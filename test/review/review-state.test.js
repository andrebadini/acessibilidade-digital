import assert from 'node:assert/strict';
import test from 'node:test';

import { commitReviewDecision, getPendingReviewEntries, isSafeEvidenceImageUrl, normalizeReviewAuditId, recordReviewDecision } from '../../src/review/review-state.js';

function reviewModel() {
  const evidence = Object.freeze({ artifacts: Object.freeze([]) });
  return Object.freeze({
    auditId: 'audit-1', evidence, reproducibility: Object.freeze({ evidenceHash: 'same' }),
    ruleResults: Object.freeze([Object.freeze({ ruleId: 'r', outcome: 'cantTell', mode: 'assisted', nbrItems: Object.freeze(['5.1.1']) })]),
    itemResults: Object.freeze([Object.freeze({ id: '5.1.1', outcome: 'cantTell', evaluation: 'assisted' })]),
    occurrences: Object.freeze([Object.freeze({ occurrenceId: 'occ-1', itemId: '5.1.1', ruleId: 'r', outcome: 'cantTell', evidenceIds: Object.freeze([]) })]),
    manualReview: Object.freeze([Object.freeze({ occurrenceId: 'occ-1', itemId: '5.1.1', status: 'unanswered' })]),
    reviewDecisions: Object.freeze([]),
  });
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
    auditId: 'audit-1', itemId: '5.1.1', occurrenceId: 'occ-1', answer: 'conforme',
    evaluator: 'Fiscal', decidedAt: '2026-08-26T14:00:00.000Z', mode: 'assisted',
  });
  assert.equal(reviewed.itemResults[0].outcome, 'passed');
  assert.equal(reviewed.manualReview[0].status, 'answered');
  assert.equal(reviewed.reviewDecisions.length, 1);
  assert.notStrictEqual(reviewed.evidence, evidence);
  assert.deepEqual(reviewed.evidence, evidence);
  assert.deepEqual(getPendingReviewEntries(reviewed), []);
});

test('keeps a failed decision persistence retryable and publishes the model only after storage succeeds', async () => {
  const original = reviewModel();
  const input = {
    auditId: 'audit-1', itemId: '5.1.1', occurrenceId: 'occ-1',
    answer: 'conforme', evaluator: 'Pessoa avaliadora', decidedAt: '2026-08-26T16:00:00.000Z', mode: 'assisted',
  };
  let attempts = 0;
  const store = {
    async setAudit(auditId, next) {
      attempts += 1;
      assert.equal(auditId, 'audit-1');
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
