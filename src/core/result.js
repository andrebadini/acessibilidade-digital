export const OUTCOMES = Object.freeze([
  'passed',
  'failed',
  'cantTell',
  'inapplicable',
  'untested'
]);

export const TEST_MODES = Object.freeze([
  'automated',
  'assisted',
  'manual'
]);

export const CLASSIFICATIONS = Object.freeze([
  'requirement',
  'recommendation',
  'best-practice',
  'editorial'
]);

export const IMPACT_LEVELS = Object.freeze([
  'critical',
  'serious',
  'moderate',
  'minor'
]);

export const CONFIDENCE_LEVELS = Object.freeze([
  'high',
  'medium',
  'low'
]);

function requiredSourceText(value) {
  return typeof value === 'string' && value.trim() === value && value.length > 0;
}

function normalizeSource(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source) ||
    !requiredSourceText(source.engine) || !requiredSourceText(source.ruleId) ||
    !requiredSourceText(source.version)) {
    throw new TypeError('Invalid source metadata');
  }
  return Object.freeze({
    engine: source.engine,
    ruleId: source.ruleId,
    version: source.version
  });
}

export function createRuleResult(input) {
  if (!OUTCOMES.includes(input.outcome)) {
    throw new TypeError('Invalid outcome');
  }
  if (!TEST_MODES.includes(input.mode)) {
    throw new TypeError('Invalid test mode');
  }

  if (input.classification !== undefined && !CLASSIFICATIONS.includes(input.classification)) {
    throw new TypeError('Invalid classification');
  }
  if (input.impact !== undefined && !IMPACT_LEVELS.includes(input.impact)) {
    throw new TypeError('Invalid impact');
  }
  if (input.confidence !== undefined && !CONFIDENCE_LEVELS.includes(input.confidence)) {
    throw new TypeError('Invalid confidence');
  }

  return Object.freeze({
    ruleId: input.ruleId,
    outcome: input.outcome,
    mode: input.mode,
    targets: Object.freeze([...(input.targets ?? [])]),
    summary: input.summary ?? '',
    limitations: Object.freeze([...(input.limitations ?? [])]),
    ...(input.classification === undefined ? {} : { classification: input.classification }),
    ...(input.impact === undefined ? {} : { impact: input.impact }),
    ...(input.confidence === undefined ? {} : { confidence: input.confidence }),
    ...(input.source === undefined ? {} : { source: normalizeSource(input.source) })
  });
}
