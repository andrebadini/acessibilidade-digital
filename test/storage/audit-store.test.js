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

test('in-memory snapshots carry a monotonic revision and compare-and-swap never overwrites a newer model', async () => {
  const store = createInMemoryAuditStore();
  await store.setAudit('audit-cas', { auditId: 'audit-cas', revisionMarker: 'initial' });
  const snapshot = await store.getAuditSnapshot('audit-cas');
  assert.equal(snapshot.revision, 1);

  await store.setAudit('audit-cas', { auditId: 'audit-cas', revisionMarker: 'human-review' });
  await assert.rejects(
    store.commitAuditIfRevision(
      'audit-cas',
      { auditId: 'audit-cas', revisionMarker: 'stale-export' },
      { auditId: 'audit-cas', exportStatus: 'complete' },
      snapshot.capability,
    ),
    error => error?.code === 'AUDIT_REVISION_CONFLICT',
  );

  assert.equal((await store.getAudit('audit-cas')).revisionMarker, 'human-review');
  assert.equal((await store.getAuditSnapshot('audit-cas')).revision, 2);
});

test('only one concurrent compare-and-swap can commit the same expected revision', async () => {
  const store = createInMemoryAuditStore();
  await store.setAudit('audit-race', { auditId: 'audit-race', winner: null });
  const { revision, capability } = await store.getAuditSnapshot('audit-race');

  const outcomes = await Promise.allSettled([
    store.commitAuditIfRevision('audit-race', { auditId: 'audit-race', winner: 'first' }, { auditId: 'audit-race' }, capability),
    store.commitAuditIfRevision('audit-race', { auditId: 'audit-race', winner: 'second' }, { auditId: 'audit-race' }, capability),
  ]);

  assert.equal(outcomes.filter(entry => entry.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter(entry => entry.status === 'rejected' && entry.reason?.code === 'AUDIT_REVISION_CONFLICT').length, 1);
  assert.ok(['first', 'second'].includes((await store.getAudit('audit-race')).winner));
  assert.equal((await store.getAuditSnapshot('audit-race')).revision, revision + 1);
});

test('in-memory revisions survive store recreation over the same fallback backing map', async () => {
  const backing = new Map();
  const first = createInMemoryAuditStore(backing);
  const recreated = createInMemoryAuditStore(backing);
  await first.setAudit('audit-retained', { auditId: 'audit-retained', marker: 'initial' });
  const snapshot = await recreated.getAuditSnapshot('audit-retained');
  assert.equal(snapshot.revision, 1);

  await first.setAudit('audit-retained', { auditId: 'audit-retained', marker: 'human-review' });
  await assert.rejects(
    recreated.commitAuditIfRevision(
      'audit-retained',
      { auditId: 'audit-retained', marker: 'stale-export' },
      { auditId: 'audit-retained', exportStatus: 'complete' },
      snapshot.capability,
    ),
    error => error?.code === 'AUDIT_REVISION_CONFLICT',
  );
  assert.equal((await recreated.getAudit('audit-retained')).marker, 'human-review');
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

test('IndexedDB compare-and-swap checks and updates the revision in the same readwrite transaction', async () => {
  const fake = createFakeIndexedDb();
  const store = createAuditStore({ indexedDB: fake });
  await store.setAudit('audit-idb-cas', { auditId: 'audit-idb-cas', marker: 'initial' });
  const snapshot = await store.getAuditSnapshot('audit-idb-cas');
  await store.commitAuditIfRevision(
    'audit-idb-cas',
    { auditId: 'audit-idb-cas', marker: 'exported' },
    { auditId: 'audit-idb-cas', exportStatus: 'complete' },
    snapshot.capability,
  );

  await assert.rejects(
    store.commitAuditIfRevision(
      'audit-idb-cas',
      { auditId: 'audit-idb-cas', marker: 'stale' },
      { auditId: 'audit-idb-cas', exportStatus: 'failed' },
      snapshot.capability,
    ),
    error => error?.code === 'AUDIT_REVISION_CONFLICT',
  );
  assert.equal((await store.getAudit('audit-idb-cas')).marker, 'exported');
  assert.equal((await store.getAuditSnapshot('audit-idb-cas')).revision, snapshot.revision + 1);
});

test('two IndexedDB store connections cannot both commit capabilities for the same revision', async () => {
  const fake = createFakeIndexedDb();
  const first = createAuditStore({ indexedDB: fake });
  const second = createAuditStore({ indexedDB: fake });
  await first.setAudit('audit-idb-race', { auditId: 'audit-idb-race', winner: null });
  const [firstSnapshot, secondSnapshot] = await Promise.all([
    first.getAuditSnapshot('audit-idb-race'),
    second.getAuditSnapshot('audit-idb-race'),
  ]);
  assert.equal(firstSnapshot.revision, secondSnapshot.revision);

  const outcomes = await Promise.allSettled([
    first.commitAuditIfRevision(
      'audit-idb-race',
      { auditId: 'audit-idb-race', winner: 'first' },
      { auditId: 'audit-idb-race', exportStatus: 'complete' },
      firstSnapshot.capability,
    ),
    second.commitAuditIfRevision(
      'audit-idb-race',
      { auditId: 'audit-idb-race', winner: 'second' },
      { auditId: 'audit-idb-race', exportStatus: 'complete' },
      secondSnapshot.capability,
    ),
  ]);

  assert.equal(outcomes.filter(entry => entry.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter(entry => entry.status === 'rejected' && entry.reason?.code === 'AUDIT_REVISION_CONFLICT').length, 1);
  assert.ok(['first', 'second'].includes((await first.getAudit('audit-idb-race')).winner));
});

test('compare-and-swap accepts only a capability minted by the same store and audit snapshot', async () => {
  const store = createInMemoryAuditStore();
  const other = createInMemoryAuditStore();
  await store.setAudit('audit-capability', { auditId: 'audit-capability', marker: 'current' });
  await other.setAudit('audit-capability', { auditId: 'audit-capability', marker: 'other' });
  const snapshot = await store.getAuditSnapshot('audit-capability');
  const otherSnapshot = await other.getAuditSnapshot('audit-capability');

  for (const forged of [snapshot.revision, {}, otherSnapshot.capability]) {
    await assert.rejects(
      store.commitAuditIfRevision(
        'audit-capability',
        { auditId: 'audit-capability', marker: 'forged' },
        { auditId: 'audit-capability', exportStatus: 'failed' },
        forged,
      ),
      /capacidade|snapshot|inválid/iu,
    );
  }
  assert.equal((await store.getAudit('audit-capability')).marker, 'current');
  assert.equal((await store.getAuditSnapshot('audit-capability')).revision, snapshot.revision);
});

test('a successful CAS returns the next store-owned capability for finalization', async () => {
  const store = createInMemoryAuditStore();
  await store.setAudit('audit-reserve', { auditId: 'audit-reserve', phase: 'prepared' });
  const prepared = await store.getAuditSnapshot('audit-reserve');
  const reserved = await store.commitAuditIfRevision(
    'audit-reserve',
    { auditId: 'audit-reserve', phase: 'reserved' },
    { auditId: 'audit-reserve', exportStatus: 'delivering' },
    prepared.capability,
  );

  assert.equal(reserved.revision, prepared.revision + 1);
  assert.ok(reserved.capability);
  await assert.rejects(
    store.commitAuditIfRevision(
      'audit-reserve',
      { auditId: 'audit-reserve', phase: 'stale' },
      {},
      prepared.capability,
    ),
    error => error?.code === 'AUDIT_REVISION_CONFLICT',
  );
  await store.commitAuditIfRevision(
    'audit-reserve',
    { auditId: 'audit-reserve', phase: 'final' },
    { auditId: 'audit-reserve', exportStatus: 'complete' },
    reserved.capability,
  );
  assert.equal((await store.getAudit('audit-reserve')).phase, 'final');
});

test('audit identifiers cannot collide with private latest or revision records', async () => {
  const store = createInMemoryAuditStore();
  for (const auditId of ['__latest__', '__audit_revision__:audit-1']) {
    await assert.rejects(store.setAudit(auditId, { auditId }), /identificador|reservad|inválid/iu);
    await assert.rejects(store.getAuditSnapshot(auditId), /identificador|reservad|inválid/iu);
  }
  assert.equal(await store.getLatest(), undefined);
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
            queueMicrotask(() => queueMicrotask(() => transaction.oncomplete?.()));
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
