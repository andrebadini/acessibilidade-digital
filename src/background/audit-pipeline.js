import { isEvidenceUrlV1, sanitizeEvidenceUrlV1 } from '../core/privacy/evidence-url.js';
import { createAuditModel } from '../core/report/audit-model.js';
import { validateExecutionCheckpoint } from './execution-checkpoint.js';
import {
  assertPixelPipelineAuthorizedV1,
  isPixelPipelinePreflightForV1,
  isPixelPrivacyGateV1,
} from './pixel-privacy-gate.js';

const OBSERVED_KEYS = Object.freeze({
  attached: Object.freeze(['version', 'kind', 'tabId', 'windowId', 'documentId', 'urlEvidence', 'urlSessionDigest']),
  'owned-disposable': Object.freeze(['version', 'kind', 'ownershipId', 'tabId', 'windowId', 'documentId', 'urlEvidence', 'urlSessionDigest', 'cleanupMode', 'pageId']),
});
const OUTCOMES = new Set(['passed', 'failed', 'cantTell', 'inapplicable', 'untested']);
const FORBIDDEN = new Set([
  'checkpoint', 'ownerId', 'tabId', 'windowId', 'documentId', 'urlSessionDigest',
  'rawUrl', 'navigationToken', 'sessionCapabilityId',
]);
const PIPELINE_KEYS = Object.freeze(['auditId', 'observedTarget', 'capturePolicy', 'checkpointRecorder', 'signal', 'services', 'beforePersist']);
const SERVICE_KEYS = Object.freeze(['collectObservedPage', 'runCoreRules', 'buildAuditModel', 'persistAuditModel']);
const CHECKPOINT_KEYS = Object.freeze(['started', 'record', 'snapshot']);
const OBSERVED_PIPELINE_RUNNERS = new WeakSet();
const OBSERVED_PIPELINE_GATES = new WeakMap();

function captureExact(value, expected) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== expected.length || keys.some(key => typeof key !== 'string') ||
      expected.some(key => !keys.includes(key))) return null;
    const copy = {};
    for (const key of expected) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      copy[key] = descriptor.value;
    }
    return copy;
  } catch { return null; }
}

function captureCallableBundle(value, keys) {
  const copy = captureExact(value, keys);
  if (!copy || keys.some(key => typeof copy[key] !== 'function')) return null;
  return Object.freeze(Object.fromEntries(keys.map(key => [key, copy[key].bind(value)])));
}

function copyPolicy(value) {
  const copy = captureExact(value, ['version', 'mode', 'includeQuery', 'captureFullPage', 'captureElements', 'composeAnnouncementMap']);
  const expected = {
    'full-evidence': [true, true, true], 'element-only': [false, true, false], 'no-pixels': [false, false, false],
  }[copy?.mode];
  if (!copy || copy.version !== 'CapturePolicyV1' || !expected || typeof copy.includeQuery !== 'boolean' ||
    copy.captureFullPage !== expected[0] || copy.captureElements !== expected[1] || copy.composeAnnouncementMap !== expected[2]) return null;
  return Object.freeze(copy);
}

function validId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,160}$/u.test(value);
}

function projectObservedTarget(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  let prototype;
  let kindDescriptor;
  try {
    prototype = Object.getPrototypeOf(value);
    kindDescriptor = Object.getOwnPropertyDescriptor(value, 'kind');
  } catch { return false; }
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (!kindDescriptor?.enumerable || !Object.hasOwn(kindDescriptor, 'value')) return false;
  const expected = OBSERVED_KEYS[kindDescriptor.value];
  if (!expected) return false;
  let keys;
  try { keys = Reflect.ownKeys(value); } catch { return false; }
  if (keys.length !== expected.length || expected.some(key => !keys.includes(key))) return false;
  const copy = {};
  try {
    for (const key of expected) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return false;
      copy[key] = descriptor.value;
    }
  } catch { return false; }
  if (copy.version !== 'ObservedTargetV1' || !Number.isSafeInteger(copy.tabId) || copy.tabId < 0 ||
    !Number.isSafeInteger(copy.windowId) || copy.windowId < 0 || !validId(copy.documentId) ||
    typeof copy.urlSessionDigest !== 'string' || !/^hmac-sha256:[A-Za-z0-9_-]{43}$/u.test(copy.urlSessionDigest) ||
    !isEvidenceUrlV1(copy.urlEvidence)) return false;
  const evidence = {};
  try {
    for (const key of ['version', 'href', 'queryIncluded', 'redactedSegments']) {
      const descriptor = Object.getOwnPropertyDescriptor(copy.urlEvidence, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return false;
      evidence[key] = descriptor.value;
    }
  } catch { return false; }
  if (copy.kind === 'attached') return Object.freeze({ ...copy, urlEvidence: Object.freeze(evidence) });
  if (!validId(copy.ownershipId) || !['always', 'pre-observation-failure'].includes(copy.cleanupMode) ||
    (copy.pageId !== null && validId(copy.pageId) === false)) return false;
  return Object.freeze({ ...copy, urlEvidence: Object.freeze(evidence) });
}

export function isObservedTargetV1(value) {
  return projectObservedTarget(value) !== false;
}

function sanitizeBoundary(value, seen = new WeakSet()) {
  if (value === null || ['string', 'boolean'].includes(typeof value)) return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('OBSERVED_PIPELINE_DENIED');
    return value;
  }
  if (!value || typeof value !== 'object' || seen.has(value)) throw new TypeError('OBSERVED_PIPELINE_DENIED');
  seen.add(value);
  let keys;
  try { keys = Reflect.ownKeys(value); } catch { throw new TypeError('OBSERVED_PIPELINE_DENIED'); }
  if (keys.some(key => typeof key !== 'string' || FORBIDDEN.has(key))) throw new TypeError('OBSERVED_PIPELINE_DENIED');
  let isArray;
  try { isArray = Array.isArray(value); } catch { throw new TypeError('OBSERVED_PIPELINE_DENIED'); }
  if (isArray) {
    let lengthDescriptor;
    try { lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length'); } catch { throw new TypeError('OBSERVED_PIPELINE_DENIED'); }
    const length = lengthDescriptor?.value;
    if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, 'value') || !Number.isSafeInteger(length) || length < 0) {
      throw new TypeError('OBSERVED_PIPELINE_DENIED');
    }
    const expected = ['length', ...Array.from({ length }, (_v, index) => String(index))];
    const keySet = new Set(keys); // O(n): includes() por índice era quadrático em listas grandes (1.1.53)
    if (keys.length !== expected.length || expected.some(key => !keySet.has(key))) throw new TypeError('OBSERVED_PIPELINE_DENIED');
    return Object.freeze(Array.from({ length }, (_v, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new TypeError('OBSERVED_PIPELINE_DENIED');
      return sanitizeBoundary(descriptor.value, seen);
    }));
  }
  let prototype;
  try { prototype = Object.getPrototypeOf(value); } catch { throw new TypeError('OBSERVED_PIPELINE_DENIED'); }
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError('OBSERVED_PIPELINE_DENIED');
  const copy = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new TypeError('OBSERVED_PIPELINE_DENIED');
    copy[key] = sanitizeBoundary(descriptor.value, seen);
  }
  return Object.freeze(copy);
}

function validateServices(services) {
  return captureCallableBundle(services, SERVICE_KEYS);
}

export function createObservedPipelineRunner(input) {
  const args = captureExact(input, ['checkpointRecorder', 'services']) ??
    captureExact(input, ['checkpointRecorder', 'services', 'privacyGate', 'pixelPreflight']);
  const checkpointRecorder = captureCallableBundle(args?.checkpointRecorder, CHECKPOINT_KEYS);
  const services = validateServices(args?.services);
  const privacyGate = Object.hasOwn(args ?? {}, 'privacyGate') ? args.privacyGate : null;
  const pixelPreflight = Object.hasOwn(args ?? {}, 'pixelPreflight') ? args.pixelPreflight : null;
  if (!checkpointRecorder || !services ||
    (privacyGate === null ? pixelPreflight !== null
      : !isPixelPrivacyGateV1(privacyGate) || !isPixelPipelinePreflightForV1(pixelPreflight, privacyGate))) {
    throw new TypeError('OBSERVED_PIPELINE_DENIED');
  }
  const runner = async pipelineInput => {
    const captured = captureExact(pipelineInput, ['auditId', 'observedTarget', 'capturePolicy', 'signal', 'beforePersist']);
    if (!captured || typeof captured.beforePersist !== 'function') throw new TypeError('OBSERVED_PIPELINE_DENIED');
    return executeObservedAuditPipelineInternal({ ...captured, checkpointRecorder, services }, privacyGate, pixelPreflight);
  };
  Object.freeze(runner);
  OBSERVED_PIPELINE_RUNNERS.add(runner);
  OBSERVED_PIPELINE_GATES.set(runner, privacyGate);
  return runner;
}

export function isObservedPipelineRunner(value) {
  return typeof value === 'function' && OBSERVED_PIPELINE_RUNNERS.has(value);
}

export function isObservedPipelineRunnerForPrivacyGate(value, privacyGate) {
  return isObservedPipelineRunner(value) && OBSERVED_PIPELINE_GATES.get(value) === privacyGate;
}

function canonicalCheckpoint(value, auditId, pageOrder) {
  const safe = sanitizeBoundary(value);
  if (!safe || !Array.isArray(safe.pages) || safe.pages.length === 0) throw new TypeError('OBSERVED_PIPELINE_DENIED');
  try { return validateExecutionCheckpoint({ auditId, checkpoint: safe, pageOrder }); }
  catch { throw new TypeError('OBSERVED_PIPELINE_DENIED'); }
}

function modelMatchesObservedTarget(model, target) {
  try {
    if (model.requestedScope?.mode !== 'single' || !Array.isArray(model.pages) || model.pages.length !== 1) return false;
    const page = model.pages[0];
    if (page.attempted !== true || page.finalUrlObserved !== true || typeof page.finalUrl !== 'string') return false;
    const durableUrls = [model.requestedUrl, model.finalUrl, page.requestedUrl, page.finalUrl];
    const durableEvidence = durableUrls.map(url => typeof url === 'string'
      ? sanitizeEvidenceUrlV1(url, { includeQuery: false }) : null);
    if (durableEvidence.some((evidence, index) => !evidence || durableUrls[index] !== evidence.href)) return false;
    if (target.kind === 'owned-disposable' && target.pageId !== null &&
      (!validId(target.pageId) || page.pageId !== target.pageId)) return false;
    const evidence = durableEvidence[3];
    return evidence.href === target.urlEvidence.href && evidence.queryIncluded === target.urlEvidence.queryIncluded &&
      evidence.redactedSegments === target.urlEvidence.redactedSegments;
  } catch { return false; }
}

export async function executeObservedAuditPipeline(input) {
  return executeObservedAuditPipelineInternal(input, null, null);
}

async function executeObservedAuditPipelineInternal(input, privacyGate, pixelPreflight) {
  const args = captureExact(input, PIPELINE_KEYS);
  if (!args) throw new TypeError('OBSERVED_PIPELINE_DENIED');
  const { auditId, observedTarget, capturePolicy, checkpointRecorder: rawCheckpoint, signal, services: rawServices, beforePersist: rawBeforePersist } = args;
  const safeObservedTarget = projectObservedTarget(observedTarget);
  const checkpointRecorder = captureCallableBundle(rawCheckpoint, CHECKPOINT_KEYS);
  const services = validateServices(rawServices);
  const safePolicy = copyPolicy(capturePolicy);
  const beforePersist = typeof rawBeforePersist === 'function' ? rawBeforePersist : null;
  if (!validId(auditId) || !safeObservedTarget || !safePolicy || safePolicy.includeQuery !== false ||
    (safeObservedTarget.urlEvidence.queryIncluded && !safePolicy.includeQuery) ||
    !checkpointRecorder || !services || !beforePersist ||
    (safePolicy.mode === 'no-pixels' ? privacyGate !== null || pixelPreflight !== null
      : !isPixelPrivacyGateV1(privacyGate) ||
        !isPixelPipelinePreflightForV1(pixelPreflight, privacyGate))) {
    throw new TypeError('OBSERVED_PIPELINE_DENIED');
  }
  const fence = () => {
    if (!signal || typeof signal !== 'object') return;
    try {
      let cursor = signal;
      let descriptor = null;
      while (cursor && !descriptor) {
        descriptor = Object.getOwnPropertyDescriptor(cursor, 'aborted');
        cursor = Object.getPrototypeOf(cursor);
      }
      const aborted = descriptor && Object.hasOwn(descriptor, 'value')
        ? descriptor.value
        : descriptor?.get ? descriptor.get.call(signal) : false;
      if (aborted === true) throw new Error('AUDIT_ABORTED');
    } catch (error) {
      if (error?.message === 'AUDIT_ABORTED') throw error;
      throw new TypeError('OBSERVED_PIPELINE_DENIED');
    }
  };
  fence();
  await checkpointRecorder.started();
  fence();
  if (safePolicy.mode !== 'no-pixels') {
    await pixelPreflight({ auditId, observedTarget: safeObservedTarget, capturePolicy: safePolicy });
    fence();
  }
  const collection = sanitizeBoundary(await services.collectObservedPage({ observedTarget: safeObservedTarget, capturePolicy: safePolicy, signal }));
  fence();
  const core = sanitizeBoundary(await services.runCoreRules({ collection, signal }));
  fence();
  if (!core || !Array.isArray(core.ruleResults)) throw new TypeError('OBSERVED_PIPELINE_DENIED');
  for (const result of core.ruleResults) {
    if (!result || !validId(result.ruleId) || !OUTCOMES.has(result.outcome)) throw new TypeError('OBSERVED_PIPELINE_DENIED');
    await checkpointRecorder.record({ ruleId: result.ruleId, outcome: result.outcome });
    fence();
  }
  const built = sanitizeBoundary(await services.buildAuditModel({ auditId, collection, coreRuleResults: core.ruleResults, capturePolicy: safePolicy, signal }));
  fence();
  let model;
  try { model = createAuditModel(built); } catch { throw new TypeError('OBSERVED_PIPELINE_DENIED'); }
  if (model.auditId !== auditId || !modelMatchesObservedTarget(model, safeObservedTarget)) throw new TypeError('OBSERVED_PIPELINE_DENIED');
  fence();
  const checkpoint = canonicalCheckpoint(await checkpointRecorder.snapshot(), auditId, model.pages.map(page => page.pageId));
  fence();
  const proof = captureExact(await beforePersist(Object.freeze({ observedTarget: safeObservedTarget, signal })),
    ['tabId', 'windowId', 'documentId', 'urlSessionDigest']);
  fence();
  if (!proof || proof.tabId !== safeObservedTarget.tabId || proof.windowId !== safeObservedTarget.windowId ||
    proof.documentId !== safeObservedTarget.documentId || proof.urlSessionDigest !== safeObservedTarget.urlSessionDigest) {
    throw new TypeError('OBSERVED_PIPELINE_DENIED');
  }
  if (safePolicy.mode !== 'no-pixels') {
    assertPixelPipelineAuthorizedV1(privacyGate, { auditId, capturePolicy: safePolicy });
  }
  await services.persistAuditModel(model, Object.freeze({ observedTarget: safeObservedTarget, signal }));
  return Object.freeze({
    model,
    checkpoint,
    status: model.session.status,
    observationState: 'observed',
  });
}
