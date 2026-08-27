import assert from 'node:assert/strict';
import test from 'node:test';

import { buildArtifactBaseName, downloadArtifacts } from '../../src/browser/download-artifacts.js';

const FAST_SHA256 = () => '0'.repeat(64);

test('builds sanitized host and canonical timestamp artifact names', () => {
  assert.equal(buildArtifactBaseName('https://Serviço.Exemplo.test:8443/path', '2026-08-26T14:00:00.000Z'), 'xn-servio-0ua-exemplo-test-20260826T140000000Z');
  assert.equal(buildArtifactBaseName('https://example.test/', '2026-08-26T14:00:00.000Z'), 'example-test-20260826T140000000Z');
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
    'example-test-20260826T140000000Z.html', 'example-test-20260826T140000000Z.json',
    'example-test-20260826T140000000Z.csv', 'example-test-20260826T140000000Z.pdf',
  ]);
  assert.deepEqual(result.formats.map(item => item.mimeType), [
    'text/html;charset=utf-8', 'application/json;charset=utf-8', 'text/csv;charset=utf-8', 'application/pdf',
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
  const cancelled = [];
  const revoked = [];
  const adapter = {
    createObjectURL() { return `blob:chrome-extension://test/${calls}`; },
    revokeObjectURL(url) { revoked.push(url); },
    download() {
      calls += 1;
      if (calls === 1) return new Promise(resolve => { resolveStart = resolve; });
      return Promise.resolve(calls);
    },
    async cancelDownload(id) { cancelled.push(id); },
    async waitForDownload(id) { return { id, state: 'complete' }; },
  };
  const resultPromise = downloadArtifacts({ baseName: 'audit', html: '<!doctype html>', json: '{}', csv: '\uFEFF"id"\r\n', pdf: new TextEncoder().encode('%PDF-1.7') }, adapter, { timeoutMs: 5, hashBytes: FAST_SHA256 });
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
  await new Promise(resolve => setTimeout(resolve, 10));
  resolveStart({ private: 'PRIVATE_SENTINEL' });
  const result = await resultPromise;
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(cancelled, []);
  assert.equal(result.formats[0].failureCode, 'DOWNLOAD_START_TIMEOUT');
  assert.equal(result.formats.at(-1).format, 'pdf');
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
    ['json', 'complete', null],
    ['csv', 'complete', null],
    ['pdf', 'complete', null],
  ]);
  assert.deepEqual(events.filter(entry => entry[0] === 'cancel'), [['cancel', 1]]);
  assert.equal(events.filter(entry => entry[0] === 'revoke').length, 4);
  assert.equal(new Set(events.filter(entry => entry[0] === 'revoke').map(entry => entry[1])).size, 4);
  assert.deepEqual(events.filter(entry => entry[0] === 'download').map(entry => entry[1]), [
    'audit.html', 'audit.json', 'audit.csv', 'audit.pdf',
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

test('contains invalid artifact bytes and hash failures without skipping the later PDF', async () => {
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
      ['html', 'complete'], ['json', 'complete'], ['csv', 'interrupted'], ['pdf', 'complete'],
    ]);
    assert.equal(result.formats[2].failureCode, scenario === 'bytes' ? 'ARTIFACT_BYTES_INVALID' : 'ARTIFACT_HASH_FAILED');
    assert.equal(result.formats[2].sha256, null);
    assert.deepEqual(downloaded, ['audit.html', 'audit.json', 'audit.pdf']);
    assert.deepEqual(created, ['text/html;charset=utf-8', 'application/json;charset=utf-8', 'application/pdf']);
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
    ['json', 'complete', null],
    ['csv', 'complete', null],
    ['pdf', 'complete', null],
  ]);
  assert.deepEqual(downloaded, ['audit.json', 'audit.csv', 'audit.pdf']);
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

test('contains CSV Blob preparation failure and still downloads the later PDF', async () => {
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
    ['html', 'complete'], ['json', 'complete'], ['csv', 'interrupted'], ['pdf', 'complete'],
  ]);
  assert.equal(result.formats[2].failureCode, 'ARTIFACT_BLOB_FAILED');
  assert.deepEqual(result.limitations, ['O artefato CSV não pôde ser preparado para download.']);
  assert.deepEqual(downloaded, ['audit.html', 'audit.json', 'audit.pdf']);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SENTINEL|blob:/u);
});

function deferred() {
  let resolve;
  const promise = new Promise(next => { resolve = next; });
  return { promise, resolve };
}
