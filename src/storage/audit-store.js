const DB_NAME = 'audita-mt';
const STORE_NAME = 'audits';
const LATEST_KEY = '__latest__';
const REVISION_KEY_PREFIX = '__audit_revision__:';
const EXPORT_LEASE_KEY_PREFIX = '__audit_export_lease__:';
const EXPORT_ATTEMPT_KEY_PREFIX = '__audit_export_attempt__:';
const EXPORT_DELIVERY_KEY_PREFIX = '__audit_export_delivery__:';
const DEFAULT_EXPORT_LEASE_TTL_MS = 2 * 60 * 1000;
const MAX_EXPORT_LEASE_TTL_MS = 10 * 60 * 1000;
const EXPORT_CLEANUP_MESSAGE = 'Um arquivo obsoleto da exportação não pôde ser removido com confirmação; tente gerar o relatório novamente.';
const EXPORT_FORMATS = new Set(['html', 'json', 'csv', 'pdf']);
const AUDIT_SNAPSHOT_CAPABILITIES = new WeakMap();

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function validId(id) {
  if (typeof id !== 'string' || !id.trim()) throw new TypeError('Identificador de auditoria inválido.');
  const value = id.trim();
  if (value === LATEST_KEY || value.startsWith(REVISION_KEY_PREFIX) ||
    value.startsWith(EXPORT_LEASE_KEY_PREFIX) || value.startsWith(EXPORT_ATTEMPT_KEY_PREFIX) ||
    value.startsWith(EXPORT_DELIVERY_KEY_PREFIX)) {
    throw new TypeError('Identificador de auditoria reservado ou inválido.');
  }
  return value;
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
    latestState: options?.latestState === undefined ? undefined : clone(options.latestState),
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
  return { schemaVersion: 1, auditId, entries: clone(entries) };
}

function pendingCleanupLatest(latest, entries) {
  if (latest === undefined || !latest || typeof latest !== 'object' || Array.isArray(latest)) return latest;
  const next = clone(latest);
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
  const latest = clone(value);
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
  const privateModel = clone(model);
  const capability = Object.freeze(Object.create(null));
  AUDIT_SNAPSHOT_CAPABILITIES.set(capability, Object.freeze({
    owner,
    auditId,
    revision: canonicalRevision,
    model: privateModel,
  }));
  return { model: clone(privateModel), revision: canonicalRevision, capability };
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
  return record ? { auditId: record.auditId, revision: record.revision, model: clone(record.model) } : null;
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

export function createInMemoryAuditStore(initial = new Map()) {
  const owner = Object.freeze(Object.create(null));
  const snapshot = id => {
    const key = validId(id);
    return mintAuditSnapshot(owner, key, initial.get(key), initial.get(revisionKey(key)));
  };
  const writeAudit = (id, model, latestState, snapshotCapability, options = {}) => {
    const key = validId(id);
    const modelClone = clone(model);
    const latestClone = latestState === undefined ? undefined : clone(latestState);
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
    initial.set(key, modelClone);
    initial.set(revisionKey(key), revision);
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
          { ...clone(latestState), exportAttempt: existing.exportAttempt },
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
    return clone(entries.find(entry => entry.ownerId === normalized.ownerId &&
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
  return {
    async setAudit(id, model) { return writeAudit(id, model); },
    async getAudit(id) { return snapshot(id).model; },
    async getAuditSnapshot(id) { return snapshot(id); },
    async setLatest(state) { initial.set(LATEST_KEY, clone(state)); },
    async getLatest() { return clone(initial.get(LATEST_KEY)); },
    async commitAudit(id, model, latestState) {
      return writeAudit(id, model, latestState);
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
    async getExportDeliveryJournal(id) { return clone(getExportDeliveryJournal(id)); },
  };
}

export function createAuditStore(options = {}) {
  const factory = options.indexedDB ?? globalThis.indexedDB;
  if (!factory || typeof factory.open !== 'function') return createInMemoryAuditStore(options.fallback);
  let database = null;
  let opening = null;
  const owner = Object.freeze(Object.create(null));
  const open = async () => {
    if (database) return database;
    if (opening) return opening;
    opening = new Promise((resolve, reject) => {
      const request = factory.open(DB_NAME, 1);
      let settled = false;
      const fail = error => {
        if (settled) return;
        settled = true;
        opening = null;
        reject(error);
      };
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
      };
      request.onblocked = () => fail(new Error('A abertura do armazenamento foi bloqueada.'));
      request.onerror = () => fail(request.error || new Error('Não foi possível abrir o armazenamento de auditorias.'));
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
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      for (const [key, value] of entries) store.put(value, key);
      transaction.oncomplete = () => finish(resolve);
      transaction.onerror = () => finish(reject, transaction.error || new Error('Não foi possível salvar a auditoria.'));
      transaction.onabort = () => finish(reject, transaction.error || new Error('A transação de auditoria foi abortada.'));
    });
  };
  const put = (key, value) => write([[key, clone(value)]]);
  const readKeys = async keys => {
    const db = await open();
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (handler, value) => { if (!settled) { settled = true; handler(value); } };
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const values = new Map();
      for (const key of keys) {
        const request = store.get(key);
        request.onsuccess = () => values.set(key, clone(request.result));
        request.onerror = () => finish(reject, request.error || new Error('Não foi possível ler a auditoria.'));
      }
      transaction.oncomplete = () => finish(resolve, values);
      transaction.onerror = () => finish(reject, transaction.error || new Error('Não foi possível ler a auditoria.'));
      transaction.onabort = () => finish(reject, transaction.error || new Error('A leitura da auditoria foi abortada.'));
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
    const modelClone = clone(model);
    const latestClone = latestState === undefined ? undefined : clone(latestState);
    const db = await open();
    return new Promise((resolve, reject) => {
      let settled = false;
      let currentModelRead = false;
      let revisionRead = false;
      let currentModel;
      let currentRevisionValue;
      let latestRead = options.review !== true;
      let currentLatest;
      let nextRevision = null;
      let conflict = false;
      const finish = (handler, value) => { if (!settled) { settled = true; handler(value); } };
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const currentRequest = store.get(key);
      const revisionRequest = store.get(revisionKey(key));
      const latestRequest = options.review === true ? store.get(LATEST_KEY) : null;
      const apply = () => {
        if (!currentModelRead || !revisionRead || !latestRead || nextRevision !== null || conflict) return;
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
        try {
          reviewLatest = options.review === true
            ? reviewLatestState(currentLatest, key, modelClone, candidateRevision)
            : undefined;
        } catch (error) {
          finish(reject, error);
          try { transaction.abort(); } catch {}
          return;
        }
        nextRevision = candidateRevision;
        store.put(modelClone, key);
        store.put(nextRevision, revisionKey(key));
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
      if (latestRequest) {
        latestRequest.onsuccess = () => {
          latestRead = true;
          currentLatest = latestRequest.result;
          apply();
        };
        latestRequest.onerror = () => finish(reject, latestRequest.error || new Error('Não foi possível ler o estado mais recente da auditoria.'));
      }
      currentRequest.onerror = () => finish(reject, currentRequest.error || new Error('Não foi possível ler a auditoria atual.'));
      revisionRequest.onerror = () => finish(reject, revisionRequest.error || new Error('Não foi possível ler a revisão da auditoria.'));
      transaction.oncomplete = () => {
        if (conflict) finish(reject, new AuditRevisionConflictError());
        else if (nextRevision === null) finish(reject, new Error('A atualização da auditoria não foi concluída.'));
        else finish(resolve, {
          revision: nextRevision,
          capability: mintAuditSnapshot(owner, key, modelClone, nextRevision).capability,
        });
      };
      transaction.onerror = () => finish(reject, transaction.error || new Error('Não foi possível salvar a auditoria.'));
      transaction.onabort = () => finish(reject, transaction.error || new Error('A transação de auditoria foi abortada.'));
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
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
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
      modelRequest.onerror = () => finish(reject, modelRequest.error || new Error('Não foi possível ler a auditoria atual.'));
      revisionRequest.onerror = () => finish(reject, revisionRequest.error || new Error('Não foi possível ler a revisão da auditoria.'));
      leaseRequest.onerror = () => finish(reject, leaseRequest.error || new Error('Não foi possível ler o lease da exportação.'));
      latestRequest.onerror = () => finish(reject, latestRequest.error || new Error('Não foi possível ler o estado mais recente da auditoria.'));
      attemptRequest.onerror = () => finish(reject, attemptRequest.error || new Error('Não foi possível ler a tentativa da exportação.'));
      deliveryRequest.onerror = () => finish(reject, deliveryRequest.error || new Error('Não foi possível ler o journal da entrega.'));
      transaction.oncomplete = () => revisionConflict
        ? finish(reject, new AuditRevisionConflictError())
        : result ? finish(resolve, result) : finish(reject, new Error('A reserva de exportação não foi concluída.'));
      transaction.onerror = () => finish(reject, transaction.error || new Error('Não foi possível reservar a exportação.'));
      transaction.onabort = () => finish(reject, transaction.error || new Error('A reserva de exportação foi abortada.'));
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
    const modelClone = claimOnly ? null : clone(model);
    const latestClone = latestState === undefined ? undefined : clone(latestState);
    const db = await open();
    return new Promise((resolve, reject) => {
      let settled = false;
      let modelRead = false;
      let revisionRead = false;
      let leaseRead = false;
      let deliveryRead = false;
      let currentModel;
      let currentRevisionValue;
      let currentLease;
      let currentDelivery;
      let result = null;
      let revisionConflict = false;
      let leaseConflict = false;
      const finish = (handler, value) => { if (!settled) { settled = true; handler(value); } };
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const modelRequest = store.get(key);
      const revisionRequest = store.get(revisionKey(key));
      const leaseRequest = store.get(exportLeaseKey(key));
      const deliveryRequest = store.get(exportDeliveryKey(key));
      const apply = () => {
        if (!modelRead || !revisionRead || !leaseRead || !deliveryRead || result || revisionConflict || leaseConflict) return;
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
      modelRequest.onerror = () => finish(reject, modelRequest.error || new Error('Não foi possível ler a auditoria atual.'));
      revisionRequest.onerror = () => finish(reject, revisionRequest.error || new Error('Não foi possível ler a revisão da auditoria.'));
      leaseRequest.onerror = () => finish(reject, leaseRequest.error || new Error('Não foi possível ler o lease da exportação.'));
      deliveryRequest.onerror = () => finish(reject, deliveryRequest.error || new Error('Não foi possível ler o journal da entrega.'));
      transaction.oncomplete = () => {
        if (revisionConflict) finish(reject, new AuditRevisionConflictError());
        else if (leaseConflict) finish(reject, new AuditExportLeaseConflictError());
        else if (result) finish(resolve, result);
        else finish(reject, new Error('A atualização exclusiva da exportação não foi concluída.'));
      };
      transaction.onerror = () => finish(reject, transaction.error || new Error('Não foi possível atualizar a exportação.'));
      transaction.onabort = () => finish(reject, transaction.error || new Error('A atualização da exportação foi abortada.'));
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
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
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
      revisionRequest.onerror = () => finish(reject, revisionRequest.error || new Error('Não foi possível ler a revisão da auditoria.'));
      leaseRequest.onerror = () => finish(reject, leaseRequest.error || new Error('Não foi possível ler o lease da exportação.'));
      transaction.oncomplete = () => finish(resolve, released);
      transaction.onerror = () => finish(reject, transaction.error || new Error('Não foi possível liberar a exportação.'));
      transaction.onabort = () => finish(reject, transaction.error || new Error('A liberação da exportação foi abortada.'));
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
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
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
        result = clone(entries.find(entry => entry.ownerId === normalized.ownerId &&
          entry.exportAttempt === normalized.exportAttempt && entry.format === normalized.format));
      };
      modelRequest.onsuccess = () => { modelRead = true; currentModel = modelRequest.result; apply(); };
      revisionRequest.onsuccess = () => { revisionRead = true; currentRevisionValue = revisionRequest.result; apply(); };
      leaseRequest.onsuccess = () => { leaseRead = true; currentLease = leaseRequest.result; apply(); };
      deliveryRequest.onsuccess = () => { deliveryRead = true; currentDelivery = deliveryRequest.result; apply(); };
      latestRequest.onsuccess = () => { latestRead = true; currentLatest = latestRequest.result; apply(); };
      modelRequest.onerror = () => finish(reject, modelRequest.error || new Error('Não foi possível ler a auditoria atual.'));
      revisionRequest.onerror = () => finish(reject, revisionRequest.error || new Error('Não foi possível ler a revisão da auditoria.'));
      leaseRequest.onerror = () => finish(reject, leaseRequest.error || new Error('Não foi possível ler o lease da exportação.'));
      deliveryRequest.onerror = () => finish(reject, deliveryRequest.error || new Error('Não foi possível ler o journal da entrega.'));
      latestRequest.onerror = () => finish(reject, latestRequest.error || new Error('Não foi possível ler o estado mais recente da auditoria.'));
      transaction.oncomplete = () => {
        if (revisionConflict) finish(reject, new AuditRevisionConflictError());
        else if (leaseConflict) finish(reject, new AuditExportLeaseConflictError());
        else if (result) finish(resolve, result);
        else finish(reject, new Error('O journal de entrega não foi atualizado.'));
      };
      transaction.onerror = () => finish(reject, transaction.error || new Error('Não foi possível atualizar o journal da entrega.'));
      transaction.onabort = () => finish(reject, transaction.error || new Error('A atualização do journal da entrega foi abortada.'));
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
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
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
      deliveryRequest.onerror = () => finish(reject, deliveryRequest.error || new Error('Não foi possível ler o journal da entrega.'));
      latestRequest.onerror = () => finish(reject, latestRequest.error || new Error('Não foi possível ler o estado mais recente da auditoria.'));
      transaction.oncomplete = () => finish(resolve, result === true);
      transaction.onerror = () => finish(reject, transaction.error || new Error('Não foi possível reconciliar o journal da entrega.'));
      transaction.onabort = () => finish(reject, transaction.error || new Error('A reconciliação do journal foi abortada.'));
    });
  };
  const getExportDeliveryJournal = async id => {
    const key = validId(id);
    return canonicalDeliveryJournal(await get(exportDeliveryKey(key)), key);
  };
  return {
    setAudit(id, model) { return mutateAudit(id, model); },
    getAudit(id) { return get(validId(id)); },
    getAuditSnapshot,
    setLatest(state) { return put(LATEST_KEY, state); },
    getLatest() { return get(LATEST_KEY); },
    commitAudit(id, model, latestState) {
      return mutateAudit(id, model, latestState);
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
  };
}
