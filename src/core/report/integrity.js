import { createAuditModel } from './audit-model.js';
import { auditModelInputError } from './audit-input.js';
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
 * Returns an immutable canonical snapshot only after recomputing every integrity
 * link from the evidence content. Callers must use only the returned snapshot.
 */
export async function verifyAuditIntegritySnapshot(input) {
  try {
    const model = createAuditModel(input);
    await verifyIntegrityLinks(model);
    VERIFIED_SNAPSHOTS.add(model);
    return model;
  } catch {
    throw auditModelInputError();
  }
}
