import { copyPanelResultBundleV1 } from './panel-result-bundle.js';
import { PANEL_UNPREPARED_MESSAGE } from './panel-status.js';

const PORT_NAME = 'audita-panel-v1';
const SESSION_ID = /^[A-Za-z0-9_-]{20,240}$/u;
const AUDIT_ID = /^[A-Za-z0-9._:-]{1,160}$/u;
const OCCURRENCE_ID = /^[A-Za-z0-9._:-]{1,200}$/u;
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,160}$/u;
const CONSENT_ID = /^[A-Za-z0-9_-]{21}[AQgw]$/u;
const RECONNECT_DELAYS = Object.freeze([250, 500, 1000, 2000, 5000]);
// Large saved audits must finish integrity verification before rehydration.
const BOOTSTRAP_TIMEOUT_MS = 60000;
const REQUEST_TIMEOUT_MS = 5000;
const REPORT_OPEN_TIMEOUT_MS = 60000;
const REVIEW_HEARTBEAT_INTERVAL_MS = 20000;
const REVIEW_HEARTBEAT_BUDGET_MS = 30 * 60 * 1000;
const REVIEW_HEARTBEAT_PACKET = Object.freeze({
  protocol: 'audita-panel', version: 1, type: 'review-heartbeat',
});
export const PANEL_RECONNECT_EXHAUSTED_MESSAGE = 'Painel indisponível. Abra novamente pelo botão da extensão.';
const PRIVACY_MESSAGE = 'A página contém conteúdo potencialmente sensível. Confirme para capturar imagens visíveis.';
const CAPTURE_MODES = new Set(['full-evidence', 'element-only', 'no-pixels']);
const PRIVACY_MODES = new Set(['full-evidence', 'element-only']);
const PRIVACY_CATEGORIES = Object.freeze(['password', 'otp', 'payment', 'private-marker']);
const BOOTSTRAP_KEYS = Object.freeze([
  'protocol', 'version', 'type', 'state', 'auditId', 'sessionCapabilityId', 'result',
]);
const RUNNING_BOOTSTRAP_KEYS = Object.freeze([...BOOTSTRAP_KEYS, 'captureMode']);
// Único aviso aceito num bootstrap ocioso: a auditoria daquela aba foi interrompida porque a página
// recarregou ou navegou (o painel foi recriado e não tem memória da tentativa).
const INITIAL_NOTICE_BOOTSTRAP_KEYS = Object.freeze([...BOOTSTRAP_KEYS, 'notice']);
const INITIAL_NOTICES = new Set(['page-reloaded']);
const ATTACHED_PRIVACY_PAUSED_KEYS = Object.freeze([
  'protocol', 'version', 'type', 'auditId', 'sessionCapabilityId',
  'consentId', 'mode', 'categories', 'message',
]);
const OWNED_PRIVACY_PAUSED_KEYS = Object.freeze([
  'protocol', 'version', 'type', 'auditId', 'sessionCapabilityId',
  'mode', 'categories', 'message',
]);
const BATCH_PRIVACY_PAUSED_KEYS = Object.freeze([
  'protocol', 'version', 'type', 'auditId', 'sessionCapabilityId',
  'mode', 'categories', 'message', 'pageNumber',
]);
const INTENT_RESULT_KEYS = Object.freeze(['protocol', 'version', 'type', 'requestId', 'response']);
const HIGHLIGHT_STATE_KEYS = Object.freeze(['version', 'type', 'auditId', 'occurrenceId', 'state']);
const PAGE_MARKERS_STATE_KEYS = Object.freeze(['version', 'type', 'auditId', 'modelRevision', 'state', 'selectedOrdinal']);
const PAGE_MARKERS_TYPES = new Set([
  'PANEL_SHOW_PAGE_MARKERS', 'PANEL_HIDE_PAGE_MARKERS', 'PANEL_SELECT_PAGE_MARKER', 'PANEL_FILTER_PAGE_MARKERS',
]);

function freeze(value, seen = new WeakSet()) {
  if (value && typeof value === 'object' && !seen.has(value)) {
    seen.add(value);
    for (const child of Object.values(value)) freeze(child, seen);
    Object.freeze(value);
  }
  return value;
}

function exact(value, keys) {
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

function ownDataOrNull(value, key) {
  try {
    const descriptor = value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, key) : null;
    return descriptor?.enumerable && Object.hasOwn(descriptor, 'value') ? descriptor.value : null;
  } catch { return null; }
}

function copyData(value, state = { nodes: 0 }, depth = 0) {
  if (['string', 'number', 'boolean'].includes(typeof value) || value === null) return value;
  if (depth > 8 || ++state.nodes > 2048 || !value || typeof value !== 'object') throw new TypeError('INVALID_DATA');
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 2048) throw new TypeError('INVALID_DATA');
    const own = Reflect.ownKeys(value);
    if (own.length !== value.length + 1 || !own.includes('length')) throw new TypeError('INVALID_DATA');
    const output = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new TypeError('INVALID_DATA');
      output.push(copyData(descriptor.value, state, depth + 1));
    }
    return output;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError('INVALID_DATA');
  const keys = Reflect.ownKeys(value);
  if (keys.length > 256 || keys.some(key => typeof key !== 'string')) throw new TypeError('INVALID_DATA');
  const output = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new TypeError('INVALID_DATA');
    output[key] = copyData(descriptor.value, state, depth + 1);
  }
  if (new TextEncoder().encode(JSON.stringify(output)).byteLength > 65_536) throw new TypeError('INVALID_DATA');
  return output;
}

function parseBootstrap(value) {
  const runningPacket = exact(value, RUNNING_BOOTSTRAP_KEYS);
  const noticePacket = runningPacket ? null : exact(value, INITIAL_NOTICE_BOOTSTRAP_KEYS);
  const packet = runningPacket ?? noticePacket ?? exact(value, BOOTSTRAP_KEYS);
  if (!packet || packet.protocol !== 'audita-panel' || packet.version !== 1 || packet.type !== 'bootstrap-result') return null;
  if (runningPacket && packet.state !== 'running') return null;
  if (noticePacket && (packet.state !== 'initial' || !INITIAL_NOTICES.has(packet.notice))) return null;
  if (packet.state === 'initial') {
    return packet.auditId === null && packet.sessionCapabilityId === null && packet.result === null ? freeze(packet) : null;
  }
  if (!AUDIT_ID.test(packet.auditId ?? '') || !SESSION_ID.test(packet.sessionCapabilityId ?? '')) return null;
  if (packet.state === 'running') {
    return packet.result === null && (!runningPacket || CAPTURE_MODES.has(packet.captureMode)) ? freeze(packet) : null;
  }
  if (!['result', 'view-only'].includes(packet.state)) return null;
  try {
    const result = copyPanelResultBundleV1(packet.result);
    return result.auditId === packet.auditId ? freeze({ ...packet, result }) : null;
  } catch { return null; }
}

function copyPrivacyCategories(value) {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
      value.length < 1 || value.length > PRIVACY_CATEGORIES.length) return null;
    const own = Reflect.ownKeys(value);
    if (own.length !== value.length + 1 || !own.includes('length')) return null;
    const categories = [];
    let priorRank = -1;
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      const rank = PRIVACY_CATEGORIES.indexOf(descriptor.value);
      if (rank <= priorRank) return null;
      priorRank = rank;
      categories.push(descriptor.value);
    }
    return freeze(categories);
  } catch { return null; }
}

function parsePrivacyPaused(value) {
  const attachedPacket = exact(value, ATTACHED_PRIVACY_PAUSED_KEYS);
  const batchPacket = attachedPacket ? null : exact(value, BATCH_PRIVACY_PAUSED_KEYS);
  const ownedPacket = attachedPacket || batchPacket ? null : exact(value, OWNED_PRIVACY_PAUSED_KEYS);
  const packet = attachedPacket ?? batchPacket ?? ownedPacket;
  if (!packet || packet.protocol !== 'audita-panel' || packet.version !== 1 ||
    packet.type !== 'privacy-paused' || !AUDIT_ID.test(packet.auditId ?? '') ||
    !SESSION_ID.test(packet.sessionCapabilityId ?? '') ||
    (attachedPacket !== null && !CONSENT_ID.test(packet.consentId ?? '')) ||
    (batchPacket !== null && (!Number.isSafeInteger(packet.pageNumber) || packet.pageNumber < 1 || packet.pageNumber > 20)) ||
    !PRIVACY_MODES.has(packet.mode) || packet.message !== PRIVACY_MESSAGE) return null;
  const categories = copyPrivacyCategories(packet.categories);
  if (!categories) return null;
  const confirmation = attachedPacket
    ? { kind: 'attached', consentId: packet.consentId, mode: packet.mode }
    : batchPacket
      ? { kind: 'batch', mode: packet.mode, categoryKey: categories.join('\u0000'), pageNumber: packet.pageNumber }
      : { kind: 'single', mode: packet.mode, categoryKey: categories.join('\u0000'), pageNumber: null };
  return { packet, categories, confirmation: freeze(confirmation) };
}

function parseIntentResult(value) {
  const packet = exact(value, INTENT_RESULT_KEYS);
  if (!packet || packet.protocol !== 'audita-panel' || packet.version !== 1 || packet.type !== 'intent-result' ||
    !REQUEST_ID.test(packet.requestId ?? '')) return null;
  try { return freeze({ ...packet, response: copyData(packet.response) }); }
  catch { return null; }
}

function parseRevokedCancelResponse(value, auditId) {
  const response = exact(value, ['ok', 'auditId', 'state']);
  return response?.ok === true && response.auditId === auditId && response.state === 'revoked'
    ? freeze(response)
    : null;
}

function parseHighlightState(value) {
  const packet = exact(value, HIGHLIGHT_STATE_KEYS);
  if (!packet || packet.version !== 1 || packet.type !== 'HIGHLIGHT_STATE_CHANGED' ||
    !AUDIT_ID.test(packet.auditId ?? '')) return null;
  if (packet.state === 'active' && OCCURRENCE_ID.test(packet.occurrenceId ?? '')) return freeze(packet);
  if (packet.state === 'clear' && packet.occurrenceId === null) return freeze(packet);
  return null;
}

function validMarkerOrdinal(value, maximum = 64) {
  return Number.isSafeInteger(value) && value >= 0 && value < maximum;
}

function parsePageMarkersState(value) {
  const packet = exact(value, PAGE_MARKERS_STATE_KEYS);
  if (!packet || packet.version !== 1 || packet.type !== 'PAGE_MARKERS_STATE_CHANGED' ||
    typeof packet.auditId !== 'string' || !AUDIT_ID.test(packet.auditId) ||
    !Number.isSafeInteger(packet.modelRevision) || packet.modelRevision < 1 ||
    !['active', 'clear'].includes(packet.state) ||
    (packet.selectedOrdinal !== null && !validMarkerOrdinal(packet.selectedOrdinal)) ||
    (packet.state === 'clear' && packet.selectedOrdinal !== null)) return null;
  return freeze(packet);
}

function copyPageMarkersIntent(intent, maximum) {
  const extras = intent.type === 'PANEL_SELECT_PAGE_MARKER' ? ['ordinal', 'scroll']
    : intent.type === 'PANEL_FILTER_PAGE_MARKERS' ? ['visibleOrdinals'] : [];
  const copy = exact(intent, ['type', 'modelRevision', ...extras]);
  if (!copy) return null;
  if (copy.type === 'PANEL_SELECT_PAGE_MARKER' &&
    (!validMarkerOrdinal(copy.ordinal, maximum) || typeof copy.scroll !== 'boolean')) return null;
  if (copy.type === 'PANEL_FILTER_PAGE_MARKERS') {
    if (typeof copy.visibleOrdinals !== 'string' || copy.visibleOrdinals.length > 181) return null;
    if (copy.visibleOrdinals !== '') {
      const parts = copy.visibleOrdinals.split(',');
      if (!parts.every((part, index) => validMarkerOrdinal(Number(part), maximum) &&
        String(Number(part)) === part && (index === 0 || Number(part) > Number(parts[index - 1])))) return null;
    }
  }
  return copy;
}

function copyIntent(value) {
  try {
    const copy = copyData(value);
    return copy && !Array.isArray(copy) && typeof copy.type === 'string' ? freeze(copy) : null;
  } catch { return null; }
}

function localUnavailable() {
  return Object.freeze({ ok: false, code: 'PANEL_SESSION_UNAVAILABLE' });
}

export function createPanelSessionPortClient(raw) {
  const factoryKeys = [
    'chromeApi', 'onBootstrapResult', 'onStatus', 'onHighlightState',
    'createRequestId', 'setTimer', 'clearTimer',
  ];
  const input = exact(raw, factoryKeys) ?? exact(raw, [...factoryKeys, 'onPageMarkersState']);
  if (!input || typeof input.chromeApi?.runtime?.connect !== 'function' ||
    typeof input.onBootstrapResult !== 'function' || typeof input.onStatus !== 'function' ||
    typeof input.onHighlightState !== 'function' ||
    (Object.hasOwn(input, 'onPageMarkersState') && typeof input.onPageMarkersState !== 'function') ||
    typeof input.createRequestId !== 'function' || typeof input.setTimer !== 'function' ||
    typeof input.clearTimer !== 'function') throw new TypeError('PANEL_SESSION_CLIENT_INVALID');

  let started = false;
  let currentPort = null;
  let reconnectTimer = null;
  let reconnectIndex = 0;
  let ready = false;
  let auditId = null;
  let sessionId = null;
  let sessionState = null;
  let markerRevision = null;
  let markerDetailCount = 0;
  let pendingConsent = null;
  let reviewVisible = false;
  let reviewHeartbeatTimer = null;
  let reviewHeartbeatGeneration = 0;
  let reviewBudgetAuditId = null;
  let reviewDeadlineAt = null;
  const ownedConfirmationsInFlight = new Set();
  const bindings = new WeakMap();
  const pending = new Map();
  // Read-only highlight requests may reply after their timeout. Discard that
  // one reply without invalidating a newer report request. Mutations keep the
  // existing reconnect/rehydration path, including terminal cancellation.
  const timedOutRequests = new Set();

  const notifyStatus = status => {
    try { input.onStatus(status); } catch { /* UI callbacks do not own transport state. */ }
  };
  const notifyBootstrap = value => {
    try { input.onBootstrapResult(value); } catch { /* UI callbacks do not own transport state. */ }
  };
  const notifyHighlightState = value => {
    try { input.onHighlightState(value); } catch { /* UI callbacks do not own transport state. */ }
  };
  const clearCorrelation = () => {
    ready = false;
    auditId = null;
    sessionId = null;
    sessionState = null;
    markerRevision = null;
    markerDetailCount = 0;
    pendingConsent = null;
    ownedConfirmationsInFlight.clear();
  };
  const settle = (entry, value) => {
    if (!entry) return;
    if (entry.ownedConfirmation) ownedConfirmationsInFlight.delete(entry.ownedConfirmation);
    try { input.clearTimer(entry.timer); } catch { /* fixed cleanup */ }
    entry.resolve(value);
  };
  const rememberRetiredRequest = requestId => {
    if (timedOutRequests.size >= 1024) timedOutRequests.delete(timedOutRequests.values().next().value);
    timedOutRequests.add(requestId);
  };
  const settleAll = (value, preserveMarkerReplies = false) => {
    for (const [requestId, entry] of pending) {
      if (preserveMarkerReplies && PAGE_MARKERS_TYPES.has(entry.type)) rememberRetiredRequest(requestId);
      settle(entry, value);
    }
    pending.clear();
  };
  const stopReviewHeartbeat = () => {
    reviewHeartbeatGeneration += 1;
    if (reviewHeartbeatTimer !== null) {
      try { input.clearTimer(reviewHeartbeatTimer); } catch { /* fixed cleanup */ }
      reviewHeartbeatTimer = null;
    }
  };
  const reviewHeartbeatEligible = () => started && ready && currentPort !== null && reviewVisible &&
    ['result', 'view-only'].includes(sessionState) && auditId !== null && sessionId !== null &&
    reviewBudgetAuditId === auditId && Number.isSafeInteger(reviewDeadlineAt) && Date.now() < reviewDeadlineAt;
  const synchronizeReviewHeartbeat = () => {
    if (!reviewHeartbeatEligible()) {
      stopReviewHeartbeat();
      return;
    }
    if (reviewHeartbeatTimer !== null) return;
    const generation = ++reviewHeartbeatGeneration;
    reviewHeartbeatTimer = input.setTimer(() => {
      if (generation !== reviewHeartbeatGeneration) return;
      reviewHeartbeatTimer = null;
      if (!reviewHeartbeatEligible()) {
        stopReviewHeartbeat();
        return;
      }
      const port = currentPort;
      try { port.postMessage(REVIEW_HEARTBEAT_PACKET); }
      catch {
        unavailable(port, true);
        return;
      }
      synchronizeReviewHeartbeat();
    }, REVIEW_HEARTBEAT_INTERVAL_MS);
  };

  function detach(port, disconnect) {
    if (!port) return;
    const binding = bindings.get(port);
    if (binding?.bootstrapTimer !== null && binding?.bootstrapTimer !== undefined) {
      try { input.clearTimer(binding.bootstrapTimer); } catch { /* fixed cleanup */ }
      binding.bootstrapTimer = null;
    }
    try { if (binding) port.onMessage?.removeListener?.(binding.onMessage); } catch { /* fixed cleanup */ }
    try { if (binding) port.onDisconnect?.removeListener?.(binding.onDisconnect); } catch { /* fixed cleanup */ }
    bindings.delete(port);
    if (disconnect) {
      try { port.disconnect?.(); } catch { /* fixed cleanup */ }
    }
    if (currentPort === port) currentPort = null;
  }

  function scheduleReconnect() {
    if (!started) return false;
    if (reconnectTimer !== null) return true;
    if (reconnectIndex >= RECONNECT_DELAYS.length) return false;
    const delay = RECONNECT_DELAYS[reconnectIndex];
    reconnectIndex += 1;
    reconnectTimer = input.setTimer(() => {
      reconnectTimer = null;
      if (started) connect();
    }, delay);
    return true;
  }

  function unavailable(port, disconnect = false) {
    stopReviewHeartbeat();
    timedOutRequests.clear();
    clearCorrelation();
    settleAll(localUnavailable());
    detach(port, disconnect);
    notifyStatus(scheduleReconnect() ? PANEL_UNPREPARED_MESSAGE : PANEL_RECONNECT_EXHAUSTED_MESSAGE);
  }

  function receive(port, rawPacket) {
    if (!started || currentPort !== port) return;
    const bootstrap = parseBootstrap(rawPacket);
    if (bootstrap) {
      const binding = bindings.get(port);
      if (binding?.bootstrapTimer !== null && binding?.bootstrapTimer !== undefined) {
        try { input.clearTimer(binding.bootstrapTimer); } catch { /* fixed cleanup */ }
        binding.bootstrapTimer = null;
      }
      const priorCorrelation = ready && (auditId !== null || sessionId !== null)
        ? `${auditId ?? ''}\u0000${sessionId ?? ''}`
        : null;
      const nextCorrelation = `${bootstrap.auditId ?? ''}\u0000${bootstrap.sessionCapabilityId ?? ''}`;
      if (priorCorrelation !== null && priorCorrelation !== nextCorrelation) settleAll(localUnavailable(), true);
      reconnectIndex = 0;
      pendingConsent = null;
      ownedConfirmationsInFlight.clear();
      ready = true;
      auditId = bootstrap.auditId;
      sessionId = bootstrap.sessionCapabilityId;
      sessionState = bootstrap.state;
      markerRevision = bootstrap.result?.modelRevision ?? null;
      markerDetailCount = Math.min(64, bootstrap.result?.details.length ?? 0);
      if (['result', 'view-only'].includes(bootstrap.state)) {
        if (reviewBudgetAuditId !== bootstrap.auditId) {
          reviewBudgetAuditId = bootstrap.auditId;
          reviewDeadlineAt = Date.now() + REVIEW_HEARTBEAT_BUDGET_MS;
        }
      } else stopReviewHeartbeat();
      notifyStatus('Painel conectado.');
      const projection = { state: bootstrap.state, auditId: bootstrap.auditId, result: bootstrap.result };
      if (bootstrap.state === 'running' && CAPTURE_MODES.has(bootstrap.captureMode)) {
        projection.captureMode = bootstrap.captureMode;
      }
      if (bootstrap.state === 'initial' && INITIAL_NOTICES.has(bootstrap.notice)) projection.notice = bootstrap.notice;
      notifyBootstrap(freeze(projection));
      synchronizeReviewHeartbeat();
      return;
    }
    const privacyPaused = parsePrivacyPaused(rawPacket);
    if (privacyPaused) {
      const packet = privacyPaused.packet;
      if (!ready || auditId === null || sessionId === null ||
        packet.auditId !== auditId || packet.sessionCapabilityId !== sessionId) {
        unavailable(port, true);
        return;
      }
      if (privacyPaused.confirmation.kind !== 'attached') {
        for (const inFlight of ownedConfirmationsInFlight) {
          if (inFlight.auditId === packet.auditId && inFlight.sessionCapabilityId === packet.sessionCapabilityId &&
            inFlight.mode === privacyPaused.confirmation.mode &&
            inFlight.categoryKey === privacyPaused.confirmation.categoryKey &&
            inFlight.pageNumber === privacyPaused.confirmation.pageNumber) return;
        }
      }
      pendingConsent = privacyPaused.confirmation;
      sessionState = 'privacy-paused';
      stopReviewHeartbeat();
      markerRevision = null;
      markerDetailCount = 0;
      const projected = {
        state: 'privacy-paused', auditId: packet.auditId, result: null,
        mode: packet.mode, categories: privacyPaused.categories, message: PRIVACY_MESSAGE,
      };
      if (privacyPaused.confirmation.kind === 'batch') projected.pageNumber = privacyPaused.confirmation.pageNumber;
      notifyBootstrap(freeze(projected));
      return;
    }
    const pageMarkersState = parsePageMarkersState(rawPacket);
    if (pageMarkersState) {
      // Old audit/revision events are harmless after rehydration. Check their
      // structure before correlation, but current detail bounds only afterward.
      if (!ready || !['result', 'view-only'].includes(sessionState) ||
        pageMarkersState.auditId !== auditId || pageMarkersState.modelRevision !== markerRevision) return;
      if (pageMarkersState.selectedOrdinal !== null && !validMarkerOrdinal(pageMarkersState.selectedOrdinal, markerDetailCount)) {
        unavailable(port, true);
        return;
      }
      try {
        input.onPageMarkersState?.(freeze({ modelRevision: pageMarkersState.modelRevision,
          state: pageMarkersState.state, selectedOrdinal: pageMarkersState.selectedOrdinal }));
      } catch { /* UI callbacks do not own transport state. */ }
      return;
    }
    const highlightState = parseHighlightState(rawPacket);
    if (highlightState) {
      if (!ready || auditId === null || highlightState.auditId !== auditId) {
        unavailable(port, true);
        return;
      }
      notifyHighlightState(freeze({
        auditId: highlightState.auditId,
        occurrenceId: highlightState.occurrenceId,
        state: highlightState.state,
      }));
      return;
    }
    const result = parseIntentResult(rawPacket);
    if (result && timedOutRequests.delete(result.requestId)) return;
    if (!result || !pending.has(result.requestId)) {
      unavailable(port, true);
      return;
    }
    const entry = pending.get(result.requestId);
    if (PAGE_MARKERS_TYPES.has(entry.type) && (entry.auditId !== auditId ||
      entry.sessionCapabilityId !== sessionId || entry.modelRevision !== markerRevision ||
      !['result', 'view-only'].includes(sessionState))) {
      pending.delete(result.requestId);
      settle(entry, localUnavailable());
      return;
    }
    const revoked = entry.type === 'PANEL_CANCEL_AUDIT'
      ? parseRevokedCancelResponse(result.response, entry.auditId)
      : null;
    if (entry.type === 'PANEL_CANCEL_AUDIT' && (entry.sessionState === 'privacy-paused' || revoked)) {
      if (!revoked || entry.sessionCapabilityId !== sessionId || entry.auditId !== auditId) {
        unavailable(port, true);
        return;
      }
      pending.delete(result.requestId);
      settleAll(localUnavailable(), true);
      ready = true;
      auditId = null;
      sessionId = null;
      sessionState = 'initial';
      stopReviewHeartbeat();
      markerRevision = null;
      markerDetailCount = 0;
      pendingConsent = null;
      notifyBootstrap(freeze({ state: 'initial', auditId: null, result: null }));
      settle(entry, revoked);
      return;
    }
    pending.delete(result.requestId);
    settle(entry, result.response);
  }

  function connect() {
    if (!started || currentPort !== null) return;
    let port;
    try { port = input.chromeApi.runtime.connect({ name: PORT_NAME }); }
    catch { unavailable(null); return; }
    if (!port || typeof port.postMessage !== 'function' ||
      typeof port.onMessage?.addListener !== 'function' || typeof port.onDisconnect?.addListener !== 'function') {
      unavailable(port, true);
      return;
    }
    currentPort = port;
    const onMessage = message => receive(port, message);
    const onDisconnect = () => { if (currentPort === port) unavailable(port, false); };
    const binding = { onMessage, onDisconnect, bootstrapTimer: null };
    bindings.set(port, binding);
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(onDisconnect);
    notifyStatus('Conectando ao painel.');
    binding.bootstrapTimer = input.setTimer(() => {
      binding.bootstrapTimer = null;
      if (started && currentPort === port && !ready) unavailable(port, true);
    }, BOOTSTRAP_TIMEOUT_MS);
    try { port.postMessage({ protocol: 'audita-panel', version: 1, type: 'bootstrap' }); }
    catch { unavailable(port, true); }
  }

  function start() {
    if (started) return false;
    started = true;
    connect();
    return true;
  }

  function stop() {
    if (!started) return false;
    started = false;
    reviewVisible = false;
    stopReviewHeartbeat();
    timedOutRequests.clear();
    clearCorrelation();
    settleAll(localUnavailable());
    if (reconnectTimer !== null) {
      input.clearTimer(reconnectTimer);
      reconnectTimer = null;
    }
    detach(currentPort, true);
    return true;
  }

  function setReviewVisible(value) {
    if (typeof value !== 'boolean') return false;
    reviewVisible = value;
    synchronizeReviewHeartbeat();
    return true;
  }

  function requestIntent(rawIntent) {
    if (!started || !ready || currentPort === null) return Promise.resolve(localUnavailable());
    let intent = copyIntent(rawIntent);
    let ownedConfirmation = null;
    if (!intent) return Promise.resolve(localUnavailable());
    if (intent.type === 'PANEL_CONFIRM_PIXEL_CAPTURE') return Promise.resolve(localUnavailable());
    if (PAGE_MARKERS_TYPES.has(intent.type)) {
      const markerIntent = copyPageMarkersIntent(intent, markerDetailCount);
      if (!markerIntent || !['result', 'view-only'].includes(sessionState) || auditId === null || sessionId === null ||
        markerIntent.modelRevision !== markerRevision || !Number.isSafeInteger(markerRevision) || markerRevision < 1) {
        return Promise.resolve(localUnavailable());
      }
      intent = freeze({ ...markerIntent, sessionCapabilityId: sessionId, auditId });
    }
    if (intent.type === 'CONFIRM_PIXEL_CAPTURE') {
      const confirmation = exact(intent, ['type', 'mode', 'accepted']);
      if (!confirmation || confirmation.accepted !== true || !PRIVACY_MODES.has(confirmation.mode) ||
        !pendingConsent || confirmation.mode !== pendingConsent.mode || auditId === null || sessionId === null) {
        return Promise.resolve(localUnavailable());
      }
      const consent = pendingConsent;
      pendingConsent = null;
      intent = consent.kind === 'attached'
        ? freeze({
            type: 'CONFIRM_PIXEL_CAPTURE', sessionCapabilityId: sessionId, auditId,
            consentId: consent.consentId, mode: consent.mode, accepted: true,
          })
        : freeze({
            type: 'PANEL_CONFIRM_PIXEL_CAPTURE', sessionCapabilityId: sessionId, auditId,
            mode: consent.mode, accepted: true,
          });
      if (consent.kind !== 'attached') {
        ownedConfirmation = freeze({
          auditId, sessionCapabilityId: sessionId, mode: consent.mode,
          categoryKey: consent.categoryKey, pageNumber: consent.pageNumber,
        });
      }
    }
    if (['PANEL_CANCEL_AUDIT', 'PANEL_OPEN_REPORT'].includes(intent.type)) {
      if (Reflect.ownKeys(intent).length !== 1 || auditId === null || sessionId === null) return Promise.resolve(localUnavailable());
      intent = freeze({ type: intent.type, sessionCapabilityId: sessionId, auditId });
    }
    if (['GET_HIGHLIGHT_AVAILABILITY', 'HIGHLIGHT_OCCURRENCE'].includes(intent.type)) {
      if (Reflect.ownKeys(intent).length !== 2 || typeof intent.occurrenceId !== 'string' ||
        !OCCURRENCE_ID.test(intent.occurrenceId) || auditId === null || sessionId === null) {
        return Promise.resolve(localUnavailable());
      }
      intent = freeze({
        type: intent.type, sessionCapabilityId: sessionId, auditId,
        occurrenceId: intent.occurrenceId,
      });
    }
    if (['GET_HIGHLIGHT_STATE', 'CLEAR_HIGHLIGHT'].includes(intent.type)) {
      if (Reflect.ownKeys(intent).length !== 1 || auditId === null || sessionId === null) return Promise.resolve(localUnavailable());
      intent = freeze({ type: intent.type, sessionCapabilityId: sessionId, auditId });
    }
    let requestId;
    try { requestId = input.createRequestId(); } catch { return Promise.resolve(localUnavailable()); }
    if (!REQUEST_ID.test(requestId ?? '') || pending.has(requestId) || timedOutRequests.has(requestId)) {
      return Promise.resolve(localUnavailable());
    }
    const port = currentPort;
    return new Promise(resolve => {
      const timer = input.setTimer(() => {
        const entry = pending.get(requestId);
        if (!entry) return;
        pending.delete(requestId);
        // The coordinator admits at most 1024 requests per Port. Bound the
        // private tombstones to the same maximum and never retain payloads.
        if (['GET_HIGHLIGHT_STATE', 'GET_HIGHLIGHT_AVAILABILITY'].includes(entry.type)) {
          rememberRetiredRequest(requestId);
        }
        settle(entry, localUnavailable());
      }, ['PANEL_OPEN_REPORT', 'PANEL_SHOW_PAGE_MARKERS'].includes(intent.type) ? REPORT_OPEN_TIMEOUT_MS : REQUEST_TIMEOUT_MS);
      pending.set(requestId, {
        resolve, timer,
        type: intent.type,
        auditId: ownDataOrNull(intent, 'auditId'),
        sessionCapabilityId: ownDataOrNull(intent, 'sessionCapabilityId'),
        sessionState,
        modelRevision: PAGE_MARKERS_TYPES.has(intent.type) ? markerRevision : null,
        ownedConfirmation,
      });
      if (ownedConfirmation) ownedConfirmationsInFlight.add(ownedConfirmation);
      try {
        port.postMessage({ protocol: 'audita-panel', version: 1, type: 'intent', requestId, envelope: intent });
      } catch {
        const entry = pending.get(requestId);
        pending.delete(requestId);
        settle(entry, localUnavailable());
        unavailable(port, true);
      }
    });
  }

  return Object.freeze({ start, stop, requestIntent, setReviewVisible });
}
