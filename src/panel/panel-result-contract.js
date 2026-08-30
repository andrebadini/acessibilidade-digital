const GROUP_CLASSIFICATIONS = Object.freeze({
  failed: 'failed',
  alerts: 'alert',
  humanReview: 'manual-review',
  passed: 'passed',
});

const RESULT_CONTEXTS = new Set([
  'page-or-process',
  'top-document',
  'same-origin-frame',
  'open-shadow-root',
  'mixed',
]);

function denyClassification() {
  throw new TypeError('RESULT_CLASSIFICATION_DENIED');
}

function denyContext() {
  throw new TypeError('RESULT_CONTEXT_DENIED');
}

export function classifyPanelResultV1(groupName) {
  if (typeof groupName !== 'string' || !Object.hasOwn(GROUP_CLASSIFICATIONS, groupName)) denyClassification();
  return GROUP_CLASSIFICATIONS[groupName];
}

function canonicalArray(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) denyContext();
  const keys = Reflect.ownKeys(value);
  const expected = ['length', ...Array.from({ length: value.length }, (_value, index) => String(index))];
  if (keys.length !== expected.length || expected.some(key => !keys.includes(key))) denyContext();
  return Array.from({ length: value.length }, (_value, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) denyContext();
    return descriptor.value;
  });
}

function ownData(record, key) {
  if (!record || typeof record !== 'object') denyContext();
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) denyContext();
  return descriptor.value;
}

function evidenceLookup(evidenceById, evidenceId) {
  if (!(evidenceById instanceof Map)) denyContext();
  return evidenceById.get(evidenceId);
}

function contextForOccurrence(occurrence, evidenceById) {
  const target = ownData(occurrence, 'target');
  const nodeId = ownData(target, 'nodeId');
  const targetSelector = ownData(target, 'selector');
  const targetFramePath = canonicalArray(ownData(target, 'framePath'));
  const evidenceRefs = canonicalArray(ownData(occurrence, 'evidenceRefs'));
  let selector = typeof targetSelector === 'string' && targetSelector ? targetSelector : null;
  let framePath = targetFramePath;

  for (const evidenceId of evidenceRefs) {
    if (typeof evidenceId !== 'string') denyContext();
    const evidence = evidenceLookup(evidenceById, evidenceId);
    if (!evidence || typeof evidence !== 'object') denyContext();
    const evidenceNodeDescriptor = Object.getOwnPropertyDescriptor(evidence, 'nodeId');
    const evidenceNode = evidenceNodeDescriptor && Object.hasOwn(evidenceNodeDescriptor, 'value')
      ? evidenceNodeDescriptor.value
      : null;
    if (evidenceNode !== null && evidenceNode !== undefined && evidenceNode !== nodeId) continue;
    const selectorDescriptor = Object.getOwnPropertyDescriptor(evidence, 'selector');
    if (!selectorDescriptor || !Object.hasOwn(selectorDescriptor, 'value') || selectorDescriptor.value === undefined) continue;
    const evidenceSelector = selectorDescriptor.value;
    const cssDescriptor = evidenceSelector && Object.getOwnPropertyDescriptor(evidenceSelector, 'css');
    const css = cssDescriptor && Object.hasOwn(cssDescriptor, 'value') ? cssDescriptor.value : null;
    const frameDescriptor = evidenceSelector && Object.getOwnPropertyDescriptor(evidenceSelector, 'framePath');
    const frames = frameDescriptor && Object.hasOwn(frameDescriptor, 'value')
      ? canonicalArray(frameDescriptor.value)
      : [];
    if (selector && typeof css === 'string' && css && selector !== css) denyContext();
    if (framePath.length > 0 && frames.length > 0 && JSON.stringify(framePath) !== JSON.stringify(frames)) denyContext();
    if (!selector && typeof css === 'string' && css) selector = css;
    if (framePath.length === 0 && frames.length > 0) framePath = frames;
  }

  if ((nodeId === null || nodeId === undefined) && !selector) return 'page-or-process';
  if (typeof selector === 'string' && selector.includes(' >>> ')) return 'open-shadow-root';
  if (framePath.length > 0) return 'same-origin-frame';
  return 'top-document';
}

export function deriveResultContextV1({ occurrences, evidenceById }) {
  try {
    const copiedOccurrences = canonicalArray(occurrences);
    if (copiedOccurrences.length === 0) return 'page-or-process';
    const contexts = new Set(copiedOccurrences.map(occurrence => contextForOccurrence(occurrence, evidenceById)));
    const result = contexts.size === 1 ? [...contexts][0] : 'mixed';
    if (!RESULT_CONTEXTS.has(result)) denyContext();
    return result;
  } catch (error) {
    if (error instanceof TypeError && error.message === 'RESULT_CONTEXT_DENIED') throw error;
    denyContext();
  }
}

export function assertPanelClassificationV1(groupName, classification, displayOutcome) {
  const expected = classifyPanelResultV1(groupName);
  const expectedOutcome = groupName === 'humanReview' ? 'cantTell'
    : groupName === 'passed' ? 'passed'
      : 'failed';
  if (classification !== expected || displayOutcome !== expectedOutcome) denyClassification();
  return expected;
}
