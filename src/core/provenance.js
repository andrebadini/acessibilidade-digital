import { AXE_PROVENANCE } from '../browser/axe-adapter.js';
import { NBR17225_ITEMS } from './normative/nbr17225.js';

export const AUDITA_RULES_VERSION = '1.0.0';

const CORE_RULE_IDS = new Set(NBR17225_ITEMS.flatMap(item => item.ruleIds));
const SOURCE_KEYS = Object.freeze(['engine', 'ruleId', 'version']);
const AXE_SOURCE_KEYS = Object.freeze([...SOURCE_KEYS, 'engineRuleId']);

/** Returns the sole locally registered source for a supported rule identity. */
export function registeredRuleSource(rule, rulesVersion) {
  const ruleId = rule?.ruleId;
  if (typeof ruleId !== 'string' || rulesVersion !== AUDITA_RULES_VERSION) return null;
  if (CORE_RULE_IDS.has(ruleId) && rule?.engineRuleId === undefined) {
    return Object.freeze({ engine: 'audita-core', ruleId, version: AUDITA_RULES_VERSION });
  }
  if (ruleId === 'editorial.placeholder-text' && rule?.engineRuleId === undefined) {
    return Object.freeze({ engine: 'audita-editorial', ruleId, version: AUDITA_RULES_VERSION });
  }
  const engineRuleId = rule?.engineRuleId;
  if (typeof engineRuleId === 'string' && ruleId === `axe.${engineRuleId}`) {
    return Object.freeze({
      engine: AXE_PROVENANCE.engine,
      ruleId,
      version: AXE_PROVENANCE.version,
      engineRuleId,
    });
  }
  return null;
}

/** Returns the registered source for an occurrence, including manual review. */
export function registeredOccurrenceSource(occurrence, rulesVersion) {
  if (rulesVersion !== AUDITA_RULES_VERSION) return null;
  if (occurrence?.ruleId === null && typeof occurrence?.nbrItemRef === 'string' &&
    occurrence?.source?.ruleId === `manual:${occurrence.nbrItemRef}`) {
    return Object.freeze({
      engine: 'audita-manual-review',
      ruleId: `manual:${occurrence.nbrItemRef}`,
      version: AUDITA_RULES_VERSION,
    });
  }
  return registeredRuleSource({
    ruleId: occurrence?.source?.ruleId,
    engineRuleId: occurrence?.engineRuleId ?? occurrence?.source?.engineRuleId,
  }, rulesVersion);
}

export function hasRegisteredSource(actual, expected) {
  if (!actual || !expected || typeof actual !== 'object' || Array.isArray(actual)) return false;
  const expectedKeys = Object.hasOwn(expected, 'engineRuleId') ? AXE_SOURCE_KEYS : SOURCE_KEYS;
  let keys;
  try { keys = Object.keys(actual).sort(); } catch { return false; }
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== [...expectedKeys].sort()[index])) {
    return false;
  }
  return expectedKeys.every(key => actual[key] === expected[key]);
}

export function isCoreRuleId(ruleId) {
  return CORE_RULE_IDS.has(ruleId);
}
