const PREFIX = 'audita:blob-url:v1:';
const CLOSED_PREFIX = 'audita:blob-url-closed:v1:';
const ID = /^[A-Za-z0-9._:-]{1,160}$/u;
const BLOB_URL = /^blob:chrome-extension:\/\/[a-p]{32}\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const ENTRY_KEYS = Object.freeze(['auditId', 'blobUrl', 'ownerDocumentId']);
const RECORD_KEYS = Object.freeze(['version', ...ENTRY_KEYS]);
const SHARED_TAILS = new WeakMap();

function unavailable() { return new Error('BLOB_REGISTRY_UNAVAILABLE'); }
function validId(value) { return typeof value === 'string' && ID.test(value); }
function validAuditId(value) { try { return canonicalAuditId(value) === value; } catch { return false; } }
function keyFor(blobUrl) { return `${PREFIX}${encodeURIComponent(blobUrl)}`; }
function closedKey(auditId) { return `${CLOSED_PREFIX}${auditId}`; }

function dataObject(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return null;
    const result = {};
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== 'string' || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      Object.defineProperty(result, key, { value: descriptor.value, enumerable: true });
    }
    return result;
  } catch { return null; }
}

function exact(value, keys) {
  const result = dataObject(value);
  return result && Object.keys(result).length === keys.length && keys.every(key => Object.hasOwn(result, key)) ? result : null;
}

function entry(value) {
  const result = exact(value, ENTRY_KEYS);
  if (!result || !validAuditId(result.auditId) || !validId(result.ownerDocumentId) ||
    typeof result.blobUrl !== 'string' || !BLOB_URL.test(result.blobUrl)) return null;
  return Object.freeze(result);
}

function record(value) {
  const result = exact(value, RECORD_KEYS);
  if (!result || result.version !== 1 || !entry({ auditId: result.auditId, blobUrl: result.blobUrl, ownerDocumentId: result.ownerDocumentId })) return null;
  return Object.freeze(result);
}

function sameRecord(left, right) {
  const actual = record(left);
  return Boolean(actual && RECORD_KEYS.every(key => actual[key] === right[key]));
}

function sameClosed(value, auditId) {
  const result = exact(value, ['version', 'auditId']);
  return Boolean(result && result.version === 1 && result.auditId === auditId);
}

function serialize(area, operation) {
  const current = (SHARED_TAILS.get(area) ?? Promise.resolve()).then(operation);
  const tail = current.catch(() => {});
  SHARED_TAILS.set(area, tail);
  void tail.then(() => { if (SHARED_TAILS.get(area) === tail) SHARED_TAILS.delete(area); });
  return current.catch(() => { throw unavailable(); });
}

export function createBlobUrlRegistryV1(raw) {
  const input = exact(raw, ['sessionArea', 'revokeInOwner', 'isOwnerAlive']);
  if (!input || !input.sessionArea || ['get', 'set', 'remove'].some(method => typeof input.sessionArea[method] !== 'function') ||
    typeof input.revokeInOwner !== 'function' || typeof input.isOwnerAlive !== 'function') throw unavailable();
  const { sessionArea, revokeInOwner, isOwnerAlive } = input;

  async function read(key) {
    const envelope = dataObject(await sessionArea.get(key));
    if (!envelope || Object.keys(envelope).some(name => name !== key)) throw unavailable();
    return envelope[key];
  }

  async function writeConfirmed(key, value, matches) {
    try { await sessionArea.set({ [key]: value }); } catch {}
    if (!matches(await read(key))) throw unavailable();
  }

  async function requireRecord(key, expected) {
    if (!sameRecord(await read(key), expected)) throw unavailable();
  }

  async function removeConfirmed(key, expected) {
    await requireRecord(key, expected);
    try { await sessionArea.remove(key); } catch {}
    if (await read(key) !== undefined) throw unavailable();
  }

  async function clean(key, expected) {
    await requireRecord(key, expected);
    const alive = await isOwnerAlive(Object.freeze({ ownerDocumentId: expected.ownerDocumentId }));
    await requireRecord(key, expected);
    if (alive === true) {
      const acknowledgement = await revokeInOwner(entry({ auditId: expected.auditId, blobUrl: expected.blobUrl,
        ownerDocumentId: expected.ownerDocumentId }));
      if (acknowledgement !== true) throw unavailable();
    } else if (alive !== false) throw unavailable();
    await removeConfirmed(key, expected);
  }

  async function register(rawEntry) {
    const captured = entry(rawEntry);
    if (!captured) throw unavailable();
    return serialize(sessionArea, async () => {
      // A successful deletion remains closed for this browser session, including late producers.
      if (await read(closedKey(captured.auditId)) !== undefined) throw unavailable();
      const key = keyFor(captured.blobUrl);
      const expected = Object.freeze({ version: 1, ...captured });
      const current = await read(key);
      if (current !== undefined) {
        if (!sameRecord(current, expected)) throw unavailable();
        return;
      }
      await writeConfirmed(key, expected, value => sameRecord(value, expected));
    });
  }

  async function release(rawEntry) {
    const captured = entry(rawEntry);
    if (!captured) throw unavailable();
    return serialize(sessionArea, async () => {
      const key = keyFor(captured.blobUrl);
      const current = await read(key);
      if (current === undefined) return;
      const expected = Object.freeze({ version: 1, ...captured });
      if (!sameRecord(current, expected)) throw unavailable();
      // The owner callback must acknowledge native revocation, not call release recursively.
      await clean(key, expected);
    });
  }

  async function clearAudit(auditId) {
    if (!validAuditId(auditId)) throw unavailable();
    return serialize(sessionArea, async () => {
      const retiredKey = closedKey(auditId);
      const retired = await read(retiredKey);
      if (retired === undefined) {
        await writeConfirmed(retiredKey, Object.freeze({ version: 1, auditId }), value => sameClosed(value, auditId));
      } else if (!sameClosed(retired, auditId)) throw unavailable();
      const inventory = dataObject(await sessionArea.get(null));
      if (!inventory) throw unavailable();
      let removed = 0;
      let pending = false;
      for (const [key, candidate] of Object.entries(inventory)) {
        if (!key.startsWith(PREFIX)) continue;
        const captured = dataObject(candidate);
        if (captured?.auditId !== auditId) continue;
        const expected = record(captured);
        if (!expected || key !== keyFor(expected.blobUrl)) { pending = true; continue; }
        try { await clean(key, expected); removed += 1; } catch { pending = true; }
      }
      if (pending) throw unavailable();
      return removed;
    });
  }

  return Object.freeze({ register, release, clearAudit });
}
import { canonicalAuditId } from '../storage/audit-retention.js';
