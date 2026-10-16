/**
 * Recorte do elemento para o cartão da revisão guiada e para as fichas de evidência.
 *
 * Duas perguntas, dois passos, nesta ordem:
 *
 * 1. `elementCropSource` responde "onde está este elemento nas imagens guardadas?". A miniatura do
 *    elemento, quando existe, já traz o quadro em `metadata`; quando ela não existe (o teto de
 *    miniaturas por auditoria foi atingido ou a captura daquele elemento falhou), a posição é lida da
 *    geometria dos mapas — as anotações do mapa de anúncios e as paradas/suspeitas do mapa do teclado
 *    guardam `nodeId` e o retângulo do documento, e os segmentos guardam a faixa da página que cada
 *    imagem cobre. Sem geometria confiável a resposta é `null`: quem chama mostra o texto do elemento,
 *    nunca uma caixa adivinhada.
 *
 * 2. `evidenceMediaParts` transforma o artefato (real ou o sintético do passo 1) em peças de desenho.
 *    O cálculo da caixa, do escurecimento e do contorno continua sendo o de `evidence-highlight.js` —
 *    o mesmo do relatório —, aqui só se escolhe a janela (`viewBox`) que o recorte mostra.
 *
 * O recorte **não gera pixel novo**: a imagem guardada entra inteira no SVG e a janela é o `viewBox`,
 * como nos recortes das marcas da revisão guiada (`review-marks-presentation.js`).
 */

import { pngDataUrlDecodedByteLength } from '../evidence/png.js';
import { documentRectToSegmentPixels, intersectRects, segmentForDocumentPoint } from '../keyboard/keyboard-map-geometry.js';
import { evidenceHighlight, evidenceHighlightLegend, evidenceHighlightShapes } from './evidence-highlight.js';

/** Folga de contexto em volta do alvo, proporcional ao lado maior, com mínimo em pixels de imagem. */
export const EVIDENCE_CROP_PADDING_RATIO = 0.12;
export const EVIDENCE_CROP_MIN_PADDING = 24;

/** Tamanho de leitura: lado maior alvo do desenho, teto de ampliação e limites da caixa. */
export const EVIDENCE_CROP_TARGET_LONGEST_SIDE = 320;
export const EVIDENCE_CROP_MAX_DISPLAY_SCALE = 3;
export const EVIDENCE_CROP_MAX_WIDTH = 640;
export const EVIDENCE_CROP_MAX_HEIGHT = 420;

/**
 * Teto do PNG de origem do recorte, em bytes decodificados. O recorte reaproveita a imagem do trecho
 * guardada na auditoria; um trecho de página muito alta pesaria na memória da aba de revisão sem
 * ganho de leitura. Passado o teto, o cartão mostra o texto do elemento em vez do recorte.
 */
export const EVIDENCE_CROP_MAX_DECODED_BYTES = 8 * 1024 * 1024;

/** Frase que diz de onde o recorte veio, quando ele não é a própria miniatura do elemento. */
export const EVIDENCE_CROP_REGION_LEGEND = 'Recorte tirado da captura da página inteira desta auditoria.';

/**
 * Primeira frase do texto alternativo do recorte: onde ele fica na página. Fica aqui, e não em cada
 * tela, porque a página de conferência e o relatório exportado mostram a MESMA imagem e precisam dizer
 * a mesma coisa a quem usa leitor de tela.
 */
export const EVIDENCE_CROP_PAGE_ORIGIN_ARIA = 'Recorte da captura da página inteira, na região do elemento desta pergunta.';
export const EVIDENCE_CROP_ELEMENT_ORIGIN_ARIA = 'Recorte da captura do elemento desta pergunta.';

const CROP_SOURCE_KINDS = Object.freeze(['announcement-map', 'keyboard-map']);
const PNG_PREFIX = 'data:image/png;base64,';

function positiveRect(value) {
  return Boolean(value) && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(value[key])) &&
    value.width > 0 && value.height > 0 ? { x: value.x, y: value.y, width: value.width, height: value.height } : null;
}

/**
 * PNG local de tamanho aceitável para entrar como imagem do recorte.
 *
 * A conferência de tamanho percorre a base64 inteira, então o resultado fica guardado por data URL: os
 * recortes de todos os elementos de um trecho compartilham a mesma imagem, e sem o cache o custo seria
 * proporcional ao número de elementos da página.
 */
const USABLE_IMAGE_CACHE = new Map();
const USABLE_IMAGE_CACHE_LIMIT = 64;

function usableImage(value) {
  if (USABLE_IMAGE_CACHE.has(value)) return USABLE_IMAGE_CACHE.get(value);
  let usable = false;
  if (typeof value === 'string' && value.startsWith(PNG_PREFIX)) {
    try { usable = pngDataUrlDecodedByteLength(value) <= EVIDENCE_CROP_MAX_DECODED_BYTES; } catch { usable = false; }
  }
  if (USABLE_IMAGE_CACHE.size >= USABLE_IMAGE_CACHE_LIMIT) USABLE_IMAGE_CACHE.clear();
  USABLE_IMAGE_CACHE.set(value, usable);
  return usable;
}

/**
 * Entradas de geometria de um mapa, na forma `{ nodeId, rect, geometry }`: o mapa de anúncios nomeia o
 * `nodeId` na anotação e o trecho em `sourceRect`; o mapa do teclado nomeia o `nodeId` na parada (ou na
 * suspeita) e o retângulo em `bounds`.
 */
function mapTargets(map) {
  if (map?.kind === 'announcement-map') {
    const geometry = map?.derivation?.geometry ?? null;
    return (geometry?.annotations ?? []).map(value => ({ nodeId: value?.nodeId, rect: value?.sourceRect, geometry }));
  }
  const geometry = map?.derivation?.geometry ?? null;
  return [...(map?.stops ?? []), ...(map?.suspects ?? [])].map(value => ({ nodeId: value?.nodeId, rect: value?.bounds, geometry }));
}

/**
 * Janela do recorte: o alvo visível dentro do trecho mais uma folga de contexto, limitada à imagem.
 * Sem folga, um botão de 20 px chegaria colado na borda e quem lê não saberia onde aquilo fica.
 */
export function evidenceCropWindow(rect, bounds) {
  const target = positiveRect(rect);
  const frame = positiveRect(bounds) ?? (Number.isFinite(bounds?.width) && Number.isFinite(bounds?.height)
    ? { x: 0, y: 0, width: bounds.width, height: bounds.height } : null);
  if (!target || !frame) return null;
  const padding = Math.max(EVIDENCE_CROP_MIN_PADDING, Math.round(Math.max(target.width, target.height) * EVIDENCE_CROP_PADDING_RATIO));
  const x = Math.max(0, target.x - padding);
  const y = Math.max(0, target.y - padding);
  const right = Math.min(frame.width, target.x + target.width + padding);
  const bottom = Math.min(frame.height, target.y + target.height + padding);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

/**
 * Tamanho de leitura do recorte, sem distorção: a mesma proporção da janela. Quem amplia (a caixa de
 * diálogo do cartão) passa limites maiores; o padrão é o tamanho do cartão.
 */
export function evidenceCropDisplaySize(view, limits = {}) {
  const width = Number.isFinite(view?.width) && view.width > 0 ? view.width : 0;
  const height = Number.isFinite(view?.height) && view.height > 0 ? view.height : 0;
  if (!width || !height) return null;
  const longestSide = limits.longestSide ?? EVIDENCE_CROP_TARGET_LONGEST_SIDE;
  const maxWidth = limits.maxWidth ?? EVIDENCE_CROP_MAX_WIDTH;
  const maxHeight = limits.maxHeight ?? EVIDENCE_CROP_MAX_HEIGHT;
  const maxScale = limits.maxScale ?? EVIDENCE_CROP_MAX_DISPLAY_SCALE;
  const scale = Math.min(maxScale, longestSide / Math.max(width, height), maxWidth / width, maxHeight / height);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * Recorte do elemento a partir das imagens guardadas na auditoria, quando não há miniatura dele.
 *
 * Devolve um artefato sintético no formato que `evidence-highlight.js` já entende (`metadata.width`,
 * `metadata.height` e `metadata.highlightBox` no espaço de pixels da imagem escolhida) e a janela do
 * recorte. Devolve `null` quando não há geometria confiável para o `nodeId` — o caso em que inventar
 * uma posição seria pior do que dizer que não há imagem.
 */
export function elementCropSource({ evidence, pageId, nodeId } = {}) {
  if (!Array.isArray(evidence) || typeof pageId !== 'string' || typeof nodeId !== 'string' || !nodeId) return null;
  const index = cropIndex(evidence);
  const key = `${pageId}\u0000${nodeId}`;
  if (index.sources.has(key)) return index.sources.get(key);
  const source = cropSourceFor(index.targets.get(key));
  index.sources.set(key, source);
  return source;
}

/**
 * Índice `pageId + nodeId` → alvo, montado uma vez por lista de evidências: sem ele, cada cartão da
 * revisão varreria todas as anotações e paradas de todos os mapas da auditoria.
 */
const CROP_INDEXES = new WeakMap();

function cropIndex(evidence) {
  const cached = CROP_INDEXES.get(evidence);
  if (cached) return cached;
  const targets = new Map();
  for (const kind of CROP_SOURCE_KINDS) {
    for (const map of evidence) {
      if (map?.kind !== kind || typeof map.pageId !== 'string') continue;
      for (const entry of mapTargets(map)) {
        const rect = positiveRect(entry.rect);
        if (typeof entry.nodeId !== 'string' || !entry.nodeId || !rect) continue;
        const key = `${map.pageId}\u0000${entry.nodeId}`;
        if (targets.has(key)) continue;
        const segment = segmentForDocumentPoint(map, { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
        // Sem pixels no trecho (orçamento de evidências estourado) não há recorte a mostrar: o alvo não
        // entra no índice e o cartão segue para o texto do elemento.
        if (segment && usableImage(segment.dataUrl)) targets.set(key, { map, segment, geometry: entry.geometry, rect });
      }
    }
  }
  const index = { targets, sources: new Map() };
  CROP_INDEXES.set(evidence, index);
  return index;
}

function cropSourceFor(target) {
  if (!target) return null;
  const { segment, geometry, rect } = target;
  // A caixa desenhada é o pedaço do alvo que aparece neste trecho; o resto continua fora, e a
  // legenda do contorno diz isso (`highlightClipped`) em vez de desenhar um quadro menor sem aviso.
  const visible = intersectRects(rect, segment.sourceCssClip) ?? intersectRects(rect, { x: 0, y: 0, width: segment.width, height: segment.height });
  if (!visible) return null;
  const box = positiveRect(documentRectToSegmentPixels(segment, geometry ?? {}, visible) ?? scaleByClip(visible, segment.sourceCssClip, segment));
  if (!box) return null;
  const view = evidenceCropWindow(box, { width: segment.width, height: segment.height });
  if (!view) return null;
  return {
    sourceEvidenceId: segment.segmentId,
    mapEvidenceId: target.map.evidenceId,
    view,
    artifact: {
      kind: 'element',
      dataUrl: segment.dataUrl,
      metadata: {
        width: segment.width, height: segment.height,
        highlightBox: box,
        ...(box.width < rect.width - 0.5 || box.height < rect.height - 0.5 ? { highlightClipped: true } : {}),
      },
    },
  };
}

/** Reserva de conversão quando o mapa não declara escala: proporção entre o recorte do documento e a imagem. */
function scaleByClip(rect, clip, segment) {
  if (!clip || !Number.isFinite(clip.width) || clip.width <= 0 || !Number.isFinite(clip.height) || clip.height <= 0) return null;
  return {
    x: (rect.x - clip.x) * (segment.width / clip.width),
    y: (rect.y - clip.y) * (segment.height / clip.height),
    width: rect.width * (segment.width / clip.width),
    height: rect.height * (segment.height / clip.height),
  };
}

/**
 * Peças de desenho do recorte: janela (`viewBox`), tamanho da imagem de origem, formas do contorno
 * (escurecimento, halo e traço) e legenda. `view` ausente desenha a imagem inteira, como no relatório.
 *
 * Quem monta SVG por texto (o HTML exportado) e quem monta por DOM (a página de revisão) usam as
 * mesmas peças: a leitura da imagem não pode depender de quem desenha.
 */
export function evidenceMediaParts(artifact, treatment, view = null) {
  const frame = evidenceHighlight(artifact);
  if (!frame || !treatment) return null;
  const window = positiveRect(view) ?? { x: 0, y: 0, width: frame.width, height: frame.height };
  return {
    frame,
    view: window,
    image: { width: frame.width, height: frame.height },
    display: evidenceCropDisplaySize(window),
    shapes: evidenceHighlightShapes(frame, treatment.tone),
    legend: evidenceHighlightLegend(treatment, frame),
    clipped: frame.clipped === true,
  };
}
