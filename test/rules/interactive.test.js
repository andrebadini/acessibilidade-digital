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

test('allowed ARIA link/button replacements are evaluated by their exposed purpose, not failed twice', async () => {
  const page = snapshot([
    record('action', 'a', {attributes:{href:'#',role:'button'}, accessibleName:'Abrir opções'}),
    record('destination', 'button', {attributes:{role:'link'}, accessibleName:'Ajuda'})
  ]);
  assert.equal((await evaluate('link-semantics', page)).outcome, 'passed');
  assert.equal((await evaluate('button-semantics', page)).outcome, 'passed');
  assert.notEqual((await evaluate('link-purpose-in-context', page)).outcome, 'failed');
  assert.notEqual((await evaluate('button-purpose', page)).outcome, 'failed');
});

test('interactive rules declare exact ABNT, WCAG and mode metadata', () => {
  const expected = {
    'link-semantics': ['automated', ['5.7.1'], ['1.3.1']],
    'link-purpose-as-link': ['assisted', ['5.7.2'], ['1.3.1']],
    'link-purpose-without-context': ['assisted', ['5.7.3'], ['2.4.4', '2.4.9']],
    'link-purpose-in-context': ['assisted', ['5.7.4'], ['2.4.4']],
    'new-window-link-warning': ['assisted', ['5.7.6'], ['2.4.4', '2.4.9', '3.2.5']],
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
  assert.equal((await evaluate('button-semantics', snapshot([
    record('text-input', 'input')
  ]))).outcome, 'inapplicable');
  assert.equal((await evaluate('link-semantics', {})).outcome, 'cantTell');
});

test('valid role replacements are not misclassified as malformed links or buttons', async () => {
  for (const [tag, attributes, role, rule] of [
    ['button', { role: 'menuitem' }, 'menuitem', 'button-semantics'],
    ['button', { role: 'tab' }, 'tab', 'button-semantics'],
    ['input', { type: 'button', role: 'switch' }, 'switch', 'button-semantics'],
    ['a', { href: '/help', role: 'menuitem' }, 'menuitem', 'link-semantics']
  ]) {
    const value = snapshot([record('control', tag, { attributes, axRole: role, accessibleName: 'Ajuda' })]);
    assert.equal((await evaluate(rule, value)).outcome, 'inapplicable', `${tag}/${role}`);
  }
});

test('computed control roles are used when author role is absent', async () => {
  for (const role of ['button', 'link']) {
    const value = snapshot([record('control', 'x-control', { axRole: role, accessibleName: 'Ajuda' })]);
    assert.equal((await evaluate(`${role}-semantics`, value)).outcome, 'passed');
  }
});

test('AX-only components still receive name and custom semantics checks', async () => {
  const value = snapshot([record('control', 'x-control', { axRole: 'button', accessibleName: '', visibleText: 'Salvar' })]);
  assert.equal((await evaluate('accessible-component-name', value)).outcome, 'failed');
  assert.equal((await evaluate('visible-label-in-name', value)).outcome, 'failed');
  assert.equal((await evaluate('custom-component-semantics', value)).outcome, 'passed');
});

test('invalid native role replacements and roleless interactions remain failures', async () => {
  const value = snapshot([record('control', 'button', { attributes: { role: 'heading' }, axRole: 'heading' })]);
  assert.equal((await evaluate('button-semantics', value)).outcome, 'failed');
  assert.equal((await evaluate('button-semantics', snapshot([
    record('image', 'input', { attributes: { type: 'image', role: 'combobox' }, axRole: 'combobox' })
  ]))).outcome, 'failed');
});

test('digital publishing link roles retain valid link semantics and name checks', async () => {
  for (const role of ['doc-backlink', 'doc-biblioref', 'doc-glossref', 'doc-noteref']) {
    const value = snapshot([record('link', 'a', { attributes: { href: '#note', role }, axRole: role, accessibleName: '' })]);
    assert.equal((await evaluate('link-semantics', value)).outcome, 'passed');
    assert.equal((await evaluate('link-purpose-in-context', value)).outcome, 'failed');
  }
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

test('generic link names remain bounded review candidates for every structural context state', async () => {
  const cases = [
    ['missing-context', '  CLIQUE\u00a0AQUI  '],
    ['potential-context', 'Saiba mais'],
    ['unknown-context', 'VEJA   MAIS'],
  ];
  for (const [contextObservation, accessibleName] of cases) {
    const value = await evaluate('link-purpose-without-context', snapshot([
      record(`generic-${contextObservation}`, 'a', {
        attributes: { href: '/conta' }, role: 'link', accessibleName,
        linkPurposeContext: contextObservation,
      }),
    ]));
    assert.equal(value.outcome, 'cantTell', contextObservation);
    assert.equal(value.targets.length, 1, contextObservation);
    assert.deepEqual(value.targets[0].data, {
      reason: 'generic-link-purpose', contextObservation,
    });
    assert.doesNotMatch(JSON.stringify(value), /clique|saiba|veja|PRIVATE-CONTEXT/iu);
  }

  const meaningful = await evaluate('link-purpose-without-context', snapshot([
    record('meaningful', 'a', {
      attributes: { href: '/relatorio' }, role: 'link', accessibleName: 'Relatório anual',
      linkPurposeContext: 'missing-context',
    }),
  ]));
  assert.equal(meaningful.outcome, 'cantTell');
  assert.deepEqual(meaningful.targets, []);

  const missing = await evaluate('link-purpose-without-context', snapshot([
    record('missing', 'a', {
      attributes: { href: '/relatorio' }, role: 'link', accessibleName: '',
      linkPurposeContext: 'potential-context',
    }),
  ]));
  assert.equal(missing.outcome, 'failed');
  assert.equal(missing.targets[0].data.reason, 'missing-accessible-name');
});

test('new-window warning uses only explicit static or probe observations and never persists warning text', async () => {
  const link = overrides => record('new-window', 'a', {
    attributes: { href: '/ajuda', target: '_blank' }, role: 'link',
    accessibleName: 'Ajuda', adjacentNewWindowWarning: false, ...overrides,
  });

  assert.equal((await evaluate('new-window-link-warning', snapshot([
    link({ accessibleName: 'Ajuda (abre em nova aba)' }),
  ]))).outcome, 'passed');
  assert.equal((await evaluate('new-window-link-warning', snapshot([
    link({ adjacentNewWindowWarning: true }),
  ]))).outcome, 'passed');

  const failed = await evaluate('new-window-link-warning', snapshot([
    link({ attributes: { href: '/ajuda', target: '  _BLANK  ' } }),
  ]));
  assert.equal(failed.outcome, 'failed');
  assert.equal(failed.targets[0].data.reason, 'missing-new-window-warning');
  assert.equal(failed.targets[0].data.behavior, 'target-blank');
  assert.doesNotMatch(JSON.stringify(failed), /Ajuda|PRIVATE-ADJACENT/iu);

  const unknownName = link();
  delete unknownName.accessibleName;
  assert.equal((await evaluate('new-window-link-warning', snapshot([unknownName]))).outcome, 'cantTell');
  const unknownAdjacent = link();
  delete unknownAdjacent.adjacentNewWindowWarning;
  assert.equal((await evaluate('new-window-link-warning', snapshot([unknownAdjacent]))).outcome, 'cantTell');

  const observedNewWindow = await evaluate('new-window-link-warning', snapshot([
    link({ attributes: { href: '/ajuda' }, newWindowBehavior: 'new-window' }),
  ]));
  assert.equal(observedNewWindow.outcome, 'failed');
  assert.equal(observedNewWindow.targets[0].data.behavior, 'observed-new-window');
  assert.equal((await evaluate('new-window-link-warning', snapshot([
    link({ attributes: { href: '/ajuda' }, newWindowBehavior: 'unknown' }),
  ]))).outcome, 'cantTell');
  assert.equal((await evaluate('new-window-link-warning', snapshot([
    link({ attributes: { href: '/ajuda' }, newWindowBehavior: 'same-window' }),
  ]))).outcome, 'inapplicable');
  assert.equal((await evaluate('new-window-link-warning', snapshot([
    link({ attributes: { href: '/ajuda' } }),
  ]))).outcome, 'inapplicable');
  assert.equal((await evaluate('new-window-link-warning', snapshot())).outcome, 'inapplicable');
});

test('contextual link observations never execute hostile accessors', async () => {
  let reads = 0;
  const hostile = record('hostile', 'a', { attributes: { href: '/ajuda' }, role: 'link' });
  Object.defineProperties(hostile, {
    accessibleName: { enumerable: true, get() { reads += 1; return 'PRIVATE-NAME'; } },
    linkPurposeContext: { enumerable: true, get() { reads += 1; return 'potential-context'; } },
    adjacentNewWindowWarning: { enumerable: true, get() { reads += 1; return true; } },
  });
  const result = await evaluate('link-purpose-without-context', snapshot([hostile]));
  assert.equal(reads, 0);
  assert.equal(result.outcome, 'cantTell');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE-NAME/u);
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
  assert.equal((await evaluate('visible-label-in-name', snapshot([
    record('punctuation', 'button', { role: 'button', visibleText: 'Salvar!', accessibleName: 'Salvar' }),
    record('accent', 'button', { role: 'button', visibleText: 'Ação…', accessibleName: 'Executar AÇÃO' })
  ]))).outcome, 'passed');
  assert.equal((await evaluate('visible-label-in-name', snapshot([
    record('symbols-only', 'button', { role: 'button', visibleText: '!!!', accessibleName: 'Abrir' })
  ]))).outcome, 'cantTell');
  assert.equal((await evaluate('visible-label-in-name', snapshot())).outcome, 'inapplicable');
  const unknown = record('unknown', 'button', { role: 'button', visibleText: 'Enviar' });
  delete unknown.accessibleName;
  assert.equal((await evaluate('visible-label-in-name', snapshot([unknown]))).outcome, 'cantTell');
});

test('accessible component name preserves all 257 failed targets in document order', async () => {
  const nodes = Array.from({ length: 257 }, (_, index) => record(`control-${index + 1}`, 'button', {
    role: 'button', accessibleName: ''
  }));
  const failed = await evaluate('accessible-component-name', snapshot(nodes));

  assert.equal(failed.outcome, 'failed');
  assert.equal(failed.targets.length, 257);
  assert.deepEqual(failed.targets.map(target => target.nodeId), nodes.map(node => node.nodeId));
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
  ]))).outcome, 'cantTell');
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

test('custom semantics rejects unknown, abstract, presentational and incompatible roles', async () => {
  const abstractRoles = [
    'widget', 'command', 'composite', 'input', 'landmark', 'range', 'roletype',
    'section', 'sectionhead', 'select', 'structure', 'window'
  ];
  const nodes = [
    record('unknown', 'x-control', { customElement: true, interactive: true, role: 'made-up' }),
    ...abstractRoles.map(role => record(`abstract-${role}`, 'x-control', {
      customElement: true, interactive: true, role
    })),
    record('none', 'x-control', { customElement: true, interactive: true, role: 'none' }),
    record('presentation', 'x-control', { customElement: true, interactive: true, role: 'presentation' }),
    record('article', 'x-control', { customElement: true, interactive: true, role: 'article' }),
    record('wrong-interaction', 'x-control', { customElement: true, interaction: 'button', role: 'link' })
  ];

  const value = await evaluate('custom-component-semantics', snapshot(nodes));
  assert.equal(value.outcome, 'failed');
  assert.deepEqual(value.targets.map(target => target.nodeId), nodes.map(node => node.nodeId));
});

test('custom semantics passes compatible widget roles and reviews insufficient compatibility data', async () => {
  assert.equal((await evaluate('custom-component-semantics', snapshot([
    record('button', 'x-button', { customElement: true, interactive: true, role: 'button' }),
    record('checkbox', 'x-checkbox', { customElement: true, interactive: true, role: 'checkbox' })
  ]))).outcome, 'passed');

  assert.equal((await evaluate('custom-component-semantics', snapshot([
    record('unknown-interactivity', 'x-button', { customElement: true, role: 'button' })
  ]))).outcome, 'cantTell');
});
