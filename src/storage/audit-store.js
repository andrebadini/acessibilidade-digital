const DB_NAME = 'audita-mt';
const STORE_NAME = 'audits';
const LATEST_KEY = '__latest__';

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function validId(id) {
  if (typeof id !== 'string' || !id.trim()) throw new TypeError('Identificador de auditoria inválido.');
  return id.trim();
}

export function createInMemoryAuditStore(initial = new Map()) {
  return {
    async setAudit(id, model) { initial.set(validId(id), clone(model)); },
    async getAudit(id) { return clone(initial.get(validId(id))); },
    async setLatest(state) { initial.set(LATEST_KEY, clone(state)); },
    async getLatest() { return clone(initial.get(LATEST_KEY)); },
  };
}

export function createAuditStore(options = {}) {
  const factory = options.indexedDB ?? globalThis.indexedDB;
  if (!factory || typeof factory.open !== 'function') return createInMemoryAuditStore(options.fallback);
  let database;
  const open = async () => {
    if (database) return database;
    database = await new Promise((resolve, reject) => {
      const request = factory.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Não foi possível abrir o armazenamento de auditorias.'));
    });
    return database;
  };
  const put = async (key, value) => {
    const db = await open();
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).put(clone(value), key);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error('Não foi possível salvar a auditoria.'));
      transaction.onabort = transaction.onerror;
    });
  };
  const get = async key => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const request = transaction.objectStore(STORE_NAME).get(key);
      request.onsuccess = () => resolve(clone(request.result));
      request.onerror = () => reject(request.error || new Error('Não foi possível ler a auditoria.'));
    });
  };
  return {
    setAudit(id, model) { return put(validId(id), model); },
    getAudit(id) { return get(validId(id)); },
    setLatest(state) { return put(LATEST_KEY, state); },
    getLatest() { return get(LATEST_KEY); },
  };
}
