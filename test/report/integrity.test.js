import assert from 'node:assert/strict';
import test from 'node:test';

import { SAMPLE_AUDIT } from '../../fixtures/audits/sample-audit.js';
import { canonicalStringify } from '../../src/core/report/canonical-json.js';
import { createAuditModel } from '../../src/core/report/audit-model.js';
import { enrichAuditForReport } from '../../src/core/report/enrich-audit.js';
import { sha256Hex } from '../../src/core/report/hash.js';
import {
  isAuditIntegrityVerified,
  verifyAuditIntegritySnapshot,
} from '../../src/core/report/integrity.js';

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
});

async function verifiedFixture() {
  return enrichAuditForReport(SAMPLE_AUDIT, {
    now: () => '2026-08-26T16:00:00.000Z',
    timezone: 'America/Cuiaba',
    manifestVersion: '0.1.0',
    rulesVersion: '1.0.0',
    browserVersion: 'Chrome/147.0.0.0',
  });
}
