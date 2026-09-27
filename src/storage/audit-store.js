import {
  AuditDeletionDeniedError,
  canonicalAuditId,
  canonicalRetentionInstant,
  createRetentionMetadata,
  createDeletionTombstoneV1,
  isPrivateAuditKey,
  migrateRetentionMetadata,
  validateRetentionMetadata,
  validateDeletionTombstoneV1,
  validateTerminalExportReceiptV1,
} from './audit-retention.js';
import { runPixelAttemptCommitAuthorizationV1 } from '../background/pixel-attempt-correlation.js';
import { AUDIT_STORAGE_UNAVAILABLE_MESSAGE as STORAGE_UNAVAILABLE_MESSAGE } from '../core/privacy.js';
import { createAuditModel } from '../core/report/audit-model.js';
import { auditModelInputError, captureAuditInput } from '../core/report/audit-input.js';
import { canonicalStringify } from '../core/report/canonical-json.js';
import { verifyAuditIntegritySnapshot } from '../core/report/integrity.js';
import { sha256Hex } from '../core/report/hash.js';
import { applyReviewDecisions } from '../core/review/decisions.js';
import { validateExecutionCheckpoint } from '../background/execution-checkpoint.js';
import { createExportDeliveryIdentityV1, EXPORT_FORMATS_V1 } from '../export/export-formats.js';

const DB_NAME = 'audita-mt';
const STORE_NAME = 'audits';
const RETENTION_STORE_NAME = 'audit-retention';
const DELETION_STORE_NAME = 'audit-deletion-tombstones';
const LATEST_KEY = '__latest__';
const REVISION_KEY_PREFIX = '__audit_revision__:';
const CHECKPOINT_KEY_PREFIX = '__audit_checkpoint__:';
const PIXEL_ATTEMPT_KEY_PREFIX = '__audit_checkpoint__:/pixel-attempt/:';
const EXPORT_LEASE_KEY_PREFIX = '__audit_export_lease__:';
const EXPORT_ATTEMPT_KEY_PREFIX = '__audit_export_attempt__:';
const EXPORT_DELIVERY_KEY_PREFIX = '__audit_export_delivery__:';
const EXPORT_RECEIPT_KEY_PREFIX = '__audit_export_receipt__:';
const RETENTION_CLEANUP_CURSOR_KEY = '__audit_retention_cleanup__';
const DEFAULT_EXPORT_LEASE_TTL_MS = 2 * 60 * 1000;
const MAX_EXPORT_LEASE_TTL_MS = 10 * 60 * 1000;
const EXPORT_CLEANUP_MESSAGE = 'Um arquivo obsoleto da exportação não pôde ser removido com confirmação; tente gerar o relatório novamente.';
const EXPORT_FORMATS = new Set(EXPORT_FORMATS_V1);
const EXPORT_MIME_V1 = Object.freeze({
  html: 'text/html;charset=utf-8', pdf: 'application/pdf',
  csv: 'text/csv;charset=utf-8', json: 'application/json;charset=utf-8',
});
const TERMINAL_AUDIT_STATUSES = new Set(['complete', 'partial', 'failed', 'cancelled']);
const INTERRUPTIBLE_AUDIT_STATUSES = new Set(['idle', 'validating', 'queued', 'running', 'cancelling']);
const AUDIT_SNAPSHOT_CAPABILITIES = new WeakMap();
const IN_MEMORY_RETENTION = new WeakMap();
const IN_MEMORY_DELETIONS = new WeakMap();
const PRIVATE_PIXEL_ATTEMPT_STORES = new WeakMap();

function materializeCanonicalAuditModel(auditId, model, options = {}) {
  if (model === undefined && options.allowMissing === true) return undefined;
  try {
    const canonical = createAuditModel(model);
    if (canonical.auditId !== auditId) throw new TypeError();
    return canonical;
  } catch {
    throw auditModelInputError();
  }
}

async function canonicalReviewTransition(id, model, snapshotCapability, owner) {
  try {
    const capturedCandidate = captureAuditInput(model);
    const auditId = validId(id);
    const record = capabilityRecord(snapshotCapability, owner, auditId);
    let base = createAuditModel(record.model);
    if (base.integrity?.algorithm !== 'SHA-256') throw new TypeError();
    const canonicalPending = base.integrity.canonicalModelHash === 'pending';
    const completeSha = /^[a-f0-9]{64}$/u.test(base.integrity.canonicalModelHash) &&
      /^[a-f0-9]{64}$/u.test(base.integrity.evidenceManifestHash);
    if (!canonicalPending && !completeSha) throw new TypeError();
    if (completeSha) base = await verifyAuditIntegritySnapshot(base);

    const candidate = createAuditModel(capturedCandidate);
    if (candidate.auditId !== auditId) throw new TypeError();
    const baseByOccurrence = new Map(base.reviewDecisions.map(decision => [decision.occurrenceId, decision]));
    const additions = [];
    for (const decision of candidate.reviewDecisions) {
      const prior = baseByOccurrence.get(decision.occurrenceId);
      if (prior) {
        if (canonicalStringify(prior) !== canonicalStringify(decision)) throw new TypeError();
      } else {
        additions.push(decision);
      }
    }
    if (candidate.reviewDecisions.length !== base.reviewDecisions.length + additions.length || additions.length === 0) {
      throw new TypeError();
    }
    const expected = createAuditModel(applyReviewDecisions(base, additions));
    if (canonicalStringify(candidate) !== canonicalStringify(expected)) throw new TypeError();
    if (completeSha) {
      // Seal the authorized review before the existing CAS transaction starts.
      // Evidence and its manifest are unchanged; only the canonical model hash changes.
      const hashInput = structuredClone(expected);
      delete hashInput.integrity.canonicalModelHash;
      const canonicalModelHash = await sha256Hex(canonicalStringify(hashInput));
      return await verifyAuditIntegritySnapshot({ ...expected,
        integrity: { ...expected.integrity, canonicalModelHash } });
    }
    return expected;
  } catch {
    throw auditModelInputError();
  }
}

function storageArrayIndex(key, length) {
  if (typeof key !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length && index < 0xffff_ffff;
}

function snapshotStorageGraph(root) {
  const snapshots = new WeakMap();
  const capture = value => {
    if (value === null || value === undefined) return value;
    const valueType = typeof value;
    if (valueType === 'string' || valueType === 'boolean' || valueType === 'number') return value;
    if (valueType !== 'object') throw new TypeError('Valor não clonável.');
    if (snapshots.has(value)) return snapshots.get(value);

    const descriptors = Object.getOwnPropertyDescriptors(value);
    const prototype = Object.getPrototypeOf(value);
    const keys = Reflect.ownKeys(descriptors);
    const isArray = Array.isArray(value);
    if (isArray ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Tipo de armazenamento não suportado.');
    }

    let snapshot;
    let entries;
    if (isArray) {
      const lengthDescriptor = descriptors.length;
      if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, 'value') ||
        !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0 ||
        lengthDescriptor.value > 0xffff_ffff) {
        throw new TypeError('Array de armazenamento inválido.');
      }
      snapshot = new Array(lengthDescriptor.value);
      entries = keys.filter(key => key !== 'length').map(key => {
        if (!storageArrayIndex(key, lengthDescriptor.value)) {
          throw new TypeError('Propriedade de array não suportada.');
        }
        return [key, descriptors[key]];
      });
    } else {
      snapshot = prototype === null ? Object.create(null) : {};
      entries = keys.map(key => {
        if (typeof key !== 'string') throw new TypeError('Chave de armazenamento não suportada.');
        return [key, descriptors[key]];
      });
    }

    snapshots.set(value, snapshot);
    for (const [key, descriptor] of entries) {
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
        throw new TypeError('Descritor de armazenamento não suportado.');
      }
      Object.defineProperty(snapshot, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: capture(descriptor.value),
      });
    }
    return snapshot;
  };
  return capture(root);
}

function storageClone(value, transaction = null) {
  if (value === undefined) return undefined;
  try {
    return snapshotStorageGraph(value);
  } catch {
    abortIndexedDbTransaction(transaction);
    throw new AuditStorageUnavailableError();
  }
}

function validId(id) {
  return canonicalAuditId(id);
}

function cleanupCursorRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(['auditId', 'expiresAt', 'schemaVersion']) ||
    value.schemaVersion !== 1) return null;
  let expiresAt;
  let auditId;
  try {
    expiresAt = canonicalRetentionInstant(value.expiresAt).iso;
    auditId = validId(value.auditId);
  } catch {
    return null;
  }
  return Object.freeze({ schemaVersion: 1, expiresAt, auditId });
}

function compareRetentionPosition(metadata, marker) {
  const expiryOrder = metadata.expiresAt.localeCompare(marker.expiresAt);
  return expiryOrder === 0 ? metadata.auditId.localeCompare(marker.auditId) : expiryOrder;
}

function ownedAuditId(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, 'auditId');
    return descriptor && Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'string'
      ? descriptor.value
      : '';
  } catch {
    return '';
  }
}

function legacyPrivateAuditKeyIsSafe(key, value) {
  if (key === LATEST_KEY) {
    try {
      return canonicalAuditId(ownedAuditId(value)) === ownedAuditId(value);
    } catch {
      return false;
    }
  }
  if (key === RETENTION_CLEANUP_CURSOR_KEY) return cleanupCursorRecord(value) !== null;
  if (key?.startsWith?.(PIXEL_ATTEMPT_KEY_PREFIX)) {
    try {
      const auditId = canonicalAuditId(key.slice(PIXEL_ATTEMPT_KEY_PREFIX.length));
      return parsePixelAttemptCompanion(value, auditId) !== null;
    } catch { return false; }
  }
  if (key?.startsWith?.(CHECKPOINT_KEY_PREFIX)) {
    try {
      const auditId = canonicalAuditId(key.slice(CHECKPOINT_KEY_PREFIX.length));
      parseCheckpointCompanion(value, auditId);
      return true;
    } catch { return false; }
  }
  for (const prefix of [
    REVISION_KEY_PREFIX,
    EXPORT_LEASE_KEY_PREFIX,
    EXPORT_ATTEMPT_KEY_PREFIX,
    EXPORT_DELIVERY_KEY_PREFIX,
    EXPORT_RECEIPT_KEY_PREFIX,
  ]) {
    if (!key?.startsWith?.(prefix)) continue;
    try {
      canonicalAuditId(key.slice(prefix.length));
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

function assertFinalizationCorrelation(auditId, model, latestState) {
  if (ownedAuditId(model) !== auditId ||
    (latestState !== undefined && ownedAuditId(latestState) !== auditId)) {
    throw new TypeError('Modelo ou estado final não corresponde à auditoria.');
  }
}

function interruptedLatest(auditId, latestState) {
  if (ownedAuditId(latestState) !== auditId || latestState?.status !== 'failed') {
    throw new TypeError('Estado de interrupção não corresponde à auditoria.');
  }
  return storageClone(latestState);
}

function isTerminalAuditStatus(status) {
  return typeof status === 'string' && TERMINAL_AUDIT_STATUSES.has(status);
}

function isInterruptibleAuditStatus(status) {
  return typeof status === 'string' && INTERRUPTIBLE_AUDIT_STATUSES.has(status);
}

function storedRevision(value) {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Revisão armazenada da auditoria inválida.');
  return value;
}

function storedExportAttempt(value, auditId) {
  if (value === undefined) return { exportAttempt: 0, deliveryAt: null };
  if (Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER) {
    return { exportAttempt: value, deliveryAt: null };
  }
  const record = exactDataRecord(value, ['schemaVersion', 'auditId', 'exportAttempt', 'deliveryAt']);
  if (!record || record.schemaVersion !== 1 || record.auditId !== auditId ||
    !Number.isSafeInteger(record.exportAttempt) || record.exportAttempt < 1 ||
    record.exportAttempt >= Number.MAX_SAFE_INTEGER) {
    throw new TypeError('Tentativa armazenada da exportação inválida.');
  }
  let deliveryAt;
  try { deliveryAt = canonicalLeaseNow(record.deliveryAt).now; }
  catch { throw new TypeError('Tentativa armazenada da exportação inválida.'); }
  return { exportAttempt: record.exportAttempt, deliveryAt };
}

function nextExportAttempt(value, latest, auditId, now) {
  const stored = storedExportAttempt(value, auditId);
  let previous = stored.exportAttempt;
  if (latest && typeof latest === 'object' && !Array.isArray(latest) && latest.auditId === auditId &&
    latest.exportAttempt !== undefined) {
    if (!Number.isSafeInteger(latest.exportAttempt) || latest.exportAttempt < 1 ||
      latest.exportAttempt >= Number.MAX_SAFE_INTEGER) {
      throw new TypeError('Tentativa armazenada da exportação inválida.');
    }
    previous = Math.max(previous, latest.exportAttempt);
  }
  const instant = canonicalLeaseNow(now);
  const previousDeliveryMs = stored.deliveryAt === null ? null : new Date(stored.deliveryAt).getTime();
  const deliveryMs = previousDeliveryMs === null ? instant.nowMs : Math.max(instant.nowMs, previousDeliveryMs + 1);
  let deliveryAt;
  try { deliveryAt = new Date(deliveryMs).toISOString(); }
  catch { throw new TypeError('Tentativa armazenada da exportação inválida.'); }
  return { exportAttempt: previous + 1, deliveryAt };
}

function exportAttemptRecord(auditId, exportAttempt, deliveryAt) {
  canonicalLeaseNow(deliveryAt);
  return Object.freeze({ schemaVersion: 1, auditId, exportAttempt, deliveryAt });
}

function correlatedExportAttemptRecord(value, auditId, lease) {
  const stored = storedExportAttempt(value, auditId);
  if (stored.exportAttempt !== lease.exportAttempt ||
    (stored.deliveryAt !== null && stored.deliveryAt !== lease.deliveryAt)) {
    throw new TypeError('Tentativa armazenada da exportação inválida.');
  }
  return exportAttemptRecord(auditId, lease.exportAttempt, lease.deliveryAt);
}

function migrateExportAttemptBeforeLeaseRemoval(attemptValue, leaseValue, auditId) {
  if (leaseValue === undefined) return null;
  const currentKeys = [
    'schemaVersion', 'auditId', 'ownerId', 'revision', 'exportAttempt', 'phase',
    'acquiredAt', 'deliveryAt', 'expiresAt',
  ];
  const legacyKeys = currentKeys.filter(key => key !== 'deliveryAt');
  const record = exactDataRecord(leaseValue, currentKeys) ?? exactDataRecord(leaseValue, legacyKeys);
  if (!record || !Number.isSafeInteger(record.revision) || record.revision < 0) return null;
  const lease = activeExportLease(record, auditId, record.revision, Number.NEGATIVE_INFINITY);
  if (!lease) return null;
  return correlatedExportAttemptRecord(attemptValue, auditId, lease);
}

function revisionKey(id) {
  return `${REVISION_KEY_PREFIX}${id}`;
}

function checkpointKey(id) {
  return `${CHECKPOINT_KEY_PREFIX}${id}`;
}

function pixelAttemptKey(id) { return `${PIXEL_ATTEMPT_KEY_PREFIX}${id}`; }

function exactDataRecord(value, keys) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return null;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== keys.length || ownKeys.some(key => typeof key !== 'string' || !keys.includes(key))) return null;
    const copy = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      copy[key] = descriptor.value;
    }
    return copy;
  } catch { return null; }
}

function deletionRequestV1(value) {
  try {
    const record = exactDataRecord(value, ['auditId', 'reason', 'now', 'expectedRevision', 'terminalReceipt']);
    if (!record) return null;
    let receipt = null;
    if (record.reason === 'post-export') {
      receipt = validateTerminalExportReceiptV1(record.terminalReceipt);
      if (receipt.status !== 'complete' || receipt.auditId !== record.auditId ||
        !Number.isSafeInteger(record.expectedRevision) || record.expectedRevision !== receipt.modelRevision + 1) return null;
    } else if (record.terminalReceipt !== null) return null;
    else if (record.reason === 'manual') {
      if (!Number.isSafeInteger(record.expectedRevision) || record.expectedRevision < 1) return null;
    } else if (record.reason !== 'retention-expired' || record.expectedRevision !== null) return null;
    return { auditId: canonicalAuditId(record.auditId), now: canonicalRetentionInstant(record.now).iso,
      reason: record.reason, expectedRevision: record.expectedRevision, terminalReceipt: receipt };
  } catch { return null; }
}

function deletionOperationV1(value, keys) {
  try {
    const record = exactDataRecord(value, keys);
    if (!record) throw new TypeError();
    if (keys.includes('auditId')) canonicalAuditId(record.auditId);
    if (keys.includes('at')) canonicalRetentionInstant(record.at);
    if (keys.includes('limit') && (!Number.isSafeInteger(record.limit) || record.limit < 1 || record.limit > 25)) throw new TypeError();
    return record;
  } catch { throw new AuditDeletionDeniedError(); }
}

function expirationSelectionRequestV1(value) {
  try {
    const request = deletionOperationV1(value, ['now', 'limit']);
    return { now: canonicalRetentionInstant(request.now).iso, limit: request.limit };
  } catch { throw new AuditDeletionDeniedError(); }
}

async function stageSelectedAuditDeletionsV1(candidates, now, stage) {
  const tombstones = [];
  let failed = false;
  for (const { auditId } of candidates) {
    try {
      const result = await stage({ auditId, reason: 'retention-expired', now, expectedRevision: null, terminalReceipt: null });
      if (result.status === 'staged') tombstones.push(result.tombstone);
    } catch { failed = true; }
  }
  // Successful per-audit commits remain recoverable through the tombstone listing.
  if (failed) throw new AuditStorageUnavailableError();
  return Object.freeze(tombstones);
}

function nextDeletionFailure(record, at) {
  if (at < (record.lastAttemptAt ?? record.requestedAt)) throw new AuditDeletionDeniedError();
  return validateDeletionTombstoneV1({ ...record, attempts: record.attempts + 1, lastAttemptAt: at }, record.auditId);
}

function stagedDeletion(record, auditId) {
  return Object.freeze({ status: 'staged', tombstone: validateDeletionTombstoneV1(record, auditId) });
}

function deniedDeletion() {
  return Object.freeze({ status: 'denied', code: 'AUDIT_DELETION_DENIED' });
}

function confirmedReceipt(value, auditId, revision) {
  try {
    const receipt = validateTerminalExportReceiptV1(value);
    return receipt.auditId === auditId && revision === receipt.modelRevision + 1 ? receipt : null;
  } catch { return null; }
}

function eligiblePostExport(request, persistedReceipt, metadata, revision) {
  const durable = confirmedReceipt(persistedReceipt, request.auditId, revision);
  return durable?.status === 'complete' && metadata !== undefined &&
    validateRetentionMetadata(metadata, request.auditId).deleteAfterCompleteExport === true &&
    canonicalStringify(durable) === canonicalStringify(request.terminalReceipt);
}

function manualDeletionCandidate(auditId, model, revisionValue) {
  try {
    canonicalAuditId(auditId);
    const revision = storedRevision(revisionValue);
    const audit = materializeCanonicalAuditModel(auditId, model, { allowMissing: true });
    if (!audit || revision < 1) return null;
    return Object.freeze({ auditId, expectedRevision: revision });
  } catch { return null; }
}

function exactTerminalOptions(value) {
  const options = exactDataRecord(value, ['now', 'deleteAfterCompleteExport']) ??
    exactDataRecord(value, ['now', 'deleteAfterCompleteExport', 'pixelAttemptCommit']);
  if (!options || options.deleteAfterCompleteExport !== false) throw new TypeError('Commit terminal inválido.');
  canonicalRetentionInstant(options.now);
  return {
    ...options,
    pixelAttemptCommit: Object.hasOwn(options, 'pixelAttemptCommit') ? options.pixelAttemptCommit : null,
  };
}

function checkpointPageOrder(value) {
  const checkpoint = exactDataRecord(value, ['version', 'auditId', 'pages']);
  if (!checkpoint || !Array.isArray(checkpoint.pages) || Object.getPrototypeOf(checkpoint.pages) !== Array.prototype) {
    throw new TypeError('Checkpoint terminal inválido.');
  }
  const length = Object.getOwnPropertyDescriptor(checkpoint.pages, 'length')?.value;
  if (!Number.isSafeInteger(length) || length < 1 || length > 20) throw new TypeError('Checkpoint terminal inválido.');
  const keys = Reflect.ownKeys(checkpoint.pages);
  const expected = ['length', ...Array.from({ length }, (_entry, index) => String(index))];
  const keySet = new Set(keys); // O(n): includes() por índice era quadrático em listas grandes (1.1.53)
  if (keys.length !== expected.length || expected.some(key => !keySet.has(key))) throw new TypeError('Checkpoint terminal inválido.');
  return Array.from({ length }, (_entry, index) => {
    const row = Object.getOwnPropertyDescriptor(checkpoint.pages, String(index));
    const page = row?.enumerable && Object.hasOwn(row, 'value') ? row.value : null;
    const descriptor = page && typeof page === 'object' ? Object.getOwnPropertyDescriptor(page, 'pageId') : null;
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new TypeError('Checkpoint terminal inválido.');
    return descriptor.value;
  });
}

function canonicalTerminalCheckpoint(auditId, checkpoint, model) {
  const pageOrder = model?.pages?.map(page => page.pageId) ?? checkpointPageOrder(checkpoint);
  try { return validateExecutionCheckpoint({ auditId, checkpoint, pageOrder }); }
  catch { throw new TypeError('Checkpoint terminal inválido.'); }
}

function canonicalTerminalLatest(auditId, latestState, model) {
  const latest = exactDataRecord(latestState, [
    'version', 'auditId', 'status', 'percent', 'message', 'failureCode', 'modelRevision', 'updatedAt',
  ]);
  const fixed = {
    complete: [100, 'Avaliação concluída.'],
    partial: [100, 'Avaliação concluída com limitações.'],
    failed: [100, 'Avaliação concluída com falha estrutural.'],
    cancelled: [100, 'Avaliação cancelada.'],
  }[model?.session?.status];
  if (!latest || !fixed || latest.version !== 1 || latest.auditId !== auditId ||
    latest.status !== model.session.status || latest.percent !== fixed[0] || latest.message !== fixed[1] ||
    latest.failureCode !== null || latest.modelRevision !== 1) throw new TypeError('Estado terminal inválido.');
  canonicalRetentionInstant(latest.updatedAt);
  return storageClone(latest);
}

async function canonicalTerminalGraph(auditId, model, checkpoint, latestState) {
  const key = validId(auditId);
  let verified;
  try { verified = await verifyAuditIntegritySnapshot(model); }
  catch { throw new AuditStorageUnavailableError(); }
  if (verified.auditId !== key || !['complete', 'partial', 'failed', 'cancelled'].includes(verified.session.status) ||
    !/^[a-f0-9]{64}$/u.test(verified.integrity.canonicalModelHash)) throw new AuditStorageUnavailableError();
  const terminalCheckpoint = canonicalTerminalCheckpoint(key, checkpoint, verified);
  const terminalLatest = canonicalTerminalLatest(key, latestState, verified);
  return { key, model: verified, checkpoint: terminalCheckpoint, latest: terminalLatest };
}

function checkpointCompanion(auditId, checkpoint) {
  return storageClone({ version: 1, auditId, checkpoint });
}

function pixelAttemptCompanion(correlation, committedAt) {
  return storageClone({ version: 1, ...correlation, committedAt, terminalRevision: 1 });
}

function parsePixelAttemptCompanion(value, auditId) {
  const record = exactDataRecord(value, [
    'version', 'auditId', 'attemptDigest', 'pageId', 'ownershipId', 'committedAt', 'terminalRevision',
  ]);
  if (!record || record.version !== 1 || record.auditId !== auditId || record.terminalRevision !== 1 ||
    typeof record.attemptDigest !== 'string' || !/^hmac-sha256:[A-Za-z0-9_-]{43}$/u.test(record.attemptDigest) ||
    (record.pageId !== null && !/^[A-Za-z0-9._:-]{1,160}$/u.test(record.pageId ?? '')) ||
    (record.ownershipId !== null && !/^[A-Za-z0-9._:-]{1,160}$/u.test(record.ownershipId ?? ''))) return null;
  try { canonicalRetentionInstant(record.committedAt); } catch { return null; }
  return record;
}

function samePixelAttempt(record, correlation) {
  return Boolean(record) && record.auditId === correlation.auditId &&
    record.attemptDigest === correlation.attemptDigest && record.pageId === correlation.pageId &&
    record.ownershipId === correlation.ownershipId;
}

function pixelAttemptCorrelation(value) {
  const record = exactDataRecord(value, ['auditId', 'attemptDigest', 'pageId', 'ownershipId']);
  if (!record || !/^[A-Za-z0-9._:-]{1,160}$/u.test(record.auditId ?? '') ||
    !/^hmac-sha256:[A-Za-z0-9_-]{43}$/u.test(record.attemptDigest ?? '') ||
    (record.pageId !== null && !/^[A-Za-z0-9._:-]{1,160}$/u.test(record.pageId ?? '')) ||
    (record.ownershipId !== null && !/^[A-Za-z0-9._:-]{1,160}$/u.test(record.ownershipId ?? ''))) return null;
  return record;
}

export async function readPrivatePixelAttemptCommitV1(store, correlation) {
  const operations = store && typeof store === 'object' ? PRIVATE_PIXEL_ATTEMPT_STORES.get(store) : null;
  return operations ? operations.read(correlation) : false;
}

export async function removePrivatePixelAttemptCommitV1(store, correlation) {
  const operations = store && typeof store === 'object' ? PRIVATE_PIXEL_ATTEMPT_STORES.get(store) : null;
  return operations ? operations.remove(correlation) : false;
}

function freezeStored(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freezeStored(child, seen);
  return Object.freeze(value);
}

function parseCheckpointCompanion(value, auditId, model = null) {
  const record = exactDataRecord(value, ['version', 'auditId', 'checkpoint']);
  if (!record || record.version !== 1 || record.auditId !== auditId) throw new AuditStorageUnavailableError();
  return canonicalTerminalCheckpoint(auditId, record.checkpoint, model);
}

function exportLeaseKey(id) {
  return `${EXPORT_LEASE_KEY_PREFIX}${id}`;
}

function exportAttemptKey(id) {
  return `${EXPORT_ATTEMPT_KEY_PREFIX}${id}`;
}

function exportDeliveryKey(id) {
  return `${EXPORT_DELIVERY_KEY_PREFIX}${id}`;
}

function exportReceiptKey(id) { return `${EXPORT_RECEIPT_KEY_PREFIX}${id}`; }

function canonicalLeaseNow(rawNow) {
  if (typeof rawNow !== 'string') throw new TypeError('Instante do lease de exportação inválido.');
  const now = new Date(rawNow);
  if (!Number.isFinite(now.getTime()) || now.toISOString() !== rawNow) {
    throw new TypeError('Instante do lease de exportação inválido.');
  }
  return { now: rawNow, nowMs: now.getTime() };
}

function canonicalLeaseOptions(options, revision, defaultPhase = 'queued') {
  const ownerId = validId(options?.ownerId);
  const instant = canonicalLeaseNow(options?.now);
  const ttlMs = options?.ttlMs ?? DEFAULT_EXPORT_LEASE_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_EXPORT_LEASE_TTL_MS) {
    throw new TypeError('Duração do lease de exportação inválida.');
  }
  const phase = options?.phase ?? defaultPhase;
  if (!['queued', 'running', 'delivering'].includes(phase)) {
    throw new TypeError('Fase do lease de exportação inválida.');
  }
  const exportAttempt = options?.exportAttempt;
  if (exportAttempt !== undefined && (!Number.isSafeInteger(exportAttempt) || exportAttempt < 1)) {
    throw new TypeError('Tentativa da exportação inválida.');
  }
  return {
    ownerId,
    now: instant.now,
    nowMs: instant.nowMs,
    expiresAt: new Date(instant.nowMs + ttlMs).toISOString(),
    ttlMs,
    phase,
    revision: storedRevision(revision),
    exportAttempt,
    latestState: options?.latestState === undefined ? undefined : storageClone(options.latestState),
    release: options?.release === true,
    clearDeliveryJournal: options?.clearDeliveryJournal === true,
  };
}

function canonicalDeliveryOptions(options, outcome = false) {
  const ownerId = validId(options?.ownerId);
  const exportAttempt = options?.exportAttempt;
  if (!Number.isSafeInteger(exportAttempt) || exportAttempt < 1) {
    throw new TypeError('Tentativa do journal de entrega inválida.');
  }
  const instant = canonicalLeaseNow(options?.now);
  const format = options?.format;
  const filename = options?.filename;
  if (!EXPORT_FORMATS.has(format) || typeof filename !== 'string' || filename !== filename.trim() ||
    filename.length < 6 || filename.length > 255 || !filename.endsWith(`.${format}`)) {
    throw new TypeError('Artefato do journal de entrega inválido.');
  }
  const downloadId = options?.downloadId;
  if (downloadId !== undefined && (!Number.isSafeInteger(downloadId) || downloadId < 0)) {
    throw new TypeError('Download do journal de entrega inválido.');
  }
  if (outcome) {
    if (!['cleaned', 'cleanup-failed'].includes(options?.outcome)) {
      throw new TypeError('Resultado de limpeza do journal inválido.');
    }
    return { ownerId, exportAttempt, ...instant, format, filename, downloadId, outcome: options.outcome };
  }
  const identityProvided = options?.mimeType !== undefined || options?.byteSize !== undefined || options?.sha256 !== undefined;
  let identity = {};
  if (identityProvided) {
    if (typeof options.mimeType !== 'string' || options.mimeType.length < 3 || options.mimeType.length > 120 ||
      !Number.isSafeInteger(options.byteSize) || options.byteSize < 0 || !/^[a-f0-9]{64}$/u.test(options.sha256 ?? '')) {
      throw new TypeError('Identidade persistente do artefato inválida.');
    }
    identity = { mimeType: options.mimeType, byteSize: options.byteSize, sha256: options.sha256 };
  }
  const state = options?.state;
  if (state === 'identified') {
    const requestedFilename = options?.requestedFilename;
    if (identityProvided || downloadId === undefined || typeof requestedFilename !== 'string' ||
      requestedFilename !== requestedFilename.trim() || requestedFilename.length < 6 ||
      requestedFilename.length > 255 || !requestedFilename.endsWith(`.${format}`) ||
      !isRequestedOrUniquifiedFilename(filename, requestedFilename, format)) {
      throw new TypeError('Estado do journal de entrega inválido.');
    }
    return {
      ownerId, exportAttempt, ...instant, format, requestedFilename, filename, downloadId, state,
    };
  }
  if (options?.requestedFilename !== undefined) {
    throw new TypeError('Estado do journal de entrega inválido.');
  }
  if (!['starting', 'in-flight', 'terminal'].includes(state) ||
    (state !== 'starting' && downloadId === undefined)) {
    throw new TypeError('Estado do journal de entrega inválido.');
  }
  return { ownerId, exportAttempt, ...instant, format, filename, downloadId, state, ...identity };
}

function isRequestedOrUniquifiedFilename(filename, requestedFilename, format) {
  if (typeof filename !== 'string' || filename.length < 6 || filename.length > 255 ||
    filename !== filename.trim() || /[\\/\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(filename) ||
    /[\\/\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(requestedFilename)) return false;
  if (filename === requestedFilename) return true;
  const requestedSuffix = `.${format}`;
  const stem = requestedFilename.slice(0, -requestedSuffix.length);
  const prefix = `${stem} (`;
  const suffix = `)${requestedSuffix}`;
  if (!filename.startsWith(prefix) || !filename.endsWith(suffix)) return false;
  const index = filename.slice(prefix.length, -suffix.length);
  if (!/^[1-9]\d*$/u.test(index)) return false;
  const numericIndex = Number(index);
  return Number.isSafeInteger(numericIndex) && numericIndex >= 1 && String(numericIndex) === index &&
    filename === `${prefix}${index}${suffix}`;
}

function canonicalDeliveryJournal(value, auditId) {
  if (value === undefined) return [];
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 1 ||
    value.auditId !== auditId || !Array.isArray(value.entries) || value.entries.length > 4) {
    throw new TypeError('Journal persistente de entrega inválido.');
  }
  const seen = new Set();
  return value.entries.map(raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('Journal persistente de entrega inválido.');
    const keys = Object.keys(raw).sort();
    const hasId = Object.hasOwn(raw, 'downloadId');
    const hasIdentity = ['mimeType', 'byteSize', 'sha256'].every(key => Object.hasOwn(raw, key));
    const expected = ['exportAttempt', 'filename', 'format', 'ownerId', 'recordedAt', 'state', 'updatedAt', ...(hasId ? ['downloadId'] : []),
      ...(hasIdentity ? ['mimeType', 'byteSize', 'sha256'] : [])].sort();
    if (JSON.stringify(keys) !== JSON.stringify(expected) ||
      !['starting', 'in-flight', 'terminal', 'cleanup-failed'].includes(raw.state)) {
      throw new TypeError('Journal persistente de entrega inválido.');
    }
    const canonical = canonicalDeliveryOptions({
      ...raw,
      now: raw.updatedAt,
      state: raw.state === 'cleanup-failed' ? (hasId ? 'in-flight' : 'starting') : raw.state,
    });
    canonicalLeaseNow(raw.recordedAt);
    if (new Date(raw.updatedAt).getTime() < new Date(raw.recordedAt).getTime()) {
      throw new TypeError('Journal persistente de entrega inválido.');
    }
    const identity = `${canonical.ownerId}\n${canonical.exportAttempt}\n${canonical.format}\n${canonical.filename}`;
    if (seen.has(identity)) throw new TypeError('Journal persistente de entrega duplicado.');
    seen.add(identity);
    return {
      ownerId: canonical.ownerId,
      exportAttempt: canonical.exportAttempt,
      state: raw.state,
      format: canonical.format,
      filename: canonical.filename,
      ...(hasId ? { downloadId: canonical.downloadId } : {}),
      ...(hasIdentity ? { mimeType: canonical.mimeType, byteSize: canonical.byteSize, sha256: canonical.sha256 } : {}),
      recordedAt: raw.recordedAt,
      updatedAt: raw.updatedAt,
    };
  });
}

function deliveryJournalRecord(auditId, entries) {
  return { schemaVersion: 1, auditId, entries: storageClone(entries) };
}

function exportReceiptFromRevision(reportRevision, entries) {
  if (!reportRevision || !Array.isArray(entries) || entries.length !== EXPORT_FORMATS_V1.length) return null;
  const formats = EXPORT_FORMATS_V1.map(format => entries.find(entry => entry.format === format));
  if (formats.some(entry => !entry || entry.state !== 'terminal' || !Number.isSafeInteger(entry.downloadId) || entry.downloadId < 0 ||
    typeof entry.mimeType !== 'string' || !Number.isSafeInteger(entry.byteSize) || entry.byteSize < 0 || !/^[a-f0-9]{64}$/u.test(entry.sha256 ?? ''))) return null;
  const ownerId = formats[0].ownerId;
  const exportAttempt = formats[0].exportAttempt;
  if (formats.some(entry => entry.ownerId !== ownerId || entry.exportAttempt !== exportAttempt)) return null;
  return freezeStored({
    version: 1, auditId: reportRevision.auditId, modelRevision: reportRevision.modelRevision,
    modelHash: reportRevision.modelHash, attemptId: String(exportAttempt), status: 'complete',
    formats: formats.map(entry => ({ format: entry.format, mimeType: entry.mimeType, byteSize: entry.byteSize,
      sha256: entry.sha256, downloadId: entry.downloadId, state: 'complete' })),
  });
}

function exportReceiptFromLatest(latest, auditId) {
  try {
    latest = storageClone(latest);
    if (!latest || typeof latest !== 'object' || Array.isArray(latest) || latest.auditId !== auditId ||
      !['complete', 'partial'].includes(latest.exportStatus)) return null;
    const status = latest.exportStatus;
    const rawIdentity = latest.exportDeliveryIdentity;
    if (!rawIdentity || typeof rawIdentity !== 'object' || Array.isArray(rawIdentity) ||
      canonicalStringify(Object.keys(rawIdentity).sort()) !== canonicalStringify(['attemptId', 'auditId', 'modelHash', 'modelRevision'])) return null;
    const identity = createExportDeliveryIdentityV1(rawIdentity);
    if (identity.auditId !== auditId) return null;
    const receipt = latest.deliveryReceipt;
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) || receipt.status !== status ||
      !Array.isArray(receipt.formats) || receipt.formats.length > EXPORT_FORMATS_V1.length ||
      !Array.isArray(receipt.limitations) ||
      canonicalStringify(Object.keys(receipt).sort()) !== canonicalStringify(['formats', 'limitations', 'status'])) return null;
    if (receipt.limitations.some(value => typeof value !== 'string' || !value.trim()) ||
      new Set(receipt.limitations).size !== receipt.limitations.length ||
      (status === 'complete' ? receipt.limitations.length !== 0 : receipt.limitations.length === 0)) return null;
    const seenDownloadIds = new Set();
    const seenFormats = new Set();
    let previousFormatIndex = -1;
    const formats = [];
    for (const entry of receipt.formats) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !EXPORT_FORMATS.has(entry.format) ||
        seenFormats.has(entry.format) || !['complete', 'timeout', 'interrupted'].includes(entry.status)) throw new TypeError();
      const formatIndex = EXPORT_FORMATS_V1.indexOf(entry.format);
      if (formatIndex <= previousFormatIndex) throw new TypeError();
      previousFormatIndex = formatIndex;
      seenFormats.add(entry.format);
      if (entry.status !== 'complete') continue;
      if (canonicalStringify(Object.keys(entry).sort()) !== canonicalStringify(['byteSize', 'downloadId', 'filename', 'format', 'mimeType', 'sha256', 'status']) ||
        entry.mimeType !== EXPORT_MIME_V1[entry.format] || typeof entry.filename !== 'string' ||
        !Number.isSafeInteger(entry.byteSize) || entry.byteSize < 0 || !/^[a-f0-9]{64}$/u.test(entry.sha256 ?? '') ||
        !Number.isSafeInteger(entry.downloadId) || entry.downloadId < 0 || seenDownloadIds.has(entry.downloadId)) throw new TypeError();
      seenDownloadIds.add(entry.downloadId);
      formats.push({ format: entry.format, mimeType: entry.mimeType, byteSize: entry.byteSize,
        sha256: entry.sha256, downloadId: entry.downloadId, state: 'complete' });
    }
    if (status === 'complete' &&
      (receipt.formats.length !== EXPORT_FORMATS_V1.length || formats.length !== EXPORT_FORMATS_V1.length)) return null;
    return freezeStored({ version: 1, ...identity, status, formats });
  } catch {
    return null;
  }
}

function pendingCleanupLatest(latest, entries) {
  if (latest === undefined || !latest || typeof latest !== 'object' || Array.isArray(latest)) return latest;
  const next = storageClone(latest);
  if (entries.length > 0) {
    next.exportCleanupPending = true;
    next.exportCleanupMessage = EXPORT_CLEANUP_MESSAGE;
  } else {
    delete next.exportCleanupPending;
    delete next.exportCleanupMessage;
  }
  return next;
}

function updateDeliveryEntries(entries, options) {
  if (options.state === 'identified') {
    const matches = entries
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.ownerId === options.ownerId &&
        entry.exportAttempt === options.exportAttempt && entry.format === options.format &&
        entry.filename === options.requestedFilename && entry.state === 'in-flight' &&
        entry.downloadId === options.downloadId);
    if (matches.length !== 1 || entries.some((entry, index) => index !== matches[0]?.index &&
      entry.ownerId === options.ownerId && entry.exportAttempt === options.exportAttempt &&
      entry.format === options.format && entry.filename === options.filename)) {
      throw new TypeError('Identificação do download não corresponde ao journal persistente.');
    }
    const { entry: previous, index } = matches[0];
    const updatedAt = new Date(options.now).getTime() < new Date(previous.updatedAt).getTime()
      ? previous.updatedAt
      : options.now;
    const next = [...entries];
    next[index] = {
      ...previous,
      filename: options.filename,
      updatedAt,
    };
    return next;
  }
  const index = entries.findIndex(entry => entry.ownerId === options.ownerId &&
    entry.exportAttempt === options.exportAttempt && entry.format === options.format && entry.filename === options.filename);
  const previous = index >= 0 ? entries[index] : null;
  if (previous && previous.downloadId !== undefined && options.downloadId !== undefined &&
    previous.downloadId !== options.downloadId) throw new TypeError('Download divergente no journal de entrega.');
  if (previous?.state === 'terminal') {
    const exactRetry = options.state === 'terminal' &&
      previous.downloadId === options.downloadId &&
      previous.mimeType === options.mimeType &&
      previous.byteSize === options.byteSize &&
      previous.sha256 === options.sha256;
    if (exactRetry) return entries;
    throw new TypeError('Identidade terminal do journal de entrega é imutável.');
  }
  const order = { starting: 0, 'in-flight': 1, terminal: 2, 'cleanup-failed': 3 };
  if (previous && order[options.state] < order[previous.state]) {
    throw new TypeError('Regressão no journal de entrega.');
  }
  const updatedAt = previous && new Date(options.now).getTime() < new Date(previous.updatedAt).getTime()
    ? previous.updatedAt
    : options.now;
  const entry = {
    ownerId: options.ownerId,
    exportAttempt: options.exportAttempt,
    state: options.state,
    format: options.format,
    filename: options.filename,
    ...(options.downloadId === undefined ? (previous?.downloadId === undefined ? {} : { downloadId: previous.downloadId }) : { downloadId: options.downloadId }),
    ...(options.mimeType === undefined ? (previous?.mimeType === undefined ? {} : { mimeType: previous.mimeType, byteSize: previous.byteSize, sha256: previous.sha256 }) :
      { mimeType: options.mimeType, byteSize: options.byteSize, sha256: options.sha256 }),
    recordedAt: previous?.recordedAt ?? options.now,
    updatedAt,
  };
  const next = [...entries];
  if (index >= 0) next[index] = entry;
  else {
    if (next.length >= 4) throw new TypeError('Journal persistente de entrega excedeu o limite.');
    next.push(entry);
  }
  return next;
}

function resolveDeliveryEntries(entries, options) {
  let index = entries.findIndex(entry => entry.ownerId === options.ownerId &&
    entry.exportAttempt === options.exportAttempt && entry.format === options.format &&
    (options.downloadId === undefined
      ? entry.filename === options.filename
      : entry.downloadId === options.downloadId));
  if (index < 0 && options.downloadId !== undefined) {
    const preIdMatches = entries
      .map((entry, candidate) => ({ entry, candidate }))
      .filter(({ entry }) => entry.ownerId === options.ownerId &&
        entry.exportAttempt === options.exportAttempt && entry.format === options.format &&
        entry.filename === options.filename && entry.state === 'starting' && entry.downloadId === undefined);
    if (preIdMatches.length === 1) index = preIdMatches[0].candidate;
  }
  if (index < 0) {
    const conflictingSlot = entries.some(entry => entry.ownerId === options.ownerId &&
      entry.exportAttempt === options.exportAttempt && entry.format === options.format);
    return { entries, matched: options.outcome === 'cleaned' && !conflictingSlot };
  }
  if (options.outcome === 'cleaned') {
    return { entries: entries.filter((_, candidate) => candidate !== index), matched: true };
  }
  const next = [...entries];
  const updatedAt = new Date(options.now).getTime() < new Date(next[index].updatedAt).getTime()
    ? next[index].updatedAt
    : options.now;
  next[index] = {
    ...next[index],
    ...(options.downloadId === undefined ? {} : { downloadId: options.downloadId }),
    state: 'cleanup-failed',
    updatedAt,
  };
  return { entries: next, matched: true };
}

function terminalDeliveriesMatchReceipt(entries, latestState, auditId, ownerId, exportAttempt) {
  let latest;
  try { latest = storageClone(latestState); } catch { return false; }
  if (!latest || typeof latest !== 'object' || Array.isArray(latest) || latest.auditId !== auditId ||
    !['complete', 'partial'].includes(latest.exportStatus)) return false;
  const receipt = latest.deliveryReceipt;
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) ||
    receipt.status !== latest.exportStatus || !Array.isArray(receipt.formats) ||
    receipt.formats.length > EXPORT_FORMATS_V1.length || !Array.isArray(receipt.limitations)) return false;
  const expected = [];
  const seenFormats = new Set();
  const seenDownloadIds = new Set();
  for (const raw of receipt.formats) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !EXPORT_FORMATS.has(raw.format) ||
      seenFormats.has(raw.format) || !['complete', 'timeout', 'interrupted'].includes(raw.status)) return false;
    seenFormats.add(raw.format);
    if (raw.status !== 'complete') continue;
    if (typeof raw.filename !== 'string' || raw.filename !== raw.filename.trim() ||
      raw.filename.length < 6 || raw.filename.length > 255 || !raw.filename.endsWith(`.${raw.format}`) ||
      raw.mimeType !== EXPORT_MIME_V1[raw.format] || !Number.isSafeInteger(raw.byteSize) || raw.byteSize < 0 ||
      !/^[a-f0-9]{64}$/u.test(raw.sha256 ?? '') || !Number.isSafeInteger(raw.downloadId) || raw.downloadId < 0 ||
      seenDownloadIds.has(raw.downloadId)) return false;
    seenDownloadIds.add(raw.downloadId);
    expected.push({
      format: raw.format, filename: raw.filename, mimeType: raw.mimeType, byteSize: raw.byteSize,
      sha256: raw.sha256, downloadId: raw.downloadId,
    });
  }
  if (receipt.status === 'complete' &&
    (receipt.formats.length !== EXPORT_FORMATS_V1.length || expected.length !== EXPORT_FORMATS_V1.length)) return false;
  if (entries.length !== expected.length) return false;
  return expected.every(identity => entries.some(entry =>
    entry.ownerId === ownerId && entry.exportAttempt === exportAttempt && entry.state === 'terminal' &&
    entry.format === identity.format && entry.filename === identity.filename &&
    entry.mimeType === identity.mimeType && entry.byteSize === identity.byteSize &&
    entry.sha256 === identity.sha256 && entry.downloadId === identity.downloadId));
}

function activeExportLease(value, auditId, revision, nowMs) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 1 ||
    value.auditId !== auditId || typeof value.ownerId !== 'string' ||
    !Number.isSafeInteger(value.revision) || value.revision !== revision ||
    !Number.isSafeInteger(value.exportAttempt) || value.exportAttempt < 1 ||
    !['queued', 'running', 'delivering'].includes(value.phase) ||
    typeof value.acquiredAt !== 'string' || typeof value.expiresAt !== 'string') return null;
  const acquiredAt = new Date(value.acquiredAt);
  const expiresAt = new Date(value.expiresAt);
  const deliveryAtValue = Object.hasOwn(value, 'deliveryAt') ? value.deliveryAt : value.acquiredAt;
  const deliveryAt = new Date(deliveryAtValue);
  if (!Number.isFinite(acquiredAt.getTime()) || acquiredAt.toISOString() !== value.acquiredAt ||
    !Number.isFinite(deliveryAt.getTime()) || deliveryAt.toISOString() !== deliveryAtValue ||
    deliveryAt.getTime() < acquiredAt.getTime() ||
    !Number.isFinite(expiresAt.getTime()) || expiresAt.toISOString() !== value.expiresAt ||
    expiresAt.getTime() <= acquiredAt.getTime() || expiresAt.getTime() <= nowMs) return null;
  return Object.hasOwn(value, 'deliveryAt') ? value : { ...value, deliveryAt: deliveryAtValue };
}

function exportLeaseRecord(auditId, options, acquiredAt = options.now) {
  return Object.freeze({
    schemaVersion: 1,
    auditId,
    ownerId: options.ownerId,
    revision: options.revision,
    exportAttempt: options.exportAttempt,
    phase: options.phase,
    acquiredAt,
    deliveryAt: options.deliveryAt,
    expiresAt: options.expiresAt,
  });
}

function monotonicLeaseTransition(options, existing) {
  const priorExpiryMs = new Date(existing.expiresAt).getTime();
  const requestedExpiryMs = options.nowMs + options.ttlMs;
  return {
    ...options,
    deliveryAt: existing.deliveryAt,
    expiresAt: new Date(Math.max(priorExpiryMs, requestedExpiryMs)).toISOString(),
  };
}

function reviewLatestState(value, auditId, model, revision) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.auditId !== auditId) return undefined;
  const latest = storageClone(value);
  latest.auditId = auditId;
  if (typeof model?.session?.status === 'string') latest.status = model.session.status;
  latest.exportStatus = 'preparing';
  latest.exportRevision = revision;
  latest.message = 'A revisão foi atualizada; gere o relatório novamente.';
  delete latest.exportQueuedAt;
  delete latest.exportAttempt;
  delete latest.leaseOwnerId;
  delete latest.deliveryReceipt;
  delete latest.exportDeliveryIdentity;
  return latest;
}

function mintAuditSnapshot(owner, auditId, model, revision) {
  const canonicalRevision = storedRevision(revision);
  if (model === undefined) return { model: undefined, revision: canonicalRevision, capability: null };
  const privateModel = storageClone(model);
  const capability = Object.freeze(Object.create(null));
  AUDIT_SNAPSHOT_CAPABILITIES.set(capability, Object.freeze({
    owner,
    auditId,
    revision: canonicalRevision,
    model: privateModel,
  }));
  return { model: storageClone(privateModel), revision: canonicalRevision, capability };
}

function capabilityRevision(capability, owner, auditId) {
  return capabilityRecord(capability, owner, auditId).revision;
}

function capabilityRecord(capability, owner, auditId) {
  const record = (typeof capability === 'object' && capability !== null)
    ? AUDIT_SNAPSHOT_CAPABILITIES.get(capability)
    : null;
  if (!record || record.owner !== owner || record.auditId !== auditId) {
    throw new TypeError('Capacidade de snapshot da auditoria inválida.');
  }
  return record;
}

/** Returns an owned clone only for a capability minted by a local audit store. */
export function inspectAuditSnapshotCapability(capability) {
  const record = (typeof capability === 'object' && capability !== null)
    ? AUDIT_SNAPSHOT_CAPABILITIES.get(capability)
    : null;
  return record ? { auditId: record.auditId, revision: record.revision, model: storageClone(record.model) } : null;
}

export class AuditRevisionConflictError extends Error {
  constructor() {
    super('A auditoria foi atualizada durante a exportação; a versão mais nova foi preservada.');
    this.name = 'AuditRevisionConflictError';
    this.code = 'AUDIT_REVISION_CONFLICT';
  }
}

export class AuditExportLeaseConflictError extends Error {
  constructor(message = 'Outra exportação possui a exclusividade de entrega desta auditoria.') {
    super(message);
    this.name = 'AuditExportLeaseConflictError';
    this.code = 'AUDIT_EXPORT_LEASE_CONFLICT';
  }
}

export class AuditStorageUnavailableError extends Error {
  constructor() {
    super(STORAGE_UNAVAILABLE_MESSAGE);
    this.name = 'AuditStorageUnavailableError';
    this.code = 'AUDIT_STORAGE_UNAVAILABLE';
  }
}

export class AuditDeleteBusyError extends Error {
  constructor() {
    super('A auditoria está sendo exportada ou possui uma entrega pendente. Tente novamente depois.');
    this.name = 'AuditDeleteBusyError';
    this.code = 'AUDIT_DELETE_BUSY';
  }
}

function abortIndexedDbTransaction(transaction) {
  if (!transaction) return;
  try { transaction.abort(); } catch {}
}

function indexedDbBoundary(operation, transaction = null) {
  try {
    return operation();
  } catch {
    abortIndexedDbTransaction(transaction);
    throw new AuditStorageUnavailableError();
  }
}

function indexedDbIndex(transaction, operation) {
  const index = indexedDbBoundary(operation, transaction);
  return new Proxy(index, {
    get(target, property) {
      const member = indexedDbBoundary(() => Reflect.get(target, property, target), transaction);
      if (typeof member !== 'function') return member;
      return (...args) => indexedDbBoundary(() => Reflect.apply(member, target, args), transaction);
    },
  });
}

function indexedDbObjectStore(transaction, operation) {
  const store = indexedDbBoundary(operation, transaction);
  return new Proxy(store, {
    get(target, property) {
      const member = indexedDbBoundary(() => Reflect.get(target, property, target), transaction);
      if (typeof member !== 'function') return member;
      return (...args) => {
        const result = indexedDbBoundary(() => Reflect.apply(member, target, args), transaction);
        return property === 'index' || property === 'createIndex'
          ? indexedDbIndex(transaction, () => result)
          : result;
      };
    },
  });
}

function continueIndexedDbCursor(transaction, cursor, method, ...args) {
  return indexedDbBoundary(() => Reflect.apply(cursor[method], cursor, args), transaction);
}

export function isAuditExportLeaseConflict(error) {
  return safeStoredErrorCode(error) === 'AUDIT_EXPORT_LEASE_CONFLICT';
}

export function isAuditRevisionConflict(error) {
  return safeStoredErrorCode(error) === 'AUDIT_REVISION_CONFLICT';
}

function safeStoredErrorCode(value) {
  try {
    const descriptor = value && (typeof value === 'object' || typeof value === 'function')
      ? Object.getOwnPropertyDescriptor(value, 'code')
      : null;
    return descriptor && Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'string'
      ? descriptor.value
      : '';
  } catch {
    return '';
  }
}

export function createInMemoryAuditStore(initial = new Map(), storeOptions = {}) {
  if (!IN_MEMORY_DELETIONS.has(initial)) IN_MEMORY_DELETIONS.set(initial, new Map());
  const deletions = IN_MEMORY_DELETIONS.get(initial);
  let retention = IN_MEMORY_RETENTION.get(initial);
  if (!retention) {
    retention = new Map();
    for (const [auditId, model] of initial) {
      if (isPrivateAuditKey(auditId)) {
        if (!legacyPrivateAuditKeyIsSafe(auditId, model)) initial.delete(auditId);
        continue;
      }
      try {
        retention.set(auditId, migrateRetentionMetadata(auditId, model));
      } catch {
        initial.delete(auditId);
      }
    }
    IN_MEMORY_RETENTION.set(initial, retention);
  }
  const clock = typeof storeOptions.now === 'function'
    ? storeOptions.now
    : () => new Date().toISOString();
  const owner = Object.freeze(Object.create(null));
  const selectRetainedAuditsV1 = (now, limit) => {
    try {
      const records = [];
      for (const [auditId, value] of retention) {
        if (initial.get(auditId) === undefined) continue;
        const metadata = validateRetentionMetadata(value, auditId);
        if (now === null || metadata.expiresAt <= now) records.push(metadata);
      }
      records.sort((left, right) => {
        if (left.expiresAt !== right.expiresAt) return left.expiresAt < right.expiresAt ? -1 : 1;
        return left.auditId < right.auditId ? -1 : left.auditId > right.auditId ? 1 : 0;
      });
      return records.slice(0, limit);
    } catch { throw new AuditStorageUnavailableError(); }
  };
  const currentAudit = key => materializeCanonicalAuditModel(
    key,
    initial.get(key),
    { allowMissing: true },
  );
  const snapshot = id => {
    const key = validId(id);
    return mintAuditSnapshot(owner, key, currentAudit(key), initial.get(revisionKey(key)));
  };
  const writeAudit = (id, model, latestState, snapshotCapability, options = {}) => {
    const key = validId(id);
    const modelClone = storageClone(materializeCanonicalAuditModel(key, model));
    const latestClone = latestState === undefined ? undefined : storageClone(latestState);
    const currentModel = currentAudit(key);
    const currentRevision = storedRevision(initial.get(revisionKey(key)));
    const expectedRevision = snapshotCapability === undefined
      ? undefined
      : capabilityRevision(snapshotCapability, owner, key);
    if (expectedRevision !== undefined && (currentModel === undefined || currentRevision !== expectedRevision)) {
      throw new AuditRevisionConflictError();
    }
    const revision = currentRevision + 1;
    const reviewLatest = options.review === true
      ? reviewLatestState(initial.get(LATEST_KEY), key, modelClone, revision)
      : undefined;
    const currentRetention = retention.get(key);
    const firstRetention = currentRetention === undefined
      ? createRetentionMetadata(
          key,
          options.now ?? clock(),
          options.deleteAfterCompleteExport === true,
        )
      : validateRetentionMetadata(currentRetention, key);
    const migratedAttempt = options.keepExportLease === true
      ? null
      : migrateExportAttemptBeforeLeaseRemoval(
          initial.get(exportAttemptKey(key)), initial.get(exportLeaseKey(key)), key,
        );
    initial.set(key, modelClone);
    initial.set(revisionKey(key), revision);
    if (currentRetention === undefined) retention.set(key, firstRetention);
    if (options.keepExportLease !== true) {
      if (migratedAttempt !== null) initial.set(exportAttemptKey(key), migratedAttempt);
      initial.delete(exportLeaseKey(key));
    }
    if (options.review === true) {
      if (reviewLatest !== undefined) initial.set(LATEST_KEY, reviewLatest);
    } else if (latestState !== undefined) initial.set(LATEST_KEY, latestClone);
    return { revision, capability: mintAuditSnapshot(owner, key, modelClone, revision).capability };
  };
  const acquireExportLease = (id, snapshotCapability, options) => {
    const key = validId(id);
    const revision = capabilityRevision(snapshotCapability, owner, key);
    const currentModel = currentAudit(key);
    const currentRevision = storedRevision(initial.get(revisionKey(key)));
    if (currentModel === undefined || currentRevision !== revision) throw new AuditRevisionConflictError();
    const normalized = canonicalLeaseOptions(options, revision, 'queued');
    const leaseValue = initial.get(exportLeaseKey(key));
    let attemptValue = initial.get(exportAttemptKey(key));
    if (leaseValue !== undefined) {
      const persistedLease = activeExportLease(leaseValue, key, revision, Number.NEGATIVE_INFINITY);
      if (!persistedLease) throw new TypeError('Concessão armazenada da exportação inválida.');
      attemptValue = correlatedExportAttemptRecord(attemptValue, key, persistedLease);
    }
    const existing = activeExportLease(leaseValue, key, revision, normalized.nowMs);
    if (existing) {
      return {
        acquired: false, busy: true, retryAt: existing.expiresAt,
        revision, exportAttempt: existing.exportAttempt,
      };
    }
    const allocation = nextExportAttempt(
      attemptValue, initial.get(LATEST_KEY), key, normalized.now,
    );
    const { exportAttempt, deliveryAt } = allocation;
    const deliveryEntries = canonicalDeliveryJournal(initial.get(exportDeliveryKey(key)), key);
    const ownerId = normalized.ownerId === `export:${key}:pending`
      ? `export:${key}:${exportAttempt}`
      : normalized.ownerId;
    const lease = exportLeaseRecord(key, { ...normalized, ownerId, exportAttempt, deliveryAt });
    initial.set(exportLeaseKey(key), lease);
    initial.set(exportAttemptKey(key), exportAttemptRecord(key, exportAttempt, deliveryAt));
    if (normalized.latestState !== undefined) {
      initial.set(LATEST_KEY, pendingCleanupLatest({ ...normalized.latestState, exportAttempt }, deliveryEntries));
    }
    return { acquired: true, busy: false, revision, exportAttempt, deliveryAt, expiresAt: lease.expiresAt };
  };
  const claimExportLease = (id, snapshotCapability, options) => {
    const key = validId(id);
    const revision = capabilityRevision(snapshotCapability, owner, key);
    const currentModel = currentAudit(key);
    const currentRevision = storedRevision(initial.get(revisionKey(key)));
    if (currentModel === undefined || currentRevision !== revision) throw new AuditRevisionConflictError();
    const normalized = canonicalLeaseOptions({ ...options, phase: 'running' }, revision, 'running');
    const existing = activeExportLease(initial.get(exportLeaseKey(key)), key, revision, normalized.nowMs);
    if (!existing || existing.ownerId !== normalized.ownerId || existing.phase !== 'queued' ||
      (normalized.exportAttempt !== undefined && normalized.exportAttempt !== existing.exportAttempt)) {
      throw new AuditExportLeaseConflictError();
    }
    const attemptRecord = correlatedExportAttemptRecord(initial.get(exportAttemptKey(key)), key, existing);
    const deliveryEntries = canonicalDeliveryJournal(initial.get(exportDeliveryKey(key)), key);
    const lease = exportLeaseRecord(key, {
      ...monotonicLeaseTransition(normalized, existing),
      exportAttempt: existing.exportAttempt,
    }, existing.acquiredAt);
    initial.set(exportLeaseKey(key), lease);
    initial.set(exportAttemptKey(key), attemptRecord);
    if (normalized.latestState !== undefined) {
      initial.set(LATEST_KEY, pendingCleanupLatest(
        { ...normalized.latestState, exportAttempt: existing.exportAttempt }, deliveryEntries,
      ));
    }
    return {
      claimed: true, revision, exportAttempt: existing.exportAttempt,
      deliveryAt: existing.deliveryAt, expiresAt: lease.expiresAt,
    };
  };
  const beginExportDelivery = (id, snapshotCapability, options) => {
    const key = validId(id);
    const revision = capabilityRevision(snapshotCapability, owner, key);
    const currentModel = currentAudit(key);
    const currentRevision = storedRevision(initial.get(revisionKey(key)));
    if (currentModel === undefined || currentRevision !== revision) throw new AuditRevisionConflictError();
    const normalized = canonicalLeaseOptions({ ...options, phase: 'delivering' }, revision, 'delivering');
    const existing = activeExportLease(initial.get(exportLeaseKey(key)), key, revision, normalized.nowMs);
    if (!existing || existing.ownerId !== normalized.ownerId || existing.phase !== 'running' ||
      (normalized.exportAttempt !== undefined && normalized.exportAttempt !== existing.exportAttempt)) {
      throw new AuditExportLeaseConflictError();
    }
    const attemptRecord = correlatedExportAttemptRecord(initial.get(exportAttemptKey(key)), key, existing);
    const deliveryEntries = canonicalDeliveryJournal(initial.get(exportDeliveryKey(key)), key);
    const lease = exportLeaseRecord(key, {
      ...monotonicLeaseTransition(normalized, existing), exportAttempt: existing.exportAttempt,
    }, existing.acquiredAt);
    initial.set(exportLeaseKey(key), lease);
    initial.set(exportAttemptKey(key), attemptRecord);
    if (normalized.latestState !== undefined) initial.set(LATEST_KEY, pendingCleanupLatest(
      { ...normalized.latestState, exportAttempt: existing.exportAttempt }, deliveryEntries,
    ));
    return {
      delivering: true, revision, exportAttempt: existing.exportAttempt,
      deliveryAt: existing.deliveryAt, expiresAt: lease.expiresAt,
    };
  };
  const commitAuditIfRevisionWithExportLease = (id, model, latestState, snapshotCapability, options) => {
    const key = validId(id);
    const revision = capabilityRevision(snapshotCapability, owner, key);
    const currentModel = currentAudit(key);
    const currentRevision = storedRevision(initial.get(revisionKey(key)));
    if (currentModel === undefined || currentRevision !== revision) throw new AuditRevisionConflictError();
    const normalized = canonicalLeaseOptions(options, revision, options?.phase ?? 'delivering');
    const existing = activeExportLease(initial.get(exportLeaseKey(key)), key, revision, normalized.nowMs);
    if (!existing || existing.ownerId !== normalized.ownerId ||
      (normalized.exportAttempt !== undefined && normalized.exportAttempt !== existing.exportAttempt) ||
      (!normalized.release && (existing.phase !== 'running' || normalized.phase !== 'delivering')) ||
      (normalized.release && !['queued', 'running', 'delivering'].includes(existing.phase))) {
      throw new AuditExportLeaseConflictError();
    }
    const attemptRecord = correlatedExportAttemptRecord(initial.get(exportAttemptKey(key)), key, existing);
    const deliveryEntries = canonicalDeliveryJournal(initial.get(exportDeliveryKey(key)), key);
    const latestWithAttempt = latestState === undefined
      ? undefined
      : pendingCleanupLatest(
          { ...storageClone(latestState), exportAttempt: existing.exportAttempt },
          normalized.clearDeliveryJournal ? [] : deliveryEntries,
        );
    if (normalized.clearDeliveryJournal && (!normalized.release || deliveryEntries.some(entry =>
      entry.ownerId !== normalized.ownerId || entry.exportAttempt !== existing.exportAttempt || entry.state !== 'terminal'))) {
      throw new AuditExportLeaseConflictError('Existem arquivos obsoletos pendentes de reconciliação.');
    }
    const result = writeAudit(key, model, latestWithAttempt, snapshotCapability, { keepExportLease: true });
    initial.set(exportAttemptKey(key), attemptRecord);
    if (normalized.release) {
      initial.delete(exportLeaseKey(key));
      if (normalized.clearDeliveryJournal) initial.delete(exportDeliveryKey(key));
    } else {
      initial.set(exportLeaseKey(key), exportLeaseRecord(key, {
        ...monotonicLeaseTransition(normalized, existing),
        revision: result.revision,
        exportAttempt: existing.exportAttempt,
      }, existing.acquiredAt));
    }
    return result;
  };
  const releaseExportLease = (id, options) => {
    const key = validId(id);
    currentAudit(key);
    const revision = storedRevision(initial.get(revisionKey(key)));
    const normalized = canonicalLeaseOptions(options, revision);
    const existing = activeExportLease(initial.get(exportLeaseKey(key)), key, revision, normalized.nowMs);
    if (!existing || existing.ownerId !== normalized.ownerId) return false;
    initial.set(exportAttemptKey(key), correlatedExportAttemptRecord(
      initial.get(exportAttemptKey(key)), key, existing,
    ));
    initial.delete(exportLeaseKey(key));
    return true;
  };
  const getExportLeaseState = (id, options) => {
    const key = validId(id);
    const currentModel = currentAudit(key);
    const revision = storedRevision(initial.get(revisionKey(key)));
    const instant = canonicalLeaseNow(options?.now);
    const existing = currentModel !== undefined
      ? activeExportLease(initial.get(exportLeaseKey(key)), key, revision, instant.nowMs)
      : null;
    return existing
      ? {
          active: true, phase: existing.phase, retryAt: existing.expiresAt,
          revision, exportAttempt: existing.exportAttempt, ownerId: existing.ownerId,
        }
      : { active: false, revision };
  };
  const assertExportLease = (id, snapshotCapability, options) => {
    const key = validId(id);
    const expected = capabilityRevision(snapshotCapability, owner, key);
    const currentModel = currentAudit(key);
    const revision = storedRevision(initial.get(revisionKey(key)));
    if (currentModel === undefined || revision !== expected) throw new AuditRevisionConflictError();
    const normalized = canonicalLeaseOptions(options, revision, options?.phase ?? 'delivering');
    const existing = activeExportLease(initial.get(exportLeaseKey(key)), key, revision, normalized.nowMs);
    if (!existing || existing.ownerId !== normalized.ownerId || existing.phase !== normalized.phase ||
      (normalized.exportAttempt !== undefined && normalized.exportAttempt !== existing.exportAttempt)) {
      throw new AuditExportLeaseConflictError();
    }
    correlatedExportAttemptRecord(initial.get(exportAttemptKey(key)), key, existing);
    return {
      active: true, phase: existing.phase, retryAt: existing.expiresAt,
      revision, exportAttempt: existing.exportAttempt, deliveryAt: existing.deliveryAt,
    };
  };
  const recordExportDelivery = (id, snapshotCapability, options) => {
    const key = validId(id);
    const expected = capabilityRevision(snapshotCapability, owner, key);
    const currentModel = currentAudit(key);
    const revision = storedRevision(initial.get(revisionKey(key)));
    if (currentModel === undefined || revision !== expected) throw new AuditRevisionConflictError();
    const normalized = canonicalDeliveryOptions(options);
    const existing = activeExportLease(initial.get(exportLeaseKey(key)), key, revision, normalized.nowMs);
    if (!existing || existing.ownerId !== normalized.ownerId || existing.exportAttempt !== normalized.exportAttempt ||
      existing.phase !== 'delivering') throw new AuditExportLeaseConflictError();
    const attemptRecord = correlatedExportAttemptRecord(initial.get(exportAttemptKey(key)), key, existing);
    const entries = updateDeliveryEntries(
      canonicalDeliveryJournal(initial.get(exportDeliveryKey(key)), key), normalized,
    );
    const latest = initial.get(LATEST_KEY);
    const nextLatest = latest?.auditId === key ? pendingCleanupLatest(latest, entries) : undefined;
    initial.set(exportAttemptKey(key), attemptRecord);
    initial.set(exportDeliveryKey(key), deliveryJournalRecord(key, entries));
    if (nextLatest !== undefined) initial.set(LATEST_KEY, nextLatest);
    return storageClone(entries.find(entry => entry.ownerId === normalized.ownerId &&
      entry.exportAttempt === normalized.exportAttempt && entry.format === normalized.format));
  };
  const resolveExportDelivery = (id, options) => {
    const key = validId(id);
    currentAudit(key);
    const normalized = canonicalDeliveryOptions(options, true);
    const current = canonicalDeliveryJournal(initial.get(exportDeliveryKey(key)), key);
    const resolved = resolveDeliveryEntries(current, normalized);
    if (!resolved.matched) return false;
    const latest = initial.get(LATEST_KEY);
    const nextLatest = latest?.auditId === key
      ? pendingCleanupLatest(latest, resolved.entries)
      : undefined;
    if (resolved.entries.length === 0) initial.delete(exportDeliveryKey(key));
    else initial.set(exportDeliveryKey(key), deliveryJournalRecord(key, resolved.entries));
    if (nextLatest !== undefined) initial.set(LATEST_KEY, nextLatest);
    return true;
  };
  const getExportDeliveryJournal = id => {
    const key = validId(id);
    currentAudit(key);
    return canonicalDeliveryJournal(initial.get(exportDeliveryKey(key)), key);
  };
  const deleteStoredAudit = key => {
    initial.delete(key);
    initial.delete(revisionKey(key));
    initial.delete(checkpointKey(key));
    initial.delete(pixelAttemptKey(key));
    initial.delete(exportLeaseKey(key));
    initial.delete(exportAttemptKey(key));
    initial.delete(exportDeliveryKey(key));
    initial.delete(exportReceiptKey(key));
    retention.delete(key);
    if (initial.get(LATEST_KEY)?.auditId === key) initial.delete(LATEST_KEY);
  };
  const hasDeliveryWork = (key, nowMs) => {
    currentAudit(key);
    const revision = storedRevision(initial.get(revisionKey(key)));
    const lease = activeExportLease(initial.get(exportLeaseKey(key)), key, revision, nowMs);
    const journal = canonicalDeliveryJournal(initial.get(exportDeliveryKey(key)), key);
    return Boolean(lease) || journal.length > 0;
  };
  const markAuditInterrupted = (id, latestState, options) => {
    const key = validId(id);
    const failedLatest = interruptedLatest(key, latestState);
    const instant = canonicalLeaseNow(options?.now);
    const model = currentAudit(key);
    const currentLatest = initial.get(LATEST_KEY);
    if (currentLatest?.auditId !== key) return { updated: false, reason: 'stale' };
    if (isTerminalAuditStatus(model?.session?.status) ||
      isTerminalAuditStatus(currentLatest.status)) {
      return { updated: false, reason: 'terminal' };
    }
    if (!isInterruptibleAuditStatus(currentLatest.status)) return { updated: false, reason: 'stale' };
    if (hasDeliveryWork(key, instant.nowMs)) return { updated: false, reason: 'delivery-active' };
    initial.set(LATEST_KEY, failedLatest);
    return { updated: true, reason: 'interrupted' };
  };
  const finalizeExportAndMaybeDelete = (id, model, latestState, snapshotCapability, options) => {
    const key = validId(id);
    const canonicalModel = materializeCanonicalAuditModel(key, model);
    const currentModel = currentAudit(key);
    assertFinalizationCorrelation(key, canonicalModel, latestState);
    if (options?.clearDeliveryJournal !== true || typeof options?.deleteAfterCompleteExport !== 'boolean') {
      throw new TypeError('Finalização de exportação inválida.');
    }
    const revision = capabilityRevision(snapshotCapability, owner, key);
    const currentRevision = storedRevision(initial.get(revisionKey(key)));
    if (currentModel === undefined || currentRevision !== revision) throw new AuditRevisionConflictError();
    const normalized = canonicalLeaseOptions({ ...options, release: true }, revision);
    const existing = activeExportLease(initial.get(exportLeaseKey(key)), key, revision, normalized.nowMs);
    if (!existing || existing.ownerId !== normalized.ownerId ||
      existing.exportAttempt !== normalized.exportAttempt ||
      !['queued', 'running', 'delivering'].includes(existing.phase)) {
      throw new AuditExportLeaseConflictError();
    }
    correlatedExportAttemptRecord(initial.get(exportAttemptKey(key)), key, existing);
    const entries = canonicalDeliveryJournal(initial.get(exportDeliveryKey(key)), key);
    if (entries.some(entry => entry.ownerId !== existing.ownerId ||
      entry.exportAttempt !== existing.exportAttempt || entry.state !== 'terminal') ||
      !terminalDeliveriesMatchReceipt(entries, latestState, key, existing.ownerId, existing.exportAttempt)) {
      throw new AuditExportLeaseConflictError('Existem arquivos obsoletos pendentes de reconciliação.');
    }
    validateRetentionMetadata(retention.get(key), key);
    const receipt = exportReceiptFromLatest(latestState, key);
    if (receipt && (receipt.modelRevision !== revision || receipt.attemptId !== String(existing.exportAttempt))) {
      throw new AuditExportLeaseConflictError();
    }
    const committed = commitAuditIfRevisionWithExportLease(
      key,
      canonicalModel,
      latestState,
      snapshotCapability,
      { ...options, release: true },
    );
    if (receipt) initial.set(exportReceiptKey(key), receipt);
    else initial.delete(exportReceiptKey(key));
    return { ...committed, deleted: false };
  };
  const commitAuditWithCheckpointIfAbsent = async (id, model, checkpoint, latestState, options) => {
    const normalizedOptions = exactTerminalOptions(options);
    const terminal = await canonicalTerminalGraph(id, model, checkpoint, latestState);
    const commit = async pixelAttempt => {
      if (pixelAttempt && pixelAttempt.auditId !== terminal.key) throw new TypeError('Commit terminal inválido.');
      if (currentAudit(terminal.key) !== undefined || storedRevision(initial.get(revisionKey(terminal.key))) !== 0 ||
        initial.has(checkpointKey(terminal.key)) || initial.has(pixelAttemptKey(terminal.key))) throw new AuditRevisionConflictError();
      const modelClone = storageClone(terminal.model);
      initial.set(terminal.key, modelClone);
      initial.set(checkpointKey(terminal.key), checkpointCompanion(terminal.key, terminal.checkpoint));
      if (pixelAttempt) {
        initial.set(pixelAttemptKey(terminal.key), pixelAttemptCompanion(pixelAttempt, normalizedOptions.now));
      }
      initial.set(revisionKey(terminal.key), 1);
      initial.set(LATEST_KEY, storageClone(terminal.latest));
      retention.set(terminal.key, createRetentionMetadata(terminal.key, normalizedOptions.now, false));
      const capability = mintAuditSnapshot(owner, terminal.key, modelClone, 1).capability;
      return Object.freeze({ revision: 1, modelHash: terminal.model.integrity.canonicalModelHash, capability });
    };
    return normalizedOptions.pixelAttemptCommit
      ? runPixelAttemptCommitAuthorizationV1(normalizedOptions.pixelAttemptCommit, api, commit)
      : commit(null);
  };
  const getReportRevision = async id => {
    try {
      const key = validId(id);
      const rawModel = initial.get(key);
      const rawRevision = initial.get(revisionKey(key));
      const rawCompanion = initial.get(checkpointKey(key));
      if (rawModel === undefined && rawRevision === undefined && rawCompanion === undefined) return null;
      const model = await verifyAuditIntegritySnapshot(rawModel);
      const revision = storedRevision(rawRevision);
      if (model.auditId !== key || !Number.isSafeInteger(revision) || revision < 1 ||
        !['complete', 'partial', 'failed', 'cancelled'].includes(model.session.status) ||
        !/^[a-f0-9]{64}$/u.test(model.integrity.canonicalModelHash)) throw new Error();
      const checkpoint = parseCheckpointCompanion(rawCompanion, key, model);
      return freezeStored({
        version: 1, auditId: key, modelRevision: revision,
        modelHash: model.integrity.canonicalModelHash, model, checkpoint: storageClone(checkpoint),
      });
    } catch (error) {
      if (error instanceof AuditStorageUnavailableError) throw error;
      throw new AuditStorageUnavailableError();
    }
  };
  const api = {
    async setAudit(id, model, options) { return writeAudit(id, model, undefined, undefined, options); },
    async listAuditDeletionCandidatesV1() {
      return Object.freeze([...retention.keys()].sort().map(auditId =>
        manualDeletionCandidate(auditId, initial.get(auditId), initial.get(revisionKey(auditId)))).filter(Boolean));
    },
    async getAudit(id) { return snapshot(id).model; },
    async getAuditSnapshot(id) { return snapshot(id); },
    commitAuditWithCheckpointIfAbsent,
    getReportRevision,
    async setLatest(state) { initial.set(LATEST_KEY, storageClone(state)); },
    async getLatest() { return storageClone(initial.get(LATEST_KEY)); },
    async markAuditInterrupted(id, latestState, options) {
      return markAuditInterrupted(id, latestState, options);
    },
    async commitAudit(id, model, latestState, options) {
      return writeAudit(id, model, latestState, undefined, options);
    },
    async commitAuditIfRevision(id, model, latestState, snapshotCapability) {
      return writeAudit(id, model, latestState, snapshotCapability);
    },
    async commitAuditReviewIfRevision(id, model, snapshotCapability) {
      const transition = await canonicalReviewTransition(id, model, snapshotCapability, owner);
      return writeAudit(
        id,
        transition,
        undefined,
        snapshotCapability,
        { review: true },
      );
    },
    async acquireExportLease(id, snapshotCapability, options) {
      return acquireExportLease(id, snapshotCapability, options);
    },
    async claimExportLease(id, snapshotCapability, options) {
      return claimExportLease(id, snapshotCapability, options);
    },
    async beginExportDelivery(id, snapshotCapability, options) {
      return beginExportDelivery(id, snapshotCapability, options);
    },
    async commitAuditIfRevisionWithExportLease(id, model, latestState, snapshotCapability, options) {
      return commitAuditIfRevisionWithExportLease(id, model, latestState, snapshotCapability, options);
    },
    async releaseExportLease(id, options) { return releaseExportLease(id, options); },
    async getExportLeaseState(id, options) { return getExportLeaseState(id, options); },
    async assertExportLease(id, snapshotCapability, options) {
      return assertExportLease(id, snapshotCapability, options);
    },
    async recordExportDelivery(id, snapshotCapability, options) {
      return recordExportDelivery(id, snapshotCapability, options);
    },
    async resolveExportDelivery(id, options) { return resolveExportDelivery(id, options); },
    async getExportDeliveryJournal(id) { return storageClone(getExportDeliveryJournal(id)); },
    async getExportReceipt(id) {
      const key = validId(id); const entries = getExportDeliveryJournal(key);
      if (entries.length) return exportReceiptFromRevision(await getReportRevision(key), entries);
      return confirmedReceipt(initial.get(exportReceiptKey(key)), key, storedRevision(initial.get(revisionKey(key)))) ??
        exportReceiptFromLatest(initial.get(LATEST_KEY), key);
    },
    async getAuditRetention(id) {
      const key = validId(id);
      const value = retention.get(key);
      return value === undefined ? undefined : storageClone(validateRetentionMetadata(value, key));
    },
    async nextExpiresAtV1() {
      return selectRetainedAuditsV1(null, 1)[0]?.expiresAt ?? null;
    },
    async stageExpiredAuditDeletionsV1(value) {
      const { now, limit } = expirationSelectionRequestV1(value);
      const candidates = selectRetainedAuditsV1(now, limit);
      return stageSelectedAuditDeletionsV1(candidates, now, request => api.stageAuditDeletionV1(request));
    },
    async stageAuditDeletionV1(value) {
      const request = deletionRequestV1(value);
      if (!request) return deniedDeletion();
      const { auditId, now } = request;
      if (deletions.has(auditId)) return stagedDeletion(deletions.get(auditId), auditId);
      if (initial.get(auditId) === undefined) return deniedDeletion();
      if (['manual', 'post-export'].includes(request.reason)) {
        if (storedRevision(initial.get(revisionKey(auditId))) !== request.expectedRevision ||
          hasDeliveryWork(auditId, canonicalRetentionInstant(now).milliseconds)) return deniedDeletion();
        if (request.reason === 'post-export' && !eligiblePostExport(request, initial.get(exportReceiptKey(auditId)),
          retention.get(auditId), request.expectedRevision)) return deniedDeletion();
      } else {
        const metadata = retention.get(auditId);
        if (metadata === undefined || validateRetentionMetadata(metadata, auditId).expiresAt > now) return deniedDeletion();
      }
      const tombstone = createDeletionTombstoneV1({ auditId, requestedAt: now, reason: request.reason });
      deleteStoredAudit(auditId);
      deletions.set(auditId, tombstone);
      return stagedDeletion(tombstone, auditId);
    },
    async listDeletionTombstonesV1(value) {
      const { limit } = deletionOperationV1(value, ['limit']);
      return Object.freeze([...deletions.keys()].sort().slice(0, limit)
        .map(auditId => validateDeletionTombstoneV1(deletions.get(auditId), auditId)));
    },
    async recordDeletionCleanupFailureV1(value) {
      const { auditId, at } = deletionOperationV1(value, ['auditId', 'at']);
      const record = deletions.get(auditId);
      if (record === undefined) return false;
      deletions.set(auditId, nextDeletionFailure(validateDeletionTombstoneV1(record, auditId), at));
      return true;
    },
    async completeAuditDeletionV1(value) {
      const { auditId } = deletionOperationV1(value, ['auditId']);
      if (!deletions.has(auditId)) return false;
      validateDeletionTombstoneV1(deletions.get(auditId), auditId);
      return deletions.delete(auditId);
    },
    async setRetentionIntent(id, snapshotCapability, options) {
      const key = validId(id);
      canonicalRetentionInstant(options?.now);
      if (typeof options?.deleteAfterCompleteExport !== 'boolean') {
        throw new TypeError('Intenção de retenção inválida.');
      }
      const expected = capabilityRevision(snapshotCapability, owner, key);
      const currentModel = currentAudit(key);
      const revision = storedRevision(initial.get(revisionKey(key)));
      if (currentModel === undefined || revision !== expected) throw new AuditRevisionConflictError();
      const current = validateRetentionMetadata(retention.get(key), key);
      const next = Object.freeze({
        ...current,
        deleteAfterCompleteExport: options.deleteAfterCompleteExport,
      });
      retention.set(key, next);
      return {
        revision,
        capability: mintAuditSnapshot(owner, key, currentModel, revision).capability,
        retention: storageClone(next),
      };
    },
    async cleanupExpiredAudits(options) {
      const instant = canonicalRetentionInstant(options?.now);
      const limit = options?.limit ?? 25;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 25) {
        throw new TypeError('Limite de limpeza inválido.');
      }
      const expired = [...retention.values()]
        .map(value => validateRetentionMetadata(value, value.auditId))
        .filter(value => new Date(value.expiresAt).getTime() <= instant.milliseconds)
        .sort((a, b) => a.expiresAt.localeCompare(b.expiresAt) || a.auditId.localeCompare(b.auditId));
      const marker = cleanupCursorRecord(initial.get(RETENTION_CLEANUP_CURSOR_KEY));
      let candidates = marker
        ? expired.filter(value => compareRetentionPosition(value, marker) > 0).slice(0, limit)
        : expired.slice(0, limit);
      if (marker && candidates.length === 0 && expired.length > 0) {
        candidates = expired.slice(0, limit);
      }
      for (const candidate of candidates) currentAudit(candidate.auditId);
      if (marker && compareRetentionPosition(candidates[0] ?? marker, marker) <= 0) {
        initial.delete(RETENTION_CLEANUP_CURSOR_KEY);
      }
      let deleted = 0;
      let blocked = 0;
      for (const candidate of candidates) {
        if (hasDeliveryWork(candidate.auditId, instant.milliseconds)) {
          blocked += 1;
          continue;
        }
        deleteStoredAudit(candidate.auditId);
        deleted += 1;
      }
      if (candidates.length === limit) {
        const last = candidates.at(-1);
        initial.set(RETENTION_CLEANUP_CURSOR_KEY, {
          schemaVersion: 1,
          expiresAt: last.expiresAt,
          auditId: last.auditId,
        });
      } else {
        initial.delete(RETENTION_CLEANUP_CURSOR_KEY);
      }
      return { scanned: candidates.length, deleted, remaining: expired.length - deleted, blocked };
    },
    async deleteAudit(id, snapshotCapability, options) {
      const key = validId(id);
      const instant = canonicalRetentionInstant(options?.now);
      const expected = capabilityRevision(snapshotCapability, owner, key);
      const currentModel = currentAudit(key);
      const revision = storedRevision(initial.get(revisionKey(key)));
      if (currentModel === undefined || revision !== expected) throw new AuditRevisionConflictError();
      if (hasDeliveryWork(key, instant.milliseconds)) throw new AuditDeleteBusyError();
      deleteStoredAudit(key);
      return { deleted: true };
    },
    async deleteAllAudits(options) {
      const instant = canonicalRetentionInstant(options?.now);
      const auditIds = [...retention.keys()].filter(key => initial.has(key));
      for (const key of auditIds) currentAudit(key);
      if (auditIds.some(key => hasDeliveryWork(key, instant.milliseconds))) {
        throw new AuditDeleteBusyError();
      }
      for (const key of auditIds) deleteStoredAudit(key);
      return { deleted: auditIds.length };
    },
    async finalizeExportAndMaybeDelete(id, model, latestState, snapshotCapability, options) {
      return finalizeExportAndMaybeDelete(id, model, latestState, snapshotCapability, options);
    },
  };
  PRIVATE_PIXEL_ATTEMPT_STORES.set(api, Object.freeze({
    async read(value) {
      const expected = pixelAttemptCorrelation(value);
      if (!expected) return false;
      const rawModel = initial.get(expected.auditId);
      const revision = storedRevision(initial.get(revisionKey(expected.auditId)));
      const companion = parsePixelAttemptCompanion(initial.get(pixelAttemptKey(expected.auditId)), expected.auditId);
      if (!rawModel || revision !== 1 || !companion || !samePixelAttempt(companion, expected)) return false;
      try {
        const model = await verifyAuditIntegritySnapshot(rawModel);
        return model.auditId === expected.auditId && ['complete', 'partial', 'failed', 'cancelled'].includes(model.session.status);
      } catch { return false; }
    },
    async remove(value) {
      const expected = pixelAttemptCorrelation(value);
      if (!expected) return false;
      if (!initial.has(pixelAttemptKey(expected.auditId))) return true;
      const current = parsePixelAttemptCompanion(initial.get(pixelAttemptKey(expected.auditId)), expected.auditId);
      if (!samePixelAttempt(current, expected)) return false;
      initial.delete(pixelAttemptKey(expected.auditId));
      return !initial.has(pixelAttemptKey(expected.auditId));
    },
  }));
  return api;
}

function createUnavailableAuditStore() {
  const unavailable = async () => { throw new AuditStorageUnavailableError(); };
  return Object.freeze({
    setAudit: unavailable,
    getAudit: unavailable,
    getAuditSnapshot: unavailable,
    setLatest: unavailable,
    getLatest: unavailable,
    markAuditInterrupted: unavailable,
    commitAudit: unavailable,
    commitAuditWithCheckpointIfAbsent: unavailable,
    getReportRevision: unavailable,
    commitAuditIfRevision: unavailable,
    commitAuditReviewIfRevision: unavailable,
    acquireExportLease: unavailable,
    claimExportLease: unavailable,
    beginExportDelivery: unavailable,
    commitAuditIfRevisionWithExportLease: unavailable,
    releaseExportLease: unavailable,
    getExportLeaseState: unavailable,
    assertExportLease: unavailable,
    recordExportDelivery: unavailable,
    resolveExportDelivery: unavailable,
    getExportDeliveryJournal: unavailable,
    getExportReceipt: unavailable,
    getAuditRetention: unavailable,
    nextExpiresAtV1: unavailable,
    stageExpiredAuditDeletionsV1: unavailable,
    stageAuditDeletionV1: unavailable,
    listAuditDeletionCandidatesV1: unavailable,
    listDeletionTombstonesV1: unavailable,
    recordDeletionCleanupFailureV1: unavailable,
    completeAuditDeletionV1: unavailable,
    setRetentionIntent: unavailable,
    cleanupExpiredAudits: unavailable,
    deleteAudit: unavailable,
    deleteAllAudits: unavailable,
    finalizeExportAndMaybeDelete: unavailable,
  });
}

export function createAuditStore(options = {}) {
  const factory = Object.hasOwn(options, 'indexedDB') ? options.indexedDB : globalThis.indexedDB;
  if (!factory || typeof factory.open !== 'function') return createUnavailableAuditStore();
  const clock = typeof options.now === 'function' ? options.now : () => new Date().toISOString();
  const keyRange = options.IDBKeyRange ?? globalThis.IDBKeyRange;
  let database = null;
  let opening = null;
  const owner = Object.freeze(Object.create(null));
  // As operações de concessão e de journal da exportação só precisam saber que o modelo armazenado existe e é
  // válido naquela revisão, mas cada uma revalidava o modelo inteiro. Em páginas com dezenas de milhares de
  // ocorrências isso custa segundos por chamada, e a exportação faz dezenas delas: os prazos de 30 s estouravam
  // e os downloads já concluídos eram desfeitos (1.1.53). A validação completa roda uma vez por revisão; toda
  // gravação de modelo incrementa a revisão, e a impressão digital inclui o hash canônico completo.
  const validatedAudits = new Map();
  const presentCanonicalAudit = (key, value, revision) => {
    if (value === undefined) {
      validatedAudits.delete(key);
      return materializeCanonicalAuditModel(key, value, { allowMissing: true });
    }
    const hash = value && typeof value === 'object' && value.integrity && typeof value.integrity === 'object'
      ? value.integrity.canonicalModelHash
      : undefined;
    const fingerprint = value?.auditId === key && typeof hash === 'string' && /^[a-f0-9]{64}$/u.test(hash) &&
      Number.isSafeInteger(revision)
      ? `${revision}:${value.schemaVersion}:${hash}`
      : null;
    if (fingerprint !== null && validatedAudits.get(key) === fingerprint) return value;
    const canonical = materializeCanonicalAuditModel(key, value, { allowMissing: true });
    if (fingerprint !== null && canonical?.integrity?.canonicalModelHash === hash) validatedAudits.set(key, fingerprint);
    else validatedAudits.delete(key);
    return canonical;
  };
  const open = async () => {
    if (database) return database;
    if (opening) return opening;
    let request;
    try {
      request = indexedDbBoundary(() => factory.open(DB_NAME, 3));
    } catch (error) {
      opening = null;
      throw error;
    }
    opening = new Promise((resolve, reject) => {
      let settled = false;
      const fail = error => {
        if (settled) return;
        settled = true;
        opening = null;
        reject(error instanceof AuditStorageUnavailableError ? error : new AuditStorageUnavailableError());
      };
      request.onupgradeneeded = event => {
        try {
          const db = request.result;
          const transaction = request.transaction;
          const auditStore = indexedDbBoundary(() => db.objectStoreNames.contains(STORE_NAME), transaction)
            ? indexedDbObjectStore(transaction, () => transaction.objectStore(STORE_NAME))
            : indexedDbObjectStore(transaction, () => db.createObjectStore(STORE_NAME));
          const retentionStore = indexedDbBoundary(() => db.objectStoreNames.contains(RETENTION_STORE_NAME), transaction)
            ? indexedDbObjectStore(transaction, () => transaction.objectStore(RETENTION_STORE_NAME))
            : indexedDbObjectStore(transaction, () => db.createObjectStore(RETENTION_STORE_NAME, { keyPath: 'auditId' }));
          if (!indexedDbBoundary(() => db.objectStoreNames.contains(DELETION_STORE_NAME), transaction)) {
            indexedDbBoundary(() => db.createObjectStore(DELETION_STORE_NAME, { keyPath: 'auditId' }), transaction);
          }
          if (!indexedDbBoundary(() => retentionStore.indexNames.contains('byExpiresAt'), transaction)) {
            retentionStore.createIndex('byExpiresAt', 'expiresAt', { unique: false });
          }
          if ((event?.oldVersion ?? 0) >= 1 && (event?.oldVersion ?? 0) < 2) {
            const cursorRequest = auditStore.openCursor();
            cursorRequest.onsuccess = () => {
              const cursor = cursorRequest.result;
              if (!cursor) return;
              const auditId = cursor.key;
              if (isPrivateAuditKey(auditId)) {
                if (!legacyPrivateAuditKeyIsSafe(auditId, cursor.value)) {
                  indexedDbBoundary(() => cursor.delete(), transaction);
                }
              } else {
                try {
                  retentionStore.put(migrateRetentionMetadata(auditId, cursor.value));
                } catch {
                  indexedDbBoundary(() => cursor.delete(), transaction);
                }
              }
              continueIndexedDbCursor(transaction, cursor, 'continue');
            };
            cursorRequest.onerror = () => {
              try { transaction.abort(); } catch {}
            };
          }
        } catch {
          try { request.transaction?.abort(); } catch {}
        }
      };
      request.onblocked = () => fail(new AuditStorageUnavailableError());
      request.onerror = () => fail(new AuditStorageUnavailableError());
      request.onsuccess = () => {
        const db = request.result;
        if (settled) {
          db.close();
          return;
        }
        settled = true;
        database = db;
        opening = null;
        db.onversionchange = () => {
          db.close();
          if (database === db) database = null;
          opening = null;
        };
        resolve(db);
      };
    });
    return opening;
  };
  const write = async entries => {
    const db = await open();
    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (handler, value) => { if (!settled) { settled = true; handler(value); } };
      const transaction = indexedDbBoundary(() => db.transaction(STORE_NAME, 'readwrite'));
      const store = indexedDbObjectStore(transaction, () => transaction.objectStore(STORE_NAME));
      for (const [key, value] of entries) store.put(value, key);
      transaction.oncomplete = () => finish(resolve);
      transaction.onerror = () => finish(reject, new AuditStorageUnavailableError());
      transaction.onabort = () => finish(reject, new AuditStorageUnavailableError());
    });
  };
  const put = (key, value) => write([[key, storageClone(value)]]);
  const readKeys = async keys => {
    const db = await open();
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (handler, value) => { if (!settled) { settled = true; handler(value); } };
      const transaction = indexedDbBoundary(() => db.transaction(STORE_NAME, 'readonly'));
      const store = indexedDbObjectStore(transaction, () => transaction.objectStore(STORE_NAME));
      const values = new Map();
      for (const key of keys) {
        const request = store.get(key);
        request.onsuccess = () => values.set(key, storageClone(request.result, transaction));
        request.onerror = () => finish(reject, new AuditStorageUnavailableError());
      }
      transaction.oncomplete = () => finish(resolve, values);
      transaction.onerror = () => finish(reject, new AuditStorageUnavailableError());
      transaction.onabort = () => finish(reject, new AuditStorageUnavailableError());
    });
  };
  const get = async key => (await readKeys([key])).get(key);
  const deletionTransaction = async (names, mode, run) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      let result;
      let resultSet = false;
      const transaction = indexedDbBoundary(() => db.transaction(names, mode));
      const fail = error => {
        abortIndexedDbTransaction(transaction);
        reject(error instanceof AuditDeletionDeniedError ? error : new AuditStorageUnavailableError());
      };
      transaction.oncomplete = () => resultSet ? resolve(result) : reject(new AuditStorageUnavailableError());
      transaction.onerror = transaction.onabort = () => reject(new AuditStorageUnavailableError());
      const watch = request => { request.onerror = () => fail(); return request; };
      const read = (request, receive) => {
        watch(request).onsuccess = () => {
          try { receive(request.result); } catch (error) { fail(error); }
        };
      };
      try {
        run({
          store: name => indexedDbObjectStore(transaction, () => transaction.objectStore(name)),
          read, watch, setResult: value => { result = value; resultSet = true; },
          advance: cursor => continueIndexedDbCursor(transaction, cursor, 'continue'),
        });
      } catch (error) { fail(error); }
    });
  };
  const stageAuditDeletionV1 = async value => {
    const request = deletionRequestV1(value);
    if (!request) return deniedDeletion();
    const { auditId, now } = request;
    return deletionTransaction([STORE_NAME, RETENTION_STORE_NAME, DELETION_STORE_NAME], 'readwrite', context => {
      const audits = context.store(STORE_NAME);
      const retention = context.store(RETENTION_STORE_NAME);
      const deletions = context.store(DELETION_STORE_NAME);
      context.read(deletions.get(auditId), existing => {
        if (existing !== undefined) { context.setResult(stagedDeletion(existing, auditId)); return; }
        context.read(audits.get(auditId), model => {
          if (model === undefined) { context.setResult(deniedDeletion()); return; }
          const stage = () => {
            const tombstone = createDeletionTombstoneV1({ auditId, requestedAt: now, reason: request.reason });
            context.read(audits.get(LATEST_KEY), latest => {
              for (const key of [auditId, revisionKey(auditId), checkpointKey(auditId), pixelAttemptKey(auditId),
                exportLeaseKey(auditId), exportAttemptKey(auditId), exportDeliveryKey(auditId), exportReceiptKey(auditId)]) context.watch(audits.delete(key));
              if (latest?.auditId === auditId) context.watch(audits.delete(LATEST_KEY));
              context.watch(retention.delete(auditId));
              context.watch(deletions.put(tombstone));
              context.setResult(stagedDeletion(tombstone, auditId));
            });
          };
          if (['manual', 'post-export'].includes(request.reason)) {
            context.read(audits.get(revisionKey(auditId)), value => {
              const revision = storedRevision(value);
              if (revision !== request.expectedRevision) { context.setResult(deniedDeletion()); return; }
              context.read(audits.get(exportLeaseKey(auditId)), lease => {
                if (activeExportLease(lease, auditId, revision, canonicalRetentionInstant(now).milliseconds)) {
                  context.setResult(deniedDeletion()); return;
                }
                context.read(audits.get(exportDeliveryKey(auditId)), delivery => {
                  if (canonicalDeliveryJournal(delivery, auditId).length > 0) {
                    context.setResult(deniedDeletion()); return;
                  }
                  if (request.reason === 'post-export') {
                    context.read(retention.get(auditId), metadata => context.read(audits.get(exportReceiptKey(auditId)), receipt => {
                      if (!eligiblePostExport(request, receipt, metadata, revision)) { context.setResult(deniedDeletion()); return; }
                      stage();
                    }));
                  } else stage();
                });
              });
            });
          } else context.read(retention.get(auditId), metadata => {
            if (metadata === undefined || validateRetentionMetadata(metadata, auditId).expiresAt > now) {
              context.setResult(deniedDeletion()); return;
            }
            stage();
          });
        });
      });
    });
  };
  const selectRetainedAuditsV1 = async (now, limit) => {
    try {
      return await deletionTransaction([STORE_NAME, RETENTION_STORE_NAME], 'readonly', context => {
        const records = [];
        const audits = context.store(STORE_NAME);
        const index = context.store(RETENTION_STORE_NAME).index('byExpiresAt');
        const range = now === null ? undefined : indexedDbBoundary(() => keyRange.upperBound(now));
        const request = index.openCursor(range);
        context.read(request, cursor => {
          if (!cursor) { context.setResult(records); return; }
          const auditId = cursor.primaryKey;
          context.read(audits.get(auditId), model => {
            if (model !== undefined) records.push(validateRetentionMetadata(cursor.value, auditId));
            if (records.length === limit) context.setResult(records);
            else context.advance(cursor);
          });
        });
      });
    } catch { throw new AuditStorageUnavailableError(); }
  };
  const nextExpiresAtV1 = async () => (await selectRetainedAuditsV1(null, 1))[0]?.expiresAt ?? null;
  const stageExpiredAuditDeletionsV1 = async value => {
    const { now, limit } = expirationSelectionRequestV1(value);
    // Finish the selection transaction before beginning independent R1 staging transactions.
    const candidates = await selectRetainedAuditsV1(now, limit);
    return stageSelectedAuditDeletionsV1(candidates, now, stageAuditDeletionV1);
  };
  const listDeletionTombstonesV1 = async value => {
    const { limit } = deletionOperationV1(value, ['limit']);
    return deletionTransaction(DELETION_STORE_NAME, 'readonly', context => {
      const records = [];
      const request = context.store(DELETION_STORE_NAME).openCursor();
      context.read(request, cursor => {
        if (!cursor) { context.setResult(Object.freeze(records)); return; }
        records.push(validateDeletionTombstoneV1(cursor.value, cursor.primaryKey ?? cursor.key));
        if (records.length === limit) context.setResult(Object.freeze(records));
        else context.advance(cursor);
      });
    });
  };
  const recordDeletionCleanupFailureV1 = async value => {
    const { auditId, at } = deletionOperationV1(value, ['auditId', 'at']);
    return deletionTransaction(DELETION_STORE_NAME, 'readwrite', context => {
      const deletions = context.store(DELETION_STORE_NAME);
      context.read(deletions.get(auditId), existing => {
        if (existing === undefined) { context.setResult(false); return; }
        const next = nextDeletionFailure(validateDeletionTombstoneV1(existing, auditId), at);
        context.watch(deletions.put(next));
        context.setResult(true);
      });
    });
  };
  const completeAuditDeletionV1 = async value => {
    const { auditId } = deletionOperationV1(value, ['auditId']);
    return deletionTransaction(DELETION_STORE_NAME, 'readwrite', context => {
      const deletions = context.store(DELETION_STORE_NAME);
      context.read(deletions.get(auditId), existing => {
        if (existing === undefined) { context.setResult(false); return; }
        validateDeletionTombstoneV1(existing, auditId);
        context.watch(deletions.delete(auditId));
        context.setResult(true);
      });
    });
  };
  const getAuditSnapshot = async id => {
    const key = validId(id);
    const values = await readKeys([key, revisionKey(key)]);
    const model = materializeCanonicalAuditModel(key, values.get(key), { allowMissing: true });
    return mintAuditSnapshot(owner, key, model, values.get(revisionKey(key)));
  };
  const commitAuditWithCheckpointIfAbsent = async (id, model, checkpoint, latestState, options) => {
    const normalizedOptions = exactTerminalOptions(options);
    const terminal = await canonicalTerminalGraph(id, model, checkpoint, latestState);
    const commit = async pixelAttempt => {
      if (pixelAttempt && pixelAttempt.auditId !== terminal.key) throw new TypeError('Commit terminal inválido.');
      const modelClone = storageClone(terminal.model);
      const companion = checkpointCompanion(terminal.key, terminal.checkpoint);
      const pixelCompanion = pixelAttempt ? pixelAttemptCompanion(pixelAttempt, normalizedOptions.now) : null;
      const latestClone = storageClone(terminal.latest);
      const retentionMetadata = createRetentionMetadata(terminal.key, normalizedOptions.now, false);
      const db = await open();
      return new Promise((resolve, reject) => {
      let settled = false;
      let reads = 0;
      let conflict = false;
      let written = false;
      const finish = (handler, value) => { if (!settled) { settled = true; handler(value); } };
      const transaction = indexedDbBoundary(() => db.transaction([STORE_NAME, RETENTION_STORE_NAME], 'readwrite'));
      const store = indexedDbObjectStore(transaction, () => transaction.objectStore(STORE_NAME));
      const retentionStore = indexedDbObjectStore(transaction, () => transaction.objectStore(RETENTION_STORE_NAME));
      const requests = [
        store.get(terminal.key), store.get(revisionKey(terminal.key)),
        store.get(checkpointKey(terminal.key)), store.get(pixelAttemptKey(terminal.key)),
        retentionStore.get(terminal.key),
      ];
      const values = new Array(requests.length);
      const apply = () => {
        if (reads !== requests.length || written || conflict) return;
        if (values.some(value => value !== undefined)) { conflict = true; return; }
        written = true;
        store.put(modelClone, terminal.key);
        store.put(companion, checkpointKey(terminal.key));
        if (pixelCompanion) store.put(pixelCompanion, pixelAttemptKey(terminal.key));
        store.put(1, revisionKey(terminal.key));
        store.put(latestClone, LATEST_KEY);
        retentionStore.put(retentionMetadata);
      };
      requests.forEach((request, index) => {
        request.onsuccess = () => { values[index] = request.result; reads += 1; apply(); };
        request.onerror = () => finish(reject, new AuditStorageUnavailableError());
      });
      transaction.oncomplete = () => {
        if (conflict) finish(reject, new AuditRevisionConflictError());
        else if (!written) finish(reject, new AuditStorageUnavailableError());
        else finish(resolve, Object.freeze({
          revision: 1,
          modelHash: terminal.model.integrity.canonicalModelHash,
          capability: mintAuditSnapshot(owner, terminal.key, modelClone, 1).capability,
        }));
      };
      transaction.onerror = () => finish(reject, new AuditStorageUnavailableError());
      transaction.onabort = () => finish(reject, new AuditStorageUnavailableError());
      });
    };
    return normalizedOptions.pixelAttemptCommit
      ? runPixelAttemptCommitAuthorizationV1(normalizedOptions.pixelAttemptCommit, api, commit)
      : commit(null);
  };
  const getReportRevision = async id => {
    try {
      const key = validId(id);
      const values = await readKeys([key, revisionKey(key), checkpointKey(key)]);
      const rawModel = values.get(key);
      const rawRevision = values.get(revisionKey(key));
      const rawCompanion = values.get(checkpointKey(key));
      if (rawModel === undefined && rawRevision === undefined && rawCompanion === undefined) return null;
      const model = await verifyAuditIntegritySnapshot(rawModel);
      const revision = storedRevision(rawRevision);
      if (model.auditId !== key || revision < 1 || !['complete', 'partial', 'failed', 'cancelled'].includes(model.session.status) ||
        !/^[a-f0-9]{64}$/u.test(model.integrity.canonicalModelHash)) throw new Error();
      const terminalCheckpoint = parseCheckpointCompanion(rawCompanion, key, model);
      return freezeStored({
        version: 1, auditId: key, modelRevision: revision,
        modelHash: model.integrity.canonicalModelHash,
        model, checkpoint: storageClone(terminalCheckpoint),
      });
    } catch (error) {
      if (error instanceof AuditStorageUnavailableError) throw error;
      throw new AuditStorageUnavailableError();
    }
  };
  const mutateAudit = async (id, model, latestState, snapshotCapability, options = {}) => {
    const key = validId(id);
    const expected = snapshotCapability === undefined
      ? undefined
      : capabilityRevision(snapshotCapability, owner, key);
    const modelClone = storageClone(materializeCanonicalAuditModel(key, model));
    const latestClone = latestState === undefined ? undefined : storageClone(latestState);
    const db = await open();
    return new Promise((resolve, reject) => {
      let settled = false;
      let currentModelRead = false;
      let revisionRead = false;
      let retentionRead = false;
      let leaseRead = false;
      let attemptRead = false;
      let currentModel;
      let currentRevisionValue;
      let currentRetention;
      let currentLease;
      let currentAttempt;
      let latestRead = options.review !== true;
      let currentLatest;
      let nextRevision = null;
      let conflict = false;
      const finish = (handler, value) => { if (!settled) { settled = true; handler(value); } };
      const transaction = indexedDbBoundary(() => db.transaction([STORE_NAME, RETENTION_STORE_NAME], 'readwrite'));
      const store = indexedDbObjectStore(transaction, () => transaction.objectStore(STORE_NAME));
      const retentionStore = indexedDbObjectStore(transaction, () => transaction.objectStore(RETENTION_STORE_NAME));
      const currentRequest = store.get(key);
      const revisionRequest = store.get(revisionKey(key));
      const retentionRequest = retentionStore.get(key);
      const leaseRequest = store.get(exportLeaseKey(key));
      const attemptRequest = store.get(exportAttemptKey(key));
      const latestRequest = options.review === true ? store.get(LATEST_KEY) : null;
      const apply = () => {
        if (!currentModelRead || !revisionRead || !retentionRead || !leaseRead || !attemptRead ||
          !latestRead || nextRevision !== null || conflict) return;
        let currentRevision;
        let canonicalCurrentModel;
        try {
          currentRevision = storedRevision(currentRevisionValue);
          canonicalCurrentModel = materializeCanonicalAuditModel(
            key, currentModel, { allowMissing: true },
          );
        } catch (error) {
          finish(reject, error);
          try { transaction.abort(); } catch {}
          return;
        }
        if (expected !== undefined && (canonicalCurrentModel === undefined || currentRevision !== expected)) {
          conflict = true;
          return;
        }
        const candidateRevision = currentRevision + 1;
        let reviewLatest;
        let nextRetention;
        let migratedAttempt;
        try {
          reviewLatest = options.review === true
            ? reviewLatestState(currentLatest, key, modelClone, candidateRevision)
            : undefined;
          nextRetention = currentRetention === undefined
            ? createRetentionMetadata(
                key,
                options.now ?? clock(),
                options.deleteAfterCompleteExport === true,
              )
            : validateRetentionMetadata(currentRetention, key);
          migratedAttempt = migrateExportAttemptBeforeLeaseRemoval(currentAttempt, currentLease, key);
        } catch (error) {
          finish(reject, error);
          try { transaction.abort(); } catch {}
          return;
        }
        nextRevision = candidateRevision;
        store.put(modelClone, key);
        store.put(nextRevision, revisionKey(key));
        if (currentRetention === undefined) retentionStore.put(nextRetention);
        if (migratedAttempt !== null) store.put(migratedAttempt, exportAttemptKey(key));
        store.delete(exportLeaseKey(key));
        if (options.review === true) {
          if (reviewLatest !== undefined) store.put(reviewLatest, LATEST_KEY);
        } else if (latestState !== undefined) store.put(latestClone, LATEST_KEY);
      };
      currentRequest.onsuccess = () => {
        currentModelRead = true;
        currentModel = currentRequest.result;
        apply();
      };
      revisionRequest.onsuccess = () => {
        revisionRead = true;
        currentRevisionValue = revisionRequest.result;
        apply();
      };
      retentionRequest.onsuccess = () => {
        retentionRead = true;
        currentRetention = retentionRequest.result;
        apply();
      };
      leaseRequest.onsuccess = () => {
        leaseRead = true;
        currentLease = leaseRequest.result;
        apply();
      };
      attemptRequest.onsuccess = () => {
        attemptRead = true;
        currentAttempt = attemptRequest.result;
        apply();
      };
      if (latestRequest) {
        latestRequest.onsuccess = () => {
          latestRead = true;
          currentLatest = latestRequest.result;
          apply();
        };
        latestRequest.onerror = () => finish(reject, new AuditStorageUnavailableError());
      }
      currentRequest.onerror = () => finish(reject, new AuditStorageUnavailableError());
      revisionRequest.onerror = () => finish(reject, new AuditStorageUnavailableError());
      retentionRequest.onerror = () => finish(reject, new AuditStorageUnavailableError());
      leaseRequest.onerror = () => finish(reject, new AuditStorageUnavailableError());
      attemptRequest.onerror = () => finish(reject, new AuditStorageUnavailableError());
      transaction.oncomplete = () => {
        if (conflict) finish(reject, new AuditRevisionConflictError());
        else if (nextRevision === null) finish(reject, new AuditStorageUnavailableError());
        else finish(resolve, {
          revision: nextRevision,
          capability: mintAuditSnapshot(owner, key, modelClone, nextRevision).capability,
        });
      };
      transaction.onerror = () => finish(reject, new AuditStorageUnavailableError());
      transaction.onabort = () => finish(reject, new AuditStorageUnavailableError());
    });
  };

  const acquireExportLease = async (id, snapshotCapability, options) => {
    const key = validId(id);
    const expected = capabilityRevision(snapshotCapability, owner, key);
    const normalized = canonicalLeaseOptions(options, expected, 'queued');
    const db = await open();
    return new Promise((resolve, reject) => {
      let settled = false;
      let modelRead = false;
      let revisionRead = false;
      let leaseRead = false;
      let latestRead = false;
      let attemptRead = false;
      let deliveryRead = false;
      let currentModel;
      let currentRevisionValue;
      let currentLease;
      let currentLatest;
      let currentAttempt;
      let currentDelivery;
      let result = null;
      let revisionConflict = false;
      const finish = (handler, value) => { if (!settled) { settled = true; handler(value); } };
      const transaction = indexedDbBoundary(() => db.transaction(STORE_NAME, 'readwrite'));
      const store = indexedDbObjectStore(transaction, () => transaction.objectStore(STORE_NAME));
      const modelRequest = store.get(key);
      const revisionRequest = store.get(revisionKey(key));
      const leaseRequest = store.get(exportLeaseKey(key));
      const latestRequest = store.get(LATEST_KEY);
      const attemptRequest = store.get(exportAttemptKey(key));
      const deliveryRequest = store.get(exportDeliveryKey(key));
      const apply = () => {
        if (!modelRead || !revisionRead || !leaseRead || !latestRead || !attemptRead || !deliveryRead || result || revisionConflict) return;
        let revision;
        let canonicalCurrentModel;
        try {
          revision = storedRevision(currentRevisionValue);
          canonicalCurrentModel = presentCanonicalAudit(key, currentModel, revision);
        } catch (error) {
          finish(reject, error);
          try { transaction.abort(); } catch {}
          return;
        }
        if (canonicalCurrentModel === undefined || revision !== expected) { revisionConflict = true; return; }
        let attemptValue = currentAttempt;
        if (currentLease !== undefined) {
          const persistedLease = activeExportLease(currentLease, key, revision, Number.NEGATIVE_INFINITY);
          if (!persistedLease) {
            finish(reject, new TypeError('Concessão armazenada da exportação inválida.'));
            try { transaction.abort(); } catch {}
            return;
          }
          try { attemptValue = correlatedExportAttemptRecord(currentAttempt, key, persistedLease); }
          catch (error) {
            finish(reject, error);
            try { transaction.abort(); } catch {}
            return;
          }
        }
        const existing = activeExportLease(currentLease, key, revision, normalized.nowMs);
        if (existing) {
          result = {
            acquired: false, busy: true, retryAt: existing.expiresAt,
            revision, exportAttempt: existing.exportAttempt,
          };
          return;
        }
        let allocation;
        try { allocation = nextExportAttempt(attemptValue, currentLatest, key, normalized.now); } catch (error) {
          finish(reject, error);
          return;
        }
        const { exportAttempt, deliveryAt } = allocation;
        let deliveryEntries;
        try { deliveryEntries = canonicalDeliveryJournal(currentDelivery, key); } catch (error) {
          finish(reject, error);
          return;
        }
        const ownerId = normalized.ownerId === `export:${key}:pending`
          ? `export:${key}:${exportAttempt}`
          : normalized.ownerId;
        const lease = exportLeaseRecord(key, { ...normalized, ownerId, exportAttempt, deliveryAt });
        store.put(lease, exportLeaseKey(key));
        store.put(exportAttemptRecord(key, exportAttempt, deliveryAt), exportAttemptKey(key));
        if (normalized.latestState !== undefined) {
          store.put(pendingCleanupLatest({ ...normalized.latestState, exportAttempt }, deliveryEntries), LATEST_KEY);
        }
        result = {
          acquired: true, busy: false, revision, exportAttempt, deliveryAt, expiresAt: lease.expiresAt,
        };
      };
      modelRequest.onsuccess = () => { modelRead = true; currentModel = modelRequest.result; apply(); };
      revisionRequest.onsuccess = () => { revisionRead = true; currentRevisionValue = revisionRequest.result; apply(); };
      leaseRequest.onsuccess = () => { leaseRead = true; currentLease = leaseRequest.result; apply(); };
      latestRequest.onsuccess = () => { latestRead = true; currentLatest = latestRequest.result; apply(); };
      attemptRequest.onsuccess = () => { attemptRead = true; currentAttempt = attemptRequest.result; apply(); };
      deliveryRequest.onsuccess = () => { deliveryRead = true; currentDelivery = deliveryRequest.result; apply(); };
      modelRequest.onerror = () => finish(reject, new AuditStorageUnavailableError());
      revisionRequest.onerror = () => finish(reject, new AuditStorageUnavailableError());
      leaseRequest.onerror = () => finish(reject, new AuditStorageUnavailableError());
      latestRequest.onerror = () => finish(reject, new AuditStorageUnavailableError());
      attemptRequest.onerror = () => finish(reject, new AuditStorageUnavailableError());
      deliveryRequest.onerror = () => finish(reject, new AuditStorageUnavailableError());
      transaction.oncomplete = () => revisionConflict
        ? finish(reject, new AuditRevisionConflictError())
        : result ? finish(resolve, result) : finish(reject, new AuditStorageUnavailableError());
      transaction.onerror = () => finish(reject, new AuditStorageUnavailableError());
      transaction.onabort = () => finish(reject, new AuditStorageUnavailableError());
    });
  };

  const mutateWithExportLease = async (id, model, latestState, snapshotCapability, options, mode = 'commit') => {
    const claimOnly = mode === 'claim';
    const transitionOnly = mode === 'delivery';
    const key = validId(id);
    const expected = capabilityRevision(snapshotCapability, owner, key);
    const normalized = canonicalLeaseOptions(
      claimOnly ? { ...options, phase: 'running' } : transitionOnly ? { ...options, phase: 'delivering' } : options,
      expected,
      claimOnly ? 'running' : 'delivering',
    );
    const modelClone = claimOnly || transitionOnly ? null : storageClone(materializeCanonicalAuditModel(key, model));
    const latestClone = latestState === undefined ? undefined : storageClone(latestState);
    const db = await open();
    return new Promise((resolve, reject) => {
      let settled = false;
      let modelRead = false;
      let revisionRead = false;
      let leaseRead = false;
      let attemptRead = false;
      let deliveryRead = false;
      let retentionRead = false;
      let currentModel;
      let currentRevisionValue;
      let currentLease;
      let currentAttempt;
      let currentDelivery;
      let currentRetention;
      let result = null;
      let revisionConflict = false;
      let leaseConflict = false;
      const finish = (handler, value) => { if (!settled) { settled = true; handler(value); } };
      const transaction = indexedDbBoundary(() => db.transaction([STORE_NAME, RETENTION_STORE_NAME], 'readwrite'));
      const store = indexedDbObjectStore(transaction, () => transaction.objectStore(STORE_NAME));
      const retentionStore = indexedDbObjectStore(transaction, () => transaction.objectStore(RETENTION_STORE_NAME));
      const modelRequest = store.get(key);
      const revisionRequest = store.get(revisionKey(key));
      const leaseRequest = store.get(exportLeaseKey(key));
      const attemptRequest = store.get(exportAttemptKey(key));
      const deliveryRequest = store.get(exportDeliveryKey(key));
      const retentionRequest = retentionStore.get(key);
      const apply = () => {
        if (!modelRead || !revisionRead || !leaseRead || !attemptRead || !deliveryRead || !retentionRead ||
          result || revisionConflict || leaseConflict) return;
        let revision;
        let canonicalCurrentModel;
        try {
          revision = storedRevision(currentRevisionValue);
          canonicalCurrentModel = presentCanonicalAudit(key, currentModel, revision);
        } catch (error) {
          finish(reject, error);
          try { transaction.abort(); } catch {}
          return;
        }
        if (canonicalCurrentModel === undefined || revision !== expected) { revisionConflict = true; return; }
        const existing = activeExportLease(currentLease, key, revision, normalized.nowMs);
        const attemptMatches = normalized.exportAttempt === undefined || normalized.exportAttempt === existing?.exportAttempt;
        const allowed = claimOnly
          ? attemptMatches && existing?.ownerId === normalized.ownerId && existing.phase === 'queued'
          : transitionOnly
            ? attemptMatches && existing?.ownerId === normalized.ownerId && existing.phase === 'running'
          : attemptMatches && existing?.ownerId === normalized.ownerId && (normalized.release
              ? ['queued', 'running', 'delivering'].includes(existing.phase)
              : existing.phase === 'running' && normalized.phase === 'delivering');
        if (!allowed) { leaseConflict = true; return; }
        let attemptRecord;
        try { attemptRecord = correlatedExportAttemptRecord(currentAttempt, key, existing); }
        catch (error) { finish(reject, error); return; }
        let deliveryEntries;
        try { deliveryEntries = canonicalDeliveryJournal(currentDelivery, key); } catch (error) {
          finish(reject, error);
          return;
        }
        let retentionMetadata;
        try {
          retentionMetadata = currentRetention === undefined
            ? createRetentionMetadata(key, normalized.now, false)
            : validateRetentionMetadata(currentRetention, key);
        } catch (error) { finish(reject, error); return; }
        if (currentRetention === undefined) retentionStore.put(retentionMetadata);
        if (normalized.clearDeliveryJournal && (!normalized.release || deliveryEntries.some(entry =>
          entry.ownerId !== normalized.ownerId || entry.exportAttempt !== existing.exportAttempt || entry.state !== 'terminal'))) {
          leaseConflict = true;
          return;
        }
        if (claimOnly) {
          const lease = exportLeaseRecord(key, {
            ...monotonicLeaseTransition(normalized, existing),
            exportAttempt: existing.exportAttempt,
          }, existing.acquiredAt);
          store.put(lease, exportLeaseKey(key));
          store.put(attemptRecord, exportAttemptKey(key));
          if (latestClone !== undefined) {
            store.put(pendingCleanupLatest(
              { ...latestClone, exportAttempt: existing.exportAttempt }, deliveryEntries,
            ), LATEST_KEY);
          }
          result = {
            claimed: true, revision, exportAttempt: existing.exportAttempt,
            deliveryAt: existing.deliveryAt, expiresAt: lease.expiresAt,
          };
          return;
        }
        if (transitionOnly) {
          const lease = exportLeaseRecord(key, {
            ...monotonicLeaseTransition(normalized, existing),
            exportAttempt: existing.exportAttempt,
          }, existing.acquiredAt);
          store.put(lease, exportLeaseKey(key));
          store.put(attemptRecord, exportAttemptKey(key));
          if (latestClone !== undefined) store.put(pendingCleanupLatest(
            { ...latestClone, exportAttempt: existing.exportAttempt }, deliveryEntries,
          ), LATEST_KEY);
          result = {
            delivering: true, revision, exportAttempt: existing.exportAttempt,
            deliveryAt: existing.deliveryAt, expiresAt: lease.expiresAt,
          };
          return;
        }
        const nextRevision = revision + 1;
        store.put(modelClone, key);
        store.put(nextRevision, revisionKey(key));
        store.put(attemptRecord, exportAttemptKey(key));
        if (latestClone !== undefined) {
          store.put(pendingCleanupLatest(
            { ...latestClone, exportAttempt: existing.exportAttempt },
            normalized.clearDeliveryJournal ? [] : deliveryEntries,
          ), LATEST_KEY);
        }
        if (normalized.release) {
          store.delete(exportLeaseKey(key));
          if (normalized.clearDeliveryJournal) store.delete(exportDeliveryKey(key));
        }
        else store.put(exportLeaseRecord(key, {
          ...monotonicLeaseTransition(normalized, existing),
          revision: nextRevision,
          exportAttempt: existing.exportAttempt,
        }, existing.acquiredAt), exportLeaseKey(key));
        result = {
          revision: nextRevision,
          capability: mintAuditSnapshot(owner, key, modelClone, nextRevision).capability,
        };
      };
      modelRequest.onsuccess = () => { modelRead = true; currentModel = modelRequest.result; apply(); };
      revisionRequest.onsuccess = () => { revisionRead = true; currentRevisionValue = revisionRequest.result; apply(); };
      leaseRequest.onsuccess = () => { leaseRead = true; currentLease = leaseRequest.result; apply(); };
      attemptRequest.onsuccess = () => { attemptRead = true; currentAttempt = attemptRequest.result; apply(); };
      deliveryRequest.onsuccess = () => { deliveryRead = true; currentDelivery = deliveryRequest.result; apply(); };
      retentionRequest.onsuccess = () => { retentionRead = true; currentRetention = retentionRequest.result; apply(); };
      modelRequest.onerror = () => finish(reject, new AuditStorageUnavailableError());
      revisionRequest.onerror = () => finish(reject, new AuditStorageUnavailableError());
      leaseRequest.onerror = () => finish(reject, new AuditStorageUnavailableError());
      attemptRequest.onerror = () => finish(reject, new AuditStorageUnavailableError());
      deliveryRequest.onerror = () => finish(reject, new AuditStorageUnavailableError());
      retentionRequest.onerror = () => finish(reject, new AuditStorageUnavailableError());
      transaction.oncomplete = () => {
        if (revisionConflict) finish(reject, new AuditRevisionConflictError());
        else if (leaseConflict) finish(reject, new AuditExportLeaseConflictError());
        else if (result) finish(resolve, result);
        else finish(reject, new AuditStorageUnavailableError());
      };
      transaction.onerror = () => finish(reject, new AuditStorageUnavailableError());
      transaction.onabort = () => finish(reject, new AuditStorageUnavailableError());
    });
  };

  const releaseExportLease = async (id, options) => {
    const key = validId(id);
    const normalized = canonicalLeaseOptions(options, 0);
    const db = await open();
    return new Promise((resolve, reject) => {
      let settled = false;
      let revisionValue;
      let leaseValue;
      let attemptValue;
      let modelValue;
      let revisionRead = false;
      let leaseRead = false;
      let attemptRead = false;
      let modelRead = false;
      let released = false;
      const finish = (handler, value) => { if (!settled) { settled = true; handler(value); } };
      const transaction = indexedDbBoundary(() => db.transaction(STORE_NAME, 'readwrite'));
      const store = indexedDbObjectStore(transaction, () => transaction.objectStore(STORE_NAME));
      const modelRequest = store.get(key);
      const revisionRequest = store.get(revisionKey(key));
      const leaseRequest = store.get(exportLeaseKey(key));
      const attemptRequest = store.get(exportAttemptKey(key));
      const apply = () => {
        if (!modelRead || !revisionRead || !leaseRead || !attemptRead) return;
        let revision;
        try {
          revision = storedRevision(revisionValue);
          presentCanonicalAudit(key, modelValue, revision);
        } catch (error) {
          finish(reject, error);
          try { transaction.abort(); } catch {}
          return;
        }
        const existing = activeExportLease(leaseValue, key, revision, normalized.nowMs);
        if (existing?.ownerId === normalized.ownerId) {
          let attemptRecord;
          try { attemptRecord = correlatedExportAttemptRecord(attemptValue, key, existing); }
          catch (error) {
            finish(reject, error);
            try { transaction.abort(); } catch {}
            return;
          }
          store.put(attemptRecord, exportAttemptKey(key));
          store.delete(exportLeaseKey(key));
          released = true;
        }
      };
      modelRequest.onsuccess = () => { modelRead = true; modelValue = modelRequest.result; apply(); };
      revisionRequest.onsuccess = () => { revisionRead = true; revisionValue = revisionRequest.result; apply(); };
      leaseRequest.onsuccess = () => { leaseRead = true; leaseValue = leaseRequest.result; apply(); };
      attemptRequest.onsuccess = () => { attemptRead = true; attemptValue = attemptRequest.result; apply(); };
      modelRequest.onerror = () => finish(reject, new AuditStorageUnavailableError());
      revisionRequest.onerror = () => finish(reject, new AuditStorageUnavailableError());
      leaseRequest.onerror = () => finish(reject, new AuditStorageUnavailableError());
      attemptRequest.onerror = () => finish(reject, new AuditStorageUnavailableError());
      transaction.oncomplete = () => finish(resolve, released);
      transaction.onerror = () => finish(reject, new AuditStorageUnavailableError());
      transaction.onabort = () => finish(reject, new AuditStorageUnavailableError());
    });
  };
  const getExportLeaseState = async (id, options) => {
    const key = validId(id);
    const instant = canonicalLeaseNow(options?.now);
    const values = await readKeys([key, revisionKey(key), exportLeaseKey(key)]);
    const revision = storedRevision(values.get(revisionKey(key)));
    const model = presentCanonicalAudit(key, values.get(key), revision);
    const existing = model === undefined
      ? null
      : activeExportLease(values.get(exportLeaseKey(key)), key, revision, instant.nowMs);
    return existing
      ? {
          active: true, phase: existing.phase, retryAt: existing.expiresAt,
          revision, exportAttempt: existing.exportAttempt, ownerId: existing.ownerId,
        }
      : { active: false, revision };
  };
  const assertExportLease = async (id, snapshotCapability, options) => {
    const key = validId(id);
    const expected = capabilityRevision(snapshotCapability, owner, key);
    const normalized = canonicalLeaseOptions(options, expected, options?.phase ?? 'delivering');
    const values = await readKeys([key, revisionKey(key), exportLeaseKey(key), exportAttemptKey(key)]);
    const revision = storedRevision(values.get(revisionKey(key)));
    const model = presentCanonicalAudit(key, values.get(key), revision);
    if (model === undefined || revision !== expected) throw new AuditRevisionConflictError();
    const existing = activeExportLease(values.get(exportLeaseKey(key)), key, revision, normalized.nowMs);
    if (!existing || existing.ownerId !== normalized.ownerId || existing.phase !== normalized.phase ||
      (normalized.exportAttempt !== undefined && normalized.exportAttempt !== existing.exportAttempt)) {
      throw new AuditExportLeaseConflictError();
    }
    correlatedExportAttemptRecord(values.get(exportAttemptKey(key)), key, existing);
    return {
      active: true, phase: existing.phase, retryAt: existing.expiresAt,
      revision, exportAttempt: existing.exportAttempt, deliveryAt: existing.deliveryAt,
    };
  };
  const recordExportDelivery = async (id, snapshotCapability, options) => {
    const key = validId(id);
    const expected = capabilityRevision(snapshotCapability, owner, key);
    const normalized = canonicalDeliveryOptions(options);
    const db = await open();
    return new Promise((resolve, reject) => {
      let settled = false;
      let modelRead = false;
      let revisionRead = false;
      let leaseRead = false;
      let attemptRead = false;
      let deliveryRead = false;
      let latestRead = false;
      let currentModel;
      let currentRevisionValue;
      let currentLease;
      let currentAttempt;
      let currentDelivery;
      let currentLatest;
      let result = null;
      let revisionConflict = false;
      let leaseConflict = false;
      const finish = (handler, value) => { if (!settled) { settled = true; handler(value); } };
      const transaction = indexedDbBoundary(() => db.transaction(STORE_NAME, 'readwrite'));
      const store = indexedDbObjectStore(transaction, () => transaction.objectStore(STORE_NAME));
      const modelRequest = store.get(key);
      const revisionRequest = store.get(revisionKey(key));
      const leaseRequest = store.get(exportLeaseKey(key));
      const attemptRequest = store.get(exportAttemptKey(key));
      const deliveryRequest = store.get(exportDeliveryKey(key));
      const latestRequest = store.get(LATEST_KEY);
      const apply = () => {
        if (!modelRead || !revisionRead || !leaseRead || !attemptRead || !deliveryRead || !latestRead || result || revisionConflict || leaseConflict) return;
        let revision;
        let canonicalCurrentModel;
        try {
          revision = storedRevision(currentRevisionValue);
          canonicalCurrentModel = presentCanonicalAudit(key, currentModel, revision);
        } catch (error) {
          finish(reject, error);
          try { transaction.abort(); } catch {}
          return;
        }
        if (canonicalCurrentModel === undefined || revision !== expected) { revisionConflict = true; return; }
        const lease = activeExportLease(currentLease, key, revision, normalized.nowMs);
        if (!lease || lease.ownerId !== normalized.ownerId || lease.exportAttempt !== normalized.exportAttempt ||
          lease.phase !== 'delivering') { leaseConflict = true; return; }
        let attemptRecord;
        let entries;
        try {
          attemptRecord = correlatedExportAttemptRecord(currentAttempt, key, lease);
          entries = updateDeliveryEntries(canonicalDeliveryJournal(currentDelivery, key), normalized);
        } catch (error) { finish(reject, error); return; }
        store.put(attemptRecord, exportAttemptKey(key));
        store.put(deliveryJournalRecord(key, entries), exportDeliveryKey(key));
        if (currentLatest?.auditId === key) store.put(pendingCleanupLatest(currentLatest, entries), LATEST_KEY);
        result = storageClone(entries.find(entry => entry.ownerId === normalized.ownerId &&
          entry.exportAttempt === normalized.exportAttempt && entry.format === normalized.format));
      };
      modelRequest.onsuccess = () => { modelRead = true; currentModel = modelRequest.result; apply(); };
      revisionRequest.onsuccess = () => { revisionRead = true; currentRevisionValue = revisionRequest.result; apply(); };
      leaseRequest.onsuccess = () => { leaseRead = true; currentLease = leaseRequest.result; apply(); };
      attemptRequest.onsuccess = () => { attemptRead = true; currentAttempt = attemptRequest.result; apply(); };
      deliveryRequest.onsuccess = () => { deliveryRead = true; currentDelivery = deliveryRequest.result; apply(); };
      latestRequest.onsuccess = () => { latestRead = true; currentLatest = latestRequest.result; apply(); };
      modelRequest.onerror = () => finish(reject, new AuditStorageUnavailableError());
      revisionRequest.onerror = () => finish(reject, new AuditStorageUnavailableError());
      leaseRequest.onerror = () => finish(reject, new AuditStorageUnavailableError());
      attemptRequest.onerror = () => finish(reject, new AuditStorageUnavailableError());
      deliveryRequest.onerror = () => finish(reject, new AuditStorageUnavailableError());
      latestRequest.onerror = () => finish(reject, new AuditStorageUnavailableError());
      transaction.oncomplete = () => {
        if (revisionConflict) finish(reject, new AuditRevisionConflictError());
        else if (leaseConflict) finish(reject, new AuditExportLeaseConflictError());
        else if (result) finish(resolve, result);
        else finish(reject, new AuditStorageUnavailableError());
      };
      transaction.onerror = () => finish(reject, new AuditStorageUnavailableError());
      transaction.onabort = () => finish(reject, new AuditStorageUnavailableError());
    });
  };
  const resolveExportDelivery = async (id, options) => {
    const key = validId(id);
    const normalized = canonicalDeliveryOptions(options, true);
    const db = await open();
    return new Promise((resolve, reject) => {
      let settled = false;
      let modelRead = false;
      let deliveryRead = false;
      let latestRead = false;
      let currentModel;
      let currentDelivery;
      let currentLatest;
      let result = null;
      const finish = (handler, value) => { if (!settled) { settled = true; handler(value); } };
      const transaction = indexedDbBoundary(() => db.transaction(STORE_NAME, 'readwrite'));
      const store = indexedDbObjectStore(transaction, () => transaction.objectStore(STORE_NAME));
      const modelRequest = store.get(key);
      const deliveryRequest = store.get(exportDeliveryKey(key));
      const latestRequest = store.get(LATEST_KEY);
      const apply = () => {
        if (!modelRead || !deliveryRead || !latestRead || result !== null) return;
        let current;
        try {
          materializeCanonicalAuditModel(key, currentModel, { allowMissing: true });
          current = canonicalDeliveryJournal(currentDelivery, key);
        } catch (error) {
          finish(reject, error);
          try { transaction.abort(); } catch {}
          return;
        }
        const resolved = resolveDeliveryEntries(current, normalized);
        result = resolved.matched;
        if (!resolved.matched) return;
        if (resolved.entries.length === 0) store.delete(exportDeliveryKey(key));
        else store.put(deliveryJournalRecord(key, resolved.entries), exportDeliveryKey(key));
        if (currentLatest?.auditId === key) {
          store.put(pendingCleanupLatest(
            currentLatest, resolved.entries,
          ), LATEST_KEY);
        }
      };
      modelRequest.onsuccess = () => { modelRead = true; currentModel = modelRequest.result; apply(); };
      deliveryRequest.onsuccess = () => { deliveryRead = true; currentDelivery = deliveryRequest.result; apply(); };
      latestRequest.onsuccess = () => { latestRead = true; currentLatest = latestRequest.result; apply(); };
      modelRequest.onerror = () => finish(reject, new AuditStorageUnavailableError());
      deliveryRequest.onerror = () => finish(reject, new AuditStorageUnavailableError());
      latestRequest.onerror = () => finish(reject, new AuditStorageUnavailableError());
      transaction.oncomplete = () => finish(resolve, result === true);
      transaction.onerror = () => finish(reject, new AuditStorageUnavailableError());
      transaction.onabort = () => finish(reject, new AuditStorageUnavailableError());
    });
  };
  const getExportDeliveryJournal = async id => {
    const key = validId(id);
    const values = await readKeys([key, revisionKey(key), exportDeliveryKey(key)]);
    presentCanonicalAudit(key, values.get(key), storedRevision(values.get(revisionKey(key))));
    return canonicalDeliveryJournal(values.get(exportDeliveryKey(key)), key);
  };
  const getAuditRetention = async id => {
    const key = validId(id);
    const db = await open();
    return new Promise((resolve, reject) => {
      const transaction = indexedDbBoundary(() => db.transaction(RETENTION_STORE_NAME, 'readonly'));
      const retentionStore = indexedDbObjectStore(transaction, () => transaction.objectStore(RETENTION_STORE_NAME));
      const request = retentionStore.get(key);
      let value;
      request.onsuccess = () => { value = request.result; };
      request.onerror = () => reject(new AuditStorageUnavailableError());
      transaction.oncomplete = () => {
        try {
          resolve(value === undefined ? undefined : storageClone(validateRetentionMetadata(value, key)));
        } catch (error) { reject(error); }
      };
      transaction.onerror = () => reject(new AuditStorageUnavailableError());
      transaction.onabort = () => reject(new AuditStorageUnavailableError());
    });
  };
  const setRetentionIntent = async (id, snapshotCapability, intentOptions) => {
    const key = validId(id);
    canonicalRetentionInstant(intentOptions?.now);
    if (typeof intentOptions?.deleteAfterCompleteExport !== 'boolean') {
      throw new TypeError('Intenção de retenção inválida.');
    }
    const expected = capabilityRevision(snapshotCapability, owner, key);
    const db = await open();
    return new Promise((resolve, reject) => {
      let modelRead = false;
      let revisionRead = false;
      let retentionRead = false;
      let modelValue;
      let revisionValue;
      let retentionValue;
      let result = null;
      let conflict = false;
      let settled = false;
      const finish = (handler, value) => { if (!settled) { settled = true; handler(value); } };
      const transaction = indexedDbBoundary(() => db.transaction([STORE_NAME, RETENTION_STORE_NAME], 'readwrite'));
      const auditStore = indexedDbObjectStore(transaction, () => transaction.objectStore(STORE_NAME));
      const retentionStore = indexedDbObjectStore(transaction, () => transaction.objectStore(RETENTION_STORE_NAME));
      const modelRequest = auditStore.get(key);
      const revisionRequest = auditStore.get(revisionKey(key));
      const retentionRequest = retentionStore.get(key);
      const apply = () => {
        if (!modelRead || !revisionRead || !retentionRead || result || conflict) return;
        let revision;
        let canonicalModel;
        try {
          revision = storedRevision(revisionValue);
          canonicalModel = materializeCanonicalAuditModel(key, modelValue, { allowMissing: true });
        } catch (error) {
          finish(reject, error);
          try { transaction.abort(); } catch {}
          return;
        }
        if (canonicalModel === undefined || revision !== expected) { conflict = true; return; }
        let current;
        try { current = validateRetentionMetadata(retentionValue, key); } catch (error) {
          finish(reject, error);
          try { transaction.abort(); } catch {}
          return;
        }
        const retentionMetadata = {
          ...current,
          deleteAfterCompleteExport: intentOptions.deleteAfterCompleteExport,
        };
        retentionStore.put(retentionMetadata);
        result = {
          revision,
          model: storageClone(canonicalModel, transaction),
          retention: storageClone(retentionMetadata, transaction),
        };
      };
      modelRequest.onsuccess = () => { modelRead = true; modelValue = modelRequest.result; apply(); };
      revisionRequest.onsuccess = () => { revisionRead = true; revisionValue = revisionRequest.result; apply(); };
      retentionRequest.onsuccess = () => { retentionRead = true; retentionValue = retentionRequest.result; apply(); };
      modelRequest.onerror = revisionRequest.onerror = retentionRequest.onerror = () => finish(reject, new AuditStorageUnavailableError());
      transaction.oncomplete = () => {
        if (conflict) finish(reject, new AuditRevisionConflictError());
        else if (!result) finish(reject, new AuditStorageUnavailableError());
        else finish(resolve, {
          revision: result.revision,
          capability: mintAuditSnapshot(owner, key, result.model, result.revision).capability,
          retention: result.retention,
        });
      };
      transaction.onerror = () => finish(reject, new AuditStorageUnavailableError());
      transaction.onabort = () => finish(reject, new AuditStorageUnavailableError());
    });
  };
  const markAuditInterrupted = async (id, latestState, options) => {
    const key = validId(id);
    const failedLatest = interruptedLatest(key, latestState);
    const instant = canonicalLeaseNow(options?.now);
    const db = await open();
    return new Promise((resolve, reject) => {
      let pending = 5;
      let modelValue;
      let revisionValue;
      let latestValue;
      let leaseValue;
      let deliveryValue;
      let result = null;
      let settled = false;
      const finish = (handler, value) => { if (!settled) { settled = true; handler(value); } };
      const transaction = indexedDbBoundary(() => db.transaction(STORE_NAME, 'readwrite'));
      const store = indexedDbObjectStore(transaction, () => transaction.objectStore(STORE_NAME));
      const apply = () => {
        pending -= 1;
        if (pending !== 0 || result) return;
        let revision;
        let entries;
        try {
          revision = storedRevision(revisionValue);
          modelValue = materializeCanonicalAuditModel(key, modelValue, { allowMissing: true });
          entries = canonicalDeliveryJournal(deliveryValue, key);
        } catch (error) {
          finish(reject, error);
          try { transaction.abort(); } catch {}
          return;
        }
        if (latestValue?.auditId !== key) {
          result = { updated: false, reason: 'stale' };
          return;
        }
        if (isTerminalAuditStatus(modelValue?.session?.status) ||
          isTerminalAuditStatus(latestValue.status)) {
          result = { updated: false, reason: 'terminal' };
          return;
        }
        if (!isInterruptibleAuditStatus(latestValue.status)) {
          result = { updated: false, reason: 'stale' };
          return;
        }
        if (activeExportLease(leaseValue, key, revision, instant.nowMs) || entries.length > 0) {
          result = { updated: false, reason: 'delivery-active' };
          return;
        }
        store.put(failedLatest, LATEST_KEY);
        result = { updated: true, reason: 'interrupted' };
      };
      const requests = [
        [store.get(key), value => { modelValue = value; }],
        [store.get(revisionKey(key)), value => { revisionValue = value; }],
        [store.get(LATEST_KEY), value => { latestValue = value; }],
        [store.get(exportLeaseKey(key)), value => { leaseValue = value; }],
        [store.get(exportDeliveryKey(key)), value => { deliveryValue = value; }],
      ];
      for (const [request, receive] of requests) {
        request.onsuccess = () => { receive(request.result); apply(); };
        request.onerror = () => finish(reject, new AuditStorageUnavailableError());
      }
      transaction.oncomplete = () => result
        ? finish(resolve, result)
        : finish(reject, new AuditStorageUnavailableError());
      transaction.onerror = () => finish(reject, new AuditStorageUnavailableError());
      transaction.onabort = () => finish(reject, new AuditStorageUnavailableError());
    });
  };

  const deleteAudit = async (id, snapshotCapability, deleteOptions) => {
    const key = validId(id);
    const instant = canonicalRetentionInstant(deleteOptions?.now);
    const expected = capabilityRevision(snapshotCapability, owner, key);
    const db = await open();
    return new Promise((resolve, reject) => {
      let pending = 5;
      let modelValue;
      let revisionValue;
      let leaseValue;
      let deliveryValue;
      let latestValue;
      let conflict = false;
      let busy = false;
      let applied = false;
      let settled = false;
      const finish = (handler, value) => { if (!settled) { settled = true; handler(value); } };
      const transaction = indexedDbBoundary(() => db.transaction([STORE_NAME, RETENTION_STORE_NAME], 'readwrite'));
      const auditStore = indexedDbObjectStore(transaction, () => transaction.objectStore(STORE_NAME));
      const retentionStore = indexedDbObjectStore(transaction, () => transaction.objectStore(RETENTION_STORE_NAME));
      const apply = () => {
        pending -= 1;
        if (pending !== 0 || applied) return;
        let revision;
        let canonicalModel;
        try {
          revision = storedRevision(revisionValue);
          canonicalModel = materializeCanonicalAuditModel(key, modelValue, { allowMissing: true });
        } catch (error) {
          finish(reject, error);
          try { transaction.abort(); } catch {}
          return;
        }
        if (canonicalModel === undefined || revision !== expected) { conflict = true; return; }
        try {
          busy = Boolean(activeExportLease(leaseValue, key, revision, instant.milliseconds)) ||
            canonicalDeliveryJournal(deliveryValue, key).length > 0;
        } catch { busy = true; }
        if (busy) return;
        applied = true;
        auditStore.delete(key);
        auditStore.delete(revisionKey(key));
        auditStore.delete(checkpointKey(key));
        auditStore.delete(pixelAttemptKey(key));
        auditStore.delete(exportLeaseKey(key));
        auditStore.delete(exportAttemptKey(key));
        auditStore.delete(exportDeliveryKey(key));
        auditStore.delete(exportReceiptKey(key));
        if (latestValue?.auditId === key) auditStore.delete(LATEST_KEY);
        retentionStore.delete(key);
      };
      const requests = [
        [auditStore.get(key), value => { modelValue = value; }],
        [auditStore.get(revisionKey(key)), value => { revisionValue = value; }],
        [auditStore.get(exportLeaseKey(key)), value => { leaseValue = value; }],
        [auditStore.get(exportDeliveryKey(key)), value => { deliveryValue = value; }],
        [auditStore.get(LATEST_KEY), value => { latestValue = value; }],
      ];
      for (const [request, receive] of requests) {
        request.onsuccess = () => { receive(request.result); apply(); };
        request.onerror = () => finish(reject, new AuditStorageUnavailableError());
      }
      transaction.oncomplete = () => {
        if (conflict) finish(reject, new AuditRevisionConflictError());
        else if (busy) finish(reject, new AuditDeleteBusyError());
        else if (!applied) finish(reject, new AuditStorageUnavailableError());
        else finish(resolve, { deleted: true });
      };
      transaction.onerror = () => finish(reject, new AuditStorageUnavailableError());
      transaction.onabort = () => finish(reject, new AuditStorageUnavailableError());
    });
  };
  const deleteAllAudits = async deleteOptions => {
    const instant = canonicalRetentionInstant(deleteOptions?.now);
    const db = await open();
    return new Promise((resolve, reject) => {
      let auditKeys;
      let retentionKeys;
      let keyReads = 0;
      let valueReadsPending = null;
      let busy = false;
      let deleted = null;
      let settled = false;
      const finish = (handler, value) => { if (!settled) { settled = true; handler(value); } };
      const transaction = indexedDbBoundary(() => db.transaction([STORE_NAME, RETENTION_STORE_NAME], 'readwrite'));
      const auditStore = indexedDbObjectStore(transaction, () => transaction.objectStore(STORE_NAME));
      const retentionStore = indexedDbObjectStore(transaction, () => transaction.objectStore(RETENTION_STORE_NAME));
      const auditKeysRequest = auditStore.getAllKeys();
      const retentionKeysRequest = retentionStore.getAllKeys();
      const decide = () => {
        if (keyReads !== 2 || valueReadsPending !== null) return;
        const modelKeys = auditKeys.filter(key => typeof key === 'string' && !isPrivateAuditKey(key));
        const workKeys = auditKeys.filter(key => typeof key === 'string' &&
          (key.startsWith(EXPORT_LEASE_KEY_PREFIX) || key.startsWith(EXPORT_DELIVERY_KEY_PREFIX)));
        const reads = [
          ...modelKeys.map(key => ({ key, kind: 'model' })),
          ...workKeys.map(key => ({ key, kind: 'work' })),
        ];
        valueReadsPending = reads.length;
        if (valueReadsPending === 0) {
          deleted = retentionKeys.length;
          auditStore.clear();
          retentionStore.clear();
          return;
        }
        for (const read of reads) {
          const request = auditStore.get(read.key);
          request.onsuccess = () => {
            try {
              if (read.kind === 'model') {
                materializeCanonicalAuditModel(read.key, request.result);
              } else if (read.key.startsWith(EXPORT_LEASE_KEY_PREFIX)) {
                const auditId = read.key.slice(EXPORT_LEASE_KEY_PREFIX.length);
                const lease = request.result;
                if (lease && activeExportLease(lease, auditId, lease.revision, instant.milliseconds)) busy = true;
              } else {
                const auditId = read.key.slice(EXPORT_DELIVERY_KEY_PREFIX.length);
                if (canonicalDeliveryJournal(request.result, auditId).length > 0) busy = true;
              }
            } catch (error) {
              if (read.kind === 'model') {
                finish(reject, error);
                try { transaction.abort(); } catch {}
                return;
              }
              busy = true;
            }
            valueReadsPending -= 1;
            if (valueReadsPending === 0 && !busy) {
              deleted = retentionKeys.length;
              auditStore.clear();
              retentionStore.clear();
            }
          };
          request.onerror = () => finish(reject, new AuditStorageUnavailableError());
        }
      };
      auditKeysRequest.onsuccess = () => { auditKeys = auditKeysRequest.result; keyReads += 1; decide(); };
      retentionKeysRequest.onsuccess = () => { retentionKeys = retentionKeysRequest.result; keyReads += 1; decide(); };
      auditKeysRequest.onerror = retentionKeysRequest.onerror = () => finish(reject, new AuditStorageUnavailableError());
      transaction.oncomplete = () => {
        if (busy) finish(reject, new AuditDeleteBusyError());
        else if (deleted === null) finish(reject, new AuditStorageUnavailableError());
        else finish(resolve, { deleted });
      };
      transaction.onerror = () => finish(reject, new AuditStorageUnavailableError());
      transaction.onabort = () => finish(reject, new AuditStorageUnavailableError());
    });
  };
  const finalizeExportAndMaybeDelete = async (
    id, model, latestState, snapshotCapability, finalizeOptions,
  ) => {
    const key = validId(id);
    const canonicalModel = materializeCanonicalAuditModel(key, model);
    assertFinalizationCorrelation(key, canonicalModel, latestState);
    if (finalizeOptions?.clearDeliveryJournal !== true ||
      typeof finalizeOptions?.deleteAfterCompleteExport !== 'boolean') {
      throw new TypeError('Finalização de exportação inválida.');
    }
    const expected = capabilityRevision(snapshotCapability, owner, key);
    const normalized = canonicalLeaseOptions({ ...finalizeOptions, release: true }, expected);
    const modelClone = storageClone(canonicalModel);
    const latestClone = latestState === undefined ? undefined : storageClone(latestState);
    const db = await open();
    return new Promise((resolve, reject) => {
      let pending = 7;
      let modelValue;
      let revisionValue;
      let leaseValue;
      let attemptValue;
      let deliveryValue;
      let retentionValue;
      let conflict = false;
      let leaseConflict = false;
      let result = null;
      let settled = false;
      const finish = (handler, value) => { if (!settled) { settled = true; handler(value); } };
      const transaction = indexedDbBoundary(() => db.transaction([STORE_NAME, RETENTION_STORE_NAME], 'readwrite'));
      const auditStore = indexedDbObjectStore(transaction, () => transaction.objectStore(STORE_NAME));
      const retentionStore = indexedDbObjectStore(transaction, () => transaction.objectStore(RETENTION_STORE_NAME));
      const apply = () => {
        pending -= 1;
        if (pending !== 0 || result || conflict || leaseConflict) return;
        let revision;
        let entries;
        let attemptRecord;
        try {
          revision = storedRevision(revisionValue);
          modelValue = materializeCanonicalAuditModel(key, modelValue, { allowMissing: true });
          validateRetentionMetadata(retentionValue, key);
          entries = canonicalDeliveryJournal(deliveryValue, key);
        } catch (error) { finish(reject, error); return; }
        if (modelValue === undefined || revision !== expected) { conflict = true; return; }
        const lease = activeExportLease(leaseValue, key, revision, normalized.nowMs);
        if (!lease || lease.ownerId !== normalized.ownerId || lease.exportAttempt !== normalized.exportAttempt ||
          !['queued', 'running', 'delivering'].includes(lease.phase)) {
          leaseConflict = true;
          return;
        }
        try { attemptRecord = correlatedExportAttemptRecord(attemptValue, key, lease); }
        catch (error) { finish(reject, error); return; }
        if (entries.some(entry => entry.ownerId !== lease.ownerId ||
          entry.exportAttempt !== lease.exportAttempt || entry.state !== 'terminal') ||
          !terminalDeliveriesMatchReceipt(entries, latestClone, key, lease.ownerId, lease.exportAttempt)) {
          leaseConflict = true;
          return;
        }
        const receipt = exportReceiptFromLatest(latestClone, key);
        if (receipt && (receipt.modelRevision !== revision || receipt.attemptId !== String(lease.exportAttempt))) {
          leaseConflict = true; return;
        }
        const nextRevision = revision + 1;
        auditStore.put(modelClone, key);
        auditStore.put(nextRevision, revisionKey(key));
        auditStore.put(attemptRecord, exportAttemptKey(key));
        auditStore.delete(exportLeaseKey(key));
        auditStore.delete(exportDeliveryKey(key));
        const receiptWrite = receipt ? auditStore.put(receipt, exportReceiptKey(key)) : auditStore.delete(exportReceiptKey(key));
        receiptWrite.onerror = () => {
          abortIndexedDbTransaction(transaction);
          finish(reject, new AuditStorageUnavailableError());
        };
        if (latestClone !== undefined) {
          auditStore.put(pendingCleanupLatest({ ...latestClone, exportAttempt: lease.exportAttempt }, []), LATEST_KEY);
        }
        result = { deleted: false, revision: nextRevision, model: modelClone };
      };
      const requests = [
        [auditStore.get(key), value => { modelValue = value; }],
        [auditStore.get(revisionKey(key)), value => { revisionValue = value; }],
        [auditStore.get(exportLeaseKey(key)), value => { leaseValue = value; }],
        [auditStore.get(exportAttemptKey(key)), value => { attemptValue = value; }],
        [auditStore.get(exportDeliveryKey(key)), value => { deliveryValue = value; }],
        [auditStore.get(LATEST_KEY), () => {}],
        [retentionStore.get(key), value => { retentionValue = value; }],
      ];
      for (const [request, receive] of requests) {
        request.onsuccess = () => { receive(request.result); apply(); };
        request.onerror = () => finish(reject, new AuditStorageUnavailableError());
      }
      transaction.oncomplete = () => {
        if (conflict) finish(reject, new AuditRevisionConflictError());
        else if (leaseConflict) finish(reject, new AuditExportLeaseConflictError());
        else if (!result) finish(reject, new AuditStorageUnavailableError());
        else if (result.deleted) finish(resolve, { deleted: true });
        else finish(resolve, {
          deleted: false,
          revision: result.revision,
          capability: mintAuditSnapshot(owner, key, result.model, result.revision).capability,
        });
      };
      transaction.onerror = () => finish(reject, new AuditStorageUnavailableError());
      transaction.onabort = () => finish(reject, new AuditStorageUnavailableError());
    });
  };
  const cleanupExpiredAudits = async optionsValue => {
    const instant = canonicalRetentionInstant(optionsValue?.now);
    const limit = optionsValue?.limit ?? 25;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 25) {
      throw new TypeError('Limite de limpeza inválido.');
    }
    if (!keyRange || typeof keyRange.upperBound !== 'function') throw new AuditStorageUnavailableError();
    const db = await open();
    return new Promise((resolve, reject) => {
      let scanned = 0;
      let deleted = 0;
      let blocked = 0;
      let initialCount = 0;
      let countRead = false;
      let markerRead = false;
      let marker = null;
      let cursorFinished = false;
      let settled = false;
      const finish = (handler, value) => {
        if (!settled) { settled = true; handler(value); }
      };
      const transaction = indexedDbBoundary(() => db.transaction([STORE_NAME, RETENTION_STORE_NAME], 'readwrite'));
      const auditStore = indexedDbObjectStore(transaction, () => transaction.objectStore(STORE_NAME));
      const retentionStore = indexedDbObjectStore(transaction, () => transaction.objectStore(RETENTION_STORE_NAME));
      const range = indexedDbBoundary(() => keyRange.upperBound(instant.iso), transaction);
      const index = retentionStore.index('byExpiresAt');
      const countRequest = index.count(range);
      const markerRequest = auditStore.get(RETENTION_CLEANUP_CURSOR_KEY);
      let cursorRequest;
      countRequest.onsuccess = () => {
        initialCount = countRequest.result;
        countRead = true;
      };
      countRequest.onerror = () => finish(reject, new AuditStorageUnavailableError());
      markerRequest.onsuccess = () => {
        markerRead = true;
        marker = cleanupCursorRecord(markerRequest.result);
        if (markerRequest.result !== undefined && marker === null) {
          auditStore.delete(RETENTION_CLEANUP_CURSOR_KEY);
        }
        cursorRequest = index.openCursor(range);
        cursorRequest.onsuccess = handleCursor;
        cursorRequest.onerror = () => finish(reject, new AuditStorageUnavailableError());
      };
      markerRequest.onerror = () => finish(reject, new AuditStorageUnavailableError());
      const handleCursor = () => {
        const cursor = cursorRequest.result;
        if (marker && cursor) {
          const current = { expiresAt: String(cursor.key), auditId: String(cursor.primaryKey) };
          const order = compareRetentionPosition(current, marker);
          if (order <= 0) {
            if (order < 0 && typeof cursor.continuePrimaryKey === 'function') {
              continueIndexedDbCursor(
                transaction, cursor, 'continuePrimaryKey', marker.expiresAt, marker.auditId,
              );
            } else {
              continueIndexedDbCursor(transaction, cursor, 'continue');
            }
            return;
          }
          marker = null;
        }
        if (!cursor || scanned >= limit) {
          cursorFinished = true;
          if (scanned < limit) auditStore.delete(RETENTION_CLEANUP_CURSOR_KEY);
          return;
        }
        let metadata;
        try { metadata = validateRetentionMetadata(cursor.value, cursor.primaryKey); } catch (error) {
          finish(reject, error);
          try { transaction.abort(); } catch {}
          return;
        }
        scanned += 1;
        if (scanned < limit) continueIndexedDbCursor(transaction, cursor, 'continue');
        else {
          cursorFinished = true;
          auditStore.put({
            schemaVersion: 1,
            expiresAt: metadata.expiresAt,
            auditId: metadata.auditId,
          }, RETENTION_CLEANUP_CURSOR_KEY);
        }
        const modelRequest = auditStore.get(metadata.auditId);
        const revisionRequest = auditStore.get(revisionKey(metadata.auditId));
        const leaseRequest = auditStore.get(exportLeaseKey(metadata.auditId));
        const deliveryRequest = auditStore.get(exportDeliveryKey(metadata.auditId));
        let modelRead = false;
        let revisionRead = false;
        let leaseRead = false;
        let deliveryRead = false;
        let modelValue;
        let revisionValue;
        let leaseValue;
        let deliveryValue;
        const decide = () => {
          if (!modelRead || !revisionRead || !leaseRead || !deliveryRead) return;
          let busy = true;
          try {
            materializeCanonicalAuditModel(metadata.auditId, modelValue);
            const revision = storedRevision(revisionValue);
            busy = Boolean(activeExportLease(leaseValue, metadata.auditId, revision, instant.milliseconds)) ||
              canonicalDeliveryJournal(deliveryValue, metadata.auditId).length > 0;
          } catch (error) {
            if (error?.code === 'AUDIT_MODEL_INPUT_INVALID') {
              finish(reject, error);
              try { transaction.abort(); } catch {}
              return;
            }
            busy = true;
          }
          if (busy) blocked += 1;
          else {
            auditStore.delete(metadata.auditId);
            auditStore.delete(revisionKey(metadata.auditId));
            auditStore.delete(checkpointKey(metadata.auditId));
            auditStore.delete(pixelAttemptKey(metadata.auditId));
            auditStore.delete(exportLeaseKey(metadata.auditId));
            auditStore.delete(exportAttemptKey(metadata.auditId));
            auditStore.delete(exportDeliveryKey(metadata.auditId));
            auditStore.delete(exportReceiptKey(metadata.auditId));
            const latestRequest = auditStore.get(LATEST_KEY);
            latestRequest.onsuccess = () => {
              if (latestRequest.result?.auditId === metadata.auditId) auditStore.delete(LATEST_KEY);
            };
            retentionStore.delete(metadata.auditId);
            deleted += 1;
          }
        };
        modelRequest.onsuccess = () => { modelRead = true; modelValue = modelRequest.result; decide(); };
        revisionRequest.onsuccess = () => { revisionRead = true; revisionValue = revisionRequest.result; decide(); };
        leaseRequest.onsuccess = () => { leaseRead = true; leaseValue = leaseRequest.result; decide(); };
        deliveryRequest.onsuccess = () => { deliveryRead = true; deliveryValue = deliveryRequest.result; decide(); };
        modelRequest.onerror = revisionRequest.onerror = leaseRequest.onerror = deliveryRequest.onerror = () => finish(reject, new AuditStorageUnavailableError());
      };
      transaction.oncomplete = () => {
        if (!countRead || !markerRead || !cursorFinished) finish(reject, new AuditStorageUnavailableError());
        else finish(resolve, { scanned, deleted, remaining: Math.max(0, initialCount - deleted), blocked });
      };
      transaction.onerror = () => finish(reject, new AuditStorageUnavailableError());
      transaction.onabort = () => finish(reject, new AuditStorageUnavailableError());
    });
  };
  const api = {
    setAudit(id, model, options) { return mutateAudit(id, model, undefined, undefined, options); },
    async listAuditDeletionCandidatesV1() {
      return deletionTransaction([STORE_NAME, RETENTION_STORE_NAME], 'readonly', context => {
        const audits = context.store(STORE_NAME);
        context.read(context.store(RETENTION_STORE_NAME).getAllKeys(), keys => {
          const candidates = [];
          const sorted = keys.filter(key => typeof key === 'string').sort();
          const next = index => {
            if (index === sorted.length) { context.setResult(Object.freeze(candidates)); return; }
            const auditId = sorted[index];
            context.read(audits.get(auditId), model => context.read(audits.get(revisionKey(auditId)), revision => {
              const candidate = manualDeletionCandidate(auditId, model, revision);
              if (candidate) candidates.push(candidate);
              next(index + 1);
            }));
          };
          next(0);
        });
      });
    },
    async getAudit(id) {
      const key = validId(id);
      return materializeCanonicalAuditModel(key, await get(key), { allowMissing: true });
    },
    getAuditSnapshot,
    commitAuditWithCheckpointIfAbsent,
    getReportRevision,
    setLatest(state) { return put(LATEST_KEY, state); },
    getLatest() { return get(LATEST_KEY); },
    markAuditInterrupted,
    commitAudit(id, model, latestState, options) {
      return mutateAudit(id, model, latestState, undefined, options);
    },
    commitAuditIfRevision(id, model, latestState, snapshotCapability) {
      return mutateAudit(id, model, latestState, snapshotCapability);
    },
    async commitAuditReviewIfRevision(id, model, snapshotCapability) {
      const transition = await canonicalReviewTransition(id, model, snapshotCapability, owner);
      return mutateAudit(
        id,
        transition,
        undefined,
        snapshotCapability,
        { review: true },
      );
    },
    acquireExportLease,
    claimExportLease(id, snapshotCapability, options) {
      return mutateWithExportLease(id, null, options?.latestState, snapshotCapability, options, 'claim');
    },
    beginExportDelivery(id, snapshotCapability, options) {
      return mutateWithExportLease(id, null, options?.latestState, snapshotCapability, options, 'delivery');
    },
    commitAuditIfRevisionWithExportLease(id, model, latestState, snapshotCapability, options) {
      return mutateWithExportLease(id, model, latestState, snapshotCapability, options, false);
    },
    releaseExportLease,
    getExportLeaseState,
    assertExportLease,
    recordExportDelivery,
    resolveExportDelivery,
    getExportDeliveryJournal,
    async getExportReceipt(id) {
      const key = validId(id); const entries = await getExportDeliveryJournal(key);
      if (entries.length) return exportReceiptFromRevision(await getReportRevision(key), entries);
      const values = await readKeys([exportReceiptKey(key), revisionKey(key), LATEST_KEY]);
      return confirmedReceipt(values.get(exportReceiptKey(key)), key, storedRevision(values.get(revisionKey(key)))) ??
        exportReceiptFromLatest(values.get(LATEST_KEY), key);
    },
    getAuditRetention,
    nextExpiresAtV1,
    stageExpiredAuditDeletionsV1,
    stageAuditDeletionV1,
    listDeletionTombstonesV1,
    recordDeletionCleanupFailureV1,
    completeAuditDeletionV1,
    setRetentionIntent,
    cleanupExpiredAudits,
    deleteAudit,
    deleteAllAudits,
    finalizeExportAndMaybeDelete,
  };
  PRIVATE_PIXEL_ATTEMPT_STORES.set(api, Object.freeze({
    async read(value) {
      const expected = pixelAttemptCorrelation(value);
      if (!expected) return false;
      try {
        const values = await readKeys([
          expected.auditId, revisionKey(expected.auditId), pixelAttemptKey(expected.auditId),
        ]);
        const model = await verifyAuditIntegritySnapshot(values.get(expected.auditId));
        const revision = storedRevision(values.get(revisionKey(expected.auditId)));
        const companion = parsePixelAttemptCompanion(values.get(pixelAttemptKey(expected.auditId)), expected.auditId);
        return revision === 1 && model.auditId === expected.auditId &&
          ['complete', 'partial', 'failed', 'cancelled'].includes(model.session.status) &&
          samePixelAttempt(companion, expected);
      } catch { return false; }
    },
    async remove(value) {
      const expected = pixelAttemptCorrelation(value);
      if (!expected) return false;
      const db = await open();
      return new Promise((resolve, reject) => {
        let settled = false;
        let matched = false;
        let confirmed = false;
        const finish = (handler, value) => { if (!settled) { settled = true; handler(value); } };
        const transaction = indexedDbBoundary(() => db.transaction(STORE_NAME, 'readwrite'));
        const store = indexedDbObjectStore(transaction, () => transaction.objectStore(STORE_NAME));
        const request = store.get(pixelAttemptKey(expected.auditId));
        request.onsuccess = () => {
          if (request.result === undefined) {
            matched = true;
            confirmed = true;
            return;
          }
          const companion = parsePixelAttemptCompanion(request.result, expected.auditId);
          matched = samePixelAttempt(companion, expected);
          if (!matched) return;
          const confirmAbsent = () => {
            let confirmation;
            try { confirmation = store.get(pixelAttemptKey(expected.auditId)); }
            catch { return; }
            confirmation.onsuccess = () => { confirmed = confirmation.result === undefined; };
            confirmation.onerror = () => finish(reject, new AuditStorageUnavailableError());
          };
          try {
            const deletion = store.delete(pixelAttemptKey(expected.auditId));
            deletion.onsuccess = confirmAbsent;
            deletion.onerror = () => finish(reject, new AuditStorageUnavailableError());
          } catch { confirmAbsent(); }
        };
        request.onerror = () => finish(reject, new AuditStorageUnavailableError());
        transaction.oncomplete = () => finish(resolve, matched && confirmed);
        transaction.onerror = () => finish(reject, new AuditStorageUnavailableError());
        transaction.onabort = () => finish(reject, new AuditStorageUnavailableError());
      });
    },
  }));
  return api;
}
