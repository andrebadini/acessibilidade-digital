// Presentation only: callers provide the already canonical, validated audit.
export const HUMAN_REVIEW_DESCRIPTION = 'Estas conclusões foram registradas pela pessoa avaliadora e valem para as ocorrências indicadas. Não comprovam a identidade informada, não apagam falhas automáticas e não certificam a página inteira.';
export const HUMAN_REVIEW_EMPTY = 'Nenhuma conclusão humana foi registrada nesta revisão do relatório. Isso não significa que a página esteja conforme.';

export function projectReviewHistory(model) {
  const occurrences = new Map(model.occurrences.map(value => [value.occurrenceId, value]));
  const pages = new Map(model.pages.map(value => [value.pageId, value]));
  return model.reviewDecisions.map(decision => {
    const occurrence = occurrences.get(decision.occurrenceId);
    const page = pages.get(occurrence.pageId);
    return {
      ...decision, pageId: occurrence.pageId, pageUrl: page.finalUrl,
      originalOutcome: occurrence.outcome, evidenceRefs: [...occurrence.evidenceRefs],
    };
  }).sort((left, right) => left.decidedAt.localeCompare(right.decidedAt) || left.occurrenceId.localeCompare(right.occurrenceId));
}

export function humanReviewMetadata(entry) {
  const instant = entry.decidedAt;
  const readableTime = `${instant.slice(8, 10)}/${instant.slice(5, 7)}/${instant.slice(0, 4)} às ${instant.slice(11, 23)} UTC`;
  return [
    ['Pessoa avaliadora (nome informado)', entry.evaluator],
    ['Data e hora', readableTime],
    ['Decisão humana', entry.answer],
    ['Página avaliada', entry.pageUrl],
    ['Ocorrência', entry.occurrenceId],
    ['Nota registrada', entry.note || 'Nenhuma nota registrada.'],
  ];
}
