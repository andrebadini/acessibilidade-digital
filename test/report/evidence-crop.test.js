import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EVIDENCE_CROP_MAX_DISPLAY_SCALE, EVIDENCE_CROP_REGION_LEGEND, EVIDENCE_CROP_TARGET_LONGEST_SIDE,
  elementCropSource, evidenceCropDisplaySize, evidenceCropWindow, evidenceMediaParts,
} from '../../src/core/report/evidence-crop.js';
import { EVIDENCE_HIGHLIGHT_CLIPPED_LEGEND, EVIDENCE_HIGHLIGHT_CONTEXT_LEGEND } from '../../src/core/report/evidence-highlight.js';
import { GUIDED_REVIEW_TREATMENT_V1 } from '../../src/core/report/evidence-treatment.js';
import { TEST_PNG, TEST_PNG_HASH } from './annotation-map-fixture.js';

// Trecho de 400×300 px CSS capturado em 2× (800×600 px de imagem): a mesma relação das capturas reais
// em tela com escala de dispositivo.
const CLIP = Object.freeze({ x: 0, y: 0, width: 400, height: 300 });
const SEGMENT = Object.freeze({
  segmentId: 'seg-1', index: 1, count: 1, role: 'image', sourceCssClip: CLIP,
  width: 800, height: 600, dataUrl: TEST_PNG, contentHash: TEST_PNG_HASH,
});
const RECT = Object.freeze({ x: 100, y: 60, width: 80, height: 20 });
// (100−0)×2 = 200; a folga é o maior valor entre 24 px e 12% do lado maior (160 × 0,12 = 19,2 → 19).
const BOX = Object.freeze({ x: 200, y: 120, width: 160, height: 40 });
const VIEW = Object.freeze({ x: 176, y: 96, width: 208, height: 88 });

function geometry(annotations = [], stops = []) {
  return {
    coordinateSpace: 'document-css-px', sourceCssSize: { width: 400, height: 300 }, sourcePixelSize: { width: 800, height: 600 },
    scaleX: 2, scaleY: 2, deviceScaleFactor: 2,
    ...(annotations.length ? { annotations } : {}), ...(stops.length ? { stops } : {}),
  };
}

function annotationMap({ pageId = 'page-1', annotations = [{ nodeId: 'n-1', sourceRect: RECT,
  marker: { x: 0.5, y: 0.5, size: 28, leaderX: 0.5, leaderY: 0.5 } }], segments = [SEGMENT] } = {}) {
  return {
    evidenceId: 'ev-map', pageId, kind: 'announcement-map', state: 'derived', fullPageEvidenceId: 'ev-full',
    derivation: { type: 'annotated-announcement-map', geometry: geometry(annotations) },
    segments, legend: [], hash: 'a'.repeat(64),
  };
}

function keyboardMap({ pageId = 'page-1', stops = [{ number: 1, nodeId: 'n-1', tag: 'button', kind: 'button', bounds: RECT }],
  segments = [SEGMENT] } = {}) {
  return {
    evidenceId: 'ev-key', pageId, kind: 'keyboard-map', state: 'derived', fullPageEvidenceId: 'ev-full',
    derivation: { type: 'annotated-keyboard-map', geometry: geometry([], stops) },
    segments, stops, suspects: [], hash: 'b'.repeat(64),
  };
}

test('o recorte do elemento sai da anotação do mapa e cai no lugar certo da imagem', () => {
  const source = elementCropSource({ evidence: [annotationMap()], pageId: 'page-1', nodeId: 'n-1' });
  assert.equal(source.sourceEvidenceId, 'seg-1');
  assert.equal(source.mapEvidenceId, 'ev-map');
  assert.deepEqual(source.view, VIEW);
  assert.deepEqual(source.artifact.metadata, { width: 800, height: 600, highlightBox: BOX });
  assert.equal(source.artifact.dataUrl, TEST_PNG);
});

test('a parada do mapa do teclado também posiciona o elemento', () => {
  const source = elementCropSource({ evidence: [keyboardMap()], pageId: 'page-1', nodeId: 'n-1' });
  assert.equal(source.mapEvidenceId, 'ev-key');
  assert.deepEqual(source.artifact.metadata.highlightBox, BOX);
  assert.deepEqual(source.view, VIEW);
});

test('sem geometria confiável não existe recorte — a posição nunca é adivinhada', () => {
  const cases = {
    'sem evidências': { evidence: [], pageId: 'page-1', nodeId: 'n-1' },
    'lista ausente': { evidence: null, pageId: 'page-1', nodeId: 'n-1' },
    'elemento sem anotação': { evidence: [annotationMap()], pageId: 'page-1', nodeId: 'n-outro' },
    'página errada': { evidence: [annotationMap()], pageId: 'page-2', nodeId: 'n-1' },
    'sem nodeId': { evidence: [annotationMap()], pageId: 'page-1', nodeId: null },
    'mapa sem trechos': { evidence: [annotationMap({ segments: [] })], pageId: 'page-1', nodeId: 'n-1' },
    'artefato de outra natureza': { evidence: [{ kind: 'element', pageId: 'page-1', nodeId: 'n-1', dataUrl: TEST_PNG }], pageId: 'page-1', nodeId: 'n-1' },
  };
  for (const [name, input] of Object.entries(cases)) assert.equal(elementCropSource(input), null, name);
});

test('trecho sem pixels guardados (orçamento estourado) não vira recorte', () => {
  const withoutPixels = { ...SEGMENT, dataUrl: undefined };
  assert.equal(elementCropSource({ evidence: [annotationMap({ segments: [withoutPixels] })], pageId: 'page-1', nodeId: 'n-1' }), null);
  // Imagem de outro tipo não entra: o cartão só mostra PNG local.
  const foreign = { ...SEGMENT, dataUrl: 'https://example.test/trecho.png' };
  assert.equal(elementCropSource({ evidence: [annotationMap({ segments: [foreign] })], pageId: 'page-1', nodeId: 'n-1' }), null);
});

test('o mapa de anúncios manda quando os dois mapas conhecem o elemento', () => {
  const evidence = [keyboardMap(), annotationMap()];
  assert.equal(elementCropSource({ evidence, pageId: 'page-1', nodeId: 'n-1' }).mapEvidenceId, 'ev-map');
});

test('o índice responde a mesma coisa na segunda consulta, sem varrer os mapas de novo', () => {
  const evidence = [annotationMap()];
  const first = elementCropSource({ evidence, pageId: 'page-1', nodeId: 'n-1' });
  assert.equal(elementCropSource({ evidence, pageId: 'page-1', nodeId: 'n-1' }), first);
  assert.equal(elementCropSource({ evidence, pageId: 'page-1', nodeId: 'n-2' }), null);
});

test('o contorno do cartão reusa o desenho do relatório com o tom próprio da revisão guiada', () => {
  const source = elementCropSource({ evidence: [annotationMap()], pageId: 'page-1', nodeId: 'n-1' });
  const parts = evidenceMediaParts(source.artifact, GUIDED_REVIEW_TREATMENT_V1, source.view);
  assert.deepEqual(parts.view, VIEW);
  assert.deepEqual(parts.image, { width: 800, height: 600 });
  assert.equal(parts.clipped, false);
  assert.equal(parts.shapes[0].kind, 'path');
  assert.equal(parts.shapes[0].attributes['fill-rule'], 'evenodd');
  const outlines = parts.shapes.filter(shape => shape.kind === 'rect' && shape.attributes.class.includes('evidence-highlight--target'));
  assert.equal(outlines.length, 1);
  assert.equal(outlines[0].attributes.class, 'evidence-highlight evidence-highlight--target');
  assert.equal(outlines[0].attributes['data-evidence-highlight'], 'target');
  // Contorno desenhado por fora do elemento, como no relatório (`EVIDENCE_HIGHLIGHT_OUTLINE_OFFSET`).
  assert.deepEqual(
    { x: outlines[0].attributes.x, y: outlines[0].attributes.y, width: outlines[0].attributes.width, height: outlines[0].attributes.height },
    { x: 197, y: 117, width: 166, height: 46 },
  );
  assert.equal(parts.legend, `Contorno vermelho: o elemento desta pergunta. ${EVIDENCE_HIGHLIGHT_CONTEXT_LEGEND}`);
});

test('elemento que passa do trecho é marcado como cortado, com a legenda avisando', () => {
  const wide = { x: 340, y: 60, width: 200, height: 40 };
  const source = elementCropSource({
    evidence: [annotationMap({ annotations: [{ nodeId: 'n-1', sourceRect: wide, marker: { x: 0, y: 0, size: 28, leaderX: 0, leaderY: 0 } }] })],
    pageId: 'page-1', nodeId: 'n-1',
  });
  // Só o pedaço dentro do trecho é contornado: 340→400 px CSS viram 680→800 px de imagem.
  assert.deepEqual(source.artifact.metadata.highlightBox, { x: 680, y: 120, width: 120, height: 80 });
  assert.equal(source.artifact.metadata.highlightClipped, true);
  assert.deepEqual(source.view, { x: 656, y: 96, width: 144, height: 128 });
  const parts = evidenceMediaParts(source.artifact, GUIDED_REVIEW_TREATMENT_V1, source.view);
  assert.equal(parts.clipped, true);
  assert.match(parts.legend, new RegExp(EVIDENCE_HIGHLIGHT_CLIPPED_LEGEND, 'u'));
});

test('miniatura sem quadro confiável ou captura de página inteira não geram recorte marcado', () => {
  assert.equal(evidenceMediaParts({ kind: 'element', dataUrl: TEST_PNG }, GUIDED_REVIEW_TREATMENT_V1), null);
  assert.equal(evidenceMediaParts({ kind: 'full-page', dataUrl: TEST_PNG, metadata: { width: 800, height: 600 } }, GUIDED_REVIEW_TREATMENT_V1), null);
  assert.equal(evidenceMediaParts(null, GUIDED_REVIEW_TREATMENT_V1), null);
  assert.equal(evidenceMediaParts({ kind: 'element', dataUrl: TEST_PNG, metadata: { width: 800, height: 600, highlightBox: BOX } }, null), null);
});

test('o tamanho de leitura mantém a proporção, encolhe o que é grande e não amplia demais', () => {
  // Janela alta de página estreita: o lado maior manda no tamanho de leitura.
  const tall = evidenceCropDisplaySize({ x: 0, y: 0, width: 80, height: 640 });
  assert.equal(Math.max(tall.width, tall.height), EVIDENCE_CROP_TARGET_LONGEST_SIDE);
  assert.equal(tall.width / tall.height, 80 / 640);
  const wide = evidenceCropDisplaySize({ x: 0, y: 0, width: 1200, height: 300 });
  assert.deepEqual(wide, { width: 320, height: 80 });
  const huge = evidenceCropDisplaySize({ x: 0, y: 0, width: 100_000, height: 100_000 });
  assert.deepEqual(huge, { width: 320, height: 320 }, 'o lado maior nunca passa do alvo de leitura');
  const tiny = evidenceCropDisplaySize({ x: 0, y: 0, width: 20, height: 10 });
  assert.equal(tiny.width, 20 * EVIDENCE_CROP_MAX_DISPLAY_SCALE, 'o pequeno amplia até o teto de nitidez');
  assert.equal(tiny.height, 10 * EVIDENCE_CROP_MAX_DISPLAY_SCALE);
  // A caixa ampliada passa limites próprios, sem distorcer.
  const zoom = evidenceCropDisplaySize({ x: 0, y: 0, width: 400, height: 300 }, { longestSide: 880, maxWidth: 880, maxHeight: 620, maxScale: 6 });
  assert.equal(zoom.height, 620);
  assert.ok(Math.abs(zoom.width / zoom.height - 400 / 300) < 0.01, 'a ampliação mantém a proporção');
  assert.equal(evidenceCropDisplaySize({ x: 0, y: 0, width: 0, height: 10 }), null);
  assert.equal(evidenceCropDisplaySize(null), null);
});

test('a janela do recorte fica dentro da imagem e a frase diz de onde o recorte veio', () => {
  assert.deepEqual(evidenceCropWindow({ x: 0, y: 0, width: 10, height: 10 }, { width: 8, height: 8 }), { x: 0, y: 0, width: 8, height: 8 });
  assert.equal(evidenceCropWindow({ x: 0, y: 0, width: 10, height: 10 }, null), null);
  assert.equal(evidenceCropWindow(null, { width: 8, height: 8 }), null);
  assert.match(EVIDENCE_CROP_REGION_LEGEND, /captura da página inteira/u);
});
