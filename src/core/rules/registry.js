import { TEST_MODES } from '../result.js';

const RULE_FIELDS = Object.freeze(['id', 'mode', 'nbrItems', 'evaluate']);
const EDITORIAL_RULE_FIELDS = Object.freeze([
  'id', 'mode', 'classification', 'impact', 'confidence', 'source', 'evaluate'
]);

function hasOwn(value, field) {
  return value !== null && typeof value === 'object' && Object.hasOwn(value, field);
}

function requireOwnRuleFields(definition) {
  if (!RULE_FIELDS.every(field => hasOwn(definition, field))) {
    throw new TypeError('Rule definition fields must be own properties');
  }
}

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

function normalizeWcag(wcag) {
  if (!Array.isArray(wcag)) {
    throw new TypeError('Rule WCAG metadata must be a non-empty array');
  }

  const normalized = [];
  const seen = new Set();
  for (const criterionId of wcag) {
    const id = normalizedString(criterionId, 'Rule WCAG criterion ID');
    if (!seen.has(id)) {
      seen.add(id);
      normalized.push(id);
    }
  }

  if (normalized.length === 0) {
    throw new TypeError('Rule WCAG metadata must be a non-empty array');
  }
  return Object.freeze(normalized);
}

function existingRuleIds(existingRules) {
  if (!Array.isArray(existingRules)) {
    throw new TypeError('Existing rules must be an array');
  }

  return new Set(existingRules.map(rule => {
    if (!hasOwn(rule, 'id')) {
      throw new TypeError('Existing rule ID must be an own property');
    }
    return normalizedString(rule.id, 'Existing rule ID');
  }));
}

/**
 * Validates one independently composable rule. Pass an explicit `existingRules`
 * array when registering incrementally; no process-wide registry is kept.
 */
export function registerRule(definition, existingRules = []) {
  if (definition === null || typeof definition !== 'object') {
    throw new TypeError('Rule definition must be an object');
  }

  requireOwnRuleFields(definition);
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
    ...(hasOwn(definition, 'wcag') ? { wcag: normalizeWcag(definition.wcag) } : {}),
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

function ownData(value, field) {
  try {
    const descriptor = value !== null && typeof value === 'object'
      ? Object.getOwnPropertyDescriptor(value, field)
      : null;
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function registerEditorialRule(definition, existingIds) {
  if (!definition || typeof definition !== 'object' ||
    !EDITORIAL_RULE_FIELDS.every(field => ownData(definition, field) !== undefined)) {
    throw new TypeError('Editorial rule fields must be own data properties');
  }
  const id = normalizedString(ownData(definition, 'id'), 'Editorial rule ID');
  if (existingIds.has(id)) throw new TypeError(`Duplicate editorial rule ID: ${id}`);
  if (ownData(definition, 'mode') !== 'automated' || ownData(definition, 'classification') !== 'editorial' ||
    ownData(definition, 'impact') !== 'minor' || ownData(definition, 'confidence') !== 'high') {
    throw new TypeError('Editorial rule metadata is invalid');
  }
  const source = ownData(definition, 'source');
  if (!source || typeof source !== 'object' || ownData(source, 'engine') !== 'audita-editorial' ||
    ownData(source, 'version') !== '1.0.0') {
    throw new TypeError('Editorial rule source is invalid');
  }
  const evaluate = ownData(definition, 'evaluate');
  if (typeof evaluate !== 'function') throw new TypeError('Editorial rule evaluator must be a function');
  return Object.freeze({
    id,
    mode: 'automated',
    classification: 'editorial',
    impact: 'minor',
    confidence: 'high',
    source: Object.freeze({ engine: 'audita-editorial', version: '1.0.0' }),
    evaluate,
  });
}

/** Keeps non-normative editorial definitions outside the NBR rule contract. */
export function createEditorialRuleRegistry(definitions = []) {
  if (!Array.isArray(definitions)) throw new TypeError('Editorial definitions must be an array');
  const ids = new Set();
  const rules = [];
  for (let index = 0; index < definitions.length; index += 1) {
    let definition;
    try {
      const descriptor = Object.getOwnPropertyDescriptor(definitions, String(index));
      definition = descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
    } catch {
      definition = undefined;
    }
    const rule = registerEditorialRule(definition, ids);
    ids.add(rule.id);
    rules.push(rule);
  }
  return Object.freeze(rules);
}
