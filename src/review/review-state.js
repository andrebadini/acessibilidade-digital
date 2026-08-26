import { applyReviewDecisions, createReviewDecision } from '../core/review/decisions.js';

export function normalizeReviewAuditId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,160}$/u.test(value) ? value : null;
}

export function getPendingReviewEntries(auditModel) {
  if (!auditModel || !Array.isArray(auditModel.manualReview)) return [];
  return auditModel.manualReview.filter(entry => entry?.status !== 'answered');
}

export function recordReviewDecision(auditModel, input) {
  const decision = createReviewDecision(input);
  return applyReviewDecisions(auditModel, [decision]);
}
