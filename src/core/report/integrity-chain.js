import { hashEvidenceArtifact, isDerivedEvidenceKind } from '../evidence/artifact-hash.js';
import { canonicalStringify } from './canonical-json.js';
import { sha256Hex } from './hash.js';

export const REPORT_HASH_BASE =
  'SHA-256 do JSON canônico com integrity.canonicalModelHash omitido; evidenceManifestHash permanece incluído.';

const SHA256 = /^[a-f0-9]{64}$/u;
const INTEGRITY_KEYS = Object.freeze([
  'algorithm', 'canonicalModelHash', 'evidenceManifestHash', 'hashBase',
]);

function exactKeys(value, expected) {
  try {
    return canonicalStringify(Object.keys(value).sort()) === canonicalStringify([...expected].sort());
  } catch {
    return false;
  }
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

/** Derives every auxiliary reproducibility claim from the closed canonical model. */
export async function computeCanonicalReproducibility(model) {
  if (!model || typeof model !== 'object' || !Array.isArray(model.ruleResults) ||
    !Array.isArray(model.evidence) || !Number.isSafeInteger(model.evidenceStateCount) ||
    model.evidenceStateCount < 0 || typeof model.versions?.rules !== 'string') {
    throw new TypeError('Fontes canônicas de reprodutibilidade inválidas.');
  }
  const output = {
    methodologyVersion: model.versions.rules,
    snapshotHash: await sha256Hex(canonicalStringify(model.snapshot ?? null)),
    ruleResultsHash: await sha256Hex(canonicalStringify(model.ruleResults)),
    evidenceHash: await sha256Hex(canonicalStringify(projectEvidenceManifest(model.evidence))),
    capturedStateCount: model.evidenceStateCount,
  };
  return output;
}

/** Recomputes every persisted integrity link without trusting model validation. */
export async function verifyIntegrityLinks(model) {
  const integrity = model?.integrity;
  if (!integrity || typeof integrity !== 'object' || Array.isArray(integrity) ||
    !exactKeys(integrity, INTEGRITY_KEYS) || integrity.algorithm !== 'SHA-256' ||
    integrity.hashBase !== REPORT_HASH_BASE || !SHA256.test(integrity.canonicalModelHash) ||
    !SHA256.test(integrity.evidenceManifestHash) || !Array.isArray(model.evidence)) {
    throw new TypeError('Metadados de integridade SHA-256 inválidos.');
  }
  const artifactById = new Map(model.evidence.map(artifact => [artifact.evidenceId, artifact]));
  for (const artifact of model.evidence) {
    if (!SHA256.test(artifact.hash ?? '') || await hashEvidenceArtifact(artifact, {
      sourceArtifact: isDerivedEvidenceKind(artifact.kind)
        ? artifactById.get(artifact.fullPageEvidenceId)
        : undefined,
    }) !== artifact.hash) {
      throw new TypeError('Hash de evidência inválido.');
    }
  }
  const manifestHash = await sha256Hex(canonicalStringify(projectEvidenceManifest(model.evidence)));
  if (manifestHash !== integrity.evidenceManifestHash) {
    throw new TypeError('Hash do manifesto de evidências inválido.');
  }
  const reproducibility = await computeCanonicalReproducibility(model);
  if (canonicalStringify(model.reproducibility) !== canonicalStringify(reproducibility)) {
    throw new TypeError('Hashes de reprodutibilidade inválidos.');
  }
  const hashInput = structuredClone(model);
  delete hashInput.integrity.canonicalModelHash;
  if (await sha256Hex(canonicalStringify(hashInput)) !== integrity.canonicalModelHash) {
    throw new TypeError('Hash do modelo canônico inválido.');
  }
}
