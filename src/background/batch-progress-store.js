import { sanitizeEvidenceUrlV1 } from '../core/privacy/evidence-url.js';
import { createAuditModel } from '../core/report/audit-model.js';
import { canonicalStringify } from '../core/report/canonical-json.js';
import { validateExecutionCheckpoint } from './execution-checkpoint.js';
import { copyBatchPageFailure } from './batch-page-failure.js';

const DEFAULT_DATABASE_NAME = 'audita-batch-progress-v1';
const STORE_NAME = 'batch-progress-v1';
const DATABASE_VERSION = 1;
const AUDIT_ID = /^[A-Za-z0-9._:-]{1,160}$/u;
const PAGE_ID = /^page-([1-9]|1[0-9]|20)$/u;
const FACTORY_KEYS = Object.freeze(['indexedDB']);
const NAMED_FACTORY_KEYS = Object.freeze(['indexedDB', 'databaseName']);
const WRITE_KEYS = Object.freeze([
  'auditId', 'pageId', 'childAuditId', 'model', 'checkpoint', 'expectedCompletedCount',
]);
const FAILURE_WRITE_KEYS = Object.freeze([...WRITE_KEYS, 'failure']);
const COMPLETE_KEYS = Object.freeze(['auditId', 'pageId', 'expectedRevision']);
const AUDIT_KEYS = Object.freeze(['auditId']);
const RECORD_KEYS = Object.freeze(['version', 'auditId', 'revision', 'pages']);
const PAGE_KEYS = Object.freeze(['pageId', 'childAuditId', 'state', 'model', 'checkpoint']);
const FAILURE_PAGE_KEYS = Object.freeze([...PAGE_KEYS, 'failure']);

function denied(code) {
  return new Error(code);
}

function freeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freeze(child, seen);
  return Object.freeze(value);
}

function exact(value, keys) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
    const own = Reflect.ownKeys(value);
    if (own.length !== keys.length || own.some(key => typeof key !== 'string' || !keys.includes(key))) return null;
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
    const expected = ['length', ...Array.from({ length: value.length }, (_entry, index) => String(index))];
    if (own.length !== expected.length || expected.some(key => !own.includes(key))) return null;
    return Array.from({ length: value.length }, (_entry, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new TypeError();
      return descriptor.value;
    });
  } catch { return null; }
}

function validAuditId(value) {
  return typeof value === 'string' && AUDIT_ID.test(value);
}

function pageNumber(value) {
  const match = typeof value === 'string' ? PAGE_ID.exec(value) : null;
  return match ? Number(match[1]) : 0;
}

function publicUrl(value) {
  try {
    return typeof value === 'string' &&
      sanitizeEvidenceUrlV1(value, { includeQuery: false }).href === value;
  } catch { return false; }
}

function canonicalPayload(raw, expected) {
  try {
    const checkpoint = validateExecutionCheckpoint({
      auditId: expected.childAuditId,
      checkpoint: raw.checkpoint,
      pageOrder: ['page-1'],
    });
    if (raw.model === null) {
      const failure = copyBatchPageFailure(raw.failure, checkpoint.pages[0]);
      return failure ? freeze({ model: null, failure, checkpoint: structuredClone(checkpoint) }) : null;
    }
    if (raw.failure !== undefined && raw.failure !== null) return null;
    const model = createAuditModel(raw.model);
    const modelPage = model.pages[0];
    const checkpointPage = checkpoint.pages[0];
    if (model.auditId !== expected.childAuditId || model.requestedScope?.mode !== 'single' ||
      model.pages.length !== 1 || modelPage?.pageId !== 'page-1' ||
      model.requestedScope.urls.length !== 1 ||
      ![model.requestedUrl, model.finalUrl, model.requestedScope.urls[0],
        modelPage.requestedUrl, modelPage.finalUrl].every(publicUrl) ||
      checkpointPage.attempted !== modelPage.attempted ||
      checkpointPage.rulesVersion !== model.versions.rules ||
      (checkpointPage.attempted && checkpointPage.startedAt !== modelPage.timestamps.startedAt)) return null;
    return freeze({ model: structuredClone(model), failure: null, checkpoint: structuredClone(checkpoint) });
  } catch { return null; }
}

function canonicalPage(raw, auditId, index) {
  const page = exact(raw, FAILURE_PAGE_KEYS) ?? exact(raw, PAGE_KEYS);
  const expectedPageId = `page-${index + 1}`;
  const expectedChildAuditId = `${auditId}:${expectedPageId}`;
  const payload = page && canonicalPayload(page, { childAuditId: expectedChildAuditId });
  if (!page || page.pageId !== expectedPageId || page.childAuditId !== expectedChildAuditId ||
    !['draft', 'completed'].includes(page.state) || !payload) return null;
  return freeze({
    pageId: page.pageId,
    childAuditId: page.childAuditId,
    state: page.state,
    model: payload.model,
    failure: payload.failure,
    checkpoint: payload.checkpoint,
  });
}

function canonicalRecord(raw, expectedAuditId) {
  const record = exact(raw, RECORD_KEYS);
  const values = record && dense(record.pages);
  if (!record || record.version !== 1 || record.auditId !== expectedAuditId ||
    !validAuditId(record.auditId) || !Number.isSafeInteger(record.revision) || record.revision < 1 ||
    !values || values.length < 1 || values.length > 20) return null;
  const pages = values.map((value, index) => canonicalPage(value, record.auditId, index));
  if (pages.some(page => page === null)) return null;
  const draftIndex = pages.findIndex(page => page.state === 'draft');
  if (draftIndex !== -1 && draftIndex !== pages.length - 1) return null;
  const expectedRevision = pages.length * 2 - (draftIndex === -1 ? 0 : 1);
  if (record.revision !== expectedRevision) return null;
  return freeze({ version: 1, auditId: record.auditId, revision: record.revision, pages });
}

function same(left, right) {
  try { return canonicalStringify(left) === canonicalStringify(right); }
  catch { return false; }
}

function cloneForStorage(value) {
  try { return structuredClone(value); }
  catch { throw denied('BATCH_PROGRESS_UNAVAILABLE'); }
}

export function createBatchProgressStoreV1(rawOptions) {
  const options = exact(rawOptions, NAMED_FACTORY_KEYS) ?? exact(rawOptions, FACTORY_KEYS);
  const databaseName = options && Object.hasOwn(options, 'databaseName')
    ? options.databaseName
    : DEFAULT_DATABASE_NAME;
  if (!options || typeof options.indexedDB?.open !== 'function' ||
    typeof databaseName !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/u.test(databaseName)) {
    throw new TypeError('BATCH_PROGRESS_STORE_INVALID');
  }

  let database = null;
  let opening = null;

  async function open() {
    if (database) return database;
    if (opening) return opening;
    opening = new Promise((resolve, reject) => {
      let request;
      let settled = false;
      const fail = () => {
        if (settled) return;
        settled = true;
        opening = null;
        reject(denied('BATCH_PROGRESS_UNAVAILABLE'));
      };
      try { request = options.indexedDB.open(databaseName, DATABASE_VERSION); }
      catch { fail(); return; }
      request.onupgradeneeded = () => {
        try {
          const db = request.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
        } catch {
          try { request.transaction?.abort(); } catch {}
        }
      };
      request.onblocked = fail;
      request.onerror = fail;
      request.onsuccess = () => {
        if (settled) {
          try { request.result?.close(); } catch {}
          return;
        }
        settled = true;
        database = request.result;
        opening = null;
        database.onversionchange = () => {
          try { database?.close(); } catch {}
          database = null;
          opening = null;
        };
        resolve(database);
      };
    });
    return opening;
  }

  async function readRaw(auditId) {
    const db = await open();
    return new Promise((resolve, reject) => {
      let settled = false;
      let value;
      const finish = (handler, result) => {
        if (settled) return;
        settled = true;
        handler(result);
      };
      let transaction;
      let request;
      try {
        transaction = db.transaction(STORE_NAME, 'readonly');
        request = transaction.objectStore(STORE_NAME).get(auditId);
      } catch { finish(reject, denied('BATCH_PROGRESS_UNAVAILABLE')); return; }
      request.onsuccess = () => {
        try { value = request.result === undefined ? undefined : cloneForStorage(request.result); }
        catch (error) { finish(reject, error); }
      };
      request.onerror = () => finish(reject, denied('BATCH_PROGRESS_UNAVAILABLE'));
      transaction.oncomplete = () => finish(resolve, value);
      transaction.onerror = () => finish(reject, denied('BATCH_PROGRESS_UNAVAILABLE'));
      transaction.onabort = () => finish(reject, denied('BATCH_PROGRESS_UNAVAILABLE'));
    });
  }

  async function mutate(auditId, denialCode, transition) {
    const db = await open();
    let desired = null;
    let logicalError = null;
    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (handler, value) => {
        if (settled) return;
        settled = true;
        handler(value);
      };
      let transaction;
      let store;
      let request;
      try {
        transaction = db.transaction(STORE_NAME, 'readwrite');
        store = transaction.objectStore(STORE_NAME);
        request = store.get(auditId);
      } catch { finish(reject, denied('BATCH_PROGRESS_UNAVAILABLE')); return; }
      request.onsuccess = () => {
        try {
          const current = request.result === undefined ? null : canonicalRecord(request.result, auditId);
          if (request.result !== undefined && !current) throw denied(denialCode);
          desired = transition(current);
          if (!desired) throw denied(denialCode);
          const put = store.put(cloneForStorage(desired), auditId);
          put.onerror = () => finish(reject, denied('BATCH_PROGRESS_UNAVAILABLE'));
        } catch (error) {
          logicalError = error?.message === denialCode ? error : denied(denialCode);
        }
      };
      request.onerror = () => finish(reject, denied('BATCH_PROGRESS_UNAVAILABLE'));
      transaction.oncomplete = () => logicalError
        ? finish(reject, logicalError)
        : finish(resolve);
      transaction.onerror = () => finish(reject, denied('BATCH_PROGRESS_UNAVAILABLE'));
      transaction.onabort = () => finish(reject, denied('BATCH_PROGRESS_UNAVAILABLE'));
    });
    const confirmed = canonicalRecord(await readRaw(auditId), auditId);
    if (!confirmed || !same(confirmed, desired)) throw denied(denialCode);
    return confirmed;
  }

  async function deleteRecord(auditId, { completedOnly, denialCode }) {
    const db = await open();
    let logicalError = null;
    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (handler, value) => {
        if (settled) return;
        settled = true;
        handler(value);
      };
      let transaction;
      let store;
      let request;
      try {
        transaction = db.transaction(STORE_NAME, 'readwrite');
        store = transaction.objectStore(STORE_NAME);
        request = store.get(auditId);
      } catch { finish(reject, denied('BATCH_PROGRESS_UNAVAILABLE')); return; }
      request.onsuccess = () => {
        try {
          if (request.result === undefined) return;
          const current = canonicalRecord(request.result, auditId);
          if (!current || completedOnly && current.pages.some(page => page.state !== 'completed')) {
            throw denied(denialCode);
          }
          const deletion = store.delete(auditId);
          deletion.onerror = () => finish(reject, denied('BATCH_PROGRESS_UNAVAILABLE'));
        } catch (error) {
          logicalError = error?.message === denialCode
            ? error
            : denied(denialCode);
        }
      };
      request.onerror = () => finish(reject, denied('BATCH_PROGRESS_UNAVAILABLE'));
      transaction.oncomplete = () => logicalError
        ? finish(reject, logicalError)
        : finish(resolve);
      transaction.onerror = () => finish(reject, denied('BATCH_PROGRESS_UNAVAILABLE'));
      transaction.onabort = () => finish(reject, denied('BATCH_PROGRESS_UNAVAILABLE'));
    });
    if (await readRaw(auditId) !== undefined) throw denied(denialCode);
  }

  return Object.freeze({
    async writeDraft(raw) {
      const input = exact(raw, FAILURE_WRITE_KEYS) ?? exact(raw, WRITE_KEYS);
      const nextNumber = input && pageNumber(input.pageId);
      const payload = input && validAuditId(input.auditId) && nextNumber > 0 &&
        input.childAuditId === `${input.auditId}:${input.pageId}` &&
        Number.isSafeInteger(input.expectedCompletedCount) && input.expectedCompletedCount >= 0 &&
        input.expectedCompletedCount < 20
        ? canonicalPayload(input, { childAuditId: input.childAuditId })
        : null;
      if (!input || !payload || nextNumber !== input.expectedCompletedCount + 1) {
        throw denied('BATCH_PROGRESS_WRITE_DENIED');
      }
      const confirmed = await mutate(input.auditId, 'BATCH_PROGRESS_WRITE_DENIED', current => {
        const pages = current?.pages ?? [];
        if (pages.length !== input.expectedCompletedCount ||
          pages.some(page => page.state !== 'completed')) return null;
        const page = freeze({
          pageId: input.pageId,
          childAuditId: input.childAuditId,
          state: 'draft',
          model: payload.model,
          failure: payload.failure,
          checkpoint: payload.checkpoint,
        });
        return freeze({
          version: 1,
          auditId: input.auditId,
          revision: (current?.revision ?? 0) + 1,
          pages: freeze([...pages, page]),
        });
      });
      return freeze({
        version: 1,
        auditId: confirmed.auditId,
        revision: confirmed.revision,
        page: confirmed.pages.at(-1),
      });
    },

    async markCompleted(raw) {
      const input = exact(raw, COMPLETE_KEYS);
      if (!input || !validAuditId(input.auditId) || pageNumber(input.pageId) === 0 ||
        !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
        throw denied('BATCH_PROGRESS_COMPLETE_DENIED');
      }
      const confirmed = await mutate(input.auditId, 'BATCH_PROGRESS_COMPLETE_DENIED', current => {
        const currentPage = current?.pages.at(-1);
        if (!current || current.revision !== input.expectedRevision ||
          currentPage?.pageId !== input.pageId || currentPage.state !== 'draft') return null;
        const pages = current.pages.map((page, index) => index === current.pages.length - 1
          ? freeze({ ...page, state: 'completed' })
          : page);
        return freeze({ ...current, revision: current.revision + 1, pages: freeze(pages) });
      });
      return freeze({
        version: 1,
        auditId: confirmed.auditId,
        revision: confirmed.revision,
        page: confirmed.pages.at(-1),
      });
    },

    async readCompleted(raw) {
      const input = exact(raw, AUDIT_KEYS);
      if (!input || !validAuditId(input.auditId)) throw denied('BATCH_PROGRESS_READ_DENIED');
      let stored;
      try { stored = await readRaw(input.auditId); }
      catch (error) {
        if (error?.message === 'BATCH_PROGRESS_UNAVAILABLE') throw error;
        throw denied('BATCH_PROGRESS_READ_DENIED');
      }
      if (stored === undefined) return null;
      const record = canonicalRecord(stored, input.auditId);
      if (!record) throw denied('BATCH_PROGRESS_READ_DENIED');
      return freeze({
        version: 1,
        auditId: record.auditId,
        revision: record.revision,
        pages: freeze(record.pages.filter(page => page.state === 'completed')),
      });
    },

    async clearAudit(raw) {
      const input = exact(raw, AUDIT_KEYS);
      if (!input || !validAuditId(input.auditId)) throw denied('BATCH_PROGRESS_CLEAR_DENIED');
      await deleteRecord(input.auditId, { completedOnly: true, denialCode: 'BATCH_PROGRESS_CLEAR_DENIED' });
      return freeze({ auditId: input.auditId, cleared: true });
    },

    async discardAudit(raw) {
      const input = exact(raw, AUDIT_KEYS);
      if (!input || !validAuditId(input.auditId)) throw denied('BATCH_PROGRESS_DISCARD_DENIED');
      await deleteRecord(input.auditId, { completedOnly: false, denialCode: 'BATCH_PROGRESS_DISCARD_DENIED' });
      return freeze({ auditId: input.auditId, discarded: true });
    },
  });
}
