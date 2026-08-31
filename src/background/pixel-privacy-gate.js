import { isCapturePolicyV1 } from '../core/privacy/capture-policy.js';
import { isEvidenceUrlV1 } from '../core/privacy/evidence-url.js';

const ID = /^[A-Za-z0-9._:-]{1,160}$/u;
const CONSENT_ID = /^[A-Za-z0-9_-]{21}[AQgw]$/u;
const DIGEST = /^hmac-sha256:[A-Za-z0-9_-]{43}$/u;
const CATEGORIES = Object.freeze(['password', 'otp', 'payment', 'private-marker']);
const SUSPENSION_KEYS = Object.freeze([
  'version', 'revision', 'auditId', 'consentId', 'tabId', 'windowId', 'documentId',
  'urlEvidence', 'urlSessionDigest', 'mode', 'capturePolicy', 'categories', 'issuedAt',
  'updatedAt', 'expiresAt', 'cleanupAttempts', 'cleanupNotBefore', 'state',
  'resumePhase', 'revokeReason', 'source',
]);
const GATES = new WeakMap();
const PAUSE_INTERRUPTION = new WeakMap();
const PIPELINE_PREFLIGHTS = new WeakMap();

function denied() { return new TypeError('PIXEL_PRIVACY_GATE_DENIED'); }

function exact(value, keys) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== keys.length || ownKeys.some(key => typeof key !== 'string') ||
      keys.some(key => !ownKeys.includes(key))) return null;
    const copy = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      copy[key] = descriptor.value;
    }
    return copy;
  } catch { return null; }
}

function callable(value, key) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable && Object.hasOwn(descriptor, 'value') &&
      typeof descriptor.value === 'function' ? descriptor.value.bind(value) : null;
  } catch { return null; }
}

function validInteger(value) { return Number.isSafeInteger(value) && value >= 0; }
function validId(value) { return typeof value === 'string' && ID.test(value); }

function copyPolicy(value) {
  const copy = exact(value, [
    'version', 'mode', 'includeQuery', 'captureFullPage', 'captureElements', 'composeAnnouncementMap',
  ]);
  if (!copy || !isCapturePolicyV1(copy) || copy.includeQuery !== false || copy.mode === 'no-pixels') return null;
  return Object.freeze(copy);
}

function copyEvidence(value) {
  const copy = exact(value, ['version', 'href', 'queryIncluded', 'redactedSegments']);
  return copy && isEvidenceUrlV1(copy) ? Object.freeze(copy) : null;
}

function copyTarget(value) {
  const copy = exact(value, [
    'version', 'kind', 'tabId', 'windowId', 'documentId', 'urlEvidence', 'urlSessionDigest',
  ]);
  const evidence = copy && copyEvidence(copy.urlEvidence);
  if (!copy || copy.version !== 'ObservedTargetV1' || copy.kind !== 'attached' ||
    !validInteger(copy.tabId) || !validInteger(copy.windowId) || !validId(copy.documentId) ||
    !DIGEST.test(copy.urlSessionDigest) || !evidence || evidence.queryIncluded !== false) return null;
  return Object.freeze({ ...copy, urlEvidence: evidence });
}

function copyCategories(value) {
  let categories;
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
    const ownKeys = Reflect.ownKeys(value);
    const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
    if (!Number.isSafeInteger(length) || length < 0 || length > CATEGORIES.length ||
      ownKeys.length !== length + 1 || !ownKeys.includes('length')) return null;
    categories = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      categories.push(descriptor.value);
    }
  } catch { return null; }
  const canonical = CATEGORIES.filter(category => categories.includes(category));
  if (categories.length !== canonical.length || categories.some((category, index) => category !== canonical[index])) return null;
  return Object.freeze(categories);
}

function copySignals(value) {
  const copy = exact(value, ['version', 'detected', 'categories']);
  const categories = copy && copyCategories(copy.categories);
  if (!copy || copy.version !== 'SensitiveCaptureSignalsV1' || typeof copy.detected !== 'boolean' ||
    !categories || copy.detected !== (categories.length > 0)) return null;
  return Object.freeze({ version: copy.version, detected: copy.detected, categories: Object.freeze(categories) });
}

function copyProof(value, target) {
  const copy = exact(value, ['tabId', 'windowId', 'documentId', 'urlSessionDigest']);
  if (!copy || copy.tabId !== target.tabId || copy.windowId !== target.windowId ||
    copy.documentId !== target.documentId || copy.urlSessionDigest !== target.urlSessionDigest) return null;
  return Object.freeze({ kind: 'attached', ...copy });
}

function samePolicy(left, right) {
  return left.mode === right.mode && left.includeQuery === right.includeQuery &&
    left.captureFullPage === right.captureFullPage && left.captureElements === right.captureElements &&
    left.composeAnnouncementMap === right.composeAnnouncementMap;
}

function sameTarget(left, right) {
  return left.kind === right.kind && left.tabId === right.tabId && left.windowId === right.windowId &&
    left.documentId === right.documentId && left.urlSessionDigest === right.urlSessionDigest &&
    left.urlEvidence.href === right.urlEvidence.href &&
    left.urlEvidence.queryIncluded === right.urlEvidence.queryIncluded &&
    left.urlEvidence.redactedSegments === right.urlEvidence.redactedSegments;
}

function context(input, metadata, withProof = false) {
  const keys = withProof
    ? ['auditId', 'observedTarget', 'capturePolicy', 'proof', 'signals']
    : ['auditId', 'observedTarget', 'capturePolicy', 'signals'];
  const copy = exact(input, keys);
  const target = copy && copyTarget(copy.observedTarget);
  const policy = copy && copyPolicy(copy.capturePolicy);
  const signals = copy && copySignals(copy.signals);
  if (!copy || !validId(copy.auditId) || !target || !policy || !signals) throw denied();
  if (metadata.auditId !== null && (copy.auditId !== metadata.auditId ||
    !sameTarget(target, metadata.target) || !samePolicy(policy, metadata.policy))) throw denied();
  const proof = withProof ? copyProof(copy.proof, target) : null;
  if (withProof && !proof) throw denied();
  return { auditId: copy.auditId, target, policy, proof, signals };
}

function validSource(value) {
  const copy = exact(value, ['kind']);
  return copy?.kind === 'attached';
}

function validSuspension(value, expected, expectedState, expectedPhase, authorityExpiresAt) {
  const copy = exact(value, SUSPENSION_KEYS);
  const policy = copy && copyPolicy(copy.capturePolicy);
  const evidence = copy && copyEvidence(copy.urlEvidence);
  const categories = copy && copyCategories(copy.categories);
  return Boolean(copy && copy.version === 'AuditSuspensionV1' && Number.isSafeInteger(copy.revision) && copy.revision > 0 &&
    copy.auditId === expected.auditId && CONSENT_ID.test(copy.consentId) &&
    copy.tabId === expected.target.tabId && copy.windowId === expected.target.windowId &&
    copy.documentId === expected.target.documentId && copy.urlSessionDigest === expected.target.urlSessionDigest &&
    evidence && evidence.href === expected.target.urlEvidence.href &&
    evidence.queryIncluded === expected.target.urlEvidence.queryIncluded &&
    evidence.redactedSegments === expected.target.urlEvidence.redactedSegments &&
    copy.mode === expected.policy.mode && policy && samePolicy(policy, expected.policy) && categories &&
    categories.length === expected.signals.categories.length &&
    categories.every((category, index) => category === expected.signals.categories[index]) &&
    validInteger(copy.issuedAt) && validInteger(copy.updatedAt) && validInteger(copy.expiresAt) &&
    copy.updatedAt >= copy.issuedAt && copy.expiresAt > copy.updatedAt && copy.expiresAt <= authorityExpiresAt &&
    validInteger(copy.cleanupAttempts) && (copy.cleanupNotBefore === null || validInteger(copy.cleanupNotBefore)) &&
    copy.state === expectedState && copy.resumePhase === expectedPhase && copy.revokeReason === null &&
    validSource(copy.source));
}

function validRunnerResult(value, expected, metadata) {
  const copy = exact(value, ['version', 'status', 'suspension']);
  if (!copy || copy.version !== 'PixelRunnerGateResultV1' || !['ready', 'repaused'].includes(copy.status)) return null;
  const state = copy.status === 'ready' ? 'resuming' : 'paused';
  const phase = copy.status === 'ready' ? 'runner-started' : null;
  const suspension = exact(copy.suspension, SUSPENSION_KEYS);
  if (!suspension || copy.status === 'ready' && suspension.consentId !== metadata.consentId ||
    copy.status === 'repaused' && suspension.consentId === metadata.consentId) return null;
  return validSuspension(copy.suspension, expected, state, phase, metadata.authorityExpiresAt) ? copy.status : null;
}

export function createPixelPrivacyGateV1(input) {
  const args = exact(input, ['pixelState', 'consentId', 'authorityExpiresAt', 'afterPixels']);
  const pause = args && callable(args.pixelState, 'pause');
  const gateRunnerStart = args && callable(args.pixelState, 'gateRunnerStart');
  if (!args || !pause || !gateRunnerStart ||
    (args.consentId !== null && (typeof args.consentId !== 'string' || !CONSENT_ID.test(args.consentId))) ||
    !validInteger(args.authorityExpiresAt) || typeof args.afterPixels !== 'function') throw denied();
  const metadata = {
    auditId: null, target: null, policy: null, state: 'created', pipelineConsumed: false,
    consentId: args.consentId, authorityExpiresAt: args.authorityExpiresAt,
    pause, gateRunnerStart, afterPixels: args.afterPixels,
  };
  const gate = Object.freeze({
    preflight: async request => {
      if (metadata.state !== 'created') throw denied();
      const captured = context(request, metadata);
      metadata.auditId = captured.auditId; metadata.target = captured.target; metadata.policy = captured.policy;
      metadata.state = 'preflighting';
      if (metadata.consentId === null && captured.signals.detected) {
        let suspension;
        try {
          suspension = await metadata.pause({
            auditId: captured.auditId, observedTarget: captured.target, mode: captured.policy.mode,
            capturePolicy: captured.policy, categories: captured.signals.categories,
            authorityExpiresAt: metadata.authorityExpiresAt,
          });
        } catch { metadata.state = 'failed'; throw denied(); }
        if (!validSuspension(suspension, captured, 'paused', null, metadata.authorityExpiresAt)) {
          metadata.state = 'failed';
          throw denied();
        }
        metadata.state = 'paused';
        return Object.freeze({ status: 'privacy-paused', signals: captured.signals });
      }
      metadata.state = 'armed';
      return Object.freeze({ status: 'armed' });
    },
    authorizeFirstPixel: async request => {
      if (metadata.state !== 'armed') throw denied();
      const captured = context(request, metadata, true);
      metadata.state = 'authorizing';
      if (metadata.consentId === null) {
        if (captured.signals.detected) {
          let suspension;
          try {
            suspension = await metadata.pause({
              auditId: captured.auditId, observedTarget: captured.target, mode: captured.policy.mode,
              capturePolicy: captured.policy, categories: captured.signals.categories,
              authorityExpiresAt: metadata.authorityExpiresAt,
            });
          } catch { metadata.state = 'cleanup-eligible'; throw denied(); }
          if (!validSuspension(suspension, captured, 'paused', null, metadata.authorityExpiresAt)) {
            metadata.state = 'cleanup-eligible';
            throw denied();
          }
          metadata.state = 'paused';
          return Object.freeze({ status: 'privacy-paused', signals: captured.signals });
        }
      } else {
        let rawResult;
        try {
          rawResult = await metadata.gateRunnerStart({
            auditId: captured.auditId, consentId: metadata.consentId,
            proof: captured.proof, categories: captured.signals.categories,
          });
        } catch { metadata.state = 'cleanup-eligible'; throw denied(); }
        const status = validRunnerResult(rawResult, captured, metadata);
        if (!status) {
          metadata.state = 'cleanup-eligible';
          throw denied();
        }
        if (status === 'repaused') {
          metadata.state = 'paused';
          return Object.freeze({ status: 'privacy-paused', signals: captured.signals });
        }
      }
      metadata.state = 'authorized';
      return Object.freeze({ status: 'ready' });
    },
    afterPixels: async request => {
      const captured = exact(request, ['auditId', 'pixelStarted']);
      if (!captured || captured.auditId !== metadata.auditId || typeof captured.pixelStarted !== 'boolean') throw denied();
      if (metadata.state === 'paused') return Object.freeze({ status: 'paused' });
      if (!['armed', 'authorized', 'cleanup-eligible'].includes(metadata.state)) throw denied();
      metadata.state = 'settled';
      try { await metadata.afterPixels(); } catch { throw denied(); }
      return Object.freeze({ status: 'settled' });
    },
  });
  GATES.set(gate, metadata);
  return gate;
}

export function isPixelPrivacyGateV1(value) {
  return typeof value === 'object' && value !== null && GATES.has(value);
}

export function assertPixelPipelineAuthorizedV1(gate, input) {
  const metadata = gate && typeof gate === 'object' ? GATES.get(gate) : null;
  const captured = exact(input, ['auditId', 'capturePolicy']);
  const policy = captured && copyPolicy(captured.capturePolicy);
  if (!metadata || !captured || !policy || captured.auditId !== metadata.auditId ||
    !samePolicy(policy, metadata.policy) || metadata.state !== 'authorized' || metadata.pipelineConsumed) throw denied();
  metadata.pipelineConsumed = true;
  return true;
}

export function createPixelPipelinePreflightV1(gate, input) {
  const metadata = gate && typeof gate === 'object' ? GATES.get(gate) : null;
  const args = exact(input, ['probeSensitiveCaptureSignals']);
  const probe = args && callable(args, 'probeSensitiveCaptureSignals');
  if (!metadata || !probe || metadata.state !== 'created') throw denied();
  const preflight = async request => {
    const captured = exact(request, ['auditId', 'observedTarget', 'capturePolicy']);
    const target = captured && copyTarget(captured.observedTarget);
    const policy = captured && copyPolicy(captured.capturePolicy);
    if (!captured || !validId(captured.auditId) || !target || !policy || metadata.state !== 'created') throw denied();
    const signals = copySignals(await probe(target));
    if (!signals) throw denied();
    const result = await gate.preflight({ auditId: captured.auditId, observedTarget: target, capturePolicy: policy, signals });
    if (result.status === 'privacy-paused') throw createPixelPrivacyPauseInterruptionV1(gate, result.signals);
    return result;
  };
  Object.freeze(preflight);
  PIPELINE_PREFLIGHTS.set(preflight, gate);
  return preflight;
}

export function isPixelPipelinePreflightForV1(value, gate) {
  return typeof value === 'function' && PIPELINE_PREFLIGHTS.get(value) === gate;
}

export function createPixelPrivacyPauseInterruptionV1(gate, signals) {
  const metadata = gate && typeof gate === 'object' ? GATES.get(gate) : null;
  const safeSignals = copySignals(signals);
  if (!metadata || metadata.state !== 'paused' || !safeSignals) throw denied();
  const error = denied();
  PAUSE_INTERRUPTION.set(error, Object.freeze({ gate, auditId: metadata.auditId, signals: safeSignals }));
  return error;
}

export function isPixelPrivacyPauseInterruptionV1(error, gate) {
  const interruption = error && typeof error === 'object' ? PAUSE_INTERRUPTION.get(error) : null;
  return Boolean(interruption && interruption.gate === gate);
}

export function readPixelPrivacyPauseInterruptionV1(error, gate) {
  const interruption = error && typeof error === 'object' ? PAUSE_INTERRUPTION.get(error) : null;
  return interruption?.gate === gate ? interruption.signals : null;
}
