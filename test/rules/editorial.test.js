import assert from 'node:assert/strict';
import test from 'node:test';

const editorialModule = await import('../../src/core/rules/editorial.js').catch(() => null);

function node(nodeId, tagName, overrides = {}) {
  return {
    nodeId, tagName, attributes: {}, text: '', visibleText: '', hidden: false,
    parentId: null, children: [], selectorHint: `#PRIVATE-${nodeId}`, ...overrides,
  };
}

function snapshot(nodes = []) {
  return { schemaVersion: 1, document: { nodeId: 'document' }, nodes };
}

test('exports one separately frozen and exactly versioned editorial rule', () => {
  assert.ok(editorialModule, 'editorial rule module must exist');
  assert.equal(Object.isFrozen(editorialModule.EDITORIAL_RULES), true);
  assert.equal(editorialModule.EDITORIAL_RULES.length, 1);
  const rule = editorialModule.EDITORIAL_RULES[0];
  assert.deepEqual({
    id: rule.id, mode: rule.mode, classification: rule.classification,
    impact: rule.impact, confidence: rule.confidence, source: rule.source,
  }, {
    id: 'editorial.placeholder-text', mode: 'automated', classification: 'editorial',
    impact: 'minor', confidence: 'high',
    source: { engine: 'audita-editorial', version: '1.0.0' },
  });
  assert.deepEqual(editorialModule.validateEditorialRuleComposition(), []);
});

test('reports unequivocal placeholder content without persisting matched text or author selectors', async () => {
  assert.ok(editorialModule, 'editorial rule module must exist');
  const [result] = await editorialModule.runEditorialRules(snapshot([
    node('n-1', 'p', { text: 'Introdução LOREM\u00a0IPSUM dolor sit amet.' }),
    node('n-2', 'p', { text: 'Conteúdo final e revisado.' }),
  ]));

  assert.deepEqual(Object.keys(result).sort(), [
    'classification', 'confidence', 'impact', 'limitations', 'mode', 'nbrItems',
    'outcome', 'ruleId', 'source', 'summary', 'targets', 'wcag',
  ]);
  assert.equal(result.outcome, 'failed');
  assert.equal(result.classification, 'editorial');
  assert.deepEqual(result.nbrItems, []);
  assert.deepEqual(result.wcag, []);
  assert.deepEqual(result.targets, [{
    nodeId: 'n-1', selectorHint: '',
    message: 'Substitua o conteúdo provisório antes da publicação.',
    data: { reason: 'placeholder-text' },
  }]);
  assert.doesNotMatch(JSON.stringify(result), /lorem|ipsum|dolor|PRIVATE-/iu);
});

test('reports the deepest matching content node instead of duplicating descendant text on containers', async () => {
  assert.ok(editorialModule, 'editorial rule module must exist');
  const [result] = await editorialModule.runEditorialRules(snapshot([
    node('container', 'div', { text: 'Lorem ipsum', children: ['paragraph'] }),
    node('paragraph', 'p', { parentId: 'container', text: 'Lorem ipsum' }),
  ]));
  assert.deepEqual(result.targets.map(target => target.nodeId), ['paragraph']);
});

test('excludes private, editable, executable and hidden content and bounds results', async () => {
  assert.ok(editorialModule, 'editorial rule module must exist');
  const privateRoot = node('private-root', 'div', {
    attributes: { contenteditable: 'true' }, text: 'LOREM IPSUM PRIVATE-EDITOR',
    children: ['private-child'],
  });
  const values = [
    node('textarea', 'textarea', { text: 'lorem ipsum PRIVATE-TEXTAREA' }),
    node('input', 'input', { text: 'lorem ipsum PRIVATE-INPUT' }),
    privateRoot,
    node('private-child', 'span', { parentId: 'private-root', text: 'lorem ipsum PRIVATE-CHILD' }),
    node('script', 'script', { text: 'lorem ipsum PRIVATE-SCRIPT' }),
    node('style', 'style', { text: 'lorem ipsum PRIVATE-STYLE' }),
    node('template', 'template', { text: 'lorem ipsum PRIVATE-TEMPLATE' }),
    node('hidden', 'p', { hidden: true, text: 'lorem ipsum PRIVATE-HIDDEN' }),
    node('aria-hidden', 'p', { attributes: { 'aria-hidden': 'true' }, text: 'lorem ipsum PRIVATE-ARIA' }),
    node('not-match', 'p', { text: 'A expressão lorem isolada não basta.' }),
    ...Array.from({ length: 80 }, (_, index) => node(`match-${index}`, 'p', { text: 'Lorem ipsum' })),
  ];
  const [result] = await editorialModule.runEditorialRules(snapshot(values));
  assert.equal(result.outcome, 'failed');
  assert.equal(result.targets.length, 64);
  assert.deepEqual(result.limitations, [{
    code: 'EDITORIAL_RESULT_LIMIT_REACHED', retainedResultCount: 64,
  }]);
  assert.ok(result.targets.every(target => target.nodeId.startsWith('match-')));
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE-|lorem|ipsum/iu);
});

test('reports node-scan truncation and never treats an unseen node as inapplicable', async () => {
  const values = Array.from({ length: 5_001 }, (_, index) => node(`node-${index}`, 'p', {
    text: index === 5_000 ? 'Lorem ipsum PRIVATE-BEYOND-CAP' : 'Conteúdo final.',
  }));
  const [result] = await editorialModule.runEditorialRules(snapshot(values));
  assert.equal(result.outcome, 'cantTell');
  assert.deepEqual(result.targets, []);
  assert.equal(result.summary, 'A verificação editorial ficou incompleta devido ao limite de varredura.');
  assert.deepEqual(result.limitations, [{
    code: 'EDITORIAL_NODE_SCAN_TRUNCATED', retainedNodeCount: 5_000,
  }]);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE-|lorem|ipsum/iu);
});

test('keeps a conclusive hit while declaring both fixed caps when applicable', async () => {
  const values = [
    ...Array.from({ length: 65 }, (_, index) => node(`match-${index}`, 'p', { text: 'Lorem ipsum' })),
    ...Array.from({ length: 4_936 }, (_, index) => node(`final-${index}`, 'p', { text: 'Conteúdo final.' })),
  ];
  const [result] = await editorialModule.runEditorialRules(snapshot(values));
  assert.equal(result.outcome, 'failed');
  assert.equal(result.targets.length, 64);
  assert.deepEqual(result.limitations, [
    { code: 'EDITORIAL_NODE_SCAN_TRUNCATED', retainedNodeCount: 5_000 },
    { code: 'EDITORIAL_RESULT_LIMIT_REACHED', retainedResultCount: 64 },
  ]);
});

test('contains accessors, revoked proxies and malformed snapshots without leaking sentinel text', async () => {
  assert.ok(editorialModule, 'editorial rule module must exist');
  let reads = 0;
  const hostile = node('hostile', 'p');
  Object.defineProperty(hostile, 'text', {
    enumerable: true, get() { reads += 1; return 'lorem ipsum PRIVATE-GETTER'; },
  });
  const pair = Proxy.revocable([], {});
  pair.revoke();
  const results = await editorialModule.runEditorialRules({
    schemaVersion: 1, document: { nodeId: 'document' }, nodes: pair.proxy,
  });
  const hostileResults = await editorialModule.runEditorialRules(snapshot([hostile]));
  assert.equal(reads, 0);
  assert.equal(results[0].outcome, 'inapplicable');
  assert.equal(hostileResults[0].outcome, 'inapplicable');
  assert.doesNotMatch(JSON.stringify([results, hostileResults]), /PRIVATE-GETTER/u);
});
