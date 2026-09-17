import { canonicalAuditId } from '../storage/audit-retention.js';

const V2_PREFIX = 'audita:owned-tab:v2:';
const V1_PREFIX = 'audita:owned-tab:v1:';

const V2_RECORD_KEYS = Object.freeze([
  'version', 'ownershipId', 'auditId', 'purpose', 'tabId', 'windowId',
  'cleanupMode', 'state', 'createdAt', 'updatedAt',
]);
const V1_RECORD_KEYS = Object.freeze([
  'version', 'ownerId', 'auditId', 'sessionCapabilityId', 'tabId', 'windowId',
  'cleanupMode', 'state', 'createdAt', 'updatedAt',
]);
const IDENTITY_KEYS = Object.freeze(['ownershipId', 'auditId', 'purpose', 'tabId', 'windowId', 'cleanupMode']);
const PURPOSES = new Set(['audit', 'current-state-assist']);
const CLEANUP_MODES = new Set(['always', 'pre-observation-failure']);
const LEGACY_CLEANUP_MODES = new Set(['always', 'retain-after-observation']);
const STATES = new Set([
  'created', 'observing', 'retained-for-review', 'retained-for-consent',
  'cleanup-pending', 'removed',
]);
const LEGACY_STATES = new Set(['created', 'observing', 'retained-for-review', 'cleanup-pending', 'removed']);
const TRANSITIONS = new Set([
  'created:observing',
  'created:cleanup-pending',
  'observing:retained-for-review',
  'observing:retained-for-consent',
  'observing:cleanup-pending',
  'observing:removed',
  'retained-for-review:cleanup-pending',
  'retained-for-review:removed',
  'retained-for-consent:observing',
  'retained-for-consent:cleanup-pending',
  'retained-for-consent:removed',
  'cleanup-pending:removed',
]);
const SESSION_OWNER_QUEUES = new WeakMap();
const SESSION_AUDIT_QUEUES = new WeakMap();

function denied(kind = 'mismatch') {
  const error = new Error('OWNERSHIP_DENIED');
  error.ownershipKind = kind;
  return error;
}

function validId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,160}$/u.test(value);
}

function canonicalTime(value) {
  try {
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) return null;
    return date.toISOString();
  } catch {
    return null;
  }
}

function trustedTime(value) {
  const at = canonicalTime(value);
  if (!at) throw denied('clock');
  return at;
}

function serializeFrom(queues, sessionArea, queueId, operation) {
  let queue = queues.get(sessionArea);
  if (!queue) {
    queue = new Map();
    queues.set(sessionArea, queue);
  }
  const tail = queue.get(queueId) ?? Promise.resolve();
  const pending = tail.then(operation, operation);
  const guarded = pending.catch(() => {});
  queue.set(queueId, guarded);
  guarded.finally(() => {
    if (queue.get(queueId) === guarded) queue.delete(queueId);
  });
  return pending;
}

function serializeOwner(sessionArea, ownershipId, operation) {
  return serializeFrom(SESSION_OWNER_QUEUES, sessionArea, ownershipId, operation);
}

function serializeAudit(sessionArea, auditId, operation) {
  return serializeFrom(SESSION_AUDIT_QUEUES, sessionArea, auditId, operation);
}

function serializeAuditOwner(sessionArea, auditId, ownershipId, operation) {
  return serializeAudit(sessionArea, auditId, () => serializeOwner(sessionArea, ownershipId, operation));
}

function closedInput(value, expectedKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw denied();
  let keys;
  try { keys = Reflect.ownKeys(value); } catch { throw denied(); }
  if (keys.length !== expectedKeys.length || expectedKeys.some(key => !keys.includes(key))) throw denied();
  const result = {};
  for (const key of expectedKeys) {
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(value, key); } catch { throw denied(); }
    if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) throw denied();
    result[key] = descriptor.value;
  }
  return result;
}

function readDataProperties(value, keys, identityKey, identityValue) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  let ownKeys;
  try { ownKeys = Reflect.ownKeys(value); } catch { return null; }
  if (ownKeys.length !== keys.length || keys.some(key => !ownKeys.includes(key))) return null;
  const record = {};
  for (const key of keys) {
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(value, key); } catch { return null; }
    if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) return null;
    record[key] = descriptor.value;
  }
  if (record[identityKey] !== identityValue) return null;
  return record;
}

function exactV2(value, ownershipId) {
  const record = readDataProperties(value, V2_RECORD_KEYS, 'ownershipId', ownershipId);
  if (!record || record.version !== 2 || !validId(record.ownershipId) ||
    !validId(record.auditId) || !PURPOSES.has(record.purpose) ||
    !Number.isSafeInteger(record.tabId) || record.tabId < 0 ||
    !Number.isSafeInteger(record.windowId) || record.windowId < 0 ||
    !CLEANUP_MODES.has(record.cleanupMode) || !STATES.has(record.state) ||
    typeof record.createdAt !== 'string' || canonicalTime(record.createdAt) !== record.createdAt ||
    typeof record.updatedAt !== 'string' || canonicalTime(record.updatedAt) !== record.updatedAt) return null;
  return record;
}

function exactV1(value, ownerId) {
  const record = readDataProperties(value, V1_RECORD_KEYS, 'ownerId', ownerId);
  if (!record || record.version !== 1 || !validId(record.ownerId) ||
    !validId(record.auditId) || !validId(record.sessionCapabilityId) ||
    !Number.isSafeInteger(record.tabId) || record.tabId < 0 ||
    !Number.isSafeInteger(record.windowId) || record.windowId < 0 ||
    !LEGACY_CLEANUP_MODES.has(record.cleanupMode) || !LEGACY_STATES.has(record.state) ||
    typeof record.createdAt !== 'string' || canonicalTime(record.createdAt) !== record.createdAt ||
    typeof record.updatedAt !== 'string' || canonicalTime(record.updatedAt) !== record.updatedAt) return null;
  return record;
}

function frozen(record) {
  return Object.freeze({ ...record });
}

function queueOwnerId(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return '';
  try {
    const descriptor = Object.getOwnPropertyDescriptor(input, 'ownershipId');
    return descriptor && Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'string'
      ? descriptor.value : '';
  } catch {
    return '';
  }
}

function queueAuditId(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return '';
  try {
    const descriptor = Object.getOwnPropertyDescriptor(input, 'auditId');
    return descriptor && Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'string'
      ? descriptor.value : '';
  } catch {
    return '';
  }
}

function storageProperty(container, key) {
  if (!container || typeof container !== 'object' || Array.isArray(container)) return { ok: false, exists: false };
  let descriptor;
  try { descriptor = Object.getOwnPropertyDescriptor(container, key); } catch { return { ok: false, exists: false }; }
  if (!descriptor) return { ok: true, exists: false };
  if (!Object.hasOwn(descriptor, 'value')) return { ok: false, exists: true };
  return { ok: true, exists: true, value: descriptor.value };
}

function sameRecord(a, b) {
  return V2_RECORD_KEYS.every(key => a[key] === b[key]);
}

function sameLegacyRecord(a, b) {
  return V1_RECORD_KEYS.every(key => a[key] === b[key]);
}

function sameIdentity(a, b) {
  return IDENTITY_KEYS.every(key => a[key] === b[key]);
}

function isSafeInventoryMismatch(error) {
  return error?.ownershipKind === 'mismatch' || error?.ownershipKind === 'malformed';
}

export function createOwnedTabRegistry({ sessionArea, chromeAdapter, now }) {
  if (!sessionArea || typeof sessionArea.get !== 'function' || typeof sessionArea.set !== 'function' ||
    typeof sessionArea.remove !== 'function' || !chromeAdapter || typeof chromeAdapter.removeTab !== 'function' ||
    // `getTab` é OBRIGATÓRIO: sem reatestação viva o registro não tem como provar que o id ainda é a aba
    // que a auditoria criou, e um adaptador que não saiba responder isso não pode fechar aba nenhuma.
    typeof chromeAdapter.getTab !== 'function' ||
    typeof now !== 'function') throw denied();

  const keyFor = ownershipId => `${V2_PREFIX}${ownershipId}`;

  const read = async ownershipId => {
    if (!validId(ownershipId)) throw denied();
    const key = keyFor(ownershipId);
    let stored;
    let property;
    try { property = storageProperty(await sessionArea.get(key), key); } catch { throw denied('storage'); }
    if (!property.ok) throw denied('malformed');
    if (!property.exists || property.value === undefined) return { key, record: null };
    stored = property.value;
    const record = exactV2(stored, ownershipId);
    if (!record) throw denied('malformed');
    return { key, record };
  };

  const readLegacy = async ownerId => {
    if (!validId(ownerId)) throw denied();
    const key = `${V1_PREFIX}${ownerId}`;
    let stored;
    let property;
    try { property = storageProperty(await sessionArea.get(key), key); } catch { throw denied('storage'); }
    if (!property.ok) throw denied('malformed');
    if (!property.exists || property.value === undefined) return { key, record: null, exists: false };
    stored = property.value;
    return { key, record: exactV1(stored, ownerId), exists: true };
  };

  const persist = async (key, record) => {
    const copy = { ...record };
    if (!exactV2(copy, copy.ownershipId)) throw denied();
    let stored;
    let property;
    try {
      await sessionArea.set({ [key]: copy });
    } catch {
      // A storage API may commit and then report an error. Treat that case as
      // success only after an exact readback; otherwise fail closed.
      try { property = storageProperty(await sessionArea.get(key), key); } catch { throw denied('storage'); }
      if (!property.ok || !property.exists) throw denied('storage');
      const committed = exactV2(property.value, copy.ownershipId);
      if (!committed || !sameRecord(committed, copy)) throw denied('storage');
      return frozen(committed);
    }
    try { property = storageProperty(await sessionArea.get(key), key); } catch { throw denied('storage'); }
    if (!property.ok || !property.exists) throw denied('storage');
    const verified = exactV2(property.value, copy.ownershipId);
    if (!verified || !sameRecord(verified, copy)) throw denied('storage');
    return frozen(verified);
  };

  const compare = (record, expected) => {
    if (!expected || record.ownershipId !== expected.ownershipId ||
      record.auditId !== expected.auditId || record.tabId !== expected.tabId ||
      record.state !== expected.fromState) throw denied();
  };

  const updateState = async ({ key, record }, toState, expected) => {
    const fresh = await read(record.ownershipId);
    if (!fresh.record) throw denied();
    compare(fresh.record, expected);
    const confirmed = await read(record.ownershipId);
    if (!confirmed.record) throw denied();
    compare(confirmed.record, expected);
    return persist(key, { ...confirmed.record, state: toState, updatedAt: trustedTime(now()) });
  };

  // REATESTAÇÃO VIVA, imediatamente antes de cada efeito destrutivo. O journal prova qual aba a auditoria
  // REGISTROU; ele não prova que o id de hoje ainda é aquela aba — o Chrome recicla `tabId` e o registro
  // pode ter sido reescrito por quem alcança `chrome.storage.session`. Sem esta leitura, a limpeza fechava
  // a aba 99 de um journal adulterado (achado D1 da revisão da 1.1.37).
  //
  // TRÊS desfechos, e a diferença entre eles é a correção do Important I-2 da revisão da 1.1.38:
  // — `match`: o id é uma aba viva na janela registrada, e o efeito acontece;
  // — `mismatch`: existe aba viva com esse id, mas NÃO é a registrada (janela diferente, ou id reciclado);
  //   nada é fechado e o chamador recusa;
  // — `absent`: o adaptador RESPONDEU que a aba não existe (`getTab` devolve `null`). A limpeza está
  //   satisfeita sem efeito — a aba já não está lá — e o registro pode ir para `removed`;
  // — `unknown`: a LEITURA falhou (adaptador quebrado, erro transitório do navegador). Nada é fechado e o
  //   registro NÃO pode ser dado como limpo: fica em `cleanup-pending` para nova tentativa. Antes desta
  //   correção a exceção virava `absent`, a aba continuava aberta e o journal ia para `removed` — a
  //   limpeza ficava dada por feita sem ter fechado nada, e `clearAudit` devolvia 1.
  const liveTabState = async record => {
    let live;
    try { live = await chromeAdapter.getTab(record.tabId); } catch { return 'unknown'; }
    if (live === null || live === undefined) return 'absent';
    if (typeof live !== 'object' || live.id !== record.tabId) return 'mismatch';
    if (live.windowId !== record.windowId) return 'mismatch';
    return 'match';
  };

  const cleanupV2 = async (current, input) => {
    const { key, record } = current;
    if (record.state === 'removed') throw denied();
    compare(record, input);
    const pending = record.state === 'cleanup-pending'
      ? frozen(record)
      : await updateState(current, 'cleanup-pending', input);
    const beforeEffect = await read(pending.ownershipId);
    if (!beforeEffect.record) throw denied();
    compare(beforeEffect.record, { ...input, fromState: 'cleanup-pending' });
    const live = await liveTabState(beforeEffect.record);
    if (live === 'mismatch') throw denied('mismatch');
    // Leitura impossível: fail-closed, o registro fica pendente para a próxima passagem.
    if (live === 'unknown') return frozen(beforeEffect.record);
    if (live === 'match') {
      try {
        await chromeAdapter.removeTab(beforeEffect.record.tabId);
      } catch {
        return frozen(beforeEffect.record);
      }
    }
    const afterEffect = await read(pending.ownershipId);
    if (!afterEffect.record) throw denied();
    compare(afterEffect.record, { ...input, fromState: 'cleanup-pending' });
    return updateState(afterEffect, 'removed', { ...input, fromState: 'cleanup-pending' });
  };

  const cleanupV1 = async (key, record) => {
    if (!record) return 0;
    let property;
    try { property = storageProperty(await sessionArea.get(key), key); } catch { throw denied('storage'); }
    if (!property.ok || !property.exists) return 0;
    const beforeEffect = exactV1(property.value, record.ownerId);
    if (!beforeEffect || beforeEffect.auditId !== record.auditId || !sameLegacyRecord(beforeEffect, record)) return 0;
    if (record.state !== 'removed') {
      const live = await liveTabState(record);
      if (live === 'mismatch') throw denied('mismatch');
      // Leitura impossível no V1 também é fail-closed: o registro legado fica onde está.
      if (live === 'unknown') return 0;
      if (live === 'match') {
        try { await chromeAdapter.removeTab(record.tabId); } catch { throw denied('cleanup'); }
      }
    }
    let current;
    try { property = storageProperty(await sessionArea.get(key), key); } catch { throw denied('storage'); }
    if (!property.ok) return 0;
    current = property.exists ? property.value : undefined;
    if (!exactV1(current, record.ownerId) || current.auditId !== record.auditId ||
      current.tabId !== record.tabId || !sameLegacyRecord(current, record)) return 0;
    try {
      await sessionArea.remove(key);
    } catch {
      // `remove` can commit before rejecting. Verify absence so callers do not
      // report a false cleanup failure and retry an already removed record.
      try { property = storageProperty(await sessionArea.get(key), key); } catch { throw denied('storage'); }
      if (!property.ok) throw denied('storage');
      if (!property.exists) return 1;
      throw denied('cleanup');
    }
    try { property = storageProperty(await sessionArea.get(key), key); } catch { throw denied('storage'); }
    if (!property.ok) throw denied('storage');
    if (property.exists) throw denied('cleanup');
    return 1;
  };

  return Object.freeze({
    registerCreated(input) {
      return serializeAuditOwner(sessionArea, queueAuditId(input), queueOwnerId(input), async () => {
        const value = closedInput(input, ['ownershipId', 'auditId', 'purpose', 'tabId', 'windowId', 'cleanupMode']);
        if (!validId(value.ownershipId) || !validId(value.auditId) || !PURPOSES.has(value.purpose) ||
          !Number.isSafeInteger(value.tabId) || value.tabId < 0 || !Number.isSafeInteger(value.windowId) || value.windowId < 0 ||
          !CLEANUP_MODES.has(value.cleanupMode)) throw denied();
        const current = await read(value.ownershipId);
        const legacy = await readLegacy(value.ownershipId);
        if (current.record || legacy.exists) throw denied();
        const at = trustedTime(now());
        return persist(keyFor(value.ownershipId), {
          version: 2, ownershipId: value.ownershipId, auditId: value.auditId, purpose: value.purpose,
          tabId: value.tabId, windowId: value.windowId, cleanupMode: value.cleanupMode,
          state: 'created', createdAt: at, updatedAt: at,
        });
      });
    },

    transition(input) {
      return serializeAuditOwner(sessionArea, queueAuditId(input), queueOwnerId(input), async () => {
        const value = closedInput(input, ['ownershipId', 'auditId', 'tabId', 'fromState', 'toState']);
        if (!validId(value.ownershipId) || !validId(value.auditId) || !Number.isSafeInteger(value.tabId) ||
          !STATES.has(value.fromState) || !STATES.has(value.toState) || !TRANSITIONS.has(`${value.fromState}:${value.toState}`)) throw denied();
        const current = await read(value.ownershipId);
        if (!current.record) throw denied();
        compare(current.record, value);
        return updateState(current, value.toState, value);
      });
    },

    removeOwned(input) {
      return serializeAuditOwner(sessionArea, queueAuditId(input), queueOwnerId(input), async () => {
        const value = closedInput(input, ['ownershipId', 'auditId', 'tabId', 'fromState']);
        if (!validId(value.ownershipId) || !validId(value.auditId) || !Number.isSafeInteger(value.tabId) || !STATES.has(value.fromState)) throw denied();
        const current = await read(value.ownershipId);
        if (!current.record) throw denied();
        return cleanupV2(current, value);
      });
    },

    markCleanupPending(input) {
      return serializeAuditOwner(sessionArea, queueAuditId(input), queueOwnerId(input), async () => {
        const value = closedInput(input, ['ownershipId', 'auditId', 'tabId', 'fromState']);
        if (!validId(value.ownershipId) || !validId(value.auditId) || !Number.isSafeInteger(value.tabId) || !STATES.has(value.fromState)) throw denied();
        const current = await read(value.ownershipId);
        if (!current.record || current.record.state === 'removed') throw denied();
        return updateState(current, 'cleanup-pending', value);
      });
    },

    get(ownershipId) {
      return serializeOwner(sessionArea, ownershipId, async () => {
        const { record } = await read(ownershipId);
        return record ? frozen(record) : null;
      });
    },

    clearAudit(auditId) {
      return serializeAudit(sessionArea, typeof auditId === 'string' ? auditId : '', async () => {
        try { canonicalAuditId(auditId); } catch { throw denied(); }
        let all;
        try { all = await sessionArea.get(null); } catch { throw denied(); }
        if (!all || typeof all !== 'object' || Array.isArray(all)) throw denied();
        let keys;
        try { keys = Reflect.ownKeys(all); } catch { throw denied(); }
        let count = 0;
        let operationalError = null;
        for (const key of keys) {
          if (typeof key !== 'string') continue;
          if (key.startsWith(V2_PREFIX)) {
            const ownershipId = key.slice(V2_PREFIX.length);
            if (!validId(ownershipId)) continue;
            const property = storageProperty(all, key);
            const candidate = property.ok && property.exists ? exactV2(property.value, ownershipId) : null;
            if (!candidate || candidate.auditId !== auditId || candidate.state === 'removed') continue;
            count += (await serializeOwner(sessionArea, ownershipId, async () => {
              let current;
              try { current = await read(ownershipId); } catch (error) {
                if (isSafeInventoryMismatch(error)) return 0;
                operationalError ||= error;
                return 0;
              }
              if (!current.record || current.record.auditId !== auditId || !sameIdentity(current.record, candidate) ||
                current.record.state === 'removed') return 0;
              // The snapshot is only a candidate selector. The fresh state is
              // the CAS source, so a concurrent state transition cannot abort
              // cleanup for this audit or make us act on an old state.
              const input = {
                ownershipId, auditId, tabId: current.record.tabId, fromState: current.record.state,
              };
              let cleanupResult;
              try { cleanupResult = await cleanupV2(current, input); } catch (error) {
                if (isSafeInventoryMismatch(error)) return 0;
                operationalError ||= error;
                return 0;
              }
              if (cleanupResult?.state === 'cleanup-pending') {
                operationalError ||= denied('cleanup');
                return 0;
              }
              let after;
              try { after = await read(ownershipId); } catch (error) {
                if (isSafeInventoryMismatch(error)) return 0;
                operationalError ||= error;
                return 0;
              }
              return after.record?.state === 'removed' ? 1 : 0;
            })) || 0;
          } else if (key.startsWith(V1_PREFIX)) {
            const ownerId = key.slice(V1_PREFIX.length);
            if (!validId(ownerId)) continue;
            const property = storageProperty(all, key);
            const candidate = property.ok && property.exists ? exactV1(property.value, ownerId) : null;
            if (!candidate || candidate.auditId !== auditId) continue;
            count += await serializeOwner(sessionArea, ownerId, async () => {
              try { return await cleanupV1(`${V1_PREFIX}${ownerId}`, candidate); } catch (error) {
                if (isSafeInventoryMismatch(error)) return 0;
                operationalError ||= error;
                return 0;
              }
            });
          }
        }
        if (operationalError) throw operationalError;
        return count;
      });
    },

    purgeRemovedAudit(auditId) {
      return serializeAudit(sessionArea, typeof auditId === 'string' ? auditId : '', async () => {
        try {
          canonicalAuditId(auditId);
          const all = await sessionArea.get(null);
          if (!all || typeof all !== 'object' || Array.isArray(all)) throw denied();
          const candidates = [];
          for (const key of Reflect.ownKeys(all)) {
            if (typeof key !== 'string' || !key.startsWith(V2_PREFIX) && !key.startsWith(V1_PREFIX)) continue;
            const property = storageProperty(all, key);
            const identity = property.ok && property.exists ? storageProperty(property.value, 'auditId') : null;
            if (!identity?.ok || !identity.exists || identity.value !== auditId) continue;
            if (!key.startsWith(V2_PREFIX)) throw denied();
            const ownershipId = key.slice(V2_PREFIX.length);
            const record = exactV2(property.value, ownershipId);
            if (!record || record.state !== 'removed') throw denied();
            candidates.push(record);
          }
          let count = 0;
          for (const candidate of candidates) {
            count += await serializeOwner(sessionArea, candidate.ownershipId, async () => {
              const current = await read(candidate.ownershipId);
              if (!current.record) return 0;
              if (!sameRecord(current.record, candidate) || current.record.state !== 'removed') throw denied();
              try { await sessionArea.remove(current.key); } catch { /* Confirm a possible commit below. */ }
              const after = storageProperty(await sessionArea.get(current.key), current.key);
              if (!after.ok || after.exists) throw denied();
              return 1;
            });
          }
          return count;
        } catch { throw denied('cleanup'); }
      });
    },
  });
}
