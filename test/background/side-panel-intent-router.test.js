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

function panelSender() {
  return {
    id: RUNTIME_ID, documentId: 'panel-document', frameId: 0,
    url: `chrome-extension://${RUNTIME_ID}/src/panel/index.html`,
  };
}

function panelCoordinatorFor(calls, overrides = {}) {
  const scope = Object.freeze({
    async registerPendingBootstrap() { return true; },
    async publishRegisteredBootstrap() { return true; },
    async publishResult() { return true; },
    async registerAndPublishViewOnly(value) { calls.push(['register-view', value]); return { registered: true, delivered: false }; },
    async disconnectSession() { return true; },
    ...overrides,
  });
  return Object.freeze({
    attachPanelPort() { return true; },
    async withWindowLock(windowId, fn) { calls.push(['lock', windowId]); return fn(scope); },
  });
}

function fixture(overrides = {}) {
  const { panelScopeOverrides, ...dependencyOverrides } = overrides;
  const calls = [];
  const durableSessions = new Map();
  const chromeApi = {
    runtime: {
      id: RUNTIME_ID,
      async getContexts({ documentIds }) {
        const documentId = documentIds[0];
        return [{
          documentId, documentUrl: `chrome-extension://${RUNTIME_ID}/src/panel/index.html`,
          contextType: 'SIDE_PANEL', tabId: -1, windowId: -1,
        }];
      },
    },
    windows: {
      async get(windowId, options) { calls.push(['window', windowId, options]); return { id: windowId, focused: false, type: 'normal' }; },
    },
    tabs: {
      async query(value) { calls.push(['query', value]); return [{ id: 17, windowId: 9, active: true, status: 'complete', url: 'https://example.test/', pendingUrl: '' }]; },
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
  const panelCoordinator = panelCoordinatorFor(calls, panelScopeOverrides);
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
    ...dependencyOverrides,
  };
  return { calls, durableSessions, router: createSidePanelIntentRouter(dependencies), dependencies };
}

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
      windows: { async get(windowId) { return { id: windowId, focused: false, type: 'normal' }; } },
      tabs: {
        async query() {
          const tab = { id: 17, windowId: 9, active: true, status: 'complete', url: 'https://example.test/' };
          Object.defineProperty(tab, 'pendingUrl', { enumerable: true, get() { pendingReads += 1; return ''; } });
          return [tab];
        },
      },
    },
  });
  assert.deepEqual(await router.dispatch({
    envelope: parsed({ type: 'PREPARE_PANEL_CAPABILITY', requestId: 'request-panel-hostile', windowId: 9 }),
    sender: panelSender(),
  }), { ok: false, code: 'CONTEXT_DENIED' });
  assert.equal(pendingReads, 0);
  assert.equal(calls.some(([name]) => ['probe', 'prepare'].includes(name)), false);
});

test('prepares a panel capability and starts through the only attached starter with worker IDs', async () => {
  const { router, calls } = fixture();
  assert.deepEqual(await router.dispatch({
    envelope: parsed({ type: 'PREPARE_PANEL_CAPABILITY', requestId: 'request-panel-1', windowId: 9 }),
    sender: panelSender(),
  }), { ok: true, requestId: 'request-panel-1', capabilityId: CAPABILITY, expiresAt: 200 });

  const started = await router.dispatch({
    envelope: parsed({ type: 'PANEL_START_ATTACHED_AUDIT', capabilityId: CAPABILITY, captureMode: 'no-pixels', includeQuery: false, deleteAfterCompleteExport: false, windowId: 9 }),
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

test('re-proves the panel window on start and denies a changed claim before the audit starter', async () => {
  const { router, calls } = fixture();
  assert.equal((await router.dispatch({
    envelope: parsed({ type: 'PREPARE_PANEL_CAPABILITY', requestId: 'request-window-reproof', windowId: 9 }),
    sender: panelSender(),
  })).ok, true);
  const beforeStart = calls.length;
  const response = await router.dispatch({
    envelope: parsed({
      type: 'PANEL_START_ATTACHED_AUDIT', capabilityId: CAPABILITY,
      captureMode: 'no-pixels', includeQuery: false, deleteAfterCompleteExport: false,
      windowId: 11,
    }),
    sender: panelSender(),
  });
  assert.deepEqual(response, { ok: false, code: 'CONTEXT_DENIED' });
  assert.equal(calls.slice(beforeStart).some(([operation]) => operation === 'begin'), false);
});

test('reserved intents fail before capability storage or Chrome effects', async () => {
  const { router, calls } = fixture();
  for (const envelope of [
    parsed({ type: 'PANEL_OPEN_REPORT', sessionCapabilityId: SESSION, auditId: 'audit-1', windowId: 9 }),
    parsed({ type: 'REPORT_CONNECT', auditId: 'audit-1' }),
    parsed({ type: 'EXPORT_CONNECT', auditId: 'audit-1' }),
  ]) assert.deepEqual(await router.dispatch({ envelope, sender: panelSender() }), { ok: false, code: 'FEATURE_UNAVAILABLE' });
  assert.deepEqual(calls, []);
});

test('denies wrong panel document path context and native window before target or authority effects', async t => {
  for (const [name, sender, context] of [
    ['path', { ...panelSender(), url: `chrome-extension://${RUNTIME_ID}/src/review/index.html` }, {
      documentId: 'panel-document', documentUrl: `chrome-extension://${RUNTIME_ID}/src/review/index.html`, contextType: 'SIDE_PANEL', windowId: 9,
    }],
    ['context', panelSender(), {
      documentId: 'panel-document', documentUrl: `chrome-extension://${RUNTIME_ID}/src/panel/index.html`, contextType: 'TAB', windowId: 9,
    }],
    ['popup', panelSender(), {
      documentId: 'panel-document', documentUrl: `chrome-extension://${RUNTIME_ID}/src/panel/index.html`, contextType: 'POPUP', windowId: -1,
    }],
    ['window', panelSender(), {
      documentId: 'panel-document', documentUrl: `chrome-extension://${RUNTIME_ID}/src/panel/index.html`, contextType: 'SIDE_PANEL', windowId: 11,
    }],
  ]) await t.test(name, async () => {
    const { router, calls, dependencies } = fixture();
    dependencies.chromeApi.runtime.getContexts = async () => [context];
    const response = await router.dispatch({
      envelope: parsed({ type: 'PREPARE_PANEL_CAPABILITY', requestId: `request-${name}`, windowId: 9 }), sender,
    });
    assert.deepEqual(response, { ok: false, code: 'CONTEXT_DENIED' });
    assert.equal(calls.some(([operation]) => ['probe', 'evidence', 'prepare'].includes(operation)), false);
  });
});

test('denies an unverified claimed window and unsafe active tab before probe prepare or response disclosure', async t => {
  const rows = [
    ['wrong-window', {
      windows: { async get() { return { id: 11, focused: false }; } },
    }],
    ['removed-window', {
      windows: { async get() { throw new Error('private native window detail'); } },
    }],
    ['ambiguous', {
      tabs: { async query() { return [
        { id: 17, windowId: 9, active: true, status: 'complete', url: 'https://example.test/', pendingUrl: '' },
        { id: 18, windowId: 9, active: true, status: 'complete', url: 'https://example.test/other', pendingUrl: '' },
      ]; } },
    }],
    ['loading', {
      tabs: { async query() { return [{ id: 17, windowId: 9, active: true, status: 'loading', url: 'https://example.test/', pendingUrl: '' }]; } },
    }],
    ['pending', {
      tabs: { async query() { return [{ id: 17, windowId: 9, active: true, status: 'complete', url: 'https://example.test/', pendingUrl: 'https://private.test/token' }]; } },
    }],
    ['privileged', {
      tabs: { async query() { return [{ id: 17, windowId: 9, active: true, status: 'complete', url: 'chrome://settings/', pendingUrl: '' }]; } },
    }],
  ];
  for (const [name, override] of rows) await t.test(name, async () => {
    const { router, calls, dependencies } = fixture();
    Object.assign(dependencies.chromeApi, override);
    const response = await router.dispatch({
      envelope: parsed({ type: 'PREPARE_PANEL_CAPABILITY', requestId: `request-${name}`, windowId: 9 }),
      sender: panelSender(),
    });
    assert.deepEqual(response, { ok: false, code: 'CONTEXT_DENIED' });
    assert.equal(calls.some(([operation]) => ['probe', 'evidence', 'prepare'].includes(operation)), false);
    assert.doesNotMatch(JSON.stringify(response), /private|https?:|chrome:\/\//iu);
  });
});

test('routes report and export envelopes through the single launch authorities without UI payloads', async () => {
  const calls = [];
  const reportLaunch = {
    async openRegisteredReport(value) { calls.push(['open', value]); return { ok: true }; },
    async connect(value) { calls.push(['report-connect', value]); return { ok: true, auditId: value.auditId, sessionCapabilityId: 'R'.repeat(22), state: 'view-only' }; },
  };
  const exportLaunch = {
    async requestExport(value) { calls.push(['request-export', value]); return { ok: true, auditId: value.auditId, attemptId: '1', state: 'awaiting-connection' }; },
    async connect(value) { calls.push(['export-connect', value]); return { ok: true, auditId: value.auditId, sessionCapabilityId: 'E'.repeat(22), expectedRevision: 3, attemptId: '1' }; },
    async complete(value) { calls.push(['export-complete', value]); return { ok: true, auditId: value.auditId, state: 'terminal' }; },
  };
  const { router } = fixture({ reportLaunch, exportLaunch });
  const sender = panelSender();
  const rows = [
    [{ type: 'PANEL_OPEN_REPORT', sessionCapabilityId: SESSION, auditId: 'audit-1', windowId: 9 }, 'open'],
    [{ type: 'REPORT_CONNECT', auditId: 'audit-1' }, 'report-connect'],
    [{ type: 'REPORT_REQUEST_EXPORT', sessionCapabilityId: SESSION, auditId: 'audit-1' }, 'request-export'],
    [{ type: 'EXPORT_CONNECT', auditId: 'audit-1' }, 'export-connect'],
    [{ type: 'EXPORT_COMPLETE', sessionCapabilityId: SESSION, auditId: 'audit-1', attemptId: '1' }, 'export-complete'],
  ];
  for (const [message, expectedCall] of rows) {
    const response = await router.dispatch({ envelope: parsed(message), sender });
    assert.equal(response.ok, true);
    assert.equal(calls.at(-1)[0], expectedCall);
    assert.deepEqual(Object.keys(calls.at(-1)[1]).sort(), expectedCall === 'export-complete'
      ? ['attemptId', 'auditId', 'sender', 'sessionCapabilityId']
      : expectedCall === 'request-export'
        ? ['auditId', 'sender', 'sessionCapabilityId']
        : expectedCall === 'open'
          ? ['auditId', 'windowId']
          : ['auditId', 'sender']);
  }
  assert.doesNotMatch(JSON.stringify(calls), /model|summary|projection|bytes|formats/iu);
});

test('authorizes cancellation and passes only the correlated session and window', async () => {
  const { router, calls } = fixture();
  const response = await router.dispatch({
    envelope: parsed({ type: 'PANEL_CANCEL_AUDIT', sessionCapabilityId: SESSION, auditId: 'audit-cancel', windowId: 9 }),
    sender: panelSender(),
  });
  assert.deepEqual(response, { ok: true, auditId: 'audit-cancel', state: 'cancelling' });
  assert.deepEqual(calls.find(([name]) => name === 'abort')[1], {
    auditId: 'audit-cancel', sessionCapabilityId: SESSION, windowId: 9, reasonCode: 'USER_CANCELLED',
  });
});

test('rehydrates under the shared window lock and confirms durable revocation after registration denial', async () => {
  const { router, calls, durableSessions } = fixture({
    panelScopeOverrides: {
      async registerAndPublishViewOnly(value) { calls.push(['register-view', value]); return { registered: false, delivered: false, code: 'AUDIT_REHYDRATE_DENIED' }; },
    },
  });
  const response = await router.dispatch({
    envelope: parsed({ type: 'PANEL_REHYDRATE_VIEW', auditId: 'audit-history', windowId: 9 }), sender: panelSender(),
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
    envelope: parsed({ type: 'PANEL_REHYDRATE_VIEW', auditId: 'audit-clock', windowId: 9 }), sender: panelSender(),
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
      panelScopeOverrides: {
        async registerAndPublishViewOnly() {
          return { registered: false, delivered: false, code: 'AUDIT_REHYDRATE_DENIED' };
        },
      },
      revokeViewOnly,
    });
    const response = await router.dispatch({
      envelope: parsed({ type: 'PANEL_REHYDRATE_VIEW', auditId: `audit-cleanup-${name}`, windowId: 9 }),
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
      panelScopeOverrides: {
        async registerAndPublishViewOnly() { throw new Error('native registration secret'); },
      },
    });
    assert.deepEqual(await router.dispatch({
      envelope: parsed({ type: 'PANEL_REHYDRATE_VIEW', auditId: 'audit-register-throw', windowId: 9 }),
      sender: panelSender(),
    }), { ok: false, code: 'AUDIT_REHYDRATE_DENIED' });
    assert.deepEqual(durableSessions.get(SESSION), { auditId: 'audit-register-throw', state: 'revoked' });
  });

  await t.test('registered success', async () => {
    const { router, durableSessions, calls } = fixture();
    assert.deepEqual(await router.dispatch({
      envelope: parsed({ type: 'PANEL_REHYDRATE_VIEW', auditId: 'audit-register-success', windowId: 9 }),
      sender: panelSender(),
    }), { ok: true, auditId: 'audit-register-success', state: 'view-only' });
    assert.deepEqual(durableSessions.get(SESSION), { auditId: 'audit-register-success', state: 'view-only' });
    assert.equal(calls.some(([name]) => name === 'revoke'), false);
  });
});

test('unconfirmed coordinator rollback remains recovery-required after minted-session revocation succeeds', async () => {
  const { router, durableSessions } = fixture({
    panelScopeOverrides: {
      async registerAndPublishViewOnly() {
        return { registered: false, delivered: false, code: 'AUDIT_RECOVERY_REQUIRED' };
      },
    },
  });

  const response = await router.dispatch({
    envelope: parsed({ type: 'PANEL_REHYDRATE_VIEW', auditId: 'audit-bootstrap-recovery', windowId: 9 }),
    sender: panelSender(),
  });

  assert.deepEqual(response, { ok: false, code: 'AUDIT_RECOVERY_REQUIRED' });
  assert.deepEqual(durableSessions.get(SESSION), { auditId: 'audit-bootstrap-recovery', state: 'revoked' });
});
