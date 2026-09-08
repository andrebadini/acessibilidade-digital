const ENHANCED_CONTRAST_RULE = 'text-contrast-enhanced';
const LEGACY_ENHANCED_CRITERIA = Object.freeze(['1.4.3', '1.4.6']);

function sameCriteria(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length &&
    expected.every((criterion, index) => actual[index] === criterion);
}

/** The ABNT/source crosswalk can be broader than a rule's failed test. */
export function testedWcagRefsForCoreRule(ruleId, outcome, sourceWcagRefs) {
  if (outcome !== 'failed' || ruleId === 'new-window-link-warning') return [];
  return sourceWcagRefs.filter(criterion => ruleId !== ENHANCED_CONTRAST_RULE || criterion === '1.4.6');
}

/** Contextual crosswalk remains available in the matrix and technical model. */
export function displayedWcagRefs(occurrences, rule, contextualRefs) {
  if (rule?.source?.engine === 'audita-core' && rule.ruleId === ENHANCED_CONTRAST_RULE &&
    occurrences.length > 0 && occurrences.every(row => row.outcome === 'failed')) {
    return testedWcagRefsForCoreRule(rule.ruleId, 'failed', rule.wcag);
  }
  return [...new Set(contextualRefs)].sort((a, b) => a.localeCompare(b));
}

/**
 * Accept the exact pre-1.1.9 enhanced claim without rewriting saved evidence or
 * invalidating its integrity hashes. Exporting a saved report can update the
 * extension version, so compatibility follows its representation, not that field.
 * New observations use testedWcagRefsForCoreRule; presentation can use it too.
 */
export function isCompatibleCoreTestedWcagRefs(ruleId, outcome, sourceWcagRefs, testedWcagRefs) {
  return sameCriteria(testedWcagRefs, testedWcagRefsForCoreRule(ruleId, outcome, sourceWcagRefs)) ||
    (ruleId === ENHANCED_CONTRAST_RULE && outcome === 'failed' &&
      sameCriteria(sourceWcagRefs, LEGACY_ENHANCED_CRITERIA) &&
      sameCriteria(testedWcagRefs, LEGACY_ENHANCED_CRITERIA));
}
