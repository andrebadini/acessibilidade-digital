import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CORE_RULES,
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
