import assert from 'node:assert/strict';
import test from 'node:test';

import { SAMPLE_AUDIT } from '../../fixtures/audits/sample-audit.js';
import { hashEvidenceArtifact, hashEvidenceArtifactDetailed } from '../../src/core/evidence/artifact-hash.js';
import { decodePngDataUrl } from '../../src/core/evidence/png.js';
import { createAuditModel } from '../../src/core/report/audit-model.js';
import { canonicalStringify } from '../../src/core/report/canonical-json.js';
import { enrichAuditForReport } from '../../src/core/report/enrich-audit.js';
import { sha256Hex } from '../../src/core/report/hash.js';
import { verifyAuditIntegritySnapshot } from '../../src/core/report/integrity.js';

const ENRICH_OPTIONS = Object.freeze({
  now: () => '2026-08-26T16:00:00.000Z',
  timezone: 'America/Cuiaba',
  manifestVersion: '0.1.0',
  rulesVersion: '1.0.0',
  browserVersion: 'Chrome/147.0.0.0',
});

// O SHA-256 do arquivo de imagem é gravado na captura (`run-audit.js`) para o anexo do relatório
// entregue poder mostrá-lo. Estes testes fixam o contrato: o campo novo não muda nenhum hash já
// guardado, auditorias antigas continuam válidas sem ele, e um valor trocado no armazenamento local é
// recusado pela verificação de integridade em vez de virar uma afirmação falsa no relatório.
const ELEMENT_PNG = SAMPLE_AUDIT.evidence.find(artifact => artifact.kind === 'element').dataUrl;

async function pngSha256(dataUrl) {
  return sha256Hex(decodePngDataUrl(dataUrl).bytes);
}

function rawWithBinary(hash) {
  const raw = structuredClone(SAMPLE_AUDIT);
  raw.evidence.find(artifact => artifact.kind === 'element').binarySha256 = hash;
  return raw;
}

async function resign(model) {
  const next = structuredClone(model);
  const hashInput = structuredClone(next);
  delete hashInput.integrity.canonicalModelHash;
  next.integrity.canonicalModelHash = await sha256Hex(canonicalStringify(hashInput));
  return next;
}

test('o hash do arquivo é o SHA-256 dos próprios bytes guardados', async () => {
  const element = SAMPLE_AUDIT.evidence.find(artifact => artifact.kind === 'element');
  const detailed = await hashEvidenceArtifactDetailed(element);
  assert.equal(detailed.binarySha256, await pngSha256(ELEMENT_PNG));
  // O digest do registro já compromete o hash do arquivo: ele entra no JSON canônico hasheado.
  assert.equal(detailed.hash, await hashEvidenceArtifact(element));
  // A captura integral não tem hash de arquivo separado: o digest do registro já é o hash dos pixels.
  const fullPage = { kind: 'full-page', dataUrl: ELEMENT_PNG };
  assert.equal((await hashEvidenceArtifactDetailed(fullPage)).binarySha256, null);
  assert.equal((await hashEvidenceArtifactDetailed(fullPage)).hash, await pngSha256(ELEMENT_PNG));
});

test('gravar o hash do arquivo não muda nenhum hash já calculado', async () => {
  const without = await enrichAuditForReport(structuredClone(SAMPLE_AUDIT), ENRICH_OPTIONS);
  const withBinary = await enrichAuditForReport(rawWithBinary(await pngSha256(ELEMENT_PNG)), ENRICH_OPTIONS);
  assert.deepEqual(
    withBinary.evidence.map(artifact => artifact.hash),
    without.evidence.map(artifact => artifact.hash),
    'os hashes das evidências continuam idênticos',
  );
  assert.equal(withBinary.integrity.evidenceManifestHash, without.integrity.evidenceManifestHash);
  // O hash do modelo cobre o campo novo (ele faz parte do modelo canônico) e por isso difere entre os
  // dois; o que não pode mudar — e não muda — é o hash de cada evidência e o manifesto, que é o que
  // correlaciona uma auditoria já guardada com os artefatos que ela registrou.
  assert.notEqual(withBinary.integrity.canonicalModelHash, without.integrity.canonicalModelHash);
  assert.equal((await verifyAuditIntegritySnapshot(structuredClone(withBinary))).integrity.canonicalModelHash,
    withBinary.integrity.canonicalModelHash);
  assert.equal(withBinary.evidence.find(artifact => artifact.kind === 'element').binarySha256, await pngSha256(ELEMENT_PNG));
  assert.equal(without.evidence.find(artifact => artifact.kind === 'element').binarySha256, undefined);
});

test('o campo é aceito no esquema fechado e a verificação de integridade o confere', async () => {
  const model = await enrichAuditForReport(rawWithBinary(await pngSha256(ELEMENT_PNG)), ENRICH_OPTIONS);
  const verified = await verifyAuditIntegritySnapshot(structuredClone(model));
  assert.equal(verified.evidence.find(artifact => artifact.kind === 'element').binarySha256, await pngSha256(ELEMENT_PNG));

  const tampered = await resign({ ...model, evidence: model.evidence.map(artifact =>
    artifact.kind === 'element' ? { ...artifact, binarySha256: 'f'.repeat(64) } : artifact) });
  // O hash do modelo é refeito para isolar a conferência do hash do arquivo.
  await assert.rejects(() => verifyAuditIntegritySnapshot(tampered), 'hash de arquivo trocado é recusado');
});

test('o esquema recusa hash de arquivo malformado ou sem os pixels a que ele se refere', async () => {
  const model = await enrichAuditForReport(rawWithBinary(await pngSha256(ELEMENT_PNG)), ENRICH_OPTIONS);
  const element = model.evidence.find(artifact => artifact.kind === 'element');
  assert.throws(() => createAuditModel({ ...model, evidence: model.evidence.map(artifact =>
    artifact === element ? { ...artifact, binarySha256: 'nao-e-hash' } : artifact) }));
  const withoutPixels = { ...element };
  delete withoutPixels.dataUrl;
  assert.throws(() => createAuditModel({ ...model, evidence: model.evidence.map(artifact =>
    artifact === element ? withoutPixels : artifact) }));
  // O mesmo artefato sem o campo continua aceito: é o formato das auditorias anteriores à 1.1.62.
  const legacyShape = { ...element };
  delete legacyShape.binarySha256;
  assert.doesNotThrow(() => createAuditModel({ ...model, evidence: model.evidence.map(artifact =>
    artifact === element ? legacyShape : artifact) }));
});
