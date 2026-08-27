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
  const receipt = { status: 'partial', formats: [{ format: 'html', status: 'complete' }, { format: 'json', status: 'timeout' }], limitations: ['O artefato JSON excedeu o tempo limite de download.'] };
  const result = { model: SAMPLE_AUDIT, json: renderTechnicalJson(SAMPLE_AUDIT), deliveryReceipt: receipt };
  const persisted = await persistExportSuccess({ auditId: SAMPLE_AUDIT.auditId, result, latest: { auditId: SAMPLE_AUDIT.auditId, status: 'partial' } }, { async commitAudit(...values) { commits.push(values); } });
  assert.equal(commits.length, 1);
  assert.deepEqual(commits[0][1], JSON.parse(result.json).audit);
  assert.deepEqual(commits[0][2].deliveryReceipt, receipt);
  assert.equal(persisted.latest.exportStatus, 'partial');
  assert.equal(Object.hasOwn(commits[0][1].report.artifact, 'deliveryReceipt'), false);
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
