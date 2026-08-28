import assert from 'node:assert/strict';
import test from 'node:test';

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
    '__audit_retention_cleanup__',
  ]) assert.equal(isPrivateAuditKey(key), true);
  assert.equal(isPrivateAuditKey('batch-audit-1'), false);
});
