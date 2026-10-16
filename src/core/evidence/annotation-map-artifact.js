import { canonicalStringify } from '../report/canonical-json.js';
import { sha256Hex } from '../report/hash.js';
import { decodePngDataUrl, pngDataUrlDecodedByteLength, validatePngRasterData } from './png.js';

export const ANNOTATION_MAP_ALGORITHM = 'audita.annotation-map';
export const ANNOTATION_MAP_VERSION = '1.3.0';

/**
 * Versões do algoritmo que esta revisão sabe **ler**, além de escrever. A 1.0.0 é a publicada na
 * 1.1.56 e continua aceita porque há auditorias guardadas nela: recusá-la faria o relatório de quem já
 * auditou parar de abrir. A 1.1.0 nunca foi publicada, então não tem regra de leitura — mapas novos
 * saem sempre na versão atual. A 1.2.0 (publicada na 1.1.61) é desenhada exatamente como a 1.3.0: o que
 * mudou na 1.3.0 foi a ORIGEM dos retângulos, medidos no mesmo leiaute da imagem (`fresh-geometry.js`) em
 * vez da leitura estrutural de segundos antes.
 */
export const ANNOTATION_MAP_READABLE_VERSIONS = Object.freeze(['1.0.0', '1.2.0', ANNOTATION_MAP_VERSION]);

/**
 * Comprimento mínimo da linha-guia, no mesmo sistema do retângulo recebido por `annotationLeaderPoint`
 * (px de documento para a geometria canônica, px de imagem do segmento para o desenho). Abaixo disso o
 * marcador já encosta no contorno: a linha não existiria como traço e só sujaria o alvo.
 */
export const ANNOTATION_MAP_LEADER_MIN_PX = 6;
export const ANNOTATION_MAP_PRINTABLE_ASPECT_RATIO = 1.3;
export const ANNOTATION_MAP_LIMITS = Object.freeze({
  maxNodes: 200,
  maxSourcePixels: 32_000_000,
  maxDimension: 8192,
  maxCanvasPixels: 32_000_000,
  maxSegments: 64,
  maxDerivedBytes: 64 * 1024 * 1024,
  maxLegendCodePoints: 256 * 1024,
});

export const ANNOTATION_MAP_LIMITATIONS = Object.freeze([
  'observed-dom-ax-order-not-literal-assistive-technology',
  'non-atomic-source-geometry',
  'top-document-open-shadow-only',
  'rasterization-browser-dependent',
  'source-capture-may-contain-personal-data',
  'frame-content-omitted',
  'closed-shadow-root-omitted',
  'container-replaced-by-annotated-descendant',
  'node-limit-reached',
  'legend-limit-reached',
  'unresolved-marker-overlap',
  'non-uniform-pixel-scale',
  // Acrescentada depois da 1.1.0, sempre no fim: a ordem canônica é a da lista, então anexar mantém
  // válidos os mapas já guardados.
  'ancestor-clipped-elements-omitted',
  'source-layout-changed',
]);

const SHA256 = /^[a-f0-9]{64}$/u;
const ID = /^[A-Za-z0-9._:-]{1,200}$/u;
const STRUCTURAL_SELECTOR = /^(?:[a-z][a-z0-9-]{0,63})(?::nth-of-type\([1-9]\d*\))?(?:(?: > | >>> )[a-z][a-z0-9-]{0,63}(?::nth-of-type\([1-9]\d*\))?)*$/u;
const MAP_KEYS = Object.freeze(['evidenceId', 'pageId', 'kind', 'state', 'fullPageEvidenceId', 'derivation', 'status', 'segments', 'legend', 'counts', 'limits', 'limitations', 'hash']);
const OMITTED_MAP_KEYS = Object.freeze([...MAP_KEYS, 'pixelState', 'pixelContentHash']);
const DERIVATION_KEYS = Object.freeze(['type', 'algorithm', 'version', 'sourceEvidenceId', 'sourceHash', 'geometrySnapshotHash', 'geometry']);
const GEOMETRY_KEYS = Object.freeze(['coordinateSpace', 'sourceCssSize', 'sourcePixelSize', 'scaleX', 'scaleY', 'deviceScaleFactor', 'annotations']);
const SIZE_KEYS = Object.freeze(['width', 'height']);
const ANNOTATION_KEYS = Object.freeze(['number', 'nodeId', 'sourceRect', 'marker', 'segmentIndex']);
const MARKER_KEYS = Object.freeze(['x', 'y', 'size', 'leaderX', 'leaderY']);
const SEGMENT_KEYS = Object.freeze(['segmentId', 'index', 'count', 'role', 'sourceCssClip', 'width', 'height', 'dataUrl', 'contentHash']);
const OMITTED_SEGMENT_KEYS = Object.freeze(SEGMENT_KEYS.filter(key => key !== 'dataUrl'));
const LEGEND_KEYS = Object.freeze(['number', 'nodeId', 'selectorSummary', 'announcementPreview', 'nameSource', 'segmentIndex']);
const COUNT_KEYS = Object.freeze(['eligible', 'annotated', 'omittedNoRect', 'omittedFrame', 'omittedLimit', 'unresolvedOverlap']);
/**
 * Contagem acrescentada depois da 1.1.0: mapas já guardados não a trazem e continuam válidos, então
 * ela é aceita quando presente e nunca exigida.
 */
const OPTIONAL_COUNT_KEYS = Object.freeze(['omittedClipped']);
const LIMIT_KEYS = Object.freeze(['maxNodes', 'maxSourcePixels', 'maxDimension', 'maxCanvasPixels', 'maxSegments', 'maxDerivedBytes', 'maxLegendCodePoints']);
const REQUIRED_LIMITATIONS = Object.freeze([
  'observed-dom-ax-order-not-literal-assistive-technology',
  'non-atomic-source-geometry',
  'top-document-open-shadow-only',
  'rasterization-browser-dependent',
  'source-capture-may-contain-personal-data',
]);

function clampValue(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

/**
 * Ponto de término da linha-guia, derivado do mesmo retângulo que o contorno desenha: o ponto da borda
 * mais próximo do marcador. `rect` é o contorno (caixa do elemento, e não a caixa expandida do relatório);
 * `x`/`y` são o centro do marcador.
 *
 * A ponta no centro do elemento riscava o conteúdo na diagonal (o título e o banner do alvo). Terminando
 * na borda, a linha encosta no contorno. Quando o marcador já está dentro do retângulo ou a menos de
 * `minimum` da borda, devolve o próprio marcador: linha de comprimento zero, que o desenho não traça — e
 * é o caso do alvo pequeno, em que o marcador cobre o elemento inteiro e qualquer traço sairia debaixo dele.
 */
export function annotationLeaderPoint(rect, x, y, minimum = ANNOTATION_MAP_LEADER_MIN_PX) {
  const pointX = clampValue(x, rect.x, rect.x + rect.width);
  const pointY = clampValue(y, rect.y, rect.y + rect.height);
  return Math.hypot(pointX - x, pointY - y) < minimum ? { x, y } : { x: pointX, y: pointY };
}

/** Linha-guia da 1.0.0: do marcador até o centro do alvo, como o mapa era desenhado na 1.1.56. */
function centeredLeaderPoint(sourceRect) {
  return { x: sourceRect.x + sourceRect.width / 2, y: sourceRect.y + sourceRect.height / 2 };
}

/**
 * Regras de leitura por versão do algoritmo. A versão declarada no artefato escolhe o conjunto, e
 * nenhuma delas é afrouxada para aceitar a outra: um mapa 1.0.0 com a ponta da linha-guia na borda
 * é tão inválido quanto um 1.3.0 com a ponta no centro. `omittedClipped` só existe a partir da 1.2.0,
 * então na 1.0.0 o conjunto de contagens é fechado sem ela — e a contagem vale zero.
 */
const MARKED_WITH_EDGE_LEADER = Object.freeze({
  leader: (sourceRect, marker) => annotationLeaderPoint(sourceRect, marker.x, marker.y),
  omittedClipped: true,
});

const READ_RULES = new Map([
  ['1.0.0', Object.freeze({ leader: (sourceRect) => centeredLeaderPoint(sourceRect), omittedClipped: false })],
  // A 1.2.0 e a 1.3.0 desenham igual; a diferença entre elas é de onde veio o retângulo, não o que o mapa
  // faz com ele. As duas entram com as mesmas regras, e nenhuma delas afrouxa a 1.0.0.
  ['1.2.0', MARKED_WITH_EDGE_LEADER],
  [ANNOTATION_MAP_VERSION, MARKED_WITH_EDGE_LEADER],
]);

function readRules(version) {
  const rules = typeof version === 'string' ? READ_RULES.get(version) : undefined;
  if (!rules) throw new TypeError(`Versão do algoritmo do mapa não reconhecida: ${String(version)}.`);
  return rules;
}

function nearlyEqual(left, right) {
  return Math.abs(left - right) <= Math.max(1, Math.abs(left), Math.abs(right)) * 1e-9;
}

function exactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    canonicalStringify(Object.keys(value).sort()) === canonicalStringify([...expected].sort());
}

/** Conjunto fechado com as chaves opcionais que o registro realmente traz, conforme a versão. */
function countKeys(counts, rules) {
  if (!rules.omittedClipped) return COUNT_KEYS;
  return [...COUNT_KEYS, ...OPTIONAL_COUNT_KEYS.filter(key => counts?.[key] !== undefined)];
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

function validateGeometry(geometry, { imageSegmentCount = null, version = ANNOTATION_MAP_VERSION } = {}) {
  const rules = readRules(version);
  if (!exactKeys(geometry, GEOMETRY_KEYS) || geometry.coordinateSpace !== 'document-css-px') {
    throw new TypeError('Geometria canônica do mapa inválida.');
  }
  validateSize(geometry.sourceCssSize, 'geometry.sourceCssSize');
  validateSize(geometry.sourcePixelSize, 'geometry.sourcePixelSize', { integer: true });
  finiteNumber(geometry.scaleX, 'geometry.scaleX', { positive: true });
  finiteNumber(geometry.scaleY, 'geometry.scaleY', { positive: true });
  if (geometry.deviceScaleFactor !== null) finiteNumber(geometry.deviceScaleFactor, 'geometry.deviceScaleFactor', { positive: true });
  if (geometry.sourcePixelSize.width !== Math.round(geometry.sourceCssSize.width * geometry.scaleX) ||
    geometry.sourcePixelSize.height !== Math.round(geometry.sourceCssSize.height * geometry.scaleY) ||
    geometry.sourcePixelSize.width > ANNOTATION_MAP_LIMITS.maxDimension ||
    geometry.sourcePixelSize.height > ANNOTATION_MAP_LIMITS.maxDimension ||
    geometry.sourcePixelSize.width * geometry.sourcePixelSize.height > ANNOTATION_MAP_LIMITS.maxSourcePixels ||
    !Array.isArray(geometry.annotations) || geometry.annotations.length > ANNOTATION_MAP_LIMITS.maxNodes) {
    throw new TypeError('Escala ou anotações da geometria do mapa inválidas.');
  }
  for (const [offset, annotation] of geometry.annotations.entries()) {
    const number = offset + 1;
    if (!exactKeys(annotation, ANNOTATION_KEYS) || annotation.number !== number ||
      !canonicalId(annotation.nodeId, `Geometria ${number}.nodeId`) || !exactKeys(annotation.marker, MARKER_KEYS)) {
      throw new TypeError(`Anotação geométrica ${number} inválida.`);
    }
    validateClip(annotation.sourceRect, `Geometria ${number}.sourceRect`);
    for (const key of MARKER_KEYS) finiteNumber(annotation.marker[key], `Geometria ${number}.marker.${key}`, { positive: key === 'size' });
    if (annotation.marker.size !== 28 || !Number.isSafeInteger(annotation.segmentIndex) || annotation.segmentIndex < 1 ||
      (imageSegmentCount !== null && annotation.segmentIndex > imageSegmentCount)) {
      throw new TypeError(`Marcador geométrico ${number} inválido.`);
    }
    const { sourceRect, marker } = annotation;
    const leader = rules.leader(sourceRect, marker);
    const within = (value, maximum) => value >= 0 && value <= maximum;
    if (!within(sourceRect.x, geometry.sourceCssSize.width) || !within(sourceRect.y, geometry.sourceCssSize.height) ||
      sourceRect.x + sourceRect.width > geometry.sourceCssSize.width || sourceRect.y + sourceRect.height > geometry.sourceCssSize.height ||
      !within(marker.x, geometry.sourceCssSize.width) || !within(marker.y, geometry.sourceCssSize.height) ||
      !nearlyEqual(marker.leaderX, leader.x) || !nearlyEqual(marker.leaderY, leader.y)) {
      throw new TypeError(`Bounds da anotação geométrica ${number} inválidos.`);
    }
  }
  return geometry;
}

export async function hashAnnotationMapGeometry(geometry, { version = ANNOTATION_MAP_VERSION } = {}) {
  return sha256Hex(canonicalStringify(validateGeometry(geometry, { version })));
}

/**
 * Valida um mapa guardado pelas regras da versão que ele próprio declara.
 *
 * A revisão escreve sempre `ANNOTATION_MAP_VERSION`, mas lê `ANNOTATION_MAP_READABLE_VERSIONS`: o mapa
 * da 1.1.56 (1.0.0) desenhava a linha-guia até o centro do alvo e não conhecia `counts.omittedClipped`.
 * Sem isso, abrir uma auditoria salva por aquela versão falharia na validação e o relatório não sairia.
 */
export function validateAnnotationMapArtifact(artifact, { sourceArtifact } = {}) {
  const pixelsOmitted = artifact?.pixelState === 'omitted-budget';
  if (!exactKeys(artifact, pixelsOmitted ? OMITTED_MAP_KEYS : MAP_KEYS) ||
    (pixelsOmitted && !SHA256.test(artifact.pixelContentHash)) ||
    artifact.kind !== 'announcement-map' || artifact.state !== 'derived') {
    throw new TypeError('Esquema do mapa de anúncios inválido.');
  }
  canonicalId(artifact.evidenceId, 'evidenceId do mapa');
  canonicalId(artifact.pageId, 'pageId do mapa');
  canonicalId(artifact.fullPageEvidenceId, 'fullPageEvidenceId do mapa');
  if (!SHA256.test(artifact.hash)) throw new TypeError('Hash do mapa inválido.');
  if (!exactKeys(artifact.derivation, DERIVATION_KEYS) ||
    artifact.derivation.type !== 'annotated-announcement-map' ||
    artifact.derivation.algorithm !== ANNOTATION_MAP_ALGORITHM ||
    artifact.derivation.sourceEvidenceId !== artifact.fullPageEvidenceId ||
    !SHA256.test(artifact.derivation.sourceHash) || !SHA256.test(artifact.derivation.geometrySnapshotHash)) {
    throw new TypeError('Derivação do mapa inválida.');
  }
  let rules;
  try {
    rules = readRules(artifact.derivation.version);
  } catch {
    throw new TypeError('Derivação do mapa inválida.');
  }
  if (sourceArtifact) {
    if (sourceArtifact.kind !== 'full-page' || sourceArtifact.state !== 'pristine' ||
      sourceArtifact.evidenceId !== artifact.fullPageEvidenceId || sourceArtifact.pageId !== artifact.pageId ||
      (sourceArtifact.pixelState === 'omitted-budget'
        ? sourceArtifact.pixelContentHash
        : sourceArtifact.hash) !== artifact.derivation.sourceHash) {
      throw new TypeError('Origem pristine do mapa inválida ou pertence a outra página.');
    }
  }
  if (!['complete', 'partial', 'empty'].includes(artifact.status) || !Array.isArray(artifact.segments) ||
    artifact.segments.length > ANNOTATION_MAP_LIMITS.maxSegments || !Array.isArray(artifact.legend)) {
    throw new TypeError('Estado ou coleções do mapa inválidos.');
  }
  const imageSegmentCount = artifact.segments.findIndex(segment => segment.role === 'legend-continuation') === -1
    ? artifact.segments.length
    : artifact.segments.findIndex(segment => segment.role === 'legend-continuation');
  validateGeometry(artifact.derivation.geometry, { imageSegmentCount, version: artifact.derivation.version });
  const segmentIds = new Set();
  let declaredDerivedBytes = 0;
  for (const segment of artifact.segments) {
    let byteLength;
    if (pixelsOmitted) byteLength = 0;
    else try { byteLength = pngDataUrlDecodedByteLength(segment?.dataUrl); } catch { throw new TypeError('Data URL PNG de segmento inválido.'); }
    declaredDerivedBytes += byteLength;
    if (!Number.isSafeInteger(declaredDerivedBytes) || declaredDerivedBytes > ANNOTATION_MAP_LIMITS.maxDerivedBytes) {
      throw new TypeError('Bytes derivados do mapa excedem o limite antes da decodificação.');
    }
  }
  let derivedBytes = 0;
  let sawContinuation = false;
  let expectedClipY = 0;
  for (const [offset, segment] of artifact.segments.entries()) {
    const index = offset + 1;
    if (!exactKeys(segment, pixelsOmitted ? OMITTED_SEGMENT_KEYS : SEGMENT_KEYS) ||
      segment.index !== index || segment.count !== artifact.segments.length ||
      segment.segmentId !== `${artifact.evidenceId}-segment-${index}` || segmentIds.has(segment.segmentId) ||
      !['image-and-legend', 'legend-continuation'].includes(segment.role) || !SHA256.test(segment.contentHash)) {
      throw new TypeError(`Segmento ${index} do mapa inválido.`);
    }
    segmentIds.add(segment.segmentId);
    if (segment.role === 'image-and-legend') {
      if (sawContinuation) throw new TypeError('Segmento de imagem não pode suceder continuação de legenda.');
      validateClip(segment.sourceCssClip, `Segmento ${index}.sourceCssClip`);
      if (!nearlyEqual(segment.sourceCssClip.x, 0) || !nearlyEqual(segment.sourceCssClip.y, expectedClipY) ||
        !nearlyEqual(segment.sourceCssClip.width, artifact.derivation.geometry.sourceCssSize.width) ||
        segment.sourceCssClip.y + segment.sourceCssClip.height > artifact.derivation.geometry.sourceCssSize.height + 1e-9) {
        throw new TypeError(`Recorte do segmento ${index} não é canônico.`);
      }
      expectedClipY += segment.sourceCssClip.height;
    } else {
      sawContinuation = true;
      if (segment.sourceCssClip !== null) throw new TypeError(`Segmento ${index} de continuação não pode declarar recorte.`);
    }
    let png = null;
    if (!pixelsOmitted) {
      const remainingBytes = ANNOTATION_MAP_LIMITS.maxDerivedBytes - derivedBytes;
      if (remainingBytes < 57) throw new TypeError('Bytes derivados do mapa excedem o limite.');
      png = decodePngDataUrl(segment.dataUrl, {
        maxBytes: remainingBytes,
        maxDimension: ANNOTATION_MAP_LIMITS.maxDimension,
        maxPixels: ANNOTATION_MAP_LIMITS.maxCanvasPixels,
      });
    }
    if ((!pixelsOmitted && (segment.width !== png.width || segment.height !== png.height)) ||
      segment.width !== artifact.derivation.geometry.sourcePixelSize.width) {
      throw new TypeError(`Dimensões do segmento ${index} divergem do PNG ou da origem.`);
    }
    if (segment.role === 'image-and-legend') {
      const pixelTop = Math.round(segment.sourceCssClip.y * artifact.derivation.geometry.scaleY);
      const pixelBottom = index === imageSegmentCount
        ? artifact.derivation.geometry.sourcePixelSize.height
        : Math.round((segment.sourceCssClip.y + segment.sourceCssClip.height) * artifact.derivation.geometry.scaleY);
      const sourceRasterHeight = pixelBottom - pixelTop;
      if (sourceRasterHeight < 1 || segment.height < sourceRasterHeight) {
        throw new TypeError(`Altura raster do segmento ${index} não contém o recorte de origem declarado.`);
      }
    }
    if (segment.height > Math.max(1, Math.floor(segment.width * ANNOTATION_MAP_PRINTABLE_ASPECT_RATIO))) {
      throw new TypeError(`Proporção imprimível do segmento ${index} excede o limite do algoritmo.`);
    }
    if (png) derivedBytes += png.bytes.length;
  }
  if (imageSegmentCount > 0 && !nearlyEqual(expectedClipY, artifact.derivation.geometry.sourceCssSize.height)) {
    throw new TypeError('Recortes do mapa não cobrem a altura canônica da origem.');
  }
  if (derivedBytes > ANNOTATION_MAP_LIMITS.maxDerivedBytes) throw new TypeError('Bytes derivados do mapa excedem o limite.');
  for (const annotation of artifact.derivation.geometry.annotations) {
    const segment = artifact.segments[annotation.segmentIndex - 1];
    const clip = segment?.sourceCssClip;
    const centerY = annotation.sourceRect.y + annotation.sourceRect.height / 2;
    const clipBottom = clip ? clip.y + clip.height : null;
    const isFinalImageSegment = annotation.segmentIndex === imageSegmentCount;
    if (segment?.role !== 'image-and-legend' || !clip ||
      centerY < clip.y - 1e-9 || (isFinalImageSegment ? centerY > clipBottom + 1e-9 : centerY >= clipBottom) ||
      annotation.marker.x < clip.x - 1e-9 || annotation.marker.x > clip.x + clip.width + 1e-9 ||
      annotation.marker.y < clip.y - 1e-9 ||
      (isFinalImageSegment ? annotation.marker.y > clipBottom + 1e-9 : annotation.marker.y >= clipBottom)) {
      throw new TypeError(`Anotação ${annotation.number} diverge do recorte do segmento declarado.`);
    }
  }
  let legendCodePoints = 0;
  for (const [offset, entry] of artifact.legend.entries()) {
    const number = offset + 1;
    if (!exactKeys(entry, LEGEND_KEYS) || entry.number !== number || !canonicalId(entry.nodeId, `Legenda ${number}.nodeId`) ||
      typeof entry.selectorSummary !== 'string' || !STRUCTURAL_SELECTOR.test(entry.selectorSummary) ||
      typeof entry.announcementPreview !== 'string' || !entry.announcementPreview || [...entry.announcementPreview].length > 4096 ||
      typeof entry.nameSource !== 'string' || !entry.nameSource || [...entry.nameSource].length > 80 ||
      !Number.isSafeInteger(entry.segmentIndex) || entry.segmentIndex < 1 || entry.segmentIndex > artifact.segments.length) {
      throw new TypeError(`Legenda ${number} do mapa inválida.`);
    }
    const annotation = artifact.derivation.geometry.annotations[offset];
    if (!annotation || annotation.number !== entry.number || annotation.nodeId !== entry.nodeId ||
      annotation.segmentIndex !== entry.segmentIndex || artifact.segments[entry.segmentIndex - 1]?.role !== 'image-and-legend') {
      throw new TypeError(`Legenda ${number} diverge da anotação geométrica.`);
    }
    legendCodePoints += [...entry.selectorSummary].length + [...entry.announcementPreview].length + [...entry.nameSource].length + 2;
    if (legendCodePoints > ANNOTATION_MAP_LIMITS.maxLegendCodePoints) {
      throw new TypeError('Legenda do mapa excede o limite agregado de pontos de código.');
    }
  }
  const omittedClipped = artifact.counts?.omittedClipped ?? 0;
  const allowedCountKeys = countKeys(artifact.counts, rules);
  if (!exactKeys(artifact.counts, allowedCountKeys) ||
    !allowedCountKeys.every(key => Number.isSafeInteger(artifact.counts[key]) && artifact.counts[key] >= 0) ||
    artifact.counts.annotated !== artifact.legend.length ||
    artifact.counts.eligible !== artifact.counts.annotated + artifact.counts.omittedNoRect + artifact.counts.omittedLimit + omittedClipped) {
    throw new TypeError('Contagens do mapa inválidas.');
  }
  if (!exactKeys(artifact.limits, LIMIT_KEYS) || canonicalStringify(artifact.limits) !== canonicalStringify(ANNOTATION_MAP_LIMITS)) {
    throw new TypeError('Limites do mapa inválidos.');
  }
  if (!Array.isArray(artifact.limitations) || new Set(artifact.limitations).size !== artifact.limitations.length ||
    artifact.limitations.some(value => !ANNOTATION_MAP_LIMITATIONS.includes(value)) ||
    artifact.limitations.some((value, index) => ANNOTATION_MAP_LIMITATIONS.indexOf(value) < ANNOTATION_MAP_LIMITATIONS.indexOf(artifact.limitations[index - 1]))) {
    throw new TypeError('Limitações do mapa inválidas.');
  }
  if (REQUIRED_LIMITATIONS.some(value => !artifact.limitations.includes(value))) {
    throw new TypeError('Limitações obrigatórias do mapa estão ausentes.');
  }
  const hasFrameLimitation = artifact.limitations.includes('frame-content-omitted');
  const hasNodeLimit = artifact.limitations.includes('node-limit-reached');
  const hasLegendLimit = artifact.limitations.includes('legend-limit-reached');
  const hasOverlap = artifact.limitations.includes('unresolved-marker-overlap');
  const hasClipped = artifact.limitations.includes('ancestor-clipped-elements-omitted');
  const nonUniformScale = Math.abs(artifact.derivation.geometry.scaleX - artifact.derivation.geometry.scaleY) /
    Math.max(artifact.derivation.geometry.scaleX, artifact.derivation.geometry.scaleY) > 0.01;
  if (hasFrameLimitation !== (artifact.counts.omittedFrame > 0) ||
    (artifact.counts.omittedLimit > 0) !== (hasNodeLimit || hasLegendLimit) ||
    (artifact.counts.omittedLimit === 0 && (hasNodeLimit || hasLegendLimit)) ||
    hasOverlap !== (artifact.counts.unresolvedOverlap > 0) ||
    hasClipped !== (omittedClipped > 0) ||
    artifact.limitations.includes('non-uniform-pixel-scale') !== nonUniformScale) {
    throw new TypeError('Limitações e contagens do mapa são incoerentes.');
  }
  if (artifact.derivation.geometry.annotations.length !== artifact.legend.length) throw new TypeError('Geometria e legenda têm quantidades divergentes.');
  if (artifact.status === 'empty' && (artifact.legend.length !== 0 || artifact.segments.length !== 0 ||
    artifact.counts.eligible !== 0 || artifact.counts.omittedFrame !== 0 || omittedClipped !== 0)) {
    throw new TypeError('Mapa vazio contém cobertura, segmentos ou legenda.');
  }
  if (artifact.status === 'complete' && (artifact.legend.length === 0 || artifact.segments.length === 0)) throw new TypeError('Mapa completo não contém segmentos ou legenda.');
  if (artifact.legend.length === 0 && artifact.segments.length !== 0) throw new TypeError('Mapa sem legenda não pode conter segmentos.');
  const materiallyPartial = artifact.counts.omittedNoRect > 0 || artifact.counts.omittedFrame > 0 || omittedClipped > 0 ||
    artifact.counts.omittedLimit > 0 || artifact.counts.unresolvedOverlap > 0 || artifact.limitations.includes('closed-shadow-root-omitted') ||
    artifact.limitations.includes('source-layout-changed');
  if ((artifact.status === 'partial') !== materiallyPartial) {
    throw new TypeError('Estado parcial do mapa diverge das contagens.');
  }
  return artifact;
}

export async function hashAnnotationMapArtifact(artifact, { sourceArtifact } = {}) {
  validateAnnotationMapArtifact(artifact, { sourceArtifact });
  if (sourceArtifact && sourceArtifact.pixelState !== 'omitted-budget') {
    const source = decodePngDataUrl(sourceArtifact.dataUrl, {
      maxBytes: ANNOTATION_MAP_LIMITS.maxDerivedBytes,
      maxDimension: ANNOTATION_MAP_LIMITS.maxDimension,
      maxPixels: ANNOTATION_MAP_LIMITS.maxSourcePixels,
    });
    await validatePngRasterData(source.bytes, {
      maxBytes: ANNOTATION_MAP_LIMITS.maxDerivedBytes,
      maxDimension: ANNOTATION_MAP_LIMITS.maxDimension,
      maxPixels: ANNOTATION_MAP_LIMITS.maxSourcePixels,
    });
    if (source.width !== artifact.derivation.geometry.sourcePixelSize.width ||
      source.height !== artifact.derivation.geometry.sourcePixelSize.height ||
      await sha256Hex(source.bytes) !== artifact.derivation.sourceHash) {
      throw new TypeError('PNG, dimensões ou hash da origem pristine do mapa são inválidos.');
    }
  }
  const geometrySnapshotHash = await hashAnnotationMapGeometry(artifact.derivation.geometry, { version: artifact.derivation.version });
  if (geometrySnapshotHash !== artifact.derivation.geometrySnapshotHash) throw new TypeError('Hash da geometria do mapa inválido.');
  const segments = [];
  for (const segment of artifact.segments) {
    let contentHash = segment.contentHash;
    if (artifact.pixelState !== 'omitted-budget') {
      const png = decodePngDataUrl(segment.dataUrl, {
        maxBytes: ANNOTATION_MAP_LIMITS.maxDerivedBytes,
        maxDimension: ANNOTATION_MAP_LIMITS.maxDimension,
        maxPixels: ANNOTATION_MAP_LIMITS.maxCanvasPixels,
      });
      await validatePngRasterData(png.bytes, {
        maxBytes: ANNOTATION_MAP_LIMITS.maxDerivedBytes,
        maxDimension: ANNOTATION_MAP_LIMITS.maxDimension,
        maxPixels: ANNOTATION_MAP_LIMITS.maxCanvasPixels,
      });
      contentHash = await sha256Hex(png.bytes);
      if (contentHash !== segment.contentHash) throw new TypeError('Hash de segmento do mapa inválido.');
    }
    segments.push({
      segmentId: segment.segmentId, index: segment.index, count: segment.count, role: segment.role,
      sourceCssClip: segment.sourceCssClip, width: segment.width, height: segment.height, contentHash,
    });
  }
  return sha256Hex(canonicalStringify({
    derivation: artifact.derivation,
    status: artifact.status,
    segments,
    legend: artifact.legend,
    counts: artifact.counts,
    limits: artifact.limits,
    limitations: artifact.limitations,
  }));
}
