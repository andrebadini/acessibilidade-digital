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
import { createPanelLaunchAuthority } from '../../src/background/panel-launch-authority.js';
import { runAttachedAuditExecution, runAudit } from '../../src/background/run-audit.js';
import { runBatch } from '../../src/background/run-batch.js';
import {
  PANEL_PORT_NAME,
  createPanelPortCoordinator,
  panelBootstrapStorageKey,
} from '../../src/background/panel-port.js';
import { createTargetOperationQueue } from '../../src/background/target-operation-queue.js';
import {
  createTargetCapabilityAuthority,
  readAttachedAuditCorrelationForRecovery,
  readAuditSessionForWorker,
  readBatchAuditCorrelationForRecovery,
  readNavigationAuditCorrelationForRecovery,
  navigationCapabilityStorageKey,
  sessionCapabilityStorageKey,
  targetCapabilityStorageKey,
} from '../../src/background/target-capabilities.js';
import { createCapturePolicyV1 } from '../../src/core/privacy/capture-policy.js';
import { createInstalledCoreRuleInventory } from '../../src/core/rules/core-rule-inventory.js';
import { enrichAuditForReport } from '../../src/core/report/enrich-audit.js';
import { createAuditModel } from '../../src/core/report/audit-model.js';
import { createPanelResultBundleV1 } from '../../src/panel/panel-result-bundle.js';
import { createPanelSessionPortClient } from '../../src/panel/panel-session-port.js';
import { AXE_PROVENANCE } from '../../src/browser/axe-adapter.js';
import { createPixelCaptureStateV1 } from '../../src/background/pixel-capture-consent.js';
import { createScriptedPixelCommitClockV1 } from '../../src/background/pixel-commit-clock.js';
import { createInMemoryAuditStore } from '../../src/storage/audit-store.js';
import { sanitizeEvidenceUrlV1 } from '../../src/core/privacy/evidence-url.js';
import { normalizeUrlList } from '../../src/core/batch/normalize-url-list.js';
import { SAMPLE_AUDIT } from '../../fixtures/audits/sample-audit.js';
import { reportInput } from '../report/helpers.js';

const DIGEST = `hmac-sha256:${'A'.repeat(43)}`;
const EPOCH = 1_788_000_000_000;
const START_JOURNAL_KEY = 'audita:start-journal:v1';
const PANEL_URL = `chrome-extension://abcdefghijklmnopabcdefghijklmnop/src/panel/index.html?launch=${'L'.repeat(43)}`;

function attachedCopyStartJournal({
  capabilityId, auditId, ownershipId, state = 'copy-preparing', sessionCapabilityId = null,
}) {
  return {
    version: 1,
    capabilityId,
    auditId,
    windowId: 9,
    mode: 'single',
    navigationPurpose: 'attached-copy',
    ownershipId,
    state,
    sessionCapabilityId,
    createdAt: EPOCH + 1,
    updatedAt: EPOCH + 1,
  };
}

function pixelCommitClock() {
  return createScriptedPixelCommitClockV1({
    epochs: [EPOCH + 1, ...Array(255).fill(EPOCH + 1_000)],
  });
}

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

function persistedBatchProgress(auditId) {
  const storage = sessionArea();
  const record = {
    auditId,
    pages: [
      { pageId: 'page-1', state: 'completed', model: structuredClone(SAMPLE_AUDIT) },
      { pageId: 'page-2', state: 'draft', model: structuredClone(SAMPLE_AUDIT) },
    ],
  };
  storage.values[auditId] = structuredClone(record);
  return {
    storage,
    record,
    async discard({ auditId: requestedAuditId }) {
      assert.equal(requestedAuditId, auditId);
      await storage.remove(requestedAuditId);
      return true;
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

async function batchReportFixture(auditId) {
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 8, 1, 12, 0, tick++)).toISOString();
  const entries = normalizeUrlList('https://one.example.test/\nhttps://two.example.test/').entries;
  const model = await runBatch({
    entries,
    batchAuditId: auditId,
    runner: async options => reportInput({
      auditId: options.idFactory(),
      requestedUrl: options.url,
      finalUrl: options.url,
      timestamps: { startedAt: now(), endedAt: now(), generatedAt: now() },
    }),
    chromeAdapter: {
      async emitProgress() {},
      async handoffReport() { return { reviewUrl: null }; },
    },
    now,
    reportOptions: {
      timezone: 'America/Cuiaba', manifestVersion: '1.0.5', rulesVersion: '1.0.0',
      browserVersion: 'Chrome/152.0.0.0', expectedExtensionId: 'abcdefghijklmnopabcdefghijklmnop',
    },
  });
  const inventory = await createInstalledCoreRuleInventory();
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
  return { model, checkpoint, inventory };
}

async function authorityFixture(area, windowId = 9, issuer = { type: 'extension-document', documentId: 'panel-doc', path: '/src/panel/index.html' }) {
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
    issuer,
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
    async publishResult(value) {
      order.push(`publish:${value.state}`);
      return issueDeferredTerminalDelivery(value);
    },
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

async function issueDeferredTerminalDelivery(value) {
  const deliveryArea = sessionArea();
  deliveryArea.values[panelBootstrapStorageKey(value.windowId)] = {
    version: 1, kind: 'audit-session', auditId: value.auditId,
    sessionCapabilityId: value.sessionCapabilityId, windowId: value.windowId,
    createdAt: EPOCH, expiresAt: EPOCH + 10_000, state: 'consumed',
  };
  const coordinator = createPanelPortCoordinator({
    chromeApi: { runtime: { id: 'abcdefghijklmnopabcdefghijklmnop' } },
    sessionArea: deliveryArea,
    async readActiveJob() { return null; },
    async readAuditSession() {
      return {
        version: 1, sessionCapabilityId: value.sessionCapabilityId, auditId: value.auditId,
        windowId: value.windowId, mode: 'attached',
        targetBinding: {
          kind: 'attached', tabId: 17, documentId: 'document-a', urlSessionDigest: DIGEST,
        },
        state: value.state, issuedAt: EPOCH, expiresAt: EPOCH + 10_000,
      };
    },
    async readPixelSuspension() { return null; },
    async loadPanelResultBundle() { return null; },
    async rehydrateViewOnly() { return null; },
    async revokeViewOnly() { return false; },
    epochNow: () => EPOCH + 1,
    setTimer() { return Object.freeze({}); },
    clearTimer() {},
    launchAuthority: {
      async admitPort() { return Object.freeze({ ok: false, code: 'PANEL_LAUNCH_DENIED' }); },
      async reprove() { return Object.freeze({ ok: false, code: 'PANEL_LAUNCH_DENIED' }); },
      async retirePort() { return Object.freeze({ version: 1, state: 'denied' }); },
      async revoke() { return Object.freeze({ ok: true, revoked: true }); },
    },
    async dispatchPanelIntent() { return Object.freeze({ ok: false, code: 'FEATURE_UNAVAILABLE' }); },
    async authorizeHighlightSession() { return Object.freeze({ ok: false }); },
  });
  return coordinator.withWindowLock(value.windowId, scope => scope.publishResult(value));
}

function panelEvent() {
  const listeners = new Set();
  return Object.freeze({
    addListener(listener) { listeners.add(listener); },
    removeListener(listener) { listeners.delete(listener); },
    emit(...args) { for (const listener of [...listeners]) listener(...args); },
  });
}

function attachedPanelPort({ failState = null } = {}) {
  const onMessage = panelEvent();
  const onDisconnect = panelEvent();
  return {
    name: PANEL_PORT_NAME,
    sender: {
      id: 'abcdefghijklmnopabcdefghijklmnop', url: PANEL_URL,
      origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
    },
    onMessage, onDisconnect, messages: [], disconnects: 0,
    postMessage(message) {
      if (message.state === failState) throw new Error('PRIVATE_RESULT_POST_FAILURE');
      this.messages.push(structuredClone(message));
    },
    disconnect() { this.disconnects += 1; onDisconnect.emit(); },
  };
}

function admittedPanelLaunchAuthority(retirementState = 'released') {
  return Object.freeze({
    async admitPort({ sender }) {
      return Object.freeze({
        ok: true, token: 'L'.repeat(43), tabId: 17, windowId: 9, generation: 1,
        contextId: 'panel-context', documentId: 'panel-doc', url: sender.url,
        syntheticSender: Object.freeze({ ...sender, documentId: 'panel-doc' }),
      });
    },
    async reprove(admission) { return admission; },
    async retirePort() { return Object.freeze({ version: 1, state: retirementState }); },
    async revoke() { return Object.freeze({ ok: true, revoked: true }); },
  });
}

function linkedPanelPortPair({ sender, coordinator, failResult }) {
  const clientMessage = panelEvent();
  const clientDisconnect = panelEvent();
  const serverMessage = panelEvent();
  const serverDisconnect = panelEvent();
  let connected = true;
  const close = () => {
    if (!connected) return;
    connected = false;
    serverDisconnect.emit();
    clientDisconnect.emit();
  };
  const client = {
    onMessage: clientMessage,
    onDisconnect: clientDisconnect,
    postMessage(value) {
      if (!connected) throw new Error('PORT_DISCONNECTED');
      serverMessage.emit(structuredClone(value));
    },
    disconnect: close,
  };
  const server = {
    name: PANEL_PORT_NAME,
    sender,
    onMessage: serverMessage,
    onDisconnect: serverDisconnect,
    postMessage(value) {
      if (!connected) throw new Error('PORT_DISCONNECTED');
      if (failResult && value?.state === 'result') {
        failResult();
        throw new Error('PRIVATE_RESULT_POST_FAILURE');
      }
      clientMessage.emit(structuredClone(value));
    },
    disconnect: close,
  };
  assert.equal(coordinator.attachPanelPort(server), true);
  return client;
}

async function waitUntil(predicate, attempts = 25) {
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail('condition was not reached');
}

function durablePanelCoordinator({
  area,
  pixelState,
  epochNow = () => EPOCH + 3,
  loadPanelResultBundle = async () => null,
  rehydrateViewOnly = async () => null,
  revokeViewOnly = async () => false,
  launchAuthority = null,
}) {
  const coordinator = createPanelPortCoordinator({
    chromeApi: { runtime: { id: 'abcdefghijklmnopabcdefghijklmnop' } },
    sessionArea: area,
    readActiveJob: () => readActiveAuditJobForWorker({ sessionArea: area }),
    readAuditSession: ({ sessionCapabilityId, auditId }) => readAuditSessionForWorker({
      sessionArea: area, sessionCapabilityId, auditId,
    }),
    readPixelSuspension: auditId => pixelState.readSuspension(auditId),
    loadPanelResultBundle,
    rehydrateViewOnly,
    revokeViewOnly,
    epochNow,
    setTimer() { return Object.freeze({}); },
    clearTimer() {},
    launchAuthority: launchAuthority ?? {
      async admitPort() { return Object.freeze({ ok: false, code: 'PANEL_LAUNCH_DENIED' }); },
      async reprove() { return Object.freeze({ ok: false, code: 'PANEL_LAUNCH_DENIED' }); },
      async retirePort() { return Object.freeze({ version: 1, state: 'denied' }); },
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
    pixelCommitClock: pixelCommitClock(),
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
    async prepareAttachedCopyPlan() { throw new Error('ATTACHED_COPY_PLAN_MUST_NOT_BE_USED'); },
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
    pixelCommitClock: pixelCommitClock(),
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
    prepareAttachedCopyPlan: touched('prepareAttachedCopyPlan'),
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

test('batch starter requires a terminal progress discard dependency', async () => {
  const area = sessionArea();
  const { authority } = await authorityFixture(area);
  const dependencies = dependencyFixture({ area, authority, execution: async () => {} });
  Object.assign(dependencies, {
    runUrlAuditExecution: async () => {},
    clearUrlAuditResources: async () => true,
    runBatchAuditExecution: async () => {},
    clearBatchAuditResources: async () => true,
    clearBatchAuditProgress: async () => true,
    discardBatchAuditProgress: async () => true,
  });
  assert.doesNotThrow(() => createAuthorizedAuditStarter(dependencies));
  dependencies.discardBatchAuditProgress = null;
  assert.throws(() => createAuthorizedAuditStarter(dependencies), /AUTHORIZED_AUDIT_STARTER_INVALID/u);
});

test('starter rejects an unbranded pixel commit clock before any dependency effect', () => {
  for (const invalidClock of [
    Object.freeze(Object.create(null)),
    {},
    { ...pixelCommitClock() },
    new Proxy(pixelCommitClock(), {}),
  ]) {
    const { dependencies, effects } = capturePolicyGateHarness();
    dependencies.pixelCommitClock = invalidClock;
    assert.throws(() => createAuthorizedAuditStarter(dependencies), /AUTHORIZED_AUDIT_STARTER_INVALID/u);
    assert.deepEqual(effects, []);
  }

  const { dependencies, effects } = capturePolicyGateHarness();
  assert.doesNotThrow(() => createAuthorizedAuditStarter(dependencies));
  assert.deepEqual(effects, []);
});

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

// Set up an explicitly exchanged legacy copy through the retained URL boundary.
// New current-page starts must never use this historical setup.
async function beginHistoricalAttachedCopy(starter, dependencies, input) {
  const plan = await dependencies.prepareAttachedCopyPlan({
    capabilityId: input.capabilityId, auditId: input.auditId, senderContext: input.senderContext,
    expectedTarget: { tabId: 17, windowId: 9, documentId: 'document-a', urlSessionDigest: DIGEST },
  });
  const { eventNonce: _eventNonce, ...urlInput } = input;
  return starter.beginAuthorizedUrlAudit({ ...urlInput, plan });
}

test('current-page admission preserves the attached document even when URL auditing is installed', async t => {
  for (const variant of ['no-pixels', 'element-only', 'full-evidence', 'worker-event']) await t.test(variant, async () => {
    const mode = variant === 'worker-event' ? 'no-pixels' : variant;
    const eventNonce = variant === 'worker-event' ? 'event-nonce-12345678901234567890' : null;
    const area = sessionArea();
    const prepared = await authorityFixture(area, 9, eventNonce ? { type: 'worker-event', event: 'context-menu', eventNonce } : undefined);
    const auditId = `audit-current-passive-${mode}`;
    let executions = 0;
    let copies = 0;
    const dependencies = dependencyFixture({
      area, authority: prepared.authority,
      execution: async args => {
        executions += 1;
        assert.equal(args.target.kind, 'attached');
        assert.equal(args.target.tabId, 17);
        assert.equal(args.target.documentId, 'document-a');
        assert.equal(args.target.windowId, 9);
        assert.equal(args.target.initialUrlSessionDigest, DIGEST);
        assert.equal(args.capturePolicy.mode, mode);
        assert.equal(Boolean(args.privacyGate), mode !== 'no-pixels');
        return Object.freeze({ version: 1, auditId, state: 'revoked', failureCode: 'AUDIT_FAILED', model: null, checkpoint: null });
      },
    });
    dependencies.prepareAttachedCopyPlan = async () => { copies += 1; throw new Error('copy must not be prepared'); };
    dependencies.runUrlAuditExecution = async () => { copies += 1; throw new Error('URL execution must not run'); };
    dependencies.clearUrlAuditResources = async () => { copies += 1; return true; };
    const started = await createAuthorizedAuditStarter(dependencies).beginAuthorizedAudit({
      capabilityId: prepared.capabilityId, eventNonce, auditId,
      capturePolicy: createCapturePolicyV1({ mode, includeQuery: false }),
      retentionPreference: { version: 1, deleteAfterCompleteExport: false }, senderContext: eventNonce ? null : prepared.senderContext,
    });
    assert.equal(started.response.ok, true);
    await started.completion;
    assert.equal(executions, 1);
    assert.equal(copies, 0);
  });
});

test('historical attached-copy plan settles both owner graphs removed', async () => {
  const area = sessionArea();
  const { authority, capabilityId, senderContext } = await authorityFixture(area);
  const auditId = 'audit-current-page-copy';
  const ownershipId = `owner_${'C'.repeat(22)}`;
  const report = await reportFixture(auditId);
  const reportByAudit = new Map();
  const order = [];
  let attachedExecutions = 0;
  const dependencies = dependencyFixture({
    area, authority, order, reportByAudit,
    execution: async () => { attachedExecutions += 1; throw new Error('ATTACHED_EXECUTION_MUST_NOT_RUN'); },
  });
  dependencies.prepareAttachedCopyPlan = async input => {
    order.push('prepare-copy');
    assert.deepEqual(input, {
      capabilityId,
      auditId,
      senderContext,
      expectedTarget: {
        tabId: 17, windowId: 9, documentId: 'document-a', urlSessionDigest: DIGEST,
      },
    });
    assert.equal((await authority.exchangeAttachedForNavigationCopy({
      capabilityId,
      intent: 'attached-copy',
      senderContext,
    })).ok, true);
    return Object.freeze({
      kind: 'attached-copy', ownershipId, navigationToken: 'C'.repeat(22),
      navigationPurpose: 'attached-copy',
      evidenceUrl: sanitizeEvidenceUrlV1('https://example.test/private?never=public', { includeQuery: false }),
      sessionDigest: DIGEST,
    });
  };
  dependencies.runUrlAuditExecution = async args => {
    order.push('run-copy');
    await args.onCheckpoint(report.checkpoint);
    const observedTarget = Object.freeze({
      version: 'ObservedTargetV1', kind: 'owned-disposable', ownershipId,
      tabId: 27, windowId: 9, documentId: 'copy-document',
      urlEvidence: sanitizeEvidenceUrlV1('https://example.test/private', { includeQuery: false }),
      urlSessionDigest: DIGEST, cleanupMode: 'always', pageId: 'page-1',
    });
    await args.persistAuditModel(report.model, observedTarget);
    return Object.freeze({
      status: 'complete', model: report.model, observedTarget,
      observationState: 'observed', ownershipState: 'removed',
    });
  };
  const cleanups = [];
  dependencies.clearUrlAuditResources = async request => {
    cleanups.push(structuredClone(request));
    return true;
  };

  let started;
  try {
    started = await beginHistoricalAttachedCopy(createAuthorizedAuditStarter(dependencies), dependencies, {
      capabilityId, eventNonce: null, auditId,
      capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
      retentionPreference: { version: 1, deleteAfterCompleteExport: false },
      senderContext,
    });
  } catch (error) {
    assert.fail(error?.stack ?? JSON.stringify(error));
  }

  assert.deepEqual(started.response, { ok: true, auditId, state: 'running' });
  assert.deepEqual(await started.completion, { ok: true, auditId, state: 'result', revision: 1 });
  assert.equal(attachedExecutions, 0);
  assert.equal(order.includes('prepare-copy'), true);
  assert.equal(order.includes('run-copy'), true);
  assert.deepEqual(cleanups, [{
    auditId, ownershipId, navigationPurpose: 'attached-copy', cleanupMode: 'always',
  }]);
  const session = await readAuditSessionForWorker({
    sessionArea: area, sessionCapabilityId: started.sessionCapabilityId, auditId,
  });
  assert.equal(session.state, 'result');
  assert.deepEqual(session.targetBinding, { kind: 'disposable', ownershipId, state: 'removed' });
  assert.equal(reportByAudit.has(auditId), true);
  assert.doesNotMatch(JSON.stringify({ report: reportByAudit.get(auditId), latest: area.values.latest }),
    /never=public|CCCCCCCCCCCCCCCCCCCCCC|owner_C|hmac-sha256:A/iu);
});

test('restart completes attached-copy cleanup after crash between invalidation and ACTIVE removal', async () => {
  const area = sessionArea();
  const { authority, capabilityId, senderContext } = await authorityFixture(area);
  const auditId = 'audit-copy-post-invalidation-crash';
  const ownershipId = `owner_${'R'.repeat(22)}`;
  const latest = { value: null };
  const firstDependencies = dependencyFixture({
    area,
    authority,
    latest,
    execution: async () => { throw new Error('ATTACHED_EXECUTION_MUST_NOT_RUN'); },
  });
  firstDependencies.prepareAttachedCopyPlan = async () => {
    assert.equal((await authority.exchangeAttachedForNavigationCopy({
      capabilityId,
      intent: 'attached-copy',
      senderContext,
    })).ok, true);
    return Object.freeze({
      kind: 'attached-copy',
      ownershipId,
      navigationToken: 'R'.repeat(22),
      navigationPurpose: 'attached-copy',
      evidenceUrl: sanitizeEvidenceUrlV1('https://example.test/private', { includeQuery: false }),
      sessionDigest: DIGEST,
    });
  };
  firstDependencies.runUrlAuditExecution = async () => Object.freeze({
    status: 'failed',
    model: null,
    observedTarget: null,
    observationState: 'pre-observation-failure',
    ownershipState: 'removed',
  });
  firstDependencies.clearUrlAuditResources = async () => true;
  firstDependencies.panelCoordinator = panelCoordinator([], {
    async disconnectSession() { return false; },
  });

  const started = await beginHistoricalAttachedCopy(createAuthorizedAuditStarter(firstDependencies), firstDependencies, {
    capabilityId,
    eventNonce: null,
    auditId,
    capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    retentionPreference: { version: 1, deleteAfterCompleteExport: false },
    senderContext,
  });

  assert.deepEqual(await started.completion, {
    ok: false, auditId, state: 'blocked', code: 'AUDIT_RECOVERY_REQUIRED',
  });
  const crashCut = await readNavigationAuditCorrelationForRecovery({
    sessionArea: area,
    capabilityId,
    auditId,
  });
  assert.equal(crashCut.capabilityState, 'invalidated');
  assert.equal(crashCut.sessionState, 'revoked');
  assert.equal(crashCut.ownershipState, 'removed');
  assert.equal((await readActiveAuditJobForWorker({ sessionArea: area })).auditId, auditId);

  const recoveryDependencies = dependencyFixture({
    area,
    authority,
    latest,
    execution: async () => { throw new Error('ATTACHED_EXECUTION_MUST_NOT_RUN'); },
  });
  recoveryDependencies.runUrlAuditExecution = async () => { throw new Error('URL_EXECUTION_MUST_NOT_RUN'); };
  recoveryDependencies.clearUrlAuditResources = async () => true;

  const sessionKey = sessionCapabilityStorageKey(crashCut.sessionCapabilityId);
  area.values[sessionKey].state = 'running';
  assert.deepEqual(
    await createAuthorizedAuditStarter(recoveryDependencies).recoverAuthorizedAuditLifecycle(),
    { ok: false, state: 'blocked', auditId: null, revision: null, code: 'AUDIT_RECOVERY_REQUIRED' },
  );
  area.values[sessionKey].state = 'revoked';

  assert.deepEqual(
    await createAuthorizedAuditStarter(recoveryDependencies).recoverAuthorizedAuditLifecycle(),
    { ok: true, state: 'interrupted', auditId, revision: null },
  );
  assert.equal(await readActiveAuditJobForWorker({ sessionArea: area }), null);
});

test('historical attached-copy pixel modes publish after cleanup always', async t => {
  for (const mode of ['full-evidence', 'element-only']) await t.test(mode, async () => {
    const area = sessionArea();
    const { authority, capabilityId, senderContext } = await authorityFixture(area);
    const auditId = `audit-current-page-${mode}`;
    const ownershipId = `owner_${mode === 'full-evidence' ? 'F'.repeat(22) : 'E'.repeat(22)}`;
    const report = await reportFixture(auditId);
    const reportByAudit = new Map();
    const effects = [];
    const dependencies = dependencyFixture({
      area, authority, reportByAudit,
      execution: async () => { effects.push('attached-original'); },
    });
    dependencies.prepareAttachedCopyPlan = async () => {
      effects.push('prepare-copy');
      assert.equal((await authority.exchangeAttachedForNavigationCopy({
        capabilityId, intent: 'attached-copy', senderContext,
      })).ok, true);
      return Object.freeze({
        kind: 'attached-copy', ownershipId, navigationToken: 'C'.repeat(22),
        navigationPurpose: 'attached-copy',
        evidenceUrl: sanitizeEvidenceUrlV1('https://example.test/current?private=never', { includeQuery: false }),
        sessionDigest: DIGEST,
      });
    };
    dependencies.runUrlAuditExecution = async args => {
      effects.push('run-copy');
      assert.equal(args.capturePolicy.mode, mode);
      assert.ok(args.privacyGate);
      await args.onCheckpoint(report.checkpoint);
      const observedTarget = Object.freeze({
        version: 'ObservedTargetV1', kind: 'owned-disposable', ownershipId,
        tabId: 27, windowId: 9, documentId: 'copy-document',
        urlEvidence: sanitizeEvidenceUrlV1('https://example.test/current', { includeQuery: false }),
        urlSessionDigest: DIGEST, cleanupMode: 'always', pageId: 'page-1',
      });
      await args.persistAuditModel(report.model, observedTarget);
      return Object.freeze({
        status: 'complete', model: report.model, observedTarget,
        observationState: 'observed', ownershipState: 'removed',
      });
    };
    const cleanups = [];
    dependencies.clearUrlAuditResources = async request => { cleanups.push(structuredClone(request)); return true; };
    const started = await beginHistoricalAttachedCopy(createAuthorizedAuditStarter(dependencies), dependencies, {
      capabilityId, eventNonce: null, auditId,
      capturePolicy: createCapturePolicyV1({ mode, includeQuery: false }),
      retentionPreference: { version: 1, deleteAfterCompleteExport: false },
      senderContext,
    });
    assert.deepEqual(started.response, { ok: true, auditId, state: 'running' });
    assert.deepEqual(await started.completion, { ok: true, auditId, state: 'result', revision: 1 });
    assert.deepEqual(effects, ['prepare-copy', 'run-copy']);
    assert.deepEqual(cleanups, [{
      auditId, ownershipId, navigationPurpose: 'attached-copy', cleanupMode: 'always',
    }]);
    assert.equal(reportByAudit.has(auditId), true);
    assert.equal(await readActiveAuditJobForWorker({ sessionArea: area }), null);
    const session = await readAuditSessionForWorker({
      sessionArea: area, sessionCapabilityId: started.sessionCapabilityId, auditId,
    });
    assert.deepEqual(session.targetBinding, { kind: 'disposable', ownershipId, state: 'removed' });
    assert.doesNotMatch(JSON.stringify({ report: reportByAudit.get(auditId), effects }), /private=never|owner_/iu);
  });
});

test('attached-copy privacy pause survives failed publication, restart and cancellation', async t => {
  for (const publicationFailure of ['false', 'throw']) await t.test(publicationFailure, async () => {
  const area = sessionArea();
  const prepared = await authorityFixture(area);
  const auditId = 'audit-current-copy-pixel-paused';
  const ownershipId = `owner_${'P'.repeat(22)}`;
  const fixture = await reportFixture(auditId);
  const policy = createCapturePolicyV1({ mode: 'full-evidence', includeQuery: false });
  const pixelState = createPixelCaptureStateV1({
    sessionArea: area, now: () => EPOCH + 2, randomBytes: length => new Uint8Array(length).fill(13),
  });
  const observedTarget = Object.freeze({
    version: 'ObservedTargetV1', kind: 'owned-disposable', ownershipId,
    tabId: 27, windowId: 9, documentId: 'copy-document',
    urlEvidence: sanitizeEvidenceUrlV1('https://example.test/current', { includeQuery: false }),
    urlSessionDigest: `hmac-sha256:${'D'.repeat(43)}`,
    cleanupMode: 'always', pageId: 'page-1',
  });
  const cleanups = [];
  const pausedPackets = [];
  let allowPausePublication = false;
  let executions = 0;
  const dependencies = dependencyFixture({
    area, authority: prepared.authority, pixelState,
    execution: async () => { throw new Error('ORIGINAL_TAB_MUST_STAY_VIEW_ONLY'); },
  });
  dependencies.prepareAttachedCopyPlan = async () => {
    assert.equal((await prepared.authority.exchangeAttachedForNavigationCopy({
      capabilityId: prepared.capabilityId, intent: 'attached-copy', senderContext: prepared.senderContext,
    })).ok, true);
    return Object.freeze({
      kind: 'attached-copy', ownershipId, navigationToken: 'P'.repeat(22),
      navigationPurpose: 'attached-copy',
      evidenceUrl: sanitizeEvidenceUrlV1('https://example.test/current?secret=never', { includeQuery: false }),
      sessionDigest: `hmac-sha256:${'D'.repeat(43)}`,
    });
  };
  dependencies.runUrlAuditExecution = async args => {
    executions += 1;
    await args.onCheckpoint(fixture.checkpoint);
    const decision = await args.privacyGate.preflight({
      auditId, observedTarget, capturePolicy: policy,
      signals: Object.freeze({
        version: 'SensitiveCaptureSignalsV1', detected: true, categories: Object.freeze(['password']),
      }),
    });
    return Object.freeze({
      status: decision.status, model: null, observedTarget,
      observationState: 'observed', ownershipState: 'retained-for-consent',
      signals: Object.freeze({
        version: 'SensitiveCaptureSignalsV1', detected: true, categories: Object.freeze(['password']),
      }),
    });
  };
  dependencies.clearUrlAuditResources = async request => { cleanups.push(structuredClone(request)); return true; };
  dependencies.panelCoordinator = panelCoordinator([], {
    async publishPrivacyPaused(value) {
      pausedPackets.push(structuredClone(value));
      if (allowPausePublication) return true;
      if (publicationFailure === 'throw') throw new Error('PANEL_PUBLICATION_FAILED');
      return false;
    },
  });

  const started = await beginHistoricalAttachedCopy(createAuthorizedAuditStarter(dependencies), dependencies, {
    capabilityId: prepared.capabilityId, eventNonce: null, auditId, capturePolicy: policy,
    retentionPreference: { version: 1, deleteAfterCompleteExport: false },
    senderContext: prepared.senderContext,
  });
  assert.deepEqual(started.response, { ok: true, auditId, state: 'running' });
  assert.deepEqual(await started.completion, {
    ok: false, auditId, state: 'blocked', code: 'AUDIT_RECOVERY_REQUIRED',
  });
  assert.equal(executions, 1);
  assert.deepEqual(cleanups, []);
  assert.equal((await readActiveAuditJobForWorker({ sessionArea: area })).state, 'privacy-paused');
  const suspension = await pixelState.readSuspension(auditId);
  assert.equal(suspension.state, 'paused');
  assert.deepEqual(suspension.source, {
    kind: 'owned-disposable', ownershipId, cleanupMode: 'always', pageId: 'page-1',
  });
  assert.equal((await readNavigationAuditCorrelationForRecovery({
    sessionArea: area, capabilityId: prepared.capabilityId, auditId,
  })).navigationPurpose, 'attached-copy');

  pausedPackets.length = 0;
  allowPausePublication = true;
  const restarted = createAuthorizedAuditStarter(dependencies);
  assert.deepEqual(await restarted.recoverAuthorizedAuditLifecycle(), {
    ok: true, state: 'privacy-paused', auditId, revision: null,
  });
  assert.equal(executions, 1);
  assert.equal(pausedPackets.length, 1);
  assert.deepEqual(await restarted.abortAuthorizedAudit({
    auditId, sessionCapabilityId: started.sessionCapabilityId, windowId: 9, reasonCode: 'USER_CANCELLED',
  }), { ok: true, auditId, state: 'revoked' });
  assert.deepEqual(cleanups, [{
    auditId, ownershipId, navigationPurpose: 'attached-copy', cleanupMode: 'always',
  }]);
  assert.equal(await pixelState.readSuspension(auditId), null);
  assert.equal(await readActiveAuditJobForWorker({ sessionArea: area }), null);
  assert.doesNotMatch(JSON.stringify({ pausedPackets, cleanups }), /secret=never|hmac-sha256|consentId/iu);
  });
});

test('attached-copy consent resume keeps its explicit purpose and cleans before publishing the result', async () => {
  const area = sessionArea();
  const prepared = await authorityFixture(area);
  const auditId = 'audit-current-copy-pixel-resume';
  const ownershipId = `owner_${'Q'.repeat(22)}`;
  const fixture = await reportFixture(auditId);
  const policy = createCapturePolicyV1({ mode: 'element-only', includeQuery: false });
  const pixelState = createPixelCaptureStateV1({
    sessionArea: area,
    now: (() => { let value = EPOCH + 2; return () => value++; })(),
    randomBytes: length => new Uint8Array(length).fill(14),
  });
  const evidence = sanitizeEvidenceUrlV1('https://example.test/current', { includeQuery: false });
  const observedTarget = Object.freeze({
    version: 'ObservedTargetV1', kind: 'owned-disposable', ownershipId,
    tabId: 27, windowId: 9, documentId: 'copy-document', urlEvidence: evidence,
    urlSessionDigest: `hmac-sha256:${'D'.repeat(43)}`,
    cleanupMode: 'always', pageId: 'page-1',
  });
  const signals = Object.freeze({
    version: 'SensitiveCaptureSignalsV1', detected: true, categories: Object.freeze(['password']),
  });
  const order = [];
  let executions = 0;
  const dependencies = dependencyFixture({
    area, authority: prepared.authority, pixelState,
    execution: async () => { throw new Error('ORIGINAL_TAB_MUST_STAY_VIEW_ONLY'); },
    probeDocumentIdentity: async tabId => ({
      tabId, windowId: 9, documentId: 'copy-document',
      urlSessionDigest: `hmac-sha256:${'D'.repeat(43)}`,
    }),
    probeSensitiveCaptureSignals: async () => signals,
  });
  dependencies.prepareAttachedCopyPlan = async () => {
    assert.equal((await prepared.authority.exchangeAttachedForNavigationCopy({
      capabilityId: prepared.capabilityId, intent: 'attached-copy', senderContext: prepared.senderContext,
    })).ok, true);
    return Object.freeze({
      kind: 'attached-copy', ownershipId, navigationToken: 'Q'.repeat(22),
      navigationPurpose: 'attached-copy', evidenceUrl: evidence,
      sessionDigest: `hmac-sha256:${'D'.repeat(43)}`,
    });
  };
  dependencies.runUrlAuditExecution = async args => {
    executions += 1;
    if (executions === 1) {
      await args.onCheckpoint(fixture.checkpoint);
      const decision = await args.privacyGate.preflight({
        auditId, observedTarget, capturePolicy: policy, signals,
      });
      return Object.freeze({
        status: decision.status, model: null, observedTarget,
        observationState: 'observed', ownershipState: 'retained-for-consent', signals,
      });
    }
    assert.deepEqual(args.resumeTarget, {
      kind: 'owned-disposable-resume', ownershipId,
      tabId: 27, windowId: 9, documentId: 'copy-document',
      initialUrlEvidence: evidence,
      initialUrlSessionDigest: `hmac-sha256:${'D'.repeat(43)}`,
      navigationPurpose: 'attached-copy', cleanupMode: 'always', pageId: 'page-1',
    });
    assert.equal((await args.privacyGate.preflight({
      auditId, observedTarget, capturePolicy: policy, signals,
    })).status, 'armed');
    assert.equal((await args.privacyGate.authorizeFirstPixel({
      auditId, observedTarget, capturePolicy: policy,
      proof: {
        tabId: 27, windowId: 9, documentId: 'copy-document',
        urlSessionDigest: `hmac-sha256:${'D'.repeat(43)}`,
      },
      signals,
    })).status, 'ready');
    await args.onCheckpoint(fixture.checkpoint);
    await args.persistAuditModel(fixture.model, observedTarget);
    await args.privacyGate.afterPixels({ auditId, pixelStarted: false });
    return Object.freeze({
      status: 'complete', model: fixture.model, observedTarget,
      observationState: 'observed', ownershipState: 'removed',
    });
  };
  dependencies.clearUrlAuditResources = async request => { order.push(['cleanup', structuredClone(request)]); return true; };
  dependencies.panelCoordinator = panelCoordinator([], {
    async publishPrivacyPaused() { return true; },
    async publishRunningResume() { return true; },
    async publishResult(value) { order.push(['publish']); return issueDeferredTerminalDelivery(value); },
  });
  const starter = createAuthorizedAuditStarter(dependencies);
  const started = await beginHistoricalAttachedCopy(starter, dependencies, {
    capabilityId: prepared.capabilityId, eventNonce: null, auditId, capturePolicy: policy,
    retentionPreference: { version: 1, deleteAfterCompleteExport: false },
    senderContext: prepared.senderContext,
  });
  assert.deepEqual(await started.completion, {
    ok: true, auditId, state: 'privacy-paused', revision: null,
  });
  const resumed = await createAuthorizedAuditStarter(dependencies).resumePrivacyPausedAudit({
    auditId, sessionCapabilityId: started.sessionCapabilityId, windowId: 9, mode: 'element-only',
  });
  assert.deepEqual(resumed.response, { ok: true, auditId, state: 'running' });
  assert.deepEqual(await resumed.completion, { ok: true, auditId, state: 'result', revision: 1 });
  assert.equal(executions, 2);
  assert.deepEqual(order[0], ['cleanup', {
    auditId, ownershipId, navigationPurpose: 'attached-copy', cleanupMode: 'always',
  }]);
  assert.deepEqual(order[1], ['publish']);
  assert.deepEqual(await createAuthorizedAuditStarter(dependencies).resumePrivacyPausedAudit({
    auditId, sessionCapabilityId: started.sessionCapabilityId, windowId: 9, mode: 'element-only',
  }), {
    response: { ok: false, code: 'AUDIT_RESUME_DENIED' }, sessionCapabilityId: null, completion: null,
  });
});

test('current-page admission rejects busy and audit-id collision before preparing an attached copy', async t => {
  for (const row of [
    { name: 'busy', code: 'AUDIT_BUSY' },
    { name: 'collision', code: 'AUDIT_ID_COLLISION' },
  ]) await t.test(row.name, async () => {
    const area = sessionArea();
    const { authority, capabilityId, senderContext } = await authorityFixture(area);
    const auditId = `audit-copy-admission-${row.name}`;
    if (row.name === 'busy') {
      area.values[ACTIVE_AUDIT_JOB_KEY] = {
        version: 1,
        auditId: 'audit-foreign-running',
        capabilityId: 'F'.repeat(22),
        sessionCapabilityId: 'S'.repeat(22),
        windowId: 9,
        mode: 'single',
        state: 'running',
        commitState: 'none',
        expectedTerminalRevision: null,
        createdAt: EPOCH,
        updatedAt: EPOCH,
      };
    }
    const dependencies = dependencyFixture({
      area,
      authority,
      execution: async () => { throw new Error('ATTACHED_EXECUTION_MUST_NOT_RUN'); },
    });
    if (row.name === 'collision') {
      dependencies.readAuditSnapshot = async () => ({ model: {}, revision: 1, capability: {} });
    }
    let preparedCopies = 0;
    dependencies.prepareAttachedCopyPlan = async () => {
      preparedCopies += 1;
      return Object.freeze({
        kind: 'attached-copy', ownershipId: `owner_${'C'.repeat(22)}`,
        navigationToken: 'C'.repeat(22), navigationPurpose: 'attached-copy',
        evidenceUrl: sanitizeEvidenceUrlV1('https://example.test/private', { includeQuery: false }),
        sessionDigest: DIGEST,
      });
    };
    dependencies.runUrlAuditExecution = async () => { throw new Error('URL_EXECUTION_MUST_NOT_RUN'); };
    dependencies.clearUrlAuditResources = async () => true;

    const result = await createAuthorizedAuditStarter(dependencies).beginAuthorizedAudit({
      capabilityId,
      eventNonce: null,
      auditId,
      capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
      retentionPreference: { version: 1, deleteAfterCompleteExport: false },
      senderContext,
    });

    assert.deepEqual(result, {
      response: { ok: false, code: row.code },
      sessionCapabilityId: null,
      completion: null,
    });
    assert.equal(preparedCopies, 0);
  });
});

test('restart compensates every attached-copy crash cut before ACTIVE and removes only its reserved owner', async t => {
  for (const phase of ['journal', 'exchange-vault', 'claim']) await t.test(phase, async () => {
    const area = sessionArea();
    const { authority, capabilityId, senderContext } = await authorityFixture(area);
    const auditId = `audit-copy-crash-${phase}`;
    const ownershipId = `owner_${phase === 'journal' ? 'J' : phase === 'exchange-vault' ? 'V' : 'C'}`.padEnd(28, phase === 'journal' ? 'J' : phase === 'exchange-vault' ? 'V' : 'C');
    let claimed = null;
    if (phase !== 'journal') {
      assert.equal((await authority.exchangeAttachedForNavigationCopy({
        capabilityId,
        intent: 'attached-copy',
        senderContext,
      })).ok, true);
    }
    if (phase === 'claim') {
      claimed = await authority.claimExchangedAttachedCopyAndIssueAuditSession({
        capabilityId,
        auditId,
        ownershipId,
        senderContext,
      });
      assert.equal(claimed.ok, true);
    }
    area.values[START_JOURNAL_KEY] = attachedCopyStartJournal({
      capabilityId,
      auditId,
      ownershipId,
      state: phase === 'claim' ? 'prepared' : 'copy-preparing',
    });
    const cleanups = [];
    const dependencies = dependencyFixture({
      area,
      authority,
      execution: async () => { throw new Error('ATTACHED_EXECUTION_MUST_NOT_RUN'); },
    });
    dependencies.runUrlAuditExecution = async () => { throw new Error('URL_EXECUTION_MUST_NOT_RUN'); };
    dependencies.clearUrlAuditResources = async request => {
      cleanups.push(structuredClone(request));
      return true;
    };

    const recovery = await createAuthorizedAuditStarter(dependencies).recoverAuthorizedAuditLifecycle();

    assert.deepEqual(recovery, { ok: true, state: 'interrupted', auditId, revision: null });
    assert.deepEqual(cleanups, [{
      auditId,
      ownershipId,
      navigationPurpose: 'attached-copy',
      cleanupMode: 'always',
    }]);
    assert.equal(Object.hasOwn(area.values, START_JOURNAL_KEY), false);
    assert.equal(area.values[targetCapabilityStorageKey(capabilityId)].state, 'invalidated');
    const navigation = area.values[navigationCapabilityStorageKey(capabilityId)];
    if (phase === 'journal') assert.equal(navigation, undefined);
    else assert.equal(navigation.state, 'invalidated');
    if (claimed) {
      const session = await readAuditSessionForWorker({
        sessionArea: area,
        sessionCapabilityId: claimed.sessionCapabilityId,
        auditId,
      });
      assert.equal(session.state, 'revoked');
      assert.deepEqual(session.targetBinding, { kind: 'disposable', ownershipId, state: 'removed' });
    }
  });
});

test('restart reconciles a correlated ACTIVE plus attached-copy journal before single recovery', async () => {
  const area = sessionArea();
  const { authority, capabilityId, senderContext } = await authorityFixture(area);
  const auditId = 'audit-copy-active-journal';
  const ownershipId = `owner_${'A'.repeat(22)}`;
  await authority.exchangeAttachedForNavigationCopy({
    capabilityId,
    intent: 'attached-copy',
    senderContext,
  });
  const claimed = await authority.claimExchangedAttachedCopyAndIssueAuditSession({
    capabilityId,
    auditId,
    ownershipId,
    senderContext,
  });
  assert.equal(claimed.ok, true);
  area.values[START_JOURNAL_KEY] = attachedCopyStartJournal({
    capabilityId,
    auditId,
    ownershipId,
    state: 'claimed',
    sessionCapabilityId: claimed.sessionCapabilityId,
  });
  area.values[ACTIVE_AUDIT_JOB_KEY] = {
    version: 1,
    auditId,
    capabilityId,
    sessionCapabilityId: claimed.sessionCapabilityId,
    windowId: 9,
    mode: 'single',
    state: 'running',
    commitState: 'none',
    expectedTerminalRevision: null,
    createdAt: EPOCH + 1,
    updatedAt: EPOCH + 1,
  };
  const cleanups = [];
  const dependencies = dependencyFixture({
    area,
    authority,
    execution: async () => { throw new Error('ATTACHED_EXECUTION_MUST_NOT_RUN'); },
  });
  dependencies.runUrlAuditExecution = async () => { throw new Error('URL_EXECUTION_MUST_NOT_RUN'); };
  dependencies.clearUrlAuditResources = async request => { cleanups.push(structuredClone(request)); return true; };

  const recovery = await createAuthorizedAuditStarter(dependencies).recoverAuthorizedAuditLifecycle();

  assert.deepEqual(recovery, { ok: true, state: 'interrupted', auditId, revision: null });
  assert.deepEqual(cleanups, [{
    auditId,
    ownershipId,
    navigationPurpose: 'attached-copy',
    cleanupMode: 'always',
  }]);
  assert.equal(await readActiveAuditJobForWorker({ sessionArea: area }), null);
  assert.equal(Object.hasOwn(area.values, START_JOURNAL_KEY), false);
});

test('unconfirmed attached-copy start compensation keeps its journal and requires recovery', async () => {
  const area = sessionArea();
  const fixture = await authorityFixture(area);
  const auditId = 'audit-copy-compensation-unconfirmed';
  const ownershipId = `owner_${'U'.repeat(22)}`;
  await fixture.authority.exchangeAttachedForNavigationCopy({
    capabilityId: fixture.capabilityId,
    intent: 'attached-copy',
    senderContext: fixture.senderContext,
  });
  const authority = Object.freeze({
    ...fixture.authority,
    async invalidateCapability() { return { ok: false, code: 'CAPABILITY_UNAVAILABLE' }; },
  });
  const dependencies = dependencyFixture({
    area,
    authority,
    execution: async () => { throw new Error('ATTACHED_EXECUTION_MUST_NOT_RUN'); },
  });
  dependencies.panelCoordinator = panelCoordinator([], {
    async registerPendingBootstrap() { return false; },
  });
  dependencies.runUrlAuditExecution = async () => { throw new Error('URL_EXECUTION_MUST_NOT_RUN'); };
  dependencies.clearUrlAuditResources = async () => true;

  const result = await createAuthorizedAuditStarter(dependencies).beginAuthorizedUrlAudit({
    capabilityId: fixture.capabilityId,
    auditId,
    senderContext: fixture.senderContext,
    capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    retentionPreference: { version: 1, deleteAfterCompleteExport: false },
    plan: {
      kind: 'attached-copy',
      ownershipId,
      navigationToken: 'U'.repeat(22),
      navigationPurpose: 'attached-copy',
      evidenceUrl: sanitizeEvidenceUrlV1('https://example.test/private', { includeQuery: false }),
      sessionDigest: DIGEST,
    },
  });

  assert.deepEqual(result, {
    response: { ok: false, code: 'AUDIT_RECOVERY_REQUIRED' },
    sessionCapabilityId: null,
    completion: null,
  });
  assert.equal(area.values[START_JOURNAL_KEY]?.auditId, auditId);
  assert.equal(area.values[navigationCapabilityStorageKey(fixture.capabilityId)].state, 'claimed');
});

test('single-URL start persists bootstrap and active job before execution, then publishes one report', async () => {
  const area = sessionArea();
  const { authority, senderContext } = await authorityFixture(area);
  const prepared = await authority.prepareNavigationForPanel({ intent: 'single', senderContext });
  const auditId = 'audit-url-report';
  const report = await reportFixture(auditId);
  const order = [];
  const reportByAudit = new Map();
  let recordedHighlight = null;
  const dependencies = dependencyFixture({
    area, authority, order, reportByAudit,
    execution: async () => { throw new Error('ATTACHED_EXECUTION_MUST_NOT_RUN'); },
  });
  dependencies.runUrlAuditExecution = async args => {
    order.push('run-url');
    const active = await readActiveAuditJobForWorker({ sessionArea: area });
    assert.equal(active.auditId, auditId);
    assert.equal(active.mode, 'single');
    assert.equal(order.indexOf('bootstrap-register') < order.indexOf('run-url'), true);
    assert.equal(order.indexOf('latest:running') < order.indexOf('run-url'), true);
    await args.onCheckpoint(report.checkpoint);
    const observedTarget = Object.freeze({
      version: 'ObservedTargetV1', kind: 'owned-disposable', ownershipId: `owner_${'O'.repeat(22)}`,
      tabId: 27, windowId: 9, documentId: 'url-document',
      urlEvidence: sanitizeEvidenceUrlV1('https://example.test/private', { includeQuery: false }),
      urlSessionDigest: `hmac-sha256:${'D'.repeat(43)}`,
      cleanupMode: 'pre-observation-failure', pageId: 'page-1',
    });
    assert.equal(typeof args.persistAuditModel, 'function');
    await args.persistAuditModel(report.model, observedTarget);
    return Object.freeze({
      status: 'complete', model: report.model,
      observedTarget,
      observationState: 'observed', ownershipState: 'retained-for-review',
    });
  };
  dependencies.clearUrlAuditResources = async () => true;
  dependencies.recordHighlightBinding = async input => { recordedHighlight = input; return null; };
  const starter = createAuthorizedAuditStarter(dependencies);
  const started = await starter.beginAuthorizedUrlAudit({
    capabilityId: prepared.capabilityId,
    auditId,
    senderContext,
    capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    retentionPreference: { version: 1, deleteAfterCompleteExport: false },
    plan: {
      kind: 'single', ownershipId: `owner_${'O'.repeat(22)}`, navigationToken: 'T'.repeat(22),
      navigationPurpose: 'single-url',
      evidenceUrl: sanitizeEvidenceUrlV1('https://example.test/private?token=raw', { includeQuery: false }),
      sessionDigest: `hmac-sha256:${'D'.repeat(43)}`,
    },
  });
  assert.deepEqual(started.response, { ok: true, auditId, state: 'running' });
  assert.deepEqual(await started.completion, { ok: true, auditId, state: 'result', revision: 1 });
  assert.equal(reportByAudit.has(auditId), true);
  assert.deepEqual(recordedHighlight.observedTarget, {
    version: 1, kind: 'disposable', ownerId: `owner_${'O'.repeat(22)}`,
    tabId: 27, windowId: 9, documentId: 'url-document',
    urlEvidence: 'https://example.test/private',
    urlSessionDigest: `hmac-sha256:${'D'.repeat(43)}`,
  }, 'the live-highlight boundary receives the sanitized URL string, not the EvidenceUrlV1 envelope');
  assert.equal(recordedHighlight.snapshot.modelHash, report.model.integrity.canonicalModelHash);
  assert.equal(await readActiveAuditJobForWorker({ sessionArea: area }), null);
  const session = await readAuditSessionForWorker({
    sessionArea: area, sessionCapabilityId: started.sessionCapabilityId, auditId,
  });
  assert.equal(session.state, 'result');
  assert.deepEqual(session.targetBinding, {
    kind: 'disposable', ownershipId: `owner_${'O'.repeat(22)}`, state: 'retained-for-review',
  });
  assert.doesNotMatch(JSON.stringify({ latest: area.values['latest'], report: reportByAudit.get(auditId) }),
    /token=raw|TTTTTTTTTTTTTTTTTTTTTT|owner_O|hmac-sha256:D/iu);
});

test('batch start persists one active session, commits the consolidated report, and leaves no active owner', async () => {
  const area = sessionArea();
  const { authority, senderContext } = await authorityFixture(area);
  const prepared = await authority.prepareNavigationForPanel({ intent: 'batch', senderContext });
  const auditId = 'audit-batch-report';
  const report = await batchReportFixture(auditId);
  const order = [];
  const reportByAudit = new Map();
  const dependencies = dependencyFixture({
    area, authority, order, reportByAudit,
    execution: async () => { throw new Error('ATTACHED_EXECUTION_MUST_NOT_RUN'); },
  });
  dependencies.runUrlAuditExecution = async () => { throw new Error('URL_EXECUTION_MUST_NOT_RUN'); };
  dependencies.clearUrlAuditResources = async () => true;
  dependencies.runBatchAuditExecution = async args => {
    order.push('run-batch');
    const active = await readActiveAuditJobForWorker({ sessionArea: area });
    assert.equal(active.auditId, auditId);
    assert.equal(active.mode, 'batch');
    assert.equal(args.acceptedCount, 2);
    await args.onCheckpoint(report.checkpoint);
    return Object.freeze({ model: report.model, checkpoint: report.checkpoint });
  };
  dependencies.clearBatchAuditResources = async () => true;
  dependencies.clearBatchAuditProgress = async () => true;
  dependencies.discardBatchAuditProgress = async () => true;

  const started = await createAuthorizedAuditStarter(dependencies).beginAuthorizedBatchAudit({
    capabilityId: prepared.capabilityId,
    auditId,
    senderContext,
    capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    retentionPreference: { version: 1, deleteAfterCompleteExport: false },
    async preparePlan() {
      assert.equal(area.values['audita:start-journal:v1']?.state, 'prepared');
      order.push('prepare-batch-queue');
      return { kind: 'batch', queueId: auditId, acceptedCount: 2 };
    },
  });

  assert.deepEqual(started.response, { ok: true, auditId, state: 'running' });
  assert.deepEqual(await started.completion, { ok: true, auditId, state: 'result', revision: 1 });
  assert.equal(reportByAudit.has(auditId), true);
  assert.equal(await readActiveAuditJobForWorker({ sessionArea: area }), null);
  const session = await readAuditSessionForWorker({
    sessionArea: area, sessionCapabilityId: started.sessionCapabilityId, auditId,
  });
  assert.equal(session.mode, 'batch');
  assert.equal(session.state, 'result');
  assert.deepEqual(session.targetBinding, { kind: 'batch', activePageId: null, activeOwnershipId: null });
  assert.equal(order.indexOf('prepare-batch-queue') < order.indexOf('run-batch'), true);
  assert.equal(order.includes('run-batch'), true);
});

test('pixel batch pauses one explicit page and confirmation resumes its same live executor and owner', async () => {
  const area = sessionArea();
  const { authority, senderContext } = await authorityFixture(area);
  const prepared = await authority.prepareNavigationForPanel({ intent: 'batch', senderContext });
  const auditId = 'audit-batch-pixel-resume';
  const progress = persistedBatchProgress(auditId);
  const pageId = 'page-2';
  const childAuditId = 'opaque-batch-child';
  const ownershipId = `owner_${'P'.repeat(22)}`;
  const report = await batchReportFixture(auditId);
  const policy = createCapturePolicyV1({ mode: 'full-evidence', includeQuery: false });
  const reportByAudit = new Map();
  let currentAt = EPOCH + 2;
  let random = 12;
  const pixelState = createPixelCaptureStateV1({
    sessionArea: area,
    now: () => currentAt++,
    randomBytes: length => new Uint8Array(length).fill(++random),
  });
  const observedTarget = Object.freeze({
    version: 'ObservedTargetV1', kind: 'owned-disposable', ownershipId,
    tabId: 27, windowId: 9, documentId: 'batch-document-a',
    urlEvidence: sanitizeEvidenceUrlV1('https://two.example.test/private?token=secret', { includeQuery: false }),
    urlSessionDigest: DIGEST, cleanupMode: 'always', pageId,
  });
  const signals = Object.freeze({
    version: 'SensitiveCaptureSignalsV1', detected: true,
    categories: Object.freeze(['password']),
  });
  let runCalls = 0;
  let releaseBatch;
  const batchReleased = new Promise(resolve => { releaseBatch = resolve; });
  let announcePaused;
  const paused = new Promise(resolve => { announcePaused = resolve; });
  const resumeCalls = [];
  const attemptCleanupCalls = [];
  let finishPixelPage = null;
  let boundDuringResume = null;
  const dependencies = dependencyFixture({
    area, authority, pixelState, reportByAudit,
    probeDocumentIdentity: async () => ({
      tabId: observedTarget.tabId, windowId: observedTarget.windowId,
      documentId: observedTarget.documentId, urlSessionDigest: observedTarget.urlSessionDigest,
    }),
    probeSensitiveCaptureSignals: async () => signals,
    execution: async () => { throw new Error('ATTACHED_EXECUTION_MUST_NOT_RUN'); },
  });
  let registeredCaptureMode = null;
  dependencies.panelCoordinator = panelCoordinator([], {
    async registerPendingBootstrap(value) {
      registeredCaptureMode = value.captureMode;
      return true;
    },
  });
  dependencies.runUrlAuditExecution = async () => { throw new Error('URL_EXECUTION_MUST_NOT_RUN'); };
  dependencies.clearUrlAuditResources = async () => true;
  dependencies.pixelAttemptLifecycle = Object.freeze({
    ...dependencies.pixelAttemptLifecycle,
    async cleanup(value) { attemptCleanupCalls.push(structuredClone(value)); return true; },
  });
  dependencies.runBatchAuditExecution = async args => {
    runCalls += 1;
    finishPixelPage = args.onPixelPageFinished;
    const bound = await authority.transitionBatchAuditSession({
      sessionCapabilityId: args.sessionCapabilityId,
      auditId,
      fromPageId: null,
      fromOwnershipId: null,
      toPageId: pageId,
      toOwnershipId: ownershipId,
    });
    assert.equal(bound.ok, true);
    const correlation = await readBatchAuditCorrelationForRecovery({
      sessionArea: area, capabilityId: args.capabilityId, auditId,
    });
    await pixelState.pause({
      auditId,
      observedTarget,
      mode: policy.mode,
      capturePolicy: policy,
      categories: signals.categories,
      authorityExpiresAt: correlation.expiresAt,
    });
    await args.onCheckpoint(report.checkpoint);
    await args.onPrivacyPaused({ auditId, childAuditId, pageId, ownershipId });
    announcePaused();
    await batchReleased;
    return Object.freeze({ model: report.model, checkpoint: report.checkpoint });
  };
  dependencies.resumeBatchAuditExecution = async request => {
    resumeCalls.push(structuredClone(request));
    boundDuringResume = await readBatchAuditCorrelationForRecovery({
      sessionArea: area, capabilityId: prepared.capabilityId, auditId,
    });
    await pixelState.gateRunnerStart({
      auditId,
      consentId: request.consentId,
      proof: {
        kind: 'owned-disposable', ownershipId,
        tabId: observedTarget.tabId, windowId: observedTarget.windowId,
        documentId: observedTarget.documentId, urlSessionDigest: observedTarget.urlSessionDigest,
        cleanupMode: 'always', pageId,
      },
      categories: signals.categories,
    });
    assert.equal(typeof finishPixelPage, 'function');
    await finishPixelPage({
      auditId, childAuditId, pageId, ownershipId, consentId: request.consentId,
    });
    assert.equal(await pixelState.readSuspension(auditId), null);
    const cleared = await authority.transitionBatchAuditSession({
      sessionCapabilityId: boundDuringResume.sessionCapabilityId,
      auditId,
      fromPageId: pageId,
      fromOwnershipId: ownershipId,
      toPageId: null,
      toOwnershipId: null,
    });
    assert.equal(cleared.ok, true);
    releaseBatch();
    return true;
  };
  dependencies.recoverBatchAuditExecution = async () => { throw new Error('BATCH_RECOVERY_MUST_NOT_RUN'); };
  dependencies.clearBatchAuditResources = async () => true;
  dependencies.clearBatchAuditProgress = async request => {
    assert.equal(reportByAudit.has(auditId), true);
    return progress.discard(request);
  };
  dependencies.discardBatchAuditProgress = async () => { throw new Error('PAUSED_OR_COMMITTED_PROGRESS_MUST_NOT_BE_DISCARDED'); };
  const starter = createAuthorizedAuditStarter(dependencies);
  const started = await starter.beginAuthorizedBatchAudit({
    capabilityId: prepared.capabilityId,
    auditId,
    senderContext,
    capturePolicy: policy,
    retentionPreference: { version: 1, deleteAfterCompleteExport: false },
    async preparePlan() { return { kind: 'batch', queueId: auditId, acceptedCount: 2 }; },
  });
  assert.deepEqual(started.response, { ok: true, auditId, state: 'running' });
  assert.equal(registeredCaptureMode, 'full-evidence');
  await paused;
  assert.equal(Object.hasOwn(await progress.storage.get(auditId), auditId), true);
  assert.equal((await readActiveAuditJobForWorker({ sessionArea: area })).state, 'privacy-paused');
  const pausedCorrelation = await readBatchAuditCorrelationForRecovery({
    sessionArea: area, capabilityId: prepared.capabilityId, auditId,
  });
  assert.equal(pausedCorrelation.activePageId, pageId);
  assert.equal(pausedCorrelation.activeOwnershipId, ownershipId);

  const resumed = await starter.resumePrivacyPausedAudit({
    auditId, sessionCapabilityId: started.sessionCapabilityId, windowId: 9,
    mode: 'full-evidence',
  });
  assert.deepEqual(resumed.response, { ok: true, auditId, state: 'running' });
  assert.equal(typeof resumed.completion?.then, 'function');
  assert.equal(resumeCalls.length, 1);
  assert.deepEqual({
    auditId: resumeCalls[0].auditId,
    pageId: resumeCalls[0].pageId,
    ownershipId: resumeCalls[0].ownershipId,
  }, { auditId, pageId, ownershipId });
  assert.match(resumeCalls[0].consentId, /^[A-Za-z0-9_-]{21}[AQgw]$/u);
  assert.equal(boundDuringResume.activePageId, pageId);
  assert.equal(boundDuringResume.activeOwnershipId, ownershipId);
  assert.deepEqual(await started.completion, { ok: true, auditId, state: 'result', revision: 1 });
  assert.equal(Object.hasOwn(await progress.storage.get(auditId), auditId), false);
  assert.equal(attemptCleanupCalls.some(value => value.expected === 'prepared' &&
    value.pageId === pageId && value.ownershipId === ownershipId), true);
  assert.equal(runCalls, 1);
  assert.equal(await pixelState.readSuspension(auditId), null);
  assert.deepEqual(await starter.resumePrivacyPausedAudit({
    auditId, sessionCapabilityId: started.sessionCapabilityId, windowId: 9,
    mode: 'full-evidence',
  }), {
    response: { ok: false, code: 'AUDIT_RESUME_DENIED' }, sessionCapabilityId: null, completion: null,
  });
});

test('worker restart rehydrates a paused batch page and resumes the same owner without navigation or token', async () => {
  const area = sessionArea();
  const { authority, senderContext } = await authorityFixture(area);
  const prepared = await authority.prepareNavigationForPanel({ intent: 'batch', senderContext });
  const auditId = 'audit-batch-pixel-worker-restart';
  const pageId = 'page-2';
  const childAuditId = `${auditId}:${pageId}`;
  const ownershipId = `owner_${'W'.repeat(22)}`;
  const report = await batchReportFixture(auditId);
  const policy = createCapturePolicyV1({ mode: 'full-evidence', includeQuery: false });
  const signals = Object.freeze({
    version: 'SensitiveCaptureSignalsV1', detected: true, categories: Object.freeze(['password']),
  });
  let epoch = EPOCH + 2;
  const pixelState = createPixelCaptureStateV1({
    sessionArea: area, now: () => epoch++,
    randomBytes: length => new Uint8Array(length).fill(19),
  });
  const observedTarget = Object.freeze({
    version: 'ObservedTargetV1', kind: 'owned-disposable', ownershipId,
    tabId: 37, windowId: 9, documentId: 'batch-restart-document',
    urlEvidence: sanitizeEvidenceUrlV1('https://two.example.test/private?token=secret', { includeQuery: false }),
    urlSessionDigest: DIGEST, cleanupMode: 'always', pageId,
  });
  let announcePause;
  const paused = new Promise(resolve => { announcePause = resolve; });
  const never = new Promise(() => {});
  const recoveryCalls = [];
  const reportByAudit = new Map();
  const dependencies = dependencyFixture({
    area, authority, pixelState, reportByAudit,
    probeDocumentIdentity: async () => ({
      tabId: observedTarget.tabId, windowId: observedTarget.windowId,
      documentId: observedTarget.documentId, urlSessionDigest: observedTarget.urlSessionDigest,
    }),
    probeSensitiveCaptureSignals: async () => signals,
    execution: async () => { throw new Error('ATTACHED_EXECUTION_MUST_NOT_RUN'); },
  });
  dependencies.runUrlAuditExecution = async () => { throw new Error('URL_EXECUTION_MUST_NOT_RUN'); };
  dependencies.clearUrlAuditResources = async () => true;
  dependencies.runBatchAuditExecution = async args => {
    const bound = await authority.transitionBatchAuditSession({
      sessionCapabilityId: args.sessionCapabilityId, auditId,
      fromPageId: null, fromOwnershipId: null, toPageId: pageId, toOwnershipId: ownershipId,
    });
    const correlation = await readBatchAuditCorrelationForRecovery({
      sessionArea: area, capabilityId: args.capabilityId, auditId,
    });
    await pixelState.pause({
      auditId, observedTarget, mode: policy.mode, capturePolicy: policy,
      categories: signals.categories, authorityExpiresAt: correlation.expiresAt,
    });
    await args.onCheckpoint(report.checkpoint);
    await args.onPrivacyPaused({ auditId, childAuditId, pageId, ownershipId });
    assert.equal(bound.ok, true);
    announcePause();
    return never;
  };
  dependencies.resumeBatchAuditExecution = async () => { throw new Error('VOLATILE_RESUME_MUST_NOT_RUN'); };
  dependencies.recoverBatchAuditExecution = async args => {
    recoveryCalls.push(args);
    assert.equal(typeof args.onPrivacyPaused, 'function');
    assert.equal(Object.hasOwn(args, 'navigationToken'), false);
    assert.equal(Object.hasOwn(args, 'rawNavigationVault'), false);
    assert.deepEqual(args.resumeTarget, observedTarget);
    await pixelState.gateRunnerStart({
      auditId, consentId: args.consentId,
      proof: {
        kind: 'owned-disposable', ownershipId, tabId: observedTarget.tabId,
        windowId: observedTarget.windowId, documentId: observedTarget.documentId,
        urlSessionDigest: observedTarget.urlSessionDigest, cleanupMode: 'always', pageId,
      },
      categories: signals.categories,
    });
    await args.onCheckpoint(report.checkpoint);
    await args.onPixelPageFinished({ auditId, childAuditId, pageId, ownershipId, consentId: args.consentId });
    const cleared = await authority.transitionBatchAuditSession({
      sessionCapabilityId: args.sessionCapabilityId, auditId,
      fromPageId: pageId, fromOwnershipId: ownershipId, toPageId: null, toOwnershipId: null,
    });
    assert.equal(cleared.ok, true);
    return Object.freeze({ model: report.model, checkpoint: report.checkpoint, acceptedCount: 2 });
  };
  dependencies.clearBatchAuditResources = async () => true;
  dependencies.clearBatchAuditProgress = async () => true;
  dependencies.discardBatchAuditProgress = async () => true;

  const original = createAuthorizedAuditStarter(dependencies);
  const started = await original.beginAuthorizedBatchAudit({
    capabilityId: prepared.capabilityId, auditId, senderContext,
    capturePolicy: policy,
    retentionPreference: { version: 1, deleteAfterCompleteExport: false },
    async preparePlan() { return { kind: 'batch', queueId: auditId, acceptedCount: 2 }; },
  });
  await paused;
  const suspension = await pixelState.readSuspension(auditId);
  assert.equal(suspension.source.ownershipId, ownershipId);

  const restarted = createAuthorizedAuditStarter(dependencies);
  assert.deepEqual(await restarted.recoverAuthorizedAuditLifecycle(), {
    ok: true, state: 'privacy-paused', auditId, revision: null,
  });
  const resumed = await restarted.resumePrivacyPausedAudit({
    auditId, sessionCapabilityId: started.sessionCapabilityId, windowId: 9,
    mode: 'full-evidence',
  });
  assert.deepEqual(resumed.response, { ok: true, auditId, state: 'running' });
  assert.deepEqual(await resumed.completion, { ok: true, auditId, state: 'result', revision: 1 });
  assert.equal(recoveryCalls.length, 1);
  assert.equal(recoveryCalls[0].resumeTarget.ownershipId, ownershipId);
  assert.equal(await pixelState.readSuspension(auditId), null);
});

for (const retry of ['none', 'direct', 'restart', 'startup-running']) {
test(`revoked batch pixel suspension discards persisted child progress after owner cleanup (retry: ${retry})`, async () => {
  const area = sessionArea();
  const { authority, senderContext } = await authorityFixture(area);
  const prepared = await authority.prepareNavigationForPanel({ intent: 'batch', senderContext });
  const auditId = 'audit-batch-pixel-liquidation';
  const progress = persistedBatchProgress(auditId);
  const discardFailsInitially = ['direct', 'restart'].includes(retry);
  let discardFailed = false;
  const pageId = 'page-2';
  const ownershipId = `owner_${'L'.repeat(22)}`;
  const claimed = await authority.claimNavigationAndIssueAuditSession({
    capabilityId: prepared.capabilityId, auditId, ownershipId: null,
    intent: 'batch', senderContext,
  });
  assert.equal(claimed.ok, true);
  assert.equal((await authority.transitionBatchAuditSession({
    sessionCapabilityId: claimed.sessionCapabilityId, auditId,
    fromPageId: null, fromOwnershipId: null,
    toPageId: pageId, toOwnershipId: ownershipId,
  })).ok, true);
  const correlation = await readBatchAuditCorrelationForRecovery({
    sessionArea: area, capabilityId: prepared.capabilityId, auditId,
  });
  let currentAt = EPOCH + 2;
  const pixelState = createPixelCaptureStateV1({
    sessionArea: area,
    now: () => currentAt++,
    randomBytes: length => new Uint8Array(length).fill(21),
  });
  const policy = createCapturePolicyV1({ mode: 'full-evidence', includeQuery: false });
  const suspension = await pixelState.pause({
    auditId,
    observedTarget: {
      version: 'ObservedTargetV1', kind: 'owned-disposable', ownershipId,
      tabId: 27, windowId: 9, documentId: 'batch-document-a',
      urlEvidence: sanitizeEvidenceUrlV1('https://two.example.test/', { includeQuery: false }),
      urlSessionDigest: DIGEST, cleanupMode: 'always', pageId,
    },
    mode: policy.mode, capturePolicy: policy, categories: ['password'],
    authorityExpiresAt: correlation.expiresAt,
  });
  if (retry !== 'startup-running') assert.equal((await authority.transitionAuditSession({
    sessionCapabilityId: claimed.sessionCapabilityId, auditId, nextState: 'privacy-paused',
  })).ok, true);
  const active = {
    version: 1, auditId, capabilityId: prepared.capabilityId,
    sessionCapabilityId: claimed.sessionCapabilityId, windowId: 9, mode: 'batch',
    state: retry === 'startup-running' ? 'running' : 'privacy-paused', commitState: 'none', expectedTerminalRevision: null,
    createdAt: EPOCH + 1, updatedAt: EPOCH + 1,
  };
  area.values[ACTIVE_AUDIT_JOB_KEY] = structuredClone(active);
  await pixelState.revokeAudit({
    auditId, consentId: suspension.consentId, reason: 'PIXEL_CONSENT_DOCUMENT_CHANGED',
  });
  const cleanupCalls = [];
  const dependencies = dependencyFixture({
    area, authority, pixelState,
    execution: async () => { throw new Error('ATTACHED_EXECUTION_MUST_NOT_RUN'); },
  });
  dependencies.runUrlAuditExecution = async () => { throw new Error('URL_EXECUTION_MUST_NOT_RUN'); };
  dependencies.clearUrlAuditResources = async () => { throw new Error('URL_CLEANUP_MUST_NOT_RUN'); };
  dependencies.runBatchAuditExecution = async () => { throw new Error('BATCH_EXECUTION_MUST_NOT_RUN'); };
  dependencies.resumeBatchAuditExecution = async () => { throw new Error('BATCH_RESUME_MUST_NOT_RUN'); };
  dependencies.recoverBatchAuditExecution = async () => { throw new Error('BATCH_RECOVERY_MUST_NOT_RUN'); };
  dependencies.clearBatchAuditResources = async request => {
    cleanupCalls.push(structuredClone(request));
    const current = await readBatchAuditCorrelationForRecovery({
      sessionArea: area, capabilityId: request.capabilityId, auditId: request.auditId,
    });
    if (current.activePageId === null && current.activeOwnershipId === null) return true;
    const cleared = await authority.transitionBatchAuditSession({
      sessionCapabilityId: request.sessionCapabilityId, auditId: request.auditId,
      fromPageId: pageId, fromOwnershipId: ownershipId,
      toPageId: null, toOwnershipId: null,
    });
    return cleared.ok === true;
  };
  dependencies.clearBatchAuditProgress = async () => true;
  dependencies.discardBatchAuditProgress = async request => {
    const correlation = await readBatchAuditCorrelationForRecovery({
      sessionArea: area, capabilityId: prepared.capabilityId, auditId,
    });
    assert.equal(correlation.activeOwnershipId, null);
    assert.equal(area.values[ACTIVE_AUDIT_JOB_KEY]?.auditId, auditId);
    if (discardFailsInitially && !discardFailed) { discardFailed = true; return false; }
    return progress.discard(request);
  };
  const starter = createAuthorizedAuditStarter(dependencies);
  if (discardFailsInitially) {
    assert.equal(await starter.liquidatePixelAudit({
      auditId, consentId: suspension.consentId,
      reason: 'PIXEL_CONSENT_DOCUMENT_CHANGED', source: suspension.source,
      signal: new AbortController().signal,
    }), false);
    assert.equal((await readActiveAuditJobForWorker({ sessionArea: area }))?.auditId, auditId);
    assert.equal((await pixelState.readSuspension(auditId))?.state, 'revoked');
    assert.equal(Object.hasOwn(await progress.storage.get(auditId), auditId), true);
  }
  if (retry === 'restart' || retry === 'startup-running') {
    assert.deepEqual(await createAuthorizedAuditStarter(dependencies).recoverAuthorizedAuditLifecycle(), {
      ok: true, state: 'interrupted', auditId, revision: null,
    });
  } else assert.equal(await starter.liquidatePixelAudit({
    auditId, consentId: suspension.consentId,
    reason: 'PIXEL_CONSENT_DOCUMENT_CHANGED', source: suspension.source,
    signal: new AbortController().signal,
  }), true);
  assert.equal(Object.hasOwn(await progress.storage.get(auditId), auditId), false);
  assert.deepEqual(cleanupCalls[0], {
    auditId, capabilityId: prepared.capabilityId,
    sessionCapabilityId: claimed.sessionCapabilityId, windowId: 9,
  });
  assert.equal(await pixelState.readSuspension(auditId), null);
  assert.equal(await readActiveAuditJobForWorker({ sessionArea: area }), null);
  const cleaned = await readBatchAuditCorrelationForRecovery({
    sessionArea: area, capabilityId: prepared.capabilityId, auditId,
  });
  assert.equal(cleaned.capabilityState, 'invalidated');
  assert.equal(cleaned.activePageId, null);
  assert.equal(cleaned.activeOwnershipId, null);
});
}

test('single-URL terminal preparation failure removes its retained owner instead of revoking without a report', async () => {
  const area = sessionArea();
  const { authority, senderContext } = await authorityFixture(area);
  const prepared = await authority.prepareNavigationForPanel({ intent: 'single', senderContext });
  const auditId = 'audit-url-terminal-preparation-failure';
  const ownershipId = `owner_${'O'.repeat(22)}`;
  const report = await reportFixture(auditId);
  const reportByAudit = new Map();
  const dependencies = dependencyFixture({
    area, authority, reportByAudit,
    execution: async () => { throw new Error('ATTACHED_EXECUTION_MUST_NOT_RUN'); },
  });
  dependencies.runUrlAuditExecution = async args => {
    await args.onCheckpoint(report.checkpoint);
    await args.persistAuditModel(report.model, Object.freeze({
      version: 'ObservedTargetV1', kind: 'owned-disposable', ownershipId,
      tabId: 27, windowId: 9, documentId: 'url-document',
      urlEvidence: sanitizeEvidenceUrlV1('https://example.test/private', { includeQuery: false }),
      urlSessionDigest: `hmac-sha256:${'D'.repeat(43)}`,
      cleanupMode: 'pre-observation-failure', pageId: 'page-1',
    }));
    throw new Error('RUNNER_MUST_NOT_CONTINUE_AFTER_TERMINAL_PREPARATION_FAILURE');
  };
  dependencies.buildPanelResultBundle = async () => { throw new Error('BUNDLE_PREPARATION_FAILED'); };
  const cleanups = [];
  dependencies.clearUrlAuditResources = async value => { cleanups.push(value); return true; };

  const started = await createAuthorizedAuditStarter(dependencies).beginAuthorizedUrlAudit({
    capabilityId: prepared.capabilityId, auditId, senderContext,
    capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    retentionPreference: { version: 1, deleteAfterCompleteExport: false },
    plan: {
      kind: 'single', ownershipId, navigationToken: 'T'.repeat(22), navigationPurpose: 'single-url',
      evidenceUrl: sanitizeEvidenceUrlV1('https://example.test/private?token=raw', { includeQuery: false }),
      sessionDigest: `hmac-sha256:${'D'.repeat(43)}`,
    },
  });

  assert.deepEqual(await started.completion, {
    ok: true, auditId, state: 'revoked', code: 'AUDIT_FAILED',
  });
  assert.deepEqual(cleanups, [{ auditId, ownershipId }]);
  assert.equal(reportByAudit.has(auditId), false);
  assert.equal(await readActiveAuditJobForWorker({ sessionArea: area }), null);
  const session = await readAuditSessionForWorker({
    sessionArea: area, sessionCapabilityId: started.sessionCapabilityId, auditId,
  });
  assert.equal(session.state, 'revoked');
  assert.deepEqual(session.targetBinding, { kind: 'disposable', ownershipId, state: 'removed' });
});

test('single-URL pre-observation cleanup failure blocks recovery and never publishes a report', async () => {
  const area = sessionArea();
  const { authority, senderContext } = await authorityFixture(area);
  const prepared = await authority.prepareNavigationForPanel({ intent: 'single', senderContext });
  const auditId = 'audit-url-cleanup-blocked';
  const reportByAudit = new Map();
  const dependencies = dependencyFixture({
    area, authority, reportByAudit,
    execution: async () => { throw new Error('ATTACHED_EXECUTION_MUST_NOT_RUN'); },
  });
  dependencies.runUrlAuditExecution = async () => Object.freeze({
    status: 'failed', model: null, observedTarget: null,
    observationState: 'pre-observation-failure', ownershipState: 'cleanup-pending',
  });
  let cleanupCalls = 0;
  dependencies.clearUrlAuditResources = async value => {
    cleanupCalls += 1;
    assert.deepEqual(value, { auditId, ownershipId: `owner_${'O'.repeat(22)}` });
    return false;
  };
  const started = await createAuthorizedAuditStarter(dependencies).beginAuthorizedUrlAudit({
    capabilityId: prepared.capabilityId, auditId, senderContext,
    capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    retentionPreference: { version: 1, deleteAfterCompleteExport: false },
    plan: {
      kind: 'single', ownershipId: `owner_${'O'.repeat(22)}`, navigationToken: 'T'.repeat(22),
      navigationPurpose: 'single-url',
      evidenceUrl: sanitizeEvidenceUrlV1('https://example.test/private?token=raw', { includeQuery: false }),
      sessionDigest: `hmac-sha256:${'D'.repeat(43)}`,
    },
  });

  assert.deepEqual(started.response, { ok: true, auditId, state: 'running' });
  assert.deepEqual(await started.completion, {
    ok: false, auditId, state: 'blocked', code: 'AUDIT_RECOVERY_REQUIRED',
  });
  assert.equal(cleanupCalls >= 1, true);
  assert.equal(reportByAudit.has(auditId), false);
  assert.doesNotMatch(JSON.stringify(await area.get(null)), /token=raw|TTTTTTTTTTTTTTTTTTTTTT|hmac-sha256:D/iu);
});

test('worker restart interrupts a running single-URL audit and confirms cleanup of only its disposable owner', async () => {
  const area = sessionArea();
  const { authority, senderContext } = await authorityFixture(area);
  const prepared = await authority.prepareNavigationForPanel({ intent: 'single', senderContext });
  const latest = { value: null };
  const auditId = 'audit-url-restart';
  const ownershipId = `owner_${'O'.repeat(22)}`;
  const first = dependencyFixture({
    area, authority, latest,
    execution: async () => { throw new Error('ATTACHED_EXECUTION_MUST_NOT_RUN'); },
  });
  first.runUrlAuditExecution = async () => new Promise(() => {});
  first.clearUrlAuditResources = async () => true;
  const started = await createAuthorizedAuditStarter(first).beginAuthorizedUrlAudit({
    capabilityId: prepared.capabilityId, auditId, senderContext,
    capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    retentionPreference: { version: 1, deleteAfterCompleteExport: false },
    plan: {
      kind: 'single', ownershipId, navigationToken: 'T'.repeat(22), navigationPurpose: 'single-url',
      evidenceUrl: sanitizeEvidenceUrlV1('https://example.test/restart?private=raw', { includeQuery: false }),
      sessionDigest: `hmac-sha256:${'D'.repeat(43)}`,
    },
  });
  assert.equal(started.response.ok, true);

  const cleanups = [];
  const recoveredDependencies = dependencyFixture({
    area, authority, latest,
    execution: async () => { throw new Error('ATTACHED_EXECUTION_MUST_NOT_RUN'); },
  });
  recoveredDependencies.runUrlAuditExecution = async () => { throw new Error('URL_EXECUTION_MUST_NOT_RESUME'); };
  recoveredDependencies.clearUrlAuditResources = async value => { cleanups.push(value); return true; };
  const recovery = await createAuthorizedAuditStarter(recoveredDependencies).recoverAuthorizedAuditLifecycle();

  assert.deepEqual(recovery, { ok: true, state: 'interrupted', auditId, revision: null });
  assert.deepEqual(cleanups, [{ auditId, ownershipId }]);
  assert.equal(await readActiveAuditJobForWorker({ sessionArea: area }), null);
  const session = await readAuditSessionForWorker({
    sessionArea: area, sessionCapabilityId: started.sessionCapabilityId, auditId,
  });
  assert.equal(session.state, 'revoked');
  assert.deepEqual(session.targetBinding, { kind: 'disposable', ownershipId, state: 'removed' });
  assert.doesNotMatch(JSON.stringify({ latest: latest.value, recovery }), /private=raw|TTTTTT|hmac-sha256|owner_/iu);
});

test('worker restart reconciles a committed single-URL report without deleting its retained review target', async () => {
  const area = sessionArea();
  const { authority, senderContext } = await authorityFixture(area);
  const prepared = await authority.prepareNavigationForPanel({ intent: 'single', senderContext });
  const auditId = 'audit-url-finalizing-restart';
  const ownershipId = `owner_${'O'.repeat(22)}`;
  const report = await reportFixture(auditId);
  const reportByAudit = new Map();
  const latest = { value: null };
  let reachedCommit;
  const commitReached = new Promise(resolve => { reachedCommit = resolve; });
  const first = dependencyFixture({
    area, authority, latest, reportByAudit,
    execution: async () => { throw new Error('ATTACHED_EXECUTION_MUST_NOT_RUN'); },
  });
  first.runUrlAuditExecution = async args => {
    await args.onCheckpoint(report.checkpoint);
    const observedTarget = Object.freeze({
      version: 'ObservedTargetV1', kind: 'owned-disposable', ownershipId,
      tabId: 27, windowId: 9, documentId: 'url-document',
      urlEvidence: sanitizeEvidenceUrlV1('https://example.test/final', { includeQuery: false }),
      urlSessionDigest: `hmac-sha256:${'D'.repeat(43)}`,
      cleanupMode: 'pre-observation-failure', pageId: 'page-1',
    });
    await args.persistAuditModel(report.model, observedTarget);
    return Object.freeze({
      status: 'complete', model: report.model, observedTarget,
      observationState: 'observed', ownershipState: 'retained-for-review',
    });
  };
  const commitTerminalAudit = first.commitTerminalAudit;
  first.commitTerminalAudit = async value => {
    await commitTerminalAudit(value);
    reachedCommit();
    return new Promise(() => {});
  };
  first.clearUrlAuditResources = async () => true;
  const started = await createAuthorizedAuditStarter(first).beginAuthorizedUrlAudit({
    capabilityId: prepared.capabilityId, auditId, senderContext,
    capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    retentionPreference: { version: 1, deleteAfterCompleteExport: false },
    plan: {
      kind: 'single', ownershipId, navigationToken: 'T'.repeat(22), navigationPurpose: 'single-url',
      evidenceUrl: sanitizeEvidenceUrlV1('https://example.test/final', { includeQuery: false }),
      sessionDigest: `hmac-sha256:${'D'.repeat(43)}`,
    },
  });
  await commitReached;

  let cleanupCalls = 0;
  const recoveredDependencies = dependencyFixture({
    area, authority, latest, reportByAudit,
    execution: async () => { throw new Error('ATTACHED_EXECUTION_MUST_NOT_RUN'); },
  });
  recoveredDependencies.runUrlAuditExecution = async () => { throw new Error('URL_EXECUTION_MUST_NOT_RESUME'); };
  recoveredDependencies.clearUrlAuditResources = async () => { cleanupCalls += 1; return true; };
  const recovery = await createAuthorizedAuditStarter(recoveredDependencies).recoverAuthorizedAuditLifecycle();

  assert.deepEqual(recovery, { ok: true, state: 'reconciled', auditId, revision: 1 });
  assert.equal(cleanupCalls, 0);
  assert.equal(reportByAudit.has(auditId), true);
  assert.equal(await readActiveAuditJobForWorker({ sessionArea: area }), null);
  const session = await readAuditSessionForWorker({
    sessionArea: area, sessionCapabilityId: started.sessionCapabilityId, auditId,
  });
  assert.equal(session.state, 'result');
  assert.deepEqual(session.targetBinding, { kind: 'disposable', ownershipId, state: 'retained-for-review' });
});

test('sensitive single-URL pixels durably pause with the exact owner retained and rehydrate after restart', async () => {
  const area = sessionArea();
  const prepared = await authorityFixture(area);
  const navigation = await prepared.authority.prepareNavigationForPanel({
    intent: 'single', senderContext: prepared.senderContext,
  });
  const auditId = 'audit-url-pixel-paused';
  const ownershipId = `owner_${'O'.repeat(22)}`;
  const fixture = await reportFixture(auditId);
  const reportByAudit = new Map();
  const policy = createCapturePolicyV1({ mode: 'full-evidence', includeQuery: false });
  const pixelState = createPixelCaptureStateV1({
    sessionArea: area, now: () => EPOCH + 2, randomBytes: length => new Uint8Array(length).fill(9),
  });
  const observedTarget = Object.freeze({
    version: 'ObservedTargetV1', kind: 'owned-disposable', ownershipId,
    tabId: 27, windowId: 9, documentId: 'url-document',
    urlEvidence: sanitizeEvidenceUrlV1('https://example.test/private', { includeQuery: false }),
    urlSessionDigest: `hmac-sha256:${'D'.repeat(43)}`,
    cleanupMode: 'pre-observation-failure', pageId: 'page-1',
  });
  let executions = 0;
  const pausedPackets = [];
  const cleanups = [];
  const dependencies = dependencyFixture({
    area, authority: prepared.authority, pixelState, reportByAudit,
    execution: async () => { throw new Error('ATTACHED_EXECUTION_MUST_NOT_RUN'); },
  });
  dependencies.runUrlAuditExecution = async args => {
    executions += 1;
    assert.equal(args.capturePolicy.mode, 'full-evidence');
    assert.ok(args.privacyGate);
    await args.onCheckpoint(fixture.checkpoint);
    const decision = await args.privacyGate.preflight({
      auditId, observedTarget, capturePolicy: policy,
      signals: Object.freeze({
        version: 'SensitiveCaptureSignalsV1', detected: true,
        categories: Object.freeze(['password']),
      }),
    });
    return Object.freeze({
      status: decision.status, model: null, observedTarget,
      observationState: 'observed', ownershipState: 'retained-for-consent',
      signals: Object.freeze({
        version: 'SensitiveCaptureSignalsV1', detected: true,
        categories: Object.freeze(['password']),
      }),
    });
  };
  dependencies.clearUrlAuditResources = async value => { cleanups.push(structuredClone(value)); return true; };
  dependencies.panelCoordinator = panelCoordinator([], {
    async publishPrivacyPaused(value) { pausedPackets.push(structuredClone(value)); return true; },
  });
  const starter = createAuthorizedAuditStarter(dependencies);
  const started = await starter.beginAuthorizedUrlAudit({
    capabilityId: navigation.capabilityId, auditId, senderContext: prepared.senderContext,
    capturePolicy: policy,
    retentionPreference: { version: 1, deleteAfterCompleteExport: false },
    plan: {
      kind: 'single', ownershipId, navigationToken: 'T'.repeat(22), navigationPurpose: 'single-url',
      evidenceUrl: sanitizeEvidenceUrlV1('https://example.test/private?token=raw', { includeQuery: false }),
      sessionDigest: `hmac-sha256:${'D'.repeat(43)}`,
    },
  });

  assert.deepEqual(started.response, { ok: true, auditId, state: 'running' });
  assert.deepEqual(await started.completion, {
    ok: true, auditId, state: 'privacy-paused', revision: null,
  });
  assert.equal(executions, 1);
  assert.deepEqual(cleanups, []);
  const active = await readActiveAuditJobForWorker({ sessionArea: area });
  assert.equal(active.state, 'privacy-paused');
  const session = await readAuditSessionForWorker({
    sessionArea: area, sessionCapabilityId: started.sessionCapabilityId, auditId,
  });
  assert.equal(session.state, 'privacy-paused');
  assert.deepEqual(session.targetBinding, { kind: 'disposable', ownershipId, state: 'retained-for-consent' });
  const correlation = await readNavigationAuditCorrelationForRecovery({
    sessionArea: area, capabilityId: navigation.capabilityId, auditId,
  });
  assert.equal(correlation.ownershipState, 'retained-for-consent');
  assert.equal(area.values[executionCheckpointStorageKey(auditId)].auditId, auditId);
  assert.equal((await pixelState.readSuspension(auditId)).source.ownershipId, ownershipId);
  assert.deepEqual(pausedPackets, [{
    auditId, sessionCapabilityId: started.sessionCapabilityId, windowId: 9,
  }]);

  pausedPackets.length = 0;
  const restarted = createAuthorizedAuditStarter(dependencies);
  assert.deepEqual(await restarted.recoverAuthorizedAuditLifecycle(), {
    ok: true, state: 'privacy-paused', auditId, revision: null,
  });
  assert.equal(executions, 1);
  assert.deepEqual(pausedPackets, [{
    auditId, sessionCapabilityId: started.sessionCapabilityId, windowId: 9,
  }]);
  assert.doesNotMatch(JSON.stringify({ active, pausedPackets }),
    /token=raw|TTTTTT|hmac-sha256|owner_/iu);

  assert.deepEqual(await restarted.abortAuthorizedAudit({
    auditId, sessionCapabilityId: started.sessionCapabilityId, windowId: 9, reasonCode: 'USER_CANCELLED',
  }), { ok: true, auditId, state: 'revoked' });
  assert.deepEqual(cleanups, [{ auditId, ownershipId }]);
  const cancelledSession = await readAuditSessionForWorker({
    sessionArea: area, sessionCapabilityId: started.sessionCapabilityId, auditId,
  });
  assert.equal(cancelledSession.state, 'revoked');
  assert.deepEqual(cancelledSession.targetBinding, { kind: 'disposable', ownershipId, state: 'removed' });
});

async function pausedSingleUrlAuditHarness(auditId, { attachedCopy = false } = {}) {
  const area = sessionArea();
  const prepared = await authorityFixture(area);
  const navigation = attachedCopy ? null : await prepared.authority.prepareNavigationForPanel({
    intent: 'single', senderContext: prepared.senderContext,
  });
  const ownershipId = `owner_${(attachedCopy ? 'A' : 'O').repeat(22)}`;
  const fixture = await reportFixture(auditId);
  const reportByAudit = new Map();
  const policy = createCapturePolicyV1({ mode: 'full-evidence', includeQuery: false });
  const pixelState = createPixelCaptureStateV1({
    sessionArea: area, now: () => EPOCH + 2, randomBytes: length => new Uint8Array(length).fill(11),
  });
  const observedTarget = Object.freeze({
    version: 'ObservedTargetV1', kind: 'owned-disposable', ownershipId,
    tabId: 27, windowId: 9, documentId: attachedCopy ? 'copy-document' : 'url-document',
    urlEvidence: sanitizeEvidenceUrlV1('https://example.test/private', { includeQuery: false }),
    urlSessionDigest: `hmac-sha256:${'D'.repeat(43)}`,
    cleanupMode: attachedCopy ? 'always' : 'pre-observation-failure', pageId: 'page-1',
  });
  let proof = {
    tabId: 27, windowId: 9, documentId: attachedCopy ? 'copy-document' : 'url-document',
    urlSessionDigest: `hmac-sha256:${'D'.repeat(43)}`,
  };
  let executions = 0;
  const cleanups = [];
  const signals = Object.freeze({
    version: 'SensitiveCaptureSignalsV1', detected: true,
    categories: Object.freeze(['password']),
  });
  const dependencies = dependencyFixture({
    area, authority: prepared.authority, pixelState, reportByAudit,
    execution: async () => { throw new Error('ATTACHED_EXECUTION_MUST_NOT_RUN'); },
    probeDocumentIdentity: async () => structuredClone(proof),
    probeSensitiveCaptureSignals: async () => signals,
  });
  dependencies.runUrlAuditExecution = async args => {
    executions += 1;
    if (executions !== 1) throw new Error('URL_RESUME_MUST_NOT_RUN_AFTER_DRIFT');
    await args.onCheckpoint(fixture.checkpoint);
    const decision = await args.privacyGate.preflight({
      auditId, observedTarget, capturePolicy: policy, signals,
    });
    return Object.freeze({
      status: decision.status, model: null, observedTarget,
      observationState: 'observed', ownershipState: 'retained-for-consent', signals,
    });
  };
  if (attachedCopy) dependencies.prepareAttachedCopyPlan = async () => {
    assert.equal((await prepared.authority.exchangeAttachedForNavigationCopy({
      capabilityId: prepared.capabilityId, intent: 'attached-copy', senderContext: prepared.senderContext,
    })).ok, true);
    return Object.freeze({
      kind: 'attached-copy', ownershipId, navigationToken: 'A'.repeat(22),
      navigationPurpose: 'attached-copy',
      evidenceUrl: sanitizeEvidenceUrlV1('https://example.test/private?token=raw', { includeQuery: false }),
      sessionDigest: `hmac-sha256:${'D'.repeat(43)}`,
    });
  };
  dependencies.clearUrlAuditResources = async value => { cleanups.push(structuredClone(value)); return true; };
  dependencies.panelCoordinator = panelCoordinator([], { async publishPrivacyPaused() { return true; } });
  const starter = createAuthorizedAuditStarter(dependencies);
  const started = attachedCopy
    ? await beginHistoricalAttachedCopy(starter, dependencies, {
        capabilityId: prepared.capabilityId, eventNonce: null, auditId, senderContext: prepared.senderContext,
        capturePolicy: policy,
        retentionPreference: { version: 1, deleteAfterCompleteExport: false },
      })
    : await starter.beginAuthorizedUrlAudit({
        capabilityId: navigation.capabilityId, auditId, senderContext: prepared.senderContext,
        capturePolicy: policy,
        retentionPreference: { version: 1, deleteAfterCompleteExport: false },
        plan: {
          kind: 'single', ownershipId, navigationToken: 'T'.repeat(22), navigationPurpose: 'single-url',
          evidenceUrl: sanitizeEvidenceUrlV1('https://example.test/private?token=raw', { includeQuery: false }),
          sessionDigest: `hmac-sha256:${'D'.repeat(43)}`,
        },
      });
  assert.deepEqual(await started.completion, {
    ok: true, auditId, state: 'privacy-paused', revision: null,
  });
  return {
    area, prepared, dependencies, pixelState, started, ownershipId, cleanups, fixture, reportByAudit,
    executions: () => executions,
    setProof(value) { proof = structuredClone(value); },
  };
}

test('single-URL document drift revokes consent and cleans only its exact retained owner', async () => {
  const auditId = 'audit-url-pixel-drift';
  const harness = await pausedSingleUrlAuditHarness(auditId);
  const suspension = await harness.pixelState.readSuspension(auditId);
  harness.setProof({
    tabId: 27, windowId: 9, documentId: 'url-document-b',
    urlSessionDigest: `hmac-sha256:${'D'.repeat(43)}`,
  });

  const result = await createAuthorizedAuditStarter(harness.dependencies).resumePrivacyPausedAudit({
    auditId, sessionCapabilityId: harness.started.sessionCapabilityId, windowId: 9,
    mode: 'full-evidence',
  });

  assert.deepEqual(result, {
    response: { ok: false, code: 'PIXEL_CONSENT_DOCUMENT_CHANGED' },
    sessionCapabilityId: null, completion: null,
  });
  assert.equal(harness.executions(), 1);
  assert.deepEqual(harness.cleanups, [{ auditId, ownershipId: harness.ownershipId }]);
  assert.equal(await harness.pixelState.readSuspension(auditId), null);
  assert.equal(await readActiveAuditJobForWorker({ sessionArea: harness.area }), null);
  const session = await readAuditSessionForWorker({
    sessionArea: harness.area, sessionCapabilityId: harness.started.sessionCapabilityId, auditId,
  });
  assert.equal(session.state, 'revoked');
  assert.deepEqual(session.targetBinding, {
    kind: 'disposable', ownershipId: harness.ownershipId, state: 'removed',
  });
});

test('single-URL liquidation retries after owner cleanup and capability invalidation without touching it twice', async () => {
  const auditId = 'audit-url-pixel-cleanup-retry';
  const harness = await pausedSingleUrlAuditHarness(auditId);
  const suspension = await harness.pixelState.readSuspension(auditId);
  let disconnects = 0;
  harness.dependencies.panelCoordinator = panelCoordinator([], {
    async publishPrivacyPaused() { return true; },
    async disconnectSession() { disconnects += 1; return disconnects > 1; },
  });
  const starter = createAuthorizedAuditStarter(harness.dependencies);

  assert.deepEqual(await starter.abortAuthorizedAudit({
    auditId, sessionCapabilityId: harness.started.sessionCapabilityId,
    windowId: 9, reasonCode: 'USER_CANCELLED',
  }), { ok: false, code: 'AUDIT_CANCEL_DENIED' });
  assert.deepEqual(harness.cleanups, [{ auditId, ownershipId: harness.ownershipId }]);

  assert.equal(await starter.liquidatePixelAudit({
    auditId, consentId: suspension.consentId, reason: 'AUDIT_CANCELLED',
    source: suspension.source, signal: new AbortController().signal,
  }), true);
  assert.equal(disconnects, 2);
  assert.deepEqual(harness.cleanups, [{ auditId, ownershipId: harness.ownershipId }]);
  assert.equal(await harness.pixelState.readSuspension(auditId), null);
  assert.equal(await readActiveAuditJobForWorker({ sessionArea: harness.area }), null);
});

test('restart advances a single-URL pause persisted before owner and ACTIVE pause transitions', async () => {
  const auditId = 'audit-url-pixel-pause-crash-cut';
  const harness = await pausedSingleUrlAuditHarness(auditId);
  const active = await readActiveAuditJobForWorker({ sessionArea: harness.area });
  const sessionKey = sessionCapabilityStorageKey(harness.started.sessionCapabilityId);
  harness.area.values[sessionKey] = {
    ...structuredClone(harness.area.values[sessionKey]),
    state: 'running',
    targetBinding: { kind: 'disposable', ownershipId: harness.ownershipId, state: 'pending' },
  };
  harness.area.values[ACTIVE_AUDIT_JOB_KEY] = {
    ...structuredClone(active), state: 'running', updatedAt: active.updatedAt + 1,
  };

  const recovery = await createAuthorizedAuditStarter(harness.dependencies).recoverAuthorizedAuditLifecycle();

  assert.deepEqual(recovery, { ok: true, state: 'privacy-paused', auditId, revision: null });
  assert.equal(harness.executions(), 1);
  const session = await readAuditSessionForWorker({
    sessionArea: harness.area, sessionCapabilityId: harness.started.sessionCapabilityId, auditId,
  });
  assert.equal(session.state, 'privacy-paused');
  assert.deepEqual(session.targetBinding, {
    kind: 'disposable', ownershipId: harness.ownershipId, state: 'retained-for-consent',
  });
});

test('restart during a claimed single-URL resume revokes and cleans without recapturing', async () => {
  const auditId = 'audit-url-pixel-restart-resuming';
  const harness = await pausedSingleUrlAuditHarness(auditId);
  const suspension = await harness.pixelState.readSuspension(auditId);
  await harness.pixelState.claimAndBeginResume({
    auditId, consentId: suspension.consentId, mode: suspension.mode,
    categories: suspension.categories,
    proof: {
      kind: 'owned-disposable', ownershipId: harness.ownershipId,
      tabId: suspension.tabId, windowId: suspension.windowId,
      documentId: suspension.documentId, urlSessionDigest: suspension.urlSessionDigest,
      cleanupMode: 'pre-observation-failure', pageId: 'page-1',
    },
  });
  await harness.prepared.authority.transitionDisposableAuditSession({
    sessionCapabilityId: harness.started.sessionCapabilityId, auditId,
    ownershipId: harness.ownershipId,
    fromState: 'retained-for-consent', toState: 'observing',
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
  assert.equal(harness.executions(), 1);
  assert.deepEqual(harness.cleanups, [{ auditId, ownershipId: harness.ownershipId }]);
  assert.equal(await harness.pixelState.readSuspension(auditId), null);
  assert.equal(await readActiveAuditJobForWorker({ sessionArea: harness.area }), null);
  const session = await readAuditSessionForWorker({
    sessionArea: harness.area, sessionCapabilityId: harness.started.sessionCapabilityId, auditId,
  });
  assert.equal(session.state, 'revoked');
  assert.deepEqual(session.targetBinding, {
    kind: 'disposable', ownershipId: harness.ownershipId, state: 'removed',
  });
});

test('restart during attached-copy resume liquidates its cleanup-always owner and suspension atomically', async () => {
  const auditId = 'audit-copy-pixel-restart-resuming';
  const harness = await pausedSingleUrlAuditHarness(auditId, { attachedCopy: true });
  const suspension = await harness.pixelState.readSuspension(auditId);
  await harness.pixelState.claimAndBeginResume({
    auditId, consentId: suspension.consentId, mode: suspension.mode,
    categories: suspension.categories,
    proof: {
      kind: 'owned-disposable', ownershipId: harness.ownershipId,
      tabId: suspension.tabId, windowId: suspension.windowId,
      documentId: suspension.documentId, urlSessionDigest: suspension.urlSessionDigest,
      cleanupMode: 'always', pageId: 'page-1',
    },
  });
  await harness.prepared.authority.transitionDisposableAuditSession({
    sessionCapabilityId: harness.started.sessionCapabilityId, auditId,
    ownershipId: harness.ownershipId,
    fromState: 'retained-for-consent', toState: 'observing',
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
  assert.equal(harness.executions(), 1);
  assert.deepEqual(harness.cleanups, [{
    auditId, ownershipId: harness.ownershipId,
    navigationPurpose: 'attached-copy', cleanupMode: 'always',
  }]);
  assert.equal(await harness.pixelState.readSuspension(auditId), null);
  assert.equal(await readActiveAuditJobForWorker({ sessionArea: harness.area }), null);
  const session = await readAuditSessionForWorker({
    sessionArea: harness.area, sessionCapabilityId: harness.started.sessionCapabilityId, auditId,
  });
  assert.equal(session.state, 'revoked');
  assert.deepEqual(session.targetBinding, {
    kind: 'disposable', ownershipId: harness.ownershipId, state: 'removed',
  });
  assert.doesNotMatch(JSON.stringify(recovery), /owner_|hmac-sha256|consentId|private/iu);
});

test('restart after finishing a terminal single-URL consent reconciles the exact attempt without recapturing', async () => {
  const auditId = 'audit-url-pixel-restart-terminal';
  const harness = await pausedSingleUrlAuditHarness(auditId);
  const suspension = await harness.pixelState.readSuspension(auditId);
  const proof = {
    kind: 'owned-disposable', ownershipId: harness.ownershipId,
    tabId: suspension.tabId, windowId: suspension.windowId,
    documentId: suspension.documentId, urlSessionDigest: suspension.urlSessionDigest,
    cleanupMode: 'pre-observation-failure', pageId: 'page-1',
  };
  await harness.pixelState.claimAndBeginResume({
    auditId, consentId: suspension.consentId, mode: suspension.mode,
    categories: suspension.categories, proof,
  });
  await harness.prepared.authority.transitionDisposableAuditSession({
    sessionCapabilityId: harness.started.sessionCapabilityId, auditId,
    ownershipId: harness.ownershipId,
    fromState: 'retained-for-consent', toState: 'observing',
  });
  await harness.prepared.authority.transitionAuditSession({
    sessionCapabilityId: harness.started.sessionCapabilityId, auditId, nextState: 'running',
  });
  await harness.pixelState.markSessionRunning({ auditId, consentId: suspension.consentId });
  await harness.pixelState.gateRunnerStart({
    auditId, consentId: suspension.consentId, proof, categories: suspension.categories,
  });
  await harness.prepared.authority.transitionDisposableAuditSession({
    sessionCapabilityId: harness.started.sessionCapabilityId, auditId,
    ownershipId: harness.ownershipId,
    fromState: 'observing', toState: 'retained-for-review',
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
  await harness.prepared.authority.transitionAuditSession({
    sessionCapabilityId: harness.started.sessionCapabilityId, auditId, nextState: 'result',
  });
  assert.equal(await harness.pixelState.finish({ auditId, consentId: suspension.consentId }), true);
  const attemptCalls = [];
  harness.dependencies.pixelAttemptLifecycle = Object.freeze({
    ...harness.dependencies.pixelAttemptLifecycle,
    async classify(value) {
      attemptCalls.push(['classify', structuredClone(value)]);
      return Object.freeze({ state: 'terminal', handle: null });
    },
    async cleanup(value) { attemptCalls.push(['cleanup', structuredClone(value)]); return true; },
  });
  harness.dependencies.panelCoordinator = panelCoordinator([], {
    async publishResult(value) { return issueDeferredTerminalDelivery(value); },
  });

  const recovery = await createAuthorizedAuditStarter(harness.dependencies).recoverAuthorizedAuditLifecycle();

  assert.deepEqual(recovery, { ok: true, state: 'reconciled', auditId, revision: 1 });
  assert.equal(harness.executions(), 1);
  assert.equal(await harness.pixelState.readSuspension(auditId), null);
  assert.equal(await readActiveAuditJobForWorker({ sessionArea: harness.area }), null);
  assert.deepEqual(attemptCalls, [
    ['classify', {
      auditId, consentId: null,
      pageId: 'page-1', ownershipId: harness.ownershipId,
    }],
    ['cleanup', {
      auditId, consentId: null,
      pageId: 'page-1', ownershipId: harness.ownershipId, expected: 'post-finish',
    }],
  ]);
});

test('single-URL consent is one-shot and resumes the retained owner without navigation or vault material', async () => {
  const area = sessionArea();
  const prepared = await authorityFixture(area);
  const navigation = await prepared.authority.prepareNavigationForPanel({
    intent: 'single', senderContext: prepared.senderContext,
  });
  const auditId = 'audit-url-pixel-resume';
  const ownershipId = `owner_${'O'.repeat(22)}`;
  const fixture = await reportFixture(auditId);
  const policy = createCapturePolicyV1({ mode: 'element-only', includeQuery: false });
  const pixelState = createPixelCaptureStateV1({
    sessionArea: area,
    now: (() => { let value = EPOCH + 2; return () => value++; })(),
    randomBytes: length => new Uint8Array(length).fill(10),
  });
  const evidence = sanitizeEvidenceUrlV1('https://example.test/resume', { includeQuery: false });
  const observedTarget = Object.freeze({
    version: 'ObservedTargetV1', kind: 'owned-disposable', ownershipId,
    tabId: 27, windowId: 9, documentId: 'url-document', urlEvidence: evidence,
    urlSessionDigest: `hmac-sha256:${'D'.repeat(43)}`,
    cleanupMode: 'pre-observation-failure', pageId: 'page-1',
  });
  const reportByAudit = new Map();
  const attempts = [];
  let executions = 0;
  let navigations = 0;
  const dependencies = dependencyFixture({
    area, authority: prepared.authority, pixelState, reportByAudit,
    probeDocumentIdentity: async tabId => ({
      tabId, windowId: 9, documentId: 'url-document',
      urlSessionDigest: `hmac-sha256:${'D'.repeat(43)}`,
    }),
    probeSensitiveCaptureSignals: async () => Object.freeze({
      version: 'SensitiveCaptureSignalsV1', detected: true,
      categories: Object.freeze(['password']),
    }),
    execution: async () => { throw new Error('ATTACHED_EXECUTION_MUST_NOT_RUN'); },
  });
  dependencies.runUrlAuditExecution = async args => {
    executions += 1;
    if (!Object.hasOwn(args, 'resumeTarget')) {
      navigations += 1;
      await args.onCheckpoint(fixture.checkpoint);
      const decision = await args.privacyGate.preflight({
        auditId, observedTarget, capturePolicy: policy,
        signals: Object.freeze({
          version: 'SensitiveCaptureSignalsV1', detected: true,
          categories: Object.freeze(['password']),
        }),
      });
      return Object.freeze({
        status: decision.status, model: null, observedTarget,
        observationState: 'observed', ownershipState: 'retained-for-consent',
        signals: Object.freeze({
          version: 'SensitiveCaptureSignalsV1', detected: true,
          categories: Object.freeze(['password']),
        }),
      });
    }
    assert.deepEqual(Object.keys(args).sort(), [
      'auditId', 'capturePolicy', 'modelNow', 'onCheckpoint', 'persistAuditModel',
      'privacyGate', 'requestedUrlEvidence', 'resumeCheckpoint', 'resumeTarget', 'signal',
    ]);
    assert.deepEqual(args.requestedUrlEvidence,
      sanitizeEvidenceUrlV1('https://example.test/start?token=raw', { includeQuery: false }));
    assert.deepEqual(args.resumeTarget, {
      kind: 'owned-disposable-resume', ownershipId, tabId: 27, windowId: 9,
      documentId: 'url-document', initialUrlEvidence: evidence,
      initialUrlSessionDigest: `hmac-sha256:${'D'.repeat(43)}`,
      navigationPurpose: 'single-url',
      cleanupMode: 'pre-observation-failure', pageId: 'page-1',
    });
    assert.equal(Object.hasOwn(args, 'navigationToken'), false);
    assert.equal(Object.hasOwn(args, 'evidenceUrl'), false);
    const resumeSignals = Object.freeze({
      version: 'SensitiveCaptureSignalsV1', detected: true,
      categories: Object.freeze(['password']),
    });
    try {
      assert.equal((await args.privacyGate.preflight({
        auditId, observedTarget, capturePolicy: policy, signals: resumeSignals,
      })).status, 'armed');
    } catch { throw new Error('TEST_RESUME_PREFLIGHT_FAILED'); }
    try {
      assert.equal((await args.privacyGate.authorizeFirstPixel({
        auditId, observedTarget, capturePolicy: policy,
        proof: {
          tabId: 27, windowId: 9, documentId: 'url-document',
          urlSessionDigest: `hmac-sha256:${'D'.repeat(43)}`,
        },
        signals: resumeSignals,
      })).status, 'ready');
    } catch { throw new Error('TEST_RESUME_AUTHORIZE_FAILED'); }
    await args.onCheckpoint(fixture.checkpoint);
    await args.persistAuditModel(fixture.model, observedTarget);
    try { await args.privacyGate.afterPixels({ auditId, pixelStarted: false }); }
    catch { throw new Error('TEST_RESUME_SETTLE_FAILED'); }
    return Object.freeze({
      status: 'complete', model: fixture.model, observedTarget,
      observationState: 'observed', ownershipState: 'retained-for-review',
    });
  };
  dependencies.clearUrlAuditResources = async () => { throw new Error('OWNER_MUST_REMAIN_FOR_REVIEW'); };
  const attemptHandle = Object.freeze(Object.create(null));
  dependencies.pixelAttemptLifecycle = Object.freeze({
    async prepareResume(value) { attempts.push(['prepare', structuredClone(value)]); return attemptHandle; },
    async commitTerminal(value) {
      attempts.push(['commit', value.attemptHandle]);
      return dependencies.commitTerminalAudit(value);
    },
    async classify() { return Object.freeze({ state: 'absent', handle: null }); },
    async cleanup(value) { attempts.push(['cleanup', structuredClone(value)]); return true; },
  });
  dependencies.panelCoordinator = panelCoordinator([], {
    async publishPrivacyPaused() { return true; },
    async publishRunningResume() { return true; },
    async publishResult(value) { return issueDeferredTerminalDelivery(value); },
  });
  const starter = createAuthorizedAuditStarter(dependencies);
  const started = await starter.beginAuthorizedUrlAudit({
    capabilityId: navigation.capabilityId, auditId, senderContext: prepared.senderContext,
    capturePolicy: policy,
    retentionPreference: { version: 1, deleteAfterCompleteExport: false },
    plan: {
      kind: 'single', ownershipId, navigationToken: 'T'.repeat(22), navigationPurpose: 'single-url',
      evidenceUrl: sanitizeEvidenceUrlV1('https://example.test/start?token=raw', { includeQuery: false }),
      sessionDigest: `hmac-sha256:${'D'.repeat(43)}`,
    },
  });
  await started.completion;
  const paused = await pixelState.readSuspension(auditId);

  const forgedPublicConsent = await createAuthorizedAuditStarter(dependencies).resumePrivacyPausedAudit({
    auditId, sessionCapabilityId: started.sessionCapabilityId, windowId: 9,
    consentId: paused.consentId, mode: 'element-only',
  });
  assert.deepEqual(forgedPublicConsent, {
    response: { ok: false, code: 'AUDIT_RESUME_DENIED' }, sessionCapabilityId: null, completion: null,
  });
  assert.equal(executions, 1);

  const resumed = await createAuthorizedAuditStarter(dependencies).resumePrivacyPausedAudit({
    auditId, sessionCapabilityId: started.sessionCapabilityId, windowId: 9,
    mode: 'element-only',
  });
  assert.deepEqual(resumed.response, { ok: true, auditId, state: 'running' });
  assert.deepEqual(await resumed.completion, { ok: true, auditId, state: 'result', revision: 1 });
  assert.equal(executions, 2);
  assert.equal(navigations, 1);
  assert.equal(await pixelState.readSuspension(auditId), null);
  const session = await readAuditSessionForWorker({
    sessionArea: area, sessionCapabilityId: started.sessionCapabilityId, auditId,
  });
  assert.equal(session.state, 'result');
  assert.deepEqual(session.targetBinding, { kind: 'disposable', ownershipId, state: 'retained-for-review' });
  assert.deepEqual(attempts[0], ['prepare', {
    auditId, consentId: paused.consentId, pageId: 'page-1', ownershipId, expiresAt: paused.expiresAt,
  }]);
  assert.equal(attempts[1][0], 'commit');
  assert.deepEqual(attempts[2], ['cleanup', {
    auditId, consentId: paused.consentId, pageId: 'page-1', ownershipId, expected: 'post-finish',
  }]);

  const replay = await createAuthorizedAuditStarter(dependencies).resumePrivacyPausedAudit({
    auditId, sessionCapabilityId: started.sessionCapabilityId, windowId: 9,
    mode: 'element-only',
  });
  assert.deepEqual(replay, {
    response: { ok: false, code: 'AUDIT_RESUME_DENIED' }, sessionCapabilityId: null, completion: null,
  });
  assert.equal(executions, 2);
  assert.doesNotMatch(JSON.stringify({ response: resumed.response, replay }),
    /token=raw|TTTTTT|hmac-sha256|owner_|consentId/iu);
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
    async publishResult(value) { order.push('publish:result'); return issueDeferredTerminalDelivery(value); },
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
    auditId, consentId: paused.consentId, expected: 'post-finish',
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

test('attached privacy resume still requires its legacy private consent identifier', async () => {
  const auditId = 'audit-attached-private-consent-required';
  const harness = await pausedAuditHarness(auditId);
  const suspension = await harness.suspension();

  const missingConsent = await createAuthorizedAuditStarter(harness.dependencies).resumePrivacyPausedAudit({
    auditId, sessionCapabilityId: harness.started.sessionCapabilityId,
    windowId: 9, mode: 'full-evidence',
  });

  assert.deepEqual(missingConsent, {
    response: { ok: false, code: 'AUDIT_RESUME_DENIED' }, sessionCapabilityId: null, completion: null,
  });
  assert.equal(harness.executions, 1);
  assert.deepEqual(await harness.suspension(), suspension);
});

test('a failed running-resume publication compensates the claimed attempt before returning denial', async t => {
  for (const [name, publishRunningResume] of [
    ['false', async () => false],
    ['rejection', async () => { throw new Error('PRIVATE_RUNNING_POST_FAILURE'); }],
  ]) await t.test(name, async () => {
    const auditId = `audit-resume-publication-${name}`;
    const harness = await pausedAuditHarness(auditId);
    const paused = await harness.suspension();
    let attemptState = 'absent';
    const cleanups = [];
    harness.dependencies.pixelAttemptLifecycle = Object.freeze({
      async prepareResume() {
        attemptState = 'prepared';
        return Object.freeze(Object.create(null));
      },
      async commitTerminal() { throw new Error('TERMINAL_COMMIT_MUST_NOT_RUN'); },
      async classify() { return Object.freeze({ state: attemptState, handle: null }); },
      async cleanup(value) {
        cleanups.push(structuredClone(value));
        if (attemptState !== 'prepared' || value.expected !== 'prepared') return false;
        attemptState = 'absent';
        return true;
      },
    });
    harness.dependencies.panelCoordinator = panelCoordinator([], { publishRunningResume });

    const resumed = await createAuthorizedAuditStarter(harness.dependencies).resumePrivacyPausedAudit({
      auditId, sessionCapabilityId: harness.started.sessionCapabilityId,
      windowId: 9, consentId: paused.consentId, mode: 'full-evidence',
    });

    assert.deepEqual(resumed, {
      response: { ok: false, code: 'AUDIT_RESUME_DENIED' }, sessionCapabilityId: null, completion: null,
    });
    assert.equal(harness.executions, 1);
    assert.equal(await readActiveAuditJobForWorker({ sessionArea: harness.area }), null);
    assert.equal(await harness.suspension(), null);
    assert.equal((await readAuditSessionForWorker({
      sessionArea: harness.area,
      sessionCapabilityId: harness.started.sessionCapabilityId,
      auditId,
    })).state, 'revoked');
    assert.deepEqual(cleanups, [{
      auditId, consentId: paused.consentId, expected: 'prepared',
    }]);
    assert.equal(attemptState, 'absent');
    assert.doesNotMatch(JSON.stringify(resumed), /PRIVATE|POST|FAILURE/u);
  });
});

test('startup advances an exact paused crash cut from running session and ACTIVE without replaying collection', async () => {
  const auditId = 'audit-pause-crash-cut';
  const harness = await pausedAuditHarness(auditId);
  const pausedActive = await readActiveAuditJobForWorker({ sessionArea: harness.area });
  const pausedSuspension = await harness.suspension();
  const pausedCheckpoint = structuredClone(harness.area.values[executionCheckpointStorageKey(auditId)]);
  assert.deepEqual(await harness.prepared.authority.transitionAuditSession({
    sessionCapabilityId: harness.started.sessionCapabilityId,
    auditId,
    nextState: 'running',
  }), {
    ok: true, sessionCapabilityId: harness.started.sessionCapabilityId, auditId, state: 'running',
  });
  harness.area.values[ACTIVE_AUDIT_JOB_KEY] = {
    ...structuredClone(pausedActive), state: 'running',
  };
  harness.pausedPackets.length = 0;

  const recovery = await createAuthorizedAuditStarter(harness.dependencies).recoverAuthorizedAuditLifecycle();

  assert.deepEqual(recovery, { ok: true, state: 'privacy-paused', auditId, revision: null });
  assert.equal(harness.executions, 1);
  assert.equal((await readActiveAuditJobForWorker({ sessionArea: harness.area })).state, 'privacy-paused');
  assert.equal((await readAuditSessionForWorker({
    sessionArea: harness.area,
    sessionCapabilityId: harness.started.sessionCapabilityId,
    auditId,
  })).state, 'privacy-paused');
  assert.deepEqual(await harness.suspension(), pausedSuspension);
  assert.deepEqual(harness.area.values[executionCheckpointStorageKey(auditId)], pausedCheckpoint);
  assert.deepEqual(harness.pausedPackets, [{
    auditId, sessionCapabilityId: harness.started.sessionCapabilityId, windowId: 9,
  }]);
});

test('startup blocks a paused crash cut whose checkpoint correlation is missing', async () => {
  const auditId = 'audit-pause-crash-cut-mismatch';
  const harness = await pausedAuditHarness(auditId);
  const pausedActive = await readActiveAuditJobForWorker({ sessionArea: harness.area });
  const pausedSuspension = await harness.suspension();
  await harness.prepared.authority.transitionAuditSession({
    sessionCapabilityId: harness.started.sessionCapabilityId,
    auditId,
    nextState: 'running',
  });
  harness.area.values[ACTIVE_AUDIT_JOB_KEY] = {
    ...structuredClone(pausedActive), state: 'running',
  };
  delete harness.area.values[executionCheckpointStorageKey(auditId)];
  harness.pausedPackets.length = 0;

  assert.deepEqual(await createAuthorizedAuditStarter(harness.dependencies).recoverAuthorizedAuditLifecycle(), {
    ok: false, state: 'blocked', auditId: null, revision: null, code: 'AUDIT_RECOVERY_REQUIRED',
  });
  assert.equal(harness.executions, 1);
  assert.equal((await readActiveAuditJobForWorker({ sessionArea: harness.area })).state, 'running');
  assert.equal((await readAuditSessionForWorker({
    sessionArea: harness.area,
    sessionCapabilityId: harness.started.sessionCapabilityId,
    auditId,
  })).state, 'running');
  assert.deepEqual(await harness.suspension(), pausedSuspension);
  assert.deepEqual(harness.pausedPackets, []);
});

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
    async publishResult(value) {
      effects.publishes += 1;
      return issueDeferredTerminalDelivery(value);
    },
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
      return issueDeferredTerminalDelivery(value);
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
      return issueDeferredTerminalDelivery(value);
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
      return issueDeferredTerminalDelivery(value);
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
      return issueDeferredTerminalDelivery(value);
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

test('real launch authority and panel client reconnect after a failed terminal post without manual recovery', async () => {
  const area = sessionArea();
  const prepared = await authorityFixture(area);
  const report = await reportFixture('audit-terminal-delivery-reconnect');
  const reportByAudit = new Map();
  let terminalBundle = null;
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
  dependencies.buildPanelResultBundle = async ({ reportRevision }) => {
    terminalBundle = await createPanelResultBundleV1({ reportRevision, inventory: report.inventory });
    return terminalBundle;
  };
  let panelUrl = null;
  const launchChromeApi = {
    runtime: {
      id: 'abcdefghijklmnopabcdefghijklmnop',
      async getContexts({ contextTypes, documentUrls }) {
        assert.deepEqual(contextTypes, ['SIDE_PANEL']);
        assert.deepEqual(documentUrls, [panelUrl]);
        return [{
          contextType: 'SIDE_PANEL', contextId: 'panel-context', documentId: 'panel-doc',
          documentUrl: panelUrl, tabId: -1, windowId: -1,
        }];
      },
    },
  };
  const launchAuthority = createPanelLaunchAuthority({
    chromeApi: launchChromeApi, sessionArea: area, now: () => EPOCH + 1,
    randomBytes: length => new Uint8Array(length).fill(0x2c),
  });
  assert.equal(await launchAuthority.initialize(), true);
  const issued = launchAuthority.issue({ tabId: 17, windowId: 9 });
  assert.equal(await launchAuthority.whenReady(issued), true);
  const durableSet = area.set.bind(area);
  let admittedCommitThrows = 0;
  area.set = async entries => {
    await durableSet(entries);
    if (admittedCommitThrows === 0 && Object.entries(entries).some(([key, value]) =>
      key.startsWith('audita:panel-launch:') && value?.state === 'admitted')) {
      admittedCommitThrows += 1;
      throw new Error('PRIVATE_LAUNCH_ADMISSION_COMMIT');
    }
  };
  panelUrl = `chrome-extension://abcdefghijklmnopabcdefghijklmnop/${issued.path}`;
  const coordinator = durablePanelCoordinator({
    area,
    pixelState: dependencies.pixelState,
    loadPanelResultBundle: async ({ auditId }) => auditId === report.model.auditId ? terminalBundle : null,
    rehydrateViewOnly: args => prepared.authority.rehydrateViewOnly(args),
    revokeViewOnly: async () => true,
    launchAuthority,
  });
  dependencies.panelCoordinator = coordinator;
  let failResultPosts = 1;
  const connectedUrls = [];
  const clientTimers = [];
  const clientStates = [];
  const client = createPanelSessionPortClient({
    chromeApi: {
      runtime: {
        connect({ name }) {
          assert.equal(name, PANEL_PORT_NAME);
          connectedUrls.push(panelUrl);
          return linkedPanelPortPair({
            coordinator,
            sender: {
              id: 'abcdefghijklmnopabcdefghijklmnop', url: panelUrl,
              origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
            },
            failResult: failResultPosts > 0 ? () => { failResultPosts -= 1; } : null,
          });
        },
      },
    },
    onBootstrapResult(value) { clientStates.push(structuredClone(value)); },
    onStatus() {},
    onHighlightState() {},
    createRequestId: () => 'request-terminal-reconnect',
    setTimer(callback, delay) {
      const timer = { callback, delay, active: true };
      clientTimers.push(timer);
      return timer;
    },
    clearTimer(timer) { timer.active = false; },
  });
  assert.equal(client.start(), true);
  await waitUntil(() => clientStates.some(value => value.state === 'initial'));

  const started = await createAuthorizedAuditStarter(dependencies).beginAuthorizedAudit({
    capabilityId: prepared.capabilityId, eventNonce: null, auditId: report.model.auditId,
    capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    retentionPreference: { version: 1, deleteAfterCompleteExport: false }, senderContext: prepared.senderContext,
  });

  assert.deepEqual(await started.completion, {
    ok: true, auditId: report.model.auditId, state: 'result', revision: 1,
  });
  assert.equal(Object.hasOwn(area.values, ACTIVE_AUDIT_JOB_KEY), false);
  await waitUntil(() => clientTimers.some(timer => timer.active && timer.delay === 250));
  const reconnect = clientTimers.find(timer => timer.active && timer.delay === 250);
  reconnect.active = false;
  reconnect.callback();
  await waitUntil(() => clientStates.some(value => value.state === 'view-only'));

  const rehydrated = clientStates.find(value => value.state === 'view-only');
  assert.equal(rehydrated.auditId, report.model.auditId);
  assert.equal(rehydrated.state, 'view-only');
  assert.equal(rehydrated.result.auditId, report.model.auditId);
  assert.deepEqual(rehydrated.result, terminalBundle);
  assert.equal(failResultPosts, 0);
  assert.equal(admittedCommitThrows, 1);
  assert.deepEqual(connectedUrls, [panelUrl, panelUrl]);
  assert.doesNotMatch(JSON.stringify({ completion: await started.completion, rehydrated }), /PRIVATE|POST_FAILURE/u);
  assert.equal(client.stop(), true);
});

test('a denied real-coordinator Port retirement preserves confirmed finalizing ACTIVE', async () => {
  const area = sessionArea();
  const prepared = await authorityFixture(area);
  const report = await reportFixture('audit-terminal-retirement-denied');
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
  const coordinator = durablePanelCoordinator({
    area,
    pixelState: dependencies.pixelState,
    launchAuthority: admittedPanelLaunchAuthority('denied'),
  });
  dependencies.panelCoordinator = coordinator;
  const connected = attachedPanelPort({ failState: 'result' });
  assert.equal(coordinator.attachPanelPort(connected), true);
  connected.onMessage.emit({ protocol: 'audita-panel', version: 1, type: 'bootstrap' });
  await waitUntil(() => connected.messages.some(message => message.state === 'initial'));

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
  assert.equal(active.expectedTerminalRevision, 1);
  assert.equal(connected.disconnects, 1);
});

test('settlement keeps confirmed ACTIVE for unbranded or hostile terminal delivery receipts', async t => {
  let accessorReads = 0;
  const accessor = {};
  Object.defineProperties(accessor, {
    version: { enumerable: true, value: 1 },
    state: { enumerable: true, get() { accessorReads += 1; return 'delivered'; } },
  });
  const cases = [
    ['undefined', async () => undefined],
    ['boolean true', async () => true],
    ['raw delivered', async () => ({ version: 1, state: 'delivered' })],
    ['raw deferred', async () => ({ version: 1, state: 'deferred' })],
    ['raw denied', async () => ({ version: 1, state: 'denied' })],
    ['accessor', async () => accessor],
    ['symbol', async () => ({ version: 1, state: 'delivered', [Symbol('private')]: true })],
    ['extra', async () => ({ version: 1, state: 'delivered', privateReceipt: true })],
    ['proxy', async () => new Proxy({ version: 1, state: 'delivered' }, {
      ownKeys() { throw new Error('PRIVATE_RECEIPT_TRAP'); },
    })],
    ['rejection', async () => { throw new Error('PRIVATE_PUBLICATION_REJECTION'); }],
  ];

  for (const [name, publishResult] of cases) await t.test(name, async () => {
    const area = sessionArea();
    const prepared = await authorityFixture(area);
    const report = await reportFixture(`audit-hostile-receipt-${name.replaceAll(' ', '-')}`);
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
    dependencies.panelCoordinator = panelCoordinator([], { publishResult });
    const started = await createAuthorizedAuditStarter(dependencies).beginAuthorizedAudit({
      capabilityId: prepared.capabilityId, eventNonce: null, auditId: report.model.auditId,
      capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
      retentionPreference: { version: 1, deleteAfterCompleteExport: false }, senderContext: prepared.senderContext,
    });

    const completion = await started.completion;
    assert.deepEqual(completion, {
      ok: false, auditId: report.model.auditId, state: 'blocked', code: 'AUDIT_RECOVERY_REQUIRED',
    });
    const active = await readActiveAuditJobForWorker({ sessionArea: area });
    assert.equal(active.state, 'finalizing');
    assert.equal(active.commitState, 'confirmed');
    assert.doesNotMatch(JSON.stringify(completion), /PRIVATE|RECEIPT|PUBLICATION/u);
  });
  assert.equal(accessorReads, 0);
});

test('settlement keeps the confirmed finalizing job when a live result publication returns false', async () => {
  const area = sessionArea();
  const prepared = await authorityFixture(area);
  const report = await reportFixture('audit-publication-live-failure');
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
  dependencies.panelCoordinator = panelCoordinator([], { publishResult: async () => false });

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

test('finalizing recovery keeps ACTIVE when a live result publication returns false', async () => {
  const area = sessionArea();
  const prepared = await authorityFixture(area);
  const report = await reportFixture('audit-recovery-live-publication');
  const reportByAudit = new Map();
  const firstDependencies = dependencyFixture({
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
  firstDependencies.buildPanelResultBundle = ({ reportRevision }) => createPanelResultBundleV1({
    reportRevision, inventory: report.inventory,
  });
  firstDependencies.panelCoordinator = panelCoordinator([], { publishResult: async () => undefined });
  const started = await createAuthorizedAuditStarter(firstDependencies).beginAuthorizedAudit({
    capabilityId: prepared.capabilityId, eventNonce: null, auditId: report.model.auditId,
    capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    retentionPreference: { version: 1, deleteAfterCompleteExport: false }, senderContext: prepared.senderContext,
  });
  await started.completion;

  const recoveryDependencies = dependencyFixture({
    area, authority: prepared.authority, reportByAudit,
    execution: async () => { throw new Error('RECOVERY_MUST_NOT_RERUN_COLLECTION'); },
  });
  recoveryDependencies.buildPanelResultBundle = ({ reportRevision }) => createPanelResultBundleV1({
    reportRevision, inventory: report.inventory,
  });
  recoveryDependencies.panelCoordinator = panelCoordinator([], { publishResult: async () => false });

  assert.deepEqual(await createAuthorizedAuditStarter(recoveryDependencies).recoverAuthorizedAuditLifecycle(), {
    ok: false, state: 'blocked', auditId: null, revision: null, code: 'AUDIT_RECOVERY_REQUIRED',
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

for (const hasActivePage of [true, false]) test(`restart cleans correlated batch resources before revoking and removing a running ACTIVE (active page: ${hasActivePage})`, async () => {
  const area = sessionArea();
  const { authority, senderContext } = await authorityFixture(area);
  const prepared = await authority.prepareNavigationForPanel({ intent: 'batch', senderContext });
  const auditId = 'audit-batch-restart-running';
  const progress = persistedBatchProgress(auditId);
  const claimed = await authority.claimNavigationAndIssueAuditSession({
    capabilityId: prepared.capabilityId,
    auditId,
    ownershipId: null,
    intent: 'batch',
    senderContext,
  });
  assert.equal(claimed.ok, true);
  const ownershipId = `owner_${'R'.repeat(22)}`;
  if (hasActivePage) assert.equal((await authority.transitionBatchAuditSession({
    sessionCapabilityId: claimed.sessionCapabilityId,
    auditId,
    fromPageId: null,
    fromOwnershipId: null,
    toPageId: 'page-1',
    toOwnershipId: ownershipId,
  })).ok, true);
  area.values[ACTIVE_AUDIT_JOB_KEY] = {
    version: 1,
    auditId,
    capabilityId: prepared.capabilityId,
    sessionCapabilityId: claimed.sessionCapabilityId,
    windowId: 9,
    mode: 'batch',
    state: 'running',
    commitState: 'none',
    expectedTerminalRevision: null,
    createdAt: EPOCH + 1,
    updatedAt: EPOCH + 1,
  };
  const cleanupCalls = [];
  const dependencies = dependencyFixture({
    area,
    authority,
    execution: async () => { throw new Error('RECOVERY_MUST_NOT_RERUN_COLLECTION'); },
  });
  dependencies.runUrlAuditExecution = async () => { throw new Error('URL_EXECUTION_MUST_NOT_RUN'); };
  dependencies.clearUrlAuditResources = async () => true;
  dependencies.runBatchAuditExecution = async () => { throw new Error('BATCH_EXECUTION_MUST_NOT_RESTART'); };
  dependencies.clearBatchAuditResources = async request => {
    cleanupCalls.push(structuredClone(request));
    const correlation = await readBatchAuditCorrelationForRecovery({
      sessionArea: area,
      capabilityId: request.capabilityId,
      auditId: request.auditId,
    });
    if (correlation.activePageId === null && correlation.activeOwnershipId === null) return true;
    const cleared = await authority.transitionBatchAuditSession({
      sessionCapabilityId: request.sessionCapabilityId,
      auditId: request.auditId,
      fromPageId: correlation.activePageId,
      fromOwnershipId: correlation.activeOwnershipId,
      toPageId: null,
      toOwnershipId: null,
    });
    return cleared.ok === true;
  };
  dependencies.clearBatchAuditProgress = async () => true;
  dependencies.discardBatchAuditProgress = async request => {
    const correlation = await readBatchAuditCorrelationForRecovery({
      sessionArea: area, capabilityId: prepared.capabilityId, auditId,
    });
    assert.equal(correlation.activeOwnershipId, null);
    assert.equal(area.values[ACTIVE_AUDIT_JOB_KEY]?.auditId, auditId);
    return progress.discard(request);
  };

  assert.deepEqual(await createAuthorizedAuditStarter(dependencies).recoverAuthorizedAuditLifecycle(), {
    ok: true,
    state: 'interrupted',
    auditId,
    revision: null,
  });
  assert.deepEqual(cleanupCalls, [{
    auditId,
    capabilityId: prepared.capabilityId,
    sessionCapabilityId: claimed.sessionCapabilityId,
    windowId: 9,
  }]);
  const session = await readAuditSessionForWorker({
    sessionArea: area,
    sessionCapabilityId: claimed.sessionCapabilityId,
    auditId,
  });
  assert.equal(session.state, 'revoked');
  assert.deepEqual(session.targetBinding, {
    kind: 'batch',
    activePageId: null,
    activeOwnershipId: null,
  });
  const correlation = await readBatchAuditCorrelationForRecovery({
    sessionArea: area,
    capabilityId: prepared.capabilityId,
    auditId,
  });
  assert.equal(correlation.capabilityState, 'invalidated');
  assert.equal(await readActiveAuditJobForWorker({ sessionArea: area }), null);
  assert.equal(Object.hasOwn(await progress.storage.get(auditId), auditId), false);
});

test('live batch cancellation aborts execution, cleans resources and settles the session as revoked', async () => {
  const area = sessionArea();
  const { authority, senderContext } = await authorityFixture(area);
  const prepared = await authority.prepareNavigationForPanel({ intent: 'batch', senderContext });
  const auditId = 'audit-batch-live-cancel';
  const progress = persistedBatchProgress(auditId);
  let announceExecution;
  const executionEntered = new Promise(resolve => { announceExecution = resolve; });
  const cleanupCalls = [];
  const dependencies = dependencyFixture({
    area,
    authority,
    execution: async () => { throw new Error('ATTACHED_EXECUTION_MUST_NOT_RUN'); },
  });
  dependencies.runUrlAuditExecution = async () => { throw new Error('URL_EXECUTION_MUST_NOT_RUN'); };
  dependencies.clearUrlAuditResources = async () => true;
  dependencies.runBatchAuditExecution = async ({ signal }) => {
    announceExecution();
    await new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    throw new Error('UNREACHABLE_BATCH_EXECUTION');
  };
  dependencies.clearBatchAuditResources = async request => {
    cleanupCalls.push(structuredClone(request));
    return true;
  };
  dependencies.clearBatchAuditProgress = async () => true;
  dependencies.discardBatchAuditProgress = async request => {
    assert.equal(cleanupCalls.length, 1);
    assert.equal(area.values[ACTIVE_AUDIT_JOB_KEY]?.auditId, auditId);
    return progress.discard(request);
  };
  const starter = createAuthorizedAuditStarter(dependencies);
  const started = await starter.beginAuthorizedBatchAudit({
    capabilityId: prepared.capabilityId,
    auditId,
    senderContext,
    capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    retentionPreference: { version: 1, deleteAfterCompleteExport: false },
    async preparePlan() { return { kind: 'batch', queueId: auditId, acceptedCount: 2 }; },
  });
  assert.deepEqual(started.response, { ok: true, auditId, state: 'running' });
  await executionEntered;

  assert.deepEqual(await starter.abortAuthorizedAudit({
    auditId,
    sessionCapabilityId: started.sessionCapabilityId,
    windowId: 9,
    reasonCode: 'USER_CANCELLED',
  }), { ok: true, auditId, state: 'cancelling' });
  assert.deepEqual(await started.completion, {
    ok: true,
    auditId,
    state: 'revoked',
    code: 'AUDIT_REVOKED',
  });
  assert.equal(cleanupCalls.length, 1);
  assert.deepEqual(cleanupCalls[0], {
    auditId,
    capabilityId: prepared.capabilityId,
    sessionCapabilityId: started.sessionCapabilityId,
    windowId: 9,
  });
  const session = await readAuditSessionForWorker({
    sessionArea: area,
    sessionCapabilityId: started.sessionCapabilityId,
    auditId,
  });
  assert.equal(session.state, 'revoked');
  const correlation = await readBatchAuditCorrelationForRecovery({
    sessionArea: area,
    capabilityId: prepared.capabilityId,
    auditId,
  });
  assert.equal(correlation.capabilityState, 'invalidated');
  assert.deepEqual({
    activePageId: correlation.activePageId,
    activeOwnershipId: correlation.activeOwnershipId,
  }, {
    activePageId: null,
    activeOwnershipId: null,
  });
  assert.equal(await readActiveAuditJobForWorker({ sessionArea: area }), null);
  assert.equal(Object.hasOwn(await progress.storage.get(auditId), auditId), false);
});

for (const terminalKind of ['cancelled', 'failed']) {
test(`batch ${terminalKind} retains ACTIVE when progress discard fails and restart retries it`, async () => {
  const area = sessionArea();
  const { authority, senderContext } = await authorityFixture(area);
  const prepared = await authority.prepareNavigationForPanel({ intent: 'batch', senderContext });
  const auditId = `audit-batch-discard-${terminalKind}`;
  const progress = persistedBatchProgress(auditId);
  let announceExecution;
  const executionEntered = new Promise(resolve => { announceExecution = resolve; });
  let discardBlocked = true;
  const dependencies = dependencyFixture({ area, authority, execution: async () => {} });
  Object.assign(dependencies, {
    runUrlAuditExecution: async () => {},
    clearUrlAuditResources: async () => true,
    async runBatchAuditExecution({ signal }) {
      announceExecution();
      if (terminalKind === 'cancelled') {
        await new Promise((resolve, reject) => {
          if (signal.aborted) reject(signal.reason);
          else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      }
      throw new Error('BATCH_EXECUTION_FAILED');
    },
    clearBatchAuditResources: async () => true,
    clearBatchAuditProgress: async () => { throw new Error('RESULT_CLEAR_MUST_NOT_RUN'); },
    async discardBatchAuditProgress(request) {
      if (discardBlocked) throw new Error('BATCH_PROGRESS_UNAVAILABLE');
      return progress.discard(request);
    },
  });
  const starter = createAuthorizedAuditStarter(dependencies);
  const started = await starter.beginAuthorizedBatchAudit({
    capabilityId: prepared.capabilityId, auditId, senderContext,
    capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    retentionPreference: { version: 1, deleteAfterCompleteExport: false },
    async preparePlan() { return { kind: 'batch', queueId: auditId, acceptedCount: 2 }; },
  });
  await executionEntered;
  if (terminalKind === 'cancelled') {
    assert.equal((await starter.abortAuthorizedAudit({
      auditId, sessionCapabilityId: started.sessionCapabilityId, windowId: 9, reasonCode: 'USER_CANCELLED',
    })).state, 'cancelling');
  }
  assert.deepEqual(await started.completion, {
    ok: false, auditId, state: 'blocked', code: 'AUDIT_RECOVERY_REQUIRED',
  });
  assert.equal((await readActiveAuditJobForWorker({ sessionArea: area }))?.auditId, auditId);
  assert.equal(Object.hasOwn(await progress.storage.get(auditId), auditId), true);
  assert.equal((await createAuthorizedAuditStarter(dependencies).recoverAuthorizedAuditLifecycle()).state, 'blocked');
  assert.equal((await readActiveAuditJobForWorker({ sessionArea: area }))?.auditId, auditId);
  discardBlocked = false;
  assert.deepEqual(await createAuthorizedAuditStarter(dependencies).recoverAuthorizedAuditLifecycle(), {
    ok: true, state: 'interrupted', auditId, revision: null,
  });
  assert.equal(await readActiveAuditJobForWorker({ sessionArea: area }), null);
  assert.equal(Object.hasOwn(await progress.storage.get(auditId), auditId), false);
});
}

test('claimed batch start keeps its journal until interrupted recovery is fully confirmed', async () => {
  const area = sessionArea();
  const { authority, senderContext } = await authorityFixture(area);
  const prepared = await authority.prepareNavigationForPanel({ intent: 'batch', senderContext });
  const auditId = 'audit-batch-claimed-retry';
  const claimed = await authority.claimNavigationAndIssueAuditSession({
    capabilityId: prepared.capabilityId,
    auditId,
    ownershipId: null,
    intent: 'batch',
    senderContext,
  });
  assert.equal(claimed.ok, true);
  const journalKey = 'audita:start-journal:v1';
  area.values[journalKey] = {
    version: 1, capabilityId: prepared.capabilityId, auditId, windowId: 9,
    mode: 'batch', state: 'claimed', sessionCapabilityId: claimed.sessionCapabilityId,
    createdAt: EPOCH + 1, updatedAt: EPOCH + 1,
  };
  let cleanupAttempts = 0;
  const dependencies = dependencyFixture({
    area, authority,
    execution: async () => { throw new Error('ATTACHED_EXECUTION_MUST_NOT_RUN'); },
  });
  dependencies.runUrlAuditExecution = async () => { throw new Error('URL_EXECUTION_MUST_NOT_RUN'); };
  dependencies.clearUrlAuditResources = async () => true;
  dependencies.runBatchAuditExecution = async () => { throw new Error('BATCH_EXECUTION_MUST_NOT_RUN'); };
  dependencies.clearBatchAuditResources = async () => {
    cleanupAttempts += 1;
    return cleanupAttempts > 1;
  };
  dependencies.clearBatchAuditProgress = async () => true;
  dependencies.discardBatchAuditProgress = async () => true;
  const starter = createAuthorizedAuditStarter(dependencies);

  assert.deepEqual(await starter.recoverAuthorizedAuditLifecycle(), {
    ok: false, state: 'blocked', auditId: null, revision: null, code: 'AUDIT_RECOVERY_REQUIRED',
  });
  assert.equal(area.values[journalKey]?.auditId, auditId);
  assert.equal(area.values[journalKey]?.state, 'claimed');

  assert.deepEqual(await starter.recoverAuthorizedAuditLifecycle(), {
    ok: true, state: 'interrupted', auditId, revision: null,
  });
  assert.equal(cleanupAttempts, 2);
  assert.equal(Object.hasOwn(area.values, journalKey), false);
  const session = await readAuditSessionForWorker({
    sessionArea: area, sessionCapabilityId: claimed.sessionCapabilityId, auditId,
  });
  assert.equal(session.state, 'revoked');
});

test('restart blocks an uncorrelated privacy-paused batch ACTIVE without touching cleanup resources', async () => {
  const area = sessionArea();
  const { authority } = await authorityFixture(area);
  const hostile = {
    version: 1,
    auditId: 'audit-batch-illegal-pause',
    capabilityId: 'A'.repeat(22),
    sessionCapabilityId: 'B'.repeat(22),
    windowId: 9,
    mode: 'batch',
    state: 'privacy-paused',
    commitState: 'none',
    expectedTerminalRevision: null,
    createdAt: EPOCH,
    updatedAt: EPOCH,
  };
  area.values[ACTIVE_AUDIT_JOB_KEY] = structuredClone(hostile);
  let cleanupCalls = 0;
  const dependencies = dependencyFixture({
    area,
    authority,
    execution: async () => { throw new Error('ATTACHED_EXECUTION_MUST_NOT_RUN'); },
  });
  dependencies.runUrlAuditExecution = async () => { throw new Error('URL_EXECUTION_MUST_NOT_RUN'); };
  dependencies.clearUrlAuditResources = async () => true;
  dependencies.runBatchAuditExecution = async () => { throw new Error('BATCH_EXECUTION_MUST_NOT_RUN'); };
  dependencies.clearBatchAuditResources = async () => {
    cleanupCalls += 1;
    return true;
  };
  dependencies.clearBatchAuditProgress = async () => true;
  dependencies.discardBatchAuditProgress = async () => true;

  assert.deepEqual(await createAuthorizedAuditStarter(dependencies).recoverAuthorizedAuditLifecycle(), {
    ok: false,
    state: 'blocked',
    auditId: null,
    revision: null,
    code: 'AUDIT_RECOVERY_REQUIRED',
  });
  assert.equal(cleanupCalls, 0);
  assert.deepEqual(area.values[ACTIVE_AUDIT_JOB_KEY], hostile);
  assert.deepEqual(await readActiveAuditJobForWorker({ sessionArea: area }), hostile);
});
