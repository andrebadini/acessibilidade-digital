import { OUTCOMES, TEST_MODES, createRuleResult } from '../result.js';
import { NBR17225_ITEMS } from '../normative/nbr17225.js';

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

  try {
    const base = createRuleResult({
      ruleId: value.ruleId,
      outcome: value.outcome,
      mode: value.mode,
      targets: value.targets,
      summary: value.summary,
      limitations: value.limitations
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
    wcag: Object.freeze(Array.isArray(item?.wcag) ? [...item.wcag] : []),
    evaluation: typeof item?.evaluation === 'string' ? item.evaluation : '',
    ruleIds: Object.freeze(Array.isArray(item?.ruleIds) ? [...item.ruleIds] : []),
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

  const linkedByItem = new Map();
  for (const candidate of ruleResults) {
    const ruleResult = normalizeRuleResult(candidate);
    if (ruleResult === null) continue;

    for (const itemId of ruleResult.nbrItems) {
      const linked = linkedByItem.get(itemId) ?? [];
      linked.push(ruleResult);
      linkedByItem.set(itemId, linked);
    }
  }

  return Object.freeze(items.map((item, index) => {
    const normative = copyNormativeData(item, index);
    const linkedResults = Object.freeze([...(linkedByItem.get(normative.id) ?? [])]);
    return Object.freeze({
      ...normative,
      humanReason: linkedResults.length === 0 ? safeHumanReason(item) : normative.humanReason,
      outcome: aggregateOutcome(linkedResults),
      ruleResults: linkedResults
    });
  }));
}
