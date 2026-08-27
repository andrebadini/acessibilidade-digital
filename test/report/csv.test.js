import assert from 'node:assert/strict';
import test from 'node:test';

import { SAMPLE_AUDIT } from '../../fixtures/audits/sample-audit.js';
import { createAuditModel } from '../../src/core/report/audit-model.js';
import {
  OCCURRENCE_CSV_COLUMNS,
  OCCURRENCE_CSV_VERSION,
  renderOccurrenceCsv,
} from '../../src/core/report/csv.js';

const HEADERS = [
  'csv_schema_version', 'audit_id', 'occurrence_id', 'page_id', 'page_url',
  'observed_at', 'outcome', 'classification', 'impact', 'confidence',
  'source_engine', 'source_version', 'source_rule_id', 'nbr_item_ref',
  'wcag_refs', 'section_508_refs', 'title', 'description', 'selector',
  'frame_path', 'accessible_preview', 'accessible_preview_source',
  'evidence_refs', 'consumer_basis_ref', 'evidence_hashes',
  'canonical_model_hash', 'evidence_manifest_hash',
];

test('serializes one deterministic RFC 4180 row per canonical occurrence with a versioned fixed header', () => {
  const csv = renderOccurrenceCsv(SAMPLE_AUDIT);
  const records = parseQuotedCsv(csv);

  assert.equal(OCCURRENCE_CSV_VERSION, 'audita-occurrences-v1');
  assert.deepEqual(OCCURRENCE_CSV_COLUMNS, HEADERS);
  assert.ok(csv.startsWith(`\uFEFF${HEADERS.map(value => `"${value}"`).join(',')}\r\n`));
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
    page_url: 'https://servico.exemplo.test/consulta/inicio',
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
    description: 'O indicador de foco observado não tem contraste suficiente.',
    selector: '#continuar',
    frame_path: '',
    accessible_preview: 'Continuar, botão, Avança para a próxima etapa',
    accessible_preview_source: 'aria-label',
    evidence_refs: 'ev-full;ev-control',
    consumer_basis_ref: 'br.consumer.accessibility.fixed.v1',
    evidence_hashes: 'ev-full=sha256-full-page-sample;ev-control=sha256-element-sample',
    canonical_model_hash: 'model-hash-pending-export',
    evidence_manifest_hash: 'evidence-hash-sample',
  });
  assert.equal(new TextDecoder('utf-8', { ignoreBOM: true }).decode(new TextEncoder().encode(csv)), csv);
  assert.equal(csv.replace(/\r\n/gu, '').includes('\n'), false);
});

test('quotes commas, quotes, multiline Unicode text and replaces unsafe controls without exporting evidence pixels or nested records', () => {
  const input = structuredClone(SAMPLE_AUDIT);
  input.occurrences[0].justification = 'Linha 1, “ação”\r\n"citada"\u0000\u0007\n終わり';
  input.occurrences[0].privatePayload = { rawHtml: '<script>PRIVATE_SENTINEL()</script>' };
  input.evidence[0].privatePayload = { patient: 'PRIVATE_SENTINEL' };
  const original = structuredClone(input);

  const csv = renderOccurrenceCsv(input);
  const first = asRecord(parseQuotedCsv(csv)[1]);

  assert.deepEqual(input, original);
  assert.equal(first.description, 'Linha 1, “ação”\r\n"citada"��\n終わり');
  assert.match(csv, /"Linha 1, “ação”\r\n""citada""��\n終わり"/u);
  assert.doesNotMatch(csv, /PRIVATE_SENTINEL|<script|data:image|iVBOR|privatePayload/iu);
});

test('neutralizes every spreadsheet-danger prefix once in CSV only and leaves safe leading characters unchanged', () => {
  const prefixes = ['=SUM(1,1)', '+cmd', '-2+3', '@formula', '\tprivate', '\rprivate', "'already-text", ' safe'];
  const input = structuredClone(SAMPLE_AUDIT);
  input.occurrences = prefixes.map((accessiblePreview, index) => ({
    ...structuredClone(input.occurrences[0]),
    occurrenceId: `occ-formula-${index}`,
    accessiblePreview,
  }));
  input.manualReview = [];
  input.reviewDecisions = [];
  const original = structuredClone(input);

  const rows = parseQuotedCsv(renderOccurrenceCsv(input)).slice(1).map(asRecord);

  assert.deepEqual(input, original);
  assert.deepEqual(rows.map(row => row.accessible_preview), [
    "'=SUM(1,1)", "'+cmd", "'-2+3", "'@formula", "'\tprivate", "'\rprivate", "'already-text", ' safe',
  ]);
});

test('resolves each page URL by pageId and rejects unknown or cross-page links instead of guessing', () => {
  const input = structuredClone(SAMPLE_AUDIT);
  input.requestedScope = {
    mode: 'batch',
    urls: [...input.requestedScope.urls, 'https://segunda.example.test/solicitada'],
  };
  input.pages.push({
    pageId: 'page-2',
    requestedUrl: 'https://segunda.example.test/solicitada',
    finalUrl: 'https://segunda.example.test/final',
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
  assert.equal(pageTwo.page_url, 'https://segunda.example.test/final');
  assert.equal(pageTwo.observed_at, '2026-08-26T14:03:02.000Z');

  const unknown = structuredClone(canonical);
  unknown.occurrences.at(-1).pageId = 'page-missing';
  assert.throws(() => renderOccurrenceCsv(unknown), /página|pageId|desconhecida/iu);

  const crossPage = structuredClone(canonical);
  crossPage.occurrences.at(-1).evidenceRefs = ['ev-full'];
  crossPage.occurrences.at(-1).evidenceIds = ['ev-full'];
  assert.throws(() => renderOccurrenceCsv(crossPage), /outra página/iu);
});

test('exports only the header for zero occurrences and keeps a realistic 512-occurrence set in canonical order', () => {
  const empty = structuredClone(SAMPLE_AUDIT);
  empty.occurrences = [];
  empty.manualReview = [];
  empty.reviewDecisions = [];
  const emptyRecords = parseQuotedCsv(renderOccurrenceCsv(empty));
  assert.deepEqual(emptyRecords, [HEADERS]);

  const large = structuredClone(empty);
  large.occurrences = Array.from({ length: 512 }, (_, index) => ({
    ...structuredClone(SAMPLE_AUDIT.occurrences[0]),
    occurrenceId: `occ-realistic-${String(index).padStart(4, '0')}`,
  }));
  const csv = renderOccurrenceCsv(large);
  const records = parseQuotedCsv(csv);
  assert.equal(records.length, 513);
  assert.equal(records[1][2], 'occ-realistic-0000');
  assert.equal(records.at(-1)[2], 'occ-realistic-0511');
  assert.ok(new TextEncoder().encode(csv).byteLength < 8 * 1024 * 1024);
});

test('bounds individual text deterministically and rejects oversized total output explicitly', () => {
  const input = structuredClone(SAMPLE_AUDIT);
  input.occurrences[0].accessiblePreview = 'A'.repeat(40_000);
  const preview = asRecord(parseQuotedCsv(renderOccurrenceCsv(input))[1]).accessible_preview;
  assert.equal([...preview].length, 32_000);
  assert.match(preview, /…\[truncated\]$/u);

  const huge = structuredClone(SAMPLE_AUDIT);
  huge.occurrences = Array.from({ length: 264 }, (_, index) => ({
    ...structuredClone(SAMPLE_AUDIT.occurrences[0]),
    occurrenceId: `occ-huge-${index}`,
    accessiblePreview: 'A'.repeat(32_000),
  }));
  huge.manualReview = [];
  huge.reviewDecisions = [];
  assert.throws(() => renderOccurrenceCsv(huge), /CSV|limite|tamanho/iu);
});

test('fails closed on accessors and revoked proxies without evaluating private values', () => {
  let accessed = false;
  const hostile = structuredClone(SAMPLE_AUDIT);
  Object.defineProperty(hostile.occurrences[0], 'privateValue', {
    enumerable: true,
    get() { accessed = true; return '=PRIVATE_SENTINEL'; },
  });
  assert.throws(() => renderOccurrenceCsv(hostile), /segur|propriedade|JSON|canônico/iu);
  assert.equal(accessed, false);

  const { proxy, revoke } = Proxy.revocable(structuredClone(SAMPLE_AUDIT), {});
  revoke();
  assert.throws(() => renderOccurrenceCsv(proxy), TypeError);
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
