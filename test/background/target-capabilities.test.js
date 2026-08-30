import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EXPORT_SURFACE,
  PANEL_SURFACE,
  REVIEW_SURFACE,
  createTargetCapabilityAuthority,
  deriveTrustedExtensionContext,
  readAttachedAuditCorrelationForRecovery,
  readAuditSessionForWorker,
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
  const writes = [];
  const removals = [];
  return {
    writes,
    removals,
    unsafeSet(key, value) { unsafeValues.set(key, value); },
    async get(key) {
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
  const sessionArea = createStorageArea();
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
    ['loading-tab', {
      tabs: { async query() { return [{ id: 41, windowId: 9, active: true, status: 'loading', url: 'https://example.test/', pendingUrl: '' }]; } },
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
  assert.deepEqual(Object.keys(authority), ['prepare', 'inspectPreparedTarget', 'claimPreparedTarget', 'inspectPreparedAuditTarget', 'claimAndIssueAuditSession', 'claimWorkerEventAndIssueAuditSession', 'authorizeSession', 'transitionAuditSession', 'invalidateCapability', 'invalidateForTab', 'invalidateForWindow', 'rehydrateViewOnly']);
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
    panel: { running: ['cancel'], result: ['open-report'], 'view-only': ['open-report'] },
    review: { running: [], result: ['export'], 'view-only': ['export'] },
  });
  assert.equal(sessionArea.writes.at(-1).keys.length, 2);
  assert.deepEqual(await authority.claimAndIssueAuditSession(validStart(prepared.capabilityId)), { ok: false, code: 'CAPABILITY_UNAVAILABLE' });
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
  assert.deepEqual(await authority.transitionAuditSession({ sessionCapabilityId: claimed.sessionCapabilityId, auditId: 'audit-1', nextState: 'running' }), { ok: false, code: 'SESSION_TRANSITION_DENIED' });
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
      review: { 'view-only': ['export'], result: ['export'], running: [] },
      panel: { 'view-only': ['open-report'], result: ['open-report'], running: ['cancel'] },
    },
  };
  await sessionArea.set({ [key]: reordered });
  assert.equal((await authority.authorizeSession({ sessionCapabilityId: claimed.sessionCapabilityId, auditId: 'audit-1', consumer: 'panel', intent: 'cancel', sender, claimedWindowId: 9 })).ok, true);
  for (const intents of [
    { ...reordered.intents, extra: {} },
    { panel: { result: ['open-report'], 'view-only': ['open-report'] }, review: reordered.intents.review },
    { panel: { ...reordered.intents.panel, running: ['open-report', 'cancel'] }, review: reordered.intents.review },
  ]) {
    await sessionArea.set({ [key]: { ...session, intents } });
    assert.deepEqual(await authority.authorizeSession({ sessionCapabilityId: claimed.sessionCapabilityId, auditId: 'audit-1', consumer: 'panel', intent: 'cancel', sender, claimedWindowId: 9 }), { ok: false, code: 'SESSION_DENIED' });
  }
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
  assert.deepEqual(await authority.authorizeSession({ sessionCapabilityId: result.sessionCapabilityId, auditId: 'audit-view-1', consumer: 'panel', intent: 'cancel', sender, claimedWindowId: 9 }), { ok: false, code: 'SESSION_DENIED' });
});

test('rehydrateViewOnly rejects caller-supplied target bindings and keeps the exact nine-method authority shape', async () => {
  const { authority, sessionArea } = authorityFixture();
  assert.deepEqual(Object.keys(authority), ['prepare', 'inspectPreparedTarget', 'claimPreparedTarget', 'inspectPreparedAuditTarget', 'claimAndIssueAuditSession', 'claimWorkerEventAndIssueAuditSession', 'authorizeSession', 'transitionAuditSession', 'invalidateCapability', 'invalidateForTab', 'invalidateForWindow', 'rehydrateViewOnly']);
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
  sessionArea.unsafeSet(sessionKey, { ...session, mode: 'single', targetBinding: { kind: 'disposable', ownerId: prepared.capabilityId } });
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
