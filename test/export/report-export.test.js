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

function fakeDownloads(events) {
  let id = 0;
  return {
    createObjectURL(blob) { const url = `blob:chrome-extension://test/download-${id}`; events.push(['create-download-url', blob.type]); return url; },
    revokeObjectURL() { events.push(['revoke-download-url']); },
    async download(options) { id += 1; events.push(['download', options.filename]); return id; },
    async waitForDownload(downloadId) { events.push(['download-complete', downloadId]); return { id: downloadId, state: 'complete' }; },
  };
}
