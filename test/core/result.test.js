import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CLASSIFICATIONS,
  CONFIDENCE_LEVELS,
  IMPACT_LEVELS,
  OUTCOMES,
  TEST_MODES,
  createRuleResult
} from '../../src/core/result.js';

test('createRuleResult rejects an unknown outcome', () => {
  assert.throws(() => createRuleResult({
    ruleId: 'html-title', outcome: 'ok', mode: 'automated', targets: []
  }), /outcome/i);
});

test('createRuleResult rejects an unknown test mode', () => {
  assert.throws(() => createRuleResult({
    ruleId: 'html-title', outcome: 'passed', mode: 'unknown', targets: []
  }), /test mode/i);
});

test('createRuleResult rejects legacy test mode names', () => {
  for (const mode of ['automatic', 'semiAuto']) {
    assert.throws(() => createRuleResult({
      ruleId: 'html-title', outcome: 'passed', mode, targets: []
    }), /test mode/i);
  }
});

test('createRuleResult accepts every global test mode', () => {
  for (const mode of ['automated', 'assisted', 'manual']) {
    assert.equal(createRuleResult({
      ruleId: 'html-title', outcome: 'passed', mode, targets: []
    }).mode, mode);
  }
});

test('createRuleResult returns the validated frozen result contract', () => {
  const targets = ['document'];
  const limitations = ['Only static markup was inspected'];
  const result = createRuleResult({
    ruleId: 'html-title',
    outcome: 'passed',
    mode: 'automated',
    targets,
    summary: 'A descriptive title is present',
    limitations
  });

  assert.deepEqual(result, {
    ruleId: 'html-title',
    outcome: 'passed',
    mode: 'automated',
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
  assert.deepEqual(TEST_MODES, ['automated', 'assisted', 'manual']);
  assert.equal(Object.isFrozen(OUTCOMES), true);
  assert.equal(Object.isFrozen(TEST_MODES), true);
});

test('createRuleResult preserves explicit V2 provenance without adding it to legacy results', () => {
  const source = { engine: 'axe-core', ruleId: 'button-name', version: '4.13.0' };
  const result = createRuleResult({
    ruleId: 'axe.button-name', outcome: 'failed', mode: 'automated',
    classification: 'best-practice', impact: 'serious', confidence: 'high', source,
  });

  assert.deepEqual(result.source, source);
  assert.equal(result.classification, 'best-practice');
  assert.equal(result.impact, 'serious');
  assert.equal(result.confidence, 'high');
  assert.equal(Object.isFrozen(result.source), true);
  assert.notStrictEqual(result.source, source);
  assert.equal(Object.hasOwn(createRuleResult({
    ruleId: 'legacy', outcome: 'passed', mode: 'automated',
  }), 'source'), false);
});

test('rejects invalid V2 classification, impact, confidence and source metadata', () => {
  const base = { ruleId: 'supplemental', outcome: 'failed', mode: 'automated' };
  for (const patch of [
    { classification: 'legal-infraction' },
    { impact: 'blocker' },
    { confidence: 'certain' },
    { source: { engine: 'axe-core', ruleId: '', version: '4.13.0' } },
  ]) assert.throws(() => createRuleResult({ ...base, ...patch }), /classification|impact|confidence|source/i);

  assert.deepEqual(CLASSIFICATIONS, ['requirement', 'recommendation', 'best-practice', 'editorial']);
  assert.deepEqual(IMPACT_LEVELS, ['critical', 'serious', 'moderate', 'minor']);
  assert.deepEqual(CONFIDENCE_LEVELS, ['high', 'medium', 'low']);
});

test('exports V2 result vocabularies through the public core boundary', async () => {
  const core = await import('../../src/core/index.js');
  assert.equal(core.CLASSIFICATIONS, CLASSIFICATIONS);
  assert.equal(core.IMPACT_LEVELS, IMPACT_LEVELS);
  assert.equal(core.CONFIDENCE_LEVELS, CONFIDENCE_LEVELS);
});
