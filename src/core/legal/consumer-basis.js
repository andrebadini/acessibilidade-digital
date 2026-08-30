import { NBR17225_ITEMS } from '../normative/nbr17225.js';
import { createReviewDecision } from '../review/decisions.js';

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value) || Object.isFrozen(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

const ABNT_ITEM_IDS = new Set(NBR17225_ITEMS.map(item => item.id));

export const CONSUMER_ACCESSIBILITY_FIXED_BASIS = deepFreeze({
  id: 'br.consumer.accessibility.fixed.v1',
  version: '1',
  label: 'Base consumerista padronizada para análise',
  sentencePrefix: 'A referida desconformidade infringe o disposto nos arts. 7º, caput, 20, § 2º, e 39, VIII, da Lei nº 8.078/1990, c/c o art. 12, IX, “a”, do Decreto nº 2.181/1997',
  display: 'Arts. 7º, caput, 20, § 2º, e 39, VIII, da Lei nº 8.078/1990, c/c art. 12, IX, “a”, do Decreto nº 2.181/1997.',
  qualification: 'Referência normativa automatizada; não constitui conclusão automática de infração, responsabilidade, sanção, certificação jurídica ou dispensa de revisão humana.',
  sources: [
    {
      id: 'br.cdc.law8078', publisher: 'Câmara dos Deputados', title: 'Lei nº 8.078/1990',
      url: 'https://www2.camara.leg.br/legin/fed/lei/1990/lei-8078-11-setembro-1990-365086-normaatualizada-pl.html',
      verifiedAt: '2026-08-29',
    },
    {
      id: 'br.decree2181.art12.ix.a', publisher: 'Câmara dos Deputados', title: 'Decreto nº 2.181/1997, art. 12, IX, “a”',
      url: 'https://www2.camara.leg.br/legin/fed/decret/1997/decreto-2181-20-marco-1997-445015-normaatualizada-pe.html',
      verifiedAt: '2026-08-29',
    },
  ]
});

/** Brazilian legal references are isolated from foreign technical benchmarks. */
export const BRAZILIAN_LEGAL_BASIS = deepFreeze({
  consumerAccessibilityFixed: CONSUMER_ACCESSIBILITY_FIXED_BASIS
});

function abntItemId(occurrence) {
  const reference = occurrence?.nbrItemRef ?? occurrence?.itemId;
  const id = typeof reference === 'string' ? reference : reference?.id;
  return typeof id === 'string' && ABNT_ITEM_IDS.has(id) ? id : null;
}

/**
 * Returns the fixed analysis basis only for a conclusive technical failure
 * tied to an official ABNT item. It never determines an infraction or remedy.
 */
export function consumerBasisForOccurrence(occurrence) {
  if (!occurrence || occurrence.outcome !== 'failed' || !abntItemId(occurrence)) return null;
  return CONSUMER_ACCESSIBILITY_FIXED_BASIS;
}

function officialItem(item, normativeItems) {
  if (normativeItems !== NBR17225_ITEMS || !Object.isFrozen(normativeItems) || !Object.isFrozen(item)) return null;
  return normativeItems.find(candidate => candidate === item && ABNT_ITEM_IDS.has(candidate.id)) ?? null;
}

function occurrenceItemId(occurrence) {
  const reference = occurrence?.nbrItemRef ?? occurrence?.itemId;
  return typeof reference === 'string' ? reference : reference?.id;
}

function canonicalNonconformingDecision(decision, occurrence, item) {
  try {
    const canonical = createReviewDecision(decision);
    return canonical.occurrenceId === occurrence.occurrenceId && canonical.itemId === item.id &&
      canonical.answer === 'não conforme' && typeof canonical.note === 'string' && canonical.note.length > 0
      ? canonical
      : null;
  } catch { return null; }
}

export function qualifiedConsumerReference({ occurrence, item, displayOutcome, decision, normativeItems } = {}) {
  try {
    const canonicalItem = officialItem(item, normativeItems);
    if (!canonicalItem || displayOutcome !== 'failed' || !occurrence || occurrenceItemId(occurrence) !== canonicalItem.id ||
      !['requirement', 'recommendation'].includes(canonicalItem.classification) ||
      !['requirement', 'recommendation'].includes(occurrence.classification)) return null;
    const originalEligible = occurrence.outcome === 'failed' &&
      occurrence.legalAnalysis?.basisRef === CONSUMER_ACCESSIBILITY_FIXED_BASIS.id;
    const reviewedEligible = occurrence.outcome === 'cantTell' &&
      canonicalNonconformingDecision(decision, occurrence, canonicalItem) !== null;
    if (!originalEligible && !reviewedEligible) return null;
    return deepFreeze({
      label: 'Referência técnica e jurídica qualificada',
      text: `${CONSUMER_ACCESSIBILITY_FIXED_BASIS.sentencePrefix}, e no item ${canonicalItem.id} da ABNT NBR 17225:2025.`,
      qualification: CONSUMER_ACCESSIBILITY_FIXED_BASIS.qualification,
      sources: CONSUMER_ACCESSIBILITY_FIXED_BASIS.sources.map(source => ({ ...source })),
    });
  } catch { return null; }
}
