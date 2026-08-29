import assert from 'node:assert/strict';
import test from 'node:test';

import { SAMPLE_AUDIT } from '../../fixtures/audits/sample-audit.js';
import { CONSUMER_ACCESSIBILITY_FIXED_BASIS } from '../../src/core/legal/consumer-basis.js';
import { NBR17225_ITEMS } from '../../src/core/normative/nbr17225.js';
import { section508ReferencesForWcag } from '../../src/core/normative/section508.js';
import { createAuditModel } from '../../src/core/report/audit-model.js';
import { canonicalStringify } from '../../src/core/report/canonical-json.js';
import { renderOccurrenceCsv } from '../../src/core/report/csv.js';
import { renderTechnicalJson } from '../../src/core/report/earl-json.js';
import { enrichAuditForReport } from '../../src/core/report/enrich-audit.js';
import { sha256Hex } from '../../src/core/report/hash.js';
import { renderHtmlReport } from '../../src/core/report/html.js';
import { verifyAuditIntegritySnapshot } from '../../src/core/report/integrity.js';
import { reportInput } from './helpers.js';

const OPTIONS = Object.freeze({
  now: () => '2026-08-28T16:00:00.000Z',
  timezone: 'America/Cuiaba',
  manifestVersion: '0.1.0',
  rulesVersion: '1.0.0',
  browserVersion: 'Chrome/151.0.0.0',
});
const INVALID_CODE = 'AUDIT_MODEL_INPUT_INVALID';
const MARKER = 'PRIVATE_BOUNDARY_MARKER_7Q9Z';

function assertFixedError(error) {
  assert.equal(error instanceof TypeError, true);
  assert.equal(error.code, INVALID_CODE);
  assert.doesNotMatch(error.message, new RegExp(MARKER, 'u'));
  return true;
}

async function verifiedFixture() {
  return enrichAuditForReport(SAMPLE_AUDIT, OPTIONS);
}

async function rehash(model) {
  const hashInput = structuredClone(model);
  delete hashInput.integrity.canonicalModelHash;
  model.integrity.canonicalModelHash = await sha256Hex(canonicalStringify(hashInput));
  return model;
}

test('rejects every historical or partial V2 normative shape at every public report entrypoint', async () => {
  const current = await verifiedFixture();
  const legacy = structuredClone(current);
  for (const occurrence of legacy.occurrences) {
    delete occurrence.itemWcagRefs;
    delete occurrence.sourceWcagRefs;
    delete occurrence.testedWcagRefs;
  }
  delete legacy.normative.sources;
  await rehash(legacy);

  for (const call of [
    () => createAuditModel(legacy),
    () => renderHtmlReport(legacy),
    () => renderTechnicalJson(legacy),
    () => renderOccurrenceCsv(legacy),
  ]) assert.throws(call, assertFixedError);
  await assert.rejects(enrichAuditForReport(legacy, OPTIONS), assertFixedError);
  await assert.rejects(verifyAuditIntegritySnapshot(legacy), assertFixedError);

  const partial = structuredClone(current);
  delete partial.occurrences[0].testedWcagRefs;
  await rehash(partial);
  assert.throws(() => createAuditModel(partial), assertFixedError);
  await assert.rejects(enrichAuditForReport(partial, OPTIONS), assertFixedError);
});

test('validates complete current V2 normative metadata before reading enrichment options', async () => {
  const variants = [
    value => { delete value.normative; },
    value => { delete value.normative.sources; },
    value => { delete value.normative.edition; },
  ];
  for (const mutate of variants) {
    const input = structuredClone(await verifiedFixture());
    mutate(input);
    await rehash(input);
    let optionReads = 0;
    const options = {};
    Object.defineProperty(options, 'now', {
      enumerable: true,
      get() { optionReads += 1; throw new Error(MARKER); },
    });
    await assert.rejects(enrichAuditForReport(input, options), assertFixedError);
    assert.equal(optionReads, 0);
  }
});

test('captures hostile report input once without executing getters or echoing traps', async () => {
  let getterReads = 0;
  const accessor = structuredClone(SAMPLE_AUDIT);
  Object.defineProperty(accessor.methodology, 'privateContext', {
    enumerable: true,
    get() { getterReads += 1; throw new Error(MARKER); },
  });
  for (const call of [
    () => createAuditModel(accessor),
    () => renderHtmlReport(accessor),
    () => renderTechnicalJson(accessor),
    () => renderOccurrenceCsv(accessor),
  ]) assert.throws(call, assertFixedError);
  await assert.rejects(enrichAuditForReport(accessor, OPTIONS), assertFixedError);
  await assert.rejects(verifyAuditIntegritySnapshot(accessor), assertFixedError);
  assert.equal(getterReads, 0);

  const ownKeysTrap = new Proxy(structuredClone(SAMPLE_AUDIT), {
    ownKeys() { throw new Error(MARKER); },
  });
  assert.throws(() => createAuditModel(ownKeysTrap), assertFixedError);
  await assert.rejects(enrichAuditForReport(ownKeysTrap, OPTIONS), assertFixedError);

  const revoked = Proxy.revocable(structuredClone(SAMPLE_AUDIT), {});
  revoked.revoke();
  assert.throws(() => createAuditModel(revoked.proxy), assertFixedError);

  const cyclic = structuredClone(SAMPLE_AUDIT);
  cyclic.scope.loop = cyclic;
  assert.throws(() => createAuditModel(cyclic), assertFixedError);

  const sparse = structuredClone(SAMPLE_AUDIT);
  sparse.pages = new Array(2);
  sparse.pages[0] = structuredClone(SAMPLE_AUDIT.pages[0]);
  assert.throws(() => createAuditModel(sparse), assertFixedError);
});

test('rejects privateContext and unknown fields throughout the retained V2 graph', async () => {
  const mutators = [
    value => { value.privateContext = MARKER; },
    value => { value.methodology.privateContext = MARKER; },
    value => { value.pages[0].privateContext = MARKER; },
    value => { value.ruleResults[0].privateContext = MARKER; },
    value => { value.itemResults[0].ruleResults = [{ ruleId: 'forged', unrecognized: MARKER }]; },
    value => { value.ruleResults[0].targets = [{ nodeId: 'n-1', selectorHint: '', message: 'x', data: { privateContext: MARKER } }]; },
    value => { value.session.privateContext = MARKER; },
    value => { value.session.diagnostics[0].privateContext = MARKER; },
    value => { value.evidence[0].privateContext = MARKER; },
    value => { value.manualReview[0].privateContext = MARKER; },
    value => { value.reviewDecisions = [{ privateContext: MARKER }]; },
    value => { value.report.privateContext = MARKER; },
    value => { value.reproducibility.privateContext = MARKER; },
    value => { value.integrity.privateContext = MARKER; },
    value => { value.normative.privateContext = MARKER; },
    value => { value.accessibilityWidgets.privateContext = MARKER; },
    value => { value.axe = { privateContext: MARKER }; },
    value => { value.presentation = { privateContext: MARKER }; },
    value => { value.snapshot = { privateContext: MARKER }; },
    value => { value.occurrences[0].source.unrecognized = MARKER; },
    value => { value.occurrences[0].target.unrecognized = MARKER; },
    value => { value.occurrences[0].unrecognized = MARKER; },
  ];
  for (const mutate of mutators) {
    const candidate = structuredClone(SAMPLE_AUDIT);
    mutate(candidate);
    assert.throws(() => createAuditModel(candidate), assertFixedError);
    await assert.rejects(enrichAuditForReport(candidate, OPTIONS), assertFixedError);
  }

  const verified = await verifiedFixture();
  for (const output of [
    renderHtmlReport(verified),
    renderTechnicalJson(verified),
    renderOccurrenceCsv(verified),
  ]) assert.doesNotMatch(output, new RegExp(MARKER, 'u'));
});

for (const [label, mutate] of [
  ['page limitation', value => { value.pages[0].limitations = [{ marker: MARKER }]; }],
  ['page diagnostic', value => {
    value.pages[0].diagnostics = [{
      at: value.timestamps.generatedAt, code: 'PRIVATE_DIAGNOSTIC',
      message: { marker: MARKER }, recoverable: false,
    }];
  }],
  ['page coverage', value => {
    value.pages[0].coverage = {
      runtime: { expectedFrameCount: 1, observedFrameCount: 1, outcome: { marker: MARKER } },
    };
  }],
  ['rule target scalar', value => {
    value.ruleResults.find(rule => rule.ruleId === 'focus-visible').targets = [{
      nodeId: 'n-1', selectorHint: '', message: { marker: MARKER }, data: { reason: 'observed' },
    }];
  }],
  ['accessibility state', value => { value.evidence[1].accessibility.states = [{ marker: MARKER }]; }],
  ['accessibility scalar', value => { value.evidence[1].accessibility.name = { marker: MARKER }; }],
  ['evidence metadata', value => { value.evidence[0].metadata.width = { marker: MARKER }; }],
  ['report limitation', value => { value.report.artifact.limitations = [{ marker: MARKER }]; }],
  ['reproducibility hash', value => { value.reproducibility.snapshotHash = { marker: MARKER }; }],
  ['snapshot warning', value => {
    value.snapshot = {
      schemaVersion: 1, retention: 'summary-only', nodeCount: 1,
      coverage: {}, warnings: [{ code: { marker: MARKER } }],
    };
  }],
]) {
  test(`rejects non-scalar private payload in ${label}`, () => {
    const candidate = structuredClone(SAMPLE_AUDIT);
    mutate(candidate);
    assert.throws(() => createAuditModel(candidate), assertFixedError);
  });
}

test('rejects object-valued equivalence identities instead of serializing private structures', async () => {
  for (const field of ['equivalenceKey', 'presentationTargetKey']) {
    const candidate = structuredClone(SAMPLE_AUDIT);
    candidate.occurrences[0][field] = { marker: MARKER };
    assert.throws(() => createAuditModel(candidate), assertFixedError);
    assert.throws(() => renderTechnicalJson(candidate), assertFixedError);
  }
});

test('binds string equivalence identities to the authoritative engine and target', () => {
  for (const mutate of [
    occurrence => { occurrence.equivalenceKey = 'audita:forged-rule'; occurrence.presentationTargetKey = `node:${occurrence.nodeId}`; },
    occurrence => { occurrence.equivalenceKey = `audita:${occurrence.ruleId}`; occurrence.presentationTargetKey = 'node:forged-target'; },
  ]) {
    const candidate = structuredClone(SAMPLE_AUDIT);
    mutate(candidate.occurrences[0]);
    assert.throws(() => createAuditModel(candidate), assertFixedError);
  }
});

test('single-page core occurrences are an exact bijection including zero occurrences for passed rules', () => {
  const candidate = structuredClone(SAMPLE_AUDIT);
  const rule = candidate.ruleResults.find(value => value.ruleId === 'focus-fully-visible');
  const item = NBR17225_ITEMS.find(value => value.id === '5.1.2');
  candidate.occurrences.push({
    occurrenceId: 'occ-extra-passed', pageId: 'page-1', outcome: 'passed',
    classification: item.classification, impact: 'minor', confidence: 'high',
    source: structuredClone(rule.source), nbrItemRef: item.id,
    itemWcagRefs: item.wcag.map(reference => reference.id),
    sourceWcagRefs: [...rule.wcag], testedWcagRefs: [], wcagRefs: [], foreignBenchmarkRefs: [],
    target: { nodeId: null, selector: null, framePath: [] }, accessiblePreview: null,
    evidenceRefs: [], legalAnalysis: null, itemId: item.id, ruleId: rule.ruleId,
    mode: rule.mode, nodeId: null, evidenceIds: [], justification: 'Resultado aprovado.',
  });
  assert.throws(() => createAuditModel(candidate), assertFixedError);
});

test('V1 migration downgrades an entire unproved failed rule and preserves a fully proved current failure', () => {
  const makeInput = completeProof => {
    const input = reportInput();
    const item = NBR17225_ITEMS.find(value => value.id === '5.1.1');
    const wcag = item.wcag.map(reference => reference.id);
    input.ruleResults = input.ruleResults.filter(rule => rule.ruleId !== 'focus-visible');
    input.ruleResults.unshift({
      ruleId: 'focus-visible', outcome: 'failed', mode: item.evaluation, nbrItems: [item.id],
      wcag, targets: ['n-1'], summary: 'Falha observada.', limitations: [],
      source: { engine: 'audita-core', ruleId: 'focus-visible', version: '1.0.0' },
    });
    input.itemResults.find(value => value.id === item.id).outcome = 'failed';
    input.occurrences.unshift({
      occurrenceId: 'occ-v1-failed', itemId: item.id, ruleId: 'focus-visible', outcome: 'failed',
      mode: item.evaluation, nodeId: 'n-1', evidenceIds: [], justification: 'Falha observada.',
      source: { engine: 'audita-core', ruleId: 'focus-visible', version: '1.0.0' },
      itemWcagRefs: wcag, sourceWcagRefs: wcag,
      ...(completeProof ? { testedWcagRefs: wcag, wcagRefs: wcag } : {}),
    });
    return input;
  };

  const downgraded = createAuditModel(makeInput(false));
  const downgradedRule = downgraded.ruleResults.find(rule => rule.ruleId === 'focus-visible');
  const downgradedOccurrence = downgraded.occurrences.find(value => value.occurrenceId === 'occ-v1-failed');
  assert.equal(downgradedRule.outcome, 'cantTell');
  assert.equal(downgradedOccurrence.outcome, 'cantTell');
  assert.deepEqual(downgradedOccurrence.testedWcagRefs, []);
  assert.deepEqual(downgradedOccurrence.wcagRefs, []);
  assert.deepEqual(downgradedOccurrence.foreignBenchmarkRefs, []);
  assert.equal(downgradedOccurrence.legalAnalysis, null);
  assert.equal(downgraded.itemResults.find(value => value.id === '5.1.1').outcome, 'cantTell');
  assert.equal(downgraded.manualReview.some(value => value.occurrenceId === 'occ-v1-failed'), true);

  const preserved = createAuditModel(makeInput(true));
  const preservedOccurrence = preserved.occurrences.find(value => value.occurrenceId === 'occ-v1-failed');
  assert.equal(preserved.ruleResults.find(rule => rule.ruleId === 'focus-visible').outcome, 'failed');
  assert.equal(preservedOccurrence.outcome, 'failed');
  assert.deepEqual(preservedOccurrence.testedWcagRefs, preservedOccurrence.sourceWcagRefs);
  assert.deepEqual(preservedOccurrence.foreignBenchmarkRefs, section508ReferencesForWcag(preservedOccurrence.testedWcagRefs));
  assert.deepEqual(preservedOccurrence.legalAnalysis, { basisRef: CONSUMER_ACCESSIBILITY_FIXED_BASIS.id });
});

test('V1 migration makes a legacy manual finding inconclusive without normative or legal claims', () => {
  const input = reportInput();
  const item = NBR17225_ITEMS.find(value => value.id === '5.1.4');
  input.occurrences.push({
    ...input.occurrences[0],
    occurrenceId: 'occ-v1-manual', ruleId: null, outcome: 'failed', mode: 'manual',
    source: { engine: 'audita-manual-review', ruleId: `manual:${item.id}`, version: '1.0.0' },
    itemWcagRefs: item.wcag.map(reference => reference.id),
    sourceWcagRefs: item.wcag.map(reference => reference.id),
    testedWcagRefs: item.wcag.map(reference => reference.id),
    wcagRefs: item.wcag.map(reference => reference.id),
    foreignBenchmarkRefs: section508ReferencesForWcag(item.wcag.map(reference => reference.id)),
    legalAnalysis: { basisRef: CONSUMER_ACCESSIBILITY_FIXED_BASIS.id },
  });
  input.manualReview = [];

  const model = createAuditModel(input);
  const occurrence = model.occurrences.find(value => value.occurrenceId === 'occ-v1-manual');
  assert.equal(occurrence.outcome, 'cantTell');
  assert.deepEqual(occurrence.itemWcagRefs, []);
  assert.deepEqual(occurrence.sourceWcagRefs, []);
  assert.deepEqual(occurrence.testedWcagRefs, []);
  assert.deepEqual(occurrence.wcagRefs, []);
  assert.deepEqual(occurrence.foreignBenchmarkRefs, []);
  assert.equal(occurrence.legalAnalysis, null);
  assert.equal(model.manualReview.some(value => value.occurrenceId === occurrence.occurrenceId), true);
});

test('V1 raw snapshots retain only a closed summary in canonical V2', () => {
  const input = reportInput({
    snapshot: {
      schemaVersion: 1,
      document: { title: MARKER, coverage: { frames: 'partial' }, warnings: [{ code: 'FRAME_LIMITED', text: MARKER }] },
      nodes: [{ nodeId: 'n-1', text: MARKER }],
      coverage: { frames: 'partial' },
      warnings: [{ code: 'FRAME_LIMITED', text: MARKER }],
    },
    presentation: { occurrenceCount: 1, findings: [{ text: MARKER }] },
    progress: [{ type: 'AUDIT_PROGRESS', auditId: 'audit-report-1', sessionId: 'audit-report-1', phase: 'done', message: MARKER, percent: 100, at: '2026-08-26T14:01:00.000Z' }],
  });
  const model = createAuditModel(input);
  assert.deepEqual(model.snapshot, {
    schemaVersion: 1,
    retention: 'summary-only',
    nodeCount: 1,
    coverage: { frames: 'partial' },
    warnings: [{ code: 'FRAME_LIMITED' }],
  });
  assert.equal(Object.hasOwn(model, 'presentation'), false);
  assert.equal(Object.hasOwn(model, 'progress'), false);
  assert.doesNotMatch(canonicalStringify(model), new RegExp(MARKER, 'u'));
});

test('technical JSON contains the exact closed canonical audit and exact EARL envelope', () => {
  const model = createAuditModel(SAMPLE_AUDIT);
  const technical = JSON.parse(renderTechnicalJson(model));
  assert.deepEqual(Object.keys(technical).sort(), ['@context', 'assertions', 'audit', 'identity', 'schemaVersion']);
  assert.equal(technical.assertions.length, 146);
  assert.deepEqual(technical.audit, JSON.parse(canonicalStringify(model)));
  assert.equal(Object.hasOwn(technical.audit, 'presentation'), false);
  assert.equal(Object.hasOwn(technical.audit, 'progress'), false);
});

test('rejects retained V2 presentation and nonempty progress instead of laundering them', () => {
  const presentation = structuredClone(SAMPLE_AUDIT);
  presentation.presentation = { groups: [], hiddenOccurrenceCount: 0, occurrenceCount: 0 };
  assert.throws(() => createAuditModel(presentation), assertFixedError);

  const progress = structuredClone(SAMPLE_AUDIT);
  progress.progress = [{
    type: 'AUDIT_PROGRESS', auditId: progress.auditId, sessionId: progress.auditId,
    phase: 'done', message: MARKER, percent: 100, at: progress.timestamps.generatedAt,
  }];
  assert.throws(() => createAuditModel(progress), assertFixedError);
});

test('rejects non-canonical current V2 facts instead of repairing them during projection', () => {
  const variants = [
    value => { value.requestedUrl = `${value.requestedUrl}?token=${MARKER}`; },
    value => { value.requestedScope.urls[0] = `${value.requestedScope.urls[0]}?token=${MARKER}`; },
    value => { value.pages[0].requestedUrl = `${value.pages[0].requestedUrl}?token=${MARKER}`; },
    value => { value.evidence[1].mediaUrl = `https://servico.exemplo.test/media.png?token=${MARKER}`; },
    value => { [value.itemResults[0], value.itemResults[1]] = [value.itemResults[1], value.itemResults[0]]; },
    value => { delete value.accessibilityWidgets; },
    value => { value.integrity.canonicalModelHash = MARKER; },
    value => { value.pages[0].attempted = MARKER; },
    value => { value.session.partial = MARKER; },
    value => { value.report.status = MARKER; },
    value => { value.snapshot = { schemaVersion: 1, retention: 'summary-only', nodeCount: MARKER, coverage: {}, warnings: [] }; },
  ];
  for (const mutate of variants) {
    const candidate = structuredClone(SAMPLE_AUDIT);
    mutate(candidate);
    assert.throws(() => createAuditModel(candidate), assertFixedError);
  }
});
