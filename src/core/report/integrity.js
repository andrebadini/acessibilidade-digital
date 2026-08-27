import { hashEvidenceArtifact } from '../evidence/artifact-hash.js';
import { createAuditModel } from './audit-model.js';
import { canonicalStringify } from './canonical-json.js';
import { sha256Hex } from './hash.js';

export const REPORT_HASH_BASE =
  'SHA-256 do JSON canônico com integrity.canonicalModelHash omitido; evidenceManifestHash permanece incluído.';

const SHA256 = /^[a-f0-9]{64}$/u;
const VERIFIED_SNAPSHOTS = new WeakSet();

export function isAuditIntegrityVerified(value) {
  return Boolean(value && typeof value === 'object' && VERIFIED_SNAPSHOTS.has(value));
}

/** The sole canonical evidence-manifest projection used by generation and verification. */
export function projectEvidenceManifest(evidence) {
  if (!Array.isArray(evidence)) throw new TypeError('Lista de evidências inválida.');
  return evidence.map(artifact => ({
    evidenceId: artifact.evidenceId,
    pageId: artifact.pageId,
    kind: artifact.kind,
    nodeId: artifact.nodeId ?? null,
    hash: artifact.hash ?? null,
    fullPageEvidenceId: artifact.fullPageEvidenceId ?? null,
  }));
}

/**
 * Returns an immutable canonical snapshot only after recomputing every integrity
 * link from the evidence content. Callers must use only the returned snapshot.
 */
export async function verifyAuditIntegritySnapshot(input) {
  try {
    const model = createAuditModel(input);
    if (model.integrity.algorithm === 'unavailable') {
      throw new TypeError('Integridade indisponível.');
    }
    if (model.integrity.algorithm !== 'SHA-256' || model.integrity.hashBase !== REPORT_HASH_BASE ||
      !SHA256.test(model.integrity.canonicalModelHash) || !SHA256.test(model.integrity.evidenceManifestHash)) {
      throw new TypeError('Metadados de integridade inválidos.');
    }
    for (const artifact of model.evidence) {
      if (!SHA256.test(artifact.hash ?? '') || await hashEvidenceArtifact(artifact) !== artifact.hash) {
        throw new TypeError('Hash de evidência inválido.');
      }
    }
    const manifestHash = await sha256Hex(canonicalStringify(projectEvidenceManifest(model.evidence)));
    if (manifestHash !== model.integrity.evidenceManifestHash) {
      throw new TypeError('Hash do manifesto de evidências inválido.');
    }
    const hashInput = structuredClone(model);
    delete hashInput.integrity.canonicalModelHash;
    if (await sha256Hex(canonicalStringify(hashInput)) !== model.integrity.canonicalModelHash) {
      throw new TypeError('Hash do modelo canônico inválido.');
    }
    VERIFIED_SNAPSHOTS.add(model);
    return model;
  } catch {
    throw new TypeError('Cadeia de integridade do relatório inválida ou indisponível.');
  }
}
