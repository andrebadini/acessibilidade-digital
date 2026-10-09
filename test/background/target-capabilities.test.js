import assert from 'node:assert/strict';
import test from 'node:test';

import * as targetCapabilitiesModule from '../../src/background/target-capabilities.js';
import {
  EXPORT_SURFACE,
  PANEL_SURFACE,
  REVIEW_SURFACE,
  createTargetCapabilityAuthority,
  deriveTrustedExtensionContext,
  navigationCapabilityStorageKey,
  readAttachedAuditCorrelationForRecovery,
  readAuditSessionForWorker,
  readBatchAuditCorrelationForRecovery,
  readClaimedAttachedAuditGrant,
  readPreparedAttachedAuditFact,
  sessionCapabilityStorageKey,
  targetCapabilityStorageKey,
} from '../../src/background/target-capabilities.js';

const TARGET_KEYS = ['version', 'capabilityId', 'kind', 'tabId', 'windowId', 'documentId', 'initialUrlEvidence', 'initialUrlSessionDigest', 'createdBy', 'allowedIntent', 'issuer', 'sessionCapabilityId', 'issuedAt', 'expiresAt', 'state'];
const SESSION_KEYS = ['version', 'sessionCapabilityId', 'auditId', 'windowId', 'mode', 'targetBinding', 'consumers', 'intents', 'state', 'issuedAt', 'expiresAt'];
const DIGEST = `hmac-sha256:${'A'.repeat(43)}`;
const LAUNCH_TOKEN = 'L'.repeat(43);
const PANEL_URL = `chrome-extension://test/src/panel/index.html?launch=${LAUNCH_TOKEN}`;

function createStorageArea() {
  const values = {};
  const unsafeValues = new Map();
  const reads = [];
  const writes = [];
  const removals = [];
  return {
    reads,
    writes,
    removals,
    unsafeSet(key, value) { unsafeValues.set(key, value); },
    async get(key) {
      reads.push(structuredClone(key));
      if (key === null) return { ...structuredClone(values), ...Object.fromEntries(unsafeValues) };
      if (Array.isArray(key)) {
        const result = {};
        for (const entry of key) {
          if (unsafeValues.has(entry)) result[entry] = unsafeValues.get(entry);
          else if (Object.hasOwn(values, entry)) result[entry] = structuredClone(values[entry]);
        }
        return result;
      }
      if (unsafeValues.has(key)) return { [key]: unsafeValues.get(key) };
      if (typeof key === 'string') return Object.hasOwn(values, key) ? { [key]: structuredClone(values[key]) } : {};
      throw new TypeError('test key');
    },
    async set(entries) {
      writes.push({ keys: Object.keys(entries), value: structuredClone(entries) });
      Object.assign(values, structuredClone(entries));
    },
    async remove(key) {
      const keys = Array.isArray(key) ? key : [key];
      removals.push([...keys]);
      for (const entry of keys) {
        delete values[entry];
        unsafeValues.delete(entry);
      }
    },
  };
}

function extensionContext(documentId = 'panel-document-1', windowId = 9) {
  return Object.freeze({
    issuer: Object.freeze({ type: 'extension-document', documentId, path: PANEL_SURFACE.path }),
    windowId,
    tabId: null,
    contextType: PANEL_SURFACE.contextType,
    documentUrl: PANEL_URL,
  });
}

function surfaceContext(surface, documentId = 'surface-document-1', windowId = 9) {
  return Object.freeze({
    issuer: Object.freeze({ type: 'extension-document', documentId, path: surface.path }),
    windowId,
    tabId: surface === PANEL_SURFACE ? null : 71,
    contextType: surface.contextType,
    documentUrl: `chrome-extension://test${surface.path}${surface.allowQuery === 'auditId-only' ? '?auditId=audit-1' : ''}`,
  });
}

function panelChromeApi(sender, overrides = {}) {
  const calls = [];
  const chromeApi = {
    runtime: {
      id: 'test',
      async getContexts() {
        calls.push(['contexts', sender.documentId]);
        return [{
          documentId: sender.documentId, documentUrl: sender.url,
          contextType: 'SIDE_PANEL', tabId: -1, windowId: -1,
        }];
      },
    },
    windows: {
      async get(windowId, options) {
        calls.push(['window', windowId, options]);
        return { id: windowId, focused: false, type: 'normal' };
      },
    },
    tabs: {
      async query(queryInfo) {
        calls.push(['tabs', queryInfo]);
        return [{ id: 41, windowId: queryInfo.windowId, active: true, status: 'complete', url: 'https://example.test/path', pendingUrl: '' }];
      },
    },
    ...overrides,
  };
  return { chromeApi, calls };
}

function authorityFixture(options = {}) {
  const sessionArea = options.sessionArea ?? createStorageArea();
  const randomValues = [new Uint8Array(16).fill(1), new Uint8Array(16).fill(2), new Uint8Array(16).fill(3)];
  const proof = {
    tabId: 41,
    windowId: 9,
    documentId: 'target-document-1',
    urlSessionDigest: DIGEST,
  };
  const authority = createTargetCapabilityAuthority({
    chromeApi: options.chromeApi ?? { runtime: { id: 'test' } },
    sessionArea,
    now: options.now ?? (() => 1_788_000_000_000),
    randomBytes: options.randomBytes ?? (() => randomValues.shift() ?? new Uint8Array(16).fill(4)),
    probeDocument: options.probeDocument ?? (async () => structuredClone(proof)),
  });
  return { authority, sessionArea, proof };
}

async function prepareAttached(authority, issuer = extensionContext().issuer) {
  return authority.prepare({
    kind: 'attached',
    tabId: 41,
    windowId: 9,
    documentId: 'target-document-1',
    initialUrlEvidence: 'https://example.test/path',
    initialUrlSessionDigest: DIGEST,
    createdBy: 'user',
    allowedIntent: 'start-audit',
    issuer,
  });
}

async function preparePersona(authority, issuer = extensionContext().issuer) {
  return authority.prepare({
    kind: 'attached',
    tabId: 41,
    windowId: 9,
    documentId: 'target-document-1',
    initialUrlEvidence: 'https://example.test/path',
    initialUrlSessionDigest: DIGEST,
    createdBy: 'user',
    allowedIntent: 'start-persona',
    issuer,
  });
}

const validStart = capabilityId => ({
  capabilityId,
  auditId: 'audit-1',
  mode: 'attached',
  allowedIntent: 'start-audit',
  senderContext: extensionContext(),
});

test('exports only the three frozen trusted-surface constants', () => {
  assert.deepEqual(PANEL_SURFACE, { path: '/src/panel/index.html', contextType: 'SIDE_PANEL', allowQuery: 'launch-only' });
  assert.deepEqual(REVIEW_SURFACE, { path: '/src/review/index.html', contextType: 'TAB', allowQuery: 'auditId-only' });
  assert.deepEqual(EXPORT_SURFACE, { path: '/src/export/index.html', contextType: 'TAB', allowQuery: 'auditId-only' });
  assert.equal([PANEL_SURFACE, REVIEW_SURFACE, EXPORT_SURFACE].every(Object.isFrozen), true);
});

test('does not trust an object shaped like the removed popup surface', async () => {
  const sender = { id: 'test', documentId: 'popup-document', url: 'chrome-extension://test/src/popup/index.html' };
  const chromeApi = { runtime: { id: 'test', async getContexts() { return [{ documentId: 'popup-document', documentUrl: sender.url, contextType: 'POPUP', windowId: -1 }]; } } };
  await assert.rejects(() => deriveTrustedExtensionContext({
    sender, chromeApi, surface: Object.freeze({ path: '/src/popup/index.html', contextType: 'POPUP', allowQuery: false }),
  }), /CONTEXT_DENIED/u);
});

test('accepts only an exact tokenized Side Panel URL with one native document identity', async () => {
  const sender = {
    id: 'test', documentId: 'panel-document-1',
    url: PANEL_URL,
  };
  const { chromeApi, calls } = panelChromeApi(sender);
  const context = await deriveTrustedExtensionContext({ sender, chromeApi, surface: PANEL_SURFACE, claimedWindowId: 9 });
  assert.equal(context.contextType, 'SIDE_PANEL');
  assert.equal(context.tabId, null);
  assert.equal(context.windowId, 9);
  assert.deepEqual(context.issuer, { type: 'extension-document', documentId: 'panel-document-1', path: PANEL_SURFACE.path });
  assert.deepEqual(calls, [
    ['contexts', 'panel-document-1'],
    ['window', 9, { populate: false }],
    ['tabs', { active: true, windowId: 9 }],
  ]);
});

test('keeps the default panel and malformed launch URLs unprivileged', async () => {
  for (const url of [
    'chrome-extension://test/src/panel/index.html',
    'chrome-extension://test/src/panel/index.html?launch=short',
    `${PANEL_URL}&launch=${'M'.repeat(43)}`,
    `${PANEL_URL}&extra=1`,
    `${PANEL_URL}#fragment`,
  ]) {
    const sender = { id: 'test', documentId: 'panel-document-1', url };
    const { chromeApi } = panelChromeApi(sender);
    await assert.rejects(
      () => deriveTrustedExtensionContext({ sender, chromeApi, surface: PANEL_SURFACE, claimedWindowId: 9 }),
      /CONTEXT_DENIED/u,
      url,
    );
  }
});

test('rejects a native Side Panel message sender without documentId even when URL origin and window look valid', async () => {
  const url = 'chrome-extension://test/src/panel/index.html';
  const sender = { id: 'test', url, origin: 'chrome-extension://test' };
  const calls = [];
  const chromeApi = {
    runtime: {
      id: 'test',
      async getContexts(filter) {
        calls.push(['contexts', filter]);
        return [{
          documentId: 'native-panel-document', documentUrl: url,
          contextType: 'SIDE_PANEL', tabId: -1, windowId: -1,
        }];
      },
    },
    windows: {
      async get(windowId, options) {
        calls.push(['window', windowId, options]);
        return { id: windowId, focused: false, type: 'normal' };
      },
    },
    tabs: {
      async query(queryInfo) {
        calls.push(['tabs', queryInfo]);
        return [{ id: 41, windowId: 9, active: true, status: 'complete', url: 'https://example.test/', pendingUrl: '' }];
      },
    },
  };

  await assert.rejects(
    () => deriveTrustedExtensionContext({ sender, chromeApi, surface: PANEL_SURFACE, claimedWindowId: 9 }),
    /CONTEXT_DENIED/u,
  );
  assert.deepEqual(calls, []);
});

test('never aliases a document-less Side Panel sender by its claimed window', async () => {
  const url = 'chrome-extension://test/src/panel/index.html';
  const sender = { id: 'test', url, origin: 'chrome-extension://test' };
  const chromeApi = {
    runtime: {
      id: 'test',
      async getContexts() {
        return [
          {
            documentId: 'native-panel-window-8', documentUrl: url,
            contextType: 'SIDE_PANEL', tabId: -1, windowId: 8,
          },
          {
            documentId: 'native-panel-window-9', documentUrl: url,
            contextType: 'SIDE_PANEL', tabId: -1, windowId: 9,
          },
        ];
      },
    },
    windows: {
      async get(windowId) { return { id: windowId, focused: true, type: 'normal' }; },
    },
    tabs: {
      async query({ windowId }) {
        return [{ id: 41, windowId, active: true, status: 'complete', url: 'https://example.test/', pendingUrl: '' }];
      },
    },
  };

  await assert.rejects(
    () => deriveTrustedExtensionContext({ sender, chromeApi, surface: PANEL_SURFACE, claimedWindowId: 9 }),
    /CONTEXT_DENIED/u,
  );
});

test('fails closed for every document-less sender shape', async () => {
  const url = PANEL_URL;
  for (const [name, sender, contexts] of [
    ['missing-origin', { id: 'test', url }, [{ documentId: 'native-panel', documentUrl: url, contextType: 'SIDE_PANEL', windowId: -1 }]],
    ['wrong-origin', { id: 'test', url, origin: 'chrome-extension://other' }, [{ documentId: 'native-panel', documentUrl: url, contextType: 'SIDE_PANEL', windowId: -1 }]],
    ['missing-context', { id: 'test', url, origin: 'chrome-extension://test' }, []],
    ['wrong-context', { id: 'test', url, origin: 'chrome-extension://test' }, [{ documentId: 'native-panel', documentUrl: url, contextType: 'TAB', windowId: -1 }]],
  ]) {
    const chromeApi = {
      runtime: { id: 'test', async getContexts() { return contexts; } },
      windows: { async get(windowId) { return { id: windowId, type: 'normal' }; } },
      tabs: { async query({ windowId }) { return [{ id: 41, windowId, active: true, status: 'complete', url: 'https://example.test/', pendingUrl: '' }]; } },
    };
    await assert.rejects(
      () => deriveTrustedExtensionContext({ sender, chromeApi, surface: PANEL_SURFACE, claimedWindowId: 9 }),
      /CONTEXT_DENIED/u,
      name,
    );
  }
});

test('rejects a SIDE_PANEL sentinel without one independently verified window claim', async () => {
  const sender = {
    id: 'test', documentId: 'panel-document-1',
    url: PANEL_URL,
  };
  const { chromeApi } = panelChromeApi(sender);
  await assert.rejects(
    () => deriveTrustedExtensionContext({ sender, chromeApi, surface: PANEL_SURFACE }),
    /CONTEXT_DENIED/u,
  );
});

test('denies wrong removed ambiguous loading pending and privileged window claims before returning authority', async t => {
  const sender = {
    id: 'test', documentId: 'panel-document-1',
    url: PANEL_URL,
  };
  const rows = [
    ['wrong-window', {
      windows: { async get() { return { id: 11, focused: false }; } },
    }],
    ['removed-window', {
      windows: { async get() { throw new Error('No window with id: 9.'); } },
    }],
    ['popup-window', {
      windows: { async get() { return { id: 9, focused: false, type: 'popup' }; } },
    }],
    ['app-window', {
      windows: { async get() { return { id: 9, focused: false, type: 'app' }; } },
    }],
    ['ambiguous-tab', {
      tabs: { async query() { return [
        { id: 41, windowId: 9, active: true, status: 'complete', url: 'https://example.test/', pendingUrl: '' },
        { id: 42, windowId: 9, active: true, status: 'complete', url: 'https://example.test/other', pendingUrl: '' },
      ]; } },
    }],
    ['inactive-tab', {
      tabs: { async query() { return [{ id: 41, windowId: 9, active: false, status: 'complete', url: 'https://example.test/', pendingUrl: '' }]; } },
    }],
    // Desde a 1.1.53 "loading" sem navegação pendente é aceito (recurso de terceiros que nunca termina); a
    // aba carregando OUTRO endereço continua recusada.
    ['loading-navigation-tab', {
      tabs: { async query() { return [{ id: 41, windowId: 9, active: true, status: 'loading', url: 'https://example.test/', pendingUrl: 'https://next.test/' }]; } },
    }],
    ['pending-tab', {
      tabs: { async query() { return [{ id: 41, windowId: 9, active: true, status: 'complete', url: 'https://example.test/', pendingUrl: 'https://next.test/' }]; } },
    }],
    ['privileged-tab', {
      tabs: { async query() { return [{ id: 41, windowId: 9, active: true, status: 'complete', url: 'chrome://settings/', pendingUrl: '' }]; } },
    }],
  ];
  for (const [name, override] of rows) await t.test(name, async () => {
    const { chromeApi } = panelChromeApi(sender, override);
    await assert.rejects(
      () => deriveTrustedExtensionContext({ sender, chromeApi, surface: PANEL_SURFACE, claimedWindowId: 9 }),
      /CONTEXT_DENIED/u,
    );
  });
});

test('rejects scheme host query context and document mismatches', async () => {
  const validUrl = PANEL_URL;
  const contexts = [{ documentId: 'panel-document-1', documentUrl: validUrl, contextType: 'SIDE_PANEL', windowId: 9 }];
  const { chromeApi } = panelChromeApi({ id: 'test', documentId: 'panel-document-1', url: validUrl }, {
    runtime: { id: 'test', async getContexts() { return contexts; } },
  });
  const senders = [
    { id: 'test', documentId: 'panel-document-1', url: 'https://test/src/panel/index.html' },
    { id: 'test', documentId: 'panel-document-1', url: 'chrome-extension://other/src/panel/index.html' },
    { id: 'test', documentId: 'panel-document-1', url: `${validUrl}&auditId=audit-1` },
    { id: 'test', documentId: 'panel-document-1', url: validUrl, contextOverride: 'TAB' },
    { id: 'test', documentId: 'unknown-document', url: validUrl },
  ];
  for (const sender of senders) {
    contexts[0].contextType = sender.contextOverride ?? 'SIDE_PANEL';
    await assert.rejects(
      () => deriveTrustedExtensionContext({ sender, chromeApi, surface: PANEL_SURFACE, claimedWindowId: 9 }),
      /CONTEXT_DENIED/u,
    );
  }
});

test('review and export allow exactly one closed auditId query', async () => {
  for (const surface of [REVIEW_SURFACE, EXPORT_SURFACE]) {
    const documentUrl = `chrome-extension://test${surface.path}?auditId=audit_1-2`;
    const sender = { id: 'test', documentId: 'document-1', url: documentUrl };
    const chromeApi = { runtime: { id: 'test', async getContexts() { return [{ documentId: 'document-1', documentUrl, contextType: 'TAB', windowId: 9, tabId: 71 }]; } } };
    assert.equal((await deriveTrustedExtensionContext({ sender, chromeApi, surface })).tabId, 71);
    for (const suffix of ['&extra=1', '&auditId=two', '#fragment']) {
      sender.url = `${documentUrl}${suffix}`;
      await assert.rejects(() => deriveTrustedExtensionContext({ sender, chromeApi, surface }), /CONTEXT_DENIED/u);
    }
  }
});

test('prepares an exact one-use target and atomically persists its running session', async () => {
  const { authority, sessionArea } = authorityFixture();
  assert.deepEqual(Object.keys(authority), ['prepare', 'prepareNavigationForPanel', 'exchangeAttachedForNavigationCopy', 'inspectPreparedTarget', 'claimPreparedTarget', 'inspectPreparedAuditTarget', 'claimAndIssueAuditSession', 'claimNavigationAndIssueAuditSession', 'claimExchangedAttachedCopyAndIssueAuditSession', 'claimWorkerEventAndIssueAuditSession', 'authorizeSession', 'transitionAuditSession', 'transitionDisposableAuditSession', 'transitionBatchAuditSession', 'invalidateCapability', 'invalidateForTab', 'invalidateForWindow', 'clearAudit', 'finalizeAudit', 'rehydrateViewOnly', 'renewResultSession']);
  const prepared = await prepareAttached(authority);
  const result = await authority.claimAndIssueAuditSession(validStart(prepared.capabilityId));
  assert.equal(result.ok, true);
  const target = (await sessionArea.get(targetCapabilityStorageKey(result.capabilityId)))[targetCapabilityStorageKey(result.capabilityId)];
  const session = (await sessionArea.get(sessionCapabilityStorageKey(result.sessionCapabilityId)))[sessionCapabilityStorageKey(result.sessionCapabilityId)];
  assert.deepEqual(Object.keys(target), TARGET_KEYS);
  assert.deepEqual(Object.keys(session), SESSION_KEYS);
  assert.equal(target.state, 'claimed');
  assert.equal(target.sessionCapabilityId, result.sessionCapabilityId);
  assert.equal(session.state, 'running');
  assert.deepEqual(session.targetBinding, { kind: 'attached', tabId: 41, documentId: 'target-document-1', urlSessionDigest: DIGEST });
  assert.deepEqual(session.consumers, [
    { name: 'panel', path: '/src/panel/index.html', contextType: 'SIDE_PANEL' },
    { name: 'review', path: '/src/review/index.html', contextType: 'TAB' },
  ]);
  assert.deepEqual(session.intents, {
    panel: { running: ['cancel'], 'privacy-paused': ['cancel', 'confirm-pixels'], result: ['open-report', 'highlight', 'review-markers'], 'view-only': ['open-report', 'review-markers'] },
    review: { running: [], 'privacy-paused': [], result: ['export', 'highlight'], 'view-only': ['export'] },
  });
  assert.equal(sessionArea.writes.at(-1).keys.length, 2);
  assert.deepEqual(await authority.claimAndIssueAuditSession(validStart(prepared.capabilityId)), { ok: false, code: 'CAPABILITY_UNAVAILABLE' });
});

test('single navigation capability is one-shot, panel-document bound, and issues a disposable session atomically', async () => {
  const { authority, sessionArea } = authorityFixture();
  const prepared = await authority.prepareNavigationForPanel({
    intent: 'single', senderContext: extensionContext(),
  });
  assert.equal(prepared.ok, true);
  const navigation = (await sessionArea.get(navigationCapabilityStorageKey(prepared.capabilityId)))[navigationCapabilityStorageKey(prepared.capabilityId)];
  assert.deepEqual(navigation, {
    version: 1, capabilityId: prepared.capabilityId, intent: 'single', windowId: 9,
    issuer: extensionContext().issuer, sessionCapabilityId: null,
    issuedAt: 1_788_000_000_000, expiresAt: 1_788_000_060_000, state: 'prepared',
  });
  const claim = {
    capabilityId: prepared.capabilityId, auditId: 'audit-url-1', ownershipId: `owner_${'A'.repeat(22)}`,
    intent: 'single', senderContext: extensionContext(),
  };
  const result = await authority.claimNavigationAndIssueAuditSession(claim);
  assert.equal(result.ok, true);
  assert.equal(result.auditId, 'audit-url-1');
  const session = (await sessionArea.get(sessionCapabilityStorageKey(result.sessionCapabilityId)))[sessionCapabilityStorageKey(result.sessionCapabilityId)];
  assert.equal(session.mode, 'single');
  assert.deepEqual(session.targetBinding, {
    kind: 'disposable', ownershipId: `owner_${'A'.repeat(22)}`, state: 'pending',
  });
  assert.equal(Object.hasOwn(session.targetBinding, 'ownerId'), false);
  assert.equal(session.state, 'running');
  assert.deepEqual(await authority.claimNavigationAndIssueAuditSession(claim), {
    ok: false, code: 'CAPABILITY_UNAVAILABLE',
  });
});

test('batch navigation capability binds and clears exactly one active owned page at a time', async () => {
  const { authority, sessionArea } = authorityFixture();
  const prepared = await authority.prepareNavigationForPanel({
    intent: 'batch', senderContext: extensionContext(),
  });
  assert.equal(prepared.ok, true);
  const claim = {
    capabilityId: prepared.capabilityId, auditId: 'audit-batch-1', ownershipId: null,
    intent: 'batch', senderContext: extensionContext(),
  };
  const result = await authority.claimNavigationAndIssueAuditSession(claim);
  assert.equal(result.ok, true);
  const sessionKey = sessionCapabilityStorageKey(result.sessionCapabilityId);
  assert.deepEqual((await sessionArea.get(sessionKey))[sessionKey].targetBinding, {
    kind: 'batch', activePageId: null, activeOwnershipId: null,
  });
  assert.deepEqual(await readBatchAuditCorrelationForRecovery({
    sessionArea,
    capabilityId: prepared.capabilityId,
    auditId: 'audit-batch-1',
  }), {
    version: 1,
    capabilityId: prepared.capabilityId,
    auditId: 'audit-batch-1',
    sessionCapabilityId: result.sessionCapabilityId,
    windowId: 9,
    capabilityState: 'claimed',
    sessionState: 'running',
    activePageId: null,
    activeOwnershipId: null,
    issuedAt: 1_788_000_000_000,
    expiresAt: 1_788_001_800_000,
  });
  const ownershipId = `owner_${'B'.repeat(22)}`;
  assert.deepEqual(await authority.transitionBatchAuditSession({
    sessionCapabilityId: result.sessionCapabilityId, auditId: 'audit-batch-1',
    fromPageId: null, fromOwnershipId: null, toPageId: 'page-1', toOwnershipId: ownershipId,
  }), {
    ok: true, sessionCapabilityId: result.sessionCapabilityId, auditId: 'audit-batch-1',
    activePageId: 'page-1', activeOwnershipId: ownershipId,
  });
  assert.deepEqual(await authority.transitionBatchAuditSession({
    sessionCapabilityId: result.sessionCapabilityId, auditId: 'audit-batch-1',
    fromPageId: null, fromOwnershipId: null, toPageId: 'page-2', toOwnershipId: `owner_${'C'.repeat(22)}`,
  }), { ok: false, code: 'SESSION_TRANSITION_DENIED' });
  assert.deepEqual(await authority.transitionBatchAuditSession({
    sessionCapabilityId: result.sessionCapabilityId, auditId: 'audit-batch-1',
    fromPageId: 'page-1', fromOwnershipId: ownershipId, toPageId: null, toOwnershipId: null,
  }), {
    ok: true, sessionCapabilityId: result.sessionCapabilityId, auditId: 'audit-batch-1',
    activePageId: null, activeOwnershipId: null,
  });
  assert.deepEqual(await authority.claimNavigationAndIssueAuditSession(claim), {
    ok: false, code: 'CAPABILITY_UNAVAILABLE',
  });
});

test('batch with one explicit active owner may pause and resume without changing its page binding', async () => {
  const { authority, sessionArea } = authorityFixture();
  const prepared = await authority.prepareNavigationForPanel({ intent: 'batch', senderContext: extensionContext() });
  const auditId = 'audit-batch-pixel-pause';
  const claimed = await authority.claimNavigationAndIssueAuditSession({
    capabilityId: prepared.capabilityId, auditId, ownershipId: null,
    intent: 'batch', senderContext: extensionContext(),
  });
  const ownershipId = `owner_${'P'.repeat(22)}`;
  assert.equal((await authority.transitionBatchAuditSession({
    sessionCapabilityId: claimed.sessionCapabilityId, auditId,
    fromPageId: null, fromOwnershipId: null, toPageId: 'page-1', toOwnershipId: ownershipId,
  })).ok, true);

  assert.deepEqual(await authority.transitionAuditSession({
    sessionCapabilityId: claimed.sessionCapabilityId, auditId, nextState: 'privacy-paused',
  }), {
    ok: true, sessionCapabilityId: claimed.sessionCapabilityId, auditId, state: 'privacy-paused',
  });
  const paused = await readBatchAuditCorrelationForRecovery({
    sessionArea, capabilityId: prepared.capabilityId, auditId,
  });
  assert.equal(paused.sessionState, 'privacy-paused');
  assert.equal(paused.activePageId, 'page-1');
  assert.equal(paused.activeOwnershipId, ownershipId);

  assert.equal((await authority.transitionAuditSession({
    sessionCapabilityId: claimed.sessionCapabilityId, auditId, nextState: 'running',
  })).state, 'running');
  const resumed = await readBatchAuditCorrelationForRecovery({
    sessionArea, capabilityId: prepared.capabilityId, auditId,
  });
  assert.equal(resumed.sessionState, 'running');
  assert.equal(resumed.activePageId, 'page-1');
  assert.equal(resumed.activeOwnershipId, ownershipId);
});

test('revoked batch session can only clear its existing owned page during recovery', async () => {
  const { authority } = authorityFixture();
  const prepared = await authority.prepareNavigationForPanel({
    intent: 'batch', senderContext: extensionContext(),
  });
  const auditId = 'audit-batch-recovery';
  const claimed = await authority.claimNavigationAndIssueAuditSession({
    capabilityId: prepared.capabilityId, auditId, ownershipId: null,
    intent: 'batch', senderContext: extensionContext(),
  });
  const ownershipId = `owner_${'R'.repeat(22)}`;
  assert.equal((await authority.transitionBatchAuditSession({
    sessionCapabilityId: claimed.sessionCapabilityId, auditId,
    fromPageId: null, fromOwnershipId: null, toPageId: 'page-1', toOwnershipId: ownershipId,
  })).ok, true);
  assert.equal((await authority.transitionAuditSession({
    sessionCapabilityId: claimed.sessionCapabilityId, auditId, nextState: 'revoked',
  })).ok, true);
  assert.deepEqual(await authority.transitionBatchAuditSession({
    sessionCapabilityId: claimed.sessionCapabilityId, auditId,
    fromPageId: 'page-1', fromOwnershipId: ownershipId, toPageId: null, toOwnershipId: null,
  }), {
    ok: true, sessionCapabilityId: claimed.sessionCapabilityId, auditId,
    activePageId: null, activeOwnershipId: null,
  });
  assert.deepEqual(await authority.transitionBatchAuditSession({
    sessionCapabilityId: claimed.sessionCapabilityId, auditId,
    fromPageId: null, fromOwnershipId: null, toPageId: 'page-2', toOwnershipId: `owner_${'S'.repeat(22)}`,
  }), { ok: false, code: 'SESSION_TRANSITION_DENIED' });
});

test('atomically exchanges a prepared attached target for an internal attached-copy navigation authority', async () => {
  let probeCalls = 0;
  const { authority, sessionArea } = authorityFixture({
    probeDocument: async () => {
      probeCalls += 1;
      return { tabId: 41, windowId: 9, documentId: 'target-document-1', urlSessionDigest: DIGEST };
    },
  });
  const prepared = await prepareAttached(authority);
  const targetKey = targetCapabilityStorageKey(prepared.capabilityId);
  const navigationKey = navigationCapabilityStorageKey(prepared.capabilityId);
  const writesBeforeExchange = sessionArea.writes.length;

  const exchanged = await authority.exchangeAttachedForNavigationCopy({
    capabilityId: prepared.capabilityId,
    intent: 'attached-copy',
    senderContext: extensionContext(),
  });

  assert.deepEqual(exchanged, {
    ok: true,
    capabilityId: prepared.capabilityId,
    expiresAt: 1_788_000_060_000,
  });
  assert.equal(probeCalls, 1);
  assert.equal(sessionArea.writes.length, writesBeforeExchange + 1);
  assert.deepEqual([...sessionArea.writes.at(-1).keys].sort(), [navigationKey, targetKey].sort());
  const target = (await sessionArea.get(targetKey))[targetKey];
  const navigation = (await sessionArea.get(navigationKey))[navigationKey];
  assert.equal(target.state, 'invalidated');
  assert.equal(target.sessionCapabilityId, null);
  assert.deepEqual(navigation, {
    version: 1,
    capabilityId: prepared.capabilityId,
    intent: 'attached-copy',
    windowId: 9,
    issuer: extensionContext().issuer,
    sessionCapabilityId: null,
    issuedAt: 1_788_000_000_000,
    expiresAt: 1_788_000_060_000,
    state: 'prepared',
  });
  assert.equal(Object.hasOwn(navigation, 'tabId'), false);
  assert.equal(Object.hasOwn(navigation, 'documentId'), false);
  assert.equal(Object.hasOwn(navigation, 'urlSessionDigest'), false);
  assert.equal(Object.hasOwn(navigation, 'rawUrl'), false);
  assert.deepEqual(await authority.exchangeAttachedForNavigationCopy({
    capabilityId: prepared.capabilityId,
    intent: 'attached-copy',
    senderContext: extensionContext(),
  }), { ok: false, code: 'CAPABILITY_UNAVAILABLE' });
  assert.deepEqual(await authority.claimAndIssueAuditSession(validStart(prepared.capabilityId)), {
    ok: false, code: 'CAPABILITY_UNAVAILABLE',
  });
  assert.deepEqual(await authority.claimNavigationAndIssueAuditSession({
    capabilityId: prepared.capabilityId,
    auditId: 'audit-copy-public-claim',
    ownershipId: `owner_${'A'.repeat(22)}`,
    intent: 'attached-copy',
    senderContext: extensionContext(),
  }), { ok: false, code: 'CAPABILITY_UNAVAILABLE' });
});

test('reads the exact attached-copy navigation graph before and after its internal claim', async () => {
  assert.equal(typeof targetCapabilitiesModule.readAttachedCopyNavigationForRecovery, 'function');
  const { authority, sessionArea } = authorityFixture();
  const prepared = await prepareAttached(authority);
  await authority.exchangeAttachedForNavigationCopy({
    capabilityId: prepared.capabilityId,
    intent: 'attached-copy',
    senderContext: extensionContext(),
  });

  assert.deepEqual(await targetCapabilitiesModule.readAttachedCopyNavigationForRecovery({
    sessionArea,
    capabilityId: prepared.capabilityId,
  }), {
    version: 1,
    capabilityId: prepared.capabilityId,
    windowId: 9,
    targetState: 'invalidated',
    navigationState: 'prepared',
    sessionCapabilityId: null,
  });

  const claimed = await authority.claimExchangedAttachedCopyAndIssueAuditSession({
    capabilityId: prepared.capabilityId,
    auditId: 'audit-copy-recovery-reader',
    ownershipId: `owner_${'R'.repeat(22)}`,
    senderContext: extensionContext(),
  });
  assert.equal(claimed.ok, true);
  assert.deepEqual(await targetCapabilitiesModule.readAttachedCopyNavigationForRecovery({
    sessionArea,
    capabilityId: prepared.capabilityId,
  }), {
    version: 1,
    capabilityId: prepared.capabilityId,
    windowId: 9,
    targetState: 'invalidated',
    navigationState: 'claimed',
    sessionCapabilityId: claimed.sessionCapabilityId,
  });
});

test('attached-copy cannot be prepared through the public navigation entry point', async () => {
  const { authority, sessionArea } = authorityFixture();
  await assert.rejects(
    () => authority.prepareNavigationForPanel({ intent: 'attached-copy', senderContext: extensionContext() }),
    /CAPABILITY_PREPARE_DENIED/u,
  );
  assert.deepEqual(await sessionArea.get(null), {});
});

test('claims an exchanged attached copy only through the worker-internal claim and binds one disposable owner', async () => {
  const { authority, sessionArea } = authorityFixture();
  const prepared = await prepareAttached(authority);
  const ownershipId = `owner_${'C'.repeat(22)}`;
  assert.equal((await authority.exchangeAttachedForNavigationCopy({
    capabilityId: prepared.capabilityId,
    intent: 'attached-copy',
    senderContext: extensionContext(),
  })).ok, true);

  const claimed = await authority.claimExchangedAttachedCopyAndIssueAuditSession({
    capabilityId: prepared.capabilityId,
    auditId: 'audit-attached-copy-claim',
    ownershipId,
    senderContext: extensionContext(),
  });

  assert.equal(claimed.ok, true);
  const navigationKey = navigationCapabilityStorageKey(prepared.capabilityId);
  const targetKey = targetCapabilityStorageKey(prepared.capabilityId);
  const sessionKey = sessionCapabilityStorageKey(claimed.sessionCapabilityId);
  assert.equal((await sessionArea.get(targetKey))[targetKey].state, 'invalidated');
  assert.deepEqual((await sessionArea.get(navigationKey))[navigationKey], {
    version: 1,
    capabilityId: prepared.capabilityId,
    intent: 'attached-copy',
    windowId: 9,
    issuer: extensionContext().issuer,
    sessionCapabilityId: claimed.sessionCapabilityId,
    issuedAt: 1_788_000_000_000,
    expiresAt: 1_788_000_060_000,
    state: 'claimed',
  });
  assert.deepEqual((await sessionArea.get(sessionKey))[sessionKey].targetBinding, {
    kind: 'disposable', ownershipId, state: 'pending',
  });
  assert.equal((await sessionArea.get(sessionKey))[sessionKey].mode, 'single');
  assert.deepEqual(await authority.claimNavigationAndIssueAuditSession({
    capabilityId: prepared.capabilityId,
    auditId: 'audit-public-copy-denied',
    ownershipId,
    intent: 'attached-copy',
    senderContext: extensionContext(),
  }), { ok: false, code: 'CAPABILITY_UNAVAILABLE' });
});

test('compensation invalidates both records sharing an attached-copy capability and revokes its exact running session', async () => {
  const { authority, sessionArea } = authorityFixture();
  const prepared = await prepareAttached(authority);
  const ownershipId = `owner_${'D'.repeat(22)}`;
  await authority.exchangeAttachedForNavigationCopy({
    capabilityId: prepared.capabilityId,
    intent: 'attached-copy',
    senderContext: extensionContext(),
  });
  const claimed = await authority.claimExchangedAttachedCopyAndIssueAuditSession({
    capabilityId: prepared.capabilityId,
    auditId: 'audit-attached-copy-compensation',
    ownershipId,
    senderContext: extensionContext(),
  });

  assert.deepEqual(await authority.invalidateCapability(
    prepared.capabilityId,
    'AUDIT_START_COMPENSATED',
  ), { ok: true, capabilityId: prepared.capabilityId });
  const targetKey = targetCapabilityStorageKey(prepared.capabilityId);
  const navigationKey = navigationCapabilityStorageKey(prepared.capabilityId);
  const sessionKey = sessionCapabilityStorageKey(claimed.sessionCapabilityId);
  assert.equal((await sessionArea.get(targetKey))[targetKey].state, 'invalidated');
  assert.equal((await sessionArea.get(navigationKey))[navigationKey].state, 'invalidated');
  assert.equal((await sessionArea.get(sessionKey))[sessionKey].state, 'revoked');
});

test('attached-copy exchange fails closed on issuer, window, expiry, or fresh document mismatch', async t => {
  const cases = [
    ['issuer', {
      prepareIssuer: extensionContext('other-panel').issuer,
      senderContext: extensionContext(),
    }],
    ['window', {
      prepareIssuer: extensionContext().issuer,
      senderContext: extensionContext('panel-document-1', 10),
    }],
    ['document', {
      prepareIssuer: extensionContext().issuer,
      senderContext: extensionContext(),
      probeDocument: async () => ({ tabId: 41, windowId: 9, documentId: 'document-b', urlSessionDigest: DIGEST }),
    }],
  ];
  for (const [name, options] of cases) {
    await t.test(name, async () => {
      const { authority, sessionArea } = authorityFixture({ probeDocument: options.probeDocument });
      const prepared = await prepareAttached(authority, options.prepareIssuer);
      const writesBeforeExchange = sessionArea.writes.length;
      assert.deepEqual(await authority.exchangeAttachedForNavigationCopy({
        capabilityId: prepared.capabilityId,
        intent: 'attached-copy',
        senderContext: options.senderContext,
      }), { ok: false, code: 'CAPABILITY_UNAVAILABLE' });
      assert.equal(sessionArea.writes.length, writesBeforeExchange);
      assert.equal((await sessionArea.get(targetCapabilityStorageKey(prepared.capabilityId)))[targetCapabilityStorageKey(prepared.capabilityId)].state, 'prepared');
      assert.deepEqual(await sessionArea.get(navigationCapabilityStorageKey(prepared.capabilityId)), {});
    });
  }

  let currentTime = 1_788_000_000_000;
  const { authority, sessionArea } = authorityFixture({ now: () => currentTime });
  const prepared = await prepareAttached(authority);
  currentTime += 60_000;
  const writesBeforeExchange = sessionArea.writes.length;
  assert.deepEqual(await authority.exchangeAttachedForNavigationCopy({
    capabilityId: prepared.capabilityId,
    intent: 'attached-copy',
    senderContext: extensionContext(),
  }), { ok: false, code: 'CAPABILITY_UNAVAILABLE' });
  assert.equal(sessionArea.writes.length, writesBeforeExchange);
});

test('attached-copy exchange confirms a commit-then-throw by exact readback', async () => {
  const base = createStorageArea();
  let throwAfterCommit = false;
  const sessionArea = {
    get: key => base.get(key),
    remove: key => base.remove(key),
    async set(value) {
      await base.set(value);
      if (throwAfterCommit) throw new Error('PRIVATE_SET_AFTER_COMMIT');
    },
  };
  const { authority } = authorityFixture({ sessionArea });
  const prepared = await prepareAttached(authority);
  throwAfterCommit = true;

  assert.deepEqual(await authority.exchangeAttachedForNavigationCopy({
    capabilityId: prepared.capabilityId,
    intent: 'attached-copy',
    senderContext: extensionContext(),
  }), {
    ok: true,
    capabilityId: prepared.capabilityId,
    expiresAt: 1_788_000_060_000,
  });
  assert.equal((await base.get(targetCapabilityStorageKey(prepared.capabilityId)))[targetCapabilityStorageKey(prepared.capabilityId)].state, 'invalidated');
  assert.equal((await base.get(navigationCapabilityStorageKey(prepared.capabilityId)))[navigationCapabilityStorageKey(prepared.capabilityId)].intent, 'attached-copy');
});

test('attached-copy exchange rejects expiry reached during its confirming storage read', async () => {
  const base = createStorageArea();
  let currentTime = 1_788_000_000_000;
  let exchangeReads = 0;
  const sessionArea = {
    set: value => base.set(value),
    remove: key => base.remove(key),
    async get(key) {
      const result = await base.get(key);
      if (Array.isArray(key)) {
        exchangeReads += 1;
        if (exchangeReads === 2) currentTime += 60_000;
      }
      return result;
    },
  };
  const { authority } = authorityFixture({ sessionArea, now: () => currentTime });
  const prepared = await prepareAttached(authority);

  assert.deepEqual(await authority.exchangeAttachedForNavigationCopy({
    capabilityId: prepared.capabilityId,
    intent: 'attached-copy',
    senderContext: extensionContext(),
  }), { ok: false, code: 'CAPABILITY_UNAVAILABLE' });
  assert.equal((await base.get(targetCapabilityStorageKey(prepared.capabilityId)))[targetCapabilityStorageKey(prepared.capabilityId)].state, 'prepared');
  assert.deepEqual(await base.get(navigationCapabilityStorageKey(prepared.capabilityId)), {});
});

test('single pixel session pauses only with its exact retained-consent owner and resumes only after owner CAS', async () => {
  const { authority, sessionArea } = authorityFixture();
  const ownershipId = `owner_${'A'.repeat(22)}`;
  const prepared = await authority.prepareNavigationForPanel({
    intent: 'single', senderContext: extensionContext(),
  });
  const claimed = await authority.claimNavigationAndIssueAuditSession({
    capabilityId: prepared.capabilityId, auditId: 'audit-url-pixel', ownershipId,
    intent: 'single', senderContext: extensionContext(),
  });
  const transitionOwner = (fromState, toState) => authority.transitionDisposableAuditSession({
    sessionCapabilityId: claimed.sessionCapabilityId, auditId: 'audit-url-pixel', ownershipId,
    fromState, toState,
  });
  const transitionSession = nextState => authority.transitionAuditSession({
    sessionCapabilityId: claimed.sessionCapabilityId, auditId: 'audit-url-pixel', nextState,
  });

  assert.deepEqual(await transitionSession('privacy-paused'), {
    ok: false, code: 'SESSION_TRANSITION_DENIED',
  });
  assert.equal((await transitionOwner('pending', 'observing')).state, 'observing');
  assert.deepEqual(await transitionSession('privacy-paused'), {
    ok: false, code: 'SESSION_TRANSITION_DENIED',
  });
  assert.equal((await transitionOwner('observing', 'retained-for-consent')).state, 'retained-for-consent');
  assert.equal((await transitionSession('privacy-paused')).state, 'privacy-paused');
  const paused = await readAuditSessionForWorker({
    sessionArea,
    sessionCapabilityId: claimed.sessionCapabilityId,
    auditId: 'audit-url-pixel',
  });
  assert.equal(paused.state, 'privacy-paused');
  assert.deepEqual(paused.targetBinding, { kind: 'disposable', ownershipId, state: 'retained-for-consent' });
  assert.deepEqual(await transitionSession('running'), {
    ok: false, code: 'SESSION_TRANSITION_DENIED',
  });
  assert.equal((await transitionOwner('retained-for-consent', 'observing')).state, 'observing');
  assert.equal((await transitionSession('running')).state, 'running');
});

test('single navigation capability rejects expiry and every cross-document or cross-window claim', async () => {
  for (const senderContext of [extensionContext('another-panel'), extensionContext('panel-document-1', 10)]) {
    const { authority } = authorityFixture();
    const prepared = await authority.prepareNavigationForPanel({ intent: 'single', senderContext: extensionContext() });
    assert.deepEqual(await authority.claimNavigationAndIssueAuditSession({
      capabilityId: prepared.capabilityId, auditId: 'audit-url-1', ownershipId: `owner_${'A'.repeat(22)}`,
      intent: 'single', senderContext,
    }), { ok: false, code: 'CAPABILITY_UNAVAILABLE' });
  }
  let clock = 1_788_000_000_000;
  const { authority } = authorityFixture({ now: () => clock });
  const prepared = await authority.prepareNavigationForPanel({ intent: 'single', senderContext: extensionContext() });
  clock += 60_000;
  assert.deepEqual(await authority.claimNavigationAndIssueAuditSession({
    capabilityId: prepared.capabilityId, auditId: 'audit-url-1', ownershipId: `owner_${'A'.repeat(22)}`,
    intent: 'single', senderContext: extensionContext(),
  }), { ok: false, code: 'CAPABILITY_UNAVAILABLE' });
});

test('rejects expiry reached while fresh document proof is pending without a claim/session write', async () => {
  let currentTime = 1_788_000_000_000;
  let releaseProbe;
  let probeStarted = false;
  const probeGate = new Promise(resolve => { releaseProbe = resolve; });
  const { authority, sessionArea } = authorityFixture({
    now: () => currentTime,
    probeDocument: async () => {
      probeStarted = true;
      await probeGate;
      return { tabId: 41, windowId: 9, documentId: 'target-document-1', urlSessionDigest: DIGEST };
    },
  });
  const prepared = await prepareAttached(authority);
  const writesBeforeClaim = sessionArea.writes.length;
  const pending = authority.claimAndIssueAuditSession(validStart(prepared.capabilityId));
  while (!probeStarted) await new Promise(resolve => setImmediate(resolve));
  currentTime += 60_001;
  releaseProbe();
  assert.deepEqual(await pending, { ok: false, code: 'CAPABILITY_UNAVAILABLE' });
  assert.equal(sessionArea.writes.length, writesBeforeClaim);
  assert.equal((await sessionArea.get(targetCapabilityStorageKey(prepared.capabilityId)))[targetCapabilityStorageKey(prepared.capabilityId)].state, 'prepared');
});

test('audit inspection returns the exact target without consuming either extension or worker-event authority', async () => {
  for (const workerEvent of [false, true]) {
    const { authority, sessionArea } = authorityFixture();
    const eventNonce = workerEvent ? 'nonce-12345678901234567890' : null;
    const prepared = await prepareAttached(authority, workerEvent
      ? { type: 'worker-event', event: 'context-menu', eventNonce }
      : extensionContext().issuer);
    const before = sessionArea.writes.length;
    const result = await authority.inspectPreparedAuditTarget({
      capabilityId: prepared.capabilityId,
      allowedIntent: 'start-audit',
      eventNonce,
      senderContext: workerEvent ? null : extensionContext(),
    });
    assert.deepEqual(result, {
      ok: true,
      target: {
        tabId: 41,
        windowId: 9,
        documentId: 'target-document-1',
        urlSessionDigest: DIGEST,
      },
    });
    assert.equal(sessionArea.writes.length, before);
    assert.equal((await sessionArea.get(targetCapabilityStorageKey(prepared.capabilityId)))[targetCapabilityStorageKey(prepared.capabilityId)].state, 'prepared');
  }
});

test('fails closed when intent issuer window context or fresh document proof differs', async () => {
  const variants = [
    start => ({ ...start, senderContext: extensionContext('another-panel') }),
    start => ({ ...start, senderContext: { ...extensionContext(), windowId: 10 } }),
    start => ({ ...start, senderContext: { ...extensionContext(), contextType: 'TAB' } }),
    start => ({ ...start, senderContext: { ...extensionContext(), documentUrl: 'chrome-extension://forged/src/panel/index.html' } }),
  ];
  for (const mutate of variants) {
    const { authority, sessionArea } = authorityFixture();
    const prepared = await prepareAttached(authority);
    assert.deepEqual(await authority.claimAndIssueAuditSession(mutate(validStart(prepared.capabilityId))), { ok: false, code: 'CAPABILITY_UNAVAILABLE' });
    assert.equal((await sessionArea.get(targetCapabilityStorageKey(prepared.capabilityId)))[targetCapabilityStorageKey(prepared.capabilityId)].state, 'prepared');
  }
  const { authority } = authorityFixture({ probeDocument: async () => ({ tabId: 41, windowId: 9, documentId: 'reloaded-document', urlSessionDigest: DIGEST }) });
  const prepared = await prepareAttached(authority);
  assert.deepEqual(await authority.claimAndIssueAuditSession(validStart(prepared.capabilityId)), { ok: false, code: 'CAPABILITY_UNAVAILABLE' });
});

test('accepts an exact persisted target shape independently of property insertion order', async () => {
  const { authority, sessionArea } = authorityFixture();
  const prepared = await prepareAttached(authority);
  const key = targetCapabilityStorageKey(prepared.capabilityId);
  const record = (await sessionArea.get(key))[key];
  const reordered = Object.fromEntries([...Object.entries(record)].reverse());
  await sessionArea.set({ [key]: reordered });
  assert.equal((await authority.claimAndIssueAuditSession(validStart(prepared.capabilityId))).ok, true);
});

test('worker event nonce cannot be replayed by another click', async () => {
  const { authority } = authorityFixture();
  const nonce = 'nonce-12345678901234567890';
  const prepared = await prepareAttached(authority, { type: 'worker-event', event: 'context-menu', eventNonce: nonce });
  const first = {
    capabilityId: prepared.capabilityId,
    auditId: 'audit-worker-1',
    mode: 'attached',
    allowedIntent: 'start-audit',
    eventNonce: nonce,
    senderContext: null,
  };
  assert.equal((await authority.claimWorkerEventAndIssueAuditSession(first)).ok, true);
  assert.deepEqual(await authority.claimWorkerEventAndIssueAuditSession(first), { ok: false, code: 'CAPABILITY_UNAVAILABLE' });
  assert.deepEqual(await authority.claimWorkerEventAndIssueAuditSession({ ...first, eventNonce: 'nonce-09876543210987654321' }), { ok: false, code: 'CAPABILITY_UNAVAILABLE' });
});

test('worker event claim rejects externally supplied window ownership and non-null sender context', async () => {
  const nonce = 'nonce-12345678901234567890';
  for (const extra of [{ windowId: 9 }, { senderContext: extensionContext() }]) {
    const { authority } = authorityFixture();
    const prepared = await prepareAttached(authority, { type: 'worker-event', event: 'context-menu', eventNonce: nonce });
    const claim = {
      capabilityId: prepared.capabilityId,
      auditId: 'audit-worker-1',
      mode: 'attached',
      allowedIntent: 'start-audit',
      eventNonce: nonce,
      senderContext: null,
      ...extra,
    };
    assert.deepEqual(await authority.claimWorkerEventAndIssueAuditSession(claim), { ok: false, code: 'CAPABILITY_UNAVAILABLE' });
  }
});

test('prepares, inspects and atomically claims a persona target without issuing an audit session', async () => {
  const { authority, sessionArea } = authorityFixture();
  const prepared = await preparePersona(authority);
  const input = {
    capabilityId: prepared.capabilityId,
    intent: 'start-persona',
    senderContext: extensionContext(),
  };
  const beforeInspect = sessionArea.writes.length;
  const inspected = await authority.inspectPreparedTarget(input);
  assert.deepEqual(inspected, {
    ok: true,
    target: {
      tabId: 41,
      windowId: 9,
      documentId: 'target-document-1',
      urlSessionDigest: DIGEST,
    },
  });
  assert.equal(Object.isFrozen(inspected), true);
  assert.equal(Object.isFrozen(inspected.target), true);
  assert.equal(sessionArea.writes.length, beforeInspect, 'inspection is read-only');

  const claimed = await authority.claimPreparedTarget(input);
  assert.deepEqual(claimed, inspected);
  const stored = await sessionArea.get(null);
  assert.equal(stored[targetCapabilityStorageKey(prepared.capabilityId)], undefined);
  assert.equal(Object.keys(stored).some(key => key.startsWith('audita:audit-session-capability:')), false);
  assert.deepEqual(sessionArea.removals, [[targetCapabilityStorageKey(prepared.capabilityId)]]);
  assert.deepEqual(await authority.claimPreparedTarget(input), { ok: false, code: 'CAPABILITY_UNAVAILABLE' });
});

test('persona capabilities are prepared and persisted only for the exact Side Panel surface', async () => {
  for (const surface of [REVIEW_SURFACE, EXPORT_SURFACE]) {
    const issuer = surfaceContext(surface).issuer;
    const { authority } = authorityFixture();
    await assert.rejects(() => preparePersona(authority, issuer), /CAPABILITY_PREPARE_DENIED/u);
  }

  for (const surface of [REVIEW_SURFACE, EXPORT_SURFACE]) {
    const capabilityId = surface === REVIEW_SURFACE ? 'R'.repeat(22) : 'E'.repeat(22);
    const { authority, sessionArea } = authorityFixture();
    const key = targetCapabilityStorageKey(capabilityId);
    await sessionArea.set({
      [key]: {
        version: 1,
        capabilityId,
        kind: 'attached',
        tabId: 41,
        windowId: 9,
        documentId: 'target-document-1',
        initialUrlEvidence: 'https://example.test/path',
        initialUrlSessionDigest: DIGEST,
        createdBy: 'user',
        allowedIntent: 'start-persona',
        issuer: surfaceContext(surface).issuer,
        sessionCapabilityId: null,
        issuedAt: 1_788_000_000_000,
        expiresAt: 1_788_000_060_000,
        state: 'prepared',
      },
    });
    const input = {
      capabilityId,
      intent: 'start-persona',
      senderContext: surfaceContext(surface),
    };
    assert.deepEqual(await authority.inspectPreparedTarget(input), { ok: false, code: 'CAPABILITY_UNAVAILABLE' });
    assert.deepEqual(await authority.claimPreparedTarget(input), { ok: false, code: 'CAPABILITY_UNAVAILABLE' });
    assert.equal((await sessionArea.get(key))[key].state, 'prepared', 'hostile fixture is never consumed');
  }
});

test('persona inspection and claim require the exact correlated Side Panel context', async () => {
  const invalidContexts = [
    { ...extensionContext(), tabId: 41 },
    { ...extensionContext(), contextType: 'TAB' },
    { ...extensionContext(), documentUrl: 'chrome-extension://test/src/panel/index.html?auditId=audit-1' },
    { ...extensionContext(), windowId: 10 },
    { ...extensionContext(), issuer: { ...extensionContext().issuer, documentId: 'another-panel-document' } },
  ];
  for (const senderContext of invalidContexts) {
    for (const operation of ['inspectPreparedTarget', 'claimPreparedTarget']) {
      const { authority } = authorityFixture();
      const prepared = await preparePersona(authority);
      assert.deepEqual(await authority[operation]({
        capabilityId: prepared.capabilityId,
        intent: 'start-persona',
        senderContext,
      }), { ok: false, code: 'CAPABILITY_UNAVAILABLE' });
    }
  }
});

test('persona inspection and claim both re-prove context expiry and the live document', async () => {
  const mutations = [
    input => ({ ...input, senderContext: extensionContext('forged-panel') }),
    input => ({ ...input, intent: 'start-audit' }),
    input => ({ ...input, tabId: 41 }),
  ];
  for (const mutate of mutations) {
    const { authority, sessionArea } = authorityFixture();
    const prepared = await preparePersona(authority);
    const input = {
      capabilityId: prepared.capabilityId,
      intent: 'start-persona',
      senderContext: extensionContext(),
    };
    assert.deepEqual(await authority.inspectPreparedTarget(mutate(input)), { ok: false, code: 'CAPABILITY_UNAVAILABLE' });
    assert.deepEqual(await authority.claimPreparedTarget(mutate(input)), { ok: false, code: 'CAPABILITY_UNAVAILABLE' });
    assert.equal((await sessionArea.get(targetCapabilityStorageKey(prepared.capabilityId)))[targetCapabilityStorageKey(prepared.capabilityId)].state, 'prepared');
  }

  let documentId = 'target-document-1';
  const { authority, sessionArea } = authorityFixture({
    probeDocument: async () => ({ tabId: 41, windowId: 9, documentId, urlSessionDigest: DIGEST }),
  });
  const prepared = await preparePersona(authority);
  const input = { capabilityId: prepared.capabilityId, intent: 'start-persona', senderContext: extensionContext() };
  assert.equal((await authority.inspectPreparedTarget(input)).ok, true);
  documentId = 'reloaded-document';
  assert.deepEqual(await authority.claimPreparedTarget(input), { ok: false, code: 'CAPABILITY_UNAVAILABLE' });
  assert.equal((await sessionArea.get(targetCapabilityStorageKey(prepared.capabilityId)))[targetCapabilityStorageKey(prepared.capabilityId)].state, 'prepared');
});

test('persona inspection and claim fail closed before proof when the clock regresses behind issuance', async () => {
  for (const operation of ['inspectPreparedTarget', 'claimPreparedTarget']) {
    let currentTime = 1_788_000_000_000;
    let probeCalls = 0;
    const { authority, sessionArea } = authorityFixture({
      now: () => currentTime,
      probeDocument: async () => {
        probeCalls += 1;
        return { tabId: 41, windowId: 9, documentId: 'target-document-1', urlSessionDigest: DIGEST };
      },
    });
    const prepared = await preparePersona(authority);
    currentTime -= 1;

    assert.deepEqual(await authority[operation]({
      capabilityId: prepared.capabilityId,
      intent: 'start-persona',
      senderContext: extensionContext(),
    }), { ok: false, code: 'CAPABILITY_UNAVAILABLE' });
    assert.equal(probeCalls, 0, `${operation} must reject before probing`);
    const key = targetCapabilityStorageKey(prepared.capabilityId);
    assert.equal((await sessionArea.get(key))[key].state, 'prepared');
  }
});

test('persona inspection and claim fail closed when the clock regresses during proof', async () => {
  for (const operation of ['inspectPreparedTarget', 'claimPreparedTarget']) {
    const issuedAt = 1_788_000_000_000;
    let currentTime = issuedAt;
    const { authority, sessionArea } = authorityFixture({
      now: () => currentTime,
      probeDocument: async () => {
        currentTime = issuedAt;
        return { tabId: 41, windowId: 9, documentId: 'target-document-1', urlSessionDigest: DIGEST };
      },
    });
    const prepared = await preparePersona(authority);
    currentTime = issuedAt + 1;

    assert.deepEqual(await authority[operation]({
      capabilityId: prepared.capabilityId,
      intent: 'start-persona',
      senderContext: extensionContext(),
    }), { ok: false, code: 'CAPABILITY_UNAVAILABLE' });
    const key = targetCapabilityStorageKey(prepared.capabilityId);
    assert.equal((await sessionArea.get(key))[key].state, 'prepared');
  }
});

test('two competing persona claims consume the capability at most once', async () => {
  const { authority, sessionArea } = authorityFixture();
  const prepared = await preparePersona(authority);
  const input = { capabilityId: prepared.capabilityId, intent: 'start-persona', senderContext: extensionContext() };
  const results = await Promise.all([
    authority.claimPreparedTarget(input),
    authority.claimPreparedTarget(input),
  ]);
  assert.equal(results.filter(result => result.ok === true).length, 1);
  assert.equal(results.filter(result => result.code === 'CAPABILITY_UNAVAILABLE').length, 1);
  const stored = await sessionArea.get(null);
  assert.equal(Object.keys(stored).length, 0);
});

test('persona invalidation and expiry remove the capability instead of retaining URL evidence', async t => {
  for (const [name, invalidate] of [
    ['exact', (authority, capabilityId) => authority.invalidateCapability(capabilityId, 'cancelled')],
    ['tab lifecycle', authority => authority.invalidateForTab(41, 'navigation')],
    ['window lifecycle', authority => authority.invalidateForWindow(9, 'window-removed')],
  ]) await t.test(name, async () => {
    const { authority, sessionArea } = authorityFixture();
    const prepared = await preparePersona(authority);
    const key = targetCapabilityStorageKey(prepared.capabilityId);
    const result = await invalidate(authority, prepared.capabilityId);
    assert.equal(result.ok, true);
    assert.equal((await sessionArea.get(key))[key], undefined);
    assert.deepEqual(sessionArea.removals, [[key]]);
  });

  for (const operation of ['inspectPreparedTarget', 'claimPreparedTarget']) await t.test(`expired ${operation}`, async () => {
    let currentTime = 1_788_000_000_000;
    let probeCalls = 0;
    const { authority, sessionArea } = authorityFixture({
      now: () => currentTime,
      probeDocument: async () => { probeCalls += 1; throw new Error('must not probe expired capability'); },
    });
    const prepared = await preparePersona(authority);
    const key = targetCapabilityStorageKey(prepared.capabilityId);
    currentTime += 60_000;
    assert.deepEqual(await authority[operation]({
      capabilityId: prepared.capabilityId,
      intent: 'start-persona',
      senderContext: extensionContext(),
    }), { ok: false, code: 'CAPABILITY_UNAVAILABLE' });
    assert.equal(probeCalls, 0);
    assert.equal((await sessionArea.get(key))[key], undefined);
    assert.deepEqual(sessionArea.removals, [[key]]);
  });
});

test('persona inspection deterministically purges legacy claimed and invalidated tombstones', async () => {
  for (const state of ['claimed', 'invalidated']) {
    const { authority, sessionArea } = authorityFixture();
    const prepared = await preparePersona(authority);
    const key = targetCapabilityStorageKey(prepared.capabilityId);
    const record = (await sessionArea.get(key))[key];
    await sessionArea.set({ [key]: { ...record, state } });
    assert.deepEqual(await authority.inspectPreparedTarget({
      capabilityId: prepared.capabilityId,
      intent: 'start-persona',
      senderContext: extensionContext(),
    }), { ok: false, code: 'CAPABILITY_UNAVAILABLE' });
    assert.equal((await sessionArea.get(key))[key], undefined);
    assert.deepEqual(sessionArea.removals, [[key]]);
  }
});

test('keeps a persona target rejected at every audit-only parser boundary', async () => {
  const capabilityId = 'P'.repeat(22);
  const sessionCapabilityId = 'S'.repeat(22);
  const currentTime = 1_788_000_000_000;
  let probeCalls = 0;
  const { authority, sessionArea } = authorityFixture({
    now: () => currentTime,
    probeDocument: async () => {
      probeCalls += 1;
      return { tabId: 41, windowId: 9, documentId: 'target-document-1', urlSessionDigest: DIGEST };
    },
  });
  const targetKey = targetCapabilityStorageKey(capabilityId);
  await sessionArea.set({
    [targetKey]: {
      version: 1,
      capabilityId,
      kind: 'attached',
      tabId: 41,
      windowId: 9,
      documentId: 'target-document-1',
      initialUrlEvidence: 'https://example.test/path',
      initialUrlSessionDigest: DIGEST,
      createdBy: 'user',
      allowedIntent: 'start-persona',
      issuer: extensionContext().issuer,
      sessionCapabilityId: null,
      issuedAt: currentTime,
      expiresAt: currentTime + 60_000,
      state: 'prepared',
    },
  });
  assert.equal(sessionArea.writes.length, 1, 'the only write is the hostile test injection');

  await assert.rejects(
    () => readPreparedAttachedAuditFact({ sessionArea, capabilityId, epochNow: () => currentTime }),
    /PREPARED_AUDIT_FACT_DENIED/u,
  );
  await assert.rejects(
    () => readClaimedAttachedAuditGrant({
      sessionArea, capabilityId, sessionCapabilityId, auditId: 'audit-persona', epochNow: () => currentTime,
    }),
    /CLAIMED_AUDIT_GRANT_DENIED/u,
  );
  await assert.rejects(
    () => readAttachedAuditCorrelationForRecovery({ sessionArea, capabilityId, auditId: 'audit-persona' }),
    /AUDIT_RECOVERY_CORRELATION_DENIED/u,
  );
  assert.deepEqual(await authority.claimAndIssueAuditSession({
    capabilityId,
    auditId: 'audit-persona',
    mode: 'attached',
    allowedIntent: 'start-audit',
    senderContext: extensionContext(),
  }), { ok: false, code: 'CAPABILITY_UNAVAILABLE' });
  assert.deepEqual(await authority.invalidateCapability(capabilityId, 'persona-invalidated'), {
    ok: true, capabilityId,
  });
  assert.deepEqual(await authority.invalidateForTab(41, 'persona-invalidated'), { ok: true, invalidated: 0 });
  assert.deepEqual(await authority.invalidateForWindow(9, 'persona-invalidated'), { ok: true, invalidated: 0 });

  assert.equal(probeCalls, 0);
  assert.equal(sessionArea.writes.length, 1, 'persona invalidation removes rather than rewriting URL evidence');
  assert.deepEqual(sessionArea.removals, [[targetKey]]);
  assert.deepEqual(Object.keys(await sessionArea.get(null)), []);
});

test('rejects unsanitized evidence URLs before persistence', async () => {
  for (const initialUrlEvidence of [
    'https://user:password@example.test/path',
    'https://example.test/path#private',
    'https://EXAMPLE.test',
  ]) {
    const { authority, sessionArea } = authorityFixture();
    await assert.rejects(() => authority.prepare({
      kind: 'attached',
      tabId: 41,
      windowId: 9,
      documentId: 'target-document-1',
      initialUrlEvidence,
      initialUrlSessionDigest: DIGEST,
      createdBy: 'user',
      allowedIntent: 'start-audit',
      issuer: extensionContext().issuer,
    }), /CAPABILITY_PREPARE_DENIED/u);
    assert.deepEqual(await sessionArea.get(null), {});
  }
});

test('serializes competing claims so only one can persist a session', async () => {
  const { authority, sessionArea } = authorityFixture();
  const prepared = await prepareAttached(authority);
  const [first, second] = await Promise.all([
    authority.claimAndIssueAuditSession(validStart(prepared.capabilityId)),
    authority.claimAndIssueAuditSession({ ...validStart(prepared.capabilityId), auditId: 'audit-2' }),
  ]);
  assert.equal([first, second].filter(result => result.ok).length, 1);
  assert.equal([first, second].filter(result => result.code === 'CAPABILITY_UNAVAILABLE').length, 1);
  assert.equal(sessionArea.writes.filter(write => write.keys.length === 2).length, 1);
});

test('authorizes only state consumer intent audit window path and context matches', async () => {
  const sender = { id: 'test', documentId: 'panel-document-1', url: PANEL_URL };
  const { chromeApi } = panelChromeApi(sender);
  const { authority } = authorityFixture({ chromeApi });
  const prepared = await prepareAttached(authority);
  const claimed = await authority.claimAndIssueAuditSession(validStart(prepared.capabilityId));
  assert.equal((await authority.authorizeSession({ sessionCapabilityId: claimed.sessionCapabilityId, auditId: 'audit-1', consumer: 'panel', intent: 'cancel', sender, claimedWindowId: 9 })).ok, true);
  for (const value of [
    { auditId: 'other', consumer: 'panel', intent: 'cancel' },
    { auditId: 'audit-1', consumer: 'panel', intent: 'open-report' },
    { auditId: 'audit-1', consumer: 'review', intent: 'export' },
  ]) {
    assert.deepEqual(await authority.authorizeSession({
      sessionCapabilityId: claimed.sessionCapabilityId, sender, ...value,
      ...(value.consumer === 'panel' ? { claimedWindowId: 9 } : {}),
    }), { ok: false, code: 'SESSION_DENIED' });
  }
  assert.equal((await authority.transitionAuditSession({ sessionCapabilityId: claimed.sessionCapabilityId, auditId: 'audit-1', nextState: 'result' })).ok, true);
  assert.equal((await authority.authorizeSession({ sessionCapabilityId: claimed.sessionCapabilityId, auditId: 'audit-1', consumer: 'panel', intent: 'open-report', sender, claimedWindowId: 9 })).ok, true);
  assert.equal((await authority.authorizeSession({ sessionCapabilityId: claimed.sessionCapabilityId, auditId: 'audit-1', consumer: 'panel', intent: 'highlight', sender, claimedWindowId: 9 })).ok, true);
  assert.deepEqual(await authority.transitionAuditSession({ sessionCapabilityId: claimed.sessionCapabilityId, auditId: 'audit-1', nextState: 'running' }), { ok: false, code: 'SESSION_TRANSITION_DENIED' });
});

test('review-markers belongs only to a terminal panel session, not review or active audit', async () => {
  const sender = { id: 'test', documentId: 'panel-document-1', url: PANEL_URL };
  const review = { id: 'test', documentId: 'review-document-1', url: 'chrome-extension://test/src/review/index.html?auditId=audit-1' };
  const { chromeApi } = panelChromeApi(sender);
  chromeApi.runtime.getContexts = async ({ documentIds }) => documentIds[0] === review.documentId
    ? [{ documentId: review.documentId, documentUrl: review.url, contextType: 'TAB', windowId: 9, tabId: 71 }]
    : [{ documentId: sender.documentId, documentUrl: PANEL_URL, contextType: 'SIDE_PANEL', tabId: -1, windowId: -1 }];
  const { authority } = authorityFixture({ chromeApi });
  const prepared = await prepareAttached(authority);
  const claimed = await authority.claimAndIssueAuditSession(validStart(prepared.capabilityId));
  const base = { sessionCapabilityId: claimed.sessionCapabilityId, auditId: 'audit-1', intent: 'review-markers' };
  const panel = () => authority.authorizeSession({ ...base, consumer: 'panel', sender, claimedWindowId: 9 });
  const denied = { ok: false, code: 'SESSION_DENIED' };
  assert.deepEqual(await panel(), denied);
  for (const state of ['privacy-paused', 'running', 'result', 'revoked']) {
    assert.equal((await authority.transitionAuditSession({
      sessionCapabilityId: claimed.sessionCapabilityId, auditId: 'audit-1', nextState: state,
    })).ok, true);
    if (state === 'result') {
      assert.equal((await panel()).ok, true);
      for (const change of [{ auditId: 'other' }, { claimedWindowId: 10 }, { sender: { ...sender, id: 'foreign' } }]) {
        assert.deepEqual(await authority.authorizeSession({ ...base, consumer: 'panel', sender, claimedWindowId: 9, ...change }), denied);
      }
    } else assert.deepEqual(await panel(), denied);
    assert.deepEqual(await authority.authorizeSession({ ...base, consumer: 'review', sender: review }), denied);
  }
});

test('review-markers can be requested by a fresh view-only panel without granting highlight', async () => {
  const sender = { id: 'test', documentId: 'panel-document-1', url: PANEL_URL };
  const { chromeApi } = panelChromeApi(sender);
  const { authority } = authorityFixture({ chromeApi });
  const session = await authority.rehydrateViewOnly({ auditId: 'audit-1', windowId: 9, mode: 'attached' });
  const base = { sessionCapabilityId: session.sessionCapabilityId, auditId: 'audit-1', consumer: 'panel', sender, claimedWindowId: 9 };
  assert.equal((await authority.authorizeSession({ ...base, intent: 'review-markers' })).ok, true);
  for (const intent of ['highlight', 'cancel', 'confirm-pixels']) {
    assert.deepEqual(await authority.authorizeSession({ ...base, intent }), { ok: false, code: 'SESSION_DENIED' });
  }
});

test('pre-markers sessions stay readable through result transition without a new grant', async () => {
  const sender = { id: 'test', documentId: 'panel-document-1', url: PANEL_URL };
  const { chromeApi } = panelChromeApi(sender);
  const { authority, sessionArea } = authorityFixture({ chromeApi });
  const prepared = await prepareAttached(authority);
  const claimed = await authority.claimAndIssueAuditSession(validStart(prepared.capabilityId));
  const key = sessionCapabilityStorageKey(claimed.sessionCapabilityId);
  const stored = (await sessionArea.get(key))[key];
  const intents = {
    panel: { running: ['cancel'], 'privacy-paused': ['cancel', 'confirm-pixels'], result: ['open-report', 'highlight'], 'view-only': ['open-report'] },
    review: { running: [], 'privacy-paused': [], result: ['export', 'highlight'], 'view-only': ['export'] },
  };
  await sessionArea.set({ [key]: { ...stored, intents } });
  assert.equal((await authority.transitionAuditSession({ sessionCapabilityId: claimed.sessionCapabilityId, auditId: 'audit-1', nextState: 'result' })).ok, true);
  const base = { sessionCapabilityId: claimed.sessionCapabilityId, auditId: 'audit-1', consumer: 'panel', sender, claimedWindowId: 9 };
  for (const intent of ['open-report', 'highlight']) assert.equal((await authority.authorizeSession({ ...base, intent })).ok, true);
  assert.deepEqual(await authority.authorizeSession({ ...base, intent: 'review-markers' }), { ok: false, code: 'SESSION_DENIED' });
  assert.deepEqual((await sessionArea.get(key))[key].intents, intents);
});

test('batch never receives review-markers even with a transplanted current grant table', async () => {
  const sender = { id: 'test', documentId: 'panel-document-1', url: PANEL_URL };
  const { chromeApi } = panelChromeApi(sender);
  const { authority, sessionArea } = authorityFixture({ chromeApi });
  const prepared = await authority.prepareNavigationForPanel({ intent: 'batch', senderContext: extensionContext() });
  const claimed = await authority.claimNavigationAndIssueAuditSession({ capabilityId: prepared.capabilityId, auditId: 'audit-1', ownershipId: null, intent: 'batch', senderContext: extensionContext() });
  assert.equal((await authority.transitionAuditSession({ sessionCapabilityId: claimed.sessionCapabilityId, auditId: 'audit-1', nextState: 'result' })).ok, true);
  const key = sessionCapabilityStorageKey(claimed.sessionCapabilityId);
  const stored = (await sessionArea.get(key))[key];
  assert.equal(stored.intents.panel.result.includes('review-markers'), false);
  const request = { sessionCapabilityId: claimed.sessionCapabilityId, auditId: 'audit-1', consumer: 'panel', sender, claimedWindowId: 9, intent: 'review-markers' };
  assert.deepEqual(await authority.authorizeSession(request), { ok: false, code: 'SESSION_DENIED' });
  const intents = structuredClone(stored.intents);
  intents.panel.result.push('review-markers');
  intents.panel['view-only'].push('review-markers');
  await sessionArea.set({ [key]: { ...stored, intents } });
  assert.equal((await authority.authorizeSession({ ...request, intent: 'open-report' })).ok, true);
  assert.deepEqual(await authority.authorizeSession(request), { ok: false, code: 'SESSION_DENIED' });
});

test('review-markers cannot be added to active or review grants in a nearly valid table', async () => {
  const sender = { id: 'test', documentId: 'panel-document-1', url: PANEL_URL };
  const { chromeApi } = panelChromeApi(sender);
  const { authority, sessionArea } = authorityFixture({ chromeApi });
  const prepared = await prepareAttached(authority);
  const claimed = await authority.claimAndIssueAuditSession(validStart(prepared.capabilityId));
  const key = sessionCapabilityStorageKey(claimed.sessionCapabilityId);
  const stored = (await sessionArea.get(key))[key];
  for (const [consumer, state] of [['panel', 'running'], ['panel', 'privacy-paused'], ['review', 'result'], ['review', 'view-only']]) {
    const intents = structuredClone(stored.intents);
    intents[consumer][state].push('review-markers');
    await sessionArea.set({ [key]: { ...stored, intents } });
    assert.deepEqual(await authority.authorizeSession({ sessionCapabilityId: claimed.sessionCapabilityId, auditId: 'audit-1', consumer: 'panel', intent: 'cancel', sender, claimedWindowId: 9 }), { ok: false, code: 'SESSION_DENIED' });
  }
});

test('authorizes the exact Side Panel privacy-paused intents and no review intent', async () => {
  const panelSender = { id: 'test', documentId: 'panel-document-1', url: PANEL_URL };
  const reviewUrl = 'chrome-extension://test/src/review/index.html?auditId=audit-1';
  const reviewSender = { id: 'test', documentId: 'review-document-1', url: reviewUrl };
  const { chromeApi } = panelChromeApi(panelSender);
  chromeApi.runtime.getContexts = async ({ documentIds }) => documentIds[0] === reviewSender.documentId
    ? [{ documentId: reviewSender.documentId, documentUrl: reviewUrl, contextType: 'TAB', windowId: 9, tabId: 71 }]
    : [{ documentId: panelSender.documentId, documentUrl: PANEL_URL, contextType: 'SIDE_PANEL', tabId: -1, windowId: -1 }];
  const { authority } = authorityFixture({ chromeApi });
  const prepared = await prepareAttached(authority);
  const claimed = await authority.claimAndIssueAuditSession(validStart(prepared.capabilityId));

  assert.equal((await authority.transitionAuditSession({
    sessionCapabilityId: claimed.sessionCapabilityId, auditId: 'audit-1', nextState: 'privacy-paused',
  })).ok, true);
  for (const intent of ['cancel', 'confirm-pixels']) {
    assert.equal((await authority.authorizeSession({
      sessionCapabilityId: claimed.sessionCapabilityId, auditId: 'audit-1', consumer: 'panel', intent,
      sender: panelSender, claimedWindowId: 9,
    })).ok, true);
  }
  for (const intent of ['cancel', 'confirm-pixels', 'export', 'highlight', 'open-report']) {
    assert.deepEqual(await authority.authorizeSession({
      sessionCapabilityId: claimed.sessionCapabilityId, auditId: 'audit-1', consumer: 'review', intent,
      sender: reviewSender,
    }), { ok: false, code: 'SESSION_DENIED' });
  }
});

test('enforces the closed privacy-paused transition graph and attached-only invariant', async () => {
  const { authority, sessionArea } = authorityFixture();
  const prepared = await prepareAttached(authority);
  const claimed = await authority.claimAndIssueAuditSession(validStart(prepared.capabilityId));
  const transition = nextState => authority.transitionAuditSession({
    sessionCapabilityId: claimed.sessionCapabilityId, auditId: 'audit-1', nextState,
  });

  assert.equal((await transition('privacy-paused')).state, 'privacy-paused');
  assert.deepEqual(await transition('result'), { ok: false, code: 'SESSION_TRANSITION_DENIED' });
  assert.equal((await transition('running')).state, 'running');
  assert.deepEqual(await transition('running'), { ok: false, code: 'SESSION_TRANSITION_DENIED' });
  assert.equal((await transition('result')).state, 'result');
  assert.deepEqual(await transition('privacy-paused'), { ok: false, code: 'SESSION_TRANSITION_DENIED' });
  assert.equal((await transition('revoked')).state, 'revoked');
  assert.deepEqual(await transition('revoked'), { ok: false, code: 'SESSION_TRANSITION_DENIED' });

  const key = sessionCapabilityStorageKey(claimed.sessionCapabilityId);
  const attached = (await sessionArea.get(key))[key];
  await sessionArea.set({
    [key]: {
      ...attached, state: 'running',
      targetBinding: { kind: 'disposable', ownershipId: 'owner-1', state: 'observing' },
    },
  });
  assert.deepEqual(await transition('privacy-paused'), { ok: false, code: 'SESSION_TRANSITION_DENIED' });
});

test('confirms transition commits, accepts commit-then-throw and rejects no-op or replacement', async t => {
  for (const behavior of ['commit-then-throw', 'no-op', 'replacement']) await t.test(behavior, async () => {
    const backing = createStorageArea();
    let intercept = false;
    const sessionArea = {
      ...backing,
      async set(entries) {
        const [key] = Object.keys(entries);
        const transitionWrite = intercept && key?.startsWith('audita:audit-session-capability:v1:') &&
          Object.keys(entries).length === 1;
        if (!transitionWrite) return backing.set(entries);
        if (behavior === 'no-op') return undefined;
        if (behavior === 'replacement') return backing.set({ [key]: { ...entries[key], state: 'revoked' } });
        await backing.set(entries);
        throw new Error('PRIVATE_COMMIT_THROW');
      },
    };
    const { authority } = authorityFixture({ sessionArea });
    const prepared = await prepareAttached(authority);
    const claimed = await authority.claimAndIssueAuditSession(validStart(prepared.capabilityId));
    intercept = true;

    const result = await authority.transitionAuditSession({
      sessionCapabilityId: claimed.sessionCapabilityId, auditId: 'audit-1', nextState: 'privacy-paused',
    });
    if (behavior === 'commit-then-throw') {
      assert.deepEqual(result, {
        ok: true, sessionCapabilityId: claimed.sessionCapabilityId, auditId: 'audit-1', state: 'privacy-paused',
      });
    } else {
      assert.deepEqual(result, { ok: false, code: 'SESSION_TRANSITION_DENIED' });
    }
  });
});

test('serializes transitions across authorities and denies replay or hostile inputs before storage effects', async () => {
  const sessionArea = createStorageArea();
  const first = authorityFixture({ sessionArea }).authority;
  const second = authorityFixture({ sessionArea }).authority;
  const prepared = await prepareAttached(first);
  const claimed = await first.claimAndIssueAuditSession(validStart(prepared.capabilityId));
  const transition = (authority, nextState) => authority.transitionAuditSession({
    sessionCapabilityId: claimed.sessionCapabilityId, auditId: 'audit-1', nextState,
  });
  const outcomes = await Promise.all([transition(first, 'privacy-paused'), transition(second, 'result')]);
  assert.equal(outcomes.filter(result => result.ok).length, 1);
  assert.equal(outcomes.filter(result => result.code === 'SESSION_TRANSITION_DENIED').length, 1);
  const winner = outcomes.find(result => result.ok).state;
  assert.deepEqual(await transition(first, winner), { ok: false, code: 'SESSION_TRANSITION_DENIED' });

  const readsBefore = sessionArea.reads.length;
  const writesBefore = sessionArea.writes.length;
  let getterCalls = 0;
  const accessor = {
    sessionCapabilityId: claimed.sessionCapabilityId,
    auditId: 'audit-1',
    nextState: 'revoked',
  };
  Object.defineProperty(accessor, 'nextState', {
    enumerable: true, get() { getterCalls += 1; return 'revoked'; },
  });
  const extra = {
    sessionCapabilityId: claimed.sessionCapabilityId, auditId: 'audit-1', nextState: 'revoked', extra: true,
  };
  const symbolic = {
    sessionCapabilityId: claimed.sessionCapabilityId, auditId: 'audit-1', nextState: 'revoked',
    [Symbol('private')]: true,
  };
  for (const hostile of [accessor, extra, symbolic]) {
    assert.deepEqual(await first.transitionAuditSession(hostile), { ok: false, code: 'SESSION_TRANSITION_DENIED' });
  }
  assert.equal(getterCalls, 0);
  assert.equal(sessionArea.reads.length, readsBefore);
  assert.equal(sessionArea.writes.length, writesBefore);
});

test('invalidates one exact capability without scanning unrelated records', async () => {
  const { authority, sessionArea } = authorityFixture();
  const first = await prepareAttached(authority);
  const second = await prepareAttached(authority);
  const writesBefore = sessionArea.writes.length;
  assert.deepEqual(await authority.invalidateCapability(first.capabilityId, 'cancelled'), { ok: true, capabilityId: first.capabilityId });
  assert.deepEqual(sessionArea.writes.at(-1).keys, [targetCapabilityStorageKey(first.capabilityId)]);
  assert.equal(sessionArea.writes.length, writesBefore + 1);
  assert.equal((await sessionArea.get(targetCapabilityStorageKey(second.capabilityId)))[targetCapabilityStorageKey(second.capabilityId)].state, 'prepared');
});

test('binds embedded target and session IDs to their storage locators at every boundary', async () => {
  const sender = { id: 'test', documentId: 'panel-document-1', url: PANEL_URL };
  const { chromeApi } = panelChromeApi(sender);

  {
    const { authority, sessionArea } = authorityFixture({ chromeApi });
    const first = await prepareAttached(authority);
    const second = await prepareAttached(authority);
    const firstKey = targetCapabilityStorageKey(first.capabilityId);
    const secondRecord = (await sessionArea.get(targetCapabilityStorageKey(second.capabilityId)))[targetCapabilityStorageKey(second.capabilityId)];
    await sessionArea.set({ [firstKey]: secondRecord });
    const writesBefore = sessionArea.writes.length;
    assert.deepEqual(await authority.claimAndIssueAuditSession(validStart(first.capabilityId)), { ok: false, code: 'CAPABILITY_UNAVAILABLE' });
    assert.equal(sessionArea.writes.length, writesBefore);
  }

  {
    const { authority, sessionArea } = authorityFixture({ chromeApi });
    const first = await prepareAttached(authority);
    const second = await prepareAttached(authority);
    const firstKey = targetCapabilityStorageKey(first.capabilityId);
    const secondRecord = (await sessionArea.get(targetCapabilityStorageKey(second.capabilityId)))[targetCapabilityStorageKey(second.capabilityId)];
    await sessionArea.set({ [firstKey]: secondRecord });
    const writesBefore = sessionArea.writes.length;
    assert.deepEqual(await authority.invalidateCapability(first.capabilityId, 'corrupt'), { ok: false, code: 'CAPABILITY_UNAVAILABLE' });
    assert.equal(sessionArea.writes.length, writesBefore);
    assert.equal((await sessionArea.get(firstKey))[firstKey].capabilityId, second.capabilityId);
  }

  {
    const { authority, sessionArea } = authorityFixture({ chromeApi });
    const prepared = await prepareAttached(authority);
    const claimed = await authority.claimAndIssueAuditSession(validStart(prepared.capabilityId));
    const realKey = sessionCapabilityStorageKey(claimed.sessionCapabilityId);
    const transplantedId = '______________________';
    const transplantedKey = sessionCapabilityStorageKey(transplantedId);
    await sessionArea.set({ [transplantedKey]: (await sessionArea.get(realKey))[realKey] });
    assert.deepEqual(await authority.authorizeSession({ sessionCapabilityId: transplantedId, auditId: 'audit-1', consumer: 'panel', intent: 'cancel', sender, claimedWindowId: 9 }), { ok: false, code: 'SESSION_DENIED' });
    const writesBefore = sessionArea.writes.length;
    assert.deepEqual(await authority.transitionAuditSession({ sessionCapabilityId: transplantedId, auditId: 'audit-1', nextState: 'result' }), { ok: false, code: 'SESSION_TRANSITION_DENIED' });
    assert.equal(sessionArea.writes.length, writesBefore);
  }
});

test('validates reordered closed intents structurally and rejects changed grants', async () => {
  const sender = { id: 'test', documentId: 'panel-document-1', url: PANEL_URL };
  const { chromeApi } = panelChromeApi(sender);
  const { authority, sessionArea } = authorityFixture({ chromeApi });
  const prepared = await prepareAttached(authority);
  const claimed = await authority.claimAndIssueAuditSession(validStart(prepared.capabilityId));
  const key = sessionCapabilityStorageKey(claimed.sessionCapabilityId);
  const session = (await sessionArea.get(key))[key];
  const reordered = {
    ...session,
    intents: {
      review: { 'view-only': ['export'], result: ['export', 'highlight'], running: [] },
      panel: { 'view-only': ['open-report'], result: ['open-report', 'highlight'], running: ['cancel'] },
    },
  };
  await sessionArea.set({ [key]: reordered });
  assert.equal((await authority.authorizeSession({ sessionCapabilityId: claimed.sessionCapabilityId, auditId: 'audit-1', consumer: 'panel', intent: 'cancel', sender, claimedWindowId: 9 })).ok, true);
  for (const intents of [
    { ...reordered.intents, extra: {} },
    { panel: { result: ['open-report', 'highlight'], 'view-only': ['open-report'] }, review: reordered.intents.review },
    { panel: { ...reordered.intents.panel, running: ['open-report', 'cancel'] }, review: reordered.intents.review },
  ]) {
    await sessionArea.set({ [key]: { ...session, intents } });
    assert.deepEqual(await authority.authorizeSession({ sessionCapabilityId: claimed.sessionCapabilityId, auditId: 'audit-1', consumer: 'panel', intent: 'cancel', sender, claimedWindowId: 9 }), { ok: false, code: 'SESSION_DENIED' });
  }
});

test('keeps a legacy V1 session readable without silently granting highlight', async () => {
  const sender = { id: 'test', documentId: 'panel-document-1', url: PANEL_URL };
  const { chromeApi } = panelChromeApi(sender);
  const { authority, sessionArea } = authorityFixture({ chromeApi });
  const prepared = await prepareAttached(authority);
  const claimed = await authority.claimAndIssueAuditSession(validStart(prepared.capabilityId));
  const key = sessionCapabilityStorageKey(claimed.sessionCapabilityId);
  const session = (await sessionArea.get(key))[key];
  const legacyIntents = {
    panel: { running: ['cancel'], result: ['open-report'], 'view-only': ['open-report'] },
    review: { running: [], result: ['export'], 'view-only': ['export'] },
  };
  await sessionArea.set({ [key]: { ...session, intents: legacyIntents } });

  assert.equal((await authority.authorizeSession({
    sessionCapabilityId: claimed.sessionCapabilityId, auditId: 'audit-1', consumer: 'panel',
    intent: 'cancel', sender, claimedWindowId: 9,
  })).ok, true);
  assert.equal((await authority.transitionAuditSession({
    sessionCapabilityId: claimed.sessionCapabilityId, auditId: 'audit-1', nextState: 'privacy-paused',
  })).ok, true);
  assert.deepEqual(await authority.authorizeSession({
    sessionCapabilityId: claimed.sessionCapabilityId, auditId: 'audit-1', consumer: 'panel',
    intent: 'confirm-pixels', sender, claimedWindowId: 9,
  }), { ok: false, code: 'SESSION_DENIED' });
  assert.equal((await authority.authorizeSession({
    sessionCapabilityId: claimed.sessionCapabilityId, auditId: 'audit-1', consumer: 'panel',
    intent: 'cancel', sender, claimedWindowId: 9,
  })).ok, true);
  assert.equal((await authority.transitionAuditSession({
    sessionCapabilityId: claimed.sessionCapabilityId, auditId: 'audit-1', nextState: 'running',
  })).ok, true);
  assert.equal((await authority.transitionAuditSession({
    sessionCapabilityId: claimed.sessionCapabilityId, auditId: 'audit-1', nextState: 'result',
  })).ok, true);
  assert.equal((await authority.authorizeSession({
    sessionCapabilityId: claimed.sessionCapabilityId, auditId: 'audit-1', consumer: 'panel',
    intent: 'open-report', sender, claimedWindowId: 9,
  })).ok, true);
  assert.deepEqual(await authority.authorizeSession({
    sessionCapabilityId: claimed.sessionCapabilityId, auditId: 'audit-1', consumer: 'panel',
    intent: 'highlight', sender, claimedWindowId: 9,
  }), { ok: false, code: 'SESSION_DENIED' });
  const persisted = (await sessionArea.get(key))[key];
  assert.deepEqual(persisted.intents, legacyIntents);
});

test('rejects hostile exact-shape accessors symbols and non-enumerable additions without invoking getters', async () => {
  let getterCalls = 0;
  const baseArgs = {
    kind: 'attached', tabId: 41, windowId: 9, documentId: 'target-document-1',
    initialUrlEvidence: 'https://example.test/path', initialUrlSessionDigest: DIGEST,
    createdBy: 'user', allowedIntent: 'start-audit', issuer: extensionContext().issuer,
  };
  const accessorArgs = { ...baseArgs };
  Object.defineProperty(accessorArgs, 'documentId', { enumerable: true, get() { getterCalls += 1; return 'target-document-1'; } });
  const { authority: prepareAuthority } = authorityFixture();
  await assert.rejects(() => prepareAuthority.prepare(accessorArgs), /CAPABILITY_PREPARE_DENIED/u);
  assert.equal(getterCalls, 0);

  for (const decorate of [
    record => { record[Symbol('hidden')] = true; },
    record => { Object.defineProperty(record, 'hidden', { value: true, enumerable: false }); },
    record => { Object.defineProperty(record, 'state', { enumerable: true, get() { getterCalls += 1; return 'prepared'; } }); },
  ]) {
    const { authority, sessionArea } = authorityFixture();
    const prepared = await prepareAttached(authority);
    const key = targetCapabilityStorageKey(prepared.capabilityId);
    const hostile = (await sessionArea.get(key))[key];
    decorate(hostile);
    sessionArea.unsafeSet(key, hostile);
    assert.deepEqual(await authority.claimAndIssueAuditSession(validStart(prepared.capabilityId)), { ok: false, code: 'CAPABILITY_UNAVAILABLE' });
  }
  assert.equal(getterCalls, 0);
});

async function claimedCleanupFixture(options = {}) {
  const fixture = authorityFixture(options);
  const prepared = await prepareAttached(fixture.authority);
  const claimed = await fixture.authority.claimAndIssueAuditSession(validStart(prepared.capabilityId));
  assert.equal(claimed.ok, true);
  return { ...fixture, prepared, claimed,
    targetKey: targetCapabilityStorageKey(prepared.capabilityId),
    sessionKey: sessionCapabilityStorageKey(claimed.sessionCapabilityId) };
}

test('audit-scoped authority cleanup revokes its attached, single, batch and view-only grants, preserving foreign and persona records', async () => {
  let random = 0;
  const sender = { id: 'test', documentId: 'panel-document-1', url: PANEL_URL };
  const { chromeApi } = panelChromeApi(sender);
  const f = await claimedCleanupFixture({ chromeApi, randomBytes: () => new Uint8Array(16).fill(++random) });
  const navigation = await f.authority.prepareNavigationForPanel({ intent: 'single', senderContext: extensionContext() });
  const navSession = await f.authority.claimNavigationAndIssueAuditSession({
    capabilityId: navigation.capabilityId, auditId: 'audit-1', ownershipId: `owner_${'O'.repeat(22)}`,
    intent: 'single', senderContext: extensionContext(),
  });
  assert.equal(navSession.ok, true);
  const batch = await f.authority.prepareNavigationForPanel({ intent: 'batch', senderContext: extensionContext() });
  const batchSession = await f.authority.claimNavigationAndIssueAuditSession({
    capabilityId: batch.capabilityId, auditId: 'audit-1', ownershipId: null,
    intent: 'batch', senderContext: extensionContext(),
  });
  assert.equal(batchSession.ok, true);
  const view = await f.authority.rehydrateViewOnly({ auditId: 'audit-1', windowId: 9, mode: 'attached' });
  const foreign = await prepareAttached(f.authority);
  assert.equal((await f.authority.claimAndIssueAuditSession({ ...validStart(foreign.capabilityId), auditId: 'audit-foreign' })).ok, true);
  await prepareAttached(f.authority);
  await f.authority.prepareNavigationForPanel({ intent: 'batch', senderContext: extensionContext() });
  const persona = await preparePersona(f.authority);
  const before = await f.sessionArea.get(null);
  const own = new Map([
    [f.targetKey, 'invalidated'], [f.sessionKey, 'revoked'],
    [navigationCapabilityStorageKey(navigation.capabilityId), 'invalidated'],
    [sessionCapabilityStorageKey(navSession.sessionCapabilityId), 'revoked'],
    [navigationCapabilityStorageKey(batch.capabilityId), 'invalidated'],
    [sessionCapabilityStorageKey(batchSession.sessionCapabilityId), 'revoked'],
    [sessionCapabilityStorageKey(view.sessionCapabilityId), 'revoked'],
  ]);
  assert.deepEqual(await f.authority.clearAudit('audit-1'), { ok: true, invalidated: 7 });
  const after = await f.sessionArea.get(null);
  assert.deepEqual(Object.keys(after), Object.keys(before));
  for (const [key, record] of Object.entries(before)) {
    assert.deepEqual(after[key], own.has(key) ? { ...record, state: own.get(key) } : record);
  }
  assert.deepEqual(await f.authority.authorizeSession({
    sessionCapabilityId: f.claimed.sessionCapabilityId, auditId: 'audit-1', consumer: 'panel',
    intent: 'cancel', sender, claimedWindowId: 9,
  }), { ok: false, code: 'SESSION_DENIED' });
  const writes = f.sessionArea.writes.length;
  assert.deepEqual(await f.authority.clearAudit('audit-1'), { ok: true, invalidated: 0 });
  assert.equal(f.sessionArea.writes.length, writes);
  assert.equal((await f.authority.inspectPreparedTarget({
    capabilityId: persona.capabilityId, intent: 'start-persona', senderContext: extensionContext(),
  })).ok, true);
});

test('audit-scoped authority cleanup waits for an earlier claim across authorities before revoking it', async () => {
  let releaseProof;
  let started;
  const proofStarted = new Promise(resolve => { started = resolve; });
  const f = authorityFixture({ probeDocument: () => new Promise(resolve => {
    releaseProof = () => resolve(structuredClone(f.proof)); started();
  }) });
  const prepared = await prepareAttached(f.authority);
  const claiming = f.authority.claimAndIssueAuditSession(validStart(prepared.capabilityId));
  await proofStarted;
  const second = authorityFixture({ sessionArea: f.sessionArea }).authority;
  const clearing = second.clearAudit('audit-1');
  releaseProof();
  const claimed = await claiming;
  assert.equal(claimed.ok, true);
  assert.deepEqual(await clearing, { ok: true, invalidated: 2 });
  const key = sessionCapabilityStorageKey(claimed.sessionCapabilityId);
  assert.equal((await f.sessionArea.get(key))[key].state, 'revoked');
  assert.deepEqual(await f.authority.transitionAuditSession({
    auditId: 'audit-1', sessionCapabilityId: claimed.sessionCapabilityId, nextState: 'result',
  }), { ok: false, code: 'SESSION_TRANSITION_DENIED' });
});

test('audit-scoped authority cleanup confirms commits and retries failures without exposing storage errors', async t => {
  for (const behavior of ['commit-then-throw', 'throw-before', 'no-op', 'partial', 'get-fails', 'readback-fails']) await t.test(behavior, async () => {
    const backing = createStorageArea();
    let intercept = false;
    const sessionArea = { ...backing,
      async get(key) {
        if (intercept && (behavior === 'get-fails' || behavior === 'readback-fails' && Array.isArray(key))) {
          throw new Error('PRIVATE_STORAGE_SENTINEL');
        }
        return backing.get(key);
      },
      async set(entries) {
        if (!intercept) return backing.set(entries);
        if (behavior === 'throw-before') throw new Error('PRIVATE_STORAGE_SENTINEL');
        if (behavior === 'no-op') return;
        if (behavior === 'partial') {
          const [key] = Object.keys(entries);
          await backing.set({ [key]: entries[key] });
          throw new Error('PRIVATE_STORAGE_SENTINEL');
        }
        await backing.set(entries);
        if (behavior === 'commit-then-throw') throw new Error('PRIVATE_STORAGE_SENTINEL');
      },
    };
    const f = await claimedCleanupFixture({ sessionArea });
    intercept = true;
    assert.deepEqual(await f.authority.clearAudit('audit-1'), behavior === 'commit-then-throw'
      ? { ok: true, invalidated: 2 } : { ok: false, code: 'CAPABILITY_UNAVAILABLE' });
    intercept = false;
    assert.equal((await f.authority.clearAudit('audit-1')).ok, true);
    const final = await backing.get(null);
    assert.equal(final[f.targetKey].state, 'invalidated');
    assert.equal(final[f.sessionKey].state, 'revoked');
  });
});

test('audit-scoped authority cleanup refuses malformed or transplanted own records without touching other records', async t => {
  for (const kind of ['session-extra', 'session-locator', 'target-extra', 'target-locator', 'target-window']) await t.test(kind, async () => {
    const f = await claimedCleanupFixture();
    const before = await f.sessionArea.get(null);
    const key = kind.startsWith('session') ? f.sessionKey : f.targetKey;
    const changed = kind.endsWith('extra') ? { ...before[key], extra: 'PRIVATE_SENTINEL' } :
      kind === 'session-locator' ? { ...before[key], sessionCapabilityId: 'F'.repeat(22) } :
        kind === 'target-locator' ? { ...before[key], capabilityId: 'F'.repeat(22) } :
          { ...before[key], windowId: 10 };
    await f.sessionArea.set({ [key]: changed, 'audita:persona-lease:independent': { state: 'active' } });
    const preserved = await f.sessionArea.get(null);
    const writes = f.sessionArea.writes.length;
    assert.deepEqual(await f.authority.clearAudit('audit-1'), { ok: false, code: 'CAPABILITY_UNAVAILABLE' });
    assert.deepEqual(await f.sessionArea.get(null), preserved);
    assert.equal(f.sessionArea.writes.length, writes);
  });
});

test('audit-scoped authority cleanup does not turn unreadable storage into empty success or accept nonstring IDs', async () => {
  const f = authorityFixture();
  const reads = f.sessionArea.reads.length;
  for (const value of [null, undefined, ['audit-1'], { toString() { throw new Error('PRIVATE_SENTINEL'); } }, 'https://private.invalid/']) {
    assert.deepEqual(await f.authority.clearAudit(value), { ok: false, code: 'CAPABILITY_UNAVAILABLE' });
  }
  assert.equal(f.sessionArea.reads.length, reads);
  const unreadable = authorityFixture({ sessionArea: { ...createStorageArea(), async get() { return null; } } }).authority;
  assert.deepEqual(await unreadable.clearAudit('audit-1'), { ok: false, code: 'CAPABILITY_UNAVAILABLE' });
  await f.sessionArea.set({ 'audita:audit-session-capability:v1:foreign-malformed': { auditId: 'audit-foreign' } });
  assert.deepEqual(await f.authority.clearAudit('audit-1'), { ok: true, invalidated: 0 });
});

test('final authority purge removes only revoked audit children before their sessions and preserves foreign and persona records', async () => {
  let random = 0;
  const f = await claimedCleanupFixture({ randomBytes: () => new Uint8Array(16).fill(++random) });
  const navigation = await f.authority.prepareNavigationForPanel({ intent: 'single', senderContext: extensionContext() });
  const navigationSession = await f.authority.claimNavigationAndIssueAuditSession({
    capabilityId: navigation.capabilityId, auditId: 'audit-1', ownershipId: `owner_${'O'.repeat(22)}`,
    intent: 'single', senderContext: extensionContext(),
  });
  const foreign = await prepareAttached(f.authority);
  const foreignSession = await f.authority.claimAndIssueAuditSession({
    ...validStart(foreign.capabilityId), auditId: 'audit-foreign',
  });
  const persona = await preparePersona(f.authority);
  assert.equal(navigationSession.ok, true);
  assert.equal(foreignSession.ok, true);
  assert.deepEqual(await f.authority.clearAudit('audit-1'), { ok: true, invalidated: 4 });
  const ownChildren = [f.targetKey, navigationCapabilityStorageKey(navigation.capabilityId)];
  const ownSessions = [f.sessionKey, sessionCapabilityStorageKey(navigationSession.sessionCapabilityId)];
  const foreignKeys = [targetCapabilityStorageKey(foreign.capabilityId),
    sessionCapabilityStorageKey(foreignSession.sessionCapabilityId), targetCapabilityStorageKey(persona.capabilityId)];
  const before = await f.sessionArea.get(null);
  const removalStart = f.sessionArea.removals.length;

  const result = await f.authority.finalizeAudit('audit-1');

  assert.deepEqual(result, { ok: true, purged: 4 });
  assert.equal(Object.isFrozen(result), true);
  assert.deepEqual(f.sessionArea.removals.slice(removalStart), [ownChildren, ownSessions]);
  const after = await f.sessionArea.get(null);
  for (const key of [...ownChildren, ...ownSessions]) assert.equal(after[key], undefined);
  for (const key of foreignKeys) assert.deepEqual(after[key], before[key]);
  const repeatRemovalStart = f.sessionArea.removals.length;
  assert.deepEqual(await f.authority.finalizeAudit('audit-1'), { ok: true, purged: 0 });
  assert.equal(f.sessionArea.removals.length, repeatRemovalStart);
});

test('final authority purge rejects active own records before deleting any child or session', async t => {
  for (const kind of ['active session', 'active child']) await t.test(kind, async () => {
    const f = await claimedCleanupFixture();
    if (kind === 'active child') {
      assert.deepEqual(await f.authority.clearAudit('audit-1'), { ok: true, invalidated: 2 });
      const target = (await f.sessionArea.get(f.targetKey))[f.targetKey];
      await f.sessionArea.set({ [f.targetKey]: { ...target, state: 'claimed' } });
    }
    const before = await f.sessionArea.get(null);
    const removals = f.sessionArea.removals.length;

    assert.deepEqual(await f.authority.finalizeAudit('audit-1'), { ok: false, code: 'CAPABILITY_UNAVAILABLE' });

    assert.deepEqual(await f.sessionArea.get(null), before);
    assert.equal(f.sessionArea.removals.length, removals);
  });
});

test('final authority purge confirms commit-then-throw removals and retries safely after unavailable readback', async t => {
  for (const readbackFailure of [false, true]) await t.test(readbackFailure ? 'retry after unreadable child commit' : 'confirmed child and parent commits', async () => {
    const backing = createStorageArea();
    let intercept = false;
    let failReadback = readbackFailure;
    const sessionArea = { ...backing,
      async get(key) {
        if (intercept && failReadback && Array.isArray(key)) {
          failReadback = false;
          throw new Error('PRIVATE_PURGE_READBACK');
        }
        return backing.get(key);
      },
      async remove(keys) {
        await backing.remove(keys);
        if (intercept) throw new Error('PRIVATE_PURGE_REMOVE');
      },
    };
    const f = await claimedCleanupFixture({ sessionArea });
    assert.deepEqual(await f.authority.clearAudit('audit-1'), { ok: true, invalidated: 2 });
    intercept = true;
    const first = await f.authority.finalizeAudit('audit-1');
    if (!readbackFailure) {
      assert.deepEqual(first, { ok: true, purged: 2 });
      assert.deepEqual(await backing.get(null), {});
      return;
    }
    assert.deepEqual(first, { ok: false, code: 'CAPABILITY_UNAVAILABLE' });
    assert.equal((await backing.get(f.targetKey))[f.targetKey], undefined);
    assert.notEqual((await backing.get(f.sessionKey))[f.sessionKey], undefined);
    intercept = false;
    assert.deepEqual(await f.authority.finalizeAudit('audit-1'), { ok: true, purged: 1 });
    assert.deepEqual(await backing.get(null), {});
  });
});

test('final authority purge accepts the full canonical audit domain and rejects invalid identifiers before storage', async () => {
  const f = authorityFixture();
  for (const length of [160, 161, 200]) {
    assert.deepEqual(await f.authority.finalizeAudit('a'.repeat(length)), { ok: true, purged: 0 });
  }
  const reads = f.sessionArea.reads.length;
  for (const value of [null, undefined, 'a'.repeat(201), 'https://private.invalid/']) {
    assert.deepEqual(await f.authority.finalizeAudit(value), { ok: false, code: 'CAPABILITY_UNAVAILABLE' });
  }
  assert.equal(f.sessionArea.reads.length, reads);
});

test('browser lifecycle scans revoke only records bound to the exact tab or window', async () => {
  const { authority, sessionArea } = authorityFixture();
  const first = await prepareAttached(authority);
  const claimed = await authority.claimAndIssueAuditSession(validStart(first.capabilityId));
  const second = await authority.prepare({
    kind: 'attached', tabId: 42, windowId: 10, documentId: 'target-document-2',
    initialUrlEvidence: 'https://example.test/other', initialUrlSessionDigest: DIGEST,
    createdBy: 'user', allowedIntent: 'start-audit', issuer: extensionContext('panel-document-2', 10).issuer,
  });
  assert.deepEqual(await authority.invalidateForTab(41, 'navigation'), { ok: true, invalidated: 2 });
  assert.equal((await sessionArea.get(targetCapabilityStorageKey(first.capabilityId)))[targetCapabilityStorageKey(first.capabilityId)].state, 'invalidated');
  assert.equal((await sessionArea.get(sessionCapabilityStorageKey(claimed.sessionCapabilityId)))[sessionCapabilityStorageKey(claimed.sessionCapabilityId)].state, 'revoked');
  assert.equal((await sessionArea.get(targetCapabilityStorageKey(second.capabilityId)))[targetCapabilityStorageKey(second.capabilityId)].state, 'prepared');
  assert.deepEqual(await authority.invalidateForWindow(10, 'window-removed'), { ok: true, invalidated: 1 });
  assert.equal((await sessionArea.get(targetCapabilityStorageKey(second.capabilityId)))[targetCapabilityStorageKey(second.capabilityId)].state, 'invalidated');
});

test('rehydrates a closed view-only session without resurrecting running intent', async () => {
  const sender = { id: 'test', documentId: 'panel-view-document', url: PANEL_URL };
  const { chromeApi } = panelChromeApi(sender);
  const { authority, sessionArea } = authorityFixture({ chromeApi });
  const result = await authority.rehydrateViewOnly({
    auditId: 'audit-view-1', windowId: 9, mode: 'attached',
  });
  const key = sessionCapabilityStorageKey(result.sessionCapabilityId);
  const session = (await sessionArea.get(key))[key];
  assert.deepEqual(Object.keys(session), SESSION_KEYS);
  assert.equal(session.state, 'view-only');
  assert.deepEqual(session.targetBinding, { kind: 'view-only' });
  assert.equal((await authority.authorizeSession({ sessionCapabilityId: result.sessionCapabilityId, auditId: 'audit-view-1', consumer: 'panel', intent: 'open-report', sender, claimedWindowId: 9 })).ok, true);
  assert.deepEqual(await authority.authorizeSession({ sessionCapabilityId: result.sessionCapabilityId, auditId: 'audit-view-1', consumer: 'panel', intent: 'highlight', sender, claimedWindowId: 9 }), { ok: false, code: 'SESSION_DENIED' });
  assert.deepEqual(await authority.authorizeSession({ sessionCapabilityId: result.sessionCapabilityId, auditId: 'audit-view-1', consumer: 'panel', intent: 'cancel', sender, claimedWindowId: 9 }), { ok: false, code: 'SESSION_DENIED' });
});

test('rehydrateViewOnly rejects caller-supplied target bindings and keeps the exact authority shape', async () => {
  const { authority, sessionArea } = authorityFixture();
  assert.deepEqual(Object.keys(authority), ['prepare', 'prepareNavigationForPanel', 'exchangeAttachedForNavigationCopy', 'inspectPreparedTarget', 'claimPreparedTarget', 'inspectPreparedAuditTarget', 'claimAndIssueAuditSession', 'claimNavigationAndIssueAuditSession', 'claimExchangedAttachedCopyAndIssueAuditSession', 'claimWorkerEventAndIssueAuditSession', 'authorizeSession', 'transitionAuditSession', 'transitionDisposableAuditSession', 'transitionBatchAuditSession', 'invalidateCapability', 'invalidateForTab', 'invalidateForWindow', 'clearAudit', 'finalizeAudit', 'rehydrateViewOnly', 'renewResultSession']);
  assert.deepEqual(await authority.rehydrateViewOnly({
    auditId: 'audit-view-1', windowId: 9, mode: 'attached', targetBinding: { kind: 'view-only' },
  }), { ok: false, code: 'SESSION_DENIED' });
  assert.deepEqual(await sessionArea.get(null), {});
});

test('worker terminalization remains correlated after TTL expiry while UI authorization stays expired', async () => {
  let currentTime = 1_788_000_000_000;
  const sender = { id: 'test', documentId: 'panel-document-1', url: PANEL_URL };
  const { chromeApi } = panelChromeApi(sender);
  const { authority } = authorityFixture({ chromeApi, now: () => currentTime });
  const prepared = await prepareAttached(authority);
  const claimed = await authority.claimAndIssueAuditSession(validStart(prepared.capabilityId));
  currentTime += 30 * 60_000 + 1;
  assert.deepEqual(await authority.authorizeSession({ sessionCapabilityId: claimed.sessionCapabilityId, auditId: 'audit-1', consumer: 'panel', intent: 'cancel', sender, claimedWindowId: 9 }), { ok: false, code: 'SESSION_DENIED' });
  assert.deepEqual(await authority.transitionAuditSession({ sessionCapabilityId: claimed.sessionCapabilityId, auditId: 'audit-1', nextState: 'result' }), {
    ok: true, sessionCapabilityId: claimed.sessionCapabilityId, auditId: 'audit-1', state: 'result',
  });
  assert.equal((await authority.transitionAuditSession({ sessionCapabilityId: claimed.sessionCapabilityId, auditId: 'audit-1', nextState: 'revoked' })).ok, true);
});

test('reads an exact confirmed unexpired prepared attached fact without scanning storage', async () => {
  let currentTime = 1_788_000_000_000;
  const { authority, sessionArea } = authorityFixture({ now: () => currentTime });
  const prepared = await prepareAttached(authority);
  const requestedKeys = [];
  const area = { ...sessionArea, async get(key) { requestedKeys.push(key); return sessionArea.get(key); } };
  const fact = await readPreparedAttachedAuditFact({ sessionArea: area, capabilityId: prepared.capabilityId, epochNow: () => currentTime });
  assert.deepEqual(fact, { version: 1, capabilityId: prepared.capabilityId, windowId: 9, issuedAt: currentTime, expiresAt: currentTime + 60_000 });
  assert.equal(Object.isFrozen(fact), true);
  assert.deepEqual(requestedKeys, [targetCapabilityStorageKey(prepared.capabilityId), targetCapabilityStorageKey(prepared.capabilityId)]);
  currentTime += 60_000;
  await assert.rejects(() => readPreparedAttachedAuditFact({ sessionArea, capabilityId: prepared.capabilityId, epochNow: () => currentTime }), /PREPARED_AUDIT_FACT_DENIED/u);
});

test('prepared fact rejects drift transplant and claimed state', async () => {
  const { authority, sessionArea } = authorityFixture();
  const first = await prepareAttached(authority);
  const second = await prepareAttached(authority);
  const firstKey = targetCapabilityStorageKey(first.capabilityId);
  const secondKey = targetCapabilityStorageKey(second.capabilityId);
  const secondRecord = (await sessionArea.get(secondKey))[secondKey];
  sessionArea.unsafeSet(firstKey, secondRecord);
  await assert.rejects(() => readPreparedAttachedAuditFact({ sessionArea, capabilityId: first.capabilityId, epochNow: () => 1_788_000_000_000 }), /PREPARED_AUDIT_FACT_DENIED/u);

  const { authority: claimedAuthority, sessionArea: claimedArea } = authorityFixture();
  const prepared = await prepareAttached(claimedAuthority);
  await claimedAuthority.claimAndIssueAuditSession(validStart(prepared.capabilityId));
  await assert.rejects(() => readPreparedAttachedAuditFact({ sessionArea: claimedArea, capabilityId: prepared.capabilityId, epochNow: () => 1_788_000_000_000 }), /PREPARED_AUDIT_FACT_DENIED/u);

  let reads = 0;
  const driftingArea = { async get(key) {
    reads += 1;
    return { [key]: { ...secondRecord, capabilityId: first.capabilityId, expiresAt: secondRecord.expiresAt + (reads === 1 ? 0 : 1) } };
  } };
  await assert.rejects(() => readPreparedAttachedAuditFact({ sessionArea: driftingArea, capabilityId: first.capabilityId, epochNow: () => 1_788_000_000_000 }), /PREPARED_AUDIT_FACT_DENIED/u);

  const future = { ...secondRecord, capabilityId: first.capabilityId, issuedAt: 1_788_000_000_001, expiresAt: 1_788_000_060_001 };
  sessionArea.unsafeSet(firstKey, future);
  await assert.rejects(() => readPreparedAttachedAuditFact({ sessionArea, capabilityId: first.capabilityId, epochNow: () => 1_788_000_000_000 }), /PREPARED_AUDIT_FACT_DENIED/u);

  const hostileEnvelopeArea = { async get(key) { return { [key]: { ...secondRecord, capabilityId: first.capabilityId }, extra: 'transplanted' }; } };
  await assert.rejects(() => readPreparedAttachedAuditFact({ sessionArea: hostileEnvelopeArea, capabilityId: first.capabilityId, epochNow: () => 1_788_000_000_000 }), /PREPARED_AUDIT_FACT_DENIED/u);
});

test('reads a claimed attached grant from exact target and session locators with session-owned root times', async () => {
  const currentTime = 1_788_000_000_000;
  const { authority, sessionArea } = authorityFixture({ now: () => currentTime });
  const prepared = await prepareAttached(authority);
  assert.deepEqual(await targetCapabilitiesModule.readAttachedAuditRecoveryGrant({
    sessionArea, capabilityId: prepared.capabilityId, auditId: 'audit-prepared',
  }), {
    version: 1, capabilityId: prepared.capabilityId, auditId: 'audit-prepared',
    sessionCapabilityId: null, windowId: 9,
    issuedAt: currentTime, expiresAt: currentTime + 60_000,
    targetState: 'prepared', sessionState: null,
    target: {
      kind: 'attached', tabId: 41, windowId: 9, documentId: 'target-document-1',
      initialUrlEvidence: 'https://example.test/path', initialUrlSessionDigest: DIGEST,
    },
  });
  const claimed = await authority.claimAndIssueAuditSession(validStart(prepared.capabilityId));
  const requestedKeys = [];
  const area = { ...sessionArea, async get(keys) { requestedKeys.push(keys); return sessionArea.get(keys); } };
  const grant = await readClaimedAttachedAuditGrant({ sessionArea: area, capabilityId: prepared.capabilityId, sessionCapabilityId: claimed.sessionCapabilityId, auditId: 'audit-1', epochNow: () => currentTime });
  assert.deepEqual(grant, {
    version: 1, capabilityId: prepared.capabilityId, auditId: 'audit-1', sessionCapabilityId: claimed.sessionCapabilityId,
    windowId: 9, issuedAt: currentTime, expiresAt: currentTime + 30 * 60_000,
    target: { kind: 'attached', tabId: 41, windowId: 9, documentId: 'target-document-1', initialUrlEvidence: 'https://example.test/path', initialUrlSessionDigest: DIGEST },
  });
  assert.equal(Object.isFrozen(grant), true);
  assert.equal(Object.isFrozen(grant.target), true);
  const expectedKeys = [targetCapabilityStorageKey(prepared.capabilityId), sessionCapabilityStorageKey(claimed.sessionCapabilityId)];
  assert.deepEqual(requestedKeys, [expectedKeys, expectedKeys]);
});

test('claimed reader rejects session-ID transplant target-binding expiry and confirming-reread drift', async () => {
  const currentTime = 1_788_000_000_000;
  const { authority, sessionArea } = authorityFixture({ now: () => currentTime });
  const prepared = await prepareAttached(authority);
  const claimed = await authority.claimAndIssueAuditSession(validStart(prepared.capabilityId));
  const targetKey = targetCapabilityStorageKey(prepared.capabilityId);
  const sessionKey = sessionCapabilityStorageKey(claimed.sessionCapabilityId);
  const target = (await sessionArea.get(targetKey))[targetKey];
  const session = (await sessionArea.get(sessionKey))[sessionKey];
  const baseArgs = { sessionArea, capabilityId: prepared.capabilityId, sessionCapabilityId: claimed.sessionCapabilityId, auditId: 'audit-1', epochNow: () => currentTime };
  for (const changedTarget of [{ ...target, sessionCapabilityId: '______________________' }, { ...target, expiresAt: currentTime }]) {
    sessionArea.unsafeSet(targetKey, changedTarget);
    await assert.rejects(() => readClaimedAttachedAuditGrant(baseArgs), /CLAIMED_AUDIT_GRANT_DENIED/u);
  }
  sessionArea.unsafeSet(targetKey, target);
  sessionArea.unsafeSet(sessionKey, { ...session, targetBinding: { ...session.targetBinding, documentId: 'different-document' } });
  await assert.rejects(() => readClaimedAttachedAuditGrant(baseArgs), /CLAIMED_AUDIT_GRANT_DENIED/u);
  let reads = 0;
  const driftingArea = { async get() {
    reads += 1;
    return { [targetKey]: { ...target, state: reads === 1 ? 'claimed' : 'invalidated' }, [sessionKey]: session };
  } };
  await assert.rejects(() => readClaimedAttachedAuditGrant({ ...baseArgs, sessionArea: driftingArea }), /CLAIMED_AUDIT_GRANT_DENIED/u);

  sessionArea.unsafeSet(targetKey, { ...target, issuedAt: currentTime + 1, expiresAt: currentTime + 60_001 });
  sessionArea.unsafeSet(sessionKey, session);
  await assert.rejects(() => readClaimedAttachedAuditGrant(baseArgs), /CLAIMED_AUDIT_GRANT_DENIED/u);
});

test('reads a frozen worker session without inventing expiry validity or exposing consumers and intents', async () => {
  const { authority, sessionArea } = authorityFixture();
  const prepared = await prepareAttached(authority);
  const claimed = await authority.claimAndIssueAuditSession(validStart(prepared.capabilityId));
  const session = await readAuditSessionForWorker({ sessionArea, sessionCapabilityId: claimed.sessionCapabilityId, auditId: 'audit-1' });
  assert.deepEqual(Object.keys(session), ['version', 'sessionCapabilityId', 'auditId', 'windowId', 'mode', 'targetBinding', 'state', 'issuedAt', 'expiresAt']);
  assert.equal(Object.isFrozen(session), true);
  assert.equal(Object.isFrozen(session.targetBinding), true);
  await assert.rejects(() => readAuditSessionForWorker({ sessionArea, sessionCapabilityId: claimed.sessionCapabilityId, auditId: 'other' }), /AUDIT_SESSION_READ_DENIED/u);
});

test('recovery reader accepts prepared claimed and invalidated targets without TTL authorization and keeps target times', async () => {
  const currentTime = 1_788_000_000_000;
  {
    const { authority, sessionArea } = authorityFixture({ now: () => currentTime });
    const prepared = await prepareAttached(authority);
    const result = await readAttachedAuditCorrelationForRecovery({ sessionArea, capabilityId: prepared.capabilityId, auditId: 'audit-prepared' });
    assert.deepEqual(result, {
      version: 1, capabilityId: prepared.capabilityId, auditId: 'audit-prepared', windowId: 9,
      targetState: 'prepared', sessionCapabilityId: null, sessionState: null,
      issuedAt: currentTime, expiresAt: currentTime + 60_000,
    });
  }
  {
    const { authority, sessionArea } = authorityFixture({ now: () => currentTime });
    const prepared = await prepareAttached(authority);
    const claimed = await authority.claimAndIssueAuditSession(validStart(prepared.capabilityId));
    for (const state of ['claimed', 'invalidated']) {
      const targetKey = targetCapabilityStorageKey(prepared.capabilityId);
      const target = (await sessionArea.get(targetKey))[targetKey];
      await sessionArea.set({ [targetKey]: { ...target, state } });
      const result = await readAttachedAuditCorrelationForRecovery({ sessionArea, capabilityId: prepared.capabilityId, auditId: 'audit-1' });
      assert.deepEqual(result, {
        version: 1, capabilityId: prepared.capabilityId, auditId: 'audit-1', windowId: 9,
        targetState: state, sessionCapabilityId: claimed.sessionCapabilityId, sessionState: 'running',
        issuedAt: currentTime, expiresAt: currentTime + 60_000,
      });
    }
  }
});

test('recovery grant projects the stable capability URL and full attached target without TTL authorization', async () => {
  assert.equal(typeof targetCapabilitiesModule.readAttachedAuditRecoveryGrant, 'function');
  const currentTime = 1_788_000_000_000;
  const { authority, sessionArea } = authorityFixture({ now: () => currentTime });
  const prepared = await prepareAttached(authority);
  const claimed = await authority.claimAndIssueAuditSession(validStart(prepared.capabilityId));
  const targetKey = targetCapabilityStorageKey(prepared.capabilityId);
  const target = (await sessionArea.get(targetKey))[targetKey];
  sessionArea.unsafeSet(targetKey, { ...target, initialUrlEvidence: 'https://example.test/distinct' });
  const requested = [];
  const area = { ...sessionArea, async get(key) { requested.push(structuredClone(key)); return sessionArea.get(key); } };

  const grant = await targetCapabilitiesModule.readAttachedAuditRecoveryGrant({
    sessionArea: area, capabilityId: prepared.capabilityId, auditId: 'audit-1',
  });

  assert.deepEqual(grant, {
    version: 1, capabilityId: prepared.capabilityId, auditId: 'audit-1',
    sessionCapabilityId: claimed.sessionCapabilityId, windowId: 9,
    issuedAt: currentTime, expiresAt: currentTime + 60_000,
    targetState: 'claimed', sessionState: 'running',
    target: {
      kind: 'attached', tabId: 41, windowId: 9, documentId: 'target-document-1',
      initialUrlEvidence: 'https://example.test/distinct', initialUrlSessionDigest: DIGEST,
    },
  });
  assert.equal(Object.isFrozen(grant), true);
  assert.equal(Object.isFrozen(grant.target), true);
  assert.deepEqual(requested, [
    targetKey, sessionCapabilityStorageKey(claimed.sessionCapabilityId),
    targetKey, sessionCapabilityStorageKey(claimed.sessionCapabilityId),
  ]);
  sessionArea.unsafeSet(targetKey, {
    ...target, state: 'invalidated', initialUrlEvidence: 'https://example.test/distinct',
  });
  assert.equal((await targetCapabilitiesModule.readAttachedAuditRecoveryGrant({
    sessionArea, capabilityId: prepared.capabilityId, auditId: 'audit-1',
  })).targetState, 'invalidated');
});

test('recovery grant denies query evidence hostile descriptors transplants and graph drift', async t => {
  assert.equal(typeof targetCapabilitiesModule.readAttachedAuditRecoveryGrant, 'function');
  const createClaimed = async () => {
    const fixture = authorityFixture();
    const prepared = await prepareAttached(fixture.authority);
    const claimed = await fixture.authority.claimAndIssueAuditSession(validStart(prepared.capabilityId));
    const targetKey = targetCapabilityStorageKey(prepared.capabilityId);
    const sessionKey = sessionCapabilityStorageKey(claimed.sessionCapabilityId);
    const target = (await fixture.sessionArea.get(targetKey))[targetKey];
    const session = (await fixture.sessionArea.get(sessionKey))[sessionKey];
    return { ...fixture, prepared, claimed, targetKey, sessionKey, target, session };
  };
  const read = fixture => targetCapabilitiesModule.readAttachedAuditRecoveryGrant({
    sessionArea: fixture.sessionArea, capabilityId: fixture.prepared.capabilityId, auditId: 'audit-1',
  });

  await t.test('query evidence', async () => {
    const fixture = await createClaimed();
    fixture.sessionArea.unsafeSet(fixture.targetKey, {
      ...fixture.target, initialUrlEvidence: 'https://example.test/path?secret=private',
    });
    await assert.rejects(read(fixture), error =>
      error?.message === 'AUDIT_RECOVERY_GRANT_DENIED' && !String(error).includes('private'));
    assert.equal((await readAttachedAuditCorrelationForRecovery({
      sessionArea: fixture.sessionArea, capabilityId: fixture.prepared.capabilityId, auditId: 'audit-1',
    })).targetState, 'claimed', 'the legacy projection remains unchanged');
  });

  await t.test('accessor and proxy', async () => {
    for (const hostile of ['accessor', 'proxy']) {
      const fixture = await createClaimed();
      let getterCalls = 0;
      let value;
      if (hostile === 'accessor') {
        value = { ...fixture.target };
        Object.defineProperty(value, 'initialUrlEvidence', {
          enumerable: true, get() { getterCalls += 1; return 'https://example.test/hostile'; },
        });
      } else {
        value = new Proxy(fixture.target, { ownKeys() { throw new Error('private proxy failure'); } });
      }
      fixture.sessionArea.unsafeSet(fixture.targetKey, value);
      await assert.rejects(read(fixture), /AUDIT_RECOVERY_GRANT_DENIED/u);
      assert.equal(getterCalls, 0);
    }
  });

  await t.test('session transplant', async () => {
    const fixture = await createClaimed();
    fixture.sessionArea.unsafeSet(fixture.sessionKey, { ...fixture.session, auditId: 'foreign-audit' });
    await assert.rejects(read(fixture), /AUDIT_RECOVERY_GRANT_DENIED/u);
  });

  await t.test('target state and URL drift between confirming reads', async () => {
    for (const field of ['state', 'initialUrlEvidence']) {
      const fixture = await createClaimed();
      let targetReads = 0;
      const driftingArea = { async get(key) {
        if (key === fixture.targetKey) {
          targetReads += 1;
          const changed = field === 'state'
            ? { state: targetReads === 1 ? 'claimed' : 'invalidated' }
            : { initialUrlEvidence: targetReads === 1 ? 'https://example.test/path' : 'https://example.test/other' };
          return { [key]: { ...fixture.target, ...changed } };
        }
        if (key === fixture.sessionKey) return { [key]: fixture.session };
        throw new Error('scan denied');
      } };
      await assert.rejects(() => targetCapabilitiesModule.readAttachedAuditRecoveryGrant({
        sessionArea: driftingArea, capabilityId: fixture.prepared.capabilityId, auditId: 'audit-1',
      }), /AUDIT_RECOVERY_GRANT_DENIED/u);
      assert.equal(targetReads, 2);
    }
  });
});

test('recovery reader rejects correlated session transplant and drift without scanning', async () => {
  const { authority, sessionArea } = authorityFixture();
  const prepared = await prepareAttached(authority);
  const claimed = await authority.claimAndIssueAuditSession(validStart(prepared.capabilityId));
  const targetKey = targetCapabilityStorageKey(prepared.capabilityId);
  const sessionKey = sessionCapabilityStorageKey(claimed.sessionCapabilityId);
  const target = (await sessionArea.get(targetKey))[targetKey];
  const session = (await sessionArea.get(sessionKey))[sessionKey];
  sessionArea.unsafeSet(sessionKey, { ...session, auditId: 'other' });
  await assert.rejects(() => readAttachedAuditCorrelationForRecovery({ sessionArea, capabilityId: prepared.capabilityId, auditId: 'audit-1' }), /AUDIT_RECOVERY_CORRELATION_DENIED/u);
  sessionArea.unsafeSet(sessionKey, {
    ...session, mode: 'single',
    targetBinding: { kind: 'disposable', ownershipId: prepared.capabilityId, state: 'observing' },
  });
  await assert.rejects(() => readAttachedAuditCorrelationForRecovery({ sessionArea, capabilityId: prepared.capabilityId, auditId: 'audit-1' }), /AUDIT_RECOVERY_CORRELATION_DENIED/u);
  let targetReads = 0;
  const requested = [];
  const driftingArea = { async get(key) {
    requested.push(key);
    if (key === targetKey) {
      targetReads += 1;
      return { [targetKey]: { ...target, state: targetReads === 1 ? 'claimed' : 'invalidated' } };
    }
    if (key === sessionKey) return { [sessionKey]: session };
    throw new Error('scan denied');
  } };
  await assert.rejects(() => readAttachedAuditCorrelationForRecovery({ sessionArea: driftingArea, capabilityId: prepared.capabilityId, auditId: 'audit-1' }), /AUDIT_RECOVERY_CORRELATION_DENIED/u);
  assert.equal(requested.includes(null), false);
});

test('rejects a stored target record with extra keys without broadening it', async () => {
  const { authority, sessionArea } = authorityFixture();
  const prepared = await prepareAttached(authority);
  const key = targetCapabilityStorageKey(prepared.capabilityId);
  const record = (await sessionArea.get(key))[key];
  await sessionArea.set({ [key]: { ...record, contextType: 'SIDE_PANEL' } });
  assert.deepEqual(await authority.claimAndIssueAuditSession(validStart(prepared.capabilityId)), { ok: false, code: 'CAPABILITY_UNAVAILABLE' });
  assert.equal(Object.hasOwn((await sessionArea.get(key))[key], 'contextType'), true, 'malformed authority data is not normalized into a usable record');
});

test('a live result session can be renewed for a long review; running, expired and revoked ones cannot', async () => {
  // A revisão guiada passa dos 30 minutos contados desde o início da auditoria. O relatório renova a
  // sessão quando reprova, ao vivo, o documento auditado; nada mais muda na sessão.
  let currentTime = 1_788_000_000_000;
  const sender = { id: 'test', documentId: 'panel-document-1', url: PANEL_URL };
  const { chromeApi } = panelChromeApi(sender);
  const { authority, sessionArea } = authorityFixture({ chromeApi, now: () => currentTime });
  const prepared = await prepareAttached(authority);
  const claimed = await authority.claimAndIssueAuditSession(validStart(prepared.capabilityId));
  const renew = () => authority.renewResultSession({ sessionCapabilityId: claimed.sessionCapabilityId, auditId: 'audit-1' });
  assert.deepEqual(await renew(), { ok: false, code: 'CAPABILITY_UNAVAILABLE' }, 'uma auditoria em execução não é renovada');
  await authority.transitionAuditSession({ sessionCapabilityId: claimed.sessionCapabilityId, auditId: 'audit-1', nextState: 'result' });
  const key = sessionCapabilityStorageKey(claimed.sessionCapabilityId);
  const before = (await sessionArea.get(key))[key];
  currentTime += 25 * 60_000;
  assert.deepEqual(await renew(), { ok: true, expiresAt: currentTime + 30 * 60_000 });
  const after = (await sessionArea.get(key))[key];
  assert.deepEqual({ ...after, expiresAt: before.expiresAt }, before, 'só o prazo muda');
  currentTime += 29 * 60_000;
  assert.equal((await authority.authorizeSession({ sessionCapabilityId: claimed.sessionCapabilityId, auditId: 'audit-1',
    consumer: 'panel', intent: 'open-report', sender, claimedWindowId: 9 })).ok, true, 'a sessão continua viva depois de 54 minutos');
  assert.deepEqual(await authority.renewResultSession({ sessionCapabilityId: claimed.sessionCapabilityId, auditId: 'audit-2' }),
    { ok: false, code: 'CAPABILITY_UNAVAILABLE' });
  currentTime += 31 * 60_000;
  assert.deepEqual(await renew(), { ok: false, code: 'CAPABILITY_UNAVAILABLE' }, 'uma sessão vencida não é ressuscitada');
});
