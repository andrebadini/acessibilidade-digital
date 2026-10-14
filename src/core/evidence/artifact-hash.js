import { canonicalStringify } from '../report/canonical-json.js';
import { sha256Hex } from '../report/hash.js';
import { hashAnnotationMapArtifact } from './annotation-map-artifact.js';
import { hashKeyboardMapArtifact } from '../keyboard/keyboard-map-artifact.js';
import { decodePngDataUrl } from './png.js';

/**
 * Tipos de artefato derivados de uma captura integral: o hash deles depende do hash da origem, então
 * quem recalcula precisa passar `sourceArtifact`. A lista fica aqui, ao lado do dispatch que a usa,
 * para que um tipo novo não seja esquecido em um dos pontos que recalculam.
 */
const DERIVED_EVIDENCE_KINDS = Object.freeze(['announcement-map', 'keyboard-map']);

export function isDerivedEvidenceKind(kind) {
  return DERIVED_EVIDENCE_KINDS.includes(kind);
}

function pngBytes(value) {
  if (typeof value !== 'string' || !value.startsWith('data:image/png;base64,')) return null;
  return decodePngDataUrl(value).bytes;
}

/** Recomputes an evidence digest from persisted content, never from a supplied hash. */
export async function hashEvidenceArtifact(input, { sourceArtifact } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Artefato de evidência inválido.');
  const content = structuredClone(input);
  delete content.hash;
  if (content.kind === 'announcement-map') {
    return hashAnnotationMapArtifact({ ...content, hash: '0'.repeat(64) }, { sourceArtifact });
  }
  if (content.kind === 'keyboard-map') {
    return hashKeyboardMapArtifact({ ...content, hash: '0'.repeat(64) }, { sourceArtifact });
  }
  const bytes = pngBytes(content.dataUrl);
  if (bytes && content.kind === 'full-page') return sha256Hex(bytes);
  if (bytes) {
    content.binarySha256 = await sha256Hex(bytes);
    delete content.dataUrl;
  }
  return sha256Hex(canonicalStringify(content));
}
