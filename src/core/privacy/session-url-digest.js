export const SESSION_HMAC_KEY = 'audita:session-hmac-key:v1';

const KEY_BYTES = 32;
const KEY_RECORD_KEYS = ['version', 'keyBase64Url', 'createdAt'];
const BASE64URL_32_BYTES = /^[A-Za-z0-9_-]{43}$/u;

export function createSessionHmacKeyBytes(randomBytes) {
  if (typeof randomBytes !== 'function') throw new TypeError('HMAC_KEY_GENERATION_FAILED');
  const value = randomBytes(KEY_BYTES);
  if (!(value instanceof Uint8Array) || value.byteLength !== KEY_BYTES) {
    throw new TypeError('HMAC_KEY_GENERATION_FAILED');
  }
  return new Uint8Array(value);
}

export async function createSessionUrlDigest(rawUrl, sessionKey, subtle) {
  requireCanonicalHttpUrl(rawUrl);
  if (!(sessionKey instanceof Uint8Array) || sessionKey.byteLength !== KEY_BYTES) {
    throw new TypeError('HMAC_KEY_INVALID');
  }
  if (!subtle || typeof subtle.importKey !== 'function' || typeof subtle.sign !== 'function') {
    throw new TypeError('HMAC_SUBTLE_UNAVAILABLE');
  }
  const key = await subtle.importKey(
    'raw',
    new Uint8Array(sessionKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await subtle.sign('HMAC', key, new TextEncoder().encode(rawUrl));
  return `hmac-sha256:${encodeBase64Url(new Uint8Array(signature))}`;
}

export function createSessionUrlDigestManager({ sessionArea, subtle, randomBytes, now = Date.now } = {}) {
  if (!sessionArea || typeof sessionArea.get !== 'function' || typeof sessionArea.set !== 'function' ||
    typeof sessionArea.remove !== 'function' || typeof randomBytes !== 'function' || typeof now !== 'function') {
    throw new TypeError('HMAC_MANAGER_INVALID');
  }
  let tail = Promise.resolve();
  let destroyed = false;
  let destroyPromise = null;

  const operate = operation => {
    const pending = tail.then(operation, operation);
    tail = pending.catch(() => {});
    return pending;
  };

  const digest = canonicalUrl => {
    if (destroyed) return Promise.reject(new Error('HMAC_MANAGER_DESTROYED'));
    try { requireCanonicalHttpUrl(canonicalUrl); }
    catch (error) { return Promise.reject(error); }
    return operate(async () => {
      if (destroyed) throw new Error('HMAC_MANAGER_DESTROYED');
      const keyBytes = await loadOrCreateKey();
      if (destroyed) throw new Error('HMAC_MANAGER_DESTROYED');
      return createSessionUrlDigest(canonicalUrl, keyBytes, subtle);
    });
  };

  const destroy = () => {
    if (destroyPromise) return destroyPromise;
    destroyed = true;
    destroyPromise = operate(async () => {
      await sessionArea.remove(SESSION_HMAC_KEY);
    });
    return destroyPromise;
  };

  async function loadOrCreateKey() {
    const stored = (await sessionArea.get(SESSION_HMAC_KEY))?.[SESSION_HMAC_KEY];
    const decoded = decodeKeyRecord(stored);
    if (decoded) return decoded;
    const keyBytes = createSessionHmacKeyBytes(randomBytes);
    const createdAt = now();
    if (!Number.isSafeInteger(createdAt) || createdAt < 0) throw new TypeError('HMAC_TIME_INVALID');
    await sessionArea.set({
      [SESSION_HMAC_KEY]: {
        version: 1,
        keyBase64Url: encodeBase64Url(keyBytes),
        createdAt,
      },
    });
    return keyBytes;
  }

  return Object.freeze({ digest, destroy });
}

function requireCanonicalHttpUrl(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 16_384) {
    throw new TypeError('HMAC_URL_INVALID');
  }
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.href !== value) {
      throw new TypeError('HMAC_URL_INVALID');
    }
  } catch (error) {
    if (error instanceof TypeError && error.message === 'HMAC_URL_INVALID') throw error;
    throw new TypeError('HMAC_URL_INVALID');
  }
}

function decodeKeyRecord(value) {
  if (!isPlainRecord(value) || !hasExactKeys(value, KEY_RECORD_KEYS) || value.version !== 1 ||
    !Number.isSafeInteger(value.createdAt) || value.createdAt < 0 ||
    typeof value.keyBase64Url !== 'string' || !BASE64URL_32_BYTES.test(value.keyBase64Url)) return null;
  try {
    const decoded = decodeBase64Url(value.keyBase64Url);
    return decoded.byteLength === KEY_BYTES ? decoded : null;
  } catch {
    return null;
  }
}

function encodeBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/gu, '');
}

function decodeBase64Url(value) {
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(value.replace(/-/gu, '+').replace(/_/gu, '/') + padding);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

function isPlainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, keys) {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
