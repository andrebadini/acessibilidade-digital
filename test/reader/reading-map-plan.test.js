import assert from 'node:assert/strict';
import test from 'node:test';

import {
  READING_MAP_OVERLAP_NOTE, READING_MAP_UNMEASURED, readingMapPlan, validPageMapGeometry,
} from '../../src/reader/reading-map-plan.js';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
// Captura de 1000×500 CSS que virou um PNG de 2000×1000: escala 2, como numa tela de alta densidade.
const GEOMETRY = { pixelWidth: 2000, pixelHeight: 1000, cssWidth: 1000, cssHeight: 500 };

const entry = (id, bounds, fields = {}) => ({
  id, tag: 'button', role: 'button', name: 'Enviar', preview: 'Enviar, botão', description: '',
  states: [], selector: `#${id}`, category: 'tab', tabOrder: null, tabIndex: 0, bounds, reasons: [], ...fields,
});
const report = (entries, geometry = GEOMETRY) => ({ pageMap: PNG, pageMapGeometry: geometry, entries });
const badgeBox = marker => ({ x: marker.badge.x, y: marker.badge.y, width: marker.badge.width, height: marker.badge.height });
const boxesOverlap = (left, right) => left.x < right.x + right.width && left.x + left.width > right.x &&
  left.y < right.y + right.height && left.y + left.height > right.y;
/** Folga entre a etiqueta e a caixa do elemento: 0 quando os dois retângulos se encostam ou se cruzam. */
const gapBetween = (badge, box) => Math.hypot(
  Math.max(box.x - (badge.x + badge.width), badge.x - (box.x + box.width), 0),
  Math.max(box.y - (badge.y + badge.height), badge.y - (box.y + box.height), 0),
);

test('sem captura não existe mapa e sem medida não existe marcação', () => {
  assert.equal(readingMapPlan({ entries: [] }), null, 'relatório sem captura não tem mapa');
  const unmeasured = readingMapPlan(report([entry('a', { x: 0, y: 0, width: 40, height: 20 })], null));
  assert.deepEqual(unmeasured.markers, [], 'sem escala conhecida nenhuma caixa é desenhada');
  assert.deepEqual(unmeasured.legend, []);
  assert.deepEqual(unmeasured.notes, [READING_MAP_UNMEASURED]);
});

test('numera os códigos uma única vez, na ordem de leitura, e converte a caixa pela escala da captura', () => {
  // `report.entries` já vem na ordem de leitura (Tab e depois conteúdo estrutural): o mapa numera nessa
  // ordem, sem reordenar por conta própria.
  const plan = readingMapPlan(report([
    entry('first', { x: 10, y: 20, width: 60, height: 24 }, { tabOrder: 1, preview: 'Ir para o conteúdo, link', tag: 'a', role: 'link' }),
    entry('second', { x: 100, y: 200, width: 80, height: 30 }, { tabOrder: 2, preview: 'Menu, botão' }),
    entry('title', { x: 0, y: 60, width: 300, height: 40 }, { category: 'reading', role: 'heading', tag: 'h1', preview: 'Título principal, título' }),
  ]));
  assert.deepEqual(plan.markers.map(marker => marker.code), ['L1', 'L2', 'L3']);
  assert.deepEqual(plan.legend.map(item => item.code), ['L1', 'L2', 'L3']);
  assert.equal(new Set(plan.markers.map(marker => marker.code)).size, 3, 'nenhum código se repete');
  assert.deepEqual(plan.markers.map(marker => marker.entryId), ['first', 'second', 'title']);
  // A caixa medida no documento (10,20,60×24 CSS) vira (20,40,120×48) nos pixels da imagem.
  assert.deepEqual(plan.markers[0].outline, { x: 20, y: 40, width: 120, height: 48 });
  assert.deepEqual(plan.markers[1].outline, { x: 200, y: 400, width: 160, height: 60 });
  assert.equal(plan.width, 2000, 'o viewBox do mapa é o tamanho em pixel do PNG');
  assert.equal(plan.height, 1000);
});

test('a coluna da direita traz o texto que seria ouvido e o Tab de quem recebe foco', () => {
  const plan = readingMapPlan(report([
    entry('first', { x: 10, y: 20, width: 60, height: 24 }, { tabOrder: 1 }),
    entry('title', { x: 0, y: 60, width: 300, height: 40 }, { category: 'reading', role: 'heading', tag: 'h1', preview: 'Título principal, título' }),
  ]));
  assert.deepEqual(plan.legend[0], {
    number: 1, code: 'L1', entryId: 'first', tone: 'ok', tabOrder: 1, text: 'Enviar, botão', truncated: false,
  });
  assert.equal(plan.legend[1].tabOrder, null, 'conteúdo estrutural não recebe foco por Tab');
  assert.equal(plan.legend[1].text, 'Título principal, título');
});

test('etiquetas do mesmo lugar não se sobrepõem: cada código fica numa caixa livre', () => {
  const bounds = { x: 400, y: 200, width: 60, height: 24 };
  const plan = readingMapPlan(report(Array.from({ length: 6 }, (unused, index) => entry(`e${index}`, bounds, { tabOrder: index + 1 }))));
  assert.equal(plan.markers.length, 6);
  const boxes = plan.markers.map(badgeBox);
  for (const [index, box] of boxes.entries()) {
    for (const other of boxes.slice(index + 1)) assert.equal(boxesOverlap(box, other), false, 'duas etiquetas não podem ocupar o mesmo lugar');
  }
  assert.equal(plan.notes.includes(READING_MAP_OVERLAP_NOTE), false, 'com lugar livre a limitação não é declarada');
});

test('numa coluna apertada o código continua encostado na própria caixa', () => {
  // Cento e dez elementos empilhados de 25 em 25 px — a forma de um menu, de uma lista de resultados ou
  // de uma tabela —, com códigos que chegam a L110. A anticolisão já mediu a distância entre os CENTROS
  // das etiquetas: duas etiquetas de 36 px de largura empilhadas com a folga de 2 px eram tratadas como
  // colisão, e o código era empurrado para o anel, dezenas de px longe do alvo (medido: até 27 px de
  // folga, média 7 px). Agora a colisão é a do retângulo de verdade, e a etiqueta fica onde encosta.
  const entries = Array.from({ length: 110 }, (unused, index) =>
    entry(`e${index}`, { x: 20, y: 30 + index * 25, width: 600, height: 20 }, { tabOrder: index + 1 }));
  const plan = readingMapPlan(report(entries, { pixelWidth: 1000, pixelHeight: 3000, cssWidth: 1000, cssHeight: 3000 }));
  assert.equal(plan.markers.length, 110);
  const gaps = plan.markers.map(marker => gapBetween(badgeBox(marker), marker.outline));
  assert.ok(Math.max(...gaps) <= 4, `todo código encosta na própria caixa (maior folga: ${Math.max(...gaps).toFixed(1)} px)`);
  assert.equal(plan.markers.filter(marker => marker.overlapped).length, 0, 'sem aperto de verdade nenhuma etiqueta é declarada sobreposta');
});

test('declara a limitação quando as etiquetas ficam sobrepostas e quando o mapa é cortado no limite', () => {
  // Todos os elementos no mesmo pixel e a imagem sem espaço em volta: não há posição livre para todos.
  const crowded = readingMapPlan(report(Array.from({ length: 40 }, (unused, index) => entry(`e${index}`, { x: 0, y: 0, width: 20, height: 10 }, { tabOrder: index + 1 }))));
  assert.ok(crowded.markers.some(marker => marker.overlapped), 'a sobreposição não resolvida fica marcada');
  assert.ok(crowded.notes.includes(READING_MAP_OVERLAP_NOTE));

  const many = readingMapPlan(report(Array.from({ length: 260 }, (unused, index) => entry(`e${index}`, { x: 0, y: index * 2, width: 20, height: 10 }, { tabOrder: index + 1 }))));
  assert.equal(many.markers.length, 200, 'o mapa marca até o limite congelado de elementos');
  assert.equal(many.legend.length, 200);
  assert.ok(many.notes.some(note => /60/.test(note)), 'a nota diz quantos elementos ficaram fora do mapa');
});

test('recusa medida incoerente em vez de desenhar com escala inventada', () => {
  assert.equal(validPageMapGeometry(null), null);
  assert.equal(validPageMapGeometry({ pixelWidth: 0, pixelHeight: 10, cssWidth: 10, cssHeight: 10 }), null);
  assert.equal(validPageMapGeometry({ pixelWidth: 10, pixelHeight: -1, cssWidth: 10, cssHeight: 10 }), null);
  assert.equal(validPageMapGeometry({ pixelWidth: 99_999, pixelHeight: 10, cssWidth: 10, cssHeight: 10 }), null);
  assert.deepEqual(validPageMapGeometry(GEOMETRY), { ...GEOMETRY, scaleX: 2, scaleY: 2 });
  assert.equal(readingMapPlan(report([entry('a', { x: 0, y: 0, width: 10, height: 10 })], { pixelWidth: 'x' })).markers.length, 0);
});
