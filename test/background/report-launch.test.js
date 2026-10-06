import assert from 'node:assert/strict';
import test from 'node:test';

import { createReportLaunchAuthority } from '../../src/background/report-launch.js';

function area() {
  const values = new Map();
  return {
    async get(keys) {
      const list = keys === null ? [...values.keys()] : (Array.isArray(keys) ? keys : [keys]);
      return Object.fromEntries(list.filter(key => values.has(key)).map(key => [key, structuredClone(values.get(key))]));
    },
    async set(rows) { for (const [key, value] of Object.entries(rows)) values.set(key, structuredClone(value)); },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) values.delete(key); },
  };
}

function fixture({ sourceSessionAuthority = null, sourcePanelAuthority = null } = {}) {
  const sessionArea = area(); const calls = []; let nextTab = 40; let contextDocument = 'report-doc-1';
  let contextTabId = 40;
  let contextDocumentUrl = 'chrome-extension://ext-test/src/review/index.html?auditId=audit-1';
  let currentTabUrl = 'chrome-extension://ext-test/src/review/index.html?auditId=audit-1';
  let currentEpoch = 1000;
  let failTabRead = false;
  let tabReadSequence = [];
  const chromeApi = {
    runtime: {
      id: 'ext-test', getURL: path => `chrome-extension://ext-test/${path}`,
      async getContexts() { return [{ contextType: 'TAB', documentId: contextDocument, documentUrl: contextDocumentUrl, tabId: contextTabId, windowId: 7 }]; },
    },
    tabs: {
      async create(options) { calls.push(['create', options]); return { id: nextTab++, windowId: options.windowId, url: 'about:blank' }; },
      async update(tabId, options) {
        calls.push(['update', tabId, options]);
        if (typeof options.url === 'string') currentTabUrl = options.url;
        return { id: tabId, windowId: 7, url: currentTabUrl };
      },
      async get(tabId) {
        calls.push(['get', tabId]);
        if (failTabRead) throw new Error('private');
        const value = tabReadSequence.length > 0 ? tabReadSequence.shift() : currentTabUrl;
        return typeof value === 'string' ? { id: tabId, windowId: 7, url: value } : value;
      },
      async remove(tabId) { calls.push(['remove', tabId]); },
    },
    sidePanel: { async open(options) { calls.push(['open-panel', options]); } },
    windows: { async update(windowId, options) { calls.push(['focus-window', windowId, options]); } },
  };
  let byte = 0;
  const factory = {
    chromeApi, sessionArea, epochNow: () => currentEpoch, randomBytes: size => new Uint8Array(size).fill(++byte),
  };
  if (sourceSessionAuthority) factory.sourceSessionAuthority = sourceSessionAuthority;
  if (sourcePanelAuthority) factory.sourcePanelAuthority = sourcePanelAuthority;
  const authority = createReportLaunchAuthority(factory);
  const sender = {
    id: 'ext-test', documentId: contextDocument,
    url: 'chrome-extension://ext-test/src/review/index.html?auditId=audit-1',
  };
  return {
    authority, chromeApi, sessionArea, calls, sender,
    setNow(value) { currentEpoch = value; },
    setContextTab(value) { contextTabId = value; },
    setContextDocumentUrl(value) { contextDocumentUrl = value; },
    setDocument(value) { contextDocument = value; },
    setTabUrl(value) { currentTabUrl = value; },
    setCurrentTab(value) { currentTabUrl = value; },
    setTabReadFailure(value) { failTabRead = value; },
    setTabReadSequence(values) { tabReadSequence = [...values]; },
  };
}

test('V2 reauthorizes its exact result source before minting a highlight-capable report consumer', async () => {
  const calls = [];
  const sourceSessionAuthority = {
    async reauthorizeReportSource(value) {
      calls.push(value);
      return { ok: true, state: 'result', binding: {
        kind: 'attached', tabId: 17, documentId: 'target-document',
        urlSessionDigest: `hmac-sha256:${'A'.repeat(43)}`,
      }, windowId: 7, live: true };
    },
  };
  const input = fixture({ sourceSessionAuthority });
  const opening = input.authority.openRegisteredReport({
    auditId: 'audit-1', windowId: 7,
    sourceSessionCapabilityId: 'S'.repeat(22), sourceSessionState: 'result',
  });
  await new Promise(resolve => setImmediate(resolve));
  const allocated = await input.authority.getLaunch('audit-1');
  assert.deepEqual({
    version: allocated.version,
    sourceSessionCapabilityId: allocated.sourceSessionCapabilityId,
    sourceSessionState: allocated.sourceSessionState,
  }, { version: 2, sourceSessionCapabilityId: 'S'.repeat(22), sourceSessionState: 'result' });

  const connected = await input.authority.connect({ auditId: 'audit-1', sender: input.sender });
  assert.deepEqual({ ok: connected.ok, auditId: connected.auditId, state: connected.state },
    { ok: true, auditId: 'audit-1', state: 'result' });
  assert.deepEqual((await input.authority.getConsumer(connected.sessionCapabilityId)).intents,
    ['export', 'review-commit', 'delete-audit', 'delete-all', 'highlight', 'return-source']);
  assert.deepEqual(calls, [{
    sessionCapabilityId: 'S'.repeat(22), auditId: 'audit-1', state: 'result',
  }]);
  await opening;
});

test('an exact live V2 report consumer returns to its audited tab and reopens the native Side Panel', async () => {
  const sourceSessionAuthority = {
    async reauthorizeReportSource() {
      return {
        ok: true, state: 'result', windowId: 7, live: true,
        binding: {
          kind: 'attached', tabId: 17, documentId: 'target-document',
          urlSessionDigest: `hmac-sha256:${'A'.repeat(43)}`,
        },
      };
    },
  };
  const input = fixture({ sourceSessionAuthority });
  const opening = input.authority.openRegisteredReport({
    auditId: 'audit-1', windowId: 7,
    sourceSessionCapabilityId: 'S'.repeat(22), sourceSessionState: 'result',
  });
  await new Promise(resolve => setImmediate(resolve));
  const connected = await input.authority.connect({ auditId: 'audit-1', sender: input.sender });
  await opening;

  assert.deepEqual(await input.authority.returnToSource({
    sessionCapabilityId: connected.sessionCapabilityId,
    auditId: 'audit-1', sender: input.sender,
  }), { ok: true, state: 'source-focused' });
  assert.deepEqual(input.calls.slice(-3), [
    ['focus-window', 7, { focused: true }],
    ['update', 17, { active: true }],
    ['open-panel', { tabId: 17 }],
  ]);
});

test('reuses the exact already-open Side Panel after focusing the audited source tab', async () => {
  const sourceSessionAuthority = {
    async reauthorizeReportSource() {
      return {
        ok: true, state: 'result', windowId: 7, live: true,
        binding: {
          kind: 'attached', tabId: 17, documentId: 'target-document',
          urlSessionDigest: `hmac-sha256:${'A'.repeat(43)}`,
        },
      };
    },
  };
  const panelChecks = [];
  const sourcePanelAuthority = {
    async hasOpenPanelForSource(value) { panelChecks.push(value); return true; },
  };
  const input = fixture({ sourceSessionAuthority, sourcePanelAuthority });
  const opening = input.authority.openRegisteredReport({
    auditId: 'audit-1', windowId: 7,
    sourceSessionCapabilityId: 'S'.repeat(22), sourceSessionState: 'result',
  });
  await new Promise(resolve => setImmediate(resolve));
  const connected = await input.authority.connect({ auditId: 'audit-1', sender: input.sender });
  await opening;

  assert.deepEqual(await input.authority.returnToSource({
    sessionCapabilityId: connected.sessionCapabilityId,
    auditId: 'audit-1', sender: input.sender,
  }), { ok: true, state: 'source-focused' });
  assert.deepEqual(panelChecks, [{ tabId: 17, windowId: 7 }]);
  assert.deepEqual(input.calls.slice(-2), [
    ['focus-window', 7, { focused: true }],
    ['update', 17, { active: true }],
  ]);
  assert.equal(input.calls.some(([name]) => name === 'open-panel'), false);
});

const launchStorageKey = auditId => `audita:report-launch:v1:${auditId}`;
const consumerStorageKey = capabilityId => `audita:report-consumer:v1:${capabilityId}`;

async function openAwaitingReport(input) {
  const opening = input.authority.openRegisteredReport({ auditId: 'audit-1', windowId: 7 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await input.authority.getLaunch('audit-1')).state, 'awaiting-connection');
  return { opening };
}

async function openConnectedReport() {
  const input = fixture();
  const { opening } = await openAwaitingReport(input);
  const connected = await input.authority.connect({ auditId: 'audit-1', sender: input.sender });
  assert.equal(connected.ok, true);
  await opening;
  return { input, connected };
}

async function denyReportIntent(input, connected, intent, message) {
  const args = {
    sessionCapabilityId: connected.sessionCapabilityId,
    auditId: 'audit-1',
    sender: input.sender,
  };
  const actual = intent === 'export'
    ? await input.authority.authorizeExport(args)
    : await input.authority.authorizeIntent({ ...args, intent });
  assert.deepEqual(actual, {
    ok: false,
    code: intent === 'export' ? 'REPORT_EXPORT_DENIED' : 'REPORT_INTENT_DENIED',
  }, message);
}

test('persists report ownership before navigation and binds only the first exact document', async () => {
  const input = fixture();
  const opening = input.authority.openRegisteredReport({ auditId: 'audit-1', windowId: 7 });
  await new Promise(resolve => setImmediate(resolve));
  const before = await input.authority.getLaunch('audit-1');
  assert.equal(before.state, 'awaiting-connection');
  assert.deepEqual(input.calls.slice(0, 2).map(call => call[0]), ['create', 'update']);
  const connected = await input.authority.connect({ auditId: 'audit-1', sender: input.sender });
  assert.deepEqual(Object.keys(connected).sort(), ['auditId', 'ok', 'sessionCapabilityId', 'state']);
  assert.deepEqual({ ok: connected.ok, auditId: connected.auditId, state: connected.state }, { ok: true, auditId: 'audit-1', state: 'view-only' });
  assert.deepEqual((await input.authority.getConsumer(connected.sessionCapabilityId)).intents,
    ['export', 'review-commit', 'delete-audit', 'delete-all']);
  assert.equal((await opening).state, 'connected');
  assert.deepEqual(await input.authority.connect({ auditId: 'audit-1', sender: input.sender }), { ok: false, code: 'REPORT_CONNECT_DENIED' });
});

test('keeps V1 report consumers view-only without granting live highlight', async () => {
  const input = fixture();
  const opening = input.authority.openRegisteredReport({ auditId: 'audit-1', windowId: 7 });
  await new Promise(resolve => setImmediate(resolve));
  const connected = await input.authority.connect({ auditId: 'audit-1', sender: input.sender });
  await opening;

  assert.deepEqual(await input.authority.authorizeExport({
    sessionCapabilityId: connected.sessionCapabilityId, auditId: 'audit-1', sender: input.sender,
  }), { ok: true, auditId: 'audit-1', windowId: 7, sessionCapabilityId: connected.sessionCapabilityId });
  for (const intent of ['review-commit', 'delete-audit', 'delete-all']) {
    assert.deepEqual(await input.authority.authorizeIntent({
      sessionCapabilityId: connected.sessionCapabilityId, auditId: 'audit-1', intent, sender: input.sender,
    }), { ok: true, auditId: 'audit-1', windowId: 7,
      sessionCapabilityId: connected.sessionCapabilityId, intent });
  }
  for (const intent of ['highlight']) {
    assert.deepEqual(await input.authority.authorizeIntent({
      sessionCapabilityId: connected.sessionCapabilityId, auditId: 'audit-1', intent, sender: input.sender,
    }), { ok: false, code: 'REPORT_INTENT_DENIED' });
  }

  assert.deepEqual(await input.authority.authorizeIntent({
    sessionCapabilityId: connected.sessionCapabilityId,
    auditId: 'audit-1', intent: 'export',
    sender: { ...input.sender, documentId: 'foreign-document' },
  }), { ok: false, code: 'CONTEXT_DENIED' });
  assert.deepEqual(await input.authority.authorizeIntent({
    sessionCapabilityId: connected.sessionCapabilityId,
    auditId: 'audit-1', intent: 'unknown', sender: input.sender,
  }), { ok: false, code: 'REPORT_INTENT_DENIED' });
});

test('connect rejects stale or mismatched launch records', async t => {
  const attacks = [
    {
      name: 'clock rollback before launch issuance',
      async apply(input) { input.setNow(999); },
    },
    {
      name: 'future-dated launch issuance',
      async apply(input, launch) {
        await input.sessionArea.set({ [launchStorageKey('audit-1')]: { ...launch, issuedAt: 1001 } });
      },
    },
    {
      name: 'exact expiry boundary',
      async apply(input, launch) { input.setNow(launch.expiresAt); },
    },
    {
      name: 'launch record belongs to another audit',
      async apply(input, launch) {
        await input.sessionArea.set({ [launchStorageKey('audit-1')]: { ...launch, auditId: 'audit-2' } });
      },
    },
  ];

  for (const attack of attacks) {
    await t.test(attack.name, async () => {
      const input = fixture();
      const { opening } = await openAwaitingReport(input);
      const launch = await input.authority.getLaunch('audit-1');
      await attack.apply(input, launch);

      assert.deepEqual(await input.authority.connect({ auditId: 'audit-1', sender: input.sender }), {
        ok: false,
        code: 'REPORT_CONNECT_DENIED',
      });
      const persisted = await input.sessionArea.get(null);
      assert.equal(Object.keys(persisted).some(key => key.startsWith('audita:report-consumer:v1:')), false);

      input.setNow(launch.expiresAt);
      await assert.rejects(opening, /REPORT_CONNECT_DENIED/u);
    });
  }
});

test('clock rollback never focuses reuses or completes a report launch issued in the future', async t => {
  await t.test('connected focus creates a fresh launch instead of reusing future authority', async () => {
    const { input } = await openConnectedReport();
    input.setNow(999);
    const reopened = input.authority.openRegisteredReport({ auditId: 'audit-1', windowId: 7 });
    try {
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(input.calls.filter(([name]) => name === 'create').length, 2);
      input.setContextTab(41);
      assert.equal((await input.authority.connect({ auditId: 'audit-1', sender: input.sender })).ok, true);
      assert.equal((await reopened).tabId, 41);
    } finally {
      input.setNow(1_801_001);
      await Promise.allSettled([reopened]);
    }
  });

  await t.test('awaiting launch is replaced instead of reused before its issuance', async () => {
    const input = fixture();
    const first = input.authority.openRegisteredReport({ auditId: 'audit-1', windowId: 7 });
    await new Promise(resolve => setImmediate(resolve));
    input.setNow(999);
    const second = input.authority.openRegisteredReport({ auditId: 'audit-1', windowId: 7 });
    try {
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(input.calls.filter(([name]) => name === 'create').length, 2);
      input.setContextTab(41);
      assert.equal((await input.authority.connect({ auditId: 'audit-1', sender: input.sender })).ok, true);
      assert.deepEqual((await Promise.all([first, second])).map(value => value.tabId), [41, 41]);
    } finally {
      input.setNow(1_801_001);
      await Promise.allSettled([first, second]);
    }
  });

  await t.test('waiter rejects a connected transition that became future-dated', async () => {
    const input = fixture();
    const opening = input.authority.openRegisteredReport({ auditId: 'audit-1', windowId: 7 });
    await new Promise(resolve => setImmediate(resolve));
    const launch = await input.authority.getLaunch('audit-1');
    await input.sessionArea.set({
      [launchStorageKey('audit-1')]: { ...launch, state: 'connected', documentId: 'report-doc-1' },
    });
    input.setNow(999);
    await assert.rejects(opening, /REPORT_CONNECT_DENIED/u);
  });
});

test('a connected launch transplanted under another audit key is never focused or reused', async () => {
  const { input } = await openConnectedReport();
  const launch = await input.authority.getLaunch('audit-1');
  await input.sessionArea.set({
    [launchStorageKey('audit-1')]: { ...launch, auditId: 'audit-2' },
  });
  input.setTabUrl('chrome-extension://ext-test/src/review/index.html?auditId=audit-2');
  input.setContextDocumentUrl('chrome-extension://ext-test/src/review/index.html?auditId=audit-2');
  const reopened = input.authority.openRegisteredReport({ auditId: 'audit-1', windowId: 7 });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(input.calls.filter(([name]) => name === 'create').length, 2);
    input.setContextTab(41);
    input.setContextDocumentUrl('chrome-extension://ext-test/src/review/index.html?auditId=audit-1');
    assert.equal((await input.authority.connect({ auditId: 'audit-1', sender: input.sender })).ok, true);
    assert.equal((await reopened).tabId, 41);
  } finally {
    input.setNow(1_801_001);
    await Promise.allSettled([reopened]);
  }
});

test('every report intent rechecks current time and the exact launch-consumer correlation', async t => {
  const attacks = [
    {
      name: 'clock rollback before both issuance times',
      async apply({ input }) { input.setNow(999); },
    },
    {
      name: 'future-dated launch issuance',
      async apply({ input, launch }) {
        await input.sessionArea.set({ [launchStorageKey('audit-1')]: { ...launch, issuedAt: 1001 } });
      },
    },
    {
      name: 'future-dated consumer issuance',
      async apply({ input, consumer, connected }) {
        await input.sessionArea.set({
          [consumerStorageKey(connected.sessionCapabilityId)]: { ...consumer, issuedAt: 1001 },
        });
      },
    },
    {
      name: 'consumer issuance predates its launch',
      async apply({ input, consumer, connected }) {
        await input.sessionArea.set({
          [consumerStorageKey(connected.sessionCapabilityId)]: { ...consumer, issuedAt: 999 },
        });
      },
    },
    {
      name: 'consumer expiry does not follow its issuance',
      async apply({ input, consumer, connected }) {
        await input.sessionArea.set({
          [consumerStorageKey(connected.sessionCapabilityId)]: {
            ...consumer,
            issuedAt: 1001,
            expiresAt: 1001,
          },
        });
      },
    },
    {
      name: 'exact shared expiry boundary',
      async apply({ input, consumer }) { input.setNow(consumer.expiresAt); },
    },
    {
      name: 'launch expired while consumer remains active',
      async apply({ input, launch }) {
        await input.sessionArea.set({
          [launchStorageKey('audit-1')]: { ...launch, issuedAt: 999, expiresAt: 1000 },
        });
      },
    },
    {
      name: 'launch and consumer expiries differ',
      async apply({ input, launch }) {
        await input.sessionArea.set({
          [launchStorageKey('audit-1')]: { ...launch, expiresAt: launch.expiresAt + 1 },
        });
      },
    },
    {
      name: 'launch audit differs from consumer audit',
      async apply({ input, launch }) {
        await input.sessionArea.set({ [launchStorageKey('audit-1')]: { ...launch, auditId: 'audit-2' } });
      },
    },
    {
      name: 'consumer record capability differs from its storage key',
      async apply({ input, consumer, connected }) {
        await input.sessionArea.set({
          [consumerStorageKey(connected.sessionCapabilityId)]: {
            ...consumer,
            sessionCapabilityId: 'Z'.repeat(22),
          },
        });
      },
    },
    {
      name: 'launch tab differs from consumer tab',
      async apply({ input, launch }) {
        await input.sessionArea.set({ [launchStorageKey('audit-1')]: { ...launch, tabId: 41 } });
      },
    },
    {
      name: 'launch window differs from consumer window',
      async apply({ input, launch }) {
        await input.sessionArea.set({ [launchStorageKey('audit-1')]: { ...launch, windowId: 8 } });
      },
    },
    {
      name: 'launch document differs from consumer document',
      async apply({ input, launch }) {
        await input.sessionArea.set({ [launchStorageKey('audit-1')]: { ...launch, documentId: 'other-report-doc' } });
      },
    },
  ];

  for (const intent of ['export', 'review-commit', 'delete-audit', 'delete-all']) {
    await t.test(intent, async intentTest => {
      for (const attack of attacks) {
        await intentTest.test(attack.name, async () => {
          const { input, connected } = await openConnectedReport();
          const launch = await input.authority.getLaunch('audit-1');
          const consumer = await input.authority.getConsumer(connected.sessionCapabilityId);
          await attack.apply({ input, connected, launch, consumer });

          await denyReportIntent(input, connected, intent, attack.name);
          assert.equal(await input.authority.validateConsumer(connected.sessionCapabilityId, 'audit-1'), false);
        });
      }
    });
  }
});

test('ignores only the delayed about:blank staging update before the exact report document connects', async () => {
  const input = fixture();
  const opening = input.authority.openRegisteredReport({ auditId: 'audit-1', windowId: 7 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await input.authority.getLaunch('audit-1')).state, 'awaiting-connection');

  assert.equal(await input.authority.handleTabUpdated(40, { status: 'loading', url: 'about:blank' }), false);
  assert.equal(input.calls.filter(call => call[0] === 'get').length, 1);
  assert.equal((await input.authority.getLaunch('audit-1')).state, 'awaiting-connection');
  const connected = await input.authority.connect({ auditId: 'audit-1', sender: input.sender });
  assert.equal(connected.ok, true);
  assert.equal((await opening).state, 'connected');
});

test('accepts about:blank with the exact canonical pending URL immediately', async () => {
  const input = fixture();
  const opening = input.authority.openRegisteredReport({ auditId: 'audit-1', windowId: 7 });
  await new Promise(resolve => setImmediate(resolve));
  input.setTabReadSequence([{ id: 40, windowId: 7, url: 'about:blank',
    pendingUrl: 'chrome-extension://ext-test/src/review/index.html?auditId=audit-1' }]);

  assert.equal(await input.authority.handleTabUpdated(40, { status: 'loading', url: 'about:blank' }), false);
  assert.equal(input.calls.filter(call => call[0] === 'get').length, 1);
  assert.equal((await input.authority.getLaunch('audit-1')).state, 'awaiting-connection');
  assert.equal((await input.authority.connect({ auditId: 'audit-1', sender: input.sender })).ok, true);
  assert.equal((await opening).state, 'connected');
});

test('still revokes a pre-connection report tab that navigates anywhere outside the exact staging URL', async () => {
  const input = fixture();
  const opening = input.authority.openRegisteredReport({ auditId: 'audit-1', windowId: 7 });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(await input.authority.handleTabUpdated(40, { status: 'loading', url: 'https://outside.example/' }), true);
  assert.equal(input.calls.filter(call => call[0] === 'get').length, 0);
  assert.equal((await input.authority.getLaunch('audit-1')).state, 'revoked');
  assert.deepEqual(await input.authority.connect({ auditId: 'audit-1', sender: input.sender }), {
    ok: false, code: 'REPORT_CONNECT_DENIED',
  });
  await assert.rejects(opening, /REPORT_CONNECT_DENIED/u);
});

test('re-proves a canonical pre-connection event against the current exact report tab', async () => {
  const canonical = 'chrome-extension://ext-test/src/review/index.html?auditId=audit-1';
  for (const mode of ['canonical', 'stale-external', 'pending-external', 'read-failed']) {
    const input = fixture();
    const opening = input.authority.openRegisteredReport({ auditId: 'audit-1', windowId: 7 });
    await new Promise(resolve => setImmediate(resolve));
    if (mode === 'stale-external') input.setTabReadSequence([{ id: 40, windowId: 7, url: 'https://outside.example/' }]);
    else if (mode === 'pending-external') input.setTabReadSequence([{
      id: 40, windowId: 7, url: canonical, pendingUrl: 'https://outside.example/',
    }]);
    else if (mode === 'read-failed') input.setTabReadFailure(true);

    const updated = await input.authority.handleTabUpdated(40, { status: 'loading', url: canonical });
    assert.equal(updated, mode !== 'canonical', mode);
    assert.equal((await input.authority.getLaunch('audit-1')).state,
      mode === 'canonical' ? 'awaiting-connection' : 'revoked', mode);
    if (mode === 'canonical') {
      assert.equal((await input.authority.connect({ auditId: 'audit-1', sender: input.sender })).ok, true);
      assert.equal((await opening).state, 'connected');
    } else {
      await assert.rejects(opening, /REPORT_CONNECT_DENIED/u, mode);
    }
  }
});

test('revokes about:blank before connection unless a fresh tab read proves the canonical report URL', async () => {
  for (const mode of ['still-blank', 'read-failed']) {
    const input = fixture();
    const opening = input.authority.openRegisteredReport({ auditId: 'audit-1', windowId: 7 });
    await new Promise(resolve => setImmediate(resolve));
    if (mode === 'still-blank') input.setTabUrl('about:blank');
    else input.setTabReadFailure(true);

    assert.equal(await input.authority.handleTabUpdated(40, { status: 'loading', url: 'about:blank' }), true, mode);
    assert.equal(input.calls.filter(call => call[0] === 'get').length, 1, mode);
    assert.equal((await input.authority.getLaunch('audit-1')).state, 'revoked', mode);
    await assert.rejects(opening, /REPORT_CONNECT_DENIED/u, mode);
  }
});

test('fails closed on a URL-less loading event when the fresh report tab cannot be proved', async () => {
  for (const mode of ['read-failed', 'url-absent']) {
    const input = fixture();
    const opening = input.authority.openRegisteredReport({ auditId: 'audit-1', windowId: 7 });
    await new Promise(resolve => setImmediate(resolve));
    if (mode === 'read-failed') input.setTabReadFailure(true);
    else input.setTabReadSequence([{ id: 40, windowId: 7 }]);

    assert.equal(await input.authority.handleTabUpdated(40, { status: 'loading' }), true, mode);
    assert.equal((await input.authority.getLaunch('audit-1')).state, 'revoked', mode);
    await assert.rejects(opening, /REPORT_CONNECT_DENIED/u, mode);
  }
});

test('requires an exact canonical pendingUrl whenever a fresh report proof exposes it', async () => {
  const canonical = 'chrome-extension://ext-test/src/review/index.html?auditId=audit-1';
  for (const pendingUrl of [canonical, 'https://outside.example/']) {
    const input = fixture();
    const opening = input.authority.openRegisteredReport({ auditId: 'audit-1', windowId: 7 });
    await new Promise(resolve => setImmediate(resolve));
    input.setTabReadSequence([{ id: 40, windowId: 7, url: canonical, pendingUrl }]);

    const updated = await input.authority.handleTabUpdated(40, { status: 'loading' });
    assert.equal(updated, pendingUrl !== canonical);
    assert.equal((await input.authority.getLaunch('audit-1')).state, pendingUrl === canonical ? 'awaiting-connection' : 'revoked');
    if (pendingUrl === canonical) {
      assert.equal((await input.authority.connect({ auditId: 'audit-1', sender: input.sender })).ok, true);
      assert.equal((await opening).state, 'connected');
    } else {
      await assert.rejects(opening, /REPORT_CONNECT_DENIED/u);
    }
  }
});

test('same-url reload revokes the old report consumer before accepting a new first document', async () => {
  const input = fixture();
  const opening = input.authority.openRegisteredReport({ auditId: 'audit-1', windowId: 7 });
  await new Promise(resolve => setImmediate(resolve));
  const first = await input.authority.connect({ auditId: 'audit-1', sender: input.sender });
  await opening;
  assert.equal(await input.authority.handleTabUpdated(40, {
    status: 'loading', url: 'https://stale-event.example/',
  }), false);
  assert.equal((await input.authority.getConsumer(first.sessionCapabilityId)).state, 'active');
  assert.equal((await input.authority.getLaunch('audit-1')).state, 'connected');
  input.setDocument('report-doc-2');
  await input.authority.handleTabUpdated(40, { status: 'loading', url: 'chrome-extension://ext-test/src/review/index.html?auditId=audit-1' });
  assert.equal((await input.authority.getConsumer(first.sessionCapabilityId)).state, 'revoked');
  assert.equal((await input.authority.getLaunch('audit-1')).state, 'awaiting-connection');
  const second = await input.authority.connect({ auditId: 'audit-1', sender: { ...input.sender, documentId: 'report-doc-2' } });
  assert.equal(second.ok, true);
  assert.notEqual(second.sessionCapabilityId, first.sessionCapabilityId);
});

test('connected report proof distinguishes same-document stale events from reload and revocation', async () => {
  for (const mode of ['document-absent', 'document-replaced', 'pending-canonical', 'pending-external', 'tab-read-failed']) {
    const input = fixture();
    const opening = input.authority.openRegisteredReport({ auditId: 'audit-1', windowId: 7 });
    await new Promise(resolve => setImmediate(resolve));
    const connected = await input.authority.connect({ auditId: 'audit-1', sender: input.sender });
    await opening;
    if (mode === 'document-absent') input.setDocument(null);
    else if (mode === 'document-replaced') input.setDocument('report-doc-2');
    else if (mode === 'pending-canonical') input.setCurrentTab({
      id: 40, windowId: 7, url: 'chrome-extension://ext-test/src/review/index.html?auditId=audit-1',
      pendingUrl: 'chrome-extension://ext-test/src/review/index.html?auditId=audit-1',
    });
    else if (mode === 'pending-external') input.setCurrentTab({
      id: 40, windowId: 7, url: 'chrome-extension://ext-test/src/review/index.html?auditId=audit-1',
      pendingUrl: 'https://outside.example/',
    });
    else input.setTabReadFailure(true);

    assert.equal(await input.authority.handleTabUpdated(40, {
      status: 'loading', url: 'about:blank',
    }), true, mode);
    const expectedState = ['document-absent', 'document-replaced', 'pending-canonical'].includes(mode)
      ? 'awaiting-connection'
      : 'revoked';
    assert.equal((await input.authority.getLaunch('audit-1')).state, expectedState, mode);
    assert.equal((await input.authority.getConsumer(connected.sessionCapabilityId)).state, 'revoked', mode);
  }
});

test('reads the report tab proof only through own data descriptors', async () => {
  const input = fixture();
  const opening = input.authority.openRegisteredReport({ auditId: 'audit-1', windowId: 7 });
  await new Promise(resolve => setImmediate(resolve));
  let getterReads = 0;
  const hostile = { id: 40, windowId: 7,
    url: 'chrome-extension://ext-test/src/review/index.html?auditId=audit-1' };
  Object.defineProperty(hostile, 'pendingUrl', { enumerable: true, get() { getterReads += 1; return hostile.url; } });
  input.setCurrentTab(hostile);

  assert.equal(await input.authority.handleTabUpdated(40, { status: 'loading' }), true);
  assert.equal(getterReads, 0);
  assert.equal((await input.authority.getLaunch('audit-1')).state, 'revoked');
  await assert.rejects(opening, /REPORT_CONNECT_DENIED/u);
});

test('concurrent authorities sharing durable state admit one launch and one first session', async () => {
  const first = fixture();
  const second = createReportLaunchAuthority({
    chromeApi: first.chromeApi, sessionArea: first.sessionArea, epochNow: () => 1000,
    randomBytes: size => new Uint8Array(size).fill(9),
  });
  const left = first.authority.openRegisteredReport({ auditId: 'audit-1', windowId: 7 });
  const right = second.openRegisteredReport({ auditId: 'audit-1', windowId: 7 });
  await new Promise(resolve => setImmediate(resolve));
  const connect = await first.authority.connect({ auditId: 'audit-1', sender: first.sender });
  assert.equal(connect.ok, true);
  const results = await Promise.all([left, right]);
  assert.equal(results.filter(result => result.ok === true).length, 2, 'second open focuses the one registered launch');
  assert.equal(first.calls.filter(call => call[0] === 'create').length, 1);
});

const CLEANUP_LAUNCH = 'audita:report-launch:v1:audit-1';
const CLEANUP_INDEX = 'audita:report-launch-tab:v1:40';
const CLEANUP_URL = 'chrome-extension://ext-test/src/review/index.html?auditId=audit-1';

async function cleanupFixture() {
  const env = fixture();
  const opening = env.authority.openRegisteredReport({ auditId: 'audit-1', windowId: 7 });
  await new Promise(resolve => setImmediate(resolve));
  const connected = await env.authority.connect({ auditId: 'audit-1', sender: env.sender });
  await opening;
  const consumerKey = `audita:report-consumer:v1:${connected.sessionCapabilityId}`;
  const tabs = new Map([[40, { id: 40, windowId: 7, url: CLEANUP_URL }]]);
  const contexts = new Map([[40, {
    contextType: 'TAB', documentId: 'report-doc-1', documentUrl: CLEANUP_URL, tabId: 40, windowId: 7,
  }]]);
  env.chromeApi.tabs.get = async tabId => {
    env.calls.push(['get', tabId]);
    if (!tabs.has(tabId)) throw new Error('PRIVATE_TAB_ERROR');
    return structuredClone(tabs.get(tabId));
  };
  env.chromeApi.tabs.query = async query => {
    assert.deepEqual(query, {});
    return [...tabs.keys()].map(id => ({ id }));
  };
  env.chromeApi.tabs.remove = async tabId => {
    env.calls.push(['remove', tabId]);
    tabs.delete(tabId); contexts.delete(tabId);
  };
  env.chromeApi.runtime.getContexts = async filter => [...contexts.values()].filter(context =>
    (!filter.tabIds || filter.tabIds.includes(context.tabId)) &&
    (!filter.documentIds || filter.documentIds.includes(context.documentId)) &&
    (!filter.contextTypes || filter.contextTypes.includes(context.contextType)));
  return { ...env, consumerKey, tabs, contexts };
}

test('report audit cleanup revokes before closing its document, purges only own records and is idempotent', async () => {
  const env = await cleanupFixture();
  const foreign = { 'audita:report-launch-tab:v1:52': 'audit-other', 'audita:persona-lease:v1:7': { state: 'active' } };
  await env.sessionArea.set(foreign);
  const remove = env.chromeApi.tabs.remove;
  env.chromeApi.tabs.remove = async tabId => {
    assert.equal((await env.authority.getLaunch('audit-1')).state, 'revoked');
    assert.equal((await env.sessionArea.get(env.consumerKey))[env.consumerKey].state, 'revoked');
    await remove(tabId);
  };
  assert.equal(await env.authority.clearAudit('audit-1'), true);
  assert.deepEqual(await env.sessionArea.get(null), foreign);
  assert.equal(await env.authority.clearAudit('audit-1'), true);
  assert.deepEqual(env.calls.filter(call => call[0] === 'remove'), [['remove', 40]]);
  assert.equal((await env.authority.authorizeExport({ auditId: 'audit-1', sessionCapabilityId: env.consumerKey.split(':').at(-1), sender: env.sender })).ok, false);
});

test('report audit cleanup includes older orphan consumers and already revoked reports without closing a foreign tab', async () => {
  const env = await cleanupFixture();
  const oldConsumer = (await env.sessionArea.get(env.consumerKey))[env.consumerKey];
  const olderId = 'Z'.repeat(22);
  const olderKey = `audita:report-consumer:v1:${olderId}`;
  await env.sessionArea.set({
    [olderKey]: { ...oldConsumer, sessionCapabilityId: olderId, tabId: 41, documentId: 'older-document', state: 'revoked' },
    'audita:report-launch-tab:v1:41': 'audit-1',
    'audita:report-launch-tab:v1:52': 'audit-other',
  });
  env.tabs.set(41, { id: 41, windowId: 7, url: CLEANUP_URL });
  env.contexts.set(41, { ...env.contexts.get(40), tabId: 41, documentId: 'older-document' });
  env.tabs.set(52, { id: 52, windowId: 7, url: 'https://unrelated.invalid/' });
  const launch = await env.authority.getLaunch('audit-1');
  await env.sessionArea.set({ [CLEANUP_LAUNCH]: { ...launch, state: 'revoked' } });
  assert.equal(await env.authority.clearAudit('audit-1'), true);
  assert.deepEqual(env.calls.filter(call => call[0] === 'remove'), [['remove', 40], ['remove', 41]]);
  assert.equal(env.tabs.has(52), true);
  assert.deepEqual(await env.sessionArea.get(null), { 'audita:report-launch-tab:v1:52': 'audit-other' });
});

test('report audit cleanup adopts only a proved canonical preconnection document and otherwise remains pending', async t => {
  for (const mode of ['canonical', 'blank', 'pending', 'context-missing']) await t.test(mode, async () => {
    const env = await cleanupFixture();
    const launch = await env.authority.getLaunch('audit-1');
    await env.sessionArea.set({ [CLEANUP_LAUNCH]: { ...launch, state: 'awaiting-connection', documentId: null } });
    await env.sessionArea.remove(env.consumerKey);
    if (mode === 'blank') env.tabs.get(40).url = 'about:blank';
    if (mode === 'pending') env.tabs.get(40).pendingUrl = CLEANUP_URL;
    if (mode === 'context-missing') env.contexts.clear();
    const remove = env.chromeApi.tabs.remove;
    env.chromeApi.tabs.remove = async tabId => {
      assert.equal((await env.authority.getLaunch('audit-1')).documentId, 'report-doc-1');
      await remove(tabId);
    };
    assert.equal(await env.authority.clearAudit('audit-1'), mode === 'canonical');
    if (mode === 'canonical') assert.deepEqual(await env.sessionArea.get(null), {});
    else {
      assert.equal(env.tabs.has(40), true);
      assert.equal((await env.authority.getLaunch('audit-1')).state, 'revoked');
    }
  });
});

test('report audit cleanup preserves navigated or replaced documents and retries after confirmed absence', async t => {
  for (const mode of ['url', 'document', 'window', 'pending', 'foreign-index']) await t.test(mode, async () => {
    const env = await cleanupFixture();
    if (mode === 'url') env.tabs.get(40).url = 'https://unrelated.invalid/';
    if (mode === 'document') env.contexts.get(40).documentId = 'foreign-document';
    if (mode === 'window') env.tabs.get(40).windowId = 8;
    if (mode === 'pending') env.tabs.get(40).pendingUrl = 'https://unrelated.invalid/';
    if (mode === 'foreign-index') await env.sessionArea.set({ [CLEANUP_INDEX]: 'audit-other' });
    assert.equal(await env.authority.clearAudit('audit-1'), false);
    assert.deepEqual(env.calls.filter(call => call[0] === 'remove'), []);
    assert.equal(env.tabs.has(40), true);
    assert.notEqual(await env.authority.getLaunch('audit-1'), null);
    if (mode === 'foreign-index') await env.sessionArea.set({ [CLEANUP_INDEX]: 'audit-1' });
    env.tabs.delete(40); env.contexts.delete(40);
    assert.equal(await env.authority.clearAudit('audit-1'), true);
    assert.deepEqual(await env.sessionArea.get(null), {});
  });
});

test('report audit cleanup never interprets a tab or context read error as absence', async t => {
  for (const mode of ['tab-get', 'query-failed', 'query-malformed', 'context-get']) await t.test(mode, async () => {
    const env = await cleanupFixture();
    if (mode === 'context-get') env.chromeApi.runtime.getContexts = async () => { throw new Error('PRIVATE_CONTEXT_ERROR'); };
    else env.chromeApi.tabs.get = async () => { throw new Error('PRIVATE_TAB_ERROR'); };
    if (mode === 'query-failed') env.chromeApi.tabs.query = async () => { throw new Error('PRIVATE_QUERY_ERROR'); };
    if (mode === 'query-malformed') env.chromeApi.tabs.query = async () => null;
    assert.equal(await env.authority.clearAudit('audit-1'), false);
    assert.deepEqual(env.calls.filter(call => call[0] === 'remove'), []);
    assert.notEqual(await env.authority.getLaunch('audit-1'), null);
  });
});

test('report audit cleanup confirms failed effects by readback and keeps unconfirmed cleanup retryable', async t => {
  for (const mode of ['write-throws', 'write-noop', 'write-commit-throw', 'close-throws', 'close-noop', 'close-commit-throw', 'remove-noop', 'remove-commit-throw']) await t.test(mode, async () => {
    const env = await cleanupFixture();
    const set = env.sessionArea.set;
    const remove = env.sessionArea.remove;
    const close = env.chromeApi.tabs.remove;
    if (mode.startsWith('write-')) env.sessionArea.set = async rows => {
      if (mode === 'write-commit-throw') await set(rows);
      if (mode !== 'write-noop') throw new Error('PRIVATE_STORAGE_ERROR');
    };
    if (mode.startsWith('close-')) env.chromeApi.tabs.remove = async tabId => {
      if (mode === 'close-commit-throw') await close(tabId);
      if (mode !== 'close-noop') throw new Error('PRIVATE_CLOSE_ERROR');
    };
    if (mode.startsWith('remove-')) env.sessionArea.remove = async keys => {
      if (mode === 'remove-commit-throw') { await remove(keys); throw new Error('PRIVATE_REMOVE_ERROR'); }
    };
    const confirmed = mode.endsWith('commit-throw');
    assert.equal(await env.authority.clearAudit('audit-1'), confirmed);
    if (confirmed) assert.deepEqual(await env.sessionArea.get(null), {});
    else {
      assert.notEqual(await env.authority.getLaunch('audit-1'), null);
      if (mode.startsWith('write-')) assert.deepEqual(env.calls.filter(call => call[0] === 'remove'), []);
      env.sessionArea.set = set; env.sessionArea.remove = remove; env.chromeApi.tabs.remove = close;
      assert.equal(await env.authority.clearAudit('audit-1'), true);
      assert.deepEqual(await env.sessionArea.get(null), {});
    }
  });
});

test('report audit cleanup rejects invalid input, malformed own records and storage replacement without foreign effects', async t => {
  for (const mode of ['invalid-id', 'inventory-error', 'malformed-launch', 'transplanted-consumer', 'replacement']) await t.test(mode, async () => {
    const env = await cleanupFixture();
    if (mode === 'malformed-launch') await env.sessionArea.set({ [CLEANUP_LAUNCH]: { auditId: 'audit-1' } });
    if (mode === 'transplanted-consumer') {
      const consumer = (await env.sessionArea.get(env.consumerKey))[env.consumerKey];
      await env.sessionArea.set({ [`audita:report-consumer:v1:${'Y'.repeat(22)}`]: consumer });
    }
    if (mode === 'inventory-error') env.sessionArea.get = async () => { throw new Error('PRIVATE_INVENTORY_ERROR'); };
    if (mode === 'replacement') {
      const contexts = env.chromeApi.runtime.getContexts;
      env.chromeApi.runtime.getContexts = async filter => {
        await env.sessionArea.set({ [CLEANUP_INDEX]: 'audit-other' });
        return contexts(filter);
      };
    }
    assert.equal(await env.authority.clearAudit(mode === 'invalid-id' ? { toString() { throw new Error('PRIVATE_INPUT'); } } : 'audit-1'), false);
    assert.deepEqual(env.calls.filter(call => call[0] === 'remove'), []);
    assert.equal(env.tabs.has(40), true);
    if (mode === 'replacement') assert.equal((await env.sessionArea.get(CLEANUP_INDEX))[CLEANUP_INDEX], 'audit-other');
  });
});

test('report audit cleanup joins the shared audit queue before a concurrent connection finishes', async t => {
  let entered;
  let release;
  const waiting = new Promise(resolve => { entered = resolve; });
  const env = fixture({ sourceSessionAuthority: { async reauthorizeReportSource() {
    entered(); await new Promise(resolve => { release = resolve; });
    return { ok: true, state: 'view-only' };
  } } });
  const opening = env.authority.openRegisteredReport({ auditId: 'audit-1', windowId: 7,
    sourceSessionCapabilityId: 'S'.repeat(22), sourceSessionState: 'view-only' });
  void opening.catch(() => {});
  await new Promise(resolve => setImmediate(resolve));
  const connection = env.authority.connect({ auditId: 'audit-1', sender: env.sender });
  await waiting;
  t.after(() => release?.());
  let cleared = false;
  let tabPresent = true;
  env.chromeApi.tabs.query = async () => tabPresent ? [{ id: 40 }] : [];
  env.chromeApi.tabs.remove = async () => { tabPresent = false; };
  const second = createReportLaunchAuthority({ chromeApi: env.chromeApi, sessionArea: env.sessionArea,
    epochNow: () => 1000, randomBytes: size => new Uint8Array(size).fill(9) });
  const clearing = second.clearAudit('audit-1').then(value => { cleared = true; return value; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cleared, false);
  release();
  assert.equal((await connection).ok, true);
  await opening.catch(() => {});
  assert.equal(await clearing, true);
  assert.deepEqual(await env.sessionArea.get(null), {});
});

test('report audit cleanup is not undone by a window event holding an earlier inventory', async () => {
  const env = await cleanupFixture();
  const get = env.sessionArea.get;
  let entered;
  let release;
  const captured = new Promise(resolve => { entered = resolve; });
  let intercept = true;
  env.sessionArea.get = async keys => {
    const result = await get(keys);
    if (keys === null && intercept) {
      intercept = false;
      return new Promise(resolve => { release = () => resolve(result); entered(); });
    }
    return result;
  };
  const windowEvent = env.authority.handleWindowRemoved(7);
  await captured;
  try { assert.equal(await env.authority.clearAudit('audit-1'), true); }
  finally { release(); }
  await windowEvent;
  assert.deepEqual(await env.sessionArea.get(null), {});
});

test('report audit cleanup removes an orphan index without using it as authority to close a tab', async () => {
  const env = await cleanupFixture();
  await env.sessionArea.remove([CLEANUP_LAUNCH, env.consumerKey]);
  assert.equal(await env.authority.clearAudit('audit-1'), true);
  assert.equal(env.tabs.has(40), true);
  assert.deepEqual(await env.sessionArea.get(null), {});
  assert.deepEqual(env.calls.filter(call => call[0] === 'remove'), []);
});

test('report audit cleanup refuses navigation that begins during its final context read', async () => {
  const env = await cleanupFixture();
  const contexts = env.chromeApi.runtime.getContexts;
  let reads = 0;
  env.chromeApi.runtime.getContexts = async filter => {
    const result = await contexts(filter);
    if (++reads === 2) env.tabs.get(40).pendingUrl = 'https://user-navigation.invalid/';
    return result;
  };
  assert.equal(await env.authority.clearAudit('audit-1'), false);
  assert.equal(env.tabs.has(40), true);
  assert.deepEqual(env.calls.filter(call => call[0] === 'remove'), []);
  delete env.tabs.get(40).pendingUrl;
  assert.equal(await env.authority.clearAudit('audit-1'), true);
});

test('report audit cleanup keeps an own launch under a foreign storage key pending without closing its tab', async () => {
  const env = await cleanupFixture();
  const launch = await env.authority.getLaunch('audit-1');
  const foreignKey = 'audita:report-launch:v1:audit-other';
  await env.sessionArea.set({ [foreignKey]: launch });
  await env.sessionArea.remove([CLEANUP_LAUNCH, CLEANUP_INDEX, env.consumerKey]);
  assert.equal(await env.authority.clearAudit('audit-1'), false);
  assert.deepEqual(await env.sessionArea.get(null), { [foreignKey]: launch });
  assert.equal(env.tabs.has(40), true);
  assert.deepEqual(env.calls.filter(call => call[0] === 'remove'), []);
});

test('report audit cleanup tab removal event cannot revoke a subsequently queued launch in another tab', async () => {
  const env = await cleanupFixture();
  let entered;
  let release;
  const captured = new Promise(resolve => { entered = resolve; });
  const contexts = env.chromeApi.runtime.getContexts;
  let reads = 0;
  env.chromeApi.runtime.getContexts = async filter => {
    const result = await contexts(filter);
    if (++reads === 1) { entered(); await new Promise(resolve => { release = resolve; }); }
    return result;
  };
  const create = env.chromeApi.tabs.create;
  env.chromeApi.tabs.create = async options => {
    const tab = await create(options); env.tabs.set(tab.id, tab); return tab;
  };
  const update = env.chromeApi.tabs.update;
  env.chromeApi.tabs.update = async (tabId, options) => {
    const tab = await update(tabId, options); env.tabs.set(tabId, tab);
    env.contexts.set(tabId, { contextType: 'TAB', tabId, windowId: 7, documentUrl: CLEANUP_URL, documentId: 'report-doc-2' });
    return tab;
  };
  let removalEvent;
  const remove = env.chromeApi.tabs.remove;
  env.chromeApi.tabs.remove = async tabId => { await remove(tabId); removalEvent = env.authority.handleTabRemoved(tabId); };
  const clearing = env.authority.clearAudit('audit-1');
  await captured;
  const opening = env.authority.openRegisteredReport({ auditId: 'audit-1', windowId: 7 });
  void opening.catch(() => {});
  release();
  assert.equal(await clearing, true);
  await new Promise(resolve => setImmediate(resolve));
  await removalEvent;
  const stateAfterEvent = (await env.authority.getLaunch('audit-1'))?.state;
  if (stateAfterEvent === 'awaiting-connection') {
    assert.equal((await env.authority.connect({ auditId: 'audit-1', sender: { ...env.sender, documentId: 'report-doc-2' } })).ok, true);
  }
  const opened = await opening.catch(() => null);
  assert.equal(stateAfterEvent, 'awaiting-connection');
  assert.equal(opened.tabId, 41);
  assert.equal(env.tabs.has(41), true);
});

test('page aids act only on the proven audited tab, per tab, and are reversible', async () => {
  const sourceSessionAuthority = {
    async reauthorizeReportSource() {
      return { ok: true, state: 'result', windowId: 7, live: true, binding: {
        kind: 'attached', tabId: 17, documentId: 'target-document', urlSessionDigest: `hmac-sha256:${'A'.repeat(43)}`,
      } };
    },
  };
  const input = fixture({ sourceSessionAuthority });
  const aids = [];
  input.chromeApi.tabs.setZoomSettings = async (tabId, settings) => { aids.push(['zoom-settings', tabId, settings]); };
  input.chromeApi.tabs.setZoom = async (tabId, factor) => { aids.push(['zoom', tabId, factor]); };
  input.chromeApi.tabs.getZoom = async tabId => { aids.push(['get-zoom', tabId]); return 1.25; };
  const realGet = input.chromeApi.tabs.get;
  input.chromeApi.tabs.get = async tabId => (tabId === 17 ? { id: 17, windowId: 7, width: 1280 } : realGet(tabId));
  input.chromeApi.scripting = {
    async insertCSS(options) { aids.push(['insert-css', options.target.tabId, options.target.documentIds, options.origin]); },
    async removeCSS(options) { aids.push(['remove-css', options.target.tabId, options.target.documentIds, options.origin]); },
  };
  const opening = input.authority.openRegisteredReport({
    auditId: 'audit-1', windowId: 7, sourceSessionCapabilityId: 'S'.repeat(22), sourceSessionState: 'result',
  });
  await new Promise(resolve => setImmediate(resolve));
  const connected = await input.authority.connect({ auditId: 'audit-1', sender: input.sender });
  await opening;
  const request = aid => input.authority.applyPageAid({
    sessionCapabilityId: connected.sessionCapabilityId, auditId: 'audit-1', sender: input.sender, aid,
  });
  assert.deepEqual(await request('zoom-200'), { ok: true, aid: 'zoom-200', state: 'applied', zoomPercent: 200 });
  assert.deepEqual(await request('reflow-320'), { ok: true, aid: 'reflow-320', state: 'applied', zoomPercent: 400 });
  assert.deepEqual(await request('text-spacing'), { ok: true, aid: 'text-spacing', state: 'applied', zoomPercent: null });
  assert.deepEqual(await request('reset'), { ok: true, aid: 'reset', state: 'reset', zoomPercent: null });
  // O zoom anterior (125%) é lido uma vez e devolvido no "voltar ao normal"; a folha de espaçamento vale só
  // para o documento provado.
  assert.deepEqual(aids, [
    ['get-zoom', 17], ['zoom-settings', 17, { mode: 'automatic', scope: 'per-tab' }], ['zoom', 17, 2],
    ['zoom-settings', 17, { mode: 'automatic', scope: 'per-tab' }], ['zoom', 17, 4],
    ['insert-css', 17, ['target-document'], 'USER'],
    ['remove-css', 17, ['target-document'], 'USER'], ['zoom', 17, 1.25],
  ]);
  aids.length = 0;
  assert.deepEqual(await request('text-spacing'), { ok: true, aid: 'text-spacing', state: 'applied', zoomPercent: null });
  assert.deepEqual(await request('reset'), { ok: true, aid: 'reset', state: 'reset', zoomPercent: null });
  assert.deepEqual(aids, [['insert-css', 17, ['target-document'], 'USER'], ['remove-css', 17, ['target-document'], 'USER']],
    'só o espaçamento foi aplicado: o zoom da pessoa não é tocado');
  assert.equal((await request('script')).ok, false);
  assert.equal((await input.authority.applyPageAid({
    sessionCapabilityId: 'X'.repeat(22), auditId: 'audit-1', sender: input.sender, aid: 'zoom-200',
  })).ok, false);
});
