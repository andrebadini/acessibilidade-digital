import { validateExecutionCheckpoint } from './execution-checkpoint.js';
import {
  readAttachedAuditCorrelationForRecovery,
  readAttachedAuditRecoveryGrant,
  readAuditSessionForWorker,
  readClaimedAttachedAuditGrant,
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

const FACTORY_KEYS = Object.freeze([
  'authority', 'sessionArea', 'panelCoordinator', 'targetQueue', 'cleanupBarrier', 'runAttachedAuditExecution',
  'persistLatest', 'persistCheckpoint', 'removeCheckpoint', 'commitTerminalAudit',
  'readAuditSnapshot', 'readReportRevision', 'readLatest', 'buildPanelResultBundle', 'recordHighlightBinding',
  'pixelCommitClock', 'epochNow', 'modelNow', 'createAbortController', 'pixelState', 'probeDocumentIdentity',
  'probeSensitiveCaptureSignals', 'pixelAttemptLifecycle', 'schedulePixelExpiry',
]);
const BEGIN_KEYS = Object.freeze([
  'capabilityId', 'eventNonce', 'auditId', 'capturePolicy', 'retentionPreference', 'senderContext',
]);
const RESUME_KEYS = Object.freeze(['auditId', 'sessionCapabilityId', 'windowId', 'consentId', 'mode']);
const ACTIVE_KEYS = Object.freeze([
  'version', 'auditId', 'capabilityId', 'sessionCapabilityId', 'windowId', 'mode',
  'state', 'commitState', 'expectedTerminalRevision', 'createdAt', 'updatedAt',
]);
const JOURNAL_KEYS = Object.freeze([
  'version', 'capabilityId', 'auditId', 'windowId', 'state', 'sessionCapabilityId', 'createdAt', 'updatedAt',
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
    !Number.isSafeInteger(record.windowId) || record.windowId < 0 || record.mode !== 'attached' ||
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
  const record = exact(value, JOURNAL_KEYS);
  if (!record || record.version !== 1 || !CAPABILITY.test(record.capabilityId ?? '') ||
    !AUDIT_ID.test(record.auditId ?? '') || !Number.isSafeInteger(record.windowId) || record.windowId < 0 ||
    !Number.isSafeInteger(record.createdAt) || record.createdAt < 0 ||
    !Number.isSafeInteger(record.updatedAt) || record.updatedAt < record.createdAt ||
    (record.state === 'prepared' ? record.sessionCapabilityId !== null
      : record.state !== 'claimed' || !CAPABILITY.test(record.sessionCapabilityId ?? ''))) return null;
  return freeze(record);
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
  return freeze({ grant, target, sessionState: grant.sessionState, targetState: grant.targetState });
}

function correlatedPixelSuspension(value, active, context) {
  const record = exact(value, [
    'version', 'revision', 'auditId', 'consentId', 'tabId', 'windowId', 'documentId', 'urlEvidence',
    'urlSessionDigest', 'mode', 'capturePolicy', 'categories', 'issuedAt', 'updatedAt', 'expiresAt',
    'cleanupAttempts', 'cleanupNotBefore', 'state', 'resumePhase', 'revokeReason', 'source',
  ]);
  const source = record && exact(record.source, ['kind']);
  const policy = record && exactCapturePolicy(record.capturePolicy);
  const evidence = record && exact(record.urlEvidence, ['version', 'href', 'queryIncluded', 'redactedSegments']);
  const categories = record && canonicalSensitiveCategories(record.categories);
  const target = context?.target;
  if (!record || record.version !== 'AuditSuspensionV1' || record.auditId !== active.auditId ||
    !/^[A-Za-z0-9_-]{21}[AQgw]$/u.test(record.consentId ?? '') ||
    record.windowId !== active.windowId || source?.kind !== 'attached' || !target ||
    record.tabId !== target.tabId || record.documentId !== target.documentId ||
    record.urlSessionDigest !== target.initialUrlSessionDigest || !policy || policy.mode !== record.mode ||
    !['full-evidence', 'element-only'].includes(record.mode) || !evidence || !isEvidenceUrlV1(evidence) ||
    evidence.queryIncluded !== false || evidence.href !== target.initialUrlEvidence || !categories ||
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

export function createAuthorizedAuditStarter(input) {
  const dependencies = exact(input, FACTORY_KEYS);
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

  const {
    authority, sessionArea, panelCoordinator, targetQueue, cleanupBarrier, runAttachedAuditExecution,
    persistLatest, persistCheckpoint, removeCheckpoint, commitTerminalAudit,
    readAuditSnapshot, readReportRevision, readLatest, buildPanelResultBundle, recordHighlightBinding,
    pixelCommitClock, epochNow, modelNow, createAbortController, pixelState,
    probeDocumentIdentity, probeSensitiveCaptureSignals,
    pixelAttemptLifecycle, schedulePixelExpiry,
  } = dependencies;
  let globalTail = Promise.resolve();
  const live = new Map();
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

  async function readCorrelatedPixelSuspension(active) {
    const [recoveryGrant, rawSuspension] = await Promise.all([
      readAttachedAuditRecoveryGrant({
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
    if (!removedJournal || !retention) throw new Error('CORRELATED_CLEANUP_DENIED');
    const removedActive = await removeCorrelated(
      sessionArea, ACTIVE_AUDIT_JOB_KEY, activeRecord,
      current => current.auditId === active.auditId && current.capabilityId === active.capabilityId &&
        current.sessionCapabilityId === active.sessionCapabilityId && current.windowId === active.windowId,
    );
    if (!removedActive) throw new Error('CORRELATED_CLEANUP_DENIED');
    live.delete(active.auditId);
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

  async function liquidatePixelAuditLocked(args, lockedScope = null) {
    if (args.signal?.aborted === true) return false;
    let active;
    try { active = await readActiveAuditJobForWorker({ sessionArea }); }
    catch { return false; }
    if (!active || active.auditId !== args.auditId) return false;
    let suspension;
    try { suspension = (await readCorrelatedPixelSuspension(active)).suspension; }
    catch { return false; }
    if (!suspension || suspension.consentId !== args.consentId || suspension.source.kind !== args.source.kind ||
      suspension.state !== 'revoked' || suspension.revokeReason !== args.reason ||
      args.signal?.aborted === true) return false;
    const classified = await pixelAttemptLifecycle.classify({
      auditId: args.auditId, consentId: args.consentId,
    });
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
      if (await invalidateConfirmed(active) !== true || args.signal?.aborted === true) return false;
      const disconnect = scope => scope.disconnectSession({
        auditId: active.auditId, sessionCapabilityId: active.sessionCapabilityId,
        windowId: active.windowId, reasonCode: args.reason,
      });
      const disconnected = lockedScope ? await disconnect(lockedScope)
        : await panelCoordinator.withWindowLock(active.windowId, disconnect);
      if (disconnected !== true || args.signal?.aborted === true) return false;
      if (!await pixelAttemptLifecycle.cleanup({
        auditId: active.auditId, consentId: args.consentId,
        expected: classification.state === 'prepared' ? 'prepared' : 'post-finish',
      })) return false;
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
    const source = args && exact(args.source, ['kind']);
    if (!args || !AUDIT_ID.test(args.auditId ?? '') || !/^[A-Za-z0-9_-]{21}[AQgw]$/u.test(args.consentId ?? '') ||
      !PIXEL_LIQUIDATION_REASONS.has(args.reason) || source?.kind !== 'attached' ||
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
      const committed = await pixelAttemptLifecycle.commitTerminal({
        auditId: candidate.auditId, model: candidate.model, checkpoint: candidate.checkpoint,
        latestState: latest, expectedRevision: 1, attemptHandle: liveRecord.attemptHandle,
      });
      const result = exact(committed, ['revision', 'modelHash']);
      if (!result || result.revision !== 1 || result.modelHash !== candidate.modelHash) throw new Error('TERMINAL_COMMIT_DENIED');
      try {
        await recordHighlightBinding(freeze({
          snapshot: {
            model: candidate.model,
            modelRevision: candidate.modelRevision,
            modelHash: candidate.modelHash,
          },
          observedTarget: {
            version: 1,
            kind: 'attached',
            tabId: liveRecord.grant.target.tabId,
            windowId: liveRecord.grant.target.windowId,
            documentId: liveRecord.grant.target.documentId,
            urlSessionDigest: liveRecord.grant.target.initialUrlSessionDigest,
            urlEvidence: liveRecord.grant.target.initialUrlEvidence,
          },
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
          if (!await pixelAttemptLifecycle.cleanup({
            auditId: current.auditId, consentId: null, expected: 'post-finish',
          })) throw new Error('PIXEL_ATTEMPT_CLEANUP_DENIED');
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
              windowId: fact.windowId, createdAt: postGrant, expiresAt: grant.expiresAt,
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
            const privacyGate = capturePolicy.mode === 'no-pixels' ? null : createPixelPrivacyGateV1({
              pixelState, consentId: null, authorityExpiresAt: grant.expiresAt,
              commitClock: pixelCommitClock, async afterPixels() {},
            });
            const liveRecord = {
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
    const args = exact(raw, RESUME_KEYS);
    const denied = () => freeze({
      response: { ok: false, code: 'AUDIT_RESUME_DENIED' }, sessionCapabilityId: null, completion: null,
    });
    if (!args || !AUDIT_ID.test(args.auditId ?? '') || !CAPABILITY.test(args.sessionCapabilityId ?? '') ||
      !Number.isSafeInteger(args.windowId) || args.windowId < 0 ||
      !/^[A-Za-z0-9_-]{21}[AQgw]$/u.test(args.consentId ?? '') ||
      !['full-evidence', 'element-only'].includes(args.mode)) return denied();

    let preliminaryActive;
    let preliminarySuspension;
    try {
      preliminaryActive = await readActiveAuditJobForWorker({ sessionArea });
      if (!preliminaryActive || preliminaryActive.state !== 'privacy-paused' ||
        preliminaryActive.auditId !== args.auditId ||
        preliminaryActive.sessionCapabilityId !== args.sessionCapabilityId ||
        preliminaryActive.windowId !== args.windowId) return denied();
      const preliminary = await readCorrelatedPixelSuspension(preliminaryActive);
      preliminarySuspension = preliminary.suspension;
      if (preliminary.sessionState !== 'privacy-paused' || preliminary.targetState !== 'claimed' ||
        !preliminarySuspension || preliminarySuspension.state !== 'paused' ||
        preliminarySuspension.consentId !== args.consentId ||
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
            const correlated = await readCorrelatedPixelSuspension(active);
            const { grant, suspension } = correlated;
            const capturePolicy = suspension?.capturePolicy ?? null;
            if (correlated.sessionState !== 'privacy-paused' || correlated.targetState !== 'claimed' ||
              journal !== null || !checkpoint || !grant || !suspension || suspension.state !== 'paused' ||
              suspension.consentId !== args.consentId || suspension.mode !== args.mode) return denied();
            const revokeAndLiquidate = async (reason, code) => {
              try {
                const currentSuspension = (await readCorrelatedPixelSuspension(active)).suspension;
                if (!currentSuspension || currentSuspension.consentId !== args.consentId ||
                  !['paused', 'resuming', 'revoked'].includes(currentSuspension.state)) {
                  return freeze({ response: { ok: false, code: 'AUDIT_RECOVERY_REQUIRED' }, sessionCapabilityId: null, completion: null });
                }
                if (currentSuspension.state !== 'revoked') {
                  await pixelState.revokeAudit({ auditId: active.auditId, consentId: args.consentId, reason });
                  await schedulePixelExpiryBestEffort();
                }
                const revoked = (await readCorrelatedPixelSuspension(active)).suspension;
                const controller = createAbortController();
                const liquidated = revoked?.consentId === args.consentId && revoked.state === 'revoked' &&
                  revoked.revokeReason === reason && controller?.signal &&
                  await liquidatePixelAuditLocked({
                    auditId: active.auditId, consentId: args.consentId, reason,
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
              await pixelState.claimAndBeginResume({
                auditId: active.auditId, consentId: args.consentId,
                proof: { kind: 'attached', ...proof }, mode: args.mode, categories: signals.categories,
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
              if (!replacement || replacement.state !== 'paused' || replacement.consentId === args.consentId) return denied();
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
            await transitionConfirmed(active, 'running');
            await pixelState.markSessionRunning({ auditId: active.auditId, consentId: args.consentId });
            const attemptHandle = await pixelAttemptLifecycle.prepareResume({
              auditId: active.auditId, consentId: args.consentId,
              pageId: null, ownershipId: null, expiresAt: suspension.expiresAt,
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
            const privacyGate = createPixelPrivacyGateV1({
              pixelState, consentId: args.consentId,
              authorityExpiresAt: suspension.expiresAt,
              commitClock: pixelCommitClock, async afterPixels() {},
            });
            const controller = createAbortController();
            const liveRecord = {
              active: running, controller, grant, capturePolicy, privacyGate,
              resumeCheckpoint: checkpoint.checkpoint,
              consentId: args.consentId, targetLock: lock,
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
      return execute(setup.liveRecord);
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
          if (correlated.sessionState !== 'privacy-paused' || correlated.targetState !== 'claimed' ||
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
        if (active.state !== 'running' || !['running', 'privacy-paused'].includes(correlated.sessionState) ||
          correlated.targetState !== 'claimed' || !checkpoint) throw new Error('AUDIT_RECOVERY_REQUIRED');
        if (correlated.sessionState === 'running') await transitionConfirmed(active, 'privacy-paused');
        const advanced = await readCorrelatedPixelSuspension(active);
        const advancedCheckpoint = await readPersistedCheckpoint(active);
        if (advanced.sessionState !== 'privacy-paused' || advanced.targetState !== 'claimed' ||
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

  async function recoverPrivacyPaused(active) {
    const journal = await readConfirmed(sessionArea, START_JOURNAL_KEY, journalRecord, 'START_JOURNAL_DENIED');
    const checkpoint = await readPersistedCheckpoint(active);
    const correlated = await readCorrelatedPixelSuspension(active);
    const suspension = correlated.suspension;
    if (correlated.sessionState !== 'privacy-paused' || correlated.targetState !== 'claimed' ||
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
    let attempt = exact(await pixelAttemptLifecycle.classify({
      auditId: active.auditId, consentId: suspension?.consentId ?? null,
    }), ['state', 'handle']);
    if (attempt?.state === 'blocked' && suspension === null && active.commitState === 'confirmed' &&
      await pixelAttemptLifecycle.cleanup({
        auditId: active.auditId, consentId: null, expected: 'post-finish',
      })) {
      attempt = exact(await pixelAttemptLifecycle.classify({
        auditId: active.auditId, consentId: null,
      }), ['state', 'handle']);
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
    if (!await pixelAttemptLifecycle.cleanup({
      auditId: active.auditId, consentId: null, expected: 'post-finish',
    })) throw new Error('AUDIT_RECOVERY_REQUIRED');
    await cleanupActive(active);
    return freeze({ ok: true, state: 'reconciled', auditId: active.auditId, revision: 1 });
  }

  async function recoverAuthorizedAuditLifecycle() {
    return withGlobalLock(async () => {
      try {
        const { active, journal } = await currentSingletons();
        if (active) {
          if (journal !== null) throw new Error('AUDIT_RECOVERY_REQUIRED');
          await readAttachedAuditCorrelationForRecovery({
            sessionArea, capabilityId: active.capabilityId, auditId: active.auditId,
          });
          const result = active.state === 'finalizing' ? await recoverFinalizing(active, journal)
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
    resumePrivacyPausedAudit,
    abortAuthorizedAudit,
    abortAttachedAuditForTarget,
    liquidatePixelAudit,
    recoverAuthorizedAuditLifecycle,
  });
}
