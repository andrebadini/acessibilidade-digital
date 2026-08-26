import assert from 'node:assert/strict';
import test from 'node:test';

import { createAuditStore, createInMemoryAuditStore } from '../../src/storage/audit-store.js';

test('in-memory audit storage round-trips models and latest panel state without aliasing', async () => {
  const store = createInMemoryAuditStore();
  const model = { auditId: 'audit-1', payload: 'x'.repeat(1024 * 1024) };
  await store.setAudit('audit-1', model);
  model.payload = 'mutated';
  assert.equal((await store.getAudit('audit-1')).payload.length, 1024 * 1024);
  await store.setLatest({ auditId: 'audit-1', status: 'complete', percent: 100 });
  assert.deepEqual(await store.getLatest(), { auditId: 'audit-1', status: 'complete', percent: 100 });
});

test('in-memory commitAudit clones both values before atomically changing state', async () => {
  const store = createInMemoryAuditStore();
  await store.commitAudit('audit-1', { auditId: 'audit-1', version: 1 }, { auditId: 'audit-1', status: 'partial' });
  await assert.rejects(store.commitAudit('audit-1', { auditId: 'audit-1', version: 2 }, { invalid: () => {} }), /clone|cloned|function/i);
  assert.deepEqual(await store.getAudit('audit-1'), { auditId: 'audit-1', version: 1 });
  assert.deepEqual(await store.getLatest(), { auditId: 'audit-1', status: 'partial' });
});

test('IndexedDB audit storage uses a dedicated object store and persists a large model', async () => {
  const fake = createFakeIndexedDb();
  const store = createAuditStore({ indexedDB: fake });
  const value = { auditId: 'audit-large', image: `data:image/png;base64,${'A'.repeat(2_000_000)}` };
  await store.setAudit('audit-large', value);
  assert.deepEqual(await store.getAudit('audit-large'), value);
  await store.setLatest({ auditId: 'audit-large', status: 'partial' });
  assert.deepEqual(await store.getLatest(), { auditId: 'audit-large', status: 'partial' });
  assert.equal(fake.createdStores.includes('audits'), true);
});

test('IndexedDB commitAudit writes model and latest in one transaction', async () => {
  const fake = createFakeIndexedDb();
  const store = createAuditStore({ indexedDB: fake });
  await store.commitAudit('audit-atomic', { auditId: 'audit-atomic', bytes: 'model' }, { auditId: 'audit-atomic', status: 'complete' });
  assert.equal(fake.transactionModes.filter(mode => mode === 'readwrite').length, 1);
  assert.deepEqual(await store.getAudit('audit-atomic'), { auditId: 'audit-atomic', bytes: 'model' });
  assert.deepEqual(await store.getLatest(), { auditId: 'audit-atomic', status: 'complete' });
});

test('caches the open promise, rejects blocked opens, and reopens after versionchange', async () => {
  const fake = createFakeIndexedDb();
  const store = createAuditStore({ indexedDB: fake });
  await Promise.all([store.getLatest(), store.getLatest()]);
  assert.equal(fake.openCalls, 1);
  fake.database.onversionchange();
  assert.equal(fake.database.closed, true);
  await store.getLatest();
  assert.equal(fake.openCalls, 2);

  const blocked = createFakeIndexedDb({ blocked: true });
  await assert.rejects(createAuditStore({ indexedDB: blocked }).getLatest(), /bloquead|blocked/i);
});

function createFakeIndexedDb(options = {}) {
  const records = new Map();
  const fake = {
    createdStores: [],
    transactionModes: [],
    openCalls: 0,
    database: null,
    open() {
      fake.openCalls += 1;
      const request = {};
      queueMicrotask(() => {
        if (options.blocked) { request.onblocked?.(); return; }
        const db = {
          closed: false,
          close() { this.closed = true; },
          objectStoreNames: { contains: name => fake.createdStores.includes(name) },
          createObjectStore(name) { fake.createdStores.push(name); },
          transaction(_store, mode) {
            fake.transactionModes.push(mode);
            const transaction = {
              objectStore() {
                return {
                  put(value, key) { records.set(key, structuredClone(value)); },
                  get(key) {
                    const result = {};
                    queueMicrotask(() => { result.result = structuredClone(records.get(key)); result.onsuccess?.(); });
                    return result;
                  },
                };
              },
            };
            queueMicrotask(() => transaction.oncomplete?.());
            return transaction;
          },
        };
        fake.database = db;
        request.result = db;
        request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  };
  return fake;
}
