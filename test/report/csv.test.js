import assert from 'node:assert/strict';
import test from 'node:test';

import { SAMPLE_AUDIT } from '../../fixtures/audits/sample-audit.js';
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
const VERIFIED_OPTIONS = Object.freeze({
  now: () => '2026-08-26T16:00:00.000Z',
  timezone: 'America/Cuiaba',
  manifestVersion: '0.1.0',
  rulesVersion: '1.0.0',
  browserVersion: 'Chrome/147.0.0.0',
});

function setCoreRuleInapplicable(input, ruleId) {
  const rule = input.ruleResults.find(value => value.ruleId === ruleId);
  assert.ok(rule, `regra ${ruleId} ausente na fixture`);
  rule.outcome = 'inapplicable';
  rule.targets = [];
  for (const itemId of rule.nbrItems) {
    const item = input.itemResults.find(value => value.id === itemId);
    assert.ok(item, `item ${itemId} ausente na fixture`);
    item.outcome = 'inapplicable';
  }
}

function bindCoreRuleTargets(input, ruleId, occurrences) {
  const rule = input.ruleResults.find(value => value.ruleId === ruleId);
  assert.ok(rule, `regra ${ruleId} ausente na fixture`);
  rule.targets = occurrences.map(occurrence => occurrence.nodeId);
}

test('serializes a deterministic RFC 4180 occurrence table with fixed versioned columns', async () => {
  const verified = await verifiedAudit(SAMPLE_AUDIT);
  const csv = renderOccurrenceCsv(verified);
  const records = parseQuotedCsv(csv);

  assert.equal(OCCURRENCE_CSV_VERSION, 'audita-occurrences-v1');
  assert.deepEqual(OCCURRENCE_CSV_COLUMNS, HEADERS);
  assert.equal(renderOccurrenceCsv(verified), csv);
  assert.deepEqual([...new TextEncoder().encode(csv).subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(records.length, verified.occurrences.length + 1);
  assert.deepEqual(records[0], HEADERS);
  assert.deepEqual(records.slice(1).map(row => row[2]), verified.occurrences.map(value => value.occurrenceId));
  assert.deepEqual(asRecord(records[1]), {
    csv_schema_version: 'audita-occurrences-v1',
    audit_id: 'audit-sample-20260826',
    occurrence_id: 'occ-focus-failed',
    page_id: 'page-1',
    page_url: 'https://servico.exemplo.test',
    observed_at: '2026-08-26T16:00:00.000Z',
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
    evidence_hashes: `ev-full=${verified.evidence[0].hash};ev-control=${verified.evidence[1].hash}`,
    canonical_model_hash: verified.integrity.canonicalModelHash,
    evidence_manifest_hash: verified.integrity.evidenceManifestHash,
  });
  assert.ok(csv.endsWith('\r\n'));
  assert.equal(csv.replace(/\r\n/gu, '').includes('\n'), false);
});

test('preserves canonical structural IDs for cross-artifact correlation', async () => {
  const input = structuredClone(SAMPLE_AUDIT);
  input.occurrences[0].occurrenceId = 'occ-PRIVATE-record';

  const first = asRecord(parseQuotedCsv(renderOccurrenceCsv(await verifiedAudit(input)))[1]);

  assert.equal(first.occurrence_id, 'occ-PRIVATE-record');
});

test('projects every rich page-derived field to one fixed marker without mutating the model', async () => {
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

  const csv = renderOccurrenceCsv(await verifiedAudit(input));
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

test('omits raw HTML, resource URLs, encoded pixels and credential prose in every rich projection', async () => {
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

    const csv = renderOccurrenceCsv(await verifiedAudit(input));
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

test('exports only an HTTP(S) origin from a canonical page URL', async () => {
  const input = structuredClone(SAMPLE_AUDIT);
  input.pages[0].finalUrl = 'https://servico.exemplo.test:8443/private?view=public';
  input.finalUrl = input.pages[0].finalUrl;

  const verified = await verifiedAudit(input);
  const pageUrl = asRecord(parseQuotedCsv(renderOccurrenceCsv(verified))[1]).page_url;

  assert.equal(pageUrl, 'https://servico.exemplo.test:8443');
  assert.doesNotMatch(renderOccurrenceCsv(verified), /private|view=public/iu);
});

test('uses only local catalog titles and fixed outcome descriptions', async () => {
  const input = structuredClone(SAMPLE_AUDIT);
  input.occurrences[0].justification = 'PRIVATE customer prose';

  const first = asRecord(parseQuotedCsv(renderOccurrenceCsv(await verifiedAudit(input)))[1]);

  assert.equal(first.title, 'Indicador de foco visível');
  assert.equal(first.description,
    'Requisito: não conformidade observada; detalhes disponíveis somente no HTML/JSON.');
  assert.doesNotMatch(JSON.stringify(first), /customer prose/iu);
});

test('derives CSV provenance exclusively from the same registry accepted by canonical JSON', async () => {
  const verified = await verifiedAudit(SAMPLE_AUDIT);
  const rows = parseQuotedCsv(renderOccurrenceCsv(verified)).slice(1).map(asRecord);
  verified.occurrences.forEach((occurrence, index) => {
    assert.equal(rows[index].source_engine, occurrence.source.engine);
    assert.equal(rows[index].source_version, occurrence.source.version);
    assert.equal(rows[index].source_rule_id, occurrence.source.ruleId);
  });
});

test('fails the whole CSV projection instead of silently emptying a list above 256 evidence references', async () => {
  const input = structuredClone(SAMPLE_AUDIT);
  const source = input.evidence.find(entry => entry.evidenceId === 'ev-full');
  const extra = Array.from({ length: 255 }, (_, index) => ({
    ...structuredClone(source),
    evidenceId: `ev-list-boundary-${String(index).padStart(3, '0')}`,
  }));
  input.evidence.push(...extra);
  input.occurrences[0].evidenceRefs = [
    ...input.occurrences[0].evidenceRefs,
    ...extra.map(entry => entry.evidenceId),
  ];
  input.occurrences[0].evidenceIds = [...input.occurrences[0].evidenceRefs];

  assert.equal(input.occurrences[0].evidenceRefs.length, 257);
  const verified = await verifiedAudit(input);
  assert.throws(
    () => renderOccurrenceCsv(verified),
    error => error instanceof RangeError && /CSV|lista|256|evid/iu.test(error.message),
  );
});

test('fails a 256-item reference list that would otherwise be truncated inside a CSV cell', async () => {
  const input = structuredClone(SAMPLE_AUDIT);
  const source = input.evidence.find(entry => entry.evidenceId === 'ev-full');
  const extra = Array.from({ length: 254 }, (_, index) => ({
    ...structuredClone(source),
    evidenceId: `ev-${String(index).padStart(3, '0')}-${'x'.repeat(180)}`,
  }));
  input.evidence.push(...extra);
  input.occurrences[0].evidenceRefs = [
    ...input.occurrences[0].evidenceRefs,
    ...extra.map(entry => entry.evidenceId),
  ];
  input.occurrences[0].evidenceIds = [...input.occurrences[0].evidenceRefs];

  assert.equal(input.occurrences[0].evidenceRefs.length, 256);
  const verified = await verifiedAudit(input);
  assert.throws(
    () => renderOccurrenceCsv(verified),
    error => error instanceof RangeError && /CSV|lista|célula|perda|trunc/iu.test(error.message),
  );
});

test('never truncates a complete correlation list to add spreadsheet neutralization', async () => {
  const input = structuredClone(SAMPLE_AUDIT);
  const ids = Array.from({ length: 256 }, (_, index) => {
    const prefix = index === 0 ? `-ev-${index}-` : `ev-${index}-`;
    const length = index === 0 ? 60 : 59;
    return `${prefix}${'x'.repeat(length - prefix.length)}`;
  });
  assert.equal(ids.reduce((sum, id) => sum + id.length, 0), 15_105);

  const fullPageSource = structuredClone(input.evidence[0]);
  input.evidence[0].evidenceId = ids[0];
  input.evidence[1].evidenceId = ids[1];
  input.evidence[1].fullPageEvidenceId = ids[0];
  input.evidence.push(...ids.slice(2).map(evidenceId => ({
    ...structuredClone(fullPageSource),
    evidenceId,
  })));
  for (const occurrence of input.occurrences) {
    occurrence.evidenceRefs = occurrence.evidenceRefs.map(id => id === 'ev-full' ? ids[0] : ids[1]);
    occurrence.evidenceIds = [...occurrence.evidenceRefs];
  }
  input.occurrences[0].evidenceRefs.push(...ids.slice(2));
  input.occurrences[0].evidenceIds = [...input.occurrences[0].evidenceRefs];

  const verified = await verifiedAudit(input);
  const projectedHashLength = ids.reduce((sum, id) => sum + id.length + 1 + 64, 0) + ids.length - 1;
  assert.equal(projectedHashLength, 32_000);
  assert.throws(
    () => renderOccurrenceCsv(verified),
    error => error instanceof RangeError && /CSV|lista|célula|perda|neutraliza|trunc/iu.test(error.message),
  );
});

test('rejects attacker-supplied hash-shaped V2 claims before any CSV projection', async () => {
  const input = structuredClone(SAMPLE_AUDIT);
  for (const artifact of input.evidence) artifact.hash = 'a'.repeat(64);
  input.integrity = {
    algorithm: 'SHA-256',
    canonicalModelHash: 'b'.repeat(64),
    evidenceManifestHash: 'c'.repeat(64),
  };
  await assert.rejects(verifiedAudit(input), /modelo|integridade|hash/iu);
});

test('emits correlated hashes only from an integrity-verified immutable snapshot', async () => {
  const verified = await verifiedAudit(SAMPLE_AUDIT);

  const first = asRecord(parseQuotedCsv(renderOccurrenceCsv(verified))[1]);

  assert.match(first.evidence_hashes,
    /^ev-full=[a-f0-9]{64};ev-control=[a-f0-9]{64}$/u);
  assert.equal(first.canonical_model_hash, verified.integrity.canonicalModelHash);
  assert.equal(first.evidence_manifest_hash, verified.integrity.evidenceManifestHash);
});

test('neutralizes the spreadsheet surface by projecting hostile prefixes out of every rich cell', async () => {
  const prefixes = ['=SUM(1,1)', '+cmd', '-2+3', '@formula', '\tprivate', '\rprivate'];
  const input = structuredClone(SAMPLE_AUDIT);
  input.occurrences = prefixes.map((value, index) => ({
    ...structuredClone(input.occurrences[0]),
    occurrenceId: `occ-formula-${index}`,
    nodeId: `n-formula-${index}`,
    target: {
      ...structuredClone(input.occurrences[0].target),
      nodeId: `n-formula-${index}`,
    },
    justification: value,
    accessiblePreview: value,
  }));
  bindCoreRuleTargets(input, 'focus-visible', input.occurrences);
  setCoreRuleInapplicable(input, 'focus-order');
  input.manualReview = [];
  input.reviewDecisions = [];
  const original = structuredClone(input);

  const rows = parseQuotedCsv(renderOccurrenceCsv(await verifiedAudit(input))).slice(1).map(asRecord);

  assert.deepEqual(input, original);
  for (const row of rows) {
    for (const value of Object.values(row)) assert.doesNotMatch(value, /^[=+\-@\t\r]/u);
    assert.equal(row.accessible_preview, DETAIL_MARKER);
  }
});

test('resolves each occurrence URL and timestamp by pageId', async () => {
  const input = structuredClone(SAMPLE_AUDIT);
  input.requestedScope = {
    mode: 'batch',
    urls: [...input.requestedScope.urls, 'https://segunda.example.test/solicitada'],
  };
  input.pages.push({
    pageId: 'page-2',
    requestedUrl: 'https://segunda.example.test/solicitada',
    finalUrl: 'https://segunda.example.test/final/private?view=public',
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
  const canonical = await verifiedAudit(input);

  const pageTwo = parseQuotedCsv(renderOccurrenceCsv(canonical)).slice(1).map(asRecord)
    .find(row => row.occurrence_id === 'occ-page-2');

  assert.equal(pageTwo.page_url, 'https://segunda.example.test');
  assert.equal(pageTwo.observed_at, '2026-08-26T16:00:00.000Z');
});

test('fails closed on unknown page and cross-page evidence references', async () => {
  const input = structuredClone(SAMPLE_AUDIT);
  const unknown = structuredClone(input);
  unknown.occurrences[0].pageId = 'page-missing';
  await assert.rejects(() => verifiedAudit(unknown), TypeError);

  const crossPage = structuredClone(input);
  crossPage.pages.push({
    ...structuredClone(crossPage.pages[0]),
    pageId: 'page-2',
  });
  crossPage.requestedScope = { mode: 'batch', urls: [...crossPage.requestedScope.urls, crossPage.pages[1].requestedUrl] };
  crossPage.occurrences[0].pageId = 'page-2';
  await assert.rejects(() => verifiedAudit(crossPage), TypeError);
});

test('exports header only for zero occurrences and preserves 512-occurrence canonical order', async () => {
  const empty = structuredClone(SAMPLE_AUDIT);
  setCoreRuleInapplicable(empty, 'focus-visible');
  setCoreRuleInapplicable(empty, 'focus-order');
  empty.occurrences = [];
  empty.manualReview = [];
  empty.reviewDecisions = [];
  assert.deepEqual(parseQuotedCsv(renderOccurrenceCsv(await verifiedAudit(empty))), [HEADERS]);

  const large = structuredClone(empty);
  const manualOccurrence = SAMPLE_AUDIT.occurrences.find(value => value.source.engine === 'audita-manual-review');
  const manualReview = SAMPLE_AUDIT.manualReview.find(value => value.occurrenceId === manualOccurrence.occurrenceId);
  large.occurrences = Array.from({ length: 512 }, (_, index) => ({
    ...structuredClone(manualOccurrence),
    occurrenceId: `occ-realistic-${String(index).padStart(4, '0')}`,
  }));
  large.manualReview = large.occurrences.map(occurrence => ({
    ...structuredClone(manualReview),
    occurrenceId: occurrence.occurrenceId,
  }));
  const records = parseQuotedCsv(renderOccurrenceCsv(await verifiedAudit(large)));
  assert.equal(records.length, 513);
  assert.equal(records[1][2], 'occ-realistic-0000');
  assert.equal(records.at(-1)[2], 'occ-realistic-0511');
});

test('processes repeated long benign prose in bounded time without decoding or budget exhaustion', async () => {
  const input = structuredClone(SAMPLE_AUDIT);
  const prose = 'A data: da reunião será amanhã; use x < y para comparar. '.repeat(20_000);
  input.occurrences = Array.from({ length: 32 }, (_, index) => ({
    ...structuredClone(input.occurrences[0]),
    occurrenceId: `occ-long-${index}`,
    nodeId: `n-long-${index}`,
    target: {
      ...structuredClone(input.occurrences[0].target),
      nodeId: `n-long-${index}`,
    },
    justification: prose,
    accessiblePreview: prose,
  }));
  bindCoreRuleTargets(input, 'focus-visible', input.occurrences);
  setCoreRuleInapplicable(input, 'focus-order');
  input.manualReview = [];
  input.reviewDecisions = [];

  const verified = await verifiedAudit(input);
  const startedAt = performance.now();
  const records = parseQuotedCsv(renderOccurrenceCsv(verified));

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
    error => error instanceof TypeError && error.code === 'AUDIT_MODEL_INPUT_INVALID' &&
      !error.message.includes('PRIVATE_SENTINEL'),
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

test('requires a privately integrity-verified snapshot before inspecting any top-level or nested proxy', async () => {
  let traps = 0;
  const trap = () => {
    traps += 1;
    throw new Error('PRIVATE_PROXY_TRAP');
  };
  const topLevel = new Proxy(structuredClone(SAMPLE_AUDIT), {
    get: trap,
    getOwnPropertyDescriptor: trap,
    getPrototypeOf: trap,
    ownKeys: trap,
  });
  assert.throws(
    () => renderOccurrenceCsv(topLevel),
    error => error instanceof TypeError && !error.message.includes('PRIVATE_PROXY_TRAP'),
  );
  assert.equal(traps, 0);

  const nested = structuredClone(SAMPLE_AUDIT);
  nested.occurrences[0] = new Proxy(nested.occurrences[0], {
    get: trap,
    getOwnPropertyDescriptor: trap,
    getPrototypeOf: trap,
    ownKeys: trap,
  });
  assert.throws(
    () => renderOccurrenceCsv(nested),
    error => error instanceof TypeError && !error.message.includes('PRIVATE_PROXY_TRAP'),
  );
  assert.equal(traps, 0);

  assert.throws(() => renderOccurrenceCsv(structuredClone(SAMPLE_AUDIT)), /integridade|verificad|snapshot|CSV/i);
  const verified = await verifiedAudit(SAMPLE_AUDIT);
  assert.match(renderOccurrenceCsv(verified), /^\uFEFF"csv_schema_version"/u);
});

test('preserves every canonical leading ID character without losing correlations', async () => {
  for (const prefix of ['-', '_', '.', ':']) {
    const input = structuredClone(SAMPLE_AUDIT);
    const auditId = `${prefix}audit-id`;
    const pageId = `${prefix}page-id`;
    const occurrenceId = `${prefix}occurrence-id`;
    const evidenceIds = [`${prefix}evidence-full`, `${prefix}evidence-control`];
    input.auditId = auditId;
    input.pages[0].pageId = pageId;
    assert.equal(Object.hasOwn(input, 'progress'), false);
    input.occurrences[0].occurrenceId = occurrenceId;
    input.occurrences[0].pageId = pageId;
    input.occurrences[0].evidenceRefs = evidenceIds;
    input.occurrences[0].evidenceIds = evidenceIds;
    input.evidence[0].evidenceId = evidenceIds[0];
    input.evidence[0].pageId = pageId;
    input.evidence[1].evidenceId = evidenceIds[1];
    input.evidence[1].pageId = pageId;
    input.evidence[1].fullPageEvidenceId = evidenceIds[0];
    for (const occurrence of input.occurrences.slice(1)) {
      occurrence.pageId = pageId;
      occurrence.evidenceRefs = occurrence.evidenceRefs.map(id => id === 'ev-full' ? evidenceIds[0] : evidenceIds[1]);
      occurrence.evidenceIds = [...occurrence.evidenceRefs];
    }
    for (const entry of input.manualReview) {
      if (entry.occurrenceId === 'occ-focus-review') entry.occurrenceId = input.occurrences[1].occurrenceId;
      if (entry.occurrenceId === 'occ-cross-page') entry.occurrenceId = input.occurrences[2].occurrenceId;
    }

    const verified = await verifiedAudit(input);
    const row = asRecord(parseQuotedCsv(renderOccurrenceCsv(verified))[1]);
    const formulaPrefix = prefix === '-' ? "'" : '';
    assert.equal(row.audit_id, `${formulaPrefix}${auditId}`);
    assert.equal(row.page_id, `${formulaPrefix}${pageId}`);
    assert.equal(row.occurrence_id, `${formulaPrefix}${occurrenceId}`);
    assert.equal(row.evidence_refs, `${formulaPrefix}${evidenceIds.join(';')}`);
    assert.match(row.evidence_hashes, new RegExp(`^${formulaPrefix ? "'" : ''}${escapeRegExp(evidenceIds[0])}=[a-f0-9]{64};${escapeRegExp(evidenceIds[1])}=[a-f0-9]{64}$`, 'u'));
  }
});

function asRecord(row) {
  return Object.fromEntries(HEADERS.map((header, index) => [header, row[index]]));
}

function verifiedAudit(input) {
  return enrichAuditForReport(input, VERIFIED_OPTIONS);
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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
