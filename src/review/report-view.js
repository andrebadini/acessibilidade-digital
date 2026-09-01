import { createAuditModel } from '../core/report/audit-model.js';
import { decodePngDataUrl } from '../core/evidence/png.js';
import { CONSUMER_ACCESSIBILITY_FIXED_BASIS, qualifiedConsumerReference } from '../core/legal/consumer-basis.js';
import { NBR17225_ITEMS } from '../core/normative/nbr17225.js';
import { WCAG22_LEVELS } from '../core/normative/wcag22.js';
import { EVIDENCE_TREATMENTS_V1, projectOccurrenceEvidencePreviews } from '../core/report/evidence-treatment.js';
import { EXPORT_FORMATS_V1 } from '../export/export-formats.js';

const GROUPS = Object.freeze(['failed', 'alerts', 'humanReview', 'passed']);
const GROUP_LABELS = Object.freeze({
  failed: 'Não conformidades', alerts: 'Alertas', humanReview: 'Revisões humanas pendentes', passed: 'Resultados positivos',
});
const OUTCOME_LABELS = Object.freeze({
  failed: 'Não atendido neste teste', passed: 'Atendido no escopo observado', cantTell: 'Requer revisão humana',
  inapplicable: 'Não aplicável', untested: 'Não testado',
});
const IMPACT_LABELS = Object.freeze({ critical: 'Crítico', serious: 'Alto', moderate: 'Moderado', minor: 'Menor' });
const CLASSIFICATION_LABELS = Object.freeze({
  failed: 'Não conformidade identificada', alerts: 'Alerta', 'manual-review': 'Revisão humana necessária', passed: 'Resultado positivo',
  requirement: 'Requisito ABNT', recommendation: 'Recomendação ABNT', 'best-practice': 'Boa prática suplementar', editorial: 'Alerta editorial',
});
const STATUS_LABELS = Object.freeze({ pending: 'Pendente', complete: 'Concluída', partial: 'Concluída com limitações', cancelled: 'Cancelada', failed: 'Falhou' });
const EVIDENCE_KIND_LABELS = Object.freeze({ 'full-page': 'Página completa', element: 'Elemento', 'announcement-map': 'Mapa de anúncios' });
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
  'Não conformidades priorizadas',
  'Revisões humanas pendentes',
  'Mapas de anúncios',
  'Matriz completa dos 146 itens',
  'Metodologia, fontes, integridade, evidências técnicas e anexos',
]);
const SECTION_NAV_LABELS = Object.freeze([
  'Sumário', 'Resultados', 'Não conformidades', 'Revisões humanas', 'Anúncios',
  'Matriz ABNT', 'Metodologia e evidências',
]);
const MAX_GRAPH_NODES = 200_000;
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const EVIDENCE_FRAME_BY_ARTIFACT = new WeakMap();
const FALLBACK_CORRECTIONS = Object.freeze({
  failed: 'Revise o elemento e aplique a orientação técnica antes de executar uma nova auditoria.',
  alerts: 'Revise o alerta no contexto da página e, se a barreira for confirmada, aplique a orientação técnica antes de repetir a auditoria.',
  humanReview: 'Realize a verificação humana indicada, registre as condições observadas e conclua se o requisito foi atendido, não atendido ou permaneceu inconclusivo.',
  passed: 'Nenhuma correção é indicada para este resultado positivo no escopo observado.',
});

function denied() { throw new TypeError('REPORT_VIEW_DENIED'); }

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
      if (!Number.isSafeInteger(length) || length < 0 || length > 100_000 || keys.length !== length + 1) denied();
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
  exact(summary, ['version', 'auditId', 'identity', 'coverage', 'counts', 'distributions', 'limitations', 'groups']);
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

function remediationForOccurrence(model, occurrence) {
  const rule = model.ruleResults.find(candidate => candidate.ruleId === occurrence.source.ruleId && candidate.source?.engine === 'audita-core');
  const occurrenceNode = occurrence.nodeId === null ? null : String(occurrence.nodeId);
  const target = rule?.targets?.find(candidate => candidate && typeof candidate === 'object' && !Array.isArray(candidate) &&
    typeof candidate.message === 'string' && (candidate.nodeId === 'document' ? null : String(candidate.nodeId)) === occurrenceNode);
  return target?.message ?? null;
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
    })).sort((left, right) => left.pageId.localeCompare(right.pageId)),
    limitations: [...new Set([
      ...model.limitations,
      ...model.session.diagnostics.map(diagnostic => `${diagnostic.code}: ${diagnostic.message}`),
      ...summary.limitations.codes,
      ...summary.limitations.notStartedPageIds.map(id => `Página não iniciada: ${id}.`),
      ...summary.limitations.untestedCheckKeys.map(id => untestedLimitationLabel(model, id)),
    ])],
  });
}

function projectCard(card, group, model, decisionByOccurrence) {
  const officialItemById = new Map(NBR17225_ITEMS.map(item => [item.id, item]));
  const occurrences = card.occurrenceIds.map(id => model.occurrences.find(row => row.occurrenceId === id)).filter(Boolean)
    .map(occurrence => {
      const decision = decisionByOccurrence.get(occurrence.occurrenceId) ?? null;
      const legalReference = qualifiedConsumerReference({
        occurrence,
        item: officialItemById.get(occurrence.itemId),
        displayOutcome: card.displayOutcome,
        decision,
        normativeItems: NBR17225_ITEMS,
      });
      return {
        occurrenceId: occurrence.occurrenceId, itemId: occurrence.itemId, outcome: occurrence.outcome,
        classification: occurrence.classification, impact: occurrence.impact, justification: occurrence.justification,
        evidenceRefs: [...occurrence.evidenceRefs], source: copyData(occurrence.source),
        decision: decision ? copyData(decision) : null,
        legalReference: legalReference ? copyData(legalReference) : null,
        remediation: remediationForOccurrence(model, occurrence),
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
  return freeze(model.evidence.map(copyData).sort((left, right) => left.evidenceId.localeCompare(right.evidenceId)));
}

export function projectReaderMaps(model) {
  return freeze(model.evidence.filter(evidence => evidence.kind === 'announcement-map')
    .map(copyData).sort((left, right) => left.evidenceId.localeCompare(right.evidenceId)));
}

export function projectMethodology(model) {
  return freeze({
    methodology: copyData(model.methodology), versions: copyData(model.versions),
    normative: copyData(model.normative), integrity: copyData(model.integrity),
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
  })).sort((left, right) => left.id.localeCompare(right.id)));
}

export function buildReportView({ model: inputModel, summary: inputSummary, modelRevision, modelHash } = {}) {
  try {
    const model = createAuditModel(inputModel);
    const summary = validateSummary(inputSummary, model.auditId);
    if (!Number.isSafeInteger(modelRevision) || modelRevision < 1 ||
      typeof modelHash !== 'string' || !/^[a-f0-9]{64}$/u.test(modelHash) ||
      modelHash !== model.integrity.canonicalModelHash || summary.identity.status !== model.session.status ||
      summary.identity.finalUrl !== model.finalUrl || summary.identity.completedAt !== model.timestamps.endedAt) denied();
    return freeze({
      version: 1, auditId: model.auditId, modelRevision, modelHash,
      filters: collectFilterOptions(model, summary),
      executive: projectExecutive(model, summary),
      issues: projectIssues(model, summary),
      technicalEvidence: projectTechnicalEvidence(model),
      readerMaps: projectReaderMaps(model),
      methodology: projectMethodology(model),
      exports: projectExports(model),
      matrix: projectMatrix(model),
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

function finitePositive(value) { return Number.isFinite(value) && value > 0 ? value : null; }

function clamp(value, minimum, maximum) { return Math.min(maximum, Math.max(minimum, value)); }

function evidenceFrame(artifact) {
  const cached = EVIDENCE_FRAME_BY_ARTIFACT.get(artifact);
  if (cached) return cached;
  let width = finitePositive(artifact.metadata?.width);
  let height = finitePositive(artifact.metadata?.height);
  if (width === null || height === null) {
    try {
      const metadata = decodePngDataUrl(artifact.dataUrl);
      width ??= metadata.width;
      height ??= metadata.height;
    } catch { return null; }
  }
  const candidate = artifact.metadata?.highlightBox;
  const box = !candidate || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(candidate[key]))
    ? { x: 0, y: 0, width, height }
    : (() => {
      const x = clamp(candidate.x, 0, width);
      const y = clamp(candidate.y, 0, height);
      const right = clamp(candidate.x + Math.max(0, candidate.width), x, width);
      const bottom = clamp(candidate.y + Math.max(0, candidate.height), y, height);
      return { x, y, width: right - x, height: bottom - y };
    })();
  const frame = Object.freeze({ width, height, box: Object.freeze(box) });
  EVIDENCE_FRAME_BY_ARTIFACT.set(artifact, frame);
  return frame;
}

function appendEvidenceMedia(document, figure, artifact, tone) {
  const label = `${evidenceKindLabel(artifact.kind)} local da evidência ${artifact.evidenceId}`;
  const treatment = artifact.kind === 'element' && tone ? EVIDENCE_TREATMENTS_V1[tone] : null;
  const frame = treatment ? evidenceFrame(artifact) : null;
  if (!treatment || !frame) {
    const image = document.createElement('img');
    image.setAttribute('src', artifact.dataUrl);
    image.setAttribute('alt', label);
    image.setAttribute('class', 'evidence-media');
    figure.append(image);
    return `${label}.`;
  }
  const svg = document.createElementNS(SVG_NAMESPACE, 'svg');
  svg.setAttribute('class', 'evidence-media evidence-media--marked');
  svg.setAttribute('data-evidence-treatment', treatment.tone);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `${label} ${treatment.aria}`);
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
  const box = document.createElementNS(SVG_NAMESPACE, 'rect');
  box.setAttribute('class', `evidence-highlight evidence-highlight--${treatment.tone}`);
  box.setAttribute('data-evidence-highlight', treatment.tone);
  box.setAttribute('x', frame.box.x);
  box.setAttribute('y', frame.box.y);
  box.setAttribute('width', frame.box.width);
  box.setAttribute('height', frame.box.height);
  box.setAttribute('aria-hidden', 'true');
  svg.append(image, box);
  figure.append(svg);
  return `${treatment.legend} ${label}.`;
}

function plainBlock(document, name, title) {
  const block = document.createElement('section');
  block.setAttribute('class', 'issue-plain-block');
  block.setAttribute('data-report-plain-block', name);
  block.append(element(document, 'h4', title));
  return block;
}

function correlatedEvidence(issue, evidenceById) {
  const evidenceIds = new Set(issue.occurrences.flatMap(occurrence => occurrence.evidenceRefs));
  return [...evidenceById.values()].filter(evidence => evidenceIds.has(evidence.evidenceId));
}

function appendTechnicalDetails(document, article, issue, evidence) {
  const details = document.createElement('details');
  details.setAttribute('data-report-technical', '');
  details.append(
    element(document, 'summary', 'Ver detalhes técnicos'),
    element(document, 'p', `Resultado original: ${outcomeLabel(issue.originalOutcome)}. Resultado consolidado: ${outcomeLabel(issue.displayOutcome)}.`),
    element(document, 'p', `Contexto técnico: ${issue.context ?? 'não registrado'}. Página: ${issue.pageId}.`),
  );
  for (const occurrence of issue.occurrences) {
    const block = document.createElement('section');
    block.setAttribute('data-report-occurrence-technical', occurrence.occurrenceId);
    block.append(
      element(document, 'h4', `ID da ocorrência: ${occurrence.occurrenceId}`),
      element(document, 'p', `Proveniência: Página ${issue.pageId}; Motor ${occurrence.source.engine}; Regra ${occurrence.source.ruleId}; Versão ${occurrence.source.version}.`),
      element(document, 'p', `Item ABNT: ${abntItemLabel(occurrence.itemId)}. Classificação: ${classificationLabel(occurrence.classification)}.`),
    );
    details.append(block);
  }
  for (const item of evidence) {
    const block = document.createElement('section');
    block.setAttribute('data-report-occurrence-evidence', item.evidenceId);
    block.append(
      element(document, 'h4', `ID da evidência: ${item.evidenceId} — ${evidenceKindLabel(item.kind)}`),
      element(document, 'p', `Proveniência: página ${item.pageId}; tipo ${item.kind}; estado ${item.state ?? 'não registrado'}.`),
      element(document, 'p', `URL: ${item.mediaUrl ?? 'não registrada.'}`),
      element(document, 'p', `Horário: ${item.observedAt ?? 'não registrado.'}`),
      element(document, 'p', `Seletor: ${item.selector?.css ?? 'não registrado.'}`),
      element(document, 'p', `Snippet: ${item.snippet ?? 'não disponível.'}`),
      element(document, 'p', `Hash: ${item.hash ?? 'não disponível.'}`),
    );
    details.append(block);
  }
  article.append(details);
}

function appendEvidencePreview(document, article, evidence, evidenceAnchorById, issue, highlightOptions = null) {
  const preview = document.createElement('section');
  preview.setAttribute('data-report-evidence-preview', '');
  preview.append(element(document, 'h4', 'Capturas registradas'));
  const selected = projectOccurrenceEvidencePreviews({
    evidence: evidence.filter(item => isSafePngDataUrl(item.dataUrl)),
    occurrences: issue.occurrences,
  });
  if (selected.length === 0) {
    preview.append(element(document, 'p', 'Nenhuma captura PNG local está disponível para esta verificação.'));
  } else {
    for (const { artifact: item, tone } of selected) {
      const figure = document.createElement('figure');
      figure.setAttribute('data-evidence-kind', item.kind);
      const caption = appendEvidenceMedia(document, figure, item, tone);
      figure.append(element(document, 'figcaption', caption));
      preview.append(figure);
    }
  }
  article.append(preview);
  if (highlightOptions?.enabled === true && typeof highlightOptions.onIntent === 'function' &&
    Array.isArray(highlightOptions.occurrenceIds) && highlightOptions.occurrenceIds.length > 0) {
    const total = highlightOptions.occurrenceIds.length;
    for (const [index, occurrenceId] of highlightOptions.occurrenceIds.entries()) {
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
  } else {
    const fallback = element(document, 'p', 'O destaque ao vivo não está disponível neste relatório. Consulte as capturas registradas no momento da auditoria.');
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

function issueArticle(document, issue, group, evidenceById, evidenceAnchorById, highlightOptions = null) {
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
    element(document, 'p', `Estado consolidado: ${outcomeLabel(issue.displayOutcome)}.`),
    element(document, 'p', `Classificação: ${classificationLabel(issue.classification)}. Impacto: ${impactLabel(issue.impact)}.`),
  );
  article.append(heading);
  const impact = plainBlock(document, 'impact', 'Impacto para a pessoa usuária');
  impact.append(element(document, 'p', issue.plainLanguage.impact)); article.append(impact);
  const observed = plainBlock(document, 'observed', 'O que foi observado');
  appendTextList(document, observed, issue.plainLanguage.observed, 'Nenhuma justificativa adicional foi registrada.');
  article.append(observed);
  const correctionCopy = correctionPresentation(group);
  const correction = plainBlock(document, 'correction', correctionCopy.title);
  correction.append(
    element(document, 'p', `Correção: ${issue.plainLanguage.correction}`),
    element(document, 'p', correctionCopy.confirmation),
  );
  article.append(correction);
  const announcement = plainBlock(document, 'announcement', 'Nome acessível e anúncio estimado');
  announcement.append(
    element(document, 'p', `Nome acessível: ${issue.accessibleName ?? 'não disponível'}.`),
    element(document, 'p', `Anúncio estimado: ${issue.announcement ?? 'indisponível'}.`),
    element(document, 'p', 'Esta prévia não é transcrição literal de tecnologia assistiva e pode variar conforme o leitor e as preferências.'),
  );
  article.append(announcement);
  const normative = plainBlock(document, 'normative', 'Fundamentação normativa');
  normative.append(element(document, 'p', `WCAG 2.2: ${issue.wcag.join(', ') || 'sem referência'}. ABNT NBR 17225: ${abntItemsLabel(issue.abntItemIds)}.`));
  article.append(normative);
  const legalReferences = issue.occurrences.map(occurrence => occurrence.legalReference).filter(Boolean);
  if (legalReferences.length > 0) {
    const legal = plainBlock(document, 'legal', 'Fundamentação legal qualificada');
    for (const reference of legalReferences) {
      legal.append(element(document, 'p', `${reference.label}: ${reference.text} ${reference.qualification}`));
    }
    article.append(legal);
  }
  const evidence = correlatedEvidence(issue, evidenceById);
  appendEvidencePreview(document, article, evidence, evidenceAnchorById, issue,
    highlightOptions && ['failed', 'humanReview'].includes(group)
      ? {
        ...highlightOptions, occurrenceIds: issue.occurrences.map(value => value.occurrenceId),
        issueTitle: issue.title, pageId: issue.pageId,
      }
      : null);
  appendTechnicalDetails(document, article, issue, evidence);
  return article;
}

function renderFilters(document, view, root, status) {
  const wrapper = document.createElement('div');
  wrapper.setAttribute('class', 'report-filters');
  wrapper.setAttribute('aria-label', 'Filtros do relatório vivo');
  const active = new Map();
  const total = GROUPS.reduce((count, group) => count + view.issues[group].length, 0);
  status.textContent = `${countLabel(total, 'verificação', 'verificações')} visíveis. Os filtros não alteram os arquivos exportados.`;
  const apply = () => {
    let visible = 0;
    for (const issue of root.querySelectorAll('[data-report-issue]')) {
      let match = true;
      for (const [dimension, value] of active) {
        const values = (issue.getAttribute(`data-${dimension}`) ?? '').split(' ');
        if (!values.includes(value)) { match = false; break; }
      }
      issue.hidden = !match;
      if (match) visible += 1;
    }
    status.textContent = `${visible} resultados visíveis. Os filtros não alteram os arquivos exportados.`;
  };
  for (const dimension of FILTERS) {
    const group = document.createElement('div');
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', FILTER_PRESENTATION[dimension].aria);
    const visibleLabel = element(document, 'strong', FILTER_PRESENTATION[dimension].visible, 'report-filter-label');
    visibleLabel.setAttribute('data-report-filter-label', '');
    group.append(visibleLabel);
    for (const option of view.filters[dimension]) {
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
  wrapper.append(status);
  return wrapper;
}

export function renderReportView({ view, document, onExport, onHighlightIntent = null } = {}) {
  if (!view || view.version !== 1 || !document || typeof document.createElement !== 'function' ||
    typeof onExport !== 'function' || ![null, 'function'].includes(onHighlightIntent === null ? null : typeof onHighlightIntent)) denied();
  const root = document.createElement('div');
  root.setAttribute('class', 'report-view');
  const identity = document.createElement('header');
  identity.setAttribute('class', 'report-identity');
  identity.append(
    element(document, 'p', 'Audita Acessibilidade — relatório técnico independente'),
    element(document, 'p', `Escopo avaliado: ${view.executive.identity.finalUrl}`),
  );
  root.append(identity);
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
    element(document, 'span', ' Mede a execução automática; não é nota, certificação ou declaração de conformidade.'),
  );
  executive.append(coverageSummary);
  const metrics = document.createElement('div');
  metrics.setAttribute('class', 'report-metrics');
  metrics.setAttribute('data-report-metrics', '');
  for (const [group, label, count] of [
    ['failed', 'Não conformidades', view.executive.counts.errors],
    ['alerts', 'Alertas', view.executive.counts.alerts],
    ['humanReview', 'Revisões humanas', view.executive.counts.humanReview],
    ['passed', 'Resultados positivos', view.executive.counts.positive],
  ]) {
    const card = document.createElement('article'); card.setAttribute('data-report-metric', group);
    card.append(
      element(document, 'strong', String(count.checkKeys), 'metric-value'),
      element(document, 'span', label, 'metric-label'),
      element(document, 'small', `${countLabel(count.checkKeys, 'verificação', 'verificações')} · ${countLabel(count.occurrences, 'ocorrência', 'ocorrências')}`, 'metric-detail'),
    );
    metrics.append(card);
  }
  executive.append(metrics);
  const limitations = document.createElement('details');
  limitations.setAttribute('data-report-limitations', '');
  const noPixelEvidence = view.executive.limitations.includes(
    'PIXEL_CAPTURE_OMITTED: Nenhuma captura raster foi coletada no modo sem imagens.');
  const elementOnlyEvidence = view.executive.limitations.includes(
    'FULL_PAGE_CAPTURE_OMITTED: A captura integral e o mapa anotado foram omitidos pela política; miniaturas de elementos permaneceram permitidas.') &&
    !view.technicalEvidence.some(evidence => evidence.kind === 'full-page') &&
    view.technicalEvidence.some(evidence => evidence.kind === 'element');
  const elementThumbnailAvailable = view.technicalEvidence.some(evidence =>
    evidence.kind === 'element' && isSafePngDataUrl(evidence.dataUrl));
  const limitationSummary = noPixelEvidence
    ? 'Modo sem imagens: nenhuma captura raster.'
    : elementOnlyEvidence
      ? elementThumbnailAvailable
        ? 'Captura integral omitida: miniaturas de elementos disponíveis.'
        : 'Captura integral omitida: evidências estruturais de elementos registradas, sem miniaturas PNG disponíveis.'
      : null;
  limitations.append(element(document, 'summary', `Limitações registradas (${view.executive.limitations.length})${
    limitationSummary === null ? '' : ` · ${limitationSummary}`
  }`));
  appendTextList(document, limitations, view.executive.limitations, 'Nenhuma limitação crítica registrada.');
  const actions = document.createElement('div');
  actions.setAttribute('class', 'executive-actions');
  actions.setAttribute('data-report-executive-actions', '');
  const exportButton = element(document, 'button', 'Exportar HTML, PDF, CSV e JSON');
  exportButton.setAttribute('type', 'button'); exportButton.setAttribute('data-report-export', '');
  exportButton.addEventListener('click', () => onExport());
  actions.append(exportButton);
  executive.append(actions, limitations);
  root.append(executive);
  root.append(sectionNavigation(document));

  const coverage = section(document, 1);
  const evidenceById = new Map(view.technicalEvidence.map(evidence => [evidence.evidenceId, evidence]));
  const evidenceAnchorById = new Map(view.technicalEvidence.map((evidence, index) => [evidence.evidenceId, `report-evidence-${index + 1}`]));
  coverage.append(element(document, 'p', view.executive.coverage.status === 'available'
    ? `Cobertura automática: ${view.executive.coverage.percent}.`
    : 'Cobertura automática indisponível.'));
  coverage.append(element(document, 'p', 'Percentual da execução automática concluída. Não é nota, certificação ou declaração de conformidade.'));
  coverage.append(renderFilters(document, view, root, live));
  for (const group of GROUPS) {
    const groupNode = document.createElement('div');
    groupNode.setAttribute('data-report-group', group);
    groupNode.append(element(document, 'h3', `${GROUP_LABELS[group]}: ${view.issues[group].length}`));
    groupNode.append(element(document, 'p', 'As fichas detalhadas aparecem uma única vez nas seções seguintes.'));
    if (['alerts', 'passed'].includes(group)) {
      for (const issue of view.issues[group]) groupNode.append(issueArticle(document, issue, group, evidenceById, evidenceAnchorById));
    }
    coverage.append(groupNode);
  }
  root.append(coverage);

  const failed = section(document, 2);
  for (const issue of view.issues.failed) failed.append(issueArticle(document, issue, 'failed', evidenceById, evidenceAnchorById,
    onHighlightIntent ? { enabled: true, onIntent: onHighlightIntent } : null));
  root.append(failed);

  const review = section(document, 3);
  review.setAttribute('data-review-controls-target', '');
  for (const issue of view.issues.humanReview) review.append(issueArticle(document, issue, 'humanReview', evidenceById, evidenceAnchorById,
    onHighlightIntent ? { enabled: true, onIntent: onHighlightIntent } : null));
  root.append(review);

  const maps = section(document, 4);
  maps.append(element(document, 'p', 'As prévias de anúncio são uma estimativa; não são transcrições literais de tecnologia assistiva.'));
  for (const map of view.readerMaps) {
    const card = document.createElement('article'); card.setAttribute('class', 'report-map');
    card.append(element(document, 'p', `Artefato: ${map.evidenceId}.`), element(document, 'p', `Legenda: mapa de anúncios da página ${map.pageId}.`));
    maps.append(card);
  }
  root.append(maps);

  const matrix = section(document, 5);
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
  matrixScroll.append(table); matrix.append(matrixScroll); root.append(matrix);

  const methodology = section(document, 6);
  appendTextList(document, methodology, view.methodology.caveats, 'Sem ressalvas adicionais.');
  methodology.append(element(document, 'p', `Integridade: ${view.modelHash}.`));
  const officialSources = document.createElement('div'); officialSources.setAttribute('data-official-sources', '');
  officialSources.append(element(document, 'h3', 'Fontes oficiais'));
  for (const source of CONSUMER_ACCESSIBILITY_FIXED_BASIS.sources) {
    const sourceText = element(document, 'p', `${source.publisher} — ${source.title} — ${source.url}`);
    sourceText.setAttribute('data-official-source', ''); officialSources.append(sourceText);
  }
  methodology.append(officialSources);
  const sources = document.createElement('div'); sources.setAttribute('data-technical-evidence', '');
  sources.append(element(document, 'h3', 'Evidências técnicas e anexos'));
  for (const evidence of view.technicalEvidence) {
    const card = document.createElement('article'); card.setAttribute('data-report-evidence', evidence.evidenceId);
    card.setAttribute('data-evidence-kind', evidence.kind);
    card.setAttribute('id', evidenceAnchorById.get(evidence.evidenceId));
    card.append(
      element(document, 'h4', `${evidence.evidenceId} — ${evidenceKindLabel(evidence.kind)}`),
      element(document, 'p', `URL: ${evidence.mediaUrl ?? 'não registrada.'}`),
      element(document, 'p', `Horário: ${evidence.observedAt ?? 'não registrado.'}`),
      element(document, 'p', `Seletor: ${evidence.selector?.css ?? 'não registrado.'}`),
      element(document, 'p', `Snippet: ${evidence.snippet ?? 'não disponível.'}`),
    );
    if (isSafePngDataUrl(evidence.dataUrl)) {
      const image = document.createElement('img'); image.setAttribute('src', evidence.dataUrl);
      image.setAttribute('alt', `${evidenceKindLabel(evidence.kind)} local da evidência ${evidence.evidenceId}`);
      image.setAttribute('class', 'evidence-media'); card.append(image);
    } else card.append(element(document, 'p', 'Imagem segura: PNG local não disponível.'));
    sources.append(card);
  }
  methodology.append(sources);
  root.append(methodology);
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
