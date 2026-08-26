import test from 'node:test';
import assert from 'node:assert/strict';

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

test('captures and validates one deterministic full-page PNG evidence record', async () => {
  const cdp = fakeCdp();
  const first = await captureFullPage(cdp, { cssContentSize: { width: 800, height: 1200 } });
  const second = await captureFullPage(fakeCdp(), { cssContentSize: { width: 800, height: 1200 } });
  assert.deepEqual(cdp.calls, [['Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, fromSurface: true }]]);
  assert.equal(first.status, 'captured');
  assert.equal(first.dataUrl, `data:image/png;base64,${PNG_1PX}`);
  assert.equal(first.evidenceId, second.evidenceId);
  assert.deepEqual(first.metadata, { kind: 'full-page', mimeType: 'image/png', width: 800, height: 1200 });
});

test('captures clamped element thumbnails and references the full-page evidence id', async () => {
  const cdp = fakeCdp();
  const capture = await captureElement(cdp, { x: -10, y: 10, width: 50, height: 30 }, {
    cssContentSize: { width: 100, height: 100 }, fullPageEvidenceId: 'full-page-abc'
  });
  assert.deepEqual(cdp.calls, [['Page.captureScreenshot', {
    format: 'png', captureBeyondViewport: true, fromSurface: true,
    clip: { x: 0, y: 10, width: 40, height: 30, scale: 1 }
  }]]);
  assert.equal(capture.metadata.kind, 'thumbnail');
  assert.equal(capture.fullPageEvidenceId, 'full-page-abc');
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
