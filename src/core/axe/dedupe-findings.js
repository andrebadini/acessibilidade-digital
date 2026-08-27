import { axeEquivalenceForAuditaRule, axeNbrMappingForRule } from '../normative/axe-nbr-crosswalk.js';

function text(value) { return typeof value === 'string' ? value.trim() : ''; }

function targetFor(occurrence) {
  const target = occurrence?.target && typeof occurrence.target === 'object'
    ? occurrence.target
    : { nodeId: occurrence?.nodeId ?? null, selector: occurrence?.selector ?? null, framePath: occurrence?.framePath ?? [] };
  const framePath = Array.isArray(target.framePath) ? target.framePath.filter(value => typeof value === 'string') : [];
  return { nodeId: text(target.nodeId) || null, selector: text(target.selector) || null, framePath };
}

function curatedIdentity(occurrence, index, canonicalNodeByOccurrenceId) {
  const source = occurrence?.source;
  const item = text(occurrence?.nbrItemRef ?? occurrence?.itemId);
  const pageId = text(occurrence?.pageId);
  const outcome = text(occurrence?.outcome);
  const target = targetFor(occurrence);
  if (!source || !item || !pageId || !outcome) return { key: `unique:${index}` };
  let mapping = null;
  if (source.engine === 'axe-core' && source.version === '4.13.0' && occurrence.ruleId === source.ruleId && source.ruleId === `axe.${source.engineRuleId}`) {
    mapping = axeNbrMappingForRule(source.engineRuleId);
  } else if (source.engine === 'audita-core' && source.version === '1.0.0' && source.ruleId === occurrence.ruleId) {
    const equivalence = axeEquivalenceForAuditaRule(source.ruleId);
    mapping = equivalence ? axeNbrMappingForRule(equivalence.axeRuleId) : null;
  }
  if (!mapping?.equivalenceKey || mapping.nbrItemRef !== item) return { key: `unique:${index}` };
  let targetKey = null;
  if (mapping.targetScope === 'document') {
    const bound = source.engine === 'axe-core'
      ? target.selector === 'html' && target.framePath.length === 0
      : target.nodeId === null && target.selector === null && target.framePath.length === 0;
    if (bound) targetKey = 'document';
  } else {
    const canonicalNode = canonicalNodeByOccurrenceId instanceof Map
      ? text(canonicalNodeByOccurrenceId.get(text(occurrence.occurrenceId))) : '';
    if (canonicalNode) targetKey = `node:${canonicalNode}`;
  }
  if (!targetKey) return { key: `unique:${index}` };
  return {
    key: ['curated', pageId, target.framePath.join('/'), targetKey, item, mapping.axeRuleId, mapping.equivalenceKey, outcome].join('\u0000'),
    equivalenceKey: mapping.equivalenceKey,
    presentationTargetKey: targetKey,
  };
}

function sourceFor(occurrence) {
  const source = occurrence?.source && typeof occurrence.source === 'object' ? occurrence.source : {};
  return {
    engine: text(source.engine) || 'unknown', ruleId: text(source.ruleId) || text(occurrence?.ruleId) || 'unknown',
    version: text(source.version) || 'unknown',
    ...(text(source.engineRuleId) ? { engineRuleId: text(source.engineRuleId) } : {}),
  };
}

/** Groups only independently bound, curated cross-engine equivalences. */
export function dedupeFindingsForPresentation(occurrences, { canonicalNodeByOccurrenceId = new Map() } = {}) {
  if (!Array.isArray(occurrences)) throw new TypeError('As ocorrências para deduplicação devem ser uma lista.');
  const byIdentity = new Map();
  for (const [index, occurrence] of occurrences.entries()) {
    if (!occurrence || typeof occurrence !== 'object' || Array.isArray(occurrence)) continue;
    const identity = curatedIdentity(occurrence, index, canonicalNodeByOccurrenceId);
    let group = byIdentity.get(identity.key);
    if (!group) {
      group = {
        groupId: `presentation-${String(byIdentity.size + 1).padStart(4, '0')}`,
        pageId: text(occurrence.pageId) || null, outcome: text(occurrence.outcome) || null,
        nbrItemRef: text(occurrence.nbrItemRef ?? occurrence.itemId) || null,
        equivalenceKey: identity.equivalenceKey ?? null, presentationTargetKey: identity.presentationTargetKey ?? null,
        target: targetFor(occurrence), occurrenceIds: [], sources: [],
      };
      byIdentity.set(identity.key, group);
    }
    group.occurrenceIds.push(text(occurrence.occurrenceId) || `unidentified-${index + 1}`);
    const source = sourceFor(occurrence);
    const sourceKey = JSON.stringify(source);
    if (!group.sources.some(existing => JSON.stringify(existing) === sourceKey)) group.sources.push(source);
  }
  return Object.freeze({
    groups: Object.freeze([...byIdentity.values()].map(group => Object.freeze({
      ...group, target: Object.freeze({ ...group.target, framePath: Object.freeze([...group.target.framePath]) }),
      occurrenceIds: Object.freeze([...group.occurrenceIds]),
      sources: Object.freeze(group.sources.map(source => Object.freeze({ ...source }))),
    }))),
    occurrenceCount: occurrences.length, hiddenOccurrenceCount: 0,
  });
}
