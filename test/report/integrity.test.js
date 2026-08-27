import assert from 'node:assert/strict';
import test from 'node:test';

import { SAMPLE_AUDIT } from '../../fixtures/audits/sample-audit.js';
import { canonicalStringify } from '../../src/core/report/canonical-json.js';
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

async function verifiedFixture() {
  return enrichAuditForReport(SAMPLE_AUDIT, {
    now: () => '2026-08-26T16:00:00.000Z',
    timezone: 'America/Cuiaba',
    manifestVersion: '0.1.0',
    rulesVersion: '1.0.0',
    browserVersion: 'Chrome/147.0.0.0',
  });
}
