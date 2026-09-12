import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSnapshot } from '../../src/core/normalize-snapshot.js';
import { redactNormalizedNode } from '../../src/core/privacy.js';

test('final privacy boundary strips derived text widths from private and executable contexts', () => {
  const node = { tagName: 'p', attributes: {}, text: 'Example', charactersPerLine: 7 };
  assert.equal(redactNormalizedNode(node).charactersPerLine, 7);
  for (const options of [{ privateText: true }, { privateTextAncestor: true }, { executable: true }]) {
    assert.equal(redactNormalizedNode(node, options).charactersPerLine, undefined);
  }
  assert.equal(redactNormalizedNode({ ...node, tagName: 'input' }).charactersPerLine, undefined);
});

test('normalization keeps bounded complete line counts and rejects invalid numbers and accessors', () => {
  for (const [count, expected] of [[5, 5], [2048, 2048], [2049, undefined], [0, undefined],
    [-1, undefined], [1.5, undefined], [Infinity, undefined], [NaN, undefined], ['5', undefined]]) {
    const raw = { format: 'simplified-v1', document: { url: 'https://example.test/' }, nodes: [{
      backendNodeId: 1, tagName: 'p', parentBackendNodeId: null, attributes: {}, text: 'Example', charactersPerLine: count,
    }] };
    assert.equal(normalizeSnapshot(raw).nodes[0].charactersPerLine, expected);
  }
  const node = { backendNodeId: 1, tagName: 'p', parentBackendNodeId: null, attributes: {}, text: 'Example' };
  let reads = 0;
  Object.defineProperty(node, 'charactersPerLine', { enumerable: true, get() { reads++; return 5; } });
  const snapshot = normalizeSnapshot({ format: 'simplified-v1', document: { url: 'https://example.test/' }, nodes: [node] });
  assert.equal(reads, 0);
  assert.equal(snapshot.nodes[0].charactersPerLine, undefined);
});
