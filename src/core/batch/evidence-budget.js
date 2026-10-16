import { hashEvidenceArtifact } from '../evidence/artifact-hash.js';
import { pngDataUrlDecodedByteLength } from '../evidence/png.js';

// Mapas derivados da captura integral (anúncios e teclado): segmentos com pixels e dependência da origem.
const DERIVED_MAP_KINDS = new Set(['announcement-map', 'keyboard-map']);

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
    const hasPixels = hasPixelPayload(artifact);
    const mapDependsOnOmittedSource = DERIVED_MAP_KINDS.has(artifact.kind) &&
      omittedSources.has(artifact.fullPageEvidenceId);
    if (hasPixels && (exhausted || mapDependsOnOmittedSource || consumed + bytes > limitBytes)) {
      exhausted = true;
      const originalHash = artifact.hash;
      omitted.push({
        evidenceId: artifact.evidenceId, kind: artifact.kind,
        contentHash: typeof originalHash === 'string' ? originalHash : null,
        reason: 'budget',
      });
      omitArtifactPixels(artifact);
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
  const dependencySafe = [];
  for (const artifact of retained) {
    if (!DERIVED_MAP_KINDS.has(artifact.kind) || !omittedPixelSources.has(artifact.fullPageEvidenceId) ||
      artifact.pixelState === 'omitted-budget' || !hasPixelPayload(artifact)) {
      dependencySafe.push(artifact);
      continue;
    }
    const originalHash = artifact.hash;
    if (!omitted.some(value => value.evidenceId === artifact.evidenceId)) omitted.push({
      evidenceId: artifact.evidenceId, kind: artifact.kind,
      contentHash: typeof originalHash === 'string' ? originalHash : null, reason: 'budget',
    });
    consumed = Math.max(initialUsedBytes, consumed - artifactBytes(artifact));
    omitArtifactPixels(artifact);
    artifact.pixelState = 'omitted-budget';
    if (typeof originalHash === 'string') artifact.pixelContentHash = originalHash;
    artifact.hash = await hashEvidenceArtifact(artifact, {
      sourceArtifact: dependencySafe.find(value => value.evidenceId === artifact.fullPageEvidenceId),
    });
    dependencySafe.push(artifact);
  }
  const evidenceOrder = new Map(result.evidence.map((artifact, index) => [artifact.evidenceId, index]));
  omitted.sort((left, right) => evidenceOrder.get(left.evidenceId) - evidenceOrder.get(right.evidenceId));
  const exceeded = omitted.length > 0;
  result.evidence = dependencySafe;
  if (exceeded) {
    const message = 'O orçamento total de 256 MiB de PNGs foi atingido; novos pixels foram omitidos, preservando metadados e hashes de conteúdo.';
    result.page.status = ['failed', 'cancelled'].includes(result.page.status) ? result.page.status : 'partial';
    result.page.diagnostics = [...(result.page.diagnostics ?? []), {
      code: 'BATCH_EVIDENCE_BUDGET_EXCEEDED', message,
      at: result.page.timestamps?.endedAt ?? new Date(0).toISOString(), recoverable: true,
    }];
    result.page.omittedEvidence = [...(result.page.omittedEvidence ?? []), ...omitted];
  }
  return { result, usedBytes: consumed, exceeded, exhausted };
}

function artifactBytes(artifact) {
  let total = pngBytes(artifact?.dataUrl);
  if (DERIVED_MAP_KINDS.has(artifact?.kind)) {
    for (const segment of artifact.segments ?? []) total += pngBytes(segment?.dataUrl);
  }
  return total;
}

function hasPixelPayload(artifact) {
  if (typeof artifact?.dataUrl === 'string') return true;
  return DERIVED_MAP_KINDS.has(artifact?.kind) &&
    Array.isArray(artifact.segments) && artifact.segments.some(segment => typeof segment?.dataUrl === 'string');
}

function omitArtifactPixels(artifact) {
  delete artifact.dataUrl;
  // Sem os pixels não há arquivo de imagem a que o hash se refira; o esquema recusa o campo sozinho.
  delete artifact.binarySha256;
  if (DERIVED_MAP_KINDS.has(artifact.kind)) {
    for (const segment of artifact.segments ?? []) delete segment.dataUrl;
  }
}

function pngBytes(value) {
  if (typeof value !== 'string') return 0;
  try { return pngDataUrlDecodedByteLength(value); } catch { return 0; }
}
