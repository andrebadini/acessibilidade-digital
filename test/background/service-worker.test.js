import assert from 'node:assert/strict';
import test from 'node:test';

import { SAMPLE_AUDIT } from '../../fixtures/audits/sample-audit.js';
import { PANEL_PORT_NAME } from '../../src/background/panel-port.js';
import { REPORT_PORT_NAME } from '../../src/background/report-port.js';
import {
  HIGHLIGHT_EXPIRY_ALARM_NAME,
  PERSONA_EXPIRY_ALARM_NAME,
  registerServiceWorker,
} from '../../src/background/service-worker.js';
import * as serviceWorkerModule from '../../src/background/service-worker.js';
import { createInMemoryAuditStore } from '../../src/storage/audit-store.js';
import { createFakeLockManager } from '../personas/fake-lock-manager.js';

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
    updated: event(), tabRemoved: event(), tabDetached: event(), windowRemoved: event(),
    action: event(), alarm: event(),
  };
  return {
    events,
    chromeApi: {
      runtime: {
        id: 'abcdefghijklmnopabcdefghijklmnop',
        onMessage: events.message, onConnect: events.connect, onInstalled: events.installed,
      },
      contextMenus: { onClicked: events.context, async removeAll() {}, create() {} },
      sidePanel: { async open() {}, async setOptions() {}, async setPanelBehavior() {} },
      action: { onClicked: events.action },
      tabs: {
        onUpdated: events.updated, onRemoved: events.tabRemoved, onDetached: events.tabDetached,
        async get(tabId) {
          return { id: tabId, windowId: 9, status: 'complete', discarded: false, url: 'https://example.test/' };
        },
      },
      windows: { onRemoved: events.windowRemoved, async get(windowId) { return { id: windowId, focused: false, type: 'normal' }; } },
      alarms: { onAlarm: events.alarm, async create() {}, async clear() { return true; } },
      scripting: { async executeScript() { return []; }, async insertCSS() {}, async removeCSS() {} },
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

function runtimeWithPersona(personaCoordinator, highlightController = null) {
  return Object.freeze({
    authority: Object.freeze({}),
    auditStarter: Object.freeze({}),
    chromeAdapter: Object.freeze({}),
    reportLaunch: Object.freeze({}),
    exportLaunch: Object.freeze({}),
    personaCoordinator,
    ...(highlightController ? { highlightController: {
      async invalidateTab() { return { ok: true }; },
      ...highlightController,
    } } : {}),
  });
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
  const contextsByUrl = new Map();
  const sent = [];
  const createdTabs = [];
  const snapshots = new Map();
  const retentions = new Map();
  let latest = null;
  let leaseResult = { acquired: true, exportAttempt: 1 };
  let deletedAll = 0;
  let deleteError = null;
  let cleanupError = null;
  let reviewConflicts = fixtureOptions.reviewConflicts ?? 0;
  let tabCreator = (_options, callback) => callback?.({ id: 77 });
  let denySessionScan = false;
  let panelPath = null;
  let panelOpens = 0;
  const panelOptions = [];
  const deleted = [];
  const storeCalls = [];
  const sessionGetCalls = [];
  const personaLockManager = createFakeLockManager();

  if (initialSessionValues) Object.assign(sessionValues, structuredClone(initialSessionValues));

  chromeApi.storage.session = {
    async setAccessLevel() {},
    async get(key) {
      sessionGetCalls.push(key);
      if (key === null && denySessionScan) throw new Error('session-wide scan denied');
      if (key === null) return structuredClone(sessionValues);
      if (Array.isArray(key)) {
        const envelope = {};
        for (const entry of key) if (Object.hasOwn(sessionValues, entry)) envelope[entry] = structuredClone(sessionValues[entry]);
        return envelope;
      }
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
  chromeApi.runtime.getContexts = async ({ documentIds, documentUrls }) => {
    const value = documentIds ? contexts.get(documentIds[0]) : contextsByUrl.get(documentUrls?.[0]);
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
  chromeApi.tabs.query = fixtureOptions.tabsQuery ?? (async () => []);
  chromeApi.sidePanel.setOptions = (value, callback) => {
    panelOptions.push(structuredClone(value));
    if (typeof value.path === 'string') panelPath = value.path;
    if (callback) setImmediate(callback);
  };
  chromeApi.sidePanel.open = (_value, callback) => { panelOpens += 1; callback?.(); };
  if (fixtureOptions.scripting) chromeApi.scripting = fixtureOptions.scripting;
  if (fixtureOptions.alarms) chromeApi.alarms = { onAlarm: events.alarm, ...fixtureOptions.alarms };

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
    async getReportRevision(auditId) {
      const value = snapshots.get(auditId);
      return value ? {
        version: 1, auditId, modelRevision: value.revision, modelHash: 'a'.repeat(64),
        model: structuredClone(value.model), checkpoint: null,
      } : null;
    },
    async getExportReceipt(auditId) {
      storeCalls.push(['getExportReceipt', auditId]);
      return fixtureOptions.exportReceipts?.get?.(auditId);
    },
    async getAuditRetention(auditId) { return retentions.get(auditId); },
    async acquireExportLease(_auditId, _capability, options) {
      return leaseResult.acquired
        ? { acquired: true, exportAttempt: leaseResult.exportAttempt, ownerId: options.ownerId }
        : { acquired: false, retryAt: leaseResult.retryAt ?? null };
    },
    async releaseExportLease() { return { released: true }; },
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
    async commitAuditReviewIfRevision(auditId, model, capability) {
      storeCalls.push(['commitAuditReviewIfRevision', auditId]);
      if (reviewConflicts > 0) {
        reviewConflicts -= 1;
        throw Object.assign(new Error('revision conflict'), { code: 'AUDIT_REVISION_CONFLICT' });
      }
      const current = snapshots.get(auditId);
      if (!current || current.capability !== capability) {
        throw Object.assign(new Error('revision conflict'), { code: 'AUDIT_REVISION_CONFLICT' });
      }
      const next = { model: structuredClone(model), revision: current.revision + 1, capability: Object.freeze({}) };
      snapshots.set(auditId, next);
      return { revision: next.revision, capability: next.capability };
    },
    async commitAuditWithCheckpointIfAbsent() { throw new Error('must not commit during worker protocol tests'); },
  };
  const auditStore = fixtureOptions.auditStore ?? fixtureAuditStore;

  if (fixtureOptions.enableReportLaunch === true) {
    chromeApi.tabs.create = async options => {
      createdTabs.push(structuredClone(options));
      return { id: 77, windowId: options.windowId, url: 'about:blank' };
    };
    chromeApi.tabs.update = async (tabId, options) => ({ id: tabId, windowId: 9, url: options.url });
    chromeApi.tabs.get = async tabId => ({ id: tabId, windowId: 9, url: chromeApi.runtime.getURL('src/review/index.html?auditId=audit-review') });
    chromeApi.tabs.remove = async () => undefined;
  }

  const registration = registerServiceWorker(chromeApi, {
    auditStore,
    chromeAdapterFactory() {
      return Object.freeze({
        async probeDocumentIdentity() { throw new Error('not used'); },
        async getEvidenceUrl() { throw new Error('not used'); },
        async getFinalUrl() { return 'https://example.test/'; },
        async proveHighlightTargets() { return []; },
        async verifyHighlightTarget() { return { ok: false, reason: 'live-proof-failed' }; },
        async injectHighlight() { return { ok: false, reason: 'execution-failed' }; },
        async emitProgress() {},
        ...(fixtureOptions.chromeAdapter ?? {}),
      });
    },
    personaLockManager,
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

  async function connectPanel() {
    await registration.startupReady;
    events.action.emit({ id: 17, windowId: 9 });
    await tick();
    if (typeof panelPath !== 'string') throw new Error('panel launch failed');
    const url = chromeApi.runtime.getURL(panelPath);
    const panelContext = {
      contextType: 'SIDE_PANEL', contextId: 'panel-context', documentId: 'panel-document',
      documentUrl: url, tabId: -1, windowId: -1,
    };
    contextsByUrl.set(url, panelContext);
    contexts.set('panel-document', panelContext);
    const onMessage = event();
    const onDisconnect = event();
    const port = {
      name: PANEL_PORT_NAME,
      sender: { id: chromeApi.runtime.id, url, origin: `chrome-extension://${chromeApi.runtime.id}` },
      onMessage, onDisconnect, messages: [], disconnects: 0,
      postMessage(value) { this.messages.push(structuredClone(value)); },
      disconnect() { this.disconnects += 1; onDisconnect.emit(); },
    };
    events.connect.emit(port);
    await tick();
    onMessage.emit({ protocol: 'audita-panel', version: 1, type: 'bootstrap' });
    await tick();
    let requestCounter = 0;
    return {
      port,
      async request(envelope) {
        requestCounter += 1;
        const requestId = `test-panel-${requestCounter}`;
        onMessage.emit({ protocol: 'audita-panel', version: 1, type: 'intent', requestId, envelope });
        await tick();
        const packet = port.messages.find(value => value.type === 'intent-result' && value.requestId === requestId);
        if (!packet) throw new Error(`panel intent failed: ${JSON.stringify({ messages: port.messages, disconnects: port.disconnects })}`);
        return packet.response;
      },
    };
  }

  async function connectReport(auditId) {
    await registration.startupReady;
    const now = 1_788_000_000_000;
    sessionValues[`audita:report-launch:v1:${auditId}`] = {
      version: 1, auditId, tabId: 17, windowId: 9, path: '/src/review/index.html',
      documentId: null, state: 'awaiting-connection', issuedAt: now, expiresAt: now + 1_800_000,
    };
    const from = sender('review', auditId);
    const connected = await dispatch({ type: 'REPORT_CONNECT', auditId }, from);
    return { connected, from };
  }

  return {
    chromeApi, events, registration, auditStore, sessionValues, sessionGetCalls, personaLockManager,
    sent, createdTabs, snapshots, retentions, deleted, storeCalls,
    sender, dispatch, connectPanel, connectReport,
    setLatest(value) { latest = value; },
    setLeaseResult(value) { leaseResult = value; },
    setDeletedAll(value) { deletedAll = value; },
    setDeleteError(value) { deleteError = value; },
    setCleanupError(value) { cleanupError = value; },
    setTabCreator(value) { tabCreator = value; },
    denySessionScan() { denySessionScan = true; },
    getPanelPath() { return panelPath; },
    getPanelOpens() { return panelOpens; },
    getPanelOptions() { return structuredClone(panelOptions); },
  };
}

test('registers every MV3 wrapper synchronously before the shared readiness promise settles', () => {
  const { chromeApi, events } = chromeFixture();
  const ready = deferred();
  registerServiceWorker(chromeApi, {
    startupReady: ready.promise,
    router: { async dispatch() { return { ok: true }; } },
    panelCoordinator: { attachPanelPort() { return true; } },
    createEventNonce: () => 'N'.repeat(22), createAuditId: () => 'audit-1', epochNow: () => 1,
    logger: { error() {} },
  });
  assert.equal(events.message.listeners.size, 1);
  assert.equal(events.connect.listeners.size, 1);
  assert.equal(events.installed.listeners.size, 1);
  assert.equal(events.context.listeners.size, 1);
  assert.equal(events.updated.listeners.size, 1);
  assert.equal(events.tabRemoved.listeners.size, 1);
  assert.equal(events.tabDetached.listeners.size, 1);
  assert.equal(events.windowRemoved.listeners.size, 1);
  assert.equal(events.alarm.listeners.size, 1);
  assert.equal(events.action.listeners.size, 1);
});

test('routes the two durable live-aid expiry alarms through the recovered runtime', async () => {
  const { chromeApi, events } = chromeFixture();
  const ready = deferred();
  const calls = [];
  const registration = registerServiceWorker(chromeApi, {
    startupReady: ready.promise,
    router: { async dispatch() { return { ok: true }; } },
    panelCoordinator: { attachPanelPort() { return true; } },
    createEventNonce: () => 'N'.repeat(22), createAuditId: () => 'audit-1', epochNow: () => 1,
    logger: { error() {} },
  });
  events.alarm.emit({ name: 'foreign-alarm', scheduledTime: 3 });
  events.alarm.emit({ name: PERSONA_EXPIRY_ALARM_NAME, scheduledTime: 4 });
  events.alarm.emit({ name: HIGHLIGHT_EXPIRY_ALARM_NAME, scheduledTime: 5 });
  ready.resolve(runtimeWithPersona(
    { async expireDue() { calls.push('persona-expire'); return { ok: true }; } },
    { async expireDue() { calls.push('highlight-expire'); return { ok: true }; } },
  ));
  await tick();
  assert.deepEqual(calls, ['persona-expire', 'highlight-expire']);
  registration.dispose();
  assert.equal(events.alarm.listeners.size, 0);
});

test('publishes correlated clear after lifecycle recovery invalidation and expiry retire an overlay', async () => {
  assert.equal(typeof serviceWorkerModule.createPublishingHighlightController, 'function');
  const calls = [];
  const controller = {
    async invalidateTab(tabId, reason) {
      calls.push(['invalidate', tabId, reason]);
      return { ok: true, state: 'invalidated', clearedAuditIds: ['audit-navigation'] };
    },
    async recover() {
      calls.push(['recover']);
      return { ok: true, recovered: 1, clearedAuditIds: ['audit-recovery'] };
    },
    async expireDue() {
      calls.push(['expire']);
      return { ok: true, purged: 1, clearedAuditIds: ['audit-expiry'] };
    },
    availability() {}, highlight() {}, clear() {}, clearForTargetLocked() {}, clearAudit() {}, invalidateContent() {},
  };
  const wrapped = serviceWorkerModule.createPublishingHighlightController({
    controller,
    async publishHighlightState(value) { calls.push(['publish', value]); return { delivered: 0 }; },
    async scheduleExpiry() { calls.push(['schedule']); },
  });

  assert.equal((await wrapped.invalidateTab(17, 'navigation')).ok, true);
  assert.equal((await wrapped.recover()).ok, true);
  assert.equal((await wrapped.expireDue()).ok, true);
  assert.deepEqual(calls.filter(([name]) => name === 'publish').map(([, value]) => value), [
    { version: 1, type: 'HIGHLIGHT_STATE_CHANGED', auditId: 'audit-navigation', occurrenceId: null, state: 'clear' },
    { version: 1, type: 'HIGHLIGHT_STATE_CHANGED', auditId: 'audit-recovery', occurrenceId: null, state: 'clear' },
    { version: 1, type: 'HIGHLIGHT_STATE_CHANGED', auditId: 'audit-expiry', occurrenceId: null, state: 'clear' },
  ]);
  assert.equal(calls.filter(([name]) => name === 'schedule').length, 3);
});

test('disables Chrome auto-open and synchronously delegates toolbar clicks to the token launcher', async t => {
  for (const [name, disableDefault, setBehavior, expectedLogs] of [
    ['success', async () => undefined, async () => undefined, []],
    ['default denial', async () => { throw new Error('native secret'); }, async () => undefined,
      ['SIDE_PANEL_DEFAULT_DENIED']],
    ['behavior denial', async () => undefined, async () => { throw new Error('native secret'); },
      ['SIDE_PANEL_BEHAVIOR_DENIED']],
  ]) await t.test(name, async () => {
    const { chromeApi, events } = chromeFixture();
    const calls = [];
    const logs = [];
    chromeApi.sidePanel.setOptions = async value => {
      calls.push(['default', structuredClone(value)]);
      return disableDefault();
    };
    chromeApi.sidePanel.setPanelBehavior = async value => {
      calls.push(['behavior', structuredClone(value)]);
      return setBehavior();
    };
    registerServiceWorker(chromeApi, {
      startupReady: Promise.resolve(runtimeValue()),
      router: { async dispatch() { return { ok: true }; } },
      panelCoordinator: { attachPanelPort() { return true; } },
      panelLauncher: { launch(tab) { calls.push(['launch', structuredClone(tab)]); return true; } },
      createEventNonce: () => 'N'.repeat(22), createAuditId: () => 'audit-1', epochNow: () => 1,
      logger: { error(value) { logs.push(value); } },
    });
    events.action.emit({ id: 17, windowId: 9 });
    await tick();
    assert.deepEqual(calls, [
      ['default', { enabled: false }],
      ['behavior', { openPanelOnActionClick: false }],
      ['launch', { id: 17, windowId: 9 }],
    ]);
    assert.deepEqual(logs, expectedLogs);
    assert.equal(events.action.listeners.size, 1);
  });
});

test('a cold default worker launches the tokenized Side Panel before long runtime recovery settles', async () => {
  const env = defaultGraphFixture();

  env.events.action.emit({ id: 17, windowId: 9 });

  assert.deepEqual(env.getPanelOptions()[0], { enabled: false },
    'the synchronous action listener first disables the global fallback panel');
  await tick();
  assert.match(env.getPanelPath() ?? '', /^src\/panel\/index\.html\?launch=[A-Za-z0-9_-]{43}$/u,
    'the callback chain owns the exact tab panel even while startupReady is pending');
  await env.registration.startupReady;
  await tick();
  assert.equal(env.getPanelOpens(), 1);
});

test('classifies primary messages, ignores removed one-shot types, and responds once after readiness', async () => {
  const { chromeApi, events } = chromeFixture();
  const ready = deferred();
  const calls = [];
  registerServiceWorker(chromeApi, {
    startupReady: ready.promise,
    router: { async dispatch(value) { calls.push(['primary', value]); return { ok: true, requestId: value.envelope.requestId }; } },
    panelCoordinator: { attachPanelPort() { return true; } },
    createEventNonce: () => 'N'.repeat(22), createAuditId: () => 'audit-1', epochNow: () => 1,
    logger: { error() {} },
  });
  const listener = [...events.message.listeners][0];
  const primaryResponses = [];
  assert.equal(listener({ type: 'PREPARE_PANEL_CAPABILITY', requestId: 'request-1', windowId: 9 }, {}, value => primaryResponses.push(value)), true);
  assert.deepEqual(primaryResponses, []);
  let oldResponses = 0;
  assert.equal(listener({ type: 'GET_LAST_AUDIT' }, {}, () => { oldResponses += 1; }), false);
  const malformedResponses = [];
  assert.equal(listener({ type: 'PREPARE_PANEL_CAPABILITY', requestId: '', windowId: 9 }, {}, value => malformedResponses.push(value)), true);
  let unknownResponses = 0;
  assert.equal(listener({ type: 'START_AUDIT', url: 'https://secret.test/?token=hidden' }, {}, () => { unknownResponses += 1; }), false);
  assert.equal(listener({ type: 'PANEL_START_URL', url: 'https://secret.test/?token=hidden' }, {}, () => { unknownResponses += 1; }), false);
  ready.resolve(runtimeValue());
  await tick();
  assert.deepEqual(primaryResponses, [{ ok: false, code: 'CONTEXT_DENIED' }]);
  assert.equal(oldResponses, 0);
  assert.deepEqual(malformedResponses, [{ ok: false, code: 'INVALID_MESSAGE' }]);
  assert.equal(unknownResponses, 0);
  assert.deepEqual(calls, []);
});

test('rejects absent extra and accessor panel window claims before router effects', async () => {
  const { chromeApi, events } = chromeFixture();
  let dispatches = 0;
  let getterCalls = 0;
  registerServiceWorker(chromeApi, {
    startupReady: Promise.resolve(runtimeValue()),
    router: { async dispatch() { dispatches += 1; return { ok: true }; } },
    panelCoordinator: { attachPanelPort() {} },
    createEventNonce: () => 'N'.repeat(22), createAuditId: () => 'audit-1', epochNow: () => 1,
    logger: { error() {} },
  });
  const accessor = { type: 'PREPARE_PANEL_CAPABILITY', requestId: 'request-accessor' };
  Object.defineProperty(accessor, 'windowId', {
    enumerable: true,
    get() { getterCalls += 1; return 9; },
  });
  const responses = [];
  const listener = [...events.message.listeners][0];
  for (const message of [
    { type: 'PREPARE_PANEL_CAPABILITY', requestId: 'request-missing' },
    { type: 'PREPARE_PANEL_CAPABILITY', requestId: 'request-extra', windowId: 9, extra: true },
    accessor,
  ]) {
    assert.equal(listener(message, {}, value => responses.push(value)), true);
  }
  await tick();
  assert.deepEqual(responses, Array.from({ length: 3 }, () => ({ ok: false, code: 'INVALID_MESSAGE' })));
  assert.equal(dispatches, 0);
  assert.equal(getterCalls, 0);
});

test('readiness rejection closes recognized primary while removed one-shot types stay unhandled', async () => {
  const { chromeApi, events } = chromeFixture();
  const ready = deferred();
  registerServiceWorker(chromeApi, {
    startupReady: ready.promise,
    router: { async dispatch() { throw new Error('must not run'); } },
    panelCoordinator: { attachPanelPort() {} },
    createEventNonce: () => 'N'.repeat(22), createAuditId: () => 'audit-1', epochNow: () => 1,
    logger: { error() {} },
  });
  const listener = [...events.message.listeners][0];
  const primary = [];
  let oldResponses = 0;
  listener({ type: 'PANEL_START_ATTACHED_AUDIT', capabilityId: CAPABILITY, captureMode: 'no-pixels', includeQuery: false, deleteAfterCompleteExport: false, windowId: 9 }, {}, value => primary.push(value));
  assert.equal(listener({ type: 'GET_LAST_AUDIT' }, {}, () => { oldResponses += 1; }), false);
  ready.reject(new Error('native storage secret'));
  await tick();
  assert.deepEqual(primary, [{ ok: false, code: 'WORKER_UNAVAILABLE' }]);
  assert.equal(oldResponses, 0);
});

test('attaches only the Side Panel and authenticated report ports after readiness', async () => {
  const { chromeApi, events } = chromeFixture();
  const attached = [];
  registerServiceWorker(chromeApi, {
    startupReady: Promise.resolve(runtimeValue()),
    router: { async dispatch() { return { ok: true }; } },
    panelCoordinator: { attachPanelPort(port) { attached.push(['panel', port.name]); return true; } },
    reportPortCoordinator: { attachReportPort(port) { attached.push(['report', port.name]); return true; } },
    createEventNonce: () => 'N'.repeat(22), createAuditId: () => 'audit-1', epochNow: () => 1,
    logger: { error() {} },
  });
  const listener = [...events.connect.listeners][0];
  const ports = [
    { name: PANEL_PORT_NAME, disconnects: 0, disconnect() { this.disconnects += 1; } },
    { name: REPORT_PORT_NAME, disconnects: 0, disconnect() { this.disconnects += 1; } },
    { name: 'audita-persona-v1', disconnects: 0, disconnect() { this.disconnects += 1; } },
    { name: 'unknown', disconnects: 0, disconnect() { this.disconnects += 1; } },
  ];
  for (const port of ports) listener(port);
  await tick();
  assert.deepEqual(attached, [['panel', PANEL_PORT_NAME], ['report', REPORT_PORT_NAME]]);
  assert.equal(ports[1].disconnects, 0);
  assert.equal(ports[2].disconnects, 1);
  assert.equal(ports[3].disconnects, 1);
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
        panelCoordinator: { attachPanelPort() { return true; } },
        panelLauncher: { launch() { return true; } },
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

test('default runtime serializes persona recovery with the supplied Web Locks manager', async () => {
  const env = defaultGraphFixture();
  const runtime = await env.registration.startupReady;
  assert.equal(typeof runtime.personaCoordinator?.expireDue, 'function');
  assert.equal(typeof runtime.highlightController?.expireDue, 'function');
  assert.equal(env.personaLockManager.calls.length > 0, true);
  assert.equal(env.personaLockManager.calls.every(call =>
    call.name === 'audita:persona-lease-store:v1' && call.options.mode === 'exclusive'), true);
});

test('default runtime clears the persona expiry alarm with the exact Promise API arity', async () => {
  const calls = [];
  const env = defaultGraphFixture(null, {
    alarms: {
      clear(...args) {
        calls.push(['clear', args.length, ...args]);
        if (args.length !== 1) throw new Error('callback overload forbidden');
        return Promise.resolve(true);
      },
      create(...args) {
        calls.push(['create', args.length, ...args]);
        if (args.length !== 2) throw new Error('callback overload forbidden');
        return Promise.resolve();
      },
    },
  });

  await env.registration.startupReady;
  env.events.alarm.emit({ name: HIGHLIGHT_EXPIRY_ALARM_NAME, scheduledTime: 1_788_000_000_001 });
  await tick();
  assert.deepEqual(calls, [
    ['clear', 1, HIGHLIGHT_EXPIRY_ALARM_NAME],
    ['clear', 1, PERSONA_EXPIRY_ALARM_NAME],
    ['clear', 1, HIGHLIGHT_EXPIRY_ALARM_NAME],
  ]);
});

test('a restarted worker recovers an active persona and rehydrates it through a fresh Side Panel capability', async () => {
  const leaseId = `lease-${'L'.repeat(22)}`;
  const target = {
    tabId: 17,
    windowId: 9,
    documentId: 'document-a',
    urlSessionDigest: `hmac-sha256:${'A'.repeat(43)}`,
  };
  const initialSession = {
    'audita:persona-leases:v1': {
      version: 1,
      leases: {
        [leaseId]: {
          version: 1,
          leaseId,
          target,
          consumer: {
            extensionId: 'abcdefghijklmnopabcdefghijklmnop',
            documentId: 'panel-document',
            path: '/src/panel/index.html',
            windowId: 9,
          },
          activeMode: 'reader',
          pendingMode: null,
          createdAt: 1_788_000_000_000,
          lastExplicitActionAt: 1_788_000_000_000,
          expiresAt: 1_788_001_800_000,
          state: 'active',
          revision: 2,
          revokeReason: null,
        },
      },
      ownerByTarget: { [`${target.tabId}\u0000${target.documentId}`]: leaseId },
    },
  };
  const scripting = {
    async executeScript(details) {
      const command = details.args?.[0];
      const result = command?.op === 'probe'
        ? { ok: true, present: true, mode: 'reader' }
        : { ok: true, mode: 'reader' };
      return [{ frameId: 0, documentId: target.documentId, result }];
    },
    async insertCSS() {},
    async removeCSS() {},
  };
  const alarmCalls = [];
  const env = defaultGraphFixture(initialSession, {
    alarms: {
      clear(...args) {
        alarmCalls.push(['clear', args.length, ...args]);
        if (args.length !== 1) throw new Error('callback overload forbidden');
        return Promise.resolve(true);
      },
      create(...args) {
        alarmCalls.push(['create', args.length, ...args]);
        if (args.length !== 2) throw new Error('callback overload forbidden');
        return Promise.resolve();
      },
    },
    scripting,
    tabsQuery: async () => [{
      id: target.tabId,
      windowId: target.windowId,
      active: true,
      status: 'complete',
      url: 'https://example.test/',
    }],
    chromeAdapter: Object.freeze({
      async probeDocumentIdentity() { return structuredClone(target); },
      async getEvidenceUrl() { return 'https://example.test/'; },
    }),
  });
  await env.registration.startupReady;
  assert.deepEqual(alarmCalls, [
    ['clear', 1, HIGHLIGHT_EXPIRY_ALARM_NAME],
    ['create', 2, PERSONA_EXPIRY_ALARM_NAME, { when: 1_788_001_800_000 }],
  ]);
  const panel = await env.connectPanel();
  const prepared = await panel.request({
    type: 'PREPARE_PANEL_PERSONA_CAPABILITY',
    requestId: 'persona-after-worker-restart',
  });
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  const rehydrated = await panel.request({
    type: 'PANEL_REHYDRATE_PERSONA',
    capabilityId: prepared.capabilityId,
  });
  assert.deepEqual(rehydrated, {
    ok: true,
    lease: {
      leaseId,
      activeMode: 'reader',
      expiresAt: 1_788_001_800_000,
    },
  });
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
    panelCoordinator: { attachPanelPort() {} },
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

test('rejects old one-shot privileged messages and routes only correlated report mutations', async () => {
  const { chromeApi, events } = chromeFixture();
  const oldTypes = ['GET_LAST_AUDIT', 'REVIEW_COMMITTED', 'REQUEST_DELETE_AUDIT', 'REQUEST_DELETE_ALL_AUDITS'];
  const routed = [];
  registerServiceWorker(chromeApi, {
    startupReady: Promise.resolve(runtimeValue()),
    router: { async dispatch({ envelope }) { routed.push(envelope); return { ok: true }; } },
    panelCoordinator: { attachPanelPort() {} },
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
  for (const type of oldTypes) assert.equal(listener(messages[type], {}, () => { throw new Error('must not respond'); }), false);
  for (const type of ['START_AUDIT', 'START_BATCH', 'CANCEL_AUDIT', 'REQUEST_EXPORT', 'EXPORT_PROGRESS', 'EXPORT_FAILED', 'EXPORT_BUSY', 'EXPORT_INVALIDATED']) {
    assert.equal(listener({ type }, {}, () => { throw new Error('must not respond'); }), false);
  }
  const correlated = {
    type: 'REPORT_DELETE_AUDIT', sessionCapabilityId: 'S'.repeat(22), auditId: 'audit-1',
  };
  assert.equal(listener(correlated, {}, () => {}), true);
  await tick();
  assert.deepEqual(routed, [correlated]);
});

test('real default graph authorizes first then commits one review with snapshot CAS and a closed receipt', async () => {
  const env = defaultGraphFixture(null, { enableReportLaunch: true, reviewConflicts: 1 });
  env.snapshots.set(SAMPLE_AUDIT.auditId, {
    model: structuredClone(SAMPLE_AUDIT), revision: 1, capability: Object.freeze({}),
  });
  const { connected, from } = await env.connectReport(SAMPLE_AUDIT.auditId);
  assert.equal(connected.ok, true);
  const entry = SAMPLE_AUDIT.manualReview[0];
  const response = await env.dispatch({
    type: 'REPORT_COMMIT_REVIEW_DECISION', sessionCapabilityId: connected.sessionCapabilityId,
    auditId: SAMPLE_AUDIT.auditId, itemId: entry.itemId, occurrenceId: entry.occurrenceId,
    answer: 'não conforme', evaluator: 'Pessoa avaliadora', decidedAt: '2026-08-30T12:00:00.000Z',
    mode: entry.mode, note: 'Barreira confirmada.',
  }, from);

  assert.deepEqual(response, {
    ok: true, auditId: SAMPLE_AUDIT.auditId, occurrenceId: entry.occurrenceId,
    modelRevision: 2, modelHash: 'a'.repeat(64),
  });
  assert.equal(env.storeCalls.filter(([name]) => name === 'commitAuditReviewIfRevision').length, 2);
  const stored = env.snapshots.get(SAMPLE_AUDIT.auditId);
  assert.equal(stored.revision, 2);
  assert.deepEqual(stored.model.reviewDecisions.map(value => value.occurrenceId), [entry.occurrenceId]);
  assert.deepEqual(env.sent, [{
    type: 'AUDIT_REVIEW_UPDATED', auditId: SAMPLE_AUDIT.auditId, exportRevision: 2,
  }]);
  assert.equal(JSON.stringify(response).includes('evaluator'), false);
  assert.equal(JSON.stringify(response).includes('note'), false);
  assert.equal(JSON.stringify(response).includes('capability'), false);
});

test('expired revoked and wrong-document report sessions cause zero review-store mutation', async t => {
  for (const attack of ['expired', 'revoked', 'wrong-document']) await t.test(attack, async () => {
    const env = defaultGraphFixture(null, { enableReportLaunch: true });
    env.snapshots.set(SAMPLE_AUDIT.auditId, {
      model: structuredClone(SAMPLE_AUDIT), revision: 1, capability: Object.freeze({}),
    });
    const { connected, from } = await env.connectReport(SAMPLE_AUDIT.auditId);
    assert.equal(connected.ok, true);
    const consumerKey = `audita:report-consumer:v1:${connected.sessionCapabilityId}`;
    if (attack === 'expired') env.sessionValues[consumerKey].expiresAt = 1_788_000_000_000;
    if (attack === 'revoked') env.sessionValues[consumerKey].state = 'revoked';
    const entry = SAMPLE_AUDIT.manualReview[0];
    const response = await env.dispatch({
      type: 'REPORT_COMMIT_REVIEW_DECISION', sessionCapabilityId: connected.sessionCapabilityId,
      auditId: SAMPLE_AUDIT.auditId, itemId: entry.itemId, occurrenceId: entry.occurrenceId,
      answer: 'conforme', evaluator: 'Pessoa avaliadora', decidedAt: '2026-08-30T12:00:00.000Z',
      mode: entry.mode, note: '',
    }, attack === 'wrong-document' ? { ...from, documentId: 'foreign-document' } : from);

    assert.equal(response.ok, false);
    assert.equal(env.storeCalls.some(([name]) => name === 'commitAuditReviewIfRevision'), false);
    assert.equal(env.snapshots.get(SAMPLE_AUDIT.auditId).revision, 1);
    assert.equal(env.snapshots.get(SAMPLE_AUDIT.auditId).model.reviewDecisions.length, 0);
    assert.deepEqual(env.sent, []);
  });
});

test('real default graph deletes one/all through correlated surfaces and maps storage busy errors', async () => {
  const env = defaultGraphFixture(null, { enableReportLaunch: true });
  env.snapshots.set('audit-delete', { model: { auditId: 'audit-delete' }, revision: 1, capability: Object.freeze({}) });
  const { connected, from } = await env.connectReport('audit-delete');
  assert.equal(connected.ok, true);
  assert.deepEqual(await env.dispatch(
    { type: 'REPORT_DELETE_AUDIT', sessionCapabilityId: connected.sessionCapabilityId, auditId: 'audit-delete' },
    from,
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
  const nullScansBeforeDeleteAll = env.sessionGetCalls.filter(value => value === null).length;
  env.denySessionScan();
  assert.deepEqual(await env.dispatch({
    type: 'REPORT_DELETE_ALL_AUDITS', sessionCapabilityId: connected.sessionCapabilityId, auditId: 'audit-delete',
  }, from), { ok: true, deleted: 3 });
  assert.deepEqual(env.sent.at(-1), { type: 'AUDIT_DELETED', scope: 'all', reason: 'delete-all' });
  assert.equal(Object.hasOwn(env.sessionValues, 'audita:execution-checkpoint:v1:audit-stale'), true);
  assert.equal(Object.hasOwn(env.sessionValues, 'audita:execution-checkpoint:v1:audit-transplanted'), true);
  assert.deepEqual(env.sessionValues['user:unrelated'], { private: true });
  assert.equal(env.sessionGetCalls.filter(value => value === null).length, nullScansBeforeDeleteAll);

  env.snapshots.set('audit-delete', { model: { auditId: 'audit-delete' }, revision: 2, capability: Object.freeze({}) });
  env.setDeleteError(Object.assign(new Error('native lock detail'), { code: 'AUDIT_DELETE_BUSY' }));
  assert.deepEqual(await env.dispatch(
    { type: 'REPORT_DELETE_AUDIT', sessionCapabilityId: connected.sessionCapabilityId, auditId: 'audit-delete' },
    from,
  ), { ok: false, code: 'AUDIT_DELETE_BUSY' });
});

test('unknown URL and batch envelopes do not read, serialize, log or respond with secret fields', () => {
  const { chromeApi, events } = chromeFixture();
  const logs = [];
  registerServiceWorker(chromeApi, {
    startupReady: Promise.resolve(runtimeValue()),
    router: { async dispatch() { throw new Error('must not run'); } },
    panelCoordinator: { attachPanelPort() {} },
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

test('dispatch rejection becomes a fixed closed response only for recognized primary paths', async () => {
  const { chromeApi, events } = chromeFixture();
  registerServiceWorker(chromeApi, {
    startupReady: Promise.resolve(runtimeValue()),
    router: { async dispatch() { throw new Error('native primary secret'); } },
    panelCoordinator: { attachPanelPort() {} },
    createEventNonce: () => 'N'.repeat(22), createAuditId: () => 'audit-1', epochNow: () => 1,
    logger: { error() {} },
  });
  const listener = [...events.message.listeners][0];
  const primary = [];
  let oldResponses = 0;
  listener({ type: 'PREPARE_PANEL_CAPABILITY', requestId: 'request-fixed', windowId: 9 }, {}, value => primary.push(value));
  assert.equal(listener({ type: 'GET_LAST_AUDIT' }, {}, () => { oldResponses += 1; }), false);
  await tick();
  assert.deepEqual(primary, [{ ok: false, code: 'CONTEXT_DENIED' }]);
  assert.equal(oldResponses, 0);
});
