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
  const records = new Map(); const calls = []; let nextByte = 1; let completionFailures = 1;
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
    async releaseExportLease() { return true; },
    async getExportReceipt() { calls.push(['receipt-reread']); return { version: 1, auditId: 'audit-1', modelRevision: 4, modelHash: 'a'.repeat(64), attemptId: '7', status: 'complete',
      formats: ['html', 'pdf', 'csv', 'json'].map((format, index) => ({ format, mimeType: {
        html: 'text/html;charset=utf-8', pdf: 'application/pdf', csv: 'text/csv;charset=utf-8', json: 'application/json;charset=utf-8',
      }[format], byteSize: index + 1, sha256: String(index).repeat(64), downloadId: index + 1, state: 'complete' })) }; },
    async completeExport(_auditId, value) {
      calls.push(['completion', value.attemptId]);
      if (completionFailures-- > 0) throw new Error('durable finalize unavailable');
      return { completed: true };
    },
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
  await assert.rejects(authority.complete({ sessionCapabilityId: session.sessionCapabilityId, auditId: 'audit-1', attemptId: '7', sender }),
    /durable finalize unavailable/u);
  assert.equal((await authority.getLaunch('audit-1')).state, 'connected');
  assert.equal((await authority.getSession(session.sessionCapabilityId)).state, 'active');
  assert.deepEqual(await authority.complete({ sessionCapabilityId: session.sessionCapabilityId, auditId: 'audit-1', attemptId: '7', sender }),
    { ok: true, auditId: 'audit-1', state: 'terminal' });
  assert.equal(calls.filter(call => call[0] === 'receipt-reread').length, 2);
  assert.deepEqual(calls.filter(call => call[0] === 'completion'), [['completion', '7'], ['completion', '7']]);
  assert.deepEqual(await authority.complete({ sessionCapabilityId: session.sessionCapabilityId, auditId: 'audit-1', attemptId: '7', sender }),
    { ok: false, code: 'EXPORT_COMPLETE_DENIED' });
});

test('compensates a proven owned tab and export lease after launch allocation failure', async () => {
  const records = new Map(); const calls = []; let createFails = true; let attempt = 0; let leaseActive = false;
  const sessionArea = {
    async get(keys) { const list = keys === null ? [...records.keys()] : [keys]; return Object.fromEntries(list.filter(key => records.has(key)).map(key => [key, structuredClone(records.get(key))])); },
    async set(rows) { for (const [key, value] of Object.entries(rows)) records.set(key, structuredClone(value)); },
  };
  const snapshot = { model: { auditId: 'audit.retry_1' }, revision: 2, capability: Object.freeze({}) };
  const auditStore = {
    async getAuditSnapshot() { return snapshot; },
    async acquireExportLease() {
      if (leaseActive) return { acquired: false, exportAttempt: attempt, revision: 2 };
      leaseActive = true; attempt += 1; return { acquired: true, exportAttempt: attempt, revision: 2 };
    },
    async releaseExportLease(_auditId, options) {
      calls.push(['release', options.ownerId]);
      if (options.ownerId !== 'export:audit.retry_1:pending') return false;
      leaseActive = false;
      return true;
    },
  };
  const reportLaunch = { async authorizeExport() { return { ok: true, windowId: 3 }; } };
  const chromeApi = {
    runtime: { id: 'ext-test', getURL: path => `chrome-extension://ext-test/${path}`, async getContexts() { return []; } },
    tabs: {
      async create() { if (createFails) { createFails = false; throw new Error('create failed'); } return { id: 81, windowId: 3 }; },
      async update(_id, options) { return { id: 81, windowId: 3, url: options.url }; },
      async remove(id) { calls.push(['remove', id]); },
    },
  };
  const authority = createExportLaunchAuthority({
    chromeApi, sessionArea, auditStore, reportLaunch, epochNow: () => 1000,
    modelNow: () => '2026-08-30T12:00:00.000Z', randomBytes: size => new Uint8Array(size).fill(1),
  });
  const request = { auditId: 'audit.retry_1', sessionCapabilityId: 'R'.repeat(22), sender: {} };
  assert.deepEqual(await authority.requestExport(request), { ok: false, code: 'EXPORT_OPEN_FAILED' });
  assert.deepEqual(calls, [['release', 'export:audit.retry_1:pending']]);
  assert.equal((await authority.requestExport(request)).ok, true);
  assert.equal(calls.some(call => call[0] === 'remove'), false, 'an unproven failed create must not remove a tab');
});

test('releases a lease whose acquired response cannot be correlated to the authorized revision', async () => {
  let leaseActive = false; let attempt = 0; const calls = []; const records = new Map();
  const sessionArea = {
    async get(keys) { const list = keys === null ? [...records.keys()] : [keys]; return Object.fromEntries(list.filter(key => records.has(key)).map(key => [key, structuredClone(records.get(key))])); },
    async set(rows) { for (const [key, value] of Object.entries(rows)) records.set(key, structuredClone(value)); },
  };
  const auditStore = {
    async getAuditSnapshot() { return { model: { auditId: 'audit-lease-validate' }, revision: 2, capability: Object.freeze({}) }; },
    async acquireExportLease() {
      if (leaseActive) return { acquired: false, exportAttempt: attempt, revision: 2 };
      leaseActive = true; attempt += 1;
      return { acquired: true, exportAttempt: attempt, revision: attempt === 1 ? 99 : 2 };
    },
    async releaseExportLease(_auditId, options) {
      calls.push(['release', options.ownerId]);
      if (options.ownerId === 'export:audit-lease-validate:pending') leaseActive = false;
      return !leaseActive;
    },
  };
  const authority = createExportLaunchAuthority({
    chromeApi: { runtime: { getURL: path => `chrome-extension://ext-test/${path}`, async getContexts() { return []; } },
      tabs: { async create() { return { id: 31, windowId: 3 }; }, async update(_id, options) { return { id: 31, windowId: 3, url: options.url }; } } },
    sessionArea, auditStore, reportLaunch: { async authorizeExport() { return { ok: true, windowId: 3 }; } },
    epochNow: () => 1000, modelNow: () => '2026-08-30T12:00:00.000Z', randomBytes: size => new Uint8Array(size),
  });
  const request = { auditId: 'audit-lease-validate', sessionCapabilityId: 'R'.repeat(22), sender: {} };

  assert.deepEqual(await authority.requestExport(request), { ok: false, code: 'EXPORT_LEASE_DENIED' });
  assert.deepEqual(calls, [['release', 'export:audit-lease-validate:pending']]);
  assert.equal((await authority.requestExport(request)).ok, true);
});

test('compensates validate, persist, navigate and confirm failures after lease acquisition', async t => {
  for (const failureStage of ['validate-tab', 'persist-launch', 'persist-index', 'navigate', 'confirm-awaiting']) {
    await t.test(failureStage, async () => {
      const auditId = `audit-${failureStage}`; const records = new Map(); const calls = [];
      let activeLease = false; let attempt = 0; let armed = true;
      const launchKey = `audita:export-launch:v1:${auditId}`;
      const sessionArea = {
        async get(keys) {
          if (armed && failureStage === 'confirm-awaiting' && keys === launchKey && records.get(keys)?.state === 'awaiting-connection') {
            armed = false;
            return {};
          }
          const list = keys === null ? [...records.keys()] : [keys];
          return Object.fromEntries(list.filter(key => records.has(key)).map(key => [key, structuredClone(records.get(key))]));
        },
        async set(rows) {
          const values = Object.values(rows);
          if (armed && failureStage === 'persist-launch' && values.some(value => value?.state === 'allocated')) { armed = false; throw new Error('persist launch'); }
          if (armed && failureStage === 'persist-index' && Object.keys(rows).some(key => key.startsWith('audita:export-launch-tab:v1:'))) { armed = false; throw new Error('persist index'); }
          for (const [key, value] of Object.entries(rows)) records.set(key, structuredClone(value));
        },
      };
      const auditStore = {
        async getAuditSnapshot() { return { model: { auditId }, revision: 1, capability: Object.freeze({}) }; },
        async acquireExportLease() {
          if (activeLease) return { acquired: false, exportAttempt: attempt, revision: 1 };
          activeLease = true; attempt += 1; return { acquired: true, exportAttempt: attempt, revision: 1 };
        },
        async releaseExportLease(_auditId, options) {
          calls.push(['release', options.ownerId]);
          if (options.ownerId !== `export:${auditId}:pending`) return false;
          activeLease = false; return true;
        },
      };
      const chromeApi = {
        runtime: { getURL: path => `chrome-extension://ext-test/${path}`, async getContexts() { return []; } },
        tabs: {
          async create() {
            if (armed && failureStage === 'validate-tab') { armed = false; return { id: 'invalid', windowId: 3 }; }
            return { id: 201, windowId: 3 };
          },
          async update(_id, options) {
            if (armed && failureStage === 'navigate') { armed = false; throw new Error('navigate'); }
            return { id: 201, windowId: 3, url: options.url };
          },
          async remove(id) { calls.push(['remove', id]); },
        },
      };
      const authority = createExportLaunchAuthority({ chromeApi, sessionArea, auditStore,
        reportLaunch: { async authorizeExport() { return { ok: true, windowId: 3 }; } },
        epochNow: () => 1000, modelNow: () => '2026-08-30T12:00:00.000Z', randomBytes: size => new Uint8Array(size).fill(3) });
      const request = { auditId, sessionCapabilityId: 'R'.repeat(22), sender: {} };

      assert.deepEqual(await authority.requestExport(request), { ok: false, code: 'EXPORT_OPEN_FAILED' });
      assert.equal(activeLease, false);
      assert.deepEqual(calls.filter(call => call[0] === 'release'), [['release', `export:${auditId}:pending`]]);
      assert.deepEqual(calls.filter(call => call[0] === 'remove'), failureStage === 'validate-tab' ? [] : [['remove', 201]]);
      assert.equal((await authority.requestExport(request)).ok, true, 'a compensated failure must permit an immediate retry');
    });
  }
});

test('revokes an active export when its source report consumer is revoked', async () => {
  const records = new Map(); const calls = []; let sourceActive = true;
  const sessionArea = {
    async get(keys) { const list = keys === null ? [...records.keys()] : [keys]; return Object.fromEntries(list.filter(key => records.has(key)).map(key => [key, structuredClone(records.get(key))])); },
    async set(rows) { for (const [key, value] of Object.entries(rows)) records.set(key, structuredClone(value)); },
  };
  const snapshot = { model: { auditId: 'audit-1' }, revision: 1, capability: Object.freeze({}) };
  const auditStore = {
    async getAuditSnapshot() { return snapshot; },
    async acquireExportLease() { return { acquired: true, exportAttempt: 1, revision: 1 }; },
    async releaseExportLease(_auditId, options) { calls.push(['release', options.ownerId]); return true; },
  };
  const reportLaunch = {
    async authorizeExport() { return { ok: true, windowId: 7 }; },
    async validateConsumer() { return sourceActive; },
  };
  const chromeApi = {
    runtime: {
      id: 'ext-test', getURL: path => `chrome-extension://ext-test/${path}`,
      async getContexts() { return [{ contextType: 'TAB', documentId: 'export-doc', documentUrl: 'chrome-extension://ext-test/src/export/index.html?auditId=audit-1', tabId: 51, windowId: 7 }]; },
    },
    tabs: {
      async create() { return { id: 51, windowId: 7 }; },
      async update(_id, options) { return { id: 51, windowId: 7, url: options.url }; },
      async remove(id) { calls.push(['remove', id]); },
    },
  };
  const authority = createExportLaunchAuthority({ chromeApi, sessionArea, auditStore, reportLaunch,
    epochNow: () => 1000, modelNow: () => '2026-08-30T12:00:00.000Z', randomBytes: size => new Uint8Array(size).fill(2) });
  await authority.requestExport({ auditId: 'audit-1', sessionCapabilityId: 'R'.repeat(22), sender: {} });
  const sender = { id: 'ext-test', documentId: 'export-doc', url: 'chrome-extension://ext-test/src/export/index.html?auditId=audit-1' };
  const connected = await authority.connect({ auditId: 'audit-1', sender });
  sourceActive = false;
  assert.equal(await authority.handleTabUpdated(40, { status: 'loading' }), true);
  assert.equal((await authority.getLaunch('audit-1')).state, 'revoked');
  assert.equal((await authority.getSession(connected.sessionCapabilityId)).state, 'revoked');
  assert.deepEqual(calls, [['release', 'export:audit-1:1'], ['remove', 51]]);
});

test('keeps lease and owned tab when durable launch revocation cannot be confirmed', async () => {
  const auditId = 'audit-1'; const calls = [];
  const key = `audita:export-launch:v1:${auditId}`;
  const launch = { version: 1, auditId, sourceReviewSessionCapabilityId: 'R'.repeat(22), expectedRevision: 1,
    attemptId: '1', tabId: 51, windowId: 7, path: '/src/export/index.html', documentId: 'export-doc',
    state: 'connected', issuedAt: 1000, expiresAt: 901000 };
  const records = new Map([[key, launch]]);
  const sessionArea = {
    async get(keys) { const list = keys === null ? [...records.keys()] : [keys]; return Object.fromEntries(list.filter(entry => records.has(entry)).map(entry => [entry, structuredClone(records.get(entry))])); },
    async set(rows) {
      if (rows[key]?.state === 'revoked') throw new Error('durable session unavailable');
      for (const [entry, value] of Object.entries(rows)) records.set(entry, structuredClone(value));
    },
  };
  const authority = createExportLaunchAuthority({
    chromeApi: { runtime: { getURL: path => `chrome-extension://ext-test/${path}`, async getContexts() { return []; } },
      tabs: { async create() {}, async update() {}, async remove(id) { calls.push(['remove', id]); } } },
    sessionArea,
    auditStore: { async getAuditSnapshot() {}, async acquireExportLease() {}, async releaseExportLease() { calls.push(['release']); return true; } },
    reportLaunch: { async authorizeExport() {}, async validateConsumer() { return false; } },
    epochNow: () => 1000, modelNow: () => '2026-08-30T12:00:00.000Z', randomBytes: size => new Uint8Array(size),
  });

  assert.equal(await authority.handleTabUpdated(99, { status: 'loading' }), false);
  assert.equal((await authority.getLaunch(auditId)).state, 'connected');
  assert.deepEqual(calls, []);
});

test('isolates source validation failures and still revokes later independent exports', async () => {
  const calls = []; const records = new Map();
  for (const [index, auditId] of ['audit-first', 'audit-second'].entries()) {
    records.set(`audita:export-launch:v1:${auditId}`, {
      version: 1, auditId, sourceReviewSessionCapabilityId: String.fromCharCode(82 + index).repeat(22), expectedRevision: 1,
      attemptId: '1', tabId: 60 + index, windowId: 7, path: '/src/export/index.html', documentId: `export-doc-${index}`,
      state: 'connected', issuedAt: 1000, expiresAt: 901000,
    });
  }
  const sessionArea = {
    async get(keys) { const list = keys === null ? [...records.keys()] : [keys]; return Object.fromEntries(list.filter(entry => records.has(entry)).map(entry => [entry, structuredClone(records.get(entry))])); },
    async set(rows) { for (const [entry, value] of Object.entries(rows)) records.set(entry, structuredClone(value)); },
  };
  const authority = createExportLaunchAuthority({
    chromeApi: { runtime: { getURL: path => `chrome-extension://ext-test/${path}`, async getContexts() { return []; } },
      tabs: { async create() {}, async update() {}, async remove(id) { calls.push(['remove', id]); } } },
    sessionArea,
    auditStore: { async getAuditSnapshot() {}, async acquireExportLease() {},
      async releaseExportLease(auditId) { calls.push(['release', auditId]); return true; } },
    reportLaunch: { async authorizeExport() {}, async validateConsumer(_capability, auditId) {
      if (auditId === 'audit-first') throw new Error('source store unavailable');
      return false;
    } },
    epochNow: () => 1000, modelNow: () => '2026-08-30T12:00:00.000Z', randomBytes: size => new Uint8Array(size),
  });

  assert.equal(await authority.handleTabUpdated(99, { status: 'loading' }), true);
  assert.equal((await authority.getLaunch('audit-first')).state, 'connected');
  assert.equal((await authority.getLaunch('audit-second')).state, 'revoked');
  assert.deepEqual(calls, [['release', 'audit-second'], ['remove', 61]]);
});
