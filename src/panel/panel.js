import { createPanelSessionPortClient } from './panel-session-port.js';
import {
  createHighlightStateSynchronizer,
  runHighlightAction,
  shouldApplyHighlightState,
} from './highlight-action.js';
import { PANEL_UNPREPARED_MESSAGE } from './panel-status.js';
import { isAuthorizedPanelLaunchUrl } from './panel-launch-url.js';
import { buildPanelView, renderPanelReconnectView, renderPanelView } from './panel-view.js';
import { createInitialPanelState, reducePanelState } from './panel-state.js';
import { createPanelPersonaSession } from './persona-session.js';

const root = document.querySelector('#panel-root');
const chromeApi = globalThis.chrome ?? null;
const OPAQUE_CAPABILITY = /^[A-Za-z0-9_-]{20,240}$/u;
const AUDIT_ID = /^[A-Za-z0-9._:-]{1,160}$/u;
let state = createInitialPanelState();
let resultBundle = null;
let requestSequence = 0;
let personaBootstrapSynchronized = false;
const personaSession = createPanelPersonaSession({
  requestIntent: requestPanelIntent,
  createRequestId: nextRequestId,
  onEvent: transition,
});
const highlightStateSynchronizer = createHighlightStateSynchronizer({
  requestCurrent: () => requestPanelIntent({ type: 'GET_HIGHLIGHT_STATE' }),
  applyState: applyHighlightState,
});

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
    case 'OPEN_URL_FORM':
    case 'OPEN_BATCH_FORM':
      announce('Disponível no Marco 3');
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
  transition({ type: 'START_REQUESTED' });
  const requestId = nextRequestId();
  const prepared = parsePreparedCapability(await requestPanelIntent({ type: 'PREPARE_PANEL_CAPABILITY', requestId }), requestId);
  if (!prepared) {
    transition({ type: 'AUDIT_UNAVAILABLE', reason: 'Não foi possível concluir a operação local.' });
    return;
  }
  const response = await requestPanelIntent({
    type: 'PANEL_START_ATTACHED_AUDIT',
    capabilityId: prepared.capabilityId,
    captureMode: 'no-pixels',
    includeQuery: false,
    deleteAfterCompleteExport: false,
  });
  const started = parseStartedAudit(response);
  await personaSession.afterAuditAttempt({ started });
  if (!started) {
    transition({ type: 'AUDIT_UNAVAILABLE', reason: 'Não foi possível concluir a operação local.' });
  }
}

async function requestSessionAction(type) {
  if (!sessionPortClient) return;
  const response = await sessionPortClient.requestIntent({ type });
  if (response?.ok === true) {
    announce(type === 'PANEL_CANCEL_AUDIT' ? 'Cancelamento solicitado.' : 'Relatório solicitado.');
    return;
  }
  if (type === 'PANEL_OPEN_REPORT' && response?.code === 'FEATURE_UNAVAILABLE') {
    announce('Abrir relatório completo estará disponível na próxima etapa.');
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
  if (value?.state === 'initial') {
    highlightStateSynchronizer.invalidate();
    resultBundle = null;
    transition({ type: 'BOOTSTRAP_INITIAL' });
    synchronizePersonaOnBootstrap();
    return;
  }
  if (value?.state === 'running' && AUDIT_ID.test(value.auditId ?? '') && value.result === null) {
    highlightStateSynchronizer.invalidate();
    resultBundle = null;
    transition({ type: 'AUDIT_RUNNING', auditId: value.auditId });
    synchronizePersonaOnBootstrap();
    return;
  }
  if (['result', 'view-only'].includes(value?.state) && AUDIT_ID.test(value.auditId ?? '') && value.result) {
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
  if (value === PANEL_UNPREPARED_MESSAGE) {
    personaBootstrapSynchronized = false;
    transition({ type: 'PORT_INTERRUPTED' });
    return;
  }
  if (typeof value === 'string') announce(value);
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

let sessionPortClient = null;
const authorizedLaunch = isAuthorizedPanelLaunchUrl(readLocationHref(), chromeApi?.runtime?.id);
if (!authorizedLaunch) {
  if (root) root.replaceChildren(renderPanelReconnectView({ document }));
} else {
  render();
}

if (authorizedLaunch && typeof chromeApi?.runtime?.connect === 'function') {
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

function readLocationHref() {
  try { return globalThis.location?.href ?? null; }
  catch { return null; }
}
