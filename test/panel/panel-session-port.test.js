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

function bootstrap(port, state = 'initial', auditId = null, sessionCapabilityId = null, result = null, captureMode) {
  const packet = {
    protocol: 'audita-panel', version: 1, type: 'bootstrap-result', state,
    auditId, sessionCapabilityId, result,
  };
  if (captureMode !== undefined) packet.captureMode = captureMode;
  port.onMessage.emit(packet);
}

async function resultBundle(auditId, modelRevision = 1) {
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
      version: 1, auditId, modelRevision,
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

function batchPrivacyPaused(port, overrides = {}) {
  port.onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'privacy-paused',
    auditId: 'audit-private', sessionCapabilityId: SESSION_ID,
    mode: 'element-only', categories: ['otp', 'private-marker'], message: PRIVACY_MESSAGE,
    pageNumber: 3,
    ...overrides,
  });
}

const markerState = (auditId, extra = {}) => ({
  version: 1, type: 'PAGE_MARKERS_STATE_CHANGED', auditId,
  modelRevision: 1, state: 'active', selectedOrdinal: 0, ...extra,
});

function replyLastIntent(port, response) {
  port.onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'intent-result',
    requestId: port.messages.at(-1).requestId, response,
  });
}

test('page-marker intents enrich private session correlation and retain the exact offered revision', async () => {
  const env = fixture();
  const client = createClient(env);
  client.start();
  const port = env.ports[0];
  const bundle = await resultBundle('audit-markers');
  assert.ok(bundle.details.length > 0);
  bootstrap(port, 'result', bundle.auditId, SESSION_ID, bundle);
  for (const intent of [
    { type: 'PANEL_SHOW_PAGE_MARKERS', modelRevision: 1 },
    { type: 'PANEL_HIDE_PAGE_MARKERS', modelRevision: 1 },
    { type: 'PANEL_SELECT_PAGE_MARKER', modelRevision: 1, ordinal: 0, scroll: true },
    { type: 'PANEL_FILTER_PAGE_MARKERS', modelRevision: 1, visibleOrdinals: '0' },
    { type: 'PANEL_FILTER_PAGE_MARKERS', modelRevision: 1, visibleOrdinals: '' },
  ]) {
    const pending = client.requestIntent(intent);
    assert.deepEqual(port.messages.at(-1).envelope, { ...intent, auditId: bundle.auditId, sessionCapabilityId: SESSION_ID });
    assert.equal(env.timers.at(-1).delay, intent.type === 'PANEL_SHOW_PAGE_MARKERS' ? 60000 : 5000);
    replyLastIntent(port, { ok: false, code: 'PAGE_MARKERS_UNAVAILABLE' });
    assert.deepEqual(await pending, { ok: false, code: 'PAGE_MARKERS_UNAVAILABLE' });
  }
  client.stop();
});

test('page-marker client rejects authority overrides, stale revision and noncanonical or unavailable ordinals without sending', async () => {
  const env = fixture();
  const client = createClient(env);
  client.start();
  const port = env.ports[0];
  const bundle = await resultBundle('audit-markers');
  bootstrap(port, 'view-only', bundle.auditId, SESSION_ID, bundle);
  const base = { type: 'PANEL_SHOW_PAGE_MARKERS', modelRevision: 1 };
  const invalid = [
    ...[{ auditId: bundle.auditId }, { sessionCapabilityId: SESSION_ID }, { windowId: 9 }, { tabId: 7 }].map(extra => ({ ...base, ...extra })),
    ...[0, 2, '1', 1.5].map(modelRevision => ({ ...base, modelRevision })),
    ...[-1, 64, Math.min(64, bundle.details.length), '0'].map(ordinal => ({ type: 'PANEL_SELECT_PAGE_MARKER', modelRevision: 1, ordinal, scroll: false })),
    { type: 'PANEL_SELECT_PAGE_MARKER', modelRevision: 1, ordinal: 0, scroll: 1 },
    ...['00', '0,0', '1,0', '64', '0,', ' 0', String(Math.min(64, bundle.details.length))].map(visibleOrdinals => ({ type: 'PANEL_FILTER_PAGE_MARKERS', modelRevision: 1, visibleOrdinals })),
  ];
  let reads = 0;
  const accessor = { ...base };
  Object.defineProperty(accessor, 'modelRevision', { enumerable: true, get() { reads += 1; return 1; } });
  invalid.push(accessor);
  const messages = port.messages.length;
  for (const intent of invalid) {
    const pending = client.requestIntent(intent);
    assert.equal(port.messages.length, messages, JSON.stringify(intent === accessor ? 'accessor' : intent));
    assert.deepEqual(await pending, { ok: false, code: 'PANEL_SESSION_UNAVAILABLE' });
  }
  assert.equal(reads, 0);
  client.stop();
});

test('page-marker state packets project no authority and ignore stale audits before checking current bounds', async () => {
  const env = fixture();
  const states = [];
  const client = createClient(env, { onPageMarkersState: value => states.push(value) });
  client.start();
  const port = env.ports[0];
  const bundle = await resultBundle('audit-markers');
  bootstrap(port, 'result', bundle.auditId, SESSION_ID, bundle);
  port.onMessage.emit(markerState('older-audit', { selectedOrdinal: 63 }));
  port.onMessage.emit(markerState(bundle.auditId, { modelRevision: 2, selectedOrdinal: 63 }));
  assert.equal(port.disconnects, 0);
  assert.deepEqual(states, []);
  port.onMessage.emit(markerState(bundle.auditId));
  port.onMessage.emit(markerState(bundle.auditId, { state: 'clear', selectedOrdinal: null }));
  assert.deepEqual(states, [
    { modelRevision: 1, state: 'active', selectedOrdinal: 0 },
    { modelRevision: 1, state: 'clear', selectedOrdinal: null },
  ]);
  assert.equal(Object.isFrozen(states[0]), true);
  assert.equal(JSON.stringify(states).includes(SESSION_ID), false);
  port.onMessage.emit(markerState(bundle.auditId, { selectedOrdinal: Math.min(64, bundle.details.length) }));
  assert.equal(port.disconnects, 1);
  client.stop();
});

test('page-marker packets work with legacy factory and throwing optional callback; malformed authority is rejected', async () => {
  for (const overrides of [{}, { onPageMarkersState() { throw new Error('UI callback'); } }]) {
    const env = fixture();
    const client = createClient(env, overrides);
    client.start();
    const port = env.ports[0];
    const bundle = await resultBundle('audit-markers');
    bootstrap(port, 'result', bundle.auditId, SESSION_ID, bundle);
    port.onMessage.emit(markerState(bundle.auditId));
    assert.equal(port.disconnects, 0);
    port.onMessage.emit(markerState(bundle.auditId, { installationId: 'a'.repeat(22) }));
    assert.equal(port.disconnects, 1);
    client.stop();
  }
});

test('page-marker pending responses cannot restore an older result revision or audit', async () => {
  for (const nextAuditId of ['audit-markers', 'audit-next']) {
    const env = fixture();
    const client = createClient(env);
    client.start();
    const port = env.ports[0];
    const old = await resultBundle('audit-markers');
    bootstrap(port, 'result', old.auditId, SESSION_ID, old);
    const pending = client.requestIntent({ type: 'PANEL_SHOW_PAGE_MARKERS', modelRevision: 1 });
    const next = await resultBundle(nextAuditId, 2);
    bootstrap(port, 'view-only', next.auditId, SESSION_ID, next);
    replyLastIntent(port, { ok: true, markers: { modelRevision: 1, state: 'active' } });
    assert.deepEqual(await pending, { ok: false, code: 'PANEL_SESSION_UNAVAILABLE' });
    assert.equal(port.disconnects, 0);
    client.stop();
  }
});

test('page-marker correlation resets for initial and running states before callbacks can request', async () => {
  const env = fixture();
  let client;
  const attempts = [];
  client = createClient(env, { onBootstrapResult() {
    attempts.push(client.requestIntent({ type: 'PANEL_SHOW_PAGE_MARKERS', modelRevision: 1 }));
  } });
  client.start();
  const port = env.ports[0];
  bootstrap(port);
  assert.equal(port.messages.length, 1);
  assert.deepEqual(await attempts.pop(), { ok: false, code: 'PANEL_SESSION_UNAVAILABLE' });
  bootstrap(port, 'running', 'audit-markers', SESSION_ID);
  assert.equal(port.messages.length, 1);
  assert.deepEqual(await attempts.pop(), { ok: false, code: 'PANEL_SESSION_UNAVAILABLE' });
  port.onMessage.emit(markerState('audit-markers'));
  assert.equal(port.disconnects, 0);
  client.stop();
});

test('an idle bootstrap carries only the closed page-reloaded notice', () => {
  // O worker avisa o painel recriado de que a auditoria daquela aba foi interrompida porque a página
  // recarregou. Só `initial` aceita aviso, e só este valor; o resto continua recusado.
  const idle = {
    protocol: 'audita-panel', version: 1, type: 'bootstrap-result', state: 'initial',
    auditId: null, sessionCapabilityId: null, result: null,
  };
  for (const [packet, accepted] of [
    [{ ...idle, notice: 'page-reloaded' }, true],
    [{ ...idle, notice: 'other' }, false],
    [{ ...idle, notice: null }, false],
    [{ ...idle, notice: 'page-reloaded', extra: true }, false],
    [{ ...idle, state: 'running', auditId: 'audit-1', sessionCapabilityId: SESSION_ID, notice: 'page-reloaded' }, false],
  ]) {
    const env = fixture();
    const observed = [];
    const client = createClient(env, { onBootstrapResult: value => observed.push(value) });
    client.start();
    const port = env.ports[0];
    port.onMessage.emit(packet);
    if (accepted) {
      assert.deepEqual(observed, [{ state: 'initial', auditId: null, result: null, notice: 'page-reloaded' }]);
      assert.equal(port.disconnects, 0);
    } else {
      assert.deepEqual(observed, [], JSON.stringify(packet));
    }
    client.stop();
  }
});

test('uses one admitted Port for bootstrap and every privileged panel intent', async () => {
  const env = fixture();
  const observed = [];
  const statuses = [];
  const client = createClient(env, {
    onBootstrapResult: value => observed.push(value),
    onStatus: value => statuses.push(value),
  });

  assert.deepEqual(Object.keys(client), ['start', 'stop', 'requestIntent', 'setReviewVisible']);
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

test('projects a batch pause with only its safe page number and consumes one public confirmation', async () => {
  const env = fixture();
  const bootstraps = [];
  const client = createClient(env, { onBootstrapResult: value => bootstraps.push(value) });
  client.start();
  const port = env.ports[0];
  bootstrap(port, 'running', 'audit-private', SESSION_ID);
  batchPrivacyPaused(port);

  assert.deepEqual(bootstraps.at(-1), {
    state: 'privacy-paused', auditId: 'audit-private', result: null,
    mode: 'element-only', categories: ['otp', 'private-marker'], message: PRIVACY_MESSAGE,
    pageNumber: 3,
  });
  assert.doesNotMatch(JSON.stringify(bootstraps), /https?:|consent|owner|digest|documentId|tabId/iu);

  const pending = client.requestIntent({
    type: 'CONFIRM_PIXEL_CAPTURE', mode: 'element-only', accepted: true,
  });
  assert.deepEqual(port.messages.at(-1), {
    protocol: 'audita-panel', version: 1, type: 'intent', requestId: 'port-request-1',
    envelope: {
      type: 'PANEL_CONFIRM_PIXEL_CAPTURE', sessionCapabilityId: SESSION_ID,
      auditId: 'audit-private', mode: 'element-only', accepted: true,
    },
  });
  const posted = port.messages.length;
  assert.deepEqual(await client.requestIntent({
    type: 'CONFIRM_PIXEL_CAPTURE', mode: 'element-only', accepted: true,
  }), { ok: false, code: 'PANEL_SESSION_UNAVAILABLE' });
  assert.equal(port.messages.length, posted);

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

test('reload and reconnect project the exact authoritative capture mode for every running audit policy', () => {
  for (const mode of ['full-evidence', 'element-only', 'no-pixels']) {
    const env = fixture();
    const observed = [];
    const client = createClient(env, { onBootstrapResult: value => observed.push(value) });
    client.start();
    const first = env.ports[0];
    bootstrap(first, 'running', `audit-${mode}`, SESSION_ID, null, mode);
    assert.deepEqual(observed.at(-1), {
      state: 'running', auditId: `audit-${mode}`, result: null, captureMode: mode,
    });

    first.onDisconnect.emit();
    env.timers.at(-1).callback();
    const second = env.ports[1];
    bootstrap(second, 'running', `audit-${mode}`, SESSION_ID, null, mode);
    assert.deepEqual(observed.at(-1), {
      state: 'running', auditId: `audit-${mode}`, result: null, captureMode: mode,
    });
  }
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

for (const intent of [
  { type: 'GET_HIGHLIGHT_STATE' },
  { type: 'GET_HIGHLIGHT_AVAILABILITY', occurrenceId: 'occ-1' },
]) test(`ignores one timed-out ${intent.type} response without losing the report session or settling a newer request`, async () => {
  const env = fixture();
  const client = createClient(env);
  client.start();
  const port = env.ports[0];
  bootstrap(port, 'result', 'audit-late', SESSION_ID, await resultBundle('audit-late'));
  const highlight = client.requestIntent(intent);
  const prior = port.messages.at(-1);
  env.timers.at(-1).callback();
  assert.deepEqual(await highlight, { ok: false, code: 'PANEL_SESSION_UNAVAILABLE' });
  const report = client.requestIntent({ type: 'PANEL_OPEN_REPORT' });
  const current = port.messages.at(-1);
  const response = {
    protocol: 'audita-panel', version: 1, type: 'intent-result',
    requestId: prior.requestId, response: { ok: false, code: 'HIGHLIGHT_NO_BINDING' },
  };
  port.onMessage.emit(response);
  assert.equal(port.disconnects, 0, 'a late reply to our own timeout must not tear down the result session');
  port.onMessage.emit({ ...response, requestId: current.requestId,
    response: { ok: true, auditId: 'audit-late', state: 'connected' } });
  assert.deepEqual(await report, { ok: true, auditId: 'audit-late', state: 'connected' });
  // Only the first late reply is discarded. Its replay is still rejected.
  port.onMessage.emit(response);
  assert.equal(port.disconnects, 1);
});

test('does not reuse a timed-out request identity or accept its malformed late packet', async () => {
  const env = fixture();
  const client = createClient(env, { createRequestId: () => 'same-request' });
  client.start();
  const port = env.ports[0];
  bootstrap(port, 'running', 'audit-port', SESSION_ID);
  const pending = client.requestIntent({ type: 'GET_HIGHLIGHT_STATE' });
  env.timers.at(-1).callback();
  await pending;
  const count = port.messages.length;
  assert.deepEqual(await client.requestIntent({ type: 'PANEL_OPEN_REPORT' }), {
    ok: false, code: 'PANEL_SESSION_UNAVAILABLE',
  });
  assert.equal(port.messages.length, count);
  port.onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'intent-result',
    requestId: 'same-request', response: { ok: true }, extra: true,
  });
  assert.equal(port.disconnects, 1);
});

test('a late cancellation acknowledgement reconnects instead of preserving a revoked privacy session', async () => {
  const env = fixture();
  const client = createClient(env);
  client.start();
  const port = env.ports[0];
  bootstrap(port, 'running', 'audit-private', SESSION_ID);
  privacyPaused(port);
  const cancelled = client.requestIntent({ type: 'PANEL_CANCEL_AUDIT' });
  const requestId = port.messages.at(-1).requestId;
  env.timers.at(-1).callback();
  assert.deepEqual(await cancelled, { ok: false, code: 'PANEL_SESSION_UNAVAILABLE' });
  port.onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'intent-result', requestId,
    response: { ok: true, auditId: 'audit-private', state: 'revoked' },
  });
  assert.equal(port.disconnects, 1, 'terminal cancellation needs authoritative rehydration after timeout');
  env.timers.at(-1).callback();
  const next = env.ports[1];
  bootstrap(next);
  const prepare = client.requestIntent({ type: 'PREPARE_PANEL_CAPABILITY', requestId: 'prepare-after-late-cancel' });
  next.onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'intent-result',
    requestId: next.messages.at(-1).requestId, response: { ok: true },
  });
  assert.deepEqual(await prepare, { ok: true });
});

test('timed-out identities cannot suppress traffic after reconnecting to a new Port', async () => {
  const env = fixture();
  const client = createClient(env);
  client.start();
  const port = env.ports[0];
  bootstrap(port, 'running', 'audit-port', SESSION_ID);
  const pending = client.requestIntent({ type: 'GET_HIGHLIGHT_STATE' });
  const requestId = port.messages.at(-1).requestId;
  env.timers.at(-1).callback();
  await pending;
  port.onDisconnect.emit();
  env.timers.at(-1).callback();
  const replacement = env.ports[1];
  bootstrap(replacement, 'running', 'audit-port', SESSION_ID);
  replacement.onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'intent-result', requestId,
    response: { ok: true },
  });
  assert.equal(replacement.disconnects, 1);
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

test('clears the bounded recovery watchdog on valid bootstrap, disconnect and stop', async t => {
  await t.test('valid bootstrap', () => {
    const env = fixture();
    const client = createClient(env);
    client.start();
    const watchdog = env.timers[0];

    assert.equal(watchdog?.delay, 60000);
    bootstrap(env.ports[0]);

    assert.equal(watchdog.cleared, true);
  });

  await t.test('disconnect', () => {
    const env = fixture();
    const client = createClient(env);
    client.start();
    const watchdog = env.timers[0];

    assert.equal(watchdog?.delay, 60000);
    env.ports[0].onDisconnect.emit();

    assert.equal(watchdog.cleared, true);
  });

  await t.test('stop', () => {
    const env = fixture();
    const client = createClient(env);
    client.start();
    const watchdog = env.timers[0];

    assert.equal(watchdog?.delay, 60000);
    client.stop();

    assert.equal(watchdog.cleared, true);
  });
});

test('times out every silent Port and bounds reconnect attempts while intents stay unavailable', async () => {
  const env = fixture();
  const statuses = [];
  const client = createClient(env, { onStatus: value => statuses.push(value) });
  client.start();

  const reconnectDelays = [250, 500, 1000, 2000, 5000];
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const port = env.ports.at(-1);
    const watchdog = env.timers.at(-1);
    assert.equal(watchdog?.delay, 60000, `Port ${attempt + 1} receives its own bootstrap watchdog`);

    watchdog.callback();

    assert.equal(port.disconnects, 1);
    assert.deepEqual(await client.requestIntent({ type: 'PREPARE_PANEL_CAPABILITY', requestId: `denied-${attempt}` }), {
      ok: false, code: 'PANEL_SESSION_UNAVAILABLE',
    });
    if (attempt === reconnectDelays.length) continue;
    const reconnect = env.timers.at(-1);
    assert.equal(reconnect.delay, reconnectDelays[attempt]);
    reconnect.callback();
  }

  assert.equal(env.ports.length, 6);
  assert.equal(env.timers.length, 11);
  assert.equal(statuses.filter(value =>
    value === 'Painel não preparado. Abra novamente pelo botão da extensão.').length, 5);
  assert.equal(statuses.at(-1), 'Painel indisponível. Abra novamente pelo botão da extensão.');
});

test('opens the report after slow verified recovery and a queued read without timing out at five seconds', async () => {
  const bundle = await resultBundle('audit-slow-report');
  const env = fixture();
  const client = createClient(env);
  client.start();
  const port = env.ports[0];
  for (const timer of [...env.timers]) if (!timer.cleared && timer.delay <= 20000) timer.callback();
  assert.equal(port.disconnects, 0, 'a verified recovery taking 20s must retain its original Port');
  bootstrap(port, 'view-only', 'audit-slow-report', SESSION_ID, bundle);
  const report = client.requestIntent({ type: 'PANEL_OPEN_REPORT' });
  const request = port.messages.at(-1);
  const watchdog = env.timers.at(-1);
  assert.equal(watchdog.delay, 60000, 'report opening must tolerate a preceding large-model read');
  for (const timer of [...env.timers]) if (!timer.cleared && timer.delay <= 20000) timer.callback();
  port.onMessage.emit({ protocol: 'audita-panel', version: 1, type: 'intent-result',
    requestId: request.requestId, response: { ok: true, auditId: 'audit-slow-report', state: 'connected' } });
  assert.deepEqual(await report, { ok: true, auditId: 'audit-slow-report', state: 'connected' });
  assert.equal(port.disconnects, 0);
  assert.equal(watchdog.cleared, true);
  client.stop();
});

test('review heartbeat is terminal-only, visible-only and keeps one absolute budget per audit across reconnects', async t => {
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  t.after(() => { Date.now = originalNow; });
  const env = fixture();
  const client = createClient(env);

  assert.equal(client.setReviewVisible(true), true);
  assert.equal(env.timers.length, 0, 'visibility alone cannot start transport activity');
  client.start();
  const firstPort = env.ports[0];
  assert.equal(env.timers.filter(timer => timer.delay === 20_000).length, 0);
  bootstrap(firstPort, 'running', 'audit-heartbeat', SESSION_ID, null, 'no-pixels');
  assert.equal(env.timers.filter(timer => timer.delay === 20_000).length, 0);

  const firstBundle = await resultBundle('audit-heartbeat');
  bootstrap(firstPort, 'result', 'audit-heartbeat', SESSION_ID, firstBundle);
  const firstHeartbeat = env.timers.find(timer => timer.delay === 20_000 && !timer.cleared);
  assert.ok(firstHeartbeat);
  now += 5_000;
  bootstrap(firstPort, 'result', 'audit-heartbeat', SESSION_ID, await resultBundle('audit-heartbeat', 2));
  assert.equal(env.timers.filter(timer => timer.delay === 20_000 && !timer.cleared).length, 1,
    'a new result revision must not duplicate or refresh the timer');

  bootstrap(firstPort, 'running', 'audit-heartbeat', SESSION_ID, null, 'no-pixels');
  assert.equal(firstHeartbeat.cleared, true, 'a non-terminal state must stop the timer immediately');
  const beforeNonTerminalCallback = firstPort.messages.length;
  firstHeartbeat.callback();
  assert.equal(firstPort.messages.length, beforeNonTerminalCallback);
  bootstrap(firstPort, 'result', 'audit-heartbeat', SESSION_ID, firstBundle);
  const resumedHeartbeat = env.timers.findLast(timer => timer.delay === 20_000 && !timer.cleared);

  now = 21_000;
  resumedHeartbeat.callback();
  assert.deepEqual(firstPort.messages.at(-1), {
    protocol: 'audita-panel', version: 1, type: 'review-heartbeat',
  });
  const delayed = env.timers.findLast(timer => timer.delay === 20_000 && !timer.cleared);
  client.setReviewVisible(false);
  assert.equal(delayed.cleared, true);
  const beforeDelayed = firstPort.messages.length;
  delayed.callback();
  assert.equal(firstPort.messages.length, beforeDelayed, 'cleared callbacks must be inert');

  client.setReviewVisible(true);
  const beforeDisconnect = env.timers.findLast(timer => timer.delay === 20_000 && !timer.cleared);
  firstPort.onDisconnect.emit();
  assert.equal(beforeDisconnect.cleared, true);
  const reconnect = env.timers.findLast(timer => timer.delay === 250 && !timer.cleared);
  reconnect.callback();
  const secondPort = env.ports.at(-1);
  now = 1_800_999;
  bootstrap(secondPort, 'view-only', 'audit-heartbeat', 'B'.repeat(22), firstBundle);
  const expiredCallback = env.timers.findLast(timer => timer.delay === 20_000 && !timer.cleared);
  assert.ok(expiredCallback);
  now = 1_801_001;
  expiredCallback.callback();
  assert.equal(secondPort.messages.some(packet => packet.type === 'review-heartbeat'), false,
    'real time beyond the original deadline must suppress a delayed callback');

  const nextBundle = await resultBundle('audit-heartbeat-next');
  bootstrap(secondPort, 'result', 'audit-heartbeat-next', 'C'.repeat(22), nextBundle);
  assert.ok(env.timers.some(timer => timer.delay === 20_000 && !timer.cleared),
    'a different audit receives a fresh bounded budget');
  client.stop();
});

test('review heartbeat post failure follows existing Port unavailability and never enters intent bookkeeping', async t => {
  const originalNow = Date.now;
  Date.now = () => 10_000;
  t.after(() => { Date.now = originalNow; });
  const env = fixture();
  const statuses = [];
  const client = createClient(env, { onStatus: value => statuses.push(value) });
  client.start();
  const port = env.ports[0];
  bootstrap(port, 'result', 'audit-heartbeat-error', SESSION_ID, await resultBundle('audit-heartbeat-error'));
  client.setReviewVisible(true);
  const timer = env.timers.findLast(entry => entry.delay === 20_000 && !entry.cleared);
  port.postMessage = () => { throw new Error('native secret'); };
  timer.callback();
  assert.equal(port.disconnects, 1);
  assert.equal(statuses.at(-1), 'Painel não preparado. Abra novamente pelo botão da extensão.');
  assert.deepEqual(await client.requestIntent({ type: 'PANEL_OPEN_REPORT' }), {
    ok: false, code: 'PANEL_SESSION_UNAVAILABLE',
  });
});
