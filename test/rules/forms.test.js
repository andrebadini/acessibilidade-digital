import test from 'node:test';
import assert from 'node:assert/strict';

import { runRules } from '../../src/core/rules/run-rules.js';
import { FORM_RULES } from '../../src/core/rules/forms.js';
import { INTERACTIVE_RULES } from '../../src/core/rules/interactive.js';
import { normalizeSnapshot } from '../../src/core/normalize-snapshot.js';
import { validateCoreRuleTargetInventory } from '../../src/core/report/remediation-policy.js';

// O relatório só aceita alvos core com remediação registrada; um motivo fora do catálogo fazia a
// auditoria inteira terminar como "encerrada antes de concluir" (1.1.48 a 1.1.55).
function acceptedByReport(result) {
  return validateCoreRuleTargetInventory(result.ruleId, result.outcome,
    result.targets.map(({ selectorHint, ...target }) => target));
}

test('a programmatic aria-label is not reported as a missing label association', async () => {
  const page = snapshot([record('search', 'textarea', {
    attributes:{'aria-label':'Pesquisar',role:'combobox'}, accessibleName:'Pesquisar'
  })]);
  assert.equal((await evaluate('form-label-association', page)).outcome, 'passed');
});

test('aria-labelledby associates a field with collected label text', async () => {
  const value = snapshot([
    record('label', 'span', { attributes: { id: 'field-name' }, text: 'Nome' }),
    record('field', 'input', { attributes: { 'aria-labelledby': 'field-name' }, accessibleName: 'Nome' })
  ]);
  assert.equal((await evaluate('form-label-association', value)).outcome, 'passed');
});

test('field-label review separates accessible naming from visual identification without multiplying findings', async () => {
  for (const field of [
    record('field', 'input', { attributes: { 'aria-label': 'Nome' }, accessibleName: 'Nome' }),
    record('field', 'input', { accessibleName: '' }),
    record('field', 'div', { attributes: { role: 'textbox', contenteditable: 'true' }, accessibleName: '' }),
    record('field', 'input', { attributes: { 'aria-hidden': 'true' }, hasRenderedBox: true }),
  ]) {
    const result = await evaluate('form-field-label', snapshot([field]));
    assert.equal(result.outcome, 'cantTell');
    assert.deepEqual(result.targets, []);
  }
  const many = Array.from({ length: 100 }, (_, index) => record(`field-${index}`, 'input', { accessibleName: 'Nome' }));
  const result = await evaluate('form-field-label', snapshot(many));
  assert.equal(result.outcome, 'cantTell');
  assert.deepEqual(result.targets, []);
  assert.equal((await evaluate('form-field-label', snapshot())).outcome, 'inapplicable');
});

test('a clipped label becomes a per-field target and never a confirmed failure', async () => {
  // Measured in real Chrome: a label fully clipped by clip-path:inset(50%) keeps
  // hasRenderedBox true and visibleText filled, so geometry and DOM text cannot prove the label
  // is seen. The inverse is what is observable — the clip is applied, so the label is not
  // visible — and that is what turns into a target. The outcome stays cantTell because the ABNT
  // requirement also accepts a visually evident purpose.
  const clipped = snapshot([
    record('label', 'label', { attributes: { for: 'field' }, text: 'Nome', hasRenderedBox: true,
      styles: { 'clip-path': 'inset(50%)', clip: 'auto' } }),
    record('field', 'input', { attributes: { id: 'field' }, accessibleName: 'Nome' }),
  ]);
  const found = await evaluate('form-field-label', clipped);
  assert.equal(found.outcome, 'cantTell');
  assert.deepEqual(found.targets.map(value => value.nodeId), ['field']);
  assert.equal(found.targets[0].data.reason, 'clipped-label');
  assert.equal(acceptedByReport(found), true, 'o rótulo recortado precisa caber no catálogo do relatório');
  assert.doesNotMatch(found.summary, /falha confirmada|infração/iu);

  // The same field with a label that is not clipped must not produce a target: the pending
  // review stays aggregate, without multiplying one item per field.
  const visible = snapshot([
    record('label', 'label', { attributes: { for: 'field' }, text: 'Nome', hasRenderedBox: true,
      styles: { 'clip-path': 'none', clip: 'auto' } }),
    record('field', 'input', { attributes: { id: 'field' }, accessibleName: 'Nome' }),
  ]);
  const pending = await evaluate('form-field-label', visible);
  assert.equal(pending.outcome, 'cantTell');
  assert.deepEqual(pending.targets, []);

  // A partial inset (10%) still shows most of the label, so it is not treated as hidden.
  const partial = snapshot([
    record('label', 'label', { attributes: { for: 'field' }, text: 'Nome', hasRenderedBox: true,
      styles: { 'clip-path': 'inset(10%)', clip: 'auto' } }),
    record('field', 'input', { attributes: { id: 'field' }, accessibleName: 'Nome' }),
  ]);
  assert.deepEqual((await evaluate('form-field-label', partial)).targets, []);

  // inset accepts one to four values and expands them like margins: one value applies to all four
  // sides, two to vertical and horizontal, three to top, horizontal and bottom, four to top, right,
  // bottom and left. A first implementation required 49% or more in every token, and a probe
  // written to refute the detection found total clips it missed: the `round` keyword broke the
  // expression match, and a two-value inset closed one axis while the other token stayed 0%.
  // The rule is one closed axis, not two: 50% on left and right trims the width to zero whatever
  // the vertical values are.
  const withInset = (top, right, bottom, left) => {
    const value = snapshot([
      record('label', 'label', { attributes: { for: 'field' }, text: 'Nome', hasRenderedBox: true,
        styles: { 'clip-path': `inset(${top}% ${right}% ${bottom}% ${left}%)`, clip: 'auto' } }),
      record('field', 'input', { attributes: { id: 'field' }, accessibleName: 'Nome' }),
    ]);
    return value;
  };
  for (const sides of [[50, 50, 50, 50], [50, 0, 50, 0], [0, 50, 0, 50], [25, 50, 25, 50],
    [50, 25, 50, 25], [100, 100, 100, 100]]) {
    const value = withInset(...sides);
    assert.deepEqual((await evaluate('form-field-label', value)).targets.map(entry => entry.nodeId), ['field'],
      `inset(${sides.join('% ')}%) closes an axis and must be treated as clipped`);
  }
  for (const sides of [[0, 0, 0, 0], [10, 10, 10, 10], [40, 40, 40, 40], [0, 0, 40, 0],
    [40, 0, 0, 0], [0, 40, 0, 0]]) {
    const value = withInset(...sides);
    assert.deepEqual((await evaluate('form-field-label', value)).targets, [],
      `inset(${sides.join('% ')}%) leaves both axes open and must not become a target`);
  }
  // The keyword form and the other shapes: `round` must not stop the match, and shapes the
  // detection does not parse must never turn a visible label into a target.
  for (const [style, expected] of [['inset(50% round 10px)', 1], ['inset(50% 0% round 4px)', 1],
    ['circle(50%)', 0], ['ellipse(25% 25%)', 0], ['polygon(0 0, 100% 0, 100% 100%)', 0], ['none', 0]]) {
    const style_ = snapshot([
      record('label', 'label', { attributes: { for: 'field' }, text: 'Nome', hasRenderedBox: true,
        styles: { 'clip-path': style, clip: 'auto' } }),
      record('field', 'input', { attributes: { id: 'field' }, accessibleName: 'Nome' }),
    ]);
    assert.equal((await evaluate('form-field-label', style_)).targets.length, expected, `${style}`);
  }

  // A label can also be hidden by being placed outside the page, which is the other classic
  // read-it-but-do-not-show-it technique. Measured in Chrome: getBoundingClientRect reports those
  // coordinates raw, x -9999 for the usual sr-only pattern and y 9000 for one pushed far below, so
  // the geometry is a trustworthy signal when the rectangle is decisive.
  const offscreen = (id, rect) => snapshot([
    record(id, 'label', { attributes: { for: 'field' }, text: 'Nome', hasRenderedBox: true,
      documentRect: rect, styles: { 'clip-path': 'none', clip: 'auto' } }),
    record('field', 'input', { attributes: { id: 'field' }, accessibleName: 'Nome' }),
  ]);
  const farLeft = await evaluate('form-field-label', offscreen('label', { x: -9999, y: 0, width: 120, height: 18 }));
  assert.deepEqual(farLeft.targets.map(entry => entry.nodeId), ['field'], 'a label left of the origin is off screen');
  assert.equal(farLeft.targets[0].data.reason, 'offscreen-label');
  assert.equal(farLeft.outcome, 'cantTell', 'being off screen does not prove absence of perception');
  assert.equal(acceptedByReport(farLeft), true, 'o rótulo fora da tela precisa caber no catálogo do relatório');

  // The vertical case needs real content above it: with only the label in the fixture the label
  // would be the lowest thing drawn and therefore its own reference, which is what the first run of
  // this test got wrong.
  const belowContent = snapshot([
    record('content', 'p', { text: 'Conteúdo', hasRenderedBox: true, documentRect: { x: 0, y: 0, width: 400, height: 600 } }),
    record('label', 'label', { attributes: { for: 'field' }, text: 'Nome', hasRenderedBox: true,
      documentRect: { x: 0, y: 9000, width: 120, height: 18 }, styles: { 'clip-path': 'none', clip: 'auto' } }),
    record('field', 'input', { attributes: { id: 'field' }, accessibleName: 'Nome' }),
  ]);
  const farBelow = await evaluate('form-field-label', belowContent);
  assert.deepEqual(farBelow.targets.map(entry => entry.nodeId), ['field'], 'a label far past the content is off screen');

  // Not decisive, so not a target: an ordinary label at the origin, one scrolled above the fold,
  // and one just past the last drawn element.
  for (const rect of [{ x: 16, y: 40, width: 120, height: 18 }, { x: 16, y: -200, width: 120, height: 18 },
    { x: 0, y: 620, width: 120, height: 18 }]) {
    const value = await evaluate('form-field-label', offscreen('label', rect));
    assert.deepEqual(value.targets, [], `an ordinary label must not become a target: ${JSON.stringify(rect)}`);
  }

  // The legacy clip:rect(0,0,0,0) technique counts as hidden too.
  const legacy = snapshot([
    record('label', 'label', { attributes: { for: 'field' }, text: 'Nome', hasRenderedBox: true,
      styles: { 'clip-path': 'none', clip: 'rect(0px, 0px, 0px, 0px)' } }),
    record('field', 'input', { attributes: { id: 'field' }, accessibleName: 'Nome' }),
  ]);
  assert.deepEqual((await evaluate('form-field-label', legacy)).targets.map(value => value.nodeId), ['field']);
});

test('a wrapping label with an explicit for cannot label a different nested field', async () => {
  const value = snapshot([
    record('label', 'label', { attributes: { for: 'other' }, children: ['nested'], text: 'Outro campo' }),
    record('nested', 'input', { parentId: 'label', attributes: { id: 'nested' } }),
    record('other', 'input', { attributes: { id: 'other' } }),
  ]);
  const result = await evaluate('form-label-association', value);
  assert.equal(result.outcome, 'failed');
  assert.deepEqual(result.targets.map(target => target.nodeId), ['nested']);
});

test('an implicit wrapping label labels only its first labelable descendant', async () => {
  const value = snapshot([
    record('label', 'label', { children: ['first', 'second'], text: 'Nome' }),
    record('first', 'input', { parentId: 'label' }),
    record('second', 'input', { parentId: 'label' }),
  ]);
  assert.deepEqual((await evaluate('form-label-association', value)).targets.map(target => target.nodeId), ['second']);
});

test('same field names do not establish a group across different form owners or documents', async () => {
  const f1 = record('f1', 'form', { attributes: { id: 'f1' }, children: ['a'] });
  const f2 = record('f2', 'form', { attributes: { id: 'f2' }, children: ['b'] });
  const a = record('a', 'input', { parentId: 'f1', attributes: { type: 'radio', name: 'choice' } });
  const b = record('b', 'input', { parentId: 'f2', attributes: { type: 'radio', name: 'choice' } });
  assert.equal((await evaluate('related-fields-grouping', snapshot([f1, a, f2, b]))).outcome, 'inapplicable');
  b.attributes.form = 'f1';
  assert.equal((await evaluate('related-fields-grouping', snapshot([f1, a, f2, b]))).outcome, 'failed');
  delete b.attributes.form;
  a.parentId = null; b.parentId = null; b.frameId = 'child';
  assert.equal((await evaluate('related-fields-grouping', snapshot([a, b]))).outcome, 'inapplicable');
});

test('an empty form reference has no owner even when a form has an empty id', async () => {
  const value = snapshot([
    record('form', 'form', { attributes: { id: '' }, children: ['a'] }),
    record('a', 'input', { parentId: 'form', attributes: { type: 'radio', name: 'choice' } }),
    record('b', 'input', { attributes: { type: 'radio', name: 'choice', form: '' } }),
  ]);
  assert.equal((await evaluate('related-fields-grouping', value)).outcome, 'inapplicable');
});

test('native labelable elements are valid targets even when they are not text fields', async () => {
  for (const tag of ['button', 'meter', 'output', 'progress']) {
    const value = snapshot([
      record('label', 'label', { attributes: { for: 'control' }, text: 'Resultado' }),
      record('control', tag, { attributes: { id: 'control' } })
    ]);
    assert.equal((await evaluate('form-label-association', value)).outcome, 'passed', tag);
  }
});

test('aria-labelledby does not approve absent, ambiguous or foreign document targets', async () => {
  const field = record('field', 'input', { attributes: { 'aria-labelledby': 'name' }, frameId: 'main' });
  const label = record('label', 'span', { attributes: { id: 'name' }, text: 'Nome', frameId: 'main' });
  for (const labels of [[], [label, { ...label, nodeId: 'duplicate' }], [{ ...label, frameId: 'child', framePath: ['frame'] }]]) {
    assert.equal((await evaluate('form-label-association', snapshot([field, ...labels]))).outcome, 'failed');
  }
});

test('native label associations cannot cross documents or be confused by foreign IDs', async () => {
  const label = record('label', 'label', { attributes: { for: 'control' }, frameId: 'main' });
  const foreign = record('foreign', 'button', { attributes: { id: 'control' }, frameId: 'child', framePath: ['frame'] });
  assert.equal((await evaluate('form-label-association', snapshot([label, foreign]))).outcome, 'failed');
  const local = record('local', 'input', { attributes: { id: 'control' }, frameId: 'main' });
  assert.equal((await evaluate('form-label-association', snapshot([label, local, { ...foreign, tagName: 'div' }]))).outcome, 'passed');
  const orphan = { ...foreign, tagName: 'input' };
  const result = await evaluate('form-label-association', snapshot([label, local, orphan]));
  assert.equal(result.outcome, 'failed');
  assert.deepEqual(result.targets.map(target => target.nodeId), ['foreign']);
});

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

function snapshot(nodes = [], document = {}) {
  const normalizedDocument = {
    nodeId: 'document',
    title: 'Formulário',
    language: 'pt-BR',
    statusMessageNodeIds: [],
    ...document
  };
  return {
    document: normalizedDocument,
    nodes,
    byId: Object.fromEntries([['document', normalizedDocument], ...nodes.map(node => [String(node.nodeId), node])])
  };
}

async function evaluate(ruleId, value) {
  const rule = [...FORM_RULES, ...INTERACTIVE_RULES].find(candidate => candidate.id === ruleId);
  assert.ok(rule, `Regra ausente: ${ruleId}`);
  return (await runRules(value, {}, [rule]))[0];
}

function assertEvidence(target) {
  assert.deepEqual(Object.keys(target).sort(), ['data', 'message', 'nodeId', 'selectorHint']);
  assert.doesNotThrow(() => JSON.stringify(target));
}

test('form rules declare exact ABNT, WCAG and mode metadata', () => {
  const expected = {
    'form-field-label': ['automated', ['5.9.1'], ['3.3.2', '4.1.2']],
    'form-label-association': ['automated', ['5.9.3'], ['1.3.1']],
    'related-fields-grouping': ['automated', ['5.9.6'], ['1.3.1']],
    'required-field-identification': ['automated', ['5.9.7'], ['3.3.2']],
    'input-purpose': ['automated', ['5.9.8'], ['1.3.5']],
    'status-message-semantics': ['automated', ['5.13.8'], ['4.1.3']]
  };
  assert.deepEqual(
    Object.fromEntries(FORM_RULES.map(rule => [
      rule.id, [rule.mode, [...rule.nbrItems], [...rule.wcag]]
    ])),
    expected
  );
});

test('missing accessible names remain automated findings under their own requirement', async () => {
  const failed = await evaluate('accessible-component-name', snapshot([
    record('name', 'input', { attributes: { type: 'text' }, role: 'textbox', accessibleName: '' }),
    record('ok', 'select', { role: 'combobox', accessibleName: 'Estado' }),
    record('email', 'input', { attributes: { type: 'email' }, role: 'textbox', accessibleName: '' })
  ]));
  assert.equal(failed.outcome, 'failed');
  assert.deepEqual(failed.targets.map(target => target.nodeId), ['name', 'email']);
  failed.targets.forEach(assertEvidence);
  assert.equal((await evaluate('accessible-component-name', snapshot([
    record('ok', 'textarea', { role: 'textbox', accessibleName: 'Mensagem' })
  ]))).outcome, 'passed');
  assert.equal((await evaluate('accessible-component-name', snapshot())).outcome, 'inapplicable');
  const unknown = record('unknown', 'input', { attributes: { type: 'text' }, role: 'textbox' });
  delete unknown.accessibleName;
  assert.equal((await evaluate('accessible-component-name', snapshot([unknown]))).outcome, 'cantTell');
});

test('form label association accepts explicit unique for and fails missing or ambiguous references', async () => {
  const valid = snapshot([
    record('label', 'label', { attributes: { for: 'email' }, text: 'E-mail' }),
    record('field', 'input', { attributes: { id: 'email', type: 'email' }, accessibleName: 'E-mail' })
  ]);
  assert.equal((await evaluate('form-label-association', valid)).outcome, 'passed');

  const invalidTarget = await evaluate('form-label-association', snapshot([
    record('label', 'label', { attributes: { for: 'panel' }, text: 'Painel' }),
    record('panel', 'div', { attributes: { id: 'panel' } })
  ]));
  assert.equal(invalidTarget.outcome, 'failed');
  assert.equal(invalidTarget.targets[0].data.reason, 'invalid-label-target');

  const failed = await evaluate('form-label-association', snapshot([
    record('label-missing', 'label', { attributes: { for: 'absent' }, text: 'Ausente' }),
    record('duplicate-label', 'label', { attributes: { for: 'dup' }, text: 'Duplicado' }),
    record('field-1', 'input', { attributes: { id: 'dup', type: 'text' }, accessibleName: 'Um' }),
    record('field-2', 'input', { attributes: { id: 'dup', type: 'text' }, accessibleName: 'Dois' }),
    record('unassociated', 'textarea', { accessibleName: 'Comentário' })
  ]));
  assert.equal(failed.outcome, 'failed');
  assert.deepEqual(failed.targets.map(target => target.nodeId), [
    'label-missing', 'field-1', 'field-2', 'unassociated'
  ]);
  assert.deepEqual(failed.targets.map(target => target.data.reason), [
    'missing-idref', 'ambiguous-idref', 'ambiguous-idref', 'missing-association'
  ]);
  assert.equal((await evaluate('form-label-association', snapshot())).outcome, 'inapplicable');
});

test('normalization preserves an ordinary textarea explicit label association outside private regions', async () => {
  const normalized = normalizeSnapshot({
    format: 'simplified-v1',
    document: { url: 'https://example.test/', title: 'Formulário' },
    nodes: [
      { backendNodeId: 1, tagName: 'label', parentBackendNodeId: null, attributes: { for: 'message' }, text: 'Mensagem' },
      {
        backendNodeId: 2, tagName: 'textarea', parentBackendNodeId: null,
        attributes: { id: 'message', name: 'message', 'aria-labelledby': 'message-label', placeholder: 'Comentário' },
        text: 'TOPSECRET-current-text', form: { type: 'textarea', value: 'TOPSECRET-current-text' },
      },
      { backendNodeId: 3, tagName: 'span', parentBackendNodeId: null, attributes: { id: 'message-label' }, text: 'Mensagem' },
    ],
    axTree: { nodes: [{
      backendDOMNodeId: 2, role: { value: 'textbox' }, name: { value: 'Mensagem' }, value: { value: 'TOPSECRET-current-text' },
    }] },
  });
  const textarea = normalized.nodes.find(node => node.backendNodeId === 2);

  assert.deepEqual(textarea.attributes, {
    id: 'message', name: 'message', 'aria-labelledby': 'message-label', placeholder: 'Comentário',
  });
  assert.equal(textarea.accessibleName, 'Mensagem');
  assert.doesNotMatch(JSON.stringify(normalized), /TOPSECRET/iu);
  assert.equal((await evaluate('form-label-association', normalized)).outcome, 'passed');
});

test('form label association validates every normalized labels reference and its field relationship', async () => {
  const valid = await evaluate('form-label-association', snapshot([
    record('label', 'label', { attributes: { for: 'email' } }),
    record('field', 'input', {
      attributes: { id: 'email', type: 'email' },
      labels: ['label'],
      accessibleName: 'E-mail'
    })
  ]));
  assert.equal(valid.outcome, 'passed');

  const failed = await evaluate('form-label-association', snapshot([
    record('other-label', 'label', { attributes: { for: 'other' } }),
    record('other', 'input', { attributes: { id: 'other', type: 'text' }, accessibleName: 'Outro' }),
    record('not-label', 'div'),
    record('missing-ref', 'input', {
      attributes: { id: 'one', type: 'text' }, labels: ['absent'], accessibleName: 'Um'
    }),
    record('wrong-type', 'input', {
      attributes: { id: 'two', type: 'text' }, labels: ['not-label'], accessibleName: 'Dois'
    }),
    record('wrong-field', 'input', {
      attributes: { id: 'three', type: 'text' }, labels: ['other-label'], accessibleName: 'Três'
    })
  ]));
  assert.equal(failed.outcome, 'failed');
  assert.deepEqual(failed.targets.map(target => target.nodeId), ['missing-ref', 'wrong-type', 'wrong-field']);
  assert.deepEqual(failed.targets.map(target => target.data.reason), [
    'missing-label-reference', 'invalid-label-reference', 'label-associated-to-other-field'
  ]);
});

test('form evidence is globally ordered by snapshot nodes across labels and fields', async () => {
  const failed = await evaluate('form-label-association', snapshot([
    record('field-first', 'input', { attributes: { type: 'text' }, accessibleName: 'Primeiro' }),
    record('orphan-label', 'label', { attributes: { for: 'absent' } }),
    record('field-last', 'textarea', { accessibleName: 'Último' })
  ]));

  assert.equal(failed.outcome, 'failed');
  assert.deepEqual(failed.targets.map(target => target.nodeId), [
    'field-first', 'orphan-label', 'field-last'
  ]);
});

test('related radio and checkbox fields require an observable named group', async () => {
  const failed = await evaluate('related-fields-grouping', snapshot([
    record('r1', 'input', { attributes: { type: 'radio', name: 'delivery' }, role: 'radio' }),
    record('r2', 'input', { attributes: { type: 'radio', name: 'delivery' }, role: 'radio' })
  ]));
  assert.equal(failed.outcome, 'failed');
  assert.deepEqual(failed.targets.map(target => target.nodeId), ['r1', 'r2']);

  const valid = snapshot([
    record('group', 'fieldset', { children: ['legend', 'r1', 'r2'], accessibleName: 'Entrega' }),
    record('legend', 'legend', { parentId: 'group', text: 'Entrega' }),
    record('r1', 'input', { parentId: 'group', attributes: { type: 'radio', name: 'delivery' }, role: 'radio' }),
    record('r2', 'input', { parentId: 'group', attributes: { type: 'radio', name: 'delivery' }, role: 'radio' })
  ]);
  assert.equal((await evaluate('related-fields-grouping', valid)).outcome, 'passed');
  assert.equal((await evaluate('related-fields-grouping', snapshot([
    record('single', 'input', { attributes: { type: 'checkbox', name: 'terms' }, role: 'checkbox' })
  ]))).outcome, 'inapplicable');

  const interleaved = await evaluate('related-fields-grouping', snapshot([
    record('a1', 'input', { attributes: { type: 'radio', name: 'a' }, role: 'radio' }),
    record('b1', 'input', { attributes: { type: 'radio', name: 'b' }, role: 'radio' }),
    record('a2', 'input', { attributes: { type: 'radio', name: 'a' }, role: 'radio' }),
    record('b2', 'input', { attributes: { type: 'radio', name: 'b' }, role: 'radio' })
  ]));
  assert.deepEqual(interleaved.targets.map(target => target.nodeId), ['a1', 'b1', 'a2', 'b2']);
});

test('required field rule checks both programmatic state and observable identification', async () => {
  // Um campo com declaração incoerente e um campo sem marcação observada aparecem **os dois** no
  // mesmo resultado. A versão anterior devolvia `failed` só com o primeiro e descartava o segundo
  // em silêncio; a revisão independente mediu esse silêncio no relatório exportado, onde o campo
  // sem marcação alguma não aparecia em lugar nenhum.
  const combined = await evaluate('required-field-identification', snapshot([
    record('state', 'input', {
      attributes: { type: 'text', required: '' },
      required: false,
      requiredIndicator: 'obrigatório',
      accessibleName: 'Nome obrigatório'
    }),
    record('indicator', 'input', {
      attributes: { type: 'email', 'aria-required': 'true' },
      required: true,
      requiredIndicator: '',
      accessibleName: 'E-mail'
    })
  ]));
  assert.equal(combined.outcome, 'cantTell');
  assert.deepEqual(combined.targets.map(target => target.nodeId), ['state', 'indicator']);
  assert.deepEqual(combined.targets.map(target => target.data.reason), [
    'required-state-mismatch', 'missing-required-identification'
  ]);
  assert.doesNotMatch(combined.summary, /infração|inconformidade ao item/iu);

  // Este item não produz `failed`. A norma pede que todos possam perceber a obrigatoriedade, e
  // nada do que se mede aqui prova percepção: uma marcação ausente nas fontes observadas pode
  // existir fora delas, e uma declaração ARIA malformada é defeito de estado do componente — 4.1.2,
  // que este item não reivindica. A versão anterior reprovava os dois casos, e a revisão
  // independente mediu a frase "Inconformidade ao item 5.9.7 da ABNT NBR 17225:2025" sendo impressa
  // para um campo que a própria árvore de acessibilidade do Chrome expõe como obrigatório.
  const invalidToken = await evaluate('required-field-identification', snapshot([
    record('invalid-token', 'input', {
      attributes: { type: 'text', 'aria-required': 'sometimes' }, required: false
    })
  ]));
  assert.equal(invalidToken.outcome, 'cantTell');
  assert.deepEqual(invalidToken.targets.map(target => target.nodeId), ['invalid-token']);
  assert.deepEqual(invalidToken.targets.map(target => target.data.reason), ['invalid-required-state']);

  const marked = await evaluate('required-field-identification', snapshot([
    record('ok', 'input', {
      attributes: { type: 'text', required: '' },
      required: true,
      requiredIndicator: 'obrigatório',
      accessibleName: 'Nome obrigatório'
    })
  ]));
  assert.equal(marked.outcome, 'cantTell');
  assert.deepEqual(marked.targets, []);

  const unmarked = await evaluate('required-field-identification', snapshot([
    record('bare', 'input', {
      attributes: { type: 'text', required: '' },
      required: true,
      requiredIndicator: '',
      accessibleName: 'Nome'
    })
  ]));
  assert.equal(unmarked.outcome, 'cantTell');
  assert.deepEqual(unmarked.targets.map(target => target.nodeId), ['bare']);
  assert.deepEqual(unmarked.targets.map(target => target.data.reason), ['missing-required-identification']);
  assert.doesNotMatch(unmarked.summary, /infração|inconformidade ao item/iu);

  assert.equal((await evaluate('required-field-identification', snapshot())).outcome, 'inapplicable');
  const unknownState = record('unknown', 'input', {
    attributes: { type: 'text', required: '' }, requiredIndicator: 'obrigatório'
  });
  delete unknownState.required;
  assert.equal((await evaluate('required-field-identification', snapshot([unknownState]))).outcome, 'cantTell');

  assert.equal((await evaluate('required-field-identification', snapshot([
    record('optional', 'input', {
      attributes: { type: 'text', 'aria-required': 'false' }, required: false
    })
  ]))).outcome, 'inapplicable');
});

test('a field with unobserved state does not discard the other requiredness suspicions', async () => {
  // Caminho medido pela revisão independente no Chrome real: um campo com o atributo nativo
  // `required` **e** um token ARIA malformado (`aria-required="maybe"`) faz o coletor deixar
  // `required` sem observação. A devolução antecipada de "faltam dados" descartava **todos** os
  // alvos do item, e um campo obrigatório sem marcação nenhuma na mesma página sumia do HTML, do
  // JSON e do PDF — o item caía no checklist genérico e o usuário não conseguia identificar o
  // campo. A falta de dado é limitação a declarar, não motivo para silenciar o que foi observado.
  const mixed = await evaluate('required-field-identification', snapshot([
    record('malformed-native', 'input', {
      attributes: { type: 'text', required: '', 'aria-required': 'maybe' }
    }),
    record('unmarked', 'input', {
      attributes: { type: 'text', required: '' },
      required: true,
      requiredIndicator: '',
      accessibleName: 'Bairro'
    })
  ]));
  assert.equal(mixed.outcome, 'cantTell');
  assert.deepEqual(mixed.targets.map(target => target.nodeId), ['unmarked'],
    'o campo sem marcação continua sendo suspeita mesmo com outro campo sem dado observado');
  assert.deepEqual(mixed.targets.map(target => target.data.reason), ['missing-required-identification']);
  assert.ok(mixed.limitations.some(text => /sem estado calculado ou sem indicador observado/u.test(text)),
    `a falta de dado precisa ser declarada: ${JSON.stringify(mixed.limitations)}`);
  assert.doesNotMatch(mixed.summary, /infração|inconformidade ao item/iu);
});

test('input purpose judges only the declaration the field itself exposes', async () => {
  const failed = await evaluate('input-purpose', snapshot([
    record('plain', 'input', { attributes: { type: 'email' } }),
    record('invalid', 'input', { attributes: { type: 'text', autocomplete: 'not-a-token' } }),
    record('ok', 'input', { attributes: { type: 'email', autocomplete: 'section-checkout email' } })
  ]));
  assert.equal(failed.outcome, 'failed');
  assert.deepEqual(failed.targets.map(target => target.nodeId), ['invalid']);
  assert.deepEqual(failed.targets.map(target => target.data.reason), ['invalid-or-missing-autocomplete']);
  assert.equal((await evaluate('input-purpose', snapshot([
    record('ok', 'input', { attributes: { autocomplete: 'shipping street-address' } })
  ]))).outcome, 'passed');
  assert.equal((await evaluate('input-purpose', snapshot())).outcome, 'inapplicable');

  // A field whose only purpose evidence is its name or input type stays under review: the
  // rule never infers personal data from the element itself.
  const undeclared = await evaluate('input-purpose', snapshot([
    record('named', 'input', { attributes: { type: 'email', name: 'user-email' }, accessibleName: 'E-mail' })
  ]));
  assert.equal(undeclared.outcome, 'cantTell');
  assert.deepEqual(undeclared.targets, []);

  // An explicit opt-out is a structural declaration with no purpose: it is not a failure,
  // but it cannot approve determinacy either.
  assert.equal((await evaluate('input-purpose', snapshot([
    record('off', 'input', { attributes: { type: 'text', autocomplete: 'off' } })
  ]))).outcome, 'cantTell');

  for (const autocomplete of [
    'username webauthn',
    'section-login username webauthn',
    'billing home tel webauthn',
    'work email',
    'nickname'
  ]) {
    assert.equal((await evaluate('input-purpose', snapshot([
      record('valid', 'input', { attributes: { autocomplete } })
    ]))).outcome, 'passed', autocomplete);
  }
  for (const autocomplete of [
    'webauthn username',
    'home name',
    'username name',
    'section-login webauthn'
  ]) {
    assert.equal((await evaluate('input-purpose', snapshot([
      record('invalid', 'input', { attributes: { autocomplete } })
    ]))).outcome, 'failed', autocomplete);
  }
});

test('status messages pass only when observed and exposed with status semantics', async () => {
  assert.equal((await evaluate('status-message-semantics', snapshot([
    record('message', 'div', { role: 'status', text: 'Arquivo salvo' })
  ], { statusMessageNodeIds: ['message'] }))).outcome, 'passed');

  const failed = await evaluate('status-message-semantics', snapshot([
    record('message-1', 'div', { role: '', text: 'Arquivo salvo' }),
    record('message-2', 'div', { role: 'region', text: 'Falha no envio' })
  ], { statusMessageNodeIds: ['message-1', 'message-2'] }));
  assert.equal(failed.outcome, 'failed');
  assert.deepEqual(failed.targets.map(target => target.nodeId), ['message-1', 'message-2']);
  failed.targets.forEach(assertEvidence);

  assert.equal((await evaluate('status-message-semantics', snapshot())).outcome, 'inapplicable');
  const incomplete = snapshot();
  delete incomplete.document.statusMessageNodeIds;
  assert.equal((await evaluate('status-message-semantics', incomplete)).outcome, 'cantTell');

  for (const node of [
    record('polite', 'div', { attributes: { 'aria-live': 'polite' } }),
    record('assertive', 'div', { attributes: { 'aria-live': 'assertive' } }),
    record('log', 'div', { role: 'log' })
  ]) {
    assert.equal((await evaluate('status-message-semantics', snapshot([
      node
    ], { statusMessageNodeIds: [node.nodeId] }))).outcome, 'passed');
  }
  assert.equal((await evaluate('status-message-semantics', snapshot([
    record('off', 'div', { role: 'status', attributes: { 'aria-live': 'off' } })
  ], { statusMessageNodeIds: ['off'] }))).outcome, 'failed');

  const ordered = await evaluate('status-message-semantics', snapshot([
    record('first', 'div'),
    record('second', 'div')
  ], { statusMessageNodeIds: ['second', 'first'] }));
  assert.deepEqual(ordered.targets.map(target => target.nodeId), ['first', 'second']);
});
