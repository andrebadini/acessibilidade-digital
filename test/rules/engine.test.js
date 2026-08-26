import test from 'node:test';
import assert from 'node:assert/strict';

import { OUTCOMES, createRuleResult } from '../../src/core/result.js';
import { NBR17225_ITEMS } from '../../src/core/normative/nbr17225.js';
import {
  createRuleRegistry,
  registerRule
} from '../../src/core/rules/registry.js';
import { runRules } from '../../src/core/rules/run-rules.js';
import { aggregateItems } from '../../src/core/rules/aggregate-items.js';

const DEFAULT_REASON_FOR_TESTS =
  'Não há resultado de regra vinculado a este item; é necessária revisão humana.';

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

function item(id, humanReason = '', ruleIds = []) {
  return Object.freeze({
    id,
    printedId: id,
    title: `Item ${id}`,
    classification: 'requirement',
    wcag: Object.freeze([]),
    evaluation: 'automated',
    ruleIds: Object.freeze([...ruleIds]),
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

test('runRules converts a null evaluation result into an untested result', async () => {
  const rules = createRuleRegistry([{
    id: 'null-result', mode: 'manual', nbrItems: ['5.1.1'],
    evaluate() { return null; }
  }]);

  const [value] = await runRules({}, {}, rules);

  assert.equal(value.outcome, 'untested');
  assert.equal(value.ruleId, 'null-result');
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
  const items = [
    item('a', '', ['a-failed', 'a-review']),
    item('b', '', ['b-review', 'b-untested']),
    item('c', '', ['c-untested', 'c-passed']),
    item('d', '', ['d-passed', 'd-na'])
  ];
  const values = aggregateItems([
    result('a-failed', 'failed', ['a']), result('a-review', 'cantTell', ['a']),
    result('b-review', 'cantTell', ['b']), result('b-untested', 'untested', ['b']),
    result('c-untested', 'untested', ['c']), result('c-passed', 'passed', ['c']),
    result('d-passed', 'passed', ['d']), result('d-na', 'inapplicable', ['d'])
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
  ], [item('5.13.10', '', ['accessible-name'])]);

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

  const first = aggregateItems(rules, [item('known', '', ['known-once', 'known-twice'])]);
  const second = aggregateItems(rules, [item('known', '', ['known-once', 'known-twice'])]);

  assert.deepEqual(first, second);
  assert.equal(first.length, 1);
  assert.equal(first[0].outcome, 'failed');
  assert.equal(first[0].ruleResults.length, 2);
});

test('aggregateItems quarantines a RuleResult whose ruleId is not declared by the item', () => {
  const knownItem = NBR17225_ITEMS.find(candidate => candidate.id === '5.13.10');
  const [value] = aggregateItems([
    result('unknown-rule', 'passed', ['5.13.10'])
  ], [knownItem]);

  assert.equal(value.outcome, 'cantTell');
  assert.deepEqual(value.ruleResults, []);
  assert.equal(value.humanReason, DEFAULT_REASON_FOR_TESTS);
});

test('aggregateItems quarantines duplicate RuleResults instead of elevating an item', () => {
  const [value] = aggregateItems([
    result('declared', 'passed', ['known']),
    result('declared', 'passed', ['known'])
  ], [item('known', '', ['declared'])]);

  assert.equal(value.outcome, 'cantTell');
  assert.deepEqual(value.ruleResults, []);
});

test('aggregateItems rejects malformed and null RuleResults without corrupting an item', () => {
  const [value] = aggregateItems([
    null,
    { ruleId: 'declared', outcome: 'passed', mode: 'automated', nbrItems: ['known'] }
  ], [item('known', '', ['declared'])]);

  assert.equal(value.outcome, 'cantTell');
  assert.deepEqual(value.ruleResults, []);
});

test('aggregateItems quarantines a RuleResult with throwing getters', () => {
  const secret = 'token=getter-secret';
  const malformed = {};
  Object.defineProperty(malformed, 'ruleId', {
    enumerable: true,
    get() { throw new Error(secret); }
  });

  const [value] = aggregateItems([malformed], [item('known', '', ['declared'])]);

  assert.equal(value.outcome, 'cantTell');
  assert.doesNotMatch(JSON.stringify(value), new RegExp(secret));
});

test('runRules rejects a result with forged nbrItems even when ruleId and mode match', async () => {
  const rules = createRuleRegistry([{
    id: 'bound-rule', mode: 'automated', nbrItems: ['5.1.1'],
    evaluate() {
      return {
        ruleId: 'bound-rule',
        mode: 'automated',
        nbrItems: ['5.1.2'],
        outcome: 'passed'
      };
    }
  }]);

  const [value] = await runRules({}, {}, rules);

  assert.equal(value.outcome, 'untested');
  assert.deepEqual(value.nbrItems, ['5.1.1']);
});

test('runRules quarantines duplicate direct rule IDs and continues with distinct rules', async () => {
  const directRules = [
    { id: 'duplicate', mode: 'automated', nbrItems: ['5.1.1'], evaluate: () => ({ outcome: 'passed' }) },
    { id: ' duplicate ', mode: 'automated', nbrItems: ['5.1.1'], evaluate: () => ({ outcome: 'passed' }) },
    { id: 'distinct', mode: 'manual', nbrItems: ['5.1.2'], evaluate: () => ({ outcome: 'passed' }) }
  ];

  const values = await runRules({}, {}, directRules);

  assert.deepEqual(values.map(value => value.outcome), ['untested', 'untested', 'passed']);
  assert.deepEqual(values.map(value => value.ruleId), ['duplicate', 'duplicate', 'distinct']);
});

test('runRules contains rejected thenables and continues without leaking rejection details', async () => {
  const secret = 'token=thenable-secret';
  const rules = createRuleRegistry([
    {
      id: 'rejecting-thenable', mode: 'automated', nbrItems: ['5.1.1'],
      evaluate() { return { then(resolve, reject) { reject(new Error(secret)); } }; }
    },
    {
      id: 'resolving-thenable', mode: 'manual', nbrItems: ['5.1.2'],
      evaluate() { return { then(resolve) { resolve({ outcome: 'passed' }); } }; }
    }
  ]);

  const values = await runRules({}, {}, rules);

  assert.deepEqual(values.map(value => value.outcome), ['untested', 'passed']);
  assert.doesNotMatch(JSON.stringify(values[0]), new RegExp(secret));
});

test('runRules gives each rule an isolated frozen deep view without freezing caller data', async () => {
  const snapshot = { nested: { label: 'original' }, nodes: [{ id: 1 }] };
  const context = {
    preferences: { locale: 'pt-BR' },
    count(values) { return values.length; }
  };
  const rules = createRuleRegistry([
    {
      id: 'mutates-view', mode: 'automated', nbrItems: ['5.1.1'],
      async evaluate(viewSnapshot, viewContext) {
        await Promise.resolve();
        assert.equal(viewContext.count(viewSnapshot.nodes), 1);
        viewSnapshot.nested.label = 'changed';
        return { outcome: 'passed' };
      }
    },
    {
      id: 'sees-original', mode: 'manual', nbrItems: ['5.1.2'],
      evaluate(viewSnapshot, viewContext) {
        assert.equal(viewSnapshot.nested.label, 'original');
        assert.deepEqual(viewSnapshot.nodes, [{ id: 1 }]);
        assert.equal(viewContext.preferences.locale, 'pt-BR');
        return { outcome: 'passed' };
      }
    }
  ]);

  const values = await runRules(snapshot, context, rules);

  assert.deepEqual(values.map(value => value.outcome), ['untested', 'passed']);
  assert.deepEqual(snapshot, { nested: { label: 'original' }, nodes: [{ id: 1 }] });
  assert.deepEqual(context.preferences, { locale: 'pt-BR' });
  assert.equal(Object.isFrozen(snapshot), false);
  assert.equal(Object.isFrozen(snapshot.nested), false);
  assert.equal(Object.isFrozen(context), false);
});

test('runRules and aggregateItems deeply detach JSON-safe evidence', async () => {
  const secret = 'token=never-report';
  const evidence = {
    nested: { entries: [{ score: 1n, optional: undefined, callback() {}, marker: Symbol('x') }] },
    error: new Error(secret)
  };
  evidence.self = evidence;
  Object.defineProperty(evidence, 'explosive', {
    enumerable: true,
    get() { throw new Error(secret); }
  });
  const rules = createRuleRegistry([{
    id: 'safe-evidence', mode: 'automated', nbrItems: ['safe-item'],
    evaluate() { return { outcome: 'failed', targets: [evidence] }; }
  }]);

  const [ruleResult] = await runRules({}, {}, rules);
  evidence.nested.entries[0].score = 9n;
  evidence.nested.entries.push({ score: 10n });
  const [itemResult] = aggregateItems([ruleResult], [item('safe-item', '', ['safe-evidence'])]);
  const ruleJson = JSON.stringify(ruleResult);
  const itemJson = JSON.stringify(itemResult);

  assert.equal(ruleResult.targets[0].nested.entries[0].score, '[bigint:1]');
  assert.equal(ruleResult.targets[0].explosive, '[unavailable]');
  assert.equal(ruleResult.targets[0].self, '[circular]');
  assert.equal(ruleResult.targets[0].error, '[error]');
  assert.equal(Object.isFrozen(ruleResult.targets[0].nested.entries[0]), true);
  assert.equal(itemResult.ruleResults[0].targets[0].nested.entries.length, 1);
  assert.doesNotMatch(ruleJson, new RegExp(secret));
  assert.doesNotMatch(itemJson, new RegExp(secret));
});

test('aggregateItems implements every ordered outcome pair with the same precedence', () => {
  const expected = {
    'passed/passed': 'passed', 'passed/failed': 'failed', 'passed/cantTell': 'cantTell', 'passed/inapplicable': 'passed', 'passed/untested': 'untested',
    'failed/passed': 'failed', 'failed/failed': 'failed', 'failed/cantTell': 'failed', 'failed/inapplicable': 'failed', 'failed/untested': 'failed',
    'cantTell/passed': 'cantTell', 'cantTell/failed': 'failed', 'cantTell/cantTell': 'cantTell', 'cantTell/inapplicable': 'cantTell', 'cantTell/untested': 'cantTell',
    'inapplicable/passed': 'passed', 'inapplicable/failed': 'failed', 'inapplicable/cantTell': 'cantTell', 'inapplicable/inapplicable': 'inapplicable', 'inapplicable/untested': 'untested',
    'untested/passed': 'untested', 'untested/failed': 'failed', 'untested/cantTell': 'cantTell', 'untested/inapplicable': 'untested', 'untested/untested': 'untested'
  };

  for (const first of OUTCOMES) {
    for (const second of OUTCOMES) {
      const id = `${first}-${second}`;
      const [value] = aggregateItems([
        result(`${id}-first`, first, [id]),
        result(`${id}-second`, second, [id])
      ], [item(id, '', [`${id}-first`, `${id}-second`])]);
      assert.equal(value.outcome, expected[`${first}/${second}`], `${first}/${second}`);
    }
  }
});
