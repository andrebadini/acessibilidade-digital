import { projectElementAccessibility, isEditableAccessibilityNode } from '../core/accessibility/element-accessibility.js';
import { buildSnapshotIndexes } from '../core/snapshot-schema.js';
import {
  ANNOTATION_MAP_ALGORITHM,
  ANNOTATION_MAP_LEADER_MIN_PX,
  ANNOTATION_MAP_LIMITATIONS,
  ANNOTATION_MAP_LIMITS,
  ANNOTATION_MAP_PRINTABLE_ASPECT_RATIO,
  ANNOTATION_MAP_VERSION,
  annotationLeaderPoint,
  hashAnnotationMapArtifact,
  hashAnnotationMapGeometry,
} from '../core/evidence/annotation-map-artifact.js';
import { decodePngDataUrl, pngDataUrlFromBytes, validatePngRasterData } from '../core/evidence/png.js';
import { sha256Hex } from '../core/report/hash.js';

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
const PRIVATE_ATTRIBUTE = /(?:^(?:data-(?:audita-)?private|data-nosnippet)$|pass(?:word|wd)?|token|secret|auth(?:orization)?|session|cookie|csrf|xsrf|otp|one[-_ ]?time|api[-_ ]?key)/iu;
const BASE_LIMITATIONS = Object.freeze([
  'observed-dom-ax-order-not-literal-assistive-technology',
  'non-atomic-source-geometry',
  'top-document-open-shadow-only',
  'rasterization-browser-dependent',
  'source-capture-may-contain-personal-data',
]);
const MARKER_RADIUS = 14;
const MARKER_CLEARANCE = MARKER_RADIUS * 2 + 4;
const MARKER_STROKE = '#8b1e1e';
const MARKER_OVERLAP_STROKE = '#6b4e00';
/** Peso de uma colisão no custo do marcador: proximidade nunca vale mais que uma sobreposição. */
const MARKER_COLLISION_COST = 1e6;
const LEGEND_LINE_HEIGHT = 22;
const LEGEND_PADDING = 16;
const LEGEND_HEADING_HEIGHT = 34;
const LEGEND_FONT = '15px system-ui';
const LEGEND_HEADING_FONT = '700 17px system-ui';
const MAX_PREVIEW_CODE_POINTS = 4096;

export class AnnotationMapError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AnnotationMapError';
    this.code = code;
  }
}

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

function privateMarker(node) {
  if (node?.privacyReferenceStatus === 'omitted-privacy') return true;
  for (const [name, value] of Object.entries(node?.attributes || {})) {
    if (PRIVATE_ATTRIBUTE.test(name) || String(value ?? '') === '[redacted]') return true;
  }
  return node?.valueStatus === 'omitted-privacy' && !['input', 'select', 'textarea'].includes(safeTag(node));
}

function ancestorState(node, indexes, predicate) {
  const visited = new Set();
  let current = node;
  while (current && !visited.has(String(current.nodeId))) {
    visited.add(String(current.nodeId));
    if (predicate(current)) return true;
    current = current.parentId === null || current.parentId === undefined ? null : indexes.byNodeId.get(String(current.parentId));
  }
  return false;
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

function usefulRect(rect) {
  return rect && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(rect[key])) && rect.width > 0 && rect.height > 0;
}

const CLIPPING_OVERFLOW = new Set(['auto', 'clip', 'hidden', 'scroll']);
/** Raízes de rolagem da página: a captura integral cobre o documento todo, então elas não escondem nada. */
const DOCUMENT_ROOT_TAGS = new Set(['body', 'html']);
/** Faixa mínima visível para valer uma anotação: menos que isto é o vinco do recorte, não o elemento. */
const CLIPPED_VISIBLE_MIN_PX = 1;

function styleValue(node, name) {
  const styles = node?.styles;
  if (!styles || typeof styles !== 'object') return '';
  const camel = name.replace(/-([a-z])/gu, (_match, letter) => letter.toUpperCase());
  return text(styles[name] ?? styles[camel]).toLowerCase();
}

/**
 * Ancestrais que recortam o próprio conteúdo — `overflow` diferente de `visible`.
 *
 * O instantâneo já traz o `overflow` computado de cada nó, então o recorte é deduzido do que foi
 * coletado: nenhuma ida extra ao navegador e nenhuma mudança na geometria declarada. A caixa usada é a
 * de borda, um pouco maior que a área realmente visível; erra para o lado de anotar demais, nunca para
 * o de esconder um elemento que aparece na imagem.
 *
 * Limitação conhecida: um descendente posicionado que escapa do recorte (por exemplo `position: fixed`
 * dentro de um contêiner com `overflow: hidden`) é tratado como recortado. O resultado é uma omissão a
 * mais, registrada na limitação do mapa, nunca uma marcação sobre o vazio.
 */
function clippingAncestorRects(node, indexes) {
  const rects = [];
  const visited = new Set();
  let current = node?.parentId === null || node?.parentId === undefined ? null : indexes.byNodeId.get(String(node.parentId));
  while (current && !visited.has(String(current.nodeId))) {
    visited.add(String(current.nodeId));
    if (!DOCUMENT_ROOT_TAGS.has(safeTag(current)) && usefulRect(current.rect) &&
      (CLIPPING_OVERFLOW.has(styleValue(current, 'overflow-x')) || CLIPPING_OVERFLOW.has(styleValue(current, 'overflow-y')))) {
      rects.push(current.rect);
    }
    current = current.parentId === null || current.parentId === undefined ? null : indexes.byNodeId.get(String(current.parentId));
  }
  return rects;
}

/**
 * Recorta o retângulo pelos ancestrais com rolagem. Retorna `null` quando nada de útil sobra: um
 * elemento guardado dentro do rolador aparece na captura integral, e marcar o lugar onde ele estaria
 * poria o número sobre outro conteúdo.
 */
function visibleRect(node, indexes) {
  let left = node.rect.x;
  let top = node.rect.y;
  let right = left + node.rect.width;
  let bottom = top + node.rect.height;
  for (const clip of clippingAncestorRects(node, indexes)) {
    left = Math.max(left, clip.x);
    top = Math.max(top, clip.y);
    right = Math.min(right, clip.x + clip.width);
    bottom = Math.min(bottom, clip.y + clip.height);
  }
  return right - left >= CLIPPED_VISIBLE_MIN_PX && bottom - top >= CLIPPED_VISIBLE_MIN_PX
    ? { x: left, y: top, width: right - left, height: bottom - top }
    : null;
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

function privacyTaintedNodeIds(snapshot, indexes) {
  const dependents = new Map();
  const addDependency = (source, consumer) => {
    const sourceId = String(source.nodeId);
    const values = dependents.get(sourceId) ?? new Set();
    values.add(String(consumer.nodeId));
    dependents.set(sourceId, values);
  };
  for (const node of snapshot.nodes) {
    for (const attribute of ['aria-labelledby', 'aria-describedby']) {
      const references = text(node.attributes?.[attribute]).split(' ').filter(Boolean);
      for (const reference of references) {
        const matches = indexes.byDomId.get(reference);
        for (const match of matches ?? []) addDependency(match, node);
      }
    }
    for (const labelId of Array.isArray(node.labels) ? node.labels : []) {
      const label = indexes.byNodeId.get(String(labelId));
      if (label) addDependency(label, node);
    }
    if (['button', 'input', 'meter', 'output', 'progress', 'select', 'textarea'].includes(safeTag(node))) {
      const visited = new Set();
      let ancestor = node.parentId === null || node.parentId === undefined
        ? null
        : indexes.byNodeId.get(String(node.parentId));
      while (ancestor && !visited.has(String(ancestor.nodeId))) {
        visited.add(String(ancestor.nodeId));
        if (safeTag(ancestor) === 'label') addDependency(ancestor, node);
        ancestor = ancestor.parentId === null || ancestor.parentId === undefined
          ? null
          : indexes.byNodeId.get(String(ancestor.parentId));
      }
    }
  }
  for (const label of snapshot.nodes.filter(node => safeTag(node) === 'label')) {
    const targetId = text(label.attributes?.for);
    const matches = targetId ? indexes.byDomId.get(targetId) : null;
    for (const match of matches ?? []) addDependency(label, match);
  }

  const tainted = new Set();
  const queue = [];
  const taintWithAncestors = node => {
    const visited = new Set();
    let current = node;
    while (current && !visited.has(String(current.nodeId))) {
      const nodeId = String(current.nodeId);
      visited.add(nodeId);
      if (!tainted.has(nodeId)) {
        tainted.add(nodeId);
        queue.push(nodeId);
      }
      current = current.parentId === null || current.parentId === undefined
        ? null
        : indexes.byNodeId.get(String(current.parentId));
    }
  };
  const taintSensitiveSubtree = root => {
    const pending = [root];
    const visited = new Set();
    for (let offset = 0; offset < pending.length; offset += 1) {
      const node = pending[offset];
      if (!node || visited.has(String(node.nodeId))) continue;
      visited.add(String(node.nodeId));
      taintWithAncestors(node);
      for (const childId of Array.isArray(node.children) ? node.children : []) {
        pending.push(indexes.byNodeId.get(String(childId)));
      }
    }
  };
  for (const node of snapshot.nodes) {
    if (isEditableAccessibilityNode(node) || privateMarker(node)) taintSensitiveSubtree(node);
  }
  for (let offset = 0; offset < queue.length; offset += 1) {
    for (const dependentId of dependents.get(queue[offset]) ?? []) {
      taintWithAncestors(indexes.byNodeId.get(dependentId));
    }
  }
  return tainted;
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

function observedContentSize(layoutMetrics, sourceMetadata) {
  const size = layoutMetrics?.cssContentSize || layoutMetrics?.contentSize || {};
  const cssWidth = Number.isFinite(size.width) && size.width > 0 ? size.width : sourceMetadata.width;
  const cssHeight = Number.isFinite(size.height) && size.height > 0 ? size.height : sourceMetadata.height;
  const deviceScaleFactor = Number.isFinite(layoutMetrics?.deviceScaleFactor) && layoutMetrics.deviceScaleFactor > 0
    ? layoutMetrics.deviceScaleFactor
    : null;
  return { cssWidth, cssHeight, deviceScaleFactor };
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

function boundedSpiralTrail(bounds, radius, width, height) {
  const inset = radius + 2;
  const horizontalInset = Math.min(inset, width / 2);
  const verticalInset = Math.min(inset, height / 2);
  const maximumX = Math.max(horizontalInset, width - horizontalInset);
  const maximumY = Math.max(verticalInset, height - verticalInset);
  const columns = Math.max(1, Math.floor((maximumX - horizontalInset) / MARKER_CLEARANCE) + 1);
  const rows = Math.max(1, Math.floor((maximumY - verticalInset) / MARKER_CLEARANCE) + 1);
  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;
  const originColumn = clamp(Math.round((centerX - horizontalInset) / MARKER_CLEARANCE), 0, columns - 1);
  const originRow = clamp(Math.round((centerY - verticalInset) / MARKER_CLEARANCE), 0, rows - 1);
  const maximumCandidates = Math.min(columns * rows, ANNOTATION_MAP_LIMITS.maxNodes * 4);
  const trail = [];
  const add = (column, row) => {
    if (column < 0 || column >= columns || row < 0 || row >= rows || trail.length >= maximumCandidates) return;
    trail.push({
      x: Math.min(maximumX, horizontalInset + column * MARKER_CLEARANCE),
      y: Math.min(maximumY, verticalInset + row * MARKER_CLEARANCE),
    });
  };
  for (let ring = 0; ring < Math.max(columns, rows) && trail.length < maximumCandidates; ring += 1) {
    if (ring === 0) { add(originColumn, originRow); continue; }
    for (let column = originColumn - ring; column <= originColumn + ring; column += 1) add(column, originRow - ring);
    for (let row = originRow - ring + 1; row <= originRow + ring; row += 1) add(originColumn + ring, row);
    for (let column = originColumn + ring - 1; column >= originColumn - ring; column -= 1) add(column, originRow + ring);
    for (let row = originRow + ring - 1; row > originRow - ring; row -= 1) add(originColumn - ring, row);
  }
  return trail;
}

function markerCandidates(bounds, radius, width, height) {
  const inset = radius + 2;
  const horizontalInset = Math.min(inset, width / 2);
  const verticalInset = Math.min(inset, height / 2);
  const points = [
    [bounds.x, bounds.y], [bounds.x + bounds.width, bounds.y],
    [bounds.x, bounds.y + bounds.height], [bounds.x + bounds.width, bounds.y + bounds.height],
    [bounds.x + bounds.width / 2, bounds.y], [bounds.x + bounds.width / 2, bounds.y + bounds.height],
    [bounds.x, bounds.y + bounds.height / 2], [bounds.x + bounds.width, bounds.y + bounds.height / 2],
  ];
  const candidates = points.map(([x, y]) => ({
    x: clamp(x, horizontalInset, Math.max(horizontalInset, width - horizontalInset)),
    y: clamp(y, verticalInset, Math.max(verticalInset, height - verticalInset)),
  }));
  candidates.push(...boundedSpiralTrail(bounds, radius, width, height));
  const seen = new Set();
  return candidates.filter(candidate => {
    const key = `${candidate.x}:${candidate.y}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function distanceSquared(a, b) {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
}

function placeMarkers(entries, width, height) {
  const placements = [];
  let unresolved = 0;
  for (const entry of entries) {
    // Custo = colisões (peso dominante, para a anticolisão continuar mandando) + distância até o canto
    // superior-esquerdo exterior do próprio elemento, que é a primeira candidata de `markerCandidates`.
    const anchor = { x: entry.bounds.x, y: entry.bounds.y };
    const candidates = markerCandidates(entry.bounds, MARKER_RADIUS, width, height);
    const scored = candidates.map((candidate, index) => {
      const collisions = placements.reduce((total, placed) => total + (distanceSquared(candidate, placed) < MARKER_CLEARANCE ** 2 ? 1 : 0), 0);
      return {
        ...candidate, index, collisions,
        score: collisions * MARKER_COLLISION_COST + Math.sqrt(distanceSquared(candidate, anchor)),
      };
    }).sort((left, right) => left.score - right.score || left.index - right.index);
    const selected = scored[0];
    if (selected.collisions > 0) unresolved += 1;
    // Ponta da linha-guia: a borda do contorno mais próxima do marcador, e não o centro do elemento —
    // a linha pelo centro riscava o conteúdo do alvo na diagonal. Se o marcador já encosta no contorno,
    // a ponta é o próprio marcador e o desenho não traça linha nenhuma.
    const leader = annotationLeaderPoint(entry.bounds, selected.x, selected.y);
    placements.push({
      number: entry.number, x: selected.x, y: selected.y,
      leaderX: leader.x, leaderY: leader.y,
      bounds: entry.bounds, overlapped: selected.collisions > 0,
    });
  }
  return { placements, unresolved };
}

function visibleAuditedText(value) {
  return String(value ?? '').replace(/[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu,
    character => `⟦U+${character.codePointAt(0).toString(16).toUpperCase()}⟧`);
}

function wrapLegend(entry, maxCharacters, measureText, maxWidth) {
  const prefix = `${entry.number} — ${entry.selectorSummary} — `;
  const source = visibleAuditedText(`${prefix}${entry.announcementPreview}`);
  const words = source.split(' ');
  const lines = [];
  let current = '';
  const fits = value => {
    if (!measureText) return [...value].length <= maxCharacters;
    const width = measureText(value);
    if (!Number.isFinite(width) || width < 0) {
      throw new AnnotationMapError('ANNOTATION_MAP_COMPOSITOR_UNAVAILABLE', 'O compositor não forneceu métricas de texto válidas.');
    }
    return width <= maxWidth + 0.01;
  };
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (fits(candidate)) { current = candidate; continue; }
    if (current) { lines.push(current); current = ''; }
    for (const codePoint of [...word]) {
      const token = `${current}${codePoint}`;
      if (fits(token)) { current = token; continue; }
      if (current) lines.push(current);
      if (!fits(codePoint)) {
        throw new AnnotationMapError('ANNOTATION_MAP_LEGEND_WIDTH_LIMIT', 'A largura da captura não comporta a legenda raster sem recorte.');
      }
      current = codePoint;
    }
  }
  if (current) lines.push(current);
  return lines.map((line, index) => ({ number: entry.number, text: line, continuation: index > 0 }));
}

function legendHeading(maxCharacters, measureText, maxWidth) {
  const candidates = ['Legenda da prévia de anúncios', 'Legenda', 'L'];
  if (!measureText) return candidates.find(value => [...value].length <= maxCharacters) || 'L';
  for (const candidate of candidates) {
    const width = measureText(candidate);
    if (!Number.isFinite(width) || width < 0) {
      throw new AnnotationMapError('ANNOTATION_MAP_COMPOSITOR_UNAVAILABLE', 'O compositor não forneceu métricas de título válidas.');
    }
    if (width <= maxWidth + 0.01) return candidate;
  }
  throw new AnnotationMapError('ANNOTATION_MAP_LEGEND_WIDTH_LIMIT', 'A largura da captura não comporta o título da legenda raster sem recorte.');
}

function maximumCanvasHeight(width) {
  return Math.max(1, Math.min(
    ANNOTATION_MAP_LIMITS.maxDimension,
    Math.floor(ANNOTATION_MAP_LIMITS.maxCanvasPixels / width),
    Math.floor(width * ANNOTATION_MAP_PRINTABLE_ASPECT_RATIO),
  ));
}

function legendCapacity(canvasHeight, imageHeight = 0) {
  const available = canvasHeight - imageHeight - LEGEND_HEADING_HEIGHT - LEGEND_PADDING * 2;
  return Math.max(0, Math.floor(available / LEGEND_LINE_HEIGHT));
}

function segmentPlan(entries, geometry, sourceMetadata, segmentCssHeight, measureLegendText, measureLegendHeading) {
  const canvasHeight = maximumCanvasHeight(sourceMetadata.width);
  if (Math.ceil(sourceMetadata.height / ANNOTATION_MAP_LIMITS.maxSegments) > canvasHeight) {
    throw new AnnotationMapError(
      'ANNOTATION_MAP_PRINT_SEGMENT_LIMIT',
      'A proporção da captura não permite segmentos imprimíveis dentro do limite congelado.',
    );
  }
  const maximumImagePixels = Math.min(
    Math.max(1, ANNOTATION_MAP_LIMITS.maxDimension - 512),
    Math.floor(ANNOTATION_MAP_LIMITS.maxCanvasPixels / sourceMetadata.width),
    canvasHeight,
  );
  const defaultCssHeight = maximumImagePixels / geometry.scaleY;
  const requestedCssHeight = Number.isFinite(segmentCssHeight) && segmentCssHeight > 0 ? segmentCssHeight : defaultCssHeight;
  const minimumForCap = geometry.cssHeight / ANNOTATION_MAP_LIMITS.maxSegments;
  const minimumForRasterRow = 1 / geometry.scaleY;
  const cssHeight = Math.max(1, Math.min(geometry.cssHeight, Math.max(requestedCssHeight, minimumForCap, minimumForRasterRow)));
  const count = Math.max(1, Math.ceil(geometry.cssHeight / cssHeight));
  const imageSegments = [];
  const maxCharacters = Math.max(12, Math.floor((sourceMetadata.width - LEGEND_PADDING * 2) / 7));
  const maximumTextWidth = Math.max(0, sourceMetadata.width - LEGEND_PADDING * 2);
  const heading = legendHeading(maxCharacters, measureLegendHeading, maximumTextWidth);
  for (let index = 0; index < count; index += 1) {
    const y = index * cssHeight;
    const height = Math.min(cssHeight, geometry.cssHeight - y);
    const nextY = index === count - 1 ? geometry.cssHeight : (index + 1) * cssHeight;
    const pixelY = index === 0 ? 0 : Math.round(y * geometry.scaleY);
    const pixelBottom = index === count - 1 ? sourceMetadata.height : Math.round(nextY * geometry.scaleY);
    const assigned = entries.filter(entry => {
      const center = entry.bounds.y + entry.bounds.height / 2;
      return center >= y && (index === count - 1 ? center <= y + height : center < y + height);
    });
    const localized = assigned.map(entry => ({ ...entry, bounds: { ...entry.bounds, y: entry.bounds.y - y } }));
    const placement = placeMarkers(localized, geometry.cssWidth, height);
    const legendLines = assigned.flatMap(entry => wrapLegend(entry, maxCharacters, measureLegendText, maximumTextWidth));
    imageSegments.push({
      role: 'image-and-legend', sourceCssClip: { x: 0, y, width: geometry.cssWidth, height },
      sourcePixelClip: { x: 0, y: pixelY, width: sourceMetadata.width, height: pixelBottom - pixelY },
      entryNumbers: assigned.map(entry => entry.number), placements: placement.placements, legendLines, legendHeading: heading,
      unresolvedOverlap: placement.unresolved,
    });
  }
  const overflow = [];
  for (const segment of imageSegments) {
    const imageHeight = segment.sourcePixelClip.height;
    const capacity = legendCapacity(canvasHeight, imageHeight);
    if (segment.legendLines.length > capacity) overflow.push(...segment.legendLines.splice(capacity));
  }
  const continuationCapacity = legendCapacity(canvasHeight);
  if (overflow.length && continuationCapacity === 0) {
    throw new AnnotationMapError(
      'ANNOTATION_MAP_LEGEND_PRINT_LIMIT',
      'A largura da captura não comporta uma linha de legenda em segmento imprimível.',
    );
  }
  const continuations = [];
  for (let offset = 0; offset < overflow.length; offset += continuationCapacity) {
    const legendLines = overflow.slice(offset, offset + continuationCapacity);
    continuations.push({
      role: 'legend-continuation', sourceCssClip: null,
      sourcePixelClip: null,
      entryNumbers: [...new Set(legendLines.map(line => line.number))], placements: [], legendLines, legendHeading: heading, unresolvedOverlap: 0,
    });
  }
  return [...imageSegments, ...continuations];
}

/** Builds deterministic geometry and a legend plan for the supplied text metrics. */
export function buildAnnotationMapPlan({
  snapshot, sourceMetadata, layoutMetrics = {}, segmentCssHeight, measureLegendText, measureLegendHeading,
} = {}) {
  if (!sourceMetadata || !Number.isFinite(sourceMetadata.width) || !Number.isFinite(sourceMetadata.height) ||
    sourceMetadata.width <= 0 || sourceMetadata.height <= 0 || sourceMetadata.width > ANNOTATION_MAP_LIMITS.maxDimension ||
    sourceMetadata.height > ANNOTATION_MAP_LIMITS.maxDimension || sourceMetadata.width * sourceMetadata.height > ANNOTATION_MAP_LIMITS.maxSourcePixels) {
    throw new AnnotationMapError('ANNOTATION_MAP_SOURCE_LIMIT', 'A captura original excede os limites do mapa visual.');
  }
  const selected = selectAnnouncementMapEntries(snapshot);
  const size = observedContentSize(layoutMetrics, sourceMetadata);
  const geometry = {
    cssWidth: size.cssWidth,
    cssHeight: size.cssHeight,
    scaleX: sourceMetadata.width / size.cssWidth,
    scaleY: sourceMetadata.height / size.cssHeight,
    deviceScaleFactor: size.deviceScaleFactor,
  };
  const limitations = new Set([...BASE_LIMITATIONS, ...selected.limitations]);
  if (Math.abs(geometry.scaleX - geometry.scaleY) / Math.max(geometry.scaleX, geometry.scaleY) > 0.01) limitations.add('non-uniform-pixel-scale');
  const entries = [];
  let outside = 0;
  for (const entry of selected.entries) {
    const bounds = clippedBounds(entry.bounds, geometry.cssWidth, geometry.cssHeight);
    if (!bounds) { outside += 1; continue; }
    entries.push({ ...entry, number: entries.length + 1, bounds });
  }
  const counts = { ...selected.counts, annotated: entries.length, omittedNoRect: selected.counts.omittedNoRect + outside };
  counts.eligible = counts.annotated + counts.omittedNoRect + counts.omittedLimit + counts.omittedClipped;
  if (measureLegendText !== undefined && typeof measureLegendText !== 'function') {
    throw new TypeError('A função de medição da legenda é inválida.');
  }
  if (measureLegendHeading !== undefined && typeof measureLegendHeading !== 'function') {
    throw new TypeError('A função de medição do título da legenda é inválida.');
  }
  let segments = entries.length
    ? segmentPlan(entries, geometry, sourceMetadata, segmentCssHeight, measureLegendText, measureLegendHeading)
    : [];
  while (segments.length > ANNOTATION_MAP_LIMITS.maxSegments && entries.length) {
    entries.pop();
    counts.annotated -= 1;
    counts.omittedLimit += 1;
    limitations.add('legend-limit-reached');
    segments = entries.length
      ? segmentPlan(entries, geometry, sourceMetadata, segmentCssHeight, measureLegendText, measureLegendHeading)
      : [];
  }
  counts.unresolvedOverlap = segments.reduce((total, segment) => total + segment.unresolvedOverlap, 0);
  if (counts.unresolvedOverlap) limitations.add('unresolved-marker-overlap');
  const segmentByNumber = new Map();
  segments.forEach((segment, index) => {
    if (segment.role !== 'image-and-legend') return;
    segment.entryNumbers.forEach(number => segmentByNumber.set(number, index + 1));
  });
  const legend = entries.map(({ bounds, ...entry }) => ({ ...entry, segmentIndex: segmentByNumber.get(entry.number) }));
  return { geometry, entries, legend, counts, limits: ANNOTATION_MAP_LIMITS, limitations: canonicalLimitations(limitations), segments };
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw signal.reason?.name === 'AbortError' ? signal.reason : new DOMException('Operação cancelada.', 'AbortError');
}

function operationWaiter(signal, timeoutMs) {
  const duration = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(Math.floor(timeoutMs), 60_000) : 15_000;
  const deadline = Date.now() + duration;
  return (operation, { onLateValue, onCancel } = {}) => new Promise((resolve, reject) => {
    if (signal?.aborted) {
      try { onCancel?.(signal.reason); } catch { /* Cancellation remains best-effort. */ }
      throwIfAborted(signal);
    }
    let settled = false;
    const remaining = deadline - Date.now();
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
    };
    const finish = (handler, value) => {
      if (settled) {
        if (handler === resolve) onLateValue?.(value);
        return;
      }
      settled = true;
      cleanup();
      handler(value);
    };
    const cancel = reason => {
      if (settled) return;
      try { onCancel?.(reason); } catch { /* Cancellation remains best-effort. */ }
      finish(reject, reason);
    };
    const onAbort = () => cancel(signal?.reason?.name === 'AbortError'
      ? signal.reason
      : new DOMException('Operação cancelada.', 'AbortError'));
    const timer = setTimeout(() => cancel(new AnnotationMapError(
      'ANNOTATION_MAP_TIMEOUT', 'O compositor local excedeu o tempo limite do mapa visual.',
    )), Math.max(0, remaining));
    signal?.addEventListener?.('abort', onAbort, { once: true });
    Promise.resolve(operation).then(value => finish(resolve, value), error => finish(reject, error));
  });
}

function featureRuntime(runtime) {
  const selected = runtime || globalThis;
  if (typeof selected.OffscreenCanvas !== 'function' || typeof selected.createImageBitmap !== 'function') {
    throw new AnnotationMapError('ANNOTATION_MAP_COMPOSITOR_UNAVAILABLE', 'O compositor local OffscreenCanvas não está disponível neste worker.');
  }
  if (typeof globalThis.DecompressionStream !== 'function' || typeof globalThis.ReadableStream !== 'function') {
    throw new AnnotationMapError('ANNOTATION_MAP_COMPOSITOR_UNAVAILABLE', 'A validação raster local não está disponível neste worker.');
  }
  return selected;
}

function waitForRasterValidation(waitForOperation, bytes, limits) {
  const controller = new AbortController();
  return waitForOperation(validatePngRasterData(bytes, { ...limits, signal: controller.signal }), {
    onCancel: reason => controller.abort(reason),
  });
}

function canvasHeightFor(segment, geometry, sourceWidth) {
  const imageHeight = segment.sourcePixelClip?.height ?? 0;
  const legendHeight = segment.legendLines.length
    ? LEGEND_HEADING_HEIGHT + LEGEND_PADDING * 2 + segment.legendLines.length * LEGEND_LINE_HEIGHT
    : 0;
  return { imageHeight, legendHeight, height: imageHeight + legendHeight, width: sourceWidth };
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

function drawSegment(context, bitmap, segment, plan, dimensions) {
  context.fillStyle = '#fff';
  context.fillRect(0, 0, dimensions.width, dimensions.height);
  if (segment.sourceCssClip) {
    const { x: sx, y: sy, width: sw, height: sh } = segment.sourcePixelClip;
    context.drawImage(bitmap, sx, sy, sw, sh, 0, 0, dimensions.width, dimensions.imageHeight);
  }
  context.font = '700 16px system-ui';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  const scale = Math.min(plan.geometry.scaleX, plan.geometry.scaleY);
  drawElementOutlines(context, segment, plan, dimensions);
  for (const marker of segment.placements) {
    const markerRadius = MARKER_RADIUS * scale;
    const x = marker.x * plan.geometry.scaleX;
    const y = marker.y * plan.geometry.scaleY;
    context.strokeStyle = marker.overlapped ? MARKER_OVERLAP_STROKE : MARKER_STROKE;
    context.lineWidth = Math.max(2, Math.round(3 * scale));
    // Sem contorno (ou já encostando nele) a linha-guia não é traçada: a ponta devolvida é o próprio
    // marcador, que só cobriria o alvo.
    const leader = segmentLeaderPoint(marker, plan.geometry, dimensions);
    if (leader && (leader.x !== x || leader.y !== y)) {
      context.beginPath(); context.moveTo(x, y); context.lineTo(leader.x, leader.y); context.stroke();
    }
    context.fillStyle = '#fff';
    context.beginPath(); context.arc(x, y, markerRadius, 0, Math.PI * 2); context.fill(); context.stroke();
    context.fillStyle = '#14212b';
    context.fillText(String(marker.number), x, y + 1);
  }
  if (!segment.legendLines.length) return;
  const legendTop = dimensions.imageHeight;
  context.fillStyle = segment.role === 'legend-continuation' ? '#fff' : '#eef4f8';
  context.fillRect(0, legendTop, dimensions.width, dimensions.legendHeight);
  context.fillStyle = '#003b71';
  context.textAlign = 'left';
  context.textBaseline = 'alphabetic';
  context.font = LEGEND_HEADING_FONT;
  context.fillText(segment.legendHeading, LEGEND_PADDING, legendTop + 26);
  context.fillStyle = '#14212b';
  context.font = '15px system-ui';
  segment.legendLines.forEach((line, index) => context.fillText(line.text, LEGEND_PADDING, legendTop + LEGEND_HEADING_HEIGHT + LEGEND_PADDING + index * LEGEND_LINE_HEIGHT));
}

async function canvasPng(canvas, waitForOperation) {
  if (typeof canvas.convertToBlob !== 'function') throw new AnnotationMapError('ANNOTATION_MAP_COMPOSITOR_UNAVAILABLE', 'O compositor local não oferece exportação PNG.');
  const blob = await waitForOperation(canvas.convertToBlob({ type: 'image/png' }));
  if (!(blob instanceof Blob) || blob.type !== 'image/png') throw new AnnotationMapError('ANNOTATION_MAP_OUTPUT_INVALID', 'O compositor não retornou PNG local válido.');
  return new Uint8Array(await waitForOperation(blob.arrayBuffer()));
}

/** Composes one page map locally. It never mutates the page or the pristine source artifact. */
export async function composeAnnouncementMap({ pageId, snapshot, fullPageEvidence, layoutMetrics = {}, signal, runtime, timeoutMs } = {}) {
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
  let plan = buildAnnotationMapPlan({ snapshot, sourceMetadata: source, layoutMetrics });
  if (plan.entries.length) {
    const measurementCanvas = new worker.OffscreenCanvas(1, 1);
    try {
      const measurementContext = measurementCanvas.getContext?.('2d', { alpha: false });
      if (!measurementContext || typeof measurementContext.measureText !== 'function') {
        throw new AnnotationMapError('ANNOTATION_MAP_COMPOSITOR_UNAVAILABLE', 'O contexto 2D local não oferece métricas de texto.');
      }
      measurementContext.font = LEGEND_FONT;
      plan = buildAnnotationMapPlan({
        snapshot, sourceMetadata: source, layoutMetrics,
        measureLegendText: value => {
          measurementContext.font = LEGEND_FONT;
          return measurementContext.measureText(value).width;
        },
        measureLegendHeading: value => {
          measurementContext.font = LEGEND_HEADING_FONT;
          return measurementContext.measureText(value).width;
        },
      });
    } finally {
      try { measurementCanvas.width = 0; measurementCanvas.height = 0; } catch { /* Best-effort release of text metrics canvas. */ }
    }
  }
  const placementByNumber = new Map();
  plan.segments.forEach((segment, index) => {
    if (segment.role !== 'image-and-legend') return;
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
          size: MARKER_RADIUS * 2,
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
      const dimensions = canvasHeightFor(segment, plan.geometry, source.width);
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
