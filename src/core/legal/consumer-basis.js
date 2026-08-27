import { NBR17225_ITEMS } from '../normative/nbr17225.js';

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
  display: 'Arts. 7º, caput, 20, § 2º, e 39, VIII, da Lei nº 8.078/1990, c/c art. 12, IX, “a”, do Decreto nº 2.181/1997.',
  qualification: 'A referência padronizada não constitui conclusão automática de infração, responsabilidade ou sanção; a incidência depende da qualificação jurídica do alvo e dos fatos do caso concreto.',
  currentTextCaveatRef: 'br.law13874.art3.vi',
  sources: [
    { id: 'br.cdc.law8078', publisher: 'Câmara dos Deputados', title: 'Lei nº 8.078/1990' },
    { id: 'br.decree2181.art12.ix.a', publisher: 'Câmara dos Deputados', title: 'Decreto nº 2.181/1997, art. 12, IX, “a”' },
    { id: 'br.law13874.art3.vi', publisher: 'Câmara dos Deputados', title: 'Lei nº 13.874/2019, art. 3º, VI' }
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
