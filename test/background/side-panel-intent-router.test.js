import assert from 'node:assert/strict';
import test from 'node:test';

import { createSidePanelIntentRouter } from '../../src/background/side-panel-intent-router.js';
import { parseWorkerMessage } from '../../src/background/worker-protocol.js';

const CAPABILITY = 'C'.repeat(22);
const SESSION = 'S'.repeat(22);
const CONSENT = `${'C'.repeat(21)}Q`;
const DIGEST = `hmac-sha256:${'A'.repeat(43)}`;
const RUNTIME_ID = 'abcdefghijklmnopabcdefghijklmnop';
const LAUNCH_TOKEN = 'L'.repeat(43);
const PANEL_URL = `chrome-extension://${RUNTIME_ID}/src/panel/index.html?launch=${LAUNCH_TOKEN}`;
const PANEL_TYPES = new Set([
  'PREPARE_PANEL_CAPABILITY', 'PREPARE_PANEL_NAVIGATION_CAPABILITY', 'PREPARE_PANEL_PERSONA_CAPABILITY',
  'PANEL_START_ATTACHED_AUDIT', 'PANEL_START_URL_AUDIT', 'PANEL_START_BATCH_AUDIT',
  'CONFIRM_PIXEL_CAPTURE', 'PANEL_CONFIRM_PIXEL_CAPTURE',
  'PANEL_START_PERSONA', 'PANEL_REHYDRATE_PERSONA',
  'PANEL_SET_PERSONA_MODE', 'PANEL_READER_STATE', 'PANEL_READER_ACTION',
  'PANEL_READER_ENABLE_VOICE',
  'PANEL_STOP_PERSONA', 'PANEL_CANCEL_AUDIT',
  'PANEL_OPEN_REPORT', 'PANEL_REHYDRATE_VIEW',
]);
const HIGHLIGHT_TYPES = new Set(['GET_HIGHLIGHT_STATE', 'GET_HIGHLIGHT_AVAILABILITY', 'HIGHLIGHT_OCCURRENCE', 'CLEAR_HIGHLIGHT']);
const REVIEW_DECISION_MESSAGE = Object.freeze({
  type: 'REPORT_COMMIT_REVIEW_DECISION', sessionCapabilityId: SESSION, auditId: 'audit-1',
  itemId: '5.2.1', occurrenceId: 'occurrence-1', answer: 'não conforme', evaluator: 'Pessoa avaliadora',
  decidedAt: '2026-08-30T12:00:00.000Z', mode: 'manual', note: 'Barreira confirmada.',
});

function parsed(message) {
  const result = parseWorkerMessage(message);
  assert.equal(result.ok, true);
  return result.value;
}

function panelSender() {
  return {
    id: RUNTIME_ID, documentId: 'panel-document', frameId: 0,
    url: PANEL_URL,
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
    async publishHighlightState(value) { calls.push(['publish-panel-highlight', value]); return { delivered: 1 }; },
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
          documentId, documentUrl: PANEL_URL,
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
    async prepareNavigationForPanel(value) {
      calls.push(['prepare-navigation', value]);
      return { ok: true, capabilityId: 'N'.repeat(22), expiresAt: 200 };
    },
    async authorizeSession(value) {
      calls.push(['authorize', value]);
      return { ok: true, session: {
        auditId: value.auditId, sessionCapabilityId: value.sessionCapabilityId,
        windowId: 9, mode: 'attached',
        targetBinding: {
          kind: 'attached', tabId: 17, documentId: 'document-a', urlSessionDigest: DIGEST,
        },
        state: value.intent === 'confirm-pixels' ? 'privacy-paused' : 'result',
      }, context: { windowId: 9 } };
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
    async resumePrivacyPausedAudit(value) {
      calls.push(['resume', value]);
      return {
        response: { ok: true, auditId: value.auditId, state: 'running' },
        sessionCapabilityId: value.sessionCapabilityId,
        completion: Promise.resolve({ ok: true }),
      };
    },
  };
  const urlAuditStarter = {
    async beginAuthorizedUrlAudit(value) {
      calls.push(['begin-url', value]);
      return { response: { ok: true, auditId: value.auditId, state: 'running' } };
    },
    async beginAuthorizedBatchAudit(value) {
      calls.push(['begin-batch', value]);
      const plan = typeof value.preparePlan === 'function' ? await value.preparePlan() : value.plan;
      calls.push(['prepared-batch-plan', plan]);
      return { response: { ok: true, auditId: value.auditId, state: 'running' } };
    },
  };
  let vaultToken = 0;
  const rawNavigationVault = {
    async put(url, options) {
      calls.push(['vault-put', url, options]);
      vaultToken += 1;
      const parsedUrl = new URL(url);
      parsedUrl.search = '';
      parsedUrl.hash = '';
      return {
        navigationToken: vaultToken === 1 ? 'T'.repeat(22) : String(vaultToken).padStart(22, 'T'),
        evidenceUrl: { version: 'EvidenceUrlV1', href: parsedUrl.href, queryIncluded: false, redactedSegments: 0 },
        sessionDigest: `hmac-sha256:${vaultToken === 1 ? 'D'.repeat(43) : String(vaultToken).padStart(43, 'D')}`,
        expiresAt: 600_250,
      };
    },
    async putQueue(value) { calls.push(['vault-put-queue', value]); },
    async clearAudit(auditId) { calls.push(['vault-clear', auditId]); return true; },
  };
  const personaStart = {
    async start(value) {
      calls.push(['persona-start', value]);
      return { ok: true, lease: { leaseId: `lease-${'L'.repeat(22)}`, activeMode: value.mode, expiresAt: 400 } };
    },
    async rehydrate(value) {
      calls.push(['persona-rehydrate', value]);
      return { ok: true, lease: { leaseId: `lease-${'L'.repeat(22)}`, activeMode: 'reader', expiresAt: 400 } };
    },
  };
  const personaCoordinator = {
    async autonomousStop(value) {
      calls.push(['persona-autonomous-stop', value]);
      return { ok: true, state: 'revoked' };
    },
    async setMode(value) {
      calls.push(['persona-set-mode', value]);
      return { ok: true, lease: { leaseId: value.leaseId, activeMode: value.mode, expiresAt: 400 } };
    },
    async stop(value) {
      calls.push(['persona-stop', value]);
      return { ok: true, lease: { leaseId: value.leaseId, activeMode: null, expiresAt: 400 } };
    },
    async readerCommand(value) {
      calls.push(['persona-reader', value]);
      if (value.command.op === 'voices') {
        return {
          ok: true, kind: 'voices', status: 'available',
          voices: [{ id: 'local-a', label: 'Voz local A', lang: 'pt-BR' }],
        };
      }
      return {
        ok: true,
        kind: 'state',
        state: {
          version: 1, playback: value.command.op === 'action' && value.command.action === 'pause' ? 'paused' : 'playing',
          index: 0, total: 2, caption: 'Título principal, título nível 1',
          canPrevious: false, canNext: true, speechAvailability: 'available', voiceId: 'local-a', rate: 1,
        },
      };
    },
  };
  const panelCoordinator = panelCoordinatorFor(calls, panelScopeOverrides);
  const panelToken = Object.freeze(Object.create(null));
  const reviewToken = Object.freeze(Object.create(null));
  const highlightSessionBridge = {
    createPanelSender(value) { calls.push(['highlight-panel-sender', value]); return panelToken; },
    createReviewSender(value) { calls.push(['highlight-review-sender', value]); return reviewToken; },
  };
  const highlightController = {
    async currentState(value) { calls.push(['highlight-state', value]); return { ok: true, highlight: { state: 'clear' } }; },
    async availability(value) { calls.push(['highlight-availability', value]); return { ok: true, bindingStatus: { state: 'available' } }; },
    async highlight(value) { calls.push(['highlight-install', value]); return { ok: true, highlight: { state: 'active', occurrenceId: value.occurrenceId } }; },
    async clear(value) { calls.push(['highlight-clear', value]); return { ok: true, highlight: { state: 'clear' } }; },
    async invalidateContent(value) {
      calls.push(['highlight-invalidate-content', value]);
      if (value.sender?.documentId !== 'page-document') {
        return { ok: false, code: 'HIGHLIGHT_INVALIDATION_IGNORED' };
      }
      return {
        ok: true,
        auditId: 'audit-1',
        highlight: { state: 'clear' },
      };
    },
  };
  const chromeAdapter = {
    async probeDocumentIdentity(tabId) { calls.push(['probe', tabId]); return { tabId, windowId: 9, documentId: 'page-document', urlSessionDigest: DIGEST }; },
    async getEvidenceUrl(tabId, includeQuery) { calls.push(['evidence', tabId, includeQuery]); return 'https://example.test/'; },
  };
  const dependencies = {
    chromeApi, authority, auditStarter, panelCoordinator, chromeAdapter,
    urlAuditStarter, rawNavigationVault,
    createOwnershipId() { calls.push(['ownership']); return `owner_${'O'.repeat(22)}`; },
    personaStart, personaCoordinator,
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
    highlightController,
    highlightSessionBridge,
    async publishHighlightState(value) { calls.push(['publish-highlight', value]); return { delivered: 2 }; },
    ...dependencyOverrides,
  };
  const rawRouter = createSidePanelIntentRouter(dependencies);
  const router = Object.freeze({
    dispatch(request) {
      if (PANEL_TYPES.has(request.envelope?.type)) return rawRouter.dispatch({ ...request, launchTabId: 17 });
      if (HIGHLIGHT_TYPES.has(request.envelope?.type)) {
        return rawRouter.dispatch({ ...request, launchTabId: 17, panelWindowId: 9 });
      }
      return rawRouter.dispatch(request);
    },
  });
  return { calls, durableSessions, router, rawRouter, dependencies };
}

test('routes panel highlight intents with only occurrence correlation and a worker-owned window token', async () => {
  const { router, calls } = fixture();
  const current = await router.dispatch({
    envelope: parsed({
      type: 'GET_HIGHLIGHT_STATE', sessionCapabilityId: SESSION, auditId: 'audit-1',
    }),
    sender: panelSender(),
  });
  assert.deepEqual(current, { ok: true, highlight: { state: 'clear' } });
  const availability = await router.dispatch({
    envelope: parsed({
      type: 'GET_HIGHLIGHT_AVAILABILITY', sessionCapabilityId: SESSION,
      auditId: 'audit-1', occurrenceId: 'occurrence-1',
    }),
    sender: panelSender(),
  });
  assert.deepEqual(availability, { ok: true, bindingStatus: { state: 'available' } });

  const highlighted = await router.dispatch({
    envelope: parsed({
      type: 'HIGHLIGHT_OCCURRENCE', sessionCapabilityId: SESSION,
      auditId: 'audit-1', occurrenceId: 'occurrence-1',
    }),
    sender: panelSender(),
  });
  assert.deepEqual(highlighted, { ok: true, highlight: { state: 'active', occurrenceId: 'occurrence-1' } });

  const cleared = await router.dispatch({
    envelope: parsed({ type: 'CLEAR_HIGHLIGHT', sessionCapabilityId: SESSION, auditId: 'audit-1' }),
    sender: panelSender(),
  });
  assert.deepEqual(cleared, { ok: true, highlight: { state: 'clear' } });

  assert.deepEqual(calls.find(([name]) => name === 'highlight-panel-sender')[1], {
    sender: panelSender(), windowId: 9,
  });
  const install = calls.find(([name]) => name === 'highlight-install')[1];
  assert.deepEqual(Object.keys(install).sort(), ['auditId', 'occurrenceId', 'sender', 'sessionCapabilityId']);
  assert.equal(Object.keys(install.sender).length, 0);
  assert.equal(JSON.stringify(calls).includes('selector'), false);
  assert.equal(calls.filter(([name]) => name === 'highlight-state').length, 1);
  assert.deepEqual(calls.filter(([name]) => name === 'publish-highlight').map(([, value]) => value), [
    { version: 1, type: 'HIGHLIGHT_STATE_CHANGED', auditId: 'audit-1', occurrenceId: 'occurrence-1', state: 'active' },
    { version: 1, type: 'HIGHLIGHT_STATE_CHANGED', auditId: 'audit-1', occurrenceId: null, state: 'clear' },
  ]);
});

test('routes report highlight through a review token and rejects mixed panel transport claims', async () => {
  const reportLaunch = {
    async returnToSource(value) {
      calls.push(['return-source-for-highlight', value]);
      return { ok: true, state: 'source-focused' };
    },
  };
  const exportLaunch = {};
  const { rawRouter, calls } = fixture({ reportLaunch, exportLaunch });
  const sender = { id: RUNTIME_ID, documentId: 'review-document', url: `chrome-extension://${RUNTIME_ID}/src/review/index.html?auditId=audit-1` };
  const envelope = parsed({
    type: 'HIGHLIGHT_OCCURRENCE', sessionCapabilityId: SESSION,
    auditId: 'audit-1', occurrenceId: 'occurrence-1',
  });
  assert.equal((await rawRouter.dispatch({ envelope, sender })).ok, true);
  assert.deepEqual(calls.find(([name]) => name === 'highlight-review-sender')[1], { sender });
  assert.deepEqual(calls.find(([name]) => name === 'return-source-for-highlight')[1], {
    sessionCapabilityId: SESSION, auditId: 'audit-1', sender,
  });
  assert.deepEqual(calls.filter(([name]) => [
    'highlight-review-sender', 'return-source-for-highlight', 'highlight-install', 'publish-highlight',
  ].includes(name)).map(([name]) => name), [
    'highlight-review-sender', 'return-source-for-highlight', 'highlight-install', 'publish-highlight',
  ]);
  assert.deepEqual(await rawRouter.dispatch({ envelope, sender, panelWindowId: 9 }), {
    ok: false, code: 'CONTEXT_DENIED',
  });
  assert.deepEqual(await rawRouter.dispatch({ envelope, sender, launchTabId: 17 }), {
    ok: false, code: 'CONTEXT_DENIED',
  });
});

test('fails closed before a report highlight mutation when the source page cannot be focused', async () => {
  const reportLaunch = {
    async returnToSource(value) {
      calls.push(['return-source-for-highlight', value]);
      return { ok: false, code: 'REPORT_RETURN_DENIED' };
    },
  };
  const exportLaunch = {};
  const { rawRouter, calls } = fixture({ reportLaunch, exportLaunch });
  const sender = {
    id: RUNTIME_ID, documentId: 'review-document',
    url: `chrome-extension://${RUNTIME_ID}/src/review/index.html?auditId=audit-1`,
  };
  const envelope = parsed({
    type: 'HIGHLIGHT_OCCURRENCE', sessionCapabilityId: SESSION,
    auditId: 'audit-1', occurrenceId: 'occurrence-1',
  });

  assert.deepEqual(await rawRouter.dispatch({ envelope, sender }), {
    ok: false, code: 'HIGHLIGHT_RETURN_FAILED',
  });
  assert.equal(calls.some(([name]) => ['highlight-install', 'highlight-clear', 'publish-highlight'].includes(name)), false);
});

test('routes an exact content invalidation through sender correlation and publishes only safe clear state', async () => {
  const { rawRouter, calls } = fixture();
  const sender = {
    id: RUNTIME_ID, documentId: 'page-document', frameId: 0,
    tab: { id: 17, windowId: 9 }, url: 'https://example.test/',
  };
  const envelope = parsed({ type: 'AUDITA_HIGHLIGHT_INVALIDATED', nonce: 'N'.repeat(22) });

  assert.deepEqual(await rawRouter.dispatch({ envelope, sender }), {
    ok: true, highlight: { state: 'clear' },
  });
  assert.deepEqual(calls.find(([name]) => name === 'highlight-invalidate-content')[1], {
    message: envelope, sender,
  });
  assert.deepEqual(calls.find(([name]) => name === 'publish-highlight')[1], {
    version: 1, type: 'HIGHLIGHT_STATE_CHANGED', auditId: 'audit-1', occurrenceId: null, state: 'clear',
  });
  assert.doesNotMatch(JSON.stringify(await rawRouter.dispatch({
    envelope, sender: { ...sender, documentId: 'forged-document' },
  })), /audit-1/u);
});

test('correlates a minimal autonomous persona shutdown to the exact native content sender only', async () => {
  const { rawRouter, calls } = fixture();
  const sender = {
    id: RUNTIME_ID, documentId: 'page-document', frameId: 0,
    tab: { id: 17, windowId: 9 }, url: 'https://example.test/private?token=hidden',
  };
  const envelope = parsed({
    type: 'AUDITA_PERSONA_AUTONOMOUS_STOP',
    leaseId: `lease-${'L'.repeat(22)}`,
    reason: 'reader-terminal',
  });

  assert.deepEqual(await rawRouter.dispatch({ envelope, sender }), {
    ok: true, state: 'acknowledged',
  });
  assert.deepEqual(calls.find(([name]) => name === 'persona-autonomous-stop')[1], {
    leaseId: `lease-${'L'.repeat(22)}`,
    tabId: 17,
    windowId: 9,
    documentId: 'page-document',
    reason: 'reader-terminal',
  });
  assert.doesNotMatch(JSON.stringify(calls.find(([name]) => name === 'persona-autonomous-stop')), /private|token|https?:/iu);

  const before = calls.filter(([name]) => name === 'persona-autonomous-stop').length;
  for (const forged of [
    { ...sender, id: 'foreign-extension' },
    { ...sender, documentId: '' },
    { ...sender, frameId: 1 },
    { ...sender, tab: { id: 18, windowId: -1 } },
  ]) {
    assert.deepEqual(await rawRouter.dispatch({ envelope, sender: forged }), {
      ok: false, code: 'CONTEXT_DENIED',
    });
  }
  assert.equal(calls.filter(([name]) => name === 'persona-autonomous-stop').length, before);
});

test('rejects privileged panel messages on runtime dispatch before any effect', async () => {
  const { rawRouter, calls } = fixture();
  const response = await rawRouter.dispatch({
    envelope: parsed({ type: 'PREPARE_PANEL_CAPABILITY', requestId: 'runtime-panel-denied', windowId: 9 }),
    sender: panelSender(),
  });

  assert.deepEqual(response, { ok: false, code: 'CONTEXT_DENIED' });
  assert.equal(calls.some(([name]) => ['query', 'probe', 'prepare'].includes(name)), false);
});

test('admitted panel selection is bound to the launch tab and denies a changed active tab', async () => {
  const { rawRouter, calls } = fixture();
  const response = await rawRouter.dispatch({
    envelope: parsed({ type: 'PREPARE_PANEL_CAPABILITY', requestId: 'launch-tab-denied', windowId: 9 }),
    sender: panelSender(),
    launchTabId: 18,
  });

  assert.deepEqual(response, { ok: false, code: 'TARGET_UNAVAILABLE' });
  assert.equal(calls.some(([name]) => ['probe', 'prepare'].includes(name)), false);
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
  }), { ok: true, requestId: 'request-panel-1', capabilityId: CAPABILITY });

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

test('prepares and starts one tokenized URL without returning or retaining private navigation fields', async () => {
  const { router, calls } = fixture();
  assert.deepEqual(await router.dispatch({
    envelope: parsed({
      type: 'PREPARE_PANEL_NAVIGATION_CAPABILITY', requestId: 'request-url-1', intent: 'single', windowId: 9,
    }),
    sender: panelSender(),
  }), { ok: true, requestId: 'request-url-1', capabilityId: 'N'.repeat(22) });

  const response = await router.dispatch({
    envelope: parsed({
      type: 'PANEL_START_URL_AUDIT', capabilityId: 'N'.repeat(22),
      url: 'https://example.test/private?token=raw', captureMode: 'no-pixels',
      includeQuery: false, deleteAfterCompleteExport: false, windowId: 9,
    }),
    sender: panelSender(),
  });
  assert.deepEqual(response, { ok: true, auditId: 'audit-router-1', state: 'running' });
  assert.doesNotMatch(JSON.stringify(response), /private|token|digest|owner|capability/iu);
  assert.deepEqual(calls.find(([name]) => name === 'vault-put').slice(1), [
    'https://example.test/private?token=raw',
    { auditId: 'audit-router-1', purpose: 'single-url', ttlMs: 600_000, includeQuery: false },
  ]);
  const begin = calls.find(([name]) => name === 'begin-url')[1];
  assert.deepEqual(begin.plan, {
    kind: 'single', ownershipId: `owner_${'O'.repeat(22)}`, navigationToken: 'T'.repeat(22),
    navigationPurpose: 'single-url',
    evidenceUrl: { version: 'EvidenceUrlV1', href: 'https://example.test/private', queryIncluded: false, redactedSegments: 0 },
    sessionDigest: `hmac-sha256:${'D'.repeat(43)}`,
  });
  assert.equal(Object.hasOwn(begin, 'url'), false);
  assert.equal(begin.capturePolicy.mode, 'no-pixels');
});

test('normalizes and starts a tokenized no-pixels batch without reflecting private URLs', async () => {
  const { router, calls } = fixture();
  assert.deepEqual(await router.dispatch({
    envelope: parsed({
      type: 'PREPARE_PANEL_NAVIGATION_CAPABILITY', requestId: 'request-batch-1', intent: 'batch', windowId: 9,
    }),
    sender: panelSender(),
  }), { ok: true, requestId: 'request-batch-1', capabilityId: 'N'.repeat(22) });

  const response = await router.dispatch({
    envelope: parsed({
      type: 'PANEL_START_BATCH_AUDIT', capabilityId: 'N'.repeat(22),
      urls: [
        'https://one.example.test/private?token=alpha',
        'https://two.example.test/path?token=beta',
        'https://one.example.test/private?token=alpha',
      ].join('\n'),
      captureMode: 'no-pixels', includeQuery: false,
      deleteAfterCompleteExport: false, windowId: 9,
    }),
    sender: panelSender(),
  });
  assert.deepEqual(response, {
    ok: true, auditId: 'audit-router-1', state: 'running', total: 2,
    warnings: [{
      line: 3, code: 'DUPLICATE_URL', firstLine: 1,
      message: 'A URL repete uma entrada anterior e não será auditada novamente.',
    }],
  });
  assert.doesNotMatch(JSON.stringify(response), /alpha|beta|token|navigation|digest|owner|capability/iu);
  assert.deepEqual(calls.filter(([name]) => name === 'vault-put').map(([, url, options]) => [url, options]), [
    ['https://one.example.test/private?token=alpha', {
      auditId: 'audit-router-1', purpose: 'batch-page', ttlMs: 7_200_000, includeQuery: false,
    }],
    ['https://two.example.test/path?token=beta', {
      auditId: 'audit-router-1', purpose: 'batch-page', ttlMs: 7_200_000, includeQuery: false,
    }],
  ]);
  const queue = calls.find(([name]) => name === 'vault-put-queue')[1];
  assert.equal(queue.auditId, 'audit-router-1');
  assert.deepEqual(queue.entries.map(entry => ({ line: entry.line, status: entry.status })), [
    { line: 1, status: 'pending' }, { line: 2, status: 'pending' },
  ]);
  assert.doesNotMatch(JSON.stringify(queue), /alpha|beta|token=/iu);
  const begin = calls.find(([name]) => name === 'begin-batch')[1];
  assert.equal(Object.hasOwn(begin, 'plan'), false);
  assert.equal(typeof begin.preparePlan, 'function');
  assert.deepEqual(calls.find(([name]) => name === 'prepared-batch-plan')[1], {
    kind: 'batch', queueId: 'audit-router-1', acceptedCount: 2,
  });
  assert.equal(calls.findIndex(([name]) => name === 'begin-batch') <
    calls.findIndex(([name]) => name === 'vault-put'), true);
  assert.equal(begin.capturePolicy.mode, 'no-pixels');
});

test('starts each batch evidence mode with its exact canonical policy and never downgrades it', async () => {
  const observed = [];
  for (const captureMode of ['full-evidence', 'element-only', 'no-pixels']) {
    const { router, calls } = fixture();
    const response = await router.dispatch({
      envelope: parsed({
        type: 'PANEL_START_BATCH_AUDIT', capabilityId: 'N'.repeat(22),
        urls: 'https://one.example.test/private?token=alpha\nhttps://two.example.test/path?token=beta',
        captureMode, includeQuery: false, deleteAfterCompleteExport: false, windowId: 9,
      }),
      sender: panelSender(),
    });
    assert.equal(response.ok, true, captureMode);
    observed.push(calls.find(([name]) => name === 'begin-batch')[1].capturePolicy);
  }
  assert.deepEqual(observed, [
    {
      version: 'CapturePolicyV1', mode: 'full-evidence', includeQuery: false,
      captureFullPage: true, captureElements: true, composeAnnouncementMap: true,
    },
    {
      version: 'CapturePolicyV1', mode: 'element-only', includeQuery: false,
      captureFullPage: false, captureElements: true, composeAnnouncementMap: false,
    },
    {
      version: 'CapturePolicyV1', mode: 'no-pixels', includeQuery: false,
      captureFullPage: false, captureElements: false, composeAnnouncementMap: false,
    },
  ]);
});

test('starts every URL capture mode with its exact canonical policy and clears the vault on denial', async () => {
  const { router, calls } = fixture();
  for (const [index, captureMode] of ['full-evidence', 'element-only', 'no-pixels'].entries()) {
    const response = await router.dispatch({
      envelope: parsed({
        type: 'PANEL_START_URL_AUDIT', capabilityId: 'N'.repeat(22),
        url: `https://example.test/${captureMode}?token=raw`, captureMode,
        includeQuery: false, deleteAfterCompleteExport: false, windowId: 9,
      }),
      sender: panelSender(),
    });
    assert.deepEqual(response, { ok: true, auditId: `audit-router-${index + 1}`, state: 'running' });
  }
  assert.deepEqual(calls.filter(([name]) => name === 'begin-url').map(([, value]) => value.capturePolicy), [
    {
      version: 'CapturePolicyV1', mode: 'full-evidence', includeQuery: false,
      captureFullPage: true, captureElements: true, composeAnnouncementMap: true,
    },
    {
      version: 'CapturePolicyV1', mode: 'element-only', includeQuery: false,
      captureFullPage: false, captureElements: true, composeAnnouncementMap: false,
    },
    {
      version: 'CapturePolicyV1', mode: 'no-pixels', includeQuery: false,
      captureFullPage: false, captureElements: false, composeAnnouncementMap: false,
    },
  ]);

  const denied = fixture({
    urlAuditStarter: {
      async beginAuthorizedUrlAudit() {
        return { response: { ok: false, code: 'AUDIT_START_FAILED' } };
      },
    },
  });
  const response = await denied.router.dispatch({
    envelope: parsed({
      type: 'PANEL_START_URL_AUDIT', capabilityId: 'N'.repeat(22),
      url: 'https://example.test/private?token=must-not-escape', captureMode: 'full-evidence',
      includeQuery: false, deleteAfterCompleteExport: false, windowId: 9,
    }),
    sender: panelSender(),
  });
  assert.deepEqual(response, { ok: false, code: 'AUDIT_START_FAILED' });
  assert.deepEqual(denied.calls.filter(([name]) => name === 'vault-clear'), [
    ['vault-clear', 'audit-router-1'],
  ]);
  assert.doesNotMatch(JSON.stringify(response), /must-not-escape|token|digest|owner|capability/iu);
});

test('starts each closed capture mode with its exact canonical policy', async () => {
  const { router, calls } = fixture();
  for (const captureMode of ['full-evidence', 'element-only', 'no-pixels']) {
    const started = await router.dispatch({
      envelope: parsed({
        type: 'PANEL_START_ATTACHED_AUDIT', capabilityId: CAPABILITY, captureMode,
        includeQuery: false, deleteAfterCompleteExport: false, windowId: 9,
      }),
      sender: panelSender(),
    });
    assert.equal(started.ok, true);
  }
  assert.deepEqual(calls.filter(([name]) => name === 'begin').map(([, value]) => value.capturePolicy), [
    {
      version: 'CapturePolicyV1', mode: 'full-evidence', includeQuery: false,
      captureFullPage: true, captureElements: true, composeAnnouncementMap: true,
    },
    {
      version: 'CapturePolicyV1', mode: 'element-only', includeQuery: false,
      captureFullPage: false, captureElements: true, composeAnnouncementMap: false,
    },
    {
      version: 'CapturePolicyV1', mode: 'no-pixels', includeQuery: false,
      captureFullPage: false, captureElements: false, composeAnnouncementMap: false,
    },
  ]);
});

test('authorizes and resumes one correlated privacy pause without exposing the completion', async () => {
  const { router, calls } = fixture();
  const response = await router.dispatch({
    envelope: parsed({
      type: 'CONFIRM_PIXEL_CAPTURE', sessionCapabilityId: SESSION, auditId: 'audit-paused',
      consentId: CONSENT, mode: 'full-evidence', accepted: true, windowId: 9,
    }),
    sender: panelSender(),
  });

  assert.deepEqual(response, { ok: true, auditId: 'audit-paused', state: 'running' });
  assert.deepEqual(calls.find(([name]) => name === 'authorize')[1], {
    sessionCapabilityId: SESSION, auditId: 'audit-paused', consumer: 'panel',
    intent: 'confirm-pixels', sender: panelSender(), claimedWindowId: 9,
  });
  assert.deepEqual(calls.find(([name]) => name === 'resume')[1], {
    auditId: 'audit-paused', sessionCapabilityId: SESSION, windowId: 9,
    consentId: CONSENT, mode: 'full-evidence',
  });
  assert.deepEqual(Reflect.ownKeys(response), ['ok', 'auditId', 'state']);
  assert.equal(calls.some(([name]) => ['begin', 'abort'].includes(name)), false);
});

test('resumes a correlated single-URL pause without receiving or forwarding private consent data', async () => {
  const { router, calls, dependencies } = fixture();
  dependencies.authority.authorizeSession = async value => {
    calls.push(['authorize', value]);
    return {
      ok: true,
      session: {
        auditId: value.auditId, sessionCapabilityId: value.sessionCapabilityId,
        windowId: 9, mode: 'single', state: 'privacy-paused',
        targetBinding: {
          kind: 'disposable', ownershipId: `owner_${'O'.repeat(22)}`, state: 'retained-for-consent',
        },
      },
      context: { windowId: 9 },
    };
  };

  const response = await router.dispatch({
    envelope: parsed({
      type: 'PANEL_CONFIRM_PIXEL_CAPTURE', sessionCapabilityId: SESSION,
      auditId: 'audit-url-paused', mode: 'element-only', accepted: true, windowId: 9,
    }),
    sender: panelSender(),
  });

  assert.deepEqual(response, { ok: true, auditId: 'audit-url-paused', state: 'running' });
  assert.deepEqual(calls.find(([name]) => name === 'resume')[1], {
    auditId: 'audit-url-paused', sessionCapabilityId: SESSION, windowId: 9,
    mode: 'element-only',
  });
  assert.deepEqual(Reflect.ownKeys(response), ['ok', 'auditId', 'state']);
  assert.doesNotMatch(JSON.stringify(response), /consent|owner_|hmac-sha256|digest/iu);
});

test('resumes a correlated batch pause through the same one-shot public confirmation envelope', async () => {
  const { router, calls, dependencies } = fixture();
  dependencies.authority.authorizeSession = async value => {
    calls.push(['authorize', value]);
    return {
      ok: true,
      session: {
        auditId: value.auditId, sessionCapabilityId: value.sessionCapabilityId,
        windowId: 9, mode: 'batch', state: 'privacy-paused',
        targetBinding: {
          kind: 'batch', activePageId: 'page-3', activeOwnershipId: `owner_${'O'.repeat(22)}`,
        },
      },
      context: { windowId: 9 },
    };
  };

  const response = await router.dispatch({
    envelope: parsed({
      type: 'PANEL_CONFIRM_PIXEL_CAPTURE', sessionCapabilityId: SESSION,
      auditId: 'audit-batch-paused', mode: 'full-evidence', accepted: true, windowId: 9,
    }),
    sender: panelSender(),
  });

  assert.deepEqual(response, { ok: true, auditId: 'audit-batch-paused', state: 'running' });
  assert.deepEqual(calls.find(([name]) => name === 'resume')[1], {
    auditId: 'audit-batch-paused', sessionCapabilityId: SESSION, windowId: 9,
    mode: 'full-evidence',
  });
  assert.doesNotMatch(JSON.stringify(response), /consent|owner_|hmac-sha256|digest|documentId|tabId/iu);
});

test('denies message, session, or disposable-binding drift before the single-URL starter', async t => {
  const mutations = [
    session => ({ ...session, state: 'running' }),
    session => ({ ...session, mode: 'attached' }),
    session => ({ ...session, targetBinding: { kind: 'attached' } }),
    session => ({ ...session, targetBinding: { ...session.targetBinding, state: 'observing' } }),
    session => ({ ...session, targetBinding: { ...session.targetBinding, ownershipId: 'owner_forged' } }),
  ];
  for (const [index, mutate] of mutations.entries()) await t.test(`single-${index}`, async () => {
    const { router, calls, dependencies } = fixture();
    dependencies.authority.authorizeSession = async value => ({
      ok: true,
      session: mutate({
        auditId: value.auditId, sessionCapabilityId: value.sessionCapabilityId,
        windowId: 9, mode: 'single', state: 'privacy-paused',
        targetBinding: {
          kind: 'disposable', ownershipId: `owner_${'O'.repeat(22)}`, state: 'retained-for-consent',
        },
      }),
      context: { windowId: 9 },
    });
    assert.deepEqual(await router.dispatch({
      envelope: parsed({
        type: 'PANEL_CONFIRM_PIXEL_CAPTURE', sessionCapabilityId: SESSION,
        auditId: 'audit-url-paused', mode: 'full-evidence', accepted: true, windowId: 9,
      }),
      sender: panelSender(),
    }), { ok: false, code: 'PIXEL_CONFIRM_DENIED' });
    assert.equal(calls.some(([name]) => name === 'resume'), false);
  });

  const { router, calls, dependencies } = fixture();
  dependencies.authority.authorizeSession = async value => ({
    ok: true,
    session: {
      auditId: value.auditId, sessionCapabilityId: value.sessionCapabilityId,
      windowId: 9, mode: 'single', state: 'privacy-paused',
      targetBinding: {
        kind: 'disposable', ownershipId: `owner_${'O'.repeat(22)}`, state: 'retained-for-consent',
      },
    },
    context: { windowId: 9 },
  });
  assert.deepEqual(await router.dispatch({
    envelope: parsed({
      type: 'CONFIRM_PIXEL_CAPTURE', sessionCapabilityId: SESSION, auditId: 'audit-url-paused',
      consentId: CONSENT, mode: 'full-evidence', accepted: true, windowId: 9,
    }),
    sender: panelSender(),
  }), { ok: false, code: 'PIXEL_CONFIRM_DENIED' });
  assert.equal(calls.some(([name]) => name === 'resume'), false);
});

test('projects only closed resume successes and allowlisted failures', async t => {
  for (const state of ['running', 'privacy-paused']) await t.test(state, async () => {
    const { router } = fixture({
      auditStarter: {
        async beginAuthorizedAudit() { throw new Error('unused'); },
        async abortAuthorizedAudit() { throw new Error('unused'); },
        async resumePrivacyPausedAudit(value) {
          return {
            response: { ok: true, auditId: value.auditId, state },
            sessionCapabilityId: value.sessionCapabilityId,
            completion: new Promise(() => {}),
          };
        },
      },
    });
    assert.deepEqual(await router.dispatch({
      envelope: parsed({
        type: 'CONFIRM_PIXEL_CAPTURE', sessionCapabilityId: SESSION, auditId: `audit-${state}`,
        consentId: CONSENT, mode: 'element-only', accepted: true, windowId: 9,
      }),
      sender: panelSender(),
    }), { ok: true, auditId: `audit-${state}`, state });
  });

  for (const code of [
    'PIXEL_CONSENT_EXPIRED', 'PIXEL_CONSENT_DOCUMENT_CHANGED', 'PIXEL_CONSENT_ALREADY_USED',
    'PIXEL_CONSENT_STALE', 'AUDIT_RECOVERY_REQUIRED', 'AUDIT_CANCELLED',
  ]) await t.test(code, async () => {
    const { router } = fixture({
      auditStarter: {
        async beginAuthorizedAudit() { throw new Error('unused'); },
        async abortAuthorizedAudit() { throw new Error('unused'); },
        async resumePrivacyPausedAudit(value) {
          return {
            response: { ok: false, code }, sessionCapabilityId: value.sessionCapabilityId,
            completion: null,
          };
        },
      },
    });
    assert.deepEqual(await router.dispatch({
      envelope: parsed({
        type: 'CONFIRM_PIXEL_CAPTURE', sessionCapabilityId: SESSION, auditId: 'audit-denied',
        consentId: CONSENT, mode: 'full-evidence', accepted: true, windowId: 9,
      }),
      sender: panelSender(),
    }), { ok: false, code });
  });
});

test('denies uncorrelated paused sessions and malformed starter wrappers', async t => {
  const sessionMutations = [
    session => ({ ...session, state: 'running' }),
    session => ({ ...session, auditId: 'other-audit' }),
    session => ({ ...session, sessionCapabilityId: 'X'.repeat(22) }),
    session => ({ ...session, windowId: 11 }),
    session => ({ ...session, mode: 'disposable' }),
  ];
  for (const [index, mutate] of sessionMutations.entries()) await t.test(`session-${index}`, async () => {
    const { router, calls, dependencies } = fixture();
    dependencies.authority.authorizeSession = async value => ({
      ok: true,
      session: mutate({
        auditId: value.auditId, sessionCapabilityId: value.sessionCapabilityId,
        windowId: 9, mode: 'attached',
        targetBinding: {
          kind: 'attached', tabId: 17, documentId: 'document-a', urlSessionDigest: DIGEST,
        },
        state: 'privacy-paused',
      }),
      context: { windowId: 9 },
    });
    assert.deepEqual(await router.dispatch({
      envelope: parsed({
        type: 'CONFIRM_PIXEL_CAPTURE', sessionCapabilityId: SESSION, auditId: 'audit-paused',
        consentId: CONSENT, mode: 'full-evidence', accepted: true, windowId: 9,
      }),
      sender: panelSender(),
    }), { ok: false, code: 'PIXEL_CONFIRM_DENIED' });
    assert.equal(calls.some(([name]) => name === 'resume'), false);
  });

  const malformed = [
    value => ({ ...value, sessionCapabilityId: 'X'.repeat(22) }),
    value => ({ ...value, extra: true }),
    value => ({ ...value, response: { ok: true, auditId: 'other-audit', state: 'running' } }),
    value => ({ ...value, response: { ok: true, auditId: 'audit-paused', state: 'result' } }),
    value => ({ ...value, response: { ok: false, code: 'PRIVATE_NATIVE_ERROR' } }),
  ];
  for (const [index, mutate] of malformed.entries()) await t.test(`wrapper-${index}`, async () => {
    const { router } = fixture({
      auditStarter: {
        async beginAuthorizedAudit() { throw new Error('unused'); },
        async abortAuthorizedAudit() { throw new Error('unused'); },
        async resumePrivacyPausedAudit() {
          return mutate({
            response: { ok: true, auditId: 'audit-paused', state: 'running' },
            sessionCapabilityId: SESSION,
            completion: null,
          });
        },
      },
    });
    assert.deepEqual(await router.dispatch({
      envelope: parsed({
        type: 'CONFIRM_PIXEL_CAPTURE', sessionCapabilityId: SESSION, auditId: 'audit-paused',
        consentId: CONSENT, mode: 'full-evidence', accepted: true, windowId: 9,
      }),
      sender: panelSender(),
    }), { ok: false, code: 'PIXEL_CONFIRM_DENIED' });
  });
});

test('mode mismatch and replay reach only the consent claim and never downstream pixels', async () => {
  let claims = 0;
  let pixels = 0;
  let consumed = false;
  const { router } = fixture({
    auditStarter: {
      async beginAuthorizedAudit() { throw new Error('unused'); },
      async abortAuthorizedAudit() { throw new Error('unused'); },
      async resumePrivacyPausedAudit(value) {
        claims += 1;
        if (value.mode !== 'full-evidence' || consumed) {
          return {
            response: { ok: false, code: 'PIXEL_CONSENT_STALE' },
            sessionCapabilityId: value.sessionCapabilityId,
            completion: null,
          };
        }
        consumed = true;
        pixels += 1;
        return {
          response: { ok: true, auditId: value.auditId, state: 'running' },
          sessionCapabilityId: value.sessionCapabilityId,
          completion: Promise.resolve({ ok: true }),
        };
      },
    },
  });
  const dispatch = mode => router.dispatch({
    envelope: parsed({
      type: 'CONFIRM_PIXEL_CAPTURE', sessionCapabilityId: SESSION, auditId: 'audit-paused',
      consentId: CONSENT, mode, accepted: true, windowId: 9,
    }),
    sender: panelSender(),
  });

  assert.deepEqual(await dispatch('element-only'), { ok: false, code: 'PIXEL_CONSENT_STALE' });
  assert.deepEqual(await dispatch('full-evidence'), { ok: true, auditId: 'audit-paused', state: 'running' });
  assert.deepEqual(await dispatch('full-evidence'), { ok: false, code: 'PIXEL_CONSENT_STALE' });
  assert.equal(claims, 3);
  assert.equal(pixels, 1);
});

test('prepares and consumes persona capabilities only from the Side Panel and projects no target data', async () => {
  const { router, calls } = fixture();
  const prepared = await router.dispatch({
    envelope: parsed({ type: 'PREPARE_PANEL_PERSONA_CAPABILITY', requestId: 'request-persona-1', windowId: 9 }),
    sender: panelSender(),
  });
  assert.deepEqual(prepared, {
    ok: true,
    requestId: 'request-persona-1',
    capabilityId: 'P'.repeat(22),
  });

  const started = await router.dispatch({
    envelope: parsed({ type: 'PANEL_START_PERSONA', capabilityId: prepared.capabilityId, mode: 'reader', windowId: 9 }),
    sender: panelSender(),
  });
  assert.deepEqual(started, {
    ok: true,
    lease: { leaseId: `lease-${'L'.repeat(22)}`, activeMode: 'reader', expiresAt: 400 },
  });
  const preparedCall = calls.find(([name, value]) => name === 'prepare' && value.allowedIntent === 'start-persona');
  assert.equal(preparedCall[1].issuer.path, '/src/panel/index.html');
  const start = calls.find(([name]) => name === 'persona-start')[1];
  assert.deepEqual(start.consumer, {
    extensionId: RUNTIME_ID,
    documentId: 'panel-document',
    path: '/src/panel/index.html',
    windowId: 9,
  });
  assert.equal(Object.hasOwn(start, 'tabId'), false);
  assert.equal(JSON.stringify(started).includes('document'), false);
});

test('rehydrates switches and stops a persona through the correlated Side Panel consumer', async () => {
  const { router, calls } = fixture();
  const leaseId = `lease-${'L'.repeat(22)}`;
  const rehydrated = await router.dispatch({
    envelope: parsed({ type: 'PANEL_REHYDRATE_PERSONA', capabilityId: 'P'.repeat(22), windowId: 9 }),
    sender: panelSender(),
  });
  assert.equal(rehydrated.ok, true);
  assert.deepEqual(await router.dispatch({
    envelope: parsed({ type: 'PANEL_SET_PERSONA_MODE', leaseId, mode: 'motor', windowId: 9 }),
    sender: panelSender(),
  }), { ok: true, lease: { leaseId, activeMode: 'motor', expiresAt: 400 } });
  assert.deepEqual(await router.dispatch({
    envelope: parsed({ type: 'PANEL_STOP_PERSONA', leaseId, windowId: 9 }),
    sender: panelSender(),
  }), { ok: true, lease: null });
  assert.deepEqual(calls.filter(([name]) => name.startsWith('persona-')).map(([name]) => name), [
    'persona-rehydrate', 'persona-set-mode', 'persona-stop',
  ]);
});

test('projects authenticated reader state and actions without exposing target data', async () => {
  const { router, calls } = fixture();
  const leaseId = `lease-${'L'.repeat(22)}`;
  const expected = {
    ok: true,
    readerState: {
      version: 1, playback: 'playing', index: 0, total: 2,
      caption: 'Título principal, título nível 1', canPrevious: false, canNext: true,
      speechAvailability: 'available', voiceId: 'local-a', rate: 1,
    },
  };
  assert.deepEqual(await router.dispatch({
    envelope: parsed({ type: 'PANEL_READER_STATE', leaseId, windowId: 9 }),
    sender: panelSender(),
  }), expected);
  assert.deepEqual(await router.dispatch({
    envelope: parsed({ type: 'PANEL_READER_ACTION', leaseId, action: 'next', windowId: 9 }),
    sender: panelSender(),
  }), expected);
  assert.deepEqual(await router.dispatch({
    envelope: parsed({ type: 'PANEL_READER_ENABLE_VOICE', leaseId, windowId: 9 }),
    sender: panelSender(),
  }), expected);
  const readerCalls = calls.filter(([name]) => name === 'persona-reader').map(([, value]) => value);
  assert.deepEqual(readerCalls.map(value => value.command), [
    { version: 1, op: 'state' },
    { version: 1, op: 'action', action: 'next' },
    { version: 1, op: 'voices', explicitUserGesture: true },
    { version: 1, op: 'preferences', voiceId: 'local-a', rate: 1 },
  ]);
  assert.equal(JSON.stringify(expected).includes('document'), false);
  assert.equal(JSON.stringify(expected).includes('tabId'), false);
});

test('persona commands deny a forged non-panel sender before persona effects', async () => {
  const { router, calls } = fixture();
  const response = await router.dispatch({
    envelope: parsed({ type: 'PANEL_START_PERSONA', capabilityId: 'P'.repeat(22), mode: 'reader', windowId: 9 }),
    sender: { ...panelSender(), url: `chrome-extension://${RUNTIME_ID}/src/review/index.html` },
  });
  assert.deepEqual(response, { ok: false, code: 'CONTEXT_DENIED' });
  assert.equal(calls.some(([name]) => name.startsWith('persona-')), false);
});

test('denies a document-less SIDE_PANEL sender because only the admitted Port may synthesize identity', async () => {
  const { router, dependencies } = fixture();
  const url = PANEL_URL;
  dependencies.chromeApi.runtime.getContexts = async filter => [{
    documentId: 'native-panel-document', documentUrl: filter.documentUrls?.[0] ?? url,
    contextType: filter.contextTypes?.[0] ?? 'SIDE_PANEL', tabId: -1, windowId: -1,
  }];

  const response = await router.dispatch({
    envelope: parsed({ type: 'PREPARE_PANEL_CAPABILITY', requestId: 'request-native-panel', windowId: 9 }),
    sender: { id: RUNTIME_ID, url, origin: `chrome-extension://${RUNTIME_ID}` },
  });

  assert.deepEqual(response, { ok: false, code: 'CONTEXT_DENIED' });
});

test('awaits a callback result when tabs.query returns undefined regardless of declared arity', async () => {
  const { router, dependencies } = fixture();
  dependencies.chromeApi.tabs.query = function query(queryInfo) {
    const callback = arguments[1];
    if (typeof callback !== 'function') return Promise.resolve([{
      id: 17, windowId: queryInfo.windowId, active: true, status: 'complete',
      url: 'https://example.test/', pendingUrl: '',
    }]);
    setImmediate(() => callback([{
      id: 17, windowId: queryInfo.windowId, active: true, status: 'complete',
      url: 'https://example.test/', pendingUrl: '',
    }]));
  };

  const response = await router.dispatch({
    envelope: parsed({ type: 'PREPARE_PANEL_CAPABILITY', requestId: 'request-callback-query', windowId: 9 }),
    sender: panelSender(),
  });

  assert.deepEqual(response, {
    ok: true, requestId: 'request-callback-query', capabilityId: CAPABILITY,
  });
});

test('accepts a defined synchronous tabs.query result regardless of declared arity', async () => {
  const { router, dependencies } = fixture();
  dependencies.chromeApi.tabs.query = function query(queryInfo, callback) {
    const result = [{
      id: 17, windowId: queryInfo.windowId, active: true, status: 'complete',
      url: 'https://example.test/', pendingUrl: '',
    }];
    if (typeof callback !== 'function') return Promise.resolve(result);
    setImmediate(() => callback([]));
    return result;
  };

  const response = await router.dispatch({
    envelope: parsed({ type: 'PREPARE_PANEL_CAPABILITY', requestId: 'request-defined-query', windowId: 9 }),
    sender: panelSender(),
  });

  assert.deepEqual(response, {
    ok: true, requestId: 'request-defined-query', capabilityId: CAPABILITY,
  });
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
    async authorizeIntent(value) { calls.push(['authorize-report', value]); return { ok: true, auditId: value.auditId, intent: value.intent }; },
    async returnToSource(value) { calls.push(['return-source', value]); return { ok: true, state: 'source-focused' }; },
  };
  const reportOperations = {
    async commitReviewDecision(value) {
      calls.push(['review-commit', value]);
      return { ok: true, auditId: value.auditId, occurrenceId: value.occurrenceId, modelRevision: 4, modelHash: 'a'.repeat(64) };
    },
    async deleteAudit(value) { calls.push(['delete-audit', value]); return { ok: true, auditId: value.auditId, deleted: true }; },
    async deleteAllAudits() { calls.push(['delete-all']); return { ok: true, deleted: 2 }; },
  };
  const exportLaunch = {
    async requestExport(value) { calls.push(['request-export', value]); return { ok: true, auditId: value.auditId, attemptId: '1', state: 'awaiting-connection' }; },
    async connect(value) { calls.push(['export-connect', value]); return { ok: true, auditId: value.auditId, sessionCapabilityId: 'E'.repeat(22), expectedRevision: 3, attemptId: '1' }; },
    async complete(value) { calls.push(['export-complete', value]); return { ok: true, auditId: value.auditId, state: 'terminal' }; },
  };
  const { router } = fixture({ reportLaunch, exportLaunch, reportOperations });
  const sender = panelSender();
  const rows = [
    [{ type: 'PANEL_OPEN_REPORT', sessionCapabilityId: SESSION, auditId: 'audit-1', windowId: 9 }, 'open'],
    [{ type: 'REPORT_CONNECT', auditId: 'audit-1' }, 'report-connect'],
    [{ type: 'REPORT_REQUEST_EXPORT', sessionCapabilityId: SESSION, auditId: 'audit-1' }, 'request-export'],
    [{ type: 'REPORT_RETURN_TO_SOURCE', sessionCapabilityId: SESSION, auditId: 'audit-1' }, 'return-source'],
    [REVIEW_DECISION_MESSAGE, 'review-commit'],
    [{ type: 'REPORT_DELETE_AUDIT', sessionCapabilityId: SESSION, auditId: 'audit-1' }, 'delete-audit'],
    [{ type: 'REPORT_DELETE_ALL_AUDITS', sessionCapabilityId: SESSION, auditId: 'audit-1' }, 'delete-all'],
    [{ type: 'EXPORT_CONNECT', auditId: 'audit-1' }, 'export-connect'],
    [{ type: 'EXPORT_COMPLETE', sessionCapabilityId: SESSION, auditId: 'audit-1', attemptId: '1' }, 'export-complete'],
  ];
  for (const [message, expectedCall] of rows) {
    const response = await router.dispatch({ envelope: parsed(message), sender });
    assert.equal(response.ok, true);
    assert.equal(calls.at(-1)[0], expectedCall);
    if (expectedCall === 'delete-all') {
      assert.equal(calls.at(-2)[0], 'authorize-report');
      assert.equal(calls.at(-1).length, 1);
      continue;
    }
    assert.deepEqual(Object.keys(calls.at(-1)[1]).sort(), expectedCall === 'export-complete'
      ? ['attemptId', 'auditId', 'sender', 'sessionCapabilityId']
      : expectedCall === 'review-commit'
        ? ['answer', 'auditId', 'decidedAt', 'evaluator', 'itemId', 'mode', 'note', 'occurrenceId']
        : expectedCall === 'delete-audit'
          ? ['auditId']
      : expectedCall === 'request-export'
        ? ['auditId', 'sender', 'sessionCapabilityId']
        : expectedCall === 'return-source'
          ? ['auditId', 'sender', 'sessionCapabilityId']
        : expectedCall === 'open'
          ? ['auditId', 'sourceSessionCapabilityId', 'sourceSessionState', 'windowId']
          : ['auditId', 'sender']);
  }
  const openCall = calls.find(([name]) => name === 'open');
  assert.deepEqual(openCall[1], {
    auditId: 'audit-1', windowId: 9,
    sourceSessionCapabilityId: SESSION, sourceSessionState: 'result',
  });
  assert.doesNotMatch(JSON.stringify(calls), /model|summary|projection|bytes|formats/iu);
});

test('denies report launch when the authorized source session is not exact or no longer report-capable', async t => {
  for (const [name, session] of [
    ['capability', { auditId: 'audit-1', sessionCapabilityId: 'X'.repeat(22), windowId: 9, state: 'result' }],
    ['state', { auditId: 'audit-1', sessionCapabilityId: SESSION, windowId: 9, state: 'running' }],
  ]) await t.test(name, async () => {
    const calls = [];
    const reportLaunch = {
      async openRegisteredReport(value) { calls.push(value); return { ok: true }; },
    };
    const { router, dependencies } = fixture({ reportLaunch, exportLaunch: {} });
    dependencies.authority.authorizeSession = async () => ({
      ok: true, session, context: { windowId: 9 },
    });
    const response = await router.dispatch({
      envelope: parsed({ type: 'PANEL_OPEN_REPORT', sessionCapabilityId: SESSION, auditId: 'audit-1', windowId: 9 }),
      sender: panelSender(),
    });
    assert.deepEqual(response, { ok: false, code: 'REPORT_OPEN_DENIED' });
    assert.deepEqual(calls, []);
  });
});

test('denies report mutations before storage effects when report session authority rejects', async () => {
  const calls = [];
  const reportLaunch = {
    async authorizeIntent(value) { calls.push(['authorize-report', value]); return { ok: false, code: 'REPORT_INTENT_DENIED' }; },
  };
  const reportOperations = {
    async commitReviewDecision(value) { calls.push(['review-commit', value]); return { ok: true }; },
    async deleteAudit(value) { calls.push(['delete-audit', value]); return { ok: true }; },
    async deleteAllAudits() { calls.push(['delete-all']); return { ok: true }; },
  };
  const { router } = fixture({ reportLaunch, reportOperations, exportLaunch: {} });
  for (const message of [
    REVIEW_DECISION_MESSAGE,
    { type: 'REPORT_DELETE_AUDIT', sessionCapabilityId: SESSION, auditId: 'audit-1' },
    { type: 'REPORT_DELETE_ALL_AUDITS', sessionCapabilityId: SESSION, auditId: 'audit-1' },
  ]) {
    calls.length = 0;
    const response = await router.dispatch({ envelope: parsed(message), sender: panelSender() });
    assert.deepEqual(response, { ok: false, code: 'REPORT_OPERATION_DENIED' });
    assert.deepEqual(calls.map(call => call[0]), ['authorize-report']);
  }
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

test('projects one confirmed privacy-paused cleanup as a closed revoked success', async () => {
  let confirmedCleanups = 0;
  const { router } = fixture({
    auditStarter: {
      async beginAuthorizedAudit() { throw new Error('unused'); },
      async resumePrivacyPausedAudit() { throw new Error('unused'); },
      async abortAuthorizedAudit(value) {
        confirmedCleanups += 1;
        return { ok: true, auditId: value.auditId, state: 'revoked' };
      },
    },
  });

  const response = await router.dispatch({
    envelope: parsed({
      type: 'PANEL_CANCEL_AUDIT', sessionCapabilityId: SESSION,
      auditId: 'audit-paused-cancel', windowId: 9,
    }),
    sender: panelSender(),
  });

  assert.deepEqual(response, {
    ok: true, auditId: 'audit-paused-cancel', state: 'revoked',
  });
  assert.deepEqual(Reflect.ownKeys(response), ['ok', 'auditId', 'state']);
  assert.equal(confirmedCleanups, 1);
});

test('denies foreign, malformed and unknown revoked cancellation outputs', async t => {
  const cases = [
    ['foreign audit', { ok: true, auditId: 'audit-foreign', state: 'revoked' }],
    ['revoked without success', { ok: false, auditId: 'audit-cancel', state: 'revoked' }],
    ['unknown state', { ok: true, auditId: 'audit-cancel', state: 'finished' }],
    ['extra consent detail', {
      ok: true, auditId: 'audit-cancel', state: 'revoked', consentId: CONSENT,
    }],
    ['accessor state', Object.defineProperty({ ok: true, auditId: 'audit-cancel' }, 'state', {
      enumerable: true, get() { return 'revoked'; },
    })],
  ];

  for (const [name, outcome] of cases) await t.test(name, async () => {
    let abortCalls = 0;
    const { router } = fixture({
      auditStarter: {
        async beginAuthorizedAudit() { throw new Error('unused'); },
        async resumePrivacyPausedAudit() { throw new Error('unused'); },
        async abortAuthorizedAudit() { abortCalls += 1; return outcome; },
      },
    });
    const response = await router.dispatch({
      envelope: parsed({
        type: 'PANEL_CANCEL_AUDIT', sessionCapabilityId: SESSION,
        auditId: 'audit-cancel', windowId: 9,
      }),
      sender: panelSender(),
    });
    assert.deepEqual(response, { ok: false, code: 'AUDIT_CANCEL_DENIED' });
    assert.equal(abortCalls, 1);
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
    const { router, durableSessions, calls } = fixture({
      panelScopeOverrides: {
        async registerAndPublishViewOnly() { return { registered: true, delivered: true }; },
      },
    });
    assert.deepEqual(await router.dispatch({
      envelope: parsed({ type: 'PANEL_REHYDRATE_VIEW', auditId: 'audit-register-success', windowId: 9 }),
      sender: panelSender(),
    }), { ok: true, auditId: 'audit-register-success', state: 'view-only' });
    assert.deepEqual(durableSessions.get(SESSION), { auditId: 'audit-register-success', state: 'view-only' });
    assert.equal(calls.some(([name]) => name === 'revoke'), false);
  });
});

test('rehydration revokes its minted session when registration does not reach the live Port', async () => {
  let registrations = 0;
  const { router, durableSessions, calls } = fixture({
    panelScopeOverrides: {
      async registerAndPublishViewOnly() {
        registrations += 1;
        return { registered: true, delivered: false };
      },
    },
  });

  const response = await router.dispatch({
    envelope: parsed({ type: 'PANEL_REHYDRATE_VIEW', auditId: 'audit-undelivered-view', windowId: 9 }),
    sender: panelSender(),
  });

  assert.deepEqual(response, { ok: false, code: 'AUDIT_REHYDRATE_DENIED' });
  assert.deepEqual(durableSessions.get(SESSION), { auditId: 'audit-undelivered-view', state: 'revoked' });
  assert.equal(registrations, 1);
  assert.equal(calls.filter(([name]) => name === 'revoke').length, 1);
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
