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
    return Object.freeze({ ...base, nbrItems: Object.freeze(nbrItems) });
  } catch {
    return null;
  }
}

function safeHumanReason(item) {
  return typeof item?.humanReason === 'string' && item.humanReason.trim() !== ''
    ? item.humanReason
    : DEFAULT_HUMAN_REASON;
}

function copyNormativeData(item, index) {
  const id = typeof item?.id === 'string' && item.id.trim() !== ''
    ? item.id
    : `invalid-item-${index + 1}`;
  return {
    id,
    printedId: typeof item?.printedId === 'string' ? item.printedId : id,
    title: typeof item?.title === 'string' ? item.title : '',
    classification: typeof item?.classification === 'string' ? item.classification : '',
    wcag: cloneJsonSafeArray(Array.isArray(item?.wcag) ? item.wcag : []),
    evaluation: typeof item?.evaluation === 'string' ? item.evaluation : '',
    ruleIds: Object.freeze(normalizeItemIds(item?.ruleIds)),
    humanReason: typeof item?.humanReason === 'string' ? item.humanReason : ''
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

  return Object.freeze(items.map((item, index) => {
    const normative = copyNormativeData(item, index);
    const declaredRuleIds = new Set(normative.ruleIds);
    const linkedResults = Object.freeze(usableResults.filter(
      ruleResult => ruleResult.nbrItems.includes(normative.id) &&
        declaredRuleIds.has(ruleResult.ruleId)
    ));
    return Object.freeze({
      ...normative,
      humanReason: linkedResults.length === 0 ? safeHumanReason(item) : normative.humanReason,
      outcome: aggregateOutcome(linkedResults),
      ruleResults: linkedResults
    });
  }));
}
