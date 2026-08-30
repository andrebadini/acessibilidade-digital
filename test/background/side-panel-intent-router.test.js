import assert from 'node:assert/strict';
import test from 'node:test';

import { createSidePanelIntentRouter } from '../../src/background/side-panel-intent-router.js';
import { parseWorkerMessage } from '../../src/background/worker-protocol.js';

const CAPABILITY = 'C'.repeat(22);
const SESSION = 'S'.repeat(22);
const DIGEST = `hmac-sha256:${'A'.repeat(43)}`;
const RUNTIME_ID = 'abcdefghijklmnopabcdefghijklmnop';

function parsed(message) {
  const result = parseWorkerMessage(message);
  assert.equal(result.ok, true);
  return result.value;
}

function panelSender(windowId = 9) {
  return {
    id: RUNTIME_ID, documentId: 'panel-document', frameId: 0,
    url: `chrome-extension://${RUNTIME_ID}/src/panel/index.html`,
    windowId,
  };
}

function popupSender(windowId = 9) {
  return {
    id: RUNTIME_ID, documentId: 'popup-document', frameId: 0,
    url: `chrome-extension://${RUNTIME_ID}/src/popup/index.html`,
    windowId,
  };
}

function fixture(overrides = {}) {
  const calls = [];
  const durableSessions = new Map();
  const chromeApi = {
    runtime: {
      id: RUNTIME_ID,
      async getContexts({ documentIds }) {
        const documentId = documentIds[0];
        const side = documentId === 'panel-document';
        return [{
          documentId, documentUrl: `chrome-extension://${RUNTIME_ID}/src/${side ? 'panel' : 'popup'}/index.html`,
          contextType: side ? 'SIDE_PANEL' : 'POPUP', windowId: 9,
        }];
      },
    },
    tabs: {
      async query(value) { calls.push(['query', value]); return [{ id: 17, windowId: 9, status: 'complete', url: 'https://example.test/', pendingUrl: '' }]; },
    },
  };
  const authority = {
    async prepare(value) {
      calls.push(['prepare', value]);
      return { ok: true, capabilityId: value.allowedIntent === 'start-audit' ? CAPABILITY : 'P'.repeat(22), expiresAt: value.allowedIntent === 'start-audit' ? 200 : 180 };
    },
    async invalidateCapability(capabilityId, reason) { calls.push(['invalidate', capabilityId, reason]); return { ok: true }; },
    async authorizeSession(value) {
      calls.push(['authorize', value]);
      return { ok: true, session: { auditId: value.auditId, sessionCapabilityId: value.sessionCapabilityId, windowId: 9 }, context: { windowId: 9 } };
    },
    async rehydrateViewOnly(value) {
      calls.push(['rehydrate', value]);
      durableSessions.set(SESSION, { auditId: value.auditId, state: 'view-only' });
      return { ok: true, sessionCapabilityId: SESSION, auditId: value.auditId, expiresAt: 300 };
    },
  };
  const auditStarter = {
    async beginAuthorizedAudit(value) { calls.push(['begin', value]); return { response: { ok: true, auditId: value.auditId, state: 'running' } }; },
    async abortAuthorizedAudit(value) { calls.push(['abort', value]); return { ok: true, auditId: value.auditId, state: 'cancelling' }; },
  };
  const panelCoordinator = {
    async withWindowLock(windowId, fn) { calls.push(['lock', windowId]); return fn(); },
    async registerAndPublishViewOnly(value) { calls.push(['register-view', value]); return { registered: true, delivered: false }; },
  };
  const chromeAdapter = {
    async probeDocumentIdentity(tabId) { calls.push(['probe', tabId]); return { tabId, windowId: 9, documentId: 'page-document', urlSessionDigest: DIGEST }; },
    async getEvidenceUrl(tabId, includeQuery) { calls.push(['evidence', tabId, includeQuery]); return 'https://example.test/'; },
  };
  const dependencies = {
    chromeApi, authority, auditStarter, panelCoordinator, chromeAdapter,
    async readReportRevision({ auditId }) { calls.push(['read-report', auditId]); return { version: 1, auditId }; },
    async buildPanelResultBundle({ reportRevision }) { calls.push(['bundle', reportRevision.auditId]); return Object.freeze({ version: 1, auditId: reportRevision.auditId }); },
    async revokeViewOnly(value) {
      calls.push(['revoke', value]);
      const current = durableSessions.get(value.sessionCapabilityId);
      if (!current || current.auditId !== value.auditId || current.state !== 'view-only') return false;
      durableSessions.set(value.sessionCapabilityId, { ...current, state: 'revoked' });
      return true;
    },
    epochNow: () => 250,
    modelNow: () => '2026-08-29T12:00:00.000Z',
    createAuditId: (() => { let id = 0; return () => `audit-router-${++id}`; })(),
    ...overrides,
  };
  return { calls, durableSessions, router: createSidePanelIntentRouter(dependencies), dependencies };
}

test('prepares popup siblings from one proof and returns the minimum expiry with windowId', async () => {
  const { router, calls } = fixture();
  const response = await router.dispatch({
    envelope: parsed({ type: 'PREPARE_POPUP_CAPABILITIES', requestId: 'request-popup-1' }),
    sender: popupSender(),
  });
  assert.deepEqual(response, {
    ok: true, requestId: 'request-popup-1', auditCapabilityId: CAPABILITY,
    personaCapabilityId: 'P'.repeat(22), windowId: 9, expiresAt: 180,
  });
  const prepared = calls.filter(([name]) => name === 'prepare').map(([, value]) => value);
  assert.equal(prepared.length, 2);
  assert.deepEqual(prepared[0].issuer, prepared[1].issuer);
  assert.equal(prepared[0].initialUrlSessionDigest, prepared[1].initialUrlSessionDigest);
  assert.equal(prepared[0].initialUrlEvidence, 'https://example.test/');
});

test('rejects an accessor-backed pending URL before proof or capability effects', async () => {
  let pendingReads = 0;
  const { router, calls } = fixture({
    chromeApi: {
      runtime: {
        id: RUNTIME_ID,
        async getContexts() {
          return [{
            documentId: 'panel-document',
            documentUrl: `chrome-extension://${RUNTIME_ID}/src/panel/index.html`,
            contextType: 'SIDE_PANEL', windowId: 9,
          }];
        },
      },
      tabs: {
        async query() {
          const tab = { id: 17, windowId: 9, status: 'complete', url: 'https://example.test/' };
          Object.defineProperty(tab, 'pendingUrl', { enumerable: true, get() { pendingReads += 1; return ''; } });
          return [tab];
        },
      },
    },
  });
  assert.deepEqual(await router.dispatch({
    envelope: parsed({ type: 'PREPARE_PANEL_CAPABILITY', requestId: 'request-panel-hostile' }),
    sender: panelSender(),
  }), { ok: false, code: 'TARGET_UNAVAILABLE' });
  assert.equal(pendingReads, 0);
  assert.equal(calls.some(([name]) => ['probe', 'prepare'].includes(name)), false);
});

test('prepares a panel capability and starts through the only attached starter with worker IDs', async () => {
  const { router, calls } = fixture();
  assert.deepEqual(await router.dispatch({
    envelope: parsed({ type: 'PREPARE_PANEL_CAPABILITY', requestId: 'request-panel-1' }),
    sender: panelSender(),
  }), { ok: true, requestId: 'request-panel-1', capabilityId: CAPABILITY, expiresAt: 200 });

  const started = await router.dispatch({
    envelope: parsed({ type: 'PANEL_START_ATTACHED_AUDIT', capabilityId: CAPABILITY, captureMode: 'no-pixels', includeQuery: false, deleteAfterCompleteExport: false }),
    sender: panelSender(),
  });
  assert.deepEqual(started, { ok: true, auditId: 'audit-router-1', state: 'running' });
  const begin = calls.find(([name]) => name === 'begin')[1];
  assert.equal(begin.capabilityId, CAPABILITY);
  assert.equal(begin.eventNonce, null);
  assert.equal(begin.capturePolicy.mode, 'no-pixels');
  assert.equal(begin.senderContext.documentUrl.includes('panel'), true);
  assert.deepEqual(begin.retentionPreference, { version: 1, deleteAfterCompleteExport: false });
  assert.equal(Object.isFrozen(begin.retentionPreference), true);
});

test('personas and reserved intents fail before capability, storage or Chrome effects', async () => {
  const { router, calls } = fixture();
  for (const envelope of [
    parsed({ type: 'POPUP_START_PERSONA', capabilityId: CAPABILITY, mode: 'reader' }),
    parsed({ type: 'PANEL_OPEN_REPORT', sessionCapabilityId: SESSION, auditId: 'audit-1' }),
    parsed({ type: 'REPORT_CONNECT', auditId: 'audit-1' }),
    parsed({ type: 'EXPORT_CONNECT', auditId: 'audit-1' }),
  ]) assert.deepEqual(await router.dispatch({ envelope, sender: panelSender() }), { ok: false, code: 'FEATURE_UNAVAILABLE' });
  assert.deepEqual(calls, []);
});

test('authorizes cancellation and passes only the correlated session and window', async () => {
  const { router, calls } = fixture();
  const response = await router.dispatch({
    envelope: parsed({ type: 'PANEL_CANCEL_AUDIT', sessionCapabilityId: SESSION, auditId: 'audit-cancel' }),
    sender: panelSender(),
  });
  assert.deepEqual(response, { ok: true, auditId: 'audit-cancel', state: 'cancelling' });
  assert.deepEqual(calls.find(([name]) => name === 'abort')[1], {
    auditId: 'audit-cancel', sessionCapabilityId: SESSION, windowId: 9, reasonCode: 'USER_CANCELLED',
  });
});

test('rehydrates under the shared window lock and confirms durable revocation after registration denial', async () => {
  const { router, calls, durableSessions } = fixture({
    panelCoordinator: {
      async withWindowLock(windowId, fn) { calls.push(['lock', windowId]); return fn(); },
      async registerAndPublishViewOnly(value) { calls.push(['register-view', value]); return { registered: false, delivered: false, code: 'AUDIT_REHYDRATE_DENIED' }; },
    },
  });
  const response = await router.dispatch({
    envelope: parsed({ type: 'PANEL_REHYDRATE_VIEW', auditId: 'audit-history' }), sender: panelSender(),
  });
  assert.deepEqual(response, { ok: false, code: 'AUDIT_REHYDRATE_DENIED' });
  assert.deepEqual(calls.find(([name]) => name === 'rehydrate')[1], { auditId: 'audit-history', windowId: 9, mode: 'attached' });
  assert.deepEqual(calls.find(([name]) => name === 'revoke')[1], { sessionCapabilityId: SESSION, auditId: 'audit-history' });
  const registration = calls.find(([name]) => name === 'register-view')[1];
  assert.equal(registration.createdAt, 250);
  assert.equal(registration.expiresAt, 300);
  assert.equal(Object.hasOwn(registration, 'delivered'), false);
  assert.deepEqual(durableSessions.get(SESSION), { auditId: 'audit-history', state: 'revoked' });
});

test('hostile post-mint clock denies and revokes before any bootstrap registration', async () => {
  const { router, calls, durableSessions } = fixture({ epochNow: () => 300 });
  const response = await router.dispatch({
    envelope: parsed({ type: 'PANEL_REHYDRATE_VIEW', auditId: 'audit-clock' }), sender: panelSender(),
  });
  assert.deepEqual(response, { ok: false, code: 'AUDIT_REHYDRATE_DENIED' });
  assert.equal(calls.some(([name]) => name === 'register-view'), false);
  assert.equal(calls.some(([name]) => name === 'revoke'), true);
  assert.deepEqual(durableSessions.get(SESSION), { auditId: 'audit-clock', state: 'revoked' });
});

test('post-mint cleanup false or rejection returns recovery-required and never reports view-only success', async t => {
  for (const [name, revokeViewOnly] of [
    ['false', async () => false],
    ['rejection', async () => { throw new Error('native revoke secret'); }],
  ]) await t.test(name, async () => {
    const { router, durableSessions } = fixture({
      panelCoordinator: {
        async withWindowLock(_windowId, fn) { return fn(); },
        async registerAndPublishViewOnly() {
          return { registered: false, delivered: false, code: 'AUDIT_REHYDRATE_DENIED' };
        },
      },
      revokeViewOnly,
    });
    const response = await router.dispatch({
      envelope: parsed({ type: 'PANEL_REHYDRATE_VIEW', auditId: `audit-cleanup-${name}` }),
      sender: panelSender(),
    });
    assert.deepEqual(response, { ok: false, code: 'AUDIT_RECOVERY_REQUIRED' });
    assert.deepEqual(durableSessions.get(SESSION), { auditId: `audit-cleanup-${name}`, state: 'view-only' });
    assert.doesNotMatch(JSON.stringify(response), /native|revoke|secret/u);
  });
});

test('registration exception revokes durable session while registered success retains it', async t => {
  await t.test('registration exception', async () => {
    const { router, durableSessions } = fixture({
      panelCoordinator: {
        async withWindowLock(_windowId, fn) { return fn(); },
        async registerAndPublishViewOnly() { throw new Error('native registration secret'); },
      },
    });
    assert.deepEqual(await router.dispatch({
      envelope: parsed({ type: 'PANEL_REHYDRATE_VIEW', auditId: 'audit-register-throw' }),
      sender: panelSender(),
    }), { ok: false, code: 'AUDIT_REHYDRATE_DENIED' });
    assert.deepEqual(durableSessions.get(SESSION), { auditId: 'audit-register-throw', state: 'revoked' });
  });

  await t.test('registered success', async () => {
    const { router, durableSessions, calls } = fixture();
    assert.deepEqual(await router.dispatch({
      envelope: parsed({ type: 'PANEL_REHYDRATE_VIEW', auditId: 'audit-register-success' }),
      sender: panelSender(),
    }), { ok: true, auditId: 'audit-register-success', state: 'view-only' });
    assert.deepEqual(durableSessions.get(SESSION), { auditId: 'audit-register-success', state: 'view-only' });
    assert.equal(calls.some(([name]) => name === 'revoke'), false);
  });
});
