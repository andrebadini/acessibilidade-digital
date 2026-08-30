import assert from 'node:assert/strict';
import test from 'node:test';

import { createPanelSessionPortClient } from '../../src/panel/panel-session-port.js';

const SESSION_ID = 'A'.repeat(22);

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
    createRequestId: env.createRequestId,
    setTimer: env.setTimer,
    clearTimer: env.clearTimer,
    ...overrides,
  });
}

function bootstrap(port, state = 'initial', auditId = null, sessionCapabilityId = null) {
  port.onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'bootstrap-result', state,
    auditId, sessionCapabilityId, result: null,
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
