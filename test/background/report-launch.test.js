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

function fixture() {
  const sessionArea = area(); const calls = []; let nextTab = 40; let contextDocument = 'report-doc-1';
  let currentTabUrl = 'chrome-extension://ext-test/src/review/index.html?auditId=audit-1';
  let failTabRead = false;
  let tabReadSequence = [];
  const chromeApi = {
    runtime: {
      id: 'ext-test', getURL: path => `chrome-extension://ext-test/${path}`,
      async getContexts() { return [{ contextType: 'TAB', documentId: contextDocument, documentUrl: 'chrome-extension://ext-test/src/review/index.html?auditId=audit-1', tabId: 40, windowId: 7 }]; },
    },
    tabs: {
      async create(options) { calls.push(['create', options]); return { id: nextTab++, windowId: options.windowId, url: 'about:blank' }; },
      async update(tabId, options) { calls.push(['update', tabId, options]); currentTabUrl = options.url; return { id: tabId, windowId: 7, url: options.url }; },
      async get(tabId) {
        calls.push(['get', tabId]);
        if (failTabRead) throw new Error('private');
        const value = tabReadSequence.length > 0 ? tabReadSequence.shift() : currentTabUrl;
        return typeof value === 'string' ? { id: tabId, windowId: 7, url: value } : value;
      },
      async remove(tabId) { calls.push(['remove', tabId]); },
    },
    windows: { async update(windowId, options) { calls.push(['focus-window', windowId, options]); } },
  };
  let byte = 0;
  const authority = createReportLaunchAuthority({
    chromeApi, sessionArea, epochNow: () => 1000, randomBytes: size => new Uint8Array(size).fill(++byte),
  });
  const sender = {
    id: 'ext-test', documentId: contextDocument,
    url: 'chrome-extension://ext-test/src/review/index.html?auditId=audit-1',
  };
  return {
    authority, chromeApi, sessionArea, calls, sender,
    setDocument(value) { contextDocument = value; },
    setTabUrl(value) { currentTabUrl = value; },
    setCurrentTab(value) { currentTabUrl = value; },
    setTabReadFailure(value) { failTabRead = value; },
    setTabReadSequence(values) { tabReadSequence = [...values]; },
  };
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
  assert.deepEqual((await input.authority.getConsumer(connected.sessionCapabilityId)).intents, ['export']);
  assert.equal((await opening).state, 'connected');
  assert.deepEqual(await input.authority.connect({ auditId: 'audit-1', sender: input.sender }), { ok: false, code: 'REPORT_CONNECT_DENIED' });
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
