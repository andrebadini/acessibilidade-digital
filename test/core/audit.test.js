import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CORE_RULES,
  mergeAxeSupplementalResults,
  runCoreAudit,
  validateCoreRuleComposition
} from '../../src/core/index.js';

function snapshot() {
  return {
    schemaVersion: 1,
    document: { nodeId: 'document', title: 'Página', language: 'pt-BR', statusMessageNodeIds: [] },
    nodes: []
  };
}

test('authoritative core runs exactly 130 rules into all 146 JSON-safe items', async () => {
  assert.equal(CORE_RULES.length, 130);
  assert.deepEqual(validateCoreRuleComposition(), []);

  const audit = await runCoreAudit(snapshot());
  assert.equal(audit.schemaVersion, 1);
  assert.equal(audit.ruleResults.length, 130);
  assert.equal(audit.itemResults.length, 146);
  assert.deepEqual(audit.composition, {
    ruleCount: 130,
    itemCount: 146,
    valid: true
  });
  assert.doesNotThrow(() => JSON.stringify(audit));
  assert.equal(Object.isFrozen(audit), true);
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
  const merged = mergeAxeSupplementalResults(core, {
    status: 'complete',
    ruleResults: [{
      ruleId: 'axe.html-has-lang', outcome: 'failed', mode: 'automated', targets: [{ selector: 'html' }],
      summary: 'Idioma principal ausente.', limitations: [], nbrItems: ['5.13.2'], wcag: ['3.1.1'],
      classification: 'requirement', impact: 'serious', confidence: 'high',
      source: { engine: 'axe-core', ruleId: 'axe.html-has-lang', version: '4.13.0', engineRuleId: 'html-has-lang' },
    }],
    occurrences: [{
      outcome: 'failed', nbrItemRef: '5.13.2', ruleId: 'axe.html-has-lang',
      source: { engine: 'axe-core', ruleId: 'axe.html-has-lang', version: '4.13.0' },
      applicabilityEvidence: {
        confirmed: true, nbrItemRef: '5.13.2',
        source: { engine: 'audita-core', ruleId: 'page-language', version: '1.0.0' },
      },
    }],
    technicalSummary: { passes: { groups: 7, nodes: 14 } },
  });

  assert.deepEqual(core, original);
  assert.equal(merged.ruleResults.length, 131);
  assert.equal(merged.itemResults.find(item => item.id === '5.13.2').outcome, 'failed');
  assert.equal(merged.composition.coreRuleCount, 130);
  assert.equal(merged.composition.supplementalRuleCount, 1);
  assert.equal(merged.ruleResults.some(rule => rule.outcome === 'passed' && rule.source?.engine === 'axe-core'), false);
});

test('mapped axe cantTell can block an ABNT pass but an unmapped finding cannot change items', async () => {
  const core = structuredClone(await runCoreAudit(snapshot()));
  core.itemResults.find(item => item.id === '5.13.10').outcome = 'passed';
  const merged = mergeAxeSupplementalResults(core, {
    status: 'complete',
    ruleResults: [
      { ruleId: 'axe.button-name', outcome: 'cantTell', mode: 'automated', targets: [], summary: '', limitations: [], nbrItems: ['5.13.10'] },
      { ruleId: 'axe.custom', outcome: 'failed', mode: 'automated', targets: [], summary: '', limitations: [], nbrItems: [] },
    ],
    occurrences: [
      { outcome: 'cantTell', nbrItemRef: '5.13.10', ruleId: 'axe.button-name' },
      { outcome: 'failed', nbrItemRef: null, ruleId: 'axe.custom' },
    ],
  });

  assert.equal(merged.itemResults.find(item => item.id === '5.13.10').outcome, 'cantTell');
  assert.equal(merged.itemResults.filter(item => item.outcome === 'failed').length,
    core.itemResults.filter(item => item.outcome === 'failed').length);
});

test('rejects forged applicability proof from an unrelated core rule or rules version', async () => {
  const core = await runCoreAudit(snapshot());
  const makeSupplemental = applicabilityEvidence => ({
    ruleResults: [{
      ruleId: 'axe.html-has-lang', outcome: 'failed', mode: 'automated', targets: [], summary: '', limitations: [],
      nbrItems: ['5.13.2'], source: { engine: 'axe-core', ruleId: 'axe.html-has-lang', version: '4.13.0' },
    }],
    occurrences: [{
      outcome: 'failed', nbrItemRef: '5.13.2', ruleId: 'axe.html-has-lang',
      source: { engine: 'axe-core', ruleId: 'axe.html-has-lang', version: '4.13.0' },
      applicabilityEvidence,
    }],
  });
  const wrongRule = mergeAxeSupplementalResults(core, makeSupplemental({
    confirmed: true, nbrItemRef: '5.13.2',
    source: { engine: 'audita-core', ruleId: 'content-image-alternative', version: '1.0.0' },
  }));
  const wrongVersion = mergeAxeSupplementalResults(core, makeSupplemental({
    confirmed: true, nbrItemRef: '5.13.2',
    source: { engine: 'audita-core', ruleId: 'page-language', version: '99.0.0' },
  }));

  assert.notEqual(wrongRule.itemResults.find(item => item.id === '5.13.2').outcome, 'failed');
  assert.notEqual(wrongVersion.itemResults.find(item => item.id === '5.13.2').outcome, 'failed');
});
