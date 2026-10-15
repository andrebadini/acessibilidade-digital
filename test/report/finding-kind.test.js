import assert from 'node:assert/strict';
import test from 'node:test';
import { findingKind } from '../../src/core/report/finding-kind.js';

const occurrence = { outcome: 'cantTell', classification: 'requirement', nodeId: 'n1', source: { engine: 'audita-core' } };
const rule = reason => ({ targets: [{ nodeId: 'n1', data: { reason } }] });

test('a control or a general question is not evidence of a suspected barrier', () => {
  for (const reason of ['human-judgment-required', 'custom-component-candidate', 'page-level-human-judgment', 'page-level-insufficient-observation']) {
    assert.equal(findingKind(occurrence, rule(reason)), 'checklist');
  }
  assert.equal(findingKind(occurrence, { targets: [] }), 'checklist');
});

test('concrete incomplete observations remain suspicions only for their correlated target', () => {
  assert.equal(findingKind(occurrence, rule('generic-link-purpose')), 'suspected');
  assert.equal(findingKind(occurrence, rule('new-window-warning-observation-incomplete')), 'suspected');
  assert.equal(findingKind({ ...occurrence, nodeId: 'other' }, rule('generic-link-purpose')), 'checklist');
});

test('the per-field requiredness suspicions of ABNT 5.9.7 are suspicions, not a generic checklist', () => {
  // An independent review measured every one of these reasons being rendered as a generic "not yet
  // evaluated" question, with the field message and the selector dropped from the exported HTML and
  // the print output reduced to a count. The rule calls them concrete suspicions, so they must not
  // fall back to the checklist group.
  for (const reason of ['missing-required-identification', 'invalid-required-state', 'required-state-mismatch']) {
    assert.equal(findingKind(occurrence, rule(reason)), 'suspected');
    assert.equal(findingKind({ ...occurrence, nodeId: 'other' }, rule(reason)), 'checklist',
      'a suspicion still needs its own correlated target, never the whole page');
  }
});

test('a block whose content a script opens on mouse over is a suspicion of its own, not a checklist question', () => {
  // A dúvida diz qual bloco parece abrir por script e manda conferir com Tab. No checklist ela
  // perderia as duas coisas: o texto da regra e o seletor do bloco não chegam a quem lê.
  assert.equal(findingKind(occurrence, rule('hover-script-no-keyboard-path')), 'suspected');
  assert.equal(findingKind({ ...occurrence, nodeId: 'other' }, rule('hover-script-no-keyboard-path')), 'checklist',
    'a suspeita precisa do alvo correlacionado, nunca da página inteira');
  // As outras dúvidas desta mesma regra continuam perguntas gerais: elas não apontam um bloco.
  for (const reason of ['hover-only-keyboard-path-unconfirmed', 'hover-only-observation-unavailable']) {
    assert.equal(findingKind(occurrence, rule(reason)), 'checklist');
  }
});

test('recommendations do not masquerade as requirement failures; human conclusions remain explicit', () => {
  assert.equal(findingKind({ ...occurrence, outcome: 'failed' }), 'detected');
  assert.equal(findingKind({ ...occurrence, outcome: 'failed', classification: 'recommendation' }), 'advisory');
  assert.equal(findingKind(occurrence, null, { answer: 'não conforme' }), 'detected');
  assert.equal(findingKind(occurrence, null, { answer: 'conforme' }), 'positive');
  assert.equal(findingKind(occurrence, null, { answer: 'não foi possível determinar' }), 'checklist');
});

test('missing evidence and supplemental incomplete outcomes are not silently approved', () => {
  assert.equal(findingKind({ ...occurrence, source: { engine: 'axe-core' } }, { targets: [{selector:'[target-unavailable]'}] }), 'checklist');
  assert.equal(findingKind({ ...occurrence, outcome: 'untested' }), 'checklist');
});

test('actual supplemental engine signals remain visible for review even without a correlated element', () => {
  for (const engineResultType of ['violations', 'incomplete']) {
    const signal = { ...occurrence, nodeId: null, source: { engine: 'axe-core' }, engineResultType,
      selector: '[target-unavailable]' };
    assert.equal(findingKind(signal, null), 'suspected');
    assert.equal(signal.outcome, 'cantTell');
    assert.equal(findingKind({ ...signal, engineResultType: undefined }, null), 'checklist');
  }
});
