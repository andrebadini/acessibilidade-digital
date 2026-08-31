export const SESSION_HMAC_KEY = 'audita:session-hmac-key:v1';

const KEY_BYTES = 32;
const KEY_RECORD_KEYS = ['version', 'keyBase64Url', 'createdAt'];
const BASE64URL_32_BYTES = /^[A-Za-z0-9_-]{43}$/u;
const PIXEL_ATTEMPT_KEYS = ['auditId', 'consentId'];
const AUDIT_ID = /^[A-Za-z0-9._:-]{1,160}$/u;
const CONSENT_ID = /^[A-Za-z0-9_-]{21}[AQgw]$/u;
const PIXEL_ATTEMPT_DOMAIN = 'audita:pixel-attempt:v1';
const SESSION_KEY_COORDINATORS = new WeakMap();
const PIXEL_ATTEMPT_AUTHORITIES = new WeakMap();

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
  return signHmac(new TextEncoder().encode(rawUrl), sessionKey, subtle);
}

export async function createPixelAttemptDigest(value, sessionKey, subtle) {
  const pair = readDataRecord(value, PIXEL_ATTEMPT_KEYS);
  if (!pair || !AUDIT_ID.test(pair.auditId ?? '') || !CONSENT_ID.test(pair.consentId ?? '')) {
    throw new TypeError('PIXEL_ATTEMPT_DIGEST_INVALID');
  }
  const material = `${PIXEL_ATTEMPT_DOMAIN}\u0000${pair.auditId.length}:${pair.auditId}\u0000${pair.consentId}`;
  return signHmac(new TextEncoder().encode(material), sessionKey, subtle);
}

async function signHmac(material, sessionKey, subtle) {
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
  const signature = await subtle.sign('HMAC', key, material);
  if (!(signature instanceof ArrayBuffer) || signature.byteLength !== KEY_BYTES) {
    throw new TypeError('HMAC_SIGNATURE_INVALID');
  }
  return `hmac-sha256:${encodeBase64Url(new Uint8Array(signature))}`;
}

export function createSessionPixelAttemptDigestAuthority({ sessionArea, subtle, randomBytes, now = Date.now } = {}) {
  if (!sessionArea || typeof sessionArea.get !== 'function' || typeof sessionArea.set !== 'function' ||
    typeof randomBytes !== 'function' || typeof now !== 'function') throw new TypeError('HMAC_MANAGER_INVALID');
  const coordinator = sessionKeyCoordinator(sessionArea);
  const digestAttempt = pair => {
    if (coordinator.destroyed) return Promise.reject(new Error('HMAC_MANAGER_DESTROYED'));
    const validated = readDataRecord(pair, PIXEL_ATTEMPT_KEYS);
    if (!validated || !AUDIT_ID.test(validated.auditId ?? '') || !CONSENT_ID.test(validated.consentId ?? '')) {
      return Promise.reject(new TypeError('PIXEL_ATTEMPT_DIGEST_INVALID'));
    }
    return enqueueSessionKeyOperation(coordinator, async () => {
      const keyBytes = await loadOrCreateSessionKey({ sessionArea, randomBytes, now });
      return createPixelAttemptDigest(validated, keyBytes, subtle);
    });
  };
  const authority = Object.freeze({ digestAttempt });
  PIXEL_ATTEMPT_AUTHORITIES.set(authority, Object.freeze({ sessionArea, digestAttempt }));
  return authority;
}

export function resolveSessionPixelAttemptDigestAuthorityV1(authority, sessionArea) {
  const metadata = authority && typeof authority === 'object' ? PIXEL_ATTEMPT_AUTHORITIES.get(authority) : null;
  return metadata?.sessionArea === sessionArea ? metadata.digestAttempt : null;
}

export function createSessionUrlDigestManager({ sessionArea, subtle, randomBytes, now = Date.now } = {}) {
  if (!sessionArea || typeof sessionArea.get !== 'function' || typeof sessionArea.set !== 'function' ||
    typeof sessionArea.remove !== 'function' || typeof randomBytes !== 'function' || typeof now !== 'function') {
    throw new TypeError('HMAC_MANAGER_INVALID');
  }
  const coordinator = sessionKeyCoordinator(sessionArea);

  const digest = canonicalUrl => {
    if (coordinator.destroyed) return Promise.reject(new Error('HMAC_MANAGER_DESTROYED'));
    try { requireCanonicalHttpUrl(canonicalUrl); }
    catch (error) { return Promise.reject(error); }
    return enqueueSessionKeyOperation(coordinator, async () => {
      const keyBytes = await loadOrCreateKey();
      return createSessionUrlDigest(canonicalUrl, keyBytes, subtle);
    });
  };

  const destroy = () => {
    if (coordinator.destroyPromise) return coordinator.destroyPromise;
    coordinator.destroyed = true;
    coordinator.destroyPromise = enqueueSessionKeyOperation(coordinator, async () => {
      try { await sessionArea.remove(SESSION_HMAC_KEY); } catch { /* confirmed below */ }
      const envelope = await sessionArea.get(SESSION_HMAC_KEY);
      if (ownPropertyState(envelope, SESSION_HMAC_KEY) !== 'absent') {
        throw new TypeError('HMAC_KEY_DESTRUCTION_FAILED');
      }
    });
    return coordinator.destroyPromise;
  };

  async function loadOrCreateKey() {
    return loadOrCreateSessionKey({ sessionArea, randomBytes, now });
  }

  return Object.freeze({ digest, destroy });
}

async function loadOrCreateSessionKey({ sessionArea, randomBytes, now }) {
  const storedEnvelope = await sessionArea.get(SESSION_HMAC_KEY);
  const stored = ownDataDescriptor(storedEnvelope, SESSION_HMAC_KEY)?.value;
  const decoded = decodeKeyRecord(stored);
  if (decoded) return decoded;
  const keyBytes = createSessionHmacKeyBytes(randomBytes);
  const createdAt = now();
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) throw new TypeError('HMAC_TIME_INVALID');
  const keyRecord = { version: 1, keyBase64Url: encodeBase64Url(keyBytes), createdAt };
  try { await sessionArea.set({ [SESSION_HMAC_KEY]: keyRecord }); } catch { /* confirmed below */ }
  const confirmedEnvelope = await sessionArea.get(SESSION_HMAC_KEY);
  const confirmed = ownDataDescriptor(confirmedEnvelope, SESSION_HMAC_KEY)?.value;
  const confirmedRecord = readDataRecord(confirmed, KEY_RECORD_KEYS);
  if (!confirmedRecord || confirmedRecord.version !== keyRecord.version ||
    confirmedRecord.keyBase64Url !== keyRecord.keyBase64Url || confirmedRecord.createdAt !== keyRecord.createdAt) {
    throw new TypeError('HMAC_KEY_GENERATION_FAILED');
  }
  const confirmedBytes = decodeKeyRecord(confirmed);
  if (!confirmedBytes) throw new TypeError('HMAC_KEY_GENERATION_FAILED');
  return confirmedBytes;
}

function sessionKeyCoordinator(sessionArea) {
  let coordinator = SESSION_KEY_COORDINATORS.get(sessionArea);
  if (!coordinator) {
    coordinator = { tail: Promise.resolve(), destroyed: false, destroyPromise: null };
    SESSION_KEY_COORDINATORS.set(sessionArea, coordinator);
  }
  return coordinator;
}

function enqueueSessionKeyOperation(coordinator, operation) {
  const pending = coordinator.tail.then(operation, operation);
  coordinator.tail = pending.catch(() => {});
  return pending;
}

function ownDataDescriptor(value, key) {
  try {
    if (!value || typeof value !== 'object') return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable && Object.hasOwn(descriptor, 'value') ? descriptor : null;
  } catch { return null; }
}

function ownPropertyState(value, key) {
  try {
    if (!value || typeof value !== 'object') return 'absent';
    return Object.getOwnPropertyDescriptor(value, key) ? 'present' : 'absent';
  } catch { return 'blocked'; }
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
  const record = readDataRecord(value, KEY_RECORD_KEYS);
  if (!record || record.version !== 1 || !Number.isSafeInteger(record.createdAt) || record.createdAt < 0 ||
    typeof record.keyBase64Url !== 'string' || !BASE64URL_32_BYTES.test(record.keyBase64Url)) return null;
  try {
    const decoded = decodeBase64Url(record.keyBase64Url);
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

function readDataRecord(value, expectedKeys) {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== expectedKeys.length || ownKeys.some(key => typeof key !== 'string' || !expectedKeys.includes(key))) {
      return null;
    }
    const record = {};
    for (const key of expectedKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) return null;
      record[key] = descriptor.value;
    }
    return record;
  } catch {
    return null;
  }
}
