import { accessibilityGuidance, recordedLabelComparisons } from './plain-language-guidance.js';
import { resultsOverviewHtml } from './results-overview.js';
import { checklistHtml } from './checklist-presentation.js';
import { consumerBasisForOccurrence, CONSUMER_ACCESSIBILITY_FIXED_BASIS } from '../legal/consumer-basis.js';
import { SECTION508_REVISED_CROSSWALK } from '../normative/section508.js';
import { WCAG22_LEVELS } from '../normative/wcag22.js';
import { createAuditModel } from './audit-model.js';
import { listedLimitations, viewportSummary } from './text-policy.js';
import { REPORT_CSS, REPORT_CSS_CSP_HASH } from './report.css.js';
import { REPORT_SCRIPT, REPORT_SCRIPT_CSP_HASH } from './report.js.js';
import { REPORT_VIEW_SCRIPT, REPORT_VIEW_SCRIPT_CSP_HASH } from './report-view-script.js';
import { EVIDENCE_TREATMENTS_V1, projectOccurrenceEvidencePreviews } from './evidence-treatment.js';
import { IMPACT_LABELS, impactText } from './impact-labels.js';
import {
  EVIDENCE_HIGHLIGHT_CLIPPED_LEGEND,
  EVIDENCE_HIGHLIGHT_UNMARKED_LEGEND,
  evidenceCaptureSize,
  evidenceHighlight,
  evidenceHighlightLegend,
  evidenceHighlightShapes,
  evidenceRasterMatchesCapture,
} from './evidence-highlight.js';
import { decodePngDataUrl } from '../evidence/png.js';
import { ANNOTATION_MAP_PRINTABLE_ASPECT_RATIO, annotationCode, annotationMapReadRules } from '../evidence/annotation-map-artifact.js';
import { createExportDeliveryIdentityV1 } from '../../export/export-formats.js';
import { readerMapPresentation, READER_MAP_INTRO, READER_MAP_LEGACY_INTRO, READER_MAP_TITLE } from './reader-map-presentation.js';
import {
  keyboardMapCountsText, keyboardMapPresentation, KEYBOARD_MAP_INTRO, KEYBOARD_MAP_TAB_HELP,
} from './keyboard-map-presentation.js';
import { projectEvidenceProvenance, evidenceProvenanceRows } from './evidence-provenance.js';
import { humanReviewHeading, humanReviewMetadata, HUMAN_REVIEW_DESCRIPTION, HUMAN_REVIEW_EMPTY } from './human-review-presentation.js';
import { FINDINGS_BOARD_INTRO, FINDINGS_BOARD_LIMIT, FINDINGS_BOARD_TITLE, scoreboardSentence } from './findings-board.js';
import { EVIDENCE_SHA256_HELP, evidenceHashRows, evidenceFileHashPresentation, EVIDENCE_RECORD_HASH_LABEL, EVIDENCE_FILE_HASH_LABEL } from './evidence-hash-presentation.js';
import { marksCropSvg, reviewMarksRecords } from './review-marks-presentation.js';

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

const IMPACT = IMPACT_LABELS;

const PAGE_STATUS = Object.freeze({
  complete: 'Completa', partial: 'Parcial', failed: 'Falhou', cancelled: 'Cancelada',
});

const ANNOTATION_MAP_LIMITATION_LABELS = Object.freeze({
  'observed-dom-ax-order-not-literal-assistive-technology': 'ordem DOM/AX observada; não representa fala literal nem ordem de foco',
  'non-atomic-source-geometry': 'captura e geometria são lidas em passos separados; a diferença é medida e o mapa não marca quando passa da tolerância',
  'top-document-open-shadow-only': 'somente o documento superior e Shadow DOM aberto foram compostos',
  'rasterization-browser-dependent': 'a rasterização pode variar conforme navegador e sistema operacional',
  'source-capture-may-contain-personal-data': 'a captura original pode conter dados pessoais visíveis',
  'frame-content-omitted': 'conteúdo de frames foi omitido',
  'closed-shadow-root-omitted': 'conteúdo de Shadow DOM fechado foi omitido',
  'container-replaced-by-annotated-descendant': 'contêineres com elementos internos anotados foram substituídos por esses elementos',
  'node-limit-reached': 'o limite de elementos anotados foi atingido',
  'legend-limit-reached': 'o limite de legenda ou segmentos foi atingido',
  'unresolved-marker-overlap': 'uma ou mais sobreposições de marcadores permaneceram',
  'non-uniform-pixel-scale': 'as escalas horizontal e vertical da captura não são uniformes',
  'ancestor-clipped-elements-omitted': 'elementos escondidos por uma área com rolagem própria foram omitidos',
  'source-layout-changed': 'a página mudou de tamanho enquanto era verificada; para não marcar o lugar errado, o mapa não foi desenhado',
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
  const shownOccurrences = orderedOccurrences.slice(0, REPORT_OCCURRENCE_DETAIL_LIMIT);
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
${filterSection(model, shownOccurrences)}
${occurrenceSection(shownOccurrences, { itemById, pageById, ruleById, artifactById, reviewByOccurrence, decisionByOccurrence, imageByEvidenceId: imageRegistry.byEvidenceId }, orderedOccurrences.length)}
${announcementMaps(model, imageRegistry.byEvidenceId)}
${keyboardMaps(model, imageRegistry.byEvidenceId)}
${humanReviewSection(model, itemById, decisionByOccurrence, shownOccurrences)}
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

function reportItemCheckPresentation(issue, itemId) {
  const occurrences = issue.occurrences.filter(occurrence => itemId === '__none__' ? !occurrence.itemId : occurrence.itemId === itemId);
  const outcomes = occurrences.map(occurrence => effectiveOccurrenceOutcome(occurrence, occurrence.decision));
  if (issue.occurrences.length === 0) outcomes.push(issue.displayOutcome);
  const outcome = outcomes.includes('failed') ? 'failed' : outcomes.some(value => ['cantTell', 'untested'].includes(value)) ? 'cantTell'
    : outcomes.includes('passed') ? 'passed' : outcomes.length ? 'inapplicable' : 'untested';
  const classifications = [...new Set(occurrences.map(occurrence => occurrence.classification))];
  if (issue.occurrences.length === 0) classifications.push(issue.classification);
  const normative = classifications.includes('requirement');
  const result = ['passed', 'inapplicable'].includes(outcome) ? 'passed' : outcome === 'failed' ? (normative ? 'failed' : 'alerts') : 'humanReview';
  const classification = result === 'humanReview' ? 'manual-review' : result;
  const originalOutcome = occurrences.some(row => row.outcome === 'failed') ? 'failed'
    : occurrences.some(row => ['cantTell', 'untested'].includes(row.outcome)) ? 'cantTell'
      : occurrences.some(row => row.outcome === 'passed') ? 'passed' : occurrences.length ? 'inapplicable' : issue.originalOutcome;
  return { outcome, result, classifications,
    issue: { ...issue, occurrences, occurrenceIds: occurrences.map(occurrence => occurrence.occurrenceId),
      abntItemIds: itemId === '__none__' ? [] : [itemId], displayOutcome: outcome, originalOutcome, classification },
    guidance: accessibilityGuidance({ itemId, title: issue.title, outcome,
    observed: [...new Set(occurrences.map(occurrence => occurrence.justification).filter(Boolean))].join(' ') }) };
}

function renderReportViewDocument(model, view, options = {}) {
  if (!view || view.version !== 1 || view.auditId !== model.auditId ||
    view.modelHash !== model.integrity.canonicalModelHash || !Object.isFrozen(view) ||
    !Array.isArray(view.matrix) || view.matrix.length !== 146) {
    throw new TypeError('ReportViewV1 inválida para exportação.');
  }
  const deliveryIdentity = options.deliveryIdentity === undefined ? null : createExportDeliveryIdentityV1(options.deliveryIdentity);
  const forPrint = options.forPrint === true;
  const csp = [
    "default-src 'none'", "img-src data:", `style-src '${REPORT_CSS_CSP_HASH}'`,
    ...(forPrint ? [] : [`script-src '${REPORT_VIEW_SCRIPT_CSP_HASH}'`]),
    "connect-src 'none'", "object-src 'none'", "frame-src 'none'", "font-src 'none'", "media-src 'none'",
    "worker-src 'none'", "base-uri 'none'", "form-action 'none'",
  ].join('; ');
  const evidenceById = new Map(view.technicalEvidence.map(evidence => [evidence.evidenceId, evidence]));
  const evidenceAnchorById = new Map(view.technicalEvidence.map((evidence, index) => [evidence.evidenceId, `report-evidence-${index + 1}`]));
  // "Item N" é a mesma numeração do painel: a posição da evidência na lista técnica do relatório. É esse
  // número que as citações citam, então ele precisa ser o do título da ficha e o da âncora, sem exceção.
  const annexNumberById = new Map(view.technicalEvidence.map((evidence, index) => [evidence.evidenceId, index + 1]));
  const groupLabels = Object.freeze({ failed: 'Não conformidades', alerts: 'Recomendações e alertas', humanReview: 'Suspeitas a confirmar', passed: 'Resultados positivos' });
  const outcomeLabels = Object.freeze({ failed: 'Não atendido neste teste', passed: 'Atendido no escopo observado', cantTell: 'Requer revisão humana', inapplicable: 'Não aplicável', untested: 'Não testado' });
  const impactLabels = IMPACT_LABELS;
  const statusLabels = Object.freeze({ pending: 'Pendente', complete: 'Concluída', partial: 'Concluída com limitações', cancelled: 'Cancelada', failed: 'Falhou' });
  const classificationLabels = Object.freeze({ failed: 'Não conformidade identificada', alerts: 'Alerta', 'manual-review': 'Revisão humana necessária', passed: 'Resultado positivo', requirement: 'Requisito ABNT', recommendation: 'Recomendação ABNT', 'best-practice': 'Boa prática suplementar', editorial: 'Alerta editorial' });
  const evidenceKindLabels = Object.freeze({
    'full-page': 'Página completa', element: 'Elemento', 'announcement-map': 'Mapa de anúncios',
    'keyboard-map': 'Mapa do teclado',
  });
  const countLabel = (count, singular, plural) => `${count} ${count === 1 ? singular : plural}`;
  const label = (value, dictionary, fallback = 'Não informado') => dictionary[value] ?? fallback;
  const safePng = value => typeof value === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/u.test(value);
  const metric = group => {
    const counts = view.executive.counts[{ failed: 'errors', alerts: 'alerts', humanReview: 'humanReview', passed: 'positive' }[group]];
    const detail = `${countLabel(counts.checkKeys, 'verificação', 'verificações')} · ${countLabel(counts.occurrences, 'ocorrência', 'ocorrências')}`;
    const total = Math.max(1, Object.values(view.executive.counts).reduce((sum, count) => sum + count.checkKeys, 0));
    return `<button type="button" class="summary-card" data-report-metric="${escapeHtml(group)}" aria-pressed="false"><strong>${counts.checkKeys}</strong><span>${escapeHtml(groupLabels[group])}</span><small>${escapeHtml(detail)}</small><meter min="0" max="${total}" value="${counts.checkKeys}" aria-hidden="true"></meter></button>`;
  };
  const correlatedEvidence = issue => {
    const ids = new Set(issue.occurrences.flatMap(occurrence => occurrence.evidenceRefs));
    return [...evidenceById.values()].filter(evidence => ids.has(evidence.evidenceId));
  };
  const plainBlock = (name, title, body) => `<section class="issue-plain-block" data-report-plain-block="${name}"><h4>${title}</h4>${body}</section>`;
  const previewAnchors = new Map();
  const firstPreviewByEvidence = new Map();
  const evidencePreview = (evidence, issue) => {
    const selected = projectOccurrenceEvidencePreviews({
      evidence: evidence.filter(item => safePng(item.dataUrl)),
      occurrences: issue.occurrences,
    });
    const previews = selected.length === 0
      ? '<p>Nenhuma captura PNG local está disponível para esta verificação.</p>'
      : selected.map(({ artifact: item, tone }) => {
        const previewKey = JSON.stringify([item.evidenceId, item.kind === 'element' ? tone : null]);
        if (previewAnchors.has(previewKey)) return `<p><a href="#${previewAnchors.get(previewKey)}">Consultar captura ${escapeHtml(item.evidenceId)} já apresentada</a>.</p>`;
        const anchor = `report-preview-${previewAnchors.size + 1}`;
        previewAnchors.set(previewKey, anchor);
        if (!firstPreviewByEvidence.has(item.evidenceId)) firstPreviewByEvidence.set(item.evidenceId, anchor);
        const figureAttributes = `id="${anchor}" data-report-preview-evidence="${escapeHtml(item.evidenceId)}" data-evidence-kind="${escapeHtml(item.kind)}"`;
        const accessibleLabel = `${label(item.kind, evidenceKindLabels, 'Evidência registrada')} local da evidência ${item.evidenceId}`;
        const treatment = item.kind === 'element' && tone ? EVIDENCE_TREATMENTS_V1[tone] : null;
        const highlight = treatment ? evidenceHighlight(item) : null;
        if (!treatment || !highlight) {
          return `<figure ${figureAttributes}><img class="evidence-media" src="${escapeHtml(item.dataUrl)}" alt="${escapeHtml(accessibleLabel)}"><figcaption>${escapeHtml(accessibleLabel)}.</figcaption></figure>`;
        }
        const aria = `${accessibleLabel} ${treatment.aria}${highlight.clipped ? ` ${EVIDENCE_HIGHLIGHT_CLIPPED_LEGEND}` : ''}`;
        return `<figure ${figureAttributes}><svg class="evidence-media evidence-media--marked" data-evidence-treatment="${treatment.tone}" role="img" aria-label="${escapeHtml(aria)}" viewBox="0 0 ${highlight.width} ${highlight.height}" width="${highlight.width}" height="${highlight.height}" preserveAspectRatio="xMidYMid meet" focusable="false"><image href="${escapeHtml(item.dataUrl)}" width="${highlight.width}" height="${highlight.height}" preserveAspectRatio="xMidYMid meet"></image>${evidenceShapesMarkup(evidenceHighlightShapes(highlight, treatment.tone))}</svg><figcaption>${escapeHtml(`${evidenceHighlightLegend(treatment, highlight)} ${accessibleLabel}.`)}</figcaption></figure>`;
      }).join('');
    return `<section data-report-evidence-preview><h4>Capturas registradas</h4>${previews}</section>`;
  };
  const technicalDetails = (issue, evidence) => `<details data-report-technical><summary>Ver detalhes técnicos</summary><p>Resultado original: ${escapeHtml(label(issue.originalOutcome, outcomeLabels))}. Resultado consolidado: ${escapeHtml(label(issue.displayOutcome, outcomeLabels))}.</p><p><strong>Orientação original registrada:</strong> ${escapeHtml(issue.plainLanguage.correction)}.</p><p><strong>Contexto técnico:</strong> ${escapeHtml(issue.context ?? 'não registrado')}. <strong>Página:</strong> ${escapeHtml(issue.pageId)}.</p>${issue.occurrences.map(occurrence => `<section data-report-occurrence-technical="${escapeHtml(occurrence.occurrenceId)}"><h4>ID da ocorrência: ${escapeHtml(occurrence.occurrenceId)}</h4><p><strong>Proveniência:</strong> Página ${escapeHtml(issue.pageId)}; Motor ${escapeHtml(occurrence.source.engine)}; Regra ${escapeHtml(occurrence.source.ruleId)}; Versão ${escapeHtml(occurrence.source.version)}.</p><p><strong>Item ABNT:</strong> ${escapeHtml(reportAbntItemLabel(occurrence.itemId))}. <strong>Classificação:</strong> ${escapeHtml(label(occurrence.classification, classificationLabels))}.</p></section>`).join('')}${evidence.map(item => `<section data-report-occurrence-evidence="${escapeHtml(item.evidenceId)}"><h4>ID da evidência: ${escapeHtml(item.evidenceId)} — ${escapeHtml(label(item.kind, evidenceKindLabels, 'Evidência registrada'))}</h4><p><strong>Proveniência:</strong> página ${escapeHtml(item.pageId)}; tipo ${escapeHtml(item.kind)}; estado ${escapeHtml(item.state ?? 'não registrado')}.</p>${evidenceProvenanceHtml(item)}<p><strong>Seletor:</strong> ${escapeHtml(item.selector?.css ?? 'não registrado')}</p><p><strong>Snippet:</strong> ${escapeHtml(item.snippet ?? 'não disponível')}</p><p><strong>Hash:</strong> ${escapeHtml(item.hash ?? 'não disponível')}</p></section>`).join('')}</details>`;
  const issueCard = (issue, group, presentation) => {
    group = presentation.result;
    issue = presentation.issue;
    const evidence = correlatedEvidence(issue);
    const labelComparisons = labelComparisonsHtml(issue.abntItemIds[0], evidence);
    const correctionPresentation = group === 'passed'
      ? { title: 'Orientação e manutenção', confirmation: 'mantenha este registro como evidência positiva do escopo observado e reavalie se a página mudar.' }
      : group === 'humanReview'
        ? { title: 'Como revisar e concluir', confirmation: 'registre a decisão humana, a justificativa e as evidências consideradas.' }
        : group === 'alerts'
          ? { title: 'Como analisar e tratar', confirmation: 'registre se a análise confirmou uma barreira e repita a auditoria somente após eventual correção.' }
          : { title: 'Como corrigir e confirmar', confirmation: 'repita a verificação após a correção.' };
    const { guidance } = presentation;
    if (forPrint) {
      if (group === 'passed') {
        const guidanceText = group === 'passed' ? 'Resultado positivo restrito ao teste realizado.'
          : guidance.reviewSteps.slice(1, -1).join(' ');
        return `<article class="occurrence-card print-checklist-row" data-report-issue data-result="${escapeHtml(group)}"><header data-report-issue-heading><h3>${escapeHtml(issue.title)}</h3><p>${escapeHtml(label(presentation.outcome, outcomeLabels))} · ${escapeHtml(issue.pageId)} · WCAG ${escapeHtml(issue.wcag.join(', ') || 'sem referência')}</p></header>${labelComparisons}<p>${escapeHtml(guidanceText)}</p></article>`;
      }
      const steps = group === 'passed' ? '' : `<ol>${guidance.reviewSteps.map(step => `<li>${escapeHtml(step)}</li>`).join('')}</ol>`;
      const announcement = issue.occurrences.length <= 1 && (issue.announcement?.length ?? 0) <= 300
        ? `<p><strong>Anúncio estimado:</strong> ${escapeHtml(issue.announcement ?? 'não disponível')}.</p>`
        : '<p>Nomes e anúncios individuais: consulte o mapa e as fichas do HTML da mesma revisão.</p>';
      return `<article class="occurrence-card" data-report-issue data-result="${escapeHtml(group)}"><header data-report-issue-heading><h3>${escapeHtml(issue.title)}</h3><p>${escapeHtml(label(presentation.outcome, outcomeLabels))} · ${escapeHtml(presentation.classifications.map(value => label(value, classificationLabels)).join(', '))} · ${escapeHtml(issue.pageId)} · WCAG ${escapeHtml(issue.wcag.join(', ') || 'sem referência')}</p></header>${labelComparisons}<p>${escapeHtml(guidance.observed)}</p><p>${escapeHtml(guidance.impact)}</p><p><strong>Como tratar:</strong> ${escapeHtml(guidance.correction)}</p><p>${escapeHtml(guidance.example)}</p>${evidencePreview(evidence, issue)}${steps}${announcement}${evidence.filter(item => item.snippet).map(item => `<p><strong>${escapeHtml(item.evidenceId)} — trecho de código:</strong></p><pre>${escapeHtml(Array.from(item.snippet).slice(0,400).join(''))}</pre>${item.snippet.length > 400 ? '<p>Trecho resumido; código integral no HTML/JSON.</p>' : ''}`).join('')}<p>${countLabel(issue.occurrences.length, 'registro associado', 'registros associados')} · ${countLabel(evidence.length, 'evidência', 'evidências')}. Correlação individual e orientações completas no HTML/JSON.</p></article>`;
    }
    // A ocorrência aponta para o item do Anexo de evidências — o lugar único onde estão o ID, a imagem do
    // elemento e os dois SHA-256 inteiros. Antes o link dizia "consultar evidências registradas" sem
    // dizer onde, e quem lê o PDF tinha de procurar a ficha de olho.
    const firstAnnexedEvidence = evidence.find(item => evidenceAnchorById.has(item.evidenceId));
    const evidenceLink = firstAnnexedEvidence
      ? `<a data-report-consult-evidence href="#${evidenceAnchorById.get(firstAnnexedEvidence.evidenceId)}">Ver Anexo de evidências, item ${annexNumberById.get(firstAnnexedEvidence.evidenceId)}</a>`
      : '<p>Nenhuma evidência correlata foi registrada para esta verificação.</p>';
    return `<article class="occurrence-card" data-report-issue data-result="${escapeHtml(group)}" data-classification="${escapeHtml(issue.classification)}" data-page="${escapeHtml(issue.pageId)}" data-engine="${escapeHtml(issue.engine)}" data-impact="${escapeHtml(issue.impact ?? 'none')}" data-wcag="${escapeHtml(reportWcagLevels(issue.wcag).join(' '))}" data-abnt="${escapeHtml(reportAbntFilterToken(issue.abntItemIds))}"><header data-report-issue-heading><h3>${escapeHtml(issue.title)}</h3><p><strong>Resultado neste item:</strong> ${escapeHtml(label(presentation.outcome, outcomeLabels))}.</p><p><strong>Classificação:</strong> ${escapeHtml(presentation.classifications.map(value => label(value, classificationLabels)).join(', '))}. <strong>${presentation.outcome === 'cantTell' ? 'Impacto se confirmado' : 'Impacto'}:</strong> ${escapeHtml(label(issue.impact, impactLabels, 'Não aplicável'))}.</p></header><details data-report-issue-details><summary>Entender o resultado, revisar e consultar evidências</summary>${plainBlock('impact', 'Impacto para a pessoa usuária', `<p>${escapeHtml(guidance.impact)}</p>`)}${plainBlock('observed', 'O que foi observado', `<p>${escapeHtml(guidance.observed)}</p>${labelComparisons}`)}${plainBlock('correction', correctionPresentation.title, `<p><strong>Correção:</strong> ${escapeHtml(guidance.correction)}</p><p><strong>Confirmação:</strong> ${escapeHtml(correctionPresentation.confirmation)}</p>`)}${plainBlock('announcement', 'Nome acessível e anúncio estimado', `<p><strong>Nome acessível:</strong> ${escapeHtml(issue.accessibleName ?? 'não disponível')}.</p><p><strong>Anúncio estimado:</strong> ${escapeHtml(issue.announcement ?? 'indisponível')}.</p><p>Esta prévia não é transcrição literal de tecnologia assistiva e pode variar conforme o leitor e as preferências.</p>`)}${plainBlock('normative', 'Fundamentação normativa', `<p><strong>WCAG 2.2:</strong> ${escapeHtml(issue.wcag.join(', ') || 'sem referência')}. <strong>ABNT NBR 17225:</strong> ${escapeHtml(reportAbntItemsLabel(issue.abntItemIds))}.</p>`)}${evidencePreview(evidence, issue)}<p data-report-live-action="evidence-only">O destaque ao vivo não está disponível neste relatório. Consulte as capturas registradas no momento da auditoria.</p>${evidenceLink}<ol>${guidance.reviewSteps.map(step => `<li>${escapeHtml(step)}</li>`).join('')}</ol><p>${escapeHtml(guidance.example)}</p>${technicalDetails(issue, evidence)}</details></article>`;
  };
  const groupedChecks = new Map();
  for (const group of ['failed', 'alerts', 'humanReview', 'passed']) {
    for (const issue of view.issues[group]) {
      for (const itemId of new Set(issue.abntItemIds.length ? issue.abntItemIds : ['__none__'])) {
        if (!groupedChecks.has(itemId)) groupedChecks.set(itemId, []);
        groupedChecks.get(itemId).push({ issue, group });
      }
    }
  }
  let cardOrdinal = 0;
  const itemGroups = [...groupedChecks].map(([itemId, checks]) => {
    const matchingOccurrences = checks.flatMap(({ issue }) => issue.occurrences).filter(occurrence => itemId === '__none__' ? !occurrence.itemId : occurrence.itemId === itemId);
    const occurrenceCount = new Set(matchingOccurrences.map(occurrence => occurrence.occurrenceId)).size;
    const failed = matchingOccurrences.some(occurrence => occurrence.legalReference);
    const pending = matchingOccurrences.some(occurrence => occurrence.decision ? occurrence.decision.answer === 'não foi possível determinar' : ['cantTell', 'untested'].includes(occurrence.outcome));
    const reference = itemId !== '__none__' && (failed || pending) ? `<p data-report-item-reference>${failed ? 'Inconformidade ao' : 'Verificar o'} item ${escapeHtml(itemId)} da ABNT NBR 17225:2025</p>` : '';
    const title = itemId === '__none__' ? REPORT_NO_ABNT_ITEM_LABEL : `Item ${itemId} da ABNT NBR 17225:2025`;
    const cards = checks.map(({ issue, group }) => {
      const presentation = reportItemCheckPresentation(issue, itemId);
      const anchor = `report-check-${++cardOrdinal}`;
      return issueCard(issue, group, presentation).replace('class="occurrence-card"', `class="occurrence-card" id="${anchor}" data-report-check-key="${escapeHtml(issue.checkKey)}"`);
    }).join('');
    return `<details data-report-item-group="${escapeHtml(itemId)}"><summary>${escapeHtml(title)} · ${countLabel(checks.length, 'verificação', 'verificações')} · ${countLabel(occurrenceCount, 'ocorrência', 'ocorrências')}</summary>${reference}${cards}</details>`;
  }).join('');
  const section = (index, body) => `<section id="report-section-${index + 1}" aria-labelledby="report-heading-${index + 1}"><h2 id="report-heading-${index + 1}">${escapeHtml(viewSectionTitle(index))}</h2>${body}</section>`;
  const delivery = deliveryIdentity === null ? '' : `<p><strong>ExportDeliveryIdentityV1:</strong> auditoria ${escapeHtml(deliveryIdentity.auditId)}; revisão ${deliveryIdentity.modelRevision}; hash ${escapeHtml(deliveryIdentity.modelHash)}; tentativa ${escapeHtml(deliveryIdentity.attemptId)}.</p>`;
  const navigationLabels = ['Sumário', 'Resultados', 'Quadro de constatações', 'Revisão guiada', 'Anúncios', 'Teclado', 'Matriz ABNT', 'Metodologia e evidências'];
  const navigation = `<div data-report-navigation><nav class="section-nav" aria-label="Seções do relatório"><strong>Ir para</strong><ul>${navigationLabels.map((navigationLabel, index) => `<li><a href="#report-section-${index + 1}">${escapeHtml(navigationLabel)}</a></li>`).join('')}</ul></nav></div>`;
  const coverage = view.executive.coverage.status === 'available' ? view.executive.coverage.percent : 'indisponível';
  const limitationsList = listedLimitations(view.executive.limitations);
  // Mesma cláusula em linguagem simples que a aba interativa mostra, pela mesma derivação: sem isto o
  // leitor do PDF (o artefato principal) só descobre que os testes interativos não rodaram lendo um
  // código em maiúsculas. A revisão da 1.1.21 mediu "Observação passiva" 0 vezes no PDF entregue.
  const limitationClauses = view.executive.limitationClauses ?? [];
  const limitationSummaryHtml = limitationClauses.length === 0 ? ''
    : ` · ${limitationClauses.map(value => escapeHtml(value)).join(' · ')}`;
  // O modelo já carrega método, viewport, ledger normativo e notas editoriais; o documento entregue
  // é o artefato que a fiscalização lê. Sem isto, quem confere a norma impressa vê "3.2.2 no Anexo C"
  // onde o relatório diz "3.3.2" e não encontra a explicação em lugar nenhum do HTML nem do PDF.
  const methodFacts = [`Método: ${view.methodology.methodology.name}.`,
    `Regras próprias: ${view.methodology.methodology.coreRuleCount}.`,
    `Regras suplementares: ${view.methodology.methodology.supplementalRuleCount}.`,
    `Itens normativos: ${view.methodology.methodology.itemCount}.`];
  const observedViewport = viewportSummary(view.methodology.viewport);
  if (observedViewport !== null) methodFacts.push(`Viewport observado: ${observedViewport}.`);
  const methodFactsHtml = `<p>${escapeHtml(methodFacts.join(' '))}</p>`;
  const normativeLedgerHtml = `<h3>Ledger normativo</h3><ul>${view.methodology.normative.sources.map(source => {
    const locator = source.localCopy
      ? `arquivo ${escapeHtml(source.localCopy.fileName)}; SHA-256 ${escapeHtml(source.localCopy.sha256)}`
      : `URL ${escapeHtml(source.url)}`;
    return `<li>${escapeHtml(source.title)} — versão ${escapeHtml(source.version)}; identificador ${escapeHtml(source.id)}; ${locator}.</li>`;
  }).join('')}</ul>`;
  const editorialNotesHtml = `<h3>Notas de integridade normativa</h3><p>Informação impressa e normalização adotada permanecem separadas; o relatório não atribui à ABNT errata não localizada.</p><ul>${view.methodology.normative.editorialNotes.map(note => `<li><strong>${escapeHtml(note.itemId)}:</strong> impresso “${escapeHtml(note.printed)}”; normalização “${escapeHtml(note.normalized)}”. ${escapeHtml(note.rationale)}</li>`).join('')}</ul>`;
  const annexEvidence = view.technicalEvidence.map(evidence => forPrint && evidence.snippet?.length > 400
    ? { ...evidence, snippet: `${Array.from(evidence.snippet).slice(0,400).join('')} […] Trecho resumido para impressão; código integral no HTML/JSON desta revisão.` }
    : evidence);
  const annex = forPrint ? `<p>URL e período de observação constam no escopo. O inventário abaixo preserva IDs e os dois hashes de cada evidência; código integral, nomes, anúncios e correlações por elemento estão no HTML/JSON desta revisão.</p><table><thead><tr><th>Evidência</th><th>Tipo / estado</th><th>Seletor / hashes</th></tr></thead><tbody>${view.technicalEvidence.map(evidence => `<tr id="${evidenceAnchorById.get(evidence.evidenceId)}"><th scope="row">Item ${annexNumberById.get(evidence.evidenceId)} — ${escapeHtml(evidence.evidenceId)}</th><td>${escapeHtml(evidence.kind)} / ${escapeHtml(evidence.state ?? 'não registrado')}<br>${escapeHtml(evidence.pageId)}<br>Recebida (UTC): ${escapeHtml(evidence.metadata?.captureReceivedAt ?? 'não registrado')}</td><td>${escapeHtml(evidence.selector?.css ?? 'página')}<br>${escapeHtml(EVIDENCE_RECORD_HASH_LABEL)}: <code>${escapeHtml(evidence.hash ?? 'não registrado')}</code><br>${escapeHtml(EVIDENCE_FILE_HASH_LABEL)}: <code>${escapeHtml(evidenceFileHashPresentation(evidence).value)}</code></td></tr>`).join('')}</tbody></table>${view.technicalEvidence.filter(evidence => safePng(evidence.dataUrl) && !firstPreviewByEvidence.has(evidence.evidenceId)).map(evidence => `<figure><img class="evidence-media" src="${escapeHtml(evidence.dataUrl)}" alt="${escapeHtml(evidence.evidenceId)}"><figcaption>${escapeHtml(`Item ${annexNumberById.get(evidence.evidenceId)} — ${evidence.evidenceId}.`)}</figcaption></figure>`).join('')}` : annexEvidence.map(evidence => `<article class="evidence-card" id="${evidenceAnchorById.get(evidence.evidenceId)}" data-report-evidence="${escapeHtml(evidence.evidenceId)}" data-evidence-kind="${escapeHtml(evidence.kind)}"><h4>Item ${annexNumberById.get(evidence.evidenceId)} — ${escapeHtml(evidence.evidenceId)} (${escapeHtml(label(evidence.kind, evidenceKindLabels, 'Evidência registrada'))})</h4>${evidenceProvenanceHtml(evidence)}<dl class="meta"><dt>ID da evidência</dt><dd><code>${escapeHtml(evidence.evidenceId)}</code></dd>${evidenceHashMarkup(evidence)}</dl><p><strong>Seletor:</strong> ${escapeHtml(evidence.selector?.css ?? 'não registrado')}</p><p><strong>Snippet:</strong> ${escapeHtml(evidence.snippet ?? 'não disponível')}</p>${firstPreviewByEvidence.has(evidence.evidenceId) ? `<p>A imagem não se repete aqui: <a href="#${firstPreviewByEvidence.get(evidence.evidenceId)}">Consultar captura ${escapeHtml(evidence.evidenceId)} já apresentada</a>. O registro e os dois hashes acima identificam o arquivo dessa imagem.</p>` : safePng(evidence.dataUrl) ? `<img class="evidence-media" src="${escapeHtml(evidence.dataUrl)}" alt="${escapeHtml(`${label(evidence.kind, evidenceKindLabels, 'Evidência registrada')} local da evidência ${evidence.evidenceId}`)}">` : '<p><strong>Imagem segura:</strong> PNG local não disponível.</p>'}</article>`).join('');
  const documentHtml = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${csp}"><title>Relatório de auditoria — Audita Acessibilidade</title><style>${REPORT_CSS}</style></head><body class="report-view-document">${header()}<main id="conteudo"><h1>Relatório de auditoria de acessibilidade</h1><p class="report-static-identity">Escopo avaliado: ${escapeHtml(view.executive.identity.finalUrl)}.</p>
${section(0, `<p data-report-outcome><strong>Estado da auditoria:</strong> ${escapeHtml(label(view.executive.status, statusLabels))}.</p><div data-report-coverage><strong>Cobertura automática: ${escapeHtml(coverage)}.</strong> Mede os testes do motor próprio com conclusão automática (passed, failed ou inapplicable), divididos pelo inventário desse motor nas páginas tentadas; não é nota, certificação ou declaração de conformidade.</div><div class="summary-grid" data-report-metrics>${['failed','alerts','humanReview','passed'].map(metric).join('')}</div>${findingsCallToActionHtml(view.findingsBoard)}<p>Formatos desta entrega: HTML, PDF, CSV e JSON.</p><details data-report-limitations><summary>Limitações registradas (${limitationsList.length})${limitationSummaryHtml}</summary><ul>${limitationsList.map(value => `<li>${escapeHtml(value)}</li>`).join('') || '<li>Nenhuma limitação crítica registrada.</li>'}</ul></details>`)}
<p data-report-summary-note>Resumo executivo — não substitui o relatório completo. Fichas, capturas, anúncios, conclusões humanas detalhadas e evidências individuais estão no relatório completo da mesma auditoria e revisão.</p>
${forPrint ? '' : '<div data-report-print-controls><button type="button" data-report-print-summary>Imprimir resumo / salvar PDF</button><p data-report-print-status role="status">Resumo: totais, limitações, matriz ABNT e metodologia, sem fichas, capturas e conclusões humanas detalhadas. No diálogo de impressão, escolha Salvar como PDF.</p></div>'}
${resultsOverviewHtml(view)}
${checklistHtml(view.checklist, forPrint, view.technicalEvidence)}
${forPrint ? `<section data-print-observation-scope><h2>Escopo e período observado</h2><p>Datas em UTC, registradas pelo relógio local; não certificado.</p><ul>${model.pages.map(page => `<li><strong>${escapeHtml(page.pageId)}</strong> — ${escapeHtml(page.finalUrl || page.requestedUrl || 'URL não registrada')}<br>Observação: ${escapeHtml(page.timestamps.startedAt || 'início não registrado')} – ${escapeHtml(page.timestamps.endedAt || 'fim não registrado')}.</li>`).join('')}</ul></section>` : ''}
${forPrint ? '<p data-print-reading-note><strong>PDF de leitura:</strong> verificações agrupadas, orientações essenciais e evidências apresentadas uma vez. Não repete o dossiê de cada ocorrência. O HTML contém as orientações completas e detalhes expansíveis; o JSON conserva todos os registros técnicos. Os arquivos se referem à mesma revisão e hash.</p>' : ''}
${navigation}<div class="filter-actions"><button type="button" data-report-clear-filters>Mostrar todos os resultados</button><p role="status" data-report-filter-status></p></div><noscript><p>Os filtros exigem JavaScript local. Todos os registros continuam disponíveis nos expansores abaixo.</p></noscript>
${section(1, itemGroups)}
${section(2, findingsBoardHtml(view.findingsBoard))}
${section(3, reportHumanHistory(view.reviewHistory ?? [], evidenceAnchorById) + '<p>Indícios e sinais inconclusivos dos motores estão agrupados por item; não são barreiras confirmadas. Quando falta a correlação com um elemento, é necessário localizar e reproduzir a situação antes de concluir. Perguntas gerais ficam no checklist separado do HTML.</p>')}
${section(4, reportViewReaderMaps(view))}
${section(5, reportViewKeyboardMaps(view))}
${section(6, `<details data-report-matrix><summary>Consultar a matriz completa dos 146 itens</summary><div class="matrix-scroll" role="region" aria-label="Matriz completa dos 146 itens ABNT" tabindex="0"><table><caption>Matriz completa da ABNT NBR 17225</caption><thead><tr><th scope="col">Item</th><th scope="col">Título</th><th scope="col">Classificação</th><th scope="col">Resultado</th><th scope="col">WCAG</th></tr></thead><tbody>${view.matrix.map(row => `<tr><th scope="row">${escapeHtml(row.id)}</th><td>${escapeHtml(row.title)}</td><td>${escapeHtml(label(row.classification, classificationLabels))}</td><td>${escapeHtml(label(row.outcome, outcomeLabels))}</td><td>${escapeHtml(row.wcag.map(ref => `${ref.id} ${ref.level}`).join(', '))}</td></tr>`).join('')}</tbody></table></div></details>`)}
${section(7, `<p>Versão da extensão que realizou a auditoria: ${escapeHtml(model.versions.extension)}.</p>${methodFactsHtml}${view.methodology.caveats.map(value => `<p>${escapeHtml(value)}</p>`).join('')}<p><strong>Revisão do modelo:</strong> ${view.modelRevision}. <strong>Integridade:</strong> ${escapeHtml(view.modelHash)}.</p>${delivery}<h3>Fontes oficiais</h3><ul>${CONSUMER_ACCESSIBILITY_FIXED_BASIS.sources.map(source => `<li data-official-source>${escapeHtml(source.publisher)} — ${escapeHtml(source.title)} — ${escapeHtml(source.url)}</li>`).join('')}</ul>${normativeLedgerHtml}${editorialNotesHtml}<details data-report-annex><summary>Anexo de evidências e registros técnicos (${view.technicalEvidence.length})</summary><h3>Anexo de evidências</h3><p>${escapeHtml(EVIDENCE_SHA256_HELP)}</p>${annex}</details>`)}
</main><footer class="report-footer"><p>Audita Acessibilidade — relatório local da auditoria ${escapeHtml(view.auditId)}.</p></footer>${forPrint ? '' : `<script>${REPORT_VIEW_SCRIPT}</script>`}</body></html>`;
  return forPrint ? documentHtml.replace(/<details(?![^>]*\bopen\b)(?=[\s>])/gu, '<details open') : documentHtml;
}

function findingsCallToActionHtml(board) {
  if (!board) return '';
  return `<aside class="findings-cta" data-findings-cta><h3>Situação dos requisitos obrigatórios</h3><p>${escapeHtml(scoreboardSentence(board.scoreboard))}</p><p><a href="#report-section-3">Ver o quadro de constatações</a></p></aside>`;
}

function findingsBoardHtml(board) {
  if (!board) return '<p>Quadro de constatações indisponível nesta versão do relatório.</p>';
  const score = [['Não atendidos', board.scoreboard.notMet, 'failed'], ['Atendidos', board.scoreboard.met, 'passed'],
    ['Não aplicáveis', board.scoreboard.notApplicable, 'inapplicable'], ['Sem conclusão', board.scoreboard.pending, 'pending']]
    .map(([name, value, tone]) => `<div data-findings-tone="${tone}"><dt>${escapeHtml(name)}</dt><dd>${value}</dd></div>`).join('');
  const notMet = board.groups.notMet.map(entry => `<article data-findings-item="${escapeHtml(entry.itemId)}"><h4>Item ${escapeHtml(entry.itemId)} — ${escapeHtml(entry.title)} (requisito)</h4><p class="findings-method">Como foi concluído: ${escapeHtml(entry.method)}.</p><ol>${entry.findings.map(finding => `<li data-findings-occurrence="${escapeHtml(finding.occurrenceId)}">${finding.element ? `<p class="findings-element">Elemento: ${escapeHtml(finding.element)}</p>` : ''}<p>${escapeHtml(finding.source === 'human' ? `Constatação (revisão humana de ${finding.evaluator}, ${finding.decidedAtLabel}): ${finding.text}` : `Constatação (verificação automática): ${finding.text}`)}</p><p class="findings-citation" data-findings-citation>${escapeHtml(finding.citation)}</p></li>`).join('')}</ol></article>`).join('')
    || '<p>Nenhum requisito foi dado como não atendido até agora. Isso não significa conformidade: veja os itens sem conclusão.</p>';
  const met = board.groups.met.map(entry => `<li>Item ${escapeHtml(entry.itemId)} — ${escapeHtml(entry.title)}. Como foi concluído: ${escapeHtml(entry.method)}${entry.evaluators.length ? ` (${escapeHtml(entry.evaluators.join(', '))}, ${escapeHtml(entry.decidedAtLabel)})` : ''}.</li>`).join('')
    || '<li>Nenhum requisito foi dado como atendido até agora.</li>';
  const list = entries => entries.map(entry => `<li>Item ${escapeHtml(entry.itemId)} — ${escapeHtml(entry.title)}</li>`).join('') || '<li>Nenhum.</li>';
  const recommendations = board.recommendations;
  return `<p>${escapeHtml(FINDINGS_BOARD_INTRO)}</p><dl class="findings-score" data-findings-score>${score}</dl><p class="findings-limit">${escapeHtml(`${scoreboardSentence(board.scoreboard)} ${FINDINGS_BOARD_LIMIT}`)}</p>` +
    `<section data-findings-group="not-met"><h3>Requisitos não atendidos (${board.groups.notMet.length})</h3>${notMet}</section>` +
    `<section data-findings-group="met"><h3>Requisitos atendidos no que foi observado (${board.groups.met.length})</h3><ul>${met}</ul></section>` +
    `<details data-findings-group="others"><summary>Não aplicáveis (${board.groups.notApplicable.length}) e sem conclusão (${board.groups.pending.length})</summary><h4>Não aplicáveis</h4><ul>${list(board.groups.notApplicable)}</ul><h4>Sem conclusão (dependem de revisão humana ou de condições não observadas)</h4><ul>${list(board.groups.pending)}</ul></details>` +
    `<p class="findings-recommendations">${escapeHtml(`Recomendações (contam só para a conformidade plena): ${recommendations.failed} não atendidas, ${recommendations.passed} atendidas, ${recommendations.inapplicable} não aplicáveis e ${recommendations.pending} sem conclusão.`)}</p>` +
    `<details data-findings-legal><summary>Base consumerista padronizada (opcional, para quem analisa relações de consumo)</summary><p>${escapeHtml(board.legalParagraph)}</p></details>`;
}

function viewSectionTitle(index) {
  return [
    'Sumário executivo e limitações críticas',
    'Cobertura e quatro grupos de resultado',
    FINDINGS_BOARD_TITLE,
    'Revisão humana guiada e conclusões registradas',
    'Mapas de anúncios',
    'Mapa do teclado',
    'Matriz completa dos 146 itens',
    'Metodologia, fontes, integridade, evidências técnicas e anexos',
  ][index];
}

function reportHumanHistory(entries, evidenceAnchorById) {
  if (!entries.length) return `<p data-review-history-empty>${HUMAN_REVIEW_EMPTY}</p>`;
  return `<details data-review-history><summary>Conclusões humanas registradas (${entries.length})</summary><p>${HUMAN_REVIEW_DESCRIPTION}</p><ol>${entries.map(entry => {
    const links = entry.evidenceRefs.map(id => evidenceAnchorById.get(id)).filter(Boolean);
    return `<li data-review-record="${escapeHtml(entry.occurrenceId)}" data-review-answer="${escapeHtml(entry.answer)}"><h3>${escapeHtml(humanReviewHeading(entry))}</h3><dl>${humanReviewMetadata(entry).map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`).join('')}</dl>${marksCropsHtml(entry.marksRecord)}${links.length ? links.map((anchor, index) => `<a data-report-consult-evidence href="#${anchor}">Consultar evidência ${index + 1}</a>`).join(' ') : '<p>Nenhuma evidência correlata foi registrada para esta ocorrência.</p>'}</li>`;
  }).join('')}</ol></details>`;
}

/** Recortes das áreas marcadas na revisão: a imagem guardada recortada por `viewBox`, sem pixel novo. */
function marksCropsHtml(record) {
  if (!record?.crops?.length) return '';
  return `<div class="marks-crops" data-review-marks>${record.crops.map(crop =>
    `<figure>${marksCropSvg(crop, escapeHtml)}<figcaption>${escapeHtml(crop.caption)}</figcaption></figure>`).join('')}</div>`;
}

function reportViewReaderMaps(view) {
  const maps = readerMapPresentation(view.executive.pages, view.readerMaps);
  // O mapa atual abre com um cabeçalho próprio: é por ele que quem usa leitor de tela encontra a
  // seção, e é o mesmo título que a página de conferência por Tab mostra. Até 1.2.0 o cartão abria
  // direto no texto antigo, que nomeava o mapa na própria frase e não tinha cabeçalho.
  const intro = maps.some(map => map.format === 'reading-codes')
    ? `<h3>${escapeHtml(READER_MAP_TITLE)}</h3><p>${escapeHtml(READER_MAP_INTRO)}</p>`
    : `<p>${escapeHtml(READER_MAP_LEGACY_INTRO)}</p>`;
  return `${intro}${maps.map(map => {
    const figures = map.segments.map(segment => `<figure class="announcement-map-segment" data-map-segment="${escapeHtml(segment.id)}">${segment.dataUrl
      ? `<img class="evidence-media" data-map-segment-image src="${escapeHtml(segment.dataUrl)}" alt="${escapeHtml(segment.caption)}" width="${segment.width}" height="${segment.height}">`
      : '<p>PNG do segmento indisponível. A legenda e a proveniência foram preservadas.</p>'}<figcaption>${escapeHtml(segment.caption)}</figcaption></figure>`).join('');
    // Nos mapas até 1.2.0 os números vivem dentro do PNG e a legenda vem numa lista única no fim do
    // cartão; é assim que a auditoria guardada foi gerada e é assim que ela continua abrindo.
    const legend = map.format === 'reading-codes' || !map.legend.length ? '' : `<h4>Legenda completa dos anúncios estimados</h4><ol class="announcement-map-legend">${map.legend.map(entry =>
      `<li value="${entry.number}" data-map-marker="${entry.number}"><bdi>${escapeAuditedText(entry.preview)}</bdi><p>${escapeHtml(entry.location)}</p></li>`).join('')}</ol>`;
    const provenance = map.provenance.length ? `<details data-map-provenance><summary>Consultar origem, integridade e limites do mapa</summary><dl class="meta map-meta">${map.provenance.map(([label, value]) =>
      `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`).join('')}</dl></details>` : '';
    const body = map.format === 'reading-codes' ? readerMapColumns(map) : figures;
    return `<article class="map-card" data-announcement-map-page="${escapeHtml(map.pageId)}" data-map-status="${escapeHtml(map.status)}" data-map-format="${escapeHtml(map.format)}"><h3>${escapeHtml(map.title)}</h3><p class="map-state map-state--${escapeHtml(map.status)}">${escapeHtml(map.summary)}</p>${map.coverage ? `<p>${escapeHtml(map.coverage)}</p>` : ''}${map.limitations.length ? `<ul>${map.limitations.map(value => `<li>${escapeHtml(value)}</li>`).join('')}</ul>` : ''}${body}${legend}${provenance}</article>`;
  }).join('')}`;
}

/**
 * Trecho do mapa de leitura com a legenda ao lado: a imagem à esquerda e, à direita, os códigos daquele
 * trecho com o texto que um leitor de tela falaria. É o mesmo par caixa ↔ texto que a pessoa vê na
 * página; empilhar em tela estreita mantém linha e legenda juntas.
 */
function readerMapColumns(map) {
  if (!map.segments.length) {
    return map.legend.length
      ? `<div class="reader-map-columns"><ol class="reader-map-segment-legend">${map.legend.map(entry =>
        `<li value="${entry.number}" data-map-marker="${entry.number}"><span class="reader-map-code">${escapeHtml(entry.code)} </span><bdi>${escapeAuditedText(entry.preview)}</bdi></li>`).join('')}</ol></div>`
      : '';
  }
  return map.segments.map(segment => {
    const image = segment.dataUrl
      ? `<img class="evidence-media" data-map-segment-image src="${escapeHtml(segment.dataUrl)}" alt="${escapeHtml(segment.caption)}" width="${segment.width}" height="${segment.height}">`
      : '<p>PNG do segmento indisponível. A legenda e a proveniência foram preservadas.</p>';
    const entries = segment.entries.length
      ? `<ol class="reader-map-segment-legend">${segment.entries.map(entry =>
        `<li value="${entry.number}" data-map-marker="${entry.number}"><span class="reader-map-code">${escapeHtml(entry.code)} </span><bdi>${escapeAuditedText(entry.preview)}</bdi></li>`).join('')}</ol>`
      : '<p class="reader-map-empty">Nenhum código neste trecho.</p>';
    return `<figure class="announcement-map-segment reader-map-segment" data-map-segment="${escapeHtml(segment.id)}">`
      + `<div class="reader-map-columns"><div class="reader-map-image">${image}</div>${entries}</div>`
      + `<figcaption>${escapeHtml(segment.caption)}</figcaption></figure>`;
  }).join('');
}

function reportViewKeyboardMaps(view) {
  const maps = keyboardMapPresentation(view.executive.pages, view.keyboardMaps ?? []);
  const entries = (list, kind, heading, describe) => list.length
    ? `<h4>${escapeHtml(heading)}</h4><ol class="keyboard-map-${kind}s">${list.map(entry => `<li value="${entry.number}" data-keyboard-map-${kind}="${entry.number}"><bdi>${escapeAuditedText(describe(entry))}</bdi><p>${escapeHtml(entry.location)}</p></li>`).join('')}</ol>`
    : '';
  return `<p>${escapeHtml(KEYBOARD_MAP_INTRO)}</p><p>${escapeHtml(KEYBOARD_MAP_TAB_HELP)}</p>` + maps.map(map => {
    const figures = map.segments.map(segment => `<figure class="announcement-map-segment keyboard-map-segment" data-keyboard-map-segment="${escapeHtml(segment.id)}">${segment.dataUrl
      ? `<img class="evidence-media" data-map-segment-image src="${escapeHtml(segment.dataUrl)}" alt="${escapeHtml(segment.caption)}" width="${segment.width}" height="${segment.height}">`
      : '<p>Imagem do mapa indisponível nesta auditoria. A lista numerada abaixo foi preservada.</p>'}<figcaption>${escapeHtml(segment.caption)}</figcaption></figure>`).join('');
    const counts = map.counts
      ? `<p class="keyboard-map-counts">${escapeHtml(keyboardMapCountsText(map.counts))}</p>`
      : '';
    const stops = entries(map.stops, 'stop', 'Onde o Tab para, na ordem', entry => `${entry.name} — ${entry.kind}`);
    const suspects = entries(map.suspects, 'suspect', 'Itens que parecem clicáveis e o Tab não alcança', entry => `${entry.name} — ${entry.reason}`);
    const provenance = map.provenance.length ? `<details data-keyboard-map-provenance><summary>Consultar origem, integridade e limites do mapa do teclado</summary><dl class="meta map-meta">${map.provenance.map(([label, value]) =>
      `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`).join('')}</dl></details>` : '';
    return `<article class="map-card keyboard-map-card" data-keyboard-map-page="${escapeHtml(map.pageId)}" data-map-status="${escapeHtml(map.status)}"><h3>${escapeHtml(map.title)}</h3><p class="map-state map-state--${escapeHtml(map.status)}">${escapeHtml(map.summary)}</p>${counts}${map.coverage ? `<p>${escapeHtml(map.coverage)}</p>` : ''}${map.limitations.length ? `<ul>${map.limitations.map(value => `<li>${escapeHtml(value)}</li>`).join('')}</ul>` : ''}${figures}${stops}${suspects}${provenance}</article>`;
  }).join('');
}

function viewSectionNavigation() {
  return `<nav class="section-nav" aria-label="Seções do relatório"><strong>Navegue pelo relatório</strong><ul>${Array.from({ length: 8 }, (_value, index) => `<li><a href="#report-section-${index + 1}">${escapeHtml(viewSectionTitle(index))}</a></li>`).join('')}</ul></nav>`;
}

function header() {
  return '<header class="report-header"><div class="report-header__inner"><p class="product-name">Audita Acessibilidade</p><p class="product-description">Auditoria independente de acessibilidade</p></div></header>';
}

function sectionNavigation() {
  return `<nav class="section-nav" aria-label="Seções do relatório"><strong>Navegue pelo relatório</strong><ul>
<li><a href="#ocorrencias">Ocorrências</a></li><li><a href="#revisao">Revisão humana</a></li><li><a href="#mapas">Mapas de anúncios</a></li><li><a href="#mapa-teclado">Mapa do teclado</a></li><li><a href="#matriz">Matriz ABNT</a></li><li><a href="#anexos">Evidências</a></li><li><a href="#metodologia">Metodologia</a></li>
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

// Teto de detalhamento do HTML/PDF (1.1.53). Uma vitrine com 1.500 produtos gerava 22 mil ocorrências e
// um HTML de 100 MB que nem o navegador nem a impressão em PDF conseguiam abrir. O modelo, o JSON-LD/EARL e
// o CSV continuam com todas as ocorrências; o HTML detalha as primeiras, na ordem de prioridade (falhas
// antes de revisões), e diz quantas ficaram de fora e onde encontrá-las.
export const REPORT_OCCURRENCE_DETAIL_LIMIT = 1_000;
export const REPORT_REVIEW_DETAIL_LIMIT = 500;

function omittedNote(omitted, singular, plural) {
  return `<p class="coverage-notice" data-report-omitted="${omitted}"><strong>${escapeHtml(omitted.toLocaleString('pt-BR'))} ${escapeHtml(omitted === 1 ? singular : plural)} não ${omitted === 1 ? 'é detalhada' : 'são detalhadas'} neste relatório</strong> para mantê-lo utilizável. A lista completa, com seletor, trecho e evidência de cada ocorrência, está nas exportações JSON-LD/EARL e CSV desta mesma auditoria.</p>`;
}

function occurrenceSection(occurrences, context, total = occurrences.length) {
  const content = occurrences.length
    ? occurrences.map((occurrence, index) => occurrenceCard(occurrence, index, context)).join('')
    : '<p>Nenhuma ocorrência foi registrada no escopo observado.</p>';
  const omitted = total - occurrences.length;
  return `<section id="ocorrencias" class="major-section" aria-labelledby="ocorrencias-titulo"><h2 id="ocorrencias-titulo">Ocorrências priorizadas</h2>
<p class="section-intro">Falhas técnicas aparecem antes de revisões humanas; impacto, página e ordem original resolvem os demais empates.</p>${omitted > 0 ? omittedNote(omitted, 'ocorrência', 'ocorrências') : ''}<div class="occurrence-list">${content}</div></section>`;
}

function labelComparisonsHtml(itemId, evidence) {
  return recordedLabelComparisons(itemId, evidence)
    .map(row => `<p data-report-label-comparison="${escapeHtml(row.evidenceId)}">${escapeHtml(row.text)}</p>`).join('');
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
<div class="chip-row">${impactMarkup(occurrence.impact, consolidated === 'cantTell', occurrence.classification === 'passed' || consolidated === 'passed')}${classificationMarkup(occurrence.classification)}</div>
<p><strong>Página:</strong> ${escapeHtml(occurrence.pageId)} — ${pageStatus(page.status)}. <strong>Observada até:</strong> ${escapeHtml(page.timestamps.endedAt)}.</p>
<div class="decision-strip"><p>Resultado do motor: ${escapeHtml(outcomeLabel(occurrence.outcome))}</p><p>Decisão humana: ${escapeHtml(decisionLabel)}</p><p>Estado consolidado: ${escapeHtml(outcomeLabel(consolidated))}</p></div>
<div class="observed"><h4>O que foi observado</h4><p>${escapeHtml(occurrence.justification || rule?.summary || 'O motor registrou esta ocorrência sem descrição adicional.')}</p>${labelComparisonsHtml(item?.id, evidence)}</div>
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
  // Only a requirement can carry the short nonconformity reference. An unmet recommendation is an
  // improvement the page should make, not a breach of the mandatory minimum, and the rest of the
  // product already refuses to convert it: the panel and the report view both gate on
  // classification === 'requirement', and the didactic text states that an unmet recommendation
  // neither demonstrates a breach of the minimum nor determines a fine.
  if (displayOutcome !== 'failed' || !item || item.classification !== 'requirement') return '';
  const automaticBasis = consumerBasisForOccurrence(occurrence);
  // Um desfecho revisado só carrega a referência quando a decisão humana está completa. A versão
  // anterior aceitava `cantTell` + "não conforme" sem exigir nota, autor e data, enquanto
  // `consumer-basis.js` e `panel-detail.js` exigem os três — o mesmo veredito humano produzia a
  // frase legal neste renderizador e nenhuma no painel. A revisão independente mediu a divergência;
  // ela não encontrou fluxo de produto que alcance este ramo hoje (a aba de exportação sempre passa
  // `reportView`, que usa o renderizador do relatório), mas um portão de redação jurídica não pode
  // depender de o caminho ser improvável — os três sítios passam a exigir o mesmo.
  const reviewedFailure = occurrence.outcome === 'cantTell' && decision?.answer === 'não conforme' &&
    typeof decision.evaluator === 'string' && decision.evaluator.length > 0 &&
    typeof decision.decidedAt === 'string' && decision.decidedAt.length > 0 &&
    typeof decision.note === 'string' && decision.note.length > 0;
  if ((!automaticBasis && !reviewedFailure) || (automaticBasis && occurrence.legalAnalysis?.basisRef !== automaticBasis.id)) return '';
  return `<section class="legal-analysis" aria-labelledby="${anchor}-juridico"><h4 id="${anchor}-juridico">Referência normativa</h4><p>Inconformidade ao item ${escapeHtml(item.id)} da ABNT NBR 17225:2025</p></section>`;
}

function occurrenceEvidence(occurrence, artifactById, imageByEvidenceId, outcome, occurrenceIndex) {
  const artifacts = occurrence.evidenceRefs.map(id => artifactById.get(id)).filter(Boolean);
  const artifact = artifacts.find(value => value.kind === 'element' && imageByEvidenceId.has(value.evidenceId))
    || artifacts.find(value => value.kind === 'full-page' && imageByEvidenceId.has(value.evidenceId));
  if (!artifact) return '<section><h4>Evidência visual</h4><p>Captura marcada indisponível; consulte as limitações e os demais registros da ocorrência.</p></section>';
  const image = imageByEvidenceId.get(artifact.evidenceId);
  const tone = outcome === 'failed' ? 'failed' : outcome === 'passed' ? 'passed' : 'review';
  const annexNumber = evidenceIndex(artifactById, artifact.evidenceId) + 1;
  const annex = `#evidencia-${annexNumber}`;
  if (artifact.kind === 'full-page') {
    const pageLegend = 'Captura integral usada como contexto; o alvo do elemento não foi localizado nesta ocorrência.';
    return `<section aria-labelledby="evidencia-ocorrencia-${occurrenceIndex + 1}"><h4 id="evidencia-ocorrencia-${occurrenceIndex + 1}">Evidência visual</h4><p class="evidence-scope-banner"><strong>Alvo elementar não localizado; evidência registrada no nível da página.</strong> A captura fornece contexto e não indica que cada pixel represente a desconformidade.</p><figure class="occurrence-evidence page-level-evidence page-level-evidence--${tone}">${renderEvidenceImage(image, pageLegend)}<figcaption>${escapeHtml(pageLegend)} <a href="${annex}">Ver Anexo de evidências, item ${annexNumber}</a>.</figcaption></figure></section>`;
  }
  const highlight = evidenceHighlight(artifact);
  const treatment = EVIDENCE_TREATMENTS_V1[tone];
  const caption = treatment && highlight ? evidenceHighlightLegend(treatment, highlight) : EVIDENCE_HIGHLIGHT_UNMARKED_LEGEND;
  return `<section aria-labelledby="evidencia-ocorrencia-${occurrenceIndex + 1}"><h4 id="evidencia-ocorrencia-${occurrenceIndex + 1}">Evidência visual</h4><figure class="occurrence-evidence">${renderMarkedEvidenceImage(image, artifact, `Captura do elemento ${artifact.nodeId || 'auditado'}.`, tone)}<figcaption>${escapeHtml(caption)} A marcação é derivada para localização; <a href="${annex}">ver Anexo de evidências, item ${annexNumber}</a>, com o PNG original e os dois SHA-256.</figcaption></figure></section>`;
}

function announcementMaps(model, imageByEvidenceId) {
  const maps = model.evidence.filter(artifact => artifact.kind === 'announcement-map');
  return `<section id="mapas" class="major-section" aria-labelledby="mapas-titulo"><h2 id="mapas-titulo">Mapa visual da prévia de anúncios</h2>
<p class="section-intro">Evidência derivada para relacionar marcadores aos elementos e às prévias calculadas. Ordem observada DOM/AX não é ordem de foco, e a prévia não é transcrição literal de tecnologia assistiva.</p><div class="map-list">${model.pages.map((page, index) => {
    const artifact = maps.find(value => value.pageId === page.pageId);
    if (!artifact) return `<article id="mapa-${index + 1}" class="map-card" data-announcement-map-page="${escapeHtml(page.pageId)}" data-map-status="absent"><h3>Página ${index + 1} — ${escapeHtml(page.pageId)}</h3><div class="map-unavailable"><p><strong>Mapa indisponível nesta auditoria.</strong></p><p>Nenhum artefato derivado validado foi registrado; a captura original permanece separada no anexo quando disponível.</p></div></article>`;
    const coverage = `${artifact.counts.annotated} de ${artifact.counts.eligible} elementos elegíveis anotados; ${artifact.counts.omittedFrame} contextos de frame, ${artifact.counts.omittedNoRect} elementos sem geometria, ${artifact.counts.omittedClipped ?? 0} escondidos por rolagem interna, ${artifact.counts.omittedLimit} por limite e ${artifact.counts.unresolvedOverlap} sobreposições não resolvidas.`;
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
    // A apresentação nova (códigos ao lado da imagem) vive no ReportView; aqui ficam os metadados
    // técnicos do artefato, dizendo o que está realmente desenhado na imagem guardada.
    const badgeMap = annotationMapReadRules(artifact.derivation.version).badge === true;
    const codeOf = number => badgeMap ? annotationCode(number) : String(number);
    const figures = artifact.segments.map(segment => {
      const image = imageByEvidenceId.get(segment.segmentId);
      const markers = artifact.derivation.geometry.annotations.filter(annotation => annotation.segmentIndex === segment.index).map(annotation => annotation.number);
      // Na 1.3.0 o que está desenhado sobre o elemento é o código L1, L2…; antes disso era o número.
      const markerText = markers.length === 1
        ? `com ${badgeMap ? 'o código' : 'marcador'} ${codeOf(markers[0])}`
        : markers.length > 1
          ? `com ${badgeMap ? 'os códigos' : 'marcadores'} ${markers.map(codeOf).join(', ')}`
          : 'sem marcadores neste recorte';
      const roleText = segment.role === 'legend-continuation' ? 'continuação da legenda' : markerText;
      const accessibleName = `Segmento ${segment.index} de ${segment.count} do mapa, ${roleText}`;
      return `<figure class="announcement-map-segment" data-map-segment="${escapeHtml(segment.segmentId)}">${image ? renderEvidenceImage(image, accessibleName) : '<p><strong>PNG do segmento indisponível.</strong> Os metadados e a legenda semântica foram preservados.</p>'}<figcaption>${escapeHtml(caption)} Segmento ${segment.index} de ${segment.count}: ${escapeHtml(roleText)}; hash do segmento <code>${escapeHtml(segment.contentHash)}</code>.</figcaption></figure>`;
    }).join('');
    const legend = artifact.legend.length ? `<h4 id="mapa-${index + 1}-legenda">Legenda semântica completa</h4><ol class="announcement-map-legend" aria-labelledby="mapa-${index + 1}-legenda">${artifact.legend.map(entry => `<li><span class="legend-selector">Elemento <code>${escapeHtml(entry.selectorSummary)}</code></span><span>Prévia calculada: <bdi>${escapeAuditedText(entry.announcementPreview)}</bdi></span><span>Origem do nome: ${escapeHtml(entry.nameSource)}; marcador no segmento ${entry.segmentIndex}.</span></li>`).join('')}</ol>` : '';
    return `<article id="mapa-${index + 1}" class="map-card" data-announcement-map-page="${escapeHtml(page.pageId)}" data-map-status="${escapeHtml(artifact.status)}"><h3>Página ${index + 1} — ${escapeHtml(page.pageId)}</h3><p class="map-state map-state--${escapeHtml(artifact.status)}">${stateText}</p><dl class="meta map-meta"><dt>Cobertura</dt><dd>${escapeHtml(coverage)}</dd><dt>Algoritmo</dt><dd><code>${escapeHtml(artifact.derivation.algorithm)}</code> ${escapeHtml(artifact.derivation.version)}</dd><dt>Captura original</dt><dd><code>${escapeHtml(artifact.fullPageEvidenceId)}</code> — <code>${escapeHtml(artifact.derivation.sourceHash)}</code></dd><dt>Hash derivado</dt><dd><code>${escapeHtml(artifact.hash)}</code></dd><dt>Limites</dt><dd>${escapeHtml(limits)}</dd><dt>Limitações</dt><dd>${escapeHtml(limitations)}</dd></dl><div class="announcement-map-segments">${figures}</div>${legend}</article>`;
  }).join('')}</div></section>`;
}

function keyboardMaps(model, imageByEvidenceId) {
  const maps = model.evidence.filter(artifact => artifact.kind === 'keyboard-map');
  const entries = (list, kind, heading, describe) => list.length
    ? `<h4>${escapeHtml(heading)}</h4><ol class="keyboard-map-${kind}s">${list.map(entry => `<li value="${entry.number}" data-keyboard-map-${kind}="${entry.number}"><bdi>${escapeAuditedText(describe(entry))}</bdi><p>${escapeHtml(entry.location)}</p></li>`).join('')}</ol>`
    : '';
  return `<section id="mapa-teclado" class="major-section" aria-labelledby="mapa-teclado-titulo"><h2 id="mapa-teclado-titulo">Mapa do teclado</h2>
<p class="section-intro">${escapeHtml(KEYBOARD_MAP_INTRO)}</p><p>${escapeHtml(KEYBOARD_MAP_TAB_HELP)}</p><div class="map-list">${keyboardMapPresentation(model.pages, maps).map((map, index) => {
    if (map.status === 'absent') return `<article id="mapa-teclado-${index + 1}" class="map-card keyboard-map-card" data-keyboard-map-page="${escapeHtml(map.pageId)}" data-map-status="absent"><h3>${escapeHtml(map.title)}</h3><div class="map-unavailable"><p><strong>Mapa do teclado indisponível nesta auditoria.</strong></p><p>${escapeHtml(map.summary)}</p></div></article>`;
    const figures = map.segments.map(segment => {
      const image = imageByEvidenceId.get(segment.id);
      return `<figure class="announcement-map-segment keyboard-map-segment" data-keyboard-map-segment="${escapeHtml(segment.id)}">${image ? renderEvidenceImage(image, segment.caption) : '<p><strong>PNG do trecho indisponível.</strong> A lista numerada foi preservada.</p>'}<figcaption>${escapeHtml(segment.caption)}</figcaption></figure>`;
    }).join('');
    const counts = map.counts ? `<p class="keyboard-map-counts">${escapeHtml(keyboardMapCountsText(map.counts))}</p>` : '';
    const metadata = `<details data-keyboard-map-provenance><summary>Consultar origem, integridade e limites do mapa do teclado</summary><dl class="meta map-meta">${map.provenance.map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd><code>${escapeHtml(value)}</code></dd>`).join('')}</dl></details>`;
    return `<article id="mapa-teclado-${index + 1}" class="map-card keyboard-map-card" data-keyboard-map-page="${escapeHtml(map.pageId)}" data-map-status="${escapeHtml(map.status)}"><h3>${escapeHtml(map.title)}</h3><p class="map-state map-state--${escapeHtml(map.status)}">${escapeHtml(map.summary)}</p>${counts}${map.coverage ? `<p>${escapeHtml(map.coverage)}</p>` : ''}${map.limitations.length ? `<ul>${map.limitations.map(value => `<li>${escapeHtml(value)}</li>`).join('')}</ul>` : ''}<div class="announcement-map-segments">${figures}</div>${entries(map.stops, 'stop', 'Onde o Tab para, na ordem', entry => `${entry.name} — ${entry.kind}`)}${entries(map.suspects, 'suspect', 'Itens que parecem clicáveis e o Tab não alcança', entry => `${entry.name} — ${entry.reason}`)}${metadata}</article>`;
  }).join('')}</div></section>`;
}

function humanReviewSection(model, itemById, decisionByOccurrence, orderedOccurrences) {
  const pending = model.manualReview.filter(entry => entry.status === 'unanswered').length;
  const completed = model.manualReview.filter(entry => entry.status === 'answered').length;
  const reviewSummary = `${pending} ${pending === 1 ? 'pendente' : 'pendentes'}; ${completed} ${completed === 1 ? 'concluída' : 'concluídas'}.`;
  const occurrenceById = new Map(model.occurrences.map(value => [value.occurrenceId, value]));
  const anchorByOccurrence = new Map(orderedOccurrences.map((value, index) => [value.occurrenceId, `ocorrencia-${index + 1}`]));
  const reviewEntries = model.manualReview.slice(0, REPORT_REVIEW_DETAIL_LIMIT);
  const omittedReviews = model.manualReview.length - reviewEntries.length;
  const marksByDecision = new Map(reviewMarksRecords(model).map(record => [record.decisionId, record]));
  const cards = reviewEntries.map((entry, index) => {
    const item = itemById.get(entry.itemId);
    const occurrence = occurrenceById.get(entry.occurrenceId);
    const decision = decisionByOccurrence.get(entry.occurrenceId);
    return `<article class="review-card" data-review-state="${escapeHtml(entry.status)}" aria-labelledby="revisao-${index + 1}"><h3 id="revisao-${index + 1}">${escapeHtml(item?.title || entry.itemId)}</h3><p><strong>Item:</strong> ${escapeHtml(entry.itemId)} (${escapeHtml(item ? CLASSIFICATION[item.classification] : 'sem classificação')}).</p><p><strong>Resultado original do motor:</strong> ${escapeHtml(outcomeLabel(occurrence?.outcome || 'cantTell'))}.</p><p><strong>Pergunta:</strong> ${escapeHtml(entry.question)}</p><p><strong>Justificativa:</strong> ${escapeHtml(entry.reason)}</p><p><strong>Decisão humana:</strong> ${escapeHtml(decision ? reviewAnswerLabel(decision.answer) : 'Pendente')}.</p>${decision ? `<p><strong>Avaliador e instante:</strong> ${escapeHtml(decision.evaluator)}, ${escapeHtml(decision.decidedAt)}.</p>${decision.revisions?.length ? `<p><strong>Respostas anteriores substituídas:</strong> ${escapeHtml(decision.revisions.map(revision => `${reviewAnswerLabel(revision.answer)} (${revision.evaluator}, ${revision.decidedAt})`).join('; '))}.</p>` : ''}<p class="human-review-note"><strong>Nota registrada:</strong> ${escapeHtml(decision.note || 'Nenhuma nota registrada.')}</p>${marksByDecision.get(decision.decisionId)?.text ? `<p><strong>Apontamento no mapa do teclado:</strong> ${escapeHtml(marksByDecision.get(decision.decisionId).text)}</p>${marksCropsHtml(marksByDecision.get(decision.decisionId))}` : ''}` : ''}<p><a href="#${escapeHtml(anchorByOccurrence.get(entry.occurrenceId) ?? 'ocorrencias')}">Ir para a ocorrência relacionada</a></p></article>`;
  }).join('');
  return `<section id="revisao" class="major-section" aria-labelledby="revisao-titulo"><h2 id="revisao-titulo">Revisão humana</h2><p>${escapeHtml(reviewSummary)} Respostas pendentes nunca são tratadas como conformidade. Resultado do motor e decisão humana permanecem separados.</p>${omittedReviews > 0 ? omittedNote(omittedReviews, 'revisão humana', 'revisões humanas') : ''}<div class="review-list">${cards || '<p>Nenhuma revisão humana foi registrada para este escopo.</p>'}</div></section>`;
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
  return `<section id="anexos" class="major-section" aria-labelledby="anexos-titulo"><h2 id="anexos-titulo">Anexo de evidências</h2><p>Capturas originais e artefatos derivados são identificados separadamente. Cada PNG validado é incorporado uma única vez e reutilizado por referência; cada evidência aparece uma vez, com o ID e os dois códigos SHA-256: o do registro e o do arquivo de imagem.</p><p>${escapeHtml(EVIDENCE_SHA256_HELP)}</p>${model.pages.map((page, pageIndex) => {
    const artifacts = model.evidence.filter(artifact => artifact.pageId === page.pageId);
    const original = artifacts.filter(artifact => !['announcement-map', 'keyboard-map'].includes(artifact.kind));
    const derived = artifacts.filter(artifact => ['announcement-map', 'keyboard-map'].includes(artifact.kind));
    return `<section class="evidence-group" aria-labelledby="anexos-pagina-${pageIndex + 1}"><h3 id="anexos-pagina-${pageIndex + 1}">Página ${pageIndex + 1} — ${escapeHtml(page.pageId)}</h3><h4>Evidências originais</h4><div class="evidence-list">${original.map(artifact => evidenceCard(artifact, model.evidence, imageByEvidenceId, model.pages)).join('') || '<p>Nenhuma evidência original registrada.</p>'}</div><h4>Evidências derivadas</h4><div class="evidence-list">${derived.map(artifact => evidenceCard(artifact, model.evidence, imageByEvidenceId, model.pages)).join('') || '<p>Nenhuma evidência derivada registrada.</p>'}</div></section>`;
  }).join('')}</section>`;
}

const EVIDENCE_POSITIONS = new WeakMap();
function evidencePosition(allEvidence, evidenceId) {
  let positions = EVIDENCE_POSITIONS.get(allEvidence);
  if (!positions) {
    positions = new Map();
    allEvidence.forEach((value, index) => { if (!positions.has(value.evidenceId)) positions.set(value.evidenceId, index); });
    if (Object.isFrozen(allEvidence)) EVIDENCE_POSITIONS.set(allEvidence, positions);
  }
  return positions.get(evidenceId) ?? -1;
}

function evidenceCard(artifact, allEvidence, imageByEvidenceId, pages) {
  const index = evidencePosition(allEvidence, artifact.evidenceId);
  const provenance = evidenceProvenanceHtml({ ...artifact, provenance: projectEvidenceProvenance(artifact, pages) });
  if (artifact.kind === 'announcement-map') {
    const coverage = `${artifact.counts.annotated}/${artifact.counts.eligible} elegíveis anotados; ${artifact.segments.length} segmentos.`;
    return `<article id="evidencia-${index + 1}" class="evidence-card evidence-card--derived" aria-labelledby="evidencia-${index + 1}-titulo"><h4 id="evidencia-${index + 1}-titulo">${escapeHtml(artifact.evidenceId)}</h4>${provenance}<dl class="meta"><dt>Tipo</dt><dd>announcement-map</dd><dt>Estado</dt><dd>${escapeHtml(artifact.status)}</dd><dt>Hash derivado</dt><dd><code>${escapeHtml(artifact.hash)}</code></dd><dt>Algoritmo</dt><dd><code>${escapeHtml(artifact.derivation.algorithm)}</code> ${escapeHtml(artifact.derivation.version)}</dd><dt>Origem pristine</dt><dd><code>${escapeHtml(artifact.fullPageEvidenceId)}</code> — <code>${escapeHtml(artifact.derivation.sourceHash)}</code></dd><dt>Cobertura</dt><dd>${escapeHtml(coverage)}</dd></dl><p class="evidence-relation">Artefato derivado localmente; os PNGs segmentados, a legenda completa, os limites e as limitações estão na seção <a href="#mapas">Mapa visual da prévia de anúncios</a>. A captura original permanece separada.</p></article>`;
  }
  const image = imageByEvidenceId.get(artifact.evidenceId);
  const relation = artifact.fullPageEvidenceId ? `Deriva ou localiza conteúdo da captura integral ${artifact.fullPageEvidenceId}.` : artifact.kind === 'full-page' ? 'Captura integral original do estado observado.' : 'Evidência elementar original, quando disponível.';
  return `<article id="evidencia-${index + 1}" class="evidence-card" aria-labelledby="evidencia-${index + 1}-titulo"><h4 id="evidencia-${index + 1}-titulo">Item ${index + 1} — ${escapeHtml(artifact.evidenceId)}</h4>${provenance}<dl class="meta"><dt>ID da evidência</dt><dd><code>${escapeHtml(artifact.evidenceId)}</code></dd><dt>Tipo</dt><dd>${escapeHtml(artifact.kind)}</dd>${evidenceHashMarkup(artifact)}${artifact.selector?.css ? `<dt>Seletor</dt><dd><code>${escapeHtml(artifact.selector.css)}</code></dd>` : ''}${artifact.backendNodeId ? `<dt>Backend node</dt><dd>${escapeHtml(artifact.backendNodeId)}</dd>` : ''}</dl><p class="evidence-relation">${escapeHtml(relation)}</p>${artifact.snippet ? `<details open data-collapsible><summary>Trecho HTML sanitizado</summary><pre><code>${escapeHtml(artifact.snippet)}</code></pre></details>` : ''}${accessibility(artifact.accessibility)}${image ? `<figure>${renderEvidenceImage(image, evidenceAlt(artifact))}<figcaption>${artifact.kind === 'full-page' ? 'PNG original da captura integral do estado observado.' : artifact.kind === 'announcement-map' ? 'PNG derivado do mapa visual; consulte relação, algoritmo e limites registrados.' : `PNG original da captura do elemento ${escapeHtml(artifact.nodeId || '')}.`}</figcaption></figure>` : '<p><strong>Imagem não incluída:</strong> PNG ausente, inválido ou fora dos limites; o registro textual e a limitação permanecem visíveis.</p>'}</article>`;
}

/**
 * Os dois códigos da ficha de evidência, inteiros: o do registro e o do arquivo PNG. É o que a ficha do
 * painel mostra, pela mesma derivação (`evidence-hash-presentation.js`), para que tela e arquivo entregue
 * não discordem sobre o mesmo arquivo.
 */
function evidenceHashMarkup(evidence) {
  return evidenceHashRows(evidence).map(([label, value, note]) =>
    `<dt>${escapeHtml(label)}</dt><dd><code>${escapeHtml(value)}</code>${note ? ` <span class="evidence-fiche-note">${escapeHtml(note)}</span>` : ''}</dd>`).join('');
}

function evidenceProvenanceHtml(evidence) {
  return evidenceProvenanceRows(evidence).map(([label, value]) =>
    `<p><strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}</p>`).join('');
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
  if (decision?.answer === 'não se aplica') return 'inapplicable';
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

function impactMarkup(impact, pendingConfirmation = false, positive = false) {
  const text = impactText(impact, pendingConfirmation, { positive }) ?? (positive || !impact ? 'Impacto não aplicável' : `Impacto ${impact}`);
  return `<span class="chip"><span aria-hidden="true">◆</span><span>${escapeHtml(text)}</span></span>`;
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
  return ({ conforme: 'Conforme', 'não conforme': 'Não conforme', 'não foi possível determinar': 'Não foi possível determinar', 'não se aplica': 'Não se aplica' })[answer] || 'Pendente';
}

function modeLabel(mode) {
  return ({ automated: 'Automatizado', assisted: 'Assistido', manual: 'Manual' })[mode] || 'Não informado';
}

function confidenceLabel(confidence) {
  return ({ high: 'Alta', medium: 'Média', low: 'Baixa' })[confidence] || 'Não informada';
}

const EVIDENCE_INDEXES = new WeakMap();
function evidenceIndex(artifactById, evidenceId) {
  let positions = EVIDENCE_INDEXES.get(artifactById);
  if (!positions || positions.size !== artifactById.size) {
    positions = new Map();
    let index = 0;
    for (const key of artifactById.keys()) positions.set(key, index++);
    EVIDENCE_INDEXES.set(artifactById, positions);
  }
  return positions.get(evidenceId) ?? -1;
}

function accessibility(value) {
  if (!value || typeof value !== 'object') return '';
  const displayedValue = 'não coletado por privacidade';
  return `<section aria-label="Propriedades de acessibilidade"><h4>Nome, função e prévia</h4><dl class="meta"><dt>Nome acessível</dt><dd>${escapeHtml(value.name || 'não disponível')}</dd><dt>Origem do nome</dt><dd>${escapeHtml(value.nameSource || 'não disponível')}</dd><dt>Descrição acessível</dt><dd>${escapeHtml(value.description || 'não disponível')}</dd><dt>Origem da descrição</dt><dd>${escapeHtml(value.descriptionSource || 'não disponível')}</dd><dt>Função</dt><dd>${escapeHtml(value.role || 'não disponível')}</dd><dt>Valor</dt><dd>${escapeHtml(displayedValue)}</dd><dt>Estados</dt><dd>${escapeHtml((value.states || []).join(', ') || 'não disponíveis')}</dd><dt>Texto visível</dt><dd>${escapeHtml(value.visibleText || 'não disponível')}</dd><dt>Prévia de anúncio</dt><dd>${escapeHtml(value.announcementPreview || 'não disponível')}</dd></dl><p><strong>Variação esperada:</strong> esta prévia não é transcrição literal de tecnologia assistiva e pode variar conforme o navegador, a API da plataforma, o leitor, o modo e as preferências.</p></section>`;
}

function evidenceAlt(artifact) {
  if (artifact.kind === 'full-page') return 'Captura integral original da página auditada';
  if (artifact.kind === 'announcement-map') return 'Mapa visual derivado da prévia de anúncios';
  if (artifact.kind === 'keyboard-map') return 'Mapa do teclado derivado da captura integral: caixas azuis numeradas onde o Tab para e caixas laranja tracejadas de itens que o Tab não alcança';
  return `Captura original do elemento auditado ${artifact.nodeId || ''}`;
}

function createImageRegistry(artifacts) {
  const definitions = [];
  const byEvidenceId = new Map();
  const byDataUrl = new Map();
  const register = (key, dataUrl, artifact) => {
    const raster = pngMetadata(dataUrl);
    if (!raster) return;
    let image = byDataUrl.get(dataUrl);
    if (!image) {
      // O quadro declarado manda quando o raster é o esperado (`width/height × pixelScale`): a captura
      // de elemento em 2× ocupa a mesma caixa de antes e o pixel a mais vira nitidez, não tamanho.
      // Sem essa conferência vale o tamanho do próprio PNG — auditorias anteriores à 1.1.57 e os
      // segmentos do mapa, que não declaram quadro.
      const declared = evidenceRasterMatchesCapture(artifact, raster) ? evidenceCaptureSize(artifact) : null;
      image = Object.freeze({
        id: `evidence-image-${definitions.length}`, dataUrl,
        width: declared?.width ?? raster.width, height: declared?.height ?? raster.height,
      });
      definitions.push(image);
      byDataUrl.set(dataUrl, image);
    }
    byEvidenceId.set(key, image);
  };
  for (const artifact of artifacts) {
    register(artifact.evidenceId, artifact.dataUrl, artifact);
    for (const segment of ['announcement-map', 'keyboard-map'].includes(artifact.kind) ? artifact.segments : []) {
      register(segment.segmentId, segment.dataUrl, segment);
    }
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
  const highlight = evidenceHighlight(artifact);
  // Sem quadro confiável (nem `metadata.width/height`, nem `metadata.clip`) não há como posicionar a
  // caixa sem misturar sistemas de escala: a captura é apresentada sem marcação, e não com uma caixa
  // possivelmente errada.
  if (!highlight) return renderEvidenceImage(image, accessibleName);
  const treatment = EVIDENCE_TREATMENTS_V1[tone];
  const aria = `${accessibleName}${treatment ? ` ${treatment.aria}` : ''}${highlight.clipped ? ` ${EVIDENCE_HIGHLIGHT_CLIPPED_LEGEND}` : ''}`;
  return `<svg class="evidence-media evidence-media--marked" role="img" aria-label="${escapeHtml(aria)}" viewBox="0 0 ${highlight.width} ${highlight.height}" width="${highlight.width}" height="${highlight.height}" preserveAspectRatio="xMidYMid meet" focusable="false"><use href="#${image.id}" width="${highlight.width}" height="${highlight.height}"></use>${evidenceShapesMarkup(evidenceHighlightShapes(highlight, tone))}</svg>`;
}

function evidenceShapesMarkup(shapes) {
  return shapes.map(shape => {
    const attributes = Object.entries(shape.attributes)
      .map(([name, value]) => ` ${name}="${escapeHtml(value)}"`).join('');
    return `<${shape.kind}${attributes}></${shape.kind}>`;
  }).join('');
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
