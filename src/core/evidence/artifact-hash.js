import { canonicalStringify } from '../report/canonical-json.js';
import { sha256Hex } from '../report/hash.js';
import { hashAnnotationMapArtifact } from './annotation-map-artifact.js';
import { decodePngDataUrl } from './png.js';

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
  const bytes = pngBytes(content.dataUrl);
  if (bytes && content.kind === 'full-page') return sha256Hex(bytes);
  if (bytes) {
    content.binarySha256 = await sha256Hex(bytes);
    delete content.dataUrl;
  }
  return sha256Hex(canonicalStringify(content));
}
