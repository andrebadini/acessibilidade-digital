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

test('audit identifiers cannot collide with private latest, revision, lease, attempt or delivery records', async () => {
  const store = createInMemoryAuditStore();
  for (const auditId of [
    '__latest__',
    '__audit_revision__:audit-1',
    '__audit_export_lease__:audit-1',
    '__audit_export_attempt__:audit-1',
    '__audit_export_delivery__:audit-1',
  ]) {
    await assert.rejects(store.setAudit(auditId, { auditId }), /identificador|reservad|inválid/iu);
    await assert.rejects(store.getAuditSnapshot(auditId), /identificador|reservad|inválid/iu);
  }
  assert.equal(await store.getLatest(), undefined);
});

test('export attempts remain monotonic per audit when another audit becomes latest', async () => {
  for (const store of [
    createInMemoryAuditStore(),
    createAuditStore({ indexedDB: createFakeIndexedDb() }),
  ]) {
    await store.setAudit('audit-attempt-a', { auditId: 'audit-attempt-a', generation: 1 });
    let snapshotA = await store.getAuditSnapshot('audit-attempt-a');
    const firstA = await store.acquireExportLease('audit-attempt-a', snapshotA.capability, {
      ownerId: 'owner-attempt-a1', now: '2026-08-27T10:00:00.000Z',
      latestState: { auditId: 'audit-attempt-a', exportStatus: 'queued', exportRevision: snapshotA.revision },
    });
    assert.equal(firstA.exportAttempt, 1);
    await store.setAudit('audit-attempt-a', { auditId: 'audit-attempt-a', generation: 2 });

    await store.setAudit('audit-attempt-b', { auditId: 'audit-attempt-b' });
    const snapshotB = await store.getAuditSnapshot('audit-attempt-b');
    const firstB = await store.acquireExportLease('audit-attempt-b', snapshotB.capability, {
      ownerId: 'owner-attempt-b1', now: '2026-08-27T10:00:00.100Z',
      latestState: { auditId: 'audit-attempt-b', exportStatus: 'queued', exportRevision: snapshotB.revision },
    });
    assert.equal(firstB.exportAttempt, 1);

    snapshotA = await store.getAuditSnapshot('audit-attempt-a');
    const secondA = await store.acquireExportLease('audit-attempt-a', snapshotA.capability, {
      ownerId: 'owner-attempt-a2', now: '2026-08-27T10:00:00.200Z',
      latestState: { auditId: 'audit-attempt-a', exportStatus: 'queued', exportRevision: snapshotA.revision },
    });
    assert.equal(secondA.exportAttempt, 2);
  }
});

test('a persistent export lease lets only one in-memory store instance own physical delivery', async () => {
  const backing = new Map();
  const first = createInMemoryAuditStore(backing);
  const second = createInMemoryAuditStore(backing);
  await first.setAudit('audit-lease-race', { auditId: 'audit-lease-race', phase: 'reviewed' });
  const [firstSnapshot, secondSnapshot] = await Promise.all([
    first.getAuditSnapshot('audit-lease-race'),
    second.getAuditSnapshot('audit-lease-race'),
  ]);

  const outcomes = await Promise.all([
    first.acquireExportLease('audit-lease-race', firstSnapshot.capability, {
      ownerId: 'owner-first', now: '2026-08-27T10:00:00.000Z',
      latestState: { auditId: 'audit-lease-race', exportStatus: 'queued', exportRevision: firstSnapshot.revision },
    }),
    second.acquireExportLease('audit-lease-race', secondSnapshot.capability, {
      ownerId: 'owner-second', now: '2026-08-27T10:00:00.000Z',
      latestState: { auditId: 'audit-lease-race', exportStatus: 'queued', exportRevision: secondSnapshot.revision },
    }),
  ]);

  assert.equal(outcomes.filter(value => value.acquired).length, 1);
  assert.equal(outcomes.filter(value => value.busy).length, 1);
  assert.equal(outcomes.find(value => value.acquired).exportAttempt, 1);
  assert.equal((await first.getAuditSnapshot('audit-lease-race')).revision, firstSnapshot.revision);
  assert.equal((await first.getLatest()).exportStatus, 'queued');
  assert.equal((await first.getLatest()).exportAttempt, 1);
});

test('an expired/crashed export lease is reclaimable and its former owner cannot reserve delivery', async () => {
  const backing = new Map();
  const first = createInMemoryAuditStore(backing);
  const second = createInMemoryAuditStore(backing);
  await first.setAudit('audit-lease-expiry', { auditId: 'audit-lease-expiry', phase: 'reviewed' });
  const firstSnapshot = await first.getAuditSnapshot('audit-lease-expiry');
  const acquired = await first.acquireExportLease('audit-lease-expiry', firstSnapshot.capability, {
    ownerId: 'owner-crashed', now: '2026-08-27T10:00:00.000Z', ttlMs: 1_000,
    latestState: { auditId: 'audit-lease-expiry', exportStatus: 'queued', exportRevision: firstSnapshot.revision },
  });
  assert.equal(acquired.acquired, true);
  assert.equal(acquired.exportAttempt, 1);
  assert.deepEqual(await first.getExportLeaseState('audit-lease-expiry', {
    now: '2026-08-27T10:00:00.500Z',
  }), {
    active: true,
    phase: 'queued',
    retryAt: '2026-08-27T10:00:01.000Z',
    revision: firstSnapshot.revision,
    exportAttempt: 1,
    ownerId: 'owner-crashed',
  });
  assert.deepEqual(await first.getExportLeaseState('audit-lease-expiry', {
    now: '2026-08-27T10:00:01.000Z',
  }), { active: false, revision: firstSnapshot.revision });

  const beforeExpiry = await second.getAuditSnapshot('audit-lease-expiry');
  assert.equal((await second.acquireExportLease('audit-lease-expiry', beforeExpiry.capability, {
    ownerId: 'owner-retry', now: '2026-08-27T10:00:00.999Z', ttlMs: 1_000,
    latestState: { auditId: 'audit-lease-expiry', exportStatus: 'queued', exportRevision: beforeExpiry.revision },
  })).busy, true);
  const reclaimed = await second.acquireExportLease('audit-lease-expiry', beforeExpiry.capability, {
    ownerId: 'owner-retry', now: '2026-08-27T10:00:01.000Z', ttlMs: 1_000,
    latestState: { auditId: 'audit-lease-expiry', exportStatus: 'queued', exportRevision: beforeExpiry.revision },
  });
  assert.equal(reclaimed.acquired, true);
  assert.equal(reclaimed.exportAttempt, 2);
  assert.equal((await second.getLatest()).exportAttempt, 2);

  await assert.rejects(
    first.commitAuditIfRevisionWithExportLease(
      'audit-lease-expiry',
      { auditId: 'audit-lease-expiry', phase: 'stale-delivery' },
      { auditId: 'audit-lease-expiry', exportStatus: 'delivering' },
      firstSnapshot.capability,
      { ownerId: 'owner-crashed', now: '2026-08-27T10:00:01.001Z', phase: 'delivering' },
    ),
    error => ['AUDIT_EXPORT_LEASE_CONFLICT', 'AUDIT_REVISION_CONFLICT'].includes(error?.code),
  );
});

test('clock rollback cannot invalidate an owned lease during claim or delivery reservation', async () => {
  for (const createStore of [
    () => createInMemoryAuditStore(),
    () => createAuditStore({ indexedDB: createFakeIndexedDb() }),
  ]) {
    const store = createStore();
    const auditId = 'audit-lease-clock-rollback';
    await store.setAudit(auditId, { auditId, phase: 'reviewed' });
    const snapshot = await store.getAuditSnapshot(auditId);
    const acquired = await store.acquireExportLease(auditId, snapshot.capability, {
      ownerId: 'owner-clock-rollback', now: '2026-08-27T12:00:00.000Z', ttlMs: 600_000,
      latestState: { auditId, exportStatus: 'queued', exportRevision: snapshot.revision },
    });
    const claimed = await store.claimExportLease(auditId, snapshot.capability, {
      ownerId: 'owner-clock-rollback', exportAttempt: acquired.exportAttempt,
      now: '2026-08-27T11:00:00.000Z', ttlMs: 120_000,
      latestState: { auditId, exportStatus: 'running', exportRevision: snapshot.revision },
    });
    assert.equal(claimed.expiresAt, '2026-08-27T12:10:00.000Z');
    assert.deepEqual(await store.getExportLeaseState(auditId, {
      now: '2026-08-27T11:00:00.001Z',
    }), {
      active: true, phase: 'running', retryAt: '2026-08-27T12:10:00.000Z',
      revision: snapshot.revision, exportAttempt: acquired.exportAttempt,
      ownerId: 'owner-clock-rollback',
    });

    const reserved = await store.commitAuditIfRevisionWithExportLease(
      auditId, { auditId, phase: 'delivering' },
      { auditId, exportStatus: 'delivering', exportRevision: snapshot.revision + 1 },
      snapshot.capability,
      {
        ownerId: 'owner-clock-rollback', exportAttempt: acquired.exportAttempt,
        now: '2026-08-27T10:00:00.000Z', ttlMs: 120_000, phase: 'delivering',
      },
    );
    assert.deepEqual(await store.getExportLeaseState(auditId, {
      now: '2026-08-27T10:00:00.001Z',
    }), {
      active: true, phase: 'delivering', retryAt: '2026-08-27T12:10:00.000Z',
      revision: reserved.revision, exportAttempt: acquired.exportAttempt,
      ownerId: 'owner-clock-rollback',
    });
  }
});

test('a persistent delivery journal survives crash and review until the next owner reconciles it', async () => {
  for (const createStore of [
    () => createInMemoryAuditStore(),
    () => createAuditStore({ indexedDB: createFakeIndexedDb() }),
  ]) {
    const store = createStore();
    const auditId = 'audit-delivery-journal';
    await store.setAudit(auditId, { auditId, phase: 'review-ready' });
    let snapshot = await store.getAuditSnapshot(auditId);
    const lease = await store.acquireExportLease(auditId, snapshot.capability, {
      ownerId: 'owner-crashed', now: '2026-08-27T10:00:00.000Z', ttlMs: 1_000,
      latestState: { auditId, exportStatus: 'queued', exportRevision: snapshot.revision },
    });
    await store.claimExportLease(auditId, snapshot.capability, {
      ownerId: 'owner-crashed', exportAttempt: lease.exportAttempt,
      now: '2026-08-27T10:00:00.100Z', ttlMs: 1_000,
      latestState: { auditId, exportStatus: 'running', exportRevision: snapshot.revision },
    });
    const reserved = await store.commitAuditIfRevisionWithExportLease(
      auditId,
      { auditId, phase: 'delivering' },
      { auditId, exportStatus: 'delivering', exportRevision: snapshot.revision + 1 },
      snapshot.capability,
      {
        ownerId: 'owner-crashed', exportAttempt: lease.exportAttempt,
        now: '2026-08-27T10:00:00.200Z', ttlMs: 1_000, phase: 'delivering',
      },
    );
    snapshot = await store.getAuditSnapshot(auditId);
    assert.equal(snapshot.revision, reserved.revision);
    await store.recordExportDelivery(auditId, snapshot.capability, {
      ownerId: 'owner-crashed', exportAttempt: lease.exportAttempt,
      now: '2026-08-27T10:00:00.300Z', format: 'html', filename: 'audit.html', state: 'starting',
    });
    await store.recordExportDelivery(auditId, snapshot.capability, {
      ownerId: 'owner-crashed', exportAttempt: lease.exportAttempt,
      now: '2026-08-27T10:00:00.400Z', format: 'html', filename: 'audit.html',
      state: 'in-flight', downloadId: 77,
    });

    const reviewed = await store.commitAuditReviewIfRevision(
      auditId, { auditId, phase: 'human-review' }, snapshot.capability,
    );
    assert.equal(reviewed.revision, snapshot.revision + 1);
    assert.equal((await store.getLatest()).exportCleanupPending, true);
    assert.deepEqual(await store.getExportDeliveryJournal(auditId), [{
      ownerId: 'owner-crashed', exportAttempt: 1, state: 'in-flight',
      format: 'html', filename: 'audit.html', downloadId: 77,
      recordedAt: '2026-08-27T10:00:00.300Z', updatedAt: '2026-08-27T10:00:00.400Z',
    }]);

    const retrySnapshot = await store.getAuditSnapshot(auditId);
    const retry = await store.acquireExportLease(auditId, retrySnapshot.capability, {
      ownerId: 'owner-retry', now: '2026-08-27T10:00:01.500Z',
      latestState: { auditId, exportStatus: 'queued', exportRevision: retrySnapshot.revision },
    });
    assert.equal(retry.acquired, true);
    assert.equal(retry.exportAttempt, 2);
    await store.resolveExportDelivery(auditId, {
      ownerId: 'owner-crashed', exportAttempt: 1, now: '2026-08-27T10:00:01.600Z',
      format: 'html', filename: 'audit.html', downloadId: 77, outcome: 'cleaned',
    });
    assert.deepEqual(await store.getExportDeliveryJournal(auditId), []);
    assert.equal((await store.getLatest()).exportCleanupPending, undefined);
  }
});

test('cleanup failure remains visible without rolling back a newer human review', async () => {
  const store = createInMemoryAuditStore();
  const auditId = 'audit-cleanup-marker';
  await store.setAudit(auditId, { auditId, phase: 'initial' });
  let snapshot = await store.getAuditSnapshot(auditId);
  const lease = await store.acquireExportLease(auditId, snapshot.capability, {
    ownerId: 'owner-export', now: '2026-08-27T10:00:00.000Z',
    latestState: { auditId, exportStatus: 'queued', exportRevision: snapshot.revision },
  });
  await store.claimExportLease(auditId, snapshot.capability, {
    ownerId: 'owner-export', exportAttempt: lease.exportAttempt, now: '2026-08-27T10:00:00.100Z',
  });
  const reserved = await store.commitAuditIfRevisionWithExportLease(
    auditId, { auditId, phase: 'delivering' }, { auditId, exportStatus: 'delivering' }, snapshot.capability,
    {
      ownerId: 'owner-export', exportAttempt: lease.exportAttempt,
      now: '2026-08-27T10:00:00.200Z', phase: 'delivering',
    },
  );
  snapshot = await store.getAuditSnapshot(auditId);
  assert.equal(snapshot.revision, reserved.revision);
  await store.recordExportDelivery(auditId, snapshot.capability, {
    ownerId: 'owner-export', exportAttempt: 1, now: '2026-08-27T10:00:00.300Z',
    format: 'pdf', filename: 'audit.pdf', state: 'in-flight', downloadId: 99,
  });
  await store.commitAuditReviewIfRevision(auditId, { auditId, phase: 'human-review' }, snapshot.capability);
  await store.resolveExportDelivery(auditId, {
    ownerId: 'owner-export', exportAttempt: 1, now: '2026-08-27T10:00:00.400Z',
    format: 'pdf', filename: 'audit.pdf', downloadId: 99, outcome: 'cleanup-failed',
  });

  assert.equal((await store.getAudit(auditId)).phase, 'human-review');
  assert.match((await store.getLatest()).exportCleanupMessage, /arquivo.*remov/u);
  assert.equal((await store.getLatest()).exportCleanupPending, true);
  assert.equal((await store.getExportDeliveryJournal(auditId))[0].state, 'cleanup-failed');
  await store.resolveExportDelivery(auditId, {
    ownerId: 'owner-export', exportAttempt: 1, now: '2026-08-27T10:00:00.500Z',
    format: 'pdf', filename: 'audit.pdf', downloadId: 99, outcome: 'cleaned',
  });
  const cleanedLatest = await store.getLatest();
  assert.equal(cleanedLatest.exportCleanupPending, undefined);
  assert.equal(cleanedLatest.exportCleanupMessage, undefined);
  assert.equal(cleanedLatest.message, 'A revisão foi atualizada; gere o relatório novamente.');
  assert.deepEqual(await store.getExportDeliveryJournal(auditId), []);
});

test('wall-clock regression cannot corrupt record or cleanup journal timestamps', async () => {
  const store = createInMemoryAuditStore();
  const auditId = 'audit-journal-clock';
  await store.setAudit(auditId, { auditId });
  let snapshot = await store.getAuditSnapshot(auditId);
  const lease = await store.acquireExportLease(auditId, snapshot.capability, {
    ownerId: 'owner-clock', now: '2026-08-27T12:00:00.000Z',
  });
  await store.claimExportLease(auditId, snapshot.capability, {
    ownerId: 'owner-clock', exportAttempt: lease.exportAttempt, now: '2026-08-27T12:00:00.100Z',
  });
  await store.commitAuditIfRevisionWithExportLease(
    auditId, { auditId }, { auditId, exportStatus: 'delivering' }, snapshot.capability,
    { ownerId: 'owner-clock', exportAttempt: 1, now: '2026-08-27T12:00:00.200Z', phase: 'delivering' },
  );
  snapshot = await store.getAuditSnapshot(auditId);
  await store.recordExportDelivery(auditId, snapshot.capability, {
    ownerId: 'owner-clock', exportAttempt: 1, now: '2026-08-27T12:00:01.000Z',
    format: 'html', filename: 'audit.html', state: 'starting',
  });
  await store.recordExportDelivery(auditId, snapshot.capability, {
    ownerId: 'owner-clock', exportAttempt: 1, now: '2026-08-27T12:00:00.500Z',
    format: 'html', filename: 'audit.html', state: 'in-flight', downloadId: 12,
  });
  assert.equal((await store.getExportDeliveryJournal(auditId))[0].updatedAt, '2026-08-27T12:00:01.000Z');
  await store.resolveExportDelivery(auditId, {
    ownerId: 'owner-clock', exportAttempt: 1, now: '2026-08-27T12:00:00.250Z',
    format: 'html', filename: 'audit.html', downloadId: 12, outcome: 'cleanup-failed',
  });
  assert.equal((await store.getExportDeliveryJournal(auditId))[0].updatedAt, '2026-08-27T12:00:01.000Z');
});

test('a malformed private journal cannot partially acquire or advance a lease', async () => {
  const backing = new Map();
  const store = createInMemoryAuditStore(backing);
  const auditId = 'audit-journal-atomic';
  const journalKey = `__audit_export_delivery__:${auditId}`;
  await store.setAudit(auditId, { auditId });
  let snapshot = await store.getAuditSnapshot(auditId);
  backing.set(journalKey, { schemaVersion: 1, auditId, entries: 'invalid' });
  await assert.rejects(store.acquireExportLease(auditId, snapshot.capability, {
    ownerId: 'owner-atomic', now: '2026-08-27T12:00:00.000Z',
  }), /journal/iu);
  assert.equal((await store.getExportLeaseState(auditId, { now: '2026-08-27T12:00:00.100Z' })).active, false);

  backing.delete(journalKey);
  const acquired = await store.acquireExportLease(auditId, snapshot.capability, {
    ownerId: 'owner-atomic', now: '2026-08-27T12:00:00.200Z',
  });
  backing.set(journalKey, { schemaVersion: 1, auditId, entries: 'invalid' });
  await assert.rejects(store.claimExportLease(auditId, snapshot.capability, {
    ownerId: 'owner-atomic', exportAttempt: acquired.exportAttempt, now: '2026-08-27T12:00:00.300Z',
  }), /journal/iu);
  assert.equal((await store.getExportLeaseState(auditId, {
    now: '2026-08-27T12:00:00.400Z',
  })).phase, 'queued');
});

test('in-memory review and journal mutations stay atomic when the stored latest state cannot be cloned', async () => {
  const backing = new Map();
  const store = createInMemoryAuditStore(backing);
  const auditId = 'audit-latest-atomic';
  await store.setAudit(auditId, { auditId, marker: 'initial' });
  let snapshot = await store.getAuditSnapshot(auditId);
  const lease = await store.acquireExportLease(auditId, snapshot.capability, {
    ownerId: 'owner-latest-atomic', now: '2026-08-27T12:30:00.000Z',
    latestState: { auditId, exportStatus: 'queued', exportRevision: snapshot.revision },
  });
  await store.claimExportLease(auditId, snapshot.capability, {
    ownerId: 'owner-latest-atomic', exportAttempt: lease.exportAttempt,
    now: '2026-08-27T12:30:00.100Z',
  });
  await store.commitAuditIfRevisionWithExportLease(
    auditId, { auditId, marker: 'delivering' },
    { auditId, exportStatus: 'delivering', exportRevision: snapshot.revision + 1 },
    snapshot.capability,
    {
      ownerId: 'owner-latest-atomic', exportAttempt: lease.exportAttempt,
      now: '2026-08-27T12:30:00.200Z', phase: 'delivering',
    },
  );
  snapshot = await store.getAuditSnapshot(auditId);
  const poisonLatest = { auditId, poison() {} };

  backing.set('__latest__', poisonLatest);
  await assert.rejects(store.recordExportDelivery(auditId, snapshot.capability, {
    ownerId: 'owner-latest-atomic', exportAttempt: lease.exportAttempt,
    now: '2026-08-27T12:30:00.300Z', format: 'html', filename: 'audit.html', state: 'starting',
  }), /clone|function/iu);
  assert.deepEqual(await store.getExportDeliveryJournal(auditId), []);

  await store.setLatest({ auditId, exportStatus: 'delivering', exportRevision: snapshot.revision });
  await store.recordExportDelivery(auditId, snapshot.capability, {
    ownerId: 'owner-latest-atomic', exportAttempt: lease.exportAttempt,
    now: '2026-08-27T12:30:00.400Z', format: 'html', filename: 'audit.html', state: 'starting',
  });
  const journalBefore = await store.getExportDeliveryJournal(auditId);
  backing.set('__latest__', poisonLatest);
  await assert.rejects(store.resolveExportDelivery(auditId, {
    ownerId: 'owner-latest-atomic', exportAttempt: lease.exportAttempt,
    now: '2026-08-27T12:30:00.500Z', format: 'html', filename: 'audit.html', outcome: 'cleanup-failed',
  }), /clone|function/iu);
  assert.deepEqual(await store.getExportDeliveryJournal(auditId), journalBefore);

  await assert.rejects(store.commitAuditReviewIfRevision(
    auditId, { auditId, marker: 'human-review' }, snapshot.capability,
  ), /clone|function/iu);
  const after = await store.getAuditSnapshot(auditId);
  assert.equal(after.revision, snapshot.revision);
  assert.equal(after.model.marker, 'delivering');
  assert.equal((await store.getExportLeaseState(auditId, {
    now: '2026-08-27T12:30:00.600Z',
  })).active, true);
});

test('successful persistence clears only its exact journal atomically with lease release', async () => {
  for (const createStore of [
    () => createInMemoryAuditStore(),
    () => createAuditStore({ indexedDB: createFakeIndexedDb() }),
  ]) {
    const store = createStore();
    const auditId = 'audit-journal-success';
    await store.setAudit(auditId, { auditId, phase: 'initial' });
    let snapshot = await store.getAuditSnapshot(auditId);
    const lease = await store.acquireExportLease(auditId, snapshot.capability, {
      ownerId: 'owner-success', now: '2026-08-27T10:00:00.000Z',
      latestState: { auditId, exportStatus: 'queued', exportRevision: snapshot.revision },
    });
    await store.claimExportLease(auditId, snapshot.capability, {
      ownerId: 'owner-success', exportAttempt: lease.exportAttempt, now: '2026-08-27T10:00:00.100Z',
    });
    await store.commitAuditIfRevisionWithExportLease(
      auditId, { auditId, phase: 'delivering' }, { auditId, exportStatus: 'delivering' }, snapshot.capability,
      {
        ownerId: 'owner-success', exportAttempt: lease.exportAttempt,
        now: '2026-08-27T10:00:00.200Z', phase: 'delivering',
      },
    );
    snapshot = await store.getAuditSnapshot(auditId);
    await store.recordExportDelivery(auditId, snapshot.capability, {
      ownerId: 'owner-success', exportAttempt: lease.exportAttempt,
      now: '2026-08-27T10:00:00.300Z', format: 'html', filename: 'audit.html',
      state: 'terminal', downloadId: 7,
    });
    await store.commitAuditIfRevisionWithExportLease(
      auditId, { auditId, phase: 'complete' }, { auditId, exportStatus: 'complete' }, snapshot.capability,
      {
        ownerId: 'owner-success', exportAttempt: lease.exportAttempt,
        now: '2026-08-27T10:00:00.400Z', release: true, clearDeliveryJournal: true,
      },
    );
    assert.deepEqual(await store.getExportDeliveryJournal(auditId), []);
    assert.equal((await store.getLatest()).exportCleanupPending, undefined);
    assert.equal((await store.getExportLeaseState(auditId, { now: '2026-08-27T10:00:00.500Z' })).active, false);
  }
});

test('an unresolved pre-ID start cannot be erased by partial success persistence', async () => {
  const store = createInMemoryAuditStore();
  const auditId = 'audit-journal-starting';
  await store.setAudit(auditId, { auditId, phase: 'initial' });
  let snapshot = await store.getAuditSnapshot(auditId);
  const lease = await store.acquireExportLease(auditId, snapshot.capability, {
    ownerId: 'owner-starting', now: '2026-08-27T10:00:00.000Z',
  });
  await store.claimExportLease(auditId, snapshot.capability, {
    ownerId: 'owner-starting', exportAttempt: lease.exportAttempt, now: '2026-08-27T10:00:00.100Z',
  });
  await store.commitAuditIfRevisionWithExportLease(
    auditId, { auditId, phase: 'delivering' }, { auditId, exportStatus: 'delivering' }, snapshot.capability,
    { ownerId: 'owner-starting', exportAttempt: 1, now: '2026-08-27T10:00:00.200Z', phase: 'delivering' },
  );
  snapshot = await store.getAuditSnapshot(auditId);
  await store.recordExportDelivery(auditId, snapshot.capability, {
    ownerId: 'owner-starting', exportAttempt: 1, now: '2026-08-27T10:00:00.300Z',
    format: 'html', filename: 'audit.html', state: 'starting',
  });
  await assert.rejects(store.commitAuditIfRevisionWithExportLease(
    auditId, { auditId, phase: 'partial' }, { auditId, exportStatus: 'partial' }, snapshot.capability,
    {
      ownerId: 'owner-starting', exportAttempt: 1, now: '2026-08-27T10:00:00.400Z',
      release: true, clearDeliveryJournal: true,
    },
  ), error => error?.code === 'AUDIT_EXPORT_LEASE_CONFLICT');
  assert.equal((await store.getExportDeliveryJournal(auditId))[0].state, 'starting');
  assert.equal((await store.getExportLeaseState(auditId, { now: '2026-08-27T10:00:00.500Z' })).active, true);
});

test('human review never waits for an export lease and wins both before and after delivery reservation', async () => {
  for (const reviewPhase of ['before-reservation', 'after-reservation']) {
    const store = createInMemoryAuditStore();
    const auditId = `audit-review-${reviewPhase}`;
    await store.setAudit(auditId, { auditId, phase: 'initial' });
    let snapshot = await store.getAuditSnapshot(auditId);
    await store.acquireExportLease(auditId, snapshot.capability, {
      ownerId: 'owner-export', now: '2026-08-27T10:00:00.000Z',
      latestState: { auditId, exportStatus: 'queued', exportRevision: snapshot.revision },
    });
    await store.claimExportLease(auditId, snapshot.capability, {
      ownerId: 'owner-export', now: '2026-08-27T10:00:00.500Z',
      latestState: { auditId, exportStatus: 'running', exportRevision: snapshot.revision },
    });
    if (reviewPhase === 'after-reservation') {
      const reserved = await store.commitAuditIfRevisionWithExportLease(
        auditId,
        { auditId, phase: 'delivering' },
        { auditId, exportStatus: 'delivering', exportRevision: snapshot.revision + 1 },
        snapshot.capability,
        { ownerId: 'owner-export', now: '2026-08-27T10:00:01.000Z', phase: 'delivering' },
      );
      snapshot = { ...reserved, model: { auditId, phase: 'delivering' } };
    }

    await store.setAudit(auditId, { auditId, phase: 'human-review' });
    await assert.rejects(
      store.commitAuditIfRevisionWithExportLease(
        auditId,
        { auditId, phase: 'stale-export-final' },
        { auditId, exportStatus: 'complete' },
        snapshot.capability,
        { ownerId: 'owner-export', now: '2026-08-27T10:00:02.000Z', release: true },
      ),
      error => ['AUDIT_EXPORT_LEASE_CONFLICT', 'AUDIT_REVISION_CONFLICT'].includes(error?.code),
    );
    assert.equal((await store.getAudit(auditId)).phase, 'human-review');
  }
});

test('success and controlled failure atomically release an owned export lease for immediate retry', async () => {
  for (const terminal of ['complete', 'failed']) {
    const store = createInMemoryAuditStore();
    const auditId = `audit-lease-${terminal}`;
    await store.setAudit(auditId, { auditId, terminal: null });
    const snapshot = await store.getAuditSnapshot(auditId);
    await store.acquireExportLease(auditId, snapshot.capability, {
      ownerId: 'owner-terminal', now: '2026-08-27T10:00:00.000Z',
      latestState: { auditId, exportStatus: 'queued', exportRevision: snapshot.revision },
    });
    await store.claimExportLease(auditId, snapshot.capability, {
      ownerId: 'owner-terminal', now: '2026-08-27T10:00:00.500Z',
      latestState: { auditId, exportStatus: 'running', exportRevision: snapshot.revision },
    });
    const terminalCommit = await store.commitAuditIfRevisionWithExportLease(
      auditId,
      { auditId, terminal },
      { auditId, exportStatus: terminal, exportRevision: snapshot.revision + 1 },
      snapshot.capability,
      { ownerId: 'owner-terminal', now: '2026-08-27T10:00:01.000Z', release: true },
    );
    const retrySnapshot = await store.getAuditSnapshot(auditId);
    const retry = await store.acquireExportLease(auditId, retrySnapshot.capability, {
      ownerId: 'owner-retry', now: '2026-08-27T10:00:01.001Z',
      latestState: { auditId, exportStatus: 'queued', exportRevision: retrySnapshot.revision },
    });
    assert.equal(terminalCommit.revision, snapshot.revision + 1);
    assert.equal(retry.acquired, true);
  }
});

test('two IndexedDB connections serialize export lease acquisition before either can deliver', async () => {
  const fake = createFakeIndexedDb();
  const first = createAuditStore({ indexedDB: fake });
  const second = createAuditStore({ indexedDB: fake });
  await first.setAudit('audit-idb-lease', { auditId: 'audit-idb-lease' });
  const [firstSnapshot, secondSnapshot] = await Promise.all([
    first.getAuditSnapshot('audit-idb-lease'), second.getAuditSnapshot('audit-idb-lease'),
  ]);
  const results = await Promise.all([
    first.acquireExportLease('audit-idb-lease', firstSnapshot.capability, {
      ownerId: 'owner-a', now: '2026-08-27T10:00:00.000Z',
      latestState: { auditId: 'audit-idb-lease', exportStatus: 'queued', exportRevision: firstSnapshot.revision },
    }),
    second.acquireExportLease('audit-idb-lease', secondSnapshot.capability, {
      ownerId: 'owner-b', now: '2026-08-27T10:00:00.000Z',
      latestState: { auditId: 'audit-idb-lease', exportStatus: 'queued', exportRevision: secondSnapshot.revision },
    }),
  ]);
  assert.equal(results.filter(result => result.acquired).length, 1);
  assert.equal(results.filter(result => result.busy).length, 1);
  assert.equal(results.find(result => result.acquired).exportAttempt, 1);
  assert.equal((await first.getLatest()).exportAttempt, 1);
});

test('IndexedDB review CAS preserves the current model and atomically clears delivery ownership and latest marker', async () => {
  const fake = createFakeIndexedDb();
  const store = createAuditStore({ indexedDB: fake });
  const auditId = 'audit-idb-review-race';
  await store.setAudit(auditId, { auditId, phase: 'review-ready' });
  const source = await store.getAuditSnapshot(auditId);
  await store.acquireExportLease(auditId, source.capability, {
    ownerId: 'owner-idb-review', now: '2026-08-27T10:00:00.000Z',
    latestState: {
      auditId,
      exportStatus: 'queued',
      exportRevision: source.revision,
      leaseOwnerId: 'owner-idb-review',
    },
  });
  await store.claimExportLease(auditId, source.capability, {
    ownerId: 'owner-idb-review', now: '2026-08-27T10:00:00.100Z',
    latestState: {
      auditId,
      exportStatus: 'running',
      exportRevision: source.revision,
      leaseOwnerId: 'owner-idb-review',
    },
  });
  const reserved = await store.commitAuditIfRevisionWithExportLease(
    auditId,
    { auditId, phase: 'prepared-report' },
    {
      auditId,
      exportStatus: 'delivering',
      exportRevision: source.revision + 1,
      leaseOwnerId: 'owner-idb-review',
    },
    source.capability,
    { ownerId: 'owner-idb-review', now: '2026-08-27T10:00:00.200Z', phase: 'delivering' },
  );
  assert.equal((await store.assertExportLease(auditId, reserved.capability, {
    ownerId: 'owner-idb-review', now: '2026-08-27T10:00:00.250Z', phase: 'delivering',
  })).active, true);

  await store.commitAuditReviewIfRevision(
    auditId,
    { auditId, phase: 'prepared-report', reviewed: true },
    reserved.capability,
  );
  const reviewed = await store.getAuditSnapshot(auditId);
  assert.deepEqual(reviewed.model, { auditId, phase: 'prepared-report', reviewed: true });
  assert.equal(reviewed.revision, reserved.revision + 1);
  assert.deepEqual(await store.getExportLeaseState(auditId, {
    now: '2026-08-27T10:00:00.300Z',
  }), { active: false, revision: reviewed.revision });
  const latest = await store.getLatest();
  assert.equal(latest.exportStatus, 'preparing');
  assert.equal(latest.exportRevision, reviewed.revision);
  assert.equal(Object.hasOwn(latest, 'leaseOwnerId'), false);
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
                  delete(key) { records.delete(key); },
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
