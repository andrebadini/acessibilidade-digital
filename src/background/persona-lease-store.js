const REGISTRY_KEY = 'audita:persona-leases:v1';
const MODES = new Set(['reader', 'achromatopsia', 'motor']);
const STATES = new Set(['prepared', 'active', 'stopping', 'revoked']);
const REVOKE_REASONS = new Set([
  'expired',
  'navigation',
  'tab-removed',
  'window-changed',
  'audit-start',
  'runtime-failure',
  'recovery',
]);
const TTL_MS = 30 * 60_000;
const MAX_DOCUMENT_ID_LENGTH = 512;
const MAX_PATH_LENGTH = 512;
const MAX_EXTENSION_ID_LENGTH = 128;
const MAX_REGISTRY_ENTRIES = 4_096;
const DIGEST = /^hmac-sha256:[A-Za-z0-9_-]{43}$/u;
const LEASE_ID = /^lease-[A-Za-z0-9_-]{22}$/u;
const LEASE_KEYS = [
  'version',
  'leaseId',
  'target',
  'consumer',
  'activeMode',
  'pendingMode',
  'createdAt',
  'lastExplicitActionAt',
  'expiresAt',
  'state',
  'revision',
  'revokeReason',
];
const TARGET_KEYS = ['tabId', 'windowId', 'documentId', 'urlSessionDigest'];
const CONSUMER_KEYS = ['extensionId', 'documentId', 'path', 'windowId'];
const REGISTRY_KEYS = ['version', 'leases', 'ownerByTarget'];

function targetKey(target) {
  return `${target.tabId}\u0000${target.documentId}`;
}

function cloneFrozen(value) {
  const clone = structuredClone(value);
  const freeze = current => {
    if (!current || typeof current !== 'object' || Object.isFrozen(current)) return current;
    Object.freeze(current);
    for (const nested of Object.values(current)) freeze(nested);
    return current;
  };
  return freeze(clone);
}

function newRegistry() {
  return { version: 1, leases: Object.create(null), ownerByTarget: Object.create(null) };
}

function encodeLeaseId(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 16) {
    throw new TypeError('Entropia insuficiente.');
  }
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `lease-${btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')}`;
}

function exactRecord(value, keys) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== keys.length || ownKeys.some(key => typeof key !== 'string' || !keys.includes(key))) {
      return null;
    }
    const record = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      record[key] = descriptor.value;
    }
    return record;
  } catch {
    return null;
  }
}

function dataEntries(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length > MAX_REGISTRY_ENTRIES || keys.some(key => typeof key !== 'string')) return null;
    const entries = [];
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      entries.push([key, descriptor.value]);
    }
    return entries;
  } catch {
    return null;
  }
}

function boundedText(value, maximum) {
  return typeof value === 'string' && value.length >= 1 && value.length <= maximum &&
    !/[\u0000-\u001F\u007F]/u.test(value);
}

function safeChromeId(value, { positive = false } = {}) {
  return Number.isSafeInteger(value) && (positive ? value > 0 : value >= 0);
}

function assertTarget(value) {
  const target = exactRecord(value, TARGET_KEYS);
  if (!target || !safeChromeId(target.tabId, { positive: true }) || !safeChromeId(target.windowId) ||
    !boundedText(target.documentId, MAX_DOCUMENT_ID_LENGTH) || !DIGEST.test(target.urlSessionDigest ?? '')) {
    throw new TypeError('PERSONA_INPUT_INVALID');
  }
  return {
    tabId: target.tabId,
    windowId: target.windowId,
    documentId: target.documentId,
    urlSessionDigest: target.urlSessionDigest,
  };
}

function assertConsumer(value) {
  const consumer = exactRecord(value, CONSUMER_KEYS);
  if (!consumer || !boundedText(consumer.extensionId, MAX_EXTENSION_ID_LENGTH) ||
    !/^[A-Za-z0-9_-]+$/u.test(consumer.extensionId) ||
    !boundedText(consumer.documentId, MAX_DOCUMENT_ID_LENGTH) ||
    !boundedText(consumer.path, MAX_PATH_LENGTH) || !consumer.path.startsWith('/') ||
    consumer.path.includes('?') || consumer.path.includes('#') || !safeChromeId(consumer.windowId)) {
    throw new TypeError('PERSONA_INPUT_INVALID');
  }
  return {
    extensionId: consumer.extensionId,
    documentId: consumer.documentId,
    path: consumer.path,
    windowId: consumer.windowId,
  };
}

function sameConsumer(left, right) {
  return left.extensionId === right.extensionId && left.documentId === right.documentId &&
    left.path === right.path && left.windowId === right.windowId;
}

function sameTarget(left, right) {
  return left.tabId === right.tabId && left.windowId === right.windowId &&
    left.documentId === right.documentId && left.urlSessionDigest === right.urlSessionDigest;
}

function isMode(value) {
  return typeof value === 'string' && MODES.has(value);
}

function safeTimestamp(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function hasExactSafeExpiry(lastExplicitActionAt, expiresAt) {
  const expected = lastExplicitActionAt + TTL_MS;
  return Number.isSafeInteger(expected) && expiresAt === expected;
}

function assertExactLease(value) {
  const lease = exactRecord(value, LEASE_KEYS);
  if (!lease || lease.version !== 1 || !LEASE_ID.test(lease.leaseId ?? '') ||
    !STATES.has(lease.state) || !Number.isSafeInteger(lease.revision) || lease.revision < 1 ||
    !safeTimestamp(lease.createdAt) || !safeTimestamp(lease.lastExplicitActionAt) ||
    !safeTimestamp(lease.expiresAt) || lease.lastExplicitActionAt < lease.createdAt ||
    !hasExactSafeExpiry(lease.lastExplicitActionAt, lease.expiresAt)) {
    throw new TypeError('PERSONA_REGISTRY_INVALID');
  }
  const target = assertTarget(lease.target);
  const consumer = assertConsumer(lease.consumer);
  if (consumer.windowId !== target.windowId ||
    (lease.activeMode !== null && !isMode(lease.activeMode)) ||
    (lease.pendingMode !== null && !isMode(lease.pendingMode))) {
    throw new TypeError('PERSONA_REGISTRY_INVALID');
  }

  if (lease.state === 'prepared' &&
    (lease.activeMode !== null || !isMode(lease.pendingMode) || lease.revokeReason !== null)) {
    throw new TypeError('PERSONA_REGISTRY_INVALID');
  }
  if (lease.state === 'active' &&
    (lease.revokeReason !== null ||
      (lease.activeMode !== null && lease.pendingMode !== null && lease.pendingMode === lease.activeMode))) {
    throw new TypeError('PERSONA_REGISTRY_INVALID');
  }
  if (lease.state === 'stopping' && (lease.pendingMode !== null || lease.revokeReason !== null)) {
    throw new TypeError('PERSONA_REGISTRY_INVALID');
  }
  if (lease.state === 'revoked' &&
    (lease.pendingMode !== null || !REVOKE_REASONS.has(lease.revokeReason))) {
    throw new TypeError('PERSONA_REGISTRY_INVALID');
  }

  return {
    version: 1,
    leaseId: lease.leaseId,
    target,
    consumer,
    activeMode: lease.activeMode,
    pendingMode: lease.pendingMode,
    createdAt: lease.createdAt,
    lastExplicitActionAt: lease.lastExplicitActionAt,
    expiresAt: lease.expiresAt,
    state: lease.state,
    revision: lease.revision,
    revokeReason: lease.revokeReason,
  };
}

function assertExactRegistry(value) {
  const registry = exactRecord(value, REGISTRY_KEYS);
  if (!registry || registry.version !== 1) throw new TypeError('PERSONA_REGISTRY_INVALID');
  const leaseEntries = dataEntries(registry.leases);
  const ownerEntries = dataEntries(registry.ownerByTarget);
  if (!leaseEntries || !ownerEntries) throw new TypeError('PERSONA_REGISTRY_INVALID');

  const normalized = newRegistry();
  for (const [leaseId, rawLease] of leaseEntries) {
    const lease = assertExactLease(rawLease);
    if (leaseId !== lease.leaseId || Object.hasOwn(normalized.leases, leaseId)) {
      throw new TypeError('PERSONA_REGISTRY_INVALID');
    }
    normalized.leases[leaseId] = lease;
  }
  for (const [key, leaseId] of ownerEntries) {
    const lease = normalized.leases[leaseId];
    if (!lease || lease.state === 'revoked' || key !== targetKey(lease.target) ||
      Object.hasOwn(normalized.ownerByTarget, key)) {
      throw new TypeError('PERSONA_REGISTRY_INVALID');
    }
    normalized.ownerByTarget[key] = leaseId;
  }
  for (const lease of Object.values(normalized.leases)) {
    const owned = normalized.ownerByTarget[targetKey(lease.target)];
    if ((lease.state === 'revoked' && owned === lease.leaseId) ||
      (lease.state !== 'revoked' && owned !== lease.leaseId)) {
      throw new TypeError('PERSONA_REGISTRY_INVALID');
    }
  }
  return normalized;
}

function assertTransition(lease, { states, expectedRevision, consumer, allowExpired = false, now }) {
  if (!lease) return 'PERSONA_NOT_FOUND';
  if (!states.includes(lease.state)) return 'PERSONA_TRANSITION_INVALID';
  if (expectedRevision !== undefined && lease.revision !== expectedRevision) return 'PERSONA_REVISION_MISMATCH';
  if (consumer !== undefined && !sameConsumer(lease.consumer, consumer)) return 'PERSONA_CONSUMER_MISMATCH';
  if (!allowExpired && now !== undefined &&
    (lease.createdAt > now || lease.lastExplicitActionAt > now || lease.expiresAt <= now)) {
    return 'PERSONA_EXPIRED';
  }
  return null;
}

function readInput(value, keys) {
  const input = exactRecord(value, keys);
  if (!input) throw new TypeError('PERSONA_INPUT_INVALID');
  return input;
}

function readLeaseId(value) {
  if (!LEASE_ID.test(value ?? '')) throw new TypeError('PERSONA_INPUT_INVALID');
  return value;
}

function readRevision(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('PERSONA_INPUT_INVALID');
  return value;
}

function nextRevision(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value >= Number.MAX_SAFE_INTEGER) {
    throw new Error('PERSONA_REVISION_OVERFLOW');
  }
  return value + 1;
}

function copyRegistry(registry) {
  const copy = newRegistry();
  for (const [key, value] of Object.entries(registry.leases)) copy.leases[key] = value;
  for (const [key, value] of Object.entries(registry.ownerByTarget)) copy.ownerByTarget[key] = value;
  return copy;
}

function registryForNewClaim(registry) {
  if (Object.keys(registry.leases).length < MAX_REGISTRY_ENTRIES) return registry;
  const tombstones = Object.values(registry.leases)
    .filter(lease => lease.state === 'revoked')
    .sort((left, right) => left.createdAt - right.createdAt ||
      (left.leaseId < right.leaseId ? -1 : left.leaseId > right.leaseId ? 1 : 0));
  if (tombstones.length === 0) return null;
  const next = copyRegistry(registry);
  for (const tombstone of tombstones) {
    delete next.leases[tombstone.leaseId];
    if (Object.keys(next.leases).length < MAX_REGISTRY_ENTRIES) break;
  }
  return next;
}

function withLease(registry, lease) {
  const next = copyRegistry(registry);
  next.leases[lease.leaseId] = lease;
  const key = targetKey(lease.target);
  if (lease.state === 'revoked') delete next.ownerByTarget[key];
  else next.ownerByTarget[key] = lease.leaseId;
  return next;
}

function success(lease) {
  return cloneFrozen({ ok: true, lease });
}

function failure(code) {
  return Object.freeze({ ok: false, code });
}

export function createPersonaLeaseStore({ sessionArea, now, randomBytes } = {}) {
  if (!sessionArea || typeof sessionArea.get !== 'function' || typeof sessionArea.set !== 'function' ||
    typeof now !== 'function' || typeof randomBytes !== 'function') {
    throw new TypeError('PERSONA_LEASE_STORE_INVALID');
  }

  let tail = Promise.resolve();
  const serialize = operation => {
    const pending = tail.then(operation, operation);
    tail = pending.then(() => undefined, () => undefined);
    return pending;
  };

  function readNow() {
    const value = now();
    if (!safeTimestamp(value)) throw new TypeError('PERSONA_CLOCK_INVALID');
    return value;
  }

  async function loadRegistry() {
    const envelope = await sessionArea.get(REGISTRY_KEY);
    try {
      if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw new Error();
      const prototype = Object.getPrototypeOf(envelope);
      if (prototype !== Object.prototype && prototype !== null) throw new Error();
      const keys = Reflect.ownKeys(envelope);
      if (keys.length === 0) return newRegistry();
      if (keys.length !== 1 || keys[0] !== REGISTRY_KEY) throw new Error();
      const descriptor = Object.getOwnPropertyDescriptor(envelope, REGISTRY_KEY);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error();
      return assertExactRegistry(descriptor.value);
    } catch {
      throw new Error('PERSONA_REGISTRY_INVALID');
    }
  }

  async function persist(registry) {
    let validated;
    try {
      validated = assertExactRegistry(registry);
    } catch {
      throw new Error('PERSONA_REGISTRY_INVALID');
    }
    await sessionArea.set({ [REGISTRY_KEY]: cloneFrozen(validated) });
  }

  const claimPrepared = args => serialize(async () => {
    const input = readInput(args, ['target', 'consumer', 'mode']);
    const trustedTarget = assertTarget(input.target);
    const consumer = assertConsumer(input.consumer);
    if (consumer.windowId !== trustedTarget.windowId || !isMode(input.mode)) {
      throw new TypeError('PERSONA_INPUT_INVALID');
    }
    const registry = await loadRegistry();
    if (Object.hasOwn(registry.ownerByTarget, targetKey(trustedTarget))) return failure('PERSONA_CONFLICT');
    const actionAt = readNow();
    const leaseId = encodeLeaseId(randomBytes(16));
    if (Object.hasOwn(registry.leases, leaseId)) throw new Error('PERSONA_LEASE_ID_COLLISION');
    const writableRegistry = registryForNewClaim(registry);
    if (!writableRegistry) return failure('PERSONA_CONFLICT');
    const lease = {
      version: 1,
      leaseId,
      target: trustedTarget,
      consumer,
      activeMode: null,
      pendingMode: input.mode,
      createdAt: actionAt,
      lastExplicitActionAt: actionAt,
      expiresAt: actionAt + TTL_MS,
      state: 'prepared',
      revision: 1,
      revokeReason: null,
    };
    if (!Number.isSafeInteger(lease.expiresAt)) throw new TypeError('PERSONA_CLOCK_INVALID');
    const next = withLease(writableRegistry, lease);
    await persist(next);
    return success(lease);
  });

  const activate = args => serialize(async () => {
    const input = readInput(args, ['leaseId', 'expectedRevision']);
    const leaseId = readLeaseId(input.leaseId);
    const expectedRevision = readRevision(input.expectedRevision);
    const registry = await loadRegistry();
    const lease = registry.leases[leaseId];
    const problem = assertTransition(lease, {
      states: ['prepared'], expectedRevision, now: readNow(),
    });
    if (problem) return failure(problem);
    const updated = {
      ...lease,
      activeMode: lease.pendingMode,
      pendingMode: null,
      state: 'active',
      revision: nextRevision(lease.revision),
    };
    await persist(withLease(registry, updated));
    return success(updated);
  });

  const beginSetMode = args => serialize(async () => {
    const input = readInput(args, ['leaseId', 'consumer', 'mode']);
    const leaseId = readLeaseId(input.leaseId);
    const consumer = assertConsumer(input.consumer);
    if (!isMode(input.mode)) throw new TypeError('PERSONA_INPUT_INVALID');
    const registry = await loadRegistry();
    const lease = registry.leases[leaseId];
    const problem = assertTransition(lease, { states: ['active'], consumer, now: readNow() });
    if (problem) return failure(problem);
    if (lease.pendingMode !== null || (lease.activeMode !== null && lease.activeMode === input.mode)) {
      return failure('PERSONA_TRANSITION_INVALID');
    }
    const updated = {
      ...lease,
      pendingMode: input.mode,
      revision: nextRevision(lease.revision),
    };
    await persist(withLease(registry, updated));
    return success(updated);
  });

  const commitSetMode = args => serialize(async () => {
    const input = readInput(args, ['leaseId', 'expectedRevision']);
    const leaseId = readLeaseId(input.leaseId);
    const expectedRevision = readRevision(input.expectedRevision);
    const registry = await loadRegistry();
    const lease = registry.leases[leaseId];
    const actionAt = readNow();
    const problem = assertTransition(lease, {
      states: ['active'], expectedRevision, allowExpired: true,
    });
    if (problem) return failure(problem);
    if (lease.pendingMode === null) return failure('PERSONA_TRANSITION_INVALID');
    if (actionAt < lease.lastExplicitActionAt) throw new TypeError('PERSONA_CLOCK_INVALID');
    const expiresAt = actionAt + TTL_MS;
    if (!Number.isSafeInteger(expiresAt)) throw new TypeError('PERSONA_CLOCK_INVALID');
    const updated = {
      ...lease,
      activeMode: lease.pendingMode,
      pendingMode: null,
      lastExplicitActionAt: actionAt,
      expiresAt,
      revision: nextRevision(lease.revision),
    };
    await persist(withLease(registry, updated));
    return success(updated);
  });

  const rollbackSetMode = args => serialize(async () => {
    const input = readInput(args, ['leaseId', 'expectedRevision']);
    const leaseId = readLeaseId(input.leaseId);
    const expectedRevision = readRevision(input.expectedRevision);
    const registry = await loadRegistry();
    const lease = registry.leases[leaseId];
    const problem = assertTransition(lease, {
      states: ['active'], expectedRevision, allowExpired: true,
    });
    if (problem) return failure(problem);
    if (lease.pendingMode === null) return failure('PERSONA_TRANSITION_INVALID');
    const updated = {
      ...lease,
      pendingMode: null,
      revision: nextRevision(lease.revision),
    };
    await persist(withLease(registry, updated));
    return success(updated);
  });

  const beginStop = args => serialize(async () => {
    const input = readInput(args, ['leaseId', 'consumer', 'explicit']);
    const leaseId = readLeaseId(input.leaseId);
    if (typeof input.explicit !== 'boolean') throw new TypeError('PERSONA_INPUT_INVALID');
    const consumer = input.consumer === null ? null : assertConsumer(input.consumer);
    const registry = await loadRegistry();
    const lease = registry.leases[leaseId];
    if (!lease) return failure('PERSONA_NOT_FOUND');

    if (input.explicit) {
      if (consumer === null || !sameConsumer(lease.consumer, consumer)) {
        return failure('PERSONA_CONSUMER_MISMATCH');
      }
      const problem = assertTransition(lease, { states: ['active'], now: readNow() });
      if (problem) return failure(problem);
    } else {
      if (consumer !== null) return failure('PERSONA_CONSUMER_MISMATCH');
      const problem = assertTransition(lease, {
        states: ['prepared', 'active', 'stopping'], allowExpired: true,
      });
      if (problem) return failure(problem);
    }
    const updated = {
      ...lease,
      pendingMode: null,
      state: 'stopping',
      revision: nextRevision(lease.revision),
    };
    await persist(withLease(registry, updated));
    return success(updated);
  });

  const completeStop = args => serialize(async () => {
    const input = readInput(args, ['leaseId', 'expectedRevision', 'explicit']);
    const leaseId = readLeaseId(input.leaseId);
    const expectedRevision = readRevision(input.expectedRevision);
    if (input.explicit !== true) return failure('PERSONA_TRANSITION_INVALID');
    const registry = await loadRegistry();
    const lease = registry.leases[leaseId];
    const problem = assertTransition(lease, {
      states: ['stopping'], expectedRevision, allowExpired: true,
    });
    if (problem) return failure(problem);
    const actionAt = readNow();
    if (actionAt < lease.lastExplicitActionAt) throw new TypeError('PERSONA_CLOCK_INVALID');
    const expiresAt = actionAt + TTL_MS;
    if (!Number.isSafeInteger(expiresAt)) throw new TypeError('PERSONA_CLOCK_INVALID');
    const updated = {
      ...lease,
      activeMode: null,
      pendingMode: null,
      lastExplicitActionAt: actionAt,
      expiresAt,
      state: 'active',
      revision: nextRevision(lease.revision),
    };
    await persist(withLease(registry, updated));
    return success(updated);
  });

  const rehydrate = args => serialize(async () => {
    const input = readInput(args, ['target', 'consumer']);
    const trustedTarget = assertTarget(input.target);
    const consumer = assertConsumer(input.consumer);
    if (consumer.windowId !== trustedTarget.windowId) throw new TypeError('PERSONA_INPUT_INVALID');
    const registry = await loadRegistry();
    const leaseId = registry.ownerByTarget[targetKey(trustedTarget)];
    const lease = leaseId ? registry.leases[leaseId] : null;
    if (lease && !sameTarget(lease.target, trustedTarget)) return failure('PERSONA_TARGET_MISMATCH');
    const problem = assertTransition(lease, { states: ['active'], now: readNow() });
    if (problem) return failure(problem);
    if (lease.pendingMode !== null) return failure('PERSONA_TRANSITION_INVALID');
    const updated = {
      ...lease,
      consumer,
      revision: nextRevision(lease.revision),
    };
    await persist(withLease(registry, updated));
    return success(updated);
  });

  const revoke = args => serialize(async () => {
    const input = readInput(args, ['leaseId', 'reason']);
    const leaseId = readLeaseId(input.leaseId);
    if (!REVOKE_REASONS.has(input.reason)) throw new TypeError('PERSONA_INPUT_INVALID');
    const registry = await loadRegistry();
    const lease = registry.leases[leaseId];
    const problem = assertTransition(lease, {
      states: ['prepared', 'active', 'stopping'], allowExpired: true,
    });
    if (problem) return failure(problem);
    const updated = {
      ...lease,
      pendingMode: null,
      state: 'revoked',
      revision: nextRevision(lease.revision),
      revokeReason: input.reason,
    };
    await persist(withLease(registry, updated));
    return success(updated);
  });

  const findOwner = target => serialize(async () => {
    const trustedTarget = assertTarget(target);
    const registry = await loadRegistry();
    const leaseId = registry.ownerByTarget[targetKey(trustedTarget)];
    const lease = leaseId ? registry.leases[leaseId] : null;
    return lease && sameTarget(lease.target, trustedTarget) ? cloneFrozen(lease) : null;
  });

  const snapshot = () => serialize(async () => cloneFrozen(await loadRegistry()));

  const listRecoverable = () => serialize(async () => {
    const registry = await loadRegistry();
    return cloneFrozen(Object.values(registry.leases).filter(lease =>
      lease.state === 'prepared' || lease.state === 'stopping'));
  });

  const listExpired = () => serialize(async () => {
    const registry = await loadRegistry();
    const actionAt = readNow();
    return cloneFrozen(Object.values(registry.leases).filter(lease =>
      lease.state !== 'revoked' && lease.expiresAt <= actionAt));
  });

  return Object.freeze({
    claimPrepared,
    activate,
    beginSetMode,
    commitSetMode,
    rollbackSetMode,
    beginStop,
    completeStop,
    rehydrate,
    revoke,
    findOwner,
    snapshot,
    listRecoverable,
    listExpired,
  });
}
