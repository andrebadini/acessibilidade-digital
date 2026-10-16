import { createAuditModel } from '../core/report/audit-model.js';
import { resultsOverviewElement } from '../core/report/results-overview.js';
import { checklistElement } from '../core/report/checklist-presentation.js';
import { CONSUMER_ACCESSIBILITY_FIXED_BASIS, qualifiedConsumerReference } from '../core/legal/consumer-basis.js';
import { NBR17225_ITEMS } from '../core/normative/nbr17225.js';
import { WCAG22_LEVELS } from '../core/normative/wcag22.js';
import { IMPACT_LABELS, impactText } from '../core/report/impact-labels.js';
import {
  EVIDENCE_FICHE_TREATMENT_V1, EVIDENCE_TREATMENTS_V1, projectOccurrenceEvidencePreviews,
} from '../core/report/evidence-treatment.js';
import { decodePngDataUrl } from '../core/evidence/png.js';
import {
  EVIDENCE_HIGHLIGHT_CLIPPED_LEGEND,
  evidenceCaptureSize,
  evidenceHighlight,
  evidenceHighlightLegend,
  evidenceHighlightShapes,
  evidencePixelScale,
} from '../core/report/evidence-highlight.js';
import { EXPORT_FORMATS_V1 } from '../export/export-formats.js';
import { ATTACHED_COPY_RELOADED_MESSAGE } from '../core/report/diagnostic-policy.js';
import { listedLimitations, viewportSummary } from '../core/report/text-policy.js';
import { readerMapPresentation, READER_MAP_INTRO, READER_MAP_LEGACY_INTRO } from '../core/report/reader-map-presentation.js';
import {
  keyboardMapCountsText, keyboardMapPresentation, KEYBOARD_MAP_INTRO, KEYBOARD_MAP_TAB_HELP,
} from '../core/report/keyboard-map-presentation.js';
import { projectEvidenceProvenance, evidenceProvenanceRows } from '../core/report/evidence-provenance.js';
import { accessibilityGuidance, recordedLabelComparisons } from '../core/report/plain-language-guidance.js';
import { projectReviewHistory, humanReviewMetadata, humanReviewHeading, HUMAN_REVIEW_DESCRIPTION, HUMAN_REVIEW_EMPTY } from '../core/report/human-review-presentation.js';
import { marksCropParts } from '../core/report/review-marks-presentation.js';
import {
  buildFindingsBoard, consolidatedCitationParagraph, FINDINGS_BOARD_INTRO, FINDINGS_BOARD_LIMIT, FINDINGS_BOARD_TITLE, scoreboardSentence,
} from '../core/report/findings-board.js';
import { ANSWER_LABELS, compareItemIds, formatLocalInstant } from '../core/report/lay-review.js';
import { projectTabReading } from '../core/report/tab-reading-plan.js';
import { EVIDENCE_SHA256_HELP, evidenceHashRows } from '../core/report/evidence-hash-presentation.js';
import { EVIDENCE_CROP_REGION_LEGEND, evidenceMediaParts, integralCropSource } from '../core/report/evidence-crop.js';

const GROUPS = Object.freeze(['failed', 'alerts', 'humanReview', 'passed']);
const GROUP_LABELS = Object.freeze({
  failed: 'Não conformidades', alerts: 'Alertas', humanReview: 'Revisões humanas pendentes', passed: 'Resultados positivos',
});
const OUTCOME_LABELS = Object.freeze({
  failed: 'Não atendido neste teste', passed: 'Atendido no escopo observado', cantTell: 'Requer revisão humana',
  inapplicable: 'Não aplicável', untested: 'Não testado',
});
const CLASSIFICATION_LABELS = Object.freeze({
  failed: 'Não conformidade identificada', alerts: 'Alerta', 'manual-review': 'Revisão humana necessária', passed: 'Resultado positivo',
  requirement: 'Requisito ABNT', recommendation: 'Recomendação ABNT', 'best-practice': 'Boa prática suplementar', editorial: 'Alerta editorial',
});
const STATUS_LABELS = Object.freeze({ pending: 'Pendente', complete: 'Concluída', partial: 'Concluída com limitações', cancelled: 'Cancelada', failed: 'Falhou' });
const EVIDENCE_KIND_LABELS = Object.freeze({
  'full-page': 'Página completa', element: 'Elemento', 'announcement-map': 'Mapa de leitura',
  'keyboard-map': 'Mapa do teclado',
});
const FILTERS = Object.freeze(['impact', 'wcag', 'result', 'classification', 'page', 'engine', 'abnt']);
const FILTER_PRESENTATION = Object.freeze({
  impact: Object.freeze({ visible: 'Impacto', aria: 'Filtrar por impacto' }),
  wcag: Object.freeze({ visible: 'Nível WCAG 2.2', aria: 'Filtrar por nível WCAG 2.2' }),
  result: Object.freeze({ visible: 'Tipo de resultado', aria: 'Filtrar por tipo de resultado' }),
  classification: Object.freeze({ visible: 'Classificação', aria: 'Filtrar por classificação' }),
  page: Object.freeze({ visible: 'Página avaliada', aria: 'Filtrar por página avaliada' }),
  engine: Object.freeze({ visible: 'Origem da verificação', aria: 'Filtrar por origem da verificação' }),
  abnt: Object.freeze({ visible: 'Item ABNT NBR 17225', aria: 'Filtrar por item da ABNT NBR 17225' }),
});
const WCAG_LEVEL_ORDER = Object.freeze(['A', 'AA', 'AAA']);
const NO_ABNT_ITEM = '__none__';
const NO_ABNT_ITEM_LABEL = 'Sem item ABNT associado';
const SECTION_TITLES = Object.freeze([
  'Sumário executivo e limitações críticas',
  'Cobertura e quatro grupos de resultado',
  FINDINGS_BOARD_TITLE,
  'Revisão humana guiada e conclusões registradas',
  'Mapa de leitura da página',
  'Mapa do teclado',
  'Matriz completa dos 146 itens',
  'Metodologia, fontes, integridade, evidências técnicas e anexos',
]);
const SECTION_NAV_LABELS = Object.freeze([
  'Sumário', 'Resultados', 'Quadro de constatações', 'Revisão guiada', 'Mapa de leitura',
  'Teclado', 'Matriz ABNT', 'Metodologia e evidências',
]);
// Mesmo teto do modelo de auditoria (audit-input.js, 1.1.53).
const MAX_GRAPH_NODES = 20_000_000;
const MAX_ARRAY_LENGTH = 2_000_000;
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const EVIDENCE_FRAME_BY_ARTIFACT = new WeakMap();
const PRINT_LISTENERS_BY_WINDOW = new WeakMap();
const FALLBACK_CORRECTIONS = Object.freeze({
  failed: 'Revise o elemento e aplique a orientação técnica antes de executar uma nova auditoria.',
  alerts: 'Revise o alerta no contexto da página e, se a barreira for confirmada, aplique a orientação técnica antes de repetir a auditoria.',
  humanReview: 'Realize a verificação humana indicada, registre as condições observadas e conclua se o requisito foi atendido, não atendido ou permaneceu inconclusivo.',
  passed: 'Nenhuma correção é indicada para este resultado positivo no escopo observado.',
});
const GENERIC_EVIDENCE_ONLY_MESSAGE = 'O destaque ao vivo não está disponível neste relatório. Consulte as capturas registradas no momento da auditoria.';
const ATTACHED_COPY_EVIDENCE_ONLY_MESSAGE = 'A página foi avaliada em uma cópia temporária já removida. O destaque ao vivo não está disponível; consulte as capturas e os seletores registrados no momento da auditoria.';

function denied() { throw new TypeError('REPORT_VIEW_DENIED'); }

function hasAttachedCopyReloadedLimitation(limitations) {
  return Array.isArray(limitations) && limitations.includes(ATTACHED_COPY_RELOADED_MESSAGE);
}

export function applyReportSourceControls({ reportSessionState, limitations, returnControl, explanation } = {}) {
  if (!['result', 'view-only'].includes(reportSessionState) || !Array.isArray(limitations) ||
    !returnControl || typeof returnControl !== 'object' || !explanation || typeof explanation !== 'object') denied();
  const temporaryCopyViewOnly = reportSessionState === 'view-only' && hasAttachedCopyReloadedLimitation(limitations);
  returnControl.disabled = reportSessionState !== 'result';
  returnControl.hidden = temporaryCopyViewOnly;
  explanation.hidden = !temporaryCopyViewOnly;
}

function freeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value) || Object.isFrozen(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freeze(child, seen);
  return Object.freeze(value);
}

function copyData(root) {
  const ancestors = new WeakSet();
  let nodes = 0;
  const copy = value => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (!value || typeof value !== 'object' || ancestors.has(value) || ++nodes > MAX_GRAPH_NODES) denied();
    let prototype;
    let descriptors;
    try { prototype = Object.getPrototypeOf(value); descriptors = Object.getOwnPropertyDescriptors(value); } catch { denied(); }
    const keys = Reflect.ownKeys(descriptors);
    if (Array.isArray(value)) {
      if (prototype !== Array.prototype) denied();
      const length = descriptors.length?.value;
      if (!Number.isSafeInteger(length) || length < 0 || length > MAX_ARRAY_LENGTH || keys.length !== length + 1) denied();
      ancestors.add(value);
      const output = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) denied();
        output.push(copy(descriptor.value));
      }
      ancestors.delete(value);
      return output;
    }
    if (![Object.prototype, null].includes(prototype) || keys.some(key => typeof key !== 'string')) denied();
    ancestors.add(value);
    const output = {};
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) denied();
      output[key] = copy(descriptor.value);
    }
    ancestors.delete(value);
    return output;
  };
  return copy(root);
}

function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) denied();
  const own = Object.keys(value);
  if (own.length !== keys.length || own.some(key => !keys.includes(key))) denied();
  return value;
}

function validateSummary(input, auditId) {
  const summary = copyData(input);
  exact(summary, ['version', 'auditId', 'identity', 'coverage', 'counts', 'distributions', 'limitations', 'groups', ...(Object.hasOwn(summary, 'checklist') ? ['checklist'] : [])]);
  if (summary.checklist !== undefined && !Array.isArray(summary.checklist)) denied();
  if (summary.version !== 1 || summary.auditId !== auditId) denied();
  exact(summary.identity, ['finalUrl', 'completedAt', 'status']);
  exact(summary.counts, ['errors', 'alerts', 'humanReview', 'positive']);
  exact(summary.distributions, ['impact', 'wcag', 'abnt']);
  exact(summary.groups, GROUPS);
  if (GROUPS.some(group => !Array.isArray(summary.groups[group])) ||
    Object.values(summary.distributions).some(rows => !Array.isArray(rows))) denied();
  const checkKeys = new Set();
  for (const group of GROUPS) {
    for (const card of summary.groups[group]) {
      if (typeof card?.checkKey !== 'string' || typeof card.pageId !== 'string' || typeof card.engine !== 'string' ||
        typeof card.classification !== 'string' || !Array.isArray(card.occurrenceIds) ||
        !Array.isArray(card.wcag) || !Array.isArray(card.abntItemIds) || checkKeys.has(card.checkKey)) denied();
      checkKeys.add(card.checkKey);
    }
  }
  return freeze(summary);
}

function copyRows(rows) { return rows.map(row => ({ id: row.id, count: row.count })); }

function countOptions(cards, valuesFor) {
  const counts = new Map();
  for (const card of cards) {
    for (const value of valuesFor(card)) {
      if (typeof value !== 'string' || !value) continue;
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }
  return [...counts].sort(([left], [right]) => left.localeCompare(right)).map(([id, count]) => ({ id, count }));
}

function labelFor(value, labels, fallback = 'Não informado') { return labels[value] ?? fallback; }
function outcomeLabel(value) { return labelFor(value, OUTCOME_LABELS); }
function impactLabel(value) { return labelFor(value, IMPACT_LABELS, 'Não aplicável'); }
function classificationLabel(value) { return labelFor(value, CLASSIFICATION_LABELS); }
function statusLabel(value) { return labelFor(value, STATUS_LABELS); }
function evidenceKindLabel(value) { return labelFor(value, EVIDENCE_KIND_LABELS, 'Evidência registrada'); }

function wcagLevelsFor(criteria) {
  const levels = new Set((Array.isArray(criteria) ? criteria : [])
    .map(criterion => typeof criterion === 'string' ? WCAG22_LEVELS[criterion] : undefined)
    .filter(level => WCAG_LEVEL_ORDER.includes(level)));
  return WCAG_LEVEL_ORDER.filter(level => levels.has(level));
}

function abntItemsLabel(values) {
  const items = (Array.isArray(values) ? values : []).filter(value => typeof value === 'string' && value);
  return items.length > 0 ? items.join(', ') : NO_ABNT_ITEM_LABEL;
}

function abntItemLabel(value) {
  return typeof value === 'string' && value ? value : NO_ABNT_ITEM_LABEL;
}

function abntFilterToken(values) {
  const items = (Array.isArray(values) ? values : []).filter(value => typeof value === 'string' && value);
  return items.length > 0 ? items.join(' ') : NO_ABNT_ITEM;
}

function pageLabel(model, pageId) {
  const index = model.pages.findIndex(page => page.pageId === pageId);
  return index >= 0 ? `Página ${index + 1}` : 'Página do escopo avaliado';
}

function untestedLimitationLabel(model, value) {
  let key;
  try { key = JSON.parse(value); } catch { return 'Verificação não testada em página do escopo avaliado.'; }
  if (!Array.isArray(key) || key.length !== 3 || key.some(part => typeof part !== 'string')) {
    return 'Verificação não testada em página do escopo avaliado.';
  }
  const [pageId, engine, ruleId] = key;
  const rule = model.ruleResults.find(candidate => candidate.source?.engine === engine && candidate.ruleId === ruleId);
  const item = NBR17225_ITEMS.find(candidate => rule?.nbrItems.includes(candidate.id));
  return `Verificação não testada: ${item?.title ?? rule?.summary ?? 'verificação do escopo'} — ${pageLabel(model, pageId)}.`;
}

function countLabel(count, singular, plural) { return `${count} ${count === 1 ? singular : plural}`; }

// Índices por modelo, calculados uma vez. As buscas lineares por ocorrência (ocorrência por id, regra por
// ocorrência, alvo por regra) eram quadráticas: com ~22 mil ocorrências o relatório levava minutos para
// abrir (bateria de páginas hostis, 1.1.53). O resultado é o mesmo: primeira regra e primeiro alvo, na ordem.
const MODEL_INDEXES = new WeakMap();
function modelIndexes(model) {
  let indexes = MODEL_INDEXES.get(model);
  if (indexes) return indexes;
  const occurrenceById = new Map();
  for (const row of model.occurrences) if (!occurrenceById.has(row.occurrenceId)) occurrenceById.set(row.occurrenceId, row);
  const coreRuleById = new Map();
  for (const candidate of model.ruleResults) {
    if (candidate.source?.engine === 'audita-core' && !coreRuleById.has(candidate.ruleId)) coreRuleById.set(candidate.ruleId, candidate);
  }
  indexes = { occurrenceById, coreRuleById, targetMessages: new Map() };
  if (Object.isFrozen(model)) MODEL_INDEXES.set(model, indexes);
  return indexes;
}

function remediationForOccurrence(model, occurrence, indexes = modelIndexes(model)) {
  const rule = indexes.coreRuleById.get(occurrence.source.ruleId);
  if (!rule) return null;
  let messages = indexes.targetMessages.get(rule);
  if (!messages) {
    messages = new Map();
    for (const candidate of rule.targets ?? []) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate) || typeof candidate.message !== 'string') continue;
      const node = candidate.nodeId === 'document' ? null : String(candidate.nodeId);
      if (!messages.has(node)) messages.set(node, candidate.message);
    }
    indexes.targetMessages.set(rule, messages);
  }
  const occurrenceNode = occurrence.nodeId === null ? null : String(occurrence.nodeId);
  return messages.get(occurrenceNode) ?? null;
}

function plainImpact(group) {
  if (group === 'failed') {
    return 'Esta barreira pode dificultar ou impedir a tarefa para pessoas que dependem deste requisito de acessibilidade.';
  }
  if (group === 'humanReview') {
    return 'Esta verificação depende de análise humana; ainda não há conclusão sobre o atendimento do requisito.';
  }
  if (group === 'alerts') {
    return 'Este alerta merece análise porque pode indicar uma barreira ou uma prática que precisa de correção.';
  }
  return 'Este resultado positivo se limita ao escopo automático que foi efetivamente observado.';
}

function plainCorrection(group, remediation) {
  return typeof remediation === 'string' && remediation ? remediation : FALLBACK_CORRECTIONS[group];
}

function correctionPresentation(group) {
  if (group === 'passed') {
    return {
      title: 'Orientação e manutenção',
      confirmation: 'Confirmação: mantenha este registro como evidência positiva do escopo observado e reavalie se a página mudar.',
    };
  }
  if (group === 'humanReview') {
    return {
      title: 'Como revisar e concluir',
      confirmation: 'Confirmação: registre a decisão humana, a justificativa e as evidências consideradas.',
    };
  }
  if (group === 'alerts') {
    return {
      title: 'Como analisar e tratar',
      confirmation: 'Confirmação: registre se a análise confirmou uma barreira e repita a auditoria somente após eventual correção.',
    };
  }
  return { title: 'Como corrigir e confirmar', confirmation: 'Confirmação: repita a verificação após a correção.' };
}

export function collectFilterOptions(model, summary) {
  const cards = GROUPS.flatMap(group => summary.groups[group].map(card => ({ ...card, result: group })));
  const wcagCounts = new Map(WCAG_LEVEL_ORDER.map(level => [level, 0]));
  for (const card of cards) {
    for (const level of wcagLevelsFor(card.wcag)) wcagCounts.set(level, wcagCounts.get(level) + 1);
  }
  return freeze({
    impact: copyRows(summary.distributions.impact),
    wcag: WCAG_LEVEL_ORDER.map(id => ({ id, count: wcagCounts.get(id) })),
    result: GROUPS.map(id => ({ id, count: summary.groups[id].length })),
    classification: countOptions(cards, card => [card.classification]),
    page: countOptions(cards, card => [card.pageId]),
    engine: countOptions(cards, card => [card.engine]),
    abnt: countOptions(cards, card => card.abntItemIds.length > 0 ? card.abntItemIds : [NO_ABNT_ITEM]),
  });
}

/**
 * Cláusulas em linguagem simples do título de limitações, para leigos não precisarem ler o código
 * em maiúsculas. A decisão vem do **código do diagnóstico**, nunca da forma exata da frase: a lista
 * pode guardar a forma codificada ou a simples (`listedLimitations`) e a cláusula não pode
 * desaparecer por causa disso. Uma única derivação serve a aba e o relatório entregue — o Minor 5 da
 * revisão da 1.1.20 foi corrigido só na aba e não chegava ao PDF justamente por haver duas lógicas.
 */
export function projectLimitationClauses(model, technicalEvidence) {
  // Só `session.diagnostics`, que é a mesma fonte de `projectExecutive.limitations`: ler também
  // `pages[].diagnostics` permitia uma cláusula na manchete sem entrada correspondente na lista
  // (achado N1 da revisão da 1.1.22). Nos caminhos do produto as duas fontes já são unificadas.
  const codes = new Set();
  for (const entry of model.session?.diagnostics ?? []) if (entry?.code) codes.add(entry.code);
  const clauses = [];
  if (codes.has('PIXEL_CAPTURE_OMITTED')) clauses.push('Modo sem imagens: nenhuma captura raster.');
  else if (codes.has('FULL_PAGE_CAPTURE_OMITTED') &&
    !technicalEvidence.some(evidence => evidence.kind === 'full-page') &&
    technicalEvidence.some(evidence => evidence.kind === 'element')) {
    clauses.push(technicalEvidence.some(evidence => evidence.kind === 'element' && isSafePngDataUrl(evidence.dataUrl))
      ? 'Captura integral omitida: miniaturas de elementos disponíveis.'
      : 'Captura integral omitida: evidências estruturais de elementos registradas, sem miniaturas PNG disponíveis.');
  }
  if (codes.has('DYNAMIC_PROBES_OMITTED_PASSIVE')) {
    clauses.push('Observação passiva: sem testes interativos de teclado, redimensionamento e movimento.');
  }
  return freeze(clauses);
}

export function projectExecutive(model, summary) {
  return freeze({
    identity: { ...summary.identity },
    scope: copyData(model.scope),
    status: model.session.status,
    coverage: copyData(summary.coverage),
    counts: copyData(summary.counts),
    pages: model.pages.map(page => ({
      pageId: page.pageId, status: page.status, attempted: page.attempted,
      finalUrl: page.finalUrl, finalUrlObserved: page.finalUrlObserved,
    })),
    limitations: [...new Set([
      ...model.limitations,
      ...model.session.diagnostics.map(diagnostic => `${diagnostic.code}: ${diagnostic.message}`),
      ...summary.limitations.codes,
      ...summary.limitations.notStartedPageIds.map(id => `Página não iniciada: ${id}.`),
      ...summary.limitations.untestedCheckKeys.map(id => untestedLimitationLabel(model, id)),
    ])],
  });
}

const OFFICIAL_ITEM_BY_ID = new Map(NBR17225_ITEMS.map(item => [item.id, item]));

function projectCard(card, group, model, decisionByOccurrence) {
  const officialItemById = OFFICIAL_ITEM_BY_ID;
  const indexes = modelIndexes(model);
  const occurrences = card.occurrenceIds.map(id => indexes.occurrenceById.get(id)).filter(Boolean)
    .map(occurrence => {
      const decision = decisionByOccurrence.get(occurrence.occurrenceId) ?? null;
      const legalReference = occurrence.classification === 'requirement' ? qualifiedConsumerReference({
        occurrence,
        item: officialItemById.get(occurrence.itemId),
        displayOutcome: card.displayOutcome,
        decision,
        normativeItems: NBR17225_ITEMS,
      }) : null;
      return {
        occurrenceId: occurrence.occurrenceId, itemId: occurrence.itemId, outcome: occurrence.outcome,
        classification: occurrence.classification, impact: occurrence.impact, justification: occurrence.justification,
        evidenceRefs: [...occurrence.evidenceRefs], source: copyData(occurrence.source),
        decision: decision ? copyData(decision) : null,
        legalReference: legalReference ? copyData(legalReference) : null,
        remediation: remediationForOccurrence(model, occurrence, indexes),
      };
    });
  const remediation = occurrences.find(occurrence => occurrence.remediation !== null)?.remediation ?? null;
  return freeze({
    checkKey: card.checkKey, pageId: card.pageId, engine: card.engine, ruleId: card.ruleId,
    title: card.title, originalOutcome: card.originalOutcome, displayOutcome: card.displayOutcome,
    classification: card.classification, impact: card.impact, wcag: [...card.wcag],
    abntItemIds: [...card.abntItemIds], context: card.context, occurrenceIds: [...card.occurrenceIds],
    accessibleName: card.accessibleName, announcement: card.announcement,
    remediation,
    plainLanguage: {
      impact: plainImpact(group),
      observed: [...new Set(occurrences.map(occurrence => occurrence.justification).filter(value => typeof value === 'string' && value))],
      correction: plainCorrection(group, remediation),
    },
    occurrences,
  });
}

export function projectIssues(model, summary) {
  const decisions = new Map(model.reviewDecisions.map(decision => [decision.occurrenceId, decision]));
  return freeze(Object.fromEntries(GROUPS.map(group => [
    group,
    summary.groups[group].map(card => projectCard(card, group, model, decisions))
      .sort((left, right) => left.checkKey.localeCompare(right.checkKey)),
  ])));
}

export function projectTechnicalEvidence(model) {
  return freeze(model.evidence.map(evidence => ({
    ...copyData(evidence), provenance: projectEvidenceProvenance(evidence, model.pages),
  })).sort((left, right) => left.evidenceId.localeCompare(right.evidenceId)));
}

export function projectReaderMaps(model) {
  return freeze(model.evidence.filter(evidence => evidence.kind === 'announcement-map')
    .map(copyData).sort((left, right) => left.evidenceId.localeCompare(right.evidenceId)));
}

export function projectKeyboardMaps(model) {
  return freeze(model.evidence.filter(evidence => evidence.kind === 'keyboard-map')
    .map(copyData).sort((left, right) => left.evidenceId.localeCompare(right.evidenceId)));
}

export function projectMethodology(model) {
  const environmentViewport = model.environment?.viewport ?? {};
  return freeze({
    methodology: copyData(model.methodology), versions: copyData(model.versions),
    normative: copyData(model.normative), integrity: copyData(model.integrity),
    viewport: freeze({
      width: Number.isFinite(environmentViewport.width) ? environmentViewport.width : null,
      height: Number.isFinite(environmentViewport.height) ? environmentViewport.height : null,
      deviceScaleFactor: Number.isFinite(environmentViewport.deviceScaleFactor) ? environmentViewport.deviceScaleFactor : null,
    }),
    caveats: [
      'A cobertura mede a execução automática; não é nota, certificação ou declaração de conformidade.',
      'As prévias de anúncio são estimativas e não transcrições literais de tecnologia assistiva.',
      'A análise automatizada não dispensa revisão humana, técnica ou jurídica.',
    ],
  });
}

export function projectExports(model) {
  return freeze({
    availability: model.report.status === 'pending' ? 'available' : model.report.status,
    formats: [...EXPORT_FORMATS_V1],
    limitations: Array.isArray(model.report.artifact?.limitations) ? [...model.report.artifact.limitations] : [],
  });
}

export function projectMatrix(model) {
  return freeze(model.itemResults.map(item => ({
    id: item.id, printedId: item.printedId, title: item.title, classification: item.classification,
    wcag: item.wcag.map(reference => ({ id: reference.id, level: reference.level })),
    evaluation: item.evaluation, ruleIds: [...item.ruleIds], humanReason: item.humanReason,
    outcome: item.outcome,
  })).sort((left, right) => compareItemIds(left.id, right.id)));
}

export function buildReportView({ model: inputModel, summary: inputSummary, modelRevision, modelHash } = {}) {
  try {
    const model = createAuditModel(inputModel);
    const summary = validateSummary(inputSummary, model.auditId);
    if (!Number.isSafeInteger(modelRevision) || modelRevision < 1 ||
      typeof modelHash !== 'string' || !/^[a-f0-9]{64}$/u.test(modelHash) ||
      modelHash !== model.integrity.canonicalModelHash || summary.identity.status !== model.session.status ||
      summary.identity.finalUrl !== model.finalUrl || summary.identity.completedAt !== model.timestamps.endedAt) denied();
    const technicalEvidence = projectTechnicalEvidence(model);
    return freeze({
      version: 1, auditId: model.auditId, modelRevision, modelHash,
      filters: collectFilterOptions(model, summary),
      executive: freeze({ ...projectExecutive(model, summary), limitationClauses: projectLimitationClauses(model, technicalEvidence) }),
      issues: projectIssues(model, summary),
      checklist: (summary.checklist ?? []).map(card => projectCard(card, 'humanReview', model,
        new Map(model.reviewDecisions.map(row => [row.occurrenceId, row])))),
      technicalEvidence,
      readerMaps: projectReaderMaps(model),
      keyboardMaps: projectKeyboardMaps(model),
      methodology: projectMethodology(model),
      exports: projectExports(model),
      matrix: projectMatrix(model),
      reviewHistory: projectReviewHistory(model),
      tabReading: projectTabReading(model),
      findingsBoard: buildFindingsBoard(model),
    });
  } catch (error) {
    if (error instanceof TypeError && error.message === 'REPORT_VIEW_DENIED') throw error;
    denied();
  }
}

function element(document, tag, text, className) {
  const node = document.createElement(tag);
  if (className) node.setAttribute('class', className);
  if (text !== undefined) node.textContent = text;
  return node;
}

function appendTextList(document, parent, values, emptyText) {
  const list = document.createElement('ul');
  if (values.length === 0) list.append(element(document, 'li', emptyText));
  else for (const value of values) list.append(element(document, 'li', value));
  parent.append(list);
}

/** Lista numerada do mapa do teclado: o número repete o da caixa na imagem. */
function keyboardEntryList(document, entries, kind, describe) {
  const list = element(document, 'ol', undefined, `keyboard-map-${kind}s`);
  for (const entry of entries) {
    const item = element(document, 'li');
    item.setAttribute('value', entry.number);
    item.setAttribute(`data-keyboard-map-${kind}`, entry.number);
    item.append(element(document, 'bdi', describe(entry)), element(document, 'p', entry.location));
    list.append(item);
  }
  return list;
}

/** Trecho do mapa até 1.2.0: só a imagem com os números, sem legenda ao lado. */
function simpleMapFigure(document, segment) {
  const figure = element(document, 'figure', undefined, 'announcement-map-segment');
  figure.setAttribute('data-map-segment', segment.id);
  figure.append(mapSegmentImage(document, segment));
  figure.append(element(document, 'figcaption', segment.caption));
  return figure;
}

/**
 * Trecho do mapa de leitura: imagem com as caixas à esquerda e, na mesma linha, só os códigos daquele
 * trecho com o texto que um leitor de tela falaria. Em tela estreita a legenda desce para baixo da imagem.
 */
function readerMapColumns(document, segment) {
  const figure = element(document, 'figure', undefined, 'announcement-map-segment reader-map-segment');
  figure.setAttribute('data-map-segment', segment.id);
  const columns = element(document, 'div', undefined, 'reader-map-columns');
  const image = element(document, 'div', undefined, 'reader-map-image');
  image.append(mapSegmentImage(document, segment));
  columns.append(image, readerMapEntries(document, segment.entries));
  figure.append(columns, element(document, 'figcaption', segment.caption));
  return figure;
}

function mapSegmentImage(document, segment) {
  if (!segment.dataUrl) {
    return element(document, 'p', 'PNG do segmento indisponível. A legenda e a proveniência foram preservadas.');
  }
  const image = element(document, 'img', undefined, 'evidence-media');
  image.setAttribute('data-map-segment-image', '');
  image.setAttribute('src', segment.dataUrl);
  image.setAttribute('alt', segment.caption);
  image.setAttribute('width', segment.width);
  image.setAttribute('height', segment.height);
  return image;
}

function readerMapEntries(document, entries) {
  if (!entries.length) return element(document, 'p', 'Nenhum código neste trecho.', 'reader-map-empty');
  const list = element(document, 'ol', undefined, 'reader-map-segment-legend');
  for (const entry of entries) {
    const item = element(document, 'li');
    item.setAttribute('value', entry.number);
    item.setAttribute('data-map-marker', entry.number);
    // O espaço depois do código vai dentro do próprio rótulo: assim o texto lido em voz alta mantém a
    // separação entre "L1" e o anúncio, sem depender de um nó de texto solto.
    item.append(element(document, 'span', `${entry.code} `, 'reader-map-code'), element(document, 'bdi', entry.preview));
    list.append(item);
  }
  return list;
}

function section(document, index) {
  const node = document.createElement('section');
  node.setAttribute('data-report-section', String(index + 1));
  node.setAttribute('aria-labelledby', `report-section-${index + 1}`);
  const heading = element(document, 'h2', SECTION_TITLES[index]);
  heading.setAttribute('id', `report-section-${index + 1}`);
  node.append(heading);
  return node;
}

function sectionNavigation(document) {
  const navigation = document.createElement('nav');
  navigation.setAttribute('class', 'section-nav');
  navigation.setAttribute('aria-label', 'Seções do relatório');
  navigation.setAttribute('data-report-navigation', '');
  navigation.append(element(document, 'strong', 'Ir para'));
  const list = document.createElement('ul');
  for (const [index, title] of SECTION_NAV_LABELS.entries()) {
    const item = document.createElement('li');
    const link = element(document, 'a', title);
    link.setAttribute('href', `#report-section-${index + 1}`);
    item.append(link); list.append(item);
  }
  navigation.append(list);
  return navigation;
}

function isSafePngDataUrl(value) { return typeof value === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/u.test(value); }

function evidenceFrame(artifact) {
  const cached = EVIDENCE_FRAME_BY_ARTIFACT.get(artifact);
  if (cached !== undefined) return cached;
  const frame = evidenceHighlight(artifact);
  EVIDENCE_FRAME_BY_ARTIFACT.set(artifact, frame);
  return frame;
}

/**
 * Fixa a caixa da miniatura em CSS px quando a captura é em escala maior que 1.
 *
 * Sem os atributos, o navegador usa o tamanho do próprio PNG e uma miniatura capturada em 2× apareceria
 * com o dobro do tamanho — diferente do relatório estático, que declara a mesma caixa. Em 1× nada muda:
 * os atributos ficam de fora e a imagem se dimensiona como sempre se dimensionou.
 */
function applyDeclaredCaptureSize(image, artifact) {
  if (evidencePixelScale(artifact) <= 1) return image;
  const declared = evidenceCaptureSize(artifact);
  if (!declared) return image;
  image.setAttribute('width', String(declared.width));
  image.setAttribute('height', String(declared.height));
  return image;
}

/**
 * Aceita o tom (`failed`, `review`, `advisory`, `passed`) ou um tratamento já resolvido — a ficha de
 * evidência tem tratamento próprio (`EVIDENCE_FICHE_TREATMENT_V1`), porque descreve o registro e não um
 * veredito. A imagem guardada entra inteira no SVG e o `viewBox` recorta: nenhum pixel novo é gerado.
 */
function appendEvidenceMedia(document, figure, artifact, toneOrTreatment) {
  const label = `${evidenceKindLabel(artifact.kind)} local da evidência ${artifact.evidenceId}`;
  const treatment = artifact.kind === 'element'
    ? (typeof toneOrTreatment === 'string' ? EVIDENCE_TREATMENTS_V1[toneOrTreatment] ?? null : toneOrTreatment ?? null)
    : null;
  const frame = treatment ? evidenceFrame(artifact) : null;
  if (!treatment || !frame) {
    const image = document.createElement('img');
    image.setAttribute('src', artifact.dataUrl);
    image.setAttribute('alt', label);
    image.setAttribute('class', 'evidence-media');
    applyDeclaredCaptureSize(image, artifact);
    figure.append(image);
    return `${label}.`;
  }
  const svg = document.createElementNS(SVG_NAMESPACE, 'svg');
  svg.setAttribute('class', 'evidence-media evidence-media--marked');
  svg.setAttribute('data-evidence-treatment', treatment.tone);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `${label} ${treatment.aria}${frame.clipped ? ` ${EVIDENCE_HIGHLIGHT_CLIPPED_LEGEND}` : ''}`);
  svg.setAttribute('viewBox', `0 0 ${frame.width} ${frame.height}`);
  svg.setAttribute('width', frame.width);
  svg.setAttribute('height', frame.height);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.setAttribute('focusable', 'false');
  const image = document.createElementNS(SVG_NAMESPACE, 'image');
  image.setAttribute('href', artifact.dataUrl);
  image.setAttribute('width', frame.width);
  image.setAttribute('height', frame.height);
  image.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.append(image);
  for (const shape of evidenceHighlightShapes(frame, treatment.tone)) {
    const node = document.createElementNS(SVG_NAMESPACE, shape.kind);
    for (const [name, value] of Object.entries(shape.attributes)) node.setAttribute(name, value);
    svg.append(node);
  }
  figure.append(svg);
  return `${evidenceHighlightLegend(treatment, frame)} ${label}.`;
}

// A ficha de evidência responde a pergunta "onde eu confiro a imagem de que este relatório fala?".
function captureInstantLabel(evidence) {
  const received = evidence?.metadata?.captureReceivedAt;
  if (typeof received === 'string' && received) {
    return `${received} (instante em que a extensão recebeu a captura; relógio local, não certificado)`;
  }
  return 'instante individual não registrado nesta auditoria; o período observado da página está logo abaixo.';
}

/**
 * Bytes exatos do PNG guardado, para o botão de download. A decodificação é a canônica
 * (`decodePngDataUrl` rejeita base64 não canônico), então o arquivo salvo tem o SHA-256 mostrado na ficha
 * — é isso que permite a qualquer pessoa conferir com uma ferramenta comum. Devolve `null` quando não há
 * PNG confiável a baixar.
 */
export function evidenceDownloadTarget(evidence) {
  if (!isSafePngDataUrl(evidence?.dataUrl) || typeof evidence?.evidenceId !== 'string' || !evidence.evidenceId) return null;
  try {
    return { fileName: `${evidence.evidenceId}.png`, bytes: decodePngDataUrl(evidence.dataUrl).bytes };
  } catch {
    return null;
  }
}

function downloadEvidencePng(document, evidence) {
  const target = evidenceDownloadTarget(evidence);
  const urlApi = typeof URL === 'undefined' ? null : URL;
  if (!target || typeof Blob !== 'function' || typeof urlApi?.createObjectURL !== 'function' ||
    typeof document?.createElement !== 'function') return false;
  const url = urlApi.createObjectURL(new Blob([target.bytes], { type: 'image/png' }));
  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', target.fileName);
  link.setAttribute('rel', 'noopener');
  document.body?.append?.(link);
  link.click?.();
  link.remove?.();
  // O endereço temporário é liberado depois que o navegador já leu o arquivo; revogar no mesmo instante
  // cancelava o download em parte dos casos.
  if (typeof setTimeout === 'function') setTimeout(() => urlApi.revokeObjectURL?.(url), 30_000);
  else urlApi.revokeObjectURL?.(url);
  return true;
}

/**
 * Registro das imagens que os recortes compartilham.
 *
 * Desde a 1.1.62 as fichas de elementos sem miniatura própria mostram o recorte da captura integral. A
 * captura integral já aparece inteira na ficha dela e no mapa; sem um registro compartilhado, o mesmo PNG
 * de página inteira seria copiado no atributo de cada recorte — numa auditoria com centenas de elementos
 * isso multiplicaria megabytes de base64 na memória da aba e no arquivo entregue. Cada imagem entra uma
 * vez, com um `id`, e cada recorte a referencia por `<use>`.
 */
function createCropDefinitions(document) {
  const svg = document.createElementNS(SVG_NAMESPACE, 'svg');
  svg.setAttribute('class', 'evidence-definitions');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('width', '0');
  svg.setAttribute('height', '0');
  svg.setAttribute('focusable', 'false');
  const defs = document.createElementNS(SVG_NAMESPACE, 'defs');
  svg.append(defs);
  const byKey = new Map();
  let count = 0;
  return {
    node: svg,
    count: () => count,
    reference(dataUrl, size) {
      const key = `${size.width}x${size.height}\u0000${dataUrl}`;
      if (byKey.has(key)) return byKey.get(key);
      const image = document.createElementNS(SVG_NAMESPACE, 'image');
      const id = `report-crop-image-${count += 1}`;
      image.setAttribute('id', id);
      image.setAttribute('href', dataUrl);
      image.setAttribute('width', String(size.width));
      image.setAttribute('height', String(size.height));
      image.setAttribute('preserveAspectRatio', 'xMidYMid meet');
      defs.append(image);
      byKey.set(key, id);
      return id;
    },
  };
}

/**
 * Desenha o recorte da captura integral com as mesmas peças do resto do produto (`evidenceMediaParts`):
 * a janela do recorte é o `viewBox`, o contorno é o do tratamento escolhido e os pixels vêm da imagem
 * compartilhada, por `<use>`. Devolve a legenda do que foi desenhado e `null` quando não há como
 * desenhar — quem chama segue para o texto que diz que não há imagem.
 *
 * A mesma peça serve à prévia de ocorrência (que recebe o tratamento do grupo) e à ficha (que recebe o
 * tratamento próprio dela): o desenho é o mesmo, muda a moldura em volta.
 */
function appendIntegralCropSvg(document, parent, crop, definitions, treatment = EVIDENCE_FICHE_TREATMENT_V1,
  accessibleName = null) {
  const parts = evidenceMediaParts(crop.artifact, treatment, crop.view);
  if (!parts) return null;
  const svg = document.createElementNS(SVG_NAMESPACE, 'svg');
  svg.setAttribute('class', 'evidence-media evidence-media--marked');
  svg.setAttribute('data-evidence-treatment', treatment.tone);
  svg.setAttribute('data-evidence-crop-source', crop.sourceEvidenceId);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `${treatment.aria} ${parts.legend}${accessibleName ? ` ${accessibleName}` : ''}`);
  svg.setAttribute('viewBox', `${parts.view.x} ${parts.view.y} ${parts.view.width} ${parts.view.height}`);
  svg.setAttribute('width', String(parts.display.width));
  svg.setAttribute('height', String(parts.display.height));
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.setAttribute('focusable', 'false');
  const use = document.createElementNS(SVG_NAMESPACE, 'use');
  use.setAttribute('href', `#${definitions.reference(crop.artifact.dataUrl, parts.image)}`);
  use.setAttribute('width', String(parts.image.width));
  use.setAttribute('height', String(parts.image.height));
  svg.append(use);
  for (const shape of parts.shapes) {
    const node = document.createElementNS(SVG_NAMESPACE, shape.kind);
    for (const [name, value] of Object.entries(shape.attributes)) node.setAttribute(name, String(value));
    svg.append(node);
  }
  parent.append(svg);
  return parts.legend;
}

/** O recorte como figura solta — a moldura da ficha. Devolve `false` quando não há como desenhar. */
function appendEvidenceCrop(document, card, crop, definitions) {
  const figure = document.createElement('figure');
  figure.setAttribute('class', 'evidence-fiche-media');
  const legend = appendIntegralCropSvg(document, figure, crop, definitions);
  if (legend === null) return false;
  figure.append(element(document, 'figcaption', `${legend} ${EVIDENCE_CROP_REGION_LEGEND}`));
  card.append(figure);
  return true;
}

/**
 * Recortes da captura integral, por `evidenceId`, para cada elemento sem miniatura própria.
 *
 * Calculado uma vez por relatório: a MESMA posição serve à prévia de ocorrência e à ficha, e o mesmo
 * `<use>` serve aos dois desenhos — nenhuma conta refeita e nenhum byte de PNG repetido. Auditorias
 * anteriores à 1.1.62 (sem posição gravada) devolvem um mapa vazio, e tudo segue pelo caminho antigo.
 */
function buildIntegralCrops(evidence = []) {
  const byEvidenceId = new Map();
  for (const artifact of evidence) {
    if (artifact?.kind !== 'element' || typeof artifact.evidenceId !== 'string') continue;
    if (isSafePngDataUrl(artifact.dataUrl)) continue;
    const crop = integralCropSource({ evidence, elementEvidence: artifact, targetImageSize: null });
    if (crop) byEvidenceId.set(artifact.evidenceId, crop);
  }
  return byEvidenceId;
}

function appendEvidenceFicheImage(document, card, evidence, cropContext = null) {
  const hasPixels = isSafePngDataUrl(evidence.dataUrl);
  const highlight = evidence.kind === 'element' && hasPixels ? evidenceFrame(evidence) : null;
  if (!hasPixels) {
    // Sem miniatura própria, a ficha mostra o recorte da captura integral quando a auditoria guardou a
    // posição do elemento (1.1.62). O texto que diz "não disponível" passa a ser o último recurso.
    const crop = cropContext?.crops?.get(evidence.evidenceId) ?? null;
    if (crop && appendEvidenceCrop(document, card, crop, cropContext.definitions)) {
      const anchor = cropContext.anchorById?.get(crop.sourceEvidenceId);
      const note = element(document, 'p', `Este elemento não tem arquivo de imagem próprio: a imagem acima é um recorte da captura integral ${crop.sourceEvidenceId}`, 'evidence-fiche-crop-note');
      if (anchor) {
        note.append(document.createTextNode('. '));
        const link = document.createElement('a');
        link.setAttribute('href', `#${anchor}`);
        link.textContent = 'Consultar a ficha dessa captura, com o arquivo e o SHA-256 dele';
        note.append(link, document.createTextNode('.'));
      } else {
        note.append(document.createTextNode('.'));
      }
      card.append(note);
      return;
    }
    card.append(element(document, 'p', 'Imagem segura: PNG local não disponível nesta auditoria.', 'evidence-fiche-missing'));
    return;
  }
  const figure = document.createElement('figure');
  figure.setAttribute('class', 'evidence-fiche-media');
  const caption = appendEvidenceMedia(document, figure, evidence, highlight ? EVIDENCE_FICHE_TREATMENT_V1 : null);
  const captionText = highlight
    ? `${caption} ${EVIDENCE_FICHE_TREATMENT_V1.binaryLegend}`
    : evidence.kind === 'element'
      ? `${caption} A localização exata do elemento não foi registrada, então não há contorno a desenhar; a imagem acima é a captura original.`
      : `${caption} Captura integral do estado observado; ela dá contexto e não indica que cada pixel represente uma desconformidade.`;
  figure.append(element(document, 'figcaption', captionText));
  card.append(figure);
}

/**
 * Ficha de uma evidência: imagem, ID, os dois SHA-256 inteiros, data/hora e o download do arquivo.
 *
 * `cropContext` traz a lista de evidências (para achar a captura integral de onde sai o recorte de um
 * elemento sem miniatura), o registro das imagens compartilhadas e os `id` das fichas, para o recorte
 * apontar para a ficha da captura que o contém.
 */
function appendEvidenceFiche(document, card, evidence, anchorNumber, cropContext = null) {
  card.setAttribute('data-report-evidence', evidence.evidenceId);
  card.setAttribute('data-evidence-fiche', '');
  card.setAttribute('data-evidence-kind', evidence.kind);
  card.append(element(document, 'h4', `Evidência ${anchorNumber} — ${evidence.evidenceId} (${evidenceKindLabel(evidence.kind)})`));
  appendEvidenceFicheImage(document, card, evidence, cropContext);
  const facts = document.createElement('dl');
  facts.setAttribute('class', 'evidence-fiche-facts');
  for (const [label, value, note] of [
    ['ID da evidência', evidence.evidenceId, null],
    ...evidenceHashRows(evidence, cropContext?.evidence ?? null),
    ['Data e hora da captura', captureInstantLabel(evidence), null],
  ]) {
    facts.append(element(document, 'dt', label));
    const cell = document.createElement('dd');
    const code = element(document, 'code', value);
    cell.append(code);
    if (note) cell.append(element(document, 'span', ` ${note}`, 'evidence-fiche-note'));
    facts.append(cell);
  }
  card.append(facts);
  if (evidenceDownloadTarget(evidence)) {
    const button = element(document, 'button', 'Baixar imagem (PNG)');
    button.setAttribute('type', 'button');
    button.setAttribute('data-evidence-download', evidence.evidenceId);
    button.addEventListener('click', () => {
      if (!downloadEvidencePng(document, evidence)) button.disabled = true;
    });
    card.append(button);
    card.append(element(document, 'p', `O arquivo é gravado como ${evidence.evidenceId}.png, com os bytes originais: o SHA-256 dele tem de ser igual ao do arquivo de imagem acima.`, 'evidence-fiche-download-note'));
  }
  card.append(
    element(document, 'p', `Proveniência: página ${evidence.pageId}; tipo ${evidence.kind}; estado ${evidence.state ?? 'não registrado'}.`),
    ...evidenceProvenanceRows(evidence).map(([label, value]) => element(document, 'p', `${label}: ${value}`)),
    element(document, 'p', `Seletor: ${evidence.selector?.css ?? 'não registrado.'}`),
    element(document, 'p', `Snippet: ${evidence.snippet ?? 'não disponível.'}`),
  );
}

function escapeForRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * Cada ID de evidência citado no texto vira link para a ficha daquela evidência. O texto do parágrafo
 * não muda: só ganha âncoras, nos mesmos limites de palavra em que o ID já aparecia. Sem isto, quem lê a
 * constatação e quer ver a imagem precisa procurar o ID na lista de anexos de olho.
 */
export function linkEvidenceIds(document, paragraph, evidenceAnchorById) {
  const text = paragraph?.textContent;
  if (!text || !evidenceAnchorById?.size || typeof document?.createDocumentFragment !== 'function') return false;
  const ids = [...evidenceAnchorById.keys()].filter(id => typeof id === 'string' && id).sort((left, right) => right.length - left.length);
  if (!ids.length) return false;
  const pattern = new RegExp(`(${ids.map(escapeForRegExp).join('|')})`, 'gu');
  const parts = text.split(pattern);
  if (parts.length === 1) return false;
  const fragment = document.createDocumentFragment();
  for (const part of parts) {
    const anchor = evidenceAnchorById.get(part);
    if (!anchor || !ids.includes(part)) {
      fragment.append(document.createTextNode(part));
      continue;
    }
    const link = element(document, 'a', part);
    link.setAttribute('href', `#${anchor}`);
    link.setAttribute('data-report-consult-evidence', '');
    link.setAttribute('aria-label', `Ver a ficha da evidência ${part}`);
    fragment.append(link);
  }
  paragraph.replaceChildren?.(fragment);
  return true;
}

function plainBlock(document, name, title) {
  const block = document.createElement('section');
  block.setAttribute('class', 'issue-plain-block');
  block.setAttribute('data-report-plain-block', name);
  block.append(element(document, 'h4', title));
  return block;
}

// Páginas muito grandes (marketplaces, catálogos) produzem dezenas de milhares de ocorrências. A tela de
// relatório mostra por verificação até este número de detalhes técnicos e controles de destaque; o conjunto
// completo permanece no modelo e nas exportações JSON-LD/EARL e CSV.
export const REPORT_VIEW_ISSUE_DETAIL_LIMIT = 100;

const EVIDENCE_ORDER = new WeakMap();
function evidenceOrder(evidenceById) {
  let order = EVIDENCE_ORDER.get(evidenceById);
  if (!order || order.size !== evidenceById.size) {
    order = new Map();
    let index = 0;
    for (const key of evidenceById.keys()) order.set(key, index++);
    EVIDENCE_ORDER.set(evidenceById, order);
  }
  return order;
}

function correlatedEvidence(issue, evidenceById) {
  const evidenceIds = new Set(issue.occurrences.flatMap(occurrence => occurrence.evidenceRefs));
  const order = evidenceOrder(evidenceById);
  return [...evidenceIds].filter(id => evidenceById.has(id))
    .sort((left, right) => order.get(left) - order.get(right))
    .map(id => evidenceById.get(id));
}

function appendOmittedNote(document, parent, omitted, singular, plural) {
  if (omitted <= 0) return;
  const note = element(document, 'p', `Mais ${countLabel(omitted, singular, plural)} desta verificação não ${omitted === 1 ? 'é exibida' : 'são exibidas'} aqui para manter o relatório utilizável; o conjunto completo está nas exportações JSON-LD/EARL e CSV.`);
  note.setAttribute('data-report-omitted', String(omitted));
  parent.append(note);
}

function appendTechnicalDetails(document, article, issue, evidence) {
  const details = document.createElement('details');
  details.setAttribute('data-report-technical', '');
  details.append(
    element(document, 'summary', 'Ver detalhes técnicos'),
    element(document, 'p', `Resultado original: ${outcomeLabel(issue.originalOutcome)}. Resultado consolidado: ${outcomeLabel(issue.displayOutcome)}.`),
    element(document, 'p', `Contexto técnico: ${issue.context ?? 'não registrado'}. Página: ${issue.pageId}.`),
    element(document, 'p', `Orientação original registrada: ${issue.plainLanguage.correction}`),
  );
  for (const occurrence of issue.occurrences.slice(0, REPORT_VIEW_ISSUE_DETAIL_LIMIT)) {
    const block = document.createElement('section');
    block.setAttribute('data-report-occurrence-technical', occurrence.occurrenceId);
    block.append(
      element(document, 'h4', `ID da ocorrência: ${occurrence.occurrenceId}`),
      element(document, 'p', `Proveniência: Página ${issue.pageId}; Motor ${occurrence.source.engine}; Regra ${occurrence.source.ruleId}; Versão ${occurrence.source.version}.`),
      element(document, 'p', `Item ABNT: ${abntItemLabel(occurrence.itemId)}. Classificação: ${classificationLabel(occurrence.classification)}.`),
    );
    details.append(block);
  }
  appendOmittedNote(document, details, issue.occurrences.length - REPORT_VIEW_ISSUE_DETAIL_LIMIT, 'ocorrência', 'ocorrências');
  for (const item of evidence.slice(0, REPORT_VIEW_ISSUE_DETAIL_LIMIT)) {
    const block = document.createElement('section');
    block.setAttribute('data-report-occurrence-evidence', item.evidenceId);
    block.append(
      element(document, 'h4', `ID da evidência: ${item.evidenceId} — ${evidenceKindLabel(item.kind)}`),
      element(document, 'p', `Proveniência: página ${item.pageId}; tipo ${item.kind}; estado ${item.state ?? 'não registrado'}.`),
      ...evidenceProvenanceRows(item).map(([label, value]) => element(document, 'p', `${label}: ${value}`)),
      element(document, 'p', `Seletor: ${item.selector?.css ?? 'não registrado.'}`),
      element(document, 'p', `Snippet: ${item.snippet ?? 'não disponível.'}`),
      element(document, 'p', `Hash: ${item.hash ?? 'não disponível.'}`),
    );
    details.append(block);
  }
  appendOmittedNote(document, details, evidence.length - REPORT_VIEW_ISSUE_DETAIL_LIMIT, 'evidência', 'evidências');
  article.append(details);
}

/**
 * Recortes das áreas marcadas na revisão guiada. Os atributos vêm de `marksCropParts`, os mesmos que o
 * HTML exportado usa: a imagem guardada entra inteira e o `viewBox` recorta, com o contorno vermelho
 * por cima. Nenhum pixel novo é gerado e nada depende de `style` embutido.
 */
function appendMarksCrops(document, parent, record) {
  if (!record?.crops?.length) return;
  const container = element(document, 'div', undefined, 'marks-crops');
  container.setAttribute('data-review-marks', '');
  for (const crop of record.crops) {
    const parts = marksCropParts(crop);
    const figure = document.createElement('figure');
    const svg = document.createElementNS(SVG_NAMESPACE, 'svg');
    for (const [name, value] of Object.entries(parts.svg)) svg.setAttribute(name, String(value));
    const image = document.createElementNS(SVG_NAMESPACE, 'image');
    for (const [name, value] of Object.entries(parts.image)) image.setAttribute(name, String(value));
    const area = document.createElementNS(SVG_NAMESPACE, 'rect');
    for (const [name, value] of Object.entries(parts.rect)) area.setAttribute(name, String(value));
    svg.append(image, area);
    figure.append(svg, element(document, 'figcaption', crop.caption));
    container.append(figure);
  }
  parent.append(container);
}

function appendHumanHistory(document, parent, entries, evidenceAnchorById) {
  if (!entries.length) {
    const empty = element(document, 'p', HUMAN_REVIEW_EMPTY);
    empty.setAttribute('data-review-history-empty', ''); parent.append(empty); return;
  }
  const history = document.createElement('details'); history.setAttribute('data-review-history', '');
  history.append(element(document, 'summary', `Conclusões humanas registradas (${entries.length})`),
    element(document, 'p', HUMAN_REVIEW_DESCRIPTION));
  const list = document.createElement('ol');
  for (const entry of entries) {
    const card = document.createElement('li'); card.setAttribute('data-review-record', entry.occurrenceId);
    card.setAttribute('data-review-answer', entry.answer);
    card.append(element(document, 'h3', humanReviewHeading(entry)));
    const metadata = document.createElement('dl');
    for (const [label, value] of humanReviewMetadata(entry)) {
      metadata.append(element(document, 'dt', label), element(document, 'dd', value));
    }
    card.append(metadata);
    appendMarksCrops(document, card, entry.marksRecord);
    const links = entry.evidenceRefs.map(id => evidenceAnchorById.get(id)).filter(Boolean);
    if (!links.length) card.append(element(document, 'p', 'Nenhuma evidência correlata foi registrada para esta ocorrência.'));
    for (const [index, anchor] of links.entries()) {
      const link = element(document, 'a', `Consultar evidência ${index + 1}`);
      link.setAttribute('href', `#${anchor}`); link.setAttribute('data-report-consult-evidence', '');
      card.append(link);
    }
    list.append(card);
  }
  history.append(list); parent.append(history);
}

/**
 * Prévia de um elemento sem miniatura própria: o recorte da captura integral, com o mesmo contorno e a
 * mesma legenda da ficha, e uma frase que diz de qual captura a imagem veio.
 *
 * A frase é a da ficha e a do HTML entregue: quem lê a prévia sabe que a imagem não é um arquivo próprio
 * do elemento e sabe onde conferir o arquivo e o SHA-256 de onde ela saiu.
 */
function appendIntegralCropPreview(document, figure, artifact, crop, cropContext, tone) {
  const accessibleName = `${evidenceKindLabel(artifact.kind)} local da evidência ${artifact.evidenceId}`;
  const treatment = (typeof tone === 'string' ? EVIDENCE_TREATMENTS_V1[tone] : null) ?? EVIDENCE_FICHE_TREATMENT_V1;
  const legend = appendIntegralCropSvg(document, figure, crop, cropContext.definitions, treatment, accessibleName);
  if (legend === null) {
    // Sem como desenhar (posição fora da imagem guardada, por exemplo): o texto assume o lugar da imagem.
    figure.append(element(document, 'p', `${accessibleName}. Captura sem imagens locais nesta auditoria.`));
    return '';
  }
  return `${legend} ${EVIDENCE_CROP_REGION_LEGEND} A imagem original é a captura integral ${crop.sourceEvidenceId}.`;
}

function appendEvidencePreview(document, article, evidence, evidenceAnchorById, issue, highlightOptions = null,
  evidenceOnlyMessage = GENERIC_EVIDENCE_ONLY_MESSAGE, cropContext = null) {
  const preview = document.createElement('section');
  preview.setAttribute('data-report-evidence-preview', '');
  preview.append(element(document, 'h4', 'Capturas registradas'));
  const crops = cropContext?.crops ?? null;
  // O elemento sem miniatura própria entra pela mesma porta da miniatura: o que ele tem é o recorte da
  // captura integral, e a verificação não pode ficar sem imagem por causa disso. É a mesma decisão que o
  // HTML entregue toma — a tela e o arquivo mostram as mesmas capturas.
  const selected = projectOccurrenceEvidencePreviews({
    evidence: evidence.filter(item => isSafePngDataUrl(item.dataUrl) ||
      (item.kind === 'element' && crops?.has(item.evidenceId) === true)),
    occurrences: issue.occurrences,
  });
  if (selected.length === 0) {
    preview.append(element(document, 'p', 'Nenhuma captura PNG local está disponível para esta verificação.'));
  } else {
    for (const { artifact: item, tone } of selected) {
      const figure = document.createElement('figure');
      figure.setAttribute('data-evidence-kind', item.kind);
      const crop = crops?.get(item.evidenceId) ?? null;
      const caption = crop
        ? appendIntegralCropPreview(document, figure, item, crop, cropContext, tone)
        : appendEvidenceMedia(document, figure, item, tone);
      figure.append(element(document, 'figcaption', caption));
      preview.append(figure);
    }
  }
  article.append(preview);
  if (highlightOptions?.enabled === true && typeof highlightOptions.onIntent === 'function' &&
    Array.isArray(highlightOptions.occurrenceIds) && highlightOptions.occurrenceIds.length > 0) {
    const total = highlightOptions.occurrenceIds.length;
    for (const [index, occurrenceId] of highlightOptions.occurrenceIds.slice(0, REPORT_VIEW_ISSUE_DETAIL_LIMIT).entries()) {
      const context = `${highlightOptions.issueTitle}, página ${highlightOptions.pageId}, ocorrência ${index + 1} de ${total}`;
      const control = document.createElement('div');
      control.setAttribute('data-report-live-action', 'worker-approved');
      control.setAttribute('data-report-highlight-control', occurrenceId);
      control.setAttribute('data-report-highlight-context', context);
      const button = element(document, 'button', 'Verificar possibilidade de destaque');
      button.setAttribute('type', 'button');
      button.setAttribute('data-highlight-action', 'check');
      button.setAttribute('aria-label', `Verificar possibilidade de destaque — ${context}`);
      button.addEventListener('click', () => {
        if (button.disabled === true || button.getAttribute('aria-disabled') === 'true') return;
        const action = button.getAttribute('data-highlight-action');
        if (action === 'highlight') highlightOptions.onIntent(freeze({ type: 'HIGHLIGHT_OCCURRENCE', occurrenceId }));
        else if (action === 'clear') highlightOptions.onIntent(freeze({ type: 'CLEAR_HIGHLIGHT' }));
        else if (action === 'check') highlightOptions.onIntent(freeze({ type: 'GET_HIGHLIGHT_AVAILABILITY', occurrenceId }));
      });
      control.append(button);
      article.append(control);
    }
    appendOmittedNote(document, article, total - REPORT_VIEW_ISSUE_DETAIL_LIMIT, 'ocorrência destacável', 'ocorrências destacáveis');
  } else {
    const fallback = element(document, 'p', evidenceOnlyMessage);
    fallback.setAttribute('data-report-live-action', 'evidence-only');
    article.append(fallback);
  }
  const firstAnchor = evidence.map(item => evidenceAnchorById.get(item.evidenceId)).find(Boolean);
  if (firstAnchor) {
    const link = element(document, 'a', 'Consultar evidências registradas');
    link.setAttribute('data-report-consult-evidence', '');
    link.setAttribute('href', `#${firstAnchor}`);
    article.append(link);
  } else {
    article.append(element(document, 'p', 'Nenhuma evidência correlata foi registrada para esta verificação.'));
  }
}

function itemCheckPresentation(issue, itemId) {
  const occurrences = issue.occurrences.filter(occurrence => itemId === NO_ABNT_ITEM ? !occurrence.itemId : occurrence.itemId === itemId);
  const outcomes = occurrences.map(occurrence => occurrence.outcome === 'failed' || occurrence.decision?.answer === 'não conforme' ? 'failed'
    : occurrence.decision?.answer === 'conforme' ? 'passed'
      : occurrence.decision?.answer === 'não se aplica' ? 'inapplicable'
        : occurrence.decision?.answer === 'não foi possível determinar' ? 'cantTell' : occurrence.outcome);
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
      abntItemIds: itemId === NO_ABNT_ITEM ? [] : [itemId], displayOutcome: outcome, originalOutcome, classification },
    guidance: accessibilityGuidance({ itemId, title: issue.title, outcome,
    observed: [...new Set(occurrences.map(occurrence => occurrence.justification).filter(Boolean))].join(' ') }) };
}

function issueArticle(document, issue, group, evidenceById, evidenceAnchorById, highlightOptions = null,
  evidenceOnlyMessage = GENERIC_EVIDENCE_ONLY_MESSAGE, presentation, cropContext = null) {
  group = presentation.result;
  issue = presentation.issue;
  const article = document.createElement('article');
  article.setAttribute('data-report-issue', '');
  article.setAttribute('data-result', group);
  article.setAttribute('data-classification', issue.classification);
  article.setAttribute('data-page', issue.pageId);
  article.setAttribute('data-engine', issue.engine);
  article.setAttribute('data-impact', issue.impact ?? 'none');
  article.setAttribute('data-wcag', wcagLevelsFor(issue.wcag).join(' '));
  article.setAttribute('data-abnt', abntFilterToken(issue.abntItemIds));
  const heading = document.createElement('header');
  heading.setAttribute('data-report-issue-heading', '');
  heading.append(
    element(document, 'h3', issue.title),
    element(document, 'p', `Resultado neste item: ${outcomeLabel(presentation.outcome)}.`),
    element(document, 'p', `Classificação: ${presentation.classifications.map(classificationLabel).join(', ')}. ${impactText(issue.impact, presentation.outcome === 'cantTell', { positive: presentation.outcome === 'passed' }) ?? 'Impacto não aplicável'}.`),
  );
  const content = document.createElement('details');
  content.setAttribute('data-report-issue-details', '');
  content.append(element(document, 'summary', 'Entender o resultado, revisar e consultar evidências'));
  article.append(heading, content);
  const { guidance } = presentation;
  const impact = plainBlock(document, 'impact', 'Impacto para a pessoa usuária');
  impact.append(element(document, 'p', guidance.impact)); content.append(impact);
  const observed = plainBlock(document, 'observed', 'O que foi observado');
  observed.append(element(document, 'p', guidance.observed));
  const evidence = correlatedEvidence(issue, evidenceById);
  for (const row of recordedLabelComparisons(issue.abntItemIds[0], evidence)) {
    const comparison = element(document, 'p', row.text);
    comparison.setAttribute('data-report-label-comparison', row.evidenceId);
    observed.append(comparison);
  }
  content.append(observed);
  const correctionCopy = correctionPresentation(group);
  const correction = plainBlock(document, 'correction', correctionCopy.title);
  correction.append(
    element(document, 'p', `Correção: ${guidance.correction}`),
    element(document, 'p', correctionCopy.confirmation),
  );
  appendTextList(document, correction, guidance.reviewSteps);
  correction.append(element(document, 'p', guidance.example));
  content.append(correction);
  const announcement = plainBlock(document, 'announcement', 'Nome acessível e anúncio estimado');
  announcement.append(
    element(document, 'p', `Nome acessível: ${issue.accessibleName ?? 'não disponível'}.`),
    element(document, 'p', `Anúncio estimado: ${issue.announcement ?? 'indisponível'}.`),
    element(document, 'p', 'Esta prévia não é transcrição literal de tecnologia assistiva e pode variar conforme o leitor e as preferências.'),
  );
  content.append(announcement);
  const normative = plainBlock(document, 'normative', 'Fundamentação normativa');
  normative.append(element(document, 'p', `WCAG 2.2: ${issue.wcag.join(', ') || 'sem referência'}. ABNT NBR 17225: ${abntItemsLabel(issue.abntItemIds)}.`));
  content.append(normative);
  appendEvidencePreview(document, content, evidence, evidenceAnchorById, issue,
    highlightOptions && ['failed', 'humanReview'].includes(group)
      ? {
        ...highlightOptions, occurrenceIds: issue.occurrences.map(value => value.occurrenceId),
        issueTitle: issue.title, pageId: issue.pageId,
      }
      : null, evidenceOnlyMessage, cropContext);
  appendTechnicalDetails(document, content, issue, evidence);
  return article;
}

function renderFilters(document, view, root, status) {
  const wrapper = document.createElement('div');
  wrapper.setAttribute('class', 'report-filters');
  // `aria-label` só vale em elemento com PAPEL que aceite nome acessível: em `div` genérico o atributo é
  // PROIBIDO, e o axe 4.13.0 reprova — medido na aba do relatório do próprio produto (rodada 83).
  wrapper.setAttribute('role', 'group');
  wrapper.setAttribute('aria-label', 'Filtros do relatório vivo');
  const active = new Map();
  const visibleCheckIds = new Set();
  const total = GROUPS.reduce((count, group) => count + view.issues[group].length, 0);
  status.textContent = `${countLabel(total, 'verificação', 'verificações')} visíveis. Os filtros não alteram os arquivos exportados.`;
  const apply = () => {
    visibleCheckIds.clear();
    for (const issue of root.querySelectorAll('[data-report-issue]')) {
      let match = true;
      for (const [dimension, value] of active) {
        const values = (issue.getAttribute(`data-${dimension}`) ?? '').split(' ');
        if (!values.includes(value)) { match = false; break; }
      }
      issue.hidden = !match;
      if (match) visibleCheckIds.add(issue.getAttribute('data-report-check-key'));
    }
    for (const group of root.querySelectorAll('[data-report-item-group]')) {
      group.hidden = ![...group.querySelectorAll('[data-report-issue]')].some(node => !node.hidden);
    }
    status.textContent = `${countLabel(visibleCheckIds.size, 'verificação', 'verificações')} visíveis. Os filtros não alteram os arquivos exportados.`;
    for (const card of root.querySelectorAll('[data-report-metric]')) {
      card.setAttribute('aria-pressed', String(active.get('result') === card.getAttribute('data-report-metric')));
    }
  };
  for (const card of root.querySelectorAll('[data-report-metric]')) {
    card.addEventListener('click', () => {
      const value = card.getAttribute('data-report-metric');
      if (active.get('result') === value) active.delete('result');
      else active.set('result', value);
      for (const peer of wrapper.querySelectorAll('[data-report-filter="result"]')) {
        peer.setAttribute('aria-pressed', String(active.get('result') === peer.getAttribute('data-filter-value')));
      }
      apply();
    });
  }
  for (const dimension of FILTERS.filter(value => value !== 'abnt')) {
    const group = document.createElement('div');
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', FILTER_PRESENTATION[dimension].aria);
    const visibleLabel = element(document, 'strong', FILTER_PRESENTATION[dimension].visible, 'report-filter-label');
    visibleLabel.setAttribute('data-report-filter-label', '');
    group.append(visibleLabel);
    let options = view.filters[dimension];
    if (['classification', 'result'].includes(dimension)) {
      const counts = new Map();
      for (const issue of GROUPS.flatMap(group => view.issues[group])) {
        for (const itemId of new Set(issue.abntItemIds.length ? issue.abntItemIds : [NO_ABNT_ITEM])) {
          const presentation = itemCheckPresentation(issue, itemId);
          const value = dimension === 'result' ? presentation.result : presentation.issue.classification;
          if (!counts.has(value)) counts.set(value, new Set());
          counts.get(value).add(issue.checkKey);
        }
      }
      options = [...new Set([...options.map(option => option.id), ...counts.keys()])].map(id => ({ id, count: counts.get(id)?.size ?? 0 }));
    }
    for (const option of options) {
      const translated = dimension === 'impact' ? impactLabel(option.id)
        : dimension === 'result' ? labelFor(option.id, GROUP_LABELS)
          : dimension === 'classification' ? classificationLabel(option.id)
            : dimension === 'page' ? `Página ${option.id}`
              : dimension === 'engine' ? `Origem ${option.id}`
                : dimension === 'wcag' ? `Nível ${option.id}`
                  : option.id === NO_ABNT_ITEM ? NO_ABNT_ITEM_LABEL : option.id;
      const button = element(document, 'button', `${translated} (${option.count})`);
      button.setAttribute('type', 'button');
      button.setAttribute('data-report-filter', dimension);
      button.setAttribute('data-filter-value', option.id);
      button.setAttribute('aria-pressed', 'false');
      button.addEventListener('click', event => {
        const control = event.currentTarget;
        const selected = control.getAttribute('aria-pressed') !== 'true';
        for (const peer of group.querySelectorAll('button[data-report-filter]')) peer.setAttribute('aria-pressed', 'false');
        if (selected) { active.set(dimension, option.id); control.setAttribute('aria-pressed', 'true'); }
        else active.delete(dimension);
        apply();
      });
      group.append(button);
    }
    wrapper.append(group);
  }
  const clear = element(document, 'button', 'Limpar filtros');
  clear.setAttribute('type', 'button'); clear.setAttribute('data-report-clear-filters', '');
  clear.addEventListener('click', () => {
    active.clear();
    for (const control of wrapper.querySelectorAll('[data-report-filter]')) control.setAttribute('aria-pressed', 'false');
    apply();
  });
  wrapper.append(clear, status);
  return wrapper;
}

function installPrintPresentation(document, root) {
  const window = document.defaultView;
  if (typeof window?.addEventListener !== 'function' || typeof window?.removeEventListener !== 'function') return;
  PRINT_LISTENERS_BY_WINDOW.get(window)?.();
  let prior = null;
  const before = () => {
    if (prior) return;
    const details = [...root.querySelectorAll('details')];
    const rows = [...root.querySelectorAll('[data-report-issue]'), ...root.querySelectorAll('[data-report-item-group]')];
    prior = { details: details.map(node => [node, node.getAttribute('open') !== null]), rows: rows.map(node => [node, node.hidden]) };
    for (const detail of details) detail.setAttribute('open', '');
    for (const row of rows) row.hidden = false;
  };
  const after = () => {
    if (!prior) return;
    for (const [node, open] of prior.details) {
      if (open) node.setAttribute('open', ''); else node.removeAttribute('open');
    }
    for (const [node, hidden] of prior.rows) node.hidden = hidden;
    prior = null;
  };
  window.addEventListener('beforeprint', before);
  window.addEventListener('afterprint', after);
  const summaryButton = root.querySelector('[data-report-print-summary]');
  const printStatus = root.querySelector('[data-report-print-status]');
  summaryButton?.addEventListener('click', () => {
    if (prior) return;
    const previousLayout = root.getAttribute('data-print-layout');
    const previousTitle = document.title;
    try {
      before();
      root.setAttribute('data-print-layout', 'summary');
      document.title = 'Resumo executivo — Audita Acessibilidade';
      window.print();
    } catch {
      if (printStatus) printStatus.textContent = 'Não foi possível abrir a impressão. Use a exportação completa ou tente novamente.';
    } finally {
      after();
      document.title = previousTitle;
      if (previousLayout === null) root.removeAttribute('data-print-layout');
      else root.setAttribute('data-print-layout', previousLayout);
    }
  });
  PRINT_LISTENERS_BY_WINDOW.set(window, () => {
    window.removeEventListener('beforeprint', before);
    window.removeEventListener('afterprint', after);
  });
}

function findingsCallToAction(document, board) {
  const box = document.createElement('aside');
  box.setAttribute('class', 'findings-cta');
  box.setAttribute('data-findings-cta', '');
  box.append(element(document, 'h3', 'Situação dos requisitos obrigatórios'));
  box.append(element(document, 'p', scoreboardSentence(board.scoreboard)));
  const links = document.createElement('p');
  const toBoard = element(document, 'a', 'Ver o quadro de constatações');
  toBoard.setAttribute('href', '#report-section-3');
  const toReview = element(document, 'a', board.scoreboard.pending > 0
    ? `Fazer a revisão guiada (${board.scoreboard.pending} ${board.scoreboard.pending === 1 ? 'requisito' : 'requisitos'} sem conclusão)`
    : 'Abrir a revisão guiada');
  toReview.setAttribute('href', '#report-section-4');
  links.append(toBoard, element(document, 'span', ' · '), toReview);
  box.append(links);
  return box;
}

function copyText(text, button) {
  const done = () => { button.textContent = 'Texto copiado'; };
  try {
    const clipboard = globalThis.navigator?.clipboard;
    if (clipboard && typeof clipboard.writeText === 'function') {
      clipboard.writeText(text).then(done, () => { button.textContent = 'Selecione o texto e copie'; });
      return;
    }
  } catch { /* cai na orientação manual */ }
  button.textContent = 'Selecione o texto e copie';
}

/**
 * Miniatura da constatação: a captura do elemento que o relatório estático mostra, com o contorno por
 * fora do elemento, mais o caminho até a ficha — onde estão os dois hashes e o download do arquivo.
 *
 * Sem miniatura própria, o que existe é o recorte da captura integral (1.1.62): é ele que a constatação
 * mostra, em vez de dizer que não há imagem. Só quando não há nenhuma das duas coisas a frase diz o que
 * existe (a ficha, quando houver) em vez de mandar a pessoa procurar em outro lugar.
 */
function appendFindingEvidence(document, row, finding, evidenceById, evidenceAnchorById, cropContext = null) {
  const elementId = finding.elementEvidenceId;
  const artifact = elementId ? evidenceById.get(elementId) : null;
  const figure = document.createElement('figure');
  figure.setAttribute('class', 'findings-evidence');
  const hasPixels = Boolean(artifact) && isSafePngDataUrl(artifact.dataUrl);
  const crop = elementId ? cropContext?.crops?.get(elementId) ?? null : null;
  if (!hasPixels && crop) {
    const accessibleName = `${evidenceKindLabel(artifact?.kind ?? 'element')} local da evidência ${elementId}`;
    const legend = appendIntegralCropSvg(document, figure, crop, cropContext.definitions,
      EVIDENCE_TREATMENTS_V1.failed, accessibleName);
    if (legend !== null) {
      figure.setAttribute('data-findings-evidence', elementId);
      figure.append(element(document, 'figcaption', `${legend} ${EVIDENCE_CROP_REGION_LEGEND}`));
      row.append(figure);
    } else {
      row.append(element(document, 'p', 'A imagem deste elemento não está nesta auditoria.', 'findings-evidence-missing'));
    }
  } else if (hasPixels) {
    figure.setAttribute('data-findings-evidence', elementId);
    figure.append(element(document, 'figcaption', appendEvidenceMedia(document, figure, artifact, 'failed')));
    row.append(figure);
  } else {
    row.append(element(document, 'p', 'A imagem deste elemento não está nesta auditoria.', 'findings-evidence-missing'));
  }
  const links = [];
  for (const evidenceId of finding.evidenceIds ?? []) {
    const anchor = evidenceAnchorById.get(evidenceId);
    if (!anchor) continue;
    const link = element(document, 'a', `Ver a ficha da evidência ${evidenceId}`);
    link.setAttribute('href', `#${anchor}`);
    link.setAttribute('data-report-consult-evidence', '');
    links.push(link);
  }
  if (links.length) {
    const list = document.createElement('ul');
    list.setAttribute('class', 'findings-evidence-links');
    for (const link of links) { const item = document.createElement('li'); item.append(link); list.append(item); }
    row.append(list);
  }
}

function appendFindingsBoard(document, parent, board, evidenceById = new Map(), evidenceAnchorById = new Map(),
  cropContext = null) {
  parent.append(element(document, 'p', FINDINGS_BOARD_INTRO));
  const score = document.createElement('dl');
  score.setAttribute('class', 'findings-score');
  score.setAttribute('data-findings-score', '');
  for (const [label, value, tone] of [
    ['Não atendidos', board.scoreboard.notMet, 'failed'],
    ['Atendidos', board.scoreboard.met, 'passed'],
    ['Não aplicáveis', board.scoreboard.notApplicable, 'inapplicable'],
    ['Sem conclusão', board.scoreboard.pending, 'pending'],
  ]) {
    const cell = document.createElement('div');
    cell.setAttribute('data-findings-tone', tone);
    cell.append(element(document, 'dt', label), element(document, 'dd', String(value)));
    score.append(cell);
  }
  parent.append(score);
  parent.append(element(document, 'p', `${scoreboardSentence(board.scoreboard)} ${FINDINGS_BOARD_LIMIT}`, 'findings-limit'));

  const notMet = document.createElement('section');
  notMet.setAttribute('data-findings-group', 'not-met');
  notMet.append(element(document, 'h3', `Requisitos não atendidos (${board.groups.notMet.length})`));
  if (!board.groups.notMet.length) notMet.append(element(document, 'p', 'Nenhum requisito foi dado como não atendido até agora. Isso não significa conformidade: veja os itens sem conclusão.'));
  for (const entry of board.groups.notMet) {
    const article = document.createElement('article');
    article.setAttribute('data-findings-item', entry.itemId);
    article.append(element(document, 'h4', `Item ${entry.itemId} — ${entry.title} (requisito)`));
    article.append(element(document, 'p', `Como foi concluído: ${entry.method}.`, 'findings-method'));
    const list = document.createElement('ol');
    // Um item com mais de uma constatação ganha UM texto para citação, que nomeia todos os elementos
    // da lista acima. Assim quem contesta não repete o mesmo item da norma em cada elemento. A lista
    // continua mostrando cada elemento com a sua própria constatação.
    const consolidated = entry.findings.length > 1
      ? consolidatedCitationParagraph({ item: { id: entry.itemId, title: entry.title }, findings: entry.findings })
      : null;
    for (const finding of entry.findings) {
      const row = document.createElement('li');
      row.setAttribute('data-findings-occurrence', finding.occurrenceId);
      if (finding.element) row.append(element(document, 'p', `Elemento: ${finding.element}`, 'findings-element'));
      row.append(element(document, 'p', finding.source === 'human'
        ? `Constatação (revisão humana de ${finding.evaluator}, ${finding.decidedAtLabel}): ${finding.text}`
        : `Constatação (verificação automática): ${finding.text}`));
      appendFindingEvidence(document, row, finding, evidenceById, evidenceAnchorById, cropContext);
      if (consolidated === null) {
        const citation = element(document, 'p', finding.citation, 'findings-citation');
        citation.setAttribute('data-findings-citation', '');
        linkEvidenceIds(document, citation, evidenceAnchorById);
        row.append(citation);
        const copy = element(document, 'button', 'Copiar texto para citação');
        copy.setAttribute('type', 'button');
        copy.setAttribute('data-findings-copy', '');
        copy.addEventListener('click', () => copyText(finding.citation, copy));
        row.append(copy);
      }
      list.append(row);
    }
    article.append(list);
    if (consolidated !== null) {
      const block = document.createElement('div');
      block.setAttribute('class', 'findings-item-citation');
      block.setAttribute('data-findings-citation-block', 'item');
      block.append(element(document, 'p', `Texto para citação (abrange os ${entry.findings.length} elementos acima)`, 'findings-citation-title'));
      const citation = element(document, 'p', consolidated, 'findings-citation');
      citation.setAttribute('data-findings-citation', '');
      citation.setAttribute('data-findings-citation-scope', 'item');
      linkEvidenceIds(document, citation, evidenceAnchorById);
      const copy = element(document, 'button', 'Copiar texto para citação');
      copy.setAttribute('type', 'button');
      copy.setAttribute('data-findings-copy', '');
      copy.addEventListener('click', () => copyText(consolidated, copy));
      block.append(citation, copy);
      article.append(block);
    }
    notMet.append(article);
  }
  parent.append(notMet);

  const met = document.createElement('section');
  met.setAttribute('data-findings-group', 'met');
  met.append(element(document, 'h3', `Requisitos atendidos no que foi observado (${board.groups.met.length})`));
  const metList = document.createElement('ul');
  for (const entry of board.groups.met) {
    metList.append(element(document, 'li', `Item ${entry.itemId} — ${entry.title}. Como foi concluído: ${entry.method}${
      entry.evaluators.length ? ` (${entry.evaluators.join(', ')}, ${entry.decidedAtLabel})` : ''}.`));
  }
  if (!board.groups.met.length) metList.append(element(document, 'li', 'Nenhum requisito foi dado como atendido até agora.'));
  met.append(metList);
  parent.append(met);

  const others = document.createElement('details');
  others.setAttribute('data-findings-group', 'others');
  others.append(element(document, 'summary', `Não aplicáveis (${board.groups.notApplicable.length}) e sem conclusão (${board.groups.pending.length})`));
  others.append(element(document, 'h4', 'Não aplicáveis'));
  const naList = document.createElement('ul');
  for (const entry of board.groups.notApplicable) naList.append(element(document, 'li', `Item ${entry.itemId} — ${entry.title}`));
  if (!board.groups.notApplicable.length) naList.append(element(document, 'li', 'Nenhum.'));
  others.append(naList);
  others.append(element(document, 'h4', 'Sem conclusão (dependem de revisão humana ou de condições não observadas)'));
  const pendingList = document.createElement('ul');
  for (const entry of board.groups.pending) pendingList.append(element(document, 'li', `Item ${entry.itemId} — ${entry.title}`));
  if (!board.groups.pending.length) pendingList.append(element(document, 'li', 'Nenhum.'));
  others.append(pendingList);
  parent.append(others);

  const recommendations = board.recommendations;
  parent.append(element(document, 'p', `Recomendações (contam só para a conformidade plena): ${recommendations.failed} não atendidas, ${recommendations.passed} atendidas, ${recommendations.inapplicable} não aplicáveis e ${recommendations.pending} sem conclusão. Os detalhes estão em “Resultados” e na matriz.`, 'findings-recommendations'));
  const legal = document.createElement('details');
  legal.setAttribute('data-findings-legal', '');
  legal.append(element(document, 'summary', 'Base consumerista padronizada (opcional, para quem analisa relações de consumo)'));
  legal.append(element(document, 'p', board.legalParagraph));
  parent.append(legal);
}

export function renderReportView({ view, document, onExport, onHighlightIntent = null } = {}) {
  if (!view || view.version !== 1 || !document || typeof document.createElement !== 'function' ||
    typeof onExport !== 'function' || ![null, 'function'].includes(onHighlightIntent === null ? null : typeof onHighlightIntent)) denied();
  const root = document.createElement('div');
  const evidenceOnlyMessage = onHighlightIntent === null && hasAttachedCopyReloadedLimitation(view.executive.limitations)
    ? ATTACHED_COPY_EVIDENCE_ONLY_MESSAGE
    : GENERIC_EVIDENCE_ONLY_MESSAGE;
  root.setAttribute('class', 'report-view');
  const identity = document.createElement('header');
  identity.setAttribute('class', 'report-identity');
  identity.append(
    element(document, 'p', 'Audita Acessibilidade — relatório técnico independente'),
    element(document, 'p', `Escopo avaliado: ${view.executive.identity.finalUrl}`),
  );
  root.append(identity);
  const summaryNote = element(document, 'p', 'Resumo executivo — não substitui o relatório completo. Fichas, capturas, anúncios, conclusões humanas detalhadas e evidências individuais estão no relatório completo da mesma auditoria e revisão.');
  summaryNote.setAttribute('data-report-summary-note', '');
  root.append(summaryNote);
  const live = element(document, 'p');
  live.setAttribute('class', 'report-filter-status');
  live.setAttribute('role', 'status'); live.setAttribute('aria-live', 'polite'); live.setAttribute('aria-atomic', 'true');

  const executive = section(document, 0);
  const outcome = element(document, 'p', `Estado da auditoria: ${statusLabel(view.executive.status)}.`, 'executive-outcome');
  outcome.setAttribute('data-report-outcome', '');
  executive.append(outcome);
  const coverageSummary = document.createElement('div');
  coverageSummary.setAttribute('class', 'executive-coverage');
  coverageSummary.setAttribute('data-report-coverage', '');
  coverageSummary.append(
    element(document, 'strong', view.executive.coverage.status === 'available'
      ? `Cobertura automática: ${view.executive.coverage.percent}.`
      : 'Cobertura automática: indisponível.'),
    element(document, 'span', ' Mede os testes do motor próprio com conclusão automática (passed, failed ou inapplicable), divididos pelo inventário desse motor nas páginas tentadas; não é nota, certificação ou declaração de conformidade.'),
  );
  executive.append(resultsOverviewElement(document, view), coverageSummary);
  const metrics = document.createElement('div');
  metrics.setAttribute('class', 'report-metrics');
  metrics.setAttribute('data-report-metrics', '');
  const metricTotal = Math.max(1, Object.values(view.executive.counts).reduce((total, count) => total + count.checkKeys, 0));
  for (const [group, label, count] of [
    ['failed', 'Não conformidades', view.executive.counts.errors],
    ['alerts', 'Recomendações e alertas', view.executive.counts.alerts],
    ['humanReview', 'Suspeitas a confirmar', view.executive.counts.humanReview],
    ['passed', 'Resultados positivos', view.executive.counts.positive],
  ]) {
    const card = document.createElement('button'); card.setAttribute('data-report-metric', group);
    card.setAttribute('type', 'button'); card.setAttribute('aria-pressed', 'false');
    card.append(
      element(document, 'strong', String(count.checkKeys), 'metric-value'),
      element(document, 'span', label, 'metric-label'),
      element(document, 'small', `${countLabel(count.checkKeys, 'verificação', 'verificações')} · ${countLabel(count.occurrences, 'ocorrência', 'ocorrências')}`, 'metric-detail'),
    );
    const meter = document.createElement('meter');
    meter.setAttribute('min', '0'); meter.setAttribute('max', String(metricTotal));
    meter.setAttribute('value', String(count.checkKeys)); meter.setAttribute('aria-hidden', 'true');
    card.append(meter);
    metrics.append(card);
  }
  executive.append(metrics);
  executive.append(findingsCallToAction(document, view.findingsBoard));
  executive.append(checklistElement(document, view.checklist, view.technicalEvidence));
  const limitations = document.createElement('details');
  limitations.setAttribute('data-report-limitations', '');
  const summaryClauses = [...(view.executive.limitationClauses ?? [])];
  const limitationSummary = summaryClauses.length === 0 ? null : summaryClauses.join(' · ');
  // The list carries the technical codes, and a limitation that is also a policy diagnostic is stated
  // in plain language by `deriveSystemLimitations` (text-policy.js) and again here with the code in
  // front. `listedLimitations` is shared with the delivered renderer so the two cannot diverge again:
  // the details keep the coded form, the plain duplicate goes, and the headline counts the list.
  const limitationsList = listedLimitations(view.executive.limitations);
  limitations.append(element(document, 'summary', `Limitações registradas (${limitationsList.length})${
    limitationSummary === null ? '' : ` · ${limitationSummary}`
  }`));
  appendTextList(document, limitations, limitationsList, 'Nenhuma limitação crítica registrada.');
  const actions = document.createElement('div');
  actions.setAttribute('class', 'executive-actions');
  actions.setAttribute('data-report-executive-actions', '');
  const exportButton = element(document, 'button', 'Exportar HTML, PDF, CSV e JSON');
  exportButton.setAttribute('type', 'button'); exportButton.setAttribute('data-report-export', '');
  const deletionChoice = document.createElement('label');
  deletionChoice.setAttribute('class', 'export-retention-choice');
  deletionChoice.setAttribute('for', 'delete-after-export');
  const deleteAfterExport = document.createElement('input');
  deleteAfterExport.setAttribute('type', 'checkbox');
  deleteAfterExport.setAttribute('id', 'delete-after-export');
  deleteAfterExport.setAttribute('data-report-delete-after-export', '');
  deleteAfterExport.checked = false;
  deletionChoice.append(deleteAfterExport, element(document, 'span',
    'Apagar os dados locais desta auditoria após baixar os quatro arquivos. Os downloads serão preservados.'));
  exportButton.addEventListener('click', () => onExport({ deleteAfterCompleteExport: deleteAfterExport.checked === true }));
  const summaryPrint = element(document, 'button', 'Imprimir resumo / salvar PDF');
  summaryPrint.setAttribute('type', 'button');
  summaryPrint.setAttribute('data-report-print-summary', '');
  const printStatus = element(document, 'p', 'Resumo: totais, limitações, matriz ABNT e metodologia, sem fichas, capturas e conclusões humanas detalhadas. No diálogo de impressão, escolha Salvar como PDF.');
  printStatus.setAttribute('data-report-print-status', '');
  printStatus.setAttribute('aria-live', 'polite');
  actions.append(exportButton, summaryPrint, printStatus, deletionChoice);
  executive.append(actions, limitations);
  root.append(executive);
  root.append(sectionNavigation(document));

  const coverage = section(document, 1);
  const evidenceById = new Map(view.technicalEvidence.map(evidence => [evidence.evidenceId, evidence]));
  const evidenceAnchorById = new Map(view.technicalEvidence.map((evidence, index) => [evidence.evidenceId, `report-evidence-${index + 1}`]));
  // Uma captura integral para muitos recortes: o registro das imagens fica no topo do relatório (e não
  // dentro do anexo, que abre fechado), para que as prévias de ocorrência e as fichas referenciem a mesma
  // imagem por `<use>` — nenhum PNG de página inteira copiado por elemento. O `id` das fichas entra aqui
  // para o recorte apontar para a captura que o contém.
  const cropDefinitions = createCropDefinitions(document);
  const cropContext = {
    evidence: view.technicalEvidence,
    crops: buildIntegralCrops(view.technicalEvidence),
    definitions: cropDefinitions,
    anchorById: evidenceAnchorById,
  };
  coverage.append(renderFilters(document, view, root, live));
  for (const group of GROUPS) {
    const groupNode = document.createElement('div');
    groupNode.setAttribute('data-report-group', group);
    groupNode.append(element(document, 'h3', `${GROUP_LABELS[group]}: ${view.issues[group].length}`));
    coverage.append(groupNode);
  }
  const itemGroups = new Map();
  let cardOrdinal = 0;
  for (const result of GROUPS) {
    for (const issue of view.issues[result]) {
      for (const itemId of new Set(issue.abntItemIds.length ? issue.abntItemIds : [NO_ABNT_ITEM])) {
        if (!itemGroups.has(itemId)) itemGroups.set(itemId, []);
        itemGroups.get(itemId).push({ issue, result });
      }
    }
  }
  for (const [itemId, checks] of itemGroups) {
    const item = document.createElement('details');
    item.setAttribute('data-report-item-group', itemId);
    const matchingOccurrences = checks.flatMap(({ issue }) => issue.occurrences).filter(occurrence => itemId === NO_ABNT_ITEM ? !occurrence.itemId : occurrence.itemId === itemId);
    const occurrences = new Set(matchingOccurrences.map(occurrence => occurrence.occurrenceId));
    item.append(element(document, 'summary', `${itemId === NO_ABNT_ITEM ? NO_ABNT_ITEM_LABEL : `Item ${itemId} da ABNT NBR 17225:2025`} · ${countLabel(checks.length, 'verificação', 'verificações')} · ${countLabel(occurrences.size, 'ocorrência', 'ocorrências')}`));
    if (itemId !== NO_ABNT_ITEM) {
      const failed = matchingOccurrences.some(occurrence => occurrence.legalReference);
      const pending = matchingOccurrences.some(occurrence => occurrence.decision ? occurrence.decision.answer === 'não foi possível determinar' : ['cantTell', 'untested'].includes(occurrence.outcome));
      if (failed || pending) {
        const reference = element(document, 'p', `${failed ? 'Inconformidade ao' : 'Verificar o'} item ${itemId} da ABNT NBR 17225:2025`);
        reference.setAttribute('data-report-item-reference', '');
        item.append(reference);
      }
    }
    for (const { issue, result } of checks) {
      const presentation = itemCheckPresentation(issue, itemId);
      const card = issueArticle(document, issue, result, evidenceById, evidenceAnchorById,
        onHighlightIntent ? { enabled: true, onIntent: onHighlightIntent } : null, evidenceOnlyMessage, presentation,
        cropContext);
      card.setAttribute('id', `report-check-${++cardOrdinal}`);
      card.setAttribute('data-report-check-key', issue.checkKey);
      item.append(card);
    }
    coverage.append(item);
  }
  root.append(coverage);

  const failed = section(document, 2);
  failed.setAttribute('data-findings-board', '');
  appendFindingsBoard(document, failed, view.findingsBoard, evidenceById, evidenceAnchorById, cropContext);
  root.append(failed);

  const review = section(document, 3);
  appendHumanHistory(document, review, view.reviewHistory ?? [], evidenceAnchorById);
  review.append(element(document, 'p', 'A revisão guiada reúne as suspeitas a confirmar e as perguntas do checklist separado, agrupadas pelo que você vê na página. Cada resposta é registrada com nome, data e hora e atualiza o quadro de constatações.'));
  const reviewForms = document.createElement('details');
  reviewForms.setAttribute('data-review-controls-target', '');
  reviewForms.open = true;
  reviewForms.append(element(document, 'summary', 'Revisão guiada: responder às perguntas'));
  review.append(reviewForms);
  root.append(review);

  const maps = section(document, 4);
  const readerMaps = readerMapPresentation(view.executive.pages, view.readerMaps);
  // O mapa atual vem com a explicação leiga logo abaixo do título da seção: repetir o mesmo título num
  // `h3` faria o relatório dizer duas vezes seguidas a mesma coisa. Até 1.2.0 o texto antigo nomeava o
  // mapa na própria frase e não tinha cabeçalho, e é assim que a auditoria guardada continua abrindo.
  if (readerMaps.some(map => map.format === 'reading-codes')) {
    maps.append(element(document, 'p', READER_MAP_INTRO));
  } else {
    maps.append(element(document, 'p', READER_MAP_LEGACY_INTRO));
  }
  for (const map of readerMaps) {
    const card = element(document, 'article', undefined, 'map-card');
    card.setAttribute('data-announcement-map-page', map.pageId);
    card.setAttribute('data-map-status', map.status);
    card.setAttribute('data-map-format', map.format);
    card.append(element(document, 'h3', map.title), element(document, 'p', map.summary, `map-state map-state--${map.status}`));
    if (map.coverage) card.append(element(document, 'p', map.coverage));
    if (map.limitations.length) appendTextList(document, card, map.limitations);
    for (const segment of map.segments) {
      card.append(map.format === 'reading-codes'
        ? readerMapColumns(document, segment)
        : simpleMapFigure(document, segment));
    }
    // Sem trecho de imagem a coluna da direita ainda faz sentido sozinha: é a lista de códigos que
    // existiria se a página não tivesse mudado de tamanho durante a verificação.
    if (map.format === 'reading-codes' && !map.segments.length && map.legend.length) {
      const columns = element(document, 'div', undefined, 'reader-map-columns');
      columns.append(readerMapEntries(document, map.legend));
      card.append(columns);
    }
    // Até 1.2.0 os números vivem dentro do PNG e a legenda completa vem no fim do cartão; a auditoria
    // guardada naquela versão continua abrindo com a apresentação com que foi gerada.
    if (map.format !== 'reading-codes' && map.legend.length) {
      card.append(element(document, 'h4', 'Legenda completa dos anúncios estimados'));
      const legend = element(document, 'ol', undefined, 'announcement-map-legend');
      for (const entry of map.legend) {
        const item = element(document, 'li');
        item.setAttribute('value', entry.number);
        item.setAttribute('data-map-marker', entry.number);
        item.append(element(document, 'bdi', entry.preview), element(document, 'p', entry.location));
        legend.append(item);
      }
      card.append(legend);
    }
    if (map.provenance.length) {
      const provenance = element(document, 'details');
      provenance.setAttribute('data-map-provenance', '');
      provenance.append(element(document, 'summary', 'Consultar origem, integridade e limites do mapa'));
      const metadata = element(document, 'dl', undefined, 'meta map-meta');
      for (const [label, value] of map.provenance) metadata.append(element(document, 'dt', label), element(document, 'dd', value));
      provenance.append(metadata);
      card.append(provenance);
    }
    maps.append(card);
  }
  root.append(maps);

  const keyboard = section(document, 5);
  keyboard.append(element(document, 'p', KEYBOARD_MAP_INTRO));
  keyboard.append(element(document, 'p', KEYBOARD_MAP_TAB_HELP));
  for (const map of keyboardMapPresentation(view.executive.pages, view.keyboardMaps ?? [])) {
    const card = element(document, 'article', undefined, 'map-card keyboard-map-card');
    card.setAttribute('data-keyboard-map-page', map.pageId);
    card.setAttribute('data-map-status', map.status);
    card.append(element(document, 'h3', map.title), element(document, 'p', map.summary, `map-state map-state--${map.status}`));
    if (map.counts) {
      card.append(element(document, 'p', keyboardMapCountsText(map.counts), 'keyboard-map-counts'));
    }
    if (map.coverage) card.append(element(document, 'p', map.coverage));
    if (map.limitations.length) appendTextList(document, card, map.limitations);
    for (const segment of map.segments) {
      const figure = element(document, 'figure', undefined, 'announcement-map-segment keyboard-map-segment');
      figure.setAttribute('data-keyboard-map-segment', segment.id);
      if (segment.dataUrl) {
        const image = element(document, 'img', undefined, 'evidence-media');
        image.setAttribute('data-map-segment-image', '');
        image.setAttribute('src', segment.dataUrl);
        image.setAttribute('alt', segment.caption);
        image.setAttribute('width', segment.width);
        image.setAttribute('height', segment.height);
        figure.append(image);
      } else figure.append(element(document, 'p', 'Imagem do mapa indisponível nesta auditoria. A lista numerada abaixo foi preservada.'));
      figure.append(element(document, 'figcaption', segment.caption));
      card.append(figure);
    }
    if (map.stops.length) {
      card.append(element(document, 'h4', 'Onde o Tab para, na ordem'));
      card.append(keyboardEntryList(document, map.stops, 'stop', entry => `${entry.name} — ${entry.kind}`));
    }
    if (map.suspects.length) {
      card.append(element(document, 'h4', 'Itens que parecem clicáveis e o Tab não alcança'));
      card.append(keyboardEntryList(document, map.suspects, 'suspect', entry => `${entry.name} — ${entry.reason}`));
    }
    if (map.provenance.length) {
      const provenance = element(document, 'details');
      provenance.setAttribute('data-keyboard-map-provenance', '');
      provenance.append(element(document, 'summary', 'Consultar origem, integridade e limites do mapa do teclado'));
      const metadata = element(document, 'dl', undefined, 'meta map-meta');
      for (const [label, value] of map.provenance) metadata.append(element(document, 'dt', label), element(document, 'dd', value));
      provenance.append(metadata);
      card.append(provenance);
    }
    keyboard.append(card);
  }
  root.append(keyboard);

  const matrix = section(document, 6);
  const table = document.createElement('table');
  const caption = element(document, 'caption', 'Matriz completa da ABNT NBR 17225'); table.append(caption);
  const head = document.createElement('thead'); const headRow = document.createElement('tr');
  for (const title of ['Item', 'Título', 'Classificação', 'Resultado', 'WCAG']) {
    const cell = element(document, 'th', title); cell.setAttribute('scope', 'col'); headRow.append(cell);
  }
  head.append(headRow); table.append(head);
  const body = document.createElement('tbody');
  for (const row of view.matrix) {
    const tr = document.createElement('tr');
    for (const [index, value] of [row.id, row.title, classificationLabel(row.classification), outcomeLabel(row.outcome), row.wcag.map(ref => `${ref.id} ${ref.level}`).join(', ')].entries()) {
      const cell = element(document, index === 0 ? 'th' : 'td', value);
      if (index === 0) cell.setAttribute('scope', 'row'); tr.append(cell);
    }
    body.append(tr);
  }
  table.append(body);
  const matrixScroll = document.createElement('div');
  matrixScroll.setAttribute('class', 'matrix-scroll'); matrixScroll.setAttribute('role', 'region');
  matrixScroll.setAttribute('aria-label', 'Matriz completa dos 146 itens ABNT'); matrixScroll.setAttribute('tabindex', '0');
  const matrixDetails = document.createElement('details'); matrixDetails.setAttribute('data-report-matrix', '');
  matrixDetails.append(element(document, 'summary', 'Consultar a matriz completa dos 146 itens'));
  matrixScroll.append(table); matrixDetails.append(matrixScroll); matrix.append(matrixDetails); root.append(matrix);

  const methodology = section(document, 7);
  methodology.append(element(document, 'p', `Versão da extensão que realizou a auditoria: ${view.methodology.versions.extension}.`));
  const methodFacts = [`Método: ${view.methodology.methodology.name}.`,
    `Regras próprias: ${view.methodology.methodology.coreRuleCount}.`,
    `Regras suplementares: ${view.methodology.methodology.supplementalRuleCount}.`,
    `Itens normativos: ${view.methodology.methodology.itemCount}.`];
  const observedViewport = viewportSummary(view.methodology.viewport);
  if (observedViewport !== null) methodFacts.push(`Viewport observado: ${observedViewport}.`);
  methodology.append(element(document, 'p', methodFacts.join(' ')));
  appendTextList(document, methodology, view.methodology.caveats, 'Sem ressalvas adicionais.');
  methodology.append(element(document, 'p', `Auditoria: ${view.auditId}. Revisão do modelo: ${view.modelRevision}. Integridade: ${view.modelHash}.`));
  const officialSources = document.createElement('div'); officialSources.setAttribute('data-official-sources', '');
  officialSources.append(element(document, 'h3', 'Fontes oficiais'));
  for (const source of CONSUMER_ACCESSIBILITY_FIXED_BASIS.sources) {
    const sourceText = element(document, 'p', `${source.publisher} — ${source.title} — ${source.url}`);
    sourceText.setAttribute('data-official-source', ''); officialSources.append(sourceText);
  }
  methodology.append(officialSources);
  const ledger = document.createElement('div'); ledger.setAttribute('data-normative-ledger', '');
  ledger.append(element(document, 'h3', 'Ledger normativo'));
  const ledgerList = document.createElement('ul');
  for (const source of view.methodology.normative.sources) {
    const locator = source.localCopy
      ? `arquivo ${source.localCopy.fileName}; SHA-256 ${source.localCopy.sha256}`
      : `URL ${source.url}`;
    ledgerList.append(element(document, 'li', `${source.title} — versão ${source.version}; identificador ${source.id}; ${locator}.`));
  }
  ledger.append(ledgerList); methodology.append(ledger);
  const notes = document.createElement('div'); notes.setAttribute('data-editorial-notes', '');
  notes.append(element(document, 'h3', 'Notas de integridade normativa'));
  notes.append(element(document, 'p', 'Informação impressa e normalização adotada permanecem separadas; o relatório não atribui à ABNT errata não localizada.'));
  const notesList = document.createElement('ul');
  for (const note of view.methodology.normative.editorialNotes) {
    notesList.append(element(document, 'li', `${note.itemId}: impresso “${note.printed}”; normalização “${note.normalized}”. ${note.rationale}`));
  }
  notes.append(notesList); methodology.append(notes);
  const sources = document.createElement('details'); sources.setAttribute('data-technical-evidence', '');
  sources.setAttribute('data-report-annex', '');
  sources.append(element(document, 'summary', `Consultar evidências técnicas e anexos (${view.technicalEvidence.length})`));
  sources.append(element(document, 'p', EVIDENCE_SHA256_HELP, 'evidence-fiche-help'));
  // As fichas usam o mesmo registro de imagens das prévias (criado no topo do relatório): as que não
  // desenham recorte nenhum não registram imagem, e o registro vazio não entra no documento.
  for (const [index, evidence] of view.technicalEvidence.entries()) {
    const card = document.createElement('article');
    card.setAttribute('data-evidence-kind', evidence.kind);
    card.setAttribute('id', evidenceAnchorById.get(evidence.evidenceId));
    appendEvidenceFiche(document, card, evidence, index + 1, cropContext);
    sources.append(card);
  }
  methodology.append(sources);
  root.append(methodology);
  if (cropDefinitions.count() > 0) root.append(cropDefinitions.node);
  for (const link of root.querySelectorAll('[data-report-consult-evidence]')) {
    link.addEventListener('click', event => {
      const id = link.getAttribute('href')?.slice(1);
      const target = [...sources.querySelectorAll('[data-report-evidence]')].find(card => card.getAttribute('id') === id);
      if (!target) return;
      event.preventDefault?.();
      sources.setAttribute('open', '');
      target.setAttribute('tabindex', '-1'); target.focus?.(); target.scrollIntoView?.({ block: 'start' });
    });
  }
  installPrintPresentation(document, root);
  return root;
}

export function updateReportHighlightAction({ root, occurrenceId, bindingStatus, activeOccurrenceId } = {}) {
  if (!root || typeof root.querySelectorAll !== 'function' || typeof occurrenceId !== 'string' ||
    !/^[A-Za-z0-9._:-]{1,200}$/u.test(occurrenceId)) return false;
  const controls = root.querySelectorAll('[data-report-highlight-control]');
  const control = [...controls].find(value => value.getAttribute('data-report-highlight-control') === occurrenceId);
  const button = control?.querySelector?.('button');
  if (!button) return false;
  const context = control.getAttribute('data-report-highlight-context') ?? 'ocorrência selecionada';
  try { button.removeAttribute('data-report-highlight'); } catch { /* absent attribute is already safe */ }
  if (activeOccurrenceId === occurrenceId) {
    button.disabled = false;
    button.removeAttribute('aria-disabled');
    button.textContent = 'Limpar destaque';
    button.setAttribute('data-highlight-action', 'clear');
    button.setAttribute('data-report-highlight', 'clear');
    button.setAttribute('aria-label', `Limpar destaque — ${context}`);
    return true;
  }
  if (bindingStatus?.state === 'available') {
    button.disabled = false;
    button.removeAttribute('aria-disabled');
    button.textContent = 'Ver e destacar na página';
    button.setAttribute('data-highlight-action', 'highlight');
    button.setAttribute('data-report-highlight', 'highlight');
    button.setAttribute('aria-label', `Ver e destacar na página — ${context}`);
    return true;
  }
  if (bindingStatus?.state === 'checking') {
    button.disabled = false;
    button.setAttribute('aria-disabled', 'true');
    button.textContent = 'Verificando possibilidade de destaque';
    button.setAttribute('data-highlight-action', 'check');
    button.setAttribute('aria-label', `Verificando possibilidade de destaque — ${context}`);
    return true;
  }
  button.disabled = false;
  button.setAttribute('aria-disabled', 'true');
  button.textContent = 'Destaque ao vivo indisponível; consulte as evidências';
  button.setAttribute('data-highlight-action', 'unavailable');
  button.setAttribute('aria-label', `Destaque ao vivo indisponível; consulte as evidências — ${context}`);
  return true;
}

export { SECTION_TITLES as REPORT_SECTION_TITLES_V1 };
