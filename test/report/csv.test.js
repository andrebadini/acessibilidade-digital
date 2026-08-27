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

test('preserves canonical structural IDs containing privacy-like words for cross-artifact correlation', () => {
  const input = structuredClone(SAMPLE_AUDIT);
  input.occurrences[0].occurrenceId = 'occ-PRIVATE-record';

  const first = asRecord(parseQuotedCsv(renderOccurrenceCsv(input))[1]);

  assert.equal(first.occurrence_id, 'occ-PRIVATE-record');
  assert.notEqual(first.occurrence_id, '[conteúdo sensível omitido]');
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

test('projects every page-derived scalar through one privacy boundary before writing CSV bytes', () => {
  const input = structuredClone(SAMPLE_AUDIT);
  const hostileUrl = 'https://user:pass@servico.exemplo.test/consulta/inicio?token=URL_PRIVATE&view=public';
  input.requestedScope.urls[0] = hostileUrl;
  input.pages[0].requestedUrl = hostileUrl;
  input.pages[0].finalUrl = hostileUrl;
  input.requestedUrl = hostileUrl;
  input.finalUrl = hostileUrl;
  input.occurrences[0].justification = '<script>DESCRIPTION_PRIVATE()</script>';
  input.occurrences[0].target.selector = 'button[data-icon="data:image/png;base64,SELECTOR_PRIVATE"]';
  input.occurrences[0].target.framePath = [
    'blob:https://origin.test/FRAME_PRIVATE',
    'resource:FRAME_PAYLOAD',
  ];
  input.occurrences[0].accessiblePreview = `authorization=PREVIEW_PRIVATE dados ${'QUJD'.repeat(100)}`;
  input.evidence.find(entry => entry.evidenceId === 'ev-control').accessibility.nameSource =
    '<img src=x onerror=SOURCE_PRIVATE()>';
  const original = structuredClone(input);

  const csv = renderOccurrenceCsv(input);
  const first = asRecord(parseQuotedCsv(csv)[1]);

  assert.deepEqual(input, original);
  assert.equal(first.page_url, 'https://servico.exemplo.test/consulta/inicio?view=public');
  assert.equal(first.description, '[marcação omitida]');
  assert.equal(first.selector, '[recurso omitido]');
  assert.equal(first.frame_path, '[recurso omitido]');
  assert.equal(first.accessible_preview, '[recurso omitido]');
  assert.equal(first.accessible_preview_source, '[marcação omitida]');
  assert.doesNotMatch(csv, /URL_PRIVATE|DESCRIPTION_PRIVATE|SELECTOR_PRIVATE|FRAME_PRIVATE|FRAME_PAYLOAD|PREVIEW_PRIVATE|SOURCE_PRIVATE|data:|blob:|resource:|<script|<img|QUJDQUJD/iu);
});

test('preserves ordinary human prose containing less-than signs while omitting tag-like markup', () => {
  const input = structuredClone(SAMPLE_AUDIT);
  input.occurrences[0].justification = 'Use x<y quando comparar; 2 < 3 e 5 > 4.';
  input.occurrences[0].accessiblePreview = 'valor <limite superior, botão';
  input.evidence.find(entry => entry.evidenceId === 'ev-control').accessibility.nameSource = 'texto < contexto';

  const first = asRecord(parseQuotedCsv(renderOccurrenceCsv(input))[1]);

  assert.equal(first.description, 'Use x<y quando comparar; 2 < 3 e 5 > 4.');
  assert.equal(first.accessible_preview, 'valor <limite superior, botão');
  assert.equal(first.accessible_preview_source, 'texto < contexto');
});

test('distinguishes chained comparison prose from incomplete custom-element markup', () => {
  const input = structuredClone(SAMPLE_AUDIT);
  input.occurrences[0].justification =
    'Use x<b>c ao comparar. Se x<y e z=1, então continue. Compare x<y-z quando necessário. ' +
    'Se a<b e c=1, mantenha o intervalo. Se a<b e disabled estiver falso, prossiga. ' +
    'Em x\u0301<b>c, preserve o identificador decomposto. Compare x<time quando necessário. ' +
    'Compare x<time. Use x<code>y ao comparar.';
  input.occurrences[0].accessiblePreview = 'Texto antes<my-widget data-customer=Alice';
  input.evidence.find(entry => entry.evidenceId === 'ev-control').accessibility.nameSource =
    'Texto antes<my-widget>';

  const first = asRecord(parseQuotedCsv(renderOccurrenceCsv(input))[1]);

  assert.equal(first.description,
    'Use x<b>c ao comparar. Se x<y e z=1, então continue. Compare x<y-z quando necessário. ' +
    'Se a<b e c=1, mantenha o intervalo. Se a<b e disabled estiver falso, prossiga. ' +
    'Em x\u0301<b>c, preserve o identificador decomposto. Compare x<time quando necessário. ' +
    'Compare x<time. Use x<code>y ao comparar.');
  assert.equal(first.accessible_preview, '[marcação omitida]');
  assert.equal(first.accessible_preview_source, '[marcação omitida]');
  assert.doesNotMatch(first.accessible_preview, /my-widget|data-customer|Alice/iu);
});

test('omits explicit self-closing and void-element markup even when adjacent to text', () => {
  const input = structuredClone(SAMPLE_AUDIT);
  input.occurrences[0].justification = 'Texto<span/>seguinte';
  input.occurrences[0].accessiblePreview = 'Texto<span />seguinte';
  input.occurrences[0].target.selector = 'Texto<br/>seguinte';
  input.occurrences[0].target.framePath = ['Texto<br>seguinte'];

  const first = asRecord(parseQuotedCsv(renderOccurrenceCsv(input))[1]);

  assert.equal(first.description, '[marcação omitida]');
  assert.equal(first.accessible_preview, '[marcação omitida]');
  assert.equal(first.selector, '[marcação omitida]');
  assert.equal(first.frame_path, '[marcação omitida]');
});

test('omits short bounded base64 layers that hide resources, markup, pixels and credentials', () => {
  const input = structuredClone(SAMPLE_AUDIT);
  const encode = value => globalThis.btoa(value);
  const encodeLayers = (value, layers) => Array.from({ length: layers }).reduce(current => encode(current), value);
  const encodeUrl = value => globalThis.btoa(String.fromCharCode(...new TextEncoder().encode(value)))
    .replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
  const pixel = String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00);
  input.occurrences[0].accessiblePreview = encode('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB');
  input.occurrences[0].justification = encode(encode('<script>NESTED_MARKUP_SENTINEL'));
  input.occurrences[0].target.selector = encode(encode(pixel));
  input.occurrences[0].target.framePath = [encodeUrl('data:text/plain,ÿ')];
  const targetEvidence = input.evidence.find(entry => entry.evidenceId === 'ev-control');
  targetEvidence.accessibility.nameSource = encode('auth=NESTED_CREDENTIAL_SENTINEL');
  targetEvidence.hash = encode('to\u0000ken=CONTROL_SPLIT_SENTINEL');
  input.integrity.canonicalModelHash = encodeLayers('data:x', 4);

  const first = asRecord(parseQuotedCsv(renderOccurrenceCsv(input))[1]);

  assert.equal(first.accessible_preview, '[recurso omitido]');
  assert.equal(first.description, '[marcação omitida]');
  assert.equal(first.selector, '[recurso omitido]');
  assert.equal(first.frame_path, '[recurso omitido]');
  assert.equal(first.accessible_preview_source, '[conteúdo sensível omitido]');
  assert.equal(first.evidence_hashes, '[conteúdo sensível omitido]');
  assert.equal(first.canonical_model_hash, '[recurso omitido]');
  assert.doesNotMatch(JSON.stringify(first), /ZGF0YT|UE5H|NESTED|SENTINEL|iVBOR|<script/iu);
});

test('preserves canonical base64 text whose decoded view is ordinary public prose', () => {
  const input = structuredClone(SAMPLE_AUDIT);
  const safeToken = globalThis.btoa('ordinary public announcement');
  input.occurrences[0].accessiblePreview = safeToken;

  const preview = asRecord(parseQuotedCsv(renderOccurrenceCsv(input))[1]).accessible_preview;

  assert.equal(preview, safeToken);
});

test('omits incomplete generic markup without treating mathematical less-than prose as HTML', () => {
  const input = structuredClone(SAMPLE_AUDIT);
  input.occurrences[0].justification = '<div data-customer=Alice';
  input.occurrences[0].accessiblePreview = 'A comparação observada foi 2 < 3, botão';

  const first = asRecord(parseQuotedCsv(renderOccurrenceCsv(input))[1]);

  assert.equal(first.description, '[marcação omitida]');
  assert.equal(first.accessible_preview, 'A comparação observada foi 2 < 3, botão');
  assert.doesNotMatch(first.description, /data-customer|Alice/iu);
});

test('classifies encoded resources, control-split credentials, incomplete markup and selected private metadata', () => {
  const input = structuredClone(SAMPLE_AUDIT);
  input.pages[0].finalUrl =
    'https://servico.exemplo.test/final?preview=data%3Aimage%2Fpng%3Bbase64%2CQ1NWX1VSTF9TRU5USU5FTA%3D%3D';
  input.occurrences[0].justification = '<script DESCRIPTION_PRIVATE_SENTINEL';
  input.occurrences[0].target.selector = 'javascript:SELECTOR_PRIVATE_SENTINEL';
  input.occurrences[0].target.framePath = ['resource:public FRAME_PRIVATE_SENTINEL'];
  input.occurrences[0].accessiblePreview = 'to\u0000ken=PREVIEW_PRIVATE_SENTINEL';
  const targetEvidence = input.evidence.find(entry => entry.evidenceId === 'ev-control');
  targetEvidence.accessibility.nameSource = [
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
    'QUJD'.repeat(20),
    'REVG'.repeat(20),
    'SOURCE_PRIVATE_SENTINEL',
  ].join('\n');
  targetEvidence.hash = 'PRIVATE_EVIDENCE_HASH_SENTINEL';
  input.integrity.canonicalModelHash = 'auth=MODEL_HASH_PRIVATE_SENTINEL';
  input.integrity.evidenceManifestHash = 'PRIVATE_MANIFEST_HASH_SENTINEL';
  const original = structuredClone(input);

  const csv = renderOccurrenceCsv(input);
  const first = asRecord(parseQuotedCsv(csv)[1]);

  assert.deepEqual(input, original);
  assert.equal(first.page_url, '[recurso omitido]');
  assert.equal(first.description, '[marcação omitida]');
  assert.equal(first.selector, '[marcação omitida]');
  assert.equal(first.frame_path, '[recurso omitido]');
  assert.equal(first.accessible_preview, '[conteúdo sensível omitido]');
  assert.equal(first.accessible_preview_source, '[recurso omitido]');
  assert.equal(first.evidence_hashes, '[conteúdo sensível omitido]');
  assert.equal(first.canonical_model_hash, 'auth=[redacted]');
  assert.equal(first.evidence_manifest_hash, '[conteúdo sensível omitido]');
  assert.doesNotMatch(csv, /PRIVATE|SENTINEL|iVBOR|QUJD|REVG|data(?::|%3A)|resource:|javascript:|<script/iu);
});

test('keeps scanning valid percent escapes when a different escape is malformed', () => {
  const input = structuredClone(SAMPLE_AUDIT);
  input.pages[0].finalUrl =
    'https://servico.exemplo.test/final?bad=%ZZ&preview=data%3Atext%2Fplain%3Bbase64%2CSGVsbG8';

  const pageUrl = asRecord(parseQuotedCsv(renderOccurrenceCsv(input))[1]).page_url;

  assert.equal(pageUrl, '[recurso omitido]');
  assert.doesNotMatch(pageUrl, /%ZZ|data|SGVsbG8/iu);
});

test('omits resource payloads hidden behind nested percent encoding', () => {
  for (const encoded of [
    'data%253Atext%252Fplain%253Bbase64%252CSGVsbG8',
    '%252564%252561%252574%252561%25253Atext%25252Fplain%25253Bbase64%25252CSGVsbG8',
  ]) {
    const input = structuredClone(SAMPLE_AUDIT);
    input.pages[0].finalUrl = `https://servico.exemplo.test/final?preview=${encoded}`;

    const pageUrl = asRecord(parseQuotedCsv(renderOccurrenceCsv(input))[1]).page_url;

    assert.equal(pageUrl, '[recurso omitido]');
    assert.doesNotMatch(pageUrl, /data|base64|SGVsbG8|%25/iu);
  }
});

test('omits long base64 payloads split by spaces without collapsing ordinary prose', () => {
  const input = structuredClone(SAMPLE_AUDIT);
  input.occurrences[0].accessiblePreview = Array.from({ length: 40 }, () => 'QUJD').join(' ');
  input.occurrences[0].justification =
    'This ordinary announcement preserves a long human sentence with common words and natural spaces for every reader. '.repeat(3);

  const first = asRecord(parseQuotedCsv(renderOccurrenceCsv(input))[1]);

  assert.equal(first.accessible_preview, '[recurso omitido]');
  assert.match(first.description, /^This ordinary announcement/iu);
  assert.doesNotMatch(first.accessible_preview, /QUJD/iu);
});

test('bounds the emitted scalar before hostile classification so an omitted tail cannot affect safe visible prose', () => {
  const input = structuredClone(SAMPLE_AUDIT);
  input.occurrences[0].justification = `${'texto humano '.repeat(4_000)}<script>TAIL_PRIVATE_SENTINEL</script>`;

  const description = asRecord(parseQuotedCsv(renderOccurrenceCsv(input))[1]).description;

  assert.equal([...description].length, 32_000);
  assert.match(description, /^texto humano /u);
  assert.match(description, /…\[truncated\]$/u);
  assert.doesNotMatch(description, /TAIL_PRIVATE_SENTINEL|<script|marcação omitida/iu);
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
  input.occurrences[0].accessiblePreview = 'texto humano '.repeat(4_000);
  const preview = asRecord(parseQuotedCsv(renderOccurrenceCsv(input))[1]).accessible_preview;
  assert.equal([...preview].length, 32_000);
  assert.match(preview, /…\[truncated\]$/u);

  const huge = structuredClone(SAMPLE_AUDIT);
  huge.occurrences = Array.from({ length: 264 }, (_, index) => ({
    ...structuredClone(SAMPLE_AUDIT.occurrences[0]),
    occurrenceId: `occ-huge-${index}`,
    accessiblePreview: 'texto humano '.repeat(4_000),
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
