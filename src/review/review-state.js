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

export async function commitReviewDecision(auditModel, input, store) {
  if (!store || typeof store.setAudit !== 'function') throw new TypeError('Store de auditoria inválido.');
  const nextModel = recordReviewDecision(auditModel, input);
  await store.setAudit(nextModel.auditId, nextModel);
  return nextModel;
}

/** Creates an occurrence-scoped UI gate with serialized persistence per audit. */
export function createReviewDecisionCommitter() {
  const pendingOccurrences = new Set();
  const auditQueues = new Map();
  return async function commitOnce({ auditModel, input, store, controls = [], retryFocus, onPendingChange } = {}) {
    const occurrenceId = typeof input?.occurrenceId === 'string' ? input.occurrenceId : '';
    const auditId = typeof input?.auditId === 'string' ? input.auditId : auditModel?.auditId;
    const pendingKey = `${auditId}\u0000${occurrenceId}`;
    if (pendingOccurrences.has(pendingKey)) return { status: 'duplicate', model: auditModel };
    pendingOccurrences.add(pendingKey);
    const cardControls = Array.from(controls).filter(control => control && typeof control === 'object');
    for (const control of cardControls) control.disabled = true;
    const queue = auditQueues.get(auditId) || { tail: null, confirmedModel: null };
    auditQueues.set(auditId, queue);
    const persist = async () => {
      const model = await commitReviewDecision(queue.confirmedModel || auditModel, input, store);
      queue.confirmedModel = model;
      return model;
    };
    const operation = queue.tail ? queue.tail.then(persist) : persist();
    const tail = operation.then(() => undefined, () => undefined);
    queue.tail = tail;
    try {
      try { onPendingChange?.(true); } catch { /* UI notification must not affect persistence. */ }
      const model = await operation;
      return { status: 'committed', model };
    } catch (error) {
      for (const control of cardControls) control.disabled = false;
      try { onPendingChange?.(false); } catch { /* UI notification must not mask the storage error. */ }
      try { retryFocus?.focus?.(); } catch { /* Focus recovery is best effort. */ }
      throw error;
    } finally {
      pendingOccurrences.delete(pendingKey);
      if (queue.tail === tail) queue.tail = null;
    }
  };
}
