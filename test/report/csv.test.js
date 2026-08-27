import assert from 'node:assert/strict';
import test from 'node:test';

import { SAMPLE_AUDIT } from '../../fixtures/audits/sample-audit.js';
import { createAuditModel } from '../../src/core/report/audit-model.js';
import {
  OCCURRENCE_CSV_COLUMNS,
  OCCURRENCE_CSV_VERSION,
  renderOccurrenceCsv,
} from '../../src/core/report/csv.js';
import { enrichAuditForReport } from '../../src/core/report/enrich-audit.js';

const HEADERS = [
  'csv_schema_version', 'audit_id', 'occurrence_id', 'page_id', 'page_url',
  'observed_at', 'outcome', 'classification', 'impact', 'confidence',
  'source_engine', 'source_version', 'source_rule_id', 'nbr_item_ref',
  'wcag_refs', 'section_508_refs', 'title', 'description', 'selector',
  'frame_path', 'accessible_preview', 'accessible_preview_source',
  'evidence_refs', 'consumer_basis_ref', 'evidence_hashes',
  'canonical_model_hash', 'evidence_manifest_hash',
];
const DETAIL_MARKER = '[detalhe disponível somente no HTML/JSON]';

test('serializes a deterministic RFC 4180 occurrence table with fixed versioned columns', () => {
  const csv = renderOccurrenceCsv(SAMPLE_AUDIT);
  const records = parseQuotedCsv(csv);

  assert.equal(OCCURRENCE_CSV_VERSION, 'audita-occurrences-v1');
  assert.deepEqual(OCCURRENCE_CSV_COLUMNS, HEADERS);
  assert.equal(renderOccurrenceCsv(SAMPLE_AUDIT), csv);
  assert.deepEqual([...new TextEncoder().encode(csv).subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(records.length, SAMPLE_AUDIT.occurrences.length + 1);
  assert.deepEqual(records[0], HEADERS);
  assert.deepEqual(records.slice(1).map(row => row[2]), SAMPLE_AUDIT.occurrences.map(value => value.occurrenceId));
  assert.deepEqual(asRecord(records[1]), {
    csv_schema_version: 'audita-occurrences-v1',
    audit_id: 'audit-sample-20260826',
    occurrence_id: 'occ-focus-failed',
    page_id: 'page-1',
    page_url: 'https://servico.exemplo.test',
    observed_at: '2026-08-26T14:02:01.000Z',
    outcome: 'failed',
    classification: 'requirement',
    impact: 'moderate',
    confidence: 'high',
    source_engine: 'audita-core',
    source_version: '1.0.0',
    source_rule_id: 'focus-visible',
    nbr_item_ref: '5.1.1',
    wcag_refs: '2.4.7',
    section_508_refs: 'us.revised-508.wcag20-aa.v1:2.4.7:AA',
    title: 'Indicador de foco visível',
    description: 'Requisito: não conformidade observada; detalhes disponíveis somente no HTML/JSON.',
    selector: DETAIL_MARKER,
    frame_path: '',
    accessible_preview: DETAIL_MARKER,
    accessible_preview_source: DETAIL_MARKER,
    evidence_refs: 'ev-full;ev-control',
    consumer_basis_ref: 'br.consumer.accessibility.fixed.v1',
    evidence_hashes: '',
    canonical_model_hash: '',
    evidence_manifest_hash: '',
  });
  assert.ok(csv.endsWith('\r\n'));
  assert.equal(csv.replace(/\r\n/gu, '').includes('\n'), false);
});

test('preserves canonical structural IDs for cross-artifact correlation', () => {
  const input = structuredClone(SAMPLE_AUDIT);
  input.occurrences[0].occurrenceId = 'occ-PRIVATE-record';

  const first = asRecord(parseQuotedCsv(renderOccurrenceCsv(input))[1]);

  assert.equal(first.occurrence_id, 'occ-PRIVATE-record');
});

test('projects every rich page-derived field to one fixed marker without mutating the model', () => {
  const input = structuredClone(SAMPLE_AUDIT);
  const nested = Array.from({ length: 5 }).reduce(value => globalThis.btoa(value), '<script>PRIVATE_NESTED()</script>');
  const png = 'Qk1G AAAAAAAA ADYAAAAo AAAA AQAAAAEA AAABABgA AAAQAAAA CwAA AAsA AAAAAAAAAAAAAAAA';
  input.occurrences[0].justification = `prefix<strong class PRIVATE_DESCRIPTION ${nested}`;
  input.occurrences[0].target.selector = `ZGF0YQ== Og== eA== ${png}`;
  input.occurrences[0].target.framePath = ['prefix<customer name=Alice', 'Ymxv Yjp4'];
  input.occurrences[0].accessiblePreview = 'A data: da reunião será amanhã. UFJJVg== QVRF';
  input.evidence.find(entry => entry.evidenceId === 'ev-control').accessibility.nameSource =
    `${globalThis.btoa('\xffPRIVATEzz')}\u2028\u2029`;
  const original = structuredClone(input);

  const csv = renderOccurrenceCsv(input);
  const first = asRecord(parseQuotedCsv(csv)[1]);

  assert.deepEqual(input, original);
  assert.equal(first.description,
    'Requisito: não conformidade observada; detalhes disponíveis somente no HTML/JSON.');
  assert.equal(first.selector, DETAIL_MARKER);
  assert.equal(first.frame_path, DETAIL_MARKER);
  assert.equal(first.accessible_preview, DETAIL_MARKER);
  assert.equal(first.accessible_preview_source, DETAIL_MARKER);
  assert.doesNotMatch(csv, /PRIVATE|NESTED|Alice|ZGF0|Ymxv|UFJJ|Qk1G|<script|<strong|<customer|\u2028|\u2029/iu);
});

test('omits raw HTML, resource URLs, encoded pixels and credential prose in every rich projection', () => {
  const payloads = [
    '<script data-customer="Alice">PRIVATE</script>',
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
    'blob:https://example.test/PRIVATE',
    'authorization=Bearer PRIVATE',
    'prefix<a data-customer=Alice>',
    'prefix<customer name=Alice>',
    'PHNj cg== aXB0 Pg==',
    'iVBOR w0KG goAA AANS UhEU gAAA AEAA AAEA',
  ];

  for (const payload of payloads) {
    const input = structuredClone(SAMPLE_AUDIT);
    input.occurrences[0].justification = payload;
    input.occurrences[0].target.selector = payload;
    input.occurrences[0].target.framePath = [payload];
    input.occurrences[0].accessiblePreview = payload;
    input.evidence.find(entry => entry.evidenceId === 'ev-control').accessibility.nameSource = payload;

    const csv = renderOccurrenceCsv(input);
    const first = asRecord(parseQuotedCsv(csv)[1]);

    assert.equal(first.selector, DETAIL_MARKER);
    assert.equal(first.frame_path, DETAIL_MARKER);
    assert.equal(first.accessible_preview, DETAIL_MARKER);
    assert.equal(first.accessible_preview_source, DETAIL_MARKER);
    assert.equal(first.description,
      'Requisito: não conformidade observada; detalhes disponíveis somente no HTML/JSON.');
    assert.equal(csv.includes(payload), false);
  }
});

test('exports only an HTTP(S) origin and removes credentials, path, query and fragment', () => {
  const input = structuredClone(SAMPLE_AUDIT);
  input.pages[0].finalUrl = 'https://user:pass@servico.exemplo.test:8443/private?token=PRIVATE#secret';

  const pageUrl = asRecord(parseQuotedCsv(renderOccurrenceCsv(input))[1]).page_url;

  assert.equal(pageUrl, 'https://servico.exemplo.test:8443');
  assert.doesNotMatch(renderOccurrenceCsv(input), /user|pass|private|token|secret/iu);
});

test('uses only local catalog titles and fixed outcome descriptions', () => {
  const input = structuredClone(SAMPLE_AUDIT);
  input.occurrences[0].justification = 'PRIVATE customer prose';

  const first = asRecord(parseQuotedCsv(renderOccurrenceCsv(input))[1]);

  assert.equal(first.title, 'Indicador de foco visível');
  assert.equal(first.description,
    'Requisito: não conformidade observada; detalhes disponíveis somente no HTML/JSON.');
  assert.doesNotMatch(JSON.stringify(first), /customer prose/iu);
});

test('does not expose invalid or non-attested hash-shaped values', () => {
  const input = structuredClone(SAMPLE_AUDIT);
  for (const artifact of input.evidence) artifact.hash = 'a'.repeat(64);
  input.integrity = {
    algorithm: 'SHA-256',
    canonicalModelHash: 'b'.repeat(64),
    evidenceManifestHash: 'c'.repeat(64),
  };
  const first = asRecord(parseQuotedCsv(renderOccurrenceCsv(input))[1]);

  assert.equal(first.evidence_hashes, '');
  assert.equal(first.canonical_model_hash, '');
  assert.equal(first.evidence_manifest_hash, '');
});

test('emits correlated hashes only from an integrity-verified immutable snapshot', async () => {
  const verified = await enrichAuditForReport(SAMPLE_AUDIT, {
    now: () => '2026-08-26T16:00:00.000Z',
    timezone: 'America/Cuiaba',
    manifestVersion: '0.1.0',
    rulesVersion: '1.0.0',
    browserVersion: 'Chrome/147.0.0.0',
  });

  const first = asRecord(parseQuotedCsv(renderOccurrenceCsv(verified))[1]);

  assert.match(first.evidence_hashes,
    /^ev-full=[a-f0-9]{64};ev-control=[a-f0-9]{64}$/u);
  assert.equal(first.canonical_model_hash, verified.integrity.canonicalModelHash);
  assert.equal(first.evidence_manifest_hash, verified.integrity.evidenceManifestHash);
});

test('neutralizes the spreadsheet surface by projecting hostile prefixes out of every rich cell', () => {
  const prefixes = ['=SUM(1,1)', '+cmd', '-2+3', '@formula', '\tprivate', '\rprivate'];
  const input = structuredClone(SAMPLE_AUDIT);
  input.occurrences = prefixes.map((value, index) => ({
    ...structuredClone(input.occurrences[0]),
    occurrenceId: `occ-formula-${index}`,
    justification: value,
    accessiblePreview: value,
  }));
  input.manualReview = [];
  input.reviewDecisions = [];
  const original = structuredClone(input);

  const rows = parseQuotedCsv(renderOccurrenceCsv(input)).slice(1).map(asRecord);

  assert.deepEqual(input, original);
  for (const row of rows) {
    for (const value of Object.values(row)) assert.doesNotMatch(value, /^[=+\-@\t\r]/u);
    assert.equal(row.accessible_preview, DETAIL_MARKER);
  }
});

test('resolves each occurrence URL and timestamp by pageId', () => {
  const input = structuredClone(SAMPLE_AUDIT);
  input.requestedScope = {
    mode: 'batch',
    urls: [...input.requestedScope.urls, 'https://segunda.example.test/solicitada'],
  };
  input.pages.push({
    pageId: 'page-2',
    requestedUrl: 'https://segunda.example.test/solicitada',
    finalUrl: 'https://segunda.example.test/final/private?token=hidden',
    status: 'failed',
    timestamps: {
      startedAt: '2026-08-26T14:03:00.000Z',
      endedAt: '2026-08-26T14:03:01.000Z',
      generatedAt: '2026-08-26T14:03:02.000Z',
    },
    viewport: { width: null, height: null, deviceScaleFactor: null },
  });
  input.occurrences.push({
    ...structuredClone(input.occurrences[0]),
    occurrenceId: 'occ-page-2',
    pageId: 'page-2',
    evidenceRefs: [],
    evidenceIds: [],
  });
  const canonical = createAuditModel(input);

  const pageTwo = parseQuotedCsv(renderOccurrenceCsv(canonical)).slice(1).map(asRecord)
    .find(row => row.occurrence_id === 'occ-page-2');

  assert.equal(pageTwo.page_url, 'https://segunda.example.test');
  assert.equal(pageTwo.observed_at, '2026-08-26T14:03:02.000Z');
});

test('fails closed on unknown page and cross-page evidence references', () => {
  const input = structuredClone(SAMPLE_AUDIT);
  const unknown = structuredClone(input);
  unknown.occurrences[0].pageId = 'page-missing';
  assert.throws(() => renderOccurrenceCsv(unknown), TypeError);

  const crossPage = structuredClone(input);
  crossPage.pages.push({
    ...structuredClone(crossPage.pages[0]),
    pageId: 'page-2',
  });
  crossPage.requestedScope = { mode: 'batch', urls: [...crossPage.requestedScope.urls, crossPage.pages[1].requestedUrl] };
  crossPage.occurrences[0].pageId = 'page-2';
  assert.throws(() => renderOccurrenceCsv(crossPage), TypeError);
});

test('exports header only for zero occurrences and preserves 512-occurrence canonical order', () => {
  const empty = structuredClone(SAMPLE_AUDIT);
  empty.occurrences = [];
  empty.manualReview = [];
  empty.reviewDecisions = [];
  assert.deepEqual(parseQuotedCsv(renderOccurrenceCsv(empty)), [HEADERS]);

  const large = structuredClone(empty);
  large.occurrences = Array.from({ length: 512 }, (_, index) => ({
    ...structuredClone(SAMPLE_AUDIT.occurrences[0]),
    occurrenceId: `occ-realistic-${String(index).padStart(4, '0')}`,
  }));
  const records = parseQuotedCsv(renderOccurrenceCsv(large));
  assert.equal(records.length, 513);
  assert.equal(records[1][2], 'occ-realistic-0000');
  assert.equal(records.at(-1)[2], 'occ-realistic-0511');
});

test('processes repeated long benign prose in bounded time without decoding or budget exhaustion', () => {
  const input = structuredClone(SAMPLE_AUDIT);
  const prose = 'A data: da reunião será amanhã; use x < y para comparar. '.repeat(20_000);
  input.occurrences = Array.from({ length: 32 }, (_, index) => ({
    ...structuredClone(input.occurrences[0]),
    occurrenceId: `occ-long-${index}`,
    justification: prose,
    accessiblePreview: prose,
  }));
  input.manualReview = [];
  input.reviewDecisions = [];

  const startedAt = performance.now();
  const records = parseQuotedCsv(renderOccurrenceCsv(input));

  assert.equal(records.length, 33);
  assert.ok(performance.now() - startedAt < 5_000);
  assert.equal(asRecord(records[1]).accessible_preview, DETAIL_MARKER);
});

test('fails closed on accessors and hostile proxies with a fixed non-sensitive error', () => {
  let accessed = false;
  const accessor = structuredClone(SAMPLE_AUDIT);
  Object.defineProperty(accessor.occurrences[0], 'privateValue', {
    enumerable: true,
    get() { accessed = true; return '=PRIVATE_SENTINEL'; },
  });
  assert.throws(
    () => renderOccurrenceCsv(accessor),
    error => error instanceof TypeError && error.message === 'Modelo CSV inválido ou contém propriedade insegura.',
  );
  assert.equal(accessed, false);

  const proxy = new Proxy(structuredClone(SAMPLE_AUDIT), {
    getPrototypeOf() { throw new Error('PRIVATE_PROXY_SENTINEL'); },
  });
  assert.throws(
    () => renderOccurrenceCsv(proxy),
    error => error instanceof TypeError && !error.message.includes('PRIVATE_PROXY_SENTINEL'),
  );

  const revocable = Proxy.revocable(structuredClone(SAMPLE_AUDIT), {});
  revocable.revoke();
  assert.throws(() => renderOccurrenceCsv(revocable.proxy), TypeError);
});

function asRecord(row) {
  return Object.fromEntries(HEADERS.map((header, index) => [header, row[index]]));
}

function parseQuotedCsv(csv) {
  assert.equal(csv[0], '\uFEFF');
  const records = [];
  let row = [];
  let index = 1;
  while (index < csv.length) {
    assert.equal(csv[index], '"', `field at offset ${index} must be quoted`);
    index += 1;
    let field = '';
    while (index < csv.length) {
      if (csv[index] !== '"') {
        field += csv[index];
        index += 1;
        continue;
      }
      if (csv[index + 1] === '"') {
        field += '"';
        index += 2;
        continue;
      }
      index += 1;
      break;
    }
    row.push(field);
    if (csv[index] === ',') {
      index += 1;
      continue;
    }
    assert.equal(csv.slice(index, index + 2), '\r\n');
    index += 2;
    records.push(row);
    row = [];
  }
  assert.deepEqual(row, []);
  return records;
}
