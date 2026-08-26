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

function createFakeIndexedDb() {
  const records = new Map();
  const fake = {
    createdStores: [],
    open() {
      const request = {};
      queueMicrotask(() => {
        const db = {
          objectStoreNames: { contains: name => fake.createdStores.includes(name) },
          createObjectStore(name) { fake.createdStores.push(name); },
          transaction() {
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
        request.result = db;
        request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  };
  return fake;
}
