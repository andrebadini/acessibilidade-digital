import { createPanelSessionPortClient } from './panel-session-port.js';
import { buildPanelView, renderPanelView } from './panel-view.js';
import { createInitialPanelState, reducePanelState } from './panel-state.js';

const root = document.querySelector('#panel-root');
const chromeApi = globalThis.chrome ?? null;
const OPAQUE_CAPABILITY = /^[A-Za-z0-9_-]{20,240}$/u;
const AUDIT_ID = /^[A-Za-z0-9._:-]{1,160}$/u;
let state = createInitialPanelState();
let resultBundle = null;
let requestSequence = 0;

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
    case 'RETRY':
      await retryAudit();
      return;
    default:
      return;
  }
}

async function startAttachedAudit() {
  transition({ type: 'START_REQUESTED' });
  const requestId = nextRequestId();
  const prepared = parsePreparedCapability(await sendWorkerMessage({ type: 'PREPARE_PANEL_CAPABILITY', requestId }), requestId);
  if (!prepared) {
    transition({ type: 'AUDIT_UNAVAILABLE', reason: 'Não foi possível concluir a operação local.' });
    return;
  }
  const response = await sendWorkerMessage({
    type: 'PANEL_START_ATTACHED_AUDIT',
    capabilityId: prepared.capabilityId,
    captureMode: 'no-pixels',
    includeQuery: false,
    deleteAfterCompleteExport: false,
  });
  if (!parseStartedAudit(response)) {
    transition({ type: 'AUDIT_UNAVAILABLE', reason: 'Não foi possível concluir a operação local.' });
  }
}

async function requestSessionAction(type) {
  if (!sessionPortClient) return;
  const response = await sessionPortClient.requestSessionIntent({ type });
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
  const response = await sendWorkerMessage({ type: 'PANEL_REHYDRATE_VIEW', auditId });
  if (!parseRehydrateResponse(response, auditId)) {
    transition({ type: 'AUDIT_UNAVAILABLE', auditId, reason: 'Não foi possível concluir a operação local.' });
  } else announce('Recuperando o resultado local.');
}

function receiveBootstrap(value) {
  if (value?.state === 'initial') {
    resultBundle = null;
    transition({ type: 'BOOTSTRAP_INITIAL' });
    return;
  }
  if (value?.state === 'running' && AUDIT_ID.test(value.auditId ?? '') && value.result === null) {
    resultBundle = null;
    transition({ type: 'AUDIT_RUNNING', auditId: value.auditId });
    return;
  }
  if (['result', 'view-only'].includes(value?.state) && AUDIT_ID.test(value.auditId ?? '') && value.result) {
    resultBundle = value.result;
    transition({ type: 'AUDIT_RESULT', auditId: value.auditId, result: value.result });
    return;
  }
  resultBundle = null;
  transition({ type: 'AUDIT_UNAVAILABLE', auditId: state.auditId, reason: 'O resultado local não pôde ser exibido com segurança.' });
}

function receivePortStatus(value) {
  if (value === 'Painel indisponível; tentando reconectar.') {
    transition({ type: 'PORT_INTERRUPTED' });
    return;
  }
  if (typeof value === 'string') announce(value);
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

function sendWorkerMessage(message) {
  if (typeof chromeApi?.runtime?.sendMessage !== 'function') return Promise.resolve(null);
  return new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      resolve(value && typeof value === 'object' ? value : null);
    };
    try {
      const returned = chromeApi.runtime.sendMessage(message, finish);
      if (returned && typeof returned.then === 'function') returned.then(finish, () => finish(null));
    } catch { finish(null); }
  });
}

function parsePreparedCapability(value, requestId) {
  const response = exactRecord(value, ['ok', 'requestId', 'capabilityId', 'expiresAt']);
  return response && response.ok === true && response.requestId === requestId &&
    OPAQUE_CAPABILITY.test(response.capabilityId ?? '') && Number.isSafeInteger(response.expiresAt)
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

render();

let sessionPortClient = null;
if (typeof chromeApi?.runtime?.connect === 'function' && typeof chromeApi.runtime.sendMessage === 'function') {
  sessionPortClient = createPanelSessionPortClient({
    chromeApi,
    onBootstrapResult: receiveBootstrap,
    onStatus: receivePortStatus,
    setTimer: globalThis.setTimeout.bind(globalThis),
    clearTimer: globalThis.clearTimeout.bind(globalThis),
  });
  sessionPortClient.start();
}
