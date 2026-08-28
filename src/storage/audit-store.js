import {
  canonicalAuditId,
  canonicalRetentionInstant,
  createRetentionMetadata,
  isPrivateAuditKey,
  migrateRetentionMetadata,
  validateRetentionMetadata,
} from './audit-retention.js';
import { AUDIT_STORAGE_UNAVAILABLE_MESSAGE as STORAGE_UNAVAILABLE_MESSAGE } from '../core/privacy.js';

const DB_NAME = 'audita-mt';
const STORE_NAME = 'audits';
const RETENTION_STORE_NAME = 'audit-retention';
const LATEST_KEY = '__latest__';
const REVISION_KEY_PREFIX = '__audit_revision__:';
const EXPORT_LEASE_KEY_PREFIX = '__audit_export_lease__:';
const EXPORT_ATTEMPT_KEY_PREFIX = '__audit_export_attempt__:';
const EXPORT_DELIVERY_KEY_PREFIX = '__audit_export_delivery__:';
const RETENTION_CLEANUP_CURSOR_KEY = '__audit_retention_cleanup__';
const DEFAULT_EXPORT_LEASE_TTL_MS = 2 * 60 * 1000;
const MAX_EXPORT_LEASE_TTL_MS = 10 * 60 * 1000;
const EXPORT_CLEANUP_MESSAGE = 'Um arquivo obsoleto da exportação não pôde ser removido com confirmação; tente gerar o relatório novamente.';
const EXPORT_FORMATS = new Set(['html', 'json', 'csv', 'pdf']);
const TERMINAL_AUDIT_STATUSES = new Set(['complete', 'partial', 'failed', 'cancelled']);
const INTERRUPTIBLE_AUDIT_STATUSES = new Set(['idle', 'validating', 'queued', 'running', 'cancelling']);
const AUDIT_SNAPSHOT_CAPABILITIES = new WeakMap();
const IN_MEMORY_RETENTION = new WeakMap();

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
  for (const prefix of [
    REVISION_KEY_PREFIX,
    EXPORT_LEASE_KEY_PREFIX,
    EXPORT_ATTEMPT_KEY_PREFIX,
    EXPORT_DELIVERY_KEY_PREFIX,
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

function storedExportAttempt(value) {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) {
    throw new TypeError('Tentativa armazenada da exportação inválida.');
  }
  return value;
}

function nextExportAttempt(value, latest, auditId) {
  let previous = storedExportAttempt(value);
  if (latest && typeof latest === 'object' && !Array.isArray(latest) && latest.auditId === auditId &&
    latest.exportAttempt !== undefined) {
    if (!Number.isSafeInteger(latest.exportAttempt) || latest.exportAttempt < 1 ||
      latest.exportAttempt >= Number.MAX_SAFE_INTEGER) {
      throw new TypeError('Tentativa armazenada da exportação inválida.');
    }
    previous = Math.max(previous, latest.exportAttempt);
  }
  return previous + 1;
}

function revisionKey(id) {
  return `${REVISION_KEY_PREFIX}${id}`;
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
    filename.length < 6 || filename.length > 240 || !filename.endsWith(`.${format}`)) {
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
  const state = options?.state;
  if (!['starting', 'in-flight', 'terminal'].includes(state) ||
    (state !== 'starting' && downloadId === undefined)) {
    throw new TypeError('Estado do journal de entrega inválido.');
  }
  return { ownerId, exportAttempt, ...instant, format, filename, downloadId, state };
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
    const expected = ['exportAttempt', 'filename', 'format', 'ownerId', 'recordedAt', 'state', 'updatedAt', ...(hasId ? ['downloadId'] : [])].sort();
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
      recordedAt: raw.recordedAt,
      updatedAt: raw.updatedAt,
    };
  });
}

function deliveryJournalRecord(auditId, entries) {
  return { schemaVersion: 1, auditId, entries: storageClone(entries) };
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
  const index = entries.findIndex(entry => entry.ownerId === options.ownerId &&
    entry.exportAttempt === options.exportAttempt && entry.format === options.format && entry.filename === options.filename);
  const previous = index >= 0 ? entries[index] : null;
  if (previous && previous.downloadId !== undefined && options.downloadId !== undefined &&
    previous.downloadId !== options.downloadId) throw new TypeError('Download divergente no journal de entrega.');
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
  const index = entries.findIndex(entry => entry.ownerId === options.ownerId &&
    entry.exportAttempt === options.exportAttempt && entry.format === options.format && entry.filename === options.filename &&
    (options.downloadId === undefined || entry.downloadId === undefined || entry.downloadId === options.downloadId));
  if (index < 0) return { entries, matched: false };
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

function isCompleteTerminalDelivery(entries, ownerId, exportAttempt) {
  if (entries.length !== EXPORT_FORMATS.size) return false;
  const formats = new Set();
  for (const entry of entries) {
    if (entry.ownerId !== ownerId || entry.exportAttempt !== exportAttempt || entry.state !== 'terminal' ||
      !EXPORT_FORMATS.has(entry.format) || formats.has(entry.format)) return false;
    formats.add(entry.format);
  }
  return formats.size === EXPORT_FORMATS.size;
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
  if (!Number.isFinite(acquiredAt.getTime()) || acquiredAt.toISOString() !== value.acquiredAt ||
    !Number.isFinite(expiresAt.getTime()) || expiresAt.toISOString() !== value.expiresAt ||
    expiresAt.getTime() <= acquiredAt.getTime() || expiresAt.getTime() <= nowMs) return null;
  return value;
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
    expiresAt: options.expiresAt,
  });
}

function monotonicLeaseTransition(options, existing) {
  const priorExpiryMs = new Date(existing.expiresAt).getTime();
  const requestedExpiryMs = options.nowMs + options.ttlMs;
  return {
    ...options,
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
  const record = (typeof capability === 'object' && capability !== null)
    ? AUDIT_SNAPSHOT_CAPABILITIES.get(capability)
    : null;
  if (!record || record.owner !== owner || record.auditId !== auditId) {
    throw new TypeError('Capacidade de snapshot da auditoria inválida.');
  }
  return record.revision;
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
  const snapshot = id => {
    const key = validId(id);
    return mintAuditSnapshot(owner, key, initial.get(key), initial.get(revisionKey(key)));
  };
  const writeAudit = (id, model, latestState, snapshotCapability, options = {}) => {
    const key = validId(id);
    const modelClone = storageClone(model);
    const latestClone = latestState === undefined ? undefined : storageClone(latestState);
    const currentRevision = storedRevision(initial.get(revisionKey(key)));
    const expectedRevision = snapshotCapability === undefined
      ? undefined
      : capabilityRevision(snapshotCapability, owner, key);
    if (expectedRevision !== undefined && (!initial.has(key) || currentRevision !== expectedRevision)) {
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
    initial.set(key, modelClone);
    initial.set(revisionKey(key), revision);
    if (currentRetention === undefined) retention.set(key, firstRetention);
    if (options.keepExportLease !== true) initial.delete(exportLeaseKey(key));
    if (options.review === true) {
      if (reviewLatest !== undefined) initial.set(LATEST_KEY, reviewLatest);
    } else if (latestState !== undefined) initial.set(LATEST_KEY, latestClone);
    return { revision, capability: mintAuditSnapshot(owner, key, modelClone, revision).capability };
  };
  const acquireExportLease = (id, snapshotCapability, options) => {
    const key = validId(id);
    const revision = capabilityRevision(snapshotCapability, owner, key);
    const currentRevision = storedRevision(initial.get(revisionKey(key)));
    if (!initial.has(key) || currentRevision !== revision) throw new AuditRevisionConflictError();
    const normalized = canonicalLeaseOptions(options, revision, 'queued');
    const existing = activeExportLease(initial.get(exportLeaseKey(key)), key, revision, normalized.nowMs);
    if (existing) {
      return {
        acquired: false, busy: true, retryAt: existing.expiresAt,
        revision, exportAttempt: existing.exportAttempt,
      };
    }
    const exportAttempt = nextExportAttempt(
      initial.get(exportAttemptKey(key)), initial.get(LATEST_KEY), key,
    );
    const deliveryEntries = canonicalDeliveryJournal(initial.get(exportDeliveryKey(key)), key);
    const lease = exportLeaseRecord(key, { ...normalized, exportAttempt });
    initial.set(exportLeaseKey(key), lease);
    initial.set(exportAttemptKey(key), exportAttempt);
    if (normalized.latestState !== undefined) {
      initial.set(LATEST_KEY, pendingCleanupLatest({ ...normalized.latestState, exportAttempt }, deliveryEntries));
    }
    return { acquired: true, busy: false, revision, exportAttempt, expiresAt: lease.expiresAt };
  };
  const claimExportLease = (id, snapshotCapability, options) => {
    const key = validId(id);
    const revision = capabilityRevision(snapshotCapability, owner, key);
    const currentRevision = storedRevision(initial.get(revisionKey(key)));
    if (!initial.has(key) || currentRevision !== revision) throw new AuditRevisionConflictError();
    const normalized = canonicalLeaseOptions({ ...options, phase: 'running' }, revision, 'running');
    const existing = activeExportLease(initial.get(exportLeaseKey(key)), key, revision, normalized.nowMs);
    if (!existing || existing.ownerId !== normalized.ownerId || existing.phase !== 'queued' ||
      (normalized.exportAttempt !== undefined && normalized.exportAttempt !== existing.exportAttempt)) {
      throw new AuditExportLeaseConflictError();
    }
    const deliveryEntries = canonicalDeliveryJournal(initial.get(exportDeliveryKey(key)), key);
    const lease = exportLeaseRecord(key, {
      ...monotonicLeaseTransition(normalized, existing),
      exportAttempt: existing.exportAttempt,
    }, existing.acquiredAt);
    initial.set(exportLeaseKey(key), lease);
    if (normalized.latestState !== undefined) {
      initial.set(LATEST_KEY, pendingCleanupLatest(
        { ...normalized.latestState, exportAttempt: existing.exportAttempt }, deliveryEntries,
      ));
    }
    return { claimed: true, revision, exportAttempt: existing.exportAttempt, expiresAt: lease.expiresAt };
  };
  const commitAuditIfRevisionWithExportLease = (id, model, latestState, snapshotCapability, options) => {
    const key = validId(id);
    const revision = capabilityRevision(snapshotCapability, owner, key);
    const currentRevision = storedRevision(initial.get(revisionKey(key)));
    if (!initial.has(key) || currentRevision !== revision) throw new AuditRevisionConflictError();
    const normalized = canonicalLeaseOptions(options, revision, options?.phase ?? 'delivering');
    const existing = activeExportLease(initial.get(exportLeaseKey(key)), key, revision, normalized.nowMs);
    if (!existing || existing.ownerId !== normalized.ownerId ||
      (normalized.exportAttempt !== undefined && normalized.exportAttempt !== existing.exportAttempt) ||
      (!normalized.release && (existing.phase !== 'running' || normalized.phase !== 'delivering')) ||
      (normalized.release && !['queued', 'running', 'delivering'].includes(existing.phase))) {
      throw new AuditExportLeaseConflictError();
    }
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
    const revision = storedRevision(initial.get(revisionKey(key)));
    const normalized = canonicalLeaseOptions(options, revision);
    const existing = activeExportLease(initial.get(exportLeaseKey(key)), key, revision, normalized.nowMs);
    if (!existing || existing.ownerId !== normalized.ownerId) return false;
    initial.delete(exportLeaseKey(key));
    return true;
  };
  const getExportLeaseState = (id, options) => {
    const key = validId(id);
    const revision = storedRevision(initial.get(revisionKey(key)));
    const instant = canonicalLeaseNow(options?.now);
    const existing = initial.has(key)
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
    const revision = storedRevision(initial.get(revisionKey(key)));
    if (!initial.has(key) || revision !== expected) throw new AuditRevisionConflictError();
    const normalized = canonicalLeaseOptions(options, revision, options?.phase ?? 'delivering');
    const existing = activeExportLease(initial.get(exportLeaseKey(key)), key, revision, normalized.nowMs);
    if (!existing || existing.ownerId !== normalized.ownerId || existing.phase !== normalized.phase ||
      (normalized.exportAttempt !== undefined && normalized.exportAttempt !== existing.exportAttempt)) {
      throw new AuditExportLeaseConflictError();
    }
    return {
      active: true, phase: existing.phase, retryAt: existing.expiresAt,
      revision, exportAttempt: existing.exportAttempt,
    };
  };
  const recordExportDelivery = (id, snapshotCapability, options) => {
    const key = validId(id);
    const expected = capabilityRevision(snapshotCapability, owner, key);
    const revision = storedRevision(initial.get(revisionKey(key)));
    if (!initial.has(key) || revision !== expected) throw new AuditRevisionConflictError();
    const normalized = canonicalDeliveryOptions(options);
    const existing = activeExportLease(initial.get(exportLeaseKey(key)), key, revision, normalized.nowMs);
    if (!existing || existing.ownerId !== normalized.ownerId || existing.exportAttempt !== normalized.exportAttempt ||
      existing.phase !== 'delivering') throw new AuditExportLeaseConflictError();
    const entries = updateDeliveryEntries(
      canonicalDeliveryJournal(initial.get(exportDeliveryKey(key)), key), normalized,
    );
    const latest = initial.get(LATEST_KEY);
    const nextLatest = latest?.auditId === key ? pendingCleanupLatest(latest, entries) : undefined;
    initial.set(exportDeliveryKey(key), deliveryJournalRecord(key, entries));
    if (nextLatest !== undefined) initial.set(LATEST_KEY, nextLatest);
    return storageClone(entries.find(entry => entry.ownerId === normalized.ownerId &&
      entry.exportAttempt === normalized.exportAttempt && entry.format === normalized.format));
  };
  const resolveExportDelivery = (id, options) => {
    const key = validId(id);
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
    return canonicalDeliveryJournal(initial.get(exportDeliveryKey(key)), key);
  };
  const deleteStoredAudit = key => {
    initial.delete(key);
    initial.delete(revisionKey(key));
    initial.delete(exportLeaseKey(key));
    initial.delete(exportAttemptKey(key));
    initial.delete(exportDeliveryKey(key));
    retention.delete(key);
    if (initial.get(LATEST_KEY)?.auditId === key) initial.delete(LATEST_KEY);
  };
  const hasDeliveryWork = (key, nowMs) => {
    const revision = storedRevision(initial.get(revisionKey(key)));
    const lease = activeExportLease(initial.get(exportLeaseKey(key)), key, revision, nowMs);
    const journal = canonicalDeliveryJournal(initial.get(exportDeliveryKey(key)), key);
    return Boolean(lease) || journal.length > 0;
  };
  const markAuditInterrupted = (id, latestState, options) => {
    const key = validId(id);
    const failedLatest = interruptedLatest(key, latestState);
    const instant = canonicalLeaseNow(options?.now);
    const model = initial.get(key);
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
    assertFinalizationCorrelation(key, model, latestState);
    if (options?.clearDeliveryJournal !== true || typeof options?.deleteAfterCompleteExport !== 'boolean') {
      throw new TypeError('Finalização de exportação inválida.');
    }
    const revision = capabilityRevision(snapshotCapability, owner, key);
    const currentRevision = storedRevision(initial.get(revisionKey(key)));
    if (!initial.has(key) || currentRevision !== revision) throw new AuditRevisionConflictError();
    const normalized = canonicalLeaseOptions({ ...options, release: true }, revision);
    const existing = activeExportLease(initial.get(exportLeaseKey(key)), key, revision, normalized.nowMs);
    if (!existing || existing.ownerId !== normalized.ownerId ||
      existing.exportAttempt !== normalized.exportAttempt ||
      !['queued', 'running', 'delivering'].includes(existing.phase)) {
      throw new AuditExportLeaseConflictError();
    }
    const entries = canonicalDeliveryJournal(initial.get(exportDeliveryKey(key)), key);
    if (entries.some(entry => entry.ownerId !== existing.ownerId ||
      entry.exportAttempt !== existing.exportAttempt || entry.state !== 'terminal')) {
      throw new AuditExportLeaseConflictError('Existem arquivos obsoletos pendentes de reconciliação.');
    }
    const metadata = validateRetentionMetadata(retention.get(key), key);
    const shouldDelete = metadata.deleteAfterCompleteExport === true &&
      options.deleteAfterCompleteExport === true &&
      isCompleteTerminalDelivery(entries, existing.ownerId, existing.exportAttempt);
    if (shouldDelete) {
      storageClone(model);
      if (latestState !== undefined) storageClone(latestState);
      deleteStoredAudit(key);
      return { deleted: true };
    }
    const committed = commitAuditIfRevisionWithExportLease(
      key,
      model,
      latestState,
      snapshotCapability,
      { ...options, release: true },
    );
    return { ...committed, deleted: false };
  };
  return {
    async setAudit(id, model, options) { return writeAudit(id, model, undefined, undefined, options); },
    async getAudit(id) { return snapshot(id).model; },
    async getAuditSnapshot(id) { return snapshot(id); },
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
      return writeAudit(id, model, undefined, snapshotCapability, { review: true });
    },
    async acquireExportLease(id, snapshotCapability, options) {
      return acquireExportLease(id, snapshotCapability, options);
    },
    async claimExportLease(id, snapshotCapability, options) {
      return claimExportLease(id, snapshotCapability, options);
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
    async getAuditRetention(id) {
      const key = validId(id);
      const value = retention.get(key);
      return value === undefined ? undefined : storageClone(validateRetentionMetadata(value, key));
    },
    async setRetentionIntent(id, snapshotCapability, options) {
      const key = validId(id);
      canonicalRetentionInstant(options?.now);
      if (typeof options?.deleteAfterCompleteExport !== 'boolean') {
        throw new TypeError('Intenção de retenção inválida.');
      }
      const expected = capabilityRevision(snapshotCapability, owner, key);
      const revision = storedRevision(initial.get(revisionKey(key)));
      if (!initial.has(key) || revision !== expected) throw new AuditRevisionConflictError();
      const current = validateRetentionMetadata(retention.get(key), key);
      const next = Object.freeze({
        ...current,
        deleteAfterCompleteExport: options.deleteAfterCompleteExport,
      });
      retention.set(key, next);
      return {
        revision,
        capability: mintAuditSnapshot(owner, key, initial.get(key), revision).capability,
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
        initial.delete(RETENTION_CLEANUP_CURSOR_KEY);
        candidates = expired.slice(0, limit);
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
      const revision = storedRevision(initial.get(revisionKey(key)));
      if (!initial.has(key) || revision !== expected) throw new AuditRevisionConflictError();
      if (hasDeliveryWork(key, instant.milliseconds)) throw new AuditDeleteBusyError();
      deleteStoredAudit(key);
      return { deleted: true };
    },
    async deleteAllAudits(options) {
      const instant = canonicalRetentionInstant(options?.now);
      const auditIds = [...retention.keys()].filter(key => initial.has(key));
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
    commitAuditIfRevision: unavailable,
    commitAuditReviewIfRevision: unavailable,
    acquireExportLease: unavailable,
    claimExportLease: unavailable,
    commitAuditIfRevisionWithExportLease: unavailable,
    releaseExportLease: unavailable,
    getExportLeaseState: unavailable,
    assertExportLease: unavailable,
    recordExportDelivery: unavailable,
    resolveExportDelivery: unavailable,
    getExportDeliveryJournal: unavailable,
    getAuditRetention: unavailable,
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
  const open = async () => {
    if (database) return database;
    if (opening) return opening;
    let request;
    try {
      request = indexedDbBoundary(() => factory.open(DB_NAME, 2));
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
  const getAuditSnapshot = async id => {
    const key = validId(id);
    const values = await readKeys([key, revisionKey(key)]);
    return mintAuditSnapshot(owner, key, values.get(key), values.get(revisionKey(key)));
  };
  const mutateAudit = async (id, model, latestState, snapshotCapability, options = {}) => {
    const key = validId(id);
    const expected = snapshotCapability === undefined
      ? undefined
      : capabilityRevision(snapshotCapability, owner, key);
    const modelClone = storageClone(model);
    const latestClone = latestState === undefined ? undefined : storageClone(latestState);
    const db = await open();
    return new Promise((resolve, reject) => {
      let settled = false;
      let currentModelRead = false;
      let revisionRead = false;
      let retentionRead = false;
      let currentModel;
      let currentRevisionValue;
      let currentRetention;
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
      const latestRequest = options.review === true ? store.get(LATEST_KEY) : null;
      const apply = () => {
        if (!currentModelRead || !revisionRead || !retentionRead || !latestRead || nextRevision !== null || conflict) return;
        let currentRevision;
        try { currentRevision = storedRevision(currentRevisionValue); } catch (error) {
          finish(reject, error);
          return;
        }
        if (expected !== undefined && (currentModel === undefined || currentRevision !== expected)) {
          conflict = true;
          return;
        }
        const candidateRevision = currentRevision + 1;
        let reviewLatest;
        let nextRetention;
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
        } catch (error) {
          finish(reject, error);
          try { transaction.abort(); } catch {}
          return;
        }
        nextRevision = candidateRevision;
        store.put(modelClone, key);
        store.put(nextRevision, revisionKey(key));
        if (currentRetention === undefined) retentionStore.put(nextRetention);
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
        try { revision = storedRevision(currentRevisionValue); } catch (error) { finish(reject, error); return; }
        if (currentModel === undefined || revision !== expected) { revisionConflict = true; return; }
        const existing = activeExportLease(currentLease, key, revision, normalized.nowMs);
        if (existing) {
          result = {
            acquired: false, busy: true, retryAt: existing.expiresAt,
            revision, exportAttempt: existing.exportAttempt,
          };
          return;
        }
        let exportAttempt;
        try { exportAttempt = nextExportAttempt(currentAttempt, currentLatest, key); } catch (error) {
          finish(reject, error);
          return;
        }
        let deliveryEntries;
        try { deliveryEntries = canonicalDeliveryJournal(currentDelivery, key); } catch (error) {
          finish(reject, error);
          return;
        }
        const lease = exportLeaseRecord(key, { ...normalized, exportAttempt });
        store.put(lease, exportLeaseKey(key));
        store.put(exportAttempt, exportAttemptKey(key));
        if (normalized.latestState !== undefined) {
          store.put(pendingCleanupLatest({ ...normalized.latestState, exportAttempt }, deliveryEntries), LATEST_KEY);
        }
        result = { acquired: true, busy: false, revision, exportAttempt, expiresAt: lease.expiresAt };
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

  const mutateWithExportLease = async (id, model, latestState, snapshotCapability, options, claimOnly = false) => {
    const key = validId(id);
    const expected = capabilityRevision(snapshotCapability, owner, key);
    const normalized = canonicalLeaseOptions(
      claimOnly ? { ...options, phase: 'running' } : options,
      expected,
      claimOnly ? 'running' : 'delivering',
    );
    const modelClone = claimOnly ? null : storageClone(model);
    const latestClone = latestState === undefined ? undefined : storageClone(latestState);
    const db = await open();
    return new Promise((resolve, reject) => {
      let settled = false;
      let modelRead = false;
      let revisionRead = false;
      let leaseRead = false;
      let deliveryRead = false;
      let retentionRead = false;
      let currentModel;
      let currentRevisionValue;
      let currentLease;
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
      const deliveryRequest = store.get(exportDeliveryKey(key));
      const retentionRequest = retentionStore.get(key);
      const apply = () => {
        if (!modelRead || !revisionRead || !leaseRead || !deliveryRead || !retentionRead || result || revisionConflict || leaseConflict) return;
        let revision;
        try { revision = storedRevision(currentRevisionValue); } catch (error) { finish(reject, error); return; }
        if (currentModel === undefined || revision !== expected) { revisionConflict = true; return; }
        const existing = activeExportLease(currentLease, key, revision, normalized.nowMs);
        const attemptMatches = normalized.exportAttempt === undefined || normalized.exportAttempt === existing?.exportAttempt;
        const allowed = claimOnly
          ? attemptMatches && existing?.ownerId === normalized.ownerId && existing.phase === 'queued'
          : attemptMatches && existing?.ownerId === normalized.ownerId && (normalized.release
              ? ['queued', 'running', 'delivering'].includes(existing.phase)
              : existing.phase === 'running' && normalized.phase === 'delivering');
        if (!allowed) { leaseConflict = true; return; }
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
          if (latestClone !== undefined) {
            store.put(pendingCleanupLatest(
              { ...latestClone, exportAttempt: existing.exportAttempt }, deliveryEntries,
            ), LATEST_KEY);
          }
          result = {
            claimed: true, revision, exportAttempt: existing.exportAttempt,
            expiresAt: lease.expiresAt,
          };
          return;
        }
        const nextRevision = revision + 1;
        store.put(modelClone, key);
        store.put(nextRevision, revisionKey(key));
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
      deliveryRequest.onsuccess = () => { deliveryRead = true; currentDelivery = deliveryRequest.result; apply(); };
      retentionRequest.onsuccess = () => { retentionRead = true; currentRetention = retentionRequest.result; apply(); };
      modelRequest.onerror = () => finish(reject, new AuditStorageUnavailableError());
      revisionRequest.onerror = () => finish(reject, new AuditStorageUnavailableError());
      leaseRequest.onerror = () => finish(reject, new AuditStorageUnavailableError());
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
      let revisionRead = false;
      let leaseRead = false;
      let released = false;
      const finish = (handler, value) => { if (!settled) { settled = true; handler(value); } };
      const transaction = indexedDbBoundary(() => db.transaction(STORE_NAME, 'readwrite'));
      const store = indexedDbObjectStore(transaction, () => transaction.objectStore(STORE_NAME));
      const revisionRequest = store.get(revisionKey(key));
      const leaseRequest = store.get(exportLeaseKey(key));
      const apply = () => {
        if (!revisionRead || !leaseRead) return;
        let revision;
        try { revision = storedRevision(revisionValue); } catch (error) { finish(reject, error); return; }
        const existing = activeExportLease(leaseValue, key, revision, normalized.nowMs);
        if (existing?.ownerId === normalized.ownerId) { store.delete(exportLeaseKey(key)); released = true; }
      };
      revisionRequest.onsuccess = () => { revisionRead = true; revisionValue = revisionRequest.result; apply(); };
      leaseRequest.onsuccess = () => { leaseRead = true; leaseValue = leaseRequest.result; apply(); };
      revisionRequest.onerror = () => finish(reject, new AuditStorageUnavailableError());
      leaseRequest.onerror = () => finish(reject, new AuditStorageUnavailableError());
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
    const existing = values.get(key) === undefined
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
    const values = await readKeys([key, revisionKey(key), exportLeaseKey(key)]);
    const revision = storedRevision(values.get(revisionKey(key)));
    if (values.get(key) === undefined || revision !== expected) throw new AuditRevisionConflictError();
    const existing = activeExportLease(values.get(exportLeaseKey(key)), key, revision, normalized.nowMs);
    if (!existing || existing.ownerId !== normalized.ownerId || existing.phase !== normalized.phase ||
      (normalized.exportAttempt !== undefined && normalized.exportAttempt !== existing.exportAttempt)) {
      throw new AuditExportLeaseConflictError();
    }
    return {
      active: true, phase: existing.phase, retryAt: existing.expiresAt,
      revision, exportAttempt: existing.exportAttempt,
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
      let deliveryRead = false;
      let latestRead = false;
      let currentModel;
      let currentRevisionValue;
      let currentLease;
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
      const deliveryRequest = store.get(exportDeliveryKey(key));
      const latestRequest = store.get(LATEST_KEY);
      const apply = () => {
        if (!modelRead || !revisionRead || !leaseRead || !deliveryRead || !latestRead || result || revisionConflict || leaseConflict) return;
        let revision;
        try { revision = storedRevision(currentRevisionValue); } catch (error) { finish(reject, error); return; }
        if (currentModel === undefined || revision !== expected) { revisionConflict = true; return; }
        const lease = activeExportLease(currentLease, key, revision, normalized.nowMs);
        if (!lease || lease.ownerId !== normalized.ownerId || lease.exportAttempt !== normalized.exportAttempt ||
          lease.phase !== 'delivering') { leaseConflict = true; return; }
        let entries;
        try {
          entries = updateDeliveryEntries(canonicalDeliveryJournal(currentDelivery, key), normalized);
        } catch (error) { finish(reject, error); return; }
        store.put(deliveryJournalRecord(key, entries), exportDeliveryKey(key));
        if (currentLatest?.auditId === key) store.put(pendingCleanupLatest(currentLatest, entries), LATEST_KEY);
        result = storageClone(entries.find(entry => entry.ownerId === normalized.ownerId &&
          entry.exportAttempt === normalized.exportAttempt && entry.format === normalized.format));
      };
      modelRequest.onsuccess = () => { modelRead = true; currentModel = modelRequest.result; apply(); };
      revisionRequest.onsuccess = () => { revisionRead = true; currentRevisionValue = revisionRequest.result; apply(); };
      leaseRequest.onsuccess = () => { leaseRead = true; currentLease = leaseRequest.result; apply(); };
      deliveryRequest.onsuccess = () => { deliveryRead = true; currentDelivery = deliveryRequest.result; apply(); };
      latestRequest.onsuccess = () => { latestRead = true; currentLatest = latestRequest.result; apply(); };
      modelRequest.onerror = () => finish(reject, new AuditStorageUnavailableError());
      revisionRequest.onerror = () => finish(reject, new AuditStorageUnavailableError());
      leaseRequest.onerror = () => finish(reject, new AuditStorageUnavailableError());
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
      let deliveryRead = false;
      let latestRead = false;
      let currentDelivery;
      let currentLatest;
      let result = null;
      const finish = (handler, value) => { if (!settled) { settled = true; handler(value); } };
      const transaction = indexedDbBoundary(() => db.transaction(STORE_NAME, 'readwrite'));
      const store = indexedDbObjectStore(transaction, () => transaction.objectStore(STORE_NAME));
      const deliveryRequest = store.get(exportDeliveryKey(key));
      const latestRequest = store.get(LATEST_KEY);
      const apply = () => {
        if (!deliveryRead || !latestRead || result !== null) return;
        let current;
        try { current = canonicalDeliveryJournal(currentDelivery, key); } catch (error) { finish(reject, error); return; }
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
      deliveryRequest.onsuccess = () => { deliveryRead = true; currentDelivery = deliveryRequest.result; apply(); };
      latestRequest.onsuccess = () => { latestRead = true; currentLatest = latestRequest.result; apply(); };
      deliveryRequest.onerror = () => finish(reject, new AuditStorageUnavailableError());
      latestRequest.onerror = () => finish(reject, new AuditStorageUnavailableError());
      transaction.oncomplete = () => finish(resolve, result === true);
      transaction.onerror = () => finish(reject, new AuditStorageUnavailableError());
      transaction.onabort = () => finish(reject, new AuditStorageUnavailableError());
    });
  };
  const getExportDeliveryJournal = async id => {
    const key = validId(id);
    return canonicalDeliveryJournal(await get(exportDeliveryKey(key)), key);
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
        try { revision = storedRevision(revisionValue); } catch (error) { finish(reject, error); return; }
        if (modelValue === undefined || revision !== expected) { conflict = true; return; }
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
          model: storageClone(modelValue, transaction),
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
        try { revision = storedRevision(revisionValue); } catch (error) { finish(reject, error); return; }
        if (modelValue === undefined || revision !== expected) { conflict = true; return; }
        try {
          busy = Boolean(activeExportLease(leaseValue, key, revision, instant.milliseconds)) ||
            canonicalDeliveryJournal(deliveryValue, key).length > 0;
        } catch { busy = true; }
        if (busy) return;
        applied = true;
        auditStore.delete(key);
        auditStore.delete(revisionKey(key));
        auditStore.delete(exportLeaseKey(key));
        auditStore.delete(exportAttemptKey(key));
        auditStore.delete(exportDeliveryKey(key));
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
        const workKeys = auditKeys.filter(key => typeof key === 'string' &&
          (key.startsWith(EXPORT_LEASE_KEY_PREFIX) || key.startsWith(EXPORT_DELIVERY_KEY_PREFIX)));
        valueReadsPending = workKeys.length;
        if (valueReadsPending === 0) {
          deleted = retentionKeys.length;
          auditStore.clear();
          retentionStore.clear();
          return;
        }
        for (const workKey of workKeys) {
          const request = auditStore.get(workKey);
          request.onsuccess = () => {
            try {
              if (workKey.startsWith(EXPORT_LEASE_KEY_PREFIX)) {
                const auditId = workKey.slice(EXPORT_LEASE_KEY_PREFIX.length);
                const lease = request.result;
                if (lease && activeExportLease(lease, auditId, lease.revision, instant.milliseconds)) busy = true;
              } else {
                const auditId = workKey.slice(EXPORT_DELIVERY_KEY_PREFIX.length);
                if (canonicalDeliveryJournal(request.result, auditId).length > 0) busy = true;
              }
            } catch { busy = true; }
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
    assertFinalizationCorrelation(key, model, latestState);
    if (finalizeOptions?.clearDeliveryJournal !== true ||
      typeof finalizeOptions?.deleteAfterCompleteExport !== 'boolean') {
      throw new TypeError('Finalização de exportação inválida.');
    }
    const expected = capabilityRevision(snapshotCapability, owner, key);
    const normalized = canonicalLeaseOptions({ ...finalizeOptions, release: true }, expected);
    const modelClone = storageClone(model);
    const latestClone = latestState === undefined ? undefined : storageClone(latestState);
    const db = await open();
    return new Promise((resolve, reject) => {
      let pending = 6;
      let modelValue;
      let revisionValue;
      let leaseValue;
      let deliveryValue;
      let latestValue;
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
        let metadata;
        let entries;
        try {
          revision = storedRevision(revisionValue);
          metadata = validateRetentionMetadata(retentionValue, key);
          entries = canonicalDeliveryJournal(deliveryValue, key);
        } catch (error) { finish(reject, error); return; }
        if (modelValue === undefined || revision !== expected) { conflict = true; return; }
        const lease = activeExportLease(leaseValue, key, revision, normalized.nowMs);
        if (!lease || lease.ownerId !== normalized.ownerId || lease.exportAttempt !== normalized.exportAttempt ||
          !['queued', 'running', 'delivering'].includes(lease.phase) || entries.some(entry =>
            entry.ownerId !== lease.ownerId || entry.exportAttempt !== lease.exportAttempt || entry.state !== 'terminal')) {
          leaseConflict = true;
          return;
        }
        const shouldDelete = metadata.deleteAfterCompleteExport === true &&
          finalizeOptions.deleteAfterCompleteExport === true &&
          isCompleteTerminalDelivery(entries, lease.ownerId, lease.exportAttempt);
        if (shouldDelete) {
          auditStore.delete(key);
          auditStore.delete(revisionKey(key));
          auditStore.delete(exportLeaseKey(key));
          auditStore.delete(exportAttemptKey(key));
          auditStore.delete(exportDeliveryKey(key));
          if (latestValue?.auditId === key) auditStore.delete(LATEST_KEY);
          retentionStore.delete(key);
          result = { deleted: true };
          return;
        }
        const nextRevision = revision + 1;
        auditStore.put(modelClone, key);
        auditStore.put(nextRevision, revisionKey(key));
        auditStore.delete(exportLeaseKey(key));
        auditStore.delete(exportDeliveryKey(key));
        if (latestClone !== undefined) {
          auditStore.put(pendingCleanupLatest({ ...latestClone, exportAttempt: lease.exportAttempt }, []), LATEST_KEY);
        }
        result = { deleted: false, revision: nextRevision, model: modelClone };
      };
      const requests = [
        [auditStore.get(key), value => { modelValue = value; }],
        [auditStore.get(revisionKey(key)), value => { revisionValue = value; }],
        [auditStore.get(exportLeaseKey(key)), value => { leaseValue = value; }],
        [auditStore.get(exportDeliveryKey(key)), value => { deliveryValue = value; }],
        [auditStore.get(LATEST_KEY), value => { latestValue = value; }],
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
        const revisionRequest = auditStore.get(revisionKey(metadata.auditId));
        const leaseRequest = auditStore.get(exportLeaseKey(metadata.auditId));
        const deliveryRequest = auditStore.get(exportDeliveryKey(metadata.auditId));
        let revisionRead = false;
        let leaseRead = false;
        let deliveryRead = false;
        let revisionValue;
        let leaseValue;
        let deliveryValue;
        const decide = () => {
          if (!revisionRead || !leaseRead || !deliveryRead) return;
          let busy = true;
          try {
            const revision = storedRevision(revisionValue);
            busy = Boolean(activeExportLease(leaseValue, metadata.auditId, revision, instant.milliseconds)) ||
              canonicalDeliveryJournal(deliveryValue, metadata.auditId).length > 0;
          } catch {
            busy = true;
          }
          if (busy) blocked += 1;
          else {
            auditStore.delete(metadata.auditId);
            auditStore.delete(revisionKey(metadata.auditId));
            auditStore.delete(exportLeaseKey(metadata.auditId));
            auditStore.delete(exportAttemptKey(metadata.auditId));
            auditStore.delete(exportDeliveryKey(metadata.auditId));
            const latestRequest = auditStore.get(LATEST_KEY);
            latestRequest.onsuccess = () => {
              if (latestRequest.result?.auditId === metadata.auditId) auditStore.delete(LATEST_KEY);
            };
            retentionStore.delete(metadata.auditId);
            deleted += 1;
          }
        };
        revisionRequest.onsuccess = () => { revisionRead = true; revisionValue = revisionRequest.result; decide(); };
        leaseRequest.onsuccess = () => { leaseRead = true; leaseValue = leaseRequest.result; decide(); };
        deliveryRequest.onsuccess = () => { deliveryRead = true; deliveryValue = deliveryRequest.result; decide(); };
        revisionRequest.onerror = leaseRequest.onerror = deliveryRequest.onerror = () => finish(reject, new AuditStorageUnavailableError());
      };
      transaction.oncomplete = () => {
        if (!countRead || !markerRead || !cursorFinished) finish(reject, new AuditStorageUnavailableError());
        else finish(resolve, { scanned, deleted, remaining: Math.max(0, initialCount - deleted), blocked });
      };
      transaction.onerror = () => finish(reject, new AuditStorageUnavailableError());
      transaction.onabort = () => finish(reject, new AuditStorageUnavailableError());
    });
  };
  return {
    setAudit(id, model, options) { return mutateAudit(id, model, undefined, undefined, options); },
    getAudit(id) { return get(validId(id)); },
    getAuditSnapshot,
    setLatest(state) { return put(LATEST_KEY, state); },
    getLatest() { return get(LATEST_KEY); },
    markAuditInterrupted,
    commitAudit(id, model, latestState, options) {
      return mutateAudit(id, model, latestState, undefined, options);
    },
    commitAuditIfRevision(id, model, latestState, snapshotCapability) {
      return mutateAudit(id, model, latestState, snapshotCapability);
    },
    commitAuditReviewIfRevision(id, model, snapshotCapability) {
      return mutateAudit(id, model, undefined, snapshotCapability, { review: true });
    },
    acquireExportLease,
    claimExportLease(id, snapshotCapability, options) {
      return mutateWithExportLease(id, null, options?.latestState, snapshotCapability, options, true);
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
    getAuditRetention,
    setRetentionIntent,
    cleanupExpiredAudits,
    deleteAudit,
    deleteAllAudits,
    finalizeExportAndMaybeDelete,
  };
}
