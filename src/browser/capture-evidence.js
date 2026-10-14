import { sha256Hex } from '../core/report/hash.js';
import { MAX_MEASURED_PARTS, rectExceedsBounds, unionOfRects } from './measure-element.js';

// Contexto ao redor do elemento, adaptativo. Um valor fixo de 24 px dominava a imagem de um botão de
// ícone de 16 px e ficava invisível ao redor de um bloco de 600 px — a pessoa não distinguia a moldura
// do conteúdo. A moldura acompanha o lado maior do alvo, entre 40 px e 160 px.
const MIN_ELEMENT_CONTEXT_MARGIN = 40;
const MAX_ELEMENT_CONTEXT_MARGIN = 160;

/** Margem de contexto, em CSS px, para um alvo do tamanho informado. */
export function elementContextMargin(width, height) {
  const longest = Math.max(Number.isFinite(width) ? width : 0, Number.isFinite(height) ? height : 0);
  return Math.max(MIN_ELEMENT_CONTEXT_MARGIN, Math.min(MAX_ELEMENT_CONTEXT_MARGIN, Math.round(0.35 * longest)));
}

function dimensions(metrics = {}) {
  const size = metrics.cssContentSize || metrics.contentSize || {};
  return {
    width: Number.isFinite(size.width) && size.width > 0 ? size.width : null,
    height: Number.isFinite(size.height) && size.height > 0 ? size.height : null
  };
}

function validBase64(value) {
  return typeof value === 'string' && value.length >= 12 && value.length % 4 !== 1 && /^[A-Za-z0-9+/]*={0,2}$/u.test(value);
}

function pngPayload(value) {
  if (!validBase64(value)) throw new TypeError('A captura não contém base64 PNG válido.');
  let binary;
  try {
    binary = atob(value);
  } catch {
    throw new TypeError('A captura não contém base64 PNG válido.');
  }
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (binary.length < signature.length || signature.some((byte, index) => binary.charCodeAt(index) !== byte)) {
    throw new TypeError('A captura retornada não possui assinatura PNG.');
  }
  return {
    dataUrl: `data:image/png;base64,${value}`,
    bytes: Uint8Array.from(binary, character => character.charCodeAt(0)),
  };
}

function stableId(prefix, value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${prefix}-${hash.toString(16).padStart(8, '0')}`;
}

async function capture(cdp, params, kind, metadata = {}) {
  if (!cdp || typeof cdp.command !== 'function') throw new TypeError('O cliente CDP de captura é inválido.');
  const response = await cdp.command('Page.captureScreenshot', params);
  // Local receipt time, not a browser-attested raster instant or trusted timestamp.
  const captureReceivedAt = new Date(Date.now()).toISOString();
  const png = pngPayload(response?.data);
  return {
    status: 'captured',
    evidenceId: stableId(kind, `${response.data}\u0000${JSON.stringify(metadata)}`),
    dataUrl: png.dataUrl,
    hash: await sha256Hex(png.bytes),
    metadata: { kind, mimeType: 'image/png', ...metadata, captureReceivedAt }
  };
}

// Teto de segurança da captura integral, medido na bateria de páginas hostis (1.1.53). Uma vitrine com
// 4.000 produtos tinha 157 mil px de altura: o Chrome gerou um PNG de 37 MB em 11 s e o renderizador ficou
// ocupado depois disso, derrubando por tempo esgotado os comandos CDP seguintes — a auditoria inteira
// falhava por causa de uma imagem. 16.384 px de dispositivo é o limite usual de textura do Chrome; o teto de
// pixels protege páginas muito largas. Acima disso, capturamos só a parte superior e quem chama declara a
// limitação (a altura capturada fica em `metadata.height`).
export const FULL_PAGE_CAPTURE_LIMITS = Object.freeze({ maxDeviceHeight: 16_384, maxDevicePixels: 40_000_000 });

function deviceScale(metrics = {}) {
  const css = metrics.cssContentSize;
  const device = metrics.contentSize;
  const ratio = Number.isFinite(css?.width) && css.width > 0 && Number.isFinite(device?.width) && device.width > 0
    ? device.width / css.width
    : Number.isFinite(metrics.deviceScaleFactor) && metrics.deviceScaleFactor > 0 ? metrics.deviceScaleFactor : 1;
  return Math.min(4, Math.max(1, ratio));
}

/** Altura CSS que a captura integral pode cobrir com segurança para a largura e escala observadas. */
export function safeFullPageCaptureHeight(width, height, scale = 1) {
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) return height;
  const byHeight = FULL_PAGE_CAPTURE_LIMITS.maxDeviceHeight / scale;
  const byPixels = FULL_PAGE_CAPTURE_LIMITS.maxDevicePixels / (width * scale * scale);
  return Math.min(height, Math.max(1, Math.floor(Math.min(byHeight, byPixels))));
}

export async function captureFullPage(cdp, metrics = {}) {
  const size = dimensions(metrics);
  if (size.width !== null && size.height !== null) {
    size.height = safeFullPageCaptureHeight(size.width, size.height, deviceScale(metrics));
  }
  const clip = size.width !== null && size.height !== null
    ? { x: 0, y: 0, width: size.width, height: size.height, scale: 1 }
    : null;
  return capture(cdp, {
    format: 'png', captureBeyondViewport: true, fromSurface: true,
    ...(clip ? { clip } : {})
  }, 'full-page', size);
}

function validRects(values) {
  if (!Array.isArray(values)) return null;
  const rects = values
    .filter(rect => rect && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(rect[key])) && rect.width > 0 && rect.height > 0)
    .map(rect => ({ x: rect.x, y: rect.y, width: rect.width, height: rect.height }));
  return rects.length > 0 ? rects : null;
}

/** Retângulo do documento recortado no espaço do clip (`capture-css-px`). */
function clipRelative(documentRect, clip) {
  const x = Math.max(0, documentRect.x - clip.x);
  const y = Math.max(0, documentRect.y - clip.y);
  const right = Math.min(clip.width, documentRect.x + documentRect.width - clip.x);
  const bottom = Math.min(clip.height, documentRect.y + documentRect.height - clip.y);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

function normalizedClip(rect, metrics) {
  const measured = validRects(metrics.measuredRects);
  const fallback = validRects([rect]);
  const source = measured ?? fallback;
  if (!source) return null;
  const size = dimensions(metrics);
  const viewportRelative = measured === null && rect.coordinateSpace === 'viewport';
  if (viewportRelative && (!Number.isFinite(metrics.scrollX) || !Number.isFinite(metrics.scrollY))) return null;
  const rects = viewportRelative
    ? source.map(item => ({ ...item, x: item.x + metrics.scrollX, y: item.y + metrics.scrollY }))
    : source;
  const box = unionOfRects(rects);
  // Contexto proporcional ao alvo: um valor fixo dominava um botão de 16 px e sumia ao redor de um
  // bloco grande. Sem medição fresca, a união é o rect do snapshot e o resultado é o mesmo de antes.
  const margin = elementContextMargin(box.width, box.height);
  const targetLeft = Math.max(0, box.x);
  const targetTop = Math.max(0, box.y);
  const targetRight = size.width === null ? box.x + box.width : Math.min(size.width, box.x + box.width);
  const targetBottom = size.height === null ? box.y + box.height : Math.min(size.height, box.y + box.height);
  if (targetRight <= targetLeft || targetBottom <= targetTop) return null;
  const clipLeft = Math.max(0, targetLeft - margin);
  const clipTop = Math.max(0, targetTop - margin);
  const clipRight = size.width === null ? targetRight + margin : Math.min(size.width, targetRight + margin);
  const clipBottom = size.height === null ? targetBottom + margin : Math.min(size.height, targetBottom + margin);
  const clip = { x: clipLeft, y: clipTop, width: clipRight - clipLeft, height: clipBottom - clipTop, scale: 1 };
  const parts = rects.map(item => clipRelative(item, clip)).filter(Boolean);
  if (parts.length === 0) return null;
  return {
    clip,
    margin,
    // O desenho usa as partes (fragmentos de linha de um inline); `highlightBox` continua sendo a
    // união, para quem lê auditorias geradas antes desta versão.
    highlightBox: { ...unionOfRects(parts), coordinateSpace: 'capture-css-px' },
    highlightParts: parts.slice(0, MAX_MEASURED_PARTS).map(part => ({ ...part })),
    highlightClipped: rectExceedsBounds(box, size),
  };
}

function clipInsideViewports(clip, metrics) {
  if (metrics.cssVisualViewport?.scale !== 1) return false;
  return [metrics.cssVisualViewport, metrics.cssLayoutViewport].every(viewport => {
    if (!viewport || !['pageX', 'pageY', 'clientWidth', 'clientHeight'].every(key => Number.isFinite(viewport[key])) ||
      viewport.clientWidth <= 0 || viewport.clientHeight <= 0) return false;
    const right = viewport.pageX + viewport.clientWidth;
    const bottom = viewport.pageY + viewport.clientHeight;
    return Number.isFinite(right) && Number.isFinite(bottom) && clip.x >= viewport.pageX && clip.y >= viewport.pageY &&
      clip.x + clip.width <= right && clip.y + clip.height <= bottom;
  });
}

function cantTell(reason, metrics) {
  return { status: 'cantTell', reason, evidenceId: null, fullPageEvidenceId: metrics.fullPageEvidenceId ?? metrics.evidenceId ?? null };
}

/**
 * Captura a miniatura do elemento.
 *
 * `rect` é o retângulo do snapshot, em CSS px do documento. Quando `metrics.measuredRects` traz a
 * remedição fresca por `DOM.getContentQuads` (um retângulo por fragmento de linha), ela manda: o
 * `rect` fica só como reserva. Nós de iframe não são capturados com coordenadas do documento de topo
 * — o clip seria aplicado ao documento errado — e devolvem `cantTell` com `reason: 'frame-context'`.
 */
export async function captureElement(cdp, rect, metrics = {}) {
  if (Array.isArray(metrics.framePath) && metrics.framePath.length > 0) return cantTell('frame-context', metrics);
  const geometry = normalizedClip(rect, metrics);
  if (!geometry) return cantTell('invalid-or-outside-rect', metrics);
  const { clip, margin, highlightBox, highlightParts, highlightClipped } = geometry;
  const result = await capture(cdp, { format: 'png', captureBeyondViewport: !clipInsideViewports(clip, metrics), fromSurface: true, clip }, 'thumbnail', {
    width: clip.width, height: clip.height, clip, highlightBox, highlightParts, annotationMargin: margin,
    ...(highlightClipped ? { highlightClipped: true } : {}),
  });
  return { ...result, fullPageEvidenceId: metrics.fullPageEvidenceId ?? metrics.evidenceId ?? null };
}
