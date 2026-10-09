import assert from 'node:assert/strict';
import test from 'node:test';

import { SAMPLE_AUDIT } from '../../fixtures/audits/sample-audit.js';
import {
  createReportOperations,
  disconnectPanelAuditSessions,
} from '../../src/background/service-worker.js';
import { panelBootstrapStorageKey } from '../../src/background/panel-port.js';
import { createInMemoryAuditStore } from '../../src/storage/audit-store.js';
import { createAuditDeletionCoordinatorV1 } from '../../src/background/audit-deletion-coordinator.js';
import { createHighlightBindingV1 } from '../../src/background/highlight-binding.js';
import { createHighlightBindingStore } from '../../src/background/highlight-binding-store.js';
import { createHighlightController } from '../../src/background/highlight-controller.js';
import { createTargetOperationQueue } from '../../src/background/target-operation-queue.js';

const PANEL_SESSION = 'S'.repeat(22);

async function fixture({ clearOk = true, disconnectOk = true } = {}) {
  const calls = [];
  const now = '2026-08-30T12:00:00.000Z'; const epoch = Date.parse(now);
  const controls = { clearOk, disconnectOk }; const values = {};
  const sessionArea = {
    async get(key) { return key === null ? structuredClone(values) :
      Object.hasOwn(values, key) ? { [key]: structuredClone(values[key]) } : {}; },
    async set(entries) { Object.assign(values, structuredClone(entries)); },
    async remove(key) { for (const name of Array.isArray(key) ? key : [key]) delete values[name]; },
  };
  const auditStore = createInMemoryAuditStore();
  const model = structuredClone(SAMPLE_AUDIT); model.auditId = 'audit-1';
  await auditStore.commitAudit('audit-1', model, { auditId: 'audit-1' }, { now });
  const highlightBindingStore = createHighlightBindingStore({ sessionArea, now: () => epoch });
  for (const [auditId, tabId] of [['audit-1', 7], ['foreign-audit', 8]]) {
    await highlightBindingStore.put(createHighlightBindingV1({ version: 1, auditId, pageId: 'page-1',
      modelRevision: 1, modelHash: 'a'.repeat(64), tabId, windowId: 3,
      topDocumentId: `document-${tabId}`, topUrlEvidence: 'https://example.test/',
      topUrlSessionDigest: `hmac-sha256:${'a'.repeat(43)}`, createdAt: epoch, expiresAt: epoch + 600_000,
      locatorVersion: 'CSSSelectorV1+StructuralSignatureV1', targets: { 'occ-1': { documentId: `document-${tabId}`,
        frameId: 0, backendNodeId: 1, evidenceId: 'ev-1', selector: { syntax: 'CSSSelectorV1', value: 'button', byteLength: 6, complexity: 1 },
        structuralSignature: { version: 'StructuralSignatureV1', sha256: 'b'.repeat(64) }, rectBucket: null } } }));
    assert.equal((await highlightBindingStore.beginOverlay({ version: 1, auditId, occurrenceId: 'occ-1',
      tabId, windowId: 3, topDocumentId: `document-${tabId}`, documentId: `document-${tabId}`, frameId: 0,
      nonce: 'R'.repeat(22), createdAt: epoch, expiresAt: epoch + 600_000, state: 'installing', revision: 1 })).ok, true);
  }
  const highlightController = createHighlightController({ bindingStore: highlightBindingStore, targetQueue: createTargetOperationQueue(),
    chromeApi: { runtime: { id: 'extension-test' }, tabs: { async get(id) { return { id, status: 'complete', discarded: false }; } } },
    chromeAdapter: { async injectHighlight(input) {
      calls.push(['clear-overlay', input.tabId]);
      assert.equal(await auditStore.getAudit('audit-1'), undefined, 'model must already be unavailable before raster-overlay cleanup');
      return controls.clearOk ? { ok: true, nonce: input.command.nonce, documentId: input.documentId, frameId: 0 } : { ok: false };
    } },
    sessionAuthority: { async authorizeSession() { throw new Error('unused'); } },
    modelAuthority: { async loadValidated() { throw new Error('unused'); } },
    liveVerifier: { async verify() { throw new Error('unused'); } }, now: () => epoch,
    randomBytes: length => new Uint8Array(length).fill(1),
  });
  const coordinator = createAuditDeletionCoordinatorV1({ store: auditStore,
    authority: { async clearAudit() { return { ok: true, invalidated: 0 }; }, async finalizeAudit() { return { ok: true, purged: 0 }; } },
    panelPortRegistry: { async clearAudit(auditId) { calls.push(['disconnect-panel', auditId]); return controls.disconnectOk; } },
    reportPortRegistry: { async clearAudit() { return 0; } }, highlightController, highlightBindingStore,
    reportLaunch: { async clearAudit() { return true; } }, exportLaunch: { async clearAudit() { return true; } },
    rawNavigationVault: { async clearAudit() { return 0; } },
    pixelCaptureState: { async readSuspension() { return null; }, async revokeAudit() { throw new Error('unused'); }, async finish() { return true; } },
    ownedDisposableTabStore: { async clearAudit() { return 0; }, async purgeRemovedAudit() { return 0; } },
    blobRegistry: { async clearAudit() { return 0; } }, now: () => now,
  });
  const operations = createReportOperations({
    chromeApi: { runtime: {} }, auditStore, sessionArea,
    modelNow: () => now, highlightController, highlightBindingStore,
    requestAuditDeletion: request => coordinator.request(request),
    async publishHighlightState(value) { calls.push(['publish-highlight', value]); return { delivered: 0 }; },
  });
  const manualAuthorization = scope => ({ version: 1, scope, auditId: scope === 'one' ? 'audit-1' : null, authorizedAt: now });
  return { operations, calls, auditStore, highlightBindingStore, coordinator, controls, manualAuthorization };
}

function reviewFixture({ clearOk = true } = {}) {
  const calls = [];
  let model = structuredClone(SAMPLE_AUDIT);
  let revision = 1;
  const capability = Object.freeze({});
  const bindings = new Set([model.auditId]);
  const auditStore = {
    async getAuditSnapshot(auditId) {
      calls.push(['snapshot-audit', auditId]);
      return auditId === model.auditId ? { model: structuredClone(model), revision, capability } : null;
    },
    async commitAuditReviewIfRevision(auditId, nextModel) {
      calls.push(['commit-review', auditId]);
      model = structuredClone(nextModel);
      revision += 1;
      return { revision };
    },
    async getReportRevision(auditId) {
      calls.push(['report-revision', auditId]);
      return { auditId, modelRevision: revision, modelHash: 'a'.repeat(64), model: structuredClone(model) };
    },
  };
  const highlightController = {
    async clearAudit(auditId, reason) {
      calls.push(['clear-highlight', auditId, reason]);
      return clearOk ? { ok: true, state: 'clear' } : { ok: false, code: 'HIGHLIGHT_CLEANUP_UNCONFIRMED' };
    },
  };
  const highlightBindingStore = {
    async deleteAudit(auditId) { calls.push(['delete-binding', auditId]); bindings.delete(auditId); return true; },
    async refreshAudit(value) { calls.push(['refresh-binding', value]); return 1; },
    async snapshot() {
      const bindingsByAuditPage = Object.create(null);
      for (const auditId of bindings) bindingsByAuditPage[`${auditId}\u0000page-1`] = { auditId };
      return { bindingsByAuditPage, activeOverlayByTab: Object.create(null) };
    },
  };
  const operations = createReportOperations({
    chromeApi: { runtime: { sendMessage(_value, callback) { callback?.(); } } }, auditStore,
    sessionArea: { async get() { return {}; }, async set() {}, async remove() {} },
    modelNow: () => '2026-08-30T12:00:00.000Z', highlightController, highlightBindingStore,
    async disconnectPanelAudit(auditId) { calls.push(['disconnect-panel', auditId]); return true; },
    async publishHighlightState(value) { calls.push(['publish-highlight', value]); return { delivered: 0 }; },
    async scheduleHighlightExpiry() { calls.push(['schedule-expiry']); },
  });
  const review = SAMPLE_AUDIT.manualReview[0];
  return {
    operations, calls,
    decision: {
      auditId: SAMPLE_AUDIT.auditId, itemId: review.itemId, occurrenceId: review.occurrenceId,
      answer: 'não conforme', evaluator: 'Pessoa avaliadora', decidedAt: '2026-08-30T12:00:00.000Z',
      mode: review.mode, note: '',
    },
  };
}

test('delete-one stages data first then clears the real overlay and binding without touching foreign state', async () => {
  const env = await fixture();
  assert.deepEqual(await env.operations.deleteAudit({ auditId: 'audit-1', manualAuthorization: env.manualAuthorization('one') }), {
    ok: true, auditId: 'audit-1', deleted: true, status: 'complete',
  });
  assert.equal(await env.auditStore.getAudit('audit-1'), undefined);
  assert.equal(await env.highlightBindingStore.getActiveOverlay(7), null);
  assert.equal(await env.highlightBindingStore.findTarget({ auditId: 'audit-1', occurrenceId: 'occ-1' }), null);
  assert.notEqual(await env.highlightBindingStore.getActiveOverlay(8), null);
  assert.notEqual(await env.highlightBindingStore.findTarget({ auditId: 'foreign-audit', occurrenceId: 'occ-1' }), null);
  assert.deepEqual(env.calls, [['disconnect-panel', 'audit-1'], ['clear-overlay', 7]]);
});

test('unconfirmed overlay cleanup leaves the staged audit unavailable and its binding recoverable', async () => {
  const env = await fixture({ clearOk: false });
  assert.deepEqual(await env.operations.deleteAudit({ auditId: 'audit-1', manualAuthorization: env.manualAuthorization('one') }), {
    ok: true, auditId: 'audit-1', deleted: true, status: 'pending',
  });
  assert.equal(await env.auditStore.getAudit('audit-1'), undefined);
  assert.equal((await env.highlightBindingStore.getActiveOverlay(7)).state, 'clearing');
  assert.notEqual(await env.highlightBindingStore.findTarget({ auditId: 'audit-1', occurrenceId: 'occ-1' }), null);
  assert.equal((await env.auditStore.listDeletionTombstonesV1({ limit: 25 })).length, 1);
  env.controls.clearOk = true; await env.coordinator.resumePending({ limit: 25 });
  assert.equal(await env.highlightBindingStore.getActiveOverlay(7), null);
  assert.equal(await env.highlightBindingStore.findTarget({ auditId: 'audit-1', occurrenceId: 'occ-1' }), null);
  assert.deepEqual(await env.auditStore.listDeletionTombstonesV1({ limit: 25 }), []);
});

test('unconfirmed panel disconnection leaves a tombstone and does not discard overlay ownership', async () => {
  const env = await fixture({ disconnectOk: false });
  assert.deepEqual(await env.operations.deleteAudit({ auditId: 'audit-1', manualAuthorization: env.manualAuthorization('one') }), {
    ok: true, auditId: 'audit-1', deleted: true, status: 'pending',
  });
  assert.equal(await env.auditStore.getAudit('audit-1'), undefined);
  assert.notEqual(await env.highlightBindingStore.getActiveOverlay(7), null);
  assert.equal(env.calls.some(([name]) => name === 'clear-overlay'), false);
  assert.equal((await env.auditStore.listDeletionTombstonesV1({ limit: 25 })).length, 1);
});

test('disconnects only the exact durable panel bootstrap for the deleted audit', async () => {
  const values = {
    [panelBootstrapStorageKey(9)]: {
      version: 1, kind: 'audit-session', auditId: 'audit-1', sessionCapabilityId: PANEL_SESSION,
      windowId: 9, captureMode: 'no-pixels', createdAt: 1, expiresAt: 10_000, state: 'consumed',
    },
    [panelBootstrapStorageKey(10)]: {
      version: 1, kind: 'audit-session', auditId: 'foreign-audit', sessionCapabilityId: PANEL_SESSION,
      windowId: 10, captureMode: 'no-pixels', createdAt: 1, expiresAt: 10_000, state: 'consumed',
    },
  };
  const sessionArea = {
    async get(keys) {
      if (keys === null) return structuredClone(values);
      const requested = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(requested.filter(key => Object.hasOwn(values, key)).map(key => [key, structuredClone(values[key])]));
    },
  };
  const calls = [];
  const panelCoordinator = {
    async withWindowLock(windowId, callback) {
      return callback({
        async disconnectSession(value) {
          calls.push([windowId, value]);
          delete values[panelBootstrapStorageKey(windowId)];
          return true;
        },
      });
    },
  };

  assert.equal(await disconnectPanelAuditSessions({ auditId: 'audit-1', sessionArea, panelCoordinator }), true);
  assert.deepEqual(calls, [[9, {
    auditId: 'audit-1', sessionCapabilityId: PANEL_SESSION, windowId: 9, reasonCode: 'AUDIT_DELETED',
  }]]);
  assert.equal(Object.hasOwn(values, panelBootstrapStorageKey(9)), false);
  assert.equal(Object.hasOwn(values, panelBootstrapStorageKey(10)), true);
});

test('fails closed on a malformed or unconfirmed target panel bootstrap', async t => {
  await t.test('malformed target', async () => {
    const key = panelBootstrapStorageKey(9);
    const sessionArea = { async get() { return { [key]: { auditId: 'audit-1' } }; } };
    assert.equal(await disconnectPanelAuditSessions({
      auditId: 'audit-1', sessionArea,
      panelCoordinator: { async withWindowLock() { throw new Error('must not run'); } },
    }), false);
  });

  await t.test('disconnect not confirmed', async () => {
    const key = panelBootstrapStorageKey(9);
    const row = {
      version: 1, kind: 'audit-session', auditId: 'audit-1', sessionCapabilityId: PANEL_SESSION,
      windowId: 9, captureMode: 'no-pixels', createdAt: 1, expiresAt: 10_000, state: 'consumed',
    };
    const sessionArea = { async get() { return { [key]: structuredClone(row) }; } };
    assert.equal(await disconnectPanelAuditSessions({
      auditId: 'audit-1', sessionArea,
      panelCoordinator: { async withWindowLock(_windowId, callback) {
        return callback({ async disconnectSession() { return false; } });
      } },
    }), false);
  });
});

test('delete-all clears only inventoried audit highlights and counts unconfirmed cleanup as pending', async () => {
  const success = await fixture();
  assert.deepEqual(await success.operations.deleteAllAudits({ manualAuthorization: success.manualAuthorization('all') }),
    { ok: true, deleted: 1, pending: 0, status: 'complete' });
  assert.equal(await success.highlightBindingStore.getActiveOverlay(7), null);
  assert.notEqual(await success.highlightBindingStore.getActiveOverlay(8), null);
  const pending = await fixture({ clearOk: false });
  assert.deepEqual(await pending.operations.deleteAllAudits({ manualAuthorization: pending.manualAuthorization('all') }),
    { ok: true, deleted: 1, pending: 1, status: 'pending' });
  assert.equal(await pending.auditStore.getAudit('audit-1'), undefined);
  assert.notEqual(await pending.highlightBindingStore.findTarget({ auditId: 'audit-1', occurrenceId: 'occ-1' }), null);
  assert.notEqual(await pending.highlightBindingStore.getActiveOverlay(8), null);
});

test('review commit keeps live highlight usable: no overlay cleanup gate, bindings follow the new model identity', async () => {
  // Revisão guiada (1.1.56): cada resposta apagava as provas de destaque e exigia limpar o destaque
  // ativo antes de gravar. "Mostrar na página" parava depois da primeira resposta e, se a página
  // auditada tivesse mudado, a própria resposta era recusada.
  for (const clearOk of [true, false]) {
    const env = reviewFixture({ clearOk });
    const result = await env.operations.commitReviewDecision(env.decision);
    assert.equal(result.ok, true);
    const names = env.calls.map(([name]) => name);
    assert.equal(names.includes('clear-highlight'), false);
    assert.equal(names.includes('delete-binding'), false);
    assert.equal(names.includes('publish-highlight'), false);
    assert.equal(names.indexOf('commit-review') < names.indexOf('refresh-binding'), true);
    assert.deepEqual(env.calls.find(([name]) => name === 'refresh-binding')[1], {
      auditId: SAMPLE_AUDIT.auditId, fromModelHash: SAMPLE_AUDIT.integrity.canonicalModelHash,
      modelRevision: result.modelRevision, modelHash: result.modelHash,
    });
    assert.equal(names.at(-1) === 'schedule-expiry' || names.includes('schedule-expiry'), true);
  }
});

test('a guided review answer commits all its decisions in one sealed revision and keeps highlight proofs', async () => {
  const { enrichAuditForReport } = await import('../../src/core/report/enrich-audit.js');
  const { createInstalledCoreRuleInventory } = await import('../../src/core/rules/core-rule-inventory.js');
  const auditId = 'audit-batch';
  const draft = structuredClone(SAMPLE_AUDIT);
  draft.auditId = auditId;
  draft.integrity.canonicalModelHash = 'pending';
  draft.integrity.evidenceManifestHash = 'pending';
  const model = await enrichAuditForReport(draft, {
    now: () => '2026-08-29T12:00:00.000Z', timezone: 'America/Cuiaba',
    manifestVersion: '1.1.56', rulesVersion: '1.0.0', browserVersion: 'Chrome/152.0.0.0',
  });
  const inventory = await createInstalledCoreRuleInventory();
  const checkpoint = { version: 1, auditId, pages: model.pages.map(page => ({
    pageId: page.pageId, attempted: page.attempted, startedAt: page.attempted ? page.timestamps.startedAt : null,
    rulesVersion: inventory.rulesVersion, inventoryVersion: inventory.inventoryVersion, inventoryHash: inventory.sha256, outcomes: [],
  })) };
  const auditStore = createInMemoryAuditStore();
  await auditStore.commitAuditWithCheckpointIfAbsent(auditId, model, checkpoint, {
    version: 1, auditId, status: model.session.status, percent: 100, message: 'Avaliação concluída com limitações.',
    failureCode: null, modelRevision: 1, updatedAt: '2026-08-29T12:00:00.000Z',
  }, { now: '2026-08-29T12:00:00.000Z', deleteAfterCompleteExport: false });
  const calls = [];
  const operations = createReportOperations({
    chromeApi: { runtime: { sendMessage(value, callback) { calls.push(['sent', value.type]); callback?.(); } } }, auditStore,
    sessionArea: { async get() { return {}; }, async set() {}, async remove() {} }, modelNow: () => '2026-08-29T12:05:00.000Z',
    highlightController: { async clearAudit() { calls.push(['clear-highlight']); return { ok: true, state: 'clear' }; } },
    highlightBindingStore: { async refreshAudit(value) { calls.push(['refresh-binding', value]); return 1; } },
    async publishHighlightState() { calls.push(['publish']); return { delivered: 0 }; },
  });
  const entries = model.manualReview.slice(0, 2).map(entry => ({
    itemId: entry.itemId, occurrenceId: entry.occurrenceId, answer: 'conforme', mode: entry.mode, note: '', revise: false,
  }));
  const result = await operations.commitReviewBatch({
    auditId, evaluator: 'Pessoa avaliadora', decidedAt: '2026-08-29T12:05:00.000Z', entries,
  });
  assert.deepEqual(Object.keys(result), ['ok', 'auditId', 'count', 'modelRevision', 'modelHash']);
  assert.equal(result.ok, true);
  assert.equal(result.count, entries.length);
  assert.equal(result.modelRevision, 2, 'uma revisão para a resposta inteira');
  const report = await auditStore.getReportRevision(auditId);
  assert.equal(report.modelHash, result.modelHash);
  assert.deepEqual(report.model.reviewDecisions.map(value => value.occurrenceId), entries.map(value => value.occurrenceId));
  assert.deepEqual(calls.find(([name]) => name === 'refresh-binding')[1], {
    auditId, fromModelHash: model.integrity.canonicalModelHash, modelRevision: 2, modelHash: result.modelHash,
  });
  assert.equal(calls.some(([name]) => ['clear-highlight', 'publish'].includes(name)), false);
  // Um lote com ocorrência repetida ou de outra auditoria não grava nada.
  assert.equal((await operations.commitReviewBatch({ auditId, evaluator: 'Pessoa avaliadora',
    decidedAt: '2026-08-29T12:06:00.000Z', entries: [entries[0], entries[0]] })).ok, false);
  assert.equal((await auditStore.getReportRevision(auditId)).modelRevision, 2);
});
