import { isCapturePolicyV1 } from '../core/privacy/capture-policy.js';
import { isEvidenceUrlV1 } from '../core/privacy/evidence-url.js';
import {
  isPixelCommitClockV1,
  readPixelCommitEpochV1,
} from './pixel-commit-clock.js';

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
const RASTER_BOUNDARIES = new WeakMap();
const RASTER_INTERRUPTION = new WeakSet();
const NATIVE_ABORTED = typeof globalThis.AbortSignal === 'function'
  ? Object.getOwnPropertyDescriptor(globalThis.AbortSignal.prototype, 'aborted')?.get
  : null;
const NATIVE_REFLECT_APPLY = Reflect.apply;

function denied() { return new TypeError('PIXEL_PRIVACY_GATE_DENIED'); }
function rasterDenied() {
  const error = new TypeError('PIXEL_CAPTURE_BOUNDARY_DENIED');
  RASTER_INTERRUPTION.add(error);
  return error;
}

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
  const attached = exact(value, [
    'version', 'kind', 'tabId', 'windowId', 'documentId', 'urlEvidence', 'urlSessionDigest',
  ]);
  const owned = exact(value, [
    'version', 'kind', 'ownershipId', 'tabId', 'windowId', 'documentId',
    'urlEvidence', 'urlSessionDigest', 'cleanupMode', 'pageId',
  ]);
  const copy = attached?.kind === 'attached'
    ? attached
    : owned?.kind === 'owned-disposable' ? owned : null;
  const evidence = copy && copyEvidence(copy.urlEvidence);
  if (!copy || copy.version !== 'ObservedTargetV1' ||
    !validInteger(copy.tabId) || !validInteger(copy.windowId) || !validId(copy.documentId) ||
    !DIGEST.test(copy.urlSessionDigest) || !evidence || evidence.queryIncluded !== false) return null;
  if (copy.kind === 'owned-disposable' && (!validId(copy.ownershipId) ||
    !['always', 'pre-observation-failure'].includes(copy.cleanupMode) ||
    (copy.pageId !== null && !validId(copy.pageId)))) return null;
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

function signalsWithinAuthorization(value, authorizedCategories) {
  const signals = copySignals(value);
  if (!signals || !Array.isArray(authorizedCategories) ||
    signals.categories.some(category => !authorizedCategories.includes(category))) throw rasterDenied();
  return signals;
}

function copyProof(value, target) {
  const copy = exact(value, ['tabId', 'windowId', 'documentId', 'urlSessionDigest']);
  if (!copy || copy.tabId !== target.tabId || copy.windowId !== target.windowId ||
    copy.documentId !== target.documentId || copy.urlSessionDigest !== target.urlSessionDigest) return null;
  return target.kind === 'owned-disposable'
    ? Object.freeze({
        kind: 'owned-disposable', ownershipId: target.ownershipId, ...copy,
        cleanupMode: target.cleanupMode, pageId: target.pageId,
      })
    : Object.freeze({ kind: 'attached', ...copy });
}

function captureProof(value) {
  const copy = exact(value, ['tabId', 'windowId', 'documentId', 'urlSessionDigest']);
  return copy && validInteger(copy.tabId) && validInteger(copy.windowId) && validId(copy.documentId) &&
    typeof copy.urlSessionDigest === 'string' && DIGEST.test(copy.urlSessionDigest)
    ? Object.freeze(copy) : null;
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
    left.urlEvidence.redactedSegments === right.urlEvidence.redactedSegments &&
    (left.kind !== 'owned-disposable' ||
      (left.ownershipId === right.ownershipId && left.cleanupMode === right.cleanupMode &&
        left.pageId === right.pageId));
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

function copySource(value) {
  const attached = exact(value, ['kind']);
  if (attached?.kind === 'attached') return Object.freeze(attached);
  const owned = exact(value, ['kind', 'ownershipId', 'cleanupMode', 'pageId']);
  if (!owned || owned.kind !== 'owned-disposable' || !validId(owned.ownershipId) ||
    !['always', 'pre-observation-failure'].includes(owned.cleanupMode) ||
    (owned.pageId !== null && !validId(owned.pageId))) return null;
  return Object.freeze(owned);
}

function sourceMatchesTarget(source, target) {
  return source.kind === target.kind && (source.kind !== 'owned-disposable' ||
    (source.ownershipId === target.ownershipId && source.cleanupMode === target.cleanupMode &&
      source.pageId === target.pageId));
}

function copySuspension(value) {
  const copy = exact(value, SUSPENSION_KEYS);
  const policy = copy && copyPolicy(copy.capturePolicy);
  const evidence = copy && copyEvidence(copy.urlEvidence);
  const categories = copy && copyCategories(copy.categories);
  const source = copy && copySource(copy.source);
  return copy && policy && evidence && categories && source
    ? Object.freeze({ ...copy, capturePolicy: policy, urlEvidence: evidence, categories, source })
    : null;
}

function validSuspension(copy, expected, expectedState, expectedPhase, authorityExpiresAt) {
  return Boolean(copy && copy.version === 'AuditSuspensionV1' && Number.isSafeInteger(copy.revision) && copy.revision > 0 &&
    copy.auditId === expected.auditId && CONSENT_ID.test(copy.consentId) &&
    copy.tabId === expected.target.tabId && copy.windowId === expected.target.windowId &&
    copy.documentId === expected.target.documentId && copy.urlSessionDigest === expected.target.urlSessionDigest &&
    copy.urlEvidence.href === expected.target.urlEvidence.href &&
    copy.urlEvidence.queryIncluded === expected.target.urlEvidence.queryIncluded &&
    copy.urlEvidence.redactedSegments === expected.target.urlEvidence.redactedSegments &&
    copy.mode === expected.policy.mode && samePolicy(copy.capturePolicy, expected.policy) &&
    copy.categories.length === expected.signals.categories.length &&
    copy.categories.every((category, index) => category === expected.signals.categories[index]) &&
    validInteger(copy.issuedAt) && validInteger(copy.updatedAt) && validInteger(copy.expiresAt) &&
    copy.updatedAt >= copy.issuedAt && copy.expiresAt > copy.updatedAt && copy.expiresAt <= authorityExpiresAt &&
    validInteger(copy.cleanupAttempts) && (copy.cleanupNotBefore === null || validInteger(copy.cleanupNotBefore)) &&
    copy.state === expectedState && copy.resumePhase === expectedPhase && copy.revokeReason === null &&
    sourceMatchesTarget(copy.source, expected.target));
}

function validRunnerResult(value, expected, metadata) {
  const copy = exact(value, ['version', 'status', 'suspension']);
  if (!copy || copy.version !== 'PixelRunnerGateResultV1' || !['ready', 'repaused'].includes(copy.status)) return null;
  const state = copy.status === 'ready' ? 'resuming' : 'paused';
  const phase = copy.status === 'ready' ? 'runner-started' : null;
  const suspension = copySuspension(copy.suspension);
  if (!suspension || copy.status === 'ready' && suspension.consentId !== metadata.consentId ||
    copy.status === 'repaused' && suspension.consentId === metadata.consentId) return null;
  return validSuspension(suspension, expected, state, phase, metadata.authorityExpiresAt)
    ? Object.freeze({ status: copy.status, updatedAt: suspension.updatedAt, expiresAt: suspension.expiresAt })
    : null;
}

function epoch(metadata) {
  let value;
  try { value = readPixelCommitEpochV1(metadata.commitClock); } catch { throw denied(); }
  if (!validInteger(value) || value < metadata.highWater) throw denied();
  metadata.highWater = value;
  return value;
}

function promoteSuspensionTime(metadata, suspension) {
  if (!suspension || suspension.updatedAt < metadata.highWater) throw denied();
  metadata.highWater = suspension.updatedAt;
  return suspension;
}

function nativeAbortFence(signal) {
  if (signal === undefined) return;
  if (typeof NATIVE_ABORTED !== 'function') throw rasterDenied();
  let aborted;
  try { aborted = NATIVE_ABORTED.call(signal); } catch { throw rasterDenied(); }
  if (aborted === true) throw rasterDenied();
}

function targetProof(value, metadata) {
  const proof = captureProof(value);
  if (!proof) throw rasterDenied();
  if (proof.tabId !== metadata.target.tabId || proof.windowId !== metadata.target.windowId ||
    proof.documentId !== metadata.target.documentId ||
    proof.urlSessionDigest !== metadata.target.urlSessionDigest) {
    metadata.targetChanged = true;
    throw rasterDenied();
  }
  return proof;
}

function commitFirstRaster(metadata, rawProof) {
  targetProof(rawProof, metadata);
  const gate = metadata.gateMetadata;
  let committedAt;
  try { committedAt = epoch(gate); } catch { gate.state = 'cleanup-eligible'; throw rasterDenied(); }
  if (metadata.state !== 'authorizing' || gate.state !== 'ready' ||
    !validInteger(gate.commitExpiresAt) || committedAt >= gate.commitExpiresAt) {
    gate.state = 'cleanup-eligible';
    throw rasterDenied();
  }
  try { nativeAbortFence(metadata.signal); } catch {
    gate.state = 'cleanup-eligible';
    throw rasterDenied();
  }
  metadata.state = 'raster-in-flight';
  metadata.pixelStarted = true;
  gate.state = 'committed';
}

function commitLaterRaster(metadata, rawProof) {
  targetProof(rawProof, metadata);
  nativeAbortFence(metadata.signal);
  if (metadata.state !== 'later-authorizing' || metadata.gateMetadata.state !== 'committed') {
    throw rasterDenied();
  }
  metadata.state = 'raster-in-flight';
}

function settleWithoutRaster(metadata) {
  const gate = metadata.gateMetadata;
  const elementOnly = metadata.policy.mode === 'element-only' && !metadata.policy.captureFullPage &&
    metadata.policy.captureElements;
  if (metadata.state === 'settled-without-raster' && gate.state === 'no-raster-settled') {
    if (!elementOnly || metadata.pixelStarted || metadata.targetChanged) throw rasterDenied();
    return;
  }
  const initialAttempt = metadata.state === 'fresh' && gate.state === 'armed' && gate.consentId === null;
  const resumedAttempt = metadata.state === 'authorizing' && gate.state === 'ready' && gate.consentId !== null;
  if ((!initialAttempt && !resumedAttempt) || !elementOnly) throw rasterDenied();
  metadata.state = 'settled-without-raster';
  gate.state = 'no-raster-settled';
}

export function createPixelPrivacyGateV1(input) {
  // O gancho da tentativa direta é OPCIONAL: só o caminho anexado o passa; as demais construções do portão
  // (URL, lote, retomada) mantêm exatamente as cinco chaves de antes.
  const args = exact(input, ['pixelState', 'consentId', 'authorityExpiresAt', 'commitClock', 'afterPixels']) ??
    exact(input, ['pixelState', 'consentId', 'authorityExpiresAt', 'commitClock', 'afterPixels', 'onArmedDirect']);
  const pause = args && callable(args.pixelState, 'pause');
  const gateRunnerStart = args && callable(args.pixelState, 'gateRunnerStart');
  if (!args || !pause || !gateRunnerStart ||
    (args.consentId !== null && (typeof args.consentId !== 'string' || !CONSENT_ID.test(args.consentId))) ||
    !validInteger(args.authorityExpiresAt) || !isPixelCommitClockV1(args.commitClock) ||
    typeof args.afterPixels !== 'function' ||
    (Object.hasOwn(args, 'onArmedDirect') && typeof args.onArmedDirect !== 'function')) throw denied();
  const metadata = {
    auditId: null, target: null, policy: null, state: 'created', pipelineConsumed: false,
    consentId: args.consentId, authorityExpiresAt: args.authorityExpiresAt,
    commitExpiresAt: null, highWater: -1, commitClock: args.commitClock,
    pause, gateRunnerStart, afterPixels: args.afterPixels, onArmedDirect: args.onArmedDirect ?? null,
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
        const canonicalSuspension = copySuspension(suspension);
        if (!validSuspension(
          canonicalSuspension, captured, 'paused', null, metadata.authorityExpiresAt,
        )) {
          metadata.state = 'failed';
          throw denied();
        }
        promoteSuspensionTime(metadata, canonicalSuspension);
        metadata.state = 'paused';
        return Object.freeze({ status: 'privacy-paused', signals: captured.signals });
      }
      // Sem sinal sensível não há pausa: a captura segue. O gancho prepara o companheiro durável da
      // tentativa DIRETA antes de qualquer raster — é o que a guarda D2 exige no commit terminal.
      if (metadata.consentId === null && metadata.onArmedDirect !== null) {
        try { await metadata.onArmedDirect({ auditId: captured.auditId, target: captured.target, policy: captured.policy }); }
        catch { metadata.state = 'failed'; throw denied(); }
      }
      metadata.state = 'armed';
      return Object.freeze({ status: 'armed' });
    },
    authorizeFirstPixel: async request => {
      if (metadata.state !== 'armed') throw denied();
      const captured = context(request, metadata, true);
      metadata.state = 'authorizing';
      let authorizationAt;
      try { authorizationAt = epoch(metadata); } catch { metadata.state = 'cleanup-eligible'; throw denied(); }
      if (authorizationAt >= metadata.authorityExpiresAt) {
        metadata.state = 'cleanup-eligible';
        throw denied();
      }
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
          const canonicalSuspension = copySuspension(suspension);
          if (!validSuspension(
            canonicalSuspension, captured, 'paused', null, metadata.authorityExpiresAt,
          )) {
            metadata.state = 'cleanup-eligible';
            throw denied();
          }
          try { promoteSuspensionTime(metadata, canonicalSuspension); }
          catch { metadata.state = 'cleanup-eligible'; throw denied(); }
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
        const result = validRunnerResult(rawResult, captured, metadata);
        if (!result) {
          metadata.state = 'cleanup-eligible';
          throw denied();
        }
        try { promoteSuspensionTime(metadata, result); }
        catch { metadata.state = 'cleanup-eligible'; throw denied(); }
        if (result.status === 'repaused') {
          metadata.state = 'paused';
          return Object.freeze({ status: 'privacy-paused', signals: captured.signals });
        }
        metadata.commitExpiresAt = result.expiresAt;
      }
      if (metadata.consentId === null) metadata.commitExpiresAt = metadata.authorityExpiresAt;
      metadata.state = 'ready';
      return Object.freeze({ status: 'ready' });
    },
    afterPixels: async request => {
      const captured = exact(request, ['auditId', 'pixelStarted']);
      if (!captured || captured.auditId !== metadata.auditId || typeof captured.pixelStarted !== 'boolean') throw denied();
      const factualPixelStarted = metadata.state === 'committed';
      if (captured.pixelStarted !== factualPixelStarted) throw denied();
      if (metadata.state === 'paused') return Object.freeze({ status: 'paused' });
      if (!['armed', 'ready', 'committed', 'no-raster-settled', 'cleanup-eligible'].includes(metadata.state)) throw denied();
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

export function createPixelRasterBoundaryV1(input) {
  const args = exact(input, [
    'auditId', 'observedTarget', 'capturePolicy', 'privacyGate',
    'probeDocumentIdentity', 'probeSensitiveCaptureSignals', 'signal',
    'captureFullPage', 'captureElement',
  ]);
  const gateMetadata = args && GATES.get(args.privacyGate);
  const target = args && copyTarget(args.observedTarget);
  const policy = args && copyPolicy(args.capturePolicy);
  if (!args || !gateMetadata || !target || !policy || !validId(args.auditId) ||
    args.auditId !== gateMetadata.auditId || !sameTarget(target, gateMetadata.target) ||
    !samePolicy(policy, gateMetadata.policy) || gateMetadata.state !== 'armed' ||
    typeof args.probeDocumentIdentity !== 'function' ||
    typeof args.probeSensitiveCaptureSignals !== 'function' ||
    (args.signal !== undefined && (() => {
      try { return typeof NATIVE_ABORTED !== 'function' || typeof NATIVE_ABORTED.call(args.signal) !== 'boolean'; }
      catch { return true; }
    })()) ||
    (policy.captureFullPage ? typeof args.captureFullPage !== 'function' : args.captureFullPage !== null) ||
    (policy.captureElements ? typeof args.captureElement !== 'function' : args.captureElement !== null)) {
    throw denied();
  }
  const metadata = {
    auditId: args.auditId,
    target,
    policy,
    gate: args.privacyGate,
    gateMetadata,
    probeDocumentIdentity: args.probeDocumentIdentity,
    probeSensitiveCaptureSignals: args.probeSensitiveCaptureSignals,
    signal: args.signal,
    captureFullPage: args.captureFullPage,
    captureElement: args.captureElement,
    state: 'fresh',
    pixelStarted: false,
    targetChanged: false,
    authorizedCategories: null,
  };

  const runRaster = async (effect, effectArgs) => {
    if (metadata.state === 'fresh') {
      metadata.state = 'authorizing';
      try {
        const signals = copySignals(await metadata.probeSensitiveCaptureSignals(
          metadata.target.tabId,
          metadata.target.documentId,
        ));
        if (!signals) throw rasterDenied();
        const gateProof = targetProof(
          await metadata.probeDocumentIdentity(metadata.target.tabId),
          metadata,
        );
        const decision = await metadata.gate.authorizeFirstPixel({
          auditId: metadata.auditId,
          observedTarget: metadata.target,
          capturePolicy: metadata.policy,
          proof: gateProof,
          signals,
        });
        if (decision.status === 'privacy-paused') {
          metadata.state = 'paused';
          throw createPixelPrivacyPauseInterruptionV1(metadata.gate, decision.signals);
        }
        if (decision.status !== 'ready') throw rasterDenied();
        metadata.authorizedCategories = signals.categories;
        signalsWithinAuthorization(
          await metadata.probeSensitiveCaptureSignals(metadata.target.tabId, metadata.target.documentId),
          metadata.authorizedCategories,
        );
        const finalProof = await metadata.probeDocumentIdentity(metadata.target.tabId);
        let raster;
        commitFirstRaster(metadata, finalProof);
        raster = NATIVE_REFLECT_APPLY(effect, undefined, effectArgs);
        const result = await raster;
        metadata.state = 'active';
        return result;
      } catch (error) {
        if (isPixelPrivacyPauseInterruptionV1(error, metadata.gate)) throw error;
        if (RASTER_INTERRUPTION.has(error)) {
          if (metadata.state !== 'paused' && metadata.state !== 'failed') metadata.state = 'failed';
          throw error;
        }
        if (metadata.state !== 'paused' && metadata.state !== 'failed') metadata.state = 'failed';
        throw rasterDenied();
      }
    }
    if (metadata.state !== 'active') throw rasterDenied();
    metadata.state = 'later-authorizing';
    try {
      signalsWithinAuthorization(
        await metadata.probeSensitiveCaptureSignals(metadata.target.tabId, metadata.target.documentId),
        metadata.authorizedCategories,
      );
      const proof = await metadata.probeDocumentIdentity(metadata.target.tabId);
      let raster;
      commitLaterRaster(metadata, proof);
      raster = NATIVE_REFLECT_APPLY(effect, undefined, effectArgs);
      const result = await raster;
      metadata.state = 'active';
      return result;
    } catch (error) {
      if (RASTER_INTERRUPTION.has(error)) {
        metadata.state = 'failed';
        throw error;
      }
      metadata.state = 'failed';
      throw rasterDenied();
    }
  };

  const boundary = Object.freeze({
    captureFullPage(...effectArgs) {
      if (RASTER_BOUNDARIES.get(this) !== metadata ||
        !metadata.policy.captureFullPage || typeof metadata.captureFullPage !== 'function') {
        return Promise.reject(rasterDenied());
      }
      return runRaster(metadata.captureFullPage, effectArgs);
    },
    captureElement(...effectArgs) {
      if (RASTER_BOUNDARIES.get(this) !== metadata ||
        !metadata.policy.captureElements || typeof metadata.captureElement !== 'function') {
        return Promise.reject(rasterDenied());
      }
      return runRaster(metadata.captureElement, effectArgs);
    },
    async settle() {
      if (RASTER_BOUNDARIES.get(this) !== metadata) throw rasterDenied();
      if (metadata.state === 'fresh' && metadata.gateMetadata.consentId !== null) {
        metadata.state = 'authorizing';
        try {
          const signals = copySignals(await metadata.probeSensitiveCaptureSignals(
            metadata.target.tabId,
            metadata.target.documentId,
          ));
          if (!signals) throw rasterDenied();
          const proof = targetProof(
            await metadata.probeDocumentIdentity(metadata.target.tabId),
            metadata,
          );
          const decision = await metadata.gate.authorizeFirstPixel({
            auditId: metadata.auditId,
            observedTarget: metadata.target,
            capturePolicy: metadata.policy,
            proof,
            signals,
          });
          if (decision.status === 'privacy-paused') {
            metadata.state = 'paused';
            throw createPixelPrivacyPauseInterruptionV1(metadata.gate, decision.signals);
          }
          if (decision.status !== 'ready') throw rasterDenied();
        } catch (error) {
          if (isPixelPrivacyPauseInterruptionV1(error, metadata.gate)) throw error;
          if (metadata.state !== 'paused' && metadata.state !== 'failed') metadata.state = 'failed';
          if (RASTER_INTERRUPTION.has(error)) throw error;
          throw rasterDenied();
        }
      }
      settleWithoutRaster(metadata);
    },
  });
  RASTER_BOUNDARIES.set(boundary, metadata);
  return boundary;
}

export function isPixelRasterBoundaryV1(value) {
  return typeof value === 'object' && value !== null && RASTER_BOUNDARIES.has(value);
}

export function isPixelRasterBoundaryInterruptionV1(error) {
  return Boolean(error && typeof error === 'object' && RASTER_INTERRUPTION.has(error));
}

export function didPixelRasterStartV1(value) {
  return RASTER_BOUNDARIES.get(value)?.pixelStarted === true;
}

export function didPixelRasterTargetChangeV1(value) {
  return RASTER_BOUNDARIES.get(value)?.targetChanged === true;
}

export function settleRefusedPixelRasterV1(value) {
  const metadata = value && typeof value === 'object' ? RASTER_BOUNDARIES.get(value) : null;
  const gate = metadata?.gateMetadata;
  if (!metadata || metadata.state !== 'failed' || metadata.pixelStarted || metadata.targetChanged ||
    !['armed', 'ready'].includes(gate?.state)) throw rasterDenied();
  try { nativeAbortFence(metadata.signal); }
  catch { throw rasterDenied(); }
  metadata.state = 'settled-without-raster';
  gate.state = 'no-raster-settled';
  return true;
}

export function assertPixelPipelineAuthorizedV1(gate, input) {
  const metadata = gate && typeof gate === 'object' ? GATES.get(gate) : null;
  const captured = exact(input, ['auditId', 'capturePolicy']);
  const policy = captured && copyPolicy(captured.capturePolicy);
  const committed = metadata?.state === 'committed';
  const settledWithoutRaster = metadata?.state === 'no-raster-settled';
  if (!metadata || !captured || !policy || captured.auditId !== metadata.auditId ||
    !samePolicy(policy, metadata.policy) ||
    (!committed && !settledWithoutRaster) || metadata.pipelineConsumed) throw denied();
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
