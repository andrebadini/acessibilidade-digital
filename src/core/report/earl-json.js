import { createAuditModel } from './audit-model.js';
import { canonicalStringify } from './canonical-json.js';

const EARL = 'http://www.w3.org/ns/earl#';
const MODE = Object.freeze({ automated: `${EARL}automatic`, assisted: `${EARL}semiAuto`, manual: `${EARL}manual` });
const OUTCOME = Object.freeze({
  passed: `${EARL}passed`, failed: `${EARL}failed`, cantTell: `${EARL}cantTell`,
  inapplicable: `${EARL}inapplicable`, untested: `${EARL}untested`,
});

export function renderTechnicalJson(input) {
  const model = createAuditModel(input);
  const artifacts = new Map(model.evidence.artifacts.map(artifact => [artifact.evidenceId, artifact]));
  const occurrencesByItem = new Map();
  for (const occurrence of model.occurrences) {
    const entries = occurrencesByItem.get(occurrence.itemId) || [];
    entries.push(occurrence);
    occurrencesByItem.set(occurrence.itemId, entries);
  }
  const assertions = model.itemResults.map(item => {
    const occurrences = occurrencesByItem.get(item.id) || [];
    const evidenceIds = [...new Set(occurrences.flatMap(occurrence => occurrence.evidenceIds))];
    return {
      assertor: { id: 'urn:audita-mt:software', type: `${EARL}Software`, name: 'Audita MT' },
      subject: { id: model.finalUrl },
      test: { id: `urn:abnt:nbr17225:${item.id}`, title: item.title, wcag: item.wcag.map(reference => reference.id) },
      mode: MODE[item.evaluation],
      result: { outcome: OUTCOME[item.outcome] },
      pointer: occurrences.map(occurrence => ({
        occurrenceId: occurrence.occurrenceId,
        ...(occurrence.nodeId ? { nodeId: occurrence.nodeId } : {}),
        ...(selectorFor(occurrence, artifacts) ? { selector: selectorFor(occurrence, artifacts) } : {}),
      })),
      info: occurrences.map(occurrence => occurrence.justification).filter(Boolean).join(' ')
        || item.humanReason || `Resultado agregado: ${item.outcome}.`,
      evidenceIds,
    };
  });
  return canonicalStringify({
    '@context': { earl: EARL, dct: 'http://purl.org/dc/terms/' },
    schemaVersion: 1,
    audit: model,
    assertions,
  });
}

function selectorFor(occurrence, artifacts) {
  for (const evidenceId of occurrence.evidenceIds) {
    const css = artifacts.get(evidenceId)?.selector?.css;
    if (typeof css === 'string' && css) return css;
  }
  return '';
}
