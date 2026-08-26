import { assertSnapshotV1 } from './snapshot-schema.js';
import { redactSensitiveText, sanitizeJsonData, sanitizeWarnings } from './privacy.js';

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function outcome(value) {
  return value ? 'passed' : 'failed';
}

function safeId(event) {
  if (typeof event?.nodeId === 'string' && event.nodeId.trim()) return event.nodeId;
  if (Number.isSafeInteger(event?.nodeId)) return String(event.nodeId);
  if (typeof event?.selector !== 'string' || !event.selector.trim()) return null;
  let hash = 2166136261;
  for (const character of redactSensitiveText(event.selector.normalize('NFKC'))) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return `probe-${hash.toString(16).padStart(8, '0')}`;
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
  const type = ACTION_TYPES.has(action?.type) ? action.type : 'probe';
  return {
    type,
    ...(type === 'key' && action?.key === 'Tab' ? { key: 'Tab' } : {}),
    ...(type === 'key' && Number.isSafeInteger(action?.index) ? { index: action.index } : {}),
    ...(type === 'viewport' && finite(action?.widthCssPx) ? { widthCssPx: action.widthCssPx } : {}),
    ...(type === 'text-resize' && finite(action?.scalePercent) ? { scalePercent: action.scalePercent } : {}),
    ...(type === 'measure-targets' && Array.isArray(action?.thresholdsCssPx) ? { thresholdsCssPx: action.thresholdsCssPx.filter(finite) } : {}),
    ...(type === 'guard-navigation' && action?.operation === 'install' ? { operation: 'install' } : {}),
    ...(type === 'restore' && ['listeners', 'styles', 'viewport', 'scroll', 'focus'].includes(action?.target) ? { target: action.target } : {}),
    ...(type === 'motion' && action?.preference === 'reduce' ? { preference: 'reduce' } : {})
  };
}

/** Converts raw probe events to a JSON-safe conservative tri-state contract. */
export function normalizeProbes(raw = {}) {
  const focusEvents = Array.isArray(raw.focus?.events) ? raw.focus.events : [];
  const focusIds = focusEvents.map(safeId).filter(Boolean);
  const focusComplete = raw.focus?.completed === true;
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

  const reflowValid = finite(raw.reflow?.testedWidthCssPx) && raw.reflow.testedWidthCssPx > 0 && raw.reflow.testedWidthCssPx <= 320 &&
    typeof raw.reflow?.horizontalOverflow === 'boolean';
  const resizeValid = finite(raw.textResize?.scalePercent) && raw.textResize.scalePercent >= 200 &&
    typeof raw.textResize?.lossOfContent === 'boolean';

  const targetObservations = (Array.isArray(raw.targetSizes) ? raw.targetSizes : []).filter(item =>
    safeId(item) && finite(item.width) && item.width >= 0 && finite(item.height) && item.height >= 0
  ).map(item => ({
    nodeId: safeId(item), width: item.width, height: item.height,
    exception: typeof item.exception === 'string' ? item.exception : 'unknown',
    minimum24: item.width >= 24 && item.height >= 24,
    enhanced44: item.width >= 44 && item.height >= 44
  }));
  const minimumFailures = targetObservations.filter(item => !item.minimum24 && item.exception === 'none').map(item => item.nodeId);
  const enhancedFailures = targetObservations.filter(item => !item.enhanced44 && item.exception === 'none').map(item => item.nodeId);
  const minimumExceptions = new Set(['equivalent', 'inline', 'user-agent', 'essential', 'spacing']);
  const enhancedExceptions = new Set(['equivalent', 'inline', 'user-agent', 'essential']);
  const minimumUnknown = targetObservations.some(item => !item.minimum24 && item.exception !== 'none' && !minimumExceptions.has(item.exception));
  const enhancedUnknown = targetObservations.some(item => !item.enhanced44 && item.exception !== 'none' && !enhancedExceptions.has(item.exception));

  const reducedPreferenceExecuted = raw.motion?.prefersReducedMotion === true ||
    (raw.motion?.prefersReducedMotion === undefined && raw.motion?.preference === 'reduce');
  const motionValid = raw.motion?.complete === true && reducedPreferenceExecuted &&
    Number.isSafeInteger(raw.motion?.animatedCount) && raw.motion.animatedCount >= 0 &&
    Number.isSafeInteger(raw.motion?.reducedAnimatedCount) && raw.motion.reducedAnimatedCount >= 0;
  const motionFailed = motionValid && raw.motion.prefersReducedMotion && raw.motion.reducedAnimatedCount > 0;

  const normalized = {
    focusOrder: {
      outcome: focusComplete ? 'passed' : 'cantTell',
      targets: focusIds,
      focusableCount: Number.isSafeInteger(raw.focus?.focusableCount) ? raw.focus.focusableCount : null
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
      outcome: reflowValid ? outcome(!raw.reflow.horizontalOverflow) : 'cantTell',
      testedWidthCssPx: reflowValid ? raw.reflow.testedWidthCssPx : null,
      horizontalOverflow: reflowValid ? raw.reflow.horizontalOverflow : null,
      exception: typeof raw.reflow?.exception === 'string' ? raw.reflow.exception : 'none'
    },
    textResize: {
      outcome: resizeValid ? outcome(!raw.textResize.lossOfContent) : 'cantTell',
      scalePercent: resizeValid ? raw.textResize.scalePercent : null,
      lossOfContent: resizeValid ? raw.textResize.lossOfContent : null
    },
    targetSizes: {
      minimum24: { outcome: minimumFailures.length ? 'failed' : targetObservations.length && !minimumUnknown ? 'passed' : 'cantTell', failedNodeIds: unique(minimumFailures) },
      enhanced44: { outcome: enhancedFailures.length ? 'failed' : targetObservations.length && !enhancedUnknown ? 'passed' : 'cantTell', failedNodeIds: unique(enhancedFailures) },
      observations: targetObservations
    },
    motion: {
      outcome: motionValid ? outcome(!motionFailed) : 'cantTell',
      prefersReducedMotion: motionValid ? raw.motion.prefersReducedMotion : null,
      animatedCount: motionValid ? raw.motion.animatedCount : null,
      reducedAnimatedCount: motionValid ? raw.motion.reducedAnimatedCount : null
    },
    warnings: sanitizeWarnings(raw.warnings),
    actions: sanitizeJsonData((Array.isArray(raw.actions) ? raw.actions : []).map(sanitizeAction))
  };
  normalized.probeCoverage = Object.fromEntries([
    'focusOrder', 'keyboardTraps', 'focusAppearance', 'obscuredTargets', 'reflow', 'textResize', 'motion'
  ].map(key => [key, normalized[key].outcome === 'cantTell' ? 'cantTell' : 'complete']));
  normalized.probeCoverage.targetSizes = [normalized.targetSizes.minimum24, normalized.targetSizes.enhanced44]
    .some(item => item.outcome === 'cantTell') ? 'cantTell' : 'complete';
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
