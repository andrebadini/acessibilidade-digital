import assert from 'node:assert/strict';
import test from 'node:test';

import { createPopupAuditMessage, createPopupController } from '../../src/popup/popup-state.js';

const AUDIT_CAPABILITY = 'abcdefghijklmnopqrstuv';
const PERSONA_CAPABILITY = 'ABCDEFGHIJKLMNOPQRSTUV';

const response = (requestId, overrides = {}) => ({
  ok: true,
  requestId,
  auditCapabilityId: AUDIT_CAPABILITY,
  personaCapabilityId: PERSONA_CAPABILITY,
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
  assert.deepEqual(createPopupAuditMessage(AUDIT_CAPABILITY), {
    type: 'POPUP_START_AUDIT',
    capabilityId: AUDIT_CAPABILITY,
    captureMode: 'no-pixels',
    includeQuery: false,
    deleteAfterCompleteExport: false,
  });
});

test('accepts only the authority exact 22-character capability ID', async () => {
  for (const length of [20, 21, 23, 240, 256]) {
    const invalidId = 'A'.repeat(length);
    assert.throws(() => createPopupAuditMessage(invalidId), /Autorização local inválida\./u, `message ${length}`);

    for (const field of ['auditCapabilityId', 'personaCapabilityId']) {
      const item = fixture({
        prepare: message => Promise.resolve(response(message.requestId, { [field]: invalidId })),
      });
      assert.equal(await item.controller.prepareCapabilities(), false, `${field} ${length}`);
      assert.equal(item.controller.getState().auditReady, false, `${field} ${length} fechado`);
      const beforeClick = item.calls.length;
      assert.equal(await item.controller.handleAuditClick(), false, `${field} ${length} sem clique`);
      assert.equal(item.calls.length, beforeClick, `${field} ${length} sem API`);
    }
  }
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

test('rejects inherited, accessor, symbol, non-enumerable and extra preparation fields', async () => {
  const requestId = 'request-1234567890123456';
  const inherited = Object.create(response(requestId));
  const accessor = response(requestId);
  Object.defineProperty(accessor, 'auditCapabilityId', {
    enumerable: true,
    get() { throw new Error('private accessor detail'); },
  });
  const symbol = response(requestId);
  symbol[Symbol('private')] = 'private symbol detail';
  const nonEnumerable = response(requestId);
  Object.defineProperty(nonEnumerable, 'personaCapabilityId', {
    value: PERSONA_CAPABILITY,
    enumerable: false,
  });
  const extra = response(requestId, { privateField: 'private response detail' });

  for (const [name, hostile] of Object.entries({ inherited, accessor, symbol, nonEnumerable, extra })) {
    const item = fixture({ prepare: () => Promise.resolve(hostile) });
    assert.equal(await item.controller.prepareCapabilities(), false, name);
    assert.deepEqual(item.controller.getState(), {
      auditReady: false,
      otherReady: false,
      preparing: false,
      inFlight: false,
      message: 'Não foi possível preparar as ações locais.',
    }, name);
  }
});

test('contains hostile ownKeys and descriptor proxies and always settles preparation closed', async () => {
  const requestId = 'request-1234567890123456';
  const hostileResponses = [
    new Proxy(response(requestId), {
      ownKeys() { throw new Error('private ownKeys detail'); },
    }),
    new Proxy(response(requestId), {
      getOwnPropertyDescriptor() { throw new Error('private descriptor detail'); },
    }),
  ];
  for (const hostile of hostileResponses) {
    const item = fixture({ prepare: () => Promise.resolve(hostile) });
    let result;
    await assert.doesNotReject(async () => { result = await item.controller.prepareCapabilities(); });
    assert.equal(result, false);
    assert.deepEqual(item.controller.getState(), {
      auditReady: false,
      otherReady: false,
      preparing: false,
      inFlight: false,
      message: 'Não foi possível preparar as ações locais.',
    });
  }
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
        auditCapabilityId: 'BBBBBBBBBBBBBBBBBBBBBB',
        personaCapabilityId: 'PPPPPPPPPPPPPPPPPPPPPP',
        windowId: 22,
      }));
    },
  });
  const first = item.controller.prepareCapabilities();
  await item.controller.prepareCapabilities();
  resolveFirst(response('request-first-1234567890', {
    auditCapabilityId: 'AAAAAAAAAAAAAAAAAAAAAA',
    personaCapabilityId: 'OOOOOOOOOOOOOOOOOOOOOO',
    windowId: 11,
  }));
  await first;
  await item.controller.handleAuditClick();
  assert.deepEqual(item.calls.slice(-2), [
    { type: 'sidePanel.open', value: { windowId: 22 } },
    { type: 'runtime.sendMessage', value: {
      type: 'POPUP_START_AUDIT', capabilityId: 'BBBBBBBBBBBBBBBBBBBBBB',
      captureMode: 'no-pixels', includeQuery: false, deleteAfterCompleteExport: false,
    } },
  ]);
});

test('keeps snapshot B ready when preparation B finishes while snapshot A is opening', async () => {
  let finishFirstOpen;
  const calls = [];
  const requestIds = ['request-snapshot-A-1234', 'request-snapshot-B-1234'];
  let preparation = 0;
  let opens = 0;
  const controller = createPopupController({
    now: () => 1_000,
    createRequestId: () => requestIds.shift(),
    onStateChange() {},
    sidePanelOpen(value) {
      calls.push({ type: 'sidePanel.open', value });
      opens += 1;
      return opens === 1 ? new Promise(resolve => { finishFirstOpen = resolve; }) : Promise.resolve();
    },
    sendMessage(message) {
      calls.push({ type: 'runtime.sendMessage', value: structuredClone(message) });
      if (message.type === 'PREPARE_POPUP_CAPABILITIES') {
        preparation += 1;
        return Promise.resolve(response(message.requestId, preparation === 1 ? {
          auditCapabilityId: 'AAAAAAAAAAAAAAAAAAAAAA',
          personaCapabilityId: 'OOOOOOOOOOOOOOOOOOOOOO',
          windowId: 11,
        } : {
          auditCapabilityId: 'BBBBBBBBBBBBBBBBBBBBBB',
          personaCapabilityId: 'PPPPPPPPPPPPPPPPPPPPPP',
          windowId: 22,
        }));
      }
      return Promise.resolve({ ok: true });
    },
  });
  await controller.prepareCapabilities();
  const clickA = controller.handleAuditClick();
  await controller.prepareCapabilities();
  finishFirstOpen();
  assert.equal(await clickA, true);
  assert.equal(controller.getState().auditReady, true);
  assert.equal(await controller.handleAuditClick(), true);
  assert.deepEqual(calls.filter(call => call.value?.type === 'POPUP_START_AUDIT').map(call => call.value.capabilityId), [
    'AAAAAAAAAAAAAAAAAAAAAA',
    'BBBBBBBBBBBBBBBBBBBBBB',
  ]);
});

test('keeps snapshot B ready when snapshot A start is rejected or throws', async () => {
  for (const outcome of ['rejected', 'throw']) {
    let settleStartA;
    let preparation = 0;
    let start = 0;
    const requestIds = [`request-${outcome}-A-1234`, `request-${outcome}-B-1234`];
    const calls = [];
    const controller = createPopupController({
      now: () => 1_000,
      createRequestId: () => requestIds.shift(),
      onStateChange() {},
      sidePanelOpen(value) {
        calls.push({ type: 'sidePanel.open', value });
        return Promise.resolve();
      },
      sendMessage(message) {
        calls.push({ type: 'runtime.sendMessage', value: structuredClone(message) });
        if (message.type === 'PREPARE_POPUP_CAPABILITIES') {
          preparation += 1;
          return Promise.resolve(response(message.requestId, preparation === 1 ? {
            auditCapabilityId: 'AAAAAAAAAAAAAAAAAAAAAA',
            personaCapabilityId: 'OOOOOOOOOOOOOOOOOOOOOO',
            windowId: 11,
          } : {
            auditCapabilityId: 'BBBBBBBBBBBBBBBBBBBBBB',
            personaCapabilityId: 'PPPPPPPPPPPPPPPPPPPPPP',
            windowId: 22,
          }));
        }
        start += 1;
        if (start === 1) return new Promise((resolve, reject) => { settleStartA = outcome === 'throw' ? reject : resolve; });
        return Promise.resolve({ ok: true });
      },
    });
    await controller.prepareCapabilities();
    const clickA = controller.handleAuditClick();
    await Promise.resolve();
    await controller.prepareCapabilities();
    settleStartA(outcome === 'throw' ? new Error('private start detail') : { ok: false });
    assert.equal(await clickA, false, outcome);
    assert.equal(controller.getState().auditReady, true, `${outcome} preserves B`);
    assert.equal(await controller.handleAuditClick(), true, `${outcome} uses B`);
    assert.deepEqual(calls.filter(call => call.value?.type === 'POPUP_START_AUDIT').map(call => call.value.capabilityId), [
      'AAAAAAAAAAAAAAAAAAAAAA',
      'BBBBBBBBBBBBBBBBBBBBBB',
    ], outcome);
  }
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
