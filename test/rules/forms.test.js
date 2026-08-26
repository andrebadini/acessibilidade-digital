import test from 'node:test';
import assert from 'node:assert/strict';

import { runRules } from '../../src/core/rules/run-rules.js';
import { FORM_RULES } from '../../src/core/rules/forms.js';

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
  const rule = FORM_RULES.find(candidate => candidate.id === ruleId);
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

test('form field label reports every unnamed field and distinguishes missing collection data', async () => {
  const failed = await evaluate('form-field-label', snapshot([
    record('name', 'input', { attributes: { type: 'text' }, role: 'textbox', accessibleName: '' }),
    record('ok', 'select', { role: 'combobox', accessibleName: 'Estado' }),
    record('email', 'input', { attributes: { type: 'email' }, role: 'textbox', accessibleName: '' })
  ]));
  assert.equal(failed.outcome, 'failed');
  assert.deepEqual(failed.targets.map(target => target.nodeId), ['name', 'email']);
  failed.targets.forEach(assertEvidence);
  assert.equal((await evaluate('form-field-label', snapshot([
    record('ok', 'textarea', { role: 'textbox', accessibleName: 'Mensagem' })
  ]))).outcome, 'passed');
  assert.equal((await evaluate('form-field-label', snapshot())).outcome, 'inapplicable');
  const unknown = record('unknown', 'input', { attributes: { type: 'text' }, role: 'textbox' });
  delete unknown.accessibleName;
  assert.equal((await evaluate('form-field-label', snapshot([unknown]))).outcome, 'cantTell');
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
});

test('required field rule checks both programmatic state and observable identification', async () => {
  const failed = await evaluate('required-field-identification', snapshot([
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
  assert.equal(failed.outcome, 'failed');
  assert.deepEqual(failed.targets.map(target => target.nodeId), ['state', 'indicator']);
  assert.deepEqual(failed.targets.map(target => target.data.reason), [
    'required-state-mismatch', 'missing-required-identification'
  ]);

  assert.equal((await evaluate('required-field-identification', snapshot([
    record('ok', 'input', {
      attributes: { type: 'text', required: '' },
      required: true,
      requiredIndicator: 'obrigatório',
      accessibleName: 'Nome obrigatório'
    })
  ]))).outcome, 'passed');
  assert.equal((await evaluate('required-field-identification', snapshot())).outcome, 'inapplicable');
  const unknownState = record('unknown', 'input', {
    attributes: { type: 'text', required: '' }, requiredIndicator: 'obrigatório'
  });
  delete unknownState.required;
  assert.equal((await evaluate('required-field-identification', snapshot([unknownState]))).outcome, 'cantTell');
});

test('input purpose validates autocomplete tokens for every field with an observed personal-data purpose', async () => {
  const failed = await evaluate('input-purpose', snapshot([
    record('missing', 'input', { attributes: { type: 'email' }, inputPurpose: 'email' }),
    record('wrong', 'input', { attributes: { type: 'tel', autocomplete: 'email' }, inputPurpose: 'tel' }),
    record('invalid', 'input', { attributes: { type: 'text', autocomplete: 'not-a-token' }, inputPurpose: 'name' }),
    record('ok', 'input', { attributes: { type: 'email', autocomplete: 'section-checkout email' }, inputPurpose: 'email' })
  ]));
  assert.equal(failed.outcome, 'failed');
  assert.deepEqual(failed.targets.map(target => target.nodeId), ['missing', 'wrong', 'invalid']);
  assert.equal((await evaluate('input-purpose', snapshot([
    record('ok', 'input', { attributes: { autocomplete: 'shipping street-address' }, inputPurpose: 'street-address' })
  ]))).outcome, 'passed');
  assert.equal((await evaluate('input-purpose', snapshot())).outcome, 'inapplicable');
  assert.equal((await evaluate('input-purpose', snapshot([
    record('unknown', 'input', { attributes: { type: 'email' } })
  ]))).outcome, 'cantTell');
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
});
