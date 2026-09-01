import {
  createPanelSessionPortClient,
  PANEL_RECONNECT_EXHAUSTED_MESSAGE,
} from './panel-session-port.js';
import { parseAuditDeletedEvent } from '../core/audit-deleted-event.js';
import {
  createHighlightStateSynchronizer,
  runHighlightAction,
  shouldApplyHighlightState,
} from './highlight-action.js';
import { PANEL_UNPREPARED_MESSAGE } from './panel-status.js';
import { isAuthorizedPanelLaunchUrl } from './panel-launch-url.js';
import {
  buildPanelView,
  renderPanelPreparingView,
  renderPanelReconnectView,
  renderPanelStaticUnavailableView,
  renderPanelView,
} from './panel-view.js';
import { createInitialPanelState, reducePanelState } from './panel-state.js';
import { createPanelPersonaSession } from './persona-session.js';

const root = document.querySelector('#panel-root');
const chromeApi = globalThis.chrome ?? null;
const OPAQUE_CAPABILITY = /^[A-Za-z0-9_-]{20,240}$/u;
const AUDIT_ID = /^[A-Za-z0-9._:-]{1,160}$/u;
const CAPTURE_MODES = Object.freeze(['full-evidence', 'element-only', 'no-pixels']);
const PIXEL_CAPTURE_MODES = Object.freeze(['full-evidence', 'element-only']);
const PRIVACY_CATEGORIES = Object.freeze(['password', 'otp', 'payment', 'private-marker']);
const PRIVACY_MESSAGE = 'A página contém conteúdo potencialmente sensível. Confirme para capturar imagens visíveis.';
const AUDIT_PROGRESS = Object.freeze([
  ['opening', 'Abrindo o site', 5],
  ['collecting', 'Lendo a estrutura', 25],
  ['testing', 'Verificando acessibilidade', 50],
  ['evidence', 'Preparando evidências', 72],
  ['reporting', 'Gerando relatório', 92],
]);
let state = createInitialPanelState();
let resultBundle = null;
let requestSequence = 0;
let urlEntryRevision = 0n;
let personaBootstrapSynchronized = false;
let hasReceivedBootstrap = false;
const personaSession = createPanelPersonaSession({
  requestIntent: requestPanelIntent,
  createRequestId: nextRequestId,
  onEvent: transition,
});
const highlightStateSynchronizer = createHighlightStateSynchronizer({
  requestCurrent: () => requestPanelIntent({ type: 'GET_HIGHLIGHT_STATE' }),
  applyState: applyHighlightState,
});
const privacyConfirmation = createPanelPrivacyConfirmationController({
  readState: () => state,
  transition,
  requestIntent: requestPanelIntent,
  announce,
});

export function createPanelAttachedAuditIntent(raw) {
  const input = exactRecord(raw, ['capabilityId', 'captureMode']);
  if (!input || !OPAQUE_CAPABILITY.test(input.capabilityId ?? '') || !CAPTURE_MODES.includes(input.captureMode)) return null;
  return Object.freeze({
    type: 'PANEL_START_ATTACHED_AUDIT', capabilityId: input.capabilityId,
    captureMode: input.captureMode, includeQuery: false, deleteAfterCompleteExport: false,
  });
}

export function normalizePanelUrlEntry(raw) {
  if (typeof raw !== 'string') return Object.freeze({ ok: false, code: 'invalid' });
  const url = raw.trim();
  if (url === '') return Object.freeze({ ok: false, code: 'required' });
  if (Array.from(url).length > 2_048) return Object.freeze({ ok: false, code: 'too-long' });
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username !== '' || parsed.password !== '' ||
      /[\u0000-\u001F\u007F]/u.test(url)) return Object.freeze({ ok: false, code: 'invalid' });
    if (Array.from(parsed.href).length > 2_048) return Object.freeze({ ok: false, code: 'too-long' });
    return Object.freeze({ ok: true, url: parsed.href });
  } catch { return Object.freeze({ ok: false, code: 'invalid' }); }
}

export function createPanelUrlAuditIntent(raw) {
  const input = exactRecord(raw, ['capabilityId', 'url', 'captureMode']);
  const normalized = input ? normalizePanelUrlEntry(input.url) : null;
  if (!input || !OPAQUE_CAPABILITY.test(input.capabilityId ?? '') || !CAPTURE_MODES.includes(input.captureMode) ||
    normalized?.ok !== true || normalized.url !== input.url) return null;
  return Object.freeze({
    type: 'PANEL_START_URL_AUDIT', capabilityId: input.capabilityId, url: normalized.url,
    captureMode: input.captureMode, includeQuery: false, deleteAfterCompleteExport: false,
  });
}

export function shouldShowPanelStartFailure(current) {
  try {
    const screen = current && typeof current === 'object'
      ? Object.getOwnPropertyDescriptor(current, 'screen') : null;
    const auditId = current && typeof current === 'object'
      ? Object.getOwnPropertyDescriptor(current, 'auditId') : null;
    return Boolean(screen?.enumerable && Object.hasOwn(screen, 'value') && screen.value === 'running' &&
      auditId?.enumerable && Object.hasOwn(auditId, 'value') && auditId.value === null);
  } catch { return false; }
}

export function createPanelAuditDeletionController({
  runtime, readState, readResult, clearResult, invalidateHighlight, transition: applyTransition,
} = {}) {
  if (!runtime || typeof runtime.id !== 'string' || typeof runtime.workerUrl !== 'string' ||
    typeof readState !== 'function' || typeof readResult !== 'function' ||
    typeof clearResult !== 'function' || typeof invalidateHighlight !== 'function' ||
    typeof applyTransition !== 'function') throw new TypeError('PANEL_AUDIT_DELETION_INVALID');

  function receive(message, sender) {
    const deletion = parseAuditDeletedEvent(message, sender, runtime);
    if (!deletion) return false;
    const current = readState();
    const result = readResult();
    const auditIds = [current?.auditId, result?.auditId].filter(value => AUDIT_ID.test(value ?? ''));
    if (auditIds.length === 0 || (deletion.scope !== 'all' && !auditIds.includes(deletion.auditId))) return false;
    clearResult();
    invalidateHighlight();
    applyTransition({ type: 'AUDIT_DELETED' });
    return true;
  }

  return Object.freeze({ receive });
}

export function projectPanelBootstrapEvent(value) {
  const paused = exactRecord(value, ['state', 'auditId', 'result', 'mode', 'categories', 'message']);
  if (!paused || paused.state !== 'privacy-paused' || !AUDIT_ID.test(paused.auditId ?? '') || paused.result !== null ||
    !PIXEL_CAPTURE_MODES.includes(paused.mode) || paused.message !== PRIVACY_MESSAGE) return null;
  const categories = copyPrivacyCategories(paused.categories);
  return categories ? Object.freeze({
    type: 'PRIVACY_PAUSED', auditId: paused.auditId, mode: paused.mode,
    categories: Object.freeze(categories), message: PRIVACY_MESSAGE,
  }) : null;
}

export function projectPanelAuditProgressEvent(value, sender, runtime, currentAuditId) {
  if (!authorizedWorkerSender(sender, runtime) || !AUDIT_ID.test(currentAuditId ?? '')) return null;
  const event = exactRecord(value, ['type', 'auditId', 'sessionId', 'phase', 'message', 'percent', 'at']);
  if (!event || event.type !== 'AUDIT_PROGRESS' || event.auditId !== currentAuditId ||
    event.sessionId !== event.auditId || !canonicalIsoTime(event.at)) return null;
  return AUDIT_PROGRESS.some(([phase, message, percent]) =>
    event.phase === phase && event.message === message && event.percent === percent)
    ? Object.freeze({
        type: 'AUDIT_PROGRESS', auditId: event.auditId, sessionId: event.sessionId,
        phase: event.phase, message: event.message, percent: event.percent, at: event.at,
      })
    : null;
}

export function createPanelPrivacyConfirmationController(raw) {
  const input = exactRecord(raw, ['readState', 'transition', 'requestIntent', 'announce']);
  if (!input || typeof input.readState !== 'function' || typeof input.transition !== 'function' ||
    typeof input.requestIntent !== 'function' || typeof input.announce !== 'function') {
    throw new TypeError('PANEL_PRIVACY_CONFIRMATION_INVALID');
  }
  async function confirm(rawIntent) {
    const intent = exactRecord(rawIntent, ['type', 'mode', 'accepted']);
    if (!intent || intent.type !== 'CONFIRM_PIXEL_CAPTURE' || intent.accepted !== true ||
      !PIXEL_CAPTURE_MODES.includes(intent.mode)) return false;
    let current;
    try { current = input.readState(); } catch { return false; }
    const privacy = exactRecord(current?.privacy, ['mode', 'categories', 'message', 'confirmationPending']);
    if (current?.screen !== 'running' || current?.sessionStatus !== 'privacy-paused' ||
      !privacy || privacy.mode !== intent.mode || privacy.message !== PRIVACY_MESSAGE ||
      privacy.confirmationPending !== false) return false;
    try { input.transition({ type: 'PRIVACY_CONFIRM_REQUESTED' }); } catch { return false; }
    let pendingState;
    try { pendingState = input.readState(); } catch { return false; }
    const pendingPrivacy = pendingState?.privacy;
    if (pendingState?.sessionStatus !== 'privacy-paused' || pendingPrivacy?.mode !== intent.mode ||
      pendingPrivacy?.confirmationPending !== true) return false;
    let response = null;
    try {
      response = await input.requestIntent(Object.freeze({
        type: 'CONFIRM_PIXEL_CAPTURE', mode: intent.mode, accepted: true,
      }));
    } catch { /* the one-use confirmation remains consumed */ }
    let latest;
    try { latest = input.readState(); } catch { return false; }
    if (latest?.sessionStatus !== 'privacy-paused' || latest.privacy !== pendingPrivacy) return false;
    const success = exactRecord(response, ['ok', 'state']);
    if (success?.ok === true && success.state === 'running') return true;
    const documentChanged = exactRecord(response, ['ok', 'code']);
    const announcement = documentChanged?.ok === false && documentChanged.code === 'PIXEL_CONSENT_DOCUMENT_CHANGED'
      ? 'A página mudou; inicie uma nova avaliação.'
      : 'Não foi possível confirmar a captura. Cancele a auditoria ou aguarde uma nova confirmação.';
    try { input.announce(announcement); }
    catch { /* announcements never change authorization state */ }
    return false;
  }
  return Object.freeze({ confirm });
}

function render() {
  if (!root) return;
  let summary = null;
  let detail = null;
  if (state.screen === 'result') {
    if (!resultBundle || resultBundle.auditId !== state.auditId) {
      state = reducePanelState(state, {
        type: 'AUDIT_UNAVAILABLE', auditId: state.auditId,
        reason: 'O resultado local não pôde ser exibido com segurança.',
      });
    } else {
      summary = resultBundle.summary;
      if (state.selectedOccurrenceId !== null) {
        const matches = resultBundle.details.filter(row => row.occurrenceId === state.selectedOccurrenceId);
        if (matches.length !== 1) {
          state = reducePanelState(state, {
            type: 'AUDIT_UNAVAILABLE', auditId: state.auditId,
            reason: 'O resultado local não pôde ser exibido com segurança.',
          });
          summary = null;
        } else detail = matches[0];
      }
    }
  }

  const view = buildPanelView({ state, summary, detail });
  const screen = renderPanelView({ view, document, onIntent: handleIntent, onEvent: handleEvent });
  root.replaceChildren(screen);
  root.scrollTop = state.scrollTop;
  restoreFocus(state.focusId);
}

function transition(event) {
  state = reducePanelState(state, event);
  render();
}

function handleEvent(event) {
  if (event?.type === 'CAPTURE_MODE_SELECTED') {
    reviseUrlEntry();
    transition(event);
    return;
  }
  if (!['FILTER_SET', 'EVIDENCE_TOGGLED'].includes(event?.type)) return;
  const fallback = typeof event.focusId === 'string'
    ? event.focusId
    : (event.type === 'FILTER_SET' ? `filter-${event.filter}-all` : 'evidence-summary');
  transition({ ...event, ...currentInteraction(fallback) });
}

async function handleIntent(intent) {
  switch (intent.type) {
    case 'START_ATTACHED':
      await startAttachedAudit();
      return;
    case 'CONFIRM_PIXEL_CAPTURE':
      await privacyConfirmation.confirm(intent);
      return;
    case 'OPEN_URL_FORM':
      reviseUrlEntry();
      transition({ type: 'URL_FORM_OPENED' });
      return;
    case 'CLOSE_URL_FORM':
      reviseUrlEntry();
      transition({ type: 'URL_FORM_CLOSED' });
      return;
    case 'START_URL':
      await startUrlAudit(intent.url);
      return;
    case 'OPEN_BATCH_FORM':
      announce('Não disponível nesta beta.');
      return;
    case 'CANCEL_AUDIT':
      await requestSessionAction('PANEL_CANCEL_AUDIT');
      return;
    case 'OPEN_REPORT':
      await requestSessionAction('PANEL_OPEN_REPORT');
      return;
    case 'SELECT_OCCURRENCE':
      selectOccurrence(intent.occurrenceId);
      return;
    case 'CONSULT_EVIDENCE':
      consultEvidence(intent.occurrenceId, intent.reason);
      return;
    case 'HIGHLIGHT_OCCURRENCE':
      await highlightOccurrence(intent.occurrenceId);
      return;
    case 'CLEAR_HIGHLIGHT':
      await clearHighlight();
      return;
    case 'PERSONA_SELECT':
      await personaSession.select(intent.mode);
      return;
    case 'PERSONA_READER_TOGGLE':
      await personaSession.readerAction(state.persona.readerPaused ? 'resume' : 'pause');
      return;
    case 'PERSONA_READER_PREVIOUS':
      await personaSession.readerAction('previous');
      return;
    case 'PERSONA_READER_REPEAT':
      await personaSession.readerAction('repeat');
      return;
    case 'PERSONA_READER_NEXT':
      await personaSession.readerAction('next');
      return;
    case 'PERSONA_READER_ENABLE_VOICE':
      await personaSession.enableVoice();
      return;
    case 'PERSONA_END':
      await personaSession.stop();
      return;
    case 'RETRY':
      await retryAudit();
      return;
    default:
      return;
  }
}

async function highlightOccurrence(occurrenceId) {
  if (typeof occurrenceId !== 'string' || !occurrenceId || occurrenceId !== state.selectedOccurrenceId ||
    state.highlight.bindingStatus?.state !== 'available') return;
  const interaction = currentInteraction('live-highlight-action');
  transition({ type: 'HIGHLIGHT_BUSY', occurrenceId, ...interaction });
  let response = null;
  try {
    response = await runHighlightAction({
      request: () => requestPanelIntent({ type: 'HIGHLIGHT_OCCURRENCE', occurrenceId }),
      onState() {},
    });
  } catch {
    // The reducer maps every denied, disconnected, or malformed result to the safe evidence fallback.
  }
  const active = exactRecord(response, ['ok', 'highlight']);
  const highlight = exactRecord(active?.highlight, ['state', 'occurrenceId']);
  if (active?.ok === true && highlight?.state === 'active' && highlight.occurrenceId === occurrenceId) {
    if (shouldApplyHighlightState(state.highlight, highlight)) {
      transition({ type: 'HIGHLIGHT_ACTIVE', occurrenceId, ...interaction });
    }
  } else transition({ type: 'HIGHLIGHT_UNAVAILABLE', occurrenceId, ...interaction });
}

async function clearHighlight() {
  if (state.highlight.state !== 'active' || !state.highlight.occurrenceId) return;
  const occurrenceId = state.highlight.occurrenceId;
  const interaction = currentInteraction('live-highlight-action');
  transition({ type: 'HIGHLIGHT_CLEAR_BUSY', ...interaction });
  let response = null;
  try {
    response = await runHighlightAction({
      request: () => requestPanelIntent({ type: 'CLEAR_HIGHLIGHT' }),
      onState() {},
    });
  } catch {
    // A denied clear cannot be represented as success; the evidence fallback remains available.
  }
  const cleared = exactRecord(response, ['ok', 'highlight']);
  const highlight = exactRecord(cleared?.highlight, ['state']);
  if (cleared?.ok === true && highlight?.state === 'clear') {
    if (shouldApplyHighlightState(state.highlight, { state: 'clear', occurrenceId: null })) {
      transition({ type: 'HIGHLIGHT_CLEARED', ...interaction });
    }
    if (state.selectedOccurrenceId) void refreshHighlightAvailability(state.selectedOccurrenceId);
  } else transition({ type: 'HIGHLIGHT_CLEAR_FAILED', occurrenceId, ...interaction });
}

async function startAttachedAudit() {
  const captureMode = state.captureMode;
  transition({ type: 'START_REQUESTED', source: 'attached' });
  const requestId = nextRequestId();
  const prepared = parsePreparedCapability(await requestPanelIntent({ type: 'PREPARE_PANEL_CAPABILITY', requestId }), requestId);
  if (!prepared) {
    transition({ type: 'AUDIT_UNAVAILABLE', reason: 'Não foi possível concluir a operação local.' });
    return;
  }
  const startIntent = createPanelAttachedAuditIntent({ capabilityId: prepared.capabilityId, captureMode });
  if (!startIntent) {
    transition({ type: 'AUDIT_UNAVAILABLE', reason: 'Não foi possível concluir a operação local.' });
    return;
  }
  const response = await requestPanelIntent(startIntent);
  const started = parseStartedAudit(response);
  await personaSession.afterAuditAttempt({ started });
  if (!started && shouldShowPanelStartFailure(state)) {
    transition({ type: 'AUDIT_UNAVAILABLE', reason: 'Não foi possível concluir a operação local.' });
  }
}

async function startUrlAudit(rawUrl) {
  const submittedRevision = reviseUrlEntry();
  const normalized = normalizePanelUrlEntry(rawUrl);
  if (!normalized.ok) {
    transition({ type: 'URL_ENTRY_REJECTED', code: normalized.code });
    return;
  }
  const captureMode = state.captureMode;
  if (state.screen !== 'initial' || state.entryMode !== 'single-url' || !CAPTURE_MODES.includes(captureMode)) return;
  const requestId = nextRequestId();
  let preparedResponse = null;
  try {
    preparedResponse = await requestPanelIntent({
      type: 'PREPARE_PANEL_NAVIGATION_CAPABILITY', requestId, intent: 'single',
    });
  } catch { /* a safe nontechnical error is rendered below */ }
  const prepared = parsePreparedCapability(preparedResponse, requestId);
  if (urlEntryRevision !== submittedRevision || state.screen !== 'initial' ||
    state.entryMode !== 'single-url' || state.captureMode !== captureMode) return;
  if (!prepared) {
    transition({ type: 'URL_ENTRY_REJECTED', code: 'start-failed' });
    return;
  }
  const startIntent = createPanelUrlAuditIntent({
    capabilityId: prepared.capabilityId, url: normalized.url, captureMode,
  });
  if (!startIntent) {
    transition({ type: 'URL_ENTRY_REJECTED', code: 'start-failed' });
    return;
  }
  transition({ type: 'START_REQUESTED', source: 'single-url' });
  if (urlEntryRevision !== submittedRevision || state.screen !== 'running' || state.auditId !== null ||
    state.auditSource !== 'single-url' || state.captureMode !== captureMode) return;
  let response = null;
  try { response = await requestPanelIntent(startIntent); }
  catch { /* a safe nontechnical error is rendered below */ }
  const started = parseStartedAudit(response);
  await personaSession.afterAuditAttempt({ started });
  if (started) {
    if (state.screen === 'running' && state.auditId === null && state.auditSource === 'single-url' &&
      state.captureMode === captureMode && state.sessionStatus === null) {
      transition({ type: 'AUDIT_RUNNING', auditId: response.auditId });
    }
    return;
  }
  if (shouldShowPanelStartFailure(state)) transition({ type: 'URL_ENTRY_REJECTED', code: 'start-failed' });
}

async function requestSessionAction(type) {
  if (!sessionPortClient) {
    if (type === 'PANEL_OPEN_REPORT') announce('Não foi possível abrir o relatório. Tente novamente.');
    return;
  }
  if (type === 'PANEL_OPEN_REPORT') {
    const auditId = state.auditId;
    let response = null;
    try { response = await sessionPortClient.requestIntent({ type }); }
    catch { /* the completed result remains available for another attempt */ }
    if (state.screen !== 'result' || state.auditId !== auditId) return;
    const opened = exactRecord(response, ['ok', 'auditId', 'state']);
    announce(opened?.ok === true && opened.auditId === auditId && opened.state === 'connected'
      ? 'Relatório completo aberto em uma nova aba.'
      : 'Não foi possível abrir o relatório. Tente novamente.');
    return;
  }
  const response = await sessionPortClient.requestIntent({ type });
  if (response?.ok === true) {
    announce('Cancelamento solicitado.');
    return;
  }
  transition({ type: 'AUDIT_UNAVAILABLE', auditId: state.auditId, reason: 'Não foi possível concluir a operação local.' });
}

function selectOccurrence(occurrenceId) {
  if (!exactDetail(occurrenceId)) return;
  const interaction = currentInteraction(`occurrence-${occurrenceId}`);
  transition({ type: 'OCCURRENCE_SELECTED', occurrenceId, ...interaction });
  void refreshHighlightAvailability(occurrenceId);
}

async function refreshHighlightAvailability(occurrenceId) {
  if (state.screen !== 'result' || state.selectedOccurrenceId !== occurrenceId || !exactDetail(occurrenceId)) return;
  const auditId = state.auditId;
  transition({ type: 'HIGHLIGHT_AVAILABILITY_CHECKING', occurrenceId });
  let response = null;
  try { response = await requestPanelIntent({ type: 'GET_HIGHLIGHT_AVAILABILITY', occurrenceId }); }
  catch { /* availability remains closed */ }
  if (state.screen !== 'result' || state.auditId !== auditId || state.selectedOccurrenceId !== occurrenceId) return;
  const success = exactRecord(response, ['ok', 'bindingStatus']);
  const available = exactRecord(success?.bindingStatus, ['state']);
  if (success?.ok === true && available?.state === 'available') {
    transition({ type: 'HIGHLIGHT_AVAILABLE', occurrenceId });
    return;
  }
  const unavailable = exactRecord(success?.bindingStatus, ['state', 'reason']);
  transition({
    type: 'HIGHLIGHT_UNAVAILABLE', occurrenceId,
    reason: success?.ok === true && unavailable?.state === 'unavailable' ? unavailable.reason : 'live-proof-failed',
  });
}

function consultEvidence(occurrenceId, reason) {
  const detail = exactDetail(occurrenceId);
  if (!detail || reason !== detail.action.reason) return;
  const scrollTop = currentScrollTop();
  transition({ type: 'EVIDENCE_TOGGLED', expanded: true, focusId: 'evidence-summary', scrollTop });
  announce(detail.action.reason);
}

async function retryAudit() {
  const auditId = state.auditId;
  transition({ type: 'RETRY_REQUESTED' });
  if (!auditId) {
    await startAttachedAudit();
    return;
  }
  const response = await requestPanelIntent({ type: 'PANEL_REHYDRATE_VIEW', auditId });
  if (!parseRehydrateResponse(response, auditId)) {
    transition({ type: 'AUDIT_UNAVAILABLE', auditId, reason: 'Não foi possível concluir a operação local.' });
  } else announce('Recuperando o resultado local.');
}

function receiveBootstrap(value) {
  const privacyEvent = projectPanelBootstrapEvent(value);
  if (privacyEvent) {
    hasReceivedBootstrap = true;
    highlightStateSynchronizer.invalidate();
    resultBundle = null;
    transition(privacyEvent);
    return;
  }
  if (value?.state === 'initial') {
    const duplicateIdleBootstrap = hasReceivedBootstrap && state.screen === 'initial';
    hasReceivedBootstrap = true;
    highlightStateSynchronizer.invalidate();
    resultBundle = null;
    if (duplicateIdleBootstrap) render();
    else {
      reviseUrlEntry();
      transition({ type: 'BOOTSTRAP_INITIAL' });
    }
    synchronizePersonaOnBootstrap();
    return;
  }
  if (value?.state === 'running' && AUDIT_ID.test(value.auditId ?? '') && value.result === null) {
    hasReceivedBootstrap = true;
    highlightStateSynchronizer.invalidate();
    resultBundle = null;
    transition({ type: 'AUDIT_RUNNING', auditId: value.auditId });
    synchronizePersonaOnBootstrap();
    return;
  }
  if (['result', 'view-only'].includes(value?.state) && AUDIT_ID.test(value.auditId ?? '') && value.result) {
    hasReceivedBootstrap = true;
    resultBundle = value.result;
    transition({ type: 'AUDIT_RESULT', auditId: value.auditId, result: value.result });
    synchronizePersonaOnBootstrap();
    void highlightStateSynchronizer.synchronize();
    if (state.selectedOccurrenceId) void refreshHighlightAvailability(state.selectedOccurrenceId);
    return;
  }
  resultBundle = null;
  highlightStateSynchronizer.invalidate();
  transition({ type: 'AUDIT_UNAVAILABLE', auditId: state.auditId, reason: 'O resultado local não pôde ser exibido com segurança.' });
}

function receiveHighlightState(value) {
  if (state.screen !== 'result' || value?.auditId !== state.auditId) return;
  highlightStateSynchronizer.publish({ state: value.state, occurrenceId: value.occurrenceId });
}

function applyHighlightState(value) {
  if (state.screen !== 'result') return;
  const interaction = currentInteraction(state.focusId ?? 'result-summary');
  if (value.state === 'active' && typeof value.occurrenceId === 'string' && exactDetail(value.occurrenceId)) {
    if (!shouldApplyHighlightState(state.highlight, value)) return;
    transition({ type: 'HIGHLIGHT_ACTIVE', occurrenceId: value.occurrenceId, ...interaction });
    return;
  }
  if (value.state === 'clear' && value.occurrenceId === null) {
    if (!shouldApplyHighlightState(state.highlight, value)) return;
    transition({ type: 'HIGHLIGHT_CLEARED', ...interaction });
    if (state.selectedOccurrenceId) void refreshHighlightAvailability(state.selectedOccurrenceId);
  }
}

function receivePortStatus(value) {
  if (value === PANEL_RECONNECT_EXHAUSTED_MESSAGE) {
    personaBootstrapSynchronized = false;
    if (!hasReceivedBootstrap && root) root.replaceChildren(renderPanelStaticUnavailableView({ document }));
    else announce(value);
    return;
  }
  if (value === PANEL_UNPREPARED_MESSAGE) {
    personaBootstrapSynchronized = false;
    if (state.screen === 'result' && resultBundle?.auditId === state.auditId) {
      highlightStateSynchronizer.invalidate();
      announce('A conexão local foi interrompida. O resultado permanece disponível; tente a ação novamente.');
      return;
    }
    if (root) root.replaceChildren(hasReceivedBootstrap
      ? renderPanelReconnectView({ document })
      : renderPanelPreparingView({ document }));
    return;
  }
  if (typeof value === 'string') announce(value);
}

function authorizedWorkerSender(sender, runtime) {
  const source = ownDataRecord(sender);
  const context = exactRecord(runtime, ['id', 'workerUrl']);
  return Boolean(source && context && typeof context.id === 'string' && typeof context.workerUrl === 'string' &&
    source.id === context.id && source.tab === undefined &&
    (source.url === undefined || source.url === context.workerUrl));
}

function ownDataRecord(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key !== 'string')) return null;
    const copy = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      copy[key] = descriptor.value;
    }
    return copy;
  } catch { return null; }
}

function canonicalIsoTime(value) {
  if (typeof value !== 'string') return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function synchronizePersonaOnBootstrap() {
  if (personaBootstrapSynchronized) return;
  personaBootstrapSynchronized = true;
  void personaSession.synchronize();
}

function currentInteraction(fallbackFocusId) {
  const activeFocusId = document.activeElement?.dataset?.focusId;
  return {
    focusId: typeof activeFocusId === 'string' ? activeFocusId : fallbackFocusId,
    scrollTop: currentScrollTop(),
  };
}

function currentScrollTop() {
  if (Number.isSafeInteger(root?.scrollTop) && root.scrollTop >= 0) return root.scrollTop;
  const scrollingElement = document.scrollingElement;
  return Number.isSafeInteger(scrollingElement?.scrollTop) && scrollingElement.scrollTop >= 0
    ? scrollingElement.scrollTop
    : state.scrollTop;
}

function restoreFocus(focusId) {
  if (!focusId || typeof root?.querySelectorAll !== 'function') return;
  const nodes = root.querySelectorAll('[data-focus-id]');
  for (const node of nodes) {
    if (node.dataset.focusId === focusId) {
      try { node.focus(); } catch { /* focus remains on the panel root */ }
      return;
    }
  }
}

function announce(message) {
  if (typeof root?.querySelector !== 'function') return;
  const region = root.querySelector('[role="status"][aria-live="polite"]');
  if (region && typeof message === 'string') region.textContent = message;
}

function exactDetail(occurrenceId) {
  if (typeof occurrenceId !== 'string' || !resultBundle || state.auditId !== resultBundle.auditId) return null;
  const matches = resultBundle.details.filter(row => row.occurrenceId === occurrenceId);
  return matches.length === 1 ? matches[0] : null;
}

function nextRequestId() {
  requestSequence += 1;
  return `panel-${Date.now()}-${requestSequence}`;
}

function reviseUrlEntry() {
  urlEntryRevision += 1n;
  return urlEntryRevision;
}

function requestPanelIntent(message) {
  return sessionPortClient?.requestIntent(message) ?? Promise.resolve(null);
}

function parsePreparedCapability(value, requestId) {
  const response = exactRecord(value, ['ok', 'requestId', 'capabilityId']);
  return response && response.ok === true && response.requestId === requestId &&
    OPAQUE_CAPABILITY.test(response.capabilityId ?? '')
    ? { capabilityId: response.capabilityId }
    : null;
}

function parseStartedAudit(value) {
  const response = exactRecord(value, ['ok', 'auditId', 'state']);
  return Boolean(response) && response.ok === true && response.state === 'running' && AUDIT_ID.test(response.auditId ?? '');
}

function parseRehydrateResponse(value, auditId) {
  const response = exactRecord(value, ['ok', 'auditId', 'state']);
  return Boolean(response) && response.ok === true && response.auditId === auditId && response.state === 'view-only';
}

function exactRecord(value, keys) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return null;
    const own = Reflect.ownKeys(value);
    if (own.length !== keys.length || own.some(key => typeof key !== 'string' || !keys.includes(key))) return null;
    const copy = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      copy[key] = descriptor.value;
    }
    return copy;
  } catch { return null; }
}

function copyPrivacyCategories(value) {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
      value.length < 1 || value.length > PRIVACY_CATEGORIES.length) return null;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== value.length + 1 || !ownKeys.includes('length')) return null;
    const copy = [];
    let previous = -1;
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      const rank = PRIVACY_CATEGORIES.indexOf(descriptor.value);
      if (rank <= previous) return null;
      previous = rank;
      copy.push(descriptor.value);
    }
    return copy;
  } catch { return null; }
}

let sessionPortClient = null;
const authorizedLaunch = isAuthorizedPanelLaunchUrl(readLocationHref(), chromeApi?.runtime?.id);
const canConnectPanelSession = typeof chromeApi?.runtime?.connect === 'function';
if (root) {
  root.replaceChildren(!authorizedLaunch
    ? renderPanelReconnectView({ document })
    : canConnectPanelSession
      ? renderPanelPreparingView({ document })
      : renderPanelStaticUnavailableView({ document }));
}

if (authorizedLaunch && canConnectPanelSession) {
  sessionPortClient = createPanelSessionPortClient({
    chromeApi,
    onBootstrapResult: receiveBootstrap,
    onStatus: receivePortStatus,
    onHighlightState: receiveHighlightState,
    createRequestId: nextRequestId,
    setTimer: globalThis.setTimeout.bind(globalThis),
    clearTimer: globalThis.clearTimeout.bind(globalThis),
  });
  sessionPortClient.start();
}

if (authorizedLaunch && typeof chromeApi?.runtime?.onMessage?.addListener === 'function' &&
  typeof chromeApi.runtime.getURL === 'function') {
  const auditDeletionController = createPanelAuditDeletionController({
    runtime: {
      id: chromeApi.runtime.id,
      workerUrl: chromeApi.runtime.getURL('src/background/service-worker.js'),
    },
    readState: () => state,
    readResult: () => resultBundle,
    clearResult() { resultBundle = null; },
    invalidateHighlight() { highlightStateSynchronizer.invalidate(); },
    transition,
  });
  chromeApi.runtime.onMessage.addListener((message, sender) => {
    const runtime = {
      id: chromeApi.runtime.id,
      workerUrl: chromeApi.runtime.getURL('src/background/service-worker.js'),
    };
    const progress = projectPanelAuditProgressEvent(message, sender, runtime, state.auditId);
    if (progress) {
      transition(progress);
      return;
    }
    auditDeletionController.receive(message, sender);
  });
}

function readLocationHref() {
  try { return globalThis.location?.href ?? null; }
  catch { return null; }
}
