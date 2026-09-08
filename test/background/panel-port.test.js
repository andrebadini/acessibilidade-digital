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
import { createPanelSessionPortClient } from '../../src/panel/panel-session-port.js';
import { SAMPLE_AUDIT } from '../../fixtures/audits/sample-audit.js';

const RUNTIME_ID = 'abcdefghijklmnopabcdefghijklmnop';
const SESSION = 'S'.repeat(22);
const VIEW_SESSION = 'V'.repeat(22);
const CONSENT = `${'P'.repeat(21)}Q`;
const PAUSE_MESSAGE = 'A página contém conteúdo potencialmente sensível. Confirme para capturar imagens visíveis.';
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

function linkedPanelPortPair({ coordinator, published, received }) {
  const clientMessage = event();
  const clientDisconnect = event();
  const serverMessage = event();
  const serverDisconnect = event();
  let connected = true;
  const close = () => {
    if (!connected) return;
    connected = false;
    serverDisconnect.emit();
    clientDisconnect.emit();
  };
  const client = {
    onMessage: clientMessage,
    onDisconnect: clientDisconnect,
    postMessage(value) {
      if (!connected) throw new Error('PORT_DISCONNECTED');
      const copy = structuredClone(value);
      received.push(copy);
      queueMicrotask(() => { if (connected) serverMessage.emit(copy); });
    },
    disconnect: close,
  };
  const server = {
    name: PANEL_PORT_NAME,
    sender: {
      id: RUNTIME_ID, url: PANEL_URL,
      origin: `chrome-extension://${RUNTIME_ID}`,
    },
    onMessage: serverMessage,
    onDisconnect: serverDisconnect,
    postMessage(value) {
      if (!connected) throw new Error('PORT_DISCONNECTED');
      const copy = structuredClone(value);
      published.push(copy);
      queueMicrotask(() => { if (connected) clientMessage.emit(copy); });
    },
    disconnect: close,
  };
  assert.equal(coordinator.attachPanelPort(server), true);
  return { client, close };
}

function area() {
  const values = Object.create(null);
  return {
    values,
    async get(key) {
      if (key === null) return structuredClone(values);
      return Object.hasOwn(values, key) ? { [key]: structuredClone(values[key]) } : {};
    },
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
    throwOnType: null,
    postMessage(message) {
      if (postError || message.state === failState || message.type === this.throwOnType) throw new Error('native secret');
      this.messages.push(structuredClone(message));
    },
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

function suspension(overrides = {}) {
  return Object.freeze({
    version: 'AuditSuspensionV1', revision: 1, auditId: 'audit-port', consentId: CONSENT,
    tabId: 17, windowId: 9, documentId: 'page-document',
    urlEvidence: {
      version: 'EvidenceUrlV1', href: 'https://example.test/',
      queryIncluded: false, redactedSegments: 0,
    },
    urlSessionDigest: `hmac-sha256:${'A'.repeat(43)}`,
    mode: 'full-evidence',
    capturePolicy: {
      version: 'CapturePolicyV1', mode: 'full-evidence', includeQuery: false,
      captureFullPage: true, captureElements: true, composeAnnouncementMap: true,
    },
    categories: ['password', 'payment'],
    issuedAt: EPOCH, updatedAt: EPOCH, expiresAt: EPOCH + 5_000,
    cleanupAttempts: 0, cleanupNotBefore: null,
    state: 'paused', resumePhase: null, revokeReason: null,
    source: { kind: 'attached' },
    ...overrides,
  });
}

async function bundle(auditId = 'audit-port', modelRevision = 1) {
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
    reportRevision: { version: 1, auditId, modelRevision, modelHash: model.integrity.canonicalModelHash, model, checkpoint },
    inventory,
  });
}

function fixture(overrides = {}) {
  const sessionArea = area();
  const sessions = new Map([[SESSION, session('running')], [VIEW_SESSION, session('view-only', VIEW_SESSION)]]);
  let active = null;
  const suspensions = new Map();
  const timers = [];
  const revoked = [];
  const launchRevoked = [];
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
    readPixelSuspension: async auditId => suspensions.get(auditId) ?? null,
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
      async retirePort(admission) {
        launchRevoked.push(admission);
        return Object.freeze({ version: 1, state: 'released' });
      },
      async revoke(admission) { launchRevoked.push(admission); return { ok: true, revoked: true }; },
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
    chromeApi, sessionArea, sessions, suspensions, timers, revoked, launchRevoked,
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

function privacyPausedActive(overrides = {}) {
  return Object.freeze({
    ...runningActive(), state: 'privacy-paused', ...overrides,
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

function markerAuthorization(value, overrides = {}) {
  return {
    ok: true,
    session: {
      ...session('result'),
      consumers: [{ name: 'panel', path: '/src/panel/index.html', contextType: 'SIDE_PANEL' }],
      intents: { panel: { running: ['cancel'], result: ['open-report', 'review-markers'], 'view-only': ['open-report', 'review-markers'] }, review: {} },
      ...overrides,
    },
    context: {
      issuer: { type: 'extension-document', documentId: value.sender.documentId, path: '/src/panel/index.html' },
      windowId: value.claimedWindowId, tabId: null, contextType: 'SIDE_PANEL', documentUrl: value.sender.url,
    },
  };
}

async function markerFixture(overrides = {}) {
  const closed = [];
  const dispatched = [];
  const env = fixture({
    authorizePageMarkersSession: async value => markerAuthorization(value),
    closePanelMarkers: value => { closed.push(value); return Promise.resolve(true); },
    dispatchPanelIntent: async value => { dispatched.push(value); return { ok: false, code: 'PAGE_MARKERS_UNAVAILABLE' }; },
    ...overrides,
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
  const resultBundle = await bundle();
  const delivered = await env.coordinator.withWindowLock(9, scope => scope.publishResult({
    auditId: 'audit-port', sessionCapabilityId: SESSION, windowId: 9, state: 'result', resultBundle,
  }));
  assert.equal(delivered.state, 'delivered');
  return { ...env, connected, closed, dispatched, resultBundle };
}

function requestMarkers(env, modelRevision = 1) {
  env.connected.onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'intent', requestId: 'markers-request',
    envelope: { type: 'PANEL_SHOW_PAGE_MARKERS', auditId: 'audit-port', sessionCapabilityId: SESSION, modelRevision },
  });
}

function markerPublication(extra = {}) {
  return { windowId: 9, sessionCapabilityId: SESSION, auditId: 'audit-port', modelRevision: 1,
    state: 'active', selectedOrdinal: 0, ...extra };
}

test('page-marker admitted dispatch retains a private current callback beyond the response and cancels before disconnect cleanup awaits', async () => {
  const closed = [];
  const env = await markerFixture({ closePanelMarkers: value => { closed.push(value); return new Promise(() => {}); } });
  requestMarkers(env);
  await tick();
  assert.equal(env.dispatched.length, 1);
  const request = env.dispatched[0];
  assert.equal(request.panelWindowId, 9);
  assert.equal(request.envelope.windowId, 9);
  assert.equal(request.isCurrent(), true);
  env.connected.onDisconnect.emit();
  assert.equal(request.isCurrent(), false);
  assert.deepEqual(closed, [{ windowId: 9, sessionCapabilityId: SESSION }]);
  await tick();
  assert.equal(env.launchRevoked.length, 1, 'marker cleanup must not hold existing retirement');
});

test('page-marker publication is sender-bound and strips private correlation for result and view-only copy grants', async () => {
  for (const state of ['result', 'view-only']) {
    const calls = [];
    const env = await markerFixture({ authorizePageMarkersSession: async value => {
      calls.push(value);
      return markerAuthorization(value, { state, mode: 'single', targetBinding: state === 'view-only'
        ? { kind: 'view-only' } : { kind: 'disposable', ownershipId: `owner_${'a'.repeat(22)}`, state: 'removed' } });
    } });
    assert.deepEqual(await env.coordinator.publishPageMarkersState(markerPublication()), { delivered: 1 });
    assert.deepEqual(env.connected.messages.at(-1), {
      version: 1, type: 'PAGE_MARKERS_STATE_CHANGED', auditId: 'audit-port', modelRevision: 1, state: 'active', selectedOrdinal: 0,
    });
    assert.equal(calls[0].claimedWindowId, 9);
    assert.equal(calls[0].sender.documentId, 'panel-document');
    assert.equal(Object.hasOwn(calls[0], 'tabId'), false);
  }
});

test('page-marker stale or foreign events have no effects and cannot disconnect another panel', async () => {
  let authorizations = 0;
  const env = await markerFixture({ authorizePageMarkersSession: async value => { authorizations += 1; return markerAuthorization(value); } });
  const before = env.connected.messages.length;
  const events = [
    { auditId: 'foreign' }, { sessionCapabilityId: 'X'.repeat(22) }, { windowId: 10 }, { modelRevision: 2 },
    { selectedOrdinal: env.resultBundle.details.length }, { selectedOrdinal: '0' }, { state: 'clear' },
    { installationId: 'a'.repeat(22) },
  ].map(extra => markerPublication(extra));
  let getterReads = 0;
  events.push(Object.defineProperty(markerPublication(), 'modelRevision', { enumerable: true, get() { getterReads += 1; return 1; } }));
  for (const value of events) assert.deepEqual(await env.coordinator.publishPageMarkersState(value), { delivered: 0 });
  assert.equal(authorizations, 0);
  assert.equal(getterReads, 0);
  assert.equal(env.connected.messages.length, before);
  assert.equal(env.connected.disconnects, 0);
});

test('page-marker publication rejects batch, missing grant and expiry reached during authorization', async () => {
  for (const kind of ['batch', 'no-intent', 'expires-during-await']) {
    let clock = EPOCH + 1;
    const env = await markerFixture({ epochNow: () => clock, authorizePageMarkersSession: async value => {
      if (kind === 'expires-during-await') clock = EPOCH + 10_000;
      return markerAuthorization(value, kind === 'batch' ? { mode: 'batch' }
        : kind === 'no-intent' ? { intents: { panel: { running: [], result: ['open-report'], 'view-only': ['open-report'] }, review: {} } } : {});
    } });
    const before = env.connected.messages.length;
    assert.deepEqual(await env.coordinator.publishPageMarkersState(markerPublication()), { delivered: 0 });
    assert.equal(env.connected.messages.length, before);
  }
});

test('page-marker delayed active cannot overwrite a later clear on the same delivered result', async () => {
  let release;
  let count = 0;
  const env = await markerFixture({ authorizePageMarkersSession: async value => {
    if (++count === 1) await new Promise(resolve => { release = resolve; });
    return markerAuthorization(value);
  } });
  const active = env.coordinator.publishPageMarkersState(markerPublication());
  await tick();
  assert.equal(typeof release, 'function');
  assert.deepEqual(await env.coordinator.publishPageMarkersState(markerPublication({ state: 'clear', selectedOrdinal: null })), { delivered: 1 });
  release();
  assert.deepEqual(await active, { delivered: 0 });
  assert.equal(env.connected.messages.at(-1).state, 'clear');
});

test('page-marker receipt replacement and failed delivery invalidate callbacks without waiting for cleanup', async () => {
  const env = await markerFixture();
  requestMarkers(env);
  await tick();
  const isCurrent = env.dispatched[0].isCurrent;
  const next = await bundle('audit-port', 2);
  const delivered = await env.coordinator.withWindowLock(9, scope => scope.publishResult({
    auditId: 'audit-port', sessionCapabilityId: SESSION, windowId: 9, state: 'result', resultBundle: next,
  }));
  assert.equal(delivered.state, 'delivered');
  assert.equal(isCurrent(), false);
  assert.deepEqual(env.closed, [{ windowId: 9, sessionCapabilityId: SESSION }]);
  await env.coordinator.withWindowLock(9, scope => scope.publishResult({
    auditId: 'audit-port', sessionCapabilityId: SESSION, windowId: 9, state: 'result', resultBundle: env.resultBundle,
  }));
  assert.equal(isCurrent(), false, 'equal values cannot revive an earlier delivery identity');
  env.connected.throwOnType = 'bootstrap-result';
  const failed = await env.coordinator.withWindowLock(9, scope => scope.publishResult({
    auditId: 'audit-port', sessionCapabilityId: SESSION, windowId: 9, state: 'result', resultBundle: next,
  }));
  assert.notEqual(failed.state, 'delivered');
  assert.deepEqual(await env.coordinator.publishPageMarkersState(markerPublication({ modelRevision: 2 })), { delivered: 0 });
});

test('page-marker delete invalidates callbacks before the audit inventory await', async () => {
  const env = await markerFixture();
  requestMarkers(env);
  await tick();
  const isCurrent = env.dispatched[0].isCurrent;
  const get = env.sessionArea.get.bind(env.sessionArea);
  let release;
  env.sessionArea.get = async key => {
    if (key === null) await new Promise(resolve => { release = resolve; });
    return get(key);
  };
  const clearing = env.coordinator.clearAudit('audit-port');
  assert.equal(isCurrent(), false);
  assert.deepEqual(env.closed, [{ windowId: 9, sessionCapabilityId: SESSION }]);
  release();
  await clearing;
});

test('page-marker same-revision result after a running interval never revives an earlier receipt', async () => {
  const env = await markerFixture();
  requestMarkers(env);
  await tick();
  const isCurrent = env.dispatched[0].isCurrent;
  env.sessions.set(SESSION, session('running'));
  env.setActive(runningActive());
  assert.equal(await env.coordinator.withWindowLock(9, scope => scope.publishRunningResume({
    auditId: 'audit-port', sessionCapabilityId: SESSION, windowId: 9,
  })), true);
  assert.equal(isCurrent(), false);
  env.sessions.set(SESSION, session('result'));
  env.setActive(null);
  await env.coordinator.withWindowLock(9, scope => scope.publishResult({
    auditId: 'audit-port', sessionCapabilityId: SESSION, windowId: 9, state: 'result', resultBundle: env.resultBundle,
  }));
  assert.equal(isCurrent(), false);
  assert.deepEqual(await env.coordinator.publishPageMarkersState(markerPublication()), { delivered: 1 });
});

test('page-marker optional factory is all-or-nothing and stale dispatch cannot reach the controller', async () => {
  assert.throws(() => fixture({ authorizePageMarkersSession: async () => ({ ok: false }) }), /PANEL_PORT_COORDINATOR_INVALID/);
  assert.throws(() => fixture({ closePanelMarkers: async () => true }), /PANEL_PORT_COORDINATOR_INVALID/);
  assert.throws(() => fixture({ authorizePageMarkersSession: null, closePanelMarkers: async () => true }), /PANEL_PORT_COORDINATOR_INVALID/);
  const env = await markerFixture();
  requestMarkers(env, 2);
  await tick();
  assert.deepEqual(env.dispatched, []);
});

function launchAuthorityWithRetirement(retirePort) {
  let owner = null;
  return Object.freeze({
    async admitPort({ sender }) {
      owner = Object.freeze({
        ok: true, token: LAUNCH_TOKEN, tabId: 17, windowId: 9, generation: 1,
        contextId: 'panel-context', documentId: 'panel-document', url: sender.url,
        syntheticSender: Object.freeze({ ...sender, documentId: 'panel-document' }),
      });
      return owner;
    },
    async reprove(admission) {
      return admission === owner ? admission : Object.freeze({ ok: false, code: 'PANEL_LAUNCH_DENIED' });
    },
    retirePort,
    async revoke() { return Object.freeze({ ok: true, revoked: true }); },
  });
}

test('exports only lock entry and attaches fresh owner-bound mutation scopes', async () => {
  const { coordinator } = fixture();
  assert.deepEqual(Object.keys(coordinator), ['attachPanelPort', 'withWindowLock', 'publishHighlightState', 'clearAudit']);
  assert.equal(Object.isFrozen(coordinator), true);

  let retained;
  await coordinator.withWindowLock(9, async scope => {
    retained = scope;
    assert.deepEqual(Object.keys(scope), [
      'registerPendingBootstrap', 'publishRegisteredBootstrap', 'publishResult',
      'registerAndPublishViewOnly', 'publishPrivacyPaused', 'publishRunningResume',
      'disconnectSession',
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

test('publishes one exact private pause packet only after durable correlation', async () => {
  const reads = [];
  const env = fixture({
    async readPixelSuspension(auditId) {
      reads.push(auditId);
      return env.suspensions.get(auditId) ?? null;
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
  env.sessions.set(SESSION, session('privacy-paused'));
  env.setActive(privacyPausedActive());
  env.suspensions.set('audit-port', suspension());

  const delivered = await env.coordinator.withWindowLock(9, scope => scope.publishPrivacyPaused({
    auditId: 'audit-port', sessionCapabilityId: SESSION, windowId: 9,
  }));

  assert.equal(delivered, true);
  assert.deepEqual(reads, ['audit-port', 'audit-port']);
  assert.deepEqual(connected.messages.at(-1), {
    protocol: 'audita-panel', version: 1, type: 'privacy-paused',
    auditId: 'audit-port', sessionCapabilityId: SESSION, consentId: CONSENT,
    mode: 'full-evidence', categories: ['password', 'payment'], message: PAUSE_MESSAGE,
  });
  assert.doesNotMatch(JSON.stringify(connected.messages.at(-1)), /page-document|hmac-sha256|tabId|url/u);
  assert.doesNotMatch(JSON.stringify(env.sessionArea.values), new RegExp(CONSENT, 'u'));
});

test('retires an in-flight privacy-paused cancellation to idle without dropping the admitted Port', async () => {
  let env;
  env = fixture({
    async dispatchPanelIntent(request) {
      assert.deepEqual(request.envelope, {
        type: 'PANEL_CANCEL_AUDIT', sessionCapabilityId: SESSION,
        auditId: 'audit-port', windowId: 9,
      });
      env.sessions.set(SESSION, session('revoked'));
      env.setActive(null);
      assert.equal(await env.coordinator.withWindowLock(9, scope => scope.disconnectSession({
        auditId: 'audit-port', sessionCapabilityId: SESSION,
        windowId: 9, reasonCode: 'AUDIT_CANCELLED',
      })), true);
      return { ok: true, auditId: 'audit-port', state: 'revoked' };
    },
  });
  env.sessions.set(SESSION, session('privacy-paused'));
  env.setActive(privacyPausedActive());
  env.suspensions.set('audit-port', suspension());
  env.sessionArea.values[panelBootstrapStorageKey(9)] = {
    version: 1, kind: 'audit-session', auditId: 'audit-port', sessionCapabilityId: SESSION,
    windowId: 9, createdAt: EPOCH, expiresAt: EPOCH + 10_000, state: 'pending',
  };
  const connected = port();
  env.coordinator.attachPanelPort(connected);
  connected.onMessage.emit({ protocol: 'audita-panel', version: 1, type: 'bootstrap' });
  await tick();
  assert.equal(connected.messages.at(-1).type, 'privacy-paused');

  connected.onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'intent', requestId: 'cancel-request-1',
    envelope: { type: 'PANEL_CANCEL_AUDIT', sessionCapabilityId: SESSION, auditId: 'audit-port' },
  });
  connected.onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'intent', requestId: 'queued-request-2',
    envelope: { type: 'PREPARE_PANEL_CAPABILITY', requestId: 'prepare-queued' },
  });
  await tick();
  await tick();

  assert.deepEqual(connected.messages.at(-1), {
    protocol: 'audita-panel', version: 1, type: 'intent-result', requestId: 'cancel-request-1',
    response: { ok: true, auditId: 'audit-port', state: 'revoked' },
  });
  assert.equal(connected.disconnects, 0);
  assert.deepEqual(env.launchRevoked, []);
  assert.equal(Object.hasOwn(env.sessionArea.values, panelBootstrapStorageKey(9)), false);
  assert.equal(env.getActive(), null);
  assert.equal(connected.messages.some(message => message.requestId === 'queued-request-2'), false);
});

test('disconnects rigidly when privacy-paused cancellation cleanup cannot remove its bootstrap', async () => {
  let env;
  env = fixture({
    async dispatchPanelIntent() {
      env.sessions.set(SESSION, session('revoked'));
      env.setActive(null);
      assert.equal(await env.coordinator.withWindowLock(9, scope => scope.disconnectSession({
        auditId: 'audit-port', sessionCapabilityId: SESSION,
        windowId: 9, reasonCode: 'AUDIT_CANCELLED',
      })), false);
      return { ok: true, auditId: 'audit-port', state: 'revoked' };
    },
  });
  env.sessions.set(SESSION, session('privacy-paused'));
  env.setActive(privacyPausedActive());
  env.suspensions.set('audit-port', suspension());
  const key = panelBootstrapStorageKey(9);
  env.sessionArea.values[key] = {
    version: 1, kind: 'audit-session', auditId: 'audit-port', sessionCapabilityId: SESSION,
    windowId: 9, createdAt: EPOCH, expiresAt: EPOCH + 10_000, state: 'pending',
  };
  env.sessionArea.remove = async () => {};
  const connected = port();
  env.coordinator.attachPanelPort(connected);
  connected.onMessage.emit({ protocol: 'audita-panel', version: 1, type: 'bootstrap' });
  await tick();
  connected.onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'intent', requestId: 'cancel-cleanup-failure',
    envelope: { type: 'PANEL_CANCEL_AUDIT', sessionCapabilityId: SESSION, auditId: 'audit-port' },
  });
  await tick();
  await tick();

  assert.equal(connected.disconnects, 1);
  assert.equal(env.launchRevoked.length, 1);
  assert.equal(connected.messages.some(message => message.type === 'intent-result'), false);
  assert.equal(Object.hasOwn(env.sessionArea.values, key), true);
});

test('disconnects rigidly when a retired privacy-paused cancellation returns a non-exact response', async () => {
  let env;
  env = fixture({
    async dispatchPanelIntent() {
      env.sessions.set(SESSION, session('revoked'));
      env.setActive(null);
      assert.equal(await env.coordinator.withWindowLock(9, scope => scope.disconnectSession({
        auditId: 'audit-port', sessionCapabilityId: SESSION,
        windowId: 9, reasonCode: 'AUDIT_CANCELLED',
      })), true);
      return { ok: true, auditId: 'audit-port', state: 'revoked', extra: true };
    },
  });
  env.sessions.set(SESSION, session('privacy-paused'));
  env.setActive(privacyPausedActive());
  env.suspensions.set('audit-port', suspension());
  env.sessionArea.values[panelBootstrapStorageKey(9)] = {
    version: 1, kind: 'audit-session', auditId: 'audit-port', sessionCapabilityId: SESSION,
    windowId: 9, createdAt: EPOCH, expiresAt: EPOCH + 10_000, state: 'pending',
  };
  const connected = port();
  env.coordinator.attachPanelPort(connected);
  connected.onMessage.emit({ protocol: 'audita-panel', version: 1, type: 'bootstrap' });
  await tick();
  connected.onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'intent', requestId: 'cancel-malformed-result',
    envelope: { type: 'PANEL_CANCEL_AUDIT', sessionCapabilityId: SESSION, auditId: 'audit-port' },
  });
  await tick();
  await tick();

  assert.equal(connected.disconnects, 1);
  assert.equal(env.launchRevoked.length, 1);
  assert.equal(connected.messages.some(message => message.type === 'intent-result'), false);
});

test('confirms a durable pause without a Port and reconnects with the same consent token', async () => {
  const env = fixture();
  env.sessions.set(SESSION, session('privacy-paused'));
  env.setActive(privacyPausedActive());
  env.suspensions.set('audit-port', suspension());
  env.sessionArea.values[panelBootstrapStorageKey(9)] = {
    version: 1, kind: 'audit-session', auditId: 'audit-port', sessionCapabilityId: SESSION,
    windowId: 9, createdAt: EPOCH, expiresAt: EPOCH + 10_000, state: 'pending',
  };

  assert.equal(await env.coordinator.withWindowLock(9, scope => scope.publishPrivacyPaused({
    auditId: 'audit-port', sessionCapabilityId: SESSION, windowId: 9,
  })), true);
  assert.doesNotMatch(JSON.stringify(env.sessionArea.values), new RegExp(CONSENT, 'u'));

  const first = port();
  env.coordinator.attachPanelPort(first);
  first.onMessage.emit({ protocol: 'audita-panel', version: 1, type: 'bootstrap' });
  await tick();
  assert.equal(first.messages.at(-1).consentId, CONSENT);
  assert.equal(env.sessionArea.values[panelBootstrapStorageKey(9)].state, 'pending');
  first.onDisconnect.emit();

  const second = port({ documentId: 'panel-document-2' });
  env.coordinator.attachPanelPort(second);
  second.onMessage.emit({ protocol: 'audita-panel', version: 1, type: 'bootstrap' });
  await tick();
  assert.deepEqual(second.messages.at(-1), first.messages.at(-1));
  assert.equal(env.sessionArea.values[panelBootstrapStorageKey(9)].state, 'pending');
});

test('blocks malformed foreign expired or drifted suspensions before publication', async t => {
  const cases = [
    ['missing', null],
    ['extra', { ...suspension(), private: true }],
    ['foreign-audit', suspension({ auditId: 'foreign-audit' })],
    ['foreign-window', suspension({ windowId: 11 })],
    ['foreign-tab', suspension({ tabId: 19 })],
    ['foreign-document', suspension({ documentId: 'other-document' })],
    ['foreign-digest', suspension({ urlSessionDigest: `hmac-sha256:${'B'.repeat(43)}` })],
    ['expired', suspension({ expiresAt: EPOCH + 1 })],
    ['wrong-mode', suspension({ mode: 'element-only' })],
    ['unordered-categories', suspension({ categories: ['payment', 'password'] })],
    ['owned-source', suspension({ source: { kind: 'owned-disposable', ownershipId: 'owner-1', cleanupMode: 'always', pageId: null } })],
  ];
  for (const [name, candidate] of cases) await t.test(name, async () => {
    const env = fixture({ readPixelSuspension: async () => candidate });
    env.sessions.set(SESSION, session('privacy-paused'));
    env.setActive(privacyPausedActive());
    env.sessionArea.values[panelBootstrapStorageKey(9)] = {
      version: 1, kind: 'audit-session', auditId: 'audit-port', sessionCapabilityId: SESSION,
      windowId: 9, createdAt: EPOCH, expiresAt: EPOCH + 10_000, state: 'consumed',
    };
    assert.equal(await env.coordinator.withWindowLock(9, scope => scope.publishPrivacyPaused({
      auditId: 'audit-port', sessionCapabilityId: SESSION, windowId: 9,
    })), false);
  });

  let sessionReads = 0;
  const drift = fixture({
    async readAuditSession() {
      sessionReads += 1;
      return session(sessionReads === 1 ? 'privacy-paused' : 'running');
    },
    readPixelSuspension: async () => suspension(),
  });
  drift.setActive(privacyPausedActive());
  drift.sessionArea.values[panelBootstrapStorageKey(9)] = {
    version: 1, kind: 'audit-session', auditId: 'audit-port', sessionCapabilityId: SESSION,
    windowId: 9, createdAt: EPOCH, expiresAt: EPOCH + 10_000, state: 'consumed',
  };
  assert.equal(await drift.coordinator.withWindowLock(9, scope => scope.publishPrivacyPaused({
    auditId: 'audit-port', sessionCapabilityId: SESSION, windowId: 9,
  })), false);
  assert.equal(sessionReads, 2);
});

test('rehydrates a single-URL privacy pause without exposing owner digest or consent capability', async () => {
  const ownershipId = `owner_${'O'.repeat(22)}`;
  const env = fixture();
  env.sessions.set(SESSION, Object.freeze({
    version: 1, sessionCapabilityId: SESSION, auditId: 'audit-port', windowId: 9, mode: 'single',
    targetBinding: { kind: 'disposable', ownershipId, state: 'retained-for-consent' },
    state: 'privacy-paused', issuedAt: EPOCH, expiresAt: EPOCH + 10_000,
  }));
  env.setActive(privacyPausedActive({ mode: 'attached' }));
  env.suspensions.set('audit-port', suspension({
    tabId: 27, documentId: 'url-document',
    urlEvidence: {
      version: 'EvidenceUrlV1', href: 'https://example.test/private',
      queryIncluded: false, redactedSegments: 0,
    },
    urlSessionDigest: `hmac-sha256:${'D'.repeat(43)}`,
    source: { kind: 'owned-disposable', ownershipId, cleanupMode: 'pre-observation-failure', pageId: 'page-1' },
  }));
  env.sessionArea.values[panelBootstrapStorageKey(9)] = {
    version: 1, kind: 'audit-session', auditId: 'audit-port', sessionCapabilityId: SESSION,
    windowId: 9, createdAt: EPOCH, expiresAt: EPOCH + 10_000, state: 'consumed',
  };
  assert.equal(await env.coordinator.withWindowLock(9, scope => scope.publishPrivacyPaused({
    auditId: 'audit-port', sessionCapabilityId: SESSION, windowId: 9,
  })), false);
  env.setActive(privacyPausedActive({ mode: 'single' }));
  assert.equal(await env.coordinator.withWindowLock(9, scope => scope.publishPrivacyPaused({
    auditId: 'audit-port', sessionCapabilityId: SESSION, windowId: 9,
  })), true);

  const first = port();
  env.coordinator.attachPanelPort(first);
  first.onMessage.emit({ protocol: 'audita-panel', version: 1, type: 'bootstrap' });
  await tick();
  assert.deepEqual(first.messages.at(-1), {
    protocol: 'audita-panel', version: 1, type: 'privacy-paused',
    auditId: 'audit-port', sessionCapabilityId: SESSION, mode: 'full-evidence',
    categories: ['password', 'payment'], message: PAUSE_MESSAGE,
  });
  assert.doesNotMatch(JSON.stringify(first.messages.at(-1)), /owner_|hmac-sha256|consentId|private/iu);
  first.onDisconnect.emit();

  const second = port({ documentId: 'panel-document-2' });
  env.coordinator.attachPanelPort(second);
  second.onMessage.emit({ protocol: 'audita-panel', version: 1, type: 'bootstrap' });
  await tick();
  assert.deepEqual(second.messages.at(-1), first.messages.at(-1));
});

test('rehydrates a batch privacy pause with only the active page number and no private correlation', async () => {
  const ownershipId = `owner_${'B'.repeat(22)}`;
  const env = fixture();
  env.sessions.set(SESSION, Object.freeze({
    version: 1, sessionCapabilityId: SESSION, auditId: 'audit-port', windowId: 9, mode: 'batch',
    targetBinding: { kind: 'batch', activePageId: 'page-3', activeOwnershipId: ownershipId },
    state: 'privacy-paused', issuedAt: EPOCH, expiresAt: EPOCH + 10_000,
  }));
  env.setActive(privacyPausedActive({ mode: 'batch' }));
  env.suspensions.set('audit-port', suspension({
    tabId: 27, documentId: 'batch-document',
    urlEvidence: {
      version: 'EvidenceUrlV1', href: 'https://example.test/private',
      queryIncluded: false, redactedSegments: 0,
    },
    urlSessionDigest: `hmac-sha256:${'D'.repeat(43)}`,
    mode: 'element-only',
    capturePolicy: {
      version: 'CapturePolicyV1', mode: 'element-only', includeQuery: false,
      captureFullPage: false, captureElements: true, composeAnnouncementMap: false,
    },
    categories: ['otp', 'private-marker'],
    source: { kind: 'owned-disposable', ownershipId, cleanupMode: 'always', pageId: 'page-3' },
  }));
  env.sessionArea.values[panelBootstrapStorageKey(9)] = {
    version: 1, kind: 'audit-session', auditId: 'audit-port', sessionCapabilityId: SESSION,
    windowId: 9, createdAt: EPOCH, expiresAt: EPOCH + 10_000, state: 'consumed',
  };

  const connected = port();
  env.coordinator.attachPanelPort(connected);
  connected.onMessage.emit({ protocol: 'audita-panel', version: 1, type: 'bootstrap' });
  await tick();

  assert.deepEqual(connected.messages.at(-1), {
    protocol: 'audita-panel', version: 1, type: 'privacy-paused',
    auditId: 'audit-port', sessionCapabilityId: SESSION, mode: 'element-only',
    categories: ['otp', 'private-marker'], message: PAUSE_MESSAGE, pageNumber: 3,
  });
  assert.doesNotMatch(JSON.stringify(connected.messages.at(-1)), /https?:|consentId|owner_|hmac-sha256|digest|documentId|tabId|batch-document/iu);
});

test('rehydrates an attached-copy privacy pause with cleanup always as a bearer-free panel state', async () => {
  const ownershipId = `owner_${'C'.repeat(22)}`;
  const env = fixture();
  env.sessions.set(SESSION, Object.freeze({
    version: 1, sessionCapabilityId: SESSION, auditId: 'audit-port', windowId: 9, mode: 'single',
    targetBinding: { kind: 'disposable', ownershipId, state: 'retained-for-consent' },
    state: 'privacy-paused', issuedAt: EPOCH, expiresAt: EPOCH + 10_000,
  }));
  env.setActive(privacyPausedActive({ mode: 'single' }));
  env.suspensions.set('audit-port', suspension({
    tabId: 27, documentId: 'copy-document',
    urlEvidence: {
      version: 'EvidenceUrlV1', href: 'https://example.test/current',
      queryIncluded: false, redactedSegments: 0,
    },
    urlSessionDigest: `hmac-sha256:${'D'.repeat(43)}`,
    source: { kind: 'owned-disposable', ownershipId, cleanupMode: 'always', pageId: 'page-1' },
  }));
  env.sessionArea.values[panelBootstrapStorageKey(9)] = {
    version: 1, kind: 'audit-session', auditId: 'audit-port', sessionCapabilityId: SESSION,
    windowId: 9, createdAt: EPOCH, expiresAt: EPOCH + 10_000, state: 'consumed',
  };
  assert.equal(await env.coordinator.withWindowLock(9, scope => scope.publishPrivacyPaused({
    auditId: 'audit-port', sessionCapabilityId: SESSION, windowId: 9,
  })), true);

  const connected = port();
  env.coordinator.attachPanelPort(connected);
  connected.onMessage.emit({ protocol: 'audita-panel', version: 1, type: 'bootstrap' });
  await tick();
  assert.deepEqual(connected.messages.at(-1), {
    protocol: 'audita-panel', version: 1, type: 'privacy-paused',
    auditId: 'audit-port', sessionCapabilityId: SESSION, mode: 'full-evidence',
    categories: ['password', 'payment'], message: PAUSE_MESSAGE,
  });
  assert.doesNotMatch(JSON.stringify(connected.messages.at(-1)), /owner_|hmac-sha256|consentId|current/iu);
});

test('re-establishes panel client correlation before a single-URL privacy pause after worker realm restart', async () => {
  const ownershipId = `owner_${'R'.repeat(22)}`;
  const urlSessionDigest = `hmac-sha256:${'D'.repeat(43)}`;
  const evidenceUrl = 'https://example.test/private';
  const durableArea = area();
  let durableSession = Object.freeze({
    version: 1, sessionCapabilityId: SESSION, auditId: 'audit-port', windowId: 9, mode: 'single',
    targetBinding: { kind: 'disposable', ownershipId, state: 'observing' },
    state: 'running', issuedAt: EPOCH, expiresAt: EPOCH + 10_000,
  });
  let durableActive = privacyPausedActive({ mode: 'single', state: 'running' });
  let durableSuspension = null;
  durableArea.values[panelBootstrapStorageKey(9)] = {
    version: 1, kind: 'audit-session', auditId: 'audit-port', sessionCapabilityId: SESSION,
    windowId: 9, createdAt: EPOCH, expiresAt: EPOCH + 10_000, state: 'pending',
  };
  const createRealm = () => fixture({
    sessionArea: durableArea,
    readActiveJob: async () => durableActive,
    readAuditSession: async ({ sessionCapabilityId, auditId }) => {
      if (sessionCapabilityId !== SESSION || auditId !== 'audit-port') throw new Error('denied');
      return durableSession;
    },
    readPixelSuspension: async auditId => auditId === 'audit-port' ? durableSuspension : null,
  }).coordinator;

  let currentCoordinator = createRealm();
  const publishedByConnection = [];
  const receivedByConnection = [];
  const connections = [];
  const clientTimers = [];
  const observed = [];
  const statuses = [];
  let requestSequence = 0;
  const client = createPanelSessionPortClient({
    chromeApi: {
      runtime: {
        connect({ name }) {
          assert.equal(name, PANEL_PORT_NAME);
          const published = [];
          const received = [];
          publishedByConnection.push(published);
          receivedByConnection.push(received);
          const connection = linkedPanelPortPair({
            coordinator: currentCoordinator, published, received,
          });
          connections.push(connection);
          return connection.client;
        },
      },
    },
    onBootstrapResult(value) { observed.push(structuredClone(value)); },
    onStatus(value) { statuses.push(value); },
    onHighlightState() {},
    createRequestId() { requestSequence += 1; return `restart-request-${requestSequence}`; },
    setTimer(callback, delay) {
      const timer = { callback, delay, active: true };
      clientTimers.push(timer);
      return timer;
    },
    clearTimer(timer) { timer.active = false; },
  });

  assert.equal(client.start(), true);
  for (let attempt = 0; attempt < 10 && observed.at(-1)?.state !== 'running'; attempt += 1) await tick();
  assert.equal(observed.at(-1)?.state, 'running');

  durableSession = Object.freeze({
    ...durableSession,
    targetBinding: { kind: 'disposable', ownershipId, state: 'retained-for-consent' },
    state: 'privacy-paused',
  });
  durableActive = privacyPausedActive({ mode: 'single' });
  durableSuspension = suspension({
    tabId: 27, documentId: 'url-document',
    urlEvidence: {
      version: 'EvidenceUrlV1', href: evidenceUrl,
      queryIncluded: false, redactedSegments: 0,
    },
    urlSessionDigest,
    source: { kind: 'owned-disposable', ownershipId, cleanupMode: 'pre-observation-failure', pageId: 'page-1' },
  });
  assert.equal(await currentCoordinator.withWindowLock(9, scope => scope.publishPrivacyPaused({
    auditId: 'audit-port', sessionCapabilityId: SESSION, windowId: 9,
  })), true);
  await tick();
  assert.equal(observed.filter(value => value.state === 'privacy-paused').length, 1);

  connections[0].close();
  currentCoordinator = createRealm();
  const reconnect = clientTimers.find(timer => timer.active && timer.delay === 250);
  assert.ok(reconnect);
  reconnect.active = false;
  reconnect.callback();
  for (let attempt = 0; attempt < 10; attempt += 1) await tick();

  assert.deepEqual(publishedByConnection[1], [
    {
      protocol: 'audita-panel', version: 1, type: 'bootstrap-result', state: 'running',
      auditId: 'audit-port', sessionCapabilityId: SESSION, result: null,
    },
    {
      protocol: 'audita-panel', version: 1, type: 'privacy-paused',
      auditId: 'audit-port', sessionCapabilityId: SESSION, mode: 'full-evidence',
      categories: ['password', 'payment'], message: PAUSE_MESSAGE,
    },
  ]);
  assert.equal(observed.filter(value => value.state === 'privacy-paused').length, 2);
  assert.equal(statuses.at(-1), 'Painel conectado.');
  const publicText = JSON.stringify(publishedByConnection[1]);
  for (const secret of [ownershipId, urlSessionDigest, evidenceUrl, CONSENT]) {
    assert.equal(publicText.includes(secret), false);
  }
  assert.doesNotMatch(publicText, /data:image|result-bundle/iu);

  const confirmation = client.requestIntent({
    type: 'CONFIRM_PIXEL_CAPTURE', mode: 'full-evidence', accepted: true,
  });
  const replay = client.requestIntent({
    type: 'CONFIRM_PIXEL_CAPTURE', mode: 'full-evidence', accepted: true,
  });
  assert.deepEqual(await replay, { ok: false, code: 'PANEL_SESSION_UNAVAILABLE' });
  assert.deepEqual(await confirmation, { ok: false, code: 'FEATURE_UNAVAILABLE' });
  const confirmations = receivedByConnection[1].filter(value =>
    value?.envelope?.type === 'PANEL_CONFIRM_PIXEL_CAPTURE');
  assert.deepEqual(confirmations, [{
    protocol: 'audita-panel', version: 1, type: 'intent', requestId: 'restart-request-1',
    envelope: {
      type: 'PANEL_CONFIRM_PIXEL_CAPTURE', sessionCapabilityId: SESSION,
      auditId: 'audit-port', mode: 'full-evidence', accepted: true,
    },
  }]);
  assert.equal(client.stop(), true);
});

test('disconnect during pause reproof blocks the stale packet and later reconnect rehydrates safely', async () => {
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
  env.sessions.set(SESSION, session('privacy-paused'));
  env.setActive(privacyPausedActive());
  env.suspensions.set('audit-port', suspension());
  const messagesBefore = connected.messages.length;
  env.chromeApi.runtime.getContexts = async () => {
    connected.onDisconnect.emit();
    return [{
      contextId: 'panel-context', documentId: 'panel-document', documentUrl: PANEL_URL,
      contextType: 'SIDE_PANEL', tabId: -1, windowId: -1,
    }];
  };

  assert.equal(await env.coordinator.withWindowLock(9, scope => scope.publishPrivacyPaused({
    auditId: 'audit-port', sessionCapabilityId: SESSION, windowId: 9,
  })), false);
  assert.equal(connected.messages.length, messagesBefore);

  env.chromeApi.runtime.getContexts = async () => [{
    contextId: 'panel-context', documentId: 'panel-document', documentUrl: PANEL_URL,
    contextType: 'SIDE_PANEL', tabId: -1, windowId: -1,
  }];
  const replacement = port();
  env.coordinator.attachPanelPort(replacement);
  replacement.onMessage.emit({ protocol: 'audita-panel', version: 1, type: 'bootstrap' });
  await tick();
  assert.equal(replacement.messages.at(-1).consentId, CONSENT);
});

test('a failed privacy post disconnects the stale incumbent so reconnect can rehydrate', async () => {
  const env = fixture();
  env.setActive(runningActive());
  env.sessionArea.values[panelBootstrapStorageKey(9)] = {
    version: 1, kind: 'audit-session', auditId: 'audit-port', sessionCapabilityId: SESSION,
    windowId: 9, createdAt: EPOCH, expiresAt: EPOCH + 10_000, state: 'pending',
  };
  const stale = port();
  env.coordinator.attachPanelPort(stale);
  stale.onMessage.emit({ protocol: 'audita-panel', version: 1, type: 'bootstrap' });
  await tick();
  env.sessions.set(SESSION, session('privacy-paused'));
  env.setActive(privacyPausedActive());
  env.suspensions.set('audit-port', suspension());
  stale.throwOnType = 'privacy-paused';

  assert.equal(await env.coordinator.withWindowLock(9, scope => scope.publishPrivacyPaused({
    auditId: 'audit-port', sessionCapabilityId: SESSION, windowId: 9,
  })), false);
  assert.equal(stale.disconnects, 1);

  const replacement = port();
  env.coordinator.attachPanelPort(replacement);
  replacement.onMessage.emit({ protocol: 'audita-panel', version: 1, type: 'bootstrap' });
  await tick();
  assert.equal(replacement.messages.at(-1).consentId, CONSENT);
});

test('an expired bootstrap cannot authorize a still-live pause publication', async () => {
  const env = fixture({ epochNow: () => EPOCH + 2 });
  env.sessions.set(SESSION, session('privacy-paused'));
  env.setActive(privacyPausedActive());
  env.suspensions.set('audit-port', suspension());
  env.sessionArea.values[panelBootstrapStorageKey(9)] = {
    version: 1, kind: 'audit-session', auditId: 'audit-port', sessionCapabilityId: SESSION,
    windowId: 9, createdAt: EPOCH, expiresAt: EPOCH + 1, state: 'consumed',
  };

  assert.equal(await env.coordinator.withWindowLock(9, scope => scope.publishPrivacyPaused({
    auditId: 'audit-port', sessionCapabilityId: SESSION, windowId: 9,
  })), false);
});

test('publishes a sanitized running resume and invalidates the local paused state', async () => {
  const env = fixture();
  env.sessions.set(SESSION, session('privacy-paused'));
  env.setActive(privacyPausedActive());
  env.suspensions.set('audit-port', suspension());
  env.sessionArea.values[panelBootstrapStorageKey(9)] = {
    version: 1, kind: 'audit-session', auditId: 'audit-port', sessionCapabilityId: SESSION,
    windowId: 9, createdAt: EPOCH, expiresAt: EPOCH + 10_000, state: 'pending',
  };
  const connected = port();
  env.coordinator.attachPanelPort(connected);
  connected.onMessage.emit({ protocol: 'audita-panel', version: 1, type: 'bootstrap' });
  await tick();
  assert.equal(connected.messages.at(-1).type, 'privacy-paused');

  env.sessions.set(SESSION, session('running'));
  env.setActive(runningActive());
  assert.equal(await env.coordinator.withWindowLock(9, scope => scope.publishRunningResume({
    auditId: 'audit-port', sessionCapabilityId: SESSION, windowId: 9,
  })), true);
  assert.deepEqual(connected.messages.at(-1), {
    protocol: 'audita-panel', version: 1, type: 'bootstrap-result',
    state: 'running', auditId: 'audit-port', sessionCapabilityId: SESSION, result: null,
  });
  assert.equal(env.sessionArea.values[panelBootstrapStorageKey(9)].state, 'consumed');
  assert.doesNotMatch(JSON.stringify(connected.messages.at(-1)), new RegExp(CONSENT, 'u'));
  assert.equal(await env.coordinator.withWindowLock(9, scope => scope.publishPrivacyPaused({
    auditId: 'audit-port', sessionCapabilityId: SESSION, windowId: 9,
  })), false);
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
        : { panel: { running: ['cancel'], 'privacy-paused': ['cancel', 'confirm-pixels'], result: ['open-report', 'highlight'], 'view-only': ['open-report'] }, review: { running: [], 'privacy-paused': [], result: ['export', 'highlight'], 'view-only': ['export'] } };
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
      createdAt: EPOCH, expiresAt: EPOCH + 10_000, captureMode: 'no-pixels',
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

test('publishResult defers an exact durable result when no live Port exists', async () => {
  const resultBundle = await bundle();
  const env = fixture();
  env.sessions.set(SESSION, session('result'));
  env.sessionArea.values[panelBootstrapStorageKey(9)] = {
    version: 1, kind: 'audit-session', auditId: 'audit-port', sessionCapabilityId: SESSION,
    windowId: 9, createdAt: EPOCH, expiresAt: EPOCH + 10_000, state: 'consumed',
  };

  const published = await env.coordinator.withWindowLock(9, scope => scope.publishResult({
    auditId: 'audit-port', sessionCapabilityId: SESSION, windowId: 9,
    state: 'result', resultBundle,
  }));

  assert.deepEqual(published, { version: 1, state: 'deferred' });
  assert.equal(Object.isFrozen(published), true);
  assert.equal(env.sessionArea.values[panelBootstrapStorageKey(9)].state, 'consumed');
});

test('publishResult disconnects a live Port whose result post fails and defers its durable result', async () => {
  const resultBundle = await bundle();
  const env = fixture();
  env.setActive(runningActive());
  env.sessionArea.values[panelBootstrapStorageKey(9)] = {
    version: 1, kind: 'audit-session', auditId: 'audit-port', sessionCapabilityId: SESSION,
    windowId: 9, createdAt: EPOCH, expiresAt: EPOCH + 10_000, state: 'pending',
  };
  const connected = port({ failState: 'result' });
  env.coordinator.attachPanelPort(connected);
  connected.onMessage.emit({ protocol: 'audita-panel', version: 1, type: 'bootstrap' });
  await tick();
  env.sessions.set(SESSION, session('result'));

  const published = await env.coordinator.withWindowLock(9, scope => scope.publishResult({
    auditId: 'audit-port', sessionCapabilityId: SESSION, windowId: 9,
    state: 'result', resultBundle,
  }));

  assert.deepEqual(published, { version: 1, state: 'deferred' });
  assert.equal(Object.isFrozen(published), true);
  assert.equal(connected.disconnects, 1);
  assert.equal(connected.messages.some(message => message.state === 'result'), false);
});

test('terminal post failure makes the binding inert but awaits retirement before native disconnect', async () => {
  const resultBundle = await bundle();
  let resolveRetirement;
  let retirementStarted = false;
  const retirement = new Promise(resolve => { resolveRetirement = resolve; });
  const env = fixture({
    launchAuthority: launchAuthorityWithRetirement(async () => {
      retirementStarted = true;
      return retirement;
    }),
  });
  env.setActive(runningActive());
  env.sessionArea.values[panelBootstrapStorageKey(9)] = {
    version: 1, kind: 'audit-session', auditId: 'audit-port', sessionCapabilityId: SESSION,
    windowId: 9, createdAt: EPOCH, expiresAt: EPOCH + 10_000, state: 'pending',
  };
  const connected = port({ failState: 'result' });
  env.coordinator.attachPanelPort(connected);
  connected.onMessage.emit({ protocol: 'audita-panel', version: 1, type: 'bootstrap' });
  await tick();
  env.sessions.set(SESSION, session('result'));

  const publication = env.coordinator.withWindowLock(9, scope => scope.publishResult({
    auditId: 'audit-port', sessionCapabilityId: SESSION, windowId: 9,
    state: 'result', resultBundle,
  }));
  await tick();
  assert.equal(retirementStarted, true);
  assert.equal(connected.disconnects, 0);
  resolveRetirement(Object.freeze({ version: 1, state: 'released' }));

  assert.deepEqual(await publication, { version: 1, state: 'deferred' });
  assert.equal(connected.disconnects, 1);
});

test('a denied Port retirement denies terminal delivery so finalizing ACTIVE cannot settle', async () => {
  const resultBundle = await bundle();
  const env = fixture({
    launchAuthority: launchAuthorityWithRetirement(async () =>
      Object.freeze({ version: 1, state: 'denied' })),
  });
  env.setActive(runningActive());
  env.sessionArea.values[panelBootstrapStorageKey(9)] = {
    version: 1, kind: 'audit-session', auditId: 'audit-port', sessionCapabilityId: SESSION,
    windowId: 9, createdAt: EPOCH, expiresAt: EPOCH + 10_000, state: 'pending',
  };
  const connected = port({ failState: 'result' });
  env.coordinator.attachPanelPort(connected);
  connected.onMessage.emit({ protocol: 'audita-panel', version: 1, type: 'bootstrap' });
  await tick();
  env.sessions.set(SESSION, session('result'));

  const publication = await env.coordinator.withWindowLock(9, scope => scope.publishResult({
    auditId: 'audit-port', sessionCapabilityId: SESSION, windowId: 9,
    state: 'result', resultBundle,
  }));

  assert.deepEqual(publication, { version: 1, state: 'denied' });
  assert.equal(connected.disconnects, 1);
});

test('publishResult preserves a foreign live Port while retaining the target result for recovery', async () => {
  const resultBundle = await bundle();
  const foreignSession = 'F'.repeat(22);
  const env = fixture();
  env.sessions.set(foreignSession, session('running', foreignSession, 'foreign-port-audit'));
  env.setActive(Object.freeze({
    ...runningActive(), auditId: 'foreign-port-audit', capabilityId: 'G'.repeat(22),
    sessionCapabilityId: foreignSession,
  }));
  env.sessionArea.values[panelBootstrapStorageKey(9)] = {
    version: 1, kind: 'audit-session', auditId: 'foreign-port-audit', sessionCapabilityId: foreignSession,
    windowId: 9, createdAt: EPOCH, expiresAt: EPOCH + 10_000, state: 'pending',
  };
  const connected = port();
  env.coordinator.attachPanelPort(connected);
  connected.onMessage.emit({ protocol: 'audita-panel', version: 1, type: 'bootstrap' });
  await tick();
  assert.equal(connected.messages.at(-1).auditId, 'foreign-port-audit');

  env.sessions.set(SESSION, session('result'));
  env.sessionArea.values[panelBootstrapStorageKey(9)] = {
    version: 1, kind: 'audit-session', auditId: 'audit-port', sessionCapabilityId: SESSION,
    windowId: 9, createdAt: EPOCH, expiresAt: EPOCH + 10_000, state: 'consumed',
  };

  const published = await env.coordinator.withWindowLock(9, scope => scope.publishResult({
    auditId: 'audit-port', sessionCapabilityId: SESSION, windowId: 9,
    state: 'result', resultBundle,
  }));

  assert.deepEqual(published, { version: 1, state: 'deferred' });
  assert.equal(Object.isFrozen(published), true);
  assert.equal(connected.disconnects, 0);
  assert.equal(connected.messages.some(message => message.auditId === 'audit-port'), false);
});

test('publishResult returns delivered only after the correlated live Port accepts the result packet', async () => {
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

  const published = await env.coordinator.withWindowLock(9, scope => scope.publishResult({
    auditId: 'audit-port', sessionCapabilityId: SESSION, windowId: 9,
    state: 'result', resultBundle,
  }));

  assert.deepEqual(published, { version: 1, state: 'delivered' });
  assert.equal(Object.isFrozen(published), true);
  assert.equal(connected.disconnects, 0);
  assert.equal(connected.messages.at(-1).state, 'result');
  assert.equal(connected.messages.at(-1).result.auditId, 'audit-port');
});

test('publishResult denies malformed or uncorrelated terminal publication without touching a foreign Port', async () => {
  const resultBundle = await bundle();
  const foreign = port();
  const env = fixture();
  env.coordinator.attachPanelPort(foreign);
  foreign.onMessage.emit({ protocol: 'audita-panel', version: 1, type: 'bootstrap' });
  await tick();

  const denied = await env.coordinator.withWindowLock(9, scope => scope.publishResult({
    auditId: 'audit-port', sessionCapabilityId: SESSION, windowId: 9,
    state: 'result', resultBundle,
  }));

  assert.deepEqual(denied, { version: 1, state: 'denied' });
  assert.equal(Object.isFrozen(denied), true);
  assert.equal(foreign.disconnects, 0);
  assert.equal(foreign.messages.some(message => message.state === 'result'), false);
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
  await tick();
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

test('a duplicate hello makes the pending binding inert before retiring its eventual owner', async () => {
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
  assert.equal(connected.disconnects, 0);
  resolveContexts([{
    contextId: 'panel-context', documentId: 'panel-document', documentUrl: PANEL_URL,
    contextType: 'SIDE_PANEL', tabId: -1, windowId: -1,
  }]);
  await tick();
  await tick();
  assert.equal(connected.disconnects, 1);
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

test('reload projects the exact durable capture mode for every running audit policy', async () => {
  for (const captureMode of ['full-evidence', 'element-only', 'no-pixels']) {
    const env = fixture();
    env.setActive(runningActive());
    env.sessionArea.values[panelBootstrapStorageKey(9)] = {
      version: 1, kind: 'audit-session', auditId: 'audit-port', sessionCapabilityId: SESSION,
      windowId: 9, createdAt: EPOCH, expiresAt: EPOCH + 10_000, state: 'pending', captureMode,
    };
    const connected = port();
    env.coordinator.attachPanelPort(connected);
    connected.onMessage.emit({ protocol: 'audita-panel', version: 1, type: 'bootstrap' });
    await tick();
    assert.deepEqual(connected.messages.at(-1), {
      protocol: 'audita-panel', version: 1, type: 'bootstrap-result', state: 'running',
      auditId: 'audit-port', sessionCapabilityId: SESSION, result: null, captureMode,
    });
    assert.doesNotMatch(JSON.stringify(connected.messages), /https?:|consent|owner|digest|documentId|tabId/iu);
  }
});

test('a completed result can yield the panel to a new audit without revoking the previous report session', async () => {
  const env = fixture();
  const connected = port();
  env.coordinator.attachPanelPort(connected);
  connected.onMessage.emit({ protocol: 'audita-panel', version: 1, type: 'bootstrap' });
  await tick();
  await env.coordinator.withWindowLock(9, async scope => {
    assert.equal((await scope.registerAndPublishViewOnly({
      auditId: 'audit-port', sessionCapabilityId: VIEW_SESSION, windowId: 9,
      createdAt: EPOCH + 1, expiresAt: EPOCH + 10_000, resultBundle: await bundle(),
    })).delivered, true);
  });
  env.sessions.set(SESSION, session('running', SESSION, 'audit-next'));
  await env.coordinator.withWindowLock(9, async scope => {
    assert.equal(await scope.registerPendingBootstrap({
      auditId: 'audit-next', sessionCapabilityId: SESSION, windowId: 9,
      createdAt: EPOCH + 1, expiresAt: EPOCH + 10_000, captureMode: 'no-pixels',
    }), true);
    env.setActive({ ...runningActive(), auditId: 'audit-next' });
    assert.equal(await scope.publishRegisteredBootstrap({
      auditId: 'audit-next', sessionCapabilityId: SESSION, windowId: 9,
    }), true);
  });
  assert.equal(connected.messages.at(-1).state, 'running');
  assert.equal(connected.messages.at(-1).auditId, 'audit-next');
  assert.equal(env.sessions.get(VIEW_SESSION).state, 'view-only');
  assert.deepEqual(env.revoked, []);
});

test('new audit does not replace a running, paused or active prior audit bootstrap', async () => {
  for (const priorState of ['running', 'privacy-paused', 'view-only']) {
    const env = fixture();
    env.sessions.set(VIEW_SESSION, session(priorState, VIEW_SESSION));
    env.sessions.set(SESSION, session('running', SESSION, 'audit-next'));
    const prior = { version: 1, kind: 'audit-session', auditId: 'audit-port', sessionCapabilityId: VIEW_SESSION,
      windowId: 9, createdAt: EPOCH, expiresAt: EPOCH + 10_000, state: 'consumed' };
    env.sessionArea.values[panelBootstrapStorageKey(9)] = prior;
    if (priorState === 'view-only') env.setActive(runningActive());
    assert.equal(await env.coordinator.withWindowLock(9, scope => scope.registerPendingBootstrap({
      auditId: 'audit-next', sessionCapabilityId: SESSION, windowId: 9,
      createdAt: EPOCH + 1, expiresAt: EPOCH + 10_000, captureMode: 'no-pixels',
    })), false);
    assert.deepEqual(env.sessionArea.values[panelBootstrapStorageKey(9)], prior);
  }
});

test('single-URL bootstrap stays connected and publishes running without exposing disposable authority', async () => {
  const env = fixture();
  env.sessions.set(SESSION, Object.freeze({
    ...session('running'),
    mode: 'single',
    targetBinding: Object.freeze({
      kind: 'disposable', ownershipId: `owner_${'O'.repeat(22)}`, state: 'pending',
    }),
  }));
  env.setActive(Object.freeze({ ...runningActive(), mode: 'single' }));
  const connected = port();
  assert.equal(env.coordinator.attachPanelPort(connected), true);
  connected.onMessage.emit({ protocol: 'audita-panel', version: 1, type: 'bootstrap' });
  await tick();
  assert.equal(connected.disconnects, 0);
  assert.deepEqual(connected.messages, [{
    protocol: 'audita-panel', version: 1, type: 'bootstrap-result', state: 'initial',
    auditId: null, sessionCapabilityId: null, result: null,
  }]);

  await env.coordinator.withWindowLock(9, async scope => {
    assert.equal(await scope.registerPendingBootstrap({
      auditId: 'audit-port', sessionCapabilityId: SESSION, windowId: 9,
      createdAt: EPOCH + 1, expiresAt: EPOCH + 10_000, captureMode: 'element-only',
    }), true);
    assert.equal(await scope.publishRegisteredBootstrap({
      auditId: 'audit-port', sessionCapabilityId: SESSION, windowId: 9,
    }), true);
  });
  assert.equal(connected.disconnects, 0);
  assert.deepEqual(connected.messages.at(-1), {
    protocol: 'audita-panel', version: 1, type: 'bootstrap-result', state: 'running',
    auditId: 'audit-port', sessionCapabilityId: SESSION, result: null, captureMode: 'element-only',
  });
  assert.doesNotMatch(JSON.stringify(connected.messages), /owner_|ownership|disposable/u);
});

test('single-URL result keeps the panel connected while publishing safe highlight state', async () => {
  const targetBinding = Object.freeze({
    kind: 'disposable', ownershipId: `owner_${'O'.repeat(22)}`, state: 'retained-for-review',
  });
  const env = fixture({
    async authorizeHighlightSession() {
      return {
        ok: true,
        session: {
          version: 1, sessionCapabilityId: SESSION, auditId: 'audit-port', windowId: 9, mode: 'single',
          targetBinding,
          consumers: [
            { name: 'panel', path: '/src/panel/index.html', contextType: 'SIDE_PANEL' },
            { name: 'review', path: '/src/review/index.html', contextType: 'TAB' },
          ],
          intents: {
            panel: { running: ['cancel'], 'privacy-paused': ['cancel', 'confirm-pixels'], result: ['open-report', 'highlight'], 'view-only': ['open-report'] },
            review: { running: [], 'privacy-paused': [], result: ['export', 'highlight'], 'view-only': ['export'] },
          },
          state: 'result', issuedAt: EPOCH, expiresAt: EPOCH + 10_000,
        },
        context: {
          issuer: { type: 'extension-document', documentId: 'panel-document', path: '/src/panel/index.html' },
          windowId: 9, tabId: null, contextType: 'SIDE_PANEL', documentUrl: PANEL_URL,
        },
      };
    },
  });
  env.sessions.set(SESSION, Object.freeze({
    ...session('running'), mode: 'single',
    targetBinding: Object.freeze({ ...targetBinding, state: 'pending' }),
  }));
  env.setActive(Object.freeze({ ...runningActive(), mode: 'single' }));
  env.sessionArea.values[panelBootstrapStorageKey(9)] = {
    version: 1, kind: 'audit-session', auditId: 'audit-port', sessionCapabilityId: SESSION,
    windowId: 9, createdAt: EPOCH, expiresAt: EPOCH + 10_000, state: 'pending',
  };
  const connected = port();
  env.coordinator.attachPanelPort(connected);
  connected.onMessage.emit({ protocol: 'audita-panel', version: 1, type: 'bootstrap' });
  await tick();
  env.sessions.set(SESSION, Object.freeze({ ...session('result'), mode: 'single', targetBinding }));
  env.setActive(null);

  const event = {
    version: 1, type: 'HIGHLIGHT_STATE_CHANGED', auditId: 'audit-port', occurrenceId: 'occ-1', state: 'active',
  };
  assert.deepEqual(await env.coordinator.publishHighlightState(event), { delivered: 1 });
  assert.equal(connected.disconnects, 0);
  assert.deepEqual(connected.messages.at(-1), event);
  assert.doesNotMatch(JSON.stringify(connected.messages.at(-1)), /owner_|ownership|disposable/u);
});

test('single-URL terminal reconnect preserves its retained result session and highlight intents', async () => {
  const resultBundle = await bundle();
  const targetBinding = Object.freeze({
    kind: 'disposable', ownershipId: `owner_${'O'.repeat(22)}`, state: 'retained-for-review',
  });
  const dispatched = [];
  let rehydrations = 0;
  const env = fixture({
    loadPanelResultBundle: async () => resultBundle,
    async rehydrateViewOnly() {
      rehydrations += 1;
      throw new Error('single result must stay authorized');
    },
    async dispatchPanelIntent(request) {
      dispatched.push(request);
      return request.envelope.type === 'GET_HIGHLIGHT_AVAILABILITY'
        ? { ok: true, available: true }
        : { ok: true, highlight: { state: 'active', occurrenceId: 'occ-1' } };
    },
  });
  env.sessions.set(SESSION, Object.freeze({
    ...session('result'), mode: 'single', targetBinding,
  }));
  env.sessionArea.values[panelBootstrapStorageKey(9)] = {
    version: 1, kind: 'audit-session', auditId: 'audit-port', sessionCapabilityId: SESSION,
    windowId: 9, createdAt: EPOCH, expiresAt: EPOCH + 10_000, state: 'consumed',
  };
  const connected = port();

  env.coordinator.attachPanelPort(connected);
  connected.onMessage.emit({ protocol: 'audita-panel', version: 1, type: 'bootstrap' });
  await tick();

  assert.equal(connected.disconnects, 0);
  assert.equal(rehydrations, 0);
  assert.deepEqual(connected.messages[0], {
    protocol: 'audita-panel', version: 1, type: 'bootstrap-result', state: 'result',
    auditId: 'audit-port', sessionCapabilityId: SESSION, result: resultBundle,
  });
  assert.equal(env.sessionArea.values[panelBootstrapStorageKey(9)].sessionCapabilityId, SESSION);
  assert.equal(env.sessionArea.values[panelBootstrapStorageKey(9)].state, 'consumed');
  assert.doesNotMatch(JSON.stringify(connected.messages[0]), /owner_|ownership|disposable/u);

  connected.onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'intent', requestId: 'availability-after-reconnect',
    envelope: {
      type: 'GET_HIGHLIGHT_AVAILABILITY', sessionCapabilityId: SESSION,
      auditId: 'audit-port', occurrenceId: 'occ-1',
    },
  });
  await tick();
  connected.onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'intent', requestId: 'highlight-after-reconnect',
    envelope: {
      type: 'HIGHLIGHT_OCCURRENCE', sessionCapabilityId: SESSION,
      auditId: 'audit-port', occurrenceId: 'occ-1',
    },
  });
  await tick();

  assert.equal(connected.disconnects, 0);
  assert.deepEqual(dispatched.map(request => ({
    type: request.envelope.type,
    sessionCapabilityId: request.envelope.sessionCapabilityId,
    panelWindowId: request.panelWindowId,
  })), [
    { type: 'GET_HIGHLIGHT_AVAILABILITY', sessionCapabilityId: SESSION, panelWindowId: 9 },
    { type: 'HIGHLIGHT_OCCURRENCE', sessionCapabilityId: SESSION, panelWindowId: 9 },
  ]);
  assert.deepEqual(connected.messages.at(-1), {
    protocol: 'audita-panel', version: 1, type: 'intent-result',
    requestId: 'highlight-after-reconnect',
    response: { ok: true, highlight: { state: 'active', occurrenceId: 'occ-1' } },
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
      createdAt: EPOCH, expiresAt: EPOCH + 10_000, captureMode: 'full-evidence',
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

function cleanupBootstrap(auditId = 'audit-port', sessionCapabilityId = SESSION, windowId = 9) {
  return {
    version: 1, kind: 'audit-session', auditId, sessionCapabilityId, windowId,
    createdAt: EPOCH, expiresAt: EPOCH + 10_000, state: 'pending',
  };
}

async function runningCleanupFixture() {
  const env = fixture();
  env.setActive(runningActive());
  env.sessionArea.values[panelBootstrapStorageKey(9)] = cleanupBootstrap();
  const connected = port();
  env.coordinator.attachPanelPort(connected);
  connected.onMessage.emit({ protocol: 'audita-panel', version: 1, type: 'bootstrap' });
  await tick();
  assert.equal(connected.messages.at(-1)?.state, 'running');
  return { ...env, connected };
}

test('panel audit cleanup removes its durable bootstrap without a Port and preserves foreign and unrelated records', async () => {
  const env = fixture();
  const ownKey = panelBootstrapStorageKey(9);
  const foreignKey = panelBootstrapStorageKey(10);
  env.sessionArea.values[ownKey] = cleanupBootstrap();
  const foreign = cleanupBootstrap('audit-foreign', 'F'.repeat(22), 10);
  env.sessionArea.values[foreignKey] = foreign;
  env.sessionArea.values['audita:persona-lease:independent'] = { state: 'active' };
  assert.equal(await env.coordinator.clearAudit('audit-port'), true);
  assert.equal(Object.hasOwn(env.sessionArea.values, ownKey), false);
  assert.deepEqual(env.sessionArea.values[foreignKey], foreign);
  assert.deepEqual(env.sessionArea.values['audita:persona-lease:independent'], { state: 'active' });
  assert.equal(await env.coordinator.clearAudit('audit-port'), true);
});

test('panel audit cleanup confirms canonical audit absence through 200 and preserves foreign state', async () => {
  const env = fixture();
  const foreignKey = panelBootstrapStorageKey(10);
  const foreign = cleanupBootstrap('audit-foreign', 'F'.repeat(22), 10);
  env.sessionArea.values[foreignKey] = foreign;
  env.sessionArea.values['audita:persona-lease:independent'] = { state: 'active' };
  for (const length of [160, 161, 200]) {
    assert.equal(await env.coordinator.clearAudit('a'.repeat(length)), true);
  }
  assert.deepEqual(env.sessionArea.values[foreignKey], foreign);
  assert.deepEqual(env.sessionArea.values['audita:persona-lease:independent'], { state: 'active' });
  for (const auditId of ['a'.repeat(201), '__latest__']) {
    assert.equal(await env.coordinator.clearAudit(auditId), false);
  }
});

test('panel audit cleanup reaches a live binding when bootstrap is absent or uses another capability of the same audit', async t => {
  for (const mode of ['absent', 'different-own-session']) await t.test(mode, async () => {
    const env = await runningCleanupFixture();
    const key = panelBootstrapStorageKey(9);
    if (mode === 'absent') await env.sessionArea.remove(key);
    else env.sessionArea.values[key] = cleanupBootstrap('audit-port', VIEW_SESSION);
    assert.equal(await env.coordinator.clearAudit('audit-port'), true);
    assert.equal(env.connected.disconnects, 1);
    assert.equal(env.connected.onMessage.listeners.size, 0);
    assert.equal(Object.hasOwn(env.sessionArea.values, key), false);
    assert.equal(await env.coordinator.clearAudit('audit-port'), true);
    assert.equal(env.connected.disconnects, 1);
  });
});

test('panel audit cleanup preserves a live foreign binding in another window', async () => {
  const env = await runningCleanupFixture();
  const ownKey = panelBootstrapStorageKey(10);
  env.sessionArea.values[ownKey] = cleanupBootstrap('audit-delete', 'D'.repeat(22), 10);
  const before = structuredClone(env.sessionArea.values[panelBootstrapStorageKey(9)]);
  assert.equal(await env.coordinator.clearAudit('audit-delete'), true);
  assert.equal(Object.hasOwn(env.sessionArea.values, ownKey), false);
  assert.deepEqual(env.sessionArea.values[panelBootstrapStorageKey(9)], before);
  assert.equal(env.connected.disconnects, 0);
  assert.equal(env.connected.onMessage.listeners.size, 1);
});

test('panel audit cleanup awaits an in-flight terminal hello and uses its current correlation', async t => {
  const resultBundle = await bundle();
  for (const kind of ['single-without-bootstrap', 'attached-rotates']) await t.test(kind, async () => {
    let release;
    let entered;
    const loading = new Promise(resolve => { entered = resolve; });
    const env = fixture({ loadPanelResultBundle: () => new Promise(resolve => {
      release = () => resolve(resultBundle); entered();
    }) });
    env.sessions.set(SESSION, kind === 'single-without-bootstrap' ? {
      ...session('result'), mode: 'single',
      targetBinding: { kind: 'disposable', ownershipId: `owner_${'O'.repeat(22)}`, state: 'retained-for-review' },
    } : session('result'));
    const key = panelBootstrapStorageKey(9);
    env.sessionArea.values[key] = { ...cleanupBootstrap(), state: 'consumed' };
    const connected = port();
    env.coordinator.attachPanelPort(connected);
    connected.onMessage.emit({ protocol: 'audita-panel', version: 1, type: 'bootstrap' });
    await loading;
    if (kind === 'single-without-bootstrap') await env.sessionArea.remove(key);
    let completed = false;
    const clearing = env.coordinator.clearAudit('audit-port').then(result => { completed = true; return result; });
    await tick();
    assert.equal(completed, false);
    release();
    assert.equal(await clearing, true);
    assert.equal(connected.disconnects, 1);
    assert.equal(Object.hasOwn(env.sessionArea.values, key), false);
    const before = structuredClone(connected.messages);
    await tick();
    assert.deepEqual(connected.messages, before);
    if (kind === 'attached-rotates') assert.equal(before.at(-1)?.sessionCapabilityId, VIEW_SESSION);
  });
});

test('panel audit cleanup waits for a hello reading its session even after the bootstrap is removed', async () => {
  let release;
  let entered;
  let reads = 0;
  const reading = new Promise(resolve => { entered = resolve; });
  const env = fixture({ readAuditSession: async () => {
    if (++reads > 1) return session('revoked');
    return new Promise(resolve => { release = () => resolve(session('running')); entered(); });
  } });
  env.setActive(runningActive());
  const key = panelBootstrapStorageKey(9);
  env.sessionArea.values[key] = cleanupBootstrap();
  const connected = port();
  env.coordinator.attachPanelPort(connected);
  connected.onMessage.emit({ protocol: 'audita-panel', version: 1, type: 'bootstrap' });
  await reading;
  await env.sessionArea.remove(key);
  let completed = false;
  const clearing = env.coordinator.clearAudit('audit-port').then(result => { completed = true; return result; });
  await tick();
  assert.equal(completed, false);
  release();
  assert.equal(await clearing, true);
  assert.equal(connected.disconnects, 1);
  assert.deepEqual(connected.messages, []);
});

test('panel audit cleanup tracks a hello before its bootstrap read resolves without touching a foreign result', async t => {
  const resultBundle = await bundle();
  for (const requestedAudit of ['audit-port', 'audit-unrelated']) await t.test(requestedAudit, async () => {
    const env = fixture({ loadPanelResultBundle: async () => resultBundle });
    env.sessions.set(SESSION, {
      ...session('result'), mode: 'single',
      targetBinding: { kind: 'disposable', ownershipId: `owner_${'O'.repeat(22)}`, state: 'retained-for-review' },
    });
    const key = panelBootstrapStorageKey(9);
    const bootstrap = { ...cleanupBootstrap(), state: 'consumed' };
    env.sessionArea.values[key] = bootstrap;
    const originalGet = env.sessionArea.get;
    let reads = 0;
    let entered;
    let release;
    const captured = new Promise(resolve => { entered = resolve; });
    env.sessionArea.get = async request => {
      const result = await originalGet(request);
      if (request === key && ++reads === 2) {
        return new Promise(resolve => { release = () => resolve(result); entered(); });
      }
      return result;
    };
    const connected = port();
    env.coordinator.attachPanelPort(connected);
    connected.onMessage.emit({ protocol: 'audita-panel', version: 1, type: 'bootstrap' });
    await captured;
    if (requestedAudit === 'audit-port') await env.sessionArea.remove(key);
    let completed = false;
    const clearing = env.coordinator.clearAudit(requestedAudit).then(result => { completed = true; return result; });
    await tick();
    const completedBeforeRead = completed;
    release();
    assert.equal(await clearing, true);
    await tick();
    assert.equal(completedBeforeRead, false);
    assert.equal(connected.messages.at(-1)?.state, 'result');
    assert.equal(connected.disconnects, requestedAudit === 'audit-port' ? 1 : 0);
    if (requestedAudit === 'audit-port') assert.equal(Object.hasOwn(env.sessionArea.values, key), false);
    else assert.deepEqual(env.sessionArea.values[key], bootstrap);
    const afterCleanup = structuredClone(connected.messages);
    await tick();
    assert.deepEqual(connected.messages, afterCleanup);
  });
});

test('panel audit cleanup denies unreadable inventory and invalid identifiers without echoing input', async () => {
  const env = fixture();
  let reads = 0;
  env.sessionArea.get = async () => { reads += 1; throw new Error('PRIVATE_SENTINEL'); };
  for (const value of [null, ['audit-port'], 'https://private.invalid/', { toString() { throw new Error('PRIVATE_SENTINEL'); } }]) {
    assert.equal(await env.coordinator.clearAudit(value), false);
  }
  assert.equal(reads, 0);
  assert.equal(await env.coordinator.clearAudit('audit-port'), false);
  env.sessionArea.get = async () => null;
  assert.equal(await env.coordinator.clearAudit('audit-port'), false);
});

test('panel audit cleanup rejects unconfirmed storage cleanup and preserves foreign replacement', async t => {
  for (const behavior of ['remove-throws', 'no-op', 'foreign-replacement', 'malformed-own']) await t.test(behavior, async () => {
    const env = fixture();
    const key = panelBootstrapStorageKey(9);
    env.sessionArea.values[key] = cleanupBootstrap();
    const foreign = cleanupBootstrap('audit-foreign', 'F'.repeat(22));
    if (behavior === 'malformed-own') env.sessionArea.values[key].createdAt = 'invalid';
    const originalRemove = env.sessionArea.remove;
    env.sessionArea.remove = async () => {
      if (behavior === 'remove-throws') throw new Error('PRIVATE_SENTINEL');
      if (behavior === 'foreign-replacement') env.sessionArea.values[key] = foreign;
    };
    assert.equal(await env.coordinator.clearAudit('audit-port'), false);
    assert.equal(Object.hasOwn(env.sessionArea.values, key), true);
    if (behavior === 'foreign-replacement') assert.deepEqual(env.sessionArea.values[key], foreign);
    env.sessionArea.remove = originalRemove;
    if (behavior !== 'malformed-own') assert.equal(await env.coordinator.clearAudit('audit-port'), true);
  });
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

test('marker-enabled coordinator coalesces exact review heartbeats without delaying ordinary intents', async () => {
  let release;
  const calls = [];
  const env = await markerFixture({ authorizePageMarkersSession: async value => {
    calls.push(value);
    await new Promise(resolve => { release = resolve; });
    return markerAuthorization(value);
  } });
  const before = env.connected.messages.length;
  const heartbeat = { protocol: 'audita-panel', version: 1, type: 'review-heartbeat' };
  env.connected.onMessage.emit(heartbeat);
  env.connected.onMessage.emit(heartbeat);
  requestMarkers(env);
  await tick();
  assert.equal(calls.length, 1, 'one heartbeat may be in flight per binding');
  assert.deepEqual(Object.keys(calls[0]).sort(), ['auditId', 'claimedWindowId', 'sender', 'sessionCapabilityId']);
  assert.equal(calls[0].auditId, 'audit-port');
  assert.equal(calls[0].sessionCapabilityId, SESSION);
  assert.equal(calls[0].claimedWindowId, 9);
  assert.equal(calls[0].sender.documentId, 'panel-document');
  assert.equal(env.dispatched.length, 1, 'heartbeat must not enter or block the intent queue');
  release();
  await tick();
  assert.equal(env.connected.messages.length, before + 1, 'only the ordinary intent receives a response');
  assert.equal(env.connected.messages.at(-1).type, 'intent-result');
  assert.equal(env.connected.disconnects, 0);
});

test('review heartbeat revalidates its result receipt after await and denied paths stay effect-free', async t => {
  await t.test('receipt replaced during authorization', async () => {
    let release;
    let epochReads = 0;
    const env = await markerFixture({
      epochNow: () => { epochReads += 1; return EPOCH + 1; },
      authorizePageMarkersSession: async value => {
        await new Promise(resolve => { release = resolve; });
        return markerAuthorization(value);
      },
    });
    epochReads = 0;
    env.connected.onMessage.emit({ protocol: 'audita-panel', version: 1, type: 'review-heartbeat' });
    await tick();
    const nextBundle = await bundle('audit-port', 2);
    const delivery = await env.coordinator.withWindowLock(9, scope => scope.publishResult({
      auditId: 'audit-port', sessionCapabilityId: SESSION, windowId: 9, state: 'result', resultBundle: nextBundle,
    }));
    assert.equal(delivery.state, 'delivered');
    release();
    await tick();
    assert.equal(epochReads, 0, 'stale receipt must be rejected before authorization validation');
    assert.equal(env.connected.disconnects, 0);
  });

  await t.test('missing native context or authorization', async () => {
    let authorizations = 0;
    const env = await markerFixture({ authorizePageMarkersSession: async value => {
      authorizations += 1;
      return { ...markerAuthorization(value), ok: false };
    } });
    const before = env.connected.messages.length;
    env.connected.onMessage.emit({ protocol: 'audita-panel', version: 1, type: 'review-heartbeat' });
    await tick();
    assert.equal(authorizations, 1);
    assert.equal(env.connected.messages.length, before);
    assert.equal(env.connected.disconnects, 0);
    env.chromeApi.runtime.getContexts = async () => [];
    env.connected.onMessage.emit({ protocol: 'audita-panel', version: 1, type: 'review-heartbeat' });
    await tick();
    assert.equal(authorizations, 1);
    assert.equal(env.connected.messages.length, before);
    assert.equal(env.connected.disconnects, 0);
  });
});

test('review heartbeat stays closed for legacy or malformed packets and is a no-op without a result receipt', async t => {
  await t.test('legacy factory', async () => {
    const env = fixture();
    const connected = port();
    env.coordinator.attachPanelPort(connected);
    connected.onMessage.emit({ protocol: 'audita-panel', version: 1, type: 'bootstrap' });
    await tick();
    connected.onMessage.emit({ protocol: 'audita-panel', version: 1, type: 'review-heartbeat' });
    await tick();
    assert.equal(connected.disconnects, 1);
  });

  await t.test('marker-enabled without receipt', async () => {
    let calls = 0;
    const env = fixture({
      authorizePageMarkersSession: async () => { calls += 1; return { ok: false }; },
      closePanelMarkers: async () => true,
    });
    const connected = port();
    env.coordinator.attachPanelPort(connected);
    connected.onMessage.emit({ protocol: 'audita-panel', version: 1, type: 'bootstrap' });
    await tick();
    connected.onMessage.emit({ protocol: 'audita-panel', version: 1, type: 'review-heartbeat' });
    await tick();
    assert.equal(calls, 0);
    assert.equal(connected.disconnects, 0);
  });

  await t.test('extra key and accessor', async () => {
    for (const malformed of [
      { protocol: 'audita-panel', version: 1, type: 'review-heartbeat', auditId: 'audit-port' },
      Object.defineProperty({ protocol: 'audita-panel', version: 1 }, 'type', {
        enumerable: true, get() { throw new Error('must not run'); },
      }),
    ]) {
      const env = await markerFixture();
      env.connected.onMessage.emit(malformed);
      await tick();
      assert.equal(env.connected.disconnects, 1);
    }
  });
});
