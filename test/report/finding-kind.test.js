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
