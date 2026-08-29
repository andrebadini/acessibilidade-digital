import { canonicalTime } from './run-audit.js';

const PREFIX = 'audita:owned-tab:v1:';
const RECORD_KEYS = Object.freeze([
  'version', 'ownerId', 'auditId', 'sessionCapabilityId', 'tabId', 'windowId',
  'cleanupMode', 'state', 'createdAt', 'updatedAt',
]);
const CLEANUP_MODES = new Set(['always', 'retain-after-observation']);
const STATES = new Set(['created', 'observing', 'retained-for-review', 'cleanup-pending', 'removed']);
const TRANSITIONS = new Set([
  'created:observing',
  'created:cleanup-pending',
  'observing:retained-for-review',
  'observing:cleanup-pending',
  'retained-for-review:cleanup-pending',
  'cleanup-pending:removed',
]);
const SESSION_OWNER_QUEUES = new WeakMap();

function serializeForOwner(sessionArea, ownerId, operation) {
  let owners = SESSION_OWNER_QUEUES.get(sessionArea);
  if (!owners) {
    owners = new Map();
    SESSION_OWNER_QUEUES.set(sessionArea, owners);
  }
  const tail = owners.get(ownerId) ?? Promise.resolve();
  const pending = tail.then(operation, operation);
  const guarded = pending.catch(() => {});
  owners.set(ownerId, guarded);
  guarded.finally(() => {
    if (owners.get(ownerId) === guarded) owners.delete(ownerId);
  });
  return pending;
}

function denied() {
  return new Error('OWNERSHIP_DENIED');
}

function validId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,160}$/u.test(value);
}

function exactRecord(value, ownerId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  let keys;
  try { keys = Reflect.ownKeys(value); } catch { return null; }
  if (keys.length !== RECORD_KEYS.length || RECORD_KEYS.some(key => !keys.includes(key))) return null;
  const record = {};
  for (const key of RECORD_KEYS) {
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(value, key); } catch { return null; }
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
    record[key] = descriptor.value;
  }
  if (record.version !== 1 || record.ownerId !== ownerId || !validId(record.ownerId) ||
    !validId(record.auditId) || !validId(record.sessionCapabilityId) ||
    !Number.isSafeInteger(record.tabId) || record.tabId < 0 ||
    !Number.isSafeInteger(record.windowId) || record.windowId < 0 ||
    !CLEANUP_MODES.has(record.cleanupMode) || !STATES.has(record.state) ||
    typeof record.createdAt !== 'string' || canonicalTime(record.createdAt) !== record.createdAt ||
    typeof record.updatedAt !== 'string' || canonicalTime(record.updatedAt) !== record.updatedAt) return null;
  return record;
}

function frozen(record) {
  return Object.freeze({ ...record });
}

export function createOwnedTabRegistry({ sessionArea, chromeAdapter, now }) {
  if (!sessionArea || typeof sessionArea.get !== 'function' || typeof sessionArea.set !== 'function' ||
    !chromeAdapter || typeof chromeAdapter.removeTab !== 'function' || typeof now !== 'function') {
    throw new TypeError('OWNERSHIP_DENIED');
  }
  const serialized = (ownerId, operation) => serializeForOwner(sessionArea, ownerId, operation);
  const read = async ownerId => {
    if (!validId(ownerId)) throw denied();
    const key = `${PREFIX}${ownerId}`;
    let stored;
    try { stored = (await sessionArea.get(key))?.[key]; } catch { throw denied(); }
    if (stored === undefined) return { key, record: null };
    const record = exactRecord(stored, ownerId);
    if (!record) throw denied();
    return { key, record };
  };
  const persist = async (key, record) => {
    try { await sessionArea.set({ [key]: record }); } catch { throw denied(); }
    let verified;
    try { verified = exactRecord((await sessionArea.get(key))?.[key], record.ownerId); } catch { throw denied(); }
    if (!verified || RECORD_KEYS.some(field => verified[field] !== record[field])) throw denied();
    return frozen(verified);
  };
  const compare = (record, { auditId, tabId, fromState }) => {
    if (!validId(auditId) || record.auditId !== auditId) throw denied();
    if (!Number.isSafeInteger(tabId) || record.tabId !== tabId) throw denied();
    if (!STATES.has(fromState) || record.state !== fromState) throw denied();
  };
  const updateState = async ({ key, record }, state, expected) => {
    const fresh = await read(record.ownerId);
    if (!fresh.record) throw denied();
    compare(fresh.record, expected);
    const confirmed = await read(record.ownerId);
    if (!confirmed.record) throw denied();
    compare(confirmed.record, expected);
    return persist(key, { ...confirmed.record, state, updatedAt: canonicalTime(now()) });
  };

  return Object.freeze({
    registerCreated(input) {
      return serialized(input?.ownerId, async () => {
        if (!input || !validId(input.ownerId) || !validId(input.auditId) ||
          !validId(input.sessionCapabilityId) || !Number.isSafeInteger(input.tabId) || input.tabId < 0 ||
          !Number.isSafeInteger(input.windowId) || input.windowId < 0 || !CLEANUP_MODES.has(input.cleanupMode)) {
          throw denied();
        }
        const current = await read(input.ownerId);
        if (current.record) throw denied();
        const confirmed = await read(input.ownerId);
        if (confirmed.record) throw denied();
        const at = canonicalTime(now());
        const base = {
          version: 1, ownerId: input.ownerId, auditId: input.auditId,
          sessionCapabilityId: input.sessionCapabilityId, tabId: input.tabId,
          windowId: input.windowId, cleanupMode: input.cleanupMode,
          state: 'created', createdAt: at, updatedAt: at,
        };
        try { return await persist(confirmed.key, base); } catch {
          const journal = { ...base, state: 'cleanup-pending', updatedAt: canonicalTime(now()) };
          return persist(confirmed.key, journal);
        }
      });
    },
    transition(input) {
      return serialized(input?.ownerId, async () => {
        const current = await read(input?.ownerId);
        if (!current.record || !validId(input?.auditId) || !STATES.has(input?.fromState) ||
          !STATES.has(input?.toState) || !TRANSITIONS.has(`${input.fromState}:${input.toState}`)) throw denied();
        compare(current.record, input);
        return updateState(current, input.toState, input);
      });
    },
    removeOwned(input) {
      return serialized(input?.ownerId, async () => {
        const current = await read(input?.ownerId);
        if (!current.record || current.record.state === 'removed') throw denied();
        compare(current.record, input ?? {});
        if (!['created', 'observing', 'retained-for-review', 'cleanup-pending'].includes(input.fromState)) throw denied();
        const pending = input.fromState === 'cleanup-pending'
          ? current.record
          : await updateState(current, 'cleanup-pending', input);
        const effectRead = await read(input.ownerId);
        compare(effectRead.record, { ...input, fromState: 'cleanup-pending' });
        try {
          await chromeAdapter.removeTab(effectRead.record.tabId);
          const afterEffect = await read(input.ownerId);
          compare(afterEffect.record, { ...input, fromState: 'cleanup-pending' });
          return updateState(afterEffect, 'removed', { ...input, fromState: 'cleanup-pending' });
        } catch {
          const verified = await read(input.ownerId);
          compare(verified.record, { ...input, fromState: 'cleanup-pending' });
          return frozen(verified.record);
        }
      });
    },
    markCleanupPending(input) {
      return serialized(input?.ownerId, async () => {
        const current = await read(input?.ownerId);
        if (!current.record || current.record.state === 'removed') throw denied();
        compare(current.record, input);
        return updateState(current, 'cleanup-pending', input);
      });
    },
    get(ownerId) {
      return serialized(ownerId, async () => {
        const { record } = await read(ownerId);
        return record ? frozen(record) : null;
      });
    },
  });
}
