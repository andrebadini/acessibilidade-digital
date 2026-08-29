import assert from 'node:assert/strict';
import test from 'node:test';

import { SAMPLE_AUDIT } from '../../fixtures/audits/sample-audit.js';
import { applyReviewDecisions, createReviewDecision } from '../../src/core/review/decisions.js';
import {
  AuditDeleteBusyError,
  AuditStorageUnavailableError,
  createAuditStore,
  createInMemoryAuditStore,
} from '../../src/storage/audit-store.js';

const T0 = '2026-08-01T00:00:00.000Z';
const T29 = '2026-08-30T00:00:00.000Z';
const T30 = '2026-08-31T00:00:00.000Z';

function reviewedAuditFixture() {
  const queue = SAMPLE_AUDIT.manualReview[0];
  return applyReviewDecisions(structuredClone(SAMPLE_AUDIT), [createReviewDecision({
    auditId: SAMPLE_AUDIT.auditId,
    itemId: queue.itemId,
    occurrenceId: queue.occurrenceId,
    answer: 'conforme',
    evaluator: 'Pessoa avaliadora',
    decidedAt: '2026-08-26T16:00:00.000Z',
    mode: queue.mode,
  })]);
}

test('review CAS rejects a noncanonical model before mutating memory or IndexedDB', async () => {
  for (const createStore of [
    () => createInMemoryAuditStore(),
    () => createAuditStore({ indexedDB: createFakeIndexedDb() }),
  ]) {
    const store = createStore();
    const model = structuredClone(SAMPLE_AUDIT);
    await store.setAudit(model.auditId, model);
    const snapshot = await store.getAuditSnapshot(model.auditId);
    const invalid = structuredClone(model);
    const marker = 'PRIVATE_INVALID_REVIEW_MODEL';
    invalid.normative.edition = marker;

    await assert.rejects(
      store.commitAuditReviewIfRevision(model.auditId, invalid, snapshot.capability),
      error => {
        assert.equal(error?.code, 'AUDIT_MODEL_INPUT_INVALID');
        assert.doesNotMatch(String(error?.message), new RegExp(marker));
        return true;
      },
    );

    const after = await store.getAuditSnapshot(model.auditId);
    assert.equal(after.revision, snapshot.revision);
    assert.equal(after.model.normative.edition, model.normative.edition);
  }
});

test('production store fails visibly when IndexedDB is unavailable and never falls back to memory', async () => {
  const store = createAuditStore({ indexedDB: {} });

  await assert.rejects(store.getLatest(), error => {
    assert.ok(error instanceof AuditStorageUnavailableError);
    assert.equal(error.code, 'AUDIT_STORAGE_UNAVAILABLE');
    assert.equal(error.message, 'Não foi possível salvar a auditoria no armazenamento local. Libere espaço ou verifique as permissões e tente novamente.');
    return true;
  });
});

test('first commit creates immutable absolute retention metadata and a batch remains one record', async () => {
  const store = createInMemoryAuditStore();
  const auditId = 'batch-retention';
  await store.commitAudit(
    auditId,
    { auditId, pages: [{ pageId: 'p1' }, { pageId: 'p2' }, { pageId: 'p3' }] },
    { auditId, status: 'complete' },
    { now: T0, deleteAfterCompleteExport: true },
  );
  const first = await store.getAuditRetention(auditId);
  assert.deepEqual(first, {
    auditId, schemaVersion: 1, firstPersistedAt: T0, expiresAt: T30,
    deleteAfterCompleteExport: true,
  });

  await store.commitAudit(
    auditId,
    { auditId, pages: [{ pageId: 'p1' }, { pageId: 'p2' }, { pageId: 'p3' }], reviewed: true },
    { auditId, status: 'complete' },
    { now: T29, deleteAfterCompleteExport: false },
  );
  assert.deepEqual(await store.getAuditRetention(auditId), first);
  assert.equal(await store.getAuditRetention('p1'), undefined);
});

test('retention intent is changed only by a current store-owned snapshot capability', async () => {
  const store = createInMemoryAuditStore();
  const auditId = 'audit-retention-cas';
  await store.commitAudit(auditId, { auditId, generation: 1 }, { auditId }, { now: T0 });
  const stale = await store.getAuditSnapshot(auditId);
  await store.setAudit(auditId, { auditId, generation: 2 });

  await assert.rejects(
    store.setRetentionIntent(auditId, stale.capability, { deleteAfterCompleteExport: true, now: T29 }),
    error => error?.code === 'AUDIT_REVISION_CONFLICT',
  );
  const current = await store.getAuditSnapshot(auditId);
  const changed = await store.setRetentionIntent(auditId, current.capability, {
    deleteAfterCompleteExport: true,
    now: T29,
  });
  assert.equal(changed.revision, current.revision);
  assert.equal(changed.retention.firstPersistedAt, T0);
  assert.equal(changed.retention.expiresAt, T30);
  assert.equal(changed.retention.deleteAfterCompleteExport, true);
});

test('incremental cleanup deletes at most 25 expired records and continues without touching future records', async () => {
  const store = createInMemoryAuditStore();
  for (let index = 0; index < 26; index += 1) {
    const auditId = `expired-${String(index).padStart(2, '0')}`;
    await store.commitAudit(auditId, { auditId }, { auditId }, { now: T0 });
  }
  await store.commitAudit('future-audit', { auditId: 'future-audit' }, { auditId: 'future-audit' }, { now: T30 });

  assert.deepEqual(await store.cleanupExpiredAudits({ now: T30, limit: 25 }), {
    scanned: 25, deleted: 25, remaining: 1, blocked: 0,
  });
  assert.deepEqual(await store.cleanupExpiredAudits({ now: T30, limit: 25 }), {
    scanned: 1, deleted: 1, remaining: 0, blocked: 0,
  });
  assert.ok(await store.getAudit('future-audit'));
});

test('cleanup resumes after 25 blocked audits across store recreation and then restarts its cycle', async () => {
  for (const scenario of [
    {
      name: 'memory',
      setup() {
        const backing = new Map();
        return {
          backing,
          first: createInMemoryAuditStore(backing),
          reopen: () => createInMemoryAuditStore(backing),
          inspectPrivate: () => [...backing.entries()],
        };
      },
    },
    {
      name: 'indexeddb',
      setup() {
        const fake = createFakeIndexedDb();
        return {
          first: createAuditStore({ indexedDB: fake, IDBKeyRange: fake.IDBKeyRange }),
          reopen: () => createAuditStore({ indexedDB: fake, IDBKeyRange: fake.IDBKeyRange }),
          inspectPrivate: () => [...fake.inspectStore('audits').entries()],
        };
      },
    },
  ]) {
    const context = scenario.setup();
    for (let index = 0; index < 25; index += 1) {
      const auditId = `blocked-${String(index).padStart(2, '0')}`;
      const ownerId = `owner-${String(index).padStart(2, '0')}`;
      await context.first.commitAudit(auditId, { auditId }, { auditId }, { now: T0 });
      let snapshot = await context.first.getAuditSnapshot(auditId);
      const lease = await context.first.acquireExportLease(auditId, snapshot.capability, {
        ownerId, now: '2026-08-30T10:00:00.000Z',
      });
      await context.first.claimExportLease(auditId, snapshot.capability, {
        ownerId, exportAttempt: lease.exportAttempt, now: '2026-08-30T10:00:00.100Z',
      });
      await context.first.commitAuditIfRevisionWithExportLease(
        auditId,
        { auditId, phase: 'delivering' },
        { auditId, exportStatus: 'delivering' },
        snapshot.capability,
        {
          ownerId, exportAttempt: lease.exportAttempt,
          now: '2026-08-30T10:00:00.200Z', phase: 'delivering',
        },
      );
      snapshot = await context.first.getAuditSnapshot(auditId);
      await context.first.recordExportDelivery(auditId, snapshot.capability, {
        ownerId, exportAttempt: lease.exportAttempt,
        now: '2026-08-30T10:00:00.300Z', format: 'html', filename: 'auditoria.html', state: 'starting',
      });
    }
    await context.first.commitAudit('clean-after-blocked', { auditId: 'clean-after-blocked' }, { auditId: 'clean-after-blocked' }, { now: T0 });

    assert.deepEqual(await context.first.cleanupExpiredAudits({ now: T30, limit: 25 }), {
      scanned: 25, deleted: 0, remaining: 26, blocked: 25,
    }, scenario.name);
    const privateEntries = context.inspectPrivate()
      .filter(([key]) => String(key).startsWith('__audit_retention_cleanup__'));
    assert.equal(privateEntries.length, 1, scenario.name);
    assert.doesNotMatch(JSON.stringify(privateEntries), /https?:|token|pixel|sentinel/iu, scenario.name);

    const reopened = context.reopen();
    assert.deepEqual(await reopened.cleanupExpiredAudits({ now: T30, limit: 25 }), {
      scanned: 1, deleted: 1, remaining: 25, blocked: 0,
    }, scenario.name);
    assert.equal(await reopened.getAudit('clean-after-blocked'), undefined, scenario.name);
    assert.equal((await reopened.getAuditRetention('blocked-00')).expiresAt, T30, scenario.name);

    assert.deepEqual(await reopened.cleanupExpiredAudits({ now: T30, limit: 25 }), {
      scanned: 25, deleted: 0, remaining: 25, blocked: 25,
    }, scenario.name);
  }
});

test('delete-one enforces snapshot CAS and refuses active lease or delivery journal', async () => {
  const store = createInMemoryAuditStore();
  const auditId = 'delete-one';
  await store.commitAudit(auditId, { auditId, generation: 1 }, { auditId }, { now: T0 });
  const stale = await store.getAuditSnapshot(auditId);
  await store.setAudit(auditId, { auditId, generation: 2 });
  await assert.rejects(store.deleteAudit(auditId, stale.capability, { now: T29 }), error => error?.code === 'AUDIT_REVISION_CONFLICT');

  const current = await store.getAuditSnapshot(auditId);
  await store.acquireExportLease(auditId, current.capability, { ownerId: 'delete-owner', now: T29 });
  await assert.rejects(store.deleteAudit(auditId, current.capability, { now: T29 }), error => {
    assert.ok(error instanceof AuditDeleteBusyError);
    assert.equal(error.code, 'AUDIT_DELETE_BUSY');
    return true;
  });
  assert.ok(await store.getAudit(auditId));

  await store.releaseExportLease(auditId, { ownerId: 'delete-owner', now: T29 });
  assert.deepEqual(await store.deleteAudit(auditId, current.capability, { now: T29 }), { deleted: true });
  assert.equal(await store.getAudit(auditId), undefined);
  assert.equal(await store.getAuditRetention(auditId), undefined);
});

test('delete-all is all-or-none while any audit has delivery work', async () => {
  const store = createInMemoryAuditStore();
  for (const auditId of ['delete-all-a', 'delete-all-b']) {
    await store.commitAudit(auditId, { auditId }, { auditId }, { now: T0 });
  }
  const snapshot = await store.getAuditSnapshot('delete-all-a');
  await store.acquireExportLease('delete-all-a', snapshot.capability, { ownerId: 'all-owner', now: T29 });

  await assert.rejects(store.deleteAllAudits({ now: T29 }), error => error?.code === 'AUDIT_DELETE_BUSY');
  assert.ok(await store.getAudit('delete-all-a'));
  assert.ok(await store.getAudit('delete-all-b'));
  await store.releaseExportLease('delete-all-a', { ownerId: 'all-owner', now: T29 });
  assert.deepEqual(await store.deleteAllAudits({ now: T29 }), { deleted: 2 });
  assert.equal(await store.getAudit('delete-all-a'), undefined);
  assert.equal(await store.getAudit('delete-all-b'), undefined);
});

test('retention CAS and destructive APIs have the same contract in IndexedDB', async () => {
  const fake = createFakeIndexedDb();
  const store = createAuditStore({ indexedDB: fake, IDBKeyRange: fake.IDBKeyRange });
  for (const auditId of ['idb-delete-a', 'idb-delete-b']) {
    await store.commitAudit(auditId, { auditId }, { auditId }, { now: T0 });
  }
  const snapshotA = await store.getAuditSnapshot('idb-delete-a');
  const changed = await store.setRetentionIntent('idb-delete-a', snapshotA.capability, {
    deleteAfterCompleteExport: true,
    now: T29,
  });
  assert.equal(changed.retention.deleteAfterCompleteExport, true);
  assert.equal(changed.retention.expiresAt, T30);

  const lease = await store.acquireExportLease('idb-delete-a', changed.capability, {
    ownerId: 'idb-delete-owner', now: T29,
  });
  assert.equal(lease.acquired, true);
  await assert.rejects(store.deleteAllAudits({ now: T29 }), error => error?.code === 'AUDIT_DELETE_BUSY');
  assert.ok(await store.getAudit('idb-delete-b'));
  await store.releaseExportLease('idb-delete-a', { ownerId: 'idb-delete-owner', now: T29 });
  assert.deepEqual(await store.deleteAudit('idb-delete-a', changed.capability, { now: T29 }), { deleted: true });
  assert.equal(await store.getAudit('idb-delete-a'), undefined);
  assert.deepEqual(await store.deleteAllAudits({ now: T29 }), { deleted: 1 });
  assert.equal(fake.inspectStore('audits').size, 0);
  assert.equal(fake.inspectStore('audit-retention').size, 0);
});

test('finalization deletes only after the exact four terminal formats for the current lease and intent', async () => {
  for (const createStore of [
    () => createInMemoryAuditStore(),
    () => {
      const fake = createFakeIndexedDb();
      return createAuditStore({ indexedDB: fake, IDBKeyRange: fake.IDBKeyRange });
    },
  ]) {
    const store = createStore();
    const auditId = 'final-delete';
    await store.commitAudit(auditId, { auditId, phase: 'prepared' }, { auditId }, {
      now: T0,
      deleteAfterCompleteExport: true,
    });
    let snapshot = await store.getAuditSnapshot(auditId);
    const lease = await store.acquireExportLease(auditId, snapshot.capability, {
      ownerId: 'final-owner', now: '2026-08-30T10:00:00.000Z',
    });
    await store.claimExportLease(auditId, snapshot.capability, {
      ownerId: 'final-owner', exportAttempt: lease.exportAttempt,
      now: '2026-08-30T10:00:00.100Z',
    });
    const reserved = await store.commitAuditIfRevisionWithExportLease(
      auditId,
      { auditId, phase: 'delivering' },
      { auditId, exportStatus: 'delivering' },
      snapshot.capability,
      {
        ownerId: 'final-owner', exportAttempt: lease.exportAttempt,
        now: '2026-08-30T10:00:00.200Z', phase: 'delivering',
      },
    );
    snapshot = await store.getAuditSnapshot(auditId);
    assert.equal(snapshot.revision, reserved.revision);
    for (const [index, format] of ['html', 'json', 'csv', 'pdf'].entries()) {
      await store.recordExportDelivery(auditId, snapshot.capability, {
        ownerId: 'final-owner', exportAttempt: lease.exportAttempt,
        now: `2026-08-30T10:00:01.${String(index).padStart(3, '0')}Z`,
        format,
        filename: `auditoria.${format}`,
        state: 'terminal',
        downloadId: index + 1,
      });
    }
    const result = await store.finalizeExportAndMaybeDelete(
      auditId,
      { auditId, phase: 'complete' },
      { auditId, exportStatus: 'complete' },
      snapshot.capability,
      {
        ownerId: 'final-owner', exportAttempt: lease.exportAttempt,
        now: '2026-08-30T10:00:02.000Z', clearDeliveryJournal: true,
        deleteAfterCompleteExport: true,
      },
    );
    assert.deepEqual(result, { deleted: true });
    assert.equal(await store.getAudit(auditId), undefined);
    assert.equal(await store.getAuditRetention(auditId), undefined);
    assert.deepEqual(await store.getExportDeliveryJournal(auditId), []);
  }
});

test('incomplete delivery receipt preserves the audit even when delete-after-export was selected', async () => {
  const store = createInMemoryAuditStore();
  const auditId = 'partial-retained';
  await store.commitAudit(auditId, { auditId }, { auditId }, { now: T0, deleteAfterCompleteExport: true });
  let snapshot = await store.getAuditSnapshot(auditId);
  const lease = await store.acquireExportLease(auditId, snapshot.capability, {
    ownerId: 'partial-owner', now: '2026-08-30T10:00:00.000Z',
  });
  await store.claimExportLease(auditId, snapshot.capability, {
    ownerId: 'partial-owner', exportAttempt: lease.exportAttempt, now: '2026-08-30T10:00:00.100Z',
  });
  await store.commitAuditIfRevisionWithExportLease(
    auditId, { auditId, phase: 'delivering' }, { auditId, exportStatus: 'delivering' }, snapshot.capability,
    { ownerId: 'partial-owner', exportAttempt: lease.exportAttempt, now: '2026-08-30T10:00:00.200Z', phase: 'delivering' },
  );
  snapshot = await store.getAuditSnapshot(auditId);
  for (const [index, format] of ['html', 'json', 'pdf'].entries()) {
    await store.recordExportDelivery(auditId, snapshot.capability, {
      ownerId: 'partial-owner', exportAttempt: lease.exportAttempt,
      now: `2026-08-30T10:00:01.${String(index).padStart(3, '0')}Z`,
      format, filename: `auditoria.${format}`, state: 'terminal', downloadId: index + 1,
    });
  }
  const result = await store.finalizeExportAndMaybeDelete(
    auditId,
    { auditId, phase: 'partial' },
    { auditId, exportStatus: 'partial' },
    snapshot.capability,
    {
      ownerId: 'partial-owner', exportAttempt: lease.exportAttempt,
      now: '2026-08-30T10:00:02.000Z', clearDeliveryJournal: true,
      deleteAfterCompleteExport: true,
    },
  );
  assert.equal(result.deleted, false);
  assert.equal((await store.getAudit(auditId)).phase, 'partial');
  assert.ok(await store.getAuditRetention(auditId));
});

test('store finalization rejects model or latest state correlated to another audit', async () => {
  for (const createStore of [
    () => createInMemoryAuditStore(),
    () => {
      const fake = createFakeIndexedDb();
      return createAuditStore({ indexedDB: fake, IDBKeyRange: fake.IDBKeyRange });
    },
  ]) {
    const store = createStore();
    const auditId = 'final-correlation';
    await store.commitAudit(auditId, { auditId }, { auditId }, { now: T0 });
    const snapshot = await store.getAuditSnapshot(auditId);
    const lease = await store.acquireExportLease(auditId, snapshot.capability, {
      ownerId: 'correlation-owner', now: '2026-08-30T10:00:00.000Z',
    });
    const options = {
      ownerId: 'correlation-owner', exportAttempt: lease.exportAttempt,
      now: '2026-08-30T10:00:00.100Z', clearDeliveryJournal: true,
      deleteAfterCompleteExport: false,
    };

    await assert.rejects(
      store.finalizeExportAndMaybeDelete(
        auditId, { auditId: 'different-model' }, { auditId }, snapshot.capability, options,
      ),
      /não corresponde|correla/iu,
    );
    await assert.rejects(
      store.finalizeExportAndMaybeDelete(
        auditId, { auditId }, { auditId: 'different-latest' }, snapshot.capability, options,
      ),
      /não corresponde|correla/iu,
    );
    assert.equal((await store.getAudit(auditId)).auditId, auditId);
  }
});

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
  await assert.rejects(
    store.commitAudit('audit-1', { auditId: 'audit-1', version: 2 }, { invalid: () => {} }),
    error => error instanceof AuditStorageUnavailableError && error.code === 'AUDIT_STORAGE_UNAVAILABLE',
  );
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

test('IndexedDB v2 persists limited retention metadata beside each model in one transaction', async () => {
  const fake = createFakeIndexedDb();
  const store = createAuditStore({ indexedDB: fake, IDBKeyRange: fake.IDBKeyRange });
  const auditId = 'audit-idb-retention';
  await store.commitAudit(
    auditId,
    { auditId, url: 'https://sensitive.invalid/?token=never-copy', pixels: 'secret-pixels' },
    { auditId, status: 'complete' },
    { now: T0, deleteAfterCompleteExport: true },
  );

  assert.equal(fake.versions[0], 2);
  assert.equal(fake.createdStores.includes('audit-retention'), true);
  assert.equal(fake.inspectIndexes('audit-retention').get('byExpiresAt').keyPath, 'expiresAt');
  assert.ok(fake.transactionStores.some(names => names.length === 2 && names.includes('audits') && names.includes('audit-retention')));
  assert.deepEqual(fake.inspectStore('audit-retention').get(auditId), {
    auditId, schemaVersion: 1, firstPersistedAt: T0, expiresAt: T30,
    deleteAfterCompleteExport: true,
  });
  assert.doesNotMatch(JSON.stringify(fake.inspectStore('audit-retention')), /sensitive|token|pixel/iu);
});

test('IndexedDB v1 migration creates metadata only for normal audit records and preserves private keys', async () => {
  const auditId = 'legacy-batch';
  const privateEntries = [
    ['__latest__', { auditId }],
    [`__audit_revision__:${auditId}`, 4],
    [`__audit_export_lease__:${auditId}`, { ownerId: 'legacy-owner' }],
    [`__audit_export_attempt__:${auditId}`, 2],
    [`__audit_export_delivery__:${auditId}`, { schemaVersion: 1, auditId, entries: [] }],
  ];
  const fake = createFakeIndexedDb({
    version: 1,
    initialStores: {
      audits: [[auditId, {
        auditId,
        timestamps: { endedAt: '2026-01-02T03:04:05.006Z' },
        url: 'https://sensitive.invalid/?token=never-copy',
        pixels: 'secret-pixels',
      }], ...privateEntries],
    },
  });
  const store = createAuditStore({ indexedDB: fake, IDBKeyRange: fake.IDBKeyRange });

  assert.equal((await store.getAudit(auditId)).auditId, auditId);
  assert.deepEqual(await store.getAuditRetention(auditId), {
    auditId, schemaVersion: 1,
    firstPersistedAt: '2026-01-02T03:04:05.006Z',
    expiresAt: '2026-02-01T03:04:05.006Z',
    deleteAfterCompleteExport: false,
  });
  assert.equal(fake.inspectStore('audit-retention').size, 1);
  for (const [key, value] of privateEntries) assert.deepEqual(fake.inspectStore('audits').get(key), value);
  assert.doesNotMatch(JSON.stringify(fake.inspectStore('audit-retention')), /sensitive|token|pixel/iu);
});

test('v1 migration removes a legacy URL key instead of copying its query into retention metadata', async () => {
  const rawQueryKey = 'https://legacy.invalid/a?ordinary_parameter=raw-query-value';
  const fake = createFakeIndexedDb({
    version: 1,
    initialStores: {
      audits: [[rawQueryKey, {
        auditId: rawQueryKey,
        timestamps: { endedAt: '2026-01-02T03:04:05.006Z' },
      }],
      [`__audit_revision__:${rawQueryKey}`, 1],
      ['__latest__', { auditId: rawQueryKey, status: 'complete' }]],
    },
  });
  const store = createAuditStore({ indexedDB: fake, IDBKeyRange: fake.IDBKeyRange });

  await store.getLatest();

  assert.equal(fake.inspectStore('audits').has(rawQueryKey), false);
  assert.equal(
    [...fake.inspectStore('audits').keys()].some(key => String(key).includes('raw-query-value')),
    false,
  );
  assert.equal(fake.inspectStore('audits').has('__latest__'), false);
  assert.equal(fake.inspectStore('audit-retention').size, 0);
  assert.doesNotMatch(JSON.stringify([...fake.inspectStore('audit-retention')]), /ordinary_parameter|raw-query-value/iu);
});

test('IndexedDB retention expiration remains absolute through revision and cleans incrementally', async () => {
  const fake = createFakeIndexedDb();
  const store = createAuditStore({ indexedDB: fake, IDBKeyRange: fake.IDBKeyRange });
  for (let index = 0; index < 26; index += 1) {
    const auditId = `idb-expired-${String(index).padStart(2, '0')}`;
    await store.commitAudit(auditId, { auditId }, { auditId }, { now: T0 });
  }
  await store.commitAudit('idb-future', { auditId: 'idb-future' }, { auditId: 'idb-future' }, { now: T30 });
  await store.commitAudit('idb-expired-25', { auditId: 'idb-expired-25', reviewed: true }, { auditId: 'idb-expired-25' }, { now: T29 });
  assert.equal((await store.getAuditRetention('idb-expired-25')).expiresAt, T30);

  assert.deepEqual(await store.cleanupExpiredAudits({ now: T30, limit: 25 }), {
    scanned: 25, deleted: 25, remaining: 1, blocked: 0,
  });
  assert.deepEqual(await store.cleanupExpiredAudits({ now: T30, limit: 25 }), {
    scanned: 1, deleted: 1, remaining: 0, blocked: 0,
  });
  assert.ok(await store.getAudit('idb-future'));
});

test('IndexedDB quota or transaction abort exposes only the fixed storage error and commits nothing', async () => {
  const fake = createFakeIndexedDb({ failWrites: true, writeError: new Error('QuotaExceeded: db=audita-mt bytes=secret') });
  const store = createAuditStore({ indexedDB: fake, IDBKeyRange: fake.IDBKeyRange });

  await assert.rejects(
    store.commitAudit(
      'quota-audit',
      { auditId: 'quota-audit', url: 'https://sensitive.invalid/?token=never-log' },
      { auditId: 'quota-audit' },
      { now: T0 },
    ),
    error => error instanceof AuditStorageUnavailableError &&
      error.code === 'AUDIT_STORAGE_UNAVAILABLE' &&
      error.message === 'Não foi possível salvar a auditoria no armazenamento local. Libere espaço ou verifique as permissões e tente novamente.',
  );
  assert.equal(fake.inspectStore('audits').size, 0);
  assert.equal(fake.inspectStore('audit-retention').size, 0);
});

test('IndexedDB request failures never expose native database details', async () => {
  const fake = createFakeIndexedDb({
    failReads: true,
    readError: new Error('UnknownError: db=audita-mt url=https://private.invalid/?token=never-log'),
  });
  const store = createAuditStore({ indexedDB: fake, IDBKeyRange: fake.IDBKeyRange });

  await assert.rejects(store.getLatest(), error => {
    assert.ok(error instanceof AuditStorageUnavailableError);
    assert.equal(error.code, 'AUDIT_STORAGE_UNAVAILABLE');
    assert.equal(error.message, 'Não foi possível salvar a auditoria no armazenamento local. Libere espaço ou verifique as permissões e tente novamente.');
    assert.doesNotMatch(error.message, /database|audita-mt|private|token/iu);
    return true;
  });
});

test('persistent storage clone failures are fixed, accessor-safe and retryable across mutation boundaries', async t => {
  const nativeDetail = 'NATIVE_DATA_CLONE_DETAIL_49';
  const fixedFailure = error => {
    assert.ok(error instanceof AuditStorageUnavailableError);
    assert.equal(error.code, 'AUDIT_STORAGE_UNAVAILABLE');
    assert.equal(error.message, 'Não foi possível salvar a auditoria no armazenamento local. Libere espaço ou verifique as permissões e tente novamente.');
    assert.doesNotMatch(error.message, /NATIVE_DATA_CLONE_DETAIL_49|DataCloneError/iu);
    return true;
  };
  const hostileValue = (auditId, extra = {}) => {
    let accessorReads = 0;
    const value = { auditId, ...extra };
    Object.defineProperty(value, 'payload', {
      enumerable: true,
      get() {
        accessorReads += 1;
        throw new Error(nativeDetail);
      },
    });
    return { value, reads: () => accessorReads };
  };
  const createPersistentStore = () => {
    const fake = createFakeIndexedDb();
    return createAuditStore({ indexedDB: fake, IDBKeyRange: fake.IDBKeyRange });
  };

  await t.test('direct put', async () => {
    const store = createPersistentStore();
    const hostile = hostileValue('clone-put');
    await assert.rejects(Promise.resolve().then(() => store.setLatest(hostile.value)), fixedFailure);
    assert.equal(hostile.reads(), 0);
    await store.setLatest({ auditId: 'clone-put', status: 'complete' });
    assert.equal((await store.getLatest()).status, 'complete');
  });

  await t.test('audit mutation', async () => {
    const store = createPersistentStore();
    const hostile = hostileValue('clone-mutation');
    await assert.rejects(
      store.commitAudit('clone-mutation', hostile.value, { auditId: 'clone-mutation' }, { now: T0 }),
      fixedFailure,
    );
    assert.equal(hostile.reads(), 0);
    await store.commitAudit(
      'clone-mutation', { auditId: 'clone-mutation' }, { auditId: 'clone-mutation' }, { now: T0 },
    );
    assert.equal((await store.getAudit('clone-mutation')).auditId, 'clone-mutation');
  });

  await t.test('interrupted-checkpoint settlement', async () => {
    const store = createPersistentStore();
    const auditId = 'clone-interrupted';
    await store.commitAudit(
      auditId,
      { auditId, session: { status: 'running' } },
      { auditId, status: 'running' },
      { now: T0 },
    );
    const hostile = hostileValue(auditId, { status: 'failed' });
    await assert.rejects(
      store.markAuditInterrupted(auditId, hostile.value, { now: '2026-08-01T00:00:01.000Z' }),
      fixedFailure,
    );
    assert.equal(hostile.reads(), 0);
    assert.deepEqual(
      await store.markAuditInterrupted(
        auditId, { auditId, status: 'failed' }, { now: '2026-08-01T00:00:01.100Z' },
      ),
      { updated: true, reason: 'interrupted' },
    );
  });

  await t.test('atomic export finalization', async () => {
    const store = createPersistentStore();
    const auditId = 'clone-finalization';
    await store.commitAudit(auditId, { auditId }, { auditId, status: 'complete' }, { now: T0 });
    const source = await store.getAuditSnapshot(auditId);
    const acquired = await store.acquireExportLease(auditId, source.capability, {
      ownerId: 'clone-owner', now: '2026-08-01T00:00:01.000Z',
      latestState: { auditId, exportStatus: 'queued', exportRevision: source.revision },
    });
    await store.claimExportLease(auditId, source.capability, {
      ownerId: 'clone-owner', exportAttempt: acquired.exportAttempt,
      now: '2026-08-01T00:00:01.100Z',
      latestState: { auditId, exportStatus: 'running', exportRevision: source.revision },
    });
    const reserved = await store.commitAuditIfRevisionWithExportLease(
      auditId,
      { auditId, session: { status: 'partial' } },
      { auditId, exportStatus: 'delivering', exportRevision: source.revision + 1 },
      source.capability,
      {
        ownerId: 'clone-owner', exportAttempt: acquired.exportAttempt,
        now: '2026-08-01T00:00:01.200Z', phase: 'delivering',
      },
    );
    let downloadId = 70;
    for (const format of ['html', 'json', 'csv', 'pdf']) {
      await store.recordExportDelivery(auditId, reserved.capability, {
        ownerId: 'clone-owner', exportAttempt: acquired.exportAttempt,
        now: `2026-08-01T00:00:02.${String(downloadId).padStart(3, '0')}Z`,
        format, filename: `clone-finalization.${format}`, state: 'terminal', downloadId,
      });
      downloadId += 1;
    }
    const hostile = hostileValue(auditId, { session: { status: 'partial' } });
    const options = {
      ownerId: 'clone-owner', exportAttempt: acquired.exportAttempt,
      now: '2026-08-01T00:00:03.000Z', clearDeliveryJournal: true,
      deleteAfterCompleteExport: false,
    };
    await assert.rejects(
      store.finalizeExportAndMaybeDelete(
        auditId, hostile.value, { auditId, exportStatus: 'partial' }, reserved.capability, options,
      ),
      fixedFailure,
    );
    assert.equal(hostile.reads(), 0);
    const finalized = await store.finalizeExportAndMaybeDelete(
      auditId,
      { auditId, session: { status: 'partial' } },
      { auditId, exportStatus: 'partial' },
      reserved.capability,
      options,
    );
    assert.equal(finalized.deleted, false);
  });
});

test('storage clone does not re-traverse a graph after descriptor capture', async () => {
  const nativeDetail = 'NESTED_PROXY_NATIVE_DETAIL_73';
  let accessorReads = 0;
  let prototypeWalks = 0;
  const nested = { payload: 'captured-before-prototype-walk' };
  const mutatingPrototype = new Proxy({}, {
    getPrototypeOf() {
      prototypeWalks += 1;
      Object.defineProperty(nested, 'payload', {
        configurable: true,
        enumerable: true,
        get() {
          accessorReads += 1;
          throw new Error(nativeDetail);
        },
      });
      return Object.prototype;
    },
  });
  const mutator = Object.create(mutatingPrototype);
  const hostile = { auditId: 'clone-toctou', mutator, nested };
  const store = createInMemoryAuditStore();

  await assert.rejects(store.setLatest(hostile), error => {
    assert.ok(error instanceof AuditStorageUnavailableError);
    assert.equal(error.code, 'AUDIT_STORAGE_UNAVAILABLE');
    assert.equal(error.message, 'Não foi possível salvar a auditoria no armazenamento local. Libere espaço ou verifique as permissões e tente novamente.');
    assert.doesNotMatch(error.message, /NESTED_PROXY_NATIVE_DETAIL_73/iu);
    return true;
  });
  assert.equal(prototypeWalks, 0, 'a validação não deve caminhar por protótipos controlados pelo valor');
  assert.equal(accessorReads, 0, 'nenhuma segunda travessia pode alcançar o acessor instalado depois');

  await store.setLatest({ auditId: 'clone-toctou', status: 'complete' });
  assert.deepEqual(await store.getLatest(), { auditId: 'clone-toctou', status: 'complete' });

  const shared = { label: 'same-node' };
  const cyclic = { auditId: 'clone-toctou', left: shared, right: shared };
  cyclic.self = cyclic;
  await store.setLatest(cyclic);
  const detached = await store.getLatest();
  assert.notEqual(detached, cyclic);
  assert.equal(detached.left, detached.right, 'aliases permanecem correlacionados no snapshot');
  assert.equal(detached.self, detached, 'ciclos suportados permanecem internos ao snapshot destacado');
});

test('every synchronous IndexedDB boundary is sanitized and remains retryable', async t => {
  const sensitive = 'SecurityError: db=audita-mt url=https://private.invalid/?token=never-log';
  const assertFixedTwice = async operation => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await assert.rejects(operation(), error => {
        assert.ok(error instanceof AuditStorageUnavailableError);
        assert.equal(error.code, 'AUDIT_STORAGE_UNAVAILABLE');
        assert.equal(error.message, 'Não foi possível salvar a auditoria no armazenamento local. Libere espaço ou verifique as permissões e tente novamente.');
        assert.doesNotMatch(error.message, /database|audita-mt|private|token/iu);
        return true;
      });
    }
  };

  await t.test('indexedDB.open', async () => {
    const fake = createFakeIndexedDb({ syncOpenFailures: 2, syncError: new Error(sensitive) });
    const store = createAuditStore({ indexedDB: fake, IDBKeyRange: fake.IDBKeyRange });
    await assertFixedTwice(() => store.getLatest());
    assert.equal(fake.openCalls, 2);
  });

  await t.test('db.transaction', async () => {
    const fake = createFakeIndexedDb({ syncTransactionFailures: 2, syncError: new Error(sensitive) });
    const store = createAuditStore({ indexedDB: fake, IDBKeyRange: fake.IDBKeyRange });
    await assertFixedTwice(() => store.getLatest());
  });

  await t.test('transaction.objectStore', async () => {
    const fake = createFakeIndexedDb({ syncObjectStoreFailures: 2, syncError: new Error(sensitive) });
    const store = createAuditStore({ indexedDB: fake, IDBKeyRange: fake.IDBKeyRange });
    await assertFixedTwice(() => store.getLatest());
  });

  await t.test('objectStore.index', async () => {
    const fake = createFakeIndexedDb({ syncIndexFailures: 2, syncError: new Error(sensitive) });
    const store = createAuditStore({ indexedDB: fake, IDBKeyRange: fake.IDBKeyRange });
    await store.commitAudit('sync-index-audit', { auditId: 'sync-index-audit' }, { auditId: 'sync-index-audit' }, { now: T0 });
    await assertFixedTwice(() => store.cleanupExpiredAudits({ now: T30, limit: 25 }));
  });
});

test('every synchronous IndexedDB operation aborts its transaction and exposes only the fixed error', async t => {
  const sensitive = 'OperationError: db=audita-mt url=https://private.invalid/?token=never-log';
  const assertFixedAbort = async (fake, boundary, operation) => {
    const before = fake.abortCalls;
    fake.failNext(boundary);
    await assert.rejects(operation(), error => {
      assert.ok(error instanceof AuditStorageUnavailableError, boundary);
      assert.equal(error.code, 'AUDIT_STORAGE_UNAVAILABLE', boundary);
      assert.doesNotMatch(error.message, /operation|database|audita-mt|private|token/iu, boundary);
      return true;
    });
    assert.equal(fake.abortCalls, before + 1, `${boundary}: a transação precisa ser abortada`);
  };

  await t.test('object-store request matrix', async () => {
    const fake = createFakeIndexedDb({ syncError: new Error(sensitive) });
    const store = createAuditStore({ indexedDB: fake, IDBKeyRange: fake.IDBKeyRange });
    await store.commitAudit('operation-matrix', { auditId: 'operation-matrix' }, { auditId: 'operation-matrix' }, { now: T0 });
    const snapshot = await store.getAuditSnapshot('operation-matrix');
    await assertFixedAbort(fake, 'store.put', () => store.setLatest({ auditId: 'operation-matrix' }));
    await assertFixedAbort(fake, 'store.get', () => store.getLatest());
    await assertFixedAbort(fake, 'store.delete', () => store.deleteAudit('operation-matrix', snapshot.capability, { now: T29 }));
    await assertFixedAbort(fake, 'store.getAllKeys', () => store.deleteAllAudits({ now: T29 }));
    await assertFixedAbort(fake, 'store.clear', () => store.deleteAllAudits({ now: T29 }));
  });

  for (const boundary of ['keyRange.upperBound', 'index.count', 'index.openCursor', 'cursor.continue']) {
    await t.test(boundary, async () => {
      const fake = createFakeIndexedDb({ syncError: new Error(sensitive) });
      const store = createAuditStore({ indexedDB: fake, IDBKeyRange: fake.IDBKeyRange });
      for (const id of ['cursor-a', 'cursor-b']) {
        await store.commitAudit(id, { auditId: id }, { auditId: id }, { now: T0 });
      }
      await assertFixedAbort(fake, boundary, () => store.cleanupExpiredAudits({ now: T30, limit: 25 }));
    });
  }

  await t.test('cursor.continuePrimaryKey', async () => {
    const fake = createFakeIndexedDb({ syncError: new Error(sensitive) });
    const store = createAuditStore({ indexedDB: fake, IDBKeyRange: fake.IDBKeyRange });
    for (const id of ['marker-b', 'marker-c']) {
      await store.commitAudit(id, { auditId: id }, { auditId: id }, { now: T0 });
    }
    await store.cleanupExpiredAudits({ now: T30, limit: 1 });
    await store.commitAudit('marker-a', { auditId: 'marker-a' }, { auditId: 'marker-a' }, { now: T0 });
    await assertFixedAbort(fake, 'cursor.continuePrimaryKey', () =>
      store.cleanupExpiredAudits({ now: T30, limit: 25 }));
  });

  for (const boundary of ['store.createIndex', 'store.openCursor']) {
    await t.test(boundary, async () => {
      const fake = createFakeIndexedDb({
        version: 1,
        initialStores: { audits: [['legacy-operation', { auditId: 'legacy-operation' }]] },
        syncError: new Error(sensitive),
      });
      const store = createAuditStore({ indexedDB: fake, IDBKeyRange: fake.IDBKeyRange });
      fake.failNext(boundary);
      await assert.rejects(store.getLatest(), error => error instanceof AuditStorageUnavailableError &&
        !/operation|database|audita-mt|private|token/iu.test(error.message));
      assert.ok(fake.abortCalls >= 1, boundary);
    });
  }
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

test('all store backends reject audit identifiers outside the shared strict grammar', async () => {
  for (const store of [
    createInMemoryAuditStore(),
    createAuditStore({ indexedDB: createFakeIndexedDb() }),
  ]) {
    for (const auditId of [
      'https://site.invalid/path?ordinary_parameter=raw-query-value',
      'audit id with spaces',
      'audit/with/slashes',
      `audit-${'x'.repeat(200)}`,
    ]) {
      await assert.rejects(
        store.setAudit(auditId, { auditId }),
        /identificador|inválido/iu,
      );
      await assert.rejects(
        Promise.resolve().then(() => store.getAudit(auditId)),
        /identificador|inválido/iu,
      );
    }
  }
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

test('interrupted-checkpoint settlement preserves terminal models and queued export ownership in memory and IndexedDB', async () => {
  for (const store of [
    createInMemoryAuditStore(),
    createAuditStore({ indexedDB: createFakeIndexedDb() }),
  ]) {
    const auditId = 'batch-terminal-export-owned';
    await store.commitAudit(auditId, {
      auditId, session: { status: 'complete' }, report: {},
    }, {
      auditId, mode: 'batch', status: 'complete', exportStatus: 'preparing',
    }, { now: T0 });
    const snapshot = await store.getAuditSnapshot(auditId);
    const lease = await store.acquireExportLease(auditId, snapshot.capability, {
      ownerId: 'owner-terminal-export', now: '2026-08-27T10:00:00.000Z',
      latestState: {
        auditId, mode: 'batch', status: 'complete', exportStatus: 'queued',
        exportRevision: snapshot.revision, leaseOwnerId: 'owner-terminal-export',
      },
    });

    const result = await store.markAuditInterrupted(auditId, {
      auditId, mode: 'batch', status: 'failed', exportStatus: 'unavailable',
      message: 'Lote interrompido.',
    }, { now: '2026-08-27T10:00:00.100Z' });

    assert.deepEqual(result, { updated: false, reason: 'terminal' });
    const after = await store.getAuditSnapshot(auditId);
    assert.equal(after.revision, snapshot.revision);
    assert.equal(after.model.session.status, 'complete');
    assert.equal((await store.getLatest()).exportStatus, 'queued');
    assert.deepEqual(await store.getExportLeaseState(auditId, {
      now: '2026-08-27T10:00:00.100Z',
    }), {
      active: true, phase: 'queued', retryAt: lease.expiresAt,
      revision: snapshot.revision, exportAttempt: lease.exportAttempt,
      ownerId: 'owner-terminal-export',
    });
  }
});

test('interrupted-checkpoint settlement updates only a still-current non-terminal audit in memory and IndexedDB', async () => {
  for (const createStore of [
    () => createInMemoryAuditStore(),
    () => createAuditStore({ indexedDB: createFakeIndexedDb() }),
  ]) {
    const liveStore = createStore();
    const liveId = 'batch-interrupted-live';
    await liveStore.commitAudit(liveId, {
      auditId: liveId, session: { status: 'running' }, report: {},
    }, {
      auditId: liveId, mode: 'batch', status: 'running', percent: 50,
    }, { now: T0 });
    const liveBefore = await liveStore.getAuditSnapshot(liveId);
    const retentionBefore = await liveStore.getAuditRetention(liveId);
    assert.deepEqual(await liveStore.markAuditInterrupted(liveId, {
      auditId: liveId, mode: 'batch', status: 'failed', exportStatus: 'unavailable',
      message: 'Lote interrompido.',
    }, { now: '2026-08-27T10:00:00.000Z' }), {
      updated: true, reason: 'interrupted',
    });
    const liveAfter = await liveStore.getAuditSnapshot(liveId);
    assert.equal(liveAfter.revision, liveBefore.revision);
    assert.deepEqual(liveAfter.model, liveBefore.model);
    assert.deepEqual(await liveStore.getAuditRetention(liveId), retentionBefore);
    assert.equal((await liveStore.getLatest()).status, 'failed');
    assert.deepEqual(await liveStore.getExportDeliveryJournal(liveId), []);

    const deletedStore = createStore();
    const deletedId = 'batch-interrupted-deleted';
    await deletedStore.commitAudit(deletedId, {
      auditId: deletedId, session: { status: 'running' }, report: {},
    }, {
      auditId: deletedId, mode: 'batch', status: 'running', percent: 50,
    }, { now: T0 });
    const deletedSnapshot = await deletedStore.getAuditSnapshot(deletedId);
    await deletedStore.deleteAudit(deletedId, deletedSnapshot.capability, {
      now: '2026-08-27T10:00:00.000Z',
    });
    assert.deepEqual(await deletedStore.markAuditInterrupted(deletedId, {
      auditId: deletedId, mode: 'batch', status: 'failed', exportStatus: 'unavailable',
      message: 'Lote interrompido.',
    }, { now: '2026-08-27T10:00:00.100Z' }), {
      updated: false, reason: 'stale',
    });
    assert.equal(await deletedStore.getAudit(deletedId), undefined);
    assert.equal(await deletedStore.getAuditRetention(deletedId), undefined);
    assert.equal(await deletedStore.getLatest(), undefined);
    assert.deepEqual(await deletedStore.getExportDeliveryJournal(deletedId), []);

    await deletedStore.setLatest({ auditId: 'newer-audit', status: 'complete' });
    assert.deepEqual(await deletedStore.markAuditInterrupted(deletedId, {
      auditId: deletedId, mode: 'batch', status: 'failed', exportStatus: 'unavailable',
      message: 'Lote interrompido.',
    }, { now: '2026-08-27T10:00:00.200Z' }), {
      updated: false, reason: 'stale',
    });
    assert.deepEqual(await deletedStore.getLatest(), {
      auditId: 'newer-audit', status: 'complete',
    });

    const malformedStore = createStore();
    const malformedId = 'batch-interrupted-malformed';
    await malformedStore.commitAudit(malformedId, {
      auditId: malformedId, session: { status: 'running' }, report: {},
    }, {
      auditId: malformedId, mode: 'batch', status: 'unknown-state',
    }, { now: T0 });
    assert.deepEqual(await malformedStore.markAuditInterrupted(malformedId, {
      auditId: malformedId, mode: 'batch', status: 'failed', exportStatus: 'unavailable',
      message: 'Lote interrompido.',
    }, { now: '2026-08-27T10:00:00.300Z' }), {
      updated: false, reason: 'stale',
    });
    assert.equal((await malformedStore.getLatest()).status, 'unknown-state');
  }
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
    const auditId = SAMPLE_AUDIT.auditId;
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
      auditId, reviewedAuditFixture(), snapshot.capability,
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
  const auditId = SAMPLE_AUDIT.auditId;
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
  await store.commitAuditReviewIfRevision(auditId, reviewedAuditFixture(), snapshot.capability);
  await store.resolveExportDelivery(auditId, {
    ownerId: 'owner-export', exportAttempt: 1, now: '2026-08-27T10:00:00.400Z',
    format: 'pdf', filename: 'audit.pdf', downloadId: 99, outcome: 'cleanup-failed',
  });

  assert.equal((await store.getAudit(auditId)).reviewDecisions.length, 1);
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
  const auditId = SAMPLE_AUDIT.auditId;
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
  }), error => error instanceof AuditStorageUnavailableError && error.code === 'AUDIT_STORAGE_UNAVAILABLE');
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
  }), error => error instanceof AuditStorageUnavailableError && error.code === 'AUDIT_STORAGE_UNAVAILABLE');
  assert.deepEqual(await store.getExportDeliveryJournal(auditId), journalBefore);

  await assert.rejects(store.commitAuditReviewIfRevision(
    auditId, reviewedAuditFixture(), snapshot.capability,
  ), error => error instanceof AuditStorageUnavailableError && error.code === 'AUDIT_STORAGE_UNAVAILABLE');
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
  const auditId = SAMPLE_AUDIT.auditId;
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

  const nextModel = reviewedAuditFixture();
  await store.commitAuditReviewIfRevision(
    auditId,
    nextModel,
    reserved.capability,
  );
  const reviewed = await store.getAuditSnapshot(auditId);
  assert.deepEqual(reviewed.model, nextModel);
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
  await assert.rejects(
    createAuditStore({ indexedDB: blocked }).getLatest(),
    error => error?.code === 'AUDIT_STORAGE_UNAVAILABLE' && !/bloquead|database|audita-mt/iu.test(error.message),
  );
});

function createFakeIndexedDb(options = {}) {
  const stores = new Map();
  let databaseVersion = options.version ?? 0;
  for (const [name, entries] of Object.entries(options.initialStores ?? {})) {
    stores.set(name, { keyPath: undefined, records: new Map(entries.map(([key, value]) => [key, structuredClone(value)])), indexes: new Map() });
  }
  let writeActive = false;
  const writeQueue = [];
  const syncFailures = {
    open: options.syncOpenFailures ?? 0,
    transaction: options.syncTransactionFailures ?? 0,
    objectStore: options.syncObjectStoreFailures ?? 0,
    index: options.syncIndexFailures ?? 0,
    ...(options.syncOperationFailures ?? {}),
  };
  const throwSynchronousFailure = boundary => {
    if ((syncFailures[boundary] ?? 0) < 1) return;
    syncFailures[boundary] -= 1;
    throw options.syncError ?? new Error(`Sensitive ${boundary} failure`);
  };

  const cloneValue = value => value === undefined ? undefined : structuredClone(value);
  const createTransaction = (storeNames, mode = 'readonly', active = true) => {
    const names = Array.isArray(storeNames) ? storeNames : [storeNames];
    let pending = 0;
    let completionQueued = false;
    let completed = false;
    const waiters = [];
    const scheduled = [];
    const transaction = {
      mode,
      error: null,
      objectStore(name) {
        throwSynchronousFailure('objectStore');
        if (!names.includes(name) || !stores.has(name)) throw new Error(`Unknown store ${name}`);
        return createStoreFacade(name, transaction);
      },
      abort() {
        if (completed) return;
        fake.abortCalls += 1;
        completed = true;
        transaction.error ??= new Error('AbortError');
        queueMicrotask(() => {
          transaction.onabort?.();
          for (const waiter of waiters.splice(0)) waiter();
        });
      },
      _begin() { pending += 1; },
      _schedule(operation) {
        if (active) queueMicrotask(operation);
        else scheduled.push(operation);
      },
      _activate() {
        if (active || completed) return;
        active = true;
        for (const operation of scheduled.splice(0)) queueMicrotask(operation);
        if (pending === 0) transaction._queueCompletion();
      },
      _end() {
        pending -= 1;
        if (pending === 0) transaction._queueCompletion();
      },
      _queueCompletion() {
        if (!active || completionQueued || completed) return;
        completionQueued = true;
        queueMicrotask(() => queueMicrotask(() => {
          completionQueued = false;
          if (completed || pending !== 0) return;
          completed = true;
          transaction.oncomplete?.();
          for (const waiter of waiters.splice(0)) waiter();
        }));
      },
      _whenDone(callback) {
        if (completed) queueMicrotask(callback);
        else waiters.push(callback);
      },
    };
    if (active) transaction._queueCompletion();
    return transaction;
  };

  const createStoreFacade = (name, transaction) => {
    const definition = stores.get(name);
    const keyFor = (value, explicitKey) => {
      if (explicitKey !== undefined) return explicitKey;
      if (definition.keyPath && value && Object.hasOwn(value, definition.keyPath)) return value[definition.keyPath];
      throw new Error('Key required');
    };
    const request = operation => {
      const result = {};
      transaction._begin();
      transaction._schedule(() => {
        if (transaction.error) { transaction._end(); return; }
        try {
          result.result = operation();
          result.onsuccess?.({ target: result });
        } catch (error) {
          result.error = error;
          result.onerror?.({ target: result });
          transaction.error = error;
          transaction.abort();
        } finally {
          transaction._end();
        }
      });
      return result;
    };
    const cursorRequest = entriesFactory => {
      const result = {};
      transaction._begin();
      let entries;
      let index = 0;
      const dispatch = () => transaction._schedule(() => {
        try {
          entries ??= entriesFactory();
          if (index >= entries.length) {
            result.result = null;
            result.onsuccess?.({ target: result });
            transaction._end();
            return;
          }
          const [key, value, primaryKey = key] = entries[index];
          let continued = false;
          result.result = {
            key,
            primaryKey,
            value: cloneValue(value),
            continue() {
              throwSynchronousFailure('cursor.continue');
              if (continued) throw new Error('Cursor already continued');
              continued = true;
              index += 1;
              dispatch();
            },
            continuePrimaryKey(targetKey, targetPrimaryKey) {
              throwSynchronousFailure('cursor.continuePrimaryKey');
              if (continued) throw new Error('Cursor already continued');
              continued = true;
              index = entries.findIndex((entry, candidateIndex) => candidateIndex > index &&
                (String(entry[0]).localeCompare(String(targetKey)) > 0 ||
                  (String(entry[0]) === String(targetKey) &&
                    String(entry[2] ?? entry[0]).localeCompare(String(targetPrimaryKey)) >= 0)));
              if (index < 0) index = entries.length;
              dispatch();
            },
            delete() { definition.records.delete(primaryKey); },
          };
          result.onsuccess?.({ target: result });
          if (!continued) transaction._end();
        } catch (error) {
          result.error = error;
          result.onerror?.({ target: result });
          transaction._end();
        }
      });
      dispatch();
      return result;
    };
    return {
      keyPath: definition.keyPath,
      indexNames: { contains: indexName => definition.indexes.has(indexName) },
      createIndex(indexName, keyPath, indexOptions = {}) {
        throwSynchronousFailure('store.createIndex');
        definition.indexes.set(indexName, { keyPath, unique: indexOptions.unique === true });
        return this.index(indexName);
      },
      index(indexName) {
        if (transaction.mode !== 'versionchange') throwSynchronousFailure('index');
        const indexDefinition = definition.indexes.get(indexName);
        if (!indexDefinition) throw new Error(`Unknown index ${indexName}`);
        return {
          count(range) {
            throwSynchronousFailure('index.count');
            return request(() => [...definition.records.values()]
              .filter(value => range?.upper === undefined || value?.[indexDefinition.keyPath] <= range.upper).length);
          },
          openCursor(range) {
            throwSynchronousFailure('index.openCursor');
            return cursorRequest(() => [...definition.records.entries()]
              .filter(([, value]) => range?.upper === undefined || value?.[indexDefinition.keyPath] <= range.upper)
              .map(([primaryKey, value]) => [value?.[indexDefinition.keyPath], value, primaryKey])
              .sort((a, b) => String(a[0]).localeCompare(String(b[0])) || String(a[2]).localeCompare(String(b[2]))));
          },
        };
      },
      put(value, explicitKey) {
        throwSynchronousFailure('store.put');
        const key = keyFor(value, explicitKey);
        return request(() => {
          if (options.failWrites) throw options.writeError ?? new Error('QuotaExceededError');
          definition.records.set(key, cloneValue(value));
          return key;
        });
      },
      delete(key) {
        throwSynchronousFailure('store.delete');
        return request(() => {
          if (options.failWrites) throw options.writeError ?? new Error('AbortError');
          return definition.records.delete(key);
        });
      },
      clear() {
        throwSynchronousFailure('store.clear');
        return request(() => {
          if (options.failWrites) throw options.writeError ?? new Error('AbortError');
          return definition.records.clear();
        });
      },
      get(key) {
        throwSynchronousFailure('store.get');
        return request(() => {
          if (options.failReads) throw options.readError ?? new Error('UnknownError');
          return cloneValue(definition.records.get(key));
        });
      },
      getAllKeys() {
        throwSynchronousFailure('store.getAllKeys');
        return request(() => {
          if (options.failReads) throw options.readError ?? new Error('UnknownError');
          return [...definition.records.keys()];
        });
      },
      openCursor() {
        throwSynchronousFailure('store.openCursor');
        return cursorRequest(() => [...definition.records.entries()]);
      },
    };
  };

  const fake = {
    createdStores: [],
    createdIndexes: [],
    transactionModes: [],
    transactionStores: [],
    openCalls: 0,
    abortCalls: 0,
    database: null,
    versions: [],
    IDBKeyRange: {
      upperBound(upper) {
        throwSynchronousFailure('keyRange.upperBound');
        return { upper };
      },
    },
    failNext(boundary, count = 1) { syncFailures[boundary] = count; },
    inspectStore(name) {
      const store = stores.get(name);
      return store ? new Map([...store.records].map(([key, value]) => [key, cloneValue(value)])) : undefined;
    },
    inspectIndexes(name) {
      const store = stores.get(name);
      return store ? new Map([...store.indexes].map(([key, value]) => [key, { ...value }])) : undefined;
    },
    open(_name, requestedVersion) {
      fake.openCalls += 1;
      fake.versions.push(requestedVersion);
      throwSynchronousFailure('open');
      const request = {};
      queueMicrotask(() => {
        if (options.blocked) { request.onblocked?.(); return; }
        const db = {
          version: requestedVersion,
          closed: false,
          close() { this.closed = true; },
          objectStoreNames: { contains: name => stores.has(name) },
          createObjectStore(name, createOptions = {}) {
            if (stores.has(name)) throw new Error(`Store ${name} already exists`);
            stores.set(name, { keyPath: createOptions.keyPath, records: new Map(), indexes: new Map() });
            fake.createdStores.push(name);
            return createStoreFacade(name, request.transaction);
          },
          transaction(storeNames, mode) {
            throwSynchronousFailure('transaction');
            fake.transactionModes.push(mode);
            fake.transactionStores.push(Array.isArray(storeNames) ? [...storeNames] : [storeNames]);
            if (mode !== 'readwrite') return createTransaction(storeNames, mode);
            const transaction = createTransaction(storeNames, mode, false);
            const release = () => {
              writeActive = false;
              const next = writeQueue.shift();
              if (next) {
                writeActive = true;
                next._activate();
              }
            };
            transaction._whenDone(release);
            if (writeActive) writeQueue.push(transaction);
            else {
              writeActive = true;
              transaction._activate();
            }
            return transaction;
          },
        };
        fake.database = db;
        request.result = db;
        const oldVersion = databaseVersion;
        if ((requestedVersion ?? 1) > databaseVersion) {
          request.transaction = createTransaction([...stores.keys(), 'audits', 'audit-retention'].filter((value, index, all) => all.indexOf(value) === index), 'versionchange');
          const originalObjectStore = request.transaction.objectStore;
          request.transaction.objectStore = name => createStoreFacade(name, request.transaction);
          request.onupgradeneeded?.({ oldVersion, newVersion: requestedVersion });
          databaseVersion = requestedVersion;
          request.transaction._whenDone(() => {
            if (request.transaction.error) request.onerror?.();
            else {
              databaseVersion = requestedVersion;
              request.onsuccess?.();
            }
          });
        } else request.onsuccess?.();
      });
      return request;
    },
  };
  return fake;
}
