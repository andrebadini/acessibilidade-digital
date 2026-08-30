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

function port({ documentId = 'panel-document', postError = false, failState = null } = {}) {
  const onMessage = event();
  const onDisconnect = event();
  return {
    name: PANEL_PORT_NAME,
    sender: { id: RUNTIME_ID, documentId, url: `chrome-extension://${RUNTIME_ID}/src/panel/index.html` },
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
      async getContexts({ documentIds }) {
        return [{
          documentId: documentIds[0], documentUrl: `chrome-extension://${RUNTIME_ID}/src/panel/index.html`,
          contextType: 'SIDE_PANEL', windowId: 9,
        }];
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
    ...overrides,
  };
  return {
    sessionArea, sessions, timers, revoked,
    setActive(value) { active = value; },
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

function tick() { return new Promise(resolve => setImmediate(resolve)); }

test('exports the exact six-method non-reentrant coordinator and rejects out-of-scope publication', async () => {
  const { coordinator } = fixture();
  assert.deepEqual(Object.keys(coordinator), [
    'attachPanelPort', 'withWindowLock', 'publishRegisteredBootstrap', 'publishResult',
    'registerAndPublishViewOnly', 'disconnectSession',
  ]);
  assert.equal(Object.isFrozen(coordinator), true);
  assert.equal(await coordinator.publishRegisteredBootstrap({
    auditId: 'audit-port', sessionCapabilityId: SESSION, windowId: 9, createdAt: EPOCH, expiresAt: EPOCH + 10_000,
  }), false);
  await assert.rejects(() => coordinator.withWindowLock(9, () => coordinator.withWindowLock(9, async () => true)), /PANEL_WINDOW_LOCK_REENTRANT/u);
});

test('keeps publication authority across awaits inside the held window callback', async () => {
  const { coordinator } = fixture();
  const published = await coordinator.withWindowLock(9, async () => {
    await Promise.resolve();
    return coordinator.publishRegisteredBootstrap({
      auditId: 'audit-port', sessionCapabilityId: SESSION, windowId: 9,
      createdAt: EPOCH, expiresAt: EPOCH + 10_000,
    });
  });
  assert.equal(published, true);
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

test('a duplicate packet arriving while first-hello proof is pending disconnects immediately', async () => {
  let resolveContexts;
  const contexts = new Promise(resolve => { resolveContexts = resolve; });
  const env = fixture({
    chromeApi: {
      runtime: {
        id: RUNTIME_ID,
        async getContexts() { return contexts; },
      },
    },
  });
  const connected = port();
  env.coordinator.attachPanelPort(connected);
  connected.onMessage.emit({ protocol: 'audita-panel', version: 1, type: 'bootstrap' });
  connected.onMessage.emit({ protocol: 'audita-panel', version: 1, type: 'bootstrap' });
  assert.equal(connected.disconnects, 1);
  resolveContexts([{ documentId: 'panel-document', documentUrl: `chrome-extension://${RUNTIME_ID}/src/panel/index.html`, contextType: 'SIDE_PANEL', windowId: 9 }]);
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
  const registered = await env.coordinator.withWindowLock(9, () => env.coordinator.registerAndPublishViewOnly({
    auditId: 'audit-port', sessionCapabilityId: VIEW_SESSION, windowId: 9,
    createdAt: EPOCH + 1, expiresAt: EPOCH + 10_000, resultBundle,
  }));
  assert.deepEqual(registered, { registered: true, delivered: false });
  assert.equal(env.sessionArea.values[panelBootstrapStorageKey(9)].state, 'pending');

  env.sessionArea.values[panelBootstrapStorageKey(9)] = {
    version: 1, kind: 'audit-session', auditId: 'foreign-audit', sessionCapabilityId: 'F'.repeat(22),
    windowId: 9, createdAt: EPOCH, expiresAt: EPOCH + 10_000, state: 'pending',
  };
  const denied = await env.coordinator.withWindowLock(9, () => env.coordinator.registerAndPublishViewOnly({
    auditId: 'audit-port', sessionCapabilityId: VIEW_SESSION, windowId: 9,
    createdAt: EPOCH + 1, expiresAt: EPOCH + 10_000, resultBundle,
  }));
  assert.deepEqual(denied, { registered: false, delivered: false, code: 'AUDIT_REHYDRATE_DENIED' });
  assert.equal(env.sessionArea.values[panelBootstrapStorageKey(9)].auditId, 'foreign-audit');
});

test('a live view-only send failure remains durably registered for reconnect', async () => {
  const resultBundle = await bundle();
  const env = fixture();
  const connected = port({ failState: 'view-only' });
  env.coordinator.attachPanelPort(connected);
  connected.onMessage.emit({ protocol: 'audita-panel', version: 1, type: 'bootstrap' });
  await tick();
  const result = await env.coordinator.withWindowLock(9, () => env.coordinator.registerAndPublishViewOnly({
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

  const disconnected = await env.coordinator.withWindowLock(9, () => env.coordinator.disconnectSession({
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

  const disconnected = await env.coordinator.withWindowLock(9, () => env.coordinator.disconnectSession({
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

  const disconnected = await env.coordinator.withWindowLock(9, () => env.coordinator.disconnectSession({
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
