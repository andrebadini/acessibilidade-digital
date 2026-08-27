const DB_NAME = 'audita-mt';
const STORE_NAME = 'audits';
const LATEST_KEY = '__latest__';
const REVISION_KEY_PREFIX = '__audit_revision__:';
const AUDIT_SNAPSHOT_CAPABILITIES = new WeakMap();

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function validId(id) {
  if (typeof id !== 'string' || !id.trim()) throw new TypeError('Identificador de auditoria inválido.');
  const value = id.trim();
  if (value === LATEST_KEY || value.startsWith(REVISION_KEY_PREFIX)) {
    throw new TypeError('Identificador de auditoria reservado ou inválido.');
  }
  return value;
}

function storedRevision(value) {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Revisão armazenada da auditoria inválida.');
  return value;
}

function revisionKey(id) {
  return `${REVISION_KEY_PREFIX}${id}`;
}

function mintAuditSnapshot(owner, auditId, model, revision) {
  const canonicalRevision = storedRevision(revision);
  if (model === undefined) return { model: undefined, revision: canonicalRevision, capability: null };
  const privateModel = clone(model);
  const capability = Object.freeze(Object.create(null));
  AUDIT_SNAPSHOT_CAPABILITIES.set(capability, Object.freeze({
    owner,
    auditId,
    revision: canonicalRevision,
    model: privateModel,
  }));
  return { model: clone(privateModel), revision: canonicalRevision, capability };
}

function capabilityRevision(capability, owner, auditId) {
  const record = (typeof capability === 'object' && capability !== null)
    ? AUDIT_SNAPSHOT_CAPABILITIES.get(capability)
    : null;
  if (!record || record.owner !== owner || record.auditId !== auditId) {
    throw new TypeError('Capacidade de snapshot da auditoria inválida.');
  }
  return record.revision;
}

/** Returns an owned clone only for a capability minted by a local audit store. */
export function inspectAuditSnapshotCapability(capability) {
  const record = (typeof capability === 'object' && capability !== null)
    ? AUDIT_SNAPSHOT_CAPABILITIES.get(capability)
    : null;
  return record ? { auditId: record.auditId, revision: record.revision, model: clone(record.model) } : null;
}

export class AuditRevisionConflictError extends Error {
  constructor() {
    super('A auditoria foi atualizada durante a exportação; a versão mais nova foi preservada.');
    this.name = 'AuditRevisionConflictError';
    this.code = 'AUDIT_REVISION_CONFLICT';
  }
}

export function isAuditRevisionConflict(error) {
  return error instanceof AuditRevisionConflictError || error?.code === 'AUDIT_REVISION_CONFLICT';
}

export function createInMemoryAuditStore(initial = new Map()) {
  const owner = Object.freeze(Object.create(null));
  const snapshot = id => {
    const key = validId(id);
    return mintAuditSnapshot(owner, key, initial.get(key), initial.get(revisionKey(key)));
  };
  const writeAudit = (id, model, latestState, snapshotCapability) => {
    const key = validId(id);
    const modelClone = clone(model);
    const latestClone = latestState === undefined ? undefined : clone(latestState);
    const currentRevision = storedRevision(initial.get(revisionKey(key)));
    const expectedRevision = snapshotCapability === undefined
      ? undefined
      : capabilityRevision(snapshotCapability, owner, key);
    if (expectedRevision !== undefined && (!initial.has(key) || currentRevision !== expectedRevision)) {
      throw new AuditRevisionConflictError();
    }
    const revision = currentRevision + 1;
    initial.set(key, modelClone);
    initial.set(revisionKey(key), revision);
    if (latestState !== undefined) initial.set(LATEST_KEY, latestClone);
    return { revision, capability: mintAuditSnapshot(owner, key, modelClone, revision).capability };
  };
  return {
    async setAudit(id, model) { return writeAudit(id, model); },
    async getAudit(id) { return snapshot(id).model; },
    async getAuditSnapshot(id) { return snapshot(id); },
    async setLatest(state) { initial.set(LATEST_KEY, clone(state)); },
    async getLatest() { return clone(initial.get(LATEST_KEY)); },
    async commitAudit(id, model, latestState) {
      return writeAudit(id, model, latestState);
    },
    async commitAuditIfRevision(id, model, latestState, snapshotCapability) {
      return writeAudit(id, model, latestState, snapshotCapability);
    },
  };
}

export function createAuditStore(options = {}) {
  const factory = options.indexedDB ?? globalThis.indexedDB;
  if (!factory || typeof factory.open !== 'function') return createInMemoryAuditStore(options.fallback);
  let database = null;
  let opening = null;
  const owner = Object.freeze(Object.create(null));
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
  const readKeys = async keys => {
    const db = await open();
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (handler, value) => { if (!settled) { settled = true; handler(value); } };
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const values = new Map();
      for (const key of keys) {
        const request = store.get(key);
        request.onsuccess = () => values.set(key, clone(request.result));
        request.onerror = () => finish(reject, request.error || new Error('Não foi possível ler a auditoria.'));
      }
      transaction.oncomplete = () => finish(resolve, values);
      transaction.onerror = () => finish(reject, transaction.error || new Error('Não foi possível ler a auditoria.'));
      transaction.onabort = () => finish(reject, transaction.error || new Error('A leitura da auditoria foi abortada.'));
    });
  };
  const get = async key => (await readKeys([key])).get(key);
  const getAuditSnapshot = async id => {
    const key = validId(id);
    const values = await readKeys([key, revisionKey(key)]);
    return mintAuditSnapshot(owner, key, values.get(key), values.get(revisionKey(key)));
  };
  const mutateAudit = async (id, model, latestState, snapshotCapability) => {
    const key = validId(id);
    const expected = snapshotCapability === undefined
      ? undefined
      : capabilityRevision(snapshotCapability, owner, key);
    const modelClone = clone(model);
    const latestClone = latestState === undefined ? undefined : clone(latestState);
    const db = await open();
    return new Promise((resolve, reject) => {
      let settled = false;
      let currentModelRead = false;
      let revisionRead = false;
      let currentModel;
      let currentRevisionValue;
      let nextRevision = null;
      let conflict = false;
      const finish = (handler, value) => { if (!settled) { settled = true; handler(value); } };
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const currentRequest = store.get(key);
      const revisionRequest = store.get(revisionKey(key));
      const apply = () => {
        if (!currentModelRead || !revisionRead || nextRevision !== null || conflict) return;
        let currentRevision;
        try { currentRevision = storedRevision(currentRevisionValue); } catch (error) {
          finish(reject, error);
          return;
        }
        if (expected !== undefined && (currentModel === undefined || currentRevision !== expected)) {
          conflict = true;
          return;
        }
        nextRevision = currentRevision + 1;
        store.put(modelClone, key);
        store.put(nextRevision, revisionKey(key));
        if (latestState !== undefined) store.put(latestClone, LATEST_KEY);
      };
      currentRequest.onsuccess = () => {
        currentModelRead = true;
        currentModel = currentRequest.result;
        apply();
      };
      revisionRequest.onsuccess = () => {
        revisionRead = true;
        currentRevisionValue = revisionRequest.result;
        apply();
      };
      currentRequest.onerror = () => finish(reject, currentRequest.error || new Error('Não foi possível ler a auditoria atual.'));
      revisionRequest.onerror = () => finish(reject, revisionRequest.error || new Error('Não foi possível ler a revisão da auditoria.'));
      transaction.oncomplete = () => {
        if (conflict) finish(reject, new AuditRevisionConflictError());
        else if (nextRevision === null) finish(reject, new Error('A atualização da auditoria não foi concluída.'));
        else finish(resolve, {
          revision: nextRevision,
          capability: mintAuditSnapshot(owner, key, modelClone, nextRevision).capability,
        });
      };
      transaction.onerror = () => finish(reject, transaction.error || new Error('Não foi possível salvar a auditoria.'));
      transaction.onabort = () => finish(reject, transaction.error || new Error('A transação de auditoria foi abortada.'));
    });
  };
  return {
    setAudit(id, model) { return mutateAudit(id, model); },
    getAudit(id) { return get(validId(id)); },
    getAuditSnapshot,
    setLatest(state) { return put(LATEST_KEY, state); },
    getLatest() { return get(LATEST_KEY); },
    commitAudit(id, model, latestState) {
      return mutateAudit(id, model, latestState);
    },
    commitAuditIfRevision(id, model, latestState, snapshotCapability) {
      return mutateAudit(id, model, latestState, snapshotCapability);
    },
  };
}
