// Presentation only: a page observation period is not an individual capture timestamp.
export function projectEvidenceProvenance(evidence, pages) {
  const matches = pages.filter(page => page.pageId === evidence.pageId);
  const page = matches.length === 1 ? matches[0] : null;
  return Object.freeze({
    pageUrl: page?.finalUrlObserved === true ? page.finalUrl ?? null : null,
    startedAt: page?.timestamps?.startedAt ?? null,
    endedAt: page?.timestamps?.endedAt ?? null,
  });
}

export function evidenceProvenanceRows(evidence) {
  const provenance = evidence.provenance;
  return [
    ['URL da página observada', provenance?.pageUrl ?? 'indisponível'],
    ['Período observado da página', provenance?.startedAt && provenance?.endedAt
      ? `${provenance.startedAt} – ${provenance.endedAt}` : 'indisponível'],
    ['Instante individual da captura', 'não registrado'],
    ['URL da mídia', evidence.mediaUrl ?? 'não registrada'],
  ];
}
