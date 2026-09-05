import assert from 'node:assert/strict';
import test from 'node:test';
import { SAMPLE_AUDIT } from '../../fixtures/audits/sample-audit.js';
import { createBlobUrlRegistryV1 } from '../../src/background/blob-url-registry.js';
import { downloadArtifacts } from '../../src/browser/download-artifacts.js';
import { runReportExport } from '../../src/export/report-export.js';

const OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PDF = new TextEncoder().encode('%PDF-1.7\nlocal');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const settle = () => new Promise(resolve => setImmediate(resolve));

function fixture() {
  const values = new Map(); const urls = new Set(); const events = [];
  let serial = 0; let downloadId = 0;
  const keyFor = url => `audita:blob-url:v1:${encodeURIComponent(url)}`;
  const urlApi = {
    createObjectURL() {
      const url = `blob:chrome-extension://${'a'.repeat(32)}/${String(++serial).padStart(8, '0')}-1111-4111-8111-111111111111`;
      urls.add(url); events.push(['create', url]); return url;
    },
    revokeObjectURL(url) { urls.delete(url); events.push(['native-revoke', url]); },
  };
  const registry = createBlobUrlRegistryV1({
    sessionArea: {
      async get(key) { return key === null ? Object.fromEntries(values) : values.has(key) ? { [key]: values.get(key) } : {}; },
      async set(rows) { for (const [key, value] of Object.entries(rows)) values.set(key, structuredClone(value)); },
      async remove(key) { values.delete(key); },
    },
    async isOwnerAlive({ ownerDocumentId }) { return ownerDocumentId === OWNER; },
    async revokeInOwner(entry) {
      assert.equal(entry.ownerDocumentId, OWNER); assert.equal(entry.auditId, SAMPLE_AUDIT.auditId);
      urlApi.revokeObjectURL(entry.blobUrl); return true;
    },
  });
  const blobLifecycle = {
    async register(blobUrl) {
      await registry.register({ auditId: SAMPLE_AUDIT.auditId, blobUrl, ownerDocumentId: OWNER });
      events.push(['registered', blobUrl]);
    },
    async release(blobUrl) {
      assert.equal(urls.has(blobUrl), false, 'native revoke must happen before releasing the journal');
      await registry.release({ auditId: SAMPLE_AUDIT.auditId, blobUrl, ownerDocumentId: OWNER });
      events.push(['released', blobUrl]);
    },
  };
  const consume = (type, url) => {
    assert.equal(values.has(keyFor(url)), true, 'temporary URL must be registered before exposure');
    assert.equal(urls.has(url), true);
    events.push([type, url]);
  };
  const downloadsAdapter = {
    ...urlApi,
    async download({ url }) { consume('download', url); return ++downloadId; },
    async waitForDownload(id) { return { id, state: 'complete' }; },
    async resolveDownloadFilename(_id, { requestedFilename }) { return requestedFilename; },
  };
  const dependencies = {
    urlApi, downloadsAdapter, blobLifecycle,
    tabAdapter: {
      async createPrintTab({ url }) { consume('print', url); return { id: 70 }; },
      async waitForReady() {}, async connectCdp() { return { async disconnect() {} }; },
      async waitForAssets() {}, async removeTab() { events.push(['print-tab-removed']); },
    },
    async pdfRenderer() { return { bytes: PDF, usedFallback: false, limitations: [] }; },
  };
  return { values, urls, events, urlApi, registry, blobLifecycle, downloadsAdapter, dependencies };
}

function download(env, options = {}) {
  return downloadArtifacts({ baseName: 'audita-local', html: '<!doctype html>Relatório' }, env.downloadsAdapter,
    { timeoutMs: 500, hashBytes: () => 'a'.repeat(64), blobLifecycle: env.blobLifecycle, ...options });
}
function report(env, options = {}) {
  return runReportExport({ auditModel: structuredClone(SAMPLE_AUDIT), now: () => '2026-08-26T15:00:00.000Z',
    timeoutMs: 500, ...options }, env.dependencies);
}

test('download waits for durable registration and releases only after native revocation', async () => {
  const env = fixture(); const entered = deferred(); const unblock = deferred();
  const register = env.blobLifecycle.register;
  env.blobLifecycle.register = async url => { entered.resolve(); await unblock.promise; return register(url); };
  const resultPromise = download(env);
  await Promise.race([entered.promise, resultPromise]);
  assert.equal(env.events.some(([type]) => type === 'download'), false);
  unblock.resolve(); const result = await resultPromise;
  assert.equal(result.formats[0].status, 'complete');
  assert.equal(env.values.size, 0); assert.equal(env.urls.size, 0);
  assert.deepEqual(env.events.map(([type]) => type), ['create', 'registered', 'download', 'native-revoke', 'native-revoke', 'released']);
  assert.doesNotMatch(JSON.stringify(result), /blob:|ownerDocumentId/u);
});

test('unconfirmed registration prevents a download and still revokes the locally created URL', async () => {
  const env = fixture();
  env.blobLifecycle.register = async () => { throw new Error('PRIVATE_SENTINEL'); };
  const result = await download(env);
  assert.equal(env.events.some(([type]) => type === 'download'), false);
  assert.equal(env.urls.size, 0); assert.equal(env.values.size, 0);
  assert.equal(result.formats[0].failureCode, 'ARTIFACT_BLOB_FAILED');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SENTINEL|blob:/u);
});

test('a negative registration response is not accepted as the void success contract', async () => {
  const env = fixture(); env.blobLifecycle.register = async () => ({ ok: false });
  const result = await download(env);
  assert.equal(result.formats[0].failureCode, 'ARTIFACT_BLOB_FAILED');
  assert.equal(env.events.some(([type]) => type === 'download'), false);
  assert.equal(env.urls.size, 0);
});

test('a negative release response is reported and leaves the journal recoverable', async () => {
  const env = fixture(); env.blobLifecycle.release = async () => false;
  const result = await download(env);
  assert.equal(result.formats[0].status, 'complete');
  assert.equal(result.limitations.length, 1);
  assert.equal(env.values.size, 1); assert.equal(env.urls.size, 0);
});

test('registration resolving after timeout cannot expose a URL or recreate a dangling journal', async () => {
  const env = fixture(); const late = deferred(); const register = env.blobLifecycle.register;
  env.blobLifecycle.register = async url => { await late.promise; return register(url); };
  const result = await download(env, { timeoutMs: 20 });
  assert.equal(result.formats[0].failureCode, 'ARTIFACT_BLOB_FAILED');
  assert.equal(env.events.some(([type]) => type === 'download'), false);
  assert.equal(env.urls.size, 0);
  late.resolve(); await settle(); await settle();
  assert.equal(env.values.size, 0);
});

test('release failure preserves a recovery journal without removing a completed download', async () => {
  const env = fixture();
  env.blobLifecycle.release = async () => { throw new Error('PRIVATE_SENTINEL'); };
  const result = await download(env);
  assert.equal(result.formats[0].status, 'complete');
  assert.equal(env.urls.size, 0); assert.equal(env.values.size, 1);
  assert.equal(result.limitations.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SENTINEL|blob:/u);
  assert.equal(await env.registry.clearAudit(SAMPLE_AUDIT.auditId), 1);
});

test('native revocation failure does not erase the last recovery record', async () => {
  const env = fixture();
  env.downloadsAdapter.revokeObjectURL = () => { throw new Error('PRIVATE_SENTINEL'); };
  const result = await download(env);
  assert.equal(result.formats[0].status, 'complete');
  assert.equal(env.urls.size, 1); assert.equal(env.values.size, 1);
  assert.equal(env.events.some(([type]) => type === 'released'), false);
  assert.equal(result.limitations.length, 1);
});

test('report registers both print preview and all four downloads using the creator document', async () => {
  const env = fixture(); const result = await report(env);
  assert.equal(result.deliveryReceipt.status, 'complete');
  assert.equal(env.events.filter(([type]) => type === 'print').length, 1);
  assert.equal(env.events.filter(([type]) => type === 'download').length, 4);
  assert.equal(env.events.filter(([type]) => type === 'registered').length, 5);
  assert.equal(env.events.filter(([type]) => type === 'released').length, 5);
  assert.equal(env.values.size, 0); assert.equal(env.urls.size, 0);
  assert.doesNotMatch(JSON.stringify(result.deliveryReceipt), /blob:|ownerDocumentId/u);
});

test('unconfirmed print registration creates no print tab and produces an explicit partial report', async () => {
  const env = fixture(); const register = env.blobLifecycle.register;
  let first = true;
  env.blobLifecycle.register = async url => { if (first) { first = false; throw new Error('PRIVATE_SENTINEL'); } return register(url); };
  const result = await report(env);
  assert.equal(env.events.some(([type]) => type === 'print'), false);
  assert.equal(result.deliveryReceipt.status, 'partial');
  assert.equal(result.pdf, null);
  assert.equal(result.formats.length, 3);
  assert.equal(result.formats.every(item => item.status === 'complete'), true);
  assert.equal(env.urls.size, 0); assert.equal(env.values.size, 0);
  assert.doesNotMatch(JSON.stringify(result.deliveryReceipt), /PRIVATE_SENTINEL|blob:/u);
});

test('late print registration is released without creating a print tab after timeout', async () => {
  const env = fixture(); const late = deferred(); const register = env.blobLifecycle.register;
  let first = true;
  env.blobLifecycle.register = async url => { if (first) { first = false; await late.promise; } return register(url); };
  const result = await report(env, { timeoutMs: 20 });
  assert.equal(result.deliveryReceipt.status, 'partial');
  assert.equal(env.events.some(([type]) => type === 'print'), false);
  assert.equal(env.events.filter(([type]) => type === 'download').length, 3);
  late.resolve(); await settle(); await settle();
  assert.equal(env.values.size, 0); assert.equal(env.urls.size, 0);
  assert.equal(env.events.filter(([type]) => type === 'registered').length, 4);
  assert.equal(env.events.filter(([type]) => type === 'released').length >= 4, true);
});

test('invalid lifecycle hooks fail before creating any temporary URL', async t => {
  for (const hooks of [null, {}, { register() {} }, { register() {}, release: true }, { register() {}, release() {}, content: 'PRIVATE_SENTINEL' }]) {
    await t.test(String(hooks), async () => {
      const env = fixture();
      await assert.rejects(download(env, { blobLifecycle: hooks }), /BLOB_LIFECYCLE_INVALID/u);
      env.dependencies.blobLifecycle = hooks;
      await assert.rejects(report(env), /BLOB_LIFECYCLE_INVALID/u);
      assert.deepEqual(env.events, []); assert.equal(env.values.size, 0);
    });
  }
});
