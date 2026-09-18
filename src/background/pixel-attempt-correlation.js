import { resolveSessionPixelAttemptDigestAuthorityV1, resolveSessionPixelDirectAttemptDigestAuthorityV1 } from '../core/privacy/session-url-digest.js';

const MARKER_PREFIX = 'audita:pixel-attempt:v1:';
const AUDIT_ID = /^[A-Za-z0-9._:-]{1,160}$/u;
const CONSENT_ID = /^[A-Za-z0-9_-]{21}[AQgw]$/u;
const DIGEST = /^hmac-sha256:[A-Za-z0-9_-]{43}$/u;
const ID = /^[A-Za-z0-9._:-]{1,160}$/u;
const CAPABILITIES = new WeakMap();
const STORE_BINDINGS = new WeakMap();
const STORE_AUTHORITIES = new WeakMap();
const SESSION_WRITERS = new WeakMap();

function exact(value, keys) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
    const own = Reflect.ownKeys(value);
    if (own.length !== keys.length || own.some(key => typeof key !== 'string' || !keys.includes(key))) return null;
    const copy = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      copy[key] = descriptor.value;
    }
    return copy;
  } catch { return null; }
}

function correlation(value) {
  const copy = exact(value, ['auditId', 'attemptDigest', 'pageId', 'ownershipId']);
  if (!copy || !AUDIT_ID.test(copy.auditId ?? '') || !DIGEST.test(copy.attemptDigest ?? '') ||
    (copy.pageId !== null && !ID.test(copy.pageId ?? '')) ||
    (copy.ownershipId !== null && !ID.test(copy.ownershipId ?? ''))) return null;
  return Object.freeze(copy);
}

function marker(value) {
  const copy = exact(value, [
    'version', 'auditId', 'attemptDigest', 'pageId', 'ownershipId', 'preparedAt', 'expiresAt',
  ]);
  const projected = copy && projectCorrelation(copy);
  if (!copy || !projected || copy.version !== 1 || !Number.isSafeInteger(copy.preparedAt) || copy.preparedAt < 0 ||
    !Number.isSafeInteger(copy.expiresAt) || copy.expiresAt <= copy.preparedAt) return null;
  return Object.freeze({ ...copy });
}

function same(left, right) {
  return left.auditId === right.auditId && left.attemptDigest === right.attemptDigest &&
    left.pageId === right.pageId && left.ownershipId === right.ownershipId;
}

function sameMarker(left, right) {
  return same(left, right) && left.version === right.version && left.preparedAt === right.preparedAt &&
    left.expiresAt === right.expiresAt;
}

function projectCorrelation(value) {
  return correlation({
    auditId: value.auditId, attemptDigest: value.attemptDigest,
    pageId: value.pageId, ownershipId: value.ownershipId,
  });
}

function markerKey(value) {
  return `${MARKER_PREFIX}${value.auditId}:${value.attemptDigest.slice('hmac-sha256:'.length)}`;
}

function serialize(sessionArea, auditId, operation) {
  let writers = SESSION_WRITERS.get(sessionArea);
  if (!writers) {
    writers = new Map();
    SESSION_WRITERS.set(sessionArea, writers);
  }
  let writer = writers.get(auditId);
  if (!writer) {
    writer = { tail: Promise.resolve() };
    writers.set(auditId, writer);
  }
  const pending = writer.tail.then(operation, operation);
  writer.tail = pending.catch(() => {});
  return pending;
}

export function createPixelAttemptStoreBindingV1(store, sessionArea) {
  if (!store || typeof store !== 'object' || !sessionArea || typeof sessionArea !== 'object') {
    throw new TypeError('PIXEL_ATTEMPT_CORRELATION_INVALID');
  }
  const existing = STORE_AUTHORITIES.get(store);
  if (existing) {
    if (STORE_BINDINGS.get(existing)?.sessionArea !== sessionArea) {
      throw new TypeError('PIXEL_ATTEMPT_CORRELATION_INVALID');
    }
    return existing;
  }
  const binding = Object.freeze(Object.create(null));
  STORE_BINDINGS.set(binding, Object.freeze({ store, sessionArea }));
  STORE_AUTHORITIES.set(store, binding);
  return binding;
}

export function runPixelAttemptCommitAuthorizationV1(value, store, operation) {
  const metadata = value && typeof value === 'object' ? CAPABILITIES.get(value) : null;
  const binding = metadata ? STORE_BINDINGS.get(metadata.binding) : null;
  if (!metadata || !binding || binding.store !== store || STORE_AUTHORITIES.get(store) !== metadata.binding ||
    typeof operation !== 'function') {
    return Promise.reject(new TypeError('PIXEL_ATTEMPT_CORRELATION_INVALID'));
  }
  return metadata.authorizeCommit(operation);
}

export function createPixelAttemptCorrelationV1(raw) {
  const input = exact(raw, ['sessionArea', 'attemptAuthority', 'now', 'storeBinding']);
  const binding = input ? STORE_BINDINGS.get(input.storeBinding) : null;
  const digestAttempt = input
    ? resolveSessionPixelAttemptDigestAuthorityV1(input.attemptAuthority, input.sessionArea)
    : null;
  const resolveDirectDigest = input
    ? resolveSessionPixelDirectAttemptDigestAuthorityV1(input.attemptAuthority, input.sessionArea)
    : null;
  if (!input || !binding || binding.sessionArea !== input.sessionArea ||
    typeof input.sessionArea?.get !== 'function' || typeof input.sessionArea?.set !== 'function' ||
    typeof input.sessionArea?.remove !== 'function' || typeof digestAttempt !== 'function' ||
    typeof input.now !== 'function') throw new TypeError('PIXEL_ATTEMPT_CORRELATION_INVALID');

  const read = async expected => {
    const storageKey = markerKey(expected);
    const envelope = await input.sessionArea.get(storageKey);
    let descriptor;
    try { descriptor = envelope && typeof envelope === 'object' ? Object.getOwnPropertyDescriptor(envelope, storageKey) : null; }
    catch { return Object.freeze({ state: 'blocked', value: null }); }
    if (!descriptor) return Object.freeze({ state: 'absent', value: null });
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      return Object.freeze({ state: 'blocked', value: null });
    }
    const parsed = marker(descriptor.value);
    if (!parsed || !same(parsed, expected)) return Object.freeze({ state: 'blocked', value: null });
    return Object.freeze({ state: 'exact', value: parsed });
  };

  const mintCapability = graph => {
    const projected = projectCorrelation(graph);
    const capability = Object.freeze(Object.create(null));
    const authorizeCommit = operation => serialize(input.sessionArea, graph.auditId, async () => {
      const current = await read(graph);
      if (current.state !== 'exact' || !sameMarker(current.value, graph)) {
        throw new TypeError('PIXEL_ATTEMPT_CORRELATION_INVALID');
      }
      return operation(projected);
    });
    CAPABILITIES.set(capability, Object.freeze({ binding: input.storeBinding, authorizeCommit }));
    return capability;
  };

  const prepare = async value => {
    const request = exact(value, ['auditId', 'consentId', 'pageId', 'ownershipId', 'expiresAt']);
    // A tentativa DIRETA (captura sem consentimento, em página sem sinal sensível) traz `consentId` NULO:
    // o digesto dela vem do domínio próprio e ela só existe para o alvo anexado (sem página/alça de posse).
    const direta = request?.consentId === null;
    if (!request || !AUDIT_ID.test(request.auditId ?? '') ||
      !(direta ? resolveDirectDigest !== null : CONSENT_ID.test(request.consentId ?? '')) ||
      (request.pageId !== null && !ID.test(request.pageId ?? '')) ||
      (request.ownershipId !== null && !ID.test(request.ownershipId ?? '')) ||
      (direta && (request.pageId !== null || request.ownershipId !== null)) ||
      !Number.isSafeInteger(request.expiresAt)) throw new TypeError('PIXEL_ATTEMPT_CORRELATION_INVALID');

    return serialize(input.sessionArea, request.auditId, async () => {
      const preparedAt = input.now();
      if (!Number.isSafeInteger(preparedAt) || preparedAt < 0 || request.expiresAt <= preparedAt) {
        throw new TypeError('PIXEL_ATTEMPT_CORRELATION_INVALID');
      }
      const attemptDigest = direta
        ? await resolveDirectDigest({ auditId: request.auditId })
        : await digestAttempt({ auditId: request.auditId, consentId: request.consentId });
      const graph = marker({
        version: 1, auditId: request.auditId, attemptDigest, pageId: request.pageId,
        ownershipId: request.ownershipId, preparedAt, expiresAt: request.expiresAt,
      });
      if (!graph) throw new TypeError('PIXEL_ATTEMPT_CORRELATION_INVALID');
      const current = await read(graph);
      if (current.state === 'blocked') throw new TypeError('PIXEL_ATTEMPT_CORRELATION_INVALID');
      if (current.state === 'exact') {
        if (current.value.expiresAt !== graph.expiresAt) throw new TypeError('PIXEL_ATTEMPT_CORRELATION_INVALID');
        return mintCapability(current.value);
      }
      try { await input.sessionArea.set({ [markerKey(graph)]: { ...graph } }); } catch { /* confirmed below */ }
      const confirmed = await read(graph);
      if (confirmed.state !== 'exact' || !sameMarker(confirmed.value, graph)) {
        throw new TypeError('PIXEL_ATTEMPT_CORRELATION_INVALID');
      }
      return mintCapability(graph);
    });
  };

  const markerMatches = value => {
    const expected = correlation(value);
    if (!expected) return Promise.resolve(false);
    return serialize(input.sessionArea, expected.auditId, async () => (await read(expected)).state === 'exact');
  };

  const remove = value => {
    const expected = correlation(value);
    if (!expected) return Promise.resolve(false);
    return serialize(input.sessionArea, expected.auditId, async () => {
      const current = await read(expected);
      if (current.state === 'absent') return true;
      if (current.state !== 'exact') return false;
      try { await input.sessionArea.remove(markerKey(expected)); } catch { /* confirmed below */ }
      return (await read(expected)).state === 'absent';
    });
  };

  return Object.freeze({ prepare, markerMatches, remove });
}
