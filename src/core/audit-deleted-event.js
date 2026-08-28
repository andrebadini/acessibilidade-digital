const AUDIT_REASONS = new Set(['delete-one', 'complete-export']);
const AUDIT_KEYS = ['auditId', 'reason', 'type'];
const ALL_KEYS = ['reason', 'scope', 'type'];

export function createAuditDeletedEvent(subject) {
  const record = ownDataRecord(subject);
  if (!record) throw new TypeError('Notificação de exclusão inválida.');
  if (exactKeys(record, ['auditId', 'reason']) && validAuditId(record.auditId) &&
    AUDIT_REASONS.has(record.reason)) {
    return Object.freeze({ type: 'AUDIT_DELETED', auditId: record.auditId, reason: record.reason });
  }
  if (exactKeys(record, ['reason', 'scope']) && record.scope === 'all' && record.reason === 'delete-all') {
    return Object.freeze({ type: 'AUDIT_DELETED', scope: 'all', reason: 'delete-all' });
  }
  throw new TypeError('Notificação de exclusão inválida.');
}

export function parseAuditDeletedEvent(message, sender, runtime) {
  if (!authorizedWorkerSender(sender, runtime)) return null;
  const record = ownDataRecord(message);
  if (!record || record.type !== 'AUDIT_DELETED') return null;
  if (exactKeys(record, AUDIT_KEYS) && validAuditId(record.auditId) && AUDIT_REASONS.has(record.reason)) {
    return { type: record.type, auditId: record.auditId, reason: record.reason };
  }
  if (exactKeys(record, ALL_KEYS) && record.scope === 'all' && record.reason === 'delete-all') {
    return { type: record.type, scope: 'all', reason: record.reason };
  }
  return null;
}

function authorizedWorkerSender(sender, runtime) {
  const source = ownDataRecord(sender);
  const context = ownDataRecord(runtime);
  if (!source || !context || typeof context.id !== 'string' || source.id !== context.id || source.tab !== undefined) {
    return false;
  }
  return source.url === undefined || (typeof context.workerUrl === 'string' && source.url === context.workerUrl);
}

function ownDataRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key !== 'string')) return null;
    const output = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) return null;
      output[key] = descriptor.value;
    }
    return output;
  } catch {
    return null;
  }
}

function exactKeys(value, expected) {
  return Object.keys(value).sort().join('\0') === [...expected].sort().join('\0');
}

function validAuditId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,200}$/u.test(value);
}
