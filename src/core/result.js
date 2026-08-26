export const OUTCOMES = Object.freeze([
  'passed',
  'failed',
  'cantTell',
  'inapplicable',
  'untested'
]);

export const TEST_MODES = Object.freeze([
  'automatic',
  'semiAuto',
  'manual'
]);

export function createRuleResult(input) {
  if (!OUTCOMES.includes(input.outcome)) {
    throw new TypeError('Invalid outcome');
  }
  if (!TEST_MODES.includes(input.mode)) {
    throw new TypeError('Invalid test mode');
  }

  return Object.freeze({
    ruleId: input.ruleId,
    outcome: input.outcome,
    mode: input.mode,
    targets: Object.freeze([...(input.targets ?? [])]),
    summary: input.summary ?? '',
    limitations: Object.freeze([...(input.limitations ?? [])])
  });
}
