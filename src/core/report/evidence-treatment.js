const NORMATIVE_CLASSIFICATIONS = new Set(['requirement', 'recommendation']);
const TONE_ORDER = Object.freeze(['failed', 'advisory', 'review']);

// A legenda começa pela cor do contorno: quem não distingue os tons lê a mesma informação no texto, e
// quem lê a imagem antes do texto sabe o que procurar. O contorno é desenhado **por fora** do
// elemento (`evidence-highlight.js`), então nenhuma frase promete uma moldura sobre o conteúdo.
export const EVIDENCE_TREATMENTS_V1 = Object.freeze({
  failed: Object.freeze({
    tone: 'failed',
    aria: 'captura do elemento com falha, contornado em vermelho por fora do elemento.',
    legend: 'Contorno vermelho: elemento com falha.',
  }),
  review: Object.freeze({
    tone: 'review',
    aria: 'captura do elemento pendente de revisão humana, contornado em âmbar tracejado por fora do elemento.',
    legend: 'Contorno âmbar tracejado: elemento que precisa de revisão humana.',
  }),
  advisory: Object.freeze({
    tone: 'advisory',
    aria: 'captura do elemento com recomendação não atendida, contornado em âmbar sólido por fora do elemento.',
    legend: 'Contorno âmbar sólido: recomendação não atendida; não é falha de requisito obrigatório.',
  }),
  passed: Object.freeze({
    tone: 'passed',
    aria: 'captura do elemento com atendimento confirmado na revisão, contornado em azul por fora do elemento.',
    legend: 'Contorno azul: atendimento confirmado na revisão.',
  }),
});

function treatmentTone(occurrence) {
  if (!occurrence || typeof occurrence !== 'object' ||
    !NORMATIVE_CLASSIFICATIONS.has(occurrence.classification)) return null;
  const answer = occurrence.decision?.answer;
  // The human verdict is the decision, in the twelve places across the product that read it: a
  // person who answered "não conforme" confirmed the failure and recorded who did it and when. The
  // note is a separate requirement, demanded only where the report emits the short nonconformity
  // reference, which is a legal statement rather than a presentation one. Gating the visual
  // treatment on the note, as an earlier revision of this file did, made the picture disagree with
  // every other surface about the same decision, including the summary grouping.
  if (occurrence.outcome === 'failed' || answer === 'não conforme') {
    return occurrence.classification === 'recommendation' ? 'advisory' : 'failed';
  }
  if (answer === 'conforme' || answer === 'não se aplica') return null;
  if (occurrence.outcome === 'cantTell' || answer === 'não foi possível determinar') return 'review';
  return null;
}

export function projectOccurrenceEvidencePreviews({ evidence, occurrences } = {}) {
  if (!Array.isArray(evidence) || !Array.isArray(occurrences)) {
    throw new TypeError('EVIDENCE_PREVIEW_INPUT_INVALID');
  }
  const elementById = new Map(evidence
    .filter(artifact => artifact?.kind === 'element' && typeof artifact.evidenceId === 'string')
    .map(artifact => [artifact.evidenceId, artifact]));
  const tonesByEvidenceId = new Map();
  for (const occurrence of occurrences) {
    const tone = treatmentTone(occurrence);
    if (!tone || !Array.isArray(occurrence?.evidenceRefs)) continue;
    for (const evidenceId of occurrence.evidenceRefs) {
      if (!elementById.has(evidenceId)) continue;
      const tones = tonesByEvidenceId.get(evidenceId) ?? new Set();
      tones.add(tone);
      tonesByEvidenceId.set(evidenceId, tones);
    }
  }
  const entries = [];
  for (const artifact of elementById.values()) {
    const tones = tonesByEvidenceId.get(artifact.evidenceId);
    if (!tones || tones.size === 0) entries.push(Object.freeze({ artifact, tone: null }));
    else for (const tone of TONE_ORDER) {
      if (tones.has(tone)) entries.push(Object.freeze({ artifact, tone }));
    }
  }
  const fullPage = evidence.find(artifact => artifact?.kind === 'full-page' && typeof artifact.evidenceId === 'string');
  if (fullPage) entries.push(Object.freeze({ artifact: fullPage, tone: null }));
  return Object.freeze(entries);
}
