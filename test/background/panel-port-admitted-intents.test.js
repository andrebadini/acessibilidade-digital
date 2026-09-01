import assert from 'node:assert/strict';
import test from 'node:test';

import { createPanelPortCoordinator, PANEL_PORT_NAME } from '../../src/background/panel-port.js';

const RUNTIME_ID = 'abcdefghijklmnopabcdefghijklmnop';
const TOKEN = 'L'.repeat(43);
const URL = `chrome-extension://${RUNTIME_ID}/src/panel/index.html?launch=${TOKEN}`;

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
  const values = Object.create(null);
  const calls = [];
  const admission = Object.freeze({
    ok: true, token: TOKEN, tabId: 17, windowId: 9, generation: 1,
    contextId: 'panel-context', documentId: 'panel-document', url: URL,
    syntheticSender: Object.freeze({
      id: RUNTIME_ID, url: URL, origin: `chrome-extension://${RUNTIME_ID}`, documentId: 'panel-document',
    }),
  });
  const launchAuthority = {
    async admitPort(value) { calls.push(['admit', value]); return admission; },
    async reprove(value) { calls.push(['reprove', value]); return value === admission ? admission : { ok: false }; },
    async retirePort(value) {
      calls.push(['retire', value]);
      return Object.freeze({ version: 1, state: 'released' });
    },
    async revoke(value) { calls.push(['revoke', value]); return { ok: true }; },
  };
  const coordinator = createPanelPortCoordinator({
    chromeApi: { runtime: { id: RUNTIME_ID } },
    sessionArea: {
      async get(key) { return Object.hasOwn(values, key) ? { [key]: structuredClone(values[key]) } : {}; },
      async set(entries) { Object.assign(values, structuredClone(entries)); },
      async remove(key) { delete values[key]; },
    },
    readActiveJob: async () => null,
    readAuditSession: async () => { throw new Error('unused'); },
    readPixelSuspension: async () => null,
    loadPanelResultBundle: async () => { throw new Error('unused'); },
    rehydrateViewOnly: async () => { throw new Error('unused'); },
    revokeViewOnly: async () => true,
    epochNow: () => 1_788_000_000_000,
    setTimer(callback, delay) { return { callback, delay }; },
    clearTimer() {},
    launchAuthority,
    async authorizeHighlightSession() { return { ok: false }; },
    async dispatchPanelIntent(value) {
      calls.push(['dispatch', value]);
      return Object.freeze({ ok: true, requestId: value.envelope.requestId });
    },
  });
  const onMessage = event();
  const onDisconnect = event();
  const port = {
    name: PANEL_PORT_NAME,
    sender: { id: RUNTIME_ID, url: URL, origin: `chrome-extension://${RUNTIME_ID}` },
    onMessage, onDisconnect, messages: [], disconnects: 0,
    postMessage(value) { this.messages.push(structuredClone(value)); },
    disconnect() { this.disconnects += 1; onDisconnect.emit(); },
  };
  return { coordinator, calls, port, admission };
}

function tick() { return new Promise(resolve => setImmediate(resolve)); }

test('admits a real-shape document-less Port then routes privileged intents with worker-owned identity', async () => {
  const { coordinator, calls, port, admission } = fixture();
  assert.equal(coordinator.attachPanelPort(port), true);
  port.onMessage.emit({ protocol: 'audita-panel', version: 1, type: 'bootstrap' });
  await tick();
  assert.equal(port.messages.at(-1).type, 'bootstrap-result');

  port.onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'intent', requestId: 'port-request-1',
    envelope: { type: 'PREPARE_PANEL_CAPABILITY', requestId: 'prepare-1' },
  });
  await tick();

  const dispatched = calls.find(([name]) => name === 'dispatch')[1];
  assert.deepEqual(dispatched, {
    envelope: {
      type: 'PREPARE_PANEL_CAPABILITY', requestId: 'prepare-1', windowId: 9,
    },
    sender: admission.syntheticSender,
    launchTabId: 17,
  });
  assert.deepEqual(port.messages.at(-1), {
    protocol: 'audita-panel', version: 1, type: 'intent-result', requestId: 'port-request-1',
    response: { ok: true, requestId: 'prepare-1' },
  });
  assert.equal(calls.filter(([name]) => name === 'reprove').length >= 2, true);

  port.onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'intent', requestId: 'confirm-request-1',
    envelope: {
      type: 'CONFIRM_PIXEL_CAPTURE', sessionCapabilityId: 'S'.repeat(22),
      auditId: 'audit-paused', consentId: `${'P'.repeat(21)}Q`,
      mode: 'full-evidence', accepted: true,
    },
  });
  await tick();
  const confirmation = calls.filter(([name]) => name === 'dispatch').at(-1)[1];
  assert.deepEqual(confirmation.envelope, {
    type: 'CONFIRM_PIXEL_CAPTURE', sessionCapabilityId: 'S'.repeat(22),
    auditId: 'audit-paused', consentId: `${'P'.repeat(21)}Q`,
    mode: 'full-evidence', accepted: true, windowId: 9,
  });
  assert.equal(confirmation.sender, admission.syntheticSender);
  assert.equal(confirmation.launchTabId, 17);

  port.onDisconnect.emit();
  await tick();
  assert.deepEqual(calls.find(([name]) => name === 'retire')[1], admission);
});

test('rejects window claims and malformed or duplicate Port requests without dispatch', async () => {
  for (const hello of [
    { protocol: 'audita-panel', version: 1, type: 'bootstrap', windowId: 9 },
    { protocol: 'audita-panel', version: 1, type: 'bootstrap', extra: true },
  ]) {
    const { coordinator, calls, port } = fixture();
    coordinator.attachPanelPort(port);
    port.onMessage.emit(hello);
    await tick();
    assert.equal(port.disconnects, 1);
    assert.equal(calls.some(([name]) => name === 'admit'), false);
  }

  const { coordinator, calls, port } = fixture();
  coordinator.attachPanelPort(port);
  port.onMessage.emit({ protocol: 'audita-panel', version: 1, type: 'bootstrap' });
  await tick();
  const request = {
    protocol: 'audita-panel', version: 1, type: 'intent', requestId: 'duplicate-request',
    envelope: { type: 'PREPARE_PANEL_CAPABILITY', requestId: 'prepare-1' },
  };
  port.onMessage.emit(request);
  port.onMessage.emit(request);
  await tick();
  assert.equal(port.disconnects, 1);
  assert.equal(calls.filter(([name]) => name === 'dispatch').length <= 1, true);
});
