import { OUTCOMES, TEST_MODES, createRuleResult } from '../result.js';

const EXECUTION_FAILURE = Object.freeze({
  summary: 'A regra não pôde ser executada com segurança.',
  limitations: Object.freeze([
    'A execução da regra falhou; revise os insumos e execute novamente.'
  ])
});

const INVALID_RESULT = Object.freeze({
  summary: 'A regra retornou um resultado inválido e não foi considerada.',
  limitations: Object.freeze([
    'Revise a implementação da regra e execute a auditoria novamente.'
  ])
});

const EVALUATION_RESULT_FIELDS = new Set([
  'ruleId',
  'outcome',
  'mode',
  'targets',
  'summary',
  'limitations',
  'nbrItems'
]);

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function normalizeRule(rule, index) {
  if (
    rule !== null && typeof rule === 'object' &&
    isNonEmptyString(rule.id) &&
    TEST_MODES.includes(rule.mode) &&
    Array.isArray(rule.nbrItems) && rule.nbrItems.length > 0 &&
    rule.nbrItems.every(isNonEmptyString) &&
    typeof rule.evaluate === 'function'
  ) {
    return Object.freeze({
      id: rule.id.trim(),
      mode: rule.mode,
      nbrItems: Object.freeze([...new Set(rule.nbrItems.map(itemId => itemId.trim()))]),
      evaluate: rule.evaluate
    });
  }

  return Object.freeze({
    id: `invalid-rule-${index + 1}`,
    mode: 'automated',
    nbrItems: Object.freeze([]),
    evaluate: null
  });
}

function hasSameItems(value, rule) {
  if (!Array.isArray(value.nbrItems) || value.nbrItems.length !== rule.nbrItems.length) {
    return false;
  }
  return value.nbrItems.every((itemId, index) => itemId === rule.nbrItems[index]);
}

function isEvaluationResult(value, rule) {
  return (
    value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).every(field => EVALUATION_RESULT_FIELDS.has(field)) &&
    OUTCOMES.includes(value.outcome) &&
    (value.ruleId === undefined || value.ruleId === rule.id) &&
    (value.mode === undefined || value.mode === rule.mode) &&
    (value.nbrItems === undefined || hasSameItems(value, rule)) &&
    (value.targets === undefined || Array.isArray(value.targets)) &&
    (value.summary === undefined || typeof value.summary === 'string') &&
    (value.limitations === undefined || Array.isArray(value.limitations))
  );
}

function makeResult(rule, outcome, details) {
  const base = createRuleResult({
    ruleId: rule.id,
    outcome,
    mode: rule.mode,
    targets: details.targets ?? [],
    summary: details.summary,
    limitations: details.limitations ?? []
  });

  return Object.freeze({
    ...base,
    nbrItems: Object.freeze([...rule.nbrItems])
  });
}

async function runOneRule(snapshot, context, rule, index) {
  const normalizedRule = normalizeRule(rule, index);
  if (typeof normalizedRule.evaluate !== 'function') {
    return makeResult(normalizedRule, 'untested', INVALID_RESULT);
  }

  try {
    const value = await normalizedRule.evaluate(snapshot, context);
    if (!isEvaluationResult(value, normalizedRule)) {
      return makeResult(normalizedRule, 'untested', INVALID_RESULT);
    }
    return makeResult(normalizedRule, value.outcome, value);
  } catch {
    return makeResult(normalizedRule, 'untested', EXECUTION_FAILURE);
  }
}

/**
 * Runs rules in the supplied order. A single rule failure is represented as an
 * untested RuleResult so the remaining audit can still be reported.
 */
export async function runRules(snapshot, context, rules) {
  if (!Array.isArray(rules)) {
    throw new TypeError('Rules must be an array');
  }

  const values = [];
  for (let index = 0; index < rules.length; index += 1) {
    values.push(await runOneRule(snapshot, context, rules[index], index));
  }
  return Object.freeze(values);
}
