import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SOURCE_LAYOUT_HEIGHT_TOLERANCE_PX,
  SOURCE_LAYOUT_WIDTH_TOLERANCE_PX,
  contentSizeOf,
  mapSourceGeometry,
  sourceLayoutAgreement,
} from '../../src/core/evidence/map-source-geometry.js';

const metrics = (width, height) => ({ cssContentSize: { width, height } });

test('confirma o mesmo leiaute quando a captura e a leitura concordam no tamanho', () => {
  const agreement = sourceLayoutAgreement(metrics(1280, 3121), metrics(1280, 3121));

  assert.deepEqual(agreement, { aligned: true, widthDrift: 0, heightDrift: 0, reason: 'measured' });
  const source = mapSourceGeometry({
    captureMetrics: metrics(1280, 3121), captureMetricsAfter: metrics(1280, 3121),
    observedMetrics: metrics(1280, 3121), capturedHeight: null, deviceScaleFactor: 2,
  });
  assert.equal(source.aligned, true);
  assert.equal(source.reason, 'aligned');
  assert.equal(source.truncated, false);
  assert.deepEqual(source.layoutMetrics.cssContentSize, { width: 1280, height: 3121 });
  assert.equal(source.layoutMetrics.deviceScaleFactor, 2);
});

test('recusa o alinhamento quando a página mudou de altura entre a leitura e a captura', () => {
  // Caso real: a captura saiu com 757 px de altura e a leitura viu 3.121 px. Converter os retângulos por
  // essa imagem punha a caixa de todo item no lugar errado.
  const source = mapSourceGeometry({
    captureMetrics: metrics(1280, 757), captureMetricsAfter: metrics(1280, 757),
    observedMetrics: metrics(1280, 3121),
  });

  assert.equal(source.aligned, false);
  assert.equal(source.reason, 'measured');
  assert.equal(source.heightDrift, 2364);
  assert.equal(source.widthDrift, 0);
});

test('recusa o alinhamento quando a própria captura mexeu no leiaute', () => {
  const source = mapSourceGeometry({
    captureMetrics: metrics(1280, 2000), captureMetricsAfter: metrics(1265, 2000),
    observedMetrics: metrics(1280, 2000),
  });

  assert.equal(source.aligned, false);
  assert.equal(source.reason, 'capture-moved-layout');
  assert.equal(source.widthDrift, 0, 'a leitura e a captura concordam; quem se mexeu foi a área de captura');
});

test('sem os dois tamanhos não há como provar alinhamento', () => {
  for (const [input, reason] of [
    [{ captureMetrics: {}, captureMetricsAfter: metrics(800, 600), observedMetrics: metrics(800, 600) }, 'size-unavailable'],
    [{ captureMetrics: metrics(800, 600), captureMetricsAfter: metrics(800, 600), observedMetrics: {} }, 'size-unavailable'],
    [{ captureMetrics: metrics(800, 600), captureMetricsAfter: null, observedMetrics: metrics(800, 600) }, 'capture-size-unavailable'],
  ]) {
    const source = mapSourceGeometry(input);
    assert.equal(source.aligned, false, JSON.stringify(input));
    assert.equal(source.reason, reason);
  }
  assert.equal(sourceLayoutAgreement(null, metrics(10, 10)).reason, 'size-unavailable');
  assert.equal(contentSizeOf({ cssContentSize: { width: 0, height: 10 } }), null);
  assert.equal(contentSizeOf({ contentSize: { width: '800', height: 600 } }), null);
  assert.deepEqual(contentSizeOf({ contentSize: { width: 800, height: 600 } }), { width: 800, height: 600 });
});

test('tolerâncias pequenas separam o que passa como igual do que passa como diferente', () => {
  const inside = mapSourceGeometry({
    captureMetrics: metrics(1280, 3121),
    captureMetricsAfter: metrics(1280, 3121 - SOURCE_LAYOUT_HEIGHT_TOLERANCE_PX),
    observedMetrics: metrics(1280 + SOURCE_LAYOUT_WIDTH_TOLERANCE_PX, 3121 - SOURCE_LAYOUT_HEIGHT_TOLERANCE_PX),
  });
  assert.equal(inside.aligned, true);

  const outside = mapSourceGeometry({
    captureMetrics: metrics(1280, 3121), captureMetricsAfter: metrics(1280, 3121),
    observedMetrics: metrics(1280, 3121 + SOURCE_LAYOUT_HEIGHT_TOLERANCE_PX + 1),
  });
  assert.equal(outside.aligned, false);
  assert.equal(outside.heightDrift, SOURCE_LAYOUT_HEIGHT_TOLERANCE_PX + 1);
});

test('captura truncada pelo teto de segurança usa a altura da imagem e declara a truncagem', () => {
  const source = mapSourceGeometry({
    captureMetrics: metrics(800, 157_000), captureMetricsAfter: metrics(800, 157_000),
    observedMetrics: metrics(800, 157_000), capturedHeight: 16_384,
  });

  assert.equal(source.aligned, true);
  assert.equal(source.truncated, true);
  assert.deepEqual(source.layoutMetrics.cssContentSize, { width: 800, height: 16_384 });
  assert.equal(source.layoutMetrics.contentSize, undefined);
});
