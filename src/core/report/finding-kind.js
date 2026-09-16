// Presentation of canonical audit records; never changes recorded outcomes.
// `missing-required-identification`, `invalid-required-state` and `required-state-mismatch` are the
// per-field suspicions ABNT 5.9.7 produces. They were missing here, so an independent review
// measured every one of them being rendered as a generic "not yet evaluated" checklist question:
// the field message and the selector never reached the exported HTML or PDF, and the print output
// carried only a count. The rule that emits them calls them concrete suspicions, and the product
// promises suspicions and checklist as separate groups, so they belong in this set.
const CONCRETE_REASONS = new Set([
  'generic-link-purpose', 'new-window-warning-observation-incomplete', 'ambiguous-idref',
  'missing-required-identification', 'invalid-required-state', 'required-state-mismatch'
]);
export function findingKind(occurrence, rule, decision) {
  const outcome = ['failed', 'passed'].includes(occurrence.outcome) ? occurrence.outcome
    : decision?.answer === 'não conforme' ? 'failed'
      : decision?.answer === 'conforme' ? 'passed' : occurrence.outcome;
  if (outcome === 'failed') return occurrence.classification === 'requirement' ? 'detected' : 'advisory';
  if (outcome === 'passed') return 'positive';
  if (outcome === 'cantTell' && occurrence.source.engine === 'axe-core' &&
    ['violations', 'incomplete'].includes(occurrence.engineResultType)) return 'suspected';
  if (outcome === 'cantTell' && occurrence.source.engine === 'audita-core' &&
    occurrence.nodeId !== null && rule?.targets?.some(target =>
      String(target.nodeId) === String(occurrence.nodeId) && CONCRETE_REASONS.has(target.data?.reason))) return 'suspected';
  return 'checklist';
}
