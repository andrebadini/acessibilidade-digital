import { highlightActionForOccurrence } from './highlight-action.js';
import { decodePngDataUrl } from '../core/evidence/png.js';
import { WCAG22_LEVELS } from '../core/normative/wcag22.js';

const SCREEN_NAMES = Object.freeze(['initial', 'running', 'result', 'unavailable']);
const GROUPS = Object.freeze(['failed', 'alerts', 'humanReview', 'passed']);
const FILTERS = Object.freeze(['impact', 'wcag', 'abnt']);
const CAPTURE_MODES = Object.freeze(['full-evidence', 'element-only', 'no-pixels']);
const PIXEL_CAPTURE_MODES = Object.freeze(['full-evidence', 'element-only']);
const PRIVACY_CATEGORIES = Object.freeze(['password', 'otp', 'payment', 'private-marker']);
const PRIVACY_MESSAGE = 'A página contém conteúdo potencialmente sensível. Confirme para capturar imagens visíveis.';
const LOCAL_PIXEL_NOTICE = 'A auditoria pode capturar pixels e conteúdo visível, inclusive dados pessoais. Tudo permanece neste dispositivo.';
const RUNNING_PHASES = Object.freeze([
  ['opening', 'Abrindo o site', 5, 'Abrindo e estabilizando a página'],
  ['collecting', 'Lendo a estrutura', 25, 'Lendo estrutura e acessibilidade'],
  ['testing', 'Verificando acessibilidade', 50, 'Verificando regras automáticas'],
  ['evidence', 'Preparando evidências', 72, 'Coletando evidências'],
  ['reporting', 'Gerando relatório', 92, 'Preparando o resultado'],
]);
const COVERAGE_DISCLAIMER = 'Percentual da execução automática concluída. Não é nota, certificação ou declaração de conformidade.';
const WCAG_LEVEL_ORDER = Object.freeze(['A', 'AA', 'AAA']);
const ENTRY_ERRORS = Object.freeze({
  required: 'Informe uma URL para continuar.',
  invalid: 'Informe um endereço completo começando por http:// ou https://.',
  'too-long': 'A URL é longa demais. Use um endereço com até 2.048 caracteres.',
  'start-failed': 'Não foi possível iniciar a avaliação desta URL. Tente novamente.',
});
const BATCH_ENTRY_ERRORS = Object.freeze({
  required: 'Informe de 2 a 20 URLs para continuar.',
  'too-few': 'Informe pelo menos 2 URLs válidas e diferentes.',
  'too-many': 'Informe no máximo 20 URLs por avaliação.',
  'invalid-lines': 'Corrija as linhas indicadas antes de avaliar.',
  'start-failed': 'Não foi possível iniciar a avaliação do lote. Tente novamente.',
});
const BATCH_LINE_ERRORS = Object.freeze({
  invalid: 'endereço HTTP/HTTPS inválido',
  'too-long': 'endereço com mais de 2.048 caracteres',
});
const DUPLICATE_URL_MESSAGE = 'A URL repete uma entrada anterior e não será auditada novamente.';
const MAX_BATCH_LINE_NUMBER = 65_536;

export function buildPanelView({ state, summary = null, detail = null } = {}) {
  const screen = dataProperty(state, 'screen');
  if (!state || !SCREEN_NAMES.includes(screen)) throw new TypeError('PANEL_VIEW_STATE_INVALID');
  const captureModeValue = dataProperty(state, 'captureMode');
  const captureMode = CAPTURE_MODES.includes(captureModeValue) ? captureModeValue : 'full-evidence';
  const sessionStatusValue = dataProperty(state, 'sessionStatus');
  const sessionStatus = sessionStatusValue === 'privacy-paused' ? 'privacy-paused' : null;
  const privacy = copyPrivacyProjection(dataProperty(state, 'privacy'));
  if (sessionStatus === 'privacy-paused' &&
    (screen !== 'running' || !PIXEL_CAPTURE_MODES.includes(captureMode) || !privacy || privacy.mode !== captureMode)) {
    throw new TypeError('PANEL_VIEW_PRIVACY_INVALID');
  }
  const entryModeValue = dataProperty(state, 'entryMode');
  const entryMode = ['single-url', 'batch'].includes(entryModeValue) ? entryModeValue : 'sources';
  const auditSourceValue = dataProperty(state, 'auditSource');
  const auditSource = ['attached', 'single-url', 'batch'].includes(auditSourceValue) ? auditSourceValue : null;
  const batch = copyBatchProjection(dataProperty(state, 'batch'));
  const base = {
    version: 1,
    screen,
    auditId: typeof state.auditId === 'string' ? state.auditId : null,
    entryMode,
    entryError: copyEntryError(entryMode, dataProperty(state, 'entryError')),
    auditSource,
    captureMode,
    sessionStatus,
    privacy: sessionStatus === 'privacy-paused' ? privacy : neutralPrivacyProjection(),
    progress: copyProgress(dataProperty(state, 'progress'), auditSource, batch),
    batch,
    filters: copyFilters(state.filters),
    selectedOccurrenceId: typeof state.selectedOccurrenceId === 'string' ? state.selectedOccurrenceId : null,
    evidenceExpanded: state.evidenceExpanded === true,
    persona: copyPersona(state.persona),
    highlight: copyHighlight(state.highlight),
    focusId: typeof state.focusId === 'string' ? state.focusId : null,
    scrollTop: Number.isSafeInteger(state.scrollTop) && state.scrollTop >= 0 ? state.scrollTop : 0,
    reason: typeof state.reason === 'string' ? state.reason : null,
  };
  if (screen !== 'result') return freezeRenderModel(base);
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
      case 'START_URL':
      case 'START_BATCH':
      case 'CONFIRM_PIXEL_CAPTURE':
      case 'OPEN_URL_FORM':
      case 'CLOSE_URL_FORM':
      case 'CLOSE_BATCH_FORM':
      case 'OPEN_BATCH_FORM':
      case 'CANCEL_AUDIT':
      case 'OPEN_REPORT':
      case 'SELECT_OCCURRENCE':
      case 'CONSULT_EVIDENCE':
      case 'HIGHLIGHT_OCCURRENCE':
      case 'CLEAR_HIGHLIGHT':
      case 'PERSONA_SELECT':
      case 'PERSONA_READER_PREVIOUS':
      case 'PERSONA_READER_REPEAT':
      case 'PERSONA_READER_TOGGLE':
      case 'PERSONA_READER_NEXT':
      case 'PERSONA_READER_ENABLE_VOICE':
      case 'PERSONA_END':
      case 'RETRY':
        onIntent(freezeRenderModel({ ...intent }));
        return;
      default:
        throw new TypeError('PANEL_UI_INTENT_INVALID');
    }
  };

  switch (view.screen) {
    case 'initial': return appendPersonaControls(renderInitial(document, view, emitIntent, onEvent), document, view.persona, emitIntent);
    case 'running': {
      const running = renderRunning(document, view, emitIntent);
      return view.sessionStatus === 'privacy-paused'
        ? running
        : appendPersonaControls(running, document, view.persona, emitIntent);
    }
    case 'result': return appendPersonaControls(renderResult(document, view, emitIntent, onEvent), document, view.persona, emitIntent);
    case 'unavailable': return appendPersonaControls(renderUnavailable(document, view, emitIntent), document, view.persona, emitIntent);
    default: throw new TypeError('PANEL_SCREEN_INVALID');
  }
}

export function renderPanelReconnectView({ document } = {}) {
  if (typeof document?.createElement !== 'function') throw new TypeError('PANEL_RECONNECT_INPUT_INVALID');
  const root = section(document, 'panel-screen panel-reconnecting');
  root.dataset.screen = 'reconnecting';
  root.append(
    paragraph(document, 'Página alterada', 'status-label status-running'),
    heading(document, 2, 'Reconectando o painel'),
    paragraph(document, 'A página mudou. O resultado local está sendo recuperado com segurança.', 'supporting-copy'),
    liveRegion(document, 'Reconectando o painel à página atual.'),
  );
  return root;
}

export function renderPanelPreparingView({ document } = {}) {
  if (typeof document?.createElement !== 'function') throw new TypeError('PANEL_PREPARING_INPUT_INVALID');
  const root = section(document, 'panel-screen panel-connecting');
  root.dataset.screen = 'connecting';
  root.append(
    paragraph(document, 'Conexão local', 'status-label status-running'),
    heading(document, 2, 'Preparando o painel'),
    paragraph(document, 'A conexão local está sendo preparada com segurança.', 'supporting-copy'),
    liveRegion(document, 'Preparando o painel.'),
  );
  return root;
}

export function renderPanelStaticUnavailableView({ document } = {}) {
  if (typeof document?.createElement !== 'function') throw new TypeError('PANEL_STATIC_UNAVAILABLE_INPUT_INVALID');
  const root = section(document, 'panel-screen panel-unavailable');
  root.dataset.screen = 'unavailable';
  root.append(
    paragraph(document, 'Painel indisponível', 'status-label status-unavailable'),
    heading(document, 2, 'Não foi possível preparar o painel'),
    paragraph(document, 'Abra novamente pelo botão da extensão.', 'supporting-copy'),
    liveRegion(document, 'Painel indisponível. Abra novamente pelo botão da extensão.'),
  );
  return root;
}

function renderInitial(document, view, emit, onEvent) {
  const root = section(document, 'panel-screen panel-initial');
  root.dataset.screen = 'initial';
  root.append(
    heading(document, 2, 'Avaliar acessibilidade'),
    paragraph(document, 'A auditoria acontece localmente nesta página e não envia o conteúdo para serviços externos.', 'lead'),
  );
  root.append(paragraph(
    document,
    view.entryMode === 'batch' && view.captureMode === 'no-pixels'
      ? 'O lote é avaliado sem capturar imagens. Tudo permanece neste dispositivo.'
      : LOCAL_PIXEL_NOTICE,
    'privacy-local-copy',
  ));
  if (view.entryMode === 'single-url') {
    root.append(renderSingleUrlEntry(document, view, emit, onEvent));
    return root;
  }
  if (view.entryMode === 'batch') {
    root.append(renderBatchEntry(document, view, emit, onEvent));
    return root;
  }
  root.append(renderCaptureModeChoices(document, view.captureMode, onEvent));
  const choices = section(document, 'source-choices');
  choices.setAttribute('aria-label', 'Escolher origem da auditoria');
  choices.append(
    actionButton(document, 'Auditar a página atual', 'START_ATTACHED', 'start-attached', emit, 'primary-action'),
    actionButton(document, 'Outra URL', 'OPEN_URL_FORM', 'open-url-form', emit, 'secondary-action'),
    actionButton(document, 'Lote de páginas', 'OPEN_BATCH_FORM', 'open-batch-form', emit, 'secondary-action'),
  );
  root.append(choices, liveRegion(document, 'Escolha como iniciar a auditoria.'));
  return root;
}

function renderBatchEntry(document, view, emit, onEvent) {
  const wrapper = section(document, 'batch-url-entry');
  const form = document.createElement('form');
  form.setAttribute('id', 'batch-audit-form');
  form.setAttribute('novalidate', '');
  const label = document.createElement('label');
  label.setAttribute('for', 'audit-urls');
  label.textContent = 'Endereços das páginas';
  const instructions = paragraph(
    document,
    'Informe de 2 a 20 URLs HTTP/HTTPS, uma por linha. A extensão avalia somente esta lista e não segue links.',
    'batch-instructions',
  );
  instructions.setAttribute('id', 'audit-urls-instructions');
  const textarea = document.createElement('textarea');
  textarea.setAttribute('id', 'audit-urls');
  textarea.setAttribute('name', 'batch-urls');
  textarea.setAttribute('rows', '7');
  textarea.setAttribute('required', '');
  textarea.setAttribute('maxlength', '40979');
  textarea.setAttribute('aria-describedby', view.entryError === null
    ? 'audit-urls-instructions' : 'audit-urls-instructions audit-urls-error');
  textarea.dataset.focusId = 'audit-urls';
  textarea.addEventListener('input', () => {
    onEvent({ type: 'BATCH_DRAFT_CHANGED', urls: typeof textarea.value === 'string' ? textarea.value : '' });
  });
  if (view.entryError !== null) textarea.setAttribute('aria-invalid', 'true');
  form.append(label, instructions, textarea);
  if (view.entryError !== null) {
    const error = section(document, 'field-error batch-entry-error');
    error.setAttribute('id', 'audit-urls-error');
    error.append(paragraph(document, BATCH_ENTRY_ERRORS[view.entryError]));
    if (view.batch.errors.length > 0) {
      const list = document.createElement('ul');
      for (const issue of view.batch.errors) {
        const item = document.createElement('li');
        item.textContent = `Linha ${issue.line}: ${BATCH_LINE_ERRORS[issue.code]}.`;
        list.append(item);
      }
      error.append(list);
    }
    form.append(error);
  }
  form.append(renderCaptureModeChoices(document, view.captureMode, onEvent));
  const actions = section(document, 'form-actions');
  const submit = document.createElement('button');
  submit.setAttribute('type', 'submit');
  submit.className = 'primary-action';
  submit.dataset.intent = 'START_BATCH';
  submit.dataset.action = 'start-batch-audit';
  submit.dataset.focusId = 'start-batch-audit';
  submit.textContent = 'Avaliar páginas';
  actions.append(submit, actionButton(document, 'Voltar', 'CLOSE_BATCH_FORM', 'close-batch-form', emit, 'secondary-action'));
  form.append(actions);
  form.addEventListener('submit', event => {
    event.preventDefault();
    emit({ type: 'START_BATCH', urls: typeof textarea.value === 'string' ? textarea.value : '' });
  });
  wrapper.append(form, liveRegion(document, 'Informe uma URL por linha e escolha como coletar as evidências.'));
  return wrapper;
}

function renderSingleUrlEntry(document, view, emit, onEvent) {
  const wrapper = section(document, 'single-url-entry');
  const form = document.createElement('form');
  form.setAttribute('id', 'audit-form');
  form.setAttribute('novalidate', '');
  const label = document.createElement('label');
  label.setAttribute('for', 'audit-url');
  label.textContent = 'Endereço da página';
  const input = document.createElement('input');
  input.setAttribute('id', 'audit-url');
  input.setAttribute('name', 'audit-url');
  input.setAttribute('type', 'url');
  input.setAttribute('inputmode', 'url');
  input.setAttribute('autocomplete', 'url');
  input.setAttribute('required', '');
  input.setAttribute('maxlength', '2048');
  input.dataset.focusId = 'audit-url';
  if (view.entryError !== null) {
    input.setAttribute('aria-invalid', 'true');
    input.setAttribute('aria-describedby', 'audit-url-error');
  }
  form.append(label, input);
  if (view.entryError !== null) {
    const error = paragraph(document, ENTRY_ERRORS[view.entryError], 'field-error');
    error.setAttribute('id', 'audit-url-error');
    form.append(error);
  }
  form.append(renderCaptureModeChoices(document, view.captureMode, onEvent));
  const actions = section(document, 'form-actions');
  const submit = document.createElement('button');
  submit.setAttribute('type', 'submit');
  submit.className = 'primary-action';
  submit.dataset.intent = 'START_URL';
  submit.dataset.action = 'start-url-audit';
  submit.dataset.focusId = 'start-url-audit';
  submit.textContent = 'Avaliar acessibilidade';
  actions.append(submit, actionButton(document, 'Voltar', 'CLOSE_URL_FORM', 'close-url-form', emit, 'secondary-action'));
  form.append(actions);
  form.addEventListener('submit', event => {
    event.preventDefault();
    emit({ type: 'START_URL', url: typeof input.value === 'string' ? input.value : '' });
  });
  wrapper.append(
    form,
    liveRegion(document, 'Informe a URL e escolha como coletar as evidências.'),
  );
  return wrapper;
}

function renderCaptureModeChoices(document, selectedMode, onEvent) {
  const fieldset = document.createElement('fieldset');
  fieldset.className = 'capture-mode-fieldset';
  const legend = document.createElement('legend');
  legend.textContent = 'Modo de evidência';
  const explanation = paragraph(
    document,
    'Escolha quanta evidência visual pode ser coletada. Você poderá confirmar antes de qualquer captura sensível.',
    'capture-mode-intro',
  );
  const options = document.createElement('div');
  options.className = 'capture-mode-options';
  const definitions = [
    ['full-evidence', 'Evidência completa', 'Captura a página e os elementos quando isso for necessário para documentar a auditoria.'],
    ['element-only', 'Somente elementos', 'Captura apenas os elementos relacionados às ocorrências encontradas.'],
    ['no-pixels', 'Sem imagens', 'Executa a auditoria sem capturar pixels. É a opção mais reservada.'],
  ];
  for (const [mode, labelText, description] of definitions) {
    const option = document.createElement('label');
    option.className = 'capture-mode-option';
    option.dataset.captureOption = mode;
    const input = document.createElement('input');
    const inputId = `capture-mode-${mode}`;
    const descriptionId = `${inputId}-description`;
    input.setAttribute('type', 'radio');
    input.setAttribute('name', 'capture-mode');
    input.setAttribute('id', inputId);
    input.setAttribute('value', mode);
    input.setAttribute('aria-describedby', descriptionId);
    input.dataset.captureMode = mode;
    input.dataset.focusId = inputId;
    input.checked = selectedMode === mode;
    input.addEventListener('change', event => {
      onEvent({ type: 'CAPTURE_MODE_SELECTED', mode, focusId: event.currentTarget.dataset.focusId });
    });
    const copy = document.createElement('div');
    copy.className = 'capture-mode-copy';
    const label = document.createElement('span');
    label.className = 'capture-mode-label';
    label.textContent = labelText;
    const detail = document.createElement('span');
    detail.className = 'capture-mode-description';
    detail.textContent = description;
    detail.setAttribute('id', descriptionId);
    copy.append(label, detail);
    option.setAttribute('for', inputId);
    option.append(input, copy);
    options.append(option);
  }
  fieldset.append(legend, explanation, options);
  return fieldset;
}

function renderRunning(document, view, emit) {
  const root = section(document, 'panel-screen panel-running');
  root.dataset.screen = 'running';
  if (view.sessionStatus === 'privacy-paused') return renderPrivacyPause(root, document, view, emit);
  const started = view.auditId !== null;
  const isBatch = view.auditSource === 'batch';
  const current = view.progress.percent === null ? null : view.progress;
  if (isBatch) return renderBatchRunning(root, document, view, emit, started, current);
  const currentPhase = current ? RUNNING_PHASES.find(([phase]) => phase === current.phase) : null;
  const currentLabel = currentPhase?.[3] ?? current?.message;
  const status = !started
    ? 'Iniciando avaliação. Aguardando confirmação da auditoria.'
    : current ? `Etapa atual: ${currentLabel}. ${current.percent}% concluído.`
      : 'Auditoria em andamento. Aguardando a primeira atualização confirmada.';
  root.append(
    paragraph(document, started ? 'Auditoria em andamento' : 'Iniciando avaliação', 'status-label status-running'),
    heading(document, 2, 'Avaliando a página atual'),
    paragraph(document, status, 'supporting-copy'),
  );
  const progress = document.createElement('progress');
  progress.className = 'audit-progress';
  progress.dataset.auditProgress = '';
  progress.setAttribute('aria-label', current ? `Progresso da auditoria: ${current.percent}%` : 'Progresso da auditoria em andamento');
  if (current) {
    progress.setAttribute('value', String(current.percent));
    progress.setAttribute('max', '100');
  }
  const phases = renderRunningPhases(document, current);
  root.append(
    progress,
    phases,
    actionButton(document, 'Cancelar auditoria', 'CANCEL_AUDIT', 'cancel-audit', emit, 'danger-action'),
    liveRegion(document, status),
  );
  return root;
}

function renderRunningPhases(document, current) {
  const phases = document.createElement('ol');
  phases.className = 'phase-list';
  phases.dataset.runningPhases = '';
  phases.setAttribute('aria-label', 'Etapas da auditoria');
  for (const [index, [_phase, _message, percent, label]] of RUNNING_PHASES.entries()) {
    const item = document.createElement('li');
    const nextPercent = RUNNING_PHASES[index + 1]?.[2] ?? 100;
    const phaseState = !current || current.percent < percent ? 'pending'
      : current.percent >= nextPercent ? 'complete' : 'current';
    item.dataset.phaseState = phaseState;
    if (phaseState === 'current') item.setAttribute('aria-current', 'step');
    const indicator = document.createElement('span');
    indicator.className = `phase-indicator phase-indicator-${phaseState}`;
    indicator.dataset.phaseIndicator = phaseState;
    indicator.setAttribute('aria-hidden', 'true');
    indicator.textContent = phaseState === 'complete' ? '✓' : phaseState === 'current' ? '●' : '○';
    const phaseLabel = document.createElement('span');
    phaseLabel.textContent = phaseState === 'complete' ? `${label} — concluída`
      : phaseState === 'current' ? `${label} — em andamento` : label;
    item.append(indicator, phaseLabel);
    phases.append(item);
  }
  return phases;
}

function renderBatchRunning(root, document, view, emit, started, current) {
  const page = view.batch.pageNumber;
  const total = view.batch.total;
  if (Number.isSafeInteger(page) && page > 0 && Number.isSafeInteger(total)) {
    root.dataset.pageNumber = String(page);
    root.dataset.total = String(total);
  }
  const status = !started
    ? 'Iniciando avaliação do lote.'
    : current && page > 0 ? `${current.message} ${current.percent}% concluído.`
      : Number.isSafeInteger(total) ? `Lote preparado com ${total} páginas. Aguardando a primeira atualização.`
        : 'Avaliação do lote em andamento.';
  const statusCopy = paragraph(document, status, 'supporting-copy batch-progress-copy');
  if (Number.isSafeInteger(page) && page > 0 && Number.isSafeInteger(total)) {
    statusCopy.dataset.pageNumber = String(page);
    statusCopy.dataset.total = String(total);
  }
  root.append(
    paragraph(document, started ? 'Auditoria em andamento' : 'Iniciando avaliação', 'status-label status-running'),
    heading(document, 2, 'Avaliando lote'),
    statusCopy,
  );
  const progress = document.createElement('progress');
  progress.className = 'audit-progress';
  progress.dataset.auditProgress = '';
  progress.setAttribute('aria-label', current
    ? `Progresso do lote: ${current.percent}%` : 'Progresso do lote em andamento');
  if (current) {
    progress.setAttribute('value', String(current.percent));
    progress.setAttribute('max', '100');
  }
  // Remove floating-point drift when reversing the batch's weighted percentage.
  const pageProgress = current && Number.isSafeInteger(page) && page > 0 && Number.isSafeInteger(total)
    ? { percent: Math.max(0, Math.min(100, Number((current.percent * total - (page - 1) * 100).toFixed(8)))) }
    : null;
  root.append(progress, renderRunningPhases(document, pageProgress));
  if (view.batch.warnings.length > 0) {
    const warnings = section(document, 'batch-warnings');
    warnings.append(heading(document, 3, 'Avisos da lista'));
    const list = document.createElement('ul');
    for (const warning of view.batch.warnings) {
      const item = document.createElement('li');
      const prior = warning.firstLine === null ? '' : ` (repete a linha ${warning.firstLine})`;
      item.textContent = `Linha ${warning.line}${prior}: ${warning.message}`;
      list.append(item);
    }
    warnings.append(list);
    root.append(warnings);
  }
  root.append(
    actionButton(document, 'Cancelar auditoria', 'CANCEL_AUDIT', 'cancel-audit', emit, 'danger-action'),
    liveRegion(document, status),
  );
  return root;
}

function renderPrivacyPause(root, document, view, emit) {
  root.className += ' privacy-pause';
  root.dataset.sessionStatus = 'privacy-paused';
  if (view.auditSource === 'batch' && Number.isSafeInteger(view.batch.pageNumber) && view.batch.pageNumber > 0) {
    root.dataset.pageNumber = String(view.batch.pageNumber);
    if (Number.isSafeInteger(view.batch.total)) root.dataset.total = String(view.batch.total);
  }
  root.append(
    paragraph(document, 'Auditoria pausada para sua proteção', 'status-label status-limited'),
    heading(document, 2, 'Confirme antes de capturar imagens'),
    paragraph(document, view.privacy.message, 'supporting-copy'),
    paragraph(document, LOCAL_PIXEL_NOTICE, 'privacy-local-copy'),
  );
  const safeContext = section(document, 'privacy-safe-context');
  safeContext.append(paragraph(document, `Modo: ${captureModeLabel(view.privacy.mode)}.`, 'privacy-capture-mode'));
  if (view.auditSource === 'batch' && Number.isSafeInteger(view.batch.pageNumber) && view.batch.pageNumber > 0) {
    const position = Number.isSafeInteger(view.batch.total)
      ? `Página ${view.batch.pageNumber} de ${view.batch.total}.`
      : `Página ${view.batch.pageNumber} pausada.`;
    safeContext.append(paragraph(document, position, 'privacy-page-position'));
  }
  root.append(safeContext);
  const signals = section(document, 'privacy-signals');
  signals.append(heading(document, 3, 'Conteúdo sensível identificado'));
  const list = document.createElement('ul');
  for (const category of view.privacy.categories) {
    const item = document.createElement('li');
    item.textContent = privacyCategoryLabel(category);
    list.append(item);
  }
  signals.append(list);
  const actions = section(document, 'privacy-actions');
  const confirm = actionButton(
    document,
    view.privacy.confirmationPending ? 'Confirmação enviada' : 'Continuar e capturar',
    'CONFIRM_PIXEL_CAPTURE',
    'confirm-pixel-capture',
    emit,
    'primary-action',
    { mode: view.privacy.mode, accepted: true },
    view.privacy.confirmationPending,
  );
  confirm.dataset.action = 'confirm-pixel-capture';
  actions.append(
    confirm,
    actionButton(document, 'Cancelar auditoria', 'CANCEL_AUDIT', 'cancel-audit', emit, 'danger-action'),
  );
  root.append(
    signals,
    actions,
    liveRegion(document, view.privacy.confirmationPending
      ? 'Confirmação enviada. Aguardando retomada segura da auditoria.'
      : 'Auditoria pausada. Confirme a captura de imagens ou cancele a auditoria.'),
  );
  return root;
}

function captureModeLabel(mode) {
  if (mode === 'full-evidence') return 'Evidência completa';
  if (mode === 'element-only') return 'Somente elementos';
  return 'Sem imagens';
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
  const coverageHeading = heading(document, 2, 'Cobertura automática');
  coverageHeading.dataset.focusId = 'result-summary';
  coverageHeading.setAttribute('tabindex', '-1');
  coverage.append(coverageHeading);
  if (summary.coverage.status === 'available') {
    const progress = document.createElement('progress');
    progress.className = 'coverage-progress';
    progress.setAttribute('value', String(summary.coverage.numerator));
    progress.setAttribute('max', String(summary.coverage.denominator));
    progress.setAttribute('aria-label', `Cobertura automática: ${summary.coverage.percent}`);
    coverage.append(
      paragraph(document, summary.coverage.percent, 'coverage-value'),
      paragraph(document, `${summary.coverage.numerator} de ${summary.coverage.denominator} testes aplicáveis`, 'coverage-ratio'),
      progress,
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
    groups.append(renderGroup(document, name, result.groups[name], view, emit, onEvent, result.detail));
  }
  root.append(groups);

  const activeOccurrenceId = view.highlight.state === 'active' ||
    (view.highlight.state === 'busy' && view.highlight.operation === 'clear')
    ? view.highlight.occurrenceId : null;
  const selectedDetailIsVisible = activeOccurrenceId !== null && result.detail?.occurrenceId === activeOccurrenceId &&
    GROUPS.some(name => result.groups[name].some(card => card.occurrenceIds.includes(activeOccurrenceId)));
  if (activeOccurrenceId !== null && !selectedDetailIsVisible) {
    root.append(renderGlobalHighlightClear(document, view.highlight, emit));
  }

  const footer = section(document, 'result-footer');
  footer.append(actionButton(document, 'Abrir relatório completo', 'OPEN_REPORT', 'open-report', emit, 'secondary-action report-action'));
  root.append(footer, liveRegion(document, view.highlight.message ??
    (view.evidenceExpanded && result.detail ? result.detail.action.reason : 'Resultado da auditoria carregado.')));
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
  const all = document.createElement('button');
  all.setAttribute('type', 'button');
  all.className = 'filter-chip filter-all';
  all.dataset.filterDimension = dimension;
  all.dataset.filterControl = 'all';
  all.dataset.focusId = `filter-${dimension}-all`;
  all.setAttribute('aria-pressed', String(selected.length === 0));
  all.setAttribute('aria-label', `${filterHeading(dimension)}: mostrar todos`);
  all.textContent = 'Todos';
  all.addEventListener('click', event => {
    const filter = event.currentTarget.dataset.filterDimension;
    const focusId = event.currentTarget.dataset.focusId;
    if (!FILTERS.includes(filter) || typeof focusId !== 'string') return;
    onEvent(freezeRenderModel({ type: 'FILTER_SET', filter, values: [], focusId }));
  });
  buttons.append(all);
  for (const [index, row] of rows.entries()) {
    const button = document.createElement('button');
    button.setAttribute('type', 'button');
    button.className = 'filter-chip';
    button.dataset.filterDimension = dimension;
    button.dataset.filterValue = row.id;
    button.dataset.focusId = `filter-${dimension}-${index}`;
    button.setAttribute('aria-pressed', String(selected.includes(row.id)));
    button.setAttribute('aria-label', `${filterHeading(dimension)}: ${filterLabel(dimension, row.id)}, ${row.count}`);
    button.textContent = `${filterLabel(dimension, row.id)} ${row.count}`;
    button.addEventListener('click', event => {
      const filter = event.currentTarget.dataset.filterDimension;
      const value = event.currentTarget.dataset.filterValue;
      const focusId = event.currentTarget.dataset.focusId;
      if (!FILTERS.includes(filter) || typeof value !== 'string' || typeof focusId !== 'string') return;
      const current = viewFilterSelection(selected, value);
      onEvent(freezeRenderModel({ type: 'FILTER_SET', filter, values: current, focusId }));
    });
    buttons.append(button);
  }
  wrapper.append(buttons);
  return wrapper;
}

function renderGroup(document, name, cards, view, emit, onEvent, detail) {
  const wrapper = section(document, `result-group group-${name}`);
  wrapper.append(heading(document, 3, groupHeading(name)));
  if (cards.length === 0) {
    wrapper.append(paragraph(document, 'Nenhum resultado neste grupo com os filtros atuais.', 'empty-group'));
    return wrapper;
  }
  for (const card of cards) {
    wrapper.append(renderCard(document, card, view, emit));
    if (detail && card.occurrenceIds.includes(detail.occurrenceId)) {
      wrapper.append(renderDetail(document, detail, view.evidenceExpanded, view.highlight, emit, onEvent, view.captureMode));
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
  if (card.occurrenceIds.length === 1) {
    const occurrenceId = card.occurrenceIds[0];
    const selected = view.selectedOccurrenceId === occurrenceId;
    const button = actionButton(document, card.title, 'SELECT_OCCURRENCE', `occurrence-${occurrenceId}`, emit, 'card-select', { occurrenceId });
    button.setAttribute('aria-pressed', String(selected));
    root.append(button);
  } else if (card.occurrenceIds.length > 1) {
    root.append(heading(document, 4, card.title));
    const occurrences = section(document, 'occurrence-options');
    occurrences.setAttribute('role', 'group');
    occurrences.setAttribute('aria-label', `Ocorrências de ${card.title}`);
    for (const [index, occurrenceId] of card.occurrenceIds.entries()) {
      const selected = view.selectedOccurrenceId === occurrenceId;
      const button = actionButton(
        document, `Ocorrência ${index + 1} de ${card.occurrenceIds.length}`,
        'SELECT_OCCURRENCE', `occurrence-${occurrenceId}`, emit, 'occurrence-select', { occurrenceId },
      );
      button.setAttribute('aria-pressed', String(selected));
      occurrences.append(button);
    }
    root.append(occurrences);
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

function renderDetail(document, detail, expanded, highlight, emit, onEvent, captureMode) {
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
    previewBlock(document, detail.previews, expanded, onEvent, captureMode),
    technicalBlock(document, detail.technical, expanded, onEvent),
  );
  const actions = section(document, 'detail-actions');
  const action = highlightActionForOccurrence({
    occurrence: detail,
    bindingStatus: highlight.bindingStatus,
    activeOccurrenceId: highlight.state === 'active' ||
      (highlight.state === 'busy' && highlight.operation === 'clear') ? highlight.occurrenceId : null,
  });
  if (action.kind === 'highlight') {
    const busy = highlight.state === 'busy' && highlight.operation === 'highlight' &&
      highlight.occurrenceId === detail.occurrenceId;
    const button = actionButton(document, busy ? 'Destacando na página' : action.label,
      'HIGHLIGHT_OCCURRENCE', 'live-highlight-action', emit, 'primary-action', {
        occurrenceId: detail.occurrenceId,
      }, busy);
    button.dataset.action = 'highlight-occurrence';
    actions.append(button);
  } else if (action.kind === 'clear') {
    const busy = highlight.state === 'busy' && highlight.operation === 'clear';
    const button = actionButton(document, busy ? 'Removendo destaque' : action.label,
      'CLEAR_HIGHLIGHT', 'live-highlight-action', emit, 'secondary-action', {}, busy);
    button.dataset.action = 'clear-highlight';
    actions.append(button);
  } else if (action.kind === 'checking') {
    const button = document.createElement('button');
    button.setAttribute('type', 'button');
    button.className = 'secondary-action';
    button.dataset.focusId = 'live-highlight-action';
    button.dataset.action = 'highlight-checking';
    button.disabled = false;
    button.setAttribute('aria-disabled', 'true');
    button.textContent = action.label;
    actions.append(button);
  } else {
    const button = actionButton(document, action.label, 'CONSULT_EVIDENCE', 'consult-evidence', emit, 'secondary-action', {
      occurrenceId: detail.occurrenceId,
      reason: action.reason,
    });
    button.dataset.action = 'consult-evidence';
    actions.append(button);
  }
  root.append(actions);
  return root;
}

function renderGlobalHighlightClear(document, highlight, emit) {
  const block = section(document, 'global-highlight-action');
  block.setAttribute('role', 'region');
  block.setAttribute('aria-label', 'Destaque ativo na página');
  block.append(paragraph(document,
    'Há um destaque ativo em outra ocorrência ou em um resultado oculto pelos filtros.',
    'global-highlight-message'));
  const busy = highlight.state === 'busy' && highlight.operation === 'clear';
  const button = actionButton(document, busy ? 'Removendo destaque' : 'Limpar destaque ativo',
    'CLEAR_HIGHLIGHT', 'live-highlight-action', emit, 'secondary-action', {}, busy);
  button.dataset.action = 'clear-highlight';
  button.dataset.globalHighlightClear = '';
  block.append(button);
  return block;
}

function detailBlock(document, name, title, values) {
  const block = section(document, `detail-block detail-${name}`);
  block.dataset.detailBlock = name;
  block.append(heading(document, name === 'heading' ? 3 : 4, title));
  for (const value of values) if (typeof value === 'string' && value) block.append(paragraph(document, value));
  return block;
}

function previewBlock(document, previews, expanded, onEvent, captureMode) {
  const block = document.createElement('details');
  block.className = 'detail-block detail-previews';
  block.dataset.detailBlock = 'previews';
  block.open = expanded;
  const summary = document.createElement('summary');
  summary.dataset.focusId = 'evidence-summary';
  summary.textContent = 'Evidências';
  block.append(summary);
  bindDisclosure(block, expanded, 'evidence-summary', onEvent);
  if (previews.length === 0) block.append(paragraph(document, 'Nenhuma prévia visual foi armazenada.'));
  if (captureMode === 'no-pixels' && previews.length > 0 && previews.every(preview => preview.dataUrl === '')) {
    block.append(paragraph(document,
      'Nenhuma captura raster foi coletada no modo sem imagens. As evidências estruturais permanecem disponíveis.'));
  }
  for (const preview of previews) {
    const item = section(document, 'evidence-preview');
    const imageMetadata = safePngPreview(preview.dataUrl);
    if (imageMetadata) {
      const image = document.createElement('img');
      image.className = 'evidence-preview-image';
      image.dataset.evidencePreviewImage = '';
      image.setAttribute('src', preview.dataUrl);
      image.setAttribute('alt', `${previewKindLabel(preview.kind)} local da evidência ${preview.evidenceId}`);
      image.setAttribute('width', String(imageMetadata.width));
      image.setAttribute('height', String(imageMetadata.height));
      image.setAttribute('loading', 'lazy');
      image.setAttribute('decoding', 'async');
      item.append(image);
    } else if (preview.dataUrl === null) {
      item.append(paragraph(document, 'Prévia omitida no painel para manter o resultado leve. A captura integral permanece disponível no relatório.'));
    }
    item.append(
      paragraph(document, preview.kind ? `Tipo: ${preview.kind}` : 'Evidência local'),
      paragraph(document, preview.origin ? `Origem: ${preview.origin}` : 'Origem não informada'),
    );
    block.append(item);
  }
  return block;
}

function safePngPreview(value) {
  try {
    const metadata = decodePngDataUrl(value, { maxBytes: 16 * 1024 * 1024, maxDimension: 50_000, maxPixels: 100_000_000 });
    return { width: metadata.width, height: metadata.height };
  } catch { return null; }
}

function previewKindLabel(kind) {
  if (kind === 'element') return 'Captura do elemento';
  if (kind === 'full-page') return 'Captura da página inteira';
  return 'Captura de evidência';
}

function technicalBlock(document, technical, expanded, onEvent) {
  const block = document.createElement('details');
  block.className = 'detail-block detail-technical';
  block.dataset.detailBlock = 'technical';
  block.open = expanded;
  const summary = document.createElement('summary');
  summary.dataset.focusId = 'technical-summary';
  summary.textContent = 'Evidências técnicas';
  block.append(summary);
  bindDisclosure(block, expanded, 'technical-summary', onEvent);
  block.append(
    paragraph(document, `Mecanismo: ${technical.engine} ${technical.version}`),
    paragraph(document, `Regra: ${technical.ruleId}`),
  );
  if (technical.selector) block.append(labeledCode(document, 'Seletor sanitizado', technical.selector));
  if (technical.snippet) block.append(labeledCode(document, 'Trecho sanitizado', technical.snippet));
  return block;
}

function bindDisclosure(block, expanded, focusId, onEvent) {
  block.addEventListener('toggle', event => {
    if (event.currentTarget.open === expanded) return;
    onEvent(freezeRenderModel({
      type: 'EVIDENCE_TOGGLED', expanded: event.currentTarget.open === true, focusId,
    }));
  });
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

function actionButton(document, label, intent, focusId, emit, className, fields = {}, disabled = false) {
  const button = document.createElement('button');
  button.setAttribute('type', 'button');
  button.className = className;
  button.dataset.intent = intent;
  button.dataset.focusId = focusId;
  button.disabled = false;
  if (disabled) button.setAttribute('aria-disabled', 'true');
  button.textContent = label;
  button.addEventListener('click', () => {
    if (button.getAttribute('aria-disabled') === 'true') return;
    emit({ type: intent, ...fields });
  });
  return button;
}

function appendPersonaControls(root, document, persona, emit) {
  const section = document.createElement('section');
  section.className = 'persona-controls';
  section.dataset.personaControls = '';
  section.setAttribute('aria-label', 'Simular experiência');
  section.append(heading(document, 2, 'Simular experiência'));
  const modes = document.createElement('div');
  modes.className = 'persona-mode-buttons';
  for (const [mode, label] of [['reader', 'Leitura simulada'], ['achromatopsia', 'Acromatopsia'], ['keyboard', 'Somente teclado']]) {
    const button = actionButton(document, label, 'PERSONA_SELECT', `persona-${mode}`, emit, 'persona-mode', { mode });
    button.dataset.personaMode = mode;
    button.setAttribute('aria-pressed', String(persona.mode === mode));
    modes.append(button);
  }
  section.append(modes, paragraph(document, persona.message, 'persona-message'));
  if (persona.mode === 'reader') {
    if (!persona.voiceId || ['unavailable', 'error'].includes(persona.speechAvailability)) {
      section.append(actionButton(
        document, 'Ativar voz local', 'PERSONA_READER_ENABLE_VOICE',
        'persona-reader-enable-voice', emit, 'secondary-action',
      ));
    }
    const transport = document.createElement('div');
    transport.className = 'persona-transport';
    for (const [intent, label] of [
      ['PERSONA_READER_PREVIOUS', 'Anterior'], ['PERSONA_READER_REPEAT', 'Repetir'],
      ['PERSONA_READER_TOGGLE', persona.readerPaused ? 'Continuar' : 'Pausar'],
      ['PERSONA_READER_NEXT', 'Próximo'], ['PERSONA_END', 'Encerrar'],
    ]) transport.append(actionButton(document, label, intent, `persona-${intent.toLowerCase()}`, emit, 'secondary-action'));
    section.append(transport);
  } else if (persona.mode !== null) {
    section.append(actionButton(
      document, 'Encerrar simulação', 'PERSONA_END', 'persona-end', emit, 'secondary-action',
    ));
  }
  root.append(section);
  return root;
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

function copyProgress(value, auditSource, batch) {
  const valid = value && typeof value === 'object' && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
  if (!valid || value.phase === null || value.message === null || value.percent === null || value.at === null) {
    return { phase: null, message: null, percent: null, at: null };
  }
  if (auditSource === 'batch' && value.phase === 'batch-page' && Number.isSafeInteger(batch.pageNumber) &&
    batch.pageNumber >= 1 && Number.isSafeInteger(batch.total) && typeof value.percent === 'number' &&
    Number.isFinite(value.percent) && value.percent >= 0 && value.percent <= 100 && canonicalIsoTime(value.at) &&
    (value.message === `Página ${batch.pageNumber} de ${batch.total}: auditoria em andamento.` ||
      value.message === `Página ${batch.pageNumber} de ${batch.total}: processamento encerrado.`)) {
    return { phase: value.phase, message: value.message, percent: value.percent, at: value.at };
  }
  return RUNNING_PHASES.some(([phase, message, percent]) =>
    value.phase === phase && value.message === message && value.percent === percent && canonicalIsoTime(value.at))
    ? { phase: value.phase, message: value.message, percent: value.percent, at: value.at }
    : { phase: null, message: null, percent: null, at: null };
}

function copyEntryError(entryMode, value) {
  if (entryMode === 'single-url' && Object.hasOwn(ENTRY_ERRORS, value)) return value;
  if (entryMode === 'batch' && Object.hasOwn(BATCH_ENTRY_ERRORS, value)) return value;
  return null;
}

function copyBatchProjection(value) {
  const batch = exactDataRecord(value, ['total', 'pageNumber', 'warnings', 'errors']);
  if (!batch) return { total: null, pageNumber: null, warnings: [], errors: [] };
  const warnings = copyBatchWarnings(batch.warnings);
  const errors = copyBatchErrors(batch.errors);
  if (!warnings || !errors) return { total: null, pageNumber: null, warnings: [], errors: [] };
  const empty = batch.total === null && batch.pageNumber === null;
  const paused = batch.total === null && Number.isSafeInteger(batch.pageNumber) &&
    batch.pageNumber >= 1 && batch.pageNumber <= 20 && errors.length === 0;
  const running = Number.isSafeInteger(batch.total) && batch.total >= 2 && batch.total <= 20 &&
    Number.isSafeInteger(batch.pageNumber) && batch.pageNumber >= 0 && batch.pageNumber <= batch.total;
  return empty || paused || running
    ? { total: batch.total, pageNumber: batch.pageNumber, warnings, errors }
    : { total: null, pageNumber: null, warnings: [], errors: [] };
}

function copyBatchWarnings(value) {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > 20) return null;
    const own = Reflect.ownKeys(value);
    if (own.length !== value.length + 1 || !own.includes('length')) return null;
    const warnings = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      const warning = exactDataRecord(descriptor.value, ['line', 'code', 'firstLine', 'message']);
      if (!warning || !Number.isSafeInteger(warning.line) || warning.line < 1 || warning.line > MAX_BATCH_LINE_NUMBER ||
        warning.code !== 'DUPLICATE_URL' || warning.message !== DUPLICATE_URL_MESSAGE ||
        warning.firstLine !== null && (!Number.isSafeInteger(warning.firstLine) || warning.firstLine < 1 ||
          warning.firstLine > MAX_BATCH_LINE_NUMBER || warning.firstLine >= warning.line)) return null;
      warnings.push({ ...warning });
    }
    return warnings;
  } catch { return null; }
}

function copyBatchErrors(value) {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > 20) return null;
    const own = Reflect.ownKeys(value);
    if (own.length !== value.length + 1 || !own.includes('length')) return null;
    const errors = [];
    let priorLine = 0;
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      const issue = exactDataRecord(descriptor.value, ['line', 'code']);
      if (!issue || !Number.isSafeInteger(issue.line) || issue.line <= priorLine || issue.line > MAX_BATCH_LINE_NUMBER ||
        !Object.hasOwn(BATCH_LINE_ERRORS, issue.code)) return null;
      priorLine = issue.line;
      errors.push({ ...issue });
    }
    return errors;
  } catch { return null; }
}

function canonicalIsoTime(value) {
  if (typeof value !== 'string') return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function neutralPrivacyProjection() {
  return { mode: null, categories: [], message: null, confirmationPending: false };
}

function copyPrivacyProjection(value) {
  const privacy = exactDataRecord(value, ['mode', 'categories', 'message', 'confirmationPending']);
  if (!privacy || !PIXEL_CAPTURE_MODES.includes(privacy.mode) || privacy.message !== PRIVACY_MESSAGE ||
    typeof privacy.confirmationPending !== 'boolean') return null;
  const categories = copyPrivacyCategories(privacy.categories);
  return categories
    ? { mode: privacy.mode, categories, message: PRIVACY_MESSAGE, confirmationPending: privacy.confirmationPending }
    : null;
}

function copyPrivacyCategories(value) {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
      value.length < 1 || value.length > PRIVACY_CATEGORIES.length) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== value.length + 1 || !keys.includes('length')) return null;
    const output = [];
    let previous = -1;
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      const rank = PRIVACY_CATEGORIES.indexOf(descriptor.value);
      if (rank <= previous) return null;
      previous = rank;
      output.push(descriptor.value);
    }
    return output;
  } catch { return null; }
}

function exactDataRecord(value, keys) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return null;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== keys.length || ownKeys.some(key => typeof key !== 'string' || !keys.includes(key))) return null;
    const output = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      output[key] = descriptor.value;
    }
    return output;
  } catch { return null; }
}

function dataProperty(value, key) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  } catch { return undefined; }
}

function copyPersona(value) {
  const mode = ['reader', 'achromatopsia', 'keyboard'].includes(value?.mode) ? value.mode : null;
  const speechAvailability = ['available', 'unavailable', 'busy', 'error'].includes(value?.speechAvailability)
    ? value.speechAvailability : 'unavailable';
  const voiceId = typeof value?.voiceId === 'string' && !/[\u0000-\u001F\u007F]/u.test(value.voiceId) &&
    Array.from(value.voiceId).length <= 200 ? value.voiceId : '';
  const rate = typeof value?.rate === 'number' && Number.isFinite(value.rate) && value.rate >= 0.5 && value.rate <= 2
    ? value.rate : 1;
  return {
    mode, readerPaused: value?.readerPaused === true, speechAvailability, voiceId, rate,
    message: typeof value?.message === 'string' ? value.message : 'Escolha uma simulação para esta página.',
  };
}

function copyHighlight(value) {
  let bindingStatus = { state: 'unchecked' };
  if (['available', 'checking', 'unchecked'].includes(value?.bindingStatus?.state)) {
    bindingStatus = { state: value.bindingStatus.state };
  } else if (value?.bindingStatus?.state === 'unavailable' && typeof value.bindingStatus.reason === 'string') {
    bindingStatus = { state: 'unavailable', reason: value.bindingStatus.reason };
  }
  return ['idle', 'busy', 'active'].includes(value?.state)
    ? {
      state: value.state,
      operation: value.state === 'busy' && ['highlight', 'clear'].includes(value.operation) ? value.operation : null,
      occurrenceId: typeof value.occurrenceId === 'string' ? value.occurrenceId : null,
      bindingStatus, message: typeof value.message === 'string' ? value.message : null,
    }
    : { state: 'idle', operation: null, occurrenceId: null, bindingStatus, message: null };
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
  const wcag = filters.wcag.length === 0 || wcagLevels(card.wcag).some(value => filters.wcag.includes(value));
  const abnt = filters.abnt.length === 0 || card.abntItemIds.some(value => filters.abnt.includes(value));
  return impact && wcag && abnt;
}

function wcagLevels(criteria) {
  const levels = new Set(criteria.map(criterion => WCAG22_LEVELS[criterion])
    .filter(level => WCAG_LEVEL_ORDER.includes(level)));
  return WCAG_LEVEL_ORDER.filter(level => levels.has(level));
}

function viewFilterSelection(selected, value) {
  return selected.includes(value) ? selected.filter(entry => entry !== value) : [...selected, value];
}

function statusText(status) {
  if (status === 'partial') return 'Avaliação concluída com limitações';
  if (status === 'cancelled') return 'Avaliação cancelada com resultado disponível';
  if (status === 'failed') return 'A avaliação não pôde ser concluída';
  return 'Avaliação concluída';
}
function statusClass(status) {
  if (status === 'complete') return 'complete';
  if (status === 'failed') return 'failed';
  return 'limited';
}
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

function privacyCategoryLabel(value) {
  return ({
    password: 'Campo de senha',
    otp: 'Código de uso único',
    payment: 'Dados de pagamento',
    'private-marker': 'Conteúdo marcado como privado',
  })[value];
}

function freezeRenderModel(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freezeRenderModel(child, seen);
  return Object.freeze(value);
}
