import test from 'node:test';
import assert from 'node:assert/strict';

import { MANUAL_ITEMS, MANUAL_REVIEW_RULES } from '../../src/core/rules/manual-review.js';
import { NBR17225_ITEMS } from '../../src/core/normative/nbr17225.js';
import { runRules } from '../../src/core/rules/run-rules.js';

function record(nodeId, tagName, overrides = {}) {
  return { nodeId, tagName, attributes: {}, text: '', children: [], parentId: null, hidden: false, selectorHint: `#${nodeId}`, role: '', ...overrides };
}

function snapshot(nodes = []) {
  const document = { nodeId: 'document' };
  return { document, nodes, byId: Object.fromEntries([['document', document], ...nodes.map(node => [String(node.nodeId), node])]) };
}

async function evaluate(ruleId, value) {
  const rule = MANUAL_REVIEW_RULES.find(candidate => candidate.id === ruleId);
  assert.ok(rule, `Regra ausente: ${ruleId}`);
  return (await runRules(value, {}, [rule]))[0];
}

test('remaining assisted rules return cantTell with objective human reason and applicable targets', async () => {
  const focus = await evaluate('focus-order', snapshot([
    record('button', 'button', { role: 'button', focusable: true })
  ]));
  assert.equal(focus.outcome, 'cantTell');
  assert.equal(focus.targets[0].nodeId, 'button');
  assert.match(focus.limitations[0], /julgamento humano|interação/i);

  const reading = await evaluate('reading-level', snapshot([
    record('text', 'p', { text: 'Conteúdo textual.' })
  ]));
  assert.equal(reading.outcome, 'cantTell');
  assert.equal(reading.targets[0].nodeId, 'document');
  assert.equal(reading.targets[0].selectorHint, '');
  assert.equal((await evaluate('focus-order', snapshot())).outcome, 'inapplicable');
});

test('assisted/manual review rules never pass merely because no automated failure was found', async () => {
  const assisted = MANUAL_REVIEW_RULES.filter(rule => rule.mode === 'assisted');
  const value = snapshot([
    record('link', 'a', { attributes: { href: '/ajuda' }, role: 'link', focusable: true, text: 'Ajuda' }),
    record('field', 'input', { role: 'textbox', focusable: true }),
    record('heading', 'h1', { role: 'heading', text: 'Título' })
  ]);
  const results = await runRules(value, {}, assisted);
  assert.ok(results.every(result => result.outcome !== 'passed'));
  assert.ok(results.filter(result => result.outcome === 'cantTell').every(result => result.limitations.length > 0));
});

test('manual items without rule IDs have pure serializable review descriptions', () => {
  const expected = NBR17225_ITEMS.filter(item => item.evaluation === 'manual');
  assert.equal(expected.length, 16);
  assert.equal(MANUAL_ITEMS.length, 16);
  assert.deepEqual(MANUAL_ITEMS.map(item => item.itemId), expected.map(item => item.id));
  for (const item of MANUAL_ITEMS) {
    assert.deepEqual(Object.keys(item), ['itemId', 'reason', 'evidenceRequest']);
    assert.ok(item.reason.trim());
    assert.ok(item.evidenceRequest.trim());
    assert.doesNotThrow(() => JSON.stringify(item));
  }
});

test('supporting automatic rules are conservative when observations are missing', async () => {
  assert.equal((await evaluate('table-title-association', snapshot([
    record('table', 'table', { hasTableTitle: true, tableTitleAssociated: false })
  ]))).outcome, 'failed');
  assert.equal((await evaluate('form-submit-button', snapshot([
    record('form', 'form')
  ]))).outcome, 'cantTell');
  assert.equal((await evaluate('custom-component-state', snapshot([
    record('custom', 'x-slider', { role: 'slider', requiredStates: ['value'], exposedStates: {} })
  ]))).outcome, 'failed');
});
