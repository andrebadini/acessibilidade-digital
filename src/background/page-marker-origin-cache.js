const KEYS = Object.freeze([
  'auditId', 'tabId', 'windowId', 'documentId', 'urlSessionDigest', 'createdAt', 'expiresAt',
]);
const IDENTIFIER = /^[A-Za-z0-9._:-]{1,200}$/u;
const DOCUMENT_ID = /^[A-Za-z0-9._:-]{1,240}$/u;
const DIGEST = /^hmac-sha256:[A-Za-z0-9_-]{43}$/u;
const RESERVED = new Set(['__proto__', 'prototype', 'constructor']);
const TTL_MS = 1_800_000;
const CAPACITY = 128;

/** The lifetime the cache itself accepts, so callers cannot hand it a record it must reject. */
export const PAGE_MARKER_ORIGIN_TTL_MS = TTL_MS;

function exactData(value, expectedKeys) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== expectedKeys.length || keys.some(key => !expectedKeys.includes(key))) return null;
    const result = {};
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

function validId(value) {
  return typeof value === 'string' && IDENTIFIER.test(value) && !RESERVED.has(value);
}

function nonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validOrigin(record) {
  return record && validId(record.auditId) && nonnegativeInteger(record.tabId) &&
    nonnegativeInteger(record.windowId) && typeof record.documentId === 'string' &&
    DOCUMENT_ID.test(record.documentId) && typeof record.urlSessionDigest === 'string' &&
    DIGEST.test(record.urlSessionDigest) && nonnegativeInteger(record.createdAt) &&
    nonnegativeInteger(record.expiresAt) && record.expiresAt > record.createdAt &&
    record.expiresAt - record.createdAt <= TTL_MS;
}

/** Session-local provenance only: never grants capture or evidence authority. */
export function createPageMarkerOriginCache(raw) {
  const options = exactData(raw, ['now']);
  if (!options || typeof options.now !== 'function') throw new TypeError('PAGE_MARKER_ORIGIN_CACHE_INVALID');
  const now = options.now;
  const records = new Map();

  function readNow() {
    try {
      const value = now();
      return nonnegativeInteger(value) ? value : null;
    } catch {
      return null;
    }
  }

  function purgeExpired(time) {
    for (const [auditId, record] of records) {
      if (record.expiresAt <= time) records.delete(auditId);
    }
  }

  function register(rawRecord) {
    const record = exactData(rawRecord, KEYS);
    if (!validOrigin(record)) return false;
    const time = readNow();
    if (time === null || record.createdAt > time || record.expiresAt <= time) return false;
    purgeExpired(time);
    const previous = records.get(record.auditId);
    if (previous) return KEYS.every(key => previous[key] === record[key]);
    if (records.size >= CAPACITY) {
      let oldest = null;
      for (const candidate of records.values()) {
        if (oldest === null || candidate.createdAt < oldest.createdAt) oldest = candidate;
      }
      records.delete(oldest.auditId);
    }
    records.set(record.auditId, Object.freeze(record));
    return true;
  }

  function get(auditId) {
    if (!validId(auditId)) return null;
    const time = readNow();
    if (time === null) return null;
    purgeExpired(time);
    const record = records.get(auditId);
    return record && record.createdAt <= time ? Object.freeze({ ...record }) : null;
  }

  function clearAudit(auditId) {
    return validId(auditId) ? records.delete(auditId) : false;
  }

  function clearTab(tabId) {
    if (!nonnegativeInteger(tabId)) return 0;
    let count = 0;
    for (const [auditId, record] of records) {
      if (record.tabId === tabId && records.delete(auditId)) count += 1;
    }
    return count;
  }

  return Object.freeze({ register, get, clearAudit, clearTab });
}
