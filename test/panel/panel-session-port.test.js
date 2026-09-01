import assert from 'node:assert/strict';
import test from 'node:test';

import { createInstalledCoreRuleInventory } from '../../src/core/rules/core-rule-inventory.js';
import { enrichAuditForReport } from '../../src/core/report/enrich-audit.js';
import { createPanelResultBundleV1 } from '../../src/panel/panel-result-bundle.js';
import { createPanelSessionPortClient } from '../../src/panel/panel-session-port.js';
import { SAMPLE_AUDIT } from '../../fixtures/audits/sample-audit.js';

const SESSION_ID = 'A'.repeat(22);
const PRIVACY_MESSAGE = 'A página contém conteúdo potencialmente sensível. Confirme para capturar imagens visíveis.';
const CONSENT_A = `${'a'.repeat(21)}A`;
const CONSENT_B = `${'b'.repeat(21)}Q`;

function event() {
  const listeners = new Set();
  return {
    listeners,
    addListener(listener) { listeners.add(listener); },
    removeListener(listener) { listeners.delete(listener); },
    emit(...args) { for (const listener of [...listeners]) listener(...args); },
  };
}

function fixture() {
  const ports = [];
  const timers = [];
  let requestId = 0;
  const chromeApi = {
    runtime: {
      connect({ name }) {
        const port = {
          name,
          onMessage: event(),
          onDisconnect: event(),
          messages: [],
          disconnects: 0,
          postMessage(message) { this.messages.push(structuredClone(message)); },
          disconnect() { this.disconnects += 1; },
        };
        ports.push(port);
        return port;
      },
      sendMessage() { throw new Error('privileged panel traffic must never use runtime.sendMessage'); },
    },
  };
  return {
    chromeApi,
    ports,
    timers,
    createRequestId() { requestId += 1; return `port-request-${requestId}`; },
    setTimer(callback, delay) { const timer = { callback, delay, cleared: false }; timers.push(timer); return timer; },
    clearTimer(timer) { timer.cleared = true; },
  };
}

function createClient(env, overrides = {}) {
  return createPanelSessionPortClient({
    chromeApi: env.chromeApi,
    onBootstrapResult() {},
    onStatus() {},
    onHighlightState() {},
    createRequestId: env.createRequestId,
    setTimer: env.setTimer,
    clearTimer: env.clearTimer,
    ...overrides,
  });
}

function bootstrap(port, state = 'initial', auditId = null, sessionCapabilityId = null, result = null) {
  port.onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'bootstrap-result', state,
    auditId, sessionCapabilityId, result,
  });
}

async function resultBundle(auditId) {
  const inventory = await createInstalledCoreRuleInventory();
  const draft = structuredClone(SAMPLE_AUDIT);
  draft.auditId = auditId;
  draft.integrity.canonicalModelHash = 'pending';
  draft.integrity.evidenceManifestHash = 'pending';
  const model = await enrichAuditForReport(draft, {
    now: () => '2026-08-31T12:00:00.000Z', timezone: 'America/Cuiaba',
    manifestVersion: '1.0.1', rulesVersion: inventory.rulesVersion, browserVersion: 'Chrome/152.0.0.0',
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
    reportRevision: {
      version: 1, auditId, modelRevision: 1,
      modelHash: model.integrity.canonicalModelHash, model, checkpoint,
    },
    inventory,
  });
}

function privacyPaused(port, overrides = {}) {
  port.onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'privacy-paused',
    auditId: 'audit-private', sessionCapabilityId: SESSION_ID,
    consentId: CONSENT_A, mode: 'full-evidence',
    categories: ['password', 'payment'], message: PRIVACY_MESSAGE,
    ...overrides,
  });
}

function ownedPrivacyPaused(port, overrides = {}) {
  port.onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'privacy-paused',
    auditId: 'audit-private', sessionCapabilityId: SESSION_ID,
    mode: 'full-evidence', categories: ['password', 'payment'], message: PRIVACY_MESSAGE,
    ...overrides,
  });
}

test('uses one admitted Port for bootstrap and every privileged panel intent', async () => {
  const env = fixture();
  const observed = [];
  const statuses = [];
  const client = createClient(env, {
    onBootstrapResult: value => observed.push(value),
    onStatus: value => statuses.push(value),
  });

  assert.deepEqual(Object.keys(client), ['start', 'stop', 'requestIntent']);
  assert.equal(Object.isFrozen(client), true);
  assert.equal(client.start(), true);
  assert.equal(client.start(), false);
  assert.equal(env.ports.length, 1);
  const port = env.ports[0];
  assert.deepEqual(port.messages, [{ protocol: 'audita-panel', version: 1, type: 'bootstrap' }]);
  bootstrap(port);
  assert.deepEqual(observed, [{ state: 'initial', auditId: null, result: null }]);

  const pending = client.requestIntent({ type: 'PREPARE_PANEL_CAPABILITY', requestId: 'prepare-1' });
  assert.deepEqual(port.messages.at(-1), {
    protocol: 'audita-panel', version: 1, type: 'intent', requestId: 'port-request-1',
    envelope: { type: 'PREPARE_PANEL_CAPABILITY', requestId: 'prepare-1' },
  });
  port.onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'intent-result',
    requestId: 'port-request-1', response: { ok: true, requestId: 'prepare-1' },
  });
  assert.deepEqual(await pending, { ok: true, requestId: 'prepare-1' });
  assert.equal(env.timers.at(-1).cleared, true);
  assert.ok(statuses.includes('Painel conectado.'));
});

test('accepts correlated highlight state events without treating them as hostile Port traffic', () => {
  const env = fixture();
  const events = [];
  const client = createClient(env, { onHighlightState: value => events.push(value) });
  client.start();
  const port = env.ports[0];
  bootstrap(port, 'running', 'audit-port', SESSION_ID);
  port.onMessage.emit({
    version: 1, type: 'HIGHLIGHT_STATE_CHANGED', auditId: 'audit-port', occurrenceId: 'occ-1', state: 'active',
  });
  port.onMessage.emit({
    version: 1, type: 'HIGHLIGHT_STATE_CHANGED', auditId: 'audit-port', occurrenceId: null, state: 'clear',
  });
  assert.deepEqual(events, [
    { auditId: 'audit-port', occurrenceId: 'occ-1', state: 'active' },
    { auditId: 'audit-port', occurrenceId: null, state: 'clear' },
  ]);
  assert.equal(port.disconnects, 0);
});

test('keeps a pending start request correlated when running bootstrap arrives before its result', async () => {
  const env = fixture();
  const observed = [];
  const client = createClient(env, { onBootstrapResult: value => observed.push(value) });
  client.start();
  const port = env.ports[0];
  bootstrap(port);
  const pending = client.requestIntent({
    type: 'PANEL_START_ATTACHED_AUDIT',
    capabilityId: 'C'.repeat(22),
    captureMode: 'no-pixels',
    retentionPreference: { version: 1, deleteAfterCompleteExport: false },
    auditId: 'audit-start-1',
  });

  bootstrap(port, 'running', 'audit-start-1', SESSION_ID);
  port.onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'intent-result',
    requestId: 'port-request-1',
    response: { ok: true, auditId: 'audit-start-1', state: 'running' },
  });

  assert.deepEqual(await pending, { ok: true, auditId: 'audit-start-1', state: 'running' });
  assert.equal(port.disconnects, 0);
  assert.deepEqual(observed.at(-1), { state: 'running', auditId: 'audit-start-1', result: null });
});

test('adds only the current session correlation to cancel and report intents without a window claim', async () => {
  const env = fixture();
  const client = createClient(env);
  client.start();
  const port = env.ports[0];
  bootstrap(port, 'running', 'audit-panel-1', SESSION_ID);

  const pending = client.requestIntent({ type: 'PANEL_CANCEL_AUDIT' });
  assert.deepEqual(port.messages.at(-1).envelope, {
    type: 'PANEL_CANCEL_AUDIT', sessionCapabilityId: SESSION_ID, auditId: 'audit-panel-1',
  });
  port.onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'intent-result',
    requestId: 'port-request-1', response: { ok: true },
  });
  assert.deepEqual(await pending, { ok: true });
});

test('adds current correlation to occurrence-only highlight intents and never accepts UI target or window data', async () => {
  const env = fixture();
  const client = createClient(env);
  client.start();
  const port = env.ports[0];
  bootstrap(port, 'running', 'audit-panel-1', SESSION_ID);

  const current = client.requestIntent({ type: 'GET_HIGHLIGHT_STATE' });
  assert.deepEqual(port.messages.at(-1).envelope, {
    type: 'GET_HIGHLIGHT_STATE', sessionCapabilityId: SESSION_ID, auditId: 'audit-panel-1',
  });
  port.onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'intent-result', requestId: 'port-request-1',
    response: { ok: true, highlight: { state: 'clear' } },
  });
  assert.deepEqual(await current, { ok: true, highlight: { state: 'clear' } });

  const availability = client.requestIntent({ type: 'GET_HIGHLIGHT_AVAILABILITY', occurrenceId: 'occ-1' });
  assert.deepEqual(port.messages.at(-1).envelope, {
    type: 'GET_HIGHLIGHT_AVAILABILITY', sessionCapabilityId: SESSION_ID,
    auditId: 'audit-panel-1', occurrenceId: 'occ-1',
  });
  port.onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'intent-result', requestId: 'port-request-2',
    response: { ok: true, bindingStatus: { state: 'available' } },
  });
  assert.deepEqual(await availability, { ok: true, bindingStatus: { state: 'available' } });

  const highlight = client.requestIntent({ type: 'HIGHLIGHT_OCCURRENCE', occurrenceId: 'occ-1' });
  assert.deepEqual(port.messages.at(-1).envelope, {
    type: 'HIGHLIGHT_OCCURRENCE', sessionCapabilityId: SESSION_ID,
    auditId: 'audit-panel-1', occurrenceId: 'occ-1',
  });
  port.onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'intent-result', requestId: 'port-request-3',
    response: { ok: true, highlight: { state: 'active', occurrenceId: 'occ-1' } },
  });
  assert.equal((await highlight).ok, true);

  const clear = client.requestIntent({ type: 'CLEAR_HIGHLIGHT' });
  assert.deepEqual(port.messages.at(-1).envelope, {
    type: 'CLEAR_HIGHLIGHT', sessionCapabilityId: SESSION_ID, auditId: 'audit-panel-1',
  });
  port.onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'intent-result', requestId: 'port-request-4',
    response: { ok: true, highlight: { state: 'clear' } },
  });
  assert.equal((await clear).ok, true);

  for (const hostile of [
    { type: 'HIGHLIGHT_OCCURRENCE', occurrenceId: 'occ-1', selector: '#forged' },
    { type: 'HIGHLIGHT_OCCURRENCE', occurrenceId: 'occ-1', windowId: 9 },
    { type: 'GET_HIGHLIGHT_STATE', auditId: 'forged' },
    { type: 'CLEAR_HIGHLIGHT', auditId: 'forged' },
  ]) assert.deepEqual(await client.requestIntent(hostile), { ok: false, code: 'PANEL_SESSION_UNAVAILABLE' });
  assert.equal(port.disconnects, 0);
});

test('projects a correlated privacy pause without disclosing its one-use consent nonce to any callback', () => {
  const env = fixture();
  const bootstraps = [];
  const statuses = [];
  const highlights = [];
  const client = createClient(env, {
    onBootstrapResult: value => bootstraps.push(value),
    onStatus: value => statuses.push(value),
    onHighlightState: value => highlights.push(value),
  });
  client.start();
  const port = env.ports[0];
  bootstrap(port, 'running', 'audit-private', SESSION_ID);

  privacyPaused(port);

  assert.deepEqual(bootstraps.at(-1), {
    state: 'privacy-paused', auditId: 'audit-private', result: null,
    mode: 'full-evidence', categories: ['password', 'payment'], message: PRIVACY_MESSAGE,
  });
  assert.equal(Object.isFrozen(bootstraps.at(-1)), true);
  assert.equal(Object.isFrozen(bootstraps.at(-1).categories), true);
  assert.equal(JSON.stringify({ bootstraps, statuses, highlights }).includes(CONSENT_A), false);
  assert.equal(JSON.stringify(client).includes(CONSENT_A), false);
  assert.equal(port.disconnects, 0);
});

test('consumes the private nonce before posting one exact confirmation and rejects a replay locally', async () => {
  const env = fixture();
  const client = createClient(env);
  client.start();
  const port = env.ports[0];
  bootstrap(port, 'running', 'audit-private', SESSION_ID);
  privacyPaused(port);

  const pending = client.requestIntent({
    type: 'CONFIRM_PIXEL_CAPTURE', mode: 'full-evidence', accepted: true,
  });
  assert.deepEqual(port.messages.at(-1), {
    protocol: 'audita-panel', version: 1, type: 'intent', requestId: 'port-request-1',
    envelope: {
      type: 'CONFIRM_PIXEL_CAPTURE', sessionCapabilityId: SESSION_ID,
      auditId: 'audit-private', consentId: CONSENT_A,
      mode: 'full-evidence', accepted: true,
    },
  });
  const messagesAfterFirstPost = port.messages.length;
  const replay = client.requestIntent({
    type: 'CONFIRM_PIXEL_CAPTURE', mode: 'full-evidence', accepted: true,
  });
  assert.equal(port.messages.length, messagesAfterFirstPost);
  assert.deepEqual(await replay, { ok: false, code: 'PANEL_SESSION_UNAVAILABLE' });

  port.onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'intent-result',
    requestId: 'port-request-1', response: { ok: true, state: 'running' },
  });
  assert.deepEqual(await pending, { ok: true, state: 'running' });
});

test('accepts an owned pause without consent and posts one exact public confirmation without identifiers', async () => {
  const env = fixture();
  const bootstraps = [];
  const client = createClient(env, { onBootstrapResult: value => bootstraps.push(value) });
  client.start();
  const port = env.ports[0];
  bootstrap(port, 'running', 'audit-private', SESSION_ID);
  ownedPrivacyPaused(port);

  assert.deepEqual(bootstraps.at(-1), {
    state: 'privacy-paused', auditId: 'audit-private', result: null,
    mode: 'full-evidence', categories: ['password', 'payment'], message: PRIVACY_MESSAGE,
  });
  assert.doesNotMatch(JSON.stringify(bootstraps), /consent|ownership|digest|documentId|tabId/iu);

  const beforeForged = port.messages.length;
  assert.deepEqual(await client.requestIntent({
    type: 'PANEL_CONFIRM_PIXEL_CAPTURE', sessionCapabilityId: SESSION_ID,
    auditId: 'audit-private', mode: 'full-evidence', accepted: true,
  }), { ok: false, code: 'PANEL_SESSION_UNAVAILABLE' });
  assert.equal(port.messages.length, beforeForged);

  const pending = client.requestIntent({
    type: 'CONFIRM_PIXEL_CAPTURE', mode: 'full-evidence', accepted: true,
  });
  assert.deepEqual(port.messages.at(-1), {
    protocol: 'audita-panel', version: 1, type: 'intent', requestId: 'port-request-1',
    envelope: {
      type: 'PANEL_CONFIRM_PIXEL_CAPTURE', sessionCapabilityId: SESSION_ID,
      auditId: 'audit-private', mode: 'full-evidence', accepted: true,
    },
  });
  assert.doesNotMatch(JSON.stringify(port.messages.at(-1)), /consent|ownership|digest|documentId|tabId/iu);

  const messagesAfterFirstPost = port.messages.length;
  assert.deepEqual(await client.requestIntent({
    type: 'CONFIRM_PIXEL_CAPTURE', mode: 'full-evidence', accepted: true,
  }), { ok: false, code: 'PANEL_SESSION_UNAVAILABLE' });
  assert.equal(port.messages.length, messagesAfterFirstPost);

  port.onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'intent-result',
    requestId: 'port-request-1', response: { ok: true, state: 'running' },
  });
  assert.deepEqual(await pending, { ok: true, state: 'running' });
});

test('does not rearm an owned confirmation when the same pause is retransmitted while it is in flight', async () => {
  const env = fixture();
  const bootstraps = [];
  const client = createClient(env, { onBootstrapResult: value => bootstraps.push(value) });
  client.start();
  const port = env.ports[0];
  bootstrap(port, 'running', 'audit-private', SESSION_ID);
  ownedPrivacyPaused(port);

  const pending = client.requestIntent({
    type: 'CONFIRM_PIXEL_CAPTURE', mode: 'full-evidence', accepted: true,
  });
  const messagesAfterFirstPost = port.messages.length;
  const bootstrapsAfterFirstPause = bootstraps.length;

  ownedPrivacyPaused(port);
  assert.equal(bootstraps.length, bootstrapsAfterFirstPause, 'the duplicate does not rearm the visible confirmation');
  assert.deepEqual(await client.requestIntent({
    type: 'CONFIRM_PIXEL_CAPTURE', mode: 'full-evidence', accepted: true,
  }), { ok: false, code: 'PANEL_SESSION_UNAVAILABLE' });
  assert.equal(port.messages.length, messagesAfterFirstPost, 'only one public confirmation is posted');

  port.onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'intent-result',
    requestId: 'port-request-1', response: { ok: false, code: 'PIXEL_CONFIRMATION_FAILED' },
  });
  assert.deepEqual(await pending, { ok: false, code: 'PIXEL_CONFIRMATION_FAILED' });

  ownedPrivacyPaused(port);
  const retry = client.requestIntent({
    type: 'CONFIRM_PIXEL_CAPTURE', mode: 'full-evidence', accepted: true,
  });
  assert.equal(port.messages.length, messagesAfterFirstPost + 1, 'a fresh pause after failure may rearm once');
  port.onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'intent-result',
    requestId: 'port-request-2', response: { ok: true, state: 'running' },
  });
  assert.deepEqual(await retry, { ok: true, state: 'running' });
});

test('keeps a different owned pause available when it rotates during an earlier confirmation', async () => {
  const env = fixture();
  const bootstraps = [];
  const client = createClient(env, { onBootstrapResult: value => bootstraps.push(value) });
  client.start();
  const port = env.ports[0];
  bootstrap(port, 'running', 'audit-private', SESSION_ID);
  ownedPrivacyPaused(port);
  const first = client.requestIntent({
    type: 'CONFIRM_PIXEL_CAPTURE', mode: 'full-evidence', accepted: true,
  });

  ownedPrivacyPaused(port, { mode: 'element-only', categories: ['private-marker'] });
  assert.deepEqual(bootstraps.at(-1), {
    state: 'privacy-paused', auditId: 'audit-private', result: null,
    mode: 'element-only', categories: ['private-marker'], message: PRIVACY_MESSAGE,
  });
  const second = client.requestIntent({
    type: 'CONFIRM_PIXEL_CAPTURE', mode: 'element-only', accepted: true,
  });
  assert.deepEqual(port.messages.filter(message =>
    message?.envelope?.type === 'PANEL_CONFIRM_PIXEL_CAPTURE').map(message => message.envelope.mode), [
    'full-evidence', 'element-only',
  ]);

  port.onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'intent-result',
    requestId: 'port-request-2', response: { ok: true, state: 'running' },
  });
  assert.deepEqual(await second, { ok: true, state: 'running' });
  const messagesBeforeStaleReplay = port.messages.length;
  const bootstrapsBeforeStaleReplay = bootstraps.length;
  ownedPrivacyPaused(port);
  assert.equal(bootstraps.length, bootstrapsBeforeStaleReplay);
  assert.deepEqual(await client.requestIntent({
    type: 'CONFIRM_PIXEL_CAPTURE', mode: 'full-evidence', accepted: true,
  }), { ok: false, code: 'PANEL_SESSION_UNAVAILABLE' });
  assert.equal(port.messages.length, messagesBeforeStaleReplay);

  port.onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'intent-result',
    requestId: 'port-request-1', response: { ok: false, code: 'STALE_CONFIRMATION' },
  });
  assert.deepEqual(await first, { ok: false, code: 'STALE_CONFIRMATION' });
});

test('one correlated revoked cancellation packet returns the same Port to initial', async () => {
  const env = fixture();
  const observed = [];
  const order = [];
  const client = createClient(env, {
    onBootstrapResult: value => { observed.push(value); order.push(`bootstrap:${value.state}`); },
  });
  client.start();
  const port = env.ports[0];
  bootstrap(port, 'running', 'audit-private', SESSION_ID);
  privacyPaused(port);

  const cancelled = client.requestIntent({ type: 'PANEL_CANCEL_AUDIT' });
  const superseded = client.requestIntent({ type: 'PANEL_OPEN_REPORT' });
  cancelled.then(() => order.push('cancel:resolved'));
  port.onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'intent-result', requestId: 'port-request-1',
    response: { ok: true, auditId: 'audit-private', state: 'revoked' },
  });

  assert.deepEqual(await cancelled, { ok: true, auditId: 'audit-private', state: 'revoked' });
  assert.deepEqual(await superseded, { ok: false, code: 'PANEL_SESSION_UNAVAILABLE' });
  assert.deepEqual(observed.at(-1), { state: 'initial', auditId: null, result: null });
  assert.ok(order.indexOf('bootstrap:initial') < order.indexOf('cancel:resolved'));
  assert.equal(port.disconnects, 0);
  assert.equal(env.ports.length, 1);

  const next = client.requestIntent({ type: 'PREPARE_PANEL_CAPABILITY', requestId: 'prepare-after-cancel' });
  assert.deepEqual(port.messages.at(-1), {
    protocol: 'audita-panel', version: 1, type: 'intent', requestId: 'port-request-3',
    envelope: { type: 'PREPARE_PANEL_CAPABILITY', requestId: 'prepare-after-cancel' },
  });
  port.onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'intent-result', requestId: 'port-request-3',
    response: { ok: true, requestId: 'prepare-after-cancel' },
  });
  assert.deepEqual(await next, { ok: true, requestId: 'prepare-after-cancel' });
});

test('disconnects and denies a privacy-paused cancellation when its revoked response is not exact', async () => {
  const env = fixture();
  const observed = [];
  const client = createClient(env, { onBootstrapResult: value => observed.push(value) });
  client.start();
  const port = env.ports[0];
  bootstrap(port, 'running', 'audit-private', SESSION_ID);
  privacyPaused(port);
  const cancelled = client.requestIntent({ type: 'PANEL_CANCEL_AUDIT' });

  port.onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'intent-result', requestId: 'port-request-1',
    response: { ok: true, auditId: 'audit-private', state: 'revoked', extra: true },
  });

  assert.deepEqual(await cancelled, { ok: false, code: 'PANEL_SESSION_UNAVAILABLE' });
  assert.equal(port.disconnects, 1);
  assert.notDeepEqual(observed.at(-1), { state: 'initial', auditId: null, result: null });
});

test('the consent nonce is already unavailable during the confirmation post side effect', async () => {
  const env = fixture();
  const client = createClient(env);
  client.start();
  const port = env.ports[0];
  bootstrap(port, 'running', 'audit-private', SESSION_ID);
  privacyPaused(port);
  const originalPost = port.postMessage;
  let nested = null;
  let intercept = true;
  port.postMessage = function postMessage(message) {
    if (message?.type === 'intent' && intercept) {
      intercept = false;
      nested = client.requestIntent({
        type: 'CONFIRM_PIXEL_CAPTURE', mode: 'full-evidence', accepted: true,
      });
    }
    originalPost.call(this, message);
  };

  const pending = client.requestIntent({
    type: 'CONFIRM_PIXEL_CAPTURE', mode: 'full-evidence', accepted: true,
  });

  assert.equal(port.messages.filter(message => message.type === 'intent').length, 1);
  assert.deepEqual(await nested, { ok: false, code: 'PANEL_SESSION_UNAVAILABLE' });
  port.onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'intent-result',
    requestId: 'port-request-1', response: { ok: true, state: 'running' },
  });
  assert.equal((await pending).ok, true);
});

test('rotates A to B and reconnects only after the server rehydrates B', async () => {
  const env = fixture();
  const client = createClient(env);
  client.start();
  const firstPort = env.ports[0];
  bootstrap(firstPort, 'running', 'audit-private', SESSION_ID);
  privacyPaused(firstPort);
  privacyPaused(firstPort, { consentId: CONSENT_B, mode: 'element-only', categories: ['private-marker'] });

  const rotated = client.requestIntent({
    type: 'CONFIRM_PIXEL_CAPTURE', mode: 'element-only', accepted: true,
  });
  assert.equal(firstPort.messages.at(-1).envelope.consentId, CONSENT_B);
  firstPort.onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'intent-result',
    requestId: 'port-request-1', response: { ok: true, state: 'running' },
  });
  await rotated;

  firstPort.onDisconnect.emit();
  env.timers.at(-1).callback();
  const secondPort = env.ports[1];
  bootstrap(secondPort, 'running', 'audit-private', SESSION_ID);
  const beforeRehydrate = secondPort.messages.length;
  const absent = client.requestIntent({
    type: 'CONFIRM_PIXEL_CAPTURE', mode: 'element-only', accepted: true,
  });
  assert.equal(secondPort.messages.length, beforeRehydrate);
  assert.deepEqual(await absent, { ok: false, code: 'PANEL_SESSION_UNAVAILABLE' });

  privacyPaused(secondPort, { consentId: CONSENT_B, mode: 'element-only', categories: ['private-marker'] });
  const rehydrated = client.requestIntent({
    type: 'CONFIRM_PIXEL_CAPTURE', mode: 'element-only', accepted: true,
  });
  assert.equal(secondPort.messages.at(-1).envelope.consentId, CONSENT_B);
  secondPort.onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'intent-result',
    requestId: 'port-request-2', response: { ok: true, state: 'running' },
  });
  assert.equal((await rehydrated).ok, true);
});

test('clears private consent on every ordinary bootstrap, session swap, disconnect and stop', async t => {
  const completedResult = await resultBundle('audit-private');
  const terminalStates = [
    ['initial', null, null, null],
    ['running', 'audit-private', SESSION_ID, null],
    ['result', 'audit-private', SESSION_ID, completedResult],
    ['view-only', 'audit-private', SESSION_ID, completedResult],
    ['running', 'audit-other', 'B'.repeat(22), null],
  ];
  for (const [state, auditId, sessionId, result] of terminalStates) {
    await t.test(state === 'running' && auditId === 'audit-other' ? 'session-swap' : state, async () => {
      const env = fixture();
      const client = createClient(env);
      client.start();
      const port = env.ports[0];
      bootstrap(port, 'running', 'audit-private', SESSION_ID);
      privacyPaused(port);
      bootstrap(port, state, auditId, sessionId, result);
      const before = port.messages.length;
      assert.deepEqual(await client.requestIntent({
        type: 'CONFIRM_PIXEL_CAPTURE', mode: 'full-evidence', accepted: true,
      }), { ok: false, code: 'PANEL_SESSION_UNAVAILABLE' });
      assert.equal(port.messages.length, before);
    });
  }

  for (const ending of ['disconnect', 'stop']) {
    await t.test(ending, async () => {
      const env = fixture();
      const client = createClient(env);
      client.start();
      const port = env.ports[0];
      bootstrap(port, 'running', 'audit-private', SESSION_ID);
      privacyPaused(port);
      if (ending === 'disconnect') port.onDisconnect.emit();
      else client.stop();
      const before = port.messages.length;
      const denied = client.requestIntent({
        type: 'CONFIRM_PIXEL_CAPTURE', mode: 'full-evidence', accepted: true,
      });
      assert.equal(port.messages.length, before);
      assert.deepEqual(await denied, { ok: false, code: 'PANEL_SESSION_UNAVAILABLE' });
    });
  }
});

test('rejects hostile pause packets and hostile confirmation shapes without posting or exposing a nonce', async t => {
  const accessorCategories = [];
  Object.defineProperty(accessorCategories, '0', {
    enumerable: true, configurable: true, get() { throw new Error('hostile category accessor'); },
  });
  const symbolCategories = ['password'];
  symbolCategories[Symbol('category')] = 'otp';
  const hostilePackets = [
    { consentId: 'short' },
    { consentId: `${'a'.repeat(21)}Z` },
    { mode: 'no-pixels' },
    { categories: [] },
    { categories: ['payment', 'password'] },
    { categories: ['password', 'password'] },
    { categories: ['password', 'unknown'] },
    { categories: Object.assign(['password'], { extra: true }) },
    { categories: accessorCategories },
    { categories: symbolCategories },
    { message: `${PRIVACY_MESSAGE}!` },
    { auditId: 'audit-other' },
    { sessionCapabilityId: 'B'.repeat(22) },
    { extra: true },
  ];
  for (let index = 0; index < hostilePackets.length; index += 1) {
    await t.test(`wire-shape-${index + 1}`, () => {
      const overrides = hostilePackets[index];
      const env = fixture();
      const observed = [];
      const client = createClient(env, { onBootstrapResult: value => observed.push(value) });
      client.start();
      const port = env.ports[0];
      bootstrap(port, 'running', 'audit-private', SESSION_ID);
      privacyPaused(port, overrides);
      assert.equal(observed.some(value => value.state === 'privacy-paused'), false);
      assert.equal(JSON.stringify(observed).includes(CONSENT_A), false);
      assert.equal(port.disconnects, 1);
    });
  }

  for (const kind of ['accessor', 'symbol']) {
    await t.test(`wire-${kind}`, () => {
      const env = fixture();
      const observed = [];
      const client = createClient(env, { onBootstrapResult: value => observed.push(value) });
      client.start();
      const port = env.ports[0];
      bootstrap(port, 'running', 'audit-private', SESSION_ID);
      const packet = {
        protocol: 'audita-panel', version: 1, type: 'privacy-paused',
        auditId: 'audit-private', sessionCapabilityId: SESSION_ID,
        consentId: CONSENT_A, mode: 'full-evidence', categories: ['password'], message: PRIVACY_MESSAGE,
      };
      if (kind === 'accessor') {
        Object.defineProperty(packet, 'consentId', {
          enumerable: true, get() { throw new Error('hostile consent accessor'); },
        });
      } else packet[Symbol('consent')] = CONSENT_A;
      port.onMessage.emit(packet);
      assert.equal(observed.some(value => value.state === 'privacy-paused'), false);
      assert.equal(port.disconnects, 1);
    });
  }

  for (const makeIntent of [
    () => ({ type: 'CONFIRM_PIXEL_CAPTURE', mode: 'full-evidence', accepted: false }),
    () => ({ type: 'CONFIRM_PIXEL_CAPTURE', mode: 'element-only', accepted: true }),
    () => ({ type: 'CONFIRM_PIXEL_CAPTURE', mode: 'full-evidence', accepted: true, extra: true }),
    () => Object.defineProperty({ type: 'CONFIRM_PIXEL_CAPTURE', mode: 'full-evidence' }, 'accepted', {
      enumerable: true, get() { throw new Error('hostile accessor'); },
    }),
    () => Object.assign({ type: 'CONFIRM_PIXEL_CAPTURE', mode: 'full-evidence', accepted: true }, { [Symbol('x')]: true }),
  ]) {
    await t.test(String(makeIntent), async () => {
      const env = fixture();
      const client = createClient(env);
      client.start();
      const port = env.ports[0];
      bootstrap(port, 'running', 'audit-private', SESSION_ID);
      privacyPaused(port);
      const before = port.messages.length;
      const denied = client.requestIntent(makeIntent());
      assert.equal(port.messages.length, before);
      assert.deepEqual(await denied, { ok: false, code: 'PANEL_SESSION_UNAVAILABLE' });
    });
  }

  await t.test('nonce-absent', async () => {
    const env = fixture();
    const client = createClient(env);
    client.start();
    const port = env.ports[0];
    bootstrap(port, 'running', 'audit-private', SESSION_ID);
    const before = port.messages.length;
    const denied = client.requestIntent({
      type: 'CONFIRM_PIXEL_CAPTURE', mode: 'full-evidence', accepted: true,
    });
    assert.equal(port.messages.length, before);
    assert.deepEqual(await denied, { ok: false, code: 'PANEL_SESSION_UNAVAILABLE' });
  });
});

test('disconnect and correlation rotation close every pending request and never fall back to messages', async () => {
  const env = fixture();
  const statuses = [];
  const client = createClient(env, { onStatus: value => statuses.push(value) });
  client.start();
  const port = env.ports[0];
  bootstrap(port, 'running', 'audit-before', SESSION_ID);
  const first = client.requestIntent({ type: 'PANEL_OPEN_REPORT' });
  bootstrap(port, 'running', 'audit-after', 'B'.repeat(22));
  assert.deepEqual(await first, { ok: false, code: 'PANEL_SESSION_UNAVAILABLE' });

  const second = client.requestIntent({ type: 'PANEL_OPEN_REPORT' });
  port.onDisconnect.emit();
  assert.deepEqual(await second, { ok: false, code: 'PANEL_SESSION_UNAVAILABLE' });
  assert.equal(env.timers.at(-1).delay, 250);
  assert.ok(statuses.includes('Painel não preparado. Abra novamente pelo botão da extensão.'));
});

test('rejects malformed or replayed intent responses and stops without leaked listeners or timers', async () => {
  const env = fixture();
  const client = createClient(env);
  assert.deepEqual(await client.requestIntent({ type: 'PREPARE_PANEL_CAPABILITY', requestId: 'before-start' }), {
    ok: false, code: 'PANEL_SESSION_UNAVAILABLE',
  });
  client.start();
  const port = env.ports[0];
  bootstrap(port);
  const pending = client.requestIntent({ type: 'PREPARE_PANEL_CAPABILITY', requestId: 'prepare-1' });
  port.onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'intent-result',
    requestId: 'unknown-request', response: { ok: true },
  });
  assert.deepEqual(await pending, { ok: false, code: 'PANEL_SESSION_UNAVAILABLE' });
  assert.equal(port.disconnects, 1);
  assert.equal(client.stop(), true);
  assert.equal(client.stop(), false);
  assert.equal(port.onMessage.listeners.size, 0);
  assert.equal(port.onDisconnect.listeners.size, 0);
});

test('bounds reconnect attempts so an unprepared default panel remains stable', () => {
  const env = fixture();
  const client = createClient(env);
  client.start();

  for (let attempt = 0; attempt < 5; attempt += 1) {
    env.ports.at(-1).onDisconnect.emit();
    assert.equal(env.timers.length, attempt + 1);
    env.timers.at(-1).callback();
  }
  env.ports.at(-1).onDisconnect.emit();

  assert.equal(env.ports.length, 6);
  assert.equal(env.timers.length, 5);
});
