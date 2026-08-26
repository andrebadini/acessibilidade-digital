import assert from 'node:assert/strict';
import test from 'node:test';

import { getPendingReviewEntries, normalizeReviewAuditId, recordReviewDecision } from '../../src/review/review-state.js';

test('accepts only bounded inert audit IDs from query or persisted state', () => {
  assert.equal(normalizeReviewAuditId('audit-1:part.2'), 'audit-1:part.2');
  for (const value of ['', '../audit', 'audit?x=1', '<script>', 'a'.repeat(161), null]) assert.equal(normalizeReviewAuditId(value), null);
});

test('records a decision by applying conservative review aggregation to the stored model', () => {
  const evidence = Object.freeze({ artifacts: Object.freeze([]) });
  const model = Object.freeze({
    auditId: 'audit-1', evidence, reproducibility: Object.freeze({ evidenceHash: 'same' }),
    ruleResults: Object.freeze([Object.freeze({ ruleId: 'r', outcome: 'cantTell', mode: 'assisted', nbrItems: Object.freeze(['5.1.1']) })]),
    itemResults: Object.freeze([Object.freeze({ id: '5.1.1', outcome: 'cantTell', evaluation: 'assisted' })]),
    occurrences: Object.freeze([Object.freeze({ occurrenceId: 'occ-1', itemId: '5.1.1', ruleId: 'r', outcome: 'cantTell', evidenceIds: Object.freeze([]) })]),
    manualReview: Object.freeze([Object.freeze({ occurrenceId: 'occ-1', itemId: '5.1.1', status: 'unanswered' })]),
    reviewDecisions: Object.freeze([]),
  });
  const reviewed = recordReviewDecision(model, {
    auditId: 'audit-1', itemId: '5.1.1', occurrenceId: 'occ-1', answer: 'conforme',
    evaluator: 'Fiscal', decidedAt: '2026-08-26T14:00:00Z', mode: 'assisted',
  });
  assert.equal(reviewed.itemResults[0].outcome, 'passed');
  assert.equal(reviewed.manualReview[0].status, 'answered');
  assert.equal(reviewed.reviewDecisions.length, 1);
  assert.strictEqual(reviewed.evidence, evidence);
  assert.deepEqual(getPendingReviewEntries(reviewed), []);
});
