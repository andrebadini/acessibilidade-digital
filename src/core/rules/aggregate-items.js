import { OUTCOMES, TEST_MODES, createRuleResult } from '../result.js';
import { NBR17225_ITEMS } from '../normative/nbr17225.js';
import { cloneJsonSafeArray } from './safe-data.js';

const OUTCOME_PRIORITY = Object.freeze({
  failed: 5,
  cantTell: 4,
  untested: 3,
  passed: 2,
  inapplicable: 1
});

const DEFAULT_HUMAN_REASON =
  'Não há resultado de regra vinculado a este item; é necessária revisão humana.';
const DUPLICATE_ITEM_REASON =
  'O catálogo normativo contém um identificador duplicado; o item exige revisão de integridade.';

function hasOwn(value, field) {
  return value !== null && (typeof value === 'object' || typeof value === 'function') &&
    Object.hasOwn(value, field);
}

function ownValue(value, field) {
  try {
    return hasOwn(value, field) ? value[field] : undefined;
  } catch {
    return undefined;
  }
}

function normalizeItemIds(value) {
  if (!Array.isArray(value)) return [];

  const ids = [];
  const seen = new Set();
  for (const itemId of value) {
    if (typeof itemId !== 'string') continue;
    const normalized = itemId.trim();
    if (normalized === '' || seen.has(normalized)) continue;
    seen.add(normalized);
    ids.push(normalized);
  }
  return ids;
}

function normalizeRuleResult(value) {
  try {
    if (
      value === null || typeof value !== 'object' || Array.isArray(value) ||
      !hasOwn(value, 'ruleId') || !hasOwn(value, 'outcome') ||
      !hasOwn(value, 'mode') || !hasOwn(value, 'nbrItems') ||
      !hasOwn(value, 'targets') || !hasOwn(value, 'summary') ||
      !hasOwn(value, 'limitations') ||
      typeof value.ruleId !== 'string' || value.ruleId.trim() === '' ||
      !OUTCOMES.includes(value.outcome) || !TEST_MODES.includes(value.mode) ||
      !Array.isArray(value.targets) || typeof value.summary !== 'string' ||
      !Array.isArray(value.limitations)
    ) {
      return null;
    }

    const nbrItems = normalizeItemIds(value.nbrItems);
    if (nbrItems.length === 0) return null;
    const base = createRuleResult({
      ruleId: value.ruleId,
      outcome: value.outcome,
      mode: value.mode,
      targets: cloneJsonSafeArray(value.targets),
      summary: value.summary,
      limitations: cloneJsonSafeArray(value.limitations)
    });
    const wcag = hasOwn(value, 'wcag') ? normalizeItemIds(value.wcag) : null;
    if (wcag !== null && wcag.length === 0) return null;
    return Object.freeze({
      ...base,
      nbrItems: Object.freeze(nbrItems),
      ...(wcag === null ? {} : { wcag: Object.freeze(wcag) })
    });
  } catch {
    return null;
  }
}

function safeHumanReason(item) {
  const humanReason = ownValue(item, 'humanReason');
  return typeof humanReason === 'string' && humanReason.trim() !== ''
    ? humanReason
    : DEFAULT_HUMAN_REASON;
}

function copyNormativeData(item, index) {
  const itemId = ownValue(item, 'id');
  const printedId = ownValue(item, 'printedId');
  const title = ownValue(item, 'title');
  const classification = ownValue(item, 'classification');
  const wcag = ownValue(item, 'wcag');
  const evaluation = ownValue(item, 'evaluation');
  const ruleIds = ownValue(item, 'ruleIds');
  const humanReason = ownValue(item, 'humanReason');
  const id = typeof itemId === 'string' && itemId.trim() !== ''
    ? itemId
    : `invalid-item-${index + 1}`;
  return {
    id,
    printedId: typeof printedId === 'string' ? printedId : id,
    title: typeof title === 'string' ? title : '',
    classification: typeof classification === 'string' ? classification : '',
    wcag: cloneJsonSafeArray(Array.isArray(wcag) ? wcag : []),
    evaluation: typeof evaluation === 'string' ? evaluation : '',
    ruleIds: Object.freeze(normalizeItemIds(ruleIds)),
    humanReason: typeof humanReason === 'string' ? humanReason : ''
  };
}

function aggregateOutcome(results) {
  if (results.length === 0) return 'cantTell';

  return results.reduce(
    (best, result) => OUTCOME_PRIORITY[result.outcome] > OUTCOME_PRIORITY[best]
      ? result.outcome
      : best,
    'inapplicable'
  );
}

/**
 * Produces a separate ItemResult for every supplied normative item. Rule
 * results remain nested evidence; they are never used as normative records.
 */
export function aggregateItems(ruleResults, items = NBR17225_ITEMS) {
  if (!Array.isArray(ruleResults)) {
    throw new TypeError('Rule results must be an array');
  }
  if (!Array.isArray(items)) {
    throw new TypeError('Normative items must be an array');
  }

  const normalizedResults = ruleResults.map(normalizeRuleResult).filter(Boolean);
  const resultCounts = new Map();
  for (const ruleResult of normalizedResults) {
    resultCounts.set(ruleResult.ruleId, (resultCounts.get(ruleResult.ruleId) ?? 0) + 1);
  }
  const usableResults = normalizedResults.filter(
    ruleResult => resultCounts.get(ruleResult.ruleId) === 1
  );

  const normativeItems = items.map(copyNormativeData);
  const itemCounts = new Map();
  for (const normative of normativeItems) {
    itemCounts.set(normative.id, (itemCounts.get(normative.id) ?? 0) + 1);
  }

  return Object.freeze(normativeItems.map((normative, index) => {
    if (itemCounts.get(normative.id) > 1) {
      return Object.freeze({
        ...normative,
        humanReason: DUPLICATE_ITEM_REASON,
        outcome: 'cantTell',
        ruleResults: Object.freeze([])
      });
    }
    const declaredRuleIds = new Set(normative.ruleIds);
    const linkedResults = Object.freeze(usableResults.filter(
      ruleResult => ruleResult.nbrItems.includes(normative.id) &&
        declaredRuleIds.has(ruleResult.ruleId)
    ));
    return Object.freeze({
      ...normative,
      humanReason: linkedResults.length === 0 ? safeHumanReason(items[index]) : normative.humanReason,
      outcome: aggregateOutcome(linkedResults),
      ruleResults: linkedResults
    });
  }));
}
