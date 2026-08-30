import assert from 'node:assert/strict';
import test from 'node:test';

import { createExportLaunchAuthority, deriveExportLeaseOwner } from '../../src/background/export-launch.js';

test('attempt identity is a canonical decimal string and its private owner is deterministic', () => {
  assert.equal(deriveExportLeaseOwner('audit-1', '7'), 'export:audit-1:7');
  for (const value of ['0', '01', '-1', '1.0', '9007199254740992']) {
    assert.throws(() => deriveExportLeaseOwner('audit-1', value), /EXPORT_ATTEMPT_DENIED/u);
  }
});

test('export launch creates a bearer-free URL and persists one first-document session', async () => {
  const records = new Map(); const calls = []; let nextByte = 1;
  const area = {
    async get(keys) { const list = keys === null ? [...records.keys()] : (Array.isArray(keys) ? keys : [keys]); return Object.fromEntries(list.filter(key => records.has(key)).map(key => [key, structuredClone(records.get(key))])); },
    async set(rows) { for (const [key, value] of Object.entries(rows)) records.set(key, structuredClone(value)); },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) records.delete(key); },
  };
  const snapshot = { model: { auditId: 'audit-1' }, revision: 4, capability: Object.freeze({}) };
  const store = {
    async getAuditSnapshot() { return snapshot; },
    async getReportRevision() { return { version: 1, auditId: 'audit-1', modelRevision: 4, modelHash: 'a'.repeat(64), model: { auditId: 'audit-1' }, checkpoint: {} }; },
    async acquireExportLease(_id, capability, options) { assert.equal(capability, snapshot.capability); calls.push(['lease', options.ownerId]); return { acquired: true, exportAttempt: 7, revision: 4, expiresAt: '2026-08-29T12:10:00.000Z' }; },
    async getExportReceipt() { calls.push(['receipt-reread']); return { version: 1, auditId: 'audit-1', modelRevision: 4, modelHash: 'a'.repeat(64), attemptId: '7', status: 'complete',
      formats: ['html', 'pdf', 'csv', 'json'].map((format, index) => ({ format, mimeType: {
        html: 'text/html;charset=utf-8', pdf: 'application/pdf', csv: 'text/csv;charset=utf-8', json: 'application/json;charset=utf-8',
      }[format], byteSize: index + 1, sha256: String(index).repeat(64), downloadId: index + 1, state: 'complete' })) }; },
    async completeExport(_auditId, value) { calls.push(['completion', value.attemptId]); return { completed: true }; },
  };
  const reportLaunch = {
    async authorizeExport() { return { ok: true, auditId: 'audit-1', windowId: 9, sessionCapabilityId: 'R'.repeat(22) }; },
    async validateConsumer() { return true; },
  };
  const chromeApi = {
    runtime: {
      id: 'ext-test', getURL: path => `chrome-extension://ext-test/${path}`,
      async getContexts() { return [{ contextType: 'TAB', documentId: 'export-doc', documentUrl: 'chrome-extension://ext-test/src/export/index.html?auditId=audit-1', tabId: 51, windowId: 9 }]; },
    },
    tabs: {
      async create(options) { calls.push(['create', options]); return { id: 51, windowId: 9, url: 'about:blank' }; },
      async update(tabId, options) { calls.push(['navigate', tabId, options.url]); return { id: tabId, windowId: 9, url: options.url }; },
      async remove(tabId) { calls.push(['remove', tabId]); },
    },
  };
  const authority = createExportLaunchAuthority({
    chromeApi, sessionArea: area, auditStore: store, reportLaunch, epochNow: () => 1000,
    modelNow: () => '2026-08-29T12:00:00.000Z', randomBytes: size => new Uint8Array(size).fill(nextByte++),
  });
  const requested = await authority.requestExport({
    auditId: 'audit-1', sessionCapabilityId: 'R'.repeat(22),
    sender: { id: 'ext-test', documentId: 'review-doc', url: 'chrome-extension://ext-test/src/review/index.html?auditId=audit-1' },
  });
  assert.equal(requested.ok, true);
  assert.equal(requested.attemptId, '7');
  assert.deepEqual(calls.find(call => call[0] === 'lease'), ['lease', 'export:audit-1:pending']);
  const navigation = calls.find(call => call[0] === 'navigate')[2];
  assert.equal(navigation, 'chrome-extension://ext-test/src/export/index.html?auditId=audit-1');
  assert.doesNotMatch(navigation, /capability|lease|attempt|revision|#|&/iu);
  const sender = { id: 'ext-test', documentId: 'export-doc', url: navigation };
  const connected = await Promise.all([
    authority.connect({ auditId: 'audit-1', sender }),
    authority.connect({ auditId: 'audit-1', sender }),
  ]);
  assert.equal(connected.filter(result => result.ok === true).length, 1);
  const session = connected.find(result => result.ok);
  assert.deepEqual(Object.keys(session).sort(), ['attemptId', 'auditId', 'expectedRevision', 'ok', 'sessionCapabilityId']);
  assert.deepEqual(await authority.complete({ sessionCapabilityId: session.sessionCapabilityId, auditId: 'audit-1', attemptId: '7', sender }),
    { ok: true, auditId: 'audit-1', state: 'terminal' });
  assert.equal(calls.filter(call => call[0] === 'receipt-reread').length, 1);
  assert.deepEqual(calls.filter(call => call[0] === 'completion'), [['completion', '7']]);
  assert.deepEqual(await authority.complete({ sessionCapabilityId: session.sessionCapabilityId, auditId: 'audit-1', attemptId: '7', sender }),
    { ok: false, code: 'EXPORT_COMPLETE_DENIED' });
});
