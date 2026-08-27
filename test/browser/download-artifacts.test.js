import assert from 'node:assert/strict';
import test from 'node:test';

import { buildArtifactBaseName, downloadArtifacts } from '../../src/browser/download-artifacts.js';

test('builds sanitized host and canonical timestamp artifact names', () => {
  assert.equal(buildArtifactBaseName('https://Serviço.MT.gov.br:8443/path', '2026-08-26T14:00:00.000Z'), 'xn-servio-0ua-mt-gov-br-20260826T140000000Z');
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
    pdf: new TextEncoder().encode('%PDF-1.7\nreport'),
  }, adapter, { timeoutMs: 50 });
  assert.equal(result.formats.length, 3);
  assert.deepEqual(result.formats.map(item => item.status), ['complete', 'complete', 'complete']);
  assert.deepEqual(result.formats.map(item => item.downloadId), [10, 11, 12]);
  assert.deepEqual(result.formats.map(item => item.filename), [
    'example-test-20260826T140000000Z.html', 'example-test-20260826T140000000Z.json', 'example-test-20260826T140000000Z.pdf',
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
  const result = await downloadArtifacts({ baseName: 'audit', html: '<!doctype html>', json: '{}', pdf: new TextEncoder().encode('%PDF-1.7') }, adapter, { timeoutMs: 5 });
  assert.deepEqual(result.formats.map(item => item.status), ['interrupted', 'timeout', 'complete']);
  assert.equal(revoked.length, 3);
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
  const result = await downloadArtifacts({ baseName: 'audit', html: '<!doctype html>', json: '{}', pdf: new TextEncoder().encode('%PDF-1.7') }, adapter);
  assert.deepEqual(result.formats.map(item => item.status), ['interrupted', 'complete', 'complete']);
  assert.equal(Object.hasOwn(result.formats[0], 'downloadId'), false);
  assert.equal(revoked.length, 3);
});
