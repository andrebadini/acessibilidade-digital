import { createInstalledCoreRuleInventory } from '../core/rules/core-rule-inventory.js';
import {
  createSessionPixelAttemptDigestAuthority,
  createSessionUrlDigestManager,
} from '../core/privacy/session-url-digest.js';
import { createRawNavigationVaultV1 } from './raw-navigation-vault.js';
import { createAuditDeletedEvent } from '../core/audit-deleted-event.js';
import { applyReviewDecisions, createReviewDecision } from '../core/review/decisions.js';
import { createAuditModel } from '../core/report/audit-model.js';
import { createPanelResultBundleV1 } from '../panel/panel-result-bundle.js';
import {
  AuditDeleteBusyError,
  createAuditStore,
  readPrivatePixelAttemptCommitV1,
  removePrivatePixelAttemptCommitV1,
} from '../storage/audit-store.js';
import {
  ACTIVE_AUDIT_JOB_KEY,
  createAuthorizedAuditStarter,
  executionCheckpointStorageKey,
  readActiveAuditJobForWorker,
} from './authorized-audit-starter.js';
import { createAuditLifecycle } from './audit-lifecycle.js';
import { createPixelCaptureStateV1 } from './pixel-capture-consent.js';
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
  composeChromeAdapter,
  createChromeAdapter,
  createChromeAuditAuthority,
} from './chrome-adapter.js';
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
} from './panel-port.js';
import { createPanelLaunchAuthority } from './panel-launch-authority.js';
import { createPanelLauncher } from './panel-launcher.js';
import { createPersonaCoordinator } from './persona-coordinator.js';
import { createPersonaLeaseStore } from './persona-lease-store.js';
import { createPersonaInjectionRuntime } from './persona-runtime.js';
import { createPersonaStartOrchestrator } from './persona-start-orchestrator.js';
import { createOwnershipId, runAttachedAuditExecution, runUrlAudit } from './run-audit.js';
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
    const ownedAttempt = request?.pageId === 'page-1' &&
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

  async function classifyCore(rawRequest) {
    const compact = exact(rawRequest, ['auditId', 'consentId']);
    const correlated = exact(rawRequest, ['auditId', 'consentId', 'pageId', 'ownershipId']);
    const request = compact ?? correlated;
    const expectedPageId = correlated?.pageId ?? null;
    const expectedOwnershipId = correlated?.ownershipId ?? null;
    const expectedAttached = expectedPageId === null && expectedOwnershipId === null;
    const expectedOwned = expectedPageId === 'page-1' &&
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
    const expectedOwned = pageId === 'page-1' && /^owner_[A-Za-z0-9_-]{22}$/u.test(ownershipId ?? '');
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

  return Object.freeze({ prepareResume, commitTerminal, classify, cleanup });
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
  const parseOwned = (value, auditId, ownershipId) => {
    if (value === null) return null;
    const record = exact(value, [
      'version', 'ownershipId', 'auditId', 'purpose', 'tabId', 'windowId',
      'cleanupMode', 'state', 'createdAt', 'updatedAt',
    ]);
    return record?.version === 2 && record.ownershipId === ownershipId && record.auditId === auditId &&
      record.purpose === 'audit' && Number.isSafeInteger(record.tabId) && record.tabId >= 0 &&
      Number.isSafeInteger(record.windowId) && record.windowId >= 0 &&
      record.cleanupMode === 'pre-observation-failure' && states.has(record.state)
      ? record : undefined;
  };
  return Object.freeze(async rawRequest => {
    const request = exact(rawRequest, ['auditId', 'ownershipId']);
    if (!request || !AUDIT_ID.test(request.auditId ?? '') ||
      !/^owner_[A-Za-z0-9_-]{22}$/u.test(request.ownershipId ?? '')) return false;
    let failed = false;
    try { await input.rawNavigationVault.clearAudit(request.auditId); } catch { failed = true; }
    let current;
    try { current = parseOwned(await input.ownedTabRegistry.get(request.ownershipId), request.auditId, request.ownershipId); }
    catch { return false; }
    if (current === undefined) return false;
    if (current !== null && current.state !== 'removed') {
      let removed;
      try {
        removed = parseOwned(await input.ownedTabRegistry.removeOwned({
          ownershipId: request.ownershipId, auditId: request.auditId,
          tabId: current.tabId, fromState: current.state,
        }), request.auditId, request.ownershipId);
      } catch { return false; }
      if (!removed || removed.state !== 'removed') return false;
    }
    let confirmed;
    try { confirmed = parseOwned(await input.ownedTabRegistry.get(request.ownershipId), request.auditId, request.ownershipId); }
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

export function createReportOperations({
  chromeApi, auditStore, sessionArea, modelNow, highlightController, highlightBindingStore,
  publishHighlightState,
}) {
  const checkpoints = createCheckpointAdapters(sessionArea);
  const now = () => canonicalModelTime(modelNow);

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

  async function deleteAudit({ auditId }) {
    try {
      const active = await readActiveAuditJobForWorker({ sessionArea });
      if (active?.auditId === auditId) return Object.freeze({ ok: false, code: 'AUDIT_DELETE_BUSY' });
      const snapshot = await auditStore.getAuditSnapshot(auditId);
      if (snapshot?.model?.auditId !== auditId || !snapshot.capability) return Object.freeze({ ok: false, code: 'REPORT_OPERATION_FAILED' });
      if (!await clearHighlightAudit(auditId, 'delete-audit')) return Object.freeze({ ok: false, code: 'REPORT_OPERATION_FAILED' });
      const result = await auditStore.deleteAudit(auditId, snapshot.capability, { now: now() });
      if (result?.deleted !== true) return Object.freeze({ ok: false, code: 'REPORT_OPERATION_FAILED' });
      await checkpoints.removeCheckpoint({ auditId, sessionCapabilityId: null, windowId: null });
      await sendRuntimeMessage(chromeApi, createAuditDeletedEvent({ auditId, reason: 'delete-one' })).catch(() => {});
      return freeze({ ok: true, auditId, deleted: true });
    } catch (error) {
      return error instanceof AuditDeleteBusyError || own(error, 'code') === 'AUDIT_DELETE_BUSY'
        ? Object.freeze({ ok: false, code: 'AUDIT_DELETE_BUSY' })
        : Object.freeze({ ok: false, code: 'REPORT_OPERATION_FAILED' });
    }
  }

  async function deleteAllAudits() {
    try {
      if (await readActiveAuditJobForWorker({ sessionArea }) !== null) return Object.freeze({ ok: false, code: 'AUDIT_DELETE_BUSY' });
      const highlightSnapshot = await highlightBindingStore.snapshot();
      const highlightAuditIds = new Set([
        ...Object.values(highlightSnapshot.bindingsByAuditPage ?? {}).map(value => value?.auditId),
        ...Object.values(highlightSnapshot.activeOverlayByTab ?? {}).map(value => value?.auditId),
      ].filter(value => typeof value === 'string'));
      for (const auditId of highlightAuditIds) {
        if (!await clearHighlightAudit(auditId, 'delete-all')) return Object.freeze({ ok: false, code: 'REPORT_OPERATION_FAILED' });
      }
      const confirmedHighlights = await highlightBindingStore.snapshot();
      if (Object.keys(confirmedHighlights.bindingsByAuditPage ?? {}).length > 0 ||
        Object.keys(confirmedHighlights.activeOverlayByTab ?? {}).length > 0) {
        return Object.freeze({ ok: false, code: 'REPORT_OPERATION_FAILED' });
      }
      const result = await auditStore.deleteAllAudits({ now: now() });
      if (!Number.isSafeInteger(result?.deleted) || result.deleted < 0) throw new Error('denied');
      await sendRuntimeMessage(chromeApi, createAuditDeletedEvent({ scope: 'all', reason: 'delete-all' })).catch(() => {});
      return freeze({ ok: true, deleted: result.deleted });
    } catch (error) {
      return error instanceof AuditDeleteBusyError || own(error, 'code') === 'AUDIT_DELETE_BUSY'
        ? Object.freeze({ ok: false, code: 'AUDIT_DELETE_BUSY' })
        : Object.freeze({ ok: false, code: 'REPORT_OPERATION_FAILED' });
    }
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
  const liquidatorBridge = createLateBoundPixelLiquidatorFacadeV1();
  const pixelScheduler = (options.pixelConsentSchedulerFactory ?? createPixelConsentExpirySchedulerV1)(chromeApi, {
    pixelState, liquidator: liquidatorBridge.facade, now: epochNow,
  });
  const launchApisAvailable = typeof chromeApi.tabs?.create === 'function' && typeof chromeApi.tabs?.update === 'function' &&
    typeof chromeApi.tabs?.get === 'function' && typeof chromeApi.tabs?.remove === 'function';
  const unavailableLaunch = freeze({
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
          const disposable = exact(session.targetBinding, ['kind', 'ownershipId', 'state'], true);
          if (disposable?.kind !== 'disposable' || disposable.state !== 'retained-for-review' ||
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
  const cleanupBarrier = createLiveAidCleanup({
    highlightCleaner: highlightController,
    personaCoordinator,
    targetQueue,
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
  const panelCoordinator = createPanelPortCoordinator({
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
    dispatchPanelIntent: request => panelIntentDispatcher
      ? panelIntentDispatcher(request)
      : Object.freeze({ ok: false, code: 'CONTEXT_DENIED' }),
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
  const urlAuditResourceCleaner = createExactUrlAuditResourceCleanerV1({
    rawNavigationVault,
    ownedTabRegistry: createOwnedTabRegistry({
      sessionArea,
      chromeAdapter: Object.freeze({ removeTab: tabId => chromeAdapter.removeTab(tabId) }),
      now: modelNow,
    }),
  });
  const auditStarter = createAuthorizedAuditStarter({
    authority, sessionArea, panelCoordinator: panelAuditCoordinator, targetQueue, cleanupBarrier,
    runAttachedAuditExecution: args => runAttachedAuditExecution({
      ...args, chromeAdapter, expectedExtensionId: chromeApi.runtime.id,
    }),
    runUrlAuditExecution: options.runUrlAuditExecution ?? (args => {
      const checkpointStore = Object.freeze({
        writeSanitized: (auditId, checkpoint) => {
          if (auditId !== args.auditId) throw new Error('CHECKPOINT_PERSIST_DENIED');
          return args.onCheckpoint(checkpoint);
        },
        persistAuditModel: (model, observedTarget) => args.persistAuditModel(model, observedTarget),
      });
      const common = {
        auditId: args.auditId, chromeAdapter, capturePolicy: args.capturePolicy,
        checkpointStore, onProgress: event => chromeAdapter.emitProgress(event),
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
            rawNavigationVault,
            ...(args.privacyGate ? { privacyGate: args.privacyGate } : {}),
          });
    }),
    clearUrlAuditResources: urlAuditResourceCleaner,
    persistLatest, persistCheckpoint: checkpoints.persistCheckpoint, removeCheckpoint: checkpoints.removeCheckpoint,
    commitTerminalAudit,
    readAuditSnapshot: ({ auditId }) => auditStore.getAuditSnapshot(auditId),
    readReportRevision: ({ auditId }) => auditStore.getReportRevision(auditId),
    readLatest: () => auditStore.getLatest(), buildPanelResultBundle,
    recordHighlightBinding: value => highlightBindingRecorder.record(value),
    pixelCommitClock,
    epochNow, modelNow, createAbortController: () => new AbortController(),
    pixelState,
    probeDocumentIdentity: tabId => chromeAdapter.probeDocumentIdentity(tabId),
    probeSensitiveCaptureSignals,
    pixelAttemptLifecycle,
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
    controller: highlightController,
    publishHighlightState,
    scheduleExpiry: scheduleHighlightExpiry,
  });
  const exportCompletionStore = createExportCompletionStore({
    auditStore,
    emitTerminal: event => chromeAdapter.emitProgress(event),
  });
  const exportLaunch = launchApisAvailable ? createExportLaunchAuthority({
    chromeApi, sessionArea, auditStore: exportCompletionStore, reportLaunch, epochNow, modelNow, randomBytes: bytes,
  }) : unavailableLaunch;
  const reportOperations = createReportOperations({
    chromeApi, auditStore, sessionArea, modelNow, highlightController, highlightBindingStore,
    publishHighlightState,
  });
  const router = createSidePanelIntentRouter({
    chromeApi, authority, auditStarter, panelCoordinator, chromeAdapter,
    urlAuditStarter: auditStarter, rawNavigationVault,
    createOwnershipId: () => createOwnershipId(bytes),
    personaStart, personaCoordinator,
    readReportRevision: ({ auditId }) => auditStore.getReportRevision(auditId),
    buildPanelResultBundle, revokeViewOnly, epochNow, modelNow,
    createAuditId: options.createAuditId ?? defaultAuditId, reportLaunch, exportLaunch, reportOperations,
    highlightController, highlightSessionBridge, publishHighlightState,
  });
  panelIntentDispatcher = request => router.dispatch(request);
  const panelLauncher = options.panelLauncher ??
    createPanelLauncher({ chromeApi, launchAuthority: panelLaunchAuthority, logger: options.logger });
  await pixelScheduler.recoverOnStartup();
  const highlightRecovery = await highlightRuntimeController.recover();
  if (highlightRecovery?.ok !== true) throw new Error('WORKER_UNAVAILABLE');
  const personaRecovery = await personaCoordinator.recover();
  if (personaRecovery?.ok !== true) throw new Error('WORKER_UNAVAILABLE');
  const recovery = await auditStarter.recoverAuthorizedAuditLifecycle();
  if (recovery?.ok !== true) throw new Error('WORKER_UNAVAILABLE');
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
    router, panelCoordinator, panelLauncher, reportPortCoordinator, pixelScheduler,
    pixelRecoveryComplete: true,
  };
}

function parseBuiltRuntime(value) {
  const built = exact(value, ['readyRuntime', 'router', 'panelCoordinator', 'panelLauncher', 'reportPortCoordinator', 'pixelScheduler', 'pixelRecoveryComplete'], true) ??
    exact(value, ['readyRuntime', 'router', 'panelCoordinator', 'panelLauncher', 'pixelScheduler', 'pixelRecoveryComplete'], true) ??
    exact(value, ['readyRuntime', 'router', 'panelCoordinator', 'panelLauncher', 'reportPortCoordinator', 'pixelScheduler'], true) ??
    exact(value, ['readyRuntime', 'router', 'panelCoordinator', 'panelLauncher', 'pixelScheduler'], true) ??
    exact(value, ['readyRuntime', 'router', 'panelCoordinator', 'panelLauncher', 'reportPortCoordinator'], true) ??
    exact(value, ['readyRuntime', 'router', 'panelCoordinator', 'panelLauncher'], true);
  if (!built || typeof built.router?.dispatch !== 'function' ||
    typeof built.panelCoordinator?.attachPanelPort !== 'function' ||
    typeof built.panelLauncher?.launch !== 'function' ||
    (Object.hasOwn(built, 'pixelScheduler') &&
      (typeof built.pixelScheduler?.recoverOnStartup !== 'function' ||
        typeof built.pixelScheduler?.run !== 'function' || typeof built.pixelScheduler?.scheduleNext !== 'function' ||
        typeof built.pixelScheduler?.dispose !== 'function')) ||
    (Object.hasOwn(built, 'pixelRecoveryComplete') && built.pixelRecoveryComplete !== true) ||
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
    void startupReady.then(() => {
      if (name === PANEL_PORT_NAME) panelCoordinator.attachPanelPort(port);
      else if (name === REPORT_PORT_NAME && reportPortCoordinator) reportPortCoordinator.attachReportPort(port);
      else {
        try { port?.disconnect?.(); } catch { /* fixed denial */ }
      }
    }, () => {
      try { port?.disconnect?.(); } catch { /* fixed denial */ }
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
    launchPanel: (tab, onOpened) => typeof panelLauncher?.launch === 'function' &&
      panelLauncher.launch(tab, onOpened) === true,
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
        if (pixelScheduler && built.pixelRecoveryComplete !== true) await pixelScheduler.recoverOnStartup();
        resolveStartup(built.readyRuntime);
      } catch {
        rejectStartup(new Error('WORKER_UNAVAILABLE'));
      }
    });
  }

  function dispose() {
    chromeApi.runtime.onMessage.removeListener(messageListener);
    chromeApi.runtime.onConnect.removeListener(connectListener);
    chromeApi.alarms.onAlarm.removeListener(alarmListener);
    chromeApi.action.onClicked.removeListener(actionListener);
    lifecycle.dispose();
    contextMenus.dispose();
    try { pixelScheduler?.dispose?.(); } catch { /* disposal is best-effort and local */ }
  }

  return Object.freeze({ startupReady, dispose });
}

export async function initializeServiceWorker(chromeApi, options = {}) {
  const registration = registerServiceWorker(chromeApi, options);
  try { await registration.startupReady; return registration; }
  catch { return null; }
}

if (typeof chrome !== 'undefined') registerServiceWorker(chrome);
