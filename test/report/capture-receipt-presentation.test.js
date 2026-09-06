import assert from 'node:assert/strict';
import test from 'node:test';
import { SAMPLE_AUDIT } from '../../fixtures/audits/sample-audit.js';
import { createAuditModel, migrateAuditV1ToV2 } from '../../src/core/report/audit-model.js';
import { enrichAuditForReport } from '../../src/core/report/enrich-audit.js';
import { verifyAuditIntegritySnapshot } from '../../src/core/report/integrity.js';
import { renderTechnicalJson } from '../../src/core/report/earl-json.js';
import { renderHtmlReport } from '../../src/core/report/html.js';
import { projectTechnicalEvidence } from '../../src/review/report-view.js';
import { evidenceProvenanceRows } from '../../src/core/report/evidence-provenance.js';
import { applyBatchEvidenceBudget } from '../../src/core/batch/evidence-budget.js';
import { remapAuditPage } from '../../src/core/batch/remap-audit.js';
import { aggregateBatchAudits } from '../../src/core/batch/aggregate-audits.js';
import { reportInput } from './helpers.js';

const RECEIVED = '2026-08-26T14:00:30.000Z';
const OPTIONS = { now: () => '2026-08-26T16:00:00.000Z', timezone: 'America/Cuiaba',
  manifestVersion: '1.1.4', rulesVersion: '1.0.0', browserVersion: 'Chrome/152.0.0.0' };

function withReceipt(value = RECEIVED) {
  const input = structuredClone(SAMPLE_AUDIT);
  input.evidence[0].metadata.captureReceivedAt = value;
  return input;
}

test('preserves receipt time through V1 migration and V2 while leaving old evidence untouched', () => {
  const legacy = reportInput();
  legacy.evidence.artifacts[0].metadata.captureReceivedAt = RECEIVED;
  assert.equal(migrateAuditV1ToV2(legacy).evidence[0].metadata.captureReceivedAt, RECEIVED);
  assert.equal(createAuditModel(withReceipt()).evidence[0].metadata.captureReceivedAt, RECEIVED);
  assert.deepEqual(createAuditModel(SAMPLE_AUDIT).evidence, SAMPLE_AUDIT.evidence);
});

test('rejects noncanonical receipt values and accessors without echoing or invoking them', () => {
  for (const value of [null, 1, {}, new Date(RECEIVED), '2026-02-30T14:00:30.000Z',
    '2026-08-26T14:00:30Z', '2026-08-26T10:00:30.000-04:00', ` ${RECEIVED}`, 'PRIVATE_TIME_MARKER']) {
    assert.throws(() => createAuditModel(withReceipt(value)), error => {
      assert.doesNotMatch(error.message, /PRIVATE_TIME_MARKER/);
      return true;
    });
  }
  const accessor = withReceipt(); let calls = 0;
  Object.defineProperty(accessor.evidence[0].metadata, 'captureReceivedAt', {
    enumerable: true, get() { calls++; return RECEIVED; },
  });
  assert.throws(() => createAuditModel(accessor));
  assert.equal(calls, 0);
});

test('rejects a receipt claim on a structural artifact without raster', () => {
  const input = withReceipt();
  delete input.evidence[0].dataUrl;
  assert.throws(() => createAuditModel(input));
});

test('budget omission retains the recorded receipt without inventing a new capture', async () => {
  const model = await enrichAuditForReport(withReceipt(), OPTIONS);
  const remapped = await remapAuditPage(model, { batchAuditId: 'receipt-batch', pageId: 'page-1' });
  const budget = await applyBatchEvidenceBudget(remapped, { limitBytes: 0 });
  const canonical = createAuditModel(aggregateBatchAudits({ batchAuditId: 'receipt-batch',
    pageResults: [budget.result], status: 'partial',
    startedAt: model.timestamps.startedAt, endedAt: model.timestamps.generatedAt }));
  assert.equal(canonical.evidence[0].dataUrl, undefined);
  assert.equal(canonical.evidence[0].pixelState, 'omitted-budget');
  assert.equal(canonical.evidence[0].metadata.captureReceivedAt, RECEIVED);
});

test('binds receipt metadata to canonical integrity while keeping the full-page PNG byte hash unchanged', async () => {
  const old = await enrichAuditForReport(SAMPLE_AUDIT, OPTIONS);
  const current = await enrichAuditForReport(withReceipt(), OPTIONS);
  assert.equal(current.evidence[0].hash, old.evidence[0].hash);
  assert.notEqual(current.integrity.canonicalModelHash, old.integrity.canonicalModelHash);
  await verifyAuditIntegritySnapshot(current);
  for (const value of ['2026-08-26T14:00:31.000Z', undefined]) {
    const changed = structuredClone(current);
    if (value === undefined) delete changed.evidence[0].metadata.captureReceivedAt;
    else changed.evidence[0].metadata.captureReceivedAt = value;
    await assert.rejects(verifyAuditIntegritySnapshot(changed));
  }
});

test('exports the exact receipt to JSON and shared live/HTML evidence presentation with its clock limitation', async () => {
  const model = await enrichAuditForReport(withReceipt(), OPTIONS);
  const technical = JSON.parse(renderTechnicalJson(model));
  assert.equal(technical.audit.evidence[0].metadata.captureReceivedAt, RECEIVED);
  const evidence = projectTechnicalEvidence(model).find(item => item.evidenceId === 'ev-full');
  assert.equal(evidence.provenance.captureReceivedAt, RECEIVED);
  const rows = evidenceProvenanceRows(evidence);
  assert.ok(rows.some(([label, value]) => /recebida/u.test(label) && value.includes(RECEIVED) && /não certificado/u.test(value)));
  const html = renderHtmlReport(model);
  assert.match(html, /Captura recebida pela extensão \(UTC\)/u);
  assert.match(html, /2026-08-26T14:00:30\.000Z/u);
  assert.match(html, /relógio local; não certificado/u);
  assert.match(html, /Instante individual da captura/u, 'the untimestamped second artifact stays explicit');
});
