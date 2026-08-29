import { isCapturePolicyV1 } from '../core/privacy/capture-policy.js';

const OBSERVED_KEYS = Object.freeze({
  attached: Object.freeze(['version', 'kind', 'tabId', 'windowId', 'documentId', 'urlSessionDigest', 'urlEvidence']),
  disposable: Object.freeze(['version', 'kind', 'ownerId', 'tabId', 'windowId', 'documentId', 'urlSessionDigest', 'urlEvidence']),
});
const OUTCOMES = new Set(['passed', 'failed', 'cantTell', 'inapplicable', 'untested']);

function validId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,160}$/u.test(value);
}

export function isObservedTargetV1(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const expected = OBSERVED_KEYS[value.kind];
  if (!expected) return false;
  let keys;
  try { keys = Reflect.ownKeys(value); } catch { return false; }
  if (keys.length !== expected.length || expected.some(key => !keys.includes(key)) || value.version !== 1 ||
    !Number.isSafeInteger(value.tabId) || value.tabId < 0 ||
    !Number.isSafeInteger(value.windowId) || value.windowId < 0 || !validId(value.documentId) ||
    typeof value.urlSessionDigest !== 'string' || !/^hmac-sha256:[A-Za-z0-9_-]{43}$/u.test(value.urlSessionDigest) ||
    typeof value.urlEvidence !== 'string') return false;
  return value.kind !== 'disposable' || validId(value.ownerId);
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
  const collection = await services.collectObservedPage({ observedTarget, capturePolicy, signal });
  if (signal?.aborted) throw signal.reason ?? new DOMException('Operação cancelada.', 'AbortError');
  const core = await services.runCoreRules({ collection, signal });
  if (!core || !Array.isArray(core.ruleResults)) throw new TypeError('OBSERVED_PIPELINE_DENIED');
  for (const result of core.ruleResults) {
    if (!result || !validId(result.ruleId) || !OUTCOMES.has(result.outcome)) throw new TypeError('OBSERVED_PIPELINE_DENIED');
    await checkpointRecorder.record({ ruleId: result.ruleId, outcome: result.outcome });
  }
  const model = await services.buildAuditModel({ auditId, collection, coreRuleResults: core.ruleResults, capturePolicy, signal });
  await services.persistAuditModel(model);
  return Object.freeze({
    model,
    checkpoint: checkpointRecorder.snapshot(),
    observationState: 'observed',
  });
}
