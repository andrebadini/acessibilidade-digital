import test from 'node:test';
import assert from 'node:assert/strict';

import { runRules } from '../../src/core/rules/run-rules.js';
import { STRUCTURE_RULES } from '../../src/core/rules/structure.js';
import { validateCoreRuleTargetInventory } from '../../src/core/report/remediation-policy.js';

function record(nodeId, tagName, overrides = {}) {
  return {
    nodeId,
    tagName,
    attributes: {},
    text: '',
    children: [],
    parentId: null,
    hidden: false,
    selectorHint: `${tagName}:nth-of-type(1)`,
    role: '',
    accessibleName: '',
    visibleText: '',
    ...overrides
  };
}

function snapshot(nodes = [], document = {}) {
  const normalizedDocument = {
    nodeId: 'document',
    title: 'Portal de serviços',
    language: 'pt-BR',
    statusMessageNodeIds: [],
    ...document
  };
  return {
    document: normalizedDocument,
    nodes,
    byId: Object.fromEntries([
      [normalizedDocument.nodeId, normalizedDocument],
      ...nodes.map(node => [String(node.nodeId), node])
    ])
  };
}

async function evaluate(ruleId, value) {
  const rule = STRUCTURE_RULES.find(candidate => candidate.id === ruleId);
  assert.ok(rule, `Regra ausente: ${ruleId}`);
  return (await runRules(value, {}, [rule]))[0];
}

function assertEvidence(target) {
  assert.deepEqual(Object.keys(target).sort(), ['data', 'message', 'nodeId', 'selectorHint']);
  assert.equal(typeof target.message, 'string');
  assert.doesNotThrow(() => JSON.stringify(target));
}

test('defines a pure JSON-safe normalized snapshot compatible with later CDP collection', () => {
  const button = record('button-1', 'button', {
    attributes: { id: 'save', type: 'button' },
    text: 'Salvar',
    parentId: 'main-1',
    selectorHint: '#save',
    role: 'button',
    accessibleName: 'Salvar',
    visibleText: 'Salvar',
    focusable: true,
    eventNames: ['click']
  });
  const value = snapshot([button]);

  assert.equal(JSON.parse(JSON.stringify(value)).byId['button-1'].accessibleName, 'Salvar');
  assert.deepEqual(Object.keys(value), ['document', 'nodes', 'byId']);
  assert.deepEqual(value.nodes[0], button);
});

test('structure rules declare only their exact ABNT and WCAG links and normative modes', () => {
  const expected = {
    'page-title': ['assisted', ['5.13.1'], ['2.4.2']],
    'page-language': ['assisted', ['5.13.2'], ['3.1.1']],
    'part-language': ['assisted', ['5.13.3'], ['3.1.2']],
    'frame-title': ['assisted', ['5.13.4'], ['1.3.1', '4.1.2']],
    'heading-semantics': ['automated', ['5.3.1'], ['1.3.1']],
    'main-heading': ['assisted', ['5.3.3'], ['2.4.6', '2.4.10']],
    'section-headings': ['assisted', ['5.3.4'], ['2.4.10']],
    'heading-order': ['assisted', ['5.3.5'], ['1.3.1', '2.4.6', '2.4.10']],
    'landmark-semantics': ['automated', ['5.4.1'], ['1.3.1', '1.3.6']],
    'unique-landmarks': ['automated', ['5.4.4'], ['1.3.1', '1.3.6']],
    'landmark-unique-names': ['automated', ['5.4.5'], ['1.3.1', '4.1.2']],
    'list-semantics': ['automated', ['5.5.1'], ['1.3.1']],
    'table-semantics': ['automated', ['5.6.1'], ['1.3.1']],
    'table-headers': ['assisted', ['5.6.3'], ['1.3.1']]
  };

  assert.deepEqual(
    Object.fromEntries(STRUCTURE_RULES.map(rule => [
      rule.id, [rule.mode, [...rule.nbrItems], [...rule.wcag]]
    ])),
    expected
  );
});

test('page title and language fail objectively invalid declarations but do not approve content quality', async () => {
  const missingTitle = await evaluate('page-title', snapshot([], { title: '' }));
  const presentTitle = await evaluate('page-title', snapshot());
  const invalidLanguage = await evaluate('page-language', snapshot([], { language: 'pt_BR' }));
  const validLanguage = await evaluate('page-language', snapshot());

  assert.equal(missingTitle.outcome, 'failed');
  assert.equal(presentTitle.outcome, 'cantTell');
  assert.equal(invalidLanguage.outcome, 'failed');
  assert.equal(validLanguage.outcome, 'cantTell');
  assert.equal((await evaluate('page-language', snapshot([], { language: 'x-private' }))).outcome, 'cantTell');
  assert.equal((await evaluate('page-language', snapshot([], { language: 'i-klingon' }))).outcome, 'cantTell');
  assertEvidence(missingTitle.targets[0]);
  assert.equal((await evaluate('page-title', {})).outcome, 'cantTell');
  assert.equal((await evaluate('page-language', {})).outcome, 'cantTell');
});

test('part language validates every explicit part tag in document order', async () => {
  const value = snapshot([
    record('p1', 'p', { attributes: { lang: 'en-US' }, selectorHint: '#first' }),
    record('p2', 'p', { attributes: { lang: 'pt_BR' }, selectorHint: '#second' }),
    record('p3', 'span', { attributes: { lang: 'x invalid' }, selectorHint: '#third' })
  ]);
  const failed = await evaluate('part-language', value);

  assert.equal(failed.outcome, 'failed');
  assert.deepEqual(failed.targets.map(target => target.nodeId), ['p2', 'p3']);
  failed.targets.forEach(assertEvidence);
  assert.equal((await evaluate('part-language', snapshot([
    record('p1', 'p', { attributes: { lang: 'en-US' } })
  ]))).outcome, 'cantTell');
  assert.equal((await evaluate('part-language', snapshot())).outcome, 'inapplicable');
  assert.equal((await evaluate('part-language', { document: {}, nodes: [] })).outcome, 'cantTell');
});

test('frame title reports every untitled frame and treats named frames as assisted review', async () => {
  const failed = await evaluate('frame-title', snapshot([
    record('f1', 'iframe', { selectorHint: '#one', attributes: { title: '' } }),
    record('f2', 'frame', { selectorHint: '#two' }),
    record('f3', 'iframe', { attributes: { title: 'Pagamento' }, accessibleName: 'Pagamento' })
  ]));

  assert.equal(failed.outcome, 'failed');
  assert.deepEqual(failed.targets.map(target => target.nodeId), ['f1', 'f2']);
  assert.equal((await evaluate('frame-title', snapshot([
    record('f3', 'iframe', { attributes: { title: 'Pagamento' }, accessibleName: 'Pagamento' })
  ]))).outcome, 'cantTell');
  assert.equal((await evaluate('frame-title', snapshot())).outcome, 'inapplicable');
});

test('heading semantics validates native and ARIA levels without guessing absent node data', async () => {
  const failed = await evaluate('heading-semantics', snapshot([
    record('h1', 'h1', { role: 'heading', headingLevel: 1 }),
    record('bad', 'div', { role: 'heading', selectorHint: '#bad' })
  ]));
  assert.equal(failed.outcome, 'failed');
  assert.deepEqual(failed.targets.map(target => target.nodeId), ['bad']);
  assert.equal((await evaluate('heading-semantics', snapshot([
    record('h2', 'h2', { role: 'heading', headingLevel: 2 })
  ]))).outcome, 'passed');
  assert.equal((await evaluate('heading-semantics', snapshot())).outcome, 'inapplicable');
  assert.equal((await evaluate('heading-semantics', snapshot([
    record('h', 'h2', { role: 'heading' })
  ]))).outcome, 'cantTell');
});

test('heading order reports every upward level skip under the ABNT-specific rule', async () => {
  const failed = await evaluate('heading-order', snapshot([
    record('h1', 'h1', { role: 'heading', headingLevel: 1 }),
    record('h3', 'h3', { role: 'heading', headingLevel: 3 }),
    record('h2', 'h2', { role: 'heading', headingLevel: 2 }),
    record('h4', 'h4', { role: 'heading', headingLevel: 4 })
  ]));
  assert.equal(failed.outcome, 'failed');
  assert.deepEqual(failed.targets.map(target => target.nodeId), ['h3', 'h4']);
  assert.equal((await evaluate('heading-order', snapshot([
    record('h1', 'h1', { role: 'heading', headingLevel: 1 }),
    record('h2', 'h2', { role: 'heading', headingLevel: 2 })
  ]))).outcome, 'cantTell');
  assert.equal((await evaluate('heading-order', snapshot([
    record('h1', 'h1', { role: 'heading', headingLevel: 1 })
  ]))).outcome, 'inapplicable');
});

test('main and section heading candidates fail only when absence is observable', async () => {
  const nodes = [
    record('main', 'main', { role: 'main', children: ['copy'] }),
    record('copy', 'p', { parentId: 'main', text: 'Conteúdo' }),
    record('section', 'section', { children: ['section-copy'] }),
    record('section-copy', 'p', { parentId: 'section', text: 'Detalhes' })
  ];
  assert.equal((await evaluate('main-heading', snapshot(nodes))).outcome, 'failed');
  assert.equal((await evaluate('section-headings', snapshot(nodes))).outcome, 'failed');

  const withHeadings = snapshot([
    record('main', 'main', { role: 'main', children: ['h1'] }),
    record('h1', 'h1', { parentId: 'main', role: 'heading', headingLevel: 1 }),
    record('section', 'section', { children: ['h2'] }),
    record('h2', 'h2', { parentId: 'section', role: 'heading', headingLevel: 2 })
  ]);
  assert.equal((await evaluate('main-heading', withHeadings)).outcome, 'cantTell');
  assert.equal((await evaluate('section-headings', withHeadings)).outcome, 'cantTell');
  assert.equal((await evaluate('main-heading', snapshot())).outcome, 'cantTell');
  assert.equal((await evaluate('section-headings', snapshot())).outcome, 'inapplicable');
});

test('main heading recommendation applies to pages without a native main container', async () => {
  assert.equal((await evaluate('main-heading', snapshot([record('body', 'body')]))).outcome, 'failed');
  assert.equal((await evaluate('main-heading', snapshot([
    record('heading', 'h1', { role: 'heading', headingLevel: 1 })
  ]))).outcome, 'cantTell');
  const duplicate = await evaluate('main-heading', snapshot([
    record('first', 'h1', { role: 'heading', headingLevel: 1 }),
    record('second', 'div', { role: 'heading', headingLevel: 1 })
  ]));
  assert.equal(duplicate.outcome, 'failed');
  assert.equal(duplicate.targets.length, 2);
  // Página com dois h1 é comum; até a 1.1.55 o motivo não estava no catálogo fechado e a auditoria
  // inteira era descartada no fim ("encerrada antes de concluir").
  assert.equal(validateCoreRuleTargetInventory('main-heading', duplicate.outcome,
    duplicate.targets.map(({ selectorHint, ...target }) => target)), true,
  'o relatório precisa aceitar os alvos de cabeçalho principal duplicado');
  assert.equal((await evaluate('main-heading', snapshot([
    record('first', 'h1', { role: 'heading', headingLevel: 1 }),
    record('hidden', 'h1', { role: 'heading', headingLevel: 1, hidden: true })
  ]))).outcome, 'cantTell');
});

test('missing heading levels cannot prove absence of the main heading', async () => {
  assert.equal((await evaluate('main-heading', snapshot([
    record('heading', 'h1', { role: 'heading' })
  ]))).outcome, 'cantTell');
});

test('main heading counts only the outer document, not embedded documents', async () => {
  const outer = record('outer', 'h1', { axRole: 'heading', headingLevel: 1, frameId: 'main', framePath: [] });
  const inner = record('inner', 'h1', { axRole: 'heading', headingLevel: 1, frameId: 'child', framePath: ['frame'] });
  assert.equal((await evaluate('main-heading', snapshot([outer, inner]))).outcome, 'cantTell');
  const missing = await evaluate('main-heading', snapshot([record('body', 'body', { frameId: 'main', framePath: [] }), inner]));
  assert.equal(missing.outcome, 'failed');
  assert.equal(missing.targets[0].data.reason, 'missing-main-heading');
});

test('ARIA ownership associates a listitem with a list only within its document', async () => {
  const owner = record('list', 'div', { axRole: 'list', attributes: { 'aria-owns': 'entry' }, frameId: 'main' });
  const item = record('item', 'div', { axRole: 'listitem', attributes: { id: 'entry' }, frameId: 'main' });
  assert.equal((await evaluate('list-semantics', snapshot([owner, item]))).outcome, 'passed');
  assert.equal((await evaluate('list-semantics', snapshot([owner, { ...item, frameId: 'child', framePath: ['frame'] }]))).outcome, 'failed');
  assert.equal((await evaluate('list-semantics', snapshot([{ ...owner, hidden: true }, item]))).outcome, 'failed');
});

test('ambiguous ARIA ownership is inconclusive rather than approved', async () => {
  const owner = record('list', 'div', { axRole: 'list', attributes: { 'aria-owns': 'entry' } });
  const item = record('item', 'div', { axRole: 'listitem', attributes: { id: 'entry' } });
  assert.equal((await evaluate('list-semantics', snapshot([owner, item,
    record('duplicate', 'div', { attributes: { id: 'entry' } })
  ]))).outcome, 'cantTell');
  assert.equal((await evaluate('list-semantics', snapshot([owner, item,
    { ...owner, nodeId: 'second-owner' }
  ]))).outcome, 'cantTell');
});

test('landmark rules cover semantics, duplicate unique regions and repeated names', async () => {
  const semanticFailure = await evaluate('landmark-semantics', snapshot([
    record('main', 'main', { role: 'none' }),
    record('nav', 'nav', { role: 'navigation' })
  ]));
  assert.equal(semanticFailure.outcome, 'failed');
  assert.deepEqual(semanticFailure.targets.map(target => target.nodeId), ['main']);
  assert.equal((await evaluate('landmark-semantics', snapshot([
    record('nav', 'nav', { role: 'navigation' })
  ]))).outcome, 'passed');
  assert.equal((await evaluate('landmark-semantics', snapshot())).outcome, 'inapplicable');

  const duplicateMain = await evaluate('unique-landmarks', snapshot([
    record('m1', 'main', { role: 'main' }),
    record('m2', 'main', { role: 'main' })
  ]));
  assert.equal(duplicateMain.outcome, 'failed');
  assert.deepEqual(duplicateMain.targets.map(target => target.nodeId), ['m1', 'm2']);
  assert.equal((await evaluate('unique-landmarks', snapshot([
    record('m1', 'main', { role: 'main' })
  ]))).outcome, 'passed');
  assert.equal((await evaluate('unique-landmarks', snapshot())).outcome, 'inapplicable');

  const duplicateNames = await evaluate('landmark-unique-names', snapshot([
    record('n1', 'nav', { role: 'navigation', accessibleName: 'Menu' }),
    record('n2', 'nav', { role: 'navigation', accessibleName: ' menu ' })
  ]));
  assert.equal(duplicateNames.outcome, 'failed');
  assert.deepEqual(duplicateNames.targets.map(target => target.nodeId), ['n1', 'n2']);
  assert.equal((await evaluate('landmark-unique-names', snapshot([
    record('n1', 'nav', { role: 'navigation', accessibleName: 'Principal' }),
    record('n2', 'nav', { role: 'navigation', accessibleName: 'Rodapé' })
  ]))).outcome, 'passed');

  const missingComputedRole = snapshot([record('main', 'main')]);
  assert.equal((await evaluate('unique-landmarks', missingComputedRole)).outcome, 'cantTell');
  assert.equal((await evaluate('landmark-unique-names', missingComputedRole)).outcome, 'cantTell');
});

test('list semantics detects list items outside a list and passes an observable list tree', async () => {
  const failed = await evaluate('list-semantics', snapshot([
    record('container', 'div'),
    record('bad', 'li', { parentId: 'container' })
  ]));
  assert.equal(failed.outcome, 'failed');
  assert.deepEqual(failed.targets.map(target => target.nodeId), ['bad']);
  assert.equal((await evaluate('list-semantics', snapshot([
    record('list', 'ul', { role: 'list', children: ['item'] }),
    record('item', 'li', { role: 'listitem', parentId: 'list' })
  ]))).outcome, 'passed');
  assert.equal((await evaluate('list-semantics', snapshot())).outcome, 'inapplicable');
  assert.equal((await evaluate('list-semantics', snapshot([
    record('hidden', 'div', { hidden: true, role: 'list' })
  ]))).outcome, 'inapplicable');
  assert.equal((await evaluate('list-semantics', snapshot([
    record('item', 'li', { role: 'listitem', parentId: 'missing' })
  ]))).outcome, 'cantTell');
  assert.equal((await evaluate('list-semantics', snapshot([
    record('list', 'ul', { role: 'list', children: ['item'] }),
    record('item', 'li', { role: 'presentation', parentId: 'list' })
  ]))).outcome, 'failed');
});

test('ARIA menu is evaluated as a custom component, not rejected as a native list', async () => {
  const value = snapshot([
    record('menu', 'ul', { attributes: { role: 'menu' }, axRole: 'menu', children: ['action'] }),
    record('action', 'li', { attributes: { role: 'menuitem' }, axRole: 'menuitem', parentId: 'menu' })
  ]);
  assert.equal((await evaluate('list-semantics', value)).outcome, 'inapplicable');
});

test('native listitem inside a menu cannot borrow the overridden ul list semantics', async () => {
  const value = snapshot([
    record('menu', 'ul', { role: 'menu', children: ['item'] }),
    record('item', 'li', { role: 'listitem', parentId: 'menu' })
  ]);
  const result = await evaluate('list-semantics', value);
  assert.equal(result.outcome, 'failed');
  assert.deepEqual(result.targets.map(t => t.nodeId), ['item']);
});

test('computed list roles are preserved even when the author did not use list tags', async () => {
  const value = snapshot([
    record('list', 'div', { axRole: 'list', children: ['item'] }),
    record('item', 'div', { axRole: 'listitem', parentId: 'list' })
  ]);
  assert.equal((await evaluate('list-semantics', value)).outcome, 'passed');
});

test('table semantics and header association report invalid, missing and ambiguous structures', async () => {
  const semanticFailure = await evaluate('table-semantics', snapshot([
    record('outside', 'div'),
    record('bad-cell', 'td', { role: 'cell', parentId: 'outside' })
  ]));
  assert.equal(semanticFailure.outcome, 'failed');
  assert.deepEqual(semanticFailure.targets.map(target => target.nodeId), ['bad-cell']);

  const validTable = snapshot([
    record('table', 'table', { role: 'table', children: ['row'] }),
    record('row', 'tr', { role: 'row', parentId: 'table', children: ['head', 'cell'] }),
    record('head', 'th', { role: 'columnheader', parentId: 'row', attributes: { id: 'amount' } }),
    record('cell', 'td', { role: 'cell', parentId: 'row', attributes: { headers: 'amount' } })
  ]);
  assert.equal((await evaluate('table-semantics', validTable)).outcome, 'passed');
  assert.equal((await evaluate('table-semantics', snapshot())).outcome, 'inapplicable');
  assert.equal((await evaluate('table-headers', validTable)).outcome, 'passed');

  const invalidHeaders = await evaluate('table-headers', snapshot([
    record('table', 'table', { role: 'table' }),
    record('row', 'tr', { role: 'row', parentId: 'table' }),
    record('head1', 'th', { role: 'columnheader', parentId: 'row', attributes: { id: 'dup' } }),
    record('head2', 'th', { role: 'columnheader', parentId: 'row', attributes: { id: 'dup' } }),
    record('missing', 'td', { role: 'cell', parentId: 'row', attributes: { headers: 'absent' } }),
    record('ambiguous', 'td', { role: 'cell', parentId: 'row', attributes: { headers: 'dup' } })
  ]));
  assert.equal(invalidHeaders.outcome, 'failed');
  assert.deepEqual(invalidHeaders.targets.map(target => target.nodeId), ['missing', 'ambiguous']);
  assert.equal((await evaluate('table-headers', snapshot())).outcome, 'inapplicable');
  assert.equal((await evaluate('table-headers', snapshot([
    record('table', 'table', { role: 'table' }),
    record('row', 'tr', { role: 'row', parentId: 'table' }),
    record('cell', 'td', { role: 'cell', parentId: 'row' })
  ]))).outcome, 'cantTell');

  for (const suppressedRole of ['none', 'presentation']) {
    assert.equal((await evaluate('table-semantics', snapshot([
      record('table', 'table', { role: 'table' }),
      record('row', 'tr', { role: 'row', parentId: 'table' }),
      record('cell', 'td', { role: suppressedRole, parentId: 'row' })
    ]))).outcome, 'failed');
  }
});

test('table header references must resolve inside the same determinable table', async () => {
  const crossTable = await evaluate('table-headers', snapshot([
    record('table-1', 'table', { role: 'table' }),
    record('head', 'th', {
      role: 'columnheader', tableId: 'table-1', attributes: { id: 'shared' }
    }),
    record('table-2', 'table', { role: 'table' }),
    record('cell', 'td', {
      role: 'cell', tableId: 'table-2', attributes: { headers: 'shared' }
    })
  ]));
  assert.equal(crossTable.outcome, 'failed');
  assert.equal(crossTable.targets[0].data.reason, 'cross-table-header-reference');

  const sameTable = await evaluate('table-headers', snapshot([
    record('table', 'table', { role: 'table' }),
    record('head', 'th', {
      role: 'columnheader', tableId: 'table', attributes: { id: 'head' }
    }),
    record('cell', 'td', {
      role: 'cell', tableId: 'table', attributes: { headers: 'head' }
    })
  ]));
  assert.equal(sameTable.outcome, 'passed');

  const unknownAncestryNodes = [
    record('head', 'th', { role: 'columnheader', attributes: { id: 'head' } }),
    record('cell', 'td', { role: 'cell', attributes: { headers: 'head' } })
  ];
  for (const node of unknownAncestryNodes) delete node.parentId;
  assert.equal((await evaluate('table-headers', snapshot(unknownAncestryNodes))).outcome, 'cantTell');

  assert.equal((await evaluate('table-headers', snapshot([
    record('head', 'th', { role: 'columnheader', attributes: { id: 'head' } }),
    record('cell', 'td', { role: 'cell', attributes: { headers: 'head' } })
  ]))).outcome, 'cantTell');
});
