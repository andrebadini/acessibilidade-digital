import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakeIndexedDb } from '../support/fake-indexeddb.js';

import { createBatchProgressStoreV1 } from '../../src/background/batch-progress-store.js';
import { createAuditModel } from '../../src/core/report/audit-model.js';
import { SAMPLE_AUDIT } from '../../fixtures/audits/sample-audit.js';

const STARTED_AT = '2026-08-26T14:00:00.000Z';

function clone(value) {
  return structuredClone(value);
}

function childModel(auditId, pageId) {
  const model = clone(SAMPLE_AUDIT);
  model.auditId = `${auditId}:${pageId}`;
  return createAuditModel(model);
}

function childCheckpoint(auditId, pageId) {
  return {
    version: 1,
    auditId: `${auditId}:${pageId}`,
    pages: [{
      pageId: 'page-1',
      attempted: true,
      startedAt: STARTED_AT,
      rulesVersion: '1.0.0',
      inventoryVersion: '1.0.0',
      inventoryHash: 'a'.repeat(64),
      outcomes: [],
    }],
  };
}

function draft(auditId, pageId, expectedCompletedCount) {
  return {
    auditId,
    pageId,
    childAuditId: `${auditId}:${pageId}`,
    model: childModel(auditId, pageId),
    failure: null,
    checkpoint: childCheckpoint(auditId, pageId),
    expectedCompletedCount,
  };
}

function preObservationFailureDraft(auditId, pageId, expectedCompletedCount) {
  return {
    auditId,
    pageId,
    childAuditId: `${auditId}:${pageId}`,
    model: null,
    failure: {
      version: 1,
      kind: 'pre-observation-failure',
      attempted: true,
      startedAt: STARTED_AT,
      endedAt: '2026-08-26T14:00:01.000Z',
      urlEvidence: {
        version: 'EvidenceUrlV1',
        href: 'https://example.test/',
        queryIncluded: false,
        redactedSegments: 0,
      },
    },
    checkpoint: childCheckpoint(auditId, pageId),
    expectedCompletedCount,
  };
}

test('persists a hidden draft, completes it by revision CAS, and rehydrates it in a fresh store instance', async () => {
  const indexedDB = createFakeIndexedDb();
  const auditId = 'batch-progress-persist';
  const first = createBatchProgressStoreV1({ indexedDB, databaseName: 'progress-persist' });

  const written = await first.writeDraft(draft(auditId, 'page-1', 0));
  assert.equal(written.revision, 1);
  assert.equal(written.page.state, 'draft');
  assert.deepEqual((await first.readCompleted({ auditId })).pages, []);

  const completed = await first.markCompleted({ auditId, pageId: 'page-1', expectedRevision: 1 });
  assert.equal(completed.revision, 2);
  assert.equal(completed.page.state, 'completed');

  const recovered = createBatchProgressStoreV1({ indexedDB, databaseName: 'progress-persist' });
  const snapshot = await recovered.readCompleted({ auditId });
  assert.equal(snapshot.revision, 2);
  assert.deepEqual(snapshot.pages.map(page => [page.pageId, page.childAuditId, page.state]), [
    ['page-1', `${auditId}:page-1`, 'completed'],
  ]);
  assert.equal(snapshot.pages[0].model.auditId, `${auditId}:page-1`);
  assert.equal(snapshot.pages[0].checkpoint.auditId, `${auditId}:page-1`);
  assert.equal(Object.isFrozen(snapshot.pages[0].model), true);
});

test('appends only the next ordered page after the prior page is completed', async () => {
  const store = createBatchProgressStoreV1({ indexedDB: createFakeIndexedDb(), databaseName: 'progress-order' });
  const auditId = 'batch-progress-order';

  const one = await store.writeDraft(draft(auditId, 'page-1', 0));
  await assert.rejects(() => store.writeDraft(draft(auditId, 'page-2', 0)), /BATCH_PROGRESS_WRITE_DENIED/u);
  await store.markCompleted({ auditId, pageId: 'page-1', expectedRevision: one.revision });
  await assert.rejects(() => store.writeDraft(draft(auditId, 'page-3', 1)), /BATCH_PROGRESS_WRITE_DENIED/u);

  const two = await store.writeDraft(draft(auditId, 'page-2', 1));
  await store.markCompleted({ auditId, pageId: 'page-2', expectedRevision: two.revision });
  assert.deepEqual((await store.readCompleted({ auditId })).pages.map(page => page.pageId), ['page-1', 'page-2']);
});

test('persists and rehydrates a factual pre-observation failure without inventing a child model', async () => {
  const store = createBatchProgressStoreV1({
    indexedDB: createFakeIndexedDb(), databaseName: 'progress-pre-observation',
  });
  const auditId = 'batch-progress-pre-observation';

  const written = await store.writeDraft(preObservationFailureDraft(auditId, 'page-1', 0));
  await store.markCompleted({ auditId, pageId: 'page-1', expectedRevision: written.revision });

  const recovered = await store.readCompleted({ auditId });
  assert.equal(recovered.pages[0].model, null);
  assert.deepEqual(recovered.pages[0].failure, {
    version: 1,
    kind: 'pre-observation-failure',
    attempted: true,
    startedAt: STARTED_AT,
    endedAt: '2026-08-26T14:00:01.000Z',
    urlEvidence: {
      version: 'EvidenceUrlV1',
      href: 'https://example.test/',
      queryIncluded: false,
      redactedSegments: 0,
    },
  });
});

test('rejects a null model with results, secret URL, mismatched time or both outcomes', async () => {
  const store = createBatchProgressStoreV1({ indexedDB: createFakeIndexedDb(), databaseName: 'progress-invalid-failure' });
  const auditId = 'batch-invalid-failure';
  const cases = [
    value => { value.checkpoint.pages[0].outcomes = [{ ruleId: 'focus-order', outcome: 'passed' }]; },
    value => { value.failure.urlEvidence.href += '?token=PRIVATE'; },
    value => { value.failure.startedAt = '2026-08-26T13:00:00.000Z'; },
    value => { value.model = childModel(auditId, 'page-1'); },
    value => { value.failure.rawUrl = 'https://secret.test/'; },
  ];
  for (const mutate of cases) {
    const value = preObservationFailureDraft(auditId, 'page-1', 0);
    mutate(value);
    await assert.rejects(() => store.writeDraft(value), /^Error: BATCH_PROGRESS_WRITE_DENIED$/u);
    assert.equal(await store.readCompleted({ auditId }), null);
  }
});

test('serializes competing writers so only one expected completed-count CAS can commit', async () => {
  const indexedDB = createFakeIndexedDb();
  const auditId = 'batch-progress-cas';
  const left = createBatchProgressStoreV1({ indexedDB, databaseName: 'progress-cas' });
  const right = createBatchProgressStoreV1({ indexedDB, databaseName: 'progress-cas' });

  const outcomes = await Promise.allSettled([
    left.writeDraft(draft(auditId, 'page-1', 0)),
    right.writeDraft(draft(auditId, 'page-1', 0)),
  ]);
  assert.equal(outcomes.filter(value => value.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter(value => value.status === 'rejected').length, 1);
  assert.match(outcomes.find(value => value.status === 'rejected').reason.message, /BATCH_PROGRESS_WRITE_DENIED/u);
});

test('rejects accessor, extra-key, and symbol inputs before opening or mutating a record', async () => {
  const indexedDB = createFakeIndexedDb();
  const store = createBatchProgressStoreV1({ indexedDB, databaseName: 'progress-descriptors' });
  const auditId = 'batch-progress-descriptors';
  let getterCalls = 0;
  const accessor = draft(auditId, 'page-1', 0);
  Object.defineProperty(accessor, 'model', {
    enumerable: true,
    get() { getterCalls += 1; return childModel(auditId, 'page-1'); },
  });
  await assert.rejects(() => store.writeDraft(accessor), /BATCH_PROGRESS_WRITE_DENIED/u);
  assert.equal(getterCalls, 0);

  await assert.rejects(() => store.writeDraft({ ...draft(auditId, 'page-1', 0), rawUrl: 'https://secret.test/' }),
    /BATCH_PROGRESS_WRITE_DENIED/u);
  const symbolInput = draft(auditId, 'page-1', 0);
  symbolInput[Symbol('secret')] = 'private';
  await assert.rejects(() => store.writeDraft(symbolInput), /BATCH_PROGRESS_WRITE_DENIED/u);
  assert.equal(await store.readCompleted({ auditId }), null);
});

test('rejects uncorrelated child models and checkpoints without replacing valid progress', async () => {
  const store = createBatchProgressStoreV1({ indexedDB: createFakeIndexedDb(), databaseName: 'progress-correlation' });
  const auditId = 'batch-progress-correlation';
  const wrongModel = draft(auditId, 'page-1', 0);
  wrongModel.model = childModel('foreign-batch', 'page-1');
  await assert.rejects(() => store.writeDraft(wrongModel), /BATCH_PROGRESS_WRITE_DENIED/u);

  const wrongCheckpoint = draft(auditId, 'page-1', 0);
  wrongCheckpoint.checkpoint.auditId = auditId;
  await assert.rejects(() => store.writeDraft(wrongCheckpoint), /BATCH_PROGRESS_WRITE_DENIED/u);

  const written = await store.writeDraft(draft(auditId, 'page-1', 0));
  const replacement = draft(auditId, 'page-1', 0);
  await assert.rejects(() => store.writeDraft(replacement), /BATCH_PROGRESS_WRITE_DENIED/u);
  assert.equal((await store.markCompleted({ auditId, pageId: 'page-1', expectedRevision: written.revision })).revision, 2);
});

test('fails closed when a stored aggregate is malformed', async () => {
  const indexedDB = createFakeIndexedDb();
  const databaseName = 'progress-malformed';
  const auditId = 'batch-progress-malformed';
  const store = createBatchProgressStoreV1({ indexedDB, databaseName });
  const written = await store.writeDraft(draft(auditId, 'page-1', 0));
  indexedDB.replace(databaseName, 'batch-progress-v1', auditId, {
    ...indexedDB.inspect(databaseName, 'batch-progress-v1', auditId),
    revision: written.revision,
    rawUrl: 'https://secret.test/',
  });

  await assert.rejects(() => store.readCompleted({ auditId }), /BATCH_PROGRESS_READ_DENIED/u);
  await assert.rejects(() => store.markCompleted({ auditId, pageId: 'page-1', expectedRevision: 1 }),
    /BATCH_PROGRESS_COMPLETE_DENIED/u);
  await assert.rejects(() => store.clearAudit({ auditId }), /BATCH_PROGRESS_CLEAR_DENIED/u);
});

test('clears only a fully completed audit and confirms absence by readback', async () => {
  const indexedDB = createFakeIndexedDb();
  const store = createBatchProgressStoreV1({ indexedDB, databaseName: 'progress-clear' });
  const auditId = 'batch-progress-clear';
  const written = await store.writeDraft(draft(auditId, 'page-1', 0));
  await assert.rejects(() => store.clearAudit({ auditId }), /BATCH_PROGRESS_CLEAR_DENIED/u);
  await store.markCompleted({ auditId, pageId: 'page-1', expectedRevision: written.revision });

  assert.deepEqual(await store.clearAudit({ auditId }), { auditId, cleared: true });
  assert.equal(await store.readCompleted({ auditId }), null);
  assert.deepEqual(await store.clearAudit({ auditId }), { auditId, cleared: true });
});

test('terminal discard removes completed and draft evidence only for the correlated audit', async () => {
  const indexedDB = createFakeIndexedDb();
  const store = createBatchProgressStoreV1({ indexedDB, databaseName: 'progress-discard' });
  const auditId = 'batch-discard';
  const foreignId = 'batch-foreign';
  const first = await store.writeDraft(draft(auditId, 'page-1', 0));
  await store.markCompleted({ auditId, pageId: 'page-1', expectedRevision: first.revision });
  await store.writeDraft(draft(auditId, 'page-2', 1));
  await store.writeDraft(draft(foreignId, 'page-1', 0));

  assert.deepEqual(await store.discardAudit({ auditId }), { auditId, discarded: true });
  assert.equal(indexedDB.inspect('progress-discard', 'batch-progress-v1', auditId), undefined);
  assert.equal(await store.readCompleted({ auditId }), null);
  assert.equal(indexedDB.inspect('progress-discard', 'batch-progress-v1', foreignId).pages.length, 1);
  assert.deepEqual(await store.discardAudit({ auditId }), { auditId, discarded: true });
});

test('terminal discard refuses uncorrelated or malformed records and closed input violations', async () => {
  const indexedDB = createFakeIndexedDb();
  const store = createBatchProgressStoreV1({ indexedDB, databaseName: 'progress-discard-invalid' });
  const auditId = 'batch-discard-invalid';
  await store.writeDraft(draft(auditId, 'page-1', 0));
  await assert.rejects(() => store.discardAudit({ auditId, extra: true }), /BATCH_PROGRESS_DISCARD_DENIED/u);
  const stored = indexedDB.inspect('progress-discard-invalid', 'batch-progress-v1', auditId);
  indexedDB.replace('progress-discard-invalid', 'batch-progress-v1', auditId, { ...stored, auditId: 'foreign' });
  await assert.rejects(() => store.discardAudit({ auditId }), /BATCH_PROGRESS_DISCARD_DENIED/u);
  assert.equal(indexedDB.inspect('progress-discard-invalid', 'batch-progress-v1', auditId).auditId, 'foreign');
});
