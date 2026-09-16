const NORMATIVE_CLASSIFICATIONS = new Set(['requirement', 'recommendation']);
const TONE_ORDER = Object.freeze(['failed', 'advisory', 'review']);

export const EVIDENCE_TREATMENTS_V1 = Object.freeze({
  failed: Object.freeze({
    tone: 'failed',
    aria: 'com falha confirmada destacada por moldura vermelha sólida.',
    legend: '✕ Falha confirmada — moldura vermelha sólida sobre o elemento.',
  }),
  review: Object.freeze({
    tone: 'review',
    aria: 'com revisão humana necessária destacada por moldura âmbar tracejada.',
    legend: '? Revisão humana necessária — moldura âmbar tracejada sobre o elemento.',
  }),
  advisory: Object.freeze({
    tone: 'advisory',
    aria: 'com recomendação não atendida destacada por moldura âmbar sólida.',
    legend: '! Recomendação não atendida — moldura âmbar sólida; não é falha de requisito obrigatório.',
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
  if (answer === 'conforme') return null;
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
