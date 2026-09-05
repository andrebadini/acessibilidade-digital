import { canonicalAuditId } from '../storage/audit-retention.js';
import { capturedUtf8Length } from './worker-protocol.js';

export const REPORT_PORT_NAME = 'audita-report-v1';

const AUDIT_ID = /^[A-Za-z0-9._:-]{1,160}$/u;
const CAPABILITY = /^[A-Za-z0-9_-]{22}$/u;
const OCCURRENCE_ID = /^[A-Za-z0-9._:-]{1,200}$/u;

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

function hello(value) {
  const packet = exact(value, ['protocol', 'version', 'type', 'auditId', 'sessionCapabilityId']);
  return packet && packet.protocol === 'audita-report' && packet.version === 1 && packet.type === 'hello' &&
    AUDIT_ID.test(packet.auditId ?? '') && CAPABILITY.test(packet.sessionCapabilityId ?? '') &&
    capturedUtf8Length(packet) <= 4096 ? Object.freeze(packet) : null;
}

function highlightEvent(value) {
  const event = exact(value, ['version', 'type', 'auditId', 'occurrenceId', 'state']);
  return event && event.version === 1 && event.type === 'HIGHLIGHT_STATE_CHANGED' && AUDIT_ID.test(event.auditId ?? '') &&
    ((event.state === 'active' && OCCURRENCE_ID.test(event.occurrenceId ?? '')) ||
      (event.state === 'clear' && event.occurrenceId === null)) &&
    capturedUtf8Length(event) <= 4096 ? Object.freeze(event) : null;
}

function highlightSnapshot(value, auditId) {
  const result = exact(value, ['ok', 'highlight']);
  const clear = exact(result?.highlight, ['state']);
  const active = exact(result?.highlight, ['state', 'occurrenceId']);
  if (result?.ok === true && clear?.state === 'clear') {
    return highlightEvent({
      version: 1, type: 'HIGHLIGHT_STATE_CHANGED', auditId, occurrenceId: null, state: 'clear',
    });
  }
  if (result?.ok === true && active?.state === 'active' && OCCURRENCE_ID.test(active.occurrenceId ?? '')) {
    return highlightEvent({
      version: 1, type: 'HIGHLIGHT_STATE_CHANGED', auditId,
      occurrenceId: active.occurrenceId, state: 'active',
    });
  }
  return null;
}

export function createReportPortCoordinator(raw) {
  const input = exact(raw, ['reportLaunch', 'readHighlightState', 'setTimer', 'clearTimer']);
  if (!input || typeof input.reportLaunch?.authorizeIntent !== 'function' || typeof input.setTimer !== 'function' ||
    typeof input.clearTimer !== 'function' || typeof input.readHighlightState !== 'function') {
    throw new TypeError('REPORT_PORT_COORDINATOR_INVALID');
  }
  const bindings = new WeakMap();
  const live = new Set();

  function disconnect(port) {
    const binding = bindings.get(port);
    if (!binding) return false;
    bindings.delete(port);
    live.delete(binding);
    try { input.clearTimer(binding.timer); } catch {}
    try { port.onMessage.removeListener(binding.onMessage); } catch {}
    try { port.onDisconnect.removeListener(binding.onDisconnect); } catch {}
    try { port.disconnect(); } catch {}
    return true;
  }

  function attachReportPort(port) {
    if (!port || port.name !== REPORT_PORT_NAME || !port.sender || typeof port.postMessage !== 'function' ||
      typeof port.disconnect !== 'function' || typeof port.onMessage?.addListener !== 'function' ||
      typeof port.onMessage.removeListener !== 'function' || typeof port.onDisconnect?.addListener !== 'function' ||
      typeof port.onDisconnect.removeListener !== 'function') return false;
    let binding;
    const onDisconnect = () => disconnect(port);
    const onMessage = value => {
      if (binding.auditId !== null) { disconnect(port); return; }
      const packet = hello(value);
      if (!packet) { disconnect(port); return; }
      binding.auditId = packet.auditId;
      binding.sessionCapabilityId = packet.sessionCapabilityId;
      void input.reportLaunch.authorizeIntent({
        sessionCapabilityId: packet.sessionCapabilityId, auditId: packet.auditId, intent: 'export', sender: port.sender,
      }).then(async authorization => {
        if (bindings.get(port) !== binding || authorization?.ok !== true || authorization.auditId !== packet.auditId ||
          authorization.sessionCapabilityId !== packet.sessionCapabilityId || authorization.intent !== 'export') {
          disconnect(port); return;
        }
        binding.ready = true;
        binding.syncing = true;
        try { input.clearTimer(binding.timer); } catch {}
        let current;
        try {
          current = await input.readHighlightState({
            sessionCapabilityId: packet.sessionCapabilityId,
            auditId: packet.auditId,
            sender: port.sender,
          });
        } catch {
          disconnect(port); return;
        }
        if (bindings.get(port) !== binding) return;
        const snapshot = highlightSnapshot(current, packet.auditId);
        const next = binding.pendingEvent ?? snapshot;
        binding.pendingEvent = null;
        binding.syncing = false;
        if (!next) { disconnect(port); return; }
        try { port.postMessage(next); } catch { disconnect(port); }
      }, () => disconnect(port));
    };
    binding = {
      port, ready: false, syncing: false, pendingEvent: null,
      auditId: null, sessionCapabilityId: null, timer: null, onMessage, onDisconnect,
    };
    binding.timer = input.setTimer(() => disconnect(port), 5_000);
    bindings.set(port, binding);
    live.add(binding);
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(onDisconnect);
    return true;
  }

  async function publishHighlightState(rawEvent) {
    const event = highlightEvent(rawEvent);
    if (!event) return Object.freeze({ delivered: 0 });
    let delivered = 0;
    for (const binding of [...live]) {
      if (bindings.get(binding.port) !== binding || !binding.ready || binding.auditId !== event.auditId) continue;
      let authorization;
      try {
        authorization = await input.reportLaunch.authorizeIntent({
          sessionCapabilityId: binding.sessionCapabilityId, auditId: binding.auditId, intent: 'highlight', sender: binding.port.sender,
        });
      } catch { authorization = null; }
      if (bindings.get(binding.port) !== binding) continue;
      if (authorization?.ok !== true || authorization.intent !== 'highlight') { disconnect(binding.port); continue; }
      if (binding.syncing) {
        binding.pendingEvent = event;
        delivered += 1;
        continue;
      }
      try { binding.port.postMessage(event); delivered += 1; } catch { disconnect(binding.port); }
    }
    return Object.freeze({ delivered });
  }

  async function clearAudit(auditId) {
    try { canonicalAuditId(auditId); } catch { throw new TypeError('REPORT_PORT_CLEANUP_DENIED'); }
    let cleared = 0;
    for (const binding of [...live]) {
      if (binding.auditId === auditId && disconnect(binding.port)) cleared += 1;
    }
    return cleared;
  }

  return Object.freeze({ attachReportPort, publishHighlightState, clearAudit });
}
