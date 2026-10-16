import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SOURCE_LAYOUT_HEIGHT_TOLERANCE_PX,
  SOURCE_LAYOUT_WIDTH_TOLERANCE_PX,
  contentSizeOf,
  mapSourceGeometry,
} from '../../src/core/evidence/map-source-geometry.js';
import { layoutAgreement } from '../../src/core/evidence/fresh-geometry.js';

const metrics = (width, height) => ({ cssContentSize: { width, height } });
const image = (width, height) => ({ width, height });

/**
 * Desde a 1.1.62 a decisão é "há geometria fresca e o leiaute ficou parado em volta dela?" — a altura da
 * leitura estrutural não entra mais na conta. Ela só servia para recusar o mapa inteiro por causa de uma
 * diferença que a medição fresca torna irrelevante.
 */
test('desenha quando há geometria fresca e o leiaute parou em volta da captura e da medição', () => {
  const source = mapSourceGeometry({
    captureMetrics: metrics(1280, 3121),
    captureMetricsAfter: metrics(1280, 3121),
    measurementMetrics: metrics(1280, 3121),
    imageSize: image(1280, 3121),
    freshRectCount: 42,
    deviceScaleFactor: 2,
  });

  assert.equal(source.aligned, true);
  assert.equal(source.reason, 'aligned');
  assert.equal(source.truncated, false);
  assert.equal(source.freshRectCount, 42);
  assert.deepEqual(source.layoutMetrics.cssContentSize, { width: 1280, height: 3121 });
  assert.equal(source.layoutMetrics.deviceScaleFactor, 2);
});

test('a altura da leitura estrutural não decide mais nada: quem manda é a imagem e a medição fresca', () => {
  // Caso real que motivou a mudança: a leitura estrutural viu 3.121 px e a captura saiu com 757 px porque a
  // página se montou durante a leitura. A medição fresca devolve os retângulos do estado da imagem, então o
  // mapa desenha — com o tamanho da imagem.
  const source = mapSourceGeometry({
    captureMetrics: metrics(1280, 757),
    captureMetricsAfter: metrics(1280, 757),
    measurementMetrics: metrics(1280, 757),
    imageSize: image(1280, 757),
    freshRectCount: 12,
  });

  assert.equal(source.aligned, true);
  assert.equal(source.reason, 'aligned');
  assert.deepEqual(source.layoutMetrics.cssContentSize, { width: 1280, height: 757 });
});

test('recusa quando a própria captura mexeu no leiaute', () => {
  const source = mapSourceGeometry({
    captureMetrics: metrics(1280, 2000),
    captureMetricsAfter: metrics(1265, 2000),
    measurementMetrics: metrics(1265, 2000),
    imageSize: image(1265, 2000),
    freshRectCount: 10,
  });

  assert.equal(source.aligned, false);
  assert.equal(source.reason, 'capture-moved-layout');
  assert.equal(source.widthDrift, 15);
  assert.equal(source.heightDrift, 0);
});

test('recusa quando a página cresceu enquanto os retângulos eram medidos', () => {
  const source = mapSourceGeometry({
    captureMetrics: metrics(1280, 2000),
    captureMetricsAfter: metrics(1280, 2000),
    measurementMetrics: metrics(1280, 2600),
    imageSize: image(1280, 2000),
    freshRectCount: 10,
  });

  assert.equal(source.aligned, false);
  assert.equal(source.reason, 'measurement-moved-layout');
  assert.equal(source.heightDrift, 600);
});

test('sem retângulos frescos não há caixa, mesmo com o leiaute parado', () => {
  const source = mapSourceGeometry({
    captureMetrics: metrics(1280, 2000),
    captureMetricsAfter: metrics(1280, 2000),
    measurementMetrics: metrics(1280, 2000),
    imageSize: image(1280, 2000),
    freshRectCount: 0,
  });

  assert.equal(source.aligned, false);
  assert.equal(source.reason, 'fresh-geometry-unavailable');
  assert.equal(source.freshRectCount, 0);
});

test('sem os tamanhos não há como provar que o leiaute parou', () => {
  for (const [input, reason] of [
    [{ captureMetrics: {}, captureMetricsAfter: metrics(800, 600), measurementMetrics: metrics(800, 600), freshRectCount: 5 }, 'capture-size-unavailable'],
    [{ captureMetrics: metrics(800, 600), captureMetricsAfter: null, measurementMetrics: metrics(800, 600), freshRectCount: 5 }, 'capture-size-unavailable'],
    [{ captureMetrics: metrics(800, 600), captureMetricsAfter: metrics(800, 600), measurementMetrics: {}, freshRectCount: 5 }, 'measurement-size-unavailable'],
    [{ captureMetrics: metrics(800, 600), captureMetricsAfter: metrics(800, 600), measurementMetrics: null, freshRectCount: 5 }, 'measurement-size-unavailable'],
  ]) {
    const source = mapSourceGeometry(input);
    assert.equal(source.aligned, false, JSON.stringify(input));
    assert.equal(source.reason, reason);
  }
  assert.equal(layoutAgreement(null, metrics(10, 10)).reason, 'size-unavailable');
  assert.equal(contentSizeOf({ cssContentSize: { width: 0, height: 10 } }), null);
  assert.equal(contentSizeOf({ contentSize: { width: '800', height: 600 } }), null);
  assert.deepEqual(contentSizeOf({ contentSize: { width: 800, height: 600 } }), { width: 800, height: 600 });
});

test('tolerâncias pequenas separam o que passa como igual do que passa como diferente', () => {
  const inside = mapSourceGeometry({
    captureMetrics: metrics(1280, 3121),
    captureMetricsAfter: metrics(1280 + SOURCE_LAYOUT_WIDTH_TOLERANCE_PX, 3121 - SOURCE_LAYOUT_HEIGHT_TOLERANCE_PX),
    measurementMetrics: metrics(1280, 3121),
    imageSize: image(1280, 3121),
    freshRectCount: 7,
  });
  assert.equal(inside.aligned, true);

  const outside = mapSourceGeometry({
    captureMetrics: metrics(1280, 3121),
    captureMetricsAfter: metrics(1280, 3121),
    measurementMetrics: metrics(1280, 3121 + SOURCE_LAYOUT_HEIGHT_TOLERANCE_PX + 1),
    imageSize: image(1280, 3121),
    freshRectCount: 7,
  });
  assert.equal(outside.aligned, false);
  assert.equal(outside.reason, 'measurement-moved-layout');
  assert.equal(outside.heightDrift, SOURCE_LAYOUT_HEIGHT_TOLERANCE_PX + 1);
});

test('captura truncada pelo teto de segurança usa a altura da imagem e declara a truncagem', () => {
  const source = mapSourceGeometry({
    captureMetrics: metrics(800, 157_000),
    captureMetricsAfter: metrics(800, 157_000),
    measurementMetrics: metrics(800, 157_000),
    imageSize: image(800, 16_384),
    freshRectCount: 30,
    capturedHeight: 16_384,
  });

  assert.equal(source.aligned, true);
  assert.equal(source.truncated, true);
  assert.deepEqual(source.layoutMetrics.cssContentSize, { width: 800, height: 16_384 });
  assert.equal(source.layoutMetrics.contentSize, undefined);
});

test('sem o tamanho declarado pela imagem cai para o do documento, e só aí a truncagem encurta', () => {
  const source = mapSourceGeometry({
    captureMetrics: metrics(800, 157_000),
    captureMetricsAfter: metrics(800, 157_000),
    measurementMetrics: metrics(800, 157_000),
    freshRectCount: 30,
    capturedHeight: 16_384,
  });

  assert.equal(source.truncated, true);
  assert.deepEqual(source.layoutMetrics.cssContentSize, { width: 800, height: 16_384 });
});
