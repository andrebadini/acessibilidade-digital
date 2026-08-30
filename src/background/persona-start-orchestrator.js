const CAPABILITY = /^[A-Za-z0-9_-]{22}$/u;
const DIGEST = /^hmac-sha256:[A-Za-z0-9_-]{43}$/u;
const MODES = new Set(['reader', 'achromatopsia', 'motor']);
const TARGET_KEYS = ['tabId', 'windowId', 'documentId', 'urlSessionDigest'];

function exactDataRecord(value, keys) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== keys.length ||
      ownKeys.some(key => typeof key !== 'string' || !keys.includes(key))) return null;
    const copy = Object.create(null);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      copy[key] = descriptor.value;
    }
    return copy;
  } catch {
    return null;
  }
}

function parseTarget(value) {
  const target = exactDataRecord(value, TARGET_KEYS);
  if (!target || !Number.isSafeInteger(target.tabId) || target.tabId <= 0 ||
    !Number.isSafeInteger(target.windowId) || target.windowId < 0 ||
    typeof target.documentId !== 'string' || !/^[A-Za-z0-9._:-]{1,240}$/u.test(target.documentId) ||
    !DIGEST.test(target.urlSessionDigest ?? '')) return null;
  return Object.freeze({
    tabId: target.tabId,
    windowId: target.windowId,
    documentId: target.documentId,
    urlSessionDigest: target.urlSessionDigest,
  });
}

function parseAuthorityTarget(value) {
  const result = exactDataRecord(value, ['ok', 'target']);
  if (!result || result.ok !== true) return null;
  return parseTarget(result.target);
}

function sameTarget(left, right) {
  return left.tabId === right.tabId && left.windowId === right.windowId &&
    left.documentId === right.documentId && left.urlSessionDigest === right.urlSessionDigest;
}

function failure(code) {
  return Object.freeze({ ok: false, code });
}

export function createPersonaStartOrchestrator({ authority, targetQueue, personaCoordinator } = {}) {
  if (!authority || typeof authority.inspectPreparedTarget !== 'function' ||
    typeof authority.claimPreparedTarget !== 'function' ||
    !targetQueue || typeof targetQueue.withTarget !== 'function' || typeof targetQueue.assertHeld !== 'function' ||
    !personaCoordinator || typeof personaCoordinator.claimLocked !== 'function' ||
    typeof personaCoordinator.rehydrateLocked !== 'function') {
    throw new TypeError('PERSONA_START_ORCHESTRATOR_INVALID');
  }

  async function run(raw, kind) {
    const keys = kind === 'start'
      ? ['capabilityId', 'mode', 'senderContext', 'consumer']
      : ['capabilityId', 'senderContext', 'consumer'];
    const input = exactDataRecord(raw, keys);
    if (!input || !CAPABILITY.test(input.capabilityId ?? '') ||
      (kind === 'start' && !MODES.has(input.mode))) return failure('CAPABILITY_UNAVAILABLE');

    const authorityInput = Object.freeze({
      capabilityId: input.capabilityId,
      intent: 'start-persona',
      senderContext: input.senderContext,
    });
    let inspected;
    try { inspected = parseAuthorityTarget(await authority.inspectPreparedTarget(authorityInput)); }
    catch { inspected = null; }
    if (!inspected) return failure('CAPABILITY_UNAVAILABLE');

    try {
      return await targetQueue.withTarget(inspected, async lock => {
        targetQueue.assertHeld(lock, inspected);
        let claimed;
        try { claimed = parseAuthorityTarget(await authority.claimPreparedTarget(authorityInput)); }
        catch { claimed = null; }
        if (!claimed || !sameTarget(inspected, claimed)) return failure('CAPABILITY_UNAVAILABLE');
        return kind === 'start'
          ? personaCoordinator.claimLocked({
              target: claimed,
              consumer: input.consumer,
              mode: input.mode,
              lock,
            })
          : personaCoordinator.rehydrateLocked({
              target: claimed,
              consumer: input.consumer,
              lock,
            });
      });
    } catch {
      return failure('PERSONA_RUNTIME_FAILED');
    }
  }

  return Object.freeze({
    start: raw => run(raw, 'start'),
    rehydrate: raw => run(raw, 'rehydrate'),
  });
}
