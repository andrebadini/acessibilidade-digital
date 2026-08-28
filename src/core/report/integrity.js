import {
  createAuditModel,
  verifyAndMigrateLegacyAuditV2,
} from './audit-model.js';
import { canonicalStringify } from './canonical-json.js';
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
    const raw = JSON.parse(canonicalStringify(input));
    if (hasLegacyNormativeOccurrences(raw)) {
      const migrated = await verifyAndMigrateLegacyAuditV2(raw);
      VERIFIED_SNAPSHOTS.add(migrated);
      return migrated;
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
