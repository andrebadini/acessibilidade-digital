import { hashEvidenceArtifact } from '../evidence/artifact-hash.js';
import { createAuditModel, migrateAuditV2AfterIntegrityVerification } from './audit-model.js';
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
    const raw = JSON.parse(canonicalStringify(input));
    if (hasLegacyNormativeOccurrences(raw)) {
      await verifyIntegrityLinks(raw);
      const migrated = migrateAuditV2AfterIntegrityVerification(raw);
      const evidenceManifestHash = await sha256Hex(canonicalStringify(projectEvidenceManifest(migrated.evidence)));
      const pending = structuredClone(migrated);
      pending.integrity = {
        algorithm: 'SHA-256', evidenceManifestHash, canonicalModelHash: 'pending', hashBase: REPORT_HASH_BASE,
      };
      const hashInput = structuredClone(pending);
      delete hashInput.integrity.canonicalModelHash;
      pending.integrity.canonicalModelHash = await sha256Hex(canonicalStringify(hashInput));
      return verifyAuditIntegritySnapshot(pending);
    }
    const model = createAuditModel(input);
    await verifyIntegrityLinks(model);
    VERIFIED_SNAPSHOTS.add(model);
    return model;
  } catch {
    throw new TypeError('Cadeia de integridade do relatório inválida ou indisponível.');
  }
}

function hasLegacyNormativeOccurrences(model) {
  const collections = [model?.occurrences, model?.axe?.occurrences];
  for (const page of Array.isArray(model?.axePages) ? model.axePages : []) collections.push(page?.result?.occurrences);
  return collections.some(collection => Array.isArray(collection) && collection.some(occurrence =>
    occurrence && typeof occurrence === 'object' &&
    ['itemWcagRefs', 'sourceWcagRefs', 'testedWcagRefs'].every(field => !Object.hasOwn(occurrence, field))));
}

async function verifyIntegrityLinks(model) {
  if (model.integrity?.algorithm === 'unavailable') throw new TypeError('Integridade indisponível.');
  if (!Array.isArray(model.evidence) || model.integrity?.algorithm !== 'SHA-256' || model.integrity.hashBase !== REPORT_HASH_BASE ||
    !SHA256.test(model.integrity.canonicalModelHash) || !SHA256.test(model.integrity.evidenceManifestHash)) {
    throw new TypeError('Metadados de integridade inválidos.');
  }
  const artifactById = new Map(model.evidence.map(artifact => [artifact.evidenceId, artifact]));
  for (const artifact of model.evidence) {
    if (!SHA256.test(artifact.hash ?? '') || await hashEvidenceArtifact(artifact, {
      sourceArtifact: artifact.kind === 'announcement-map'
        ? artifactById.get(artifact.fullPageEvidenceId)
        : undefined,
    }) !== artifact.hash) throw new TypeError('Hash de evidência inválido.');
  }
  const manifestHash = await sha256Hex(canonicalStringify(projectEvidenceManifest(model.evidence)));
  if (manifestHash !== model.integrity.evidenceManifestHash) throw new TypeError('Hash do manifesto de evidências inválido.');
  const hashInput = structuredClone(model);
  delete hashInput.integrity.canonicalModelHash;
  if (await sha256Hex(canonicalStringify(hashInput)) !== model.integrity.canonicalModelHash) {
    throw new TypeError('Hash do modelo canônico inválido.');
  }
}
