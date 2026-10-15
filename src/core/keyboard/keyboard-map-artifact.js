/**
 * Esquema fechado, limites e hash do artefato "mapa do teclado".
 *
 * Artefato irmão do mapa de anúncios, com esquema e versionamento próprios: uma auditoria guardada
 * sem mapa do teclado (toda a 1.1.57 e anteriores) continua abrindo, e um mapa do teclado nunca é
 * confundido com um mapa de anúncios na leitura. Como lá, os pixels derivados não entram no hash —
 * o conteúdo que o hash cobre é a derivação e as listas —, e o PNG de cada segmento tem o próprio
 * `contentHash`.
 */
import { decodePngDataUrl, pngDataUrlDecodedByteLength, validatePngRasterData } from '../evidence/png.js';
import { canonicalStringify } from '../report/canonical-json.js';
import { sha256Hex } from '../report/hash.js';
import { KEYBOARD_MAP_LIMITATIONS, KEYBOARD_MAP_REQUIRED_LIMITATIONS, KEYBOARD_MAP_STOP_KINDS, KEYBOARD_MAP_SUSPECT_REASONS } from './keyboard-map-model.js';

export const KEYBOARD_MAP_ALGORITHM = 'audita.keyboard-map';
export const KEYBOARD_MAP_VERSION = '1.0.0';
export const KEYBOARD_MAP_READABLE_VERSIONS = Object.freeze([KEYBOARD_MAP_VERSION]);
export const KEYBOARD_MAP_PRINTABLE_ASPECT_RATIO = 1.3;

export const KEYBOARD_MAP_LIMITS = Object.freeze({
  maxStops: 400,
  maxSuspects: 60,
  maxSourcePixels: 32_000_000,
  maxDimension: 8192,
  maxCanvasPixels: 32_000_000,
  maxSegments: 64,
  maxDerivedBytes: 64 * 1024 * 1024,
});

const SHA256 = /^[a-f0-9]{64}$/u;
const ID = /^[A-Za-z0-9._:-]{1,200}$/u;
const TAG = /^[a-z][a-z0-9-]{0,63}$/u;
const NAME_SOURCE = /^[a-z][a-z0-9-]{0,39}$/u;
/** Estados do nome projetado: desenhado a partir do instantâneo, ou retirado por privacidade. */
export const KEYBOARD_MAP_NAME_STATUSES = Object.freeze(['projected', 'omitted-privacy']);
const KEYBOARD_MAP_SEGMENT_ROLES = Object.freeze(['image']);

/**
 * Limitações que tornam o mapa *materialmente* parcial: alguma coisa que deveria estar desenhada ou
 * listada pode faltar, ou foi desenhada fora de lugar. Elemento escondido, sem caixa útil ou dentro de
 * recorte por rolagem não entra nesta lista por si só — omissão correta não é lacuna —, mas o corte por
 * rolagem entra porque esconde uma parada que existe. `source-layout-changed` entra porque a lista sai
 * inteira e a imagem sai sem caixa nenhuma: o que deveria estar desenhado não está.
 */
export const KEYBOARD_MAP_PARTIAL_LIMITATIONS = Object.freeze([
  'closed-shadow-root-omitted',
  'frame-content-omitted',
  'stops-outside-source-clamped',
  'ancestor-clipped-stops-omitted',
  'cursor-style-not-collected',
  'privacy-content-omitted',
  'stop-limit-reached',
  'suspect-limit-reached',
  'source-layout-changed',
]);

/**
 * Estado do mapa, derivado das coleções e das limitações — nunca declarado à mão.
 *
 * Vazio: não há nada a mostrar. Parcial: alguma coisa pode faltar. Completo: tudo o que a varredura
 * encontrou está desenhado e listado.
 */
export function keyboardMapStatus({ stops, suspects, segments, limitations, pixelsOmitted = false }) {
  const materiallyPartial = pixelsOmitted || limitations.some(value => KEYBOARD_MAP_PARTIAL_LIMITATIONS.includes(value));
  if (stops.length === 0 && suspects.length === 0 && segments.length === 0) return 'empty';
  return materiallyPartial || segments.length === 0 ? 'partial' : 'complete';
}

const ARTIFACT_KEYS = Object.freeze([
  'evidenceId', 'pageId', 'kind', 'state', 'fullPageEvidenceId', 'derivation', 'status',
  'segments', 'stops', 'suspects', 'counts', 'limits', 'limitations', 'hash',
]);
const OMITTED_ARTIFACT_KEYS = Object.freeze([...ARTIFACT_KEYS, 'pixelState', 'pixelContentHash']);
const DERIVATION_KEYS = Object.freeze(['type', 'algorithm', 'version', 'sourceEvidenceId', 'sourceHash', 'geometry']);
const GEOMETRY_KEYS = Object.freeze(['coordinateSpace', 'sourceCssSize', 'sourcePixelSize', 'scaleX', 'scaleY', 'deviceScaleFactor']);
const SIZE_KEYS = Object.freeze(['width', 'height']);
const SEGMENT_KEYS = Object.freeze(['segmentId', 'index', 'count', 'role', 'sourceCssClip', 'width', 'height', 'dataUrl', 'contentHash']);
const OMITTED_SEGMENT_KEYS = Object.freeze(SEGMENT_KEYS.filter(key => key !== 'dataUrl'));
const STOP_KEYS = Object.freeze(['number', 'nodeId', 'tag', 'kind', 'tabIndex', 'name', 'nameSource', 'nameStatus', 'bounds', 'segmentIndex']);
const SUSPECT_KEYS = Object.freeze(['number', 'nodeId', 'tag', 'role', 'reason', 'ruleId', 'name', 'nameSource', 'nameStatus', 'bounds', 'segmentIndex']);
const COUNT_KEYS = Object.freeze(['eligible', 'stops', 'suspects', 'omittedNotVisible', 'omittedNoRect', 'omittedClipped', 'omittedFrame', 'omittedLimit']);
const LIMIT_KEYS = Object.freeze(['maxStops', 'maxSuspects', 'maxSourcePixels', 'maxDimension', 'maxCanvasPixels', 'maxSegments', 'maxDerivedBytes']);

function exactKeys(value, expected) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
    canonicalStringify(Object.keys(value).sort()) === canonicalStringify([...expected].sort());
}

function nearlyEqual(left, right) {
  return Math.abs(left - right) <= Math.max(1, Math.abs(left), Math.abs(right)) * 1e-9;
}

function canonicalId(value, label) {
  if (typeof value !== 'string' || !ID.test(value)) throw new TypeError(`${label} inválido.`);
  return value;
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} inválido.`);
  return value;
}

function finiteNumber(value, label, { positive = false } = {}) {
  if (!Number.isFinite(value) || (positive && value <= 0)) throw new TypeError(`${label} inválido.`);
  return value;
}

function validateClip(value, label) {
  if (!exactKeys(value, ['x', 'y', 'width', 'height'])) throw new TypeError(`${label} inválido.`);
  finiteNumber(value.x, `${label}.x`);
  finiteNumber(value.y, `${label}.y`);
  finiteNumber(value.width, `${label}.width`, { positive: true });
  finiteNumber(value.height, `${label}.height`, { positive: true });
}

function validateSize(value, label, { integer = false } = {}) {
  if (!exactKeys(value, SIZE_KEYS)) throw new TypeError(`${label} inválido.`);
  finiteNumber(value.width, `${label}.width`, { positive: true });
  finiteNumber(value.height, `${label}.height`, { positive: true });
  if (integer && (!Number.isSafeInteger(value.width) || !Number.isSafeInteger(value.height))) {
    throw new TypeError(`${label} deve usar pixels inteiros.`);
  }
}

function validateGeometry(geometry, { version = KEYBOARD_MAP_VERSION } = {}) {
  if (version !== KEYBOARD_MAP_VERSION) throw new TypeError(`Versão do algoritmo do mapa do teclado não reconhecida: ${String(version)}.`);
  if (!exactKeys(geometry, GEOMETRY_KEYS) || geometry.coordinateSpace !== 'document-css-px') {
    throw new TypeError('Geometria do mapa do teclado inválida.');
  }
  validateSize(geometry.sourceCssSize, 'geometry.sourceCssSize');
  validateSize(geometry.sourcePixelSize, 'geometry.sourcePixelSize', { integer: true });
  finiteNumber(geometry.scaleX, 'geometry.scaleX', { positive: true });
  finiteNumber(geometry.scaleY, 'geometry.scaleY', { positive: true });
  if (geometry.deviceScaleFactor !== null) finiteNumber(geometry.deviceScaleFactor, 'geometry.deviceScaleFactor', { positive: true });
  if (geometry.sourcePixelSize.width !== Math.round(geometry.sourceCssSize.width * geometry.scaleX) ||
    geometry.sourcePixelSize.height !== Math.round(geometry.sourceCssSize.height * geometry.scaleY) ||
    geometry.sourcePixelSize.width > KEYBOARD_MAP_LIMITS.maxDimension ||
    geometry.sourcePixelSize.height > KEYBOARD_MAP_LIMITS.maxDimension ||
    geometry.sourcePixelSize.width * geometry.sourcePixelSize.height > KEYBOARD_MAP_LIMITS.maxSourcePixels) {
    throw new TypeError('Escala do mapa do teclado inválida.');
  }
  return geometry;
}

export async function hashKeyboardMapGeometry(geometry) {
  return sha256Hex(canonicalStringify(validateGeometry(geometry)));
}

function validateEntry(entry, kind, { index, geometry, segmentCount }) {
  const keys = kind === 'stop' ? STOP_KEYS : SUSPECT_KEYS;
  const label = kind === 'stop' ? `Parada ${index}` : `Suspeito ${index}`;
  if (!exactKeys(entry, keys) || entry.number !== index) throw new TypeError(`${label} inválida.`);
  canonicalId(entry.nodeId, `${label}.nodeId`);
  if (typeof entry.tag !== 'string' || !TAG.test(entry.tag)) throw new TypeError(`${label}.tag inválido.`);
  for (const field of ['name', 'nameSource']) {
    if (typeof entry[field] !== 'string' || [...entry[field]].length > 512) throw new TypeError(`${label}.${field} inválido.`);
  }
  if (entry.nameSource !== 'none' && !NAME_SOURCE.test(entry.nameSource)) throw new TypeError(`${label}.nameSource inválido.`);
  if (!KEYBOARD_MAP_NAME_STATUSES.includes(entry.nameStatus)) throw new TypeError(`${label}.nameStatus inválido.`);
  if (entry.nameStatus === 'omitted-privacy' && entry.name !== '') throw new TypeError(`${label} declara nome omitido com texto projetado.`);
  validateClip(entry.bounds, `${label}.bounds`);
  if (entry.bounds.x + entry.bounds.width > geometry.sourceCssSize.width + 1e-9 ||
    entry.bounds.y + entry.bounds.height > geometry.sourceCssSize.height + 1e-9) {
    throw new TypeError(`${label} fora da área declarada da origem.`);
  }
  if (!Number.isSafeInteger(entry.segmentIndex) || entry.segmentIndex < 1 || entry.segmentIndex > segmentCount) {
    throw new TypeError(`${label}.segmentIndex inválido.`);
  }
  if (kind === 'stop') {
    if (!KEYBOARD_MAP_STOP_KINDS.includes(entry.kind)) throw new TypeError(`${label}.kind inválido.`);
    nonNegativeInteger(entry.tabIndex, `${label}.tabIndex`);
    return entry;
  }
  if (!KEYBOARD_MAP_SUSPECT_REASONS.includes(entry.reason)) throw new TypeError(`${label}.reason inválido.`);
  if (typeof entry.role !== 'string' || (entry.role !== '' && !/^[a-z][a-z0-9-]{0,63}$/u.test(entry.role))) {
    throw new TypeError(`${label}.role inválido.`);
  }
  if (entry.reason === 'keyboard-rule') {
    if (typeof entry.ruleId !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/u.test(entry.ruleId)) throw new TypeError(`${label}.ruleId inválido.`);
  } else if (entry.ruleId !== null) {
    throw new TypeError(`${label} declara regra sem motivo de regra.`);
  }
  return entry;
}

/**
 * Valida um mapa do teclado guardado, pelas regras da versão que ele próprio declara.
 *
 * `sourceArtifact` é a captura pristine declarada: quando ela vem junto, o vínculo é conferido por
 * identidade e por hash, e não apenas por nome.
 */
export function validateKeyboardMapArtifact(artifact, { sourceArtifact } = {}) {
  const pixelsOmitted = artifact?.pixelState === 'omitted-budget';
  if (!exactKeys(artifact, pixelsOmitted ? OMITTED_ARTIFACT_KEYS : ARTIFACT_KEYS) ||
    (pixelsOmitted && !SHA256.test(artifact.pixelContentHash)) ||
    artifact.kind !== 'keyboard-map' || artifact.state !== 'derived') {
    throw new TypeError('Esquema do mapa do teclado inválido.');
  }
  canonicalId(artifact.evidenceId, 'evidenceId do mapa do teclado');
  canonicalId(artifact.pageId, 'pageId do mapa do teclado');
  canonicalId(artifact.fullPageEvidenceId, 'fullPageEvidenceId do mapa do teclado');
  if (!SHA256.test(artifact.hash)) throw new TypeError('Hash do mapa do teclado inválido.');
  if (!exactKeys(artifact.derivation, DERIVATION_KEYS) ||
    artifact.derivation.type !== 'annotated-keyboard-map' ||
    artifact.derivation.algorithm !== KEYBOARD_MAP_ALGORITHM ||
    artifact.derivation.sourceEvidenceId !== artifact.fullPageEvidenceId ||
    !SHA256.test(artifact.derivation.sourceHash)) {
    throw new TypeError('Derivação do mapa do teclado inválida.');
  }
  if (sourceArtifact) {
    if (sourceArtifact.kind !== 'full-page' || sourceArtifact.state !== 'pristine' ||
      sourceArtifact.evidenceId !== artifact.fullPageEvidenceId || sourceArtifact.pageId !== artifact.pageId ||
      (sourceArtifact.pixelState === 'omitted-budget'
        ? sourceArtifact.pixelContentHash
        : sourceArtifact.hash) !== artifact.derivation.sourceHash) {
      throw new TypeError('Origem pristine do mapa do teclado inválida ou pertence a outra página.');
    }
  }
  const geometry = validateGeometry(artifact.derivation.geometry, { version: artifact.derivation.version });
  if (!['complete', 'partial', 'empty'].includes(artifact.status) ||
    !Array.isArray(artifact.segments) || artifact.segments.length > KEYBOARD_MAP_LIMITS.maxSegments ||
    !Array.isArray(artifact.stops) || artifact.stops.length > KEYBOARD_MAP_LIMITS.maxStops ||
    !Array.isArray(artifact.suspects) || artifact.suspects.length > KEYBOARD_MAP_LIMITS.maxSuspects) {
    throw new TypeError('Estado ou coleções do mapa do teclado inválidos.');
  }
  const segmentIds = new Set();
  let declaredDerivedBytes = 0;
  for (const segment of artifact.segments) {
    if (pixelsOmitted) continue;
    try { declaredDerivedBytes += pngDataUrlDecodedByteLength(segment?.dataUrl); } catch { throw new TypeError('Data URL PNG de segmento inválido.'); }
    if (declaredDerivedBytes > KEYBOARD_MAP_LIMITS.maxDerivedBytes) throw new TypeError('Bytes derivados do mapa do teclado excedem o limite antes da decodificação.');
  }
  let derivedBytes = 0;
  let expectedClipY = 0;
  for (const [offset, segment] of artifact.segments.entries()) {
    const index = offset + 1;
    if (!exactKeys(segment, pixelsOmitted ? OMITTED_SEGMENT_KEYS : SEGMENT_KEYS) ||
      segment.index !== index || segment.count !== artifact.segments.length ||
      segment.segmentId !== `${artifact.evidenceId}-segment-${index}` || segmentIds.has(segment.segmentId) ||
      !KEYBOARD_MAP_SEGMENT_ROLES.includes(segment.role) || !SHA256.test(segment.contentHash)) {
      throw new TypeError(`Segmento ${index} do mapa do teclado inválido.`);
    }
    segmentIds.add(segment.segmentId);
    validateClip(segment.sourceCssClip, `Segmento ${index}.sourceCssClip`);
    if (!nearlyEqual(segment.sourceCssClip.x, 0) || !nearlyEqual(segment.sourceCssClip.y, expectedClipY) ||
      !nearlyEqual(segment.sourceCssClip.width, geometry.sourceCssSize.width) ||
      segment.sourceCssClip.y + segment.sourceCssClip.height > geometry.sourceCssSize.height + 1e-9) {
      throw new TypeError(`Recorte do segmento ${index} não é canônico.`);
    }
    expectedClipY += segment.sourceCssClip.height;
    let png = null;
    if (!pixelsOmitted) {
      const remainingBytes = KEYBOARD_MAP_LIMITS.maxDerivedBytes - derivedBytes;
      if (remainingBytes < 57) throw new TypeError('Bytes derivados do mapa do teclado excedem o limite.');
      png = decodePngDataUrl(segment.dataUrl, {
        maxBytes: remainingBytes,
        maxDimension: KEYBOARD_MAP_LIMITS.maxDimension,
        maxPixels: KEYBOARD_MAP_LIMITS.maxCanvasPixels,
      });
    }
    if ((!pixelsOmitted && (segment.width !== png.width || segment.height !== png.height)) ||
      segment.width !== geometry.sourcePixelSize.width) {
      throw new TypeError(`Dimensões do segmento ${index} divergem do PNG ou da origem.`);
    }
    const pixelTop = Math.round(segment.sourceCssClip.y * geometry.scaleY);
    const pixelBottom = index === artifact.segments.length
      ? geometry.sourcePixelSize.height
      : Math.round((segment.sourceCssClip.y + segment.sourceCssClip.height) * geometry.scaleY);
    if (pixelBottom - pixelTop < 1 || segment.height < pixelBottom - pixelTop) {
      throw new TypeError(`Altura raster do segmento ${index} não contém o recorte de origem declarado.`);
    }
    if (segment.height > Math.max(1, Math.floor(segment.width * KEYBOARD_MAP_PRINTABLE_ASPECT_RATIO))) {
      throw new TypeError(`Proporção imprimível do segmento ${index} excede o limite do algoritmo.`);
    }
    if (png) derivedBytes += png.bytes.length;
  }
  if (artifact.segments.length > 0 && !nearlyEqual(expectedClipY, geometry.sourceCssSize.height)) {
    throw new TypeError('Recortes do mapa do teclado não cobrem a altura canônica da origem.');
  }
  if (derivedBytes > KEYBOARD_MAP_LIMITS.maxDerivedBytes) throw new TypeError('Bytes derivados do mapa do teclado excedem o limite.');
  for (const [offset, entry] of artifact.stops.entries()) {
    validateEntry(entry, 'stop', { index: offset + 1, geometry, segmentCount: artifact.segments.length });
  }
  for (const [offset, entry] of artifact.suspects.entries()) {
    validateEntry(entry, 'suspect', { index: offset + 1, geometry, segmentCount: artifact.segments.length });
  }
  for (const entry of [...artifact.stops, ...artifact.suspects]) {
    const clip = artifact.segments[entry.segmentIndex - 1]?.sourceCssClip;
    const centerY = entry.bounds.y + entry.bounds.height / 2;
    const isFinalSegment = entry.segmentIndex === artifact.segments.length;
    const clipBottom = clip ? clip.y + clip.height : null;
    if (!clip || centerY < clip.y - 1e-9 || (isFinalSegment ? centerY > clipBottom + 1e-9 : centerY >= clipBottom) ||
      entry.bounds.x + entry.bounds.width / 2 < clip.x - 1e-9 ||
      entry.bounds.x + entry.bounds.width / 2 > clip.x + clip.width + 1e-9) {
      throw new TypeError(`Item ${entry.number} diverge do recorte do segmento declarado.`);
    }
  }
  if (!exactKeys(artifact.counts, COUNT_KEYS) || !COUNT_KEYS.every(key => Number.isSafeInteger(artifact.counts[key]) && artifact.counts[key] >= 0) ||
    artifact.counts.stops !== artifact.stops.length || artifact.counts.suspects !== artifact.suspects.length ||
    artifact.counts.eligible !== artifact.counts.stops + artifact.counts.omittedNoRect + artifact.counts.omittedClipped + artifact.counts.omittedLimit ||
    artifact.counts.stops > KEYBOARD_MAP_LIMITS.maxStops || artifact.counts.suspects > KEYBOARD_MAP_LIMITS.maxSuspects) {
    throw new TypeError('Contagens do mapa do teclado inválidas.');
  }
  if (!exactKeys(artifact.limits, LIMIT_KEYS) || canonicalStringify(artifact.limits) !== canonicalStringify(KEYBOARD_MAP_LIMITS)) {
    throw new TypeError('Limites do mapa do teclado inválidos.');
  }
  if (!Array.isArray(artifact.limitations) || new Set(artifact.limitations).size !== artifact.limitations.length ||
    artifact.limitations.some(value => !KEYBOARD_MAP_LIMITATIONS.includes(value)) ||
    artifact.limitations.some((value, index) => KEYBOARD_MAP_LIMITATIONS.indexOf(value) < KEYBOARD_MAP_LIMITATIONS.indexOf(artifact.limitations[index - 1]))) {
    throw new TypeError('Limitações do mapa do teclado inválidas.');
  }
  if (KEYBOARD_MAP_REQUIRED_LIMITATIONS.some(value => !artifact.limitations.includes(value))) {
    throw new TypeError('Limitações obrigatórias do mapa do teclado estão ausentes.');
  }
  const hasFrame = artifact.limitations.includes('frame-content-omitted');
  const hasStopLimit = artifact.limitations.includes('stop-limit-reached');
  const hasSuspectLimit = artifact.limitations.includes('suspect-limit-reached');
  const hasClipped = artifact.limitations.includes('ancestor-clipped-stops-omitted');
  const hasCursorMissing = artifact.limitations.includes('cursor-style-not-collected');
  if (hasFrame !== (artifact.counts.omittedFrame > 0) ||
    hasClipped !== (artifact.counts.omittedClipped > 0) ||
    (artifact.counts.omittedLimit > 0) !== (hasStopLimit || hasSuspectLimit) ||
    (artifact.limitations.includes('cursor-style-not-collected') && artifact.suspects.some(entry => entry.reason === 'cursor-pointer'))) {
    throw new TypeError('Limitações e contagens do mapa do teclado são incoerentes.');
  }
  // Pixels omitidos pelo orçamento do lote não mudam o estado do mapa (como no mapa de anúncios): a omissão
  // já é declarada por `pixelState` e pelo diagnóstico do orçamento, e o mapa continua verificável.
  const expectedStatus = keyboardMapStatus({
    stops: artifact.stops, suspects: artifact.suspects, segments: artifact.segments,
    limitations: artifact.limitations,
  });
  if (artifact.status !== expectedStatus) {
    throw new TypeError('Estado do mapa do teclado diverge das contagens e limitações.');
  }
  return artifact;
}

export async function hashKeyboardMapArtifact(artifact, { sourceArtifact } = {}) {
  validateKeyboardMapArtifact(artifact, { sourceArtifact });
  const geometrySnapshotHash = await hashKeyboardMapGeometry(artifact.derivation.geometry);
  const segments = [];
  for (const segment of artifact.segments) {
    let contentHash = segment.contentHash;
    if (artifact.pixelState !== 'omitted-budget') {
      const png = decodePngDataUrl(segment.dataUrl, {
        maxBytes: KEYBOARD_MAP_LIMITS.maxDerivedBytes,
        maxDimension: KEYBOARD_MAP_LIMITS.maxDimension,
        maxPixels: KEYBOARD_MAP_LIMITS.maxCanvasPixels,
      });
      await validatePngRasterData(png.bytes, {
        maxBytes: KEYBOARD_MAP_LIMITS.maxDerivedBytes,
        maxDimension: KEYBOARD_MAP_LIMITS.maxDimension,
        maxPixels: KEYBOARD_MAP_LIMITS.maxCanvasPixels,
      });
      contentHash = await sha256Hex(png.bytes);
      if (contentHash !== segment.contentHash) throw new TypeError('Hash de segmento do mapa do teclado inválido.');
    }
    segments.push({
      segmentId: segment.segmentId, index: segment.index, count: segment.count, role: segment.role,
      sourceCssClip: segment.sourceCssClip, width: segment.width, height: segment.height, contentHash,
    });
  }
  if (artifact.pixelState !== 'omitted-budget' && sourceArtifact && sourceArtifact.pixelState !== 'omitted-budget') {
    const source = decodePngDataUrl(sourceArtifact.dataUrl, {
      maxBytes: KEYBOARD_MAP_LIMITS.maxDerivedBytes,
      maxDimension: KEYBOARD_MAP_LIMITS.maxDimension,
      maxPixels: KEYBOARD_MAP_LIMITS.maxSourcePixels,
    });
    await validatePngRasterData(source.bytes, {
      maxBytes: KEYBOARD_MAP_LIMITS.maxDerivedBytes,
      maxDimension: KEYBOARD_MAP_LIMITS.maxDimension,
      maxPixels: KEYBOARD_MAP_LIMITS.maxSourcePixels,
    });
    if (source.width !== artifact.derivation.geometry.sourcePixelSize.width ||
      source.height !== artifact.derivation.geometry.sourcePixelSize.height ||
      await sha256Hex(source.bytes) !== artifact.derivation.sourceHash) {
      throw new TypeError('PNG, dimensões ou hash da origem pristine do mapa do teclado são inválidos.');
    }
  }
  return sha256Hex(canonicalStringify({
    derivation: artifact.derivation,
    geometrySnapshotHash,
    status: artifact.status,
    segments,
    stops: artifact.stops,
    suspects: artifact.suspects,
    counts: artifact.counts,
    limits: artifact.limits,
    limitations: artifact.limitations,
  }));
}
