import { copyPanelResultBundleV1 } from './panel-result-bundle.js';

const PORT_NAME = 'audita-panel-v1';
const SESSION_ID = /^[A-Za-z0-9_-]{20,240}$/u;
const AUDIT_ID = /^[A-Za-z0-9._:-]{1,160}$/u;
const RECONNECT_DELAYS = Object.freeze([250, 500, 1000, 2000, 5000]);
const PACKET_KEYS = Object.freeze([
  'protocol', 'version', 'type', 'state', 'auditId', 'sessionCapabilityId', 'result',
]);

function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
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

function parsePacket(value) {
  const packet = exact(value, PACKET_KEYS);
  if (!packet || packet.protocol !== 'audita-panel' || packet.version !== 1 || packet.type !== 'bootstrap-result') return null;
  if (packet.state === 'initial') {
    return packet.auditId === null && packet.sessionCapabilityId === null && packet.result === null ? freeze(packet) : null;
  }
  if (!AUDIT_ID.test(packet.auditId ?? '') || !SESSION_ID.test(packet.sessionCapabilityId ?? '')) return null;
  if (packet.state === 'running') return packet.result === null ? freeze(packet) : null;
  if (!['result', 'view-only'].includes(packet.state)) return null;
  try {
    const result = copyPanelResultBundleV1(packet.result);
    return result.auditId === packet.auditId ? freeze({ ...packet, result }) : null;
  } catch { return null; }
}

function localUnavailable() {
  return Object.freeze({ ok: false, code: 'PANEL_SESSION_UNAVAILABLE' });
}

export function createPanelSessionPortClient(raw) {
  const input = exact(raw, ['chromeApi', 'getWindowId', 'onBootstrapResult', 'onStatus', 'setTimer', 'clearTimer']);
  if (!input || typeof input.chromeApi?.runtime?.connect !== 'function' ||
    typeof input.chromeApi.runtime.sendMessage !== 'function' || typeof input.getWindowId !== 'function' ||
    typeof input.onBootstrapResult !== 'function' ||
    typeof input.onStatus !== 'function' || typeof input.setTimer !== 'function' || typeof input.clearTimer !== 'function') {
    throw new TypeError('PANEL_SESSION_CLIENT_INVALID');
  }

  let started = false;
  let connecting = false;
  let currentPort = null;
  let reconnectTimer = null;
  let reconnectIndex = 0;
  let auditId = null;
  let sessionId = null;
  const bindings = new WeakMap();

  const notifyStatus = status => {
    try { input.onStatus(status); } catch { /* UI callbacks never own transport state. */ }
  };
  const notifyBootstrap = value => {
    try { input.onBootstrapResult(value); } catch { /* UI callbacks never own transport state. */ }
  };
  const clearCorrelation = () => { auditId = null; sessionId = null; };

  function detach(port, disconnect) {
    if (!port) return;
    const binding = bindings.get(port);
    try { if (binding) port.onMessage?.removeListener?.(binding.onMessage); } catch { /* fixed cleanup */ }
    try { if (binding) port.onDisconnect?.removeListener?.(binding.onDisconnect); } catch { /* fixed cleanup */ }
    bindings.delete(port);
    if (disconnect) {
      try { port.disconnect?.(); } catch { /* fixed cleanup */ }
    }
    if (currentPort === port) currentPort = null;
  }

  function scheduleReconnect() {
    if (!started || reconnectTimer !== null) return;
    const delay = RECONNECT_DELAYS[Math.min(reconnectIndex, RECONNECT_DELAYS.length - 1)];
    reconnectIndex = Math.min(reconnectIndex + 1, RECONNECT_DELAYS.length);
    reconnectTimer = input.setTimer(() => {
      reconnectTimer = null;
      if (started) connect();
    }, delay);
  }

  function unavailable(port, disconnect = false) {
    clearCorrelation();
    detach(port, disconnect);
    notifyStatus('Painel indisponível; tentando reconectar.');
    scheduleReconnect();
  }

  function receive(port, rawPacket) {
    if (!started || currentPort !== port) return;
    const packet = parsePacket(rawPacket);
    if (!packet) {
      unavailable(port, true);
      return;
    }
    reconnectIndex = 0;
    if (packet.state === 'initial') clearCorrelation();
    else {
      auditId = packet.auditId;
      sessionId = packet.sessionCapabilityId;
    }
    notifyStatus('Painel conectado.');
    notifyBootstrap(freeze({ state: packet.state, auditId: packet.auditId, result: packet.result }));
  }

  async function connect() {
    if (!started || currentPort !== null || connecting) return;
    connecting = true;
    let windowId;
    try { windowId = await input.getWindowId(); }
    catch {
      connecting = false;
      unavailable(null);
      return;
    }
    if (!started || currentPort !== null) {
      connecting = false;
      return;
    }
    if (!Number.isSafeInteger(windowId) || windowId < 0) {
      connecting = false;
      unavailable(null);
      return;
    }
    let port;
    try { port = input.chromeApi.runtime.connect({ name: PORT_NAME }); }
    catch {
      connecting = false;
      unavailable(null);
      return;
    }
    if (!port || typeof port.postMessage !== 'function' ||
      typeof port.onMessage?.addListener !== 'function' || typeof port.onDisconnect?.addListener !== 'function') {
      connecting = false;
      unavailable(port, true);
      return;
    }
    currentPort = port;
    const onMessage = message => receive(port, message);
    const onDisconnect = () => {
      if (currentPort !== port) return;
      unavailable(port, false);
    };
    bindings.set(port, { onMessage, onDisconnect });
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(onDisconnect);
    notifyStatus('Conectando ao painel.');
    connecting = false;
    try { port.postMessage({ protocol: 'audita-panel', version: 1, type: 'bootstrap', windowId }); }
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
    clearCorrelation();
    if (reconnectTimer !== null) {
      input.clearTimer(reconnectTimer);
      reconnectTimer = null;
    }
    detach(currentPort, true);
    return true;
  }

  async function requestSessionIntent(rawIntent) {
    const intent = exact(rawIntent, ['type']);
    if (!intent || !['PANEL_CANCEL_AUDIT', 'PANEL_OPEN_REPORT'].includes(intent.type) ||
      auditId === null || sessionId === null) return localUnavailable();
    const expectedAuditId = auditId;
    const expectedSessionId = sessionId;
    let windowId;
    try { windowId = await input.getWindowId(); }
    catch { return localUnavailable(); }
    if (!Number.isSafeInteger(windowId) || windowId < 0 ||
      auditId !== expectedAuditId || sessionId !== expectedSessionId) return localUnavailable();
    const message = {
      type: intent.type, sessionCapabilityId: expectedSessionId, auditId: expectedAuditId, windowId,
    };
    try {
      return await new Promise(resolve => {
        let settled = false;
        const finish = value => { if (!settled) { settled = true; resolve(value); } };
        const result = input.chromeApi.runtime.sendMessage(message, finish);
        if (result && typeof result.then === 'function') result.then(finish, () => finish(localUnavailable()));
      });
    } catch { return localUnavailable(); }
  }

  return Object.freeze({ start, stop, requestSessionIntent });
}
