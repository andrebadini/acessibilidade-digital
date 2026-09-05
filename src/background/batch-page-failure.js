import { isEvidenceUrlV1 } from '../core/privacy/evidence-url.js';

const KEYS = Object.freeze(['version', 'kind', 'attempted', 'startedAt', 'endedAt', 'urlEvidence']);

// A failed attempt contains facts about execution, never an invented audit model.
export function copyBatchPageFailure(value, checkpointPage, expectedUrl = null) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length !== KEYS.length || keys.some(key => !KEYS.includes(key))) return null;
    const copy = {};
    for (const key of KEYS) {
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      copy[key] = descriptor.value;
    }
    const validTime = time => typeof time === 'string' &&
      Number.isFinite(Date.parse(time)) && new Date(time).toISOString() === time;
    if (copy.version !== 1 || copy.kind !== 'pre-observation-failure' || copy.attempted !== true ||
      !validTime(copy.startedAt) || !validTime(copy.endedAt) || copy.endedAt < copy.startedAt ||
      !isEvidenceUrlV1(copy.urlEvidence) || copy.urlEvidence.queryIncluded !== false ||
      checkpointPage?.attempted !== true || checkpointPage.startedAt !== copy.startedAt ||
      checkpointPage.outcomes.length !== 0 ||
      expectedUrl !== null && copy.urlEvidence.href !== expectedUrl.href) return null;
    return Object.freeze({ ...copy, urlEvidence: Object.freeze({ ...copy.urlEvidence }) });
  } catch { return null; }
}
