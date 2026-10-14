import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EVIDENCE_HIGHLIGHT_CLIPPED_LEGEND,
  EVIDENCE_HIGHLIGHT_CONTEXT_LEGEND,
  EVIDENCE_HIGHLIGHT_MAX_PARTS,
  EVIDENCE_HIGHLIGHT_OUTLINE_OFFSET,
  EVIDENCE_HIGHLIGHT_UNMARKED_LEGEND,
  EVIDENCE_SPOTLIGHT_OPACITY,
  evidenceCaptureSize,
  evidenceHighlight,
  evidenceHighlightLegend,
  evidenceHighlightRects,
  evidenceHighlightShapes,
  evidenceOutlineRect,
  evidencePixelScale,
  evidenceRasterMatchesCapture,
  evidenceSpotlightPath,
} from '../../src/core/report/evidence-highlight.js';
import { EVIDENCE_TREATMENTS_V1 } from '../../src/core/report/evidence-treatment.js';

const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';

function elementEvidence(metadata, extra = {}) {
  return { evidenceId: 'ev-1', kind: 'element', dataUrl: PNG_DATA_URL, metadata, ...extra };
}

test('sizes the drawn frame from the capture metadata, never from the decoded PNG', () => {
  assert.deepEqual(evidenceCaptureSize(elementEvidence({ width: 128, height: 88 })), { width: 128, height: 88 });
  // Sem width/height declarados, o próprio recorte descreve o quadro.
  assert.deepEqual(evidenceCaptureSize(elementEvidence({ clip: { x: 10, y: 20, width: 300, height: 200 } })),
    { width: 300, height: 200 });
  // O PNG tem 1×1 px e o quadro declarado é 128×88: misturar os dois sistemas desalinharia a caixa.
  assert.deepEqual(evidenceCaptureSize(elementEvidence({ width: 128, height: 88 })), { width: 128, height: 88 });
  for (const metadata of [undefined, null, {}, { width: 128 }, { width: 0, height: 88 }, { clip: { width: Number.NaN, height: 10 } }]) {
    assert.equal(evidenceCaptureSize(elementEvidence(metadata)), null);
  }
});

test('accepts a raster that is the declared frame times the pixel scale', () => {
  // Miniatura capturada em 2×: o quadro é 110×110 CSS px e o PNG mede 220×220.
  const doubled = elementEvidence({ width: 110, height: 110, clip: { x: 0, y: 0, width: 110, height: 110, scale: 2 }, pixelScale: 2 });
  assert.equal(evidencePixelScale(doubled), 2);
  assert.equal(evidenceRasterMatchesCapture(doubled, { width: 220, height: 220 }), true);
  // Um pixel de diferença é arredondamento do retângulo de dispositivo do Chrome, não desalinhamento.
  assert.equal(evidenceRasterMatchesCapture(doubled, { width: 221, height: 219 }), true);
  assert.equal(evidenceRasterMatchesCapture(doubled, { width: 110, height: 110 }), false, 'o PNG cru não é o quadro');
  assert.equal(evidenceRasterMatchesCapture(doubled, { width: 330, height: 330 }), false);

  // Auditorias anteriores à 1.1.57 não declaram escala: o PNG mede exatamente o quadro.
  const legacy = elementEvidence({ width: 128, height: 88 });
  assert.equal(evidencePixelScale(legacy), 1);
  assert.equal(evidenceRasterMatchesCapture(legacy, { width: 128, height: 88 }), true);
  assert.equal(evidenceRasterMatchesCapture(legacy, { width: 256, height: 176 }), false);

  // Campo opcional malformado não vira escala: vale 1 e a comparação usa o próprio PNG.
  for (const pixelScale of [0, -2, 1.5, '2', Number.NaN, Number.POSITIVE_INFINITY]) {
    const hostile = elementEvidence({ width: 110, height: 110, pixelScale });
    assert.equal(evidencePixelScale(hostile), 1);
    assert.equal(evidenceRasterMatchesCapture(hostile, { width: 220, height: 220 }), false);
  }
  assert.equal(evidenceRasterMatchesCapture(elementEvidence({}), { width: 10, height: 10 }), false);
  assert.equal(evidenceRasterMatchesCapture(doubled, null), false);
});

test('reads the target rectangles from highlightParts and understands audits written before 1.1.57', () => {
  const parts = evidenceHighlightRects(elementEvidence({
    highlightParts: [{ x: 1, y: 2, width: 3, height: 4 }, { x: 5, y: 6, width: 7, height: 8 }],
  }));
  assert.deepEqual(parts, [{ x: 1, y: 2, width: 3, height: 4 }, { x: 5, y: 6, width: 7, height: 8 }]);
  // Dados antigos trazem só a união.
  assert.deepEqual(evidenceHighlightRects(elementEvidence({
    highlightBox: { x: 24, y: 12, width: 80, height: 40, coordinateSpace: 'capture-css-px' },
  })), [{ x: 24, y: 12, width: 80, height: 40 }]);
  // Partes degeneradas não viram furo; cai para a união, e sem união não há o que desenhar.
  assert.deepEqual(evidenceHighlightRects(elementEvidence({
    highlightParts: [{ x: 0, y: 0, width: 0, height: 10 }], highlightBox: { x: 4, y: 4, width: 10, height: 10 },
  })), [{ x: 4, y: 4, width: 10, height: 10 }]);
  assert.equal(evidenceHighlightRects(elementEvidence({})), null);
  assert.equal(evidenceHighlightRects(elementEvidence({ highlightBox: { x: 0, y: 0, width: 0, height: 0 } })), null);
  assert.equal(evidenceHighlightRects({ metadata: null }), null);
});

test('draws a whole element even when a hostile metadata carries more parts than the cap', () => {
  const many = Array.from({ length: 40 }, (_value, index) => ({ x: 0, y: index * 4, width: 10, height: 4 }));
  const highlight = evidenceHighlight(elementEvidence({ width: 100, height: 400, highlightParts: many }));
  assert.equal(highlight.parts.length, EVIDENCE_HIGHLIGHT_MAX_PARTS);
  assert.deepEqual(highlight.parts[0], { x: 0, y: 0, width: 10, height: 4 });
  // A união continua sendo a união das partes desenhadas, para a caixa nunca sair do contorno.
  assert.deepEqual(highlight.box, { x: 0, y: 0, width: 10, height: 32 });
});

test('clips every part inside the captured frame and reports clipped only when the capture says so', () => {
  const highlight = evidenceHighlight(elementEvidence({
    width: 100, height: 100,
    highlightParts: [{ x: -20, y: 10, width: 40, height: 20 }, { x: 80, y: 90, width: 60, height: 60 }],
  }));
  assert.deepEqual(highlight.parts, [{ x: 0, y: 10, width: 20, height: 20 }, { x: 80, y: 90, width: 20, height: 10 }]);
  assert.deepEqual(highlight.box, { x: 0, y: 10, width: 100, height: 90 });
  assert.equal(highlight.clipped, false);
  assert.equal(highlight.coordinateSpace, 'capture-css-px');
  assert.equal(evidenceHighlight(elementEvidence({ width: 100, height: 100, highlightClipped: true,
    highlightBox: { x: 10, y: 10, width: 30, height: 30 } })).clipped, true);
  // Uma parte inteiramente fora do quadro não vira furo vazio; sem nada desenhável, não há marcação.
  assert.equal(evidenceHighlight(elementEvidence({ width: 100, height: 100,
    highlightBox: { x: 200, y: 200, width: 30, height: 30 } })), null);
});

test('has no geometry to draw when the capture carries no frame or no target', () => {
  assert.equal(evidenceHighlight(elementEvidence(undefined)), null);
  assert.equal(evidenceHighlight(elementEvidence({ width: 128, height: 88 })), null);
  // Sem quadro declarado, a captura não pode ser marcada nem usando o recorte: o PNG tem 1×1 px.
  assert.equal(evidenceHighlight(elementEvidence({})), null);
});

test('expands the outline outside the element and never past the image edges', () => {
  assert.equal(EVIDENCE_HIGHLIGHT_OUTLINE_OFFSET, 3);
  assert.deepEqual(evidenceOutlineRect({ x: 24, y: 12, width: 80, height: 40 }, 128, 88),
    { x: 21, y: 9, width: 86, height: 46 });
  assert.deepEqual(evidenceOutlineRect({ x: 0, y: 0, width: 128, height: 88 }, 128, 88),
    { x: 0, y: 0, width: 128, height: 88 });
  assert.deepEqual(evidenceOutlineRect({ x: 1, y: 1, width: 10, height: 10 }, 128, 88),
    { x: 0, y: 0, width: 14, height: 14 });
});

test('darkens everything except the target, leaving one hole per drawn part', () => {
  const highlight = evidenceHighlight(elementEvidence({
    width: 128, height: 88,
    highlightParts: [{ x: 24, y: 12, width: 80, height: 20 }, { x: 24, y: 36, width: 40, height: 20 }],
  }));
  assert.equal(evidenceSpotlightPath(highlight),
    'M0 0H128V88H0ZM24 12H104V32H24ZM24 36H64V56H24Z');
  assert.equal(EVIDENCE_SPOTLIGHT_OPACITY, 0.38);
});

test('paints every white halo before any coloured stroke so neighbouring lines do not cover each other', () => {
  const highlight = evidenceHighlight(elementEvidence({
    width: 128, height: 88,
    highlightParts: [{ x: 24, y: 12, width: 80, height: 20 }, { x: 24, y: 30, width: 40, height: 20 }],
  }));
  const shapes = evidenceHighlightShapes(highlight, 'failed');
  assert.equal(shapes[0].kind, 'path');
  assert.equal(shapes[0].attributes.class, 'evidence-spotlight');
  assert.equal(shapes[0].attributes['fill-rule'], 'evenodd');
  const classes = shapes.slice(1).map(shape => shape.attributes.class);
  assert.deepEqual(classes, ['evidence-halo', 'evidence-halo',
    'evidence-highlight evidence-highlight--failed', 'evidence-highlight evidence-highlight--failed']);
  for (const shape of shapes.slice(1)) {
    assert.equal(shape.kind, 'rect');
    assert.equal(shape.attributes.rx, 2);
    assert.equal(shape.attributes['aria-hidden'], 'true');
  }
  assert.deepEqual(shapes.slice(1).map(shape => [shape.attributes.x, shape.attributes.y, shape.attributes.width, shape.attributes.height]), [
    [21, 9, 86, 26], [21, 27, 46, 26], [21, 9, 86, 26], [21, 27, 46, 26],
  ]);
  assert.equal(shapes[3].attributes['data-evidence-highlight'], 'failed');
  assert.equal(shapes[2].attributes['data-evidence-highlight'], undefined);
});

test('explains the marking in plain language, for laypeople, without promising a frame over the content', () => {
  const highlight = evidenceHighlight(elementEvidence({
    width: 128, height: 88, highlightBox: { x: 24, y: 12, width: 80, height: 40 },
  }));
  assert.equal(evidenceHighlightLegend(EVIDENCE_TREATMENTS_V1.failed, highlight),
    `Contorno vermelho: elemento com falha. ${EVIDENCE_HIGHLIGHT_CONTEXT_LEGEND}`);
  assert.equal(evidenceHighlightLegend(EVIDENCE_TREATMENTS_V1.review, { ...highlight, clipped: true }),
    `Contorno âmbar tracejado: elemento que precisa de revisão humana. ${EVIDENCE_HIGHLIGHT_CONTEXT_LEGEND} ${EVIDENCE_HIGHLIGHT_CLIPPED_LEGEND}`);
  assert.match(EVIDENCE_HIGHLIGHT_UNMARKED_LEGEND, /^Captura sem marcação: /u);
  for (const treatment of Object.values(EVIDENCE_TREATMENTS_V1)) {
    assert.match(treatment.legend, /^Contorno /u);
    assert.doesNotMatch(treatment.legend, /moldura/iu);
  }
});
