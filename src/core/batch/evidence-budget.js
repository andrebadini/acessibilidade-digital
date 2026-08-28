import { hashEvidenceArtifact } from '../evidence/artifact-hash.js';
import { pngDataUrlDecodedByteLength } from '../evidence/png.js';

export const DEFAULT_BATCH_EVIDENCE_BUDGET_BYTES = 256 * 1024 * 1024;

/** Applies the global decoded-PNG budget to one remapped page without breaking graph references. */
export async function applyBatchEvidenceBudget(pageResult, {
  usedBytes = 0,
  limitBytes = DEFAULT_BATCH_EVIDENCE_BUDGET_BYTES,
  exhausted = false,
} = {}) {
  if (!pageResult || typeof pageResult !== 'object' || !Array.isArray(pageResult.evidence) ||
    !Number.isSafeInteger(usedBytes) || usedBytes < 0 || !Number.isSafeInteger(limitBytes) || limitBytes < 0 ||
    typeof exhausted !== 'boolean') {
    throw new TypeError('Estado do orçamento de evidências inválido.');
  }
  const result = structuredClone(pageResult);
  const retained = [];
  const omitted = [];
  const omittedSources = new Set();
  const initialUsedBytes = usedBytes;
  let consumed = usedBytes;

  for (const artifact of result.evidence) {
    const bytes = artifactBytes(artifact);
    const mapDependsOnOmittedSource = artifact.kind === 'announcement-map' &&
      omittedSources.has(artifact.fullPageEvidenceId);
    if (exhausted || mapDependsOnOmittedSource || consumed + bytes > limitBytes) {
      exhausted = true;
      omitted.push({
        evidenceId: artifact.evidenceId, kind: artifact.kind,
        contentHash: typeof artifact.hash === 'string' ? artifact.hash : null,
        reason: 'budget',
      });
      if (artifact.kind === 'announcement-map') continue;
      const originalHash = artifact.hash;
      delete artifact.dataUrl;
      artifact.pixelState = 'omitted-budget';
      if (typeof originalHash === 'string') artifact.pixelContentHash = originalHash;
      artifact.hash = await hashEvidenceArtifact(artifact);
      if (artifact.kind === 'full-page') omittedSources.add(artifact.evidenceId);
      retained.push(artifact);
      continue;
    }
    consumed += bytes;
    retained.push(artifact);
  }

  const omittedPixelSources = new Set(retained
    .filter(artifact => artifact.kind === 'full-page' && artifact.pixelState === 'omitted-budget')
    .map(artifact => artifact.evidenceId));
  const dependencySafe = retained.filter(artifact => {
    if (artifact.kind !== 'announcement-map' || !omittedPixelSources.has(artifact.fullPageEvidenceId)) return true;
    if (!omitted.some(value => value.evidenceId === artifact.evidenceId)) omitted.push({
      evidenceId: artifact.evidenceId, kind: artifact.kind,
      contentHash: typeof artifact.hash === 'string' ? artifact.hash : null, reason: 'budget',
    });
    consumed = Math.max(initialUsedBytes, consumed - artifactBytes(artifact));
    return false;
  });
  const exceeded = omitted.length > 0;
  result.evidence = dependencySafe;
  if (exceeded) {
    const message = 'O orçamento total de 256 MiB de PNGs foi atingido; novos pixels foram omitidos, preservando metadados e hashes de conteúdo.';
    result.page.status = ['failed', 'cancelled'].includes(result.page.status) ? result.page.status : 'partial';
    result.page.diagnostics = [...(result.page.diagnostics ?? []), {
      code: 'BATCH_EVIDENCE_BUDGET_EXCEEDED', message,
      at: result.page.timestamps?.endedAt ?? new Date(0).toISOString(), recoverable: false,
    }];
    result.page.limitations = [...new Set([...(result.page.limitations ?? []), message])];
    result.page.omittedEvidence = [...(result.page.omittedEvidence ?? []), ...omitted];
  }
  return { result, usedBytes: consumed, exceeded, exhausted };
}

function artifactBytes(artifact) {
  let total = pngBytes(artifact?.dataUrl);
  if (artifact?.kind === 'announcement-map') {
    for (const segment of artifact.segments ?? []) total += pngBytes(segment?.dataUrl);
  }
  return total;
}

function pngBytes(value) {
  if (typeof value !== 'string') return 0;
  try { return pngDataUrlDecodedByteLength(value); } catch { return 0; }
}
