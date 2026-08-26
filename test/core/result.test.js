import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OUTCOMES,
  TEST_MODES,
  createRuleResult
} from '../../src/core/result.js';

test('createRuleResult rejects an unknown outcome', () => {
  assert.throws(() => createRuleResult({
    ruleId: 'html-title', outcome: 'ok', mode: 'automatic', targets: []
  }), /outcome/i);
});

test('createRuleResult rejects an unknown test mode', () => {
  assert.throws(() => createRuleResult({
    ruleId: 'html-title', outcome: 'passed', mode: 'unknown', targets: []
  }), /test mode/i);
});

test('createRuleResult returns the validated frozen result contract', () => {
  const targets = ['document'];
  const limitations = ['Only static markup was inspected'];
  const result = createRuleResult({
    ruleId: 'html-title',
    outcome: 'passed',
    mode: 'automatic',
    targets,
    summary: 'A descriptive title is present',
    limitations
  });

  assert.deepEqual(result, {
    ruleId: 'html-title',
    outcome: 'passed',
    mode: 'automatic',
    targets,
    summary: 'A descriptive title is present',
    limitations
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.targets), true);
  assert.equal(Object.isFrozen(result.limitations), true);
  assert.notEqual(result.targets, targets);
  assert.notEqual(result.limitations, limitations);
});

test('createRuleResult defaults optional fields', () => {
  assert.deepEqual(createRuleResult({
    ruleId: 'html-title', outcome: 'untested', mode: 'manual'
  }), {
    ruleId: 'html-title',
    outcome: 'untested',
    mode: 'manual',
    targets: [],
    summary: '',
    limitations: []
  });
});

test('exports the supported outcomes and test modes', () => {
  assert.deepEqual(OUTCOMES, ['passed', 'failed', 'cantTell', 'inapplicable', 'untested']);
  assert.deepEqual(TEST_MODES, ['automatic', 'semiAuto', 'manual']);
  assert.equal(Object.isFrozen(OUTCOMES), true);
  assert.equal(Object.isFrozen(TEST_MODES), true);
});
