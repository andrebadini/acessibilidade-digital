import assert from 'node:assert/strict';
import test from 'node:test';

import { SAMPLE_AUDIT } from '../../fixtures/audits/sample-audit.js';
import { runReportExport } from '../../src/export/report-export.js';

const PDF = new TextEncoder().encode('%PDF-1.7\nlocal');

function clone(value) { return structuredClone(value); }

test('prints one inactive blob tab, cleans exact resources, and exports one shared 146-item model', async () => {
  const events = [];
  const input = clone(SAMPLE_AUDIT);
  const original = structuredClone(input);
  const result = await runReportExport({ auditModel: input, now: () => '2026-08-26T15:00:00.000Z' }, {
    urlApi: {
      createObjectURL(blob) { events.push(['create-print-url', blob.type, blob.size]); return 'blob:chrome-extension://test/print'; },
      revokeObjectURL(url) { events.push(['revoke-print-url', url]); },
    },
    tabAdapter: {
      async createPrintTab(options) { events.push(['tab-create', options]); return { id: 31 }; },
      async waitForReady(id, options) { events.push(['tab-ready', id, options]); },
      async connectCdp(id, options) { events.push(['cdp-connect', id, options]); return { async disconnect() { events.push(['cdp-disconnect']); } }; },
      async waitForAssets() { events.push(['assets-ready']); },
      async removeTab(id) { events.push(['tab-remove', id]); },
    },
    async pdfRenderer() { events.push(['pdf']); return { bytes: PDF, usedFallback: false, limitations: [] }; },
    downloadsAdapter: fakeDownloads(events),
  });
  assert.deepEqual(input, original);
  assert.equal(Object.isFrozen(input), false);
  assert.deepEqual(events.filter(entry => entry[0] === 'tab-create'), [['tab-create', { url: 'blob:chrome-extension://test/print', active: false }]]);
  assert.equal(events.filter(entry => entry[0] === 'cdp-disconnect').length, 1);
  assert.ok(events.findIndex(entry => entry[0] === 'assets-ready') >= 0);
  assert.ok(events.findIndex(entry => entry[0] === 'assets-ready') < events.findIndex(entry => entry[0] === 'pdf'));
  assert.deepEqual(events.filter(entry => entry[0] === 'tab-remove'), [['tab-remove', 31]]);
  assert.ok(events.findIndex(entry => entry[0] === 'revoke-print-url') > events.findIndex(entry => entry[0] === 'tab-remove'));
  assert.equal((result.html.match(/data-report-item=/gu) ?? []).length, 146);
  const technical = JSON.parse(result.json);
  assert.equal(technical.assertions.length, 146);
  assert.equal(technical.audit.auditId, result.model.auditId);
  assert.deepEqual(result.formats.map(entry => entry.format), ['html', 'json', 'pdf']);
  assert.doesNotMatch(JSON.stringify(result), /blob:chrome-extension/u);
});

test('ignores image branding input and exports only the neutral independent identity', async () => {
  const dataUrl = SAMPLE_AUDIT.evidence.find(artifact => artifact.dataUrl)?.dataUrl;
  let printBlob;
  const result = await runReportExport({
    auditModel: clone(SAMPLE_AUDIT),
    brand: { dataUrl, alt: 'External agency identity', width: 1, height: 1 },
    now: () => '2026-08-26T15:00:00.000Z',
  }, {
    urlApi: { createObjectURL(blob) { printBlob = blob; return 'blob:chrome-extension://test/print'; }, revokeObjectURL() {} },
    tabAdapter: successfulTabAdapter(),
    async pdfRenderer() { return { bytes: PDF, usedFallback: false, limitations: [] }; },
    downloadsAdapter: fakeDownloads([]),
  });
  assert.match(result.html, /Auditoria independente de acessibilidade/iu);
  assert.match(result.html, /sem vínculo institucional/iu);
  assert.doesNotMatch(result.html, /brand-logo|External agency identity/iu);
  assert.match(await printBlob.text(), /Auditoria independente de acessibilidade/iu);
  assert.deepEqual(JSON.parse(result.json).audit, result.model);
});

test('keeps HTML and JSON when PDF fails, records a partial limitation, and still cleans exact tab/CDP', async () => {
  const events = [];
  const result = await runReportExport({ auditModel: clone(SAMPLE_AUDIT), now: () => '2026-08-26T15:00:00.000Z' }, {
    urlApi: {
      createObjectURL() { return 'blob:chrome-extension://test/print'; },
      revokeObjectURL() { events.push(['revoke']); },
    },
    tabAdapter: {
      async createPrintTab() { return { id: 44 }; },
      async waitForReady() {},
      async connectCdp() { return { async disconnect() { events.push(['disconnect']); } }; },
      async waitForAssets() {},
      async removeTab(id) { events.push(['remove', id]); },
    },
    async pdfRenderer() { throw new Error('print failed'); },
    downloadsAdapter: fakeDownloads(events),
  });
  assert.equal(result.model.session.status, 'partial');
  assert.match(result.model.limitations.join(' '), /PDF|impressão/iu);
  assert.deepEqual(result.formats.map(entry => entry.format), ['html', 'json']);
  assert.equal(JSON.parse(result.json).audit.session.status, 'partial');
  assert.deepEqual(events.filter(entry => entry[0] === 'disconnect'), [['disconnect']]);
  assert.deepEqual(events.filter(entry => entry[0] === 'remove'), [['remove', 44]]);
});

test('contains readiness failures and cleanup errors without leaking a print URL', async () => {
  const events = [];
  const result = await runReportExport({ auditModel: clone(SAMPLE_AUDIT), now: () => '2026-08-26T15:00:00.000Z' }, {
    urlApi: {
      createObjectURL() { return 'blob:chrome-extension://test/print'; },
      revokeObjectURL(url) { events.push(['revoke', url]); },
    },
    tabAdapter: {
      async createPrintTab() { return { id: 55 }; },
      async waitForReady() { throw new DOMException('timeout', 'TimeoutError'); },
      async connectCdp() { throw new Error('must not connect'); },
      async waitForAssets() { throw new Error('must not wait'); },
      async removeTab() { throw new Error('already closed'); },
    },
    async pdfRenderer() { throw new Error('must not print'); },
    downloadsAdapter: fakeDownloads(events),
  });
  assert.equal(result.model.session.status, 'partial');
  assert.deepEqual(result.formats.map(entry => entry.format), ['html', 'json']);
  assert.deepEqual(events.filter(entry => entry[0] === 'revoke'), [['revoke', 'blob:chrome-extension://test/print']]);
});

test('records PDF fallback in the final model and the exact final HTML and JSON', async () => {
  const result = await runReportExport({ auditModel: clone(SAMPLE_AUDIT), now: () => '2026-08-26T15:00:00.000Z' }, {
    urlApi: { createObjectURL() { return 'blob:chrome-extension://test/print'; }, revokeObjectURL() {} },
    tabAdapter: successfulTabAdapter(),
    async pdfRenderer() { return { bytes: PDF, usedFallback: true, limitations: ['hostile TOPSECRET https://origin.test/'] }; },
    downloadsAdapter: fakeDownloads([]),
  });
  assert.equal(result.model.session.status, 'partial');
  assert.equal(result.model.report.artifact.pdfFallback, true);
  assert.match(result.model.limitations.join(' '), /estrutura|marcação|outline/iu);
  assert.deepEqual(JSON.parse(result.json).audit, result.model);
  assert.match(result.html, /estrutura|marcação|outline/iu);
  assert.doesNotMatch(JSON.stringify(result), /TOPSECRET|origin\.test/iu);
});

test('keeps delivery receipt separate so downloaded JSON and final model cannot disagree', async () => {
  let id = 0;
  const downloads = fakeDownloads([]);
  downloads.waitForDownload = async downloadId => downloadId === 2
    ? Promise.reject(new DOMException('TOPSECRET blob:chrome-extension://test/private', 'TimeoutError'))
    : { id: downloadId, state: 'complete' };
  downloads.download = async () => ++id;
  const result = await runReportExport({ auditModel: clone(SAMPLE_AUDIT), now: () => '2026-08-26T15:00:00.000Z' }, {
    urlApi: { createObjectURL() { return 'blob:chrome-extension://test/print'; }, revokeObjectURL() {} },
    tabAdapter: successfulTabAdapter(),
    async pdfRenderer() { return { bytes: PDF, usedFallback: false, limitations: [] }; },
    downloadsAdapter: downloads,
  });
  assert.deepEqual(JSON.parse(result.json).audit, result.model);
  assert.equal(result.deliveryReceipt.status, 'partial');
  assert.deepEqual(result.deliveryReceipt.formats.map(format => format.status), ['complete', 'timeout', 'complete']);
  assert.ok(result.model.report.artifact.formats.every(format => format.status === 'prepared'));
  assert.equal(Object.hasOwn(result.model.report.artifact, 'deliveryReceipt'), false);
  assert.doesNotMatch(JSON.stringify(result), /TOPSECRET|blob:|chrome-extension:/iu);
});

test('sanitizes primary and cleanup failures into controlled codes before rendering', async () => {
  const result = await runReportExport({ auditModel: clone(SAMPLE_AUDIT), now: () => '2026-08-26T15:00:00.000Z' }, {
    urlApi: {
      createObjectURL() { return 'blob:chrome-extension://test/print'; },
      revokeObjectURL() { throw new Error('TOPSECRET https://origin.test blob:chrome-extension://test/private'); },
    },
    tabAdapter: {
      async createPrintTab() { return { id: 8 }; },
      async waitForReady() { throw new Error('TOPSECRET https://origin.test/?token=x'); },
      async connectCdp() { throw new Error('unused'); },
      async waitForAssets() {},
      async removeTab() { throw new Error('TOPSECRET chrome-extension://test/private'); },
    },
    async pdfRenderer() { throw new Error('unused'); },
    downloadsAdapter: fakeDownloads([]),
  });
  assert.equal(result.model.session.status, 'partial');
  assert.ok(result.model.session.diagnostics.filter(entry => entry.at === '2026-08-26T15:00:00.000Z').every(entry => /^REPORT_[A-Z0-9_]+$/u.test(entry.code)));
  assert.doesNotMatch(`${result.html}\n${result.json}\n${JSON.stringify(result)}`, /TOPSECRET|origin\.test|blob:|chrome-extension:/iu);
});

test('redacts inherited diagnostic and limitation secrets before the first print render', async () => {
  const input = clone(SAMPLE_AUDIT);
  input.limitations.push('Falha em https://origin.test/?token=TOPSECRET blob:chrome-extension://test/private');
  input.session.diagnostics.push({
    code: 'SOURCE_FAILURE', message: 'auth=TOPSECRET em chrome-extension://test/private',
    at: '2026-08-26T14:01:00.000Z', recoverable: true,
    details: { source: 'https://origin.test/private?session=TOPSECRET' },
  });
  const renderedBlobs = [];
  const result = await runReportExport({ auditModel: input, now: () => '2026-08-26T15:00:00.000Z' }, {
    urlApi: { createObjectURL(blob) { renderedBlobs.push(blob); return 'blob:chrome-extension://test/print'; }, revokeObjectURL() {} },
    tabAdapter: successfulTabAdapter(),
    async pdfRenderer() { return { bytes: PDF, usedFallback: false, limitations: [] }; },
    downloadsAdapter: fakeDownloads([]),
  });
  assert.doesNotMatch(await renderedBlobs[0].text(), /TOPSECRET|origin\.test|blob:|chrome-extension:/iu);
  assert.doesNotMatch(`${result.html}\n${result.json}`, /TOPSECRET|origin\.test|blob:|chrome-extension:/iu);
});

test('adopts and cleans a tab that resolves after its creation timeout', async () => {
  const late = deferred();
  const removed = [];
  const resultPromise = runReportExport({ auditModel: clone(SAMPLE_AUDIT), now: () => '2026-08-26T15:00:00.000Z', timeoutMs: 5 }, {
    urlApi: { createObjectURL() { return 'blob:chrome-extension://test/print'; }, revokeObjectURL() {} },
    tabAdapter: {
      createPrintTab() { return late.promise; },
      async waitForReady() {}, async connectCdp() {}, async waitForAssets() {},
      async removeTab(id) { removed.push(id); throw new Error('TOPSECRET cleanup denied'); },
    },
    downloadsAdapter: fakeDownloads([]),
  });
  await resultPromise;
  late.resolve({ id: 91 });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(removed, [91]);
});

test('adopts and disconnects a CDP client that resolves after timeout without removing the tab twice', async () => {
  const late = deferred();
  const events = [];
  const resultPromise = runReportExport({ auditModel: clone(SAMPLE_AUDIT), now: () => '2026-08-26T15:00:00.000Z', timeoutMs: 5 }, {
    urlApi: { createObjectURL() { return 'blob:chrome-extension://test/print'; }, revokeObjectURL() {} },
    tabAdapter: {
      async createPrintTab() { return { id: 92 }; }, async waitForReady() {},
      connectCdp() { return late.promise; }, async waitForAssets() {},
      async removeTab(id) { events.push(['remove', id]); },
    },
    downloadsAdapter: fakeDownloads([]),
  });
  await resultPromise;
  late.resolve({ async disconnect() { events.push(['disconnect']); throw new Error('TOPSECRET cleanup denied'); } });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, [['remove', 92], ['disconnect']]);
});

function fakeDownloads(events) {
  let id = 0;
  return {
    createObjectURL(blob) { const url = `blob:chrome-extension://test/download-${id}`; events.push(['create-download-url', blob.type]); return url; },
    revokeObjectURL() { events.push(['revoke-download-url']); },
    async download(options) { id += 1; events.push(['download', options.filename]); return id; },
    async waitForDownload(downloadId) { events.push(['download-complete', downloadId]); return { id: downloadId, state: 'complete' }; },
  };
}

function successfulTabAdapter() {
  return {
    async createPrintTab() { return { id: 70 }; }, async waitForReady() {},
    async connectCdp() { return { async disconnect() {} }; }, async waitForAssets() {}, async removeTab() {},
  };
}

function deferred() {
  let resolve;
  const promise = new Promise(next => { resolve = next; });
  return { promise, resolve };
}
