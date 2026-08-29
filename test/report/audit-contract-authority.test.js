import assert from 'node:assert/strict';
import test from 'node:test';

import { SAMPLE_AUDIT } from '../../fixtures/audits/sample-audit.js';
import { createAuditModel } from '../../src/core/report/audit-model.js';
import { enrichAuditForReport } from '../../src/core/report/enrich-audit.js';
import { renderTechnicalJson } from '../../src/core/report/earl-json.js';
import { renderHtmlReport } from '../../src/core/report/html.js';
import { createExportIssue } from '../../src/export/export-issues.js';
import { finalizeGeneratedModel } from '../../src/export/report-export.js';
import {
  canonicalBatchRuleSummary,
  canonicalScope,
} from '../../src/core/report/text-policy.js';

const PRIVATE_MARKER = 'PRIVATE_AUTHORITY_MARKER_7Q9Z';
const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';
const STRUCTURAL_LIMITATION = 'A cobertura estrutural contém avisos ou frames que não puderam ser observados integralmente.';
const VIEWPORT_LIMITATION = 'Não foi possível registrar o viewport; dimensões e escala permanecem não disponíveis, sem valores estimados.';

function clone(value) {
  return structuredClone(value);
}

function replacePageDiagnostics(model, diagnostics) {
  model.pages[0].diagnostics = clone(diagnostics);
  model.session.diagnostics = clone(diagnostics);
  return model;
}

function diagnostic(code, message, overrides = {}) {
  return {
    code,
    message,
    at: '2026-08-26T14:00:30.000Z',
    recoverable: true,
    ...overrides,
  };
}

function appendPageDiagnostic(model, entry, pageIndex = 0) {
  model.pages[pageIndex].diagnostics = [...(model.pages[pageIndex].diagnostics ?? []), clone(entry)];
  model.session.diagnostics = [...model.session.diagnostics, clone(entry)];
  return model;
}

function twoPageBatch() {
  const model = clone(SAMPLE_AUDIT);
  const secondUrl = 'https://segunda.example.test/';
  model.requestedScope = { mode: 'batch', urls: [model.requestedUrl, secondUrl] };
  model.scope = canonicalScope('batch', 2);
  model.timestamps = {
    startedAt: '2026-08-26T14:00:00.000Z',
    endedAt: '2026-08-26T14:02:00.000Z',
    generatedAt: '2026-08-26T14:02:01.000Z',
  };
  model.pages[0].timestamps = {
    startedAt: '2026-08-26T14:00:00.000Z',
    endedAt: '2026-08-26T14:01:00.000Z',
    generatedAt: model.timestamps.generatedAt,
  };
  model.pages[0].coverage = {};
  model.pages[0].warnings = [];
  model.pages.push({
    pageId: 'page-2', requestedUrl: secondUrl, finalUrl: secondUrl,
    status: 'complete', attempted: true, finalUrlObserved: true, axeStatus: 'not-run',
    timestamps: {
      startedAt: '2026-08-26T14:01:00.000Z',
      endedAt: '2026-08-26T14:02:00.000Z',
      generatedAt: model.timestamps.generatedAt,
    },
    viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
    diagnostics: [], coverage: {}, warnings: [],
  });
  model.evidence.push({
    ...clone(model.evidence.find(entry => entry.evidenceId === 'ev-full')),
    evidenceId: 'ev-full-page-2',
    pageId: 'page-2',
  });
  model.evidenceStateCount = 2;
  model.reproducibility.capturedStateCount = 2;
  delete model.snapshot;
  model.limitations = [
    'O relatório cobre somente a lista explícita de URLs e os estados observados; não constitui declaração de conformidade do site inteiro.',
    'A auditoria foi concluída parcialmente e contém limitações técnicas registradas nos diagnósticos.',
  ];
  for (const rule of model.ruleResults) {
    if (rule.source?.engine === 'audita-core') {
      rule.summary = canonicalBatchRuleSummary(rule.outcome);
    }
  }
  return model;
}

test('rejects diagnostic records that are individually catalogued but contradict their facts', () => {
  const cases = [];

  const sessionDetails = clone(SAMPLE_AUDIT);
  sessionDetails.session.diagnostics.push({
    code: 'REPORT_PDF_UNAVAILABLE',
    message: 'O PDF não foi gerado devido a uma limitação técnica local.',
    at: sessionDetails.timestamps.generatedAt,
    recoverable: true,
    details: { occurrenceId: PRIVATE_MARKER },
  });
  cases.push(sessionDetails);

  const noPartialCause = replacePageDiagnostics(clone(SAMPLE_AUDIT), []);
  cases.push(noPartialCause);

  const axeWithoutEnvelope = replacePageDiagnostics(clone(SAMPLE_AUDIT), [diagnostic(
    'AXE_EXECUTION_FAILED',
    'O motor suplementar axe-core teve cobertura parcial; o motor próprio continuou normalmente.',
  )]);
  cases.push(axeWithoutEnvelope);

  const pristineContradiction = replacePageDiagnostics(clone(SAMPLE_AUDIT), [diagnostic(
    'FULL_PAGE_CAPTURE_FAILED',
    'Não foi possível capturar a página completa no estado original.',
  )]);
  cases.push(pristineContradiction);

  const viewportContradiction = replacePageDiagnostics(clone(SAMPLE_AUDIT), [diagnostic(
    'ENVIRONMENT_UNAVAILABLE',
    'Os metadados públicos do ambiente não puderam ser lidos.',
  )]);
  cases.push(viewportContradiction);

  const annotationAlternatives = replacePageDiagnostics(clone(SAMPLE_AUDIT), [
    diagnostic(
      'ANNOTATION_MAP_SOURCE_INVALID',
      'O mapa visual derivado não pôde ser gerado localmente; a captura original foi preservada.',
    ),
    diagnostic(
      'ANNOTATION_MAP_TIMEOUT',
      'O mapa visual derivado não pôde ser gerado localmente; a captura original foi preservada.',
    ),
  ]);
  cases.push(annotationAlternatives);

  for (const candidate of cases) {
    assert.throws(() => createAuditModel(candidate), /modelo de auditoria inválido/iu);
  }
});

test('rejects orphan cross-page cleanup and evidence-budget claims', () => {
  const orphanCleanup = twoPageBatch();
  const fatal = diagnostic(
    'BATCH_NOT_STARTED_CLEANUP_UNCONFIRMED',
    'A página não foi iniciada porque a limpeza anterior não foi confirmada.',
    { at: '2026-08-26T14:01:00.000Z', recoverable: false },
  );
  orphanCleanup.pages[1] = {
    ...orphanCleanup.pages[1], finalUrlObserved: false, attempted: false, status: 'failed',
    timestamps: {
      startedAt: fatal.at, endedAt: fatal.at,
      generatedAt: orphanCleanup.timestamps.generatedAt,
    },
    viewport: { width: null, height: null, deviceScaleFactor: null },
    diagnostics: [fatal], coverage: {},
  };
  orphanCleanup.session.diagnostics.push(clone(fatal));

  const orphanOmission = twoPageBatch();
  orphanOmission.pages[0].omittedEvidence = [{
    evidenceId: 'ev-full', kind: 'full-page',
    contentHash: 'sha256-full-page-sample', reason: 'budget',
  }];

  for (const candidate of [orphanCleanup, orphanOmission]) {
    assert.throws(() => createAuditModel(candidate), /modelo de auditoria inválido/iu);
  }
});

test('rejects canonical limitation prose when the underlying fact is absent', () => {
  const candidate = clone(SAMPLE_AUDIT);
  candidate.limitations.push('A auditoria foi cancelada; resultados disponíveis permanecem incompletos.');
  assert.throws(() => createAuditModel(candidate), /modelo de auditoria inválido/iu);
});

test('rejects unbounded or cross-rule core targets for every outcome', () => {
  const hugePassedTarget = clone(SAMPLE_AUDIT);
  const passed = hugePassedTarget.ruleResults.find(rule => rule.ruleId === 'focus-fully-visible');
  passed.targets = ['x'.repeat(100_000)];

  const crossedRemediation = clone(SAMPLE_AUDIT);
  const focus = crossedRemediation.ruleResults.find(rule => rule.ruleId === 'focus-visible');
  focus.targets = [{
    nodeId: 'n-1',
    data: { reason: 'missing-page-title' },
    message: 'Informe um título para a página.',
  }];

  const privateParameter = clone(SAMPLE_AUDIT);
  const privateFocus = privateParameter.ruleResults.find(rule => rule.ruleId === 'focus-visible');
  privateFocus.targets = [{
    nodeId: 'n-1',
    data: { reason: 'focus-indicator-not-visible', attribute: PRIVATE_MARKER },
    message: 'Forneça um indicador de foco visível.',
  }];

  for (const candidate of [hugePassedTarget, crossedRemediation, privateParameter]) {
    assert.throws(() => createAuditModel(candidate), /modelo de auditoria inválido/iu);
  }
});

test('retains only canonical rule-specific remediation in the model, HTML and technical JSON', () => {
  const candidate = clone(SAMPLE_AUDIT);
  const focus = candidate.ruleResults.find(rule => rule.ruleId === 'focus-visible');
  focus.targets = [{
    nodeId: 'n-1',
    data: { reason: 'focus-indicator-not-visible' },
    message: 'Forneça um indicador de foco visível.',
  }];

  const model = createAuditModel(candidate);
  const html = renderHtmlReport(model);
  const technicalJson = renderTechnicalJson(model);

  assert.equal(model.ruleResults.find(rule => rule.ruleId === 'focus-visible').targets[0].message,
    'Forneça um indicador de foco visível.');
  assert.match(html, /Como corrigir/u);
  assert.match(html, /Forneça um indicador de foco visível\./u);
  assert.match(technicalJson, /Forneça um indicador de foco visível\./u);
});

test('closes snapshot coverage vocabulary, counts and warning catalogue', () => {
  const candidates = [];
  const baseSnapshot = {
    schemaVersion: 1,
    retention: 'summary-only',
    nodeCount: 1,
    coverage: {
      runtime: { outcome: 'complete', expectedFrameCount: 1, observedFrameCount: 1 },
      accessibility: { outcome: 'complete', expectedFrameCount: 1, observedFrameCount: 1 },
    },
    warnings: [],
  };

  const privateOutcome = clone(SAMPLE_AUDIT);
  privateOutcome.snapshot = clone(baseSnapshot);
  privateOutcome.snapshot.coverage.runtime.outcome = PRIVATE_MARKER;
  candidates.push(privateOutcome);

  const impossibleCount = clone(SAMPLE_AUDIT);
  impossibleCount.snapshot = clone(baseSnapshot);
  impossibleCount.snapshot.coverage.runtime.observedFrameCount = 99;
  candidates.push(impossibleCount);

  const privateWarning = clone(SAMPLE_AUDIT);
  privateWarning.snapshot = clone(baseSnapshot);
  privateWarning.snapshot.warnings = [{ code: PRIVATE_MARKER }];
  candidates.push(privateWarning);

  for (const candidate of candidates) {
    assert.throws(() => createAuditModel(candidate), /modelo de auditoria inválido/iu);
  }
});

test('closes the temporal report/artifact union and internal review URL boundary', () => {
  const candidates = [];

  const pendingFinalArtifact = clone(SAMPLE_AUDIT);
  pendingFinalArtifact.report = {
    status: 'pending', reviewUrl: null,
    artifact: { status: 'complete', formats: [] },
  };
  candidates.push(pendingFinalArtifact);

  const completePendingArtifact = clone(SAMPLE_AUDIT);
  completePendingArtifact.report = {
    status: 'complete', reviewUrl: null,
    artifact: { status: 'pending', formats: [] },
  };
  candidates.push(completePendingArtifact);

  const externalReviewUrl = clone(SAMPLE_AUDIT);
  externalReviewUrl.report.reviewUrl = `https://private.example.test/?token=${PRIVATE_MARKER}`;
  candidates.push(externalReviewUrl);

  const privateFormat = clone(SAMPLE_AUDIT);
  privateFormat.report.artifact.formats = [{ format: PRIVATE_MARKER, status: PRIVATE_MARKER }];
  candidates.push(privateFormat);

  for (const candidate of candidates) {
    assert.throws(() => createAuditModel(candidate), /modelo de auditoria inválido/iu);
  }
});

test('rebuilds generation claims from the current export attempt instead of retaining stale issues', async () => {
  const partial = await finalizeGeneratedModel(
    clone(SAMPLE_AUDIT),
    '2026-08-26T15:00:00.000Z',
    [createExportIssue('REPORT_PDF_UNAVAILABLE')],
    false,
    false,
    true,
    true,
  );
  const retried = await finalizeGeneratedModel(
    partial,
    '2026-08-26T15:01:00.000Z',
    [],
    true,
    false,
    true,
    true,
  );

  assert.equal(retried.report.artifact.status, 'complete');
  assert.equal(retried.session.diagnostics.some(entry => entry.code === 'REPORT_PDF_UNAVAILABLE'), false);
  assert.equal(retried.limitations.includes('O PDF não foi gerado devido a uma limitação técnica local.'), false);
});

test('binds occurrence evidence diagnostics to the exact missing artifact fact', () => {
  const entries = [
    ['EVIDENCE_NODE_MISSING', 'Um elemento relacionado à ocorrência não estava mais disponível.'],
    ['SNIPPET_CAPTURE_FAILED', 'O trecho de código do elemento não pôde ser capturado.'],
    ['ELEMENT_CAPTURE_FAILED', 'A miniatura do elemento não pôde ser capturada.'],
    ['EVIDENCE_CAPTURE_FAILED', 'As evidências de uma ocorrência não puderam ser preparadas.'],
  ];
  for (const [code, message] of entries) {
    const candidate = clone(SAMPLE_AUDIT);
    appendPageDiagnostic(candidate, diagnostic(code, message, {
      details: { occurrenceId: 'occ-focus-failed' },
    }));
    assert.throws(() => createAuditModel(candidate), /modelo de auditoria inválido/iu, code);
  }

  const missingPristineWithoutDiagnostic = clone(SAMPLE_AUDIT);
  missingPristineWithoutDiagnostic.evidence = missingPristineWithoutDiagnostic.evidence
    .filter(artifact => artifact.evidenceId !== 'ev-full')
    .map(artifact => {
      const next = { ...artifact };
      delete next.fullPageEvidenceId;
      return next;
    });
  for (const occurrence of missingPristineWithoutDiagnostic.occurrences) {
    occurrence.evidenceRefs = occurrence.evidenceRefs.filter(id => id !== 'ev-full');
    occurrence.evidenceIds = occurrence.evidenceIds.filter(id => id !== 'ev-full');
  }
  missingPristineWithoutDiagnostic.evidenceStateCount = 0;
  missingPristineWithoutDiagnostic.reproducibility.capturedStateCount = 0;
  assert.throws(() => createAuditModel(missingPristineWithoutDiagnostic), /modelo de auditoria inválido/iu);
});

test('requires an immediate complete not-started suffix after a non-final cleanup barrier', () => {
  const candidate = twoPageBatch();
  assert.doesNotThrow(() => createAuditModel(candidate), 'o controle batch precisa ser canônico antes da única mutação');
  appendPageDiagnostic(candidate, diagnostic(
    'TAB_CLOSE_FAILED',
    'A aba descartável não pôde ser fechada automaticamente.',
    { at: candidate.pages[0].timestamps.endedAt },
  ));
  assert.equal(candidate.pages[1].attempted, true);
  assert.throws(() => createAuditModel(candidate), /modelo de auditoria inválido/iu);

  const finalBarrier = twoPageBatch();
  finalBarrier.pages[1].status = 'partial';
  appendPageDiagnostic(finalBarrier, diagnostic(
    'TAB_CLOSE_FAILED',
    'A aba descartável não pôde ser fechada automaticamente.',
    { at: finalBarrier.pages[1].timestamps.endedAt },
  ), 1);
  assert.doesNotThrow(() => createAuditModel(finalBarrier));

  const combinedFinalBarrier = twoPageBatch();
  combinedFinalBarrier.pages[1].status = 'partial';
  appendPageDiagnostic(combinedFinalBarrier, diagnostic(
    'CDP_DISCONNECT_FAILED',
    'A sessão de depuração não pôde ser encerrada automaticamente.',
    { at: combinedFinalBarrier.pages[1].timestamps.endedAt },
  ), 1);
  appendPageDiagnostic(combinedFinalBarrier, diagnostic(
    'TAB_CLOSE_FAILED',
    'A aba descartável não pôde ser fechada automaticamente.',
    { at: combinedFinalBarrier.pages[1].timestamps.endedAt },
  ), 1);
  assert.doesNotThrow(() => createAuditModel(combinedFinalBarrier));
});

test('closes the evidence pixel union and omitted-budget metadata', () => {
  const normalPrivateState = clone(SAMPLE_AUDIT);
  Object.assign(normalPrivateState.evidence.find(entry => entry.evidenceId === 'ev-control'), {
    pixelState: PRIVATE_MARKER,
    pixelContentHash: PRIVATE_MARKER,
  });

  const omittedWithPixels = twoPageBatch();
  const artifact = omittedWithPixels.evidence.find(entry => entry.evidenceId === 'ev-control');
  Object.assign(artifact, {
    pixelState: 'omitted-budget',
    pixelContentHash: PRIVATE_MARKER,
    hash: PRIVATE_MARKER,
  });
  omittedWithPixels.pages[0].omittedEvidence = [{
    evidenceId: artifact.evidenceId,
    kind: artifact.kind,
    contentHash: PRIVATE_MARKER,
    reason: 'budget',
  }];
  appendPageDiagnostic(omittedWithPixels, diagnostic(
    'BATCH_EVIDENCE_BUDGET_EXCEEDED',
    'O orçamento total de 256 MiB de PNGs foi atingido; novos pixels foram omitidos, preservando metadados e hashes de conteúdo.',
    { at: omittedWithPixels.pages[0].timestamps.endedAt },
  ));

  for (const candidate of [normalPrivateState, omittedWithPixels]) {
    assert.throws(() => createAuditModel(candidate), /modelo de auditoria inválido/iu);
    assert.doesNotMatch(renderTechnicalJson.bind(null, candidate).toString(), new RegExp(PRIVATE_MARKER, 'u'));
  }
});

test('rejects another extension review URL so foreign authority cannot enter the canonical model', () => {
  const candidate = clone(SAMPLE_AUDIT);
  candidate.report.reviewUrl =
    `chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba/src/review/index.html?auditId=${SAMPLE_AUDIT.auditId}`;

  assert.throws(() => createAuditModel(candidate), /modelo de auditoria inválido/iu);
});

test('rejects the trusted extension review URL so no capability can enter the canonical model', () => {
  const candidate = clone(SAMPLE_AUDIT);
  candidate.report.reviewUrl =
    `chrome-extension://${EXTENSION_ID}/src/review/index.html?auditId=${SAMPLE_AUDIT.auditId}`;

  assert.throws(() => createAuditModel(candidate), /modelo de auditoria inválido/iu);
});

test('binds a handoff capability to the trusted runtime id and then discards it', async () => {
  const reportOptions = {
    now: () => '2026-08-26T14:02:00.000Z',
    timezone: 'America/Cuiaba',
    manifestVersion: '0.1.0',
    rulesVersion: '1.0.0',
    browserVersion: 'Chrome/147.0.0.0',
    expectedExtensionId: EXTENSION_ID,
  };
  const expected = `chrome-extension://${EXTENSION_ID}/src/review/index.html?auditId=${SAMPLE_AUDIT.auditId}`;
  const accepted = await enrichAuditForReport(clone(SAMPLE_AUDIT), {
    ...reportOptions,
    handoffReviewUrl: expected,
  });
  assert.deepEqual(accepted.report, {
    status: 'review-ready',
    reviewUrl: null,
    artifact: { status: 'pending', formats: [] },
  });
  assert.doesNotMatch(JSON.stringify(accepted), new RegExp(EXTENSION_ID, 'u'));

  const differentValidId = 'ponmlkjihgfedcbaponmlkjihgfedcba';
  await assert.rejects(enrichAuditForReport(clone(SAMPLE_AUDIT), {
    ...reportOptions,
    handoffReviewUrl: `chrome-extension://${differentValidId}/src/review/index.html?auditId=${SAMPLE_AUDIT.auditId}`,
  }), /modelo de auditoria inválido/iu);
});

test('retains canonical structural warnings and non-primary viewport limitations per page', () => {
  const candidate = twoPageBatch();
  candidate.pages[0].warnings = [];
  candidate.pages[0].limitations = [];
  candidate.pages[1].warnings = [{ code: 'TIMEOUT' }];
  candidate.pages[1].coverage = {
    runtime: { outcome: 'partial', expectedFrameCount: 2, observedFrameCount: 1 },
  };
  candidate.pages[1].status = 'partial';
  candidate.pages[1].viewport = { width: null, height: null, deviceScaleFactor: null };
  const probe = diagnostic(
    'DYNAMIC_PROBES_INCOMPLETE',
    'As verificações dinâmicas atingiram o tempo limite.',
    { at: '2026-08-26T14:01:20.000Z' },
  );
  const environment = diagnostic(
    'ENVIRONMENT_UNAVAILABLE',
    'Os metadados públicos do ambiente não puderam ser lidos.',
    { at: '2026-08-26T14:01:30.000Z' },
  );
  candidate.pages[1].diagnostics = [probe, environment];
  candidate.session.diagnostics.push(clone(probe), clone(environment));
  candidate.pages[1].limitations = [STRUCTURAL_LIMITATION, VIEWPORT_LIMITATION];
  candidate.limitations = [
    'O relatório cobre somente a lista explícita de URLs e os estados observados; não constitui declaração de conformidade do site inteiro.',
    'A auditoria foi concluída parcialmente e contém limitações técnicas registradas nos diagnósticos.',
    STRUCTURAL_LIMITATION,
    VIEWPORT_LIMITATION,
  ];
  const model = createAuditModel(candidate);
  assert.deepEqual(model.pages[1].warnings, [{ code: 'TIMEOUT' }]);
  assert.deepEqual(model.pages[1].limitations, [STRUCTURAL_LIMITATION, VIEWPORT_LIMITATION]);

  const single = clone(SAMPLE_AUDIT);
  single.snapshot = {
    schemaVersion: 1,
    retention: 'summary-only',
    nodeCount: 1,
    coverage: { runtime: { outcome: 'partial', expectedFrameCount: 2, observedFrameCount: 1 } },
    warnings: [{ code: 'TIMEOUT' }],
  };
  single.pages[0].warnings = [{ code: 'TIMEOUT' }];
  single.pages[0].limitations = [STRUCTURAL_LIMITATION];
  single.limitations.push(STRUCTURAL_LIMITATION);
  assert.doesNotThrow(() => createAuditModel(single));

  single.pages[0].warnings = [];
  assert.throws(() => createAuditModel(single), /modelo de auditoria inválido/iu);
});

test('enforces session-only export issue groups and causal exclusivity', async () => {
  await assert.rejects(
    finalizeGeneratedModel(
      clone(SAMPLE_AUDIT),
      '2026-08-26T15:00:00.000Z',
      [createExportIssue('REPORT_PRINT_TAB_FAILED'), createExportIssue('REPORT_PDF_UNAVAILABLE')],
      false, false, true, true,
    ),
    /modelo de auditoria inválido/iu,
  );
  await assert.rejects(
    finalizeGeneratedModel(
      clone(SAMPLE_AUDIT),
      '2026-08-26T15:00:00.000Z',
      [createExportIssue('REPORT_EXPORT_PREPARATION_FAILED'), createExportIssue('REPORT_CSV_UNAVAILABLE')],
      false, false, false, false,
    ),
    /modelo de auditoria inválido/iu,
  );
});

test('bounds and correlates productive non-axe occurrence targets', () => {
  const hugeSelector = clone(SAMPLE_AUDIT);
  hugeSelector.occurrences[0].target.selector = 'x'.repeat(120_000);

  const hugeFrame = clone(SAMPLE_AUDIT);
  hugeFrame.occurrences[0].target.framePath = ['x'.repeat(120_000)];

  const manualSelector = clone(SAMPLE_AUDIT);
  manualSelector.occurrences.find(entry => entry.source.engine === 'audita-manual-review').target.selector = '#private';

  const forgedBatchNode = twoPageBatch();
  const occurrence = forgedBatchNode.occurrences.find(entry => entry.source.engine === 'audita-core');
  occurrence.nodeId = 'forged-node';
  occurrence.target.nodeId = 'forged-node';

  for (const candidate of [hugeSelector, hugeFrame, manualSelector, forgedBatchNode]) {
    assert.throws(() => createAuditModel(candidate), /modelo de auditoria inválido/iu);
  }
});

test('deduplicates material limitations and diagnostics in the HTML summary and list', async () => {
  const model = await finalizeGeneratedModel(
    clone(SAMPLE_AUDIT),
    '2026-08-26T15:00:00.000Z',
    [createExportIssue('REPORT_PDF_UNAVAILABLE')],
    false, false, true, true,
  );
  const html = renderHtmlReport(model);
  assert.match(html, /Limitações materiais registradas:<\/strong> 4\./u);
  const methodology = html.match(/<h3>Limitações e diagnósticos<\/h3><ul class="compact-list">([\s\S]*?)<\/ul>/u)?.[1] ?? '';
  assert.equal((methodology.match(/O PDF não foi gerado devido a uma limitação técnica local\./gu) ?? []).length, 1);
  assert.match(methodology, /REPORT_PDF_UNAVAILABLE/u);
});
