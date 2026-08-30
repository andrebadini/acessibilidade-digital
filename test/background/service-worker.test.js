import assert from 'node:assert/strict';
import test from 'node:test';

import { PANEL_PORT_NAME } from '../../src/background/panel-port.js';
import { registerServiceWorker } from '../../src/background/service-worker.js';

const CAPABILITY = 'C'.repeat(22);

function event() {
  const listeners = new Set();
  return {
    listeners,
    addListener(listener) { listeners.add(listener); },
    removeListener(listener) { listeners.delete(listener); },
    emit(...args) { for (const listener of [...listeners]) listener(...args); },
  };
}

function chromeFixture() {
  const events = {
    message: event(), connect: event(), installed: event(), context: event(),
    updated: event(), tabRemoved: event(), windowRemoved: event(),
  };
  return {
    events,
    chromeApi: {
      runtime: {
        id: 'abcdefghijklmnopabcdefghijklmnop',
        onMessage: events.message, onConnect: events.connect, onInstalled: events.installed,
      },
      contextMenus: { onClicked: events.context, async removeAll() {}, create() {} },
      sidePanel: { async open() {} },
      tabs: { onUpdated: events.updated, onRemoved: events.tabRemoved },
      windows: { onRemoved: events.windowRemoved },
      storage: { session: { async setAccessLevel() {} } },
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function tick() { return new Promise(resolve => setImmediate(resolve)); }

function runtimeValue() {
  return Object.freeze({ authority: Object.freeze({}), auditStarter: Object.freeze({}), chromeAdapter: Object.freeze({}) });
}

function defaultGraphFixture(initialSessionValues = null) {
  const { chromeApi, events } = chromeFixture();
  const sessionValues = Object.create(null);
  const contexts = new Map();
  const sent = [];
  const createdTabs = [];
  const snapshots = new Map();
  const retentions = new Map();
  let latest = null;
  let leaseResult = { acquired: true, exportAttempt: 1 };
  let deletedAll = 0;
  let deleteError = null;
  const deleted = [];

  if (initialSessionValues) Object.assign(sessionValues, structuredClone(initialSessionValues));

  chromeApi.storage.session = {
    async setAccessLevel() {},
    async get(key) {
      if (key === null) return structuredClone(sessionValues);
      return Object.hasOwn(sessionValues, key) ? { [key]: structuredClone(sessionValues[key]) } : {};
    },
    async set(entries) { Object.assign(sessionValues, structuredClone(entries)); },
    async remove(key) {
      for (const entry of Array.isArray(key) ? key : [key]) delete sessionValues[entry];
    },
  };
  Object.defineProperty(chromeApi.storage, 'local', {
    enumerable: true,
    get() { throw new Error('storage.local must remain untouched'); },
  });
  chromeApi.runtime.getURL = path => `chrome-extension://${chromeApi.runtime.id}/${path}`;
  chromeApi.runtime.getContexts = async ({ documentIds }) => {
    const value = contexts.get(documentIds[0]);
    return value ? [structuredClone(value)] : [];
  };
  chromeApi.runtime.sendMessage = (message, callback) => {
    sent.push(structuredClone(message));
    callback?.();
  };
  chromeApi.tabs.create = (options, callback) => {
    createdTabs.push(structuredClone(options));
    callback?.({ id: 77 });
  };
  chromeApi.tabs.query = async () => [];

  const auditStore = {
    async getLatest() { return structuredClone(latest); },
    async setLatest(value) { latest = structuredClone(value); },
    async getAuditSnapshot(auditId) {
      const value = snapshots.get(auditId);
      return value ? { ...value } : { model: undefined, revision: 0, capability: null };
    },
    async getReportRevision() { return null; },
    async getAuditRetention(auditId) { return retentions.get(auditId); },
    async acquireExportLease(_auditId, _capability, options) {
      return leaseResult.acquired
        ? { acquired: true, exportAttempt: leaseResult.exportAttempt, ownerId: options.ownerId }
        : { acquired: false, retryAt: leaseResult.retryAt ?? null };
    },
    async deleteAudit(auditId) {
      if (deleteError) throw deleteError;
      snapshots.delete(auditId);
      deleted.push(auditId);
      return { deleted: true };
    },
    async deleteAllAudits() {
      if (deleteError) throw deleteError;
      snapshots.clear();
      return { deleted: deletedAll };
    },
    async commitAuditWithCheckpointIfAbsent() { throw new Error('must not commit during compatibility tests'); },
  };

  const registration = registerServiceWorker(chromeApi, {
    auditStore,
    chromeAdapterFactory() {
      return Object.freeze({
        async probeDocumentIdentity() { throw new Error('not used'); },
        async getEvidenceUrl() { throw new Error('not used'); },
      });
    },
    personaController: { attachPanelPort() {} },
    createAuditId: () => 'audit-worker-generated',
    createExportOwnerId: () => 'export-owner-1',
    createEventNonce: () => 'N'.repeat(22),
    epochNow: () => 1_788_000_000_000,
    modelNow: () => '2026-08-29T12:00:00.000Z',
    randomBytes: length => new Uint8Array(length).fill(7),
    logger: { error() {} },
  });

  function sender(kind, auditId = null, leaseOwnerId = null, exportAttempt = null) {
    const documentId = `${kind}-document`;
    let path;
    let contextType;
    if (kind === 'panel') {
      path = 'src/panel/index.html';
      contextType = 'SIDE_PANEL';
    } else if (kind === 'review') {
      path = `src/review/index.html?auditId=${encodeURIComponent(auditId)}`;
      contextType = 'TAB';
    } else {
      path = `src/export/index.html?auditId=${encodeURIComponent(auditId)}&leaseOwnerId=${encodeURIComponent(leaseOwnerId)}&exportAttempt=${exportAttempt}`;
      contextType = 'TAB';
    }
    const url = chromeApi.runtime.getURL(path);
    const value = { id: chromeApi.runtime.id, documentId, frameId: 0, url };
    contexts.set(documentId, {
      documentId, documentUrl: url, contextType, windowId: 9,
      ...(contextType === 'TAB' ? { tabId: 17 } : {}),
    });
    return value;
  }

  async function dispatch(message, from) {
    await registration.startupReady;
    const listener = [...events.message.listeners][0];
    return new Promise((resolve, reject) => {
      const handled = listener(message, from, resolve);
      if (handled !== true) reject(new Error('message was not handled'));
    });
  }

  return {
    chromeApi, events, registration, sessionValues, sent, createdTabs, snapshots, retentions, deleted,
    sender, dispatch,
    setLatest(value) { latest = value; },
    setLeaseResult(value) { leaseResult = value; },
    setDeletedAll(value) { deletedAll = value; },
    setDeleteError(value) { deleteError = value; },
  };
}

test('registers every MV3 wrapper synchronously before the shared readiness promise settles', () => {
  const { chromeApi, events } = chromeFixture();
  const ready = deferred();
  registerServiceWorker(chromeApi, {
    startupReady: ready.promise,
    router: { async dispatch() { return { ok: true }; } },
    compatibilityHandler: { async dispatch() { return { ok: true }; } },
    panelCoordinator: { attachPanelPort() { return true; } },
    personaController: { attachPanelPort() { return true; } },
    createEventNonce: () => 'N'.repeat(22), createAuditId: () => 'audit-1', epochNow: () => 1,
    logger: { error() {} },
  });
  assert.equal(events.message.listeners.size, 1);
  assert.equal(events.connect.listeners.size, 1);
  assert.equal(events.installed.listeners.size, 1);
  assert.equal(events.context.listeners.size, 1);
  assert.equal(events.updated.listeners.size, 1);
  assert.equal(events.tabRemoved.listeners.size, 1);
  assert.equal(events.windowRemoved.listeners.size, 1);
});

test('classifies primary then compatibility, returns literal true only when handled, and responds once after readiness', async () => {
  const { chromeApi, events } = chromeFixture();
  const ready = deferred();
  const calls = [];
  registerServiceWorker(chromeApi, {
    startupReady: ready.promise,
    router: { async dispatch(value) { calls.push(['primary', value]); return { ok: true, requestId: value.envelope.requestId }; } },
    compatibilityHandler: { async dispatch(value) { calls.push(['compat', value]); return { ok: true, state: null }; } },
    panelCoordinator: { attachPanelPort() { return true; } },
    personaController: { attachPanelPort() { return true; } },
    createEventNonce: () => 'N'.repeat(22), createAuditId: () => 'audit-1', epochNow: () => 1,
    logger: { error() {} },
  });
  const listener = [...events.message.listeners][0];
  const primaryResponses = [];
  assert.equal(listener({ type: 'PREPARE_PANEL_CAPABILITY', requestId: 'request-1' }, {}, value => primaryResponses.push(value)), true);
  assert.deepEqual(primaryResponses, []);
  const compatResponses = [];
  assert.equal(listener({ type: 'GET_LAST_AUDIT' }, {}, value => compatResponses.push(value)), true);
  const malformedResponses = [];
  assert.equal(listener({ type: 'PREPARE_PANEL_CAPABILITY', requestId: '' }, {}, value => malformedResponses.push(value)), true);
  let unknownResponses = 0;
  assert.equal(listener({ type: 'START_AUDIT', url: 'https://secret.test/?token=hidden' }, {}, () => { unknownResponses += 1; }), false);
  assert.equal(listener({ type: 'PANEL_START_URL', url: 'https://secret.test/?token=hidden' }, {}, () => { unknownResponses += 1; }), false);
  ready.resolve(runtimeValue());
  await tick();
  assert.deepEqual(primaryResponses, [{ ok: true, requestId: 'request-1' }]);
  assert.deepEqual(compatResponses, [{ ok: true, state: null }]);
  assert.deepEqual(malformedResponses, [{ ok: false, code: 'INVALID_MESSAGE' }]);
  assert.equal(unknownResponses, 0);
  assert.deepEqual(calls.map(([name]) => name), ['primary', 'compat']);
});

test('readiness rejection overrides recognized primary and compatibility without native error leakage', async () => {
  const { chromeApi, events } = chromeFixture();
  const ready = deferred();
  registerServiceWorker(chromeApi, {
    startupReady: ready.promise,
    router: { async dispatch() { throw new Error('must not run'); } },
    compatibilityHandler: { async dispatch() { throw new Error('must not run'); } },
    panelCoordinator: { attachPanelPort() {} }, personaController: { attachPanelPort() {} },
    createEventNonce: () => 'N'.repeat(22), createAuditId: () => 'audit-1', epochNow: () => 1,
    logger: { error() {} },
  });
  const listener = [...events.message.listeners][0];
  const primary = [];
  const compat = [];
  listener({ type: 'PANEL_START_ATTACHED_AUDIT', capabilityId: CAPABILITY, captureMode: 'no-pixels', includeQuery: false, deleteAfterCompleteExport: false }, {}, value => primary.push(value));
  listener({ type: 'GET_LAST_AUDIT' }, {}, value => compat.push(value));
  ready.reject(new Error('native storage secret'));
  await tick();
  assert.deepEqual(primary, [{ ok: false, code: 'WORKER_UNAVAILABLE' }]);
  assert.deepEqual(compat, [{ ok: false, code: 'COMPATIBILITY_FAILED' }]);
});

test('fans out panel and persona ports strictly after readiness and disconnects every other name', async () => {
  const { chromeApi, events } = chromeFixture();
  const attached = [];
  registerServiceWorker(chromeApi, {
    startupReady: Promise.resolve(runtimeValue()),
    router: { async dispatch() { return { ok: true }; } }, compatibilityHandler: { async dispatch() { return { ok: true }; } },
    panelCoordinator: { attachPanelPort(port) { attached.push(['panel', port.name]); return true; } },
    personaController: { attachPanelPort(port) { attached.push(['persona', port.name]); return true; } },
    createEventNonce: () => 'N'.repeat(22), createAuditId: () => 'audit-1', epochNow: () => 1,
    logger: { error() {} },
  });
  const listener = [...events.connect.listeners][0];
  const ports = [
    { name: PANEL_PORT_NAME, disconnects: 0, disconnect() { this.disconnects += 1; } },
    { name: 'audita-persona-v1', disconnects: 0, disconnect() { this.disconnects += 1; } },
    { name: 'unknown', disconnects: 0, disconnect() { this.disconnects += 1; } },
  ];
  for (const port of ports) listener(port);
  await tick();
  assert.deepEqual(attached, [['panel', PANEL_PORT_NAME], ['persona', 'audita-persona-v1']]);
  assert.equal(ports[2].disconnects, 1);
});

test('opens trusted session storage before building one shared runtime graph', async () => {
  const { chromeApi } = chromeFixture();
  const order = [];
  chromeApi.storage.session.setAccessLevel = async value => { order.push(['access', value]); };
  const readyRuntime = runtimeValue();
  const registration = registerServiceWorker(chromeApi, {
    async buildRuntime() {
      order.push(['build']);
      return {
        readyRuntime,
        router: { async dispatch() { return { ok: true }; } },
        compatibilityHandler: { async dispatch() { return { ok: true }; } },
        panelCoordinator: { attachPanelPort() { return true; } },
        personaController: { attachPanelPort() { return true; } },
      };
    },
    createEventNonce: () => 'N'.repeat(22), createAuditId: () => 'audit-1', epochNow: () => 1,
    logger: { error() {} },
  });
  const resolved = await registration.startupReady;
  assert.deepEqual(order, [['access', { accessLevel: 'TRUSTED_CONTEXTS' }], ['build']]);
  assert.deepEqual(resolved, readyRuntime);
  assert.deepEqual(Object.keys(resolved), ['authority', 'auditStarter', 'chromeAdapter']);
  assert.equal(Object.isFrozen(resolved), true);
});

test('does not misreport a post-gate runtime construction failure as access denial', async () => {
  const { chromeApi } = chromeFixture();
  const logs = [];
  let accessCalls = 0;
  chromeApi.storage.session.setAccessLevel = async () => { accessCalls += 1; };
  const registration = registerServiceWorker(chromeApi, {
    async buildRuntime() { throw new Error('native graph secret'); },
    createEventNonce: () => 'N'.repeat(22), createAuditId: () => 'audit-1', epochNow: () => 1,
    logger: { error(code) { logs.push(code); } },
  });
  await assert.rejects(registration.startupReady, /WORKER_UNAVAILABLE/u);
  assert.equal(accessCalls, 1);
  assert.deepEqual(logs, []);
});

test('default runtime rejects readiness when lifecycle recovery reports blocked state', async () => {
  const env = defaultGraphFixture({
    'audita:active-audit-job:v1': { version: 1, auditId: 'malformed-active', state: 'running' },
  });

  await assert.rejects(env.registration.startupReady, /WORKER_UNAVAILABLE/u);
});

test('fails a denied trusted-session gate with one fixed diagnostic and no graph construction', async () => {
  const { chromeApi } = chromeFixture();
  const logs = [];
  let builds = 0;
  chromeApi.storage.session.setAccessLevel = async () => { throw new Error('native storage detail'); };
  const registration = registerServiceWorker(chromeApi, {
    async buildRuntime() { builds += 1; throw new Error('must not build'); },
    createEventNonce: () => 'N'.repeat(22), createAuditId: () => 'audit-1', epochNow: () => 1,
    logger: { error(code) { logs.push(code); } },
  });
  await assert.rejects(registration.startupReady, /WORKER_UNAVAILABLE/u);
  assert.equal(builds, 0);
  assert.deepEqual(logs, ['SESSION_ACCESS_LEVEL_DENIED']);
});

test('retries context-menu installation on service-worker startup only after shared readiness', async () => {
  const { chromeApi } = chromeFixture();
  const ready = deferred();
  const calls = [];
  chromeApi.contextMenus.removeAll = async () => { calls.push(['remove']); };
  chromeApi.contextMenus.create = item => { calls.push(['create', item]); };
  registerServiceWorker(chromeApi, {
    startupReady: ready.promise,
    router: { async dispatch() { return { ok: true }; } },
    compatibilityHandler: { async dispatch() { return { ok: true }; } },
    panelCoordinator: { attachPanelPort() {} }, personaController: { attachPanelPort() {} },
    createEventNonce: () => 'N'.repeat(22), createAuditId: () => 'audit-1', epochNow: () => 1,
    logger: { error() {} },
  });
  assert.deepEqual(calls, []);
  ready.resolve(runtimeValue());
  await tick();
  assert.equal(calls[0][0], 'remove');
  assert.equal(calls[1][0], 'create');
  assert.equal(calls[1][1].id, 'audita.accessibility.audit-page');
});

test('routes all ten compatibility schemas and no removed legacy start type', async () => {
  const { chromeApi, events } = chromeFixture();
  const types = [
    'GET_LAST_AUDIT', 'REVIEW_COMMITTED', 'REQUEST_EXPORT', 'REQUEST_DELETE_AUDIT',
    'REQUEST_DELETE_ALL_AUDITS', 'EXPORT_PROGRESS', 'EXPORT_FAILED', 'EXPORT_BUSY',
    'EXPORT_INVALIDATED', 'EXPORT_COMPLETE',
  ];
  const compatibilityCalls = [];
  registerServiceWorker(chromeApi, {
    startupReady: Promise.resolve(runtimeValue()),
    router: { async dispatch() { throw new Error('wrong route'); } },
    compatibilityHandler: { async dispatch({ envelope }) { compatibilityCalls.push(envelope.type); return { ok: true }; } },
    panelCoordinator: { attachPanelPort() {} }, personaController: { attachPanelPort() {} },
    createEventNonce: () => 'N'.repeat(22), createAuditId: () => 'audit-1', epochNow: () => 1,
    logger: { error() {} },
  });
  const messages = {
    GET_LAST_AUDIT: { type: 'GET_LAST_AUDIT' },
    REVIEW_COMMITTED: { type: 'REVIEW_COMMITTED', auditId: 'audit-1', exportRevision: 1 },
    REQUEST_EXPORT: { type: 'REQUEST_EXPORT', auditId: 'audit-1' },
    REQUEST_DELETE_AUDIT: { type: 'REQUEST_DELETE_AUDIT', auditId: 'audit-1' },
    REQUEST_DELETE_ALL_AUDITS: { type: 'REQUEST_DELETE_ALL_AUDITS' },
    EXPORT_PROGRESS: { type: 'EXPORT_PROGRESS', auditId: 'audit-1', status: 'running', message: 'Executando.', exportRevision: 1, exportAttempt: 1, leaseOwnerId: 'owner-1' },
    EXPORT_FAILED: { type: 'EXPORT_FAILED', auditId: 'audit-1', status: 'failed', error: 'Falha.', exportRevision: 1, exportAttempt: 1, leaseOwnerId: 'owner-1' },
    EXPORT_BUSY: { type: 'EXPORT_BUSY', auditId: 'audit-1', status: 'busy', error: 'Ocupado.', exportRevision: 1, exportAttempt: 1, leaseOwnerId: 'owner-1' },
    EXPORT_INVALIDATED: { type: 'EXPORT_INVALIDATED', auditId: 'audit-1', status: 'preparing', error: 'Invalidado.', exportRevision: 1, exportAttempt: 1, leaseOwnerId: 'owner-1' },
    EXPORT_COMPLETE: { type: 'EXPORT_COMPLETE', auditId: 'audit-1', status: 'complete', formats: ['html', 'json', 'csv', 'pdf'], exportRevision: 1, exportAttempt: 1, leaseOwnerId: 'owner-1', localAuditDeleted: false },
  };
  const listener = [...events.message.listeners][0];
  for (const type of types) assert.equal(listener(messages[type], {}, () => {}), true);
  for (const type of ['START_AUDIT', 'START_BATCH', 'CANCEL_AUDIT']) {
    assert.equal(listener({ type }, {}, () => { throw new Error('must not respond'); }), false);
  }
  await tick();
  assert.deepEqual(compatibilityCalls, types);
});

test('real default graph restores only a validated panel latest projection', async () => {
  const env = defaultGraphFixture();
  env.setLatest({
    auditId: 'audit-latest', mode: 'single', status: 'complete', percent: 100,
    message: 'Auditoria concluída.',
    reviewUrl: env.chromeApi.runtime.getURL('src/review/index.html?auditId=audit-latest'),
    exportStatus: 'unavailable', exportRevision: 1,
  });
  assert.deepEqual(await env.dispatch({ type: 'GET_LAST_AUDIT' }, env.sender('panel')), {
    ok: true,
    state: {
      auditId: 'audit-latest', mode: 'single', status: 'complete', percent: 100,
      message: 'Auditoria concluída.',
      reviewUrl: env.chromeApi.runtime.getURL('src/review/index.html?auditId=audit-latest'),
      exportStatus: 'unavailable', exportRevision: 1,
    },
  });

  env.setLatest({ auditId: 'audit-latest', status: 'complete', secretBearer: 'S'.repeat(22) });
  assert.deepEqual(await env.dispatch({ type: 'GET_LAST_AUDIT' }, env.sender('panel')), {
    ok: false, code: 'COMPATIBILITY_FAILED',
  });
});

test('real default graph validates review revision before a bearer-free update broadcast', async () => {
  const env = defaultGraphFixture();
  env.snapshots.set('audit-review', { model: { auditId: 'audit-review' }, revision: 4, capability: Object.freeze({}) });
  assert.deepEqual(await env.dispatch(
    { type: 'REVIEW_COMMITTED', auditId: 'audit-review', exportRevision: 3 },
    env.sender('review', 'audit-review'),
  ), { ok: false, code: 'COMPATIBILITY_DENIED' });
  assert.deepEqual(env.sent, []);

  assert.deepEqual(await env.dispatch(
    { type: 'REVIEW_COMMITTED', auditId: 'audit-review', exportRevision: 4 },
    env.sender('review', 'audit-review'),
  ), { ok: true });
  assert.deepEqual(env.sent, [{ type: 'AUDIT_REVIEW_UPDATED', auditId: 'audit-review', exportRevision: 4 }]);
  assert.equal(JSON.stringify(env.sent).includes('capability'), false);
});

test('real default graph queues export with persistent lease correlation and reports a live busy retry', async () => {
  const env = defaultGraphFixture();
  env.snapshots.set('audit-export', { model: { auditId: 'audit-export' }, revision: 2, capability: Object.freeze({ token: 'private' }) });
  env.setLatest({ auditId: 'audit-export', status: 'complete' });
  assert.deepEqual(await env.dispatch(
    { type: 'REQUEST_EXPORT', auditId: 'audit-export' },
    env.sender('review', 'audit-export'),
  ), {
    ok: true, auditId: 'audit-export', state: 'queued', exportRevision: 2,
    exportAttempt: 1, leaseOwnerId: 'export-owner-1',
  });
  assert.deepEqual(env.createdTabs, [{
    url: env.chromeApi.runtime.getURL('src/export/index.html?auditId=audit-export&leaseOwnerId=export-owner-1&exportAttempt=1'),
    active: false,
  }]);
  assert.equal(JSON.stringify(env.createdTabs).includes('private'), false);

  env.setLeaseResult({ acquired: false, retryAt: '2026-08-29T12:01:00.000Z' });
  assert.deepEqual(await env.dispatch(
    { type: 'REQUEST_EXPORT', auditId: 'audit-export' },
    env.sender('review', 'audit-export'),
  ), {
    ok: false, auditId: 'audit-export', state: 'busy', code: 'EXPORT_BUSY', retryable: true,
    retryAt: '2026-08-29T12:01:00.000Z',
  });
  assert.equal(env.createdTabs.length, 1);
});

test('real default graph deletes one/all through correlated surfaces and maps storage busy errors', async () => {
  const env = defaultGraphFixture();
  env.snapshots.set('audit-delete', { model: { auditId: 'audit-delete' }, revision: 1, capability: Object.freeze({}) });
  assert.deepEqual(await env.dispatch(
    { type: 'REQUEST_DELETE_AUDIT', auditId: 'audit-delete' },
    env.sender('review', 'audit-delete'),
  ), { ok: true, auditId: 'audit-delete', deleted: true });
  assert.deepEqual(env.deleted, ['audit-delete']);
  assert.deepEqual(env.sent, [{ type: 'AUDIT_DELETED', auditId: 'audit-delete', reason: 'delete-one' }]);

  env.setDeletedAll(3);
  env.sessionValues['audita:execution-checkpoint:v1:audit-stale'] = {
    version: 1, auditId: 'audit-stale', sessionCapabilityId: 'S'.repeat(22), windowId: 9,
    checkpoint: { version: 1, auditId: 'audit-stale', pages: [] },
  };
  env.sessionValues['user:unrelated'] = { private: true };
  assert.deepEqual(await env.dispatch({ type: 'REQUEST_DELETE_ALL_AUDITS' }, env.sender('panel')), { ok: true, deleted: 3 });
  assert.deepEqual(env.sent.at(-1), { type: 'AUDIT_DELETED', scope: 'all', reason: 'delete-all' });
  assert.equal(Object.hasOwn(env.sessionValues, 'audita:execution-checkpoint:v1:audit-stale'), false);
  assert.deepEqual(env.sessionValues['user:unrelated'], { private: true });

  env.snapshots.set('audit-busy', { model: { auditId: 'audit-busy' }, revision: 1, capability: Object.freeze({}) });
  env.setDeleteError(Object.assign(new Error('native lock detail'), { code: 'AUDIT_DELETE_BUSY' }));
  assert.deepEqual(await env.dispatch(
    { type: 'REQUEST_DELETE_AUDIT', auditId: 'audit-busy' },
    env.sender('review', 'audit-busy'),
  ), { ok: false, code: 'AUDIT_DELETE_BUSY' });
});

test('real default graph acknowledges completed export deletion only after durable absence', async () => {
  const env = defaultGraphFixture();
  const message = {
    type: 'EXPORT_COMPLETE', auditId: 'audit-gone', status: 'complete',
    formats: ['html', 'json', 'csv', 'pdf'], exportRevision: 1, exportAttempt: 2,
    leaseOwnerId: 'export-owner-2', localAuditDeleted: true,
  };
  assert.deepEqual(await env.dispatch(
    message, env.sender('export', 'audit-gone', 'export-owner-2', 2),
  ), { ok: true });
  assert.deepEqual(env.sent, [{ type: 'AUDIT_DELETED', auditId: 'audit-gone', reason: 'complete-export' }]);

  env.snapshots.set('audit-present', { model: { auditId: 'audit-present' }, revision: 1, capability: Object.freeze({}) });
  const present = { ...message, auditId: 'audit-present' };
  assert.deepEqual(await env.dispatch(
    present, env.sender('export', 'audit-present', 'export-owner-2', 2),
  ), { ok: true });
  assert.equal(env.sent.length, 1);
});

test('unknown URL and batch envelopes do not read, serialize, log or respond with secret fields', () => {
  const { chromeApi, events } = chromeFixture();
  const logs = [];
  registerServiceWorker(chromeApi, {
    startupReady: Promise.resolve(runtimeValue()),
    router: { async dispatch() { throw new Error('must not run'); } },
    compatibilityHandler: { async dispatch() { throw new Error('must not run'); } },
    panelCoordinator: { attachPanelPort() {} }, personaController: { attachPanelPort() {} },
    createEventNonce: () => 'N'.repeat(22), createAuditId: () => 'audit-1', epochNow: () => 1,
    logger: { error(value) { logs.push(value); } },
  });
  let reads = 0;
  const message = { type: 'PANEL_START_URL' };
  Object.defineProperty(message, 'url', { enumerable: true, get() { reads += 1; throw new Error('token=secret'); } });
  let responses = 0;
  assert.equal([...events.message.listeners][0](message, {}, () => { responses += 1; }), false);
  assert.equal(reads, 0);
  assert.equal(responses, 0);
  assert.deepEqual(logs, []);
});

test('dispatch rejection becomes a fixed closed response for primary and compatibility paths', async () => {
  const { chromeApi, events } = chromeFixture();
  registerServiceWorker(chromeApi, {
    startupReady: Promise.resolve(runtimeValue()),
    router: { async dispatch() { throw new Error('native primary secret'); } },
    compatibilityHandler: { async dispatch() { throw new Error('native compatibility secret'); } },
    panelCoordinator: { attachPanelPort() {} }, personaController: { attachPanelPort() {} },
    createEventNonce: () => 'N'.repeat(22), createAuditId: () => 'audit-1', epochNow: () => 1,
    logger: { error() {} },
  });
  const listener = [...events.message.listeners][0];
  const primary = [];
  const compatibility = [];
  listener({ type: 'PREPARE_PANEL_CAPABILITY', requestId: 'request-fixed' }, {}, value => primary.push(value));
  listener({ type: 'GET_LAST_AUDIT' }, {}, value => compatibility.push(value));
  await tick();
  assert.deepEqual(primary, [{ ok: false, code: 'WORKER_UNAVAILABLE' }]);
  assert.deepEqual(compatibility, [{ ok: false, code: 'COMPATIBILITY_FAILED' }]);
});
