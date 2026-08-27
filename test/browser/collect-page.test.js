import assert from 'node:assert/strict';
import test from 'node:test';

import { collectPage } from '../../src/browser/collect-page.js';

function cdp() {
  return {
    async command(method) {
      if (method.endsWith('.enable')) return {};
      if (method === 'Page.getFrameTree') return {
        frameTree: { frame: { id: 'main', url: 'https://example.test/' } },
      };
      if (method === 'DOMSnapshot.captureSnapshot') return { strings: [], documents: [] };
      if (method === 'Accessibility.getFullAXTree') return { nodes: [] };
      if (method === 'Page.getLayoutMetrics') return {};
      throw new Error(`Unexpected command: ${method}`);
    },
  };
}

test('aggregates boolean-only widget signals across completely observed runtime frames', async () => {
  const output = await collectPage(cdp(), 7, { executeScript: async () => [{
    frameId: 'main', result: {
      url: 'https://example.test/', nodes: [],
      widgetSignals: {
        vlibras: { dom: true, script: false, global: false },
        'hand-talk': { dom: false, script: true, global: false },
      },
    },
  }] });
  assert.deepEqual(output.widgetObservations, {
    coverage: 'complete', widgets: {
      vlibras: { dom: true, script: false, global: false },
      'hand-talk': { dom: false, script: true, global: false },
    },
  });
  assert.doesNotMatch(JSON.stringify(output.widgetObservations), /url|selector|PRIVATE|globalValue|scriptSrc/iu);
});

test('contains accessor and revoked executeScript payloads without reading private values', async () => {
  let reads = 0;
  const hostile = { frameId: 'main' };
  Object.defineProperty(hostile, 'result', {
    enumerable: true, get() { reads += 1; return { privateText: 'PRIVATE-RUNTIME-SENTINEL' }; },
  });
  const accessorOutput = await collectPage(cdp(), 7, { executeScript: async () => [hostile] });
  const pair = Proxy.revocable([], {});
  pair.revoke();
  const revokedOutput = await collectPage(cdp(), 7, { executeScript: async () => pair.proxy });

  assert.equal(reads, 0);
  assert.notEqual(accessorOutput.widgetObservations.coverage, 'complete');
  assert.notEqual(revokedOutput.widgetObservations.coverage, 'complete');
  assert.doesNotMatch(JSON.stringify([accessorOutput.widgetObservations, revokedOutput.widgetObservations]), /PRIVATE-/u);
});
