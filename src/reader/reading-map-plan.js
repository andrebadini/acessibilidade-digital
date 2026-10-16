/**
 * Planejamento do mapa de leitura da conferência por Tab.
 *
 * É o mesmo desenho do mapa anexado ao relatório da auditoria — contorno no elemento, etiqueta
 * encostada nele com o código curto (L1, L2…) e linha-guia — e a posição das etiquetas sai da MESMA
 * regra (`annotationMarkerLayout`), para os dois mapas serem lidos do mesmo jeito.
 *
 * A diferença está na origem das medidas. No relatório da auditoria o mapa é rasterizado a partir do
 * artefato; aqui as caixas vêm do documento medido na página e precisam ser convertidas para pixel da
 * imagem pela escala real da captura. É essa conversão que faz a caixa cair sobre o elemento: o mapa é
 * desenhado com `viewBox` do tamanho em pixel do PNG, e não a partir da maior coordenada observada.
 */
import {
  ANNOTATION_MAP_LIMITS,
  ANNOTATION_MAP_LEADER_MIN_PX,
  annotationBadgeFont,
  annotationCode,
  annotationLeaderPoint,
} from '../core/evidence/annotation-map-artifact.js';
import { annotationMarkerLayout } from '../core/evidence/annotation-marker-layout.js';
import { entryTone, roleName } from './plain-language.js';

export const READING_MAP_TITLE = 'Mapa de leitura da página';
export const READING_MAP_INTRO = 'Cada caixa marca um elemento da página. O código da caixa (L1, L2…) leva ao texto que um leitor de tela falaria, na coluna ao lado. Os códigos seguem a ordem de leitura observada: primeiro o que recebe Tab, depois o conteúdo estrutural.';
export const READING_MAP_UNAVAILABLE = 'Captura da página inteira não disponível nesta inspeção.';
export const READING_MAP_UNMEASURED = 'A medida da captura não foi registrada nesta inspeção. Para não apontar o lugar errado, nenhum código foi desenhado: os textos continuam nas tabelas abaixo.';
export const READING_MAP_OVERLAP_NOTE = 'Alguns códigos ficaram muito próximos e podem aparecer sobrepostos. Use a tabela do elemento para confirmar.';
export const READING_MAP_TRUNCATED_NOTE = 'Textos muito longos aparecem cortados aqui. O texto completo está na tabela do elemento.';
const LIMIT_NOTE = omitted => `O mapa marca os ${ANNOTATION_MAP_LIMITS.maxNodes} primeiros elementos da ordem de leitura. Os outros ${omitted} estão nas tabelas abaixo.`;
const LEGEND_TEXT_LIMIT = 600;
const MAP_CATEGORIES = ['tab', 'reading'];

function clipRect(rect, width, height) {
  const x = Math.max(0, Math.min(rect.x, width));
  const y = Math.max(0, Math.min(rect.y, height));
  const right = Math.max(x, Math.min(rect.x + rect.width, width));
  const bottom = Math.max(y, Math.min(rect.y + rect.height, height));
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

/**
 * Medida da captura, quando registrada: tamanho do PNG e tamanho em CSS que o recorte cobriu. A escala
 * sai da razão entre os dois — é o que converte a caixa medida no documento para o pixel da imagem.
 */
export function validPageMapGeometry(value) {
  if (!value || typeof value !== 'object') return null;
  const values = [value.pixelWidth, value.pixelHeight, value.cssWidth, value.cssHeight];
  if (!values.every(item => Number.isFinite(item) && item > 0)) return null;
  if (value.pixelWidth > 16384 || value.pixelHeight > 16384 || value.cssWidth > 200_000 || value.cssHeight > 200_000) return null;
  return {
    pixelWidth: Math.round(value.pixelWidth), pixelHeight: Math.round(value.pixelHeight),
    cssWidth: value.cssWidth, cssHeight: value.cssHeight,
    scaleX: value.pixelWidth / value.cssWidth, scaleY: value.pixelHeight / value.cssHeight,
  };
}

function legendText(entry) {
  const preview = String(entry.preview ?? '').replace(/\s+/gu, ' ').trim();
  return preview || [entry.name, roleName(entry)].filter(Boolean).join(', ') || 'Sem texto anunciado';
}

function legendItem(entry, number) {
  const full = legendText(entry);
  return {
    number, code: annotationCode(number), entryId: entry.id, tone: entryTone(entry),
    tabOrder: entry.tabOrder ?? null,
    text: full.length > LEGEND_TEXT_LIMIT ? `${full.slice(0, LEGEND_TEXT_LIMIT)}…` : full,
    truncated: full.length > LEGEND_TEXT_LIMIT,
  };
}

/** Ponto onde a linha-guia sai da etiqueta: a borda da caixa na direção do alvo, nunca o meio dela. */
function badgeEdgePoint(box, target) {
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const deltaX = target.x - center.x;
  const deltaY = target.y - center.y;
  if (deltaX === 0 && deltaY === 0) return center;
  const factorX = deltaX === 0 ? Infinity : (box.width / 2) / Math.abs(deltaX);
  const factorY = deltaY === 0 ? Infinity : (box.height / 2) / Math.abs(deltaY);
  const factor = Math.min(factorX, factorY);
  return Number.isFinite(factor) ? { x: center.x + deltaX * factor, y: center.y + deltaY * factor } : center;
}

function markerOf(placement, entry, geometry, scale, strokeWidth) {
  const { width, height } = placement;
  const x = Math.max(0, Math.min(placement.x - width / 2, Math.max(0, geometry.pixelWidth - width)));
  const y = Math.max(0, Math.min(placement.y - height / 2, Math.max(0, geometry.pixelHeight - height)));
  const box = { x, y, width, height };
  const center = { x: x + width / 2, y: y + height / 2 };
  // A ponta é medida no contorno desenhado, em px de imagem: o mínimo de `annotationLeaderPoint` vale
  // em px de documento, então entra multiplicado pela escala — igual ao mapa do relatório.
  const target = annotationLeaderPoint(placement.bounds, center.x, center.y, ANNOTATION_MAP_LEADER_MIN_PX * scale);
  const start = badgeEdgePoint(box, target);
  const size = annotationBadgeFont(height);
  return {
    entryId: entry.id, number: placement.number, code: placement.code, tone: entryTone(entry),
    overlapped: placement.overlapped, strokeWidth,
    outline: placement.bounds,
    badge: { ...box, radius: Math.round(height * 0.28) },
    label: { x: center.x, y: center.y + Math.round(size * 0.35), size },
    leader: Math.hypot(target.x - start.x, target.y - start.y) >= 2
      ? { x1: start.x, y1: start.y, x2: target.x, y2: target.y } : null,
  };
}

/**
 * Plano do mapa: medidas da imagem, marcas com código e a legenda que acompanha cada código. Devolve
 * `null` quando a inspeção não guardou captura — sem imagem não existe mapa para desenhar.
 */
export function readingMapPlan(report) {
  if (!report?.pageMap) return null;
  const entries = (Array.isArray(report.entries) ? report.entries : [])
    .filter(entry => entry && MAP_CATEGORIES.includes(entry.category) && entry.bounds);
  const geometry = validPageMapGeometry(report.pageMapGeometry);
  if (!geometry) return { width: 0, height: 0, markers: [], legend: [], notes: [READING_MAP_UNMEASURED] };
  const drawn = [];
  for (const entry of entries) {
    if (drawn.length >= ANNOTATION_MAP_LIMITS.maxNodes) break;
    const bounds = clipRect({
      x: entry.bounds.x * geometry.scaleX, y: entry.bounds.y * geometry.scaleY,
      width: entry.bounds.width * geometry.scaleX, height: entry.bounds.height * geometry.scaleY,
    }, geometry.pixelWidth, geometry.pixelHeight);
    if (bounds) drawn.push({ ...entry, number: drawn.length + 1, bounds });
  }
  const scale = Math.min(geometry.scaleX, geometry.scaleY);
  const strokeWidth = Math.max(2, Math.round(2 * scale));
  const { placements } = annotationMarkerLayout(drawn, {
    width: geometry.pixelWidth, height: geometry.pixelHeight, cssWidth: geometry.pixelWidth,
  });
  const legend = drawn.map((entry, index) => legendItem(entry, index + 1));
  const byNumber = new Map(drawn.map(entry => [entry.number, entry]));
  const markers = placements.map(placement => markerOf(placement, byNumber.get(placement.number), geometry, scale, strokeWidth));
  const notes = [];
  if (entries.length > drawn.length) notes.push(LIMIT_NOTE(entries.length - drawn.length));
  if (legend.some(item => item.truncated)) notes.push(READING_MAP_TRUNCATED_NOTE);
  if (markers.some(marker => marker.overlapped)) notes.push(READING_MAP_OVERLAP_NOTE);
  return { width: geometry.pixelWidth, height: geometry.pixelHeight, markers, legend, notes };
}
