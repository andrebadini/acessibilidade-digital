import test from 'node:test';
import assert from 'node:assert/strict';

import { runRules } from '../../src/core/rules/run-rules.js';
import { INTERACTIVE_RULES } from '../../src/core/rules/interactive.js';

function record(nodeId, tagName, overrides = {}) {
  return {
    nodeId,
    tagName,
    attributes: {},
    text: '',
    children: [],
    parentId: null,
    hidden: false,
    selectorHint: `#${nodeId}`,
    role: '',
    accessibleName: '',
    visibleText: '',
    ...overrides
  };
}

function snapshot(nodes = []) {
  const document = { nodeId: 'document', title: 'Página', language: 'pt-BR', statusMessageNodeIds: [] };
  return {
    document,
    nodes,
    byId: Object.fromEntries([['document', document], ...nodes.map(node => [String(node.nodeId), node])])
  };
}

async function evaluate(ruleId, value) {
  const rule = INTERACTIVE_RULES.find(candidate => candidate.id === ruleId);
  assert.ok(rule, `Regra ausente: ${ruleId}`);
  return (await runRules(value, {}, [rule]))[0];
}

function assertEvidence(target) {
  assert.deepEqual(Object.keys(target).sort(), ['data', 'message', 'nodeId', 'selectorHint']);
  assert.doesNotThrow(() => JSON.stringify(target));
}

test('interactive rules declare exact ABNT, WCAG and mode metadata', () => {
  const expected = {
    'link-semantics': ['automated', ['5.7.1'], ['1.3.1']],
    'link-purpose-as-link': ['assisted', ['5.7.2'], ['1.3.1']],
    'link-purpose-without-context': ['assisted', ['5.7.3'], ['2.4.4', '2.4.9']],
    'link-purpose-in-context': ['assisted', ['5.7.4'], ['2.4.4']],
    'button-semantics': ['automated', ['5.8.1'], ['1.3.1']],
    'button-purpose-as-button': ['assisted', ['5.8.2'], ['1.3.1']],
    'button-purpose': ['assisted', ['5.8.3'], ['4.1.2', '2.4.6']],
    'visible-label-in-name': ['automated', ['5.13.7'], ['2.5.3']],
    'accessible-component-name': ['automated', ['5.13.10'], ['4.1.2']],
    'native-elements': ['assisted', ['5.13.11'], ['1.3.1']],
    'custom-component-semantics': ['automated', ['5.13.12'], ['1.3.1', '4.1.2']]
  };
  assert.deepEqual(
    Object.fromEntries(INTERACTIVE_RULES.map(rule => [
      rule.id, [rule.mode, [...rule.nbrItems], [...rule.wcag]]
    ])),
    expected
  );
});

test('link and button semantics fail every observed interaction lacking its role', async () => {
  const value = snapshot([
    record('bad-link-1', 'div', { interaction: 'link', navigationTarget: '/conta', focusable: true }),
    record('good-link', 'a', { attributes: { href: '/ajuda' }, role: 'link', accessibleName: 'Ajuda' }),
    record('bad-link-2', 'span', { interaction: 'link', navigationTarget: '/sair', focusable: true }),
    record('bad-button-1', 'div', { interaction: 'button', eventNames: ['click'], focusable: true }),
    record('good-button', 'button', { role: 'button', accessibleName: 'Salvar' }),
    record('bad-button-2', 'span', { interaction: 'button', eventNames: ['click'], focusable: true })
  ]);
  const links = await evaluate('link-semantics', value);
  const buttons = await evaluate('button-semantics', value);

  assert.equal(links.outcome, 'failed');
  assert.deepEqual(links.targets.map(target => target.nodeId), ['bad-link-1', 'bad-link-2']);
  assert.equal(buttons.outcome, 'failed');
  assert.deepEqual(buttons.targets.map(target => target.nodeId), ['bad-button-1', 'bad-button-2']);
  [...links.targets, ...buttons.targets].forEach(assertEvidence);

  assert.equal((await evaluate('link-semantics', snapshot([
    record('link', 'a', { attributes: { href: '/ajuda' }, role: 'link' })
  ]))).outcome, 'passed');
  assert.equal((await evaluate('button-semantics', snapshot([
    record('button', 'button', { role: 'button' })
  ]))).outcome, 'passed');
  assert.equal((await evaluate('link-semantics', snapshot())).outcome, 'inapplicable');
  assert.equal((await evaluate('button-semantics', snapshot())).outcome, 'inapplicable');
  assert.equal((await evaluate('link-semantics', {})).outcome, 'cantTell');
});

test('assisted link and button purpose rules reject objective missing semantics or names without approving quality', async () => {
  const namelessLink = snapshot([
    record('link', 'a', { attributes: { href: '/produto' }, role: 'link', accessibleName: '' })
  ]);
  const namedLink = snapshot([
    record('link', 'a', { attributes: { href: '/produto' }, role: 'link', accessibleName: 'Detalhes' })
  ]);
  const namelessButton = snapshot([
    record('button', 'button', { role: 'button', accessibleName: '' })
  ]);
  const namedButton = snapshot([
    record('button', 'button', { role: 'button', accessibleName: 'Continuar' })
  ]);

  for (const ruleId of ['link-purpose-as-link', 'link-purpose-without-context', 'link-purpose-in-context']) {
    assert.equal((await evaluate(ruleId, namelessLink)).outcome, 'failed');
    assert.equal((await evaluate(ruleId, namedLink)).outcome, 'cantTell');
    assert.equal((await evaluate(ruleId, snapshot())).outcome, 'inapplicable');
  }
  for (const ruleId of ['button-purpose-as-button', 'button-purpose']) {
    assert.equal((await evaluate(ruleId, namelessButton)).outcome, 'failed');
    assert.equal((await evaluate(ruleId, namedButton)).outcome, 'cantTell');
    assert.equal((await evaluate(ruleId, snapshot())).outcome, 'inapplicable');
  }
});

test('accessible component name reports all unnamed components and missing input as cantTell', async () => {
  const failed = await evaluate('accessible-component-name', snapshot([
    record('a', 'a', { attributes: { href: '/a' }, role: 'link', accessibleName: '' }),
    record('ok', 'button', { role: 'button', accessibleName: 'Salvar' }),
    record('b', 'input', { attributes: { type: 'text' }, role: 'textbox', accessibleName: '' })
  ]));
  assert.equal(failed.outcome, 'failed');
  assert.deepEqual(failed.targets.map(target => target.nodeId), ['a', 'b']);
  failed.targets.forEach(assertEvidence);

  assert.equal((await evaluate('accessible-component-name', snapshot([
    record('ok', 'button', { role: 'button', accessibleName: 'Salvar' })
  ]))).outcome, 'passed');
  assert.equal((await evaluate('accessible-component-name', snapshot())).outcome, 'inapplicable');
  const missingName = record('unknown', 'button', { role: 'button' });
  delete missingName.accessibleName;
  assert.equal((await evaluate('accessible-component-name', snapshot([missingName]))).outcome, 'cantTell');
});

test('duplicate or broken aria-labelledby IDREF fails the affected component without leaking label text', async () => {
  const failed = await evaluate('accessible-component-name', snapshot([
    record('label-1', 'span', { attributes: { id: 'duplicate' }, text: 'Conta corrente' }),
    record('label-2', 'span', { attributes: { id: 'duplicate' }, text: 'Saldo sigiloso' }),
    record('ambiguous', 'button', {
      attributes: { 'aria-labelledby': 'duplicate' }, role: 'button', accessibleName: 'Conta'
    }),
    record('missing', 'button', {
      attributes: { 'aria-labelledby': 'absent' }, role: 'button', accessibleName: 'Outra'
    })
  ]));

  assert.equal(failed.outcome, 'failed');
  assert.deepEqual(failed.targets.map(target => target.nodeId), ['ambiguous', 'missing']);
  assert.deepEqual(failed.targets.map(target => target.data.reason), [
    'ambiguous-idref', 'missing-idref'
  ]);
  assert.doesNotMatch(JSON.stringify(failed.targets), /Saldo sigiloso|Conta corrente/);
});

test('visible label in name uses conservative Unicode, case and whitespace normalization and returns every failure', async () => {
  const failed = await evaluate('visible-label-in-name', snapshot([
    record('ok', 'button', { role: 'button', visibleText: '  SALVAR pedido ', accessibleName: 'Salvar pedido agora' }),
    record('bad-1', 'button', { role: 'button', visibleText: 'Cancelar', accessibleName: 'Fechar' }),
    record('bad-2', 'a', { attributes: { href: '/' }, role: 'link', visibleText: 'Início', accessibleName: 'Página principal' })
  ]));

  assert.equal(failed.outcome, 'failed');
  assert.deepEqual(failed.targets.map(target => target.nodeId), ['bad-1', 'bad-2']);
  assert.ok(failed.targets.every(target => target.data.reason === 'visible-label-not-in-name'));
  assert.doesNotMatch(JSON.stringify(failed.targets), /Cancelar|Fechar|Início|principal/);
  assert.equal((await evaluate('visible-label-in-name', snapshot([
    record('ok', 'button', { role: 'button', visibleText: 'Cafe\u0301', accessibleName: 'CAFÉ especial' })
  ]))).outcome, 'passed');
  assert.equal((await evaluate('visible-label-in-name', snapshot())).outcome, 'inapplicable');
  const unknown = record('unknown', 'button', { role: 'button', visibleText: 'Enviar' });
  delete unknown.accessibleName;
  assert.equal((await evaluate('visible-label-in-name', snapshot([unknown]))).outcome, 'cantTell');
});

test('native element review and custom semantics distinguish observable native and custom controls', async () => {
  assert.equal((await evaluate('native-elements', snapshot([
    record('native', 'button', { role: 'button', interaction: 'button' })
  ]))).outcome, 'passed');
  assert.equal((await evaluate('native-elements', snapshot([
    record('custom', 'x-save', { role: 'button', interaction: 'button', customElement: true })
  ]))).outcome, 'cantTell');
  assert.equal((await evaluate('native-elements', snapshot())).outcome, 'inapplicable');

  const failed = await evaluate('custom-component-semantics', snapshot([
    record('bad', 'x-save', { interaction: 'button', customElement: true, role: '' }),
    record('good', 'x-link', { interaction: 'link', customElement: true, role: 'link', accessibleName: 'Conta' })
  ]));
  assert.equal(failed.outcome, 'failed');
  assert.deepEqual(failed.targets.map(target => target.nodeId), ['bad']);
  assert.equal((await evaluate('custom-component-semantics', snapshot([
    record('good', 'x-link', { interaction: 'link', customElement: true, role: 'link', accessibleName: 'Conta' })
  ]))).outcome, 'passed');
  assert.equal((await evaluate('custom-component-semantics', snapshot([
    record('aria-button', 'div', { role: 'button', accessibleName: 'Abrir' })
  ]))).outcome, 'passed');
  assert.equal((await evaluate('custom-component-semantics', snapshot())).outcome, 'inapplicable');
});

test('invalid aria reference on a custom component is mapped to its declared semantics rule', async () => {
  const failed = await evaluate('custom-component-semantics', snapshot([
    record('custom', 'x-menu', {
      attributes: { 'aria-controls': 'missing-panel' },
      interaction: 'button',
      customElement: true,
      role: 'button',
      accessibleName: 'Menu'
    })
  ]));

  assert.equal(failed.outcome, 'failed');
  assert.equal(failed.targets[0].data.attribute, 'aria-controls');
  assert.equal(failed.targets[0].data.reason, 'missing-idref');
});
