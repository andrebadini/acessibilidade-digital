import { pageZoomOf } from '../core/evidence/fresh-geometry.js';
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

// Os dois mapas derivados recusam uma fonte com lado maior que 8.192 px (limite congelado deles,
// `maxDimension`). Com a página ampliada, o mesmo documento passa a render mais pixels do que em
// 100 %: um documento de 5.759 px CSS vira 8.638 px de imagem em 150 % e o mapa inteiro seria omitido
// por tamanho de fonte — pior do que as caixas erradas que esta versão corrige. A imagem continua
// cobrindo a página inteira; quando o zoom a levaria além do que o mapa consegue ler, ela é reduzida
// só o suficiente para caber. Em 100 % nada muda: a escala de recorte continua 1 e o limite de altura
// de 16.384 px de dispositivo segue valendo.
const FULL_PAGE_MAP_SOURCE_DIMENSION = 8_192;

/**
 * Densidade da tela (o 2× de um monitor Retina), separada do zoom da página.
 *
 * `contentSize / cssContentSize` já traz os dois fatores multiplicados: em 125 % e tela 2× a razão é
 * 2,5, não 2. Dividir pelo zoom é o que impede o zoom de ser contado duas vezes — o recorte do CDP já
 * cresce por ele. `deviceScaleFactor` nas métricas é o `devicePixelRatio` do ambiente, que também
 * inclui o zoom, então passa pela mesma divisão.
 */
function deviceScale(metrics = {}) {
  const zoom = pageZoomOf(metrics);
  const css = metrics.cssContentSize;
  const device = metrics.contentSize;
  const ratio = Number.isFinite(css?.width) && css.width > 0 && Number.isFinite(device?.width) && device.width > 0
    ? device.width / css.width / zoom
    : Number.isFinite(metrics.deviceScaleFactor) && metrics.deviceScaleFactor > 0
      ? metrics.deviceScaleFactor / zoom : 1;
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
  const zoom = pageZoomOf(metrics);
  const density = deviceScale(metrics);
  // O teto de dispositivo conta o zoom: o recorte abaixo cresce pelo zoom e a densidade multiplica o
  // raster de novo. Sem isso, uma página alta em 125 % podia passar do teto de 16.384 px de dispositivo.
  if (size.width !== null && size.height !== null) {
    size.height = safeFullPageCaptureHeight(size.width, size.height, density * zoom);
  }
  // O recorte do CDP é interpretado em px CSS do documento, mas a imagem que o Chrome rasteriza com a
  // página ampliada continua no tamanho do leiaute em 100 %: pedir `width` CSS devolvia uma imagem de
  // `width` px mostrando só `width / zoom` CSS — a página inteira ficava cortada na horizontal e na
  // vertical. Multiplicar o recorte pelo zoom faz a imagem cobrir todo o documento; os metadados
  // continuam em CSS px, então a escala do mapa vira `largura do PNG / largura CSS` = zoom × escala da
  // tela, que é exatamente a relação entre o pixel da imagem e o pixel CSS do documento.
  //
  // O zoom nunca aumenta o raster além do que o documento ocuparia em 100 % nem além do teto que os
  // mapas leem (8.192 px): se aumentasse, a imagem seria reduzida de volta só o necessário. Em 100 %
  // esta conta dá escala 1 e o recorte é idêntico ao de antes.
  const naturalWidth = size.width === null ? null : size.width * zoom;
  const naturalHeight = size.height === null ? null : size.height * zoom;
  // A densidade da tela multiplica o raster além do zoom: o PNG final mede
  // `natural × rasterScale × densidade`. Numa tela 2×, uma página de 5.246 px CSS virava 10.492 px e
  // os dois mapas se recusavam a desenhá-la (limite de 8.192 px) — o mesmo problema que o zoom causava,
  // agora pela densidade. A conta abaixo cabe nas duas causas ao mesmo tempo.
  const rasterScale = naturalWidth !== null && naturalHeight !== null
    ? Math.min(
      1,
      Math.max(size.width, FULL_PAGE_MAP_SOURCE_DIMENSION) / (naturalWidth * density),
      Math.max(size.height, FULL_PAGE_MAP_SOURCE_DIMENSION) / (naturalHeight * density),
    )
    : 1;
  const clip = size.width !== null && size.height !== null
    ? {
      x: 0, y: 0, width: naturalWidth, height: naturalHeight, scale: rasterScale,
    }
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

// Nitidez da miniatura. A captura saía em escala 1 (1 px de imagem por CSS px) e, ampliada no relatório,
// um botão de ícone de 30 px chegava serrilhado à tela. A miniatura passa a ser capturada em 2× — ou na
// escala do dispositivo, quando maior — mantendo `metadata.width/height` em CSS px, que é o sistema do
// `viewBox` e da caixa da marcação. O teto de pixels existe pelo mesmo motivo do teto da captura
// integral: uma miniatura grande em 2× viraria um PNG de dezenas de MB sem ganho de leitura. Acima dele
// a escala volta para 1 e a imagem sai como antes.
export const ELEMENT_CAPTURE_PIXEL_LIMITS = Object.freeze({ minScale: 2, maxScale: 3, maxPixels: 4_000_000 });

/**
 * Escala de pixels da miniatura: inteira, no mínimo 2×, no máximo 3×, e 1× quando o alvo é grande
 * demais para o teto de pixels.
 *
 * A escala é inteira de propósito: a imagem de dispositivo vira, então, um múltiplo exato de
 * `metadata.width/height` e a relação "PNG = metadados × escala" pode ser conferida sem adivinhar o
 * arredondamento do Chrome (uma escala fracionária, como 2,5, cairia em 500 ou 501 px de dispositivo
 * para um recorte ímpar).
 */
export function elementCaptureScale(width, height, devicePixelRatio = 1) {
  const area = (Number.isFinite(width) && width > 0 ? width : 0) * (Number.isFinite(height) && height > 0 ? height : 0);
  const ratio = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  const requested = Math.min(ELEMENT_CAPTURE_PIXEL_LIMITS.maxScale, Math.max(ELEMENT_CAPTURE_PIXEL_LIMITS.minScale, Math.ceil(ratio)));
  let scale = requested;
  while (scale > 1 && area * scale * scale > ELEMENT_CAPTURE_PIXEL_LIMITS.maxPixels) scale -= 1;
  return scale;
}

/**
 * Captura a miniatura do elemento.
 *
 * `rect` é o retângulo do snapshot, em CSS px do documento. Quando `metrics.measuredRects` traz a
 * remedição fresca por `DOM.getContentQuads` (um retângulo por fragmento de linha), ela manda: o
 * `rect` fica só como reserva. Nós de iframe não são capturados com coordenadas do documento de topo
 * — o clip seria aplicado ao documento errado — e devolvem `cantTell` com `reason: 'frame-context'`.
 *
 * A escala de pixels não entra nas coordenadas: `width`, `height`, `clip`, `highlightBox` e
 * `highlightParts` continuam em CSS px do recorte, e a escala fica declarada em `pixelScale` para
 * quem for comparar o raster com os metadados.
 */
export async function captureElement(cdp, rect, metrics = {}) {
  if (Array.isArray(metrics.framePath) && metrics.framePath.length > 0) return cantTell('frame-context', metrics);
  const geometry = normalizedClip(rect, metrics);
  if (!geometry) return cantTell('invalid-or-outside-rect', metrics);
  const { clip, margin, highlightBox, highlightParts, highlightClipped } = geometry;
  const density = deviceScale(metrics);
  const pixelScale = elementCaptureScale(clip.width, clip.height, density);
  const scaledClip = pixelScale === 1 ? clip : { ...clip, scale: pixelScale };
  const zoom = pageZoomOf(metrics);
  // A miniatura sofre do mesmo recorte da captura integral: as coordenadas do clip são CSS, mas o
  // raster continua no tamanho do leiaute em 100 % e ainda é multiplicado pela densidade da tela.
  // Pedir `clip × pixelScale` devolvia só `1 / (zoom × densidade)` do quadro — e numa tela 2× o PNG
  // saía com o dobro do que os metadados declaravam. O recorte enviado ao Chrome cresce pelo zoom; a
  // escala pedida cai por `zoom × densidade`, então a imagem final mede exatamente `quadro ×
  // pixelScale`, como os metadados prometem. `metadata.clip` guarda o quadro LÓGICO (CSS) com a
  // escala inteira, que é o sistema do `viewBox` e da marcação; só o pedido ao Chrome enxerga a
  // densidade e o zoom.
  const outputScale = zoom * density;
  const requestClip = outputScale === 1 ? scaledClip
    : {
      x: clip.x * zoom, y: clip.y * zoom, width: clip.width * zoom, height: clip.height * zoom,
      scale: pixelScale / outputScale,
    };
  const result = await capture(cdp, { format: 'png', captureBeyondViewport: !clipInsideViewports(clip, metrics), fromSurface: true, clip: requestClip }, 'thumbnail', {
    width: clip.width, height: clip.height, clip: scaledClip, highlightBox, highlightParts, annotationMargin: margin,
    ...(pixelScale > 1 ? { pixelScale } : {}),
    ...(highlightClipped ? { highlightClipped: true } : {}),
  });
  return { ...result, fullPageEvidenceId: metrics.fullPageEvidenceId ?? metrics.evidenceId ?? null };
}
