import assert from 'node:assert/strict';
import test from 'node:test';

import { SAMPLE_AUDIT } from '../../fixtures/audits/sample-audit.js';
import { createReportOperations } from '../../src/background/service-worker.js';

function fixture({ clearOk = true } = {}) {
  const calls = [];
  const bindings = new Set(['audit-1']);
  const sessionArea = {
    async get() { return {}; },
    async set() {},
    async remove() {},
  };
  const auditStore = {
    async getAuditSnapshot(auditId) {
      calls.push(['snapshot-audit', auditId]);
      return { model: { auditId }, capability: Object.freeze({}) };
    },
    async deleteAudit(auditId) { calls.push(['delete-audit', auditId]); return { deleted: true }; },
    async deleteAllAudits() { calls.push(['delete-all']); return { deleted: 1 }; },
  };
  const highlightController = {
    async clearAudit(auditId) {
      calls.push(['clear-highlight', auditId]);
      return clearOk ? { ok: true, state: 'clear' } : { ok: false, code: 'HIGHLIGHT_CLEANUP_UNCONFIRMED' };
    },
  };
  const highlightBindingStore = {
    async deleteAudit(auditId) { calls.push(['delete-binding', auditId]); bindings.delete(auditId); return true; },
    async snapshot() {
      const bindingsByAuditPage = Object.create(null);
      for (const auditId of bindings) bindingsByAuditPage[`${auditId}\u0000page-1`] = { auditId };
      return { bindingsByAuditPage, activeOverlayByTab: Object.create(null) };
    },
  };
  const operations = createReportOperations({
    chromeApi: { runtime: {} }, auditStore, sessionArea,
    modelNow: () => '2026-08-30T12:00:00.000Z', highlightController, highlightBindingStore,
    async publishHighlightState(value) { calls.push(['publish-highlight', value]); return { delivered: 0 }; },
  });
  return { operations, calls };
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
    async publishHighlightState(value) { calls.push(['publish-highlight', value]); return { delivered: 0 }; },
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

test('delete-one clears the real overlay and binding before deleting the audit', async () => {
  const { operations, calls } = fixture();
  assert.deepEqual(await operations.deleteAudit({ auditId: 'audit-1' }), {
    ok: true, auditId: 'audit-1', deleted: true,
  });
  assert.deepEqual(calls.slice(0, 5).map(([name, value]) => name === 'publish-highlight'
    ? [name, value.state]
    : [name, value]), [
    ['snapshot-audit', 'audit-1'], ['clear-highlight', 'audit-1'],
    ['delete-binding', 'audit-1'], ['publish-highlight', 'clear'], ['delete-audit', 'audit-1'],
  ]);
});

test('delete-one fails closed before audit deletion when overlay cleanup is unconfirmed', async () => {
  const { operations, calls } = fixture({ clearOk: false });
  assert.deepEqual(await operations.deleteAudit({ auditId: 'audit-1' }), {
    ok: false, code: 'REPORT_OPERATION_FAILED',
  });
  assert.equal(calls.some(([name]) => name === 'delete-audit'), false);
  assert.equal(calls.some(([name]) => name === 'delete-binding'), false);
});

test('delete-all clears every highlight binding first and fails closed on unconfirmed cleanup', async () => {
  const success = fixture();
  assert.deepEqual(await success.operations.deleteAllAudits(), { ok: true, deleted: 1 });
  assert.deepEqual(success.calls.slice(0, 4).map(([name, value]) => name === 'publish-highlight'
    ? [name, value.state]
    : [name, value]), [
    ['clear-highlight', 'audit-1'], ['delete-binding', 'audit-1'], ['publish-highlight', 'clear'], ['delete-all', undefined],
  ]);

  const denied = fixture({ clearOk: false });
  assert.deepEqual(await denied.operations.deleteAllAudits(), { ok: false, code: 'REPORT_OPERATION_FAILED' });
  assert.equal(denied.calls.some(([name]) => name === 'delete-all'), false);
});

test('review commit confirms overlay and binding invalidation before changing the model identity', async () => {
  const success = reviewFixture();
  const result = await success.operations.commitReviewDecision(success.decision);
  assert.equal(result.ok, true);
  const names = success.calls.map(([name]) => name);
  assert.equal(names.indexOf('clear-highlight') < names.indexOf('commit-review'), true);
  assert.equal(names.indexOf('delete-binding') < names.indexOf('commit-review'), true);
  assert.deepEqual(success.calls.find(([name]) => name === 'publish-highlight')[1], {
    version: 1, type: 'HIGHLIGHT_STATE_CHANGED', auditId: SAMPLE_AUDIT.auditId,
    occurrenceId: null, state: 'clear',
  });

  const denied = reviewFixture({ clearOk: false });
  assert.deepEqual(await denied.operations.commitReviewDecision(denied.decision), {
    ok: false, code: 'REPORT_OPERATION_FAILED',
  });
  assert.equal(denied.calls.some(([name]) => name === 'commit-review'), false);
  assert.equal(denied.calls.some(([name]) => name === 'delete-binding'), false);
});
