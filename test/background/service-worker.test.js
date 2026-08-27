import assert from 'node:assert/strict';
import test from 'node:test';

import { SAMPLE_AUDIT } from '../../fixtures/audits/sample-audit.js';
import { createSessionStore, isAuthorizedExtensionSender, isAuthorizedPanelSender, registerServiceWorker } from '../../src/background/service-worker.js';
import { commitReviewDecision } from '../../src/review/review-state.js';
import { createInMemoryAuditStore } from '../../src/storage/audit-store.js';

const createChrome = () => {
  const action = {};
  const message = {};
  const createdTabs = [];
  return {
    action: { onClicked: { addListener(listener) { action.listener = listener; } } },
    runtime: {
      id: 'test',
      getURL: (path) => `chrome-extension://test/${path}`,
      onMessage: { addListener(listener) { message.listener = listener; } },
      sent: [],
      async sendMessage(value) { this.sent.push(value); },
    },
    tabs: { create: async (options) => { createdTabs.push(options); } },
    listeners: { action, message },
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
  };
}

test('opens the local panel in one tab when the action is clicked', async () => {
  const chromeApi = createChrome();
  registerServiceWorker(chromeApi, { createId: () => 'audit-1' });
  await chromeApi.listeners.action.listener();
  assert.deepEqual(chromeApi.createdTabs, [{ url: 'chrome-extension://test/src/panel/index.html' }]);
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
  for (const path of ['/src/panel/index.html', '/src/review/index.html?auditId=audit-1', '/src/export/index.html?auditId=audit-1']) {
    assert.equal(isAuthorizedExtensionSender({ id: 'test', url: `chrome-extension://test${path}` }, 'test'), true);
  }
  for (const url of [
    'https://example.test/src/review/index.html?auditId=audit-1',
    'chrome-extension://test/src/review/index.html?auditId=../escape',
    'chrome-extension://test/src/export/index.html?auditId=audit-1&extra=x',
    'chrome-extension://other/src/export/index.html?auditId=audit-1',
  ]) assert.equal(isAuthorizedExtensionSender({ id: 'test', url }, 'test'), false);
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

test('ACKs immediately and reports a background persistence failure without an unhandled rejection', async () => {
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
  await assert.rejects(store.set('audit-1', { id: 'audit-1' }), /storage denied/);

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
  assert.ok(chromeApi.createdTabs.some(tab => tab.active === false && tab.url === 'chrome-extension://test/src/export/index.html?auditId=audit-1'));
});

test('regenerates only a known audit from review and deduplicates persisted queued export state', async () => {
  const chromeApi = createChrome();
  let latest = { auditId: 'audit-1', status: 'partial', exportStatus: 'complete' };
  const auditStore = {
    async getAudit(id) { return id === 'audit-1' ? { auditId: id } : undefined; },
    async getLatest() { return latest; },
    async setLatest(value) { latest = value; },
  };
  registerServiceWorker(chromeApi, { auditStore: withAuditRevisions(auditStore), now: () => '2026-08-26T15:00:00.000Z' });
  const sender = { id: 'test', url: 'chrome-extension://test/src/review/index.html?auditId=audit-1' };
  let first;
  chromeApi.listeners.message.listener({ type: 'REQUEST_EXPORT', auditId: 'audit-1' }, sender, value => { first = value; });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(first, { ok: true, auditId: 'audit-1', state: 'queued' });
  assert.equal(latest.exportStatus, 'queued');
  assert.equal(latest.exportQueuedAt, '2026-08-26T15:00:00.000Z');
  assert.ok(chromeApi.createdTabs.some(tab => tab.url.endsWith('/src/export/index.html?auditId=audit-1') && tab.active === false));
  let duplicate;
  chromeApi.listeners.message.listener({ type: 'REQUEST_EXPORT', auditId: 'audit-1' }, sender, value => { duplicate = value; });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(duplicate, { ok: true, auditId: 'audit-1', state: 'queued', duplicate: true });
});

test('serializes concurrent REQUEST_EXPORT so only one inactive export tab opens', async () => {
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
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(chromeApi.createdTabs.filter(tab => tab.url.includes('/src/export/')).length, 1);
  assert.equal(responses.length, 2);
  assert.equal(responses.filter(response => response.duplicate).length, 1);
});

test('recovers an orphaned queued export after worker restart but keeps a fresh queue deduplicated', async () => {
  for (const [queuedAt, shouldOpen] of [[undefined, true], ['not-an-iso-date', true], ['2026-08-26T14:59:30.000Z', false]]) {
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
    assert.equal(chromeApi.createdTabs.some(tab => tab.url.includes('/src/export/')), shouldOpen);
    assert.equal(Boolean(response.duplicate), !shouldOpen);
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
  assert.deepEqual(second, { ok: true, auditId: model.auditId, state: 'queued' });
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

test('handles rejected panel-tab creation without an unhandled rejection', async () => {
  const chromeApi = createChrome();
  chromeApi.tabs.create = async () => { throw new Error('tabs indisponível'); };
  const errors = [];
  registerServiceWorker(chromeApi, { createId: () => 'audit-1', logger: { error: (message) => errors.push(message) } });
  chromeApi.listeners.action.listener();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(errors, ['Não foi possível abrir o painel de auditoria.']);
});
