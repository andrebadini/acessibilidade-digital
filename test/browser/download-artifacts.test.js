import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildArtifactBaseName,
  bindDeliveryArtifactBaseName,
  createDownloadsAdapter,
  downloadArtifacts,
  reconcileStaleDownloads,
} from '../../src/browser/download-artifacts.js';

const FAST_SHA256 = () => '0'.repeat(64);

test('builds audit-owned canonical timestamp artifact names without a hostname', () => {
  assert.equal(buildArtifactBaseName('audit:cliente-1', '2026-08-26T14:00:00.000Z'), 'audit-cliente-1-20260826T140000000Z');
  assert.throws(() => buildArtifactBaseName('https://example.test/', '2026-08-26T14:00:00.000Z'), /Auditoria inválida/u);
});

test('accepts every canonical audit id character and keeps the bound delivery name within its limit', async () => {
  const auditId = `._${'a'.repeat(157)}:`;
  const base = buildArtifactBaseName(auditId, '2026-08-26T14:00:00.000Z');
  assert.equal(base.length <= 160, true);
  assert.match(base, /^\._/u);
  const bound = await bindDeliveryArtifactBaseName(base, `export:${auditId}:1`, 1);
  assert.equal(bound.length <= 240, true);
  await assert.doesNotReject(() => downloadArtifacts({ baseName: bound }, {
    createObjectURL() {}, revokeObjectURL() {}, download() {}, waitForDownload() {},
  }));
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
    async recordDeliveryState(entry) { journal.push(entry); },
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
    async recordDeliveryState(entry) { journal.push(entry); },
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
    async recordDeliveryState(entry) { journal.push(entry); },
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
      async recordDeliveryState(entry) { journal.push(entry); },
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

test('reconciles stale IDs and pre-ID starts before a retry can deliver new artifacts', async () => {
  const operations = [];
  const resolved = [];
  const adapter = {
    async findDownloadsByFilename(filename) {
      operations.push(['find', filename]);
      return filename.endsWith('.json') ? [{ id: 12 }] : [];
    },
    async cancelDownload(downloadId) { operations.push(['cancel', downloadId]); },
    async removeDownloadFile(downloadId) { operations.push(['remove', downloadId]); },
  };
  const deliveryBase = await bindDeliveryArtifactBaseName('audit', 'owner-old', 1);
  const entries = [
    {
      ownerId: 'owner-old', exportAttempt: 1, state: 'in-flight',
      format: 'html', filename: `${deliveryBase}.html`, downloadId: 11,
    },
    {
      ownerId: 'owner-old', exportAttempt: 1, state: 'starting',
      format: 'json', filename: `${deliveryBase}.json`,
    },
  ];

  await reconcileStaleDownloads(entries, adapter, async entry => { resolved.push(entry); });

  assert.deepEqual(operations, [
    ['cancel', 11], ['remove', 11],
    ['find', `${deliveryBase}.json`], ['cancel', 12], ['remove', 12],
  ]);
  assert.deepEqual(resolved, entries);
});

test('never deletes an ambiguous or absent pre-ID download by filename alone', async () => {
  const base = await bindDeliveryArtifactBaseName('audit', 'owner-old', 1);
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
    }, async (_entry, outcome) => { outcomes.push(outcome); }), error =>
      error?.code === 'AUDIT_DOWNLOAD_CLEANUP_PENDING');
    assert.deepEqual(removed, []);
    assert.deepEqual(outcomes, ['cleanup-failed']);
  }
});

test('preserves a completed prior-attempt download while clearing only its finalized journal row', async () => {
  const outcomes = [];
  const base = await bindDeliveryArtifactBaseName('audit', 'owner-old', 1);
  await reconcileStaleDownloads([{
    ownerId: 'owner-old', exportAttempt: 1, state: 'terminal',
    format: 'html', filename: `${base}.html`, downloadId: 99,
  }], {
    async cancelDownload() { throw new Error('completed download must remain available'); },
    async removeDownloadFile() { throw new Error('completed download must remain available'); },
  }, async (_entry, outcome) => { outcomes.push(outcome); }, { timeoutMs: 10 });

  assert.deepEqual(outcomes, ['cleaned']);
});

test('bounds a hanging pre-ID filename lookup and records cleanup-failed', { timeout: 500 }, async () => {
  const findGate = deferred();
  const outcomes = [];
  const base = await bindDeliveryArtifactBaseName('audit', 'owner-old', 1);
  const operation = reconcileStaleDownloads([{
    ownerId: 'owner-old', exportAttempt: 1, state: 'starting',
    format: 'html', filename: `${base}.html`,
  }], {
    findDownloadsByFilename() { return findGate.promise; },
  }, async (_entry, outcome) => { outcomes.push(outcome); }, { timeoutMs: 10 }).then(
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
  const base = await bindDeliveryArtifactBaseName('audit', 'owner-old', 1);
  const operation = reconcileStaleDownloads([{
    ownerId: 'owner-old', exportAttempt: 1, state: 'terminal',
    format: 'html', filename: `${base}.html`, downloadId: 101,
  }], {
    async cancelDownload() {},
    async removeDownloadFile() {},
  }, async (_entry, outcome) => {
    outcomes.push(outcome);
    return resolutionGate.promise;
  }, { timeoutMs: 10 }).then(
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

test('keeps the pre-ID journal entry until a late start is physically removed', async () => {
  const late = deferred();
  const states = [];
  const removed = [];
  const adapter = {
    createObjectURL() { return 'blob:chrome-extension://test/late-journal'; },
    revokeObjectURL() {},
    download() { return late.promise; },
    async cancelDownload() {},
    async removeDownloadFile(id) { removed.push(id); },
    async waitForDownload(id) { return { id, state: 'complete' }; },
  };
  const result = await downloadArtifacts({ baseName: 'audit', html: '<!doctype html>' }, adapter, {
    timeoutMs: 5,
    hashBytes: FAST_SHA256,
    async recordDeliveryState(entry) { states.push(entry); },
  });
  assert.equal(result.formats[0].failureCode, 'DOWNLOAD_START_TIMEOUT');
  assert.deepEqual(states, [{ state: 'starting', format: 'html', filename: 'audit.html' }]);

  late.resolve(88);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(removed, [88]);
  assert.deepEqual(states.at(-1), {
    state: 'cleaned', format: 'html', filename: 'audit.html', downloadId: 88,
  });
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
