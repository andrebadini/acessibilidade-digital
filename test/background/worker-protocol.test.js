import assert from 'node:assert/strict';
import test from 'node:test';

import { parseWorkerMessage } from '../../src/background/worker-protocol.js';

const CAPABILITY = '_1234567890123456789';
const SESSION = '-1234567890123456789';

const validMessages = [
  { type: 'PREPARE_PANEL_CAPABILITY', requestId: '_request', windowId: 9 },
  { type: 'PANEL_START_ATTACHED_AUDIT', capabilityId: CAPABILITY, captureMode: 'no-pixels', includeQuery: false, deleteAfterCompleteExport: false, windowId: 9 },
  { type: 'PANEL_CANCEL_AUDIT', sessionCapabilityId: SESSION, auditId: '-audit.1', windowId: 9 },
  { type: 'PANEL_OPEN_REPORT', sessionCapabilityId: SESSION, auditId: '_audit:1', windowId: 9 },
  { type: 'REPORT_REQUEST_EXPORT', sessionCapabilityId: SESSION, auditId: '1-audit' },
  { type: 'PANEL_REHYDRATE_VIEW', auditId: 'audit.1', windowId: 9 },
  { type: 'REPORT_CONNECT', auditId: 'audit_1' },
  { type: 'EXPORT_CONNECT', auditId: 'audit:1' },
];

test('copies and recursively freezes every exact primary envelope', () => {
  for (const message of validMessages) {
    const parsed = parseWorkerMessage(message);
    assert.equal(parsed.ok, true, message.type);
    assert.notEqual(parsed.value, message);
    assert.deepEqual(parsed.value, message);
    assert.equal(Object.isFrozen(parsed), true);
    assert.equal(Object.isFrozen(parsed.value), true);
  }
});

test('accepts the full external opaque and audit identifier alphabets without a letter prefix', () => {
  for (const capabilityId of ['01234567890123456789', '_1234567890123456789', '-1234567890123456789', 'A'.repeat(240)]) {
    assert.equal(parseWorkerMessage({
      type: 'PANEL_START_ATTACHED_AUDIT', capabilityId, captureMode: 'no-pixels',
      includeQuery: false, deleteAfterCompleteExport: false, windowId: 9,
    }).ok, true);
  }
  for (const auditId of ['0', '_', '-', '.audit', ':audit', 'A'.repeat(160)]) {
    assert.equal(parseWorkerMessage({ type: 'PANEL_REHYDRATE_VIEW', auditId, windowId: 9 }).ok, true, auditId);
  }
});

test('rejects wrong values and exact-key violations as recognized invalid messages', () => {
  const invalid = [
    { type: 'PREPARE_PANEL_CAPABILITY', requestId: 'a', windowId: 9, extra: true },
    { type: 'PANEL_START_ATTACHED_AUDIT', capabilityId: 'short', captureMode: 'no-pixels', includeQuery: false, deleteAfterCompleteExport: false, windowId: 9 },
    { type: 'PANEL_START_ATTACHED_AUDIT', capabilityId: CAPABILITY, captureMode: 'pixels', includeQuery: false, deleteAfterCompleteExport: false, windowId: 9 },
    { type: 'PANEL_START_ATTACHED_AUDIT', capabilityId: CAPABILITY, captureMode: 'no-pixels', includeQuery: true, deleteAfterCompleteExport: false, windowId: 9 },
    { type: 'PANEL_START_ATTACHED_AUDIT', capabilityId: CAPABILITY, captureMode: 'no-pixels', includeQuery: false, deleteAfterCompleteExport: true, windowId: 9 },
    { type: 'PANEL_CANCEL_AUDIT', sessionCapabilityId: SESSION, auditId: '', windowId: 9 },
    { type: 'PANEL_REHYDRATE_VIEW', auditId: 'space denied', windowId: 9 },
  ];
  for (const message of invalid) {
    assert.deepEqual(parseWorkerMessage(message), { ok: false, code: 'INVALID_MESSAGE' }, message.type);
  }
});

test('requires one safe data-only window claim on every panel envelope', () => {
  const base = { type: 'PREPARE_PANEL_CAPABILITY', requestId: 'request-1', windowId: 9 };
  const missing = { type: base.type, requestId: base.requestId };
  const extra = { ...base, secondWindowId: 11 };
  const negative = { ...base, windowId: -1 };
  const accessor = { type: base.type, requestId: base.requestId };
  let getterCalls = 0;
  Object.defineProperty(accessor, 'windowId', {
    enumerable: true,
    get() { getterCalls += 1; return 9; },
  });
  for (const message of [missing, extra, negative, accessor]) {
    assert.deepEqual(parseWorkerMessage(message), { ok: false, code: 'INVALID_MESSAGE' });
  }
  assert.equal(getterCalls, 0);
});

test('classifies inherited and non-enumerable types as unknown without reading other fields', () => {
  let secretReads = 0;
  const inherited = Object.create({ type: 'POPUP_START_AUDIT' });
  Object.defineProperty(inherited, 'secret', { enumerable: true, get() { secretReads += 1; return 'secret'; } });
  const nonEnumerable = {};
  Object.defineProperty(nonEnumerable, 'type', { value: 'POPUP_START_AUDIT', enumerable: false });
  Object.defineProperty(nonEnumerable, 'secret', { enumerable: true, get() { secretReads += 1; return 'secret'; } });
  assert.deepEqual(parseWorkerMessage(inherited), { ok: false, code: 'UNKNOWN_MESSAGE' });
  assert.deepEqual(parseWorkerMessage(nonEnumerable), { ok: false, code: 'UNKNOWN_MESSAGE' });
  assert.equal(secretReads, 0);
});

test('returns unknown immediately for removed popup URL batch and legacy start types without touching secrets', () => {
  let secretReads = 0;
  for (const type of [
    'PREPARE_POPUP_CAPABILITIES', 'POPUP_START_AUDIT', 'POPUP_START_PERSONA',
    'START_AUDIT', 'START_BATCH', 'CANCEL_AUDIT', 'PANEL_START_URL', 'SOME_UNKNOWN_TYPE',
  ]) {
    const message = { type };
    Object.defineProperty(message, 'url', { enumerable: true, get() { secretReads += 1; return 'https://secret.test/private'; } });
    Object.defineProperty(message, 'toJSON', { enumerable: true, get() { secretReads += 1; return () => 'secret'; } });
    assert.deepEqual(parseWorkerMessage(message), { ok: false, code: 'UNKNOWN_MESSAGE' }, type);
  }
  assert.equal(secretReads, 0);
});

test('rejects hostile recognized envelopes without invoking accessors', () => {
  let getterCalls = 0;
  const accessor = { type: 'PREPARE_PANEL_CAPABILITY', windowId: 9 };
  Object.defineProperty(accessor, 'requestId', { enumerable: true, get() { getterCalls += 1; return 'request-1'; } });
  const symbol = { type: 'PREPARE_PANEL_CAPABILITY', requestId: 'request-1', windowId: 9, [Symbol('secret')]: true };
  const hidden = { type: 'PREPARE_PANEL_CAPABILITY', requestId: 'request-1', windowId: 9 };
  Object.defineProperty(hidden, 'secret', { value: true, enumerable: false });
  const customPrototype = Object.assign(Object.create({ inherited: true }), { type: 'PREPARE_PANEL_CAPABILITY', requestId: 'request-1', windowId: 9 });
  for (const message of [accessor, symbol, hidden, customPrototype]) {
    assert.deepEqual(parseWorkerMessage(message), { ok: false, code: 'INVALID_MESSAGE' });
  }
  assert.equal(getterCalls, 0);
});

test('enforces the captured-envelope UTF-8 budget before value validation', () => {
  const parsed = parseWorkerMessage({ type: 'PANEL_REHYDRATE_VIEW', auditId: 'x'.repeat(5_000), windowId: 9 });
  assert.deepEqual(parsed, { ok: false, code: 'MESSAGE_TOO_LARGE' });
  const baseBytes = new TextEncoder().encode(JSON.stringify({ type: 'PANEL_REHYDRATE_VIEW', auditId: '', windowId: 9 })).byteLength;
  assert.deepEqual(parseWorkerMessage({ type: 'PANEL_REHYDRATE_VIEW', auditId: 'x'.repeat(4096 - baseBytes), windowId: 9 }), { ok: false, code: 'INVALID_MESSAGE' });
  assert.deepEqual(parseWorkerMessage({ type: 'PANEL_REHYDRATE_VIEW', auditId: 'x'.repeat(4097 - baseBytes), windowId: 9 }), { ok: false, code: 'MESSAGE_TOO_LARGE' });
});

test('is total for primitive array proxy and throwing-descriptor inputs', () => {
  const throwing = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('secret'); } });
  for (const value of [null, undefined, true, 'message', [], throwing]) {
    assert.doesNotThrow(() => parseWorkerMessage(value));
    assert.deepEqual(parseWorkerMessage(value), { ok: false, code: 'UNKNOWN_MESSAGE' });
  }
});
