import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { SAMPLE_AUDIT } from '../../fixtures/audits/sample-audit.js';
import { buildArtifactBaseName } from '../../src/browser/download-artifacts.js';
import { canonicalStringify } from '../../src/core/report/canonical-json.js';
import { renderOccurrenceCsv } from '../../src/core/report/csv.js';
import { renderTechnicalJson } from '../../src/core/report/earl-json.js';
import { renderHtmlReport } from '../../src/core/report/html.js';
import { verifyAuditIntegritySnapshot } from '../../src/core/report/integrity.js';
import { persistExportFailure, persistExportSuccess } from '../../src/export/export-controller.js';
import { attestReportExportResult } from '../../src/export/export-provenance.js';
import { runReportExport } from '../../src/export/report-export.js';

const PDF = new TextEncoder().encode('%PDF-1.7\ncontroller-test');

test('atomically commits a controlled partial model and latest state for pre-result failure', async () => {
  const commits = [];
  const store = { async commitAudit(...values) { commits.push(values); } };
  const model = structuredClone(SAMPLE_AUDIT);
  model.limitations.push('TOPSECRET https://origin.test/?token=x blob:chrome-extension://test/private');
  const result = await persistExportFailure({
    auditId: SAMPLE_AUDIT.auditId,
    model,
    latest: { auditId: SAMPLE_AUDIT.auditId, status: 'partial', exportStatus: 'running' },
    at: '2026-08-26T16:00:00.000Z',
  }, store);
  assert.equal(commits.length, 1);
  assert.equal(commits[0][0], SAMPLE_AUDIT.auditId);
  assert.equal(commits[0][1].session.status, 'partial');
  assert.deepEqual(commits[0][1].report.artifact.formats, []);
  assert.equal(commits[0][2].exportStatus, 'failed');
  assert.deepEqual(result, { model: commits[0][1], latest: commits[0][2] });
  assert.doesNotMatch(JSON.stringify(commits), /TOPSECRET|origin\.test|blob:|chrome-extension:/iu);
});

test('rejects mismatched audit ID instead of committing another model', async () => {
  let committed = false;
  await assert.rejects(persistExportFailure({ auditId: 'audit-other', model: structuredClone(SAMPLE_AUDIT), latest: {}, at: '2026-08-26T16:00:00.000Z' }, { async commitAudit() { committed = true; } }), /correla|auditId|auditoria/iu);
  assert.equal(committed, false);
});

test('snapshots a failure request without repeatedly reading a hostile model accessor', async () => {
  const request = {
    auditId: SAMPLE_AUDIT.auditId,
    latest: {},
    at: '2026-08-26T16:00:00.000Z',
  };
  let modelReads = 0;
  Object.defineProperty(request, 'model', {
    enumerable: true,
    get() {
      modelReads += 1;
      const model = structuredClone(SAMPLE_AUDIT);
      if (modelReads > 1) model.auditId = 'audit-private-alternate';
      return model;
    },
  });
  let committed = false;

  await assert.rejects(
    persistExportFailure(request, { async commitAudit() { committed = true; } }),
    /solicitação|propriedade|segur|esquema/iu,
  );

  assert.equal(modelReads, 0);
  assert.equal(committed, false);
});

test('rejects nested failure-model accessors before structured cloning can invoke them', async () => {
  const model = structuredClone(SAMPLE_AUDIT);
  let nestedReads = 0;
  Object.defineProperty(model.occurrences[0], 'privateValue', {
    enumerable: true,
    get() {
      nestedReads += 1;
      return 'PRIVATE_NESTED_FAILURE_SENTINEL';
    },
  });
  let committed = false;

  await assert.rejects(
    persistExportFailure({
      auditId: model.auditId,
      model,
      latest: {},
      at: '2026-08-26T16:00:00.000Z',
    }, { async commitAudit() { committed = true; } }),
    /solicitação|propriedade|segur|esquema/iu,
  );

  assert.equal(nestedReads, 0);
  assert.equal(committed, false);
});

test('sanitizes a hostile failure-request proxy before persistence', async () => {
  let getTraps = 0;
  const proxy = new Proxy({
    auditId: SAMPLE_AUDIT.auditId,
    model: structuredClone(SAMPLE_AUDIT),
    latest: {},
    at: '2026-08-26T16:00:00.000Z',
  }, {
    get() {
      getTraps += 1;
      throw new Error('PRIVATE_FAILURE_PROXY_SENTINEL');
    },
  });
  let committed = false;

  await assert.rejects(
    persistExportFailure(proxy, { async commitAudit() { committed = true; } }),
    error => error instanceof TypeError && !error.message.includes('PRIVATE_FAILURE_PROXY_SENTINEL'),
  );

  assert.equal(getTraps, 0);
  assert.equal(committed, false);

  const revocable = Proxy.revocable({
    auditId: SAMPLE_AUDIT.auditId,
    model: structuredClone(SAMPLE_AUDIT),
    latest: {},
    at: '2026-08-26T16:00:00.000Z',
  }, {});
  revocable.revoke();
  await assert.rejects(
    persistExportFailure(revocable.proxy, { async commitAudit() { committed = true; } }),
    error => error instanceof TypeError && !/revoked|proxy/iu.test(error.message),
  );
  assert.equal(committed, false);
});

test('persists the initial failure latest snapshot despite mutation during finalization', async () => {
  const request = {
    auditId: SAMPLE_AUDIT.auditId,
    model: structuredClone(SAMPLE_AUDIT),
    latest: { auditId: SAMPLE_AUDIT.auditId, marker: 'initial' },
    at: '2026-08-26T16:00:00.000Z',
  };
  const commits = [];

  const pending = persistExportFailure(request, {
    async commitAudit(...values) { commits.push(values); },
  });
  request.latest = { auditId: SAMPLE_AUDIT.auditId, marker: 'PRIVATE_AFTER_CALL' };
  const persisted = await pending;

  assert.equal(persisted.latest.marker, 'initial');
  assert.equal(commits[0][2].marker, 'initial');
  assert.doesNotMatch(JSON.stringify(commits), /PRIVATE_AFTER_CALL/u);
});

test('atomically persists the exact serialized model and a separate delivery receipt', async () => {
  const commits = [];
  const model = generatedModel(['html', 'json', 'csv', 'pdf']);
  const receipt = {
    status: 'partial',
    formats: [
      receiptFormat('html', 'complete', 1), receiptFormat('json', 'complete', 2),
      { ...receiptFormat('csv', 'timeout', 3), failureCode: 'DOWNLOAD_WAIT_TIMEOUT' },
      receiptFormat('pdf', 'complete', 4),
    ],
    limitations: ['O artefato CSV não concluiu o download (tempo limite excedido).'],
  };
  const result = await exportResult(model, receipt);
  const persisted = await persistExportSuccess({ auditId: SAMPLE_AUDIT.auditId, result, latest: { auditId: SAMPLE_AUDIT.auditId, status: 'partial' } }, { async commitAudit(...values) { commits.push(values); } });
  assert.equal(commits.length, 1);
  assert.deepEqual(commits[0][1], JSON.parse(result.json).audit);
  assert.deepEqual(commits[0][2].deliveryReceipt, result.deliveryReceipt);
  assert.equal(persisted.latest.exportStatus, 'partial');
  assert.equal(Object.hasOwn(commits[0][1].report.artifact, 'deliveryReceipt'), false);
});

test('rejects forged evidence bytes even when manifest and canonical claims were recomputed', async () => {
  const model = generatedModel(['html', 'json', 'csv', 'pdf']);
  model.evidence[0].dataUrl = `data:image/png;base64,${Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x63,
  ]).toString('base64')}`;
  model.evidence[0].hash = 'b'.repeat(64);
  refreshDeclaredIntegrity(model);
  const receipt = {
    status: 'complete',
    formats: ['html', 'json', 'csv', 'pdf'].map((format, index) => receiptFormat(format, 'complete', index + 1)),
    limitations: [],
  };
  let committed = false;

  await assert.rejects(
    persistExportSuccess({
      auditId: model.auditId,
      result: await exportResult(model, receipt),
      latest: {},
    }, { async commitAudit() { committed = true; } }),
    /integridade|evidência|hash/iu,
  );

  assert.equal(committed, false);
});

test('rejects unavailable integrity in a final V2 export', async () => {
  const model = generatedModel(['html', 'json', 'csv', 'pdf']);
  model.integrity = { algorithm: 'unavailable', status: 'not-recorded-v1' };
  const receipt = {
    status: 'complete',
    formats: ['html', 'json', 'csv', 'pdf'].map((format, index) => receiptFormat(format, 'complete', index + 1)),
    limitations: [],
  };
  let committed = false;

  await assert.rejects(
    persistExportSuccess({
      auditId: model.auditId,
      result: await exportResult(model, receipt),
      latest: {},
    }, { async commitAudit() { committed = true; } }),
    /integridade|SHA-256|indisponível/iu,
  );

  assert.equal(committed, false);
});

test('persists only the initial success snapshot when the caller mutates its model later', async () => {
  const model = generatedModel(['html', 'json', 'csv', 'pdf']);
  const expected = structuredClone(model);
  const receipt = {
    status: 'complete',
    formats: ['html', 'json', 'csv', 'pdf'].map((format, index) => receiptFormat(format, 'complete', index + 1)),
    limitations: [],
  };
  const result = await exportResult(model, receipt);
  const commits = [];

  const pending = persistExportSuccess({ auditId: model.auditId, result, latest: {} }, {
    async commitAudit(...values) { commits.push(values); },
  });
  result.model.evidence[0].hash = 'c'.repeat(64);
  result.model.auditId = 'audit-mutated-after-call';
  const persisted = await pending;

  assert.deepEqual(persisted.model, expected);
  assert.deepEqual(commits[0][1], expected);
});

test('rejects forged PDF bytes and matching forged receipt hashes after a genuine final print', async () => {
  const result = await genuineReportExport();
  const forgedPdf = new TextEncoder().encode('%PDF-1.7\nPRIVATE_FORGED_PDF');
  const forgedHash = artifactHash(forgedPdf);
  result.pdf = forgedPdf;
  result.formats = result.formats.map(entry => entry.format === 'pdf' ? { ...entry, sha256: forgedHash } : entry);
  result.deliveryReceipt = {
    ...result.deliveryReceipt,
    formats: result.deliveryReceipt.formats.map(entry =>
      entry.format === 'pdf' ? { ...entry, sha256: forgedHash } : entry),
  };
  let committed = false;

  await assert.rejects(
    persistExportSuccess({ auditId: result.model.auditId, result, latest: {} }, {
      async commitAudit() { committed = true; },
    }),
    /proveniência|PDF|impressão|artefato|correla/iu,
  );

  assert.equal(committed, false);
});

test('accepts the untouched artifact set attested by genuine final report generation', async () => {
  const result = await genuineReportExport();
  const commits = [];

  const persisted = await persistExportSuccess({
    auditId: result.model.auditId,
    result,
    latest: {},
  }, { async commitAudit(...values) { commits.push(values); } });

  assert.equal(commits.length, 1);
  assert.deepEqual(commits[0][1], result.model);
  assert.equal(persisted.latest.exportStatus, 'complete');
});

test('requires correlated ordered unique receipt formats with exact MIME, filename, hash and status semantics', async () => {
  const model = generatedModel(['html', 'json', 'csv', 'pdf']);
  const baseReceipt = {
    status: 'complete',
    formats: [
      receiptFormat('html', 'complete', 1), receiptFormat('json', 'complete', 2),
      receiptFormat('csv', 'complete', 3), receiptFormat('pdf', 'complete', 4),
    ],
    limitations: [],
  };
  const attempts = [
    { ...baseReceipt, formats: [...baseReceipt.formats, receiptFormat('csv', 'complete', 5)] },
    { ...baseReceipt, formats: baseReceipt.formats.map((entry, index) => index === 2 ? { ...entry, format: 'xml' } : entry) },
    { ...baseReceipt, formats: baseReceipt.formats.map((entry, index) => index === 2 ? { ...entry, mimeType: 'text/plain' } : entry) },
    { ...baseReceipt, formats: baseReceipt.formats.map((entry, index) => index === 2 ? { ...entry, filename: 'audit.csv.exe' } : entry) },
    { ...baseReceipt, formats: baseReceipt.formats.map((entry, index) => index === 2 ? { ...entry, sha256: 'forged' } : entry) },
    { ...baseReceipt, formats: baseReceipt.formats.map(entry => ({ ...entry, filename: `other-base.${entry.format}` })) },
    { ...baseReceipt, formats: baseReceipt.formats.map(entry => ({ ...entry, downloadId: 7 })) },
    { ...baseReceipt, formats: [baseReceipt.formats[1], baseReceipt.formats[0], ...baseReceipt.formats.slice(2)] },
    { ...baseReceipt, status: 'partial' },
  ];
  for (const deliveryReceipt of attempts) {
    let committed = false;
    await assert.rejects(persistExportSuccess({
      auditId: model.auditId,
      result: await exportResult(model, deliveryReceipt),
      latest: {},
    }, { async commitAudit() { committed = true; } }), /recibo|formato|MIME|arquivo|hash|ordem|status|correla/iu);
    assert.equal(committed, false);
  }
});

test('requires the four-format model contract and exact generation evidence for omitted CSV or PDF', async () => {
  const invalidModels = [
    generatedModel(['html', 'json']),
    generatedModel(['json', 'csv', 'pdf']),
    generatedModel(['html', 'csv', 'pdf']),
    generatedModel(['html', 'json'], ['REPORT_CSV_UNAVAILABLE']),
    generatedModel(['html', 'json', 'pdf'], ['REPORT_PDF_UNAVAILABLE']),
    generatedModel(['html', 'json', 'csv'], ['REPORT_PRINT_CLEANUP_LIMITED']),
    generatedModel(['html', 'json', 'csv'], ['REPORT_PDF_TAGGING_UNSUPPORTED']),
  ];
  invalidModels.push(generatedModel(['html', 'json', 'pdf'], ['REPORT_CSV_UNAVAILABLE'], {
    artifactLimitations: ['Mensagem não canônica para o CSV.'],
  }));

  for (const model of invalidModels) {
    let committed = false;
    const formats = model.report.artifact.formats.map(entry => receiptFormat(entry.format, 'complete', 1));
    await assert.rejects(persistExportSuccess({
      auditId: model.auditId,
      result: await exportResult(model, { status: 'complete', formats, limitations: [] }),
      latest: {},
    }, { async commitAudit() { committed = true; } }), /formato|quatro|CSV|PDF|diagnóstico|limitação|parcial|relatório/iu);
    assert.equal(committed, false);
  }
});

test('accepts controlled CSV or PDF generation omissions only as partial exports', async () => {
  const cases = [
    generatedModel(['html', 'json', 'pdf'], ['REPORT_CSV_UNAVAILABLE']),
    generatedModel(['html', 'json', 'csv'], ['REPORT_PRINT_ASSETS_TIMEOUT']),
    generatedModel(['html', 'json'], ['REPORT_CSV_UNAVAILABLE', 'REPORT_PDF_UNAVAILABLE']),
  ];

  for (const model of cases) {
    const formats = model.report.artifact.formats.map((entry, index) => receiptFormat(entry.format, 'complete', index + 1));
    const persisted = await persistExportSuccess({
      auditId: model.auditId,
      result: await exportResult(model, {
        status: 'partial',
        formats,
        limitations: model.report.artifact.limitations,
      }),
      latest: {},
    }, { async commitAudit() {} });
    assert.equal(persisted.latest.exportStatus, 'partial');
    assert.equal(persisted.latest.deliveryReceipt.status, 'partial');
  }
});

test('accepts one exact late print-cleanup limitation only in a partial delivery receipt', async () => {
  const model = generatedModel(['html', 'json', 'csv', 'pdf']);
  const formats = ['html', 'json', 'csv', 'pdf'].map((format, index) => receiptFormat(format, 'complete', index + 1));
  const cleanup = 'A limpeza de um recurso temporário de impressão não pôde ser confirmada.';
  const deliveryReceipt = { status: 'partial', formats, limitations: [cleanup] };
  const result = await exportResult(model, deliveryReceipt);
  let committed = false;

  const persisted = await persistExportSuccess({
    auditId: model.auditId,
    result,
    latest: {},
  }, { async commitAudit() { committed = true; } });

  assert.equal(committed, true);
  assert.equal(persisted.latest.exportStatus, 'partial');
  assert.deepEqual(persisted.latest.deliveryReceipt, result.deliveryReceipt);
});

test('rejects artifact payloads that are present despite controlled CSV or PDF omission', async () => {
  const missingCsv = generatedModel(['html', 'json', 'pdf'], ['REPORT_CSV_UNAVAILABLE']);
  const missingPdf = generatedModel(['html', 'json', 'csv'], ['REPORT_PDF_UNAVAILABLE']);
  for (const [model, format] of [[missingCsv, 'csv'], [missingPdf, 'pdf']]) {
    const formats = model.report.artifact.formats.map((entry, index) => receiptFormat(entry.format, 'complete', index + 1));
    const valid = await exportResult(model, {
      status: 'partial',
      formats,
      limitations: model.report.artifact.limitations,
    });
    const result = format === 'csv'
      ? { ...valid, csv: '\uFEFF"private"\r\n"PRIVATE_SENTINEL"\r\n' }
      : { ...valid, pdf: Uint8Array.from(PDF) };
    let committed = false;
    await assert.rejects(persistExportSuccess({ auditId: model.auditId, result, latest: {} }, {
      async commitAudit() { committed = true; },
    }), /CSV|PDF|artefato|formato|correla/iu);
    assert.equal(committed, false);
  }
});

test('rejects stale or bidirectionally inconsistent generation evidence and PDF fallback omissions', async () => {
  const staleCsv = generatedModel(['html', 'json', 'pdf'], ['REPORT_CSV_UNAVAILABLE']);
  staleCsv.session.diagnostics[0].at = '2026-08-26T15:59:59.999Z';
  const csvIssueWithCsv = generatedModel(['html', 'json', 'csv', 'pdf'], ['REPORT_CSV_UNAVAILABLE']);
  const missingFallbackPdf = generatedModel(['html', 'json', 'csv'], ['REPORT_PDF_UNAVAILABLE']);
  missingFallbackPdf.report.artifact.pdfFallback = true;
  const extraDiagnostic = generatedModel(['html', 'json', 'pdf'], ['REPORT_CSV_UNAVAILABLE']);
  extraDiagnostic.session.diagnostics[0].details = { note: 'PRIVATE_DIAGNOSTIC_SENTINEL' };
  const duplicateDiagnostic = generatedModel(['html', 'json', 'pdf'], ['REPORT_CSV_UNAVAILABLE']);
  duplicateDiagnostic.session.diagnostics.push(structuredClone(duplicateDiagnostic.session.diagnostics[0]));

  for (const model of [staleCsv, csvIssueWithCsv, missingFallbackPdf, extraDiagnostic, duplicateDiagnostic]) {
    const formats = model.report.artifact.formats.map((entry, index) => receiptFormat(entry.format, 'complete', index + 1));
    const missing = ['csv', 'pdf'].filter(format => !model.report.artifact.formats.some(entry => entry.format === format));
    const limitations = missing.map(format => format === 'csv'
      ? GENERATION_MESSAGES.REPORT_CSV_UNAVAILABLE
      : GENERATION_MESSAGES.REPORT_PDF_UNAVAILABLE);
    let committed = false;
    await assert.rejects(persistExportSuccess({
      auditId: model.auditId,
      result: await exportResult(model, { status: missing.length ? 'partial' : 'complete', formats, limitations }),
      latest: {},
    }, { async commitAudit() { committed = true; } }), /diagnóstico|geração|formato|PDF|CSV|fallback|correla/iu);
    assert.equal(committed, false);
  }
});

test('rejects unbacked artifact limitations and forged PDF fallback status in otherwise complete exports', async () => {
  const rawLimitation = generatedModel(['html', 'json', 'csv', 'pdf']);
  rawLimitation.report.artifact.limitations = ['token=PRIVATE_ARTIFACT_SENTINEL'];
  rawLimitation.limitations = ['token=PRIVATE_ARTIFACT_SENTINEL'];
  const forgedFallback = generatedModel(['html', 'json', 'csv', 'pdf']);
  forgedFallback.report.artifact.pdfFallback = true;
  const unsupportedWithoutFallback = generatedModel(
    ['html', 'json', 'csv', 'pdf'],
    ['REPORT_PDF_TAGGING_UNSUPPORTED'],
  );

  for (const model of [rawLimitation, forgedFallback, unsupportedWithoutFallback]) {
    const formats = model.report.artifact.formats.map((entry, index) => receiptFormat(entry.format, 'complete', index + 1));
    const result = await exportResult(model, { status: 'complete', formats, limitations: [] });
    let committed = false;
    await assert.rejects(persistExportSuccess({ auditId: model.auditId, result, latest: {} }, {
      async commitAudit() { committed = true; },
    }), /limitação|diagnóstico|fallback|status|PDF|correla/iu);
    assert.equal(committed, false);
  }
});

test('accepts PDF fallback only with one exact current tagging diagnostic and partial model status', async () => {
  const model = generatedModel(['html', 'json', 'csv', 'pdf'], ['REPORT_PDF_TAGGING_UNSUPPORTED']);
  model.report.artifact.pdfFallback = true;
  refreshDeclaredIntegrity(model);
  const formats = model.report.artifact.formats.map((entry, index) => receiptFormat(entry.format, 'complete', index + 1));
  const result = await exportResult(model, { status: 'complete', formats, limitations: [] });

  const persisted = await persistExportSuccess({ auditId: model.auditId, result, latest: {} }, { async commitAudit() {} });

  assert.equal(persisted.latest.exportStatus, 'partial');
  assert.equal(persisted.model.report.artifact.pdfFallback, true);
});

test('rejects forged top-level artifact correlation and well-formed but wrong hashes', async () => {
  const model = generatedModel(['html', 'json', 'csv', 'pdf']);
  const receipt = {
    status: 'complete',
    formats: ['html', 'json', 'csv', 'pdf'].map((format, index) => receiptFormat(format, 'complete', index + 1)),
    limitations: [],
  };
  const valid = await exportResult(model, receipt);
  const wrongHashFormats = valid.formats.map((entry, index) => index === 0 ? { ...entry, sha256: 'b'.repeat(64) } : entry);
  const attempts = [
    { ...valid, formats: [] },
    { ...valid, pdfFallback: true },
    { ...valid, csv: null },
    { ...valid, formats: wrongHashFormats, deliveryReceipt: { ...valid.deliveryReceipt, formats: wrongHashFormats } },
  ];

  for (const attempt of attempts) {
    let committed = false;
    await assert.rejects(persistExportSuccess({
      auditId: model.auditId,
      result: attempt,
      latest: {},
    }, { async commitAudit() { committed = true; } }), /hash|formato|CSV|PDF|correla|resultado|artefato/iu);
    assert.equal(committed, false);
  }
});

test('preserves fixed artifact failure stage and rejects incompatible failure schemas or raw limitations', async () => {
  const model = generatedModel(['html', 'json', 'csv', 'pdf']);
  const blobFailure = {
    status: 'partial',
    formats: [
      receiptFormat('html', 'complete', 1),
      receiptFormat('json', 'complete', 2),
      { ...receiptFormat('csv', 'interrupted'), failureCode: 'ARTIFACT_BLOB_FAILED' },
      receiptFormat('pdf', 'complete', 4),
    ],
    limitations: ['O artefato CSV não pôde ser preparado para download.'],
  };
  const persisted = await persistExportSuccess({
    auditId: model.auditId,
    result: await exportResult(model, blobFailure),
    latest: {},
  }, { async commitAudit() {} });
  assert.equal(persisted.latest.deliveryReceipt.formats[2].failureCode, 'ARTIFACT_BLOB_FAILED');
  assert.deepEqual(persisted.latest.deliveryReceipt.limitations, blobFailure.limitations);

  const invalidReceipts = [
    { ...blobFailure, formats: blobFailure.formats.map((entry, index) => index === 2 ? receiptFormat('csv', 'interrupted') : entry) },
    { ...blobFailure, formats: blobFailure.formats.map((entry, index) => index === 2 ? { ...entry, failureCode: 'UNKNOWN_FAILURE' } : entry) },
    { ...blobFailure, formats: blobFailure.formats.map((entry, index) => index === 2 ? { ...entry, status: 'timeout' } : entry) },
    { ...blobFailure, formats: blobFailure.formats.map((entry, index) => index === 2 ? { ...entry, failureCode: 'DOWNLOAD_WAIT_TIMEOUT', status: 'timeout' } : entry) },
    { ...blobFailure, formats: blobFailure.formats.map((entry, index) => index === 2 ? { ...entry, failureCode: 'ARTIFACT_BYTES_INVALID', sha256: 'a'.repeat(64) } : entry) },
    { ...blobFailure, limitations: ['PRIVATE_SENTINEL https://origin.test/?token=x'] },
    {
      ...blobFailure,
      limitations: [
        ...blobFailure.limitations,
        'A liberação do endereço temporário do artefato CSV não pôde ser confirmada.',
      ],
    },
  ];
  for (const deliveryReceipt of invalidReceipts) {
    await assert.rejects(persistExportSuccess({
      auditId: model.auditId,
      result: await exportResult(model, deliveryReceipt),
      latest: {},
    }, { async commitAudit() {} }), /recibo|falha|etapa|hash|download|limitação|status|formato/iu);
  }
});

test('rejects an accessor or revoked delivery receipt without invoking private data', async () => {
  const model = generatedModel(['html', 'json', 'csv', 'pdf']);
  const valid = await exportResult(model, {
    status: 'complete',
    formats: ['html', 'json', 'csv', 'pdf'].map((format, index) => receiptFormat(format, 'complete', index + 1)),
    limitations: [],
  });
  let accessed = false;
  const hostile = {};
  Object.defineProperty(hostile, 'formats', {
    enumerable: true,
    get() { accessed = true; return [{ private: 'PRIVATE_SENTINEL' }]; },
  });
  await assert.rejects(persistExportSuccess({
    auditId: model.auditId,
    result: { ...valid, deliveryReceipt: hostile },
    latest: {},
  }, { async commitAudit() {} }), /recibo|segur|propriedade|JSON/iu);
  assert.equal(accessed, false);

  const { proxy, revoke } = Proxy.revocable({ status: 'complete', formats: [], limitations: [] }, {});
  revoke();
  await assert.rejects(persistExportSuccess({
    auditId: model.auditId,
    result: { ...valid, deliveryReceipt: proxy },
    latest: {},
  }, { async commitAudit() {} }), TypeError);
});

test('rejects hostile outer request and result accessors before invoking them', async () => {
  const model = generatedModel(['html', 'json', 'csv', 'pdf']);
  const deliveryReceipt = {
    status: 'complete',
    formats: ['html', 'json', 'csv', 'pdf'].map((format, index) => receiptFormat(format, 'complete', index + 1)),
    limitations: [],
  };
  const valid = await exportResult(model, deliveryReceipt);
  let resultGetterAccessed = false;
  const hostileResult = { ...valid };
  Object.defineProperty(hostileResult, 'json', {
    enumerable: true,
    get() { resultGetterAccessed = true; return renderTechnicalJson(model); },
  });
  let committed = false;
  await assert.rejects(persistExportSuccess({ auditId: model.auditId, result: hostileResult, latest: {} }, {
    async commitAudit() { committed = true; },
  }), /resultado|propriedade|segur|recibo/iu);
  assert.equal(resultGetterAccessed, false);
  assert.equal(committed, false);

  let requestGetterAccessed = false;
  const hostileRequest = { auditId: model.auditId, latest: {} };
  Object.defineProperty(hostileRequest, 'result', {
    enumerable: true,
    get() { requestGetterAccessed = true; return valid; },
  });
  await assert.rejects(persistExportSuccess(hostileRequest, { async commitAudit() { committed = true; } }), /solicitação|resultado|propriedade|segur/iu);
  assert.equal(requestGetterAccessed, false);
  assert.equal(committed, false);

  const { proxy, revoke } = Proxy.revocable(valid, {});
  revoke();
  await assert.rejects(persistExportSuccess({ auditId: model.auditId, result: proxy, latest: {} }, { async commitAudit() {} }), TypeError);

  const activeProxy = new Proxy(valid, {});
  await assert.rejects(persistExportSuccess({ auditId: model.auditId, result: activeProxy, latest: {} }, { async commitAudit() {} }), /resultado|propriedade|segur|proxy/iu);
});

test('rejects a technical JSON incompatible with the final model before persistence', async () => {
  const model = generatedModel(['html', 'json', 'csv', 'pdf']);
  const receipt = {
    status: 'complete',
    formats: ['html', 'json', 'csv', 'pdf'].map((format, index) => receiptFormat(format, 'complete', index + 1)),
    limitations: [],
  };
  const technical = JSON.parse(renderTechnicalJson(model));
  technical.audit.report.status = 'forged';
  const result = { ...await exportResult(model, receipt), json: JSON.stringify(technical) };
  let committed = false;
  await assert.rejects(persistExportSuccess({
    auditId: model.auditId,
    result,
    latest: {},
  }, { async commitAudit() { committed = true; } }), /correla/iu);
  assert.equal(committed, false);
});

function receiptFormat(format, status, downloadId) {
  const mimeType = {
    html: 'text/html;charset=utf-8', json: 'application/json;charset=utf-8',
    csv: 'text/csv;charset=utf-8', pdf: 'application/pdf',
  }[format];
  return {
    format,
    filename: `audit.${format}`,
    mimeType,
    status,
    ...(downloadId === undefined ? {} : { downloadId }),
    sha256: 'a'.repeat(64),
  };
}

async function exportResult(model, deliveryReceipt, overrides = {}) {
  if (model.integrity?.algorithm === 'SHA-256') refreshDeclaredIntegrity(model);
  let renderModel = model;
  try { renderModel = await verifyAuditIntegritySnapshot(model); } catch {}
  const html = renderHtmlReport(renderModel);
  const json = renderTechnicalJson(renderModel);
  const prepared = renderModel.report.artifact.formats.map(entry => entry.format);
  const csv = prepared.includes('csv') ? renderOccurrenceCsv(renderModel) : null;
  const pdf = prepared.includes('pdf') ? Uint8Array.from(PDF) : null;
  const artifacts = { html, json, csv, pdf };
  const baseName = buildArtifactBaseName(renderModel.finalUrl, renderModel.timestamps.generatedAt);
  const normalizedFormats = deliveryReceipt.formats.map(entry => ({
    ...entry,
    ...(entry.filename === `audit.${entry.format}` ? { filename: `${baseName}.${entry.format}` } : {}),
    ...(entry.sha256 === 'a'.repeat(64) && artifacts[entry.format] !== null && artifacts[entry.format] !== undefined
      ? { sha256: artifactHash(artifacts[entry.format]) }
      : {}),
  }));
  const receipt = { ...deliveryReceipt, formats: normalizedFormats };
  const result = {
    model: structuredClone(renderModel),
    html,
    json,
    csv,
    pdf,
    formats: structuredClone(normalizedFormats),
    deliveryReceipt: receipt,
    limitations: [...new Set([...renderModel.report.artifact.limitations, ...receipt.limitations])],
    pdfFallback: renderModel.report.artifact.pdfFallback,
    ...overrides,
  };
  return attestReportExportResult(result);
}

function artifactHash(value) {
  return createHash('sha256').update(typeof value === 'string' ? new TextEncoder().encode(value) : value).digest('hex');
}

const REPORT_HASH_BASE =
  'SHA-256 do JSON canônico com integrity.canonicalModelHash omitido; evidenceManifestHash permanece incluído.';

function evidenceArtifactHash(artifact) {
  const content = structuredClone(artifact);
  delete content.hash;
  const prefix = 'data:image/png;base64,';
  const isPng = typeof content.dataUrl === 'string' && content.dataUrl.startsWith(prefix);
  const bytes = isPng ? Uint8Array.from(Buffer.from(content.dataUrl.slice(prefix.length), 'base64')) : null;
  if (bytes && content.kind === 'full-page') return artifactHash(bytes);
  if (bytes) {
    content.binarySha256 = artifactHash(bytes);
    delete content.dataUrl;
  }
  return artifactHash(canonicalStringify(content));
}

function evidenceManifest(model) {
  return model.evidence.map(artifact => ({
    evidenceId: artifact.evidenceId,
    pageId: artifact.pageId,
    kind: artifact.kind,
    nodeId: artifact.nodeId ?? null,
    hash: artifact.hash ?? null,
    fullPageEvidenceId: artifact.fullPageEvidenceId ?? null,
  }));
}

function refreshDeclaredIntegrity(model) {
  model.integrity = {
    algorithm: 'SHA-256',
    evidenceManifestHash: artifactHash(canonicalStringify(evidenceManifest(model))),
    hashBase: REPORT_HASH_BASE,
    canonicalModelHash: 'pending',
  };
  const hashInput = structuredClone(model);
  delete hashInput.integrity.canonicalModelHash;
  model.integrity.canonicalModelHash = artifactHash(canonicalStringify(hashInput));
  return model;
}

function refreshIntegrity(model) {
  for (const artifact of model.evidence) artifact.hash = evidenceArtifactHash(artifact);
  return refreshDeclaredIntegrity(model);
}

async function genuineReportExport() {
  let downloadId = 0;
  return runReportExport({
    auditModel: structuredClone(SAMPLE_AUDIT),
    now: () => '2026-08-26T16:00:00.000Z',
  }, {
    urlApi: {
      createObjectURL() { return 'blob:chrome-extension://test/print'; },
      revokeObjectURL() {},
    },
    tabAdapter: {
      async createPrintTab() { return { id: 77 }; },
      async waitForReady() {},
      async connectCdp() { return { async disconnect() {} }; },
      async waitForAssets() {},
      async removeTab() {},
    },
    async pdfRenderer() { return { bytes: Uint8Array.from(PDF), usedFallback: false, limitations: [] }; },
    downloadsAdapter: {
      createObjectURL() { return `blob:chrome-extension://test/download-${downloadId}`; },
      revokeObjectURL() {},
      async download() { downloadId += 1; return downloadId; },
      async waitForDownload(id) { return { id, state: 'complete' }; },
    },
  });
}

const GENERATION_MESSAGES = Object.freeze({
  REPORT_CSV_UNAVAILABLE: 'O CSV não foi gerado devido a uma limitação técnica local.',
  REPORT_PDF_UNAVAILABLE: 'O PDF não foi gerado devido a uma limitação técnica local.',
  REPORT_PRINT_ASSETS_TIMEOUT: 'A preparação local de fontes e imagens excedeu o tempo limite.',
  REPORT_PRINT_CLEANUP_LIMITED: 'A limpeza de um recurso temporário de impressão não pôde ser confirmada.',
  REPORT_PDF_TAGGING_UNSUPPORTED: 'O PDF foi gerado sem marcação estrutural adicional e sem outline porque o navegador não aceitou esses parâmetros.',
});

function generatedModel(formats, issueCodes = [], options = {}) {
  const model = structuredClone(SAMPLE_AUDIT);
  model.timestamps.generatedAt = '2026-08-26T16:00:00.000Z';
  for (const page of model.pages) page.timestamps.generatedAt = '2026-08-26T16:00:00.000Z';
  const messages = issueCodes.map(code => GENERATION_MESSAGES[code]);
  model.session.status = issueCodes.length ? 'partial' : 'complete';
  model.session.partial = issueCodes.length > 0;
  model.session.diagnostics = issueCodes.map(code => ({
    code,
    message: GENERATION_MESSAGES[code],
    at: '2026-08-26T16:00:00.000Z',
    recoverable: true,
  }));
  model.limitations = [...messages];
  model.report = {
    status: issueCodes.length ? 'partial' : 'complete',
    reviewUrl: null,
    artifact: {
      status: issueCodes.length ? 'partial' : 'complete',
      pdfFallback: false,
      limitations: options.artifactLimitations ?? messages,
      formats: formats.map(format => ({ format, status: 'prepared' })),
    },
  };
  return refreshIntegrity(model);
}
