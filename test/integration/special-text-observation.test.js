import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSnapshot } from '../../src/core/normalize-snapshot.js';
import { runRules } from '../../src/core/rules/run-rules.js';
import { VISUAL_RULES } from '../../src/core/rules/visual.js';
import { aggregateItems } from '../../src/core/rules/aggregate-items.js';
import { NBR17225_ITEMS } from '../../src/core/normative/nbr17225.js';

async function evaluate(nodes) {
  const snapshot = normalizeSnapshot({
    format: 'simplified-v1',
    document: { url: 'https://example.test/', title: 'Texto', language: 'pt-BR' },
    nodes: nodes.map((node, index) => ({ backendNodeId: index + 1, ...node }))
  });
  const [result] = await runRules(snapshot, {}, VISUAL_RULES.filter(rule => rule.id === 'special-text-semantics'));
  return { snapshot, result };
}

test('observed emphasis is not declared inapplicable or globally conforming', async () => {
  const { result } = await evaluate([{ tagName: 'em', text: 'Atenção' }]);
  assert.equal(result.outcome, 'cantTell');
  assert.deepEqual(result.targets, [], 'valid markup is not an occurrence requiring repair');
  assert.match(result.summary, /1 marcação/u);
});

test('unmarked ordinary or visually emphasized text stays a general checklist, not a failure', async () => {
  for (const tagName of ['p', 'b', 'i', 'span', 'h1']) {
    const { result } = await evaluate([{ tagName, text: 'Informação', styles: { 'font-weight': '700', 'font-style': 'italic' } }]);
    assert.equal(result.outcome, 'cantTell');
    assert.deepEqual(result.targets, []);
  }
});

test('absence of observed text does not prove absence of special text in the page', async () => {
  assert.equal((await evaluate([])).result.outcome, 'cantTell');
});

test('hundreds of semantic excerpts do not generate hundreds of suspected problems', async () => {
  const { result } = await evaluate(Array.from({ length: 400 }, () => ({ tagName: 'strong', text: 'Importante' })));
  assert.equal(result.outcome, 'cantTell');
  assert.deepEqual(result.targets, []);
  assert.match(result.summary, /400 marcações/u);
});

test('private, executable and hidden excerpts are excluded from the observed markup inventory', async () => {
  const { snapshot, result } = await evaluate([
    { tagName: 'div', attributes: { contenteditable: 'true' } },
    { tagName: 'em', text: 'PRIVATE-TEXT-SENTINEL', parentBackendNodeId: 1 },
    { tagName: 'template' },
    { tagName: 'strong', text: 'Not rendered', parentBackendNodeId: 3 },
    { tagName: 'div', hidden: true },
    { tagName: 'em', text: 'Hidden child', parentBackendNodeId: 5 },
    { tagName: 'q', text: 'Public quotation' }
  ]);
  assert.equal(result.outcome, 'cantTell');
  assert.match(result.summary, /1 marcação/u);
  assert.deepEqual(result.targets, []);
  assert.equal(JSON.stringify({ snapshot, result }).includes('PRIVATE-TEXT-SENTINEL'), false);
});

test('columnar DOM text children retain observed markup without approving the ABNT item', async () => {
  const snapshot = normalizeSnapshot({ domSnapshot: {
    strings: ['#document', 'HTML', 'BODY', 'EM', '#text', '', 'Importante', 'https://example.test/', 'Página'],
    documents: [{ documentURL: 7, title: 8, nodes: {
      parentIndex: [-1, 0, 1, 2, 3], nodeType: [9, 1, 1, 1, 3],
      nodeName: [0, 1, 2, 3, 4], nodeValue: [5, 5, 5, 5, 6],
      backendNodeId: [1, 2, 3, 4, 5], attributes: [[], [], [], [], []]
    }, layout: { nodeIndex: [3, 4], bounds: [[0, 0, 80, 20], [0, 0, 80, 20]], styles: [[], []] } }]
  } });
  const results = await runRules(snapshot, {}, VISUAL_RULES.filter(rule => rule.id === 'special-text-semantics'));
  assert.equal(results[0].outcome, 'cantTell');
  assert.match(results[0].summary, /1 marcação/u);
  assert.deepEqual(results[0].targets, []);
  const items = aggregateItems(results, NBR17225_ITEMS);
  assert.equal(items.find(item => item.id === '5.12.8').outcome, 'cantTell');
});

test('unused special-text flags cannot fabricate a conclusive result', async () => {
  for (const specialTextSemantic of [true, false, 'true']) {
    const { snapshot } = await evaluate([{ tagName: 'span', text: 'Texto' }]);
    snapshot.nodes[0].specialTextKind = 'emphasis';
    snapshot.nodes[0].specialTextSemantic = specialTextSemantic;
    const [result] = await runRules(snapshot, {}, VISUAL_RULES.filter(rule => rule.id === 'special-text-semantics'));
    assert.equal(result.outcome, 'cantTell');
    assert.deepEqual(result.targets, []);
  }
});
