import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { SAMPLE_AUDIT } from '../../fixtures/audits/sample-audit.js';
import { buildArtifactBaseName } from '../../src/browser/download-artifacts.js';
import { canonicalStringify } from '../../src/core/report/canonical-json.js';
import { renderOccurrenceCsv } from '../../src/core/report/csv.js';
import { renderTechnicalJson } from '../../src/core/report/earl-json.js';
import { renderHtmlReport } from '../../src/core/report/html.js';
import { verifyAuditIntegritySnapshot } from '../../src/core/report/integrity.js';
import {
  createExportFailureRequest,
  createExportSuccessRequest,
  persistExportFailure as persistOpaqueExportFailure,
  persistExportSuccess as persistOpaqueExportSuccess,
} from '../../src/export/export-controller.js';
import { runReportExport } from '../../src/export/report-export.js';
import { commitReviewDecision } from '../../src/review/review-state.js';
import { createInMemoryAuditStore } from '../../src/storage/audit-store.js';

const PDF = new TextEncoder().encode('%PDF-1.7\ncontroller-test');
const TEST_LEASE_OWNER = 'owner-test-export';

function revisionStore(store) {
  if (typeof store?.commitAuditIfRevisionWithExportLease === 'function') return store;
  if (typeof store?.commitAudit !== 'function') return store;
  const adapted = {
    ...store,
    commitAuditIfRevision(auditId, model, latest, snapshotCapability) {
      return store.commitAudit(auditId, model, latest, snapshotCapability);
    },
    commitAuditIfRevisionWithExportLease(auditId, model, latest, snapshotCapability) {
      return typeof store.commitAuditIfRevision === 'function'
        ? store.commitAuditIfRevision(auditId, model, latest, snapshotCapability)
        : store.commitAudit(auditId, model, latest, snapshotCapability);
    },
  };
  adapted.finalizeExportAndMaybeDelete = async (auditId, model, latest, snapshotCapability, options) => {
    const committed = await adapted.commitAuditIfRevisionWithExportLease(
      auditId, model, latest, snapshotCapability, options,
    );
    return { ...committed, deleted: false };
  };
  return adapted;
}

async function persistExportFailure(request, store) {
  const outer = safeTestRequest(request, ['auditId', 'model', 'latest', 'at'], ['auditId', 'model']);
  let model;
  try { model = JSON.parse(canonicalStringify(outer.model)); } catch {
    throw new TypeError('Solicitação de falha contém propriedade não segura ou esquema inválido.');
  }
  if (model?.auditId !== outer.auditId) throw new TypeError('Modelo e auditId não estão correlacionados.');
  const issuer = createInMemoryAuditStore();
  await issuer.setAudit(outer.auditId, model);
  const snapshot = await issuer.getAuditSnapshot(outer.auditId);
  return persistOpaqueExportFailure(createExportFailureRequest({
    snapshotCapability: snapshot.capability,
    leaseOwnerId: TEST_LEASE_OWNER,
    exportAttempt: 1,
    ...(Object.hasOwn(outer, 'latest') ? { latest: outer.latest } : {}),
    ...(Object.hasOwn(outer, 'at') ? { at: outer.at } : {}),
  }), revisionStore(store));
}

async function persistExportSuccess(request, store) {
  return persistOpaqueExportSuccess(createExportSuccessRequest(request), revisionStore(store));
}

function safeTestRequest(value, allowedKeys, requiredKeys) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError();
    const allowed = new Set(allowedKeys);
    const result = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string' || !allowed.has(key)) throw new TypeError();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new TypeError();
      result[key] = descriptor.value;
    }
    if (requiredKeys.some(key => !Object.hasOwn(result, key))) throw new TypeError();
    return result;
  } catch {
    throw new TypeError('Solicitação contém propriedade não segura ou esquema inválido.');
  }
}

test('atomically commits a controlled partial model and latest state for pre-result failure', async () => {
  const commits = [];
  const store = { async commitAudit(...values) { commits.push(values); } };
  const model = structuredClone(SAMPLE_AUDIT);
  model.limitations.push('TOPSECRET https://origin.test/?token=x blob:chrome-extension://test/private');
  const result = await persistExportFailure({
    auditId: SAMPLE_AUDIT.auditId,
    model,
    latest: { auditId: SAMPLE_AUDIT.auditId, status: 'partial', exportStatus: 'running' },
    at: '2026-08-26T16:00:00.000Z',
  }, store);
  assert.equal(commits.length, 1);
  assert.equal(commits[0][0], SAMPLE_AUDIT.auditId);
  assert.equal(commits[0][1].session.status, 'partial');
  assert.deepEqual(commits[0][1].report.artifact.formats, []);
  assert.equal(commits[0][2].exportStatus, 'failed');
  assert.deepEqual(result, { model: commits[0][1], latest: commits[0][2] });
  assert.doesNotMatch(JSON.stringify(commits), /TOPSECRET|origin\.test|blob:|chrome-extension:/iu);
});

test('rejects mismatched audit ID instead of committing another model', async () => {
  let committed = false;
  await assert.rejects(persistExportFailure({ auditId: 'audit-other', model: structuredClone(SAMPLE_AUDIT), latest: {}, at: '2026-08-26T16:00:00.000Z' }, { async commitAudit() { committed = true; } }), /correla|auditId|auditoria/iu);
  assert.equal(committed, false);
});

test('snapshots a failure request without repeatedly reading a hostile model accessor', async () => {
  const request = {
    auditId: SAMPLE_AUDIT.auditId,
    latest: {},
    at: '2026-08-26T16:00:00.000Z',
  };
  let modelReads = 0;
  Object.defineProperty(request, 'model', {
    enumerable: true,
    get() {
      modelReads += 1;
      const model = structuredClone(SAMPLE_AUDIT);
      if (modelReads > 1) model.auditId = 'audit-private-alternate';
      return model;
    },
  });
  let committed = false;

  await assert.rejects(
    persistExportFailure(request, { async commitAudit() { committed = true; } }),
    /solicitação|propriedade|segur|esquema/iu,
  );

  assert.equal(modelReads, 0);
  assert.equal(committed, false);
});

test('rejects nested failure-model accessors before structured cloning can invoke them', async () => {
  const model = structuredClone(SAMPLE_AUDIT);
  let nestedReads = 0;
  Object.defineProperty(model.occurrences[0], 'privateValue', {
    enumerable: true,
    get() {
      nestedReads += 1;
      return 'PRIVATE_NESTED_FAILURE_SENTINEL';
    },
  });
  let committed = false;

  await assert.rejects(
    persistExportFailure({
      auditId: model.auditId,
      model,
      latest: {},
      at: '2026-08-26T16:00:00.000Z',
    }, { async commitAudit() { committed = true; } }),
    /solicitação|propriedade|segur|esquema/iu,
  );

  assert.equal(nestedReads, 0);
  assert.equal(committed, false);
});

test('sanitizes a hostile failure-request proxy before persistence', async () => {
  let getTraps = 0;
  const proxy = new Proxy({
    auditId: SAMPLE_AUDIT.auditId,
    model: structuredClone(SAMPLE_AUDIT),
    latest: {},
    at: '2026-08-26T16:00:00.000Z',
  }, {
    get() {
      getTraps += 1;
      throw new Error('PRIVATE_FAILURE_PROXY_SENTINEL');
    },
  });
  let committed = false;

  await assert.rejects(
    persistOpaqueExportFailure(proxy, revisionStore({ async commitAudit() { committed = true; } })),
    error => error instanceof TypeError && !error.message.includes('PRIVATE_FAILURE_PROXY_SENTINEL'),
  );

  assert.equal(getTraps, 0);
  assert.equal(committed, false);

  const revocable = Proxy.revocable({
    auditId: SAMPLE_AUDIT.auditId,
    model: structuredClone(SAMPLE_AUDIT),
    latest: {},
    at: '2026-08-26T16:00:00.000Z',
  }, {});
  revocable.revoke();
  await assert.rejects(
    persistOpaqueExportFailure(revocable.proxy, revisionStore({ async commitAudit() { committed = true; } })),
    error => error instanceof TypeError && !/revoked|proxy/iu.test(error.message),
  );
  assert.equal(committed, false);
});

test('persists the initial failure latest snapshot despite mutation during finalization', async () => {
  const request = {
    auditId: SAMPLE_AUDIT.auditId,
    model: structuredClone(SAMPLE_AUDIT),
    latest: { auditId: SAMPLE_AUDIT.auditId, marker: 'initial' },
    at: '2026-08-26T16:00:00.000Z',
  };
  const commits = [];

  const pending = persistExportFailure(request, {
    async commitAudit(...values) { commits.push(values); },
  });
  request.latest = { auditId: SAMPLE_AUDIT.auditId, marker: 'PRIVATE_AFTER_CALL' };
  const persisted = await pending;

  assert.equal(persisted.latest.marker, 'initial');
  assert.equal(commits[0][2].marker, 'initial');
  assert.doesNotMatch(JSON.stringify(commits), /PRIVATE_AFTER_CALL/u);
});

test('atomically persists the exact serialized model and a separate delivery receipt', async () => {
  const commits = [];
  const result = await genuineReportExport({ csvDownloadTimeout: true });
  const persisted = await persistExportSuccess({ auditId: SAMPLE_AUDIT.auditId, result, latest: { auditId: SAMPLE_AUDIT.auditId, status: 'partial' } }, { async commitAudit(...values) { commits.push(values); } });
  assert.equal(commits.length, 1);
  assert.deepEqual(commits[0][1], JSON.parse(result.json).audit);
  assert.deepEqual(commits[0][2].deliveryReceipt, result.deliveryReceipt);
  assert.equal(persisted.latest.exportStatus, 'partial');
  assert.equal(Object.hasOwn(commits[0][1].report.artifact, 'deliveryReceipt'), false);
});

test('rejects forged evidence bytes even when manifest and canonical claims were recomputed', async () => {
  const model = generatedModel(['html', 'json', 'csv', 'pdf']);
  model.evidence[0].dataUrl = `data:image/png;base64,${Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x63,
  ]).toString('base64')}`;
  model.evidence[0].hash = 'b'.repeat(64);
  refreshDeclaredIntegrity(model);
  const receipt = {
    status: 'complete',
    formats: ['html', 'json', 'csv', 'pdf'].map((format, index) => receiptFormat(format, 'complete', index + 1)),
    limitations: [],
  };
  let committed = false;

  await assert.rejects(
    persistExportSuccess({
      auditId: model.auditId,
      result: await exportResult(model, receipt),
      latest: {},
    }, { async commitAudit() { committed = true; } }),
    /integridade|evidência|hash/iu,
  );

  assert.equal(committed, false);
});

test('rejects unavailable integrity in a final V2 export', async () => {
  const model = generatedModel(['html', 'json', 'csv', 'pdf']);
  model.integrity = { algorithm: 'unavailable', status: 'not-recorded-v1' };
  const receipt = {
    status: 'complete',
    formats: ['html', 'json', 'csv', 'pdf'].map((format, index) => receiptFormat(format, 'complete', index + 1)),
    limitations: [],
  };
  let committed = false;

  await assert.rejects(
    persistExportSuccess({
      auditId: model.auditId,
      result: await exportResult(model, receipt),
      latest: {},
    }, { async commitAudit() { committed = true; } }),
    /integridade|SHA-256|indisponível/iu,
  );

  assert.equal(committed, false);
});

test('persists only the initial success snapshot when the caller mutates its model later', async () => {
  const result = await genuineReportExport();
  const expected = structuredClone(result.model);
  const commits = [];

  const pending = persistExportSuccess({ auditId: result.model.auditId, result, latest: {} }, {
    async commitAudit(...values) { commits.push(values); },
  });
  const mutated = structuredClone(result.model);
  mutated.evidence[0].hash = 'c'.repeat(64);
  mutated.auditId = 'audit-mutated-after-call';
  result.model = mutated;
  const persisted = await pending;

  assert.deepEqual(persisted.model, expected);
  assert.deepEqual(commits[0][1], expected);
});

test('rejects forged PDF bytes and matching forged receipt hashes after a genuine final print', async () => {
  const result = await genuineReportExport();
  const forgedPdf = new TextEncoder().encode('%PDF-1.7\nPRIVATE_FORGED_PDF');
  const forgedHash = artifactHash(forgedPdf);
  result.pdf = forgedPdf;
  result.formats = result.formats.map(entry => entry.format === 'pdf' ? { ...entry, sha256: forgedHash } : entry);
  result.deliveryReceipt = {
    ...result.deliveryReceipt,
    formats: result.deliveryReceipt.formats.map(entry =>
      entry.format === 'pdf' ? { ...entry, sha256: forgedHash } : entry),
  };
  let committed = false;

  await assert.rejects(
    persistExportSuccess({ auditId: result.model.auditId, result, latest: {} }, {
      async commitAudit() { committed = true; },
    }),
    /proveniência|PDF|impressão|artefato|correla/iu,
  );

  assert.equal(committed, false);
});

test('accepts the untouched artifact set attested by genuine final report generation', async () => {
  const result = await genuineReportExport();
  const commits = [];

  const persisted = await persistExportSuccess({
    auditId: result.model.auditId,
    result,
    latest: {},
  }, { async commitAudit(...values) { commits.push(values); } });

  assert.equal(commits.length, 1);
  assert.deepEqual(commits[0][1], result.model);
  assert.equal(persisted.latest.exportStatus, 'complete');
});

test('successful persistence delegates deletion only to the atomic four-format finalizer', async () => {
  const result = await genuineReportExport();
  const calls = [];
  const store = {
    async commitAuditIfRevisionWithExportLease() {
      throw new Error('legacy finalizer must not be used for success');
    },
    async finalizeExportAndMaybeDelete(...args) {
      calls.push(args);
      return { deleted: true };
    },
  };

  const persisted = await persistOpaqueExportSuccess(createExportSuccessRequest({
    auditId: result.model.auditId,
    result,
    latest: {},
  }), store);

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], result.model.auditId);
  assert.equal(calls[0][4].clearDeliveryJournal, true);
  assert.equal(calls[0][4].deleteAfterCompleteExport, true);
  assert.equal(persisted.deleted, true);
  assert.equal(persisted.latest.exportStatus, 'complete');
});

test('passes the attested export attempt into atomic four-terminal finalization', async () => {
  const store = createInMemoryAuditStore();
  const result = await genuineReportExport({ store, persistentJournal: true });
  const pending = await store.getExportDeliveryJournal(result.model.auditId);
  assert.equal(pending.length, 4);
  assert.equal(pending.every(entry => entry.state === 'terminal'), true);

  const persisted = await persistOpaqueExportSuccess(createExportSuccessRequest({
    auditId: result.model.auditId,
    result,
    latest: {},
  }), store);

  assert.equal(persisted.latest.exportStatus, 'complete');
  assert.deepEqual(await store.getExportDeliveryJournal(result.model.auditId), []);
  assert.equal((await store.getExportLeaseState(result.model.auditId, {
    now: new Date().toISOString(),
  })).active, false);
});

test('keeps the attestation issuer private and rejects a substituted rehashed PDF without a caller reissue path', async () => {
  const controller = await import('../../src/export/export-controller.js');
  const provenance = await import('../../src/export/export-provenance.js');
  assert.equal(typeof controller.createExportSuccessRequest, 'function');
  assert.equal(provenance.attestReportExportResult, undefined);
  const store = createInMemoryAuditStore();
  const result = await genuineReportExport({ store });
  const forgedPdf = new TextEncoder().encode('%PDF-1.7\nPRIVATE_REATTEST_FORGED_PDF');
  const forgedHash = artifactHash(forgedPdf);
  result.pdf = forgedPdf;
  result.formats = result.formats.map(entry => entry.format === 'pdf' ? { ...entry, sha256: forgedHash } : entry);
  result.deliveryReceipt = {
    ...result.deliveryReceipt,
    formats: result.deliveryReceipt.formats.map(entry =>
      entry.format === 'pdf' ? { ...entry, sha256: forgedHash } : entry),
  };
  const request = controller.createExportSuccessRequest({
    auditId: result.model.auditId,
    result,
    latest: {},
  });

  await assert.rejects(
    controller.persistExportSuccess(request, store),
    /proveniência|atestado|geração|artefato/iu,
  );
  assert.doesNotMatch(JSON.stringify(await store.getAudit(result.model.auditId)), /PRIVATE_REATTEST_FORGED_PDF/u);
});

test('a review after delivery reservation is preserved and final receipt persistence cannot roll it back', async () => {
  const controller = await import('../../src/export/export-controller.js');
  assert.equal(typeof controller.createExportSuccessRequest, 'function');
  assert.equal(typeof controller.createExportFailureRequest, 'function');
  const reviewInput = auditId => ({
    auditId,
    itemId: '5.1.4',
    occurrenceId: 'occ-focus-review',
    answer: 'não foi possível determinar',
    evaluator: 'Pessoa avaliadora',
    decidedAt: '2026-08-26T16:10:00.000Z',
    mode: 'assisted',
  });

  for (const mode of ['success', 'failure']) {
    const store = createInMemoryAuditStore();
    const result = await genuineReportExport({ store });
    const before = await store.getAuditSnapshot(result.model.auditId);
    assert.equal(before.revision, 2);
    assert.equal((await store.getLatest()).exportStatus, 'delivering');
    const request = mode === 'success'
      ? controller.createExportSuccessRequest({
        auditId: result.model.auditId, result, latest: {},
      })
      : controller.createExportFailureRequest({
        snapshotCapability: before.capability,
        leaseOwnerId: TEST_LEASE_OWNER,
        exportAttempt: 1,
        latest: {},
        at: '2026-08-26T16:11:00.000Z',
      });
    await commitReviewDecision(result.model, reviewInput(result.model.auditId), store);

    await assert.rejects(
      mode === 'success'
        ? controller.persistExportSuccess(request, store)
        : controller.persistExportFailure(request, store),
      error => error?.code === 'AUDIT_REVISION_CONFLICT',
    );

    const after = await store.getAuditSnapshot(result.model.auditId);
    assert.equal(after.revision, before.revision + 1);
    assert.equal(after.model.reviewDecisions.length, 1);
    assert.equal(after.model.reviewDecisions[0].answer, 'não foi possível determinar');
    const latest = await store.getLatest();
    assert.equal(latest.exportStatus, 'preparing');
    assert.equal(latest.exportRevision, after.revision);
  }
});

test('a caller cannot preselect a future revision to roll a later human decision back', async () => {
  const controller = await import('../../src/export/export-controller.js');
  const staleModel = structuredClone(SAMPLE_AUDIT);
  const store = createInMemoryAuditStore();
  await store.setAudit(staleModel.auditId, staleModel);
  assert.throws(() => controller.createExportFailureRequest({
    snapshotCapability: {},
    leaseOwnerId: TEST_LEASE_OWNER,
    latest: {},
    expectedRevision: 2,
  }), /capacidade|snapshot|solicitação|esquema|inválid/iu);
  await commitReviewDecision(staleModel, {
    auditId: staleModel.auditId,
    itemId: '5.1.4',
    occurrenceId: 'occ-focus-review',
    answer: 'não foi possível determinar',
    evaluator: 'Pessoa avaliadora',
    decidedAt: '2026-08-26T16:01:00.000Z',
    mode: 'assisted',
  }, store);

  const after = await store.getAuditSnapshot(staleModel.auditId);
  assert.equal(after.revision, 2);
  assert.equal(after.model.reviewDecisions.length, 1);
});

test('only one concurrent success or failure export can commit one expected revision', async () => {
  const controller = await import('../../src/export/export-controller.js');
  const store = createInMemoryAuditStore();
  const result = await genuineReportExport({ store });
  const { revision, capability } = await store.getAuditSnapshot(result.model.auditId);
  const success = controller.createExportSuccessRequest({
    auditId: result.model.auditId, result, latest: {},
  });
  const failure = controller.createExportFailureRequest({
    snapshotCapability: capability,
    leaseOwnerId: TEST_LEASE_OWNER,
    exportAttempt: 1,
    latest: {},
    at: '2026-08-26T16:12:00.000Z',
  });

  const outcomes = await Promise.allSettled([
    controller.persistExportSuccess(success, store),
    controller.persistExportFailure(failure, store),
  ]);

  assert.equal(outcomes.filter(entry => entry.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter(entry => entry.status === 'rejected' && entry.reason?.code === 'AUDIT_REVISION_CONFLICT').length, 1);
  assert.equal((await store.getAuditSnapshot(result.model.auditId)).revision, revision + 1);
});

test('a stale failure cannot release a newer attempt that reused the same owner and revision', async () => {
  const controller = await import('../../src/export/export-controller.js');
  const store = createInMemoryAuditStore();
  await store.setAudit(SAMPLE_AUDIT.auditId, structuredClone(SAMPLE_AUDIT));
  const snapshot = await store.getAuditSnapshot(SAMPLE_AUDIT.auditId);
  const expiredAt = new Date(Date.now() - 60_000).toISOString();
  const currentAt = new Date().toISOString();
  const first = await store.acquireExportLease(SAMPLE_AUDIT.auditId, snapshot.capability, {
    ownerId: TEST_LEASE_OWNER,
    now: expiredAt,
    ttlMs: 1_000,
    latestState: { auditId: SAMPLE_AUDIT.auditId, exportStatus: 'queued' },
  });
  const staleFailure = controller.createExportFailureRequest({
    snapshotCapability: snapshot.capability,
    leaseOwnerId: TEST_LEASE_OWNER,
    exportAttempt: first.exportAttempt,
    latest: { auditId: SAMPLE_AUDIT.auditId, exportAttempt: first.exportAttempt },
    at: currentAt,
  });
  const current = await store.acquireExportLease(SAMPLE_AUDIT.auditId, snapshot.capability, {
    ownerId: TEST_LEASE_OWNER,
    now: currentAt,
    ttlMs: 10 * 60 * 1_000,
    latestState: { auditId: SAMPLE_AUDIT.auditId, exportStatus: 'queued' },
  });
  assert.notEqual(current.exportAttempt, first.exportAttempt);

  await assert.rejects(
    controller.persistExportFailure(staleFailure, store),
    error => error?.code === 'AUDIT_EXPORT_LEASE_CONFLICT',
  );
  const remaining = await store.getExportLeaseState(SAMPLE_AUDIT.auditId, { now: currentAt });
  assert.equal(remaining.active, true);
  assert.equal(remaining.exportAttempt, current.exportAttempt);
  assert.equal((await store.getAuditSnapshot(SAMPLE_AUDIT.auditId)).revision, snapshot.revision);
});

test('rejects a Proxy around an opaque persistence request before every meta-trap and without commit', async () => {
  const controller = await import('../../src/export/export-controller.js');
  assert.equal(typeof controller.createExportFailureRequest, 'function');
  const issuer = createInMemoryAuditStore();
  await issuer.setAudit(SAMPLE_AUDIT.auditId, structuredClone(SAMPLE_AUDIT));
  const snapshot = await issuer.getAuditSnapshot(SAMPLE_AUDIT.auditId);
  const request = controller.createExportFailureRequest({
    snapshotCapability: snapshot.capability,
    leaseOwnerId: TEST_LEASE_OWNER,
    exportAttempt: 1,
    latest: {},
    at: '2026-08-26T16:00:00.000Z',
  });
  let traps = 0;
  const proxy = new Proxy(request, {
    getPrototypeOf(target) { traps += 1; return Reflect.getPrototypeOf(target); },
    ownKeys(target) { traps += 1; return Reflect.ownKeys(target); },
    getOwnPropertyDescriptor(target, key) { traps += 1; return Reflect.getOwnPropertyDescriptor(target, key); },
    get(target, key, receiver) { traps += 1; return Reflect.get(target, key, receiver); },
  });
  let committed = false;

  await assert.rejects(
    controller.persistExportFailure(proxy, {
      async commitAuditIfRevision() { committed = true; },
    }),
    error => error instanceof TypeError && !error.message.includes('PRIVATE'),
  );

  assert.equal(traps, 0);
  assert.equal(committed, false);
});

test('requires correlated ordered unique receipt formats with exact MIME, filename, hash and status semantics', async () => {
  const model = generatedModel(['html', 'json', 'csv', 'pdf']);
  const baseReceipt = {
    status: 'complete',
    formats: [
      receiptFormat('html', 'complete', 1), receiptFormat('json', 'complete', 2),
      receiptFormat('csv', 'complete', 3), receiptFormat('pdf', 'complete', 4),
    ],
    limitations: [],
  };
  const attempts = [
    { ...baseReceipt, formats: [...baseReceipt.formats, receiptFormat('csv', 'complete', 5)] },
    { ...baseReceipt, formats: baseReceipt.formats.map((entry, index) => index === 2 ? { ...entry, format: 'xml' } : entry) },
    { ...baseReceipt, formats: baseReceipt.formats.map((entry, index) => index === 2 ? { ...entry, mimeType: 'text/plain' } : entry) },
    { ...baseReceipt, formats: baseReceipt.formats.map((entry, index) => index === 2 ? { ...entry, filename: 'audit.csv.exe' } : entry) },
    { ...baseReceipt, formats: baseReceipt.formats.map((entry, index) => index === 2 ? { ...entry, sha256: 'forged' } : entry) },
    { ...baseReceipt, formats: baseReceipt.formats.map(entry => ({ ...entry, filename: `other-base.${entry.format}` })) },
    { ...baseReceipt, formats: baseReceipt.formats.map(entry => ({ ...entry, downloadId: 7 })) },
    { ...baseReceipt, formats: [baseReceipt.formats[1], baseReceipt.formats[0], ...baseReceipt.formats.slice(2)] },
    { ...baseReceipt, status: 'partial' },
  ];
  for (const deliveryReceipt of attempts) {
    let committed = false;
    await assert.rejects(persistExportSuccess({
      auditId: model.auditId,
      result: await exportResult(model, deliveryReceipt),
      latest: {},
    }, { async commitAudit() { committed = true; } }), /recibo|formato|MIME|arquivo|hash|ordem|status|correla/iu);
    assert.equal(committed, false);
  }
});

test('requires the four-format model contract and exact generation evidence for omitted CSV or PDF', async () => {
  const invalidModels = [
    generatedModel(['html', 'json']),
    generatedModel(['json', 'csv', 'pdf']),
    generatedModel(['html', 'csv', 'pdf']),
    generatedModel(['html', 'json'], ['REPORT_CSV_UNAVAILABLE']),
    generatedModel(['html', 'json', 'pdf'], ['REPORT_PDF_UNAVAILABLE']),
    generatedModel(['html', 'json', 'csv'], ['REPORT_PRINT_CLEANUP_LIMITED']),
    generatedModel(['html', 'json', 'csv'], ['REPORT_PDF_TAGGING_UNSUPPORTED']),
  ];
  invalidModels.push(generatedModel(['html', 'json', 'pdf'], ['REPORT_CSV_UNAVAILABLE'], {
    artifactLimitations: ['Mensagem não canônica para o CSV.'],
  }));

  for (const model of invalidModels) {
    let committed = false;
    const formats = model.report.artifact.formats.map(entry => receiptFormat(entry.format, 'complete', 1));
    await assert.rejects(persistExportSuccess({
      auditId: model.auditId,
      result: await exportResult(model, { status: 'complete', formats, limitations: [] }),
      latest: {},
    }, { async commitAudit() { committed = true; } }), /formato|quatro|CSV|PDF|diagnóstico|limitação|parcial|relatório/iu);
    assert.equal(committed, false);
  }
});

test('accepts controlled CSV or PDF generation omissions only as partial exports', async () => {
  const cases = [
    { csvFailure: true },
    { pdfAssetsTimeout: true },
    { csvFailure: true, pdfFailure: true },
  ];

  for (const options of cases) {
    const result = await genuineReportExport(options);
    const persisted = await persistExportSuccess({
      auditId: result.model.auditId,
      result,
      latest: {},
    }, { async commitAudit() {} });
    assert.equal(persisted.latest.exportStatus, 'partial');
    assert.equal(persisted.latest.deliveryReceipt.status, 'partial');
  }
});

test('accepts one exact late print-cleanup limitation only in a partial delivery receipt', async () => {
  const result = await genuineReportExport({ printCleanupFailure: true });
  let committed = false;

  const persisted = await persistExportSuccess({
    auditId: result.model.auditId,
    result,
    latest: {},
  }, { async commitAudit() { committed = true; } });

  assert.equal(committed, true);
  assert.equal(persisted.latest.exportStatus, 'partial');
  assert.deepEqual(persisted.latest.deliveryReceipt, result.deliveryReceipt);
});

test('accepts a controlled fourth-artifact start failure as a partial export', async () => {
  const result = await genuineReportExport({ pdfDownloadStartFailure: true });
  assert.deepEqual(result.deliveryReceipt.formats.at(-1), {
    format: 'pdf',
    filename: result.deliveryReceipt.formats.at(-1).filename,
    mimeType: 'application/pdf',
    status: 'interrupted',
    sha256: result.deliveryReceipt.formats.at(-1).sha256,
    failureCode: 'DOWNLOAD_START_FAILED',
  });

  const persisted = await persistExportSuccess({
    auditId: result.model.auditId, result, latest: {},
  }, { async commitAudit() {} });
  assert.equal(persisted.latest.exportStatus, 'partial');
  assert.equal(persisted.latest.deliveryReceipt.status, 'partial');
});

test('rejects artifact payloads that are present despite controlled CSV or PDF omission', async () => {
  const missingCsv = generatedModel(['html', 'json', 'pdf'], ['REPORT_CSV_UNAVAILABLE']);
  const missingPdf = generatedModel(['html', 'json', 'csv'], ['REPORT_PDF_UNAVAILABLE']);
  for (const [model, format] of [[missingCsv, 'csv'], [missingPdf, 'pdf']]) {
    const formats = model.report.artifact.formats.map((entry, index) => receiptFormat(entry.format, 'complete', index + 1));
    const valid = await exportResult(model, {
      status: 'partial',
      formats,
      limitations: model.report.artifact.limitations,
    });
    const result = valid;
    if (format === 'csv') result.csv = '\uFEFF"private"\r\n"PRIVATE_SENTINEL"\r\n';
    else result.pdf = Uint8Array.from(PDF);
    let committed = false;
    await assert.rejects(persistExportSuccess({ auditId: model.auditId, result, latest: {} }, {
      async commitAudit() { committed = true; },
    }), /CSV|PDF|artefato|formato|correla|proveniência/iu);
    assert.equal(committed, false);
  }
});

test('rejects stale or bidirectionally inconsistent generation evidence and PDF fallback omissions', async () => {
  const staleCsv = generatedModel(['html', 'json', 'pdf'], ['REPORT_CSV_UNAVAILABLE']);
  staleCsv.session.diagnostics[0].at = '2026-08-26T15:59:59.999Z';
  const csvIssueWithCsv = generatedModel(['html', 'json', 'csv', 'pdf'], ['REPORT_CSV_UNAVAILABLE']);
  const missingFallbackPdf = generatedModel(['html', 'json', 'csv'], ['REPORT_PDF_UNAVAILABLE']);
  missingFallbackPdf.report.artifact.pdfFallback = true;
  const extraDiagnostic = generatedModel(['html', 'json', 'pdf'], ['REPORT_CSV_UNAVAILABLE']);
  extraDiagnostic.session.diagnostics[0].details = { note: 'PRIVATE_DIAGNOSTIC_SENTINEL' };
  const duplicateDiagnostic = generatedModel(['html', 'json', 'pdf'], ['REPORT_CSV_UNAVAILABLE']);
  duplicateDiagnostic.session.diagnostics.push(structuredClone(duplicateDiagnostic.session.diagnostics[0]));

  for (const model of [staleCsv, csvIssueWithCsv, missingFallbackPdf, extraDiagnostic, duplicateDiagnostic]) {
    const formats = model.report.artifact.formats.map((entry, index) => receiptFormat(entry.format, 'complete', index + 1));
    const missing = ['csv', 'pdf'].filter(format => !model.report.artifact.formats.some(entry => entry.format === format));
    const limitations = missing.map(format => format === 'csv'
      ? GENERATION_MESSAGES.REPORT_CSV_UNAVAILABLE
      : GENERATION_MESSAGES.REPORT_PDF_UNAVAILABLE);
    if (model === extraDiagnostic) {
      await assert.rejects(exportResult(model, { status: missing.length ? 'partial' : 'complete', formats, limitations }), error => {
        assert.equal(error.code, 'AUDIT_MODEL_INPUT_INVALID');
        assert.doesNotMatch(error.message, /PRIVATE_DIAGNOSTIC_SENTINEL/u);
        return true;
      });
      continue;
    }
    let committed = false;
    await assert.rejects(persistExportSuccess({
      auditId: model.auditId,
      result: await exportResult(model, { status: missing.length ? 'partial' : 'complete', formats, limitations }),
      latest: {},
    }, { async commitAudit() { committed = true; } }), /diagnóstico|geração|formato|PDF|CSV|fallback|correla/iu);
    assert.equal(committed, false);
  }
});

test('rejects unbacked artifact limitations and forged PDF fallback status in otherwise complete exports', async () => {
  const rawLimitation = generatedModel(['html', 'json', 'csv', 'pdf']);
  rawLimitation.report.artifact.limitations = ['token=PRIVATE_ARTIFACT_SENTINEL'];
  rawLimitation.limitations = ['token=PRIVATE_ARTIFACT_SENTINEL'];
  const forgedFallback = generatedModel(['html', 'json', 'csv', 'pdf']);
  forgedFallback.report.artifact.pdfFallback = true;
  const unsupportedWithoutFallback = generatedModel(
    ['html', 'json', 'csv', 'pdf'],
    ['REPORT_PDF_TAGGING_UNSUPPORTED'],
  );

  for (const model of [rawLimitation, forgedFallback, unsupportedWithoutFallback]) {
    const formats = model.report.artifact.formats.map((entry, index) => receiptFormat(entry.format, 'complete', index + 1));
    const result = await exportResult(model, { status: 'complete', formats, limitations: [] });
    let committed = false;
    await assert.rejects(persistExportSuccess({ auditId: model.auditId, result, latest: {} }, {
      async commitAudit() { committed = true; },
    }), /limitação|diagnóstico|fallback|status|PDF|correla/iu);
    assert.equal(committed, false);
  }
});

test('accepts PDF fallback only with one exact current tagging diagnostic and partial model status', async () => {
  const result = await genuineReportExport({ pdfFallback: true });

  const persisted = await persistExportSuccess({ auditId: result.model.auditId, result, latest: {} }, { async commitAudit() {} });

  assert.equal(persisted.latest.exportStatus, 'partial');
  assert.equal(persisted.model.report.artifact.pdfFallback, true);
});

test('rejects forged top-level artifact correlation and well-formed but wrong hashes', async () => {
  const model = generatedModel(['html', 'json', 'csv', 'pdf']);
  const receipt = {
    status: 'complete',
    formats: ['html', 'json', 'csv', 'pdf'].map((format, index) => receiptFormat(format, 'complete', index + 1)),
    limitations: [],
  };
  const valid = await exportResult(model, receipt);
  const wrongHashFormats = valid.formats.map((entry, index) => index === 0 ? { ...entry, sha256: 'b'.repeat(64) } : entry);
  const attempts = [
    { ...valid, formats: [] },
    { ...valid, pdfFallback: true },
    { ...valid, csv: null },
    { ...valid, formats: wrongHashFormats, deliveryReceipt: { ...valid.deliveryReceipt, formats: wrongHashFormats } },
  ];

  for (const attempt of attempts) {
    let committed = false;
    await assert.rejects(persistExportSuccess({
      auditId: model.auditId,
      result: attempt,
      latest: {},
    }, { async commitAudit() { committed = true; } }), /hash|formato|CSV|PDF|correla|resultado|artefato/iu);
    assert.equal(committed, false);
  }
});

test('preserves fixed artifact failure stage and rejects incompatible failure schemas or raw limitations', async () => {
  const model = generatedModel(['html', 'json', 'csv', 'pdf']);
  const blobFailure = {
    status: 'partial',
    formats: [
      receiptFormat('html', 'complete', 1),
      receiptFormat('json', 'complete', 2),
      { ...receiptFormat('csv', 'interrupted'), failureCode: 'ARTIFACT_BLOB_FAILED' },
      receiptFormat('pdf', 'complete', 4),
    ],
    limitations: ['O artefato CSV não pôde ser preparado para download.'],
  };
  const genuineBlobFailure = await genuineReportExport({ csvBlobFailure: true });
  const persisted = await persistExportSuccess({
    auditId: genuineBlobFailure.model.auditId,
    result: genuineBlobFailure,
    latest: {},
  }, { async commitAudit() {} });
  assert.equal(persisted.latest.deliveryReceipt.formats[2].failureCode, 'ARTIFACT_BLOB_FAILED');
  assert.deepEqual(persisted.latest.deliveryReceipt.limitations, blobFailure.limitations);

  const invalidReceipts = [
    { ...blobFailure, formats: blobFailure.formats.map((entry, index) => index === 2 ? receiptFormat('csv', 'interrupted') : entry) },
    { ...blobFailure, formats: blobFailure.formats.map((entry, index) => index === 2 ? { ...entry, failureCode: 'UNKNOWN_FAILURE' } : entry) },
    { ...blobFailure, formats: blobFailure.formats.map((entry, index) => index === 2 ? { ...entry, status: 'timeout' } : entry) },
    { ...blobFailure, formats: blobFailure.formats.map((entry, index) => index === 2 ? { ...entry, failureCode: 'DOWNLOAD_WAIT_TIMEOUT', status: 'timeout' } : entry) },
    { ...blobFailure, formats: blobFailure.formats.map((entry, index) => index === 2 ? { ...entry, failureCode: 'ARTIFACT_BYTES_INVALID', sha256: 'a'.repeat(64) } : entry) },
    { ...blobFailure, limitations: ['PRIVATE_SENTINEL https://origin.test/?token=x'] },
    {
      ...blobFailure,
      limitations: [
        ...blobFailure.limitations,
        'A liberação do endereço temporário do artefato CSV não pôde ser confirmada.',
      ],
    },
  ];
  for (const deliveryReceipt of invalidReceipts) {
    await assert.rejects(persistExportSuccess({
      auditId: model.auditId,
      result: await exportResult(model, deliveryReceipt),
      latest: {},
    }, { async commitAudit() {} }), /recibo|falha|etapa|hash|download|limitação|status|formato/iu);
  }
});

test('rejects an accessor or revoked delivery receipt without invoking private data', async () => {
  const model = generatedModel(['html', 'json', 'csv', 'pdf']);
  const valid = await exportResult(model, {
    status: 'complete',
    formats: ['html', 'json', 'csv', 'pdf'].map((format, index) => receiptFormat(format, 'complete', index + 1)),
    limitations: [],
  });
  let accessed = false;
  const hostile = {};
  Object.defineProperty(hostile, 'formats', {
    enumerable: true,
    get() { accessed = true; return [{ private: 'PRIVATE_SENTINEL' }]; },
  });
  valid.deliveryReceipt = hostile;
  await assert.rejects(persistExportSuccess({
    auditId: model.auditId,
    result: valid,
    latest: {},
  }, { async commitAudit() {} }), /recibo|segur|propriedade|JSON/iu);
  assert.equal(accessed, false);

  const { proxy, revoke } = Proxy.revocable({ status: 'complete', formats: [], limitations: [] }, {});
  revoke();
  valid.deliveryReceipt = proxy;
  await assert.rejects(persistExportSuccess({
    auditId: model.auditId,
    result: valid,
    latest: {},
  }, { async commitAudit() {} }), TypeError);
});

test('rejects hostile outer request and result accessors before invoking them', async () => {
  const model = generatedModel(['html', 'json', 'csv', 'pdf']);
  const deliveryReceipt = {
    status: 'complete',
    formats: ['html', 'json', 'csv', 'pdf'].map((format, index) => receiptFormat(format, 'complete', index + 1)),
    limitations: [],
  };
  const valid = await exportResult(model, deliveryReceipt);
  let resultGetterAccessed = false;
  const hostileResult = { ...valid };
  Object.defineProperty(hostileResult, 'json', {
    enumerable: true,
    get() { resultGetterAccessed = true; return renderTechnicalJson(model); },
  });
  let committed = false;
  await assert.rejects(persistExportSuccess({ auditId: model.auditId, result: hostileResult, latest: {} }, {
    async commitAudit() { committed = true; },
  }), /resultado|propriedade|segur|recibo/iu);
  assert.equal(resultGetterAccessed, false);
  assert.equal(committed, false);

  let requestGetterAccessed = false;
  const hostileRequest = { auditId: model.auditId, latest: {} };
  Object.defineProperty(hostileRequest, 'result', {
    enumerable: true,
    get() { requestGetterAccessed = true; return valid; },
  });
  await assert.rejects(persistExportSuccess(hostileRequest, { async commitAudit() { committed = true; } }), /solicitação|resultado|propriedade|segur/iu);
  assert.equal(requestGetterAccessed, false);
  assert.equal(committed, false);

  const { proxy, revoke } = Proxy.revocable(valid, {});
  revoke();
  await assert.rejects(persistExportSuccess({ auditId: model.auditId, result: proxy, latest: {} }, { async commitAudit() {} }), TypeError);

  const activeProxy = new Proxy(valid, {});
  await assert.rejects(persistExportSuccess({ auditId: model.auditId, result: activeProxy, latest: {} }, { async commitAudit() {} }), /resultado|propriedade|segur|proxy/iu);
});

test('rejects a technical JSON incompatible with the final model before persistence', async () => {
  const model = generatedModel(['html', 'json', 'csv', 'pdf']);
  const receipt = {
    status: 'complete',
    formats: ['html', 'json', 'csv', 'pdf'].map((format, index) => receiptFormat(format, 'complete', index + 1)),
    limitations: [],
  };
  const technical = JSON.parse(renderTechnicalJson(model));
  technical.audit.report.status = 'forged';
  const result = await exportResult(model, receipt);
  result.json = JSON.stringify(technical);
  let committed = false;
  await assert.rejects(persistExportSuccess({
    auditId: model.auditId,
    result,
    latest: {},
  }, { async commitAudit() { committed = true; } }), /correla/iu);
  assert.equal(committed, false);
});

function receiptFormat(format, status, downloadId) {
  const mimeType = {
    html: 'text/html;charset=utf-8', json: 'application/json;charset=utf-8',
    csv: 'text/csv;charset=utf-8', pdf: 'application/pdf',
  }[format];
  return {
    format,
    filename: `audit.${format}`,
    mimeType,
    status,
    ...(downloadId === undefined ? {} : { downloadId }),
    sha256: 'a'.repeat(64),
  };
}

async function exportResult(model, deliveryReceipt, overrides = {}) {
  if (model.integrity?.algorithm === 'SHA-256') refreshDeclaredIntegrity(model);
  let renderModel = model;
  try { renderModel = await verifyAuditIntegritySnapshot(model); } catch {}
  const html = renderHtmlReport(renderModel);
  const json = renderTechnicalJson(renderModel);
  const prepared = renderModel.report.artifact.formats.map(entry => entry.format);
  let csv = null;
  if (prepared.includes('csv')) {
    try { csv = renderOccurrenceCsv(renderModel); } catch {}
  }
  const pdf = prepared.includes('pdf') ? Uint8Array.from(PDF) : null;
  const artifacts = { html, json, csv, pdf };
  const baseName = buildArtifactBaseName(renderModel.finalUrl, renderModel.timestamps.generatedAt);
  const normalizedFormats = deliveryReceipt.formats.map(entry => ({
    ...entry,
    ...(entry.filename === `audit.${entry.format}` ? { filename: `${baseName}.${entry.format}` } : {}),
    ...(entry.sha256 === 'a'.repeat(64) && artifacts[entry.format] !== null && artifacts[entry.format] !== undefined
      ? { sha256: artifactHash(artifacts[entry.format]) }
      : {}),
  }));
  const receipt = { ...deliveryReceipt, formats: normalizedFormats };
  const result = {
    model: structuredClone(renderModel),
    html,
    json,
    csv,
    pdf,
    formats: structuredClone(normalizedFormats),
    deliveryReceipt: receipt,
    limitations: [...new Set([...renderModel.report.artifact.limitations, ...receipt.limitations])],
    pdfFallback: renderModel.report.artifact.pdfFallback,
    ...overrides,
  };
  const issued = await genuineReportExport();
  Object.assign(issued, result);
  return issued;
}

function artifactHash(value) {
  return createHash('sha256').update(typeof value === 'string' ? new TextEncoder().encode(value) : value).digest('hex');
}

const REPORT_HASH_BASE =
  'SHA-256 do JSON canônico com integrity.canonicalModelHash omitido; evidenceManifestHash permanece incluído.';

function evidenceArtifactHash(artifact) {
  const content = structuredClone(artifact);
  delete content.hash;
  const prefix = 'data:image/png;base64,';
  const isPng = typeof content.dataUrl === 'string' && content.dataUrl.startsWith(prefix);
  const bytes = isPng ? Uint8Array.from(Buffer.from(content.dataUrl.slice(prefix.length), 'base64')) : null;
  if (bytes && content.kind === 'full-page') return artifactHash(bytes);
  if (bytes) {
    content.binarySha256 = artifactHash(bytes);
    delete content.dataUrl;
  }
  return artifactHash(canonicalStringify(content));
}

function evidenceManifest(model) {
  return model.evidence.map(artifact => ({
    evidenceId: artifact.evidenceId,
    pageId: artifact.pageId,
    kind: artifact.kind,
    nodeId: artifact.nodeId ?? null,
    hash: artifact.hash ?? null,
    fullPageEvidenceId: artifact.fullPageEvidenceId ?? null,
  }));
}

function refreshDeclaredIntegrity(model) {
  model.integrity = {
    algorithm: 'SHA-256',
    evidenceManifestHash: artifactHash(canonicalStringify(evidenceManifest(model))),
    hashBase: REPORT_HASH_BASE,
    canonicalModelHash: 'pending',
  };
  const hashInput = structuredClone(model);
  delete hashInput.integrity.canonicalModelHash;
  model.integrity.canonicalModelHash = artifactHash(canonicalStringify(hashInput));
  return model;
}

function refreshIntegrity(model) {
  for (const artifact of model.evidence) artifact.hash = evidenceArtifactHash(artifact);
  return refreshDeclaredIntegrity(model);
}

async function genuineReportExport(options = {}) {
  let downloadId = 0;
  let artifactUrl = 0;
  const issuer = options.store ?? createInMemoryAuditStore();
  if (!await issuer.getAudit(SAMPLE_AUDIT.auditId)) {
    await issuer.setAudit(SAMPLE_AUDIT.auditId, structuredClone(SAMPLE_AUDIT));
  }
  const snapshot = await issuer.getAuditSnapshot(SAMPLE_AUDIT.auditId);
  const leaseOwnerId = options.leaseOwnerId ?? TEST_LEASE_OWNER;
  const leaseNow = new Date().toISOString();
  const acquired = await issuer.acquireExportLease(SAMPLE_AUDIT.auditId, snapshot.capability, {
    ownerId: leaseOwnerId,
    now: leaseNow,
    ttlMs: 10 * 60 * 1000,
    latestState: { auditId: SAMPLE_AUDIT.auditId, exportStatus: 'queued', exportRevision: snapshot.revision },
  });
  await issuer.claimExportLease(SAMPLE_AUDIT.auditId, snapshot.capability, {
    ownerId: leaseOwnerId,
    now: new Date().toISOString(),
    ttlMs: 10 * 60 * 1000,
    latestState: { auditId: SAMPLE_AUDIT.auditId, exportStatus: 'running', exportRevision: snapshot.revision },
  });
  return runReportExport({
    auditSnapshotCapability: snapshot.capability,
    exportLeaseOwnerId: leaseOwnerId,
    exportAttempt: acquired.exportAttempt,
    now: () => '2026-08-26T16:00:00.000Z',
  }, {
    urlApi: {
      createObjectURL() { return 'blob:chrome-extension://test/print'; },
      revokeObjectURL() {},
    },
    tabAdapter: {
      async createPrintTab() { return { id: 77 }; },
      async waitForReady() {},
      async connectCdp() { return { async disconnect() {} }; },
      async waitForAssets() {
        if (options.pdfAssetsTimeout) throw new DOMException('timeout', 'TimeoutError');
      },
      async removeTab() {
        if (options.printCleanupFailure) throw new Error('cleanup');
      },
    },
    csvRenderer: options.csvFailure ? () => { throw new Error('csv'); } : undefined,
    async pdfRenderer() {
      if (options.pdfFailure) throw new Error('pdf');
      return { bytes: Uint8Array.from(PDF), usedFallback: options.pdfFallback === true, limitations: [] };
    },
    downloadsAdapter: {
      createObjectURL() {
        artifactUrl += 1;
        if (options.csvBlobFailure && artifactUrl === 3) throw new Error('blob');
        return `blob:chrome-extension://test/download-${artifactUrl}`;
      },
      revokeObjectURL() {},
      async download() {
        downloadId += 1;
        if (options.pdfDownloadStartFailure && downloadId === 4) throw new Error('controlled start failure');
        return downloadId;
      },
      async cancelDownload() {},
      async removeDownloadFile() {},
      async waitForDownload(id) {
        if (options.csvDownloadTimeout && id === 3) throw new DOMException('timeout', 'TimeoutError');
        return { id, state: 'complete' };
      },
    },
    reserveDelivery({ model }) {
      return issuer.commitAuditIfRevisionWithExportLease(
        SAMPLE_AUDIT.auditId,
        model,
        { auditId: SAMPLE_AUDIT.auditId, exportStatus: 'delivering' },
        snapshot.capability,
        {
          ownerId: leaseOwnerId,
          now: new Date().toISOString(),
          ttlMs: 10 * 60 * 1000,
          phase: 'delivering',
        },
      );
    },
    assertDelivery({ snapshotCapability, exportLeaseOwnerId }) {
      return issuer.assertExportLease(SAMPLE_AUDIT.auditId, snapshotCapability, {
        ownerId: exportLeaseOwnerId,
        now: new Date().toISOString(),
        phase: 'delivering',
      });
    },
    recordDelivery({ snapshotCapability, exportLeaseOwnerId, state, format, filename, downloadId }) {
      if (options.persistentJournal !== true) return undefined;
      return issuer.recordExportDelivery(SAMPLE_AUDIT.auditId, snapshotCapability, {
        ownerId: exportLeaseOwnerId,
        exportAttempt: acquired.exportAttempt,
        now: new Date().toISOString(),
        state,
        format,
        filename,
        ...(downloadId === undefined ? {} : { downloadId }),
      });
    },
  });
}

const GENERATION_MESSAGES = Object.freeze({
  REPORT_CSV_UNAVAILABLE: 'O CSV não foi gerado devido a uma limitação técnica local.',
  REPORT_PDF_UNAVAILABLE: 'O PDF não foi gerado devido a uma limitação técnica local.',
  REPORT_PRINT_ASSETS_TIMEOUT: 'A preparação local de fontes e imagens excedeu o tempo limite.',
  REPORT_PRINT_CLEANUP_LIMITED: 'A limpeza de um recurso temporário de impressão não pôde ser confirmada.',
  REPORT_PDF_TAGGING_UNSUPPORTED: 'O PDF foi gerado sem marcação estrutural adicional e sem outline porque o navegador não aceitou esses parâmetros.',
});

function generatedModel(formats, issueCodes = [], options = {}) {
  const model = structuredClone(SAMPLE_AUDIT);
  model.timestamps.generatedAt = '2026-08-26T16:00:00.000Z';
  for (const page of model.pages) page.timestamps.generatedAt = '2026-08-26T16:00:00.000Z';
  const messages = issueCodes.map(code => GENERATION_MESSAGES[code]);
  model.session.status = issueCodes.length ? 'partial' : 'complete';
  model.session.partial = issueCodes.length > 0;
  model.session.diagnostics = issueCodes.map(code => ({
    code,
    message: GENERATION_MESSAGES[code],
    at: '2026-08-26T16:00:00.000Z',
    recoverable: true,
  }));
  model.limitations = [...messages];
  model.report = {
    status: issueCodes.length ? 'partial' : 'complete',
    reviewUrl: null,
    artifact: {
      status: issueCodes.length ? 'partial' : 'complete',
      pdfFallback: false,
      limitations: options.artifactLimitations ?? messages,
      formats: formats.map(format => ({ format, status: 'prepared' })),
    },
  };
  return refreshIntegrity(model);
}
