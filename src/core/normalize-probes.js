import { assertSnapshotV1 } from './snapshot-schema.js';
import { sanitizeJsonData, sanitizeWarnings } from './privacy.js';

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function outcome(value) {
  return value ? 'passed' : 'failed';
}

const REFLOW_EXCEPTIONS = new Set(['essential']);
const MINIMUM_TARGET_EXCEPTIONS = new Set(['equivalent', 'inline', 'user-agent', 'essential', 'spacing']);
const ENHANCED_TARGET_EXCEPTIONS = new Set(['equivalent', 'inline', 'user-agent', 'essential']);
const MAX_PROBE_COLLECTION_ITEMS = 5_000;
const MAX_TARGET_THRESHOLDS = 16;
const MAX_PROBE_RECORD_FIELDS = 32;
const MAX_PROBE_STRING_LENGTH = 4_096;
const FOCUS_EVENT_FIELDS = new Set([
  'backendNodeId', 'nodeId', 'selector', 'frameId',
  'indicatorVisible', 'beforeCss', 'afterCss', 'areaSufficient',
  'intersectionRatio', 'rect',
]);
const FOCUS_CSS_FIELDS = new Set([
  'outline', 'outlineColor', 'outlineOffset', 'outlineStyle', 'outlineWidth', 'boxShadow',
]);
const RECT_FIELDS = new Set(['x', 'y', 'width', 'height']);
const TEXT_RESIZE_FIELDS = new Set(['scalePercent', 'lossOfContent']);
const MOTION_FIELDS = new Set([
  'complete', 'preference', 'prefersReducedMotion', 'animatedCount', 'reducedAnimatedCount',
]);

function ownData(value, field) {
  try {
    if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function denseOwnDataArray(value, maxItems = MAX_PROBE_COLLECTION_ITEMS) {
  try {
    if (!Array.isArray(value)) return { available: false, values: [] };
    const iteratorDescriptor = Object.getOwnPropertyDescriptor(value, Symbol.iterator);
    if (iteratorDescriptor && !Object.hasOwn(iteratorDescriptor, 'value')) {
      return { available: false, values: [] };
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, 'value') ||
      !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0 ||
      lengthDescriptor.value > maxItems) {
      return { available: false, values: [] };
    }
    const values = new Array(lengthDescriptor.value);
    for (let index = 0; index < lengthDescriptor.value; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
        return { available: false, values: [] };
      }
      values[index] = descriptor.value;
    }
    return { available: true, values };
  } catch {
    return { available: false, values: [] };
  }
}

function ownDataRecord(value, allowedFields, { requiredFields = [], maxFields = MAX_PROBE_RECORD_FIELDS } = {}) {
  try {
    if (value === null || typeof value !== 'object') return { available: false, value: null, present: new Set() };
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return { available: false, value: null, present: new Set() };
    const keys = Reflect.ownKeys(value);
    if (keys.length > maxFields || keys.some(key => typeof key !== 'string' || !allowedFields.has(key))) {
      return { available: false, value: null, present: new Set() };
    }
    const output = {};
    const present = new Set();
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
        return { available: false, value: null, present: new Set() };
      }
      output[key] = descriptor.value;
      present.add(key);
    }
    if (requiredFields.some(field => !present.has(field))) {
      return { available: false, value: null, present: new Set() };
    }
    return { available: true, value: output, present };
  } catch {
    return { available: false, value: null, present: new Set() };
  }
}

function boundedString(value) {
  return typeof value === 'string' && value.length <= MAX_PROBE_STRING_LENGTH;
}

function projectFocusCss(value) {
  const projected = ownDataRecord(value, FOCUS_CSS_FIELDS, { maxFields: FOCUS_CSS_FIELDS.size });
  if (!projected.available) return projected;
  for (const item of Object.values(projected.value)) {
    if (typeof item !== 'string' || item.length > MAX_PROBE_STRING_LENGTH) {
      return { available: false, value: null, present: new Set() };
    }
  }
  return projected;
}

function projectRect(value) {
  const projected = ownDataRecord(value, RECT_FIELDS, {
    requiredFields: [...RECT_FIELDS], maxFields: RECT_FIELDS.size,
  });
  if (!projected.available || [...RECT_FIELDS].some(field => !finite(projected.value[field]))) {
    return { available: false, value: null, present: new Set() };
  }
  return projected;
}

function projectFocusEvent(value) {
  const projected = ownDataRecord(value, FOCUS_EVENT_FIELDS, { maxFields: FOCUS_EVENT_FIELDS.size });
  if (!projected.available) return projected;
  const event = projected.value;
  const present = projected.present;
  const hasIdentity = (present.has('backendNodeId') && Number.isSafeInteger(event.backendNodeId) && event.backendNodeId >= 0) ||
    (present.has('nodeId') && (boundedString(event.nodeId) || Number.isSafeInteger(event.nodeId))) ||
    (present.has('selector') && boundedString(event.selector));
  if (!hasIdentity ||
    (present.has('backendNodeId') && (!Number.isSafeInteger(event.backendNodeId) || event.backendNodeId < 0)) ||
    (present.has('nodeId') && !boundedString(event.nodeId) && !Number.isSafeInteger(event.nodeId)) ||
    (present.has('selector') && !boundedString(event.selector)) ||
    (present.has('frameId') && event.frameId !== null && !boundedString(event.frameId) && !Number.isSafeInteger(event.frameId)) ||
    (present.has('indicatorVisible') && typeof event.indicatorVisible !== 'boolean') ||
    (present.has('areaSufficient') && typeof event.areaSufficient !== 'boolean') ||
    (present.has('intersectionRatio') && (!finite(event.intersectionRatio) || event.intersectionRatio < 0 || event.intersectionRatio > 1))) {
    return { available: false, value: null, present: new Set() };
  }
  const hasBeforeCss = present.has('beforeCss');
  const hasAfterCss = present.has('afterCss');
  if (hasBeforeCss !== hasAfterCss) return { available: false, value: null, present: new Set() };
  if (hasBeforeCss) {
    const beforeCss = projectFocusCss(event.beforeCss);
    const afterCss = projectFocusCss(event.afterCss);
    if (!beforeCss.available || !afterCss.available) return { available: false, value: null, present: new Set() };
    event.beforeCss = beforeCss.value;
    event.afterCss = afterCss.value;
  }
  if (present.has('rect')) {
    const rect = projectRect(event.rect);
    if (!rect.available) return { available: false, value: null, present: new Set() };
    event.rect = rect.value;
  }
  return projected;
}

function projectFocusEvents(collection) {
  if (!collection.available) return collection;
  const values = [];
  for (const event of collection.values) {
    const projected = projectFocusEvent(event);
    if (!projected.available) return { available: false, values: [] };
    values.push(projected.value);
  }
  return { available: true, values };
}

function projectTextResize(value) {
  const projected = ownDataRecord(value, TEXT_RESIZE_FIELDS, {
    requiredFields: [...TEXT_RESIZE_FIELDS], maxFields: TEXT_RESIZE_FIELDS.size,
  });
  if (!projected.available || !finite(projected.value.scalePercent) ||
    typeof projected.value.lossOfContent !== 'boolean') {
    return { available: false, value: null, present: new Set() };
  }
  return projected;
}

function projectMotion(value) {
  const projected = ownDataRecord(value, MOTION_FIELDS, {
    requiredFields: ['complete', 'prefersReducedMotion', 'animatedCount', 'reducedAnimatedCount'],
    maxFields: MOTION_FIELDS.size,
  });
  if (!projected.available || typeof projected.value.complete !== 'boolean' ||
    typeof projected.value.prefersReducedMotion !== 'boolean' ||
    !Number.isSafeInteger(projected.value.animatedCount) || projected.value.animatedCount < 0 ||
    !Number.isSafeInteger(projected.value.reducedAnimatedCount) || projected.value.reducedAnimatedCount < 0 ||
    (projected.present.has('preference') && projected.value.preference !== 'reduce')) {
    return { available: false, value: null, present: new Set() };
  }
  return projected;
}

function normalizedException(observation, allowed) {
  const observed = ownData(observation, 'exception');
  const value = typeof observed === 'string' ? observed : 'unknown';
  if (value === 'none') return ownData(observation, 'exceptionProof') === 'complete' ? 'none' : 'unknown';
  return allowed.has(value) ? value : 'unknown';
}

const probeFallbacks = new WeakMap();

function selectorFrameKey(selector, frameId) {
  const normalizedSelector = typeof selector === 'string' ? selector.trim() : '';
  if (!normalizedSelector) return null;
  const normalizedFrameId = frameId == null ? '' : String(frameId).trim();
  return `selector\u0000${normalizedFrameId}\u0000${normalizedSelector}`;
}

function createProbeIdentity() {
  const idsBySource = new Map();
  const fallbacksById = new Map();
  let next = 1;
  return {
    safeId(event) {
      const backendNodeId = ownData(event, 'backendNodeId');
      if (Number.isSafeInteger(backendNodeId) && backendNodeId >= 0) return `n-${backendNodeId}`;
      const rawNodeId = ownData(event, 'nodeId');
      const nodeId = typeof rawNodeId === 'string' ? rawNodeId.trim() : '';
      if (/^(?:document|n-(?:(?:0|[1-9]\d*)|d(?:0|[1-9]\d*)-(?:0|[1-9]\d*)|fixture-[1-9]\d*))$/u.test(nodeId)) return nodeId;
      const fallback = selectorFrameKey(ownData(event, 'selector'), ownData(event, 'frameId'));
      const source = fallback || (nodeId ? `node\u0000${nodeId}` : Number.isSafeInteger(rawNodeId) ? `node\u0000${rawNodeId}` : '');
      if (!source) return null;
      if (!idsBySource.has(source)) idsBySource.set(source, `probe-${next++}`);
      const id = idsBySource.get(source);
      if (fallback) fallbacksById.set(id, fallback);
      return id;
    },
    fallbacksById
  };
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function changedCss(before, after) {
  if (!before || typeof before !== 'object' || !after || typeof after !== 'object') return null;
  const keys = unique([...Object.keys(before), ...Object.keys(after)]).sort();
  if (keys.length === 0) return false;
  return keys.some(key => String(before[key] ?? '') !== String(after[key] ?? ''));
}

function jsonData(value, fallback) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
}

const ACTION_TYPES = new Set(['guard-navigation', 'key', 'viewport', 'text-resize', 'measure-targets', 'motion', 'restore']);

function sanitizeAction(action) {
  const observedType = ownData(action, 'type');
  const type = ACTION_TYPES.has(observedType) ? observedType : 'probe';
  const key = ownData(action, 'key');
  const index = ownData(action, 'index');
  const widthCssPx = ownData(action, 'widthCssPx');
  const scalePercent = ownData(action, 'scalePercent');
  const thresholds = denseOwnDataArray(ownData(action, 'thresholdsCssPx'), MAX_TARGET_THRESHOLDS);
  const operation = ownData(action, 'operation');
  const target = ownData(action, 'target');
  const preference = ownData(action, 'preference');
  return {
    type,
    ...(type === 'key' && key === 'Tab' ? { key: 'Tab' } : {}),
    ...(type === 'key' && Number.isSafeInteger(index) ? { index } : {}),
    ...(type === 'viewport' && finite(widthCssPx) ? { widthCssPx } : {}),
    ...(type === 'text-resize' && finite(scalePercent) ? { scalePercent } : {}),
    ...(type === 'measure-targets' && thresholds.available ? { thresholdsCssPx: thresholds.values.filter(finite) } : {}),
    ...(type === 'guard-navigation' && operation === 'install' ? { operation: 'install' } : {}),
    ...(type === 'restore' && ['listeners', 'styles', 'viewport', 'scroll', 'focus'].includes(target) ? { target } : {}),
    ...(type === 'motion' && preference === 'reduce' ? { preference: 'reduce' } : {})
  };
}

/** Converts raw probe events to a JSON-safe conservative tri-state contract. */
export function normalizeProbes(raw = {}) {
  const identity = createProbeIdentity();
  const safeId = identity.safeId;
  const focus = ownData(raw, 'focus');
  const focusCollection = projectFocusEvents(denseOwnDataArray(ownData(focus, 'events')));
  const focusEvents = focusCollection.values;
  const focusIds = focusEvents.map(safeId).filter(Boolean);
  const observedFocusableCount = ownData(focus, 'focusableCount');
  const focusableCount = focusCollection.available && Number.isSafeInteger(observedFocusableCount) &&
    observedFocusableCount >= 0 ? observedFocusableCount : null;
  const focusComplete = focusCollection.available && focusableCount !== null && ownData(focus, 'completed') === true;
  const repeated = [];
  for (let index = 1; index < focusIds.length; index += 1) {
    if (focusIds[index] === focusIds[index - 1]) repeated.push(focusIds[index]);
  }

  const appearanceObservations = focusEvents.map(event => ({
    nodeId: safeId(event),
    visible: typeof event.indicatorVisible === 'boolean' ? event.indicatorVisible : changedCss(event.beforeCss, event.afterCss),
    beforeCss: jsonData(event.beforeCss, null),
    afterCss: jsonData(event.afterCss, null),
    areaSufficient: typeof event.areaSufficient === 'boolean' ? event.areaSufficient : null
  })).filter(item => item.nodeId);
  const knownAppearance = appearanceObservations.filter(item => typeof item.visible === 'boolean');
  const appearanceFailures = unique(knownAppearance.filter(item => !item.visible).map(item => item.nodeId));

  const visibilityObservations = focusEvents.map(event => ({
    nodeId: safeId(event),
    intersectionRatio: finite(event.intersectionRatio) ? event.intersectionRatio : null,
    rect: event.rect && ['x', 'y', 'width', 'height'].every(key => finite(event.rect[key])) ? {
      x: event.rect.x, y: event.rect.y, width: event.rect.width, height: event.rect.height
    } : null
  })).filter(item => item.nodeId);
  const knownVisibility = visibilityObservations.filter(item => item.intersectionRatio !== null);
  const obscured = unique(knownVisibility.filter(item => item.intersectionRatio < 1).map(item => item.nodeId));

  const reflow = ownData(raw, 'reflow');
  const reflowWidth = ownData(reflow, 'testedWidthCssPx');
  const horizontalOverflow = ownData(reflow, 'horizontalOverflow');
  const reflowValid = finite(reflowWidth) && reflowWidth > 0 && reflowWidth <= 320 &&
    typeof horizontalOverflow === 'boolean';
  const reflowException = normalizedException(reflow, REFLOW_EXCEPTIONS);
  const textResizeProjection = projectTextResize(ownData(raw, 'textResize'));
  const textResize = textResizeProjection.value;
  const resizeValid = textResizeProjection.available && textResize.scalePercent >= 200;

  const rawTargetSizes = ownData(raw, 'targetSizes');
  const targetSizes = denseOwnDataArray(rawTargetSizes).values;
  const targetObservations = [];
  for (const item of targetSizes) {
    const nodeId = safeId(item);
    const width = ownData(item, 'width');
    const height = ownData(item, 'height');
    if (!nodeId || !finite(width) || width < 0 || !finite(height) || height < 0) continue;
    targetObservations.push({
      nodeId, width, height,
      exception: normalizedException(item, MINIMUM_TARGET_EXCEPTIONS),
      minimum24: width >= 24 && height >= 24,
      enhanced44: width >= 44 && height >= 44,
    });
  }
  const minimumFailures = targetObservations.filter(item => !item.minimum24 && item.exception === 'none').map(item => item.nodeId);
  const enhancedFailures = targetObservations.filter(item => !item.enhanced44 && item.exception === 'none').map(item => item.nodeId);
  const minimumUnknown = targetObservations.some(item => !item.minimum24 && item.exception === 'unknown');
  const enhancedUnknown = targetObservations.some(item => !item.enhanced44 &&
    normalizedException({ exception: item.exception, exceptionProof: 'complete' }, ENHANCED_TARGET_EXCEPTIONS) === 'unknown');

  const motionProjection = projectMotion(ownData(raw, 'motion'));
  const motion = motionProjection.value;
  const reducedPreferenceExecuted = motionProjection.available && (motion.prefersReducedMotion === true ||
    (motion.prefersReducedMotion === undefined && motion.preference === 'reduce'));
  const motionValid = motionProjection.available && motion.complete === true && reducedPreferenceExecuted;
  const motionFailed = motionValid && motion.prefersReducedMotion && motion.reducedAnimatedCount > 0;

  const normalized = {
    focusOrder: {
      outcome: focusComplete ? 'passed' : 'cantTell',
      targets: focusIds,
      focusableCount
    },
    keyboardTraps: {
      outcome: repeated.length ? 'failed' : focusComplete ? 'passed' : 'cantTell',
      targets: unique(repeated)
    },
    focusAppearance: {
      outcome: appearanceFailures.length ? 'failed' : focusComplete && knownAppearance.length === focusEvents.length ? 'passed' : 'cantTell',
      targets: appearanceFailures,
      observations: appearanceObservations
    },
    obscuredTargets: {
      outcome: obscured.length ? 'failed' : focusComplete && knownVisibility.length === focusEvents.length ? 'passed' : 'cantTell',
      targets: obscured,
      observations: visibilityObservations
    },
    reflow: {
      outcome: reflowValid
        ? (!horizontalOverflow ? 'passed' : reflowException === 'none' ? 'failed' : 'cantTell')
        : 'cantTell',
      testedWidthCssPx: reflowValid ? reflowWidth : null,
      horizontalOverflow: reflowValid ? horizontalOverflow : null,
      exception: reflowException
    },
    textResize: {
      outcome: 'cantTell',
      scalePercent: resizeValid ? textResize.scalePercent : null,
      lossOfContent: resizeValid ? textResize.lossOfContent : null
    },
    targetSizes: {
      minimum24: { outcome: minimumFailures.length ? 'failed' : targetObservations.length && !minimumUnknown ? 'passed' : 'cantTell', failedNodeIds: unique(minimumFailures) },
      enhanced44: { outcome: enhancedFailures.length ? 'failed' : targetObservations.length && !enhancedUnknown ? 'passed' : 'cantTell', failedNodeIds: unique(enhancedFailures) },
      observations: targetObservations
    },
    motion: {
      outcome: motionValid ? outcome(!motionFailed) : 'cantTell',
      prefersReducedMotion: motionValid ? motion.prefersReducedMotion : null,
      animatedCount: motionValid ? motion.animatedCount : null,
      reducedAnimatedCount: motionValid ? motion.reducedAnimatedCount : null
    },
    warnings: sanitizeWarnings(denseOwnDataArray(ownData(raw, 'warnings')).values),
    actions: sanitizeJsonData(denseOwnDataArray(ownData(raw, 'actions')).values.map(sanitizeAction))
  };
  normalized.probeCoverage = Object.fromEntries([
    'focusOrder', 'keyboardTraps', 'focusAppearance', 'obscuredTargets', 'reflow', 'textResize', 'motion'
  ].map(key => [key, normalized[key].outcome === 'cantTell' ? 'cantTell' : 'complete']));
  normalized.probeCoverage.targetSizes = [normalized.targetSizes.minimum24, normalized.targetSizes.enhanced44]
    .some(item => item.outcome === 'cantTell') ? 'cantTell' : 'complete';
  probeFallbacks.set(normalized, identity.fallbacksById);
  return normalized;
}

/** Merges normalized observations without mutating the public snapshot. */
export function mergeProbesIntoSnapshot(snapshot, probes) {
  assertSnapshotV1(snapshot);
  const normalized = probes && probes.focusOrder && probes.targetSizes ? probes : normalizeProbes(probes);
  const runtimeOutcome = snapshot.document?.coverage?.runtime?.outcome;
  const runtimeIncomplete = typeof runtimeOutcome === 'string' && runtimeOutcome !== 'complete';
  const probeCoverage = { ...(normalized.probeCoverage || {}) };
  if (runtimeIncomplete) {
    for (const key of ['focusOrder', 'keyboardTraps', 'focusAppearance', 'obscuredTargets', 'reflow', 'textResize', 'targetSizes', 'motion']) probeCoverage[key] = 'cantTell';
  }
  const focusById = new Map();
  for (const item of normalized.focusAppearance.observations || []) focusById.set(String(item.nodeId), { appearance: item });
  for (const item of normalized.obscuredTargets.observations || []) {
    const current = focusById.get(String(item.nodeId)) || {};
    current.visibility = item;
    focusById.set(String(item.nodeId), current);
  }
  const targetById = new Map((normalized.targetSizes.observations || []).map(item => [String(item.nodeId), item]));
  const fallbackByProbeId = probeFallbacks.get(normalized) || new Map();
  const nodesByFallback = new Map();
  for (const node of snapshot.nodes) {
    const fallback = selectorFrameKey(node.selectorHint, node.frameId);
    if (!fallback) continue;
    const nodes = nodesByFallback.get(fallback) || [];
    nodes.push(node);
    nodesByFallback.set(fallback, nodes);
  }
  const observationsById = new Map();
  for (const observation of normalized.targetSizes.observations || []) {
    const fallback = fallbackByProbeId.get(String(observation.nodeId));
    if (!fallback) continue;
    const observations = observationsById.get(fallback) || [];
    observations.push(observation);
    observationsById.set(fallback, observations);
  }
  for (const [fallback, nodes] of nodesByFallback) {
    const observations = observationsById.get(fallback) || [];
    if (nodes.length === 1 && observations.length === 1 && !targetById.has(String(nodes[0].nodeId))) {
      targetById.set(String(nodes[0].nodeId), observations[0]);
    }
  }

  const nodes = snapshot.nodes.map(node => {
    const focus = probeCoverage.focusAppearance === 'complete' || probeCoverage.obscuredTargets === 'complete'
      ? focusById.get(String(node.nodeId)) : null;
    const target = probeCoverage.targetSizes === 'complete' ? targetById.get(String(node.nodeId)) : null;
    const focusObservation = {};
    if (probeCoverage.focusAppearance === 'complete' && typeof focus?.appearance?.visible === 'boolean') focusObservation.indicatorVisible = focus.appearance.visible;
    if (probeCoverage.obscuredTargets === 'complete' && finite(focus?.visibility?.intersectionRatio)) {
      focusObservation.fullyVisible = focus.visibility.intersectionRatio >= 1;
      focusObservation.partiallyVisible = focus.visibility.intersectionRatio > 0;
    }
    if (probeCoverage.focusAppearance === 'complete' && typeof focus?.appearance?.areaSufficient === 'boolean') focusObservation.areaSufficient = focus.appearance.areaSufficient;
    return {
      ...node,
      attributes: { ...node.attributes },
      children: [...node.children],
      ...(focus ? { focusObservation } : {}),
      ...(target ? { targetSize: { width: target.width, height: target.height, exception: target.exception } } : {})
    };
  });
  return assertSnapshotV1({
    schemaVersion: 1,
    document: {
      ...snapshot.document,
      probeCoverage,
      reflowObservation: probeCoverage.reflow === 'cantTell' || normalized.reflow.outcome === 'cantTell' ? null : {
        testedWidthCssPx: normalized.reflow.testedWidthCssPx,
        twoDimensionalScroll: normalized.reflow.horizontalOverflow,
        exception: normalized.reflow.exception
      },
      textResizeObservation: probeCoverage.textResize === 'cantTell' || normalized.textResize.outcome === 'cantTell' ? null : {
        scalePercent: normalized.textResize.scalePercent,
        lossOfContent: normalized.textResize.lossOfContent
      },
      dynamicProbes: normalized
    },
    nodes
  });
}
