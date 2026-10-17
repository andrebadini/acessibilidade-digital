/**
 * Recorte do elemento para o cartão da revisão guiada e para as fichas de evidência.
 *
 * Duas perguntas, dois passos, nesta ordem:
 *
 * 1. `elementCropSource` responde "onde está este elemento nas imagens guardadas?", na ordem de
 *    preferência do produto: (a) a **posição na captura integral** gravada no próprio artefato do
 *    elemento (`fullPageRect`/`fullPageParts`, 1.1.62) — a imagem já está na auditoria e o recorte não
 *    custou nenhuma captura de tela; (b) a **geometria dos mapas**, para as auditorias anteriores que não
 *    têm o campo: as anotações do mapa de anúncios e as paradas/suspeitas do mapa do teclado guardam
 *    `nodeId` e o retângulo do documento, e os segmentos guardam a faixa da página que cada imagem cobre.
 *    Sem nenhuma das duas a resposta é `null`: quem chama mostra o texto do elemento, nunca uma caixa
 *    adivinhada.
 *
 * 2. `evidenceMediaParts` transforma o artefato (real ou o sintético do passo 1) em peças de desenho.
 *    O cálculo da caixa, do escurecimento e do contorno continua sendo o de `evidence-highlight.js` —
 *    o mesmo do relatório —, aqui só se escolhe a janela (`viewBox`) que o recorte mostra.
 *
 * O recorte **não gera pixel novo**: a imagem guardada entra inteira no SVG e a janela é o `viewBox`,
 * como nos recortes das marcas da revisão guiada (`review-marks-presentation.js`).
 */

import { pngDataUrlDecodedByteLength } from '../evidence/png.js';
import { integralCaptureRect } from '../evidence/fresh-geometry.js';
import { documentRectToSegmentPixels, intersectRects, segmentForDocumentPoint } from '../keyboard/keyboard-map-geometry.js';
import { evidenceCaptureSize, evidenceHighlight, evidenceHighlightLegend, evidenceHighlightShapes } from './evidence-highlight.js';

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

/**
 * Teto do PNG da captura integral usado como recorte, em bytes decodificados.
 *
 * É dezesseis vezes o teto dos trechos de mapa, e o motivo é outro: a captura integral já está guardada
 * e já é desenhada pelo próprio relatório e pela própria página de revisão. Recortá-la não acrescenta
 * byte nenhum ao documento nem à memória da aba — o limite aqui só evita que um arquivo absurdo (acima
 * do que o teto de captura de 40 milhões de pixels consegue produzir) entre num recorte.
 */
export const EVIDENCE_CROP_MAX_INTEGRAL_DECODED_BYTES = 64 * 1024 * 1024;

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

function usableImage(value, limit = EVIDENCE_CROP_MAX_DECODED_BYTES) {
  const key = `${limit}\u0000${value}`;
  if (USABLE_IMAGE_CACHE.has(key)) return USABLE_IMAGE_CACHE.get(key);
  let usable = false;
  if (typeof value === 'string' && value.startsWith(PNG_PREFIX)) {
    try { usable = pngDataUrlDecodedByteLength(value) <= limit; } catch { usable = false; }
  }
  if (USABLE_IMAGE_CACHE.size >= USABLE_IMAGE_CACHE_LIMIT) USABLE_IMAGE_CACHE.clear();
  USABLE_IMAGE_CACHE.set(key, usable);
  return usable;
}

/** `usableImage` com o teto da captura integral, que é outro: a imagem já está no documento. */
function usableIntegralImage(value) {
  return usableImage(value, EVIDENCE_CROP_MAX_INTEGRAL_DECODED_BYTES);
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function unionRect(rects) {
  if (rects.length === 0) return null;
  const left = Math.min(...rects.map(rect => rect.x));
  const top = Math.min(...rects.map(rect => rect.y));
  const right = Math.max(...rects.map(rect => rect.x + rect.width));
  const bottom = Math.max(...rects.map(rect => rect.y + rect.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function scaleRect(rect, scale) {
  return { x: round2(rect.x * scale), y: round2(rect.y * scale), width: round2(rect.width * scale), height: round2(rect.height * scale) };
}

/**
 * Fator entre os px CSS da imagem (unidades de `fullPageRect`) e a caixa em que o consumidor desenha a
 * captura integral.
 *
 * O relatório estático dimensiona a imagem pelo próprio PNG (`evidence-image-N`), que em tela com escala
 * de dispositivo é maior que os px CSS; a página de revisão declara a caixa que quiser. Quem sabe qual é a
 * caixa é quem chama, e é isso que `targetImageSize` informa. Sem ele a caixa é a dos px CSS declarados —
 * o caso da revisão —, e um alvo com proporção diferente é recusado: um recorte esticado cairia fora do
 * elemento, que é exatamente o que este módulo existe para não fazer.
 */
function imageScale(declared, target) {
  if (!target) return 1;
  const sx = Number.isFinite(target.width) && target.width > 0 ? target.width / declared.width : null;
  const sy = Number.isFinite(target.height) && target.height > 0 ? target.height / declared.height : null;
  if (sx === null || sy === null) return null;
  return Math.abs(sx - sy) <= 0.02 ? sx : null;
}

/**
 * Recorte a partir da posição gravada na captura integral (`fullPageRect`), o caminho novo do produto.
 *
 * `elementEvidence` é o artefato do elemento — o mesmo que vai para o relatório. `evidence` é a lista de
 * evidências da auditoria, de onde sai a captura integral referenciada. A posição está em px CSS da
 * imagem, medidos no mesmo leiaute da captura (`fresh-geometry.js`), e é reaproveitada como está: nada
 * aqui remede nada, e um artefato sem posição simplesmente não tem recorte por este caminho.
 *
 * @returns {{sourceEvidenceId: string, view: object, artifact: object}|null}
 */
export function integralCropSource({ evidence, pageId = null, elementEvidence = null, targetImageSize = null } = {}) {
  const recorded = positiveRect(elementEvidence?.fullPageRect);
  const sourceId = elementEvidence?.fullPageEvidenceId;
  if (!recorded || typeof sourceId !== 'string' || !sourceId || !Array.isArray(evidence)) return null;
  const source = evidence.find(artifact => artifact?.kind === 'full-page' && artifact?.evidenceId === sourceId);
  if (!source) return null;
  if (typeof pageId === 'string' && source.pageId !== pageId) return null;
  const declared = evidenceCaptureSize(source);
  if (!declared || !usableIntegralImage(source.dataUrl)) return null;
  // A posição gravada só vale se couber na imagem declarada: fora dela não há pixel guardado (a página
  // pode ter sido truncada pelo teto de segurança, e aí o recorte sai por outro caminho). A mesma
  // conferência da captura (`integralCaptureRect`) é refeita aqui porque quem lê o artefato não confia
  // no que veio do armazenamento local — e uma caixa fora do quadro é pior do que nenhuma imagem.
  const rect = integralCaptureRect(recorded, declared);
  if (!rect) return null;
  const scale = imageScale(declared, targetImageSize);
  if (scale === null) return null;
  const parts = (Array.isArray(elementEvidence.fullPageParts) ? elementEvidence.fullPageParts : [])
    .map(part => integralCaptureRect(positiveRect(part), declared)).filter(Boolean).map(part => scaleRect(part, scale));
  const box = scaleRect(rect, scale);
  const artifact = {
    kind: 'element',
    dataUrl: source.dataUrl,
    metadata: {
      // O quadro desenhado é a imagem inteira, no espaço da imagem escolhida: o `viewBox` do recorte é a
      // janela dentro dele, e a caixa do alvo vai no mesmo espaço.
      width: round2(declared.width * scale),
      height: round2(declared.height * scale),
      highlightBox: box,
      ...(parts.length > 0 ? { highlightParts: parts } : {}),
    },
  };
  const view = evidenceCropWindow(parts.length > 0 ? unionRect(parts) : box, { width: artifact.metadata.width, height: artifact.metadata.height });
  if (!view) return null;
  return { sourceEvidenceId: sourceId, view, artifact };
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
 * Ordem de preferência: a posição gravada na captura integral (`fullPageRect`, 1.1.62) e, sem ela, a
 * geometria dos mapas (auditorias anteriores). Devolve um artefato sintético no formato que
 * `evidence-highlight.js` já entende (`metadata.width`, `metadata.height` e `metadata.highlightBox` no
 * espaço de pixels da imagem escolhida) e a janela do recorte. Devolve `null` quando não há geometria
 * confiável — o caso em que inventar uma posição seria pior do que dizer que não há imagem.
 */
export function elementCropSource({ evidence, pageId, nodeId, elementEvidence = null, targetImageSize = null } = {}) {
  if (!Array.isArray(evidence)) return null;
  const integral = integralCropSource({ evidence, pageId, elementEvidence, targetImageSize });
  if (integral) return integral;
  if (typeof pageId !== 'string' || typeof nodeId !== 'string' || !nodeId) return null;
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
