import { validateExecutionCheckpoint } from './execution-checkpoint.js';
import {
  readAttachedAuditCorrelationForRecovery,
  readAttachedAuditRecoveryGrant,
  readAttachedCopyNavigationForRecovery,
  readAuditSessionForWorker,
  readBatchAuditCorrelationForRecovery,
  readClaimedAttachedAuditGrant,
  readNavigationAuditCorrelationForRecovery,
  readPreparedAttachedAuditFact,
} from './target-capabilities.js';
import { isCapturePolicyV1 } from '../core/privacy/capture-policy.js';
import { isEvidenceUrlV1 } from '../core/privacy/evidence-url.js';
import { verifyAuditIntegritySnapshot } from '../core/report/integrity.js';
import { copyPanelResultBundleV1 } from '../panel/panel-result-bundle.js';
import { parseStorageGetEnvelope } from './storage-get-envelope.js';
import { createPixelPrivacyGateV1 } from './pixel-privacy-gate.js';
import { isPixelCommitClockV1 } from './pixel-commit-clock.js';
import { isTerminalDeliveryV1 } from './panel-port.js';

export const ACTIVE_AUDIT_JOB_KEY = 'audita:active-audit-job:v1';
const START_JOURNAL_KEY = 'audita:start-journal:v1';
export const retentionPreferenceStorageKey = auditId => `audita:retention-preference:v1:${auditId}`;
export const executionCheckpointStorageKey = auditId => `audita:execution-checkpoint:v1:${auditId}`;
const urlRequestedEvidenceStorageKey = auditId => `audita:url-requested-evidence:v1:${auditId}`;

const FACTORY_KEYS = Object.freeze([
  'authority', 'sessionArea', 'panelCoordinator', 'targetQueue', 'cleanupBarrier', 'runAttachedAuditExecution',
  'persistLatest', 'persistCheckpoint', 'removeCheckpoint', 'commitTerminalAudit',
  'readAuditSnapshot', 'readReportRevision', 'readLatest', 'buildPanelResultBundle', 'recordHighlightBinding',
  'pixelCommitClock', 'epochNow', 'modelNow', 'createAbortController', 'pixelState', 'probeDocumentIdentity',
  'probeSensitiveCaptureSignals', 'pixelAttemptLifecycle', 'schedulePixelExpiry', 'prepareAttachedCopyPlan',
  'recordPageMarkerOrigin',
]);
const URL_FACTORY_KEYS = Object.freeze([...FACTORY_KEYS, 'runUrlAuditExecution', 'clearUrlAuditResources']);
const BATCH_FACTORY_KEYS = Object.freeze([
  ...URL_FACTORY_KEYS, 'runBatchAuditExecution', 'clearBatchAuditResources', 'clearBatchAuditProgress',
  'discardBatchAuditProgress',
]);
const BATCH_RESUME_FACTORY_KEYS = Object.freeze([
  ...BATCH_FACTORY_KEYS, 'resumeBatchAuditExecution', 'recoverBatchAuditExecution',
]);
const BEGIN_KEYS = Object.freeze([
  'capabilityId', 'eventNonce', 'auditId', 'capturePolicy', 'retentionPreference', 'senderContext',
]);
const URL_BEGIN_KEYS = Object.freeze([
  'capabilityId', 'auditId', 'senderContext', 'capturePolicy', 'retentionPreference', 'plan',
]);
const BATCH_BEGIN_KEYS = Object.freeze([
  'capabilityId', 'auditId', 'senderContext', 'capturePolicy', 'retentionPreference', 'preparePlan',
]);
const BATCH_PLAN_KEYS = Object.freeze(['kind', 'queueId', 'acceptedCount']);
const URL_PLAN_KEYS = Object.freeze([
  'kind', 'ownershipId', 'navigationToken', 'navigationPurpose', 'evidenceUrl', 'sessionDigest',
]);
const ATTACHED_RESUME_KEYS = Object.freeze(['auditId', 'sessionCapabilityId', 'windowId', 'consentId', 'mode']);
const SINGLE_RESUME_KEYS = Object.freeze(['auditId', 'sessionCapabilityId', 'windowId', 'mode']);
const ACTIVE_KEYS = Object.freeze([
  'version', 'auditId', 'capabilityId', 'sessionCapabilityId', 'windowId', 'mode',
  'state', 'commitState', 'expectedTerminalRevision', 'createdAt', 'updatedAt',
]);
const JOURNAL_KEYS = Object.freeze([
  'version', 'capabilityId', 'auditId', 'windowId', 'state', 'sessionCapabilityId', 'createdAt', 'updatedAt',
]);
const BATCH_JOURNAL_KEYS = Object.freeze([
  'version', 'capabilityId', 'auditId', 'windowId', 'mode', 'state',
  'sessionCapabilityId', 'createdAt', 'updatedAt',
]);
const ATTACHED_COPY_JOURNAL_KEYS = Object.freeze([
  'version', 'capabilityId', 'auditId', 'windowId', 'mode', 'navigationPurpose', 'ownershipId',
  'state', 'sessionCapabilityId', 'createdAt', 'updatedAt',
]);
const LATEST_KEYS = Object.freeze([
  'version', 'auditId', 'status', 'percent', 'message', 'failureCode', 'modelRevision', 'updatedAt',
]);
const CAPABILITY = /^[A-Za-z0-9_-]{22}$/u;
const AUDIT_ID = /^[A-Za-z0-9._:-]{1,160}$/u;
const DIGEST = /^hmac-sha256:[A-Za-z0-9_-]{43}$/u;
const FAILURE_CODES = new Set(['PRIVACY_PAUSED', 'TARGET_CHANGED', 'AUDIT_FAILED']);
const TARGET_REASONS = new Set([
  'TAB_LOADING', 'TAB_URL_CHANGED', 'TAB_PENDING_URL', 'TAB_DISCARDED', 'TAB_REMOVED', 'WINDOW_REMOVED',
]);
const PIXEL_LIQUIDATION_REASONS = new Set([
  'PIXEL_CONSENT_EXPIRED', 'PIXEL_CONSENT_DOCUMENT_CHANGED', 'PIXEL_RESUME_INTERRUPTED',
  'AUDIT_CANCELLED', 'SESSION_ENDED',
]);
const TARGET_UNAVAILABLE_SENTINEL = Object.freeze(Object.create(null));
const AUDIT_REVOKED_SENTINEL = Object.freeze(Object.create(null));
const AUDIT_CANCELLATION_PENDING_SENTINEL = Object.freeze(Object.create(null));

function freeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freeze(child, seen);
  return Object.freeze(value);
}

function exact(value, keys) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return null;
    const own = Reflect.ownKeys(value);
    if (own.length !== keys.length || own.some(key => typeof key !== 'string' || !keys.includes(key))) return null;
    const copy = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      copy[key] = descriptor.value;
    }
    return copy;
  } catch { return null; }
}

function acceptedTerminalDelivery(value) {
  if (!isTerminalDeliveryV1(value)) return false;
  const receipt = exact(value, ['version', 'state']);
  return Boolean(receipt?.version === 1 && ['delivered', 'deferred'].includes(receipt.state));
}

function safeEpoch(now) {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('AUDIT_START_FAILED');
  return value;
}

function canonicalModelTime(modelNow) {
  const value = modelNow();
  if (typeof value !== 'string') throw new TypeError('AUDIT_START_FAILED');
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) throw new TypeError('AUDIT_START_FAILED');
  return value;
}

function same(left, right) {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) !== Array.isArray(right)) return false;
  const leftKeys = Reflect.ownKeys(left);
  const rightKeys = Reflect.ownKeys(right);
  return leftKeys.length === rightKeys.length && leftKeys.every(key => rightKeys.includes(key) && same(left[key], right[key]));
}

function missingAuditSnapshot(value) {
  const snapshot = exact(value, ['model', 'revision', 'capability']);
  return snapshot !== null && snapshot.model === undefined && snapshot.revision === 0 && snapshot.capability === null;
}

function activeRecord(value) {
  const record = exact(value, ACTIVE_KEYS);
  if (!record || record.version !== 1 || !AUDIT_ID.test(record.auditId ?? '') ||
    !CAPABILITY.test(record.capabilityId ?? '') || !CAPABILITY.test(record.sessionCapabilityId ?? '') ||
    !Number.isSafeInteger(record.windowId) || record.windowId < 0 || !['attached', 'single', 'batch'].includes(record.mode) ||
    !Number.isSafeInteger(record.createdAt) || record.createdAt < 0 ||
    !Number.isSafeInteger(record.updatedAt) || record.updatedAt < record.createdAt) return null;
  if (record.state === 'running') {
    if (record.commitState !== 'none' || record.expectedTerminalRevision !== null) return null;
  } else if (record.state === 'privacy-paused') {
    if (record.commitState !== 'none' || record.expectedTerminalRevision !== null) return null;
  } else if (record.state === 'finalizing') {
    if (!['pending', 'confirmed'].includes(record.commitState) || record.expectedTerminalRevision !== 1) return null;
  } else return null;
  return freeze(record);
}

function journalRecord(value) {
  const batch = exact(value, BATCH_JOURNAL_KEYS);
  if (batch && batch.version === 1 && batch.mode === 'batch' && CAPABILITY.test(batch.capabilityId ?? '') &&
    AUDIT_ID.test(batch.auditId ?? '') && Number.isSafeInteger(batch.windowId) && batch.windowId >= 0 &&
    Number.isSafeInteger(batch.createdAt) && batch.createdAt >= 0 &&
    Number.isSafeInteger(batch.updatedAt) && batch.updatedAt >= batch.createdAt &&
    (batch.state === 'prepared' ? batch.sessionCapabilityId === null
      : batch.state === 'claimed' && CAPABILITY.test(batch.sessionCapabilityId ?? ''))) return freeze(batch);
  const record = exact(value, JOURNAL_KEYS);
  if (record && record.version === 1 && CAPABILITY.test(record.capabilityId ?? '') &&
    AUDIT_ID.test(record.auditId ?? '') && Number.isSafeInteger(record.windowId) && record.windowId >= 0 &&
    Number.isSafeInteger(record.createdAt) && record.createdAt >= 0 &&
    Number.isSafeInteger(record.updatedAt) && record.updatedAt >= record.createdAt &&
    (record.state === 'prepared' ? record.sessionCapabilityId === null
      : record.state === 'claimed' && CAPABILITY.test(record.sessionCapabilityId ?? ''))) return freeze(record);
  const attachedCopy = exact(value, ATTACHED_COPY_JOURNAL_KEYS);
  if (!attachedCopy || attachedCopy.version !== 1 || !CAPABILITY.test(attachedCopy.capabilityId ?? '') ||
    attachedCopy.mode !== 'single' || attachedCopy.navigationPurpose !== 'attached-copy' ||
    !/^owner_[A-Za-z0-9_-]{22}$/u.test(attachedCopy.ownershipId ?? '') ||
    !AUDIT_ID.test(attachedCopy.auditId ?? '') || !Number.isSafeInteger(attachedCopy.windowId) || attachedCopy.windowId < 0 ||
    !Number.isSafeInteger(attachedCopy.createdAt) || attachedCopy.createdAt < 0 ||
    !Number.isSafeInteger(attachedCopy.updatedAt) || attachedCopy.updatedAt < attachedCopy.createdAt ||
    (['copy-preparing', 'prepared'].includes(attachedCopy.state)
      ? attachedCopy.sessionCapabilityId !== null
      : attachedCopy.state !== 'claimed' || !CAPABILITY.test(attachedCopy.sessionCapabilityId ?? ''))) return null;
  return freeze(attachedCopy);
}

function batchJournal(value) {
  const record = journalRecord(value);
  return record?.mode === 'batch' ? record : null;
}

function attachedCopyJournal(value) {
  const record = journalRecord(value);
  return record && Object.hasOwn(record, 'navigationPurpose') && record.navigationPurpose === 'attached-copy'
    ? record
    : null;
}

function sameAttachedCopyJournalIdentity(record, expected) {
  return record?.capabilityId === expected.capabilityId && record.auditId === expected.auditId &&
    record.windowId === expected.windowId && record.mode === 'single' &&
    record.navigationPurpose === 'attached-copy' && record.ownershipId === expected.ownershipId;
}

/*
 * Reserva durável criada pelo worker antes do snapshot/exchange/vault. O
 * registro contém somente correlação técnica; URL, token e digest nunca
 * atravessam esta fronteira.
 */
export async function reserveAttachedCopyStartJournalV1(raw) {
  const input = exact(raw, [
    'sessionArea', 'capabilityId', 'auditId', 'windowId', 'ownershipId', 'createdAt',
  ]);
  if (!input || typeof input.sessionArea?.get !== 'function' || typeof input.sessionArea?.set !== 'function' ||
    !CAPABILITY.test(input.capabilityId ?? '') || !AUDIT_ID.test(input.auditId ?? '') ||
    !Number.isSafeInteger(input.windowId) || input.windowId < 0 ||
    !/^owner_[A-Za-z0-9_-]{22}$/u.test(input.ownershipId ?? '') ||
    !Number.isSafeInteger(input.createdAt) || input.createdAt < 0) {
    throw new Error('START_JOURNAL_DENIED');
  }
  const existing = await readConfirmed(input.sessionArea, START_JOURNAL_KEY, journalRecord, 'START_JOURNAL_DENIED');
  if (existing !== null) throw new Error('START_JOURNAL_DENIED');
  const journal = freeze({
    version: 1,
    capabilityId: input.capabilityId,
    auditId: input.auditId,
    windowId: input.windowId,
    mode: 'single',
    navigationPurpose: 'attached-copy',
    ownershipId: input.ownershipId,
    state: 'copy-preparing',
    sessionCapabilityId: null,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  });
  return writeConfirmed(input.sessionArea, START_JOURNAL_KEY, journal, journalRecord, 'START_JOURNAL_DENIED');
}

async function readConfirmed(sessionArea, key, parser, denial) {
  try {
    const first = parseStorageGetEnvelope(await sessionArea.get(key), key);
    const second = parseStorageGetEnvelope(await sessionArea.get(key), key);
    if (!first || !second || first.state !== second.state) throw new Error();
    if (first.state === 'absent') return null;
    const firstParsed = parser(first.value);
    const secondParsed = parser(second.value);
    if (!firstParsed || !secondParsed || !same(firstParsed, secondParsed)) throw new Error();
    return firstParsed;
  } catch { throw new Error(denial); }
}

async function writeConfirmed(sessionArea, key, value, parser, denial) {
  try {
    await sessionArea.set({ [key]: value });
    const stored = await readConfirmed(sessionArea, key, parser, denial);
    if (!stored || !same(stored, value)) throw new Error();
    return stored;
  } catch { throw new Error(denial); }
}

async function removeCorrelated(sessionArea, key, parser, predicate = () => true) {
  const current = await readConfirmed(sessionArea, key, parser, 'CORRELATED_CLEANUP_DENIED');
  if (current === null) return true;
  if (!predicate(current)) return false;
  try { await sessionArea.remove(key); } catch { /* readback below is authoritative */ }
  return (await readConfirmed(sessionArea, key, parser, 'CORRELATED_CLEANUP_DENIED')) === null;
}

export async function readActiveAuditJobForWorker(raw = {}) {
  const input = exact(raw, ['sessionArea']);
  const sessionArea = input?.sessionArea;
  if (!sessionArea || typeof sessionArea.get !== 'function') throw new Error('ACTIVE_AUDIT_JOB_DENIED');
  return readConfirmed(sessionArea, ACTIVE_AUDIT_JOB_KEY, activeRecord, 'ACTIVE_AUDIT_JOB_DENIED');
}

function checkpointPageOrder(checkpoint) {
  const root = exact(checkpoint, ['version', 'auditId', 'pages']);
  if (!root || !Array.isArray(root.pages) || Object.getPrototypeOf(root.pages) !== Array.prototype) throw new Error('CHECKPOINT_PERSIST_DENIED');
  const length = Object.getOwnPropertyDescriptor(root.pages, 'length')?.value;
  if (!Number.isSafeInteger(length) || length < 1 || length > 20) throw new Error('CHECKPOINT_PERSIST_DENIED');
  const keys = Reflect.ownKeys(root.pages);
  const expected = ['length', ...Array.from({ length }, (_entry, index) => String(index))];
  if (keys.length !== expected.length || expected.some(key => !keys.includes(key))) throw new Error('CHECKPOINT_PERSIST_DENIED');
  return Array.from({ length }, (_entry, index) => {
    const row = Object.getOwnPropertyDescriptor(root.pages, String(index));
    const pageId = row?.enumerable && Object.hasOwn(row, 'value') && row.value && typeof row.value === 'object'
      ? Object.getOwnPropertyDescriptor(row.value, 'pageId') : null;
    if (!pageId?.enumerable || !Object.hasOwn(pageId, 'value') || typeof pageId.value !== 'string') throw new Error('CHECKPOINT_PERSIST_DENIED');
    return pageId.value;
  });
}

function canonicalIntermediateCheckpoint(auditId, checkpoint) {
  return validateExecutionCheckpoint({ auditId, checkpoint, pageOrder: checkpointPageOrder(checkpoint) });
}

function retentionIntent(value) {
  const record = exact(value, ['version', 'deleteAfterCompleteExport']);
  return record?.version === 1 && record.deleteAfterCompleteExport === false ? freeze(record) : null;
}

function urlRequestedEvidenceRecord(value, active) {
  const record = exact(value, [
    'version', 'auditId', 'capabilityId', 'sessionCapabilityId', 'windowId', 'evidenceUrl',
  ]);
  const evidenceUrl = record && exact(record.evidenceUrl, [
    'version', 'href', 'queryIncluded', 'redactedSegments',
  ]);
  if (!record || record.version !== 1 || record.auditId !== active.auditId ||
    record.capabilityId !== active.capabilityId || record.sessionCapabilityId !== active.sessionCapabilityId ||
    record.windowId !== active.windowId || !evidenceUrl || !isEvidenceUrlV1(evidenceUrl) ||
    evidenceUrl.queryIncluded !== false) return null;
  return freeze({ ...record, evidenceUrl: { ...evidenceUrl } });
}

function exactCapturePolicy(value) {
  const record = exact(value, [
    'version', 'mode', 'includeQuery', 'captureFullPage', 'captureElements', 'composeAnnouncementMap',
  ]);
  return record && Object.isFrozen(value) && isCapturePolicyV1(record) && record.version === 'CapturePolicyV1' &&
    ['full-evidence', 'element-only', 'no-pixels'].includes(record.mode) && record.includeQuery === false
    ? freeze(record) : null;
}

function latestState(auditId, kind, modelNow, status = null) {
  const row = {
    running: ['running', 0, 'Preparando a auditoria.', null, null],
    complete: ['complete', 100, 'Avaliação concluída.', null, 1],
    partial: ['partial', 100, 'Avaliação concluída com limitações.', null, 1],
    failed: ['failed', 100, 'Avaliação concluída com falha estrutural.', null, 1],
    cancelled: ['cancelled', 100, 'Avaliação cancelada.', null, 1],
    AUDIT_INTERRUPTED: ['failed', 100, 'A auditoria foi interrompida antes da conclusão.', 'AUDIT_INTERRUPTED', null],
    AUDIT_FAILED: ['failed', 100, 'Não foi possível concluir a auditoria.', 'AUDIT_FAILED', null],
    TARGET_CHANGED: ['failed', 100, 'A página mudou durante a auditoria; tente novamente.', 'TARGET_CHANGED', null],
    PRIVACY_PAUSED: ['paused', 0, 'A auditoria foi pausada por proteção de privacidade.', 'PRIVACY_PAUSED', null],
    AUDIT_REVOKED: ['failed', 100, 'A auditoria foi interrompida antes da conclusão.', 'AUDIT_INTERRUPTED', null],
  }[kind ?? status];
  if (!row) throw new TypeError('LATEST_STATE_DENIED');
  return freeze({
    version: 1, auditId, status: row[0], percent: row[1], message: row[2],
    failureCode: row[3], modelRevision: row[4], updatedAt: canonicalModelTime(modelNow),
  });
}

function parseLatest(value) {
  const record = exact(value, LATEST_KEYS);
  if (!record || record.version !== 1 || !AUDIT_ID.test(record.auditId ?? '') || typeof record.updatedAt !== 'string') return null;
  const date = new Date(record.updatedAt);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== record.updatedAt) return null;
  const key = record.failureCode ?? record.status;
  const expected = {
    running: ['running', 0, 'Preparando a auditoria.', null, null],
    complete: ['complete', 100, 'Avaliação concluída.', null, 1],
    partial: ['partial', 100, 'Avaliação concluída com limitações.', null, 1],
    failed: ['failed', 100, 'Avaliação concluída com falha estrutural.', null, 1],
    cancelled: ['cancelled', 100, 'Avaliação cancelada.', null, 1],
    AUDIT_INTERRUPTED: ['failed', 100, 'A auditoria foi interrompida antes da conclusão.', 'AUDIT_INTERRUPTED', null],
    AUDIT_FAILED: ['failed', 100, 'Não foi possível concluir a auditoria.', 'AUDIT_FAILED', null],
    TARGET_CHANGED: ['failed', 100, 'A página mudou durante a auditoria; tente novamente.', 'TARGET_CHANGED', null],
    PRIVACY_PAUSED: ['paused', 0, 'A auditoria foi pausada por proteção de privacidade.', 'PRIVACY_PAUSED', null],
  }[key];
  return expected && same(
    [record.status, record.percent, record.message, record.failureCode, record.modelRevision], expected,
  ) ? freeze(record) : null;
}

function supportedLatestAuditId(value) {
  const current = parseLatest(value);
  if (current) return current.auditId;
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
    const allowed = new Set([
      'auditId', 'mode', 'status', 'percent', 'message', 'reviewUrl', 'exportStatus', 'exportRevision',
      'exportAttempt', 'leaseOwnerId', 'total', 'pageNumber', 'statusCounts', 'exportQueuedAt',
    ]);
    const keys = Reflect.ownKeys(value);
    if (keys.length < 2 || keys.some(key => typeof key !== 'string' || !allowed.has(key))) return null;
    const copy = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      copy[key] = descriptor.value;
    }
    if (!AUDIT_ID.test(copy.auditId ?? '') ||
      (!Object.hasOwn(copy, 'status') && !Object.hasOwn(copy, 'exportStatus'))) return null;
    if (Object.hasOwn(copy, 'mode') && !['single', 'batch'].includes(copy.mode)) return null;
    if (Object.hasOwn(copy, 'status') && ![
      'idle', 'validating', 'queued', 'running', 'cancelling', 'complete', 'partial', 'failed', 'cancelled', 'paused',
    ].includes(copy.status)) return null;
    if (Object.hasOwn(copy, 'exportStatus') && ![
      'unavailable', 'preparing', 'queued', 'running', 'delivering', 'complete', 'partial', 'failed', 'busy',
    ].includes(copy.exportStatus)) return null;
    if (Object.hasOwn(copy, 'percent') && (typeof copy.percent !== 'number' || !Number.isFinite(copy.percent) ||
      copy.percent < 0 || copy.percent > 100)) return null;
    if (Object.hasOwn(copy, 'message') && (typeof copy.message !== 'string' || [...copy.message].length > 512)) return null;
    if (Object.hasOwn(copy, 'reviewUrl')) {
      if (typeof copy.reviewUrl !== 'string') return null;
      const review = new URL(copy.reviewUrl);
      if (review.protocol !== 'chrome-extension:' || review.pathname !== '/src/review/index.html' || review.hash ||
        [...review.searchParams.keys()].length !== 1 || review.searchParams.get('auditId') !== copy.auditId) return null;
    }
    if (Object.hasOwn(copy, 'exportRevision') && (!Number.isSafeInteger(copy.exportRevision) || copy.exportRevision < 0)) return null;
    if (Object.hasOwn(copy, 'exportAttempt') && (!Number.isSafeInteger(copy.exportAttempt) || copy.exportAttempt < 1)) return null;
    if (Object.hasOwn(copy, 'leaseOwnerId') && !/^[A-Za-z0-9._:-]{1,200}$/u.test(copy.leaseOwnerId ?? '')) return null;
    if (Object.hasOwn(copy, 'exportQueuedAt') && typeof copy.exportQueuedAt !== 'string') return null;
    if (Object.hasOwn(copy, 'total') && (!Number.isSafeInteger(copy.total) || copy.total < 1 || copy.total > 20)) return null;
    if (Object.hasOwn(copy, 'pageNumber') && (!Number.isSafeInteger(copy.pageNumber) || copy.pageNumber < 0 ||
      !Number.isSafeInteger(copy.total) || copy.pageNumber > copy.total)) return null;
    if (Object.hasOwn(copy, 'statusCounts')) {
      const counts = exact(copy.statusCounts, ['cancelled', 'complete', 'failed', 'partial']);
      if (!counts || !Number.isSafeInteger(copy.total) || Object.values(counts).some(count =>
        !Number.isSafeInteger(count) || count < 0 || count > 20) ||
        Object.values(counts).reduce((sum, count) => sum + count, 0) > copy.total) return null;
    }
    return copy.auditId;
  } catch { return null; }
}

async function terminalCandidate({ auditId, model, checkpoint }) {
  const verified = await verifyAuditIntegritySnapshot(model);
  if (verified.auditId !== auditId || !['complete', 'partial', 'failed', 'cancelled'].includes(verified.session.status) ||
    !/^[a-f0-9]{64}$/u.test(verified.integrity.canonicalModelHash)) throw new TypeError('REPORT_REVISION_CANDIDATE_DENIED');
  const canonicalCheckpoint = validateExecutionCheckpoint({
    auditId, checkpoint, pageOrder: verified.pages.map(page => page.pageId),
  });
  return freeze({
    version: 1, auditId, modelRevision: 1, modelHash: verified.integrity.canonicalModelHash,
    model: verified, checkpoint: canonicalCheckpoint,
  });
}

function completionRevoked(auditId, code) {
  return freeze({ ok: true, auditId, state: 'revoked', code });
}

function inspectedTarget(value) {
  const result = exact(value, ['ok', 'target']);
  const target = result?.ok === true
    ? exact(result.target, ['tabId', 'windowId', 'documentId', 'urlSessionDigest'])
    : null;
  return target && Number.isSafeInteger(target.tabId) && target.tabId > 0 &&
    Number.isSafeInteger(target.windowId) && target.windowId >= 0 &&
    typeof target.documentId === 'string' && target.documentId.length >= 1 && target.documentId.length <= 512 &&
    !/[\u0000-\u001F\u007F]/u.test(target.documentId) && DIGEST.test(target.urlSessionDigest ?? '')
    ? freeze(target)
    : null;
}

function sensitiveSignals(value) {
  const record = exact(value, ['version', 'detected', 'categories']);
  if (!record || record.version !== 'SensitiveCaptureSignalsV1' || typeof record.detected !== 'boolean' ||
    !Array.isArray(record.categories) || Object.getPrototypeOf(record.categories) !== Array.prototype) return null;
  const categories = [...record.categories];
  const allowed = ['password', 'otp', 'payment', 'private-marker'];
  if (categories.some(category => !allowed.includes(category)) || new Set(categories).size !== categories.length ||
    record.detected !== (categories.length > 0)) return null;
  return freeze({ version: record.version, detected: record.detected, categories: freeze(categories) });
}

function canonicalSensitiveCategories(value) {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
    const length = Object.getOwnPropertyDescriptor(value, 'length');
    if (!length || !Object.hasOwn(length, 'value') || !Number.isSafeInteger(length.value) ||
      length.value < 1 || length.value > 4) return null;
    const expected = ['length', ...Array.from({ length: length.value }, (_entry, index) => String(index))];
    const own = Reflect.ownKeys(value);
    if (own.length !== expected.length || expected.some(key => !own.includes(key))) return null;
    const order = ['password', 'otp', 'payment', 'private-marker'];
    const categories = [];
    for (let index = 0; index < length.value; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value') ||
        !order.includes(descriptor.value) ||
        (index > 0 && order.indexOf(descriptor.value) <= order.indexOf(categories[index - 1]))) return null;
      categories.push(descriptor.value);
    }
    return freeze(categories);
  } catch { return null; }
}

function correlatedPixelContext(active, recoveryGrant) {
  if (active.mode === 'attached') {
    const grant = exact(recoveryGrant, [
      'version', 'capabilityId', 'auditId', 'sessionCapabilityId', 'windowId', 'issuedAt', 'expiresAt',
      'targetState', 'sessionState', 'target',
    ]);
    const target = grant && exact(grant.target, [
      'kind', 'tabId', 'windowId', 'documentId', 'initialUrlEvidence', 'initialUrlSessionDigest',
    ]);
    if (!grant || grant.version !== 1 || !target || target.kind !== 'attached' ||
      grant.auditId !== active.auditId || grant.capabilityId !== active.capabilityId ||
      grant.sessionCapabilityId !== active.sessionCapabilityId || grant.windowId !== active.windowId ||
      target.windowId !== active.windowId || !['claimed', 'invalidated'].includes(grant.targetState) ||
      !['running', 'privacy-paused', 'result', 'revoked'].includes(grant.sessionState) ||
      !Number.isSafeInteger(grant.issuedAt) || grant.issuedAt < 0 ||
      !Number.isSafeInteger(grant.expiresAt) || grant.expiresAt <= grant.issuedAt) return null;
    return freeze({ kind: 'attached', grant, target, ownershipId: null,
      sessionState: grant.sessionState, targetState: grant.targetState });
  }
  if (active.mode === 'batch') {
    const grant = exact(recoveryGrant, [
      'version', 'capabilityId', 'auditId', 'sessionCapabilityId', 'windowId', 'capabilityState',
      'sessionState', 'activePageId', 'activeOwnershipId', 'issuedAt', 'expiresAt',
    ]);
    const activePair = AUDIT_ID.test(grant?.activePageId ?? '') &&
      /^owner_[A-Za-z0-9_-]{22}$/u.test(grant?.activeOwnershipId ?? '');
    const clearedRevokedPair = grant?.sessionState === 'revoked' &&
      grant.activePageId === null && grant.activeOwnershipId === null;
    if (!grant || grant.version !== 1 || grant.auditId !== active.auditId ||
      grant.capabilityId !== active.capabilityId || grant.sessionCapabilityId !== active.sessionCapabilityId ||
      grant.windowId !== active.windowId || !['claimed', 'invalidated'].includes(grant.capabilityState) ||
      !['running', 'privacy-paused', 'result', 'revoked'].includes(grant.sessionState) ||
      (!activePair && !clearedRevokedPair) ||
      !Number.isSafeInteger(grant.issuedAt) || grant.issuedAt < 0 ||
      !Number.isSafeInteger(grant.expiresAt) || grant.expiresAt <= grant.issuedAt) return null;
    return freeze({
      kind: 'batch', grant, target: null, ownershipId: grant.activeOwnershipId,
      pageId: grant.activePageId, sessionState: grant.sessionState, targetState: grant.capabilityState,
    });
  }
  const grant = exact(recoveryGrant, [
    'version', 'capabilityId', 'auditId', 'sessionCapabilityId', 'windowId', 'capabilityState',
    'sessionState', 'navigationPurpose', 'ownershipId', 'ownershipState', 'issuedAt', 'expiresAt',
  ]);
  if (!grant || grant.version !== 1 || grant.auditId !== active.auditId ||
    grant.capabilityId !== active.capabilityId || grant.sessionCapabilityId !== active.sessionCapabilityId ||
    grant.windowId !== active.windowId || !['claimed', 'invalidated'].includes(grant.capabilityState) ||
    !['single-url', 'attached-copy'].includes(grant.navigationPurpose) ||
    !/^owner_[A-Za-z0-9_-]{22}$/u.test(grant.ownershipId ?? '') ||
    !['pending', 'observing', 'retained-for-consent', 'retained-for-review', 'cleanup-pending', 'removed']
      .includes(grant.ownershipState) ||
    !['running', 'privacy-paused', 'result', 'revoked'].includes(grant.sessionState) ||
    !Number.isSafeInteger(grant.issuedAt) || grant.issuedAt < 0 ||
    !Number.isSafeInteger(grant.expiresAt) || grant.expiresAt <= grant.issuedAt) return null;
  return freeze({ kind: 'single', grant, target: null, ownershipId: grant.ownershipId,
    sessionState: grant.sessionState, targetState: grant.ownershipState });
}

function correlatedPixelSuspension(value, active, context) {
  const record = exact(value, [
    'version', 'revision', 'auditId', 'consentId', 'tabId', 'windowId', 'documentId', 'urlEvidence',
    'urlSessionDigest', 'mode', 'capturePolicy', 'categories', 'issuedAt', 'updatedAt', 'expiresAt',
    'cleanupAttempts', 'cleanupNotBefore', 'state', 'resumePhase', 'revokeReason', 'source',
  ]);
  const attachedSource = record && exact(record.source, ['kind']);
  const ownedSource = record && exact(record.source, ['kind', 'ownershipId', 'cleanupMode', 'pageId']);
  const source = attachedSource?.kind === 'attached' ? attachedSource
    : ownedSource?.kind === 'owned-disposable' ? ownedSource : null;
  const policy = record && exactCapturePolicy(record.capturePolicy);
  const evidence = record && exact(record.urlEvidence, ['version', 'href', 'queryIncluded', 'redactedSegments']);
  const categories = record && canonicalSensitiveCategories(record.categories);
  const target = context?.target;
  const attachedTargetMatches = context?.kind === 'attached' && source?.kind === 'attached' && target &&
    record.tabId === target.tabId && record.documentId === target.documentId &&
    record.urlSessionDigest === target.initialUrlSessionDigest && record.urlEvidence?.href === target.initialUrlEvidence;
  const expectedOwnedCleanupMode = context?.grant?.navigationPurpose === 'attached-copy'
    ? 'always' : 'pre-observation-failure';
  const ownedTargetMatches = context?.kind === 'single' && source?.kind === 'owned-disposable' &&
    source.ownershipId === context.ownershipId && source.cleanupMode === expectedOwnedCleanupMode &&
    source.pageId === 'page-1' && Number.isSafeInteger(record.tabId) && record.tabId >= 0 &&
    typeof record.documentId === 'string' && record.documentId.length >= 1 && record.documentId.length <= 512 &&
    DIGEST.test(record.urlSessionDigest ?? '');
  const batchTargetMatches = context?.kind === 'batch' && source?.kind === 'owned-disposable' &&
    source.cleanupMode === 'always' &&
    (source.ownershipId === context.ownershipId && source.pageId === context.pageId ||
      context.sessionState === 'revoked' && context.ownershipId === null && context.pageId === null &&
      record.state === 'revoked' && canonicalPixelSource(source) !== null) &&
    Number.isSafeInteger(record.tabId) && record.tabId >= 0 &&
    typeof record.documentId === 'string' && record.documentId.length >= 1 && record.documentId.length <= 512 &&
    DIGEST.test(record.urlSessionDigest ?? '');
  if (!record || record.version !== 'AuditSuspensionV1' || record.auditId !== active.auditId ||
    !/^[A-Za-z0-9_-]{21}[AQgw]$/u.test(record.consentId ?? '') ||
    record.windowId !== active.windowId || (!attachedTargetMatches && !ownedTargetMatches && !batchTargetMatches) ||
    !policy || policy.mode !== record.mode ||
    !['full-evidence', 'element-only'].includes(record.mode) || !evidence || !isEvidenceUrlV1(evidence) ||
    evidence.queryIncluded !== false || !categories ||
    !Number.isSafeInteger(record.revision) || record.revision < 1 ||
    !Number.isSafeInteger(record.issuedAt) || !Number.isSafeInteger(record.updatedAt) ||
    !Number.isSafeInteger(record.expiresAt) || record.issuedAt < 0 || record.updatedAt < record.issuedAt ||
    record.expiresAt <= record.issuedAt || !Number.isSafeInteger(record.cleanupAttempts) ||
    record.cleanupAttempts < 0 || record.cleanupAttempts > 31 ||
    !['paused', 'resuming', 'revoked', 'finished'].includes(record.state)) return null;
  const liveState = ['paused', 'resuming'].includes(record.state);
  if (record.state === 'paused' && record.resumePhase !== null ||
    record.state === 'resuming' && !['consent-claimed', 'session-running', 'runner-started'].includes(record.resumePhase) ||
    !liveState && record.resumePhase !== null || record.state === 'revoked' && !PIXEL_LIQUIDATION_REASONS.has(record.revokeReason) ||
    record.state !== 'revoked' && record.revokeReason !== null ||
    liveState && (record.cleanupAttempts !== 0 || record.cleanupNotBefore !== null) ||
    !liveState && (!Number.isSafeInteger(record.cleanupNotBefore) || record.cleanupNotBefore < record.updatedAt)) return null;
  return freeze({
    ...record, capturePolicy: policy, urlEvidence: evidence, categories, source,
  });
}

function canonicalPixelSource(value) {
  const attached = exact(value, ['kind']);
  if (attached?.kind === 'attached') return freeze(attached);
  const owned = exact(value, ['kind', 'ownershipId', 'cleanupMode', 'pageId']);
  return owned?.kind === 'owned-disposable' && /^owner_[A-Za-z0-9_-]{22}$/u.test(owned.ownershipId ?? '') &&
    ['always', 'pre-observation-failure'].includes(owned.cleanupMode) &&
    /^page-([1-9]|1[0-9]|20)$/u.test(owned.pageId ?? '')
    ? freeze(owned) : null;
}

function pixelAttemptRequest(auditId, consentId, source, additional = null) {
  const base = source?.kind === 'owned-disposable'
    ? { auditId, consentId, pageId: source.pageId, ownershipId: source.ownershipId }
    : { auditId, consentId };
  return additional === null ? freeze(base) : freeze({ ...base, ...additional });
}

export function createAuthorizedAuditStarter(input) {
  const dependencies = exact(input, BATCH_RESUME_FACTORY_KEYS) ?? exact(input, BATCH_FACTORY_KEYS) ??
    exact(input, URL_FACTORY_KEYS) ?? exact(input, FACTORY_KEYS);
  const hasUrlAudit = Boolean(dependencies && Object.hasOwn(dependencies, 'runUrlAuditExecution'));
  const hasBatchAudit = Boolean(dependencies && Object.hasOwn(dependencies, 'runBatchAuditExecution'));
  const hasBatchResume = Boolean(dependencies && Object.hasOwn(dependencies, 'resumeBatchAuditExecution'));
  const coordinator = exact(dependencies?.panelCoordinator, ['attachPanelPort', 'withWindowLock']);
  if (!dependencies || !dependencies.authority || !dependencies.sessionArea || !dependencies.panelCoordinator ||
    FACTORY_KEYS.filter(key => ![
      'authority', 'sessionArea', 'panelCoordinator', 'targetQueue', 'cleanupBarrier', 'pixelState',
      'pixelAttemptLifecycle', 'pixelCommitClock',
    ].includes(key))
      .some(key => typeof dependencies[key] !== 'function') ||
    typeof dependencies.sessionArea.get !== 'function' || typeof dependencies.sessionArea.set !== 'function' ||
    typeof dependencies.sessionArea.remove !== 'function' ||
    typeof dependencies.authority.claimAndIssueAuditSession !== 'function' ||
    typeof dependencies.authority.claimWorkerEventAndIssueAuditSession !== 'function' ||
    typeof dependencies.authority.inspectPreparedAuditTarget !== 'function' ||
    typeof dependencies.authority.transitionAuditSession !== 'function' ||
    typeof dependencies.authority.invalidateCapability !== 'function' || !coordinator ||
    typeof coordinator.attachPanelPort !== 'function' ||
    typeof coordinator.withWindowLock !== 'function' ||
    typeof dependencies.targetQueue?.withTarget !== 'function' ||
    typeof dependencies.targetQueue?.assertHeld !== 'function' ||
    typeof dependencies.cleanupBarrier?.clearForAuditLocked !== 'function' ||
    !isPixelCommitClockV1(dependencies.pixelCommitClock) ||
    !dependencies.pixelState ||
    ['pause', 'gateRunnerStart', 'readSuspension', 'claimAndBeginResume', 'markSessionRunning', 'finish', 'revokeAudit']
      .some(key => typeof dependencies.pixelState[key] !== 'function') ||
    !dependencies.pixelAttemptLifecycle ||
    ['prepareResume', 'commitTerminal', 'classify', 'cleanup']
      .some(key => typeof dependencies.pixelAttemptLifecycle[key] !== 'function') ||
    typeof dependencies.probeDocumentIdentity !== 'function' ||
    typeof dependencies.probeSensitiveCaptureSignals !== 'function' ||
    typeof dependencies.schedulePixelExpiry !== 'function') {
    throw new TypeError('AUTHORIZED_AUDIT_STARTER_INVALID');
  }
  if (hasUrlAudit && (typeof dependencies.runUrlAuditExecution !== 'function' ||
    typeof dependencies.clearUrlAuditResources !== 'function' ||
    typeof dependencies.authority.claimNavigationAndIssueAuditSession !== 'function' ||
    typeof dependencies.authority.claimExchangedAttachedCopyAndIssueAuditSession !== 'function' ||
    typeof dependencies.authority.transitionDisposableAuditSession !== 'function')) {
    throw new TypeError('AUTHORIZED_AUDIT_STARTER_INVALID');
  }
  if (hasBatchAudit && (typeof dependencies.runBatchAuditExecution !== 'function' ||
    typeof dependencies.clearBatchAuditResources !== 'function' ||
    typeof dependencies.clearBatchAuditProgress !== 'function' ||
    typeof dependencies.discardBatchAuditProgress !== 'function' ||
    typeof dependencies.authority.transitionBatchAuditSession !== 'function')) {
    throw new TypeError('AUTHORIZED_AUDIT_STARTER_INVALID');
  }
  if (hasBatchResume && (typeof dependencies.resumeBatchAuditExecution !== 'function' ||
    typeof dependencies.recoverBatchAuditExecution !== 'function')) {
    throw new TypeError('AUTHORIZED_AUDIT_STARTER_INVALID');
  }

  const {
    authority, sessionArea, panelCoordinator, targetQueue, cleanupBarrier, runAttachedAuditExecution,
    persistLatest, persistCheckpoint, removeCheckpoint, commitTerminalAudit,
    readAuditSnapshot, readReportRevision, readLatest, buildPanelResultBundle, recordHighlightBinding,
    pixelCommitClock, epochNow, modelNow, createAbortController, pixelState,
    probeDocumentIdentity, probeSensitiveCaptureSignals,
    pixelAttemptLifecycle, schedulePixelExpiry, prepareAttachedCopyPlan, recordPageMarkerOrigin,
  } = dependencies;
  const runUrlAuditExecution = hasUrlAudit ? dependencies.runUrlAuditExecution : null;
  const clearUrlAuditResources = hasUrlAudit ? dependencies.clearUrlAuditResources : null;
  const runBatchAuditExecution = hasBatchAudit ? dependencies.runBatchAuditExecution : null;
  const clearBatchAuditResources = hasBatchAudit ? dependencies.clearBatchAuditResources : null;
  const clearBatchAuditProgress = hasBatchAudit ? dependencies.clearBatchAuditProgress : null;
  const discardBatchAuditProgress = hasBatchAudit ? dependencies.discardBatchAuditProgress : null;
  const resumeBatchAuditExecution = hasBatchResume ? dependencies.resumeBatchAuditExecution : null;
  const recoverBatchAuditExecution = hasBatchResume ? dependencies.recoverBatchAuditExecution : null;
  let globalTail = Promise.resolve();
  const live = new Map();
  const lockedAttachedCopyStarts = new WeakSet();
  const withGlobalLock = operation => {
    const pending = globalTail.then(operation, operation);
    globalTail = pending.catch(() => {});
    return pending;
  };

  async function currentSingletons() {
    const active = await readActiveAuditJobForWorker({ sessionArea });
    const journal = await readConfirmed(sessionArea, START_JOURNAL_KEY, journalRecord, 'START_JOURNAL_DENIED');
    return { active, journal };
  }

  async function persistExactLatest(state) {
    let returned = null;
    try { returned = parseLatest(await persistLatest({ state })); } catch { /* confirm below */ }
    if (returned && same(returned, state)) return returned;
    const confirmed = parseLatest(await readLatest());
    if (!confirmed || !same(confirmed, state)) throw new Error('LATEST_STATE_DENIED');
    return confirmed;
  }

  async function schedulePixelExpiryBestEffort() {
    try { await schedulePixelExpiry(); } catch { /* the durable pixel journal remains recoverable */ }
  }

  async function readPersistedCheckpoint(active) {
    const parser = value => {
      const record = exact(value, ['version', 'auditId', 'sessionCapabilityId', 'windowId', 'checkpoint']);
      if (!record || record.version !== 1 || record.auditId !== active.auditId ||
        record.sessionCapabilityId !== active.sessionCapabilityId || record.windowId !== active.windowId) return null;
      let checkpoint;
      try { checkpoint = canonicalIntermediateCheckpoint(active.auditId, record.checkpoint); }
      catch { return null; }
      return freeze({ ...record, checkpoint });
    };
    return readConfirmed(
      sessionArea, executionCheckpointStorageKey(active.auditId), parser, 'CHECKPOINT_PERSIST_DENIED',
    );
  }

  async function readUrlRequestedEvidence(active) {
    return readConfirmed(
      sessionArea, urlRequestedEvidenceStorageKey(active.auditId),
      value => urlRequestedEvidenceRecord(value, active), 'URL_REQUESTED_EVIDENCE_DENIED',
    );
  }

  async function readCorrelatedPixelSuspension(active) {
    const [recoveryGrant, rawSuspension] = await Promise.all([
      active.mode === 'attached'
        ? readAttachedAuditRecoveryGrant({
            sessionArea, capabilityId: active.capabilityId, auditId: active.auditId,
          })
        : active.mode === 'batch'
          ? readBatchAuditCorrelationForRecovery({
              sessionArea, capabilityId: active.capabilityId, auditId: active.auditId,
            })
          : readNavigationAuditCorrelationForRecovery({
              sessionArea, capabilityId: active.capabilityId, auditId: active.auditId,
            }),
      pixelState.readSuspension(active.auditId),
    ]);
    const context = correlatedPixelContext(active, recoveryGrant);
    if (!context) throw new Error('PIXEL_CORRELATION_DENIED');
    if (rawSuspension === null) return freeze({
      suspension: null, grant: context.grant,
      sessionState: context.sessionState, targetState: context.targetState,
    });
    const suspension = correlatedPixelSuspension(rawSuspension, active, context);
    if (!suspension) throw new Error('PIXEL_CORRELATION_DENIED');
    return freeze({
      suspension, grant: context.grant,
      sessionState: context.sessionState, targetState: context.targetState,
    });
  }

  async function transitionConfirmed(active, nextState) {
    const transitioned = await authority.transitionAuditSession({
      sessionCapabilityId: active.sessionCapabilityId, auditId: active.auditId, nextState,
    });
    if (transitioned?.ok !== true && transitioned?.code !== 'SESSION_TRANSITION_DENIED') throw new Error('SESSION_TRANSITION_DENIED');
    const session = await readAuditSessionForWorker({
      sessionArea, sessionCapabilityId: active.sessionCapabilityId, auditId: active.auditId,
    });
    if (session.state !== nextState) throw new Error('SESSION_TRANSITION_DENIED');
    return session;
  }

  async function invalidateConfirmed(active) {
    await authority.invalidateCapability(active.capabilityId, 'AUDIT_TERMINAL');
    if (active.mode === 'single') {
      const correlation = await readNavigationAuditCorrelationForRecovery({
        sessionArea, capabilityId: active.capabilityId, auditId: active.auditId,
      });
      return correlation.capabilityState === 'invalidated';
    }
    if (active.mode === 'batch') {
      const correlation = await readBatchAuditCorrelationForRecovery({
        sessionArea, capabilityId: active.capabilityId, auditId: active.auditId,
      });
      return correlation.capabilityState === 'invalidated';
    }
    const correlation = await readAttachedAuditCorrelationForRecovery({
      sessionArea, capabilityId: active.capabilityId, auditId: active.auditId,
    });
    return correlation.targetState === 'invalidated';
  }

  async function removePreference(active) {
    const key = retentionPreferenceStorageKey(active.auditId);
    const parser = value => {
      const record = exact(value, ['version', 'auditId', 'deleteAfterCompleteExport', 'createdAt', 'expiresAt']);
      return record && record.version === 1 && record.auditId === active.auditId &&
        record.deleteAfterCompleteExport === false ? freeze(record) : null;
    };
    return removeCorrelated(sessionArea, key, parser, record => record.auditId === active.auditId);
  }

  async function cleanupActive(active, { removeRetention = false } = {}) {
    const checkpoint = exact(await removeCheckpoint({
      auditId: active.auditId, sessionCapabilityId: active.sessionCapabilityId, windowId: active.windowId,
    }), ['removed']);
    if (!checkpoint || typeof checkpoint.removed !== 'boolean') throw new Error('CORRELATED_CLEANUP_DENIED');
    const removedJournal = await removeCorrelated(
      sessionArea, START_JOURNAL_KEY, journalRecord,
      current => current.auditId === active.auditId && current.capabilityId === active.capabilityId && current.windowId === active.windowId,
    );
    const retention = removeRetention ? await removePreference(active) : true;
    const requestedEvidenceRemoved = active.mode !== 'single' || await removeCorrelated(
      sessionArea, urlRequestedEvidenceStorageKey(active.auditId),
      value => urlRequestedEvidenceRecord(value, active),
      current => current.auditId === active.auditId && current.capabilityId === active.capabilityId &&
        current.sessionCapabilityId === active.sessionCapabilityId && current.windowId === active.windowId,
    );
    if (!removedJournal || !retention || !requestedEvidenceRemoved) throw new Error('CORRELATED_CLEANUP_DENIED');
    const removedActive = await removeCorrelated(
      sessionArea, ACTIVE_AUDIT_JOB_KEY, activeRecord,
      current => current.auditId === active.auditId && current.capabilityId === active.capabilityId &&
        current.sessionCapabilityId === active.sessionCapabilityId && current.windowId === active.windowId,
    );
    if (!removedActive) throw new Error('CORRELATED_CLEANUP_DENIED');
    live.delete(active.auditId);
  }

  async function discardTerminalBatchProgress(active) {
    if (active.mode === 'batch' && await discardBatchAuditProgress({ auditId: active.auditId }) !== true) {
      throw new Error('BATCH_PROGRESS_DISCARD_DENIED');
    }
  }

  async function finishPixelConsent(liveRecord) {
    if (liveRecord.consentId === null) return true;
    try {
      if (await pixelState.finish({ auditId: liveRecord.active.auditId, consentId: liveRecord.consentId }) === true) {
        await schedulePixelExpiryBestEffort();
        return true;
      }
    } catch { /* readback below confirms commit-then-throw */ }
    try {
      const removed = (await readCorrelatedPixelSuspension(liveRecord.active)).suspension === null;
      if (removed) await schedulePixelExpiryBestEffort();
      return removed;
    }
    catch { return false; }
  }

  async function clearOwnedPixelSource(active, source) {
    if (source.kind === 'attached') return active.mode === 'attached';
    if (source.kind !== 'owned-disposable') return false;
    if (active.mode === 'batch') {
      if (!hasBatchAudit || source.cleanupMode !== 'always' ||
        !/^page-([1-9]|1[0-9]|20)$/u.test(source.pageId ?? '')) return false;
      let correlation = await readBatchAuditCorrelationForRecovery({
        sessionArea, capabilityId: active.capabilityId, auditId: active.auditId,
      });
      if (correlation.sessionCapabilityId !== active.sessionCapabilityId ||
        correlation.windowId !== active.windowId ||
        !(correlation.activePageId === source.pageId && correlation.activeOwnershipId === source.ownershipId ||
          correlation.sessionState === 'revoked' && correlation.activePageId === null &&
          correlation.activeOwnershipId === null)) return false;
      if (await clearBatchAuditResources(freeze({
        auditId: active.auditId,
        capabilityId: active.capabilityId,
        sessionCapabilityId: active.sessionCapabilityId,
        windowId: active.windowId,
      })) !== true) return false;
      correlation = await readBatchAuditCorrelationForRecovery({
        sessionArea, capabilityId: active.capabilityId, auditId: active.auditId,
      });
      return correlation.sessionCapabilityId === active.sessionCapabilityId &&
        correlation.windowId === active.windowId && correlation.activePageId === null &&
        correlation.activeOwnershipId === null;
    }
    if (active.mode !== 'single') return false;
    let correlation = await readNavigationAuditCorrelationForRecovery({
      sessionArea, capabilityId: active.capabilityId, auditId: active.auditId,
    });
    if (correlation.sessionCapabilityId !== active.sessionCapabilityId ||
      correlation.windowId !== active.windowId || correlation.ownershipId !== source.ownershipId ||
      !(correlation.navigationPurpose === 'single-url' && source.cleanupMode === 'pre-observation-failure' ||
        correlation.navigationPurpose === 'attached-copy' && source.cleanupMode === 'always')) return false;
    if (correlation.ownershipState !== 'removed') {
      if (await clearUrlAuditResources(urlCleanupRequest(
        active.auditId, source.ownershipId, correlation.navigationPurpose,
      )) !== true) return false;
      const removed = await authority.transitionDisposableAuditSession({
        sessionCapabilityId: active.sessionCapabilityId,
        auditId: active.auditId,
        ownershipId: source.ownershipId,
        fromState: correlation.ownershipState,
        toState: 'removed',
      });
      if (removed?.ok !== true || removed.state !== 'removed' || removed.ownershipId !== source.ownershipId) return false;
    }
    correlation = await readNavigationAuditCorrelationForRecovery({
      sessionArea, capabilityId: active.capabilityId, auditId: active.auditId,
    });
    return correlation.sessionCapabilityId === active.sessionCapabilityId &&
      correlation.windowId === active.windowId && correlation.ownershipId === source.ownershipId &&
      correlation.ownershipState === 'removed';
  }

  async function liquidatePixelAuditLocked(args, lockedScope = null) {
    if (args.signal?.aborted === true) return false;
    let active;
    try { active = await readActiveAuditJobForWorker({ sessionArea }); }
    catch { return false; }
    if (!active || active.auditId !== args.auditId) return false;
    let suspension;
    try { suspension = (await readCorrelatedPixelSuspension(active)).suspension; }
    catch { return false; }
    if (!suspension || suspension.consentId !== args.consentId || !same(suspension.source, args.source) ||
      suspension.state !== 'revoked' || suspension.revokeReason !== args.reason ||
      args.signal?.aborted === true) return false;
    const classified = await pixelAttemptLifecycle.classify(pixelAttemptRequest(
      args.auditId, args.consentId, args.source,
    ));
    const classification = exact(classified, ['state', 'handle']);
    if (!classification || !['absent', 'prepared', 'terminal', 'blocked'].includes(classification.state) ||
      classification.handle !== null || classification.state === 'blocked') return false;

    if (classification.state === 'terminal') {
      if (active.state !== 'finalizing') return false;
      const journal = await readConfirmed(sessionArea, START_JOURNAL_KEY, journalRecord, 'START_JOURNAL_DENIED');
      try {
        const recovered = await recoverFinalizing(active, journal, lockedScope);
        return recovered?.ok === true && recovered.auditId === active.auditId;
      } catch { return false; }
    }

    try {
      const session = await readAuditSessionForWorker({
        sessionArea, sessionCapabilityId: active.sessionCapabilityId, auditId: active.auditId,
      });
      if (['running', 'privacy-paused'].includes(session.state)) await transitionConfirmed(active, 'revoked');
      else if (session.state !== 'revoked') return false;
      if (!await clearOwnedPixelSource(active, args.source)) return false;
      await discardTerminalBatchProgress(active);
      if (await invalidateConfirmed(active) !== true || args.signal?.aborted === true) return false;
      const disconnect = scope => scope.disconnectSession({
        auditId: active.auditId, sessionCapabilityId: active.sessionCapabilityId,
        windowId: active.windowId, reasonCode: args.reason,
      });
      const disconnected = lockedScope ? await disconnect(lockedScope)
        : await panelCoordinator.withWindowLock(active.windowId, disconnect);
      if (disconnected !== true || args.signal?.aborted === true) return false;
      if (!await pixelAttemptLifecycle.cleanup(pixelAttemptRequest(
        active.auditId, args.consentId, args.source,
        { expected: classification.state === 'prepared' ? 'prepared' : 'post-finish' },
      ))) return false;
      try {
        if (await pixelState.finish({ auditId: active.auditId, consentId: args.consentId }) !== true) return false;
      } catch {
        if ((await readCorrelatedPixelSuspension(active)).suspension !== null) return false;
      }
      await schedulePixelExpiryBestEffort();
      const latestKind = args.reason === 'PIXEL_CONSENT_DOCUMENT_CHANGED'
        ? 'TARGET_CHANGED' : args.reason === 'AUDIT_CANCELLED' ? 'AUDIT_REVOKED' : 'AUDIT_INTERRUPTED';
      await persistExactLatest(latestState(active.auditId, latestKind, modelNow));
      await cleanupActive(active, { removeRetention: true });
      return true;
    } catch { return false; }
  }

  async function liquidatePixelAudit(raw) {
    const args = exact(raw, ['auditId', 'consentId', 'reason', 'source', 'signal']);
    const source = args && canonicalPixelSource(args.source);
    if (!args || !AUDIT_ID.test(args.auditId ?? '') || !/^[A-Za-z0-9_-]{21}[AQgw]$/u.test(args.consentId ?? '') ||
      !PIXEL_LIQUIDATION_REASONS.has(args.reason) || !source ||
      !args.signal || typeof args.signal !== 'object') return false;
    return withGlobalLock(() => liquidatePixelAuditLocked({ ...args, source }));
  }

  async function markFinalizingLocked(liveRecord, candidate, bundle) {
      const current = await readActiveAuditJobForWorker({ sessionArea });
      if (!current || current.auditId !== liveRecord.active.auditId || current.state !== 'running' || liveRecord.externallyInvalidated) {
        throw AUDIT_REVOKED_SENTINEL;
      }
      if (liveRecord.controller.signal.aborted && candidate.model.session.status !== 'cancelled') {
        throw AUDIT_CANCELLATION_PENDING_SENTINEL;
      }
      const updatedAt = safeEpoch(epochNow);
      const pending = freeze({
        ...current, state: 'finalizing', commitState: 'pending', expectedTerminalRevision: 1, updatedAt,
      });
      await writeConfirmed(sessionArea, ACTIVE_AUDIT_JOB_KEY, pending, activeRecord, 'ACTIVE_AUDIT_JOB_DENIED');
      const latest = latestState(candidate.auditId, candidate.model.session.status, modelNow);
      // FECHADO À FALHA, achado D2 da revisão da 1.1.37: consentimento de pixel REIVINDICADO
      // (`consentId` não nulo) sem a alça da tentativa é estado inconsistente — o commit terminal gravaria
      // raster sem a correlação durável que amarra a captura à tentativa consentida. Quem prepara a alça
      // (`pixelAttemptLifecycle.prepareResume`) é a MESMA trilha que devolve o `consentId`; aqui só se
      // recusa seguir quando os dois discordam.
      if (liveRecord.consentId !== null && !liveRecord.attemptHandle) throw new Error('TERMINAL_COMMIT_DENIED');
      const committed = await pixelAttemptLifecycle.commitTerminal({
        auditId: candidate.auditId, model: candidate.model, checkpoint: candidate.checkpoint,
        latestState: latest, expectedRevision: 1, attemptHandle: liveRecord.attemptHandle,
      });
      const result = exact(committed, ['revision', 'modelHash']);
      if (!result || result.revision !== 1 || result.modelHash !== candidate.modelHash) throw new Error('TERMINAL_COMMIT_DENIED');
      try {
        const highlightTarget = liveRecord.observedTarget?.kind === 'owned-disposable'
          ? {
              version: 1,
              kind: 'disposable',
              ownerId: liveRecord.observedTarget.ownershipId,
              tabId: liveRecord.observedTarget.tabId,
              windowId: liveRecord.observedTarget.windowId,
              documentId: liveRecord.observedTarget.documentId,
              urlSessionDigest: liveRecord.observedTarget.urlSessionDigest,
              urlEvidence: liveRecord.observedTarget.urlEvidence.href,
            }
          : {
              version: 1,
              kind: 'attached',
              tabId: liveRecord.grant.target.tabId,
              windowId: liveRecord.grant.target.windowId,
              documentId: liveRecord.grant.target.documentId,
              urlSessionDigest: liveRecord.grant.target.initialUrlSessionDigest,
              urlEvidence: liveRecord.grant.target.initialUrlEvidence,
            };
        await recordHighlightBinding(freeze({
          snapshot: {
            model: candidate.model,
            modelRevision: candidate.modelRevision,
            modelHash: candidate.modelHash,
          },
          observedTarget: highlightTarget,
        }));
      } catch { /* a ausência de prova ao vivo mantém o relatório em evidências coletadas */ }
      const confirmed = freeze({ ...pending, commitState: 'confirmed', updatedAt: safeEpoch(epochNow) });
      await writeConfirmed(sessionArea, ACTIVE_AUDIT_JOB_KEY, confirmed, activeRecord, 'ACTIVE_AUDIT_JOB_DENIED');
      liveRecord.active = confirmed;
      liveRecord.committed = { candidate, bundle };
      return confirmed;
  }

  async function markFinalizing(liveRecord, candidate, bundle) {
    return withGlobalLock(() => panelCoordinator.withWindowLock(
      liveRecord.active.windowId,
      () => markFinalizingLocked(liveRecord, candidate, bundle),
    ));
  }

  async function execute(liveRecord) {
    const active = liveRecord.active;
    try {
      let lastCheckpoint = null;
      const outcome = await runAttachedAuditExecution({
        auditId: active.auditId, sessionCapabilityId: active.sessionCapabilityId,
        target: liveRecord.grant.target, capturePolicy: liveRecord.capturePolicy,
        ...(liveRecord.privacyGate ? { privacyGate: liveRecord.privacyGate } : {}),
        ...(liveRecord.resumeCheckpoint ? { resumeCheckpoint: liveRecord.resumeCheckpoint } : {}),
        modelNow, signal: liveRecord.controller.signal,
        onCheckpoint: async checkpoint => {
          const canonicalCheckpoint = canonicalIntermediateCheckpoint(active.auditId, checkpoint);
          const stored = await persistCheckpoint({
            auditId: active.auditId, sessionCapabilityId: active.sessionCapabilityId,
            windowId: active.windowId, checkpoint: canonicalCheckpoint,
          });
          const record = exact(stored, ['version', 'auditId', 'sessionCapabilityId', 'windowId', 'checkpoint']);
          if (!record || record.version !== 1 || record.auditId !== active.auditId ||
            record.sessionCapabilityId !== active.sessionCapabilityId || record.windowId !== active.windowId ||
            !same(canonicalIntermediateCheckpoint(active.auditId, record.checkpoint), canonicalCheckpoint)) {
            throw new Error('CHECKPOINT_PERSIST_DENIED');
          }
          lastCheckpoint = record.checkpoint;
        },
        persistAuditModel: async model => {
          if (lastCheckpoint === null) throw new Error('CHECKPOINT_PERSIST_DENIED');
          const candidate = await terminalCandidate({ auditId: active.auditId, model, checkpoint: lastCheckpoint });
          const bundle = copyPanelResultBundleV1(await buildPanelResultBundle({ reportRevision: candidate }));
          await markFinalizing(liveRecord, candidate, bundle);
        },
      });
      return await settle(liveRecord, outcome);
    } catch (error) {
      if (liveRecord.committed) {
        return settle(liveRecord, freeze({
          version: 1, auditId: active.auditId, state: 'model', failureCode: null,
          model: liveRecord.committed.candidate.model, checkpoint: liveRecord.committed.candidate.checkpoint,
        }));
      }
      let durable;
      try { durable = await readActiveAuditJobForWorker({ sessionArea }); } catch { durable = null; }
      if (durable?.auditId === active.auditId && durable.state === 'finalizing') {
        const recovery = await recoverAuthorizedAuditLifecycle();
        if (recovery.ok && recovery.state === 'reconciled') {
          return freeze({ ok: true, auditId: active.auditId, state: 'result', revision: 1 });
        }
        if (recovery.ok && recovery.state === 'interrupted') return completionRevoked(active.auditId, 'AUDIT_INTERRUPTED');
        return freeze({ ok: false, auditId: active.auditId, state: 'blocked', code: 'AUDIT_RECOVERY_REQUIRED' });
      }
      const code = error === AUDIT_REVOKED_SENTINEL || liveRecord.externallyInvalidated || liveRecord.liquidationReason
        ? 'AUDIT_REVOKED' : 'AUDIT_FAILED';
      return settle(liveRecord, freeze({
        version: 1, auditId: active.auditId, state: 'revoked', failureCode: code === 'AUDIT_REVOKED' ? 'AUDIT_FAILED' : code,
        model: null, checkpoint: null,
      }), code);
    }
  }

  async function liquidateLivePixel(current, liveRecord, scope, fallbackReason) {
    const reason = liveRecord.liquidationReason ?? fallbackReason;
    if (!PIXEL_LIQUIDATION_REASONS.has(reason) || liveRecord.consentId === null) return false;
    let suspension = (await readCorrelatedPixelSuspension(current)).suspension;
    if (!suspension || suspension.consentId !== liveRecord.consentId) return false;
    if (suspension.state !== 'revoked') {
      await pixelState.revokeAudit({ auditId: current.auditId, consentId: liveRecord.consentId, reason });
      await schedulePixelExpiryBestEffort();
      suspension = (await readCorrelatedPixelSuspension(current)).suspension;
    }
    const controller = createAbortController();
    if (!suspension || suspension.consentId !== liveRecord.consentId ||
      suspension.state !== 'revoked' || suspension.revokeReason !== reason ||
      !controller?.signal) return false;
    return liquidatePixelAuditLocked({
      auditId: current.auditId, consentId: liveRecord.consentId, reason,
      source: suspension.source, signal: controller.signal,
    }, scope);
  }

  async function settle(liveRecord, rawOutcome, forcedCode = null) {
    const active = liveRecord.active;
    return withGlobalLock(() => panelCoordinator.withWindowLock(active.windowId, async scope => {
      try {
        let current = await readActiveAuditJobForWorker({ sessionArea });
        if (!current || current.auditId !== active.auditId || current.sessionCapabilityId !== active.sessionCapabilityId) {
          return freeze({ ok: false, auditId: active.auditId, state: 'blocked', code: 'AUDIT_RECOVERY_REQUIRED' });
        }
        if (liveRecord.externallyInvalidated || forcedCode === 'AUDIT_REVOKED') {
          if (liveRecord.consentId !== null) {
            const liquidated = await liquidateLivePixel(
              current, liveRecord, scope,
              liveRecord.externallyInvalidated ? 'PIXEL_CONSENT_DOCUMENT_CHANGED' : 'PIXEL_RESUME_INTERRUPTED',
            );
            if (!liquidated) throw new Error('CORRELATED_CLEANUP_DENIED');
            return completionRevoked(current.auditId, 'AUDIT_REVOKED');
          }
          await persistExactLatest(latestState(current.auditId, 'AUDIT_REVOKED', modelNow));
          await transitionConfirmed(current, 'revoked');
          if (await invalidateConfirmed(current) !== true) throw new Error('CORRELATED_CLEANUP_DENIED');
          if (await scope.disconnectSession({
            auditId: current.auditId, sessionCapabilityId: current.sessionCapabilityId,
            windowId: current.windowId, reasonCode: 'AUDIT_REVOKED',
          }) !== true) throw new Error('CORRELATED_CLEANUP_DENIED');
          await discardTerminalBatchProgress(current);
          await cleanupActive(current, { removeRetention: true });
          return completionRevoked(current.auditId, 'AUDIT_REVOKED');
        }
        const outcome = exact(rawOutcome, ['version', 'auditId', 'state', 'failureCode', 'model', 'checkpoint']);
        if (!outcome || outcome.version !== 1 || outcome.auditId !== current.auditId) throw new Error('AUDIT_OUTCOME_DENIED');
        if (outcome.state === 'privacy-paused') {
          if (liveRecord.capturePolicy.mode === 'no-pixels' || outcome.failureCode !== null ||
            outcome.model !== null || !outcome.checkpoint) throw new Error('AUDIT_OUTCOME_DENIED');
          targetQueue.assertHeld(liveRecord.targetLock, {
            tabId: liveRecord.grant.target.tabId,
            windowId: liveRecord.grant.target.windowId,
            documentId: liveRecord.grant.target.documentId,
            urlSessionDigest: liveRecord.grant.target.initialUrlSessionDigest,
          });
          const journal = await readConfirmed(sessionArea, START_JOURNAL_KEY, journalRecord, 'START_JOURNAL_DENIED');
          const checkpoint = await readPersistedCheckpoint(current);
          const correlated = await readCorrelatedPixelSuspension(current);
          const { grant, suspension } = correlated;
          if (journal !== null ||
            correlated.sessionState !== 'running' || correlated.targetState !== 'claimed' ||
            !checkpoint || !grant || !suspension || suspension.state !== 'paused' ||
            !same(suspension.capturePolicy, liveRecord.capturePolicy) ||
            !same(checkpoint.checkpoint, outcome.checkpoint)) {
            throw new Error('AUDIT_RECOVERY_REQUIRED');
          }
          await transitionConfirmed(current, 'privacy-paused');
          const pausedActive = freeze({ ...current, state: 'privacy-paused', updatedAt: safeEpoch(epochNow) });
          await writeConfirmed(sessionArea, ACTIVE_AUDIT_JOB_KEY, pausedActive, activeRecord, 'ACTIVE_AUDIT_JOB_DENIED');
          await persistExactLatest(latestState(current.auditId, 'PRIVACY_PAUSED', modelNow));
          await schedulePixelExpiryBestEffort();
          const published = await scope.publishPrivacyPaused({
            auditId: current.auditId, sessionCapabilityId: current.sessionCapabilityId,
            windowId: current.windowId,
          });
          if (published !== true) throw new Error('PANEL_PUBLICATION_DENIED');
          live.delete(current.auditId);
          return freeze({ ok: true, auditId: current.auditId, state: 'privacy-paused', revision: null });
        }
        if (outcome.state === 'model') {
          let committed = liveRecord.committed;
          if (!committed) {
            const candidate = await terminalCandidate({ auditId: current.auditId, model: outcome.model, checkpoint: outcome.checkpoint });
            const bundle = copyPanelResultBundleV1(await buildPanelResultBundle({ reportRevision: candidate }));
            await markFinalizingLocked(liveRecord, candidate, bundle);
            committed = liveRecord.committed;
            current = liveRecord.active;
          }
          if (!committed || current.state !== 'finalizing' || current.commitState !== 'confirmed') throw new Error('TERMINAL_COMMIT_DENIED');
          await transitionConfirmed(current, 'result');
          const published = await scope.publishResult({
            auditId: current.auditId, sessionCapabilityId: current.sessionCapabilityId,
            windowId: current.windowId, state: 'result', resultBundle: committed.bundle,
          });
          if (!acceptedTerminalDelivery(published)) throw new Error('PANEL_PUBLICATION_DENIED');
          if (!await finishPixelConsent(liveRecord)) throw new Error('PIXEL_STATE_UNAVAILABLE');
          const attemptSource = liveRecord.resumeTarget ? freeze({
            kind: 'owned-disposable', ownershipId: liveRecord.resumeTarget.ownershipId,
            cleanupMode: liveRecord.resumeTarget.cleanupMode, pageId: liveRecord.resumeTarget.pageId,
          }) : freeze({ kind: 'attached' });
          if (!await pixelAttemptLifecycle.cleanup(pixelAttemptRequest(
            current.auditId, liveRecord.consentId, attemptSource, { expected: 'post-finish' },
          ))) throw new Error('PIXEL_ATTEMPT_CLEANUP_DENIED');
          if (current.mode === 'batch' && await clearBatchAuditProgress({ auditId: current.auditId }) !== true) {
            throw new Error('BATCH_PROGRESS_CLEAR_DENIED');
          }
          await cleanupActive(current);
          return freeze({ ok: true, auditId: current.auditId, state: 'result', revision: 1 });
        }
        const code = FAILURE_CODES.has(outcome.failureCode) ? outcome.failureCode : 'AUDIT_FAILED';
        if (liveRecord.consentId !== null) {
          const liquidated = await liquidateLivePixel(current, liveRecord, scope, 'PIXEL_RESUME_INTERRUPTED');
          if (!liquidated) throw new Error('CORRELATED_CLEANUP_DENIED');
          return completionRevoked(current.auditId, code);
        }
        await persistExactLatest(latestState(current.auditId, code, modelNow));
        await transitionConfirmed(current, 'revoked');
        if (await invalidateConfirmed(current) !== true) throw new Error('CORRELATED_CLEANUP_DENIED');
        if (await scope.disconnectSession({
          auditId: current.auditId, sessionCapabilityId: current.sessionCapabilityId,
          windowId: current.windowId, reasonCode: code,
        }) !== true) throw new Error('CORRELATED_CLEANUP_DENIED');
        await discardTerminalBatchProgress(current);
        await cleanupActive(current, { removeRetention: true });
        return completionRevoked(current.auditId, code);
      } catch (error) {
        let durable = null;
        try { durable = await readActiveAuditJobForWorker({ sessionArea }); } catch { /* fail closed below */ }
        if (durable?.auditId === active.auditId && durable.state === 'finalizing' && durable.commitState === 'pending') {
          throw error;
        }
        return freeze({ ok: false, auditId: active.auditId, state: 'blocked', code: 'AUDIT_RECOVERY_REQUIRED' });
      }
    }));
  }

  async function compensateStart(fact, journal, claimed) {
    try {
      return await panelCoordinator.withWindowLock(fact.windowId, async scope => {
        const sessionCapabilityId = claimed?.sessionCapabilityId;
        const currentActive = await readActiveAuditJobForWorker({ sessionArea });
        if (currentActive && (currentActive.auditId !== journal.auditId ||
          currentActive.capabilityId !== journal.capabilityId || currentActive.sessionCapabilityId !== sessionCapabilityId ||
          currentActive.windowId !== fact.windowId)) return false;
        const active = sessionCapabilityId ? (currentActive ?? {
          auditId: journal.auditId, capabilityId: journal.capabilityId,
          sessionCapabilityId, windowId: fact.windowId,
        }) : null;
        const liveRecord = live.get(journal.auditId);
        if (liveRecord && active && liveRecord.active.sessionCapabilityId === active.sessionCapabilityId) {
          try { liveRecord.controller.abort(); } catch { /* durable compensation remains authoritative */ }
        }
        if (active) {
          const latest = await readLatest();
          const latestAuditId = latest === null || latest === undefined ? null : supportedLatestAuditId(latest);
          if (latest !== null && latest !== undefined && latestAuditId === null) return false;
          if (latestAuditId === null || latestAuditId === active.auditId) {
            await persistExactLatest(latestState(active.auditId, 'AUDIT_FAILED', modelNow));
          }
          await transitionConfirmed(active, 'revoked');
          if (await invalidateConfirmed(active) !== true) return false;
          if (await scope.disconnectSession({
            auditId: active.auditId, sessionCapabilityId: active.sessionCapabilityId,
            windowId: active.windowId, reasonCode: 'AUDIT_START_COMPENSATED',
          }) !== true) return false;
          const checkpoint = exact(await removeCheckpoint({
            auditId: active.auditId, sessionCapabilityId: active.sessionCapabilityId, windowId: active.windowId,
          }), ['removed']);
          if (!checkpoint || typeof checkpoint.removed !== 'boolean') return false;
        } else {
          await authority.invalidateCapability(fact.capabilityId, 'AUDIT_START_COMPENSATED');
          const correlation = await readAttachedAuditCorrelationForRecovery({
            sessionArea, capabilityId: fact.capabilityId, auditId: journal.auditId,
          });
          if (correlation.targetState !== 'invalidated') return false;
        }
        const preferenceKey = retentionPreferenceStorageKey(journal.auditId);
        const preferenceParser = value => {
          const record = exact(value, ['version', 'auditId', 'deleteAfterCompleteExport', 'createdAt', 'expiresAt']);
          return record && record.version === 1 && record.auditId === journal.auditId &&
            record.deleteAfterCompleteExport === false ? freeze(record) : null;
        };
        if (!await removeCorrelated(sessionArea, preferenceKey, preferenceParser,
          record => record.auditId === journal.auditId)) return false;
        if (!await removeCorrelated(sessionArea, START_JOURNAL_KEY, journalRecord,
          current => current.auditId === journal.auditId && current.capabilityId === journal.capabilityId &&
            current.windowId === fact.windowId)) return false;
        if (currentActive && !await removeCorrelated(
          sessionArea, ACTIVE_AUDIT_JOB_KEY, activeRecord,
          current => current.auditId === currentActive.auditId && current.capabilityId === currentActive.capabilityId &&
            current.sessionCapabilityId === currentActive.sessionCapabilityId && current.windowId === currentActive.windowId,
        )) return false;
        live.delete(journal.auditId);
        return true;
      });
    } catch { return false; }
  }

  function urlPlan(value) {
    const plan = exact(value, URL_PLAN_KEYS);
    const evidenceUrl = plan && exact(plan.evidenceUrl, ['version', 'href', 'queryIncluded', 'redactedSegments']);
    const validPurpose = plan?.kind === 'single'
      ? plan.navigationPurpose === 'single-url'
      : plan?.kind === 'attached-copy' && plan.navigationPurpose === 'attached-copy';
    if (!plan || !validPurpose || !/^owner_[A-Za-z0-9_-]{22}$/u.test(plan.ownershipId ?? '') ||
      !/^[A-Za-z0-9_-]{22}$/u.test(plan.navigationToken ?? '') ||
      !evidenceUrl || !isEvidenceUrlV1(evidenceUrl) || evidenceUrl.queryIncluded !== false ||
      !/^hmac-sha256:[A-Za-z0-9_-]{43}$/u.test(plan.sessionDigest ?? '')) return null;
    return freeze({ ...plan, evidenceUrl: { ...evidenceUrl } });
  }

  function batchPlan(value) {
    const plan = exact(value, BATCH_PLAN_KEYS);
    return plan?.kind === 'batch' && AUDIT_ID.test(plan.queueId ?? '') && Number.isSafeInteger(plan.acceptedCount) &&
      plan.acceptedCount >= 2 && plan.acceptedCount <= 20
      ? freeze(plan)
      : null;
  }

  function urlObservedTarget(value, ownershipId, windowId, expectedCleanupMode = 'pre-observation-failure') {
    const target = exact(value, [
      'version', 'kind', 'ownershipId', 'tabId', 'windowId', 'documentId', 'urlEvidence',
      'urlSessionDigest', 'cleanupMode', 'pageId',
    ]);
    const evidenceUrl = target && exact(target.urlEvidence, ['version', 'href', 'queryIncluded', 'redactedSegments']);
    if (!target || target.version !== 'ObservedTargetV1' || target.kind !== 'owned-disposable' ||
      target.ownershipId !== ownershipId || !Number.isSafeInteger(target.tabId) || target.tabId < 0 ||
      !Number.isSafeInteger(target.windowId) || target.windowId !== windowId ||
      typeof target.documentId !== 'string' || target.documentId.length < 1 || target.documentId.length > 512 ||
      /[\u0000-\u001F\u007F]/u.test(target.documentId) || !evidenceUrl || !isEvidenceUrlV1(evidenceUrl) ||
      evidenceUrl.queryIncluded !== false || !DIGEST.test(target.urlSessionDigest ?? '') ||
      target.cleanupMode !== expectedCleanupMode || target.pageId !== 'page-1') return null;
    return freeze({ ...target, urlEvidence: { ...evidenceUrl } });
  }

  function urlCleanupRequest(auditId, ownershipId, navigationPurpose = 'single-url') {
    return navigationPurpose === 'attached-copy'
      ? freeze({ auditId, ownershipId, navigationPurpose: 'attached-copy', cleanupMode: 'always' })
      : freeze({ auditId, ownershipId });
  }

  async function transitionUrlOwnership(liveRecord, fromState, toState) {
    const ownershipId = liveRecord.plan?.ownershipId ?? liveRecord.resumeTarget?.ownershipId;
    const result = await authority.transitionDisposableAuditSession({
      sessionCapabilityId: liveRecord.active.sessionCapabilityId,
      auditId: liveRecord.active.auditId,
      ownershipId,
      fromState,
      toState,
    });
    if (result?.ok !== true || result.state !== toState || result.ownershipId !== ownershipId) {
      throw new Error('URL_OWNERSHIP_STATE_DENIED');
    }
    return toState;
  }

  async function executeUrl(liveRecord) {
    const active = liveRecord.active;
    const ownershipId = liveRecord.plan?.ownershipId ?? liveRecord.resumeTarget?.ownershipId;
    const navigationPurpose = liveRecord.plan?.navigationPurpose ?? liveRecord.resumeTarget?.navigationPurpose;
    if (!['single-url', 'attached-copy'].includes(navigationPurpose)) {
      throw new Error('URL_AUDIT_OUTCOME_DENIED');
    }
    const attachedCopy = navigationPurpose === 'attached-copy';
    const expectedCleanupMode = attachedCopy ? 'always' : 'pre-observation-failure';
    let lastCheckpoint = null;
    let proposedTerminal = null;
    try {
      const commonExecution = {
        auditId: active.auditId,
        capturePolicy: liveRecord.capturePolicy,
        privacyGate: liveRecord.privacyGate,
        modelNow,
        signal: liveRecord.controller.signal,
        onCheckpoint: async checkpoint => {
          const canonicalCheckpoint = canonicalIntermediateCheckpoint(active.auditId, checkpoint);
          const stored = await persistCheckpoint({
            auditId: active.auditId, sessionCapabilityId: active.sessionCapabilityId,
            windowId: active.windowId, checkpoint: canonicalCheckpoint,
          });
          const record = exact(stored, ['version', 'auditId', 'sessionCapabilityId', 'windowId', 'checkpoint']);
          if (!record || record.version !== 1 || record.auditId !== active.auditId ||
            record.sessionCapabilityId !== active.sessionCapabilityId || record.windowId !== active.windowId ||
            !same(canonicalIntermediateCheckpoint(active.auditId, record.checkpoint), canonicalCheckpoint)) {
            throw new Error('CHECKPOINT_PERSIST_DENIED');
          }
          lastCheckpoint = record.checkpoint;
        },
        persistAuditModel: async (model, observedTarget) => {
          if (lastCheckpoint === null || liveRecord.committed || proposedTerminal !== null) {
            throw new Error('CHECKPOINT_PERSIST_DENIED');
          }
          const safeTarget = urlObservedTarget(
            observedTarget,
            ownershipId,
            active.windowId,
            expectedCleanupMode,
          );
          if (!safeTarget) throw new Error('URL_AUDIT_OUTCOME_DENIED');
          const candidate = await terminalCandidate({
            auditId: active.auditId, model, checkpoint: lastCheckpoint,
          });
          const bundle = copyPanelResultBundleV1(await buildPanelResultBundle({ reportRevision: candidate }));
          proposedTerminal = freeze({ safeTarget, candidate, bundle });
        },
      };
      const output = await runUrlAuditExecution(liveRecord.resumeTarget
        ? {
            auditId: commonExecution.auditId,
            requestedUrlEvidence: liveRecord.requestedUrlEvidence,
            resumeTarget: liveRecord.resumeTarget,
            resumeCheckpoint: liveRecord.resumeCheckpoint,
            capturePolicy: commonExecution.capturePolicy,
            privacyGate: commonExecution.privacyGate,
            modelNow: commonExecution.modelNow,
            signal: commonExecution.signal,
            onCheckpoint: commonExecution.onCheckpoint,
            persistAuditModel: commonExecution.persistAuditModel,
          }
        : {
            auditId: commonExecution.auditId,
            ownershipId,
            windowId: active.windowId,
            navigationToken: liveRecord.plan.navigationToken,
            navigationPurpose: liveRecord.plan.navigationPurpose,
            evidenceUrl: liveRecord.plan.evidenceUrl,
            sessionDigest: liveRecord.plan.sessionDigest,
            capturePolicy: commonExecution.capturePolicy,
            ...(commonExecution.privacyGate ? { privacyGate: commonExecution.privacyGate } : {}),
            modelNow: commonExecution.modelNow,
            signal: commonExecution.signal,
            onCheckpoint: commonExecution.onCheckpoint,
            persistAuditModel: commonExecution.persistAuditModel,
          });
      const observed = exact(output, [
        'status', 'model', 'observedTarget', 'observationState', 'ownershipState',
      ]) ?? exact(output, [
        'status', 'model', 'observedTarget', 'observationState', 'ownershipState', 'signals',
      ]);
      if (!observed || !['complete', 'partial', 'failed', 'cancelled', 'privacy-paused'].includes(observed.status) ||
        !['observed', 'pre-observation-failure'].includes(observed.observationState) ||
        !['retained-for-review', 'retained-for-consent', 'cleanup-pending', 'removed'].includes(observed.ownershipState)) {
        throw new Error('URL_AUDIT_OUTCOME_DENIED');
      }
      if (observed.status === 'privacy-paused') {
        const safeTarget = urlObservedTarget(
          observed.observedTarget,
          ownershipId,
          active.windowId,
          expectedCleanupMode,
        );
        if (liveRecord.capturePolicy.mode === 'no-pixels' || observed.model !== null ||
          observed.observationState !== 'observed' || observed.ownershipState !== 'retained-for-consent' ||
          lastCheckpoint === null || !safeTarget) throw new Error('URL_AUDIT_OUTCOME_DENIED');
        await transitionUrlOwnership(liveRecord, 'pending', 'observing');
        await transitionUrlOwnership(liveRecord, 'observing', 'retained-for-consent');
        liveRecord.observedTarget = safeTarget;
        const checkpoint = await readPersistedCheckpoint(active);
        const correlated = await readCorrelatedPixelSuspension(active);
        if (!checkpoint || !same(checkpoint.checkpoint, lastCheckpoint) ||
          correlated.sessionState !== 'running' || correlated.targetState !== 'retained-for-consent' ||
          !correlated.suspension || correlated.suspension.state !== 'paused' ||
          !same(correlated.suspension.capturePolicy, liveRecord.capturePolicy)) {
          throw new Error('AUDIT_RECOVERY_REQUIRED');
        }
        await transitionConfirmed(active, 'privacy-paused');
        const pausedActive = freeze({ ...active, state: 'privacy-paused', updatedAt: safeEpoch(epochNow) });
        await writeConfirmed(sessionArea, ACTIVE_AUDIT_JOB_KEY, pausedActive, activeRecord, 'ACTIVE_AUDIT_JOB_DENIED');
        await persistExactLatest(latestState(active.auditId, 'PRIVACY_PAUSED', modelNow));
        await schedulePixelExpiryBestEffort();
        const published = await panelCoordinator.withWindowLock(active.windowId, scope => scope.publishPrivacyPaused({
          auditId: active.auditId, sessionCapabilityId: active.sessionCapabilityId, windowId: active.windowId,
        }));
        if (published !== true) throw new Error('PANEL_PUBLICATION_DENIED');
        live.delete(active.auditId);
        return freeze({ ok: true, auditId: active.auditId, state: 'privacy-paused', revision: null });
      }
      if (observed.model !== null) {
        const safeTarget = urlObservedTarget(
          observed.observedTarget,
          ownershipId,
          active.windowId,
          expectedCleanupMode,
        );
        const expectedOwnershipState = attachedCopy ? 'removed' : 'retained-for-review';
        if (lastCheckpoint === null || observed.observationState !== 'observed' ||
          observed.ownershipState !== expectedOwnershipState || !safeTarget ||
          (proposedTerminal && !same(proposedTerminal.safeTarget, safeTarget))) {
          throw new Error('URL_AUDIT_OUTCOME_DENIED');
        }
        const candidate = await terminalCandidate({
          auditId: active.auditId, model: observed.model, checkpoint: lastCheckpoint,
        });
        if (proposedTerminal && (proposedTerminal.candidate.modelHash !== candidate.modelHash ||
          proposedTerminal.candidate.modelRevision !== candidate.modelRevision ||
          !same(proposedTerminal.candidate.checkpoint, candidate.checkpoint))) {
          throw new Error('URL_AUDIT_OUTCOME_DENIED');
        }
        const bundle = proposedTerminal?.bundle ??
          copyPanelResultBundleV1(await buildPanelResultBundle({ reportRevision: candidate }));
        if (attachedCopy) {
          if (await clearUrlAuditResources(urlCleanupRequest(
            active.auditId,
            ownershipId,
            navigationPurpose,
          )) !== true) throw new Error('CORRELATED_CLEANUP_DENIED');
          await transitionUrlOwnership(
            liveRecord,
            liveRecord.resumeTarget ? 'observing' : 'pending',
            'removed',
          );
          const correlation = await readNavigationAuditCorrelationForRecovery({
            sessionArea, capabilityId: active.capabilityId, auditId: active.auditId,
          });
          if (correlation.ownershipState !== 'removed' ||
            correlation.navigationPurpose !== 'attached-copy') {
            throw new Error('URL_OWNERSHIP_STATE_DENIED');
          }
        } else {
          await transitionUrlOwnership(
            liveRecord,
            liveRecord.resumeTarget ? 'observing' : 'pending',
            'retained-for-review',
          );
        }
        liveRecord.observedTarget = safeTarget;
        await markFinalizing(liveRecord, candidate, bundle);
        const committed = liveRecord.committed;
        if (!committed) throw new Error('TERMINAL_COMMIT_DENIED');
        return settle(liveRecord, freeze({
          version: 1, auditId: active.auditId, state: 'model', failureCode: null,
          model: committed.candidate.model, checkpoint: committed.candidate.checkpoint,
        }));
      }
      if (observed.observationState !== 'pre-observation-failure' || observed.observedTarget !== null) {
        throw new Error('URL_AUDIT_OUTCOME_DENIED');
      }
      await transitionUrlOwnership(liveRecord, 'pending', observed.ownershipState);
      if (observed.ownershipState === 'cleanup-pending') {
        if (await clearUrlAuditResources(urlCleanupRequest(
          active.auditId,
          ownershipId,
          navigationPurpose,
        )) !== true) throw new Error('CORRELATED_CLEANUP_DENIED');
        await transitionUrlOwnership(liveRecord, 'cleanup-pending', 'removed');
      } else if (await clearUrlAuditResources(urlCleanupRequest(
        active.auditId,
        ownershipId,
        navigationPurpose,
      )) !== true) throw new Error('CORRELATED_CLEANUP_DENIED');
      return settle(liveRecord, freeze({
        version: 1, auditId: active.auditId, state: 'revoked', failureCode: 'AUDIT_FAILED',
        model: null, checkpoint: null,
      }), 'AUDIT_FAILED');
    } catch (error) {
      if (liveRecord.committed) {
        return settle(liveRecord, freeze({
          version: 1, auditId: active.auditId, state: 'model', failureCode: null,
          model: liveRecord.committed.candidate.model, checkpoint: liveRecord.committed.candidate.checkpoint,
        }));
      }
      let durable;
      try { durable = await readActiveAuditJobForWorker({ sessionArea }); } catch { durable = null; }
      if (durable?.auditId === active.auditId && durable.state === 'privacy-paused') {
        live.delete(active.auditId);
        return freeze({
          ok: false, auditId: active.auditId, state: 'blocked', code: 'AUDIT_RECOVERY_REQUIRED',
        });
      }
      if (durable?.auditId === active.auditId && durable.state === 'finalizing') {
        const recovery = await recoverAuthorizedAuditLifecycle();
        if (recovery.ok && recovery.state === 'reconciled') {
          return freeze({ ok: true, auditId: active.auditId, state: 'result', revision: 1 });
        }
        if (recovery.ok && recovery.state === 'interrupted') {
          return completionRevoked(active.auditId, 'AUDIT_INTERRUPTED');
        }
        return freeze({ ok: false, auditId: active.auditId, state: 'blocked', code: 'AUDIT_RECOVERY_REQUIRED' });
      }
      try {
        const correlation = await readNavigationAuditCorrelationForRecovery({
          sessionArea, capabilityId: active.capabilityId, auditId: active.auditId,
        });
        if (await clearUrlAuditResources(urlCleanupRequest(
          active.auditId,
          ownershipId,
          navigationPurpose,
        )) !== true) {
          throw new Error('CORRELATED_CLEANUP_DENIED');
        }
        if (correlation.ownershipState !== 'removed') {
          await transitionUrlOwnership(liveRecord, correlation.ownershipState, 'removed');
        }
        const removed = await readNavigationAuditCorrelationForRecovery({
          sessionArea, capabilityId: active.capabilityId, auditId: active.auditId,
        });
        if (removed.ownershipState !== 'removed') throw new Error('CORRELATED_CLEANUP_DENIED');
      } catch {
        return freeze({ ok: false, auditId: active.auditId, state: 'blocked', code: 'AUDIT_RECOVERY_REQUIRED' });
      }
      return settle(liveRecord, freeze({
        version: 1, auditId: active.auditId, state: 'revoked', failureCode: 'AUDIT_FAILED',
        model: null, checkpoint: null,
      }), 'AUDIT_FAILED');
    }
  }

  async function executeBatch(liveRecord) {
    const active = liveRecord.active;
    const recovery = liveRecord.batchRecovery ?? null;
    let lastCheckpoint = recovery?.resumeCheckpoint ?? null;
    try {
      const rawOutput = await (recovery ? recoverBatchAuditExecution : runBatchAuditExecution)({
        auditId: active.auditId,
        capabilityId: active.capabilityId,
        sessionCapabilityId: active.sessionCapabilityId,
        windowId: active.windowId,
        ...(recovery ? {
          consentId: recovery.consentId,
          resumeTarget: recovery.resumeTarget,
          resumeCheckpoint: recovery.resumeCheckpoint,
        } : { acceptedCount: liveRecord.plan.acceptedCount }),
        capturePolicy: liveRecord.capturePolicy,
        modelNow,
        signal: liveRecord.controller.signal,
        onCheckpoint: async checkpoint => {
          const canonicalCheckpoint = canonicalIntermediateCheckpoint(active.auditId, checkpoint);
          const stored = await persistCheckpoint({
            auditId: active.auditId,
            sessionCapabilityId: active.sessionCapabilityId,
            windowId: active.windowId,
            checkpoint: canonicalCheckpoint,
          });
          const record = exact(stored, ['version', 'auditId', 'sessionCapabilityId', 'windowId', 'checkpoint']);
          if (!record || record.version !== 1 || record.auditId !== active.auditId ||
            record.sessionCapabilityId !== active.sessionCapabilityId || record.windowId !== active.windowId ||
            !same(canonicalIntermediateCheckpoint(active.auditId, record.checkpoint), canonicalCheckpoint)) {
            throw new Error('CHECKPOINT_PERSIST_DENIED');
          }
          lastCheckpoint = record.checkpoint;
        },
        onPrivacyPaused: async value => {
          const paused = exact(value, ['auditId', 'childAuditId', 'pageId', 'ownershipId']);
          if (!paused || paused.auditId !== active.auditId || !AUDIT_ID.test(paused.childAuditId ?? '') ||
            !/^page-([1-9]|1[0-9]|20)$/u.test(paused.pageId ?? '') ||
            !/^owner_[A-Za-z0-9_-]{22}$/u.test(paused.ownershipId ?? '') || lastCheckpoint === null) {
            throw new Error('BATCH_PRIVACY_PAUSE_DENIED');
          }
          const correlation = await readBatchAuditCorrelationForRecovery({
            sessionArea, capabilityId: active.capabilityId, auditId: active.auditId,
          });
          const checkpoint = await readPersistedCheckpoint(active);
          const correlated = await readCorrelatedPixelSuspension(active);
          if (correlation.sessionState !== 'running' || correlation.activePageId !== paused.pageId ||
            correlation.activeOwnershipId !== paused.ownershipId || !checkpoint ||
            !same(checkpoint.checkpoint, lastCheckpoint) || correlated.sessionState !== 'running' ||
            correlated.targetState !== 'claimed' || !correlated.suspension ||
            correlated.suspension.state !== 'paused' ||
            correlated.suspension.source.kind !== 'owned-disposable' ||
            correlated.suspension.source.ownershipId !== paused.ownershipId ||
            correlated.suspension.source.pageId !== paused.pageId ||
            !same(correlated.suspension.capturePolicy, liveRecord.capturePolicy)) {
            throw new Error('BATCH_PRIVACY_PAUSE_DENIED');
          }
          liveRecord.pausedBatchPage = freeze({
            childAuditId: paused.childAuditId,
            pageId: paused.pageId,
            ownershipId: paused.ownershipId,
          });
          await transitionConfirmed(active, 'privacy-paused');
          const pausedActive = freeze({ ...active, state: 'privacy-paused', updatedAt: safeEpoch(epochNow) });
          await writeConfirmed(sessionArea, ACTIVE_AUDIT_JOB_KEY, pausedActive, activeRecord, 'ACTIVE_AUDIT_JOB_DENIED');
          liveRecord.active = pausedActive;
          await persistExactLatest(latestState(active.auditId, 'PRIVACY_PAUSED', modelNow));
          await schedulePixelExpiryBestEffort();
          const published = await panelCoordinator.withWindowLock(active.windowId, scope => scope.publishPrivacyPaused({
            auditId: active.auditId, sessionCapabilityId: active.sessionCapabilityId, windowId: active.windowId,
          }));
          if (published !== true) throw new Error('PANEL_PUBLICATION_DENIED');
        },
        onPixelPageFinished: async value => {
          const finished = exact(value, ['auditId', 'childAuditId', 'pageId', 'ownershipId', 'consentId']);
          const paused = liveRecord.pausedBatchPage;
          const resume = liveRecord.resumeTarget;
          if (!finished || finished.auditId !== active.auditId ||
            (paused?.childAuditId !== null && finished.childAuditId !== paused?.childAuditId) ||
            !AUDIT_ID.test(finished.childAuditId ?? '') || finished.pageId !== paused?.pageId ||
            finished.ownershipId !== paused?.ownershipId || finished.consentId !== liveRecord.consentId ||
            resume?.pageId !== finished.pageId || resume?.ownershipId !== finished.ownershipId ||
            !/^[A-Za-z0-9_-]{21}[AQgw]$/u.test(finished.consentId ?? '') ||
            !liveRecord.attemptHandle || typeof liveRecord.attemptHandle !== 'object') {
            throw new Error('BATCH_PIXEL_FINISH_DENIED');
          }
          let pixelFinished = false;
          try {
            pixelFinished = await pixelState.finish({
              auditId: active.auditId,
              consentId: finished.consentId,
            }) === true;
          } catch {
            pixelFinished = (await readCorrelatedPixelSuspension(active)).suspension === null;
          }
          if (!pixelFinished || (await readCorrelatedPixelSuspension(active)).suspension !== null ||
            !await pixelAttemptLifecycle.cleanup({
              auditId: active.auditId,
              consentId: finished.consentId,
              pageId: finished.pageId,
              ownershipId: finished.ownershipId,
              expected: 'prepared',
            })) throw new Error('BATCH_PIXEL_FINISH_DENIED');
          liveRecord.consentId = null;
          liveRecord.attemptHandle = null;
          liveRecord.resumeTarget = null;
          liveRecord.pausedBatchPage = null;
          await schedulePixelExpiryBestEffort();
        },
      });
      const recoveredOutput = recovery ? exact(rawOutput, ['model', 'checkpoint', 'acceptedCount']) : null;
      const output = recoveredOutput ?? exact(rawOutput, ['model', 'checkpoint']);
      if (recoveredOutput) {
        if (!Number.isSafeInteger(recoveredOutput.acceptedCount) || recoveredOutput.acceptedCount < 2 ||
          recoveredOutput.acceptedCount > 20) throw new Error('BATCH_AUDIT_OUTCOME_DENIED');
        liveRecord.plan = freeze({
          kind: 'batch', queueId: active.auditId, acceptedCount: recoveredOutput.acceptedCount,
        });
      }
      if (!output || lastCheckpoint === null ||
        !same(canonicalIntermediateCheckpoint(active.auditId, output.checkpoint), lastCheckpoint)) {
        throw new Error('BATCH_AUDIT_OUTCOME_DENIED');
      }
      const candidate = await terminalCandidate({
        auditId: active.auditId,
        model: output.model,
        checkpoint: lastCheckpoint,
      });
      if (candidate.model.requestedScope?.mode !== 'batch' ||
        candidate.model.pages.length !== liveRecord.plan.acceptedCount) {
        throw new Error('BATCH_AUDIT_OUTCOME_DENIED');
      }
      const bundle = copyPanelResultBundleV1(await buildPanelResultBundle({ reportRevision: candidate }));
      await markFinalizing(liveRecord, candidate, bundle);
      return settle(liveRecord, freeze({
        version: 1,
        auditId: active.auditId,
        state: 'model',
        failureCode: null,
        model: candidate.model,
        checkpoint: candidate.checkpoint,
      }));
    } catch (error) {
      if (liveRecord.committed) {
        return settle(liveRecord, freeze({
          version: 1,
          auditId: active.auditId,
          state: 'model',
          failureCode: null,
          model: liveRecord.committed.candidate.model,
          checkpoint: liveRecord.committed.candidate.checkpoint,
        }));
      }
      let durable = null;
      try { durable = await readActiveAuditJobForWorker({ sessionArea }); } catch { /* fail closed below */ }
      if (durable?.auditId === active.auditId && durable.state === 'finalizing') {
        const recovered = await recoverAuthorizedAuditLifecycle();
        if (recovered.ok && recovered.state === 'reconciled') {
          return freeze({ ok: true, auditId: active.auditId, state: 'result', revision: 1 });
        }
        return freeze({ ok: false, auditId: active.auditId, state: 'blocked', code: 'AUDIT_RECOVERY_REQUIRED' });
      }
      let cleaned = false;
      try {
        cleaned = await clearBatchAuditResources(freeze({
          auditId: active.auditId,
          capabilityId: active.capabilityId,
          sessionCapabilityId: active.sessionCapabilityId,
          windowId: active.windowId,
        })) === true;
      } catch { cleaned = false; }
      if (!cleaned) {
        return freeze({ ok: false, auditId: active.auditId, state: 'blocked', code: 'AUDIT_RECOVERY_REQUIRED' });
      }
      const cancelled = error === AUDIT_REVOKED_SENTINEL || liveRecord.externallyInvalidated ||
        liveRecord.liquidationReason || liveRecord.controller.signal.aborted;
      return settle(liveRecord, freeze({
        version: 1,
        auditId: active.auditId,
        state: 'revoked',
        failureCode: 'AUDIT_FAILED',
        model: null,
        checkpoint: null,
      }), cancelled ? 'AUDIT_REVOKED' : 'AUDIT_FAILED');
    }
  }

  async function beginAuthorizedBatchAudit(raw) {
    const args = exact(raw, BATCH_BEGIN_KEYS);
    const capturePolicy = args && exactCapturePolicy(args.capturePolicy);
    const preference = args && retentionIntent(args.retentionPreference);
    const context = args && exact(args.senderContext, ['issuer', 'windowId', 'tabId', 'contextType', 'documentUrl']);
    const denied = code => freeze({ response: { ok: false, code }, sessionCapabilityId: null, completion: null });
    if (!hasBatchAudit || !args || !CAPABILITY.test(args.capabilityId ?? '') || !AUDIT_ID.test(args.auditId ?? '') ||
      typeof args?.preparePlan !== 'function' || !capturePolicy ||
      (capturePolicy.mode !== 'no-pixels' && !hasBatchResume) ||
      capturePolicy.includeQuery !== false || !preference || !context ||
      !Number.isSafeInteger(context.windowId) || context.windowId < 0 || context.tabId !== null ||
      context.contextType !== 'SIDE_PANEL') return denied('AUDIT_START_FAILED');

    const setup = await withGlobalLock(async () => {
      let journal = null;
      let claimed = null;
      let active = null;
      let plan = null;
      try {
        const singletons = await currentSingletons();
        if (singletons.active) return denied('AUDIT_BUSY');
        if (singletons.journal) return denied('AUDIT_RECOVERY_REQUIRED');
        const snapshot = await readAuditSnapshot({ auditId: args.auditId });
        if (!missingAuditSnapshot(snapshot) || await readReportRevision({ auditId: args.auditId }) !== null) {
          return denied('AUDIT_ID_COLLISION');
        }
        return await panelCoordinator.withWindowLock(context.windowId, async scope => {
          const createdAt = safeEpoch(epochNow);
          journal = freeze({
            version: 1, capabilityId: args.capabilityId, auditId: args.auditId,
            windowId: context.windowId, mode: 'batch', state: 'prepared', sessionCapabilityId: null,
            createdAt, updatedAt: createdAt,
          });
          await writeConfirmed(sessionArea, START_JOURNAL_KEY, journal, journalRecord, 'START_JOURNAL_DENIED');
          plan = batchPlan(await Reflect.apply(args.preparePlan, undefined, []));
          if (!plan || plan.queueId !== args.auditId) throw new Error('AUDIT_START_FAILED');
          claimed = await authority.claimNavigationAndIssueAuditSession({
            capabilityId: args.capabilityId,
            auditId: args.auditId,
            ownershipId: null,
            intent: 'batch',
            senderContext: args.senderContext,
          });
          if (claimed?.ok !== true || !CAPABILITY.test(claimed.sessionCapabilityId ?? '')) {
            throw TARGET_UNAVAILABLE_SENTINEL;
          }
          const correlation = await readBatchAuditCorrelationForRecovery({
            sessionArea, capabilityId: args.capabilityId, auditId: args.auditId,
          });
          if (correlation.sessionCapabilityId !== claimed.sessionCapabilityId ||
            correlation.windowId !== context.windowId || correlation.capabilityState !== 'claimed' ||
            correlation.sessionState !== 'running' || correlation.activePageId !== null ||
            correlation.activeOwnershipId !== null) throw TARGET_UNAVAILABLE_SENTINEL;
          journal = freeze({
            ...journal, state: 'claimed', sessionCapabilityId: claimed.sessionCapabilityId,
            updatedAt: safeEpoch(epochNow),
          });
          await writeConfirmed(sessionArea, START_JOURNAL_KEY, journal, journalRecord, 'START_JOURNAL_DENIED');
          const postGrant = safeEpoch(epochNow);
          if (postGrant < correlation.issuedAt || postGrant >= correlation.expiresAt) throw TARGET_UNAVAILABLE_SENTINEL;
          const storedPreference = freeze({
            version: 1, auditId: args.auditId, deleteAfterCompleteExport: false,
            createdAt: postGrant, expiresAt: correlation.expiresAt,
          });
          const preferenceParser = value => {
            const record = exact(value, ['version', 'auditId', 'deleteAfterCompleteExport', 'createdAt', 'expiresAt']);
            return record && same(record, storedPreference) ? freeze(record) : null;
          };
          await writeConfirmed(sessionArea, retentionPreferenceStorageKey(args.auditId), storedPreference,
            preferenceParser, 'RETENTION_PREFERENCE_DENIED');
          if (await scope.registerPendingBootstrap({
            auditId: args.auditId,
            sessionCapabilityId: claimed.sessionCapabilityId,
            windowId: context.windowId,
            captureMode: capturePolicy.mode,
            createdAt: postGrant,
            expiresAt: correlation.expiresAt,
          }) !== true) throw new Error('AUDIT_START_FAILED');
          await persistExactLatest(latestState(args.auditId, 'running', modelNow));
          const controller = createAbortController();
          if (!controller?.signal || typeof controller.abort !== 'function') throw new Error('AUDIT_START_FAILED');
          active = freeze({
            version: 1, auditId: args.auditId, capabilityId: args.capabilityId,
            sessionCapabilityId: claimed.sessionCapabilityId, windowId: context.windowId, mode: 'batch',
            state: 'running', commitState: 'none', expectedTerminalRevision: null,
            createdAt: postGrant, updatedAt: postGrant,
          });
          await writeConfirmed(sessionArea, ACTIVE_AUDIT_JOB_KEY, active, activeRecord, 'ACTIVE_AUDIT_JOB_DENIED');
          const liveRecord = {
            active, controller, plan, capturePolicy, privacyGate: null, consentId: null,
            grant: null, observedTarget: null, externallyInvalidated: false, liquidationReason: null,
            committed: null, completion: null, attemptHandle: null,
          };
          live.set(active.auditId, liveRecord);
          if (!await removeCorrelated(sessionArea, START_JOURNAL_KEY, journalRecord,
            current => current.mode === 'batch' && current.auditId === active.auditId &&
              current.capabilityId === active.capabilityId &&
              current.sessionCapabilityId === active.sessionCapabilityId && current.windowId === active.windowId)) {
            throw new Error('AUDIT_START_FAILED');
          }
          if (await scope.publishRegisteredBootstrap({
            auditId: args.auditId,
            sessionCapabilityId: claimed.sessionCapabilityId,
            windowId: context.windowId,
          }) !== true) throw new Error('AUDIT_START_FAILED');
          return {
            response: { ok: true, auditId: args.auditId, state: 'running' },
            sessionCapabilityId: claimed.sessionCapabilityId,
            liveRecord,
          };
        });
      } catch (error) {
        try {
          const cleanupRequest = freeze({
            auditId: args.auditId,
            capabilityId: args.capabilityId,
            sessionCapabilityId: claimed?.sessionCapabilityId ?? null,
            windowId: context.windowId,
          });
          if (await clearBatchAuditResources(cleanupRequest) !== true) throw new Error('AUDIT_RECOVERY_REQUIRED');
          const compensationActive = claimed?.sessionCapabilityId ? (active ?? freeze({
            version: 1, auditId: args.auditId, capabilityId: args.capabilityId,
            sessionCapabilityId: claimed.sessionCapabilityId, windowId: context.windowId, mode: 'batch',
            state: 'running', commitState: 'none', expectedTerminalRevision: null,
            createdAt: journal?.createdAt ?? safeEpoch(epochNow),
            updatedAt: journal?.updatedAt ?? safeEpoch(epochNow),
          })) : null;
          if (compensationActive) {
            const session = await readAuditSessionForWorker({
              sessionArea,
              sessionCapabilityId: compensationActive.sessionCapabilityId,
              auditId: compensationActive.auditId,
            });
            if (session.state === 'running') await transitionConfirmed(compensationActive, 'revoked');
            else if (session.state !== 'revoked') throw new Error('AUDIT_RECOVERY_REQUIRED');
          }
          const invalidated = compensationActive
            ? await invalidateConfirmed(compensationActive)
            : (await authority.invalidateCapability(args.capabilityId, 'AUDIT_START_COMPENSATED'))?.ok === true;
          if (invalidated !== true) throw new Error('AUDIT_RECOVERY_REQUIRED');
          if (compensationActive) {
            const disconnected = await panelCoordinator.withWindowLock(context.windowId, scope => scope.disconnectSession({
              auditId: compensationActive.auditId,
              sessionCapabilityId: compensationActive.sessionCapabilityId,
              windowId: compensationActive.windowId,
              reasonCode: 'AUDIT_START_COMPENSATED',
            }));
            if (disconnected !== true) throw new Error('AUDIT_RECOVERY_REQUIRED');
            await removeCheckpoint({
              auditId: compensationActive.auditId,
              sessionCapabilityId: compensationActive.sessionCapabilityId,
              windowId: compensationActive.windowId,
            });
            if (!await removePreference(compensationActive)) throw new Error('AUDIT_RECOVERY_REQUIRED');
          } else if (!await removePreference({ auditId: args.auditId })) {
            throw new Error('AUDIT_RECOVERY_REQUIRED');
          }
          if (active) {
            await removeCorrelated(sessionArea, ACTIVE_AUDIT_JOB_KEY, activeRecord,
              current => current.auditId === active.auditId && current.sessionCapabilityId === active.sessionCapabilityId);
            live.delete(active.auditId);
          }
          if (journal) await removeCorrelated(sessionArea, START_JOURNAL_KEY, journalRecord,
            current => current.mode === 'batch' && current.auditId === args.auditId &&
              current.capabilityId === args.capabilityId);
        } catch { return denied('AUDIT_RECOVERY_REQUIRED'); }
        return denied(error === TARGET_UNAVAILABLE_SENTINEL ? 'TARGET_UNAVAILABLE' : 'AUDIT_START_FAILED');
      }
    });
    if (setup.response.ok !== true) return setup;
    const completion = executeBatch(setup.liveRecord);
    setup.liveRecord.completion = completion;
    return freeze({ response: setup.response, sessionCapabilityId: setup.sessionCapabilityId, completion });
  }

  async function beginAuthorizedUrlAudit(raw, lockToken = null) {
    const args = exact(raw, URL_BEGIN_KEYS);
    const plan = args && urlPlan(args.plan);
    const capturePolicy = args && exactCapturePolicy(args.capturePolicy);
    const preference = args && retentionIntent(args.retentionPreference);
    const context = args && exact(args.senderContext, ['issuer', 'windowId', 'tabId', 'contextType', 'documentUrl']);
    const denied = code => freeze({ response: { ok: false, code }, sessionCapabilityId: null, completion: null });
    if (!hasUrlAudit || !args || !CAPABILITY.test(args.capabilityId ?? '') || !AUDIT_ID.test(args.auditId ?? '') ||
      !plan || !capturePolicy || capturePolicy.includeQuery !== false ||
      !preference || !context || !Number.isSafeInteger(context.windowId) || context.windowId < 0 ||
      context.tabId !== null || context.contextType !== 'SIDE_PANEL') return denied('AUDIT_START_FAILED');
    const lockedAttachedCopy = plan.kind === 'attached-copy' && lockToken !== null &&
      typeof lockToken === 'object' && lockedAttachedCopyStarts.has(lockToken);

    const prepareSetup = async () => {
      let journal = null;
      let claimed = null;
      try {
        const singletons = await currentSingletons();
        if (lockedAttachedCopy) {
          journal = attachedCopyJournal(singletons.journal);
          if (singletons.active || !journal || journal.state !== 'prepared' ||
            journal.sessionCapabilityId !== null ||
            !sameAttachedCopyJournalIdentity(journal, {
              capabilityId: args.capabilityId,
              auditId: args.auditId,
              windowId: context.windowId,
              ownershipId: plan.ownershipId,
            })) return denied('AUDIT_RECOVERY_REQUIRED');
        } else {
          if (singletons.active) return denied('AUDIT_BUSY');
          if (singletons.journal) return denied('AUDIT_RECOVERY_REQUIRED');
        }
        const snapshot = await readAuditSnapshot({ auditId: args.auditId });
        if (!missingAuditSnapshot(snapshot) || await readReportRevision({ auditId: args.auditId }) !== null) {
          return denied('AUDIT_ID_COLLISION');
        }
        return await panelCoordinator.withWindowLock(context.windowId, async scope => {
          if (journal === null) {
            const createdAt = safeEpoch(epochNow);
            journal = plan.kind === 'attached-copy'
              ? freeze({
                  version: 1, capabilityId: args.capabilityId, auditId: args.auditId,
                  windowId: context.windowId, mode: 'single', navigationPurpose: 'attached-copy',
                  ownershipId: plan.ownershipId, state: 'prepared', sessionCapabilityId: null,
                  createdAt, updatedAt: createdAt,
                })
              : freeze({
                  version: 1, capabilityId: args.capabilityId, auditId: args.auditId,
                  windowId: context.windowId, state: 'prepared', sessionCapabilityId: null,
                  createdAt, updatedAt: createdAt,
                });
            await writeConfirmed(sessionArea, START_JOURNAL_KEY, journal, journalRecord, 'START_JOURNAL_DENIED');
          }
          claimed = plan.kind === 'attached-copy'
            ? await authority.claimExchangedAttachedCopyAndIssueAuditSession({
                capabilityId: args.capabilityId, auditId: args.auditId,
                ownershipId: plan.ownershipId, senderContext: args.senderContext,
              })
            : await authority.claimNavigationAndIssueAuditSession({
                capabilityId: args.capabilityId, auditId: args.auditId, ownershipId: plan.ownershipId,
                intent: 'single', senderContext: args.senderContext,
              });
          if (claimed?.ok !== true || !CAPABILITY.test(claimed.sessionCapabilityId ?? '')) throw TARGET_UNAVAILABLE_SENTINEL;
          const correlation = await readNavigationAuditCorrelationForRecovery({
            sessionArea, capabilityId: args.capabilityId, auditId: args.auditId,
          });
          if (correlation.sessionCapabilityId !== claimed.sessionCapabilityId ||
            correlation.windowId !== context.windowId || correlation.ownershipId !== plan.ownershipId ||
            correlation.ownershipState !== 'pending' || correlation.navigationPurpose !== plan.navigationPurpose) {
            throw TARGET_UNAVAILABLE_SENTINEL;
          }
          journal = freeze({
            ...journal, state: 'claimed', sessionCapabilityId: claimed.sessionCapabilityId,
            updatedAt: safeEpoch(epochNow),
          });
          await writeConfirmed(sessionArea, START_JOURNAL_KEY, journal, journalRecord, 'START_JOURNAL_DENIED');
          const postGrant = safeEpoch(epochNow);
          if (postGrant < correlation.issuedAt || postGrant >= correlation.expiresAt) throw TARGET_UNAVAILABLE_SENTINEL;
          const storedPreference = freeze({
            version: 1, auditId: args.auditId, deleteAfterCompleteExport: false,
            createdAt: postGrant, expiresAt: correlation.expiresAt,
          });
          const preferenceParser = value => {
            const record = exact(value, ['version', 'auditId', 'deleteAfterCompleteExport', 'createdAt', 'expiresAt']);
            return record && same(record, storedPreference) ? freeze(record) : null;
          };
          await writeConfirmed(sessionArea, retentionPreferenceStorageKey(args.auditId), storedPreference,
            preferenceParser, 'RETENTION_PREFERENCE_DENIED');
          if (await scope.registerPendingBootstrap({
            auditId: args.auditId, sessionCapabilityId: claimed.sessionCapabilityId,
            windowId: context.windowId, captureMode: capturePolicy.mode,
            createdAt: postGrant, expiresAt: correlation.expiresAt,
          }) !== true) throw new Error('AUDIT_START_FAILED');
          await persistExactLatest(latestState(args.auditId, 'running', modelNow));
          const controller = createAbortController();
          if (!controller?.signal || typeof controller.abort !== 'function') throw new Error('AUDIT_START_FAILED');
          const active = freeze({
            version: 1, auditId: args.auditId, capabilityId: args.capabilityId,
            sessionCapabilityId: claimed.sessionCapabilityId, windowId: context.windowId, mode: 'single',
            state: 'running', commitState: 'none', expectedTerminalRevision: null,
            createdAt: postGrant, updatedAt: postGrant,
          });
          await writeConfirmed(sessionArea, ACTIVE_AUDIT_JOB_KEY, active, activeRecord, 'ACTIVE_AUDIT_JOB_DENIED');
          const requestedEvidence = freeze({
            version: 1, auditId: active.auditId, capabilityId: active.capabilityId,
            sessionCapabilityId: active.sessionCapabilityId, windowId: active.windowId,
            evidenceUrl: { ...plan.evidenceUrl },
          });
          await writeConfirmed(
            sessionArea, urlRequestedEvidenceStorageKey(active.auditId), requestedEvidence,
            value => urlRequestedEvidenceRecord(value, active), 'URL_REQUESTED_EVIDENCE_DENIED',
          );
          const privacyGate = capturePolicy.mode === 'no-pixels' ? null : createPixelPrivacyGateV1({
            pixelState, consentId: null, authorityExpiresAt: correlation.expiresAt,
            commitClock: pixelCommitClock, async afterPixels() {},
          });
          const liveRecord = {
            active, controller, plan, requestedUrlEvidence: requestedEvidence.evidenceUrl,
            capturePolicy, privacyGate, consentId: null, grant: null, observedTarget: null,
            externallyInvalidated: false, liquidationReason: null, committed: null, completion: null,
            attemptHandle: null,
          };
          live.set(active.auditId, liveRecord);
          if (!await removeCorrelated(sessionArea, START_JOURNAL_KEY, journalRecord,
            current => current.auditId === active.auditId && current.capabilityId === active.capabilityId &&
              current.sessionCapabilityId === active.sessionCapabilityId && current.windowId === active.windowId)) {
            throw new Error('AUDIT_START_FAILED');
          }
          if (await scope.publishRegisteredBootstrap({
            auditId: args.auditId, sessionCapabilityId: claimed.sessionCapabilityId, windowId: context.windowId,
          }) !== true) throw new Error('AUDIT_START_FAILED');
          return { response: { ok: true, auditId: args.auditId, state: 'running' },
            sessionCapabilityId: claimed.sessionCapabilityId, liveRecord };
        });
      } catch (error) {
        if (plan.kind === 'attached-copy') {
          try {
            const active = await readActiveAuditJobForWorker({ sessionArea });
            const storedJournal = attachedCopyJournal(await readConfirmed(
              sessionArea,
              START_JOURNAL_KEY,
              journalRecord,
              'START_JOURNAL_DENIED',
            ));
            let recovered;
            if (active?.auditId === args.auditId && active.capabilityId === args.capabilityId &&
              active.mode === 'single') {
              if (storedJournal !== null) {
                if (storedJournal.state !== 'claimed' ||
                  storedJournal.sessionCapabilityId !== active.sessionCapabilityId ||
                  !sameAttachedCopyJournalIdentity(storedJournal, {
                    capabilityId: args.capabilityId,
                    auditId: args.auditId,
                    windowId: context.windowId,
                    ownershipId: plan.ownershipId,
                  }) || !await removeCorrelated(
                    sessionArea,
                    START_JOURNAL_KEY,
                    journalRecord,
                    current => same(current, storedJournal),
                  )) throw new Error('AUDIT_RECOVERY_REQUIRED');
              }
              recovered = await recoverSingleInterrupted(active);
            } else {
              if (active !== null || !storedJournal ||
                !sameAttachedCopyJournalIdentity(storedJournal, {
                  capabilityId: args.capabilityId,
                  auditId: args.auditId,
                  windowId: context.windowId,
                  ownershipId: plan.ownershipId,
                })) throw new Error('AUDIT_RECOVERY_REQUIRED');
              recovered = await recoverAttachedCopyStart(storedJournal);
            }
            if (recovered?.ok !== true || recovered.state !== 'interrupted' ||
              recovered.auditId !== args.auditId) throw new Error('AUDIT_RECOVERY_REQUIRED');
          } catch {
            return denied('AUDIT_RECOVERY_REQUIRED');
          }
          return denied(error === TARGET_UNAVAILABLE_SENTINEL ? 'TARGET_UNAVAILABLE' : 'AUDIT_START_FAILED');
        }
        try {
          if (await clearUrlAuditResources(urlCleanupRequest(
            args.auditId,
            plan.ownershipId,
            plan.navigationPurpose,
          )) !== true) {
            return denied('AUDIT_RECOVERY_REQUIRED');
          }
          if (claimed?.ok === true) {
            const active = await readActiveAuditJobForWorker({ sessionArea });
            if (active?.auditId === args.auditId) {
              await transitionConfirmed(active, 'revoked');
              await invalidateConfirmed(active);
              await removeCheckpoint({
                auditId: active.auditId, sessionCapabilityId: active.sessionCapabilityId, windowId: active.windowId,
              });
              await removeCorrelated(sessionArea, ACTIVE_AUDIT_JOB_KEY, activeRecord,
                current => current.auditId === active.auditId && current.sessionCapabilityId === active.sessionCapabilityId);
            } else await authority.invalidateCapability(args.capabilityId, 'AUDIT_START_COMPENSATED');
          } else if ((await authority.invalidateCapability(args.capabilityId, 'AUDIT_START_COMPENSATED'))?.ok !== true) {
            return denied('AUDIT_RECOVERY_REQUIRED');
          }
          if (journal) await removeCorrelated(sessionArea, START_JOURNAL_KEY, journalRecord,
            current => current.auditId === args.auditId && current.capabilityId === args.capabilityId);
        } catch { return denied('AUDIT_RECOVERY_REQUIRED'); }
        return denied(error === TARGET_UNAVAILABLE_SENTINEL ? 'TARGET_UNAVAILABLE' : 'AUDIT_START_FAILED');
      }
    };
    const setup = lockedAttachedCopy ? await prepareSetup() : await withGlobalLock(prepareSetup);
    if (setup.response.ok !== true) return setup;
    const completion = executeUrl(setup.liveRecord);
    setup.liveRecord.completion = completion;
    return freeze({ response: setup.response, sessionCapabilityId: setup.sessionCapabilityId, completion });
  }

  async function beginAuthorizedAudit(raw) {
    const args = exact(raw, BEGIN_KEYS);
    const capturePolicy = args && exactCapturePolicy(args.capturePolicy);
    const preference = args && retentionIntent(args.retentionPreference);
    const inversePair = args && ((args.eventNonce === null && args.senderContext !== null) ||
      (typeof args.eventNonce === 'string' && /^[A-Za-z0-9._:-]{20,240}$/u.test(args.eventNonce) && args.senderContext === null));
    if (!args || !CAPABILITY.test(args.capabilityId ?? '') || !AUDIT_ID.test(args.auditId ?? '') ||
      !capturePolicy || !preference || !inversePair) {
      return freeze({ response: { ok: false, code: 'AUDIT_START_FAILED' }, sessionCapabilityId: null, completion: null });
    }
    let target;
    try {
      target = inspectedTarget(await authority.inspectPreparedAuditTarget({
        capabilityId: args.capabilityId,
        allowedIntent: 'start-audit',
        eventNonce: args.eventNonce,
        senderContext: args.senderContext,
      }));
    } catch { target = null; }
    if (!target) {
      return freeze({ response: { ok: false, code: 'TARGET_UNAVAILABLE' }, sessionCapabilityId: null, completion: null });
    }

    let resolveStarted;
    let startedResolved = false;
    const started = new Promise(resolve => {
      resolveStarted = value => {
        if (!startedResolved) {
          startedResolved = true;
          resolve(value);
        }
      };
    });
    let resolveCompletion;
    const completion = new Promise(resolve => { resolveCompletion = resolve; });
    const targetOperation = targetQueue.withTarget(target, async lock => {
      const setup = await withGlobalLock(async () => {
        let fact = null;
        let journal = null;
        let claimed = null;
        try {
          let singletons;
          try { singletons = await currentSingletons(); } catch {
            return freeze({ response: { ok: false, code: 'AUDIT_RECOVERY_REQUIRED' }, sessionCapabilityId: null, completion: null });
          }
          if (singletons.active) return freeze({ response: { ok: false, code: 'AUDIT_BUSY' }, sessionCapabilityId: null, completion: null });
          if (singletons.journal) return freeze({ response: { ok: false, code: 'AUDIT_RECOVERY_REQUIRED' }, sessionCapabilityId: null, completion: null });
          const snapshot = await readAuditSnapshot({ auditId: args.auditId });
          if (!missingAuditSnapshot(snapshot) || await readReportRevision({ auditId: args.auditId }) !== null) {
            return freeze({ response: { ok: false, code: 'AUDIT_ID_COLLISION' }, sessionCapabilityId: null, completion: null });
          }
          try {
            fact = await readPreparedAttachedAuditFact({ sessionArea, capabilityId: args.capabilityId, epochNow });
          } catch { throw TARGET_UNAVAILABLE_SENTINEL; }
          if (fact.windowId !== target.windowId) throw TARGET_UNAVAILABLE_SENTINEL;
          return await panelCoordinator.withWindowLock(fact.windowId, async scope => {
            let confirmedFact;
            try {
              confirmedFact = await readPreparedAttachedAuditFact({ sessionArea, capabilityId: args.capabilityId, epochNow });
            } catch { throw TARGET_UNAVAILABLE_SENTINEL; }
            if (confirmedFact.windowId !== fact.windowId) throw TARGET_UNAVAILABLE_SENTINEL;
            let cleanup;
            try { cleanup = await cleanupBarrier.clearForAuditLocked({ target, lock }); }
            catch { cleanup = null; }
            if (cleanup?.ok !== true || cleanup.state !== 'clear') {
              const code = cleanup?.ok === false &&
                ['HIGHLIGHT_CLEANUP_UNCONFIRMED', 'PERSONA_CLEANUP_UNCONFIRMED'].includes(cleanup.code)
                ? cleanup.code : 'AUDIT_START_FAILED';
              return freeze({ response: { ok: false, code }, sessionCapabilityId: null, completion: null });
            }
            const createdAt = safeEpoch(epochNow);
            journal = freeze({
              version: 1, capabilityId: args.capabilityId, auditId: args.auditId, windowId: fact.windowId,
              state: 'prepared', sessionCapabilityId: null, createdAt, updatedAt: createdAt,
            });
            await writeConfirmed(sessionArea, START_JOURNAL_KEY, journal, journalRecord, 'START_JOURNAL_DENIED');
            try {
              claimed = args.eventNonce === null
                ? await authority.claimAndIssueAuditSession({
                    capabilityId: args.capabilityId, auditId: args.auditId, mode: 'attached',
                    allowedIntent: 'start-audit', senderContext: args.senderContext,
                  })
                : await authority.claimWorkerEventAndIssueAuditSession({
                    capabilityId: args.capabilityId, auditId: args.auditId, mode: 'attached',
                    allowedIntent: 'start-audit', eventNonce: args.eventNonce, senderContext: null,
                  });
            } catch { throw TARGET_UNAVAILABLE_SENTINEL; }
            if (claimed?.ok !== true || !CAPABILITY.test(claimed.sessionCapabilityId ?? '')) throw TARGET_UNAVAILABLE_SENTINEL;
            let grant;
            try {
              grant = await readClaimedAttachedAuditGrant({
                sessionArea, capabilityId: args.capabilityId, sessionCapabilityId: claimed.sessionCapabilityId,
                auditId: args.auditId, epochNow,
              });
            } catch { throw TARGET_UNAVAILABLE_SENTINEL; }
            if (grant.windowId !== fact.windowId || grant.target.tabId !== target.tabId ||
              grant.target.documentId !== target.documentId ||
              grant.target.initialUrlSessionDigest !== target.urlSessionDigest) throw TARGET_UNAVAILABLE_SENTINEL;
            // Provenance for the numbered in-page signals: tab, window, document and session
            // digest of the document this audit is bound to. The panel cannot resolve a target
            // from the audit id alone, and without a registered origin every marker request is
            // answered PAGE_MARKERS_UNAVAILABLE. Only the attached mode has a live page to mark.
            try {
              recordPageMarkerOrigin(Object.freeze({
                auditId: args.auditId, tabId: grant.target.tabId, windowId: grant.target.windowId,
                documentId: grant.target.documentId,
                urlSessionDigest: grant.target.initialUrlSessionDigest,
              }));
            } catch { /* losing optional provenance must not abort the audit */ }
            journal = freeze({ ...journal, state: 'claimed', sessionCapabilityId: claimed.sessionCapabilityId, updatedAt: safeEpoch(epochNow) });
            await writeConfirmed(sessionArea, START_JOURNAL_KEY, journal, journalRecord, 'START_JOURNAL_DENIED');
            const postGrant = safeEpoch(epochNow);
            if (postGrant < grant.issuedAt || postGrant >= grant.expiresAt) throw new Error('AUDIT_START_FAILED');
            const storedPreference = freeze({
              version: 1, auditId: args.auditId, deleteAfterCompleteExport: false,
              createdAt: postGrant, expiresAt: grant.expiresAt,
            });
            const preferenceParser = value => {
              const record = exact(value, ['version', 'auditId', 'deleteAfterCompleteExport', 'createdAt', 'expiresAt']);
              return record && same(record, storedPreference) ? freeze(record) : null;
            };
            await writeConfirmed(sessionArea, retentionPreferenceStorageKey(args.auditId), storedPreference, preferenceParser, 'RETENTION_PREFERENCE_DENIED');
            const bootstrapRegistered = await scope.registerPendingBootstrap({
              auditId: args.auditId, sessionCapabilityId: claimed.sessionCapabilityId,
              windowId: fact.windowId, captureMode: capturePolicy.mode,
              createdAt: postGrant, expiresAt: grant.expiresAt,
            });
            if (bootstrapRegistered !== true) throw new Error('AUDIT_START_FAILED');
            await persistExactLatest(latestState(args.auditId, 'running', modelNow));
            const controller = createAbortController();
            if (!controller || typeof controller.abort !== 'function' || !controller.signal) throw new Error('AUDIT_START_FAILED');
            const active = freeze({
              version: 1, auditId: args.auditId, capabilityId: args.capabilityId,
              sessionCapabilityId: claimed.sessionCapabilityId, windowId: fact.windowId, mode: 'attached',
              state: 'running', commitState: 'none', expectedTerminalRevision: null,
              createdAt: postGrant, updatedAt: postGrant,
            });
            await writeConfirmed(sessionArea, ACTIVE_AUDIT_JOB_KEY, active, activeRecord, 'ACTIVE_AUDIT_JOB_DENIED');
            // A tentativa DIRETA é preparada quando o portão ARMA sem pausa (página sem sinal sensível):
            // é o companheiro durável que a guarda D2 exige para gravar o raster. O registro `liveRecord`
            // só existe depois da criação do portão, então a ligação passa por esta variável.
            let liveRecord = null;
            const privacyGate = capturePolicy.mode === 'no-pixels' ? null : createPixelPrivacyGateV1({
              pixelState, consentId: null, authorityExpiresAt: grant.expiresAt,
              commitClock: pixelCommitClock, async afterPixels() {},
              // A página pode revelar sinal sensível DEPOIS de o portão armar: aí a captura pausa e a
              // tentativa direta precisa sair de cena ANTES de a consentida entrar (achado A-1).
              async onRetireDirect() {
                if (await pixelAttemptLifecycle.retireDirect(args.auditId) !== true) {
                  throw new Error('PIXEL_ATTEMPT_PREPARE_DENIED');
                }
                if (liveRecord) liveRecord.attemptHandle = null;
              },
              async onArmedDirect() {
                const attemptHandle = await pixelAttemptLifecycle.prepareDirect({
                  auditId: args.auditId, expiresAt: grant.expiresAt,
                });
                if (!attemptHandle || typeof attemptHandle !== 'object' ||
                  Reflect.ownKeys(attemptHandle).length !== 0 || !liveRecord) {
                  throw new Error('PIXEL_ATTEMPT_PREPARE_DENIED');
                }
                liveRecord.attemptHandle = attemptHandle;
              },
            });
            liveRecord = {
              active, controller, grant, capturePolicy, privacyGate, consentId: null, targetLock: lock,
              externallyInvalidated: false, liquidationReason: null,
              committed: null, completion: null, attemptHandle: null,
            };
            live.set(active.auditId, liveRecord);
            const removedJournal = await removeCorrelated(sessionArea, START_JOURNAL_KEY, journalRecord,
              current => current.auditId === active.auditId && current.capabilityId === active.capabilityId &&
                current.sessionCapabilityId === active.sessionCapabilityId && current.windowId === active.windowId);
            if (!removedJournal) throw new Error('AUDIT_START_FAILED');
            const bootstrapPublished = await scope.publishRegisteredBootstrap({
              auditId: args.auditId, sessionCapabilityId: claimed.sessionCapabilityId, windowId: fact.windowId,
            });
            if (bootstrapPublished !== true) throw new Error('AUDIT_START_FAILED');
            return {
              response: { ok: true, auditId: args.auditId, state: 'running' },
              sessionCapabilityId: claimed.sessionCapabilityId, liveRecord,
            };
          });
        } catch (error) {
          if (fact && journal) {
            const compensated = await compensateStart(fact, journal, claimed);
            if (!compensated) return freeze({ response: { ok: false, code: 'AUDIT_RECOVERY_REQUIRED' }, sessionCapabilityId: null, completion: null });
          }
          const code = error === TARGET_UNAVAILABLE_SENTINEL ? 'TARGET_UNAVAILABLE' : 'AUDIT_START_FAILED';
          return freeze({ response: { ok: false, code }, sessionCapabilityId: null, completion: null });
        }
      });
      if (setup.response.ok !== true) {
        resolveStarted(setup);
        return null;
      }
      const { liveRecord } = setup;
      liveRecord.completion = completion;
      resolveStarted(freeze({
        response: setup.response,
        sessionCapabilityId: setup.sessionCapabilityId,
        completion,
      }));
      try { return await execute(liveRecord); }
      catch { return completionRevoked(liveRecord.active.auditId, 'AUDIT_FAILED'); }
    });
    void targetOperation.then(resolveCompletion, () => {
      resolveStarted(freeze({ response: { ok: false, code: 'AUDIT_START_FAILED' }, sessionCapabilityId: null, completion: null }));
      resolveCompletion(completionRevoked(args.auditId, 'AUDIT_FAILED'));
    });
    return started;
  }

  async function resumePrivacyPausedAudit(raw) {
    const attachedArgs = exact(raw, ATTACHED_RESUME_KEYS);
    const singleArgs = attachedArgs ? null : exact(raw, SINGLE_RESUME_KEYS);
    const args = attachedArgs ?? singleArgs;
    const denied = () => freeze({
      response: { ok: false, code: 'AUDIT_RESUME_DENIED' }, sessionCapabilityId: null, completion: null,
    });
    if (!args || !AUDIT_ID.test(args.auditId ?? '') || !CAPABILITY.test(args.sessionCapabilityId ?? '') ||
      !Number.isSafeInteger(args.windowId) || args.windowId < 0 ||
      (attachedArgs && !/^[A-Za-z0-9_-]{21}[AQgw]$/u.test(attachedArgs.consentId ?? '')) ||
      !['full-evidence', 'element-only'].includes(args.mode)) return denied();

    let preliminaryActive;
    let preliminarySuspension;
    let consentId;
    try {
      preliminaryActive = await readActiveAuditJobForWorker({ sessionArea });
      if (!preliminaryActive || preliminaryActive.state !== 'privacy-paused' ||
        preliminaryActive.auditId !== args.auditId ||
        preliminaryActive.sessionCapabilityId !== args.sessionCapabilityId ||
        preliminaryActive.windowId !== args.windowId ||
        (preliminaryActive.mode === 'attached' ? !attachedArgs : !singleArgs)) return denied();
      const preliminary = await readCorrelatedPixelSuspension(preliminaryActive);
      preliminarySuspension = preliminary.suspension;
      consentId = attachedArgs?.consentId ?? preliminarySuspension?.consentId;
      const preliminaryTargetState = preliminaryActive.mode === 'single' ? 'retained-for-consent' : 'claimed';
      if (preliminary.sessionState !== 'privacy-paused' || preliminary.targetState !== preliminaryTargetState ||
        !preliminarySuspension || preliminarySuspension.state !== 'paused' ||
        !/^[A-Za-z0-9_-]{21}[AQgw]$/u.test(consentId ?? '') ||
        preliminarySuspension.consentId !== consentId ||
        preliminarySuspension.mode !== args.mode) return denied();
    } catch { return denied(); }

    const target = freeze({
      tabId: preliminarySuspension.tabId, windowId: preliminarySuspension.windowId,
      documentId: preliminarySuspension.documentId, urlSessionDigest: preliminarySuspension.urlSessionDigest,
    });
    let resolveStarted;
    let startedResolved = false;
    const started = new Promise(resolve => {
      resolveStarted = value => {
        if (!startedResolved) { startedResolved = true; resolve(value); }
      };
    });
    let resolveCompletion;
    const completion = new Promise(resolve => { resolveCompletion = resolve; });
    const targetOperation = targetQueue.withTarget(target, async lock => {
      const setup = await withGlobalLock(async () => {
        try {
          const active = await readActiveAuditJobForWorker({ sessionArea });
          if (!active || !same(active, preliminaryActive)) return denied();
          return panelCoordinator.withWindowLock(active.windowId, async scope => {
            const journal = await readConfirmed(sessionArea, START_JOURNAL_KEY, journalRecord, 'START_JOURNAL_DENIED');
            const checkpoint = await readPersistedCheckpoint(active);
            const requestedEvidence = active.mode === 'single' ? await readUrlRequestedEvidence(active) : null;
            const correlated = await readCorrelatedPixelSuspension(active);
            const { grant, suspension } = correlated;
            const capturePolicy = suspension?.capturePolicy ?? null;
            const expectedPausedTarget = active.mode === 'single' ? 'retained-for-consent' : 'claimed';
            if (correlated.sessionState !== 'privacy-paused' || correlated.targetState !== expectedPausedTarget ||
              journal !== null || !checkpoint || !grant || !suspension || suspension.state !== 'paused' ||
              (active.mode === 'single' && !requestedEvidence) ||
              suspension.consentId !== consentId || suspension.mode !== args.mode) return denied();
            const revokeAndLiquidate = async (reason, code) => {
              try {
                const currentSuspension = (await readCorrelatedPixelSuspension(active)).suspension;
                if (!currentSuspension || currentSuspension.consentId !== consentId ||
                  !['paused', 'resuming', 'revoked'].includes(currentSuspension.state)) {
                  return freeze({ response: { ok: false, code: 'AUDIT_RECOVERY_REQUIRED' }, sessionCapabilityId: null, completion: null });
                }
                if (currentSuspension.state !== 'revoked') {
                  await pixelState.revokeAudit({ auditId: active.auditId, consentId, reason });
                  await schedulePixelExpiryBestEffort();
                }
                const revoked = (await readCorrelatedPixelSuspension(active)).suspension;
                const controller = createAbortController();
                const liquidated = revoked?.consentId === consentId && revoked.state === 'revoked' &&
                  revoked.revokeReason === reason && controller?.signal &&
                  await liquidatePixelAuditLocked({
                    auditId: active.auditId, consentId, reason,
                    source: revoked.source, signal: controller.signal,
                  }, scope);
                return liquidated
                  ? freeze({ response: { ok: false, code }, sessionCapabilityId: null, completion: null })
                  : freeze({ response: { ok: false, code: 'AUDIT_RECOVERY_REQUIRED' }, sessionCapabilityId: null, completion: null });
              } catch {
                return freeze({ response: { ok: false, code: 'AUDIT_RECOVERY_REQUIRED' }, sessionCapabilityId: null, completion: null });
              }
            };
            const cleanup = await cleanupBarrier.clearForAuditLocked({ target, lock });
            if (cleanup?.ok !== true || cleanup.state !== 'clear') return denied();
            let proof = null;
            try { proof = inspectedTarget({ ok: true, target: await probeDocumentIdentity(target.tabId) }); }
            catch { /* document proof failure is terminal for this consent */ }
            if (!proof || !same(proof, target)) {
              return revokeAndLiquidate('PIXEL_CONSENT_DOCUMENT_CHANGED', 'PIXEL_CONSENT_DOCUMENT_CHANGED');
            }
            const signals = sensitiveSignals(await probeSensitiveCaptureSignals(target.tabId, target.documentId));
            if (!signals) return denied();
            try {
              const resumeProof = active.mode !== 'attached'
                ? {
                    kind: 'owned-disposable', ownershipId: suspension.source.ownershipId,
                    ...proof, cleanupMode: suspension.source.cleanupMode, pageId: suspension.source.pageId,
                  }
                : { kind: 'attached', ...proof };
              await pixelState.claimAndBeginResume({
                auditId: active.auditId, consentId,
                proof: resumeProof, mode: args.mode, categories: signals.categories,
              });
            } catch (error) {
              if (error?.message === 'PIXEL_CONSENT_EXPIRED') {
                return revokeAndLiquidate('PIXEL_CONSENT_EXPIRED', 'PIXEL_CONSENT_EXPIRED');
              }
              if (error?.message === 'PIXEL_CONSENT_DOCUMENT_CHANGED') {
                return revokeAndLiquidate('PIXEL_CONSENT_DOCUMENT_CHANGED', 'PIXEL_CONSENT_DOCUMENT_CHANGED');
              }
              if (error?.message !== 'PIXEL_CONSENT_SIGNALS_CHANGED') return denied();
              const replacement = (await readCorrelatedPixelSuspension(active)).suspension;
              if (!replacement || replacement.state !== 'paused' || replacement.consentId === consentId) return denied();
              await schedulePixelExpiryBestEffort();
              await persistExactLatest(latestState(active.auditId, 'PRIVACY_PAUSED', modelNow));
              if (await scope.publishPrivacyPaused({
                auditId: active.auditId, sessionCapabilityId: active.sessionCapabilityId,
                windowId: active.windowId,
              }) !== true) return denied();
              return freeze({
                response: { ok: true, auditId: active.auditId, state: 'privacy-paused' },
                sessionCapabilityId: active.sessionCapabilityId, completion: null,
              });
            }
            await schedulePixelExpiryBestEffort();
            if (active.mode === 'single') {
              const transitionedOwner = await authority.transitionDisposableAuditSession({
                sessionCapabilityId: active.sessionCapabilityId, auditId: active.auditId,
                ownershipId: suspension.source.ownershipId,
                fromState: 'retained-for-consent', toState: 'observing',
              });
              if (transitionedOwner?.ok !== true || transitionedOwner.state !== 'observing' ||
                transitionedOwner.ownershipId !== suspension.source.ownershipId) {
                return revokeAndLiquidate('PIXEL_RESUME_INTERRUPTED', 'AUDIT_RESUME_DENIED');
              }
            }
            await transitionConfirmed(active, 'running');
            await pixelState.markSessionRunning({ auditId: active.auditId, consentId });
            const attemptHandle = await pixelAttemptLifecycle.prepareResume({
              auditId: active.auditId, consentId,
              pageId: active.mode === 'attached' ? null : suspension.source.pageId,
              ownershipId: active.mode === 'attached' ? null : suspension.source.ownershipId,
              expiresAt: suspension.expiresAt,
            });
            if (!attemptHandle || typeof attemptHandle !== 'object' || Reflect.ownKeys(attemptHandle).length !== 0) {
              throw new Error('PIXEL_ATTEMPT_PREPARE_DENIED');
            }
            const running = freeze({ ...active, state: 'running', updatedAt: safeEpoch(epochNow) });
            await writeConfirmed(sessionArea, ACTIVE_AUDIT_JOB_KEY, running, activeRecord, 'ACTIVE_AUDIT_JOB_DENIED');
            let runningPublished = false;
            try {
              runningPublished = await scope.publishRunningResume({
                auditId: active.auditId, sessionCapabilityId: active.sessionCapabilityId,
                windowId: active.windowId,
              }) === true;
            } catch { /* compensate the durable resume below */ }
            if (!runningPublished) {
              return revokeAndLiquidate('PIXEL_RESUME_INTERRUPTED', 'AUDIT_RESUME_DENIED');
            }
            if (active.mode === 'batch') {
              const existing = live.get(active.auditId);
              const batchResumeTarget = freeze({
                ownershipId: suspension.source.ownershipId,
                cleanupMode: suspension.source.cleanupMode,
                pageId: suspension.source.pageId,
              });
              if (!hasBatchResume) {
                return revokeAndLiquidate('PIXEL_RESUME_INTERRUPTED', 'AUDIT_RESUME_DENIED');
              }
              if (!existing) {
                const controller = createAbortController();
                if (!controller?.signal || typeof controller.abort !== 'function') {
                  return revokeAndLiquidate('PIXEL_RESUME_INTERRUPTED', 'AUDIT_RESUME_DENIED');
                }
                const recoveredTarget = freeze({
                  version: 'ObservedTargetV1',
                  kind: 'owned-disposable',
                  ownershipId: suspension.source.ownershipId,
                  tabId: suspension.tabId,
                  windowId: suspension.windowId,
                  documentId: suspension.documentId,
                  urlEvidence: suspension.urlEvidence,
                  urlSessionDigest: suspension.urlSessionDigest,
                  cleanupMode: suspension.source.cleanupMode,
                  pageId: suspension.source.pageId,
                });
                const recovered = {
                  active: running,
                  controller,
                  plan: null,
                  capturePolicy,
                  privacyGate: null,
                  consentId,
                  grant: null,
                  observedTarget: null,
                  externallyInvalidated: false,
                  liquidationReason: null,
                  committed: null,
                  completion: null,
                  attemptHandle,
                  resumeTarget: batchResumeTarget,
                  pausedBatchPage: freeze({
                    childAuditId: null,
                    pageId: suspension.source.pageId,
                    ownershipId: suspension.source.ownershipId,
                  }),
                  batchRecovery: freeze({
                    consentId,
                    resumeTarget: recoveredTarget,
                    resumeCheckpoint: checkpoint.checkpoint,
                  }),
                };
                live.set(active.auditId, recovered);
                recovered.completion = executeBatch(recovered);
                return {
                  response: { ok: true, auditId: active.auditId, state: 'running' },
                  sessionCapabilityId: active.sessionCapabilityId,
                  liveRecord: recovered,
                  resumedBatch: true,
                };
              }
              if (existing.active.auditId !== active.auditId || existing.active.state !== 'privacy-paused' ||
                existing.completion === null) {
                return revokeAndLiquidate('PIXEL_RESUME_INTERRUPTED', 'AUDIT_RESUME_DENIED');
              }
              existing.active = running;
              existing.consentId = consentId;
              existing.attemptHandle = attemptHandle;
              existing.resumeTarget = batchResumeTarget;
              let resumed = false;
              try {
                resumed = await resumeBatchAuditExecution({
                  auditId: active.auditId,
                  pageId: suspension.source.pageId,
                  ownershipId: suspension.source.ownershipId,
                  consentId,
                }) === true;
              } catch { resumed = false; }
              if (!resumed) return revokeAndLiquidate('PIXEL_RESUME_INTERRUPTED', 'AUDIT_RESUME_DENIED');
              return {
                response: { ok: true, auditId: active.auditId, state: 'running' },
                sessionCapabilityId: active.sessionCapabilityId,
                liveRecord: existing,
                resumedBatch: true,
              };
            }
            const privacyGate = createPixelPrivacyGateV1({
              pixelState, consentId,
              authorityExpiresAt: suspension.expiresAt,
              commitClock: pixelCommitClock, async afterPixels() {},
            });
            const controller = createAbortController();
            const resumeTarget = active.mode === 'single' ? freeze({
              kind: 'owned-disposable-resume', ownershipId: suspension.source.ownershipId,
              tabId: suspension.tabId, windowId: suspension.windowId, documentId: suspension.documentId,
              initialUrlEvidence: suspension.urlEvidence,
              initialUrlSessionDigest: suspension.urlSessionDigest,
              navigationPurpose: grant.navigationPurpose,
              cleanupMode: suspension.source.cleanupMode, pageId: suspension.source.pageId,
            }) : null;
            const liveRecord = {
              active: running, controller, grant, capturePolicy, privacyGate,
              resumeCheckpoint: checkpoint.checkpoint,
              ...(resumeTarget ? { plan: null, resumeTarget, observedTarget: null } : {}),
              ...(resumeTarget ? { requestedUrlEvidence: requestedEvidence.evidenceUrl } : {}),
              consentId, targetLock: lock,
              externallyInvalidated: false, liquidationReason: null,
              committed: null, completion, attemptHandle,
            };
            live.set(active.auditId, liveRecord);
            return {
              response: { ok: true, auditId: active.auditId, state: 'running' },
              sessionCapabilityId: active.sessionCapabilityId, liveRecord,
            };
          });
        } catch { return denied(); }
      });
      if (setup.response.ok !== true || !setup.liveRecord) {
        resolveStarted(setup);
        return setup.completion === null && setup.response.state === 'privacy-paused'
          ? freeze({ ok: true, auditId: args.auditId, state: 'privacy-paused', revision: null })
          : completionRevoked(args.auditId, 'AUDIT_FAILED');
      }
      resolveStarted(freeze({
        response: setup.response, sessionCapabilityId: setup.sessionCapabilityId, completion,
      }));
      if (setup.resumedBatch === true) return setup.liveRecord.completion;
      return setup.liveRecord.active.mode === 'single'
        ? executeUrl(setup.liveRecord)
        : execute(setup.liveRecord);
    });
    void targetOperation.then(resolveCompletion, () => {
      resolveStarted(denied());
      resolveCompletion(completionRevoked(args.auditId, 'AUDIT_FAILED'));
    });
    return started;
  }

  async function abortAuthorizedAudit(raw) {
    const args = exact(raw, ['auditId', 'sessionCapabilityId', 'windowId', 'reasonCode']);
    if (!args || !AUDIT_ID.test(args.auditId ?? '') || !CAPABILITY.test(args.sessionCapabilityId ?? '') ||
      !Number.isSafeInteger(args.windowId) || args.windowId < 0 || args.reasonCode !== 'USER_CANCELLED') {
      return freeze({ ok: false, code: 'AUDIT_CANCEL_DENIED' });
    }
    return withGlobalLock(async () => {
      let active;
      try { active = await readActiveAuditJobForWorker({ sessionArea }); } catch { return freeze({ ok: false, code: 'AUDIT_CANCEL_DENIED' }); }
      if (!active || active.auditId !== args.auditId || active.sessionCapabilityId !== args.sessionCapabilityId ||
        active.windowId !== args.windowId) return freeze({ ok: false, code: 'AUDIT_CANCEL_DENIED' });
      if (active.state === 'finalizing') return freeze({ ok: false, code: 'AUDIT_CANCEL_TOO_LATE' });
      if (active.state === 'privacy-paused') {
        try {
          const journal = await readConfirmed(sessionArea, START_JOURNAL_KEY, journalRecord, 'START_JOURNAL_DENIED');
          const checkpoint = await readPersistedCheckpoint(active);
          const correlated = await readCorrelatedPixelSuspension(active);
          const suspension = correlated.suspension;
          const expectedTargetState = active.mode === 'single' ? 'retained-for-consent' : 'claimed';
          if (correlated.sessionState !== 'privacy-paused' || correlated.targetState !== expectedTargetState ||
            journal !== null || !checkpoint || !suspension || suspension.state !== 'paused') {
            return freeze({ ok: false, code: 'AUDIT_CANCEL_DENIED' });
          }
          await pixelState.revokeAudit({
            auditId: active.auditId, consentId: suspension.consentId, reason: 'AUDIT_CANCELLED',
          });
          await schedulePixelExpiryBestEffort();
          const revokedSuspension = (await readCorrelatedPixelSuspension(active)).suspension;
          if (!revokedSuspension || revokedSuspension.consentId !== suspension.consentId ||
            revokedSuspension.state !== 'revoked' ||
            !await liquidatePixelAuditLocked({
              auditId: active.auditId, consentId: suspension.consentId, reason: 'AUDIT_CANCELLED',
              source: suspension.source, signal: new AbortController().signal,
            })) throw new Error('AUDIT_CANCEL_DENIED');
          return freeze({ ok: true, auditId: active.auditId, state: 'revoked' });
        } catch { return freeze({ ok: false, code: 'AUDIT_CANCEL_DENIED' }); }
      }
      const record = live.get(active.auditId);
      if (!record) return freeze({ ok: false, code: 'AUDIT_CANCEL_DENIED' });
      record.liquidationReason = 'AUDIT_CANCELLED';
      record.controller.abort(new DOMException('Operação cancelada.', 'AbortError'));
      return freeze({ ok: true, auditId: active.auditId, state: 'cancelling' });
    });
  }

  async function abortAttachedAuditForTarget(raw) {
    const args = exact(raw, ['tabId', 'windowId', 'reasonCode']);
    const tab = args && args.windowId === null && Number.isSafeInteger(args.tabId) && args.tabId >= 0;
    const window = args && args.tabId === null && Number.isSafeInteger(args.windowId) && args.windowId >= 0;
    if (!args || (!tab && !window) || !TARGET_REASONS.has(args.reasonCode)) return freeze({ aborted: false, auditId: null });
    let waitFor = null;
    const answer = await withGlobalLock(async () => {
      let active;
      try { active = await readActiveAuditJobForWorker({ sessionArea }); } catch { return freeze({ aborted: false, auditId: null }); }
      if (!active) return freeze({ aborted: false, auditId: null });
      const record = live.get(active.auditId);
      if (active.mode === 'batch') {
        if (!window || active.windowId !== args.windowId || active.state === 'finalizing' || !record) {
          return freeze({ aborted: false, auditId: active.state === 'finalizing' ? active.auditId : null });
        }
        record.externallyInvalidated = true;
        record.liquidationReason = 'SESSION_ENDED';
        record.controller.abort(new DOMException('Operação interrompida.', 'AbortError'));
        return freeze({ aborted: true, auditId: active.auditId });
      }
      if (!record && ['running', 'privacy-paused'].includes(active.state)) {
        try {
          const verified = (await readCorrelatedPixelSuspension(active)).suspension;
          const matchesSuspension = verified &&
            (window ? verified.windowId === args.windowId : verified.tabId === args.tabId);
          if (matchesSuspension && ['paused', 'resuming', 'revoked'].includes(verified.state)) {
            const reason = ['TAB_LOADING', 'TAB_URL_CHANGED', 'TAB_PENDING_URL'].includes(args.reasonCode)
              ? 'PIXEL_CONSENT_DOCUMENT_CHANGED' : 'SESSION_ENDED';
            if (verified.state !== 'revoked') {
              await pixelState.revokeAudit({
                auditId: active.auditId, consentId: verified.consentId, reason,
              });
              await schedulePixelExpiryBestEffort();
            }
            const liquidated = await liquidatePixelAuditLocked({
              auditId: active.auditId, consentId: verified.consentId, reason,
              source: verified.source, signal: new AbortController().signal,
            });
            return freeze({ handled: true, liquidated, aborted: liquidated, auditId: active.auditId });
          }
        } catch {
          return freeze({ handled: true, liquidated: false, aborted: false, auditId: active.auditId });
        }
      }
      const matches = window ? active.windowId === args.windowId : record?.grant?.target?.tabId === args.tabId;
      if (!matches) return freeze({ aborted: false, auditId: null });
      try {
        const correlation = await readAttachedAuditCorrelationForRecovery({
          sessionArea, capabilityId: active.capabilityId, auditId: active.auditId,
        });
        if (correlation.windowId !== active.windowId || correlation.sessionCapabilityId !== active.sessionCapabilityId) {
          return freeze({ aborted: false, auditId: null });
        }
      } catch { return freeze({ aborted: false, auditId: null }); }
      if (active.state === 'finalizing') {
        waitFor = recoverAuthorizedAuditLifecycle();
        return freeze({ aborted: false, auditId: active.auditId });
      }
      if (!record) return freeze({ aborted: false, auditId: null });
      record.externallyInvalidated = true;
      record.liquidationReason = ['TAB_LOADING', 'TAB_URL_CHANGED', 'TAB_PENDING_URL'].includes(args.reasonCode)
        ? 'PIXEL_CONSENT_DOCUMENT_CHANGED' : 'SESSION_ENDED';
      record.controller.abort(new DOMException('Operação interrompida.', 'AbortError'));
      return freeze({ aborted: true, auditId: active.auditId });
    });
    if (waitFor) await waitFor;
    return answer;
  }

  async function recoverInterrupted(active) {
    const journal = await readConfirmed(sessionArea, START_JOURNAL_KEY, journalRecord, 'START_JOURNAL_DENIED');
    if (journal !== null) throw new Error('AUDIT_RECOVERY_REQUIRED');
    const correlated = await readCorrelatedPixelSuspension(active);
    const recoverable = correlated.suspension;
    if (recoverable) {
      if (recoverable.state === 'paused') {
        const checkpoint = await readPersistedCheckpoint(active);
        const recoverableTargetStates = active.mode === 'single'
          ? ['pending', 'observing', 'retained-for-consent'] : ['claimed'];
        if (active.state !== 'running' || !['running', 'privacy-paused'].includes(correlated.sessionState) ||
          !recoverableTargetStates.includes(correlated.targetState) || !checkpoint) {
          throw new Error('AUDIT_RECOVERY_REQUIRED');
        }
        let advancedTarget = correlated;
        if (active.mode === 'single' && advancedTarget.targetState === 'pending') {
          const observing = await authority.transitionDisposableAuditSession({
            sessionCapabilityId: active.sessionCapabilityId, auditId: active.auditId,
            ownershipId: recoverable.source.ownershipId, fromState: 'pending', toState: 'observing',
          });
          if (observing?.ok !== true || observing.state !== 'observing' ||
            observing.ownershipId !== recoverable.source.ownershipId) throw new Error('AUDIT_RECOVERY_REQUIRED');
          advancedTarget = await readCorrelatedPixelSuspension(active);
        }
        if (active.mode === 'single' && advancedTarget.targetState === 'observing') {
          const retained = await authority.transitionDisposableAuditSession({
            sessionCapabilityId: active.sessionCapabilityId, auditId: active.auditId,
            ownershipId: recoverable.source.ownershipId,
            fromState: 'observing', toState: 'retained-for-consent',
          });
          if (retained?.ok !== true || retained.state !== 'retained-for-consent' ||
            retained.ownershipId !== recoverable.source.ownershipId) throw new Error('AUDIT_RECOVERY_REQUIRED');
          advancedTarget = await readCorrelatedPixelSuspension(active);
        }
        const expectedTargetState = active.mode === 'single' ? 'retained-for-consent' : 'claimed';
        if (advancedTarget.targetState !== expectedTargetState || !advancedTarget.suspension ||
          !same(advancedTarget.suspension, recoverable)) throw new Error('AUDIT_RECOVERY_REQUIRED');
        if (advancedTarget.sessionState === 'running') await transitionConfirmed(active, 'privacy-paused');
        const advanced = await readCorrelatedPixelSuspension(active);
        const advancedCheckpoint = await readPersistedCheckpoint(active);
        if (advanced.sessionState !== 'privacy-paused' || advanced.targetState !== expectedTargetState ||
          !advanced.suspension || !same(advanced.suspension, recoverable) ||
          !advancedCheckpoint || !same(advancedCheckpoint, checkpoint)) throw new Error('AUDIT_RECOVERY_REQUIRED');
        const durableActive = await readActiveAuditJobForWorker({ sessionArea });
        if (!durableActive || !same(durableActive, active)) throw new Error('AUDIT_RECOVERY_REQUIRED');
        const paused = freeze({ ...active, state: 'privacy-paused', updatedAt: safeEpoch(epochNow) });
        await writeConfirmed(sessionArea, ACTIVE_AUDIT_JOB_KEY, paused, activeRecord, 'ACTIVE_AUDIT_JOB_DENIED');
        return recoverPrivacyPaused(paused);
      }
      if (!['resuming', 'revoked'].includes(recoverable.state)) throw new Error('AUDIT_RECOVERY_REQUIRED');
      let suspension = recoverable;
      const reason = recoverable.state === 'revoked' && PIXEL_LIQUIDATION_REASONS.has(recoverable.revokeReason)
        ? suspension.revokeReason : 'PIXEL_RESUME_INTERRUPTED';
      if (recoverable.state !== 'revoked') {
        await pixelState.revokeAudit({ auditId: active.auditId, consentId: recoverable.consentId, reason });
        await schedulePixelExpiryBestEffort();
        suspension = (await readCorrelatedPixelSuspension(active)).suspension;
      }
      const controller = createAbortController();
      if (!suspension || suspension.consentId !== recoverable.consentId ||
        suspension.state !== 'revoked' || suspension.revokeReason !== reason ||
        !controller?.signal || !await liquidatePixelAuditLocked({
          auditId: active.auditId, consentId: recoverable.consentId, reason,
          source: suspension.source, signal: controller.signal,
        })) throw new Error('AUDIT_RECOVERY_REQUIRED');
      return freeze({ ok: true, state: 'interrupted', auditId: active.auditId, revision: null });
    }
    const attempt = exact(await pixelAttemptLifecycle.classify({
      auditId: active.auditId, consentId: null,
    }), ['state', 'handle']);
    if (!attempt || attempt.state !== 'absent' || attempt.handle !== null) throw new Error('AUDIT_RECOVERY_REQUIRED');
    const latest = await readLatest();
    const latestAuditId = latest === null || latest === undefined ? null : supportedLatestAuditId(latest);
    if (latest !== null && latest !== undefined && latestAuditId === null) throw new Error('AUDIT_RECOVERY_REQUIRED');
    if (latestAuditId === null || latestAuditId === active.auditId) {
      await persistExactLatest(latestState(active.auditId, 'AUDIT_INTERRUPTED', modelNow));
    }
    const session = await readAuditSessionForWorker({
      sessionArea, sessionCapabilityId: active.sessionCapabilityId, auditId: active.auditId,
    });
    if (session.state === 'running') await transitionConfirmed(active, 'revoked');
    else if (session.state !== 'revoked') throw new Error('AUDIT_RECOVERY_REQUIRED');
    if (await invalidateConfirmed(active) !== true) throw new Error('AUDIT_RECOVERY_REQUIRED');
    const disconnected = await panelCoordinator.withWindowLock(active.windowId, scope => scope.disconnectSession({
      auditId: active.auditId, sessionCapabilityId: active.sessionCapabilityId,
      windowId: active.windowId, reasonCode: 'AUDIT_INTERRUPTED',
    }));
    if (disconnected !== true) throw new Error('AUDIT_RECOVERY_REQUIRED');
    await cleanupActive(active, { removeRetention: true });
    return freeze({ ok: true, state: 'interrupted', auditId: active.auditId, revision: null });
  }

  async function recoverSingleInterrupted(active) {
    const journal = await readConfirmed(sessionArea, START_JOURNAL_KEY, journalRecord, 'START_JOURNAL_DENIED');
    if (journal !== null) throw new Error('AUDIT_RECOVERY_REQUIRED');
    let correlation = await readNavigationAuditCorrelationForRecovery({
      sessionArea, capabilityId: active.capabilityId, auditId: active.auditId,
    });
    const validRecoveryState =
      (correlation.capabilityState === 'claimed' && ['running', 'revoked'].includes(correlation.sessionState)) ||
      (correlation.capabilityState === 'invalidated' && correlation.sessionState === 'revoked');
    if (correlation.sessionCapabilityId !== active.sessionCapabilityId || correlation.windowId !== active.windowId ||
      !validRecoveryState) {
      throw new Error('AUDIT_RECOVERY_REQUIRED');
    }
    if (await clearUrlAuditResources(urlCleanupRequest(
      active.auditId,
      correlation.ownershipId,
      correlation.navigationPurpose,
    )) !== true) throw new Error('AUDIT_RECOVERY_REQUIRED');
    if (correlation.ownershipState !== 'removed') {
      const removed = await authority.transitionDisposableAuditSession({
        sessionCapabilityId: active.sessionCapabilityId,
        auditId: active.auditId,
        ownershipId: correlation.ownershipId,
        fromState: correlation.ownershipState,
        toState: 'removed',
      });
      if (removed?.ok !== true || removed.state !== 'removed' || removed.ownershipId !== correlation.ownershipId) {
        throw new Error('AUDIT_RECOVERY_REQUIRED');
      }
    }
    correlation = await readNavigationAuditCorrelationForRecovery({
      sessionArea, capabilityId: active.capabilityId, auditId: active.auditId,
    });
    if (correlation.ownershipState !== 'removed') throw new Error('AUDIT_RECOVERY_REQUIRED');
    const latest = await readLatest();
    const latestAuditId = latest === null || latest === undefined ? null : supportedLatestAuditId(latest);
    if (latest !== null && latest !== undefined && latestAuditId === null) throw new Error('AUDIT_RECOVERY_REQUIRED');
    if (latestAuditId === null || latestAuditId === active.auditId) {
      await persistExactLatest(latestState(active.auditId, 'AUDIT_INTERRUPTED', modelNow));
    }
    if (correlation.sessionState === 'running') await transitionConfirmed(active, 'revoked');
    if (await invalidateConfirmed(active) !== true) throw new Error('AUDIT_RECOVERY_REQUIRED');
    const disconnected = await panelCoordinator.withWindowLock(active.windowId, scope => scope.disconnectSession({
      auditId: active.auditId, sessionCapabilityId: active.sessionCapabilityId,
      windowId: active.windowId, reasonCode: 'AUDIT_INTERRUPTED',
    }));
    if (disconnected !== true) throw new Error('AUDIT_RECOVERY_REQUIRED');
    await cleanupActive(active, { removeRetention: true });
    return freeze({ ok: true, state: 'interrupted', auditId: active.auditId, revision: null });
  }

  async function recoverSingleFinalizing(active) {
    const report = await readReportRevision({ auditId: active.auditId });
    if (report === null) return recoverSingleInterrupted(active);
    const correlation = await readNavigationAuditCorrelationForRecovery({
      sessionArea, capabilityId: active.capabilityId, auditId: active.auditId,
    });
    const expectedOwnershipState = correlation.navigationPurpose === 'attached-copy'
      ? 'removed'
      : 'retained-for-review';
    const expectedCleanupMode = correlation.navigationPurpose === 'attached-copy'
      ? 'always'
      : 'pre-observation-failure';
    if (correlation.sessionCapabilityId !== active.sessionCapabilityId || correlation.windowId !== active.windowId ||
      correlation.capabilityState !== 'claimed' || !['running', 'result'].includes(correlation.sessionState) ||
      correlation.ownershipState !== expectedOwnershipState) throw new Error('AUDIT_RECOVERY_REQUIRED');
    const attemptSource = freeze({
      kind: 'owned-disposable', ownershipId: correlation.ownershipId,
      cleanupMode: expectedCleanupMode, pageId: 'page-1',
    });
    let attempt = exact(await pixelAttemptLifecycle.classify(pixelAttemptRequest(
      active.auditId, null, attemptSource,
    )), ['state', 'handle']);
    if (attempt?.state === 'blocked' && active.commitState === 'confirmed' &&
      await pixelAttemptLifecycle.cleanup(pixelAttemptRequest(
        active.auditId, null, attemptSource, { expected: 'post-finish' },
      ))) {
      attempt = exact(await pixelAttemptLifecycle.classify(pixelAttemptRequest(
        active.auditId, null, attemptSource,
      )), ['state', 'handle']);
    }
    if (!attempt || attempt.handle !== null || !['absent', 'terminal'].includes(attempt.state)) {
      throw new Error('AUDIT_RECOVERY_REQUIRED');
    }
    const candidate = await terminalCandidate({
      auditId: active.auditId, model: report.model, checkpoint: report.checkpoint,
    });
    if (candidate.modelRevision !== active.expectedTerminalRevision || candidate.modelHash !== report.modelHash ||
      report.modelRevision !== active.expectedTerminalRevision) return recoverSingleInterrupted(active);
    const bundle = copyPanelResultBundleV1(await buildPanelResultBundle({ reportRevision: report }));
    const latest = await readLatest();
    const latestAuditId = latest === null || latest === undefined ? null : supportedLatestAuditId(latest);
    if (latest !== null && latest !== undefined && latestAuditId === null) throw new Error('AUDIT_RECOVERY_REQUIRED');
    if (latestAuditId === null || latestAuditId === active.auditId) {
      await persistExactLatest(latestState(active.auditId, candidate.model.session.status, modelNow));
    }
    if (correlation.sessionState === 'running') await transitionConfirmed(active, 'result');
    const published = await panelCoordinator.withWindowLock(active.windowId, scope => scope.publishResult({
      auditId: active.auditId, sessionCapabilityId: active.sessionCapabilityId,
      windowId: active.windowId, state: 'result', resultBundle: bundle,
    }));
    if (!acceptedTerminalDelivery(published)) throw new Error('AUDIT_RECOVERY_REQUIRED');
    if (!await pixelAttemptLifecycle.cleanup(pixelAttemptRequest(
      active.auditId, null, attemptSource, { expected: 'post-finish' },
    ))) throw new Error('AUDIT_RECOVERY_REQUIRED');
    await cleanupActive(active);
    return freeze({ ok: true, state: 'reconciled', auditId: active.auditId, revision: 1 });
  }

  function batchCleanupRequest(active) {
    return freeze({
      auditId: active.auditId,
      capabilityId: active.capabilityId,
      sessionCapabilityId: active.sessionCapabilityId,
      windowId: active.windowId,
    });
  }

  async function recoverBatchInterrupted(active, retainedJournal = null) {
    const journal = await readConfirmed(sessionArea, START_JOURNAL_KEY, journalRecord, 'START_JOURNAL_DENIED');
    if (retainedJournal === null ? journal !== null : !journal || !same(journal, retainedJournal)) {
      throw new Error('AUDIT_RECOVERY_REQUIRED');
    }
    let correlation = await readBatchAuditCorrelationForRecovery({
      sessionArea, capabilityId: active.capabilityId, auditId: active.auditId,
    });
    if (correlation.sessionCapabilityId !== active.sessionCapabilityId ||
      correlation.windowId !== active.windowId || !['claimed', 'invalidated'].includes(correlation.capabilityState) ||
      !['running', 'revoked'].includes(correlation.sessionState)) throw new Error('AUDIT_RECOVERY_REQUIRED');
    if (await clearBatchAuditResources(batchCleanupRequest(active)) !== true) {
      throw new Error('AUDIT_RECOVERY_REQUIRED');
    }
    correlation = await readBatchAuditCorrelationForRecovery({
      sessionArea, capabilityId: active.capabilityId, auditId: active.auditId,
    });
    if (correlation.activePageId !== null || correlation.activeOwnershipId !== null) {
      throw new Error('AUDIT_RECOVERY_REQUIRED');
    }
    const latest = await readLatest();
    const latestAuditId = latest === null || latest === undefined ? null : supportedLatestAuditId(latest);
    if (latest !== null && latest !== undefined && latestAuditId === null) throw new Error('AUDIT_RECOVERY_REQUIRED');
    if (latestAuditId === null || latestAuditId === active.auditId) {
      await persistExactLatest(latestState(active.auditId, 'AUDIT_INTERRUPTED', modelNow));
    }
    if (correlation.sessionState === 'running') await transitionConfirmed(active, 'revoked');
    else if (correlation.sessionState !== 'revoked') throw new Error('AUDIT_RECOVERY_REQUIRED');
    if (await invalidateConfirmed(active) !== true) throw new Error('AUDIT_RECOVERY_REQUIRED');
    const disconnected = await panelCoordinator.withWindowLock(active.windowId, scope => scope.disconnectSession({
      auditId: active.auditId, sessionCapabilityId: active.sessionCapabilityId,
      windowId: active.windowId, reasonCode: 'AUDIT_INTERRUPTED',
    }));
    if (disconnected !== true) throw new Error('AUDIT_RECOVERY_REQUIRED');
    await discardTerminalBatchProgress(active);
    await cleanupActive(active, { removeRetention: true });
    return freeze({ ok: true, state: 'interrupted', auditId: active.auditId, revision: null });
  }

  async function recoverBatchFinalizing(active) {
    const report = await readReportRevision({ auditId: active.auditId });
    if (report === null) return recoverBatchInterrupted(active);
    const journal = await readConfirmed(sessionArea, START_JOURNAL_KEY, journalRecord, 'START_JOURNAL_DENIED');
    if (journal !== null || await clearBatchAuditResources(batchCleanupRequest(active)) !== true) {
      throw new Error('AUDIT_RECOVERY_REQUIRED');
    }
    const correlation = await readBatchAuditCorrelationForRecovery({
      sessionArea, capabilityId: active.capabilityId, auditId: active.auditId,
    });
    if (correlation.sessionCapabilityId !== active.sessionCapabilityId || correlation.windowId !== active.windowId ||
      correlation.activePageId !== null || correlation.activeOwnershipId !== null ||
      correlation.capabilityState !== 'claimed' || !['running', 'result'].includes(correlation.sessionState)) {
      throw new Error('AUDIT_RECOVERY_REQUIRED');
    }
    const candidate = await terminalCandidate({
      auditId: active.auditId, model: report.model, checkpoint: report.checkpoint,
    });
    if (candidate.modelRevision !== active.expectedTerminalRevision || candidate.modelHash !== report.modelHash ||
      report.modelRevision !== active.expectedTerminalRevision || candidate.model.requestedScope?.mode !== 'batch') {
      return recoverBatchInterrupted(active);
    }
    const bundle = copyPanelResultBundleV1(await buildPanelResultBundle({ reportRevision: report }));
    const latest = await readLatest();
    const latestAuditId = latest === null || latest === undefined ? null : supportedLatestAuditId(latest);
    if (latest !== null && latest !== undefined && latestAuditId === null) throw new Error('AUDIT_RECOVERY_REQUIRED');
    if (latestAuditId === null || latestAuditId === active.auditId) {
      await persistExactLatest(latestState(active.auditId, candidate.model.session.status, modelNow));
    }
    if (correlation.sessionState === 'running') await transitionConfirmed(active, 'result');
    const published = await panelCoordinator.withWindowLock(active.windowId, scope => scope.publishResult({
      auditId: active.auditId, sessionCapabilityId: active.sessionCapabilityId,
      windowId: active.windowId, state: 'result', resultBundle: bundle,
    }));
    if (!acceptedTerminalDelivery(published)) throw new Error('AUDIT_RECOVERY_REQUIRED');
    if (!await pixelAttemptLifecycle.cleanup({
      auditId: active.auditId, consentId: null, expected: 'post-finish',
    })) throw new Error('AUDIT_RECOVERY_REQUIRED');
    if (await clearBatchAuditProgress({ auditId: active.auditId }) !== true) {
      throw new Error('AUDIT_RECOVERY_REQUIRED');
    }
    await cleanupActive(active);
    return freeze({ ok: true, state: 'reconciled', auditId: active.auditId, revision: 1 });
  }

  async function recoverBatchStart(journal) {
    if (!hasBatchAudit) throw new Error('AUDIT_RECOVERY_REQUIRED');
    if (journal.state === 'prepared') {
      if (journal.sessionCapabilityId !== null || await clearBatchAuditResources(freeze({
        auditId: journal.auditId, capabilityId: journal.capabilityId,
        sessionCapabilityId: null, windowId: journal.windowId,
      })) !== true) throw new Error('AUDIT_RECOVERY_REQUIRED');
      const invalidated = await authority.invalidateCapability(journal.capabilityId, 'AUDIT_START_COMPENSATED');
      if (invalidated?.ok !== true) throw new Error('AUDIT_RECOVERY_REQUIRED');
      const checkpoint = exact(await removeCheckpoint({
        auditId: journal.auditId, sessionCapabilityId: null, windowId: null,
      }), ['removed']);
      if (!checkpoint || typeof checkpoint.removed !== 'boolean' ||
        !await removePreference({ auditId: journal.auditId }) ||
        !await removeCorrelated(sessionArea, START_JOURNAL_KEY, journalRecord,
          current => same(current, journal))) throw new Error('AUDIT_RECOVERY_REQUIRED');
      return freeze({ ok: true, state: 'interrupted', auditId: journal.auditId, revision: null });
    }
    if (journal.state !== 'claimed' || !CAPABILITY.test(journal.sessionCapabilityId ?? '')) {
      throw new Error('AUDIT_RECOVERY_REQUIRED');
    }
    const correlation = await readBatchAuditCorrelationForRecovery({
      sessionArea, capabilityId: journal.capabilityId, auditId: journal.auditId,
    });
    if (correlation.sessionCapabilityId !== journal.sessionCapabilityId ||
      correlation.windowId !== journal.windowId) throw new Error('AUDIT_RECOVERY_REQUIRED');
    return recoverBatchInterrupted(freeze({
      version: 1, auditId: journal.auditId, capabilityId: journal.capabilityId,
      sessionCapabilityId: journal.sessionCapabilityId, windowId: journal.windowId, mode: 'batch',
      state: 'running', commitState: 'none', expectedTerminalRevision: null,
      createdAt: journal.createdAt, updatedAt: journal.updatedAt,
    }), journal);
  }

  async function recoverPrivacyPaused(active) {
    const journal = await readConfirmed(sessionArea, START_JOURNAL_KEY, journalRecord, 'START_JOURNAL_DENIED');
    const checkpoint = await readPersistedCheckpoint(active);
    const correlated = await readCorrelatedPixelSuspension(active);
    const suspension = correlated.suspension;
    if (active.mode === 'batch' && correlated.sessionState === 'revoked' && suspension?.state === 'revoked') {
      return recoverInterrupted(active);
    }
    const expectedTargetState = active.mode === 'single' ? 'retained-for-consent' : 'claimed';
    if (correlated.sessionState !== 'privacy-paused' || correlated.targetState !== expectedTargetState ||
      journal !== null || !checkpoint || !suspension || suspension.state !== 'paused') {
      throw new Error('AUDIT_RECOVERY_REQUIRED');
    }
    const latest = await readLatest();
    const latestAuditId = latest === null || latest === undefined ? null : supportedLatestAuditId(latest);
    if (latest !== null && latest !== undefined && latestAuditId === null) throw new Error('AUDIT_RECOVERY_REQUIRED');
    if (latestAuditId === null || latestAuditId === active.auditId) {
      await persistExactLatest(latestState(active.auditId, 'PRIVACY_PAUSED', modelNow));
    }
    const published = await panelCoordinator.withWindowLock(active.windowId, scope => scope.publishPrivacyPaused({
      auditId: active.auditId, sessionCapabilityId: active.sessionCapabilityId,
      windowId: active.windowId,
    }));
    if (published !== true) throw new Error('AUDIT_RECOVERY_REQUIRED');
    return freeze({ ok: true, state: 'privacy-paused', auditId: active.auditId, revision: null });
  }

  async function recoverFinalizing(active, journal = null, lockedScope = null) {
    const report = await readReportRevision({ auditId: active.auditId });
    if (report === null) return recoverInterrupted(active);
    if (journal !== null) throw new Error('AUDIT_RECOVERY_REQUIRED');
    const correlated = await readCorrelatedPixelSuspension(active);
    const suspension = correlated.suspension;
    if (suspension !== null && (!['resuming', 'revoked'].includes(suspension.state) ||
      suspension.state === 'resuming' && suspension.resumePhase !== 'runner-started')) {
      throw new Error('AUDIT_RECOVERY_REQUIRED');
    }
    const attemptSource = suspension?.source ?? freeze({ kind: 'attached' });
    let attempt = exact(await pixelAttemptLifecycle.classify(pixelAttemptRequest(
      active.auditId, suspension?.consentId ?? null, attemptSource,
    )), ['state', 'handle']);
    if (attempt?.state === 'blocked' && suspension === null && active.commitState === 'confirmed' &&
      await pixelAttemptLifecycle.cleanup(pixelAttemptRequest(
        active.auditId, null, attemptSource, { expected: 'post-finish' },
      ))) {
      attempt = exact(await pixelAttemptLifecycle.classify(pixelAttemptRequest(
        active.auditId, null, attemptSource,
      )), ['state', 'handle']);
    }
    if (!attempt || attempt.handle !== null || attempt.state === 'blocked' || attempt.state === 'prepared' ||
      (suspension && attempt.state !== 'terminal')) throw new Error('AUDIT_RECOVERY_REQUIRED');
    const candidate = await terminalCandidate({ auditId: active.auditId, model: report.model, checkpoint: report.checkpoint });
    if (candidate.modelRevision !== active.expectedTerminalRevision || candidate.modelHash !== report.modelHash ||
      report.modelRevision !== active.expectedTerminalRevision) return recoverInterrupted(active);
    const bundle = copyPanelResultBundleV1(await buildPanelResultBundle({ reportRevision: report }));
    const latest = await readLatest();
    const latestAuditId = latest === null || latest === undefined ? null : supportedLatestAuditId(latest);
    if (latest !== null && latest !== undefined && latestAuditId === null) throw new Error('AUDIT_RECOVERY_REQUIRED');
    if (latestAuditId === null || latestAuditId === active.auditId) {
      await persistExactLatest(latestState(active.auditId, candidate.model.session.status, modelNow));
    }
    const session = await readAuditSessionForWorker({
      sessionArea, sessionCapabilityId: active.sessionCapabilityId, auditId: active.auditId,
    });
    if (session.state === 'running') await transitionConfirmed(active, 'result');
    else if (session.state !== 'result') throw new Error('AUDIT_RECOVERY_REQUIRED');
    const publish = scope => scope.publishResult({
      auditId: active.auditId, sessionCapabilityId: active.sessionCapabilityId,
      windowId: active.windowId, state: 'result', resultBundle: bundle,
    });
    const published = lockedScope ? await publish(lockedScope)
      : await panelCoordinator.withWindowLock(active.windowId, publish);
    if (!acceptedTerminalDelivery(published)) throw new Error('AUDIT_RECOVERY_REQUIRED');
    if (suspension) {
      try {
        if (await pixelState.finish({ auditId: active.auditId, consentId: suspension.consentId }) !== true) {
          throw new Error('AUDIT_RECOVERY_REQUIRED');
        }
      } catch {
        if ((await readCorrelatedPixelSuspension(active)).suspension !== null) {
          throw new Error('AUDIT_RECOVERY_REQUIRED');
        }
      }
      await schedulePixelExpiryBestEffort();
    }
    if (!await pixelAttemptLifecycle.cleanup(pixelAttemptRequest(
      active.auditId, suspension?.consentId ?? null, attemptSource, { expected: 'post-finish' },
    ))) throw new Error('AUDIT_RECOVERY_REQUIRED');
    await cleanupActive(active);
    return freeze({ ok: true, state: 'reconciled', auditId: active.auditId, revision: 1 });
  }

  async function recoverAttachedCopyStart(journal) {
    const cleanupRequest = urlCleanupRequest(
      journal.auditId,
      journal.ownershipId,
      journal.navigationPurpose,
    );
    let copyGraph = null;
    try {
      copyGraph = await readAttachedCopyNavigationForRecovery({
        sessionArea,
        capabilityId: journal.capabilityId,
      });
    } catch { copyGraph = null; }

    if (copyGraph === null) {
      const target = await readAttachedAuditCorrelationForRecovery({
        sessionArea,
        capabilityId: journal.capabilityId,
        auditId: journal.auditId,
      });
      if (journal.state !== 'copy-preparing' || journal.sessionCapabilityId !== null ||
        target.windowId !== journal.windowId || target.sessionCapabilityId !== null ||
        !['prepared', 'invalidated'].includes(target.targetState)) throw new Error('AUDIT_RECOVERY_REQUIRED');
      if (await clearUrlAuditResources(cleanupRequest) !== true) throw new Error('AUDIT_RECOVERY_REQUIRED');
      const invalidated = await authority.invalidateCapability(
        journal.capabilityId,
        'AUDIT_START_COMPENSATED',
      );
      if (invalidated?.ok !== true) throw new Error('AUDIT_RECOVERY_REQUIRED');
      const confirmed = await readAttachedAuditCorrelationForRecovery({
        sessionArea,
        capabilityId: journal.capabilityId,
        auditId: journal.auditId,
      });
      if (confirmed.windowId !== journal.windowId || confirmed.targetState !== 'invalidated' ||
        confirmed.sessionCapabilityId !== null || confirmed.sessionState !== null) {
        throw new Error('AUDIT_RECOVERY_REQUIRED');
      }
    } else {
      if (copyGraph.windowId !== journal.windowId || copyGraph.targetState !== 'invalidated' ||
        !['prepared', 'claimed', 'invalidated'].includes(copyGraph.navigationState)) {
        throw new Error('AUDIT_RECOVERY_REQUIRED');
      }
      if (copyGraph.sessionCapabilityId === null) {
        if (journal.sessionCapabilityId !== null || !['copy-preparing', 'prepared'].includes(journal.state)) {
          throw new Error('AUDIT_RECOVERY_REQUIRED');
        }
        if (await clearUrlAuditResources(cleanupRequest) !== true) throw new Error('AUDIT_RECOVERY_REQUIRED');
        const invalidated = await authority.invalidateCapability(
          journal.capabilityId,
          'AUDIT_START_COMPENSATED',
        );
        if (invalidated?.ok !== true) throw new Error('AUDIT_RECOVERY_REQUIRED');
        const confirmed = await readAttachedCopyNavigationForRecovery({
          sessionArea,
          capabilityId: journal.capabilityId,
        });
        if (confirmed.windowId !== journal.windowId || confirmed.navigationState !== 'invalidated' ||
          confirmed.sessionCapabilityId !== null) throw new Error('AUDIT_RECOVERY_REQUIRED');
      } else {
        if (journal.state === 'claimed' && journal.sessionCapabilityId !== copyGraph.sessionCapabilityId ||
          !['prepared', 'claimed'].includes(journal.state)) throw new Error('AUDIT_RECOVERY_REQUIRED');
        let correlation = await readNavigationAuditCorrelationForRecovery({
          sessionArea,
          capabilityId: journal.capabilityId,
          auditId: journal.auditId,
        });
        if (correlation.sessionCapabilityId !== copyGraph.sessionCapabilityId ||
          correlation.windowId !== journal.windowId || correlation.navigationPurpose !== 'attached-copy' ||
          correlation.ownershipId !== journal.ownershipId ||
          !['running', 'revoked'].includes(correlation.sessionState)) throw new Error('AUDIT_RECOVERY_REQUIRED');
        if (await clearUrlAuditResources(cleanupRequest) !== true) throw new Error('AUDIT_RECOVERY_REQUIRED');
        if (correlation.ownershipState !== 'removed') {
          const removed = await authority.transitionDisposableAuditSession({
            sessionCapabilityId: correlation.sessionCapabilityId,
            auditId: journal.auditId,
            ownershipId: journal.ownershipId,
            fromState: correlation.ownershipState,
            toState: 'removed',
          });
          if (removed?.ok !== true || removed.state !== 'removed' ||
            removed.ownershipId !== journal.ownershipId) throw new Error('AUDIT_RECOVERY_REQUIRED');
        }
        const invalidated = await authority.invalidateCapability(
          journal.capabilityId,
          'AUDIT_START_COMPENSATED',
        );
        if (invalidated?.ok !== true) throw new Error('AUDIT_RECOVERY_REQUIRED');
        correlation = await readNavigationAuditCorrelationForRecovery({
          sessionArea,
          capabilityId: journal.capabilityId,
          auditId: journal.auditId,
        });
        if (correlation.capabilityState !== 'invalidated' || correlation.sessionState !== 'revoked' ||
          correlation.ownershipState !== 'removed' || correlation.navigationPurpose !== 'attached-copy' ||
          correlation.ownershipId !== journal.ownershipId) throw new Error('AUDIT_RECOVERY_REQUIRED');
        const disconnected = await panelCoordinator.withWindowLock(journal.windowId, scope => scope.disconnectSession({
          auditId: journal.auditId,
          sessionCapabilityId: correlation.sessionCapabilityId,
          windowId: journal.windowId,
          reasonCode: 'AUDIT_INTERRUPTED',
        }));
        if (disconnected !== true) throw new Error('AUDIT_RECOVERY_REQUIRED');
      }
    }

    const checkpoint = exact(await removeCheckpoint({
      auditId: journal.auditId,
      sessionCapabilityId: journal.sessionCapabilityId,
      windowId: journal.sessionCapabilityId === null ? null : journal.windowId,
    }), ['removed']);
    if (!checkpoint || typeof checkpoint.removed !== 'boolean') throw new Error('AUDIT_RECOVERY_REQUIRED');
    const preferenceRemoved = await removePreference({ auditId: journal.auditId });
    if (!preferenceRemoved || !await removeCorrelated(
      sessionArea,
      START_JOURNAL_KEY,
      journalRecord,
      current => sameAttachedCopyJournalIdentity(current, journal),
    )) throw new Error('AUDIT_RECOVERY_REQUIRED');
    return freeze({ ok: true, state: 'interrupted', auditId: journal.auditId, revision: null });
  }

  async function recoverAuthorizedAuditLifecycle() {
    return withGlobalLock(async () => {
      try {
        let { active, journal } = await currentSingletons();
        if (active) {
          if (journal !== null) {
            const activeBatchJournal = batchJournal(journal);
            if (active.mode === 'batch') {
              if (!activeBatchJournal || activeBatchJournal.state !== 'claimed' ||
                activeBatchJournal.capabilityId !== active.capabilityId ||
                activeBatchJournal.auditId !== active.auditId || activeBatchJournal.windowId !== active.windowId ||
                activeBatchJournal.sessionCapabilityId !== active.sessionCapabilityId ||
                !await removeCorrelated(sessionArea, START_JOURNAL_KEY, journalRecord,
                  current => same(current, activeBatchJournal))) throw new Error('AUDIT_RECOVERY_REQUIRED');
              journal = null;
            } else {
            const copyJournal = attachedCopyJournal(journal);
            if (!copyJournal || active.mode !== 'single' || copyJournal.state !== 'claimed' ||
              copyJournal.sessionCapabilityId !== active.sessionCapabilityId ||
              !sameAttachedCopyJournalIdentity(copyJournal, {
                capabilityId: active.capabilityId,
                auditId: active.auditId,
                windowId: active.windowId,
                ownershipId: copyJournal.ownershipId,
              }) || !await removeCorrelated(
                sessionArea,
                START_JOURNAL_KEY,
                journalRecord,
                current => same(current, copyJournal),
              )) throw new Error('AUDIT_RECOVERY_REQUIRED');
            journal = null;
            }
          }
          let navigationCorrelation = null;
          if (active.mode === 'batch') {
            navigationCorrelation = await readBatchAuditCorrelationForRecovery({
              sessionArea, capabilityId: active.capabilityId, auditId: active.auditId,
            });
          } else if (active.mode === 'single') {
            navigationCorrelation = await readNavigationAuditCorrelationForRecovery({
              sessionArea, capabilityId: active.capabilityId, auditId: active.auditId,
            });
          } else {
            await readAttachedAuditCorrelationForRecovery({
              sessionArea, capabilityId: active.capabilityId, auditId: active.auditId,
            });
          }
          const singlePixelSuspension = active.mode === 'single'
            ? (await readCorrelatedPixelSuspension(active)).suspension
            : null;
          const batchRunningPixelSuspension = active.mode === 'batch' && active.state === 'running'
            ? await pixelState.readSuspension(active.auditId)
            : null;
          const result = active.mode === 'batch'
            ? active.state === 'finalizing'
              ? await recoverBatchFinalizing(active)
              : active.state === 'privacy-paused'
                ? await recoverPrivacyPaused(active)
                : batchRunningPixelSuspension ? await recoverInterrupted(active) : await recoverBatchInterrupted(active)
            : active.mode === 'single'
            ? active.state === 'finalizing'
              ? singlePixelSuspension ? await recoverFinalizing(active, journal) : await recoverSingleFinalizing(active)
              : active.state === 'privacy-paused'
                ? await recoverPrivacyPaused(active)
                : singlePixelSuspension ? await recoverInterrupted(active) : await recoverSingleInterrupted(active)
            : active.state === 'finalizing' ? await recoverFinalizing(active, journal)
              : active.state === 'privacy-paused' ? await recoverPrivacyPaused(active)
                : await recoverInterrupted(active);
          if (active.state !== 'privacy-paused' && journal &&
            journal.auditId === active.auditId && journal.capabilityId === active.capabilityId) {
            if (!await removeCorrelated(sessionArea, START_JOURNAL_KEY, journalRecord,
              current => current.auditId === active.auditId && current.capabilityId === active.capabilityId)) {
              throw new Error('AUDIT_RECOVERY_REQUIRED');
            }
          }
          return result;
        }
        if (!journal) return freeze({ ok: true, state: 'idle', auditId: null, revision: null });
        const pendingBatch = batchJournal(journal);
        if (pendingBatch) return await recoverBatchStart(pendingBatch);
        const copyJournal = attachedCopyJournal(journal);
        if (copyJournal) return recoverAttachedCopyStart(copyJournal);
        const correlation = await readAttachedAuditCorrelationForRecovery({
          sessionArea, capabilityId: journal.capabilityId, auditId: journal.auditId,
        });
        if (correlation.windowId !== journal.windowId) throw new Error('AUDIT_RECOVERY_REQUIRED');
        if (correlation.targetState === 'prepared') {
          await authority.invalidateCapability(journal.capabilityId, 'AUDIT_START_INTERRUPTED');
          const invalidated = await readAttachedAuditCorrelationForRecovery({
            sessionArea, capabilityId: journal.capabilityId, auditId: journal.auditId,
          });
          if (invalidated.targetState !== 'invalidated' || !await removeCorrelated(
            sessionArea, START_JOURNAL_KEY, journalRecord,
            current => current.auditId === journal.auditId && current.capabilityId === journal.capabilityId &&
              current.windowId === journal.windowId,
          )) throw new Error('AUDIT_RECOVERY_REQUIRED');
          return freeze({ ok: true, state: 'interrupted', auditId: journal.auditId, revision: null });
        }
        if (!correlation.sessionCapabilityId) throw new Error('AUDIT_RECOVERY_REQUIRED');
        const synthetic = freeze({
          version: 1, auditId: journal.auditId, capabilityId: journal.capabilityId,
          sessionCapabilityId: correlation.sessionCapabilityId, windowId: journal.windowId, mode: 'attached',
          state: 'running', commitState: 'none', expectedTerminalRevision: null,
          createdAt: journal.createdAt, updatedAt: journal.updatedAt,
        });
        return recoverInterrupted(synthetic);
      } catch {
        return freeze({ ok: false, state: 'blocked', auditId: null, revision: null, code: 'AUDIT_RECOVERY_REQUIRED' });
      }
    });
  }

  return Object.freeze({
    beginAuthorizedAudit,
    beginAuthorizedUrlAudit,
    beginAuthorizedBatchAudit,
    resumePrivacyPausedAudit,
    abortAuthorizedAudit,
    abortAttachedAuditForTarget,
    liquidatePixelAudit,
    recoverAuthorizedAuditLifecycle,
  });
}
