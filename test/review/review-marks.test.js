import assert from 'node:assert/strict';
import test from 'node:test';

import {
  documentRectToSegmentPixels, integerDocumentArea, intersectRects, segmentForDocumentPoint,
  segmentPixelsToDocumentRect,
} from '../../src/core/keyboard/keyboard-map-geometry.js';
import { canonicalReviewMarks, emptyReviewMarks, REVIEW_MARKS_LIMITS, REVIEW_MARKS_VERSION } from '../../src/core/review/review-marks.js';
import { createReviewDecision, reviseReviewDecision } from '../../src/core/review/decisions.js';

// Marcas do apontamento no mapa do teclado (item 5.1.13): esquema fechado, versão 1, coordenadas em
// pixels CSS do DOCUMENTO auditado. O que não estiver nesta forma não entra em decisão nenhuma.
const marcas = (suspects = [], areas = []) => ({ version: REVIEW_MARKS_VERSION, suspects, areas });
const area = (x, y, width, height) => ({ x, y, width, height });

test('normaliza as marcas: inteiros, itens únicos em ordem e áreas congeladas', () => {
  const marks = canonicalReviewMarks(marcas([3, 1, 3, 2], [area(10, 20, 30, 40)]));
  assert.deepEqual(marks, { version: 1, suspects: [1, 2, 3], areas: [area(10, 20, 30, 40)] });
  assert.ok(Object.isFrozen(marks) && Object.isFrozen(marks.suspects) && Object.isFrozen(marks.areas[0]),
    'as marcas canônicas não podem ser mutadas depois de validadas');
});

test('sem nada apontado não há marcas: `null`, nunca um objeto vazio', () => {
  assert.equal(canonicalReviewMarks(marcas()), null);
  assert.equal(canonicalReviewMarks(marcas([], [])), null);
  assert.equal(canonicalReviewMarks(null), null);
  assert.equal(canonicalReviewMarks(undefined), null);
  assert.deepEqual(emptyReviewMarks(), marcas());
});

test('recusa marcas fora da forma fechada', () => {
  for (const invalid of [
    { version: 2, suspects: [1], areas: [] },
    { version: '1', suspects: [1], areas: [] },
    { suspects: [1], areas: [] },
    marcas([1], [{ ...area(0, 0, 1, 1), extra: 1 }]),
    { ...marcas([1], []), extra: true },
    { version: 1, suspects: '1', areas: [] },
    { version: 1, suspects: [1], areas: 'nada' },
    marcas([0], []),
    marcas([REVIEW_MARKS_LIMITS.maxSuspects + 1], []),
    marcas([1.5], []),
    marcas(['1'], []),
    marcas([], [area(-1, 0, 10, 10)]),
    marcas([], [area(0, 0, 0, 10)]),
    marcas([], [area(0, 0, 10.5, 10)]),
    marcas([], [area(0, 0, REVIEW_MARKS_LIMITS.maxCoordinate + 1, 10)]),
    marcas([], [area(REVIEW_MARKS_LIMITS.maxCoordinate, 0, 1, 1)]),
    marcas(Array.from({ length: REVIEW_MARKS_LIMITS.maxSuspects + 1 }, (_value, index) => index + 1), []),
    marcas([], Array.from({ length: REVIEW_MARKS_LIMITS.maxAreas + 1 }, () => area(0, 0, 1, 1))),
  ]) {
    assert.throws(() => canonicalReviewMarks(invalid), TypeError, JSON.stringify(invalid));
  }
});

test('recusa objeto forjado: protótipo trocado, campos herdados e acessores', () => {
  const forged = Object.create({ version: 1, suspects: [1], areas: [] });
  assert.throws(() => canonicalReviewMarks(forged), /dados simples/u);
  const inherited = Object.create(Object.prototype);
  Object.defineProperty(inherited, 'version', { value: 1, enumerable: true });
  assert.throws(() => canonicalReviewMarks(inherited), /não reconhecidos|inteiro/u);
  const accessor = { version: 1, suspects: [1], areas: [] };
  let calls = 0;
  Object.defineProperty(accessor, 'suspects', { enumerable: true, get() { calls += 1; return [1]; } });
  assert.throws(() => canonicalReviewMarks(accessor), TypeError);
  assert.equal(calls, 0, 'nenhum acessor pode ser chamado durante a validação');
});

test('o limite de áreas é público e o esquema é versionado', () => {
  assert.equal(REVIEW_MARKS_LIMITS.maxAreas, 5);
  assert.equal(REVIEW_MARKS_LIMITS.maxSuspects, 60);
  assert.equal(REVIEW_MARKS_LIMITS.version, REVIEW_MARKS_VERSION);
  assert.ok(Object.isFrozen(REVIEW_MARKS_LIMITS));
});

test('a decisão guarda as marcas e a revisão seguinte preserva as anteriores na trilha', () => {
  const decision = createReviewDecision({
    auditId: 'audit-1', itemId: '5.1.13', occurrenceId: 'occ-1', answer: 'não conforme',
    evaluator: 'Pessoa revisora', decidedAt: '2026-08-27T12:00:00.000Z', mode: 'assisted',
    note: 'Os cartões abrem menus só com o mouse.', marks: marcas([1, 2], [area(10, 20, 30, 40)]),
  });
  assert.deepEqual(decision.marks, { version: 1, suspects: [1, 2], areas: [area(10, 20, 30, 40)] });

  const revised = reviseReviewDecision(decision, {
    auditId: 'audit-1', itemId: '5.1.13', occurrenceId: 'occ-1', mode: 'assisted',
    answer: 'não conforme', evaluator: 'Outra pessoa', decidedAt: '2026-08-28T12:00:00.000Z',
    note: 'Confirmei os dois cartões.', marks: marcas([1]),
  });
  assert.deepEqual(revised.marks, { version: 1, suspects: [1], areas: [] });
  assert.deepEqual(revised.revisions.at(-1).marks, { version: 1, suspects: [1, 2], areas: [area(10, 20, 30, 40)] },
    'a resposta substituída leva o apontamento dela junto');

  // Decisões antigas, gravadas antes do apontamento, continuam válidas e sem o campo.
  const antiga = createReviewDecision({
    auditId: 'audit-1', itemId: '5.1.13', occurrenceId: 'occ-1', answer: 'conforme',
    evaluator: 'Pessoa revisora', decidedAt: '2026-08-27T12:00:00.000Z', mode: 'assisted',
  });
  assert.equal(Object.hasOwn(antiga, 'marks'), false);
  assert.throws(() => createReviewDecision({
    auditId: 'audit-1', itemId: '5.1.13', occurrenceId: 'occ-1', answer: 'não conforme',
    evaluator: 'Pessoa revisora', decidedAt: '2026-08-27T12:00:00.000Z', mode: 'assisted',
    marks: marcas([0]),
  }), TypeError);
});

test('a conta documento ↔ imagem do mapa é a mesma nos dois sentidos', () => {
  const geometry = { coordinateSpace: 'document-css-px', scaleX: 0.5, scaleY: 0.5 };
  const segment = {
    segmentId: 'seg-1', index: 1, sourceCssClip: { x: 100, y: 400, width: 800, height: 600 },
    width: 400, height: 300,
  };
  const rect = { x: 200, y: 500, width: 400, height: 300 };
  const pixels = documentRectToSegmentPixels(segment, geometry, rect);
  assert.deepEqual(pixels, { x: 50, y: 50, width: 200, height: 150 });
  assert.deepEqual(segmentPixelsToDocumentRect(segment, geometry, pixels), rect);
  assert.equal(documentRectToSegmentPixels({ ...segment, width: 0 }, geometry, rect), null,
    'trecho sem imagem não converte nada');

  const map = { segments: [segment, { ...segment, segmentId: 'seg-2', index: 2, sourceCssClip: { x: 100, y: 1000, width: 800, height: 600 } }] };
  assert.equal(segmentForDocumentPoint(map, { x: 200, y: 1100 }).segmentId, 'seg-2');
  assert.equal(segmentForDocumentPoint(map, { x: 200, y: 1900 }).segmentId, 'seg-2', 'fora dos dois, vale o mais próximo');
  assert.deepEqual(intersectRects({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 5, width: 10, height: 10 }),
    { x: 5, y: 5, width: 5, height: 5 });
  assert.equal(intersectRects({ x: 0, y: 0, width: 4, height: 4 }, { x: 5, y: 5, width: 4, height: 4 }), null);

  const size = { width: 800, height: 600 };
  assert.deepEqual(integerDocumentArea({ x: 100.4, y: 200.6, width: 9.6, height: 10.4 }, size),
    { x: 100, y: 201, width: 10, height: 10 });
  assert.deepEqual(integerDocumentArea({ x: 790, y: 590, width: 100, height: 100 }, size),
    { x: 700, y: 500, width: 100, height: 100 }, 'área que passa da borda encosta nela, sem sair do documento');
});
