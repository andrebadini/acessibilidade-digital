import { createAuditModel } from '../core/report/audit-model.js';
import { verifyAuditIntegritySnapshot } from '../core/report/integrity.js';

const AUDIT_ID = /^[A-Za-z0-9._:-]{1,200}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const DENIED = 'AUDIT_MODEL_INVALID';

function exactDataRecord(value, expectedKeys) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== expectedKeys.length || keys.some(key => typeof key !== 'string') ||
      expectedKeys.some(key => !keys.includes(key))) return null;
    const result = Object.create(null);
    for (const key of expectedKeys) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    return null;
  }
}

function fail() {
  throw new TypeError(DENIED);
}

export function createHighlightModelAuthority(raw = undefined) {
  const options = exactDataRecord(raw, ['auditStore']);
  const auditStore = options?.auditStore;
  let getAuditSnapshot;
  try {
    const descriptor = auditStore && typeof auditStore === 'object'
      ? Reflect.getOwnPropertyDescriptor(auditStore, 'getAuditSnapshot')
      : null;
    getAuditSnapshot = descriptor?.enumerable && Object.hasOwn(descriptor, 'value')
      ? descriptor.value
      : null;
  } catch {
    getAuditSnapshot = null;
  }
  if (typeof getAuditSnapshot !== 'function') fail();

  async function loadValidated(rawRequest) {
    const request = exactDataRecord(rawRequest, ['auditId']);
    if (!request || typeof request.auditId !== 'string' || !AUDIT_ID.test(request.auditId) ||
      ['__proto__', 'prototype', 'constructor'].includes(request.auditId)) fail();

    try {
      const persisted = exactDataRecord(
        await Reflect.apply(getAuditSnapshot, auditStore, [request.auditId]),
        ['model', 'revision', 'capability'],
      );
      if (!persisted || !Number.isSafeInteger(persisted.revision) || persisted.revision < 1 ||
        persisted.model === undefined) fail();

      const canonical = createAuditModel(persisted.model);
      const verifiedModel = await verifyAuditIntegritySnapshot(canonical);
      const modelHash = verifiedModel?.integrity?.canonicalModelHash;
      if (verifiedModel.auditId !== request.auditId || typeof modelHash !== 'string' || !SHA256.test(modelHash)) fail();

      return Object.freeze({
        model: verifiedModel,
        modelRevision: persisted.revision,
        modelHash,
      });
    } catch {
      fail();
    }
  }

  return Object.freeze({ loadValidated });
}
