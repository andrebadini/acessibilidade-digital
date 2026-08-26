import { applyReviewDecisions, createReviewDecision } from '../core/review/decisions.js';

export function normalizeReviewAuditId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,160}$/u.test(value) ? value : null;
}

export function isSafeEvidenceImageUrl(value, extensionBaseUrl) {
  if (typeof value !== 'string' || typeof extensionBaseUrl !== 'string') return false;
  if (value.startsWith('data:image/png;base64,')) {
    const encoded = value.slice('data:image/png;base64,'.length);
    if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) return false;
    try {
      const bytes = atob(encoded);
      return bytes.length >= 8
        && bytes.charCodeAt(0) === 0x89
        && bytes.slice(1, 4) === 'PNG'
        && bytes.charCodeAt(4) === 0x0d
        && bytes.charCodeAt(5) === 0x0a
        && bytes.charCodeAt(6) === 0x1a
        && bytes.charCodeAt(7) === 0x0a;
    } catch {
      return false;
    }
  }
  try {
    const own = new URL(extensionBaseUrl);
    const url = new URL(value);
    if (own.protocol !== 'chrome-extension:' || url.protocol !== 'blob:') return false;
    const blobOrigin = new URL(url.pathname);
    return blobOrigin.protocol === own.protocol && blobOrigin.hostname === own.hostname;
  } catch {
    return false;
  }
}

export function getPendingReviewEntries(auditModel) {
  if (!auditModel || !Array.isArray(auditModel.manualReview)) return [];
  return auditModel.manualReview.filter(entry => entry?.status !== 'answered');
}

export function recordReviewDecision(auditModel, input) {
  const decision = createReviewDecision(input);
  return applyReviewDecisions(auditModel, [decision]);
}
