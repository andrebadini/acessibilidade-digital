import assert from 'node:assert/strict';
import test from 'node:test';

import { SAMPLE_AUDIT } from '../../fixtures/audits/sample-audit.js';
import { createSessionStore, initializeServiceWorker, isAuthorizedExtensionSender, isAuthorizedPanelSender, registerServiceWorker } from '../../src/background/service-worker.js';
import { commitReviewDecision } from '../../src/review/review-state.js';
import { AuditStorageUnavailableError, createInMemoryAuditStore } from '../../src/storage/audit-store.js';
import { runBatch } from '../../src/background/run-batch.js';
import { reportInput } from '../report/helpers.js';

const createChrome = () => {
  const action = {};
  const message = {};
  const connect = {};
  const installed = {};
  const context = {};
  const createdTabs = [];
  return {
    action: { onClicked: { addListener(listener) { action.listener = listener; } } },
    runtime: {
      id: 'test',
      getURL: (path) => `chrome-extension://test/${path}`,
      onMessage: { addListener(listener) { message.listener = listener; } },
      onConnect: { addListener(listener) { connect.listener = listener; } },
      onInstalled: { addListener(listener) { installed.listener = listener; } },
      sent: [],
      async sendMessage(value) { this.sent.push(value); },
    },
    contextMenus: {
      onClicked: { addListener(listener) { context.listener = listener; } },
      removeAll(callback) { callback?.(); },
      create(_item, callback) { callback?.(); },
    },
    tabs: {
      create: async (options) => { createdTabs.push(options); },
      async get() { throw new Error('No tab with id'); },
    },
    listeners: { action, message, connect, installed, context },
    createdTabs,
  };
};

test('registers no operational listener before trusted session access is fulfilled', async () => {
  let resolveAccess;
  const access = new Promise(resolve => { resolveAccess = resolve; });
  const listenerCounts = { message: 0, connect: 0, tabUpdated: 0, tabRemoved: 0, windowRemoved: 0, context: 0 };
  const listener = name => ({ addListener() { listenerCounts[name] += 1; } });
  const chromeApi = {
    storage: { session: { setAccessLevel(options) { assert.deepEqual(options, { accessLevel: 'TRUSTED_CONTEXTS' }); return access; } } },
    runtime: { onMessage: listener('message'), onConnect: listener('connect') },
    tabs: { onUpdated: listener('tabUpdated'), onRemoved: listener('tabRemoved') },
    windows: { onRemoved: listener('windowRemoved') },
    contextMenus: { onClicked: listener('context') },
  };
  const pending = initializeServiceWorker(chromeApi, {
    register(api) {
      api.runtime.onMessage.addListener(() => {});
      api.runtime.onConnect.addListener(() => {});
      api.tabs.onUpdated.addListener(() => {});
      api.tabs.onRemoved.addListener(() => {});
      api.windows.onRemoved.addListener(() => {});
      api.contextMenus.onClicked.addListener(() => {});
      return 'registered';
    },
  });
  await Promise.resolve();
  assert.deepEqual(listenerCounts, { message: 0, connect: 0, tabUpdated: 0, tabRemoved: 0, windowRemoved: 0, context: 0 });
  resolveAccess();
  assert.equal(await pending, 'registered');
  assert.deepEqual(listenerCounts, { message: 1, connect: 1, tabUpdated: 1, tabRemoved: 1, windowRemoved: 1, context: 1 });
});

test('fails closed with one fixed diagnostic when trusted session access is rejected', async () => {
  const diagnostics = [];
  let registrations = 0;
  const chromeApi = { storage: { session: { async setAccessLevel() { throw new Error('private native detail'); } } } };
  assert.equal(await initializeServiceWorker(chromeApi, {
    register() { registrations += 1; },
    diagnosticSink: { error(code) { diagnostics.push(code); } },
  }), null);
  assert.equal(registrations, 0);
  assert.deepEqual(diagnostics, ['SESSION_ACCESS_LEVEL_DENIED']);
});

test('does not misreport a post-gate registration exception as access denial', async () => {
  const diagnostics = [];
  const chromeApi = { storage: { session: { async setAccessLevel() {} } } };
  await assert.rejects(() => initializeServiceWorker(chromeApi, {
    register() { throw new Error('REGISTER_FAILED'); },
    diagnosticSink: { error(code) { diagnostics.push(code); } },
  }), /REGISTER_FAILED/u);
  assert.deepEqual(diagnostics, []);
});

async function waitUntil(predicate, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error('Condição de teste não foi atendida no prazo.');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function auditFixture(auditId, tag = 'fixture') {
  const model = structuredClone(SAMPLE_AUDIT);
  model.auditId = auditId;
  model.versions.extension = `test-${tag}`;
  return model;
}

function completeAuditFixture(auditId, tag = 'complete') {
  const model = auditFixture(auditId, tag);
  model.session.status = 'complete';
  model.session.partial = false;
  model.session.diagnostics = [];
  model.pages[0].status = 'complete';
  model.pages[0].diagnostics = [];
  model.limitations = model.limitations.filter(limitation => !limitation.includes('parcial'));
  return model;
}

function withAuditRevisions(store) {
  const models = new Map();
  const revisions = new Map();
  const capabilityRevisions = new WeakMap();
  const exportLeases = new Map();
  const commit = typeof store.commitAudit === 'function' ? store.commitAudit.bind(store) : null;
  const read = typeof store.getAudit === 'function' ? store.getAudit.bind(store) : null;
  const readLatest = typeof store.getLatest === 'function' ? store.getLatest.bind(store) : null;
  const writeLatest = typeof store.setLatest === 'function' ? store.setLatest.bind(store) : null;
  let latestState;
  const write = async (id, model, latest, snapshotCapability) => {
    const revision = revisions.get(id) ?? 0;
    const expectedRevision = snapshotCapability === undefined
      ? undefined
      : (typeof snapshotCapability === 'object' && snapshotCapability !== null
          ? capabilityRevisions.get(snapshotCapability)
          : undefined);
    if (snapshotCapability !== undefined && expectedRevision === undefined) {
      throw new TypeError('invalid snapshot capability');
    }
    if (expectedRevision !== undefined && revision !== expectedRevision) {
      throw Object.assign(new Error('revision conflict'), { code: 'AUDIT_REVISION_CONFLICT' });
    }
    const value = commit ? await commit(id, model, latest) : undefined;
    models.set(id, model);
    revisions.set(id, revision + 1);
    if (latest !== undefined) latestState = latest;
    return value ?? { revision: revision + 1 };
  };
  return {
    ...store,
    async getAuditSnapshot(id) {
      const model = models.has(id) ? models.get(id) : await read?.(id);
      const revision = revisions.get(id) ?? 0;
      if (model === undefined) return { model, revision, capability: null };
      const issuer = createInMemoryAuditStore();
      await issuer.setAudit(id, auditFixture(id));
      const issued = await issuer.getAuditSnapshot(id);
      capabilityRevisions.set(issued.capability, revision);
      return { model, revision, capability: issued.capability };
    },
    async getLatest() { return readLatest ? readLatest() : latestState; },
    async setLatest(value) {
      if (writeLatest) await writeLatest(value);
      latestState = value;
    },
    async markAuditInterrupted(id, value, options) {
      if (typeof store.markAuditInterrupted === 'function') {
        return store.markAuditInterrupted(id, value, options);
      }
      const [snapshot, latest] = await Promise.all([this.getAuditSnapshot(id), this.getLatest()]);
      if (latest?.auditId !== id) return { updated: false, reason: 'stale' };
      if (['complete', 'partial', 'failed', 'cancelled'].includes(snapshot?.model?.session?.status) ||
        ['complete', 'partial', 'failed', 'cancelled'].includes(latest.status)) {
        return { updated: false, reason: 'terminal' };
      }
      if (!['idle', 'validating', 'queued', 'running', 'cancelling'].includes(latest.status)) {
        return { updated: false, reason: 'stale' };
      }
      const lease = exportLeases.get(id);
      if (lease && new Date(lease.expiresAt).getTime() > new Date(options.now).getTime()) {
        return { updated: false, reason: 'delivery-active' };
      }
      await this.setLatest(value);
      return { updated: true, reason: 'interrupted' };
    },
    commitAudit(id, model, latest) { return write(id, model, latest); },
    commitAuditIfRevision(id, model, latest, snapshotCapability) {
      return write(id, model, latest, snapshotCapability);
    },
    async acquireExportLease(id, snapshotCapability, options) {
      const revision = revisions.get(id) ?? 0;
      if (capabilityRevisions.get(snapshotCapability) !== revision) {
        throw Object.assign(new Error('revision conflict'), { code: 'AUDIT_REVISION_CONFLICT' });
      }
      const now = new Date(options.now).getTime();
      const existing = exportLeases.get(id);
      if (existing && existing.revision === revision && new Date(existing.expiresAt).getTime() > now) {
        return {
          acquired: false, busy: true, retryAt: existing.expiresAt,
          revision, exportAttempt: existing.exportAttempt,
        };
      }
      const latest = await this.getLatest();
      const exportAttempt = latest?.auditId === id && Number.isSafeInteger(latest.exportAttempt)
        ? latest.exportAttempt + 1
        : 1;
      exportLeases.set(id, {
        ownerId: options.ownerId,
        revision,
        exportAttempt,
        phase: 'queued',
        expiresAt: new Date(now + (options.ttlMs ?? 120_000)).toISOString(),
      });
      await this.setLatest({ ...options.latestState, exportAttempt });
      return {
        acquired: true, busy: false, revision, exportAttempt,
        expiresAt: exportLeases.get(id).expiresAt,
      };
    },
    async claimExportLease(id, snapshotCapability, options) {
      const revision = revisions.get(id) ?? 0;
      const lease = exportLeases.get(id);
      if (capabilityRevisions.get(snapshotCapability) !== revision) {
        throw Object.assign(new Error('revision conflict'), { code: 'AUDIT_REVISION_CONFLICT' });
      }
      if (!lease || lease.ownerId !== options.ownerId || lease.phase !== 'queued' ||
        (options.exportAttempt !== undefined && lease.exportAttempt !== options.exportAttempt)) {
        throw Object.assign(new Error('lease conflict'), { code: 'AUDIT_EXPORT_LEASE_CONFLICT' });
      }
      lease.phase = 'running';
      lease.expiresAt = new Date(new Date(options.now).getTime() + (options.ttlMs ?? 120_000)).toISOString();
      await this.setLatest({ ...options.latestState, exportAttempt: lease.exportAttempt });
      return { claimed: true, revision, exportAttempt: lease.exportAttempt, expiresAt: lease.expiresAt };
    },
    async commitAuditIfRevisionWithExportLease(id, model, latest, snapshotCapability, options) {
      const revision = revisions.get(id) ?? 0;
      const lease = exportLeases.get(id);
      if (capabilityRevisions.get(snapshotCapability) !== revision) {
        throw Object.assign(new Error('revision conflict'), { code: 'AUDIT_REVISION_CONFLICT' });
      }
      if (!lease || lease.ownerId !== options.ownerId) {
        throw Object.assign(new Error('lease conflict'), { code: 'AUDIT_EXPORT_LEASE_CONFLICT' });
      }
      const result = await write(id, model, { ...latest, exportAttempt: lease.exportAttempt }, snapshotCapability);
      if (options.release) exportLeases.delete(id);
      else {
        lease.revision = result.revision;
        lease.phase = options.phase ?? 'delivering';
        lease.expiresAt = new Date(new Date(options.now).getTime() + (options.ttlMs ?? 120_000)).toISOString();
      }
      return result;
    },
    async releaseExportLease(id, options) {
      const lease = exportLeases.get(id);
      if (lease?.ownerId !== options.ownerId) return false;
      exportLeases.delete(id);
      return true;
    },
  };
}

test('opens the local panel through the centralized persona binding with the explicit source tab', async () => {
  const chromeApi = createChrome();
  const opens = [];
  const attached = [];
  const personaController = {
    async openPanel(value) { opens.push(value); return { id: 50 }; },
    attachPanelPort(port) { attached.push(port); return true; },
  };
  registerServiceWorker(chromeApi, { createId: () => 'audit-1', personaController });
  const sourceTab = { id: 7, url: 'https://alvo.test/pagina', title: 'não persistir' };
  chromeApi.listeners.action.listener(sourceTab);
  await waitUntil(() => opens.length === 1);
  assert.deepEqual(opens, [{ sourceTab }]);
  assert.deepEqual(chromeApi.createdTabs, []);
  const port = { name: 'audita-persona-v1' };
  chromeApi.listeners.connect.listener(port);
  assert.deepEqual(attached, [port]);
});

test('routes a context-menu audit through the shared single-audit boundary after a correlated panel ACK', async () => {
  const chromeApi = createChrome();
  const tabs = new Map([
    [7, { id: 7, url: 'https://origem.test/pagina', status: 'complete' }],
    [50, { id: 50, url: 'chrome-extension://test/src/panel/index.html', status: 'complete' }],
  ]);
  chromeApi.tabs.get = async tabId => structuredClone(tabs.get(tabId));
  const sent = [];
  chromeApi.runtime.sendMessage = (message, callback) => {
    sent.push(structuredClone(message));
    queueMicrotask(() => callback?.());
  };
  let runnerUrl;
  let runnerSignal;
  let finishContextRunner;
  const sessions = new Map();
  const bindingLease = Object.freeze(Object.create(null));
  let bindingLeaseLive = false;
  const personaController = {
    async openPanel({ sourceTab }) {
      assert.deepEqual(sourceTab, { id: 7, url: 'https://origem.test/pagina' });
      return { id: 50 };
    },
    async issueBindingLease(value) {
      assert.deepEqual(value, {
        panelTabId: 50, targetTabId: 7, sourceUrl: 'https://origem.test/pagina',
        panelDocumentId: 'panel-document-1',
      });
      bindingLeaseLive = true;
      return bindingLease;
    },
    consumeBindingLease(value) {
      if (value !== bindingLease || !bindingLeaseLive) return false;
      bindingLeaseLive = false;
      return true;
    },
    attachPanelPort() {},
  };
  registerServiceWorker(chromeApi, {
    createId: () => 'audit-context-1',
    createContextRequestId: () => 'context-request-1',
    sessions,
    personaController,
    auditStore: withAuditRevisions({ async setLatest() {}, async commitAudit() {} }),
    chromeAdapterFactory: () => ({}),
    runner: ({ url, signal }) => {
      runnerUrl = url;
      runnerSignal = signal;
      return new Promise(resolve => { finishContextRunner = resolve; });
    },
  });

  chromeApi.listeners.context.listener({
    menuItemId: 'audita.accessibility.audit-link', frameId: 0,
    pageUrl: 'https://origem.test/pagina',
    linkUrl: 'https://destino.test/alvo?token=TOPSECRET&view=public#auth=TOPSECRET',
  }, { id: 7, url: 'https://origem.test/pagina' });
  await waitUntil(() => sent.some(message => message.type === 'AUDIT_CONTEXT_PREFILL'));
  const prefill = sent.find(message => message.type === 'AUDIT_CONTEXT_PREFILL');
  assert.equal(prefill.prefill.url, 'https://destino.test/alvo?view=public');
  let startResponse;
  const panelSender = {
    id: 'test', frameId: 0, documentId: 'panel-document-1',
    url: 'chrome-extension://test/src/panel/index.html', tab: { id: 50 },
  };
  assert.equal(chromeApi.listeners.message.listener({
    type: 'CONTEXT_PREFILL_ACK', requestId: 'context-request-1', panelTabId: 50, accepted: true,
  }, panelSender, value => { startResponse = value; }), true);
  await waitUntil(() => sent.some(message => message.type === 'AUDIT_CONTEXT_PREFILL_COMMIT'));
  assert.equal(chromeApi.listeners.message.listener({
    type: 'CONTEXT_PREFILL_COMMIT_ACK', requestId: 'context-request-1', panelTabId: 50, accepted: true,
  }, panelSender, () => {}), true);
  await waitUntil(() => runnerUrl !== undefined);

  assert.equal(runnerUrl, 'https://destino.test/alvo?token=TOPSECRET&view=public#auth=TOPSECRET');
  assert.deepEqual(startResponse, { ok: true, auditId: 'audit-context-1', state: 'idle' });
  assert.doesNotMatch(JSON.stringify([...sessions.values(), ...sent]), /TOPSECRET|token=|auth=/iu);
  assert.equal(sent.some(message => message.type === 'START_AUDIT'), false,
    'autoStarted nunca reenvia START_AUDIT pelo painel');
  let cancelled;
  chromeApi.listeners.message.listener(
    { type: 'CANCEL_AUDIT', auditId: 'audit-context-1' },
    { ...panelSender, documentId: 'panel-document-after-reload' },
    value => { cancelled = value; },
  );
  assert.deepEqual(cancelled, { ok: true, auditId: 'audit-context-1', state: 'cancelling' });
  assert.equal(runnerSignal.aborted, true);
  finishContextRunner?.({ auditId: 'audit-context-1', session: { status: 'cancelled' }, report: {} });
});

test('validates START_AUDIT, stores an armed session, and keeps the response channel open', async () => {
  const chromeApi = createChrome();
  const sessions = new Map();
  let finishRunner;
  registerServiceWorker(chromeApi, {
    createId: () => 'audit-1', sessions,
    auditStore: withAuditRevisions({ async setLatest() {}, async commitAudit() {} }),
    chromeAdapterFactory: () => ({}),
    runner: () => new Promise(resolve => { finishRunner = resolve; }),
  });
  let response;
  const keepOpen = chromeApi.listeners.message.listener(
    { type: 'START_AUDIT', url: ' example.test/a ' },
    { id: 'test', url: 'chrome-extension://test/src/panel/index.html' },
    (value) => { response = value; },
  );
  assert.equal(keepOpen, true);
  assert.deepEqual(response, { ok: true, auditId: 'audit-1', state: 'idle' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(response, { ok: true, auditId: 'audit-1', state: 'idle' });
  assert.equal(sessions.get('audit-1').requestedUrl, 'https://example.test/a');
  finishRunner?.({ auditId: 'audit-1', session: { status: 'failed' }, report: {} });
});

test('default worker runner preserves the real execution contract through ownership registration', async () => {
  const chromeApi = createChrome();
  const values = {};
  const removed = [];
  let committed = null;
  chromeApi.storage = { session: {
    async get(key) { return Object.hasOwn(values, key) ? { [key]: structuredClone(values[key]) } : {}; },
    async set(entries) { Object.assign(values, structuredClone(entries)); },
    async remove(key) { delete values[key]; },
  } };
  chromeApi.tabs.create = async () => ({ id: 77, windowId: 5 });
  chromeApi.tabs.update = async () => { throw new Error('CONTROLLED_AFTER_OWNERSHIP'); };
  chromeApi.tabs.remove = async id => removed.push(id);
  chromeApi.tabs.onUpdated = { addListener() {}, removeListener() {} };
  chromeApi.tabs.onRemoved = { addListener() {}, removeListener() {} };
  chromeApi.scripting = { async executeScript() { return []; } };
  chromeApi.debugger = { async attach() {}, async sendCommand() { return {}; }, async detach() {} };
  registerServiceWorker(chromeApi, {
    createId: () => 'audit-real-worker', sessions: new Map(),
    auditStore: withAuditRevisions({
      async setLatest() {},
      async commitAudit(_auditId, model) { committed = model; },
    }),
    now: () => '2026-08-29T12:00:00.000Z',
  });
  chromeApi.listeners.message.listener(
    { type: 'START_AUDIT', url: 'https://example.test/' },
    { id: 'test', url: 'chrome-extension://test/src/panel/index.html' },
    () => {},
  );
  await waitUntil(() => removed.length === 1 && committed !== null, 2_000);
  assert.deepEqual(removed, [77]);
  assert.equal(committed.auditId, 'audit-real-worker');
  assert.doesNotMatch(JSON.stringify(committed), /AUDIT_EXECUTION_DENIED|CONTROLLED_AFTER_OWNERSHIP/u);
});

test('rejects unknown, hostile, and malformed worker messages safely', () => {
  const chromeApi = createChrome();
  registerServiceWorker(chromeApi, { createId: () => 'audit-1' });
  let response;
  assert.equal(chromeApi.listeners.message.listener({ type: 'OTHER' }, {}, (value) => { response = value; }), false);
  assert.equal(response, undefined);
  const keepOpen = chromeApi.listeners.message.listener({ type: 'START_AUDIT', url: 'https://example.test/' }, { id: 'hostile', url: 'chrome-extension://hostile/src/panel/index.html' }, (value) => { response = value; });
  assert.equal(keepOpen, true);
  assert.deepEqual(response, { ok: false, error: 'Origem da mensagem não autorizada.' });
});

test('authorizes only this extension panel origin and exact path', () => {
  assert.equal(isAuthorizedPanelSender({ id: 'test', url: 'chrome-extension://test/src/panel/index.html' }, 'test'), true);
  assert.equal(isAuthorizedPanelSender({ id: 'test', url: 'chrome-extension://test/src/other.html' }, 'test'), false);
  assert.equal(isAuthorizedPanelSender({ id: 'test', url: 'https://example.test/src/panel/index.html' }, 'test'), false);
  assert.equal(isAuthorizedPanelSender({ id: 'other', url: 'chrome-extension://test/src/panel/index.html' }, 'test'), false);
});

test('authorizes exact panel, review and correlated export pages but never audited web pages', () => {
  for (const path of ['/src/panel/index.html', '/src/review/index.html?auditId=audit-1', '/src/export/index.html?auditId=audit-1&leaseOwnerId=owner-1&exportAttempt=2']) {
    assert.equal(isAuthorizedExtensionSender({ id: 'test', url: `chrome-extension://test${path}` }, 'test'), true);
  }
  for (const url of [
    'https://example.test/src/review/index.html?auditId=audit-1',
    'chrome-extension://test/src/review/index.html?auditId=../escape',
    'chrome-extension://test/src/export/index.html?auditId=audit-1',
    'chrome-extension://test/src/export/index.html?auditId=audit-1&extra=x',
    'chrome-extension://test/src/export/index.html?auditId=audit-1&leaseOwnerId=owner-1&exportAttempt=0',
    'chrome-extension://other/src/export/index.html?auditId=audit-1&leaseOwnerId=owner-1&exportAttempt=2',
  ]) assert.equal(isAuthorizedExtensionSender({ id: 'test', url }, 'test'), false);
});

test('accepts export events only with the exact lease owner, attempt and revision from the sender URL', () => {
  const chromeApi = createChrome();
  registerServiceWorker(chromeApi, { auditStore: withAuditRevisions({}) });
  const sender = {
    id: 'test',
    url: 'chrome-extension://test/src/export/index.html?auditId=audit-1&leaseOwnerId=owner-1&exportAttempt=2',
  };
  for (const [message, ok] of [
    [{ type: 'EXPORT_PROGRESS', auditId: 'audit-1', leaseOwnerId: 'owner-1', exportAttempt: 2, exportRevision: 2 }, true],
    [{ type: 'EXPORT_INVALIDATED', auditId: 'audit-1', leaseOwnerId: 'owner-1', exportAttempt: 2, exportRevision: 3 }, true],
    [{ type: 'EXPORT_PROGRESS', auditId: 'audit-1', leaseOwnerId: 'owner-other', exportAttempt: 2, exportRevision: 2 }, false],
    [{ type: 'EXPORT_PROGRESS', auditId: 'audit-1', leaseOwnerId: 'owner-1', exportAttempt: 3, exportRevision: 2 }, false],
    [{ type: 'EXPORT_PROGRESS', auditId: 'audit-1', leaseOwnerId: 'owner-1', exportAttempt: 2 }, false],
  ]) {
    let response;
    chromeApi.listeners.message.listener(message, sender, value => { response = value; });
    assert.equal(response.ok, ok);
  }
});

test('validates a committed review against storage before broadcasting its exact new revision', async () => {
  const chromeApi = createChrome();
  const auditStore = createInMemoryAuditStore();
  const model = structuredClone(SAMPLE_AUDIT);
  const queue = model.manualReview[0];
  const auditId = model.auditId;
  await auditStore.setAudit(auditId, model);
  await auditStore.setLatest({
    auditId, exportStatus: 'complete', exportRevision: 1,
    exportAttempt: 1, leaseOwnerId: 'owner-old',
  });
  await commitReviewDecision(model, {
    auditId, itemId: queue.itemId, occurrenceId: queue.occurrenceId,
    answer: 'conforme', evaluator: 'Pessoa avaliadora',
    decidedAt: '2026-08-26T16:00:00.000Z', mode: queue.mode,
  }, auditStore);
  const committed = await auditStore.getAuditSnapshot(auditId);
  await auditStore.setLatest({
    auditId, exportStatus: 'queued', exportRevision: committed.revision,
    exportAttempt: 2, leaseOwnerId: 'owner-retry-after-review',
  });
  registerServiceWorker(chromeApi, { auditStore });
  let response;
  const keepOpen = chromeApi.listeners.message.listener({
    type: 'REVIEW_COMMITTED', auditId, exportRevision: committed.revision,
  }, {
    id: 'test', url: `chrome-extension://test/src/review/index.html?auditId=${auditId}`,
  }, value => { response = value; });
  assert.equal(keepOpen, true);
  await waitUntil(() => response !== undefined);
  assert.deepEqual(response, { ok: true });
  assert.deepEqual(chromeApi.runtime.sent.filter(message => message.type === 'AUDIT_REVIEW_UPDATED'), [{
    type: 'AUDIT_REVIEW_UPDATED', auditId, exportRevision: committed.revision,
  }]);

  response = undefined;
  chromeApi.listeners.message.listener({
    type: 'REVIEW_COMMITTED', auditId, exportRevision: committed.revision + 1,
  }, {
    id: 'test', url: 'chrome-extension://test/src/review/index.html?auditId=other-audit',
  }, value => { response = value; });
  assert.deepEqual(response, { ok: false, error: 'Revisão não correlacionada.' });
});

test('contains a failed review-update broadcast and always settles the response channel', async () => {
  const chromeApi = createChrome();
  chromeApi.runtime.sendMessage = async () => { throw new Error('broadcast failed'); };
  const auditStore = createInMemoryAuditStore();
  const model = structuredClone(SAMPLE_AUDIT);
  const queue = model.manualReview[0];
  const auditId = model.auditId;
  await auditStore.setAudit(auditId, model);
  await auditStore.setLatest({ auditId, exportStatus: 'complete', exportRevision: 1 });
  await commitReviewDecision(model, {
    auditId, itemId: queue.itemId, occurrenceId: queue.occurrenceId,
    answer: 'conforme', evaluator: 'Pessoa avaliadora',
    decidedAt: '2026-08-26T16:00:00.000Z', mode: queue.mode,
  }, auditStore);
  const committed = await auditStore.getAuditSnapshot(auditId);
  registerServiceWorker(chromeApi, { auditStore });
  let response;
  chromeApi.listeners.message.listener({
    type: 'REVIEW_COMMITTED', auditId, exportRevision: committed.revision,
  }, {
    id: 'test', url: `chrome-extension://test/src/review/index.html?auditId=${auditId}`,
  }, value => { response = value; });
  await waitUntil(() => response !== undefined);
  assert.deepEqual(response, { ok: false, error: 'Não foi possível notificar a revisão.' });
});

test('persists sessions with storage.session and falls back to an injected map', async () => {
  const writes = [];
  const sessionStore = createSessionStore({ storage: { session: { set: async (value) => writes.push(value) } } });
  await sessionStore.set('audit-1', { id: 'audit-1', requestedUrl: 'https://example.test/' });
  assert.deepEqual(writes, [{ 'audita-mt:session:audit-1': { id: 'audit-1', requestedUrl: 'https://example.test/' } }]);

  const fallback = new Map();
  const fallbackStore = createSessionStore({}, fallback);
  await fallbackStore.set('audit-2', { id: 'audit-2' });
  assert.deepEqual(await fallbackStore.get('audit-2'), { id: 'audit-2' });
});

test('session store removes only correlated audit checkpoints and can prune its own namespace', async () => {
  const sessionValues = {
    'persona-owned-elsewhere': { voice: 'pt-BR' },
  };
  let localCalls = 0;
  const chromeApi = {
    runtime: {},
    storage: {
      session: {
        async set(values) { Object.assign(sessionValues, structuredClone(values)); },
        async get(key) {
          if (key === null) return structuredClone(sessionValues);
          return Object.hasOwn(sessionValues, key) ? { [key]: structuredClone(sessionValues[key]) } : {};
        },
        async remove(keys) {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete sessionValues[key];
        },
      },
      local: {
        async get() { localCalls += 1; },
        async set() { localCalls += 1; },
        async remove() { localCalls += 1; },
      },
    },
  };
  const fallback = new Map();
  const store = createSessionStore(chromeApi, fallback);
  await store.set('audit-a', { id: 'audit-a', state: 'complete' });
  await store.set('audit-b', { id: 'audit-b', state: 'running' });
  await store.setActiveBatch({ id: 'audit-b', mode: 'batch', state: 'running' });

  await store.remove('audit-a');
  assert.equal(Object.hasOwn(sessionValues, 'audita-mt:session:audit-a'), false);
  assert.equal(fallback.has('audit-a'), false);

  await store.clearAuditSessions({ keepAuditIds: ['audit-b'] });
  assert.ok(sessionValues['audita-mt:session:audit-b']);
  assert.ok(sessionValues['audita-mt:session:active-batch']);
  await store.clearAuditSessions({ keepAuditIds: [] });
  assert.deepEqual(sessionValues, { 'persona-owned-elsewhere': { voice: 'pt-BR' } });
  assert.equal(localCalls, 0);
});

test('session remove clears only its correlated active marker and remains retryable after storage failure', async () => {
  const sessionValues = {};
  let failRemove = false;
  const chromeApi = {
    runtime: {},
    storage: { session: {
      async set(values) { Object.assign(sessionValues, structuredClone(values)); },
      async get(key) {
        return Object.hasOwn(sessionValues, key) ? { [key]: structuredClone(sessionValues[key]) } : {};
      },
      async remove(keys) {
        if (failRemove) throw new Error('session unavailable');
        for (const key of Array.isArray(keys) ? keys : [keys]) delete sessionValues[key];
      },
    } },
  };
  const store = createSessionStore(chromeApi);
  await store.set('audit-a', { id: 'audit-a', state: 'complete' });
  await store.setActiveBatch({ id: 'audit-a', mode: 'batch', state: 'complete' });
  await store.remove('audit-a');
  assert.equal(sessionValues['audita-mt:session:audit-a'], undefined);
  assert.equal(sessionValues['audita-mt:session:active-batch'], undefined);

  await store.set('audit-a', { id: 'audit-a', state: 'complete' });
  await store.setActiveBatch({ id: 'audit-b', mode: 'batch', state: 'running' });
  await store.remove('audit-a');
  assert.equal(sessionValues['audita-mt:session:active-batch'].id, 'audit-b');

  await store.set('audit-b', { id: 'audit-b', state: 'complete' });
  await store.setActiveBatch({ id: 'audit-b', mode: 'batch', state: 'complete' });
  failRemove = true;
  await store.remove('audit-b');
  assert.equal(sessionValues['audita-mt:session:active-batch'].id, 'audit-b');
  failRemove = false;
  const restarted = createSessionStore(chromeApi);
  await restarted.remove('audit-b');
  assert.equal(sessionValues['audita-mt:session:active-batch'], undefined);
});

test('session pruning removes malformed keys only from its own namespace', async () => {
  const sessionValues = {
    'audita-mt:session:': { id: '' },
    'audita-mt:session:bad/value': { id: 'bad/value' },
    'audita-mt:session:mismatch': { id: 'different' },
    'persona-owned-elsewhere': { voice: 'pt-BR' },
  };
  const chromeApi = { runtime: {}, storage: { session: {
    async get() { return structuredClone(sessionValues); },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete sessionValues[key];
    },
  } } };
  await createSessionStore(chromeApi).clearAuditSessions({ keepAuditIds: [] });
  assert.deepEqual(sessionValues, { 'persona-owned-elsewhere': { voice: 'pt-BR' } });
});

test('falls back to memory when storage.session rejects without touching storage.local', async () => {
  const chromeApi = createChrome();
  chromeApi.storage = {
    session: {
      set(_value, callback) {
        chromeApi.runtime.lastError = { message: 'storage denied' };
        callback();
        chromeApi.runtime.lastError = null;
      },
    },
  };
  const store = createSessionStore(chromeApi);
  await assert.doesNotReject(store.set('audit-1', { id: 'audit-1' }));
  assert.deepEqual(await store.get('audit-1'), { id: 'audit-1' });

  registerServiceWorker(chromeApi, { createId: () => 'audit-1' });
  let response;
  chromeApi.listeners.message.listener(
    { type: 'START_AUDIT', url: 'https://example.test/' },
    { id: 'test', url: 'chrome-extension://test/src/panel/index.html' },
    (value) => { response = value; },
  );
  assert.deepEqual(response, { ok: true, auditId: 'audit-1', state: 'idle' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(chromeApi.runtime.sent.some(message => message.type === 'AUDIT_FAILED' && message.auditId === 'audit-1'));
});

test('runs the audit in background, persists the model and sends correlated progress and completion', async () => {
  const chromeApi = createChrome();
  const writes = [];
  const auditStore = {
    async setLatest(value) { writes.push(['latest', value]); },
    async commitAudit(id, model, latest) { writes.push(['commit', id, model, latest]); },
  };
  const runner = async ({ chromeAdapter }) => {
    await chromeAdapter.emitProgress({ type: 'AUDIT_PROGRESS', auditId: 'audit-1', sessionId: 'audit-1', percent: 50, message: 'Verificando acessibilidade' });
    return { auditId: 'audit-1', session: { status: 'complete' }, report: { reviewUrl: 'chrome-extension://test/src/review/index.html?auditId=audit-1' } };
  };
  registerServiceWorker(chromeApi, {
    createId: () => 'audit-1', runner, auditStore: withAuditRevisions(auditStore),
    createExportOwnerId: () => 'owner-auto',
    chromeAdapterFactory: () => ({ async emitProgress() {} }),
  });
  let response;
  chromeApi.listeners.message.listener(
    { type: 'START_AUDIT', url: 'https://example.test/' },
    { id: 'test', url: 'chrome-extension://test/src/panel/index.html', documentId: 'panel-1' },
    value => { response = value; },
  );
  assert.deepEqual(response, { ok: true, auditId: 'audit-1', state: 'idle' });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(chromeApi.runtime.sent.some(message => message.type === 'AUDIT_PROGRESS' && message.auditId === 'audit-1'));
  assert.ok(chromeApi.runtime.sent.some(message => message.type === 'AUDIT_COMPLETE' && message.auditId === 'audit-1'));
  assert.ok(writes.some(([kind, id]) => kind === 'commit' && id === 'audit-1'));
  await waitUntil(() => chromeApi.createdTabs.some(tab => tab.url.includes('/src/export/')));
  assert.ok(chromeApi.createdTabs.some(tab => tab.active === false && tab.url === 'chrome-extension://test/src/export/index.html?auditId=audit-1&leaseOwnerId=owner-auto&exportAttempt=1'));
});

test('derives the current review capability at the worker boundary for single and batch', async t => {
  const runtimeId = 'abcdefghijklmnopabcdefghijklmnop';
  const hostileReviewUrl =
    'chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba/src/review/index.html?auditId=hostile';
  for (const mode of ['single', 'batch']) await t.test(mode, async () => {
    const auditId = mode === 'single' ? 'audit-worker-review' : 'batch-worker-review';
    const chromeApi = createChrome();
    const getUrlPaths = [];
    chromeApi.runtime.id = runtimeId;
    chromeApi.runtime.getURL = path => {
      getUrlPaths.push(path);
      return `chrome-extension://${runtimeId}/${path}`;
    };
    const commits = [];
    const auditStore = withAuditRevisions({
      async setLatest() {},
      async commitAudit(id, model, latestState) {
        commits.push(structuredClone({ id, model, latestState }));
      },
    });
    const productionModel = {
      auditId,
      session: { status: 'complete' },
      progress: [],
      report: { status: 'review-ready', reviewUrl: null },
      ...(mode === 'batch' ? { pages: [{ status: 'complete' }] } : {}),
    };
    const exerciseHandoff = async chromeAdapter => {
      const handoff = await chromeAdapter.handoffReport({ auditId });
      assert.equal(handoff.reviewUrl, hostileReviewUrl);
      return structuredClone(productionModel);
    };
    registerServiceWorker(chromeApi, {
      createId: () => auditId,
      auditStore,
      createExportOwnerId: () => `owner-${mode}`,
      chromeAdapterFactory: () => ({
        async emitProgress() {},
        async handoffReport() { return { reviewUrl: hostileReviewUrl }; },
      }),
      ...(mode === 'single'
        ? { runner: async ({ chromeAdapter }) => exerciseHandoff(chromeAdapter) }
        : {
            batchRunner: async ({ chromeAdapter }) => exerciseHandoff(chromeAdapter),
            reportOptions: {
              timezone: 'UTC', manifestVersion: '2.0.0',
              rulesVersion: '1.0.0', browserVersion: 'Chrome/152',
            },
          }),
    });
    const sender = {
      id: runtimeId,
      url: `chrome-extension://${runtimeId}/src/panel/index.html`,
      documentId: `panel-${mode}`,
      tab: { id: mode === 'single' ? 101 : 102 },
    };
    const message = mode === 'single'
      ? { type: 'START_AUDIT', url: 'https://single.example.test/' }
      : { type: 'START_BATCH', urls: 'https://batch.example.test/' };
    chromeApi.listeners.message.listener(message, sender, () => {});
    await waitUntil(() => commits.length === 1);

    const expectedReviewUrl =
      `chrome-extension://${runtimeId}/src/review/index.html?auditId=${auditId}`;
    assert.equal(commits[0].model.report.reviewUrl, null);
    assert.equal(commits[0].latestState.reviewUrl, expectedReviewUrl);
    const completion = chromeApi.runtime.sent.find(entry =>
      entry.type === 'AUDIT_COMPLETE' && entry.auditId === auditId);
    assert.equal(completion.reviewUrl, expectedReviewUrl);
    assert.deepEqual(
      getUrlPaths.filter(path => path.startsWith('src/review/')),
      [`src/review/index.html?auditId=${auditId}`],
    );
    assert.doesNotMatch(
      JSON.stringify([commits[0].model, commits[0].latestState, completion]),
      /ponmlkjihgfedcbaponmlkjihgfedcba|auditId=hostile/u,
    );
  });
});

test('regenerates only a known audit and reports an active persistent export as BUSY', async () => {
  const chromeApi = createChrome();
  let latest = { auditId: 'audit-1', status: 'partial', exportStatus: 'complete', exportAttempt: 4 };
  const auditStore = {
    async getAudit(id) { return id === 'audit-1' ? { auditId: id } : undefined; },
    async getLatest() { return latest; },
    async setLatest(value) { latest = value; },
  };
  registerServiceWorker(chromeApi, {
    auditStore: withAuditRevisions(auditStore), now: () => '2026-08-26T15:00:00.000Z',
    createExportOwnerId: () => 'owner-review',
  });
  const sender = { id: 'test', url: 'chrome-extension://test/src/review/index.html?auditId=audit-1' };
  let first;
  chromeApi.listeners.message.listener({ type: 'REQUEST_EXPORT', auditId: 'audit-1' }, sender, value => { first = value; });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(first, {
    ok: true, auditId: 'audit-1', state: 'queued', exportRevision: 0,
    exportAttempt: 5, leaseOwnerId: 'owner-review',
  });
  assert.equal(latest.exportStatus, 'queued');
  assert.equal(latest.exportQueuedAt, '2026-08-26T15:00:00.000Z');
  assert.equal(latest.exportAttempt, 5);
  assert.ok(chromeApi.createdTabs.some(tab => tab.url.endsWith('/src/export/index.html?auditId=audit-1&leaseOwnerId=owner-review&exportAttempt=5') && tab.active === false));
  let duplicate;
  chromeApi.listeners.message.listener({ type: 'REQUEST_EXPORT', auditId: 'audit-1' }, sender, value => { duplicate = value; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.code, 'EXPORT_BUSY');
  assert.equal(duplicate.retryable, true);
  assert.equal(typeof duplicate.retryAt, 'string');
});

test('serializes concurrent REQUEST_EXPORT so one wins and the retry receives BUSY', async () => {
  const chromeApi = createChrome();
  let latest = { auditId: 'audit-1', status: 'complete', exportStatus: 'complete' };
  let releaseRead;
  const readGate = new Promise(resolve => { releaseRead = resolve; });
  const auditStore = {
    async getAudit() { await readGate; return { auditId: 'audit-1' }; },
    async getLatest() { await readGate; return latest; },
    async setLatest(value) { latest = value; },
  };
  registerServiceWorker(chromeApi, { auditStore: withAuditRevisions(auditStore), now: () => '2026-08-26T15:00:00.000Z' });
  const sender = { id: 'test', url: 'chrome-extension://test/src/review/index.html?auditId=audit-1' };
  const responses = [];
  chromeApi.listeners.message.listener({ type: 'REQUEST_EXPORT', auditId: 'audit-1' }, sender, value => responses.push(value));
  chromeApi.listeners.message.listener({ type: 'REQUEST_EXPORT', auditId: 'audit-1' }, sender, value => responses.push(value));
  releaseRead();
  await waitUntil(() => responses.length === 2);
  assert.equal(chromeApi.createdTabs.filter(tab => tab.url.includes('/src/export/')).length, 1);
  assert.equal(responses.length, 2);
  assert.equal(responses.filter(response => response.ok && response.state === 'queued').length, 1);
  assert.equal(responses.filter(response => response.code === 'EXPORT_BUSY' && response.retryable).length, 1);
});

test('queues REQUEST_EXPORT behind startup while installing same-audit deduplication synchronously', async () => {
  const chromeApi = createChrome();
  const auditId = 'audit-export-startup-gate';
  const store = createInMemoryAuditStore();
  await store.commitAudit(auditId, auditFixture(auditId), {
    auditId, status: 'complete', exportStatus: 'complete',
  }, { now: '2026-08-28T09:00:00.000Z' });
  let releaseStartup;
  const startupGate = new Promise(resolve => { releaseStartup = resolve; });
  let snapshotReads = 0;
  const auditStore = {
    ...store,
    async getAuditSnapshot(id) {
      snapshotReads += 1;
      return store.getAuditSnapshot(id);
    },
  };
  registerServiceWorker(chromeApi, {
    auditStore,
    sessionStore: {
      async getActiveBatch() { await startupGate; return undefined; },
      async remove() {},
    },
    createExportOwnerId: () => 'owner-startup-gate',
    now: () => '2026-08-28T09:02:00.000Z',
  });
  const sender = {
    id: 'test', frameId: 0,
    url: `chrome-extension://test/src/review/index.html?auditId=${auditId}`,
  };
  let first;
  let duplicate;
  chromeApi.listeners.message.listener(
    { type: 'REQUEST_EXPORT', auditId }, sender, value => { first = value; },
  );
  chromeApi.listeners.message.listener(
    { type: 'REQUEST_EXPORT', auditId }, sender, value => { duplicate = value; },
  );
  await waitUntil(() => duplicate !== undefined);
  assert.equal(snapshotReads, 0, 'export storage reads must wait for startup');
  assert.equal(chromeApi.createdTabs.length, 0);
  assert.equal(duplicate.code, 'EXPORT_BUSY');

  releaseStartup();
  await waitUntil(() => first !== undefined);
  assert.equal(first.ok, true);
  assert.equal(first.state, 'queued');
  assert.equal(snapshotReads, 1);
  assert.equal(chromeApi.createdTabs.filter(tab => tab.url.includes('/src/export/')).length, 1);
});

test('never treats an uncorrelated queued marker as persistent exclusivity after restart', async () => {
  for (const queuedAt of [undefined, 'not-an-iso-date', '2026-08-26T14:59:30.000Z']) {
    const chromeApi = createChrome();
    let latest = { auditId: 'audit-1', status: 'complete', exportStatus: 'queued', exportRevision: 0, ...(queuedAt ? { exportQueuedAt: queuedAt } : {}) };
    const auditStore = {
      async getAudit() { return { auditId: 'audit-1' }; }, async getLatest() { return latest; },
      async setLatest(value) { latest = value; },
    };
    registerServiceWorker(chromeApi, { auditStore: withAuditRevisions(auditStore), now: () => '2026-08-26T15:00:00.000Z' });
    let response;
    chromeApi.listeners.message.listener(
      { type: 'REQUEST_EXPORT', auditId: 'audit-1' },
      { id: 'test', url: 'chrome-extension://test/src/review/index.html?auditId=audit-1' },
      value => { response = value; },
    );
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(chromeApi.createdTabs.some(tab => tab.url.includes('/src/export/')), true);
    assert.equal(response.ok, true);
    assert.equal(response.state, 'queued');
  }
});

test('never lets review audit A request export of audit B', () => {
  const chromeApi = createChrome();
  let reads = 0;
  registerServiceWorker(chromeApi, { auditStore: { async getAudit() { reads += 1; } } });
  let response;
  chromeApi.listeners.message.listener(
    { type: 'REQUEST_EXPORT', auditId: 'audit-B' },
    { id: 'test', url: 'chrome-extension://test/src/review/index.html?auditId=audit-A' },
    value => { response = value; },
  );
  assert.deepEqual(response, { ok: false, error: 'Pedido de exportação inválido.' });
  assert.equal(reads, 0);
});

test('never carries latest state from audit B into an export request for audit A', async () => {
  const chromeApi = createChrome();
  let written;
  const auditStore = {
    async getAudit() { return { auditId: 'audit-A' }; },
    async getLatest() { return { auditId: 'audit-B', reviewUrl: 'chrome-extension://test/private-B', secretMarker: 'audit-B-only' }; },
    async setLatest(value) { written = value; },
  };
  registerServiceWorker(chromeApi, { auditStore: withAuditRevisions(auditStore), now: () => '2026-08-26T15:00:00.000Z' });
  let response;
  chromeApi.listeners.message.listener(
    { type: 'REQUEST_EXPORT', auditId: 'audit-A' },
    { id: 'test', url: 'chrome-extension://test/src/review/index.html?auditId=audit-A' },
    value => { response = value; },
  );
  await waitUntil(() => response !== undefined);
  assert.equal(response.ok, true);
  assert.equal(written.auditId, 'audit-A');
  assert.equal(Object.hasOwn(written, 'reviewUrl'), false);
  assert.equal(Object.hasOwn(written, 'secretMarker'), false);
});

test('rejects a stored model whose correlated auditId is inherited', async () => {
  const chromeApi = createChrome();
  const inherited = Object.create({ auditId: 'audit-A' });
  const auditStore = {
    async getAuditSnapshot() {
      return { model: inherited, revision: 0, capability: Object.freeze(Object.create(null)) };
    },
    async getLatest() { return null; },
  };
  registerServiceWorker(chromeApi, { auditStore });
  let response;
  chromeApi.listeners.message.listener(
    { type: 'REQUEST_EXPORT', auditId: 'audit-A' },
    { id: 'test', url: 'chrome-extension://test/src/review/index.html?auditId=audit-A' },
    value => { response = value; },
  );
  await waitUntil(() => response !== undefined);
  assert.deepEqual(response, { ok: false, error: 'Auditoria não encontrada.' });
  assert.equal(chromeApi.createdTabs.some(tab => tab.url.includes('/src/export/')), false);
});

test('rejects export requests from an audited web page', () => {
  const chromeApi = createChrome();
  registerServiceWorker(chromeApi, { auditStore: {} });
  let response;
  const keepOpen = chromeApi.listeners.message.listener(
    { type: 'REQUEST_EXPORT', auditId: 'audit-1' },
    { id: 'test', url: 'https://example.test/' },
    value => { response = value; },
  );
  assert.equal(keepOpen, true);
  assert.deepEqual(response, { ok: false, error: 'Origem da mensagem não autorizada.' });
});

test('deduplicates concurrent START_AUDIT messages from the same panel sender', () => {
  const chromeApi = createChrome();
  let finish;
  const runner = () => new Promise(resolve => { finish = resolve; });
  registerServiceWorker(chromeApi, { createId: () => 'audit-1', runner, auditStore: withAuditRevisions({ async setLatest() {}, async commitAudit() {} }), chromeAdapterFactory: () => ({}) });
  const sender = { id: 'test', url: 'chrome-extension://test/src/panel/index.html', documentId: 'panel-1' };
  let first;
  let second;
  chromeApi.listeners.message.listener({ type: 'START_AUDIT', url: 'https://example.test/' }, sender, value => { first = value; });
  chromeApi.listeners.message.listener({ type: 'START_AUDIT', url: 'https://example.test/' }, sender, value => { second = value; });
  assert.equal(first.auditId, 'audit-1');
  assert.deepEqual(second, { ok: true, auditId: 'audit-1', state: 'running', duplicate: true });
  finish?.({ auditId: 'audit-1', session: { status: 'complete' }, report: {} });
});

test('never falls back to storage.local for ephemeral batch checkpoints', async () => {
  let localCalls = 0;
  const fallback = new Map();
  const store = createSessionStore({ storage: { local: {
    async set() { localCalls += 1; }, async get() { localCalls += 1; },
  } } }, fallback);
  await store.set('batch-ephemeral', { id: 'batch-ephemeral', mode: 'batch' });
  assert.deepEqual(await store.get('batch-ephemeral'), { id: 'batch-ephemeral', mode: 'batch' });
  assert.equal(localCalls, 0);
});

test('starts one normalized batch globally and only lets its owning panel cancel it', async () => {
  const chromeApi = createChrome();
  const checkpoints = [];
  let batchInput;
  let release;
  const batchRunner = ({ entries, batchAuditId, signal, onCheckpoint }) => {
    batchInput = { entries, batchAuditId, signal };
    void onCheckpoint({ id: batchAuditId, mode: 'batch', state: 'running', total: entries.length });
    return new Promise(resolve => { release = resolve; });
  };
  registerServiceWorker(chromeApi, {
    createId: () => 'batch-global', batchRunner,
    sessionStore: { async set(id, value) { checkpoints.push([id, value]); }, async get() {} },
    auditStore: withAuditRevisions({ async setLatest() {}, async commitAudit() {} }),
    chromeAdapterFactory: () => ({}),
    reportOptions: { timezone: 'UTC', manifestVersion: '2.0.0', rulesVersion: '1.0.0', browserVersion: '152.0.0.0' },
  });
  const owner = { id: 'test', url: 'chrome-extension://test/src/panel/index.html', documentId: 'panel-owner' };
  const other = { id: 'test', url: 'chrome-extension://test/src/panel/index.html', documentId: 'panel-other' };
  let started;
  chromeApi.listeners.message.listener({ type: 'START_BATCH', urls: 'https://example.test/a?token=SECRET\nhttps://example.org/b' }, owner, value => { started = value; });
  assert.deepEqual(started, { ok: true, auditId: 'batch-global', state: 'idle', total: 2, warnings: [] });
  await waitUntil(() => batchInput !== undefined);
  assert.equal(batchInput.entries[0].navigationUrl.includes('SECRET'), true);
  assert.equal(JSON.stringify(checkpoints).includes('SECRET'), false);

  let busy;
  chromeApi.listeners.message.listener({ type: 'START_AUDIT', url: 'https://third.test/' }, other, value => { busy = value; });
  assert.deepEqual(busy, { ok: false, code: 'AUDIT_BUSY', error: 'Já existe uma auditoria em andamento.' });

  let denied;
  chromeApi.listeners.message.listener({ type: 'CANCEL_AUDIT', auditId: 'batch-global' }, other, value => { denied = value; });
  assert.deepEqual(denied, { ok: false, error: 'Cancelamento não autorizado.' });
  let cancelled;
  chromeApi.listeners.message.listener({ type: 'CANCEL_AUDIT', auditId: 'batch-global' }, owner, value => { cancelled = value; });
  assert.deepEqual(cancelled, { ok: true, auditId: 'batch-global', state: 'cancelling' });
  assert.equal(batchInput.signal.aborted, true);
  release?.({ auditId: 'batch-global', session: { status: 'cancelled' }, report: {} });
});

test('rejects cancellation with a fixed too-late result once single or batch enters final handoff', async () => {
  for (const mode of ['single', 'batch']) {
    const chromeApi = createChrome();
    let enteredHandoff;
    const handoffEntered = new Promise(resolve => { enteredHandoff = resolve; });
    let releaseHandoff;
    const handoffGate = new Promise(resolve => { releaseHandoff = resolve; });
    const runner = async ({ chromeAdapter }) => {
      if (mode === 'batch') {
        await chromeAdapter.enterFinalization();
        enteredHandoff();
        await handoffGate;
      } else {
        await chromeAdapter.handoffReport({});
      }
      return { auditId: `audit-${mode}`, pages: [], session: { status: mode === 'batch' ? 'failed' : 'complete' }, report: {} };
    };
    registerServiceWorker(chromeApi, {
      createId: () => `audit-${mode}`,
      runner: mode === 'single' ? runner : undefined,
      batchRunner: mode === 'batch' ? runner : undefined,
      reportOptions: { timezone: 'UTC', manifestVersion: '2.0.0', rulesVersion: '1.0.0', browserVersion: '152' },
      chromeAdapterFactory: () => ({ async handoffReport() { enteredHandoff(); await handoffGate; return {}; } }),
      auditStore: withAuditRevisions({ async setLatest() {}, async commitAudit() {} }),
    });
    const sender = { id: 'test', url: 'chrome-extension://test/src/panel/index.html', tab: { id: mode === 'single' ? 80 : 81 } };
    let started;
    chromeApi.listeners.message.listener(mode === 'single'
      ? { type: 'START_AUDIT', url: 'https://late.example.test/' }
      : { type: 'START_BATCH', urls: 'https://late.example.test/' }, sender, value => { started = value; });
    await handoffEntered;
    let cancelled;
    chromeApi.listeners.message.listener({ type: 'CANCEL_AUDIT', auditId: started.auditId }, sender, value => { cancelled = value; });
    assert.deepEqual(cancelled, {
      ok: false, code: 'AUDIT_CANCEL_TOO_LATE',
      error: 'A auditoria já está na etapa final e não pode mais ser cancelada.',
    });
    releaseHandoff();
  }
});

test('closes cancellation atomically before persisting every terminal batch path', async t => {
  const pageResultAtRunnerClock = (options, sessionFactory) => {
    const timestamps = {
      startedAt: options.now(),
      endedAt: options.now(),
      generatedAt: options.now(),
    };
    return reportInput({
      auditId: options.idFactory(), requestedUrl: options.url, finalUrl: options.url,
      timestamps,
      session: sessionFactory(timestamps),
    });
  };
  const cases = [
    {
      name: 'last PAGE_FINISHED', urls: 'https://last.example.test/',
      gate: value => value.state === 'running' && value.completedCount === 1,
      runner: async options => pageResultAtRunnerClock(options,
        () => ({ status: 'complete', diagnostics: [], partial: false })),
      expectedStatus: 'complete',
    },
    {
      name: 'FINISH', urls: 'https://finish.example.test/', gate: value => value.state === 'complete',
      runner: async options => pageResultAtRunnerClock(options,
        () => ({ status: 'complete', diagnostics: [], partial: false })),
      expectedStatus: 'complete',
    },
    {
      name: 'cleanup-unconfirmed early terminal',
      urls: 'https://stuck.example.test/\nhttps://never.example.test/',
      gate: value => value.state === 'running' && value.completedCount === 1,
      runner: () => new Promise(() => {}), expectedStatus: 'failed',
    },
    {
      name: 'cleanup diagnostic early terminal',
      urls: 'https://cleanup.example.test/\nhttps://never.example.test/',
      gate: value => value.state === 'running' && value.completedCount === 1,
      runner: async options => pageResultAtRunnerClock(options, timestamps => ({
          status: 'partial', partial: true,
          diagnostics: [{
            code: 'TAB_CLOSE_FAILED', message: 'A aba descartável não pôde ser fechada automaticamente.',
            at: timestamps.endedAt, recoverable: true,
          }],
        })),
      expectedStatus: 'partial',
    },
  ];
  for (const scenario of cases) await t.test(scenario.name, { timeout: 5_000 }, async () => {
    const chromeApi = createChrome();
    let releasePersistence;
    const persistenceGate = new Promise(resolve => { releasePersistence = resolve; });
    let enteredPersistence;
    const persistenceEntered = new Promise(resolve => { enteredPersistence = resolve; });
    let gated = false;
    let committed;
    let resolveCommitted;
    const committedReached = new Promise(resolve => { resolveCommitted = resolve; });
    registerServiceWorker(chromeApi, {
      createId: () => `batch-boundary-${scenario.name.replaceAll(/[^a-z]+/giu, '-').toLowerCase()}`,
      sessionStore: {
        async getActiveBatch() {}, async get() {},
        async set(_id, value) {
          if (!gated && value?.mode === 'batch' && scenario.gate(value)) {
            gated = true; enteredPersistence(); await persistenceGate;
          }
        },
        async setActiveBatch() {}, async clearActiveBatch() {},
      },
      batchRunner: options => runBatch({
        ...options, runner: scenario.runner, pageTimeoutMs: 5, cleanupTimeoutMs: 5,
      }),
      auditStore: withAuditRevisions({
        async setLatest() {},
        async commitAudit(_id, model) { committed = model; resolveCommitted(); },
      }),
      chromeAdapterFactory: () => ({ async emitProgress() {}, async handoffReport() { return { reviewUrl: null }; } }),
      reportOptions: { timezone: 'UTC', manifestVersion: '2.0.0', rulesVersion: '1.0.0', browserVersion: 'Chrome/152' },
    });
    const sender = { id: 'test', url: 'chrome-extension://test/src/panel/index.html', tab: { id: 90 } };
    let started;
    chromeApi.listeners.message.listener({ type: 'START_BATCH', urls: scenario.urls }, sender, value => { started = value; });
    await persistenceEntered;
    let cancellation;
    chromeApi.listeners.message.listener({ type: 'CANCEL_AUDIT', auditId: started.auditId }, sender, value => { cancellation = value; });
    assert.deepEqual(cancellation, {
      ok: false, code: 'AUDIT_CANCEL_TOO_LATE',
      error: 'A auditoria já está na etapa final e não pode mais ser cancelada.',
    });
    releasePersistence();
    await committedReached;
    assert.equal(committed.session.status, scenario.expectedStatus);
  });
});

test('persists copied batch statusCounts so GET_LAST restores failures after panel reload', async () => {
  const chromeApi = createChrome();
  const writes = [];
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  registerServiceWorker(chromeApi, {
    createId: () => 'batch-reload-counts',
    batchRunner: async ({ chromeAdapter }) => {
      const statusCounts = { complete: 0, partial: 0, failed: 1, cancelled: 0 };
      await chromeAdapter.emitProgress({
        type: 'AUDIT_PROGRESS', auditId: 'batch-reload-counts', sessionId: 'batch-reload-counts',
        percent: 50, message: 'Página 1 encerrada.', pageNumber: 1, total: 2, statusCounts,
      });
      statusCounts.failed = 9;
      await hold;
    },
    auditStore: withAuditRevisions({ async setLatest(value) { writes.push(structuredClone(value)); } }),
    chromeAdapterFactory: () => ({}),
    reportOptions: { timezone: 'UTC', manifestVersion: '2.0.0', rulesVersion: '1.0.0', browserVersion: 'Chrome/152' },
  });
  const sender = { id: 'test', url: 'chrome-extension://test/src/panel/index.html', tab: { id: 91 } };
  chromeApi.listeners.message.listener({ type: 'START_BATCH', urls: 'https://one.example.test/\nhttps://two.example.test/' }, sender, () => {});
  await waitUntil(() => writes.length >= 2);
  assert.deepEqual(writes[0].statusCounts, { complete: 0, partial: 0, failed: 0, cancelled: 0 });
  let restored;
  chromeApi.listeners.message.listener({ type: 'GET_LAST_AUDIT' }, sender, value => { restored = value; });
  await waitUntil(() => restored !== undefined);
  assert.deepEqual(restored.state.statusCounts, { complete: 0, partial: 0, failed: 1, cancelled: 0 });
  release();
});

test('blocks a batch with line errors before allocating an audit id', () => {
  const chromeApi = createChrome();
  let allocated = 0;
  registerServiceWorker(chromeApi, { createId() { allocated += 1; return 'must-not-run'; } });
  let response;
  chromeApi.listeners.message.listener(
    { type: 'START_BATCH', urls: 'https://ok.test\nftp://invalid.test' },
    { id: 'test', url: 'chrome-extension://test/src/panel/index.html', documentId: 'panel-1' },
    value => { response = value; },
  );
  assert.equal(response.ok, false);
  assert.equal(response.code, 'BATCH_INVALID');
  assert.equal(response.errors[0].line, 2);
  assert.equal(JSON.stringify(response).includes('ftp://'), false);
  assert.equal(allocated, 0);
});

test('turns a running batch checkpoint into an explanatory non-resumable interruption after restart', async () => {
  const chromeApi = createChrome();
  const checkpoint = {
    id: 'batch-restart', mode: 'batch', state: 'running', total: 3, currentIndex: 1,
    completedCount: 1, statusCounts: { complete: 1, partial: 0, failed: 0, cancelled: 0 },
    cancelRequested: false, startedAt: '2026-08-28T10:00:00.000Z',
    updatedAt: '2026-08-28T10:01:00.000Z', resumable: false,
  };
  let savedCheckpoint;
  let cleared = false;
  let latest = { auditId: checkpoint.id, mode: 'batch', status: 'running', percent: 50 };
  registerServiceWorker(chromeApi, {
    now: () => '2026-08-28T10:02:00.000Z',
    sessionStore: {
      async getActiveBatch() { return checkpoint; },
      async set(_id, value) { savedCheckpoint = value; }, async get() {},
      async clearActiveBatch() { cleared = true; },
    },
    auditStore: withAuditRevisions({
      async getLatest() { return latest; },
      async setLatest(value) { latest = value; },
    }),
  });
  await waitUntil(() => latest?.status === 'failed' && savedCheckpoint !== undefined);
  assert.equal(savedCheckpoint.state, 'failed');
  assert.equal(savedCheckpoint.resumable, false);
  assert.equal(latest.auditId, 'batch-restart');
  assert.equal(latest.mode, 'batch');
  assert.equal(latest.status, 'failed');
  assert.equal(cleared, true);
  assert.match(latest.message, /interrompid[oa]|reinício/iu);
  assert.doesNotMatch(JSON.stringify([savedCheckpoint, latest]), /https?:|token=|session=/iu);
});

test('restart leaves a terminal audit and its queued export lease intact behind a stale running checkpoint', async () => {
  const chromeApi = createChrome();
  const auditId = 'batch-terminal-lease-restart';
  const checkpoint = {
    id: auditId, mode: 'batch', state: 'running', total: 2, currentIndex: 2,
    completedCount: 2, statusCounts: { complete: 2, partial: 0, failed: 0, cancelled: 0 },
    cancelRequested: false, startedAt: '2026-08-28T09:00:00.000Z',
    updatedAt: '2026-08-28T09:01:00.000Z', resumable: false,
  };
  const store = createInMemoryAuditStore();
  await store.commitAudit(auditId, completeAuditFixture(auditId), {
    auditId, mode: 'batch', status: 'complete', exportStatus: 'preparing',
  }, { now: '2026-08-28T09:01:00.000Z' });
  const before = await store.getAuditSnapshot(auditId);
  const lease = await store.acquireExportLease(auditId, before.capability, {
    ownerId: 'owner-terminal-restart', now: '2026-08-28T09:01:30.000Z',
    latestState: {
      auditId, mode: 'batch', status: 'complete', exportStatus: 'queued',
      exportRevision: before.revision, leaseOwnerId: 'owner-terminal-restart',
    },
  });
  let activeCheckpoint = checkpoint;
  registerServiceWorker(chromeApi, {
    auditStore: store,
    sessionStore: {
      async getActiveBatch() { return activeCheckpoint; },
      async set() {}, async get() {}, async remove() { activeCheckpoint = undefined; },
      async clearActiveBatch() { activeCheckpoint = undefined; },
    },
    now: () => '2026-08-28T09:01:31.000Z',
  });
  await waitUntil(() => activeCheckpoint === undefined);

  const after = await store.getAuditSnapshot(auditId);
  assert.equal(after.revision, before.revision);
  assert.equal(after.model.session.status, 'complete');
  assert.equal((await store.getLatest()).exportStatus, 'queued');
  assert.deepEqual(await store.getExportLeaseState(auditId, {
    now: '2026-08-28T09:01:31.000Z',
  }), {
    active: true, phase: 'queued', retryAt: lease.expiresAt,
    revision: before.revision, exportAttempt: lease.exportAttempt,
    ownerId: 'owner-terminal-restart',
  });
});

test('a delayed restart restoration can never overwrite a newly accepted audit', async () => {
  const chromeApi = createChrome();
  let releaseRestore;
  const restoreGate = new Promise(resolve => { releaseRestore = resolve; });
  const latestWrites = [];
  let latest;
  let finishRunner;
  registerServiceWorker(chromeApi, {
    createId: () => 'audit-new',
    sessionStore: {
      async getActiveBatch() { await restoreGate; return {
        id: 'batch-old', mode: 'batch', state: 'running', total: 2, currentIndex: 1, completedCount: 1,
        statusCounts: { complete: 1, partial: 0, failed: 0, cancelled: 0 }, cancelRequested: false,
        startedAt: '2026-08-28T09:00:00.000Z', updatedAt: '2026-08-28T09:01:00.000Z', resumable: false,
      }; },
      async set() {}, async get() {}, async clearActiveBatch() {},
    },
    auditStore: withAuditRevisions({
      async getLatest() { return latest; },
      async setLatest(value) { latest = value; latestWrites.push(value); }, async commitAudit(_id, _model, value) { latest = value; },
    }),
    chromeAdapterFactory: () => ({}),
    runner: () => new Promise(resolve => { finishRunner = resolve; }),
  });
  let response;
  chromeApi.listeners.message.listener(
    { type: 'START_AUDIT', url: 'https://new.example.test/' },
    { id: 'test', url: 'chrome-extension://test/src/panel/index.html', documentId: 'panel-new' },
    value => { response = value; },
  );
  assert.equal(response.auditId, 'audit-new');
  releaseRestore();
  await waitUntil(() => latest?.auditId === 'audit-new');
  assert.equal(latest.auditId, 'audit-new');
  finishRunner?.({ auditId: 'audit-new', session: { status: 'complete' }, report: {} });
});

test('serializes delete-one after startup restoration and never resurrects a stale same-audit latest record', async () => {
  const chromeApi = createChrome();
  const auditId = 'batch-delete-startup-race';
  const checkpoint = {
    id: auditId, mode: 'batch', state: 'running', total: 2, currentIndex: 1,
    completedCount: 1, statusCounts: { complete: 1, partial: 0, failed: 0, cancelled: 0 },
    cancelRequested: false, startedAt: '2026-08-28T09:00:00.000Z',
    updatedAt: '2026-08-28T09:01:00.000Z', resumable: false,
  };
  const store = createInMemoryAuditStore();
  await store.commitAudit(auditId, auditFixture(auditId), {
    auditId, mode: 'batch', status: 'running', percent: 50,
  }, { now: '2026-08-28T09:01:00.000Z' });
  let releaseInterruptionDecision;
  const interruptionGate = new Promise(resolve => { releaseInterruptionDecision = resolve; });
  let interruptionDecisionEntered = false;
  let deleteEntered = false;
  const auditStore = {
    ...store,
    async markAuditInterrupted(...args) {
      interruptionDecisionEntered = true;
      await interruptionGate;
      return store.markAuditInterrupted(...args);
    },
    async deleteAudit(...args) {
      deleteEntered = true;
      return store.deleteAudit(...args);
    },
  };
  const sessionValues = new Map([[auditId, checkpoint]]);
  let activeCheckpoint = checkpoint;
  registerServiceWorker(chromeApi, {
    auditStore,
    sessionStore: {
      async getActiveBatch() { return activeCheckpoint; },
      async set(id, value) { sessionValues.set(id, value); },
      async get(id) { return sessionValues.get(id); },
      async remove(id) {
        sessionValues.delete(id);
        if (activeCheckpoint?.id === id) activeCheckpoint = undefined;
      },
      async clearActiveBatch() { activeCheckpoint = undefined; },
    },
    now: () => '2026-08-28T09:02:00.000Z',
  });
  await waitUntil(() => interruptionDecisionEntered);

  let response;
  chromeApi.listeners.message.listener(
    { type: 'REQUEST_DELETE_AUDIT', auditId },
    { id: 'test', frameId: 0, url: `chrome-extension://test/src/review/index.html?auditId=${auditId}` },
    value => { response = value; },
  );
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(deleteEntered, false, 'delete-one must wait for startup restoration');

  releaseInterruptionDecision();
  await waitUntil(() => response !== undefined);
  assert.deepEqual(response, { ok: true, auditId, deleted: true });
  assert.equal(await store.getAudit(auditId), undefined);
  assert.equal(await store.getLatest(), undefined);
  assert.equal(sessionValues.has(auditId), false);
  assert.equal(activeCheckpoint, undefined);
});

test('serializes delete-all after startup restoration and leaves no stale durable or session state', async () => {
  const chromeApi = createChrome();
  const auditId = 'batch-delete-all-startup-race';
  const checkpoint = {
    id: auditId, mode: 'batch', state: 'running', total: 2, currentIndex: 1,
    completedCount: 1, statusCounts: { complete: 1, partial: 0, failed: 0, cancelled: 0 },
    cancelRequested: false, startedAt: '2026-08-28T09:00:00.000Z',
    updatedAt: '2026-08-28T09:01:00.000Z', resumable: false,
  };
  const store = createInMemoryAuditStore();
  await store.commitAudit(auditId, auditFixture(auditId), {
    auditId, mode: 'batch', status: 'running', percent: 50,
  }, { now: '2026-08-28T09:01:00.000Z' });
  let releaseInterruptionDecision;
  const interruptionGate = new Promise(resolve => { releaseInterruptionDecision = resolve; });
  let interruptionDecisionEntered = false;
  let deleteAllEntered = false;
  const auditStore = {
    ...store,
    async markAuditInterrupted(...args) {
      interruptionDecisionEntered = true;
      await interruptionGate;
      return store.markAuditInterrupted(...args);
    },
    async deleteAllAudits(...args) {
      deleteAllEntered = true;
      return store.deleteAllAudits(...args);
    },
  };
  const sessionValues = new Map([[auditId, checkpoint]]);
  let activeCheckpoint = checkpoint;
  registerServiceWorker(chromeApi, {
    auditStore,
    sessionStore: {
      async getActiveBatch() { return activeCheckpoint; },
      async set(id, value) { sessionValues.set(id, value); },
      async get(id) { return sessionValues.get(id); },
      async remove(id) {
        sessionValues.delete(id);
        if (activeCheckpoint?.id === id) activeCheckpoint = undefined;
      },
      async clearActiveBatch() { activeCheckpoint = undefined; },
      async clearAuditSessions() {
        sessionValues.clear();
        activeCheckpoint = undefined;
      },
    },
    now: () => '2026-08-28T09:02:00.000Z',
  });
  await waitUntil(() => interruptionDecisionEntered);

  let response;
  chromeApi.listeners.message.listener(
    { type: 'REQUEST_DELETE_ALL_AUDITS' },
    { id: 'test', frameId: 0, url: 'chrome-extension://test/src/panel/index.html' },
    value => { response = value; },
  );
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(deleteAllEntered, false, 'delete-all must wait for startup restoration');

  releaseInterruptionDecision();
  await waitUntil(() => response !== undefined);
  assert.deepEqual(response, { ok: true, deleted: 1 });
  assert.equal(await store.getAudit(auditId), undefined);
  assert.equal(await store.getLatest(), undefined);
  assert.equal(sessionValues.size, 0);
  assert.equal(activeCheckpoint, undefined);
});

test('clears a terminal active marker when its commit is proved or its durable audit is absent', async () => {
  for (const proved of [false, true]) {
    const chromeApi = createChrome();
    const checkpoint = {
      id: `batch-terminal-${proved}`, mode: 'batch', state: 'complete', total: 1, currentIndex: 1,
      completedCount: 1, statusCounts: { complete: 1, partial: 0, failed: 0, cancelled: 0 },
      cancelRequested: false, startedAt: '2026-08-28T10:00:00.000Z', updatedAt: '2026-08-28T10:01:00.000Z', resumable: false,
    };
    let latest = proved ? { auditId: checkpoint.id, status: 'complete' } : undefined;
    let saved;
    let cleared = false;
    const removed = [];
    registerServiceWorker(chromeApi, {
      sessionStore: {
        async getActiveBatch() { return checkpoint; }, async set(_id, value) { saved = value; },
        async clearActiveBatch() { cleared = true; }, async remove(id) { removed.push(id); }, async get() {},
      },
      auditStore: withAuditRevisions({
        async getAudit(id) { return proved && id === checkpoint.id ? { auditId: id, session: { status: 'complete' } } : undefined; },
        async getLatest() { return latest; }, async setLatest(value) { latest = value; },
      }),
    });
    await waitUntil(() => cleared);
    assert.equal(saved, undefined);
    assert.equal(latest?.status, proved ? 'complete' : undefined);
    assert.deepEqual(removed, [checkpoint.id]);
  }
});

test('restart treats an absent terminal checkpoint as deleted and never recreates latest state', async () => {
  const chromeApi = createChrome();
  const sessionValues = {
    'audita-mt:session:batch-deleted': {
      id: 'batch-deleted', mode: 'batch', state: 'complete', total: 1, currentIndex: 1,
      completedCount: 1, statusCounts: { complete: 1, partial: 0, failed: 0, cancelled: 0 },
      cancelRequested: false, startedAt: '2026-08-28T10:00:00.000Z',
      updatedAt: '2026-08-28T10:01:00.000Z', resumable: false,
    },
  };
  sessionValues['audita-mt:session:active-batch'] = structuredClone(sessionValues['audita-mt:session:batch-deleted']);
  chromeApi.storage = { session: {
    async get(key) {
      if (key === null) return structuredClone(sessionValues);
      return Object.hasOwn(sessionValues, key) ? { [key]: structuredClone(sessionValues[key]) } : {};
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete sessionValues[key];
    },
    async set(values) { Object.assign(sessionValues, structuredClone(values)); },
  } };
  const latestWrites = [];
  registerServiceWorker(chromeApi, {
    auditStore: {
      async markAuditInterrupted() { return { updated: false, reason: 'stale' }; },
    },
  });
  await waitUntil(() => sessionValues['audita-mt:session:active-batch'] === undefined);
  assert.equal(sessionValues['audita-mt:session:batch-deleted'], undefined);
  assert.deepEqual(latestWrites, []);
});

test('clears a stale active marker without replacing a newer single-page latest record', async () => {
  const chromeApi = createChrome();
  const checkpoint = {
    id: 'batch-stale', mode: 'batch', state: 'idle', total: 1, currentIndex: 0, completedCount: 0,
    statusCounts: { complete: 0, partial: 0, failed: 0, cancelled: 0 }, cancelRequested: false,
    startedAt: '2026-08-28T10:00:00.000Z', updatedAt: '2026-08-28T10:00:00.000Z', resumable: false,
  };
  const latest = { auditId: 'single-newer', status: 'complete' };
  const writes = [];
  let cleared = false;
  registerServiceWorker(chromeApi, {
    sessionStore: { async getActiveBatch() { return checkpoint; }, async clearActiveBatch() { cleared = true; }, async set() {}, async get() {} },
    auditStore: withAuditRevisions({ async getLatest() { return latest; }, async setLatest(value) { writes.push(value); } }),
  });
  await waitUntil(() => cleared);
  assert.deepEqual(writes, []);
});

test('single-audit checkpoints strip every query and hash while runner keeps the full navigation URL', async () => {
  const chromeApi = createChrome();
  const sessions = new Map();
  const stored = [];
  const logs = [];
  let runnerUrl;
  let finishRunner;
  const auditStore = {
    async setLatest(value) { stored.push(value); },
    async commitAudit(_id, _model, latest) { stored.push(latest); },
  };
  registerServiceWorker(chromeApi, {
    createId: () => 'audit-private', sessions, auditStore: withAuditRevisions(auditStore),
    logger: { error(value) { logs.push(value); } },
    chromeAdapterFactory: () => ({}),
    runner: ({ url }) => {
      runnerUrl = url;
      return new Promise(resolve => { finishRunner = resolve; });
    },
  });
  const fullNavigationUrl = 'https://example.test/path?ordinary_parameter=PRIVATE_QUERY_VALUE#ordinary-fragment';
  chromeApi.listeners.message.listener(
    { type: 'START_AUDIT', url: fullNavigationUrl },
    { id: 'test', url: 'chrome-extension://test/src/panel/index.html' }, () => {},
  );
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(runnerUrl, fullNavigationUrl);
  assert.equal(sessions.get('audit-private').requestedUrl, 'https://example.test/path');
  assert.doesNotMatch(
    JSON.stringify([...sessions.values(), ...stored, ...logs]),
    /PRIVATE_QUERY_VALUE|ordinary_parameter|ordinary-fragment/iu,
  );
  finishRunner?.({ auditId: 'audit-private', session: { status: 'complete' }, report: {} });
});

test('notification failure after atomic commit never rewrites committed complete state', async () => {
  const chromeApi = createChrome();
  chromeApi.runtime.sendMessage = async () => { throw new Error('panel closed'); };
  const writes = [];
  const auditStore = {
    async setLatest(value) { writes.push(['latest', value]); },
    async commitAudit(id, model, latest) { writes.push(['commit', id, model, latest]); },
  };
  registerServiceWorker(chromeApi, {
    createId: () => 'audit-notify', auditStore: withAuditRevisions(auditStore), chromeAdapterFactory: () => ({}),
    runner: async () => ({ auditId: 'audit-notify', session: { status: 'complete' }, report: {} }),
  });
  chromeApi.listeners.message.listener({ type: 'START_AUDIT', url: 'https://example.test/' }, { id: 'test', url: 'chrome-extension://test/src/panel/index.html' }, () => {});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(writes.filter(([kind]) => kind === 'commit').length, 1);
  assert.equal(writes.some(([kind, value]) => kind === 'latest' && value.status === 'failed'), false);
});

test('automatic export never synthesizes failure from another preparing attempt', async () => {
  const chromeApi = createChrome();
  const store = createInMemoryAuditStore();
  store.acquireExportLease = async () => {
    await store.setLatest({
      auditId: SAMPLE_AUDIT.auditId,
      status: 'partial',
      exportStatus: 'preparing',
      exportRevision: 1,
      exportAttempt: 7,
      leaseOwnerId: 'owner-other-attempt',
      message: 'Uma versão revisada aguarda nova geração.',
    });
    throw Object.assign(new Error('review won'), { code: 'AUDIT_REVISION_CONFLICT' });
  };
  registerServiceWorker(chromeApi, {
    createId: () => SAMPLE_AUDIT.auditId,
    auditStore: store,
    chromeAdapterFactory: () => ({}),
    runner: async () => structuredClone(SAMPLE_AUDIT),
  });
  chromeApi.listeners.message.listener(
    { type: 'START_AUDIT', url: 'https://example.test/' },
    { id: 'test', url: 'chrome-extension://test/src/panel/index.html' },
    () => {},
  );
  await waitUntil(() => chromeApi.runtime.sent.some(message => message.type === 'AUDIT_COMPLETE'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(chromeApi.runtime.sent.some(message => message.type === 'EXPORT_FAILED'), false);
  assert.equal((await store.getLatest()).exportStatus, 'preparing');
});

test('automatic export tab failure atomically persists a controlled partial model and latest state', async () => {
  const chromeApi = createChrome();
  chromeApi.tabs.create = async options => {
    if (options.url.includes('/src/export/')) throw new Error('tab denied');
    chromeApi.createdTabs.push(options);
  };
  const writes = [];
  const auditStore = {
    async setLatest(value) { writes.push(['latest', value]); },
    async commitAudit(id, model, latest) { writes.push(['commit', id, model, latest]); },
  };
  const model = structuredClone(SAMPLE_AUDIT);
  registerServiceWorker(chromeApi, { createId: () => model.auditId, auditStore: withAuditRevisions(auditStore), chromeAdapterFactory: () => ({}), runner: async () => model, now: () => '2026-08-26T16:00:00.000Z' });
  chromeApi.listeners.message.listener({ type: 'START_AUDIT', url: 'https://example.test/' }, { id: 'test', url: 'chrome-extension://test/src/panel/index.html' }, () => {});
  await waitUntil(() => writes.filter(([kind]) => kind === 'commit').length === 2);
  const commits = writes.filter(([kind]) => kind === 'commit');
  assert.equal(commits.length, 2);
  assert.equal(commits[1][2].session.status, 'partial');
  assert.deepEqual(commits[1][2].report.artifact.formats, []);
  assert.equal(commits[1][3].exportStatus, 'failed');
  assert.ok(chromeApi.runtime.sent.some(message => message.type === 'EXPORT_FAILED' && message.auditId === model.auditId));
});

test('requested export tab failure atomically replaces queued state with a controlled partial model', async () => {
  const chromeApi = createChrome();
  chromeApi.tabs.create = async () => { throw new Error('TOPSECRET https://origin.test/?token=x'); };
  const model = structuredClone(SAMPLE_AUDIT);
  let latest = { auditId: model.auditId, status: 'complete', exportStatus: 'complete' };
  const commits = [];
  const auditStore = {
    async getAudit() { return model; }, async getLatest() { return latest; },
    async setLatest(value) { latest = value; },
    async commitAudit(...values) { commits.push(values); latest = values[2]; },
  };
  registerServiceWorker(chromeApi, { auditStore: withAuditRevisions(auditStore), now: () => '2026-08-26T16:00:00.000Z' });
  let response;
  chromeApi.listeners.message.listener(
    { type: 'REQUEST_EXPORT', auditId: model.auditId },
    { id: 'test', url: `chrome-extension://test/src/review/index.html?auditId=${model.auditId}` },
    value => { response = value; },
  );
  await waitUntil(() => response !== undefined);
  assert.equal(response.ok, false);
  assert.equal(commits.length, 1);
  assert.equal(commits[0][1].session.status, 'partial');
  assert.equal(commits[0][2].exportStatus, 'failed');
  assert.doesNotMatch(JSON.stringify(commits), /TOPSECRET|origin\.test|blob:|chrome-extension:/iu);
});

test('a newer review makes an old queued export marker stale and never blocks the immediate retry', async () => {
  const chromeApi = createChrome();
  let releaseFirstTab;
  let exportTabCalls = 0;
  chromeApi.tabs.create = async options => {
    exportTabCalls += 1;
    if (exportTabCalls === 1) {
      await new Promise(resolve => { releaseFirstTab = resolve; });
      throw new Error('tab denied after review');
    }
    chromeApi.createdTabs.push(options);
  };
  const store = createInMemoryAuditStore();
  const model = structuredClone(SAMPLE_AUDIT);
  await store.setAudit(model.auditId, model);
  await store.setLatest({ auditId: model.auditId, status: 'complete', exportStatus: 'complete' });
  registerServiceWorker(chromeApi, { auditStore: store, now: () => '2026-08-26T16:00:00.000Z' });
  const sender = { id: 'test', url: `chrome-extension://test/src/review/index.html?auditId=${model.auditId}` };
  let first;
  chromeApi.listeners.message.listener(
    { type: 'REQUEST_EXPORT', auditId: model.auditId },
    sender,
    value => { first = value; },
  );
  await waitUntil(async () => (await store.getLatest())?.exportStatus === 'queued');
  await commitReviewDecision(model, {
    auditId: model.auditId,
    itemId: '5.1.4',
    occurrenceId: 'occ-focus-review',
    answer: 'não foi possível determinar',
    evaluator: 'Pessoa avaliadora',
    decidedAt: '2026-08-26T16:01:00.000Z',
    mode: 'assisted',
  }, store);
  releaseFirstTab();
  await waitUntil(() => first !== undefined);
  assert.equal(first.ok, false);
  assert.equal((await store.getAudit(model.auditId)).reviewDecisions.length, 1);

  let second;
  chromeApi.listeners.message.listener(
    { type: 'REQUEST_EXPORT', auditId: model.auditId },
    sender,
    value => { second = value; },
  );
  await waitUntil(() => second !== undefined);
  assert.equal(second.ok, true);
  assert.equal(second.auditId, model.auditId);
  assert.equal(second.state, 'queued');
  assert.equal(Number.isSafeInteger(second.exportRevision), true);
  assert.equal(exportTabCalls, 2);
});

test('commit failure sends no completion and persists only best-effort failed latest', async () => {
  const chromeApi = createChrome();
  const latest = [];
  const auditStore = {
    async setLatest(value) { latest.push(value); },
    async commitAudit() { throw new Error('transaction aborted'); },
  };
  registerServiceWorker(chromeApi, {
    createId: () => 'audit-commit-fail', auditStore: withAuditRevisions(auditStore), chromeAdapterFactory: () => ({}),
    runner: async () => ({ auditId: 'audit-commit-fail', session: { status: 'complete' }, report: {} }),
  });
  chromeApi.listeners.message.listener({ type: 'START_AUDIT', url: 'https://example.test/' }, { id: 'test', url: 'chrome-extension://test/src/panel/index.html' }, () => {});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(chromeApi.runtime.sent.some(message => message.type === 'AUDIT_COMPLETE'), false);
  assert.equal(latest.at(-1).status, 'failed');
});

test('restores the latest persisted audit state to a reopened authorized panel', async () => {
  const chromeApi = createChrome();
  const latest = { auditId: 'audit-last', status: 'partial', percent: 100, reviewUrl: 'chrome-extension://test/src/review/index.html?auditId=audit-last' };
  registerServiceWorker(chromeApi, { auditStore: { async getLatest() { return latest; } } });
  let response;
  const keepOpen = chromeApi.listeners.message.listener(
    { type: 'GET_LAST_AUDIT' },
    { id: 'test', url: 'chrome-extension://test/src/panel/index.html' },
    value => { response = value; },
  );
  assert.equal(keepOpen, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(response, { ok: true, state: latest });
});

test('restored complete or partial exports become stale after a newer audit revision', async () => {
  for (const exportStatus of ['complete', 'partial']) {
    const chromeApi = createChrome();
    const auditStore = createInMemoryAuditStore();
    await auditStore.setAudit('audit-stale-export', auditFixture('audit-stale-export', 'initial'));
    await auditStore.setLatest({
      auditId: 'audit-stale-export',
      status: 'complete',
      exportStatus,
      exportRevision: 1,
      message: 'Arquivos do relatório gerados.',
    });
    await auditStore.setAudit('audit-stale-export', auditFixture('audit-stale-export', 'newer-review'));
    registerServiceWorker(chromeApi, { auditStore });
    let response;
    chromeApi.listeners.message.listener(
      { type: 'GET_LAST_AUDIT' },
      { id: 'test', url: 'chrome-extension://test/src/panel/index.html' },
      value => { response = value; },
    );
    await waitUntil(() => response !== undefined);
    assert.equal(response.state.exportStatus, 'failed');
    assert.match(response.state.message, /atualizada|desatualizado|gere.+novamente/iu);
  }
});

test('does not acknowledge queued before persistent exclusivity and reports a concurrent retry as BUSY', async () => {
  const chromeApi = createChrome();
  const store = createInMemoryAuditStore();
  const model = structuredClone(SAMPLE_AUDIT);
  await store.setAudit(model.auditId, model);
  await store.setLatest({ auditId: model.auditId, exportStatus: 'complete' });
  const acquire = store.acquireExportLease.bind(store);
  let releaseAcquire;
  const gate = new Promise(resolve => { releaseAcquire = resolve; });
  store.acquireExportLease = async (...args) => { await gate; return acquire(...args); };
  registerServiceWorker(chromeApi, {
    auditStore: store,
    now: () => '2026-08-27T10:00:00.000Z',
    createExportOwnerId: () => 'owner-exclusive',
  });
  const sender = { id: 'test', url: `chrome-extension://test/src/review/index.html?auditId=${model.auditId}` };
  let first;
  let retry;
  chromeApi.listeners.message.listener(
    { type: 'REQUEST_EXPORT', auditId: model.auditId }, sender, value => { first = value; },
  );
  chromeApi.listeners.message.listener(
    { type: 'REQUEST_EXPORT', auditId: model.auditId }, sender, value => { retry = value; },
  );
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(first, undefined);
  assert.deepEqual(retry, {
    ok: false,
    auditId: model.auditId,
    state: 'busy',
    code: 'EXPORT_BUSY',
    retryable: true,
    error: 'Este relatório já está sendo gerado; tente novamente após a conclusão.',
  });
  assert.equal(chromeApi.createdTabs.length, 0);

  releaseAcquire();
  await waitUntil(() => first !== undefined);
  assert.equal(first.ok, true);
  assert.equal(first.state, 'queued');
  assert.equal(Number.isSafeInteger(first.exportRevision), true);
  assert.equal(chromeApi.createdTabs.filter(tab => tab.url.includes('/src/export/')).length, 1);
});

test('maps a review race before lease acquisition to an explicit retryable stale response', async () => {
  const chromeApi = createChrome();
  const store = createInMemoryAuditStore();
  const model = structuredClone(SAMPLE_AUDIT);
  await store.setAudit(model.auditId, model);
  const acquire = store.acquireExportLease.bind(store);
  let raced = false;
  store.acquireExportLease = async (...args) => {
    if (!raced) {
      raced = true;
      await store.setAudit(model.auditId, auditFixture(model.auditId, 'review-race'));
    }
    return acquire(...args);
  };
  registerServiceWorker(chromeApi, {
    auditStore: store,
    now: () => '2026-08-27T10:00:00.000Z',
    createExportOwnerId: () => 'owner-stale-retry',
  });
  let response;
  chromeApi.listeners.message.listener(
    { type: 'REQUEST_EXPORT', auditId: model.auditId },
    { id: 'test', url: `chrome-extension://test/src/review/index.html?auditId=${model.auditId}` },
    value => { response = value; },
  );
  await waitUntil(() => response !== undefined);
  assert.deepEqual(response, {
    ok: false,
    auditId: model.auditId,
    state: 'stale',
    code: 'AUDIT_REVISION_CONFLICT',
    retryable: true,
    error: 'A auditoria foi atualizada; solicite novamente o relatório revisado.',
  });
  assert.equal(chromeApi.createdTabs.some(tab => tab.url.includes('/src/export/')), false);
});

test('two service-worker instances share the persistent lease and open only one export tab', async () => {
  const backing = new Map();
  const firstStore = createInMemoryAuditStore(backing);
  const secondStore = createInMemoryAuditStore(backing);
  const model = structuredClone(SAMPLE_AUDIT);
  await firstStore.setAudit(model.auditId, model);
  await firstStore.setLatest({ auditId: model.auditId, exportStatus: 'complete' });
  const firstChrome = createChrome();
  const secondChrome = createChrome();
  registerServiceWorker(firstChrome, {
    auditStore: firstStore, now: () => '2026-08-27T10:00:00.000Z', createExportOwnerId: () => 'owner-worker-a',
  });
  registerServiceWorker(secondChrome, {
    auditStore: secondStore, now: () => '2026-08-27T10:00:00.000Z', createExportOwnerId: () => 'owner-worker-b',
  });
  const sender = { id: 'test', url: `chrome-extension://test/src/review/index.html?auditId=${model.auditId}` };
  let first;
  let second;
  firstChrome.listeners.message.listener(
    { type: 'REQUEST_EXPORT', auditId: model.auditId }, sender, value => { first = value; },
  );
  secondChrome.listeners.message.listener(
    { type: 'REQUEST_EXPORT', auditId: model.auditId }, sender, value => { second = value; },
  );
  await waitUntil(() => first !== undefined && second !== undefined);
  const responses = [first, second];
  assert.equal(responses.filter(response => response.ok && response.state === 'queued').length, 1);
  assert.equal(responses.filter(response => response.code === 'EXPORT_BUSY' && response.retryable).length, 1);
  assert.equal([
    ...firstChrome.createdTabs,
    ...secondChrome.createdTabs,
  ].filter(tab => tab.url.includes('/src/export/')).length, 1);
});

test('GET_LAST keeps an uncorrelated initial export handshake retryable instead of marking it failed', async () => {
  const chromeApi = createChrome();
  const store = createInMemoryAuditStore();
  await store.setAudit('audit-handshake', auditFixture('audit-handshake'));
  await store.setLatest({
    auditId: 'audit-handshake',
    status: 'complete',
    exportStatus: 'queued',
    message: 'Relatório na fila de geração.',
  });
  registerServiceWorker(chromeApi, { auditStore: store });
  let response;
  chromeApi.listeners.message.listener(
    { type: 'GET_LAST_AUDIT' },
    { id: 'test', url: 'chrome-extension://test/src/panel/index.html' },
    value => { response = value; },
  );
  await waitUntil(() => response !== undefined);
  assert.equal(response.state.exportStatus, 'preparing');
  assert.notEqual(response.state.exportStatus, 'failed');
  assert.match(response.state.message, /preparando|tente novamente|geração/iu);
});

test('GET_LAST treats a same-revision queued marker without a live lease as retryable stale state', async () => {
  const chromeApi = createChrome();
  const store = createInMemoryAuditStore();
  await store.setAudit('audit-orphan-marker', auditFixture('audit-orphan-marker'));
  const snapshot = await store.getAuditSnapshot('audit-orphan-marker');
  await store.setLatest({
    auditId: 'audit-orphan-marker',
    status: 'complete',
    exportStatus: 'queued',
    exportRevision: snapshot.revision,
    message: 'Relatório na fila de geração.',
  });
  registerServiceWorker(chromeApi, {
    auditStore: store,
    now: () => '2026-08-27T10:00:00.000Z',
  });
  let response;
  chromeApi.listeners.message.listener(
    { type: 'GET_LAST_AUDIT' },
    { id: 'test', url: 'chrome-extension://test/src/panel/index.html' },
    value => { response = value; },
  );
  await waitUntil(() => response !== undefined);
  assert.equal(response.state.exportStatus, 'preparing');
  assert.match(response.state.message, /interrompida|novamente|preparando|geração/iu);
});

test('GET_LAST rejects a queued marker whose owner differs from the live lease', async () => {
  const chromeApi = createChrome();
  const store = createInMemoryAuditStore();
  await store.setAudit('audit-owner-marker', auditFixture('audit-owner-marker'));
  const snapshot = await store.getAuditSnapshot('audit-owner-marker');
  const lease = await store.acquireExportLease('audit-owner-marker', snapshot.capability, {
    ownerId: 'owner-live', now: '2026-08-27T10:00:00.000Z',
    latestState: {
      auditId: 'audit-owner-marker', status: 'complete', exportStatus: 'queued',
      exportRevision: snapshot.revision, leaseOwnerId: 'owner-live',
    },
  });
  await store.setLatest({
    auditId: 'audit-owner-marker', status: 'complete', exportStatus: 'queued',
    exportRevision: snapshot.revision, exportAttempt: lease.exportAttempt,
    leaseOwnerId: 'owner-forged',
  });
  registerServiceWorker(chromeApi, { auditStore: store, now: () => '2026-08-27T10:00:00.100Z' });
  let response;
  chromeApi.listeners.message.listener(
    { type: 'GET_LAST_AUDIT' },
    { id: 'test', url: 'chrome-extension://test/src/panel/index.html' },
    value => { response = value; },
  );
  await waitUntil(() => response !== undefined);
  assert.equal(response.state.exportStatus, 'preparing');
});

test('GET_LAST retries a torn latest/snapshot read instead of reporting a live delivery as failed', async () => {
  const chromeApi = createChrome();
  const store = createInMemoryAuditStore();
  await store.setAudit('audit-restore-race', auditFixture('audit-restore-race', 'reviewed'));
  const queuedSnapshot = await store.getAuditSnapshot('audit-restore-race');
  await store.acquireExportLease('audit-restore-race', queuedSnapshot.capability, {
    ownerId: 'owner-restore-race', now: '2026-08-27T10:00:00.000Z',
    latestState: {
      auditId: 'audit-restore-race', status: 'complete', exportStatus: 'queued',
      exportRevision: queuedSnapshot.revision,
      leaseOwnerId: 'owner-restore-race',
    },
  });
  await store.claimExportLease('audit-restore-race', queuedSnapshot.capability, {
    ownerId: 'owner-restore-race', now: '2026-08-27T10:00:00.100Z',
    latestState: {
      auditId: 'audit-restore-race', status: 'complete', exportStatus: 'running',
      exportRevision: queuedSnapshot.revision,
      leaseOwnerId: 'owner-restore-race',
    },
  });
  const readSnapshot = store.getAuditSnapshot.bind(store);
  let raced = false;
  store.getAuditSnapshot = async id => {
    if (!raced) {
      raced = true;
      await store.commitAuditIfRevisionWithExportLease(
        id,
        auditFixture(id, 'delivering'),
        {
          auditId: id, status: 'complete', exportStatus: 'delivering',
          exportRevision: queuedSnapshot.revision + 1,
          leaseOwnerId: 'owner-restore-race',
        },
        queuedSnapshot.capability,
        { ownerId: 'owner-restore-race', now: '2026-08-27T10:00:00.200Z', phase: 'delivering' },
      );
    }
    return readSnapshot(id);
  };
  registerServiceWorker(chromeApi, {
    auditStore: store,
    now: () => '2026-08-27T10:00:00.300Z',
  });
  let response;
  chromeApi.listeners.message.listener(
    { type: 'GET_LAST_AUDIT' },
    { id: 'test', url: 'chrome-extension://test/src/panel/index.html' },
    value => { response = value; },
  );
  await waitUntil(() => response !== undefined);
  assert.equal(response.ok, true);
  assert.equal(response.state.exportStatus, 'delivering');
  assert.equal(response.state.exportRevision, queuedSnapshot.revision + 1);
});

test('handles rejected panel-tab creation without an unhandled rejection', async () => {
  const chromeApi = createChrome();
  chromeApi.tabs.create = async () => { throw new Error('tabs indisponível'); };
  const errors = [];
  registerServiceWorker(chromeApi, { createId: () => 'audit-1', logger: { error: (message) => errors.push(message) } });
  chromeApi.listeners.action.listener();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(errors, ['Não foi possível abrir o painel de auditoria.']);
});

test('START_AUDIT persists the per-audit delete-after-export intent only on the first model commit', async () => {
  const chromeApi = createChrome();
  const store = createInMemoryAuditStore();
  registerServiceWorker(chromeApi, {
    createId: () => 'audit-retention-worker',
    now: () => '2026-08-28T10:00:00.000Z',
    auditStore: store,
    chromeAdapterFactory: () => ({}),
    runner: async () => auditFixture('audit-retention-worker'),
  });
  let response;
  chromeApi.listeners.message.listener({
    type: 'START_AUDIT', url: 'https://example.test/', deleteAfterCompleteExport: true,
  }, {
    id: 'test', url: 'chrome-extension://test/src/panel/index.html', documentId: 'panel-retention',
  }, value => { response = value; });
  assert.equal(response.ok, true);
  await waitUntil(async () => (await store.getAuditRetention('audit-retention-worker')) !== undefined);
  assert.equal((await store.getAuditRetention('audit-retention-worker')).deleteAfterCompleteExport, true);
});

test('START messages reject non-boolean retention intent before running any audit', () => {
  const chromeApi = createChrome();
  let calls = 0;
  registerServiceWorker(chromeApi, { runner: async () => { calls += 1; } });
  let response;
  chromeApi.listeners.message.listener({
    type: 'START_AUDIT', url: 'https://example.test/', deleteAfterCompleteExport: 'yes',
  }, {
    id: 'test', url: 'chrome-extension://test/src/panel/index.html', documentId: 'panel-invalid-retention',
  }, value => { response = value; });
  assert.equal(response.ok, false);
  assert.equal(calls, 0);
});

test('GET_LAST runs one limited retention cleanup before restoring state', async () => {
  const chromeApi = createChrome();
  const calls = [];
  const latest = { auditId: 'audit-cleanup-open', status: 'complete' };
  const pruned = [];
  const auditStore = {
    async cleanupExpiredAudits(options) { calls.push(['cleanup', options]); return { scanned: 0, deleted: 0, remaining: 0, blocked: 0 }; },
    async getLatest() { calls.push(['latest']); return latest; },
  };
  registerServiceWorker(chromeApi, {
    auditStore,
    sessionStore: {
      async getActiveBatch() {},
      async clearAuditSessions(options) { pruned.push(options); },
    },
    now: () => '2026-08-28T11:22:33.444Z',
  });
  let response;
  chromeApi.listeners.message.listener(
    { type: 'GET_LAST_AUDIT' },
    { id: 'test', url: 'chrome-extension://test/src/panel/index.html' },
    value => { response = value; },
  );
  await waitUntil(() => response !== undefined);
  assert.deepEqual(response, { ok: true, state: latest });
  assert.deepEqual(calls[0], ['cleanup', { now: '2026-08-28T11:22:33.444Z', limit: 25 }]);
  assert.deepEqual(pruned, [{ keepAuditIds: [] }]);
});

test('terminal single and batch executions remove their correlated session checkpoints', async () => {
  for (const mode of ['single', 'batch']) {
    const chromeApi = createChrome();
    const removed = [];
    let activeCleared = 0;
    const sessionStore = {
      async getActiveBatch() {},
      async set() {},
      async remove(id) { removed.push(id); },
      async setActiveBatch() {},
      async clearActiveBatch() { activeCleared += 1; },
    };
    const auditId = `terminal-${mode}`;
    const runner = async ({ onCheckpoint } = {}) => {
      await onCheckpoint?.({
        id: auditId, mode: 'batch', state: 'running', total: 1, currentIndex: 0,
        completedCount: 0, statusCounts: { complete: 0, partial: 0, failed: 0, cancelled: 0 },
        cancelRequested: false, startedAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z', resumable: false,
      });
      return {
        auditId,
        pages: mode === 'batch' ? [] : undefined,
        session: { status: mode === 'single' ? 'complete' : 'failed' },
        report: {},
      };
    };
    registerServiceWorker(chromeApi, {
      createId: () => auditId,
      sessionStore,
      auditStore: createInMemoryAuditStore(),
      chromeAdapterFactory: () => ({}),
      runner: mode === 'single' ? runner : undefined,
      batchRunner: mode === 'batch' ? runner : undefined,
      now: () => '2026-08-01T00:00:00.000Z',
      reportOptions: { timezone: 'UTC', manifestVersion: '2.0.0', rulesVersion: '1.0.0', browserVersion: '152' },
    });
    const message = mode === 'single'
      ? { type: 'START_AUDIT', url: 'https://example.test/' }
      : { type: 'START_BATCH', urls: 'https://example.test/' };
    chromeApi.listeners.message.listener(
      message,
      { id: 'test', url: 'chrome-extension://test/src/panel/index.html', documentId: `panel-${mode}` },
      () => {},
    );
    await waitUntil(() => removed.includes(auditId));
    assert.deepEqual(removed, [auditId], mode);
    assert.equal(activeCleared, mode === 'batch' ? 1 : 0, mode);
  }
});

test('storage failure prevents AUDIT_COMPLETE and exposes only the fixed actionable message', async () => {
  const chromeApi = createChrome();
  const auditStore = {
    async setLatest() {},
    async commitAudit() { throw new AuditStorageUnavailableError(); },
  };
  registerServiceWorker(chromeApi, {
    createId: () => 'audit-storage-failure',
    auditStore,
    chromeAdapterFactory: () => ({}),
    runner: async () => ({ auditId: 'audit-storage-failure', session: { status: 'complete' }, report: {} }),
  });
  chromeApi.listeners.message.listener(
    { type: 'START_AUDIT', url: 'https://example.test/' },
    { id: 'test', url: 'chrome-extension://test/src/panel/index.html', documentId: 'panel-storage-failure' },
    () => {},
  );
  await waitUntil(() => chromeApi.runtime.sent.some(message => message.type === 'AUDIT_FAILED'));
  assert.equal(chromeApi.runtime.sent.some(message => message.type === 'AUDIT_COMPLETE'), false);
  const failed = chromeApi.runtime.sent.find(message => message.type === 'AUDIT_FAILED');
  assert.equal(failed.error, 'Não foi possível salvar a auditoria no armazenamento local. Libere espaço ou verifique as permissões e tente novamente.');
  assert.doesNotMatch(JSON.stringify(failed), /database|quota|bytes|token/iu);
});

test('destructive protocol accepts only correlated review and canonical panel senders', async () => {
  const chromeApi = createChrome();
  const store = createInMemoryAuditStore();
  for (const auditId of ['delete-protocol-a', 'delete-protocol-b']) {
    await store.commitAudit(auditId, auditFixture(auditId), { auditId }, { now: '2026-08-01T00:00:00.000Z' });
  }
  const sessions = registerServiceWorker(chromeApi, {
    auditStore: store,
    now: () => '2026-08-28T12:00:00.000Z',
  });
  await sessions.set('delete-protocol-a', { id: 'delete-protocol-a', state: 'complete' });
  await sessions.set('delete-protocol-b', { id: 'delete-protocol-b', state: 'complete' });
  await sessions.setActiveBatch({ id: 'delete-protocol-a', mode: 'batch', state: 'complete' });

  for (const [message, sender] of [
    [{ type: 'REQUEST_DELETE_AUDIT', auditId: 'delete-protocol-a' }, { id: 'test', url: 'chrome-extension://test/src/export/index.html?auditId=delete-protocol-a&exportAttempt=1&leaseOwnerId=owner' }],
    [{ type: 'REQUEST_DELETE_AUDIT', auditId: 'delete-protocol-a' }, { id: 'test', url: 'chrome-extension://test/src/review/index.html?auditId=delete-protocol-b' }],
    [{ type: 'REQUEST_DELETE_AUDIT', auditId: 'delete-protocol-a', confirmed: true }, { id: 'test', url: 'chrome-extension://test/src/review/index.html?auditId=delete-protocol-a' }],
    [{ type: 'REQUEST_DELETE_ALL_AUDITS' }, { id: 'test', url: 'chrome-extension://test/src/panel/index.html?unexpected=1' }],
  ]) {
    let denied;
    chromeApi.listeners.message.listener(message, sender, value => { denied = value; });
    await waitUntil(() => denied !== undefined);
    assert.equal(denied.ok, false);
    assert.ok(await store.getAudit('delete-protocol-a'));
  }

  let deletedOne;
  chromeApi.listeners.message.listener(
    { type: 'REQUEST_DELETE_AUDIT', auditId: 'delete-protocol-a' },
    { id: 'test', frameId: 0, url: 'chrome-extension://test/src/review/index.html?auditId=delete-protocol-a' },
    value => { deletedOne = value; },
  );
  await waitUntil(() => deletedOne !== undefined);
  assert.deepEqual(deletedOne, { ok: true, auditId: 'delete-protocol-a', deleted: true });
  assert.equal(await store.getAudit('delete-protocol-a'), undefined);
  assert.equal(await sessions.get('delete-protocol-a'), undefined);
  assert.equal(await sessions.getActiveBatch(), undefined);
  assert.ok(await sessions.get('delete-protocol-b'));
  assert.ok(chromeApi.runtime.sent.some(message => message.type === 'AUDIT_DELETED' &&
    message.auditId === 'delete-protocol-a' && message.reason === 'delete-one'));

  await sessions.setActiveBatch({ id: 'delete-protocol-b', mode: 'batch', state: 'complete' });
  let deletedAll;
  chromeApi.listeners.message.listener(
    { type: 'REQUEST_DELETE_ALL_AUDITS' },
    { id: 'test', frameId: 0, url: 'chrome-extension://test/src/panel/index.html' },
    value => { deletedAll = value; },
  );
  await waitUntil(() => deletedAll !== undefined);
  assert.deepEqual(deletedAll, { ok: true, deleted: 1 });
  assert.equal(await store.getAudit('delete-protocol-b'), undefined);
  assert.equal(await sessions.get('delete-protocol-b'), undefined);
  assert.equal(await sessions.getActiveBatch(), undefined);
  assert.ok(chromeApi.runtime.sent.some(message => message.type === 'AUDIT_DELETED' &&
    message.scope === 'all' && message.reason === 'delete-all'));
});

test('worker publishes complete-export deletion only after exact correlation and durable absence', async () => {
  const chromeApi = createChrome();
  const store = createInMemoryAuditStore();
  const sessions = registerServiceWorker(chromeApi, { auditStore: store });
  await sessions.set('export-deleted', { id: 'export-deleted', state: 'complete' });
  await sessions.setActiveBatch({ id: 'export-deleted', mode: 'batch', state: 'complete' });
  const message = {
    type: 'EXPORT_COMPLETE',
    auditId: 'export-deleted',
    status: 'complete',
    formats: ['html', 'json', 'csv', 'pdf'],
    exportRevision: 2,
    exportAttempt: 1,
    leaseOwnerId: 'owner-1',
    localAuditDeleted: true,
  };
  const sender = {
    id: 'test', frameId: 0,
    url: 'chrome-extension://test/src/export/index.html?auditId=export-deleted&leaseOwnerId=owner-1&exportAttempt=1',
  };
  let response;
  chromeApi.listeners.message.listener(message, sender, value => { response = value; });
  await waitUntil(() => response !== undefined);
  assert.deepEqual(response, { ok: true });
  await waitUntil(() => chromeApi.runtime.sent.some(value => value.type === 'AUDIT_DELETED'));
  assert.deepEqual(chromeApi.runtime.sent.find(value => value.type === 'AUDIT_DELETED'), {
    type: 'AUDIT_DELETED', auditId: 'export-deleted', reason: 'complete-export',
  });
  assert.equal(await sessions.get('export-deleted'), undefined);
  assert.equal(await sessions.getActiveBatch(), undefined);

  chromeApi.runtime.sent.length = 0;
  await store.commitAudit('still-present', auditFixture('still-present'), { auditId: 'still-present' }, {
    now: '2026-08-28T12:00:00.000Z', deleteAfterCompleteExport: true,
  });
  chromeApi.listeners.message.listener({ ...message, auditId: 'still-present' }, {
    ...sender,
    url: 'chrome-extension://test/src/export/index.html?auditId=still-present&leaseOwnerId=owner-1&exportAttempt=1',
  }, () => {});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(chromeApi.runtime.sent.some(value => value.type === 'AUDIT_DELETED'), false);

  chromeApi.listeners.message.listener({ ...message, formats: ['html', 'json', 'csv'] }, sender, () => {});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(chromeApi.runtime.sent.some(value => value.type === 'AUDIT_DELETED'), false);
});

test('queues complete-export confirmation behind startup restoration', async () => {
  const chromeApi = createChrome();
  const auditId = 'export-complete-startup-gate';
  let releaseStartup;
  const startupGate = new Promise(resolve => { releaseStartup = resolve; });
  const removed = [];
  registerServiceWorker(chromeApi, {
    sessionStore: {
      async getActiveBatch() { await startupGate; return undefined; },
      async remove(id) { removed.push(id); },
    },
    auditStore: {
      async getAuditSnapshot() { return { model: undefined, revision: 1, capability: null }; },
      async getAuditRetention() { return undefined; },
      async getLatest() { return undefined; },
    },
  });
  const message = {
    type: 'EXPORT_COMPLETE', auditId, status: 'complete',
    formats: ['html', 'json', 'csv', 'pdf'], exportRevision: 1,
    exportAttempt: 1, leaseOwnerId: 'owner-startup-gate', localAuditDeleted: true,
  };
  const sender = {
    id: 'test', frameId: 0,
    url: `chrome-extension://test/src/export/index.html?auditId=${auditId}&leaseOwnerId=owner-startup-gate&exportAttempt=1`,
  };
  let response;
  chromeApi.listeners.message.listener(message, sender, value => { response = value; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(response, undefined);
  assert.deepEqual(removed, []);
  assert.equal(chromeApi.runtime.sent.some(value => value.type === 'AUDIT_DELETED'), false);

  releaseStartup();
  await waitUntil(() => response !== undefined);
  assert.deepEqual(response, { ok: true });
  assert.deepEqual(removed, [auditId]);
  assert.deepEqual(chromeApi.runtime.sent.find(value => value.type === 'AUDIT_DELETED'), {
    type: 'AUDIT_DELETED', auditId, reason: 'complete-export',
  });
});

test('fences restart interruption atomically against an export-tab deletion', async () => {
  const chromeApi = createChrome();
  const auditId = 'batch-export-delete-startup-race';
  const checkpoint = {
    id: auditId, mode: 'batch', state: 'running', total: 2, currentIndex: 1,
    completedCount: 1, statusCounts: { complete: 1, partial: 0, failed: 0, cancelled: 0 },
    cancelRequested: false, startedAt: '2026-08-28T09:00:00.000Z',
    updatedAt: '2026-08-28T09:01:00.000Z', resumable: false,
  };
  const store = createInMemoryAuditStore();
  await store.commitAudit(auditId, auditFixture(auditId), {
    auditId, mode: 'batch', status: 'running', percent: 50,
  }, { now: '2026-08-28T09:01:00.000Z', deleteAfterCompleteExport: true });
  let releaseInterruptionDecision;
  const interruptionGate = new Promise(resolve => { releaseInterruptionDecision = resolve; });
  let interruptionDecisionEntered = false;
  const auditStore = {
    ...store,
    async markAuditInterrupted(...args) {
      interruptionDecisionEntered = true;
      await interruptionGate;
      return store.markAuditInterrupted(...args);
    },
  };
  const sessionValues = new Map([[auditId, checkpoint]]);
  let activeCheckpoint = checkpoint;
  registerServiceWorker(chromeApi, {
    auditStore,
    sessionStore: {
      async getActiveBatch() { return activeCheckpoint; },
      async set(id, value) { sessionValues.set(id, value); },
      async get(id) { return sessionValues.get(id); },
      async remove(id) {
        sessionValues.delete(id);
        if (activeCheckpoint?.id === id) activeCheckpoint = undefined;
      },
      async clearActiveBatch() { activeCheckpoint = undefined; },
    },
    now: () => '2026-08-28T09:02:00.000Z',
  });
  await waitUntil(() => interruptionDecisionEntered);

  const externalSnapshot = await store.getAuditSnapshot(auditId);
  assert.equal((await store.deleteAudit(auditId, externalSnapshot.capability, {
    now: '2026-08-28T09:02:00.000Z',
  })).deleted, true);
  const message = {
    type: 'EXPORT_COMPLETE', auditId, status: 'complete',
    formats: ['html', 'json', 'csv', 'pdf'], exportRevision: externalSnapshot.revision,
    exportAttempt: 1, leaseOwnerId: 'owner-export-race', localAuditDeleted: true,
  };
  const sender = {
    id: 'test', frameId: 0,
    url: `chrome-extension://test/src/export/index.html?auditId=${auditId}&leaseOwnerId=owner-export-race&exportAttempt=1`,
  };
  let response;
  chromeApi.listeners.message.listener(message, sender, value => { response = value; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(response, undefined);

  releaseInterruptionDecision();
  await waitUntil(() => response !== undefined);
  await waitUntil(() => chromeApi.runtime.sent.some(value => value.type === 'AUDIT_DELETED'));
  assert.deepEqual(response, { ok: true });
  assert.equal(await store.getAudit(auditId), undefined);
  assert.equal(await store.getLatest(), undefined);
  assert.equal(sessionValues.has(auditId), false);
  assert.equal(activeCheckpoint, undefined);
  assert.deepEqual(chromeApi.runtime.sent.filter(value => value.type === 'AUDIT_DELETED'), [{
    type: 'AUDIT_DELETED', auditId, reason: 'complete-export',
  }]);
});

test('restart never recreates latest when deletion wins before its atomic interruption decision', async () => {
  const chromeApi = createChrome();
  const auditId = 'batch-delete-before-interruption-decision';
  const checkpoint = {
    id: auditId, mode: 'batch', state: 'running', total: 2, currentIndex: 1,
    completedCount: 1, statusCounts: { complete: 1, partial: 0, failed: 0, cancelled: 0 },
    cancelRequested: false, startedAt: '2026-08-28T09:00:00.000Z',
    updatedAt: '2026-08-28T09:01:00.000Z', resumable: false,
  };
  const store = createInMemoryAuditStore();
  await store.commitAudit(auditId, auditFixture(auditId), {
    auditId, mode: 'batch', status: 'running', percent: 50,
  }, { now: '2026-08-28T09:01:00.000Z' });
  let releaseInterruptionDecision;
  const interruptionGate = new Promise(resolve => { releaseInterruptionDecision = resolve; });
  let interruptionDecisionEntered = false;
  const auditStore = {
    ...store,
    async markAuditInterrupted(...args) {
      interruptionDecisionEntered = true;
      await interruptionGate;
      return store.markAuditInterrupted(...args);
    },
  };
  let activeCheckpoint = checkpoint;
  registerServiceWorker(chromeApi, {
    auditStore,
    sessionStore: {
      async getActiveBatch() { return activeCheckpoint; },
      async set() {}, async get() {}, async remove() { activeCheckpoint = undefined; },
      async clearActiveBatch() { activeCheckpoint = undefined; },
    },
    now: () => '2026-08-28T09:02:00.000Z',
  });
  await waitUntil(() => interruptionDecisionEntered);
  const deletionSnapshot = await store.getAuditSnapshot(auditId);
  await store.deleteAudit(auditId, deletionSnapshot.capability, {
    now: '2026-08-28T09:02:00.000Z',
  });
  releaseInterruptionDecision();
  await waitUntil(() => activeCheckpoint === undefined);

  assert.equal(await store.getAudit(auditId), undefined);
  assert.equal(await store.getAuditRetention(auditId), undefined);
  assert.equal(await store.getLatest(), undefined);
  assert.deepEqual(await store.getExportDeliveryJournal(auditId), []);
});
