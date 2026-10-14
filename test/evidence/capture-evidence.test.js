import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { captureElement, captureFullPage, elementCaptureScale, elementContextMargin } from '../../src/browser/capture-evidence.js';

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';

function fakeCdp(data = PNG_1PX) {
  const calls = [];
  return {
    calls,
    command: async (method, params) => {
      calls.push([method, params]);
      return { data };
    }
  };
}

test('timestamps each PNG receipt after the command resolves, not before waiting or from the previous raster', async t => {
  let clock = Date.parse('2026-09-06T12:00:00.000Z');
  t.mock.method(Date, 'now', () => clock);
  const cdp = { async command() {
    clock += 2000;
    return { data: PNG_1PX };
  } };
  const full = await captureFullPage(cdp);
  const element = await captureElement(cdp, { x: 0, y: 0, width: 10, height: 10 });
  assert.equal(full.metadata.captureReceivedAt, '2026-09-06T12:00:02.000Z');
  assert.equal(element.metadata.captureReceivedAt, '2026-09-06T12:00:04.000Z');
  const absent = await captureElement(cdp, { x: 0, y: 0, width: 0, height: 10 });
  assert.equal(absent.metadata, undefined);
  assert.equal(clock, Date.parse('2026-09-06T12:00:04.000Z'));
});

test('captures and validates one deterministic full-page PNG evidence record', async () => {
  const cdp = fakeCdp();
  const first = await captureFullPage(cdp, { cssContentSize: { width: 800, height: 1200 } });
  const second = await captureFullPage(fakeCdp(), { cssContentSize: { width: 800, height: 1200 } });
  assert.deepEqual(cdp.calls, [['Page.captureScreenshot', {
    format: 'png', captureBeyondViewport: true, fromSurface: true,
    clip: { x: 0, y: 0, width: 800, height: 1200, scale: 1 }
  }]]);
  assert.equal(first.status, 'captured');
  assert.equal(first.dataUrl, `data:image/png;base64,${PNG_1PX}`);
  assert.equal(first.hash, createHash('sha256').update(Buffer.from(PNG_1PX, 'base64')).digest('hex'));
  assert.match(first.hash, /^[a-f0-9]{64}$/u);
  assert.equal(first.evidenceId, second.evidenceId);
  assert.equal(new Date(first.metadata.captureReceivedAt).toISOString(), first.metadata.captureReceivedAt);
  const { captureReceivedAt, ...geometry } = first.metadata;
  assert.deepEqual(geometry, { kind: 'full-page', mimeType: 'image/png', width: 800, height: 1200 });
});

test('hashes the decoded PNG bytes instead of a short stable identifier', async () => {
  const firstBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
  const secondBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 2]);
  const first = await captureFullPage(fakeCdp(firstBytes.toString('base64')), {});
  const second = await captureFullPage(fakeCdp(secondBytes.toString('base64')), {});
  assert.equal(first.hash, createHash('sha256').update(firstBytes).digest('hex'));
  assert.equal(second.hash, createHash('sha256').update(secondBytes).digest('hex'));
  assert.notEqual(first.hash, second.hash);
});

test('converts an explicitly viewport-relative rect to document coordinates before clipping', async () => {
  const cdp = fakeCdp();
  await captureElement(cdp, { x: 20, y: 500, width: 60, height: 40, coordinateSpace: 'viewport' }, {
    cssContentSize: { width: 1000, height: 2000 }, scrollX: 0, scrollY: 1000
  });
  assert.deepEqual(cdp.calls[0][1].clip, { x: 0, y: 1460, width: 120, height: 120, scale: 2 });
});

test('captures clamped element thumbnails and references the full-page evidence id', async () => {
  const cdp = fakeCdp();
  const capture = await captureElement(cdp, { x: -10, y: 10, width: 50, height: 30 }, {
    cssContentSize: { width: 100, height: 100 }, fullPageEvidenceId: 'full-page-abc'
  });
  assert.deepEqual(cdp.calls, [['Page.captureScreenshot', {
    format: 'png', captureBeyondViewport: true, fromSurface: true,
    clip: { x: 0, y: 0, width: 80, height: 80, scale: 2 }
  }]]);
  assert.equal(capture.metadata.kind, 'thumbnail');
  assert.deepEqual(capture.metadata.highlightBox, {
    x: 0, y: 10, width: 40, height: 30,
    coordinateSpace: 'capture-css-px',
  });
  assert.equal(capture.metadata.annotationMargin, elementContextMargin(30, 30));
  assert.equal(capture.fullPageEvidenceId, 'full-page-abc');
});

test('grows the context margin with the target and keeps it bounded', () => {
  // 24 px fixos dominavam um botão de ícone e desapareciam ao redor de um bloco grande.
  assert.equal(elementContextMargin(16, 16), 40);
  assert.equal(elementContextMargin(60, 40), 40);
  assert.equal(elementContextMargin(200, 120), 70);
  assert.equal(elementContextMargin(400, 80), 140);
  assert.equal(elementContextMargin(600, 300), 160);
  assert.equal(elementContextMargin(Number.NaN, Number.NaN), 40);
});

test('captures the thumbnail at 2x and declares the scale beside the CSS frame', async () => {
  const cdp = fakeCdp();
  const capture = await captureElement(cdp, { x: 200, y: 300, width: 30, height: 30 }, {
    cssContentSize: { width: 800, height: 1000 },
  });
  // 30 px de alvo + 40 px de margem de cada lado: o quadro continua em CSS px — é o `viewBox` da
  // marcação — e a escala fica declarada ao lado, não embutida nas coordenadas.
  assert.equal(capture.metadata.width, 110);
  assert.equal(capture.metadata.height, 110);
  assert.equal(capture.metadata.clip.width, 110);
  assert.equal(capture.metadata.pixelScale, 2);
  assert.equal(capture.metadata.clip.scale, capture.metadata.pixelScale, 'o clip enviado ao Chrome declara a mesma escala');
  assert.deepEqual(cdp.calls[0][1].clip, { x: 160, y: 260, width: 110, height: 110, scale: 2 });
});

test('scales the thumbnail to the device, capped, and falls back to 1x on a big crop', () => {
  // Botão de ícone: 2× é o mínimo pedido, mesmo em tela comum.
  assert.equal(elementCaptureScale(110, 110, 1), 2);
  assert.equal(elementCaptureScale(110, 110, 1.5), 2);
  assert.equal(elementCaptureScale(110, 110, 2), 2);
  // Tela de dispositivo maior manda, com teto de 3×.
  assert.equal(elementCaptureScale(110, 110, 3), 3);
  assert.equal(elementCaptureScale(110, 110, 4), 3);
  assert.equal(elementCaptureScale(110, 110, Number.NaN), 2);
  // Teto de 4 Mpx de imagem: 1000×1000 ainda cabe em 2×, um pixel a mais não.
  assert.equal(elementCaptureScale(1000, 1000, 2), 2);
  assert.equal(elementCaptureScale(1001, 1000, 2), 1);
  assert.equal(elementCaptureScale(666, 666, 3), 3);
  assert.equal(elementCaptureScale(667, 667, 3), 2);
  // Um bloco grande com 160 px de margem estoura o teto: volta a 1×, como antes desta versão.
  assert.equal(elementCaptureScale(1600, 1200, 2), 1);
  assert.equal(elementCaptureScale(0, 0, 2), 2);
});

test('leaves the full-page capture at scale 1', async () => {
  const cdp = fakeCdp();
  const capture = await captureFullPage(cdp, { cssContentSize: { width: 800, height: 1200 }, contentSize: { width: 1600, height: 2400 } });
  assert.deepEqual(cdp.calls[0][1].clip, { x: 0, y: 0, width: 800, height: 1200, scale: 1 });
  assert.equal(capture.metadata.pixelScale, undefined);
});

test('visible capture requires the entire context crop inside both CSS viewports', async () => {
  const viewport = { pageX: 100, pageY: 200, clientWidth: 400, clientHeight: 300 };
  const metrics = { cssContentSize: { width: 1000, height: 2000 }, cssLayoutViewport: viewport,
    cssVisualViewport: { ...viewport, scale: 1 }, fullPageEvidenceId: 'full-original' };
  for (const [rect, overrides, expected] of [
    // Alvo e contexto inteiramente dentro das duas viewports: captura sem sair do que está visível.
    [{ x: 200, y: 260, width: 60, height: 40 }, {}, false],
    [{ x: 160, y: 220, width: 300, height: 240 }, {}, true],
    [{ x: 110, y: 224, width: 20, height: 20 }, {}, true],
    [{ x: 200, y: 260, width: 60, height: 40 }, { cssVisualViewport: null }, true],
    [{ x: 150, y: 260, width: 60, height: 40 }, { cssLayoutViewport: { ...viewport, pageX: 125 } }, true],
  ]) {
    const cdp = fakeCdp();
    const result = await captureElement(cdp, rect, { ...metrics, ...overrides });
    assert.equal(cdp.calls[0][1].captureBeyondViewport, expected);
    assert.equal(result.fullPageEvidenceId, 'full-original');
    assert.equal(result.metadata.highlightBox.x, elementContextMargin(rect.width, rect.height));
    assert.equal(result.metadata.highlightBox.width, rect.width);
  }
  for (const override of [{ scale: 2 }, { scale: undefined }, { clientWidth: 0 }, { clientHeight: Infinity }, { pageX: NaN }]) {
    const cdp = fakeCdp();
    await captureElement(cdp, { x: 150, y: 250, width: 30, height: 30 }, {
      ...metrics, cssVisualViewport: { ...metrics.cssVisualViewport, ...override },
    });
    assert.equal(cdp.calls[0][1].captureBeyondViewport, true);
  }
});

test('adds evidence context around an element and records its exact box inside the crop', async () => {
  const cdp = fakeCdp();
  const capture = await captureElement(cdp, { x: 200, y: 300, width: 80, height: 40 }, {
    cssContentSize: { width: 800, height: 1000 }, fullPageEvidenceId: 'full-page-context'
  });

  assert.deepEqual(cdp.calls[0][1].clip, { x: 160, y: 260, width: 160, height: 120, scale: 2 });
  assert.deepEqual(capture.metadata.highlightBox, {
    x: 40, y: 40, width: 80, height: 40,
    coordinateSpace: 'capture-css-px',
  });
  assert.deepEqual(capture.metadata.highlightParts, [{ x: 40, y: 40, width: 80, height: 40 }]);
  assert.equal(capture.metadata.highlightClipped, undefined);
});

test('prefers the fresh multi-line measurement over the snapshot rect', async () => {
  const cdp = fakeCdp();
  // Três fragmentos de linha de um link inline, já em coordenadas do documento.
  const measuredRects = [
    { x: 100, y: 200, width: 60, height: 20 },
    { x: 60, y: 220, width: 80, height: 20 },
    { x: 60, y: 240, width: 40, height: 20 },
  ];
  const capture = await captureElement(cdp, { x: 0, y: 200, width: 300, height: 60 }, {
    cssContentSize: { width: 400, height: 400 }, measuredRects,
  });

  // O clip cobre a união das partes com a margem do alvo; o snapshot não é somado nem usado.
  assert.deepEqual(cdp.calls[0][1].clip, { x: 20, y: 160, width: 180, height: 140, scale: 2 });
  assert.deepEqual(capture.metadata.highlightParts, [
    { x: 80, y: 40, width: 60, height: 20 },
    { x: 40, y: 60, width: 80, height: 20 },
    { x: 40, y: 80, width: 40, height: 20 },
  ]);
  assert.deepEqual(capture.metadata.highlightBox, {
    x: 40, y: 40, width: 100, height: 60, coordinateSpace: 'capture-css-px',
  });
});

test('keeps measured parts in document coordinates even when the snapshot rect is viewport-relative', async () => {
  const cdp = fakeCdp();
  const measuredRects = [{ x: 0, y: 1200, width: 200, height: 20 }];
  await captureElement(cdp, { x: 0, y: 200, width: 200, height: 20, coordinateSpace: 'viewport' }, {
    cssContentSize: { width: 400, height: 2000 }, scrollX: 0, scrollY: 1000, measuredRects,
  });
  // A rolagem já foi aplicada na medição: somá-la de novo colocaria a caixa 1000 px abaixo do alvo.
  assert.equal(cdp.calls[0][1].clip.y + cdp.calls[0][1].clip.height, 1290);
});

test('caps drawn parts at eight fragments while the clip still covers every measured line', async () => {
  const cdp = fakeCdp();
  const measuredRects = Array.from({ length: 10 }, (_, index) => ({ x: 0, y: 100 + index * 20, width: 100, height: 20 }));
  const capture = await captureElement(cdp, { x: 0, y: 100, width: 100, height: 200 }, {
    cssContentSize: { width: 400, height: 400 }, measuredRects,
  });
  assert.equal(capture.metadata.highlightParts.length, 8);
  // 200 px de união + 70 px de margem de cada lado: o recorte não pode encolher por causa do teto de
  // partes desenhadas, senão o elemento apareceria cortado na imagem.
  assert.equal(cdp.calls[0][1].clip.height, 340);
  assert.equal(capture.metadata.highlightBox.height, 200);
});

test('marks a capture clipped when the element continues beyond the page bounds', async () => {
  const inside = await captureElement(fakeCdp(), { x: 10, y: 10, width: 40, height: 20 }, {
    cssContentSize: { width: 800, height: 1000 },
  });
  assert.equal(inside.metadata.highlightClipped, undefined);

  const cdp = fakeCdp();
  const clipped = await captureElement(cdp, { x: 700, y: 900, width: 120, height: 120 }, {
    cssContentSize: { width: 800, height: 1000 },
  });
  assert.equal(clipped.metadata.highlightClipped, true);
  assert.deepEqual(cdp.calls[0][1].clip, { x: 658, y: 858, width: 142, height: 142, scale: 2 });
});

test('falls back to the snapshot rect when the fresh measurement is unusable', async () => {
  for (const measuredRects of [undefined, null, [], [{ x: 0, y: 0, width: 0, height: 10 }], [{ x: Number.NaN, y: 0, width: 10, height: 10 }]]) {
    const cdp = fakeCdp();
    const capture = await captureElement(cdp, { x: 200, y: 300, width: 80, height: 40 }, {
      cssContentSize: { width: 800, height: 1000 }, measuredRects,
    });
    assert.equal(capture.status, 'captured');
    assert.deepEqual(cdp.calls[0][1].clip, { x: 160, y: 260, width: 160, height: 120, scale: 2 });
  }
});

test('refuses to capture a node inside an iframe with top-document coordinates', async () => {
  const cdp = fakeCdp();
  const result = await captureElement(cdp, { x: 10, y: 10, width: 80, height: 40 }, {
    cssContentSize: { width: 800, height: 1000 }, framePath: ['frame-host'], fullPageEvidenceId: 'full-original',
  });
  assert.equal(result.status, 'cantTell');
  assert.equal(result.reason, 'frame-context');
  assert.equal(result.evidenceId, null);
  assert.equal(result.fullPageEvidenceId, 'full-original');
  assert.equal(cdp.calls.length, 0);
});

test('returns explicit cantTell for empty, NaN and off-page rectangles without capturing', async () => {
  for (const rect of [
    { x: 0, y: 0, width: 0, height: 10 },
    { x: Number.NaN, y: 0, width: 10, height: 10 },
    { x: 200, y: 200, width: 10, height: 10 }
  ]) {
    const cdp = fakeCdp();
    const result = await captureElement(cdp, rect, { cssContentSize: { width: 100, height: 100 } });
    assert.equal(result.status, 'cantTell');
    assert.match(result.reason, /rect/i);
    assert.equal(cdp.calls.length, 0);
  }
});

test('rejects malformed or non-PNG screenshot payloads', async () => {
  await assert.rejects(captureFullPage(fakeCdp('not-base64***'), {}), /PNG|base64/i);
  await assert.rejects(captureFullPage(fakeCdp('SGVsbG8='), {}), /PNG/i);
});

test('caps the pristine capture of a very tall page at a renderer-safe height (1.1.53)', async () => {
  const cdp = fakeCdp();
  const capture = await captureFullPage(cdp, {
    cssContentSize: { width: 900, height: 157_000 }, contentSize: { width: 1800, height: 314_000 },
  });
  assert.deepEqual(cdp.calls[0][1].clip, { x: 0, y: 0, width: 900, height: 8192, scale: 1 });
  assert.equal(capture.metadata.height, 8192, 'the captured height is what the metadata declares');
  const normal = fakeCdp();
  await captureFullPage(normal, { cssContentSize: { width: 800, height: 1200 } });
  assert.equal(normal.calls[0][1].clip.height, 1200, 'ordinary pages are unchanged');
});
