import { EXPORT_FORMATS_V1 } from '../export/export-formats.js';

const AUDIT_ID = /^[A-Za-z0-9._:-]{1,160}$/u;
const ATTEMPT = /^[1-9][0-9]*$/u;
const CAPABILITY = /^[A-Za-z0-9_-]{22}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MIME = Object.freeze({
  html: 'text/html;charset=utf-8',
  pdf: 'application/pdf',
  csv: 'text/csv;charset=utf-8',
  json: 'application/json;charset=utf-8',
});
const RECEIPT_KEYS = Object.freeze([
  'version', 'auditId', 'modelRevision', 'modelHash', 'attemptId', 'status', 'formats',
]);
const FORMAT_KEYS = Object.freeze([
  'format', 'mimeType', 'byteSize', 'sha256', 'downloadId', 'state',
]);
const PROOF_KEYS = Object.freeze([
  'version', 'auditId', 'sessionCapabilityId', 'attemptId', 'modelRevision',
  'receiptStatus', 'applied', 'deleted', 'status', 'notified',
]);

function ownData(value, key) {
  try {
    const descriptor = value && typeof value === 'object'
      ? Object.getOwnPropertyDescriptor(value, key)
      : null;
    return descriptor?.enumerable && Object.hasOwn(descriptor, 'value')
      ? descriptor.value
      : undefined;
  } catch { return undefined; }
}

function exact(value, keys) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) return null;
    const names = Reflect.ownKeys(value);
    if (names.length !== keys.length ||
      names.some(name => typeof name !== 'string' || !keys.includes(name))) return null;
    const copy = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      copy[key] = descriptor.value;
    }
    return copy;
  } catch { return null; }
}

function denseArray(value) {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
    const keys = Reflect.ownKeys(value);
    const expected = ['length', ...Array.from({ length: value.length }, (_unused, index) => String(index))];
    if (keys.length !== expected.length || expected.some(key => !keys.includes(key))) return null;
    const copy = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      copy.push(descriptor.value);
    }
    return copy;
  } catch { return null; }
}

function validAttempt(value) {
  if (!ATTEMPT.test(value ?? '')) return false;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 && String(number) === value;
}

function receiptRecord(value) {
  const receipt = exact(value, RECEIPT_KEYS);
  const rawFormats = receipt ? denseArray(receipt.formats) : null;
  if (!receipt || receipt.version !== 1 || !AUDIT_ID.test(receipt.auditId ?? '') ||
    !Number.isSafeInteger(receipt.modelRevision) || receipt.modelRevision < 1 ||
    !SHA256.test(receipt.modelHash ?? '') || !validAttempt(receipt.attemptId) ||
    !['complete', 'partial'].includes(receipt.status) || !rawFormats ||
    rawFormats.length > EXPORT_FORMATS_V1.length ||
    (receipt.status === 'complete' && rawFormats.length !== EXPORT_FORMATS_V1.length)) return null;

  const formats = [];
  const downloadIds = new Set();
  let priorIndex = -1;
  for (const value of rawFormats) {
    const row = exact(value, FORMAT_KEYS);
    const formatIndex = row ? EXPORT_FORMATS_V1.indexOf(row.format) : -1;
    if (!row || formatIndex <= priorIndex || row.mimeType !== MIME[row.format] ||
      !Number.isSafeInteger(row.byteSize) || row.byteSize < 0 || !SHA256.test(row.sha256 ?? '') ||
      !Number.isSafeInteger(row.downloadId) || row.downloadId < 0 ||
      row.state !== 'complete' || downloadIds.has(row.downloadId)) return null;
    formats.push(Object.freeze(row));
    priorIndex = formatIndex;
    downloadIds.add(row.downloadId);
  }
  if (receipt.status === 'complete' &&
    formats.some((row, index) => row.format !== EXPORT_FORMATS_V1[index])) return null;
  return Object.freeze({ ...receipt, formats: Object.freeze(formats) });
}

function pendingProofRecord(value) {
  const proof = exact(value, PROOF_KEYS);
  if (!proof || proof.version !== 1 || !AUDIT_ID.test(proof.auditId ?? '') ||
    !CAPABILITY.test(proof.sessionCapabilityId ?? '') || !validAttempt(proof.attemptId) ||
    !Number.isSafeInteger(proof.modelRevision) || proof.modelRevision < 1 ||
    !['complete', 'partial'].includes(proof.receiptStatus) || proof.applied !== false ||
    proof.deleted !== false || proof.status !== null || proof.notified !== false) return null;
  return Object.freeze(proof);
}

function same(left, right) {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object' ||
    Array.isArray(left) !== Array.isArray(right)) return false;
  const leftKeys = Reflect.ownKeys(left);
  const rightKeys = Reflect.ownKeys(right);
  return leftKeys.length === rightKeys.length && leftKeys.every(key =>
    typeof key === 'string' && rightKeys.includes(key) && same(ownData(left, key), ownData(right, key)));
}

function correlated(receipt, proof, auditId, attemptId) {
  return Boolean(receipt && proof && receipt.auditId === auditId && proof.auditId === auditId &&
    receipt.attemptId === attemptId && proof.attemptId === attemptId &&
    receipt.modelRevision === proof.modelRevision && receipt.status === proof.receiptStatus);
}

function alreadyDeletedSnapshot(value) {
  return Boolean(value && typeof value === 'object' && ownData(value, 'model') === undefined &&
    ownData(value, 'revision') === 0 && ownData(value, 'capability') === null);
}

export function createExportCompletionStore({ auditStore, emitTerminal, deleteCompletedAudit }) {
  if (!auditStore || typeof auditStore.getExportReceipt !== 'function' ||
    typeof auditStore.getAuditRetention !== 'function' ||
    typeof auditStore.getAuditSnapshot !== 'function' || typeof emitTerminal !== 'function' ||
    (deleteCompletedAudit !== undefined && typeof deleteCompletedAudit !== 'function')) {
    throw new TypeError('EXPORT_COMPLETION_STORE_INVALID');
  }

  return Object.freeze({
    ...auditStore,
    async emitTerminal(event) { await emitTerminal(event); },
    async completeExport(auditId, options) {
      if (!AUDIT_ID.test(auditId ?? '')) throw new Error('EXPORT_COMPLETE_DENIED');
      const input = exact(options, ['attemptId', 'receipt', 'terminalProof']) ??
        exact(options, ['attemptId', 'terminalProof']);
      const proof = input ? pendingProofRecord(input.terminalProof) : null;
      if (!input || !validAttempt(input.attemptId) || input.attemptId !== proof?.attemptId ||
        proof.auditId !== auditId) throw new Error('EXPORT_COMPLETE_DENIED');

      const durable = receiptRecord(await auditStore.getExportReceipt(auditId));
      const supplied = Object.hasOwn(input, 'receipt') ? receiptRecord(input.receipt) : null;
      if (Object.hasOwn(input, 'receipt') && (!supplied || !durable || !same(durable, supplied))) {
        throw new Error('EXPORT_RECEIPT_DENIED');
      }

      if (!durable) {
        if (Object.hasOwn(input, 'receipt') || proof.receiptStatus !== 'complete') {
          throw new Error('EXPORT_RECEIPT_DENIED');
        }
        const snapshot = await auditStore.getAuditSnapshot(auditId);
        if (!alreadyDeletedSnapshot(snapshot)) throw new Error('EXPORT_RECEIPT_DENIED');
        return Object.freeze({ completed: true, deleted: true, status: 'complete' });
      }
      if (!correlated(durable, proof, auditId, input.attemptId)) {
        throw new Error('EXPORT_RECEIPT_DENIED');
      }
      if (durable.status === 'partial') {
        return Object.freeze({ completed: true, deleted: false, status: 'partial' });
      }

      const retention = await auditStore.getAuditRetention(auditId);
      if (ownData(retention, 'deleteAfterCompleteExport') !== true) {
        return Object.freeze({ completed: true, deleted: false, status: 'complete' });
      }
      if (!deleteCompletedAudit) {
        return Object.freeze({ completed: true, deleted: false, status: 'complete' });
      }
      const deletion = await deleteCompletedAudit(Object.freeze({
        auditId,
        expectedRevision: durable.modelRevision + 1,
        attemptId: input.attemptId,
      }));
      if (ownData(deletion, 'ok') === true && ownData(deletion, 'auditId') === auditId &&
        ownData(deletion, 'deleted') === true) {
        return Object.freeze({ completed: true, deleted: true, status: 'complete' });
      }
      const code = ownData(deletion, 'code');
      if (ownData(deletion, 'ok') === false &&
        ['AUDIT_REVISION_CONFLICT', 'AUDIT_DELETE_BUSY'].includes(code)) {
        return Object.freeze({ completed: true, deleted: false, status: 'complete' });
      }
      throw new Error('EXPORT_COMPLETE_DENIED');
    },
  });
}
