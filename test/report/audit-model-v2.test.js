import assert from 'node:assert/strict';
import test from 'node:test';

import { SAMPLE_AUDIT } from '../../fixtures/audits/sample-audit.js';
import { AXE_PROVENANCE } from '../../src/browser/axe-adapter.js';
import { normalizeAxeResults } from '../../src/core/axe/normalize-axe-results.js';
import { CONSUMER_ACCESSIBILITY_FIXED_BASIS } from '../../src/core/legal/consumer-basis.js';
import { NBR17225_ITEMS } from '../../src/core/normative/nbr17225.js';
import { section508ReferencesForWcag } from '../../src/core/normative/section508.js';
import { renderOccurrenceCsv } from '../../src/core/report/csv.js';
import { canonicalStringify } from '../../src/core/report/canonical-json.js';
import { renderTechnicalJson } from '../../src/core/report/earl-json.js';
import { enrichAuditForReport } from '../../src/core/report/enrich-audit.js';
import { sha256Hex } from '../../src/core/report/hash.js';
import { renderHtmlReport } from '../../src/core/report/html.js';
import { projectEvidenceManifest, REPORT_HASH_BASE } from '../../src/core/report/integrity.js';
import {
  canonicalBatchRuleSummary,
  canonicalCoreRuleSummary,
  canonicalScope,
  derivePageLimitations,
  deriveSystemLimitations,
} from '../../src/core/report/text-policy.js';
import { applyReviewDecisions, createReviewDecision } from '../../src/core/review/decisions.js';
import { aggregateItems } from '../../src/core/rules/aggregate-items.js';
import {
  V1_MIGRATION_DEFAULTS,
  createAuditModel,
  migrateAuditV1ToV2,
} from '../../src/core/report/audit-model.js';
import { reportInput } from './helpers.js';

const ENRICH_OPTIONS = Object.freeze({
  now: () => '2026-08-26T16:00:00.000Z',
  timezone: 'America/Cuiaba',
  manifestVersion: '0.1.0',
  rulesVersion: '1.0.0',
  browserVersion: 'Chrome/147.0.0.0',
});

function rejectsWithoutMarker(fn, marker) {
  assert.throws(fn, error => {
    assert.doesNotMatch(String(error?.message ?? error), new RegExp(marker, 'u'));
    return true;
  });
}

async function rejectsAsyncWithoutMarker(promise, marker) {
  await assert.rejects(promise, error => {
    assert.doesNotMatch(String(error?.message ?? error), new RegExp(marker, 'u'));
    return true;
  });
}

test('separates ABNT item context, source mapping and occurrence-tested WCAG without expanding the alias', () => {
  const input = reportInput();
  input.ruleResults.find(rule => rule.ruleId === 'focus-order').wcag = ['2.4.3'];
  const model = migrateAuditV1ToV2(input);
  const occurrence = model.occurrences[0];
  assert.deepEqual(occurrence.itemWcagRefs, ['2.4.3']);
  assert.deepEqual(occurrence.sourceWcagRefs, ['2.4.3']);
  assert.deepEqual(occurrence.testedWcagRefs, []);
  assert.deepEqual(occurrence.wcagRefs, occurrence.testedWcagRefs);
  assert.deepEqual(occurrence.foreignBenchmarkRefs, []);
});

test('rejects partially present normative occurrence fields', () => {
  const input = structuredClone(SAMPLE_AUDIT);
  delete input.occurrences[0].testedWcagRefs;
  assert.throws(() => createAuditModel(input), /WCAG|campos|parcial|integridade|ocorrência/iu);

  const privateMarker = 'PRIVATE_OCCURRENCE_MARKER';
  input.occurrences[0].occurrenceId = privateMarker;
  assert.throws(() => createAuditModel(input), error => {
    assert.doesNotMatch(error.message, new RegExp(privateMarker, 'u'));
    return true;
  });
});

test('requires the exact normative ledger on every current V2 model and technical JSON export', () => {
  for (const mutate of [
    value => { delete value.normative; },
    value => { delete value.normative.sources; },
  ]) {
    const input = structuredClone(SAMPLE_AUDIT);
    mutate(input);
    assert.throws(() => createAuditModel(input), /normativ|ledger|fontes|sources|ausente/iu);
  }

  const technical = JSON.parse(renderTechnicalJson(SAMPLE_AUDIT));
  assert.deepEqual(technical.audit.normative, SAMPLE_AUDIT.normative);
});

for (const [label, mutate] of [
  ['root', (value, marker) => { value.privateContext = marker; }],
  ['occurrence', (value, marker) => {
    const occurrence = value.occurrences.find(item => item.source.ruleId === 'focus-visible');
    occurrence.occurrenceId = marker;
    occurrence.privateContext = marker;
  }],
  ['manual occurrence', (value, marker) => {
    const occurrence = value.occurrences.find(item => item.source.engine === 'audita-manual-review');
    occurrence.occurrenceId = marker;
    occurrence.privateContext = marker;
  }],
  ['source', (value, marker) => {
    const occurrence = value.occurrences.find(item => item.source.ruleId === 'focus-visible');
    occurrence.occurrenceId = marker;
    occurrence.source.privateContext = marker;
  }],
  ['target', (value, marker) => {
    const occurrence = value.occurrences.find(item => item.source.ruleId === 'focus-visible');
    occurrence.occurrenceId = marker;
    occurrence.target.privateContext = marker;
  }],
  ['reason', (value, marker) => {
    const occurrence = value.occurrences.find(item => item.source.ruleId === 'focus-visible');
    occurrence.occurrenceId = marker;
    occurrence.reason = { privateContext: marker };
  }],
  ['legalAnalysis', (value, marker) => {
    const occurrence = value.occurrences.find(item => item.source.ruleId === 'focus-visible');
    occurrence.occurrenceId = marker;
    occurrence.legalAnalysis.privateContext = marker;
  }],
  ['normative', (value, marker) => {
    value.normative.privateContext = marker;
    value.normative.sources[0].privateContext = marker;
  }],
]) {
  test(`rejects unknown ${label} fields without echoing private input`, async () => {
    const marker = `PRIVATE${label.replace(/[^A-Za-z]/gu, '').toUpperCase()}MARKER9`;
    const candidate = structuredClone(SAMPLE_AUDIT);
    mutate(candidate, marker);
    rejectsWithoutMarker(() => createAuditModel(candidate), marker);
    await rejectsAsyncWithoutMarker(enrichAuditForReport(candidate, ENRICH_OPTIONS), marker);
  });
}

test('unknown occurrence data cannot reach technical JSON, EARL, HTML or CSV', () => {
  const marker = 'PRIVATEEXPORTMARKER9';
  const candidate = structuredClone(SAMPLE_AUDIT);
  const occurrence = candidate.occurrences.find(item => item.source.ruleId === 'focus-visible');
  occurrence.occurrenceId = marker;
  occurrence.privateContext = marker;

  rejectsWithoutMarker(() => renderTechnicalJson(candidate), marker);
  rejectsWithoutMarker(() => renderHtmlReport(candidate), marker);
  rejectsWithoutMarker(() => renderOccurrenceCsv(candidate), marker);
});

test('binds core WCAG claims exactly to the authoritative rule, item and outcome', () => {
  const failedCoverageErased = structuredClone(SAMPLE_AUDIT);
  const failed = failedCoverageErased.occurrences.find(value => value.source.ruleId === 'focus-visible');
  failed.sourceWcagRefs = [];
  failed.testedWcagRefs = [];
  failed.wcagRefs = [];
  failed.foreignBenchmarkRefs = [];
  assert.throws(
    () => createAuditModel(failedCoverageErased),
    /WCAG|cobertura|fonte|regra|autoritativ|testad/iu,
  );

  const cantTellInventedCoverage = structuredClone(SAMPLE_AUDIT);
  const inconclusive = cantTellInventedCoverage.occurrences.find(value => value.source.ruleId === 'focus-order');
  inconclusive.testedWcagRefs = [...inconclusive.sourceWcagRefs];
  inconclusive.wcagRefs = [...inconclusive.testedWcagRefs];
  inconclusive.foreignBenchmarkRefs = [...section508ReferencesForWcag(inconclusive.testedWcagRefs)];
  assert.throws(
    () => createAuditModel(cantTellInventedCoverage),
    /WCAG|508|cobertura|resultado|autoritativ|testad/iu,
  );

  for (const mutate of [
    value => { delete value.ruleResults.find(rule => rule.ruleId === 'focus-order').wcag; },
    value => { value.ruleResults.find(rule => rule.ruleId === 'focus-order').wcag = ['1.1.1']; },
    value => { value.occurrences.find(item => item.source.ruleId === 'focus-order').sourceWcagRefs = []; },
  ]) {
    const forged = structuredClone(SAMPLE_AUDIT);
    mutate(forged);
    assert.throws(
      () => createAuditModel(forged),
      /WCAG|fonte|regra|registro|autoritativ|mapeamento/iu,
    );
  }

  const outcomeDrift = structuredClone(SAMPLE_AUDIT);
  outcomeDrift.ruleResults.find(rule => rule.ruleId === 'focus-order').outcome = 'passed';
  assert.throws(
    () => createAuditModel(outcomeDrift),
    /resultado|outcome|regra|autoritativ|incoerente/iu,
  );

  const manual = SAMPLE_AUDIT.occurrences.find(value => value.source.engine === 'audita-manual-review');
  assert.deepEqual(manual.itemWcagRefs, []);
  assert.deepEqual(manual.sourceWcagRefs, []);
  assert.deepEqual(manual.testedWcagRefs, []);
  assert.deepEqual(manual.wcagRefs, []);
  assert.deepEqual(manual.foreignBenchmarkRefs, []);

  const manualFailure = structuredClone(SAMPLE_AUDIT);
  const forgedManual = manualFailure.occurrences.find(value => value.source.engine === 'audita-manual-review');
  forgedManual.outcome = 'failed';
  forgedManual.legalAnalysis = { basisRef: CONSUMER_ACCESSIBILITY_FIXED_BASIS.id };
  assert.throws(
    () => createAuditModel(manualFailure),
    /manual|revis[aã]o|resultado|cantTell|decis[aã]o/iu,
  );
});

test('rejects a single-page failed core rule downgraded to a cantTell occurrence', () => {
  const downgraded = structuredClone(SAMPLE_AUDIT);
  const failed = downgraded.occurrences.find(value => value.source.ruleId === 'focus-visible');
  failed.outcome = 'cantTell';
  failed.confidence = 'low';
  failed.testedWcagRefs = [];
  failed.wcagRefs = [];
  failed.foreignBenchmarkRefs = [];
  failed.legalAnalysis = null;
  assert.throws(
    () => createAuditModel(downgraded),
    /resultado|outcome|regra|autoritativ|complet/iu,
  );
});

test('rejects a single-page failed core rule whose occurrence was deleted', () => {
  const deletedFailure = structuredClone(SAMPLE_AUDIT);
  deletedFailure.occurrences = deletedFailure.occurrences.filter(value => value.source.ruleId !== 'focus-visible');
  assert.throws(
    () => createAuditModel(deletedFailure),
    /ocorrência|cobertura|complet|alvo|produto/iu,
  );
});

test('rejects a single-page failed or cantTell core target omitted from occurrences', () => {
  const omittedTarget = structuredClone(SAMPLE_AUDIT);
  omittedTarget.ruleResults.find(value => value.ruleId === 'focus-order').targets.push('n-2');
  assert.throws(
    () => createAuditModel(omittedTarget),
    /ocorrência|cobertura|complet|alvo|produto/iu,
  );
});

test('exposes the exact frozen normative source ledger without paths or query-bearing URLs', async () => {
  const { NORMATIVE_SOURCE_LEDGER } = await import('../../src/core/normative/source-ledger.js');
  assert.equal(Object.isFrozen(NORMATIVE_SOURCE_LEDGER), true);
  assert.deepEqual(NORMATIVE_SOURCE_LEDGER, [
    {
      id: 'abnt.nbr17225.2025', version: '2025', title: 'ABNT NBR 17225:2025',
      localCopy: {
        fileName: 'ABNT-NBR-17225-Acessibilidade-Digital.pdf',
        sha256: '1c3ee66b7fd606367e3de087e6a55fea90f4d368d8a1f769141d5e3b96d32afc',
      },
    },
    { id: 'w3c.wcag22', version: '2.2', title: 'Web Content Accessibility Guidelines (WCAG) 2.2', url: 'https://www.w3.org/TR/WCAG22/' },
    { id: 'us.access-board.revised-508', version: '2017', title: 'Revised 508 Standards and Section 255 Guidelines', url: 'https://www.access-board.gov/ict/' },
    { id: 'us.section508.applicability-conformance', version: 'current', title: 'Applicability and Conformance', url: 'https://www.section508.gov/develop/applicability-conformance/' },
  ]);
  assert.doesNotMatch(JSON.stringify(NORMATIVE_SOURCE_LEDGER), /[?#]|(?:^|["'])\/(?:Users|Volumes|private)\//u);
});

function reviewDecision(occurrenceId, itemId, answer, mode) {
  return createReviewDecision({
    auditId: SAMPLE_AUDIT.auditId,
    itemId,
    occurrenceId,
    answer,
    evaluator: 'Fiscal de teste',
    decidedAt: '2026-08-26T15:00:00.000Z',
    mode,
  });
}

function authorityConsistentSample({ axe = false } = {}) {
  const model = structuredClone(SAMPLE_AUDIT);
  const aggregate = new Map(aggregateItems(
    model.ruleResults.filter(rule => rule.source.engine === 'audita-core'),
    NBR17225_ITEMS,
  ).map(item => [item.id, item]));
  for (const item of model.itemResults) {
    const expected = aggregate.get(item.id);
    item.outcome = expected.outcome;
    item.ruleResults = expected.ruleResults.map(rule => rule.ruleId);
    delete item.originalOutcome;
    delete item.reviewedOutcome;
    delete item.review;
  }
  if (axe) {
    model.axe = structuredClone(normalizeAxeResults({
      status: 'disabled', provenance: AXE_PROVENANCE, frames: [],
    }, { pageId: 'page-1', rulesVersion: '1.0.0' }));
    const diagnostic = {
      code: 'AXE_FEATURE_DISABLED',
      message: 'O motor suplementar axe-core permaneceu desativado pelo gate MV3/CSP; o motor próprio continuou normalmente.',
      at: '2026-08-26T14:00:30.000Z', recoverable: true,
    };
    model.pages[0].diagnostics.push(diagnostic);
    model.session.diagnostics.push(structuredClone(diagnostic));
  }
  syncDerivedClaims(model);
  return model;
}

function syncDerivedClaims(model) {
  model.limitations = deriveSystemLimitations(model);
  for (const page of model.pages) {
    const limitations = derivePageLimitations(model, page);
    if (limitations.length > 0) page.limitations = limitations;
    else delete page.limitations;
  }
  return model;
}

function syncCoreItemAuthority(model) {
  const aggregate = new Map(aggregateItems(
    model.ruleResults.filter(rule => rule.source.engine === 'audita-core'),
    NBR17225_ITEMS,
  ).map(item => [item.id, item]));
  for (const item of model.itemResults) {
    const expected = aggregate.get(item.id);
    item.outcome = expected.outcome;
    item.ruleResults = expected.ruleResults.map(rule => rule.ruleId);
    delete item.originalOutcome;
    delete item.reviewedOutcome;
    delete item.review;
  }
  return model;
}

function withoutCoreExecution(model = authorityConsistentSample()) {
  model.ruleResults = model.ruleResults.filter(rule => rule.source.engine !== 'audita-core');
  const retainedOccurrenceIds = new Set(model.occurrences
    .filter(occurrence => occurrence.source.engine !== 'audita-core')
    .map(occurrence => occurrence.occurrenceId));
  model.occurrences = model.occurrences.filter(occurrence => retainedOccurrenceIds.has(occurrence.occurrenceId));
  model.manualReview = model.manualReview.filter(entry => retainedOccurrenceIds.has(entry.occurrenceId));
  model.reviewDecisions = model.reviewDecisions.filter(decision => retainedOccurrenceIds.has(decision.occurrenceId));
  return syncCoreItemAuthority(model);
}

function setSingleStatus(model, status, { diagnostics = model.session.diagnostics } = {}) {
  model.pages[0].status = status;
  model.pages[0].diagnostics = structuredClone(diagnostics);
  model.session.status = status;
  model.session.partial = status === 'partial';
  model.session.diagnostics = diagnostics;
  return syncDerivedClaims(model);
}

function batchWithUnattemptedPage() {
  const model = structuredClone(migrateAuditV1ToV2(reportInput()));
  const requestedUrl = 'https://not-started.example.test/';
  const diagnostic = {
    code: 'BATCH_NOT_STARTED_CLEANUP_UNCONFIRMED',
    message: 'A página não foi iniciada porque a limpeza anterior não foi confirmada.',
    at: '2026-08-26T14:01:00.000Z',
    recoverable: false,
  };
  model.requestedScope = { mode: 'batch', urls: [...model.requestedScope.urls, requestedUrl] };
  model.scope = canonicalScope('batch', 2);
  model.pages[0].coverage = {};
  const pageRecoverable = {
    code: 'TAB_CLOSE_FAILED', message: 'A aba descartável não pôde ser fechada automaticamente.',
    at: '2026-08-26T14:01:00.000Z', recoverable: true,
  };
  model.pages[0].diagnostics = [pageRecoverable];
  for (const rule of model.ruleResults) {
    if (rule.source?.engine === 'audita-core') {
      rule.summary = canonicalBatchRuleSummary(rule.outcome, 1, 2);
    }
  }
  model.pages.push({
    pageId: 'page-2', requestedUrl, finalUrl: requestedUrl, finalUrlObserved: false,
    status: 'failed', attempted: false,
    timestamps: {
      startedAt: '2026-08-26T14:01:00.000Z',
      endedAt: '2026-08-26T14:01:00.000Z',
      generatedAt: '2026-08-26T14:01:00.000Z',
    },
    viewport: { width: null, height: null, deviceScaleFactor: null },
    diagnostics: [diagnostic], coverage: {}, warnings: [], axeStatus: 'not-run',
  });
  model.session = {
    status: 'partial', partial: true,
    diagnostics: [pageRecoverable, diagnostic],
  };
  return syncDerivedClaims(model);
}

function singleUnattemptedAudit() {
  const model = withoutCoreExecution();
  const diagnostic = {
    code: 'NAVIGATION_FAILED', message: 'O site não pôde ser aberto de forma estável.',
    at: '2026-08-26T14:00:30.000Z', recoverable: false,
  };
  model.requestedScope = { mode: 'single', urls: [model.requestedUrl] };
  model.finalUrl = model.requestedUrl;
  model.pages = [{
    pageId: 'page-1', requestedUrl: model.requestedUrl, finalUrl: model.requestedUrl,
    finalUrlObserved: false, status: 'failed', attempted: false,
    timestamps: {
      startedAt: diagnostic.at, endedAt: diagnostic.at,
      generatedAt: model.timestamps.generatedAt,
    },
    viewport: { width: null, height: null, deviceScaleFactor: null },
    diagnostics: [diagnostic], warnings: [], axeStatus: 'not-run',
  }];
  model.environment.viewport = { width: null, height: null, deviceScaleFactor: null };
  model.session = { status: 'failed', partial: false, diagnostics: [diagnostic] };
  model.ruleResults = [];
  model.methodology.ruleCount = 0;
  model.methodology.supplementalRuleCount = 0;
  model.occurrences = [];
  model.evidence = [];
  model.evidenceStateCount = 0;
  model.manualReview = [];
  model.reviewDecisions = [];
  model.reproducibility.capturedStateCount = 0;
  delete model.snapshot;
  delete model.axe;
  delete model.axePages;
  delete model.presentation;
  syncCoreItemAuthority(model);
  return syncDerivedClaims(model);
}

function singleAttemptedUnobservedAudit() {
  const model = singleUnattemptedAudit();
  model.pages[0].attempted = true;
  model.pages[0].timestamps = structuredClone(model.timestamps);
  return model;
}

function singleObservedTerminalWithoutResults(status, code, message) {
  const model = withoutCoreExecution();
  model.ruleResults = [];
  model.occurrences = [];
  model.evidence = [];
  model.evidenceStateCount = 0;
  model.manualReview = [];
  model.reviewDecisions = [];
  model.methodology.ruleCount = 0;
  model.methodology.supplementalRuleCount = 0;
  model.reproducibility.capturedStateCount = 0;
  delete model.snapshot;
  syncCoreItemAuthority(model);
  return setSingleStatus(model, status, { diagnostics: [
    { code, message, at: '2026-08-26T14:00:30.000Z', recoverable: false },
    {
      code: 'FULL_PAGE_CAPTURE_FAILED',
      message: 'Não foi possível capturar a página completa no estado original.',
      at: '2026-08-26T14:00:30.000Z', recoverable: true,
    },
  ] });
}

function editorialInapplicableRule() {
  return {
    ruleId: 'editorial.placeholder-text', outcome: 'inapplicable', mode: 'automated',
    classification: 'editorial', impact: 'minor', confidence: 'high',
    source: { engine: 'audita-editorial', ruleId: 'editorial.placeholder-text', version: '1.0.0' },
    nbrItems: [], wcag: [], targets: [],
    summary: 'Não foi observado conteúdo provisório inequívoco.', limitations: [],
  };
}

test('requires the exact 130-rule registered core inventory for complete and partial sessions', () => {
  assert.equal(SAMPLE_AUDIT.ruleResults.filter(rule => rule.source.engine === 'audita-core').length, 130);

  for (const status of ['complete', 'partial']) {
    const zero = withoutCoreExecution();
    zero.methodology.ruleCount = 0;
    zero.methodology.supplementalRuleCount = 0;
    setSingleStatus(zero, status, { diagnostics: status === 'partial' ? zero.session.diagnostics : [] });

    const missingOne = authorityConsistentSample();
    const removed = missingOne.ruleResults.find(rule =>
      rule.source.engine === 'audita-core' && rule.outcome === 'inapplicable');
    missingOne.ruleResults = missingOne.ruleResults.filter(rule => rule.ruleId !== removed.ruleId);
    missingOne.methodology.ruleCount = missingOne.ruleResults.length;
    syncCoreItemAuthority(missingOne);
    setSingleStatus(missingOne, status, { diagnostics: status === 'partial' ? missingOne.session.diagnostics : [] });

    const substituted = structuredClone(missingOne);
    substituted.ruleResults.push(editorialInapplicableRule());
    substituted.methodology.ruleCount = substituted.ruleResults.length;
    substituted.methodology.supplementalRuleCount = 1;
    syncCoreItemAuthority(substituted);

    const duplicated = authorityConsistentSample();
    duplicated.ruleResults.push(structuredClone(removed));
    duplicated.methodology.ruleCount = duplicated.ruleResults.length;
    setSingleStatus(duplicated, status, { diagnostics: status === 'partial' ? duplicated.session.diagnostics : [] });

    for (const candidate of [zero, missingOne, substituted, duplicated]) {
      assert.throws(
        () => createAuditModel(candidate),
        /130|inventário|regra|core|metodologia|duplicad|suplementar|quantidade/iu,
      );
    }
  }
});

test('allows a failed or cancelled pre-execution subset only with a compatible fatal diagnostic', () => {
  const scenarios = [
    ['failed', 'COLLECTION_FAILED', 'A estrutura da página não pôde ser coletada com segurança.'],
    ['cancelled', 'NAVIGATION_FAILED', 'A auditoria foi cancelada.'],
  ];
  for (const [status, code, message] of scenarios) {
    const candidate = singleObservedTerminalWithoutResults(status, code, message);

    assert.doesNotThrow(() => createAuditModel(candidate));

    const incompatible = structuredClone(candidate);
    incompatible.session.diagnostics = [{
      code: 'FRAME_LIMITED', message: 'Um frame não pôde ser lido.',
      at: '2026-08-26T14:00:30.000Z', recoverable: true,
    }];
    assert.throws(() => createAuditModel(incompatible), /diagnóstico|fase|falha|cancel|incomplet|regra/iu);
  }
});

test('binds complete and cancelled terminal states while rejecting a failed terminal claim over a full core inventory', () => {
  const fatal = (code, message) => ({
    code, message, at: '2026-08-26T14:00:30.000Z', recoverable: false,
  });

  const completeWithFatal = authorityConsistentSample();
  setSingleStatus(completeWithFatal, 'complete', {
    diagnostics: [fatal('COLLECTION_FAILED', 'A estrutura da página não pôde ser coletada com segurança.')],
  });
  assert.throws(() => createAuditModel(completeWithFatal), /status|sessão|diagnóst|fatal|modelo/iu);

  for (const [status, code, message] of [
    ['failed', 'CORE_AUDIT_FAILED', 'O núcleo de regras não pôde concluir a auditoria.'],
    ['cancelled', 'NAVIGATION_FAILED', 'A auditoria foi cancelada.'],
  ]) {
    const missingFatal = authorityConsistentSample();
    setSingleStatus(missingFatal, status, { diagnostics: [] });
    assert.throws(() => createAuditModel(missingFatal), /status|sessão|diagnóst|fatal|modelo/iu);

    const recoverableOnly = authorityConsistentSample();
    setSingleStatus(recoverableOnly, status, {
      diagnostics: [{
        code: 'FRAME_LIMITED', message: 'Um frame não pôde ser lido.',
        at: '2026-08-26T14:00:30.000Z', recoverable: true,
      }],
    });
    assert.throws(() => createAuditModel(recoverableOnly), /status|sessão|diagnóst|fatal|modelo/iu);

    const candidateWithFullFacts = authorityConsistentSample();
    setSingleStatus(candidateWithFullFacts, status, { diagnostics: [fatal(code, message)] });
    if (status === 'failed') {
      assert.throws(() => createAuditModel(candidateWithFullFacts), /fase|resultado|regra|modelo/iu);
      const compatible = singleObservedTerminalWithoutResults(status, code, message);
      assert.doesNotThrow(() => createAuditModel(compatible));
    } else {
      assert.doesNotThrow(() => createAuditModel(candidateWithFullFacts));
    }
  }
});

test('accepts terminal fatal diagnostics only from the exact code and message catalogue', () => {
  const canonicalFatal = {
    code: 'CORE_AUDIT_FAILED', message: 'O núcleo de regras não pôde concluir a auditoria.',
    at: '2026-08-26T14:00:30.000Z', recoverable: false,
  };
  const canonical = singleObservedTerminalWithoutResults(
    'failed', canonicalFatal.code, canonicalFatal.message,
  );
  assert.doesNotThrow(() => createAuditModel(canonical));

  const forgedExtra = structuredClone(canonical);
  const forged = {
    code: 'FORGED_FATAL', message: 'PRIVATE_FORGED_FATAL_MESSAGE_7Q9Z',
    at: '2026-08-26T14:00:30.000Z', recoverable: false,
  };
  forgedExtra.session.diagnostics.push(forged);
  forgedExtra.pages[0].diagnostics.push(structuredClone(forged));

  const alteredMessage = structuredClone(canonical);
  alteredMessage.session.diagnostics[0].message = 'PRIVATE_ALTERED_CORE_MESSAGE_7Q9Z';
  alteredMessage.pages[0].diagnostics[0].message = 'PRIVATE_ALTERED_CORE_MESSAGE_7Q9Z';

  for (const candidate of [forgedExtra, alteredMessage]) {
    assert.throws(() => createAuditModel(candidate), /modelo|diagnóst|fatal/iu);
  }
});

test('rejects results, evidence or execution claims for a page explicitly marked as not attempted', () => {
  const canonical = batchWithUnattemptedPage();
  assert.doesNotThrow(() => createAuditModel(canonical));

  const withOccurrence = structuredClone(canonical);
  const occurrence = structuredClone(withOccurrence.occurrences[0]);
  occurrence.occurrenceId = 'occ-unattempted';
  occurrence.pageId = 'page-2';
  occurrence.evidenceRefs = [];
  occurrence.evidenceIds = [];
  withOccurrence.occurrences.push(occurrence);
  withOccurrence.manualReview.push({
    ...structuredClone(withOccurrence.manualReview[0]), occurrenceId: occurrence.occurrenceId,
  });

  const withEvidence = structuredClone(canonical);
  withEvidence.evidence.push({
    evidenceId: 'ev-unattempted', pageId: 'page-2', kind: 'element', nodeId: null,
  });

  const withExecution = structuredClone(canonical);
  withExecution.pages[1].axeStatus = 'complete';

  const withObservedNavigation = structuredClone(canonical);
  withObservedNavigation.pages[1].finalUrlObserved = true;

  const withElapsedExecution = structuredClone(canonical);
  withElapsedExecution.pages[1].timestamps.endedAt = '2026-08-26T14:00:46.000Z';
  withElapsedExecution.pages[1].timestamps.generatedAt = '2026-08-26T14:00:46.000Z';

  const withViewport = structuredClone(canonical);
  withViewport.pages[1].viewport = { width: 1280, height: 720, deviceScaleFactor: 1 };

  const withPositiveWidgetObservation = structuredClone(canonical);
  withPositiveWidgetObservation.pages[1].accessibilityWidgets = {
    detector: 'audita.accessibility-widgets', version: '1.0.0', coverage: 'complete',
    widgets: [
      { id: 'vlibras', status: 'present', signals: ['dom-signature'] },
      { id: 'hand-talk', status: 'absent', signals: [] },
    ],
  };

  for (const candidate of [
    withOccurrence, withEvidence, withExecution, withObservedNavigation, withElapsedExecution,
    withViewport, withPositiveWidgetObservation,
  ]) {
    assert.throws(() => createAuditModel(candidate), /attempted|iniciada|execução|resultado|evidência|modelo/iu);
  }
});

test('rejects global single-page execution claims when the only page was not attempted', () => {
  for (const canonical of [singleUnattemptedAudit(), singleAttemptedUnobservedAudit()]) {
    assert.doesNotThrow(() => createAuditModel(canonical));

    const withSnapshot = structuredClone(canonical);
    withSnapshot.snapshot = {
      schemaVersion: 1, retention: 'summary-only', nodeCount: 1,
      coverage: { runtime: { outcome: 'complete', expectedFrameCount: 1, observedFrameCount: 1 } },
      warnings: [],
    };

    const withWidgets = structuredClone(canonical);
    withWidgets.accessibilityWidgets = {
      detector: 'audita.accessibility-widgets', version: '1.0.0', coverage: 'complete',
      widgets: [
        { id: 'vlibras', status: 'present', signals: ['dom-signature'] },
        { id: 'hand-talk', status: 'absent', signals: [] },
      ],
    };

    const withRules = structuredClone(canonical);
    withRules.ruleResults = structuredClone(authorityConsistentSample().ruleResults);
    withRules.methodology.ruleCount = withRules.ruleResults.length;
    syncCoreItemAuthority(withRules);

    for (const candidate of [withSnapshot, withWidgets, withRules]) {
      assert.throws(
        () => createAuditModel(candidate),
        /attempted|iniciada|observada|execução|resultado|snapshot|widget|regra|modelo/iu,
      );
    }
  }
});

test('applies one declarative pre-observation matrix to attempted and unattempted pages', () => {
  for (const canonical of [singleUnattemptedAudit(), singleAttemptedUnobservedAudit()]) {
    assert.doesNotThrow(() => createAuditModel(canonical));
    const variants = [];

    const redirected = structuredClone(canonical);
    redirected.pages[0].finalUrl = 'https://redirected.example.test/';
    redirected.finalUrl = redirected.pages[0].finalUrl;
    variants.push(redirected);

    const withViewport = structuredClone(canonical);
    withViewport.pages[0].viewport = { width: 1280, height: 720, deviceScaleFactor: 1 };
    withViewport.environment.viewport = structuredClone(withViewport.pages[0].viewport);
    variants.push(withViewport);

    const withAxe = structuredClone(canonical);
    withAxe.pages[0].axeStatus = 'complete';
    variants.push(withAxe);

    const withCoverage = structuredClone(canonical);
    withCoverage.pages[0].coverage = { runtime: { outcome: 'complete' } };
    variants.push(withCoverage);

    const withWidgets = structuredClone(canonical);
    withWidgets.pages[0].accessibilityWidgets = {
      detector: 'audita.accessibility-widgets', version: '1.0.0', coverage: 'complete',
      widgets: [
        { id: 'vlibras', status: 'present', signals: ['dom-signature'] },
        { id: 'hand-talk', status: 'absent', signals: [] },
      ],
    };
    variants.push(withWidgets);

    for (const candidate of variants) {
      assert.throws(() => createAuditModel(candidate), /página|observad|execução|URL|modelo/iu);
    }
  }

  const elapsedAttempt = singleAttemptedUnobservedAudit();
  assert.notEqual(elapsedAttempt.pages[0].timestamps.startedAt, elapsedAttempt.pages[0].timestamps.endedAt);
  assert.doesNotThrow(() => createAuditModel(elapsedAttempt));

  const elapsedWithoutAttempt = singleUnattemptedAudit();
  elapsedWithoutAttempt.pages[0].timestamps.startedAt = elapsedWithoutAttempt.timestamps.startedAt;
  assert.throws(() => createAuditModel(elapsedWithoutAttempt), /página|duração|attempted|modelo/iu);
});

test('binds required page axeStatus exactly to the single or batch axe envelope', () => {
  const missing = authorityConsistentSample();
  delete missing.pages[0].axeStatus;
  assert.throws(() => createAuditModel(missing), /axeStatus|axe|página|modelo/iu);

  const withoutEnvelope = authorityConsistentSample();
  withoutEnvelope.pages[0].axeStatus = 'complete';
  assert.throws(() => createAuditModel(withoutEnvelope), /axeStatus|axe|página|modelo/iu);

  const disabledEnvelope = authorityConsistentSample({ axe: true });
  disabledEnvelope.pages[0].axeStatus = 'disabled';
  assert.doesNotThrow(() => createAuditModel(disabledEnvelope));
  disabledEnvelope.pages[0].axeStatus = 'not-run';
  assert.throws(() => createAuditModel(disabledEnvelope), /axeStatus|axe|página|modelo/iu);

  const batchWithoutEnvelope = batchWithUnattemptedPage();
  batchWithoutEnvelope.pages[0].axeStatus = 'complete';
  assert.throws(() => createAuditModel(batchWithoutEnvelope), /axeStatus|axe|página|modelo/iu);

  const singleWithBatchEnvelope = authorityConsistentSample();
  singleWithBatchEnvelope.axePages = [{
    pageId: 'page-1', result: structuredClone(authorityConsistentSample({ axe: true }).axe),
  }];
  assert.throws(() => createAuditModel(singleWithBatchEnvelope), /axe|modo|single|lote|modelo/iu);

  const batchWithSingleEnvelope = batchWithUnattemptedPage();
  batchWithSingleEnvelope.axe = structuredClone(authorityConsistentSample({ axe: true }).axe);
  assert.throws(() => createAuditModel(batchWithSingleEnvelope), /axe|modo|single|lote|modelo/iu);
});

test('binds the optional primary-page widget inventory to the authoritative root inventory', () => {
  const contradictoryWidgets = {
    detector: 'audita.accessibility-widgets', version: '1.0.0', coverage: 'complete',
    widgets: [
      { id: 'vlibras', status: 'absent', signals: [] },
      { id: 'hand-talk', status: 'absent', signals: [] },
    ],
  };
  for (const candidate of [authorityConsistentSample(), batchWithUnattemptedPage()]) {
    candidate.pages[0].accessibilityWidgets = structuredClone(contradictoryWidgets);
    assert.throws(() => createAuditModel(candidate), /widget|página|raiz|inventário|modelo/iu);
  }

  const matching = authorityConsistentSample();
  matching.pages[0].accessibilityWidgets = structuredClone(matching.accessibilityWidgets);
  assert.doesNotThrow(() => createAuditModel(matching));
});

test('requires every root fatal diagnostic to correspond to the terminal page facts', () => {
  const hiddenSingleRecoverable = authorityConsistentSample();
  hiddenSingleRecoverable.pages[0].diagnostics = structuredClone(hiddenSingleRecoverable.session.diagnostics);
  hiddenSingleRecoverable.session.diagnostics = [];
  assert.throws(() => createAuditModel(hiddenSingleRecoverable), /diagnóst|página|sessão|modelo/iu);

  const single = authorityConsistentSample();
  single.session.diagnostics.push({
    code: 'CORE_AUDIT_FAILED', message: 'O núcleo de regras não pôde concluir a auditoria.',
    at: single.timestamps.endedAt, recoverable: false,
  });
  assert.throws(() => createAuditModel(single), /diagnóst|fatal|página|status|modelo/iu);

  const canonicalBatch = batchWithUnattemptedPage();
  assert.doesNotThrow(() => createAuditModel(canonicalBatch));

  const missing = structuredClone(canonicalBatch);
  missing.session.diagnostics = missing.session.diagnostics.filter(diagnostic => diagnostic.recoverable !== false);

  const duplicated = structuredClone(canonicalBatch);
  duplicated.session.diagnostics.push(structuredClone(
    duplicated.session.diagnostics.find(diagnostic => diagnostic.recoverable === false),
  ));

  const mismatched = structuredClone(canonicalBatch);
  mismatched.session.diagnostics = mismatched.session.diagnostics.map(diagnostic => structuredClone(diagnostic));
  const rootFatal = mismatched.session.diagnostics.find(diagnostic => diagnostic.recoverable === false);
  rootFatal.code = 'BATCH_PAGE_FAILED';
  rootFatal.message = 'A página não pôde ser auditada.';

  const missingRecoverable = structuredClone(canonicalBatch);
  missingRecoverable.session.diagnostics = missingRecoverable.session.diagnostics
    .filter(diagnostic => diagnostic.recoverable === false);

  const duplicatedRecoverable = structuredClone(canonicalBatch);
  duplicatedRecoverable.session.diagnostics.push(structuredClone(
    duplicatedRecoverable.session.diagnostics.find(diagnostic => diagnostic.recoverable === true),
  ));

  for (const candidate of [missing, duplicated, mismatched, missingRecoverable, duplicatedRecoverable]) {
    assert.throws(() => createAuditModel(candidate), /diagnóst|fatal|página|correspond|modelo/iu);
  }

  const reordered = structuredClone(canonicalBatch);
  reordered.session.diagnostics.reverse();
  assert.doesNotThrow(() => createAuditModel(reordered));

  const withSessionOnlyRecoverable = structuredClone(canonicalBatch);
  const sessionOnlyRecoverable = {
    code: 'REPORT_PDF_UNAVAILABLE', message: 'O PDF não foi gerado devido a uma limitação técnica local.',
    at: withSessionOnlyRecoverable.timestamps.generatedAt, recoverable: true,
  };
  withSessionOnlyRecoverable.session.diagnostics.push(sessionOnlyRecoverable);
  withSessionOnlyRecoverable.report = {
    status: 'partial', reviewUrl: null,
    artifact: {
      status: 'partial', pdfFallback: false,
      formats: [
        { format: 'html', status: 'prepared' },
        { format: 'csv', status: 'prepared' },
        { format: 'json', status: 'prepared' },
      ],
      limitations: [sessionOnlyRecoverable.message],
    },
  };
  syncDerivedClaims(withSessionOnlyRecoverable);
  assert.doesNotThrow(() => createAuditModel(withSessionOnlyRecoverable));

  const staleSessionOnlyRecoverable = structuredClone(withSessionOnlyRecoverable);
  staleSessionOnlyRecoverable.session.diagnostics.find(
    diagnostic => diagnostic.code === sessionOnlyRecoverable.code,
  ).at = staleSessionOnlyRecoverable.timestamps.endedAt;
  assert.throws(
    () => createAuditModel(staleSessionOnlyRecoverable),
    /diagnóst|geração|fechamento|sessão|modelo/iu,
  );

  const duplicatedSessionOnlyRecoverable = structuredClone(withSessionOnlyRecoverable);
  duplicatedSessionOnlyRecoverable.session.diagnostics.push(structuredClone(sessionOnlyRecoverable));
  assert.throws(
    () => createAuditModel(duplicatedSessionOnlyRecoverable),
    /diagnóst|duplicad|sessão|modelo/iu,
  );
});

test('requires attempted on every page and binds each page status to its own fatal diagnostics', () => {
  const missingAttempted = authorityConsistentSample();
  delete missingAttempted.pages[0].attempted;
  assert.throws(() => createAuditModel(missingAttempted), /página|attempted|tentativa|modelo/iu);

  const missingFinalUrlObserved = authorityConsistentSample();
  delete missingFinalUrlObserved.pages[0].finalUrlObserved;
  assert.throws(() => createAuditModel(missingFinalUrlObserved), /página|finalUrlObserved|observad|modelo/iu);

  const unobservedRedirect = authorityConsistentSample();
  unobservedRedirect.pages[0].finalUrlObserved = false;
  assert.throws(() => createAuditModel(unobservedRedirect), /página|URL|observad|modelo/iu);

  const observedWithoutAttempt = singleUnattemptedAudit();
  observedWithoutAttempt.pages[0].finalUrlObserved = true;
  assert.throws(() => createAuditModel(observedWithoutAttempt), /página|attempted|observad|execução|modelo/iu);

  const partialWithFatal = authorityConsistentSample();
  partialWithFatal.pages[0].diagnostics = [{
    code: 'BATCH_PAGE_FAILED', message: 'A página não pôde ser auditada.',
    at: '2026-08-26T14:00:30.000Z', recoverable: false,
  }];
  assert.throws(() => createAuditModel(partialWithFatal), /página|fatal|status|diagnóstico|modelo/iu);

  for (const pageDiagnostics of [
    [],
    [{
      code: 'BATCH_CANCELLED', message: 'A página foi cancelada.',
      at: '2026-08-26T14:00:30.000Z', recoverable: false,
    }],
  ]) {
    const failed = authorityConsistentSample();
    setSingleStatus(failed, 'failed', { diagnostics: [{
      code: 'CORE_AUDIT_FAILED', message: 'O núcleo de regras não pôde concluir a auditoria.',
      at: '2026-08-26T14:00:30.000Z', recoverable: false,
    }] });
    failed.pages[0].diagnostics = pageDiagnostics;
    assert.throws(() => createAuditModel(failed), /página|fatal|status|diagnóstico|modelo/iu);
  }
});

test('binds every diagnostic to one declared mode, role, execution stage, status and cardinality', () => {
  const fatal = (code, message, at = '2026-08-26T14:00:30.000Z') => ({
    code, message, at, recoverable: false,
  });
  const recoverable = (code, message) => ({
    code, message, at: '2026-08-26T14:00:30.000Z', recoverable: true,
  });

  for (const diagnostic of [
    fatal('COLLECTION_FAILED', 'A estrutura da página não pôde ser coletada com segurança.'),
    fatal('CORE_AUDIT_FAILED', 'O núcleo de regras não pôde concluir a auditoria.'),
    fatal('BATCH_PAGE_TIMEOUT', 'A página excedeu o tempo limite da auditoria.'),
  ]) {
    const candidate = singleUnattemptedAudit();
    setSingleStatus(candidate, 'failed', { diagnostics: [diagnostic] });
    assert.throws(() => createAuditModel(candidate), /diagnóst|fase|tentativa|modo|página|modelo/iu);
  }

  const activeCancellationBeforeStart = singleUnattemptedAudit();
  setSingleStatus(activeCancellationBeforeStart, 'cancelled', { diagnostics: [
    fatal('BATCH_CANCELLED', 'A página ativa foi cancelada e limpa antes do encerramento do lote.'),
  ] });
  assert.throws(() => createAuditModel(activeCancellationBeforeStart), /diagnóst|fase|tentativa|modo|página|modelo/iu);

  for (const diagnostics of [
    [
      fatal('CORE_AUDIT_FAILED', 'O núcleo de regras não pôde concluir a auditoria.'),
      fatal('COLLECTION_FAILED', 'A estrutura da página não pôde ser coletada com segurança.'),
    ],
    [
      fatal('CORE_AUDIT_FAILED', 'O núcleo de regras não pôde concluir a auditoria.'),
      fatal('CORE_AUDIT_FAILED', 'O núcleo de regras não pôde concluir a auditoria.'),
    ],
  ]) {
    const candidate = authorityConsistentSample();
    setSingleStatus(candidate, 'failed', { diagnostics });
    assert.throws(() => createAuditModel(candidate), /diagnóst|fatal|cardinal|duplicad|modelo/iu);
  }

  for (const diagnostic of [
    recoverable('DYNAMIC_PROBES_FAILED', 'As verificações dinâmicas não puderam ser concluídas.'),
    recoverable('FULL_PAGE_CAPTURE_FAILED', 'Não foi possível capturar a página completa no estado original.'),
    recoverable('REPORT_PDF_UNAVAILABLE', 'O PDF não foi gerado devido a uma limitação técnica local.'),
  ]) {
    const candidate = authorityConsistentSample();
    setSingleStatus(candidate, 'complete', { diagnostics: [diagnostic] });
    assert.throws(() => createAuditModel(candidate), /diagnóst|fase|papel|status|página|modelo/iu);
  }

  const occurrenceIds = authorityConsistentSample().occurrences.slice(0, 2)
    .map(occurrence => occurrence.occurrenceId);
  const occurrenceDiagnostics = occurrenceIds.map(occurrenceId => ({
    code: 'SNIPPET_CAPTURE_FAILED',
    message: 'O trecho de código do elemento não pôde ser capturado.',
    at: '2026-08-26T14:00:30.000Z', recoverable: true,
    details: { occurrenceId },
  }));
  const occurrenceScoped = authorityConsistentSample();
  for (const artifact of occurrenceScoped.evidence) {
    if (artifact.kind === 'element' && occurrenceIds.some(occurrenceId =>
      occurrenceScoped.occurrences.find(occurrence => occurrence.occurrenceId === occurrenceId)?.nodeId === artifact.nodeId)) {
      delete artifact.snippet;
    }
  }
  setSingleStatus(occurrenceScoped, 'partial', { diagnostics: occurrenceDiagnostics });
  assert.doesNotThrow(() => createAuditModel(occurrenceScoped));

  const duplicateOccurrenceDiagnostic = structuredClone(occurrenceScoped);
  duplicateOccurrenceDiagnostic.pages[0].diagnostics.push(
    structuredClone(duplicateOccurrenceDiagnostic.pages[0].diagnostics[0]),
  );
  duplicateOccurrenceDiagnostic.session.diagnostics.push(
    structuredClone(duplicateOccurrenceDiagnostic.session.diagnostics[0]),
  );
  assert.throws(
    () => createAuditModel(duplicateOccurrenceDiagnostic),
    /diagnóst|cardinal|duplicad|ocorrência|modelo/iu,
  );

  const crossPageOccurrenceDiagnostic = batchWithUnattemptedPage();
  crossPageOccurrenceDiagnostic.pages[1].diagnostics[0].details = {
    occurrenceId: crossPageOccurrenceDiagnostic.occurrences[0].occurrenceId,
  };
  crossPageOccurrenceDiagnostic.session.diagnostics = [
    ...crossPageOccurrenceDiagnostic.pages[0].diagnostics.map(value => structuredClone(value)),
    ...crossPageOccurrenceDiagnostic.pages[1].diagnostics.map(value => structuredClone(value)),
  ];
  assert.throws(
    () => createAuditModel(crossPageOccurrenceDiagnostic),
    /diagnóst|detalhe|ocorrência|página|modelo/iu,
  );
});

test('uses a closed modal union for root snapshot and per-page coverage', () => {
  const batchWithRootSnapshot = batchWithUnattemptedPage();
  batchWithRootSnapshot.pages[0].coverage = {};
  batchWithRootSnapshot.snapshot = {
    schemaVersion: 1, retention: 'summary-only', nodeCount: 1,
    coverage: { frames: 'complete' }, warnings: [],
  };
  assert.throws(() => createAuditModel(batchWithRootSnapshot), /snapshot|cobertura|coverage|lote|modo|modelo/iu);

  const singleWithPageCoverage = authorityConsistentSample();
  singleWithPageCoverage.pages[0].coverage = { frames: 'partial' };
  assert.throws(() => createAuditModel(singleWithPageCoverage), /snapshot|cobertura|coverage|single|modo|modelo/iu);

  const batchWithoutPageCoverage = batchWithUnattemptedPage();
  batchWithoutPageCoverage.pages[0].coverage = {};
  delete batchWithoutPageCoverage.pages[1].coverage;
  assert.throws(() => createAuditModel(batchWithoutPageCoverage), /snapshot|cobertura|coverage|lote|modo|modelo/iu);
});

test('rejects an unverifiable historical page count embedded in a batch rule summary', () => {
  const candidate = batchWithUnattemptedPage();
  const rule = candidate.ruleResults.find(value => value.source.engine === 'audita-core');
  rule.summary = `Resultado agregado de 2 de 2 páginas: ${rule.outcome}.`;
  assert.throws(() => createAuditModel(candidate), /resumo|agregado|contagem|regra|modelo/iu);
});

test('keeps page and diagnostic observation times inside their pertinent root window', () => {
  const pageBeforeRoot = authorityConsistentSample();
  pageBeforeRoot.pages[0].timestamps.startedAt = '2026-08-26T13:59:59.999Z';

  const pageAfterRoot = authorityConsistentSample();
  pageAfterRoot.pages[0].timestamps.generatedAt = '2026-08-26T14:02:02.000Z';

  const rootDiagnosticBeforeStart = authorityConsistentSample();
  rootDiagnosticBeforeStart.session.diagnostics[0].at = '2026-08-26T13:59:59.999Z';
  rootDiagnosticBeforeStart.pages[0].diagnostics[0].at = '2026-08-26T13:59:59.999Z';

  const pageDiagnosticAfterGeneration = authorityConsistentSample();
  pageDiagnosticAfterGeneration.pages[0].diagnostics = [{
    code: 'DYNAMIC_PROBES_INCOMPLETE', message: 'As verificações dinâmicas atingiram o tempo limite.',
    at: '2026-08-26T14:02:02.000Z', recoverable: true,
  }];
  pageDiagnosticAfterGeneration.session.diagnostics = structuredClone(pageDiagnosticAfterGeneration.pages[0].diagnostics);

  const pageDiagnosticAfterEnd = authorityConsistentSample();
  pageDiagnosticAfterEnd.pages[0].diagnostics = [{
    code: 'DYNAMIC_PROBES_INCOMPLETE', message: 'As verificações dinâmicas atingiram o tempo limite.',
    at: '2026-08-26T14:02:00.500Z', recoverable: true,
  }];
  pageDiagnosticAfterEnd.session.diagnostics = structuredClone(pageDiagnosticAfterEnd.pages[0].diagnostics);

  const fatalAfterEnd = authorityConsistentSample();
  const lateFatal = {
    code: 'CORE_AUDIT_FAILED', message: 'O núcleo de regras não pôde concluir a auditoria.',
    at: '2026-08-26T14:02:00.500Z', recoverable: false,
  };
  setSingleStatus(fatalAfterEnd, 'failed', { diagnostics: [lateFatal] });

  for (const candidate of [
    pageBeforeRoot, pageAfterRoot, rootDiagnosticBeforeStart, pageDiagnosticAfterGeneration,
    pageDiagnosticAfterEnd, fatalAfterEnd,
  ]) {
    assert.throws(() => createAuditModel(candidate), /janela|tempo|data|diagnóstico|página|modelo/iu);
  }

  const sessionArtifactAfterEnd = authorityConsistentSample();
  const generationDiagnostic = {
    code: 'REPORT_PDF_UNAVAILABLE', message: 'O PDF não foi gerado devido a uma limitação técnica local.',
    at: sessionArtifactAfterEnd.timestamps.generatedAt, recoverable: true,
  };
  sessionArtifactAfterEnd.session.diagnostics.push(generationDiagnostic);
  sessionArtifactAfterEnd.report = {
    status: 'partial', reviewUrl: null,
    artifact: {
      status: 'partial', pdfFallback: false,
      formats: [
        { format: 'html', status: 'prepared' },
        { format: 'csv', status: 'prepared' },
        { format: 'json', status: 'prepared' },
      ],
      limitations: [generationDiagnostic.message],
    },
  };
  syncDerivedClaims(sessionArtifactAfterEnd);
  assert.doesNotThrow(() => createAuditModel(sessionArtifactAfterEnd));
});

test('enforces observation chronology while preserving human decisions made after report generation', () => {
  for (const timestamps of [
    {
      startedAt: '2026-08-26T14:03:00.000Z',
      endedAt: '2026-08-26T14:02:00.000Z',
      generatedAt: '2026-08-26T14:04:00.000Z',
    },
    {
      startedAt: '2026-08-26T14:00:00.000Z',
      endedAt: '2026-08-26T14:02:00.000Z',
      generatedAt: '2026-08-26T14:01:00.000Z',
    },
  ]) {
    const reversed = authorityConsistentSample();
    reversed.timestamps = timestamps;
    reversed.pages[0].timestamps = structuredClone(timestamps);
    assert.throws(() => createAuditModel(reversed), /data|página|modelo|cronolog/iu);
  }

  const reversedPage = batchWithUnattemptedPage();
  reversedPage.pages[1].timestamps.generatedAt = '2026-08-26T14:00:44.000Z';
  assert.throws(() => createAuditModel(reversedPage), /data|página|modelo|cronolog/iu);

  const earlyDecision = createReviewDecision({
    auditId: SAMPLE_AUDIT.auditId, itemId: '5.1.4', occurrenceId: 'occ-focus-review',
    answer: 'conforme', evaluator: 'Fiscal de teste',
    decidedAt: '2026-08-26T14:01:59.000Z', mode: 'assisted',
  });
  assert.throws(
    () => createAuditModel(applyReviewDecisions(authorityConsistentSample(), [earlyDecision])),
    /data|revisão|decisão|modelo/iu,
  );

  const laterDecision = createReviewDecision({
    auditId: SAMPLE_AUDIT.auditId, itemId: '5.1.4', occurrenceId: 'occ-focus-review',
    answer: 'conforme', evaluator: 'Fiscal de teste',
    decidedAt: '2026-08-26T15:00:00.000Z', mode: 'assisted',
  });
  const reviewed = createAuditModel(applyReviewDecisions(authorityConsistentSample(), [laterDecision]));
  assert.equal(reviewed.reviewDecisions[0].decidedAt, '2026-08-26T15:00:00.000Z');
  assert.equal(reviewed.timestamps.generatedAt, '2026-08-26T14:02:01.000Z');
});

test('binds a single page status and the partial flag exactly to the session status', () => {
  for (const status of ['complete', 'partial', 'failed', 'cancelled']) {
    const canonical = status === 'failed'
      ? singleObservedTerminalWithoutResults(
        'failed', 'CORE_AUDIT_FAILED', 'O núcleo de regras não pôde concluir a auditoria.',
      )
      : authorityConsistentSample();
    if (status !== 'failed') {
      const diagnostics = status === 'complete' ? [] : status === 'partial'
        ? canonical.session.diagnostics
        : [{
          code: 'NAVIGATION_FAILED', message: 'A auditoria foi cancelada.',
          at: '2026-08-26T14:00:30.000Z', recoverable: false,
        }];
      setSingleStatus(canonical, status, { diagnostics });
    }
    assert.doesNotThrow(() => createAuditModel(canonical));

    const pageDrift = structuredClone(canonical);
    pageDrift.pages[0].status = status === 'complete' ? 'partial' : 'complete';
    assert.throws(() => createAuditModel(pageDrift), /status|página|sessão/iu);

    const partialDrift = structuredClone(canonical);
    partialDrift.session.partial = !partialDrift.session.partial;
    assert.throws(() => createAuditModel(partialDrift), /partial|status|sessão/iu);
  }
});

test('permits human review only for an originally cantTell occurrence', () => {
  const candidate = authorityConsistentSample();
  candidate.manualReview.push({
    occurrenceId: 'occ-focus-failed', itemId: '5.1.1', ruleId: 'focus-visible',
    mode: 'assisted', status: 'unanswered',
    question: 'A falha conclusiva deve ser reconsiderada?',
    reason: 'Fila forjada para uma ocorrência conclusiva.',
  });

  assert.throws(() => createAuditModel(candidate), /cantTell|inconclus|revis|fila|resultado/iu);
  assert.throws(() => applyReviewDecisions(candidate, [
    reviewDecision('occ-focus-failed', '5.1.1', 'conforme', 'assisted'),
  ]), /cantTell|inconclus|revis|fila|resultado/iu);
});

test('derives every ABNT item outcome from authoritative rules and occurrences even when axe is absent', async () => {
  for (const axe of [false, true]) {
    const candidate = authorityConsistentSample({ axe });
    candidate.itemResults.find(item => item.id === '5.1.2').outcome = 'failed';

    assert.throws(() => createAuditModel(candidate), /item|resultado|fonte|ocorrência|autoritativ/iu);
    assert.throws(() => renderTechnicalJson(candidate), /item|resultado|fonte|ocorrência|autoritativ/iu);
    assert.throws(() => renderHtmlReport(candidate), /item|resultado|fonte|ocorrência|autoritativ/iu);

    let optionReads = 0;
    const options = {};
    Object.defineProperty(options, 'now', {
      enumerable: true,
      get() { optionReads += 1; return ENRICH_OPTIONS.now; },
    });
    await assert.rejects(
      enrichAuditForReport(candidate, options),
      /item|resultado|fonte|ocorrência|autoritativ/iu,
    );
    assert.equal(optionReads, 0, 'V2 adulterado deve falhar antes de opções ou rehash');
  }
});

test('binds every reviewed item outcome and review summary to its exact validated decision graph', () => {
  const noDecision = authorityConsistentSample();
  const noDecisionItem = noDecision.itemResults.find(item => item.id === '5.1.4');
  noDecisionItem.originalOutcome = 'cantTell';
  noDecisionItem.reviewedOutcome = 'failed';
  noDecisionItem.outcome = 'failed';
  noDecisionItem.review = {
    mode: 'assisted', evaluator: 'Fiscal de teste', decidedAt: '2026-08-26T15:00:00.000Z',
    decisionIds: ['decision-inexistente'],
  };

  const reviewedPass = structuredClone(applyReviewDecisions(authorityConsistentSample(), [
    reviewDecision('occ-cross-page', '5.7.5', 'conforme', 'manual'),
  ]));
  const passItem = reviewedPass.itemResults.find(item => item.id === '5.7.5');

  const forgedPassSummary = structuredClone(reviewedPass);
  forgedPassSummary.itemResults.find(item => item.id === '5.7.5').review.evaluator = 'Avaliador inventado';

  const forgedCantTell = structuredClone(reviewedPass);
  forgedCantTell.itemResults.find(item => item.id === '5.7.5').outcome = 'cantTell';
  forgedCantTell.itemResults.find(item => item.id === '5.7.5').reviewedOutcome = 'cantTell';

  const forgedFailed = structuredClone(reviewedPass);
  forgedFailed.itemResults.find(item => item.id === '5.7.5').outcome = 'failed';
  forgedFailed.itemResults.find(item => item.id === '5.7.5').reviewedOutcome = 'failed';

  const reviewedFailure = structuredClone(applyReviewDecisions(authorityConsistentSample(), [
    reviewDecision('occ-cross-page', '5.7.5', 'não conforme', 'manual'),
  ]));
  const extraDecision = structuredClone(reviewedFailure);
  extraDecision.itemResults.find(item => item.id === '5.7.5').review.decisionIds.push('decision-extra');
  const staleDecision = structuredClone(reviewedFailure);
  staleDecision.itemResults.find(item => item.id === '5.7.5').review.decisionIds = ['decision-stale'];

  const reviewedWithoutGraph = authorityConsistentSample();
  reviewedWithoutGraph.itemResults.find(item => item.id === '5.1.4').reviewedOutcome = 'cantTell';

  assert.equal(passItem.outcome, 'passed', 'a referência de teste deve ser uma revisão legítima');
  for (const candidate of [
    noDecision,
    forgedPassSummary,
    forgedCantTell,
    forgedFailed,
    extraDecision,
    staleDecision,
    reviewedWithoutGraph,
  ]) {
    assert.throws(() => createAuditModel(candidate), /item|revisão|decisão|resultado|autoritativ/iu);
  }

  assert.throws(() => renderTechnicalJson(noDecision), /item|revisão|decisão|resultado|autoritativ/iu);
  assert.throws(() => renderHtmlReport(noDecision), /item|revisão|decisão|resultado|autoritativ/iu);
});

test('explicitly migrates V1 into the canonical single-page V2 contract without inventing source facts', () => {
  const input = reportInput();
  const original = structuredClone(input);
  const model = migrateAuditV1ToV2(input);
  const occurrence = model.occurrences[0];

  assert.deepEqual(input, original);
  assert.equal(model.schemaVersion, 2);
  assert.deepEqual(model.requestedScope, {
    mode: 'single', urls: ['https://example.test/path?view=public'],
  });
  assert.deepEqual(model.pages, [{
    pageId: 'page-1',
    requestedUrl: 'https://example.test/path?view=public',
    finalUrl: 'https://example.test/final?view=public',
      status: 'partial', attempted: true, finalUrlObserved: true,
      axeStatus: 'not-run',
    timestamps: model.timestamps,
    viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
    diagnostics: [{
      code: 'DYNAMIC_PROBES_INCOMPLETE',
      message: 'As verificações dinâmicas atingiram o tempo limite.',
      at: '2026-08-26T14:00:30.000Z', recoverable: true,
    }],
    warnings: [],
  }]);
  assert.equal(Array.isArray(model.evidence), true);
  assert.equal(model.evidence[0].pageId, 'page-1');
  assert.equal(occurrence.pageId, 'page-1');
  assert.equal(occurrence.classification, 'requirement');
  assert.equal(occurrence.impact, V1_MIGRATION_DEFAULTS.impact);
  assert.equal(occurrence.confidence, V1_MIGRATION_DEFAULTS.confidence);
  assert.deepEqual(occurrence.source, {
    engine: 'audita-core', ruleId: 'focus-order', version: '1.0.0',
  });
  assert.equal(occurrence.nbrItemRef, '5.1.4');
  assert.deepEqual(occurrence.itemWcagRefs, ['2.4.3']);
  assert.deepEqual(occurrence.sourceWcagRefs, ['2.4.3']);
  assert.deepEqual(occurrence.testedWcagRefs, []);
  assert.deepEqual(occurrence.wcagRefs, occurrence.testedWcagRefs);
  assert.deepEqual(occurrence.foreignBenchmarkRefs, []);
  assert.deepEqual(occurrence.target, { nodeId: 'n-1', selector: null, framePath: [] });
  assert.equal(occurrence.accessiblePreview, null);
  assert.deepEqual(occurrence.evidenceRefs, ['ev-1']);
  assert.equal(occurrence.legalAnalysis, null);
  assert.deepEqual(model.integrity, {
    algorithm: 'unavailable', status: 'not-recorded-v1',
  });
  assert.equal(model.normative.edition, 'ABNT NBR 17225:2025');
  assert.equal(model.normative.wcag, 'WCAG 2.2');
  assert.equal(model.normative.sources[0].localCopy.sha256, '1c3ee66b7fd606367e3de087e6a55fea90f4d368d8a1f769141d5e3b96d32afc');
  assert.equal(Object.isFrozen(model), true);
});

test('never carries a claimed V1 SHA-256 block into migration, technical JSON or enrichment', async () => {
  const input = reportInput();
  const claimedCanonical = 'a'.repeat(64);
  const claimedEvidence = 'b'.repeat(64);
  input.integrity = {
    algorithm: 'SHA-256', canonicalModelHash: claimedCanonical,
    evidenceManifestHash: claimedEvidence, hashBase: REPORT_HASH_BASE,
  };

  const migrated = migrateAuditV1ToV2(input);
  assert.deepEqual(migrated.integrity, { algorithm: 'unavailable', status: 'not-recorded-v1' });
  assert.doesNotMatch(renderTechnicalJson(migrated), new RegExp(`${claimedCanonical}|${claimedEvidence}`, 'u'));

  const enriched = await enrichAuditForReport(input, ENRICH_OPTIONS);
  assert.notEqual(enriched.integrity.canonicalModelHash, claimedCanonical);
  assert.notEqual(enriched.integrity.evidenceManifestHash, claimedEvidence);
  assert.doesNotMatch(renderTechnicalJson(enriched), new RegExp(`${claimedCanonical}|${claimedEvidence}`, 'u'));

  const expectedManifestHash = await sha256Hex(canonicalStringify(projectEvidenceManifest(enriched.evidence)));
  assert.equal(enriched.integrity.evidenceManifestHash, expectedManifestHash);
  const hashInput = structuredClone(enriched);
  delete hashInput.integrity.canonicalModelHash;
  assert.equal(enriched.integrity.canonicalModelHash, await sha256Hex(canonicalStringify(hashInput)));
});

test('drops every claimed V1 reproducibility hash from migration and report consumers', () => {
  const input = reportInput();
  const claimedSnapshot = 'a'.repeat(64);
  const claimedRules = 'b'.repeat(64);
  const claimedEvidence = 'c'.repeat(64);
  input.reproducibility = {
    methodologyVersion: '1.0.0', snapshotHash: claimedSnapshot,
    ruleResultsHash: claimedRules, evidenceHash: claimedEvidence, capturedStateCount: 1,
  };

  const migrated = migrateAuditV1ToV2(input);

  assert.deepEqual(migrated.reproducibility, {
    methodologyVersion: '1.0.0',
    snapshotHash: 'not-recorded-v1',
    ruleResultsHash: 'not-recorded-v1',
    evidenceHash: 'not-recorded-v1',
    capturedStateCount: 1,
  });
  for (const claim of [claimedSnapshot, claimedRules, claimedEvidence]) {
    const marker = new RegExp(claim, 'u');
    assert.doesNotMatch(renderTechnicalJson(migrated), marker);
    assert.doesNotMatch(renderHtmlReport(migrated), marker);
  }
});

test('drops historical V1 review queues for conclusive occurrences and retains only legitimate cantTell work', () => {
  const input = reportInput();
  const legitimateDecision = {
    ...createReviewDecision({
      auditId: input.auditId, itemId: '5.1.4', occurrenceId: 'occ-1',
      answer: 'conforme', evaluator: 'Fiscal atual', mode: 'assisted',
      decidedAt: '2026-08-26T14:01:20.000Z',
    }),
    decisionId: 'decision-deadbeef',
  };
  input.manualReview[0].status = 'answered';
  input.manualReview[0].decisionId = legitimateDecision.decisionId;
  const legitimateItem = input.itemResults.find(item => item.id === '5.1.4');
  legitimateItem.originalOutcome = 'cantTell';
  legitimateItem.reviewedOutcome = 'passed';
  legitimateItem.outcome = 'passed';
  legitimateItem.review = {
    mode: 'assisted', evaluator: legitimateDecision.evaluator,
    decidedAt: legitimateDecision.decidedAt, decisionIds: [legitimateDecision.decisionId],
  };
  const rule = input.ruleResults.find(value => value.ruleId === 'focus-visible');
  rule.outcome = 'failed';
  rule.targets = ['n-1'];
  const reviewedItem = input.itemResults.find(item => item.id === '5.1.1');
  reviewedItem.outcome = 'failed';
  input.occurrences.push({
    occurrenceId: 'occ-conclusive', itemId: '5.1.1', ruleId: 'focus-visible',
    outcome: 'failed', mode: 'automated', nodeId: 'n-1', evidenceIds: ['ev-1'],
    justification: 'Falha conclusiva registrada pela regra autoritativa.',
    source: { engine: 'audita-core', ruleId: 'focus-visible', version: '1.0.0' },
    itemWcagRefs: ['2.4.7'], sourceWcagRefs: ['2.4.7'],
    testedWcagRefs: ['2.4.7'], wcagRefs: ['2.4.7'],
  });
  const historicalDecision = createReviewDecision({
    auditId: input.auditId, itemId: '5.1.1', occurrenceId: 'occ-conclusive',
    answer: 'não conforme', evaluator: 'Fiscal histórico', mode: 'assisted',
    decidedAt: '2026-08-26T14:01:30.000Z',
  });
  input.manualReview.push({
    occurrenceId: 'occ-conclusive', itemId: '5.1.1', ruleId: 'focus-visible',
    mode: 'assisted', status: 'answered', decisionId: historicalDecision.decisionId,
    question: 'A falha conclusiva deve ser revista?',
    reason: 'Fila histórica incompatível com o resultado conclusivo.',
  });
  input.reviewDecisions.push(legitimateDecision, historicalDecision);
  reviewedItem.originalOutcome = 'failed';
  reviewedItem.reviewedOutcome = 'failed';
  reviewedItem.review = {
    mode: 'assisted', evaluator: historicalDecision.evaluator,
    decidedAt: historicalDecision.decidedAt, decisionIds: [historicalDecision.decisionId],
  };

  const migrated = migrateAuditV1ToV2(input);

  assert.deepEqual(migrated.manualReview.map(entry => entry.occurrenceId), ['occ-1']);
  assert.deepEqual(migrated.reviewDecisions.map(decision => decision.decisionId), ['occ-1']);
  assert.equal(migrated.manualReview[0].decisionId, 'occ-1');
  assert.deepEqual(migrated.itemResults.find(item => item.id === '5.1.4').review.decisionIds, ['occ-1']);
  assert.doesNotMatch(JSON.stringify(migrated), /decision-deadbeef/u);
  assert.equal(migrated.itemResults.find(item => item.id === '5.1.4').outcome, 'passed');
  assert.equal(migrated.itemResults.find(item => item.id === '5.1.1').outcome, 'failed');
  assert.equal(Object.hasOwn(migrated.itemResults.find(item => item.id === '5.1.1'), 'review'), false);
  assert.ok(migrated.manualReview.every(entry =>
    migrated.occurrences.find(occurrence => occurrence.occurrenceId === entry.occurrenceId)?.outcome === 'cantTell'));
});

test('consumes legitimate V1 selector aliases into the closed canonical target', () => {
  const input = reportInput();
  input.occurrences[0].selector = '#legacy-control';
  input.occurrences[0].framePath = ['frame:0'];

  const model = migrateAuditV1ToV2(input);
  const occurrence = model.occurrences[0];

  assert.deepEqual(occurrence.target, {
    nodeId: occurrence.nodeId,
    selector: null,
    framePath: [],
  });
  assert.equal(Object.hasOwn(occurrence, 'selector'), false);
  assert.equal(Object.hasOwn(occurrence, 'framePath'), false);
});

test('projects V1 evidence onto the closed canonical URL-bearing schema', () => {
  const input = reportInput();
  const safeDataUrl = 'data:image/png;base64,iVBORw0KGgo=';
  const elementIndex = input.evidence.artifacts.findIndex(artifact => artifact.evidenceId === 'ev-1');
  input.evidence.artifacts[elementIndex] = {
    ...input.evidence.artifacts[elementIndex],
    mediaUrl: 'https://cdn.example.test/video.mp4?token=TOPSECRET&view=public',
    resourceUrl: 'https://cdn.example.test/resource?api_key=TOPSECRET&lang=pt-BR',
    dataUrl: safeDataUrl,
    media: {
      currentSrc: 'https://images.example.test/poster.png?session=TOPSECRET&size=large',
    },
  };

  const model = migrateAuditV1ToV2(input);
  const artifact = model.evidence.find(value => value.evidenceId === 'ev-1');
  assert.equal(artifact.mediaUrl, 'https://cdn.example.test/video.mp4?view=public');
  assert.equal(artifact.dataUrl, safeDataUrl);
  assert.equal(Object.hasOwn(artifact, 'resourceUrl'), false);
  assert.equal(Object.hasOwn(artifact, 'media'), false);
  assert.doesNotMatch(renderTechnicalJson(model), /TOPSECRET|token=|api_key=|session=/u);
});

test('rejects an unregistered V1 supplemental rule instead of inventing trustworthy provenance', () => {
  const input = reportInput();
  input.itemResults.find(item => item.id === '5.1.2').outcome = 'passed';
  input.ruleResults.push({
    ruleId: 'supplemental.legacy-pass', outcome: 'passed', mode: 'automated',
    nbrItems: ['5.1.2'], targets: [], summary: 'Aprovação V1 suplementar.', limitations: [],
  });
  input.occurrences.push({
    occurrenceId: 'occ-legacy-supplemental-pass', itemId: '5.1.2',
    ruleId: 'supplemental.legacy-pass', outcome: 'passed', mode: 'automated',
    nodeId: null, evidenceIds: [], justification: 'Aprovação V1 suplementar.',
  });

  assert.throws(
    () => migrateAuditV1ToV2(input),
    /proveniência|fonte|registro|suplementar|aprova/iu,
  );
});

test('createAuditModel is the explicit V1 migration boundary and accepts native multipage V2', () => {
  const migrated = createAuditModel(reportInput());
  assert.equal(migrated.schemaVersion, 2);

  const batch = structuredClone(migrated);
  batch.requestedScope = {
    mode: 'batch',
    urls: [...batch.requestedScope.urls, 'https://second.example.test/'],
  };
  batch.scope = canonicalScope('batch', 2);
  batch.pages[0].coverage = {};
  const failedPage = {
    pageId: 'page-2',
    requestedUrl: 'https://second.example.test/',
    finalUrl: 'https://second.example.test/',
    status: 'failed', attempted: true, finalUrlObserved: false,
    axeStatus: 'not-run',
    timestamps: {
      startedAt: '2026-08-26T14:01:00.000Z',
      endedAt: '2026-08-26T14:01:00.000Z',
      generatedAt: '2026-08-26T14:01:01.000Z',
    },
    viewport: { width: null, height: null, deviceScaleFactor: null },
    coverage: {},
    warnings: [],
    diagnostics: [{
      code: 'BATCH_PAGE_FAILED', message: 'A página não pôde ser auditada.',
      at: '2026-08-26T14:01:00.000Z', recoverable: false,
    }],
  };
  batch.pages.push(failedPage);
  batch.session.diagnostics.push(structuredClone(failedPage.diagnostics[0]));
  for (const rule of batch.ruleResults) {
    if (rule.source?.engine === 'audita-core') {
      rule.summary = canonicalBatchRuleSummary(rule.outcome, 1, 2);
    }
  }
  syncDerivedClaims(batch);

  const model = createAuditModel(batch);
  assert.equal(model.requestedScope.mode, 'batch');
  assert.deepEqual(model.pages.map(page => page.pageId), ['page-1', 'page-2']);
  assert.throws(() => createAuditModel({ ...batch, session: { ...batch.session, status: 'complete' } }), /status|páginas|sessão/iu);
  assert.throws(() => createAuditModel({
    ...batch,
    pages: batch.pages.map(page => ({ ...page, pageId: 'page-1' })),
  }), /pageId|página|duplicad/i);
  assert.throws(() => createAuditModel({
    ...batch,
    pages: batch.pages.map((page, index) => index === 1
      ? { ...page, requestedUrl: 'https://unrequested.example.test/' }
      : page),
  }), /requestedScope|escopo|solicitad|URL/i);
});

test('rejects non-string occurrence justification and evidence hashes without coercing hostile values', () => {
  const unsafeValues = [null, 42, true, [], { nested: 'PRIVATE_SENTINEL' }];
  for (const value of unsafeValues) {
    const occurrenceInput = structuredClone(SAMPLE_AUDIT);
    occurrenceInput.occurrences[0].justification = value;
    assert.throws(() => createAuditModel(occurrenceInput), /justification|justificativa|texto|schema|inválid/iu);

    const evidenceInput = structuredClone(SAMPLE_AUDIT);
    evidenceInput.evidence[0].hash = value;
    assert.throws(() => createAuditModel(evidenceInput), /evidência|evidence|hash|texto|schema|inválid/iu);
  }

  let accessed = false;
  const hostile = {};
  Object.defineProperty(hostile, 'toString', {
    enumerable: true,
    get() { accessed = true; throw new Error('PRIVATE_SENTINEL'); },
  });
  const hostileOccurrence = structuredClone(SAMPLE_AUDIT);
  hostileOccurrence.occurrences[0].justification = hostile;
  assert.throws(() => createAuditModel(hostileOccurrence), /propriedade|segura|justification|valor|schema/iu);
  assert.equal(accessed, false);

  const hostileEvidence = structuredClone(SAMPLE_AUDIT);
  Object.defineProperty(hostileEvidence.evidence[0], 'hash', {
    enumerable: true,
    get() { accessed = true; throw new Error('PRIVATE_SENTINEL'); },
  });
  assert.throws(() => createAuditModel(hostileEvidence), /propriedade|segura|hash|valor|schema/iu);
  assert.equal(accessed, false);
});

test('conclusive failed requirements and recommendations use the same catalog reference without changing classification', () => {
  const model = structuredClone(createAuditModel(reportInput()));
  const requirement = NBR17225_ITEMS.find(item => item.id === '5.1.1');
  const recommendation = NBR17225_ITEMS.find(item => item.id === '5.1.2');
  const makeRule = (item, ruleId, nodeId) => ({
    ruleId, outcome: 'failed', mode: item.evaluation, nbrItems: [item.id],
    wcag: item.wcag.map(reference => reference.id),
    targets: [nodeId], summary: canonicalCoreRuleSummary(ruleId, 'failed'), limitations: [],
    source: { engine: 'audita-core', ruleId, version: '1.0.0' },
  });
  const makeOccurrence = (item, ruleId, occurrenceId, nodeId, outcome = 'failed') => {
    const sourceWcagRefs = item.wcag.map(reference => reference.id);
    const testedWcagRefs = outcome === 'failed' ? [...sourceWcagRefs] : [];
    return ({
    occurrenceId, pageId: 'page-1', outcome, classification: item.classification,
    impact: 'moderate', confidence: 'high',
    source: { engine: 'audita-core', ruleId, version: '1.0.0' },
    nbrItemRef: item.id, itemWcagRefs: [...sourceWcagRefs], sourceWcagRefs, testedWcagRefs,
    wcagRefs: [...testedWcagRefs],
    foreignBenchmarkRefs: [...section508ReferencesForWcag(testedWcagRefs)], target: { nodeId, selector: null, framePath: [] },
    accessiblePreview: null, evidenceRefs: [],
    legalAnalysis: outcome === 'failed'
      ? { basisRef: CONSUMER_ACCESSIBILITY_FIXED_BASIS.id }
      : null,
    itemId: item.id, ruleId, mode: item.evaluation, nodeId,
    evidenceIds: [], justification: canonicalCoreRuleSummary(ruleId, outcome),
  });
  };
  model.ruleResults = model.ruleResults.filter(rule =>
    !['focus-visible', 'focus-fully-visible'].includes(rule.ruleId));
  const requirementItem = model.itemResults.find(item => item.id === requirement.id);
  requirementItem.outcome = 'failed';
  requirementItem.ruleResults = ['focus-visible'];
  const recommendationItem = model.itemResults.find(item => item.id === recommendation.id);
  recommendationItem.outcome = 'failed';
  recommendationItem.ruleResults = ['focus-fully-visible'];
  model.ruleResults.push(makeRule(requirement, 'focus-visible', 'n-requirement'));
  model.ruleResults.push(makeRule(recommendation, 'focus-fully-visible', 'n-recommendation'));
  model.occurrences.push(makeOccurrence(requirement, 'focus-visible', 'occ-requirement', 'n-requirement'));
  model.occurrences.push(makeOccurrence(recommendation, 'focus-fully-visible', 'occ-recommendation', 'n-recommendation'));

  const canonical = createAuditModel(model);
  const [requirementFailure, recommendationFailure] =
    ['occ-requirement', 'occ-recommendation']
      .map(id => canonical.occurrences.find(occurrence => occurrence.occurrenceId === id));
  const inconclusive = canonical.occurrences.find(occurrence => occurrence.outcome === 'cantTell');
  assert.equal(requirementFailure.legalAnalysis.basisRef, CONSUMER_ACCESSIBILITY_FIXED_BASIS.id);
  assert.equal(recommendationFailure.legalAnalysis.basisRef, CONSUMER_ACCESSIBILITY_FIXED_BASIS.id);
  assert.equal(requirementFailure.classification, 'requirement');
  assert.equal(recommendationFailure.classification, 'recommendation');
  assert.equal(inconclusive.legalAnalysis, null);
  assert.doesNotMatch(JSON.stringify(canonical.occurrences), /violatedLaw|illegal|liability|sanction/iu);
});

test('allows supplemental and editorial rules without weakening the exact 130-core and 146-item contracts', () => {
  const model = structuredClone(createAuditModel(reportInput()));
  model.methodology = {
    ...model.methodology,
    coreRuleCount: 130,
    supplementalRuleCount: 1,
    ruleCount: 131,
  };
  model.ruleResults.push({
    ruleId: 'editorial.placeholder-text', outcome: 'failed', mode: 'automated',
    classification: 'editorial', impact: 'minor', confidence: 'high',
    source: { engine: 'audita-editorial', ruleId: 'editorial.placeholder-text', version: '1.0.0' },
    nbrItems: [], wcag: [], targets: [{
      nodeId: 'n-1', selectorHint: '',
      message: 'Substitua o conteúdo provisório antes da publicação.',
      data: { reason: 'placeholder-text' },
    }],
    summary: 'Há conteúdo provisório inequívoco na página.', limitations: [],
  });
  model.occurrences.push({
    occurrenceId: 'occ-editorial', pageId: 'page-1', outcome: 'failed',
    classification: 'editorial', impact: 'minor', confidence: 'high',
    source: { engine: 'audita-editorial', ruleId: 'editorial.placeholder-text', version: '1.0.0' },
    nbrItemRef: null, itemWcagRefs: [], sourceWcagRefs: [], testedWcagRefs: [], wcagRefs: [], foreignBenchmarkRefs: [],
    target: { nodeId: 'n-1', selector: null, framePath: [] },
    accessiblePreview: null, evidenceRefs: [], legalAnalysis: null,
    itemId: null, ruleId: 'editorial.placeholder-text', mode: 'automated', nodeId: 'n-1',
    evidenceIds: [], justification: 'Há conteúdo provisório inequívoco na página.',
  });

  const canonical = createAuditModel(model);
  assert.equal(canonical.itemResults.length, 146);
  assert.equal(canonical.methodology.coreRuleCount, 130);
  assert.equal(canonical.ruleResults.at(-1).nbrItems.length, 0);
  assert.equal(canonical.occurrences.at(-1).legalAnalysis, null);

  for (const field of ['supplementalRuleCount', 'ruleCount']) {
    const forgedCount = structuredClone(canonical);
    forgedCount.methodology[field] += 1;
    assert.throws(() => createAuditModel(forgedCount), /contagem|inventário|metodologia|regra/iu);
  }

  model.methodology.coreRuleCount = 129;
  assert.throws(() => createAuditModel(model), /130|core|regra/i);
});

test('strictly validates editorial and informational inventory schemas without accepting private extension fields', () => {
  const base = structuredClone(createAuditModel(reportInput()));
  assert.deepEqual(base.accessibilityWidgets, {
    detector: 'audita.accessibility-widgets', version: '1.0.0', coverage: 'unavailable',
    widgets: [
      { id: 'vlibras', status: 'unknown', signals: [] },
      { id: 'hand-talk', status: 'unknown', signals: [] },
    ],
  });

  for (const mutate of [
    value => { value.accessibilityWidgets.privateText = 'PRIVATE-INVENTORY'; },
    value => { value.accessibilityWidgets.widgets[0].selector = '#PRIVATE-WIDGET'; },
    value => { value.accessibilityWidgets.widgets.reverse(); },
    value => { value.accessibilityWidgets.widgets[0].status = 'absent'; },
    value => { value.accessibilityWidgets.widgets[0].signals = ['script-src']; },
  ]) {
    const forged = structuredClone(base);
    mutate(forged);
    assert.throws(() => createAuditModel(forged), /widget|invent|schema|sinal|status|ordem|campo|inválid/i);
  }

  const editorialBase = structuredClone(base);
  editorialBase.methodology.supplementalRuleCount += 1;
  editorialBase.methodology.ruleCount += 1;
  editorialBase.ruleResults.push({
    ruleId: 'editorial.placeholder-text', outcome: 'failed', mode: 'automated',
    classification: 'editorial', impact: 'minor', confidence: 'high',
    source: { engine: 'audita-editorial', ruleId: 'editorial.placeholder-text', version: '1.0.0' },
    nbrItems: [], wcag: [], targets: [{
      nodeId: 'n-1', selectorHint: '', message: 'Substitua o conteúdo provisório antes da publicação.',
      data: { reason: 'placeholder-text' },
    }],
    summary: 'Há conteúdo provisório inequívoco na página.', limitations: [],
  });
  editorialBase.occurrences.push({
    occurrenceId: 'occ-editorial-strict', pageId: 'page-1', outcome: 'failed',
    classification: 'editorial', impact: 'minor', confidence: 'high',
    source: { engine: 'audita-editorial', ruleId: 'editorial.placeholder-text', version: '1.0.0' },
    nbrItemRef: null, itemWcagRefs: [], sourceWcagRefs: [], testedWcagRefs: [], wcagRefs: [], foreignBenchmarkRefs: [],
    target: { nodeId: 'n-1', selector: null, framePath: [] }, accessiblePreview: null,
    evidenceRefs: [], legalAnalysis: null, itemId: null, ruleId: 'editorial.placeholder-text',
    mode: 'automated', nodeId: 'n-1', evidenceIds: [],
    justification: 'Há conteúdo provisório inequívoco na página.',
  });
  editorialBase.ruleResults.at(-1).limitations = [{
    code: 'EDITORIAL_NODE_SCAN_TRUNCATED', retainedNodeCount: 5_000,
  }];
  assert.doesNotThrow(() => createAuditModel(editorialBase));
  for (const mutate of [
    value => { value.ruleResults.at(-1).privateText = 'PRIVATE-RESULT'; },
    value => { value.ruleResults.at(-1).source.version = '9.9.9'; },
    value => { value.ruleResults.at(-1).nbrItems = ['5.1.1']; },
    value => { value.occurrences.at(-1).privateText = 'PRIVATE-OCCURRENCE'; },
    value => { value.occurrences.at(-1).target.selector = '#PRIVATE-AUTHOR-ID'; },
    value => { value.occurrences.at(-1).evidenceRefs = ['ev-1']; value.occurrences.at(-1).evidenceIds = ['ev-1']; },
    value => { value.occurrences.at(-1).accessiblePreview = 'PRIVATE-PREVIEW'; },
    value => { value.ruleResults.at(-1).limitations[0].retainedNodeCount = 4_999; },
    value => { value.ruleResults.at(-1).limitations[0].privateText = 'PRIVATE-LIMIT'; },
  ]) {
    const forged = structuredClone(editorialBase);
    mutate(forged);
    assert.throws(() => createAuditModel(forged), /editorial|privad|schema|fonte|versão|evidência|seletor|item|preview|campo|inválid/i);
  }
});

test('rejects a supplemental passed rule and occurrence that try to auto-approve an ABNT item', () => {
  const model = structuredClone(createAuditModel(reportInput()));
  const item = NBR17225_ITEMS.find(entry => entry.id === '5.1.2');
  model.methodology = {
    ...model.methodology,
    supplementalRuleCount: model.methodology.supplementalRuleCount + 1,
    ruleCount: model.methodology.ruleCount + 1,
  };
  model.itemResults.find(entry => entry.id === item.id).outcome = 'passed';
  model.ruleResults.push({
    ruleId: 'supplemental.fabricated-pass', outcome: 'passed', mode: 'automated',
    nbrItems: [item.id], targets: [], summary: 'Aprovação suplementar.', limitations: [],
  });
  model.occurrences.push({
    occurrenceId: 'occ-supplemental-pass', pageId: 'page-1', outcome: 'passed',
    classification: item.classification, impact: 'minor', confidence: 'high',
    source: { engine: 'third-party-engine', ruleId: 'supplemental.fabricated-pass', version: '9.9.9' },
    nbrItemRef: item.id, itemWcagRefs: item.wcag.map(reference => reference.id),
    sourceWcagRefs: item.wcag.map(reference => reference.id), testedWcagRefs: [], wcagRefs: [],
    foreignBenchmarkRefs: [], target: { nodeId: null, selector: null, framePath: [] },
    accessiblePreview: null, evidenceRefs: [], legalAnalysis: null,
    itemId: item.id, ruleId: 'supplemental.fabricated-pass', mode: 'automated',
    nodeId: null, evidenceIds: [], justification: 'Aprovação suplementar.',
  });

  assert.throws(() => createAuditModel(model), /passad|aprova|autorit|ABNT|suplementar/i);
});

test('rejects a third-party engine that claims an authoritative rule ID to approve ABNT', () => {
  const ruleClaim = structuredClone(createAuditModel(reportInput()));
  const rule = ruleClaim.ruleResults.find(entry => entry.ruleId === 'focus-visible');
  rule.source = { engine: 'third-party-engine', ruleId: rule.ruleId, version: ruleClaim.versions.rules };
  assert.throws(() => createAuditModel(ruleClaim), /audita-core|proveniência|fonte|aprova|autorit/i);

  const occurrenceClaim = structuredClone(createAuditModel(reportInput()));
  const item = NBR17225_ITEMS.find(entry => entry.id === '5.1.1');
  occurrenceClaim.occurrences.push({
    occurrenceId: 'occ-third-party-pass', pageId: 'page-1', outcome: 'passed',
    classification: item.classification, impact: 'minor', confidence: 'high',
    source: { engine: 'third-party-engine', ruleId: 'focus-visible', version: occurrenceClaim.versions.rules },
    nbrItemRef: item.id, itemWcagRefs: item.wcag.map(reference => reference.id),
    sourceWcagRefs: item.wcag.map(reference => reference.id), testedWcagRefs: [], wcagRefs: [],
    foreignBenchmarkRefs: [], target: { nodeId: null, selector: null, framePath: [] },
    accessiblePreview: null, evidenceRefs: [], legalAnalysis: null,
    itemId: item.id, ruleId: 'focus-visible', mode: 'automated', nodeId: null,
    evidenceIds: [], justification: 'Aprovação de fonte externa.',
  });
  assert.throws(() => createAuditModel(occurrenceClaim), /audita-core|proveniência|fonte|aprova|autorit/i);
});

test('rejects an authoritative passed rule whose source version differs from the model rules version', () => {
  const model = structuredClone(createAuditModel(reportInput()));
  const rule = model.ruleResults.find(entry => entry.ruleId === 'focus-visible');
  rule.source = { engine: 'audita-core', ruleId: rule.ruleId, version: '9.9.9' };

  assert.throws(() => createAuditModel(model), /versão|version|proveniência|fonte|aprova|autorit/i);
});

test('rejects incoherent core provenance for every outcome instead of relabeling it downstream', () => {
  for (const [engine, version] of [
    ['third-party-engine', '1.0.0'],
    ['audita-core', '9.9.9'],
  ]) {
    const model = structuredClone(SAMPLE_AUDIT);
    const rule = model.ruleResults.find(entry => entry.ruleId === 'focus-visible');
    const occurrence = model.occurrences.find(entry => entry.source.ruleId === 'focus-visible');
    rule.source = { engine, ruleId: 'focus-visible', version };
    occurrence.source = { engine, ruleId: 'focus-visible', version };

    assert.throws(
      () => createAuditModel(model),
      /audita-core|proveniência|fonte|engine|versão|version|registro/i,
    );
  }

  const coherent = structuredClone(SAMPLE_AUDIT);
  coherent.ruleResults.find(entry => entry.ruleId === 'focus-visible').source = {
    engine: 'audita-core', ruleId: 'focus-visible', version: coherent.versions.rules,
  };
  assert.deepEqual(createAuditModel(coherent).occurrences[0].source, {
    engine: 'audita-core', ruleId: 'focus-visible', version: '1.0.0',
  });
});

test('rejects a globally coherent forged methodology version outside the local provenance registry', () => {
  const forged = structuredClone(SAMPLE_AUDIT);
  forged.versions.rules = '9.9.9';
  forged.methodology.version = '9.9.9';
  forged.reproducibility.methodologyVersion = '9.9.9';
  for (const rule of forged.ruleResults) {
    if (rule.source.engine !== 'axe-core') rule.source.version = '9.9.9';
  }
  for (const occurrence of forged.occurrences) {
    if (occurrence.source.engine !== 'axe-core') occurrence.source.version = '9.9.9';
  }

  assert.throws(
    () => createAuditModel(forged),
    /proveniência|registro|versão|version|metodologia/iu,
  );
});

test('rejects a forged global rules version even when no source-bearing result remains', () => {
  const forged = structuredClone(SAMPLE_AUDIT);
  forged.versions.rules = '9.9.9';
  forged.methodology.version = '9.9.9';
  forged.reproducibility.methodologyVersion = '9.9.9';
  forged.ruleResults = [];
  forged.occurrences = [];
  forged.manualReview = [];
  forged.reviewDecisions = [];
  forged.itemResults.find(item => item.id === '5.1.2').outcome = 'cantTell';

  assert.throws(
    () => createAuditModel(forged),
    /versão|version|proveniência|registro|metodologia/iu,
  );
});

test('requires each legacy occurrence identity to agree with its registered core or manual source', () => {
  const coreIdentityDrift = structuredClone(SAMPLE_AUDIT);
  coreIdentityDrift.occurrences[0].ruleId = null;
  assert.throws(
    () => createAuditModel(coreIdentityDrift),
    /regra|rule|proveniência|fonte|incoerente/iu,
  );

  const manualVersionDrift = structuredClone(SAMPLE_AUDIT);
  manualVersionDrift.occurrences.find(entry => entry.ruleId === null).source.version = '9.9.9';
  assert.throws(
    () => createAuditModel(manualVersionDrift),
    /manual|proveniência|fonte|versão|version|registro/iu,
  );
});

test('rejects an unknown decision ID used to justify a reviewed ABNT pass', () => {
  const model = structuredClone(applyReviewDecisions(SAMPLE_AUDIT, [
    reviewDecision('occ-cross-page', '5.7.5', 'conforme', 'manual'),
  ]));
  model.itemResults.find(item => item.id === '5.7.5').review.decisionIds = ['decision-unknown'];

  assert.throws(() => createAuditModel(model), /decisão|decision|revisão|aprova|autorit/i);
});

test('rejects reviewed ABNT passes backed by another item or a nonconformity decision', () => {
  const otherItem = structuredClone(applyReviewDecisions(SAMPLE_AUDIT, [
    reviewDecision('occ-focus-review', '5.1.4', 'conforme', 'assisted'),
  ]));
  const borrowedDecisionId = otherItem.reviewDecisions[0].decisionId;
  const borrowedPass = otherItem.itemResults.find(item => item.id === '5.7.5');
  borrowedPass.outcome = 'passed';
  borrowedPass.reviewedOutcome = 'passed';
  borrowedPass.review = { mode: 'manual', evaluator: 'Fiscal de teste', decidedAt: '2026-08-26T15:00:00.000Z', decisionIds: [borrowedDecisionId] };
  assert.throws(() => createAuditModel(otherItem), /decisão|decision|item|revisão|aprova|autorit/i);

  const nonconformity = structuredClone(applyReviewDecisions(SAMPLE_AUDIT, [
    reviewDecision('occ-cross-page', '5.7.5', 'não conforme', 'manual'),
  ]));
  const forgedPass = nonconformity.itemResults.find(item => item.id === '5.7.5');
  forgedPass.outcome = 'passed';
  forgedPass.reviewedOutcome = 'passed';
  assert.throws(() => createAuditModel(nonconformity), /decisão|decision|conforme|revisão|aprova|autorit/i);
});

test('rejects derived evidence whose full-page capture belongs to another page', () => {
  const model = structuredClone(createAuditModel(reportInput()));
  model.requestedScope = {
    mode: 'batch',
    urls: [...model.requestedScope.urls, 'https://second.example.test/'],
  };
  model.pages.push({
    pageId: 'page-2', requestedUrl: 'https://second.example.test/',
    finalUrl: 'https://second.example.test/final', status: 'complete',
    timestamps: {
      startedAt: '2026-08-26T14:02:00.000Z', endedAt: '2026-08-26T14:02:01.000Z',
      generatedAt: '2026-08-26T14:02:02.000Z',
    },
    viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
  });
  model.evidence.push({ evidenceId: 'ev-page-1-full', pageId: 'page-1', kind: 'full-page' });
  model.evidence.push({
    evidenceId: 'ev-page-2-element', pageId: 'page-2', kind: 'element',
    fullPageEvidenceId: 'ev-page-1-full',
  });

  assert.throws(() => createAuditModel(model), /captura integral|evidência|outra página/i);
});

test('requires every canonical alias and integrity field on native V2', () => {
  const model = structuredClone(createAuditModel(reportInput()));
  const occurrence = model.occurrences[0];
  for (const key of ['itemId', 'ruleId', 'mode', 'nodeId', 'evidenceIds']) delete occurrence[key];

  assert.throws(() => createAuditModel(model), /modelo|ocorrência|esquema/iu);

  delete model.integrity;
  assert.throws(() => createAuditModel(model), /integrity|integridade/i);
});
