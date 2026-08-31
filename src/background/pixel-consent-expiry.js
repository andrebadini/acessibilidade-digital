import { isCapturePolicyV1 } from '../core/privacy/capture-policy.js';
import { isEvidenceUrlV1 } from '../core/privacy/evidence-url.js';

export const PIXEL_CONSENT_ALARM_NAME = 'audita-pixel-consent-expiry-v1';

const LIQUIDATION_TIMEOUT_MS = 5_000;
const MINIMUM_ALARM_RETRY_MS = 60_000;
const MAX_SCHEDULE_RECALCULATIONS = 8;
const ALARM_STATES = new WeakMap();
const AUDIT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/u;
const CONSENT_ID_PATTERN = /^[A-Za-z0-9_-]{21}[AQgw]$/u;
const DIGEST_PATTERN = /^hmac-sha256:[A-Za-z0-9_-]{43}$/u;
const CATEGORIES = Object.freeze(['password', 'otp', 'payment', 'private-marker']);
const REVOKE_REASONS = new Set(['PIXEL_CONSENT_EXPIRED', 'PIXEL_CONSENT_DOCUMENT_CHANGED', 'PIXEL_RESUME_INTERRUPTED', 'AUDIT_CANCELLED', 'AUDIT_DELETED', 'SESSION_ENDED']);
const SUSPENSION_KEYS = Object.freeze(['version', 'revision', 'auditId', 'consentId', 'tabId', 'windowId', 'documentId', 'urlEvidence', 'urlSessionDigest', 'mode', 'capturePolicy', 'categories', 'issuedAt', 'updatedAt', 'expiresAt', 'cleanupAttempts', 'cleanupNotBefore', 'state', 'resumePhase', 'revokeReason', 'source']);
const LOCAL_TIMER = Object.freeze({
  set(callback, delayMs) { return globalThis.setTimeout(callback, delayMs); },
  clear(handle) { globalThis.clearTimeout(handle); },
});

function failure(code) { return new Error(code); }
function validEpoch(value) { return Number.isSafeInteger(value) && value >= 0; }
function validPositive(value) { return Number.isSafeInteger(value) && value > 0; }

function exactOwnData(value, keys) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== keys.length || keys.some(key => !ownKeys.includes(key))) return null;
    const projected = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      projected[key] = descriptor.value;
    }
    return projected;
  } catch { return null; }
}

function denseOwnDataArray(value) {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
    const ownKeys = Reflect.ownKeys(value);
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    if (!lengthDescriptor || lengthDescriptor.enumerable || !Object.hasOwn(lengthDescriptor, 'value') || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) return null;
    const length = lengthDescriptor.value;
    const expected = ['length', ...Array.from({ length }, (_unused, index) => String(index))];
    if (ownKeys.length !== expected.length || expected.some(key => !ownKeys.includes(key))) return null;
    const projected = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      projected.push(descriptor.value);
    }
    return projected;
  } catch { return null; }
}

function sourceProjection(value) {
  const attached = exactOwnData(value, ['kind']);
  if (attached?.kind === 'attached') return Object.freeze(attached);
  const owned = exactOwnData(value, ['kind', 'ownershipId', 'cleanupMode', 'pageId']);
  if (!owned || owned.kind !== 'owned-disposable' || typeof owned.ownershipId !== 'string' || !AUDIT_ID_PATTERN.test(owned.ownershipId) || !['always', 'pre-observation-failure'].includes(owned.cleanupMode) || owned.pageId !== null && (typeof owned.pageId !== 'string' || !AUDIT_ID_PATTERN.test(owned.pageId))) return null;
  return Object.freeze(owned);
}

function canonicalCategories(value) {
  let previous = -1;
  for (const category of value) {
    if (typeof category !== 'string') return false;
    const index = CATEGORIES.indexOf(category);
    if (index <= previous) return false;
    previous = index;
  }
  return true;
}

function suspensionProjection(value) {
  const suspension = exactOwnData(value, SUSPENSION_KEYS);
  const categoryValues = suspension && denseOwnDataArray(suspension.categories);
  const source = suspension && sourceProjection(suspension.source);
  const capturePolicy = suspension && exactOwnData(suspension.capturePolicy, ['version', 'mode', 'includeQuery', 'captureFullPage', 'captureElements', 'composeAnnouncementMap']);
  const urlEvidence = suspension && exactOwnData(suspension.urlEvidence, ['version', 'href', 'queryIncluded', 'redactedSegments']);
  if (!suspension || suspension.version !== 'AuditSuspensionV1' || !validPositive(suspension.revision) || typeof suspension.auditId !== 'string' || !AUDIT_ID_PATTERN.test(suspension.auditId) || typeof suspension.consentId !== 'string' || !CONSENT_ID_PATTERN.test(suspension.consentId) || !validEpoch(suspension.tabId) || !validEpoch(suspension.windowId) || typeof suspension.documentId !== 'string' || !AUDIT_ID_PATTERN.test(suspension.documentId) || typeof suspension.urlSessionDigest !== 'string' || !DIGEST_PATTERN.test(suspension.urlSessionDigest) || !['full-evidence', 'element-only'].includes(suspension.mode) || !capturePolicy || !isCapturePolicyV1(capturePolicy) || capturePolicy.mode !== suspension.mode || !urlEvidence || !isEvidenceUrlV1(urlEvidence) || urlEvidence.queryIncluded && !capturePolicy.includeQuery || !categoryValues || !canonicalCategories(categoryValues) || !validEpoch(suspension.issuedAt) || !validEpoch(suspension.updatedAt) || !validEpoch(suspension.expiresAt) || suspension.updatedAt < suspension.issuedAt || suspension.expiresAt <= suspension.issuedAt || suspension.expiresAt - suspension.issuedAt > 600_000 || !Number.isSafeInteger(suspension.cleanupAttempts) || suspension.cleanupAttempts < 0 || suspension.cleanupAttempts > 31 || !source || !['paused', 'resuming', 'revoked', 'finished'].includes(suspension.state)) return null;
  if (suspension.state === 'resuming' && !['consent-claimed', 'session-running', 'runner-started'].includes(suspension.resumePhase) || suspension.state !== 'resuming' && suspension.resumePhase !== null || suspension.state === 'revoked' && !REVOKE_REASONS.has(suspension.revokeReason) || suspension.state !== 'revoked' && suspension.revokeReason !== null) return null;
  const terminal = suspension.state === 'revoked' || suspension.state === 'finished';
  if (terminal ? !validEpoch(suspension.cleanupNotBefore) || suspension.cleanupNotBefore < suspension.updatedAt : suspension.cleanupAttempts !== 0 || suspension.cleanupNotBefore !== null) return null;
  return Object.freeze({
    version: suspension.version,
    auditId: suspension.auditId,
    consentId: suspension.consentId,
    revision: suspension.revision,
    tabId: suspension.tabId,
    windowId: suspension.windowId,
    documentId: suspension.documentId,
    urlEvidence: Object.freeze(urlEvidence),
    urlSessionDigest: suspension.urlSessionDigest,
    mode: suspension.mode,
    capturePolicy: Object.freeze(capturePolicy),
    categories: Object.freeze(categoryValues),
    issuedAt: suspension.issuedAt,
    updatedAt: suspension.updatedAt,
    expiresAt: suspension.expiresAt,
    cleanupAttempts: suspension.cleanupAttempts,
    cleanupNotBefore: suspension.cleanupNotBefore,
    state: suspension.state,
    resumePhase: suspension.resumePhase,
    revokeReason: suspension.revokeReason,
    source,
  });
}

function sameSource(left, right) {
  if (left.kind !== right.kind) return false;
  return left.kind === 'attached' ||
    left.ownershipId === right.ownershipId && left.cleanupMode === right.cleanupMode &&
    left.pageId === right.pageId;
}

function sameImmutableSuspension(left, right) {
  return left.version === right.version && left.auditId === right.auditId &&
    left.consentId === right.consentId && left.tabId === right.tabId &&
    left.windowId === right.windowId && left.documentId === right.documentId &&
    left.urlEvidence.version === right.urlEvidence.version &&
    left.urlEvidence.href === right.urlEvidence.href &&
    left.urlEvidence.queryIncluded === right.urlEvidence.queryIncluded &&
    left.urlEvidence.redactedSegments === right.urlEvidence.redactedSegments &&
    left.urlSessionDigest === right.urlSessionDigest && left.mode === right.mode &&
    left.capturePolicy.version === right.capturePolicy.version &&
    left.capturePolicy.mode === right.capturePolicy.mode &&
    left.capturePolicy.includeQuery === right.capturePolicy.includeQuery &&
    left.capturePolicy.captureFullPage === right.capturePolicy.captureFullPage &&
    left.capturePolicy.captureElements === right.capturePolicy.captureElements &&
    left.capturePolicy.composeAnnouncementMap === right.capturePolicy.composeAnnouncementMap &&
    left.categories.length === right.categories.length &&
    left.categories.every((category, index) => category === right.categories[index]) &&
    left.issuedAt === right.issuedAt && left.expiresAt === right.expiresAt &&
    sameSource(left.source, right.source);
}

function sameMutableSuspension(left, right) {
  return left.revision === right.revision && left.updatedAt === right.updatedAt &&
    left.cleanupAttempts === right.cleanupAttempts &&
    left.cleanupNotBefore === right.cleanupNotBefore && left.state === right.state &&
    left.resumePhase === right.resumePhase && left.revokeReason === right.revokeReason;
}

function immediateRevision(candidate, suspension) {
  return candidate.revision < Number.MAX_SAFE_INTEGER &&
    suspension.revision === candidate.revision + 1 &&
    suspension.updatedAt >= candidate.updatedAt;
}

function canonicalImmediateRevocation(candidate, suspension) {
  return ['paused', 'resuming'].includes(candidate.state) &&
    immediateRevision(candidate, suspension) &&
    suspension.state === 'revoked' && suspension.resumePhase === null &&
    suspension.cleanupAttempts === 0 &&
    suspension.cleanupNotBefore === suspension.updatedAt;
}

function immediateRevocation(candidate, suspension) {
  const revokeReason = candidate.state === 'paused'
    ? 'PIXEL_CONSENT_EXPIRED'
    : candidate.state === 'resuming'
      ? 'PIXEL_RESUME_INTERRUPTED'
      : null;
  return revokeReason !== null && suspension.revokeReason === revokeReason &&
    canonicalImmediateRevocation(candidate, suspension);
}

function correlatedAlreadyRevoked(candidate, suspension) {
  return candidate.state === 'revoked'
    ? sameMutableSuspension(suspension, candidate)
    : canonicalImmediateRevocation(candidate, suspension);
}

function terminalFinishAfter(candidate, suspension) {
  return ['paused', 'resuming', 'revoked'].includes(candidate.state) &&
    suspension.revision > candidate.revision &&
    suspension.updatedAt >= candidate.updatedAt &&
    suspension.state === 'finished' && suspension.resumePhase === null &&
    suspension.revokeReason === null && suspension.cleanupAttempts === 0 &&
    suspension.cleanupNotBefore === suspension.updatedAt;
}

function finishRetryCandidate(fallback, latest) {
  if (!fallback || !latest || !sameImmutableSuspension(latest, fallback)) return null;
  if (latest.revision === fallback.revision && latest.state === fallback.state &&
    latest.updatedAt === fallback.updatedAt &&
    latest.cleanupAttempts === fallback.cleanupAttempts &&
    latest.cleanupNotBefore === fallback.cleanupNotBefore &&
    latest.resumePhase === fallback.resumePhase &&
    latest.revokeReason === fallback.revokeReason) return latest;
  if (fallback.state !== 'revoked' || fallback.revision >= Number.MAX_SAFE_INTEGER ||
    latest.revision !== fallback.revision + 1 || latest.state !== 'finished' ||
    latest.updatedAt < fallback.updatedAt || latest.cleanupAttempts !== 0 ||
    latest.cleanupNotBefore !== latest.updatedAt || latest.resumePhase !== null ||
    latest.revokeReason !== null) return null;
  return latest;
}

function recoveryScanProjection(value, at) {
  const scan = exactOwnData(value, ['version', 'candidates', 'unavailableAuditIds', 'hasUnattributedUnavailable', 'blockingCount']);
  const candidates = scan && denseOwnDataArray(scan.candidates);
  const unavailableAuditIds = scan && denseOwnDataArray(scan.unavailableAuditIds);
  if (!scan || scan.version !== 'PixelRecoveryScanV1' || !candidates || candidates.length > 25 || !unavailableAuditIds || unavailableAuditIds.some(id => typeof id !== 'string' || !AUDIT_ID_PATTERN.test(id)) || new Set(unavailableAuditIds).size !== unavailableAuditIds.length || typeof scan.hasUnattributedUnavailable !== 'boolean' || !Number.isSafeInteger(scan.blockingCount) || scan.blockingCount < 0 || !validEpoch(at)) return null;
  const projectedCandidates = candidates.map(suspensionProjection);
  if (projectedCandidates.some(candidate => candidate === null)) return null;
  if (new Set(projectedCandidates.map(candidate => candidate.auditId)).size !== projectedCandidates.length) return null;
  if (projectedCandidates.some(candidate => candidate.updatedAt > at || candidate.state === 'paused' && candidate.expiresAt > at || ['revoked', 'finished'].includes(candidate.state) && candidate.cleanupNotBefore > at)) return null;
  if (scan.blockingCount < projectedCandidates.filter(candidate => candidate.state === 'resuming').length) return null;
  return Object.freeze({ candidates: Object.freeze(projectedCandidates), blockingCount: scan.blockingCount });
}

function revokeResultProjection(value, candidate, at) {
  const result = exactOwnData(value, ['version', 'status', 'suspension']);
  if (!result || result.version !== 'PixelRevokeResultV1' || !['revoked', 'already-revoked', 'finished', 'missing', 'mismatch'].includes(result.status)) return null;
  if (['missing', 'mismatch'].includes(result.status)) return result.suspension === null ? Object.freeze({ status: result.status, suspension: null }) : null;
  const suspension = suspensionProjection(result.suspension);
  if (!suspension || !validEpoch(at) || suspension.updatedAt > at ||
    !sameImmutableSuspension(suspension, candidate)) return null;
  if (result.status === 'revoked' && !immediateRevocation(candidate, suspension) ||
    result.status === 'already-revoked' && !correlatedAlreadyRevoked(candidate, suspension) ||
    result.status === 'finished' && !terminalFinishAfter(candidate, suspension)) return null;
  return Object.freeze({ status: result.status, suspension });
}

function alarmState(alarms) {
  let state = ALARM_STATES.get(alarms);
  if (!state) {
    state = { tail: Promise.resolve(), startupDone: false, startupPromise: null, highWater: null };
    ALARM_STATES.set(alarms, state);
  }
  return state;
}

function alarmProjection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    const name = Object.getOwnPropertyDescriptor(value, 'name');
    const scheduledTime = Object.getOwnPropertyDescriptor(value, 'scheduledTime');
    if (!name || !scheduledTime || !Object.hasOwn(name, 'value') || !Object.hasOwn(scheduledTime, 'value') || name.value !== PIXEL_CONSENT_ALARM_NAME || !validEpoch(scheduledTime.value)) return null;
    return { name: name.value, scheduledTime: scheduledTime.value };
  } catch { return null; }
}

function timerProjection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 2 || !keys.includes('set') || !keys.includes('clear')) return null;
    const set = Object.getOwnPropertyDescriptor(value, 'set');
    const clear = Object.getOwnPropertyDescriptor(value, 'clear');
    if (!set || !clear || !Object.hasOwn(set, 'value') || !Object.hasOwn(clear, 'value') || typeof set.value !== 'function' || typeof clear.value !== 'function') return null;
    return Object.freeze({ set: set.value.bind(value), clear: clear.value.bind(value) });
  } catch { return null; }
}

export function createPixelConsentExpirySchedulerV1(chromeApi, options) {
  const alarms = chromeApi?.alarms;
  const pixelState = options?.pixelState;
  const liquidator = options?.liquidator;
  const now = options?.now;
  const timer = timerProjection(options?.timer ?? LOCAL_TIMER);
  if (!alarms || typeof alarms.create !== 'function' || typeof alarms.get !== 'function' || typeof alarms.clear !== 'function' || !pixelState || typeof pixelState.listRecoveryCandidates !== 'function' || typeof pixelState.nextExpiresAt !== 'function' || typeof liquidator?.liquidate !== 'function' || typeof now !== 'function' || !timer) throw failure('PIXEL_STATE_UNAVAILABLE');

  const shared = alarmState(alarms);
  const activeLiquidations = new Set();
  let disposed = false;

  const assertActive = () => {
    if (disposed) throw failure('PIXEL_STATE_UNAVAILABLE');
  };
  const serial = operation => {
    if (disposed) return Promise.reject(failure('PIXEL_STATE_UNAVAILABLE'));
    const execute = () => {
      assertActive();
      return operation();
    };
    const result = shared.tail.then(execute, execute);
    shared.tail = result.catch(() => {});
    return result;
  };
  const current = () => {
    let value;
    try { value = now(); } catch { throw failure('PIXEL_STATE_UNAVAILABLE'); }
    if (!validEpoch(value) || shared.highWater !== null && value < shared.highWater) throw failure('PIXEL_STATE_UNAVAILABLE');
    shared.highWater = value;
    return value;
  };
  const alarmWhen = (next, at) => {
    if (next === null) return null;
    if (!validEpoch(next)) throw failure('PIXEL_STATE_UNAVAILABLE');
    const minimumRetry = at + MINIMUM_ALARM_RETRY_MS;
    if (!validEpoch(minimumRetry)) throw failure('PIXEL_STATE_UNAVAILABLE');
    const when = next <= at ? Math.ceil(minimumRetry / MINIMUM_ALARM_RETRY_MS) * MINIMUM_ALARM_RETRY_MS : next;
    if (!validEpoch(when)) throw failure('PIXEL_STATE_UNAVAILABLE');
    return when;
  };
  const readAlarm = async () => {
    let value;
    try { value = await alarms.get(PIXEL_CONSENT_ALARM_NAME); } catch { throw failure('PIXEL_STATE_UNAVAILABLE'); }
    return value;
  };
  const applyAlarm = async when => {
    try {
      if (when === null) await alarms.clear(PIXEL_CONSENT_ALARM_NAME);
      else await alarms.create(PIXEL_CONSENT_ALARM_NAME, { when });
    } catch { /* The read-back below is the commit authority. */ }
  };
  const projectAlarm = value => {
    if (value === undefined) return null;
    const projected = alarmProjection(value);
    if (!projected) throw failure('PIXEL_STATE_UNAVAILABLE');
    return projected;
  };
  const preserveEarlierAlarm = async previous => {
    if (!previous) return;
    const observed = projectAlarm(await readAlarm());
    if (observed && observed.scheduledTime <= previous.scheduledTime) return;
    await applyAlarm(previous.scheduledTime);
    const confirmed = projectAlarm(await readAlarm());
    if (!confirmed || confirmed.scheduledTime > previous.scheduledTime) {
      throw failure('PIXEL_STATE_UNAVAILABLE');
    }
  };
  const schedule = async () => {
    for (let attempt = 0; attempt < MAX_SCHEDULE_RECALCULATIONS; attempt += 1) {
      assertActive();
      current();
      const intendedDeadline = await pixelState.nextExpiresAt();
      assertActive();
      const intended = alarmWhen(intendedDeadline, current());
      const previous = projectAlarm(await readAlarm());
      assertActive();
      await applyAlarm(intended);
      if (disposed) {
        await preserveEarlierAlarm(previous);
        throw failure('PIXEL_STATE_UNAVAILABLE');
      }
      assertActive();

      const afterMutationDeadline = await pixelState.nextExpiresAt();
      assertActive();
      const afterMutation = alarmWhen(afterMutationDeadline, current());
      const observed = await readAlarm();
      assertActive();
      const confirmationDeadline = await pixelState.nextExpiresAt();
      assertActive();
      const confirmedDeadline = alarmWhen(confirmationDeadline, current());

      if (afterMutation !== confirmedDeadline || intended !== confirmedDeadline) continue;
      if (confirmedDeadline === null) {
        if (observed !== undefined) throw failure('PIXEL_STATE_UNAVAILABLE');
        return;
      }
      if (alarmProjection(observed)?.scheduledTime !== confirmedDeadline) throw failure('PIXEL_STATE_UNAVAILABLE');
      return;
    }
    throw failure('PIXEL_STATE_UNAVAILABLE');
  };

  const liquidateWithBudget = confirmed => new Promise(resolve => {
    let settled = false;
    let timeoutHandle;
    let controller;
    const finish = result => {
      if (settled) return;
      settled = true;
      activeLiquidations.delete(cancel);
      if (timeoutHandle !== undefined) {
        try { timer.clear(timeoutHandle); } catch { /* A late callback is inert. */ }
      }
      resolve(result);
    };
    const cancel = () => {
      if (settled) return;
      try { controller?.abort(); } catch { /* Abort is best-effort; denial remains closed. */ }
      finish(false);
    };

    try { controller = new AbortController(); } catch { finish(false); return; }
    activeLiquidations.add(cancel);
    try {
      timeoutHandle = timer.set(cancel, LIQUIDATION_TIMEOUT_MS);
      if (settled) {
        try { timer.clear(timeoutHandle); } catch { /* The timeout already denied work. */ }
        return;
      }
    }
    catch { cancel(); return; }

    Promise.resolve().then(() => liquidator.liquidate({
      auditId: confirmed.auditId,
      consentId: confirmed.consentId,
      reason: confirmed.revokeReason,
      source: confirmed.source,
      signal: controller.signal,
    })).then(value => finish(value === true), () => finish(false));
  });

  const deferConfirmed = async candidate => {
    if (!candidate || !['revoked', 'finished'].includes(candidate.state) || typeof pixelState.deferCleanup !== 'function') return false;
    try {
      return await pixelState.deferCleanup({
        auditId: candidate.auditId,
        consentId: candidate.consentId,
        expectedRevision: candidate.revision,
      }) !== null;
    } catch { return false; }
  };

  const readAndDefer = async (auditId, consentId, fallback) => {
    let latest = fallback;
    if (typeof pixelState.readSuspension === 'function') {
      try {
        const readValue = await pixelState.readSuspension(auditId);
        latest = readValue === null ? null : suspensionProjection(readValue);
      } catch { return false; }
    }
    if (!latest || latest.auditId !== auditId || latest.consentId !== consentId) return false;
    return deferConfirmed(finishRetryCandidate(fallback, latest));
  };

  const finishOnly = async candidate => {
    if (!candidate || typeof pixelState.finish !== 'function') return false;
    try {
      return await pixelState.finish({ auditId: candidate.auditId, consentId: candidate.consentId }) === true;
    } catch {
      return readAndDefer(candidate.auditId, candidate.consentId, candidate);
    }
  };

  const processCandidate = async (candidate, includeResuming) => {
    if (!candidate || typeof candidate !== 'object') return false;
    if (candidate.state === 'resuming' && !includeResuming) return false;
    if (candidate.state === 'finished') return finishOnly(candidate);
    if (!['paused', 'resuming', 'revoked'].includes(candidate.state) || typeof pixelState.revokeAudit !== 'function') return false;

    const reason = candidate.state === 'paused'
      ? 'PIXEL_CONSENT_EXPIRED'
      : candidate.state === 'resuming'
        ? 'PIXEL_RESUME_INTERRUPTED'
        : candidate.revokeReason;
    let revoked;
    try {
      const revokeValue = await pixelState.revokeAudit({ auditId: candidate.auditId, consentId: candidate.consentId, reason });
      revoked = revokeResultProjection(revokeValue, candidate, current());
    } catch { return false; }
    const resumeAuthorityCleared = candidate.state === 'resuming'
      && ['revoked', 'already-revoked', 'finished'].includes(revoked?.status);
    if (revoked?.status === 'finished') {
      const cleanupProgressed = await finishOnly(revoked.suspension);
      return cleanupProgressed || resumeAuthorityCleared;
    }
    if (!['revoked', 'already-revoked'].includes(revoked?.status) || !revoked.suspension) return false;

    const confirmed = revoked.suspension;
    const liquidated = await liquidateWithBudget(confirmed);
    if (!liquidated) {
      const cleanupProgressed = await deferConfirmed(confirmed);
      return cleanupProgressed || resumeAuthorityCleared;
    }
    try {
      const finished = await pixelState.finish({ auditId: confirmed.auditId, consentId: confirmed.consentId });
      return finished === true || resumeAuthorityCleared;
    } catch {
      const cleanupProgressed = await readAndDefer(confirmed.auditId, confirmed.consentId, confirmed);
      return cleanupProgressed || resumeAuthorityCleared;
    }
  };

  const process = async (includeResuming, drainAll) => {
    let previousFingerprint = null;
    for (;;) {
      const scanValue = await pixelState.listRecoveryCandidates({ limit: 25, includeResuming });
      const scan = recoveryScanProjection(scanValue, current());
      if (!scan) throw failure('PIXEL_STATE_UNAVAILABLE');
      const candidates = scan.candidates;
      if (candidates.length === 0) return scan;
      const fingerprint = candidates.map(candidate => `${candidate?.auditId ?? ''}:${candidate?.consentId ?? ''}:${candidate?.revision ?? ''}:${candidate?.state ?? ''}`).join('|');
      if (drainAll && fingerprint === previousFingerprint) return scan;

      let progressed = false;
      for (const candidate of candidates) {
        if (await processCandidate(candidate, includeResuming)) progressed = true;
      }
      if (!drainAll) return scan;
      if (!progressed) return scan;
      previousFingerprint = fingerprint;
      await Promise.resolve();
    }
  };

  const run = trigger => serial(async () => {
    if (!['alarm', 'panel'].includes(trigger)) throw failure('PIXEL_STATE_UNAVAILABLE');
    try { await process(false, false); } finally { await schedule(); }
  });

  const recoverOnStartup = () => {
    if (disposed) return Promise.reject(failure('PIXEL_STATE_UNAVAILABLE'));
    if (shared.startupPromise) return shared.startupPromise;
    const recovery = serial(async () => {
      if (shared.startupDone) return;
      let recoveryFailure = null;
      try {
        const scan = await process(true, true);
        if (scan.blockingCount > 0) throw failure('PIXEL_RECOVERY_PENDING');
      } catch (caught) {
        recoveryFailure = caught;
      }
      try { await schedule(); }
      catch (caught) { if (recoveryFailure === null) recoveryFailure = caught; }
      if (recoveryFailure !== null) throw recoveryFailure;
      shared.startupDone = true;
    });
    shared.startupPromise = recovery;
    void recovery.catch(() => {
      if (!shared.startupDone && shared.startupPromise === recovery) shared.startupPromise = null;
    });
    return recovery;
  };

  return Object.freeze({
    scheduleNext: () => serial(schedule),
    run,
    recoverOnStartup,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const cancel of [...activeLiquidations]) cancel();
    },
  });
}
