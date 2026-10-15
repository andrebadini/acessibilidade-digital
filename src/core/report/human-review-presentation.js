import { ANSWER_LABELS, CLASSIFICATION_WORDS, describeEvidenceElement, formatLocalInstant } from './lay-review.js';
import { reviewMarksRecords } from './review-marks-presentation.js';

// Presentation only: callers provide the already canonical, validated audit.
export const HUMAN_REVIEW_DESCRIPTION = 'Estas conclusões foram registradas pela pessoa avaliadora e valem para as ocorrências indicadas. Não comprovam a identidade informada, não apagam falhas automáticas e não certificam a página inteira.';
export const HUMAN_REVIEW_EMPTY = 'Nenhuma conclusão humana foi registrada nesta revisão do relatório. Isso não significa que a página esteja conforme.';

function elementLabel(occurrence, evidenceById) {
  const refs = Array.isArray(occurrence?.evidenceRefs) ? occurrence.evidenceRefs : [];
  const nodeId = occurrence?.target?.nodeId;
  const artifacts = refs.map(id => evidenceById.get(id)).filter(Boolean);
  const evidence = artifacts.find(value => value.kind === 'element' && value.nodeId === nodeId) ??
    artifacts.find(value => value.kind === 'element');
  return describeEvidenceElement(evidence)?.label ?? null;
}

export function projectReviewHistory(model) {
  const occurrences = new Map(model.occurrences.map(value => [value.occurrenceId, value]));
  const pages = new Map(model.pages.map(value => [value.pageId, value]));
  const items = new Map((model.itemResults ?? []).map(value => [value.id, value]));
  const evidenceById = new Map((model.evidence ?? []).map(value => [value.evidenceId, value]));
  // Apontamento no mapa do teclado (quando a decisão apontou itens sem caixa ou marcou áreas): chega
  // pronto em texto e em recortes, para as duas rotas de relatório mostrarem o mesmo.
  const marksByDecision = new Map(reviewMarksRecords(model).map(record => [record.decisionId, record]));
  return model.reviewDecisions.map(decision => {
    const occurrence = occurrences.get(decision.occurrenceId);
    const page = pages.get(occurrence.pageId);
    const item = items.get(decision.itemId);
    return {
      ...decision, pageId: occurrence.pageId, pageUrl: page.finalUrl,
      originalOutcome: occurrence.outcome, evidenceRefs: [...occurrence.evidenceRefs],
      itemTitle: item?.title ?? null, itemClassification: item?.classification ?? null,
      element: elementLabel(occurrence, evidenceById), timezone: model.timezone ?? 'UTC',
      marksRecord: marksByDecision.get(decision.decisionId) ?? null,
    };
  }).sort((left, right) => left.decidedAt.localeCompare(right.decidedAt) || left.occurrenceId.localeCompare(right.occurrenceId));
}

export function humanReviewHeading(entry) {
  const title = entry.itemTitle ? ` — ${entry.itemTitle}` : '';
  const classification = CLASSIFICATION_WORDS[entry.itemClassification] ? ` (${CLASSIFICATION_WORDS[entry.itemClassification]})` : '';
  return `Item ${entry.itemId} da ABNT NBR 17225:2025${title}${classification}`;
}

export function humanReviewMetadata(entry) {
  const timezone = entry.timezone ?? 'UTC';
  const rows = [
    ['Pessoa avaliadora (nome informado)', entry.evaluator],
    ['Data e hora', formatLocalInstant(entry.decidedAt, timezone)],
    ['Decisão humana', ANSWER_LABELS[entry.answer] ?? entry.answer],
    ['Página avaliada', entry.pageUrl],
  ];
  if (entry.element) rows.push(['Elemento', entry.element]);
  rows.push(['Ocorrência', entry.occurrenceId]);
  rows.push(['Nota registrada', entry.note || 'Nenhuma nota registrada.']);
  // O que a pessoa apontou no mapa vira texto do próprio registro: "Itens apontados: …" e
  // "Áreas marcadas no mapa do teclado: N".
  if (entry.marksRecord?.text) rows.push(['Apontamento no mapa do teclado', entry.marksRecord.text]);
  for (const [index, revision] of (entry.revisions ?? []).entries()) {
    rows.push([`Resposta anterior ${index + 1} (substituída)`,
      `${ANSWER_LABELS[revision.answer] ?? revision.answer} — ${revision.evaluator}, ${formatLocalInstant(revision.decidedAt, timezone)}${revision.note ? `. Nota: ${revision.note}` : ''}`]);
  }
  return rows;
}
