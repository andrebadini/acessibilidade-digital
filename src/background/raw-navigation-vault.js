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

function token(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 16) throw new TypeError('RAW_NAVIGATION_INVALID');
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

function currentTime(now) {
  let value;
  try { value = now(); } catch { return null; }
  if (validClock(value)) return value;
  if (typeof value !== 'string') return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value ? parsed.getTime() : null;
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
  if (!entry || !Number.isSafeInteger(entry.line) || entry.line < 1 || !validToken(entry.navigationToken) ||
    !isEvidenceUrlV1(entry.evidenceUrl) || !validDigest(entry.sessionDigest) || !QUEUE_STATUSES.has(entry.status)) return null;
  return freeze(entry);
}

function parseQueue(value) {
  const queue = exact(value, QUEUE_KEYS);
  if (!queue || queue.version !== 1 || !validId(queue.auditId) || !validToken(queue.ownerOperationId) ||
    !Number.isSafeInteger(queue.revision) || queue.revision < 1 || !validClock(queue.issuedAt) ||
    !validClock(queue.expiresAt) || queue.expiresAt - queue.issuedAt !== BATCH_TTL_MS ||
    !Number.isSafeInteger(queue.nextIndex) || queue.nextIndex < 0) return null;
  const entries = dense(queue.entries);
  if (!entries || queue.nextIndex > entries.length) return null;
  const parsed = entries.map(parseQueueEntry);
  if (parsed.some(entry => entry === null) || new Set(parsed.map(entry => entry.line)).size !== parsed.length) return null;
  return freeze({ ...queue, entries: parsed });
}

function queueState(queue) { return freeze({ nextIndex: queue.nextIndex, status: queue.entries[queue.nextIndex]?.status ?? 'finished' }); }
function parseExpectedState(value) {
  const state = exact(value, ['nextIndex', 'status']);
  return state && Number.isSafeInteger(state.nextIndex) && state.nextIndex >= 0 && QUEUE_STATUSES.has(state.status) ? freeze(state) : null;
}

async function erase(sessionArea, key) {
  try { await sessionArea.remove(key); return !Object.hasOwn(await sessionArea.get(key), key); } catch { return false; }
}

async function all(sessionArea) {
  const value = await sessionArea.get(null);
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export function createRawNavigationVaultV1({ sessionArea, digestManager = null, now, randomBytes }) {
  if (!sessionArea || typeof sessionArea.get !== 'function' || typeof sessionArea.set !== 'function' ||
    typeof sessionArea.remove !== 'function' || typeof now !== 'function' || typeof randomBytes !== 'function' ||
    (digestManager !== null && typeof digestManager?.digest !== 'function')) throw new TypeError('RAW_NAVIGATION_INVALID');
  let tail = Promise.resolve();
  const serial = operation => { const pending = tail.then(operation, operation); tail = pending.catch(() => {}); return pending; };
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
      const issuedAt = currentTime(now); if (issuedAt === null || issuedAt > Number.MAX_SAFE_INTEGER - LEGACY_TTL_MS) throw new TypeError('RAW_NAVIGATION_INVALID');
      const navigationToken = token(randomBytes(16)); const expiresAt = issuedAt + LEGACY_TTL_MS; const key = `${PREFIX}${navigationToken}`;
      try {
        if (Object.hasOwn(await sessionArea.get(key), key)) throw unavailable();
        await sessionArea.set({ [key]: { version: 1, navigationToken, ownerId, rawUrl, issuedAt, expiresAt, state: 'prepared' } });
        const confirmed = exact((await sessionArea.get(key))?.[key], LEGACY_RECORD_KEYS);
        if (!confirmed || !same(confirmed, { version: 1, navigationToken, ownerId, rawUrl, issuedAt, expiresAt, state: 'prepared' })) throw unavailable();
      } catch { throw unavailable(); }
      return freeze({ navigationToken, expiresAt });
    }); },
    takeInternal({ ownerId, navigationToken }) { return serial(async () => {
      const { key, record } = await readLegacy(ownerId, navigationToken); const nowValue = currentTime(now);
      if (nowValue === null) throw unavailable();
      if (nowValue >= record.expiresAt) { await erase(sessionArea, key); throw unavailable(); }
      if (!await erase(sessionArea, key)) throw unavailable(); return record.rawUrl;
    }); },
    invalidateInternal({ ownerId, navigationToken }) { return serial(async () => {
      const { key } = await readLegacy(ownerId, navigationToken); if (!await erase(sessionArea, key)) throw unavailable(); return freeze({ invalidated: true });
    }); },
    put(rawUrl, options) { return serial(async () => {
      const input = exact(options, ['auditId', 'purpose', 'ttlMs', 'includeQuery']);
      if (!input || !validId(input.auditId) || !PURPOSES.has(input.purpose) || input.ttlMs !== ttlFor(input.purpose) ||
        typeof input.includeQuery !== 'boolean' || !digestManager) throw new TypeError('RAW_NAVIGATION_INVALID');
      let canonical; let evidenceUrl;
      try { canonical = canonicalNavigationUrl(rawUrl); evidenceUrl = sanitizeEvidenceUrlV1(canonical, { includeQuery: input.includeQuery }); }
      catch { throw new TypeError('RAW_NAVIGATION_INVALID'); }
      const issuedAt = currentTime(now); if (issuedAt === null || issuedAt > Number.MAX_SAFE_INTEGER - input.ttlMs) throw new TypeError('RAW_NAVIGATION_INVALID');
      let sessionDigest; try { sessionDigest = await digestManager.digest(canonical); } catch { throw consumed(); }
      if (!validDigest(sessionDigest)) throw consumed();
      const navigationToken = token(randomBytes(16)); const expiresAt = issuedAt + input.ttlMs; const key = `${PREFIX}${navigationToken}`;
      const record = freeze({ version: 'RawNavigationUrlV1', auditId: input.auditId, purpose: input.purpose, rawUrl: canonical, issuedAt, expiresAt });
      try {
        if (Object.hasOwn(await sessionArea.get(key), key)) throw consumed();
        await sessionArea.set({ [key]: record });
        if (!same(publicRecord((await sessionArea.get(key))?.[key]), record)) throw consumed();
      } catch (error) { if (error?.message === consumed().message) throw error; throw consumed(); }
      return freeze({ navigationToken, evidenceUrl, sessionDigest, expiresAt });
    }); },
    take(navigationToken, options) { return serial(async () => {
      const input = exact(options, ['auditId', 'purpose']); if (!input || !validId(input.auditId) || !PURPOSES.has(input.purpose)) throw consumed();
      const { key, record } = await readPublic(navigationToken);
      if (record.auditId !== input.auditId) throw wrongAudit(); if (record.purpose !== input.purpose) throw wrongPurpose();
      const nowValue = currentTime(now); if (nowValue === null) throw consumed();
      if (nowValue >= record.expiresAt) { await erase(sessionArea, key); throw consumed(); }
      if (!await erase(sessionArea, key)) throw consumed(); return record.rawUrl;
    }); },
    putQueue({ auditId, entries }) { return serial(async () => {
      if (!validId(auditId)) throw new TypeError('RAW_NAVIGATION_INVALID');
      const values = dense(entries); const parsed = values?.map(parseQueueEntry);
      if (!parsed || parsed.some(entry => entry === null) || new Set(parsed.map(entry => entry.line)).size !== parsed.length ||
        new Set(parsed.map(entry => entry.navigationToken)).size !== parsed.length) throw new TypeError('RAW_NAVIGATION_INVALID');
      const nowValue = currentTime(now); if (nowValue === null) throw new TypeError('RAW_NAVIGATION_INVALID');
      const sourceRecords = [];
      for (const entry of parsed) {
        const { record } = await readPublic(entry.navigationToken);
        if (record.auditId !== auditId || record.purpose !== 'batch-page' || record.expiresAt <= nowValue) throw new TypeError('RAW_NAVIGATION_INVALID');
        sourceRecords.push({ entry, record });
      }
      const issuedAt = Math.min(...sourceRecords.map(source => source.record.issuedAt));
      const expiresAt = Math.min(...sourceRecords.map(source => source.record.expiresAt));
      const key = `${QUEUE_PREFIX}${auditId}`;
      const queue = freeze({ version: 1, auditId, ownerOperationId: token(randomBytes(16)), revision: 1, issuedAt, expiresAt, nextIndex: 0, entries: parsed });
      try {
        if (Object.hasOwn(await sessionArea.get(key), key)) throw staleQueue();
        const writes = { [key]: queue };
        const normalized = sourceRecords.map(({ entry, record }) => ({
          key: `${PREFIX}${entry.navigationToken}`,
          record: freeze({ ...record, issuedAt, expiresAt }),
        }));
        for (const source of normalized) writes[source.key] = source.record;
        await sessionArea.set(writes);
        const confirmed = parseQueue((await sessionArea.get(key))?.[key]);
        if (!confirmed || !same(confirmed, queue) || !same(queueState(confirmed), queueState(queue))) throw staleQueue();
        for (const source of normalized) if (!same(publicRecord((await sessionArea.get(source.key))?.[source.key]), source.record)) throw staleQueue();
      } catch (error) { if (error?.message === staleQueue().message) throw error; throw staleQueue(); }
    }); },
    readQueue(auditId) { return serial(async () => {
      const { key, queue } = await readQueue(auditId); if (!queue) return null;
      const nowValue = currentTime(now); if (nowValue === null) throw staleQueue();
      if (nowValue >= queue.expiresAt) { if (!await erase(sessionArea, key)) throw staleQueue(); return null; }
      return freeze(structuredClone(queue));
    }); },
    replaceQueue(auditId, value, options) { return serial(async () => {
      const expected = exact(options, ['expectedRevision', 'expectedState']); const expectedState = expected && parseExpectedState(expected.expectedState); const desired = parseQueue(value);
      if (!validId(auditId) || !expected || !expectedState || !Number.isSafeInteger(expected.expectedRevision) || expected.expectedRevision < 1 || !desired || desired.auditId !== auditId) throw staleQueue();
      const { key, queue: current } = await readQueue(auditId);
      if (!current || current.revision !== expected.expectedRevision || !same(queueState(current), expectedState) || desired.ownerOperationId !== current.ownerOperationId ||
        desired.revision !== current.revision + 1 || desired.issuedAt !== current.issuedAt || desired.expiresAt !== current.expiresAt) throw staleQueue();
      const nowValue = currentTime(now); if (nowValue === null || nowValue >= current.expiresAt) throw staleQueue();
      try {
        await sessionArea.set({ [key]: desired }); const confirmed = parseQueue((await sessionArea.get(key))?.[key]);
        if (!confirmed || confirmed.revision !== desired.revision || confirmed.ownerOperationId !== desired.ownerOperationId || !same(queueState(confirmed), queueState(desired)) || !same(confirmed, desired)) throw staleQueue();
      } catch (error) { if (error?.message === staleQueue().message) throw error; throw staleQueue(); }
    }); },
    clearAudit(auditId) { return serial(async () => {
      if (!validId(auditId)) throw new TypeError('RAW_NAVIGATION_INVALID'); let entries;
      try { entries = await all(sessionArea); } catch { throw unavailable(); }
      const keys = Object.entries(entries).flatMap(([key, value]) =>
        (key.startsWith(PREFIX) && publicRecord(value)?.auditId === auditId) || (key === `${QUEUE_PREFIX}${auditId}` && parseQueue(value)?.auditId === auditId) ? [key] : []);
      if (keys.length === 0) return 0;
      try { await sessionArea.remove(keys); const confirmed = await all(sessionArea); if (keys.some(key => Object.hasOwn(confirmed, key))) throw unavailable(); }
      catch { throw unavailable(); }
      return keys.length;
    }); },
    clearExpired() { return serial(async () => {
      const nowValue = currentTime(now); if (nowValue === null) throw unavailable(); let entries;
      try { entries = await all(sessionArea); } catch { throw unavailable(); }
      const keys = Object.entries(entries).flatMap(([key, value]) => {
        const legacy = key.startsWith(PREFIX) ? exact(value, LEGACY_RECORD_KEYS) : null;
        const publicValue = key.startsWith(PREFIX) ? publicRecord(value) : null;
        const queue = key.startsWith(QUEUE_PREFIX) ? parseQueue(value) : null;
        return (legacy && validClock(legacy.expiresAt) && nowValue >= legacy.expiresAt) || (publicValue && nowValue >= publicValue.expiresAt) || (queue && nowValue >= queue.expiresAt) ? [key] : [];
      });
      if (keys.length === 0) return 0;
      try { await sessionArea.remove(keys); const confirmed = await all(sessionArea); if (keys.some(key => Object.hasOwn(confirmed, key))) throw unavailable(); }
      catch { throw unavailable(); }
      return keys.length;
    }); },
  });
}
