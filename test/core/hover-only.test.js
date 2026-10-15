import test from 'node:test';
import assert from 'node:assert/strict';

import { NBR17225_ITEMS } from '../../src/core/normative/nbr17225.js';
import { HOVER_ONLY_RULES, HOVER_ONLY_RULE_ID } from '../../src/core/rules/hover-only.js';
import { aggregateItems } from '../../src/core/rules/aggregate-items.js';
import { runRules } from '../../src/core/rules/run-rules.js';
import { CORE_RULES } from '../../src/core/index.js';
import { canonicalCoreRemediation, validateCoreRuleTargetInventory } from '../../src/core/report/remediation-policy.js';

const RULE = HOVER_ONLY_RULES.find(rule => rule.id === HOVER_ONLY_RULE_ID);

function node(nodeId, overrides = {}) {
  return {
    nodeId,
    tagName: 'div',
    attributes: { class: 'card' },
    text: 'Serviços',
    children: [],
    parentId: null,
    hidden: false,
    selectorHint: `.card[data-id="${nodeId}"]`,
    role: '',
    ...overrides
  };
}

function snapshot(nodes, observation) {
  const document = { nodeId: 'document', title: 'Página', language: 'pt-BR' };
  if (observation !== undefined) document.hoverOnlyObservation = observation;
  return { schemaVersion: 1, document, nodes };
}

function observation(overrides = {}) {
  return {
    status: 'complete',
    outcome: 'passed',
    truncated: false,
    candidates: 0,
    examinedGroups: 0,
    withheldGroups: 0,
    groups: [],
    warnings: [],
    ...overrides
  };
}

function group(nodeId, outcome, overrides = {}) {
  return {
    nodeId,
    outcome,
    targetCount: 4,
    revealedOnHover: 4,
    focusableInside: false,
    ...overrides
  };
}

async function evaluate(value) {
  const [result] = await runRules(value, {}, [RULE]);
  return result;
}

test('the rule belongs to item 5.1.13 and declares its WCAG 2.1.1 reference', () => {
  const item = NBR17225_ITEMS.find(candidate => candidate.id === '5.1.13');
  assert.equal(RULE.id, 'hover-only-interactive-content');
  assert.deepEqual([...RULE.nbrItems], ['5.1.13']);
  assert.deepEqual([...RULE.wcag], ['2.1.1']);
  assert.equal(RULE.mode, item.evaluation);
  assert.equal(item.ruleIds.includes(RULE.id), true);
  assert.equal(CORE_RULES.some(candidate => candidate.id === RULE.id), true);
});

test('a card whose hidden links only appear with the mouse fails with a keyboard explanation', async () => {
  const value = await evaluate(snapshot([node('n-42')], observation({
    examinedGroups: 1,
    groups: [group('n-42', 'failed')]
  })));
  const [target] = value.targets;

  assert.equal(value.outcome, 'failed');
  assert.equal(value.targets.length, 1);
  assert.equal(target.nodeId, 'n-42');
  assert.equal(target.data.reason, 'hover-only-content-not-keyboard-reachable');
  assert.match(target.message, /mouse/u);
  assert.match(target.message, /teclado/u);
  assert.match(target.message, /TAB/u);
  assert.match(target.message, /:focus-within|focável/u);
  assert.doesNotMatch(target.message, /hover-only-content-not-keyboard-reachable/u);
});

test('a confirmed failure survives a neighbouring group that still needs review', async () => {
  const value = await evaluate(snapshot([node('n-1'), node('n-2')], observation({
    examinedGroups: 2,
    groups: [group('n-2', 'cantTell', { focusableInside: true }), group('n-1', 'failed')]
  })));

  assert.equal(value.outcome, 'failed');
  assert.deepEqual(value.targets.map(target => target.nodeId).sort(), ['n-1']);
});

test('a focusable control that does not reveal the content stays a question for the reviewer', async () => {
  const value = await evaluate(snapshot([node('n-7')], observation({
    examinedGroups: 1,
    groups: [group('n-7', 'cantTell', { focusableInside: true, revealedOnHover: 2 })]
  })));

  assert.equal(value.outcome, 'cantTell');
  assert.equal(value.targets.length, 1);
  assert.equal(value.targets[0].nodeId, 'n-7');
  assert.equal(value.targets[0].data.reason, 'hover-only-keyboard-path-unconfirmed');
  assert.match(value.targets[0].message, /TAB/u);
});

test('a block whose animated opening was not measured out is a doubt about the collection', async () => {
  // A sondagem parou antes de a animação terminar. Isso não é o mesmo que "há um controle focável
  // que não revela": o texto precisa falar da medição, não de um controle que talvez nem exista.
  const value = await evaluate(snapshot([node('n-8')], observation({
    examinedGroups: 1,
    groups: [group('n-8', 'cantTell', { focusableInside: false, revealedOnHover: 0, unsettled: true })]
  })));

  assert.equal(value.outcome, 'cantTell');
  assert.equal(value.targets[0].nodeId, 'n-8');
  assert.equal(value.targets[0].data.reason, 'hover-only-observation-unavailable');
  assert.doesNotMatch(value.targets[0].message, /controle focável/u);
});

test('a block that seems to open by script, with no keyboard path, is a review with its own reason', async () => {
  const value = await evaluate(snapshot([node('n-10')], observation({
    examinedGroups: 1,
    groups: [group('n-10', 'cantTell', {
      focusableInside: false, revealedOnHover: 0, hoverScript: true, keyboardPath: false
    })]
  })));

  assert.equal(value.outcome, 'cantTell');
  assert.equal(value.targets.length, 1);
  assert.equal(value.targets[0].nodeId, 'n-10');
  assert.equal(value.targets[0].data.reason, 'hover-script-no-keyboard-path');
  assert.match(value.targets[0].message, /script.*mouse.*teclado|script.*teclado/iu, value.targets[0].message);
  assert.match(value.targets[0].message, /Tab/u);
  assert.match(value.summary, /script/u);
  // O mesmo bloco com caminho de teclado não é achado nenhum: a leitura dos ouvintes só tira a
  // conclusão de conformidade quando o teclado também abre o conteúdo.
  const reachable = await evaluate(snapshot([node('n-10')], observation({
    examinedGroups: 1,
    groups: [group('n-10', 'passed', {
      focusableInside: false, revealedOnHover: 0, hoverScript: true, keyboardPath: true
    })]
  })));
  assert.equal(reachable.outcome, 'passed');
  assert.deepEqual(reachable.targets, []);
});

test('a doubt about the measurement does not hide a confirmed failure in the same page', async () => {
  const value = await evaluate(snapshot([node('n-8'), node('n-9')], observation({
    examinedGroups: 2,
    groups: [group('n-8', 'cantTell', { unsettled: true }), group('n-9', 'failed')]
  })));

  assert.equal(value.outcome, 'failed');
  assert.deepEqual(value.targets.map(target => target.nodeId), ['n-9']);
});

test('groups that are already keyboard reachable, with no other group, pass without targets', async () => {
  const value = await evaluate(snapshot([node('n-3')], observation({
    examinedGroups: 1,
    groups: [group('n-3', 'passed', { revealedOnHover: 3, focusableInside: true })]
  })));

  assert.equal(value.outcome, 'passed');
  assert.deepEqual(value.targets, []);
});

test('a complete observation that found no hidden interactive content is inapplicable', async () => {
  const value = await evaluate(snapshot([node('n-4')], observation()));

  assert.equal(value.outcome, 'inapplicable');
  assert.deepEqual(value.targets, []);
  assert.equal(value.limitations.length, 0);
});

test('an observation that was not collected, was omitted, or did not finish stays cantTell', async () => {
  const missing = await evaluate(snapshot([node('n-5')]));
  const omitted = await evaluate(snapshot([node('n-5')], observation({ status: 'omitted', groups: [] })));
  const unfinished = await evaluate(snapshot([node('n-5')], observation({
    status: 'incomplete', groups: [group('n-5', 'passed')]
  })));
  const truncated = await evaluate(snapshot([node('n-5')], observation({ truncated: true })));

  for (const value of [missing, omitted, unfinished, truncated]) {
    assert.equal(value.outcome, 'cantTell');
    assert.deepEqual(value.targets.map(target => target.nodeId), ['document']);
    assert.equal(value.targets[0].data.reason, 'hover-only-observation-unavailable');
  }
  assert.match(missing.summary, /não acompanha este snapshot/u);
  assert.match(truncated.summary, /não foi concluída/u);
});

test('a group without a matching snapshot node never becomes a silent pass', async () => {
  const value = await evaluate(snapshot([node('n-6')], observation({
    examinedGroups: 1,
    groups: [group('n-404', 'failed')]
  })));

  assert.equal(value.outcome, 'cantTell');
  assert.equal(value.targets[0].data.reason, 'hover-only-observation-unavailable');
});

test('a snapshot without document and nodes is reported instead of crashing', async () => {
  const value = await evaluate({ nodes: [] });
  assert.equal(value.outcome, 'cantTell');
  assert.deepEqual(value.targets, []);
});

test('every produced target stays inside the closed remediation catalog', async () => {
  const scenarios = [
    await evaluate(snapshot([node('n-42')], observation({ groups: [group('n-42', 'failed')] }))),
    await evaluate(snapshot([node('n-7')], observation({ groups: [group('n-7', 'cantTell')] }))),
    await evaluate(snapshot([node('n-13')], observation({
      groups: [group('n-13', 'cantTell', { focusableInside: false, revealedOnHover: 0, hoverScript: true })]
    }))),
    await evaluate(snapshot([node('n-5')]))
  ];

  for (const value of scenarios) {
    assert.equal(value.targets.length > 0, true);
    // O modelo do relatório troca o texto do alvo pela remediação registrada no catálogo; sem a
    // entrada registrada, o motivo sumiria do relatório e o item perderia a orientação de conserto.
    const targets = value.targets.map(({ nodeId, data }) => {
      const message = canonicalCoreRemediation(RULE.id, data);
      assert.equal(typeof message, 'string', `${value.outcome}: ${data.reason}`);
      assert.match(message, /teclado|foco|TAB/u);
      return { nodeId, data, message };
    });
    assert.equal(validateCoreRuleTargetInventory(RULE.id, value.outcome, targets), true,
      `${value.outcome}: ${JSON.stringify(targets)}`);
  }
});

test('item 5.1.13 turns failed when the hover rule fails, even though the review rule only asks', async () => {
  const hover = await evaluate(snapshot([node('n-9')], observation({
    examinedGroups: 1,
    groups: [group('n-9', 'failed')]
  })));
  const review = CORE_RULES.find(rule => rule.id === 'partial-keyboard-access');
  const reviewResult = (await runRules(snapshot([node('n-9')]), {}, [review]))[0];
  const items = aggregateItems([hover, reviewResult], NBR17225_ITEMS);
  const item = items.find(candidate => candidate.id === '5.1.13');

  assert.equal(reviewResult.outcome, 'cantTell');
  assert.equal(item.outcome, 'failed');
  assert.equal(item.ruleIds.includes('partial-keyboard-access'), true);
  assert.equal(item.ruleIds.includes(RULE.id), true);
});
