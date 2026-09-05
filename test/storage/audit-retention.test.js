import assert from 'node:assert/strict';
import test from 'node:test';
import * as retention from '../../src/storage/audit-retention.js';

import {
  RETENTION_MS,
  createRetentionMetadata,
  migrateRetentionMetadata,
  isPrivateAuditKey,
  validateRetentionMetadata,
} from '../../src/storage/audit-retention.js';

test('retention metadata expires exactly 30 days after the first durable commit', () => {
  const metadata = createRetentionMetadata('batch-audit-1', '2026-08-01T12:34:56.789Z', true);

  assert.equal(RETENTION_MS, 30 * 24 * 60 * 60 * 1000);
  assert.deepEqual(metadata, {
    auditId: 'batch-audit-1',
    schemaVersion: 1,
    firstPersistedAt: '2026-08-01T12:34:56.789Z',
    expiresAt: '2026-08-31T12:34:56.789Z',
    deleteAfterCompleteExport: true,
  });
});

test('retention metadata rejects non-canonical time and unexpected sensitive fields', () => {
  assert.throws(
    () => createRetentionMetadata('audit-1', '2026-08-01 12:34:56Z'),
    /instante|canônico|retenção/iu,
  );
  assert.throws(
    () => validateRetentionMetadata({
      auditId: 'audit-1', schemaVersion: 1,
      firstPersistedAt: '2026-08-01T00:00:00.000Z',
      expiresAt: '2026-08-31T00:00:00.000Z',
      deleteAfterCompleteExport: false,
      url: 'https://sensitive.invalid/',
    }, 'audit-1'),
    /metadado|propriedade/iu,
  );
});

test('v1 migration uses endedAt conservatively and invalid timestamps expire immediately', () => {
  assert.deepEqual(
    migrateRetentionMetadata('legacy-valid', { timestamps: { endedAt: '2026-01-02T03:04:05.006Z' } }),
    {
      auditId: 'legacy-valid', schemaVersion: 1,
      firstPersistedAt: '2026-01-02T03:04:05.006Z',
      expiresAt: '2026-02-01T03:04:05.006Z',
      deleteAfterCompleteExport: false,
    },
  );
  assert.deepEqual(
    migrateRetentionMetadata('legacy-invalid', { timestamps: { endedAt: 'not-a-date' } }),
    {
      auditId: 'legacy-invalid', schemaVersion: 1,
      firstPersistedAt: '1970-01-01T00:00:00.000Z',
      expiresAt: '1970-01-01T00:00:00.000Z',
      deleteAfterCompleteExport: false,
    },
  );
});

test('private audit keys never become retention records', () => {
  for (const key of [
    '__latest__',
    '__audit_revision__:audit-1',
    '__audit_export_lease__:audit-1',
    '__audit_export_attempt__:audit-1',
    '__audit_export_delivery__:audit-1',
    '__audit_checkpoint__:audit-1',
    '__audit_retention_cleanup__',
  ]) assert.equal(isPrivateAuditKey(key), true);
  assert.equal(isPrivateAuditKey('batch-audit-1'), false);
});

test('retention accepts only the shared bounded audit identifier grammar', () => {
  for (const auditId of [
    'https://legacy.invalid/a?ordinary_parameter=raw-query-value',
    'audit id with spaces',
    'audit/with/slashes',
    `audit-${'x'.repeat(200)}`,
  ]) {
    assert.throws(
      () => createRetentionMetadata(auditId, '2026-08-01T00:00:00.000Z'),
      /identificador|inválido/iu,
    );
  }

  assert.equal(
    createRetentionMetadata('Audit_2.release:2026-08-28', '2026-08-01T00:00:00.000Z').auditId,
    'Audit_2.release:2026-08-28',
  );
});

test('deletion tombstone contains only the durable cleanup identity and canonical retry state', () => {
  const record = retention.createDeletionTombstoneV1({ auditId: 'expired-audit', requestedAt: '2026-08-31T00:00:00.000Z' });
  assert.deepEqual(record, {
    version: 1, auditId: 'expired-audit', reason: 'retention-expired',
    requestedAt: '2026-08-31T00:00:00.000Z', phase: 'transient-cleanup-pending',
    attempts: 0, lastAttemptAt: null,
  });
  assert.equal(Object.isFrozen(record), true);
  assert.deepEqual(retention.validateDeletionTombstoneV1(record, 'expired-audit'), record);
});

test('deletion tombstone rejects foreign identity, private fields and inconsistent retry chronology', () => {
  const record = {
    version: 1, auditId: 'expired-audit', reason: 'retention-expired',
    requestedAt: '2026-08-31T00:00:00.000Z', phase: 'transient-cleanup-pending',
    attempts: 0, lastAttemptAt: null,
  };
  for (const patch of [
    { auditId: 'foreign-audit' }, { url: 'https://example.test/?token=PRIVATE' },
    { reason: 'manual' }, { phase: 'complete' }, { attempts: -1 },
    { attempts: 1 }, { lastAttemptAt: '2026-08-31T00:00:01.000Z' },
    { attempts: 1, lastAttemptAt: '2026-08-30T23:59:59.999Z' },
    { requestedAt: 'not-a-date' },
  ]) assert.throws(() => retention.validateDeletionTombstoneV1({ ...record, ...patch }, 'expired-audit'),
    error => error?.code === 'AUDIT_DELETION_DENIED' && !/PRIVATE|https:|token/u.test(error.message));
  let reads = 0;
  const accessor = { ...record };
  Object.defineProperty(accessor, 'auditId', { enumerable: true, get() { reads += 1; return 'expired-audit'; } });
  assert.throws(() => retention.validateDeletionTombstoneV1(accessor), { code: 'AUDIT_DELETION_DENIED' });
  assert.equal(reads, 0);
});
