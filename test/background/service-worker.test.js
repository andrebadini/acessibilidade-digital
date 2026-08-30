import assert from 'node:assert/strict';
import test from 'node:test';

import { SAMPLE_AUDIT } from '../../fixtures/audits/sample-audit.js';
import { PANEL_PORT_NAME } from '../../src/background/panel-port.js';
import { registerServiceWorker } from '../../src/background/service-worker.js';
import * as serviceWorkerModule from '../../src/background/service-worker.js';
import { createInMemoryAuditStore } from '../../src/storage/audit-store.js';

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
    updated: event(), tabRemoved: event(), windowRemoved: event(), action: event(),
  };
  return {
    events,
    chromeApi: {
      runtime: {
        id: 'abcdefghijklmnopabcdefghijklmnop',
        onMessage: events.message, onConnect: events.connect, onInstalled: events.installed,
      },
      contextMenus: { onClicked: events.context, async removeAll() {}, create() {} },
      sidePanel: { async open() {}, async setPanelBehavior() {} },
      action: { onClicked: events.action },
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

function checkpoint(auditId, pages = [{
  pageId: 'page-1', attempted: true, startedAt: '2026-08-29T12:00:00.000Z',
  rulesVersion: '1.0.0', inventoryVersion: 'inventory-v1', inventoryHash: 'a'.repeat(64),
  outcomes: [{ ruleId: 'rule-a', outcome: 'passed' }],
}]) {
  return { version: 1, auditId, pages: structuredClone(pages) };
}

function sessionAreaForCheckpointTest() {
  const values = Object.create(null);
  return {
    values,
    async get(key) { return Object.hasOwn(values, key) ? { [key]: structuredClone(values[key]) } : {}; },
    async set(entries) { Object.assign(values, structuredClone(entries)); },
    async remove(key) { delete values[key]; },
  };
}

function defaultGraphFixture(initialSessionValues = null, fixtureOptions = {}) {
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
  let cleanupError = null;
  let tabCreator = (_options, callback) => callback?.({ id: 77 });
  let denySessionScan = false;
  const deleted = [];
  const storeCalls = [];
  const sessionGetCalls = [];

  if (initialSessionValues) Object.assign(sessionValues, structuredClone(initialSessionValues));

  chromeApi.storage.session = {
    async setAccessLevel() {},
    async get(key) {
      sessionGetCalls.push(key);
      if (key === null && denySessionScan) throw new Error('session-wide scan denied');
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
    return tabCreator(options, callback);
  };
  chromeApi.tabs.query = async () => [];

  const fixtureAuditStore = {
    async getLatest() { storeCalls.push(['getLatest']); return structuredClone(latest); },
    async setLatest(value) { latest = structuredClone(value); },
    async cleanupExpiredAudits(options) {
      storeCalls.push(['cleanupExpiredAudits', structuredClone(options)]);
      if (cleanupError) throw cleanupError;
      return { scanned: 0, deleted: 0, remaining: 0, blocked: 0 };
    },
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
  const auditStore = fixtureOptions.auditStore ?? fixtureAuditStore;

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
    modelNow: fixtureOptions.modelNow ?? (() => '2026-08-29T12:00:00.000Z'),
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
    chromeApi, events, registration, auditStore, sessionValues, sessionGetCalls,
    sent, createdTabs, snapshots, retentions, deleted, storeCalls,
    sender, dispatch,
    setLatest(value) { latest = value; },
    setLeaseResult(value) { leaseResult = value; },
    setDeletedAll(value) { deletedAll = value; },
    setDeleteError(value) { deleteError = value; },
    setCleanupError(value) { cleanupError = value; },
    setTabCreator(value) { tabCreator = value; },
    denySessionScan() { denySessionScan = true; },
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
  assert.equal(events.action.listeners.size, 0);
});

test('configures the toolbar action to open the native side panel exactly once without a click fallback', async t => {
  for (const [name, implementation, expectedLogs] of [
    ['success', async () => undefined, []],
    ['denial', async () => { throw new Error('native secret'); }, ['SIDE_PANEL_BEHAVIOR_DENIED']],
  ]) await t.test(name, async () => {
    const { chromeApi, events } = chromeFixture();
    const calls = [];
    const logs = [];
    chromeApi.sidePanel.setPanelBehavior = async value => {
      calls.push(structuredClone(value));
      return implementation();
    };
    registerServiceWorker(chromeApi, {
      startupReady: Promise.resolve(runtimeValue()),
      router: { async dispatch() { return { ok: true }; } },
      compatibilityHandler: { async dispatch() { return { ok: true }; } },
      panelCoordinator: { attachPanelPort() { return true; } },
      personaController: { attachPanelPort() { return true; } },
      createEventNonce: () => 'N'.repeat(22), createAuditId: () => 'audit-1', epochNow: () => 1,
      logger: { error(value) { logs.push(value); } },
    });
    await tick();
    assert.deepEqual(calls, [{ openPanelOnActionClick: true }]);
    assert.deepEqual(logs, expectedLogs);
    assert.equal(events.action.listeners.size, 0);
  });
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

test('checkpoint adapter permits only canonical semantic progression and preserves corrupt evidence', async () => {
  assert.equal(typeof serviceWorkerModule.createCheckpointAdapters, 'function');
  const storage = sessionAreaForCheckpointTest();
  const adapter = serviceWorkerModule.createCheckpointAdapters(storage);
  const auditId = 'audit-checkpoint';
  const sessionCapabilityId = 'S'.repeat(22);
  const key = `audita:execution-checkpoint:v1:${auditId}`;
  const persist = value => adapter.persistCheckpoint({
    auditId, sessionCapabilityId, windowId: 9, checkpoint: value,
  });

  const initial = checkpoint(auditId);
  await persist(initial);
  const progressed = checkpoint(auditId);
  progressed.pages[0].outcomes.push({ ruleId: 'rule-b', outcome: 'failed' });
  assert.equal((await persist(progressed)).checkpoint.pages[0].outcomes.length, 2);

  for (const regression of [
    (() => { const value = checkpoint(auditId); value.pages[0].outcomes[0].outcome = 'failed'; return value; })(),
    (() => { const value = structuredClone(progressed); value.pages[0].outcomes.shift(); return value; })(),
    (() => { const value = structuredClone(progressed); value.pages[0].inventoryHash = 'b'.repeat(64); return value; })(),
  ]) {
    await assert.rejects(() => persist(regression), /CHECKPOINT_PERSIST_DENIED/u);
    assert.deepEqual(storage.values[key].checkpoint, progressed);
  }

  const appended = structuredClone(progressed);
  appended.pages.push({
    pageId: 'page-2', attempted: false, startedAt: null, rulesVersion: '1.0.0',
    inventoryVersion: 'inventory-v1', inventoryHash: 'a'.repeat(64), outcomes: [],
  });
  assert.deepEqual((await persist(appended)).checkpoint.pages.map(page => page.pageId), ['page-1', 'page-2']);
  const reordered = structuredClone(appended);
  reordered.pages.reverse();
  await assert.rejects(() => persist(reordered), /CHECKPOINT_PERSIST_DENIED/u);

  const malformed = { version: 1, auditId, sessionCapabilityId, windowId: 9, checkpoint: { private: true } };
  storage.values[key] = structuredClone(malformed);
  await assert.rejects(() => persist(initial), /CHECKPOINT_PERSIST_DENIED/u);
  assert.deepEqual(storage.values[key], malformed);

  let getterCalls = 0;
  const hostile = checkpoint(auditId);
  Object.defineProperty(hostile.pages[0], 'pageId', {
    enumerable: true,
    get() { getterCalls += 1; return 'page-1'; },
  });
  delete storage.values[key];
  await assert.rejects(() => persist(hostile), /CHECKPOINT_PERSIST_DENIED/u);
  assert.equal(getterCalls, 0);
  assert.equal(Object.hasOwn(storage.values, key), false);

  const foreignAuditId = 'foreign-checkpoint';
  storage.values[key] = {
    version: 1, auditId: foreignAuditId, sessionCapabilityId: 'F'.repeat(22), windowId: 11,
    checkpoint: checkpoint(foreignAuditId),
  };
  await assert.rejects(() => adapter.removeCheckpoint({
    auditId, sessionCapabilityId, windowId: 9,
  }), /CHECKPOINT_REMOVE_DENIED/u);
  assert.equal(storage.values[key].auditId, foreignAuditId);
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

test('routes only the four retained compatibility schemas and rejects the removed export lane', async () => {
  const { chromeApi, events } = chromeFixture();
  const types = ['GET_LAST_AUDIT', 'REVIEW_COMMITTED', 'REQUEST_DELETE_AUDIT', 'REQUEST_DELETE_ALL_AUDITS'];
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
    REQUEST_DELETE_AUDIT: { type: 'REQUEST_DELETE_AUDIT', auditId: 'audit-1' },
    REQUEST_DELETE_ALL_AUDITS: { type: 'REQUEST_DELETE_ALL_AUDITS' },
  };
  const listener = [...events.message.listeners][0];
  for (const type of types) assert.equal(listener(messages[type], {}, () => {}), true);
  for (const type of ['START_AUDIT', 'START_BATCH', 'CANCEL_AUDIT', 'REQUEST_EXPORT', 'EXPORT_PROGRESS', 'EXPORT_FAILED', 'EXPORT_BUSY', 'EXPORT_INVALIDATED']) {
    assert.equal(listener({ type }, {}, () => { throw new Error('must not respond'); }), false);
  }
  assert.equal(listener({ type: 'EXPORT_COMPLETE', auditId: 'audit-1' }, {}, () => {}), true,
    'EXPORT_COMPLETE now belongs only to the authenticated primary protocol');
  await tick();
  assert.deepEqual(compatibilityCalls, types);
});

test('real default graph cleans retention before projecting canonical Task 5 latest rows', async () => {
  const env = defaultGraphFixture();
  const rows = [
    ['audit-running', 'running', 0, 'Preparando a auditoria.', null, null],
    ['audit-complete', 'complete', 100, 'Avaliação concluída.', null, 1],
    ['audit-failed', 'failed', 100, 'Não foi possível concluir a auditoria.', 'AUDIT_FAILED', null],
  ];
  for (const [auditId, status, percent, message, failureCode, modelRevision] of rows) {
    env.setLatest({
      version: 1, auditId, status, percent, message, failureCode, modelRevision,
      updatedAt: '2026-08-29T12:00:00.000Z', secretBearer: 'S'.repeat(22),
    });
    assert.deepEqual(await env.dispatch({ type: 'GET_LAST_AUDIT' }, env.sender('panel')), {
      ok: true, state: { auditId, status, percent, message },
    });
  }
  assert.deepEqual(env.storeCalls, rows.flatMap(() => [
    ['cleanupExpiredAudits', { now: '2026-08-29T12:00:00.000Z', limit: 25 }],
    ['getLatest'],
  ]));
});

test('real default graph returns fixed failure when GET_LAST cleanup fails before latest read', async () => {
  const env = defaultGraphFixture();
  env.setLatest({ auditId: 'audit-hidden', status: 'complete' });
  env.setCleanupError(new Error('native cleanup secret'));
  const response = await env.dispatch({ type: 'GET_LAST_AUDIT' }, env.sender('panel'));
  assert.deepEqual(response, { ok: false, code: 'COMPATIBILITY_FAILED' });
  assert.deepEqual(env.storeCalls, [[
    'cleanupExpiredAudits', { now: '2026-08-29T12:00:00.000Z', limit: 25 },
  ]]);
  assert.doesNotMatch(JSON.stringify(response), /native|cleanup|secret/u);
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
  env.sessionValues['audita:execution-checkpoint:v1:audit-transplanted'] = {
    version: 1, auditId: 'audit-foreign', sessionCapabilityId: 'F'.repeat(22), windowId: 11,
    checkpoint: { version: 1, auditId: 'audit-foreign', pages: [] },
  };
  env.sessionValues['user:unrelated'] = { private: true };
  env.denySessionScan();
  assert.deepEqual(await env.dispatch({ type: 'REQUEST_DELETE_ALL_AUDITS' }, env.sender('panel')), { ok: true, deleted: 3 });
  assert.deepEqual(env.sent.at(-1), { type: 'AUDIT_DELETED', scope: 'all', reason: 'delete-all' });
  assert.equal(Object.hasOwn(env.sessionValues, 'audita:execution-checkpoint:v1:audit-stale'), true);
  assert.equal(Object.hasOwn(env.sessionValues, 'audita:execution-checkpoint:v1:audit-transplanted'), true);
  assert.deepEqual(env.sessionValues['user:unrelated'], { private: true });
  assert.equal(env.sessionGetCalls.includes(null), false);

  env.snapshots.set('audit-busy', { model: { auditId: 'audit-busy' }, revision: 1, capability: Object.freeze({}) });
  env.setDeleteError(Object.assign(new Error('native lock detail'), { code: 'AUDIT_DELETE_BUSY' }));
  assert.deepEqual(await env.dispatch(
    { type: 'REQUEST_DELETE_AUDIT', auditId: 'audit-busy' },
    env.sender('review', 'audit-busy'),
  ), { ok: false, code: 'AUDIT_DELETE_BUSY' });
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
