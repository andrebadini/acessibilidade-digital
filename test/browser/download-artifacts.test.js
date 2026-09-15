import assert from 'node:assert/strict';
import test from 'node:test';

import {
  advancePendingDownloadOwnership,
  buildArtifactBaseName,
  createDownloadsAdapter,
  downloadArtifacts,
  reconcileStaleDownloads,
} from '../../src/browser/download-artifacts.js';
import { SAMPLE_AUDIT } from '../../fixtures/audits/sample-audit.js';
import { createInMemoryAuditStore } from '../../src/storage/audit-store.js';

const FAST_SHA256 = () => '0'.repeat(64);
const ATTEST_REQUESTED_FILENAME = (_downloadId, { requestedFilename }) => requestedFilename;

test('builds public artifact names only from the audit id projection and canonical UTC', () => {
  assert.equal(buildArtifactBaseName('audit-1', '2026-08-29T12:00:00.123Z'), 'audita-audit-1-20260829T120000123Z');
  assert.equal(buildArtifactBaseName('audit:cliente-1', '2026-08-26T14:00:00.000Z'), 'audita-audit_3acliente-1-20260826T140000000Z');
  assert.notEqual(
    buildArtifactBaseName('audit:cliente-1', '2026-08-26T14:00:00.000Z'),
    buildArtifactBaseName('audit-cliente-1', '2026-08-26T14:00:00.000Z'),
  );
  assert.notEqual(
    buildArtifactBaseName('audit:_3a', '2026-08-26T14:00:00.000Z'),
    buildArtifactBaseName('audit::', '2026-08-26T14:00:00.000Z'),
  );
  assert.throws(() => buildArtifactBaseName('https://example.test/', '2026-08-26T14:00:00.000Z'), /Auditoria inválida/u);
  assert.throws(() => buildArtifactBaseName('audit-1', '2026-08-26'), /Timestamp/u);
});

test('accepts every canonical audit id character without exposing a delivery owner or attempt', async () => {
  const auditId = `._${'a'.repeat(157)}:`;
  const base = buildArtifactBaseName(auditId, '2026-08-26T14:00:00.000Z');
  assert.equal(base.length <= 240, true);
  assert.match(base, /^audita-\._/u);
  assert.doesNotMatch(base, /delivery|export|attempt/iu);
  await assert.doesNotReject(() => downloadArtifacts({ baseName: base }, {
    createObjectURL() {}, revokeObjectURL() {}, download() {}, waitForDownload() {},
  }));
});

test('projects every 200-character canonical audit id injectively into a portable filename', () => {
  const timestamp = '2026-08-26T14:00:00.000Z';
  const longId = ':'.repeat(200);
  const formerFallbackCollision = ':'.repeat(101);
  const longBase = buildArtifactBaseName(longId, timestamp);
  const oldFallbackLiteral = `id64-${btoa(':'.repeat(101)).replace(/=+$/u, '')}`;

  assert.equal(`${longBase}.html`.length <= 255, true);
  assert.match(longBase, /^audita-[A-Za-z0-9._-]+-20260826T140000000Z$/u);
  assert.notEqual(
    buildArtifactBaseName(formerFallbackCollision, timestamp),
    buildArtifactBaseName(oldFallbackLiteral, timestamp),
  );
});

test('rejects non-existent canonical instants instead of normalizing their calendar date', () => {
  assert.throws(
    () => buildArtifactBaseName('audit-1', '2026-02-30T12:00:00.000Z'),
    /Timestamp do relatório inválido/u,
  );
});

test('downloads large payloads only through Blob URLs and revokes them after terminal states', async () => {
  const events = [];
  let nextId = 10;
  const adapter = {
    createObjectURL(blob) { const url = `blob:chrome-extension://test/${events.length}`; events.push(['create', url, blob.type, blob.size]); return url; },
    revokeObjectURL(url) { events.push(['revoke', url]); },
    async download(options) { events.push(['download', options]); return nextId++; },
    async waitForDownload(id) { events.push(['terminal', id]); return { id, state: 'complete' }; },
  };
  const result = await downloadArtifacts({
    baseName: 'example-test-20260826T140000000Z',
    html: `<!doctype html>${'x'.repeat(2_000_000)}`,
    json: '{"schemaVersion":1}',
    csv: '\uFEFF"occurrence_id"\r\n"occ-1"\r\n',
    pdf: new TextEncoder().encode('%PDF-1.7\nreport'),
  }, adapter, { timeoutMs: 50 });
  assert.equal(result.formats.length, 4);
  assert.deepEqual(result.formats.map(item => item.status), ['complete', 'complete', 'complete', 'complete']);
  assert.deepEqual(result.formats.map(item => item.downloadId), [10, 11, 12, 13]);
  assert.deepEqual(result.formats.map(item => item.filename), [
    'example-test-20260826T140000000Z.html', 'example-test-20260826T140000000Z.pdf',
    'example-test-20260826T140000000Z.csv', 'example-test-20260826T140000000Z.json',
  ]);
  assert.deepEqual(result.formats.map(item => item.mimeType), [
    'text/html;charset=utf-8', 'application/pdf', 'text/csv;charset=utf-8', 'application/json;charset=utf-8',
  ]);
  assert.ok(result.formats.every(item => /^[a-f0-9]{64}$/u.test(item.sha256)));
  for (const event of events.filter(item => item[0] === 'download')) {
    assert.match(event[1].url, /^blob:chrome-extension:\/\/test\//u);
    assert.doesNotMatch(event[1].url, /^data:/u);
    assert.equal(event[1].conflictAction, 'uniquify');
    assert.equal(event[1].saveAs, false);
  }
  for (const [index, event] of events.entries()) {
    if (event[0] !== 'revoke') continue;
    assert.ok(events.slice(0, index).some(value => value[0] === 'terminal'));
  }
  assert.deepEqual(result.limitations, []);
  assert.doesNotMatch(JSON.stringify(result), /blob:/u);
});

test('journals and receipts the exact Chrome-uniquified basename attested by download id', async () => {
  const journal = [];
  const adapter = {
    createObjectURL() { return 'blob:chrome-extension://test/uniquified'; },
    revokeObjectURL() {},
    async download() { return 42; },
    async resolveDownloadFilename(downloadId, context) {
      assert.deepEqual([downloadId, context], [42, { requestedFilename: 'audit.html', format: 'html' }]);
      return 'audit (1).html';
    },
    async waitForDownload(downloadId) { return { id: downloadId, state: 'complete' }; },
  };

  const result = await downloadArtifacts({ baseName: 'audit', html: '<!doctype html>' }, adapter, {
    hashBytes: FAST_SHA256,
    async recordDeliveryState(entry) { journal.push(entry); return true; },
  });

  assert.deepEqual(journal, [
    { state: 'starting', format: 'html', filename: 'audit.html' },
    { state: 'in-flight', format: 'html', filename: 'audit.html', downloadId: 42 },
    { state: 'identified', format: 'html', requestedFilename: 'audit.html', filename: 'audit (1).html', downloadId: 42 },
    { state: 'terminal', format: 'html', filename: 'audit (1).html', downloadId: 42,
      mimeType: 'text/html;charset=utf-8', byteSize: 15, sha256: '0'.repeat(64) },
  ]);
  assert.equal(result.formats[0].filename, 'audit (1).html');
});

test('compensates a starting journal write that commits only after its timeout', { timeout: 500 }, async () => {
  let journal = null;
  let physicalStarts = 0;
  const states = [];
  const result = downloadArtifacts({ baseName: 'audit-late-starting', html: '<!doctype html>' }, {
    createObjectURL() { return 'blob:chrome-extension://test/late-starting'; },
    revokeObjectURL() {},
    async download() { physicalStarts += 1; return 91; },
    async waitForDownload() { return { id: 91, state: 'complete' }; },
    resolveDownloadFilename: ATTEST_REQUESTED_FILENAME,
  }, {
    timeoutMs: 10,
    hashBytes: FAST_SHA256,
    async recordDeliveryState(entry) {
      states.push(entry.state);
      if (entry.state === 'starting') {
        await new Promise(resolve => setTimeout(resolve, 15));
        journal = { ...entry };
        return journal;
      }
      if (entry.state === 'cleaned') {
        const matched = journal?.format === entry.format && journal?.filename === entry.filename;
        if (matched) journal = null;
        return matched;
      }
      return false;
    },
  });

  await assert.rejects(result, error => error?.name === 'TimeoutError');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(physicalStarts, 0);
  assert.equal(journal, null, 'a late pre-download row must be compensatingly removed');
  assert.deepEqual(states.slice(0, 2), ['starting', 'cleaned']);
});

test('fails closed when persistent cleanup does not acknowledge the exact row', async () => {
  let physicalStarts = 0;
  await assert.rejects(downloadArtifacts({ baseName: 'audit-cleanup-ack', html: '<!doctype html>' }, {
    createObjectURL() { return 'blob:chrome-extension://test/cleanup-ack'; },
    revokeObjectURL() {},
    async download() { physicalStarts += 1; return 92; },
    async waitForDownload() { return { id: 92, state: 'complete' }; },
    resolveDownloadFilename: ATTEST_REQUESTED_FILENAME,
  }, {
    timeoutMs: 20,
    hashBytes: FAST_SHA256,
    async assertCanDownload({ stage }) {
      if (stage === 'before-physical-start') {
        throw Object.assign(new Error('revoked'), { code: 'AUDIT_REVISION_CONFLICT' });
      }
    },
    async recordDeliveryState(entry) {
      return entry.state === 'starting' ? { ...entry } : false;
    },
  }), error => error?.code === 'AUDIT_DOWNLOAD_CLEANUP_PENDING');
  assert.equal(physicalStarts, 0);
});

test('never reports a rejected physical start while its starting row lacks a durable cleanup acknowledgement', async () => {
  const states = [];
  await assert.rejects(downloadArtifacts({ baseName: 'audit-start-rejected', html: '<!doctype html>' }, {
    createObjectURL() { return 'blob:chrome-extension://test/start-rejected'; },
    revokeObjectURL() {},
    async download() { throw new Error('downloads denied'); },
    async waitForDownload() { throw new Error('download must not be observed'); },
    resolveDownloadFilename: ATTEST_REQUESTED_FILENAME,
  }, {
    timeoutMs: 20,
    hashBytes: FAST_SHA256,
    async recordDeliveryState(entry) {
      states.push(entry.state);
      if (entry.state === 'starting' || entry.state === 'cleanup-failed') return true;
      return false;
    },
  }), error => error?.code === 'AUDIT_DOWNLOAD_CLEANUP_PENDING');

  assert.deepEqual(states, ['starting', 'cleaned', 'cleanup-failed']);
});

test('never releases an identified download when its physical cleanup lacks a durable journal acknowledgement', async () => {
  const states = [];
  const operations = [];
  await assert.rejects(downloadArtifacts({ baseName: 'audit-in-flight-write', html: '<!doctype html>' }, {
    createObjectURL() { return 'blob:chrome-extension://test/in-flight-write'; },
    revokeObjectURL() {},
    async download() { return 93; },
    async cancelDownload(id) { operations.push(['cancel', id]); },
    async removeDownloadFile(id) { operations.push(['remove', id]); },
    async waitForDownload() { throw new Error('download must not be observed'); },
    resolveDownloadFilename: ATTEST_REQUESTED_FILENAME,
  }, {
    timeoutMs: 20,
    hashBytes: FAST_SHA256,
    async recordDeliveryState(entry) {
      states.push(entry.state);
      if (entry.state === 'starting' || entry.state === 'cleanup-failed') return true;
      if (entry.state === 'in-flight') throw new Error('journal write unavailable');
      return false;
    },
  }), error => error?.code === 'AUDIT_DOWNLOAD_CLEANUP_PENDING');

  assert.deepEqual(operations, [['cancel', 93], ['remove', 93]]);
  assert.deepEqual(states, ['starting', 'in-flight', 'cleaned', 'cleanup-failed']);
});

test('keeps the live owner while any timed-out journal state can still commit after cleanup', async () => {
  const lateInFlight = deferred();
  let journal = null;
  const operation = downloadArtifacts({ baseName: 'audit-late-in-flight', html: '<!doctype html>' }, {
    createObjectURL() { return 'blob:chrome-extension://test/late-in-flight'; },
    revokeObjectURL() {},
    async download() { return 95; },
    async cancelDownload() {},
    async removeDownloadFile() {},
    async waitForDownload() { throw new Error('download must not be observed'); },
    resolveDownloadFilename: ATTEST_REQUESTED_FILENAME,
  }, {
    timeoutMs: 5,
    hashBytes: FAST_SHA256,
    async recordDeliveryState(entry) {
      if (entry.state === 'starting') { journal = { ...entry }; return true; }
      if (entry.state === 'in-flight') {
        await lateInFlight.promise;
        journal = { ...entry };
        return true;
      }
      if (entry.state === 'cleaned') { journal = null; return true; }
      return true;
    },
  });

  let pendingError;
  await assert.rejects(operation, error => {
    pendingError = error;
    return error?.code === 'AUDIT_DOWNLOAD_CLEANUP_PENDING';
  });
  assert.equal(journal, null);
  assert.equal(await advancePendingDownloadOwnership(pendingError, { timeoutMs: 5 }), 'waiting');
  lateInFlight.resolve();
  assert.equal(await advancePendingDownloadOwnership(pendingError, { timeoutMs: 50 }), 'settled');
  assert.deepEqual(journal, {
    state: 'in-flight', format: 'html', filename: 'audit-late-in-flight.html', downloadId: 95,
  });
});

test('tracks a timed-out cleanup-failed fallback even when the preceding cleanup error was synchronous', async () => {
  const lateFallback = deferred();
  let journal = null;
  const operation = downloadArtifacts({ baseName: 'audit-late-fallback', html: '<!doctype html>' }, {
    createObjectURL() { return 'blob:chrome-extension://test/late-fallback'; },
    revokeObjectURL() {},
    async download() { throw new Error('physical start must not happen'); },
    async waitForDownload() { throw new Error('terminal wait must not happen'); },
    resolveDownloadFilename: ATTEST_REQUESTED_FILENAME,
  }, {
    timeoutMs: 5,
    hashBytes: FAST_SHA256,
    async assertCanDownload({ stage }) {
      if (stage === 'before-physical-start') throw new Error('revoked');
    },
    async recordDeliveryState(entry) {
      if (entry.state === 'starting') { journal = { ...entry }; return true; }
      if (entry.state === 'cleaned') { journal = null; throw new Error('cleanup acknowledgement failed'); }
      if (entry.state === 'cleanup-failed') {
        await lateFallback.promise;
        journal = { ...entry };
        return true;
      }
      return true;
    },
  });

  let pendingError;
  await assert.rejects(operation, error => {
    pendingError = error;
    return error?.code === 'AUDIT_DOWNLOAD_CLEANUP_PENDING';
  });
  assert.equal(journal, null);
  assert.equal(await advancePendingDownloadOwnership(pendingError, { timeoutMs: 5 }), 'waiting');
  lateFallback.resolve();
  assert.equal(await advancePendingDownloadOwnership(pendingError, { timeoutMs: 50 }), 'settled');
  assert.deepEqual(journal, {
    state: 'cleanup-failed', format: 'html', filename: 'audit-late-fallback.html',
  });
});

test('fails closed and removes the download when Chrome cannot attest the requested filename family', async () => {
  const journal = [];
  const operations = [];
  const adapter = {
    createObjectURL() { return 'blob:chrome-extension://test/wrong-name'; },
    revokeObjectURL() {},
    async download() { return 43; },
    async resolveDownloadFilename() { return 'outro-relatorio.html'; },
    async cancelDownload(downloadId) { operations.push(['cancel', downloadId]); },
    async removeDownloadFile(downloadId) { operations.push(['remove', downloadId]); },
    async waitForDownload(downloadId) { return { id: downloadId, state: 'complete' }; },
  };

  const result = await downloadArtifacts({ baseName: 'audit', html: '<!doctype html>' }, adapter, {
    hashBytes: FAST_SHA256,
    async recordDeliveryState(entry) { journal.push(entry); return true; },
  });

  assert.deepEqual(operations, [['cancel', 43], ['remove', 43]]);
  assert.deepEqual(journal, [
    { state: 'starting', format: 'html', filename: 'audit.html' },
    { state: 'in-flight', format: 'html', filename: 'audit.html', downloadId: 43 },
    { state: 'cleaned', format: 'html', filename: 'audit.html', downloadId: 43 },
  ]);
  assert.equal(result.formats[0].failureCode, 'DOWNLOAD_INTERRUPTED');
  assert.equal(result.formats[0].downloadId, 43);
});

test('revalidates delivery immediately before each physical download and aborts on revocation', async () => {
  const started = [];
  const checked = [];
  const revoked = [];
  let nextId = 1;
  const adapter = {
    createObjectURL(blob) { return `blob:chrome-extension://test/${blob.type}`; },
    revokeObjectURL(url) { revoked.push(url); },
    async download(options) { started.push(options.filename); return nextId++; },
    async waitForDownload(id) { return { id, state: 'complete' }; },
  };

  await assert.rejects(downloadArtifacts({
    baseName: 'audit',
    html: '<!doctype html>',
    json: '{}',
    csv: '\uFEFF"id"\r\n',
    pdf: new TextEncoder().encode('%PDF-1.7'),
  }, adapter, {
    hashBytes: FAST_SHA256,
    async assertCanDownload({ format }) {
      checked.push(format);
      if (format === 'csv') {
        throw Object.assign(new Error('lease revoked'), { code: 'AUDIT_EXPORT_LEASE_CONFLICT' });
      }
    },
  }), error => error?.code === 'AUDIT_EXPORT_LEASE_CONFLICT');

  assert.deepEqual(checked, ['html', 'html', 'html', 'html', 'pdf', 'pdf', 'pdf', 'pdf', 'csv']);
  assert.deepEqual(started, ['audit.html', 'audit.pdf']);
  assert.equal(revoked.length, 3);
});

test('revalidates after journaling and never starts a physical download revoked during the journal write', async () => {
  const journal = [];
  let revoked = false;
  let physicalStarts = 0;
  const adapter = {
    createObjectURL() { return 'blob:chrome-extension://test/revoked-after-journal'; },
    revokeObjectURL() {},
    async download() { physicalStarts += 1; return 7; },
    resolveDownloadFilename: ATTEST_REQUESTED_FILENAME,
    async waitForDownload(downloadId) { return { id: downloadId, state: 'complete' }; },
    async cancelDownload() {},
    async removeDownloadFile() {},
  };

  await assert.rejects(downloadArtifacts({ baseName: 'audit', html: '<!doctype html>' }, adapter, {
    timeoutMs: 20,
    hashBytes: FAST_SHA256,
    async assertCanDownload() {
      if (revoked) throw Object.assign(new Error('review won'), { code: 'AUDIT_REVISION_CONFLICT' });
    },
    async recordDeliveryState(entry) {
      journal.push(entry);
      if (entry.state === 'starting') revoked = true;
      return true;
    },
  }), error => error?.code === 'AUDIT_REVISION_CONFLICT');

  assert.equal(physicalStarts, 0);
  assert.deepEqual(journal, [
    { state: 'starting', format: 'html', filename: 'audit.html' },
    { state: 'cleaned', format: 'html', filename: 'audit.html' },
  ]);
});

test('cancels and removes an in-flight artifact when review revokes delivery before its terminal acceptance', async () => {
  const started = [];
  const cancelled = [];
  const removed = [];
  const checks = [];
  let revoked = false;
  const adapter = {
    createObjectURL() { return 'blob:chrome-extension://test/html'; },
    revokeObjectURL() {},
    async download(options) { started.push(options.filename); return 1; },
    async waitForDownload(id) {
      revoked = true;
      return { id, state: 'complete' };
    },
    async cancelDownload(id) { cancelled.push(id); },
    async removeDownloadFile(id) { removed.push(id); },
  };

  await assert.rejects(downloadArtifacts({
    baseName: 'audit',
    html: '<!doctype html>',
    json: '{}',
  }, adapter, {
    hashBytes: FAST_SHA256,
    async assertCanDownload({ format, stage }) {
      checks.push([format, stage]);
      if (revoked) throw Object.assign(new Error('lease revoked'), { code: 'AUDIT_EXPORT_LEASE_CONFLICT' });
    },
  }), error => error?.code === 'AUDIT_EXPORT_LEASE_CONFLICT');

  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started, ['audit.html']);
  assert.deepEqual(cancelled, [1]);
  assert.deepEqual(removed, [1]);
  assert.deepEqual(checks, [
    ['html', 'before-start'],
    ['html', 'before-physical-start'],
    ['html', 'started'],
    ['html', 'terminal'],
  ]);
});

test('journals a physical download before start and exposes a durable cleanup failure after revocation', async () => {
  const journal = [];
  let revoked = false;
  const adapter = {
    createObjectURL() { return 'blob:chrome-extension://test/journalled'; },
    revokeObjectURL() {},
    async download() { return 77; },
    resolveDownloadFilename: ATTEST_REQUESTED_FILENAME,
    async waitForDownload(downloadId) {
      revoked = true;
      return { id: downloadId, state: 'complete' };
    },
    async cancelDownload() { throw new Error('cancel denied'); },
    async removeDownloadFile() { throw new Error('remove denied'); },
  };

  await assert.rejects(downloadArtifacts({
    baseName: 'audit', html: '<!doctype html>',
  }, adapter, {
    hashBytes: FAST_SHA256,
    async assertCanDownload({ stage }) {
      if (stage === 'terminal' && revoked) {
        throw Object.assign(new Error('review won'), { code: 'AUDIT_REVISION_CONFLICT' });
      }
    },
    async recordDeliveryState(entry) { journal.push(entry); return true; },
  }), error => error?.code === 'AUDIT_DOWNLOAD_CLEANUP_PENDING' && error?.causeCode === 'AUDIT_REVISION_CONFLICT');

  assert.deepEqual(journal, [
    { state: 'starting', format: 'html', filename: 'audit.html' },
    { state: 'in-flight', format: 'html', filename: 'audit.html', downloadId: 77 },
    { state: 'terminal', format: 'html', filename: 'audit.html', downloadId: 77,
      mimeType: 'text/html;charset=utf-8', byteSize: 15, sha256: '0'.repeat(64) },
    { state: 'cleanup-failed', format: 'html', filename: 'audit.html', downloadId: 77 },
  ]);
});

test('bounds hanging cancel and remove operations, stops lease polling, and persists cleanup-failed', { timeout: 500 }, async () => {
  const cancelGate = deferred();
  const removeGate = deferred();
  const journal = [];
  let revoked = false;
  let inFlightChecks = 0;
  const adapter = {
    createObjectURL() { return 'blob:chrome-extension://test/hanging-cleanup'; },
    revokeObjectURL() {},
    async download() { return 78; },
    resolveDownloadFilename: ATTEST_REQUESTED_FILENAME,
    async waitForDownload(downloadId) {
      revoked = true;
      return { id: downloadId, state: 'complete' };
    },
    cancelDownload() { return cancelGate.promise; },
    removeDownloadFile() { return removeGate.promise; },
  };

  const operation = downloadArtifacts({ baseName: 'audit', html: '<!doctype html>' }, adapter, {
    timeoutMs: 10,
    hashBytes: FAST_SHA256,
    async assertCanDownload({ stage }) {
      if (stage === 'in-flight') inFlightChecks += 1;
      if (stage === 'terminal' && revoked) {
        throw Object.assign(new Error('review won'), { code: 'AUDIT_REVISION_CONFLICT' });
      }
    },
    async recordDeliveryState(entry) { journal.push(entry); return true; },
  }).then(
    value => ({ status: 'resolved', value }),
    error => ({ status: 'rejected', error }),
  );
  const outcome = await Promise.race([
    operation,
    new Promise(resolve => setTimeout(() => resolve({ status: 'still-pending' }), 70)),
  ]);
  cancelGate.resolve();
  removeGate.resolve();
  await operation;

  assert.equal(outcome.status, 'rejected');
  assert.equal(outcome.error?.code, 'AUDIT_DOWNLOAD_CLEANUP_PENDING');
  assert.equal(outcome.error?.causeCode, 'AUDIT_REVISION_CONFLICT');
  assert.ok(inFlightChecks <= 1, `monitor continuou ativo durante a limpeza: ${inFlightChecks}`);
  assert.deepEqual(journal.at(-1), {
    state: 'cleanup-failed', format: 'html', filename: 'audit.html', downloadId: 78,
  });
});

test('settles an interrupted artifact only after Chrome attests user cancellation, physical absence and exact history erasure', async () => {
  const events = [];
  const journal = [];
  let inspections = 0;
  const adapter = {
    createObjectURL() { return 'blob:chrome-extension://test/interrupted-clean'; },
    revokeObjectURL() {},
    async download() { return 79; },
    resolveDownloadFilename: ATTEST_REQUESTED_FILENAME,
    async waitForDownload() {
      throw Object.assign(new Error('interrupted'), { name: 'DownloadInterruptedError' });
    },
    async cancelDownload(id) { events.push(['cancel', id]); },
    async inspectDownload(id) {
      events.push(['inspect', id]);
      inspections += 1;
      return inspections === 1
        ? [{ id, state: 'interrupted', error: 'USER_CANCELED', canResume: false, exists: false }]
        : [];
    },
    async eraseDownload(id) { events.push(['erase', id]); return [id]; },
    async removeDownloadFile() { throw new Error('removeFile must not receive an interrupted item'); },
  };

  const result = await downloadArtifacts({ baseName: 'audit', html: '<!doctype html>' }, adapter, {
    timeoutMs: 50,
    hashBytes: FAST_SHA256,
    async recordDeliveryState(entry) { journal.push(entry); return true; },
  });

  assert.deepEqual(events, [
    ['cancel', 79], ['inspect', 79], ['erase', 79], ['inspect', 79],
  ]);
  assert.deepEqual(result.formats.map(entry => [entry.status, entry.failureCode]), [
    ['interrupted', 'DOWNLOAD_INTERRUPTED'],
  ]);
  assert.deepEqual(journal, [
    { state: 'starting', format: 'html', filename: 'audit.html' },
    { state: 'in-flight', format: 'html', filename: 'audit.html', downloadId: 79 },
    { state: 'cleaned', format: 'html', filename: 'audit.html', downloadId: 79 },
  ]);
});

test('keeps interrupted cleanup pending for ambiguous, resumable, residual or incompletely erased downloads', async () => {
  const cancelled = id => ({ id, state: 'interrupted', error: 'USER_CANCELED', canResume: false, exists: false });
  let accessorRead = false;
  const accessorItem = cancelled(80);
  Object.defineProperty(accessorItem, 'state', {
    enumerable: true,
    get() { accessorRead = true; return 'interrupted'; },
  });
  const scenarios = [
    ['absent-before-erasure', { first: [] }],
    ['ambiguous', { first: [cancelled(80), cancelled(80)] }],
    ['wrong-id', { first: [cancelled(81)] }],
    ['network-interruption', { first: [{ ...cancelled(80), error: 'NETWORK_FAILED' }] }],
    ['resumable', { first: [{ ...cancelled(80), canResume: true }] }],
    ['missing-can-resume', { first: [{ id: 80, state: 'interrupted', error: 'USER_CANCELED', exists: false }] }],
    ['physical-residue', { first: [{ ...cancelled(80), exists: true }] }],
    ['missing-exists', { first: [{ id: 80, state: 'interrupted', error: 'USER_CANCELED', canResume: false }] }],
    ['accessor', { first: [accessorItem] }],
    ['proxy', { first: new Proxy([cancelled(80)], {}) }],
    ['erase-empty', { first: [cancelled(80)], erased: [] }],
    ['erase-wrong-id', { first: [cancelled(80)], erased: [81] }],
    ['erase-ambiguous', { first: [cancelled(80)], erased: [80, 81] }],
    ['erase-rejected', { first: [cancelled(80)], eraseError: true }],
    ['still-present', { first: [cancelled(80)], erased: [80], after: [cancelled(80)] }],
    ['malformed-after-erasure', { first: [cancelled(80)], erased: [80], after: [{ id: 80 }] }],
  ];

  for (const [name, scenario] of scenarios) {
    const journal = [];
    let inspections = 0;
    const adapter = {
      createObjectURL() { return `blob:chrome-extension://test/${name}`; },
      revokeObjectURL() {},
      async download() { return 80; },
      resolveDownloadFilename: ATTEST_REQUESTED_FILENAME,
      async waitForDownload() {
        throw Object.assign(new Error('interrupted'), { name: 'DownloadInterruptedError' });
      },
      async cancelDownload() {},
      async inspectDownload() {
        inspections += 1;
        return inspections === 1 ? scenario.first : scenario.after ?? [];
      },
      async eraseDownload() {
        if (scenario.eraseError) throw new Error('PRIVATE_ERASE_SENTINEL');
        return scenario.erased ?? [80];
      },
      async removeDownloadFile() { throw new Error('interrupted item cannot be removed as complete'); },
    };
    await assert.rejects(downloadArtifacts({ baseName: 'audit', html: '<!doctype html>' }, adapter, {
      timeoutMs: 20,
      hashBytes: FAST_SHA256,
      async recordDeliveryState(entry) { journal.push(entry); return true; },
    }), error => error?.code === 'AUDIT_DOWNLOAD_CLEANUP_PENDING', name);
    assert.deepEqual(journal.at(-1), {
      state: 'cleanup-failed', format: 'html', filename: 'audit.html', downloadId: 80,
    }, name);
    assert.doesNotMatch(JSON.stringify(journal), /PRIVATE_ERASE_SENTINEL/u, name);
  }
  assert.equal(accessorRead, false);
});

test('exposes exact download inspection and history erasure through callback Chrome APIs', async () => {
  const calls = [];
  const chromeApi = {
    runtime: { lastError: null },
    downloads: {
      search(query, callback) {
        calls.push(['search', query]);
        callback([{ id: query.id, state: 'interrupted', error: 'USER_CANCELED', canResume: false, exists: false }]);
      },
      erase(query, callback) { calls.push(['erase', query]); callback([query.id]); },
      download(_options, callback) { callback(1); },
      cancel(_id, callback) { callback(); },
      removeFile(_id, callback) { callback(); },
      onChanged: { addListener() {}, removeListener() {} },
    },
  };
  const adapter = createDownloadsAdapter(chromeApi, {
    createObjectURL() { return 'blob:chrome-extension://test/adapter'; },
    revokeObjectURL() {},
  });

  assert.deepEqual(await adapter.inspectDownload(91), [
    { id: 91, state: 'interrupted', error: 'USER_CANCELED', canResume: false, exists: false },
  ]);
  assert.deepEqual(await adapter.eraseDownload(91), [91]);
  assert.deepEqual(calls, [['search', { id: 91 }], ['erase', { id: 91 }]]);

  chromeApi.downloads.search = (_query, callback) => {
    chromeApi.runtime.lastError = { message: 'PRIVATE_SEARCH_SENTINEL' };
    callback(undefined);
    chromeApi.runtime.lastError = null;
  };
  await assert.rejects(adapter.inspectDownload(91));
});

test('resolves an actual Chrome basename only from one plain search result with the exact download id', async () => {
  const queries = [];
  const chromeApi = {
    runtime: { lastError: null },
    downloads: {
      search(query, callback) {
        queries.push(query);
        callback([{ id: 91, filename: '/Users/fiscal/Downloads/audit (1).html', state: 'in_progress' }]);
      },
      download(_options, callback) { callback(91); },
      cancel(_id, callback) { callback(); },
      removeFile(_id, callback) { callback(); },
      erase(_query, callback) { callback([]); },
      onChanged: { addListener() {}, removeListener() {} },
    },
  };
  const adapter = createDownloadsAdapter(chromeApi, {
    createObjectURL() { return 'blob:chrome-extension://test/actual-name'; },
    revokeObjectURL() {},
  });

  assert.equal(await adapter.resolveDownloadFilename(91, {
    requestedFilename: 'audit.html', format: 'html',
  }), 'audit (1).html');
  assert.deepEqual(queries, [{ id: 91 }]);

  const unsafe = [
    [],
    [{ id: 90, filename: '/Downloads/audit.html' }],
    [{ id: 91, filename: '/Downloads/audit.html' }, { id: 91, filename: '/tmp/audit.html' }],
    [{ id: 91, filename: '/Downloads/outro.html' }],
    [{ id: 91, filename: '/Downloads/audit (01).html' }],
    [{ id: 91, filename: '/Downloads/audit (1).pdf' }],
  ];
  for (const result of unsafe) {
    chromeApi.downloads.search = (_query, callback) => callback(result);
    await assert.rejects(adapter.resolveDownloadFilename(91, {
      requestedFilename: 'audit.html', format: 'html',
    }), /nome real do download/iu);
  }
});

test('reconciles a public-name stale ID and a verifiable legacy pre-ID start', async () => {
  const operations = [];
  const resolved = [];
  const adapter = {
    async findDownloadsByFilename(filename) {
      operations.push(['find', filename]);
      return filename.endsWith('.json') ? [{ id: 12 }] : [];
    },
    async inspectDownload(downloadId) {
      const filename = downloadId === 11 ? entries[0].filename : entries[1].filename;
      return [{ id: downloadId, state: 'complete', filename: `/Downloads/${filename}` }];
    },
    async cancelDownload(downloadId) { operations.push(['cancel', downloadId]); },
    async removeDownloadFile(downloadId) { operations.push(['remove', downloadId]); },
  };
  const publicBase = buildArtifactBaseName('audit', '2026-08-29T12:00:00.123Z');
  const legacyBase = 'audit-20260829T120000123Z-delivery-22be6be49601e2a3adb3c81e78057773f77e74d482c64997baa6c565a5fb0b7b';
  const entries = [
    {
      ownerId: 'owner-old', exportAttempt: 1, state: 'in-flight',
      format: 'html', filename: `${publicBase}.html`, downloadId: 11,
    },
    {
      ownerId: 'owner-old', exportAttempt: 1, state: 'starting',
      format: 'json', filename: `${legacyBase}.json`,
    },
  ];

  await reconcileStaleDownloads(entries, adapter, async entry => { resolved.push(entry); return true; }, { auditId: 'audit' });

  assert.deepEqual(operations, [
    ['cancel', 11], ['remove', 11],
    ['find', `${legacyBase}.json`], ['cancel', 12], ['remove', 12],
  ]);
  assert.deepEqual(resolved, entries);
});

test('reconciles the immediately prior public id64 filename only through its persisted download id', async () => {
  const auditId = ':'.repeat(101);
  const projected = `id64-${btoa(auditId).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/gu, '')}`;
  const filename = `audita-${projected}-20260829T120000123Z.html`;
  const operations = [];
  const outcomes = [];

  await reconcileStaleDownloads([{
    ownerId: 'owner-old', exportAttempt: 1, state: 'in-flight',
    format: 'html', filename, downloadId: 77,
  }], {
    async inspectDownload(id) {
      operations.push(['inspect', id]);
      return [{ id, state: 'complete', filename: `/Downloads/${filename}` }];
    },
    async cancelDownload(id) { operations.push(['cancel', id]); },
    async removeDownloadFile(id) { operations.push(['remove', id]); },
  }, async (_entry, outcome) => { outcomes.push(outcome); return true; }, { auditId });

  assert.deepEqual(operations, [['inspect', 77], ['cancel', 77], ['inspect', 77], ['remove', 77]]);
  assert.deepEqual(outcomes, ['cleaned']);
});

test('never searches for the prior public id64 filename before Chrome assigned an id', async () => {
  const auditId = ':'.repeat(101);
  const projected = `id64-${btoa(auditId).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/gu, '')}`;
  const operations = [];
  const outcomes = [];

  await assert.rejects(reconcileStaleDownloads([{
    ownerId: 'owner-old', exportAttempt: 1, state: 'starting',
    format: 'html', filename: `audita-${projected}-20260829T120000123Z.html`,
  }], {
    async findDownloadsByFilename() { operations.push('find'); return [{ id: 77 }]; },
    async cancelDownload() { operations.push('cancel'); },
    async removeDownloadFile() { operations.push('remove'); },
  }, async (_entry, outcome) => { outcomes.push(outcome); return true; }, { auditId }), error =>
    error?.code === 'AUDIT_DOWNLOAD_CLEANUP_PENDING');

  assert.deepEqual(operations, []);
  assert.deepEqual(outcomes, ['cleanup-failed']);
});

test('never treats a foreign legacy prefix as owned merely because its delivery token suffix matches', async () => {
  const operations = [];
  const outcomes = [];
  const filename = 'foreign-20260829T120000123Z-delivery-22be6be49601e2a3adb3c81e78057773f77e74d482c64997baa6c565a5fb0b7b.json';

  await assert.rejects(reconcileStaleDownloads([{
    ownerId: 'owner-old', exportAttempt: 1, state: 'starting', format: 'json', filename,
  }], {
    async findDownloadsByFilename() { operations.push('find'); return [{ id: 12 }]; },
    async cancelDownload() { operations.push('cancel'); },
    async removeDownloadFile() { operations.push('remove'); },
  }, async (_entry, outcome) => { outcomes.push(outcome); return true; }, { auditId: 'audit' }), error =>
    error?.code === 'AUDIT_DOWNLOAD_CLEANUP_PENDING');

  assert.deepEqual(operations, []);
  assert.deepEqual(outcomes, []);
});

test('rejects a public artifact filename whose compact timestamp is not a real UTC instant', async () => {
  const outcomes = [];
  await assert.rejects(reconcileStaleDownloads([{
    ownerId: 'owner-old', exportAttempt: 1, state: 'terminal', format: 'html',
    filename: 'audita-audit-20260230T120000000Z.html', downloadId: 99,
  }], {}, async (_entry, outcome) => { outcomes.push(outcome); }, { auditId: 'audit' }), error =>
    error?.code === 'AUDIT_DOWNLOAD_CLEANUP_PENDING');

  assert.deepEqual(outcomes, []);
});

test('recovery never cancels a persisted download id whose real basename belongs to another file', async () => {
  const operations = [];
  const outcomes = [];
  const base = buildArtifactBaseName('audit', '2026-08-29T12:00:00.123Z');
  await assert.rejects(reconcileStaleDownloads([{
    ownerId: 'owner-old', exportAttempt: 1, state: 'in-flight', format: 'html',
    filename: `${base}.html`, downloadId: 77,
  }], {
    async inspectDownload(id) {
      operations.push(['inspect', id]);
      return [{ id, state: 'complete', filename: '/Downloads/unrelated-tax-return.pdf' }];
    },
    async cancelDownload(id) { operations.push(['cancel', id]); },
    async removeDownloadFile(id) { operations.push(['remove', id]); },
  }, async (_entry, outcome) => { outcomes.push(outcome); return true; }, { auditId: 'audit' }), error =>
    error?.code === 'AUDIT_DOWNLOAD_CLEANUP_PENDING');

  assert.deepEqual(operations, [['inspect', 77]]);
  assert.deepEqual(outcomes, ['cleanup-failed']);
});

test('never guesses a public-name pre-ID download that could belong to another attempt', async () => {
  const outcomes = [];
  const operations = [];
  const base = buildArtifactBaseName('audit', '2026-08-29T12:00:00.123Z');
  await assert.rejects(reconcileStaleDownloads([{
    ownerId: 'owner-old', exportAttempt: 1, state: 'starting',
    format: 'html', filename: `${base}.html`,
  }], {
    async findDownloadsByFilename() { operations.push('find'); return [{ id: 77 }]; },
    async cancelDownload() { operations.push('cancel'); },
    async removeDownloadFile() { operations.push('remove'); },
  }, async (_entry, outcome) => { outcomes.push(outcome); return true; }, { auditId: 'audit' }), error =>
    error?.code === 'AUDIT_DOWNLOAD_CLEANUP_PENDING');

  assert.deepEqual(operations, []);
  assert.deepEqual(outcomes, ['cleanup-failed']);
});

test('never deletes an ambiguous or absent pre-ID download by filename alone', async () => {
  const base = 'audit-20260829T120000123Z-delivery-22be6be49601e2a3adb3c81e78057773f77e74d482c64997baa6c565a5fb0b7b';
  for (const found of [[], [10, 11]]) {
    const removed = [];
    const outcomes = [];
    await assert.rejects(reconcileStaleDownloads([{
      ownerId: 'owner-old', exportAttempt: 1, state: 'starting',
      format: 'html', filename: `${base}.html`,
    }], {
      async findDownloadsByFilename() { return found; },
      async cancelDownload() {},
      async removeDownloadFile(id) { removed.push(id); },
    }, async (_entry, outcome) => { outcomes.push(outcome); return true; }, { auditId: 'audit' }), error =>
      error?.code === 'AUDIT_DOWNLOAD_CLEANUP_PENDING');
    assert.deepEqual(removed, []);
    assert.deepEqual(outcomes, ['cleanup-failed']);
  }
});

test('preserves a completed prior-attempt download while clearing only its finalized journal row', async () => {
  const outcomes = [];
  const base = buildArtifactBaseName('audit', '2026-08-29T12:00:00.123Z');
  await reconcileStaleDownloads([{
    ownerId: 'owner-old', exportAttempt: 1, state: 'terminal',
    format: 'html', filename: `${base}.html`, downloadId: 99,
  }], {
    async cancelDownload() { throw new Error('completed download must remain available'); },
    async removeDownloadFile() { throw new Error('completed download must remain available'); },
  }, async (_entry, outcome) => { outcomes.push(outcome); return true; }, { auditId: 'audit', timeoutMs: 10 });

  assert.deepEqual(outcomes, ['cleaned']);
});

test('requires an exact positive journal acknowledgement during stale recovery', async () => {
  const base = buildArtifactBaseName('audit', '2026-08-29T12:00:00.123Z');
  await assert.rejects(reconcileStaleDownloads([{
    ownerId: 'owner-old', exportAttempt: 1, state: 'terminal', format: 'html',
    filename: `${base}.html`, downloadId: 100,
  }], {}, async () => false, { auditId: 'audit' }), error =>
    error?.code === 'AUDIT_DOWNLOAD_CLEANUP_PENDING');
});

test('treats an exact completed download with exists false as already physically absent', async () => {
  const base = buildArtifactBaseName('audit', '2026-08-29T12:00:00.123Z');
  const operations = [];
  const outcomes = [];
  await reconcileStaleDownloads([{
    ownerId: 'owner-old', exportAttempt: 1, state: 'in-flight', format: 'html',
    filename: `${base}.html`, downloadId: 101,
  }], {
    async inspectDownload(id) {
      operations.push(['inspect', id]);
      return [{ id, state: 'complete', exists: false, filename: `/Downloads/${base}.html` }];
    },
    async cancelDownload(id) { operations.push(['cancel', id]); },
    async removeDownloadFile(id) { operations.push(['remove', id]); throw new Error('File not found'); },
  }, async (_entry, outcome) => { outcomes.push(outcome); return true; }, { auditId: 'audit' });

  assert.deepEqual(operations, [['inspect', 101], ['cancel', 101], ['inspect', 101]]);
  assert.deepEqual(outcomes, ['cleaned']);
});

test('clears an exact persisted download id that Chrome confirms is already absent', async () => {
  const base = buildArtifactBaseName('audit', '2026-08-29T12:00:00.123Z');
  const operations = [];
  const outcomes = [];
  await reconcileStaleDownloads([{
    ownerId: 'owner-old', exportAttempt: 1, state: 'in-flight', format: 'html',
    filename: `${base}.html`, downloadId: 104,
  }], {
    async inspectDownload(id) { operations.push(['inspect', id]); return []; },
    async cancelDownload(id) { operations.push(['cancel', id]); },
    async removeDownloadFile(id) { operations.push(['remove', id]); },
  }, async (_entry, outcome) => { outcomes.push(outcome); return true; }, { auditId: 'audit' });

  assert.deepEqual(operations, [['inspect', 104]]);
  assert.deepEqual(outcomes, ['cleaned']);
});

test('recognizes a safely uniquified public filename when reconciling its exact stale download id', async () => {
  const operations = [];
  const outcomes = [];
  const base = buildArtifactBaseName('audit', '2026-08-29T12:00:00.123Z');
  await reconcileStaleDownloads([{
    ownerId: 'owner-old', exportAttempt: 1, state: 'in-flight', format: 'html',
    filename: `${base} (12).html`, downloadId: 102,
  }], {
    async inspectDownload(id) {
      return [{ id, state: 'complete', filename: `/Downloads/${base} (12).html` }];
    },
    async cancelDownload(id) { operations.push(['cancel', id]); },
    async removeDownloadFile(id) { operations.push(['remove', id]); },
  }, async (_entry, outcome) => { outcomes.push(outcome); return true; }, { auditId: 'audit' });

  assert.deepEqual(operations, [['cancel', 102], ['remove', 102]]);
  assert.deepEqual(outcomes, ['cleaned']);
});

test('never treats a second uniquification of an already attested filename as the same download', async () => {
  const operations = [];
  const outcomes = [];
  const base = buildArtifactBaseName('audit', '2026-08-29T12:00:00.123Z');
  await assert.rejects(reconcileStaleDownloads([{
    ownerId: 'owner-old', exportAttempt: 1, state: 'in-flight', format: 'html',
    filename: `${base} (1).html`, downloadId: 103,
  }], {
    async inspectDownload(id) {
      operations.push(['inspect', id]);
      return [{ id, state: 'complete', filename: `/Downloads/${base} (1) (2).html` }];
    },
    async cancelDownload(id) { operations.push(['cancel', id]); },
    async removeDownloadFile(id) { operations.push(['remove', id]); },
  }, async (_entry, outcome) => { outcomes.push(outcome); return true; }, { auditId: 'audit' }), error =>
    error?.code === 'AUDIT_DOWNLOAD_CLEANUP_PENDING');

  assert.deepEqual(operations, [['inspect', 103]]);
  assert.deepEqual(outcomes, ['cleanup-failed']);
});

test('bounds a hanging pre-ID filename lookup and records cleanup-failed', { timeout: 500 }, async () => {
  const findGate = deferred();
  const outcomes = [];
  const base = 'audit-20260829T120000123Z-delivery-22be6be49601e2a3adb3c81e78057773f77e74d482c64997baa6c565a5fb0b7b';
  const operation = reconcileStaleDownloads([{
    ownerId: 'owner-old', exportAttempt: 1, state: 'starting',
    format: 'html', filename: `${base}.html`,
  }], {
    findDownloadsByFilename() { return findGate.promise; },
  }, async (_entry, outcome) => { outcomes.push(outcome); return true; }, { auditId: 'audit', timeoutMs: 10 }).then(
    value => ({ status: 'resolved', value }),
    error => ({ status: 'rejected', error }),
  );
  const outcome = await Promise.race([
    operation,
    new Promise(resolve => setTimeout(() => resolve({ status: 'still-pending' }), 70)),
  ]);
  findGate.resolve([]);
  await operation;

  assert.equal(outcome.status, 'rejected');
  assert.equal(outcome.error?.code, 'AUDIT_DOWNLOAD_CLEANUP_PENDING');
  assert.deepEqual(outcomes, ['cleanup-failed']);
});

test('bounds a hanging journal resolution after physical stale cleanup', { timeout: 500 }, async () => {
  const resolutionGate = deferred();
  const outcomes = [];
  const base = buildArtifactBaseName('audit', '2026-08-29T12:00:00.123Z');
  const operation = reconcileStaleDownloads([{
    ownerId: 'owner-old', exportAttempt: 1, state: 'terminal',
    format: 'html', filename: `${base}.html`, downloadId: 101,
  }], {
    async cancelDownload() {},
    async removeDownloadFile() {},
  }, async (_entry, outcome) => {
    outcomes.push(outcome);
    return resolutionGate.promise;
  }, { auditId: 'audit', timeoutMs: 10 }).then(
    value => ({ status: 'resolved', value }),
    error => ({ status: 'rejected', error }),
  );
  const outcome = await Promise.race([
    operation,
    new Promise(resolve => setTimeout(() => resolve({ status: 'still-pending' }), 70)),
  ]);
  resolutionGate.resolve();
  await operation;

  assert.equal(outcome.status, 'rejected');
  assert.equal(outcome.error?.code, 'AUDIT_DOWNLOAD_CLEANUP_PENDING');
  assert.deepEqual(outcomes, ['cleaned'], 'a completed row must remain terminal when its journal cleanup cannot be confirmed');
});

test('polls delivery ownership and cancels while the terminal observer is still pending', async () => {
  const waitStarted = deferred();
  const terminal = deferred();
  const cancelled = [];
  const removed = [];
  let revoked = false;
  const adapter = {
    createObjectURL() { return 'blob:chrome-extension://test/html-pending'; },
    revokeObjectURL() {},
    async download() { return 9; },
    waitForDownload() {
      waitStarted.resolve();
      return terminal.promise;
    },
    async cancelDownload(id) { cancelled.push(id); },
    async removeDownloadFile(id) { removed.push(id); },
  };
  const result = downloadArtifacts({ baseName: 'audit', html: '<!doctype html>' }, adapter, {
    timeoutMs: 40,
    hashBytes: FAST_SHA256,
    async assertCanDownload({ stage }) {
      if (stage === 'in-flight' && revoked) {
        throw Object.assign(new Error('lease revoked while waiting'), { code: 'AUDIT_EXPORT_LEASE_CONFLICT' });
      }
    },
  });
  await waitStarted.promise;
  revoked = true;
  await assert.rejects(result, error => error?.code === 'AUDIT_EXPORT_LEASE_CONFLICT');
  terminal.resolve({ id: 9, state: 'complete' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(cancelled, [9]);
  assert.deepEqual(removed, [9]);
});

test('contains interrupted and timed-out downloads, revokes URLs, and continues other formats', async () => {
  const revoked = [];
  let id = 0;
  const adapter = {
    createObjectURL() { return `blob:chrome-extension://test/${id}`; },
    revokeObjectURL(url) { revoked.push(url); },
    async download() { id += 1; return id; },
    async waitForDownload(downloadId) {
      if (downloadId === 1) throw Object.assign(new Error('interrupted'), { name: 'DownloadInterruptedError' });
      if (downloadId === 2) throw new DOMException('timeout', 'TimeoutError');
      return { id: downloadId, state: 'complete' };
    },
  };
  const result = await downloadArtifacts({ baseName: 'audit', html: '<!doctype html>', json: '{}', csv: '\uFEFF"id"\r\n', pdf: new TextEncoder().encode('%PDF-1.7') }, adapter, { timeoutMs: 5, hashBytes: FAST_SHA256 });
  assert.deepEqual(result.formats.map(item => item.status), ['interrupted', 'timeout', 'complete', 'complete']);
  assert.deepEqual(result.formats.map(item => item.failureCode ?? null), [
    'DOWNLOAD_INTERRUPTED', 'DOWNLOAD_WAIT_TIMEOUT', null, null,
  ]);
  assert.equal(revoked.length, 4);
  assert.equal(result.limitations.length, 2);
});

test('continues later formats when starting one download rejects', async () => {
  let started = 0;
  const revoked = [];
  const adapter = {
    createObjectURL() { return `blob:chrome-extension://test/${started}`; },
    revokeObjectURL(url) { revoked.push(url); },
    async download() { started += 1; if (started === 1) throw new Error('downloads denied'); return started; },
    async waitForDownload(id) { return { id, state: 'complete' }; },
  };
  const result = await downloadArtifacts({ baseName: 'audit', html: '<!doctype html>', json: '{}', csv: '\uFEFF"id"\r\n', pdf: new TextEncoder().encode('%PDF-1.7') }, adapter);
  assert.deepEqual(result.formats.map(item => item.status), ['interrupted', 'complete', 'complete', 'complete']);
  assert.equal(result.formats[0].failureCode, 'DOWNLOAD_START_FAILED');
  assert.equal(Object.hasOwn(result.formats[0], 'downloadId'), false);
  assert.equal(revoked.length, 4);
});

test('contains hostile failure-name accessors at start and terminal wait without invoking them', async () => {
  for (const stage of ['start', 'wait']) {
    let accessed = false;
    const hostile = {};
    Object.defineProperty(hostile, 'name', {
      enumerable: true,
      get() { accessed = true; throw new Error('PRIVATE_SENTINEL'); },
    });
    let id = 0;
    const adapter = {
      createObjectURL(blob) { return `blob:chrome-extension://test/${blob.type}`; },
      revokeObjectURL() {},
      async download() {
        id += 1;
        if (stage === 'start' && id === 1) throw hostile;
        return id;
      },
      async waitForDownload(downloadId) {
        if (stage === 'wait' && downloadId === 1) throw hostile;
        return { id: downloadId, state: 'complete' };
      },
    };

    const result = await downloadArtifacts({
      baseName: 'audit', html: '<!doctype html>', json: '{}', csv: '\uFEFF"id"\r\n',
      pdf: new TextEncoder().encode('%PDF-1.7'),
    }, adapter);

    assert.equal(accessed, false);
    assert.deepEqual(result.formats.map(entry => entry.status), ['interrupted', 'complete', 'complete', 'complete']);
    assert.equal(result.formats[0].failureCode, stage === 'start' ? 'DOWNLOAD_START_FAILED' : 'DOWNLOAD_INTERRUPTED');
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SENTINEL/u);
  }
});

test('descriptor-validates terminal download state without invoking accessors or accepting proxies', async () => {
  let accessed = false;
  const accessorTerminal = { id: 1 };
  Object.defineProperty(accessorTerminal, 'state', {
    enumerable: true,
    get() { accessed = true; return 'complete'; },
  });
  const invalidTerminals = [
    accessorTerminal,
    new Proxy({ id: 1, state: 'complete' }, {}),
  ];

  for (const terminal of invalidTerminals) {
    let id = 0;
    const adapter = {
      createObjectURL(blob) { return `blob:chrome-extension://test/${blob.type}`; },
      revokeObjectURL() {},
      async download() { return ++id; },
      async waitForDownload(downloadId) { return downloadId === 1 ? terminal : { id: downloadId, state: 'complete' }; },
    };
    const result = await downloadArtifacts({
      baseName: 'audit', html: '<!doctype html>', json: '{}', csv: '\uFEFF"id"\r\n',
      pdf: new TextEncoder().encode('%PDF-1.7'),
    }, adapter);

    assert.equal(accessed, false);
    assert.equal(result.formats[0].failureCode, 'DOWNLOAD_INTERRUPTED');
    assert.deepEqual(result.formats.slice(1).map(entry => entry.status), ['complete', 'complete', 'complete']);
  }
});

test('cleanup failures are controlled and never stop subsequent formats', async () => {
  let id = 0;
  const adapter = {
    createObjectURL() { return `blob:chrome-extension://test/${id}`; },
    revokeObjectURL() { throw new Error('TOPSECRET https://origin.test/'); },
    async download() { return ++id; },
    async waitForDownload(downloadId) { return { id: downloadId, state: 'complete' }; },
  };
  const result = await downloadArtifacts({ baseName: 'audit', html: '<!doctype html>', json: '{}', csv: '\uFEFF"id"\r\n', pdf: new TextEncoder().encode('%PDF-1.7') }, adapter);
  assert.equal(result.formats.length, 4);
  assert.ok(result.formats.every(format => format.status === 'complete'));
  assert.match(result.limitations.join(' '), /liberar|temporário|limpeza/iu);
  assert.doesNotMatch(JSON.stringify(result), /TOPSECRET|origin\.test|blob:/iu);
});

test('cancels a download ID that resolves only after its start timeout and has already revoked its Blob URL', async () => {
  let resolveStart;
  let calls = 0;
  const startObserved = deferred();
  const cancelled = [];
  const revoked = [];
  const adapter = {
    createObjectURL() { return `blob:chrome-extension://test/${calls}`; },
    revokeObjectURL(url) { revoked.push(url); },
    download() {
      calls += 1;
      if (calls === 1) {
        startObserved.resolve();
        return new Promise(resolve => { resolveStart = resolve; });
      }
      return Promise.resolve(calls);
    },
    async cancelDownload(id) { cancelled.push(id); },
    async waitForDownload(id) { return { id, state: 'complete' }; },
  };
  const resultPromise = downloadArtifacts({ baseName: 'audit', html: '<!doctype html>', json: '{}', csv: '\uFEFF"id"\r\n', pdf: new TextEncoder().encode('%PDF-1.7') }, adapter, { timeoutMs: 5, hashBytes: FAST_SHA256 });
  await startObserved.promise;
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(revoked.length >= 1);
  assert.equal(revoked[0], 'blob:chrome-extension://test/0');
  resolveStart(77);
  const result = await resultPromise;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(cancelled, [77]);
  assert.deepEqual(result.formats.map(format => format.status), ['timeout', 'complete', 'complete', 'complete']);
  assert.equal(result.formats[0].failureCode, 'DOWNLOAD_START_TIMEOUT');
});

test('fails closed on a public pre-ID timeout and clears it only after the late start is physically removed', async () => {
  const late = deferred();
  const states = [];
  const removed = [];
  const adapter = {
    createObjectURL() { return 'blob:chrome-extension://test/late-journal'; },
    revokeObjectURL() {},
    download() { return late.promise; },
    resolveDownloadFilename: ATTEST_REQUESTED_FILENAME,
    async cancelDownload() {},
    async removeDownloadFile(id) { removed.push(id); },
    async waitForDownload(id) { return { id, state: 'complete' }; },
  };
  const result = downloadArtifacts({ baseName: 'audit', html: '<!doctype html>' }, adapter, {
    timeoutMs: 5,
    hashBytes: FAST_SHA256,
    async recordDeliveryState(entry) { states.push(entry); return true; },
  });
  let pendingError;
  await assert.rejects(result, error => {
    pendingError = error;
    return error?.code === 'AUDIT_DOWNLOAD_CLEANUP_PENDING';
  });
  assert.deepEqual(states, [{ state: 'starting', format: 'html', filename: 'audit.html' }]);
  assert.equal(await advancePendingDownloadOwnership(pendingError, { timeoutMs: 5 }), 'waiting',
    'an empty journal cannot release the tab while the late Chrome ID is still owned by its callback');

  late.resolve(88);
  assert.equal(await advancePendingDownloadOwnership(pendingError, { timeoutMs: 50 }), 'settled');
  assert.deepEqual(removed, [88]);
  assert.deepEqual(states.at(-1), {
    state: 'cleaned', format: 'html', filename: 'audit.html', downloadId: 88,
  });
});

test('a late Chrome id clears the exact pre-ID row through the real persistent journal contract', async () => {
  const store = createInMemoryAuditStore();
  const auditId = SAMPLE_AUDIT.auditId;
  const ownerId = 'late-start-owner';
  await store.setAudit(auditId, structuredClone(SAMPLE_AUDIT));
  const snapshot = await store.getAuditSnapshot(auditId);
  const lease = await store.acquireExportLease(auditId, snapshot.capability, {
    ownerId, now: '2026-08-30T12:00:00.000Z',
  });
  await store.claimExportLease(auditId, snapshot.capability, {
    ownerId, exportAttempt: lease.exportAttempt, now: '2026-08-30T12:00:00.100Z',
  });
  await store.beginExportDelivery(auditId, snapshot.capability, {
    ownerId, exportAttempt: lease.exportAttempt, now: '2026-08-30T12:00:00.200Z',
  });
  const late = deferred();
  const removed = [];
  const operation = downloadArtifacts({ baseName: 'audit', html: '<!doctype html>' }, {
    createObjectURL() { return 'blob:chrome-extension://test/late-real-journal'; },
    revokeObjectURL() {},
    download() { return late.promise; },
    resolveDownloadFilename: ATTEST_REQUESTED_FILENAME,
    async cancelDownload() {},
    async removeDownloadFile(id) { removed.push(id); },
    async waitForDownload(id) { return { id, state: 'complete' }; },
  }, {
    timeoutMs: 5,
    hashBytes: FAST_SHA256,
    recordDeliveryState(entry) {
      if (entry.state === 'cleaned' || entry.state === 'cleanup-failed') {
        return store.resolveExportDelivery(auditId, {
          ownerId, exportAttempt: lease.exportAttempt, now: '2026-08-30T12:00:00.400Z',
          format: entry.format, filename: entry.filename,
          ...(entry.downloadId === undefined ? {} : { downloadId: entry.downloadId }),
          outcome: entry.state,
        });
      }
      return store.recordExportDelivery(auditId, snapshot.capability, {
        ownerId, exportAttempt: lease.exportAttempt, now: '2026-08-30T12:00:00.300Z', ...entry,
      });
    },
  });

  await assert.rejects(operation, error => error?.code === 'AUDIT_DOWNLOAD_CLEANUP_PENDING');
  assert.equal((await store.getExportDeliveryJournal(auditId))[0].state, 'starting');
  late.resolve(94);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(removed, [94]);
  assert.deepEqual(await store.getExportDeliveryJournal(auditId), []);
});

test('does not pass an invalid late start result to the cancellation adapter', async () => {
  let resolveStart;
  let calls = 0;
  const cancelled = [];
  const adapter = {
    createObjectURL() { return `blob:chrome-extension://test/${calls}`; },
    revokeObjectURL() {},
    download() {
      calls += 1;
      if (calls === 1) return new Promise(resolve => { resolveStart = resolve; });
      return Promise.resolve(calls);
    },
    async cancelDownload(value) { cancelled.push(value); },
    async waitForDownload(id) { return { id, state: 'complete' }; },
  };
  const resultPromise = downloadArtifacts({
    baseName: 'audit', html: '<!doctype html>', json: '{}', csv: '\uFEFF"id"\r\n',
    pdf: new TextEncoder().encode('%PDF-1.7'),
  }, adapter, { timeoutMs: 5, hashBytes: FAST_SHA256 });
  const result = await resultPromise;
  resolveStart({ private: 'PRIVATE_SENTINEL' });
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(cancelled, []);
  assert.equal(result.formats[0].failureCode, 'DOWNLOAD_START_TIMEOUT');
  assert.equal(result.formats.at(-1).format, 'json');
  assert.equal(result.formats.at(-1).status, 'complete');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SENTINEL/u);
});

test('independently times out a hanging terminal wait, cancels it, revokes once, and continues in format order', { timeout: 500 }, async () => {
  const late = deferred();
  const events = [];
  let id = 0;
  const adapter = {
    createObjectURL(blob) { const url = `blob:chrome-extension://test/${blob.type}`; events.push(['create', blob.type, url]); return url; },
    revokeObjectURL(url) { events.push(['revoke', url]); },
    async download(options) { const downloadId = ++id; events.push(['download', options.filename, downloadId]); return downloadId; },
    async cancelDownload(downloadId) { events.push(['cancel', downloadId]); },
    waitForDownload(downloadId) {
      events.push(['wait', downloadId]);
      return downloadId === 1 ? late.promise : Promise.resolve({ id: downloadId, state: 'complete' });
    },
  };

  const resultPromise = downloadArtifacts({
    baseName: 'audit', html: '<!doctype html>', json: '{}', csv: '\uFEFF"id"\r\n',
    pdf: new TextEncoder().encode('%PDF-1.7'),
  }, adapter, { timeoutMs: 5, hashBytes: FAST_SHA256 });
  const outcome = await Promise.race([
    resultPromise,
    new Promise(resolve => setTimeout(() => resolve('still-pending'), 50)),
  ]);

  assert.notEqual(outcome, 'still-pending');
  assert.deepEqual(outcome.formats.map(entry => [entry.format, entry.status, entry.failureCode ?? null]), [
    ['html', 'timeout', 'DOWNLOAD_WAIT_TIMEOUT'],
    ['pdf', 'complete', null],
    ['csv', 'complete', null],
    ['json', 'complete', null],
  ]);
  assert.deepEqual(events.filter(entry => entry[0] === 'cancel'), [['cancel', 1]]);
  assert.equal(events.filter(entry => entry[0] === 'revoke').length, 4);
  assert.equal(new Set(events.filter(entry => entry[0] === 'revoke').map(entry => entry[1])).size, 4);
  assert.deepEqual(events.filter(entry => entry[0] === 'download').map(entry => entry[1]), [
    'audit.html', 'audit.pdf', 'audit.csv', 'audit.json',
  ]);
  assert.ok(events.findIndex(entry => entry[0] === 'cancel') < events.findIndex(entry => entry[0] === 'revoke'));

  late.resolve({ id: 1, state: 'complete' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events.filter(entry => entry[0] === 'cancel'), [['cancel', 1]]);
  assert.equal(events.filter(entry => entry[0] === 'revoke').length, 4);
});

test('cancels once when the adapter itself reports a terminal wait timeout before the outer timer', async () => {
  const events = [];
  let id = 0;
  const adapter = {
    createObjectURL(blob) { const url = `blob:chrome-extension://test/${blob.type}`; events.push(['create', url]); return url; },
    revokeObjectURL(url) { events.push(['revoke', url]); },
    async download() { return ++id; },
    async cancelDownload(downloadId) { events.push(['cancel', downloadId]); },
    async waitForDownload(downloadId) {
      if (downloadId === 1) throw new DOMException('adapter timeout', 'TimeoutError');
      return { id: downloadId, state: 'complete' };
    },
  };

  const result = await downloadArtifacts({
    baseName: 'audit', html: '<!doctype html>', json: '{}', csv: '\uFEFF"id"\r\n',
    pdf: new TextEncoder().encode('%PDF-1.7'),
  }, adapter, { timeoutMs: 50 });

  assert.equal(result.formats[0].failureCode, 'DOWNLOAD_WAIT_TIMEOUT');
  assert.deepEqual(events.filter(entry => entry[0] === 'cancel'), [['cancel', 1]]);
  assert.ok(events.findIndex(entry => entry[0] === 'cancel') < events.findIndex(entry => entry[0] === 'revoke'));
  assert.deepEqual(result.formats.slice(1).map(entry => entry.status), ['complete', 'complete', 'complete']);
});

test('attempts one contained cancellation after every terminal observer failure and still revokes once and continues', async () => {
  for (const scenario of ['reject', 'invalid-terminal', 'throw']) {
    const events = [];
    let id = 0;
    const adapter = {
      createObjectURL(blob) {
        const url = `blob:chrome-extension://test/${scenario}/${blob.type}`;
        events.push(['create', url]);
        return url;
      },
      revokeObjectURL(url) { events.push(['revoke', url]); },
      async download(options) {
        const downloadId = ++id;
        events.push(['download', options.filename, downloadId]);
        return downloadId;
      },
      cancelDownload(downloadId) {
        events.push(['cancel', downloadId]);
        return new Promise(() => {});
      },
      waitForDownload(downloadId) {
        events.push(['wait', downloadId]);
        if (downloadId !== 1) return Promise.resolve({ id: downloadId, state: 'complete' });
        if (scenario === 'reject') return Promise.reject(new Error('PRIVATE_TERMINAL_SENTINEL'));
        if (scenario === 'invalid-terminal') return Promise.resolve({ id: downloadId, state: 'interrupted' });
        throw new Error('PRIVATE_TERMINAL_SENTINEL');
      },
    };

    const result = await downloadArtifacts({
      baseName: 'audit', html: '<!doctype html>', json: '{}', csv: '\uFEFF"id"\r\n',
      pdf: new TextEncoder().encode('%PDF-1.7'),
    }, adapter, { timeoutMs: 50, hashBytes: FAST_SHA256 });

    assert.equal(result.formats[0].failureCode, 'DOWNLOAD_INTERRUPTED');
    assert.deepEqual(result.formats.slice(1).map(entry => entry.status), ['complete', 'complete', 'complete']);
    assert.deepEqual(events.filter(entry => entry[0] === 'cancel'), [['cancel', 1]]);
    assert.equal(events.filter(entry => entry[0] === 'revoke').length, 4);
    assert.equal(new Set(events.filter(entry => entry[0] === 'revoke').map(entry => entry[1])).size, 4);
    assert.ok(events.findIndex(entry => entry[0] === 'cancel') < events.findIndex(entry => entry[0] === 'revoke'));
    assert.deepEqual(events.filter(entry => entry[0] === 'download').map(entry => entry[1]), [
      'audit.html', 'audit.pdf', 'audit.csv', 'audit.json',
    ]);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_TERMINAL_SENTINEL/u);
  }
});

test('contains a throwing optional cancellation getter without invoking or leaking it', async () => {
  let accessed = false;
  let id = 0;
  const adapter = {
    createObjectURL(blob) { return `blob:chrome-extension://test/${blob.type}`; },
    revokeObjectURL() {},
    async download() { return ++id; },
    async waitForDownload(downloadId) {
      if (downloadId === 1) throw new DOMException('adapter timeout', 'TimeoutError');
      return { id: downloadId, state: 'complete' };
    },
  };
  Object.defineProperty(adapter, 'cancelDownload', {
    enumerable: true,
    get() { accessed = true; throw new Error('PRIVATE_CANCEL_SENTINEL'); },
  });

  const result = await downloadArtifacts({
    baseName: 'audit', html: '<!doctype html>', json: '{}', csv: '\uFEFF"id"\r\n',
    pdf: new TextEncoder().encode('%PDF-1.7'),
  }, adapter, { timeoutMs: 50 });

  assert.equal(accessed, false);
  assert.equal(result.formats[0].failureCode, 'DOWNLOAD_WAIT_TIMEOUT');
  assert.deepEqual(result.formats.slice(1).map(entry => entry.status), ['complete', 'complete', 'complete']);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_CANCEL_SENTINEL/u);
});

test('uses a descriptor-safe inherited cancellation method accepted by a class adapter', async () => {
  class Adapter {
    constructor() { this.id = 0; this.cancelled = []; }
    createObjectURL(blob) { return `blob:chrome-extension://test/${blob.type}`; }
    revokeObjectURL() {}
    async download() { return ++this.id; }
    async cancelDownload(downloadId) { this.cancelled.push(downloadId); }
    async waitForDownload(downloadId) {
      if (downloadId === 1) throw new DOMException('adapter timeout', 'TimeoutError');
      return { id: downloadId, state: 'complete' };
    }
  }
  const adapter = new Adapter();

  const result = await downloadArtifacts({
    baseName: 'audit', html: '<!doctype html>', json: '{}', csv: '\uFEFF"id"\r\n',
    pdf: new TextEncoder().encode('%PDF-1.7'),
  }, adapter, { timeoutMs: 50 });

  assert.equal(result.formats[0].failureCode, 'DOWNLOAD_WAIT_TIMEOUT');
  assert.deepEqual(adapter.cancelled, [1]);
  assert.deepEqual(result.formats.slice(1).map(entry => entry.status), ['complete', 'complete', 'complete']);
});

test('contains invalid artifact bytes and hash failures without skipping the later JSON', async () => {
  for (const scenario of ['bytes', 'hash']) {
    let id = 0;
    let hashCalls = 0;
    const downloaded = [];
    const created = [];
    const adapter = {
      createObjectURL(blob) { created.push(blob.type); return `blob:chrome-extension://test/${blob.type}`; },
      revokeObjectURL() {},
      async download(options) { downloaded.push(options.filename); return ++id; },
      async waitForDownload(downloadId) { return { id: downloadId, state: 'complete' }; },
    };
    const result = await downloadArtifacts({
      baseName: 'audit', html: '<!doctype html>', json: '{}',
      csv: scenario === 'bytes' ? { private: 'PRIVATE_SENTINEL' } : '\uFEFF"id"\r\n',
      pdf: new TextEncoder().encode('%PDF-1.7'),
    }, adapter, {
      hashBytes: async bytes => {
        hashCalls += 1;
        if (scenario === 'hash' && hashCalls === 3) throw new Error('PRIVATE_SENTINEL');
        return globalThis.crypto.subtle.digest('SHA-256', bytes).then(buffer =>
          [...new Uint8Array(buffer)].map(byte => byte.toString(16).padStart(2, '0')).join(''));
      },
    });

    assert.deepEqual(result.formats.map(entry => [entry.format, entry.status]), [
      ['html', 'complete'], ['pdf', 'complete'], ['csv', 'interrupted'], ['json', 'complete'],
    ]);
    assert.equal(result.formats[2].failureCode, scenario === 'bytes' ? 'ARTIFACT_BYTES_INVALID' : 'ARTIFACT_HASH_FAILED');
    assert.equal(result.formats[2].sha256, null);
    assert.deepEqual(downloaded, ['audit.html', 'audit.pdf', 'audit.json']);
    assert.deepEqual(created, ['text/html;charset=utf-8', 'application/pdf', 'application/json;charset=utf-8']);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SENTINEL|blob:/u);
  }
});

test('independently times out a hanging hash calculation and continues through the later PDF', { timeout: 500 }, async () => {
  let hashCalls = 0;
  let id = 0;
  const downloaded = [];
  const adapter = {
    createObjectURL(blob) { return `blob:chrome-extension://test/${blob.type}`; },
    revokeObjectURL() {},
    async download(options) { downloaded.push(options.filename); return ++id; },
    async waitForDownload(downloadId) { return { id: downloadId, state: 'complete' }; },
  };
  const operation = downloadArtifacts({
    baseName: 'audit', html: '<!doctype html>', json: '{}', csv: '\uFEFF"id"\r\n',
    pdf: new TextEncoder().encode('%PDF-1.7'),
  }, adapter, {
    timeoutMs: 5,
    hashBytes() {
      hashCalls += 1;
      if (hashCalls === 1) return new Promise(() => {});
      return FAST_SHA256();
    },
  });
  const outcome = await Promise.race([
    operation,
    new Promise(resolve => setTimeout(() => resolve('still-pending'), 50)),
  ]);

  assert.notEqual(outcome, 'still-pending');
  assert.deepEqual(outcome.formats.map(entry => [entry.format, entry.status, entry.failureCode ?? null]), [
    ['html', 'interrupted', 'ARTIFACT_HASH_FAILED'],
    ['pdf', 'complete', null],
    ['csv', 'complete', null],
    ['json', 'complete', null],
  ]);
  assert.deepEqual(downloaded, ['audit.pdf', 'audit.csv', 'audit.json']);
});

test('hashes and blobs the same owned byte snapshot when the caller mutates its original buffer', async () => {
  const pdf = new TextEncoder().encode('%PDF-1.7\nORIGINAL');
  const original = Uint8Array.from(pdf);
  let hashCall = 0;
  let pdfBlob = null;
  const adapter = {
    createObjectURL(blob) {
      if (blob.type === 'application/pdf') pdfBlob = blob;
      return `blob:chrome-extension://test/${blob.type}`;
    },
    revokeObjectURL() {},
    async download() { return ++hashCall; },
    async waitForDownload(downloadId) { return { id: downloadId, state: 'complete' }; },
  };
  let digestCall = 0;
  const result = await downloadArtifacts({
    baseName: 'audit', html: '<!doctype html>', json: '{}', csv: '\uFEFF"id"\r\n', pdf,
  }, adapter, {
    async hashBytes(bytes) {
      digestCall += 1;
      const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
      if (digestCall === 4) pdf.fill(0x58);
      return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    },
  });

  assert.deepEqual(new Uint8Array(await pdfBlob.arrayBuffer()), original);
  const expectedDigest = await globalThis.crypto.subtle.digest('SHA-256', original);
  const expectedHash = [...new Uint8Array(expectedDigest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  assert.equal(result.formats.find(entry => entry.format === 'pdf').sha256, expectedHash);
  assert.notDeepEqual(pdf, original);
});

test('contains CSV Blob preparation failure and still downloads the later JSON', async () => {
  let id = 0;
  const downloaded = [];
  const adapter = {
    createObjectURL(blob) {
      if (blob.type === 'text/csv;charset=utf-8') throw new Error('PRIVATE_SENTINEL');
      return `blob:chrome-extension://test/${blob.type}`;
    },
    revokeObjectURL() {},
    async download(options) { downloaded.push(options.filename); return ++id; },
    async waitForDownload(downloadId) { return { id: downloadId, state: 'complete' }; },
  };
  const result = await downloadArtifacts({
    baseName: 'audit', html: '<!doctype html>', json: '{}', csv: '\uFEFF"id"\r\n',
    pdf: new TextEncoder().encode('%PDF-1.7'),
  }, adapter);
  assert.deepEqual(result.formats.map(format => [format.format, format.status]), [
    ['html', 'complete'], ['pdf', 'complete'], ['csv', 'interrupted'], ['json', 'complete'],
  ]);
  assert.equal(result.formats[2].failureCode, 'ARTIFACT_BLOB_FAILED');
  assert.deepEqual(result.limitations, ['O artefato CSV não pôde ser preparado para download.']);
  assert.deepEqual(downloaded, ['audit.html', 'audit.pdf', 'audit.json']);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SENTINEL|blob:/u);
});

function deferred() {
  let resolve;
  const promise = new Promise(next => { resolve = next; });
  return { promise, resolve };
}

test('a transient interrupted signal does not discard a download that Chrome reports complete', async () => {
  const listeners = new Set();
  let searchState = 'in_progress';
  const chromeApi = {
    runtime: {},
    downloads: {
      onChanged: {
        addListener(listener) { listeners.add(listener); },
        removeListener(listener) { listeners.delete(listener); },
      },
      download(_options, callback) { callback(77); },
      search(_query, callback) {
        callback([searchState === 'complete' ? { id: 77, state: 'complete' }
          : { id: 77, state: 'interrupted', error: 'NETWORK_FAILED' }]);
      },
    },
  };
  const adapter = createDownloadsAdapter(chromeApi, { createObjectURL() { return 'blob:test'; }, revokeObjectURL() {} });
  const pending = adapter.waitForDownload(77, { timeoutMs: 5_000 });
  // Chrome can report an interruption and still finish the very same download: by the time
  // the durable search is repeated the artifact is already complete. The authority is that
  // search result, so the signal alone must not end the wait.
  searchState = 'complete';
  for (const listener of [...listeners]) listener({ id: 77, state: { current: 'interrupted' }, error: { current: 'NETWORK_FAILED' } });
  const settled = await pending;
  assert.deepEqual(settled, { id: 77, state: 'complete' });
  assert.equal(listeners.size, 0, 'the terminal wait releases its listener');
});
