import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EXPORT_SURFACE,
  PANEL_SURFACE,
  POPUP_SURFACE,
  REVIEW_SURFACE,
  createTargetCapabilityAuthority,
  deriveTrustedExtensionContext,
  sessionCapabilityStorageKey,
  targetCapabilityStorageKey,
} from '../../src/background/target-capabilities.js';

const TARGET_KEYS = ['version', 'capabilityId', 'kind', 'tabId', 'windowId', 'documentId', 'initialUrlEvidence', 'initialUrlSessionDigest', 'createdBy', 'allowedIntent', 'issuer', 'issuedAt', 'expiresAt', 'state'];
const SESSION_KEYS = ['version', 'sessionCapabilityId', 'auditId', 'windowId', 'mode', 'targetBinding', 'consumers', 'intents', 'state', 'issuedAt', 'expiresAt'];
const DIGEST = `hmac-sha256:${'A'.repeat(43)}`;

function createStorageArea() {
  const values = {};
  const unsafeValues = new Map();
  const writes = [];
  return {
    writes,
    unsafeSet(key, value) { unsafeValues.set(key, value); },
    async get(key) {
      if (key === null) return { ...structuredClone(values), ...Object.fromEntries(unsafeValues) };
      if (unsafeValues.has(key)) return { [key]: unsafeValues.get(key) };
      if (typeof key === 'string') return Object.hasOwn(values, key) ? { [key]: structuredClone(values[key]) } : {};
      throw new TypeError('test key');
    },
    async set(entries) {
      writes.push({ keys: Object.keys(entries), value: structuredClone(entries) });
      Object.assign(values, structuredClone(entries));
    },
  };
}

function extensionContext(documentId = 'panel-document-1', windowId = 9) {
  return Object.freeze({
    issuer: Object.freeze({ type: 'extension-document', documentId, path: PANEL_SURFACE.path }),
    windowId,
    tabId: null,
    contextType: PANEL_SURFACE.contextType,
    documentUrl: 'chrome-extension://test/src/panel/index.html',
  });
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

const validStart = capabilityId => ({
  capabilityId,
  auditId: 'audit-1',
  mode: 'attached',
  allowedIntent: 'start-audit',
  senderContext: extensionContext(),
});

test('exports the four frozen trusted-surface constants', () => {
  assert.deepEqual(POPUP_SURFACE, { path: '/src/popup/index.html', contextType: 'POPUP', allowQuery: false });
  assert.deepEqual(PANEL_SURFACE, { path: '/src/panel/index.html', contextType: 'SIDE_PANEL', allowQuery: false });
  assert.deepEqual(REVIEW_SURFACE, { path: '/src/review/index.html', contextType: 'TAB', allowQuery: 'auditId-only' });
  assert.deepEqual(EXPORT_SURFACE, { path: '/src/export/index.html', contextType: 'TAB', allowQuery: 'auditId-only' });
  assert.equal([POPUP_SURFACE, PANEL_SURFACE, REVIEW_SURFACE, EXPORT_SURFACE].every(Object.isFrozen), true);
});

test('accepts Node WHATWG chrome-extension URL without origin comparison or sender.tab', async () => {
  const sender = {
    id: 'test', documentId: 'panel-document-1',
    url: 'chrome-extension://test/src/panel/index.html',
  };
  const chromeApi = {
    runtime: {
      id: 'test',
      async getContexts() {
        return [{ documentId: 'panel-document-1', documentUrl: sender.url, contextType: 'SIDE_PANEL', windowId: 9 }];
      },
    },
  };
  const context = await deriveTrustedExtensionContext({ sender, chromeApi, surface: PANEL_SURFACE });
  assert.equal(context.contextType, 'SIDE_PANEL');
  assert.equal(context.tabId, null);
  assert.deepEqual(context.issuer, { type: 'extension-document', documentId: 'panel-document-1', path: PANEL_SURFACE.path });
});

test('rejects scheme host query context and document mismatches', async () => {
  const validUrl = 'chrome-extension://test/src/panel/index.html';
  const contexts = [{ documentId: 'panel-document-1', documentUrl: validUrl, contextType: 'SIDE_PANEL', windowId: 9 }];
  const chromeApi = { runtime: { id: 'test', async getContexts() { return contexts; } } };
  const senders = [
    { id: 'test', documentId: 'panel-document-1', url: 'https://test/src/panel/index.html' },
    { id: 'test', documentId: 'panel-document-1', url: 'chrome-extension://other/src/panel/index.html' },
    { id: 'test', documentId: 'panel-document-1', url: `${validUrl}?auditId=audit-1` },
    { id: 'test', documentId: 'panel-document-1', url: validUrl, contextOverride: 'TAB' },
    { id: 'test', documentId: 'unknown-document', url: validUrl },
  ];
  for (const sender of senders) {
    contexts[0].contextType = sender.contextOverride ?? 'SIDE_PANEL';
    await assert.rejects(
      () => deriveTrustedExtensionContext({ sender, chromeApi, surface: PANEL_SURFACE }),
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
  assert.deepEqual(Object.keys(authority), ['prepare', 'claimAndIssueAuditSession', 'claimWorkerEventAndIssueAuditSession', 'authorizeSession', 'transitionAuditSession', 'invalidateCapability', 'invalidateForTab', 'invalidateForWindow', 'rehydrateViewOnly']);
  const prepared = await prepareAttached(authority);
  const result = await authority.claimAndIssueAuditSession(validStart(prepared.capabilityId));
  assert.equal(result.ok, true);
  const target = (await sessionArea.get(targetCapabilityStorageKey(result.capabilityId)))[targetCapabilityStorageKey(result.capabilityId)];
  const session = (await sessionArea.get(sessionCapabilityStorageKey(result.sessionCapabilityId)))[sessionCapabilityStorageKey(result.sessionCapabilityId)];
  assert.deepEqual(Object.keys(target), TARGET_KEYS);
  assert.deepEqual(Object.keys(session), SESSION_KEYS);
  assert.equal(target.state, 'claimed');
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

test('fails closed when intent issuer window context or fresh document proof differs', async () => {
  const variants = [
    start => ({ ...start, allowedIntent: 'start-persona' }),
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

test('never upgrades a persona-only target capability into an audit session', async () => {
  const { authority } = authorityFixture();
  const prepared = await authority.prepare({
    kind: 'attached',
    tabId: 41,
    windowId: 9,
    documentId: 'target-document-1',
    initialUrlEvidence: 'https://example.test/path',
    initialUrlSessionDigest: DIGEST,
    createdBy: 'user',
    allowedIntent: 'start-persona',
    issuer: extensionContext().issuer,
  });
  assert.deepEqual(await authority.claimAndIssueAuditSession({
    ...validStart(prepared.capabilityId),
    allowedIntent: 'start-persona',
  }), { ok: false, code: 'CAPABILITY_UNAVAILABLE' });
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
  const sender = { id: 'test', documentId: 'panel-document-1', url: 'chrome-extension://test/src/panel/index.html' };
  const chromeApi = { runtime: { id: 'test', async getContexts() { return [{ documentId: sender.documentId, documentUrl: sender.url, contextType: 'SIDE_PANEL', windowId: 9 }]; } } };
  const { authority } = authorityFixture({ chromeApi });
  const prepared = await prepareAttached(authority);
  const claimed = await authority.claimAndIssueAuditSession(validStart(prepared.capabilityId));
  assert.equal((await authority.authorizeSession({ sessionCapabilityId: claimed.sessionCapabilityId, auditId: 'audit-1', consumer: 'panel', intent: 'cancel', sender })).ok, true);
  for (const value of [
    { auditId: 'other', consumer: 'panel', intent: 'cancel' },
    { auditId: 'audit-1', consumer: 'panel', intent: 'open-report' },
    { auditId: 'audit-1', consumer: 'review', intent: 'export' },
  ]) {
    assert.deepEqual(await authority.authorizeSession({ sessionCapabilityId: claimed.sessionCapabilityId, sender, ...value }), { ok: false, code: 'SESSION_DENIED' });
  }
  assert.equal((await authority.transitionAuditSession({ sessionCapabilityId: claimed.sessionCapabilityId, auditId: 'audit-1', nextState: 'result' })).ok, true);
  assert.equal((await authority.authorizeSession({ sessionCapabilityId: claimed.sessionCapabilityId, auditId: 'audit-1', consumer: 'panel', intent: 'open-report', sender })).ok, true);
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
  const sender = { id: 'test', documentId: 'panel-document-1', url: 'chrome-extension://test/src/panel/index.html' };
  const chromeApi = { runtime: { id: 'test', async getContexts() { return [{ documentId: sender.documentId, documentUrl: sender.url, contextType: 'SIDE_PANEL', windowId: 9 }]; } } };

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
    assert.deepEqual(await authority.authorizeSession({ sessionCapabilityId: transplantedId, auditId: 'audit-1', consumer: 'panel', intent: 'cancel', sender }), { ok: false, code: 'SESSION_DENIED' });
    const writesBefore = sessionArea.writes.length;
    assert.deepEqual(await authority.transitionAuditSession({ sessionCapabilityId: transplantedId, auditId: 'audit-1', nextState: 'result' }), { ok: false, code: 'SESSION_TRANSITION_DENIED' });
    assert.equal(sessionArea.writes.length, writesBefore);
  }
});

test('validates reordered closed intents structurally and rejects changed grants', async () => {
  const sender = { id: 'test', documentId: 'panel-document-1', url: 'chrome-extension://test/src/panel/index.html' };
  const chromeApi = { runtime: { id: 'test', async getContexts() { return [{ documentId: sender.documentId, documentUrl: sender.url, contextType: 'SIDE_PANEL', windowId: 9 }]; } } };
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
  assert.equal((await authority.authorizeSession({ sessionCapabilityId: claimed.sessionCapabilityId, auditId: 'audit-1', consumer: 'panel', intent: 'cancel', sender })).ok, true);
  for (const intents of [
    { ...reordered.intents, extra: {} },
    { panel: { result: ['open-report'], 'view-only': ['open-report'] }, review: reordered.intents.review },
    { panel: { ...reordered.intents.panel, running: ['open-report', 'cancel'] }, review: reordered.intents.review },
  ]) {
    await sessionArea.set({ [key]: { ...session, intents } });
    assert.deepEqual(await authority.authorizeSession({ sessionCapabilityId: claimed.sessionCapabilityId, auditId: 'audit-1', consumer: 'panel', intent: 'cancel', sender }), { ok: false, code: 'SESSION_DENIED' });
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
  const sender = { id: 'test', documentId: 'panel-view-document', url: 'chrome-extension://test/src/panel/index.html' };
  const chromeApi = { runtime: { id: 'test', async getContexts() { return [{ documentId: sender.documentId, documentUrl: sender.url, contextType: 'SIDE_PANEL', windowId: 9 }]; } } };
  const { authority, sessionArea } = authorityFixture({ chromeApi });
  const result = await authority.rehydrateViewOnly({
    auditId: 'audit-view-1', windowId: 9, mode: 'attached',
    targetBinding: { kind: 'attached', tabId: 41, documentId: 'historical-document', urlSessionDigest: DIGEST },
  });
  const key = sessionCapabilityStorageKey(result.sessionCapabilityId);
  const session = (await sessionArea.get(key))[key];
  assert.deepEqual(Object.keys(session), SESSION_KEYS);
  assert.equal(session.state, 'view-only');
  assert.equal((await authority.authorizeSession({ sessionCapabilityId: result.sessionCapabilityId, auditId: 'audit-view-1', consumer: 'panel', intent: 'open-report', sender })).ok, true);
  assert.deepEqual(await authority.authorizeSession({ sessionCapabilityId: result.sessionCapabilityId, auditId: 'audit-view-1', consumer: 'panel', intent: 'cancel', sender }), { ok: false, code: 'SESSION_DENIED' });
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
