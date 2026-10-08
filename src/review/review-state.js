import { applyReviewDecisions, createReviewDecision } from '../core/review/decisions.js';
import { createAuditModel } from '../core/report/audit-model.js';

const REVIEW_COMMIT_REVISIONS = new WeakMap();

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
  return createAuditModel(applyReviewDecisions(auditModel, [decision]));
}

export async function commitReviewDecision(auditModel, input, store) {
  if (!store || typeof store.setAudit !== 'function') throw new TypeError('Store de auditoria inválido.');
  if (typeof store.getAuditSnapshot === 'function' && typeof store.commitAuditReviewIfRevision === 'function') {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const snapshot = await store.getAuditSnapshot(auditModel?.auditId);
      if (!snapshot?.model || snapshot.model.auditId !== auditModel?.auditId || !snapshot.capability) {
        throw new TypeError('Snapshot atual da auditoria inválido para revisão.');
      }
      const nextModel = recordReviewDecision(snapshot.model, input);
      try {
        const committed = await store.commitAuditReviewIfRevision(nextModel.auditId, nextModel, snapshot.capability);
        rememberReviewRevision(nextModel, committed);
        return nextModel;
      } catch (error) {
        if (error?.code === 'AUDIT_REVISION_CONFLICT') continue;
        throw error;
      }
    }
    throw new Error('A auditoria mudou repetidamente durante a revisão; tente salvar a decisão novamente.');
  }
  const nextModel = recordReviewDecision(auditModel, input);
  const committed = await store.setAudit(nextModel.auditId, nextModel);
  rememberReviewRevision(nextModel, committed);
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
      const exportRevision = REVIEW_COMMIT_REVISIONS.get(model);
      return {
        status: 'committed', model,
        ...(Number.isSafeInteger(exportRevision) && exportRevision >= 0 ? { exportRevision } : {}),
      };
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

function ownData(value, key) {
  try {
    const descriptor = value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, key) : null;
    return descriptor?.enumerable === true && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  } catch { return undefined; }
}

function exactCommitReceipt(value, decision) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return null;
    const keys = Reflect.ownKeys(value);
    const expected = ['ok', 'auditId', 'occurrenceId', 'modelRevision', 'modelHash'];
    if (keys.length !== expected.length || keys.some(key => typeof key !== 'string' || !expected.includes(key))) return null;
    const receipt = Object.fromEntries(expected.map(key => [key, ownData(value, key)]));
    return receipt.ok === true && receipt.auditId === decision.auditId &&
      receipt.occurrenceId === decision.occurrenceId &&
      Number.isSafeInteger(receipt.modelRevision) && receipt.modelRevision >= 1 &&
      typeof receipt.modelHash === 'string' && /^[a-f0-9]{64}$/u.test(receipt.modelHash)
      ? receipt : null;
  } catch { return null; }
}

function sameReviewDecision(current, expected) {
  if (!current || typeof current !== 'object') return false;
  return current.decisionId === expected.decisionId && current.auditId === expected.auditId &&
    current.itemId === expected.itemId && current.occurrenceId === expected.occurrenceId &&
    current.answer === expected.answer && current.evaluator === expected.evaluator &&
    current.decidedAt === expected.decidedAt && current.mode === expected.mode &&
    (current.note ?? '') === (expected.note ?? '');
}

function verifiedCommittedRevision(value, receipt, decision) {
  try {
    const auditId = ownData(value, 'auditId');
    const modelRevision = ownData(value, 'modelRevision');
    const modelHash = ownData(value, 'modelHash');
    const model = createAuditModel(ownData(value, 'model'));
    if (auditId !== decision.auditId || model.auditId !== decision.auditId ||
      modelRevision !== receipt.modelRevision || modelHash !== receipt.modelHash ||
      !Array.isArray(model.reviewDecisions) ||
      !model.reviewDecisions.some(current => sameReviewDecision(current, decision))) return null;
    return { model, modelRevision, modelHash };
  } catch { return null; }
}

/** Serializes UI requests while keeping the only review write behind worker authorization. */
export function createAuthorizedReviewDecisionCommitter() {
  const pendingOccurrences = new Set();
  const auditQueues = new Map();
  return async function commitOnce({
    auditModel, input, requestCommit, loadReportRevision,
    controls = [], retryFocus, onPendingChange,
  } = {}) {
    const decision = createReviewDecision(input);
    const pendingKey = `${decision.auditId}\u0000${decision.occurrenceId}`;
    if (pendingOccurrences.has(pendingKey)) return { status: 'duplicate', model: auditModel };
    pendingOccurrences.add(pendingKey);
    const cardControls = Array.from(controls).filter(control => control && typeof control === 'object');
    for (const control of cardControls) control.disabled = true;
    const queue = auditQueues.get(decision.auditId) || { tail: null };
    auditQueues.set(decision.auditId, queue);
    const persist = async () => {
      if (typeof requestCommit !== 'function' || typeof loadReportRevision !== 'function') {
        throw new TypeError('Canal autorizado de revisão indisponível.');
      }
      const receipt = exactCommitReceipt(await requestCommit(decision), decision);
      if (!receipt) throw new Error('A decisão não foi autorizada pelo relatório.');
      const revision = verifiedCommittedRevision(
        await loadReportRevision(decision.auditId), receipt, decision,
      );
      if (!revision) throw new Error('A confirmação da decisão não corresponde ao relatório persistido.');
      return revision;
    };
    const operation = queue.tail ? queue.tail.then(persist) : persist();
    const tail = operation.then(() => undefined, () => undefined);
    queue.tail = tail;
    try {
      try { onPendingChange?.(true); } catch { /* UI notification must not affect authorization. */ }
      const committed = await operation;
      return { status: 'committed', ...committed };
    } catch (error) {
      for (const control of cardControls) control.disabled = false;
      try { onPendingChange?.(false); } catch { /* UI notification must not mask the authorization error. */ }
      try { retryFocus?.focus?.(); } catch { /* Focus recovery is best effort. */ }
      throw error;
    } finally {
      pendingOccurrences.delete(pendingKey);
      if (queue.tail === tail) queue.tail = null;
    }
  };
}

function rememberReviewRevision(model, committed) {
  if (model && typeof model === 'object' && Number.isSafeInteger(committed?.revision) && committed.revision >= 0) {
    REVIEW_COMMIT_REVISIONS.set(model, committed.revision);
  }
}

function exactBatchReceipt(value, auditId, count) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return null;
    const keys = Reflect.ownKeys(value);
    const expected = ['ok', 'auditId', 'count', 'modelRevision', 'modelHash'];
    if (keys.length !== expected.length || keys.some(key => typeof key !== 'string' || !expected.includes(key))) return null;
    const receipt = Object.fromEntries(expected.map(key => [key, ownData(value, key)]));
    return receipt.ok === true && receipt.auditId === auditId && receipt.count === count &&
      Number.isSafeInteger(receipt.modelRevision) && receipt.modelRevision >= 1 &&
      typeof receipt.modelHash === 'string' && /^[a-f0-9]{64}$/u.test(receipt.modelHash)
      ? receipt : null;
  } catch { return null; }
}

/**
 * Uma resposta da revisão guiada pode decidir várias ocorrências (as de uma pergunta ou as perguntas
 * de uma imagem). Elas vão numa única gravação autorizada, conferida contra o relatório persistido;
 * antes cada ocorrência era uma gravação completa do modelo, em sequência.
 */
export function createAuthorizedReviewBatchCommitter() {
  const pendingOccurrences = new Set();
  const auditQueues = new Map();
  return async function commitBatch({
    inputs, requestCommit, loadReportRevision, controls = [], retryFocus, onPendingChange,
  } = {}) {
    if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 64) throw new TypeError('Lote de decisões inválido.');
    const decisions = inputs.map(input => createReviewDecision(input));
    const auditId = decisions[0].auditId;
    if (decisions.some(decision => decision.auditId !== auditId) ||
      new Set(decisions.map(decision => decision.occurrenceId)).size !== decisions.length) {
      throw new TypeError('Lote de decisões inválido.');
    }
    const keys = decisions.map(decision => `${auditId}\u0000${decision.occurrenceId}`);
    if (keys.some(key => pendingOccurrences.has(key))) return { status: 'duplicate' };
    for (const key of keys) pendingOccurrences.add(key);
    const cardControls = Array.from(controls).filter(control => control && typeof control === 'object');
    for (const control of cardControls) control.disabled = true;
    const queue = auditQueues.get(auditId) || { tail: null };
    auditQueues.set(auditId, queue);
    const persist = async () => {
      if (typeof requestCommit !== 'function' || typeof loadReportRevision !== 'function') {
        throw new TypeError('Canal autorizado de revisão indisponível.');
      }
      const receipt = exactBatchReceipt(await requestCommit(decisions), auditId, decisions.length);
      if (!receipt) throw new Error('A decisão não foi autorizada pelo relatório.');
      try {
        const value = await loadReportRevision(auditId);
        const model = createAuditModel(ownData(value, 'model'));
        if (ownData(value, 'auditId') !== auditId || model.auditId !== auditId ||
          ownData(value, 'modelRevision') !== receipt.modelRevision || ownData(value, 'modelHash') !== receipt.modelHash ||
          !Array.isArray(model.reviewDecisions) ||
          !decisions.every(decision => model.reviewDecisions.some(current => sameReviewDecision(current, decision)))) throw new Error();
        return { model, modelRevision: receipt.modelRevision, modelHash: receipt.modelHash };
      } catch {
        throw new Error('A confirmação da decisão não corresponde ao relatório persistido.');
      }
    };
    const operation = queue.tail ? queue.tail.then(persist) : persist();
    const tail = operation.then(() => undefined, () => undefined);
    queue.tail = tail;
    try {
      try { onPendingChange?.(true); } catch { /* UI notification must not affect authorization. */ }
      const committed = await operation;
      return { status: 'committed', ...committed };
    } catch (error) {
      for (const control of cardControls) control.disabled = false;
      try { onPendingChange?.(false); } catch { /* UI notification must not mask the authorization error. */ }
      try { retryFocus?.focus?.(); } catch { /* Focus recovery is best effort. */ }
      throw error;
    } finally {
      for (const key of keys) pendingOccurrences.delete(key);
      if (queue.tail === tail) queue.tail = null;
    }
  };
}
