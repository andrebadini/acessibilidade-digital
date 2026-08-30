import { createAuditModel } from '../core/report/audit-model.js';
import { qualifiedConsumerReference } from '../core/legal/consumer-basis.js';
import { NBR17225_ITEMS } from '../core/normative/nbr17225.js';
import { EXPORT_FORMATS_V1 } from '../export/export-formats.js';

const GROUPS = Object.freeze(['failed', 'alerts', 'humanReview', 'passed']);
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
      ...summary.limitations.untestedCheckKeys.map(id => `Verificação não testada: ${id}.`),
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
      };
    });
  return freeze({
    checkKey: card.checkKey, pageId: card.pageId, engine: card.engine, ruleId: card.ruleId,
    title: card.title, originalOutcome: card.originalOutcome, displayOutcome: card.displayOutcome,
    classification: card.classification, impact: card.impact, wcag: [...card.wcag],
    abntItemIds: [...card.abntItemIds], context: card.context, occurrenceIds: [...card.occurrenceIds],
    accessibleName: card.accessibleName, announcement: card.announcement, occurrences,
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

function issueArticle(document, issue, group) {
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
    element(document, 'p', `Resultado consolidado: ${issue.displayOutcome}. Resultado original: ${issue.originalOutcome}.`),
    element(document, 'p', `Impacto: ${issue.impact ?? 'não aplicável'}. Classificação: ${issue.classification}.`),
    element(document, 'p', `WCAG: ${issue.wcag.join(', ') || 'sem referência'}. ABNT: ${issue.abntItemIds.join(', ') || 'sem item'}.`),
    element(document, 'p', `Prévia estimada de anúncio: ${issue.announcement ?? 'indisponível'}.`),
  );
  return article;
}

function renderFilters(document, view, root, status) {
  const wrapper = document.createElement('div');
  wrapper.setAttribute('class', 'report-filters');
  wrapper.setAttribute('aria-label', 'Filtros do relatório vivo');
  const active = new Map();
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
      const button = element(document, 'button', `${option.id} ${option.count}`);
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
    element(document, 'p', `Estado: ${view.executive.status}. Revisão do modelo: ${view.modelRevision}.`),
  );
  root.append(identity);
  const live = element(document, 'p', 'Relatório completo carregado.');
  live.setAttribute('role', 'status'); live.setAttribute('aria-live', 'polite'); live.setAttribute('aria-atomic', 'true');
  root.append(live);

  const executive = section(document, 0);
  appendTextList(document, executive, view.executive.limitations, 'Nenhuma limitação crítica registrada.');
  root.append(executive);

  const coverage = section(document, 1);
  coverage.append(element(document, 'p', view.executive.coverage.status === 'available'
    ? `Cobertura automática: ${view.executive.coverage.percent}.`
    : 'Cobertura automática indisponível.'));
  coverage.append(element(document, 'p', 'Percentual da execução automática concluída. Não é nota, certificação ou declaração de conformidade.'));
  coverage.append(renderFilters(document, view, root, live));
  for (const group of GROUPS) {
    const groupNode = document.createElement('div');
    groupNode.setAttribute('data-report-group', group);
    groupNode.append(element(document, 'h3', group));
    for (const issue of view.issues[group]) groupNode.append(issueArticle(document, issue, group));
    coverage.append(groupNode);
  }
  root.append(coverage);

  const failed = section(document, 2);
  for (const issue of view.issues.failed) failed.append(issueArticle(document, issue, 'failed'));
  root.append(failed);

  const review = section(document, 3);
  review.setAttribute('data-review-controls-target', '');
  for (const issue of view.issues.humanReview) review.append(issueArticle(document, issue, 'humanReview'));
  root.append(review);

  const maps = section(document, 4);
  maps.append(element(document, 'p', 'As prévias de anúncio são uma estimativa; não são transcrições literais de tecnologia assistiva.'));
  for (const map of view.readerMaps) maps.append(element(document, 'p', `Mapa ${map.evidenceId}: ${map.pageId}.`));
  root.append(maps);

  const matrix = section(document, 5);
  const table = document.createElement('table');
  const caption = element(document, 'caption', 'Matriz completa da ABNT NBR 17225'); table.append(caption);
  const head = document.createElement('thead'); const headRow = document.createElement('tr');
  for (const title of ['Item', 'Título', 'Classificação', 'Resultado', 'WCAG']) headRow.append(element(document, 'th', title));
  head.append(headRow); table.append(head);
  const body = document.createElement('tbody');
  for (const row of view.matrix) {
    const tr = document.createElement('tr');
    for (const value of [row.id, row.title, row.classification, row.outcome, row.wcag.map(ref => `${ref.id} ${ref.level}`).join(', ')]) {
      tr.append(element(document, 'td', value));
    }
    body.append(tr);
  }
  table.append(body); matrix.append(table); root.append(matrix);

  const methodology = section(document, 6);
  appendTextList(document, methodology, view.methodology.caveats, 'Sem ressalvas adicionais.');
  methodology.append(element(document, 'p', `Integridade: ${view.modelHash}.`));
  const sources = document.createElement('div'); sources.setAttribute('data-technical-evidence', '');
  sources.append(element(document, 'h3', 'Evidências técnicas e anexos'));
  for (const evidence of view.technicalEvidence) sources.append(element(document, 'p', `${evidence.evidenceId}: ${evidence.kind}.`));
  methodology.append(sources);
  const exportButton = element(document, 'button', 'Exportar HTML, PDF, CSV e JSON');
  exportButton.setAttribute('type', 'button'); exportButton.setAttribute('data-report-export', '');
  exportButton.addEventListener('click', () => onExport()); methodology.append(exportButton);
  root.append(methodology);
  return root;
}

export { SECTION_TITLES as REPORT_SECTION_TITLES_V1 };
