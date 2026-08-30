import { validateExecutionCheckpoint } from './execution-checkpoint.js';
import {
  readAttachedAuditCorrelationForRecovery,
  readAuditSessionForWorker,
  readClaimedAttachedAuditGrant,
  readPreparedAttachedAuditFact,
} from './target-capabilities.js';
import { isCapturePolicyV1 } from '../core/privacy/capture-policy.js';
import { verifyAuditIntegritySnapshot } from '../core/report/integrity.js';
import { copyPanelResultBundleV1 } from '../panel/panel-result-bundle.js';

export const ACTIVE_AUDIT_JOB_KEY = 'audita:active-audit-job:v1';
const START_JOURNAL_KEY = 'audita:start-journal:v1';
export const retentionPreferenceStorageKey = auditId => `audita:retention-preference:v1:${auditId}`;
export const executionCheckpointStorageKey = auditId => `audita:execution-checkpoint:v1:${auditId}`;

const FACTORY_KEYS = Object.freeze([
  'authority', 'sessionArea', 'panelCoordinator', 'runAttachedAuditExecution',
  'persistLatest', 'persistCheckpoint', 'removeCheckpoint', 'commitTerminalAudit',
  'readAuditSnapshot', 'readReportRevision', 'readLatest', 'buildPanelResultBundle',
  'epochNow', 'modelNow', 'createAbortController',
]);
const BEGIN_KEYS = Object.freeze([
  'capabilityId', 'eventNonce', 'auditId', 'capturePolicy', 'retentionPreference', 'senderContext',
]);
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
const FAILURE_CODES = new Set(['PRIVACY_PAUSED', 'TARGET_CHANGED', 'AUDIT_FAILED']);
const TARGET_REASONS = new Set(['TAB_LOADING', 'TAB_URL_CHANGED', 'TAB_PENDING_URL', 'TAB_REMOVED', 'WINDOW_REMOVED']);
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

function activeRecord(value) {
  const record = exact(value, ACTIVE_KEYS);
  if (!record || record.version !== 1 || !AUDIT_ID.test(record.auditId ?? '') ||
    !CAPABILITY.test(record.capabilityId ?? '') || !CAPABILITY.test(record.sessionCapabilityId ?? '') ||
    !Number.isSafeInteger(record.windowId) || record.windowId < 0 || record.mode !== 'attached' ||
    !Number.isSafeInteger(record.createdAt) || record.createdAt < 0 ||
    !Number.isSafeInteger(record.updatedAt) || record.updatedAt < record.createdAt) return null;
  if (record.state === 'running') {
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

function readEnvelopeValue(envelope, key) {
  try {
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) ||
      (Object.getPrototypeOf(envelope) !== Object.prototype && Object.getPrototypeOf(envelope) !== null)) throw new Error();
    const keys = Reflect.ownKeys(envelope);
    if (keys.length === 0) return undefined;
    if (keys.length !== 1 || keys[0] !== key) throw new Error();
    const descriptor = Object.getOwnPropertyDescriptor(envelope, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error();
    return descriptor.value;
  } catch { throw new TypeError('STORAGE_DENIED'); }
}

async function readConfirmed(sessionArea, key, parser, denial) {
  try {
    const first = readEnvelopeValue(await sessionArea.get(key), key);
    const second = readEnvelopeValue(await sessionArea.get(key), key);
    if (first === undefined && second === undefined) return null;
    const firstParsed = parser(first);
    const secondParsed = parser(second);
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
  await sessionArea.remove(key);
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
    record.mode === 'no-pixels' && record.includeQuery === false && record.captureFullPage === false &&
    record.captureElements === false && record.composeAnnouncementMap === false ? freeze(record) : null;
}

function latestState(auditId, kind, modelNow, status = null) {
  const row = {
    running: ['running', 0, 'Preparando a auditoria.', null, null],
    complete: ['complete', 100, 'Avaliação concluída.', null, 1],
    partial: ['partial', 100, 'Avaliação concluída com limitações.', null, 1],
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
  if (verified.auditId !== auditId || !['complete', 'partial', 'cancelled'].includes(verified.session.status) ||
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

export function createAuthorizedAuditStarter(input) {
  const dependencies = exact(input, FACTORY_KEYS);
  const coordinator = exact(dependencies?.panelCoordinator, ['attachPanelPort', 'withWindowLock']);
  if (!dependencies || !dependencies.authority || !dependencies.sessionArea || !dependencies.panelCoordinator ||
    FACTORY_KEYS.filter(key => !['authority', 'sessionArea', 'panelCoordinator'].includes(key))
      .some(key => typeof dependencies[key] !== 'function') ||
    typeof dependencies.sessionArea.get !== 'function' || typeof dependencies.sessionArea.set !== 'function' ||
    typeof dependencies.sessionArea.remove !== 'function' ||
    typeof dependencies.authority.claimAndIssueAuditSession !== 'function' ||
    typeof dependencies.authority.claimWorkerEventAndIssueAuditSession !== 'function' ||
    typeof dependencies.authority.transitionAuditSession !== 'function' ||
    typeof dependencies.authority.invalidateCapability !== 'function' || !coordinator ||
    typeof coordinator.attachPanelPort !== 'function' ||
    typeof coordinator.withWindowLock !== 'function') throw new TypeError('AUTHORIZED_AUDIT_STARTER_INVALID');

  const {
    authority, sessionArea, panelCoordinator, runAttachedAuditExecution,
    persistLatest, persistCheckpoint, removeCheckpoint, commitTerminalAudit,
    readAuditSnapshot, readReportRevision, readLatest, buildPanelResultBundle,
    epochNow, modelNow, createAbortController,
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
    const returned = parseLatest(await persistLatest({ state }));
    if (!returned || !same(returned, state)) throw new Error('LATEST_STATE_DENIED');
    return returned;
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
      const committed = await commitTerminalAudit({
        auditId: candidate.auditId, model: candidate.model, checkpoint: candidate.checkpoint,
        latestState: latest, expectedRevision: 1,
      });
      const result = exact(committed, ['revision', 'modelHash']);
      if (!result || result.revision !== 1 || result.modelHash !== candidate.modelHash) throw new Error('TERMINAL_COMMIT_DENIED');
      const confirmed = freeze({ ...pending, commitState: 'confirmed', updatedAt: safeEpoch(epochNow) });
      await writeConfirmed(sessionArea, ACTIVE_AUDIT_JOB_KEY, confirmed, activeRecord, 'ACTIVE_AUDIT_JOB_DENIED');
      const removed = exact(await removeCheckpoint({
        auditId: confirmed.auditId, sessionCapabilityId: confirmed.sessionCapabilityId, windowId: confirmed.windowId,
      }), ['removed']);
      if (!removed || typeof removed.removed !== 'boolean') throw new Error('CORRELATED_CLEANUP_DENIED');
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
      const code = error === AUDIT_REVOKED_SENTINEL || liveRecord.externallyInvalidated ? 'AUDIT_REVOKED' : 'AUDIT_FAILED';
      return settle(liveRecord, freeze({
        version: 1, auditId: active.auditId, state: 'revoked', failureCode: code === 'AUDIT_REVOKED' ? 'AUDIT_FAILED' : code,
        model: null, checkpoint: null,
      }), code);
    }
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
          if (typeof published !== 'boolean') throw new Error('PANEL_PUBLICATION_DENIED');
          await cleanupActive(current);
          return freeze({ ok: true, auditId: current.auditId, state: 'result', revision: 1 });
        }
        const code = FAILURE_CODES.has(outcome.failureCode) ? outcome.failureCode : 'AUDIT_FAILED';
        await persistExactLatest(latestState(current.auditId, code, modelNow));
        await transitionConfirmed(current, 'revoked');
        if (await invalidateConfirmed(current) !== true) throw new Error('CORRELATED_CLEANUP_DENIED');
        if (await scope.disconnectSession({
          auditId: current.auditId, sessionCapabilityId: current.sessionCapabilityId,
          windowId: current.windowId, reasonCode: code,
        }) !== true) throw new Error('CORRELATED_CLEANUP_DENIED');
        await cleanupActive(current, { removeRetention: true });
        return completionRevoked(current.auditId, code);
      } catch {
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
    let launch = null;
    const started = await withGlobalLock(async () => {
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
        const snapshot = exact(await readAuditSnapshot({ auditId: args.auditId }), ['model', 'revision']);
        if (!snapshot || snapshot.model !== undefined || snapshot.revision !== 0 || await readReportRevision({ auditId: args.auditId }) !== null) {
          return freeze({ response: { ok: false, code: 'AUDIT_ID_COLLISION' }, sessionCapabilityId: null, completion: null });
        }
        try {
          fact = await readPreparedAttachedAuditFact({ sessionArea, capabilityId: args.capabilityId, epochNow });
        } catch { throw TARGET_UNAVAILABLE_SENTINEL; }
        return await panelCoordinator.withWindowLock(fact.windowId, async scope => {
          let confirmedFact;
          try {
            confirmedFact = await readPreparedAttachedAuditFact({ sessionArea, capabilityId: args.capabilityId, epochNow });
          } catch { throw TARGET_UNAVAILABLE_SENTINEL; }
          if (confirmedFact.windowId !== fact.windowId) throw TARGET_UNAVAILABLE_SENTINEL;
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
          if (grant.windowId !== fact.windowId) throw TARGET_UNAVAILABLE_SENTINEL;
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
          const liveRecord = { active, controller, grant, capturePolicy, externallyInvalidated: false, committed: null, completion: null };
          live.set(active.auditId, liveRecord);
          const removedJournal = await removeCorrelated(sessionArea, START_JOURNAL_KEY, journalRecord,
            current => current.auditId === active.auditId && current.capabilityId === active.capabilityId &&
              current.sessionCapabilityId === active.sessionCapabilityId && current.windowId === active.windowId);
          if (!removedJournal) throw new Error('AUDIT_START_FAILED');
          const bootstrapPublished = await scope.publishRegisteredBootstrap({
            auditId: args.auditId, sessionCapabilityId: claimed.sessionCapabilityId, windowId: fact.windowId,
          });
          if (bootstrapPublished !== true) throw new Error('AUDIT_START_FAILED');
          let resolveCompletion;
          const completion = new Promise(resolve => { resolveCompletion = resolve; });
          liveRecord.completion = completion;
          launch = () => { execute(liveRecord).then(resolveCompletion, () => resolveCompletion(completionRevoked(active.auditId, 'AUDIT_FAILED'))); };
          return freeze({
            response: { ok: true, auditId: args.auditId, state: 'running' },
            sessionCapabilityId: claimed.sessionCapabilityId, completion,
          });
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
    launch?.();
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
      const record = live.get(active.auditId);
      if (!record) return freeze({ ok: false, code: 'AUDIT_CANCEL_DENIED' });
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
      record.controller.abort(new DOMException('Operação interrompida.', 'AbortError'));
      return freeze({ aborted: true, auditId: active.auditId });
    });
    if (waitFor) await waitFor;
    return answer;
  }

  async function recoverInterrupted(active) {
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

  async function recoverFinalizing(active) {
    const report = await readReportRevision({ auditId: active.auditId });
    if (report === null) return recoverInterrupted(active);
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
    const published = await panelCoordinator.withWindowLock(active.windowId, scope => scope.publishResult({
      auditId: active.auditId, sessionCapabilityId: active.sessionCapabilityId,
      windowId: active.windowId, state: 'result', resultBundle: bundle,
    }));
    if (typeof published !== 'boolean') throw new Error('AUDIT_RECOVERY_REQUIRED');
    await cleanupActive(active);
    return freeze({ ok: true, state: 'reconciled', auditId: active.auditId, revision: 1 });
  }

  async function recoverAuthorizedAuditLifecycle() {
    return withGlobalLock(async () => {
      try {
        const { active, journal } = await currentSingletons();
        if (active) {
          await readAttachedAuditCorrelationForRecovery({
            sessionArea, capabilityId: active.capabilityId, auditId: active.auditId,
          });
          const result = active.state === 'finalizing' ? await recoverFinalizing(active) : await recoverInterrupted(active);
          if (journal && journal.auditId === active.auditId && journal.capabilityId === active.capabilityId) {
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
    abortAuthorizedAudit,
    abortAttachedAuditForTarget,
    recoverAuthorizedAuditLifecycle,
  });
}
