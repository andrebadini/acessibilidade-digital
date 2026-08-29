import assert from 'node:assert/strict';
import test from 'node:test';

import { SAMPLE_AUDIT } from '../../fixtures/audits/sample-audit.js';
import { createAuditModel } from '../../src/core/report/audit-model.js';
import { commitReviewDecision, createReviewDecisionCommitter, getPendingReviewEntries, isSafeEvidenceImageUrl, normalizeReviewAuditId, recordReviewDecision } from '../../src/review/review-state.js';
import { createInMemoryAuditStore } from '../../src/storage/audit-store.js';

const FIRST_REVIEW = SAMPLE_AUDIT.manualReview[0];
const SECOND_REVIEW = SAMPLE_AUDIT.manualReview[1];

function reviewModel() {
  return structuredClone(SAMPLE_AUDIT);
}

function reviewInput(occurrenceId = FIRST_REVIEW.occurrenceId, answer = 'conforme') {
  const queue = SAMPLE_AUDIT.manualReview.find(entry => entry.occurrenceId === occurrenceId);
  if (!queue) throw new TypeError('Fixture de revisão desconhecida.');
  return {
    auditId: SAMPLE_AUDIT.auditId, itemId: queue.itemId, occurrenceId, answer,
    evaluator: 'Pessoa avaliadora', decidedAt: '2026-08-26T16:00:00.000Z', mode: queue.mode,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test('allows only valid PNG data or same-extension blob evidence images', () => {
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';
  const base = 'chrome-extension://test/';
  assert.equal(isSafeEvidenceImageUrl(png, base), true);
  assert.equal(isSafeEvidenceImageUrl('blob:chrome-extension://test/uuid', base), true);
  for (const value of [
    'https://example.test/evidence.png', 'javascript:alert(1)',
    'data:image/svg+xml,<svg onload=alert(1)>', 'data:text/html,<script>alert(1)</script>',
    'data:image/png;base64,SGVsbG8=', 'blob:chrome-extension://other/uuid',
  ]) assert.equal(isSafeEvidenceImageUrl(value, base), false, value);
});

test('accepts only bounded inert audit IDs from query or persisted state', () => {
  assert.equal(normalizeReviewAuditId('audit-1:part.2'), 'audit-1:part.2');
  for (const value of ['', '../audit', 'audit?x=1', '<script>', 'a'.repeat(161), null]) assert.equal(normalizeReviewAuditId(value), null);
});

test('records a decision by applying conservative review aggregation to the stored model', () => {
  const model = reviewModel();
  const { evidence } = model;
  const reviewed = recordReviewDecision(model, {
    ...reviewInput(), evaluator: 'Fiscal', decidedAt: '2026-08-26T16:00:00.000Z',
  });
  assert.equal(reviewed.itemResults.find(item => item.id === FIRST_REVIEW.itemId).outcome, 'passed');
  assert.equal(reviewed.manualReview[0].status, 'answered');
  assert.equal(reviewed.reviewDecisions.length, 1);
  assert.notStrictEqual(reviewed.evidence, evidence);
  assert.deepEqual(reviewed.evidence, evidence);
  assert.deepEqual(getPendingReviewEntries(reviewed).map(entry => entry.occurrenceId), [SECOND_REVIEW.occurrenceId]);
  assert.doesNotThrow(() => createAuditModel(reviewed));
});

test('rejects a noncanonical reviewed model before any persistence call', async () => {
  const invalid = reviewModel();
  const marker = 'PRIVATE_INVALID_NORMATIVE_EDITION';
  invalid.normative.edition = marker;
  let writes = 0;

  await assert.rejects(
    commitReviewDecision(invalid, reviewInput(), {
      async setAudit() {
        writes += 1;
      },
    }),
    error => {
      assert.equal(error?.code, 'AUDIT_MODEL_INPUT_INVALID');
      assert.doesNotMatch(String(error?.message), new RegExp(marker));
      return true;
    },
  );
  assert.equal(writes, 0);
});

test('keeps a failed decision persistence retryable and publishes the model only after storage succeeds', async () => {
  const original = reviewModel();
  const input = reviewInput();
  let attempts = 0;
  const store = {
    async setAudit(auditId, next) {
      attempts += 1;
      assert.equal(auditId, SAMPLE_AUDIT.auditId);
      assert.equal(next.reviewDecisions.length, 1);
      if (attempts === 1) throw new Error('IDB indisponível');
    },
  };

  await assert.rejects(commitReviewDecision(original, input, store), /IDB indisponível/);
  assert.equal(original.reviewDecisions.length, 0);
  const committed = await commitReviewDecision(original, input, store);
  assert.equal(attempts, 2);
  assert.equal(committed.reviewDecisions.length, 1);
  assert.equal(original.reviewDecisions.length, 0);
});

test('merges decisions from two stale review tabs through revision CAS without losing either answer', async () => {
  const initial = reviewModel();
  const store = createInMemoryAuditStore();
  await store.setAudit(initial.auditId, initial);

  await commitReviewDecision(initial, reviewInput(FIRST_REVIEW.occurrenceId), store);
  await commitReviewDecision(initial, reviewInput(SECOND_REVIEW.occurrenceId), store);

  const stored = await store.getAudit(initial.auditId);
  assert.deepEqual(stored.reviewDecisions.map(decision => decision.occurrenceId), [FIRST_REVIEW.occurrenceId, SECOND_REVIEW.occurrenceId]);
  assert.equal(stored.manualReview.every(entry => entry.status === 'answered'), true);
});

test('returns the exact committed review revision for a correlated live panel refresh', async () => {
  const initial = reviewModel();
  const store = createInMemoryAuditStore();
  await store.setAudit(initial.auditId, initial);
  await store.setLatest({
    auditId: initial.auditId, exportStatus: 'complete', exportRevision: 1,
    exportAttempt: 1, leaseOwnerId: 'owner-complete',
  });
  const commit = createReviewDecisionCommitter();
  const committed = await commit({ auditModel: initial, input: reviewInput(), store });

  assert.equal(committed.status, 'committed');
  assert.equal(committed.exportRevision, 2);
  const latest = await store.getLatest();
  assert.equal(latest.exportRevision, committed.exportRevision);
  assert.equal(latest.exportStatus, 'preparing');
  assert.equal(Object.hasOwn(latest, 'exportAttempt'), false);
  assert.equal(Object.hasOwn(latest, 'leaseOwnerId'), false);
});

test('a review after delivery reservation preserves the prepared model and atomically revokes its lease marker', async () => {
  const initial = reviewModel();
  const store = createInMemoryAuditStore();
  await store.setAudit(initial.auditId, initial);
  const snapshot = await store.getAuditSnapshot(initial.auditId);
  await store.acquireExportLease(initial.auditId, snapshot.capability, {
    ownerId: 'owner-review-race', now: '2026-08-27T10:00:00.000Z',
    latestState: {
      auditId: initial.auditId,
      exportStatus: 'queued',
      exportRevision: snapshot.revision,
      leaseOwnerId: 'owner-review-race',
    },
  });
  await store.claimExportLease(initial.auditId, snapshot.capability, {
    ownerId: 'owner-review-race', now: '2026-08-27T10:00:00.100Z',
    latestState: {
      auditId: initial.auditId,
      exportStatus: 'running',
      exportRevision: snapshot.revision,
      leaseOwnerId: 'owner-review-race',
    },
  });
  const reservedModel = structuredClone(initial);
  const reservedSnippet = '<button id="continuar" aria-label="Continuar">Prosseguir</button>';
  reservedModel.evidence.find(artifact => artifact.evidenceId === 'ev-control').snippet = reservedSnippet;
  const reservation = await store.commitAuditIfRevisionWithExportLease(
    initial.auditId,
    reservedModel,
    {
      auditId: initial.auditId,
      exportStatus: 'delivering',
      exportRevision: snapshot.revision + 1,
      leaseOwnerId: 'owner-review-race',
    },
    snapshot.capability,
    { ownerId: 'owner-review-race', now: '2026-08-27T10:00:00.200Z', phase: 'delivering' },
  );

  const reviewed = await commitReviewDecision(initial, reviewInput(), store);
  const stored = await store.getAudit(initial.auditId);
  const latest = await store.getLatest();
  assert.equal(stored.evidence.find(artifact => artifact.evidenceId === 'ev-control').snippet, reservedSnippet);
  assert.equal(stored.reviewDecisions.length, 1);
  assert.equal(reviewed.evidence.find(artifact => artifact.evidenceId === 'ev-control').snippet, reservedSnippet);
  assert.equal((await store.getAuditSnapshot(initial.auditId)).revision, reservation.revision + 1);
  assert.deepEqual(await store.getExportLeaseState(initial.auditId, {
    now: '2026-08-27T10:00:00.300Z',
  }), { active: false, revision: reservation.revision + 1 });
  assert.equal(latest.exportStatus, 'preparing');
  assert.equal(latest.exportRevision, reservation.revision + 1);
  assert.equal(Object.hasOwn(latest, 'leaseOwnerId'), false);
});

test('locks every card control synchronously and deduplicates contradictory concurrent decisions', async () => {
  const original = reviewModel();
  const pendingWrite = deferred();
  const controls = [{ disabled: false }, { disabled: false }, { disabled: false }, { disabled: false }];
  const duplicateControls = [{ disabled: false }];
  const pendingStates = [];
  let writes = 0;
  const commit = createReviewDecisionCommitter();
  const store = { setAudit: async () => { writes += 1; return pendingWrite.promise; } };

  const first = commit({
    auditModel: original, input: reviewInput(FIRST_REVIEW.occurrenceId, 'conforme'), store, controls,
    onPendingChange: pending => pendingStates.push(pending),
  });
  assert.deepEqual(controls.map(control => control.disabled), [true, true, true, true]);
  const duplicate = await commit({
    auditModel: original, input: reviewInput(FIRST_REVIEW.occurrenceId, 'não conforme'), store, controls: duplicateControls,
  });
  assert.deepEqual(duplicate, { status: 'duplicate', model: original });
  assert.equal(duplicateControls[0].disabled, false);
  assert.equal(writes, 1);

  pendingWrite.resolve();
  const committed = await first;
  assert.equal(committed.status, 'committed');
  assert.equal(committed.model.reviewDecisions[0].answer, 'conforme');
  assert.deepEqual(controls.map(control => control.disabled), [true, true, true, true]);
  assert.deepEqual(pendingStates, [true]);
});

test('serializes independent occurrences against the latest committed model without losing a decision', async () => {
  const original = reviewModel();
  const firstWrite = deferred();
  const secondWrite = deferred();
  const firstControls = [{ disabled: false }, { disabled: false }];
  const independentControls = [{ disabled: false }];
  const persisted = [];
  let writes = 0;
  const commit = createReviewDecisionCommitter();
  const store = {
    setAudit: async (_auditId, model) => {
      writes += 1;
      persisted.push(model);
      return writes === 1 ? firstWrite.promise : secondWrite.promise;
    },
  };

  const first = commit({
    auditModel: original, input: reviewInput(FIRST_REVIEW.occurrenceId), store, controls: firstControls,
  });
  const independent = commit({
    auditModel: original, input: reviewInput(SECOND_REVIEW.occurrenceId), store, controls: independentControls,
  });
  assert.equal(writes, 1);
  assert.equal(firstControls.every(control => control.disabled), true);
  assert.equal(independentControls.every(control => control.disabled), true);

  firstWrite.resolve();
  assert.equal((await first).model.reviewDecisions.length, 1);
  await Promise.resolve();
  assert.equal(writes, 2);
  secondWrite.resolve();
  const committed = await independent;
  assert.equal(committed.model.reviewDecisions.length, 2);
  assert.deepEqual(committed.model.reviewDecisions.map(decision => decision.occurrenceId), [FIRST_REVIEW.occurrenceId, SECOND_REVIEW.occurrenceId]);
  assert.equal(persisted[0].reviewDecisions.length, 1);
  assert.equal(persisted[1].reviewDecisions.length, 2);
});

test('unlocks and focuses a failed card so the same occurrence can retry', async () => {
  const original = reviewModel();
  const firstWrite = deferred();
  const retryControls = [{ disabled: false }, { disabled: false }];
  const retryFocus = { calls: 0, focus() { this.calls += 1; } };
  const pendingStates = [];
  let writes = 0;
  const commit = createReviewDecisionCommitter();
  const store = { setAudit: async () => { writes += 1; return firstWrite.promise; } };

  const failed = commit({
    auditModel: original, input: reviewInput(FIRST_REVIEW.occurrenceId), store, controls: retryControls, retryFocus,
    onPendingChange: pending => pendingStates.push(pending),
  });
  assert.equal(writes, 1);
  assert.equal(retryControls.every(control => control.disabled), true);
  firstWrite.reject(new Error('IDB indisponível'));
  await assert.rejects(failed, /IDB indisponível/);
  assert.equal(retryControls.every(control => control.disabled === false), true);
  assert.equal(retryFocus.calls, 1);
  assert.deepEqual(pendingStates, [true, false]);

  const retryWrite = deferred();
  store.setAudit = async () => { writes += 1; return retryWrite.promise; };
  const retry = commit({ auditModel: original, input: reviewInput(FIRST_REVIEW.occurrenceId), store, controls: retryControls });
  await Promise.resolve();
  assert.equal(writes, 2);
  assert.equal(retryControls.every(control => control.disabled), true);
  retryWrite.resolve();
  assert.equal((await retry).status, 'committed');
});
