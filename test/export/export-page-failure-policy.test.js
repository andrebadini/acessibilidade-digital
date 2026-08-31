import assert from 'node:assert/strict';
import test from 'node:test';

const CLEANUP_PENDING = 'AUDIT_DOWNLOAD_CLEANUP_PENDING';

async function policyModule() {
  return import('../../src/export/export-page-failure-policy.js').catch(() => ({}));
}

test('export-page failure policy preserves the tab and lease for own or inherited cleanup-pending data codes', async () => {
  const { shouldPreserveExportTabAndLease } = await policyModule();
  assert.equal(typeof shouldPreserveExportTabAndLease, 'function');

  const own = new Error('cleanup pending');
  Object.defineProperty(own, 'code', { value: CLEANUP_PENDING });
  class InheritedCleanupPendingError extends Error {}
  Object.defineProperty(InheritedCleanupPendingError.prototype, 'code', { value: CLEANUP_PENDING });

  assert.equal(shouldPreserveExportTabAndLease(own), true);
  assert.equal(shouldPreserveExportTabAndLease(new InheritedCleanupPendingError('cleanup pending')), true);
  assert.equal(shouldPreserveExportTabAndLease({ code: 'AUDIT_EXPORT_RESERVATION_PENDING' }), true);
});

test('export-page failure policy never invokes code accessors or accepts a shadowed or unrelated code', async () => {
  const { shouldPreserveExportTabAndLease } = await policyModule();
  assert.equal(typeof shouldPreserveExportTabAndLease, 'function');
  let reads = 0;
  const inherited = Object.defineProperty({}, 'code', { value: CLEANUP_PENDING });
  const shadowed = Object.create(inherited);
  Object.defineProperty(shadowed, 'code', {
    get() { reads += 1; return CLEANUP_PENDING; },
  });
  const accessorOnly = Object.create(Object.defineProperty({}, 'code', {
    get() { reads += 1; return CLEANUP_PENDING; },
  }));
  const dataShadow = Object.create(inherited);
  Object.defineProperty(dataShadow, 'code', { value: 'AUDIT_EXPORT_LEASE_CONFLICT' });

  assert.equal(shouldPreserveExportTabAndLease(shadowed), false);
  assert.equal(shouldPreserveExportTabAndLease(accessorOnly), false);
  assert.equal(shouldPreserveExportTabAndLease(dataShadow), false);
  assert.equal(shouldPreserveExportTabAndLease({ code: 'AUDIT_EXPORT_LEASE_CONFLICT' }), false);
  assert.equal(shouldPreserveExportTabAndLease(null), false);
  assert.equal(reads, 0);
});

test('pending cleanup recovery waits for a pre-ID owner but reconciles an exact ID-backed journal', async () => {
  const { advancePendingExportCleanup } = await policyModule();
  assert.equal(typeof advancePendingExportCleanup, 'function');
  let reconciliations = 0;

  assert.equal(await advancePendingExportCleanup({
    async readJournal() { return [{ state: 'starting', format: 'html', filename: 'report.html' }]; },
    async reconcile() { reconciliations += 1; },
  }), 'waiting');
  assert.equal(reconciliations, 0, 'a public pre-ID row is owned only by its still-live late callback');

  assert.equal(await advancePendingExportCleanup({
    async readJournal() {
      return [{ state: 'cleanup-failed', format: 'html', filename: 'report.html', downloadId: 77 }];
    },
    async reconcile(entries) { reconciliations += 1; assert.equal(entries[0].downloadId, 77); },
  }), 'waiting');
  assert.equal(reconciliations, 1);
  assert.equal(await advancePendingExportCleanup({
    async readJournal() { return []; },
    async reconcile() { reconciliations += 1; },
  }), 'resolved');
  assert.equal(reconciliations, 1);
});

test('pending cleanup recovery contains hostile or failed probes and never invokes downloadId accessors', async () => {
  const { advancePendingExportCleanup } = await policyModule();
  let reads = 0;
  let reconciliations = 0;
  const hostile = { state: 'starting' };
  Object.defineProperty(hostile, 'downloadId', {
    enumerable: true,
    get() { reads += 1; throw new Error('PRIVATE_DOWNLOAD_ID'); },
  });

  assert.equal(await advancePendingExportCleanup({
    async readJournal() { return [hostile]; },
    async reconcile() { reconciliations += 1; },
  }), 'waiting');
  assert.equal(await advancePendingExportCleanup({
    async readJournal() { throw new Error('PRIVATE_STORAGE'); },
    async reconcile() { reconciliations += 1; },
  }), 'waiting');
  assert.equal(reads, 0);
  assert.equal(reconciliations, 0);
});

test('pending cleanup recovery bounds storage and reconciliation probes so the live tab can keep retrying', async () => {
  const { advancePendingExportCleanup } = await policyModule();
  assert.equal(typeof advancePendingExportCleanup, 'function');

  const never = new Promise(() => {});
  const storageProbe = Promise.race([
    advancePendingExportCleanup({
      readJournal() { return never; },
      async reconcile() {},
    }, { timeoutMs: 5 }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('storage probe remained unbounded')), 200)),
  ]);
  assert.equal(await storageProbe, 'waiting');

  const reconciliationProbe = Promise.race([
    advancePendingExportCleanup({
      async readJournal() {
        return [{ state: 'cleanup-failed', format: 'html', filename: 'report.html', downloadId: 77 }];
      },
      reconcile() { return never; },
    }, { timeoutMs: 5 }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('reconciliation remained unbounded')), 200)),
  ]);
  assert.equal(await reconciliationProbe, 'waiting');
});
