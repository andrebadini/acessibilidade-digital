import assert from 'node:assert/strict';
import test from 'node:test';

import { createPopupAuditMessage, createPopupController } from '../../src/popup/popup-state.js';

const response = (requestId, overrides = {}) => ({
  ok: true,
  requestId,
  auditCapabilityId: 'audit-capability-1234567890',
  personaCapabilityId: 'persona-capability-12345678',
  windowId: 17,
  expiresAt: 2_000,
  ...overrides,
});

function fixture(options = {}) {
  let currentTime = options.now ?? 1_000;
  const calls = [];
  const states = [];
  const requestIds = [...(options.requestIds ?? ['request-1234567890123456'])];
  const controller = createPopupController({
    now: () => currentTime,
    createRequestId: () => requestIds.shift(),
    onStateChange: state => states.push(structuredClone(state)),
    sidePanelOpen(value) {
      calls.push({ type: 'sidePanel.open', value });
      if (options.openResult === 'reject') return Promise.reject(new Error('private native detail'));
      return Promise.resolve();
    },
    sendMessage(message) {
      calls.push({ type: 'runtime.sendMessage', value: structuredClone(message) });
      if (message.type === 'PREPARE_POPUP_CAPABILITIES') {
        return options.prepare?.(message) ?? Promise.resolve(response(message.requestId));
      }
      return Promise.resolve(options.startResponse ?? { ok: true });
    },
  });
  return {
    controller, calls, states,
    setNow(value) { currentTime = value; },
  };
}

test('creates the exact no-pixels audit envelope', () => {
  assert.deepEqual(createPopupAuditMessage('audit-capability-1234567890'), {
    type: 'POPUP_START_AUDIT',
    capabilityId: 'audit-capability-1234567890',
    captureMode: 'no-pixels',
    includeQuery: false,
    deleteAfterCompleteExport: false,
  });
});

test('stays closed until an exact matching preparation response arrives', async () => {
  const invalidCases = [
    { ok: true },
    response('wrong-request-1234567890'),
    response('request-1234567890123456', { extra: true }),
    response('request-1234567890123456', { auditCapabilityId: 'short' }),
    response('request-1234567890123456', { windowId: -1 }),
    response('request-1234567890123456', { expiresAt: 1_000 }),
  ];
  for (const [index, invalid] of invalidCases.entries()) {
    const item = fixture({ prepare: () => Promise.resolve(invalid) });
    await item.controller.prepareCapabilities();
    assert.equal(item.controller.getState().auditReady, false, `caso inválido ${index}`);
    const beforeClick = item.calls.length;
    await item.controller.handleAuditClick();
    assert.equal(item.calls.length, beforeClick, `caso inválido ${index} não chama API no clique`);
  }

  const valid = fixture();
  await valid.controller.prepareCapabilities();
  assert.deepEqual(valid.controller.getState(), {
    auditReady: true,
    otherReady: true,
    preparing: false,
    inFlight: false,
    message: '',
  });
});

test('expires the prepared snapshot closed before opening the side panel', async () => {
  const item = fixture();
  await item.controller.prepareCapabilities();
  item.setNow(2_000);
  assert.equal(item.controller.refreshValidity(), true);
  assert.equal(item.controller.getState().auditReady, false);
  const beforeClick = item.calls.length;
  await item.controller.handleAuditClick();
  assert.equal(item.calls.length, beforeClick);
});

test('never lets a stale preparation response replace a newer snapshot', async () => {
  let resolveFirst;
  const item = fixture({
    requestIds: ['request-first-1234567890', 'request-second-123456789'],
    prepare(message) {
      if (message.requestId.startsWith('request-first')) {
        return new Promise(resolve => { resolveFirst = resolve; });
      }
      return Promise.resolve(response(message.requestId, {
        auditCapabilityId: 'audit-capability-new-123456',
        personaCapabilityId: 'persona-capability-new-1234',
        windowId: 22,
      }));
    },
  });
  const first = item.controller.prepareCapabilities();
  await item.controller.prepareCapabilities();
  resolveFirst(response('request-first-1234567890', {
    auditCapabilityId: 'audit-capability-old-123456',
    personaCapabilityId: 'persona-capability-old-1234',
    windowId: 11,
  }));
  await first;
  await item.controller.handleAuditClick();
  assert.deepEqual(item.calls.slice(-2), [
    { type: 'sidePanel.open', value: { windowId: 22 } },
    { type: 'runtime.sendMessage', value: {
      type: 'POPUP_START_AUDIT', capabilityId: 'audit-capability-new-123456',
      captureMode: 'no-pixels', includeQuery: false, deleteAfterCompleteExport: false,
    } },
  ]);
});

test('opens the side panel first and never starts when opening fails', async () => {
  const ok = fixture();
  await ok.controller.prepareCapabilities();
  ok.calls.length = 0;
  await ok.controller.handleAuditClick();
  assert.deepEqual(ok.calls.map(call => call.type), ['sidePanel.open', 'runtime.sendMessage']);

  const failed = fixture({ openResult: 'reject' });
  await failed.controller.prepareCapabilities();
  failed.calls.length = 0;
  await failed.controller.handleAuditClick();
  assert.deepEqual(failed.calls.map(call => call.type), ['sidePanel.open']);
  assert.equal(failed.controller.getState().message, 'Não foi possível abrir o painel lateral.');
});

test('fails closed with a fixed message when the worker rejects the prepared start', async () => {
  const item = fixture({ startResponse: { ok: false, error: 'private worker detail' } });
  await item.controller.prepareCapabilities();
  item.calls.length = 0;
  await item.controller.handleAuditClick();
  assert.deepEqual(item.calls.map(call => call.type), ['sidePanel.open', 'runtime.sendMessage']);
  assert.equal(item.controller.getState().message, 'Não foi possível iniciar a auditoria local.');
  assert.equal(item.controller.getState().auditReady, false);
});

test('disables re-entry while an audit click is in flight', async () => {
  let finishOpen;
  const item = fixture();
  item.controller = createPopupController({
    now: () => 1_000,
    createRequestId: () => 'request-double-1234567890',
    onStateChange() {},
    sidePanelOpen(value) {
      item.calls.push({ type: 'sidePanel.open', value });
      return new Promise(resolve => { finishOpen = resolve; });
    },
    sendMessage(message) {
      item.calls.push({ type: 'runtime.sendMessage', value: structuredClone(message) });
      return Promise.resolve(message.type === 'PREPARE_POPUP_CAPABILITIES'
        ? response(message.requestId)
        : { ok: true });
    },
  });
  await item.controller.prepareCapabilities();
  item.calls.length = 0;
  const first = item.controller.handleAuditClick();
  const second = item.controller.handleAuditClick();
  assert.equal(item.controller.getState().inFlight, true);
  assert.deepEqual(item.calls.map(call => call.type), ['sidePanel.open']);
  finishOpen();
  await Promise.all([first, second]);
  assert.deepEqual(item.calls.map(call => call.type), ['sidePanel.open', 'runtime.sendMessage']);
});

test('opens the initial panel for another URL or batch without sending a start envelope', async () => {
  const item = fixture();
  await item.controller.prepareCapabilities();
  item.calls.length = 0;
  await item.controller.handleOtherClick();
  assert.deepEqual(item.calls, [{ type: 'sidePanel.open', value: { windowId: 17 } }]);
});
