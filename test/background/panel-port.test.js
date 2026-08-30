import assert from 'node:assert/strict';
import test from 'node:test';

import { createInstalledCoreRuleInventory } from '../../src/core/rules/core-rule-inventory.js';
import { enrichAuditForReport } from '../../src/core/report/enrich-audit.js';
import {
  PANEL_PORT_NAME,
  createPanelPortCoordinator,
  panelBootstrapStorageKey,
} from '../../src/background/panel-port.js';
import { createPanelResultBundleV1 } from '../../src/panel/panel-result-bundle.js';
import { SAMPLE_AUDIT } from '../../fixtures/audits/sample-audit.js';

const RUNTIME_ID = 'abcdefghijklmnopabcdefghijklmnop';
const SESSION = 'S'.repeat(22);
const VIEW_SESSION = 'V'.repeat(22);
const EPOCH = 1_788_000_000_000;
const LAUNCH_TOKEN = 'L'.repeat(43);
const PANEL_URL = `chrome-extension://${RUNTIME_ID}/src/panel/index.html?launch=${LAUNCH_TOKEN}`;

function event() {
  const listeners = new Set();
  return {
    listeners,
    addListener(listener) { listeners.add(listener); },
    removeListener(listener) { listeners.delete(listener); },
    emit(...args) { for (const listener of [...listeners]) listener(...args); },
  };
}

function area() {
  const values = Object.create(null);
  return {
    values,
    async get(key) { return Object.hasOwn(values, key) ? { [key]: structuredClone(values[key]) } : {}; },
    async set(entries) { Object.assign(values, structuredClone(entries)); },
    async remove(key) { delete values[key]; },
  };
}

function port({ documentId = 'panel-document', nativeSender = false, postError = false, failState = null } = {}) {
  const onMessage = event();
  const onDisconnect = event();
  const url = PANEL_URL;
  return {
    name: PANEL_PORT_NAME,
    sender: { id: RUNTIME_ID, url, origin: `chrome-extension://${RUNTIME_ID}` },
    onMessage, onDisconnect, messages: [], disconnects: 0,
    postMessage(message) { if (postError || message.state === failState) throw new Error('native secret'); this.messages.push(structuredClone(message)); },
    disconnect() { this.disconnects += 1; onDisconnect.emit(); },
  };
}

function session(state, sessionCapabilityId = SESSION, auditId = 'audit-port', windowId = 9) {
  return Object.freeze({
    version: 1, sessionCapabilityId, auditId, windowId, mode: 'attached',
    targetBinding: state === 'view-only' ? { kind: 'view-only' } : { kind: 'attached', tabId: 17, documentId: 'page-document', urlSessionDigest: `hmac-sha256:${'A'.repeat(43)}` },
    state, issuedAt: EPOCH, expiresAt: EPOCH + 10_000,
  });
}

async function bundle(auditId = 'audit-port') {
  const inventory = await createInstalledCoreRuleInventory();
  const draft = structuredClone(SAMPLE_AUDIT);
  draft.auditId = auditId;
  draft.integrity.canonicalModelHash = 'pending';
  draft.integrity.evidenceManifestHash = 'pending';
  const model = await enrichAuditForReport(draft, {
    now: () => '2026-08-29T12:00:00.000Z', timezone: 'America/Cuiaba',
    manifestVersion: '1.0.1', rulesVersion: inventory.rulesVersion, browserVersion: 'Chrome/147.0.0.0',
  });
  const checkpoint = {
    version: 1, auditId,
    pages: model.pages.map(page => ({
      pageId: page.pageId, attempted: page.attempted,
      startedAt: page.attempted ? page.timestamps.startedAt : null,
      rulesVersion: inventory.rulesVersion, inventoryVersion: inventory.inventoryVersion,
      inventoryHash: inventory.sha256, outcomes: [],
    })),
  };
  return createPanelResultBundleV1({
    reportRevision: { version: 1, auditId, modelRevision: 1, modelHash: model.integrity.canonicalModelHash, model, checkpoint },
    inventory,
  });
}

function fixture(overrides = {}) {
  const sessionArea = area();
  const sessions = new Map([[SESSION, session('running')], [VIEW_SESSION, session('view-only', VIEW_SESSION)]]);
  let active = null;
  const timers = [];
  const revoked = [];
  const chromeApi = {
    runtime: {
      id: RUNTIME_ID,
      async getContexts({ documentIds, contextTypes, documentUrls }) {
        const documentId = documentIds?.[0] ?? 'panel-document';
        const documentUrl = documentUrls?.[0] ?? PANEL_URL;
        return [{
          contextId: 'panel-context', documentId, documentUrl,
          contextType: contextTypes?.[0] ?? 'SIDE_PANEL', tabId: -1, windowId: -1,
        }];
      },
    },
    windows: {
      async get(windowId) { return { id: windowId, focused: false, type: 'normal' }; },
    },
    tabs: {
      async query({ windowId }) {
        return [{ id: 17, windowId, active: true, status: 'complete', url: 'https://example.test/', pendingUrl: '' }];
      },
    },
  };
  const dependencies = {
    chromeApi, sessionArea,
    readActiveJob: async () => active,
    readAuditSession: async ({ sessionCapabilityId, auditId }) => {
      const value = sessions.get(sessionCapabilityId);
      if (!value || value.auditId !== auditId) throw new Error('denied');
      return value;
    },
    loadPanelResultBundle: async () => null,
    rehydrateViewOnly: async ({ auditId }) => ({ ok: true, sessionCapabilityId: VIEW_SESSION, auditId, expiresAt: EPOCH + 10_000 }),
    revokeViewOnly: async value => { revoked.push(value); return true; },
    epochNow: () => EPOCH + 1,
    setTimer(callback, delay) { const timer = { callback, delay, cleared: false }; timers.push(timer); return timer; },
    clearTimer(timer) { timer.cleared = true; },
    launchAuthority: {
      async admitPort({ sender }) {
        if (!sender || sender.id !== RUNTIME_ID || sender.url !== PANEL_URL ||
          sender.origin !== `chrome-extension://${RUNTIME_ID}`) return { ok: false, code: 'PANEL_LAUNCH_DENIED' };
        const contexts = await chromeApi.runtime.getContexts({ contextTypes: ['SIDE_PANEL'], documentUrls: [sender.url] });
        if (!Array.isArray(contexts) || contexts.length !== 1) return { ok: false, code: 'PANEL_LAUNCH_DENIED' };
        const context = contexts[0];
        if (context.contextType !== 'SIDE_PANEL' || context.documentUrl !== sender.url ||
          typeof context.documentId !== 'string' || !context.documentId ||
          ![-1, undefined].includes(context.tabId) || ![-1, undefined].includes(context.windowId)) {
          return { ok: false, code: 'PANEL_LAUNCH_DENIED' };
        }
        return Object.freeze({
          ok: true, token: LAUNCH_TOKEN, tabId: 17, windowId: 9, generation: 1,
          contextId: context.contextId ?? 'panel-context', documentId: context.documentId, url: sender.url,
          syntheticSender: Object.freeze({ ...sender, documentId: context.documentId }),
        });
      },
      async reprove(admission) {
        if (admission?.ok !== true) return { ok: false, code: 'PANEL_LAUNCH_DENIED' };
        const contexts = await chromeApi.runtime.getContexts({ contextTypes: ['SIDE_PANEL'], documentUrls: [admission.url] });
        const context = Array.isArray(contexts) && contexts.length === 1 ? contexts[0] : null;
        return context?.contextType === 'SIDE_PANEL' && context.documentUrl === admission.url &&
          context.documentId === admission.documentId && [-1, undefined].includes(context.tabId) &&
          [-1, undefined].includes(context.windowId) ? admission : { ok: false, code: 'PANEL_LAUNCH_DENIED' };
      },
      async revoke() { return { ok: true, revoked: true }; },
    },
    async authorizeHighlightSession({ sessionCapabilityId, auditId, claimedWindowId, sender }) {
      const value = sessions.get(sessionCapabilityId);
      if (!value || value.auditId !== auditId || value.state !== 'result' || value.windowId !== claimedWindowId) {
        return { ok: false };
      }
      return {
        ok: true,
        session: {
          ...value,
          consumers: [
            { name: 'panel', path: '/src/panel/index.html', contextType: 'SIDE_PANEL' },
            { name: 'review', path: '/src/review/index.html', contextType: 'TAB' },
          ],
          intents: {
            panel: { running: ['cancel'], result: ['open-report', 'highlight'], 'view-only': ['open-report'] },
            review: { running: [], result: ['export', 'highlight'], 'view-only': ['export'] },
          },
        },
        context: {
          issuer: { type: 'extension-document', documentId: sender.documentId, path: '/src/panel/index.html' },
          windowId: claimedWindowId, tabId: null, contextType: 'SIDE_PANEL', documentUrl: sender.url,
        },
      };
    },
    async dispatchPanelIntent() { return { ok: false, code: 'FEATURE_UNAVAILABLE' }; },
    ...overrides,
  };
  return {
    chromeApi, sessionArea, sessions, timers, revoked,
    setActive(value) { active = value; },
    getActive() { return active; },
    coordinator: createPanelPortCoordinator(dependencies),
  };
}

function runningActive() {
  return Object.freeze({
    version: 1, auditId: 'audit-port', capabilityId: 'C'.repeat(22), sessionCapabilityId: SESSION,
    windowId: 9, mode: 'attached', state: 'running', commitState: 'none', expectedTerminalRevision: null,
    createdAt: EPOCH, updatedAt: EPOCH,
  });
}

function foreignRunningActive() {
  return Object.freeze({
    version: 1, auditId: 'foreign-active-audit', capabilityId: 'F'.repeat(22),
    sessionCapabilityId: 'G'.repeat(22), windowId: 12, mode: 'attached',
    state: 'running', commitState: 'none', expectedTerminalRevision: null,
    createdAt: EPOCH, updatedAt: EPOCH + 1,
  });
}

function tick() { return new Promise(resolve => setImmediate(resolve)); }

test('exports only lock entry and attaches fresh owner-bound mutation scopes', async () => {
  const { coordinator } = fixture();
  assert.deepEqual(Object.keys(coordinator), ['attachPanelPort', 'withWindowLock', 'publishHighlightState']);
  assert.equal(Object.isFrozen(coordinator), true);

  let retained;
  await coordinator.withWindowLock(9, async scope => {
    retained = scope;
    assert.deepEqual(Object.keys(scope), [
      'registerPendingBootstrap', 'publishRegisteredBootstrap', 'publishResult',
      'registerAndPublishViewOnly', 'disconnectSession',
    ]);
    assert.equal(Object.isFrozen(scope), true);
  });
  await assert.rejects(() => retained.disconnectSession({
    auditId: 'audit-port', sessionCapabilityId: SESSION, windowId: 9, reasonCode: 'AUDIT_FAILED',
  }), /PANEL_SCOPE_DENIED/u);

  let release;
  const held = coordinator.withWindowLock(9, async () => new Promise(resolve => { release = resolve; }));
  await Promise.resolve();
  await assert.rejects(() => retained.disconnectSession({
    auditId: 'audit-port', sessionCapabilityId: SESSION, windowId: 9, reasonCode: 'AUDIT_FAILED',
  }), /PANEL_SCOPE_DENIED/u);
  release();
  await held;

  let rejectedScope;
  await assert.rejects(() => coordinator.withWindowLock(9, scope => {
    rejectedScope = scope;
    throw new Error('callback failed');
  }), /callback failed/u);
  await assert.rejects(() => rejectedScope.disconnectSession({
    auditId: 'audit-port', sessionCapabilityId: SESSION, windowId: 9, reasonCode: 'AUDIT_FAILED',
  }), /PANEL_SCOPE_DENIED/u);
});

test('injects the admitted Port window only into worker dispatch and publishes safe highlight state without disconnecting', async () => {
  const dispatched = [];
  const env = fixture({
    async dispatchPanelIntent(request) {
      dispatched.push(request);
      return { ok: true, highlight: { state: 'active', occurrenceId: 'occ-1' } };
    },
  });
  env.setActive(runningActive());
  env.sessionArea.values[panelBootstrapStorageKey(9)] = {
    version: 1, kind: 'audit-session', auditId: 'audit-port', sessionCapabilityId: SESSION,
    windowId: 9, createdAt: EPOCH, expiresAt: EPOCH + 10_000, state: 'pending',
  };
  const connected = port();
  env.coordinator.attachPanelPort(connected);
  connected.onMessage.emit({ protocol: 'audita-panel', version: 1, type: 'bootstrap' });
  await tick();
  connected.onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'intent', requestId: 'highlight-request-1',
    envelope: {
      type: 'HIGHLIGHT_OCCURRENCE', sessionCapabilityId: SESSION,
      auditId: 'audit-port', occurrenceId: 'occ-1',
    },
  });
  await tick();
  assert.equal(connected.disconnects, 0);
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].panelWindowId, 9);
  assert.equal(dispatched[0].launchTabId, 17);
  assert.equal(Object.hasOwn(dispatched[0].envelope, 'windowId'), false);
  assert.equal(dispatched[0].envelope.occurrenceId, 'occ-1');

  env.sessions.set(SESSION, session('result'));
  env.setActive(null);

  assert.deepEqual(await env.coordinator.publishHighlightState({
    version: 1, type: 'HIGHLIGHT_STATE_CHANGED', auditId: 'audit-port',
    occurrenceId: 'occ-1', state: 'active',
  }), { delivered: 1 });
  assert.deepEqual(connected.messages.at(-1), {
    version: 1, type: 'HIGHLIGHT_STATE_CHANGED', auditId: 'audit-port',
    occurrenceId: 'occ-1', state: 'active',
  });
});

test('reauthorizes every highlight publication against an unexpired attached result grant', async () => {
  const authorizations = [];
  let grant = 'current';
  const env = fixture({
    async authorizeHighlightSession(value) {
      authorizations.push(value);
      const intents = grant === 'legacy'
        ? { panel: { running: ['cancel'], result: ['open-report'], 'view-only': ['open-report'] }, review: { running: [], result: ['export'], 'view-only': ['export'] } }
        : { panel: { running: ['cancel'], result: ['open-report', 'highlight'], 'view-only': ['open-report'] }, review: { running: [], result: ['export', 'highlight'], 'view-only': ['export'] } };
      return {
        ok: true,
        session: {
          version: 1, sessionCapabilityId: SESSION, auditId: 'audit-port', windowId: 9, mode: 'attached',
          targetBinding: grant === 'view-only'
            ? { kind: 'view-only' }
            : { kind: 'attached', tabId: 17, documentId: 'page-document', urlSessionDigest: `hmac-sha256:${'A'.repeat(43)}` },
          consumers: [
            { name: 'panel', path: '/src/panel/index.html', contextType: 'SIDE_PANEL' },
            { name: 'review', path: '/src/review/index.html', contextType: 'TAB' },
          ],
          intents, state: grant === 'view-only' ? 'view-only' : 'result',
          issuedAt: EPOCH, expiresAt: grant === 'expired' ? EPOCH + 1 : EPOCH + 10_000,
        },
        context: {
          issuer: { type: 'extension-document', documentId: 'panel-document', path: '/src/panel/index.html' },
          windowId: 9, tabId: null, contextType: 'SIDE_PANEL', documentUrl: PANEL_URL,
        },
      };
    },
  });
  env.setActive(runningActive());
  env.sessionArea.values[panelBootstrapStorageKey(9)] = {
    version: 1, kind: 'audit-session', auditId: 'audit-port', sessionCapabilityId: SESSION,
    windowId: 9, createdAt: EPOCH, expiresAt: EPOCH + 10_000, state: 'pending',
  };
  const connected = port();
  env.coordinator.attachPanelPort(connected);
  connected.onMessage.emit({ protocol: 'audita-panel', version: 1, type: 'bootstrap' });
  await tick();
  env.sessions.set(SESSION, session('result'));
  env.setActive(null);

  const event = {
    version: 1, type: 'HIGHLIGHT_STATE_CHANGED', auditId: 'audit-port', occurrenceId: null, state: 'clear',
  };
  assert.deepEqual(await env.coordinator.publishHighlightState(event), { delivered: 1 });
  assert.deepEqual(authorizations, [{
    sessionCapabilityId: SESSION, auditId: 'audit-port', claimedWindowId: 9,
    sender: {
      id: RUNTIME_ID, url: PANEL_URL, origin: `chrome-extension://${RUNTIME_ID}`,
      documentId: 'panel-document',
    },
  }]);

  grant = 'legacy';
  assert.deepEqual(await env.coordinator.publishHighlightState(event), { delivered: 0 });
  assert.equal(connected.disconnects, 1);
});

test('keeps scoped mutation authority across awaits and serializes independent lock requests', async () => {
  const { coordinator } = fixture();
  const order = [];
  let release;
  let entered;
  const enteredPromise = new Promise(resolve => { entered = resolve; });
  const first = coordinator.withWindowLock(9, async scope => {
    order.push('first-enter');
    await Promise.resolve();
    const registered = await scope.registerPendingBootstrap({
      auditId: 'audit-port', sessionCapabilityId: SESSION, windowId: 9,
      createdAt: EPOCH, expiresAt: EPOCH + 10_000,
    });
    assert.equal(registered, true);
    entered();
    await new Promise(resolve => { release = resolve; });
    order.push('first-leave');
  });
  await enteredPromise;
  const second = coordinator.withWindowLock(9, async () => { order.push('second'); });
  await Promise.resolve();
  assert.deepEqual(order, ['first-enter']);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first-enter', 'first-leave', 'second']);
});

test('rejects synchronous same-window root reentry without weakening independent serialization', async () => {
  const { coordinator } = fixture();

  await coordinator.withWindowLock(9, () => assert.rejects(
    () => coordinator.withWindowLock(9, async () => {}),
    /PANEL_WINDOW_LOCK_REENTRANT/u,
  ));

  assert.equal(await coordinator.withWindowLock(9, async () => 'independent'), 'independent');
});

test('publishResult cannot send after its owner callback settles during final reproof', async () => {
  const resultBundle = await bundle();
  const env = fixture();
  env.setActive(runningActive());
  env.sessionArea.values[panelBootstrapStorageKey(9)] = {
    version: 1, kind: 'audit-session', auditId: 'audit-port', sessionCapabilityId: SESSION,
    windowId: 9, createdAt: EPOCH, expiresAt: EPOCH + 10_000, state: 'pending',
  };
  const connected = port();
  env.coordinator.attachPanelPort(connected);
  connected.onMessage.emit({ protocol: 'audita-panel', version: 1, type: 'bootstrap' });
  await tick();
  env.sessions.set(SESSION, session('result'));

  let releaseReproof;
  let reachedReproof;
  const reproofReached = new Promise(resolve => { reachedReproof = resolve; });
  env.chromeApi.runtime.getContexts = async () => {
    reachedReproof();
    await new Promise(resolve => { releaseReproof = resolve; });
    return [{
      contextId: 'panel-context', documentId: 'panel-document', documentUrl: PANEL_URL,
      contextType: 'SIDE_PANEL', tabId: -1, windowId: -1,
    }];
  };
  let publication;
  await env.coordinator.withWindowLock(9, async scope => {
    publication = scope.publishResult({
      auditId: 'audit-port', sessionCapabilityId: SESSION, windowId: 9,
      state: 'result', resultBundle,
    });
    await reproofReached;
  });
  releaseReproof();

  await assert.rejects(publication, /PANEL_SCOPE_DENIED/u);
  assert.equal(connected.messages.some(message => message.state === 'result'), false);
});

test('view-only registration cannot send or bind after its owner callback settles during reproof', async () => {
  const resultBundle = await bundle();
  const env = fixture();
  const connected = port();
  env.coordinator.attachPanelPort(connected);
  connected.onMessage.emit({ protocol: 'audita-panel', version: 1, type: 'bootstrap' });
  await tick();
  assert.equal(connected.messages.at(-1).state, 'initial');

  let releaseReproof;
  let reachedReproof;
  const reproofReached = new Promise(resolve => { reachedReproof = resolve; });
  env.chromeApi.runtime.getContexts = async () => {
    reachedReproof();
    await new Promise(resolve => { releaseReproof = resolve; });
    return [{
      contextId: 'panel-context', documentId: 'panel-document', documentUrl: PANEL_URL,
      contextType: 'SIDE_PANEL', tabId: -1, windowId: -1,
    }];
  };
  let registration;
  await env.coordinator.withWindowLock(9, async scope => {
    registration = scope.registerAndPublishViewOnly({
      auditId: 'audit-port', sessionCapabilityId: VIEW_SESSION, windowId: 9,
      createdAt: EPOCH + 1, expiresAt: EPOCH + 10_000, resultBundle,
    });
    await reproofReached;
  });
  releaseReproof();

  await assert.rejects(registration, /PANEL_SCOPE_DENIED/u);
  assert.equal(connected.messages.some(message => message.state === 'view-only'), false);
});

test('panel-first receives initial, rejects a second hello and preserves the incumbent port', async () => {
  const { coordinator, timers } = fixture();
  const first = port();
  assert.equal(coordinator.attachPanelPort(first), true);
  assert.equal(timers[0].delay, 5000);
  first.onMessage.emit({ protocol: 'audita-panel', version: 1, type: 'bootstrap' });
  await tick();
  assert.deepEqual(first.messages, [{
    protocol: 'audita-panel', version: 1, type: 'bootstrap-result', state: 'initial',
    auditId: null, sessionCapabilityId: null, result: null,
  }]);
  assert.equal(timers[0].cleared, true);

  const competitor = port({ documentId: 'panel-document-2' });
  coordinator.attachPanelPort(competitor);
  competitor.onMessage.emit({ protocol: 'audita-panel', version: 1, type: 'bootstrap' });
  await tick();
  assert.equal(competitor.disconnects, 1);
  first.onMessage.emit({ protocol: 'audita-panel', version: 1, type: 'bootstrap' });
  assert.equal(first.disconnects, 1);
});

test('native SIDE_PANEL port without sender documentId reaches a proved idle bootstrap', async () => {
  const env = fixture();
  const connected = port({ nativeSender: true });

  assert.equal(env.coordinator.attachPanelPort(connected), true);
  connected.onMessage.emit({ protocol: 'audita-panel', version: 1, type: 'bootstrap' });
  await tick();

  assert.deepEqual(connected.messages, [{
    protocol: 'audita-panel', version: 1, type: 'bootstrap-result', state: 'initial',
    auditId: null, sessionCapabilityId: null, result: null,
  }]);
  assert.equal(connected.disconnects, 0);
});

test('document-less panel port is denied before hello unless Chrome supplies the exact extension origin', () => {
  const env = fixture();
  let documentIdReads = 0;
  const accessorDocumentId = {
    id: RUNTIME_ID,
    url: `chrome-extension://${RUNTIME_ID}/src/panel/index.html`,
    origin: `chrome-extension://${RUNTIME_ID}`,
  };
  Object.defineProperty(accessorDocumentId, 'documentId', {
    enumerable: true,
    get() { documentIdReads += 1; return 'forged-document'; },
  });
  const nativeShape = {
    id: RUNTIME_ID,
    url: `chrome-extension://${RUNTIME_ID}/src/panel/index.html`,
    origin: `chrome-extension://${RUNTIME_ID}`,
  };
  for (const sender of [
    { id: RUNTIME_ID, url: `chrome-extension://${RUNTIME_ID}/src/panel/index.html` },
    { id: RUNTIME_ID, url: `chrome-extension://${RUNTIME_ID}/src/panel/index.html`, origin: 'chrome-extension://other' },
    accessorDocumentId,
    Object.assign([], nativeShape),
    Object.assign(Object.create({ inherited: true }), nativeShape),
  ]) {
    const connected = port();
    connected.sender = sender;
    assert.equal(env.coordinator.attachPanelPort(connected), false);
    assert.equal(connected.disconnects, 1);
  }
  assert.equal(documentIdReads, 0);
});

test('port bootstrap denies every window claim and accessor without reading accessors', async () => {
  let getterCalls = 0;
  const accessor = { protocol: 'audita-panel', version: 1, type: 'bootstrap' };
  Object.defineProperty(accessor, 'windowId', {
    enumerable: true,
    get() { getterCalls += 1; return 9; },
  });
  for (const hello of [
    { protocol: 'audita-panel', version: 1, type: 'bootstrap', windowId: 9, extra: true },
    { protocol: 'audita-panel', version: 1, type: 'bootstrap', windowId: -1 },
    accessor,
  ]) {
    const env = fixture();
    const connected = port();
    env.coordinator.attachPanelPort(connected);
    connected.onMessage.emit(hello);
    assert.equal(connected.disconnects, 1);
    assert.deepEqual(connected.messages, []);
  }
  assert.equal(getterCalls, 0);
});

test('port bootstrap independently denies a wrong window claim and non-SIDE_PANEL contexts', async t => {
  await t.test('wrong window', async () => {
    const env = fixture();
    env.chromeApi.windows.get = async () => ({ id: 9, focused: false });
    const connected = port();
    env.coordinator.attachPanelPort(connected);
    connected.onMessage.emit({ protocol: 'audita-panel', version: 1, type: 'bootstrap', windowId: 11 });
    await tick();
    assert.equal(connected.disconnects, 1);
    assert.deepEqual(connected.messages, []);
  });
  for (const contextType of ['TAB', 'POPUP']) await t.test(contextType, async () => {
    const env = fixture();
    env.chromeApi.runtime.getContexts = async () => [{
      contextId: 'panel-context', documentId: 'panel-document', documentUrl: PANEL_URL,
      contextType, tabId: -1, windowId: -1,
    }];
    const connected = port();
    env.coordinator.attachPanelPort(connected);
    connected.onMessage.emit({ protocol: 'audita-panel', version: 1, type: 'bootstrap' });
    await tick();
    assert.equal(connected.disconnects, 1);
    assert.deepEqual(connected.messages, []);
  });
});

test('a bound port keeps its worker-owned launch identity when the active tab later changes', async () => {
  const resultBundle = await bundle();
  const env = fixture();
  const connected = port();
  env.coordinator.attachPanelPort(connected);
  connected.onMessage.emit({ protocol: 'audita-panel', version: 1, type: 'bootstrap' });
  await tick();
  assert.equal(connected.messages.at(-1).state, 'initial');

  env.chromeApi.tabs.query = async () => [{
    id: 27, windowId: 11, active: true, status: 'complete', url: 'https://other.test/', pendingUrl: '',
  }];
  const registration = await env.coordinator.withWindowLock(9, scope => scope.registerAndPublishViewOnly({
    auditId: 'audit-port', sessionCapabilityId: VIEW_SESSION, windowId: 9,
    createdAt: EPOCH + 1, expiresAt: EPOCH + 10_000, resultBundle,
  }));
  assert.deepEqual(registration, { registered: true, delivered: true });
  assert.equal(connected.messages.some(message => message.state === 'view-only'), true);
});

test('a duplicate packet arriving while first-hello proof is pending disconnects immediately', async () => {
  let resolveContexts;
  const contexts = new Promise(resolve => { resolveContexts = resolve; });
  const env = fixture({
    chromeApi: {
      runtime: {
        id: RUNTIME_ID,
        async getContexts() { return contexts; },
      },
      windows: { async get(windowId) { return { id: windowId, focused: false }; } },
      tabs: { async query({ windowId }) { return [{ id: 17, windowId, active: true, status: 'complete', url: 'https://example.test/', pendingUrl: '' }]; } },
    },
  });
  const connected = port();
  env.coordinator.attachPanelPort(connected);
  connected.onMessage.emit({ protocol: 'audita-panel', version: 1, type: 'bootstrap' });
  connected.onMessage.emit({ protocol: 'audita-panel', version: 1, type: 'bootstrap' });
  assert.equal(connected.disconnects, 1);
  resolveContexts([{
    contextId: 'panel-context', documentId: 'panel-document', documentUrl: PANEL_URL,
    contextType: 'SIDE_PANEL', tabId: -1, windowId: -1,
  }]);
  await tick();
});

test('start-first consumes a pending bootstrap only after proving ACTIVE running', async () => {
  const env = fixture();
  env.setActive(runningActive());
  env.sessionArea.values[panelBootstrapStorageKey(9)] = {
    version: 1, kind: 'audit-session', auditId: 'audit-port', sessionCapabilityId: SESSION,
    windowId: 9, createdAt: EPOCH, expiresAt: EPOCH + 10_000, state: 'pending',
  };
  const connected = port();
  env.coordinator.attachPanelPort(connected);
  connected.onMessage.emit({ protocol: 'audita-panel', version: 1, type: 'bootstrap' });
  await tick();
  assert.equal(env.sessionArea.values[panelBootstrapStorageKey(9)].state, 'consumed');
  assert.deepEqual(connected.messages[0], {
    protocol: 'audita-panel', version: 1, type: 'bootstrap-result', state: 'running',
    auditId: 'audit-port', sessionCapabilityId: SESSION, result: null,
  });
});

test('start-first hello cannot publish running until the start journal is confirmed absent', async () => {
  const env = fixture();
  env.setActive(runningActive());
  env.sessionArea.values[panelBootstrapStorageKey(9)] = {
    version: 1, kind: 'audit-session', auditId: 'audit-port', sessionCapabilityId: SESSION,
    windowId: 9, createdAt: EPOCH, expiresAt: EPOCH + 10_000, state: 'pending',
  };
  env.sessionArea.values['audita:start-journal:v1'] = {
    version: 1, auditId: 'audit-port', private: 'start-not-settled',
  };
  const connected = port();

  env.coordinator.attachPanelPort(connected);
  connected.onMessage.emit({ protocol: 'audita-panel', version: 1, type: 'bootstrap' });
  await tick();

  assert.equal(connected.messages.some(message => message.state === 'running'), false);
  assert.equal(connected.disconnects, 1);
  assert.equal(env.sessionArea.values[panelBootstrapStorageKey(9)].state, 'pending');
});

test('an accessor start-journal envelope cannot authorize running publication or bootstrap consumption', async () => {
  const env = fixture();
  const connected = port();
  env.coordinator.attachPanelPort(connected);
  connected.onMessage.emit({ protocol: 'audita-panel', version: 1, type: 'bootstrap' });
  await tick();
  env.setActive(runningActive());
  const bootstrapKey = panelBootstrapStorageKey(9);
  const journalKey = 'audita:start-journal:v1';
  env.sessionArea.values[bootstrapKey] = {
    version: 1, kind: 'audit-session', auditId: 'audit-port', sessionCapabilityId: SESSION,
    windowId: 9, createdAt: EPOCH, expiresAt: EPOCH + 10_000, state: 'pending',
  };
  let getterCalls = 0;
  const accessorEnvelope = {};
  Object.defineProperty(accessorEnvelope, journalKey, {
    enumerable: true,
    get() { getterCalls += 1; return { private: 'unsettled-start' }; },
  });
  const originalGet = env.sessionArea.get.bind(env.sessionArea);
  const originalSet = env.sessionArea.set.bind(env.sessionArea);
  let writes = 0;
  env.sessionArea.get = async key => key === journalKey ? accessorEnvelope : originalGet(key);
  env.sessionArea.set = async entries => { writes += 1; await originalSet(entries); };

  const published = await env.coordinator.withWindowLock(9, scope => scope.publishRegisteredBootstrap({
    auditId: 'audit-port', sessionCapabilityId: SESSION, windowId: 9,
  }));

  assert.equal(published, false);
  assert.equal(getterCalls, 0);
  assert.equal(writes, 0);
  assert.equal(env.sessionArea.values[bootstrapKey].state, 'pending');
  assert.equal(connected.messages.some(message => message.state === 'running'), false);
});

test('an idle live panel receives running only after ACTIVE exists and the start journal is absent', async () => {
  const env = fixture();
  const connected = port();
  env.coordinator.attachPanelPort(connected);
  connected.onMessage.emit({ protocol: 'audita-panel', version: 1, type: 'bootstrap' });
  await tick();
  assert.equal(connected.messages.at(-1).state, 'initial');

  await env.coordinator.withWindowLock(9, async scope => {
    assert.equal(await scope.registerPendingBootstrap({
      auditId: 'audit-port', sessionCapabilityId: SESSION, windowId: 9,
      createdAt: EPOCH, expiresAt: EPOCH + 10_000,
    }), true);
    env.setActive(runningActive());
    env.sessionArea.values['audita:start-journal:v1'] = { private: 'unconfirmed-removal' };
    assert.equal(await scope.publishRegisteredBootstrap({
      auditId: 'audit-port', sessionCapabilityId: SESSION, windowId: 9,
    }), false);
    assert.equal(connected.messages.some(message => message.state === 'running'), false);

    delete env.sessionArea.values['audita:start-journal:v1'];
    assert.equal(await scope.publishRegisteredBootstrap({
      auditId: 'audit-port', sessionCapabilityId: SESSION, windowId: 9,
    }), true);
    assert.equal(connected.messages.at(-1).state, 'running');
  });
  assert.equal(env.timers.some(timer => timer.delay === 0), false);
});

test('rotates a consumed running bootstrap only for the exact durable ACTIVE job', async () => {
  const env = fixture();
  env.setActive(runningActive());
  env.sessionArea.values[panelBootstrapStorageKey(9)] = {
    version: 1, kind: 'audit-session', auditId: 'audit-port', sessionCapabilityId: SESSION,
    windowId: 9, createdAt: EPOCH, expiresAt: EPOCH + 10_000, state: 'consumed',
  };
  const connected = port();
  env.coordinator.attachPanelPort(connected);
  connected.onMessage.emit({ protocol: 'audita-panel', version: 1, type: 'bootstrap' });
  await tick();
  assert.equal(connected.messages[0].state, 'running');
  env.setActive(null);
  connected.onDisconnect.emit();
  const replay = port({ documentId: 'panel-document-3' });
  env.coordinator.attachPanelPort(replay);
  replay.onMessage.emit({ protocol: 'audita-panel', version: 1, type: 'bootstrap' });
  await tick();
  assert.equal(replay.messages.length, 0);
  assert.equal(replay.disconnects, 1);
});

test('registerAndPublishViewOnly durably registers without a port and preserves foreign state', async () => {
  const resultBundle = await bundle();
  const env = fixture();
  const registered = await env.coordinator.withWindowLock(9, scope => scope.registerAndPublishViewOnly({
    auditId: 'audit-port', sessionCapabilityId: VIEW_SESSION, windowId: 9,
    createdAt: EPOCH + 1, expiresAt: EPOCH + 10_000, resultBundle,
  }));
  assert.deepEqual(registered, { registered: true, delivered: false });
  assert.equal(env.sessionArea.values[panelBootstrapStorageKey(9)].state, 'pending');

  env.sessionArea.values[panelBootstrapStorageKey(9)] = {
    version: 1, kind: 'audit-session', auditId: 'foreign-audit', sessionCapabilityId: 'F'.repeat(22),
    windowId: 9, createdAt: EPOCH, expiresAt: EPOCH + 10_000, state: 'pending',
  };
  const denied = await env.coordinator.withWindowLock(9, scope => scope.registerAndPublishViewOnly({
    auditId: 'audit-port', sessionCapabilityId: VIEW_SESSION, windowId: 9,
    createdAt: EPOCH + 1, expiresAt: EPOCH + 10_000, resultBundle,
  }));
  assert.deepEqual(denied, { registered: false, delivered: false, code: 'AUDIT_REHYDRATE_DENIED' });
  assert.equal(env.sessionArea.values[panelBootstrapStorageKey(9)].auditId, 'foreign-audit');
});

test('an accessor bootstrap envelope cannot be mistaken for absence and overwritten', async () => {
  const resultBundle = await bundle();
  const env = fixture();
  const key = panelBootstrapStorageKey(9);
  let getterCalls = 0;
  const accessorEnvelope = {};
  Object.defineProperty(accessorEnvelope, key, {
    enumerable: true,
    get() { getterCalls += 1; return { private: 'hostile-bootstrap' }; },
  });
  const originalGet = env.sessionArea.get.bind(env.sessionArea);
  const originalSet = env.sessionArea.set.bind(env.sessionArea);
  const originalRemove = env.sessionArea.remove.bind(env.sessionArea);
  let writes = 0;
  let removals = 0;
  env.sessionArea.get = async requestedKey => requestedKey === key ? accessorEnvelope : originalGet(requestedKey);
  env.sessionArea.set = async entries => { writes += 1; await originalSet(entries); };
  env.sessionArea.remove = async removedKey => { removals += 1; await originalRemove(removedKey); };

  const registration = await env.coordinator.withWindowLock(9, scope => scope.registerAndPublishViewOnly({
    auditId: 'audit-port', sessionCapabilityId: VIEW_SESSION, windowId: 9,
    createdAt: EPOCH + 1, expiresAt: EPOCH + 10_000, resultBundle,
  }));

  assert.deepEqual(registration, { registered: false, delivered: false, code: 'AUDIT_REHYDRATE_DENIED' });
  assert.equal(getterCalls, 0);
  assert.equal(writes, 0);
  assert.equal(removals, 0);
  assert.equal(Object.hasOwn(env.sessionArea.values, key), false);
});

test('bootstrap storage envelopes admit only exact absent or one-key defined data shapes', async t => {
  const resultBundle = await bundle();
  const key = panelBootstrapStorageKey(9);
  const oldSessionCapabilityId = 'O'.repeat(22);
  const prior = {
    version: 1, kind: 'audit-session', auditId: 'audit-port', sessionCapabilityId: oldSessionCapabilityId,
    windowId: 9, createdAt: EPOCH, expiresAt: EPOCH + 10_000, state: 'consumed',
  };

  for (const variant of [
    { name: 'plain empty', nullPrototype: false, present: false },
    { name: 'null-prototype empty', nullPrototype: true, present: false },
    { name: 'plain one-key data', nullPrototype: false, present: true },
    { name: 'null-prototype one-key data', nullPrototype: true, present: true },
  ]) {
    await t.test(variant.name, async () => {
      const env = fixture();
      if (variant.present) {
        env.sessions.set(oldSessionCapabilityId, session('result', oldSessionCapabilityId));
        env.sessionArea.values[key] = structuredClone(prior);
      }
      if (variant.nullPrototype) {
        const originalGet = env.sessionArea.get.bind(env.sessionArea);
        env.sessionArea.get = async requestedKey => {
          const source = await originalGet(requestedKey);
          const envelope = Object.create(null);
          if (Object.hasOwn(source, requestedKey)) {
            Object.defineProperty(envelope, requestedKey, { enumerable: true, value: source[requestedKey] });
          }
          return envelope;
        };
      }

      const registration = await env.coordinator.withWindowLock(9, scope => scope.registerAndPublishViewOnly({
        auditId: 'audit-port', sessionCapabilityId: VIEW_SESSION, windowId: 9,
        createdAt: EPOCH + 1, expiresAt: EPOCH + 10_000, resultBundle,
      }));

      assert.deepEqual(registration, { registered: true, delivered: false });
      assert.equal(env.sessionArea.values[key].sessionCapabilityId, VIEW_SESSION);
      assert.equal(env.sessionArea.values[key].state, 'pending');
    });
  }
});

test('bootstrap storage envelopes reject malformed shapes or invalid present values without effects', async t => {
  const resultBundle = await bundle();
  const key = panelBootstrapStorageKey(9);
  const oldSessionCapabilityId = 'O'.repeat(22);
  const prior = {
    version: 1, kind: 'audit-session', auditId: 'audit-port', sessionCapabilityId: oldSessionCapabilityId,
    windowId: 9, createdAt: EPOCH, expiresAt: EPOCH + 10_000, state: 'consumed',
  };
  const cases = [
    ['accessor', getterState => {
      const value = {};
      Object.defineProperty(value, key, {
        enumerable: true,
        get() { getterState.calls += 1; return prior; },
      });
      return value;
    }],
    ['non-enumerable', () => {
      const value = {};
      Object.defineProperty(value, key, { enumerable: false, value: prior });
      return value;
    }],
    ['symbol', () => ({ [key]: prior, [Symbol('private')]: true })],
    ['extra key', () => ({ [key]: prior, extra: true })],
    ['wrong key', () => ({ other: prior })],
    ['custom prototype', () => Object.assign(Object.create({ inherited: true }), { [key]: prior })],
    ['explicit undefined', () => ({ [key]: undefined })],
    ['defined null row', () => ({ [key]: null })],
    ['array', () => []],
    ['primitive', () => 7],
    ['ownKeys failure', () => new Proxy({ [key]: prior }, {
      ownKeys() { throw new Error('PRIVATE_OWN_KEYS_FAILURE'); },
    })],
    ['descriptor failure', () => new Proxy({ [key]: prior }, {
      getOwnPropertyDescriptor() { throw new Error('PRIVATE_DESCRIPTOR_FAILURE'); },
    })],
  ];

  for (const [name, createEnvelope] of cases) {
    await t.test(name, async () => {
      const env = fixture();
      env.sessions.set(oldSessionCapabilityId, session('result', oldSessionCapabilityId));
      const getterState = { calls: 0 };
      const envelope = createEnvelope(getterState);
      const originalGet = env.sessionArea.get.bind(env.sessionArea);
      const originalSet = env.sessionArea.set.bind(env.sessionArea);
      const originalRemove = env.sessionArea.remove.bind(env.sessionArea);
      let writes = 0;
      let removals = 0;
      env.sessionArea.get = async requestedKey => requestedKey === key ? envelope : originalGet(requestedKey);
      env.sessionArea.set = async entries => { writes += 1; await originalSet(entries); };
      env.sessionArea.remove = async removedKey => { removals += 1; await originalRemove(removedKey); };

      const registration = await env.coordinator.withWindowLock(9, scope => scope.registerAndPublishViewOnly({
        auditId: 'audit-port', sessionCapabilityId: VIEW_SESSION, windowId: 9,
        createdAt: EPOCH + 1, expiresAt: EPOCH + 10_000, resultBundle,
      }));

      assert.deepEqual(registration, { registered: false, delivered: false, code: 'AUDIT_REHYDRATE_DENIED' });
      assert.equal(getterState.calls, 0);
      assert.equal(writes, 0);
      assert.equal(removals, 0);
    });
  }
});

test('view-only registration preserves observable bootstrap drift immediately before replacement set', async () => {
  const resultBundle = await bundle();
  const key = panelBootstrapStorageKey(9);
  const foreign = {
    version: 1, kind: 'audit-session', auditId: 'foreign-audit', sessionCapabilityId: 'F'.repeat(22),
    windowId: 9, createdAt: EPOCH, expiresAt: EPOCH + 10_000, state: 'pending',
  };
  let sessionArea;
  let activeReads = 0;
  const env = fixture({
    readActiveJob: async () => {
      activeReads += 1;
      if (activeReads === 2) sessionArea.values[key] = structuredClone(foreign);
      return null;
    },
  });
  sessionArea = env.sessionArea;
  const originalSet = env.sessionArea.set.bind(env.sessionArea);
  let writes = 0;
  env.sessionArea.set = async entries => { writes += 1; await originalSet(entries); };

  const registration = await env.coordinator.withWindowLock(9, scope => scope.registerAndPublishViewOnly({
    auditId: 'audit-port', sessionCapabilityId: VIEW_SESSION, windowId: 9,
    createdAt: EPOCH + 1, expiresAt: EPOCH + 10_000, resultBundle,
  }));

  assert.equal(activeReads, 2);
  assert.deepEqual(registration, { registered: false, delivered: false, code: 'AUDIT_RECOVERY_REQUIRED' });
  assert.equal(writes, 0);
  assert.deepEqual(env.sessionArea.values[key], foreign);
});

test('view-only pending registration reconciles a landed write when its first confirmation read throws', async () => {
  const resultBundle = await bundle();
  const env = fixture();
  const key = panelBootstrapStorageKey(9);
  const originalGet = env.sessionArea.get.bind(env.sessionArea);
  const originalSet = env.sessionArea.set.bind(env.sessionArea);
  let pendingWritten = false;
  let confirmationFailed = false;
  env.sessionArea.set = async entries => {
    await originalSet(entries);
    pendingWritten = true;
  };
  env.sessionArea.get = async requestedKey => {
    if (requestedKey === key && pendingWritten && !confirmationFailed) {
      confirmationFailed = true;
      throw new Error('PRIVATE_CONFIRMATION_FAILURE');
    }
    return originalGet(requestedKey);
  };

  const registration = await env.coordinator.withWindowLock(9, scope => scope.registerAndPublishViewOnly({
    auditId: 'audit-port', sessionCapabilityId: VIEW_SESSION, windowId: 9,
    createdAt: EPOCH + 1, expiresAt: EPOCH + 10_000, resultBundle,
  }));

  assert.deepEqual(registration, { registered: false, delivered: false, code: 'AUDIT_REHYDRATE_DENIED' });
  assert.equal(confirmationFailed, true);
  assert.equal(Object.hasOwn(env.sessionArea.values, key), false);
  assert.doesNotMatch(JSON.stringify(registration), /PRIVATE_CONFIRMATION_FAILURE/u);
});

test('view-only pending confirmation preserves stable foreign drift and requires recovery', async () => {
  const resultBundle = await bundle();
  const env = fixture();
  const key = panelBootstrapStorageKey(9);
  const foreign = {
    version: 1, kind: 'audit-session', auditId: 'foreign-audit', sessionCapabilityId: 'F'.repeat(22),
    windowId: 9, createdAt: EPOCH, expiresAt: EPOCH + 10_000, state: 'pending',
  };
  const originalSet = env.sessionArea.set.bind(env.sessionArea);
  env.sessionArea.set = async entries => {
    await originalSet(entries);
    env.sessionArea.values[key] = structuredClone(foreign);
  };

  const registration = await env.coordinator.withWindowLock(9, scope => scope.registerAndPublishViewOnly({
    auditId: 'audit-port', sessionCapabilityId: VIEW_SESSION, windowId: 9,
    createdAt: EPOCH + 1, expiresAt: EPOCH + 10_000, resultBundle,
  }));

  assert.deepEqual(registration, { registered: false, delivered: false, code: 'AUDIT_RECOVERY_REQUIRED' });
  assert.deepEqual(env.sessionArea.values[key], foreign);
});

test('view-only consumed confirmation preserves stable foreign drift and cannot claim registration', async () => {
  const resultBundle = await bundle();
  const env = fixture();
  const connected = port();
  env.coordinator.attachPanelPort(connected);
  connected.onMessage.emit({ protocol: 'audita-panel', version: 1, type: 'bootstrap' });
  await tick();
  const key = panelBootstrapStorageKey(9);
  const foreign = {
    version: 1, kind: 'audit-session', auditId: 'foreign-audit', sessionCapabilityId: 'F'.repeat(22),
    windowId: 9, createdAt: EPOCH, expiresAt: EPOCH + 10_000, state: 'consumed',
  };
  const originalSet = env.sessionArea.set.bind(env.sessionArea);
  let writes = 0;
  env.sessionArea.set = async entries => {
    await originalSet(entries);
    writes += 1;
    if (writes === 2) env.sessionArea.values[key] = structuredClone(foreign);
  };

  const registration = await env.coordinator.withWindowLock(9, scope => scope.registerAndPublishViewOnly({
    auditId: 'audit-port', sessionCapabilityId: VIEW_SESSION, windowId: 9,
    createdAt: EPOCH + 1, expiresAt: EPOCH + 10_000, resultBundle,
  }));

  assert.equal(writes, 2);
  assert.deepEqual(registration, { registered: false, delivered: false, code: 'AUDIT_RECOVERY_REQUIRED' });
  assert.deepEqual(env.sessionArea.values[key], foreign);
  assert.equal(connected.messages.some(message => message.state === 'view-only'), false);
});

test('view-only registration restores the exact prior bootstrap when ACTIVE appears during the pending write', async () => {
  const resultBundle = await bundle();
  const env = fixture();
  const oldSessionCapabilityId = 'O'.repeat(22);
  env.sessions.set(oldSessionCapabilityId, session('result', oldSessionCapabilityId));
  const prior = {
    version: 1, kind: 'audit-session', auditId: 'audit-port', sessionCapabilityId: oldSessionCapabilityId,
    windowId: 9, createdAt: EPOCH, expiresAt: EPOCH + 10_000, state: 'consumed',
  };
  env.sessionArea.values[panelBootstrapStorageKey(9)] = structuredClone(prior);
  const originalSet = env.sessionArea.set.bind(env.sessionArea);
  let writes = 0;
  env.sessionArea.set = async entries => {
    await originalSet(entries);
    writes += 1;
    if (writes === 1) env.setActive(foreignRunningActive());
  };

  const registration = await env.coordinator.withWindowLock(9, scope => scope.registerAndPublishViewOnly({
    auditId: 'audit-port', sessionCapabilityId: VIEW_SESSION, windowId: 9,
    createdAt: EPOCH + 1, expiresAt: EPOCH + 10_000, resultBundle,
  }));

  assert.deepEqual(registration, { registered: false, delivered: false, code: 'AUDIT_REHYDRATE_DENIED' });
  assert.deepEqual(env.sessionArea.values[panelBootstrapStorageKey(9)], prior);
  assert.deepEqual(env.getActive(), foreignRunningActive());
});

test('view-only registration rolls consumed back to confirmed pending when ACTIVE appears during the consumed write', async () => {
  const resultBundle = await bundle();
  const env = fixture();
  const connected = port();
  env.coordinator.attachPanelPort(connected);
  connected.onMessage.emit({ protocol: 'audita-panel', version: 1, type: 'bootstrap' });
  await tick();
  const originalSet = env.sessionArea.set.bind(env.sessionArea);
  let writes = 0;
  env.sessionArea.set = async entries => {
    await originalSet(entries);
    writes += 1;
    if (writes === 2) env.setActive(foreignRunningActive());
  };

  const registration = await env.coordinator.withWindowLock(9, scope => scope.registerAndPublishViewOnly({
    auditId: 'audit-port', sessionCapabilityId: VIEW_SESSION, windowId: 9,
    createdAt: EPOCH + 1, expiresAt: EPOCH + 10_000, resultBundle,
  }));

  assert.deepEqual(registration, { registered: true, delivered: false });
  assert.equal(env.sessionArea.values[panelBootstrapStorageKey(9)].state, 'pending');
  assert.equal(env.sessionArea.values[panelBootstrapStorageKey(9)].sessionCapabilityId, VIEW_SESSION);
  assert.equal(connected.messages.some(message => message.state === 'view-only'), false);
  assert.deepEqual(env.getActive(), foreignRunningActive());
});

test('view-only registration rechecks ACTIVE after reproof and retains only confirmed pending registration', async () => {
  const resultBundle = await bundle();
  const env = fixture();
  const connected = port();
  env.coordinator.attachPanelPort(connected);
  connected.onMessage.emit({ protocol: 'audita-panel', version: 1, type: 'bootstrap' });
  await tick();
  env.chromeApi.runtime.getContexts = async () => {
    env.setActive(foreignRunningActive());
    return [{
      contextId: 'panel-context', documentId: 'panel-document', documentUrl: PANEL_URL,
      contextType: 'SIDE_PANEL', tabId: -1, windowId: -1,
    }];
  };

  const registration = await env.coordinator.withWindowLock(9, scope => scope.registerAndPublishViewOnly({
    auditId: 'audit-port', sessionCapabilityId: VIEW_SESSION, windowId: 9,
    createdAt: EPOCH + 1, expiresAt: EPOCH + 10_000, resultBundle,
  }));

  assert.deepEqual(registration, { registered: true, delivered: false });
  assert.equal(env.sessionArea.values[panelBootstrapStorageKey(9)].state, 'pending');
  assert.equal(env.sessionArea.values[panelBootstrapStorageKey(9)].sessionCapabilityId, VIEW_SESSION);
  assert.equal(connected.messages.some(message => message.state === 'view-only'), false);
  assert.deepEqual(env.getActive(), foreignRunningActive());
});

test('view-only registration reports recovery-required when removing its replacement cannot be confirmed', async () => {
  const resultBundle = await bundle();
  const env = fixture();
  const originalSet = env.sessionArea.set.bind(env.sessionArea);
  env.sessionArea.set = async entries => {
    await originalSet(entries);
    env.setActive(foreignRunningActive());
  };
  env.sessionArea.remove = async removedKey => {
    assert.equal(removedKey, panelBootstrapStorageKey(9));
  };

  const registration = await env.coordinator.withWindowLock(9, scope => scope.registerAndPublishViewOnly({
    auditId: 'audit-port', sessionCapabilityId: VIEW_SESSION, windowId: 9,
    createdAt: EPOCH + 1, expiresAt: EPOCH + 10_000, resultBundle,
  }));

  assert.deepEqual(registration, { registered: false, delivered: false, code: 'AUDIT_RECOVERY_REQUIRED' });
  assert.equal(env.sessionArea.values[panelBootstrapStorageKey(9)].sessionCapabilityId, VIEW_SESSION);
  assert.deepEqual(env.getActive(), foreignRunningActive());
});

test('view-only registration reports recovery-required when restoring its exact prior bootstrap throws', async () => {
  const resultBundle = await bundle();
  const env = fixture();
  const oldSessionCapabilityId = 'O'.repeat(22);
  env.sessions.set(oldSessionCapabilityId, session('result', oldSessionCapabilityId));
  env.sessionArea.values[panelBootstrapStorageKey(9)] = {
    version: 1, kind: 'audit-session', auditId: 'audit-port', sessionCapabilityId: oldSessionCapabilityId,
    windowId: 9, createdAt: EPOCH, expiresAt: EPOCH + 10_000, state: 'consumed',
  };
  const originalSet = env.sessionArea.set.bind(env.sessionArea);
  let writes = 0;
  env.sessionArea.set = async entries => {
    writes += 1;
    if (writes === 2) throw new Error('PRIVATE_RESTORE_FAILURE');
    await originalSet(entries);
    env.setActive(foreignRunningActive());
  };

  const registration = await env.coordinator.withWindowLock(9, scope => scope.registerAndPublishViewOnly({
    auditId: 'audit-port', sessionCapabilityId: VIEW_SESSION, windowId: 9,
    createdAt: EPOCH + 1, expiresAt: EPOCH + 10_000, resultBundle,
  }));

  assert.deepEqual(registration, { registered: false, delivered: false, code: 'AUDIT_RECOVERY_REQUIRED' });
  assert.equal(env.sessionArea.values[panelBootstrapStorageKey(9)].sessionCapabilityId, VIEW_SESSION);
  assert.deepEqual(env.getActive(), foreignRunningActive());
  assert.doesNotMatch(JSON.stringify(registration), /PRIVATE_RESTORE_FAILURE/u);
});

test('a live view-only send failure remains durably registered for reconnect', async () => {
  const resultBundle = await bundle();
  const env = fixture();
  const connected = port({ failState: 'view-only' });
  env.coordinator.attachPanelPort(connected);
  connected.onMessage.emit({ protocol: 'audita-panel', version: 1, type: 'bootstrap' });
  await tick();
  const result = await env.coordinator.withWindowLock(9, scope => scope.registerAndPublishViewOnly({
    auditId: 'audit-port', sessionCapabilityId: VIEW_SESSION, windowId: 9,
    createdAt: EPOCH + 1, expiresAt: EPOCH + 10_000, resultBundle,
  }));
  assert.deepEqual(result, { registered: true, delivered: false });
  assert.equal(env.sessionArea.values[panelBootstrapStorageKey(9)].state, 'consumed');
});

test('disconnectSession removes a correlated durable bootstrap even when no live port exists', async () => {
  const env = fixture();
  env.sessionArea.values[panelBootstrapStorageKey(9)] = {
    version: 1, kind: 'audit-session', auditId: 'audit-port', sessionCapabilityId: SESSION,
    windowId: 9, createdAt: EPOCH, expiresAt: EPOCH + 10_000, state: 'pending',
  };

  const disconnected = await env.coordinator.withWindowLock(9, scope => scope.disconnectSession({
    auditId: 'audit-port', sessionCapabilityId: SESSION, windowId: 9, reasonCode: 'AUDIT_INTERRUPTED',
  }));

  assert.equal(disconnected, true);
  assert.equal(Object.hasOwn(env.sessionArea.values, panelBootstrapStorageKey(9)), false);
});

test('disconnectSession preserves a foreign durable bootstrap and reports cleanup failure', async () => {
  const env = fixture();
  env.sessionArea.values[panelBootstrapStorageKey(9)] = {
    version: 1, kind: 'audit-session', auditId: 'foreign-audit', sessionCapabilityId: 'F'.repeat(22),
    windowId: 9, createdAt: EPOCH, expiresAt: EPOCH + 10_000, state: 'pending',
  };

  const disconnected = await env.coordinator.withWindowLock(9, scope => scope.disconnectSession({
    auditId: 'audit-port', sessionCapabilityId: SESSION, windowId: 9, reasonCode: 'AUDIT_INTERRUPTED',
  }));

  assert.equal(disconnected, false);
  assert.equal(env.sessionArea.values[panelBootstrapStorageKey(9)].auditId, 'foreign-audit');
});

test('disconnectSession detects and preserves a concurrent bootstrap replacement', async () => {
  const env = fixture();
  const key = panelBootstrapStorageKey(9);
  env.sessionArea.values[key] = {
    version: 1, kind: 'audit-session', auditId: 'audit-port', sessionCapabilityId: SESSION,
    windowId: 9, createdAt: EPOCH, expiresAt: EPOCH + 10_000, state: 'pending',
  };
  const replacement = {
    version: 1, kind: 'audit-session', auditId: 'foreign-replacement', sessionCapabilityId: 'R'.repeat(22),
    windowId: 9, createdAt: EPOCH + 1, expiresAt: EPOCH + 10_000, state: 'pending',
  };
  env.sessionArea.remove = async removedKey => {
    assert.equal(removedKey, key);
    env.sessionArea.values[key] = structuredClone(replacement);
  };

  const disconnected = await env.coordinator.withWindowLock(9, scope => scope.disconnectSession({
    auditId: 'audit-port', sessionCapabilityId: SESSION, windowId: 9, reasonCode: 'AUDIT_INTERRUPTED',
  }));

  assert.equal(disconnected, false);
  assert.deepEqual(env.sessionArea.values[key], replacement);
});

test('terminal hello rotates to a fresh view-only session and sends a bearer-free result to UI callbacks only', async () => {
  const resultBundle = await bundle();
  const env = fixture({ loadPanelResultBundle: async () => resultBundle });
  env.sessions.set(SESSION, session('result'));
  env.sessionArea.values[panelBootstrapStorageKey(9)] = {
    version: 1, kind: 'audit-session', auditId: 'audit-port', sessionCapabilityId: SESSION,
    windowId: 9, createdAt: EPOCH, expiresAt: EPOCH + 10_000, state: 'consumed',
  };
  const connected = port();
  env.coordinator.attachPanelPort(connected);
  connected.onMessage.emit({ protocol: 'audita-panel', version: 1, type: 'bootstrap' });
  await tick();
  assert.equal(connected.messages[0].state, 'view-only');
  assert.equal(connected.messages[0].sessionCapabilityId, VIEW_SESSION);
  assert.equal(connected.messages[0].result.auditId, 'audit-port');
  assert.equal(env.sessionArea.values[panelBootstrapStorageKey(9)].sessionCapabilityId, VIEW_SESSION);
  assert.equal(env.sessionArea.values[panelBootstrapStorageKey(9)].state, 'consumed');
});

test('terminal hello restores its exact prior bootstrap when foreign ACTIVE appears during replacement write', async () => {
  const resultBundle = await bundle();
  const env = fixture({ loadPanelResultBundle: async () => resultBundle });
  env.sessions.set(SESSION, session('result'));
  const prior = {
    version: 1, kind: 'audit-session', auditId: 'audit-port', sessionCapabilityId: SESSION,
    windowId: 9, createdAt: EPOCH, expiresAt: EPOCH + 10_000, state: 'consumed',
  };
  env.sessionArea.values[panelBootstrapStorageKey(9)] = structuredClone(prior);
  const originalSet = env.sessionArea.set.bind(env.sessionArea);
  env.sessionArea.set = async entries => {
    await originalSet(entries);
    env.setActive(foreignRunningActive());
  };
  const connected = port();

  env.coordinator.attachPanelPort(connected);
  connected.onMessage.emit({ protocol: 'audita-panel', version: 1, type: 'bootstrap' });
  await tick();

  assert.equal(connected.messages.length, 0);
  assert.equal(connected.disconnects, 1);
  assert.deepEqual(env.revoked, [{ sessionCapabilityId: VIEW_SESSION, auditId: 'audit-port' }]);
  assert.deepEqual(env.getActive(), foreignRunningActive());
  assert.deepEqual(env.sessionArea.values[panelBootstrapStorageKey(9)], prior);
});

test('terminal hello restores its exact prior bootstrap when foreign ACTIVE appears during final reproof', async () => {
  const resultBundle = await bundle();
  const env = fixture({ loadPanelResultBundle: async () => resultBundle });
  env.sessions.set(SESSION, session('result'));
  const prior = {
    version: 1, kind: 'audit-session', auditId: 'audit-port', sessionCapabilityId: SESSION,
    windowId: 9, createdAt: EPOCH, expiresAt: EPOCH + 10_000, state: 'pending',
  };
  env.sessionArea.values[panelBootstrapStorageKey(9)] = structuredClone(prior);
  let contextReads = 0;
  env.chromeApi.runtime.getContexts = async () => {
    contextReads += 1;
    if (contextReads === 3) env.setActive(foreignRunningActive());
    return [{
      contextId: 'panel-context', documentId: 'panel-document', documentUrl: PANEL_URL,
      contextType: 'SIDE_PANEL', tabId: -1, windowId: -1,
    }];
  };
  const connected = port();

  env.coordinator.attachPanelPort(connected);
  connected.onMessage.emit({ protocol: 'audita-panel', version: 1, type: 'bootstrap' });
  await tick();

  assert.equal(contextReads, 3);
  assert.equal(connected.messages.length, 0);
  assert.equal(connected.disconnects, 1);
  assert.deepEqual(env.revoked, [{ sessionCapabilityId: VIEW_SESSION, auditId: 'audit-port' }]);
  assert.deepEqual(env.getActive(), foreignRunningActive());
  assert.deepEqual(env.sessionArea.values[panelBootstrapStorageKey(9)], prior);
});

test('terminal hello denies publication and preserves its replacement when rollback cannot be confirmed', async () => {
  const resultBundle = await bundle();
  const env = fixture({ loadPanelResultBundle: async () => resultBundle });
  env.sessions.set(SESSION, session('result'));
  const prior = {
    version: 1, kind: 'audit-session', auditId: 'audit-port', sessionCapabilityId: SESSION,
    windowId: 9, createdAt: EPOCH, expiresAt: EPOCH + 10_000, state: 'consumed',
  };
  env.sessionArea.values[panelBootstrapStorageKey(9)] = structuredClone(prior);
  const originalSet = env.sessionArea.set.bind(env.sessionArea);
  let writes = 0;
  env.sessionArea.set = async entries => {
    writes += 1;
    if (writes === 1) {
      await originalSet(entries);
      env.setActive(foreignRunningActive());
    }
  };
  const connected = port();

  env.coordinator.attachPanelPort(connected);
  connected.onMessage.emit({ protocol: 'audita-panel', version: 1, type: 'bootstrap' });
  await tick();

  assert.equal(writes, 2);
  assert.equal(connected.messages.length, 0);
  assert.equal(connected.disconnects, 1);
  assert.deepEqual(env.revoked, [{ sessionCapabilityId: VIEW_SESSION, auditId: 'audit-port' }]);
  assert.deepEqual(env.getActive(), foreignRunningActive());
  assert.equal(env.sessionArea.values[panelBootstrapStorageKey(9)].sessionCapabilityId, VIEW_SESSION);
});
