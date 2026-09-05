import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { createExportBlobUrlClientV1 } from '../../src/export/blob-url-client.js';
import { deriveExportLeaseOwner } from '../../src/background/export-launch.js';
import { shouldPreserveExportTabAndLease } from '../../src/export/export-page-failure-policy.js';
import { normalizeReviewAuditId } from '../../src/review/review-state.js';

const read = path => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

const AUDIT_ID = 'audit-export-wiring';
const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';
const BLOB_URL = `blob:chrome-extension://${EXTENSION_ID}/12345678-1234-1234-1234-123456789abc`;
const CONNECTED = Object.freeze({
  ok: true, auditId: AUDIT_ID, sessionCapabilityId: 'C'.repeat(22), expectedRevision: 3, attemptId: '2',
});
const tick = () => new Promise(resolve => setImmediate(resolve));

function deferred() {
  let resolve; let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function event() {
  const listeners = new Set();
  return {
    listeners,
    addListener(listener) { listeners.add(listener); },
    removeListener(listener) { listeners.delete(listener); },
    emit(value) { for (const listener of [...listeners]) listener(value); },
  };
}

async function exportPageFixture(t, { closeFails = false, completionFails = false } = {}) {
  const source = await read('src/export/index.js');
  // Execute the entrypoint unchanged apart from resolving its imports to controlled boundaries.
  const script = source.replace(/^import\s+\{([\s\S]*?)\}\s+from\s+'[^']+';/gmu,
    (_declaration, names) => `const {${names}} = __dependencies;`);
  const exporting = deferred();
  const recovering = deferred();
  const status = { textContent: '' };
  const clientArguments = []; const clients = []; const ports = [];
  const nativeRevocations = []; const removedTabs = []; const workerRequests = []; const calls = [];
  const documentListeners = new Map();
  let respond; let exportDependencies = null;
  class NativeURL extends URL {
    static revokeObjectURL(value) { nativeRevocations.push(value); }
  }
  const chrome = {
    runtime: {
      id: EXTENSION_ID,
      getManifest: () => ({ version: '1.0.8' }),
      sendMessage(message, callback) { workerRequests.push({ ...message }); respond = callback; },
      connect({ name }) {
        const port = {
          name, onMessage: event(), onDisconnect: event(), messages: [], disconnects: 0,
          postMessage(message) {
            this.messages.push(message);
            if (message.type === 'hello') queueMicrotask(() => this.onMessage.emit({ type: 'ready' }));
            if (message.type === 'register') queueMicrotask(() => this.onMessage.emit({
              type: 'result', requestId: message.requestId, ok: true,
            }));
          },
          disconnect() { this.disconnects += 1; this.onDisconnect.emit(); },
        };
        ports.push(port); return port;
      },
    },
    tabs: {
      async getCurrent() { return { id: 17 }; },
      async remove(id) { removedTabs.push(id); if (closeFails) throw new Error('native close denied'); },
    },
  };
  const model = { auditId: AUDIT_ID, integrity: { canonicalModelHash: 'a'.repeat(64) }, timezone: 'America/Cuiaba' };
  const store = {
    async getAuditSnapshot() { calls.push('snapshot'); return { model, revision: 3, capability: {} }; },
    async getReportRevision() { return { model, modelRevision: 3, modelHash: 'a'.repeat(64), checkpoint: null }; },
    async getLatest() { return null; },
    async claimExportLease() {}, async beginExportDelivery() {}, async getExportDeliveryJournal() { return []; },
  };
  const dependencies = {
    createAuditStore: () => store, createDownloadsAdapter: () => ({}), normalizeReviewAuditId,
    createInstalledCoreRuleInventory: async () => ({}), createAuditModel: value => value,
    verifyAuditIntegritySnapshot: async value => value, buildCompleteReportSummary: async () => ({}),
    buildReportView: () => ({}), deriveExportLeaseOwner, createExportTabAdapter: () => ({}),
    reconcileStaleDownloads: async () => undefined,
    runReportExport(_request, hooks) { exportDependencies = hooks; calls.push('export'); return exporting.promise; },
    createExportSuccessRequest: value => value, persistExportSuccess: async () => { calls.push('success'); },
    createExportFailureRequest: value => value,
    persistExportFailure: async () => { calls.push('failure'); return { latest: { message: 'Exportação interrompida.' } }; },
    awaitExportCompletionAcknowledgement: async () => { if (completionFails) throw new Error('ack unavailable'); },
    isAuditExportLeaseConflict: () => false, isAuditRevisionConflict: () => false,
    isPendingReportReservationError: () => false, shouldPreserveExportTabAndLease,
    advancePendingDownloadOwnership: () => { calls.push('recovering'); return recovering.promise; },
    advancePendingExportCleanup: async () => 'resolved',
    createExportBlobUrlClientV1(options) {
      clientArguments.push({ ...options }); calls.push('client');
      // The factory runs in the test realm; retain the real client and its native effects.
      const client = createExportBlobUrlClientV1({ ...options }); clients.push(client); return client;
    },
  };
  runInNewContext(script, {
    __dependencies: dependencies, chrome, URL: NativeURL, setTimeout, clearTimeout,
    location: { href: `chrome-extension://${EXTENSION_ID}/src/export/index.html?auditId=${AUDIT_ID}` },
    navigator: { userAgent: 'Chrome/152' }, document: { querySelector: () => status },
    addEventListener(type, listener, options) {
      const entries = documentListeners.get(type) ?? [];
      entries.push({ listener, once: options?.once === true }); documentListeners.set(type, entries);
    },
  }, { filename: 'src/export/index.js' });
  t.after(() => { respond?.({ ok: false }); for (const client of clients) client.dispose(); });
  return {
    chrome, NativeURL, clientArguments, clients, ports, nativeRevocations, removedTabs, workerRequests, calls,
    exporting, recovering, status,
    get exportDependencies() { return exportDependencies; },
    respond(value = CONNECTED) { calls.push('connected'); respond(value); },
    pagehide() {
      for (const entry of [...(documentListeners.get('pagehide') ?? [])]) {
        if (entry.once) documentListeners.get('pagehide').splice(documentListeners.get('pagehide').indexOf(entry), 1);
        entry.listener({ type: 'pagehide' });
      }
    },
    pagehideListeners: () => documentListeners.get('pagehide')?.length ?? 0,
  };
}

test('Blob wiring authenticates the real export entrypoint before creating and injecting the owner hooks', async t => {
  const denied = await exportPageFixture(t);
  assert.equal(denied.clientArguments.length, 0);
  assert.equal(denied.ports.length, 0);
  denied.respond({ ...CONNECTED, auditId: 'another-audit' });
  await tick();
  assert.equal(denied.clientArguments.length, 0);
  assert.equal(denied.exportDependencies, null);

  const env = await exportPageFixture(t);
  assert.deepEqual(env.workerRequests, [{ type: 'EXPORT_CONNECT', auditId: AUDIT_ID }]);
  assert.equal(env.clientArguments.length, 0);
  env.respond(); await tick();
  assert.equal(env.clientArguments.length, 1, 'authenticated entrypoint must construct its Blob owner');
  assert.deepEqual(env.clientArguments[0], {
    runtime: env.chrome.runtime, urlApi: env.NativeURL, auditId: AUDIT_ID, sessionCapabilityId: 'C'.repeat(22),
  });
  assert.deepEqual(env.calls.slice(0, 3), ['connected', 'client', 'snapshot']);
  assert.equal(env.exportDependencies.blobLifecycle, env.clients[0].blobLifecycle);
  assert.deepEqual(Object.keys(env.exportDependencies).sort(), [
    'assertDelivery', 'blobLifecycle', 'downloadsAdapter', 'recordDelivery', 'reportView', 'tabAdapter', 'urlApi',
  ]);
  assert.equal(env.ports.length, 0, 'the authenticated client still connects lazily');
  await env.exportDependencies.blobLifecycle.register(BLOB_URL);
  assert.deepEqual(env.ports[0].messages[0], { type: 'hello', auditId: AUDIT_ID, sessionCapabilityId: 'C'.repeat(22) });
});

test('Blob wiring disposes on document pagehide but preserves a live owner during recovery and failed close', async t => {
  for (const scenario of ['cleanup-pending', 'completion-pending', 'close-failed']) {
    const env = await exportPageFixture(t, {
      closeFails: scenario === 'close-failed', completionFails: scenario === 'completion-pending',
    });
    env.respond(); await tick();
    assert.equal(env.pagehideListeners(), 1, 'the exporting document must own the disposal listener');
    await env.exportDependencies.blobLifecycle.register(BLOB_URL);
    if (scenario === 'cleanup-pending') {
      env.exporting.reject(Object.assign(new Error('cleanup pending'), { code: 'AUDIT_DOWNLOAD_CLEANUP_PENDING' }));
      await tick();
      assert.ok(env.calls.includes('recovering'));
      assert.equal(env.calls.includes('failure'), false, 'recovery retains the lease before failure persistence');
    } else env.exporting.resolve({});
    await tick();
    assert.deepEqual(env.removedTabs, scenario === 'close-failed' ? [17] : []);
    assert.deepEqual(env.nativeRevocations, [], 'an open owner must remain available for remote cleanup');
    assert.equal(env.ports[0].disconnects, 0);
    env.pagehide();
    assert.deepEqual(env.nativeRevocations, [BLOB_URL]);
    assert.equal(env.ports[0].disconnects, 1);
    assert.equal(env.ports[0].onMessage.listeners.size, 0);
    env.pagehide();
    assert.deepEqual(env.nativeRevocations, [BLOB_URL], 'repeated lifecycle delivery is idempotent');
    if (scenario === 'cleanup-pending') { env.recovering.resolve('settled'); await tick(); }
  }
});

test('internal export page authenticates first, rebuilds one stored revision and completes from a durable receipt', async () => {
  const [html, script, css, completion] = await Promise.all([
    read('src/export/index.html'), read('src/export/index.js'), read('src/export/export.css'),
    read('src/export/export-completion.js'),
  ]);
  assert.match(html, /lang="pt-BR"/u);
  assert.equal((html.match(/<h1\b/giu) ?? []).length, 1);
  assert.match(html, /aria-live="polite"/u);
  assert.doesNotMatch(html, /(?:src|href)="https?:\/\//u);
  assert.doesNotMatch(script, /data:text|URL\.createObjectURL/u);
  assert.match(script, /runReportExport|createAuditStore/u);
  assert.match(script, /createExportSuccessRequest/u);
  assert.match(script, /persistExportSuccess/u);
  assert.match(script, /type:\s*'EXPORT_CONNECT'/u);
  assert.match(script, /deriveExportLeaseOwner/u);
  assert.match(script, /getReportRevision/u);
  assert.match(script, /verifyAuditIntegritySnapshot/u);
  assert.match(script, /buildCompleteReportSummary/u);
  assert.doesNotMatch(script, /createPanelResultBundleV1/u);
  assert.match(script, /buildReportView/u);
  assert.ok(script.indexOf('await store.claimExportLease') < script.indexOf('const result = await runReportExport'));
  assert.doesNotMatch(script, /runReportExport\(\{[^}]*deliveryAt\s*:/u,
    'a caller must not be able to select the public artifact timestamp');
  assert.match(script, /assertDelivery\([\s\S]*store\.assertExportLease/u,
    'the export must obtain its delivery identity from the persisted lease assertion');
  assert.ok(script.indexOf('reconcileStaleDownloads') < script.indexOf('const result = await runReportExport'));
  assert.match(script, /recordExportDelivery/u);
  assert.match(script, /resolveExportDelivery/u);
  assert.ok(script.indexOf('await store.claimExportLease') < script.indexOf('await store.beginExportDelivery'));
  assert.ok(script.indexOf('await store.beginExportDelivery') < script.indexOf('const result = await runReportExport'));
  assert.ok(script.indexOf('const result = await runReportExport') < script.indexOf('await persistExportSuccess'));
  assert.ok(script.indexOf('await persistExportSuccess') < script.indexOf('await confirmExportCompletion'));
  assert.match(script, /completionPending\s*=\s*true[\s\S]*confirmExportCompletion/u);
  assert.match(script, /awaitExportCompletionAcknowledgement/u);
  assert.match(script, /send:\s*sendWorkerRequest[\s\S]*wait:\s*delay/u,
    'completion acknowledgement must retry while the export tab remains alive');
  assert.match(script, /setTimeout\(\(\) => finish\(\{ ok: false \}\), 5_000\)/u,
    'a missing worker callback must not block the export tab forever');
  assert.match(script, /if \(completionPending\)[\s\S]*return;/u,
    'a transient acknowledgement failure must preserve the durable receipt and active export tab for retry');
  assert.match(script, /shouldPreserveExportTabAndLease[\s\S]*await recoverPendingDownloadCleanup\(error\)/u,
    'download cleanup ownership must remain in the live export tab until durable recovery finishes');
  assert.ok(script.indexOf('await recoverPendingDownloadCleanup(error)') < script.indexOf('await persistAndCloseFailure(error)'),
    'cleanup recovery must finish before failure persistence can release the lease');
  assert.match(script, /isPendingReportReservationError\(error\)[\s\S]*await recoverPendingReportReservation\(error\)/u,
    'a late persistent reservation must be adopted by its live export tab');
  assert.ok(script.indexOf('await recoverPendingReportReservation(error)') < script.indexOf('await persistAndCloseFailure(error)'),
    'reservation ownership must settle before failure persistence can release the lease');
  assert.match(script, /advancePendingDownloadOwnership\(error[\s\S]*advancePendingExportCleanup/u,
    'an adopted asynchronous download source must settle before an empty journal can release the tab');
  assert.doesNotMatch(script, /navigator\.locks|request\(['"]audita-export/u);
  assert.match(script, /if \(!busy\) await closeOwnTab\(\)/u);
  assert.match(completion, /type:\s*'EXPORT_COMPLETE'[\s\S]*sessionCapabilityId[\s\S]*attemptId/u);
  assert.match(script, /mimeType,\s*byteSize,\s*sha256/u);
  assert.doesNotMatch(script, /searchParams\.get\(['"](?:leaseOwnerId|exportAttempt|revision|capability)/u);
  assert.doesNotMatch(script, /notify\(\{\s*type:\s*'AUDIT_DELETED'/u,
    'somente o worker validado pode publicar o evento visual de exclusão');
  assert.match(html, /HTML[\s\S]*PDF[\s\S]*CSV[\s\S]*JSON/iu);
  assert.match(html, /beta[^.]*permanece no armazenamento local[^.]*exportação/iu);
  assert.match(html, /Excluir auditoria local[^.]*página do relatório/iu);
  assert.doesNotMatch(html, /exclusão[^.]*escolhida antes/iu);
  assert.match(html, /arquivos já baixados[^.]*não são apagados/iu);
  assert.doesNotMatch(html, /<button|<input/iu);
  assert.match(css, /@media\s*\(max-width:\s*24rem\)/u);
  assert.match(css, /@media\s*\(forced-colors:\s*active\)/u);
});
