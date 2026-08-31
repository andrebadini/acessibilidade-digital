import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ACTIVE_AUDIT_JOB_KEY,
  createAuthorizedAuditStarter,
  executionCheckpointStorageKey,
  readActiveAuditJobForWorker,
  retentionPreferenceStorageKey,
} from '../../src/background/authorized-audit-starter.js';
import { AUDIT_EXECUTION_INTERNAL } from '../../src/background/chrome-adapter.js';
import { runAttachedAuditExecution, runAudit } from '../../src/background/run-audit.js';
import { createPanelPortCoordinator, panelBootstrapStorageKey } from '../../src/background/panel-port.js';
import { createTargetOperationQueue } from '../../src/background/target-operation-queue.js';
import {
  createTargetCapabilityAuthority,
  readAttachedAuditCorrelationForRecovery,
  readAuditSessionForWorker,
  targetCapabilityStorageKey,
} from '../../src/background/target-capabilities.js';
import { createCapturePolicyV1 } from '../../src/core/privacy/capture-policy.js';
import { createInstalledCoreRuleInventory } from '../../src/core/rules/core-rule-inventory.js';
import { enrichAuditForReport } from '../../src/core/report/enrich-audit.js';
import { createAuditModel } from '../../src/core/report/audit-model.js';
import { createPanelResultBundleV1 } from '../../src/panel/panel-result-bundle.js';
import { AXE_PROVENANCE } from '../../src/browser/axe-adapter.js';
import { createPixelCaptureStateV1 } from '../../src/background/pixel-capture-consent.js';
import { createInMemoryAuditStore } from '../../src/storage/audit-store.js';
import { sanitizeEvidenceUrlV1 } from '../../src/core/privacy/evidence-url.js';
import { SAMPLE_AUDIT } from '../../fixtures/audits/sample-audit.js';
import { reportInput } from '../report/helpers.js';

const DIGEST = `hmac-sha256:${'A'.repeat(43)}`;
const EPOCH = 1_788_000_000_000;
const START_JOURNAL_KEY = 'audita:start-journal:v1';
const PANEL_URL = `chrome-extension://abcdefghijklmnopabcdefghijklmnop/src/panel/index.html?launch=${'L'.repeat(43)}`;

function sessionArea() {
  const values = Object.create(null);
  return {
    values,
    async get(key) {
      if (key === null) return structuredClone(values);
      if (Array.isArray(key)) return Object.fromEntries(key.filter(name => Object.hasOwn(values, name)).map(name => [name, structuredClone(values[name])]));
      return Object.hasOwn(values, key) ? { [key]: structuredClone(values[key]) } : {};
    },
    async set(entries) { Object.assign(values, structuredClone(entries)); },
    async remove(key) {
      for (const name of Array.isArray(key) ? key : [key]) delete values[name];
    },
  };
}

async function failedAudit(auditId) {
  const internalValues = {};
  const adapter = {
    async createTab() { return { id: 42, windowId: 9 }; },
    async navigateTab() {},
    async waitForStable() { return { url: 'https://example.test/' }; },
    async probeDocumentIdentity(tabId) {
      return { tabId, windowId: 9, documentId: 'document-a', urlSessionDigest: DIGEST };
    },
    async getEvidenceUrl() { return 'https://example.test/'; },
    async connectCdp() {
      return {
        async command() {
          return {
            cssContentSize: { width: 800, height: 600 },
            cssLayoutViewport: { clientWidth: 800, clientHeight: 600 },
          };
        },
        async disconnect() {},
      };
    },
    async runAxeInTab() {
      return {
        status: 'disabled', provenance: AXE_PROVENANCE, frames: [],
        diagnostics: [{ code: 'AXE_FEATURE_DISABLED', frameId: null }],
      };
    },
    async getEnvironment() {
      return { chromeVersion: 'Chrome/147.0.0.0', viewport: { width: 800, height: 600, deviceScaleFactor: 1 } };
    },
    async collectPage() { throw new Error('structural collection failure'); },
    async removeTab() {},
  };
  Object.defineProperty(adapter, AUDIT_EXECUTION_INTERNAL, {
    value: Object.freeze({
      sessionArea: {
        async get(key) { return Object.hasOwn(internalValues, key) ? { [key]: structuredClone(internalValues[key]) } : {}; },
        async set(entries) { Object.assign(internalValues, structuredClone(entries)); },
        async remove(key) { delete internalValues[key]; },
      },
      randomBytes(length) { return new Uint8Array(length).fill(11); },
      capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    }),
  });
  return runAudit({
    url: 'https://example.test/', chromeAdapter: adapter,
    now: () => '2026-08-29T11:59:00.000Z', idFactory: () => auditId,
  });
}

function failedAttachedChromeAdapter() {
  return Object.freeze({
    async probeDocumentIdentity(tabId) {
      return { tabId, windowId: 9, documentId: 'document-a', urlSessionDigest: DIGEST };
    },
    async connectCdp() {
      return Object.freeze({
        async command() {
          return {
            cssContentSize: { width: 800, height: 600 },
            cssLayoutViewport: { clientWidth: 800, clientHeight: 600 },
          };
        },
        async disconnect() {},
      });
    },
    async runAxeInTab() {
      return {
        status: 'disabled', provenance: AXE_PROVENANCE, frames: [],
        diagnostics: [{ code: 'AXE_FEATURE_DISABLED', frameId: null }],
      };
    },
    async getEnvironment() {
      return { chromeVersion: 'Chrome/147.0.0.0', viewport: { width: 800, height: 600, deviceScaleFactor: 1 } };
    },
    async collectPage() { throw new Error('structural collection failure'); },
  });
}

async function reportFixture(auditId, status = 'partial') {
  const draft = status === 'failed'
    ? await failedAudit(auditId)
    : status === 'cancelled' ? createAuditModel(reportInput({
        auditId,
        session: {
          status: 'cancelled', partial: false,
          diagnostics: [{
            code: 'NAVIGATION_FAILED', message: 'A auditoria foi cancelada.',
            at: '2026-08-26T14:00:30.000Z', recoverable: false,
          }],
        },
      })) : structuredClone(SAMPLE_AUDIT);
  if (!['cancelled', 'failed'].includes(status)) {
    draft.auditId = auditId;
    draft.session.status = status;
    draft.session.partial = status === 'partial';
    draft.integrity.canonicalModelHash = 'pending';
    draft.integrity.evidenceManifestHash = 'pending';
  }
  const model = await enrichAuditForReport(draft, {
    now: () => '2026-08-29T12:00:00.000Z', timezone: 'America/Cuiaba',
    manifestVersion: '0.1.0', rulesVersion: '1.0.0', browserVersion: 'Chrome/147.0.0.0',
  });
  const inventory = await createInstalledCoreRuleInventory();
  const checkpoint = {
    version: 1, auditId,
    pages: model.pages.map(page => ({
      pageId: page.pageId, attempted: page.attempted,
      startedAt: page.attempted ? page.timestamps.startedAt : null,
      rulesVersion: inventory.rulesVersion, inventoryVersion: inventory.inventoryVersion,
      inventoryHash: inventory.sha256, outcomes: [],
    })),
  };
  return { model, checkpoint, inventory };
}

async function authorityFixture(area, windowId = 9) {
  let random = 0;
  const authority = createTargetCapabilityAuthority({
    chromeApi: { runtime: { id: 'abcdefghijklmnopabcdefghijklmnop' } },
    sessionArea: area, now: () => EPOCH, randomBytes: length => new Uint8Array(length).fill(++random),
    probeDocument: async tabId => ({ tabId, windowId, documentId: 'document-a', urlSessionDigest: DIGEST }),
  });
  const prepared = await authority.prepare({
    kind: 'attached', tabId: 17, windowId, documentId: 'document-a',
    initialUrlEvidence: 'https://example.test/', initialUrlSessionDigest: DIGEST,
    createdBy: 'user', allowedIntent: 'start-audit',
    issuer: { type: 'extension-document', documentId: 'panel-doc', path: '/src/panel/index.html' },
  });
  const senderContext = {
    issuer: { type: 'extension-document', documentId: 'panel-doc', path: '/src/panel/index.html' },
    windowId, tabId: null, contextType: 'SIDE_PANEL',
    documentUrl: PANEL_URL,
  };
  return { authority, capabilityId: prepared.capabilityId, senderContext };
}

function panelCoordinator(order = [], overrides = {}) {
  const scope = Object.freeze({
    async registerPendingBootstrap(value) { order.push('bootstrap-register'); assert.equal(value.windowId >= 0, true); return true; },
    async publishRegisteredBootstrap(value) { order.push('bootstrap'); assert.equal(value.windowId >= 0, true); return true; },
    async publishResult(value) { order.push(`publish:${value.state}`); return true; },
    async publishPrivacyPaused(value) { order.push(`publish:${value.state ?? 'privacy-paused'}`); return true; },
    async publishRunningResume() { order.push('publish:running-resume'); return true; },
    async registerAndPublishViewOnly() { return { registered: true, delivered: false }; },
    async disconnectSession() { order.push('disconnect'); return true; },
    ...overrides,
  });
  return Object.freeze({
    attachPanelPort() { return true; },
    async withWindowLock(windowId, fn) {
      order.push(`window:${windowId}:enter`);
      const value = await fn(scope);
      order.push(`window:${windowId}:leave`);
      return value;
    },
  });
}

function durablePanelCoordinator({ area, pixelState, epochNow = () => EPOCH + 3 }) {
  const coordinator = createPanelPortCoordinator({
    chromeApi: { runtime: { id: 'abcdefghijklmnopabcdefghijklmnop' } },
    sessionArea: area,
    readActiveJob: () => readActiveAuditJobForWorker({ sessionArea: area }),
    readAuditSession: ({ sessionCapabilityId, auditId }) => readAuditSessionForWorker({
      sessionArea: area, sessionCapabilityId, auditId,
    }),
    readPixelSuspension: auditId => pixelState.readSuspension(auditId),
    async loadPanelResultBundle() { return null; },
    async rehydrateViewOnly() { return null; },
    async revokeViewOnly() { return false; },
    epochNow,
    setTimer() { return Object.freeze({}); },
    clearTimer() {},
    launchAuthority: {
      async admitPort() { return Object.freeze({ ok: false, code: 'PANEL_LAUNCH_DENIED' }); },
      async reprove() { return Object.freeze({ ok: false, code: 'PANEL_LAUNCH_DENIED' }); },
      async revoke() { return Object.freeze({ ok: true, revoked: true }); },
    },
    async dispatchPanelIntent() { return Object.freeze({ ok: false, code: 'FEATURE_UNAVAILABLE' }); },
    async authorizeHighlightSession() { return Object.freeze({ ok: false }); },
  });
  return Object.freeze({
    attachPanelPort: coordinator.attachPanelPort,
    withWindowLock: coordinator.withWindowLock,
  });
}

function dependencyFixture({
  area,
  authority,
  execution,
  order = [],
  reportByAudit = new Map(),
  latest = { value: null },
  targetQueue = createTargetOperationQueue(),
  cleanupBarrier = null,
  pixelState = null,
  probeDocumentIdentity = async tabId => ({ tabId, windowId: 9, documentId: 'document-a', urlSessionDigest: DIGEST }),
  probeSensitiveCaptureSignals = async () => ({ version: 'SensitiveCaptureSignalsV1', detected: false, categories: [] }),
}) {
  const barrier = cleanupBarrier ?? Object.freeze({
    async clearForAuditLocked({ target, lock }) {
      targetQueue.assertHeld(lock, target);
      return Object.freeze({ ok: true, state: 'clear' });
    },
  });
  const dependencies = {
    authority, sessionArea: area, panelCoordinator: panelCoordinator(order),
    targetQueue, cleanupBarrier: barrier,
    runAttachedAuditExecution: execution,
    async persistLatest({ state }) { order.push(`latest:${state.status}`); latest.value = structuredClone(state); return structuredClone(state); },
    async persistCheckpoint(value) {
      order.push('checkpoint');
      area.values[executionCheckpointStorageKey(value.auditId)] = structuredClone({ version: 1, ...value });
      return Object.freeze({ version: 1, ...structuredClone(value) });
    },
    async removeCheckpoint({ auditId, sessionCapabilityId, windowId }) {
      order.push('checkpoint-remove');
      const key = executionCheckpointStorageKey(auditId);
      const current = area.values[key];
      if (current && current.auditId === auditId && current.sessionCapabilityId === sessionCapabilityId && current.windowId === windowId) {
        delete area.values[key]; return Object.freeze({ removed: true });
      }
      return Object.freeze({ removed: false });
    },
    async commitTerminalAudit({ auditId, model, checkpoint, latestState, expectedRevision }) {
      order.push('commit');
      assert.equal(expectedRevision, 1);
      reportByAudit.set(auditId, Object.freeze({
        version: 1, auditId, modelRevision: 1, modelHash: model.integrity.canonicalModelHash, model, checkpoint,
      }));
      latest.value = structuredClone(latestState);
      return Object.freeze({ revision: 1, modelHash: model.integrity.canonicalModelHash });
    },
    async readAuditSnapshot({ auditId }) {
      return reportByAudit.has(auditId)
        ? { model: reportByAudit.get(auditId).model, revision: 1, capability: Object.freeze(Object.create(null)) }
        : { model: undefined, revision: 0, capability: null };
    },
    async readReportRevision({ auditId }) { return reportByAudit.get(auditId) ?? null; },
    async readLatest() { return structuredClone(latest.value); },
    async buildPanelResultBundle({ reportRevision }) {
      const fixture = reportByAudit.get(reportRevision.auditId);
      const inventory = fixture?.inventory ?? await createInstalledCoreRuleInventory();
      return createPanelResultBundleV1({ reportRevision, inventory });
    },
    async recordHighlightBinding() { return null; },
    epochNow: () => EPOCH + 1,
    modelNow: () => '2026-08-29T12:00:00.000Z',
    createAbortController: () => new AbortController(),
    pixelState: pixelState ?? Object.freeze({
      async pause() { throw new Error('PIXEL_STATE_MUST_NOT_BE_ACCESSED'); },
      async gateRunnerStart() { throw new Error('PIXEL_STATE_MUST_NOT_BE_ACCESSED'); },
      async readSuspension() { return null; },
      async claimAndBeginResume() { throw new Error('PIXEL_STATE_MUST_NOT_BE_ACCESSED'); },
      async markSessionRunning() { throw new Error('PIXEL_STATE_MUST_NOT_BE_ACCESSED'); },
      async finish() { throw new Error('PIXEL_STATE_MUST_NOT_BE_ACCESSED'); },
      async revokeAudit() { throw new Error('PIXEL_STATE_MUST_NOT_BE_ACCESSED'); },
    }),
    probeDocumentIdentity,
    probeSensitiveCaptureSignals,
    async schedulePixelExpiry() {},
  };
  dependencies.pixelAttemptLifecycle = {
    async prepareResume() { return Object.freeze(Object.create(null)); },
    async commitTerminal(value) {
      const { attemptHandle: _attemptHandle, ...terminal } = value;
      const committed = await dependencies.commitTerminalAudit(terminal);
      return Object.freeze({ revision: committed.revision, modelHash: committed.modelHash });
    },
    async classify() { return Object.freeze({ state: 'absent', handle: null }); },
    async cleanup() { return true; },
  };
  return dependencies;
}

function instrumentAuthority(authority, effects) {
  return Object.freeze({
    ...authority,
    async claimAndIssueAuditSession(args) {
      effects.claims += 1;
      return authority.claimAndIssueAuditSession(args);
    },
    async claimWorkerEventAndIssueAuditSession(args) {
      effects.claims += 1;
      return authority.claimWorkerEventAndIssueAuditSession(args);
    },
  });
}

function instrumentJournalStorage(area, createEnvelope = null) {
  const effects = { writes: 0, removals: 0 };
  const originalGet = area.get.bind(area);
  const originalSet = area.set.bind(area);
  const originalRemove = area.remove.bind(area);
  if (createEnvelope) {
    area.get = async key => key === START_JOURNAL_KEY ? createEnvelope() : originalGet(key);
  }
  area.set = async entries => {
    if (Object.hasOwn(entries, START_JOURNAL_KEY)) effects.writes += 1;
    return originalSet(entries);
  };
  area.remove = async key => {
    if ((Array.isArray(key) && key.includes(START_JOURNAL_KEY)) || key === START_JOURNAL_KEY) effects.removals += 1;
    return originalRemove(key);
  };
  return effects;
}

function malformedJournalEnvelopeCases(getterState) {
  const journal = {
    version: 1, capabilityId: 'A'.repeat(22), auditId: 'hostile-audit', windowId: 9,
    state: 'prepared', sessionCapabilityId: null, createdAt: EPOCH, updatedAt: EPOCH,
  };
  return [
    ['accessor', () => {
      const envelope = {};
      Object.defineProperty(envelope, START_JOURNAL_KEY, {
        enumerable: true,
        get() { getterState.calls += 1; return journal; },
      });
      return envelope;
    }],
    ['non-enumerable', () => {
      const envelope = {};
      Object.defineProperty(envelope, START_JOURNAL_KEY, { enumerable: false, value: journal });
      return envelope;
    }],
    ['symbol', () => ({ [START_JOURNAL_KEY]: journal, [Symbol('private')]: true })],
    ['extra key', () => ({ [START_JOURNAL_KEY]: journal, extra: true })],
    ['wrong key', () => ({ other: journal })],
    ['custom prototype', () => Object.assign(Object.create({ inherited: true }), { [START_JOURNAL_KEY]: journal })],
    ['explicit undefined', () => ({ [START_JOURNAL_KEY]: undefined })],
    ['defined invalid row', () => ({ [START_JOURNAL_KEY]: null })],
    ['array', () => []],
    ['primitive', () => 7],
    ['ownKeys failure', () => new Proxy({ [START_JOURNAL_KEY]: journal }, {
      ownKeys() { throw new Error('PRIVATE_OWN_KEYS_FAILURE'); },
    })],
    ['descriptor failure', () => new Proxy({ [START_JOURNAL_KEY]: journal }, {
      getOwnPropertyDescriptor() { throw new Error('PRIVATE_DESCRIPTOR_FAILURE'); },
    })],
  ];
}

function capturePolicyGateHarness() {
  const effects = [];
  const touched = name => (..._args) => { effects.push(name); };
  const inspected = async () => {
    effects.push('inspectPreparedAuditTarget');
    return { ok: false, target: null };
  };
  const dependencies = {
    authority: {
      claimAndIssueAuditSession: touched('claimAndIssueAuditSession/rng'),
      claimWorkerEventAndIssueAuditSession: touched('claimWorkerEventAndIssueAuditSession/rng'),
      inspectPreparedAuditTarget: inspected,
      transitionAuditSession: touched('transitionAuditSession'),
      invalidateCapability: touched('invalidateCapability'),
    },
    sessionArea: {
      get: touched('storage.get'),
      set: touched('storage.set'),
      remove: touched('storage.remove'),
    },
    panelCoordinator: {
      attachPanelPort: touched('attachPanelPort'),
      withWindowLock: touched('withWindowLock'),
    },
    targetQueue: {
      withTarget: touched('targetQueue.withTarget'),
      assertHeld: touched('targetQueue.assertHeld'),
    },
    cleanupBarrier: { clearForAuditLocked: touched('cleanupBarrier.clearForAuditLocked') },
    runAttachedAuditExecution: touched('runAttachedAuditExecution'),
    persistLatest: touched('persistLatest'),
    persistCheckpoint: touched('persistCheckpoint'),
    removeCheckpoint: touched('removeCheckpoint'),
    commitTerminalAudit: touched('commitTerminalAudit'),
    readAuditSnapshot: touched('readAuditSnapshot'),
    readReportRevision: touched('readReportRevision'),
    readLatest: touched('readLatest'),
    buildPanelResultBundle: touched('buildPanelResultBundle'),
    recordHighlightBinding: touched('recordHighlightBinding'),
    epochNow: touched('epochNow'),
    modelNow: touched('modelNow'),
    createAbortController: touched('createAbortController'),
    pixelState: {
      pause: touched('pixelState.pause'), gateRunnerStart: touched('pixelState.gateRunnerStart'),
      readSuspension: touched('pixelState.readSuspension'), claimAndBeginResume: touched('pixelState.claimAndBeginResume'),
      markSessionRunning: touched('pixelState.markSessionRunning'), finish: touched('pixelState.finish'),
      revokeAudit: touched('pixelState.revokeAudit'),
    },
    probeDocumentIdentity: touched('probeDocumentIdentity'),
    probeSensitiveCaptureSignals: touched('probeSensitiveCaptureSignals'),
    schedulePixelExpiry: touched('schedulePixelExpiry'),
    pixelAttemptLifecycle: {
      prepareResume: touched('pixelAttemptLifecycle.prepareResume'),
      commitTerminal: touched('pixelAttemptLifecycle.commitTerminal'),
      classify: touched('pixelAttemptLifecycle.classify'),
      cleanup: touched('pixelAttemptLifecycle.cleanup'),
    },
  };
  return { dependencies, effects };
}

test('admits every closed capture policy before target inspection without touching pixel state', async t => {
  const beginInput = (auditId, mode) => ({
    capabilityId: 'A'.repeat(22),
    eventNonce: null,
    auditId,
    capturePolicy: createCapturePolicyV1({ mode, includeQuery: false }),
    retentionPreference: { version: 1, deleteAfterCompleteExport: false },
    senderContext: {},
  });

  for (const mode of ['full-evidence', 'element-only', 'no-pixels']) {
    await t.test(mode, async () => {
      const { dependencies, effects } = capturePolicyGateHarness();
      const started = await createAuthorizedAuditStarter(dependencies).beginAuthorizedAudit(
        beginInput(`audit-policy-${mode}`, mode),
      );
      assert.deepEqual(started, {
        response: { ok: false, code: 'TARGET_UNAVAILABLE' },
        sessionCapabilityId: null,
        completion: null,
      });
      assert.deepEqual(effects, ['inspectPreparedAuditTarget']);
    });
  }
});

test('a sensitive pixel begin durably pauses only after journal and checkpoint are confirmed', async () => {
  const area = sessionArea();
  const prepared = await authorityFixture(area);
  const pixelState = createPixelCaptureStateV1({
    sessionArea: area, now: () => EPOCH + 2, randomBytes: length => new Uint8Array(length).fill(7),
  });
  const order = [];
  const fixture = await reportFixture('audit-pixel-paused');
  const dependencies = dependencyFixture({
    area, authority: prepared.authority, pixelState, order,
    execution: async args => {
      assert.equal(args.capturePolicy.mode, 'full-evidence');
      assert.ok(args.privacyGate);
      await args.onCheckpoint(fixture.checkpoint);
      const observedTarget = Object.freeze({
        version: 'ObservedTargetV1', kind: 'attached', tabId: 17, windowId: 9,
        documentId: 'document-a', urlEvidence: sanitizeEvidenceUrlV1('https://example.test/', { includeQuery: false }),
        urlSessionDigest: DIGEST,
      });
      const decision = await args.privacyGate.preflight({
        auditId: 'audit-pixel-paused', observedTarget, capturePolicy: args.capturePolicy,
        signals: Object.freeze({ version: 'SensitiveCaptureSignalsV1', detected: true, categories: Object.freeze(['password']) }),
      });
      return Object.freeze({
        version: 1, auditId: 'audit-pixel-paused', state: decision.status,
        failureCode: null, model: null, checkpoint: fixture.checkpoint,
      });
    },
  });
  const expirySchedules = [];
  dependencies.schedulePixelExpiry = async () => { expirySchedules.push('scheduled'); return true; };
  dependencies.panelCoordinator = durablePanelCoordinator({ area, pixelState });
  const starter = createAuthorizedAuditStarter(dependencies);
  const started = await starter.beginAuthorizedAudit({
    capabilityId: prepared.capabilityId, eventNonce: null, auditId: 'audit-pixel-paused',
    capturePolicy: createCapturePolicyV1({ mode: 'full-evidence', includeQuery: false }),
    retentionPreference: { version: 1, deleteAfterCompleteExport: false }, senderContext: prepared.senderContext,
  });

  assert.deepEqual(started.response, { ok: true, auditId: 'audit-pixel-paused', state: 'running' });
  assert.deepEqual(await started.completion, { ok: true, auditId: 'audit-pixel-paused', state: 'privacy-paused', revision: null });
  const active = await readActiveAuditJobForWorker({ sessionArea: area });
  const session = await readAuditSessionForWorker({
    sessionArea: area, sessionCapabilityId: started.sessionCapabilityId, auditId: 'audit-pixel-paused',
  });
  const suspension = await pixelState.readSuspension('audit-pixel-paused');
  assert.equal(active.state, 'privacy-paused');
  assert.equal(active.commitState, 'none');
  assert.equal(active.expectedTerminalRevision, null);
  assert.equal(session.state, 'privacy-paused');
  assert.equal(Object.hasOwn(area.values, START_JOURNAL_KEY), false);
  assert.equal(area.values[executionCheckpointStorageKey('audit-pixel-paused')].auditId, 'audit-pixel-paused');
  assert.deepEqual(expirySchedules, ['scheduled']);
  assert.equal(area.values[panelBootstrapStorageKey(9)].auditId, 'audit-pixel-paused');
});

test('resumes one paused pixel audit exactly once in the same target and finishes only after result publication', async () => {
  const area = sessionArea();
  const prepared = await authorityFixture(area);
  const durablePixelState = createPixelCaptureStateV1({
    sessionArea: area, now: (() => { let value = EPOCH + 2; return () => value++; })(),
    randomBytes: length => new Uint8Array(length).fill(8),
  });
  const pixelState = Object.freeze({
    ...durablePixelState,
    async finish(args) {
      await durablePixelState.finish(args);
      throw new Error('PRIVATE_FINISH_ACK_LOST');
    },
  });
  const auditId = 'audit-pixel-resume';
  const fixture = await reportFixture(auditId);
  const policy = createCapturePolicyV1({ mode: 'full-evidence', includeQuery: false });
  const signals = Object.freeze({ version: 'SensitiveCaptureSignalsV1', detected: true, categories: Object.freeze(['password']) });
  const observedTarget = Object.freeze({
    version: 'ObservedTargetV1', kind: 'attached', tabId: 17, windowId: 9, documentId: 'document-a',
    urlEvidence: sanitizeEvidenceUrlV1('https://example.test/', { includeQuery: false }), urlSessionDigest: DIGEST,
  });
  const order = [];
  let executions = 0;
  const execution = async args => {
    executions += 1;
    await args.onCheckpoint(fixture.checkpoint);
    const preflight = await args.privacyGate.preflight({
      auditId, observedTarget, capturePolicy: policy, signals,
    });
    if (executions === 1) {
      return Object.freeze({
        version: 1, auditId, state: preflight.status, failureCode: null, model: null, checkpoint: fixture.checkpoint,
      });
    }
    assert.equal(preflight.status, 'armed');
    const authorized = await args.privacyGate.authorizeFirstPixel({
      auditId, observedTarget, capturePolicy: policy,
      proof: { tabId: 17, windowId: 9, documentId: 'document-a', urlSessionDigest: DIGEST }, signals,
    });
    assert.equal(authorized.status, 'ready');
    await args.persistAuditModel(fixture.model);
    await args.privacyGate.afterPixels({ auditId, pixelStarted: true });
    return Object.freeze({
      version: 1, auditId, state: 'model', failureCode: null, model: fixture.model, checkpoint: fixture.checkpoint,
    });
  };
  const dependencies = dependencyFixture({
    area, authority: prepared.authority, pixelState, order, execution,
    probeDocumentIdentity: async tabId => ({ tabId, windowId: 9, documentId: 'document-a', urlSessionDigest: DIGEST }),
    probeSensitiveCaptureSignals: async () => signals,
  });
  const pixelAttemptCalls = [];
  const attemptHandle = Object.freeze(Object.create(null));
  dependencies.pixelAttemptLifecycle = Object.freeze({
    async prepareResume(value) { pixelAttemptCalls.push(['prepare', value]); return attemptHandle; },
    async commitTerminal(value) {
      pixelAttemptCalls.push(['commit', value.attemptHandle]);
      return dependencies.commitTerminalAudit(value);
    },
    async classify() { return Object.freeze({ state: 'absent', handle: null }); },
    async cleanup(value) { pixelAttemptCalls.push(['cleanup', value]); return true; },
  });
  dependencies.panelCoordinator = panelCoordinator(order, {
    async publishPrivacyPaused() { order.push('publish:privacy-paused'); return true; },
    async publishRunningResume() { order.push('publish:running-resume'); return true; },
    async publishResult() { order.push('publish:result'); return true; },
  });
  const starter = createAuthorizedAuditStarter(dependencies);
  const started = await starter.beginAuthorizedAudit({
    capabilityId: prepared.capabilityId, eventNonce: null, auditId, capturePolicy: policy,
    retentionPreference: { version: 1, deleteAfterCompleteExport: false }, senderContext: prepared.senderContext,
  });
  await started.completion;
  const paused = await durablePixelState.readSuspension(auditId);

  const recoveredStarter = createAuthorizedAuditStarter(dependencies);
  assert.deepEqual(await recoveredStarter.recoverAuthorizedAuditLifecycle(), {
    ok: true, state: 'privacy-paused', auditId, revision: null,
  });
  assert.equal((await readActiveAuditJobForWorker({ sessionArea: area })).state, 'privacy-paused');
  const resumedStarter = createAuthorizedAuditStarter(dependencies);
  const resumed = await resumedStarter.resumePrivacyPausedAudit({
    auditId, sessionCapabilityId: started.sessionCapabilityId, windowId: 9,
    consentId: paused.consentId, mode: 'full-evidence',
  });
  assert.deepEqual(resumed.response, { ok: true, auditId, state: 'running' });
  assert.equal(resumed.sessionCapabilityId, started.sessionCapabilityId);
  assert.deepEqual(await resumed.completion, { ok: true, auditId, state: 'result', revision: 1 });
  assert.equal(executions, 2);
  assert.equal(await durablePixelState.readSuspension(auditId), null);
  assert.ok(order.indexOf('publish:running-resume') < order.indexOf('publish:result'));
  assert.deepEqual(pixelAttemptCalls[0], ['prepare', {
    auditId, consentId: paused.consentId, pageId: null, ownershipId: null, expiresAt: paused.expiresAt,
  }]);
  assert.deepEqual(pixelAttemptCalls[1], ['commit', attemptHandle]);
  assert.deepEqual(pixelAttemptCalls[2], ['cleanup', {
    auditId, consentId: null, expected: 'post-finish',
  }]);

  const replay = await resumedStarter.resumePrivacyPausedAudit({
    auditId, sessionCapabilityId: started.sessionCapabilityId, windowId: 9,
    consentId: paused.consentId, mode: 'full-evidence',
  });
  assert.deepEqual(replay, {
    response: { ok: false, code: 'AUDIT_RESUME_DENIED' }, sessionCapabilityId: null, completion: null,
  });
  assert.equal(executions, 2);
});

async function pausedAuditHarness(auditId) {
  const area = sessionArea();
  const prepared = await authorityFixture(area);
  let currentAt = EPOCH + 2;
  let random = 8;
  const pixelState = createPixelCaptureStateV1({
    sessionArea: area, now: () => currentAt,
    randomBytes: length => new Uint8Array(length).fill(++random),
  });
  const fixture = await reportFixture(auditId);
  const policy = createCapturePolicyV1({ mode: 'full-evidence', includeQuery: false });
  const initialSignals = Object.freeze({
    version: 'SensitiveCaptureSignalsV1', detected: true, categories: Object.freeze(['password']),
  });
  const observedTarget = Object.freeze({
    version: 'ObservedTargetV1', kind: 'attached', tabId: 17, windowId: 9, documentId: 'document-a',
    urlEvidence: sanitizeEvidenceUrlV1('https://example.test/', { includeQuery: false }), urlSessionDigest: DIGEST,
  });
  let proof = { tabId: 17, windowId: 9, documentId: 'document-a', urlSessionDigest: DIGEST };
  let signals = initialSignals;
  let executions = 0;
  const pausedPackets = [];
  const reportByAudit = new Map();
  const dependencies = dependencyFixture({
    area, authority: prepared.authority, pixelState, reportByAudit,
    probeDocumentIdentity: async () => structuredClone(proof),
    probeSensitiveCaptureSignals: async () => signals,
    execution: async args => {
      executions += 1;
      await args.onCheckpoint(fixture.checkpoint);
      const preflight = await args.privacyGate.preflight({
        auditId, observedTarget, capturePolicy: policy, signals: initialSignals,
      });
      return Object.freeze({
        version: 1, auditId, state: preflight.status,
        failureCode: null, model: null, checkpoint: fixture.checkpoint,
      });
    },
  });
  dependencies.panelCoordinator = panelCoordinator([], {
    async publishPrivacyPaused(value) { pausedPackets.push(structuredClone(value)); return true; },
    async publishRunningResume() { throw new Error('RUNNING_MUST_NOT_BE_PUBLISHED'); },
  });
  const starter = createAuthorizedAuditStarter(dependencies);
  const started = await starter.beginAuthorizedAudit({
    capabilityId: prepared.capabilityId, eventNonce: null, auditId, capturePolicy: policy,
    retentionPreference: { version: 1, deleteAfterCompleteExport: false }, senderContext: prepared.senderContext,
  });
  await started.completion;
  return {
    area, dependencies, pixelState, policy, prepared, started, pausedPackets, fixture, reportByAudit,
    get executions() { return executions; },
    suspension: () => pixelState.readSuspension(auditId),
    setProof(value) { proof = value; },
    setSignals(value) { signals = value; },
    expire(value) { currentAt = value; },
  };
}

async function finalizingPixelRecoveryHarness(auditId) {
  const harness = await pausedAuditHarness(auditId);
  const suspension = await harness.suspension();
  const proof = {
    kind: 'attached', tabId: suspension.tabId, windowId: suspension.windowId,
    documentId: suspension.documentId, urlSessionDigest: suspension.urlSessionDigest,
  };
  await harness.pixelState.claimAndBeginResume({
    auditId, consentId: suspension.consentId, proof,
    mode: suspension.mode, categories: suspension.categories,
  });
  await harness.prepared.authority.transitionAuditSession({
    sessionCapabilityId: harness.started.sessionCapabilityId, auditId, nextState: 'running',
  });
  await harness.pixelState.markSessionRunning({ auditId, consentId: suspension.consentId });
  await harness.pixelState.gateRunnerStart({
    auditId, consentId: suspension.consentId, proof, categories: suspension.categories,
  });
  const active = await readActiveAuditJobForWorker({ sessionArea: harness.area });
  harness.area.values[ACTIVE_AUDIT_JOB_KEY] = {
    ...structuredClone(active), state: 'finalizing', commitState: 'confirmed',
    expectedTerminalRevision: 1, updatedAt: active.updatedAt + 1,
  };
  harness.reportByAudit.set(auditId, Object.freeze({
    version: 1, auditId, modelRevision: 1,
    modelHash: harness.fixture.model.integrity.canonicalModelHash,
    model: harness.fixture.model, checkpoint: harness.fixture.checkpoint,
  }));
  const effects = { publishes: 0, finishes: 0, cleanups: 0 };
  const durablePixelState = harness.pixelState;
  harness.dependencies.pixelState = Object.freeze({
    ...durablePixelState,
    async finish(value) { effects.finishes += 1; return durablePixelState.finish(value); },
  });
  harness.dependencies.panelCoordinator = panelCoordinator([], {
    async publishResult() { effects.publishes += 1; return true; },
  });
  harness.dependencies.pixelAttemptLifecycle = Object.freeze({
    ...harness.dependencies.pixelAttemptLifecycle,
    async classify() { return Object.freeze({ state: 'terminal', handle: null }); },
    async cleanup() { effects.cleanups += 1; return true; },
  });
  return { ...harness, initialSuspension: suspension, effects };
}

test('denies wrong mode, document drift, and expiry without relaunching a paused pixel audit', async t => {
  await t.test('wrong mode', async () => {
    const harness = await pausedAuditHarness('audit-resume-mode');
    const suspension = await harness.suspension();
    const result = await createAuthorizedAuditStarter(harness.dependencies).resumePrivacyPausedAudit({
      auditId: 'audit-resume-mode', sessionCapabilityId: harness.started.sessionCapabilityId,
      windowId: 9, consentId: suspension.consentId, mode: 'element-only',
    });
    assert.deepEqual(result, {
      response: { ok: false, code: 'AUDIT_RESUME_DENIED' }, sessionCapabilityId: null, completion: null,
    });
    assert.equal(harness.executions, 1);
  });

  await t.test('document drift', async () => {
    const harness = await pausedAuditHarness('audit-resume-document');
    const suspension = await harness.suspension();
    harness.setProof({ tabId: 17, windowId: 9, documentId: 'document-b', urlSessionDigest: DIGEST });
    const result = await createAuthorizedAuditStarter(harness.dependencies).resumePrivacyPausedAudit({
      auditId: 'audit-resume-document', sessionCapabilityId: harness.started.sessionCapabilityId,
      windowId: 9, consentId: suspension.consentId, mode: 'full-evidence',
    });
    assert.deepEqual(result, {
      response: { ok: false, code: 'PIXEL_CONSENT_DOCUMENT_CHANGED' }, sessionCapabilityId: null, completion: null,
    });
    assert.equal(harness.executions, 1);
    assert.equal(await harness.suspension(), null);
    assert.equal(await readActiveAuditJobForWorker({ sessionArea: harness.area }), null);
  });

  await t.test('expired consent', async () => {
    const harness = await pausedAuditHarness('audit-resume-expired');
    const suspension = await harness.suspension();
    harness.expire(suspension.expiresAt);
    const result = await createAuthorizedAuditStarter(harness.dependencies).resumePrivacyPausedAudit({
      auditId: 'audit-resume-expired', sessionCapabilityId: harness.started.sessionCapabilityId,
      windowId: 9, consentId: suspension.consentId, mode: 'full-evidence',
    });
    assert.deepEqual(result, {
      response: { ok: false, code: 'PIXEL_CONSENT_EXPIRED' }, sessionCapabilityId: null, completion: null,
    });
    assert.equal(harness.executions, 1);
    assert.equal(await harness.suspension(), null);
    assert.equal(await readActiveAuditJobForWorker({ sessionArea: harness.area }), null);
  });
});

test('liquidation rejects a transplanted suspension before session or ACTIVE cleanup', async () => {
  const auditId = 'audit-pixel-transplant';
  const harness = await pausedAuditHarness(auditId);
  const suspension = await harness.suspension();
  const key = `audita:pixel-capture:v1:${auditId}`;
  harness.area.values[key] = { ...structuredClone(harness.area.values[key]), tabId: 999 };
  await harness.pixelState.revokeAudit({
    auditId, consentId: suspension.consentId, reason: 'SESSION_ENDED',
  });
  const result = await createAuthorizedAuditStarter(harness.dependencies).liquidatePixelAudit({
    auditId, consentId: suspension.consentId, reason: 'SESSION_ENDED',
    source: { kind: 'attached' }, signal: new AbortController().signal,
  });
  assert.equal(result, false);
  assert.equal((await readActiveAuditJobForWorker({ sessionArea: harness.area })).auditId, auditId);
  assert.equal((await harness.suspension()).tabId, 999);
});

test('TAB_DISCARDED enters the unified paused-pixel liquidator', async () => {
  const auditId = 'audit-pixel-discarded';
  const harness = await pausedAuditHarness(auditId);
  const result = await createAuthorizedAuditStarter(harness.dependencies).abortAttachedAuditForTarget({
    tabId: 17, windowId: null, reasonCode: 'TAB_DISCARDED',
  });
  assert.deepEqual(result, { handled: true, liquidated: true, aborted: true, auditId });
  assert.equal(await harness.suspension(), null);
  assert.equal(await readActiveAuditJobForWorker({ sessionArea: harness.area }), null);
});

test('rotates changed sensitive categories and republishes a new paused consent without relaunching', async () => {
  const auditId = 'audit-resume-drift';
  const harness = await pausedAuditHarness(auditId);
  const first = await harness.suspension();
  harness.setSignals(Object.freeze({
    version: 'SensitiveCaptureSignalsV1', detected: true, categories: Object.freeze(['payment']),
  }));
  const result = await createAuthorizedAuditStarter(harness.dependencies).resumePrivacyPausedAudit({
    auditId, sessionCapabilityId: harness.started.sessionCapabilityId,
    windowId: 9, consentId: first.consentId, mode: 'full-evidence',
  });
  assert.deepEqual(result, {
    response: { ok: true, auditId, state: 'privacy-paused' },
    sessionCapabilityId: harness.started.sessionCapabilityId, completion: null,
  });
  const second = await harness.suspension();
  assert.notEqual(second.consentId, first.consentId);
  assert.deepEqual(second.categories, ['payment']);
  assert.equal(harness.executions, 1);
  assert.equal((await readActiveAuditJobForWorker({ sessionArea: harness.area })).state, 'privacy-paused');
  assert.deepEqual(harness.pausedPackets.at(-1), {
    auditId, sessionCapabilityId: harness.started.sessionCapabilityId,
    windowId: 9,
  });
});

test('restart during a claimed resume revokes the attempt and never relaunches pixels', async () => {
  const auditId = 'audit-resume-restart-cut';
  const harness = await pausedAuditHarness(auditId);
  const suspension = await harness.suspension();
  await harness.pixelState.claimAndBeginResume({
    auditId, consentId: suspension.consentId, mode: suspension.mode,
    categories: suspension.categories,
    proof: {
      kind: 'attached', tabId: suspension.tabId, windowId: suspension.windowId,
      documentId: suspension.documentId, urlSessionDigest: suspension.urlSessionDigest,
    },
  });
  await harness.prepared.authority.transitionAuditSession({
    sessionCapabilityId: harness.started.sessionCapabilityId, auditId, nextState: 'running',
  });
  await harness.pixelState.markSessionRunning({ auditId, consentId: suspension.consentId });
  const active = await readActiveAuditJobForWorker({ sessionArea: harness.area });
  harness.area.values[ACTIVE_AUDIT_JOB_KEY] = {
    ...structuredClone(active), state: 'running', updatedAt: active.updatedAt + 1,
  };

  const recovery = await createAuthorizedAuditStarter(harness.dependencies).recoverAuthorizedAuditLifecycle();
  assert.deepEqual(recovery, { ok: true, state: 'interrupted', auditId, revision: null });
  assert.equal(harness.executions, 1);
  assert.equal(await harness.suspension(), null);
  assert.equal(await readActiveAuditJobForWorker({ sessionArea: harness.area }), null);
});

test('restart after a terminal commit publishes and finishes consent without recapturing', async () => {
  const auditId = 'audit-resume-terminal-cut';
  const harness = await finalizingPixelRecoveryHarness(auditId);

  const recovery = await createAuthorizedAuditStarter(harness.dependencies).recoverAuthorizedAuditLifecycle();
  assert.deepEqual(recovery, { ok: true, state: 'reconciled', auditId, revision: 1 });
  assert.equal(harness.executions, 1);
  assert.equal(await harness.suspension(), null);
  assert.deepEqual(harness.effects, { publishes: 1, finishes: 1, cleanups: 1 });
});

test('finalizing recovery rejects a transplanted pixel journal before every terminal effect', async t => {
  const mutations = [
    ['tab', record => { record.tabId = 999; }],
    ['document', record => { record.documentId = 'foreign-document'; }],
    ['digest', record => { record.urlSessionDigest = `hmac-sha256:${'B'.repeat(43)}`; }],
    ['foreign evidence URL', record => { record.urlEvidence.href = 'https://foreign.example/other'; }],
    ['evidence query', record => { record.urlEvidence.queryIncluded = true; record.urlEvidence.href = 'https://example.test/?private=1'; }],
    ['mode-policy mismatch', record => { record.mode = 'element-only'; }],
    ['query-enabled policy', record => { record.capturePolicy.includeQuery = true; }],
    ['noncanonical categories', record => { record.categories = ['payment', 'password']; }],
  ];
  for (const [name, mutate] of mutations) await t.test(name, async () => {
    const auditId = `audit-finalizing-transplant-${name.replaceAll(' ', '-')}`;
    const harness = await finalizingPixelRecoveryHarness(auditId);
    const key = `audita:pixel-capture:v1:${auditId}`;
    mutate(harness.area.values[key]);

    const recovery = await createAuthorizedAuditStarter(harness.dependencies).recoverAuthorizedAuditLifecycle();

    assert.deepEqual(recovery, {
      ok: false, state: 'blocked', auditId: null, revision: null, code: 'AUDIT_RECOVERY_REQUIRED',
    });
    assert.deepEqual(harness.effects, { publishes: 0, finishes: 0, cleanups: 0 });
    assert.equal((await readActiveAuditJobForWorker({ sessionArea: harness.area })).auditId, auditId);
    assert.equal(harness.reportByAudit.has(auditId), true);
    assert.equal(Object.hasOwn(harness.area.values, key), true);
  });
});

test('cancels a durable paused audit without any live-map authority or pixel relaunch', async () => {
  const auditId = 'audit-paused-cancel';
  const harness = await pausedAuditHarness(auditId);
  const result = await createAuthorizedAuditStarter(harness.dependencies).abortAuthorizedAudit({
    auditId, sessionCapabilityId: harness.started.sessionCapabilityId, windowId: 9, reasonCode: 'USER_CANCELLED',
  });
  assert.deepEqual(result, { ok: true, auditId, state: 'revoked' });
  assert.equal(harness.executions, 1);
  assert.equal(await harness.suspension(), null);
  assert.equal(await readActiveAuditJobForWorker({ sessionArea: harness.area }), null);
  assert.equal(Object.hasOwn(harness.area.values, START_JOURNAL_KEY), false);
  assert.equal(Object.hasOwn(harness.area.values, executionCheckpointStorageKey(auditId)), false);
});

test('cleans live aids under the target lock before any capability claim or audit side effect', async () => {
  const area = sessionArea();
  const prepared = await authorityFixture(area);
  const targetQueue = createTargetOperationQueue();
  const effects = { claims: 0, executions: 0 };
  const trace = [];
  const starter = createAuthorizedAuditStarter(dependencyFixture({
    area,
    authority: instrumentAuthority(prepared.authority, effects),
    targetQueue,
    cleanupBarrier: {
      async clearForAuditLocked({ target, lock }) {
        trace.push('cleanup');
        targetQueue.assertHeld(lock, target);
        return { ok: false, code: 'PERSONA_CLEANUP_UNCONFIRMED' };
      },
    },
    execution: async () => { effects.executions += 1; throw new Error('must not execute'); },
  }));

  const started = await starter.beginAuthorizedAudit({
    capabilityId: prepared.capabilityId,
    eventNonce: null,
    auditId: 'audit-cleanup-denied',
    capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    retentionPreference: { version: 1, deleteAfterCompleteExport: false },
    senderContext: prepared.senderContext,
  });

  assert.deepEqual(started, {
    response: { ok: false, code: 'PERSONA_CLEANUP_UNCONFIRMED' },
    sessionCapabilityId: null,
    completion: null,
  });
  assert.deepEqual(trace, ['cleanup']);
  assert.equal(effects.claims, 0);
  assert.equal(effects.executions, 0);
  assert.equal((await area.get(targetCapabilityStorageKey(prepared.capabilityId)))[targetCapabilityStorageKey(prepared.capabilityId)].state, 'prepared');
});

test('holds the shared target queue until the attached audit execution and settlement finish', async () => {
  const area = sessionArea();
  const prepared = await authorityFixture(area);
  const targetQueue = createTargetOperationQueue();
  let releaseExecution;
  let executionEntered = false;
  const executionGate = new Promise(resolve => { releaseExecution = resolve; });
  const starter = createAuthorizedAuditStarter(dependencyFixture({
    area,
    authority: prepared.authority,
    targetQueue,
    execution: async () => {
      executionEntered = true;
      await executionGate;
      return Object.freeze({
        version: 1,
        auditId: 'audit-target-lock',
        state: 'revoked',
        failureCode: 'AUDIT_FAILED',
        model: null,
        checkpoint: null,
      });
    },
  }));
  const started = await starter.beginAuthorizedAudit({
    capabilityId: prepared.capabilityId,
    eventNonce: null,
    auditId: 'audit-target-lock',
    capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    retentionPreference: { version: 1, deleteAfterCompleteExport: false },
    senderContext: prepared.senderContext,
  });
  assert.equal(started.response.ok, true);
  while (!executionEntered) await new Promise(resolve => setImmediate(resolve));

  let contenderEntered = false;
  const contender = targetQueue.withTarget({
    tabId: 17,
    windowId: 9,
    documentId: 'document-a',
    urlSessionDigest: DIGEST,
  }, async () => { contenderEntered = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(contenderEntered, false);
  releaseExecution();
  await started.completion;
  assert.equal(contenderEntered, true,
    'completion pública só pode resolver depois que o lock do alvo liberar o sucessor');
  await contender;
});

test('explicit undefined start-journal storage blocks begin before overwrite, claim, bootstrap or publication', async () => {
  const area = sessionArea();
  const prepared = await authorityFixture(area);
  area.values[START_JOURNAL_KEY] = undefined;
  const effects = { claims: 0 };
  const order = [];
  const storageEffects = instrumentJournalStorage(area);
  const starter = createAuthorizedAuditStarter(dependencyFixture({
    area,
    authority: instrumentAuthority(prepared.authority, effects),
    order,
    execution: async () => Object.freeze({
      version: 1, auditId: 'audit-undefined-journal', state: 'revoked',
      failureCode: 'AUDIT_FAILED', model: null, checkpoint: null,
    }),
  }));

  const started = await starter.beginAuthorizedAudit({
    capabilityId: prepared.capabilityId, eventNonce: null, auditId: 'audit-undefined-journal',
    capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    retentionPreference: { version: 1, deleteAfterCompleteExport: false }, senderContext: prepared.senderContext,
  });
  if (started.completion) await started.completion;

  assert.deepEqual(started.response, { ok: false, code: 'AUDIT_RECOVERY_REQUIRED' });
  assert.equal(started.sessionCapabilityId, null);
  assert.equal(effects.claims, 0);
  assert.equal(storageEffects.writes, 0);
  assert.equal(storageEffects.removals, 0);
  assert.deepEqual(order, []);
  assert.equal(Object.hasOwn(area.values, START_JOURNAL_KEY), true);
  assert.equal(area.values[START_JOURNAL_KEY], undefined);
});

test('explicit undefined start-journal storage blocks lifecycle recovery instead of reporting idle', async () => {
  const area = sessionArea();
  const prepared = await authorityFixture(area);
  area.values[START_JOURNAL_KEY] = undefined;
  const order = [];
  const storageEffects = instrumentJournalStorage(area);
  const recovered = await createAuthorizedAuditStarter(dependencyFixture({
    area, authority: prepared.authority, order,
    execution: async () => { throw new Error('must not resume'); },
  })).recoverAuthorizedAuditLifecycle();

  assert.deepEqual(recovered, {
    ok: false, state: 'blocked', auditId: null, revision: null, code: 'AUDIT_RECOVERY_REQUIRED',
  });
  assert.equal(storageEffects.writes, 0);
  assert.equal(storageEffects.removals, 0);
  assert.deepEqual(order, []);
  assert.equal(Object.hasOwn(area.values, START_JOURNAL_KEY), true);
  assert.equal(area.values[START_JOURNAL_KEY], undefined);
});

test('hostile start-journal storage envelopes block begin and recovery with zero effects', async t => {
  const getterState = { calls: 0 };
  for (const [name, createEnvelope] of malformedJournalEnvelopeCases(getterState)) {
    await t.test(name, async () => {
      const beginArea = sessionArea();
      const prepared = await authorityFixture(beginArea);
      const beginEffects = { claims: 0 };
      const beginOrder = [];
      const beginStorageEffects = instrumentJournalStorage(beginArea, createEnvelope);
      const started = await createAuthorizedAuditStarter(dependencyFixture({
        area: beginArea,
        authority: instrumentAuthority(prepared.authority, beginEffects),
        order: beginOrder,
        execution: async () => { throw new Error('must not run'); },
      })).beginAuthorizedAudit({
        capabilityId: prepared.capabilityId, eventNonce: null, auditId: `audit-hostile-${name.replaceAll(' ', '-')}`,
        capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
        retentionPreference: { version: 1, deleteAfterCompleteExport: false }, senderContext: prepared.senderContext,
      });

      assert.deepEqual(started.response, { ok: false, code: 'AUDIT_RECOVERY_REQUIRED' });
      assert.equal(started.sessionCapabilityId, null);
      assert.equal(beginEffects.claims, 0);
      assert.equal(beginStorageEffects.writes, 0);
      assert.equal(beginStorageEffects.removals, 0);
      assert.deepEqual(beginOrder, []);

      const recoveryArea = sessionArea();
      const recoveryPrepared = await authorityFixture(recoveryArea);
      const recoveryOrder = [];
      const recoveryStorageEffects = instrumentJournalStorage(recoveryArea, createEnvelope);
      const recovered = await createAuthorizedAuditStarter(dependencyFixture({
        area: recoveryArea, authority: recoveryPrepared.authority, order: recoveryOrder,
        execution: async () => { throw new Error('must not resume'); },
      })).recoverAuthorizedAuditLifecycle();

      assert.deepEqual(recovered, {
        ok: false, state: 'blocked', auditId: null, revision: null, code: 'AUDIT_RECOVERY_REQUIRED',
      });
      assert.equal(recoveryStorageEffects.writes, 0);
      assert.equal(recoveryStorageEffects.removals, 0);
      assert.deepEqual(recoveryOrder, []);
    });
  }
  assert.equal(getterState.calls, 0);
});

test('rejects a hostile retention intent before claim, journal or other effect', async () => {
  const area = sessionArea();
  const prepared = await authorityFixture(area);
  let executions = 0;
  const dependencies = dependencyFixture({ area, authority: prepared.authority, execution: async () => { executions += 1; } });
  const starter = createAuthorizedAuditStarter(dependencies);
  let reads = 0;
  const preference = { version: 1, deleteAfterCompleteExport: false };
  Object.defineProperty(preference, 'deleteAfterCompleteExport', { enumerable: true, get() { reads += 1; return false; } });
  const result = await starter.beginAuthorizedAudit({
    capabilityId: prepared.capabilityId, eventNonce: null, auditId: 'audit-hostile-intent',
    capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    retentionPreference: preference, senderContext: prepared.senderContext,
  });
  assert.deepEqual(result.response, { ok: false, code: 'AUDIT_START_FAILED' });
  assert.equal(reads, 0);
  assert.equal(executions, 0);
  assert.equal(Object.hasOwn(area.values, ACTIVE_AUDIT_JOB_KEY), false);
});

test('native dependency messages cannot spoof TARGET_UNAVAILABLE selection', async () => {
  const area = sessionArea();
  const prepared = await authorityFixture(area);
  const dependencies = dependencyFixture({
    area, authority: prepared.authority,
    execution: async () => { throw new Error('must not run'); },
  });
  dependencies.readAuditSnapshot = async () => { throw new Error('TARGET_UNAVAILABLE'); };

  const started = await createAuthorizedAuditStarter(dependencies).beginAuthorizedAudit({
    capabilityId: prepared.capabilityId, eventNonce: null, auditId: 'audit-native-target-spoof',
    capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    retentionPreference: { version: 1, deleteAfterCompleteExport: false }, senderContext: prepared.senderContext,
  });

  assert.deepEqual(started.response, { ok: false, code: 'AUDIT_START_FAILED' });
});

test('a failed target inspection returns one recoverable closed response before queue or cleanup effects', async () => {
  const area = sessionArea();
  const prepared = await authorityFixture(area);
  let cleanupCalls = 0;
  const authority = {
    ...prepared.authority,
    async inspectPreparedAuditTarget() { throw new Error('private inspection detail'); },
  };
  const dependencies = dependencyFixture({
    area,
    authority,
    cleanupBarrier: {
      async clearForAuditLocked() { cleanupCalls += 1; return { ok: true, state: 'clear' }; },
    },
    execution: async () => { throw new Error('must not execute'); },
  });
  const started = await createAuthorizedAuditStarter(dependencies).beginAuthorizedAudit({
    capabilityId: prepared.capabilityId,
    eventNonce: null,
    auditId: 'audit-inspection-failed',
    capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    retentionPreference: { version: 1, deleteAfterCompleteExport: false },
    senderContext: prepared.senderContext,
  });
  assert.deepEqual(started, {
    response: { ok: false, code: 'TARGET_UNAVAILABLE' },
    sessionCapabilityId: null,
    completion: null,
  });
  assert.equal(cleanupCalls, 0);
});

test('starts from the exact missing snapshot contract returned by the real audit store', async () => {
  const area = sessionArea();
  const prepared = await authorityFixture(area);
  const dependencies = dependencyFixture({
    area, authority: prepared.authority,
    execution: async ({ auditId }) => Object.freeze({
      version: 1, auditId, state: 'revoked', failureCode: 'AUDIT_FAILED', model: null, checkpoint: null,
    }),
  });
  dependencies.readAuditSnapshot = async () => ({ model: undefined, revision: 0, capability: null });

  const started = await createAuthorizedAuditStarter(dependencies).beginAuthorizedAudit({
    capabilityId: prepared.capabilityId, eventNonce: null, auditId: 'audit-real-missing-snapshot',
    capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    retentionPreference: { version: 1, deleteAfterCompleteExport: false }, senderContext: prepared.senderContext,
  });

  assert.deepEqual(started.response, { ok: true, auditId: 'audit-real-missing-snapshot', state: 'running' });
  assert.match(started.sessionCapabilityId, /^[A-Za-z0-9_-]{22}$/u);
  await started.completion;
});

test('rejects malformed missing-snapshot lookalikes before claim or persistence', async t => {
  let getterCalls = 0;
  const accessor = { model: undefined, revision: 0 };
  Object.defineProperty(accessor, 'capability', {
    enumerable: true,
    get() { getterCalls += 1; return null; },
  });
  const cases = [
    ['legacy two-key shape', { model: undefined, revision: 0 }],
    ['extra key', { model: undefined, revision: 0, capability: null, extra: true }],
    ['non-null capability without a model', { model: undefined, revision: 0, capability: Object.freeze(Object.create(null)) }],
    ['nonzero revision without a model', { model: undefined, revision: 1, capability: null }],
    ['accessor capability', accessor],
  ];
  for (const [name, snapshot] of cases) {
    await t.test(name, async () => {
      const area = sessionArea();
      const prepared = await authorityFixture(area);
      const effects = { claims: 0 };
      const order = [];
      const dependencies = dependencyFixture({
        area, authority: instrumentAuthority(prepared.authority, effects), order,
        execution: async () => { throw new Error('must not run'); },
      });
      dependencies.readAuditSnapshot = async () => snapshot;

      const started = await createAuthorizedAuditStarter(dependencies).beginAuthorizedAudit({
        capabilityId: prepared.capabilityId, eventNonce: null, auditId: `audit-hostile-snapshot-${name.replaceAll(' ', '-')}`,
        capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
        retentionPreference: { version: 1, deleteAfterCompleteExport: false }, senderContext: prepared.senderContext,
      });

      assert.deepEqual(started.response, { ok: false, code: 'AUDIT_ID_COLLISION' });
      assert.equal(started.sessionCapabilityId, null);
      assert.equal(effects.claims, 0);
      assert.deepEqual(order, []);
    });
  }
  assert.equal(getterCalls, 0);
});

test('journals, claims, checkpoints and atomically settles a result before publication', async () => {
  const area = sessionArea();
  const prepared = await authorityFixture(area);
  const report = await reportFixture('audit-attached-result');
  const order = [];
  const reportByAudit = new Map();
  const execution = async ({ onCheckpoint, persistAuditModel }) => {
    order.push('run');
    await onCheckpoint(report.checkpoint);
    await persistAuditModel(report.model);
    return Object.freeze({
      version: 1, auditId: report.model.auditId, state: 'model', failureCode: null,
      model: report.model, checkpoint: report.checkpoint,
    });
  };
  const dependencies = dependencyFixture({ area, authority: prepared.authority, execution, order, reportByAudit });
  dependencies.panelCoordinator = panelCoordinator(order, {
    async registerPendingBootstrap(value) {
      assert.equal(Object.hasOwn(area.values, 'audita:start-journal:v1'), true);
      assert.equal(Object.hasOwn(area.values, ACTIVE_AUDIT_JOB_KEY), false);
      order.push('bootstrap-register');
      return true;
    },
    async publishRegisteredBootstrap() {
      assert.equal(Object.hasOwn(area.values, 'audita:start-journal:v1'), false);
      assert.equal(Object.hasOwn(area.values, ACTIVE_AUDIT_JOB_KEY), true);
      order.push('bootstrap');
      return true;
    },
  });
  dependencies.buildPanelResultBundle = ({ reportRevision }) => createPanelResultBundleV1({ reportRevision, inventory: report.inventory });
  const starter = createAuthorizedAuditStarter(dependencies);
  const started = await starter.beginAuthorizedAudit({
    capabilityId: prepared.capabilityId, eventNonce: null, auditId: report.model.auditId,
    capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    retentionPreference: { version: 1, deleteAfterCompleteExport: false }, senderContext: prepared.senderContext,
  });
  assert.deepEqual(started.response, { ok: true, auditId: report.model.auditId, state: 'running' });
  assert.match(started.sessionCapabilityId, /^[A-Za-z0-9_-]{22}$/u);
  const active = await readActiveAuditJobForWorker({ sessionArea: area });
  assert.equal(active.auditId, report.model.auditId);
  const completion = await started.completion;
  assert.deepEqual(completion, { ok: true, auditId: report.model.auditId, state: 'result', revision: 1 });
  assert.equal(Object.hasOwn(area.values, ACTIVE_AUDIT_JOB_KEY), false);
  assert.equal(Object.hasOwn(area.values, executionCheckpointStorageKey(report.model.auditId)), false);
  assert.deepEqual(area.values[retentionPreferenceStorageKey(report.model.auditId)], {
    version: 1, auditId: report.model.auditId, deleteAfterCompleteExport: false,
    createdAt: EPOCH + 1, expiresAt: EPOCH + 30 * 60_000,
  });
  assert.ok(order.indexOf('commit') < order.indexOf('publish:result'));
  assert.ok(order.indexOf('publish:result') < order.indexOf('checkpoint-remove'));
  assert.ok(order.indexOf('bootstrap-register') < order.indexOf('latest:running'));
  assert.ok(order.indexOf('latest:running') < order.indexOf('bootstrap'));
  assert.ok(order.indexOf('bootstrap') < order.indexOf('run'));
});

test('commits and publishes a canonical failed terminal model through the production result callback', async () => {
  const area = sessionArea();
  const prepared = await authorityFixture(area);
  const report = await reportFixture('audit-attached-failed-result', 'failed');
  const order = [];
  const reportByAudit = new Map();
  const auditStore = createInMemoryAuditStore();
  let published = null;
  const execution = async ({ onCheckpoint, persistAuditModel }) => {
    order.push('run');
    await onCheckpoint(report.checkpoint);
    await persistAuditModel(report.model);
    return Object.freeze({
      version: 1, auditId: report.model.auditId, state: 'model', failureCode: null,
      model: report.model, checkpoint: report.checkpoint,
    });
  };
  const dependencies = dependencyFixture({ area, authority: prepared.authority, execution, order, reportByAudit });
  let commitCalls = 0;
  dependencies.commitTerminalAudit = async input => {
    commitCalls += 1;
    assert.equal(input.expectedRevision, 1);
    return auditStore.commitAuditWithCheckpointIfAbsent(
      input.auditId, input.model, input.checkpoint, input.latestState,
      { now: '2026-08-29T12:00:00.000Z', deleteAfterCompleteExport: false },
    );
  };
  dependencies.readAuditSnapshot = ({ auditId }) => auditStore.getAuditSnapshot(auditId);
  dependencies.readReportRevision = ({ auditId }) => auditStore.getReportRevision(auditId);
  dependencies.panelCoordinator = panelCoordinator(order, {
    async publishResult(value) {
      order.push(`publish:${value.state}`);
      published = value;
      return true;
    },
  });
  dependencies.buildPanelResultBundle = ({ reportRevision }) => createPanelResultBundleV1({
    reportRevision, inventory: report.inventory,
  });

  const started = await createAuthorizedAuditStarter(dependencies).beginAuthorizedAudit({
    capabilityId: prepared.capabilityId, eventNonce: null, auditId: report.model.auditId,
    capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    retentionPreference: { version: 1, deleteAfterCompleteExport: false }, senderContext: prepared.senderContext,
  });
  const completion = await started.completion;

  assert.deepEqual(completion, { ok: true, auditId: report.model.auditId, state: 'result', revision: 1 });
  assert.equal(commitCalls, 1);
  assert.equal((await auditStore.getReportRevision(report.model.auditId))?.model.session.status, 'failed');
  assert.equal(published?.state, 'result');
  assert.equal(published?.resultBundle?.summary?.identity?.status, 'failed');
  assert.equal(order.filter(entry => entry === 'publish:result').length, 1);
  assert.equal(order.some(entry => entry === 'publish:revoked'), false);
});

test('recovers and publishes once when the real attached façade observes a terminal commit before its callback rejects', async () => {
  const area = sessionArea();
  const prepared = await authorityFixture(area);
  const auditId = 'audit-attached-commit-then-throw';
  const order = [];
  const auditStore = createInMemoryAuditStore();
  const inventory = await createInstalledCoreRuleInventory();
  const chromeAdapter = failedAttachedChromeAdapter();
  let commitCalls = 0;
  let published = null;
  const dependencies = dependencyFixture({
    area,
    authority: prepared.authority,
    order,
    execution: args => runAttachedAuditExecution({
      ...args,
      chromeAdapter,
      expectedExtensionId: 'abcdefghijklmnopabcdefghijklmnop',
    }),
  });
  dependencies.persistLatest = async ({ state }) => {
    order.push(`latest:${state.status}`);
    await auditStore.setLatest(state);
    return Object.freeze(structuredClone(state));
  };
  dependencies.commitTerminalAudit = async input => {
    commitCalls += 1;
    await auditStore.commitAuditWithCheckpointIfAbsent(
      input.auditId, input.model, input.checkpoint, input.latestState,
      { now: '2026-08-29T12:00:00.000Z', deleteAfterCompleteExport: false },
    );
    throw new Error('simulated commit acknowledgement loss');
  };
  dependencies.readAuditSnapshot = ({ auditId: id }) => auditStore.getAuditSnapshot(id);
  dependencies.readReportRevision = ({ auditId: id }) => auditStore.getReportRevision(id);
  dependencies.readLatest = () => auditStore.getLatest();
  dependencies.buildPanelResultBundle = ({ reportRevision }) => createPanelResultBundleV1({
    reportRevision, inventory,
  });
  dependencies.panelCoordinator = panelCoordinator(order, {
    async publishResult(value) {
      order.push(`publish:${value.state}`);
      published = value;
      return true;
    },
  });

  const started = await createAuthorizedAuditStarter(dependencies).beginAuthorizedAudit({
    capabilityId: prepared.capabilityId,
    eventNonce: null,
    auditId,
    capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    retentionPreference: { version: 1, deleteAfterCompleteExport: false },
    senderContext: prepared.senderContext,
  });

  assert.deepEqual(await started.completion, { ok: true, auditId, state: 'result', revision: 1 });
  assert.equal(commitCalls, 1);
  assert.equal((await auditStore.getReportRevision(auditId))?.model.session.status, 'failed');
  assert.equal(published?.state, 'result');
  assert.equal(published?.resultBundle?.summary?.identity?.status, 'failed');
  assert.equal(order.filter(entry => entry === 'publish:result').length, 1);
  assert.equal(order.some(entry => entry === 'publish:revoked'), false);
  assert.equal(await readActiveAuditJobForWorker({ sessionArea: area }), null);
});

test('real attached façade commits one cancelled result when cancellation wins during bundle preparation', async () => {
  const area = sessionArea();
  const prepared = await authorityFixture(area);
  const auditId = 'audit-attached-cancel-during-bundle';
  const order = [];
  const auditStore = createInMemoryAuditStore();
  const inventory = await createInstalledCoreRuleInventory();
  const chromeAdapter = failedAttachedChromeAdapter();
  let commitCalls = 0;
  let published = null;
  let buildCalls = 0;
  let releaseFirstBuild;
  let announceFirstBuild;
  const firstBuildEntered = new Promise(resolve => { announceFirstBuild = resolve; });
  const firstBuildGate = new Promise(resolve => { releaseFirstBuild = resolve; });
  const dependencies = dependencyFixture({
    area,
    authority: prepared.authority,
    order,
    execution: args => runAttachedAuditExecution({
      ...args,
      chromeAdapter,
      expectedExtensionId: 'abcdefghijklmnopabcdefghijklmnop',
    }),
  });
  dependencies.persistLatest = async ({ state }) => {
    order.push(`latest:${state.status}`);
    await auditStore.setLatest(state);
    return Object.freeze(structuredClone(state));
  };
  dependencies.commitTerminalAudit = async input => {
    commitCalls += 1;
    return auditStore.commitAuditWithCheckpointIfAbsent(
      input.auditId, input.model, input.checkpoint, input.latestState,
      { now: '2026-08-29T12:00:00.000Z', deleteAfterCompleteExport: false },
    );
  };
  dependencies.readAuditSnapshot = ({ auditId: id }) => auditStore.getAuditSnapshot(id);
  dependencies.readReportRevision = ({ auditId: id }) => auditStore.getReportRevision(id);
  dependencies.readLatest = () => auditStore.getLatest();
  dependencies.buildPanelResultBundle = async ({ reportRevision }) => {
    buildCalls += 1;
    if (buildCalls === 1) {
      announceFirstBuild();
      await firstBuildGate;
    }
    return createPanelResultBundleV1({ reportRevision, inventory });
  };
  dependencies.panelCoordinator = panelCoordinator(order, {
    async publishResult(value) {
      order.push(`publish:${value.state}`);
      published = value;
      return true;
    },
  });
  const starter = createAuthorizedAuditStarter(dependencies);
  const started = await starter.beginAuthorizedAudit({
    capabilityId: prepared.capabilityId,
    eventNonce: null,
    auditId,
    capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    retentionPreference: { version: 1, deleteAfterCompleteExport: false },
    senderContext: prepared.senderContext,
  });
  await firstBuildEntered;
  assert.deepEqual(await starter.abortAuthorizedAudit({
    auditId,
    sessionCapabilityId: started.sessionCapabilityId,
    windowId: 9,
    reasonCode: 'USER_CANCELLED',
  }), { ok: true, auditId, state: 'cancelling' });
  releaseFirstBuild();

  assert.deepEqual(await started.completion, { ok: true, auditId, state: 'result', revision: 1 });
  assert.equal(commitCalls, 1);
  assert.equal((await auditStore.getReportRevision(auditId))?.model.session.status, 'cancelled');
  assert.equal(published?.state, 'result');
  assert.equal(published?.resultBundle?.summary?.identity?.status, 'cancelled');
  assert.equal(order.filter(entry => entry === 'publish:result').length, 1);
  assert.equal(order.some(entry => entry === 'publish:revoked'), false);
});

test('real attached façade commits cancellation accepted at its first observed checkpoint', async () => {
  const area = sessionArea();
  const prepared = await authorityFixture(area);
  const auditId = 'audit-attached-cancel-first-checkpoint';
  const order = [];
  const auditStore = createInMemoryAuditStore();
  const inventory = await createInstalledCoreRuleInventory();
  let collectCalls = 0;
  const chromeAdapter = Object.freeze({
    ...failedAttachedChromeAdapter(),
    async collectPage() {
      collectCalls += 1;
      throw new Error('collection must not start after checkpoint cancellation');
    },
  });
  let commitCalls = 0;
  let published = null;
  let releaseFirstCheckpoint;
  let announceFirstCheckpoint;
  const firstCheckpointEntered = new Promise(resolve => { announceFirstCheckpoint = resolve; });
  const firstCheckpointGate = new Promise(resolve => { releaseFirstCheckpoint = resolve; });
  const dependencies = dependencyFixture({
    area,
    authority: prepared.authority,
    order,
    execution: args => runAttachedAuditExecution({
      ...args,
      chromeAdapter,
      expectedExtensionId: 'abcdefghijklmnopabcdefghijklmnop',
    }),
  });
  const persistCheckpoint = dependencies.persistCheckpoint;
  let checkpointCalls = 0;
  dependencies.persistCheckpoint = async value => {
    checkpointCalls += 1;
    if (checkpointCalls === 1) {
      announceFirstCheckpoint();
      await firstCheckpointGate;
    }
    return persistCheckpoint(value);
  };
  dependencies.persistLatest = async ({ state }) => {
    order.push(`latest:${state.status}`);
    await auditStore.setLatest(state);
    return Object.freeze(structuredClone(state));
  };
  dependencies.commitTerminalAudit = async input => {
    commitCalls += 1;
    await auditStore.commitAuditWithCheckpointIfAbsent(
      input.auditId, input.model, input.checkpoint, input.latestState,
      { now: '2026-08-29T12:00:00.000Z', deleteAfterCompleteExport: false },
    );
    throw new Error('simulated first-checkpoint commit acknowledgement loss');
  };
  dependencies.readAuditSnapshot = ({ auditId: id }) => auditStore.getAuditSnapshot(id);
  dependencies.readReportRevision = ({ auditId: id }) => auditStore.getReportRevision(id);
  dependencies.readLatest = () => auditStore.getLatest();
  dependencies.buildPanelResultBundle = ({ reportRevision }) => createPanelResultBundleV1({
    reportRevision, inventory,
  });
  dependencies.panelCoordinator = panelCoordinator(order, {
    async publishResult(value) {
      order.push(`publish:${value.state}`);
      published = value;
      return true;
    },
  });
  const starter = createAuthorizedAuditStarter(dependencies);
  const started = await starter.beginAuthorizedAudit({
    capabilityId: prepared.capabilityId,
    eventNonce: null,
    auditId,
    capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    retentionPreference: { version: 1, deleteAfterCompleteExport: false },
    senderContext: prepared.senderContext,
  });
  await firstCheckpointEntered;
  assert.deepEqual(await starter.abortAuthorizedAudit({
    auditId,
    sessionCapabilityId: started.sessionCapabilityId,
    windowId: 9,
    reasonCode: 'USER_CANCELLED',
  }), { ok: true, auditId, state: 'cancelling' });
  releaseFirstCheckpoint();

  assert.deepEqual(await started.completion, { ok: true, auditId, state: 'result', revision: 1 });
  assert.equal(checkpointCalls, 1);
  assert.equal(collectCalls, 0);
  assert.equal(commitCalls, 1);
  assert.equal((await auditStore.getReportRevision(auditId))?.model.session.status, 'cancelled');
  assert.equal(published?.state, 'result');
  assert.equal(published?.resultBundle?.summary?.identity?.status, 'cancelled');
  assert.equal(order.filter(entry => entry === 'publish:result').length, 1);
  assert.equal(order.some(entry => entry === 'publish:revoked'), false);
});

test('records the validated terminal snapshot against the observed target before exposing the result', async () => {
  const area = sessionArea();
  const prepared = await authorityFixture(area);
  const report = await reportFixture('audit-highlight-binding-seam');
  const order = [];
  const reportByAudit = new Map();
  let recorded = null;
  let recordCalls = 0;
  const dependencies = dependencyFixture({
    area, authority: prepared.authority, order, reportByAudit,
    execution: async ({ onCheckpoint, persistAuditModel }) => {
      order.push('run');
      await onCheckpoint(report.checkpoint);
      await persistAuditModel(report.model);
      return Object.freeze({
        version: 1, auditId: report.model.auditId, state: 'model', failureCode: null,
        model: report.model, checkpoint: report.checkpoint,
      });
    },
  });
  dependencies.buildPanelResultBundle = ({ reportRevision }) => createPanelResultBundleV1({
    reportRevision, inventory: report.inventory,
  });
  dependencies.recordHighlightBinding = async input => {
    recordCalls += 1;
    order.push('highlight-binding');
    recorded = input;
    return Object.freeze({ state: 'available' });
  };

  const started = await createAuthorizedAuditStarter(dependencies).beginAuthorizedAudit({
    capabilityId: prepared.capabilityId, eventNonce: null, auditId: report.model.auditId,
    capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    retentionPreference: { version: 1, deleteAfterCompleteExport: false }, senderContext: prepared.senderContext,
  });

  assert.deepEqual(await started.completion, {
    ok: true, auditId: report.model.auditId, state: 'result', revision: 1,
  });
  assert.equal(recordCalls, 1);
  assert.deepEqual(Reflect.ownKeys(recorded), ['snapshot', 'observedTarget']);
  assert.deepEqual(Reflect.ownKeys(recorded.snapshot), ['model', 'modelRevision', 'modelHash']);
  assert.equal(Object.isFrozen(recorded.snapshot), true);
  assert.equal(recorded.snapshot.model, reportByAudit.get(report.model.auditId).model);
  assert.equal(recorded.snapshot.modelRevision, 1);
  assert.equal(recorded.snapshot.modelHash, report.model.integrity.canonicalModelHash);
  assert.deepEqual(recorded.observedTarget, {
    version: 1,
    kind: 'attached',
    tabId: 17,
    windowId: 9,
    documentId: 'document-a',
    urlSessionDigest: DIGEST,
    urlEvidence: 'https://example.test/',
  });
  assert.equal(Object.isFrozen(recorded.observedTarget), true);
  assert.ok(order.indexOf('commit') < order.indexOf('highlight-binding'));
  assert.ok(order.indexOf('highlight-binding') < order.indexOf('publish:result'));
});

for (const [label, recordHighlightBinding] of [
  ['returns no live binding', async () => null],
  ['cannot persist the live binding', async () => { throw new Error('HIGHLIGHT_REGISTRY_WRITE_DENIED'); }],
]) {
  test(`keeps the canonical audit result evidence-only when binding recording ${label}`, async () => {
    const area = sessionArea();
    const prepared = await authorityFixture(area);
    const report = await reportFixture(`audit-highlight-evidence-only-${label.replaceAll(' ', '-')}`);
    const reportByAudit = new Map();
    let recordCalls = 0;
    const dependencies = dependencyFixture({
      area, authority: prepared.authority, reportByAudit,
      execution: async () => Object.freeze({
        version: 1, auditId: report.model.auditId, state: 'model', failureCode: null,
        model: report.model, checkpoint: report.checkpoint,
      }),
    });
    dependencies.buildPanelResultBundle = ({ reportRevision }) => createPanelResultBundleV1({
      reportRevision, inventory: report.inventory,
    });
    dependencies.recordHighlightBinding = async input => {
      recordCalls += 1;
      try { input.snapshot.model.session.status = 'failed'; } catch { /* the verified snapshot is immutable */ }
      return recordHighlightBinding();
    };

    const started = await createAuthorizedAuditStarter(dependencies).beginAuthorizedAudit({
      capabilityId: prepared.capabilityId, eventNonce: null, auditId: report.model.auditId,
      capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
      retentionPreference: { version: 1, deleteAfterCompleteExport: false }, senderContext: prepared.senderContext,
    });

    assert.deepEqual(await started.completion, {
      ok: true, auditId: report.model.auditId, state: 'result', revision: 1,
    });
    assert.equal(recordCalls, 1);
    const stored = reportByAudit.get(report.model.auditId).model;
    assert.equal(stored.session.status, report.model.session.status);
    assert.deepEqual(
      stored.occurrences.map(occurrence => [occurrence.occurrenceId, occurrence.outcome, occurrence.classification]),
      report.model.occurrences.map(occurrence => [occurrence.occurrenceId, occurrence.outcome, occurrence.classification]),
    );
    assert.equal(stored.integrity.canonicalModelHash, report.model.integrity.canonicalModelHash);
  });
}

test('does not record a live binding when terminal persistence fails and compensates the finalizing job', async () => {
  const area = sessionArea();
  const prepared = await authorityFixture(area);
  const report = await reportFixture('audit-highlight-terminal-compensation');
  let recordCalls = 0;
  const dependencies = dependencyFixture({
    area, authority: prepared.authority,
    execution: async ({ onCheckpoint, persistAuditModel }) => {
      await onCheckpoint(report.checkpoint);
      await persistAuditModel(report.model);
      throw new Error('must stop after terminal persistence denial');
    },
  });
  dependencies.buildPanelResultBundle = ({ reportRevision }) => createPanelResultBundleV1({
    reportRevision, inventory: report.inventory,
  });
  dependencies.commitTerminalAudit = async () => { throw new Error('TERMINAL_COMMIT_DENIED'); };
  dependencies.recordHighlightBinding = async () => { recordCalls += 1; return null; };

  const started = await createAuthorizedAuditStarter(dependencies).beginAuthorizedAudit({
    capabilityId: prepared.capabilityId, eventNonce: null, auditId: report.model.auditId,
    capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    retentionPreference: { version: 1, deleteAfterCompleteExport: false }, senderContext: prepared.senderContext,
  });

  assert.deepEqual(await started.completion, {
    ok: true, auditId: report.model.auditId, state: 'revoked', code: 'AUDIT_INTERRUPTED',
  });
  assert.equal(recordCalls, 0);
  assert.equal(Object.hasOwn(area.values, ACTIVE_AUDIT_JOB_KEY), false);
  assert.equal(Object.hasOwn(area.values, retentionPreferenceStorageKey(report.model.auditId)), false);
});

test('compensates a false bootstrap publication instead of reporting a running audit', async () => {
  const area = sessionArea();
  const prepared = await authorityFixture(area);
  let executions = 0;
  const dependencies = dependencyFixture({
    area, authority: prepared.authority,
    execution: async () => { executions += 1; },
  });
  dependencies.panelCoordinator = panelCoordinator([], { publishRegisteredBootstrap: async () => false });
  const starter = createAuthorizedAuditStarter(dependencies);

  const started = await starter.beginAuthorizedAudit({
    capabilityId: prepared.capabilityId, eventNonce: null, auditId: 'audit-bootstrap-false',
    capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    retentionPreference: { version: 1, deleteAfterCompleteExport: false }, senderContext: prepared.senderContext,
  });

  assert.deepEqual(started.response, { ok: false, code: 'AUDIT_START_FAILED' });
  assert.equal(started.sessionCapabilityId, null);
  assert.equal(executions, 0);
  assert.equal(Object.hasOwn(area.values, ACTIVE_AUDIT_JOB_KEY), false);
  assert.equal(Object.hasOwn(area.values, retentionPreferenceStorageKey('audit-bootstrap-false')), false);
  assert.equal(Object.hasOwn(area.values, 'audita:start-journal:v1'), false);
});

test('journal removal failure after ACTIVE triggers complete verified start compensation', async () => {
  const area = sessionArea();
  const prepared = await authorityFixture(area);
  const latest = { value: null };
  let executions = 0;
  const originalRemove = area.remove.bind(area);
  let journalRemovals = 0;
  area.remove = async key => {
    if (key === 'audita:start-journal:v1' && journalRemovals++ === 0) return;
    return originalRemove(key);
  };
  const dependencies = dependencyFixture({
    area, authority: prepared.authority, latest,
    execution: async () => { executions += 1; },
  });
  dependencies.panelCoordinator = panelCoordinator([], {
    async registerPendingBootstrap(value) {
      area.values[panelBootstrapStorageKey(value.windowId)] = {
        version: 1, kind: 'audit-session', ...structuredClone(value), state: 'pending',
      };
      return true;
    },
    async publishRegisteredBootstrap(value) {
      return true;
    },
    async publishResult() { return true; },
    async disconnectSession({ auditId, sessionCapabilityId, windowId }) {
      const key = panelBootstrapStorageKey(windowId);
      const bootstrap = area.values[key];
      if (bootstrap && bootstrap.auditId === auditId && bootstrap.sessionCapabilityId === sessionCapabilityId) delete area.values[key];
      return !Object.hasOwn(area.values, key);
    },
  });
  const starter = createAuthorizedAuditStarter(dependencies);

  const started = await starter.beginAuthorizedAudit({
    capabilityId: prepared.capabilityId, eventNonce: null, auditId: 'audit-active-compensation',
    capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    retentionPreference: { version: 1, deleteAfterCompleteExport: false }, senderContext: prepared.senderContext,
  });

  assert.deepEqual(started.response, { ok: false, code: 'AUDIT_START_FAILED' });
  assert.equal(executions, 0);
  assert.equal(Object.hasOwn(area.values, ACTIVE_AUDIT_JOB_KEY), false);
  assert.equal(Object.hasOwn(area.values, executionCheckpointStorageKey('audit-active-compensation')), false);
  assert.equal(Object.hasOwn(area.values, panelBootstrapStorageKey(9)), false);
  assert.equal(Object.hasOwn(area.values, retentionPreferenceStorageKey('audit-active-compensation')), false);
  assert.equal(Object.hasOwn(area.values, 'audita:start-journal:v1'), false);
  assert.equal(latest.value.auditId, 'audit-active-compensation');
  assert.equal(latest.value.failureCode, 'AUDIT_FAILED');
  const correlation = await readAttachedAuditCorrelationForRecovery({
    sessionArea: area, capabilityId: prepared.capabilityId, auditId: 'audit-active-compensation',
  });
  assert.equal(correlation.targetState, 'invalidated');
  const revoked = await readAuditSessionForWorker({
    sessionArea: area, sessionCapabilityId: correlation.sessionCapabilityId, auditId: 'audit-active-compensation',
  });
  assert.equal(revoked.state, 'revoked');
});

test('incomplete post-ACTIVE compensation returns recovery-required and keeps ACTIVE recoverable', async () => {
  const area = sessionArea();
  const prepared = await authorityFixture(area);
  const originalRemove = area.remove.bind(area);
  let journalRemovals = 0;
  area.remove = async key => {
    if (key === 'audita:start-journal:v1' && journalRemovals++ === 0) return;
    return originalRemove(key);
  };
  const dependencies = dependencyFixture({
    area, authority: prepared.authority,
    execution: async () => { throw new Error('must not run'); },
  });
  dependencies.panelCoordinator = panelCoordinator([], { disconnectSession: async () => false });

  const started = await createAuthorizedAuditStarter(dependencies).beginAuthorizedAudit({
    capabilityId: prepared.capabilityId, eventNonce: null, auditId: 'audit-compensation-blocked',
    capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    retentionPreference: { version: 1, deleteAfterCompleteExport: false }, senderContext: prepared.senderContext,
  });

  assert.deepEqual(started.response, { ok: false, code: 'AUDIT_RECOVERY_REQUIRED' });
  const active = await readActiveAuditJobForWorker({ sessionArea: area });
  assert.equal(active.auditId, 'audit-compensation-blocked');
});

test('recovers a durable running job as interrupted without resuming collection', async () => {
  const area = sessionArea();
  const prepared = await authorityFixture(area);
  const never = new Promise(() => {});
  const latest = { value: null };
  let executionCalls = 0;
  const dependencies = dependencyFixture({
    area, authority: prepared.authority, latest,
    execution: async () => { executionCalls += 1; return never; },
  });
  const starter = createAuthorizedAuditStarter(dependencies);
  const started = await starter.beginAuthorizedAudit({
    capabilityId: prepared.capabilityId, eventNonce: null, auditId: 'audit-recover-running',
    capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    retentionPreference: { version: 1, deleteAfterCompleteExport: false }, senderContext: prepared.senderContext,
  });
  assert.equal(started.response.ok, true);
  const recovered = createAuthorizedAuditStarter(dependencyFixture({
    area, authority: prepared.authority, latest,
    execution: async () => { throw new Error('must not resume'); },
  }));
  assert.deepEqual(await recovered.recoverAuthorizedAuditLifecycle(), {
    ok: true, state: 'interrupted', auditId: 'audit-recover-running', revision: null,
  });
  assert.equal(executionCalls, 1);
  assert.equal(latest.value.failureCode, 'AUDIT_INTERRUPTED');
  assert.equal(Object.hasOwn(area.values, ACTIVE_AUDIT_JOB_KEY), false);
});

test('running recovery preserves a supported foreign legacy export latest record', async () => {
  const area = sessionArea();
  const prepared = await authorityFixture(area);
  const latest = { value: null };
  const starter = createAuthorizedAuditStarter(dependencyFixture({
    area, authority: prepared.authority, latest,
    execution: async () => new Promise(() => {}),
  }));
  const started = await starter.beginAuthorizedAudit({
    capabilityId: prepared.capabilityId, eventNonce: null, auditId: 'audit-recover-foreign-latest',
    capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    retentionPreference: { version: 1, deleteAfterCompleteExport: false }, senderContext: prepared.senderContext,
  });
  assert.equal(started.response.ok, true);
  latest.value = {
    auditId: 'foreign-export-audit', status: 'complete', exportStatus: 'queued', exportRevision: 3,
  };

  const recovered = createAuthorizedAuditStarter(dependencyFixture({
    area, authority: prepared.authority, latest,
    execution: async () => { throw new Error('must not resume'); },
  }));
  assert.deepEqual(await recovered.recoverAuthorizedAuditLifecycle(), {
    ok: true, state: 'interrupted', auditId: 'audit-recover-foreign-latest', revision: null,
  });
  assert.deepEqual(latest.value, {
    auditId: 'foreign-export-audit', status: 'complete', exportStatus: 'queued', exportRevision: 3,
  });
});

test('running recovery blocks and retains ACTIVE when durable panel cleanup cannot be confirmed', async () => {
  const area = sessionArea();
  const prepared = await authorityFixture(area);
  const latest = { value: null };
  const starter = createAuthorizedAuditStarter(dependencyFixture({
    area, authority: prepared.authority, latest,
    execution: async () => new Promise(() => {}),
  }));
  const started = await starter.beginAuthorizedAudit({
    capabilityId: prepared.capabilityId, eventNonce: null, auditId: 'audit-recovery-cleanup-blocked',
    capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    retentionPreference: { version: 1, deleteAfterCompleteExport: false }, senderContext: prepared.senderContext,
  });
  assert.equal(started.response.ok, true);
  const dependencies = dependencyFixture({
    area, authority: prepared.authority, latest,
    execution: async () => { throw new Error('must not resume'); },
  });
  dependencies.panelCoordinator = panelCoordinator([], { disconnectSession: async () => false });

  assert.deepEqual(await createAuthorizedAuditStarter(dependencies).recoverAuthorizedAuditLifecycle(), {
    ok: false, state: 'blocked', auditId: null, revision: null, code: 'AUDIT_RECOVERY_REQUIRED',
  });
  const active = await readActiveAuditJobForWorker({ sessionArea: area });
  assert.equal(active.auditId, 'audit-recovery-cleanup-blocked');
});

test('prepared-journal recovery blocks and preserves a concurrent replacement during cleanup', async () => {
  const area = sessionArea();
  const prepared = await authorityFixture(area);
  area.values['audita:start-journal:v1'] = {
    version: 1, capabilityId: prepared.capabilityId, auditId: 'audit-prepared-replacement', windowId: 9,
    state: 'prepared', sessionCapabilityId: null, createdAt: EPOCH, updatedAt: EPOCH,
  };
  const replacement = {
    version: 1, capabilityId: 'R'.repeat(22), auditId: 'foreign-replacement', windowId: 11,
    state: 'prepared', sessionCapabilityId: null, createdAt: EPOCH + 1, updatedAt: EPOCH + 1,
  };
  const originalRemove = area.remove.bind(area);
  area.remove = async key => {
    if (key === 'audita:start-journal:v1') {
      area.values[key] = structuredClone(replacement);
      return;
    }
    return originalRemove(key);
  };
  const recovery = await createAuthorizedAuditStarter(dependencyFixture({
    area, authority: prepared.authority,
    execution: async () => { throw new Error('must not resume'); },
  })).recoverAuthorizedAuditLifecycle();

  assert.deepEqual(recovery, {
    ok: false, state: 'blocked', auditId: null, revision: null, code: 'AUDIT_RECOVERY_REQUIRED',
  });
  assert.deepEqual(area.values['audita:start-journal:v1'], replacement);
});

test('revoked settlement blocks and retains recoverable ACTIVE when durable panel cleanup fails', async () => {
  const area = sessionArea();
  const prepared = await authorityFixture(area);
  const dependencies = dependencyFixture({
    area, authority: prepared.authority,
    execution: async () => Object.freeze({
      version: 1, auditId: 'audit-settlement-blocked', state: 'revoked',
      failureCode: 'AUDIT_FAILED', model: null, checkpoint: null,
    }),
  });
  dependencies.panelCoordinator = panelCoordinator([], { disconnectSession: async () => false });
  const started = await createAuthorizedAuditStarter(dependencies).beginAuthorizedAudit({
    capabilityId: prepared.capabilityId, eventNonce: null, auditId: 'audit-settlement-blocked',
    capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    retentionPreference: { version: 1, deleteAfterCompleteExport: false }, senderContext: prepared.senderContext,
  });

  assert.deepEqual(await started.completion, {
    ok: false, auditId: 'audit-settlement-blocked', state: 'blocked', code: 'AUDIT_RECOVERY_REQUIRED',
  });
  const active = await readActiveAuditJobForWorker({ sessionArea: area });
  assert.equal(active.auditId, 'audit-settlement-blocked');
  assert.equal(active.state, 'running');
});

test('revoked settlement succeeds without a live port after correlated durable bootstrap cleanup', async () => {
  const area = sessionArea();
  const prepared = await authorityFixture(area);
  const dependencies = dependencyFixture({
    area, authority: prepared.authority,
    execution: async () => Object.freeze({
      version: 1, auditId: 'audit-no-live-settlement', state: 'revoked',
      failureCode: 'AUDIT_FAILED', model: null, checkpoint: null,
    }),
  });
  dependencies.panelCoordinator = panelCoordinator([], {
    async registerPendingBootstrap(value) {
      area.values[panelBootstrapStorageKey(value.windowId)] = {
        version: 1, kind: 'audit-session', ...structuredClone(value), state: 'pending',
      };
      return true;
    },
    async publishRegisteredBootstrap() { return true; },
    async publishResult() { return false; },
    async disconnectSession({ auditId, sessionCapabilityId, windowId }) {
      const key = panelBootstrapStorageKey(windowId);
      const bootstrap = area.values[key];
      if (!bootstrap || bootstrap.auditId !== auditId || bootstrap.sessionCapabilityId !== sessionCapabilityId) return false;
      delete area.values[key];
      return true;
    },
  });
  const started = await createAuthorizedAuditStarter(dependencies).beginAuthorizedAudit({
    capabilityId: prepared.capabilityId, eventNonce: null, auditId: 'audit-no-live-settlement',
    capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    retentionPreference: { version: 1, deleteAfterCompleteExport: false }, senderContext: prepared.senderContext,
  });

  assert.deepEqual(await started.completion, {
    ok: true, auditId: 'audit-no-live-settlement', state: 'revoked', code: 'AUDIT_FAILED',
  });
  assert.equal(Object.hasOwn(area.values, panelBootstrapStorageKey(9)), false);
  assert.equal(Object.hasOwn(area.values, ACTIVE_AUDIT_JOB_KEY), false);
});

test('native runner messages cannot spoof AUDIT_REVOKED selection', async () => {
  const area = sessionArea();
  const prepared = await authorityFixture(area);
  const started = await createAuthorizedAuditStarter(dependencyFixture({
    area, authority: prepared.authority,
    execution: async () => { throw new Error('AUDIT_REVOKED'); },
  })).beginAuthorizedAudit({
    capabilityId: prepared.capabilityId, eventNonce: null, auditId: 'audit-native-revoked-spoof',
    capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    retentionPreference: { version: 1, deleteAfterCompleteExport: false }, senderContext: prepared.senderContext,
  });

  assert.deepEqual(await started.completion, {
    ok: true, auditId: 'audit-native-revoked-spoof', state: 'revoked', code: 'AUDIT_FAILED',
  });
});

test('blocks starts and recovery on malformed singleton state instead of overwriting it', async () => {
  const area = sessionArea();
  const prepared = await authorityFixture(area);
  area.values[ACTIVE_AUDIT_JOB_KEY] = { version: 1, auditId: 'foreign', state: 'running', secret: 'PRIVATE' };
  const starter = createAuthorizedAuditStarter(dependencyFixture({
    area, authority: prepared.authority, execution: async () => { throw new Error('must not run'); },
  }));
  assert.deepEqual(await starter.recoverAuthorizedAuditLifecycle(), {
    ok: false, state: 'blocked', auditId: null, revision: null, code: 'AUDIT_RECOVERY_REQUIRED',
  });
  const started = await starter.beginAuthorizedAudit({
    capabilityId: prepared.capabilityId, eventNonce: null, auditId: 'audit-blocked',
    capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    retentionPreference: { version: 1, deleteAfterCompleteExport: false }, senderContext: prepared.senderContext,
  });
  assert.deepEqual(started.response, { ok: false, code: 'AUDIT_RECOVERY_REQUIRED' });
  assert.equal(area.values[ACTIVE_AUDIT_JOB_KEY].secret, 'PRIVATE');
});

test('commits a canonical cancelled model exactly once when the runner bypasses persistence', async () => {
  const area = sessionArea();
  const prepared = await authorityFixture(area);
  const report = await reportFixture('audit-cancelled-once', 'cancelled');
  let commits = 0;
  const reportByAudit = new Map();
  const dependencies = dependencyFixture({
    area, authority: prepared.authority, reportByAudit,
    execution: async () => Object.freeze({
      version: 1, auditId: report.model.auditId, state: 'model', failureCode: null,
      model: report.model, checkpoint: report.checkpoint,
    }),
  });
  const originalCommit = dependencies.commitTerminalAudit;
  dependencies.commitTerminalAudit = async value => { commits += 1; return originalCommit(value); };
  dependencies.buildPanelResultBundle = ({ reportRevision }) => createPanelResultBundleV1({ reportRevision, inventory: report.inventory });
  const started = await createAuthorizedAuditStarter(dependencies).beginAuthorizedAudit({
    capabilityId: prepared.capabilityId, eventNonce: null, auditId: report.model.auditId,
    capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    retentionPreference: { version: 1, deleteAfterCompleteExport: false }, senderContext: prepared.senderContext,
  });
  assert.deepEqual(await started.completion, {
    ok: true, auditId: report.model.auditId, state: 'result', revision: 1,
  });
  assert.equal(commits, 1);
});

test('an accepted user cancellation wins before ACTIVE enters finalizing and commits only the cancelled model', async () => {
  const area = sessionArea();
  const prepared = await authorityFixture(area);
  const auditId = 'audit-cancel-before-finalizing';
  const terminal = await reportFixture(auditId);
  const cancelled = await reportFixture(auditId, 'cancelled');
  const reportByAudit = new Map();
  const committedStatuses = [];
  let releaseBundle;
  let reachedBundle;
  const bundleReached = new Promise(resolve => { reachedBundle = resolve; });
  const bundleGate = new Promise(resolve => { releaseBundle = resolve; });
  const execution = async ({ onCheckpoint, persistAuditModel }) => {
    await onCheckpoint(terminal.checkpoint);
    try {
      await persistAuditModel(terminal.model);
      assert.fail('the pre-cancel terminal candidate must not commit');
    } catch {
      await onCheckpoint(cancelled.checkpoint);
      return Object.freeze({
        version: 1, auditId, state: 'model', failureCode: null,
        model: cancelled.model, checkpoint: cancelled.checkpoint,
      });
    }
  };
  const dependencies = dependencyFixture({ area, authority: prepared.authority, execution, reportByAudit });
  const commit = dependencies.commitTerminalAudit;
  dependencies.commitTerminalAudit = async value => {
    committedStatuses.push(value.model.session.status);
    return commit(value);
  };
  dependencies.buildPanelResultBundle = async ({ reportRevision }) => {
    if (reportRevision.model.session.status !== 'cancelled') {
      reachedBundle();
      await bundleGate;
    }
    return createPanelResultBundleV1({ reportRevision, inventory: terminal.inventory });
  };
  const starter = createAuthorizedAuditStarter(dependencies);
  const started = await starter.beginAuthorizedAudit({
    capabilityId: prepared.capabilityId, eventNonce: null, auditId,
    capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    retentionPreference: { version: 1, deleteAfterCompleteExport: false }, senderContext: prepared.senderContext,
  });
  await bundleReached;

  const cancellation = await starter.abortAuthorizedAudit({
    auditId, sessionCapabilityId: started.sessionCapabilityId, windowId: 9, reasonCode: 'USER_CANCELLED',
  });
  releaseBundle();
  const completion = await started.completion;

  assert.deepEqual(cancellation, { ok: true, auditId, state: 'cancelling' });
  assert.deepEqual(completion, { ok: true, auditId, state: 'result', revision: 1 });
  assert.deepEqual(committedStatuses, ['cancelled']);
  assert.equal(reportByAudit.get(auditId).model.session.status, 'cancelled');
  const session = await readAuditSessionForWorker({
    sessionArea: area, sessionCapabilityId: started.sessionCapabilityId, auditId,
  });
  assert.equal(session.state, 'result');
  assert.equal(Object.hasOwn(area.values, ACTIVE_AUDIT_JOB_KEY), false);
});

test('finalizing fallback reconciles a witnessed commit after the commit adapter return is denied', async () => {
  const area = sessionArea();
  const prepared = await authorityFixture(area);
  const report = await reportFixture('audit-finalizing-fallback');
  const reportByAudit = new Map();
  const dependencies = dependencyFixture({
    area, authority: prepared.authority, reportByAudit,
    execution: async ({ onCheckpoint, persistAuditModel }) => {
      await onCheckpoint(report.checkpoint);
      await persistAuditModel(report.model);
      throw new Error('must not continue after denied adapter return');
    },
  });
  const commit = dependencies.commitTerminalAudit;
  dependencies.commitTerminalAudit = async value => {
    await commit(value);
    return Object.freeze({ revision: 1, modelHash: '0'.repeat(64) });
  };
  dependencies.buildPanelResultBundle = ({ reportRevision }) => createPanelResultBundleV1({
    reportRevision, inventory: report.inventory,
  });
  const started = await createAuthorizedAuditStarter(dependencies).beginAuthorizedAudit({
    capabilityId: prepared.capabilityId, eventNonce: null, auditId: report.model.auditId,
    capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    retentionPreference: { version: 1, deleteAfterCompleteExport: false }, senderContext: prepared.senderContext,
  });

  assert.deepEqual(await started.completion, {
    ok: true, auditId: report.model.auditId, state: 'result', revision: 1,
  });
  assert.equal(Object.hasOwn(area.values, ACTIVE_AUDIT_JOB_KEY), false);
});

test('settlement blocks with finalizing ACTIVE when result publication returns a non-boolean confirmation', async () => {
  const area = sessionArea();
  const prepared = await authorityFixture(area);
  const report = await reportFixture('audit-publication-confirmation');
  const reportByAudit = new Map();
  const dependencies = dependencyFixture({
    area, authority: prepared.authority, reportByAudit,
    execution: async ({ onCheckpoint, persistAuditModel }) => {
      await onCheckpoint(report.checkpoint);
      await persistAuditModel(report.model);
      return Object.freeze({
        version: 1, auditId: report.model.auditId, state: 'model', failureCode: null,
        model: report.model, checkpoint: report.checkpoint,
      });
    },
  });
  dependencies.buildPanelResultBundle = ({ reportRevision }) => createPanelResultBundleV1({
    reportRevision, inventory: report.inventory,
  });
  dependencies.panelCoordinator = panelCoordinator([], { publishResult: async () => undefined });
  const started = await createAuthorizedAuditStarter(dependencies).beginAuthorizedAudit({
    capabilityId: prepared.capabilityId, eventNonce: null, auditId: report.model.auditId,
    capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    retentionPreference: { version: 1, deleteAfterCompleteExport: false }, senderContext: prepared.senderContext,
  });

  assert.deepEqual(await started.completion, {
    ok: false, auditId: report.model.auditId, state: 'blocked', code: 'AUDIT_RECOVERY_REQUIRED',
  });
  const active = await readActiveAuditJobForWorker({ sessionArea: area });
  assert.equal(active.state, 'finalizing');
  assert.equal(active.commitState, 'confirmed');
});

test('reconciles a confirmed finalizing revision and preserves a different latest audit', async () => {
  const area = sessionArea();
  const prepared = await authorityFixture(area);
  const report = await reportFixture('audit-finalizing-recovery');
  const reportByAudit = new Map();
  const latest = { value: null };
  let committedResolve;
  const committed = new Promise(resolve => { committedResolve = resolve; });
  const execution = async ({ onCheckpoint, persistAuditModel }) => {
    await onCheckpoint(report.checkpoint);
    await persistAuditModel(report.model);
    committedResolve();
    return new Promise(() => {});
  };
  const dependencies = dependencyFixture({ area, authority: prepared.authority, execution, reportByAudit, latest });
  dependencies.buildPanelResultBundle = ({ reportRevision }) => createPanelResultBundleV1({ reportRevision, inventory: report.inventory });
  const first = createAuthorizedAuditStarter(dependencies);
  const started = await first.beginAuthorizedAudit({
    capabilityId: prepared.capabilityId, eventNonce: null, auditId: report.model.auditId,
    capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    retentionPreference: { version: 1, deleteAfterCompleteExport: false }, senderContext: prepared.senderContext,
  });
  assert.equal(started.response.ok, true);
  await committed;
  assert.deepEqual(await readActiveAuditJobForWorker({ sessionArea: area }), {
    version: 1, auditId: report.model.auditId, capabilityId: prepared.capabilityId,
    sessionCapabilityId: started.sessionCapabilityId, windowId: 9, mode: 'attached',
    state: 'finalizing', commitState: 'confirmed', expectedTerminalRevision: 1,
    createdAt: EPOCH + 1, updatedAt: EPOCH + 1,
  });
  latest.value = {
    version: 1, auditId: 'newer-audit', status: 'running', percent: 0,
    message: 'Preparando a auditoria.', failureCode: null, modelRevision: null,
    updatedAt: '2026-08-29T12:00:01.000Z',
  };
  const recoveredDependencies = dependencyFixture({
    area, authority: prepared.authority, reportByAudit, latest,
    execution: async () => { throw new Error('must not resume'); },
  });
  recoveredDependencies.buildPanelResultBundle = ({ reportRevision }) => createPanelResultBundleV1({ reportRevision, inventory: report.inventory });
  const recovery = await createAuthorizedAuditStarter(recoveredDependencies).recoverAuthorizedAuditLifecycle();
  assert.deepEqual(recovery, { ok: true, state: 'reconciled', auditId: report.model.auditId, revision: 1 });
  assert.equal(latest.value.auditId, 'newer-audit');
  assert.equal(Object.hasOwn(area.values, ACTIVE_AUDIT_JOB_KEY), false);
});

test('active-job reader denies storage envelope drift and never returns the first record', async () => {
  const area = sessionArea();
  const record = {
    version: 1, auditId: 'audit-drift', capabilityId: 'A'.repeat(22), sessionCapabilityId: 'B'.repeat(22),
    windowId: 9, mode: 'attached', state: 'running', commitState: 'none', expectedTerminalRevision: null,
    createdAt: EPOCH, updatedAt: EPOCH,
  };
  let reads = 0;
  area.get = async key => {
    reads += 1;
    return { [key]: { ...record, updatedAt: EPOCH + reads - 1 } };
  };
  await assert.rejects(readActiveAuditJobForWorker({ sessionArea: area }), error => error?.message === 'ACTIVE_AUDIT_JOB_DENIED');
  assert.equal(reads, 2);
});
