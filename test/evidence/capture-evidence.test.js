import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { captureElement, captureFullPage } from '../../src/browser/capture-evidence.js';

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
  assert.equal(cdp.calls[0][1].clip.y, 1476);
  assert.equal(cdp.calls[0][1].clip.x, 0);
});

test('captures clamped element thumbnails and references the full-page evidence id', async () => {
  const cdp = fakeCdp();
  const capture = await captureElement(cdp, { x: -10, y: 10, width: 50, height: 30 }, {
    cssContentSize: { width: 100, height: 100 }, fullPageEvidenceId: 'full-page-abc'
  });
  assert.deepEqual(cdp.calls, [['Page.captureScreenshot', {
    format: 'png', captureBeyondViewport: true, fromSurface: true,
    clip: { x: 0, y: 0, width: 64, height: 64, scale: 1 }
  }]]);
  assert.equal(capture.metadata.kind, 'thumbnail');
  assert.deepEqual(capture.metadata.highlightBox, {
    x: 0, y: 10, width: 40, height: 30,
    coordinateSpace: 'capture-css-px',
  });
  assert.equal(capture.metadata.annotationMargin, 24);
  assert.equal(capture.fullPageEvidenceId, 'full-page-abc');
});

test('visible capture requires the entire context crop inside both CSS viewports', async () => {
  const viewport = { pageX: 100, pageY: 200, clientWidth: 400, clientHeight: 300 };
  const metrics = { cssContentSize: { width: 1000, height: 2000 }, cssLayoutViewport: viewport,
    cssVisualViewport: { ...viewport, scale: 1 }, fullPageEvidenceId: 'full-original' };
  for (const [rect, overrides, expected] of [
    [{ x: 124, y: 224, width: 352, height: 252 }, {}, false],
    [{ x: 124, y: 224, width: 352.01, height: 252 }, {}, true],
    [{ x: 110, y: 224, width: 20, height: 20 }, {}, true],
    [{ x: 124, y: 224, width: 20, height: 20 }, { cssVisualViewport: null }, true],
    [{ x: 124, y: 224, width: 20, height: 20 }, { cssLayoutViewport: { ...viewport, pageX: 125 } }, true],
  ]) {
    const cdp = fakeCdp();
    const result = await captureElement(cdp, rect, { ...metrics, ...overrides });
    assert.equal(cdp.calls[0][1].captureBeyondViewport, expected);
    assert.equal(result.fullPageEvidenceId, 'full-original');
    assert.equal(result.metadata.highlightBox.x, 24);
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

  assert.deepEqual(cdp.calls[0][1].clip, { x: 176, y: 276, width: 128, height: 88, scale: 1 });
  assert.deepEqual(capture.metadata.highlightBox, {
    x: 24, y: 24, width: 80, height: 40,
    coordinateSpace: 'capture-css-px',
  });
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
