export const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const LATEST_KEY = '__latest__';
const PRIVATE_PREFIXES = Object.freeze([
  '__audit_revision__:',
  '__audit_export_lease__:',
  '__audit_export_attempt__:',
  '__audit_export_delivery__:',
]);
const RETENTION_KEYS = Object.freeze([
  'auditId',
  'deleteAfterCompleteExport',
  'expiresAt',
  'firstPersistedAt',
  'schemaVersion',
]);
const UNIX_EPOCH = '1970-01-01T00:00:00.000Z';

export function isPrivateAuditKey(value) {
  return value === LATEST_KEY || PRIVATE_PREFIXES.some(prefix => value?.startsWith?.(prefix));
}

function canonicalAuditId(value) {
  if (typeof value !== 'string' || value !== value.trim() || !value || isPrivateAuditKey(value)) {
    throw new TypeError('Identificador do metadado de retenção inválido.');
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
