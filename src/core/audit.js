import { NBR17225_ITEMS } from './normative/nbr17225.js';
import { validateNormativeData } from './normative/validate-normative-data.js';
import { aggregateItems } from './rules/aggregate-items.js';
import { FORM_RULES } from './rules/forms.js';
import { INTERACTIVE_RULES } from './rules/interactive.js';
import { MANUAL_REVIEW_RULES } from './rules/manual-review.js';
import { MEDIA_RULES } from './rules/media.js';
import { runRules } from './rules/run-rules.js';
import { STRUCTURE_RULES } from './rules/structure.js';
import { VISUAL_RULES } from './rules/visual.js';
import { assertSnapshotV1 } from './snapshot-schema.js';

const RULE_FAMILIES = Object.freeze([
  STRUCTURE_RULES,
  INTERACTIVE_RULES,
  FORM_RULES,
  VISUAL_RULES,
  MEDIA_RULES,
  MANUAL_REVIEW_RULES
]);

const EXPECTED_RULES = Object.freeze(NBR17225_ITEMS.flatMap(item => item.ruleIds.map(id => Object.freeze({
  id,
  mode: item.evaluation,
  nbrItems: Object.freeze([item.id]),
  wcag: Object.freeze(item.wcag.map(reference => reference.id))
}))));

/** The complete Task 5 + Task 6 rule composition in stable family order. */
export const CORE_RULES = Object.freeze(RULE_FAMILIES.flat());

function sameStrings(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length &&
    expected.every((value, index) => actual[index] === value);
}

/**
 * Returns deterministic composition errors. Exact rule IDs and their mode,
 * NBR item and WCAG metadata must match the authoritative normative registry.
 */
export function validateCoreRuleComposition(rules = CORE_RULES) {
  if (!Array.isArray(rules)) return ['Core rule composition must be an array'];
  const errors = [...validateNormativeData()];
  const counts = new Map();
  for (const rule of rules) {
    const id = typeof rule?.id === 'string' ? rule.id : '';
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  for (const [id, count] of counts) {
    if (count > 1) errors.push(`Duplicate core rule: ${id || '[invalid]'}`);
  }

  const expectedById = new Map(EXPECTED_RULES.map(rule => [rule.id, rule]));
  const actualById = new Map(rules.filter(rule => typeof rule?.id === 'string').map(rule => [rule.id, rule]));
  for (const expected of EXPECTED_RULES) {
    const actual = actualById.get(expected.id);
    if (!actual) {
      errors.push(`Missing core rule: ${expected.id}`);
      continue;
    }
    if (actual.mode !== expected.mode) errors.push(`Mode mismatch for ${expected.id}`);
    if (!sameStrings(actual.nbrItems, expected.nbrItems)) errors.push(`NBR items mismatch for ${expected.id}`);
    if (!sameStrings(actual.wcag, expected.wcag)) errors.push(`WCAG mismatch for ${expected.id}`);
    if (typeof actual.evaluate !== 'function') errors.push(`Evaluator missing for ${expected.id}`);
  }
  for (const id of actualById.keys()) {
    if (!expectedById.has(id)) errors.push(`Unexpected core rule: ${id}`);
  }
  if (rules.length !== EXPECTED_RULES.length) {
    errors.push(`Core rule count mismatch: expected ${EXPECTED_RULES.length}, received ${rules.length}`);
  }
  return errors;
}

/** Runs the complete validated core audit and returns a frozen JSON-safe model. */
export async function runCoreAudit(snapshot, context = {}, rules = CORE_RULES) {
  const compositionErrors = validateCoreRuleComposition(rules);
  if (compositionErrors.length > 0) {
    throw new TypeError(`Invalid core composition: ${compositionErrors.join('; ')}`);
  }
  assertSnapshotV1(snapshot);
  const ruleResults = await runRules(snapshot, context, rules);
  const itemResults = aggregateItems(ruleResults, NBR17225_ITEMS);
  return Object.freeze({
    schemaVersion: 1,
    ruleResults,
    itemResults,
    composition: Object.freeze({
      ruleCount: ruleResults.length,
      itemCount: itemResults.length,
      valid: true
    })
  });
}
