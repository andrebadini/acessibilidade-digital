import { TEST_MODES } from '../result.js';

function normalizedString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${label} must be a non-empty string`);
  }

  return value.trim();
}

function normalizeNbrItems(nbrItems) {
  if (!Array.isArray(nbrItems)) {
    throw new TypeError('Rule nbrItems must be a non-empty array');
  }

  const normalized = [];
  const seen = new Set();
  for (const itemId of nbrItems) {
    const id = normalizedString(itemId, 'Rule item ID');
    if (!seen.has(id)) {
      seen.add(id);
      normalized.push(id);
    }
  }

  if (normalized.length === 0) {
    throw new TypeError('Rule nbrItems must be a non-empty array');
  }

  return Object.freeze(normalized);
}

function existingRuleIds(existingRules) {
  if (!Array.isArray(existingRules)) {
    throw new TypeError('Existing rules must be an array');
  }

  return new Set(existingRules.map(rule => normalizedString(rule?.id, 'Existing rule ID')));
}

/**
 * Validates one independently composable rule. Pass an explicit `existingRules`
 * array when registering incrementally; no process-wide registry is kept.
 */
export function registerRule(definition, existingRules = []) {
  if (definition === null || typeof definition !== 'object') {
    throw new TypeError('Rule definition must be an object');
  }

  const id = normalizedString(definition.id, 'Rule ID');
  const ids = existingRuleIds(existingRules);
  if (ids.has(id)) {
    throw new TypeError(`Duplicate rule ID: ${id}`);
  }
  if (!TEST_MODES.includes(definition.mode)) {
    throw new TypeError('Rule mode is invalid');
  }
  if (typeof definition.evaluate !== 'function') {
    throw new TypeError('Rule evaluate must be a function');
  }

  return Object.freeze({
    id,
    mode: definition.mode,
    nbrItems: normalizeNbrItems(definition.nbrItems),
    evaluate: definition.evaluate
  });
}

/**
 * Creates a frozen, deterministic rule list and checks duplicate IDs within
 * this explicit composition boundary.
 */
export function createRuleRegistry(definitions = []) {
  if (!Array.isArray(definitions)) {
    throw new TypeError('Rule definitions must be an array');
  }

  const rules = [];
  for (const definition of definitions) {
    rules.push(registerRule(definition, rules));
  }
  return Object.freeze(rules);
}
