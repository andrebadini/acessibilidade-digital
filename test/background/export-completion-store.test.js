import assert from 'node:assert/strict';
import test from 'node:test';

import { createExportCompletionStore } from '../../src/background/export-completion-store.js';

const AUDIT_ID = 'audit-completion-store';
const ATTEMPT_ID = '3';
const MODEL_REVISION = 7;

const MIME = Object.freeze({
  html: 'text/html;charset=utf-8',
  pdf: 'application/pdf',
  csv: 'text/csv;charset=utf-8',
  json: 'application/json;charset=utf-8',
});

function receipt(status = 'complete') {
  const names = status === 'complete' ? ['html', 'pdf', 'csv', 'json'] : ['html', 'json'];
  return {
    version: 1,
    auditId: AUDIT_ID,
    modelRevision: MODEL_REVISION,
    modelHash: 'a'.repeat(64),
    attemptId: ATTEMPT_ID,
    status,
    formats: names.map((format, index) => ({
      format,
      mimeType: MIME[format],
      byteSize: 100 + index,
      sha256: String(index + 1).repeat(64),
      downloadId: 40 + index,
      state: 'complete',
    })),
  };
}

function terminalProof(receiptStatus = 'complete') {
  return {
    version: 1,
    auditId: AUDIT_ID,
    sessionCapabilityId: 'S'.repeat(22),
    attemptId: ATTEMPT_ID,
    modelRevision: MODEL_REVISION,
    receiptStatus,
    applied: false,
    deleted: false,
    status: null,
    notified: false,
  };
}

function fixture({
  durableReceipt = receipt(),
  retention = false,
  snapshot = { model: { auditId: AUDIT_ID }, revision: MODEL_REVISION + 1, capability: Object.freeze({ proof: 'snapshot' }) },
  deleteCompletedAudit,
} = {}) {
  const calls = [];
  const auditStore = {
    async getExportReceipt(auditId) {
      calls.push(['getExportReceipt', auditId]);
      return structuredClone(durableReceipt);
    },
    async getAuditRetention(auditId) {
      calls.push(['getAuditRetention', auditId]);
      return {
        auditId,
        schemaVersion: 1,
        firstPersistedAt: '2026-08-01T00:00:00.000Z',
        expiresAt: '2026-08-31T00:00:00.000Z',
        deleteAfterCompleteExport: retention,
      };
    },
    async getAuditSnapshot(auditId) {
      calls.push(['getAuditSnapshot', auditId]);
      return snapshot;
    },
    async deleteAudit() { throw new Error('the low-level store must never delete from export completion'); },
  };
  const store = createExportCompletionStore({
    auditStore,
    async emitTerminal(event) { calls.push(['emitTerminal', event]); },
    ...(deleteCompletedAudit ? {
      async deleteCompletedAudit(request) {
        calls.push(['deleteCompletedAudit', request]);
        return deleteCompletedAudit(request);
      },
    } : {}),
  });
  return { store, calls, snapshot };
}

test('a partial receipt is acknowledged without applying complete-export deletion', async () => {
  const partial = receipt('partial');
  const input = fixture({ durableReceipt: partial, retention: true });

  const result = await input.store.completeExport(AUDIT_ID, {
    attemptId: ATTEMPT_ID,
    receipt: partial,
    terminalProof: terminalProof('partial'),
  });

  assert.deepEqual(result, { completed: true, deleted: false, status: 'partial' });
  assert.deepEqual(input.calls.map(([name]) => name), ['getExportReceipt']);
});

test('a complete receipt is retained when deletion was not requested', async () => {
  const input = fixture({ retention: false });

  const result = await input.store.completeExport(AUDIT_ID, {
    attemptId: ATTEMPT_ID,
    receipt: receipt(),
    terminalProof: terminalProof(),
  });

  assert.deepEqual(result, { completed: true, deleted: false, status: 'complete' });
  assert.deepEqual(input.calls.map(([name]) => name), ['getExportReceipt', 'getAuditRetention']);
});

test('a complete receipt applies deferred deletion to the exact finalized revision', async () => {
  const input = fixture({
    retention: true,
    async deleteCompletedAudit() { return { ok: true, auditId: AUDIT_ID, deleted: true }; },
  });

  const result = await input.store.completeExport(AUDIT_ID, {
    attemptId: ATTEMPT_ID,
    receipt: receipt(),
    terminalProof: terminalProof(),
  });

  assert.deepEqual(result, { completed: true, deleted: true, status: 'complete' });
  assert.deepEqual(input.calls, [
    ['getExportReceipt', AUDIT_ID],
    ['getAuditRetention', AUDIT_ID],
    ['deleteCompletedAudit', {
      auditId: AUDIT_ID,
      expectedRevision: MODEL_REVISION + 1,
      attemptId: ATTEMPT_ID,
      terminalReceipt: receipt(),
    }],
  ]);
});

test('a newer human-review revision reported by the deletion coordinator is preserved', async () => {
  const input = fixture({
    retention: true,
    async deleteCompletedAudit() { return { ok: false, code: 'AUDIT_REVISION_CONFLICT' }; },
  });

  const result = await input.store.completeExport(AUDIT_ID, {
    attemptId: ATTEMPT_ID,
    receipt: receipt(),
    terminalProof: terminalProof(),
  });

  assert.deepEqual(result, { completed: true, deleted: false, status: 'complete' });
  assert.equal(input.calls.some(([name]) => name === 'deleteCompletedAudit'), true);
});

test('a deletion preference cannot bypass the audit-scoped coordinator', async () => {
  const input = fixture({ retention: true });

  const result = await input.store.completeExport(AUDIT_ID, {
    attemptId: ATTEMPT_ID,
    receipt: receipt(),
    terminalProof: terminalProof(),
  });

  assert.deepEqual(result, { completed: true, deleted: false, status: 'complete' });
  assert.deepEqual(input.calls.map(([name]) => name), ['getExportReceipt', 'getAuditRetention']);
});

test('a lost response after deletion is recovered from the authenticated pending proof', async () => {
  const input = fixture({
    durableReceipt: null,
    retention: true,
    snapshot: { model: undefined, revision: 0, capability: null },
  });

  const result = await input.store.completeExport(AUDIT_ID, {
    attemptId: ATTEMPT_ID,
    terminalProof: terminalProof(),
  });

  assert.deepEqual(result, { completed: true, deleted: true, status: 'complete' });
  assert.deepEqual(input.calls.map(([name]) => name), ['getExportReceipt', 'getAuditSnapshot']);
});

test('a partial replay cannot claim success after its durable receipt disappears', async () => {
  const input = fixture({
    durableReceipt: null,
    snapshot: { model: undefined, revision: 0, capability: null },
  });

  await assert.rejects(
    input.store.completeExport(AUDIT_ID, {
      attemptId: ATTEMPT_ID,
      terminalProof: terminalProof('partial'),
    }),
    error => error?.message === 'EXPORT_RECEIPT_DENIED',
  );
});

test('a forged or stale receipt cannot authorize terminal completion', async () => {
  const input = fixture();
  const forged = receipt();
  forged.modelHash = 'b'.repeat(64);

  await assert.rejects(
    input.store.completeExport(AUDIT_ID, {
      attemptId: ATTEMPT_ID,
      receipt: forged,
      terminalProof: terminalProof(),
    }),
    error => error?.message === 'EXPORT_RECEIPT_DENIED',
  );
  assert.equal(input.calls.some(([name]) => name === 'deleteAudit'), false);
});

test('a retention deletion race preserves the audit and completes the receipt acknowledgement', async () => {
  const input = fixture({
    retention: true,
    async deleteCompletedAudit() { return { ok: false, code: 'AUDIT_DELETE_BUSY' }; },
  });

  const result = await input.store.completeExport(AUDIT_ID, {
    attemptId: ATTEMPT_ID,
    receipt: receipt(),
    terminalProof: terminalProof(),
  });

  assert.deepEqual(result, { completed: true, deleted: false, status: 'complete' });
});

test('unexpected storage failures remain retryable and do not become a false acknowledgement', async () => {
  const input = fixture({
    retention: true,
    async deleteCompletedAudit() { throw new Error('private storage detail'); },
  });

  await assert.rejects(
    input.store.completeExport(AUDIT_ID, {
      attemptId: ATTEMPT_ID,
      receipt: receipt(),
      terminalProof: terminalProof(),
    }),
    /private storage detail/u,
  );
});

test('terminal events are delegated without changing their authenticated payload', async () => {
  const input = fixture();
  const event = Object.freeze({
    type: 'EXPORT_COMPLETE', auditId: AUDIT_ID, deleted: false, status: 'partial', exportRevision: MODEL_REVISION + 1,
  });

  await input.store.emitTerminal(event);

  assert.deepEqual(input.calls, [['emitTerminal', event]]);
});
