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
  let tail = Promise.resolve();
  const serialized = operation => {
    const pending = tail.then(operation, operation);
    tail = pending.catch(() => {});
    return pending;
  };
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
    await sessionArea.set({ [key]: record });
    const verified = exactRecord((await sessionArea.get(key))?.[key], record.ownerId);
    if (!verified || RECORD_KEYS.some(field => verified[field] !== record[field])) throw denied();
    return frozen(verified);
  };
  const compare = (record, { auditId, tabId, fromState }) => {
    if (auditId !== undefined && record.auditId !== auditId) throw denied();
    if (!Number.isSafeInteger(tabId) || record.tabId !== tabId) throw denied();
    if (fromState !== undefined && record.state !== fromState) throw denied();
  };
  const updateState = async ({ key, record }, state) => persist(key, {
    ...record, state, updatedAt: canonicalTime(now()),
  });

  return Object.freeze({
    registerCreated(input) {
      return serialized(async () => {
        if (!input || !validId(input.ownerId) || !validId(input.auditId) ||
          !validId(input.sessionCapabilityId) || !Number.isSafeInteger(input.tabId) || input.tabId < 0 ||
          !Number.isSafeInteger(input.windowId) || input.windowId < 0 || !CLEANUP_MODES.has(input.cleanupMode)) {
          throw denied();
        }
        const current = await read(input.ownerId);
        if (current.record) throw denied();
        const at = canonicalTime(now());
        return persist(current.key, {
          version: 1, ownerId: input.ownerId, auditId: input.auditId,
          sessionCapabilityId: input.sessionCapabilityId, tabId: input.tabId,
          windowId: input.windowId, cleanupMode: input.cleanupMode,
          state: 'created', createdAt: at, updatedAt: at,
        });
      });
    },
    transition(input) {
      return serialized(async () => {
        const current = await read(input?.ownerId);
        if (!current.record || !validId(input?.auditId) || !STATES.has(input?.fromState) ||
          !STATES.has(input?.toState) || !TRANSITIONS.has(`${input.fromState}:${input.toState}`)) throw denied();
        compare(current.record, input);
        return updateState(current, input.toState);
      });
    },
    removeOwned(input) {
      return serialized(async () => {
        const current = await read(input?.ownerId);
        if (!current.record || current.record.state === 'removed') throw denied();
        compare(current.record, { tabId: input?.tabId });
        try {
          await chromeAdapter.removeTab(current.record.tabId);
          return updateState(current, 'removed');
        } catch {
          return updateState(current, 'cleanup-pending');
        }
      });
    },
    markCleanupPending(input) {
      return serialized(async () => {
        const current = await read(input?.ownerId);
        if (!current.record || current.record.state === 'removed') throw denied();
        compare(current.record, input);
        return updateState(current, 'cleanup-pending');
      });
    },
    get(ownerId) {
      return serialized(async () => {
        const { record } = await read(ownerId);
        return record ? frozen(record) : null;
      });
    },
  });
}
