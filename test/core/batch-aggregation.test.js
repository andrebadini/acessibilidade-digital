import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createBatchFailurePage,
  createBatchReportTemplate,
  aggregateBatchAudits,
} from '../../src/core/batch/aggregate-audits.js';
import { remapAuditPage } from '../../src/core/batch/remap-audit.js';
import { applyBatchEvidenceBudget } from '../../src/core/batch/evidence-budget.js';
import { enrichAuditForReport } from '../../src/core/report/enrich-audit.js';
import { createAnnotationMapFixture, createPristineMapSource } from '../report/annotation-map-fixture.js';
import { reportInput } from '../report/helpers.js';
import { normalizeAxeResults } from '../../src/core/axe/normalize-axe-results.js';
import { AXE_PROVENANCE } from '../../src/browser/axe-adapter.js';
import { pngDataUrlDecodedByteLength } from '../../src/core/evidence/png.js';
import { mergeAxeSupplementalResults } from '../../src/core/audit.js';
import { aggregateItems } from '../../src/core/rules/aggregate-items.js';
import { NBR17225_ITEMS } from '../../src/core/normative/nbr17225.js';
import { canonicalStringify } from '../../src/core/report/canonical-json.js';
import { sha256Hex } from '../../src/core/report/hash.js';
import { verifyAuditIntegritySnapshot } from '../../src/core/report/integrity.js';

const OPTIONS = Object.freeze({
  now: () => '2026-08-28T12:00:00.000Z',
  timezone: 'America/Cuiaba',
  manifestVersion: '0.1.0',
  rulesVersion: '1.0.0',
  browserVersion: 'Chrome/151.0.0.0',
});

async function childModel(auditId, url, { axe = false } = {}) {
  const map = await createAnnotationMapFixture();
  const raw = reportInput({
    auditId,
    requestedUrl: url,
    finalUrl: `${url}final?token=REMOVE&view=public`,
  });
  raw.evidence = {
    stateCount: 1,
    artifacts: [raw.evidence.artifacts[0], createPristineMapSource(), map],
  };
  if (axe) raw.axe = normalizeAxeResults(['finding', 'mapped'].includes(axe) ? {
    status: 'complete', provenance: AXE_PROVENANCE, diagnostics: [],
    frames: [{ frameId: 0, status: 'success', result: {
      violations: [{ id: axe === 'mapped' ? 'html-has-lang' : 'custom-batch-id', impact: 'serious', nodes: [{ impact: 'serious', target: ['html'] }] }],
      incomplete: [], passes: [], inapplicable: [],
    } }],
  } : { status: 'disabled', provenance: AXE_PROVENANCE, frames: [] }, {
    pageId: 'page-1', rulesVersion: '1.0.0', snapshot: raw.snapshot,
  });
  if (['finding', 'mapped'].includes(axe)) {
    const aggregated = new Map(aggregateItems(raw.ruleResults, NBR17225_ITEMS).map(item => [item.id, item]));
    raw.itemResults = NBR17225_ITEMS.map(item => ({
      ...structuredClone(item), outcome: aggregated.get(item.id).outcome,
      ruleResults: structuredClone(aggregated.get(item.id).ruleResults),
    }));
    const hybrid = mergeAxeSupplementalResults(raw, raw.axe);
    raw.ruleResults = hybrid.ruleResults;
    raw.itemResults = hybrid.itemResults;
    raw.occurrences = [...raw.occurrences, ...structuredClone(raw.axe.occurrences)];
  }
  return enrichAuditForReport(raw, OPTIONS);
}

test('remaps identical local graphs with deterministic page-qualified sequential occurrence identities', async () => {
  const firstChild = await childModel('child-a', 'https://one.example.test/?token=SECRET_A&view=public');
  const secondChild = await childModel('child-b', 'https://two.example.test/?token=SECRET_B&view=public');
  const first = await remapAuditPage(firstChild, { batchAuditId: 'batch-1', pageId: 'page-1' });
  const repeated = await remapAuditPage(firstChild, { batchAuditId: 'batch-1', pageId: 'page-1' });
  const second = await remapAuditPage(secondChild, { batchAuditId: 'batch-1', pageId: 'page-2' });

  assert.deepEqual(first, repeated);
  assert.notEqual(first.occurrences[0].occurrenceId, second.occurrences[0].occurrenceId);
  assert.equal(first.occurrences[0].occurrenceId, 'occurrence-page-1-000001');
  assert.equal(second.occurrences[0].occurrenceId, 'occurrence-page-2-000001');
  assert.deepEqual(first.occurrences.map(value => value.occurrenceId), first.occurrences.map((_value, index) =>
    `occurrence-page-1-${String(index + 1).padStart(6, '0')}`));
  assert.match(first.evidence[0].evidenceId, /^evidence-[a-f0-9]{32}$/u);
  assert.match(first.occurrences[0].nodeId, /^node-[a-f0-9]{32}$/u);
  assert.notEqual(first.occurrences[0].nodeId, second.occurrences[0].nodeId);
  assert.equal(first.ruleResults.find(rule => rule.ruleId === 'focus-order').targets[0], first.occurrences[0].nodeId);
  assert.equal(first.evidence[0].nodeId, first.occurrences[0].nodeId);
  assert.deepEqual(first.occurrences[0].evidenceRefs, [first.evidence[0].evidenceId]);
  assert.deepEqual(first.occurrences[0].evidenceIds, first.occurrences[0].evidenceRefs);

  const firstMap = first.evidence.find(artifact => artifact.kind === 'announcement-map');
  const firstSource = first.evidence.find(artifact => artifact.kind === 'full-page');
  const secondMap = second.evidence.find(artifact => artifact.kind === 'announcement-map');
  assert.equal(firstMap.pageId, 'page-1');
  assert.equal(firstMap.fullPageEvidenceId, firstSource.evidenceId);
  assert.equal(firstMap.derivation.sourceEvidenceId, firstSource.evidenceId);
  assert.equal(firstMap.segments[0].segmentId, `${firstMap.evidenceId}-segment-1`);
  assert.equal(firstMap.legend[0].nodeId, firstMap.derivation.geometry.annotations[0].nodeId);
  assert.notEqual(firstMap.legend[0].nodeId, secondMap.legend[0].nodeId);
  assert.equal(firstSource.hash, second.evidence.find(artifact => artifact.kind === 'full-page').hash,
    'bytes idênticos preservam o mesmo hash, mas não a identidade da evidência');
  assert.doesNotMatch(JSON.stringify([first, second]), /SECRET_A|SECRET_B|token=/u);

  for (const slice of [first, second]) {
    const evidenceIds = new Set(slice.evidence.map(artifact => artifact.evidenceId));
    assert.ok(slice.occurrences.every(occurrence => occurrence.pageId === slice.page.pageId));
    assert.ok(slice.occurrences.every(occurrence => occurrence.evidenceRefs.every(id => evidenceIds.has(id))));
    assert.ok(slice.evidence.every(artifact => artifact.pageId === slice.page.pageId));
  }
});

test('rejects an adulterated or unreadable child graph before allocating remapped IDs', async () => {
  const child = structuredClone(await childModel('child-a', 'https://one.example.test/'));
  child.occurrences[0].evidenceRefs = ['missing-evidence'];
  child.occurrences[0].evidenceIds = ['missing-evidence'];
  await assert.rejects(remapAuditPage(child, { batchAuditId: 'batch-1', pageId: 'page-1' }), /evidência|refer/iu);

  const { proxy, revoke } = Proxy.revocable(child, {});
  revoke();
  await assert.rejects(remapAuditPage(proxy, { batchAuditId: 'batch-1', pageId: 'page-1' }), /modelo|auditoria|segur|inválid/iu);
});

test('keeps a valid cross-reference graph when the pixel budget omits a full-page source and its map', async () => {
  const remapped = await remapAuditPage(
    await childModel('child-budget', 'https://budget.example.test/'),
    { batchAuditId: 'batch-budget', pageId: 'page-1' },
  );
  const map = remapped.evidence.find(artifact => artifact.kind === 'announcement-map');
  const source = remapped.evidence.find(artifact => artifact.kind === 'full-page');
  const rest = remapped.evidence.filter(artifact => ![map.evidenceId, source.evidenceId].includes(artifact.evidenceId));
  const reversed = { ...remapped, evidence: [map, source, ...rest] };
  const mapBytes = map.segments.reduce((total, segment) => total + pngDataUrlDecodedByteLength(segment.dataUrl), 0);
  const budgeted = await applyBatchEvidenceBudget(reversed, { usedBytes: 0, limitBytes: mapBytes });
  assert.equal(budgeted.result.page.status, 'partial');
  assert.equal(budgeted.result.evidence.some(artifact => artifact.kind === 'announcement-map'), false);
  assert.ok(budgeted.result.evidence.every(artifact => !Object.hasOwn(artifact, 'dataUrl')));
  assert.equal(budgeted.usedBytes, 0, 'a remoção dependente também libera os bytes do mapa já contado');
  const evidenceIds = new Set(budgeted.result.evidence.map(artifact => artifact.evidenceId));
  assert.ok(budgeted.result.occurrences.every(occurrence => occurrence.evidenceRefs.every(id => evidenceIds.has(id))));

  const aggregate = aggregateBatchAudits({
    batchAuditId: 'batch-budget', pageResults: [budgeted.result],
    startedAt: '2026-08-28T11:00:00.000Z', endedAt: '2026-08-28T11:01:00.000Z',
    status: 'partial', template: createBatchReportTemplate(OPTIONS),
  });
  const final = await enrichAuditForReport(aggregate, OPTIONS);
  assert.equal(final.session.status, 'partial');
  assert.equal(final.pages[0].diagnostics.some(value => value.code === 'BATCH_EVIDENCE_BUDGET_EXCEEDED'), true);
  assert.ok(final.occurrences.every(occurrence => occurrence.evidenceRefs.every(id => final.evidence.some(value => value.evidenceId === id))));
});

test('validates each batch axe envelope against its exact page and rejects tampering', async () => {
  const first = await remapAuditPage(
    await childModel('child-axe-1', 'https://axe-one.example.test/'),
    { batchAuditId: 'batch-axe', pageId: 'page-1' },
  );
  const second = await remapAuditPage(
    await childModel('child-axe-2', 'https://axe-two.example.test/'),
    { batchAuditId: 'batch-axe', pageId: 'page-2' },
  );
  const disabledFor = pageId => normalizeAxeResults({
    status: 'disabled', provenance: AXE_PROVENANCE, frames: [],
  }, { pageId, rulesVersion: '1.0.0' });
  const raw = aggregateBatchAudits({
    batchAuditId: 'batch-axe', pageResults: [
      { ...first, page: { ...first.page, status: 'complete', axeStatus: 'disabled' }, axe: disabledFor('page-1') },
      { ...second, page: { ...second.page, status: 'complete', axeStatus: 'disabled' }, axe: disabledFor('page-2') },
    ],
    startedAt: '2026-08-28T11:00:00.000Z', endedAt: '2026-08-28T11:01:00.000Z', status: 'complete',
  });
  const final = await enrichAuditForReport(raw, OPTIONS);
  assert.equal(final.axePages.length, 2);
  assert.deepEqual(final.axePages.map(entry => entry.pageId), ['page-1', 'page-2']);

  const tampered = structuredClone(raw);
  tampered.axePages[1].pageId = 'page-1';
  await assert.rejects(enrichAuditForReport(tampered, OPTIONS), /axe|página|duplicad/iu);

  const partialAxe = normalizeAxeResults({
    status: 'partial', provenance: AXE_PROVENANCE,
    diagnostics: [{ code: 'AXE_DIAGNOSTIC_UNAVAILABLE', frameId: null }], frames: [],
  }, { pageId: 'page-1', rulesVersion: '1.0.0' });
  const partialRaw = aggregateBatchAudits({
    batchAuditId: 'batch-axe-partial',
    pageResults: [{ ...first, page: { ...first.page, status: 'complete', axeStatus: 'partial' }, axe: partialAxe }],
    startedAt: '2026-08-28T11:00:00.000Z', endedAt: '2026-08-28T11:01:00.000Z', status: 'complete',
  });
  await assert.rejects(enrichAuditForReport(partialRaw, OPTIONS), /axe parcial|cobertura axe/iu);
});

test('migrates mapped legacy normative fields inside nested axe only after preserving the verified occurrence identity', async () => {
  const current = await childModel('child-axe-legacy', 'https://axe-legacy.example.test/', { axe: 'mapped' });
  const legacy = structuredClone(current);
  const legacyId = legacy.occurrences.find(value => value.source.engine === 'axe-core').occurrenceId;
  for (const collection of [legacy.occurrences, legacy.axe.occurrences]) {
    for (const occurrence of collection) for (const field of ['itemWcagRefs', 'sourceWcagRefs', 'testedWcagRefs']) delete occurrence[field];
  }
  const hashInput = structuredClone(legacy);
  delete hashInput.integrity.canonicalModelHash;
  legacy.integrity.canonicalModelHash = await sha256Hex(canonicalStringify(hashInput));

  const migrated = await verifyAuditIntegritySnapshot(legacy);
  assert.equal(migrated.occurrences.find(value => value.source.engine === 'axe-core').occurrenceId, legacyId);
  assert.deepEqual(migrated.occurrences.find(value => value.source.engine === 'axe-core').testedWcagRefs, []);
  assert.deepEqual(migrated.axe.occurrences[0].testedWcagRefs, []);

  const page = await remapAuditPage(current, { batchAuditId: 'batch-axe-legacy', pageId: 'page-1' });
  const batchRaw = aggregateBatchAudits({
    batchAuditId: 'batch-axe-legacy', pageResults: [page],
    startedAt: '2026-08-28T11:00:00.000Z', endedAt: '2026-08-28T11:01:00.000Z', status: page.page.status,
  });
  const batchCurrent = await enrichAuditForReport(batchRaw, OPTIONS);
  const batchLegacy = structuredClone(batchCurrent);
  for (const collection of [batchLegacy.occurrences, ...batchLegacy.axePages.map(entry => entry.result.occurrences)]) {
    for (const occurrence of collection) for (const field of ['itemWcagRefs', 'sourceWcagRefs', 'testedWcagRefs']) delete occurrence[field];
  }
  const batchHashInput = structuredClone(batchLegacy);
  delete batchHashInput.integrity.canonicalModelHash;
  batchLegacy.integrity.canonicalModelHash = await sha256Hex(canonicalStringify(batchHashInput));
  const batchMigrated = await verifyAuditIntegritySnapshot(batchLegacy);
  assert.deepEqual(batchMigrated.axePages[0].result.occurrences[0].testedWcagRefs, []);
});

test('aggregates pages in requested order with unique rules, 146 items and conservative pass semantics', async () => {
  const first = await remapAuditPage(
    await childModel('child-a', 'https://one.example.test/?token=SECRET_A&view=public'),
    { batchAuditId: 'batch-aggregate', pageId: 'page-1' },
  );
  const second = await remapAuditPage(
    await childModel('child-b', 'https://two.example.test/'),
    { batchAuditId: 'batch-aggregate', pageId: 'page-2' },
  );
  const failed = createBatchFailurePage({
    pageId: 'page-3', requestedUrl: 'https://three.example.test/?view=public', status: 'failed',
    attempted: true, startedAt: '2026-08-28T11:02:00.000Z', endedAt: '2026-08-28T11:02:30.000Z',
    code: 'BATCH_PAGE_TIMEOUT', message: 'A página excedeu o tempo limite da auditoria.',
  });
  const raw = aggregateBatchAudits({
    batchAuditId: 'batch-aggregate', pageResults: [first, second, failed],
    startedAt: '2026-08-28T11:00:00.000Z', endedAt: '2026-08-28T11:03:00.000Z',
    status: 'partial', progress: [], diagnostics: [],
  });

  assert.deepEqual(raw.requestedScope.urls, [
    'https://one.example.test/?view=public',
    'https://two.example.test/',
    'https://three.example.test/?view=public',
  ]);
  assert.deepEqual(raw.pages.map(page => page.pageId), ['page-1', 'page-2', 'page-3']);
  assert.equal(raw.pages[2].attempted, true);
  assert.equal(raw.pages[2].finalUrlObserved, false);
  assert.equal(raw.occurrences.some(occurrence => occurrence.pageId === 'page-3'), false,
    'falha de navegação não vira ocorrência normativa ou jurídica');
  assert.equal(new Set(raw.ruleResults.map(rule => rule.ruleId)).size, raw.ruleResults.length);
  assert.equal(raw.ruleResults.find(rule => rule.ruleId === 'focus-visible').outcome, 'cantTell',
    'uma página falha impede aprovação global automática');
  assert.equal(raw.itemResults.length, 146);
  assert.equal(raw.itemResults.find(item => item.id === '5.1.1').outcome, 'cantTell');
  assert.equal(raw.methodology.coreRuleCount, 130);
  assert.equal(raw.methodology.itemCount, 146);
  assert.equal(raw.presentation.occurrenceCount, raw.occurrences.length);
  assert.doesNotMatch(JSON.stringify(raw), /SECRET_A|token=/u);

  const final = await enrichAuditForReport(raw, OPTIONS);
  assert.equal(final.schemaVersion, 2);
  assert.equal(final.requestedScope.mode, 'batch');
  assert.equal(final.pages.length, 3);
  assert.equal(final.itemResults.length, 146);
  assert.equal(final.session.status, 'partial');
  assert.match(final.integrity.canonicalModelHash, /^[a-f0-9]{64}$/u);
});

test('uses the strongest rule metadata and derives conservative status and summaries from every page', async () => {
  const first = structuredClone(await remapAuditPage(
    await childModel('child-meta-1', 'https://meta-one.example.test/'),
    { batchAuditId: 'batch-meta', pageId: 'page-1' },
  ));
  const second = structuredClone(await remapAuditPage(
    await childModel('child-meta-2', 'https://meta-two.example.test/'),
    { batchAuditId: 'batch-meta', pageId: 'page-2' },
  ));
  const ruleId = 'focus-visible';
  first.page.status = 'complete'; second.page.status = 'complete';
  const firstRule = first.ruleResults.find(rule => rule.ruleId === ruleId);
  const secondRule = second.ruleResults.find(rule => rule.ruleId === ruleId);
  firstRule.outcome = 'passed'; firstRule.summary = 'Resumo passed da primeira página.';
  secondRule.outcome = 'failed'; secondRule.summary = 'Resumo failed autoritativo.';
  const raw = aggregateBatchAudits({
    batchAuditId: 'batch-meta', pageResults: [first, second],
    startedAt: OPTIONS.now(), endedAt: OPTIONS.now(), status: 'complete',
  });
  const aggregated = raw.ruleResults.find(rule => rule.ruleId === ruleId);
  assert.equal(aggregated.outcome, 'failed');
  assert.equal(aggregated.impact, secondRule.impact);
  assert.match(aggregated.summary, /2 páginas.*falha/iu);
  const one = structuredClone(first);
  one.ruleResults.find(rule => rule.ruleId === ruleId).outcome = 'failed';
  const onePage = aggregateBatchAudits({
    batchAuditId: 'batch-meta-one', pageResults: [one],
    startedAt: OPTIONS.now(), endedAt: OPTIONS.now(), status: 'complete',
  });
  assert.match(onePage.ruleResults.find(rule => rule.ruleId === ruleId).summary, /1 página(?!s).*falha/iu);

  const failedPage = createBatchFailurePage({
    pageId: 'page-2', requestedUrl: 'https://failed.example.test/', status: 'failed', attempted: true,
    startedAt: OPTIONS.now(), endedAt: OPTIONS.now(), code: 'BATCH_PAGE_FAILED', message: 'Falha controlada.',
  });
  first.ruleResults.find(rule => rule.ruleId === ruleId).outcome = 'inapplicable';
  assert.throws(() => aggregateBatchAudits({
    batchAuditId: 'batch-status-tamper', pageResults: [first, failedPage],
    startedAt: OPTIONS.now(), endedAt: OPTIONS.now(), status: 'complete',
  }), /status|páginas|sessão/iu);
  const partial = aggregateBatchAudits({
    batchAuditId: 'batch-status-safe', pageResults: [first, failedPage],
    startedAt: OPTIONS.now(), endedAt: OPTIONS.now(), status: 'partial',
  });
  const partialRule = partial.ruleResults.find(rule => rule.ruleId === ruleId);
  assert.equal(partialRule.outcome, 'cantTell');
  assert.match(partialRule.summary, /1 de 2 páginas.*não foi possível concluir/iu);
  assert.equal(partial.itemResults.find(item => item.ruleIds.includes(ruleId)).outcome, 'cantTell');
});

test('allocates distinct stable ordinals for the reported legacy 32-bit collision pair', async () => {
  const child = structuredClone(await childModel('child-collision', 'https://collision.example.test/'));
  const firstOccurrence = child.occurrences[0];
  const firstReview = child.manualReview[0];
  firstOccurrence.occurrenceId = 'occurrence-axe-0001179a';
  firstReview.occurrenceId = firstOccurrence.occurrenceId;
  child.occurrences.push({ ...structuredClone(firstOccurrence), occurrenceId: 'occurrence-axe-0001e467' });
  child.manualReview.push({ ...structuredClone(firstReview), occurrenceId: 'occurrence-axe-0001e467' });

  const first = await remapAuditPage(child, { batchAuditId: 'batch-collision', pageId: 'page-1' });
  const repeated = await remapAuditPage(child, { batchAuditId: 'batch-collision', pageId: 'page-1' });
  assert.deepEqual(first.occurrences.map(value => value.occurrenceId), [
    'occurrence-page-1-000001', 'occurrence-page-1-000002',
  ]);
  assert.deepEqual(first.occurrences.map(value => value.occurrenceId), repeated.occurrences.map(value => value.occurrenceId));
  assert.deepEqual(first.manualReview.map(value => value.occurrenceId), first.occurrences.map(value => value.occurrenceId));
});

test('represents never-started cancellation without pixels, findings or observed redirect', () => {
  const page = createBatchFailurePage({
    pageId: 'page-4', requestedUrl: 'https://four.example.test/?session=REMOVE&view=public',
    status: 'cancelled', attempted: false,
    startedAt: '2026-08-28T11:03:00.000Z', endedAt: '2026-08-28T11:03:00.000Z',
    code: 'BATCH_CANCELLED', message: 'A página não foi iniciada porque o lote foi cancelado.',
  });
  assert.equal(page.page.attempted, false);
  assert.equal(page.page.finalUrlObserved, false);
  assert.equal(page.page.finalUrl, 'https://four.example.test/?view=public');
  assert.deepEqual(page.occurrences, []);
  assert.deepEqual(page.evidence, []);
  assert.doesNotMatch(JSON.stringify(page), /REMOVE|session=/u);
});

test('builds a valid revisable model when every page failed or was cancelled before producing a child template', async () => {
  const finalOptions = { ...OPTIONS, manifestVersion: '2.0.0', browserVersion: 'Chrome/152.0.0.0' };
  const template = createBatchReportTemplate(finalOptions);
  for (const scenario of [
    { status: 'failed', pageStatus: 'failed', attempted: true, code: 'BATCH_PAGE_FAILED' },
    { status: 'cancelled', pageStatus: 'cancelled', attempted: false, code: 'BATCH_CANCELLED' },
  ]) {
    const pageResults = ['one', 'two'].map((name, index) => createBatchFailurePage({
      pageId: `page-${index + 1}`, requestedUrl: `https://${name}.example.test/?token=REMOVE&view=public`,
      status: scenario.pageStatus, attempted: scenario.attempted,
      startedAt: '2026-08-28T11:00:00.000Z', endedAt: '2026-08-28T11:00:01.000Z',
      code: scenario.code,
      message: scenario.status === 'cancelled'
        ? 'A página não foi iniciada porque o lote foi cancelado.'
        : 'A página não pôde ser auditada.',
    }));
    const raw = aggregateBatchAudits({
      batchAuditId: `batch-${scenario.status}`, pageResults,
      startedAt: '2026-08-28T11:00:00.000Z', endedAt: '2026-08-28T11:01:00.000Z',
      status: scenario.status, progress: [], diagnostics: [], template,
    });
    const final = await enrichAuditForReport(raw, finalOptions);
    assert.equal(final.session.status, scenario.status);
    assert.equal(final.versions.extension, '2.0.0');
    assert.equal(final.versions.browser, 'Chrome/152.0.0.0');
    assert.equal(final.normative.edition, 'ABNT NBR 17225:2025');
    assert.equal(final.pages.length, 2);
    assert.equal(final.itemResults.length, 146);
    assert.ok(final.itemResults.every(item => item.outcome === 'cantTell'));
    assert.deepEqual(final.occurrences, []);
    assert.deepEqual(final.evidence, []);
    assert.match(final.integrity.canonicalModelHash, /^[a-f0-9]{64}$/u);
    assert.doesNotMatch(JSON.stringify(final), /REMOVE|token=/u);
  }
});
