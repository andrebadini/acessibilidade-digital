const DETECTOR = 'audita.accessibility-widgets';
const VERSION = '1.0.0';
const WIDGET_IDS = Object.freeze(['vlibras', 'hand-talk']);
const SIGNALS = Object.freeze([
  Object.freeze(['dom', 'dom-signature']),
  Object.freeze(['script', 'script-signature']),
  Object.freeze(['global', 'global-signature']),
]);
const COVERAGE = new Set(['complete', 'partial', 'unavailable']);

function ownData(value, key) {
  try {
    const descriptor = value !== null && typeof value === 'object'
      ? Object.getOwnPropertyDescriptor(value, key)
      : null;
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function inaccessible(value) {
  try {
    return value === null || typeof value !== 'object' || Reflect.ownKeys(value).length < 0;
  } catch {
    return true;
  }
}

export function detectAccessibilityWidgets(observation) {
  if (inaccessible(observation)) return unknownInventory('unavailable');
  const declaredCoverage = ownData(observation, 'coverage');
  const rawWidgets = ownData(observation, 'widgets');
  let coverage = COVERAGE.has(declaredCoverage) ? declaredCoverage : 'unavailable';
  let malformed = !rawWidgets || typeof rawWidgets !== 'object';
  const widgets = WIDGET_IDS.map(id => {
    const raw = ownData(rawWidgets, id);
    const signals = [];
    let completeSignals = raw !== null && typeof raw === 'object';
    for (const [field, label] of SIGNALS) {
      const value = ownData(raw, field);
      if (value === true) signals.push(label);
      else if (value !== false) completeSignals = false;
    }
    malformed ||= !completeSignals;
    const status = signals.length > 0
      ? 'present'
      : coverage === 'complete' && completeSignals ? 'absent' : 'unknown';
    return Object.freeze({ id, status, signals: Object.freeze(signals) });
  });
  if (malformed && coverage === 'complete') coverage = 'partial';
  return Object.freeze({
    detector: DETECTOR,
    version: VERSION,
    coverage,
    widgets: Object.freeze(widgets),
  });
}

export function unknownAccessibilityWidgetInventory() {
  return unknownInventory('unavailable');
}

function unknownInventory(coverage) {
  return Object.freeze({
    detector: DETECTOR,
    version: VERSION,
    coverage,
    widgets: Object.freeze(WIDGET_IDS.map(id => Object.freeze({
      id, status: 'unknown', signals: Object.freeze([]),
    }))),
  });
}

export const ACCESSIBILITY_WIDGET_DETECTOR = Object.freeze({
  id: DETECTOR,
  version: VERSION,
  widgetIds: WIDGET_IDS,
  signals: Object.freeze(SIGNALS.map(([, label]) => label)),
});
