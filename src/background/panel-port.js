import { copyPanelResultBundleV1 } from '../panel/panel-result-bundle.js';
import { PANEL_SURFACE, deriveTrustedExtensionContext } from './target-capabilities.js';
import { capturedUtf8Length } from './worker-protocol.js';

export const PANEL_PORT_NAME = 'audita-panel-v1';
export const panelBootstrapStorageKey = windowId => `audita:panel-bootstrap:v1:${windowId}`;

const FACTORY_KEYS = Object.freeze([
  'chromeApi', 'sessionArea', 'readActiveJob', 'readAuditSession', 'loadPanelResultBundle',
  'rehydrateViewOnly', 'revokeViewOnly', 'epochNow', 'setTimer', 'clearTimer',
]);
const BOOTSTRAP_KEYS = Object.freeze([
  'version', 'kind', 'auditId', 'sessionCapabilityId', 'windowId', 'createdAt', 'expiresAt', 'state',
]);
const SESSION_KEYS = Object.freeze([
  'version', 'sessionCapabilityId', 'auditId', 'windowId', 'mode', 'targetBinding', 'state', 'issuedAt', 'expiresAt',
]);
const ACTIVE_KEYS = Object.freeze([
  'version', 'auditId', 'capabilityId', 'sessionCapabilityId', 'windowId', 'mode',
  'state', 'commitState', 'expectedTerminalRevision', 'createdAt', 'updatedAt',
]);
const AUDIT_ID = /^[A-Za-z0-9._:-]{1,160}$/u;
const CAPABILITY = /^[A-Za-z0-9_-]{22}$/u;
const DIGEST = /^hmac-sha256:[A-Za-z0-9_-]{43}$/u;

function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function exact(value, keys, allowNullPrototype = false) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && (!allowNullPrototype || prototype !== null)) return null;
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

function own(value, key) {
  try {
    const descriptor = value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, key) : null;
    return descriptor?.enumerable && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  } catch { return undefined; }
}

function safeChromeId(value) { return Number.isSafeInteger(value) && value >= 0; }
function safeEpoch(value) { return Number.isSafeInteger(value) && value >= 0; }

function same(left, right) {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) !== Array.isArray(right)) return false;
  const leftKeys = Reflect.ownKeys(left);
  const rightKeys = Reflect.ownKeys(right);
  return leftKeys.length === rightKeys.length && leftKeys.every(key => rightKeys.includes(key) && same(left[key], right[key]));
}

function parseBootstrap(value) {
  const record = exact(value, BOOTSTRAP_KEYS, true);
  return record && record.version === 1 && record.kind === 'audit-session' && AUDIT_ID.test(record.auditId ?? '') &&
    CAPABILITY.test(record.sessionCapabilityId ?? '') && safeChromeId(record.windowId) && safeEpoch(record.createdAt) &&
    safeEpoch(record.expiresAt) && record.expiresAt > record.createdAt && ['pending', 'consumed'].includes(record.state)
    ? freeze(record) : null;
}

function parseSession(value) {
  const record = exact(value, SESSION_KEYS, true);
  if (!record || record.version !== 1 || !CAPABILITY.test(record.sessionCapabilityId ?? '') ||
    !AUDIT_ID.test(record.auditId ?? '') || !safeChromeId(record.windowId) || record.mode !== 'attached' ||
    !['running', 'result', 'view-only', 'revoked'].includes(record.state) || !safeEpoch(record.issuedAt) ||
    !safeEpoch(record.expiresAt) || record.expiresAt <= record.issuedAt) return null;
  const viewOnlyBinding = exact(record.targetBinding, ['kind'], true);
  const attachedBinding = exact(record.targetBinding, ['kind', 'tabId', 'documentId', 'urlSessionDigest'], true);
  const validViewOnly = viewOnlyBinding?.kind === 'view-only' && ['view-only', 'revoked'].includes(record.state);
  const validAttached = attachedBinding?.kind === 'attached' && safeChromeId(attachedBinding.tabId) &&
    typeof attachedBinding.documentId === 'string' && attachedBinding.documentId.length > 0 &&
    attachedBinding.documentId.length <= 512 && DIGEST.test(attachedBinding.urlSessionDigest ?? '') &&
    record.state !== 'view-only';
  if (!validViewOnly && !validAttached) return null;
  return freeze(record);
}

function parseActive(value) {
  if (value === null) return null;
  const record = exact(value, ACTIVE_KEYS, true);
  if (!record || record.version !== 1 || !AUDIT_ID.test(record.auditId ?? '') ||
    !CAPABILITY.test(record.capabilityId ?? '') || !CAPABILITY.test(record.sessionCapabilityId ?? '') ||
    !safeChromeId(record.windowId) || record.mode !== 'attached' || !safeEpoch(record.createdAt) ||
    !safeEpoch(record.updatedAt) || record.updatedAt < record.createdAt) return undefined;
  if (record.state === 'running' && record.commitState === 'none' && record.expectedTerminalRevision === null) return freeze(record);
  if (record.state === 'finalizing' && ['pending', 'confirmed'].includes(record.commitState) && record.expectedTerminalRevision === 1) return freeze(record);
  return undefined;
}

function hello(value) {
  const record = exact(value, ['protocol', 'version', 'type']);
  return record && record.protocol === 'audita-panel' && record.version === 1 && record.type === 'bootstrap' &&
    capturedUtf8Length(record) <= 4096;
}

function packet(state, auditId, sessionCapabilityId, result) {
  return freeze({
    protocol: 'audita-panel', version: 1, type: 'bootstrap-result',
    state, auditId, sessionCapabilityId, result,
  });
}

function deniedRegistration() {
  return Object.freeze({ registered: false, delivered: false, code: 'AUDIT_REHYDRATE_DENIED' });
}

export function createPanelPortCoordinator(raw) {
  const input = exact(raw, FACTORY_KEYS);
  if (!input || typeof input.chromeApi?.runtime?.id !== 'string' || typeof input.chromeApi.runtime.getContexts !== 'function' ||
    typeof input.sessionArea?.get !== 'function' || typeof input.sessionArea.set !== 'function' ||
    typeof input.readActiveJob !== 'function' || typeof input.readAuditSession !== 'function' ||
    typeof input.loadPanelResultBundle !== 'function' || typeof input.rehydrateViewOnly !== 'function' ||
    typeof input.revokeViewOnly !== 'function' || typeof input.epochNow !== 'function' ||
    typeof input.setTimer !== 'function' || typeof input.clearTimer !== 'function') {
    throw new TypeError('PANEL_PORT_COORDINATOR_INVALID');
  }

  const windowTails = new Map();
  const bindings = new WeakMap();
  const liveByWindow = new Map();
  const activePublicationScopes = new Set();
  let scopeMarker = null;

  function withWindowLock(windowId, fn) {
    if (!safeChromeId(windowId) || typeof fn !== 'function') return Promise.reject(new TypeError('PANEL_WINDOW_LOCK_DENIED'));
    if (scopeMarker?.windowId === windowId) return Promise.reject(new Error('PANEL_WINDOW_LOCK_REENTRANT'));
    const previous = windowTails.get(windowId) ?? Promise.resolve();
    const operation = previous.then(async () => {
      const marker = { windowId };
      scopeMarker = marker;
      activePublicationScopes.add(windowId);
      let returned;
      try { returned = fn(); }
      finally { if (scopeMarker === marker) scopeMarker = null; }
      try { return await returned; }
      finally {
        activePublicationScopes.delete(windowId);
      }
    }, async () => {
      const marker = { windowId };
      scopeMarker = marker;
      activePublicationScopes.add(windowId);
      let returned;
      try { returned = fn(); }
      finally { if (scopeMarker === marker) scopeMarker = null; }
      try { return await returned; }
      finally {
        activePublicationScopes.delete(windowId);
      }
    });
    windowTails.set(windowId, operation.catch(() => {}));
    return operation;
  }

  function scoped(windowId) { return activePublicationScopes.has(windowId); }

  async function readBootstrap(windowId) {
    const key = panelBootstrapStorageKey(windowId);
    const read = async () => {
      const envelope = await input.sessionArea.get(key);
      const rawValue = own(envelope, key);
      if (rawValue === undefined) return null;
      const value = parseBootstrap(rawValue);
      if (!value) throw new Error('PANEL_BOOTSTRAP_DENIED');
      return value;
    };
    const first = await read();
    const second = await read();
    if (!same(first, second)) throw new Error('PANEL_BOOTSTRAP_DENIED');
    return first;
  }

  async function writeBootstrap(record) {
    const canonical = parseBootstrap(record);
    if (!canonical) throw new Error('PANEL_BOOTSTRAP_DENIED');
    const key = panelBootstrapStorageKey(canonical.windowId);
    await input.sessionArea.set({ [key]: canonical });
    const confirmed = await readBootstrap(canonical.windowId);
    if (!same(confirmed, canonical)) throw new Error('PANEL_BOOTSTRAP_DENIED');
    return confirmed;
  }

  async function readSession(sessionCapabilityId, auditId) {
    const value = parseSession(await input.readAuditSession({ sessionCapabilityId, auditId }));
    if (!value || value.sessionCapabilityId !== sessionCapabilityId || value.auditId !== auditId) throw new Error('PANEL_SESSION_DENIED');
    return value;
  }

  async function readActive() {
    const value = parseActive(await input.readActiveJob());
    if (value === undefined) throw new Error('PANEL_ACTIVE_DENIED');
    return value;
  }

  function snapshotSender(port) {
    const sender = own(port, 'sender');
    const id = own(sender, 'id');
    const documentId = own(sender, 'documentId');
    const url = own(sender, 'url');
    return id === input.chromeApi.runtime.id && typeof documentId === 'string' && documentId && typeof url === 'string'
      ? freeze({ id, documentId, url }) : null;
  }

  async function proveSender(sender) {
    return deriveTrustedExtensionContext({ sender, chromeApi: input.chromeApi, surface: PANEL_SURFACE });
  }

  function connected(binding) {
    return binding && binding.state !== 'disconnected' && bindings.get(binding.port) === binding;
  }

  function removeTemporary(binding) {
    if (binding.deadline !== null) {
      input.clearTimer(binding.deadline);
      binding.deadline = null;
    }
    try { binding.port.onMessage.removeListener(binding.onHello); } catch { /* fixed cleanup */ }
  }

  function disconnect(binding) {
    if (!binding || binding.state === 'disconnected') return false;
    binding.state = 'disconnected';
    removeTemporary(binding);
    try { binding.port.onMessage.removeListener(binding.onBoundMessage); } catch { /* fixed cleanup */ }
    try { binding.port.onDisconnect.removeListener(binding.onDisconnect); } catch { /* fixed cleanup */ }
    bindings.delete(binding.port);
    if (binding.windowId !== null && liveByWindow.get(binding.windowId) === binding) liveByWindow.delete(binding.windowId);
    try { binding.port.disconnect(); } catch { /* fixed cleanup */ }
    return true;
  }

  async function reprove(binding) {
    const context = await proveSender(binding.sender);
    return connected(binding) && context.windowId === binding.windowId && context.issuer.documentId === binding.sender.documentId
      ? context : null;
  }

  function send(binding, value) {
    if (!connected(binding)) throw new Error('PANEL_PORT_DISCONNECTED');
    binding.port.postMessage(value);
  }

  function bind(binding, windowId, state, auditId = null, sessionCapabilityId = null) {
    binding.windowId = windowId;
    binding.state = state;
    binding.auditId = auditId;
    binding.sessionCapabilityId = sessionCapabilityId;
    liveByWindow.set(windowId, binding);
  }

  async function runningCorrelation(bootstrap) {
    const session = await readSession(bootstrap.sessionCapabilityId, bootstrap.auditId);
    const active = await readActive();
    return session.state === 'running' && session.windowId === bootstrap.windowId && active?.state === 'running' &&
      active.auditId === bootstrap.auditId && active.sessionCapabilityId === bootstrap.sessionCapabilityId &&
      active.windowId === bootstrap.windowId ? { session, active } : null;
  }

  async function deliverRunning(binding, bootstrap, rotate) {
    if (!await runningCorrelation(bootstrap)) throw new Error('PANEL_RUNNING_DENIED');
    let current = bootstrap;
    if (rotate) current = await writeBootstrap({ ...bootstrap, state: 'pending' });
    if (current.state !== 'pending') throw new Error('PANEL_BOOTSTRAP_DENIED');
    current = await writeBootstrap({ ...current, state: 'consumed' });
    if (!await reprove(binding)) throw new Error('PANEL_CONTEXT_DENIED');
    send(binding, packet('running', current.auditId, current.sessionCapabilityId, null));
    bind(binding, current.windowId, 'bound-session', current.auditId, current.sessionCapabilityId);
    return true;
  }

  async function recoverTerminal(binding, bootstrap, session) {
    let minted = null;
    try {
      if (await readActive() !== null || !['result', 'view-only', 'revoked'].includes(session.state)) throw new Error('PANEL_TERMINAL_DENIED');
      const resultBundle = copyPanelResultBundleV1(await input.loadPanelResultBundle({ auditId: bootstrap.auditId }));
      minted = await input.rehydrateViewOnly({ auditId: bootstrap.auditId, windowId: bootstrap.windowId, mode: 'attached' });
      if (minted?.ok !== true || minted.auditId !== bootstrap.auditId || !CAPABILITY.test(minted.sessionCapabilityId ?? '') ||
        !safeEpoch(minted.expiresAt)) throw new Error('PANEL_TERMINAL_DENIED');
      const createdAt = input.epochNow();
      if (!safeEpoch(createdAt) || createdAt >= minted.expiresAt) throw new Error('PANEL_TERMINAL_DENIED');
      const replacement = await writeBootstrap({
        version: 1, kind: 'audit-session', auditId: bootstrap.auditId,
        sessionCapabilityId: minted.sessionCapabilityId, windowId: bootstrap.windowId,
        createdAt, expiresAt: minted.expiresAt, state: 'consumed',
      });
      if (!await reprove(binding) || await readActive() !== null) throw new Error('PANEL_TERMINAL_DENIED');
      send(binding, packet('view-only', replacement.auditId, replacement.sessionCapabilityId, resultBundle));
      bind(binding, replacement.windowId, 'bound-session', replacement.auditId, replacement.sessionCapabilityId);
      return true;
    } catch {
      if (minted?.ok === true && CAPABILITY.test(minted.sessionCapabilityId ?? '')) {
        let revoked = false;
        try { revoked = await input.revokeViewOnly({ sessionCapabilityId: minted.sessionCapabilityId, auditId: bootstrap.auditId }); }
        catch { revoked = false; }
        if (!revoked) return false;
      }
      return false;
    }
  }

  async function handleHello(binding) {
    try {
      const admission = await binding.admission;
      if (!admission || !connected(binding)) throw new Error('PANEL_CONTEXT_DENIED');
      await withWindowLock(admission.windowId, async () => {
        binding.windowId = admission.windowId;
        if (!await reprove(binding)) throw new Error('PANEL_CONTEXT_DENIED');
        const incumbent = liveByWindow.get(admission.windowId);
        if (incumbent && incumbent !== binding && connected(incumbent)) throw new Error('PANEL_INCUMBENT');
        const currentTime = input.epochNow();
        if (!safeEpoch(currentTime)) throw new Error('PANEL_CLOCK_DENIED');
        const bootstrap = await readBootstrap(admission.windowId);
        if (!bootstrap) {
          bind(binding, admission.windowId, 'bound-idle');
          send(binding, packet('initial', null, null, null));
          return;
        }
        if (bootstrap.windowId !== admission.windowId || bootstrap.createdAt > currentTime || bootstrap.expiresAt <= currentTime) {
          throw new Error('PANEL_BOOTSTRAP_DENIED');
        }
        const session = await readSession(bootstrap.sessionCapabilityId, bootstrap.auditId);
        if (session.windowId !== bootstrap.windowId) throw new Error('PANEL_SESSION_DENIED');
        if (session.state === 'running') {
          await deliverRunning(binding, bootstrap, bootstrap.state === 'consumed');
          return;
        }
        if (!await recoverTerminal(binding, bootstrap, session)) throw new Error('PANEL_TERMINAL_DENIED');
      });
    } catch { disconnect(binding); }
  }

  function attachPanelPort(port) {
    const name = own(port, 'name');
    const sender = snapshotSender(port);
    if (name !== PANEL_PORT_NAME || !sender || typeof port?.postMessage !== 'function' ||
      typeof port?.disconnect !== 'function' || typeof port?.onMessage?.addListener !== 'function' ||
      typeof port.onMessage.removeListener !== 'function' || typeof port?.onDisconnect?.addListener !== 'function' ||
      typeof port.onDisconnect.removeListener !== 'function') {
      try { port?.disconnect?.(); } catch { /* fixed denial */ }
      return false;
    }
    const binding = {
      port, sender, state: 'awaiting-hello', windowId: null, auditId: null, sessionCapabilityId: null,
      admission: proveSender(sender).catch(() => null), deadline: null, onHello: null, onBoundMessage: null, onDisconnect: null,
    };
    binding.onBoundMessage = () => disconnect(binding);
    binding.onDisconnect = () => {
      if (binding.state === 'disconnected') return;
      binding.state = 'disconnected';
      removeTemporary(binding);
      try { port.onMessage.removeListener(binding.onBoundMessage); } catch { /* fixed cleanup */ }
      bindings.delete(port);
      if (binding.windowId !== null && liveByWindow.get(binding.windowId) === binding) liveByWindow.delete(binding.windowId);
    };
    binding.onHello = value => {
      if (binding.state !== 'awaiting-hello') { disconnect(binding); return; }
      removeTemporary(binding);
      if (!hello(value)) { disconnect(binding); return; }
      binding.state = 'proving-hello';
      port.onMessage.addListener(binding.onBoundMessage);
      void handleHello(binding);
    };
    bindings.set(port, binding);
    port.onMessage.addListener(binding.onHello);
    port.onDisconnect.addListener(binding.onDisconnect);
    binding.deadline = input.setTimer(() => disconnect(binding), 5000);
    return true;
  }

  function publishRegisteredBootstrap(rawArgs) {
    const args = exact(rawArgs, ['auditId', 'sessionCapabilityId', 'windowId', 'createdAt', 'expiresAt']);
    if (!args || !scoped(args.windowId)) return Promise.resolve(false);
    return (async () => {
      try {
        const session = await readSession(args.sessionCapabilityId, args.auditId);
        const currentTime = input.epochNow();
        if (session.state !== 'running' || session.windowId !== args.windowId || session.expiresAt !== args.expiresAt ||
          !safeEpoch(args.createdAt) || args.createdAt < session.issuedAt || args.createdAt >= args.expiresAt ||
          !safeEpoch(currentTime) || currentTime >= args.expiresAt) return false;
        const bootstrap = await writeBootstrap({
          version: 1, kind: 'audit-session', auditId: args.auditId, sessionCapabilityId: args.sessionCapabilityId,
          windowId: args.windowId, createdAt: args.createdAt, expiresAt: args.expiresAt, state: 'pending',
        });
        const binding = liveByWindow.get(args.windowId);
        if (connected(binding) && binding.state === 'bound-idle') {
          input.setTimer(() => {
            void withWindowLock(args.windowId, async () => {
              try { await deliverRunning(binding, await readBootstrap(args.windowId), false); } catch { /* reconnect owns recovery */ }
            });
          }, 0);
        }
        return Boolean(bootstrap);
      } catch { return false; }
    })();
  }

  function publishResult(rawArgs) {
    const args = exact(rawArgs, ['auditId', 'sessionCapabilityId', 'windowId', 'state', 'resultBundle']);
    if (!args || !scoped(args.windowId)) return Promise.resolve(false);
    return (async () => {
      try {
        if (!['result', 'view-only'].includes(args.state)) return false;
        const resultBundle = copyPanelResultBundleV1(args.resultBundle);
        if (resultBundle.auditId !== args.auditId) return false;
        const session = await readSession(args.sessionCapabilityId, args.auditId);
        const bootstrap = await readBootstrap(args.windowId);
        const binding = liveByWindow.get(args.windowId);
        if (session.state !== args.state || session.windowId !== args.windowId || !bootstrap ||
          bootstrap.auditId !== args.auditId || bootstrap.sessionCapabilityId !== args.sessionCapabilityId ||
          !connected(binding) || binding.auditId !== args.auditId || binding.sessionCapabilityId !== args.sessionCapabilityId ||
          !await reprove(binding)) return false;
        send(binding, packet(args.state, args.auditId, args.sessionCapabilityId, resultBundle));
        return true;
      } catch { return false; }
    })();
  }

  function registerAndPublishViewOnly(rawArgs) {
    const args = exact(rawArgs, ['auditId', 'sessionCapabilityId', 'windowId', 'createdAt', 'expiresAt', 'resultBundle']);
    if (!args || !scoped(args.windowId)) return Promise.resolve(deniedRegistration());
    return (async () => {
      let registered = false;
      try {
        const resultBundle = copyPanelResultBundleV1(args.resultBundle);
        if (resultBundle.auditId !== args.auditId) return deniedRegistration();
        const session = await readSession(args.sessionCapabilityId, args.auditId);
        const currentTime = input.epochNow();
        if (session.state !== 'view-only' || session.windowId !== args.windowId || session.expiresAt !== args.expiresAt ||
          !safeEpoch(args.createdAt) || args.createdAt < session.issuedAt || args.createdAt >= args.expiresAt ||
          !safeEpoch(currentTime) || currentTime >= args.expiresAt || await readActive() !== null) return deniedRegistration();
        const existing = await readBootstrap(args.windowId);
        if (existing) {
          if (existing.auditId !== args.auditId || existing.windowId !== args.windowId) return deniedRegistration();
          const oldSession = await readSession(existing.sessionCapabilityId, existing.auditId);
          if (!['result', 'view-only', 'revoked'].includes(oldSession.state) || oldSession.windowId !== args.windowId) return deniedRegistration();
        }
        const pending = await writeBootstrap({
          version: 1, kind: 'audit-session', auditId: args.auditId, sessionCapabilityId: args.sessionCapabilityId,
          windowId: args.windowId, createdAt: args.createdAt, expiresAt: args.expiresAt, state: 'pending',
        });
        registered = true;
        const binding = liveByWindow.get(args.windowId);
        if (!connected(binding)) return Object.freeze({ registered: true, delivered: false });
        if (binding.auditId && binding.auditId !== args.auditId) return Object.freeze({ registered: true, delivered: false });
        const consumed = await writeBootstrap({ ...pending, state: 'consumed' });
        if (!await reprove(binding)) return Object.freeze({ registered: true, delivered: false });
        send(binding, packet('view-only', consumed.auditId, consumed.sessionCapabilityId, resultBundle));
        bind(binding, args.windowId, 'bound-session', args.auditId, args.sessionCapabilityId);
        return Object.freeze({ registered: true, delivered: true });
      } catch {
        return registered ? Object.freeze({ registered: true, delivered: false }) : deniedRegistration();
      }
    })();
  }

  function disconnectSession(rawArgs) {
    const args = exact(rawArgs, ['auditId', 'sessionCapabilityId', 'windowId', 'reasonCode']);
    if (!args || !scoped(args.windowId) || typeof args.reasonCode !== 'string' || !args.reasonCode) return Promise.resolve(false);
    return (async () => {
      try {
        const binding = liveByWindow.get(args.windowId);
        if (connected(binding) && binding.auditId === args.auditId &&
          binding.sessionCapabilityId === args.sessionCapabilityId) disconnect(binding);
        const bootstrap = await readBootstrap(args.windowId);
        if (bootstrap === null) return true;
        if (bootstrap.auditId !== args.auditId || bootstrap.sessionCapabilityId !== args.sessionCapabilityId ||
          bootstrap.windowId !== args.windowId) return false;
        await input.sessionArea.remove(panelBootstrapStorageKey(args.windowId));
        return await readBootstrap(args.windowId) === null;
      } catch { return false; }
    })();
  }

  return Object.freeze({
    attachPanelPort,
    withWindowLock,
    publishRegisteredBootstrap,
    publishResult,
    registerAndPublishViewOnly,
    disconnectSession,
  });
}
