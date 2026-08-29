import { isCapturePolicyV1 } from '../core/privacy/capture-policy.js';
import { createAuditModel } from '../core/report/audit-model.js';

const OBSERVED_KEYS = Object.freeze({
  attached: Object.freeze(['version', 'kind', 'tabId', 'windowId', 'documentId', 'urlSessionDigest', 'urlEvidence']),
  disposable: Object.freeze(['version', 'kind', 'ownerId', 'tabId', 'windowId', 'documentId', 'urlSessionDigest', 'urlEvidence']),
});
const OUTCOMES = new Set(['passed', 'failed', 'cantTell', 'inapplicable', 'untested']);
const FORBIDDEN = new Set([
  'checkpoint', 'ownerId', 'tabId', 'windowId', 'documentId', 'urlSessionDigest',
  'rawUrl', 'navigationToken', 'sessionCapabilityId', 'inventory', 'inventoryHash',
]);

function validId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,160}$/u.test(value);
}

export function isObservedTargetV1(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const kindDescriptor = Object.getOwnPropertyDescriptor(value, 'kind');
  if (!kindDescriptor?.enumerable || !Object.hasOwn(kindDescriptor, 'value')) return false;
  const expected = OBSERVED_KEYS[kindDescriptor.value];
  if (!expected) return false;
  let keys;
  try { keys = Reflect.ownKeys(value); } catch { return false; }
  if (keys.length !== expected.length || expected.some(key => !keys.includes(key))) return false;
  const copy = {};
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return false;
    copy[key] = descriptor.value;
  }
  if (copy.version !== 1 || !Number.isSafeInteger(copy.tabId) || copy.tabId < 0 ||
    !Number.isSafeInteger(copy.windowId) || copy.windowId < 0 || !validId(copy.documentId) ||
    typeof copy.urlSessionDigest !== 'string' || !/^hmac-sha256:[A-Za-z0-9_-]{43}$/u.test(copy.urlSessionDigest) ||
    typeof copy.urlEvidence !== 'string') return false;
  return copy.kind !== 'disposable' || validId(copy.ownerId);
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
  if (Array.isArray(value)) {
    const expected = ['length', ...Array.from({ length: value.length }, (_v, index) => String(index))];
    if (keys.length !== expected.length || expected.some(key => !keys.includes(key))) throw new TypeError('OBSERVED_PIPELINE_DENIED');
    return Object.freeze(Array.from({ length: value.length }, (_v, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new TypeError('OBSERVED_PIPELINE_DENIED');
      return sanitizeBoundary(descriptor.value, seen);
    }));
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new TypeError('OBSERVED_PIPELINE_DENIED');
  }
  const copy = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new TypeError('OBSERVED_PIPELINE_DENIED');
    copy[key] = sanitizeBoundary(descriptor.value, seen);
  }
  return Object.freeze(copy);
}

function validateServices(services) {
  return services && typeof services === 'object' &&
    ['collectObservedPage', 'runCoreRules', 'buildAuditModel', 'persistAuditModel']
      .every(name => typeof services[name] === 'function');
}

export async function executeObservedAuditPipeline({
  auditId,
  observedTarget,
  capturePolicy,
  checkpointRecorder,
  signal,
  services,
}) {
  if (!validId(auditId) || !isObservedTargetV1(observedTarget) || !isCapturePolicyV1(capturePolicy) ||
    !checkpointRecorder || typeof checkpointRecorder.started !== 'function' ||
    typeof checkpointRecorder.record !== 'function' || typeof checkpointRecorder.snapshot !== 'function' ||
    !validateServices(services)) throw new TypeError('OBSERVED_PIPELINE_DENIED');
  if (signal?.aborted) throw signal.reason ?? new DOMException('Operação cancelada.', 'AbortError');
  await checkpointRecorder.started();
  const collection = sanitizeBoundary(await services.collectObservedPage({ observedTarget, capturePolicy, signal }));
  if (signal?.aborted) throw signal.reason ?? new DOMException('Operação cancelada.', 'AbortError');
  const core = sanitizeBoundary(await services.runCoreRules({ collection, signal }));
  if (!core || !Array.isArray(core.ruleResults)) throw new TypeError('OBSERVED_PIPELINE_DENIED');
  for (const result of core.ruleResults) {
    if (!result || !validId(result.ruleId) || !OUTCOMES.has(result.outcome)) throw new TypeError('OBSERVED_PIPELINE_DENIED');
    await checkpointRecorder.record({ ruleId: result.ruleId, outcome: result.outcome });
  }
  const built = sanitizeBoundary(await services.buildAuditModel({ auditId, collection, coreRuleResults: core.ruleResults, capturePolicy, signal }));
  let model;
  try { model = createAuditModel(built); } catch { throw new TypeError('OBSERVED_PIPELINE_DENIED'); }
  if (model.auditId !== auditId) throw new TypeError('OBSERVED_PIPELINE_DENIED');
  await services.persistAuditModel(model);
  return Object.freeze({
    model,
    checkpoint: checkpointRecorder.snapshot(),
    observationState: 'observed',
  });
}
