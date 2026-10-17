import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CORE_RULES,
  mergeAxeSupplementalResults,
  runCoreAudit,
  validateCoreRuleComposition
} from '../../src/core/index.js';
import { AXE_PROVENANCE } from '../../src/browser/axe-adapter.js';
import { normalizeAxeResults } from '../../src/core/axe/normalize-axe-results.js';

function normalizedSupplemental({ violations = [], incomplete = [], snapshot: axeSnapshot = snapshot() } = {}) {
  return structuredClone(normalizeAxeResults({
    status: 'complete', provenance: AXE_PROVENANCE, diagnostics: [],
    frames: [{ frameId: 0, status: 'success', result: { violations, incomplete, passes: [], inapplicable: [] } }],
  }, { pageId: 'page-1', snapshot: axeSnapshot, rulesVersion: '1.0.0' }));
}

function snapshot() {
  return {
    schemaVersion: 1,
    document: { nodeId: 'document', title: 'Página', language: 'pt-BR', statusMessageNodeIds: [] },
    nodes: []
  };
}

test('authoritative core runs exactly 132 rules into all 146 JSON-safe items', async () => {
  assert.equal(CORE_RULES.length, 132);
  assert.deepEqual(validateCoreRuleComposition(), []);

  const audit = await runCoreAudit(snapshot());
  assert.equal(audit.schemaVersion, 1);
  assert.equal(audit.ruleResults.length, 132);
  assert.equal(audit.itemResults.length, 146);
  assert.deepEqual(audit.composition, {
    ruleCount: 132,
    itemCount: 146,
    valid: true
  });
  assert.doesNotThrow(() => JSON.stringify(audit));
  assert.equal(Object.isFrozen(audit), true);
  assert.equal(Object.isFrozen(audit.ruleResults), true);
  assert.equal(Object.isFrozen(audit.ruleResults[0]), true);
  assert.equal(Object.isFrozen(audit.ruleResults[0].source), true);
  assert.doesNotMatch(JSON.stringify(audit), /byNodeId|byDomId/);
});

test('composition validation rejects missing, duplicate and wrong WCAG metadata', () => {
  const missing = CORE_RULES.slice(14);
  const duplicate = [...CORE_RULES, ...CORE_RULES.slice(0, 14)];
  const wrongWcag = CORE_RULES.map((rule, index) => index === 0
    ? { ...rule, wcag: ['9.9.9'] }
    : rule);

  assert.match(validateCoreRuleComposition(missing).join('\n'), /missing|ausente/i);
  assert.match(validateCoreRuleComposition(duplicate).join('\n'), /duplicate|duplicad/i);
  assert.match(validateCoreRuleComposition(wrongWcag).join('\n'), /wcag/i);
});

test('public audit aborts before execution for invalid snapshot or composition', async () => {
  await assert.rejects(runCoreAudit({ document: {}, nodes: [] }), /snapshotv1/i);
  await assert.rejects(runCoreAudit(snapshot(), {}, CORE_RULES.slice(14)), /composition|composição/i);
});

test('merges supplemental axe failures conservatively without treating passes as ABNT approval', async () => {
  const core = await runCoreAudit(snapshot());
  const original = structuredClone(core);
  const merged = mergeAxeSupplementalResults(core, normalizedSupplemental({
    violations: [{ id: 'html-has-lang', impact: 'serious', nodes: [{ impact: 'serious', target: ['html'] }] }],
    snapshot: { document: { language: '' }, nodes: [] },
  }));

  assert.deepEqual(core, original);
  assert.equal(merged.ruleResults.length, 133);
  assert.equal(merged.itemResults.find(item => item.id === '5.13.2').outcome, 'failed');
  assert.equal(merged.composition.coreRuleCount, 132);
  assert.equal(merged.composition.supplementalRuleCount, 1);
  assert.equal(merged.ruleResults.some(rule => rule.outcome === 'passed' && rule.source?.engine === 'axe-core'), false);
});

test('mapped axe cantTell can block an ABNT pass but an unmapped finding cannot change items', async () => {
  const core = structuredClone(await runCoreAudit(snapshot()));
  core.itemResults.find(item => item.id === '5.13.10').outcome = 'passed';
  const merged = mergeAxeSupplementalResults(core, normalizedSupplemental({
    violations: [{ id: 'custom', impact: 'minor', nodes: [{ target: ['main'] }] }],
    incomplete: [{ id: 'button-name', impact: 'serious', nodes: [{ target: ['button'] }] }],
  }));

  assert.equal(merged.itemResults.find(item => item.id === '5.13.10').outcome, 'cantTell');
  assert.equal(merged.itemResults.filter(item => item.outcome === 'failed').length,
    core.itemResults.filter(item => item.outcome === 'failed').length);
});

test('rejects forged applicability proof from an unrelated core rule or rules version', async () => {
  const core = await runCoreAudit(snapshot());
  const makeSupplemental = applicabilityEvidence => {
    const supplemental = normalizedSupplemental({
      violations: [{ id: 'html-has-lang', impact: 'serious', nodes: [{ target: ['html'] }] }],
      snapshot: { document: { language: '' }, nodes: [] },
    });
    supplemental.occurrences[0].applicabilityEvidence = applicabilityEvidence;
    return supplemental;
  };
  const wrongRule = mergeAxeSupplementalResults(core, makeSupplemental({
    confirmed: true, pageId: 'page-1', frameId: 0, target: 'html', nbrItemRef: '5.13.2',
    source: { engine: 'audita-core', ruleId: 'content-image-alternative', version: '1.0.0' },
  }));
  const wrongVersion = mergeAxeSupplementalResults(core, makeSupplemental({
    confirmed: true, pageId: 'page-1', frameId: 0, target: 'html', nbrItemRef: '5.13.2',
    source: { engine: 'audita-core', ruleId: 'page-language', version: '99.0.0' },
  }));

  assert.notEqual(wrongRule.itemResults.find(item => item.id === '5.13.2').outcome, 'failed');
  assert.notEqual(wrongVersion.itemResults.find(item => item.id === '5.13.2').outcome, 'failed');
});

test('merge drops the whole hostile axe cluster without persisting private prose', async () => {
  const core = await runCoreAudit(snapshot());
  const hostile = normalizedSupplemental({
    incomplete: [{ id: 'button-name', impact: 'serious', nodes: [{ target: ['button'] }] }],
  });
  hostile.ruleResults[0].privateText = 'Família Oliveira prontuário confidencial';
  hostile.occurrences[0].justification = 'Família Oliveira prontuário confidencial';

  const merged = mergeAxeSupplementalResults(core, hostile);
  assert.equal(merged.composition.supplementalRuleCount, 0);
  assert.doesNotMatch(JSON.stringify(merged), /Oliveira|prontuário/iu);
});
