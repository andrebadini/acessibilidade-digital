/**
 * Compositor do mapa do teclado: desenha, sobre a captura integral, uma caixa azul numerada em cada
 * parada de Tab e uma caixa laranja tracejada com "?" em cada suspeito de "parece clicável, mas o Tab
 * não chega".
 *
 * Segue o mesmo desenho do mapa de anúncios — segmentos imprimíveis, PNG conferido, hash e artefato
 * próprios —, mas sem legenda raster: quem explica os números é a lista em texto do relatório, que
 * fica legível para leitor de tela e para a lupa do navegador. O protocolo de tempo, cancelamento e
 * exportação vem de `canvas-runtime`, compartilhado com o mapa de anúncios.
 */
import { KEYBOARD_MAP_LIMITATIONS, selectKeyboardMapStops } from '../core/keyboard/keyboard-map-model.js';
import {
  KEYBOARD_MAP_ALGORITHM,
  KEYBOARD_MAP_LIMITS,
  KEYBOARD_MAP_PRINTABLE_ASPECT_RATIO,
  KEYBOARD_MAP_VERSION,
  hashKeyboardMapArtifact,
  hashKeyboardMapGeometry,
  keyboardMapStatus,
} from '../core/keyboard/keyboard-map-artifact.js';
import { decodePngDataUrl, pngDataUrlFromBytes } from '../core/evidence/png.js';
import { captureContentSize, usefulRect } from '../core/evidence/visible-geometry.js';
import { sha256Hex } from '../core/report/hash.js';
import { compositionSupport } from './canvas-runtime.js';

export { KEYBOARD_MAP_ALGORITHM, KEYBOARD_MAP_LIMITS, KEYBOARD_MAP_VERSION };

export const KEYBOARD_MAP_MV3_GATE = Object.freeze({
  enabled: true,
  code: 'KEYBOARD_MAP_MV3_E2E_PASSED',
  reason: 'Composição local e relatório com mapa do teclado validados no percurso público MV3 com confirmação e quatro exportações.',
  testedBrowser: 'Google Chrome for Testing 152.0.7977.64',
});

/** Azul sólido: onde o Tab para. Laranja tracejado: onde ele não chega. */
const STOP_COLOR = '#0b4fa8';
const SUSPECT_COLOR = '#b45309';
const BOX_HALO_COLOR = '#ffffff';
const BADGE_TEXT_COLOR = '#ffffff';
const BADGE_BASE_PX = 20;
const BADGE_GAP_PX = 4;
const MAX_BADGE_CANDIDATES = 96;

export class KeyboardMapError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'KeyboardMapError';
    this.code = code;
  }
}

const { throwIfAborted, operationWaiter, featureRuntime, waitForRasterValidation, canvasPng } = compositionSupport({
  createError: (code, message) => new KeyboardMapError(code, message),
  unavailableCode: 'KEYBOARD_MAP_COMPOSITOR_UNAVAILABLE',
  timeoutCode: 'KEYBOARD_MAP_TIMEOUT',
  outputInvalidCode: 'KEYBOARD_MAP_OUTPUT_INVALID',
});

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function canonicalLimitations(values) {
  const requested = new Set(values);
  return KEYBOARD_MAP_LIMITATIONS.filter(value => requested.has(value));
}

function sourceWithinLimits(source) {
  return Number.isFinite(source?.width) && Number.isFinite(source?.height) && source.width > 0 && source.height > 0 &&
    source.width <= KEYBOARD_MAP_LIMITS.maxDimension && source.height <= KEYBOARD_MAP_LIMITS.maxDimension &&
    source.width * source.height <= KEYBOARD_MAP_LIMITS.maxSourcePixels;
}

function outsideSource(bounds, cssWidth, cssHeight) {
  return bounds.x >= cssWidth || bounds.y >= cssHeight || bounds.x + bounds.width <= 0 || bounds.y + bounds.height <= 0;
}

/**
 * Recorte da caixa pela área capturada. Só é usado para itens que continuam na lista: no leiaute
 * confirmado, o pedaço visível do elemento; no leiaute reprovado, a posição estimada que o esquema
 * aceita. Nunca devolve retângulo degenerado nem fora da origem.
 */
function clippedBox(bounds, cssWidth, cssHeight) {
  const x = clamp(bounds.x, 0, Math.max(0, cssWidth - 1));
  const y = clamp(bounds.y, 0, Math.max(0, cssHeight - 1));
  const right = clamp(bounds.x + bounds.width, x + 1, cssWidth);
  const bottom = clamp(bounds.y + bounds.height, y + 1, cssHeight);
  return { x, y, width: right - x, height: bottom - y };
}

function maximumRasterSliceHeight(width) {
  return Math.max(1, Math.min(
    KEYBOARD_MAP_LIMITS.maxDimension,
    Math.floor(KEYBOARD_MAP_LIMITS.maxCanvasPixels / width),
    Math.floor(width * KEYBOARD_MAP_PRINTABLE_ASPECT_RATIO),
  ));
}

/**
 * Fatias imprimíveis da captura. Sem legenda raster, cada segmento é só imagem: a fatia é a própria
 * faixa do documento, na altura máxima que ainda cabe numa folha em pé.
 */
function segmentSlices(geometry, sourceMetadata, segmentCssHeight) {
  const rasterHeight = maximumRasterSliceHeight(sourceMetadata.width);
  if (Math.ceil(sourceMetadata.height / KEYBOARD_MAP_LIMITS.maxSegments) > rasterHeight) {
    throw new KeyboardMapError(
      'KEYBOARD_MAP_PRINT_SEGMENT_LIMIT',
      'A proporção da captura não permite segmentos imprimíveis dentro do limite congelado.',
    );
  }
  const defaultCssHeight = rasterHeight / geometry.scaleY;
  const requestedCssHeight = Number.isFinite(segmentCssHeight) && segmentCssHeight > 0 ? segmentCssHeight : defaultCssHeight;
  const minimumForCap = geometry.cssHeight / KEYBOARD_MAP_LIMITS.maxSegments;
  const minimumForRasterRow = 1 / geometry.scaleY;
  const cssHeight = Math.max(1, Math.min(
    geometry.cssHeight, defaultCssHeight,
    Math.max(requestedCssHeight, minimumForCap, minimumForRasterRow),
  ));
  const count = Math.max(1, Math.ceil(geometry.cssHeight / cssHeight));
  const slices = [];
  for (let index = 0; index < count; index += 1) {
    const y = index * cssHeight;
    const height = Math.min(cssHeight, geometry.cssHeight - y);
    const pixelY = index === 0 ? 0 : Math.round(y * geometry.scaleY);
    const pixelBottom = index === count - 1 ? sourceMetadata.height : Math.round((y + height) * geometry.scaleY);
    slices.push({
      last: index === count - 1,
      sourceCssClip: { x: 0, y, width: geometry.cssWidth, height },
      sourcePixelClip: { x: 0, y: pixelY, width: sourceMetadata.width, height: pixelBottom - pixelY },
    });
  }
  return slices;
}

function badgeSize(geometry) {
  return Math.max(BADGE_BASE_PX, Math.round(BADGE_BASE_PX * Math.min(geometry.scaleX, geometry.scaleY)));
}

function distanceSquared(left, right) {
  return (left.x - right.x) ** 2 + (left.y - right.y) ** 2;
}

/**
 * Posições candidatas para a etiqueta numerada, começando pelo canto superior esquerdo da própria
 * caixa e abrindo em anel: o número deve encostar no alvo antes de procurar lugar livre.
 */
function badgeCandidates(box, size, width, height) {
  const half = size / 2;
  const clampPoint = (x, y) => ({ x: clamp(x, 0, Math.max(0, width - size)), y: clamp(y, 0, Math.max(0, height - size)) });
  // Fora da caixa primeiro (à esquerda, acima, à direita, abaixo): o número encosta no alvo sem cobrir o
  // texto do próprio item, que é o que a pessoa leiga precisa ler para comparar com a página.
  const gap = 2;
  const points = [
    [box.x - size - gap, box.y + box.height / 2 - half], [box.x, box.y - size - gap],
    [box.x + box.width + gap, box.y + box.height / 2 - half], [box.x, box.y + box.height + gap],
    [box.x - size - gap, box.y - size - gap], [box.x + box.width - size, box.y - size - gap],
    [box.x, box.y], [box.x + box.width - size, box.y],
    [box.x, box.y + box.height - size], [box.x + box.width - size, box.y + box.height - size],
    [box.x + box.width / 2 - half, box.y], [box.x + box.width / 2 - half, box.y + box.height - size],
    [box.x, box.y + box.height / 2 - half], [box.x + box.width - size, box.y + box.height / 2 - half],
  ];
  const candidates = points.map(([x, y]) => clampPoint(x, y));
  const origin = clampPoint(box.x, box.y);
  const step = size + BADGE_GAP_PX;
  for (let ring = 1; ring <= 6 && candidates.length < MAX_BADGE_CANDIDATES; ring += 1) {
    for (let offset = -ring; offset <= ring && candidates.length < MAX_BADGE_CANDIDATES; offset += 1) {
      candidates.push(clampPoint(origin.x + offset * step, origin.y - ring * step));
      candidates.push(clampPoint(origin.x + offset * step, origin.y + ring * step));
    }
    for (let offset = -ring + 1; offset <= ring - 1 && candidates.length < MAX_BADGE_CANDIDATES; offset += 1) {
      candidates.push(clampPoint(origin.x - ring * step, origin.y + offset * step));
      candidates.push(clampPoint(origin.x + ring * step, origin.y + offset * step));
    }
  }
  const seen = new Set();
  return candidates.filter(candidate => {
    const key = `${candidate.x}:${candidate.y}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Coloca as etiquetas de uma fatia. A primeira candidata sem colisão vence — é o que mantém o custo
 * baixo numa página com centenas de paradas — e, quando todas colidem, fica a menos colidida.
 */
function placeBadges(entries, geometry, width, height) {
  const size = badgeSize(geometry);
  const clearance = size * 0.9;
  const placed = [];
  let unresolved = 0;
  const boxOf = entry => ({
    x: entry.bounds.x * geometry.scaleX,
    y: (entry.bounds.y - entry.sliceY) * geometry.scaleY,
    width: entry.bounds.width * geometry.scaleX,
    height: entry.bounds.height * geometry.scaleY,
  });
  const boxes = entries.map(boxOf);
  const overlaps = (candidate, rect) => candidate.x < rect.x + rect.width && candidate.x + size > rect.x &&
    candidate.y < rect.y + rect.height && candidate.y + size > rect.y;
  for (const [index, entry] of entries.entries()) {
    const box = boxes[index];
    if (!usefulRect(box)) continue;
    let selected = null;
    for (const candidate of badgeCandidates(box, size, width, height)) {
      const collisions = placed.reduce((total, other) => total + (distanceSquared(candidate, other) < clearance ** 2 ? 1 : 0), 0);
      // Custo: outra etiqueta pesa mais; cobrir outra caixa ou o próprio item pesa menos, mas conta.
      let cost = collisions * 100;
      for (const [other, rect] of boxes.entries()) {
        if (usefulRect(rect) && overlaps(candidate, rect)) cost += other === index ? 2 : 5;
      }
      if (!selected || cost < selected.cost) selected = { x: candidate.x, y: candidate.y, collisions, cost };
      if (cost === 0) break;
    }
    if (selected.collisions > 0) unresolved += 1;
    placed.push(selected);
    // A parada leva o número da ordem de Tab; o suspeito leva "?", como manda a legenda do relatório.
    entry.placement = {
      number: entry.number,
      label: entry.entryKind === 'stop' ? String(entry.number) : '?',
      kind: entry.entryKind,
      box,
      badge: { x: selected.x, y: selected.y, size },
    };
  }
  return unresolved;
}

/**
 * Plano determinístico do mapa: geometria, paradas, suspeitos, contagens e fatias com as caixas já
 * posicionadas em pixel de imagem. Nenhuma ida ao navegador acontece aqui.
 *
 * `sourceAligned: false` diz que a captura integral e a leitura estrutural descrevem leiautes
 * diferentes (ver `src/core/evidence/map-source-geometry.js`). Nesse caso as caixas não são
 * posicionadas nem desenhadas: a lista numerada continua inteira, o mapa declara a limitação e a
 * imagem sai sem marcação — melhor sem caixa do que com caixa no lugar errado.
 */
export function buildKeyboardMapPlan({
  snapshot, occurrences, sourceMetadata, layoutMetrics = {}, segmentCssHeight, sourceAligned = true,
} = {}) {
  if (!sourceWithinLimits(sourceMetadata)) {
    throw new KeyboardMapError('KEYBOARD_MAP_SOURCE_LIMIT', 'A captura original excede os limites do mapa do teclado.');
  }
  const selected = selectKeyboardMapStops(snapshot, { occurrences });
  const size = captureContentSize(layoutMetrics, sourceMetadata);
  const geometry = {
    cssWidth: size.cssWidth,
    cssHeight: size.cssHeight,
    scaleX: sourceMetadata.width / size.cssWidth,
    scaleY: sourceMetadata.height / size.cssHeight,
    deviceScaleFactor: size.deviceScaleFactor,
  };
  const limitations = new Set(selected.limitations);
  if (Math.abs(geometry.scaleX - geometry.scaleY) / Math.max(geometry.scaleX, geometry.scaleY) > 0.01) {
    limitations.add('non-uniform-pixel-scale');
  }
  const counts = { ...selected.counts };
  let anyOutsideSource = false;
  // Posição totalmente fora da captura não vira caixa no leiaute confirmado: encaixá-la na borda
  // desenharia um retângulo de 1 px num lugar onde o elemento não está. O item sai das caixas e entra
  // em `omittedNoRect`; a contagem de elegíveis não muda (ver `counts.eligible`).
  //
  // No leiaute reprovado (`sourceAligned: false`) NADA é desenhado: a lista continua completa e é ela
  // que informa o item. Aí a caixa guardada é só a posição estimada recortada pela área da imagem, para
  // o esquema fechado continuar válido — sem inventar uma caixa no lugar errado, porque não há desenho.
  const layoutRejected = sourceAligned !== true;
  const collectEntries = (entries, entryKind) => entries.flatMap(entry => {
    if (outsideSource(entry.bounds, geometry.cssWidth, geometry.cssHeight)) {
      if (layoutRejected) {
        return [{ ...entry, entryKind, bounds: clippedBox(entry.bounds, geometry.cssWidth, geometry.cssHeight) }];
      }
      counts.omittedNoRect += 1;
      anyOutsideSource = true;
      return [];
    }
    return [{
      ...entry,
      entryKind,
      bounds: clippedBox(entry.bounds, geometry.cssWidth, geometry.cssHeight),
    }];
  });
  let stops = collectEntries(selected.stops, 'stop').map((entry, offset) => ({ ...entry, number: offset + 1 }));
  let suspects = collectEntries(selected.suspects, 'suspect').map((entry, offset) => ({ ...entry, number: offset + 1 }));

  // Mesmo sem nenhuma caixa desenhável, a imagem continua no relatório quando existia item fora da
  // área: é ela que dá contexto à contagem de itens sem posição medida. Sem isso, uma página cujo único
  // item de Tab está fora da captura sairia como "nada alcançável pelo Tab".
  const buildSegments = () => stops.length === 0 && suspects.length === 0 && !anyOutsideSource
    ? []
    : segmentSlices(geometry, sourceMetadata, segmentCssHeight).map(slice => {
    const within = entry => {
      const center = entry.bounds.y + entry.bounds.height / 2;
      return center >= slice.sourceCssClip.y &&
        (slice.last ? center <= slice.sourceCssClip.y + slice.sourceCssClip.height : center < slice.sourceCssClip.y + slice.sourceCssClip.height);
    };
      const sliceStops = stops.filter(within).map(entry => ({ ...entry, sliceY: slice.sourceCssClip.y }));
      const sliceSuspects = suspects.filter(within).map(entry => ({ ...entry, sliceY: slice.sourceCssClip.y }));
      return {
        role: 'image', sourceCssClip: slice.sourceCssClip, sourcePixelClip: slice.sourcePixelClip,
        entries: [...sliceStops, ...sliceSuspects],
      };
    });
  let segments = buildSegments();
  // Teto de segmentos: tira do fim, para a numeração da ordem de Tab continuar inteira de 1 a N.
  while (segments.length > KEYBOARD_MAP_LIMITS.maxSegments && (stops.length > 0 || suspects.length > 0)) {
    if (suspects.length > 0) {
      suspects = suspects.slice(0, -1);
      limitations.add('suspect-limit-reached');
    } else {
      stops = stops.slice(0, -1);
      limitations.add('stop-limit-reached');
    }
    counts.omittedLimit += 1;
    segments = buildSegments();
  }
  // "A página mudou de tamanho" descreve a recusa do leiaute, não o que sobrou depois de tirar os itens
  // fora da área: mesmo que todos tenham ficado sem caixa, a razão de nenhuma caixa existir é a recusa.
  const hasEntries = selected.stops.length > 0 || selected.suspects.length > 0;
  const drawBoxes = sourceAligned === true && (stops.length > 0 || suspects.length > 0);
  if (!drawBoxes && hasEntries && sourceAligned !== true) limitations.add('source-layout-changed');
  // A omissão é um fato da lista, não do desenho: o item existe e ficou sem posição. No leiaute
  // reprovado (`sourceAligned: false`) nenhuma caixa sai por outro motivo e `source-layout-changed` já
  // explica o silêncio; dizer "sem posição medida" ali seria uma segunda explicação para a mesma coisa.
  if (anyOutsideSource && sourceAligned === true) limitations.add('stops-outside-source-omitted');
  let unresolved = 0;
  if (drawBoxes) {
    for (const segment of segments) {
      unresolved += placeBadges(segment.entries, geometry, segment.sourcePixelClip.width, segment.sourcePixelClip.height);
    }
  }
  if (unresolved > 0) limitations.add('badge-overlap-unresolved');
  const segmentIndexByNumber = new Map();
  segments.forEach((segment, index) => {
    for (const entry of segment.entries) segmentIndexByNumber.set(`${entry.entryKind}-${entry.number}`, index + 1);
  });
  counts.stops = stops.length;
  counts.suspects = suspects.length;
  counts.eligible = counts.stops + counts.omittedNoRect + counts.omittedClipped + counts.omittedLimit;
  const shared = (entry, offset, kind) => ({
    number: offset + 1,
    nodeId: entry.nodeId,
    tag: entry.tag,
    name: entry.name,
    nameSource: entry.nameSource,
    nameStatus: entry.nameStatus,
    bounds: entry.bounds,
    segmentIndex: segmentIndexByNumber.get(`${kind}-${offset + 1}`),
  });
  return {
    geometry,
    // `drawBoxes: false` é o caso "captura e leitura em leiautes diferentes": as fatias continuam
    // saindo (a imagem existe), os itens continuam listados, e nenhuma caixa é desenhada.
    drawBoxes,
    stops: stops.map((entry, offset) => ({
      ...shared(entry, offset, 'stop'), kind: entry.kind, tabIndex: entry.tabIndex,
    })),
    suspects: suspects.map((entry, offset) => ({
      ...shared(entry, offset, 'suspect'),
      role: entry.role, reason: entry.reason, ruleId: entry.ruleId,
    })),
    counts,
    limits: { ...KEYBOARD_MAP_LIMITS },
    limitations: canonicalLimitations(limitations),
    segments,
  };
}

function strokeBox(context, box, color, { dashed = false, scale = 1 } = {}) {
  const path = () => {
    context.beginPath();
    context.moveTo(box.x, box.y);
    context.lineTo(box.x + box.width, box.y);
    context.lineTo(box.x + box.width, box.y + box.height);
    context.lineTo(box.x, box.y + box.height);
    context.lineTo(box.x, box.y);
  };
  const width = Math.max(2, Math.round(3 * scale));
  context.setLineDash?.(dashed ? [Math.max(6, Math.round(8 * scale)), Math.max(4, Math.round(5 * scale))] : []);
  context.strokeStyle = BOX_HALO_COLOR;
  context.lineWidth = width + 4;
  path(); context.stroke();
  context.strokeStyle = color;
  context.lineWidth = width;
  path(); context.stroke();
  context.setLineDash?.([]);
}

/**
 * Desenha uma fatia: a imagem, as caixas dos suspeitos (tracejadas), as caixas das paradas (sólidas) e,
 * por cima de tudo, as etiquetas — o número da ordem de Tab e o "?" do suspeito.
 *
 * Sem caixas confiáveis (`plan.drawBoxes === false`) só a imagem é desenhada: é melhor não marcar do
 * que marcar o lugar errado.
 */
function drawSegment(context, bitmap, segment, plan) {
  const width = segment.sourcePixelClip.width;
  const height = segment.sourcePixelClip.height;
  const scale = Math.min(plan.geometry.scaleX, plan.geometry.scaleY);
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  context.drawImage(bitmap, 0, segment.sourcePixelClip.y, width, height, 0, 0, width, height);
  if (!plan.drawBoxes) return;
  for (const entry of segment.entries) {
    if (entry.entryKind === 'suspect') strokeBox(context, entry.placement.box, SUSPECT_COLOR, { dashed: true, scale });
  }
  for (const entry of segment.entries) {
    if (entry.entryKind === 'stop') strokeBox(context, entry.placement.box, STOP_COLOR, { scale });
  }
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  for (const entry of segment.entries) {
    const { badge } = entry.placement;
    context.font = `700 ${Math.max(10, Math.round(badge.size * 0.62))}px system-ui`;
    context.fillStyle = entry.entryKind === 'stop' ? STOP_COLOR : SUSPECT_COLOR;
    context.fillRect(badge.x, badge.y, badge.size, badge.size);
    context.strokeStyle = BOX_HALO_COLOR;
    context.lineWidth = 2;
    context.strokeRect?.(badge.x, badge.y, badge.size, badge.size);
    context.fillStyle = BADGE_TEXT_COLOR;
    context.fillText(entry.placement.label, badge.x + badge.size / 2, badge.y + badge.size / 2);
  }
}

/** Composes the keyboard map locally. It never mutates the page or the pristine source artifact. */
export async function composeKeyboardMap({
  pageId, snapshot, occurrences, fullPageEvidence, layoutMetrics = {}, segmentCssHeight, sourceAligned = true,
  signal, runtime, timeoutMs,
} = {}) {
  throwIfAborted(signal);
  const worker = featureRuntime(runtime);
  const waitForOperation = operationWaiter(signal, timeoutMs);
  if (!fullPageEvidence || fullPageEvidence.kind !== 'full-page' || fullPageEvidence.state !== 'pristine' ||
    (fullPageEvidence.pageId !== undefined && fullPageEvidence.pageId !== pageId)) {
    throw new KeyboardMapError('KEYBOARD_MAP_SOURCE_INVALID', 'A captura original pristine da mesma página não está disponível.');
  }
  let source;
  try {
    source = decodePngDataUrl(fullPageEvidence.dataUrl, { maxBytes: KEYBOARD_MAP_LIMITS.maxDerivedBytes });
  } catch {
    throw new KeyboardMapError('KEYBOARD_MAP_SOURCE_INVALID', 'A captura original não contém um PNG local estritamente válido.');
  }
  if (!sourceWithinLimits(source)) {
    throw new KeyboardMapError('KEYBOARD_MAP_SOURCE_LIMIT', 'A captura original excede os limites do mapa do teclado.');
  }
  try {
    await waitForRasterValidation(waitForOperation, source.bytes, {
      maxBytes: KEYBOARD_MAP_LIMITS.maxDerivedBytes,
      maxDimension: KEYBOARD_MAP_LIMITS.maxDimension,
      maxPixels: KEYBOARD_MAP_LIMITS.maxSourcePixels,
    });
  } catch (error) {
    if (error instanceof KeyboardMapError || error?.name === 'AbortError') throw error;
    throw new KeyboardMapError('KEYBOARD_MAP_SOURCE_INVALID', 'A captura original não contém um PNG local estritamente válido.');
  }
  const sourceHash = await sha256Hex(source.bytes);
  if (sourceHash !== fullPageEvidence.hash) {
    throw new KeyboardMapError('KEYBOARD_MAP_SOURCE_HASH_MISMATCH', 'O hash da captura original não corresponde aos pixels recebidos.');
  }
  const plan = buildKeyboardMapPlan({
    snapshot, occurrences, sourceMetadata: source, layoutMetrics, segmentCssHeight, sourceAligned: sourceAligned !== false,
  });
  const geometry = {
    coordinateSpace: 'document-css-px',
    sourceCssSize: { width: plan.geometry.cssWidth, height: plan.geometry.cssHeight },
    sourcePixelSize: { width: source.width, height: source.height },
    scaleX: plan.geometry.scaleX,
    scaleY: plan.geometry.scaleY,
    deviceScaleFactor: plan.geometry.deviceScaleFactor,
  };
  const geometrySnapshotHash = await hashKeyboardMapGeometry(geometry);
  const evidenceDigest = await sha256Hex(`${pageId}\u0000${fullPageEvidence.evidenceId}\u0000${sourceHash}\u0000${geometrySnapshotHash}`);
  const evidenceId = `keyboard-map-${evidenceDigest.slice(0, 32)}`;
  const derivation = {
    type: 'annotated-keyboard-map', algorithm: KEYBOARD_MAP_ALGORITHM, version: KEYBOARD_MAP_VERSION,
    sourceEvidenceId: fullPageEvidence.evidenceId, sourceHash, geometry,
  };
  const status = keyboardMapStatus({
    stops: plan.stops, suspects: plan.suspects, segments: plan.segments, limitations: plan.limitations,
  });
  if (status === 'empty') {
    const empty = {
      evidenceId, pageId, kind: 'keyboard-map', state: 'derived', fullPageEvidenceId: fullPageEvidence.evidenceId,
      derivation, status, segments: [], stops: [], suspects: [], counts: plan.counts, limits: { ...plan.limits },
      limitations: plan.limitations, hash: '0'.repeat(64),
    };
    empty.hash = await hashKeyboardMapArtifact(empty);
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
      const dimensions = { width: segment.sourcePixelClip.width, height: segment.sourcePixelClip.height };
      if (dimensions.width > KEYBOARD_MAP_LIMITS.maxDimension || dimensions.height > KEYBOARD_MAP_LIMITS.maxDimension ||
        dimensions.width * dimensions.height > KEYBOARD_MAP_LIMITS.maxCanvasPixels) {
        throw new KeyboardMapError('KEYBOARD_MAP_SEGMENT_LIMIT', 'Um segmento do mapa do teclado excede os limites do compositor.');
      }
      const canvas = new worker.OffscreenCanvas(dimensions.width, dimensions.height);
      try {
        const context = canvas.getContext?.('2d', { alpha: false });
        if (!context) throw new KeyboardMapError('KEYBOARD_MAP_COMPOSITOR_UNAVAILABLE', 'O contexto 2D local não está disponível.');
        drawSegment(context, bitmap, segment, plan);
        const bytes = await canvasPng(canvas, waitForOperation);
        let parsed;
        try {
          parsed = decodePngDataUrl(pngDataUrlFromBytes(bytes), {
            maxBytes: KEYBOARD_MAP_LIMITS.maxDerivedBytes,
            maxDimension: KEYBOARD_MAP_LIMITS.maxDimension,
            maxPixels: KEYBOARD_MAP_LIMITS.maxCanvasPixels,
          });
          await waitForRasterValidation(waitForOperation, parsed.bytes, {
            maxBytes: KEYBOARD_MAP_LIMITS.maxDerivedBytes,
            maxDimension: KEYBOARD_MAP_LIMITS.maxDimension,
            maxPixels: KEYBOARD_MAP_LIMITS.maxCanvasPixels,
          });
        } catch (error) {
          if (error instanceof KeyboardMapError || error?.name === 'AbortError') throw error;
          throw new KeyboardMapError('KEYBOARD_MAP_OUTPUT_INVALID', 'O compositor não retornou um PNG estritamente válido.');
        }
        if (parsed.width !== dimensions.width || parsed.height !== dimensions.height) {
          throw new KeyboardMapError('KEYBOARD_MAP_OUTPUT_INVALID', 'O PNG derivado não corresponde às dimensões do segmento solicitado.');
        }
        derivedBytes += parsed.bytes.length;
        if (derivedBytes > KEYBOARD_MAP_LIMITS.maxDerivedBytes) {
          throw new KeyboardMapError('KEYBOARD_MAP_DERIVED_BYTES_LIMIT', 'Os segmentos derivados excedem o limite local de bytes.');
        }
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
  const artifact = {
    evidenceId, pageId, kind: 'keyboard-map', state: 'derived', fullPageEvidenceId: fullPageEvidence.evidenceId,
    derivation, status: keyboardMapStatus({
      stops: plan.stops, suspects: plan.suspects, segments, limitations: plan.limitations,
    }),
    segments, stops: plan.stops, suspects: plan.suspects, counts: plan.counts, limits: { ...plan.limits },
    limitations: plan.limitations, hash: '0'.repeat(64),
  };
  artifact.hash = await hashKeyboardMapArtifact(artifact);
  return artifact;
}

/** Production entry point: fail closed until the compositor passes the real MV3 gate. */
export async function composeKeyboardMapForProduction(input = {}) {
  if (!KEYBOARD_MAP_MV3_GATE.enabled) {
    throw new KeyboardMapError(KEYBOARD_MAP_MV3_GATE.code, KEYBOARD_MAP_MV3_GATE.reason);
  }
  return composeKeyboardMap(input);
}
