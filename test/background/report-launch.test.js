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
  const chromeApi = {
    runtime: {
      id: 'ext-test', getURL: path => `chrome-extension://ext-test/${path}`,
      async getContexts() { return [{ contextType: 'TAB', documentId: contextDocument, documentUrl: 'chrome-extension://ext-test/src/review/index.html?auditId=audit-1', tabId: 40, windowId: 7 }]; },
    },
    tabs: {
      async create(options) { calls.push(['create', options]); return { id: nextTab++, windowId: options.windowId, url: 'about:blank' }; },
      async update(tabId, options) { calls.push(['update', tabId, options]); return { id: tabId, windowId: 7, url: options.url }; },
      async get(tabId) { calls.push(['get', tabId]); return { id: tabId, windowId: 7, url: 'chrome-extension://ext-test/src/review/index.html?auditId=audit-1' }; },
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
  return { authority, chromeApi, sessionArea, calls, sender, setDocument(value) { contextDocument = value; } };
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

test('same-url reload revokes the old report consumer before accepting a new first document', async () => {
  const input = fixture();
  const opening = input.authority.openRegisteredReport({ auditId: 'audit-1', windowId: 7 });
  await new Promise(resolve => setImmediate(resolve));
  const first = await input.authority.connect({ auditId: 'audit-1', sender: input.sender });
  await opening;
  input.setDocument('report-doc-2');
  await input.authority.handleTabUpdated(40, { status: 'loading', url: 'chrome-extension://ext-test/src/review/index.html?auditId=audit-1' });
  assert.equal((await input.authority.getConsumer(first.sessionCapabilityId)).state, 'revoked');
  assert.equal((await input.authority.getLaunch('audit-1')).state, 'awaiting-connection');
  const second = await input.authority.connect({ auditId: 'audit-1', sender: { ...input.sender, documentId: 'report-doc-2' } });
  assert.equal(second.ok, true);
  assert.notEqual(second.sessionCapabilityId, first.sessionCapabilityId);
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
