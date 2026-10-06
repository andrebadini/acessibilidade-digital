import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isPanelPortIntent,
  parsePanelPortIntent,
  parseWorkerMessage,
} from '../../src/background/worker-protocol.js';

const CAPABILITY = '_1234567890123456789';
const SESSION = '-1234567890123456789';
const LEASE = 'lease-1234567890123456789012';
const CONSENT = `${'C'.repeat(21)}Q`;

const markerEnvelope = (type, extra = {}) => ({
  type, auditId: 'audit-markers', sessionCapabilityId: SESSION,
  modelRevision: 1, ...extra,
});

test('page-marker intents are panel-only and acquire the admitted window, never a client window', () => {
  for (const intent of [
    markerEnvelope('PANEL_SHOW_PAGE_MARKERS'),
    markerEnvelope('PANEL_HIDE_PAGE_MARKERS'),
    markerEnvelope('PANEL_SELECT_PAGE_MARKER', { ordinal: 63, scroll: false }),
    markerEnvelope('PANEL_FILTER_PAGE_MARKERS', { visibleOrdinals: '0,2,63' }),
  ]) {
    assert.equal(isPanelPortIntent(intent), true, intent.type);
    assert.deepEqual(parsePanelPortIntent(intent, 9), { ok: true, value: { ...intent, windowId: 9 } });
    assert.equal(parsePanelPortIntent({ ...intent, windowId: 9 }, 9).ok, false);
    assert.equal(parseWorkerMessage({ ...intent, windowId: 9 }).ok, true);
    assert.equal(parseWorkerMessage(intent).ok, false);
  }
});

test('page-marker revision, ordinal and filter boundaries are closed and canonical', () => {
  const parse = intent => parsePanelPortIntent(intent, 9).ok;
  for (const revision of [0, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(parse(markerEnvelope('PANEL_SHOW_PAGE_MARKERS', { modelRevision: revision })), false);
  }
  for (const ordinal of [-1, 64, 0.5, '0', null]) {
    assert.equal(parse(markerEnvelope('PANEL_SELECT_PAGE_MARKER', { ordinal, scroll: false })), false);
  }
  assert.equal(parse(markerEnvelope('PANEL_SELECT_PAGE_MARKER', { ordinal: 0, scroll: true })), true);
  assert.equal(parse(markerEnvelope('PANEL_SELECT_PAGE_MARKER', { ordinal: 0, scroll: 1 })), false);
  for (const visibleOrdinals of ['', '0', '0,9,10,63', Array.from({ length: 64 }, (_, i) => i).join(',')]) {
    assert.equal(parse(markerEnvelope('PANEL_FILTER_PAGE_MARKERS', { visibleOrdinals })), true);
  }
  for (const visibleOrdinals of ['00', '1,0', '0,0', '64', '-1', '0,', ' 0', '0, 1', [0]]) {
    assert.equal(parse(markerEnvelope('PANEL_FILTER_PAGE_MARKERS', { visibleOrdinals })), false);
  }
});

test('page-marker protocol rejects extra authority and accessor fields without reading them', () => {
  const intent = markerEnvelope('PANEL_SHOW_PAGE_MARKERS');
  for (const extra of [{ tabId: 7 }, { documentId: 'document-a' }, { installationId: 'a'.repeat(22) }, { ordinal: 0 }]) {
    assert.equal(parsePanelPortIntent({ ...intent, ...extra }, 9).ok, false);
  }
  let reads = 0;
  Object.defineProperty(intent, 'modelRevision', { enumerable: true, get() { reads += 1; return 1; } });
  assert.equal(parsePanelPortIntent(intent, 9).ok, false);
  assert.equal(reads, 0);
});

test('report export accepts only an optional boolean deletion preference and copies it without accessors', () => {
  const base = { type: 'REPORT_REQUEST_EXPORT', sessionCapabilityId: SESSION, auditId: 'audit-1' };
  for (const value of [true, false]) assert.deepEqual(parseWorkerMessage({ ...base, deleteAfterCompleteExport: value }),
    { ok: true, value: { ...base, deleteAfterCompleteExport: value } });
  for (const value of ['true', 1, null, undefined]) assert.equal(
    parseWorkerMessage({ ...base, deleteAfterCompleteExport: value }).ok, false);
  const accessor = { ...base };
  Object.defineProperty(accessor, 'deleteAfterCompleteExport', { enumerable: true, get() { throw new Error('must not read'); } });
  assert.equal(parseWorkerMessage(accessor).ok, false);
});

const validMessages = [
  { type: 'PREPARE_PANEL_CAPABILITY', requestId: '_request', windowId: 9 },
  { type: 'PREPARE_PANEL_NAVIGATION_CAPABILITY', requestId: '_navigation', intent: 'single', windowId: 9 },
  { type: 'PREPARE_PANEL_NAVIGATION_CAPABILITY', requestId: '_batch', intent: 'batch', windowId: 9 },
  { type: 'PREPARE_PANEL_PERSONA_CAPABILITY', requestId: '_persona', windowId: 9 },
  { type: 'PANEL_START_ATTACHED_AUDIT', capabilityId: CAPABILITY, captureMode: 'no-pixels', includeQuery: false, deleteAfterCompleteExport: false, windowId: 9 },
  { type: 'PANEL_START_ATTACHED_AUDIT', capabilityId: CAPABILITY, captureMode: 'full-evidence', includeQuery: false, deleteAfterCompleteExport: false, windowId: 9 },
  { type: 'PANEL_START_ATTACHED_AUDIT', capabilityId: CAPABILITY, captureMode: 'element-only', includeQuery: false, deleteAfterCompleteExport: false, windowId: 9 },
  {
    type: 'PANEL_START_URL_AUDIT', capabilityId: CAPABILITY,
    url: 'https://example.test/private?token=raw', captureMode: 'no-pixels',
    includeQuery: false, deleteAfterCompleteExport: false, windowId: 9,
  },
  {
    type: 'PANEL_START_URL_AUDIT', capabilityId: CAPABILITY,
    url: 'https://example.test/private?token=raw', captureMode: 'full-evidence',
    includeQuery: false, deleteAfterCompleteExport: false, windowId: 9,
  },
  {
    type: 'PANEL_START_URL_AUDIT', capabilityId: CAPABILITY,
    url: 'https://example.test/private?token=raw', captureMode: 'element-only',
    includeQuery: false, deleteAfterCompleteExport: false, windowId: 9,
  },
  {
    type: 'PANEL_START_BATCH_AUDIT', capabilityId: CAPABILITY,
    urls: 'https://one.example.test/private?token=raw\nhttps://two.example.test/',
    captureMode: 'no-pixels', includeQuery: false,
    deleteAfterCompleteExport: false, windowId: 9,
  },
  {
    type: 'PANEL_START_BATCH_AUDIT', capabilityId: CAPABILITY,
    urls: 'https://one.example.test/private?token=raw\nhttps://two.example.test/',
    captureMode: 'full-evidence', includeQuery: false,
    deleteAfterCompleteExport: false, windowId: 9,
  },
  {
    type: 'PANEL_START_BATCH_AUDIT', capabilityId: CAPABILITY,
    urls: 'https://one.example.test/private?token=raw\nhttps://two.example.test/',
    captureMode: 'element-only', includeQuery: false,
    deleteAfterCompleteExport: false, windowId: 9,
  },
  { type: 'CONFIRM_PIXEL_CAPTURE', sessionCapabilityId: SESSION, auditId: '-audit.1', consentId: CONSENT, mode: 'full-evidence', accepted: true, windowId: 9 },
  { type: 'PANEL_CONFIRM_PIXEL_CAPTURE', sessionCapabilityId: SESSION, auditId: '-audit.1', mode: 'element-only', accepted: true, windowId: 9 },
  { type: 'PANEL_START_PERSONA', capabilityId: CAPABILITY, mode: 'reader', windowId: 9 },
  { type: 'PANEL_REHYDRATE_PERSONA', capabilityId: CAPABILITY, windowId: 9 },
  { type: 'PANEL_SET_PERSONA_MODE', leaseId: LEASE, mode: 'motor', windowId: 9 },
  { type: 'PANEL_READER_STATE', leaseId: LEASE, windowId: 9 },
  { type: 'PANEL_READER_ACTION', leaseId: LEASE, action: 'next', windowId: 9 },
  { type: 'PANEL_READER_ENABLE_VOICE', leaseId: LEASE, windowId: 9 },
  { type: 'PANEL_STOP_PERSONA', leaseId: LEASE, windowId: 9 },
  { type: 'PANEL_CANCEL_AUDIT', sessionCapabilityId: SESSION, auditId: '-audit.1', windowId: 9 },
  { type: 'PANEL_OPEN_REPORT', sessionCapabilityId: SESSION, auditId: '_audit:1', windowId: 9 },
  { type: 'REPORT_REQUEST_EXPORT', sessionCapabilityId: SESSION, auditId: '1-audit' },
  { type: 'REPORT_RETURN_TO_SOURCE', sessionCapabilityId: SESSION, auditId: '1-audit' },
  {
    type: 'REPORT_COMMIT_REVIEW_DECISION', sessionCapabilityId: SESSION, auditId: '1-audit',
    itemId: '5.2.1', occurrenceId: 'occurrence-1', answer: 'não conforme', evaluator: 'Pessoa avaliadora',
    decidedAt: '2026-08-30T12:00:00.000Z', mode: 'manual', note: '',
  },
  { type: 'REPORT_DELETE_AUDIT', sessionCapabilityId: SESSION, auditId: '1-audit' },
  { type: 'REPORT_DELETE_ALL_AUDITS', sessionCapabilityId: SESSION, auditId: '1-audit' },
  { type: 'GET_HIGHLIGHT_STATE', sessionCapabilityId: SESSION, auditId: '1-audit' },
  { type: 'GET_HIGHLIGHT_AVAILABILITY', sessionCapabilityId: SESSION, auditId: '1-audit', occurrenceId: 'occurrence-1' },
  { type: 'HIGHLIGHT_OCCURRENCE', sessionCapabilityId: SESSION, auditId: '1-audit', occurrenceId: 'occurrence-1' },
  { type: 'CLEAR_HIGHLIGHT', sessionCapabilityId: SESSION, auditId: '1-audit' },
  { type: 'AUDITA_HIGHLIGHT_INVALIDATED', nonce: 'N'.repeat(22) },
  { type: 'AUDITA_PERSONA_AUTONOMOUS_STOP', leaseId: LEASE, reason: 'emergency-stop' },
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

test('rejects numeric coercion for every identifier while keeping windowId numeric', () => {
  const twentyDigitNumber = Number('12345678901234567890');
  const numericIdentifiers = [
    { type: 'PREPARE_PANEL_CAPABILITY', requestId: 1, windowId: 9 },
    {
      type: 'PANEL_START_ATTACHED_AUDIT', capabilityId: twentyDigitNumber,
      captureMode: 'no-pixels', includeQuery: false, deleteAfterCompleteExport: false, windowId: 9,
    },
    { type: 'PANEL_CANCEL_AUDIT', sessionCapabilityId: twentyDigitNumber, auditId: 'audit-1', windowId: 9 },
    { type: 'PANEL_CANCEL_AUDIT', sessionCapabilityId: SESSION, auditId: 1, windowId: 9 },
    { type: 'PANEL_OPEN_REPORT', sessionCapabilityId: twentyDigitNumber, auditId: 'audit-1', windowId: 9 },
    { type: 'PANEL_OPEN_REPORT', sessionCapabilityId: SESSION, auditId: 1, windowId: 9 },
    { type: 'REPORT_REQUEST_EXPORT', sessionCapabilityId: twentyDigitNumber, auditId: 'audit-1' },
    { type: 'REPORT_REQUEST_EXPORT', sessionCapabilityId: SESSION, auditId: 1 },
    {
      type: 'REPORT_COMMIT_REVIEW_DECISION', sessionCapabilityId: twentyDigitNumber, auditId: 'audit-1',
      itemId: '5.2.1', occurrenceId: 'occurrence-1', answer: 'conforme', evaluator: 'Pessoa avaliadora',
      decidedAt: '2026-08-30T12:00:00.000Z', mode: 'manual', note: '',
    },
    { type: 'REPORT_DELETE_AUDIT', sessionCapabilityId: twentyDigitNumber, auditId: 'audit-1' },
    { type: 'REPORT_DELETE_ALL_AUDITS', sessionCapabilityId: SESSION, auditId: 1 },
    { type: 'PANEL_REHYDRATE_VIEW', auditId: 1, windowId: 9 },
    { type: 'REPORT_CONNECT', auditId: 1 },
    { type: 'EXPORT_CONNECT', auditId: 1 },
    { type: 'EXPORT_COMPLETE', sessionCapabilityId: twentyDigitNumber, auditId: 'audit-1', attemptId: '1' },
    { type: 'EXPORT_COMPLETE', sessionCapabilityId: SESSION, auditId: 1, attemptId: '1' },
    { type: 'EXPORT_COMPLETE', sessionCapabilityId: SESSION, auditId: 'audit-1', attemptId: 1 },
  ];

  for (const message of numericIdentifiers) {
    assert.deepEqual(parseWorkerMessage(message), { ok: false, code: 'INVALID_MESSAGE' }, message.type);
  }
  assert.equal(parseWorkerMessage({
    type: 'EXPORT_COMPLETE', sessionCapabilityId: SESSION, auditId: 'audit-1', attemptId: '1',
  }).ok, true);
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

test('accepts the bounded review decision envelope and rejects legacy, malformed and oversized mutations', () => {
  const base = {
    type: 'REPORT_COMMIT_REVIEW_DECISION', sessionCapabilityId: SESSION, auditId: 'audit-1',
    itemId: '5.2.1', occurrenceId: 'occurrence-1', answer: 'conforme', evaluator: 'Pessoa avaliadora',
    decidedAt: '2026-08-30T12:00:00.000Z', mode: 'assisted', note: '',
  };
  assert.equal(parseWorkerMessage({ ...base, note: '📝'.repeat(4_000) }).ok, true);
  for (const message of [
    { type: 'REPORT_REVIEW_COMMITTED', sessionCapabilityId: SESSION, auditId: 'audit-1', exportRevision: 2 },
    { ...base, note: '📝'.repeat(4_001) },
    { ...base, evaluator: ' ' },
    { ...base, evaluator: 'a'.repeat(161) },
    { ...base, itemId: '../forged' },
    { ...base, occurrenceId: 'x'.repeat(201) },
    { ...base, answer: 'talvez' },
    { ...base, decidedAt: '2026-08-30' },
    { ...base, mode: 'automatic' },
    { ...base, note: 1 },
  ]) assert.equal(parseWorkerMessage(message).ok, false, JSON.stringify(message).slice(0, 160));
  assert.deepEqual(parseWorkerMessage({ ...base, note: 'a'.repeat(30_000) }), { ok: false, code: 'MESSAGE_TOO_LARGE' });
});

test('requires one safe data-only window claim on every panel envelope', () => {
  const base = { type: 'PREPARE_PANEL_CAPABILITY', requestId: 'request-1', windowId: 9 };
  const missing = { type: base.type, requestId: base.requestId };
  const extra = { ...base, secondWindowId: 11 };
  const negative = { ...base, windowId: -1 };
  const stringWindow = { ...base, windowId: '9' };
  const accessor = { type: base.type, requestId: base.requestId };
  let getterCalls = 0;
  Object.defineProperty(accessor, 'windowId', {
    enumerable: true,
    get() { getterCalls += 1; return 9; },
  });
  for (const message of [missing, extra, negative, stringWindow, accessor]) {
    assert.deepEqual(parseWorkerMessage(message), { ok: false, code: 'INVALID_MESSAGE' });
  }
  assert.equal(getterCalls, 0);
});

test('adds the admitted window only at the panel Port boundary and rejects every non-panel lane', () => {
  for (const message of validMessages.filter(value => value.type.startsWith('PANEL_') || value.type.startsWith('PREPARE_PANEL_'))) {
    const { windowId: _removed, ...withoutWindow } = message;
    const parsed = parsePanelPortIntent(withoutWindow, 9);
    assert.equal(parsed.ok, true, message.type);
    assert.deepEqual(parsed.value, message);
    assert.equal(Object.isFrozen(parsed.value), true);
    assert.deepEqual(parsePanelPortIntent(message, 9), { ok: false, code: 'INVALID_MESSAGE' });
  }
  assert.deepEqual(parsePanelPortIntent({ type: 'REPORT_CONNECT', auditId: 'audit-1' }, 9), {
    ok: false, code: 'INVALID_MESSAGE',
  });
  assert.deepEqual(parsePanelPortIntent({ type: 'PREPARE_PANEL_CAPABILITY', requestId: 'request-1' }, -1), {
    ok: false, code: 'INVALID_MESSAGE',
  });

  let reads = 0;
  const hostile = { type: 'PREPARE_PANEL_CAPABILITY' };
  Object.defineProperty(hostile, 'requestId', {
    enumerable: true,
    get() { reads += 1; return 'request-1'; },
  });
  assert.deepEqual(parsePanelPortIntent(hostile, 9), { ok: false, code: 'INVALID_MESSAGE' });
  assert.equal(reads, 0);
});

test('admits each bounded single-URL capture mode through its exact panel Port envelopes', () => {
  const prepare = { type: 'PREPARE_PANEL_NAVIGATION_CAPABILITY', requestId: 'url-request-1', intent: 'single' };
  assert.deepEqual(parsePanelPortIntent(prepare, 17), {
    ok: true, value: { ...prepare, windowId: 17 },
  });
  for (const captureMode of ['full-evidence', 'element-only', 'no-pixels']) {
    const start = {
      type: 'PANEL_START_URL_AUDIT', capabilityId: CAPABILITY,
      url: 'https://example.test/private?token=raw', captureMode,
      includeQuery: false, deleteAfterCompleteExport: false,
    };
    assert.deepEqual(parsePanelPortIntent(start, 17), {
      ok: true, value: { ...start, windowId: 17 },
    });
    assert.equal(isPanelPortIntent(start), true);
  }

  const start = {
    type: 'PANEL_START_URL_AUDIT', capabilityId: CAPABILITY,
    url: 'https://example.test/private?token=raw', captureMode: 'no-pixels',
    includeQuery: false, deleteAfterCompleteExport: false,
  };

  for (const invalid of [
    { ...prepare, intent: 'crawler' },
    { ...prepare, url: 'https://forged.test/' },
    { ...start, captureMode: 'pixels' },
    { ...start, includeQuery: true },
    { ...start, deleteAfterCompleteExport: true },
    { ...start, url: '' },
    { ...start, url: 'x'.repeat(2_049) },
    { ...start, url: 'https://example.test/', ownershipId: 'forged-owner' },
  ]) assert.deepEqual(parsePanelPortIntent(invalid, 17), { ok: false, code: 'INVALID_MESSAGE' });
});

test('admits every explicit evidence mode for a bounded batch through the panel Port', () => {
  const prepare = { type: 'PREPARE_PANEL_NAVIGATION_CAPABILITY', requestId: 'batch-request-1', intent: 'batch' };
  assert.deepEqual(parsePanelPortIntent(prepare, 17), {
    ok: true, value: { ...prepare, windowId: 17 },
  });
  const start = {
    type: 'PANEL_START_BATCH_AUDIT', capabilityId: CAPABILITY,
    urls: 'https://one.example.test/private?token=raw\nhttps://two.example.test/',
    captureMode: 'no-pixels', includeQuery: false, deleteAfterCompleteExport: false,
  };
  for (const captureMode of ['full-evidence', 'element-only', 'no-pixels']) {
    const modeStart = { ...start, captureMode };
    assert.deepEqual(parsePanelPortIntent(modeStart, 17), {
      ok: true, value: { ...modeStart, windowId: 17 },
    });
    assert.equal(isPanelPortIntent(modeStart), true);
  }

  for (const invalid of [
    { ...start, captureMode: 'pixels' },
    { ...start, includeQuery: true },
    { ...start, deleteAfterCompleteExport: true },
    { ...start, urls: '' },
    { ...start, urls: 'x'.repeat(41_001) },
    { ...start, queueId: 'forged' },
  ]) assert.deepEqual(parsePanelPortIntent(invalid, 17), { ok: false, code: 'INVALID_MESSAGE' });
});

test('admits confirmation only through the panel Port and injects its bound window', () => {
  const clientIntent = {
    type: 'CONFIRM_PIXEL_CAPTURE', sessionCapabilityId: SESSION, auditId: 'audit-1',
    consentId: CONSENT, mode: 'element-only', accepted: true,
  };
  const internal = { ...clientIntent, windowId: 9 };

  assert.equal(isPanelPortIntent(clientIntent), true);
  assert.deepEqual(parsePanelPortIntent(clientIntent, 9), { ok: true, value: internal });
  assert.deepEqual(parseWorkerMessage(internal), { ok: true, value: internal });
  assert.deepEqual(parseWorkerMessage(clientIntent), { ok: false, code: 'INVALID_MESSAGE' });
  assert.deepEqual(parsePanelPortIntent(internal, 9), { ok: false, code: 'INVALID_MESSAGE' });
});

test('admits an owned confirmation only through the panel Port without any private identifier', () => {
  const clientIntent = {
    type: 'PANEL_CONFIRM_PIXEL_CAPTURE', sessionCapabilityId: SESSION,
    auditId: 'audit-1', mode: 'element-only', accepted: true,
  };
  const internal = { ...clientIntent, windowId: 9 };

  assert.equal(isPanelPortIntent(clientIntent), true);
  assert.deepEqual(parsePanelPortIntent(clientIntent, 9), { ok: true, value: internal });
  assert.deepEqual(parseWorkerMessage(internal), { ok: true, value: internal });
  assert.deepEqual(parseWorkerMessage(clientIntent), { ok: false, code: 'INVALID_MESSAGE' });
  assert.deepEqual(parsePanelPortIntent(internal, 9), { ok: false, code: 'INVALID_MESSAGE' });
  assert.doesNotMatch(JSON.stringify(internal), /consent|ownership|digest|documentId|tabId/iu);

  for (const invalid of [
    { ...clientIntent, accepted: false },
    { ...clientIntent, mode: 'no-pixels' },
    { ...clientIntent, consentId: CONSENT },
    { ...clientIntent, ownershipId: 'owner_forged' },
  ]) assert.deepEqual(parsePanelPortIntent(invalid, 9), { ok: false, code: 'INVALID_MESSAGE' });
});

test('rejects non-canonical or hostile pixel confirmations without invoking accessors', () => {
  const base = {
    type: 'CONFIRM_PIXEL_CAPTURE', sessionCapabilityId: SESSION, auditId: 'audit-1',
    consentId: CONSENT, mode: 'full-evidence', accepted: true,
  };
  let getterCalls = 0;
  const accessor = { ...base };
  Object.defineProperty(accessor, 'consentId', {
    enumerable: true,
    get() { getterCalls += 1; return CONSENT; },
  });
  const customPrototype = Object.assign(Object.create({ inherited: true }), base);
  for (const intent of [
    { ...base, accepted: false },
    { ...base, mode: 'no-pixels' },
    { ...base, mode: 'pixels' },
    { ...base, consentId: `${'C'.repeat(21)}B` },
    { ...base, consentId: 'C'.repeat(21) },
    { ...base, consentId: 'C'.repeat(23) },
    { ...base, tabId: 17 },
    { ...base, [Symbol('private')]: true },
    accessor,
    customPrototype,
  ]) {
    assert.deepEqual(parsePanelPortIntent(intent, 9), { ok: false, code: 'INVALID_MESSAGE' });
  }
  assert.equal(getterCalls, 0);
});

test('admits shared highlight intents through the panel Port without adding or accepting a UI window claim', () => {
  for (const message of validMessages.filter(value => [
    'GET_HIGHLIGHT_STATE', 'GET_HIGHLIGHT_AVAILABILITY', 'HIGHLIGHT_OCCURRENCE', 'CLEAR_HIGHLIGHT',
  ].includes(value.type))) {
    const parsed = parsePanelPortIntent(message, 9);
    assert.equal(parsed.ok, true, message.type);
    assert.deepEqual(parsed.value, message);
    assert.equal(Object.hasOwn(parsed.value, 'windowId'), false);
    assert.deepEqual(parsePanelPortIntent({ ...message, windowId: 9 }, 9), {
      ok: false, code: 'INVALID_MESSAGE',
    });
  }
  assert.deepEqual(parseWorkerMessage({
    type: 'HIGHLIGHT_OCCURRENCE', sessionCapabilityId: SESSION, auditId: 'audit-1',
    occurrenceId: 'occ-1', selector: '#forged',
  }), { ok: false, code: 'INVALID_MESSAGE' });
});

test('admits only the exact opaque content invalidation notice outside the panel Port lane', () => {
  const message = { type: 'AUDITA_HIGHLIGHT_INVALIDATED', nonce: 'N'.repeat(22) };
  assert.deepEqual(parseWorkerMessage(message), { ok: true, value: message });
  for (const invalid of [
    { ...message, nonce: 'short' },
    { ...message, nonce: 'N'.repeat(22), auditId: 'forged-audit' },
    { ...message, nonce: 'N'.repeat(22), tabId: 7 },
  ]) assert.deepEqual(parseWorkerMessage(invalid), { ok: false, code: 'INVALID_MESSAGE' });
  assert.deepEqual(parsePanelPortIntent(message, 9), { ok: false, code: 'INVALID_MESSAGE' });
});

test('admits only a minimal exact persona shutdown correlation outside the panel Port lane', () => {
  for (const reason of ['emergency-stop', 'lifecycle-stop', 'reader-terminal']) {
    const message = { type: 'AUDITA_PERSONA_AUTONOMOUS_STOP', leaseId: LEASE, reason };
    assert.deepEqual(parseWorkerMessage(message), { ok: true, value: message });
    assert.deepEqual(parsePanelPortIntent(message, 9), { ok: false, code: 'INVALID_MESSAGE' });
  }
  for (const invalid of [
    { type: 'AUDITA_PERSONA_AUTONOMOUS_STOP', leaseId: 'short', reason: 'emergency-stop' },
    { type: 'AUDITA_PERSONA_AUTONOMOUS_STOP', leaseId: LEASE, reason: 'page-text' },
    { type: 'AUDITA_PERSONA_AUTONOMOUS_STOP', leaseId: LEASE, reason: 'lifecycle-stop', url: 'https://private.test/' },
    { type: 'AUDITA_PERSONA_AUTONOMOUS_STOP', leaseId: LEASE, reason: 'reader-terminal', selector: '#private' },
  ]) assert.deepEqual(parseWorkerMessage(invalid), { ok: false, code: 'INVALID_MESSAGE' });
});

test('persona envelopes reject target coordinates modes outside the closed union and extra fields', () => {
  for (const message of [
    { type: 'PANEL_START_PERSONA', capabilityId: CAPABILITY, mode: 'reader', windowId: 9, tabId: 17 },
    { type: 'PANEL_START_PERSONA', capabilityId: CAPABILITY, mode: 'visual', windowId: 9 },
    { type: 'PANEL_REHYDRATE_PERSONA', capabilityId: CAPABILITY, windowId: 9, documentId: 'forged' },
    { type: 'PANEL_SET_PERSONA_MODE', leaseId: LEASE, mode: 'motor', windowId: 9, selector: '#forged' },
    { type: 'PANEL_SET_PERSONA_MODE', leaseId: LEASE, mode: 'reader', windowId: -1 },
    { type: 'PANEL_READER_STATE', leaseId: LEASE, windowId: 9, caption: 'forjada' },
    { type: 'PANEL_READER_ACTION', leaseId: LEASE, action: 'clear', windowId: 9 },
    { type: 'PANEL_READER_ACTION', leaseId: LEASE, action: 'next', windowId: 9, documentId: 'forged' },
    { type: 'PANEL_READER_ENABLE_VOICE', leaseId: LEASE, windowId: 9, explicitUserGesture: true },
    { type: 'PANEL_STOP_PERSONA', leaseId: LEASE, windowId: 9, explicitActionAt: 1 },
  ]) assert.deepEqual(parseWorkerMessage(message), { ok: false, code: 'INVALID_MESSAGE' });
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

test('guided review: "não se aplica", an explicit revise flag and the bounded page aids', () => {
  const base = {
    type: 'REPORT_COMMIT_REVIEW_DECISION', sessionCapabilityId: SESSION, auditId: 'audit-1',
    itemId: '5.2.6', occurrenceId: 'occurrence-1', answer: 'não se aplica', evaluator: 'Pessoa avaliadora',
    decidedAt: '2026-08-30T12:00:00.000Z', mode: 'assisted', note: '',
  };
  assert.equal(parseWorkerMessage(base).ok, true);
  assert.equal(parseWorkerMessage({ ...base, revise: true }).ok, true);
  assert.equal(parseWorkerMessage({ ...base, revise: false }).ok, false, 'revise só existe como pedido explícito');
  assert.equal(parseWorkerMessage({ ...base, revise: 'true' }).ok, false);
  assert.equal(parseWorkerMessage({ ...base, answer: 'talvez' }).ok, false);
  for (const aid of ['zoom-200', 'reflow-320', 'text-spacing', 'reset']) {
    assert.equal(parseWorkerMessage({ type: 'REPORT_PAGE_AID', sessionCapabilityId: SESSION, auditId: 'audit-1', aid }).ok, true, aid);
  }
  for (const message of [
    { type: 'REPORT_PAGE_AID', sessionCapabilityId: SESSION, auditId: 'audit-1', aid: 'inject-script' },
    { type: 'REPORT_PAGE_AID', sessionCapabilityId: SESSION, auditId: 'audit-1', aid: 'zoom-200', css: '*{}' },
    { type: 'REPORT_PAGE_AID', sessionCapabilityId: 'curto', auditId: 'audit-1', aid: 'reset' },
  ]) assert.equal(parseWorkerMessage(message).ok, false, JSON.stringify(message));
});
