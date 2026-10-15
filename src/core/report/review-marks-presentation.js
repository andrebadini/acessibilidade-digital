import { documentRectToSegmentPixels, intersectRects, segmentForDocumentPoint } from '../keyboard/keyboard-map-geometry.js';
import { keyboardMapEntryName } from './keyboard-map-presentation.js';
import { describeReviewAreaPosition } from '../review/review-marks.js';

// Apresentação das marcas do mapa do teclado (`marks` da decisão humana do item 5.1.13).
//
// Só transforma dados já validados em texto e em recortes. O recorte NÃO gera pixel novo: reaproveita
// a imagem do trecho guardada na auditoria, recortada por `viewBox` de um SVG com um contorno
// vermelho por cima — o mesmo caminho serve para a tela, para o HTML exportado e para a impressão.

export const MARKS_SUSPECTS_LABEL = 'Itens apontados';
export const MARKS_AREAS_LABEL = 'Áreas marcadas no mapa do teclado';

function byNumber(map) {
  const entries = new Map();
  for (const entry of map?.suspects ?? []) entries.set(entry.number, entry);
  return entries;
}

/** "Itens apontados: Saúde; Ouvidoria." — os nomes que a pessoa viu na lista de itens sem caixa. */
export function marksSuspectsText(marks, map) {
  const suspects = marks?.suspects ?? [];
  if (suspects.length === 0) return '';
  const entries = byNumber(map);
  const names = suspects.map(number => {
    const entry = entries.get(number);
    return entry ? keyboardMapEntryName(entry) : `item ${number} da lista`;
  });
  return `${MARKS_SUSPECTS_LABEL}: ${names.join('; ')}.`;
}

/** "Áreas marcadas no mapa do teclado: 2." — a contagem é o que o texto cita. */
export function marksAreasText(marks) {
  const count = marks?.areas?.length ?? 0;
  return count > 0 ? `${MARKS_AREAS_LABEL}: ${count}.` : '';
}

/** Frase única com o que a decisão apontou; vazia quando não há marcas. */
export function marksText(marks, map) {
  return [marksSuspectsText(marks, map), marksAreasText(marks)].filter(Boolean).join(' ');
}

export function marksSuspectNames(marks, map) {
  const entries = byNumber(map);
  return (marks?.suspects ?? []).map(number => {
    const entry = entries.get(number);
    return entry ? keyboardMapEntryName(entry) : `item ${number} da lista`;
  });
}

/**
 * Tudo o que as decisões humanas apontaram no mapa do teclado, por decisão: nomes dos itens, contagem
 * de áreas e os recortes prontos. Serve à tela do relatório, ao HTML exportado e à impressão.
 */
export function reviewMarksRecords(model) {
  const maps = new Map();
  for (const artifact of model?.evidence ?? []) {
    if (artifact?.kind === 'keyboard-map' && !maps.has(artifact.pageId)) maps.set(artifact.pageId, artifact);
  }
  const occurrenceById = new Map((model?.occurrences ?? []).map(value => [value.occurrenceId, value]));
  return (model?.reviewDecisions ?? [])
    .filter(decision => decision?.marks)
    .map(decision => {
      const pageId = occurrenceById.get(decision.occurrenceId)?.pageId ?? null;
      const map = maps.get(pageId) ?? null;
      return {
        decisionId: decision.decisionId,
        occurrenceId: decision.occurrenceId,
        itemId: decision.itemId,
        evaluator: decision.evaluator,
        decidedAt: decision.decidedAt,
        pageId,
        suspects: marksSuspectNames(decision.marks, map),
        text: marksText(decision.marks, map),
        areas: decision.marks.areas.map((area, index) => ({ number: index + 1, ...area })),
        crops: reviewMarksAreaCrops(decision.marks, map),
      };
    })
    .sort((left, right) => left.decidedAt.localeCompare(right.decidedAt) || left.decisionId.localeCompare(right.decisionId));
}

function displaySize(width, height, maximum = { width: 320, height: 240 }) {
  const scale = Math.min(1, maximum.width / width, maximum.height / height);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * Recortes das áreas marcadas, um por área. Quando a área atravessa dois trechos da imagem, o recorte
 * sai no trecho que contém o centro dela; a parte que ficar fora aparece cortada pelo próprio SVG.
 */
export function reviewMarksAreaCrops(marks, map) {
  const areas = marks?.areas ?? [];
  const geometry = map?.derivation?.geometry;
  if (areas.length === 0 || !geometry) return [];
  return areas.map((area, index) => {
    const segment = segmentForDocumentPoint(map, { x: area.x + area.width / 2, y: area.y + area.height / 2 });
    if (!segment) return null;
    const clip = segment.sourceCssClip;
    const visible = intersectRects(area, clip);
    if (!visible) return null;
    const inPixels = documentRectToSegmentPixels(segment, geometry, visible);
    const areaPixels = documentRectToSegmentPixels(segment, geometry, area);
    if (!inPixels || !areaPixels) return null;
    // Folga de 12% do próprio recorte (no mínimo 24 pixels da imagem) para a área não vir colada na
    // borda: sem contexto, quem lê o relatório não sabe onde aquilo fica na página.
    const padding = Math.max(24, Math.round(Math.max(inPixels.width, inPixels.height) * 0.12));
    const view = {
      x: inPixels.x - padding, y: inPixels.y - padding,
      width: inPixels.width + padding * 2, height: inPixels.height + padding * 2,
    };
    const size = displaySize(view.width, view.height);
    return {
      number: index + 1,
      segmentId: segment.segmentId,
      segmentIndex: segment.index,
      dataUrl: segment.dataUrl,
      segmentWidth: segment.width,
      segmentHeight: segment.height,
      view,
      area: areaPixels,
      width: size.width,
      height: size.height,
      caption: reviewAreaCaption(area, index + 1, geometry?.sourceCssSize),
      alt: `Recorte do mapa do teclado com contorno vermelho sobre a área ${index + 1} marcada na revisão guiada.`,
    };
  }).filter(Boolean);
}

/**
 * Atributos do recorte, na ordem em que o SVG os recebe. É a única definição do desenho: o HTML
 * exportado monta a marcação como texto e a tela do relatório monta os mesmos nós pelo DOM.
 */
export function marksCropParts(crop) {
  return {
    svg: {
      class: 'marks-crop',
      viewBox: `${crop.view.x} ${crop.view.y} ${crop.view.width} ${crop.view.height}`,
      width: crop.width, height: crop.height,
      preserveAspectRatio: 'xMidYMid meet', role: 'img',
      'aria-label': crop.alt, 'data-marks-crop': String(crop.number),
    },
    image: { x: 0, y: 0, width: crop.segmentWidth, height: crop.segmentHeight, href: crop.dataUrl },
    rect: {
      class: 'marks-area-outline',
      x: crop.area.x, y: crop.area.y, width: crop.area.width, height: crop.area.height,
    },
  };
}

/**
 * Recorte em SVG: a imagem guardada entra inteira e o `viewBox` faz o papel do recorte. Sem `style`
 * embutido — a meta de CSP do relatório não permite atributo de estilo — e sem gerar pixel novo.
 */
export function marksCropSvg(crop, escape) {
  const { svg, image, rect } = marksCropParts(crop);
  const attributes = values => Object.entries(values).map(([name, value]) => ` ${name}="${escape(String(value))}"`).join('');
  return `<svg${attributes(svg)}><image${attributes(image)}></image><rect${attributes(rect)}></rect></svg>`;
}

function reviewAreaCaption(area, number, size) {
  const where = describeReviewAreaPosition(area, size);
  return `Área ${number} marcada na revisão guiada${where ? `, ${where}` : ''} (${area.width} × ${area.height} pixels a partir de ${area.x}, ${area.y}).`;
}
