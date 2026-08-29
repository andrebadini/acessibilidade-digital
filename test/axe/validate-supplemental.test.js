import assert from 'node:assert/strict';
import test from 'node:test';

import { AXE_DIAGNOSTIC_CODES, AXE_PROVENANCE } from '../../src/browser/axe-adapter.js';
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

const PARTIAL_LIMITATION = 'O motor suplementar axe-core teve cobertura parcial; somente resultados vinculados a frames concluídos foram considerados.';
const TRUNCATED_LIMITATION = 'Os resultados axe excederam limites locais de segurança; contagens e achados publicados são truncados.';

function partialSupplemental({ truncated = false } = {}) {
  const group = { id: 'html-has-lang', impact: 'serious', nodes: [{ impact: 'serious', target: ['html'] }] };
  if (truncated) {
    group.tags = Array.from({ length: 32 }, () => 'wcag2a');
    group.truncation = {
      tags: { original: 33, retained: 32, truncated: true },
      nodes: { original: 1, retained: 1, truncated: false },
    };
  }
  const frameResult = {
    violations: [group],
    incomplete: [], passes: [], inapplicable: [],
  };
  return structuredClone(normalizeAxeResults({
    status: 'partial', provenance: AXE_PROVENANCE,
    diagnostics: [{ code: 'AXE_FRAME_MISSING', frameId: 2 }],
    frames: [{ frameId: 0, status: 'success', result: frameResult }],
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

test('does not expose a legacy option that can erase authoritative tested coverage', () => {
  const forged = validSupplemental();
  const occurrence = forged.occurrences[0];
  occurrence.sourceWcagRefs = [];
  occurrence.testedWcagRefs = [];
  occurrence.wcagRefs = [];
  occurrence.foreignBenchmarkRefs = [];
  const checked = validateNormalizedAxeSupplemental(forged, {
    rulesVersion: '1.0.0', legacyNormativeIds: new Set([occurrence.occurrenceId]),
  });
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

test('rejects forged normalized payloads whose diagnostics collection is missing, invalid or unreadable', () => {
  let accessorCalls = 0;
  const revokedPair = Proxy.revocable([], {});
  revokedPair.revoke();
  const mutations = [
    value => { delete value.diagnostics; },
    value => { value.diagnostics = null; },
    value => { value.diagnostics = {}; },
    value => { value.diagnostics = revokedPair.proxy; },
    value => {
      Object.defineProperty(value, 'diagnostics', {
        enumerable: true,
        get() { accessorCalls += 1; throw new Error('diagnostics getter must not execute'); },
      });
    },
  ];

  for (const mutate of mutations) {
    const hostile = validSupplemental();
    mutate(hostile);
    let checked;
    assert.doesNotThrow(() => {
      checked = validateNormalizedAxeSupplemental(hostile, { rulesVersion: '1.0.0' });
    });
    assert.ok(checked.errors.length > 0);
    assert.deepEqual(checked.ruleResults, []);
    assert.deepEqual(checked.occurrences, []);
  }
  assert.equal(accessorCalls, 0);
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

test('rejects the forged partial-coverage attack instead of treating partial as an integrity bypass', () => {
  const hostile = validSupplemental();
  hostile.status = 'partial';
  hostile.diagnostics = [{ code: 'AXE_PATIENT_HIV_POSITIVE', frameId: null }];
  hostile.limitations = [PARTIAL_LIMITATION];
  hostile.technicalSummary.violations = { groups: 6_400, nodes: 640_000 };
  hostile.technicalSummary.incomplete = { groups: 6_400, nodes: 640_000 };

  const checked = validateNormalizedAxeSupplemental(hostile, { rulesVersion: '1.0.0' });
  assert.ok(checked.errors.length > 0);
  assert.deepEqual(checked.ruleResults, []);
  assert.deepEqual(checked.occurrences, []);
  assert.doesNotMatch(JSON.stringify(checked), /PATIENT|HIV|POSITIVE/iu);
});

test('uses the exact stable adapter and normalizer diagnostic catalog', () => {
  assert.deepEqual(AXE_DIAGNOSTIC_CODES, [
    'AXE_FEATURE_DISABLED', 'AXE_PROVENANCE_INVALID', 'AXE_TIMEOUT', 'AXE_INJECTION_FAILED',
    'AXE_EXECUTION_FAILED', 'AXE_FRAME_TOPOLOGY_CHANGED', 'AXE_FRAME_MISSING',
    'AXE_FRAME_RUNTIME_UNAVAILABLE', 'AXE_FRAME_RUN_FAILED', 'AXE_VERSION_MISMATCH',
    'AXE_FRAME_INVALID', 'AXE_FRAME_DUPLICATE', 'AXE_FRAME_FAILED',
    'AXE_FRAME_RESULT_INVALID', 'AXE_RESULTS_TRUNCATED', 'AXE_DIAGNOSTIC_UNAVAILABLE',
  ]);
});

test('reconciles retained occurrences and group semantics in non-truncated partial payloads', () => {
  const valid = partialSupplemental();
  assert.deepEqual(validateNormalizedAxeSupplemental(valid, { rulesVersion: '1.0.0' }).errors, []);

  for (const mutate of [
    value => { value.technicalSummary.violations.nodes += 1; },
    value => { value.technicalSummary.violations.groups = value.technicalSummary.violations.nodes + 1; },
  ]) {
    const hostile = partialSupplemental();
    mutate(hostile);
    assert.ok(validateNormalizedAxeSupplemental(hostile, { rulesVersion: '1.0.0' }).errors.length > 0);
  }
});

test('requires canonical truncation markers and counts no smaller than retained occurrences', () => {
  const valid = partialSupplemental({ truncated: true });
  assert.ok(valid.diagnostics.some(entry => entry.code === 'AXE_RESULTS_TRUNCATED'));
  assert.deepEqual(valid.limitations, [PARTIAL_LIMITATION, TRUNCATED_LIMITATION]);
  assert.deepEqual(validateNormalizedAxeSupplemental(valid, { rulesVersion: '1.0.0' }).errors, []);

  const tooSmall = partialSupplemental({ truncated: true });
  tooSmall.technicalSummary.violations.nodes = 0;
  assert.ok(validateNormalizedAxeSupplemental(tooSmall, { rulesVersion: '1.0.0' }).errors.length > 0);

  const fabricated = partialSupplemental({ truncated: true });
  fabricated.technicalSummary.violations = { groups: 6_400, nodes: 640_000 };
  fabricated.technicalSummary.incomplete = { groups: 6_400, nodes: 640_000 };
  assert.ok(validateNormalizedAxeSupplemental(fabricated, { rulesVersion: '1.0.0' }).errors.length > 0);

  const missingMarker = partialSupplemental({ truncated: true });
  missingMarker.diagnostics = missingMarker.diagnostics.filter(entry => entry.code !== 'AXE_RESULTS_TRUNCATED');
  assert.ok(validateNormalizedAxeSupplemental(missingMarker, { rulesVersion: '1.0.0' }).errors.length > 0);
});

test('requires unique limitations and stable diagnostic ordering from the canonical catalog', () => {
  const duplicateLimit = partialSupplemental({ truncated: true });
  duplicateLimit.limitations.push(TRUNCATED_LIMITATION);
  assert.ok(validateNormalizedAxeSupplemental(duplicateLimit, { rulesVersion: '1.0.0' }).errors.length > 0);

  const reorderedLimit = partialSupplemental({ truncated: true });
  reorderedLimit.limitations.reverse();
  assert.ok(validateNormalizedAxeSupplemental(reorderedLimit, { rulesVersion: '1.0.0' }).errors.length > 0);

  const first = normalizeAxeResults({
    status: 'partial', provenance: AXE_PROVENANCE,
    diagnostics: [{ code: 'AXE_FRAME_MISSING', frameId: 2 }, { code: 'AXE_TIMEOUT', frameId: null }],
    frames: [{ frameId: 0, status: 'success', result: { violations: [], incomplete: [], passes: [], inapplicable: [] } }],
  }, { pageId: 'page-1' });
  const second = normalizeAxeResults({
    status: 'partial', provenance: AXE_PROVENANCE,
    diagnostics: [{ code: 'AXE_TIMEOUT', frameId: null }, { code: 'AXE_FRAME_MISSING', frameId: 2 }],
    frames: [{ frameId: 0, status: 'success', result: { violations: [], incomplete: [], passes: [], inapplicable: [] } }],
  }, { pageId: 'page-1' });
  assert.deepEqual(first.diagnostics, second.diagnostics);
  assert.deepEqual(validateNormalizedAxeSupplemental(first, { rulesVersion: '1.0.0' }).errors, []);

  const reordered = structuredClone(first);
  reordered.diagnostics.reverse();
  assert.ok(validateNormalizedAxeSupplemental(reordered, { rulesVersion: '1.0.0' }).errors.length > 0);

  const duplicated = structuredClone(first);
  duplicated.diagnostics.push(structuredClone(duplicated.diagnostics[0]));
  assert.ok(validateNormalizedAxeSupplemental(duplicated, { rulesVersion: '1.0.0' }).errors.length > 0);
});

test('rejects duplicate retained occurrence identities even when summaries are forged consistently', () => {
  const hostile = validSupplemental();
  hostile.occurrences.push(structuredClone(hostile.occurrences[0]));
  hostile.ruleResults[0].targets.push(structuredClone(hostile.ruleResults[0].targets[0]));
  hostile.technicalSummary.violations.nodes = 2;

  const checked = validateNormalizedAxeSupplemental(hostile, { rulesVersion: '1.0.0' });
  assert.ok(checked.errors.length > 0);
  assert.deepEqual(checked.occurrences, []);
});

test('binds violation and incomplete node/group summaries to their exact retained occurrence types', () => {
  for (const mutate of [
    value => {
      value.technicalSummary.violations = { groups: 0, nodes: 0 };
      value.technicalSummary.incomplete = { groups: 1, nodes: 1 };
    },
    value => { value.technicalSummary.violations.groups = 0; },
  ]) {
    const hostile = validSupplemental();
    mutate(hostile);
    assert.ok(validateNormalizedAxeSupplemental(hostile, { rulesVersion: '1.0.0' }).errors.length > 0);
  }
});

test('does not let the occurrence cap authorize fabricated truncated technical counts', () => {
  const hostile = validSupplemental();
  const occurrence = hostile.occurrences[0];
  hostile.occurrences = Array.from({ length: 256 }, (_, index) => ({
    ...structuredClone(occurrence),
    occurrenceId: `occurrence-axe-${index.toString(16).padStart(8, '0')}`,
  }));
  hostile.ruleResults[0].targets = hostile.occurrences.map(() => structuredClone(hostile.ruleResults[0].targets[0]));
  hostile.status = 'partial';
  hostile.diagnostics = [{ code: 'AXE_RESULTS_TRUNCATED', frameId: null }];
  hostile.limitations = [PARTIAL_LIMITATION, TRUNCATED_LIMITATION];
  hostile.technicalSummary.violations = { groups: 6_400, nodes: 640_000 };

  const checked = validateNormalizedAxeSupplemental(hostile, { rulesVersion: '1.0.0' });
  assert.ok(checked.errors.length > 0);
  assert.deepEqual(checked.occurrences, []);
});
