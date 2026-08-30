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
  const sent = [];
  const timers = [];
  const chromeApi = {
    runtime: {
      connect({ name }) {
        const port = {
          name,
          onMessage: event(), onDisconnect: event(), messages: [], disconnects: 0,
          postMessage(message) { this.messages.push(structuredClone(message)); },
          disconnect() { this.disconnects += 1; },
        };
        ports.push(port);
        return port;
      },
      async sendMessage(message) { sent.push(structuredClone(message)); return { ok: true }; },
    },
  };
  let currentWindowId = 9;
  const windowReads = [];
  return {
    chromeApi, ports, sent, timers,
    windowReads,
    getWindowId() { windowReads.push(currentWindowId); return currentWindowId; },
    setCurrentWindowId(value) { currentWindowId = value; },
    setTimer(callback, delay) { const timer = { callback, delay, cleared: false }; timers.push(timer); return timer; },
    clearTimer(timer) { timer.cleared = true; },
  };
}

test('connects once, sends one exact hello and never exposes the bearer to callbacks', async () => {
  const env = fixture();
  const bootstrap = [];
  const statuses = [];
  const client = createPanelSessionPortClient({
    chromeApi: env.chromeApi,
    getWindowId: env.getWindowId,
    onBootstrapResult: value => bootstrap.push(value),
    onStatus: value => statuses.push(value),
    setTimer: env.setTimer,
    clearTimer: env.clearTimer,
  });

  assert.deepEqual(Object.keys(client), ['start', 'stop', 'requestSessionIntent']);
  assert.equal(Object.isFrozen(client), true);
  assert.equal(client.start(), true);
  assert.equal(client.start(), false);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(env.ports.length, 1);
  assert.deepEqual(env.ports[0].messages, [{ protocol: 'audita-panel', version: 1, type: 'bootstrap', windowId: 9 }]);

  env.ports[0].onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'bootstrap-result', state: 'running',
    auditId: 'audit-panel-1', sessionCapabilityId: SESSION_ID, result: null,
  });
  assert.deepEqual(bootstrap, [{ state: 'running', auditId: 'audit-panel-1', result: null }]);
  assert.equal(JSON.stringify({ bootstrap, statuses }).includes(SESSION_ID), false);

  assert.deepEqual(await client.requestSessionIntent({ type: 'PANEL_CANCEL_AUDIT' }), { ok: true });
  assert.deepEqual(env.sent, [{ type: 'PANEL_CANCEL_AUDIT', sessionCapabilityId: SESSION_ID, auditId: 'audit-panel-1', windowId: 9 }]);
  assert.deepEqual(env.windowReads, [9, 9]);
});

test('clears correlation before unavailable notification and follows the fixed reconnect schedule', async () => {
  const env = fixture();
  const observations = [];
  let client;
  client = createPanelSessionPortClient({
    chromeApi: env.chromeApi,
    getWindowId: env.getWindowId,
    onBootstrapResult: value => observations.push(['bootstrap', value]),
    onStatus: value => observations.push(['status', value]),
    setTimer: env.setTimer,
    clearTimer: env.clearTimer,
  });
  client.start();
  await new Promise(resolve => setImmediate(resolve));
  const first = env.ports[0];
  first.onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'bootstrap-result', state: 'running',
    auditId: 'audit-panel-2', sessionCapabilityId: SESSION_ID, result: null,
  });
  first.onDisconnect.emit();
  assert.deepEqual(await client.requestSessionIntent({ type: 'PANEL_OPEN_REPORT' }), {
    ok: false, code: 'PANEL_SESSION_UNAVAILABLE',
  });
  assert.equal(env.sent.length, 0);
  assert.deepEqual(env.timers.map(timer => timer.delay), [250]);

  for (const expected of [500, 1000, 2000, 5000, 5000]) {
    env.timers.at(-1).callback();
    await new Promise(resolve => setImmediate(resolve));
    env.ports.at(-1).onDisconnect.emit();
    assert.equal(env.timers.at(-1).delay, expected);
  }
  assert.equal(observations.some(([, value]) => JSON.stringify(value).includes(SESSION_ID)), false);
});

test('invalid packets clear IDs, disconnect, and stop removes listeners and timers idempotently', async () => {
  const env = fixture();
  const client = createPanelSessionPortClient({
    chromeApi: env.chromeApi,
    getWindowId: env.getWindowId,
    onBootstrapResult() {}, onStatus() {}, setTimer: env.setTimer, clearTimer: env.clearTimer,
  });
  client.start();
  await new Promise(resolve => setImmediate(resolve));
  const port = env.ports[0];
  port.onMessage.emit({ protocol: 'audita-panel', version: 1, type: 'bootstrap-result', state: 'initial', auditId: null, sessionCapabilityId: null, result: null, extra: true });
  assert.equal(port.disconnects, 1);
  assert.equal(env.timers[0].delay, 250);
  assert.deepEqual(await client.requestSessionIntent({ type: 'PANEL_CANCEL_AUDIT' }), { ok: false, code: 'PANEL_SESSION_UNAVAILABLE' });
  assert.deepEqual(await client.requestSessionIntent({ type: 'PANEL_START_ATTACHED_AUDIT' }), { ok: false, code: 'PANEL_SESSION_UNAVAILABLE' });
  assert.equal(client.stop(), true);
  assert.equal(client.stop(), false);
  assert.equal(port.onMessage.listeners.size, 0);
  assert.equal(port.onDisconnect.listeners.size, 0);
  assert.equal(env.timers[0].cleared, true);
});

test('re-reads and propagates one closed panel window claim for reconnects and session actions', async () => {
  const env = fixture();
  const client = createPanelSessionPortClient({
    chromeApi: env.chromeApi,
    getWindowId: env.getWindowId,
    onBootstrapResult() {}, onStatus() {}, setTimer: env.setTimer, clearTimer: env.clearTimer,
  });
  client.start();
  await new Promise(resolve => setImmediate(resolve));
  const first = env.ports[0];
  first.onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'bootstrap-result', state: 'running',
    auditId: 'audit-panel-window', sessionCapabilityId: SESSION_ID, result: null,
  });
  env.setCurrentWindowId(11);
  assert.deepEqual(await client.requestSessionIntent({ type: 'PANEL_CANCEL_AUDIT' }), { ok: true });
  assert.deepEqual(env.sent.at(-1), {
    type: 'PANEL_CANCEL_AUDIT', sessionCapabilityId: SESSION_ID,
    auditId: 'audit-panel-window', windowId: 11,
  });
  first.onDisconnect.emit();
  env.timers.at(-1).callback();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(env.ports.at(-1).messages, [
    { protocol: 'audita-panel', version: 1, type: 'bootstrap', windowId: 11 },
  ]);
});
