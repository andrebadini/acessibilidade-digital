import test from 'node:test';
import assert from 'node:assert/strict';

import { createRuleResult } from '../../src/core/result.js';
import { NBR17225_ITEMS } from '../../src/core/normative/nbr17225.js';
import {
  createRuleRegistry,
  registerRule
} from '../../src/core/rules/registry.js';
import { runRules } from '../../src/core/rules/run-rules.js';
import { aggregateItems } from '../../src/core/rules/aggregate-items.js';

function result(ruleId, outcome, nbrItems, options = {}) {
  return Object.freeze({
    ...createRuleResult({
      ruleId,
      outcome,
      mode: options.mode ?? 'automated',
      targets: options.targets ?? [],
      summary: options.summary ?? '',
      limitations: options.limitations ?? []
    }),
    nbrItems: Object.freeze([...nbrItems])
  });
}

function item(id, humanReason = '') {
  return Object.freeze({
    id,
    printedId: id,
    title: `Item ${id}`,
    classification: 'requirement',
    wcag: Object.freeze([]),
    evaluation: 'automated',
    ruleIds: Object.freeze([]),
    humanReason
  });
}

test('registerRule validates and defensively normalizes an isolated rule', () => {
  for (const invalid of [
    { id: '', mode: 'automated', nbrItems: ['5.1.1'], evaluate() {} },
    { id: 'bad-mode', mode: 'automatic', nbrItems: ['5.1.1'], evaluate() {} },
    { id: 'no-items', mode: 'automated', nbrItems: [], evaluate() {} },
    { id: 'no-evaluate', mode: 'automated', nbrItems: ['5.1.1'], evaluate: null }
  ]) {
    assert.throws(() => registerRule(invalid), /rule|id|mode|item|evaluate/i);
  }

  const sourceItems = [' 5.1.1 ', '5.1.1', '5.1.2'];
  const rule = registerRule({
    id: '  visible-name  ',
    mode: 'automated',
    nbrItems: sourceItems,
    evaluate() { return { outcome: 'passed' }; }
  });

  assert.deepEqual(rule.nbrItems, ['5.1.1', '5.1.2']);
  assert.equal(rule.id, 'visible-name');
  assert.equal(Object.isFrozen(rule), true);
  assert.equal(Object.isFrozen(rule.nbrItems), true);
  assert.notEqual(rule.nbrItems, sourceItems);
});

test('explicit rule registry rejects duplicate IDs without global state', () => {
  const first = { id: 'same-id', mode: 'manual', nbrItems: ['5.1.1'], evaluate() {} };
  const second = { id: ' same-id ', mode: 'manual', nbrItems: ['5.1.2'], evaluate() {} };

  assert.throws(() => createRuleRegistry([first, second]), /duplicate|same-id/i);
  assert.deepEqual(
    createRuleRegistry([first]).map(rule => rule.id),
    ['same-id']
  );
});

test('runRules preserves input order for synchronous and asynchronous evaluations', async () => {
  const received = [];
  const snapshot = Object.freeze({ documentId: 'page-1' });
  const context = Object.freeze({ locale: 'pt-BR' });
  const rules = createRuleRegistry([
    {
      id: 'sync', mode: 'automated', nbrItems: ['5.1.1'],
      evaluate(actualSnapshot, actualContext) {
        received.push([actualSnapshot, actualContext]);
        return { outcome: 'passed', summary: 'Verificação síncrona.' };
      }
    },
    {
      id: 'async', mode: 'assisted', nbrItems: ['5.1.2'],
      async evaluate() {
        return { outcome: 'cantTell', limitations: ['Exige julgamento humano.'] };
      }
    }
  ]);

  const values = await runRules(snapshot, context, rules);

  assert.deepEqual(values.map(value => [value.ruleId, value.outcome, value.mode, value.nbrItems]), [
    ['sync', 'passed', 'automated', ['5.1.1']],
    ['async', 'cantTell', 'assisted', ['5.1.2']]
  ]);
  assert.deepEqual(received, [[snapshot, context]]);
});

test('runRules converts an evaluation exception into a safe untested result and continues', async () => {
  const secret = 'token=nao-expor';
  const rules = createRuleRegistry([
    {
      id: 'throws', mode: 'automated', nbrItems: ['5.1.1'],
      evaluate() { throw new Error(secret); }
    },
    {
      id: 'continues', mode: 'manual', nbrItems: ['5.1.2'],
      evaluate() { return { outcome: 'passed' }; }
    }
  ]);

  const values = await runRules({}, {}, rules);

  assert.deepEqual(values.map(value => value.outcome), ['untested', 'passed']);
  assert.deepEqual(values[0].nbrItems, ['5.1.1']);
  assert.equal(values[0].mode, 'automated');
  assert.match(values[0].summary, /não pôde ser executada/i);
  assert.doesNotMatch(JSON.stringify(values[0]), new RegExp(secret));
});

test('runRules turns a malformed evaluation result into a valid untested result', async () => {
  const rules = createRuleRegistry([
    {
      id: 'malformed', mode: 'automated', nbrItems: ['5.1.1'],
      evaluate() { return { outcome: 'approved', targets: 'not-an-array' }; }
    }
  ]);

  const [value] = await runRules({}, {}, rules);

  assert.deepEqual(value, {
    ruleId: 'malformed',
    outcome: 'untested',
    mode: 'automated',
    targets: [],
    summary: 'A regra retornou um resultado inválido e não foi considerada.',
    limitations: ['Revise a implementação da regra e execute a auditoria novamente.'],
    nbrItems: ['5.1.1']
  });
  assert.equal(Object.isFrozen(value), true);
});

test('runRules rejects a result that changes its registered identity or schema', async () => {
  const rules = createRuleRegistry([
    {
      id: 'stable-identity', mode: 'assisted', nbrItems: ['5.1.1'],
      evaluate() {
        return {
          ruleId: 'other-rule',
          mode: 'automated',
          outcome: 'passed',
          unexpected: 'must-not-reach-the-report'
        };
      }
    }
  ]);

  const [value] = await runRules({}, {}, rules);

  assert.equal(value.outcome, 'untested');
  assert.equal(value.ruleId, 'stable-identity');
  assert.equal(value.mode, 'assisted');
  assert.doesNotMatch(JSON.stringify(value), /must-not-reach-the-report/);
});

test('aggregateItems applies every outcome precedence boundary deterministically', () => {
  const items = ['a', 'b', 'c', 'd'].map(id => item(id));
  const values = aggregateItems([
    result('failed', 'failed', ['a']), result('review', 'cantTell', ['a']),
    result('review', 'cantTell', ['b']), result('untested', 'untested', ['b']),
    result('untested', 'untested', ['c']), result('passed', 'passed', ['c']),
    result('passed', 'passed', ['d']), result('na', 'inapplicable', ['d'])
  ], items);

  assert.deepEqual(values.map(value => [value.id, value.outcome]), [
    ['a', 'failed'],
    ['b', 'cantTell'],
    ['c', 'untested'],
    ['d', 'passed']
  ]);
});

test('aggregateItems keeps linked RuleResults and evidence separate from normative item data', () => {
  const evidence = { nodeId: 42, message: 'Controle sem nome.' };
  const [value] = aggregateItems([
    result('accessible-name', 'failed', ['5.13.10'], { targets: [evidence] })
  ], [item('5.13.10')]);

  assert.equal(value.id, '5.13.10');
  assert.equal(value.outcome, 'failed');
  assert.equal(value.ruleResults.length, 1);
  assert.deepEqual(value.ruleResults[0].targets, [evidence]);
  assert.equal(value.ruleResults[0].ruleId, 'accessible-name');
  assert.equal(value.humanReason, '');
  assert.equal(Object.isFrozen(value.ruleResults), true);
});

test('aggregateItems marks an unlinked item cantTell with its stored or safe human reason', () => {
  const values = aggregateItems([], [
    item('stored', 'A finalidade deste requisito depende de avaliação humana.'),
    item('missing')
  ]);

  assert.deepEqual(values.map(value => [value.id, value.outcome, value.humanReason]), [
    ['stored', 'cantTell', 'A finalidade deste requisito depende de avaliação humana.'],
    ['missing', 'cantTell', 'Não há resultado de regra vinculado a este item; é necessária revisão humana.']
  ]);
});

test('aggregateItems returns every real NBR item in normative order', () => {
  const values = aggregateItems([], NBR17225_ITEMS);

  assert.equal(values.length, 146);
  assert.deepEqual(values.map(value => value.id), NBR17225_ITEMS.map(value => value.id));
  assert.ok(values.every(value => value.outcome === 'cantTell'));
});

test('aggregateItems handles duplicate item links and unknown item IDs without corruption', () => {
  const rules = [
    result('known-once', 'passed', ['known', 'known', 'unknown']),
    result('known-twice', 'failed', ['known'])
  ];

  const first = aggregateItems(rules, [item('known')]);
  const second = aggregateItems(rules, [item('known')]);

  assert.deepEqual(first, second);
  assert.equal(first.length, 1);
  assert.equal(first[0].outcome, 'failed');
  assert.equal(first[0].ruleResults.length, 2);
});
