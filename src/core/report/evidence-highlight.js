/**
 * Geometria e desenho da marcação de evidência de elemento, compartilhados pelo relatório HTML
 * estático (`html.js`) e pela página de revisão (`report-view.js`).
 *
 * Antes, cada um dos dois arquivos calculava a própria caixa e desenhava um `<rect>` de 7 px
 * centralizado na borda do elemento: o traço invadia o conteúdo e cobria os vizinhos. Aqui o alvo
 * é desenhado **por fora** (offset de 3 px de imagem), com halo branco por baixo do traço colorido,
 * e o resto da imagem é escurecido como contexto — a leitura de "o que está contornado" deixa de
 * depender só da cor.
 *
 * O sistema de coordenadas de `metadata.highlightBox`/`metadata.highlightParts` é `capture-css-px`
 * do próprio recorte (`metadata.clip`), que é o mesmo sistema do `viewBox` desenhado. Nunca se usa
 * o tamanho do PNG decodificado: em captura com escala de dispositivo isso misturaria dois sistemas
 * e desalinharia a caixa. Desde a 1.1.57 a miniatura é capturada em 2× para não chegar serrilhada, e
 * o tamanho do PNG só serve para conferir a relação `width/height × pixelScale`
 * (`evidenceRasterMatchesCapture`), nunca para posicionar nada.
 */

export const EVIDENCE_HIGHLIGHT_KIND = 'element';

/** Teto de partes desenhadas (fragmentos de linha de um inline multilinha). */
export const EVIDENCE_HIGHLIGHT_MAX_PARTS = 8;

/** Afastamento do contorno em relação à borda do elemento, em px de imagem. */
export const EVIDENCE_HIGHLIGHT_OUTLINE_OFFSET = 3;

/** Halo branco por baixo do traço colorido e traço colorido por cima, ambos em px de tela. */
export const EVIDENCE_HIGHLIGHT_HALO_WIDTH = 5;
export const EVIDENCE_HIGHLIGHT_STROKE_WIDTH = 2.5;

/** Raio dos cantos do contorno, em px de imagem. */
export const EVIDENCE_HIGHLIGHT_RADIUS = 2;

/** Opacidade do escurecimento fora do alvo. */
export const EVIDENCE_SPOTLIGHT_OPACITY = 0.38;

export const EVIDENCE_HIGHLIGHT_CONTEXT_LEGEND = 'O restante da imagem aparece escurecido só como contexto.';
export const EVIDENCE_HIGHLIGHT_CLIPPED_LEGEND = 'O elemento continua além desta captura.';
/** Sem quadro confiável a captura é mostrada crua; a frase diz isso em vez de prometer um contorno. */
export const EVIDENCE_HIGHLIGHT_UNMARKED_LEGEND = 'Captura sem marcação: o quadro do elemento não pôde ser posicionado com segurança.';

const COORDINATE_SPACE = 'capture-css-px';
const RECT_KEYS = Object.freeze(['x', 'y', 'width', 'height']);

function finitePositive(value) {
  return Number.isFinite(value) && value > 0 ? value : null;
}

function finiteRect(value) {
  if (!value || typeof value !== 'object') return null;
  if (!RECT_KEYS.every(key => Number.isFinite(value[key]))) return null;
  return { x: value.x, y: value.y, width: value.width, height: value.height };
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

/**
 * Tamanho do quadro desenhado, sempre em `capture-css-px`.
 *
 * Preferência: `metadata.width/height` (as dimensões do clip, gravadas na captura). Se faltarem,
 * o próprio `metadata.clip`. O tamanho do PNG decodificado **não** é usado como reserva: em tela
 * com escala de dispositivo ele misturaria sistemas de coordenadas. Sem nenhuma das duas fontes,
 * não há como posicionar a caixa com honestidade e a evidência é apresentada sem marcação.
 */
export function evidenceCaptureSize(artifact) {
  const metadata = artifact?.metadata;
  if (!metadata || typeof metadata !== 'object') return null;
  const declared = { width: finitePositive(metadata.width), height: finitePositive(metadata.height) };
  if (declared.width !== null && declared.height !== null) return Object.freeze(declared);
  const clip = metadata.clip;
  const fromClip = { width: finitePositive(clip?.width), height: finitePositive(clip?.height) };
  if (fromClip.width !== null && fromClip.height !== null) return Object.freeze(fromClip);
  return null;
}

/**
 * Escala de pixels declarada na captura da miniatura: 1 quando ausente.
 *
 * A miniatura é capturada em 2× (ou na escala do dispositivo) desde a 1.1.57 para não chegar
 * serrilhada ao relatório; auditorias anteriores não têm o campo e valem 1. Valores fora do contrato
 * da captura — fracionários, zero ou negativos — também valem 1: nenhuma comparação de tamanho deve
 * falhar por causa de um campo opcional malformado, e o esquema fechado já recusa esse caso.
 */
export function evidencePixelScale(artifact) {
  const value = artifact?.metadata?.pixelScale;
  return Number.isSafeInteger(value) && value > 0 ? value : 1;
}

/**
 * O raster decodificado mede `metadata.width/height × pixelScale`?
 *
 * Quem for dimensionar a imagem com os metadados precisa desta conferência: com a captura em 2× o PNG
 * é o dobro do quadro, e usar o tamanho errado moveria a caixa e o `viewBox`. A tolerância de 1 px
 * absorve o arredondamento do retângulo de dispositivo do Chrome quando o recorte tem fração de pixel.
 * Sem tamanho declarado — ou com um raster que não bate — a resposta é `false` e quem lê usa o tamanho
 * do próprio PNG, como fazia antes deste campo existir.
 */
export function evidenceRasterMatchesCapture(artifact, raster) {
  const size = evidenceCaptureSize(artifact);
  if (!size || !raster || !Number.isFinite(raster.width) || !Number.isFinite(raster.height)) return false;
  const scale = evidencePixelScale(artifact);
  return Math.abs(raster.width - size.width * scale) <= 1 && Math.abs(raster.height - size.height * scale) <= 1;
}

function clippedRect(rect, width, height) {
  const x = clamp(rect.x, 0, width);
  const y = clamp(rect.y, 0, height);
  const right = clamp(rect.x + Math.max(0, rect.width), x, width);
  const bottom = clamp(rect.y + Math.max(0, rect.height), y, height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

/**
 * Partes cruas do alvo, na ordem em que devem ser lidas: `metadata.highlightParts` (fragmentos de
 * linha de um inline) ou, na ausência do campo — auditorias anteriores à 1.1.57 —, a união em
 * `metadata.highlightBox`.
 */
export function evidenceHighlightRects(artifact) {
  const metadata = artifact?.metadata;
  if (!metadata || typeof metadata !== 'object') return null;
  if (Array.isArray(metadata.highlightParts)) {
    const parts = metadata.highlightParts
      .slice(0, EVIDENCE_HIGHLIGHT_MAX_PARTS)
      .map(finiteRect)
      .filter(part => part && part.width > 0 && part.height > 0);
    if (parts.length > 0) return parts;
  }
  const box = finiteRect(metadata.highlightBox);
  return box && box.width > 0 && box.height > 0 ? [box] : null;
}

function unionOf(rects) {
  if (rects.length === 0) return null;
  const left = Math.min(...rects.map(rect => rect.x));
  const top = Math.min(...rects.map(rect => rect.y));
  const right = Math.max(...rects.map(rect => rect.x + rect.width));
  const bottom = Math.max(...rects.map(rect => rect.y + rect.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * Geometria pronta para desenhar: quadro, partes do alvo (cada uma recortada no quadro) e a união.
 * Devolve `null` quando a evidência não tem como ser posicionada.
 */
export function evidenceHighlight(artifact, captureSize = null) {
  const size = captureSize ?? evidenceCaptureSize(artifact);
  if (!size) return null;
  const raw = evidenceHighlightRects(artifact);
  if (!raw) return null;
  const parts = raw.map(rect => clippedRect(rect, size.width, size.height)).filter(Boolean);
  if (parts.length === 0) return null;
  return Object.freeze({
    width: size.width,
    height: size.height,
    coordinateSpace: COORDINATE_SPACE,
    parts: Object.freeze(parts.map(part => Object.freeze(part))),
    box: Object.freeze(unionOf(parts)),
    clipped: artifact?.metadata?.highlightClipped === true,
  });
}

/** Contorno desenhado por fora: expande a parte e mantém o resultado dentro da imagem. */
export function evidenceOutlineRect(part, width, height) {
  return {
    x: clamp(part.x - EVIDENCE_HIGHLIGHT_OUTLINE_OFFSET, 0, width),
    y: clamp(part.y - EVIDENCE_HIGHLIGHT_OUTLINE_OFFSET, 0, height),
    width: clamp(part.x + part.width + EVIDENCE_HIGHLIGHT_OUTLINE_OFFSET, 0, width) - clamp(part.x - EVIDENCE_HIGHLIGHT_OUTLINE_OFFSET, 0, width),
    height: clamp(part.y + part.height + EVIDENCE_HIGHLIGHT_OUTLINE_OFFSET, 0, height) - clamp(part.y - EVIDENCE_HIGHLIGHT_OUTLINE_OFFSET, 0, height),
  };
}

/**
 * Path do "spotlight": a imagem inteira, com cada parte do alvo como furo (`fill-rule: evenodd`).
 * O que fica fora do alvo é escurecido; o alvo permanece nítido.
 */
export function evidenceSpotlightPath(highlight) {
  const number = value => (Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100));
  const rectangle = (x, y, width, height) => `M${number(x)} ${number(y)}H${number(x + width)}V${number(y + height)}H${number(x)}Z`;
  const holes = highlight.parts.map(part => rectangle(part.x, part.y, part.width, part.height)).join('');
  return `${rectangle(0, 0, highlight.width, highlight.height)}${holes}`;
}

/** Frase de leitura para leigos: o que está contornado, com que cor e o que é contexto. */
export function evidenceHighlightLegend(treatment, highlight) {
  const sentences = [treatment.legend, EVIDENCE_HIGHLIGHT_CONTEXT_LEGEND];
  if (highlight?.clipped) sentences.push(EVIDENCE_HIGHLIGHT_CLIPPED_LEGEND);
  return sentences.join(' ');
}

/**
 * Camadas do desenho, na ordem de pintura: escurecimento, halo branco de todas as partes e, por
 * cima, o contorno colorido de cada parte. Os halos vêm todos antes dos contornos porque, num inline
 * de várias linhas, os retângulos expandidos de linhas vizinhas se sobrepõem alguns pixels; se cada
 * halo fosse pintado junto do seu contorno, o halo de uma linha cobriria o contorno da anterior.
 *
 * As formas são descritas como dados, e não como marcação, porque os dois consumidores constroem SVG
 * de maneiras diferentes: o relatório por template de string, a página de revisão por `createElementNS`.
 */
export function evidenceHighlightShapes(highlight, tone) {
  const shapes = [{
    kind: 'path',
    attributes: {
      class: 'evidence-spotlight', 'fill-rule': 'evenodd', d: evidenceSpotlightPath(highlight),
      'aria-hidden': 'true',
    },
  }];
  const geometry = highlight.parts.map(part => {
    const rect = evidenceOutlineRect(part, highlight.width, highlight.height);
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, rx: EVIDENCE_HIGHLIGHT_RADIUS };
  });
  for (const rect of geometry) {
    shapes.push({ kind: 'rect', attributes: { class: 'evidence-halo', ...rect, 'aria-hidden': 'true' } });
  }
  for (const rect of geometry) {
    shapes.push({
      kind: 'rect',
      attributes: { class: `evidence-highlight evidence-highlight--${tone}`, 'data-evidence-highlight': tone, ...rect, 'aria-hidden': 'true' },
    });
  }
  return shapes;
}
