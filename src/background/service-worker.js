import { createInstalledCoreRuleInventory } from '../core/rules/core-rule-inventory.js';
import { isCapturePolicyV1 } from '../core/privacy/capture-policy.js';
import {
  createSessionPixelAttemptDigestAuthority,
  createSessionUrlDigestManager,
} from '../core/privacy/session-url-digest.js';
import { createRawNavigationVaultV1 } from './raw-navigation-vault.js';
import { createPageMarkerOriginCache, PAGE_MARKER_ORIGIN_TTL_MS } from './page-marker-origin-cache.js';
import { createPageMarkersController } from './page-markers-controller.js';
import {
  PAGE_MARKERS_PORT_NAME,
  createPageMarkersWorkerBridge,
  createPageMarkersWorkerLifecycle,
  isPageMarkersRuntimeMessage,
} from './page-markers-worker-bridge.js';
import { createBlobUrlPortBridgeV1 } from './blob-url-port.js';
import { BLOB_URL_PORT_NAME } from '../export/blob-url-protocol.js';
import { createBatchProgressStoreV1 } from './batch-progress-store.js';
import { createAuditDeletedEvent } from '../core/audit-deleted-event.js';
import { applyReviewDecisions, createReviewDecision } from '../core/review/decisions.js';
import { createAuditModel } from '../core/report/audit-model.js';
import { createPanelResultBundleV1 } from '../panel/panel-result-bundle.js';
import {
  createAuditStore,
  readPrivatePixelAttemptCommitV1,
  removePrivatePixelAttemptCommitV1,
} from '../storage/audit-store.js';
import {
  ACTIVE_AUDIT_JOB_KEY,
  createAuthorizedAuditStarter,
  executionCheckpointStorageKey,
  readActiveAuditJobForWorker,
  reserveAttachedCopyStartJournalV1,
} from './authorized-audit-starter.js';
import { createAuditLifecycle } from './audit-lifecycle.js';
import { createAuditDeletionCoordinatorV1 } from './audit-deletion-coordinator.js';
import { registerRetentionSchedulerV1 } from './retention-scheduler.js';
import { createPixelCaptureStateV1 } from './pixel-capture-consent.js';
import { createPixelPrivacyGateV1 } from './pixel-privacy-gate.js';
import {
  createNativePixelCommitClockV1,
  isPixelCommitClockV1,
} from './pixel-commit-clock.js';
import {
  PIXEL_CONSENT_ALARM_NAME,
  createPixelConsentExpirySchedulerV1,
} from './pixel-consent-expiry.js';
import {
  createPixelAttemptCorrelationV1,
  createPixelAttemptStoreBindingV1,
} from './pixel-attempt-correlation.js';
import {
  AUDIT_EXECUTION_INTERNAL,
  composeChromeAdapter,
  createChromeAdapter,
  createChromeAuditAuthority,
} from './chrome-adapter.js';
import { isEvidenceUrlV1, sanitizeEvidenceUrlV1 } from '../core/privacy/evidence-url.js';
import { registerAuditContextMenus } from './context-menu.js';
import { validateExecutionCheckpoint } from './execution-checkpoint.js';
import { recordHighlightBindingV1 } from './highlight-binding.js';
import { createHighlightBindingRecorder } from './highlight-binding-recorder.js';
import { createHighlightBindingStore } from './highlight-binding-store.js';
import { createHighlightController } from './highlight-controller.js';
import { createHighlightLiveVerifier } from './highlight-live-verifier.js';
import { createHighlightModelAuthority } from './highlight-model-authority.js';
import { createHighlightSessionAuthorityBridge } from './highlight-session-authority.js';
import {
  PANEL_PORT_NAME,
  createPanelPortCoordinator,
  panelBootstrapStorageKey,
} from './panel-port.js';
import { createPanelLaunchAuthority } from './panel-launch-authority.js';
import { createPanelLauncher } from './panel-launcher.js';
import { createPersonaCoordinator } from './persona-coordinator.js';
import { createPersonaLeaseStore } from './persona-lease-store.js';
import { createPersonaInjectionRuntime } from './persona-runtime.js';
import { createPersonaStartOrchestrator } from './persona-start-orchestrator.js';
import { createOwnershipId, runAttachedAuditExecution, runUrlAudit } from './run-audit.js';
import { runBatch } from './run-batch.js';
import { createBatchAuditExecutionV1 } from './batch-audit-execution.js';
import { runObservedTabAudit } from './observed-tab-runner.js';
import { createOwnedTabRegistry } from './owned-tabs.js';
import { createSidePanelIntentRouter } from './side-panel-intent-router.js';
import { createReportLaunchAuthority } from './report-launch.js';
import {
  REPORT_PORT_NAME,
  createReportPortCoordinator,
} from './report-port.js';
import { createExportLaunchAuthority } from './export-launch.js';
import { createExportCompletionStore } from './export-completion-store.js';
import { createTargetOperationQueue } from './target-operation-queue.js';
import {
  createLiveAidCleanup,
} from './live-aid-cleanup.js';
import {
  createTargetCapabilityAuthority,
  readBatchAuditCorrelationForRecovery,
  readAuditSessionForWorker,
} from './target-capabilities.js';
import { isPanelPortIntent, parseWorkerMessage } from './worker-protocol.js';

export const SESSION_ACCESS_LEVEL_DENIED = 'SESSION_ACCESS_LEVEL_DENIED';
export const SIDE_PANEL_DEFAULT_DENIED = 'SIDE_PANEL_DEFAULT_DENIED';
export const SIDE_PANEL_BEHAVIOR_DENIED = 'SIDE_PANEL_BEHAVIOR_DENIED';
export const PERSONA_EXPIRY_ALARM_NAME = 'audita-persona-expiry-v1';
export const HIGHLIGHT_EXPIRY_ALARM_NAME = 'audita-highlight-expiry-v1';

const AUDIT_ID = /^[A-Za-z0-9._:-]{1,160}$/u;
const CAPABILITY = /^[A-Za-z0-9_-]{22}$/u;
const PANEL_BOOTSTRAP_PREFIX = 'audita:panel-bootstrap:v1:';
const PANEL_BOOTSTRAP_KEYS = Object.freeze([
  'version', 'kind', 'auditId', 'sessionCapabilityId', 'windowId', 'captureMode',
  'createdAt', 'expiresAt', 'state',
]);

function freeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freeze(child, seen);
  return Object.freeze(value);
}

function exact(value, keys, allowNullPrototype = false) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && (!allowNullPrototype || prototype !== null)) return null;
    const own = Reflect.ownKeys(value);
    if (own.length !== keys.length || own.some(key => typeof key !== 'string' || !keys.includes(key))) return null;
    const copy = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      copy[key] = descriptor.value;
    }
    return copy;
  } catch { return null; }
}

function own(value, key) {
  try {
    const descriptor = value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, key) : null;
    return descriptor?.enumerable && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  } catch { return undefined; }
}

function dataEntries(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length > 50_000 || keys.some(key => typeof key !== 'string')) return null;
    const entries = [];
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      entries.push([key, descriptor.value]);
    }
    return entries;
  } catch { return null; }
}

function panelBootstrapRecord(value) {
  const record = exact(value, PANEL_BOOTSTRAP_KEYS, true);
  return record && record.version === 1 && record.kind === 'audit-session' &&
    AUDIT_ID.test(record.auditId ?? '') && CAPABILITY.test(record.sessionCapabilityId ?? '') &&
    Number.isSafeInteger(record.windowId) && record.windowId >= 0 &&
    ['no-pixels', 'element-only', 'full-evidence'].includes(record.captureMode) &&
    Number.isSafeInteger(record.createdAt) && record.createdAt >= 0 &&
    Number.isSafeInteger(record.expiresAt) && record.expiresAt > record.createdAt &&
    ['pending', 'consumed'].includes(record.state)
    ? Object.freeze(record)
    : null;
}

export async function disconnectPanelAuditSessions({ auditId, sessionArea, panelCoordinator } = {}) {
  if (!AUDIT_ID.test(auditId ?? '') || typeof sessionArea?.get !== 'function' ||
    typeof panelCoordinator?.withWindowLock !== 'function') return false;
  try {
    const entries = dataEntries(await sessionArea.get(null));
    if (!entries) return false;
    const candidates = [];
    const windows = new Set();
    for (const [key, value] of entries) {
      if (!key.startsWith(PANEL_BOOTSTRAP_PREFIX)) continue;
      const record = panelBootstrapRecord(value);
      if (!record) {
        if (own(value, 'auditId') === auditId) return false;
        continue;
      }
      if (key !== panelBootstrapStorageKey(record.windowId)) {
        if (record.auditId === auditId) return false;
        continue;
      }
      if (record.auditId !== auditId) continue;
      if (windows.has(record.windowId)) return false;
      windows.add(record.windowId);
      candidates.push(record);
    }
    candidates.sort((left, right) => left.windowId - right.windowId);
    for (const record of candidates) {
      const disconnected = await panelCoordinator.withWindowLock(record.windowId, scope => {
        if (typeof scope?.disconnectSession !== 'function') return false;
        return scope.disconnectSession({
          auditId: record.auditId,
          sessionCapabilityId: record.sessionCapabilityId,
          windowId: record.windowId,
          reasonCode: 'AUDIT_DELETED',
        });
      });
      if (disconnected !== true) return false;
      const remaining = dataEntries(await sessionArea.get(panelBootstrapStorageKey(record.windowId)));
      if (!remaining || remaining.some(([key]) => key === panelBootstrapStorageKey(record.windowId))) return false;
    }
    return true;
  } catch { return false; }
}

function captureSensitiveCaptureProbeAuthority(adapter) {
  const first = own(adapter, 'probeSensitiveCaptureSignals');
  const second = own(adapter, 'probeSensitiveCaptureSignals');
  if (typeof first !== 'function' || first !== second) throw new Error('WORKER_UNAVAILABLE');
  return Object.freeze((tabId, documentId) => Reflect.apply(first, adapter, [tabId, documentId]));
}

function same(left, right) {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) !== Array.isArray(right)) return false;
  const leftKeys = Reflect.ownKeys(left);
  const rightKeys = Reflect.ownKeys(right);
  return leftKeys.length === rightKeys.length && leftKeys.every(key => rightKeys.includes(key) && same(left[key], right[key]));
}

function canonicalModelTime(modelNow) {
  const value = modelNow();
  if (typeof value !== 'string') throw new Error('WORKER_UNAVAILABLE');
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) throw new Error('WORKER_UNAVAILABLE');
  return value;
}

function randomBytes(length) {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

function base64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/gu, '');
}

function defaultNonce() { return base64Url(randomBytes(16)); }
function defaultAuditId() { return globalThis.crypto.randomUUID(); }

const PIXEL_ATTEMPT_MARKER_PREFIX = 'audita:pixel-attempt:v1:';
const CONSENT_ID = /^[A-Za-z0-9_-]{21}[AQgw]$/u;
const ATTEMPT_DIGEST = /^hmac-sha256:[A-Za-z0-9_-]{43}$/u;
const PRIVATE_ID = /^[A-Za-z0-9._:-]{1,160}$/u;
const BATCH_PAGE_ID = /^page-([1-9]|1[0-9]|20)$/u;
const OWNER_ID = /^owner_[A-Za-z0-9_-]{22}$/u;
const PIXEL_POLICY_KEYS = Object.freeze([
  'version', 'mode', 'includeQuery', 'captureFullPage', 'captureElements', 'composeAnnouncementMap',
]);
const PIXEL_SUSPENSION_KEYS = Object.freeze([
  'version', 'revision', 'auditId', 'consentId', 'tabId', 'windowId', 'documentId',
  'urlEvidence', 'urlSessionDigest', 'mode', 'capturePolicy', 'categories', 'issuedAt',
  'updatedAt', 'expiresAt', 'cleanupAttempts', 'cleanupNotBefore', 'state',
  'resumePhase', 'revokeReason', 'source',
]);

// RASTER no modelo do commit terminal (achado D2 da revisão da 1.1.37): payload de pixel embutido —
// `dataUrl` do artefato ou, no mapa de anúncio, `dataUrl` de segmento. É o mesmo critério que o orçamento
// de evidências usa para omitir pixels, e é a pergunta que o commit precisa responder antes de gravar sem
// a alça da tentativa.
function modelCarriesRaster(model) {
  const evidence = Array.isArray(model?.evidence) ? model.evidence : [];
  return evidence.some(artifact => typeof artifact?.dataUrl === 'string' ||
    (Array.isArray(artifact?.segments) &&
      artifact.segments.some(segment => typeof segment?.dataUrl === 'string')));
}

function batchPixelPolicy(value) {
  const policy = exact(value, PIXEL_POLICY_KEYS, true);
  return policy && isCapturePolicyV1(policy) && policy.mode !== 'no-pixels' && policy.includeQuery === false
    ? freeze({ ...policy })
    : null;
}

function sameBatchPixelPolicy(left, right) {
  return Boolean(left && right) && PIXEL_POLICY_KEYS.every(key => left[key] === right[key]);
}

function batchPixelEvidence(value) {
  const evidence = exact(value, ['version', 'href', 'queryIncluded', 'redactedSegments'], true);
  return evidence && isEvidenceUrlV1(evidence) && evidence.queryIncluded === false
    ? freeze({ ...evidence })
    : null;
}

function batchPixelCategories(value) {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== value.length + 1 || !ownKeys.includes('length')) return null;
    const copy = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value') ||
        !['password', 'otp', 'payment', 'private-marker'].includes(descriptor.value)) return null;
      copy.push(descriptor.value);
    }
    return freeze(copy);
  } catch { return null; }
}

function batchPixelChildTarget(value, expected) {
  const target = exact(value, [
    'version', 'kind', 'ownershipId', 'tabId', 'windowId', 'documentId',
    'urlEvidence', 'urlSessionDigest', 'cleanupMode', 'pageId',
  ], true);
  const evidence = target && batchPixelEvidence(target.urlEvidence);
  return target?.version === 'ObservedTargetV1' && target.kind === 'owned-disposable' &&
    target.ownershipId === expected.ownershipId && target.windowId === expected.windowId &&
    Number.isSafeInteger(target.tabId) && target.tabId >= 0 &&
    typeof target.documentId === 'string' && PRIVATE_ID.test(target.documentId) && evidence &&
    ATTEMPT_DIGEST.test(target.urlSessionDigest ?? '') && target.cleanupMode === 'always' &&
    target.pageId === 'page-1'
    ? freeze({ ...target, urlEvidence: evidence })
    : null;
}

function projectBatchPixelTarget(target, pageId) {
  return freeze({ ...target, pageId });
}

function projectBatchPixelProof(value, expected, pageId) {
  const proof = exact(value, [
    'kind', 'ownershipId', 'tabId', 'windowId', 'documentId',
    'urlSessionDigest', 'cleanupMode', 'pageId',
  ], true);
  return proof?.kind === 'owned-disposable' && proof.ownershipId === expected.ownershipId &&
    proof.windowId === expected.windowId && Number.isSafeInteger(proof.tabId) && proof.tabId >= 0 &&
    typeof proof.documentId === 'string' && PRIVATE_ID.test(proof.documentId) &&
    ATTEMPT_DIGEST.test(proof.urlSessionDigest ?? '') && proof.cleanupMode === 'always' &&
    proof.pageId === 'page-1'
    ? freeze({ ...proof, pageId })
    : null;
}

function projectBatchPixelSuspension(value, expected, direction) {
  const suspension = exact(value, PIXEL_SUSPENSION_KEYS, true);
  const policy = suspension && batchPixelPolicy(suspension.capturePolicy);
  const evidence = suspension && batchPixelEvidence(suspension.urlEvidence);
  const categories = suspension && batchPixelCategories(suspension.categories);
  const source = suspension && exact(suspension.source,
    ['kind', 'ownershipId', 'cleanupMode', 'pageId'], true);
  const fromAuditId = direction === 'to-child' ? expected.batchAuditId : expected.childAuditId;
  const fromPageId = direction === 'to-child' ? expected.pageId : 'page-1';
  const toAuditId = direction === 'to-child' ? expected.childAuditId : expected.batchAuditId;
  const toPageId = direction === 'to-child' ? 'page-1' : expected.pageId;
  if (!suspension || suspension.auditId !== fromAuditId || !policy || !evidence || !categories ||
    !source || source.kind !== 'owned-disposable' || source.ownershipId !== expected.ownershipId ||
    source.cleanupMode !== 'always' || source.pageId !== fromPageId) return null;
  return freeze({
    ...suspension,
    auditId: toAuditId,
    capturePolicy: policy,
    urlEvidence: evidence,
    categories,
    source: freeze({ ...source, pageId: toPageId }),
  });
}

export function createBatchPagePixelPrivacyGateV1(raw) {
  const input = exact(raw, [
    'pixelState', 'pixelCommitClock', 'batchAuditId', 'childAuditId', 'pageId',
    'ownershipId', 'consentId', 'authorityExpiresAt', 'capturePolicy',
  ]);
  const pause = input && own(input.pixelState, 'pause');
  const gateRunnerStart = input && own(input.pixelState, 'gateRunnerStart');
  const capturePolicy = input && batchPixelPolicy(input.capturePolicy);
  if (!input || typeof pause !== 'function' || typeof gateRunnerStart !== 'function' ||
    !AUDIT_ID.test(input.batchAuditId ?? '') || !AUDIT_ID.test(input.childAuditId ?? '') ||
    !BATCH_PAGE_ID.test(input.pageId ?? '') || !OWNER_ID.test(input.ownershipId ?? '') ||
    !capturePolicy || !Number.isSafeInteger(input.authorityExpiresAt) || input.authorityExpiresAt < 0) {
    throw new TypeError('BATCH_PIXEL_GATE_DENIED');
  }
  const expected = freeze({
    batchAuditId: input.batchAuditId,
    childAuditId: input.childAuditId,
    pageId: input.pageId,
    ownershipId: input.ownershipId,
    windowId: null,
  });
  const assertPolicy = value => {
    const policy = batchPixelPolicy(value);
    if (!policy || !sameBatchPixelPolicy(policy, capturePolicy)) throw new Error('BATCH_PIXEL_GATE_DENIED');
    return policy;
  };
  const facade = Object.freeze({
    async pause(rawRequest) {
      const request = exact(rawRequest, [
        'auditId', 'observedTarget', 'mode', 'capturePolicy', 'categories', 'authorityExpiresAt',
      ]);
      const windowId = request?.observedTarget && own(request.observedTarget, 'windowId');
      const targetExpected = { ...expected, windowId };
      const target = request && batchPixelChildTarget(request.observedTarget, targetExpected);
      const policy = request && assertPolicy(request.capturePolicy);
      const categories = request && batchPixelCategories(request.categories);
      if (!request || request.auditId !== expected.childAuditId || request.mode !== capturePolicy.mode ||
        request.authorityExpiresAt !== input.authorityExpiresAt || !target || !policy || !categories) {
        throw new Error('BATCH_PIXEL_GATE_DENIED');
      }
      const suspension = await Reflect.apply(pause, input.pixelState, [{
        ...request,
        auditId: expected.batchAuditId,
        observedTarget: projectBatchPixelTarget(target, expected.pageId),
        capturePolicy: policy,
        categories,
      }]);
      const projected = projectBatchPixelSuspension(suspension,
        { ...expected, windowId: target.windowId }, 'to-child');
      if (!projected) throw new Error('BATCH_PIXEL_GATE_DENIED');
      return projected;
    },
    async gateRunnerStart(rawRequest) {
      const request = exact(rawRequest, ['auditId', 'consentId', 'proof', 'categories']);
      const windowId = request?.proof && own(request.proof, 'windowId');
      const proof = request && projectBatchPixelProof(request.proof, { ...expected, windowId }, expected.pageId);
      const categories = request && batchPixelCategories(request.categories);
      if (!request || request.auditId !== expected.childAuditId || !proof || !categories) {
        throw new Error('BATCH_PIXEL_GATE_DENIED');
      }
      const rawResult = await Reflect.apply(gateRunnerStart, input.pixelState, [{
        ...request,
        auditId: expected.batchAuditId,
        proof,
        categories,
      }]);
      const result = exact(rawResult, ['version', 'status', 'suspension'], true);
      const suspension = result && projectBatchPixelSuspension(result.suspension,
        { ...expected, windowId: proof.windowId }, 'to-child');
      if (!result || !['ready', 'repaused'].includes(result.status) || !suspension) {
        throw new Error('BATCH_PIXEL_GATE_DENIED');
      }
      return freeze({ ...result, suspension });
    },
  });
  return createPixelPrivacyGateV1({
    pixelState: facade,
    consentId: input.consentId,
    authorityExpiresAt: input.authorityExpiresAt,
    commitClock: input.pixelCommitClock,
    async afterPixels() {},
  });
}

function pixelAttemptMarker(value) {
  const row = exact(value, [
    'version', 'auditId', 'attemptDigest', 'pageId', 'ownershipId', 'preparedAt', 'expiresAt',
  ], true);
  if (!row || row.version !== 1 || !AUDIT_ID.test(row.auditId ?? '') ||
    !ATTEMPT_DIGEST.test(row.attemptDigest ?? '') ||
    (row.pageId !== null && !PRIVATE_ID.test(row.pageId ?? '')) ||
    (row.ownershipId !== null && !PRIVATE_ID.test(row.ownershipId ?? '')) ||
    !Number.isSafeInteger(row.preparedAt) || row.preparedAt < 0 ||
    !Number.isSafeInteger(row.expiresAt) || row.expiresAt <= row.preparedAt) return null;
  return Object.freeze(row);
}

function samePixelAttempt(left, right) {
  return Boolean(left && right) && left.auditId === right.auditId &&
    left.attemptDigest === right.attemptDigest && left.pageId === right.pageId &&
    left.ownershipId === right.ownershipId;
}

export function createLateBoundPixelLiquidatorFacadeV1() {
  let liquidate = null;
  const facade = Object.freeze({
    async liquidate(value) {
      if (liquidate === null) return false;
      try { return await liquidate(value) === true; }
      catch { return false; }
    },
  });
  return Object.freeze({
    facade,
    bind(value) {
      if (liquidate !== null || typeof value !== 'function') return false;
      liquidate = value;
      return true;
    },
  });
}

export function createPixelAttemptLifecycleV1(raw) {
  const input = exact(raw, [
    'sessionArea', 'auditStore', 'attemptAuthority', 'attemptCorrelation', 'modelNow',
  ]);
  if (!input || typeof input.sessionArea?.get !== 'function' ||
    typeof input.auditStore?.commitAuditWithCheckpointIfAbsent !== 'function' ||
    typeof input.auditStore?.getReportRevision !== 'function' ||
    typeof input.attemptAuthority?.digestAttempt !== 'function' ||
    typeof input.attemptCorrelation?.prepare !== 'function' ||
    typeof input.attemptCorrelation?.markerMatches !== 'function' ||
    typeof input.attemptCorrelation?.remove !== 'function' || typeof input.modelNow !== 'function') {
    throw new TypeError('PIXEL_ATTEMPT_LIFECYCLE_INVALID');
  }

  const handles = new WeakMap();
  const createHandle = (capability, correlation, consentId) => {
    const handle = Object.freeze(Object.create(null));
    handles.set(handle, Object.freeze({ capability, correlation, consentId }));
    return handle;
  };
  const markerStorageKey = marker =>
    `${PIXEL_ATTEMPT_MARKER_PREFIX}${marker.auditId}:${marker.attemptDigest.slice('hmac-sha256:'.length)}`;

  async function scanMarker(auditId) {
    let envelope;
    try { envelope = await input.sessionArea.get(null); }
    catch { return { state: 'blocked', marker: null }; }
    let keys;
    try {
      if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(envelope))) {
        return { state: 'blocked', marker: null };
      }
      keys = Reflect.ownKeys(envelope);
    } catch { return { state: 'blocked', marker: null }; }
    const prefix = `${PIXEL_ATTEMPT_MARKER_PREFIX}${auditId}:`;
    const matches = [];
    for (const key of keys) {
      if (typeof key !== 'string' || !key.startsWith(prefix)) continue;
      let descriptor;
      try { descriptor = Object.getOwnPropertyDescriptor(envelope, key); }
      catch { return { state: 'blocked', marker: null }; }
      const marker = descriptor?.enumerable && Object.hasOwn(descriptor, 'value')
        ? pixelAttemptMarker(descriptor.value) : null;
      if (!marker || marker.auditId !== auditId || markerStorageKey(marker) !== key) {
        return { state: 'blocked', marker: null };
      }
      matches.push(marker);
    }
    if (matches.length > 1) return { state: 'blocked', marker: null };
    return { state: 'ok', marker: matches[0] ?? null };
  }

  async function prepareResume(rawRequest) {
    const request = exact(rawRequest, ['auditId', 'consentId', 'pageId', 'ownershipId', 'expiresAt']);
    const attachedAttempt = request?.pageId === null && request?.ownershipId === null;
    const ownedAttempt = BATCH_PAGE_ID.test(request?.pageId ?? '') &&
      /^owner_[A-Za-z0-9_-]{22}$/u.test(request?.ownershipId ?? '');
    if (!request || !AUDIT_ID.test(request.auditId ?? '') || !CONSENT_ID.test(request.consentId ?? '') ||
      (!attachedAttempt && !ownedAttempt) ||
      !Number.isSafeInteger(request.expiresAt) || request.expiresAt < 0) {
      throw new TypeError('PIXEL_ATTEMPT_LIFECYCLE_INVALID');
    }
    const capability = await input.attemptCorrelation.prepare(request);
    const attemptDigest = await input.attemptAuthority.digestAttempt({
      auditId: request.auditId, consentId: request.consentId,
    });
    const correlation = Object.freeze({
      auditId: request.auditId, attemptDigest,
      pageId: request.pageId, ownershipId: request.ownershipId,
    });
    if (await input.attemptCorrelation.markerMatches(correlation) !== true) {
      throw new TypeError('PIXEL_ATTEMPT_LIFECYCLE_INVALID');
    }
    return createHandle(capability, correlation, request.consentId);
  }

  // TENTATIVA DIRETA (conserto do percurso de pixel em página SEM sinal sensível): a captura que o portão
  // autoriza sem pausa precisa do MESMO companheiro durável da captura consentida — o marcador de tentativa
  // que amarra o raster à auditoria. Sem consentimento não há `consentId`; o digesto vem do domínio próprio
  // (`audita:pixel-direct-attempt:v1`) e a guarda D2 do commit terminal segue INTACTA.
  async function prepareDirect(rawRequest) {
    const request = exact(rawRequest, ['auditId', 'expiresAt']);
    if (!request || !AUDIT_ID.test(request.auditId ?? '') ||
      !Number.isSafeInteger(request.expiresAt) || request.expiresAt < 0) {
      throw new TypeError('PIXEL_ATTEMPT_LIFECYCLE_INVALID');
    }
    const capability = await input.attemptCorrelation.prepare({
      auditId: request.auditId, consentId: null, pageId: null, ownershipId: null,
      expiresAt: request.expiresAt,
    });
    const attemptDigest = await input.attemptAuthority.digestDirectAttempt({ auditId: request.auditId });
    const correlation = Object.freeze({
      auditId: request.auditId, attemptDigest, pageId: null, ownershipId: null,
    });
    if (await input.attemptCorrelation.markerMatches(correlation) !== true) {
      throw new TypeError('PIXEL_ATTEMPT_LIFECYCLE_INVALID');
    }
    return createHandle(capability, correlation, null);
  }

  async function classifyCore(rawRequest) {
    const compact = exact(rawRequest, ['auditId', 'consentId']);
    const correlated = exact(rawRequest, ['auditId', 'consentId', 'pageId', 'ownershipId']);
    const request = compact ?? correlated;
    const expectedPageId = correlated?.pageId ?? null;
    const expectedOwnershipId = correlated?.ownershipId ?? null;
    const expectedAttached = expectedPageId === null && expectedOwnershipId === null;
    const expectedOwned = BATCH_PAGE_ID.test(expectedPageId ?? '') &&
      /^owner_[A-Za-z0-9_-]{22}$/u.test(expectedOwnershipId ?? '');
    if (!request || !AUDIT_ID.test(request.auditId ?? '') ||
      !(request.consentId === null || CONSENT_ID.test(request.consentId ?? '')) ||
      (!expectedAttached && !expectedOwned)) {
      return { state: 'blocked', handle: null, correlation: null };
    }
    const scan = await scanMarker(request.auditId);
    if (scan.state !== 'ok') return { state: 'blocked', handle: null, correlation: null };
    let correlation = scan.marker && Object.freeze({
      auditId: scan.marker.auditId, attemptDigest: scan.marker.attemptDigest,
      pageId: scan.marker.pageId, ownershipId: scan.marker.ownershipId,
    });
    if (correlation && (correlation.pageId !== expectedPageId ||
      correlation.ownershipId !== expectedOwnershipId)) {
      return { state: 'blocked', handle: null, correlation: null };
    }
    if (request.consentId !== null) {
      let attemptDigest;
      try {
        attemptDigest = await input.attemptAuthority.digestAttempt({
          auditId: request.auditId, consentId: request.consentId,
        });
      } catch { return { state: 'blocked', handle: null, correlation: null }; }
      const expected = Object.freeze({
        auditId: request.auditId, attemptDigest,
        pageId: expectedPageId, ownershipId: expectedOwnershipId,
      });
      if (correlation && !samePixelAttempt(correlation, expected)) {
        return { state: 'blocked', handle: null, correlation: null };
      }
      correlation = expected;
    }
    if (!correlation) {
      try {
        return request.consentId !== null && await input.auditStore.getReportRevision(request.auditId)
          ? { state: 'blocked', handle: null, correlation: null }
          : { state: 'absent', handle: null, correlation: null };
      } catch { return { state: 'blocked', handle: null, correlation: null }; }
    }
    const markerPresent = await input.attemptCorrelation.markerMatches(correlation);
    let companionPresent;
    let report;
    try {
      [companionPresent, report] = await Promise.all([
        readPrivatePixelAttemptCommitV1(input.auditStore, correlation),
        input.auditStore.getReportRevision(request.auditId),
      ]);
    } catch { return { state: 'blocked', handle: null, correlation: null }; }
    if (markerPresent !== true) {
      return companionPresent === true || request.consentId !== null && Boolean(report)
        ? { state: 'blocked', handle: null, correlation: null }
        : { state: 'absent', handle: null, correlation: null };
    }
    const terminal = companionPresent === true;
    if (terminal !== Boolean(report)) return { state: 'blocked', handle: null, correlation: null };
    return { state: terminal ? 'terminal' : 'prepared', handle: null, correlation };
  }

  async function classify(request) {
    const result = await classifyCore(request);
    return Object.freeze({ state: result.state, handle: result.handle });
  }

  async function commitTerminal(rawRequest) {
    const request = exact(rawRequest, [
      'auditId', 'model', 'checkpoint', 'latestState', 'expectedRevision', 'attemptHandle',
    ]);
    const metadata = request?.attemptHandle === null ? null : handles.get(request?.attemptHandle);
    if (!request || !AUDIT_ID.test(request.auditId ?? '') || request.expectedRevision !== 1 ||
      (request.attemptHandle !== null && (!metadata || metadata.correlation.auditId !== request.auditId))) {
      throw new Error('TERMINAL_COMMIT_DENIED');
    }
    // FECHADO À FALHA, achado D2 da revisão da 1.1.37: um commit SEM a alça da tentativa não pode gravar
    // pixels. Sem esta guarda, o modelo com raster entrava no armazenamento sem o companheiro durável de
    // correlação — e a promessa "captura do documento B nunca atribuída à auditoria de A" ficava dependendo
    // de o chamador lembrar de mandar a alça. Modelo sem raster (modo no-pixels, ou pixels omitidos pelo
    // orçamento) continua commitando sem alça.
    //
    // FRONTEIRA DECLARADA: auditoria de VÁRIAS URLs (modelo com mais de uma página) tem uma tentativa
    // consentida POR PÁGINA — `onPixelPageFinished` fecha a tentativa da página e zera a alça antes da
    // próxima. Nesse caso a correlação durável do raster é a da página (marcador `prepared` + journal de
    // captura em estado `finished`, com o `pageId` em cada artefato), e não uma tentativa terminal que não
    // existe. O resíduo — modelo de lote sem companheiro no armazenamento — está registrado no QA; fechá-lo
    // exige uma tentativa terminal de lote, que é mudança de ciclo de vida, não de guarda.
    const batchModel = Array.isArray(request.model?.pages) && request.model.pages.length > 1;
    if (metadata === null && !batchModel && modelCarriesRaster(request.model)) {
      throw new Error('TERMINAL_COMMIT_DENIED');
    }
    let committed;
    try {
      committed = await input.auditStore.commitAuditWithCheckpointIfAbsent(
        request.auditId, request.model, request.checkpoint, request.latestState,
        {
          now: canonicalModelTime(input.modelNow), deleteAfterCompleteExport: false,
          ...(metadata ? { pixelAttemptCommit: metadata.capability } : {}),
        },
      );
    } catch { /* a readback below is the commit authority */ }
    let report;
    try { report = await input.auditStore.getReportRevision(request.auditId); }
    catch { throw new Error('TERMINAL_COMMIT_DENIED'); }
    const revision = committed?.revision ?? report?.modelRevision;
    const modelHash = committed?.modelHash ?? report?.modelHash;
    if (revision !== 1 || report?.modelRevision !== 1 || typeof modelHash !== 'string' ||
      report.modelHash !== modelHash) throw new Error('TERMINAL_COMMIT_DENIED');
    if (metadata) {
      const classified = await classifyCore({
        auditId: request.auditId, consentId: metadata.consentId,
        pageId: metadata.correlation.pageId, ownershipId: metadata.correlation.ownershipId,
      });
      if (classified.state !== 'terminal') throw new Error('TERMINAL_COMMIT_DENIED');
    }
    return Object.freeze({ revision: 1, modelHash });
  }

  async function cleanup(rawRequest) {
    const compact = exact(rawRequest, ['auditId', 'consentId', 'expected']);
    const correlated = exact(rawRequest, ['auditId', 'consentId', 'expected', 'pageId', 'ownershipId']);
    const request = compact ?? correlated;
    const pageId = correlated?.pageId ?? null;
    const ownershipId = correlated?.ownershipId ?? null;
    const expectedAttached = pageId === null && ownershipId === null;
    const expectedOwned = BATCH_PAGE_ID.test(pageId ?? '') && /^owner_[A-Za-z0-9_-]{22}$/u.test(ownershipId ?? '');
    if (!request || !AUDIT_ID.test(request.auditId ?? '') ||
      !(request.consentId === null || CONSENT_ID.test(request.consentId ?? '')) ||
      !['prepared', 'terminal', 'post-finish'].includes(request.expected) ||
      (!expectedAttached && !expectedOwned)) return false;
    if (request.expected === 'post-finish') {
      const scan = await scanMarker(request.auditId);
      if (scan.state !== 'ok') return false;
      if (scan.marker === null) return true;
      if (scan.marker.pageId !== pageId || scan.marker.ownershipId !== ownershipId) return false;
      const correlation = Object.freeze({
        auditId: scan.marker.auditId, attemptDigest: scan.marker.attemptDigest,
        pageId: scan.marker.pageId, ownershipId: scan.marker.ownershipId,
      });
      let companion; let report;
      try {
        [companion, report] = await Promise.all([
          readPrivatePixelAttemptCommitV1(input.auditStore, correlation),
          input.auditStore.getReportRevision(request.auditId),
        ]);
      } catch { return false; }
      if (companion === false && report) {
        try {
          return await input.attemptCorrelation.remove(correlation) === true &&
            await input.attemptCorrelation.markerMatches(correlation) === false;
        } catch { return false; }
      }
    }
    const current = await classifyCore(correlated
      ? { auditId: request.auditId, consentId: request.consentId, pageId, ownershipId }
      : { auditId: request.auditId, consentId: request.consentId });
    if (current.state === 'blocked') return false;
    if (current.state === 'absent') return request.expected === 'post-finish';
    if (request.expected === 'prepared' && current.state !== 'prepared' ||
      request.expected !== 'prepared' && current.state !== 'terminal') return false;
    if (current.state === 'terminal') {
      try {
        if (await removePrivatePixelAttemptCommitV1(input.auditStore, current.correlation) !== true ||
          await readPrivatePixelAttemptCommitV1(input.auditStore, current.correlation) !== false) return false;
      } catch { return false; }
    }
    try {
      if (await input.attemptCorrelation.remove(current.correlation) !== true ||
        await input.attemptCorrelation.markerMatches(current.correlation) !== false) return false;
    } catch { return false; }
    return true;
  }

  return Object.freeze({ prepareResume, prepareDirect, commitTerminal, classify, cleanup });
}

export function createExactUrlAuditResourceCleanerV1(raw) {
  const input = exact(raw, ['rawNavigationVault', 'ownedTabRegistry']);
  if (!input || typeof input.rawNavigationVault?.clearAudit !== 'function' ||
    typeof input.ownedTabRegistry?.get !== 'function' ||
    typeof input.ownedTabRegistry?.removeOwned !== 'function') {
    throw new TypeError('URL_AUDIT_CLEANER_INVALID');
  }
  const states = new Set([
    'created', 'observing', 'retained-for-review', 'retained-for-consent', 'cleanup-pending', 'removed',
  ]);
  const parseOwned = (value, auditId, ownershipId, cleanupMode) => {
    if (value === null) return null;
    const record = exact(value, [
      'version', 'ownershipId', 'auditId', 'purpose', 'tabId', 'windowId',
      'cleanupMode', 'state', 'createdAt', 'updatedAt',
    ]);
    return record?.version === 2 && record.ownershipId === ownershipId && record.auditId === auditId &&
      record.purpose === 'audit' && Number.isSafeInteger(record.tabId) && record.tabId >= 0 &&
      Number.isSafeInteger(record.windowId) && record.windowId >= 0 &&
      record.cleanupMode === cleanupMode && states.has(record.state)
      ? record : undefined;
  };
  return Object.freeze(async rawRequest => {
    const ordinary = exact(rawRequest, ['auditId', 'ownershipId']);
    const attachedCopy = exact(rawRequest, [
      'auditId', 'ownershipId', 'navigationPurpose', 'cleanupMode',
    ]);
    const request = ordinary ?? (attachedCopy?.navigationPurpose === 'attached-copy' &&
      attachedCopy.cleanupMode === 'always' ? attachedCopy : null);
    const cleanupMode = ordinary ? 'pre-observation-failure' : 'always';
    if (!request || !AUDIT_ID.test(request.auditId ?? '') ||
      !/^owner_[A-Za-z0-9_-]{22}$/u.test(request.ownershipId ?? '')) return false;
    let failed = false;
    try { await input.rawNavigationVault.clearAudit(request.auditId); } catch { failed = true; }
    let current;
    try {
      current = parseOwned(
        await input.ownedTabRegistry.get(request.ownershipId),
        request.auditId,
        request.ownershipId,
        cleanupMode,
      );
    }
    catch { return false; }
    if (current === undefined) return false;
    if (current !== null && current.state !== 'removed') {
      let removed;
      try {
        removed = parseOwned(await input.ownedTabRegistry.removeOwned({
          ownershipId: request.ownershipId, auditId: request.auditId,
          tabId: current.tabId, fromState: current.state,
        }), request.auditId, request.ownershipId, cleanupMode);
      } catch { return false; }
      if (!removed || removed.state !== 'removed') return false;
    }
    let confirmed;
    try {
      confirmed = parseOwned(
        await input.ownedTabRegistry.get(request.ownershipId),
        request.auditId,
        request.ownershipId,
        cleanupMode,
      );
    }
    catch { return false; }
    return !failed && (confirmed === null || confirmed?.state === 'removed');
  });
}

async function invokeChrome(chromeApi, receiver, name, ...args) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (handler, value) => { if (!settled) { settled = true; handler(value); } };
    try {
      const returned = receiver[name](...args, value => {
        if (chromeApi.runtime?.lastError) finish(reject, new Error('CHROME_API_DENIED'));
        else finish(resolve, value);
      });
      if (returned && typeof returned.then === 'function') returned.then(value => finish(resolve, value), () => finish(reject, new Error('CHROME_API_DENIED')));
      else if (receiver[name].length <= args.length) finish(resolve, returned);
    } catch { finish(reject, new Error('CHROME_API_DENIED')); }
  });
}

async function sendRuntimeMessage(chromeApi, message) {
  if (typeof chromeApi.runtime?.sendMessage !== 'function') return;
  await invokeChrome(chromeApi, chromeApi.runtime, 'sendMessage', message);
}

async function readStored(sessionArea, key, parser) {
  const read = async () => {
    const envelope = await sessionArea.get(key);
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw new Error('STORAGE_DENIED');
    const value = own(envelope, key);
    if (value === undefined) return null;
    const parsed = parser(value);
    if (!parsed) throw new Error('STORAGE_DENIED');
    return parsed;
  };
  const first = await read();
  const second = await read();
  if (!same(first, second)) throw new Error('STORAGE_DENIED');
  return first;
}

function denseArray(value) {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
    const keys = Reflect.ownKeys(value);
    const expected = ['length', ...Array.from({ length: value.length }, (_unused, index) => String(index))];
    if (keys.length !== expected.length || expected.some(key => !keys.includes(key))) return null;
    const copy = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      copy.push(descriptor.value);
    }
    return copy;
  } catch { return null; }
}

function canonicalCheckpoint(auditId, value) {
  const root = exact(value, ['version', 'auditId', 'pages'], true);
  const pages = root ? denseArray(root.pages) : null;
  if (!root || root.version !== 1 || root.auditId !== auditId || !pages || pages.length === 0) return null;
  const pageOrder = [];
  for (const page of pages) {
    const pageId = own(page, 'pageId');
    if (typeof pageId !== 'string') return null;
    pageOrder.push(pageId);
  }
  try { return validateExecutionCheckpoint({ auditId, checkpoint: value, pageOrder }); }
  catch { return null; }
}

function checkpointRecord(value) {
  const record = exact(value, ['version', 'auditId', 'sessionCapabilityId', 'windowId', 'checkpoint'], true);
  if (!record || record.version !== 1 || !AUDIT_ID.test(record.auditId ?? '') ||
    !CAPABILITY.test(record.sessionCapabilityId ?? '') || !Number.isSafeInteger(record.windowId) || record.windowId < 0 ||
    !record.checkpoint || typeof record.checkpoint !== 'object') return null;
  const checkpoint = canonicalCheckpoint(record.auditId, record.checkpoint);
  return checkpoint ? freeze({ ...record, checkpoint }) : null;
}

function checkpointProgresses(existing, incoming) {
  const oldPages = existing.checkpoint.pages;
  const newPages = incoming.checkpoint.pages;
  if (newPages.length < oldPages.length) return false;
  for (let index = 0; index < oldPages.length; index += 1) {
    const prior = oldPages[index];
    const next = newPages[index];
    if (!next || prior.pageId !== next.pageId || prior.attempted !== next.attempted ||
      prior.startedAt !== next.startedAt || prior.rulesVersion !== next.rulesVersion ||
      prior.inventoryVersion !== next.inventoryVersion || prior.inventoryHash !== next.inventoryHash) return false;
    const nextOutcomes = new Map(next.outcomes.map(row => [row.ruleId, row.outcome]));
    if (prior.outcomes.some(row => nextOutcomes.get(row.ruleId) !== row.outcome)) return false;
  }
  return true;
}

export function createCheckpointAdapters(sessionArea) {
  async function persistCheckpoint(raw) {
    try {
      const args = exact(raw, ['auditId', 'sessionCapabilityId', 'windowId', 'checkpoint']);
      const record = checkpointRecord(args && { version: 1, ...args });
      if (!record) throw new Error('CHECKPOINT_PERSIST_DENIED');
      const key = executionCheckpointStorageKey(record.auditId);
      const existing = await readStored(sessionArea, key, checkpointRecord);
      if (existing !== null && (existing.auditId !== record.auditId ||
        existing.sessionCapabilityId !== record.sessionCapabilityId || existing.windowId !== record.windowId ||
        !checkpointProgresses(existing, record))) throw new Error('CHECKPOINT_PERSIST_DENIED');
      await sessionArea.set({ [key]: record });
      const confirmed = await readStored(sessionArea, key, checkpointRecord);
      if (!confirmed || !same(confirmed, record)) throw new Error('CHECKPOINT_PERSIST_DENIED');
      return confirmed;
    } catch {
      throw new Error('CHECKPOINT_PERSIST_DENIED');
    }
  }

  async function removeCheckpoint(raw) {
    const args = exact(raw, ['auditId', 'sessionCapabilityId', 'windowId']);
    if (!args || !AUDIT_ID.test(args.auditId ?? '') ||
      !((args.sessionCapabilityId === null && args.windowId === null) ||
        (CAPABILITY.test(args.sessionCapabilityId ?? '') && Number.isSafeInteger(args.windowId) && args.windowId >= 0))) {
      return Object.freeze({ removed: false });
    }
    try {
      const key = executionCheckpointStorageKey(args.auditId);
      const current = await readStored(sessionArea, key, checkpointRecord);
      if (current === null) return Object.freeze({ removed: false });
      const correlated = current.auditId === args.auditId &&
        (args.sessionCapabilityId === null ||
          (current.sessionCapabilityId === args.sessionCapabilityId && current.windowId === args.windowId));
      if (!correlated) throw new Error('CHECKPOINT_REMOVE_DENIED');
      await sessionArea.remove(key);
      if (await readStored(sessionArea, key, checkpointRecord) !== null) throw new Error('CHECKPOINT_REMOVE_DENIED');
      return Object.freeze({ removed: true });
    } catch {
      throw new Error('CHECKPOINT_REMOVE_DENIED');
    }
  }

  return Object.freeze({ persistCheckpoint, removeCheckpoint });
}

function copyReadyRuntime(value) {
  const runtime = exact(value, ['authority', 'auditStarter', 'chromeAdapter', 'reportLaunch', 'exportLaunch', 'personaCoordinator', 'highlightController'], true) ??
    exact(value, ['authority', 'auditStarter', 'chromeAdapter', 'reportLaunch', 'exportLaunch', 'personaCoordinator'], true) ??
    exact(value, ['authority', 'auditStarter', 'chromeAdapter', 'reportLaunch', 'exportLaunch'], true) ??
    exact(value, ['authority', 'auditStarter', 'chromeAdapter'], true);
  if (!runtime || !runtime.authority || !runtime.auditStarter || !runtime.chromeAdapter) throw new Error('WORKER_UNAVAILABLE');
  if (Object.hasOwn(runtime, 'personaCoordinator') && typeof runtime.personaCoordinator?.expireDue !== 'function') {
    throw new Error('WORKER_UNAVAILABLE');
  }
  if (Object.hasOwn(runtime, 'highlightController') &&
    (typeof runtime.highlightController?.expireDue !== 'function' ||
      typeof runtime.highlightController?.invalidateTab !== 'function')) {
    throw new Error('WORKER_UNAVAILABLE');
  }
  return freeze(runtime);
}

export function createPublishingHighlightController(raw) {
  const input = exact(raw, ['controller', 'publishHighlightState', 'scheduleExpiry']);
  const methodNames = [
    'availability', 'highlight', 'clear', 'clearForTargetLocked', 'clearAudit',
    'invalidateContent', 'invalidateTab', 'recover', 'expireDue',
  ];
  if (!input || typeof input.publishHighlightState !== 'function' || typeof input.scheduleExpiry !== 'function' ||
    methodNames.some(name => typeof input.controller?.[name] !== 'function')) {
    throw new TypeError('HIGHLIGHT_RUNTIME_CONTROLLER_INVALID');
  }

  function clearedAuditIds(result) {
    if (result?.ok !== true || !Array.isArray(result.clearedAuditIds) || result.clearedAuditIds.length > 5_000) return null;
    const ids = [...new Set(result.clearedAuditIds)];
    return ids.length === result.clearedAuditIds.length && ids.every(value => AUDIT_ID.test(value)) ? ids : null;
  }

  async function lifecycle(method, args) {
    let result;
    try { result = await input.controller[method](...args); }
    catch { return Object.freeze({ ok: false, code: 'HIGHLIGHT_STATE_FAILED' }); }
    if (result?.ok !== true) return result;
    const auditIds = clearedAuditIds(result);
    if (!auditIds) return Object.freeze({ ok: false, code: 'HIGHLIGHT_STATE_FAILED' });
    try {
      await input.scheduleExpiry();
      for (const auditId of auditIds) {
        await input.publishHighlightState({
          version: 1, type: 'HIGHLIGHT_STATE_CHANGED', auditId,
          occurrenceId: null, state: 'clear',
        });
      }
    } catch {
      return Object.freeze({ ok: false, code: 'HIGHLIGHT_STATE_FAILED' });
    }
    return result;
  }

  return Object.freeze({
    ...input.controller,
    invalidateTab: (...args) => lifecycle('invalidateTab', args),
    recover: (...args) => lifecycle('recover', args),
    expireDue: (...args) => lifecycle('expireDue', args),
  });
}

const PAGE_MARKER_PANEL_TYPES = new Set([
  'PANEL_SHOW_PAGE_MARKERS', 'PANEL_HIDE_PAGE_MARKERS',
  'PANEL_SELECT_PAGE_MARKER', 'PANEL_FILTER_PAGE_MARKERS',
]);

export function createPageMarkersPanelDispatcher(raw) {
  const input = exact(raw, ['pageMarkersController', 'dispatchFallback']);
  const dispatchMarkers = input && own(input.pageMarkersController, 'dispatch');
  if (!input || typeof dispatchMarkers !== 'function' || typeof input.dispatchFallback !== 'function') {
    throw new TypeError('PAGE_MARKERS_DISPATCHER_INVALID');
  }
  return async request => {
    const envelope = own(request, 'envelope');
    if (!PAGE_MARKER_PANEL_TYPES.has(own(envelope, 'type'))) return input.dispatchFallback(request);
    const admitted = exact(request, ['envelope', 'sender', 'launchTabId', 'panelWindowId', 'isCurrent']);
    if (!admitted || typeof admitted.isCurrent !== 'function') {
      return Object.freeze({ ok: false, code: 'PAGE_MARKERS_INVALID' });
    }
    return Reflect.apply(dispatchMarkers, input.pageMarkersController, [{
      envelope: admitted.envelope,
      sender: admitted.sender,
      panelWindowId: admitted.panelWindowId,
      isCurrent: admitted.isCurrent,
    }]);
  };
}

export function createPageMarkersCleanupComposition(raw) {
  const input = exact(raw, ['pageMarkersController', 'highlightController']);
  const highlightMethods = [
    'availability', 'highlight', 'clear', 'clearForTargetLocked', 'clearAudit',
    'invalidateContent', 'invalidateTab', 'recover', 'expireDue',
  ];
  const markerMethods = ['clearForTargetLocked', 'clearAudit', 'invalidateTab'];
  const highlight = {};
  const markers = {};
  if (!input) throw new TypeError('PAGE_MARKERS_CLEANUP_INVALID');
  for (const name of highlightMethods) {
    const method = own(input.highlightController, name);
    if (typeof method !== 'function') throw new TypeError('PAGE_MARKERS_CLEANUP_INVALID');
    highlight[name] = (...args) => Reflect.apply(method, input.highlightController, args);
  }
  for (const name of markerMethods) {
    const method = own(input.pageMarkersController, name);
    if (typeof method !== 'function') throw new TypeError('PAGE_MARKERS_CLEANUP_INVALID');
    markers[name] = (...args) => Reflect.apply(method, input.pageMarkersController, args);
  }
  const confirmed = (value, states) => {
    const result = exact(value, ['ok', 'state'], true);
    return Boolean(result?.ok === true && states.includes(result.state));
  };
  return Object.freeze({
    availability: highlight.availability,
    highlight: highlight.highlight,
    clear: highlight.clear,
    invalidateContent: highlight.invalidateContent,
    recover: highlight.recover,
    expireDue: highlight.expireDue,
    async clearForTargetLocked(target, reason, lock) {
      const markerTarget = Object.freeze({
        tabId: own(target, 'tabId'),
        documentId: own(target, 'documentId'),
      });
      let markerResult = null;
      let highlightResult = null;
      try { markerResult = await markers.clearForTargetLocked(markerTarget, reason, lock); } catch {}
      try { highlightResult = await highlight.clearForTargetLocked(target, reason, lock); } catch {}
      return confirmed(markerResult, ['absent', 'clear']) &&
        confirmed(highlightResult, ['absent', 'clear', 'revoked'])
        ? Object.freeze({ ok: true, state: 'clear' })
        : Object.freeze({ ok: false, code: 'HIGHLIGHT_CLEANUP_UNCONFIRMED' });
    },
    async clearAudit(auditId, reason) {
      let markerConfirmed = false;
      let highlightResult = null;
      try { markerConfirmed = await markers.clearAudit(auditId) === true; } catch {}
      try { highlightResult = await highlight.clearAudit(auditId, reason); } catch {}
      return markerConfirmed && confirmed(highlightResult, ['clear'])
        ? Object.freeze({ ok: true, state: 'clear' })
        : Object.freeze({ ok: false, state: 'pending' });
    },
    async invalidateTab(tabId, reason) {
      let highlightResult = null;
      try { await markers.invalidateTab(tabId); } catch {}
      try { highlightResult = await highlight.invalidateTab(tabId, reason); }
      catch { return Object.freeze({ ok: false, code: 'HIGHLIGHT_STATE_FAILED' }); }
      return highlightResult;
    },
  });
}

function createUnavailablePageMarkersController(originCache) {
  const clearAudit = typeof own(originCache, 'clearAudit') === 'function'
    ? own(originCache, 'clearAudit')
    : null;
  const clearTab = typeof own(originCache, 'clearTab') === 'function'
    ? own(originCache, 'clearTab')
    : null;
  return Object.freeze({
    async dispatch() { return Object.freeze({ ok: false, code: 'PAGE_MARKERS_UNAVAILABLE' }); },
    attachPort() { return false; },
    handleRuntimeMessage() { return false; },
    async clearAudit(auditId) {
      if (!clearAudit) return true;
      try { Reflect.apply(clearAudit, originCache, [auditId]); return true; } catch { return false; }
    },
    async invalidateTab(tabId) {
      if (!clearTab) return true;
      try { Reflect.apply(clearTab, originCache, [tabId]); return true; } catch { return false; }
    },
    async closePanel() { return true; },
    async clearForTargetLocked() { return Object.freeze({ ok: true, state: 'absent' }); },
  });
}

export function createReportOperations({
  chromeApi, auditStore, sessionArea, modelNow, highlightController, highlightBindingStore,
  publishHighlightState, requestAuditDeletion,
}) {

  async function clearHighlightAudit(auditId, reason) {
    const cleared = await highlightController.clearAudit(auditId, reason);
    if (cleared?.ok !== true || cleared.state !== 'clear') return false;
    await highlightBindingStore.deleteAudit(auditId);
    const snapshot = await highlightBindingStore.snapshot();
    const confirmed = !Object.values(snapshot.bindingsByAuditPage ?? {}).some(value => value?.auditId === auditId) &&
      !Object.values(snapshot.activeOverlayByTab ?? {}).some(value => value?.auditId === auditId);
    if (!confirmed) return false;
    try {
      const published = await publishHighlightState({
        version: 1, type: 'HIGHLIGHT_STATE_CHANGED', auditId,
        occurrenceId: null, state: 'clear',
      });
      return Number.isSafeInteger(published?.delivered) && published.delivered >= 0;
    } catch {
      return false;
    }
  }

  async function commitReviewDecision(input) {
    let decision;
    try { decision = createReviewDecision(input); }
    catch { return Object.freeze({ ok: false, code: 'REPORT_OPERATION_DENIED' }); }
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        const snapshot = await auditStore.getAuditSnapshot(decision.auditId);
        if (snapshot?.model?.auditId !== decision.auditId || !snapshot.capability) {
          return Object.freeze({ ok: false, code: 'REPORT_OPERATION_DENIED' });
        }
        if (!await clearHighlightAudit(decision.auditId, 'review-commit')) {
          return Object.freeze({ ok: false, code: 'REPORT_OPERATION_FAILED' });
        }
        const nextModel = createAuditModel(applyReviewDecisions(snapshot.model, [decision]));
        const committed = await auditStore.commitAuditReviewIfRevision(
          decision.auditId, nextModel, snapshot.capability,
        );
        const revision = await auditStore.getReportRevision(decision.auditId);
        const persistedDecision = revision?.model?.reviewDecisions?.find(value =>
          value?.occurrenceId === decision.occurrenceId);
        if (!Number.isSafeInteger(committed?.revision) || committed.revision < 1 ||
          revision?.auditId !== decision.auditId || revision.modelRevision !== committed.revision ||
          typeof revision.modelHash !== 'string' || !/^[a-f0-9]{64}$/u.test(revision.modelHash) ||
          !same(persistedDecision, decision)) {
          return Object.freeze({ ok: false, code: 'REPORT_OPERATION_FAILED' });
        }
        await sendRuntimeMessage(chromeApi, {
          type: 'AUDIT_REVIEW_UPDATED', auditId: decision.auditId, exportRevision: committed.revision,
        }).catch(() => {});
        return freeze({
          ok: true, auditId: decision.auditId, occurrenceId: decision.occurrenceId,
          modelRevision: committed.revision, modelHash: revision.modelHash,
        });
      } catch (error) {
        if (own(error, 'code') === 'AUDIT_REVISION_CONFLICT') continue;
        return Object.freeze({ ok: false, code: 'REPORT_OPERATION_FAILED' });
      }
    }
    return Object.freeze({ ok: false, code: 'REPORT_OPERATION_FAILED' });
  }

  async function deleteCandidate({ auditId, expectedRevision }, manualAuthorization) {
    try {
      const active = await readActiveAuditJobForWorker({ sessionArea });
      if (active?.auditId === auditId) return Object.freeze({ ok: false, code: 'AUDIT_DELETE_BUSY' });
      const result = await requestAuditDeletion({ auditId, reason: 'manual', expectedRevision,
        terminalReceipt: null, manualAuthorization });
      if (result?.status === 'denied') return Object.freeze({ ok: false, code: 'AUDIT_DELETION_DENIED' });
      if (result?.auditId !== auditId || !['complete', 'pending'].includes(result?.status)) {
        throw new Error('REPORT_OPERATION_FAILED');
      }
      if (result.status === 'complete') {
        await sendRuntimeMessage(chromeApi, createAuditDeletedEvent({ auditId, reason: 'delete-one' })).catch(() => {});
      }
      return freeze({ ok: true, auditId, deleted: true, status: result.status });
    } catch {
      // Staging may have committed before an unavailable cleaner/journal reported failure.
      try {
        const snapshot = await auditStore.getAuditSnapshot(auditId);
        if (snapshot?.model === undefined && snapshot?.revision === 0) {
          return freeze({ ok: true, auditId, deleted: true, status: 'pending' });
        }
        return Object.freeze({ ok: false, code: 'REPORT_OPERATION_FAILED', preserved: true });
      } catch { return Object.freeze({ ok: false, code: 'REPORT_OPERATION_FAILED', preserved: false }); }
    }
  }

  async function deleteAudit({ auditId, manualAuthorization }) {
    try {
      const snapshot = await auditStore.getAuditSnapshot(auditId);
      if (snapshot?.model?.auditId !== auditId || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 1) {
        return Object.freeze({ ok: false, code: 'REPORT_OPERATION_DENIED' });
      }
      return deleteCandidate({ auditId, expectedRevision: snapshot.revision }, manualAuthorization);
    } catch { return Object.freeze({ ok: false, code: 'REPORT_OPERATION_FAILED' }); }
  }

  async function deleteAllAudits({ manualAuthorization }) {
    try {
      if (await readActiveAuditJobForWorker({ sessionArea }) !== null) return Object.freeze({ ok: false, code: 'AUDIT_DELETE_BUSY' });
      const candidates = await auditStore.listAuditDeletionCandidatesV1();
      let deleted = 0; let pending = 0; let preserved = 0; let unconfirmed = 0;
      for (const candidate of candidates) {
        const result = await deleteCandidate(candidate, manualAuthorization);
        if (result.ok) { deleted++; if (result.status === 'pending') pending++; }
        else if (result.preserved === false) unconfirmed++;
        else preserved++;
      }
      if (preserved || unconfirmed) return freeze({ ok: false, code: 'AUDIT_DELETE_PARTIAL', deleted, pending, preserved,
        ...(unconfirmed ? { unconfirmed } : {}) });
      return freeze({ ok: true, deleted, pending, status: pending ? 'pending' : 'complete' });
    } catch { return Object.freeze({ ok: false, code: 'REPORT_OPERATION_FAILED' }); }
  }

  return freeze({
    commitReviewDecision, deleteAudit, deleteAllAudits,
  });
}

async function buildDefaultRuntime(chromeApi, options) {
  const pixelCommitClockFactory = options.pixelCommitClockFactory ?? createNativePixelCommitClockV1;
  if (typeof pixelCommitClockFactory !== 'function') throw new Error('WORKER_UNAVAILABLE');
  let pixelCommitClock;
  try { pixelCommitClock = pixelCommitClockFactory(); }
  catch { throw new Error('WORKER_UNAVAILABLE'); }
  if (!isPixelCommitClockV1(pixelCommitClock)) throw new Error('WORKER_UNAVAILABLE');
  const chromeAuditAuthority = typeof options.chromeAdapterFactory === 'function'
    ? null
    : createChromeAuditAuthority(chromeApi);
  const sessionArea = chromeApi.storage.session;
  const epochNow = options.epochNow ?? Date.now;
  let pageMarkerOriginCache = null;
  try {
    pageMarkerOriginCache = (options.pageMarkerOriginCacheFactory ?? createPageMarkerOriginCache)({ now: epochNow });
  } catch { /* Optional presentation provenance must not prevent an audit. */ }
  let pageMarkersCleanupController = createUnavailablePageMarkersController(pageMarkerOriginCache);
  const modelNow = options.modelNow ?? (() => new Date().toISOString());
  const bytes = options.randomBytes ?? randomBytes;
  const pixelState = (options.pixelCaptureStateFactory ?? createPixelCaptureStateV1)({
    sessionArea, now: epochNow, randomBytes: bytes,
  });
  const digestManager = createSessionUrlDigestManager({
    sessionArea, subtle: options.subtle ?? globalThis.crypto?.subtle, randomBytes: bytes, now: epochNow,
  });
  const rawNavigationVault = (options.rawNavigationVaultFactory ?? createRawNavigationVaultV1)({
    sessionArea, digestManager, now: epochNow, randomBytes: bytes,
  });
  if (typeof rawNavigationVault?.put !== 'function' || typeof rawNavigationVault?.take !== 'function' ||
    typeof rawNavigationVault?.readQueue !== 'function' || typeof rawNavigationVault?.replaceQueue !== 'function' ||
    typeof rawNavigationVault?.clearAudit !== 'function') throw new Error('WORKER_UNAVAILABLE');
  const baseAdapter = typeof options.chromeAdapterFactory === 'function'
    ? options.chromeAdapterFactory(chromeApi, { sessionUrlDigestManager: digestManager })
    : createChromeAdapter(chromeAuditAuthority, { sessionUrlDigestManager: digestManager });
  const chromeAdapter = options.chromeAdapterOverrides
    ? composeChromeAdapter(baseAdapter, options.chromeAdapterOverrides)
    : Object.freeze(baseAdapter);
  const probeSensitiveCaptureSignals = captureSensitiveCaptureProbeAuthority(chromeAdapter);
  const authority = createTargetCapabilityAuthority({
    chromeApi, sessionArea, now: epochNow, randomBytes: bytes,
    probeDocument: tabId => chromeAdapter.probeDocumentIdentity(tabId),
  });
  const prepareAttachedCopyPlan = async raw => {
    const input = exact(raw, [
      'capabilityId', 'auditId', 'senderContext', 'expectedTarget',
    ]);
    const expectedTarget = input && exact(input.expectedTarget, [
      'tabId', 'windowId', 'documentId', 'urlSessionDigest',
    ]);
    if (!input || !CAPABILITY.test(input.capabilityId ?? '') || !AUDIT_ID.test(input.auditId ?? '') ||
      !expectedTarget || !Number.isSafeInteger(expectedTarget.tabId) || expectedTarget.tabId < 0 ||
      !Number.isSafeInteger(expectedTarget.windowId) || expectedTarget.windowId < 0 ||
      typeof expectedTarget.documentId !== 'string' || expectedTarget.documentId.length < 1 ||
      !/^hmac-sha256:[A-Za-z0-9_-]{43}$/u.test(expectedTarget.urlSessionDigest ?? '')) {
      throw new Error('ATTACHED_COPY_PREPARATION_DENIED');
    }
    let ownershipId;
    let createdAt;
    try {
      ownershipId = createOwnershipId(bytes);
      createdAt = epochNow();
      await reserveAttachedCopyStartJournalV1({
        sessionArea,
        capabilityId: input.capabilityId,
        auditId: input.auditId,
        windowId: expectedTarget.windowId,
        ownershipId,
        createdAt,
      });
    } catch { throw new Error('AUDIT_RECOVERY_REQUIRED'); }
    try {
      if (await pageMarkersCleanupController.invalidateTab(expectedTarget.tabId) !== true) {
        throw new Error('ATTACHED_COPY_PREPARATION_DENIED');
      }
      const internalDescriptor = Object.getOwnPropertyDescriptor(chromeAdapter, AUDIT_EXECUTION_INTERNAL);
      const internal = internalDescriptor && Object.hasOwn(internalDescriptor, 'value')
        ? internalDescriptor.value
        : null;
      const snapshotAttachedCopySource = internal && own(internal, 'snapshotAttachedCopySource');
      if (typeof snapshotAttachedCopySource !== 'function') throw new Error('ATTACHED_COPY_PREPARATION_DENIED');
      const source = exact(await snapshotAttachedCopySource(Object.freeze({ ...expectedTarget })), [
        'version', 'tabId', 'windowId', 'documentId', 'urlSessionDigest', 'rawUrl',
      ]);
      if (!source || source.version !== 'AttachedCopySourceV1' || source.tabId !== expectedTarget.tabId ||
        source.windowId !== expectedTarget.windowId || source.documentId !== expectedTarget.documentId ||
        source.urlSessionDigest !== expectedTarget.urlSessionDigest || typeof source.rawUrl !== 'string') {
        throw new Error('ATTACHED_COPY_PREPARATION_DENIED');
      }
      const exchange = exact(await authority.exchangeAttachedForNavigationCopy({
        capabilityId: input.capabilityId,
        intent: 'attached-copy',
        senderContext: input.senderContext,
      }), ['ok', 'capabilityId', 'expiresAt']);
      if (!exchange || exchange.ok !== true || exchange.capabilityId !== input.capabilityId ||
        !Number.isSafeInteger(exchange.expiresAt)) throw new Error('ATTACHED_COPY_PREPARATION_DENIED');
      const issued = exact(await rawNavigationVault.put(source.rawUrl, {
        auditId: input.auditId,
        purpose: 'attached-copy',
        ttlMs: 60_000,
        includeQuery: false,
      }), ['navigationToken', 'evidenceUrl', 'sessionDigest', 'expiresAt']);
      const evidenceUrl = issued && exact(issued.evidenceUrl, [
        'version', 'href', 'queryIncluded', 'redactedSegments',
      ]);
      const expectedEvidence = sanitizeEvidenceUrlV1(source.rawUrl, { includeQuery: false });
      if (!issued || !/^[A-Za-z0-9_-]{22}$/u.test(issued.navigationToken ?? '') ||
        !evidenceUrl || !isEvidenceUrlV1(evidenceUrl) || evidenceUrl.queryIncluded !== false ||
        JSON.stringify(evidenceUrl) !== JSON.stringify(expectedEvidence) ||
        issued.sessionDigest !== source.urlSessionDigest ||
        !Number.isSafeInteger(issued.expiresAt)) {
        throw new Error('ATTACHED_COPY_PREPARATION_DENIED');
      }
      try {
        const registeredAt = epochNow();
        pageMarkerOriginCache?.register({
          auditId: input.auditId, tabId: source.tabId, windowId: source.windowId,
          documentId: source.documentId, urlSessionDigest: source.urlSessionDigest,
          createdAt: registeredAt, expiresAt: registeredAt + PAGE_MARKER_ORIGIN_TTL_MS,
        });
      } catch { /* Losing optional provenance does not invalidate the prepared copy. */ }
      return freeze({
        kind: 'attached-copy',
        ownershipId,
        navigationToken: issued.navigationToken,
        navigationPurpose: 'attached-copy',
        evidenceUrl: { ...evidenceUrl },
        sessionDigest: issued.sessionDigest,
      });
    } catch {
      let invalidated = false;
      let cleared = false;
      try {
        invalidated = (await authority.invalidateCapability(
          input.capabilityId,
          'AUDIT_START_COMPENSATED',
        ))?.ok === true;
      } catch { invalidated = false; }
      try { await rawNavigationVault.clearAudit(input.auditId); cleared = true; }
      catch { cleared = false; }
      void invalidated;
      void cleared;
      // O journal durável permanece como autoridade de retry mesmo quando a
      // compensação imediata parece confirmada.
      throw new Error('AUDIT_RECOVERY_REQUIRED');
    }
  };
  const panelLaunchAuthority = options.panelLaunchAuthority ?? createPanelLaunchAuthority({
    chromeApi, sessionArea, now: epochNow, randomBytes: bytes,
  });
  if (await panelLaunchAuthority.initialize() !== true) throw new Error('WORKER_UNAVAILABLE');
  const targetQueue = createTargetOperationQueue();
  const personaLeaseStore = createPersonaLeaseStore({
    sessionArea,
    lockManager: options.personaLockManager ?? globalThis.navigator?.locks,
    now: epochNow,
    randomBytes: bytes,
  });
  const personaRuntime = createPersonaInjectionRuntime({ chromeApi });
  const schedulePersonaExpiry = async when => {
    if (when === null) {
      await chromeApi.alarms.clear(PERSONA_EXPIRY_ALARM_NAME);
      return;
    }
    if (!Number.isSafeInteger(when) || when < 0) throw new Error('PERSONA_EXPIRY_SCHEDULE_FAILED');
    await chromeApi.alarms.create(PERSONA_EXPIRY_ALARM_NAME, { when });
  };
  const personaCoordinator = createPersonaCoordinator({
    leaseStore: personaLeaseStore,
    targetQueue,
    personaRuntime,
    probeDocument: tabId => chromeAdapter.probeDocumentIdentity(tabId),
    scheduleExpiry: schedulePersonaExpiry,
  });
  const personaStart = createPersonaStartOrchestrator({
    authority,
    targetQueue,
    personaCoordinator,
  });
  const auditStore = options.auditStore ?? createAuditStore(options.auditStoreOptions);
  const attemptAuthority = createSessionPixelAttemptDigestAuthority({
    sessionArea, subtle: options.subtle ?? globalThis.crypto?.subtle, randomBytes: bytes, now: epochNow,
  });
  const attemptCorrelation = createPixelAttemptCorrelationV1({
    sessionArea, attemptAuthority, now: epochNow,
    storeBinding: createPixelAttemptStoreBindingV1(auditStore, sessionArea),
  });
  const pixelAttemptLifecycle = createPixelAttemptLifecycleV1({
    sessionArea, auditStore, attemptAuthority, attemptCorrelation, modelNow,
  });
  let retentionScheduler = null;
  const liquidatorBridge = createLateBoundPixelLiquidatorFacadeV1();
  const pixelScheduler = (options.pixelConsentSchedulerFactory ?? createPixelConsentExpirySchedulerV1)(chromeApi, {
    pixelState, liquidator: liquidatorBridge.facade, now: epochNow,
  });
  const launchApisAvailable = typeof chromeApi.tabs?.create === 'function' && typeof chromeApi.tabs?.update === 'function' &&
    typeof chromeApi.tabs?.get === 'function' && typeof chromeApi.tabs?.remove === 'function';
  const unavailableLaunch = freeze({
    async clearAudit() { throw new Error('AUDIT_DELETION_UNAVAILABLE'); },
    async getLaunch() { return null; }, async getSession() { return null; },
    async openRegisteredReport() { return { ok: false, code: 'REPORT_OPEN_DENIED' }; },
    async connect() { return { ok: false, code: 'CONTEXT_DENIED' }; },
    async authorizeIntent() { return { ok: false, code: 'REPORT_INTENT_DENIED' }; },
    async authorizeExport() { return { ok: false, code: 'REPORT_EXPORT_DENIED' }; },
    async returnToSource() { return { ok: false, code: 'REPORT_RETURN_DENIED' }; },
    async validateConsumer() { return false; },
    async requestExport() { return { ok: false, code: 'REPORT_EXPORT_DENIED' }; },
    async complete() { return { ok: false, code: 'EXPORT_COMPLETE_DENIED' }; },
    async handleTabUpdated() { return false; }, async handleTabRemoved() { return false; }, async handleWindowRemoved() { return false; },
  });
  const sourceSessionAuthority = Object.freeze({
    async reauthorizeReportSource({ sessionCapabilityId, auditId, state } = {}) {
      try {
        const session = await readAuditSessionForWorker({ sessionArea, sessionCapabilityId, auditId });
        const current = epochNow();
        if (!Number.isSafeInteger(current) || current < 0 || session.issuedAt > current || current >= session.expiresAt ||
          session.state !== state || !['result', 'view-only'].includes(state)) {
          return Object.freeze({ ok: false, code: 'REPORT_SOURCE_DENIED' });
        }
        if (state === 'result') {
          const attached = exact(session.targetBinding, ['kind', 'tabId', 'documentId', 'urlSessionDigest'], true);
          if (attached?.kind === 'attached') {
            const proof = exact(await chromeAdapter.probeDocumentIdentity(attached.tabId),
              ['tabId', 'windowId', 'documentId', 'urlSessionDigest'], true);
            if (!proof || proof.tabId !== attached.tabId || proof.windowId !== session.windowId ||
              proof.documentId !== attached.documentId || proof.urlSessionDigest !== attached.urlSessionDigest) {
              return Object.freeze({ ok: false, code: 'REPORT_SOURCE_DENIED' });
            }
            return Object.freeze({ ok: true, state, binding: session.targetBinding, windowId: session.windowId, live: true });
          }
          const batch = exact(session.targetBinding, ['kind', 'activePageId', 'activeOwnershipId'], true);
          if (session.mode === 'batch' && batch?.kind === 'batch' &&
            batch.activePageId === null && batch.activeOwnershipId === null) {
            // O lote concluído não conserva uma aba de origem viva. Ele pode ser
            // aberto para consulta, revisão e exportação, sem conceder destaque
            // ou retorno a uma página que já foi descartada.
            return Object.freeze({ ok: true, state, binding: session.targetBinding, windowId: session.windowId, live: false });
          }
          const disposable = exact(session.targetBinding, ['kind', 'ownershipId', 'state'], true);
          if (disposable?.kind !== 'disposable' ||
            !['removed', 'retained-for-review'].includes(disposable.state) ||
            !/^owner_[A-Za-z0-9_-]{22}$/u.test(disposable.ownershipId ?? '')) {
            return Object.freeze({ ok: false, code: 'REPORT_SOURCE_DENIED' });
          }
          // A aba descartável não é projetada como fonte viva ao relatório.
          // O relatório mantém exportação/revisão, mas não recebe poderes de
          // destaque ou retorno sem uma prova de documento separada.
          return Object.freeze({ ok: true, state, binding: session.targetBinding, windowId: session.windowId, live: false });
        }
        return Object.freeze({ ok: true, state, binding: session.targetBinding, windowId: session.windowId, live: false });
      } catch {
        return Object.freeze({ ok: false, code: 'REPORT_SOURCE_DENIED' });
      }
    },
  });
  const reportLaunch = launchApisAvailable ? createReportLaunchAuthority({
    chromeApi, sessionArea, epochNow, randomBytes: bytes, sourceSessionAuthority,
    sourcePanelAuthority: panelLaunchAuthority,
  }) : unavailableLaunch;
  const highlightBindingStore = createHighlightBindingStore({ sessionArea, now: epochNow });
  const highlightModelAuthority = createHighlightModelAuthority({ auditStore });
  const highlightLiveVerifier = createHighlightLiveVerifier({
    chromeApi, digestManager, chromeAdapter, now: epochNow,
  });
  const highlightSessionBridge = createHighlightSessionAuthorityBridge({ authority, reportLaunch });
  const highlightController = createHighlightController({
    chromeApi,
    chromeAdapter,
    sessionAuthority: highlightSessionBridge.sessionAuthority,
    modelAuthority: highlightModelAuthority,
    bindingStore: highlightBindingStore,
    liveVerifier: highlightLiveVerifier,
    targetQueue,
    now: epochNow,
    randomBytes: bytes,
  });
  async function scheduleHighlightExpiry() {
    const snapshot = await highlightBindingStore.snapshot();
    const deadlines = [
      ...Object.values(snapshot.bindingsByAuditPage),
      ...Object.values(snapshot.activeOverlayByTab),
    ].map(value => value.expiresAt).filter(value => Number.isSafeInteger(value) && value >= 0);
    if (deadlines.length === 0) {
      await chromeApi.alarms.clear(HIGHLIGHT_EXPIRY_ALARM_NAME);
      return;
    }
    await chromeApi.alarms.create(HIGHLIGHT_EXPIRY_ALARM_NAME, { when: Math.min(...deadlines) });
  }
  const highlightBindingRecorder = createHighlightBindingRecorder({
    bindingStore: highlightBindingStore,
    chromeAdapter,
    digestManager,
    now: epochNow,
    recordBinding: recordHighlightBindingV1,
    scheduleExpiry: scheduleHighlightExpiry,
  });
  const inventory = await createInstalledCoreRuleInventory();
  const buildPanelResultBundle = ({ reportRevision }) => createPanelResultBundleV1({ reportRevision, inventory });
  const checkpoints = createCheckpointAdapters(sessionArea);
  const revokeViewOnly = async ({ sessionCapabilityId, auditId }) => {
    try {
      const before = await readAuditSessionForWorker({ sessionArea, sessionCapabilityId, auditId });
      if (before.state !== 'view-only' || before.targetBinding?.kind !== 'view-only') return false;
      const result = await authority.transitionAuditSession({ sessionCapabilityId, auditId, nextState: 'revoked' });
      if (result?.ok !== true) return false;
      const after = await readAuditSessionForWorker({ sessionArea, sessionCapabilityId, auditId });
      return after.state === 'revoked' && after.targetBinding?.kind === 'view-only';
    } catch { return false; }
  };
  const loadPanelResultBundle = async ({ auditId }) => {
    const reportRevision = await auditStore.getReportRevision(auditId);
    return reportRevision ? buildPanelResultBundle({ reportRevision }) : null;
  };
  let panelIntentDispatcher = null;
  let panelCoordinator = null;
  const pageMarkersWorkerLifecycle = createPageMarkersWorkerLifecycle({
    publish: event => panelCoordinator
      ? panelCoordinator.publishPageMarkersState(event)
      : Object.freeze({ delivered: 0 }),
  });
  panelCoordinator = createPanelPortCoordinator({
    chromeApi, sessionArea,
    readActiveJob: () => readActiveAuditJobForWorker({ sessionArea }),
    readAuditSession: ({ sessionCapabilityId, auditId }) => readAuditSessionForWorker({ sessionArea, sessionCapabilityId, auditId }),
    readPixelSuspension: auditId => pixelState.readSuspension(auditId),
    loadPanelResultBundle,
    rehydrateViewOnly: value => authority.rehydrateViewOnly(value),
    revokeViewOnly,
    epochNow,
    setTimer: (callback, delay) => setTimeout(callback, delay),
    clearTimer: timer => clearTimeout(timer),
    launchAuthority: panelLaunchAuthority,
    authorizeHighlightSession: value => authority.authorizeSession({
      ...value, consumer: 'panel', intent: 'highlight',
    }),
    authorizePageMarkersSession: async value => {
      if (!pageMarkersWorkerLifecycle.isActive()) return Object.freeze({ ok: false });
      const result = await authority.authorizeSession({
        ...value, consumer: 'panel', intent: 'review-markers',
      });
      return pageMarkersWorkerLifecycle.isActive() ? result : Object.freeze({ ok: false });
    },
    closePanelMarkers: value => pageMarkersCleanupController.closePanel(value),
    dispatchPanelIntent: request => panelIntentDispatcher
      ? panelIntentDispatcher(request)
      : Object.freeze({ ok: false, code: 'CONTEXT_DENIED' }),
  });
  let pageMarkersWorkerBridge = null;
  try {
    const controllerFactory = options.pageMarkersControllerFactory ?? createPageMarkersController;
    if (typeof controllerFactory !== 'function') throw new Error('PAGE_MARKERS_UNAVAILABLE');
    const controller = controllerFactory({
      originCache: pageMarkerOriginCache,
      modelAuthority: highlightModelAuthority,
      loadPanelResultBundle,
      authority,
      chromeApi,
      chromeAdapter,
      targetQueue,
      now: epochNow,
      createInstallationId: () => base64Url(bytes(16)),
      publish: event => pageMarkersWorkerLifecycle.publish(event),
      setTimer: (callback, delay) => setTimeout(callback, delay),
      clearTimer: timer => clearTimeout(timer),
    });
    if (typeof own(controller, 'closePanel') !== 'function') throw new Error('PAGE_MARKERS_UNAVAILABLE');
    pageMarkersWorkerBridge = createPageMarkersWorkerBridge({
      controller,
      lifecycle: pageMarkersWorkerLifecycle,
    });
    pageMarkersCleanupController = controller;
  } catch {
    pageMarkersWorkerLifecycle.dispose();
    pageMarkersWorkerBridge = null;
  }
  const composedHighlightController = createPageMarkersCleanupComposition({
    pageMarkersController: pageMarkersCleanupController,
    highlightController,
  });
  const cleanupBarrier = createLiveAidCleanup({
    highlightCleaner: composedHighlightController,
    personaCoordinator,
    targetQueue,
  });
  const persistLatest = async ({ state }) => { await auditStore.setLatest(state); return freeze(structuredClone(state)); };
  const commitTerminalAudit = async ({ auditId, model, checkpoint, latestState, expectedRevision }) => {
    if (expectedRevision !== 1) throw new Error('TERMINAL_COMMIT_DENIED');
    const result = await auditStore.commitAuditWithCheckpointIfAbsent(
      auditId, model, checkpoint, latestState,
      { now: canonicalModelTime(modelNow), deleteAfterCompleteExport: false },
    );
    if (result?.revision !== 1 || typeof result.modelHash !== 'string') throw new Error('TERMINAL_COMMIT_DENIED');
    return Object.freeze({ revision: 1, modelHash: result.modelHash });
  };
  const panelAuditCoordinator = Object.freeze({
    attachPanelPort: panelCoordinator.attachPanelPort,
    withWindowLock: panelCoordinator.withWindowLock,
  });
  const ownedTabRegistry = createOwnedTabRegistry({
    sessionArea,
    // `getTab` entra junto com `removeTab`: a limpeza reatesta a aba viva antes de fechá-la (achado D1
    // da revisão da 1.1.37) e o registro recusa ser construído sem essa leitura.
    chromeAdapter: Object.freeze({
      removeTab: tabId => chromeAdapter.removeTab(tabId),
      getTab: tabId => chromeAdapter.getTab(tabId),
    }),
    now: modelNow,
  });
  const urlAuditResourceCleaner = createExactUrlAuditResourceCleanerV1({
    rawNavigationVault,
    ownedTabRegistry,
  });
  const runUrlAuditExecution = options.runUrlAuditExecution ?? (args => {
    const checkpointStore = Object.freeze({
      writeSanitized: (auditId, checkpoint) => {
        if (auditId !== args.auditId) throw new Error('CHECKPOINT_PERSIST_DENIED');
        return args.onCheckpoint(checkpoint);
      },
      persistAuditModel: (model, observedTarget) => args.persistAuditModel(model, observedTarget),
    });
    const requestedVault = own(args, 'rawNavigationVault');
    const navigationVault = requestedVault === undefined ? rawNavigationVault : requestedVault;
    if (typeof navigationVault?.take !== 'function') throw new Error('WORKER_UNAVAILABLE');
    const requestedProgress = own(args, 'onProgress');
    if (requestedProgress !== undefined && typeof requestedProgress !== 'function') {
      throw new Error('WORKER_UNAVAILABLE');
    }
    const common = {
      auditId: args.auditId, chromeAdapter, capturePolicy: args.capturePolicy,
      checkpointStore,
      onProgress: requestedProgress ?? (event => chromeAdapter.emitProgress(event)),
      now: args.modelNow, signal: args.signal, expectedExtensionId: chromeApi.runtime.id,
      auditRunner: runObservedTabAudit,
    };
    return Object.hasOwn(args, 'resumeTarget')
      ? runUrlAudit({
          ...common,
          requestedUrlEvidence: args.requestedUrlEvidence,
          resumeTarget: args.resumeTarget,
          resumeCheckpoint: args.resumeCheckpoint,
          privacyGate: args.privacyGate,
        })
      : runUrlAudit({
          ...common,
          ownershipId: args.ownershipId,
          windowId: args.windowId,
          navigationToken: args.navigationToken,
          navigationPurpose: args.navigationPurpose,
          evidenceUrl: args.evidenceUrl,
          sessionDigest: args.sessionDigest,
          rawNavigationVault: navigationVault,
          ...(args.privacyGate ? { privacyGate: args.privacyGate } : {}),
        });
  });
  const manifestVersion = own(chromeApi.runtime.getManifest?.(), 'version');
  const batchReportOptions = Object.freeze({
    timezone: 'America/Cuiaba',
    manifestVersion: typeof manifestVersion === 'string' && manifestVersion.length > 0 ? manifestVersion : '0.0.0',
    rulesVersion: inventory.rulesVersion,
    browserVersion: typeof globalThis.navigator?.userAgent === 'string' && globalThis.navigator.userAgent.length > 0
      ? globalThis.navigator.userAgent.slice(0, 256)
      : 'Chrome (versão não disponível)',
    expectedExtensionId: chromeApi.runtime.id,
  });
  let openedBatchProgressStore = null;
  const batchProgressStore = options.batchProgressStore ?? Object.freeze({
    writeDraft: args => (openedBatchProgressStore ??= createBatchProgressStoreV1({
      indexedDB: options.batchProgressIndexedDB ?? globalThis.indexedDB,
    })).writeDraft(args),
    markCompleted: args => (openedBatchProgressStore ??= createBatchProgressStoreV1({
      indexedDB: options.batchProgressIndexedDB ?? globalThis.indexedDB,
    })).markCompleted(args),
    readCompleted: args => (openedBatchProgressStore ??= createBatchProgressStoreV1({
      indexedDB: options.batchProgressIndexedDB ?? globalThis.indexedDB,
    })).readCompleted(args),
    clearAudit: args => (openedBatchProgressStore ??= createBatchProgressStoreV1({
      indexedDB: options.batchProgressIndexedDB ?? globalThis.indexedDB,
    })).clearAudit(args),
    discardAudit: args => (openedBatchProgressStore ??= createBatchProgressStoreV1({
      indexedDB: options.batchProgressIndexedDB ?? globalThis.indexedDB,
    })).discardAudit(args),
  });
  const batchExecution = (options.batchAuditExecutionFactory ?? createBatchAuditExecutionV1)({
    rawNavigationVault,
    authority,
    ownedTabRegistry,
    batchProgressStore,
    createOwnershipId: () => createOwnershipId(bytes),
    runBatch,
    runUrlAuditExecution,
    readBatchCorrelation: ({ capabilityId, auditId }) => readBatchAuditCorrelationForRecovery({
      sessionArea, capabilityId, auditId,
    }),
    emitProgress: event => chromeAdapter.emitProgress(event),
    tryEnterFinalization: () => true,
    createPixelPrivacyGate: args => createBatchPagePixelPrivacyGateV1({
      pixelState,
      pixelCommitClock,
      ...args,
    }),
  });
  const auditStarter = createAuthorizedAuditStarter({
    authority, sessionArea, panelCoordinator: panelAuditCoordinator, targetQueue, cleanupBarrier,
    runAttachedAuditExecution: args => runAttachedAuditExecution({
      ...args, chromeAdapter, expectedExtensionId: chromeApi.runtime.id,
    }),
    runUrlAuditExecution,
    clearUrlAuditResources: urlAuditResourceCleaner,
    runBatchAuditExecution: args => batchExecution.run({
      auditId: args.auditId,
      capabilityId: args.capabilityId,
      sessionCapabilityId: args.sessionCapabilityId,
      windowId: args.windowId,
      acceptedCount: args.acceptedCount,
      capturePolicy: args.capturePolicy,
      now: args.modelNow,
      signal: args.signal,
      reportOptions: batchReportOptions,
      onExecutionCheckpoint: args.onCheckpoint,
      onPrivacyPaused: args.onPrivacyPaused,
      onPixelPageFinished: args.onPixelPageFinished,
    }),
    resumeBatchAuditExecution: args => batchExecution.resume(args),
    recoverBatchAuditExecution: args => batchExecution.recover({
      auditId: args.auditId,
      capabilityId: args.capabilityId,
      sessionCapabilityId: args.sessionCapabilityId,
      windowId: args.windowId,
      capturePolicy: args.capturePolicy,
      now: args.modelNow,
      signal: args.signal,
      reportOptions: batchReportOptions,
      onExecutionCheckpoint: args.onCheckpoint,
      onPrivacyPaused: args.onPrivacyPaused,
      onPixelPageFinished: args.onPixelPageFinished,
      consentId: args.consentId,
      resumeTarget: args.resumeTarget,
      resumeCheckpoint: args.resumeCheckpoint,
    }),
    clearBatchAuditResources: args => batchExecution.cleanup(args),
    clearBatchAuditProgress: args => batchExecution.clearProgress(args),
    discardBatchAuditProgress: args => batchExecution.discardProgress(args),
    persistLatest, persistCheckpoint: checkpoints.persistCheckpoint, removeCheckpoint: checkpoints.removeCheckpoint,
    commitTerminalAudit,
    readAuditSnapshot: ({ auditId }) => auditStore.getAuditSnapshot(auditId),
    readReportRevision: ({ auditId }) => auditStore.getReportRevision(auditId),
    readLatest: () => auditStore.getLatest(), buildPanelResultBundle,
    recordHighlightBinding: value => highlightBindingRecorder.record(value),
    pixelCommitClock,
    epochNow, modelNow, createAbortController: () => new AbortController(),
    prepareAttachedCopyPlan,
    recordPageMarkerOrigin: value => {
      if (!pageMarkerOriginCache) return false;
      const createdAt = epochNow();
      try {
        return pageMarkerOriginCache.register({
          auditId: value.auditId, tabId: value.tabId, windowId: value.windowId,
          documentId: value.documentId, urlSessionDigest: value.urlSessionDigest,
          createdAt, expiresAt: createdAt + PAGE_MARKER_ORIGIN_TTL_MS,
        }) === true;
      } catch { return false; }
    },
    pixelState,
    probeDocumentIdentity: tabId => chromeAdapter.probeDocumentIdentity(tabId),
    probeSensitiveCaptureSignals,
    pixelAttemptLifecycle: Object.freeze({
      ...pixelAttemptLifecycle,
      async commitTerminal(request) {
        const result = await pixelAttemptLifecycle.commitTerminal(request);
        if (retentionScheduler) void retentionScheduler.scheduleNext().catch(() => {});
        return result;
      },
    }),
    schedulePixelExpiry: () => pixelScheduler.scheduleNext(),
  });
  if (liquidatorBridge.bind(value => auditStarter.liquidatePixelAudit(value)) !== true) {
    throw new Error('WORKER_UNAVAILABLE');
  }
  const reportPortCoordinator = createReportPortCoordinator({
    reportLaunch,
    async readHighlightState({ sessionCapabilityId, auditId, sender }) {
      let token;
      try { token = highlightSessionBridge.createReviewSender({ sender }); }
      catch { return Object.freeze({ ok: false, code: 'HIGHLIGHT_NOT_AUTHORIZED' }); }
      return highlightController.currentState({ sessionCapabilityId, auditId, sender: token });
    },
    setTimer: (callback, delay) => setTimeout(callback, delay),
    clearTimer: timer => clearTimeout(timer),
  });
  const publishHighlightState = async event => {
    const [panelResult, reportResult] = await Promise.all([
      panelCoordinator.publishHighlightState(event),
      reportPortCoordinator.publishHighlightState(event),
    ]);
    const panelDelivered = Number.isSafeInteger(panelResult?.delivered) && panelResult.delivered >= 0
      ? panelResult.delivered : 0;
    const reportDelivered = Number.isSafeInteger(reportResult?.delivered) && reportResult.delivered >= 0
      ? reportResult.delivered : 0;
    return Object.freeze({ delivered: panelDelivered + reportDelivered });
  };
  const highlightRuntimeController = createPublishingHighlightController({
    controller: composedHighlightController,
    publishHighlightState,
    scheduleExpiry: scheduleHighlightExpiry,
  });
  const exportCompletionStore = createExportCompletionStore({
    auditStore,
    emitTerminal: event => chromeAdapter.emitProgress(event),
    async deleteCompletedAudit({ auditId, expectedRevision, terminalReceipt }) {
      const result = await deletionCoordinator.request({ auditId, reason: 'post-export', expectedRevision,
        terminalReceipt, manualAuthorization: null });
      return result?.auditId === auditId && result.status === 'pending'
        ? Object.freeze({ ok: true, auditId, deleted: true })
        : Object.freeze({ ok: false, code: 'AUDIT_DELETE_BUSY' });
    },
  });
  const baseExportLaunch = launchApisAvailable ? createExportLaunchAuthority({
    chromeApi, sessionArea, auditStore: exportCompletionStore, reportLaunch, epochNow, modelNow, randomBytes: bytes,
  }) : unavailableLaunch;
  const exportLaunch = Object.freeze({
    ...baseExportLaunch,
    async complete(request) {
      let completed = false;
      try {
        const result = await baseExportLaunch.complete(request);
        completed = result?.ok === true;
        return result;
      } finally {
        // The launch queue must release its terminal proof before cleanup can clear that launch.
        if (retentionScheduler) void (completed
          ? retentionScheduler.run('post-export') : retentionScheduler.scheduleNext()).catch(() => {});
      }
    },
  });
  const blobUrlPortBridge = createBlobUrlPortBridgeV1({
    chromeApi, sessionArea, exportLaunch, auditStore, now: epochNow,
  });
  const reportOperations = createReportOperations({
    chromeApi, auditStore, sessionArea, modelNow, highlightController: composedHighlightController, highlightBindingStore,
    publishHighlightState,
    async requestAuditDeletion(request) {
      try { return await deletionCoordinator.request(request); }
      finally {
        if (retentionScheduler) void retentionScheduler.scheduleNext().catch(() => {});
      }
    },
  });
  const router = createSidePanelIntentRouter({
    chromeApi, authority, auditStarter, chromeAdapter,
    panelCoordinator: Object.freeze({
      attachPanelPort: panelCoordinator.attachPanelPort,
      withWindowLock: panelCoordinator.withWindowLock,
      publishHighlightState: panelCoordinator.publishHighlightState,
    }),
    urlAuditStarter: auditStarter, rawNavigationVault,
    createOwnershipId: () => createOwnershipId(bytes),
    personaStart, personaCoordinator,
    readReportRevision: ({ auditId }) => auditStore.getReportRevision(auditId),
    buildPanelResultBundle, revokeViewOnly, epochNow, modelNow,
    createAuditId: options.createAuditId ?? defaultAuditId, reportLaunch, exportLaunch, reportOperations,
    highlightController, highlightSessionBridge, publishHighlightState,
  });
  panelIntentDispatcher = createPageMarkersPanelDispatcher({
    pageMarkersController: pageMarkersCleanupController,
    dispatchFallback: request => router.dispatch(request),
  });
  const panelLauncher = options.panelLauncher ??
    createPanelLauncher({ chromeApi, launchAuthority: panelLaunchAuthority, logger: options.logger });
  await pixelScheduler.recoverOnStartup();
  const highlightRecovery = await highlightRuntimeController.recover();
  if (highlightRecovery?.ok !== true) throw new Error('WORKER_UNAVAILABLE');
  const personaRecovery = await personaCoordinator.recover();
  if (personaRecovery?.ok !== true) throw new Error('WORKER_UNAVAILABLE');
  const recovery = await auditStarter.recoverAuthorizedAuditLifecycle();
  if (recovery?.ok !== true) throw new Error('WORKER_UNAVAILABLE');
  const deletionCoordinator = createAuditDeletionCoordinatorV1({
    store: auditStore,
    authority,
    panelPortRegistry: panelCoordinator,
    reportPortRegistry: reportPortCoordinator,
    highlightController: composedHighlightController,
    highlightBindingStore,
    reportLaunch,
    exportLaunch,
    rawNavigationVault,
    pixelCaptureState: pixelState,
    ownedDisposableTabStore: ownedTabRegistry,
    blobRegistry: blobUrlPortBridge.registry,
    now: modelNow,
  });
  retentionScheduler = registerRetentionSchedulerV1(chromeApi, {
    store: auditStore, deletionCoordinator, now: modelNow,
  });
  return {
    readyRuntime: copyReadyRuntime({
      authority,
      auditStarter,
      chromeAdapter,
      reportLaunch,
      exportLaunch,
      personaCoordinator,
      highlightController: highlightRuntimeController,
    }),
    router, panelCoordinator, panelLauncher, reportPortCoordinator, pixelScheduler, blobUrlPortBridge,
    ...(pageMarkersWorkerBridge ? { pageMarkersWorkerBridge } : {}), retentionScheduler,
    pixelRecoveryComplete: true,
  };
}

function parseBuiltRuntime(value) {
  const blobKeys = value && Object.hasOwn(value, 'blobUrlPortBridge') ? ['blobUrlPortBridge'] : [];
  const retentionKeys = value && Object.hasOwn(value, 'retentionScheduler') ? ['retentionScheduler'] : [];
  const pageMarkerKeys = value && Object.hasOwn(value, 'pageMarkersWorkerBridge') ? ['pageMarkersWorkerBridge'] : [];
  const privateKeys = [...blobKeys, ...retentionKeys, ...pageMarkerKeys];
  const built = exact(value, ['readyRuntime', 'router', 'panelCoordinator', 'panelLauncher', 'reportPortCoordinator', 'pixelScheduler', 'pixelRecoveryComplete', ...privateKeys], true) ??
    exact(value, ['readyRuntime', 'router', 'panelCoordinator', 'panelLauncher', 'pixelScheduler', 'pixelRecoveryComplete', ...privateKeys], true) ??
    exact(value, ['readyRuntime', 'router', 'panelCoordinator', 'panelLauncher', 'reportPortCoordinator', 'pixelScheduler', ...privateKeys], true) ??
    exact(value, ['readyRuntime', 'router', 'panelCoordinator', 'panelLauncher', 'pixelScheduler', ...privateKeys], true) ??
    exact(value, ['readyRuntime', 'router', 'panelCoordinator', 'panelLauncher', 'reportPortCoordinator', ...privateKeys], true) ??
    exact(value, ['readyRuntime', 'router', 'panelCoordinator', 'panelLauncher', ...privateKeys], true);
  if (!built || typeof built.router?.dispatch !== 'function' ||
    typeof built.panelCoordinator?.attachPanelPort !== 'function' ||
    typeof built.panelLauncher?.launch !== 'function' ||
    (Object.hasOwn(built, 'pixelScheduler') &&
      (typeof built.pixelScheduler?.recoverOnStartup !== 'function' ||
        typeof built.pixelScheduler?.run !== 'function' || typeof built.pixelScheduler?.scheduleNext !== 'function' ||
        typeof built.pixelScheduler?.dispose !== 'function')) ||
    (Object.hasOwn(built, 'pixelRecoveryComplete') && built.pixelRecoveryComplete !== true) ||
    (Object.hasOwn(built, 'retentionScheduler') &&
      (typeof built.retentionScheduler?.run !== 'function' || typeof built.retentionScheduler?.scheduleNext !== 'function' ||
        typeof built.retentionScheduler?.dispose !== 'function')) ||
    (Object.hasOwn(built, 'blobUrlPortBridge') &&
      (typeof built.blobUrlPortBridge?.attachPort !== 'function' || typeof built.blobUrlPortBridge?.dispose !== 'function')) ||
    (Object.hasOwn(built, 'pageMarkersWorkerBridge') &&
      (typeof built.pageMarkersWorkerBridge?.attachPort !== 'function' ||
        typeof built.pageMarkersWorkerBridge?.handleRuntimeMessage !== 'function' ||
        typeof built.pageMarkersWorkerBridge?.dispose !== 'function')) ||
    (Object.hasOwn(built, 'reportPortCoordinator') &&
      typeof built.reportPortCoordinator?.attachReportPort !== 'function')) throw new Error('WORKER_UNAVAILABLE');
  return { ...built, readyRuntime: copyReadyRuntime(built.readyRuntime) };
}

export function registerServiceWorker(chromeApi, options = {}) {
  if (!chromeApi?.runtime?.onMessage?.addListener || !chromeApi.runtime.onMessage.removeListener ||
    !chromeApi?.runtime?.onConnect?.addListener || !chromeApi.runtime.onConnect.removeListener ||
    !chromeApi?.alarms?.onAlarm?.addListener || !chromeApi.alarms.onAlarm.removeListener ||
    !chromeApi?.action?.onClicked?.addListener || !chromeApi.action.onClicked.removeListener ||
    typeof chromeApi.alarms.create !== 'function' || typeof chromeApi.alarms.clear !== 'function' ||
    !chromeApi?.storage?.session) throw new TypeError('SERVICE_WORKER_INVALID');
  const logger = options.logger ?? { error() {} };
  const epochNow = options.epochNow ?? Date.now;
  const createEventNonce = options.createEventNonce ?? defaultNonce;
  const createAuditId = options.createAuditId ?? defaultAuditId;

  void invokeChrome(chromeApi, chromeApi.sidePanel, 'setOptions', {
    enabled: false,
  }).catch(() => logger.error(SIDE_PANEL_DEFAULT_DENIED));
  void invokeChrome(chromeApi, chromeApi.sidePanel, 'setPanelBehavior', {
    openPanelOnActionClick: false,
  }).catch(() => logger.error(SIDE_PANEL_BEHAVIOR_DENIED));

  let router = options.router ?? null;
  let panelCoordinator = options.panelCoordinator ?? null;
  let reportPortCoordinator = options.reportPortCoordinator ?? null;
  let panelLauncher = options.panelLauncher ?? null;
  let pixelScheduler = options.pixelScheduler ?? null;
  let blobUrlPortBridge = options.blobUrlPortBridge ?? null;
  let pageMarkersWorkerBridge = options.pageMarkersWorkerBridge ?? null;
  let retentionScheduler = null;
  let disposed = false;
  const pendingPageMarkerPorts = new Map();
  let earlyPanelLaunchAuthority = null;
  let settlePanelStorageGate = null;
  if (!options.startupReady && !options.buildRuntime && !panelLauncher) {
    const panelStorageGate = new Promise(resolve => { settlePanelStorageGate = resolve; });
    try {
      earlyPanelLaunchAuthority = createPanelLaunchAuthority({
        chromeApi,
        sessionArea: chromeApi.storage.session,
        now: epochNow,
        randomBytes: options.randomBytes ?? randomBytes,
      });
      void earlyPanelLaunchAuthority.initialize(panelStorageGate);
      panelLauncher = createPanelLauncher({ chromeApi, launchAuthority: earlyPanelLaunchAuthority, logger });
    } catch {
      earlyPanelLaunchAuthority = null;
      settlePanelStorageGate(false);
      settlePanelStorageGate = null;
    }
  }
  let resolveStartup;
  let rejectStartup;
  let startupReady;

  if (options.startupReady) {
    startupReady = Promise.resolve(options.startupReady).then(async value => {
      if (pixelScheduler) await pixelScheduler.recoverOnStartup();
      return copyReadyRuntime(value);
    });
  } else {
    startupReady = new Promise((resolve, reject) => { resolveStartup = resolve; rejectStartup = reject; });
  }
  const getReadyRuntime = () => startupReady;

  const messageListener = (message, sender, sendResponse) => {
    if (isPageMarkersRuntimeMessage(message)) {
      void startupReady.then(() => {
        if (!disposed) pageMarkersWorkerBridge?.handleRuntimeMessage(message, sender);
      }, () => false).catch(() => false);
      return false;
    }
    const primary = parseWorkerMessage(message);
    if (!primary.ok && primary.code === 'UNKNOWN_MESSAGE') return false;
    void startupReady.then(async () => {
      if (!primary.ok) return primary.code === 'MESSAGE_TOO_LARGE'
        ? Object.freeze({ ok: false, code: 'MESSAGE_TOO_LARGE' })
        : Object.freeze({ ok: false, code: 'INVALID_MESSAGE' });
      if (isPanelPortIntent(primary.value)) return Object.freeze({ ok: false, code: 'CONTEXT_DENIED' });
      try { return await router.dispatch({ envelope: primary.value, sender }); }
      catch { return Object.freeze({ ok: false, code: 'WORKER_UNAVAILABLE' }); }
    }, () => Object.freeze({ ok: false, code: 'WORKER_UNAVAILABLE' }))
      .then(response => {
        try { sendResponse(response); } catch { /* one closed response attempt */ }
      });
    return true;
  };

  const connectListener = port => {
    const name = own(port, 'name');
    const disconnect = () => { try { port?.disconnect?.(); } catch { /* fixed denial */ } };
    const isPendingPageMarkerPort = name === PAGE_MARKERS_PORT_NAME;
    if (isPendingPageMarkerPort) pendingPageMarkerPorts.set(port, disconnect);
    const releasePendingPageMarkerPort = () => {
      if (pendingPageMarkerPorts.get(port) !== disconnect) return false;
      pendingPageMarkerPorts.delete(port);
      return true;
    };
    void startupReady.then(() => {
      const released = isPendingPageMarkerPort ? releasePendingPageMarkerPort() : true;
      if (disposed) {
        if (released) disconnect();
        return;
      }
      if (name === PANEL_PORT_NAME) panelCoordinator.attachPanelPort(port);
      else if (name === REPORT_PORT_NAME && reportPortCoordinator) reportPortCoordinator.attachReportPort(port);
      else if (name === BLOB_URL_PORT_NAME && blobUrlPortBridge) {
        try { if (blobUrlPortBridge.attachPort(port) !== true) disconnect(); }
        catch { disconnect(); }
      } else if (name === PAGE_MARKERS_PORT_NAME && pageMarkersWorkerBridge) {
        try { if (pageMarkersWorkerBridge.attachPort(port) !== true) disconnect(); }
        catch { disconnect(); }
      } else disconnect();
    }, () => {
      const released = isPendingPageMarkerPort ? releasePendingPageMarkerPort() : true;
      if (released) disconnect();
    });
  };

  const alarmListener = alarm => {
    const name = own(alarm, 'name');
    if (name === PERSONA_EXPIRY_ALARM_NAME) {
      void startupReady.then(runtime => runtime.personaCoordinator?.expireDue?.(), () => false).catch(() => false);
      return;
    }
    if (name === HIGHLIGHT_EXPIRY_ALARM_NAME) {
      void startupReady.then(runtime => runtime.highlightController?.expireDue?.(), () => false).catch(() => false);
      return;
    }
    if (name === PIXEL_CONSENT_ALARM_NAME) {
      void startupReady.then(() => pixelScheduler?.run?.('alarm'), () => false).catch(() => false);
    }
  };

  const actionListener = tab => {
    try {
      if (typeof panelLauncher?.launch !== 'function' || panelLauncher.launch(tab) !== true) {
        logger.error('PANEL_LAUNCH_UNAVAILABLE');
      } else {
        void startupReady.then(() => pixelScheduler?.run?.('panel'), () => false).catch(() => false);
        void startupReady.then(() => disposed ? false : retentionScheduler?.run('panel'), () => false).catch(() => false);
      }
    } catch { logger.error('PANEL_LAUNCH_UNAVAILABLE'); }
  };

  chromeApi.runtime.onMessage.addListener(messageListener);
  chromeApi.runtime.onConnect.addListener(connectListener);
  chromeApi.alarms.onAlarm.addListener(alarmListener);
  chromeApi.action.onClicked.addListener(actionListener);

  const lifecycle = createAuditLifecycle({
    chromeApi,
    getReadyRuntime,
    rebindPanelForNavigation: value => typeof panelLauncher?.rebindForNavigation === 'function'
      ? panelLauncher.rebindForNavigation(value)
      : false,
  });
  lifecycle.register();
  const contextMenus = registerAuditContextMenus(chromeApi, {
    getReadyRuntime, createEventNonce, createAuditId, epochNow, logger,
    launchPanel: (tab, onOpened) => {
      if (typeof panelLauncher?.launch !== 'function' || panelLauncher.launch(tab, onOpened) !== true) return false;
      void startupReady.then(() => disposed ? false : retentionScheduler?.run('panel'), () => false).catch(() => false);
      return true;
    },
  });
  void startupReady.then(() => contextMenus.installMenus(), () => false);

  if (!options.startupReady) {
    Promise.resolve().then(async () => {
      try {
        if (typeof chromeApi.storage.session.setAccessLevel !== 'function') throw new Error(SESSION_ACCESS_LEVEL_DENIED);
        await invokeChrome(chromeApi, chromeApi.storage.session, 'setAccessLevel', { accessLevel: 'TRUSTED_CONTEXTS' });
      } catch {
        settlePanelStorageGate?.(false);
        logger.error(SESSION_ACCESS_LEVEL_DENIED);
        rejectStartup(new Error('WORKER_UNAVAILABLE'));
        return;
      }
      settlePanelStorageGate?.(true);
      try {
        const built = parseBuiltRuntime(options.buildRuntime
          ? await options.buildRuntime({ chromeApi, sessionArea: chromeApi.storage.session })
          : await buildDefaultRuntime(chromeApi, {
            ...options, logger, epochNow, createAuditId,
            panelLaunchAuthority: earlyPanelLaunchAuthority ?? undefined,
            panelLauncher: panelLauncher ?? undefined,
          }));
        router = built.router;
        panelCoordinator = built.panelCoordinator;
        reportPortCoordinator = built.reportPortCoordinator ?? null;
        panelLauncher = built.panelLauncher;
        pixelScheduler = built.pixelScheduler ?? null;
        blobUrlPortBridge = built.blobUrlPortBridge ?? null;
        pageMarkersWorkerBridge = built.pageMarkersWorkerBridge ?? null;
        retentionScheduler = built.retentionScheduler ?? null;
        if (pixelScheduler && built.pixelRecoveryComplete !== true) await pixelScheduler.recoverOnStartup();
        if (disposed) {
          try { pixelScheduler?.dispose(); } catch { /* local scheduler cleanup */ }
          try { blobUrlPortBridge?.dispose(); } catch { /* local bridge cleanup */ }
          try { pageMarkersWorkerBridge?.dispose(); } catch { /* local bridge cleanup */ }
          try { retentionScheduler?.dispose(); } catch { /* local scheduler cleanup */ }
        }
        resolveStartup(built.readyRuntime);
        if (!disposed) void retentionScheduler?.run('startup').catch(() => {});
      } catch {
        rejectStartup(new Error('WORKER_UNAVAILABLE'));
      }
    });
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    const pendingMarkerDisconnects = [...pendingPageMarkerPorts.values()];
    pendingPageMarkerPorts.clear();
    for (const disconnect of pendingMarkerDisconnects) disconnect();
    chromeApi.runtime.onMessage.removeListener(messageListener);
    chromeApi.runtime.onConnect.removeListener(connectListener);
    chromeApi.alarms.onAlarm.removeListener(alarmListener);
    chromeApi.action.onClicked.removeListener(actionListener);
    lifecycle.dispose();
    contextMenus.dispose();
    try { pixelScheduler?.dispose?.(); } catch { /* disposal is best-effort and local */ }
    try { blobUrlPortBridge?.dispose?.(); } catch { /* disposal is best-effort and local */ }
    try { pageMarkersWorkerBridge?.dispose?.(); } catch { /* disposal is best-effort and local */ }
    try { retentionScheduler?.dispose(); } catch { /* disposal is best-effort and local */ }
  }

  return Object.freeze({ startupReady, dispose });
}

export async function initializeServiceWorker(chromeApi, options = {}) {
  const registration = registerServiceWorker(chromeApi, options);
  try { await registration.startupReady; return registration; }
  catch { return null; }
}

if (typeof chrome !== 'undefined') registerServiceWorker(chrome);
