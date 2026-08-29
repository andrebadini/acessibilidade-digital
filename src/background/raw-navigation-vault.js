import { normalizeAuditUrl } from '../core/url.js';

const PREFIX = 'audita:raw-navigation:v1:';
const TTL_MS = 60_000;
const RECORD_KEYS = Object.freeze([
  'version', 'navigationToken', 'ownerId', 'rawUrl', 'issuedAt', 'expiresAt', 'state',
]);

function exactOwnData(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  let ownKeys;
  try { ownKeys = Reflect.ownKeys(value); } catch { return null; }
  if (ownKeys.length !== keys.length || keys.some(key => !ownKeys.includes(key))) return null;
  const copy = {};
  for (const key of keys) {
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(value, key); } catch { return null; }
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
    copy[key] = descriptor.value;
  }
  return copy;
}

function validId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,160}$/u.test(value);
}

function validToken(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{22}$/u.test(value);
}

function validRawUrl(rawUrl) {
  try { return typeof rawUrl === 'string' && normalizeAuditUrl(rawUrl) === rawUrl; } catch { return false; }
}

function encodeToken(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 16) throw new TypeError('RAW_NAVIGATION_INVALID');
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

function unavailable() {
  return new Error('RAW_NAVIGATION_UNAVAILABLE');
}

function validClock(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

async function erased(sessionArea, key) {
  try {
    await sessionArea.remove(key);
    return !Object.hasOwn(await sessionArea.get(key), key);
  } catch { return false; }
}

export function createRawNavigationVaultV1({ sessionArea, now, randomBytes }) {
  if (!sessionArea || typeof sessionArea.get !== 'function' || typeof sessionArea.set !== 'function' ||
    typeof sessionArea.remove !== 'function' || typeof now !== 'function' || typeof randomBytes !== 'function') {
    throw new TypeError('RAW_NAVIGATION_INVALID');
  }
  let tail = Promise.resolve();
  const serialized = operation => {
    const pending = tail.then(operation, operation);
    tail = pending.catch(() => {});
    return pending;
  };

  const readValid = async (ownerId, navigationToken) => {
    if (!validId(ownerId) || !validToken(navigationToken)) throw unavailable();
    const key = `${PREFIX}${navigationToken}`;
    let stored;
    try { stored = (await sessionArea.get(key))?.[key]; } catch { throw unavailable(); }
    const record = exactOwnData(stored, RECORD_KEYS);
    if (!record || record.version !== 1 || record.navigationToken !== navigationToken ||
      record.ownerId !== ownerId || !validRawUrl(record.rawUrl) ||
      !Number.isSafeInteger(record.issuedAt) || !Number.isSafeInteger(record.expiresAt) ||
      record.expiresAt <= record.issuedAt || record.state !== 'prepared') throw unavailable();
    return { key, record };
  };

  return Object.freeze({
    putInternal({ ownerId, rawUrl }) {
      return serialized(async () => {
        if (!validId(ownerId) || !validRawUrl(rawUrl)) throw new TypeError('RAW_NAVIGATION_INVALID');
        let issuedAt;
        try { issuedAt = now(); } catch { throw new TypeError('RAW_NAVIGATION_INVALID'); }
        if (!validClock(issuedAt) || issuedAt > Number.MAX_SAFE_INTEGER - TTL_MS) throw new TypeError('RAW_NAVIGATION_INVALID');
        const navigationToken = encodeToken(randomBytes(16));
        const expiresAt = issuedAt + TTL_MS;
        const key = `${PREFIX}${navigationToken}`;
        try {
          if (Object.hasOwn(await sessionArea.get(key), key)) throw unavailable();
          await sessionArea.set({ [key]: {
          version: 1, navigationToken, ownerId, rawUrl, issuedAt, expiresAt, state: 'prepared',
          } });
          const verified = exactOwnData((await sessionArea.get(key))?.[key], RECORD_KEYS);
          if (!verified || RECORD_KEYS.some(field => verified[field] !== ({
            version: 1, navigationToken, ownerId, rawUrl, issuedAt, expiresAt, state: 'prepared',
          })[field])) throw unavailable();
        } catch { throw unavailable(); }
        return Object.freeze({ navigationToken, expiresAt });
      });
    },
    takeInternal({ ownerId, navigationToken }) {
      return serialized(async () => {
        const { key, record } = await readValid(ownerId, navigationToken);
        let current;
        try { current = now(); } catch { throw unavailable(); }
        if (!validClock(current)) throw unavailable();
        if (current >= record.expiresAt) {
          await erased(sessionArea, key);
          throw unavailable();
        }
        if (!await erased(sessionArea, key)) throw unavailable();
        return record.rawUrl;
      });
    },
    invalidateInternal({ ownerId, navigationToken }) {
      return serialized(async () => {
        const { key } = await readValid(ownerId, navigationToken);
        if (!await erased(sessionArea, key)) throw unavailable();
        return Object.freeze({ invalidated: true });
      });
    },
  });
}
