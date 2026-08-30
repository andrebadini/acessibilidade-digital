const SCREEN_NAMES = Object.freeze(['initial', 'running', 'result', 'unavailable']);
const GROUPS = Object.freeze(['failed', 'alerts', 'humanReview', 'passed']);
const FILTERS = Object.freeze(['impact', 'wcag', 'abnt']);
const RUNNING_PHASES = Object.freeze([
  'Abrindo e estabilizando a página.',
  'Lendo estrutura e acessibilidade.',
  'Verificando regras automáticas.',
  'Coletando evidências.',
  'Preparando o resultado.',
]);
const COVERAGE_DISCLAIMER = 'Percentual da execução automática concluída. Não é nota, certificação ou declaração de conformidade.';

export function buildPanelView({ state, summary = null, detail = null } = {}) {
  if (!state || !SCREEN_NAMES.includes(state.screen)) throw new TypeError('PANEL_VIEW_STATE_INVALID');
  const base = {
    version: 1,
    screen: state.screen,
    auditId: typeof state.auditId === 'string' ? state.auditId : null,
    filters: copyFilters(state.filters),
    selectedOccurrenceId: typeof state.selectedOccurrenceId === 'string' ? state.selectedOccurrenceId : null,
    evidenceExpanded: state.evidenceExpanded === true,
    focusId: typeof state.focusId === 'string' ? state.focusId : null,
    scrollTop: Number.isSafeInteger(state.scrollTop) && state.scrollTop >= 0 ? state.scrollTop : 0,
    reason: typeof state.reason === 'string' ? state.reason : null,
  };
  if (state.screen !== 'result') return freezeRenderModel(base);
  if (!summary || summary.auditId !== base.auditId) throw new TypeError('PANEL_VIEW_RESULT_INVALID');
  const summaryCopy = copySummary(summary);
  const detailCopy = detail && detail.auditId === base.auditId && detail.occurrenceId === base.selectedOccurrenceId
    ? copyDetail(detail)
    : null;
  const groups = {};
  for (const name of GROUPS) {
    groups[name] = summaryCopy.groups[name].filter(card => cardMatchesFilters(card, base.filters));
  }
  return freezeRenderModel({
    ...base,
    result: {
      summary: summaryCopy,
      groups,
      detail: detailCopy,
    },
  });
}

export function renderPanelView({ view, document, onIntent, onEvent = () => {} } = {}) {
  if (!view || !SCREEN_NAMES.includes(view.screen) || typeof document?.createElement !== 'function' ||
    typeof onIntent !== 'function' || typeof onEvent !== 'function') throw new TypeError('PANEL_RENDER_INPUT_INVALID');
  const emitIntent = intent => {
    switch (intent.type) {
      case 'START_ATTACHED':
      case 'OPEN_URL_FORM':
      case 'OPEN_BATCH_FORM':
      case 'CANCEL_AUDIT':
      case 'OPEN_REPORT':
      case 'SELECT_OCCURRENCE':
      case 'CONSULT_EVIDENCE':
      case 'RETRY':
        onIntent(freezeRenderModel({ ...intent }));
        return;
      default:
        throw new TypeError('PANEL_UI_INTENT_INVALID');
    }
  };

  switch (view.screen) {
    case 'initial': return renderInitial(document, emitIntent);
    case 'running': return renderRunning(document, emitIntent);
    case 'result': return renderResult(document, view, emitIntent, onEvent);
    case 'unavailable': return renderUnavailable(document, view, emitIntent);
    default: throw new TypeError('PANEL_SCREEN_INVALID');
  }
}

function renderInitial(document, emit) {
  const root = section(document, 'panel-screen panel-initial');
  root.dataset.screen = 'initial';
  root.append(
    heading(document, 2, 'Avaliar acessibilidade'),
    paragraph(document, 'A auditoria acontece localmente nesta página e não envia o conteúdo para serviços externos.', 'lead'),
  );
  const choices = section(document, 'source-choices');
  choices.setAttribute('aria-label', 'Escolher origem da auditoria');
  choices.append(
    actionButton(document, 'Auditar a página atual', 'START_ATTACHED', 'start-attached', emit, 'primary-action'),
    unavailableChoice(document, 'Outra URL', 'OPEN_URL_FORM', 'open-url-form', emit),
    unavailableChoice(document, 'Lote de páginas', 'OPEN_BATCH_FORM', 'open-batch-form', emit),
  );
  root.append(choices, liveRegion(document, 'Escolha como iniciar a auditoria.'));
  return root;
}

function unavailableChoice(document, label, intent, focusId, emit) {
  const wrapper = section(document, 'source-choice secondary-choice');
  wrapper.append(
    actionButton(document, label, intent, focusId, emit, 'secondary-action'),
    paragraph(document, 'Disponível no Marco 3', 'availability-note'),
  );
  return wrapper;
}

function renderRunning(document, emit) {
  const root = section(document, 'panel-screen panel-running');
  root.dataset.screen = 'running';
  root.append(
    paragraph(document, 'Auditoria em andamento', 'status-label status-running'),
    heading(document, 2, 'Avaliando a página atual'),
    paragraph(document, 'Estas etapas explicam o processo em ordem, sem indicar qual delas está em andamento nem uma porcentagem parcial.', 'supporting-copy'),
  );
  const phases = document.createElement('ol');
  phases.className = 'phase-list';
  for (const phase of RUNNING_PHASES) {
    const item = document.createElement('li');
    item.textContent = phase;
    phases.append(item);
  }
  root.append(
    phases,
    actionButton(document, 'Cancelar auditoria', 'CANCEL_AUDIT', 'cancel-audit', emit, 'danger-action'),
    liveRegion(document, 'Auditoria em andamento.'),
  );
  return root;
}

function renderResult(document, view, emit, onEvent) {
  const result = view.result;
  const summary = result.summary;
  const root = section(document, 'panel-screen panel-result');
  root.dataset.screen = 'result';
  root.dataset.auditId = view.auditId;

  const identity = section(document, 'result-identity');
  identity.append(
    paragraph(document, statusText(summary.identity.status), `status-label status-${statusClass(summary.identity.status)}`),
    paragraph(document, summary.identity.finalUrl, 'result-url'),
    paragraph(document, formatCompletedAt(summary.identity.completedAt), 'result-time'),
  );
  root.append(identity);

  const coverage = section(document, 'coverage-block');
  coverage.append(heading(document, 2, 'Cobertura automática'));
  if (summary.coverage.status === 'available') {
    coverage.append(
      paragraph(document, summary.coverage.percent, 'coverage-value'),
      paragraph(document, `${summary.coverage.numerator} de ${summary.coverage.denominator} testes aplicáveis`, 'coverage-ratio'),
    );
  } else {
    coverage.append(paragraph(document, 'Cobertura indisponível para esta execução.', 'coverage-value coverage-unavailable'));
  }
  coverage.append(paragraph(document, COVERAGE_DISCLAIMER, 'coverage-disclaimer'));
  root.append(coverage, renderMetrics(document, summary.counts));

  const filters = section(document, 'filters');
  filters.append(heading(document, 2, 'Filtrar resultados'));
  for (const dimension of FILTERS) {
    filters.append(renderFilter(document, dimension, summary.distributions[dimension], view.filters[dimension], onEvent));
  }
  root.append(filters, heading(document, 2, 'Principais questões'));

  const groups = section(document, 'result-groups');
  for (const name of GROUPS) {
    groups.append(renderGroup(document, name, result.groups[name], view, emit, result.detail));
  }
  root.append(groups);

  const footer = section(document, 'result-footer');
  footer.append(actionButton(document, 'Abrir relatório completo', 'OPEN_REPORT', 'open-report', emit, 'secondary-action report-action'));
  root.append(footer, liveRegion(document, view.evidenceExpanded && result.detail ? result.detail.action.reason : 'Resultado da auditoria carregado.'));
  return root;
}

function renderMetrics(document, counts) {
  const wrapper = section(document, 'metric-grid');
  wrapper.setAttribute('aria-label', 'Resumo dos resultados');
  const metrics = [
    ['Falhas confirmadas', counts.errors, 'failure'],
    ['Alertas', counts.alerts, 'alert'],
    ['Revisão humana', counts.humanReview, 'review'],
    ['Resultados positivos', counts.positive, 'success'],
  ];
  for (const [label, value, kind] of metrics) {
    const item = section(document, `metric metric-${kind}`);
    item.append(
      paragraph(document, String(value.checkKeys), 'metric-value'),
      paragraph(document, label, 'metric-label'),
      paragraph(document, occurrenceText(value.occurrences), 'metric-occurrences'),
    );
    wrapper.append(item);
  }
  return wrapper;
}

function renderFilter(document, dimension, rows, selected, onEvent) {
  const wrapper = section(document, 'filter-group');
  wrapper.setAttribute('role', 'group');
  wrapper.setAttribute('aria-label', filterHeading(dimension));
  wrapper.append(heading(document, 3, filterHeading(dimension)));
  const buttons = section(document, 'filter-options');
  for (const row of rows) {
    const button = document.createElement('button');
    button.setAttribute('type', 'button');
    button.className = 'filter-chip';
    button.dataset.filterDimension = dimension;
    button.dataset.filterValue = row.id;
    button.dataset.focusId = `filter-${dimension}`;
    button.setAttribute('aria-pressed', String(selected.includes(row.id)));
    button.setAttribute('aria-label', `${filterHeading(dimension)}: ${filterLabel(dimension, row.id)}, ${row.count}`);
    button.textContent = `${filterLabel(dimension, row.id)} ${row.count}`;
    button.addEventListener('click', event => {
      const filter = event.currentTarget.dataset.filterDimension;
      const value = event.currentTarget.dataset.filterValue;
      if (!FILTERS.includes(filter) || typeof value !== 'string') return;
      const current = viewFilterSelection(selected, value);
      onEvent(freezeRenderModel({ type: 'FILTER_SET', filter, values: current }));
    });
    buttons.append(button);
  }
  wrapper.append(buttons);
  return wrapper;
}

function renderGroup(document, name, cards, view, emit, detail) {
  const wrapper = section(document, `result-group group-${name}`);
  wrapper.append(heading(document, 3, groupHeading(name)));
  if (cards.length === 0) {
    wrapper.append(paragraph(document, 'Nenhum resultado neste grupo com os filtros atuais.', 'empty-group'));
    return wrapper;
  }
  for (const card of cards) {
    wrapper.append(renderCard(document, card, view, emit));
    if (detail && card.occurrenceIds.includes(detail.occurrenceId)) {
      wrapper.append(renderDetail(document, detail, view.evidenceExpanded, emit));
    }
  }
  return wrapper;
}

function renderCard(document, card, view, emit) {
  const root = document.createElement('article');
  root.className = `result-card card-${card.classification}`;
  root.dataset.resultCard = '';
  root.dataset.checkKey = card.checkKey;
  root.dataset.classification = card.classification;
  root.dataset.context = card.context;
  const occurrenceId = card.occurrenceIds[0] ?? null;
  if (occurrenceId) {
    const selected = view.selectedOccurrenceId === occurrenceId;
    const button = actionButton(document, card.title, 'SELECT_OCCURRENCE', `occurrence-${occurrenceId}`, emit, 'card-select', { occurrenceId });
    button.setAttribute('aria-pressed', String(selected));
    root.append(button);
  } else {
    root.append(heading(document, 4, card.title));
  }
  root.append(
    paragraph(document, classificationLabel(card.classification), 'card-classification'),
    paragraph(document, card.impact ? `Impacto ${impactLabel(card.impact)}` : 'Sem impacto associado', 'card-impact'),
    paragraph(document, card.wcag.length ? `WCAG ${card.wcag.join(', ')}` : 'Sem critério WCAG associado', 'card-normative'),
    paragraph(document, card.abntItemIds.length ? `ABNT ${card.abntItemIds.join(', ')}` : 'Sem item ABNT associado', 'card-normative'),
    paragraph(document, occurrenceText(card.occurrenceIds.length), 'card-occurrences'),
  );
  return root;
}

function renderDetail(document, detail, expanded, emit) {
  const root = section(document, 'result-detail');
  root.dataset.resultDetail = '';
  root.dataset.classification = detail.heading.classification;
  root.dataset.context = detail.heading.context;
  root.append(
    detailBlock(document, 'heading', 'Questão selecionada', [
      detail.heading.title,
      `${classificationLabel(detail.heading.classification)}${detail.heading.impact ? ` · Impacto ${impactLabel(detail.heading.impact)}` : ''}`,
    ]),
    detailBlock(document, 'affected', 'Quem é afetado', [detail.affected.audience, detail.affected.reason]),
    detailBlock(document, 'observed', 'O que foi observado', [detail.observed]),
    detailBlock(document, 'correction', 'Como corrigir', [detail.correction]),
    detailBlock(document, 'targets', 'Alvos relacionados', detail.targets.map(target => `Alvo ${target.position} de ${target.total}`)),
    detailBlock(document, 'accessibility', 'Acessibilidade', [
      detail.accessibility.name ? `Nome acessível: ${detail.accessibility.name}` : 'Nome acessível ausente',
      detail.accessibility.nameSource ? `Origem do nome: ${detail.accessibility.nameSource}` : null,
      detail.accessibility.announcementPreview ? `Anúncio esperado: ${detail.accessibility.announcementPreview}` : null,
    ]),
    detailBlock(document, 'normative', 'Referências normativas', [
      detail.normative.wcag.length ? `WCAG ${detail.normative.wcag.join(', ')}` : null,
      detail.normative.level.length ? `Nível ${detail.normative.level.join(', ')}` : null,
      detail.normative.abntItem ? `ABNT NBR 17225: ${detail.normative.abntItem}` : null,
    ]),
    detailBlock(document, 'legal', 'Referência legal', detail.legalReference ? [
      detail.legalReference.statement, detail.legalReference.qualification,
    ] : ['Não há referência legal específica para esta ocorrência.']),
    previewBlock(document, detail.previews, expanded),
    technicalBlock(document, detail.technical, expanded),
  );
  root.append(actionButton(document, 'Consultar evidências', 'CONSULT_EVIDENCE', 'consult-evidence', emit, 'primary-action', {
    occurrenceId: detail.occurrenceId,
    reason: detail.action.reason,
  }));
  return root;
}

function detailBlock(document, name, title, values) {
  const block = section(document, `detail-block detail-${name}`);
  block.dataset.detailBlock = name;
  block.append(heading(document, name === 'heading' ? 3 : 4, title));
  for (const value of values) if (typeof value === 'string' && value) block.append(paragraph(document, value));
  return block;
}

function previewBlock(document, previews, expanded) {
  const block = document.createElement('details');
  block.className = 'detail-block detail-previews';
  block.dataset.detailBlock = 'previews';
  block.open = expanded;
  const summary = document.createElement('summary');
  summary.dataset.focusId = 'evidence-summary';
  summary.textContent = 'Evidências';
  block.append(summary);
  if (previews.length === 0) block.append(paragraph(document, 'Nenhuma prévia visual foi armazenada.'));
  for (const preview of previews) {
    const item = section(document, 'evidence-preview');
    item.append(
      paragraph(document, preview.kind ? `Tipo: ${preview.kind}` : 'Evidência local'),
      paragraph(document, preview.origin ? `Origem: ${preview.origin}` : 'Origem não informada'),
    );
    block.append(item);
  }
  return block;
}

function technicalBlock(document, technical, expanded) {
  const block = document.createElement('details');
  block.className = 'detail-block detail-technical';
  block.dataset.detailBlock = 'technical';
  block.open = expanded;
  const summary = document.createElement('summary');
  summary.textContent = 'Evidências técnicas';
  block.append(summary);
  block.append(
    paragraph(document, `Mecanismo: ${technical.engine} ${technical.version}`),
    paragraph(document, `Regra: ${technical.ruleId}`),
  );
  if (technical.selector) block.append(labeledCode(document, 'Seletor sanitizado', technical.selector));
  if (technical.snippet) block.append(labeledCode(document, 'Trecho sanitizado', technical.snippet));
  return block;
}

function labeledCode(document, label, value) {
  const wrapper = section(document, 'technical-field');
  wrapper.append(paragraph(document, label, 'technical-label'));
  const code = document.createElement('code');
  code.textContent = value;
  wrapper.append(code);
  return wrapper;
}

function renderUnavailable(document, view, emit) {
  const root = section(document, 'panel-screen panel-unavailable');
  root.dataset.screen = 'unavailable';
  root.append(
    paragraph(document, 'Painel indisponível', 'status-label status-unavailable'),
    heading(document, 2, 'Não foi possível mostrar a auditoria'),
    paragraph(document, view.reason ?? 'Não foi possível concluir a operação local.', 'unavailable-reason'),
    actionButton(document, 'Tentar novamente', 'RETRY', 'retry', emit, 'primary-action'),
    actionButton(document, 'Iniciar nova auditoria', 'START_ATTACHED', 'start-attached', emit, 'secondary-action'),
    liveRegion(document, view.reason ?? 'Painel indisponível.'),
  );
  return root;
}

function actionButton(document, label, intent, focusId, emit, className, fields = {}) {
  const button = document.createElement('button');
  button.setAttribute('type', 'button');
  button.className = className;
  button.dataset.intent = intent;
  button.dataset.focusId = focusId;
  button.textContent = label;
  button.addEventListener('click', () => emit({ type: intent, ...fields }));
  return button;
}

function section(document, className) {
  const element = document.createElement('section');
  element.className = className;
  return element;
}

function heading(document, level, value) {
  const element = document.createElement(`h${level}`);
  element.textContent = value;
  return element;
}

function paragraph(document, value, className = '') {
  const element = document.createElement('p');
  element.className = className;
  element.textContent = value;
  return element;
}

function liveRegion(document, value) {
  const region = paragraph(document, value, 'visually-hidden panel-live');
  region.setAttribute('role', 'status');
  region.setAttribute('aria-live', 'polite');
  region.setAttribute('aria-atomic', 'true');
  return region;
}

function copyFilters(filters) {
  const copy = {};
  for (const name of FILTERS) copy[name] = Array.isArray(filters?.[name]) ? [...filters[name]] : [];
  return copy;
}

function copySummary(summary) {
  return {
    version: summary.version,
    auditId: summary.auditId,
    identity: { ...summary.identity },
    coverage: { ...summary.coverage },
    counts: Object.fromEntries(Object.entries(summary.counts).map(([name, value]) => [name, { ...value }])),
    distributions: Object.fromEntries(FILTERS.map(name => [name, summary.distributions[name].map(row => ({ id: row.id, count: row.count }))])),
    limitations: Object.fromEntries(Object.entries(summary.limitations).map(([name, values]) => [name, [...values]])),
    groups: Object.fromEntries(GROUPS.map(name => [name, summary.groups[name].map(copyCard)])),
  };
}

function copyCard(card) {
  return {
    checkKey: card.checkKey, pageId: card.pageId, engine: card.engine, ruleId: card.ruleId,
    originalOutcome: card.originalOutcome, displayOutcome: card.displayOutcome, title: card.title,
    impact: card.impact, wcag: [...card.wcag], abntItemIds: [...card.abntItemIds],
    occurrenceIds: [...card.occurrenceIds], classification: card.classification, context: card.context,
    accessibleName: card.accessibleName, announcement: card.announcement,
    evidence: { evidenceIds: [...card.evidence.evidenceIds], highlightAvailable: false },
  };
}

function copyDetail(detail) {
  return {
    version: detail.version, auditId: detail.auditId, occurrenceId: detail.occurrenceId, checkKey: detail.checkKey,
    heading: { ...detail.heading }, affected: { ...detail.affected }, observed: detail.observed, correction: detail.correction,
    targets: detail.targets.map(target => ({ nodeId: target.nodeId, position: target.position, total: target.total })),
    accessibility: { ...detail.accessibility },
    normative: { ...detail.normative, wcag: [...detail.normative.wcag], level: [...detail.normative.level] },
    legalReference: detail.legalReference ? { ...detail.legalReference } : null,
    previews: detail.previews.map(preview => ({ ...preview })),
    technical: {
      ...detail.technical, framePath: [...detail.technical.framePath],
      styles: detail.technical.styles.map(style => ({ ...style })), hashes: [...detail.technical.hashes],
    },
    action: { ...detail.action },
  };
}

function cardMatchesFilters(card, filters) {
  const impact = filters.impact.length === 0 || (card.impact !== null && filters.impact.includes(card.impact));
  const wcag = filters.wcag.length === 0 || card.wcag.some(value => filters.wcag.includes(value));
  const abnt = filters.abnt.length === 0 || card.abntItemIds.some(value => filters.abnt.includes(value));
  return impact && wcag && abnt;
}

function viewFilterSelection(selected, value) {
  return selected.includes(value) ? selected.filter(entry => entry !== value) : [...selected, value];
}

function statusText(status) {
  if (status === 'partial') return 'Avaliação concluída com limitações';
  if (status === 'cancelled') return 'Avaliação cancelada com resultado disponível';
  return 'Avaliação concluída';
}
function statusClass(status) { return status === 'complete' ? 'complete' : 'limited'; }
function formatCompletedAt(value) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return 'Instante de conclusão indisponível';
  return `Avaliado em ${new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(parsed)}`;
}
function occurrenceText(count) { return `${count} ${count === 1 ? 'ocorrência' : 'ocorrências'}`; }
function filterHeading(dimension) {
  if (dimension === 'impact') return 'Distribuição por impacto';
  if (dimension === 'wcag') return 'Distribuição por WCAG';
  return 'Distribuição por ABNT';
}
function filterLabel(dimension, value) { return dimension === 'impact' ? impactLabel(value) : value; }
function impactLabel(value) {
  return ({ critical: 'Crítico', serious: 'Sério', moderate: 'Moderado', minor: 'Menor' })[value] ?? value;
}
function groupHeading(name) {
  return ({ failed: 'Falhas confirmadas', alerts: 'Alertas', humanReview: 'Revisão humana', passed: 'Resultados positivos' })[name];
}
function classificationLabel(value) {
  return ({ failed: 'Falha confirmada', alert: 'Alerta', 'manual-review': 'Revisão humana', passed: 'Resultado positivo' })[value] ?? value;
}

function freezeRenderModel(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freezeRenderModel(child, seen);
  return Object.freeze(value);
}
