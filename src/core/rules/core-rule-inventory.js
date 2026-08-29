import { CORE_RULES } from '../audit.js';
import { AUDITA_RULES_VERSION } from '../provenance.js';
import { canonicalStringify } from '../report/canonical-json.js';
import { sha256Hex } from '../report/hash.js';

export const CORE_INVENTORY_VERSION = 'CoreRuleInventoryV1';
const INVENTORY_KEYS = Object.freeze(['inventoryVersion', 'rulesVersion', 'ruleIds', 'sha256']);
const INSTALLED_RULE_IDS = Object.freeze(CORE_RULES.map(rule => rule.id).sort((a, b) => a.localeCompare(b)));

function ownData(value, key) {
  try {
    const descriptor = value && typeof value === 'object'
      ? Object.getOwnPropertyDescriptor(value, key)
      : null;
    return descriptor && descriptor.enumerable && Object.hasOwn(descriptor, 'value')
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

function exactKeys(value, expected) {
  try {
    const keys = Reflect.ownKeys(value);
    return keys.length === expected.length && expected.every(key => keys.includes(key));
  } catch {
    return false;
  }
}

function validRuleIds(ruleIds) {
  if (!Array.isArray(ruleIds) || Object.getPrototypeOf(ruleIds) !== Array.prototype ||
    ruleIds.length !== INSTALLED_RULE_IDS.length) return false;
  let keys;
  try { keys = Reflect.ownKeys(ruleIds); } catch { return false; }
  const expected = ['length', ...INSTALLED_RULE_IDS.map((_value, index) => String(index))];
  if (keys.length !== expected.length || expected.some(key => !keys.includes(key))) return false;
  for (let index = 0; index < ruleIds.length; index += 1) {
    if (ownData(ruleIds, String(index)) !== INSTALLED_RULE_IDS[index]) return false;
  }
  return true;
}

async function inventoryHash(inventoryVersion, rulesVersion, ruleIds) {
  return sha256Hex(canonicalStringify({ inventoryVersion, rulesVersion, ruleIds }));
}

export async function createInstalledCoreRuleInventory() {
  const ruleIds = [...INSTALLED_RULE_IDS];
  const sha256 = await inventoryHash(CORE_INVENTORY_VERSION, AUDITA_RULES_VERSION, ruleIds);
  return Object.freeze({
    inventoryVersion: CORE_INVENTORY_VERSION,
    rulesVersion: AUDITA_RULES_VERSION,
    ruleIds: Object.freeze(ruleIds),
    sha256,
  });
}

export async function verifyCoreRuleInventory(inventory) {
  try {
    if (!inventory || typeof inventory !== 'object' || Array.isArray(inventory) ||
      !exactKeys(inventory, INVENTORY_KEYS)) throw new TypeError();
    const inventoryVersion = ownData(inventory, 'inventoryVersion');
    const rulesVersion = ownData(inventory, 'rulesVersion');
    const ruleIds = ownData(inventory, 'ruleIds');
    const sha256 = ownData(inventory, 'sha256');
    if (inventoryVersion !== CORE_INVENTORY_VERSION || rulesVersion !== AUDITA_RULES_VERSION ||
      !validRuleIds(ruleIds) || typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(sha256)) {
      throw new TypeError();
    }
    const copiedIds = Array.from({ length: ruleIds.length }, (_value, index) => ownData(ruleIds, String(index)));
    if (await inventoryHash(inventoryVersion, rulesVersion, copiedIds) !== sha256) throw new TypeError();
    return Object.freeze({
      inventoryVersion,
      rulesVersion,
      ruleIds: Object.freeze(copiedIds),
      sha256,
    });
  } catch {
    throw new TypeError('CORE_INVENTORY_UNVERIFIED');
  }
}
