export const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const LATEST_KEY = '__latest__';
const RETENTION_CLEANUP_CURSOR_KEY = '__audit_retention_cleanup__';
const PRIVATE_PREFIXES = Object.freeze([
  '__audit_revision__:',
  '__audit_export_lease__:',
  '__audit_export_attempt__:',
  '__audit_export_delivery__:',
  '__audit_checkpoint__:',
]);
const RETENTION_KEYS = Object.freeze([
  'auditId',
  'deleteAfterCompleteExport',
  'expiresAt',
  'firstPersistedAt',
  'schemaVersion',
]);
const UNIX_EPOCH = '1970-01-01T00:00:00.000Z';

export class AuditDeletionDeniedError extends TypeError {
  constructor() {
    super('Não foi possível autorizar a exclusão da auditoria.');
    this.code = 'AUDIT_DELETION_DENIED';
  }
}

function deletionDataRecord(value, keys) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError();
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== keys.length || ownKeys.some(key => !keys.includes(key))) throw new TypeError();
    const result = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new TypeError();
      result[key] = descriptor.value;
    }
    return result;
  } catch { throw new AuditDeletionDeniedError(); }
}

export function createDeletionTombstoneV1(value) {
  const { auditId, requestedAt } = deletionDataRecord(value, ['auditId', 'requestedAt']);
  return validateDeletionTombstoneV1({
    version: 1, auditId, reason: 'retention-expired', requestedAt,
    phase: 'transient-cleanup-pending', attempts: 0, lastAttemptAt: null,
  });
}

export function validateDeletionTombstoneV1(value, expectedAuditId) {
  try {
    const record = deletionDataRecord(value, [
      'version', 'auditId', 'reason', 'requestedAt', 'phase', 'attempts', 'lastAttemptAt',
    ]);
    canonicalAuditId(record.auditId);
    if (expectedAuditId !== undefined && record.auditId !== canonicalAuditId(expectedAuditId)) throw new TypeError();
    const requested = canonicalRetentionInstant(record.requestedAt);
    if (record.version !== 1 || record.reason !== 'retention-expired' ||
      record.phase !== 'transient-cleanup-pending' || !Number.isSafeInteger(record.attempts) || record.attempts < 0) throw new TypeError();
    if (record.attempts === 0) {
      if (record.lastAttemptAt !== null) throw new TypeError();
    } else if (canonicalRetentionInstant(record.lastAttemptAt).milliseconds < requested.milliseconds) throw new TypeError();
    return Object.freeze(record);
  } catch { throw new AuditDeletionDeniedError(); }
}

export function isPrivateAuditKey(value) {
  return value === LATEST_KEY || value === RETENTION_CLEANUP_CURSOR_KEY ||
    PRIVATE_PREFIXES.some(prefix => value?.startsWith?.(prefix));
}

export function canonicalAuditId(value) {
  if (typeof value !== 'string' || value !== value.trim() ||
    !/^[A-Za-z0-9._:-]{1,200}$/u.test(value) || isPrivateAuditKey(value)) {
    throw new TypeError('Identificador de auditoria inválido.');
  }
  return value;
}

export function canonicalRetentionInstant(value) {
  if (typeof value !== 'string') throw new TypeError('Instante canônico de retenção inválido.');
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new TypeError('Instante canônico de retenção inválido.');
  }
  return { iso: value, milliseconds: parsed.getTime() };
}

export function createRetentionMetadata(auditId, firstPersistedAt, deleteAfterCompleteExport = false) {
  const id = canonicalAuditId(auditId);
  const instant = canonicalRetentionInstant(firstPersistedAt);
  if (typeof deleteAfterCompleteExport !== 'boolean') {
    throw new TypeError('Intenção do metadado de retenção inválida.');
  }
  return Object.freeze({
    auditId: id,
    schemaVersion: 1,
    firstPersistedAt: instant.iso,
    expiresAt: new Date(instant.milliseconds + RETENTION_MS).toISOString(),
    deleteAfterCompleteExport,
  });
}

export function validateRetentionMetadata(value, expectedAuditId) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(RETENTION_KEYS)) {
    throw new TypeError('Metadado de retenção contém propriedade inválida.');
  }
  const auditId = canonicalAuditId(value.auditId);
  if (expectedAuditId !== undefined && auditId !== canonicalAuditId(expectedAuditId)) {
    throw new TypeError('Metadado de retenção não corresponde à auditoria.');
  }
  if (value.schemaVersion !== 1 || typeof value.deleteAfterCompleteExport !== 'boolean') {
    throw new TypeError('Metadado de retenção inválido.');
  }
  const first = canonicalRetentionInstant(value.firstPersistedAt);
  const expires = canonicalRetentionInstant(value.expiresAt);
  const expectedExpiry = first.iso === UNIX_EPOCH
    ? UNIX_EPOCH
    : new Date(first.milliseconds + RETENTION_MS).toISOString();
  if (expires.iso !== expectedExpiry) throw new TypeError('Prazo do metadado de retenção inválido.');
  return Object.freeze({ ...value });
}

export function migrateRetentionMetadata(auditId, model) {
  const endedAt = model?.timestamps?.endedAt;
  try {
    return createRetentionMetadata(auditId, canonicalRetentionInstant(endedAt).iso, false);
  } catch {
    return Object.freeze({
      auditId: canonicalAuditId(auditId),
      schemaVersion: 1,
      firstPersistedAt: UNIX_EPOCH,
      expiresAt: UNIX_EPOCH,
      deleteAfterCompleteExport: false,
    });
  }
}
