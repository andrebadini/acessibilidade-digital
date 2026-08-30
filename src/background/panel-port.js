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
const START_JOURNAL_KEY = 'audita:start-journal:v1';

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

function recoveryRequiredRegistration() {
  return Object.freeze({ registered: false, delivered: false, code: 'AUDIT_RECOVERY_REQUIRED' });
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
  const scopeStates = new WeakMap();
  const scopeDeniedSentinel = Object.freeze(Object.create(null));
  const activeConflictSentinel = Object.freeze(Object.create(null));
  let scopeMarker = null;

  function assertScope(scope, windowId) {
    const state = scopeStates.get(scope);
    if (!state?.active || state.windowId !== windowId) throw scopeDeniedSentinel;
  }

  function exposeScopeFailure(error) {
    if (error === scopeDeniedSentinel) throw new Error('PANEL_SCOPE_DENIED');
    throw error;
  }

  function createScope(windowId) {
    let scope;
    const invoke = operation => rawArgs => {
      try {
        assertScope(scope, windowId);
        if (own(rawArgs, 'windowId') !== windowId) return Promise.resolve(false);
        return Promise.resolve(operation(rawArgs, () => assertScope(scope, windowId))).catch(exposeScopeFailure);
      } catch (error) {
        return Promise.reject(error === scopeDeniedSentinel ? new Error('PANEL_SCOPE_DENIED') : error);
      }
    };
    scope = Object.freeze({
      registerPendingBootstrap: invoke(registerPendingBootstrap),
      publishRegisteredBootstrap: invoke(publishRegisteredBootstrap),
      publishResult: invoke(publishResult),
      registerAndPublishViewOnly: invoke(registerAndPublishViewOnly),
      disconnectSession: invoke(disconnectSession),
    });
    scopeStates.set(scope, { windowId, active: true });
    return scope;
  }

  function withWindowLock(windowId, fn) {
    if (!safeChromeId(windowId) || typeof fn !== 'function') return Promise.reject(new TypeError('PANEL_WINDOW_LOCK_DENIED'));
    if (scopeMarker?.windowId === windowId) return Promise.reject(new Error('PANEL_WINDOW_LOCK_REENTRANT'));
    const previous = windowTails.get(windowId) ?? Promise.resolve();
    const run = async () => {
      const marker = { windowId };
      const scope = createScope(windowId);
      scopeMarker = marker;
      let returned;
      try {
        try { returned = fn(scope); }
        finally { if (scopeMarker === marker) scopeMarker = null; }
        return await returned;
      }
      finally { scopeStates.get(scope).active = false; }
    };
    const operation = previous.then(run, run);
    windowTails.set(windowId, operation.catch(() => {}));
    return operation;
  }

  function reassert(assertOwned) { assertOwned?.(); }

  async function readBootstrap(windowId, assertOwned = null) {
    const key = panelBootstrapStorageKey(windowId);
    const read = async () => {
      const envelope = await input.sessionArea.get(key);
      reassert(assertOwned);
      const rawValue = own(envelope, key);
      if (rawValue === undefined) return null;
      const value = parseBootstrap(rawValue);
      if (!value) throw new Error('PANEL_BOOTSTRAP_DENIED');
      return value;
    };
    const first = await read();
    reassert(assertOwned);
    const second = await read();
    reassert(assertOwned);
    if (!same(first, second)) throw new Error('PANEL_BOOTSTRAP_DENIED');
    return first;
  }

  function replacementOutcome(state, record, rollback = null) {
    return Object.freeze({ state, record, rollback });
  }

  async function reconcileBootstrapReplacement(operation, assertOwned) {
    let current;
    try {
      current = await readBootstrap(operation.candidate.windowId, assertOwned);
      reassert(assertOwned);
    } catch (error) {
      if (error === scopeDeniedSentinel) throw error;
      return replacementOutcome('recovery-required', null);
    }
    if (same(current, operation.previous)) return replacementOutcome('rolled-back', operation.previous);
    if (!same(current, operation.candidate)) return replacementOutcome('recovery-required', null);

    try {
      reassert(assertOwned);
      if (operation.previous === null) {
        await input.sessionArea.remove(panelBootstrapStorageKey(operation.candidate.windowId));
      } else {
        await input.sessionArea.set({
          [panelBootstrapStorageKey(operation.candidate.windowId)]: operation.previous,
        });
      }
      reassert(assertOwned);
    } catch (error) {
      if (error === scopeDeniedSentinel) throw error;
      // The storage effect may have landed before rejecting; the confirming read below is authoritative.
    }

    try {
      const restored = await readBootstrap(operation.candidate.windowId, assertOwned);
      reassert(assertOwned);
      return same(restored, operation.previous)
        ? replacementOutcome('rolled-back', operation.previous)
        : replacementOutcome('recovery-required', null);
    } catch (error) {
      if (error === scopeDeniedSentinel) throw error;
      return replacementOutcome('recovery-required', null);
    }
  }

  async function replaceBootstrap(previousValue, candidateValue, assertOwned = null) {
    const previous = previousValue === null ? null : parseBootstrap(previousValue);
    const candidate = parseBootstrap(candidateValue);
    if (!candidate || (previousValue !== null && !previous) ||
      (previous !== null && previous.windowId !== candidate.windowId)) {
      throw new Error('PANEL_BOOTSTRAP_DENIED');
    }
    const operation = Object.freeze({ previous, candidate });
    const rollback = () => reconcileBootstrapReplacement(operation, assertOwned);
    try {
      reassert(assertOwned);
      await input.sessionArea.set({ [panelBootstrapStorageKey(candidate.windowId)]: candidate });
      reassert(assertOwned);
      const confirmed = await readBootstrap(candidate.windowId, assertOwned);
      reassert(assertOwned);
      if (same(confirmed, candidate)) return replacementOutcome('committed', confirmed, rollback);
    } catch (error) {
      if (error === scopeDeniedSentinel) throw error;
    }
    return reconcileBootstrapReplacement(operation, assertOwned);
  }

  async function readSession(sessionCapabilityId, auditId, assertOwned = null) {
    const value = parseSession(await input.readAuditSession({ sessionCapabilityId, auditId }));
    reassert(assertOwned);
    if (!value || value.sessionCapabilityId !== sessionCapabilityId || value.auditId !== auditId) throw new Error('PANEL_SESSION_DENIED');
    return value;
  }

  async function readActive(assertOwned = null) {
    const value = parseActive(await input.readActiveJob());
    reassert(assertOwned);
    if (value === undefined) throw new Error('PANEL_ACTIVE_DENIED');
    return value;
  }

  async function requireActiveAbsent(assertOwned) {
    try {
      const active = await readActive(assertOwned);
      reassert(assertOwned);
      if (active !== null) throw activeConflictSentinel;
    } catch (error) {
      if (error === scopeDeniedSentinel) throw error;
      throw activeConflictSentinel;
    }
  }

  async function confirmStartJournalAbsent(assertOwned = null) {
    const read = async () => {
      const envelope = await input.sessionArea.get(START_JOURNAL_KEY);
      reassert(assertOwned);
      return own(envelope, START_JOURNAL_KEY);
    };
    const first = await read();
    reassert(assertOwned);
    if (first !== undefined) return false;
    const second = await read();
    reassert(assertOwned);
    return second === undefined;
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

  function removeTemporary(binding, assertOwned = null) {
    if (binding.deadline !== null) {
      reassert(assertOwned);
      input.clearTimer(binding.deadline);
      binding.deadline = null;
    }
    reassert(assertOwned);
    try { binding.port.onMessage.removeListener(binding.onHello); } catch { /* fixed cleanup */ }
  }

  function disconnect(binding, assertOwned = null) {
    if (!binding || binding.state === 'disconnected') return false;
    reassert(assertOwned);
    binding.state = 'disconnected';
    removeTemporary(binding, assertOwned);
    reassert(assertOwned);
    try { binding.port.onMessage.removeListener(binding.onBoundMessage); } catch { /* fixed cleanup */ }
    reassert(assertOwned);
    try { binding.port.onDisconnect.removeListener(binding.onDisconnect); } catch { /* fixed cleanup */ }
    reassert(assertOwned);
    bindings.delete(binding.port);
    reassert(assertOwned);
    if (binding.windowId !== null && liveByWindow.get(binding.windowId) === binding) liveByWindow.delete(binding.windowId);
    reassert(assertOwned);
    try { binding.port.disconnect(); } catch { /* fixed cleanup */ }
    return true;
  }

  async function reprove(binding, assertOwned = null) {
    const context = await proveSender(binding.sender);
    reassert(assertOwned);
    return connected(binding) && context.windowId === binding.windowId && context.issuer.documentId === binding.sender.documentId
      ? context : null;
  }

  function send(binding, value, assertOwned = null) {
    reassert(assertOwned);
    if (!connected(binding)) throw new Error('PANEL_PORT_DISCONNECTED');
    binding.port.postMessage(value);
  }

  function bind(binding, windowId, state, auditId = null, sessionCapabilityId = null, assertOwned = null) {
    reassert(assertOwned);
    binding.windowId = windowId;
    binding.state = state;
    binding.auditId = auditId;
    binding.sessionCapabilityId = sessionCapabilityId;
    liveByWindow.set(windowId, binding);
  }

  async function runningCorrelation(bootstrap, assertOwned = null) {
    const session = await readSession(bootstrap.sessionCapabilityId, bootstrap.auditId, assertOwned);
    reassert(assertOwned);
    const active = await readActive(assertOwned);
    reassert(assertOwned);
    return session.state === 'running' && session.windowId === bootstrap.windowId && active?.state === 'running' &&
      active.auditId === bootstrap.auditId && active.sessionCapabilityId === bootstrap.sessionCapabilityId &&
      active.windowId === bootstrap.windowId ? { session, active } : null;
  }

  async function deliverRunning(binding, bootstrap, rotate, assertOwned = null) {
    const correlation = await runningCorrelation(bootstrap, assertOwned);
    reassert(assertOwned);
    const journalAbsent = correlation ? await confirmStartJournalAbsent(assertOwned) : false;
    reassert(assertOwned);
    if (!correlation || !journalAbsent) {
      throw new Error('PANEL_RUNNING_DENIED');
    }
    let current = bootstrap;
    if (rotate) {
      const rotation = await replaceBootstrap(bootstrap, { ...bootstrap, state: 'pending' }, assertOwned);
      reassert(assertOwned);
      if (rotation.state !== 'committed') throw new Error('PANEL_BOOTSTRAP_DENIED');
      current = rotation.record;
    }
    if (current.state !== 'pending') throw new Error('PANEL_BOOTSTRAP_DENIED');
    const consumption = await replaceBootstrap(current, { ...current, state: 'consumed' }, assertOwned);
    reassert(assertOwned);
    if (consumption.state !== 'committed') throw new Error('PANEL_BOOTSTRAP_DENIED');
    current = consumption.record;
    const context = await reprove(binding, assertOwned);
    reassert(assertOwned);
    if (!context) throw new Error('PANEL_CONTEXT_DENIED');
    send(binding, packet('running', current.auditId, current.sessionCapabilityId, null), assertOwned);
    bind(binding, current.windowId, 'bound-session', current.auditId, current.sessionCapabilityId, assertOwned);
    return true;
  }

  async function recoverTerminal(binding, bootstrap, session) {
    let minted = null;
    let replacement = null;
    try {
      if (await readActive() !== null || !['result', 'view-only', 'revoked'].includes(session.state)) throw new Error('PANEL_TERMINAL_DENIED');
      const resultBundle = copyPanelResultBundleV1(await input.loadPanelResultBundle({ auditId: bootstrap.auditId }));
      if (await readActive() !== null) throw new Error('PANEL_TERMINAL_DENIED');
      minted = await input.rehydrateViewOnly({ auditId: bootstrap.auditId, windowId: bootstrap.windowId, mode: 'attached' });
      if (await readActive() !== null) throw new Error('PANEL_TERMINAL_DENIED');
      if (minted?.ok !== true || minted.auditId !== bootstrap.auditId || !CAPABILITY.test(minted.sessionCapabilityId ?? '') ||
        !safeEpoch(minted.expiresAt)) throw new Error('PANEL_TERMINAL_DENIED');
      const createdAt = input.epochNow();
      if (!safeEpoch(createdAt) || createdAt >= minted.expiresAt) throw new Error('PANEL_TERMINAL_DENIED');
      if (await readActive() !== null) throw new Error('PANEL_TERMINAL_DENIED');
      replacement = Object.freeze({
        version: 1, kind: 'audit-session', auditId: bootstrap.auditId,
        sessionCapabilityId: minted.sessionCapabilityId, windowId: bootstrap.windowId,
        createdAt, expiresAt: minted.expiresAt, state: 'consumed',
      });
      const operation = await replaceBootstrap(bootstrap, replacement);
      if (operation.state !== 'committed') throw new Error('PANEL_TERMINAL_DENIED');
      replacement = operation;
      if (await readActive() !== null) throw new Error('PANEL_TERMINAL_DENIED');
      if (!await reprove(binding)) throw new Error('PANEL_TERMINAL_DENIED');
      if (await readActive() !== null) throw new Error('PANEL_TERMINAL_DENIED');
      send(binding, packet('view-only', replacement.record.auditId, replacement.record.sessionCapabilityId, resultBundle));
      bind(binding, replacement.record.windowId, 'bound-session', replacement.record.auditId, replacement.record.sessionCapabilityId);
      return true;
    } catch {
      if (replacement?.state === 'committed') {
        try { await replacement.rollback(); }
        catch { /* publication remains denied */ }
      }
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

  function registerPendingBootstrap(rawArgs, assertOwned) {
    const args = exact(rawArgs, ['auditId', 'sessionCapabilityId', 'windowId', 'createdAt', 'expiresAt']);
    if (!args) return Promise.resolve(false);
    return (async () => {
      try {
        assertOwned();
        const session = await readSession(args.sessionCapabilityId, args.auditId, assertOwned);
        assertOwned();
        const currentTime = input.epochNow();
        if (session.state !== 'running' || session.windowId !== args.windowId || session.expiresAt !== args.expiresAt ||
          !safeEpoch(args.createdAt) || args.createdAt < session.issuedAt || args.createdAt >= args.expiresAt ||
          !safeEpoch(currentTime) || currentTime >= args.expiresAt) return false;
        const existing = await readBootstrap(args.windowId, assertOwned);
        assertOwned();
        if (existing && (existing.auditId !== args.auditId || existing.sessionCapabilityId !== args.sessionCapabilityId ||
          existing.windowId !== args.windowId)) return false;
        assertOwned();
        const replacement = await replaceBootstrap(existing, {
          version: 1, kind: 'audit-session', auditId: args.auditId, sessionCapabilityId: args.sessionCapabilityId,
          windowId: args.windowId, createdAt: args.createdAt, expiresAt: args.expiresAt, state: 'pending',
        }, assertOwned);
        assertOwned();
        return replacement.state === 'committed';
      } catch (error) {
        if (error === scopeDeniedSentinel) throw error;
        return false;
      }
    })();
  }

  function publishRegisteredBootstrap(rawArgs, assertOwned) {
    const args = exact(rawArgs, ['auditId', 'sessionCapabilityId', 'windowId']);
    if (!args) return Promise.resolve(false);
    return (async () => {
      try {
        assertOwned();
        const bootstrap = await readBootstrap(args.windowId, assertOwned);
        assertOwned();
        if (!bootstrap || bootstrap.state !== 'pending' || bootstrap.auditId !== args.auditId ||
          bootstrap.sessionCapabilityId !== args.sessionCapabilityId || bootstrap.windowId !== args.windowId) return false;
        const session = await readSession(args.sessionCapabilityId, args.auditId, assertOwned);
        assertOwned();
        const active = await readActive(assertOwned);
        assertOwned();
        if (session.state !== 'running' || session.windowId !== args.windowId || active?.state !== 'running' ||
          active.auditId !== args.auditId || active.sessionCapabilityId !== args.sessionCapabilityId ||
          active.windowId !== args.windowId) return false;
        const journalAbsent = await confirmStartJournalAbsent(assertOwned);
        assertOwned();
        if (!journalAbsent) return false;
        const binding = liveByWindow.get(args.windowId);
        if (connected(binding) && binding.state === 'bound-idle') {
          const delivered = await deliverRunning(binding, bootstrap, false, assertOwned);
          assertOwned();
          return delivered;
        }
        return true;
      } catch (error) {
        if (error === scopeDeniedSentinel) throw error;
        return false;
      }
    })();
  }

  function publishResult(rawArgs, assertOwned) {
    const args = exact(rawArgs, ['auditId', 'sessionCapabilityId', 'windowId', 'state', 'resultBundle']);
    if (!args) return Promise.resolve(false);
    return (async () => {
      try {
        assertOwned();
        if (!['result', 'view-only'].includes(args.state)) return false;
        const resultBundle = copyPanelResultBundleV1(args.resultBundle);
        if (resultBundle.auditId !== args.auditId) return false;
        const session = await readSession(args.sessionCapabilityId, args.auditId, assertOwned);
        assertOwned();
        const bootstrap = await readBootstrap(args.windowId, assertOwned);
        assertOwned();
        const binding = liveByWindow.get(args.windowId);
        if (session.state !== args.state || session.windowId !== args.windowId || !bootstrap ||
          bootstrap.auditId !== args.auditId || bootstrap.sessionCapabilityId !== args.sessionCapabilityId ||
          !connected(binding) || binding.auditId !== args.auditId || binding.sessionCapabilityId !== args.sessionCapabilityId) return false;
        const context = await reprove(binding, assertOwned);
        assertOwned();
        if (!context) return false;
        send(binding, packet(args.state, args.auditId, args.sessionCapabilityId, resultBundle), assertOwned);
        return true;
      } catch (error) {
        if (error === scopeDeniedSentinel) throw error;
        return false;
      }
    })();
  }

  function registerAndPublishViewOnly(rawArgs, assertOwned) {
    const args = exact(rawArgs, ['auditId', 'sessionCapabilityId', 'windowId', 'createdAt', 'expiresAt', 'resultBundle']);
    if (!args) return Promise.resolve(deniedRegistration());
    return (async () => {
      let registered = false;
      let previous = null;
      let replacement = null;
      let replacementStage = null;
      try {
        assertOwned();
        const resultBundle = copyPanelResultBundleV1(args.resultBundle);
        if (resultBundle.auditId !== args.auditId) return deniedRegistration();
        const session = await readSession(args.sessionCapabilityId, args.auditId, assertOwned);
        assertOwned();
        const currentTime = input.epochNow();
        if (session.state !== 'view-only' || session.windowId !== args.windowId || session.expiresAt !== args.expiresAt ||
          !safeEpoch(args.createdAt) || args.createdAt < session.issuedAt || args.createdAt >= args.expiresAt ||
          !safeEpoch(currentTime) || currentTime >= args.expiresAt) return deniedRegistration();
        await requireActiveAbsent(assertOwned);
        assertOwned();
        previous = await readBootstrap(args.windowId, assertOwned);
        assertOwned();
        if (previous) {
          if (previous.auditId !== args.auditId || previous.windowId !== args.windowId) return deniedRegistration();
          const oldSession = await readSession(previous.sessionCapabilityId, previous.auditId, assertOwned);
          assertOwned();
          if (!['result', 'view-only', 'revoked'].includes(oldSession.state) || oldSession.windowId !== args.windowId) return deniedRegistration();
        }
        await requireActiveAbsent(assertOwned);
        assertOwned();
        const pendingOperation = await replaceBootstrap(previous, {
          version: 1, kind: 'audit-session', auditId: args.auditId, sessionCapabilityId: args.sessionCapabilityId,
          windowId: args.windowId, createdAt: args.createdAt, expiresAt: args.expiresAt, state: 'pending',
        }, assertOwned);
        assertOwned();
        if (pendingOperation.state === 'recovery-required') return recoveryRequiredRegistration();
        if (pendingOperation.state !== 'committed') return deniedRegistration();
        const pending = pendingOperation.record;
        replacement = pendingOperation;
        replacementStage = 'pending';
        await requireActiveAbsent(assertOwned);
        assertOwned();
        registered = true;
        const binding = liveByWindow.get(args.windowId);
        if (!connected(binding)) return Object.freeze({ registered: true, delivered: false });
        if (binding.auditId && binding.auditId !== args.auditId) return Object.freeze({ registered: true, delivered: false });
        await requireActiveAbsent(assertOwned);
        assertOwned();
        const consumedOperation = await replaceBootstrap(pending, { ...pending, state: 'consumed' }, assertOwned);
        assertOwned();
        if (consumedOperation.state === 'recovery-required') return recoveryRequiredRegistration();
        if (consumedOperation.state !== 'committed') return Object.freeze({ registered: true, delivered: false });
        const consumed = consumedOperation.record;
        replacement = consumedOperation;
        replacementStage = 'consumed';
        await requireActiveAbsent(assertOwned);
        assertOwned();
        const context = await reprove(binding, assertOwned);
        assertOwned();
        if (!context) return Object.freeze({ registered: true, delivered: false });
        await requireActiveAbsent(assertOwned);
        assertOwned();
        send(binding, packet('view-only', consumed.auditId, consumed.sessionCapabilityId, resultBundle), assertOwned);
        bind(binding, args.windowId, 'bound-session', args.auditId, args.sessionCapabilityId, assertOwned);
        return Object.freeze({ registered: true, delivered: true });
      } catch (error) {
        if (error === scopeDeniedSentinel) throw error;
        if (error === activeConflictSentinel) {
          if (replacement) {
            try {
              const restored = await replacement.rollback();
              assertOwned();
              if (restored.state === 'recovery-required') return recoveryRequiredRegistration();
              if (restored.state !== 'rolled-back') return recoveryRequiredRegistration();
              if (replacementStage === 'consumed') return Object.freeze({ registered: true, delivered: false });
            }
            catch (restoreError) {
              if (restoreError === scopeDeniedSentinel) throw restoreError;
              return recoveryRequiredRegistration();
            }
          }
          return deniedRegistration();
        }
        return registered ? Object.freeze({ registered: true, delivered: false }) : deniedRegistration();
      }
    })();
  }

  function disconnectSession(rawArgs, assertOwned) {
    const args = exact(rawArgs, ['auditId', 'sessionCapabilityId', 'windowId', 'reasonCode']);
    if (!args || typeof args.reasonCode !== 'string' || !args.reasonCode) return Promise.resolve(false);
    return (async () => {
      try {
        assertOwned();
        const binding = liveByWindow.get(args.windowId);
        if (connected(binding) && binding.auditId === args.auditId &&
          binding.sessionCapabilityId === args.sessionCapabilityId) disconnect(binding, assertOwned);
        const bootstrap = await readBootstrap(args.windowId, assertOwned);
        assertOwned();
        if (bootstrap === null) return true;
        if (bootstrap.auditId !== args.auditId || bootstrap.sessionCapabilityId !== args.sessionCapabilityId ||
          bootstrap.windowId !== args.windowId) return false;
        assertOwned();
        await input.sessionArea.remove(panelBootstrapStorageKey(args.windowId));
        assertOwned();
        const removed = await readBootstrap(args.windowId, assertOwned);
        assertOwned();
        return removed === null;
      } catch (error) {
        if (error === scopeDeniedSentinel) throw error;
        return false;
      }
    })();
  }

  return Object.freeze({
    attachPanelPort,
    withWindowLock,
  });
}
