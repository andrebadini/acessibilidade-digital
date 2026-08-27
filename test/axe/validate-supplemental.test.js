import assert from 'node:assert/strict';
import test from 'node:test';

import { AXE_PROVENANCE } from '../../src/browser/axe-adapter.js';
import { normalizeAxeResults } from '../../src/core/axe/normalize-axe-results.js';
import { validateNormalizedAxeSupplemental } from '../../src/core/axe/validate-supplemental.js';

function validSupplemental() {
  return structuredClone(normalizeAxeResults({
    status: 'complete', provenance: AXE_PROVENANCE, diagnostics: [],
    frames: [{ frameId: 0, status: 'success', result: {
      violations: [{ id: 'html-has-lang', impact: 'serious', nodes: [{ impact: 'serious', target: ['html'] }] }],
      incomplete: [], passes: [], inapplicable: [],
    } }],
  }, {
    pageId: 'page-1', rulesVersion: '1.0.0',
    snapshot: { document: { language: '' }, nodes: [] },
  }));
}

test('strict supplemental validator accepts only the exact normalized axe contract', () => {
  const valid = validateNormalizedAxeSupplemental(validSupplemental(), { rulesVersion: '1.0.0' });
  assert.deepEqual(valid.errors, []);
  assert.equal(valid.ruleResults.length, 1);
  assert.equal(valid.occurrences.length, 1);

  for (const mutate of [
    value => { value.provenance.version = '99.0.0'; },
    value => { value.provenance.config.runOnly.values.push('section508'); },
    value => { value.ruleResults[0].ruleId = 'axe.fake-rule'; value.occurrences[0].ruleId = 'axe.fake-rule'; },
    value => { value.ruleResults[0].nbrItems = ['5.2.1']; },
    value => { value.ruleResults[0].wcag = ['1.1.1']; },
    value => { value.ruleResults[0].classification = 'recommendation'; },
    value => { value.occurrences[0].nbrItemRef = '5.2.1'; value.occurrences[0].itemId = '5.2.1'; },
    value => { value.occurrences[0].applicabilityEvidence.pageId = 'other-page'; },
    value => { value.occurrences[0].applicabilityEvidence.frameId = 2; },
    value => { value.occurrences[0].applicabilityEvidence.target = 'body'; },
    value => { value.occurrences[0].applicabilityEvidence.source.ruleId = 'page-title'; },
    value => { value.occurrences[0].applicabilityEvidence.source.version = '99.0.0'; },
  ]) {
    const hostile = validSupplemental();
    mutate(hostile);
    const checked = validateNormalizedAxeSupplemental(hostile, { rulesVersion: '1.0.0' });
    assert.ok(checked.errors.length > 0, JSON.stringify(hostile));
    assert.deepEqual(checked.ruleResults, []);
    assert.deepEqual(checked.occurrences, []);
  }
});

test('forged cantTell and legal claims are rejected rather than influencing ABNT', () => {
  const forged = validSupplemental();
  forged.ruleResults[0].outcome = 'cantTell';
  forged.occurrences[0] = {
    ...forged.occurrences[0],
    outcome: 'cantTell', applicabilityEvidence: null,
    legalAnalysis: { basisRef: 'br.consumer.accessibility.fixed.v1' },
    source: { ...forged.occurrences[0].source, engineRuleId: 'fake-rule' },
  };
  const checked = validateNormalizedAxeSupplemental(forged, { rulesVersion: '1.0.0' });
  assert.ok(checked.errors.length > 0);
  assert.deepEqual(checked.occurrences, []);
});

test('rejects extra private prose and oversized target collections at the integrity boundary', () => {
  const privateText = validSupplemental();
  privateText.ruleResults[0].privatePageText = 'Família Oliveira, prontuário confidencial';
  privateText.ruleResults[0].summary = 'Família Oliveira, prontuário confidencial';
  let checked = validateNormalizedAxeSupplemental(privateText, { rulesVersion: '1.0.0' });
  assert.ok(checked.errors.length > 0);
  assert.doesNotMatch(JSON.stringify(checked), /Oliveira|prontuário/iu);

  const oversized = validSupplemental();
  oversized.ruleResults[0].targets = Array.from({ length: 300 }, () => ({
    selector: 'html', framePath: [], message: 'texto privado',
  }));
  checked = validateNormalizedAxeSupplemental(oversized, { rulesVersion: '1.0.0' });
  assert.ok(checked.errors.length > 0);
  assert.deepEqual(checked.ruleResults, []);
});

test('recomputes confidence, impact, targets and requires the exact curated document binding', () => {
  for (const mutate of [
    value => { value.occurrences[0].confidence = 'low'; },
    value => { value.ruleResults[0].confidence = 'low'; },
    value => { value.ruleResults[0].impact = 'minor'; },
    value => { value.ruleResults[0].targets = []; },
    value => {
      value.occurrences[0].selector = 'TOPSECRET';
      value.occurrences[0].target.selector = 'TOPSECRET';
      value.occurrences[0].applicabilityEvidence.target = 'TOPSECRET';
    },
    value => {
      value.occurrences[0].framePath = ['frame:2'];
      value.occurrences[0].target.framePath = ['frame:2'];
      value.occurrences[0].applicabilityEvidence.frameId = 2;
    },
  ]) {
    const hostile = validSupplemental();
    mutate(hostile);
    assert.ok(validateNormalizedAxeSupplemental(hostile, { rulesVersion: '1.0.0' }).errors.length > 0);
  }
});

test('contains revoked proxies and nested accessors without throwing or executing them', () => {
  let getterCalls = 0;
  const hostile = validSupplemental();
  Object.defineProperty(hostile.ruleResults[0], 'targets', {
    enumerable: true,
    get() { getterCalls += 1; throw new Error('must not execute'); },
  });
  assert.doesNotThrow(() => validateNormalizedAxeSupplemental(hostile, { rulesVersion: '1.0.0' }));
  assert.equal(getterCalls, 0);

  const { proxy, revoke } = Proxy.revocable([], {});
  revoke();
  assert.doesNotThrow(() => validateNormalizedAxeSupplemental({
    provenance: AXE_PROVENANCE, ruleResults: proxy, occurrences: [],
  }, { rulesVersion: '1.0.0' }));
});

test('requires the exact complete normalized top-level axe payload even when disabled and empty', () => {
  const disabled = structuredClone(normalizeAxeResults({
    status: 'disabled', provenance: AXE_PROVENANCE, diagnostics: [{ code: 'AXE_FEATURE_DISABLED', frameId: null }], frames: [],
  }, { pageId: 'page-1' }));
  assert.deepEqual(validateNormalizedAxeSupplemental(disabled, { rulesVersion: '1.0.0' }).errors, []);

  for (const mutate of [
    value => { value.privateText = 'Paciente HIV positivo'; },
    value => { value.status = 'complete'; },
    value => { value.diagnostics[0].privateText = 'Paciente HIV positivo'; },
    value => { value.limitations = []; },
    value => { value.technicalSummary.violations.groups = 1; },
    value => { delete value.technicalSummary.passes; },
  ]) {
    const hostile = structuredClone(disabled);
    mutate(hostile);
    const checked = validateNormalizedAxeSupplemental(hostile, { rulesVersion: '1.0.0' });
    assert.ok(checked.errors.length > 0);
    assert.doesNotMatch(JSON.stringify(checked), /Paciente|HIV/iu);
  }
});

test('uses the adapter structural-selector allowlist and rejects hostile tag-shaped private selectors', () => {
  const supplemental = structuredClone(normalizeAxeResults({
    status: 'complete', provenance: AXE_PROVENANCE, diagnostics: [],
    frames: [{ frameId: 0, status: 'success', result: {
      violations: [],
      incomplete: [{ id: 'input-image-alt', impact: 'serious', nodes: [{ impact: 'serious', target: ['input'] }] }],
      passes: [], inapplicable: [],
    } }],
  }, { pageId: 'page-1', rulesVersion: '1.0.0' }));
  const occurrence = supplemental.occurrences[0];
  occurrence.selector = 'patient-hiv-positive';
  occurrence.target.selector = 'patient-hiv-positive';
  occurrence.presentationTargetKey = 'selector:0:patient-hiv-positive';
  supplemental.ruleResults[0].targets[0].selector = 'patient-hiv-positive';

  const checked = validateNormalizedAxeSupplemental(supplemental, { rulesVersion: '1.0.0' });
  assert.ok(checked.errors.length > 0);
  assert.doesNotMatch(JSON.stringify(checked), /patient-hiv-positive/iu);
});

test('rejects internally inconsistent technical-summary counts for a complete finding set', () => {
  for (const mutate of [
    value => { value.technicalSummary.violations.nodes += 1; },
    value => { value.technicalSummary.violations.groups = value.technicalSummary.violations.nodes + 1; },
  ]) {
    const hostile = validSupplemental();
    mutate(hostile);
    assert.ok(validateNormalizedAxeSupplemental(hostile, { rulesVersion: '1.0.0' }).errors.length > 0);
  }
});
