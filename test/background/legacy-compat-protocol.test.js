import assert from 'node:assert/strict';
import test from 'node:test';

import { createLegacyCompatibilityHandler, parseLegacyCompatMessage } from '../../src/background/legacy-compat-protocol.js';

const AUDIT_ID = 'audit-1';
const retained = [
  { type: 'GET_LAST_AUDIT' },
  { type: 'REVIEW_COMMITTED', auditId: AUDIT_ID, exportRevision: 2 },
  { type: 'REQUEST_DELETE_AUDIT', auditId: AUDIT_ID },
  { type: 'REQUEST_DELETE_ALL_AUDITS' },
];

test('retains only the four non-export compatibility messages as frozen copies', () => {
  for (const message of retained) {
    const parsed = parseLegacyCompatMessage(message);
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.value, message);
    assert.notStrictEqual(parsed.value, message);
    assert.equal(Object.isFrozen(parsed.value), true);
  }
});

test('removed export envelopes are unknown and their private fields are never inspected', () => {
  let reads = 0;
  for (const type of ['REQUEST_EXPORT', 'EXPORT_PROGRESS', 'EXPORT_FAILED', 'EXPORT_BUSY', 'EXPORT_INVALIDATED', 'EXPORT_COMPLETE']) {
    const message = { type };
    Object.defineProperty(message, 'auditId', { enumerable: true, get() { reads += 1; return AUDIT_ID; } });
    assert.deepEqual(parseLegacyCompatMessage(message), { ok: false, code: 'UNKNOWN_MESSAGE' });
  }
  assert.equal(reads, 0);
});

function fixture(path, query = '', contextType = 'TAB') {
  const url = `chrome-extension://test${path}${query}`;
  const calls = [];
  const chromeApi = { runtime: {
    id: 'test',
    async getContexts() {
      return [{ documentId: 'doc-1', documentUrl: url, contextType, windowId: 9,
        ...(contextType === 'TAB' ? { tabId: 70 } : {}) }];
    },
  } };
  const handler = createLegacyCompatibilityHandler({
    chromeApi,
    async readLegacyLastAudit() { calls.push('last'); return { ok: true, state: null }; },
    async notifyLegacyReviewCommitted() { calls.push('review'); return { ok: true }; },
    async deleteLegacyAudit({ auditId }) { calls.push(`delete:${auditId}`); return { ok: true, auditId, deleted: true }; },
    async deleteAllLegacyAudits() { calls.push('delete-all'); return { ok: true, deleted: 2 }; },
  });
  return { handler, calls, sender: { id: 'test', documentId: 'doc-1', url, frameId: 0 } };
}

test('dispatches retained messages only from their exact owned surfaces', async () => {
  const cases = [
    [retained[0], fixture('/src/panel/index.html', '', 'SIDE_PANEL'), 'last'],
    [retained[1], fixture('/src/review/index.html', `?auditId=${AUDIT_ID}`), 'review'],
    [retained[2], fixture('/src/review/index.html', `?auditId=${AUDIT_ID}`), `delete:${AUDIT_ID}`],
    [retained[3], fixture('/src/panel/index.html', '', 'SIDE_PANEL'), 'delete-all'],
  ];
  for (const [message, env, call] of cases) {
    const response = await env.handler.dispatch({ envelope: parseLegacyCompatMessage(message).value, sender: env.sender });
    assert.equal(response.ok, true);
    assert.deepEqual(env.calls, [call]);
  }
});

test('denies wrong query and subframes before adapter effects', async () => {
  const env = fixture('/src/review/index.html', '?auditId=foreign');
  const envelope = parseLegacyCompatMessage(retained[2]).value;
  assert.deepEqual(await env.handler.dispatch({ envelope, sender: env.sender }), { ok: false, code: 'COMPATIBILITY_DENIED' });
  env.sender.frameId = 1;
  assert.deepEqual(await env.handler.dispatch({ envelope, sender: env.sender }), { ok: false, code: 'COMPATIBILITY_DENIED' });
  assert.deepEqual(env.calls, []);
});
