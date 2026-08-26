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
    async commitAudit(id, model, latestState) {
      const key = validId(id);
      const modelClone = clone(model);
      const latestClone = clone(latestState);
      initial.set(key, modelClone);
      initial.set(LATEST_KEY, latestClone);
    },
  };
}

export function createAuditStore(options = {}) {
  const factory = options.indexedDB ?? globalThis.indexedDB;
  if (!factory || typeof factory.open !== 'function') return createInMemoryAuditStore(options.fallback);
  let database = null;
  let opening = null;
  const open = async () => {
    if (database) return database;
    if (opening) return opening;
    opening = new Promise((resolve, reject) => {
      const request = factory.open(DB_NAME, 1);
      let settled = false;
      const fail = error => {
        if (settled) return;
        settled = true;
        opening = null;
        reject(error);
      };
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
      };
      request.onblocked = () => fail(new Error('A abertura do armazenamento foi bloqueada.'));
      request.onerror = () => fail(request.error || new Error('Não foi possível abrir o armazenamento de auditorias.'));
      request.onsuccess = () => {
        const db = request.result;
        if (settled) {
          db.close();
          return;
        }
        settled = true;
        database = db;
        opening = null;
        db.onversionchange = () => {
          db.close();
          if (database === db) database = null;
          opening = null;
        };
        resolve(db);
      };
    });
    return opening;
  };
  const write = async entries => {
    const db = await open();
    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (handler, value) => { if (!settled) { settled = true; handler(value); } };
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      for (const [key, value] of entries) store.put(value, key);
      transaction.oncomplete = () => finish(resolve);
      transaction.onerror = () => finish(reject, transaction.error || new Error('Não foi possível salvar a auditoria.'));
      transaction.onabort = () => finish(reject, transaction.error || new Error('A transação de auditoria foi abortada.'));
    });
  };
  const put = (key, value) => write([[key, clone(value)]]);
  const get = async key => {
    const db = await open();
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (handler, value) => { if (!settled) { settled = true; handler(value); } };
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const request = transaction.objectStore(STORE_NAME).get(key);
      request.onsuccess = () => finish(resolve, clone(request.result));
      request.onerror = () => finish(reject, request.error || new Error('Não foi possível ler a auditoria.'));
      transaction.onerror = () => finish(reject, transaction.error || new Error('Não foi possível ler a auditoria.'));
      transaction.onabort = () => finish(reject, transaction.error || new Error('A leitura da auditoria foi abortada.'));
    });
  };
  return {
    setAudit(id, model) { return put(validId(id), model); },
    getAudit(id) { return get(validId(id)); },
    setLatest(state) { return put(LATEST_KEY, state); },
    getLatest() { return get(LATEST_KEY); },
    commitAudit(id, model, latestState) {
      const key = validId(id);
      const modelClone = clone(model);
      const latestClone = clone(latestState);
      return write([[key, modelClone], [LATEST_KEY, latestClone]]);
    },
  };
}
