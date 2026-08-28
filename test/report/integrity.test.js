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

test('validates a legacy V2 integrity chain before conservative normative migration and re-attestation', async () => {
  const current = await verifiedFixture();
  const legacy = structuredClone(current);
  const legacyId = legacy.occurrences[0].occurrenceId;
  for (const occurrence of legacy.occurrences) {
    delete occurrence.itemWcagRefs;
    delete occurrence.sourceWcagRefs;
    delete occurrence.testedWcagRefs;
  }
  delete legacy.normative.sources;
  const hashInput = structuredClone(legacy);
  delete hashInput.integrity.canonicalModelHash;
  legacy.integrity.canonicalModelHash = await sha256Hex(canonicalStringify(hashInput));

  assert.throws(() => createAuditModel(legacy), /integridade.*antes.*migra|migra.*integridade/iu);
  const migrated = await verifyAuditIntegritySnapshot(legacy);
  assert.equal(migrated.occurrences[0].occurrenceId, legacyId);
  assert.deepEqual(migrated.occurrences[0].testedWcagRefs, []);
  assert.deepEqual(migrated.occurrences[0].wcagRefs, []);
  assert.deepEqual(migrated.occurrences[0].foreignBenchmarkRefs, []);
  assert.equal(migrated.normative.sources[0].localCopy.sha256, '1c3ee66b7fd606367e3de087e6a55fea90f4d368d8a1f769141d5e3b96d32afc');
  assert.match(migrated.limitations.join(' '), /proveniência legada|critérios WCAG testados/iu);
  assert.notEqual(migrated.integrity.canonicalModelHash, legacy.integrity.canonicalModelHash);
  assert.equal(isAuditIntegrityVerified(migrated), true);

  const detachedMigrationClaim = structuredClone(migrated);
  assert.throws(() => createAuditModel(detachedMigrationClaim), /migra|integridade|linhagem|prova/iu);
  assert.throws(() => renderHtmlReport(detachedMigrationClaim), /migra|integridade|linhagem|prova/iu);
  assert.throws(() => renderTechnicalJson(detachedMigrationClaim), /migra|integridade|linhagem|prova/iu);
  await assert.rejects(enrichAuditForReport(detachedMigrationClaim, ENRICH_OPTIONS), /migra|integridade|linhagem|prova/iu);
  await assert.rejects(
    verifyAuditIntegritySnapshot(detachedMigrationClaim),
    /integridade|indisponível/iu,
  );
});

test('legacy migration returns one exact renderable snapshot and exposes no derivation capability', async () => {
  const current = await verifiedFixture();
  const legacy = structuredClone(current);
  for (const occurrence of legacy.occurrences) {
    delete occurrence.itemWcagRefs;
    delete occurrence.sourceWcagRefs;
    delete occurrence.testedWcagRefs;
  }
  delete legacy.normative.sources;
  await rehashCanonicalModel(legacy);

  const migrated = await verifyAuditIntegritySnapshot(legacy);
  assert.match(renderHtmlReport(migrated), /Relatório de auditoria/iu);
  assert.equal(JSON.parse(renderTechnicalJson(migrated)).audit.auditId, migrated.auditId);

  const auditModelModule = await import('../../src/core/report/audit-model.js');
  const derivationCapability = auditModelModule.createAuditModelFromVerifiedLegacyLineage;
  if (typeof derivationCapability === 'function') {
    const forged = structuredClone(migrated);
    forged.scope.description = 'Escopo alterado depois da prova RAW.';
    forged.limitations.push('Limitação adicionada depois da prova RAW.');
    forged.report.status = 'pending';
    await rehashCanonicalModel(forged);
    const laundered = derivationCapability(forged, migrated);
    await assert.rejects(verifyAuditIntegritySnapshot(laundered), /integridade|linhagem|migra/iu);
  }
  assert.equal(derivationCapability, undefined);

  for (const mutate of [
    value => { value.scope.description = 'Escopo alterado depois da prova RAW.'; },
    value => { value.limitations.push('Limitação adicionada depois da prova RAW.'); },
    value => { value.report.status = 'pending'; },
  ]) {
    const detached = structuredClone(migrated);
    mutate(detached);
    await rehashCanonicalModel(detached);
    assert.throws(() => createAuditModel(detached), /migra|integridade|WCAG|linhagem/iu);
    assert.throws(() => renderHtmlReport(detached), /migra|integridade|WCAG|linhagem/iu);
    assert.throws(() => renderTechnicalJson(detached), /migra|integridade|WCAG|linhagem/iu);
    await assert.rejects(enrichAuditForReport(detached, ENRICH_OPTIONS), /migra|integridade|WCAG|linhagem/iu);
    await assert.rejects(verifyAuditIntegritySnapshot(detached), /integridade|indisponível/iu);
  }
});

test('legacy lineage remains process-local when migrated fields equal ordinary empty coverage', async () => {
  const current = await verifiedFixture();
  const legacy = structuredClone(current);
  const manual = legacy.occurrences.find(occurrence => occurrence.source.engine === 'audita-manual-review');
  delete manual.itemWcagRefs;
  delete manual.sourceWcagRefs;
  delete manual.testedWcagRefs;
  await rehashCanonicalModel(legacy);

  const migrated = await verifyAuditIntegritySnapshot(legacy);
  const detached = structuredClone(migrated);
  detached.scope.description = 'Escopo alterado após migração de cobertura originalmente vazia.';
  await rehashCanonicalModel(detached);

  assert.throws(() => createAuditModel(detached), /migra|integridade|linhagem|prova/iu);
  assert.throws(() => renderHtmlReport(detached), /migra|integridade|linhagem|prova/iu);
  assert.throws(() => renderTechnicalJson(detached), /migra|integridade|linhagem|prova/iu);
  await assert.rejects(enrichAuditForReport(detached, ENRICH_OPTIONS), /migra|integridade|linhagem|prova/iu);
  await assert.rejects(verifyAuditIntegritySnapshot(detached), /integridade|indisponível/iu);
});

test('legacy enrichment is exactly the verified migration and ignores post-proof options', async () => {
  const current = await verifiedFixture();
  const legacy = structuredClone(current);
  for (const occurrence of legacy.occurrences) {
    delete occurrence.itemWcagRefs;
    delete occurrence.sourceWcagRefs;
    delete occurrence.testedWcagRefs;
  }
  delete legacy.normative.sources;
  await rehashCanonicalModel(legacy);

  const direct = await verifyAuditIntegritySnapshot(legacy);
  const enriched = await enrichAuditForReport(legacy, {
    ...ENRICH_OPTIONS,
    now: () => '2030-01-01T00:00:00.000Z',
    timezone: 'UTC',
    manifestVersion: '9.9.9',
    browserVersion: 'Chrome/999.0.0.0',
  });
  assert.deepEqual(enriched, direct);
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

test('enrichment verifies the untouched legacy V2 chain before migration and rejects laundering attempts', async () => {
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

  const migrated = await enrichAuditForReport(legacy, ENRICH_OPTIONS);
  assert.deepEqual(migrated.occurrences[0].sourceWcagRefs, []);
  assert.deepEqual(migrated.occurrences[0].testedWcagRefs, []);
  assert.match(migrated.limitations.join(' '), /proveniência legada|critérios WCAG testados/iu);

  const staleCanonical = structuredClone(legacy);
  staleCanonical.timestamps.generatedAt = '2026-08-26T16:00:01.000Z';
  await assert.rejects(enrichAuditForReport(staleCanonical, ENRICH_OPTIONS), /integridade|indisponível/iu);

  const unavailable = structuredClone(legacy);
  unavailable.integrity = { algorithm: 'unavailable', status: 'not-recorded-v1' };
  await assert.rejects(enrichAuditForReport(unavailable, ENRICH_OPTIONS), /integridade|indisponível/iu);

  const missing = structuredClone(legacy);
  delete missing.integrity;
  await assert.rejects(enrichAuditForReport(missing, ENRICH_OPTIONS), /integridade|indisponível/iu);

  const forgedEvidence = structuredClone(legacy);
  forgedEvidence.evidence[0].dataUrl =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';
  const forgedHashInput = structuredClone(forgedEvidence);
  delete forgedHashInput.integrity.canonicalModelHash;
  forgedEvidence.integrity.canonicalModelHash = await sha256Hex(canonicalStringify(forgedHashInput));
  await assert.rejects(enrichAuditForReport(forgedEvidence, ENRICH_OPTIONS), /integridade|indisponível/iu);
});

async function verifiedFixture() {
  return enrichAuditForReport(SAMPLE_AUDIT, ENRICH_OPTIONS);
}

async function rehashCanonicalModel(model) {
  const hashInput = structuredClone(model);
  delete hashInput.integrity.canonicalModelHash;
  model.integrity.canonicalModelHash = await sha256Hex(canonicalStringify(hashInput));
}
