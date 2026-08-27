function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function targetFor(occurrence) {
  const target = occurrence?.target && typeof occurrence.target === 'object'
    ? occurrence.target
    : { nodeId: occurrence?.nodeId ?? null, selector: occurrence?.selector ?? null, framePath: occurrence?.framePath ?? [] };
  const nodeId = text(target.nodeId);
  const selector = text(target.selector);
  const framePath = Array.isArray(target.framePath) ? target.framePath.filter(value => typeof value === 'string') : [];
  return { nodeId: nodeId || null, selector: selector || null, framePath };
}

function identityFor(occurrence, index) {
  const pageId = text(occurrence?.pageId);
  const target = targetFor(occurrence);
  const condition = text(occurrence?.equivalenceKey);
  const outcome = text(occurrence?.outcome);
  const stableTarget = text(occurrence?.presentationTargetKey) || target.nodeId || target.selector;
  if (!pageId || !stableTarget || !condition || !outcome) return `unique:${index}`;
  return ['shared', pageId, target.framePath.join('/'), stableTarget, condition, outcome].join('\u0000');
}

function sourceFor(occurrence) {
  const source = occurrence?.source && typeof occurrence.source === 'object' ? occurrence.source : {};
  return {
    engine: text(source.engine) || 'unknown',
    ruleId: text(source.ruleId) || text(occurrence?.ruleId) || 'unknown',
    version: text(source.version) || 'unknown',
    ...(text(source.engineRuleId) ? { engineRuleId: text(source.engineRuleId) } : {}),
  };
}

/** Groups equivalent cards without removing or mutating any occurrence. */
export function dedupeFindingsForPresentation(occurrences) {
  if (!Array.isArray(occurrences)) throw new TypeError('As ocorrências para deduplicação devem ser uma lista.');
  const byIdentity = new Map();
  for (const [index, occurrence] of occurrences.entries()) {
    if (!occurrence || typeof occurrence !== 'object' || Array.isArray(occurrence)) continue;
    const identity = identityFor(occurrence, index);
    let group = byIdentity.get(identity);
    if (!group) {
      group = {
        groupId: `presentation-${String(byIdentity.size + 1).padStart(4, '0')}`,
        pageId: text(occurrence.pageId) || null,
        outcome: text(occurrence.outcome) || null,
        nbrItemRef: text(occurrence.nbrItemRef ?? occurrence.itemId) || null,
        equivalenceKey: text(occurrence.equivalenceKey) || null,
        presentationTargetKey: text(occurrence.presentationTargetKey) || null,
        target: targetFor(occurrence),
        occurrenceIds: [],
        sources: [],
      };
      byIdentity.set(identity, group);
    }
    const occurrenceId = text(occurrence.occurrenceId) || `unidentified-${index + 1}`;
    group.occurrenceIds.push(occurrenceId);
    const source = sourceFor(occurrence);
    const sourceKey = JSON.stringify(source);
    if (!group.sources.some(existing => JSON.stringify(existing) === sourceKey)) group.sources.push(source);
  }
  return Object.freeze({
    groups: Object.freeze([...byIdentity.values()].map(group => Object.freeze({
      ...group,
      target: Object.freeze({ ...group.target, framePath: Object.freeze([...group.target.framePath]) }),
      occurrenceIds: Object.freeze([...group.occurrenceIds]),
      sources: Object.freeze(group.sources.map(source => Object.freeze({ ...source }))),
    }))),
    occurrenceCount: occurrences.length,
    hiddenOccurrenceCount: 0,
  });
}
