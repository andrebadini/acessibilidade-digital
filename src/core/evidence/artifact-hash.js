import { canonicalStringify } from '../report/canonical-json.js';
import { sha256Hex } from '../report/hash.js';

const PNG_PREFIX = 'data:image/png;base64,';
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function pngBytes(value) {
  if (typeof value !== 'string' || !value.startsWith(PNG_PREFIX)) return null;
  const encoded = value.slice(PNG_PREFIX.length);
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) return null;
  try {
    const binary = atob(encoded);
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    return bytes.length >= PNG_SIGNATURE.length && PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)
      ? bytes
      : null;
  } catch {
    return null;
  }
}

/** Recomputes an evidence digest from persisted content, never from a supplied hash. */
export async function hashEvidenceArtifact(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Artefato de evidência inválido.');
  const content = structuredClone(input);
  delete content.hash;
  const bytes = pngBytes(content.dataUrl);
  if (bytes && content.kind === 'full-page') return sha256Hex(bytes);
  if (bytes) {
    content.binarySha256 = await sha256Hex(bytes);
    delete content.dataUrl;
  }
  return sha256Hex(canonicalStringify(content));
}
