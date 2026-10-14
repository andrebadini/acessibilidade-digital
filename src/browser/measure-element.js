/**
 * Remedição do alvo imediatamente antes da captura de elemento.
 *
 * O `rect` do snapshot (`DOMSnapshot.captureSnapshot` com `includeDOMRects`) é medido muito antes da
 * fase de evidências. Entre uma coisa e outra a página rola, carrega imagens e troca de layout, e a
 * caixa desenhada passa a apontar para outro ponto da imagem. Além disso, o `bounds` do snapshot para
 * um elemento inline é a caixa envolvente de todos os fragmentos de linha — não os fragmentos.
 *
 * `DOM.getContentQuads` resolve as duas coisas de uma vez: remede o nó pelo `backendNodeId` no instante
 * da captura e devolve **um quadrilátero por fragmento de linha** de um inline. As coordenadas vêm no
 * sistema da viewport do quadro (confirmado contra o Chrome for Testing 152: com `scrollY = 800`, um
 * elemento em `y = 1200` no documento devolve quadriláteros em `y = 400`), então a conversão para o
 * documento é somar o deslocamento da viewport medido por `Page.getLayoutMetrics` **no mesmo momento**.
 */

/** Teto de partes devolvidas para desenho; a união usada no recorte continua considerando todas. */
export const MAX_MEASURED_PARTS = 8;

/** Abaixo disso a diferença entre quadriláteros adjacentes é ruído de subpixel, não recorte real. */
const CLIP_EPSILON = 0.5;

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Converte um quadrilátero CDP (8 números) no retângulo alinhado aos eixos que o contém. */
export function quadToRect(quad) {
  if (!Array.isArray(quad) || quad.length !== 8) return null;
  const values = quad.map(Number);
  if (!values.every(finite)) return null;
  const left = Math.min(values[0], values[2], values[4], values[6]);
  const top = Math.min(values[1], values[3], values[5], values[7]);
  const right = Math.max(values[0], values[2], values[4], values[6]);
  const bottom = Math.max(values[1], values[3], values[5], values[7]);
  const width = right - left;
  const height = bottom - top;
  return width > 0 && height > 0 ? { x: left, y: top, width, height } : null;
}

/** Retângulo que contém todos os retângulos informados. */
export function unionOfRects(rects) {
  if (!Array.isArray(rects) || rects.length === 0) return null;
  const left = Math.min(...rects.map(rect => rect.x));
  const top = Math.min(...rects.map(rect => rect.y));
  const right = Math.max(...rects.map(rect => rect.x + rect.width));
  const bottom = Math.max(...rects.map(rect => rect.y + rect.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Deslocamento da viewport (origem do sistema dos quadriláteros) dentro do documento, em CSS px. */
export function viewportOrigin(metrics) {
  const viewport = metrics?.cssVisualViewport;
  if (!viewport || !finite(viewport.pageX) || !finite(viewport.pageY)) return null;
  return { x: viewport.pageX, y: viewport.pageY };
}

/** Recorte real do elemento pelos limites da página capturada (o que "continua além da captura"). */
export function rectExceedsBounds(rect, bounds) {
  if (!rect) return false;
  if (rect.x < -CLIP_EPSILON || rect.y < -CLIP_EPSILON) return true;
  if (finite(bounds?.width) && rect.x + rect.width > bounds.width + CLIP_EPSILON) return true;
  if (finite(bounds?.height) && rect.y + rect.height > bounds.height + CLIP_EPSILON) return true;
  return false;
}

/**
 * Mede o alvo pelo `backendNodeId`.
 *
 * Devolve sempre um objeto com `status`; nunca lança por causa da página (uma remoção de nó entre a
 * coleta e a captura é esperada e vira `unavailable`, com o chamador registrando a ocorrência).
 */
export async function measureElementTarget(cdp, node) {
  if (Array.isArray(node?.framePath) && node.framePath.length > 0) {
    return { status: 'frame-context', reason: 'frame-context' };
  }
  const backendNodeId = node?.backendNodeId;
  if (!Number.isSafeInteger(backendNodeId) || backendNodeId < 0) {
    return { status: 'unavailable', reason: 'missing-backend-node' };
  }
  let metrics = null;
  try {
    metrics = await cdp.command('Page.getLayoutMetrics', {});
  } catch {
    return { status: 'unavailable', reason: 'layout-metrics-unavailable' };
  }
  const origin = viewportOrigin(metrics);
  if (!origin) return { status: 'unavailable', reason: 'viewport-origin-unavailable', metrics };
  let source = 'content-quads';
  // A queda para `DOM.getBoxModel` acontece sempre que a medição por quadriláteros não rende nenhum
  // retângulo utilizável — sem quadriláteros ou só com quadriláteros degenerados —, e não apenas
  // quando a lista vem vazia: um elemento sem caixa visível ainda pode ter borda no box model.
  let rects = await rectsFor(cdp, 'DOM.getContentQuads', backendNodeId, response => response?.quads, origin);
  if (rects.length === 0) {
    source = 'box-model';
    rects = await rectsFor(cdp, 'DOM.getBoxModel', backendNodeId,
      response => (response?.model?.border ? [response.model.border] : []), origin);
  }
  if (rects.length === 0) return { status: 'unavailable', reason: 'element-not-measurable', metrics };
  const ordered = rects.sort((left, right) => left.y - right.y || left.x - right.x);
  return { status: 'measured', source, metrics, rects: ordered, box: unionOfRects(ordered) };
}

async function rectsFor(cdp, method, backendNodeId, pick, origin) {
  try {
    const response = await cdp.command(method, { backendNodeId });
    const quads = pick(response);
    if (!Array.isArray(quads)) return [];
    return quads.map(quadToRect).filter(Boolean)
      .map(rect => ({ x: rect.x + origin.x, y: rect.y + origin.y, width: rect.width, height: rect.height }));
  } catch {
    // Nó removido, sem layout, ou comando indisponível: o chamador cai no rect do snapshot.
    return [];
  }
}
