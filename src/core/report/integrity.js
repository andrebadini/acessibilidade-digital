import { createAuditModel, withCanonicalModelHash } from './audit-model.js';
import { auditModelInputError } from './audit-input.js';
import { canonicalStringify } from './canonical-json.js';
import { sha256Hex } from './hash.js';
import {
  projectEvidenceManifest,
  REPORT_HASH_BASE,
  verifyIntegrityLinks,
} from './integrity-chain.js';

export { projectEvidenceManifest, REPORT_HASH_BASE } from './integrity-chain.js';
const VERIFIED_SNAPSHOTS = new WeakSet();

export function isAuditIntegrityVerified(value) {
  return Boolean(value && typeof value === 'object' && VERIFIED_SNAPSHOTS.has(value));
}

/**
 * Sela uma revisão humana sobre uma base já verificada. A revisão não toca em evidências,
 * regras nem no snapshot observado; isso é conferido aqui contra a base verificada, e só o
 * hash canônico do modelo é recalculado. Antes, cada resposta re-hasheava todas as evidências
 * (milhares em páginas de loja) só para confirmar o que a base verificada já provava.
 */
export async function sealReviewedAuditSnapshot(verifiedBase, reviewed) {
  try {
    if (!VERIFIED_SNAPSHOTS.has(verifiedBase)) throw new TypeError();
    const expected = createAuditModel(reviewed);
    if (expected.auditId !== verifiedBase.auditId ||
      canonicalStringify(expected.evidence) !== canonicalStringify(verifiedBase.evidence) ||
      canonicalStringify(expected.snapshot ?? null) !== canonicalStringify(verifiedBase.snapshot ?? null) ||
      canonicalStringify(expected.ruleResults) !== canonicalStringify(verifiedBase.ruleResults) ||
      canonicalStringify(expected.reproducibility) !== canonicalStringify(verifiedBase.reproducibility) ||
      expected.evidenceStateCount !== verifiedBase.evidenceStateCount ||
      expected.versions?.rules !== verifiedBase.versions?.rules) throw new TypeError();
    const { canonicalModelHash: _previous, ...integrityRest } = expected.integrity;
    if (canonicalStringify(integrityRest) !== canonicalStringify((({ canonicalModelHash: _base, ...rest }) => rest)(verifiedBase.integrity))) {
      throw new TypeError();
    }
    const hashInput = structuredClone(expected);
    delete hashInput.integrity.canonicalModelHash;
    const canonicalModelHash = await sha256Hex(canonicalStringify(hashInput));
    const sealed = withCanonicalModelHash(expected, canonicalModelHash);
    VERIFIED_SNAPSHOTS.add(sealed);
    return sealed;
  } catch {
    throw auditModelInputError();
  }
}

/**
 * Returns an immutable canonical snapshot only after recomputing every integrity
 * link from the evidence content. Callers must use only the returned snapshot.
 */
export async function verifyAuditIntegritySnapshot(input) {
  if (VERIFIED_SNAPSHOTS.has(input)) return input;
  try {
    const model = createAuditModel(input);
    await verifyIntegrityLinks(model);
    VERIFIED_SNAPSHOTS.add(model);
    return model;
  } catch {
    throw auditModelInputError();
  }
}
