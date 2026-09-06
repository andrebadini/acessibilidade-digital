import assert from 'node:assert/strict';
import test from 'node:test';

import { SAMPLE_AUDIT } from '../../fixtures/audits/sample-audit.js';
import { PANEL_PORT_NAME, panelBootstrapStorageKey } from '../../src/background/panel-port.js';
import { REPORT_PORT_NAME } from '../../src/background/report-port.js';
import { BLOB_URL_PORT_NAME } from '../../src/export/blob-url-protocol.js';
import { deriveExportLeaseOwner } from '../../src/background/export-launch.js';
import { createRawNavigationVaultV1 } from '../../src/background/raw-navigation-vault.js';
import { ACTIVE_AUDIT_JOB_KEY } from '../../src/background/authorized-audit-starter.js';
import {
  HIGHLIGHT_EXPIRY_ALARM_NAME,
  PERSONA_EXPIRY_ALARM_NAME,
  registerServiceWorker,
} from '../../src/background/service-worker.js';
import { PIXEL_CONSENT_ALARM_NAME } from '../../src/background/pixel-consent-expiry.js';
import { RETENTION_ALARM_NAME, registerRetentionSchedulerV1 } from '../../src/background/retention-scheduler.js';
import * as serviceWorkerModule from '../../src/background/service-worker.js';
import { createInMemoryAuditStore } from '../../src/storage/audit-store.js';
import { createCapturePolicyV1 } from '../../src/core/privacy/capture-policy.js';
import { createScriptedPixelCommitClockV1 } from '../../src/background/pixel-commit-clock.js';
import { createPixelCaptureStateV1 } from '../../src/background/pixel-capture-consent.js';
import { createOwnedTabRegistry } from '../../src/background/owned-tabs.js';
import { runBatch } from '../../src/background/run-batch.js';
import { sanitizeEvidenceUrlV1 } from '../../src/core/privacy/evidence-url.js';
import { normalizeUrlList } from '../../src/core/batch/normalize-url-list.js';
import { enrichAuditForReport } from '../../src/core/report/enrich-audit.js';
import { createInstalledCoreRuleInventory } from '../../src/core/rules/core-rule-inventory.js';
import { createFakeLockManager } from '../personas/fake-lock-manager.js';
import { reportInput } from '../report/helpers.js';

const CAPABILITY = 'C'.repeat(22);
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

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
    action: event(), alarm: event(), startup: event(),
  };
  const alarmValues = new Map();
  return {
    events,
    chromeApi: {
      runtime: {
        id: 'abcdefghijklmnopabcdefghijklmnop',
        onMessage: events.message, onConnect: events.connect, onInstalled: events.installed, onStartup: events.startup,
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
      alarms: {
        onAlarm: events.alarm,
        async create(name, details) { alarmValues.set(name, { name, scheduledTime: details.when }); },
        async get(name) { return alarmValues.get(name); },
        async clear(name) { return alarmValues.delete(name); },
      },
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

const RETENTION_NOW = '2026-09-05T14:00:00.000Z';

async function retainAudit(store, auditId, now = '2026-08-01T00:00:00.000Z') {
  const model = structuredClone(SAMPLE_AUDIT);
  model.auditId = auditId;
  await store.commitAudit(auditId, model, { auditId }, { now });
}

async function settleRetention() {
  for (let index = 0; index < 30; index += 1) await tick();
}

test('R3-E startup removes expired real models and completed tombstones while preserving future and foreign state', async t => {
  const values = new Map();
  const auditStore = createInMemoryAuditStore(values);
  values.set('foreign-state', { private: 'preserve' });
  await retainAudit(auditStore, 'expired-startup');
  await retainAudit(auditStore, 'future-startup', RETENTION_NOW);
  const env = defaultGraphFixture({ 'foreign-session': { private: 'preserve' } }, {
    auditStore, enableReportLaunch: true, modelNow: () => RETENTION_NOW,
  });
  t.after(() => env.registration.dispose());
  const runtime = await env.registration.startupReady;
  await settleRetention();
  assert.equal((await auditStore.getAuditSnapshot('expired-startup')).model === undefined, true);
  assert.deepEqual(await auditStore.listDeletionTombstonesV1({ limit: 25 }), []);
  assert.equal((await auditStore.getAuditSnapshot('future-startup')).model.auditId, 'future-startup');
  assert.deepEqual(values.get('foreign-state'), { private: 'preserve' });
  assert.deepEqual(env.sessionValues['foreign-session'], { private: 'preserve' });
  assert.equal((await env.chromeApi.alarms.get(RETENTION_ALARM_NAME)).scheduledTime,
    Date.parse('2026-10-05T14:00:00.000Z'));
  assert.equal(Object.hasOwn(runtime, 'retentionScheduler'), false);
  assert.equal(Object.hasOwn(runtime, 'deletionCoordinator'), false);
});

test('R3-E unavailable launch preserves a retry tombstone after hiding the model and does not block readiness', async t => {
  const auditStore = createInMemoryAuditStore();
  await retainAudit(auditStore, 'expired-unavailable-launch');
  const env = defaultGraphFixture(null, { auditStore, modelNow: () => RETENTION_NOW });
  t.after(() => env.registration.dispose());
  const runtime = await env.registration.startupReady;
  await settleRetention();
  assert.equal((await auditStore.getAuditSnapshot('expired-unavailable-launch')).model === undefined, true);
  const pending = await auditStore.listDeletionTombstonesV1({ limit: 25 });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].attempts, 1);
  assert.equal(pending[0].lastAttemptAt, RETENTION_NOW);
  assert.equal((await env.chromeApi.alarms.get(RETENTION_ALARM_NAME)).scheduledTime,
    Date.parse('2026-09-05T14:01:00.000Z'));
  await assert.rejects(runtime.reportLaunch.clearAudit('expired-unavailable-launch'),
    error => error.constructor === Error && error.message === 'AUDIT_DELETION_UNAVAILABLE' && error.cause === undefined);
  await assert.rejects(runtime.exportLaunch.clearAudit('expired-unavailable-launch'), /AUDIT_DELETION_UNAVAILABLE/u);
});

test('R3-E retention waits for recovery completion and never starts after recovery rejection', async t => {
  for (const outcome of ['complete', 'pixel-rejected', 'audit-blocked']) await t.test(outcome, async t => {
    const auditStore = createInMemoryAuditStore();
    await retainAudit(auditStore, 'expired-recovery');
    const recovery = deferred();
    const entered = deferred();
    const env = defaultGraphFixture(outcome === 'audit-blocked' ? {
      [ACTIVE_AUDIT_JOB_KEY]: { version: 1, auditId: 'malformed-active', state: 'running' },
    } : null, {
      auditStore, enableReportLaunch: true, modelNow: () => RETENTION_NOW,
      pixelConsentSchedulerFactory() {
        return { async recoverOnStartup() { entered.resolve(); await recovery.promise; },
          async run() {}, async scheduleNext() {}, dispose() {} };
      },
    });
    t.after(() => env.registration.dispose());
    const ready = env.registration.startupReady.catch(error => error);
    await entered.promise;
    assert.equal(env.events.startup.listeners.size, 0);
    assert.equal((await auditStore.getAuditSnapshot('expired-recovery')).model.auditId, 'expired-recovery');
    assert.deepEqual(await auditStore.listDeletionTombstonesV1({ limit: 25 }), []);
    if (outcome === 'pixel-rejected') recovery.reject(new Error('PRIVATE_RECOVERY_FAILURE'));
    else recovery.resolve();
    const result = await ready;
    await settleRetention();
    if (outcome === 'complete') {
      assert.equal(result instanceof Error, false);
      assert.equal((await auditStore.getAuditSnapshot('expired-recovery')).model === undefined, true);
      assert.equal(env.events.startup.listeners.size, 1);
    } else {
      assert.equal(result.message, 'WORKER_UNAVAILABLE');
      assert.equal(env.events.startup.listeners.size, 0);
      assert.equal((await auditStore.getAuditSnapshot('expired-recovery')).model.auditId, 'expired-recovery');
      assert.deepEqual(await auditStore.listDeletionTombstonesV1({ limit: 25 }), []);
    }
  });
});

test('R3-E startup alarm toolbar and context panel events run once and disposal preserves foreign listeners', async t => {
  const realStore = createInMemoryAuditStore();
  const staged = [];
  const auditStore = { ...realStore, async stageExpiredAuditDeletionsV1(request) {
    staged.push(structuredClone(request));
    return realStore.stageExpiredAuditDeletionsV1(request);
  } };
  const env = defaultGraphFixture(null, { auditStore, enableReportLaunch: true, modelNow: () => RETENTION_NOW });
  t.after(() => env.registration.dispose());
  const foreignStartup = () => {};
  const foreignAlarm = () => {};
  env.events.startup.addListener(foreignStartup);
  env.events.alarm.addListener(foreignAlarm);
  await env.registration.startupReady;
  await settleRetention();
  assert.equal(staged.length, 1);
  const tab = { id: 17, windowId: 9, status: 'complete', url: 'https://example.test/' };
  const triggers = [
    () => env.events.startup.emit(),
    () => env.events.alarm.emit({ name: RETENTION_ALARM_NAME }),
    () => env.events.action.emit(tab),
    () => env.events.context.emit({ menuItemId: 'audita.accessibility.audit-page', frameId: 0 }, tab),
  ];
  for (let index = 0; index < triggers.length; index += 1) {
    const auditId = `expired-event-${index}`;
    await retainAudit(auditStore, auditId);
    triggers[index]();
    await settleRetention();
    assert.equal(staged.length, index + 2);
    assert.equal((await auditStore.getAuditSnapshot(auditId)).model === undefined, true);
    assert.deepEqual(await auditStore.listDeletionTombstonesV1({ limit: 25 }), []);
  }
  assert.equal(staged.every(value => value.now === RETENTION_NOW && value.limit === 25), true);
  env.events.alarm.emit({ name: 'foreign-alarm' });
  await settleRetention();
  assert.equal(staged.length, 5);
  env.registration.dispose();
  assert.deepEqual([...env.events.startup.listeners], [foreignStartup]);
  assert.deepEqual([...env.events.alarm.listeners], [foreignAlarm]);
  env.events.startup.emit();
  env.events.alarm.emit({ name: RETENTION_ALARM_NAME });
  await settleRetention();
  assert.equal(staged.length, 5);
});

test('R3-E private built scheduler validates methods resolves readiness before cleanup and disposes late builds', async t => {
  for (const late of [false, true]) await t.test(late ? 'late build' : 'Blob reconnection readiness', async t => {
    const { chromeApi, events } = chromeFixture();
    const gate = deferred();
    const connected = deferred();
    const realStore = createInMemoryAuditStore();
    let staged = 0;
    let startupObserved = false;
    const store = { ...realStore, async stageExpiredAuditDeletionsV1(request) {
      assert.equal(startupObserved, true, 'startup must be ready before cleanup starts');
      await connected.promise;
      staged += 1;
      return realStore.stageExpiredAuditDeletionsV1(request);
    } };
    const registration = registerServiceWorker(chromeApi, { async buildRuntime() {
      await gate.promise;
      return { readyRuntime: runtimeValue(), router: { dispatch() {} }, panelCoordinator: { attachPanelPort() {} },
        panelLauncher: { launch() { return true; } },
        retentionScheduler: registerRetentionSchedulerV1(chromeApi, {
          store, deletionCoordinator: { async resumePending() {} }, now: () => RETENTION_NOW,
        }),
        blobUrlPortBridge: { attachPort() { connected.resolve(); return true; }, dispose() {} },
      };
    } });
    t.after(() => { connected.resolve(); registration.dispose(); });
    const ready = registration.startupReady.then(value => { startupObserved = true; return value; });
    if (late) registration.dispose();
    gate.resolve();
    const runtime = await ready;
    assert.equal(Object.hasOwn(runtime, 'retentionScheduler'), false);
    if (!late) events.connect.emit(blobWiringPort());
    await settleRetention();
    assert.equal(staged, late ? 0 : 1);
    registration.dispose();
    assert.equal(events.startup.listeners.size, 0);
    assert.equal(events.alarm.listeners.size, 0);
  });
  for (const missing of ['run', 'scheduleNext', 'dispose']) await t.test(`reject missing ${missing}`, async () => {
    const { chromeApi } = chromeFixture();
    const scheduler = { async run() {}, async scheduleNext() {}, dispose() {} };
    delete scheduler[missing];
    const registration = registerServiceWorker(chromeApi, { async buildRuntime() {
      return { readyRuntime: runtimeValue(), router: { dispatch() {} }, panelCoordinator: { attachPanelPort() {} },
        panelLauncher: { launch() {} }, retentionScheduler: scheduler };
    } });
    await assert.rejects(registration.startupReady, /WORKER_UNAVAILABLE/u);
    registration.dispose();
  });
});

async function batchReportFixture(auditId) {
  let tickIndex = 0;
  const now = () => new Date(Date.UTC(2026, 8, 1, 12, 0, tickIndex++)).toISOString();
  const entries = normalizeUrlList('https://one.example.test/\nhttps://two.example.test/').entries;
  const model = await runBatch({
    entries,
    batchAuditId: auditId,
    runner: async options => reportInput({
      auditId: options.idFactory(), requestedUrl: options.url, finalUrl: options.url,
      timestamps: { startedAt: now(), endedAt: now(), generatedAt: now() },
    }),
    chromeAdapter: { async emitProgress() {}, async handoffReport() { return { reviewUrl: null }; } },
    now,
    reportOptions: {
      timezone: 'America/Cuiaba', manifestVersion: '1.0.5', rulesVersion: '1.0.0',
      browserVersion: 'Chrome/152.0.0.0', expectedExtensionId: 'abcdefghijklmnopabcdefghijklmnop',
    },
  });
  const inventory = await createInstalledCoreRuleInventory();
  return {
    model,
    checkpoint: {
      version: 1,
      auditId,
      pages: model.pages.map(page => ({
        pageId: page.pageId, attempted: page.attempted,
        startedAt: page.attempted ? page.timestamps.startedAt : null,
        rulesVersion: inventory.rulesVersion, inventoryVersion: inventory.inventoryVersion,
        inventoryHash: inventory.sha256, outcomes: [],
      })),
    },
  };
}

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
  if (fixtureOptions.useDefaultChromeAdapter === true) {
    chromeApi.tabs.update = async (tabId, options) => ({ id: tabId, windowId: 9, ...options });
    chromeApi.tabs.remove = async () => undefined;
    chromeApi.debugger = {
      async attach() {},
      async sendCommand() { return {}; },
      async detach() {},
    };
  }
  chromeApi.tabs.query = fixtureOptions.tabsQuery ?? (async () => []);
  chromeApi.sidePanel.setOptions = (value, callback) => {
    panelOptions.push(structuredClone(value));
    if (typeof value.path === 'string') panelPath = value.path;
    if (callback) setImmediate(callback);
  };
  chromeApi.sidePanel.open = (_value, callback) => { panelOpens += 1; callback?.(); };
  if (fixtureOptions.scripting) chromeApi.scripting = fixtureOptions.scripting;
  if (fixtureOptions.alarms) chromeApi.alarms = { ...chromeApi.alarms, ...fixtureOptions.alarms, onAlarm: events.alarm };

  const fixtureAuditStore = {
    ...createInMemoryAuditStore(),
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
    async getExportLeaseState() { return { active: false }; },
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
    ...(fixtureOptions.useDefaultChromeAdapter === true ? {} : {
      chromeAdapterFactory(...args) {
        if (fixtureOptions.chromeAdapterFactory) return fixtureOptions.chromeAdapterFactory(...args);
        return Object.freeze({
          async probeDocumentIdentity() { throw new Error('not used'); },
          async probeSensitiveCaptureSignals() {
            return Object.freeze({
              version: 'SensitiveCaptureSignalsV1', detected: false, categories: Object.freeze([]),
            });
          },
          async getEvidenceUrl() { throw new Error('not used'); },
          async getFinalUrl() { return 'https://example.test/'; },
          async proveHighlightTargets() { return []; },
          async verifyHighlightTarget() { return { ok: false, reason: 'live-proof-failed' }; },
          async injectHighlight() { return { ok: false, reason: 'execution-failed' }; },
          async emitProgress() {},
          ...(fixtureOptions.chromeAdapter ?? {}),
        });
      },
    }),
    personaLockManager,
    createAuditId: fixtureOptions.createAuditId ?? (() => 'audit-worker-generated'),
    createExportOwnerId: () => 'export-owner-1',
    createEventNonce: () => 'N'.repeat(22),
    epochNow: fixtureOptions.epochNow ?? (() => 1_788_000_000_000),
    modelNow: fixtureOptions.modelNow ?? (() => '2026-08-29T12:00:00.000Z'),
    randomBytes: fixtureOptions.randomBytes ?? (length => new Uint8Array(length).fill(7)),
    ...(fixtureOptions.useNativePixelCommitClock === true ? {} : {
      pixelCommitClockFactory: () => createScriptedPixelCommitClockV1({ epochs: Array(256).fill(1_788_000_000_000) }),
    }),
    ...(fixtureOptions.rawNavigationVaultFactory ? { rawNavigationVaultFactory: fixtureOptions.rawNavigationVaultFactory } : {}),
    ...(fixtureOptions.runUrlAuditExecution ? { runUrlAuditExecution: fixtureOptions.runUrlAuditExecution } : {}),
    ...(fixtureOptions.batchAuditExecutionFactory
      ? { batchAuditExecutionFactory: fixtureOptions.batchAuditExecutionFactory }
      : {}),
    ...(fixtureOptions.pixelConsentSchedulerFactory
      ? { pixelConsentSchedulerFactory: fixtureOptions.pixelConsentSchedulerFactory }
      : {}),
    logger: { error() {} },
  });

  function sender(kind, auditId = null, leaseOwnerId = null, exportAttempt = null, tabId = 17) {
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
      ...(contextType === 'TAB' ? { tabId } : {}),
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
        let packet = null;
        for (let attempt = 0; attempt < 200 && packet === null; attempt += 1) {
          await new Promise(resolve => setTimeout(resolve, 1));
          packet = port.messages.find(value => value.type === 'intent-result' && value.requestId === requestId) ?? null;
        }
        if (!packet) throw new Error(`panel intent failed: ${JSON.stringify({ messages: port.messages, disconnects: port.disconnects })}`);
        return packet.response;
      },
    };
  }

  async function connectReport(auditId, { preserveLaunch = false } = {}) {
    await registration.startupReady;
    const now = 1_788_000_000_000;
    const launchKey = `audita:report-launch:v1:${auditId}`;
    if (!preserveLaunch) {
      sessionValues[launchKey] = {
        version: 1, auditId, tabId: 17, windowId: 9, path: '/src/review/index.html',
        documentId: null, state: 'awaiting-connection', issuedAt: now, expiresAt: now + 1_800_000,
      };
    }
    const launch = sessionValues[launchKey];
    const from = sender('review', auditId, null, null, launch?.tabId ?? 17);
    const connected = await dispatch({ type: 'REPORT_CONNECT', auditId }, from);
    return { connected, from };
  }

  return {
    chromeApi, events, registration, auditStore, sessionValues, sessionGetCalls, personaLockManager,
    sent, createdTabs, snapshots, retentions, deleted, storeCalls,
    sender, dispatch, connectPanel, connectReport,
    setContext(value) { contexts.set(value.documentId, structuredClone(value)); },
    setLatest(value) { latest = value; },
    setLeaseResult(value) { leaseResult = value; },
    setDeletedAll(value) { deletedAll = value; },
    setDeleteError(value) { deleteError = value; },
    setCleanupError(value) { cleanupError = value; },
    setTabCreator(value) { tabCreator = value; },
    denySessionScan() { denySessionScan = true; },
    allowSessionScan() { denySessionScan = false; },
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

test('holds messages and Ports behind pixel recovery and routes its alarm through the one worker listener', async () => {
  const { chromeApi, events } = chromeFixture();
  const recovery = deferred();
  const calls = [];
  const readyRuntime = runtimeValue();
  const registration = registerServiceWorker(chromeApi, {
    async buildRuntime() {
      return {
        readyRuntime,
        router: { async dispatch() { calls.push('dispatch'); return { ok: true }; } },
        panelCoordinator: { attachPanelPort() { calls.push('port'); return true; } },
        panelLauncher: { launch() { return true; } },
        pixelScheduler: {
          async recoverOnStartup() { calls.push('recover:start'); await recovery.promise; calls.push('recover:end'); },
          async run(trigger) { calls.push(`run:${trigger}`); },
          async scheduleNext() { calls.push('schedule'); },
          dispose() { calls.push('dispose'); },
        },
      };
    },
    createEventNonce: () => 'N'.repeat(22), createAuditId: () => 'audit-1', epochNow: () => 1,
    logger: { error() {} },
  });
  const responses = [];
  [...events.message.listeners][0](
    { type: 'REPORT_DELETE_ALL_AUDITS', sessionCapabilityId: 'S'.repeat(22), auditId: 'audit-1' },
    {}, value => responses.push(value),
  );
  events.connect.emit({ name: PANEL_PORT_NAME, disconnect() {} });
  events.alarm.emit({ name: PIXEL_CONSENT_ALARM_NAME, scheduledTime: 5 });
  await tick();
  assert.deepEqual(calls, ['recover:start']);
  assert.deepEqual(responses, []);

  recovery.resolve();
  await registration.startupReady;
  await tick();
  assert.deepEqual(calls, ['recover:start', 'recover:end', 'dispatch', 'port', 'run:alarm']);
  assert.equal(events.alarm.listeners.size, 1);
  registration.dispose();
  assert.deepEqual(calls.at(-1), 'dispose');
});

test('late-bound pixel liquidator is closed and denies work before its single binding', async () => {
  assert.equal(typeof serviceWorkerModule.createLateBoundPixelLiquidatorFacadeV1, 'function');
  const bridge = serviceWorkerModule.createLateBoundPixelLiquidatorFacadeV1();
  assert.deepEqual(Reflect.ownKeys(bridge), ['facade', 'bind']);
  assert.equal(Object.isFrozen(bridge), true);
  assert.equal(await bridge.facade.liquidate({ auditId: 'audit-a' }), false);
  const calls = [];
  assert.equal(bridge.bind(async value => { calls.push(value); return true; }), true);
  assert.equal(bridge.bind(async () => true), false);
  assert.equal(await bridge.facade.liquidate({ auditId: 'audit-a' }), true);
  assert.deepEqual(calls, [{ auditId: 'audit-a' }]);
});

test('panel bootstrap cleanup accepts only a closed record carrying its capture mode', async () => {
  const auditId = 'audit-bootstrap-mode';
  const area = sessionAreaForCheckpointTest();
  const readOne = area.get.bind(area);
  area.get = async key => key === null ? structuredClone(area.values) : readOne(key);
  const key = panelBootstrapStorageKey(9);
  area.values[key] = {
    version: 1, kind: 'audit-session', auditId,
    sessionCapabilityId: 'S'.repeat(22), windowId: 9,
    captureMode: 'element-only',
    createdAt: 10, expiresAt: 20, state: 'consumed',
  };
  const calls = [];
  const panelCoordinator = {
    async withWindowLock(windowId, callback) {
      return callback({
        async disconnectSession(value) {
          calls.push([windowId, structuredClone(value)]);
          delete area.values[key];
          return true;
        },
      });
    },
  };
  assert.equal(await serviceWorkerModule.disconnectPanelAuditSessions({
    auditId, sessionArea: area, panelCoordinator,
  }), true);
  assert.deepEqual(calls, [[9, {
    auditId, sessionCapabilityId: 'S'.repeat(22), windowId: 9, reasonCode: 'AUDIT_DELETED',
  }]]);

  area.values[key] = {
    version: 1, kind: 'audit-session', auditId,
    sessionCapabilityId: 'S'.repeat(22), windowId: 9,
    createdAt: 10, expiresAt: 20, state: 'consumed',
  };
  calls.length = 0;
  assert.equal(await serviceWorkerModule.disconnectPanelAuditSessions({
    auditId, sessionArea: area, panelCoordinator,
  }), false);
  assert.deepEqual(calls, []);
});

test('batch pixel gate stores parent authority while projecting the exact child target to the runner', async () => {
  assert.equal(typeof serviceWorkerModule.createBatchPagePixelPrivacyGateV1, 'function');
  const area = sessionAreaForCheckpointTest();
  let epoch = 1_788_000_000_000;
  const pixelState = createPixelCaptureStateV1({
    sessionArea: area,
    now: () => epoch++,
    randomBytes: length => new Uint8Array(length).fill(7),
  });
  const capturePolicy = createCapturePolicyV1({ mode: 'full-evidence', includeQuery: false });
  const batchAuditId = 'audit-batch-pixels';
  const childAuditId = 'opaque-child-audit';
  const pageId = 'page-2';
  const ownershipId = `owner_${'O'.repeat(22)}`;
  const target = Object.freeze({
    version: 'ObservedTargetV1', kind: 'owned-disposable', ownershipId,
    tabId: 27, windowId: 9, documentId: 'document-a',
    urlEvidence: sanitizeEvidenceUrlV1('https://example.test/private?token=secret', { includeQuery: false }),
    urlSessionDigest: `hmac-sha256:${'D'.repeat(43)}`,
    cleanupMode: 'always', pageId: 'page-1',
  });
  const signals = Object.freeze({
    version: 'SensitiveCaptureSignalsV1', detected: true,
    categories: Object.freeze(['password']),
  });
  const gateInput = {
    pixelState,
    pixelCommitClock: createScriptedPixelCommitClockV1({
      epochs: Array(8).fill(1_788_000_000_010),
    }),
    batchAuditId,
    childAuditId,
    pageId,
    ownershipId,
    consentId: null,
    authorityExpiresAt: 1_788_000_500_000,
    capturePolicy,
  };
  const pausedGate = serviceWorkerModule.createBatchPagePixelPrivacyGateV1(gateInput);
  assert.deepEqual(await pausedGate.preflight({
    auditId: childAuditId, observedTarget: target, capturePolicy, signals,
  }), { status: 'privacy-paused', signals });
  const suspension = await pixelState.readSuspension(batchAuditId);
  assert.equal(suspension.auditId, batchAuditId);
  assert.deepEqual(suspension.source, {
    kind: 'owned-disposable', ownershipId, cleanupMode: 'always', pageId,
  });
  assert.equal(await pixelState.readSuspension(childAuditId), null);

  const parentProof = {
    kind: 'owned-disposable', ownershipId, tabId: target.tabId, windowId: target.windowId,
    documentId: target.documentId, urlSessionDigest: target.urlSessionDigest,
    cleanupMode: 'always', pageId,
  };
  await pixelState.claimAndBeginResume({
    auditId: batchAuditId, consentId: suspension.consentId,
    proof: parentProof, mode: capturePolicy.mode, categories: signals.categories,
  });
  await pixelState.markSessionRunning({ auditId: batchAuditId, consentId: suspension.consentId });
  const resumedGate = serviceWorkerModule.createBatchPagePixelPrivacyGateV1({
    ...gateInput,
    pixelCommitClock: createScriptedPixelCommitClockV1({
      epochs: Array(8).fill(1_788_000_000_000),
    }),
    consentId: suspension.consentId,
  });
  assert.deepEqual(await resumedGate.preflight({
    auditId: childAuditId, observedTarget: target, capturePolicy, signals,
  }), { status: 'armed' });
  assert.deepEqual(await resumedGate.authorizeFirstPixel({
    auditId: childAuditId, observedTarget: target, capturePolicy,
    proof: {
      tabId: target.tabId, windowId: target.windowId,
      documentId: target.documentId, urlSessionDigest: target.urlSessionDigest,
    },
    signals,
  }), { status: 'ready' });
  const running = await pixelState.readSuspension(batchAuditId);
  assert.equal(running.state, 'resuming');
  assert.equal(running.resumePhase, 'runner-started');
  assert.equal(running.source.pageId, pageId);
});

test('pixel-attempt recovery classifies an expired prepared marker without reminting a commit capability', async () => {
  assert.equal(typeof serviceWorkerModule.createPixelAttemptLifecycleV1, 'function');
  const auditId = 'audit-expired-attempt';
  const consentId = `${'A'.repeat(21)}Q`;
  const attemptDigest = `hmac-sha256:${'D'.repeat(43)}`;
  const key = `audita:pixel-attempt:v1:${auditId}:${'D'.repeat(43)}`;
  const values = {
    [key]: { version: 1, auditId, attemptDigest, pageId: null, ownershipId: null, preparedAt: 1, expiresAt: 2 },
  };
  let prepareCalls = 0;
  const lifecycle = serviceWorkerModule.createPixelAttemptLifecycleV1({
    sessionArea: { async get() { return structuredClone(values); } },
    auditStore: {
      async commitAuditWithCheckpointIfAbsent() { throw new Error('not used'); },
      async getReportRevision() { return null; },
    },
    attemptAuthority: { async digestAttempt() { return attemptDigest; } },
    attemptCorrelation: {
      async prepare() { prepareCalls += 1; throw new Error('expired marker cannot mint'); },
      async markerMatches() { return true; }, async remove() { return true; },
    },
    modelNow: () => '2026-08-29T12:00:00.000Z',
  });
  assert.deepEqual(await lifecycle.classify({ auditId, consentId }), { state: 'prepared', handle: null });
  assert.equal(prepareCalls, 0);
});

test('single-URL pixel attempt keeps the exact page and disposable owner through prepare and classify', async () => {
  const auditId = 'audit-url-pixel-attempt';
  const consentId = `${'A'.repeat(21)}Q`;
  const ownershipId = `owner_${'O'.repeat(22)}`;
  const attemptDigest = `hmac-sha256:${'F'.repeat(43)}`;
  const key = `audita:pixel-attempt:v1:${auditId}:${'F'.repeat(43)}`;
  const marker = {
    version: 1, auditId, attemptDigest, pageId: 'page-1', ownershipId,
    preparedAt: 1, expiresAt: 10,
  };
  const prepared = [];
  const matched = [];
  const lifecycle = serviceWorkerModule.createPixelAttemptLifecycleV1({
    sessionArea: { async get() { return { [key]: structuredClone(marker) }; } },
    auditStore: {
      async commitAuditWithCheckpointIfAbsent() { throw new Error('not used'); },
      async getReportRevision() { return null; },
    },
    attemptAuthority: { async digestAttempt() { return attemptDigest; } },
    attemptCorrelation: {
      async prepare(value) { prepared.push(structuredClone(value)); return Object.freeze(Object.create(null)); },
      async markerMatches(value) { matched.push(structuredClone(value)); return true; },
      async remove() { return true; },
    },
    modelNow: () => '2026-08-29T12:00:00.000Z',
  });

  const handle = await lifecycle.prepareResume({
    auditId, consentId, pageId: 'page-1', ownershipId, expiresAt: 10,
  });
  assert.deepEqual(Reflect.ownKeys(handle), []);
  assert.deepEqual(prepared, [{ auditId, consentId, pageId: 'page-1', ownershipId, expiresAt: 10 }]);
  assert.deepEqual(matched[0], { auditId, attemptDigest, pageId: 'page-1', ownershipId });
  const classification = await lifecycle.classify({
    auditId, consentId, pageId: 'page-1', ownershipId,
  });
  assert.deepEqual(matched.at(-1), { auditId, attemptDigest, pageId: 'page-1', ownershipId });
  assert.deepEqual(classification, { state: 'prepared', handle: null });
  assert.deepEqual(await lifecycle.classify({ auditId, consentId: null }), {
    state: 'blocked', handle: null,
  });
});

test('batch pixel attempt accepts the exact later page and removes its prepared marker before the next consent', async () => {
  const auditId = 'audit-batch-page-attempt';
  const consentId = `${'B'.repeat(21)}Q`;
  const ownershipId = `owner_${'P'.repeat(22)}`;
  const attemptDigest = `hmac-sha256:${'G'.repeat(43)}`;
  const key = `audita:pixel-attempt:v1:${auditId}:${'G'.repeat(43)}`;
  let marker = {
    version: 1, auditId, attemptDigest, pageId: 'page-2', ownershipId,
    preparedAt: 1, expiresAt: 10,
  };
  const lifecycle = serviceWorkerModule.createPixelAttemptLifecycleV1({
    sessionArea: { async get() { return marker ? { [key]: structuredClone(marker) } : {}; } },
    auditStore: {
      async commitAuditWithCheckpointIfAbsent() { throw new Error('not used'); },
      async getReportRevision() { return null; },
    },
    attemptAuthority: { async digestAttempt() { return attemptDigest; } },
    attemptCorrelation: {
      async prepare() { return Object.freeze(Object.create(null)); },
      async markerMatches(value) {
        return Boolean(marker) && value.auditId === auditId && value.attemptDigest === attemptDigest &&
          value.pageId === 'page-2' && value.ownershipId === ownershipId;
      },
      async remove(value) {
        assert.equal(value.pageId, 'page-2');
        assert.equal(value.ownershipId, ownershipId);
        marker = null;
        return true;
      },
    },
    modelNow: () => '2026-08-29T12:00:00.000Z',
  });

  const handle = await lifecycle.prepareResume({
    auditId, consentId, pageId: 'page-2', ownershipId, expiresAt: 10,
  });
  assert.deepEqual(Reflect.ownKeys(handle), []);
  assert.deepEqual(await lifecycle.classify({ auditId, consentId, pageId: 'page-2', ownershipId }), {
    state: 'prepared', handle: null,
  });
  assert.equal(await lifecycle.cleanup({
    auditId, consentId, pageId: 'page-2', ownershipId, expected: 'prepared',
  }), true);
  assert.equal(marker, null);
});

test('single-URL cleanup removes only the exact disposable owner even when an audit has another owner', async () => {
  assert.equal(typeof serviceWorkerModule.createExactUrlAuditResourceCleanerV1, 'function');
  const area = sessionAreaForCheckpointTest();
  const removedTabs = [];
  let clock = 0;
  const registry = createOwnedTabRegistry({
    sessionArea: area,
    chromeAdapter: { async removeTab(tabId) { removedTabs.push(tabId); } },
    now: () => new Date(1_788_000_000_000 + clock++).toISOString(),
  });
  const auditId = 'audit-two-owned-tabs';
  const ownerOne = `owner_${'A'.repeat(22)}`;
  const ownerTwo = `owner_${'B'.repeat(22)}`;
  await registry.registerCreated({
    ownershipId: ownerOne, auditId, purpose: 'audit', tabId: 27, windowId: 9,
    cleanupMode: 'pre-observation-failure',
  });
  await registry.registerCreated({
    ownershipId: ownerTwo, auditId, purpose: 'audit', tabId: 28, windowId: 9,
    cleanupMode: 'pre-observation-failure',
  });
  const clearedAudits = [];
  const cleaner = serviceWorkerModule.createExactUrlAuditResourceCleanerV1({
    rawNavigationVault: { async clearAudit(value) { clearedAudits.push(value); return 0; } },
    ownedTabRegistry: registry,
  });

  assert.equal(await cleaner({ auditId, ownershipId: ownerOne }), true);
  assert.deepEqual(clearedAudits, [auditId]);
  assert.deepEqual(removedTabs, [27]);
  assert.equal((await registry.get(ownerOne)).state, 'removed');
  assert.equal((await registry.get(ownerTwo)).state, 'created');
});

test('URL cleanup accepts cleanup always only with an exact attached-copy correlation request', async () => {
  const area = sessionAreaForCheckpointTest();
  const removedTabs = [];
  const registry = createOwnedTabRegistry({
    sessionArea: area,
    chromeAdapter: { async removeTab(tabId) { removedTabs.push(tabId); } },
    now: () => '2026-09-01T12:00:00.000Z',
  });
  const auditId = 'audit-attached-copy-cleaner';
  const ownershipId = `owner_${'C'.repeat(22)}`;
  const foreignOwnershipId = `owner_${'D'.repeat(22)}`;
  await registry.registerCreated({
    ownershipId, auditId, purpose: 'audit', tabId: 27, windowId: 9,
    cleanupMode: 'always',
  });
  await registry.registerCreated({
    ownershipId: foreignOwnershipId, auditId, purpose: 'audit', tabId: 28, windowId: 9,
    cleanupMode: 'always',
  });
  const cleaner = serviceWorkerModule.createExactUrlAuditResourceCleanerV1({
    rawNavigationVault: { async clearAudit() { return 1; } },
    ownedTabRegistry: registry,
  });

  assert.equal(await cleaner({ auditId, ownershipId }), false);
  assert.equal((await registry.get(ownershipId)).state, 'created');
  assert.equal(await cleaner({
    auditId, ownershipId, navigationPurpose: 'single-url', cleanupMode: 'always',
  }), false);
  assert.equal((await registry.get(ownershipId)).state, 'created');
  assert.equal(await cleaner({
    auditId, ownershipId, navigationPurpose: 'attached-copy', cleanupMode: 'always',
  }), true);
  assert.deepEqual(removedTabs, [27]);
  assert.equal((await registry.get(ownershipId)).state, 'removed');
  assert.equal((await registry.get(foreignOwnershipId)).state, 'created');
});

test('post-finish cleanup accepts only the companion-first crash cut and removes the remaining marker', async () => {
  const auditId = 'audit-post-finish';
  const attemptDigest = `hmac-sha256:${'E'.repeat(43)}`;
  const key = `audita:pixel-attempt:v1:${auditId}:${'E'.repeat(43)}`;
  const values = {
    [key]: { version: 1, auditId, attemptDigest, pageId: null, ownershipId: null, preparedAt: 1, expiresAt: 2 },
  };
  let present = true;
  const lifecycle = serviceWorkerModule.createPixelAttemptLifecycleV1({
    sessionArea: { async get() { return present ? structuredClone(values) : {}; } },
    auditStore: {
      async commitAuditWithCheckpointIfAbsent() { throw new Error('not used'); },
      async getReportRevision() { return { auditId, modelRevision: 1 }; },
    },
    attemptAuthority: { async digestAttempt() { throw new Error('post-finish has no raw consent'); } },
    attemptCorrelation: {
      async prepare() { throw new Error('not used'); },
      async markerMatches() { return present; },
      async remove() { present = false; return true; },
    },
    modelNow: () => '2026-08-29T12:00:00.000Z',
  });
  assert.deepEqual(await lifecycle.classify({ auditId, consentId: null }), { state: 'blocked', handle: null });
  assert.equal(await lifecycle.cleanup({ auditId, consentId: null, expected: 'post-finish' }), true);
  assert.equal(present, false);
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

function blobWiringPort(name = BLOB_URL_PORT_NAME, sender = {}) {
  const onMessage = event(); const onDisconnect = event();
  return { name, sender, onMessage, onDisconnect, messages: [], disconnects: 0,
    postMessage(value) { this.messages.push(structuredClone(value)); },
    disconnect() { this.disconnects++; onDisconnect.emit(); } };
}

test('Blob wiring routes through one listener only after readiness and rejects failed attachments', async t => {
  for (const mode of ['attached', 'false', 'throw', 'startup-failed']) await t.test(mode, async () => {
    const { chromeApi, events } = chromeFixture(); const ready = deferred(); const attached = [];
    const bridge = { registry: {}, attachPort(port) {
      attached.push(port); if (mode === 'throw') throw new Error('PRIVATE_SENTINEL'); return mode !== 'false';
    }, dispose() {} };
    const registration = registerServiceWorker(chromeApi, {
      startupReady: ready.promise, blobUrlPortBridge: bridge,
      router: { async dispatch() { return { ok: true }; } },
      panelCoordinator: { attachPanelPort() { assert.fail('Blob must not reach panel'); } },
      reportPortCoordinator: { attachReportPort() { assert.fail('Blob must not reach report'); } },
    });
    t.after(() => registration.dispose());
    const port = blobWiringPort(); events.connect.emit(port);
    assert.equal(events.connect.listeners.size, 1); assert.equal(attached.length, 0);
    const resolved = registration.startupReady.catch(() => null);
    if (mode === 'startup-failed') ready.reject(new Error('PRIVATE_SENTINEL'));
    else ready.resolve(runtimeValue());
    await resolved; await tick();
    assert.equal(attached.length, mode === 'startup-failed' ? 0 : 1);
    assert.equal(port.disconnects, mode === 'attached' ? 0 : 1);
  });
});

test('Blob wiring does not attach a queued Port after registration disposal', async () => {
  const { chromeApi, events } = chromeFixture(); const ready = deferred(); let attaches = 0; let disposals = 0;
  const registration = registerServiceWorker(chromeApi, {
    startupReady: ready.promise,
    blobUrlPortBridge: { registry: {}, attachPort() { attaches++; return true; }, dispose() { disposals++; } },
  });
  const port = blobWiringPort(); events.connect.emit(port);
  registration.dispose(); ready.resolve(runtimeValue()); await registration.startupReady; await tick();
  assert.equal(attaches, 0); assert.equal(disposals, 1); assert.equal(port.disconnects, 1);
  assert.equal(events.connect.listeners.size, 0);
});

test('Blob wiring disposes a bridge built after registration was already disposed and keeps it private', async () => {
  const { chromeApi, events } = chromeFixture(); const gate = deferred(); let disposals = 0; let attaches = 0;
  const registration = registerServiceWorker(chromeApi, { async buildRuntime() {
    await gate.promise;
    return { readyRuntime: runtimeValue(), router: { dispatch() {} },
      panelCoordinator: { attachPanelPort() {} }, panelLauncher: { launch() {} },
      blobUrlPortBridge: { registry: {}, attachPort() { attaches++; return true; }, dispose() { disposals++; } } };
  } });
  const port = blobWiringPort(); events.connect.emit(port); await tick();
  registration.dispose(); gate.resolve();
  const runtime = await registration.startupReady; await tick();
  assert.deepEqual(Object.keys(runtime), ['authority', 'auditStarter', 'chromeAdapter']);
  assert.equal(disposals, 1); assert.equal(attaches, 0); assert.equal(port.disconnects, 1);
});

test('Blob wiring rejects a present malformed bridge in the private built graph', async () => {
  for (const bridge of [{ registry: {}, dispose() {} }, { registry: {}, attachPort() {} }]) {
    const { chromeApi } = chromeFixture();
    const registration = registerServiceWorker(chromeApi, { async buildRuntime() {
      return { readyRuntime: runtimeValue(), router: { dispatch() {} }, panelCoordinator: { attachPanelPort() {} },
        panelLauncher: { launch() {} }, blobUrlPortBridge: bridge };
    } });
    await assert.rejects(registration.startupReady, /WORKER_UNAVAILABLE/u); registration.dispose();
  }
});

test('Blob wiring default graph registers with its original store and native export document', async t => {
  const auditStore = createInMemoryAuditStore(); const auditId = 'audit-blob-wiring';
  const epoch = 1_788_000_000_000; const iso = new Date(epoch).toISOString();
  const model = structuredClone(SAMPLE_AUDIT); model.auditId = auditId;
  await auditStore.commitAudit(auditId, model, { auditId }, { now: iso });
  const snapshot = await auditStore.getAuditSnapshot(auditId);
  const leaseOwnerId = deriveExportLeaseOwner(auditId, '1');
  await auditStore.acquireExportLease(auditId, snapshot.capability, { ownerId: `export:${auditId}:pending`, now: iso });
  const lease = { ownerId: leaseOwnerId, exportAttempt: 1, now: iso, ttlMs: 600_000,
    latestState: { auditId, exportStatus: 'running', exportRevision: snapshot.revision, exportAttempt: 1, leaseOwnerId } };
  await auditStore.claimExportLease(auditId, snapshot.capability, lease);
  await auditStore.beginExportDelivery(auditId, snapshot.capability, {
    ...lease, latestState: { ...lease.latestState, exportStatus: 'delivering' },
  });
  const env = defaultGraphFixture(null, { auditStore, enableReportLaunch: true, modelNow: () => iso });
  t.after(() => env.registration.dispose());
  const runtime = await env.registration.startupReady;
  assert.equal(Object.hasOwn(runtime, 'blobUrlPortBridge'), false);
  const documentId = 'blob-export-document'; const capability = 'B'.repeat(22);
  const url = env.chromeApi.runtime.getURL(`src/export/index.html?auditId=${auditId}`);
  env.sessionValues[`audita:export-launch:v1:${auditId}`] = {
    version: 1, auditId, sourceReviewSessionCapabilityId: 'R'.repeat(22), expectedRevision: snapshot.revision,
    attemptId: '1', tabId: 77, windowId: 9, path: '/src/export/index.html', documentId,
    state: 'connected', issuedAt: epoch, expiresAt: epoch + 900_000,
  };
  env.sessionValues[`audita:export-session:v1:${capability}`] = {
    version: 1, sessionCapabilityId: capability, auditId, launchTabId: 77, launchDocumentId: documentId,
    expectedRevision: snapshot.revision, attemptId: '1', intents: ['execute-export', 'complete-export'],
    state: 'active', issuedAt: epoch, expiresAt: epoch + 900_000,
  };
  env.setContext({ documentId, documentUrl: url, contextType: 'TAB', tabId: 77, windowId: 9, frameId: 0 });
  const from = { id: env.chromeApi.runtime.id, documentId, url, frameId: 0, tab: { id: 77, windowId: 9 } };
  const port = blobWiringPort(BLOB_URL_PORT_NAME, from);
  env.events.connect.emit(port); await tick();
  port.onMessage.emit({ type: 'hello', auditId, sessionCapabilityId: capability });
  await tick();
  assert.deepEqual(port.messages, [{ type: 'ready' }]);
  const blobUrl = `blob:chrome-extension://${env.chromeApi.runtime.id}/11111111-1111-4111-8111-111111111111`;
  port.onMessage.emit({ type: 'register', requestId: 1, blobUrl });
  for (let attempt = 0; attempt < 100 && port.messages.length < 2; attempt++) await tick();
  assert.deepEqual(port.messages.at(-1), { type: 'result', requestId: 1, ok: true });
  const rows = Object.entries(env.sessionValues).filter(([key]) => key.startsWith('audita:blob-url:v1:'));
  assert.equal(rows.length, 1); assert.equal(rows[0][1].auditId, auditId);
  assert.equal(rows[0][1].ownerDocumentId, documentId);
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

test('real default worker graph composes the native branded pixel commit clock into its starter', async () => {
  const env = defaultGraphFixture(null, { useNativePixelCommitClock: true });
  const runtime = await env.registration.startupReady;
  assert.equal(typeof runtime.auditStarter?.beginAuthorizedAudit, 'function');
  assert.equal(Object.hasOwn(runtime.auditStarter, 'pixelCommitClock'), false);
});

test('default runtime bootstraps the operational adapter through a trusted Chrome authority', async () => {
  const env = defaultGraphFixture(null, { useDefaultChromeAdapter: true });

  const runtime = await env.registration.startupReady;
  const created = await runtime.chromeAdapter.createTab({ active: false });
  await runtime.chromeAdapter.removeTab(created.id);

  assert.equal(created.id, 77);
  assert.deepEqual(env.createdTabs, [{ active: false }]);
});

test('current-page full-evidence pauses before raster when the inactive attached copy contains sensitive content', async () => {
  const documentTargets = [];
  const rawUrl = 'https://example.test/';
  let rasterCalls = 0;
  const scripting = {
    async executeScript(details) {
      const target = structuredClone(details.target);
      if (target.frameIds) {
        return [{ frameId: 0, documentId: 'document-a', result: rawUrl }];
      }
      if (target.allFrames === true) {
        return [
          { frameId: 0, documentId: 'document-a', result: null },
          { frameId: 7, documentId: 'document-child', result: null },
        ];
      }
      if (target.documentIds) {
        if (['probe', 'inspect', 'clear'].includes(details.args?.[0]?.op)) {
          return [{
            frameId: 0, documentId: 'document-a',
            result: { ok: true, present: false, mode: null },
          }];
        }
        documentTargets.push(target.documentIds);
        return target.documentIds.map((documentId, index) => ({
          frameId: documentId === 'document-a' ? 0 : 7,
          documentId,
          result: {
            password: documentId === 'document-child',
            otp: false,
            payment: false,
            privateMarker: false,
          },
        }));
      }
      throw new Error('unexpected script target');
    },
    async insertCSS() {},
    async removeCSS() {},
  };
  const env = defaultGraphFixture(null, {
    useDefaultChromeAdapter: true,
    scripting,
    modelNow: () => '2026-08-29T12:00:00.000Z',
  });
  const sendCommand = env.chromeApi.debugger.sendCommand;
  env.chromeApi.debugger.sendCommand = async (...args) => {
    const method = args[1];
    if (method === 'Page.captureScreenshot') {
      rasterCalls += 1;
      return { data: PNG };
    }
    if (method === 'Page.getFrameTree') {
      return { frameTree: { frame: { id: 'main', url: rawUrl } } };
    }
    if (method === 'DOMSnapshot.captureSnapshot') return { strings: [], documents: [] };
    if (method === 'Accessibility.getFullAXTree') return { nodes: [] };
    if (method === 'Page.getLayoutMetrics') {
      return { cssContentSize: { width: 800, height: 600 } };
    }
    if (method === 'Browser.getVersion') return { product: 'Chrome/152.0.0.0' };
    if (method === 'Runtime.evaluate') {
      return { result: { value: { width: 800, height: 600, deviceScaleFactor: 1 } } };
    }
    return sendCommand(...args);
  };
  const runtime = await env.registration.startupReady;
  env.setTabCreator((_options, callback) => callback?.({ id: 77, windowId: 9 }));
  const proof = await runtime.chromeAdapter.probeDocumentIdentity(17);
  const issuer = {
    type: 'extension-document', documentId: 'panel-document', path: '/src/panel/index.html',
  };
  const prepared = await runtime.authority.prepare({
    kind: 'attached', tabId: 17, windowId: 9, documentId: proof.documentId,
    initialUrlEvidence: rawUrl, initialUrlSessionDigest: proof.urlSessionDigest,
    createdBy: 'user', allowedIntent: 'start-audit', issuer,
  });
  const senderContext = {
    issuer, windowId: 9, tabId: null, contextType: 'SIDE_PANEL',
    documentUrl: `chrome-extension://${env.chromeApi.runtime.id}/src/panel/index.html?launch=${'L'.repeat(43)}`,
  };
  const policy = createCapturePolicyV1({ mode: 'full-evidence', includeQuery: false });
  const auditId = 'audit-iframe-password-consent';
  const started = await runtime.auditStarter.beginAuthorizedAudit({
    capabilityId: prepared.capabilityId, eventNonce: null, auditId, capturePolicy: policy,
    retentionPreference: { version: 1, deleteAfterCompleteExport: false }, senderContext,
  });
  assert.deepEqual(started.response, { ok: true, auditId, state: 'running' });
  assert.match(started.sessionCapabilityId, /^[A-Za-z0-9_-]{22}$/u);
  const completion = await started.completion;
  assert.deepEqual(completion, {
    ok: true, auditId, state: 'privacy-paused', revision: null,
  });
  assert.equal(rasterCalls, 0);
  assert.equal(documentTargets.length > 0, true);
});

test('default worker snapshots the current page and reauthorizes its removed copy as a view-only report source', async () => {
  const rawUrl = 'https://example.test/current?private=NEVER_PUBLIC';
  const auditId = 'audit-default-current-copy';
  const inventory = await createInstalledCoreRuleInventory();
  const draft = structuredClone(SAMPLE_AUDIT);
  draft.auditId = auditId;
  draft.integrity.canonicalModelHash = 'pending';
  draft.integrity.evidenceManifestHash = 'pending';
  const model = await enrichAuditForReport(draft, {
    now: () => '2026-08-29T12:00:00.000Z', timezone: 'America/Cuiaba',
    manifestVersion: '0.1.0', rulesVersion: inventory.rulesVersion,
    browserVersion: 'Chrome/147.0.0.0',
  });
  const checkpoint = {
    version: 1, auditId,
    pages: model.pages.map(page => ({
      pageId: page.pageId, attempted: page.attempted,
      startedAt: page.attempted ? page.timestamps.startedAt : null,
      rulesVersion: inventory.rulesVersion, inventoryVersion: inventory.inventoryVersion,
      inventoryHash: inventory.sha256, outcomes: [],
    })),
  };
  const auditStore = createInMemoryAuditStore();
  let epoch = 1_788_000_000_000;
  const scriptTargets = [];
  const execution = deferred();
  let executionArgs = null;
  const env = defaultGraphFixture(null, {
    auditStore,
    enableReportLaunch: true,
    epochNow: () => epoch++,
    useDefaultChromeAdapter: true,
    tabsQuery: async () => [{
      id: 17, windowId: 9, active: true, status: 'complete', url: rawUrl,
    }],
    scripting: {
      async executeScript(details) {
        scriptTargets.push(structuredClone(details.target));
        if (details.target?.frameIds?.[0] === 0) {
          return [{ frameId: 0, documentId: 'document-a', result: rawUrl }];
        }
        return [];
      },
      async insertCSS() {},
      async removeCSS() {},
    },
    async runUrlAuditExecution(args) {
      executionArgs = structuredClone({
        auditId: args.auditId,
        ownershipId: args.ownershipId,
        windowId: args.windowId,
        navigationToken: args.navigationToken,
        navigationPurpose: args.navigationPurpose,
        evidenceUrl: args.evidenceUrl,
        sessionDigest: args.sessionDigest,
      });
      await args.onCheckpoint(checkpoint);
      const observedTarget = Object.freeze({
        version: 'ObservedTargetV1', kind: 'owned-disposable', ownershipId: args.ownershipId,
        tabId: 27, windowId: 9, documentId: 'copy-document',
        urlEvidence: sanitizeEvidenceUrlV1('https://example.test/current', { includeQuery: false }),
        urlSessionDigest: `hmac-sha256:${'D'.repeat(43)}`,
        cleanupMode: 'always', pageId: 'page-1',
      });
      await args.persistAuditModel(model, observedTarget);
      execution.resolve();
      return Object.freeze({
        status: model.session.status, model, observedTarget,
        observationState: 'observed', ownershipState: 'removed',
      });
    },
  });
  env.chromeApi.tabs.get = async tabId => ({
    id: tabId, windowId: 9, active: true, status: 'complete', discarded: false, url: rawUrl,
  });
  const runtime = await env.registration.startupReady;
  const proof = await runtime.chromeAdapter.probeDocumentIdentity(17);
  const issuer = {
    type: 'extension-document', documentId: 'panel-document', path: '/src/panel/index.html',
  };
  const prepared = await runtime.authority.prepare({
    kind: 'attached', tabId: 17, windowId: 9, documentId: proof.documentId,
    initialUrlEvidence: sanitizeEvidenceUrlV1(rawUrl, { includeQuery: false }).href,
    initialUrlSessionDigest: proof.urlSessionDigest,
    createdBy: 'user', allowedIntent: 'start-audit', issuer,
  });
  const senderContext = {
    issuer, windowId: 9, tabId: null, contextType: 'SIDE_PANEL',
    documentUrl: `chrome-extension://${env.chromeApi.runtime.id}/src/panel/index.html?launch=${'L'.repeat(43)}`,
  };
  const started = await runtime.auditStarter.beginAuthorizedAudit({
    capabilityId: prepared.capabilityId, eventNonce: null, auditId,
    capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    retentionPreference: { version: 1, deleteAfterCompleteExport: false },
    senderContext,
  });
  assert.deepEqual(started.response, { ok: true, auditId, state: 'running' });
  await execution.promise;
  assert.deepEqual(await started.completion, {
    ok: true, auditId, state: 'result', revision: 1,
  });
  assert.equal(executionArgs.navigationPurpose, 'attached-copy');
  assert.equal(executionArgs.windowId, 9);
  assert.match(executionArgs.ownershipId, /^owner_[A-Za-z0-9_-]{22}$/u);
  assert.match(executionArgs.navigationToken, /^[A-Za-z0-9_-]{22}$/u);
  assert.equal(executionArgs.evidenceUrl.queryIncluded, false);
  assert.equal(executionArgs.evidenceUrl.href, 'https://example.test/current');
  assert.doesNotMatch(JSON.stringify(executionArgs), /NEVER_PUBLIC/u);
  assert.equal(env.createdTabs.length, 0);
  assert.equal(scriptTargets.every(target => target.tabId === 17 && target.frameIds?.[0] === 0), true);

  const opening = runtime.reportLaunch.openRegisteredReport({
    auditId, windowId: 9,
    sourceSessionCapabilityId: started.sessionCapabilityId,
    sourceSessionState: 'result',
  });
  for (let attempt = 0; attempt < 20 && !env.sessionValues[`audita:report-launch:v1:${auditId}`]; attempt += 1) {
    await tick();
  }
  const { connected } = await env.connectReport(auditId, { preserveLaunch: true });
  assert.equal((await opening).ok, true);
  assert.equal(connected.state, 'view-only');
  assert.doesNotMatch(JSON.stringify(connected), /NEVER_PUBLIC|owner_|hmac-sha256/iu);
});

test('default worker keeps the volatile vault closed while injecting the one digest manager by factories', async () => {
  const captured = {};
  const env = defaultGraphFixture(null, {
    chromeAdapterFactory(_chromeApi, { sessionUrlDigestManager }) {
      captured.adapterDigestManager = sessionUrlDigestManager;
      return Object.freeze({
        async probeDocumentIdentity() { throw new Error('not used'); },
        async probeSensitiveCaptureSignals() {
          return Object.freeze({
            version: 'SensitiveCaptureSignalsV1', detected: false, categories: Object.freeze([]),
          });
        },
        async getEvidenceUrl() { throw new Error('not used'); },
        async getFinalUrl() { return 'https://example.test/'; },
        async proveHighlightTargets() { return []; },
        async verifyHighlightTarget() { return { ok: false, reason: 'live-proof-failed' }; },
        async injectHighlight() { return { ok: false, reason: 'execution-failed' }; },
        async emitProgress() {},
      });
    },
    rawNavigationVaultFactory(input) {
      captured.vaultInput = input;
      captured.vault = createRawNavigationVaultV1(input);
      return captured.vault;
    },
  });
  const runtime = await env.registration.startupReady;
  assert.equal(Object.hasOwn(runtime, 'digestManager'), false);
  assert.equal(Object.hasOwn(runtime, 'rawNavigationVault'), false);
  assert.equal(captured.vaultInput.digestManager, captured.adapterDigestManager);
  const sessionScansBefore = env.sessionGetCalls.filter(key => key === null).length;
  const [digest, issued] = await Promise.all([
    captured.adapterDigestManager.digest('https://example.test/shared?private=1'),
    captured.vault.put('https://example.test/shared?private=1', {
      auditId: 'audit-vault', purpose: 'single-url', ttlMs: 600_000, includeQuery: false,
    }),
  ]);
  assert.equal(issued.sessionDigest, digest);
  assert.deepEqual(Object.keys(env.sessionValues).filter(key => key === 'audita:session-hmac-key:v1'), [
    'audita:session-hmac-key:v1',
  ]);
  assert.equal(env.sessionGetCalls.filter(key => key === null).length, sessionScansBefore,
    'the vault has no session-wide scan during put');
});

test('default worker exposes the tokenized single-URL capability only through its Side Panel Port', async () => {
  const env = defaultGraphFixture(null, {
    tabsQuery: async () => [{
      id: 17, windowId: 9, active: true, status: 'complete', url: 'https://example.test/',
    }],
  });
  const panel = await env.connectPanel();

  const prepared = await panel.request({
    type: 'PREPARE_PANEL_NAVIGATION_CAPABILITY',
    requestId: 'single-url-default-worker',
    intent: 'single',
  });

  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  assert.equal(prepared.requestId, 'single-url-default-worker');
  assert.match(prepared.capabilityId, /^[A-Za-z0-9_-]{22}$/u);
});

test('R3-E terminal commit schedules retention without holding the starter lock or blocking its result and report', async t => {
  const auditId = 'audit-worker-batch';
  const report = await batchReportFixture(auditId);
  const realStore = createInMemoryAuditStore();
  const schedulingGate = deferred();
  let schedulingPending = false;
  const auditStore = {
    ...realStore,
    async nextExpiresAtV1() {
      if (await realStore.getReportRevision(auditId)) {
        schedulingPending = true;
        await schedulingGate.promise;
      }
      return realStore.nextExpiresAtV1();
    },
  };
  let executorDependencies = null;
  let executorArgs = null;
  const executionSettled = deferred();
  let randomSeed = 0;
  const env = defaultGraphFixture(null, {
    auditStore,
    enableReportLaunch: true,
    createAuditId: () => auditId,
    randomBytes: length => new Uint8Array(length).fill(++randomSeed),
    tabsQuery: async () => [{
      id: 17, windowId: 9, active: true, status: 'complete', url: 'https://example.test/',
    }],
    batchAuditExecutionFactory(dependencies) {
      executorDependencies = dependencies;
      return Object.freeze({
        async run(args) {
          executorArgs = args;
          await args.onExecutionCheckpoint(report.checkpoint);
          executionSettled.resolve();
          return Object.freeze({ model: report.model, checkpoint: report.checkpoint });
        },
        async cleanup() { return true; },
        async clearProgress() { return true; },
        async discardProgress() { throw new Error('COMMITTED_RESULT_MUST_NOT_BE_DISCARDED'); },
      });
    },
  });
  t.after(() => { schedulingGate.resolve(); env.registration.dispose(); });
  const panel = await env.connectPanel();
  const prepared = await panel.request({
    type: 'PREPARE_PANEL_NAVIGATION_CAPABILITY', requestId: 'batch-result', intent: 'batch',
  });
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  const started = await panel.request({
    type: 'PANEL_START_BATCH_AUDIT', capabilityId: prepared.capabilityId,
    urls: 'https://one.example.test/private?token=never-public\nhttps://two.example.test/',
    captureMode: 'no-pixels', includeQuery: false, deleteAfterCompleteExport: false,
  });
  assert.deepEqual(started, { ok: true, auditId, state: 'running', total: 2, warnings: [] }, JSON.stringify({
    started, sessionValues: env.sessionValues, panelMessages: panel.port.messages,
  }));
  await executionSettled.promise;
  let revision = null;
  for (let attempt = 0; attempt < 200 && revision === null; attempt += 1) {
    await tick();
    revision = await auditStore.getReportRevision(auditId);
  }
  assert.equal(revision?.modelRevision, 1);
  assert.equal(revision.model.requestedScope.mode, 'batch');
  assert.equal(revision.model.pages.length, 2);
  assert.equal(executorArgs.acceptedCount, 2);
  assert.equal(typeof executorArgs.now, 'function');
  assert.equal(typeof executorArgs.onExecutionCheckpoint, 'function');
  assert.equal(executorArgs.reportOptions.expectedExtensionId, env.chromeApi.runtime.id);
  assert.equal(typeof executorDependencies.runUrlAuditExecution, 'function');
  assert.equal(typeof executorDependencies.readBatchCorrelation, 'function');
  assert.doesNotMatch(JSON.stringify({ started, revision }), /never-public|token=/iu);

  let resultPacket = null;
  for (let attempt = 0; attempt < 200 && resultPacket === null; attempt += 1) {
    await tick();
    resultPacket = panel.port.messages.find(value =>
      value.type === 'bootstrap-result' && value.state === 'result' && value.auditId === auditId) ?? null;
  }
  assert.equal(Boolean(resultPacket?.result), true, JSON.stringify(panel.port.messages));
  const opening = panel.request({
    type: 'PANEL_OPEN_REPORT', auditId, sessionCapabilityId: resultPacket.sessionCapabilityId,
  }).catch(error => error);
  const launchKey = `audita:report-launch:v1:${auditId}`;
  for (let attempt = 0; attempt < 20 && !env.sessionValues[launchKey]; attempt += 1) await tick();
  assert.equal(Boolean(env.sessionValues[launchKey]), true);
  const { connected } = await env.connectReport(auditId, { preserveLaunch: true });
  const opened = await opening;
  assert.match(connected.sessionCapabilityId ?? '', /^[A-Za-z0-9_-]{22}$/u);
  assert.equal(connected.state, 'view-only');
  assert.equal(opened.ok, true, JSON.stringify(opened));
  assert.equal(schedulingPending, true, 'the real terminal path must request expiry scheduling');
  assert.equal((await auditStore.getLatest()).auditId, auditId);
  schedulingGate.resolve();
  await tick();
  assert.equal((await env.chromeApi.alarms.get(RETENTION_ALARM_NAME))?.scheduledTime,
    Date.parse('2026-09-28T12:00:00.000Z'));
});

test('default worker cancellation removes persisted batch child pixels before clearing ACTIVE', async () => {
  const auditId = 'audit-worker-cancel-progress';
  const progress = new Map();
  const entered = deferred();
  let resourcesCleared = false;
  let randomSeed = 0;
  const env = defaultGraphFixture(null, {
    auditStore: createInMemoryAuditStore(),
    createAuditId: () => auditId,
    randomBytes: length => new Uint8Array(length).fill(++randomSeed),
    tabsQuery: async () => [{
      id: 17, windowId: 9, active: true, status: 'complete', url: 'https://example.test/',
    }],
    batchAuditExecutionFactory() {
      return Object.freeze({
        async run({ signal }) {
          progress.set(auditId, structuredClone(SAMPLE_AUDIT));
          entered.resolve();
          await new Promise((resolve, reject) => {
            if (signal.aborted) reject(signal.reason);
            else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        },
        async cleanup() { resourcesCleared = true; return true; },
        async clearProgress() { throw new Error('COMMITTED_RESULT_CLEAR_MUST_NOT_RUN'); },
        async discardProgress(request) {
          assert.deepEqual(request, { auditId });
          assert.equal(resourcesCleared, true);
          assert.equal(env.sessionValues[ACTIVE_AUDIT_JOB_KEY]?.auditId, auditId);
          progress.delete(request.auditId);
          return true;
        },
      });
    },
  });
  const panel = await env.connectPanel();
  const prepared = await panel.request({
    type: 'PREPARE_PANEL_NAVIGATION_CAPABILITY', requestId: 'batch-cancel', intent: 'batch',
  });
  assert.equal(prepared.ok, true);
  const started = await panel.request({
    type: 'PANEL_START_BATCH_AUDIT', capabilityId: prepared.capabilityId,
    urls: 'https://one.example.test/\nhttps://two.example.test/',
    captureMode: 'no-pixels', includeQuery: false, deleteAfterCompleteExport: false,
  });
  assert.equal(started.ok, true);
  await entered.promise;
  assert.equal(progress.has(auditId), true);
  const active = env.sessionValues[ACTIVE_AUDIT_JOB_KEY];
  const cancelled = await panel.request({
    type: 'PANEL_CANCEL_AUDIT', auditId, sessionCapabilityId: active.sessionCapabilityId,
  });
  assert.equal(cancelled.ok, true);
  for (let attempt = 0; attempt < 100 && env.sessionValues[ACTIVE_AUDIT_JOB_KEY]; attempt += 1) await tick();
  assert.equal(progress.has(auditId), false);
  assert.equal(Object.hasOwn(env.sessionValues, ACTIVE_AUDIT_JOB_KEY), false);
});

test('default worker carries one tokenized URL from the Side Panel to a persisted result without public secrets', async () => {
  const auditId = 'audit-worker-single-url';
  const inventory = await createInstalledCoreRuleInventory();
  const draft = structuredClone(SAMPLE_AUDIT);
  draft.auditId = auditId;
  draft.integrity.canonicalModelHash = 'pending';
  draft.integrity.evidenceManifestHash = 'pending';
  const model = await enrichAuditForReport(draft, {
    now: () => '2026-08-29T12:00:00.000Z', timezone: 'America/Cuiaba',
    manifestVersion: '0.1.0', rulesVersion: inventory.rulesVersion,
    browserVersion: 'Chrome/147.0.0.0',
  });
  const checkpoint = {
    version: 1,
    auditId,
    pages: model.pages.map(page => ({
      pageId: page.pageId,
      attempted: page.attempted,
      startedAt: page.attempted ? page.timestamps.startedAt : null,
      rulesVersion: inventory.rulesVersion,
      inventoryVersion: inventory.inventoryVersion,
      inventoryHash: inventory.sha256,
      outcomes: [],
    })),
  };
  const auditStore = createInMemoryAuditStore();
  let executionFailure = null;
  const executionSettled = deferred();
  const env = defaultGraphFixture(null, {
    auditStore,
    enableReportLaunch: true,
    createAuditId: () => auditId,
    tabsQuery: async () => [{
      id: 17, windowId: 9, active: true, status: 'complete', url: 'https://example.test/',
    }],
    async runUrlAuditExecution(args) {
      try {
        await args.onCheckpoint(checkpoint);
        const observedTarget = Object.freeze({
          version: 'ObservedTargetV1', kind: 'owned-disposable', ownershipId: args.ownershipId,
          tabId: 27, windowId: 9, documentId: 'single-url-document',
          urlEvidence: sanitizeEvidenceUrlV1(model.finalUrl, { includeQuery: false }),
          urlSessionDigest: `hmac-sha256:${'D'.repeat(43)}`,
          cleanupMode: 'pre-observation-failure', pageId: 'page-1',
        });
        await args.persistAuditModel(model, observedTarget);
        const output = Object.freeze({
          status: 'partial', model, observedTarget,
          observationState: 'observed', ownershipState: 'retained-for-review',
        });
        executionSettled.resolve();
        return output;
      } catch (error) {
        executionFailure = error;
        executionSettled.resolve();
        throw error;
      }
    },
  });
  const panel = await env.connectPanel();
  const prepared = await panel.request({
    type: 'PREPARE_PANEL_NAVIGATION_CAPABILITY', requestId: 'single-url-result', intent: 'single',
  });
  assert.equal(prepared.ok, true, JSON.stringify(prepared));

  const started = await panel.request({
    type: 'PANEL_START_URL_AUDIT', capabilityId: prepared.capabilityId,
    url: 'https://servico.exemplo.test/consulta?private-token=never-public',
    captureMode: 'no-pixels', includeQuery: false, deleteAfterCompleteExport: false,
  });
  assert.deepEqual(started, { ok: true, auditId, state: 'running' });
  await executionSettled.promise;

  let revision = null;
  for (let attempt = 0; attempt < 200 && revision === null; attempt += 1) {
    await tick();
    revision = await auditStore.getReportRevision(auditId);
  }
  assert.equal(executionFailure, null, executionFailure?.stack ?? executionFailure?.message);
  assert.equal(revision?.modelRevision, 1, JSON.stringify({
    revision, executionFailure: executionFailure?.message ?? null,
    messages: panel.port.messages,
    sessionKeys: Object.keys(env.sessionValues),
  }));
  let resultPacket = null;
  for (let attempt = 0; attempt < 200 && resultPacket === null; attempt += 1) {
    await tick();
    resultPacket = panel.port.messages.find(value =>
      value.type === 'bootstrap-result' && value.state === 'result' && value.auditId === auditId) ?? null;
  }
  assert.equal(Boolean(resultPacket?.result), true, JSON.stringify(panel.port.messages));
  const publicText = JSON.stringify({ packets: panel.port.messages, latest: await auditStore.getLatest() });
  assert.doesNotMatch(publicText, /private-token|owner_|hmac-sha256|navigationToken|sessionDigest|ownershipId/iu);

  const opening = panel.request({
    type: 'PANEL_OPEN_REPORT', auditId, sessionCapabilityId: resultPacket.sessionCapabilityId,
  }).catch(error => error);
  const launchKey = `audita:report-launch:v1:${auditId}`;
  for (let attempt = 0; attempt < 20 && !env.sessionValues[launchKey]; attempt += 1) await tick();
  assert.equal(Boolean(env.sessionValues[launchKey]), true);
  const { connected } = await env.connectReport(auditId, { preserveLaunch: true });
  const opened = await opening;
  assert.match(connected.sessionCapabilityId ?? '', /^[A-Za-z0-9_-]{22}$/u);
  assert.equal(connected.state, 'view-only');
  assert.equal(opened.ok, true, JSON.stringify(opened));
});

test('default graph rearms its singleton pixel scheduler after unified paused cleanup', async () => {
  const schedules = [];
  let durablePixelState = null;
  const env = defaultGraphFixture(null, {
    chromeAdapter: {
      async probeDocumentIdentity(tabId) {
        return {
          tabId, windowId: 9, documentId: 'document-a',
          urlSessionDigest: `hmac-sha256:${'A'.repeat(43)}`,
        };
      },
    },
    pixelConsentSchedulerFactory(_chromeApi, dependencies) {
      durablePixelState = dependencies.pixelState;
      return Object.freeze({
        async recoverOnStartup() { return true; },
        async run() { return true; },
        async scheduleNext() { schedules.push('schedule'); return true; },
        dispose() {},
      });
    },
  });
  const runtime = await env.registration.startupReady;
  const digest = `hmac-sha256:${'A'.repeat(43)}`;
  const issuer = {
    type: 'extension-document', documentId: 'panel-document', path: '/src/panel/index.html',
  };
  const prepared = await runtime.authority.prepare({
    kind: 'attached', tabId: 17, windowId: 9, documentId: 'document-a',
    initialUrlEvidence: 'https://example.test/', initialUrlSessionDigest: digest,
    createdBy: 'user', allowedIntent: 'start-audit', issuer,
  });
  const claimed = await runtime.authority.claimAndIssueAuditSession({
    capabilityId: prepared.capabilityId, auditId: 'audit-scheduler-rearm', mode: 'attached',
    allowedIntent: 'start-audit',
    senderContext: {
      issuer, windowId: 9, tabId: null, contextType: 'SIDE_PANEL',
      documentUrl: `chrome-extension://${env.chromeApi.runtime.id}/src/panel/index.html?launch=${'L'.repeat(43)}`,
    },
  });
  assert.equal(claimed.ok, true);
  const policy = createCapturePolicyV1({ mode: 'full-evidence', includeQuery: false });
  const paused = await durablePixelState.pause({
    auditId: 'audit-scheduler-rearm',
    observedTarget: {
      version: 'ObservedTargetV1', kind: 'attached', tabId: 17, windowId: 9,
      documentId: 'document-a',
      urlEvidence: sanitizeEvidenceUrlV1('https://example.test/', { includeQuery: false }),
      urlSessionDigest: digest,
    },
    mode: 'full-evidence', capturePolicy: policy, categories: ['password'],
    authorityExpiresAt: 1_788_000_600_000,
  });
  assert.equal((await runtime.authority.transitionAuditSession({
    sessionCapabilityId: claimed.sessionCapabilityId,
    auditId: 'audit-scheduler-rearm', nextState: 'privacy-paused',
  })).ok, true);
  env.sessionValues[ACTIVE_AUDIT_JOB_KEY] = {
    version: 1, auditId: 'audit-scheduler-rearm', capabilityId: prepared.capabilityId,
    sessionCapabilityId: claimed.sessionCapabilityId, windowId: 9, mode: 'attached',
    state: 'privacy-paused', commitState: 'none', expectedTerminalRevision: null,
    createdAt: 1_788_000_000_000, updatedAt: 1_788_000_000_000,
  };

  const result = await runtime.auditStarter.abortAttachedAuditForTarget({
    tabId: 17, windowId: null, reasonCode: 'TAB_DISCARDED',
  });
  assert.deepEqual(result, {
    handled: true, liquidated: true, aborted: true, auditId: 'audit-scheduler-rearm',
  });
  assert.equal(await durablePixelState.readSuspension('audit-scheduler-rearm'), null);
  assert.equal(schedules.length >= 1, true);
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
    ['clear', 1, PIXEL_CONSENT_ALARM_NAME],
    ['clear', 1, HIGHLIGHT_EXPIRY_ALARM_NAME],
    ['clear', 1, PERSONA_EXPIRY_ALARM_NAME],
    ['clear', 1, RETENTION_ALARM_NAME],
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
    ['clear', 1, PIXEL_CONSENT_ALARM_NAME],
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

  env.allowSessionScan();
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
