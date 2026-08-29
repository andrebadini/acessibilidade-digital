import assert from 'node:assert/strict';
import test from 'node:test';

import { CORE_RULES } from '../../src/core/audit.js';
import { AUDITA_RULES_VERSION } from '../../src/core/provenance.js';
import { canonicalStringify } from '../../src/core/report/canonical-json.js';
import { sha256Hex } from '../../src/core/report/hash.js';
import {
  CORE_INVENTORY_VERSION,
  createInstalledCoreRuleInventory,
  verifyCoreRuleInventory,
} from '../../src/core/rules/core-rule-inventory.js';

async function handBuiltInventory() {
  const ruleIds = CORE_RULES.map(rule => rule.id).sort((a, b) => a.localeCompare(b));
  const inventoryVersion = 'CoreRuleInventoryV1';
  const rulesVersion = AUDITA_RULES_VERSION;
  const sha256 = await sha256Hex(canonicalStringify({ inventoryVersion, rulesVersion, ruleIds }));
  return { inventoryVersion, rulesVersion, ruleIds, sha256 };
}

test('builds and verifies the exact installed core inventory as a deep-frozen copy', async () => {
  assert.equal(CORE_INVENTORY_VERSION, 'CoreRuleInventoryV1');
  const expected = await handBuiltInventory();
  const installed = await createInstalledCoreRuleInventory();
  assert.deepEqual(installed, expected);
  const input = { sha256: expected.sha256, ruleIds: [...expected.ruleIds], rulesVersion: expected.rulesVersion, inventoryVersion: expected.inventoryVersion };
  const verified = await verifyCoreRuleInventory(input);
  assert.deepEqual(verified, expected);
  assert.notEqual(verified, input);
  assert.notEqual(verified.ruleIds, input.ruleIds);
  assert.equal(Object.isFrozen(verified), true);
  assert.equal(Object.isFrozen(verified.ruleIds), true);
});

test('fails closed for wrong shapes, version, ordering, membership, duplicates, or digest', async () => {
  const valid = await handBuiltInventory();
  const malformed = [
    { ...valid, extra: true },
    { ...valid, rulesVersion: '9.9.9' },
    { ...valid, inventoryVersion: 'CoreRuleInventoryV0' },
    { ...valid, ruleIds: [...valid.ruleIds].reverse() },
    { ...valid, ruleIds: [...valid.ruleIds, valid.ruleIds.at(-1)] },
    { ...valid, ruleIds: [...valid.ruleIds.slice(0, -1), 'unknown-core-rule'] },
    { ...valid, sha256: '0'.repeat(64) },
  ];
  for (const inventory of malformed) {
    await assert.rejects(() => verifyCoreRuleInventory(inventory), /CORE_INVENTORY_UNVERIFIED/u);
  }
});

test('rejects a hostile own iterator without invoking it', async () => {
  const inventory = await handBuiltInventory();
  let iteratorCalls = 0;
  Object.defineProperty(inventory.ruleIds, Symbol.iterator, {
    enumerable: true,
    value() { iteratorCalls += 1; throw new Error('PRIVATE_ITERATOR'); },
  });
  await assert.rejects(() => verifyCoreRuleInventory(inventory), /CORE_INVENTORY_UNVERIFIED/u);
  assert.equal(iteratorCalls, 0);
});
