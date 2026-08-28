import assert from 'node:assert/strict';
import test from 'node:test';

import { SAMPLE_AUDIT } from '../../fixtures/audits/sample-audit.js';
import { createSessionStore, isAuthorizedExtensionSender, isAuthorizedPanelSender, registerServiceWorker } from '../../src/background/service-worker.js';
import { commitReviewDecision } from '../../src/review/review-state.js';
import { createInMemoryAuditStore } from '../../src/storage/audit-store.js';
import { runBatch } from '../../src/background/run-batch.js';
import { reportInput } from '../report/helpers.js';

const createChrome = () => {
  const action = {};
  const message = {};
  const connect = {};
  const installed = {};
  const context = {};
  const createdTabs = [];
  return {
    action: { onClicked: { addListener(listener) { action.listener = listener; } } },
    runtime: {
      id: 'test',
      getURL: (path) => `chrome-extension://test/${path}`,
      onMessage: { addListener(listener) { message.listener = listener; } },
      onConnect: { addListener(listener) { connect.listener = listener; } },
      onInstalled: { addListener(listener) { installed.listener = listener; } },
      sent: [],
      async sendMessage(value) { this.sent.push(value); },
    },
    contextMenus: {
      onClicked: { addListener(listener) { context.listener = listener; } },
      removeAll(callback) { callback?.(); },
      create(_item, callback) { callback?.(); },
    },
    tabs: {
      create: async (options) => { createdTabs.push(options); },
      async get() { throw new Error('No tab with id'); },
    },
    listeners: { action, message, connect, installed, context },
    createdTabs,
  };
};

async function waitUntil(predicate, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error('Condição de teste não foi atendida no prazo.');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function withAuditRevisions(store) {
  const models = new Map();
  const revisions = new Map();
  const capabilityRevisions = new WeakMap();
  const exportLeases = new Map();
  const commit = typeof store.commitAudit === 'function' ? store.commitAudit.bind(store) : null;
  const read = typeof store.getAudit === 'function' ? store.getAudit.bind(store) : null;
  const readLatest = typeof store.getLatest === 'function' ? store.getLatest.bind(store) : null;
  const writeLatest = typeof store.setLatest === 'function' ? store.setLatest.bind(store) : null;
  let latestState;
  const write = async (id, model, latest, snapshotCapability) => {
    const revision = revisions.get(id) ?? 0;
    const expectedRevision = snapshotCapability === undefined
      ? undefined
      : (typeof snapshotCapability === 'object' && snapshotCapability !== null
          ? capabilityRevisions.get(snapshotCapability)
          : undefined);
    if (snapshotCapability !== undefined && expectedRevision === undefined) {
      throw new TypeError('invalid snapshot capability');
    }
    if (expectedRevision !== undefined && revision !== expectedRevision) {
      throw Object.assign(new Error('revision conflict'), { code: 'AUDIT_REVISION_CONFLICT' });
    }
    const value = commit ? await commit(id, model, latest) : undefined;
    models.set(id, model);
    revisions.set(id, revision + 1);
    if (latest !== undefined) latestState = latest;
    return value ?? { revision: revision + 1 };
  };
  return {
    ...store,
    async getAuditSnapshot(id) {
      const model = models.has(id) ? models.get(id) : await read?.(id);
      const revision = revisions.get(id) ?? 0;
      if (model === undefined) return { model, revision, capability: null };
      const issuer = createInMemoryAuditStore();
      await issuer.setAudit(id, model);
      const issued = await issuer.getAuditSnapshot(id);
      capabilityRevisions.set(issued.capability, revision);
      return { model, revision, capability: issued.capability };
    },
    async getLatest() { return readLatest ? readLatest() : latestState; },
    async setLatest(value) {
      if (writeLatest) await writeLatest(value);
      latestState = value;
    },
    commitAudit(id, model, latest) { return write(id, model, latest); },
    commitAuditIfRevision(id, model, latest, snapshotCapability) {
      return write(id, model, latest, snapshotCapability);
    },
    async acquireExportLease(id, snapshotCapability, options) {
      const revision = revisions.get(id) ?? 0;
      if (capabilityRevisions.get(snapshotCapability) !== revision) {
        throw Object.assign(new Error('revision conflict'), { code: 'AUDIT_REVISION_CONFLICT' });
      }
      const now = new Date(options.now).getTime();
      const existing = exportLeases.get(id);
      if (existing && existing.revision === revision && new Date(existing.expiresAt).getTime() > now) {
        return {
          acquired: false, busy: true, retryAt: existing.expiresAt,
          revision, exportAttempt: existing.exportAttempt,
        };
      }
      const latest = await this.getLatest();
      const exportAttempt = latest?.auditId === id && Number.isSafeInteger(latest.exportAttempt)
        ? latest.exportAttempt + 1
        : 1;
      exportLeases.set(id, {
        ownerId: options.ownerId,
        revision,
        exportAttempt,
        phase: 'queued',
        expiresAt: new Date(now + (options.ttlMs ?? 120_000)).toISOString(),
      });
      await this.setLatest({ ...options.latestState, exportAttempt });
      return {
        acquired: true, busy: false, revision, exportAttempt,
        expiresAt: exportLeases.get(id).expiresAt,
      };
    },
    async claimExportLease(id, snapshotCapability, options) {
      const revision = revisions.get(id) ?? 0;
      const lease = exportLeases.get(id);
      if (capabilityRevisions.get(snapshotCapability) !== revision) {
        throw Object.assign(new Error('revision conflict'), { code: 'AUDIT_REVISION_CONFLICT' });
      }
      if (!lease || lease.ownerId !== options.ownerId || lease.phase !== 'queued' ||
        (options.exportAttempt !== undefined && lease.exportAttempt !== options.exportAttempt)) {
        throw Object.assign(new Error('lease conflict'), { code: 'AUDIT_EXPORT_LEASE_CONFLICT' });
      }
      lease.phase = 'running';
      lease.expiresAt = new Date(new Date(options.now).getTime() + (options.ttlMs ?? 120_000)).toISOString();
      await this.setLatest({ ...options.latestState, exportAttempt: lease.exportAttempt });
      return { claimed: true, revision, exportAttempt: lease.exportAttempt, expiresAt: lease.expiresAt };
    },
    async commitAuditIfRevisionWithExportLease(id, model, latest, snapshotCapability, options) {
      const revision = revisions.get(id) ?? 0;
      const lease = exportLeases.get(id);
      if (capabilityRevisions.get(snapshotCapability) !== revision) {
        throw Object.assign(new Error('revision conflict'), { code: 'AUDIT_REVISION_CONFLICT' });
      }
      if (!lease || lease.ownerId !== options.ownerId) {
        throw Object.assign(new Error('lease conflict'), { code: 'AUDIT_EXPORT_LEASE_CONFLICT' });
      }
      const result = await write(id, model, { ...latest, exportAttempt: lease.exportAttempt }, snapshotCapability);
      if (options.release) exportLeases.delete(id);
      else {
        lease.revision = result.revision;
        lease.phase = options.phase ?? 'delivering';
        lease.expiresAt = new Date(new Date(options.now).getTime() + (options.ttlMs ?? 120_000)).toISOString();
      }
      return result;
    },
    async releaseExportLease(id, options) {
      const lease = exportLeases.get(id);
      if (lease?.ownerId !== options.ownerId) return false;
      exportLeases.delete(id);
      return true;
    },
  };
}

test('opens the local panel through the centralized persona binding with the explicit source tab', async () => {
  const chromeApi = createChrome();
  const opens = [];
  const attached = [];
  const personaController = {
    async openPanel(value) { opens.push(value); return { id: 50 }; },
    attachPanelPort(port) { attached.push(port); return true; },
  };
  registerServiceWorker(chromeApi, { createId: () => 'audit-1', personaController });
  const sourceTab = { id: 7, url: 'https://alvo.test/pagina', title: 'não persistir' };
  chromeApi.listeners.action.listener(sourceTab);
  await waitUntil(() => opens.length === 1);
  assert.deepEqual(opens, [{ sourceTab }]);
  assert.deepEqual(chromeApi.createdTabs, []);
  const port = { name: 'audita-persona-v1' };
  chromeApi.listeners.connect.listener(port);
  assert.deepEqual(attached, [port]);
});

test('routes a context-menu audit through the shared single-audit boundary after a correlated panel ACK', async () => {
  const chromeApi = createChrome();
  const tabs = new Map([
    [7, { id: 7, url: 'https://origem.test/pagina', status: 'complete' }],
    [50, { id: 50, url: 'chrome-extension://test/src/panel/index.html', status: 'complete' }],
  ]);
  chromeApi.tabs.get = async tabId => structuredClone(tabs.get(tabId));
  const sent = [];
  chromeApi.runtime.sendMessage = (message, callback) => {
    sent.push(structuredClone(message));
    queueMicrotask(() => callback?.());
  };
  let runnerUrl;
  let runnerSignal;
  let finishContextRunner;
  const sessions = new Map();
  const bindingLease = Object.freeze(Object.create(null));
  let bindingLeaseLive = false;
  const personaController = {
    async openPanel({ sourceTab }) {
      assert.deepEqual(sourceTab, { id: 7, url: 'https://origem.test/pagina' });
      return { id: 50 };
    },
    async issueBindingLease(value) {
      assert.deepEqual(value, {
        panelTabId: 50, targetTabId: 7, sourceUrl: 'https://origem.test/pagina',
        panelDocumentId: 'panel-document-1',
      });
      bindingLeaseLive = true;
      return bindingLease;
    },
    consumeBindingLease(value) {
      if (value !== bindingLease || !bindingLeaseLive) return false;
      bindingLeaseLive = false;
      return true;
    },
    attachPanelPort() {},
  };
  registerServiceWorker(chromeApi, {
    createId: () => 'audit-context-1',
    createContextRequestId: () => 'context-request-1',
    sessions,
    personaController,
    auditStore: withAuditRevisions({ async setLatest() {}, async commitAudit() {} }),
    chromeAdapterFactory: () => ({}),
    runner: ({ url, signal }) => {
      runnerUrl = url;
      runnerSignal = signal;
      return new Promise(resolve => { finishContextRunner = resolve; });
    },
  });

  chromeApi.listeners.context.listener({
    menuItemId: 'audita.accessibility.audit-link', frameId: 0,
    pageUrl: 'https://origem.test/pagina',
    linkUrl: 'https://destino.test/alvo?token=TOPSECRET&view=public#auth=TOPSECRET',
  }, { id: 7, url: 'https://origem.test/pagina' });
  await waitUntil(() => sent.some(message => message.type === 'AUDIT_CONTEXT_PREFILL'));
  const prefill = sent.find(message => message.type === 'AUDIT_CONTEXT_PREFILL');
  assert.equal(prefill.prefill.url, 'https://destino.test/alvo?view=public');
  let startResponse;
  const panelSender = {
    id: 'test', frameId: 0, documentId: 'panel-document-1',
    url: 'chrome-extension://test/src/panel/index.html', tab: { id: 50 },
  };
  assert.equal(chromeApi.listeners.message.listener({
    type: 'CONTEXT_PREFILL_ACK', requestId: 'context-request-1', panelTabId: 50, accepted: true,
  }, panelSender, value => { startResponse = value; }), true);
  await waitUntil(() => sent.some(message => message.type === 'AUDIT_CONTEXT_PREFILL_COMMIT'));
  assert.equal(chromeApi.listeners.message.listener({
    type: 'CONTEXT_PREFILL_COMMIT_ACK', requestId: 'context-request-1', panelTabId: 50, accepted: true,
  }, panelSender, () => {}), true);
  await waitUntil(() => runnerUrl !== undefined);

  assert.equal(runnerUrl, 'https://destino.test/alvo?token=TOPSECRET&view=public#auth=TOPSECRET');
  assert.deepEqual(startResponse, { ok: true, auditId: 'audit-context-1', state: 'idle' });
  assert.doesNotMatch(JSON.stringify([...sessions.values(), ...sent]), /TOPSECRET|token=|auth=/iu);
  assert.equal(sent.some(message => message.type === 'START_AUDIT'), false,
    'autoStarted nunca reenvia START_AUDIT pelo painel');
  let cancelled;
  chromeApi.listeners.message.listener(
    { type: 'CANCEL_AUDIT', auditId: 'audit-context-1' },
    { ...panelSender, documentId: 'panel-document-after-reload' },
    value => { cancelled = value; },
  );
  assert.deepEqual(cancelled, { ok: true, auditId: 'audit-context-1', state: 'cancelling' });
  assert.equal(runnerSignal.aborted, true);
  finishContextRunner?.({ auditId: 'audit-context-1', session: { status: 'cancelled' }, report: {} });
});

test('validates START_AUDIT, stores an armed session, and keeps the response channel open', async () => {
  const chromeApi = createChrome();
  const sessions = new Map();
  registerServiceWorker(chromeApi, { createId: () => 'audit-1', sessions });
  let response;
  const keepOpen = chromeApi.listeners.message.listener(
    { type: 'START_AUDIT', url: ' example.test/a ' },
    { id: 'test', url: 'chrome-extension://test/src/panel/index.html' },
    (value) => { response = value; },
  );
  assert.equal(keepOpen, true);
  assert.deepEqual(response, { ok: true, auditId: 'audit-1', state: 'idle' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(response, { ok: true, auditId: 'audit-1', state: 'idle' });
  assert.equal(sessions.get('audit-1').requestedUrl, 'https://example.test/a');
});

test('rejects unknown, hostile, and malformed worker messages safely', () => {
  const chromeApi = createChrome();
  registerServiceWorker(chromeApi, { createId: () => 'audit-1' });
  let response;
  assert.equal(chromeApi.listeners.message.listener({ type: 'OTHER' }, {}, (value) => { response = value; }), false);
  assert.equal(response, undefined);
  const keepOpen = chromeApi.listeners.message.listener({ type: 'START_AUDIT', url: 'https://example.test/' }, { id: 'hostile', url: 'chrome-extension://hostile/src/panel/index.html' }, (value) => { response = value; });
  assert.equal(keepOpen, true);
  assert.deepEqual(response, { ok: false, error: 'Origem da mensagem não autorizada.' });
});

test('authorizes only this extension panel origin and exact path', () => {
  assert.equal(isAuthorizedPanelSender({ id: 'test', url: 'chrome-extension://test/src/panel/index.html' }, 'test'), true);
  assert.equal(isAuthorizedPanelSender({ id: 'test', url: 'chrome-extension://test/src/other.html' }, 'test'), false);
  assert.equal(isAuthorizedPanelSender({ id: 'test', url: 'https://example.test/src/panel/index.html' }, 'test'), false);
  assert.equal(isAuthorizedPanelSender({ id: 'other', url: 'chrome-extension://test/src/panel/index.html' }, 'test'), false);
});

test('authorizes exact panel, review and correlated export pages but never audited web pages', () => {
  for (const path of ['/src/panel/index.html', '/src/review/index.html?auditId=audit-1', '/src/export/index.html?auditId=audit-1&leaseOwnerId=owner-1&exportAttempt=2']) {
    assert.equal(isAuthorizedExtensionSender({ id: 'test', url: `chrome-extension://test${path}` }, 'test'), true);
  }
  for (const url of [
    'https://example.test/src/review/index.html?auditId=audit-1',
    'chrome-extension://test/src/review/index.html?auditId=../escape',
    'chrome-extension://test/src/export/index.html?auditId=audit-1',
    'chrome-extension://test/src/export/index.html?auditId=audit-1&extra=x',
    'chrome-extension://test/src/export/index.html?auditId=audit-1&leaseOwnerId=owner-1&exportAttempt=0',
    'chrome-extension://other/src/export/index.html?auditId=audit-1&leaseOwnerId=owner-1&exportAttempt=2',
  ]) assert.equal(isAuthorizedExtensionSender({ id: 'test', url }, 'test'), false);
});

test('accepts export events only with the exact lease owner, attempt and revision from the sender URL', () => {
  const chromeApi = createChrome();
  registerServiceWorker(chromeApi, { auditStore: withAuditRevisions({}) });
  const sender = {
    id: 'test',
    url: 'chrome-extension://test/src/export/index.html?auditId=audit-1&leaseOwnerId=owner-1&exportAttempt=2',
  };
  for (const [message, ok] of [
    [{ type: 'EXPORT_PROGRESS', auditId: 'audit-1', leaseOwnerId: 'owner-1', exportAttempt: 2, exportRevision: 2 }, true],
    [{ type: 'EXPORT_INVALIDATED', auditId: 'audit-1', leaseOwnerId: 'owner-1', exportAttempt: 2, exportRevision: 3 }, true],
    [{ type: 'EXPORT_PROGRESS', auditId: 'audit-1', leaseOwnerId: 'owner-other', exportAttempt: 2, exportRevision: 2 }, false],
    [{ type: 'EXPORT_PROGRESS', auditId: 'audit-1', leaseOwnerId: 'owner-1', exportAttempt: 3, exportRevision: 2 }, false],
    [{ type: 'EXPORT_PROGRESS', auditId: 'audit-1', leaseOwnerId: 'owner-1', exportAttempt: 2 }, false],
  ]) {
    let response;
    chromeApi.listeners.message.listener(message, sender, value => { response = value; });
    assert.equal(response.ok, ok);
  }
});

test('validates a committed review against storage before broadcasting its exact new revision', async () => {
  const chromeApi = createChrome();
  const auditStore = createInMemoryAuditStore();
  await auditStore.setAudit('audit-review-event', { auditId: 'audit-review-event' });
  await auditStore.setLatest({
    auditId: 'audit-review-event', exportStatus: 'complete', exportRevision: 1,
    exportAttempt: 1, leaseOwnerId: 'owner-old',
  });
  const snapshot = await auditStore.getAuditSnapshot('audit-review-event');
  const committed = await auditStore.commitAuditReviewIfRevision(
    'audit-review-event', { auditId: 'audit-review-event', reviewed: true }, snapshot.capability,
  );
  await auditStore.setLatest({
    auditId: 'audit-review-event', exportStatus: 'queued', exportRevision: committed.revision,
    exportAttempt: 2, leaseOwnerId: 'owner-retry-after-review',
  });
  registerServiceWorker(chromeApi, { auditStore });
  let response;
  const keepOpen = chromeApi.listeners.message.listener({
    type: 'REVIEW_COMMITTED', auditId: 'audit-review-event', exportRevision: committed.revision,
  }, {
    id: 'test', url: 'chrome-extension://test/src/review/index.html?auditId=audit-review-event',
  }, value => { response = value; });
  assert.equal(keepOpen, true);
  await waitUntil(() => response !== undefined);
  assert.deepEqual(response, { ok: true });
  assert.deepEqual(chromeApi.runtime.sent.filter(message => message.type === 'AUDIT_REVIEW_UPDATED'), [{
    type: 'AUDIT_REVIEW_UPDATED', auditId: 'audit-review-event', exportRevision: committed.revision,
  }]);

  response = undefined;
  chromeApi.listeners.message.listener({
    type: 'REVIEW_COMMITTED', auditId: 'audit-review-event', exportRevision: committed.revision + 1,
  }, {
    id: 'test', url: 'chrome-extension://test/src/review/index.html?auditId=other-audit',
  }, value => { response = value; });
  assert.deepEqual(response, { ok: false, error: 'Revisão não correlacionada.' });
});

test('contains a failed review-update broadcast and always settles the response channel', async () => {
  const chromeApi = createChrome();
  chromeApi.runtime.sendMessage = async () => { throw new Error('broadcast failed'); };
  const auditStore = createInMemoryAuditStore();
  await auditStore.setAudit('audit-review-notify', { auditId: 'audit-review-notify' });
  await auditStore.setLatest({ auditId: 'audit-review-notify', exportStatus: 'complete', exportRevision: 1 });
  const snapshot = await auditStore.getAuditSnapshot('audit-review-notify');
  const committed = await auditStore.commitAuditReviewIfRevision(
    'audit-review-notify', { auditId: 'audit-review-notify', reviewed: true }, snapshot.capability,
  );
  registerServiceWorker(chromeApi, { auditStore });
  let response;
  chromeApi.listeners.message.listener({
    type: 'REVIEW_COMMITTED', auditId: 'audit-review-notify', exportRevision: committed.revision,
  }, {
    id: 'test', url: 'chrome-extension://test/src/review/index.html?auditId=audit-review-notify',
  }, value => { response = value; });
  await waitUntil(() => response !== undefined);
  assert.deepEqual(response, { ok: false, error: 'Não foi possível notificar a revisão.' });
});

test('persists sessions with storage.session and falls back to an injected map', async () => {
  const writes = [];
  const sessionStore = createSessionStore({ storage: { session: { set: async (value) => writes.push(value) } } });
  await sessionStore.set('audit-1', { id: 'audit-1', requestedUrl: 'https://example.test/' });
  assert.deepEqual(writes, [{ 'audita-mt:session:audit-1': { id: 'audit-1', requestedUrl: 'https://example.test/' } }]);

  const fallback = new Map();
  const fallbackStore = createSessionStore({}, fallback);
  await fallbackStore.set('audit-2', { id: 'audit-2' });
  assert.deepEqual(await fallbackStore.get('audit-2'), { id: 'audit-2' });
});

test('falls back to memory when storage.session rejects without touching storage.local', async () => {
  const chromeApi = createChrome();
  chromeApi.storage = {
    session: {
      set(_value, callback) {
        chromeApi.runtime.lastError = { message: 'storage denied' };
        callback();
        chromeApi.runtime.lastError = null;
      },
    },
  };
  const store = createSessionStore(chromeApi);
  await assert.doesNotReject(store.set('audit-1', { id: 'audit-1' }));
  assert.deepEqual(await store.get('audit-1'), { id: 'audit-1' });

  registerServiceWorker(chromeApi, { createId: () => 'audit-1' });
  let response;
  chromeApi.listeners.message.listener(
    { type: 'START_AUDIT', url: 'https://example.test/' },
    { id: 'test', url: 'chrome-extension://test/src/panel/index.html' },
    (value) => { response = value; },
  );
  assert.deepEqual(response, { ok: true, auditId: 'audit-1', state: 'idle' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(chromeApi.runtime.sent.some(message => message.type === 'AUDIT_FAILED' && message.auditId === 'audit-1'));
});

test('runs the audit in background, persists the model and sends correlated progress and completion', async () => {
  const chromeApi = createChrome();
  const writes = [];
  const auditStore = {
    async setLatest(value) { writes.push(['latest', value]); },
    async commitAudit(id, model, latest) { writes.push(['commit', id, model, latest]); },
  };
  const runner = async ({ chromeAdapter }) => {
    await chromeAdapter.emitProgress({ type: 'AUDIT_PROGRESS', auditId: 'audit-1', sessionId: 'audit-1', percent: 50, message: 'Verificando acessibilidade' });
    return { auditId: 'audit-1', session: { status: 'complete' }, report: { reviewUrl: 'chrome-extension://test/src/review/index.html?auditId=audit-1' } };
  };
  registerServiceWorker(chromeApi, {
    createId: () => 'audit-1', runner, auditStore: withAuditRevisions(auditStore),
    createExportOwnerId: () => 'owner-auto',
    chromeAdapterFactory: () => ({ async emitProgress() {} }),
  });
  let response;
  chromeApi.listeners.message.listener(
    { type: 'START_AUDIT', url: 'https://example.test/' },
    { id: 'test', url: 'chrome-extension://test/src/panel/index.html', documentId: 'panel-1' },
    value => { response = value; },
  );
  assert.deepEqual(response, { ok: true, auditId: 'audit-1', state: 'idle' });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(chromeApi.runtime.sent.some(message => message.type === 'AUDIT_PROGRESS' && message.auditId === 'audit-1'));
  assert.ok(chromeApi.runtime.sent.some(message => message.type === 'AUDIT_COMPLETE' && message.auditId === 'audit-1'));
  assert.ok(writes.some(([kind, id]) => kind === 'commit' && id === 'audit-1'));
  await waitUntil(() => chromeApi.createdTabs.some(tab => tab.url.includes('/src/export/')));
  assert.ok(chromeApi.createdTabs.some(tab => tab.active === false && tab.url === 'chrome-extension://test/src/export/index.html?auditId=audit-1&leaseOwnerId=owner-auto&exportAttempt=1'));
});

test('regenerates only a known audit and reports an active persistent export as BUSY', async () => {
  const chromeApi = createChrome();
  let latest = { auditId: 'audit-1', status: 'partial', exportStatus: 'complete', exportAttempt: 4 };
  const auditStore = {
    async getAudit(id) { return id === 'audit-1' ? { auditId: id } : undefined; },
    async getLatest() { return latest; },
    async setLatest(value) { latest = value; },
  };
  registerServiceWorker(chromeApi, {
    auditStore: withAuditRevisions(auditStore), now: () => '2026-08-26T15:00:00.000Z',
    createExportOwnerId: () => 'owner-review',
  });
  const sender = { id: 'test', url: 'chrome-extension://test/src/review/index.html?auditId=audit-1' };
  let first;
  chromeApi.listeners.message.listener({ type: 'REQUEST_EXPORT', auditId: 'audit-1' }, sender, value => { first = value; });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(first, {
    ok: true, auditId: 'audit-1', state: 'queued', exportRevision: 0,
    exportAttempt: 5, leaseOwnerId: 'owner-review',
  });
  assert.equal(latest.exportStatus, 'queued');
  assert.equal(latest.exportQueuedAt, '2026-08-26T15:00:00.000Z');
  assert.equal(latest.exportAttempt, 5);
  assert.ok(chromeApi.createdTabs.some(tab => tab.url.endsWith('/src/export/index.html?auditId=audit-1&leaseOwnerId=owner-review&exportAttempt=5') && tab.active === false));
  let duplicate;
  chromeApi.listeners.message.listener({ type: 'REQUEST_EXPORT', auditId: 'audit-1' }, sender, value => { duplicate = value; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.code, 'EXPORT_BUSY');
  assert.equal(duplicate.retryable, true);
  assert.equal(typeof duplicate.retryAt, 'string');
});

test('serializes concurrent REQUEST_EXPORT so one wins and the retry receives BUSY', async () => {
  const chromeApi = createChrome();
  let latest = { auditId: 'audit-1', status: 'complete', exportStatus: 'complete' };
  let releaseRead;
  const readGate = new Promise(resolve => { releaseRead = resolve; });
  const auditStore = {
    async getAudit() { await readGate; return { auditId: 'audit-1' }; },
    async getLatest() { await readGate; return latest; },
    async setLatest(value) { latest = value; },
  };
  registerServiceWorker(chromeApi, { auditStore: withAuditRevisions(auditStore), now: () => '2026-08-26T15:00:00.000Z' });
  const sender = { id: 'test', url: 'chrome-extension://test/src/review/index.html?auditId=audit-1' };
  const responses = [];
  chromeApi.listeners.message.listener({ type: 'REQUEST_EXPORT', auditId: 'audit-1' }, sender, value => responses.push(value));
  chromeApi.listeners.message.listener({ type: 'REQUEST_EXPORT', auditId: 'audit-1' }, sender, value => responses.push(value));
  releaseRead();
  await waitUntil(() => responses.length === 2);
  assert.equal(chromeApi.createdTabs.filter(tab => tab.url.includes('/src/export/')).length, 1);
  assert.equal(responses.length, 2);
  assert.equal(responses.filter(response => response.ok && response.state === 'queued').length, 1);
  assert.equal(responses.filter(response => response.code === 'EXPORT_BUSY' && response.retryable).length, 1);
});

test('never treats an uncorrelated queued marker as persistent exclusivity after restart', async () => {
  for (const queuedAt of [undefined, 'not-an-iso-date', '2026-08-26T14:59:30.000Z']) {
    const chromeApi = createChrome();
    let latest = { auditId: 'audit-1', status: 'complete', exportStatus: 'queued', exportRevision: 0, ...(queuedAt ? { exportQueuedAt: queuedAt } : {}) };
    const auditStore = {
      async getAudit() { return { auditId: 'audit-1' }; }, async getLatest() { return latest; },
      async setLatest(value) { latest = value; },
    };
    registerServiceWorker(chromeApi, { auditStore: withAuditRevisions(auditStore), now: () => '2026-08-26T15:00:00.000Z' });
    let response;
    chromeApi.listeners.message.listener(
      { type: 'REQUEST_EXPORT', auditId: 'audit-1' },
      { id: 'test', url: 'chrome-extension://test/src/review/index.html?auditId=audit-1' },
      value => { response = value; },
    );
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(chromeApi.createdTabs.some(tab => tab.url.includes('/src/export/')), true);
    assert.equal(response.ok, true);
    assert.equal(response.state, 'queued');
  }
});

test('never lets review audit A request export of audit B', () => {
  const chromeApi = createChrome();
  let reads = 0;
  registerServiceWorker(chromeApi, { auditStore: { async getAudit() { reads += 1; } } });
  let response;
  chromeApi.listeners.message.listener(
    { type: 'REQUEST_EXPORT', auditId: 'audit-B' },
    { id: 'test', url: 'chrome-extension://test/src/review/index.html?auditId=audit-A' },
    value => { response = value; },
  );
  assert.deepEqual(response, { ok: false, error: 'Pedido de exportação inválido.' });
  assert.equal(reads, 0);
});

test('never carries latest state from audit B into an export request for audit A', async () => {
  const chromeApi = createChrome();
  let written;
  const auditStore = {
    async getAudit() { return { auditId: 'audit-A' }; },
    async getLatest() { return { auditId: 'audit-B', reviewUrl: 'chrome-extension://test/private-B', secretMarker: 'audit-B-only' }; },
    async setLatest(value) { written = value; },
  };
  registerServiceWorker(chromeApi, { auditStore: withAuditRevisions(auditStore), now: () => '2026-08-26T15:00:00.000Z' });
  let response;
  chromeApi.listeners.message.listener(
    { type: 'REQUEST_EXPORT', auditId: 'audit-A' },
    { id: 'test', url: 'chrome-extension://test/src/review/index.html?auditId=audit-A' },
    value => { response = value; },
  );
  await waitUntil(() => response !== undefined);
  assert.equal(response.ok, true);
  assert.equal(written.auditId, 'audit-A');
  assert.equal(Object.hasOwn(written, 'reviewUrl'), false);
  assert.equal(Object.hasOwn(written, 'secretMarker'), false);
});

test('rejects a stored model whose correlated auditId is inherited', async () => {
  const chromeApi = createChrome();
  const inherited = Object.create({ auditId: 'audit-A' });
  registerServiceWorker(chromeApi, { auditStore: withAuditRevisions({ async getAudit() { return inherited; }, async getLatest() { return null; } }) });
  let response;
  chromeApi.listeners.message.listener(
    { type: 'REQUEST_EXPORT', auditId: 'audit-A' },
    { id: 'test', url: 'chrome-extension://test/src/review/index.html?auditId=audit-A' },
    value => { response = value; },
  );
  await waitUntil(() => response !== undefined);
  assert.deepEqual(response, { ok: false, error: 'Auditoria não encontrada.' });
  assert.equal(chromeApi.createdTabs.some(tab => tab.url.includes('/src/export/')), false);
});

test('rejects export requests from an audited web page', () => {
  const chromeApi = createChrome();
  registerServiceWorker(chromeApi, { auditStore: {} });
  let response;
  const keepOpen = chromeApi.listeners.message.listener(
    { type: 'REQUEST_EXPORT', auditId: 'audit-1' },
    { id: 'test', url: 'https://example.test/' },
    value => { response = value; },
  );
  assert.equal(keepOpen, true);
  assert.deepEqual(response, { ok: false, error: 'Origem da mensagem não autorizada.' });
});

test('deduplicates concurrent START_AUDIT messages from the same panel sender', () => {
  const chromeApi = createChrome();
  let finish;
  const runner = () => new Promise(resolve => { finish = resolve; });
  registerServiceWorker(chromeApi, { createId: () => 'audit-1', runner, auditStore: withAuditRevisions({ async setLatest() {}, async commitAudit() {} }), chromeAdapterFactory: () => ({}) });
  const sender = { id: 'test', url: 'chrome-extension://test/src/panel/index.html', documentId: 'panel-1' };
  let first;
  let second;
  chromeApi.listeners.message.listener({ type: 'START_AUDIT', url: 'https://example.test/' }, sender, value => { first = value; });
  chromeApi.listeners.message.listener({ type: 'START_AUDIT', url: 'https://example.test/' }, sender, value => { second = value; });
  assert.equal(first.auditId, 'audit-1');
  assert.deepEqual(second, { ok: true, auditId: 'audit-1', state: 'running', duplicate: true });
  finish?.({ auditId: 'audit-1', session: { status: 'complete' }, report: {} });
});

test('never falls back to storage.local for ephemeral batch checkpoints', async () => {
  let localCalls = 0;
  const fallback = new Map();
  const store = createSessionStore({ storage: { local: {
    async set() { localCalls += 1; }, async get() { localCalls += 1; },
  } } }, fallback);
  await store.set('batch-ephemeral', { id: 'batch-ephemeral', mode: 'batch' });
  assert.deepEqual(await store.get('batch-ephemeral'), { id: 'batch-ephemeral', mode: 'batch' });
  assert.equal(localCalls, 0);
});

test('starts one normalized batch globally and only lets its owning panel cancel it', async () => {
  const chromeApi = createChrome();
  const checkpoints = [];
  let batchInput;
  let release;
  const batchRunner = ({ entries, batchAuditId, signal, onCheckpoint }) => {
    batchInput = { entries, batchAuditId, signal };
    void onCheckpoint({ id: batchAuditId, mode: 'batch', state: 'running', total: entries.length });
    return new Promise(resolve => { release = resolve; });
  };
  registerServiceWorker(chromeApi, {
    createId: () => 'batch-global', batchRunner,
    sessionStore: { async set(id, value) { checkpoints.push([id, value]); }, async get() {} },
    auditStore: withAuditRevisions({ async setLatest() {}, async commitAudit() {} }),
    chromeAdapterFactory: () => ({}),
    reportOptions: { timezone: 'UTC', manifestVersion: '2.0.0', rulesVersion: '1.0.0', browserVersion: '152.0.0.0' },
  });
  const owner = { id: 'test', url: 'chrome-extension://test/src/panel/index.html', documentId: 'panel-owner' };
  const other = { id: 'test', url: 'chrome-extension://test/src/panel/index.html', documentId: 'panel-other' };
  let started;
  chromeApi.listeners.message.listener({ type: 'START_BATCH', urls: 'https://example.test/a?token=SECRET\nhttps://example.org/b' }, owner, value => { started = value; });
  assert.deepEqual(started, { ok: true, auditId: 'batch-global', state: 'idle', total: 2, warnings: [] });
  await waitUntil(() => batchInput !== undefined);
  assert.equal(batchInput.entries[0].navigationUrl.includes('SECRET'), true);
  assert.equal(JSON.stringify(checkpoints).includes('SECRET'), false);

  let busy;
  chromeApi.listeners.message.listener({ type: 'START_AUDIT', url: 'https://third.test/' }, other, value => { busy = value; });
  assert.deepEqual(busy, { ok: false, code: 'AUDIT_BUSY', error: 'Já existe uma auditoria em andamento.' });

  let denied;
  chromeApi.listeners.message.listener({ type: 'CANCEL_AUDIT', auditId: 'batch-global' }, other, value => { denied = value; });
  assert.deepEqual(denied, { ok: false, error: 'Cancelamento não autorizado.' });
  let cancelled;
  chromeApi.listeners.message.listener({ type: 'CANCEL_AUDIT', auditId: 'batch-global' }, owner, value => { cancelled = value; });
  assert.deepEqual(cancelled, { ok: true, auditId: 'batch-global', state: 'cancelling' });
  assert.equal(batchInput.signal.aborted, true);
  release?.({ auditId: 'batch-global', session: { status: 'cancelled' }, report: {} });
});

test('rejects cancellation with a fixed too-late result once single or batch enters final handoff', async () => {
  for (const mode of ['single', 'batch']) {
    const chromeApi = createChrome();
    let enteredHandoff;
    const handoffEntered = new Promise(resolve => { enteredHandoff = resolve; });
    let releaseHandoff;
    const handoffGate = new Promise(resolve => { releaseHandoff = resolve; });
    const runner = async ({ chromeAdapter }) => {
      if (mode === 'batch') {
        await chromeAdapter.enterFinalization();
        enteredHandoff();
        await handoffGate;
      } else {
        await chromeAdapter.handoffReport({});
      }
      return { auditId: `audit-${mode}`, pages: [], session: { status: mode === 'batch' ? 'failed' : 'complete' }, report: {} };
    };
    registerServiceWorker(chromeApi, {
      createId: () => `audit-${mode}`,
      runner: mode === 'single' ? runner : undefined,
      batchRunner: mode === 'batch' ? runner : undefined,
      reportOptions: { timezone: 'UTC', manifestVersion: '2.0.0', rulesVersion: '1.0.0', browserVersion: '152' },
      chromeAdapterFactory: () => ({ async handoffReport() { enteredHandoff(); await handoffGate; return {}; } }),
      auditStore: withAuditRevisions({ async setLatest() {}, async commitAudit() {} }),
    });
    const sender = { id: 'test', url: 'chrome-extension://test/src/panel/index.html', tab: { id: mode === 'single' ? 80 : 81 } };
    let started;
    chromeApi.listeners.message.listener(mode === 'single'
      ? { type: 'START_AUDIT', url: 'https://late.example.test/' }
      : { type: 'START_BATCH', urls: 'https://late.example.test/' }, sender, value => { started = value; });
    await handoffEntered;
    let cancelled;
    chromeApi.listeners.message.listener({ type: 'CANCEL_AUDIT', auditId: started.auditId }, sender, value => { cancelled = value; });
    assert.deepEqual(cancelled, {
      ok: false, code: 'AUDIT_CANCEL_TOO_LATE',
      error: 'A auditoria já está na etapa final e não pode mais ser cancelada.',
    });
    releaseHandoff();
  }
});

test('closes cancellation atomically before persisting every terminal batch path', async t => {
  const cases = [
    {
      name: 'last PAGE_FINISHED', urls: 'https://last.example.test/',
      gate: value => value.state === 'running' && value.completedCount === 1,
      runner: async options => reportInput({
        auditId: options.idFactory(), requestedUrl: options.url, finalUrl: options.url,
        session: { status: 'complete', diagnostics: [], partial: false },
      }),
      expectedStatus: 'complete',
    },
    {
      name: 'FINISH', urls: 'https://finish.example.test/', gate: value => value.state === 'complete',
      runner: async options => reportInput({
        auditId: options.idFactory(), requestedUrl: options.url, finalUrl: options.url,
        session: { status: 'complete', diagnostics: [], partial: false },
      }),
      expectedStatus: 'complete',
    },
    {
      name: 'cleanup-unconfirmed early terminal',
      urls: 'https://stuck.example.test/\nhttps://never.example.test/',
      gate: value => value.state === 'running' && value.completedCount === 1,
      runner: () => new Promise(() => {}), expectedStatus: 'failed',
    },
    {
      name: 'cleanup diagnostic early terminal',
      urls: 'https://cleanup.example.test/\nhttps://never.example.test/',
      gate: value => value.state === 'running' && value.completedCount === 1,
      runner: async options => reportInput({
        auditId: options.idFactory(), requestedUrl: options.url, finalUrl: options.url,
        session: {
          status: 'partial', partial: true,
          diagnostics: [{
            code: 'TAB_CLOSE_FAILED', message: 'A aba descartável não pôde ser fechada automaticamente.',
            at: '2026-08-28T12:00:00.000Z', recoverable: false,
          }],
        },
      }),
      expectedStatus: 'partial',
    },
  ];
  for (const scenario of cases) await t.test(scenario.name, async () => {
    const chromeApi = createChrome();
    let releasePersistence;
    const persistenceGate = new Promise(resolve => { releasePersistence = resolve; });
    let enteredPersistence;
    const persistenceEntered = new Promise(resolve => { enteredPersistence = resolve; });
    let gated = false;
    let committed;
    registerServiceWorker(chromeApi, {
      createId: () => `batch-boundary-${scenario.name.replaceAll(/[^a-z]+/giu, '-').toLowerCase()}`,
      sessionStore: {
        async getActiveBatch() {}, async get() {},
        async set(_id, value) {
          if (!gated && value?.mode === 'batch' && scenario.gate(value)) {
            gated = true; enteredPersistence(); await persistenceGate;
          }
        },
        async setActiveBatch() {}, async clearActiveBatch() {},
      },
      batchRunner: options => runBatch({
        ...options, runner: scenario.runner, pageTimeoutMs: 5, cleanupTimeoutMs: 5,
      }),
      auditStore: withAuditRevisions({
        async setLatest() {},
        async commitAudit(_id, model) { committed = model; },
      }),
      chromeAdapterFactory: () => ({ async emitProgress() {}, async handoffReport() { return { reviewUrl: null }; } }),
      reportOptions: { timezone: 'UTC', manifestVersion: '2.0.0', rulesVersion: '1.0.0', browserVersion: 'Chrome/152' },
    });
    const sender = { id: 'test', url: 'chrome-extension://test/src/panel/index.html', tab: { id: 90 } };
    let started;
    chromeApi.listeners.message.listener({ type: 'START_BATCH', urls: scenario.urls }, sender, value => { started = value; });
    await persistenceEntered;
    let cancellation;
    chromeApi.listeners.message.listener({ type: 'CANCEL_AUDIT', auditId: started.auditId }, sender, value => { cancellation = value; });
    assert.deepEqual(cancellation, {
      ok: false, code: 'AUDIT_CANCEL_TOO_LATE',
      error: 'A auditoria já está na etapa final e não pode mais ser cancelada.',
    });
    releasePersistence();
    await waitUntil(() => committed !== undefined);
    assert.equal(committed.session.status, scenario.expectedStatus);
  });
});

test('persists copied batch statusCounts so GET_LAST restores failures after panel reload', async () => {
  const chromeApi = createChrome();
  const writes = [];
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  registerServiceWorker(chromeApi, {
    createId: () => 'batch-reload-counts',
    batchRunner: async ({ chromeAdapter }) => {
      const statusCounts = { complete: 0, partial: 0, failed: 1, cancelled: 0 };
      await chromeAdapter.emitProgress({
        type: 'AUDIT_PROGRESS', auditId: 'batch-reload-counts', sessionId: 'batch-reload-counts',
        percent: 50, message: 'Página 1 encerrada.', pageNumber: 1, total: 2, statusCounts,
      });
      statusCounts.failed = 9;
      await hold;
    },
    auditStore: withAuditRevisions({ async setLatest(value) { writes.push(structuredClone(value)); } }),
    chromeAdapterFactory: () => ({}),
    reportOptions: { timezone: 'UTC', manifestVersion: '2.0.0', rulesVersion: '1.0.0', browserVersion: 'Chrome/152' },
  });
  const sender = { id: 'test', url: 'chrome-extension://test/src/panel/index.html', tab: { id: 91 } };
  chromeApi.listeners.message.listener({ type: 'START_BATCH', urls: 'https://one.example.test/\nhttps://two.example.test/' }, sender, () => {});
  await waitUntil(() => writes.length >= 2);
  assert.deepEqual(writes[0].statusCounts, { complete: 0, partial: 0, failed: 0, cancelled: 0 });
  let restored;
  chromeApi.listeners.message.listener({ type: 'GET_LAST_AUDIT' }, sender, value => { restored = value; });
  await waitUntil(() => restored !== undefined);
  assert.deepEqual(restored.state.statusCounts, { complete: 0, partial: 0, failed: 1, cancelled: 0 });
  release();
});

test('blocks a batch with line errors before allocating an audit id', () => {
  const chromeApi = createChrome();
  let allocated = 0;
  registerServiceWorker(chromeApi, { createId() { allocated += 1; return 'must-not-run'; } });
  let response;
  chromeApi.listeners.message.listener(
    { type: 'START_BATCH', urls: 'https://ok.test\nftp://invalid.test' },
    { id: 'test', url: 'chrome-extension://test/src/panel/index.html', documentId: 'panel-1' },
    value => { response = value; },
  );
  assert.equal(response.ok, false);
  assert.equal(response.code, 'BATCH_INVALID');
  assert.equal(response.errors[0].line, 2);
  assert.equal(JSON.stringify(response).includes('ftp://'), false);
  assert.equal(allocated, 0);
});

test('turns a running batch checkpoint into an explanatory non-resumable interruption after restart', async () => {
  const chromeApi = createChrome();
  const checkpoint = {
    id: 'batch-restart', mode: 'batch', state: 'running', total: 3, currentIndex: 1,
    completedCount: 1, statusCounts: { complete: 1, partial: 0, failed: 0, cancelled: 0 },
    cancelRequested: false, startedAt: '2026-08-28T10:00:00.000Z',
    updatedAt: '2026-08-28T10:01:00.000Z', resumable: false,
  };
  let savedCheckpoint;
  let cleared = false;
  let latest;
  registerServiceWorker(chromeApi, {
    now: () => '2026-08-28T10:02:00.000Z',
    sessionStore: {
      async getActiveBatch() { return checkpoint; },
      async set(_id, value) { savedCheckpoint = value; }, async get() {},
      async clearActiveBatch() { cleared = true; },
    },
    auditStore: withAuditRevisions({ async setLatest(value) { latest = value; } }),
  });
  await waitUntil(() => latest !== undefined);
  assert.equal(savedCheckpoint.state, 'failed');
  assert.equal(savedCheckpoint.resumable, false);
  assert.equal(latest.auditId, 'batch-restart');
  assert.equal(latest.mode, 'batch');
  assert.equal(latest.status, 'failed');
  assert.equal(cleared, true);
  assert.match(latest.message, /interrompid[oa]|reinício/iu);
  assert.doesNotMatch(JSON.stringify([savedCheckpoint, latest]), /https?:|token=|session=/iu);
});

test('a delayed restart restoration can never overwrite a newly accepted audit', async () => {
  const chromeApi = createChrome();
  let releaseRestore;
  const restoreGate = new Promise(resolve => { releaseRestore = resolve; });
  const latestWrites = [];
  let latest;
  let finishRunner;
  registerServiceWorker(chromeApi, {
    createId: () => 'audit-new',
    sessionStore: {
      async getActiveBatch() { await restoreGate; return {
        id: 'batch-old', mode: 'batch', state: 'running', total: 2, currentIndex: 1, completedCount: 1,
        statusCounts: { complete: 1, partial: 0, failed: 0, cancelled: 0 }, cancelRequested: false,
        startedAt: '2026-08-28T09:00:00.000Z', updatedAt: '2026-08-28T09:01:00.000Z', resumable: false,
      }; },
      async set() {}, async get() {}, async clearActiveBatch() {},
    },
    auditStore: withAuditRevisions({
      async getLatest() { return latest; },
      async setLatest(value) { latest = value; latestWrites.push(value); }, async commitAudit(_id, _model, value) { latest = value; },
    }),
    chromeAdapterFactory: () => ({}),
    runner: () => new Promise(resolve => { finishRunner = resolve; }),
  });
  let response;
  chromeApi.listeners.message.listener(
    { type: 'START_AUDIT', url: 'https://new.example.test/' },
    { id: 'test', url: 'chrome-extension://test/src/panel/index.html', documentId: 'panel-new' },
    value => { response = value; },
  );
  assert.equal(response.auditId, 'audit-new');
  releaseRestore();
  await waitUntil(() => latest?.auditId === 'audit-new');
  assert.equal(latest.auditId, 'audit-new');
  finishRunner?.({ auditId: 'audit-new', session: { status: 'complete' }, report: {} });
});

test('accepts a terminal active marker only when snapshot and latest prove its commit', async () => {
  for (const proved of [false, true]) {
    const chromeApi = createChrome();
    const checkpoint = {
      id: `batch-terminal-${proved}`, mode: 'batch', state: 'complete', total: 1, currentIndex: 1,
      completedCount: 1, statusCounts: { complete: 1, partial: 0, failed: 0, cancelled: 0 },
      cancelRequested: false, startedAt: '2026-08-28T10:00:00.000Z', updatedAt: '2026-08-28T10:01:00.000Z', resumable: false,
    };
    let latest = proved ? { auditId: checkpoint.id, status: 'complete' } : undefined;
    let saved;
    let cleared = false;
    registerServiceWorker(chromeApi, {
      sessionStore: {
        async getActiveBatch() { return checkpoint; }, async set(_id, value) { saved = value; },
        async clearActiveBatch() { cleared = true; }, async get() {},
      },
      auditStore: withAuditRevisions({
        async getAudit(id) { return proved && id === checkpoint.id ? { auditId: id, session: { status: 'complete' } } : undefined; },
        async getLatest() { return latest; }, async setLatest(value) { latest = value; },
      }),
    });
    await waitUntil(() => cleared);
    assert.equal(saved?.state, proved ? undefined : 'failed');
    assert.equal(latest?.status, proved ? 'complete' : 'failed');
  }
});

test('clears a stale active marker without replacing a newer single-page latest record', async () => {
  const chromeApi = createChrome();
  const checkpoint = {
    id: 'batch-stale', mode: 'batch', state: 'idle', total: 1, currentIndex: 0, completedCount: 0,
    statusCounts: { complete: 0, partial: 0, failed: 0, cancelled: 0 }, cancelRequested: false,
    startedAt: '2026-08-28T10:00:00.000Z', updatedAt: '2026-08-28T10:00:00.000Z', resumable: false,
  };
  const latest = { auditId: 'single-newer', status: 'complete' };
  const writes = [];
  let cleared = false;
  registerServiceWorker(chromeApi, {
    sessionStore: { async getActiveBatch() { return checkpoint; }, async clearActiveBatch() { cleared = true; }, async set() {}, async get() {} },
    auditStore: withAuditRevisions({ async getLatest() { return latest; }, async setLatest(value) { writes.push(value); } }),
  });
  await waitUntil(() => cleared);
  assert.deepEqual(writes, []);
});

test('stores only a sanitized URL before execution while runner keeps the full navigation URL', async () => {
  const chromeApi = createChrome();
  const sessions = new Map();
  const stored = [];
  let runnerUrl;
  const auditStore = {
    async setLatest(value) { stored.push(value); },
    async commitAudit(_id, _model, latest) { stored.push(latest); },
  };
  registerServiceWorker(chromeApi, {
    createId: () => 'audit-private', sessions, auditStore: withAuditRevisions(auditStore),
    chromeAdapterFactory: () => ({}),
    runner: async ({ url }) => { runnerUrl = url; return { auditId: 'audit-private', session: { status: 'complete' }, report: {} }; },
  });
  chromeApi.listeners.message.listener(
    { type: 'START_AUDIT', url: 'https://example.test/path?token=TOPSECRET&view=public#auth=TOPSECRET' },
    { id: 'test', url: 'chrome-extension://test/src/panel/index.html' }, () => {},
  );
  await new Promise(resolve => setImmediate(resolve));
  assert.match(runnerUrl, /TOPSECRET/);
  assert.doesNotMatch(JSON.stringify([...sessions.values(), ...stored]), /TOPSECRET|token=|auth=/i);
  assert.match(sessions.get('audit-private').requestedUrl, /view=public/);
});

test('notification failure after atomic commit never rewrites committed complete state', async () => {
  const chromeApi = createChrome();
  chromeApi.runtime.sendMessage = async () => { throw new Error('panel closed'); };
  const writes = [];
  const auditStore = {
    async setLatest(value) { writes.push(['latest', value]); },
    async commitAudit(id, model, latest) { writes.push(['commit', id, model, latest]); },
  };
  registerServiceWorker(chromeApi, {
    createId: () => 'audit-notify', auditStore: withAuditRevisions(auditStore), chromeAdapterFactory: () => ({}),
    runner: async () => ({ auditId: 'audit-notify', session: { status: 'complete' }, report: {} }),
  });
  chromeApi.listeners.message.listener({ type: 'START_AUDIT', url: 'https://example.test/' }, { id: 'test', url: 'chrome-extension://test/src/panel/index.html' }, () => {});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(writes.filter(([kind]) => kind === 'commit').length, 1);
  assert.equal(writes.some(([kind, value]) => kind === 'latest' && value.status === 'failed'), false);
});

test('automatic export never synthesizes failure from another preparing attempt', async () => {
  const chromeApi = createChrome();
  const store = createInMemoryAuditStore();
  store.acquireExportLease = async () => {
    await store.setLatest({
      auditId: SAMPLE_AUDIT.auditId,
      status: 'partial',
      exportStatus: 'preparing',
      exportRevision: 1,
      exportAttempt: 7,
      leaseOwnerId: 'owner-other-attempt',
      message: 'Uma versão revisada aguarda nova geração.',
    });
    throw Object.assign(new Error('review won'), { code: 'AUDIT_REVISION_CONFLICT' });
  };
  registerServiceWorker(chromeApi, {
    createId: () => SAMPLE_AUDIT.auditId,
    auditStore: store,
    chromeAdapterFactory: () => ({}),
    runner: async () => structuredClone(SAMPLE_AUDIT),
  });
  chromeApi.listeners.message.listener(
    { type: 'START_AUDIT', url: 'https://example.test/' },
    { id: 'test', url: 'chrome-extension://test/src/panel/index.html' },
    () => {},
  );
  await waitUntil(() => chromeApi.runtime.sent.some(message => message.type === 'AUDIT_COMPLETE'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(chromeApi.runtime.sent.some(message => message.type === 'EXPORT_FAILED'), false);
  assert.equal((await store.getLatest()).exportStatus, 'preparing');
});

test('automatic export tab failure atomically persists a controlled partial model and latest state', async () => {
  const chromeApi = createChrome();
  chromeApi.tabs.create = async options => {
    if (options.url.includes('/src/export/')) throw new Error('tab denied');
    chromeApi.createdTabs.push(options);
  };
  const writes = [];
  const auditStore = {
    async setLatest(value) { writes.push(['latest', value]); },
    async commitAudit(id, model, latest) { writes.push(['commit', id, model, latest]); },
  };
  const model = structuredClone(SAMPLE_AUDIT);
  model.limitations.push('TOPSECRET https://origin.test/?token=x blob:chrome-extension://test/private');
  registerServiceWorker(chromeApi, { createId: () => model.auditId, auditStore: withAuditRevisions(auditStore), chromeAdapterFactory: () => ({}), runner: async () => model, now: () => '2026-08-26T16:00:00.000Z' });
  chromeApi.listeners.message.listener({ type: 'START_AUDIT', url: 'https://example.test/' }, { id: 'test', url: 'chrome-extension://test/src/panel/index.html' }, () => {});
  await waitUntil(() => writes.filter(([kind]) => kind === 'commit').length === 2);
  const commits = writes.filter(([kind]) => kind === 'commit');
  assert.equal(commits.length, 2);
  assert.equal(commits[1][2].session.status, 'partial');
  assert.deepEqual(commits[1][2].report.artifact.formats, []);
  assert.equal(commits[1][3].exportStatus, 'failed');
  assert.doesNotMatch(JSON.stringify(commits[1]), /TOPSECRET|origin\.test|blob:|chrome-extension:/iu);
  assert.ok(chromeApi.runtime.sent.some(message => message.type === 'EXPORT_FAILED' && message.auditId === model.auditId));
});

test('requested export tab failure atomically replaces queued state with a controlled partial model', async () => {
  const chromeApi = createChrome();
  chromeApi.tabs.create = async () => { throw new Error('TOPSECRET https://origin.test/?token=x'); };
  const model = structuredClone(SAMPLE_AUDIT);
  let latest = { auditId: model.auditId, status: 'complete', exportStatus: 'complete' };
  const commits = [];
  const auditStore = {
    async getAudit() { return model; }, async getLatest() { return latest; },
    async setLatest(value) { latest = value; },
    async commitAudit(...values) { commits.push(values); latest = values[2]; },
  };
  registerServiceWorker(chromeApi, { auditStore: withAuditRevisions(auditStore), now: () => '2026-08-26T16:00:00.000Z' });
  let response;
  chromeApi.listeners.message.listener(
    { type: 'REQUEST_EXPORT', auditId: model.auditId },
    { id: 'test', url: `chrome-extension://test/src/review/index.html?auditId=${model.auditId}` },
    value => { response = value; },
  );
  await waitUntil(() => response !== undefined);
  assert.equal(response.ok, false);
  assert.equal(commits.length, 1);
  assert.equal(commits[0][1].session.status, 'partial');
  assert.equal(commits[0][2].exportStatus, 'failed');
  assert.doesNotMatch(JSON.stringify(commits), /TOPSECRET|origin\.test|blob:|chrome-extension:/iu);
});

test('a newer review makes an old queued export marker stale and never blocks the immediate retry', async () => {
  const chromeApi = createChrome();
  let releaseFirstTab;
  let exportTabCalls = 0;
  chromeApi.tabs.create = async options => {
    exportTabCalls += 1;
    if (exportTabCalls === 1) {
      await new Promise(resolve => { releaseFirstTab = resolve; });
      throw new Error('tab denied after review');
    }
    chromeApi.createdTabs.push(options);
  };
  const store = createInMemoryAuditStore();
  const model = structuredClone(SAMPLE_AUDIT);
  await store.setAudit(model.auditId, model);
  await store.setLatest({ auditId: model.auditId, status: 'complete', exportStatus: 'complete' });
  registerServiceWorker(chromeApi, { auditStore: store, now: () => '2026-08-26T16:00:00.000Z' });
  const sender = { id: 'test', url: `chrome-extension://test/src/review/index.html?auditId=${model.auditId}` };
  let first;
  chromeApi.listeners.message.listener(
    { type: 'REQUEST_EXPORT', auditId: model.auditId },
    sender,
    value => { first = value; },
  );
  await waitUntil(async () => (await store.getLatest())?.exportStatus === 'queued');
  await commitReviewDecision(model, {
    auditId: model.auditId,
    itemId: '5.1.4',
    occurrenceId: 'occ-focus-review',
    answer: 'não foi possível determinar',
    evaluator: 'Pessoa avaliadora',
    decidedAt: '2026-08-26T16:01:00.000Z',
    mode: 'assisted',
  }, store);
  releaseFirstTab();
  await waitUntil(() => first !== undefined);
  assert.equal(first.ok, false);
  assert.equal((await store.getAudit(model.auditId)).reviewDecisions.length, 1);

  let second;
  chromeApi.listeners.message.listener(
    { type: 'REQUEST_EXPORT', auditId: model.auditId },
    sender,
    value => { second = value; },
  );
  await waitUntil(() => second !== undefined);
  assert.equal(second.ok, true);
  assert.equal(second.auditId, model.auditId);
  assert.equal(second.state, 'queued');
  assert.equal(Number.isSafeInteger(second.exportRevision), true);
  assert.equal(exportTabCalls, 2);
});

test('commit failure sends no completion and persists only best-effort failed latest', async () => {
  const chromeApi = createChrome();
  const latest = [];
  const auditStore = {
    async setLatest(value) { latest.push(value); },
    async commitAudit() { throw new Error('transaction aborted'); },
  };
  registerServiceWorker(chromeApi, {
    createId: () => 'audit-commit-fail', auditStore: withAuditRevisions(auditStore), chromeAdapterFactory: () => ({}),
    runner: async () => ({ auditId: 'audit-commit-fail', session: { status: 'complete' }, report: {} }),
  });
  chromeApi.listeners.message.listener({ type: 'START_AUDIT', url: 'https://example.test/' }, { id: 'test', url: 'chrome-extension://test/src/panel/index.html' }, () => {});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(chromeApi.runtime.sent.some(message => message.type === 'AUDIT_COMPLETE'), false);
  assert.equal(latest.at(-1).status, 'failed');
});

test('restores the latest persisted audit state to a reopened authorized panel', async () => {
  const chromeApi = createChrome();
  const latest = { auditId: 'audit-last', status: 'partial', percent: 100, reviewUrl: 'chrome-extension://test/src/review/index.html?auditId=audit-last' };
  registerServiceWorker(chromeApi, { auditStore: { async getLatest() { return latest; } } });
  let response;
  const keepOpen = chromeApi.listeners.message.listener(
    { type: 'GET_LAST_AUDIT' },
    { id: 'test', url: 'chrome-extension://test/src/panel/index.html' },
    value => { response = value; },
  );
  assert.equal(keepOpen, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(response, { ok: true, state: latest });
});

test('restored complete or partial exports become stale after a newer audit revision', async () => {
  for (const exportStatus of ['complete', 'partial']) {
    const chromeApi = createChrome();
    const auditStore = createInMemoryAuditStore();
    await auditStore.setAudit('audit-stale-export', { auditId: 'audit-stale-export', reviewDecisions: [] });
    await auditStore.setLatest({
      auditId: 'audit-stale-export',
      status: 'complete',
      exportStatus,
      exportRevision: 1,
      message: 'Arquivos do relatório gerados.',
    });
    await auditStore.setAudit('audit-stale-export', {
      auditId: 'audit-stale-export',
      reviewDecisions: [{ decisionId: 'newer-human-decision' }],
    });
    registerServiceWorker(chromeApi, { auditStore });
    let response;
    chromeApi.listeners.message.listener(
      { type: 'GET_LAST_AUDIT' },
      { id: 'test', url: 'chrome-extension://test/src/panel/index.html' },
      value => { response = value; },
    );
    await waitUntil(() => response !== undefined);
    assert.equal(response.state.exportStatus, 'failed');
    assert.match(response.state.message, /atualizada|desatualizado|gere.+novamente/iu);
  }
});

test('does not acknowledge queued before persistent exclusivity and reports a concurrent retry as BUSY', async () => {
  const chromeApi = createChrome();
  const store = createInMemoryAuditStore();
  const model = structuredClone(SAMPLE_AUDIT);
  await store.setAudit(model.auditId, model);
  await store.setLatest({ auditId: model.auditId, exportStatus: 'complete' });
  const acquire = store.acquireExportLease.bind(store);
  let releaseAcquire;
  const gate = new Promise(resolve => { releaseAcquire = resolve; });
  store.acquireExportLease = async (...args) => { await gate; return acquire(...args); };
  registerServiceWorker(chromeApi, {
    auditStore: store,
    now: () => '2026-08-27T10:00:00.000Z',
    createExportOwnerId: () => 'owner-exclusive',
  });
  const sender = { id: 'test', url: `chrome-extension://test/src/review/index.html?auditId=${model.auditId}` };
  let first;
  let retry;
  chromeApi.listeners.message.listener(
    { type: 'REQUEST_EXPORT', auditId: model.auditId }, sender, value => { first = value; },
  );
  chromeApi.listeners.message.listener(
    { type: 'REQUEST_EXPORT', auditId: model.auditId }, sender, value => { retry = value; },
  );
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(first, undefined);
  assert.deepEqual(retry, {
    ok: false,
    auditId: model.auditId,
    state: 'busy',
    code: 'EXPORT_BUSY',
    retryable: true,
    error: 'Este relatório já está sendo gerado; tente novamente após a conclusão.',
  });
  assert.equal(chromeApi.createdTabs.length, 0);

  releaseAcquire();
  await waitUntil(() => first !== undefined);
  assert.equal(first.ok, true);
  assert.equal(first.state, 'queued');
  assert.equal(Number.isSafeInteger(first.exportRevision), true);
  assert.equal(chromeApi.createdTabs.filter(tab => tab.url.includes('/src/export/')).length, 1);
});

test('maps a review race before lease acquisition to an explicit retryable stale response', async () => {
  const chromeApi = createChrome();
  const store = createInMemoryAuditStore();
  const model = structuredClone(SAMPLE_AUDIT);
  await store.setAudit(model.auditId, model);
  const acquire = store.acquireExportLease.bind(store);
  let raced = false;
  store.acquireExportLease = async (...args) => {
    if (!raced) {
      raced = true;
      await store.setAudit(model.auditId, { ...structuredClone(model), reviewRace: true });
    }
    return acquire(...args);
  };
  registerServiceWorker(chromeApi, {
    auditStore: store,
    now: () => '2026-08-27T10:00:00.000Z',
    createExportOwnerId: () => 'owner-stale-retry',
  });
  let response;
  chromeApi.listeners.message.listener(
    { type: 'REQUEST_EXPORT', auditId: model.auditId },
    { id: 'test', url: `chrome-extension://test/src/review/index.html?auditId=${model.auditId}` },
    value => { response = value; },
  );
  await waitUntil(() => response !== undefined);
  assert.deepEqual(response, {
    ok: false,
    auditId: model.auditId,
    state: 'stale',
    code: 'AUDIT_REVISION_CONFLICT',
    retryable: true,
    error: 'A auditoria foi atualizada; solicite novamente o relatório revisado.',
  });
  assert.equal(chromeApi.createdTabs.some(tab => tab.url.includes('/src/export/')), false);
});

test('two service-worker instances share the persistent lease and open only one export tab', async () => {
  const backing = new Map();
  const firstStore = createInMemoryAuditStore(backing);
  const secondStore = createInMemoryAuditStore(backing);
  const model = structuredClone(SAMPLE_AUDIT);
  await firstStore.setAudit(model.auditId, model);
  await firstStore.setLatest({ auditId: model.auditId, exportStatus: 'complete' });
  const firstChrome = createChrome();
  const secondChrome = createChrome();
  registerServiceWorker(firstChrome, {
    auditStore: firstStore, now: () => '2026-08-27T10:00:00.000Z', createExportOwnerId: () => 'owner-worker-a',
  });
  registerServiceWorker(secondChrome, {
    auditStore: secondStore, now: () => '2026-08-27T10:00:00.000Z', createExportOwnerId: () => 'owner-worker-b',
  });
  const sender = { id: 'test', url: `chrome-extension://test/src/review/index.html?auditId=${model.auditId}` };
  let first;
  let second;
  firstChrome.listeners.message.listener(
    { type: 'REQUEST_EXPORT', auditId: model.auditId }, sender, value => { first = value; },
  );
  secondChrome.listeners.message.listener(
    { type: 'REQUEST_EXPORT', auditId: model.auditId }, sender, value => { second = value; },
  );
  await waitUntil(() => first !== undefined && second !== undefined);
  const responses = [first, second];
  assert.equal(responses.filter(response => response.ok && response.state === 'queued').length, 1);
  assert.equal(responses.filter(response => response.code === 'EXPORT_BUSY' && response.retryable).length, 1);
  assert.equal([
    ...firstChrome.createdTabs,
    ...secondChrome.createdTabs,
  ].filter(tab => tab.url.includes('/src/export/')).length, 1);
});

test('GET_LAST keeps an uncorrelated initial export handshake retryable instead of marking it failed', async () => {
  const chromeApi = createChrome();
  const store = createInMemoryAuditStore();
  await store.setAudit('audit-handshake', { auditId: 'audit-handshake' });
  await store.setLatest({
    auditId: 'audit-handshake',
    status: 'complete',
    exportStatus: 'queued',
    message: 'Relatório na fila de geração.',
  });
  registerServiceWorker(chromeApi, { auditStore: store });
  let response;
  chromeApi.listeners.message.listener(
    { type: 'GET_LAST_AUDIT' },
    { id: 'test', url: 'chrome-extension://test/src/panel/index.html' },
    value => { response = value; },
  );
  await waitUntil(() => response !== undefined);
  assert.equal(response.state.exportStatus, 'preparing');
  assert.notEqual(response.state.exportStatus, 'failed');
  assert.match(response.state.message, /preparando|tente novamente|geração/iu);
});

test('GET_LAST treats a same-revision queued marker without a live lease as retryable stale state', async () => {
  const chromeApi = createChrome();
  const store = createInMemoryAuditStore();
  await store.setAudit('audit-orphan-marker', { auditId: 'audit-orphan-marker' });
  const snapshot = await store.getAuditSnapshot('audit-orphan-marker');
  await store.setLatest({
    auditId: 'audit-orphan-marker',
    status: 'complete',
    exportStatus: 'queued',
    exportRevision: snapshot.revision,
    message: 'Relatório na fila de geração.',
  });
  registerServiceWorker(chromeApi, {
    auditStore: store,
    now: () => '2026-08-27T10:00:00.000Z',
  });
  let response;
  chromeApi.listeners.message.listener(
    { type: 'GET_LAST_AUDIT' },
    { id: 'test', url: 'chrome-extension://test/src/panel/index.html' },
    value => { response = value; },
  );
  await waitUntil(() => response !== undefined);
  assert.equal(response.state.exportStatus, 'preparing');
  assert.match(response.state.message, /interrompida|novamente|preparando|geração/iu);
});

test('GET_LAST rejects a queued marker whose owner differs from the live lease', async () => {
  const chromeApi = createChrome();
  const store = createInMemoryAuditStore();
  await store.setAudit('audit-owner-marker', { auditId: 'audit-owner-marker' });
  const snapshot = await store.getAuditSnapshot('audit-owner-marker');
  const lease = await store.acquireExportLease('audit-owner-marker', snapshot.capability, {
    ownerId: 'owner-live', now: '2026-08-27T10:00:00.000Z',
    latestState: {
      auditId: 'audit-owner-marker', status: 'complete', exportStatus: 'queued',
      exportRevision: snapshot.revision, leaseOwnerId: 'owner-live',
    },
  });
  await store.setLatest({
    auditId: 'audit-owner-marker', status: 'complete', exportStatus: 'queued',
    exportRevision: snapshot.revision, exportAttempt: lease.exportAttempt,
    leaseOwnerId: 'owner-forged',
  });
  registerServiceWorker(chromeApi, { auditStore: store, now: () => '2026-08-27T10:00:00.100Z' });
  let response;
  chromeApi.listeners.message.listener(
    { type: 'GET_LAST_AUDIT' },
    { id: 'test', url: 'chrome-extension://test/src/panel/index.html' },
    value => { response = value; },
  );
  await waitUntil(() => response !== undefined);
  assert.equal(response.state.exportStatus, 'preparing');
});

test('GET_LAST retries a torn latest/snapshot read instead of reporting a live delivery as failed', async () => {
  const chromeApi = createChrome();
  const store = createInMemoryAuditStore();
  await store.setAudit('audit-restore-race', { auditId: 'audit-restore-race', phase: 'reviewed' });
  const queuedSnapshot = await store.getAuditSnapshot('audit-restore-race');
  await store.acquireExportLease('audit-restore-race', queuedSnapshot.capability, {
    ownerId: 'owner-restore-race', now: '2026-08-27T10:00:00.000Z',
    latestState: {
      auditId: 'audit-restore-race', status: 'complete', exportStatus: 'queued',
      exportRevision: queuedSnapshot.revision,
      leaseOwnerId: 'owner-restore-race',
    },
  });
  await store.claimExportLease('audit-restore-race', queuedSnapshot.capability, {
    ownerId: 'owner-restore-race', now: '2026-08-27T10:00:00.100Z',
    latestState: {
      auditId: 'audit-restore-race', status: 'complete', exportStatus: 'running',
      exportRevision: queuedSnapshot.revision,
      leaseOwnerId: 'owner-restore-race',
    },
  });
  const readSnapshot = store.getAuditSnapshot.bind(store);
  let raced = false;
  store.getAuditSnapshot = async id => {
    if (!raced) {
      raced = true;
      await store.commitAuditIfRevisionWithExportLease(
        id,
        { auditId: id, phase: 'delivering' },
        {
          auditId: id, status: 'complete', exportStatus: 'delivering',
          exportRevision: queuedSnapshot.revision + 1,
          leaseOwnerId: 'owner-restore-race',
        },
        queuedSnapshot.capability,
        { ownerId: 'owner-restore-race', now: '2026-08-27T10:00:00.200Z', phase: 'delivering' },
      );
    }
    return readSnapshot(id);
  };
  registerServiceWorker(chromeApi, {
    auditStore: store,
    now: () => '2026-08-27T10:00:00.300Z',
  });
  let response;
  chromeApi.listeners.message.listener(
    { type: 'GET_LAST_AUDIT' },
    { id: 'test', url: 'chrome-extension://test/src/panel/index.html' },
    value => { response = value; },
  );
  await waitUntil(() => response !== undefined);
  assert.equal(response.ok, true);
  assert.equal(response.state.exportStatus, 'delivering');
  assert.equal(response.state.exportRevision, queuedSnapshot.revision + 1);
});

test('handles rejected panel-tab creation without an unhandled rejection', async () => {
  const chromeApi = createChrome();
  chromeApi.tabs.create = async () => { throw new Error('tabs indisponível'); };
  const errors = [];
  registerServiceWorker(chromeApi, { createId: () => 'audit-1', logger: { error: (message) => errors.push(message) } });
  chromeApi.listeners.action.listener();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(errors, ['Não foi possível abrir o painel de auditoria.']);
});
