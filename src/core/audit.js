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
import { validateNormalizedAxeSupplemental } from './axe/validate-supplemental.js';
import { AUDITA_RULES_VERSION, registeredRuleSource } from './provenance.js';

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
  const evaluated = await runRules(snapshot, context, rules);
  const ruleResults = Object.freeze(evaluated.map(result => Object.freeze({
    ...result,
    source: registeredRuleSource(result, AUDITA_RULES_VERSION),
  })));
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

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Adds sanitized supplemental rule records while the ABNT item registry stays
 * authoritative. A pass is summary-only and can never enter this boundary.
 */
export function mergeAxeSupplementalResults(coreAudit, supplemental) {
  if (!coreAudit || typeof coreAudit !== 'object' || !Array.isArray(coreAudit.ruleResults) || !Array.isArray(coreAudit.itemResults)) {
    throw new TypeError('O resultado do motor próprio é inválido.');
  }
  const validated = validateNormalizedAxeSupplemental(supplemental, { rulesVersion: '1.0.0' });
  const incomingRules = validated.ruleResults;
  const existingIds = new Set(coreAudit.ruleResults.map(rule => rule.ruleId));
  const supplementalRules = incomingRules.filter(rule => typeof rule.ruleId === 'string' &&
    rule.ruleId.startsWith('axe.') && !existingIds.has(rule.ruleId));
  const occurrenceOutcomes = new Map();
  for (const occurrence of validated.occurrences) {
    if (!occurrence.nbrItemRef) continue;
    const previous = occurrenceOutcomes.get(occurrence.nbrItemRef);
    if (occurrence.outcome === 'failed' || previous !== 'failed') {
      occurrenceOutcomes.set(occurrence.nbrItemRef, occurrence.outcome);
    }
  }
  const itemResults = coreAudit.itemResults.map(item => {
    const supplementalOutcome = occurrenceOutcomes.get(item.id);
    if (supplementalOutcome === 'failed') return { ...item, outcome: 'failed' };
    if (supplementalOutcome === 'cantTell' && item.outcome !== 'failed') return { ...item, outcome: 'cantTell' };
    return { ...item };
  });
  const coreRuleResults = cloneJson(coreAudit.ruleResults);
  const copiedSupplemental = cloneJson(supplementalRules);
  return deepFreeze({
    schemaVersion: coreAudit.schemaVersion,
    ruleResults: [...coreRuleResults, ...copiedSupplemental],
    itemResults: cloneJson(itemResults),
    composition: {
      ruleCount: coreRuleResults.length + copiedSupplemental.length,
      coreRuleCount: coreRuleResults.length,
      supplementalRuleCount: copiedSupplemental.length,
      itemCount: itemResults.length,
      valid: coreAudit.composition?.valid === true,
    },
  });
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value) || Object.isFrozen(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}
