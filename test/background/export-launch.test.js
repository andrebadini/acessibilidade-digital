import assert from 'node:assert/strict';
import test from 'node:test';

import { createExportLaunchAuthority, deriveExportLeaseOwner } from '../../src/background/export-launch.js';

function navigationFixture({
  completionFailures = 0,
  terminalFailures = 0,
  deleted = true,
  receiptStatus = 'complete',
  receiptFormats = ['html', 'pdf', 'csv', 'json'],
} = {}) {
  const auditId = 'audit-navigation';
  const windowId = 7;
  const tabId = 51;
  const canonical = `chrome-extension://ext-test/src/export/index.html?auditId=${auditId}`;
  const records = new Map();
  const calls = [];
  let currentTab = { id: tabId, windowId, url: canonical };
  let tabReadSequence = [];
  let failTabRead = false;
  let contextDocument = 'export-doc';
  let epoch = 1000;
  const sessionArea = {
    async get(keys) {
      const list = keys === null ? [...records.keys()] : (Array.isArray(keys) ? keys : [keys]);
      return Object.fromEntries(list.filter(key => records.has(key)).map(key => [key, structuredClone(records.get(key))]));
    },
    async set(rows) { for (const [key, value] of Object.entries(rows)) records.set(key, structuredClone(value)); },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) records.delete(key); },
  };
  const capability = Object.freeze({});
  const auditStore = {
    async setRetentionIntent() {},
    async getAuditSnapshot() { return { model: { auditId }, revision: 1, capability }; },
    async acquireExportLease(_auditId, receivedCapability) {
      assert.equal(receivedCapability, capability);
      return { acquired: true, exportAttempt: 1, revision: 1 };
    },
    async releaseExportLease(_auditId, options) { calls.push(['release', options.ownerId]); return true; },
    async getExportReceipt() {
      calls.push(['receipt']);
      return {
        version: 1, auditId, modelRevision: 1, modelHash: 'a'.repeat(64), attemptId: '1', status: receiptStatus,
        formats: receiptFormats.map((format, index) => ({
          format,
          mimeType: {
            html: 'text/html;charset=utf-8', pdf: 'application/pdf',
            csv: 'text/csv;charset=utf-8', json: 'application/json;charset=utf-8',
          }[format],
          byteSize: index + 1, sha256: String(index).repeat(64), downloadId: index + 1, state: 'complete',
        })),
      };
    },
    async completeExport(_auditId, options) {
      calls.push(['complete', options]);
      if (completionFailures-- > 0) throw new Error('controlled completion failure');
      return { completed: true, deleted, status: receiptStatus };
    },
    async emitTerminal(event) {
      calls.push(['terminal', event]);
      if (terminalFailures-- > 0) throw new Error('controlled terminal failure');
    },
  };
  const chromeApi = {
    runtime: {
      id: 'ext-test',
      getURL: path => `chrome-extension://ext-test/${path}`,
      async getContexts() {
        return contextDocument === null ? []
          : [{ contextType: 'TAB', documentId: contextDocument, documentUrl: canonical, tabId, windowId }];
      },
    },
    tabs: {
      async create(options) { calls.push(['create', options]); return { id: tabId, windowId, url: 'about:blank' }; },
      async update(receivedTabId, options) {
        calls.push(['navigate', receivedTabId, options.url]);
        currentTab = { id: receivedTabId, windowId, url: options.url };
        return structuredClone(currentTab);
      },
      async get(receivedTabId) {
        calls.push(['get', receivedTabId]);
        if (failTabRead) throw new Error('private');
        const next = tabReadSequence.length > 0 ? tabReadSequence.shift() : currentTab;
        return typeof next === 'string' ? { id: receivedTabId, windowId, url: next } : next;
      },
      async remove(receivedTabId) { calls.push(['remove', receivedTabId]); },
    },
  };
  const reportLaunch = {
    async authorizeExport() { return { ok: true, auditId, windowId, sessionCapabilityId: 'R'.repeat(22) }; },
    async validateConsumer() { return true; },
  };
  const authority = createExportLaunchAuthority({
    chromeApi, sessionArea, auditStore, reportLaunch,
    epochNow: () => epoch,
    modelNow: () => '2026-08-30T12:00:00.000Z',
    randomBytes: size => new Uint8Array(size).fill(3),
  });
  const request = {
    auditId, sessionCapabilityId: 'R'.repeat(22),
    sender: { id: 'ext-test', documentId: 'review-doc', url: `chrome-extension://ext-test/src/review/index.html?auditId=${auditId}` },
  };
  const sender = { id: 'ext-test', documentId: 'export-doc', url: canonical };
  return {
    auditId, authority, calls, canonical, request, sender, tabId, windowId,
    chromeApi, sessionArea, auditStore, reportLaunch,
    setCurrentTab(value) { currentTab = value; },
    setDocument(value) { contextDocument = value; },
    setEpoch(value) { epoch = value; },
    setTabReadFailure(value) { failTabRead = value; },
    setTabReadSequence(values) { tabReadSequence = [...values]; },
  };
}

test('attempt identity is a canonical decimal string and its private owner is deterministic', () => {
  assert.equal(deriveExportLeaseOwner('audit-1', '7'), 'export:audit-1:7');
  for (const value of ['0', '01', '-1', '1.0', '9007199254740992']) {
    assert.throws(() => deriveExportLeaseOwner('audit-1', value), /EXPORT_ATTEMPT_DENIED/u);
  }
});

test('post-export preference is written after authorization and lease, before tab creation, with default off', async () => {
  for (const value of [undefined, false, true]) {
    const env = navigationFixture();
    const acquired = env.auditStore.acquireExportLease;
    env.auditStore.acquireExportLease = async (...args) => { env.calls.push(['lease']); return acquired(...args); };
    env.auditStore.setRetentionIntent = async (id, capability, options) => {
      assert.equal(id, env.auditId);
      assert.ok(capability);
      env.calls.push(['preference', options.deleteAfterCompleteExport]);
    };
    assert.equal((await env.authority.requestExport({ ...env.request,
      ...(value === undefined ? {} : { deleteAfterCompleteExport: value }) })).ok, true);
    assert.deepEqual(env.calls.slice(0, 3).map(call => call[0]), ['lease', 'preference', 'create']);
    assert.equal(env.calls.find(call => call[0] === 'preference')[1], value === true);
    assert.equal((await env.authority.requestExport({ ...env.request, deleteAfterCompleteExport: !value })).code, 'EXPORT_ALREADY_ACTIVE');
    assert.equal(env.calls.filter(call => call[0] === 'preference').length, 1);
  }
});

test('post-export preference failure releases lease without creating a tab; foreign sender has zero effects', async () => {
  const env = navigationFixture();
  env.auditStore.setRetentionIntent = async () => { throw new Error('private storage detail'); };
  assert.deepEqual(await env.authority.requestExport({ ...env.request, deleteAfterCompleteExport: true }),
    { ok: false, code: 'EXPORT_OPEN_FAILED' });
  assert.ok(env.calls.some(call => call[0] === 'release'));
  assert.equal(env.calls.some(call => call[0] === 'create'), false);
  const foreign = navigationFixture();
  foreign.reportLaunch.authorizeExport = async () => ({ ok: false });
  foreign.auditStore.setRetentionIntent = async () => { throw new Error('must not run'); };
  assert.equal((await foreign.authority.requestExport({ ...foreign.request, deleteAfterCompleteExport: true })).ok, false);
  assert.deepEqual(foreign.calls, []);
});

test('accepts every exact pre-connection staging snapshot immediately without a timer', async () => {
  const snapshots = input => [
    { id: input.tabId, windowId: input.windowId, url: input.canonical },
    { id: input.tabId, windowId: input.windowId, url: input.canonical, pendingUrl: input.canonical },
    { id: input.tabId, windowId: input.windowId, url: 'about:blank', pendingUrl: input.canonical },
  ];
  for (const snapshot of snapshots(navigationFixture())) {
    const input = navigationFixture();
    assert.equal((await input.authority.requestExport(input.request)).ok, true);
    input.setCurrentTab(snapshot);

    assert.equal(await input.authority.handleTabUpdated(input.tabId, { status: 'loading', url: 'about:blank' }), false);
    assert.equal(input.calls.filter(call => call[0] === 'get').length, 1);
    assert.equal((await input.authority.getLaunch(input.auditId)).state, 'awaiting-connection');
    assert.equal(input.calls.some(call => call[0] === 'release' || call[0] === 'remove'), false);
  }
});

test('revokes a pre-connection export immediately for any noncanonical URL', async () => {
  for (const url of ['https://outside.example/',
    'chrome-extension://ext-test/src/export/index.html?auditId=audit-navigation&extra=1']) {
    const input = navigationFixture();
    assert.equal((await input.authority.requestExport(input.request)).ok, true);
    input.setTabReadFailure(true);

    assert.equal(await input.authority.handleTabUpdated(input.tabId, { status: 'loading', url }), true);
    assert.equal(input.calls.filter(call => call[0] === 'get').length, 0);
    assert.equal((await input.authority.getLaunch(input.auditId)).state, 'revoked');
  }
});

test('tolerates the transient staging state of its own navigation and revokes it after the grace window', async () => {
  // Defeito medido na revisão adversarial da 1.1.49 (N-2): sob carga, o evento de `tabs.onUpdated` da PRÓPRIA
  // aba recém-criada (`about:blank` sem `pendingUrl` publicado) chegava depois de a concessão existir e a
  // revogava — a exportação do usuário morria sem produzir arquivo, com o relatório já respondendo "ok".
  const input = navigationFixture();
  assert.equal((await input.authority.requestExport(input.request)).ok, true);
  input.setCurrentTab({ id: input.tabId, windowId: input.windowId, url: 'about:blank' });

  assert.equal(await input.authority.handleTabUpdated(input.tabId, { status: 'loading' }), false,
    'o estado pendente da nossa própria navegação não pode revogar a concessão');
  assert.equal((await input.authority.getLaunch(input.auditId)).state, 'awaiting-connection',
    'a concessão tem de continuar viva depois do evento transitório');
  assert.equal(input.calls.some(call => call[0] === 'release' || call[0] === 'remove'), false);

  input.setEpoch(1000 + 30_000);
  assert.equal(await input.authority.handleTabUpdated(input.tabId, { status: 'loading' }), false,
    'dentro da janela a mesma leitura continua tolerada');

  input.setEpoch(1000 + 30_001);
  assert.equal(await input.authority.handleTabUpdated(input.tabId, { status: 'loading' }), true,
    'fora da janela, um estado que não prova a aba de exportação volta a revogar');
  assert.equal((await input.authority.getLaunch(input.auditId)).state, 'revoked');
});

test('re-proves a canonical pre-connection event against the current exact export tab', async () => {
  for (const mode of ['canonical', 'stale-external', 'pending-external', 'read-failed']) {
    const input = navigationFixture();
    assert.equal((await input.authority.requestExport(input.request)).ok, true);
    if (mode === 'stale-external') input.setCurrentTab({
      id: input.tabId, windowId: input.windowId, url: 'https://outside.example/',
    });
    else if (mode === 'pending-external') input.setCurrentTab({
      id: input.tabId, windowId: input.windowId, url: input.canonical, pendingUrl: 'https://outside.example/',
    });
    else if (mode === 'read-failed') input.setTabReadFailure(true);

    const updated = await input.authority.handleTabUpdated(input.tabId, { status: 'loading', url: input.canonical });
    assert.equal(updated, mode !== 'canonical', mode);
    assert.equal((await input.authority.getLaunch(input.auditId)).state,
      mode === 'canonical' ? 'awaiting-connection' : 'revoked', mode);
  }
});

test('fails closed immediately when one fresh read cannot prove an exact export staging snapshot', async () => {
  // 'still-blank' saiu daqui na 1.1.49: o estado `about:blank` sem `pendingUrl` é o INTERMEDIÁRIO da
  // navegação que a própria autoridade iniciou, e revogá-lo era o defeito N-2 medido sob carga. O caso
  // passou a ter teste próprio, logo abaixo, com a janela de tolerância e o desfecho depois dela.
  for (const mode of ['read-failed', 'url-absent', 'wrong-tab', 'wrong-window', 'pending-external']) {
    const input = navigationFixture();
    assert.equal((await input.authority.requestExport(input.request)).ok, true);
    if (mode === 'read-failed') input.setTabReadFailure(true);
    else if (mode === 'url-absent') input.setCurrentTab({ id: input.tabId, windowId: input.windowId });
    else if (mode === 'wrong-tab') input.setCurrentTab({ id: input.tabId + 1, windowId: input.windowId, url: input.canonical });
    else if (mode === 'wrong-window') input.setCurrentTab({ id: input.tabId, windowId: input.windowId + 1, url: input.canonical });
    else if (mode === 'pending-external') input.setCurrentTab({
      id: input.tabId, windowId: input.windowId, url: input.canonical, pendingUrl: 'https://outside.example/',
    });
    else input.setCurrentTab({ id: input.tabId, windowId: input.windowId, url: 'about:blank' });

    const event = ['url-absent', 'pending-external'].includes(mode)
      ? { status: 'loading' }
      : { status: 'loading', url: 'about:blank' };
    assert.equal(await input.authority.handleTabUpdated(input.tabId, event), true, mode);
    assert.equal(input.calls.filter(call => call[0] === 'get').length, 1, mode);
    assert.equal((await input.authority.getLaunch(input.auditId)).state, 'revoked', mode);
  }
});

test('ignores delayed connected export events only while the same document remains exact', async () => {
  const input = navigationFixture();
  assert.equal((await input.authority.requestExport(input.request)).ok, true);
  assert.equal((await input.authority.connect({ auditId: input.auditId, sender: input.sender })).ok, true);

  assert.equal(await input.authority.handleTabUpdated(input.tabId, { status: 'complete' }), false);
  assert.equal((await input.authority.getLaunch(input.auditId)).state, 'connected');
  assert.equal(await input.authority.handleTabUpdated(input.tabId, {
    status: 'loading', url: 'https://stale-event.example/',
  }), false);
  assert.equal((await input.authority.getLaunch(input.auditId)).state, 'connected');
});

test('revokes connected export authority on every absent, divergent or navigating proof', async () => {
  for (const mode of ['document-absent', 'document-replaced', 'pending-canonical', 'pending-external', 'tab-read-failed']) {
    const input = navigationFixture();
    assert.equal((await input.authority.requestExport(input.request)).ok, true);
    assert.equal((await input.authority.connect({ auditId: input.auditId, sender: input.sender })).ok, true);
    if (mode === 'document-absent') input.setDocument(null);
    else if (mode === 'document-replaced') input.setDocument('replacement-doc');
    else if (mode === 'pending-canonical') input.setCurrentTab({
      id: input.tabId, windowId: input.windowId, url: input.canonical, pendingUrl: input.canonical,
    });
    else if (mode === 'pending-external') input.setCurrentTab({
      id: input.tabId, windowId: input.windowId, url: input.canonical, pendingUrl: 'https://outside.example/',
    });
    else input.setTabReadFailure(true);

    assert.equal(await input.authority.handleTabUpdated(input.tabId, {
      status: 'loading', url: 'about:blank',
    }), true, mode);
    assert.equal((await input.authority.getLaunch(input.auditId)).state, 'revoked', mode);
  }
});

test('reads native tab proof only through own data descriptors', async () => {
  const input = navigationFixture();
  assert.equal((await input.authority.requestExport(input.request)).ok, true);
  let getterReads = 0;
  const hostile = { id: input.tabId, windowId: input.windowId, url: input.canonical };
  Object.defineProperty(hostile, 'pendingUrl', { enumerable: true, get() { getterReads += 1; return input.canonical; } });
  input.setCurrentTab(hostile);

  assert.equal(await input.authority.handleTabUpdated(input.tabId, { status: 'loading', url: input.canonical }), true);
  assert.equal(getterReads, 0);
  assert.equal((await input.authority.getLaunch(input.auditId)).state, 'revoked');
});

test('replays a lost terminal acknowledgement without repeating completion effects', async () => {
  const input = navigationFixture();
  assert.equal((await input.authority.requestExport(input.request)).ok, true);
  const session = await input.authority.connect({ auditId: input.auditId, sender: input.sender });
  assert.equal(session.ok, true);
  const completion = {
    sessionCapabilityId: session.sessionCapabilityId,
    auditId: input.auditId,
    attemptId: '1',
    sender: input.sender,
  };

  await input.authority.complete(completion); // the caller loses this successful response
  const terminalProof = {
    version: 1,
    auditId: input.auditId,
    sessionCapabilityId: session.sessionCapabilityId,
    attemptId: '1',
    modelRevision: 1,
    receiptStatus: 'complete',
    applied: true,
    deleted: true,
    status: 'complete',
    notified: true,
  };
  const terminalLaunch = await input.authority.getLaunch(input.auditId);
  const terminalSession = await input.authority.getSession(session.sessionCapabilityId);
  assert.equal(terminalLaunch.state, 'terminal');
  assert.deepEqual(terminalLaunch.terminalProof, terminalProof);
  assert.equal(terminalSession.state, 'terminal');
  assert.deepEqual(terminalSession.terminalProof, terminalProof);
  assert.deepEqual(await input.authority.complete(completion), {
    ok: true, auditId: input.auditId, state: 'terminal',
  });
  assert.equal(input.calls.filter(([type]) => type === 'receipt').length, 1);
  assert.equal(input.calls.filter(([type]) => type === 'complete').length, 1);
  assert.equal(input.calls.filter(([type]) => type === 'terminal').length, 1);

  const divergent = [
    ['capability', { ...completion, sessionCapabilityId: 'S'.repeat(22) }],
    ['audit', { ...completion, auditId: 'audit-navigation-other' }],
    ['attempt', { ...completion, attemptId: '2' }],
    ['sender', { ...completion, sender: { ...input.sender, documentId: 'replacement-doc' } }],
  ];
  for (const [label, request] of divergent) {
    assert.equal((await input.authority.complete(request)).ok, false, label);
  }
  assert.equal(input.calls.filter(([type]) => type === 'receipt').length, 1);
  assert.equal(input.calls.filter(([type]) => type === 'complete').length, 1);
  assert.equal(input.calls.filter(([type]) => type === 'terminal').length, 1);

});

test('replays an exactly correlated terminal acknowledgement after its active TTL expires', async () => {
  const input = navigationFixture();
  assert.equal((await input.authority.requestExport(input.request)).ok, true);
  const session = await input.authority.connect({ auditId: input.auditId, sender: input.sender });
  const completion = {
    sessionCapabilityId: session.sessionCapabilityId,
    auditId: input.auditId,
    attemptId: '1',
    sender: input.sender,
  };
  await input.authority.complete(completion); // successful response is lost before the caller observes it
  input.setEpoch(901001);

  assert.deepEqual(await input.authority.complete(completion), {
    ok: true, auditId: input.auditId, state: 'terminal',
  });
  assert.equal(input.calls.filter(([type]) => type === 'receipt').length, 1);
  assert.equal(input.calls.filter(([type]) => type === 'complete').length, 1);
  assert.equal(input.calls.filter(([type]) => type === 'terminal').length, 1);

  const active = navigationFixture();
  assert.equal((await active.authority.requestExport(active.request)).ok, true);
  const activeSession = await active.authority.connect({ auditId: active.auditId, sender: active.sender });
  active.setEpoch(901001);
  assert.deepEqual(await active.authority.complete({
    sessionCapabilityId: activeSession.sessionCapabilityId,
    auditId: active.auditId,
    attemptId: '1',
    sender: active.sender,
  }), { ok: false, code: 'EXPORT_COMPLETE_DENIED' });
  assert.equal(active.calls.filter(([type]) => type === 'receipt').length, 0);
});

test('resumes an unapplied terminal proof without requiring the deleted receipt', async () => {
  const input = navigationFixture({ completionFailures: 1 });
  assert.equal((await input.authority.requestExport(input.request)).ok, true);
  const session = await input.authority.connect({ auditId: input.auditId, sender: input.sender });
  const completion = {
    sessionCapabilityId: session.sessionCapabilityId,
    auditId: input.auditId,
    attemptId: '1',
    sender: input.sender,
  };

  await assert.rejects(input.authority.complete(completion), /controlled completion failure/u);
  const pendingProof = {
    version: 1,
    auditId: input.auditId,
    sessionCapabilityId: session.sessionCapabilityId,
    attemptId: '1',
    modelRevision: 1,
    receiptStatus: 'complete',
    applied: false,
    deleted: false,
    status: null,
    notified: false,
  };
  assert.deepEqual((await input.authority.getLaunch(input.auditId)).terminalProof, pendingProof);
  assert.deepEqual((await input.authority.getSession(session.sessionCapabilityId)).terminalProof, pendingProof);
  assert.equal(input.calls.filter(([type]) => type === 'receipt').length, 1);

  assert.deepEqual(await input.authority.complete(completion), {
    ok: true, auditId: input.auditId, state: 'terminal',
  });
  const completionCalls = input.calls.filter(([type]) => type === 'complete');
  assert.equal(completionCalls.length, 2);
  assert.equal(Object.hasOwn(completionCalls[0][1], 'receipt'), true);
  assert.equal(Object.hasOwn(completionCalls[1][1], 'receipt'), false);
  assert.deepEqual(completionCalls[1][1].terminalProof, pendingProof);
  assert.equal(input.calls.filter(([type]) => type === 'receipt').length, 1);
  assert.equal(input.calls.filter(([type]) => type === 'terminal').length, 1);
  assert.equal((await input.authority.getLaunch(input.auditId)).terminalProof.applied, true);
  assert.equal((await input.authority.getLaunch(input.auditId)).terminalProof.notified, true);
});

test('retries a missing terminal notification without reapplying completion', async () => {
  const input = navigationFixture({ terminalFailures: 1 });
  assert.equal((await input.authority.requestExport(input.request)).ok, true);
  const session = await input.authority.connect({ auditId: input.auditId, sender: input.sender });
  const completion = {
    sessionCapabilityId: session.sessionCapabilityId,
    auditId: input.auditId,
    attemptId: '1',
    sender: input.sender,
  };

  await assert.rejects(input.authority.complete(completion), /controlled terminal failure/u);
  const interruptedProof = (await input.authority.getLaunch(input.auditId)).terminalProof;
  assert.deepEqual(interruptedProof, {
    version: 1,
    auditId: input.auditId,
    sessionCapabilityId: session.sessionCapabilityId,
    attemptId: '1',
    modelRevision: 1,
    receiptStatus: 'complete',
    applied: true,
    deleted: true,
    status: 'complete',
    notified: false,
  });

  assert.deepEqual(await input.authority.complete(completion), {
    ok: true, auditId: input.auditId, state: 'terminal',
  });
  assert.equal(input.calls.filter(([type]) => type === 'receipt').length, 1);
  assert.equal(input.calls.filter(([type]) => type === 'complete').length, 1);
  assert.equal(input.calls.filter(([type]) => type === 'terminal').length, 2);
  assert.equal((await input.authority.getLaunch(input.auditId)).terminalProof.notified, true);

  assert.equal((await input.authority.complete(completion)).ok, true);
  assert.equal(input.calls.filter(([type]) => type === 'terminal').length, 2);
});

test('accepts an exact partial receipt without authorizing deletion', async () => {
  const input = navigationFixture({
    receiptStatus: 'partial',
    receiptFormats: ['html', 'json'],
    deleted: false,
  });
  assert.equal((await input.authority.requestExport(input.request)).ok, true);
  const session = await input.authority.connect({ auditId: input.auditId, sender: input.sender });
  const result = await input.authority.complete({
    sessionCapabilityId: session.sessionCapabilityId,
    auditId: input.auditId,
    attemptId: '1',
    sender: input.sender,
  });

  assert.deepEqual(result, { ok: true, auditId: input.auditId, state: 'terminal' });
  const proof = (await input.authority.getLaunch(input.auditId)).terminalProof;
  assert.equal(proof.receiptStatus, 'partial');
  assert.equal(proof.applied, true);
  assert.equal(proof.deleted, false);
  assert.equal(proof.status, 'partial');
  assert.equal(proof.notified, true);
  const applied = input.calls.find(([type]) => type === 'complete')[1];
  assert.equal(applied.terminalProof.receiptStatus, 'partial');
  assert.equal(applied.terminalProof.deleted, false);
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
    async setRetentionIntent() {},
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
      return { completed: true };
    },
    async emitTerminal(event) { calls.push(['terminal', event]); },
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
      async get(tabId) { return { id: tabId, windowId: 9, url: 'chrome-extension://ext-test/src/export/index.html?auditId=audit-1' }; },
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
  assert.deepEqual(Object.keys(requested).sort(), ['auditId', 'ok', 'state']);
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
  assert.deepEqual(Object.keys(session).sort(), ['attemptId', 'auditId', 'expectedRevision', 'formats', 'ok', 'sessionCapabilityId']);
  assert.deepEqual(session.formats, ['html', 'pdf', 'csv', 'json']);
  assert.deepEqual(await authority.complete({ sessionCapabilityId: session.sessionCapabilityId, auditId: 'audit-1', attemptId: '7', sender }),
    { ok: true, auditId: 'audit-1', state: 'terminal' });
  assert.deepEqual(calls.find(call => call[0] === 'terminal'), ['terminal', { type: 'EXPORT_COMPLETE', auditId: 'audit-1', deleted: false, status: 'complete', exportRevision: 5 }]);
  assert.equal(calls.filter(call => call[0] === 'receipt-reread').length, 1);
  assert.deepEqual(calls.filter(call => call[0] === 'completion'), [['completion', '7']]);
});

test('a subset request survives as an exact receipt while older records still mean all four formats', async () => {
  const mime = {
    html: 'text/html;charset=utf-8', pdf: 'application/pdf',
    csv: 'text/csv;charset=utf-8', json: 'application/json;charset=utf-8',
  };
  const runCase = async ({ formats, deleteAfterCompleteExport = false, expectedFormats }) => {
    const records = new Map(); const calls = []; let nextByte = 1;
    const area = {
      async get(keys) { const list = keys === null ? [...records.keys()] : (Array.isArray(keys) ? keys : [keys]); return Object.fromEntries(list.filter(key => records.has(key)).map(key => [key, structuredClone(records.get(key))])); },
      async set(rows) { for (const [key, value] of Object.entries(rows)) records.set(key, structuredClone(value)); },
      async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) records.delete(key); },
    };
    const snapshot = { model: { auditId: 'audit-1' }, revision: 4, capability: Object.freeze({}) };
    const status = expectedFormats.length === 4 ? 'complete' : 'partial';
    const store = {
      async setRetentionIntent() {},
      async getAuditSnapshot() { return snapshot; },
      async getReportRevision() { return { version: 1, auditId: 'audit-1', modelRevision: 4, modelHash: 'a'.repeat(64), model: { auditId: 'audit-1' }, checkpoint: {} }; },
      async acquireExportLease(_id, capability, options) { calls.push(['lease', options.ownerId]); return { acquired: true, exportAttempt: 7, revision: 4, expiresAt: '2026-08-29T12:10:00.000Z' }; },
      async releaseExportLease() { return true; },
      async getExportReceipt() {
        calls.push(['receipt-reread']);
        return {
          version: 1, auditId: 'audit-1', modelRevision: 4, modelHash: 'a'.repeat(64),
          attemptId: '7', status,
          formats: expectedFormats.map((format, index) => ({
            format, mimeType: mime[format], byteSize: index + 1,
            sha256: String(index).repeat(64), downloadId: index + 1, state: 'complete',
          })),
        };
      },
      async completeExport(_auditId, value) { calls.push(['completion', value.attemptId]); return { completed: true }; },
      async emitTerminal(event) { calls.push(['terminal', event]); },
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
        async get(tabId) { return { id: tabId, windowId: 9, url: 'chrome-extension://ext-test/src/export/index.html?auditId=audit-1' }; },
        async remove(tabId) { calls.push(['remove', tabId]); },
      },
    };
    const authority = createExportLaunchAuthority({
      chromeApi, sessionArea: area, auditStore: store, reportLaunch, epochNow: () => 1000,
      modelNow: () => '2026-08-29T12:00:00.000Z', randomBytes: size => new Uint8Array(size).fill(nextByte++),
    });
    const requested = await authority.requestExport({
      auditId: 'audit-1', sessionCapabilityId: 'R'.repeat(22), deleteAfterCompleteExport,
      ...(formats === undefined ? {} : { formats }),
      sender: { id: 'ext-test', documentId: 'review-doc', url: 'chrome-extension://ext-test/src/review/index.html?auditId=audit-1' },
    });
    assert.equal(requested.ok, true);
    const navigation = calls.find(call => call[0] === 'navigate')[2];
    const sender = { id: 'ext-test', documentId: 'export-doc', url: navigation };
    const session = await authority.connect({ auditId: 'audit-1', sender });
    assert.deepEqual(session.formats, expectedFormats);
    const launch = await authority.getLaunch('audit-1');
    assert.equal(launch.formats, expectedFormats.join(','));
    const completed = await authority.complete({
      sessionCapabilityId: session.sessionCapabilityId, auditId: 'audit-1', attemptId: '7', sender,
    });
    assert.deepEqual(completed, { ok: true, auditId: 'audit-1', state: 'terminal' });
    assert.equal((await authority.getLaunch('audit-1')).terminalProof.status, status);
    return calls;
  };

  const pdfCalls = await runCase({ formats: 'pdf', expectedFormats: ['pdf'] });
  assert.deepEqual(pdfCalls.find(([type]) => type === 'terminal')[1],
    { type: 'EXPORT_COMPLETE', auditId: 'audit-1', deleted: false, status: 'partial', exportRevision: 5 });
  await runCase({ formats: 'html,json', expectedFormats: ['html', 'json'] });
  await runCase({ formats: undefined, expectedFormats: ['html', 'pdf', 'csv', 'json'] });
  await runCase({ formats: 'html,pdf,csv,json', deleteAfterCompleteExport: true,
    expectedFormats: ['html', 'pdf', 'csv', 'json'] });

  // Registro gravado antes da exportação por formato: sem o campo opcional, vale o conjunto completo.
  const legacyRecords = new Map([['audita:export-launch:v1:audit-1', {
    version: 1, auditId: 'audit-1', sourceReviewSessionCapabilityId: 'R'.repeat(22),
    expectedRevision: 4, attemptId: '7', tabId: 51, windowId: 9,
    path: '/src/export/index.html', documentId: null, state: 'awaiting-connection',
    issuedAt: 900, expiresAt: 1100,
  }]]);
  const legacyArea = {
    async get(keys) { const list = keys === null ? [...legacyRecords.keys()] : (Array.isArray(keys) ? keys : [keys]); return Object.fromEntries(list.filter(key => legacyRecords.has(key)).map(key => [key, structuredClone(legacyRecords.get(key))])); },
    async set(rows) { for (const [key, value] of Object.entries(rows)) legacyRecords.set(key, structuredClone(value)); },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) legacyRecords.delete(key); },
  };
  const legacyAuthority = createExportLaunchAuthority({
    chromeApi: {
      runtime: {
        id: 'ext-test', getURL: path => `chrome-extension://ext-test/${path}`,
        async getContexts() { return [{ contextType: 'TAB', documentId: 'export-doc', documentUrl: 'chrome-extension://ext-test/src/export/index.html?auditId=audit-1', tabId: 51, windowId: 9 }]; },
      },
      tabs: { async create() {}, async update() {}, async get() {} },
    },
    sessionArea: legacyArea,
    auditStore: {
      async getAuditSnapshot() {}, async acquireExportLease() {},
      async releaseExportLease() { return true; },
    },
    reportLaunch: { async authorizeExport() {}, async validateConsumer() { return true; } },
    epochNow: () => 1000, modelNow: () => '2026-08-29T12:00:00.000Z',
    randomBytes: size => new Uint8Array(size).fill(9),
  });
  const legacySession = await legacyAuthority.connect({
    auditId: 'audit-1',
    sender: { id: 'ext-test', documentId: 'export-doc', url: 'chrome-extension://ext-test/src/export/index.html?auditId=audit-1' },
  });
  assert.deepEqual(legacySession.formats, ['html', 'pdf', 'csv', 'json']);
  assert.equal(Object.hasOwn(legacyRecords.get('audita:export-launch:v1:audit-1'), 'formats'), false);

  const deniedCalls = [];
  const denied = createExportLaunchAuthority({
    chromeApi: {
      runtime: {
        id: 'ext-test', getURL: path => `chrome-extension://ext-test/${path}`,
        async getContexts() { return []; },
      },
      tabs: {
        async create() { deniedCalls.push('create'); return { id: 51, windowId: 9 }; },
        async update() { deniedCalls.push('update'); },
        async get() { deniedCalls.push('get'); },
      },
    },
    sessionArea: { async get() { return {}; }, async set() {}, async remove() {} },
    auditStore: {
      async getAuditSnapshot() {}, async acquireExportLease() {},
      async releaseExportLease() { return true; },
    },
    reportLaunch: { async authorizeExport() {} },
    epochNow: () => 1000, modelNow: () => '2026-08-29T12:00:00.000Z',
    randomBytes: size => new Uint8Array(size).fill(1),
  });
  const base = {
    auditId: 'audit-1', sessionCapabilityId: 'R'.repeat(22),
    sender: { id: 'ext-test', documentId: 'review-doc' },
  };
  assert.deepEqual(await denied.requestExport({ ...base, formats: 'pdf', deleteAfterCompleteExport: true }),
    { ok: false, code: 'REPORT_EXPORT_DENIED' });
  for (const formats of ['json,html', 'pdf,pdf', '', 'xml']) {
    assert.deepEqual(await denied.requestExport({ ...base, formats }),
      { ok: false, code: 'REPORT_EXPORT_DENIED' }, formats);
  }
  assert.deepEqual(deniedCalls, []);
});

test('compensates a proven owned tab and export lease after launch allocation failure', async () => {
  const records = new Map(); const calls = []; let createFails = true; let attempt = 0; let leaseActive = false;
  const sessionArea = {
    async get(keys) { const list = keys === null ? [...records.keys()] : [keys]; return Object.fromEntries(list.filter(key => records.has(key)).map(key => [key, structuredClone(records.get(key))])); },
    async set(rows) { for (const [key, value] of Object.entries(rows)) records.set(key, structuredClone(value)); },
  };
  const snapshot = { model: { auditId: 'audit.retry_1' }, revision: 2, capability: Object.freeze({}) };
  const auditStore = {
    async setRetentionIntent() {},
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
      async get(id) { return { id, windowId: 3, url: 'chrome-extension://ext-test/src/export/index.html?auditId=audit.retry_1' }; },
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
    async setRetentionIntent() {},
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
      tabs: { async create() { return { id: 31, windowId: 3 }; }, async update(_id, options) { return { id: 31, windowId: 3, url: options.url }; },
        async get(id) { return { id, windowId: 3, url: 'chrome-extension://ext-test/src/export/index.html?auditId=audit-lease-validate' }; } } },
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
        async setRetentionIntent() {},
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
          async get(id) { return { id, windowId: 3, url: `chrome-extension://ext-test/src/export/index.html?auditId=${auditId}` }; },
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
    async setRetentionIntent() {},
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
      async get(id) { return { id, windowId: 7, url: 'chrome-extension://ext-test/src/export/index.html?auditId=audit-1' }; },
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
      tabs: { async create() {}, async update() {}, async get() {}, async remove(id) { calls.push(['remove', id]); } } },
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
      tabs: { async create() {}, async update() {}, async get() {}, async remove(id) { calls.push(['remove', id]); } } },
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

async function exportCleanupFixture(state = 'connected') {
  const env = navigationFixture({ deleted: false });
  assert.equal((await env.authority.requestExport(env.request)).ok, true);
  const connection = await env.authority.connect({ auditId: env.auditId, sender: env.sender });
  assert.equal(connection.ok, true);
  const completion = { auditId: env.auditId, sessionCapabilityId: connection.sessionCapabilityId, attemptId: '1', sender: env.sender };
  if (state === 'terminal') assert.equal((await env.authority.complete(completion)).ok, true);
  const launchKey = `audita:export-launch:v1:${env.auditId}`;
  const indexKey = `audita:export-launch-tab:v1:${env.tabId}`;
  const sessionKey = `audita:export-session:v1:${connection.sessionCapabilityId}`;
  if (state === 'revoked') {
    const launch = await env.authority.getLaunch(env.auditId);
    const session = await env.authority.getSession(connection.sessionCapabilityId);
    await env.sessionArea.set({ [launchKey]: { ...launch, state }, [sessionKey]: { ...session, state } });
  }
  const tabs = new Map([[env.tabId, { id: env.tabId, windowId: 7, url: env.canonical }]]);
  const contexts = new Map([[env.tabId, {
    contextType: 'TAB', documentId: 'export-doc', documentUrl: env.canonical, tabId: env.tabId, windowId: 7,
  }]]);
  env.chromeApi.tabs.get = async tabId => {
    if (!tabs.has(tabId)) throw new Error('PRIVATE_TAB_ERROR');
    return structuredClone(tabs.get(tabId));
  };
  env.chromeApi.tabs.query = async query => { assert.deepEqual(query, {}); return [...tabs.keys()].map(id => ({ id })); };
  env.chromeApi.tabs.remove = async tabId => { env.calls.push(['remove', tabId]); tabs.delete(tabId); contexts.delete(tabId); };
  env.chromeApi.runtime.getContexts = async filter => [...contexts.values()].filter(context =>
    (!filter.tabIds || filter.tabIds.includes(context.tabId)) &&
    (!filter.documentIds || filter.documentIds.includes(context.documentId)) &&
    (!filter.contextTypes || filter.contextTypes.includes(context.contextType)));
  const forbidden = [];
  for (const owner of [env.auditStore, env.reportLaunch]) for (const method of Object.keys(owner)) {
    owner[method] = async () => { forbidden.push(method); throw new Error('PRIVATE_DEPENDENCY_GONE'); };
  }
  env.chromeApi.downloads = {
    async removeFile() { forbidden.push('removeFile'); }, async erase() { forbidden.push('erase'); },
  };
  env.calls.length = 0;
  return { ...env, launchKey, indexKey, sessionKey, connection, completion, tabs, contexts, forbidden };
}

test('export audit cleanup revokes and purges connected terminal and revoked resources without model or download effects', async t => {
  for (const state of ['connected', 'terminal', 'revoked']) await t.test(state, async () => {
    const env = await exportCleanupFixture(state);
    const foreign = { 'audita:export-launch-tab:v1:90': 'audit-other', 'audita:persona-lease:v1:7': { state: 'active' } };
    await env.sessionArea.set(foreign);
    const remove = env.chromeApi.tabs.remove;
    env.chromeApi.tabs.remove = async tabId => {
      const launch = await env.authority.getLaunch(env.auditId);
      const session = await env.authority.getSession(env.connection.sessionCapabilityId);
      assert.equal(launch.state, 'revoked'); assert.equal(session.state, 'revoked');
      assert.equal(Object.hasOwn(launch, 'terminalProof'), false); assert.equal(Object.hasOwn(session, 'terminalProof'), false);
      await remove(tabId);
    };
    assert.equal(await env.authority.clearAudit(env.auditId), true);
    assert.equal(await env.authority.clearAudit(env.auditId), true);
    assert.deepEqual(await env.sessionArea.get(null), foreign);
    assert.deepEqual(env.calls, [['remove', 51]]);
    assert.equal((await env.authority.complete(env.completion)).ok, false);
    assert.deepEqual(env.forbidden, []);
  });
});

test('export audit cleanup accepts equivalent terminal proof after storage reorders object keys', async () => {
  const env = await exportCleanupFixture('terminal');
  const read = env.sessionArea.get;
  const reordered = value => Array.isArray(value) ? value.map(reordered)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, reordered(value[key])])) : value;
  env.sessionArea.get = async keys => reordered(await read(keys));
  assert.equal((await env.authority.getLaunch(env.auditId)).state, 'terminal');
  assert.equal(await env.authority.clearAudit(env.auditId), true);
  assert.deepEqual(await env.sessionArea.get(null), {});
  assert.deepEqual(env.calls, [['remove', 51]]);
  assert.deepEqual(env.forbidden, []);
});

test('export audit cleanup still rejects changed or malformed terminal proof on readback', async t => {
  for (const mode of ['changed-value', 'extra-key', 'getter']) await t.test(mode, async () => {
    const env = await exportCleanupFixture('terminal');
    const read = env.sessionArea.get;
    let getterReads = 0;
    env.sessionArea.get = async keys => {
      const rows = await read(keys);
      if (Array.isArray(keys)) {
        const proof = rows[env.launchKey]?.terminalProof;
        if (proof) {
          if (mode === 'changed-value') proof.notified = !proof.notified;
          if (mode === 'extra-key') proof.extra = true;
          if (mode === 'getter') Object.defineProperty(proof, 'notified', {
            enumerable: true, get() { getterReads += 1; return true; },
          });
        }
      }
      return rows;
    };
    assert.equal(await env.authority.clearAudit(env.auditId), false);
    assert.equal(getterReads, 0);
    assert.deepEqual(env.calls, []);
    assert.equal(env.tabs.has(51), true);
    assert.deepEqual(env.forbidden, []);
  });
});

test('export audit cleanup includes orphan sessions using their exact document and never an index-only tab', async () => {
  const env = await exportCleanupFixture();
  const session = await env.authority.getSession(env.connection.sessionCapabilityId);
  const olderId = 'Z'.repeat(22);
  await env.sessionArea.set({
    [`audita:export-session:v1:${olderId}`]: { ...session, sessionCapabilityId: olderId, launchTabId: 52, launchDocumentId: 'older-doc', state: 'revoked' },
    'audita:export-launch-tab:v1:52': env.auditId,
    'audita:export-launch-tab:v1:53': env.auditId,
  });
  env.tabs.set(52, { id: 52, windowId: 8, url: env.canonical });
  env.contexts.set(52, { ...env.contexts.get(51), tabId: 52, windowId: 8, documentId: 'older-doc' });
  env.tabs.set(53, { id: 53, windowId: 7, url: 'https://unrelated.invalid/' });
  assert.equal(await env.authority.clearAudit(env.auditId), true);
  assert.deepEqual(env.calls, [['remove', 51], ['remove', 52]]);
  assert.equal(env.tabs.has(53), true);
  assert.deepEqual(await env.sessionArea.get(null), {});
  assert.deepEqual(env.forbidden, []);
});

test('export audit cleanup adopts only a stable preconnection document and retains unproved blank or pending tabs', async t => {
  for (const mode of ['canonical', 'blank', 'pending', 'context-missing']) await t.test(mode, async () => {
    const env = await exportCleanupFixture();
    const launch = await env.authority.getLaunch(env.auditId);
    await env.sessionArea.set({ [env.launchKey]: { ...launch, state: 'awaiting-connection', documentId: null } });
    await env.sessionArea.remove(env.sessionKey);
    if (mode === 'blank') env.tabs.get(51).url = 'about:blank';
    if (mode === 'pending') env.tabs.get(51).pendingUrl = env.canonical;
    if (mode === 'context-missing') env.contexts.clear();
    const remove = env.chromeApi.tabs.remove;
    env.chromeApi.tabs.remove = async tabId => {
      assert.equal((await env.authority.getLaunch(env.auditId)).documentId, 'export-doc'); await remove(tabId);
    };
    assert.equal(await env.authority.clearAudit(env.auditId), mode === 'canonical');
    if (mode !== 'canonical') {
      assert.equal(env.tabs.has(51), true);
      assert.equal((await env.authority.getLaunch(env.auditId)).state, 'revoked');
    }
    assert.deepEqual(env.forbidden, []);
  });
});

test('export audit cleanup refuses foreign documents navigation and indices then retries on proved absence', async t => {
  for (const mode of ['url', 'document', 'window', 'pending', 'last-proof-navigation', 'foreign-index']) await t.test(mode, async () => {
    const env = await exportCleanupFixture();
    if (mode === 'url') env.tabs.get(51).url = 'https://unrelated.invalid/';
    if (mode === 'document') env.contexts.get(51).documentId = 'foreign-doc';
    if (mode === 'window') env.tabs.get(51).windowId = 9;
    if (mode === 'pending') env.tabs.get(51).pendingUrl = 'https://unrelated.invalid/';
    if (mode === 'foreign-index') await env.sessionArea.set({ [env.indexKey]: 'audit-other' });
    if (mode === 'last-proof-navigation') {
      let reads = 0; const contexts = env.chromeApi.runtime.getContexts;
      env.chromeApi.runtime.getContexts = async filter => {
        const result = await contexts(filter);
        if (++reads === 2) env.tabs.get(51).pendingUrl = 'https://unrelated.invalid/';
        return result;
      };
    }
    assert.equal(await env.authority.clearAudit(env.auditId), false);
    assert.deepEqual(env.calls, []); assert.equal(env.tabs.has(51), true);
    env.tabs.delete(51); env.contexts.clear();
    if (mode === 'foreign-index') await env.sessionArea.set({ [env.indexKey]: env.auditId });
    assert.equal(await env.authority.clearAudit(env.auditId), true);
    assert.deepEqual(await env.sessionArea.get(null), {});
    assert.deepEqual(env.forbidden, []);
  });
});

test('export audit cleanup confirms writes removal and tab absence instead of trusting exceptions or no-ops', async t => {
  for (const mode of ['write-noop', 'write-throws', 'write-commit-throw', 'remove-noop', 'remove-commit-throw',
    'close-noop', 'close-throws', 'close-commit-throw', 'tab-read-error', 'query-error', 'context-error']) await t.test(mode, async () => {
    const env = await exportCleanupFixture('terminal');
    const set = env.sessionArea.set; const remove = env.sessionArea.remove;
    const getTab = env.chromeApi.tabs.get; const query = env.chromeApi.tabs.query;
    const close = env.chromeApi.tabs.remove; const contexts = env.chromeApi.runtime.getContexts;
    if (mode.startsWith('write-')) env.sessionArea.set = async rows => {
      if (mode === 'write-commit-throw') await set(rows);
      if (mode !== 'write-noop') throw new Error('PRIVATE_SET_ERROR');
    };
    if (mode.startsWith('remove-')) env.sessionArea.remove = async keys => {
      if (mode === 'remove-commit-throw') { await remove(keys); throw new Error('PRIVATE_REMOVE_ERROR'); }
    };
    if (mode.startsWith('close-')) env.chromeApi.tabs.remove = async tabId => {
      if (mode === 'close-commit-throw') await close(tabId);
      if (mode !== 'close-noop') throw new Error('PRIVATE_CLOSE_ERROR');
    };
    if (['tab-read-error', 'query-error'].includes(mode)) env.chromeApi.tabs.get = async () => { throw new Error('PRIVATE_TAB_ERROR'); };
    if (mode === 'query-error') env.chromeApi.tabs.query = async () => { throw new Error('PRIVATE_QUERY_ERROR'); };
    if (mode === 'context-error') env.chromeApi.runtime.getContexts = async () => { throw new Error('PRIVATE_CONTEXT_ERROR'); };
    const confirmed = mode.endsWith('commit-throw');
    assert.equal(await env.authority.clearAudit(env.auditId), confirmed);
    if (!confirmed) {
      assert.notEqual(await env.authority.getLaunch(env.auditId), null);
      env.sessionArea.set = set; env.sessionArea.remove = remove;
      env.chromeApi.tabs.get = getTab; env.chromeApi.tabs.query = query;
      env.chromeApi.tabs.remove = close; env.chromeApi.runtime.getContexts = contexts;
      assert.equal(await env.authority.clearAudit(env.auditId), true);
    }
    assert.deepEqual(await env.sessionArea.get(null), {});
    assert.deepEqual(env.forbidden, []);
  });
});

test('export audit cleanup rejects invalid or transplanted records and foreign replacements without effects', async t => {
  for (const mode of ['invalid-id', 'inventory-error', 'malformed-launch', 'transplant-launch', 'transplant-session', 'replacement']) await t.test(mode, async () => {
    const env = await exportCleanupFixture();
    if (mode === 'malformed-launch') await env.sessionArea.set({ [env.launchKey]: { auditId: env.auditId } });
    if (mode === 'transplant-launch') {
      await env.sessionArea.set({ 'audita:export-launch:v1:audit-other': await env.authority.getLaunch(env.auditId) });
      await env.sessionArea.remove([env.launchKey, env.sessionKey, env.indexKey]);
    }
    if (mode === 'transplant-session') await env.sessionArea.set({
      [`audita:export-session:v1:${'Z'.repeat(22)}`]: await env.authority.getSession(env.connection.sessionCapabilityId),
    });
    if (mode === 'inventory-error') env.sessionArea.get = async () => { throw new Error('PRIVATE_INVENTORY_ERROR'); };
    if (mode === 'replacement') {
      const contexts = env.chromeApi.runtime.getContexts;
      env.chromeApi.runtime.getContexts = async filter => {
        await env.sessionArea.set({ [env.indexKey]: 'audit-other' }); return contexts(filter);
      };
    }
    assert.equal(await env.authority.clearAudit(mode === 'invalid-id' ? ['audit-navigation'] : env.auditId), false);
    assert.deepEqual(env.calls, []); assert.equal(env.tabs.has(51), true);
    assert.deepEqual(env.forbidden, []);
  });
});

test('export audit cleanup is not undone by a delayed window inventory', async () => {
  const env = await exportCleanupFixture();
  const get = env.sessionArea.get;
  let entered; let release; let intercept = true;
  const captured = new Promise(resolve => { entered = resolve; });
  env.sessionArea.get = async keys => {
    const result = await get(keys);
    if (keys === null && intercept) {
      intercept = false;
      return new Promise(resolve => { release = () => resolve(result); entered(); });
    }
    return result;
  };
  const event = env.authority.handleWindowRemoved(7);
  await captured;
  try { assert.equal(await env.authority.clearAudit(env.auditId), true); }
  finally { release(); }
  await event;
  assert.deepEqual(await env.sessionArea.get(null), {});
  assert.deepEqual(env.calls, [['remove', 51]]);
  assert.deepEqual(env.forbidden, []);
});

test('export audit cleanup is not undone by an earlier source validation resolving false', async () => {
  const env = await exportCleanupFixture();
  let entered; let release;
  const captured = new Promise(resolve => { entered = resolve; });
  env.reportLaunch.validateConsumer = async () => {
    entered(); await new Promise(resolve => { release = resolve; }); return false;
  };
  const event = env.authority.handleTabUpdated(99, { status: 'loading' });
  await captured;
  try { assert.equal(await env.authority.clearAudit(env.auditId), true); }
  finally { release(); }
  await event;
  assert.deepEqual(await env.sessionArea.get(null), {});
  assert.deepEqual(env.calls, [['remove', 51]]);
  assert.deepEqual(env.forbidden, []);
});

test('export audit cleanup delayed old-tab event cannot revoke or close a replacement launch', async () => {
  const env = await exportCleanupFixture();
  const get = env.sessionArea.get;
  let entered; let release; let intercept = true;
  const captured = new Promise(resolve => { entered = resolve; });
  env.sessionArea.get = async keys => {
    const result = await get(keys);
    if (keys === env.indexKey && intercept) {
      intercept = false;
      return new Promise(resolve => { release = () => resolve(result); entered(); });
    }
    return result;
  };
  const event = env.authority.handleTabRemoved(51);
  await captured;
  try {
    assert.equal(await env.authority.clearAudit(env.auditId), true);
    const capability = Object.freeze({});
    env.auditStore.getAuditSnapshot = async () => ({ revision: 2, capability });
    env.auditStore.acquireExportLease = async (_auditId, received) => {
      assert.equal(received, capability); return { acquired: true, exportAttempt: 2, revision: 2 };
    };
    env.auditStore.setRetentionIntent = async () => {};
    env.reportLaunch.authorizeExport = async () => ({ ok: true, auditId: env.auditId, windowId: 7 });
    env.chromeApi.tabs.create = async options => ({ id: 52, windowId: options.windowId, url: 'about:blank' });
    env.chromeApi.tabs.update = async (tabId, options) => {
      const tab = { id: tabId, windowId: 7, url: options.url }; env.tabs.set(tabId, tab); return tab;
    };
    assert.equal((await env.authority.requestExport(env.request)).ok, true);
  } finally { release(); }
  await event;
  const launch = await env.authority.getLaunch(env.auditId);
  assert.equal(launch.state, 'awaiting-connection');
  assert.equal(launch.tabId, 52);
  assert.equal(env.tabs.has(52), true);
  assert.deepEqual(env.calls, [['remove', 51]]);
  assert.deepEqual(env.forbidden, []);
});

test('export audit cleanup is serialized across authorities sharing the same durable area', async () => {
  const env = await exportCleanupFixture();
  const second = createExportLaunchAuthority({ chromeApi: env.chromeApi, sessionArea: env.sessionArea,
    auditStore: env.auditStore, reportLaunch: env.reportLaunch, epochNow: () => 1000,
    modelNow: () => '2026-09-05T12:00:00.000Z', randomBytes: size => new Uint8Array(size).fill(9) });
  const set = env.sessionArea.set;
  let entered; let release; let intercept = true;
  const captured = new Promise(resolve => { entered = resolve; });
  env.sessionArea.set = async rows => {
    await set(rows);
    if (intercept) { intercept = false; entered(); await new Promise(resolve => { release = resolve; }); }
  };
  const first = env.authority.clearAudit(env.auditId);
  await captured;
  let secondDone = false;
  const later = second.clearAudit(env.auditId).then(result => { secondDone = true; return result; });
  await new Promise(resolve => setImmediate(resolve));
  const wasDoneEarly = secondDone;
  release();
  assert.deepEqual(await Promise.all([first, later]), [true, true]);
  assert.equal(wasDoneEarly, false);
  assert.deepEqual(env.calls, [['remove', 51]]);
  assert.deepEqual(await env.sessionArea.get(null), {});
  assert.deepEqual(env.forbidden, []);
});
