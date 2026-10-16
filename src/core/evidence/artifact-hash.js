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
export async function hashEvidenceArtifact(input, options) {
  return (await hashEvidenceArtifactDetailed(input, options)).hash;
}

/**
 * O mesmo recálculo, devolvendo também o SHA-256 do arquivo PNG guardado quando existe um.
 *
 * O digest do artefato de elemento é o hash do JSON canônico **sem** `dataUrl` e **com** o hash do PNG
 * dentro, então as duas informações saem da mesma passada: a verificação de integridade confere, de uma
 * vez, que o hash do registro corresponde ao conteúdo e que o hash do arquivo corresponde aos pixels.
 */
export async function hashEvidenceArtifactDetailed(input, { sourceArtifact } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Artefato de evidência inválido.');
  const content = structuredClone(input);
  delete content.hash;
  if (content.kind === 'announcement-map') {
    return { hash: await hashAnnotationMapArtifact({ ...content, hash: '0'.repeat(64) }, { sourceArtifact }), binarySha256: null };
  }
  if (content.kind === 'keyboard-map') {
    return { hash: await hashKeyboardMapArtifact({ ...content, hash: '0'.repeat(64) }, { sourceArtifact }), binarySha256: null };
  }
  const bytes = pngBytes(content.dataUrl);
  if (bytes && content.kind === 'full-page') return { hash: await sha256Hex(bytes), binarySha256: null };
  let binarySha256 = null;
  if (bytes) {
    binarySha256 = await sha256Hex(bytes);
    content.binarySha256 = binarySha256;
    delete content.dataUrl;
  }
  return { hash: await sha256Hex(canonicalStringify(content)), binarySha256 };
}
