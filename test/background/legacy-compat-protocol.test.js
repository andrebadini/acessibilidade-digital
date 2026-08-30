import assert from 'node:assert/strict';
import test from 'node:test';

import { createLegacyCompatibilityHandler, parseLegacyCompatMessage } from '../../src/background/legacy-compat-protocol.js';

const AUDIT_ID = '-audit.1';
const OWNER_ID = '_owner.123456789012345';
const exactMessages = [
  { type: 'GET_LAST_AUDIT' },
  { type: 'REVIEW_COMMITTED', auditId: AUDIT_ID, exportRevision: 0 },
  { type: 'REQUEST_EXPORT', auditId: AUDIT_ID },
  { type: 'REQUEST_DELETE_AUDIT', auditId: AUDIT_ID },
  { type: 'REQUEST_DELETE_ALL_AUDITS' },
  { type: 'EXPORT_PROGRESS', auditId: AUDIT_ID, status: 'running', message: 'Gerando.', exportRevision: 1, exportAttempt: 2, leaseOwnerId: OWNER_ID },
  { type: 'EXPORT_FAILED', auditId: AUDIT_ID, status: 'failed', error: 'Falhou.', exportRevision: 1, exportAttempt: 2, leaseOwnerId: OWNER_ID },
  { type: 'EXPORT_BUSY', auditId: AUDIT_ID, status: 'busy', error: 'Ocupado.', exportRevision: 1, exportAttempt: 2, leaseOwnerId: OWNER_ID },
  { type: 'EXPORT_INVALIDATED', auditId: AUDIT_ID, status: 'preparing', error: 'Obsoleto.', exportRevision: 1, exportAttempt: 2, leaseOwnerId: OWNER_ID },
  { type: 'EXPORT_COMPLETE', auditId: AUDIT_ID, status: 'complete', formats: ['html', 'json', 'csv', 'pdf'], exportRevision: 1, exportAttempt: 2, leaseOwnerId: OWNER_ID, localAuditDeleted: true },
];

test('parses fresh recursively frozen copies of the exact ten compatibility schemas', () => {
  for (const message of exactMessages) {
    const parsed = parseLegacyCompatMessage(message);
    assert.equal(parsed.ok, true, message.type);
    assert.notEqual(parsed.value, message);
    assert.deepEqual(parsed.value, message);
    assert.equal(Object.isFrozen(parsed), true);
    assert.equal(Object.isFrozen(parsed.value), true);
    if (Array.isArray(message.formats)) {
      assert.notEqual(parsed.value.formats, message.formats);
      assert.equal(Object.isFrozen(parsed.value.formats), true);
    }
  }
});

test('enforces exact compatibility correlations formats and scalar bounds', () => {
  const invalid = [
    { type: 'GET_LAST_AUDIT', extra: true },
    { type: 'REVIEW_COMMITTED', auditId: '', exportRevision: 0 },
    { type: 'REVIEW_COMMITTED', auditId: AUDIT_ID, exportRevision: -1 },
    { type: 'EXPORT_PROGRESS', auditId: AUDIT_ID, status: 'running', message: '', exportRevision: 1, exportAttempt: 2, leaseOwnerId: OWNER_ID },
    { type: 'EXPORT_FAILED', auditId: AUDIT_ID, status: 'busy', error: 'Falhou.', exportRevision: 1, exportAttempt: 2, leaseOwnerId: OWNER_ID },
    { type: 'EXPORT_BUSY', auditId: AUDIT_ID, status: 'busy', error: 'O'.repeat(513), exportRevision: 1, exportAttempt: 2, leaseOwnerId: OWNER_ID },
    { type: 'EXPORT_INVALIDATED', auditId: AUDIT_ID, status: 'preparing', error: 'Obsoleto.', exportRevision: 1, exportAttempt: 0, leaseOwnerId: OWNER_ID },
    { type: 'EXPORT_COMPLETE', auditId: AUDIT_ID, status: 'complete', formats: ['html', 'json'], exportRevision: 1, exportAttempt: 2, leaseOwnerId: OWNER_ID, localAuditDeleted: false },
    { type: 'EXPORT_COMPLETE', auditId: AUDIT_ID, status: 'partial', formats: ['html', 'json', 'pdf'], exportRevision: 1, exportAttempt: 2, leaseOwnerId: OWNER_ID, localAuditDeleted: true },
    { type: 'EXPORT_COMPLETE', auditId: AUDIT_ID, status: 'partial', formats: ['json', 'html'], exportRevision: 1, exportAttempt: 2, leaseOwnerId: OWNER_ID, localAuditDeleted: false },
  ];
  for (const message of invalid) {
    assert.deepEqual(parseLegacyCompatMessage(message), { ok: false, code: 'COMPATIBILITY_DENIED' }, message.type);
  }
  for (const formats of [['html', 'json'], ['html', 'json', 'csv'], ['html', 'json', 'pdf'], ['html', 'json', 'csv', 'pdf']]) {
    assert.equal(parseLegacyCompatMessage({
      type: 'EXPORT_COMPLETE', auditId: AUDIT_ID, status: 'partial', formats,
      exportRevision: 1, exportAttempt: 2, leaseOwnerId: OWNER_ID, localAuditDeleted: false,
    }).ok, true);
  }
});

test('classifies unknown and removed start types without inspecting or serializing secrets', () => {
  let secretReads = 0;
  for (const type of ['START_AUDIT', 'START_BATCH', 'CANCEL_AUDIT', 'PANEL_START_URL', 'UNKNOWN']) {
    const message = { type };
    Object.defineProperty(message, 'url', { enumerable: true, get() { secretReads += 1; return 'https://secret.test/private'; } });
    Object.defineProperty(message, 'toJSON', { enumerable: true, get() { secretReads += 1; return () => 'secret'; } });
    assert.deepEqual(parseLegacyCompatMessage(message), { ok: false, code: 'UNKNOWN_MESSAGE' });
  }
  assert.equal(secretReads, 0);
});

test('denies hostile recognized compatibility shapes without invoking getters', () => {
  let getterCalls = 0;
  const accessor = { type: 'REQUEST_EXPORT' };
  Object.defineProperty(accessor, 'auditId', { enumerable: true, get() { getterCalls += 1; return AUDIT_ID; } });
  const symbol = { type: 'REQUEST_EXPORT', auditId: AUDIT_ID, [Symbol('secret')]: true };
  const hidden = { type: 'REQUEST_EXPORT', auditId: AUDIT_ID };
  Object.defineProperty(hidden, 'secret', { enumerable: false, value: true });
  const customPrototype = Object.assign(Object.create({ inherited: true }), { type: 'REQUEST_EXPORT', auditId: AUDIT_ID });
  for (const message of [accessor, symbol, hidden, customPrototype]) {
    assert.deepEqual(parseLegacyCompatMessage(message), { ok: false, code: 'COMPATIBILITY_DENIED' });
  }
  assert.equal(getterCalls, 0);
});

function senderFixture(path, query = '', contextType = 'TAB') {
  const url = `chrome-extension://test${path}${query}`;
  const sender = { id: 'test', documentId: 'sender-document', url, frameId: 0 };
  const chromeApi = { runtime: { id: 'test', async getContexts(request) {
    assert.deepEqual(request, { documentIds: ['sender-document'] });
    return [{ documentId: 'sender-document', documentUrl: url, contextType, windowId: 9, ...(contextType === 'TAB' ? { tabId: 70 } : {}) }];
  } } };
  return { sender, chromeApi };
}

function adapters(overrides = {}) {
  return {
    readLegacyLastAudit: async () => ({ ok: true, state: null }),
    notifyLegacyReviewCommitted: async () => ({ ok: true }),
    queueLegacyExport: async ({ auditId }) => ({ ok: true, auditId, state: 'queued', exportRevision: 3, exportAttempt: 4, leaseOwnerId: OWNER_ID }),
    deleteLegacyAudit: async ({ auditId }) => ({ ok: true, auditId, deleted: true }),
    deleteAllLegacyAudits: async () => ({ ok: true, deleted: 2 }),
    acknowledgeLegacyExportEvent: async () => ({ ok: true }),
    ...overrides,
  };
}

function createHandler(message, surface, overrides = {}) {
  const { sender, chromeApi } = surface;
  const calls = [];
  const wrapped = {};
  for (const [name, adapter] of Object.entries(adapters(overrides))) {
    wrapped[name] = async input => { calls.push({ name, input }); return adapter(input); };
  }
  const handler = createLegacyCompatibilityHandler({ chromeApi, ...wrapped });
  const envelope = parseLegacyCompatMessage(message).value;
  return { handler, envelope, sender, calls };
}

test('validates the exact compatibility factory and returns only a frozen dispatch method', () => {
  const { chromeApi } = senderFixture('/src/panel/index.html', '', 'SIDE_PANEL');
  const handler = createLegacyCompatibilityHandler({ chromeApi, ...adapters() });
  assert.deepEqual(Object.keys(handler), ['dispatch']);
  assert.equal(Object.isFrozen(handler), true);
  assert.throws(() => createLegacyCompatibilityHandler({ chromeApi, ...adapters(), extra: true }), /COMPATIBILITY_HANDLER_INVALID/u);
  assert.throws(() => createLegacyCompatibilityHandler({ chromeApi, ...adapters({ queueLegacyExport: null }) }), /COMPATIBILITY_HANDLER_INVALID/u);
});

test('dispatches each schema only after exact surface proof and passes no sender or URL to adapters', async () => {
  const rows = [
    [exactMessages[0], senderFixture('/src/panel/index.html', '', 'SIDE_PANEL'), 'readLegacyLastAudit', undefined],
    [exactMessages[1], senderFixture('/src/review/index.html', `?auditId=${AUDIT_ID}`), 'notifyLegacyReviewCommitted', { auditId: AUDIT_ID, exportRevision: 0 }],
    [exactMessages[2], senderFixture('/src/review/index.html', `?auditId=${AUDIT_ID}`), 'queueLegacyExport', { auditId: AUDIT_ID }],
    [exactMessages[3], senderFixture('/src/review/index.html', `?auditId=${AUDIT_ID}`), 'deleteLegacyAudit', { auditId: AUDIT_ID }],
    [exactMessages[4], senderFixture('/src/panel/index.html', '', 'SIDE_PANEL'), 'deleteAllLegacyAudits', undefined],
    [exactMessages[5], senderFixture('/src/export/index.html', `?auditId=${AUDIT_ID}&leaseOwnerId=${OWNER_ID}&exportAttempt=2`), 'acknowledgeLegacyExportEvent', { event: exactMessages[5] }],
  ];
  for (const [message, surface, adapterName, expectedInput] of rows) {
    const { handler, envelope, sender, calls } = createHandler(message, surface);
    const response = await handler.dispatch({ envelope, sender });
    assert.equal(response.ok, true, message.type);
    assert.equal(Object.isFrozen(response), true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, adapterName);
    assert.deepEqual(calls[0].input, expectedInput);
    if (calls[0].input?.event) {
      assert.notEqual(calls[0].input.event, message);
      assert.equal(Object.isFrozen(calls[0].input.event), true);
    }
  }
});

test('denies wrong path query context and subframes before adapter effects', async () => {
  const message = { type: 'REQUEST_EXPORT', auditId: AUDIT_ID };
  const surfaces = [
    senderFixture('/src/panel/index.html', '', 'SIDE_PANEL'),
    senderFixture('/src/review/index.html', '?auditId=other'),
    senderFixture('/src/review/index.html', `?auditId=${AUDIT_ID}&extra=1`),
    senderFixture('/src/review/index.html', `?auditId=${AUDIT_ID}`),
  ];
  surfaces[3].sender.frameId = 1;
  for (const surface of surfaces) {
    const { handler, envelope, sender, calls } = createHandler(message, surface);
    assert.deepEqual(await handler.dispatch({ envelope, sender }), { ok: false, code: 'COMPATIBILITY_DENIED' });
    assert.equal(calls.length, 0);
  }
});

test('denies hostile runtime context arrays without invoking accessors or adapters', async () => {
  const surface = senderFixture('/src/review/index.html', `?auditId=${AUDIT_ID}`);
  let getterCalls = 0;
  surface.chromeApi.runtime.getContexts = async () => {
    const contexts = [];
    Object.defineProperty(contexts, '0', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return { documentId: 'sender-document', documentUrl: surface.sender.url, contextType: 'TAB', windowId: 9, tabId: 70 };
      },
    });
    contexts.length = 1;
    return contexts;
  };
  const { handler, envelope, sender, calls } = createHandler({ type: 'REQUEST_EXPORT', auditId: AUDIT_ID }, surface);
  assert.deepEqual(await handler.dispatch({ envelope, sender }), { ok: false, code: 'COMPATIBILITY_DENIED' });
  assert.equal(getterCalls, 0);
  assert.equal(calls.length, 0);

  const customSurface = senderFixture('/src/review/index.html', `?auditId=${AUDIT_ID}`);
  customSurface.chromeApi.runtime.getContexts = async () => [Object.assign(Object.create({ inherited: true }), {
    documentId: 'sender-document', documentUrl: customSurface.sender.url, contextType: 'TAB', windowId: 9, tabId: 70,
  })];
  const custom = createHandler({ type: 'REQUEST_EXPORT', auditId: AUDIT_ID }, customSurface);
  assert.deepEqual(await custom.handler.dispatch({ envelope: custom.envelope, sender: custom.sender }), { ok: false, code: 'COMPATIBILITY_DENIED' });
  assert.equal(custom.calls.length, 0);
});

test('normalizes adapter throws invalid outputs and native text to fixed compatibility failure', async () => {
  const message = { type: 'REQUEST_EXPORT', auditId: AUDIT_ID };
  const surface = senderFixture('/src/review/index.html', `?auditId=${AUDIT_ID}`);
  for (const queueLegacyExport of [
    async () => { throw new Error('native secret'); },
    async () => ({ ok: false, error: 'native secret' }),
    async () => ({ ok: true, auditId: 'other', state: 'queued', exportRevision: 1, exportAttempt: 1, leaseOwnerId: OWNER_ID }),
  ]) {
    const { handler, envelope, sender } = createHandler(message, surface, { queueLegacyExport });
    assert.deepEqual(await handler.dispatch({ envelope, sender }), { ok: false, code: 'COMPATIBILITY_FAILED' });
  }
});

test('copies and freezes every closed request-export response member', async () => {
  const queueResponses = [
    { ok: true, auditId: AUDIT_ID, state: 'queued', exportRevision: 3, exportAttempt: 4, leaseOwnerId: OWNER_ID },
    { ok: false, auditId: AUDIT_ID, state: 'busy', code: 'EXPORT_BUSY', retryable: true, retryAt: null },
    { ok: false, auditId: AUDIT_ID, state: 'stale', code: 'AUDIT_REVISION_CONFLICT', retryable: true, retryAt: null },
    { ok: false, auditId: AUDIT_ID, state: 'failed', code: 'EXPORT_PREPARE_FAILED', retryable: true, retryAt: '2026-08-29T12:00:00.000Z' },
  ];
  for (const adapterResponse of queueResponses) {
    const surface = senderFixture('/src/review/index.html', `?auditId=${AUDIT_ID}`);
    const { handler, envelope, sender } = createHandler({ type: 'REQUEST_EXPORT', auditId: AUDIT_ID }, surface, {
      queueLegacyExport: async () => adapterResponse,
    });
    const response = await handler.dispatch({ envelope, sender });
    assert.deepEqual(response, adapterResponse);
    assert.notEqual(response, adapterResponse);
    assert.equal(Object.isFrozen(response), true);
  }
});

test('validates and copies only the closed legacy latest projection', async () => {
  const state = {
    auditId: AUDIT_ID, mode: 'batch', status: 'complete', percent: 100, message: 'Concluida.',
    reviewUrl: `chrome-extension://test/src/review/index.html?auditId=${AUDIT_ID}`,
    exportStatus: 'complete', exportRevision: 3, exportAttempt: 4, leaseOwnerId: OWNER_ID,
    total: 2, pageNumber: 2,
    statusCounts: { cancelled: 0, complete: 2, failed: 0, partial: 0 },
  };
  const surface = senderFixture('/src/panel/index.html', '', 'SIDE_PANEL');
  const { handler, envelope, sender } = createHandler({ type: 'GET_LAST_AUDIT' }, surface, {
    readLegacyLastAudit: async () => ({ ok: true, state }),
  });
  const response = await handler.dispatch({ envelope, sender });
  assert.deepEqual(response, { ok: true, state });
  assert.notEqual(response.state, state);
  assert.notEqual(response.state.statusCounts, state.statusCounts);
  assert.equal(Object.isFrozen(response.state), true);
  assert.equal(Object.isFrozen(response.state.statusCounts), true);
});

test('projects canonical Task 5, export and batch latest rows without internal store fields', async () => {
  const rows = [
    [{
      version: 1, auditId: 'audit-running', status: 'running', percent: 0,
      message: 'Preparando a auditoria.', failureCode: null, modelRevision: null,
      updatedAt: '2026-08-29T12:00:00.000Z',
    }, {
      auditId: 'audit-running', status: 'running', percent: 0,
      message: 'Preparando a auditoria.',
    }],
    [{
      auditId: 'audit-export', status: 'complete', exportStatus: 'queued',
      exportRevision: 3, exportAttempt: 2, leaseOwnerId: OWNER_ID,
      exportQueuedAt: '2026-08-29T12:00:00.000Z',
      deliveryReceipt: { status: 'pending', formats: [], limitations: [] },
    }, {
      auditId: 'audit-export', status: 'complete', exportStatus: 'queued',
      exportRevision: 3, exportAttempt: 2, leaseOwnerId: OWNER_ID,
    }],
    [{
      auditId: 'audit-batch', mode: 'batch', status: 'partial', total: 3, pageNumber: 2,
      statusCounts: { cancelled: 0, complete: 1, failed: 1, partial: 1 },
      pages: [{ privateUrl: 'https://secret.test/' }],
    }, {
      auditId: 'audit-batch', mode: 'batch', status: 'partial', total: 3, pageNumber: 2,
      statusCounts: { cancelled: 0, complete: 1, failed: 1, partial: 1 },
    }],
  ];
  for (const [state, projected] of rows) {
    const surface = senderFixture('/src/panel/index.html', '', 'SIDE_PANEL');
    const { handler, envelope, sender } = createHandler({ type: 'GET_LAST_AUDIT' }, surface, {
      readLegacyLastAudit: async () => ({ ok: true, state }),
    });
    assert.deepEqual(await handler.dispatch({ envelope, sender }), { ok: true, state: projected });
  }
});

test('omits invalid optional latest fields independently without invoking getters', async () => {
  let getterCalls = 0;
  const state = {
    auditId: AUDIT_ID, status: 'complete', mode: 'url', percent: Number.POSITIVE_INFINITY,
    reviewUrl: 'https://secret.test/private', exportStatus: 'unknown', exportRevision: -1,
    exportAttempt: 0, leaseOwnerId: 'owner with spaces', total: 99, pageNumber: 100,
    statusCounts: { cancelled: 0, complete: 99, failed: 0, partial: 0 },
  };
  Object.defineProperty(state, 'message', {
    enumerable: true,
    get() { getterCalls += 1; return 'native secret'; },
  });
  Object.defineProperty(state, 'privateBearer', {
    enumerable: true,
    get() { getterCalls += 1; return 'S'.repeat(22); },
  });
  const surface = senderFixture('/src/panel/index.html', '', 'SIDE_PANEL');
  const { handler, envelope, sender } = createHandler({ type: 'GET_LAST_AUDIT' }, surface, {
    readLegacyLastAudit: async () => ({ ok: true, state }),
  });
  assert.deepEqual(await handler.dispatch({ envelope, sender }), {
    ok: true, state: { auditId: AUDIT_ID, status: 'complete' },
  });
  assert.equal(getterCalls, 0);
});

test('returns null for invalid required latest data and fixed failure for hostile roots', async () => {
  const surface = senderFixture('/src/panel/index.html', '', 'SIDE_PANEL');
  for (const state of [
    42,
    [],
    Object.assign(Object.create({ inherited: true }), { auditId: AUDIT_ID, status: 'complete' }),
    { auditId: '', status: 'complete', secret: 'raw store data' },
    { auditId: AUDIT_ID, status: 'unknown' },
  ]) {
    const { handler, envelope, sender } = createHandler({ type: 'GET_LAST_AUDIT' }, surface, {
      readLegacyLastAudit: async () => ({ ok: true, state }),
    });
    assert.deepEqual(await handler.dispatch({ envelope, sender }), { ok: true, state: null });
  }
  const hostile = new Proxy({}, {
    getPrototypeOf() { throw new Error('native proxy secret'); },
  });
  const proxied = createHandler({ type: 'GET_LAST_AUDIT' }, surface, {
    readLegacyLastAudit: async () => ({ ok: true, state: hostile }),
  });
  const fixed = await proxied.handler.dispatch({ envelope: proxied.envelope, sender: proxied.sender });
  assert.deepEqual(fixed, { ok: false, code: 'COMPATIBILITY_FAILED' });
  assert.doesNotMatch(JSON.stringify(fixed), /native|proxy|secret/u);

  const { handler, sender } = createHandler({ type: 'GET_LAST_AUDIT' }, surface);
  assert.deepEqual(await handler.dispatch({ envelope: { type: 'GET_LAST_AUDIT' }, sender }), { ok: false, code: 'COMPATIBILITY_DENIED' });
});
