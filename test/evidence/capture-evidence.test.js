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
  assert.deepEqual(first.metadata, { kind: 'full-page', mimeType: 'image/png', width: 800, height: 1200 });
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
  assert.equal(cdp.calls[0][1].clip.y, 1500);
  assert.equal(cdp.calls[0][1].clip.x, 20);
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
