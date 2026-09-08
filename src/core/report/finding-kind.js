// Presentation of canonical audit records; never changes recorded outcomes.
const CONCRETE_REASONS = new Set(['generic-link-purpose', 'new-window-warning-observation-incomplete', 'ambiguous-idref']);
export function findingKind(occurrence, rule, decision) {
  const outcome = ['failed', 'passed'].includes(occurrence.outcome) ? occurrence.outcome
    : decision?.answer === 'não conforme' ? 'failed'
      : decision?.answer === 'conforme' ? 'passed' : occurrence.outcome;
  if (outcome === 'failed') return occurrence.classification === 'requirement' ? 'detected' : 'advisory';
  if (outcome === 'passed') return 'positive';
  if (outcome === 'cantTell' && occurrence.source.engine === 'audita-core' &&
    occurrence.nodeId !== null && rule?.targets?.some(target =>
      String(target.nodeId) === String(occurrence.nodeId) && CONCRETE_REASONS.has(target.data?.reason))) return 'suspected';
  return 'checklist';
}
