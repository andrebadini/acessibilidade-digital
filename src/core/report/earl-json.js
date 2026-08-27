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
  const artifacts = new Map(model.evidence.map(artifact => [artifact.evidenceId, artifact]));
  const occurrencesByItem = new Map();
  for (const occurrence of model.occurrences) {
    if (!occurrence.nbrItemRef) continue;
    const entries = occurrencesByItem.get(occurrence.nbrItemRef) || [];
    entries.push(occurrence);
    occurrencesByItem.set(occurrence.nbrItemRef, entries);
  }
  const subject = model.requestedScope.mode === 'single'
    ? { id: model.pages[0].finalUrl }
    : {
      id: `urn:audita-mt:audit:${model.auditId}:scope`,
      pages: model.pages.map(page => ({ pageId: page.pageId, id: page.finalUrl })),
    };
  const assertions = model.itemResults.map(item => {
    const occurrences = occurrencesByItem.get(item.id) || [];
    const evidenceIds = [...new Set(occurrences.flatMap(occurrence => occurrence.evidenceRefs))];
    return {
      assertor: { id: 'urn:audita-mt:software', type: `${EARL}Software`, name: 'Audita Acessibilidade' },
      subject,
      test: { id: `urn:abnt:nbr17225:${item.id}`, title: item.title, wcag: item.wcag.map(reference => reference.id) },
      mode: MODE[item.evaluation],
      result: { outcome: OUTCOME[item.outcome] },
      pointer: occurrences.map(occurrence => ({
        occurrenceId: occurrence.occurrenceId,
        pageId: occurrence.pageId,
        ...(occurrence.target.nodeId ? { nodeId: occurrence.target.nodeId } : {}),
        ...(selectorFor(occurrence, artifacts) ? { selector: selectorFor(occurrence, artifacts) } : {}),
      })),
      info: occurrences.map(occurrence => occurrence.justification).filter(Boolean).join(' ')
        || item.humanReason || `Resultado agregado: ${item.outcome}.`,
      evidenceIds,
    };
  });
  return canonicalStringify({
    '@context': { earl: EARL, dct: 'http://purl.org/dc/terms/' },
    schemaVersion: 2,
    identity: {
      name: 'Audita Acessibilidade',
      description: 'Auditoria independente de acessibilidade',
      independent: true,
      disclaimer: 'Ferramenta independente, sem vínculo institucional; não equivale a certificação nem a laudo oficial.',
    },
    audit: model,
    assertions,
  });
}

function selectorFor(occurrence, artifacts) {
  if (occurrence.target.selector) return occurrence.target.selector;
  for (const evidenceId of occurrence.evidenceRefs) {
    const css = artifacts.get(evidenceId)?.selector?.css;
    if (typeof css === 'string' && css) return css;
  }
  return '';
}
