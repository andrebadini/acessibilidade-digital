import { annotationBadgeSize, annotationCode, annotationLeaderPoint } from './annotation-map-artifact.js';

/**
 * Regra única de posicionamento das etiquetas de leitura (caixa com o código L1, L2…). Vale para o mapa
 * anexado ao relatório da auditoria e para o mapa da conferência de leitura por Tab: os dois desenham a
 * mesma caixa, encostada no elemento, com a mesma linha-guia, e é isso que faz os dois mapas serem
 * lidos do mesmo jeito.
 */
export const ANNOTATION_BADGE_GAP_PX = 2;
const BADGE_RING_LIMIT = 6;
const MAX_BADGE_CANDIDATES = 120;

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function distanceSquared(a, b) {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
}

function overlapping(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function boundedSpiralTrail(bounds, size, width, height) {
  const originX = clamp(bounds.x, 0, Math.max(0, width - size.width));
  const originY = clamp(bounds.y, 0, Math.max(0, height - size.height));
  const step = Math.max(size.width, size.height) + ANNOTATION_BADGE_GAP_PX;
  const trail = [];
  const add = (column, row) => {
    if (trail.length >= MAX_BADGE_CANDIDATES) return;
    trail.push({
      x: clamp(originX + column * step, 0, Math.max(0, width - size.width)),
      y: clamp(originY + row * step, 0, Math.max(0, height - size.height)),
    });
  };
  for (let ring = 1; ring <= BADGE_RING_LIMIT && trail.length < MAX_BADGE_CANDIDATES; ring += 1) {
    for (let offset = -ring; offset <= ring && trail.length < MAX_BADGE_CANDIDATES; offset += 1) {
      add(offset, -ring);
      add(offset, ring);
    }
    for (let offset = -ring + 1; offset <= ring - 1 && trail.length < MAX_BADGE_CANDIDATES; offset += 1) {
      add(-ring, offset);
      add(ring, offset);
    }
  }
  return trail;
}

/**
 * Posições candidatas da etiqueta, começando encostada na própria caixa — à esquerda, acima, à direita
 * e abaixo —, e só depois abrindo em anel. O código encosta no alvo antes de procurar lugar livre: a
 * caixa do elemento é o que a pessoa precisa ver para comparar com a página.
 */
function badgeCandidates(bounds, size, width, height) {
  const clampPoint = (x, y) => ({
    x: clamp(x, 0, Math.max(0, width - size.width)),
    y: clamp(y, 0, Math.max(0, height - size.height)),
  });
  const gap = ANNOTATION_BADGE_GAP_PX;
  const points = [
    [bounds.x - size.width - gap, bounds.y + bounds.height / 2 - size.height / 2],
    [bounds.x, bounds.y - size.height - gap],
    [bounds.x + bounds.width + gap, bounds.y + bounds.height / 2 - size.height / 2],
    [bounds.x, bounds.y + bounds.height + gap],
    [bounds.x - size.width - gap, bounds.y - size.height - gap],
    [bounds.x + bounds.width - size.width, bounds.y - size.height - gap],
    [bounds.x, bounds.y], [bounds.x + bounds.width - size.width, bounds.y],
    [bounds.x, bounds.y + bounds.height - size.height], [bounds.x + bounds.width - size.width, bounds.y + bounds.height - size.height],
  ];
  const candidates = points.map(([x, y]) => clampPoint(x, y));
  candidates.push(...boundedSpiralTrail(bounds, size, width, height));
  const seen = new Set();
  return candidates.filter(candidate => {
    const key = `${candidate.x}:${candidate.y}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Coloca as etiquetas de um trecho: custo = outra etiqueta (peso dominante, para a anticolisão
 * continuar mandando) + cobrir a caixa de outro elemento + cobrir a própria caixa. A primeira candidata
 * sem custo vence — o que mantém o trabalho baixo numa página com centenas de anotações —, e quando
 * nenhuma zera fica a de menor custo, com a limitação de sobreposição declarada. A distância até o
 * canto de encaixe desempata: entre duas posições livres, fica a que encosta no alvo.
 *
 * `entries` traz `number` e `bounds` na mesma medida usada para desenhar (px do documento no relatório,
 * px da imagem no mapa da conferência) e `cssWidth`, a largura usada no tamanho da etiqueta — assim a
 * caixa do código mantém a mesma proporção legível nos dois mapas.
 */
export function annotationMarkerLayout(entries, { width, height, cssWidth } = {}) {
  const placements = [];
  let unresolved = 0;
  const sized = entries.map(entry => ({ entry, size: annotationBadgeSize(entry.number, cssWidth) }));
  const elementBoxes = entries.map(entry => entry.bounds);
  for (const [index, { entry, size }] of sized.entries()) {
    const candidates = badgeCandidates(entry.bounds, size, width, height);
    const anchor = candidates[0] ?? { x: entry.bounds.x, y: entry.bounds.y };
    const clearance = Math.max(size.width, size.height) * 0.9;
    let selected = null;
    for (const [offset, candidate] of candidates.entries()) {
      const box = { x: candidate.x, y: candidate.y, width: size.width, height: size.height };
      const center = { x: box.x + size.width / 2, y: box.y + size.height / 2 };
      // `placed.x`/`placed.y` já são o centro da etiqueta publicada: a distância é entre centros. Somar
      // meia caixa aqui comparava um centro com uma borda deslocada e deixava passar etiquetas coladas.
      const collisions = placements.reduce((total, placed) => total +
        (distanceSquared(center, { x: placed.x, y: placed.y }) < clearance ** 2 ? 1 : 0), 0);
      let cost = collisions * 100 + Math.hypot(box.x - anchor.x, box.y - anchor.y);
      for (const [otherIndex, other] of elementBoxes.entries()) {
        if (overlapping(box, other)) cost += otherIndex === index ? 2 : 5;
      }
      if (!selected || cost < selected.cost || cost === selected.cost && offset < selected.offset) {
        selected = { box, collisions, cost, offset };
      }
      if (cost <= 1e-9) break;
    }
    if (selected.collisions > 0) unresolved += 1;
    // Ponta da linha-guia: a borda do contorno mais próxima do centro da etiqueta, e não o centro do
    // elemento — a linha pelo centro riscaria o conteúdo do alvo na diagonal. Se a etiqueta já encosta no
    // contorno, a ponta devolvida é o próprio centro e o desenho não traça linha nenhuma.
    const center = { x: selected.box.x + size.width / 2, y: selected.box.y + size.height / 2 };
    const leader = annotationLeaderPoint(entry.bounds, center.x, center.y);
    placements.push({
      number: entry.number, code: annotationCode(entry.number),
      x: center.x, y: center.y, width: size.width, height: size.height,
      leaderX: leader.x, leaderY: leader.y,
      bounds: entry.bounds, overlapped: selected.collisions > 0,
    });
  }
  return { placements, unresolved };
}
