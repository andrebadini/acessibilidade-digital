import assert from 'node:assert/strict';
import test from 'node:test';

import { SAMPLE_AUDIT } from '../../fixtures/audits/sample-audit.js';
import { runReportExport } from '../../src/export/report-export.js';
import { commitReviewDecision } from '../../src/review/review-state.js';
import { createInMemoryAuditStore } from '../../src/storage/audit-store.js';

const PDF = new TextEncoder().encode('%PDF-1.7\nlocal');
const FALLBACK_PDF = new TextEncoder().encode('%PDF-1.7\nfinal-fallback');

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
  assert.deepEqual(result.formats.map(entry => entry.format), ['html', 'json', 'csv', 'pdf']);
  assert.ok(result.csv.startsWith('\uFEFF'));
  for (const occurrence of result.model.occurrences) {
    assert.match(result.csv, new RegExp(`"${occurrence.occurrenceId}"`, 'u'));
    assert.match(result.html, new RegExp(occurrence.occurrenceId, 'u'));
    assert.ok(technical.audit.occurrences.some(entry => entry.occurrenceId === occurrence.occurrenceId));
  }
  assert.doesNotMatch(JSON.stringify(result), /blob:chrome-extension/u);
});

test('a newer human review that wins the pre-delivery CAS prevents every stale download', async () => {
  const store = createInMemoryAuditStore();
  await store.setAudit(SAMPLE_AUDIT.auditId, clone(SAMPLE_AUDIT));
  const snapshot = await store.getAuditSnapshot(SAMPLE_AUDIT.auditId);
  const leaseOwnerId = 'owner-stale-review';
  const acquired = await store.acquireExportLease(SAMPLE_AUDIT.auditId, snapshot.capability, {
    ownerId: leaseOwnerId,
    now: '2026-08-26T14:59:58.000Z',
    latestState: { auditId: SAMPLE_AUDIT.auditId, exportStatus: 'queued', exportRevision: snapshot.revision },
  });
  await store.claimExportLease(SAMPLE_AUDIT.auditId, snapshot.capability, {
    ownerId: leaseOwnerId,
    now: '2026-08-26T14:59:59.000Z',
    latestState: { auditId: SAMPLE_AUDIT.auditId, exportStatus: 'running', exportRevision: snapshot.revision },
  });
  const events = [];

  await assert.rejects(runReportExport({
    auditSnapshotCapability: snapshot.capability,
    exportLeaseOwnerId: leaseOwnerId,
    exportAttempt: acquired.exportAttempt,
    now: () => '2026-08-26T15:00:00.000Z',
  }, {
    urlApi: { createObjectURL() { return 'blob:chrome-extension://test/print'; }, revokeObjectURL() {} },
    tabAdapter: successfulTabAdapter(),
    async pdfRenderer() { return { bytes: PDF, usedFallback: false, limitations: [] }; },
    downloadsAdapter: fakeDownloads(events),
    async assertDelivery() {},
    async recordDelivery() {},
    async reserveDelivery({ model }) {
      await commitReviewDecision(snapshot.model, {
        auditId: SAMPLE_AUDIT.auditId,
        itemId: '5.1.4',
        occurrenceId: 'occ-focus-review',
        answer: 'não foi possível determinar',
        evaluator: 'Pessoa avaliadora',
        decidedAt: '2026-08-26T15:01:00.000Z',
        mode: 'assisted',
      }, store);
      return store.commitAuditIfRevisionWithExportLease(
        SAMPLE_AUDIT.auditId,
        model,
        { auditId: SAMPLE_AUDIT.auditId, exportStatus: 'delivering' },
        snapshot.capability,
        { ownerId: leaseOwnerId, now: '2026-08-26T15:01:01.000Z', phase: 'delivering' },
      );
    },
  }), error => error?.code === 'AUDIT_REVISION_CONFLICT');

  assert.equal(events.some(entry => entry[0] === 'download'), false);
  assert.equal((await store.getAuditSnapshot(SAMPLE_AUDIT.auditId)).model.reviewDecisions.length, 1);
});

test('a review immediately after reservation revokes delivery before the first physical download', async () => {
  const store = createInMemoryAuditStore();
  await store.setAudit(SAMPLE_AUDIT.auditId, clone(SAMPLE_AUDIT));
  const snapshot = await store.getAuditSnapshot(SAMPLE_AUDIT.auditId);
  const leaseOwnerId = 'owner-post-reservation-review';
  const acquired = await store.acquireExportLease(SAMPLE_AUDIT.auditId, snapshot.capability, {
    ownerId: leaseOwnerId,
    now: '2026-08-26T14:59:58.000Z',
    latestState: { auditId: SAMPLE_AUDIT.auditId, exportStatus: 'queued', exportRevision: snapshot.revision },
  });
  await store.claimExportLease(SAMPLE_AUDIT.auditId, snapshot.capability, {
    ownerId: leaseOwnerId,
    now: '2026-08-26T14:59:59.000Z',
    latestState: { auditId: SAMPLE_AUDIT.auditId, exportStatus: 'running', exportRevision: snapshot.revision },
  });
  const events = [];

  await assert.rejects(runReportExport({
    auditSnapshotCapability: snapshot.capability,
    exportLeaseOwnerId: leaseOwnerId,
    exportAttempt: acquired.exportAttempt,
    now: () => '2026-08-26T15:00:00.000Z',
  }, {
    urlApi: { createObjectURL() { return 'blob:chrome-extension://test/print'; }, revokeObjectURL() {} },
    tabAdapter: successfulTabAdapter(),
    async pdfRenderer() { return { bytes: PDF, usedFallback: false, limitations: [] }; },
    downloadsAdapter: fakeDownloads(events),
    async recordDelivery() {},
    async reserveDelivery({ model }) {
      const reservation = await store.commitAuditIfRevisionWithExportLease(
        SAMPLE_AUDIT.auditId,
        model,
        { auditId: SAMPLE_AUDIT.auditId, exportStatus: 'delivering', exportRevision: snapshot.revision + 1 },
        snapshot.capability,
        { ownerId: leaseOwnerId, now: '2026-08-26T15:00:01.000Z', phase: 'delivering' },
      );
      await commitReviewDecision(snapshot.model, {
        auditId: SAMPLE_AUDIT.auditId,
        itemId: '5.1.4',
        occurrenceId: 'occ-focus-review',
        answer: 'não foi possível determinar',
        evaluator: 'Pessoa avaliadora',
        decidedAt: '2026-08-26T15:00:01.100Z',
        mode: 'assisted',
      }, store);
      return reservation;
    },
    async assertDelivery() {
      const lease = await store.getExportLeaseState(SAMPLE_AUDIT.auditId, {
        now: '2026-08-26T15:00:01.200Z',
      });
      if (!lease.active) {
        throw Object.assign(new Error('delivery lease revoked'), { code: 'AUDIT_EXPORT_LEASE_CONFLICT' });
      }
    },
  }), error => error?.code === 'AUDIT_EXPORT_LEASE_CONFLICT');

  assert.equal(events.some(entry => entry[0] === 'download'), false);
  const stored = await store.getAudit(SAMPLE_AUDIT.auditId);
  assert.equal(stored.reviewDecisions.length, 1);
  assert.notEqual(stored.report?.artifact?.status, 'pending');
  assert.equal((await store.getLatest()).exportStatus, 'preparing');
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

test('rejects hostile audit-model accessors before export cloning or rendering', async () => {
  const input = clone(SAMPLE_AUDIT);
  let accessed = false;
  Object.defineProperty(input.occurrences[0], 'privateValue', {
    enumerable: true,
    get() {
      accessed = true;
      return 'PRIVATE_EXPORT_MODEL_SENTINEL';
    },
  });
  const events = [];

  await assert.rejects(runReportExport({
    auditModel: input,
    now: () => '2026-08-26T15:00:00.000Z',
  }, {
    urlApi: { createObjectURL() { events.push('url'); }, revokeObjectURL() {} },
    tabAdapter: successfulTabAdapter(),
    downloadsAdapter: fakeDownloads(events),
  }), /modelo|auditoria|propriedade|segur/iu);

  assert.equal(accessed, false);
  assert.deepEqual(events, []);
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
  assert.deepEqual(result.formats.map(entry => entry.format), ['html', 'json', 'csv']);
  assert.deepEqual(result.deliveryReceipt, {
    status: 'partial',
    formats: result.formats,
    limitations: ['O PDF não foi gerado devido a uma limitação técnica local.'],
  });
  assert.equal(JSON.parse(result.json).audit.session.status, 'partial');
  assert.deepEqual(events.filter(entry => entry[0] === 'disconnect'), [['disconnect']]);
  assert.deepEqual(events.filter(entry => entry[0] === 'remove'), [['remove', 44]]);
});

test('contains a hostile print failure name accessor without invoking or serializing it', async () => {
  let accessed = false;
  const hostile = {};
  Object.defineProperty(hostile, 'name', {
    enumerable: true,
    get() { accessed = true; throw new Error('PRIVATE_SENTINEL'); },
  });
  const result = await runReportExport({ auditModel: clone(SAMPLE_AUDIT), now: () => '2026-08-26T15:00:00.000Z' }, {
    urlApi: { createObjectURL() { return 'blob:chrome-extension://test/print'; }, revokeObjectURL() {} },
    tabAdapter: successfulTabAdapter(),
    async pdfRenderer() { throw hostile; },
    downloadsAdapter: fakeDownloads([]),
  });

  assert.equal(accessed, false);
  assert.deepEqual(result.formats.map(entry => entry.format), ['html', 'json', 'csv']);
  assert.ok(result.model.session.diagnostics.some(entry => entry.code === 'REPORT_PDF_UNAVAILABLE'));
  assert.doesNotMatch(`${result.html}\n${result.json}\n${JSON.stringify(result)}`, /PRIVATE_SENTINEL/u);
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
  assert.deepEqual(result.formats.map(entry => entry.format), ['html', 'json', 'csv']);
  assert.deepEqual(events.filter(entry => entry[0] === 'revoke'), [['revoke', 'blob:chrome-extension://test/print']]);
});

test('descriptor-validates the temporary print tab without invoking ID accessors or accepting proxies', async () => {
  let accessed = false;
  const accessorTab = {};
  Object.defineProperty(accessorTab, 'id', {
    enumerable: true,
    get() { accessed = true; return 93; },
  });
  const invalidTabs = [accessorTab, new Proxy({ id: 94 }, {})];

  for (const tab of invalidTabs) {
    const events = [];
    const result = await runReportExport({ auditModel: clone(SAMPLE_AUDIT), now: () => '2026-08-26T15:00:00.000Z' }, {
      urlApi: { createObjectURL() { return 'blob:chrome-extension://test/print'; }, revokeObjectURL() {} },
      tabAdapter: {
        async createPrintTab() { return tab; },
        async waitForReady() { events.push(['unexpected-ready']); },
        async connectCdp() { events.push(['unexpected-connect']); },
        async waitForAssets() {},
        async removeTab(id) { events.push(['unexpected-remove', id]); },
      },
      async pdfRenderer() { events.push(['unexpected-pdf']); return { bytes: PDF, usedFallback: false, limitations: [] }; },
      downloadsAdapter: fakeDownloads(events),
    });

    assert.equal(accessed, false);
    assert.deepEqual(result.formats.map(entry => entry.format), ['html', 'json', 'csv']);
    assert.deepEqual(events.filter(entry => entry[0].startsWith('unexpected')), []);
    assert.ok(result.model.session.diagnostics.some(entry => entry.code === 'REPORT_PRINT_TAB_FAILED'));
  }
});

test('contains print Blob URL preparation failure as a PDF omission and still exports HTML JSON and CSV', async () => {
  const events = [];
  const result = await runReportExport({ auditModel: clone(SAMPLE_AUDIT), now: () => '2026-08-26T15:00:00.000Z' }, {
    urlApi: {
      createObjectURL() { throw new Error('PRIVATE_SENTINEL blob:https://origin.test/private'); },
      revokeObjectURL() { events.push(['unexpected-revoke']); },
    },
    tabAdapter: {
      async createPrintTab() { events.push(['unexpected-tab']); },
      async waitForReady() {}, async connectCdp() {}, async waitForAssets() {}, async removeTab() {},
    },
    downloadsAdapter: fakeDownloads(events),
  });

  assert.deepEqual(result.formats.map(entry => entry.format), ['html', 'json', 'csv']);
  assert.equal(result.model.session.status, 'partial');
  assert.equal(result.model.report.artifact.pdfFallback, false);
  assert.ok(result.model.session.diagnostics.some(entry => entry.code === 'REPORT_PDF_UNAVAILABLE'));
  assert.deepEqual(result.deliveryReceipt.limitations, ['O PDF não foi gerado devido a uma limitação técnica local.']);
  assert.deepEqual(events.filter(entry => entry[0].startsWith('unexpected')), []);
  assert.doesNotMatch(`${result.html}\n${result.json}\n${JSON.stringify(result)}`, /PRIVATE_SENTINEL|origin\.test|blob:/iu);
});

test('descriptor-validates and snapshots PDF renderer output before reading fallback state or bytes', async () => {
  let getterAccessed = false;
  const accessorResult = { bytes: PDF };
  Object.defineProperty(accessorResult, 'usedFallback', {
    enumerable: true,
    get() { getterAccessed = true; throw new Error('PRIVATE_SENTINEL'); },
  });
  const activeProxy = new Proxy({ bytes: PDF, usedFallback: false, limitations: [] }, {});
  const revoked = Proxy.revocable({ bytes: PDF, usedFallback: false, limitations: [] }, {});
  revoked.revoke();
  const invalidResults = [
    accessorResult,
    activeProxy,
    revoked.proxy,
    { bytes: { private: 'PRIVATE_SENTINEL' }, usedFallback: false },
    { bytes: new TextEncoder().encode('NOT-A-PDF PRIVATE_SENTINEL'), usedFallback: false },
    { bytes: PDF, usedFallback: 'false' },
  ];

  for (const rendered of invalidResults) {
    const events = [];
    const result = await runReportExport({ auditModel: clone(SAMPLE_AUDIT), now: () => '2026-08-26T15:00:00.000Z' }, {
      urlApi: { createObjectURL() { return 'blob:chrome-extension://test/print'; }, revokeObjectURL() {} },
      tabAdapter: successfulTabAdapter(),
      async pdfRenderer() { return rendered; },
      downloadsAdapter: fakeDownloads(events),
    });

    assert.deepEqual(result.formats.map(entry => entry.format), ['html', 'json', 'csv']);
    assert.equal(result.model.report.artifact.pdfFallback, false);
    assert.ok(result.model.session.diagnostics.some(entry => entry.code === 'REPORT_PDF_UNAVAILABLE'));
    assert.ok(events.every(entry => entry[0] !== 'download' || !entry[1].endsWith('.pdf')));
    assert.doesNotMatch(`${result.html}\n${result.json}\n${JSON.stringify(result)}`, /PRIVATE_SENTINEL|NOT-A-PDF/u);
  }
  assert.equal(getterAccessed, false);
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
  downloads.waitForDownload = async downloadId => downloadId === 3
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
  assert.deepEqual(result.deliveryReceipt.formats.map(format => format.status), ['complete', 'complete', 'timeout', 'complete']);
  assert.deepEqual(result.model.report.artifact.formats.map(format => format.format), ['html', 'json', 'csv', 'pdf']);
  assert.ok(result.model.report.artifact.formats.every(format => format.status === 'prepared'));
  assert.equal(Object.hasOwn(result.model.report.artifact, 'deliveryReceipt'), false);
  assert.doesNotMatch(JSON.stringify(result), /TOPSECRET|blob:|chrome-extension:/iu);
});

test('contains CSV preparation failure, records it in the final correlated model, and still downloads PDF', async () => {
  const result = await runReportExport({ auditModel: clone(SAMPLE_AUDIT), now: () => '2026-08-26T15:00:00.000Z' }, {
    urlApi: { createObjectURL() { return 'blob:chrome-extension://test/print'; }, revokeObjectURL() {} },
    tabAdapter: successfulTabAdapter(),
    async pdfRenderer() { return { bytes: PDF, usedFallback: false, limitations: [] }; },
    csvRenderer() { throw new Error('PRIVATE_SENTINEL https://origin.test/?token=x'); },
    downloadsAdapter: fakeDownloads([]),
  });
  assert.equal(result.model.session.status, 'partial');
  assert.match(result.model.limitations.join(' '), /CSV/iu);
  assert.deepEqual(result.formats.map(format => format.format), ['html', 'json', 'pdf']);
  assert.deepEqual(result.model.report.artifact.formats.map(format => format.format), ['html', 'json', 'pdf']);
  assert.deepEqual(JSON.parse(result.json).audit, result.model);
  assert.equal(result.csv, null);
  assert.deepEqual(result.deliveryReceipt, {
    status: 'partial',
    formats: result.formats,
    limitations: ['O CSV não foi gerado devido a uma limitação técnica local.'],
  });
  assert.doesNotMatch(`${result.html}\n${result.json}\n${JSON.stringify(result)}`, /PRIVATE_SENTINEL|origin\.test|token=/iu);
});

test('marks CSV unavailable when an occurrence has more than 256 evidence references without downloading a partial row', async () => {
  const input = clone(SAMPLE_AUDIT);
  const source = input.evidence.find(entry => entry.evidenceId === 'ev-full');
  const extra = Array.from({ length: 255 }, (_, index) => ({
    ...clone(source),
    evidenceId: `ev-export-boundary-${String(index).padStart(3, '0')}`,
  }));
  input.evidence.push(...extra);
  input.occurrences[0].evidenceRefs = [
    ...input.occurrences[0].evidenceRefs,
    ...extra.map(entry => entry.evidenceId),
  ];
  input.occurrences[0].evidenceIds = [...input.occurrences[0].evidenceRefs];
  const events = [];

  const result = await runReportExport({
    auditModel: input, now: () => '2026-08-26T15:00:00.000Z',
  }, {
    urlApi: { createObjectURL() { return 'blob:chrome-extension://test/print'; }, revokeObjectURL() {} },
    tabAdapter: successfulTabAdapter(),
    async pdfRenderer() { return { bytes: PDF, usedFallback: false, limitations: [] }; },
    downloadsAdapter: fakeDownloads(events),
  });

  assert.equal(result.csv, null);
  assert.equal(result.model.session.status, 'partial');
  assert.deepEqual(result.model.report.artifact.formats.map(entry => entry.format), ['html', 'json', 'pdf']);
  assert.deepEqual(result.formats.map(entry => entry.format), ['html', 'json', 'pdf']);
  assert.ok(result.model.session.diagnostics.some(entry => entry.code === 'REPORT_CSV_UNAVAILABLE'));
  assert.deepEqual(result.deliveryReceipt.limitations, ['O CSV não foi gerado devido a uma limitação técnica local.']);
  assert.equal(events.some(entry => entry[0] === 'download' && entry[1].endsWith('.csv')), false);
});

test('prints the exact final canonical HTML after CSV availability is known, including timestamp, hash and limitation', async () => {
  const printBlobs = [];
  const result = await runReportExport({
    auditModel: clone(SAMPLE_AUDIT), now: () => '2026-08-26T15:00:00.000Z',
  }, {
    urlApi: {
      createObjectURL(blob) { printBlobs.push(blob); return `blob:chrome-extension://test/print-${printBlobs.length}`; },
      revokeObjectURL() {},
    },
    tabAdapter: successfulTabAdapter(),
    csvRenderer() { throw new Error('PRIVATE_SENTINEL'); },
    async pdfRenderer() { return { bytes: PDF, usedFallback: false, limitations: [] }; },
    downloadsAdapter: fakeDownloads([]),
  });

  assert.equal(printBlobs.length, 1);
  const printedHtml = await printBlobs[0].text();
  assert.equal(printedHtml, result.html);
  assert.match(printedHtml, /2026-08-26T15:00:00\.000Z/u);
  assert.match(printedHtml, new RegExp(result.model.integrity.canonicalModelHash, 'u'));
  assert.match(printedHtml, /CSV não foi gerado/iu);
  assert.deepEqual(JSON.parse(result.json).audit, result.model);
  assert.equal(result.csv, null);
  assert.doesNotMatch(printedHtml, /PRIVATE_SENTINEL/u);
});

test('discards a provisional fallback PDF and rerenders the exact final fallback model in compatible mode', async () => {
  const printBlobs = [];
  const renderOptions = [];
  const result = await runReportExport({
    auditModel: clone(SAMPLE_AUDIT), now: () => '2026-08-26T15:00:00.000Z',
  }, {
    urlApi: {
      createObjectURL(blob) { printBlobs.push(blob); return `blob:chrome-extension://test/print-${printBlobs.length}`; },
      revokeObjectURL() {},
    },
    tabAdapter: successfulTabAdapter(),
    async pdfRenderer(_cdp, options) {
      renderOptions.push(options ?? null);
      return renderOptions.length === 1
        ? { bytes: PDF, usedFallback: true, limitations: ['controlled provisional fallback'] }
        : { bytes: FALLBACK_PDF, usedFallback: true, limitations: ['controlled final fallback'] };
    },
    downloadsAdapter: fakeDownloads([]),
  });

  assert.deepEqual(renderOptions, [null, { forceCompatible: true }]);
  assert.equal(printBlobs.length, 2);
  assert.notEqual(await printBlobs[0].text(), result.html);
  assert.equal(await printBlobs[1].text(), result.html);
  assert.deepEqual(result.pdf, FALLBACK_PDF);
  assert.equal(result.pdfFallback, true);
  assert.equal(result.model.report.artifact.pdfFallback, true);
  assert.match(result.html, new RegExp(result.model.integrity.canonicalModelHash, 'u'));
  assert.match(result.html, /estrutura|marcação|outline/iu);
  assert.equal(result.csv, (await import('../../src/core/report/csv.js')).renderOccurrenceCsv(result.model));
});

test('fails closed and omits PDF when a final fallback rerender diverges from its declared mode', async () => {
  const printBlobs = [];
  let renders = 0;
  const result = await runReportExport({
    auditModel: clone(SAMPLE_AUDIT), now: () => '2026-08-26T15:00:00.000Z',
  }, {
    urlApi: {
      createObjectURL(blob) { printBlobs.push(blob); return `blob:chrome-extension://test/print-${printBlobs.length}`; },
      revokeObjectURL() {},
    },
    tabAdapter: successfulTabAdapter(),
    async pdfRenderer() {
      renders += 1;
      return renders === 1
        ? { bytes: PDF, usedFallback: true, limitations: ['controlled provisional fallback'] }
        : { bytes: FALLBACK_PDF, usedFallback: false, limitations: [] };
    },
    downloadsAdapter: fakeDownloads([]),
  });

  assert.equal(renders, 2);
  assert.equal(result.pdf, null);
  assert.equal(result.pdfFallback, false);
  assert.deepEqual(result.formats.map(entry => entry.format), ['html', 'json', 'csv']);
  assert.deepEqual(result.model.report.artifact.formats.map(entry => entry.format), ['html', 'json', 'csv']);
  assert.ok(result.model.session.diagnostics.some(entry => entry.code === 'REPORT_PDF_UNAVAILABLE'));
  assert.deepEqual(JSON.parse(result.json).audit, result.model);
  assert.equal(result.csv, (await import('../../src/core/report/csv.js')).renderOccurrenceCsv(result.model));
  assert.notEqual(await printBlobs.at(-1).text(), result.html);
});

test('keeps late print cleanup outside the printed model and marks the controlled delivery receipt partial', async () => {
  const printBlobs = [];
  const result = await runReportExport({
    auditModel: clone(SAMPLE_AUDIT), now: () => '2026-08-26T15:00:00.000Z',
  }, {
    urlApi: {
      createObjectURL(blob) { printBlobs.push(blob); return 'blob:chrome-extension://test/print'; },
      revokeObjectURL() {},
    },
    tabAdapter: {
      async createPrintTab() { return { id: 81 }; }, async waitForReady() {},
      async connectCdp() { return { async disconnect() {} }; }, async waitForAssets() {},
      async removeTab() { throw new Error('PRIVATE_CLEANUP_SENTINEL'); },
    },
    async pdfRenderer() { return { bytes: PDF, usedFallback: false, limitations: [] }; },
    downloadsAdapter: fakeDownloads([]),
  });

  assert.equal(await printBlobs[0].text(), result.html);
  assert.equal(result.deliveryReceipt.status, 'partial');
  assert.deepEqual(result.deliveryReceipt.limitations, [
    'A limpeza de um recurso temporário de impressão não pôde ser confirmada.',
  ]);
  assert.deepEqual(JSON.parse(result.json).audit, result.model);
  assert.doesNotMatch(`${result.html}\n${result.json}\n${JSON.stringify(result)}`, /PRIVATE_CLEANUP_SENTINEL/u);
});

test('treats non-string, non-BOM or noncanonical CSV renderer output as a generation failure and still downloads PDF', async () => {
  for (const rendered of [
    new Uint8Array([0x50, 0x52, 0x49, 0x56, 0x41, 0x54, 0x45]),
    '"id"\r\n"PRIVATE_SENTINEL"\r\n',
    '\uFEFF"description"\r\n"token=PRIVATE_SENTINEL"\r\n',
  ]) {
    const events = [];
    const result = await runReportExport({ auditModel: clone(SAMPLE_AUDIT), now: () => '2026-08-26T15:00:00.000Z' }, {
      urlApi: { createObjectURL() { return 'blob:chrome-extension://test/print'; }, revokeObjectURL() {} },
      tabAdapter: successfulTabAdapter(),
      async pdfRenderer() { return { bytes: PDF, usedFallback: false, limitations: [] }; },
      csvRenderer() { return rendered; },
      downloadsAdapter: fakeDownloads(events),
    });

    assert.equal(result.csv, null);
    assert.equal(result.model.session.status, 'partial');
    assert.deepEqual(result.model.report.artifact.formats.map(entry => entry.format), ['html', 'json', 'pdf']);
    assert.deepEqual(result.formats.map(entry => entry.format), ['html', 'json', 'pdf']);
    assert.deepEqual(result.deliveryReceipt.limitations, ['O CSV não foi gerado devido a uma limitação técnica local.']);
    assert.equal(result.deliveryReceipt.status, 'partial');
    assert.ok(events.some(entry => entry[0] === 'download' && entry[1].endsWith('.pdf')));
    assert.ok(result.model.session.diagnostics.some(entry => entry.code === 'REPORT_CSV_UNAVAILABLE'));
    assert.doesNotMatch(`${result.html}\n${result.json}\n${JSON.stringify(result)}`, /PRIVATE_SENTINEL/u);
  }
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
  const result = await resultPromise;
  assert.equal(result.deliveryReceipt.status, 'partial');
  assert.ok(result.deliveryReceipt.limitations.includes(
    'A limpeza de um recurso temporário de impressão não pôde ser confirmada.',
  ));
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
  const result = await resultPromise;
  assert.equal(result.deliveryReceipt.status, 'partial');
  assert.ok(result.deliveryReceipt.limitations.includes(
    'A limpeza de um recurso temporário de impressão não pôde ser confirmada.',
  ));
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
