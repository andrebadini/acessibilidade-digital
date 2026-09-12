import test from 'node:test';
import assert from 'node:assert/strict';

import { buildStableSelector } from '../../src/core/evidence/selector.js';
import { parseCssSelectorV1 } from '../../src/background/highlight-locator.js';

function index(nodes) {
  const byNodeId = new Map(nodes.map(node => [String(node.nodeId), node]));
  const byDomId = new Map();
  for (const node of nodes) {
    if (!node.attributes?.id) continue;
    const values = byDomId.get(node.attributes.id) || [];
    values.push(node);
    byDomId.set(node.attributes.id, values);
  }
  return { byNodeId, byDomId };
}

test('prefers a unique stable DOM id with complete CSS escaping and frame path', () => {
  const node = { nodeId: 'n1', tagName: 'button', attributes: { id: '123 a#b' }, parentId: null, framePath: ['frame-1'] };
  assert.deepEqual(buildStableSelector(node, index([node])), {
    css: 'button#\\31 23\\ a\\#b', framePath: ['frame-1'], confidence: 'high'
  });
});

test('uses stable semantic attributes before a deterministic nth-of-type path', () => {
  const root = { nodeId: 'root', tagName: 'main', attributes: {}, parentId: null, children: ['a', 'b'] };
  const first = { nodeId: 'a', tagName: 'button', attributes: {}, parentId: 'root', children: [] };
  const semantic = { nodeId: 'b', tagName: 'button', attributes: { 'data-testid': 'save "draft"' }, parentId: 'root', children: [] };
  const all = [root, first, semantic];
  assert.deepEqual(buildStableSelector(semantic, index(all)), {
    css: 'button[data-testid="save \\22 draft\\22 "]', framePath: [], confidence: 'medium'
  });

  const fallback = { ...semantic, attributes: {} };
  const fallbackNodes = [root, first, fallback];
  assert.deepEqual(buildStableSelector(fallback, index(fallbackNodes)), {
    css: 'main > button:nth-of-type(2)', framePath: [], confidence: 'low'
  });
});

test('includes a sanitized shadow path and never embeds password or token identifiers', () => {
  const host = { nodeId: 'host', tagName: 'secure-panel', attributes: { id: 'account-panel' }, parentId: null, children: [] };
  const secret = {
    nodeId: 'secret', tagName: 'input', attributes: { id: 'password-token', name: 'access_token', type: 'password' },
    parentId: null, children: [], framePath: ['frame-token'], shadowPath: ['#account-panel']
  };
  const selector = buildStableSelector(secret, index([host, secret]));
  assert.equal(selector.css, '#account-panel >>> input');
  assert.deepEqual(selector.framePath, []);
  assert.doesNotMatch(JSON.stringify(selector), /password|token|access_token/i);
});

test('classed controls without an id use a structural locator that can be independently corroborated', () => {
  const root = { nodeId: 'root', tagName: 'html', attributes: {}, parentId: null, children: ['body'] };
  const body = { nodeId: 'body', tagName: 'body', attributes: {}, parentId: 'root', children: ['login'] };
  const login = { nodeId: 'login', tagName: 'a', attributes: { class: 'signin primary', 'aria-label': 'Fazer login' }, parentId: 'body', children: [] };
  assert.deepEqual(buildStableSelector(login, index([root, body, login])), {
    css: 'html > body > a', framePath: [], confidence: 'low',
  });
});

test('builds selectors by shadow scope instead of treating shadow ids as document-global', () => {
  const outside = { nodeId: 'outside', tagName: 'button', attributes: { id: 'inner' }, parentId: null, children: [] };
  const host = { nodeId: 'host', tagName: 'x-host', attributes: { id: 'account-panel' }, parentId: null, children: ['root'], shadowRootId: 'root' };
  const root = { nodeId: 'root', tagName: '#document-fragment', attributes: {}, parentId: 'host', children: ['inside'], shadowRootId: 'root', shadowHostId: 'host' };
  const inside = { nodeId: 'inside', tagName: 'button', attributes: { id: 'inner' }, parentId: 'root', children: [], shadowRootId: 'root', shadowHostId: 'host' };
  const selector = buildStableSelector(inside, index([outside, host, root, inside]));
  assert.deepEqual(selector, { css: 'x-host#account-panel >>> button#inner', framePath: [], confidence: 'high' });
  assert.doesNotMatch(selector.css, /\*/u);
});

test('a stable id evidence selector remains usable by the closed live-highlight grammar', () => {
  const node = { nodeId: 'n1', tagName: 'button', attributes: { id: 'memory-only-unnamed' }, parentId: null };
  const selector = buildStableSelector(node, index([node]));
  const parsed = parseCssSelectorV1(selector.css);
  assert.equal(parsed.value, 'button#memory-only-unnamed');
  assert.equal(parsed.segments[0].tag, 'button');
  assert.equal(parsed.segments[0].id, 'memory-only-unnamed');
});
