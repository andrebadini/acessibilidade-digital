import { projectElementAccessibility, isEditableAccessibilityNode } from '../core/accessibility/element-accessibility.js';
import { ancestorState, privacyTaintedNodeIds, privateMarker } from '../core/evidence/privacy-taint.js';
import { captureContentSize, usefulRect, visibleRect } from '../core/evidence/visible-geometry.js';
import { buildSnapshotIndexes } from '../core/snapshot-schema.js';
import {
  ANNOTATION_MAP_ALGORITHM,
  ANNOTATION_MAP_LEADER_MIN_PX,
  ANNOTATION_MAP_LIMITATIONS,
  ANNOTATION_MAP_LIMITS,
  ANNOTATION_MAP_PRINTABLE_ASPECT_RATIO,
  ANNOTATION_MAP_VERSION,
  annotationBadgeFont,
  annotationLeaderPoint,
  hashAnnotationMapArtifact,
  hashAnnotationMapGeometry,
} from '../core/evidence/annotation-map-artifact.js';
import { annotationMarkerLayout } from '../core/evidence/annotation-marker-layout.js';
import { decodePngDataUrl, pngDataUrlFromBytes, validatePngRasterData } from '../core/evidence/png.js';
import { sha256Hex } from '../core/report/hash.js';
import { compositionSupport } from './canvas-runtime.js';

export { ANNOTATION_MAP_ALGORITHM, ANNOTATION_MAP_LIMITS, ANNOTATION_MAP_VERSION };

export const ANNOTATION_MAP_MV3_GATE = Object.freeze({
  enabled: true,
  code: 'ANNOTATION_MAP_MV3_E2E_PASSED',
  reason: 'Composição local e relatório com mapa validados no percurso público MV3 com confirmação e quatro exportações.',
  testedBrowser: 'Google Chrome for Testing 152.0.7977.64',
});

const SIGNIFICANT_TAGS = new Set(['a', 'button', 'details', 'iframe', 'img', 'li', 'summary', 'table', 'video', 'audio']);
const SIGNIFICANT_ROLES = new Set([
  'button', 'checkbox', 'combobox', 'heading', 'iframe', 'img', 'link', 'list', 'listbox', 'listitem',
  'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'radio', 'region', 'slider', 'spinbutton',
  'switch', 'tab', 'table', 'textbox', 'treeitem',
]);
/**
 * Contêineres: quando já existe descendente anotado, uma anotação do contêiner englobaria vários
 * elementos e o número deixaria de apontar para um alvo único.
 */
const CONTAINER_TAGS = new Set(['details', 'li', 'table']);
const CONTAINER_ROLES = new Set(['list', 'listitem', 'region', 'table']);
const BASE_LIMITATIONS = Object.freeze([
  'observed-dom-ax-order-not-literal-assistive-technology',
  'non-atomic-source-geometry',
  'top-document-open-shadow-only',
  'rasterization-browser-dependent',
  'source-capture-may-contain-personal-data',
]);
/**
 * Etiqueta do mapa de leitura: caixa encostada ao elemento com o código curto (L1, L2…). A cor é a
 * mesma do contorno — o par caixa+etiqueta se lê de longe, sem depender de a pessoa achar o número.
 */
const MARKER_STROKE = '#8b1e1e';
const MARKER_OVERLAP_STROKE = '#6b4e00';
const BADGE_BG = '#8b1e1e';
const BADGE_OVERLAP_BG = '#6b4e00';
const BADGE_TEXT = '#ffffff';
const LEADER_LINE_WIDTH_CSS = 2;
const MAX_PREVIEW_CODE_POINTS = 4096;

export class AnnotationMapError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AnnotationMapError';
    this.code = code;
  }
}

const { throwIfAborted, operationWaiter, featureRuntime, waitForRasterValidation, canvasPng } = compositionSupport({
  createError: (code, message) => new AnnotationMapError(code, message),
  unavailableCode: 'ANNOTATION_MAP_COMPOSITOR_UNAVAILABLE',
  timeoutCode: 'ANNOTATION_MAP_TIMEOUT',
  outputInvalidCode: 'ANNOTATION_MAP_OUTPUT_INVALID',
});

function text(value) {
  return typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '';
}

function safeTag(node) {
  const value = text(node?.tagName).toLowerCase();
  return /^[a-z][a-z0-9-]{0,63}$/u.test(value) ? value : 'element';
}

function hasBooleanAttribute(node, name) {
  return Object.hasOwn(node?.attributes || {}, name);
}

/** Registra todos os ancestrais de um nó anotável, para saber quais contêineres já têm descendente. */
function markAncestorsOf(node, indexes, target) {
  const visited = new Set();
  let current = node?.parentId === null || node?.parentId === undefined ? null : indexes.byNodeId.get(String(node.parentId));
  while (current && !visited.has(String(current.nodeId))) {
    visited.add(String(current.nodeId));
    target.add(String(current.nodeId));
    current = current.parentId === null || current.parentId === undefined ? null : indexes.byNodeId.get(String(current.parentId));
  }
}

function closedShadow(node, indexes) {
  const rootId = typeof node?.shadowRootId === 'string' ? node.shadowRootId : null;
  const root = rootId ? indexes.byNodeId.get(rootId) : null;
  return root?.shadowRootType === 'closed' || ancestorState(node, indexes, current => current.shadowRootType === 'closed');
}

function significant(node, projection) {
  return Boolean(projection.announcementPreview && (SIGNIFICANT_ROLES.has(projection.role) || SIGNIFICANT_TAGS.has(safeTag(node))));
}

function nthPart(node, indexes) {
  const tag = safeTag(node);
  if (!node?.parentId) return tag;
  const parent = indexes.byNodeId.get(String(node.parentId));
  if (!parent || !Array.isArray(parent.children)) return tag;
  const siblings = parent.children.map(id => indexes.byNodeId.get(String(id))).filter(candidate => candidate && safeTag(candidate) === tag);
  if (siblings.length <= 1) return tag;
  const position = siblings.findIndex(candidate => String(candidate.nodeId) === String(node.nodeId));
  return `${tag}:nth-of-type(${Math.max(0, position) + 1})`;
}

function structuralSelector(node, indexes) {
  const parts = [];
  const visited = new Set();
  let current = node;
  let pendingShadowBoundary = false;
  while (current && !visited.has(String(current.nodeId))) {
    visited.add(String(current.nodeId));
    if (current.shadowRootType) {
      pendingShadowBoundary = true;
      current = current.parentId ? indexes.byNodeId.get(String(current.parentId)) : null;
      continue;
    }
    const part = nthPart(current, indexes);
    parts.unshift({ part, shadowAfter: pendingShadowBoundary });
    pendingShadowBoundary = false;
    current = current.parentId ? indexes.byNodeId.get(String(current.parentId)) : null;
  }
  let selector = '';
  for (const [index, entry] of parts.entries()) {
    if (index === 0) selector = entry.part;
    else selector += `${parts[index - 1].shadowAfter ? ' >>> ' : ' > '}${entry.part}`;
  }
  return selector || safeTag(node);
}

function canonicalLimitations(values) {
  const requested = new Set(values);
  return ANNOTATION_MAP_LIMITATIONS.filter(value => requested.has(value));
}

function omittedFrameContextCount(snapshot, observedPaths) {
  const topLevelHosts = snapshot.nodes.filter(node => safeTag(node) === 'iframe' &&
    (!Array.isArray(node.framePath) || node.framePath.length === 0)).length;
  const expectedCounts = ['runtime', 'accessibility'].map(kind => snapshot.document?.coverage?.[kind]?.expectedFrameCount)
    .filter(Number.isSafeInteger);
  const expectedChildren = Math.max(0, (expectedCounts.length ? Math.max(...expectedCounts) : 1) - 1);
  const warningFrames = new Set();
  let unknownWarningFrame = false;
  for (const warning of Array.isArray(snapshot.document?.warnings) ? snapshot.document.warnings : []) {
    if (!['AX_FRAME_UNAVAILABLE', 'FRAME_RUNTIME_BLOCKED', 'RUNTIME_FRAME_MISSING'].includes(warning?.code)) continue;
    if (typeof warning.frameId === 'string' || Number.isSafeInteger(warning.frameId)) warningFrames.add(String(warning.frameId));
    else unknownWarningFrame = true;
  }
  return Math.max(observedPaths.size, topLevelHosts, expectedChildren, warningFrames.size, unknownWarningFrame ? 1 : 0);
}

/** Selects the bounded observed DOM/AX projection without reading current editable values. */
export function selectAnnouncementMapEntries(snapshot, options = {}) {
  const indexes = buildSnapshotIndexes(snapshot);
  const privacyTainted = privacyTaintedNodeIds(snapshot, indexes);
  const maxNodes = Number.isSafeInteger(options.maxNodes) && options.maxNodes >= 0
    ? Math.min(options.maxNodes, ANNOTATION_MAP_LIMITS.maxNodes)
    : ANNOTATION_MAP_LIMITS.maxNodes;
  const entries = [];
  const counts = { eligible: 0, annotated: 0, omittedNoRect: 0, omittedFrame: 0, omittedLimit: 0, unresolvedOverlap: 0, omittedClipped: 0 };
  const limitations = new Set(['observed-dom-ax-order-not-literal-assistive-technology', 'top-document-open-shadow-only']);
  const dedupe = new Set();
  const omittedFrames = new Set();
  const candidates = [];
  const annotatedAncestorIds = new Set();
  let legendCodePoints = 0;
  let closedShadowOmitted = false;
  for (const node of snapshot.nodes) {
    if (Array.isArray(node.framePath) && node.framePath.length > 0) {
      omittedFrames.add(node.framePath.map(String).join('\u001f'));
      limitations.add('frame-content-omitted');
      continue;
    }
    if (closedShadow(node, indexes)) {
      closedShadowOmitted = true;
      continue;
    }
    if (ancestorState(node, indexes, current => current.hidden === true || hasBooleanAttribute(current, 'hidden') ||
      text(current.attributes?.['aria-hidden']).toLowerCase() === 'true' || hasBooleanAttribute(current, 'inert'))) continue;
    if (privacyTainted.has(String(node.nodeId)) ||
      ancestorState(node, indexes, current => isEditableAccessibilityNode(current) || privateMarker(current))) continue;
    const projection = projectElementAccessibility(node, indexes);
    if (!significant(node, projection)) continue;
    const key = String(node.nodeId);
    if (dedupe.has(key)) continue;
    dedupe.add(key);
    if (!usefulRect(node.rect)) {
      counts.omittedNoRect += 1;
      continue;
    }
    if (!visibleRect(node, indexes)) {
      counts.omittedClipped += 1;
      limitations.add('ancestor-clipped-elements-omitted');
      continue;
    }
    candidates.push({
      nodeId: key,
      selectorSummary: structuralSelector(node, indexes),
      announcementPreview: text(projection.announcementPreview),
      nameSource: text(projection.nameSource) || 'none',
      bounds: { x: node.rect.x, y: node.rect.y, width: node.rect.width, height: node.rect.height },
      container: CONTAINER_TAGS.has(safeTag(node)) || CONTAINER_ROLES.has(projection.role),
    });
    markAncestorsOf(node, indexes, annotatedAncestorIds);
  }
  // Contêineres com descendentes anotados saem antes de qualquer numeração: a caixa de um `<li>`,
  // `<table>`, `<details>` ou `role="region"` que já tem filhos anotados englobaria vários elementos
  // e o número deixaria de dizer qual deles está marcado.
  const kept = candidates.filter(candidate => !(candidate.container && annotatedAncestorIds.has(candidate.nodeId)));
  if (kept.length !== candidates.length) limitations.add('container-replaced-by-annotated-descendant');
  for (const candidate of kept) {
    const previewLength = [...`${candidate.selectorSummary}\n${candidate.announcementPreview}\n${candidate.nameSource}`].length;
    if (entries.length >= maxNodes || previewLength > MAX_PREVIEW_CODE_POINTS ||
      legendCodePoints + previewLength > ANNOTATION_MAP_LIMITS.maxLegendCodePoints) {
      counts.omittedLimit += 1;
      limitations.add(previewLength > MAX_PREVIEW_CODE_POINTS || legendCodePoints + previewLength > ANNOTATION_MAP_LIMITS.maxLegendCodePoints
        ? 'legend-limit-reached'
        : 'node-limit-reached');
      continue;
    }
    legendCodePoints += previewLength;
    entries.push({
      number: entries.length + 1,
      nodeId: candidate.nodeId,
      selectorSummary: candidate.selectorSummary,
      announcementPreview: candidate.announcementPreview,
      nameSource: candidate.nameSource,
      bounds: candidate.bounds,
    });
  }
  counts.omittedFrame = omittedFrameContextCount(snapshot, omittedFrames);
  if (counts.omittedFrame > 0) limitations.add('frame-content-omitted');
  if (closedShadowOmitted) limitations.add('closed-shadow-root-omitted');
  counts.annotated = entries.length;
  counts.eligible = kept.length + counts.omittedNoRect + counts.omittedClipped;
  return { entries, legend: entries.map(({ bounds, ...entry }) => entry), counts, limitations: canonicalLimitations(limitations) };
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function clippedBounds(bounds, width, height) {
  const x = clamp(bounds.x, 0, width);
  const y = clamp(bounds.y, 0, height);
  const right = clamp(bounds.x + bounds.width, x, width);
  const bottom = clamp(bounds.y + bounds.height, y, height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

/** Posicionamento das etiquetas: a mesma regra vale para este mapa e para o da conferência por Tab. */
function placeMarkers(entries, geometry, width, height) {
  return annotationMarkerLayout(entries, { width, height, cssWidth: geometry.cssWidth });
}

function maximumCanvasHeight(width) {
  return Math.max(1, Math.min(
    ANNOTATION_MAP_LIMITS.maxDimension,
    Math.floor(ANNOTATION_MAP_LIMITS.maxCanvasPixels / width),
    Math.floor(width * ANNOTATION_MAP_PRINTABLE_ASPECT_RATIO),
  ));
}

/**
 * Fatias imprimíveis da captura. Sem legenda raster, cada trecho é só imagem: a fatia é a própria faixa
 * do documento, na altura máxima que ainda cabe numa folha em pé. A legenda acompanha o trecho como
 * texto ao lado, no relatório, e não ocupa pixel de imagem.
 */
function segmentPlan(entries, geometry, sourceMetadata, segmentCssHeight) {
  const canvasHeight = maximumCanvasHeight(sourceMetadata.width);
  if (Math.ceil(sourceMetadata.height / ANNOTATION_MAP_LIMITS.maxSegments) > canvasHeight) {
    throw new AnnotationMapError(
      'ANNOTATION_MAP_PRINT_SEGMENT_LIMIT',
      'A proporção da captura não permite segmentos imprimíveis dentro do limite congelado.',
    );
  }
  const maximumImagePixels = Math.min(
    Math.max(1, ANNOTATION_MAP_LIMITS.maxDimension - 256),
    Math.floor(ANNOTATION_MAP_LIMITS.maxCanvasPixels / sourceMetadata.width),
    canvasHeight,
  );
  const defaultCssHeight = maximumImagePixels / geometry.scaleY;
  const requestedCssHeight = Number.isFinite(segmentCssHeight) && segmentCssHeight > 0 ? segmentCssHeight : defaultCssHeight;
  const minimumForCap = geometry.cssHeight / ANNOTATION_MAP_LIMITS.maxSegments;
  const minimumForRasterRow = 1 / geometry.scaleY;
  const cssHeight = Math.max(1, Math.min(
    geometry.cssHeight, defaultCssHeight,
    Math.max(requestedCssHeight, minimumForCap, minimumForRasterRow),
  ));
  const count = Math.max(1, Math.ceil(geometry.cssHeight / cssHeight));
  const segments = [];
  for (let index = 0; index < count; index += 1) {
    const y = index * cssHeight;
    const height = Math.min(cssHeight, geometry.cssHeight - y);
    const last = index === count - 1;
    const pixelY = index === 0 ? 0 : Math.round(y * geometry.scaleY);
    const pixelBottom = last ? sourceMetadata.height : Math.round((y + height) * geometry.scaleY);
    const assigned = entries.filter(entry => {
      const center = entry.bounds.y + entry.bounds.height / 2;
      return center >= y && (last ? center <= y + height : center < y + height);
    });
    const localized = assigned.map(entry => ({ ...entry, bounds: { ...entry.bounds, y: entry.bounds.y - y } }));
    const placement = placeMarkers(localized, geometry, geometry.cssWidth, height);
    segments.push({
      role: 'image', sourceCssClip: { x: 0, y, width: geometry.cssWidth, height },
      sourcePixelClip: { x: 0, y: pixelY, width: sourceMetadata.width, height: pixelBottom - pixelY },
      entryNumbers: assigned.map(entry => entry.number), placements: placement.placements,
      unresolvedOverlap: placement.unresolved,
    });
  }
  return segments;
}

/**
 * Builds deterministic geometry and a legend plan for the supplied text metrics.
 *
 * `sourceAligned: false` diz que a captura integral e a leitura estrutural descrevem leiautes
 * diferentes (ver `src/core/evidence/map-source-geometry.js`): os elementos elegíveis saem do mapa e
 * entram na contagem de "sem posição medida", com a limitação declarada. O mapa deste anúncio é a
 * própria marcação desenhada, então não há como manter a imagem sem marcador errado — e a alternativa
 * (marcar o lugar errado) é pior.
 */
export function buildAnnotationMapPlan({
  snapshot, sourceMetadata, layoutMetrics = {}, segmentCssHeight,
  sourceAligned = true,
} = {}) {
  if (!sourceMetadata || !Number.isFinite(sourceMetadata.width) || !Number.isFinite(sourceMetadata.height) ||
    sourceMetadata.width <= 0 || sourceMetadata.height <= 0 || sourceMetadata.width > ANNOTATION_MAP_LIMITS.maxDimension ||
    sourceMetadata.height > ANNOTATION_MAP_LIMITS.maxDimension || sourceMetadata.width * sourceMetadata.height > ANNOTATION_MAP_LIMITS.maxSourcePixels) {
    throw new AnnotationMapError('ANNOTATION_MAP_SOURCE_LIMIT', 'A captura original excede os limites do mapa visual.');
  }
  const selected = selectAnnouncementMapEntries(snapshot);
  const size = captureContentSize(layoutMetrics, sourceMetadata);
  const geometry = {
    cssWidth: size.cssWidth,
    cssHeight: size.cssHeight,
    scaleX: sourceMetadata.width / size.cssWidth,
    scaleY: sourceMetadata.height / size.cssHeight,
    deviceScaleFactor: size.deviceScaleFactor,
  };
  const limitations = new Set([...BASE_LIMITATIONS, ...selected.limitations]);
  if (Math.abs(geometry.scaleX - geometry.scaleY) / Math.max(geometry.scaleX, geometry.scaleY) > 0.01) limitations.add('non-uniform-pixel-scale');
  const boundsTrusted = sourceAligned !== false;
  if (!boundsTrusted && selected.entries.length > 0) limitations.add('source-layout-changed');
  const entries = [];
  let outside = 0;
  for (const entry of selected.entries) {
    if (!boundsTrusted) { outside += 1; continue; }
    const bounds = clippedBounds(entry.bounds, geometry.cssWidth, geometry.cssHeight);
    if (!bounds) { outside += 1; continue; }
    entries.push({ ...entry, number: entries.length + 1, bounds });
  }
  const counts = { ...selected.counts, annotated: entries.length, omittedNoRect: selected.counts.omittedNoRect + outside };
  counts.eligible = counts.annotated + counts.omittedNoRect + counts.omittedLimit + counts.omittedClipped;
  let segments = entries.length ? segmentPlan(entries, geometry, sourceMetadata, segmentCssHeight) : [];
  // Teto de segmentos: tira do fim, para a numeração da ordem de leitura continuar inteira de L1 a Ln.
  while (segments.length > ANNOTATION_MAP_LIMITS.maxSegments && entries.length) {
    entries.pop();
    counts.annotated -= 1;
    counts.omittedLimit += 1;
    limitations.add('node-limit-reached');
    segments = entries.length ? segmentPlan(entries, geometry, sourceMetadata, segmentCssHeight) : [];
  }
  counts.unresolvedOverlap = segments.reduce((total, segment) => total + segment.unresolvedOverlap, 0);
  if (counts.unresolvedOverlap) limitations.add('unresolved-marker-overlap');
  const segmentByNumber = new Map();
  segments.forEach((segment, index) => {
    segment.entryNumbers.forEach(number => segmentByNumber.set(number, index + 1));
  });
  const legend = entries.map(({ bounds, ...entry }) => ({ ...entry, segmentIndex: segmentByNumber.get(entry.number) }));
  return { geometry, entries, legend, counts, limits: ANNOTATION_MAP_LIMITS, limitations: canonicalLimitations(limitations), segments };
}

/** Cada segmento é só a faixa da imagem: a legenda vive no texto ao lado do trecho, não em pixel. */
function canvasHeightFor(segment, sourceWidth) {
  const imageHeight = segment.sourcePixelClip?.height ?? 0;
  return { imageHeight, height: imageHeight, width: sourceWidth };
}

function segmentOutlineRect(marker, geometry, dimensions) {
  const bounds = marker.bounds;
  if (!usefulRect(bounds)) return null;
  const imageHeight = Math.max(0, dimensions.imageHeight);
  const x = clamp(bounds.x * geometry.scaleX, 0, dimensions.width);
  const y = clamp(bounds.y * geometry.scaleY, 0, imageHeight);
  const right = clamp((bounds.x + bounds.width) * geometry.scaleX, x, dimensions.width);
  const bottom = clamp((bounds.y + bounds.height) * geometry.scaleY, y, imageHeight);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

/**
 * Ponta da linha-guia no próprio contorno desenhado, em px de imagem do segmento. O contorno aqui é o
 * retângulo recortado pelo segmento (`segmentOutlineRect`), e não a caixa do elemento no documento: a
 * linha termina exatamente sobre o traço que aparece na imagem. O mínimo de `annotationLeaderPoint` é
 * multiplicado pela escala para continuar valendo em px de documento, como na geometria canônica.
 */
function segmentLeaderPoint(marker, geometry, dimensions) {
  const rect = segmentOutlineRect(marker, geometry, dimensions);
  if (!rect) return null;
  const scale = Math.min(geometry.scaleX, geometry.scaleY);
  return annotationLeaderPoint(rect, marker.x * geometry.scaleX, marker.y * geometry.scaleY,
    ANNOTATION_MAP_LEADER_MIN_PX * scale);
}

function strokeRectPath(context, rect) {
  context.beginPath();
  context.moveTo(rect.x, rect.y);
  context.lineTo(rect.x + rect.width, rect.y);
  context.lineTo(rect.x + rect.width, rect.y + rect.height);
  context.lineTo(rect.x, rect.y + rect.height);
  context.lineTo(rect.x, rect.y);
  context.stroke();
}

/**
 * Contorno fino do elemento anotado, na mesma cor do marcador e com halo branco: liga visualmente o
 * número ao alvo sem depender só da linha-guia. Como no relatório, os halos de todos os contornos
 * saem antes dos traços coloridos, para um contorno colorido vizinho nunca ficar coberto.
 */
function drawElementOutlines(context, segment, plan, dimensions) {
  const outlines = segment.placements
    .map(marker => ({ marker, rect: segmentOutlineRect(marker, plan.geometry, dimensions) }))
    .filter(entry => entry.rect);
  if (!outlines.length) return;
  const strokeWidth = Math.max(2, Math.round(2 * Math.min(plan.geometry.scaleX, plan.geometry.scaleY)));
  context.strokeStyle = '#fff';
  context.lineWidth = strokeWidth + 4;
  for (const { rect } of outlines) strokeRectPath(context, rect);
  context.lineWidth = strokeWidth;
  for (const { marker, rect } of outlines) {
    context.strokeStyle = marker.overlapped ? MARKER_OVERLAP_STROKE : MARKER_STROKE;
    strokeRectPath(context, rect);
  }
}

/**
 * Caixa da etiqueta em px de imagem do segmento, com o arredondamento do canto. A etiqueta é desenhada
 * na escala da captura: cresce junto com a imagem, e continua legível quando o relatório reduz o trecho
 * para caber na folha.
 */
function badgeRect(marker, geometry, dimensions) {
  const scaleX = geometry.scaleX;
  const scaleY = geometry.scaleY;
  const width = marker.width * scaleX;
  const height = marker.height * scaleY;
  const box = {
    x: marker.x * scaleX - width / 2,
    y: marker.y * scaleY - height / 2,
    width, height,
  };
  if (!Number.isFinite(box.x) || !Number.isFinite(box.y) || width <= 0 || height <= 0) return null;
  const clampedX = clamp(box.x, 0, Math.max(0, dimensions.width - width));
  const clampedY = clamp(box.y, 0, Math.max(0, dimensions.imageHeight - height));
  return { ...box, x: clampedX, y: clampedY };
}

/** Ponto onde a linha-guia sai da etiqueta: a borda da caixa na direção do alvo, nunca o meio dela. */
function badgeEdgePoint(box, target) {
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const deltaX = target.x - center.x;
  const deltaY = target.y - center.y;
  if (deltaX === 0 && deltaY === 0) return center;
  const factorX = deltaX === 0 ? Infinity : (box.width / 2) / Math.abs(deltaX);
  const factorY = deltaY === 0 ? Infinity : (box.height / 2) / Math.abs(deltaY);
  const factor = Math.min(factorX, factorY);
  if (!Number.isFinite(factor)) return center;
  return { x: center.x + deltaX * factor, y: center.y + deltaY * factor };
}

function roundedRectPath(context, box, radius) {
  const corner = Math.max(0, Math.min(radius, box.width / 2, box.height / 2));
  context.beginPath();
  context.moveTo(box.x + corner, box.y);
  context.lineTo(box.x + box.width - corner, box.y);
  context.quadraticCurveTo(box.x + box.width, box.y, box.x + box.width, box.y + corner);
  context.lineTo(box.x + box.width, box.y + box.height - corner);
  context.quadraticCurveTo(box.x + box.width, box.y + box.height, box.x + box.width - corner, box.y + box.height);
  context.lineTo(box.x + corner, box.y + box.height);
  context.quadraticCurveTo(box.x, box.y + box.height, box.x, box.y + box.height - corner);
  context.lineTo(box.x, box.y + corner);
  context.quadraticCurveTo(box.x, box.y, box.x + corner, box.y);
  context.closePath();
}

function drawSegment(context, bitmap, segment, plan, dimensions) {
  context.fillStyle = '#fff';
  context.fillRect(0, 0, dimensions.width, dimensions.height);
  if (segment.sourceCssClip) {
    const { x: sx, y: sy, width: sw, height: sh } = segment.sourcePixelClip;
    context.drawImage(bitmap, sx, sy, sw, sh, 0, 0, dimensions.width, dimensions.imageHeight);
  }
  const scale = Math.min(plan.geometry.scaleX, plan.geometry.scaleY);
  drawElementOutlines(context, segment, plan, dimensions);
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  for (const marker of segment.placements) {
    const box = badgeRect(marker, plan.geometry, dimensions);
    if (!box) continue;
    const color = marker.overlapped ? BADGE_OVERLAP_BG : BADGE_BG;
    // Linha-guia curta: sai da borda da etiqueta e termina sobre o contorno do elemento. Quando a
    // etiqueta já encosta no alvo, a ponta devolvida é o próprio centro e nenhum traço é feito.
    const leader = segmentLeaderPoint(marker, plan.geometry, dimensions);
    if (leader) {
      const start = badgeEdgePoint(box, leader);
      if (Math.hypot(leader.x - start.x, leader.y - start.y) >= 2) {
        context.strokeStyle = color;
        context.lineWidth = Math.max(2, Math.round(LEADER_LINE_WIDTH_CSS * scale));
        context.beginPath(); context.moveTo(start.x, start.y); context.lineTo(leader.x, leader.y); context.stroke();
      }
    }
    context.fillStyle = color;
    context.lineWidth = Math.max(2, Math.round(2 * scale));
    roundedRectPath(context, box, Math.round(box.height * 0.28));
    context.fill();
    context.strokeStyle = '#fff';
    context.stroke();
    context.fillStyle = BADGE_TEXT;
    context.font = `700 ${Math.max(9, Math.round(annotationBadgeFont(marker.height) * scale))}px system-ui`;
    context.fillText(marker.code, box.x + box.width / 2, box.y + box.height / 2 + Math.round(scale));
  }
}

/** Composes one page map locally. It never mutates the page or the pristine source artifact. */
export async function composeAnnouncementMap({
  pageId, snapshot, fullPageEvidence, layoutMetrics = {}, sourceAligned = true, signal, runtime, timeoutMs,
} = {}) {
  throwIfAborted(signal);
  const worker = featureRuntime(runtime);
  const waitForOperation = operationWaiter(signal, timeoutMs);
  if (!fullPageEvidence || fullPageEvidence.kind !== 'full-page' || fullPageEvidence.state !== 'pristine' ||
    (fullPageEvidence.pageId !== undefined && fullPageEvidence.pageId !== pageId)) {
    throw new AnnotationMapError('ANNOTATION_MAP_SOURCE_INVALID', 'A captura original pristine da mesma página não está disponível.');
  }
  let source;
  try {
    source = decodePngDataUrl(fullPageEvidence.dataUrl, { maxBytes: ANNOTATION_MAP_LIMITS.maxDerivedBytes });
  } catch {
    throw new AnnotationMapError('ANNOTATION_MAP_SOURCE_INVALID', 'A captura original não contém um PNG local estritamente válido.');
  }
  if (source.width > ANNOTATION_MAP_LIMITS.maxDimension || source.height > ANNOTATION_MAP_LIMITS.maxDimension ||
    source.width * source.height > ANNOTATION_MAP_LIMITS.maxSourcePixels) {
    throw new AnnotationMapError('ANNOTATION_MAP_SOURCE_LIMIT', 'A captura original excede os limites do mapa visual.');
  }
  try {
    await waitForRasterValidation(waitForOperation, source.bytes, {
      maxBytes: ANNOTATION_MAP_LIMITS.maxDerivedBytes,
      maxDimension: ANNOTATION_MAP_LIMITS.maxDimension,
      maxPixels: ANNOTATION_MAP_LIMITS.maxSourcePixels,
    });
  } catch (error) {
    if (error instanceof AnnotationMapError || error?.name === 'AbortError') throw error;
    throw new AnnotationMapError('ANNOTATION_MAP_SOURCE_INVALID', 'A captura original não contém um PNG local estritamente válido.');
  }
  const sourceHash = await sha256Hex(source.bytes);
  if (sourceHash !== fullPageEvidence.hash) throw new AnnotationMapError('ANNOTATION_MAP_SOURCE_HASH_MISMATCH', 'O hash da captura original não corresponde aos pixels recebidos.');
  // Uma passada só: sem legenda raster não há texto para medir antes de desenhar.
  const plan = buildAnnotationMapPlan({
    snapshot, sourceMetadata: source, layoutMetrics, sourceAligned: sourceAligned !== false,
  });
  const placementByNumber = new Map();
  plan.segments.forEach((segment, index) => {
    for (const marker of segment.placements) placementByNumber.set(marker.number, {
      marker, segmentIndex: index + 1, clipY: segment.sourceCssClip.y,
    });
  });
  const geometry = {
    coordinateSpace: 'document-css-px',
    sourceCssSize: { width: plan.geometry.cssWidth, height: plan.geometry.cssHeight },
    sourcePixelSize: { width: source.width, height: source.height },
    scaleX: plan.geometry.scaleX,
    scaleY: plan.geometry.scaleY,
    deviceScaleFactor: plan.geometry.deviceScaleFactor,
    annotations: plan.entries.map(entry => {
      const placed = placementByNumber.get(entry.number);
      if (!placed) throw new AnnotationMapError('ANNOTATION_MAP_GEOMETRY_INVALID', 'Uma anotação não possui marcador no segmento de origem.');
      return {
        number: entry.number,
        nodeId: entry.nodeId,
        sourceRect: entry.bounds,
        marker: {
          x: placed.marker.x,
          y: placed.marker.y + placed.clipY,
          width: placed.marker.width,
          height: placed.marker.height,
          leaderX: placed.marker.leaderX,
          leaderY: placed.marker.leaderY + placed.clipY,
        },
        segmentIndex: placed.segmentIndex,
      };
    }),
  };
  const geometrySnapshotHash = await hashAnnotationMapGeometry(geometry);
  const evidenceDigest = await sha256Hex(`${pageId}\u0000${fullPageEvidence.evidenceId}\u0000${sourceHash}\u0000${geometrySnapshotHash}`);
  const evidenceId = `announcement-map-${evidenceDigest.slice(0, 32)}`;
  const derivation = {
    type: 'annotated-announcement-map', algorithm: ANNOTATION_MAP_ALGORITHM, version: ANNOTATION_MAP_VERSION,
    sourceEvidenceId: fullPageEvidence.evidenceId, sourceHash, geometrySnapshotHash, geometry,
  };
  if (!plan.entries.length) {
    const materiallyPartial = plan.counts.omittedNoRect > 0 || plan.counts.omittedFrame > 0 || plan.counts.omittedClipped > 0 ||
      plan.counts.omittedLimit > 0 || plan.counts.unresolvedOverlap > 0 || plan.limitations.includes('closed-shadow-root-omitted');
    const empty = {
      evidenceId, pageId, kind: 'announcement-map', state: 'derived', fullPageEvidenceId: fullPageEvidence.evidenceId,
      derivation, status: materiallyPartial ? 'partial' : 'empty', segments: [], legend: [], counts: plan.counts, limits: { ...ANNOTATION_MAP_LIMITS },
      limitations: plan.limitations, hash: '0'.repeat(64),
    };
    empty.hash = await hashAnnotationMapArtifact(empty);
    return empty;
  }

  throwIfAborted(signal);
  const bitmap = await waitForOperation(worker.createImageBitmap(new Blob([source.bytes], { type: 'image/png' })), {
    onLateValue: value => { try { value?.close?.(); } catch { /* Best-effort late bitmap cleanup. */ } },
  });
  const rendered = [];
  let derivedBytes = 0;
  try {
    for (const segment of plan.segments) {
      throwIfAborted(signal);
      const dimensions = canvasHeightFor(segment, source.width);
      if (dimensions.width > ANNOTATION_MAP_LIMITS.maxDimension || dimensions.height > ANNOTATION_MAP_LIMITS.maxDimension ||
        dimensions.width * dimensions.height > ANNOTATION_MAP_LIMITS.maxCanvasPixels) {
        throw new AnnotationMapError('ANNOTATION_MAP_SEGMENT_LIMIT', 'Um segmento do mapa excede os limites do compositor.');
      }
      const canvas = new worker.OffscreenCanvas(dimensions.width, dimensions.height);
      try {
        const context = canvas.getContext?.('2d', { alpha: false });
        if (!context) throw new AnnotationMapError('ANNOTATION_MAP_COMPOSITOR_UNAVAILABLE', 'O contexto 2D local não está disponível.');
        drawSegment(context, bitmap, segment, plan, dimensions);
        const bytes = await canvasPng(canvas, waitForOperation);
        let parsed;
        try {
          parsed = decodePngDataUrl(pngDataUrlFromBytes(bytes), {
            maxBytes: ANNOTATION_MAP_LIMITS.maxDerivedBytes,
            maxDimension: ANNOTATION_MAP_LIMITS.maxDimension,
            maxPixels: ANNOTATION_MAP_LIMITS.maxCanvasPixels,
          });
          await waitForRasterValidation(waitForOperation, parsed.bytes, {
            maxBytes: ANNOTATION_MAP_LIMITS.maxDerivedBytes,
            maxDimension: ANNOTATION_MAP_LIMITS.maxDimension,
            maxPixels: ANNOTATION_MAP_LIMITS.maxCanvasPixels,
          });
        } catch (error) {
          if (error instanceof AnnotationMapError || error?.name === 'AbortError') throw error;
          throw new AnnotationMapError('ANNOTATION_MAP_OUTPUT_INVALID', 'O compositor não retornou um PNG estritamente válido.');
        }
        if (parsed.width !== dimensions.width || parsed.height !== dimensions.height) {
          throw new AnnotationMapError('ANNOTATION_MAP_OUTPUT_INVALID', 'O PNG derivado não corresponde às dimensões do segmento solicitado.');
        }
        derivedBytes += parsed.bytes.length;
        if (derivedBytes > ANNOTATION_MAP_LIMITS.maxDerivedBytes) throw new AnnotationMapError('ANNOTATION_MAP_DERIVED_BYTES_LIMIT', 'Os segmentos derivados excedem o limite local de bytes.');
        rendered.push({
          role: segment.role, sourceCssClip: segment.sourceCssClip,
          width: parsed.width, height: parsed.height, dataUrl: pngDataUrlFromBytes(parsed.bytes),
          contentHash: await sha256Hex(parsed.bytes),
        });
      } finally {
        try { canvas.width = 0; canvas.height = 0; } catch { /* Best-effort release of backing storage. */ }
      }
    }
  } finally {
    try { bitmap?.close?.(); } catch { /* Best-effort release of worker bitmap. */ }
  }
  const segments = rendered.map((segment, offset) => ({
    segmentId: `${evidenceId}-segment-${offset + 1}`, index: offset + 1, count: rendered.length, ...segment,
  }));
  const materiallyPartial = plan.counts.omittedNoRect > 0 || plan.counts.omittedFrame > 0 || plan.counts.omittedClipped > 0 ||
    plan.counts.omittedLimit > 0 || plan.counts.unresolvedOverlap > 0 || plan.limitations.includes('closed-shadow-root-omitted');
  const artifact = {
    evidenceId, pageId, kind: 'announcement-map', state: 'derived', fullPageEvidenceId: fullPageEvidence.evidenceId,
    derivation, status: materiallyPartial ? 'partial' : 'complete', segments, legend: plan.legend,
    counts: plan.counts, limits: { ...ANNOTATION_MAP_LIMITS }, limitations: plan.limitations, hash: '0'.repeat(64),
  };
  artifact.hash = await hashAnnotationMapArtifact(artifact);
  return artifact;
}

/** Production entry point: fail closed until the compositor passes the real MV3 gate. */
export async function composeAnnouncementMapForProduction(input = {}) {
  if (!ANNOTATION_MAP_MV3_GATE.enabled) {
    throw new AnnotationMapError(ANNOTATION_MAP_MV3_GATE.code, ANNOTATION_MAP_MV3_GATE.reason);
  }
  return composeAnnouncementMap(input);
}
