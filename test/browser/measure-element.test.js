import assert from 'node:assert/strict';
import test from 'node:test';

import {
  measureElementTarget,
  quadToRect,
  rectExceedsBounds,
  unionOfRects,
  viewportOrigin,
} from '../../src/browser/measure-element.js';

const LAYOUT_METRICS = { cssVisualViewport: { pageX: 0, pageY: 800, clientWidth: 800, clientHeight: 600, scale: 1 } };

function fakeCdp({ metrics = LAYOUT_METRICS, quads = [], boxModel = null, throws = {} } = {}) {
  const calls = [];
  return {
    calls,
    async command(method, params) {
      calls.push([method, params]);
      if (throws[method]) throw new Error(`${method} falhou`);
      if (method === 'Page.getLayoutMetrics') return metrics;
      if (method === 'DOM.getContentQuads') return { quads };
      if (method === 'DOM.getBoxModel') return { model: { border: boxModel } };
      throw new Error(`comando inesperado: ${method}`);
    },
  };
}

test('turns a CDP quad into the axis-aligned rectangle that contains it', () => {
  assert.deepEqual(quadToRect([10, 20, 30, 20, 30, 40, 10, 40]), { x: 10, y: 20, width: 20, height: 20 });
  // Um elemento rotacionado devolve um quadrilátero, não um retângulo: o desenho usa a caixa que o contém.
  assert.deepEqual(quadToRect([10, 20, 30, 25, 25, 40, 5, 35]), { x: 5, y: 20, width: 25, height: 20 });
  for (const quad of [null, [], [1, 2, 3], [0, 0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 'x', 0, 0, 0, 0], [Number.NaN, 0, 0, 0, 0, 0, 0, 0]]) {
    assert.equal(quadToRect(quad), null);
  }
});

test('unions the measured fragments and keeps the reading order', () => {
  assert.deepEqual(unionOfRects([{ x: 10, y: 20, width: 20, height: 10 }, { x: 40, y: 50, width: 10, height: 10 }]),
    { x: 10, y: 20, width: 40, height: 40 });
  assert.equal(unionOfRects([]), null);
  assert.equal(unionOfRects(null), null);
});

test('reads the viewport origin from the layout metrics measured at the same instant', () => {
  assert.deepEqual(viewportOrigin(LAYOUT_METRICS), { x: 0, y: 800 });
  for (const metrics of [null, {}, { cssVisualViewport: {} }, { cssVisualViewport: { pageX: 0, pageY: Number.NaN } }]) {
    assert.equal(viewportOrigin(metrics), null);
  }
});

test('declares the target clipped only when it exceeds the captured page edges', () => {
  const bounds = { width: 800, height: 1000 };
  assert.equal(rectExceedsBounds({ x: 10, y: 10, width: 40, height: 20 }, bounds), false);
  assert.equal(rectExceedsBounds({ x: -1, y: 10, width: 40, height: 20 }, bounds), true);
  assert.equal(rectExceedsBounds({ x: 10, y: -1, width: 40, height: 20 }, bounds), true);
  assert.equal(rectExceedsBounds({ x: 780, y: 10, width: 40, height: 20 }, bounds), true);
  assert.equal(rectExceedsBounds({ x: 10, y: 990, width: 40, height: 20 }, bounds), true);
  // Diferença de subpixel entre a medição e o recorte não é "continua além da captura".
  assert.equal(rectExceedsBounds({ x: 10, y: 10, width: 790.4, height: 20 }, bounds), false);
  assert.equal(rectExceedsBounds(null, bounds), false);
});

test('re-measures the node at capture time and converts viewport coordinates into document coordinates', async () => {
  const cdp = fakeCdp({ quads: [[100, 400, 160, 400, 160, 420, 100, 420]] });
  const measured = await measureElementTarget(cdp, { backendNodeId: 41 });
  assert.equal(measured.status, 'measured');
  assert.equal(measured.source, 'content-quads');
  assert.deepEqual(measured.rects, [{ x: 100, y: 1200, width: 60, height: 20 }]);
  assert.deepEqual(measured.box, { x: 100, y: 1200, width: 60, height: 20 });
  assert.deepEqual(cdp.calls.map(call => call[0]), ['Page.getLayoutMetrics', 'DOM.getContentQuads']);
  assert.deepEqual(cdp.calls[1][1], { backendNodeId: 41 });
});

test('keeps one rectangle per line fragment of an inline instead of a single enclosing box', async () => {
  const cdp = fakeCdp({
    quads: [
      [60, 440, 100, 440, 100, 460, 60, 460],
      [100, 400, 160, 400, 160, 420, 100, 420],
      [60, 420, 140, 420, 140, 440, 60, 440],
    ],
  });
  const measured = await measureElementTarget(cdp, { backendNodeId: 7 });
  assert.deepEqual(measured.rects, [
    { x: 100, y: 1200, width: 60, height: 20 },
    { x: 60, y: 1220, width: 80, height: 20 },
    { x: 60, y: 1240, width: 40, height: 20 },
  ]);
  assert.deepEqual(measured.box, { x: 60, y: 1200, width: 100, height: 60 });
});

test('falls back to the border box when the element has no content quads', async () => {
  for (const quads of [[], [[0, 0, 0, 0, 0, 0, 0, 0]]]) {
    const cdp = fakeCdp({ quads, boxModel: [100, 400, 160, 400, 160, 420, 100, 420] });
    const measured = await measureElementTarget(cdp, { backendNodeId: 41 });
    assert.equal(measured.status, 'measured');
    assert.equal(measured.source, 'box-model');
    assert.deepEqual(measured.rects, [{ x: 100, y: 1200, width: 60, height: 20 }]);
  }
  const thrown = fakeCdp({ boxModel: [0, 400, 60, 400, 60, 420, 0, 420], throws: { 'DOM.getContentQuads': true } });
  const measured = await measureElementTarget(thrown, { backendNodeId: 41 });
  assert.equal(measured.source, 'box-model');
  assert.deepEqual(measured.rects, [{ x: 0, y: 1200, width: 60, height: 20 }]);
});

test('refuses to measure a node inside an iframe with top-document coordinates', async () => {
  const cdp = fakeCdp({ quads: [[0, 0, 10, 0, 10, 10, 0, 10]] });
  const measured = await measureElementTarget(cdp, { backendNodeId: 41, framePath: ['iframe-anuncio'] });
  assert.deepEqual(measured, { status: 'frame-context', reason: 'frame-context' });
  assert.deepEqual(cdp.calls, []);
});

test('reports an explicit unavailable status without throwing when the page cannot answer', async () => {
  const noNode = fakeCdp();
  assert.deepEqual(await measureElementTarget(noNode, { backendNodeId: undefined }),
    { status: 'unavailable', reason: 'missing-backend-node' });
  assert.deepEqual(await measureElementTarget(noNode, { backendNodeId: 41.5 }),
    { status: 'unavailable', reason: 'missing-backend-node' });
  assert.deepEqual(noNode.calls, []);

  const noMetrics = fakeCdp({ throws: { 'Page.getLayoutMetrics': true } });
  assert.equal((await measureElementTarget(noMetrics, { backendNodeId: 41 })).reason, 'layout-metrics-unavailable');

  const noOrigin = fakeCdp({ metrics: { cssVisualViewport: { clientWidth: 800, clientHeight: 600 } } });
  assert.equal((await measureElementTarget(noOrigin, { backendNodeId: 41 })).reason, 'viewport-origin-unavailable');

  const nothingMeasurable = fakeCdp({ throws: { 'DOM.getContentQuads': true, 'DOM.getBoxModel': true } });
  assert.equal((await measureElementTarget(nothingMeasurable, { backendNodeId: 41 })).reason, 'element-not-measurable');
});
