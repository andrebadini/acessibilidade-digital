// Oferta de recolocação dos sinais: a aba recarregou depois da auditoria e o endereço é o mesmo.
//
// A oferta NÃO é autorização. Ela é só a memória de que uma tentativa feita por gesto do usuário
// encontrou "mesmo endereço, documento novo" e que a segunda confirmação explícita pode acontecer —
// nas duas confirmações seguintes (a do painel e a do worker) o documento vivo é provado de novo.
// Guarda apenas o que já vive no cache de origem (aba, janela, documento, digest de sessão), com
// expiração curta, e nunca é consumida: repetir a tentativa é sempre possível enquanto valer.
const AUDIT_ID = /^[A-Za-z0-9._:-]{1,200}$/u;
const DOCUMENT_ID = /^[A-Za-z0-9._:-]{1,240}$/u;
const DIGEST = /^hmac-sha256:[A-Za-z0-9_-]{43}$/u;
const SCOPES = new Set(['page-markers', 'highlight']);
const CAPACITY = 64;
export const PAGE_RELOCATION_OFFER_TTL_MS = 300_000;

function ownData(value, key) {
  try {
    const descriptor = value && typeof value === 'object' ? Reflect.getOwnPropertyDescriptor(value, key) : null;
    return descriptor?.enumerable && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  } catch { return undefined; }
}

function exactData(value, fields) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Reflect.getPrototypeOf(value))) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== fields.length || fields.some(field => !keys.includes(field)) ||
      keys.some(key => typeof key !== 'string' || !fields.includes(key))) return null;
    const copy = Object.create(null);
    for (const field of fields) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, field);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      copy[field] = descriptor.value;
    }
    return copy;
  } catch { return null; }
}

// Os cinco campos de identidade, já copiados como dados próprios: é o que `accept` e `read`
// recebem do chamador, e o subconjunto que `register` aproveita do registro completo.
function identityOf(record) {
  if (!record || !AUDIT_ID.test(record.auditId ?? '') || !DOCUMENT_ID.test(record.documentId ?? '') ||
    !Number.isSafeInteger(record.tabId) || record.tabId <= 0 ||
    !Number.isSafeInteger(record.windowId) || record.windowId < 0 || !SCOPES.has(record.scope)) return null;
  return record;
}

function identity(raw) {
  return identityOf(exactData(raw, ['auditId', 'tabId', 'windowId', 'documentId', 'scope']));
}

const keyOf = record => [record.auditId, record.tabId, record.windowId, record.scope].join('\u0000');

export function createPageRelocationOfferStore({ now, ttlMs = PAGE_RELOCATION_OFFER_TTL_MS, capacity = CAPACITY } = {}) {
  if (typeof now !== 'function' || !Number.isSafeInteger(ttlMs) || ttlMs < 1 ||
    !Number.isSafeInteger(capacity) || capacity < 1) throw new TypeError('PAGE_RELOCATION_OFFER_INVALID');
  let lastNow = null;
  function readNow() {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0 || (lastNow !== null && value < lastNow)) {
      throw new TypeError('PAGE_RELOCATION_OFFER_INVALID');
    }
    lastNow = value;
    return value;
  }

  const offers = new Map();

  function prune(at) {
    for (const [key, offer] of offers) if (offer.expiresAt <= at) offers.delete(key);
  }

  function register(raw) {
    const record = exactData(raw, ['auditId', 'tabId', 'windowId', 'documentId', 'urlSessionDigest', 'scope', 'expiresAt']);
    const base = record && identityOf({
      auditId: ownData(record, 'auditId'), tabId: ownData(record, 'tabId'), windowId: ownData(record, 'windowId'),
      documentId: ownData(record, 'documentId'), scope: ownData(record, 'scope'),
    });
    if (!record || !base || !DIGEST.test(record.urlSessionDigest ?? '') ||
      !Number.isSafeInteger(record.expiresAt)) return false;
    let at;
    try { at = readNow(); } catch { return false; }
    const expiresAt = Math.min(record.expiresAt, at + ttlMs, at + PAGE_RELOCATION_OFFER_TTL_MS);
    if (expiresAt <= at) return false;
    prune(at);
    const key = keyOf(base);
    if (!offers.has(key) && offers.size >= capacity) {
      const oldest = [...offers.entries()].reduce((best, entry) => entry[1].createdAt < best[1].createdAt ? entry : best);
      offers.delete(oldest[0]);
    }
    offers.set(key, Object.freeze({ ...base, urlSessionDigest: record.urlSessionDigest, createdAt: at, expiresAt }));
    return true;
  }

  // Aceita só quando o documento vivo é exatamente aquele que a oferta registrou: se a aba
  // recarregou de novo no meio do caminho, a oferta não serve mais e uma nova tentativa é exigida.
  function accept(raw) {
    const record = identity(raw);
    if (!record) return false;
    let at;
    try { at = readNow(); } catch { return false; }
    const offer = offers.get(keyOf(record));
    return Boolean(offer) && offer.expiresAt > at && offer.documentId === record.documentId;
  }

  function clearAudit(auditId) {
    let changed = false;
    for (const [key, offer] of offers) {
      if (offer.auditId === auditId) { offers.delete(key); changed = true; }
    }
    return changed;
  }

  function clearTab(tabId) {
    let changed = false;
    for (const [key, offer] of offers) {
      if (offer.tabId === tabId) { offers.delete(key); changed = true; }
    }
    return changed;
  }

  function read(raw) {
    const record = identity(raw);
    if (!record) return null;
    let at;
    try { at = readNow(); } catch { return null; }
    const offer = offers.get(keyOf(record));
    return offer && offer.expiresAt > at ? offer : null;
  }

  return Object.freeze({ register, accept, read, clearAudit, clearTab, size: () => offers.size });
}
