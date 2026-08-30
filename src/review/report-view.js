import { createAuditModel } from '../core/report/audit-model.js';
import { CONSUMER_ACCESSIBILITY_FIXED_BASIS, qualifiedConsumerReference } from '../core/legal/consumer-basis.js';
import { NBR17225_ITEMS } from '../core/normative/nbr17225.js';
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
const SECTION_TITLES = Object.freeze([
  'Sumário executivo e limitações críticas',
  'Cobertura e quatro grupos de resultado',
  'Não conformidades priorizadas',
  'Revisões humanas pendentes',
  'Mapas de anúncios',
  'Matriz completa dos 146 itens',
  'Metodologia, fontes, integridade, evidências técnicas e anexos',
]);
const MAX_GRAPH_NODES = 200_000;

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

function groupMetric(view, group) {
  const cards = view.issues[group];
  return { checkKeys: cards.length, occurrences: cards.reduce((total, card) => total + card.occurrences.length, 0) };
}

function countLabel(count, singular, plural) { return `${count} ${count === 1 ? singular : plural}`; }

function remediationForOccurrence(model, occurrence) {
  const rule = model.ruleResults.find(candidate => candidate.ruleId === occurrence.source.ruleId && candidate.source?.engine === 'audita-core');
  const occurrenceNode = occurrence.nodeId === null ? null : String(occurrence.nodeId);
  const target = rule?.targets?.find(candidate => candidate && typeof candidate === 'object' && !Array.isArray(candidate) &&
    typeof candidate.message === 'string' && (candidate.nodeId === 'document' ? null : String(candidate.nodeId)) === occurrenceNode);
  return target?.message ?? null;
}

export function collectFilterOptions(model, summary) {
  const cards = GROUPS.flatMap(group => summary.groups[group].map(card => ({ ...card, result: group })));
  return freeze({
    impact: copyRows(summary.distributions.impact),
    wcag: copyRows(summary.distributions.wcag),
    result: GROUPS.map(id => ({ id, count: summary.groups[id].length })),
    classification: countOptions(cards, card => [card.classification]),
    page: countOptions(cards, card => [card.pageId]),
    engine: countOptions(cards, card => [card.engine]),
    abnt: copyRows(summary.distributions.abnt),
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
      ...summary.limitations.codes,
      ...summary.limitations.notStartedPageIds.map(id => `Página não iniciada: ${id}.`),
      ...summary.limitations.untestedCheckKeys.map(id => untestedLimitationLabel(model, id)),
    ])],
  });
}

function projectCard(card, model, decisionByOccurrence) {
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
  return freeze({
    checkKey: card.checkKey, pageId: card.pageId, engine: card.engine, ruleId: card.ruleId,
    title: card.title, originalOutcome: card.originalOutcome, displayOutcome: card.displayOutcome,
    classification: card.classification, impact: card.impact, wcag: [...card.wcag],
    abntItemIds: [...card.abntItemIds], context: card.context, occurrenceIds: [...card.occurrenceIds],
    accessibleName: card.accessibleName, announcement: card.announcement,
    remediation: occurrences.find(occurrence => occurrence.remediation !== null)?.remediation ?? null, occurrences,
  });
}

export function projectIssues(model, summary) {
  const decisions = new Map(model.reviewDecisions.map(decision => [decision.occurrenceId, decision]));
  return freeze(Object.fromEntries(GROUPS.map(group => [
    group,
    summary.groups[group].map(card => projectCard(card, model, decisions))
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
  navigation.append(element(document, 'strong', 'Navegue pelo relatório'));
  const list = document.createElement('ul');
  for (const [index, title] of SECTION_TITLES.entries()) {
    const item = document.createElement('li');
    const link = element(document, 'a', title);
    link.setAttribute('href', `#report-section-${index + 1}`);
    item.append(link); list.append(item);
  }
  navigation.append(list);
  return navigation;
}

function isSafePngDataUrl(value) { return typeof value === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/u.test(value); }

function appendEvidenceDetails(document, article, issue, evidenceById) {
  const evidenceIds = [...new Set(issue.occurrences.flatMap(occurrence => occurrence.evidenceRefs))];
  const details = document.createElement('details');
  details.append(element(document, 'summary', 'Evidências técnicas'));
  for (const evidenceId of evidenceIds) {
    const evidence = evidenceById.get(evidenceId);
    if (!evidence) continue;
    const block = document.createElement('section'); block.setAttribute('data-report-occurrence-evidence', evidenceId);
    block.append(
      element(document, 'h4', `${evidenceId} — ${evidenceKindLabel(evidence.kind)}`),
      element(document, 'p', `URL: ${evidence.mediaUrl ?? 'não registrada.'}`),
      element(document, 'p', `Horário: ${evidence.observedAt ?? 'não registrado.'}`),
      element(document, 'p', `Seletor: ${evidence.selector?.css ?? 'não registrado.'}`),
      element(document, 'p', `Snippet: ${evidence.snippet ?? 'não disponível.'}`),
    );
    if (isSafePngDataUrl(evidence.dataUrl)) {
      const image = document.createElement('img'); image.setAttribute('src', evidence.dataUrl);
      image.setAttribute('alt', `${evidenceKindLabel(evidence.kind)} local da evidência ${evidenceId}`);
      image.setAttribute('class', 'evidence-media'); block.append(image);
    } else block.append(element(document, 'p', 'Imagem segura: PNG local não disponível.'));
    details.append(block);
  }
  article.append(details);
}

function issueArticle(document, issue, group, evidenceById) {
  const article = document.createElement('article');
  article.setAttribute('data-report-issue', '');
  article.setAttribute('data-result', group);
  article.setAttribute('data-classification', issue.classification);
  article.setAttribute('data-page', issue.pageId);
  article.setAttribute('data-engine', issue.engine);
  article.setAttribute('data-impact', issue.impact ?? 'none');
  article.setAttribute('data-wcag', issue.wcag.join(' '));
  article.setAttribute('data-abnt', issue.abntItemIds.join(' '));
  article.append(
    element(document, 'h3', issue.title),
    element(document, 'p', `Resultado consolidado: ${outcomeLabel(issue.displayOutcome)}. Resultado original: ${outcomeLabel(issue.originalOutcome)}.`),
    element(document, 'p', `Impacto: ${impactLabel(issue.impact)}. Classificação: ${classificationLabel(issue.classification)}.`),
    element(document, 'p', `Observação: ${issue.context ?? 'Sem observação adicional registrada.'}`),
    element(document, 'p', `Correção: ${issue.remediation ?? 'revise o elemento e aplique a orientação técnica antes de nova auditoria.'}`),
    element(document, 'p', 'Confirmar: repita a verificação após a correção.'),
    element(document, 'p', `WCAG: ${issue.wcag.join(', ') || 'sem referência'}. ABNT: ${issue.abntItemIds.join(', ') || 'sem item'}.`),
    element(document, 'p', `Nome acessível: ${issue.accessibleName ?? 'não disponível'}.`),
    element(document, 'p', `Prévia estimada de anúncio: ${issue.announcement ?? 'indisponível'}.`),
  );
  for (const occurrence of issue.occurrences) {
    article.append(element(document, 'p', occurrence.legalReference
      ? `${occurrence.legalReference.label}: ${occurrence.legalReference.text} ${occurrence.legalReference.qualification}`
      : 'Referência técnica e jurídica qualificada: não aplicável a este resultado.'));
  }
  appendEvidenceDetails(document, article, issue, evidenceById);
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
    group.setAttribute('aria-label', `Filtro ${dimension}`);
    for (const option of view.filters[dimension]) {
      const translated = dimension === 'impact' ? impactLabel(option.id)
        : dimension === 'result' ? labelFor(option.id, GROUP_LABELS)
          : dimension === 'classification' ? classificationLabel(option.id)
            : dimension === 'page' ? `Página ${option.id}` : dimension === 'engine' ? `Motor ${option.id}` : option.id;
      const button = element(document, 'button', `${translated} ${option.count}`);
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

export function renderReportView({ view, document, onExport } = {}) {
  if (!view || view.version !== 1 || !document || typeof document.createElement !== 'function' || typeof onExport !== 'function') denied();
  const root = document.createElement('div');
  root.setAttribute('class', 'report-view');
  const identity = document.createElement('header');
  identity.setAttribute('class', 'report-identity');
  identity.append(
    element(document, 'p', 'Audita Acessibilidade — relatório técnico independente'),
    element(document, 'p', `Escopo avaliado: ${view.executive.identity.finalUrl}`),
    element(document, 'p', `Estado: ${statusLabel(view.executive.status)}. Revisão do modelo: ${view.modelRevision}.`),
  );
  root.append(identity);
  root.append(sectionNavigation(document));
  const live = element(document, 'p');
  live.setAttribute('class', 'report-filter-status');
  live.setAttribute('role', 'status'); live.setAttribute('aria-live', 'polite'); live.setAttribute('aria-atomic', 'true');

  const executive = section(document, 0);
  const metrics = document.createElement('div'); metrics.setAttribute('class', 'report-metrics');
  for (const [group, label] of [
    ['failed', 'Não conformidades'], ['alerts', 'Alertas'],
    ['humanReview', 'Revisões humanas'], ['passed', 'Resultados positivos'],
  ]) {
    const metric = groupMetric(view, group);
    const card = document.createElement('article'); card.setAttribute('data-report-metric', group);
    card.append(
      element(document, 'strong', String(metric.checkKeys), 'metric-value'),
      element(document, 'span', label, 'metric-label'),
      element(document, 'small', `${countLabel(metric.checkKeys, 'verificação', 'verificações')} · ${countLabel(metric.occurrences, 'ocorrência', 'ocorrências')}`, 'metric-detail'),
    );
    metrics.append(card);
  }
  executive.append(metrics);
  appendTextList(document, executive, view.executive.limitations, 'Nenhuma limitação crítica registrada.');
  root.append(executive);

  const coverage = section(document, 1);
  const evidenceById = new Map(view.technicalEvidence.map(evidence => [evidence.evidenceId, evidence]));
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
      for (const issue of view.issues[group]) groupNode.append(issueArticle(document, issue, group, evidenceById));
    }
    coverage.append(groupNode);
  }
  root.append(coverage);

  const failed = section(document, 2);
  for (const issue of view.issues.failed) failed.append(issueArticle(document, issue, 'failed', evidenceById));
  root.append(failed);

  const review = section(document, 3);
  review.setAttribute('data-review-controls-target', '');
  for (const issue of view.issues.humanReview) review.append(issueArticle(document, issue, 'humanReview', evidenceById));
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
  const exportButton = element(document, 'button', 'Exportar HTML, PDF, CSV e JSON');
  exportButton.setAttribute('type', 'button'); exportButton.setAttribute('data-report-export', '');
  exportButton.addEventListener('click', () => onExport()); methodology.append(exportButton);
  root.append(methodology);
  return root;
}

export { SECTION_TITLES as REPORT_SECTION_TITLES_V1 };
