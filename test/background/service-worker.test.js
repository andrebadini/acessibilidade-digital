import assert from 'node:assert/strict';
import test from 'node:test';

import { createSessionStore, isAuthorizedPanelSender, registerServiceWorker } from '../../src/background/service-worker.js';

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
    async setAudit(id, value) { writes.push(['audit', id, value]); },
    async setLatest(value) { writes.push(['latest', value]); },
  };
  const runner = async ({ chromeAdapter }) => {
    await chromeAdapter.emitProgress({ type: 'AUDIT_PROGRESS', auditId: 'audit-1', sessionId: 'audit-1', percent: 50, message: 'Verificando acessibilidade' });
    return { auditId: 'audit-1', session: { status: 'complete' }, report: { reviewUrl: 'chrome-extension://test/src/review/index.html?auditId=audit-1' } };
  };
  registerServiceWorker(chromeApi, {
    createId: () => 'audit-1', runner, auditStore,
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
  assert.ok(writes.some(([kind, id]) => kind === 'audit' && id === 'audit-1'));
});

test('deduplicates concurrent START_AUDIT messages from the same panel sender', () => {
  const chromeApi = createChrome();
  let finish;
  const runner = () => new Promise(resolve => { finish = resolve; });
  registerServiceWorker(chromeApi, { createId: () => 'audit-1', runner, auditStore: { async setLatest() {}, async setAudit() {} }, chromeAdapterFactory: () => ({}) });
  const sender = { id: 'test', url: 'chrome-extension://test/src/panel/index.html', documentId: 'panel-1' };
  let first;
  let second;
  chromeApi.listeners.message.listener({ type: 'START_AUDIT', url: 'https://example.test/' }, sender, value => { first = value; });
  chromeApi.listeners.message.listener({ type: 'START_AUDIT', url: 'https://example.test/' }, sender, value => { second = value; });
  assert.equal(first.auditId, 'audit-1');
  assert.deepEqual(second, { ok: true, auditId: 'audit-1', state: 'running', duplicate: true });
  finish?.({ auditId: 'audit-1', session: { status: 'complete' }, report: {} });
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

test('handles rejected panel-tab creation without an unhandled rejection', async () => {
  const chromeApi = createChrome();
  chromeApi.tabs.create = async () => { throw new Error('tabs indisponível'); };
  const errors = [];
  registerServiceWorker(chromeApi, { createId: () => 'audit-1', logger: { error: (message) => errors.push(message) } });
  chromeApi.listeners.action.listener();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(errors, ['Não foi possível abrir o painel de auditoria.']);
});
