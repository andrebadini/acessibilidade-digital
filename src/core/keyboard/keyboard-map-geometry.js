/**
 * Conversão entre o DOCUMENTO auditado e a IMAGEM de cada trecho do mapa do teclado.
 *
 * É o único lugar que sabe a conta: o mapa guarda, por trecho, `sourceCssClip` (a faixa do documento,
 * em pixels CSS) e o tamanho em pixels da imagem daquele trecho. Quem desenha sobre a imagem (a
 * revisão guiada) e quem recorta a imagem para o relatório usam estas funções, para que a área
 * marcada continue caindo no mesmo lugar nos dois lados.
 *
 * Nada aqui valida esquema: entram artefatos já validados pelo mapa do teclado.
 */

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function usable(segment, geometry) {
  const clip = segment?.sourceCssClip;
  return Boolean(geometry && clip && finite(segment.width) && finite(segment.height) &&
    segment.width > 0 && segment.height > 0 &&
    finite(clip.x) && finite(clip.y) && finite(clip.width) && finite(clip.height) &&
    clip.width > 0 && clip.height > 0 && finite(geometry.scaleX) && finite(geometry.scaleY));
}

/** Retângulo (ou ponto) do documento auditado em pixels da imagem daquele trecho. */
export function documentRectToSegmentPixels(segment, geometry, rect) {
  if (!usable(segment, geometry) || !rect) return null;
  const clip = segment.sourceCssClip;
  return {
    x: (rect.x - clip.x) * (segment.width / clip.width),
    y: (rect.y - clip.y) * (segment.height / clip.height),
    width: rect.width * (segment.width / clip.width),
    height: rect.height * (segment.height / clip.height),
  };
}

/** Caminho inverso: pixels da imagem do trecho em pixels CSS do documento auditado. */
export function segmentPixelsToDocumentRect(segment, geometry, rect) {
  if (!usable(segment, geometry) || !rect) return null;
  const clip = segment.sourceCssClip;
  return {
    x: clip.x + rect.x * (clip.width / segment.width),
    y: clip.y + rect.y * (clip.height / segment.height),
    width: rect.width * (clip.width / segment.width),
    height: rect.height * (clip.height / segment.height),
  };
}

/** Interseção de dois retângulos do mesmo espaço; `null` quando não se sobrepõem. */
export function intersectRects(left, right) {
  if (!left || !right) return null;
  const x = Math.max(left.x, right.x);
  const y = Math.max(left.y, right.y);
  const maxX = Math.min(left.x + left.width, right.x + right.width);
  const maxY = Math.min(left.y + left.height, right.y + right.height);
  if (maxX - x <= 0 || maxY - y <= 0) return null;
  return { x, y, width: maxX - x, height: maxY - y };
}

function distanceToClip(clip, point) {
  const dx = Math.max(clip.x - point.x, 0, point.x - (clip.x + clip.width));
  const dy = Math.max(clip.y - point.y, 0, point.y - (clip.y + clip.height));
  return Math.hypot(dx, dy);
}

/** Trecho cuja faixa do documento contém o ponto; na falta dele, o trecho mais próximo. */
export function segmentForDocumentPoint(map, point) {
  const segments = Array.isArray(map?.segments) ? map.segments : [];
  if (!point) return segments[0] ?? null;
  for (const segment of segments) {
    const clip = segment.sourceCssClip;
    if (point.x >= clip.x && point.x <= clip.x + clip.width &&
      point.y >= clip.y && point.y <= clip.y + clip.height) return segment;
  }
  let nearest = segments[0] ?? null;
  let best = Infinity;
  for (const segment of segments) {
    const distance = distanceToClip(segment.sourceCssClip, point);
    if (distance < best) { best = distance; nearest = segment; }
  }
  return nearest;
}

/** Recorta um retângulo do documento para dentro dos limites do próprio documento. */
export function clampDocumentRect(rect, size, { minimum = 1 } = {}) {
  if (!rect || !size || !finite(size.width) || !finite(size.height) || size.width <= 0 || size.height <= 0) return null;
  const width = Math.max(minimum, Math.min(rect.width, size.width));
  const height = Math.max(minimum, Math.min(rect.height, size.height));
  const x = Math.max(0, Math.min(rect.x, size.width - width));
  const y = Math.max(0, Math.min(rect.y, size.height - height));
  return { x, y, width, height };
}

/** Área marcada pronta para desenhar: inteira, com números inteiros de pixels do documento. */
export function integerDocumentArea(rect, size) {
  const rounded = rect && {
    x: Math.round(rect.x), y: Math.round(rect.y),
    width: Math.round(rect.width), height: Math.round(rect.height),
  };
  return rounded ? clampDocumentRect(rounded, size, { minimum: 1 }) : null;
}
