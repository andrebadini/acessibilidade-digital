import { consumerBasisForOccurrence, CONSUMER_ACCESSIBILITY_FIXED_BASIS } from '../legal/consumer-basis.js';
import { sanitizeResourceUrl } from '../normalize-snapshot.js';
import { SECTION508_REVISED_CROSSWALK } from '../normative/section508.js';
import { WCAG22_LEVELS } from '../normative/wcag22.js';
import { createAuditModel } from './audit-model.js';
import { REPORT_CSS, REPORT_CSS_CSP_HASH } from './report.css.js';
import { REPORT_SCRIPT, REPORT_SCRIPT_CSP_HASH } from './report.js.js';
import { EVIDENCE_TREATMENTS_V1, projectOccurrenceEvidencePreviews } from './evidence-treatment.js';
import { decodePngDataUrl } from '../evidence/png.js';
import { ANNOTATION_MAP_PRINTABLE_ASPECT_RATIO } from '../evidence/annotation-map-artifact.js';
import { createExportDeliveryIdentityV1 } from '../../export/export-formats.js';

const OUTCOME = Object.freeze({
  passed: { label: 'Atendido no escopo observado', icon: '✓' },
  failed: { label: 'Não atendido neste teste', icon: '✕' },
  cantTell: { label: 'Requer revisão humana', icon: '?' },
  untested: { label: 'Não testado', icon: '!' },
  inapplicable: { label: 'Não aplicável', icon: '—' },
});

const CLASSIFICATION = Object.freeze({
  requirement: 'Requisito ABNT',
  recommendation: 'Recomendação ABNT',
  'best-practice': 'Boa prática suplementar',
  editorial: 'Alerta editorial',
});

const IMPACT = Object.freeze({
  critical: 'Crítico', serious: 'Alto', moderate: 'Moderado', minor: 'Menor',
});

const PAGE_STATUS = Object.freeze({
  complete: 'Completa', partial: 'Parcial', failed: 'Falhou', cancelled: 'Cancelada',
});

const ANNOTATION_MAP_LIMITATION_LABELS = Object.freeze({
  'observed-dom-ax-order-not-literal-assistive-technology': 'ordem DOM/AX observada; não representa fala literal nem ordem de foco',
  'non-atomic-source-geometry': 'captura e geometria foram coletadas em instantes distintos',
  'top-document-open-shadow-only': 'somente o documento superior e Shadow DOM aberto foram compostos',
  'rasterization-browser-dependent': 'a rasterização pode variar conforme navegador e sistema operacional',
  'source-capture-may-contain-personal-data': 'a captura original pode conter dados pessoais visíveis',
  'frame-content-omitted': 'conteúdo de frames foi omitido',
  'closed-shadow-root-omitted': 'conteúdo de Shadow DOM fechado foi omitido',
  'node-limit-reached': 'o limite de elementos anotados foi atingido',
  'legend-limit-reached': 'o limite de legenda ou segmentos foi atingido',
  'unresolved-marker-overlap': 'uma ou mais sobreposições de marcadores permaneceram',
  'non-uniform-pixel-scale': 'as escalas horizontal e vertical da captura não são uniformes',
});

const OUTCOME_PRIORITY = Object.freeze({ failed: 0, cantTell: 1, passed: 2, untested: 3, inapplicable: 4 });
const IMPACT_PRIORITY = Object.freeze({ critical: 0, serious: 1, moderate: 2, minor: 3 });
const REPORT_WCAG_LEVEL_ORDER = Object.freeze(['A', 'AA', 'AAA']);
const REPORT_NO_ABNT_ITEM = '__none__';
const REPORT_NO_ABNT_ITEM_LABEL = 'Sem item ABNT associado';

function reportWcagLevels(criteria) {
  const levels = new Set((Array.isArray(criteria) ? criteria : [])
    .map(criterion => typeof criterion === 'string' ? WCAG22_LEVELS[criterion] : undefined)
    .filter(level => REPORT_WCAG_LEVEL_ORDER.includes(level)));
  return REPORT_WCAG_LEVEL_ORDER.filter(level => levels.has(level));
}

function reportAbntItemsLabel(values) {
  const items = (Array.isArray(values) ? values : []).filter(value => typeof value === 'string' && value);
  return items.length > 0 ? items.join(', ') : REPORT_NO_ABNT_ITEM_LABEL;
}

function reportAbntItemLabel(value) {
  return typeof value === 'string' && value ? value : REPORT_NO_ABNT_ITEM_LABEL;
}

function reportAbntFilterToken(values) {
  const items = (Array.isArray(values) ? values : []).filter(value => typeof value === 'string' && value);
  return items.length > 0 ? items.join(' ') : REPORT_NO_ABNT_ITEM;
}

export function renderHtmlReport(input, options = {}) {
  const model = createAuditModel(input);
  if (options?.reportView !== undefined) return renderReportViewDocument(model, options.reportView, options);
  const itemById = new Map(model.itemResults.map(item => [item.id, item]));
  const pageById = new Map(model.pages.map(page => [page.pageId, page]));
  const ruleById = new Map(model.ruleResults.map(rule => [rule.ruleId, rule]));
  const artifactById = new Map(model.evidence.map(artifact => [artifact.evidenceId, artifact]));
  const reviewByOccurrence = new Map(model.manualReview.map(entry => [entry.occurrenceId, entry]));
  const decisionByOccurrence = new Map(model.reviewDecisions.map(decision => [decision.occurrenceId, decision]));
  const imageRegistry = createImageRegistry(model.evidence);
  const orderedOccurrences = prioritizeOccurrences(model.occurrences, model.pages, decisionByOccurrence);
  const csp = [
    "default-src 'none'", "img-src data:", `style-src '${REPORT_CSS_CSP_HASH}'`, `script-src '${REPORT_SCRIPT_CSP_HASH}'`,
    "connect-src 'none'", "object-src 'none'", "frame-src 'none'", "font-src 'none'", "media-src 'none'",
    "worker-src 'none'", "base-uri 'none'", "form-action 'none'",
  ].join('; ');

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>Relatório de auditoria — Audita Acessibilidade</title>
<style>${REPORT_CSS}</style>
</head>
<body>
${imageDefinitions(imageRegistry.definitions)}
<a class="skip-link" href="#conteudo">Ir para o conteúdo principal</a>
${header()}
<main id="conteudo">
<h1>Relatório de auditoria de acessibilidade</h1>
<p class="lead">Resultados técnicos, evidências e pendências de revisão do escopo observado. Este relatório não declara conformidade integral, não gera indicador numérico e não substitui avaliação humana.</p>
${sectionNavigation()}
${scopeSection(model)}
${executiveSummary(model, decisionByOccurrence)}
${filterSection(model, orderedOccurrences)}
${occurrenceSection(orderedOccurrences, { itemById, pageById, ruleById, artifactById, reviewByOccurrence, decisionByOccurrence, imageByEvidenceId: imageRegistry.byEvidenceId })}
${announcementMaps(model, imageRegistry.byEvidenceId)}
${humanReviewSection(model, itemById, decisionByOccurrence, orderedOccurrences)}
${widgetInventory(model)}
${itemMatrix(model)}
${evidenceAnnex(model, imageRegistry.byEvidenceId)}
${methodologySection(model)}
</main>
<footer class="report-footer"><p>Audita Acessibilidade — relatório local da auditoria ${escapeHtml(model.auditId)}.</p><p>Gerado em ${escapeHtml(model.timestamps.generatedAt)} (${escapeHtml(model.timezone)}).</p></footer>
<script>${REPORT_SCRIPT}</script>
</body>
</html>`;
}

function renderReportViewDocument(model, view, options = {}) {
  if (!view || view.version !== 1 || view.auditId !== model.auditId ||
    view.modelHash !== model.integrity.canonicalModelHash || !Object.isFrozen(view) ||
    !Array.isArray(view.matrix) || view.matrix.length !== 146) {
    throw new TypeError('ReportViewV1 inválida para exportação.');
  }
  const deliveryIdentity = options.deliveryIdentity === undefined ? null : createExportDeliveryIdentityV1(options.deliveryIdentity);
  const csp = [
    "default-src 'none'", "img-src data:", `style-src '${REPORT_CSS_CSP_HASH}'`,
    "connect-src 'none'", "object-src 'none'", "frame-src 'none'", "font-src 'none'", "media-src 'none'",
    "worker-src 'none'", "base-uri 'none'", "form-action 'none'",
  ].join('; ');
  const evidenceById = new Map(view.technicalEvidence.map(evidence => [evidence.evidenceId, evidence]));
  const evidenceAnchorById = new Map(view.technicalEvidence.map((evidence, index) => [evidence.evidenceId, `report-evidence-${index + 1}`]));
  const groupLabels = Object.freeze({ failed: 'Não conformidades', alerts: 'Alertas', humanReview: 'Revisões humanas pendentes', passed: 'Resultados positivos' });
  const outcomeLabels = Object.freeze({ failed: 'Não atendido neste teste', passed: 'Atendido no escopo observado', cantTell: 'Requer revisão humana', inapplicable: 'Não aplicável', untested: 'Não testado' });
  const impactLabels = Object.freeze({ critical: 'Crítico', serious: 'Alto', moderate: 'Moderado', minor: 'Menor' });
  const statusLabels = Object.freeze({ pending: 'Pendente', complete: 'Concluída', partial: 'Concluída com limitações', cancelled: 'Cancelada', failed: 'Falhou' });
  const classificationLabels = Object.freeze({ failed: 'Não conformidade identificada', alerts: 'Alerta', 'manual-review': 'Revisão humana necessária', passed: 'Resultado positivo', requirement: 'Requisito ABNT', recommendation: 'Recomendação ABNT', 'best-practice': 'Boa prática suplementar', editorial: 'Alerta editorial' });
  const evidenceKindLabels = Object.freeze({ 'full-page': 'Página completa', element: 'Elemento', 'announcement-map': 'Mapa de anúncios' });
  const countLabel = (count, singular, plural) => `${count} ${count === 1 ? singular : plural}`;
  const label = (value, dictionary, fallback = 'Não informado') => dictionary[value] ?? fallback;
  const safePng = value => typeof value === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/u.test(value);
  const metric = group => {
    const counts = view.executive.counts[{ failed: 'errors', alerts: 'alerts', humanReview: 'humanReview', passed: 'positive' }[group]];
    const detail = `${countLabel(counts.checkKeys, 'verificação', 'verificações')} · ${countLabel(counts.occurrences, 'ocorrência', 'ocorrências')}`;
    return `<article class="summary-card" data-report-metric="${escapeHtml(group)}"><strong>${counts.checkKeys}</strong><span>${escapeHtml(groupLabels[group])}</span><small>${escapeHtml(detail)}</small></article>`;
  };
  const correlatedEvidence = issue => {
    const ids = new Set(issue.occurrences.flatMap(occurrence => occurrence.evidenceRefs));
    return [...evidenceById.values()].filter(evidence => ids.has(evidence.evidenceId));
  };
  const plainBlock = (name, title, body) => `<section class="issue-plain-block" data-report-plain-block="${name}"><h4>${title}</h4>${body}</section>`;
  const evidencePreview = (evidence, issue) => {
    const selected = projectOccurrenceEvidencePreviews({
      evidence: evidence.filter(item => safePng(item.dataUrl)),
      occurrences: issue.occurrences,
    });
    const previews = selected.length === 0
      ? '<p>Nenhuma captura PNG local está disponível para esta verificação.</p>'
      : selected.map(({ artifact: item, tone }) => {
        const accessibleLabel = `${label(item.kind, evidenceKindLabels, 'Evidência registrada')} local da evidência ${item.evidenceId}`;
        const treatment = item.kind === 'element' && tone ? EVIDENCE_TREATMENTS_V1[tone] : null;
        const png = treatment ? pngMetadata(item.dataUrl) : null;
        if (!treatment || !png) {
          return `<figure data-evidence-kind="${escapeHtml(item.kind)}"><img class="evidence-media" src="${escapeHtml(item.dataUrl)}" alt="${escapeHtml(accessibleLabel)}"><figcaption>${escapeHtml(accessibleLabel)}.</figcaption></figure>`;
        }
        const width = finitePositive(item.metadata?.width) || png.width;
        const height = finitePositive(item.metadata?.height) || png.height;
        const box = highlightBox(item, width, height);
        return `<figure data-evidence-kind="${escapeHtml(item.kind)}"><svg class="evidence-media evidence-media--marked" data-evidence-treatment="${treatment.tone}" role="img" aria-label="${escapeHtml(`${accessibleLabel} ${treatment.aria}`)}" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" preserveAspectRatio="xMidYMid meet" focusable="false"><image href="${escapeHtml(item.dataUrl)}" width="${width}" height="${height}" preserveAspectRatio="xMidYMid meet"></image><rect class="evidence-highlight evidence-highlight--${treatment.tone}" data-evidence-highlight="${treatment.tone}" x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" aria-hidden="true"></rect></svg><figcaption>${escapeHtml(`${treatment.legend} ${accessibleLabel}.`)}</figcaption></figure>`;
      }).join('');
    return `<section data-report-evidence-preview><h4>Capturas registradas</h4>${previews}</section>`;
  };
  const technicalDetails = (issue, evidence) => `<details data-report-technical><summary>Ver detalhes técnicos</summary><p>Resultado original: ${escapeHtml(label(issue.originalOutcome, outcomeLabels))}. Resultado consolidado: ${escapeHtml(label(issue.displayOutcome, outcomeLabels))}.</p><p><strong>Contexto técnico:</strong> ${escapeHtml(issue.context ?? 'não registrado')}. <strong>Página:</strong> ${escapeHtml(issue.pageId)}.</p>${issue.occurrences.map(occurrence => `<section data-report-occurrence-technical="${escapeHtml(occurrence.occurrenceId)}"><h4>ID da ocorrência: ${escapeHtml(occurrence.occurrenceId)}</h4><p><strong>Proveniência:</strong> Página ${escapeHtml(issue.pageId)}; Motor ${escapeHtml(occurrence.source.engine)}; Regra ${escapeHtml(occurrence.source.ruleId)}; Versão ${escapeHtml(occurrence.source.version)}.</p><p><strong>Item ABNT:</strong> ${escapeHtml(reportAbntItemLabel(occurrence.itemId))}. <strong>Classificação:</strong> ${escapeHtml(label(occurrence.classification, classificationLabels))}.</p></section>`).join('')}${evidence.map(item => `<section data-report-occurrence-evidence="${escapeHtml(item.evidenceId)}"><h4>ID da evidência: ${escapeHtml(item.evidenceId)} — ${escapeHtml(label(item.kind, evidenceKindLabels, 'Evidência registrada'))}</h4><p><strong>Proveniência:</strong> página ${escapeHtml(item.pageId)}; tipo ${escapeHtml(item.kind)}; estado ${escapeHtml(item.state ?? 'não registrado')}.</p><p><strong>URL:</strong> ${escapeHtml(item.mediaUrl ?? 'não registrada')}</p><p><strong>Horário:</strong> ${escapeHtml(item.observedAt ?? 'não registrado')}</p><p><strong>Seletor:</strong> ${escapeHtml(item.selector?.css ?? 'não registrado')}</p><p><strong>Snippet:</strong> ${escapeHtml(item.snippet ?? 'não disponível')}</p><p><strong>Hash:</strong> ${escapeHtml(item.hash ?? 'não disponível')}</p></section>`).join('')}</details>`;
  const issueCard = (issue, group) => {
    const evidence = correlatedEvidence(issue);
    const correctionPresentation = group === 'passed'
      ? { title: 'Orientação e manutenção', confirmation: 'mantenha este registro como evidência positiva do escopo observado e reavalie se a página mudar.' }
      : group === 'humanReview'
        ? { title: 'Como revisar e concluir', confirmation: 'registre a decisão humana, a justificativa e as evidências consideradas.' }
        : group === 'alerts'
          ? { title: 'Como analisar e tratar', confirmation: 'registre se a análise confirmou uma barreira e repita a auditoria somente após eventual correção.' }
          : { title: 'Como corrigir e confirmar', confirmation: 'repita a verificação após a correção.' };
    const legalReferences = issue.occurrences.map(occurrence => occurrence.legalReference).filter(Boolean);
    const legal = legalReferences.length === 0 ? '' : plainBlock('legal', 'Fundamentação legal qualificada', legalReferences.map(reference => `<p><strong>${escapeHtml(reference.label)}:</strong> ${escapeHtml(reference.text)} ${escapeHtml(reference.qualification)}</p>`).join(''));
    const firstAnchor = evidence.map(item => evidenceAnchorById.get(item.evidenceId)).find(Boolean);
    const evidenceLink = firstAnchor
      ? `<a data-report-consult-evidence href="#${firstAnchor}">Consultar evidências registradas</a>`
      : '<p>Nenhuma evidência correlata foi registrada para esta verificação.</p>';
    return `<article class="occurrence-card" data-report-issue data-result="${escapeHtml(group)}" data-classification="${escapeHtml(issue.classification)}" data-page="${escapeHtml(issue.pageId)}" data-engine="${escapeHtml(issue.engine)}" data-impact="${escapeHtml(issue.impact ?? 'none')}" data-wcag="${escapeHtml(reportWcagLevels(issue.wcag).join(' '))}" data-abnt="${escapeHtml(reportAbntFilterToken(issue.abntItemIds))}"><header data-report-issue-heading><h3>${escapeHtml(issue.title)}</h3><p><strong>Estado consolidado:</strong> ${escapeHtml(label(issue.displayOutcome, outcomeLabels))}.</p><p><strong>Classificação:</strong> ${escapeHtml(label(issue.classification, classificationLabels))}. <strong>Impacto:</strong> ${escapeHtml(label(issue.impact, impactLabels, 'Não aplicável'))}.</p></header>${plainBlock('impact', 'Impacto para a pessoa usuária', `<p>${escapeHtml(issue.plainLanguage.impact)}</p>`)}${plainBlock('observed', 'O que foi observado', `<ul>${issue.plainLanguage.observed.map(value => `<li>${escapeHtml(value)}</li>`).join('') || '<li>Nenhuma justificativa adicional foi registrada.</li>'}</ul>`)}${plainBlock('correction', correctionPresentation.title, `<p><strong>Correção:</strong> ${escapeHtml(issue.plainLanguage.correction)}</p><p><strong>Confirmação:</strong> ${escapeHtml(correctionPresentation.confirmation)}</p>`)}${plainBlock('announcement', 'Nome acessível e anúncio estimado', `<p><strong>Nome acessível:</strong> ${escapeHtml(issue.accessibleName ?? 'não disponível')}.</p><p><strong>Anúncio estimado:</strong> ${escapeHtml(issue.announcement ?? 'indisponível')}.</p><p>Esta prévia não é transcrição literal de tecnologia assistiva e pode variar conforme o leitor e as preferências.</p>`)}${plainBlock('normative', 'Fundamentação normativa', `<p><strong>WCAG 2.2:</strong> ${escapeHtml(issue.wcag.join(', ') || 'sem referência')}. <strong>ABNT NBR 17225:</strong> ${escapeHtml(reportAbntItemsLabel(issue.abntItemIds))}.</p>`)}${legal}${evidencePreview(evidence, issue)}<p data-report-live-action="evidence-only">O destaque ao vivo não está disponível neste relatório. Consulte as capturas registradas no momento da auditoria.</p>${evidenceLink}${technicalDetails(issue, evidence)}</article>`;
  };
  const issueCards = group => view.issues[group].map(issue => issueCard(issue, group)).join('');
  const section = (index, body) => `<section id="report-section-${index + 1}" aria-labelledby="report-heading-${index + 1}"><h2 id="report-heading-${index + 1}">${escapeHtml(viewSectionTitle(index))}</h2>${body}</section>`;
  const delivery = deliveryIdentity === null ? '' : `<p><strong>ExportDeliveryIdentityV1:</strong> auditoria ${escapeHtml(deliveryIdentity.auditId)}; revisão ${deliveryIdentity.modelRevision}; hash ${escapeHtml(deliveryIdentity.modelHash)}; tentativa ${escapeHtml(deliveryIdentity.attemptId)}.</p>`;
  const navigationLabels = ['Sumário', 'Resultados', 'Não conformidades', 'Revisões humanas', 'Anúncios', 'Matriz ABNT', 'Metodologia e evidências'];
  const navigation = `<div data-report-navigation><nav class="section-nav" aria-label="Seções do relatório"><strong>Ir para</strong><ul>${navigationLabels.map((navigationLabel, index) => `<li><a href="#report-section-${index + 1}">${escapeHtml(navigationLabel)}</a></li>`).join('')}</ul></nav></div>`;
  const coverage = view.executive.coverage.status === 'available' ? view.executive.coverage.percent : 'indisponível';
  const annex = view.technicalEvidence.map(evidence => `<article class="evidence-card" id="${evidenceAnchorById.get(evidence.evidenceId)}" data-report-evidence="${escapeHtml(evidence.evidenceId)}" data-evidence-kind="${escapeHtml(evidence.kind)}"><h4>${escapeHtml(evidence.evidenceId)} — ${escapeHtml(label(evidence.kind, evidenceKindLabels, 'Evidência registrada'))}</h4><p><strong>URL:</strong> ${escapeHtml(evidence.mediaUrl ?? 'não registrada')}</p><p><strong>Horário:</strong> ${escapeHtml(evidence.observedAt ?? 'não registrado')}</p><p><strong>Seletor:</strong> ${escapeHtml(evidence.selector?.css ?? 'não registrado')}</p><p><strong>Snippet:</strong> ${escapeHtml(evidence.snippet ?? 'não disponível')}</p>${safePng(evidence.dataUrl) ? `<img class="evidence-media" src="${escapeHtml(evidence.dataUrl)}" alt="${escapeHtml(`${label(evidence.kind, evidenceKindLabels, 'Evidência registrada')} local da evidência ${evidence.evidenceId}`)}">` : '<p><strong>Imagem segura:</strong> PNG local não disponível.</p>'}</article>`).join('');
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${csp}"><title>Relatório de auditoria — Audita Acessibilidade</title><style>${REPORT_CSS}</style></head><body class="report-view-document">${header()}<main id="conteudo"><h1>Relatório de auditoria de acessibilidade</h1><p class="report-static-identity">Escopo avaliado: ${escapeHtml(view.executive.identity.finalUrl)}.</p>
${section(0, `<p data-report-outcome><strong>Estado da auditoria:</strong> ${escapeHtml(label(view.executive.status, statusLabels))}.</p><div data-report-coverage><strong>Cobertura automática: ${escapeHtml(coverage)}.</strong> Mede a execução automática; não é nota, certificação ou declaração de conformidade.</div><div class="summary-grid" data-report-metrics>${['failed','alerts','humanReview','passed'].map(metric).join('')}</div><p>Formatos desta entrega: HTML, PDF, CSV e JSON.</p><details data-report-limitations><summary>Limitações registradas (${view.executive.limitations.length})</summary><ul>${view.executive.limitations.map(value => `<li>${escapeHtml(value)}</li>`).join('') || '<li>Nenhuma limitação crítica registrada.</li>'}</ul></details>`)}
${navigation}<p class="filters-noscript">Este arquivo contém todos os registros; filtros interativos estão disponíveis somente no relatório vivo.</p>
${section(1, `${['failed','alerts','humanReview','passed'].map(group => `<h3>${escapeHtml(groupLabels[group])}: ${view.issues[group].length}</h3><p>As fichas detalhadas aparecem uma única vez nas seções seguintes.</p>${['alerts','passed'].includes(group) ? issueCards(group) : ''}`).join('')}`)}
${section(2, issueCards('failed'))}
${section(3, issueCards('humanReview'))}
${section(4, `<p>As prévias de anúncio são uma estimativa; não são transcrições literais de tecnologia assistiva.</p>${view.readerMaps.map(map => `<article class="map-card"><p><strong>Artefato:</strong> ${escapeHtml(map.evidenceId)}.</p><p><strong>Legenda:</strong> mapa de anúncios da página ${escapeHtml(map.pageId)}.</p></article>`).join('')}`)}
${section(5, `<div class="matrix-scroll" role="region" aria-label="Matriz completa dos 146 itens ABNT" tabindex="0"><table><caption>Matriz completa da ABNT NBR 17225</caption><thead><tr><th scope="col">Item</th><th scope="col">Título</th><th scope="col">Classificação</th><th scope="col">Resultado</th><th scope="col">WCAG</th></tr></thead><tbody>${view.matrix.map(row => `<tr><th scope="row">${escapeHtml(row.id)}</th><td>${escapeHtml(row.title)}</td><td>${escapeHtml(label(row.classification, classificationLabels))}</td><td>${escapeHtml(label(row.outcome, outcomeLabels))}</td><td>${escapeHtml(row.wcag.map(ref => `${ref.id} ${ref.level}`).join(', '))}</td></tr>`).join('')}</tbody></table></div>`)}
${section(6, `${view.methodology.caveats.map(value => `<p>${escapeHtml(value)}</p>`).join('')}<p><strong>Revisão do modelo:</strong> ${view.modelRevision}. <strong>Integridade:</strong> ${escapeHtml(view.modelHash)}.</p>${delivery}<h3>Fontes oficiais</h3><ul>${CONSUMER_ACCESSIBILITY_FIXED_BASIS.sources.map(source => `<li data-official-source>${escapeHtml(source.publisher)} — ${escapeHtml(source.title)} — ${escapeHtml(source.url)}</li>`).join('')}</ul><h3>Evidências técnicas e anexos</h3>${annex}`)}
</main><footer class="report-footer"><p>Audita Acessibilidade — relatório local da auditoria ${escapeHtml(view.auditId)}.</p></footer></body></html>`;
}

function viewSectionTitle(index) {
  return [
    'Sumário executivo e limitações críticas',
    'Cobertura e quatro grupos de resultado',
    'Não conformidades priorizadas',
    'Revisões humanas pendentes',
    'Mapas de anúncios',
    'Matriz completa dos 146 itens',
    'Metodologia, fontes, integridade, evidências técnicas e anexos',
  ][index];
}

function viewSectionNavigation() {
  return `<nav class="section-nav" aria-label="Seções do relatório"><strong>Navegue pelo relatório</strong><ul>${Array.from({ length: 7 }, (_value, index) => `<li><a href="#report-section-${index + 1}">${escapeHtml(viewSectionTitle(index))}</a></li>`).join('')}</ul></nav>`;
}

function header() {
  return '<header class="report-header"><div class="report-header__inner"><p class="product-name">Audita Acessibilidade</p><p class="product-description">Auditoria independente de acessibilidade</p></div></header>';
}

function sectionNavigation() {
  return `<nav class="section-nav" aria-label="Seções do relatório"><strong>Navegue pelo relatório</strong><ul>
<li><a href="#ocorrencias">Ocorrências</a></li><li><a href="#revisao">Revisão humana</a></li><li><a href="#matriz">Matriz ABNT</a></li><li><a href="#anexos">Evidências</a></li><li><a href="#metodologia">Metodologia</a></li>
</ul></nav>`;
}

function scopeSection(model) {
  return `<section id="escopo" aria-labelledby="escopo-titulo"><h2 id="escopo-titulo">Identidade, escopo e estado da auditoria</h2>
<p class="independence-notice"><strong>Independência:</strong> ferramenta independente, sem vínculo institucional; o resultado não equivale a certificação nem a laudo oficial.</p>
<p class="notice"><strong>Integridade temporal:</strong> os horários usam o relógio local do dispositivo e não constituem carimbo de tempo certificado. Os hashes demonstram igualdade entre artefatos, não autoria ou assinatura digital.</p>
<div class="scope-grid">
<article class="scope-card"><h3>Registro</h3><dl class="meta"><dt>Auditoria</dt><dd><code>${escapeHtml(model.auditId)}</code></dd><dt>Status da sessão</dt><dd>${pageStatus(model.session.status)}</dd><dt>Modo solicitado</dt><dd>${model.requestedScope.mode === 'batch' ? 'Lista explícita de páginas' : 'Página única'}</dd></dl></article>
<article class="scope-card"><h3>Período observado</h3><dl class="meta"><dt>Início</dt><dd>${escapeHtml(model.timestamps.startedAt)}</dd><dt>Observada até</dt><dd>${escapeHtml(model.timestamps.endedAt)}</dd><dt>Fuso</dt><dd>${escapeHtml(model.timezone)}</dd></dl></article>
<article class="scope-card"><h3>Cobertura declarada</h3><p>${escapeHtml(model.scope.description)}</p><p><strong>${model.pages.length}</strong> ${model.pages.length === 1 ? 'página registrada' : 'páginas registradas'}.</p></article>
</div>
<div class="page-grid">${model.pages.map((page, index) => pageCard(page, index)).join('')}</div></section>`;
}

function pageCard(page, index) {
  const finalUrl = page.finalUrlObserved
    ? `<code>${escapeHtml(page.finalUrl)}</code>`
    : 'Não observada — a URL solicitada abaixo não foi tratada como URL final.';
  return `<article class="page-card" data-page-summary="${escapeHtml(page.pageId)}"><h3>Página ${index + 1}</h3><p class="page-status">${pageStatus(page.status)}</p><dl class="meta"><dt>Identificador</dt><dd><code>${escapeHtml(page.pageId)}</code></dd><dt>URL solicitada</dt><dd><code>${escapeHtml(page.requestedUrl)}</code></dd><dt>URL final</dt><dd>${finalUrl}</dd><dt>Observada até</dt><dd>${escapeHtml(page.timestamps.endedAt)}</dd></dl></article>`;
}

function executiveSummary(model, decisionByOccurrence) {
  const displayOutcome = occurrence => effectiveOccurrenceOutcome(occurrence, decisionByOccurrence.get(occurrence.occurrenceId));
  const failed = model.occurrences.filter(occurrence => displayOutcome(occurrence) === 'failed' && ['requirement', 'recommendation'].includes(occurrence.classification)).length;
  const review = model.occurrences.filter(occurrence => displayOutcome(occurrence) === 'cantTell').length;
  const supplemental = model.occurrences.filter(occurrence => ['editorial', 'best-practice'].includes(occurrence.classification)).length;
  const constrainedPages = model.pages.filter(page => page.status !== 'complete').length;
  const materialEntries = materialLimitationEntries(model);
  return `<section id="resumo" aria-labelledby="resumo-titulo"><h2 id="resumo-titulo">Sumário executivo</h2>
<p class="section-intro">O sumário conta ocorrências e estados observados; não constitui índice de conformidade ou certificação.</p>
<div class="summary-grid">
${summaryCard('Ocorrências', model.occurrences.length, 'Registros técnicos e editoriais', 'neutral')}
${summaryCard('Não atendidas', failed, 'Desconformidades ABNT conclusivas', 'failed')}
${summaryCard('Revisão humana', review, 'Resultados ainda inconclusivos', 'review')}
${summaryCard('Informativas', supplemental, 'Boa prática ou alerta editorial', 'neutral')}
${summaryCard('Páginas com ressalva', constrainedPages, `De ${model.pages.length} páginas registradas`, constrainedPages ? 'review' : 'neutral')}
</div>
${materialEntries.length ? `<p class="coverage-notice"><strong>Limitações materiais registradas:</strong> ${escapeHtml(materialEntries.length)}. Consulte a metodologia antes de concluir a análise.</p>` : ''}
</section>`;
}

function summaryCard(label, value, description, tone) {
  return `<article class="summary-card summary-card--${tone}"><h3>${escapeHtml(label)}</h3><strong>${escapeHtml(value)}</strong><span>${escapeHtml(description)}</span></article>`;
}

function filterSection(model, occurrences) {
  const engines = unique(occurrences.map(occurrence => occurrence.source.engine));
  const pages = model.pages.map(page => ({ value: page.pageId, label: page.pageId }));
  const items = unique(occurrences.map(occurrence => occurrence.nbrItemRef).filter(Boolean)).map(id => ({ value: id, label: id }));
  return `<section id="acoes" aria-labelledby="acoes-titulo"><h2 id="acoes-titulo">Ações e filtros</h2>
<p class="section-intro">Combine os filtros para localizar ocorrências. A ordem de prioridade do relatório permanece estável.</p>
<form id="report-filters" class="filters-shell" aria-describedby="filters-help filter-status">
<div class="filters-grid">
${selectFilter('filter-impact', 'Impacto', [['', 'Todos'], ...Object.entries(IMPACT).map(([value, label]) => [value, label])])}
${selectFilter('filter-wcag', 'Nível WCAG', [['', 'Todos'], ['A', 'A'], ['AA', 'AA'], ['AAA', 'AAA']])}
${selectFilter('filter-outcome', 'Resultado do motor', [['', 'Todos'], ...Object.entries(OUTCOME).map(([value, entry]) => [value, entry.label])])}
${selectFilter('filter-classification', 'Classificação', [['', 'Todas'], ...Object.entries(CLASSIFICATION).map(([value, label]) => [value, label])])}
${selectFilter('filter-page', 'Página', [['', 'Todas'], ...pages.map(page => [page.value, page.label])])}
${selectFilter('filter-engine', 'Motor', [['', 'Todos'], ...engines.map(value => [value, value])])}
${selectFilter('filter-abnt', 'Item ABNT', [['', 'Todos'], ['__none__', REPORT_NO_ABNT_ITEM_LABEL], ...items.map(item => [item.value, item.label])])}
</div>
<div class="filter-actions"><button type="button" data-clear-filters disabled>Limpar filtros</button><button type="button" id="expand-details" disabled>Expandir detalhes</button><button type="button" id="collapse-details" disabled>Recolher detalhes</button></div>
<p id="filters-help" class="filters-noscript">Os filtros precisam de JavaScript. Sem JavaScript, todas as ocorrências e todos os detalhes permanecem abertos e legíveis.</p>
<p id="filter-status" class="filter-status" role="status" aria-live="polite" aria-atomic="true">${occurrences.length} de ${occurrences.length} ocorrências exibidas.</p>
</form>
<div id="filter-empty" class="empty-state" hidden><h3>Nenhuma ocorrência corresponde aos filtros</h3><p>Limpe os filtros para retornar ao conjunto completo.</p><button type="button" data-clear-filters disabled>Limpar filtros</button></div>
</section>`;
}

function selectFilter(id, label, options) {
  return `<div class="filter-field"><label for="${id}">${escapeHtml(label)}</label><select id="${id}" name="${id}" disabled>${options.map(([value, text]) => `<option value="${escapeHtml(value)}">${escapeHtml(text)}</option>`).join('')}</select></div>`;
}

function occurrenceSection(occurrences, context) {
  const content = occurrences.length
    ? occurrences.map((occurrence, index) => occurrenceCard(occurrence, index, context)).join('')
    : '<p>Nenhuma ocorrência foi registrada no escopo observado.</p>';
  return `<section id="ocorrencias" class="major-section" aria-labelledby="ocorrencias-titulo"><h2 id="ocorrencias-titulo">Ocorrências priorizadas</h2>
<p class="section-intro">Falhas técnicas aparecem antes de revisões humanas; impacto, página e ordem original resolvem os demais empates.</p><div class="occurrence-list">${content}</div></section>`;
}

function occurrenceCard(occurrence, index, context) {
  const item = occurrence.nbrItemRef ? context.itemById.get(occurrence.nbrItemRef) : null;
  const page = context.pageById.get(occurrence.pageId);
  const rule = context.ruleById.get(occurrence.source.ruleId);
  const review = context.reviewByOccurrence.get(occurrence.occurrenceId);
  const decision = context.decisionByOccurrence.get(occurrence.occurrenceId);
  const consolidated = effectiveOccurrenceOutcome(occurrence, decision);
  const wcagLevels = item ? unique(item.wcag.filter(reference => occurrence.testedWcagRefs.includes(reference.id))
    .map(reference => reference.level)).join(' ') : '';
  const title = occurrenceTitle(occurrence, item, rule);
  const abntToken = occurrence.nbrItemRef ?? '__none__';
  const decisionLabel = decision ? reviewAnswerLabel(decision.answer) : review ? 'Pendente' : 'Não se aplica';
  const selector = occurrence.target?.selector;
  const frame = occurrence.target?.framePath?.length ? occurrence.target.framePath.join(' › ') : 'Documento principal';
  const evidence = occurrence.evidenceRefs.map(id => context.artifactById.get(id)).filter(Boolean);
  const accessibilityArtifact = evidence.find(artifact => artifact.accessibility);
  const preview = occurrence.accessiblePreview || accessibilityArtifact?.accessibility?.announcementPreview;
  const nameSource = accessibilityArtifact?.accessibility?.nameSource;
  const remediation = coreRemediationForOccurrence(rule, occurrence);
  const anchor = `ocorrencia-${index + 1}`;

  return `<article id="${anchor}" class="occurrence-card" data-occurrence-card data-occurrence-id="${escapeHtml(occurrence.occurrenceId)}" data-impact="${escapeHtml(occurrence.impact)}" data-wcag-levels="${escapeHtml(wcagLevels)}" data-outcome="${escapeHtml(occurrence.outcome)}" data-display-outcome="${escapeHtml(consolidated)}" data-classification="${escapeHtml(occurrence.classification)}" data-page="${escapeHtml(occurrence.pageId)}" data-engine="${escapeHtml(occurrence.source.engine)}" data-abnt-item="${escapeHtml(abntToken)}" aria-labelledby="${anchor}-titulo">
<div class="occurrence-heading"><h3 id="${anchor}-titulo">${escapeHtml(title)}</h3>${statusMarkup(consolidated)}</div>
<div class="chip-row">${impactMarkup(occurrence.impact)}${classificationMarkup(occurrence.classification)}</div>
<p><strong>Página:</strong> ${escapeHtml(occurrence.pageId)} — ${pageStatus(page.status)}. <strong>Observada até:</strong> ${escapeHtml(page.timestamps.endedAt)}.</p>
<div class="decision-strip"><p>Resultado do motor: ${escapeHtml(outcomeLabel(occurrence.outcome))}</p><p>Decisão humana: ${escapeHtml(decisionLabel)}</p><p>Estado consolidado: ${escapeHtml(outcomeLabel(consolidated))}</p></div>
<div class="observed"><h4>O que foi observado</h4><p>${escapeHtml(occurrence.justification || rule?.summary || 'O motor registrou esta ocorrência sem descrição adicional.')}</p></div>
${remediation ? `<div class="remediation"><h4>Como corrigir</h4><p>${escapeHtml(remediation)}</p></div>` : ''}
<div class="confirm"><h4>Como confirmar</h4><p>${escapeHtml(review?.question || confirmationInstruction(occurrence, item))}</p></div>
${normativeMapping(occurrence, item)}
<details open data-collapsible><summary>Detalhes técnicos e evidências</summary>
<section aria-labelledby="${anchor}-anuncio"><h4 id="${anchor}-anuncio">Prévia de anúncio</h4><p>${escapeHtml(preview || 'Prévia não disponível para este alvo.')}</p><p><strong>Origem do nome:</strong> ${escapeHtml(nameSource || 'não registrada')}.</p><p>Prévia calculada a partir dos dados observados; não é transcrição literal de VoiceOver, NVDA, JAWS ou outro leitor de tela.</p></section>
${occurrenceEvidence(occurrence, context.artifactById, context.imageByEvidenceId, consolidated, index)}
<section aria-labelledby="${anchor}-alvo"><h4 id="${anchor}-alvo">Alvo e trecho de código</h4><dl class="meta"><dt>Seletor</dt><dd>${selector ? `<code>${escapeHtml(selector)}</code>` : 'Alvo elementar não localizado'}</dd><dt>Frame</dt><dd>${escapeHtml(frame)}</dd><dt>Evidências</dt><dd>${occurrence.evidenceRefs.length ? occurrence.evidenceRefs.map(id => `<a href="#evidencia-${escapeHtml(evidenceIndex(context.artifactById, id) + 1)}"><code>${escapeHtml(id)}</code></a>`).join(' ') : 'Sem evidência anexada'}</dd></dl>${evidence.map(artifact => artifact.snippet ? `<pre><code>${escapeHtml(artifact.snippet)}</code></pre>` : '').join('')}</section>
${legalAnalysis(occurrence, item, anchor, consolidated, decision)}
<section aria-labelledby="${anchor}-proveniencia"><h4 id="${anchor}-proveniencia">Proveniência técnica</h4><dl class="meta"><dt>Motor</dt><dd>${escapeHtml(occurrence.source.engine)}</dd><dt>Regra</dt><dd><code>${escapeHtml(occurrence.source.ruleId)}</code></dd><dt>Versão</dt><dd>${escapeHtml(occurrence.source.version)}</dd><dt>Modo</dt><dd>${modeLabel(occurrence.mode)}</dd><dt>Confiança</dt><dd>${confidenceLabel(occurrence.confidence)}</dd><dt>Frame</dt><dd>${escapeHtml(frame)}</dd><dt>Hashes</dt><dd>${evidence.map(artifact => `<code>${escapeHtml(artifact.hash || 'não disponível')}</code>`).join(' ') || 'não disponíveis'}</dd></dl></section>
<p><strong>ID da ocorrência:</strong> <code>${escapeHtml(occurrence.occurrenceId)}</code></p>
</details></article>`;
}

function coreRemediationForOccurrence(rule, occurrence) {
  if (rule?.source?.engine !== 'audita-core' || !Array.isArray(rule.targets)) return null;
  const occurrenceNode = occurrence.nodeId === null ? null : String(occurrence.nodeId);
  for (const target of rule.targets) {
    if (!target || typeof target !== 'object' || Array.isArray(target) || typeof target.message !== 'string') continue;
    const targetNode = target.nodeId === 'document' ? null : String(target.nodeId);
    if (targetNode === occurrenceNode) return target.message;
  }
  return null;
}

function occurrenceTitle(occurrence, item, rule) {
  if (item) return item.title;
  if (occurrence.classification === 'editorial') return rule?.summary || 'Alerta editorial identificado';
  if (occurrence.classification === 'best-practice') return rule?.summary || 'Boa prática suplementar identificada';
  return rule?.summary || 'Ocorrência suplementar';
}

function normativeMapping(occurrence, item) {
  if (!item) return `<div class="normative-map"><h4>Mapeamento normativo</h4><p><strong>ABNT NBR 17225:</strong> ${REPORT_NO_ABNT_ITEM_LABEL}.</p></div>`;
  const levelById = new Map(item.wcag.map(reference => [reference.id, reference.level]));
  const format = references => references.length
    ? references.map(reference => `${reference}${levelById.has(reference) ? ` (nível ${levelById.get(reference)})` : ''}`).join(', ')
    : 'Nenhum critério registrado';
  const foreign = occurrence.foreignBenchmarkRefs.length
    ? `${occurrence.foreignBenchmarkRefs.map(reference => `${reference.criterionId} (${reference.level})`).join(', ')}. ${SECTION508_REVISED_CROSSWALK.qualification}`
    : 'Nenhuma correspondência: somente critérios efetivamente testados podem gerar esta referência.';
  return `<div class="normative-map"><h4>Mapeamento normativo</h4><p><strong>ABNT NBR 17225:2025:</strong> item ${escapeHtml(item.id)} — ${escapeHtml(item.title)} (${escapeHtml(CLASSIFICATION[item.classification])}).</p><dl class="meta"><dt>Contexto integral do item ABNT</dt><dd>${escapeHtml(format(occurrence.itemWcagRefs))}</dd><dt>Critérios mapeados pela fonte</dt><dd>${escapeHtml(format(occurrence.sourceWcagRefs))}</dd><dt>Critérios efetivamente testados</dt><dd>${escapeHtml(format(occurrence.testedWcagRefs))}</dd><dt>${escapeHtml(SECTION508_REVISED_CROSSWALK.label)}</dt><dd>${escapeHtml(foreign)}</dd></dl></div>`;
}

function legalAnalysis(occurrence, item, anchor, displayOutcome, decision) {
  if (displayOutcome !== 'failed' || !item || !['requirement', 'recommendation'].includes(item.classification)) return '';
  const automaticBasis = consumerBasisForOccurrence(occurrence);
  const reviewedFailure = occurrence.outcome === 'cantTell' && decision?.answer === 'não conforme';
  if ((!automaticBasis && !reviewedFailure) || (automaticBasis && occurrence.legalAnalysis?.basisRef !== automaticBasis.id)) return '';
  const basis = automaticBasis || CONSUMER_ACCESSIBILITY_FIXED_BASIS;
  return `<section class="legal-analysis" aria-labelledby="${anchor}-juridico"><h4 id="${anchor}-juridico">${escapeHtml(basis.label)}</h4><p><strong>Referência técnica variável:</strong> ABNT NBR 17225:2025, item ${escapeHtml(item.id)} — ${escapeHtml(item.title)} (${escapeHtml(CLASSIFICATION[item.classification])}).</p><p>${escapeHtml(basis.sentencePrefix)}. ${escapeHtml(basis.qualification)}</p></section>`;
}

function occurrenceEvidence(occurrence, artifactById, imageByEvidenceId, outcome, occurrenceIndex) {
  const artifacts = occurrence.evidenceRefs.map(id => artifactById.get(id)).filter(Boolean);
  const artifact = artifacts.find(value => value.kind === 'element' && imageByEvidenceId.has(value.evidenceId))
    || artifacts.find(value => value.kind === 'full-page' && imageByEvidenceId.has(value.evidenceId));
  if (!artifact) return '<section><h4>Evidência visual</h4><p>Captura marcada indisponível; consulte as limitações e os demais registros da ocorrência.</p></section>';
  const image = imageByEvidenceId.get(artifact.evidenceId);
  const tone = outcome === 'failed' ? 'failed' : outcome === 'passed' ? 'passed' : 'review';
  const legend = tone === 'failed'
    ? 'Símbolo ✕ e moldura sólida: não atendimento técnico observado.'
    : tone === 'passed'
      ? 'Símbolo ✓ e moldura dupla: atendimento confirmado na revisão.'
      : 'Símbolo ? e moldura tracejada: evidência pendente de revisão humana.';
  const annex = `#evidencia-${evidenceIndex(artifactById, artifact.evidenceId) + 1}`;
  if (artifact.kind === 'full-page') {
    return `<section aria-labelledby="evidencia-ocorrencia-${occurrenceIndex + 1}"><h4 id="evidencia-ocorrencia-${occurrenceIndex + 1}">Evidência visual</h4><p class="evidence-scope-banner"><strong>Alvo elementar não localizado; evidência registrada no nível da página.</strong> A captura fornece contexto e não indica que cada pixel represente a desconformidade.</p><figure class="occurrence-evidence page-level-evidence page-level-evidence--${tone}">${renderEvidenceImage(image, `Captura integral usada como contexto da ocorrência. ${legend}`)}<figcaption>${escapeHtml(legend)} <a href="${annex}">Consultar o arquivo original no anexo</a>.</figcaption></figure></section>`;
  }
  return `<section aria-labelledby="evidencia-ocorrencia-${occurrenceIndex + 1}"><h4 id="evidencia-ocorrencia-${occurrenceIndex + 1}">Evidência visual</h4><figure class="occurrence-evidence">${renderMarkedEvidenceImage(image, artifact, `Captura do elemento ${artifact.nodeId || 'auditado'}. ${legend}`, tone)}<figcaption>${escapeHtml(legend)} A marcação é derivada para localização; <a href="${annex}">o PNG original e seu hash estão no anexo</a>.</figcaption></figure></section>`;
}

function announcementMaps(model, imageByEvidenceId) {
  const maps = model.evidence.filter(artifact => artifact.kind === 'announcement-map');
  return `<section id="mapas" class="major-section" aria-labelledby="mapas-titulo"><h2 id="mapas-titulo">Mapa visual da prévia de anúncios</h2>
<p class="section-intro">Evidência derivada para relacionar marcadores aos elementos e às prévias calculadas. Ordem observada DOM/AX não é ordem de foco, e a prévia não é transcrição literal de tecnologia assistiva.</p><div class="map-list">${model.pages.map((page, index) => {
    const artifact = maps.find(value => value.pageId === page.pageId);
    if (!artifact) return `<article id="mapa-${index + 1}" class="map-card" data-announcement-map-page="${escapeHtml(page.pageId)}" data-map-status="absent"><h3>Página ${index + 1} — ${escapeHtml(page.pageId)}</h3><div class="map-unavailable"><p><strong>Mapa indisponível nesta auditoria.</strong></p><p>Nenhum artefato derivado validado foi registrado; a captura original permanece separada no anexo quando disponível.</p></div></article>`;
    const coverage = `${artifact.counts.annotated} de ${artifact.counts.eligible} elementos elegíveis anotados; ${artifact.counts.omittedFrame} contextos de frame, ${artifact.counts.omittedNoRect} elementos sem geometria, ${artifact.counts.omittedLimit} por limite e ${artifact.counts.unresolvedOverlap} sobreposições não resolvidas.`;
    const printableAspectRatio = String(ANNOTATION_MAP_PRINTABLE_ASPECT_RATIO).replace('.', ',');
    const limits = `${groupedInteger(artifact.limits.maxNodes)} nós; ${groupedInteger(artifact.limits.maxSourcePixels)} pixels de origem; dimensão ${groupedInteger(artifact.limits.maxDimension)}; ${groupedInteger(artifact.limits.maxCanvasPixels)} pixels por segmento; ${groupedInteger(artifact.limits.maxSegments)} segmentos; ${groupedInteger(artifact.limits.maxDerivedBytes)} bytes derivados; ${groupedInteger(artifact.limits.maxLegendCodePoints)} pontos de código de legenda; proporção raster imprimível até ${printableAspectRatio}:1 (regra do algoritmo).`;
    const limitations = artifact.limitations.length
      ? artifact.limitations.map(code => `${code} — ${ANNOTATION_MAP_LIMITATION_LABELS[code]}`).join('; ')
      : 'nenhuma limitação adicional';
    const stateText = artifact.status === 'empty'
      ? '<strong>Nenhum elemento elegível foi encontrado.</strong> O estado vazio foi registrado explicitamente; não significa conformidade da página.'
      : artifact.status === 'partial'
        ? '<strong>Mapa gerado com cobertura parcial.</strong> Consulte as omissões e limitações antes de usar a correlação.'
        : '<strong>Mapa gerado.</strong> A correlação visual e a legenda semântica estão disponíveis abaixo.';
    const caption = `Página ${index + 1} (${page.pageId}); cobertura: ${coverage} Algoritmo ${artifact.derivation.algorithm} ${artifact.derivation.version}; limites: ${limits} Origem ${artifact.fullPageEvidenceId}, hash ${artifact.derivation.sourceHash}; hash derivado ${artifact.hash}; limitações: ${limitations}.`;
    const figures = artifact.segments.map(segment => {
      const image = imageByEvidenceId.get(segment.segmentId);
      const markers = artifact.derivation.geometry.annotations.filter(annotation => annotation.segmentIndex === segment.index).map(annotation => annotation.number);
      const markerText = markers.length === 1
        ? `com marcador ${markers[0]}`
        : markers.length > 1 ? `com marcadores ${markers.join(', ')}` : 'sem marcadores neste recorte';
      const roleText = segment.role === 'legend-continuation' ? 'continuação da legenda' : markerText;
      const accessibleName = `Segmento ${segment.index} de ${segment.count} do mapa, ${roleText}`;
      return `<figure class="announcement-map-segment" data-map-segment="${escapeHtml(segment.segmentId)}">${image ? renderEvidenceImage(image, accessibleName) : '<p><strong>PNG do segmento indisponível.</strong> Os metadados e a legenda semântica foram preservados.</p>'}<figcaption>${escapeHtml(caption)} Segmento ${segment.index} de ${segment.count}: ${escapeHtml(roleText)}; hash do segmento <code>${escapeHtml(segment.contentHash)}</code>.</figcaption></figure>`;
    }).join('');
    const legend = artifact.legend.length ? `<h4 id="mapa-${index + 1}-legenda">Legenda semântica completa</h4><ol class="announcement-map-legend" aria-labelledby="mapa-${index + 1}-legenda">${artifact.legend.map(entry => `<li><span class="legend-selector">Elemento <code>${escapeHtml(entry.selectorSummary)}</code></span><span>Prévia calculada: <bdi>${escapeAuditedText(entry.announcementPreview)}</bdi></span><span>Origem do nome: ${escapeHtml(entry.nameSource)}; marcador no segmento ${entry.segmentIndex}.</span></li>`).join('')}</ol>` : '';
    return `<article id="mapa-${index + 1}" class="map-card" data-announcement-map-page="${escapeHtml(page.pageId)}" data-map-status="${escapeHtml(artifact.status)}"><h3>Página ${index + 1} — ${escapeHtml(page.pageId)}</h3><p class="map-state map-state--${escapeHtml(artifact.status)}">${stateText}</p><dl class="meta map-meta"><dt>Cobertura</dt><dd>${escapeHtml(coverage)}</dd><dt>Algoritmo</dt><dd><code>${escapeHtml(artifact.derivation.algorithm)}</code> ${escapeHtml(artifact.derivation.version)}</dd><dt>Captura original</dt><dd><code>${escapeHtml(artifact.fullPageEvidenceId)}</code> — <code>${escapeHtml(artifact.derivation.sourceHash)}</code></dd><dt>Hash derivado</dt><dd><code>${escapeHtml(artifact.hash)}</code></dd><dt>Limites</dt><dd>${escapeHtml(limits)}</dd><dt>Limitações</dt><dd>${escapeHtml(limitations)}</dd></dl><div class="announcement-map-segments">${figures}</div>${legend}</article>`;
  }).join('')}</div></section>`;
}

function humanReviewSection(model, itemById, decisionByOccurrence, orderedOccurrences) {
  const pending = model.manualReview.filter(entry => entry.status === 'unanswered').length;
  const completed = model.manualReview.filter(entry => entry.status === 'answered').length;
  const reviewSummary = `${pending} ${pending === 1 ? 'pendente' : 'pendentes'}; ${completed} ${completed === 1 ? 'concluída' : 'concluídas'}.`;
  const cards = model.manualReview.map((entry, index) => {
    const item = itemById.get(entry.itemId);
    const occurrence = model.occurrences.find(value => value.occurrenceId === entry.occurrenceId);
    const decision = decisionByOccurrence.get(entry.occurrenceId);
    return `<article class="review-card" data-review-state="${escapeHtml(entry.status)}" aria-labelledby="revisao-${index + 1}"><h3 id="revisao-${index + 1}">${escapeHtml(item?.title || entry.itemId)}</h3><p><strong>Item:</strong> ${escapeHtml(entry.itemId)} (${escapeHtml(item ? CLASSIFICATION[item.classification] : 'sem classificação')}).</p><p><strong>Resultado original do motor:</strong> ${escapeHtml(outcomeLabel(occurrence?.outcome || 'cantTell'))}.</p><p><strong>Pergunta:</strong> ${escapeHtml(entry.question)}</p><p><strong>Justificativa:</strong> ${escapeHtml(entry.reason)}</p><p><strong>Decisão humana:</strong> ${escapeHtml(decision ? reviewAnswerLabel(decision.answer) : 'Pendente')}.</p>${decision ? `<p><strong>Avaliador e instante:</strong> ${escapeHtml(decision.evaluator)}, ${escapeHtml(decision.decidedAt)}.</p>` : ''}<p><a href="#${escapeHtml(occurrenceAnchor(orderedOccurrences, entry.occurrenceId))}">Ir para a ocorrência relacionada</a></p></article>`;
  }).join('');
  return `<section id="revisao" class="major-section" aria-labelledby="revisao-titulo"><h2 id="revisao-titulo">Revisão humana</h2><p>${escapeHtml(reviewSummary)} Respostas pendentes nunca são tratadas como conformidade. Resultado do motor e decisão humana permanecem separados.</p><div class="review-list">${cards || '<p>Nenhuma revisão humana foi registrada para este escopo.</p>'}</div></section>`;
}

function widgetInventory(model) {
  const inventory = model.accessibilityWidgets;
  const pageIds = model.pages.map(page => page.pageId).join(', ');
  const coverage = inventory.coverage === 'complete' ? 'Cobertura local completa' : inventory.coverage === 'partial' ? 'Cobertura local parcial' : 'Inventário não registrado';
  const names = { vlibras: 'VLibras', 'hand-talk': 'Hand Talk' };
  const signalLabels = { 'dom-signature': 'assinatura no DOM', 'script-signature': 'assinatura de script', 'global-signature': 'assinatura global' };
  return `<section id="inventario" class="major-section" aria-labelledby="inventario-titulo"><h2 id="inventario-titulo">Inventário de recursos de acessibilidade</h2><p class="section-intro">Inventário informativo; presença ou ausência de widget não aprova nem reprova item normativo e não altera contagens.</p><p class="coverage-notice"><strong>Cobertura:</strong> ${escapeHtml(coverage)}.</p><div class="widget-grid">${inventory.widgets.map(widget => {
    const state = widget.status === 'present' ? 'Assinatura detectada' : widget.status === 'absent' ? 'Assinatura não detectada com cobertura completa' : 'Não foi possível determinar';
    const signals = widget.signals.length ? widget.signals.map(signal => signalLabels[signal]).join(', ') : 'nenhum sinal seguro registrado';
    return `<article class="widget-card" data-widget-state="${escapeHtml(widget.status)}"><h3>${escapeHtml(names[widget.id] || widget.id)}</h3><p class="widget-state">${escapeHtml(state)}</p><dl class="meta"><dt>Escopo de detecção</dt><dd>Agregado da sessão; não localizado por página.</dd><dt>Páginas incluídas</dt><dd>${escapeHtml(pageIds)}</dd><dt>Cobertura</dt><dd>${escapeHtml(coverage)}</dd><dt>Sinais seguros</dt><dd>${escapeHtml(signals)}</dd></dl></article>`;
  }).join('')}</div></section>`;
}

function itemMatrix(model) {
  return `<section id="matriz" class="major-section" aria-labelledby="matriz-titulo"><h2 id="matriz-titulo">Matriz completa dos 146 itens</h2><p>A matriz registra todos os itens sem transformar ausência de falha em conformidade integral.</p><div class="matrix-scroll" role="region" aria-label="Matriz completa dos 146 itens ABNT; use rolagem horizontal quando necessário" tabindex="0"><table><thead><tr><th scope="col">Item</th><th scope="col">Título</th><th scope="col">Classificação</th><th scope="col">Resultado</th><th scope="col">Modo</th><th scope="col">WCAG 2.2</th></tr></thead><tbody>${model.itemResults.map(item => `<tr data-report-item="${escapeHtml(item.id)}"><th scope="row">${escapeHtml(item.id)}</th><td>${escapeHtml(item.title)}</td><td>${escapeHtml(CLASSIFICATION[item.classification])}</td><td>${statusMarkup(item.outcome)}</td><td>${modeLabel(item.evaluation)}</td><td>${item.wcag.length ? item.wcag.map(reference => `${escapeHtml(reference.id)} (${escapeHtml(reference.level)})`).join(', ') : 'Sem critério vinculado'}</td></tr>`).join('')}</tbody></table></div></section>`;
}

function evidenceAnnex(model, imageByEvidenceId) {
  return `<section id="anexos" class="major-section" aria-labelledby="anexos-titulo"><h2 id="anexos-titulo">Anexos de evidências</h2><p>Capturas originais e artefatos derivados são identificados separadamente. Cada PNG validado é incorporado uma única vez e reutilizado por referência.</p>${model.pages.map((page, pageIndex) => {
    const artifacts = model.evidence.filter(artifact => artifact.pageId === page.pageId);
    const original = artifacts.filter(artifact => artifact.kind !== 'announcement-map');
    const derived = artifacts.filter(artifact => artifact.kind === 'announcement-map');
    return `<section class="evidence-group" aria-labelledby="anexos-pagina-${pageIndex + 1}"><h3 id="anexos-pagina-${pageIndex + 1}">Página ${pageIndex + 1} — ${escapeHtml(page.pageId)}</h3><h4>Evidências originais</h4><div class="evidence-list">${original.map(artifact => evidenceCard(artifact, model.evidence, imageByEvidenceId)).join('') || '<p>Nenhuma evidência original registrada.</p>'}</div><h4>Evidências derivadas</h4><div class="evidence-list">${derived.map(artifact => evidenceCard(artifact, model.evidence, imageByEvidenceId)).join('') || '<p>Nenhuma evidência derivada registrada.</p>'}</div></section>`;
  }).join('')}</section>`;
}

function evidenceCard(artifact, allEvidence, imageByEvidenceId) {
  const index = allEvidence.findIndex(value => value.evidenceId === artifact.evidenceId);
  if (artifact.kind === 'announcement-map') {
    const coverage = `${artifact.counts.annotated}/${artifact.counts.eligible} elegíveis anotados; ${artifact.segments.length} segmentos.`;
    return `<article id="evidencia-${index + 1}" class="evidence-card evidence-card--derived" aria-labelledby="evidencia-${index + 1}-titulo"><h4 id="evidencia-${index + 1}-titulo">${escapeHtml(artifact.evidenceId)}</h4><dl class="meta"><dt>Tipo</dt><dd>announcement-map</dd><dt>Estado</dt><dd>${escapeHtml(artifact.status)}</dd><dt>Hash derivado</dt><dd><code>${escapeHtml(artifact.hash)}</code></dd><dt>Algoritmo</dt><dd><code>${escapeHtml(artifact.derivation.algorithm)}</code> ${escapeHtml(artifact.derivation.version)}</dd><dt>Origem pristine</dt><dd><code>${escapeHtml(artifact.fullPageEvidenceId)}</code> — <code>${escapeHtml(artifact.derivation.sourceHash)}</code></dd><dt>Cobertura</dt><dd>${escapeHtml(coverage)}</dd></dl><p class="evidence-relation">Artefato derivado localmente; os PNGs segmentados, a legenda completa, os limites e as limitações estão na seção <a href="#mapas">Mapa visual da prévia de anúncios</a>. A captura original permanece separada.</p></article>`;
  }
  const image = imageByEvidenceId.get(artifact.evidenceId);
  const relation = artifact.fullPageEvidenceId ? `Deriva ou localiza conteúdo da captura integral ${artifact.fullPageEvidenceId}.` : artifact.kind === 'full-page' ? 'Captura integral original do estado observado.' : 'Evidência elementar original, quando disponível.';
  return `<article id="evidencia-${index + 1}" class="evidence-card" aria-labelledby="evidencia-${index + 1}-titulo"><h4 id="evidencia-${index + 1}-titulo">${escapeHtml(artifact.evidenceId)}</h4><dl class="meta"><dt>Tipo</dt><dd>${escapeHtml(artifact.kind)}</dd><dt>Hash</dt><dd><code>${escapeHtml(artifact.hash || 'não disponível')}</code></dd>${artifact.selector?.css ? `<dt>Seletor</dt><dd><code>${escapeHtml(artifact.selector.css)}</code></dd>` : ''}${artifact.backendNodeId ? `<dt>Backend node</dt><dd>${escapeHtml(artifact.backendNodeId)}</dd>` : ''}${artifact.mediaUrl ? `<dt>URL da mídia</dt><dd>${safeMediaText(artifact.mediaUrl)}</dd>` : ''}</dl><p class="evidence-relation">${escapeHtml(relation)}</p>${artifact.snippet ? `<details open data-collapsible><summary>Trecho HTML sanitizado</summary><pre><code>${escapeHtml(artifact.snippet)}</code></pre></details>` : ''}${accessibility(artifact.accessibility)}${image ? `<figure>${renderEvidenceImage(image, evidenceAlt(artifact))}<figcaption>${artifact.kind === 'full-page' ? 'PNG original da captura integral do estado observado.' : artifact.kind === 'announcement-map' ? 'PNG derivado do mapa visual; consulte relação, algoritmo e limites registrados.' : `PNG original da captura do elemento ${escapeHtml(artifact.nodeId || '')}.`}</figcaption></figure>` : '<p><strong>Imagem não incluída:</strong> PNG ausente, inválido ou fora dos limites; o registro textual e a limitação permanecem visíveis.</p>'}</article>`;
}

function methodologySection(model) {
  const viewport = model.environment.viewport;
  const viewportText = viewport.width === null ? 'não disponível' : `${viewport.width} × ${viewport.height} CSS px; escala ${viewport.deviceScaleFactor}`;
  const sources = unique(model.occurrences.map(occurrence => `${occurrence.source.engine} — ${occurrence.source.version}`));
  const materialEntries = materialLimitationEntries(model);
  const notes = model.normative?.editorialNotes || [];
  const normativeSources = model.normative?.sources || [];
  const sourceLedger = normativeSources.map(source => {
    const locator = source.localCopy
      ? `arquivo <code>${escapeHtml(source.localCopy.fileName)}</code>; SHA-256 <code>${escapeHtml(source.localCopy.sha256)}</code>`
      : `<code>${escapeHtml(source.url)}</code>`;
    return `<li><strong>${escapeHtml(source.title)}</strong> — versão ${escapeHtml(source.version)}; identificador <code>${escapeHtml(source.id)}</code>; ${locator}.</li>`;
  }).join('');
  return `<section id="metodologia" class="major-section" aria-labelledby="metodologia-titulo"><h2 id="metodologia-titulo">Metodologia, proveniência e integridade</h2><div class="method-grid">
<article class="method-card"><h3>Método e ambiente</h3><p>${escapeHtml(model.methodology.name)}. Aprovação automática exige aplicabilidade e expectativas integralmente observadas; itens contextuais permanecem inconclusivos.</p><dl class="meta"><dt>Extensão</dt><dd>${escapeHtml(model.versions.extension)}</dd><dt>Regras</dt><dd>${escapeHtml(model.versions.rules)}</dd><dt>Navegador</dt><dd>${escapeHtml(model.versions.browser)}</dd><dt>Viewport</dt><dd>${escapeHtml(viewportText)}</dd><dt>Regras próprias</dt><dd>${escapeHtml(model.methodology.coreRuleCount)}</dd><dt>Regras suplementares</dt><dd>${escapeHtml(model.methodology.supplementalRuleCount)}</dd><dt>Itens normativos</dt><dd>${escapeHtml(model.methodology.itemCount)}</dd></dl></article>
<article class="method-card"><h3>Proveniência dos motores</h3><ul class="compact-list">${sources.map(source => `<li>${escapeHtml(source)}</li>`).join('') || '<li>Nenhuma ocorrência de motor registrada.</li>'}</ul><p>axe-core, quando habilitado por gate técnico, é suplementar e não aprova item ABNT por si só.</p></article>
<article class="method-card"><h3>Limitações e diagnósticos</h3><ul class="compact-list">${materialEntries.map(value => `<li>${escapeHtml(value)}</li>`).join('') || '<li>Nenhuma limitação adicional registrada.</li>'}</ul><p>A ausência de falha automática não comprova conformidade integral.</p></article>
<article class="method-card"><h3>Fundamentação e fontes</h3><p>Ledger normativo congelado e reproduzível:</p><ul class="compact-list">${sourceLedger}</ul><p><strong>${escapeHtml(CONSUMER_ACCESSIBILITY_FIXED_BASIS.label)}:</strong> ${escapeHtml(CONSUMER_ACCESSIBILITY_FIXED_BASIS.sentencePrefix)}. ${escapeHtml(CONSUMER_ACCESSIBILITY_FIXED_BASIS.qualification)}</p></article>
<article class="method-card"><h3>Notas de integridade normativa</h3><p>Informação impressa e normalização adotada permanecem separadas; o relatório não atribui à ABNT errata não localizada.</p><ul class="compact-list">${notes.map(note => `<li><strong>${escapeHtml(note.itemId)}:</strong> impresso “${escapeHtml(note.printed)}”; normalização “${escapeHtml(note.normalized)}”. ${escapeHtml(note.rationale)}</li>`).join('') || '<li>Nenhuma nota editorial registrada.</li>'}</ul></article>
<article class="method-card"><h3>Manifesto de integridade</h3>${integrityList(model)}<p>SHA-256 permite verificar igualdade dos artefatos, mas não substitui assinatura digital, carimbo certificado ou ata notarial.</p></article>
</div></section>`;
}

function materialLimitationEntries(model) {
  const diagnostics = [];
  const diagnosticKeys = new Set();
  const diagnosticMessages = new Set();
  for (const entry of model.session.diagnostics) {
    const key = `${entry.code}\u0000${entry.message}`;
    if (diagnosticKeys.has(key)) continue;
    diagnosticKeys.add(key);
    diagnosticMessages.add(entry.message);
    diagnostics.push(`${entry.code}: ${entry.message}`);
  }
  const limitations = [...new Set(model.limitations)]
    .filter(value => !diagnosticMessages.has(value));
  return [...limitations, ...diagnostics];
}

function integrityList(model) {
  const entries = {
    Algoritmo: model.integrity?.algorithm || 'SHA-256',
    'Modelo canônico': model.integrity?.canonicalModelHash || 'pendente da etapa de exportação',
    'Manifesto de evidências': model.integrity?.evidenceManifestHash || model.reproducibility?.evidenceHash || 'não disponível',
    Snapshot: model.reproducibility?.snapshotHash || 'não disponível',
    'Resultados de regras': model.reproducibility?.ruleResultsHash || 'não disponível',
  };
  return `<dl class="meta">${Object.entries(entries).map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd><code>${escapeHtml(value)}</code></dd>`).join('')}</dl>`;
}

function prioritizeOccurrences(occurrences, pages, decisionByOccurrence) {
  const pageIndex = new Map(pages.map((page, index) => [page.pageId, index]));
  return occurrences.map((occurrence, index) => ({ occurrence, index })).sort((left, right) =>
    (OUTCOME_PRIORITY[effectiveOccurrenceOutcome(left.occurrence, decisionByOccurrence.get(left.occurrence.occurrenceId))] ?? 99)
      - (OUTCOME_PRIORITY[effectiveOccurrenceOutcome(right.occurrence, decisionByOccurrence.get(right.occurrence.occurrenceId))] ?? 99)
    || (IMPACT_PRIORITY[left.occurrence.impact] ?? 99) - (IMPACT_PRIORITY[right.occurrence.impact] ?? 99)
    || (pageIndex.get(left.occurrence.pageId) ?? 99) - (pageIndex.get(right.occurrence.pageId) ?? 99)
    || left.index - right.index).map(entry => entry.occurrence);
}

function effectiveOccurrenceOutcome(occurrence, decision) {
  if (occurrence.outcome === 'failed' || decision?.answer === 'não conforme') return 'failed';
  if (decision?.answer === 'conforme') return 'passed';
  if (decision?.answer === 'não foi possível determinar') return 'cantTell';
  return occurrence.outcome;
}

function confirmationInstruction(occurrence, item) {
  if (item?.humanReason) return item.humanReason;
  if (!item) return 'Repita a verificação no estado e viewport registrados e confirme a condição descrita pelo motor suplementar.';
  if (occurrence.outcome === 'failed') return `Repita a verificação no estado e viewport registrados e compare o alvo com o item ${item?.id || 'ABNT indicado'}.`;
  return 'Confirme o comportamento no fluxo completo e registre a decisão sem alterar o resultado original do motor.';
}

function statusMarkup(outcome) {
  const status = OUTCOME[outcome] || OUTCOME.untested;
  return `<span class="status status--${escapeHtml(outcome)}"><span aria-hidden="true">${status.icon}</span><span>${status.label}</span></span>`;
}

function impactMarkup(impact) {
  return `<span class="chip"><span aria-hidden="true">◆</span><span>Impacto ${escapeHtml(IMPACT[impact] || impact)}</span></span>`;
}

function classificationMarkup(classification) {
  return `<span class="chip chip--${escapeHtml(classification)}"><span>${escapeHtml(CLASSIFICATION[classification] || classification)}</span></span>`;
}

function outcomeLabel(outcome) {
  return (OUTCOME[outcome] || OUTCOME.untested).label;
}

function pageStatus(status) {
  return PAGE_STATUS[status] || escapeHtml(status);
}

function reviewAnswerLabel(answer) {
  return ({ conforme: 'Conforme', 'não conforme': 'Não conforme', 'não foi possível determinar': 'Não foi possível determinar' })[answer] || 'Pendente';
}

function modeLabel(mode) {
  return ({ automated: 'Automatizado', assisted: 'Assistido', manual: 'Manual' })[mode] || 'Não informado';
}

function confidenceLabel(confidence) {
  return ({ high: 'Alta', medium: 'Média', low: 'Baixa' })[confidence] || 'Não informada';
}

function occurrenceAnchor(occurrences, occurrenceId) {
  const index = occurrences.findIndex(value => value.occurrenceId === occurrenceId);
  return index >= 0 ? `ocorrencia-${index + 1}` : 'ocorrencias';
}

function evidenceIndex(artifactById, evidenceId) {
  return [...artifactById.keys()].indexOf(evidenceId);
}

function accessibility(value) {
  if (!value || typeof value !== 'object') return '';
  const displayedValue = 'não coletado por privacidade';
  return `<section aria-label="Propriedades de acessibilidade"><h4>Nome, função e prévia</h4><dl class="meta"><dt>Nome acessível</dt><dd>${escapeHtml(value.name || 'não disponível')}</dd><dt>Origem do nome</dt><dd>${escapeHtml(value.nameSource || 'não disponível')}</dd><dt>Descrição acessível</dt><dd>${escapeHtml(value.description || 'não disponível')}</dd><dt>Origem da descrição</dt><dd>${escapeHtml(value.descriptionSource || 'não disponível')}</dd><dt>Função</dt><dd>${escapeHtml(value.role || 'não disponível')}</dd><dt>Valor</dt><dd>${escapeHtml(displayedValue)}</dd><dt>Estados</dt><dd>${escapeHtml((value.states || []).join(', ') || 'não disponíveis')}</dd><dt>Texto visível</dt><dd>${escapeHtml(value.visibleText || 'não disponível')}</dd><dt>Prévia de anúncio</dt><dd>${escapeHtml(value.announcementPreview || 'não disponível')}</dd></dl><p><strong>Variação esperada:</strong> esta prévia não é transcrição literal de tecnologia assistiva e pode variar conforme o navegador, a API da plataforma, o leitor, o modo e as preferências.</p></section>`;
}

function evidenceAlt(artifact) {
  if (artifact.kind === 'full-page') return 'Captura integral original da página auditada';
  if (artifact.kind === 'announcement-map') return 'Mapa visual derivado da prévia de anúncios';
  return `Captura original do elemento auditado ${artifact.nodeId || ''}`;
}

function safeMediaText(value) {
  const sanitized = sanitizeResourceUrl(value);
  return /^https?:\/\//u.test(sanitized) ? `<code>${escapeHtml(sanitized)}</code>` : 'URL omitida por segurança.';
}

function createImageRegistry(artifacts) {
  const definitions = [];
  const byEvidenceId = new Map();
  const byDataUrl = new Map();
  const register = (key, dataUrl) => {
    const metadata = pngMetadata(dataUrl);
    if (!metadata) return;
    let image = byDataUrl.get(dataUrl);
    if (!image) {
      image = Object.freeze({ id: `evidence-image-${definitions.length}`, dataUrl, width: metadata.width, height: metadata.height });
      definitions.push(image);
      byDataUrl.set(dataUrl, image);
    }
    byEvidenceId.set(key, image);
  };
  for (const artifact of artifacts) {
    register(artifact.evidenceId, artifact.dataUrl);
    for (const segment of artifact.kind === 'announcement-map' ? artifact.segments : []) register(segment.segmentId, segment.dataUrl);
  }
  return { definitions, byEvidenceId };
}

function imageDefinitions(definitions) {
  if (definitions.length === 0) return '';
  return `<svg class="evidence-definitions" aria-hidden="true" width="0" height="0" focusable="false"><defs>${definitions.map(image => `<image id="${image.id}" href="${escapeHtml(image.dataUrl)}" width="${image.width}" height="${image.height}" preserveAspectRatio="xMidYMid meet"></image>`).join('')}</defs></svg>`;
}

function renderEvidenceImage(image, accessibleName) {
  return `<svg class="evidence-media" role="img" aria-label="${escapeHtml(accessibleName)}" viewBox="0 0 ${image.width} ${image.height}" width="${image.width}" height="${image.height}" preserveAspectRatio="xMidYMid meet" focusable="false"><use href="#${image.id}" width="${image.width}" height="${image.height}"></use></svg>`;
}

function renderMarkedEvidenceImage(image, artifact, accessibleName, tone) {
  const captureWidth = finitePositive(artifact.metadata?.width) || image.width;
  const captureHeight = finitePositive(artifact.metadata?.height) || image.height;
  const box = highlightBox(artifact, captureWidth, captureHeight);
  return `<svg class="evidence-media" role="img" aria-label="${escapeHtml(accessibleName)}" viewBox="0 0 ${captureWidth} ${captureHeight}" width="${captureWidth}" height="${captureHeight}" preserveAspectRatio="xMidYMid meet" focusable="false"><use href="#${image.id}" width="${captureWidth}" height="${captureHeight}"></use><rect class="evidence-highlight evidence-highlight--${tone}" x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" aria-hidden="true"></rect></svg>`;
}

function highlightBox(artifact, width, height) {
  const box = artifact.metadata?.highlightBox;
  if (!box || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(box[key]))) return { x: 0, y: 0, width, height };
  const x = clamp(box.x, 0, width);
  const y = clamp(box.y, 0, height);
  const right = clamp(box.x + Math.max(0, box.width), x, width);
  const bottom = clamp(box.y + Math.max(0, box.height), y, height);
  return { x, y, width: right - x, height: bottom - y };
}

function finitePositive(value) {
  return Number.isFinite(value) && value > 0 ? value : null;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function unique(values) {
  return [...new Set(values)];
}

function pngMetadata(value) {
  try {
    const { width, height } = decodePngDataUrl(value);
    return { width, height };
  } catch {
    return false;
  }
}

function groupedInteger(value) {
  return String(value).replace(/\B(?=(?:\d{3})+(?!\d))/gu, '.');
}

function escapeAuditedText(value) {
  const visible = String(value ?? '').replace(/[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu, character => `⟦U+${character.codePointAt(0).toString(16).toUpperCase()}⟧`);
  return escapeHtml(visible);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/gu, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}
