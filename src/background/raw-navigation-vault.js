import { canonicalNavigationUrl, isEvidenceUrlV1, sanitizeEvidenceUrlV1 } from '../core/privacy/evidence-url.js';
import { normalizeAuditUrl } from '../core/url.js';

const PREFIX = 'audita:raw-navigation:v1:';
const QUEUE_PREFIX = 'audita:raw-navigation-queue:v1:';
const LEGACY_TTL_MS = 60_000;
const SINGLE_USE_TTL_MS = 600_000;
const BATCH_TTL_MS = 7_200_000;
const PURPOSES = new Set(['single-url', 'batch-page', 'context-menu-link', 'current-state-assist']);
const QUEUE_STATUSES = new Set(['pending', 'running', 'finished']);
const LEGACY_RECORD_KEYS = Object.freeze(['version', 'navigationToken', 'ownerId', 'rawUrl', 'issuedAt', 'expiresAt', 'state']);
const RECORD_KEYS = Object.freeze(['version', 'auditId', 'purpose', 'rawUrl', 'issuedAt', 'expiresAt']);
const QUEUE_KEYS = Object.freeze(['version', 'auditId', 'ownerOperationId', 'revision', 'issuedAt', 'expiresAt', 'nextIndex', 'entries']);
const QUEUE_ENTRY_KEYS = Object.freeze(['line', 'navigationToken', 'evidenceUrl', 'sessionDigest', 'status']);
const EVIDENCE_URL_KEYS = Object.freeze(['version', 'href', 'queryIncluded', 'redactedSegments']);
const CLEANUP_MARKER_KEY = 'audita:raw-navigation-cleanup:v1';
const CLEANUP_MARKER_KEYS = Object.freeze(['version', 'keys']);
const MARKER_UNAVAILABLE = Symbol('marker-unavailable');
const MARKER_MALFORMED = Symbol('marker-malformed');
const SESSION_STATES = new WeakMap();

function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    const own = Reflect.ownKeys(value);
    if (own.length !== keys.length || keys.some(key => !own.includes(key))) return null;
    const copy = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      copy[key] = descriptor.value;
    }
    return copy;
  } catch { return null; }
}

function dense(value) {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
    const own = Reflect.ownKeys(value);
    const expected = ['length', ...Array.from({ length: value.length }, (_unused, index) => String(index))];
    if (own.length !== expected.length || expected.some(key => !own.includes(key))) return null;
    const copy = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      copy.push(descriptor.value);
    }
    return copy;
  } catch { return null; }
}

function freeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freeze(child, seen);
  return Object.freeze(value);
}

function same(left, right) {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) !== Array.isArray(right)) return false;
  const leftKeys = Reflect.ownKeys(left); const rightKeys = Reflect.ownKeys(right);
  return leftKeys.length === rightKeys.length && leftKeys.every(key => rightKeys.includes(key) && same(left[key], right[key]));
}

function validId(value) { return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,160}$/u.test(value); }
function validToken(value) { return typeof value === 'string' && /^[A-Za-z0-9_-]{22}$/u.test(value); }
function validDigest(value) { return typeof value === 'string' && /^hmac-sha256:[A-Za-z0-9_-]{43}$/u.test(value); }
function validClock(value) { return Number.isSafeInteger(value) && value >= 0; }
function validRawUrl(value) { try { return typeof value === 'string' && normalizeAuditUrl(value) === value; } catch { return false; } }
function ttlFor(purpose) { return purpose === 'batch-page' ? BATCH_TTL_MS : SINGLE_USE_TTL_MS; }
function unavailable() { return new Error('RAW_NAVIGATION_UNAVAILABLE'); }
function consumed() { return new Error('Navegação expirada ou consumida.'); }
function wrongPurpose() { return new Error('Finalidade não corresponde.'); }
function wrongAudit() { return new Error('Auditoria não corresponde.'); }
function staleQueue() { return new Error('Fila de navegação desatualizada.'); }
function cleanupPending() { return new Error('RAW_NAVIGATION_CLEANUP_PENDING'); }

function token(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 16) throw new TypeError('RAW_NAVIGATION_INVALID');
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

function stateFor(sessionArea) {
  let state = SESSION_STATES.get(sessionArea);
  if (!state) {
    state = { tail: Promise.resolve(), highWater: null, bindings: new Map(), pendingCleanup: new Set(), markerSeen: false };
    SESSION_STATES.set(sessionArea, state);
  }
  return state;
}

function currentTime(now, state) {
  let value;
  try { value = now(); } catch { return null; }
  if (!validClock(value)) {
    if (typeof value !== 'string') return null;
    const parsed = new Date(value);
    value = Number.isFinite(parsed.getTime()) && parsed.toISOString() === value ? parsed.getTime() : null;
  }
  if (!validClock(value) || (state.highWater !== null && value < state.highWater)) return null;
  state.highWater = value;
  return value;
}

function publicRecord(value) {
  const record = exact(value, RECORD_KEYS);
  if (!record || record.version !== 'RawNavigationUrlV1' || !validId(record.auditId) || !PURPOSES.has(record.purpose) ||
    !validRawUrl(record.rawUrl) || !validClock(record.issuedAt) || !validClock(record.expiresAt) ||
    record.expiresAt - record.issuedAt !== ttlFor(record.purpose)) return null;
  return freeze(record);
}

function parseQueueEntry(value) {
  const entry = exact(value, QUEUE_ENTRY_KEYS);
  const evidenceUrl = entry && exact(entry.evidenceUrl, EVIDENCE_URL_KEYS);
  if (!entry || !Number.isSafeInteger(entry.line) || entry.line < 1 || !validToken(entry.navigationToken) ||
    !evidenceUrl || !isEvidenceUrlV1(evidenceUrl) || !validDigest(entry.sessionDigest) || !QUEUE_STATUSES.has(entry.status)) return null;
  return freeze({ ...entry, evidenceUrl });
}

function parseQueue(value) {
  const queue = exact(value, QUEUE_KEYS);
  if (!queue || queue.version !== 1 || !validId(queue.auditId) || !validToken(queue.ownerOperationId) ||
    !Number.isSafeInteger(queue.revision) || queue.revision < 1 || !validClock(queue.issuedAt) ||
    !validClock(queue.expiresAt) || queue.expiresAt - queue.issuedAt !== BATCH_TTL_MS ||
    !Number.isSafeInteger(queue.nextIndex) || queue.nextIndex < 0) return null;
  const entries = dense(queue.entries);
  if (!entries || entries.length < 1 || entries.length > 20 || queue.nextIndex > entries.length) return null;
  const parsed = entries.map(parseQueueEntry);
  if (parsed.some(entry => entry === null) || new Set(parsed.map(entry => entry.line)).size !== parsed.length ||
    new Set(parsed.map(entry => entry.navigationToken)).size !== parsed.length) return null;
  for (let index = 0; index < queue.nextIndex; index += 1) if (parsed[index].status !== 'finished') return null;
  if (queue.nextIndex === parsed.length) {
    if (parsed.some(entry => entry.status !== 'finished')) return null;
  } else {
    if (!['pending', 'running'].includes(parsed[queue.nextIndex].status) ||
      parsed.slice(queue.nextIndex + 1).some(entry => entry.status !== 'pending')) return null;
  }
  return freeze({ ...queue, entries: parsed });
}

function queueState(queue) { return freeze({ nextIndex: queue.nextIndex, status: queue.entries[queue.nextIndex]?.status ?? 'finished' }); }
function parseExpectedState(value) {
  const state = exact(value, ['nextIndex', 'status']);
  return state && Number.isSafeInteger(state.nextIndex) && state.nextIndex >= 0 && QUEUE_STATUSES.has(state.status) ? freeze(state) : null;
}

function sameQueueMetadata(left, right) {
  return left.line === right.line && left.navigationToken === right.navigationToken &&
    same(left.evidenceUrl, right.evidenceUrl) && left.sessionDigest === right.sessionDigest;
}

function validTransition(current, desired) {
  if (current.nextIndex >= current.entries.length) return false;
  if (desired.nextIndex < current.nextIndex || desired.nextIndex > current.nextIndex + 1 ||
    desired.entries.length !== current.entries.length ||
    desired.entries.some((entry, index) => !sameQueueMetadata(entry, current.entries[index]))) return false;
  for (let index = 0; index < current.nextIndex; index += 1) if (desired.entries[index].status !== 'finished') return false;
  if (desired.nextIndex === current.nextIndex) {
    const before = current.entries[current.nextIndex];
    const after = desired.entries[desired.nextIndex];
    return before.status === 'pending' && after.status === 'running';
  }
  return desired.entries[current.nextIndex].status === 'finished';
}

function dropBindings(state, tokens) {
  for (const navigationToken of tokens) state.bindings.delete(navigationToken);
}

function tokensForKeys(keys) {
  return keys.filter(key => key.startsWith(PREFIX)).map(key => key.slice(PREFIX.length));
}

function validCleanupKey(key) {
  return typeof key === 'string' &&
    (key.startsWith(PREFIX) ? validToken(key.slice(PREFIX.length)) :
      key.startsWith(QUEUE_PREFIX) && validId(key.slice(QUEUE_PREFIX.length)));
}

function cleanupMarker(value) {
  const marker = exact(value, CLEANUP_MARKER_KEYS);
  const keys = marker && dense(marker.keys);
  if (!marker || marker.version !== 1 || !keys || keys.length > 256 ||
    keys.some(key => !validCleanupKey(key)) || new Set(keys).size !== keys.length) return null;
  return freeze({ version: 1, keys: [...keys].sort() });
}

function ownValue(value, key) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) return undefined;
    return Object.hasOwn(descriptor, 'value') ? descriptor.value : MARKER_MALFORMED;
  } catch { return MARKER_MALFORMED; }
}

async function erase(sessionArea, key) {
  try { await sessionArea.remove(key); return !Object.hasOwn(await sessionArea.get(key), key); } catch { return false; }
}

async function all(sessionArea) {
  const value = await sessionArea.get(null);
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error();
    const entries = [];
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') throw new Error();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error();
      entries.push([key, descriptor.value]);
    }
    return entries;
  } catch { throw unavailable(); }
}

async function cleanupNamespaceKeys(sessionArea) {
  const value = await sessionArea.get(null);
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error();
    return Reflect.ownKeys(value).filter(key => typeof key === 'string' && validCleanupKey(key));
  } catch { throw unavailable(); }
}

function recordAuditId(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, 'auditId');
    return descriptor?.enumerable && Object.hasOwn(descriptor, 'value') && validId(descriptor.value) ? descriptor.value : null;
  } catch { return null; }
}

async function removeKeys(sessionArea, keys) {
  try {
    await sessionArea.remove(keys);
    const entries = await all(sessionArea);
    return !entries.some(([key]) => keys.includes(key));
  } catch { return false; }
}

export function createRawNavigationVaultV1({ sessionArea, digestManager = null, now, randomBytes }) {
  if (!sessionArea || typeof sessionArea.get !== 'function' || typeof sessionArea.set !== 'function' ||
    typeof sessionArea.remove !== 'function' || typeof now !== 'function' || typeof randomBytes !== 'function' ||
    (digestManager !== null && typeof digestManager?.digest !== 'function')) throw new TypeError('RAW_NAVIGATION_INVALID');
  const state = stateFor(sessionArea);
  const markerValue = async () => {
    try {
      const value = ownValue(await sessionArea.get(CLEANUP_MARKER_KEY), CLEANUP_MARKER_KEY);
      if (value === MARKER_MALFORMED) return null;
      return value === undefined ? undefined : cleanupMarker(value);
    } catch { return MARKER_UNAVAILABLE; }
  };
  const persistMarker = async () => {
    const marker = freeze({ version: 1, keys: [...state.pendingCleanup].sort() });
    state.markerSeen = true;
    try { await sessionArea.set({ [CLEANUP_MARKER_KEY]: marker }); } catch { /* confirm below */ }
    return same(await markerValue(), marker);
  };
  const clearMarker = async () => {
    const marker = await markerValue();
    if (marker === MARKER_UNAVAILABLE) return false;
    if (marker === undefined) { state.markerSeen = false; return true; }
    if (!await erase(sessionArea, CLEANUP_MARKER_KEY)) return false;
    state.markerSeen = false;
    return true;
  };
  const loadPersistedMarker = async () => {
    const value = await markerValue();
    if (value === MARKER_UNAVAILABLE) return false;
    if (value === undefined) return true;
    state.markerSeen = true;
    if (value) {
      for (const key of value.keys) state.pendingCleanup.add(key);
      return true;
    }
    let keys;
    try { keys = await cleanupNamespaceKeys(sessionArea); } catch { return false; }
    for (const key of keys) state.pendingCleanup.add(key);
    await persistMarker();
    return true;
  };
  const removeOrPend = async keys => {
    const unique = [...new Set(keys)];
    for (const key of unique) state.pendingCleanup.add(key);
    await persistMarker();
    if (!await removeKeys(sessionArea, unique)) return false;
    for (const key of unique) state.pendingCleanup.delete(key);
    dropBindings(state, tokensForKeys(unique));
    return state.pendingCleanup.size === 0 ? clearMarker() : persistMarker();
  };
  const drainPending = async () => {
    if (!await loadPersistedMarker()) return false;
    if (state.pendingCleanup.size === 0) return state.markerSeen ? clearMarker() : true;
    const keys = [...state.pendingCleanup];
    await persistMarker();
    if (!await removeKeys(sessionArea, keys)) return false;
    state.pendingCleanup.clear();
    dropBindings(state, tokensForKeys(keys));
    return clearMarker();
  };
  const serial = operation => {
    const guarded = async () => {
      if (!await drainPending()) throw cleanupPending();
      return operation();
    };
    const pending = state.tail.then(guarded, guarded);
    state.tail = pending.catch(() => {});
    return pending;
  };
  const readPublic = async navigationToken => {
    if (!validToken(navigationToken)) throw consumed();
    const key = `${PREFIX}${navigationToken}`;
    let value; try { value = (await sessionArea.get(key))?.[key]; } catch { throw consumed(); }
    const record = publicRecord(value); if (!record) throw consumed();
    return { key, record };
  };
  const readQueue = async auditId => {
    if (!validId(auditId)) throw staleQueue();
    const key = `${QUEUE_PREFIX}${auditId}`;
    let value; try { value = (await sessionArea.get(key))?.[key]; } catch { throw staleQueue(); }
    if (value === undefined) return { key, queue: null };
    const queue = parseQueue(value); if (!queue || queue.auditId !== auditId) throw staleQueue();
    return { key, queue };
  };
  const readLegacy = async (ownerId, navigationToken) => {
    if (!validId(ownerId) || !validToken(navigationToken)) throw unavailable();
    const key = `${PREFIX}${navigationToken}`;
    let value; try { value = (await sessionArea.get(key))?.[key]; } catch { throw unavailable(); }
    const record = exact(value, LEGACY_RECORD_KEYS);
    if (!record || record.version !== 1 || record.navigationToken !== navigationToken || record.ownerId !== ownerId ||
      !validRawUrl(record.rawUrl) || !validClock(record.issuedAt) || !validClock(record.expiresAt) ||
      record.expiresAt <= record.issuedAt || record.state !== 'prepared') throw unavailable();
    return { key, record };
  };

  return freeze({
    putInternal({ ownerId, rawUrl }) { return serial(async () => {
      if (!validId(ownerId) || !validRawUrl(rawUrl)) throw new TypeError('RAW_NAVIGATION_INVALID');
      const issuedAt = currentTime(now, state); if (issuedAt === null || issuedAt > Number.MAX_SAFE_INTEGER - LEGACY_TTL_MS) throw new TypeError('RAW_NAVIGATION_INVALID');
      const navigationToken = token(randomBytes(16)); const expiresAt = issuedAt + LEGACY_TTL_MS; const key = `${PREFIX}${navigationToken}`;
      const record = freeze({ version: 1, navigationToken, ownerId, rawUrl, issuedAt, expiresAt, state: 'prepared' });
      const confirmedWrite = async () => {
        try { return same(exact((await sessionArea.get(key))?.[key], LEGACY_RECORD_KEYS), record); } catch { return false; }
      };
      let writeAttempted = false;
      try {
        if (Object.hasOwn(await sessionArea.get(key), key)) throw unavailable();
        writeAttempted = true;
        await sessionArea.set({ [key]: record });
        if (!await confirmedWrite()) throw unavailable();
      } catch {
        if (writeAttempted && await confirmedWrite()) return freeze({ navigationToken, expiresAt });
        if (writeAttempted && !await removeOrPend([key])) throw cleanupPending();
        throw unavailable();
      }
      return freeze({ navigationToken, expiresAt });
    }); },
    takeInternal({ ownerId, navigationToken }) { return serial(async () => {
      const { key, record } = await readLegacy(ownerId, navigationToken); const nowValue = currentTime(now, state);
      if (nowValue === null || nowValue < record.issuedAt) { if (!await removeOrPend([key])) throw cleanupPending(); throw unavailable(); }
      if (nowValue >= record.expiresAt) { if (!await removeOrPend([key])) throw cleanupPending(); throw unavailable(); }
      if (!await removeOrPend([key])) throw cleanupPending(); return record.rawUrl;
    }); },
    invalidateInternal({ ownerId, navigationToken }) { return serial(async () => {
      const { key } = await readLegacy(ownerId, navigationToken); if (!await removeOrPend([key])) throw cleanupPending(); return freeze({ invalidated: true });
    }); },
    put(rawUrl, options) { return serial(async () => {
      const input = exact(options, ['auditId', 'purpose', 'ttlMs', 'includeQuery']);
      if (!input || !validId(input.auditId) || !PURPOSES.has(input.purpose) || input.ttlMs !== ttlFor(input.purpose) ||
        typeof input.includeQuery !== 'boolean' || !digestManager) throw new TypeError('RAW_NAVIGATION_INVALID');
      let canonical; let evidenceUrl;
      try { canonical = canonicalNavigationUrl(rawUrl); evidenceUrl = sanitizeEvidenceUrlV1(canonical, { includeQuery: input.includeQuery }); }
      catch { throw new TypeError('RAW_NAVIGATION_INVALID'); }
      const issuedAt = currentTime(now, state); if (issuedAt === null || issuedAt > Number.MAX_SAFE_INTEGER - input.ttlMs) throw new TypeError('RAW_NAVIGATION_INVALID');
      let sessionDigest; try { sessionDigest = await digestManager.digest(canonical); } catch { throw consumed(); }
      if (!validDigest(sessionDigest)) throw consumed();
      const navigationToken = token(randomBytes(16)); const expiresAt = issuedAt + input.ttlMs; const key = `${PREFIX}${navigationToken}`;
      const record = freeze({ version: 'RawNavigationUrlV1', auditId: input.auditId, purpose: input.purpose, rawUrl: canonical, issuedAt, expiresAt });
      const confirmedWrite = async () => {
        try { return same(publicRecord((await sessionArea.get(key))?.[key]), record); } catch { return false; }
      };
      let writeAttempted = false;
      try {
        if (Object.hasOwn(await sessionArea.get(key), key)) throw consumed();
        writeAttempted = true;
        await sessionArea.set({ [key]: record });
        if (!await confirmedWrite()) throw consumed();
      } catch (error) {
        if (writeAttempted && await confirmedWrite()) {
          state.bindings.set(navigationToken, freeze({ evidenceUrl, sessionDigest }));
          return freeze({ navigationToken, evidenceUrl, sessionDigest, expiresAt });
        }
        if (writeAttempted && !await removeOrPend([key])) throw cleanupPending();
        if (error?.message === consumed().message) throw error;
        throw consumed();
      }
      state.bindings.set(navigationToken, freeze({ evidenceUrl, sessionDigest }));
      return freeze({ navigationToken, evidenceUrl, sessionDigest, expiresAt });
    }); },
    take(navigationToken, options) { return serial(async () => {
      const input = exact(options, ['auditId', 'purpose']); if (!input || !validId(input.auditId) || !PURPOSES.has(input.purpose)) throw consumed();
      const { key, record } = await readPublic(navigationToken);
      if (record.auditId !== input.auditId) throw wrongAudit(); if (record.purpose !== input.purpose) throw wrongPurpose();
      const nowValue = currentTime(now, state); if (nowValue === null || nowValue < record.issuedAt) { if (!await removeOrPend([key])) throw cleanupPending(); throw consumed(); }
      if (nowValue >= record.expiresAt) { if (!await removeOrPend([key])) throw cleanupPending(); throw consumed(); }
      if (!await removeOrPend([key])) throw cleanupPending(); return record.rawUrl;
    }); },
    putQueue(input) { return serial(async () => {
      const request = exact(input, ['auditId', 'entries']);
      if (!request) throw new TypeError('RAW_NAVIGATION_INVALID');
      const { auditId, entries } = request;
      if (!validId(auditId)) throw new TypeError('RAW_NAVIGATION_INVALID');
      const values = dense(entries); const parsed = values?.map(parseQueueEntry);
      if (!parsed || parsed.length < 1 || parsed.length > 20 || parsed.some(entry => entry === null || entry.status !== 'pending') ||
        new Set(parsed.map(entry => entry.line)).size !== parsed.length || new Set(parsed.map(entry => entry.navigationToken)).size !== parsed.length) throw new TypeError('RAW_NAVIGATION_INVALID');
      const nowValue = currentTime(now, state); if (nowValue === null) throw new TypeError('RAW_NAVIGATION_INVALID');
      const sourceRecords = [];
      try {
        for (const entry of parsed) {
          const { record } = await readPublic(entry.navigationToken);
          if (record.auditId !== auditId || record.purpose !== 'batch-page' || record.expiresAt <= nowValue) throw new TypeError('RAW_NAVIGATION_INVALID');
          let expectedEvidence; let expectedDigest;
          try {
            expectedEvidence = sanitizeEvidenceUrlV1(record.rawUrl, { includeQuery: entry.evidenceUrl.queryIncluded });
            expectedDigest = await digestManager.digest(record.rawUrl);
          } catch { throw new TypeError('RAW_NAVIGATION_INVALID'); }
          const binding = state.bindings.get(entry.navigationToken);
          if (!binding || !same(binding.evidenceUrl, entry.evidenceUrl) || binding.sessionDigest !== entry.sessionDigest ||
            !same(expectedEvidence, entry.evidenceUrl) || expectedDigest !== entry.sessionDigest) throw new TypeError('RAW_NAVIGATION_INVALID');
          sourceRecords.push({ entry, record });
        }
      } catch (error) {
        dropBindings(state, parsed.map(entry => entry.navigationToken));
        throw error;
      }
      const issuedAt = Math.min(...sourceRecords.map(source => source.record.issuedAt));
      const expiresAt = Math.min(...sourceRecords.map(source => source.record.expiresAt));
      const key = `${QUEUE_PREFIX}${auditId}`;
      const queue = freeze({ version: 1, auditId, ownerOperationId: token(randomBytes(16)), revision: 1, issuedAt, expiresAt, nextIndex: 0, entries: parsed });
      const normalized = sourceRecords.map(({ entry, record }) => ({
        key: `${PREFIX}${entry.navigationToken}`,
        record: freeze({ ...record, issuedAt, expiresAt }),
      }));
      const cleanupKeys = [key, ...normalized.map(source => source.key)];
      const confirmedWrite = async () => {
        try {
          const confirmed = parseQueue((await sessionArea.get(key))?.[key]);
          if (!confirmed || !same(confirmed, queue) || !same(queueState(confirmed), queueState(queue))) return false;
          for (const source of normalized) if (!same(publicRecord((await sessionArea.get(source.key))?.[source.key]), source.record)) return false;
          return true;
        } catch { return false; }
      };
      let writeAttempted = false;
      try {
        if (Object.hasOwn(await sessionArea.get(key), key)) throw staleQueue();
        const writes = { [key]: queue };
        for (const source of normalized) writes[source.key] = source.record;
        writeAttempted = true;
        await sessionArea.set(writes);
        if (!await confirmedWrite()) throw staleQueue();
      } catch (error) {
        if (writeAttempted && await confirmedWrite()) { dropBindings(state, parsed.map(entry => entry.navigationToken)); return; }
        if (writeAttempted && !await removeOrPend(cleanupKeys)) throw cleanupPending();
        dropBindings(state, parsed.map(entry => entry.navigationToken));
        if (error?.message === staleQueue().message) throw error;
        throw staleQueue();
      }
      dropBindings(state, parsed.map(entry => entry.navigationToken));
    }); },
    readQueue(auditId) { return serial(async () => {
      const { key, queue } = await readQueue(auditId); if (!queue) return null;
      const keys = [key, ...queue.entries.map(entry => `${PREFIX}${entry.navigationToken}`)];
      const nowValue = currentTime(now, state);
      if (nowValue === null || nowValue < queue.issuedAt) {
        if (!await removeOrPend(keys)) throw cleanupPending();
        throw staleQueue();
      }
      if (nowValue >= queue.expiresAt) {
        if (!await removeOrPend(keys)) throw cleanupPending();
        return null;
      }
      let complete = true;
      for (const entry of queue.entries) {
        if (entry.status === 'finished') continue;
        let record;
        try { record = publicRecord((await sessionArea.get(`${PREFIX}${entry.navigationToken}`))?.[`${PREFIX}${entry.navigationToken}`]); } catch { complete = false; break; }
        if (!record || record.auditId !== queue.auditId || record.purpose !== 'batch-page' ||
          record.issuedAt !== queue.issuedAt || record.expiresAt !== queue.expiresAt) { complete = false; break; }
      }
      if (!complete) {
        if (!await removeOrPend(keys)) throw cleanupPending();
        throw staleQueue();
      }
      return freeze(structuredClone(queue));
    }); },
    replaceQueue(auditId, value, options) { return serial(async () => {
      const expected = exact(options, ['expectedRevision', 'expectedState']); const expectedState = expected && parseExpectedState(expected.expectedState); const desired = parseQueue(value);
      if (!validId(auditId) || !expected || !expectedState || !Number.isSafeInteger(expected.expectedRevision) || expected.expectedRevision < 1 || !desired || desired.auditId !== auditId) throw staleQueue();
      const { key, queue: current } = await readQueue(auditId);
      if (!current || current.revision !== expected.expectedRevision || !same(queueState(current), expectedState) || desired.ownerOperationId !== current.ownerOperationId ||
        current.nextIndex >= current.entries.length || desired.revision !== current.revision + 1 || desired.issuedAt !== current.issuedAt || desired.expiresAt !== current.expiresAt || !validTransition(current, desired)) throw staleQueue();
      const nowValue = currentTime(now, state);
      if (nowValue === null || nowValue < current.issuedAt || nowValue >= current.expiresAt) {
        if (!await removeOrPend([key, ...current.entries.map(entry => `${PREFIX}${entry.navigationToken}`)])) throw cleanupPending();
        throw staleQueue();
      }
      const cleanupKeys = [key, ...current.entries.map(entry => `${PREFIX}${entry.navigationToken}`)];
      const confirmedDesired = async () => {
        try { return same(parseQueue((await sessionArea.get(key))?.[key]), desired); } catch { return false; }
      };
      const confirmedCurrent = async () => {
        try { return same(parseQueue((await sessionArea.get(key))?.[key]), current); } catch { return false; }
      };
      try {
        await sessionArea.set({ [key]: desired });
        if (!await confirmedDesired()) throw staleQueue();
      } catch (error) {
        if (await confirmedDesired()) return;
        let restored = false;
        try {
          await sessionArea.set({ [key]: current });
          restored = await confirmedCurrent();
        } catch { restored = await confirmedCurrent(); }
        if (!restored && !await removeOrPend(cleanupKeys)) throw cleanupPending();
        if (error?.message === staleQueue().message) throw error;
        throw staleQueue();
      }
    }); },
    clearAudit(auditId) { return serial(async () => {
      if (!validId(auditId)) throw new TypeError('RAW_NAVIGATION_INVALID'); let entries;
      try { entries = await all(sessionArea); } catch { throw unavailable(); }
      const keys = entries.flatMap(([key, value]) =>
        (key.startsWith(PREFIX) && recordAuditId(value) === auditId) || key === `${QUEUE_PREFIX}${auditId}` ? [key] : []);
      if (keys.length === 0) return 0;
      if (!await removeOrPend(keys)) throw cleanupPending();
      return keys.length;
    }); },
    clearExpired() { return serial(async () => {
      const nowValue = currentTime(now, state); if (nowValue === null) throw unavailable(); let entries;
      try { entries = await all(sessionArea); } catch { throw unavailable(); }
      const keys = entries.flatMap(([key, value]) => {
        const legacy = key.startsWith(PREFIX) ? exact(value, LEGACY_RECORD_KEYS) : null;
        const publicValue = key.startsWith(PREFIX) ? publicRecord(value) : null;
        const queue = key.startsWith(QUEUE_PREFIX) ? parseQueue(value) : null;
        const malformed = key.startsWith(PREFIX) && !legacy && !publicValue || key.startsWith(QUEUE_PREFIX) && !queue;
        return malformed || (legacy && validClock(legacy.expiresAt) && nowValue >= legacy.expiresAt) ||
          (publicValue && nowValue >= publicValue.expiresAt) || (queue && nowValue >= queue.expiresAt) ? [key] : [];
      });
      if (keys.length === 0) return 0;
      if (!await removeOrPend(keys)) throw cleanupPending();
      return keys.length;
    }); },
  });
}
