import assert from 'node:assert/strict';
import test from 'node:test';

import { createHighlightSessionAuthorityBridge } from '../../src/background/highlight-session-authority.js';

const SESSION = 'S'.repeat(22);

test('normalizes a worker-owned panel sender token without exposing or accepting a UI window claim', async () => {
  const calls = [];
  const authority = {
    async authorizeSession(input) {
      calls.push(input);
      return { ok: true, session: { auditId: input.auditId, state: 'result' } };
    },
  };
  const bridge = createHighlightSessionAuthorityBridge({ authority, reportLaunch: { async authorizeIntent() { throw new Error('wrong lane'); } } });
  const sender = Object.freeze({ id: 'extension-id', url: 'chrome-extension://extension-id/src/panel/index.html?launch=opaque' });
  const trustedSender = bridge.createPanelSender({ sender, windowId: 9 });

  assert.deepEqual(Object.keys(trustedSender), []);
  assert.equal(Object.isFrozen(trustedSender), true);
  assert.equal(Object.hasOwn(trustedSender, 'windowId'), false);
  assert.equal(Object.hasOwn(trustedSender, 'sender'), false);

  const result = await bridge.sessionAuthority.authorizeSession({
    sessionCapabilityId: SESSION,
    auditId: 'audit-1',
    intent: 'highlight',
    sender: trustedSender,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [{
    sessionCapabilityId: SESSION,
    auditId: 'audit-1',
    consumer: 'panel',
    intent: 'highlight',
    sender,
    claimedWindowId: 9,
  }]);
});

test('normalizes a worker-owned review token through the report capability without adding a claimed window', async () => {
  const calls = [];
  const authority = { async authorizeSession() { throw new Error('wrong lane'); } };
  const reportLaunch = {
    async authorizeIntent(input) {
      calls.push(input);
      return { ok: true, auditId: input.auditId, sessionCapabilityId: input.sessionCapabilityId, intent: 'highlight', windowId: 9 };
    },
  };
  const bridge = createHighlightSessionAuthorityBridge({ authority, reportLaunch });
  const sender = Object.freeze({ id: 'extension-id', documentId: 'review-document' });
  const trustedSender = bridge.createReviewSender({ sender });
  const result = await bridge.sessionAuthority.authorizeSession({
    sessionCapabilityId: SESSION,
    auditId: 'audit-1',
    intent: 'highlight',
    sender: trustedSender,
  });
  assert.deepEqual(result, { ok: true, session: { auditId: 'audit-1', state: 'result' } });
  assert.deepEqual(calls, [{
    sessionCapabilityId: SESSION,
    auditId: 'audit-1',
    intent: 'highlight',
    sender,
  }]);
});

test('rejects transplanted report audit or capability correlations after report authorization', async () => {
  const bridge = createHighlightSessionAuthorityBridge({
    authority: { async authorizeSession() { throw new Error('wrong lane'); } },
    reportLaunch: {
      async authorizeIntent(input) {
        return { ok: true, auditId: 'another-audit', sessionCapabilityId: input.sessionCapabilityId, intent: input.intent, windowId: 9 };
      },
    },
  });
  const token = bridge.createReviewSender({ sender: Object.freeze({ id: 'extension-id', documentId: 'review-document' }) });
  assert.deepEqual(await bridge.sessionAuthority.authorizeSession({
    sessionCapabilityId: SESSION, auditId: 'audit-1', intent: 'highlight', sender: token,
  }), { ok: false, code: 'SESSION_INTENT_DENIED' });
});

test('fails closed for forged, reused incorrectly, accessor-backed or extra-field requests', async () => {
  let calls = 0;
  const bridge = createHighlightSessionAuthorityBridge({
    authority: { async authorizeSession() { calls += 1; return { ok: true }; } },
    reportLaunch: { async authorizeIntent() { calls += 1; return { ok: true }; } },
  });
  const sender = Object.freeze({ id: 'extension-id' });
  const panel = bridge.createPanelSender({ sender, windowId: 0 });
  const base = { sessionCapabilityId: SESSION, auditId: 'audit-1', intent: 'highlight', sender: panel };

  assert.deepEqual(await bridge.sessionAuthority.authorizeSession({ ...base, windowId: 0 }), {
    ok: false, code: 'SESSION_INTENT_DENIED',
  });
  assert.deepEqual(await bridge.sessionAuthority.authorizeSession({ ...base, sender: Object.freeze({}) }), {
    ok: false, code: 'SESSION_INTENT_DENIED',
  });
  const hostile = {};
  Object.defineProperty(hostile, 'sender', { enumerable: true, get() { throw new Error('private getter'); } });
  assert.deepEqual(await bridge.createPanelSender(hostile), { ok: false, code: 'SESSION_INTENT_DENIED' });
  assert.equal(calls, 0);
});

test('rejects malformed factories and invalid internal context creation', () => {
  assert.throws(() => createHighlightSessionAuthorityBridge(), /HIGHLIGHT_SESSION_AUTHORITY_INVALID/u);
  assert.throws(() => createHighlightSessionAuthorityBridge({ authority: { authorizeSession: true } }), /HIGHLIGHT_SESSION_AUTHORITY_INVALID/u);
  assert.throws(() => createHighlightSessionAuthorityBridge({
    authority: { async authorizeSession() {} }, reportLaunch: { authorizeIntent: true },
  }), /HIGHLIGHT_SESSION_AUTHORITY_INVALID/u);
  const bridge = createHighlightSessionAuthorityBridge({
    authority: { async authorizeSession() {} }, reportLaunch: { async authorizeIntent() {} },
  });
  assert.deepEqual(bridge.createPanelSender({ sender: null, windowId: 1 }), { ok: false, code: 'SESSION_INTENT_DENIED' });
  assert.deepEqual(bridge.createPanelSender({ sender: {}, windowId: -1 }), { ok: false, code: 'SESSION_INTENT_DENIED' });
  assert.deepEqual(bridge.createReviewSender({ sender: null }), { ok: false, code: 'SESSION_INTENT_DENIED' });
});
