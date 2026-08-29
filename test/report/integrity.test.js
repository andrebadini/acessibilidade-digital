import assert from 'node:assert/strict';
import test from 'node:test';

import { SAMPLE_AUDIT } from '../../fixtures/audits/sample-audit.js';
import { canonicalStringify } from '../../src/core/report/canonical-json.js';
import { createAuditModel } from '../../src/core/report/audit-model.js';
import { enrichAuditForReport } from '../../src/core/report/enrich-audit.js';
import { renderTechnicalJson } from '../../src/core/report/earl-json.js';
import { sha256Hex } from '../../src/core/report/hash.js';
import { renderHtmlReport } from '../../src/core/report/html.js';
import {
  isAuditIntegrityVerified,
  REPORT_HASH_BASE,
  verifyAuditIntegritySnapshot,
} from '../../src/core/report/integrity.js';

const ENRICH_OPTIONS = Object.freeze({
  now: () => '2026-08-26T16:00:00.000Z',
  timezone: 'America/Cuiaba',
  manifestVersion: '0.1.0',
  rulesVersion: '1.0.0',
  browserVersion: 'Chrome/147.0.0.0',
});

test('attests only an immutable snapshot whose complete integrity chain recomputes', async () => {
  const model = await verifiedFixture();
  const input = structuredClone(model);

  const verified = await verifyAuditIntegritySnapshot(input);

  assert.equal(isAuditIntegrityVerified(input), false);
  assert.equal(isAuditIntegrityVerified(verified), true);
  assert.equal(Object.isFrozen(verified), true);
  assert.deepEqual(verified, input);
  assert.deepEqual(input, structuredClone(model));
});

test('rejects manifest and canonical claims independently even when the other link is recomputed', async () => {
  const source = await verifiedFixture();
  const forgedManifest = structuredClone(source);
  forgedManifest.integrity.evidenceManifestHash = 'd'.repeat(64);
  const manifestHashInput = structuredClone(forgedManifest);
  delete manifestHashInput.integrity.canonicalModelHash;
  forgedManifest.integrity.canonicalModelHash = await sha256Hex(canonicalStringify(manifestHashInput));

  await assert.rejects(verifyAuditIntegritySnapshot(forgedManifest), /integridade|indisponível/iu);

  const forgedCanonical = structuredClone(source);
  forgedCanonical.integrity.canonicalModelHash = 'e'.repeat(64);
  await assert.rejects(verifyAuditIntegritySnapshot(forgedCanonical), /integridade|indisponível/iu);
});

test('never attests unavailable V1 integrity as a final V2 export snapshot', async () => {
  const input = structuredClone(await verifiedFixture());
  input.integrity = { algorithm: 'unavailable', status: 'not-recorded-v1' };

  await assert.rejects(verifyAuditIntegritySnapshot(input), /integridade|indisponível/iu);
  assert.equal(isAuditIntegrityVerified(input), false);
});

test('rejects historical V2 even when its obsolete shape is internally rehashed', async () => {
  const current = await verifiedFixture();
  const legacy = structuredClone(current);
  for (const occurrence of legacy.occurrences) {
    delete occurrence.itemWcagRefs;
    delete occurrence.sourceWcagRefs;
    delete occurrence.testedWcagRefs;
  }
  delete legacy.normative.sources;
  await rehashCanonicalModel(legacy);

  assert.throws(() => createAuditModel(legacy), /modelo|integridade|WCAG/iu);
  assert.throws(() => renderHtmlReport(legacy), /modelo|integridade|WCAG/iu);
  assert.throws(() => renderTechnicalJson(legacy), /modelo|integridade|WCAG/iu);
  await assert.rejects(enrichAuditForReport(legacy, ENRICH_OPTIONS), /modelo|integridade|WCAG/iu);
  await assert.rejects(verifyAuditIntegritySnapshot(legacy), /modelo|integridade|WCAG/iu);

  const auditModelModule = await import('../../src/core/report/audit-model.js');
  assert.equal(Object.hasOwn(auditModelModule, 'verifyAndMigrateLegacyAuditV2'), false);
  assert.equal(Object.hasOwn(auditModelModule, 'createAuditModelFromVerifiedLegacyLineage'), false);
});

test('the public model constructor rejects every raw legacy V2 occurrence before any migration', async () => {
  const current = await verifiedFixture();
  const legacy = structuredClone(current);
  for (const occurrence of legacy.occurrences) {
    delete occurrence.itemWcagRefs;
    delete occurrence.sourceWcagRefs;
    delete occurrence.testedWcagRefs;
  }

  for (const integrity of [
    { algorithm: 'SHA-256', evidenceManifestHash: 'pending', canonicalModelHash: 'pending', hashBase: REPORT_HASH_BASE },
    { algorithm: 'unavailable', status: 'not-recorded-v1' },
    { ...legacy.integrity, canonicalModelHash: 'a'.repeat(64) },
  ]) {
    const candidate = structuredClone(legacy);
    candidate.integrity = integrity;
    assert.throws(
      () => createAuditModel(candidate),
      /V2 legad|migra|separa[cç][aã]o normativa|integridade/iu,
    );
  }

  const auditModelModule = await import('../../src/core/report/audit-model.js');
  assert.equal(Object.hasOwn(auditModelModule, 'migrateAuditV2AfterIntegrityVerification'), false);
  assert.equal(Object.hasOwn(auditModelModule, 'createAuditModelFromVerifiedLegacyLineage'), false);
});

test('enrichment rejects every legacy V2 integrity variant without repairing it', async () => {
  const current = await verifiedFixture();
  const legacy = structuredClone(current);
  for (const occurrence of legacy.occurrences) {
    delete occurrence.itemWcagRefs;
    delete occurrence.sourceWcagRefs;
    delete occurrence.testedWcagRefs;
  }
  delete legacy.normative.sources;
  const oldHashInput = structuredClone(legacy);
  delete oldHashInput.integrity.canonicalModelHash;
  legacy.integrity.canonicalModelHash = await sha256Hex(canonicalStringify(oldHashInput));

  await assert.rejects(enrichAuditForReport(legacy, ENRICH_OPTIONS), /modelo|integridade|WCAG/iu);

  const staleCanonical = structuredClone(legacy);
  staleCanonical.timestamps.generatedAt = '2026-08-26T16:00:01.000Z';
  await assert.rejects(enrichAuditForReport(staleCanonical, ENRICH_OPTIONS), /modelo|integridade|WCAG/iu);

  const unavailable = structuredClone(legacy);
  unavailable.integrity = { algorithm: 'unavailable', status: 'not-recorded-v1' };
  await assert.rejects(enrichAuditForReport(unavailable, ENRICH_OPTIONS), /modelo|integridade|WCAG/iu);

  const missing = structuredClone(legacy);
  delete missing.integrity;
  await assert.rejects(enrichAuditForReport(missing, ENRICH_OPTIONS), /modelo|integridade|WCAG/iu);

  const forgedEvidence = structuredClone(legacy);
  forgedEvidence.evidence[0].dataUrl =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';
  const forgedHashInput = structuredClone(forgedEvidence);
  delete forgedHashInput.integrity.canonicalModelHash;
  forgedEvidence.integrity.canonicalModelHash = await sha256Hex(canonicalStringify(forgedHashInput));
  await assert.rejects(enrichAuditForReport(forgedEvidence, ENRICH_OPTIONS), /modelo|integridade|WCAG/iu);
});

async function verifiedFixture() {
  return enrichAuditForReport(SAMPLE_AUDIT, ENRICH_OPTIONS);
}

async function rehashCanonicalModel(model) {
  const hashInput = structuredClone(model);
  delete hashInput.integrity.canonicalModelHash;
  model.integrity.canonicalModelHash = await sha256Hex(canonicalStringify(hashInput));
}
