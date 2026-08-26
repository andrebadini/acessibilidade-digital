import { OUTCOMES, TEST_MODES, createRuleResult } from '../result.js';
import { cloneJsonSafeArray, createReadonlyView } from './safe-data.js';

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

const DUPLICATE_RULE = Object.freeze({
  summary: 'A regra possui um identificador duplicado e não foi considerada.',
  limitations: Object.freeze([
    'Remova a duplicidade do identificador da regra e execute a auditoria novamente.'
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

function hasOwn(value, field) {
  return value !== null && (typeof value === 'object' || typeof value === 'function') &&
    Object.hasOwn(value, field);
}

function normalizeRule(rule, index) {
  try {
    const hasWcag = hasOwn(rule, 'wcag');
    if (
      rule !== null && typeof rule === 'object' &&
      hasOwn(rule, 'id') && hasOwn(rule, 'mode') &&
      hasOwn(rule, 'nbrItems') && hasOwn(rule, 'evaluate') &&
      isNonEmptyString(rule.id) &&
      TEST_MODES.includes(rule.mode) &&
      Array.isArray(rule.nbrItems) && rule.nbrItems.length > 0 &&
      rule.nbrItems.every(isNonEmptyString) &&
      (!hasWcag || (
        Array.isArray(rule.wcag) && rule.wcag.length > 0 && rule.wcag.every(isNonEmptyString)
      )) &&
      typeof rule.evaluate === 'function'
    ) {
      return Object.freeze({
        id: rule.id.trim(),
        mode: rule.mode,
        nbrItems: Object.freeze([...new Set(rule.nbrItems.map(itemId => itemId.trim()))]),
        ...(hasWcag
          ? { wcag: Object.freeze([...new Set(rule.wcag.map(criterionId => criterionId.trim()))]) }
          : {}),
        evaluate: rule.evaluate
      });
    }
  } catch {
    // Invalid direct rule inputs are represented below as safe untested rules.
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

function hasInheritedContractField(value) {
  return [...EVALUATION_RESULT_FIELDS].some(
    field => field in value && !hasOwn(value, field)
  );
}

function isEvaluationResult(value, rule) {
  return (
    value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).every(field => EVALUATION_RESULT_FIELDS.has(field)) &&
    !hasInheritedContractField(value) &&
    hasOwn(value, 'outcome') && OUTCOMES.includes(value.outcome) &&
    (!hasOwn(value, 'ruleId') || value.ruleId === rule.id) &&
    (!hasOwn(value, 'mode') || value.mode === rule.mode) &&
    (!hasOwn(value, 'nbrItems') || hasSameItems(value, rule)) &&
    (!hasOwn(value, 'targets') || Array.isArray(value.targets)) &&
    (!hasOwn(value, 'summary') || typeof value.summary === 'string') &&
    (!hasOwn(value, 'limitations') || Array.isArray(value.limitations))
  );
}

function evaluationDetails(value) {
  return {
    targets: hasOwn(value, 'targets') ? value.targets : [],
    summary: hasOwn(value, 'summary') ? value.summary : '',
    limitations: hasOwn(value, 'limitations') ? value.limitations : []
  };
}

function makeResult(rule, outcome, details) {
  const base = createRuleResult({
    ruleId: rule.id,
    outcome,
    mode: rule.mode,
    targets: cloneJsonSafeArray(details.targets ?? []),
    summary: details.summary,
    limitations: cloneJsonSafeArray(details.limitations ?? [])
  });

  return Object.freeze({
    ...base,
    nbrItems: Object.freeze([...rule.nbrItems]),
    ...(hasOwn(rule, 'wcag') ? { wcag: Object.freeze([...rule.wcag]) } : {})
  });
}

async function runOneRule(snapshot, context, rule, duplicateRuleIds) {
  if (typeof rule.evaluate !== 'function') {
    return makeResult(rule, 'untested', INVALID_RESULT);
  }
  if (duplicateRuleIds.has(rule.id)) {
    return makeResult(rule, 'untested', DUPLICATE_RULE);
  }

  try {
    const value = await rule.evaluate(createReadonlyView(snapshot), createReadonlyView(context));
    if (!isEvaluationResult(value, rule)) {
      return makeResult(rule, 'untested', INVALID_RESULT);
    }
    return makeResult(rule, value.outcome, evaluationDetails(value));
  } catch {
    return makeResult(rule, 'untested', EXECUTION_FAILURE);
  }
}

function duplicateRuleIds(rules) {
  const counts = new Map();
  for (const rule of rules) {
    counts.set(rule.id, (counts.get(rule.id) ?? 0) + 1);
  }
  return new Set([...counts].filter(([, count]) => count > 1).map(([id]) => id));
}

function safeRulesLength(rules) {
  try {
    if (!Array.isArray(rules)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(rules, 'length');
    return descriptor && Object.hasOwn(descriptor, 'value') &&
      Number.isSafeInteger(descriptor.value) && descriptor.value >= 0
      ? descriptor.value
      : 0;
  } catch {
    return 0;
  }
}

function safeRuleSlot(rules, index) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(rules, String(index));
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Runs rules in the supplied order. A single rule failure is represented as an
 * untested RuleResult so the remaining audit can still be reported.
 */
export async function runRules(snapshot, context, rules) {
  const length = safeRulesLength(rules);
  if (length === null) {
    throw new TypeError('Rules must be an array');
  }

  const normalizedRules = [];
  for (let index = 0; index < length; index += 1) {
    normalizedRules.push(normalizeRule(safeRuleSlot(rules, index), index));
  }
  const duplicated = duplicateRuleIds(normalizedRules);
  const values = [];
  for (const rule of normalizedRules) {
    values.push(await runOneRule(snapshot, context, rule, duplicated));
  }
  return Object.freeze(values);
}
