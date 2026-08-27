import assert from 'node:assert/strict';
import test from 'node:test';

import { SAMPLE_AUDIT } from '../../fixtures/audits/sample-audit.js';
import { renderTechnicalJson } from '../../src/core/report/earl-json.js';
import { persistExportFailure, persistExportSuccess } from '../../src/export/export-controller.js';

test('atomically commits a controlled partial model and latest state for pre-result failure', async () => {
  const commits = [];
  const store = { async commitAudit(...values) { commits.push(values); } };
  const model = structuredClone(SAMPLE_AUDIT);
  model.limitations.push('TOPSECRET https://origin.test/?token=x blob:chrome-extension://test/private');
  const result = await persistExportFailure({
    auditId: SAMPLE_AUDIT.auditId,
    model,
    latest: { auditId: SAMPLE_AUDIT.auditId, status: 'partial', exportStatus: 'running' },
    now: () => '2026-08-26T16:00:00.000Z',
    cause: new Error('TOPSECRET https://origin.test/?token=x blob:chrome-extension://test/private'),
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
  await assert.rejects(persistExportFailure({ auditId: 'audit-other', model: structuredClone(SAMPLE_AUDIT), latest: {}, now: () => '2026-08-26T16:00:00.000Z' }, { async commitAudit() { committed = true; } }), /correla|auditId|auditoria/iu);
  assert.equal(committed, false);
});

test('atomically persists the exact serialized model and a separate delivery receipt', async () => {
  const commits = [];
  const model = structuredClone(SAMPLE_AUDIT);
  model.report.artifact.formats = ['html', 'json', 'csv', 'pdf'].map(format => ({ format, status: 'prepared' }));
  const receipt = {
    status: 'partial',
    formats: [
      receiptFormat('html', 'complete', 1), receiptFormat('json', 'complete', 2),
      receiptFormat('csv', 'timeout'), receiptFormat('pdf', 'complete', 4),
    ],
    limitations: ['O artefato CSV excedeu o tempo limite de download.'],
  };
  const result = { model, json: renderTechnicalJson(model), deliveryReceipt: receipt };
  const persisted = await persistExportSuccess({ auditId: SAMPLE_AUDIT.auditId, result, latest: { auditId: SAMPLE_AUDIT.auditId, status: 'partial' } }, { async commitAudit(...values) { commits.push(values); } });
  assert.equal(commits.length, 1);
  assert.deepEqual(commits[0][1], JSON.parse(result.json).audit);
  assert.deepEqual(commits[0][2].deliveryReceipt, receipt);
  assert.equal(persisted.latest.exportStatus, 'partial');
  assert.equal(Object.hasOwn(commits[0][1].report.artifact, 'deliveryReceipt'), false);
});

test('requires correlated ordered unique receipt formats with exact MIME, filename, hash and status semantics', async () => {
  const model = structuredClone(SAMPLE_AUDIT);
  model.report.artifact.formats = ['html', 'json', 'csv', 'pdf'].map(format => ({ format, status: 'prepared' }));
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
    { ...baseReceipt, formats: [baseReceipt.formats[1], baseReceipt.formats[0], ...baseReceipt.formats.slice(2)] },
    { ...baseReceipt, status: 'partial' },
  ];
  for (const deliveryReceipt of attempts) {
    let committed = false;
    await assert.rejects(persistExportSuccess({
      auditId: model.auditId,
      result: { model, json: renderTechnicalJson(model), deliveryReceipt },
      latest: {},
    }, { async commitAudit() { committed = true; } }), /recibo|formato|MIME|arquivo|hash|ordem|status|correla/iu);
    assert.equal(committed, false);
  }
});

test('rejects an accessor or revoked delivery receipt without invoking private data', async () => {
  const model = structuredClone(SAMPLE_AUDIT);
  model.report.artifact.formats = ['html', 'json', 'csv'].map(format => ({ format, status: 'prepared' }));
  let accessed = false;
  const hostile = {};
  Object.defineProperty(hostile, 'formats', {
    enumerable: true,
    get() { accessed = true; return [{ private: 'PRIVATE_SENTINEL' }]; },
  });
  await assert.rejects(persistExportSuccess({
    auditId: model.auditId,
    result: { model, json: renderTechnicalJson(model), deliveryReceipt: hostile },
    latest: {},
  }, { async commitAudit() {} }), /recibo|segur|propriedade|JSON/iu);
  assert.equal(accessed, false);

  const { proxy, revoke } = Proxy.revocable({ status: 'complete', formats: [], limitations: [] }, {});
  revoke();
  await assert.rejects(persistExportSuccess({
    auditId: model.auditId,
    result: { model, json: renderTechnicalJson(model), deliveryReceipt: proxy },
    latest: {},
  }, { async commitAudit() {} }), TypeError);
});

test('rejects a technical JSON incompatible with the final model before persistence', async () => {
  const technical = JSON.parse(renderTechnicalJson(SAMPLE_AUDIT));
  technical.audit.report.status = 'forged';
  let committed = false;
  await assert.rejects(persistExportSuccess({
    auditId: SAMPLE_AUDIT.auditId,
    result: { model: SAMPLE_AUDIT, json: JSON.stringify(technical), deliveryReceipt: { status: 'complete', formats: [], limitations: [] } },
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
