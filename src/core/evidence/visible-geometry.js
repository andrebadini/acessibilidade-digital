/**
 * Geometria visível de um nó do instantâneo, deduzida só do que foi coletado.
 *
 * Extraído de `src/browser/annotation-map.js` na 1.1.58 para ser compartilhado com o mapa do
 * teclado: os dois mapas desenham sobre a mesma captura integral e precisam da mesma decisão sobre
 * o que aparece na imagem. Duas cópias divergiriam na primeira correção.
 */
function normalizedText(value) {
  return typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '';
}

function safeTag(node) {
  const value = normalizedText(node?.tagName).toLowerCase();
  return /^[a-z][a-z0-9-]{0,63}$/u.test(value) ? value : 'element';
}

/**
 * Tamanho da área capturada, em px de documento, e a escala do dispositivo quando declarada.
 *
 * As métricas de leiaute são a fonte preferida; sem elas, a própria captura responde. É o que
 * permite converter o retângulo de um elemento em pixel de imagem sem consultar a página de novo.
 */
export function captureContentSize(layoutMetrics, sourceMetadata) {
  const size = layoutMetrics?.cssContentSize || layoutMetrics?.contentSize || {};
  const cssWidth = Number.isFinite(size.width) && size.width > 0 ? size.width : sourceMetadata.width;
  const cssHeight = Number.isFinite(size.height) && size.height > 0 ? size.height : sourceMetadata.height;
  const deviceScaleFactor = Number.isFinite(layoutMetrics?.deviceScaleFactor) && layoutMetrics.deviceScaleFactor > 0
    ? layoutMetrics.deviceScaleFactor
    : null;
  return { cssWidth, cssHeight, deviceScaleFactor };
}

export function usefulRect(rect) {
  return Boolean(rect) && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(rect[key])) && rect.width > 0 && rect.height > 0;
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
  return normalizedText(styles[name] ?? styles[camel]).toLowerCase();
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
export function clippingAncestorRects(node, indexes) {
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
export function visibleRect(node, indexes) {
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
