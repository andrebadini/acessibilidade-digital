import { AXE_PROVENANCE } from '../../browser/axe-adapter.js';
import { CONSUMER_ACCESSIBILITY_FIXED_BASIS } from '../legal/consumer-basis.js';
import { axeNbrMappingForRule } from '../normative/axe-nbr-crosswalk.js';
import { NBR17225_ITEMS } from '../normative/nbr17225.js';
import { section508ReferencesForWcag } from '../normative/section508.js';

const ITEM_BY_ID = new Map(NBR17225_ITEMS.map(item => [item.id, item]));
const PRIORITY = Object.freeze({ cantTell: 1, failed: 2 });
const RULE_KEYS = Object.freeze(['classification', 'confidence', 'engineRuleId', 'impact', 'limitations', 'mode', 'nbrItems', 'outcome', 'ruleId', 'source', 'summary', 'targets', 'wcag']);
const OCCURRENCE_KEYS = Object.freeze(['accessiblePreview', 'applicabilityEvidence', 'classification', 'confidence', 'engineRuleId', 'equivalenceKey', 'evidenceIds', 'evidenceRefs', 'foreignBenchmarkRefs', 'framePath', 'impact', 'itemId', 'justification', 'legalAnalysis', 'mode', 'nbrItemRef', 'nodeId', 'occurrenceId', 'outcome', 'pageId', 'presentationTargetKey', 'ruleId', 'selector', 'source', 'target', 'wcagRefs']);
const UNMAPPED_RATIONALE = 'Achado suplementar do axe-core sem vínculo curado com item ABNT.';
const CONFIRMATION_SUFFIX = ' A aplicabilidade ao item ABNT ainda exige confirmação pelo motor próprio ou revisão.';

function own(value, key) {
  try {
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  } catch { return undefined; }
}

function exactData(actual, expected, seen = new WeakMap()) {
  if (actual === expected) return true;
  if (!actual || !expected || typeof actual !== 'object' || typeof expected !== 'object') return false;
  let actualArray;
  let expectedArray;
  try { actualArray = Array.isArray(actual); expectedArray = Array.isArray(expected); } catch { return false; }
  if (actualArray !== expectedArray) return false;
  if (seen.get(actual) === expected) return true;
  seen.set(actual, expected);
  let actualKeys;
  let expectedKeys;
  try {
    actualKeys = Object.keys(actual).sort();
    expectedKeys = Object.keys(expected).sort();
  } catch { return false; }
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) return false;
  return expectedKeys.every(key => {
    const actualDescriptor = (() => { try { return Object.getOwnPropertyDescriptor(actual, key); } catch { return null; } })();
    const expectedDescriptor = Object.getOwnPropertyDescriptor(expected, key);
    return actualDescriptor && expectedDescriptor && Object.hasOwn(actualDescriptor, 'value') &&
      Object.hasOwn(expectedDescriptor, 'value') && exactData(actualDescriptor.value, expectedDescriptor.value, seen);
  });
}

function boundedArray(value, key, max = 512) {
  const array = own(value, key);
  try { if (!Array.isArray(array)) return null; } catch { return null; }
  const length = own(array, 'length');
  if (!Number.isSafeInteger(length) || length < 0 || length > max) return null;
  const output = [];
  for (let index = 0; index < length; index += 1) output.push(own(array, String(index)));
  return output;
}

function exactStrings(actual, expected) {
  let actualArray;
  try { actualArray = Array.isArray(actual); } catch { return false; }
  if (!actualArray || own(actual, 'length') !== expected.length) return false;
  for (let index = 0; index < expected.length; index += 1) if (own(actual, String(index)) !== expected[index]) return false;
  return true;
}

function exactKeys(value, expected) {
  let keys;
  try { keys = Object.keys(value).sort(); } catch { return false; }
  return exactStrings(keys, [...expected].sort()) && keys.every(key => {
    const descriptor = (() => { try { return Object.getOwnPropertyDescriptor(value, key); } catch { return null; } })();
    return descriptor && Object.hasOwn(descriptor, 'value');
  });
}

function validFramePath(value) {
  try { if (!Array.isArray(value)) return false; } catch { return false; }
  const length = own(value, 'length');
  return length === 0 || (length === 1 && /^frame:\d+$/u.test(own(value, '0')));
}

function validTarget(target, rationale) {
  if (!exactKeys(target, ['framePath', 'message', 'selector'])) return false;
  return validSelector(own(target, 'selector')) && validFramePath(own(target, 'framePath')) && own(target, 'message') === rationale;
}

function validSelector(value) {
  if (value === '[target-unavailable]') return true;
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 || /[#.[\],+~='"\\]/u.test(value)) return false;
  return value.split(/\s*>\s*|\s+/u).every(token => /^[a-z][a-z0-9-]{0,31}(?::nth-of-type\([1-9]\d{0,3}\))?$/iu.test(token));
}

function exactSource(source, ruleId, engineRuleId) {
  return exactData(source, {
    engine: AXE_PROVENANCE.engine,
    ruleId,
    version: AXE_PROVENANCE.version,
    engineRuleId,
  });
}

function frameIdFor(occurrence) {
  const path = own(own(occurrence, 'target'), 'framePath');
  try { if (!Array.isArray(path)) return null; } catch { return null; }
  const length = own(path, 'length');
  if (length === 0) return 0;
  if (length !== 1) return null;
  const value = own(path, '0');
  const match = typeof value === 'string' ? value.match(/^frame:(\d+)$/u) : null;
  return match && Number.isSafeInteger(Number(match[1])) ? Number(match[1]) : null;
}

function validateRule(rule, errors) {
  const ruleId = own(rule, 'ruleId');
  const engineRuleId = own(rule, 'engineRuleId');
  if (typeof engineRuleId !== 'string' || !/^[a-z][a-z0-9-]{0,127}$/u.test(engineRuleId) || ruleId !== `axe.${engineRuleId}` || !exactSource(own(rule, 'source'), ruleId, engineRuleId)) {
    errors.push('Regra axe possui identidade ou proveniência inválida.');
    return null;
  }
  const outcome = own(rule, 'outcome');
  if (!Object.hasOwn(PRIORITY, outcome) || own(rule, 'mode') !== 'automated') {
    errors.push(`Regra ${ruleId} possui resultado não autorizado.`);
    return null;
  }
  const mapping = axeNbrMappingForRule(engineRuleId);
  const expectedItems = mapping ? [mapping.nbrItemRef] : [];
  const expectedWcag = mapping ? [...mapping.wcagRefs] : [];
  const expectedClassification = mapping ? ITEM_BY_ID.get(mapping.nbrItemRef)?.classification : 'best-practice';
  if (!exactStrings(own(rule, 'nbrItems'), expectedItems) || !exactStrings(own(rule, 'wcag'), expectedWcag) ||
    own(rule, 'classification') !== expectedClassification || !exactKeys(rule, RULE_KEYS)) {
    errors.push(`Regra ${ruleId} diverge do crosswalk curado.`);
    return null;
  }
  const rationale = mapping?.rationale ?? UNMAPPED_RATIONALE;
  const targets = boundedArray(rule, 'targets', 256);
  const limitations = boundedArray(rule, 'limitations', 4);
  const allowedJustifications = new Set([rationale, `${rationale}${CONFIRMATION_SUFFIX}`]);
  if (!targets || !limitations || own(rule, 'summary') !== rationale ||
    targets.some(target => !allowedJustifications.has(own(target, 'message')) || !validTarget(target, own(target, 'message'))) ||
    limitations.some(value => value !== 'A aplicabilidade ABNT não foi confirmada; o resultado permanece cantTell.') ||
    !['minor', 'moderate', 'serious', 'critical'].includes(own(rule, 'impact')) ||
    !['low', 'high'].includes(own(rule, 'confidence'))) {
    errors.push(`Regra ${ruleId} contém payload não canônico.`);
    return null;
  }
  return { rule, ruleId, engineRuleId, mapping, outcome };
}

function validateOccurrence(occurrence, validatedRule, options, errors) {
  const { ruleId, engineRuleId, mapping } = validatedRule;
  if (!exactKeys(occurrence, OCCURRENCE_KEYS) || own(occurrence, 'ruleId') !== ruleId || own(occurrence, 'engineRuleId') !== engineRuleId ||
    !exactSource(own(occurrence, 'source'), ruleId, engineRuleId)) {
    errors.push(`Ocorrência de ${ruleId} possui origem inválida.`);
    return false;
  }
  const outcome = own(occurrence, 'outcome');
  const itemId = mapping?.nbrItemRef ?? null;
  const wcag = mapping ? [...mapping.wcagRefs] : [];
  const classification = mapping ? ITEM_BY_ID.get(itemId)?.classification : 'best-practice';
  if (!Object.hasOwn(PRIORITY, outcome) || own(occurrence, 'nbrItemRef') !== itemId || own(occurrence, 'itemId') !== itemId ||
    own(occurrence, 'classification') !== classification || !exactStrings(own(occurrence, 'wcagRefs'), wcag) ||
    !exactData(own(occurrence, 'foreignBenchmarkRefs'), [...section508ReferencesForWcag(wcag)])) {
    errors.push(`Ocorrência de ${ruleId} diverge do crosswalk curado.`);
    return false;
  }
  const rationale = mapping?.rationale ?? UNMAPPED_RATIONALE;
  const justification = own(occurrence, 'justification');
  const target = own(occurrence, 'target');
  const selector = own(target, 'selector');
  const framePath = own(target, 'framePath');
  if (!new Set([rationale, `${rationale}${CONFIRMATION_SUFFIX}`]).has(justification) ||
    !exactKeys(target, ['framePath', 'nodeId', 'selector']) || own(target, 'nodeId') !== null ||
    own(occurrence, 'nodeId') !== null || own(occurrence, 'selector') !== selector ||
    !exactData(own(occurrence, 'framePath'), framePath) || !validFramePath(framePath) || !validSelector(selector) ||
    !/^occurrence-axe-[0-9a-f]{8}$/u.test(own(occurrence, 'occurrenceId')) ||
    !/^[A-Za-z0-9._:-]{1,200}$/u.test(own(occurrence, 'pageId')) ||
    own(occurrence, 'accessiblePreview') !== null || !exactData(own(occurrence, 'evidenceIds'), []) ||
    !exactData(own(occurrence, 'evidenceRefs'), []) || own(occurrence, 'mode') !== 'automated' ||
    !['minor', 'moderate', 'serious', 'critical'].includes(own(occurrence, 'impact')) ||
    own(occurrence, 'confidence') !== (outcome === 'failed' ? 'high' : 'low') ||
    own(occurrence, 'equivalenceKey') !== (mapping?.equivalenceKey ?? `axe:${engineRuleId}`) ||
    own(occurrence, 'presentationTargetKey') !== (mapping?.targetScope === 'document' ? 'document' : `selector:${frameIdFor(occurrence)}:${selector}`)) {
    errors.push(`Ocorrência de ${ruleId} contém payload não canônico.`);
    return false;
  }
  const legal = own(occurrence, 'legalAnalysis');
  if (outcome !== 'failed') {
    if (legal !== null || own(occurrence, 'applicabilityEvidence') !== null) {
      errors.push(`Ocorrência inconclusiva de ${ruleId} contém estado normativo conclusivo.`);
      return false;
    }
    return true;
  }
  if (!mapping) {
    if (legal !== null) errors.push(`Achado não mapeado ${ruleId} contém base jurídica.`);
    return legal === null;
  }
  if (!mapping.auditaRuleId || !mapping.equivalenceKey) {
    errors.push(`Ocorrência ${ruleId} não possui equivalência curada para conclusão automática.`);
    return false;
  }
  const frameId = frameIdFor(occurrence);
  const proof = own(occurrence, 'applicabilityEvidence');
  const expectedProof = {
    confirmed: true,
    pageId: own(occurrence, 'pageId'),
    frameId,
    target: selector,
    nbrItemRef: mapping.nbrItemRef,
    source: { engine: 'audita-core', ruleId: mapping.auditaRuleId, version: options.rulesVersion },
  };
  if (options.rulesVersion !== '1.0.0' || own(occurrence, 'equivalenceKey') !== mapping.equivalenceKey ||
    (mapping.targetScope === 'document' && (frameId !== 0 || selector !== 'html')) ||
    frameId === null || typeof selector !== 'string' || !exactData(proof, expectedProof) ||
    !ITEM_BY_ID.get(mapping.nbrItemRef)?.ruleIds.includes(mapping.auditaRuleId) ||
    !exactData(legal, { basisRef: CONSUMER_ACCESSIBILITY_FIXED_BASIS.id })) {
    errors.push(`Ocorrência conclusiva de ${ruleId} não possui prova de aplicabilidade autoritativa.`);
    return false;
  }
  return true;
}

/**
 * Single integrity boundary for normalized supplemental axe records. Any
 * inconsistency rejects the whole supplemental cluster conservatively.
 */
export function validateNormalizedAxeSupplemental(input, options = {}) {
  const errors = [];
  if (!exactData(own(input, 'provenance'), AXE_PROVENANCE)) errors.push('Proveniência/configuração axe inválida.');
  const rules = boundedArray(input, 'ruleResults');
  const occurrences = boundedArray(input, 'occurrences', 1024);
  if (!rules || !occurrences) errors.push('Coleções suplementares axe inválidas ou acima do limite.');
  const validatedRules = new Map();
  for (const rule of rules ?? []) {
    const checked = validateRule(rule, errors);
    if (!checked || validatedRules.has(checked.ruleId)) errors.push('Regra axe inválida ou duplicada.');
    else validatedRules.set(checked.ruleId, checked);
  }
  const strongest = new Map();
  const acceptedByRule = new Map();
  for (const occurrence of occurrences ?? []) {
    const checkedRule = validatedRules.get(own(occurrence, 'ruleId'));
    if (!checkedRule || !validateOccurrence(occurrence, checkedRule, options, errors)) continue;
    const previous = strongest.get(checkedRule.ruleId);
    const outcome = own(occurrence, 'outcome');
    if (!previous || PRIORITY[outcome] > PRIORITY[previous]) strongest.set(checkedRule.ruleId, outcome);
    const accepted = acceptedByRule.get(checkedRule.ruleId) ?? [];
    accepted.push(occurrence);
    acceptedByRule.set(checkedRule.ruleId, accepted);
  }
  for (const checked of validatedRules.values()) {
    if (strongest.get(checked.ruleId) !== checked.outcome) errors.push(`Agregação declarada de ${checked.ruleId} não corresponde às ocorrências.`);
    const accepted = acceptedByRule.get(checked.ruleId) ?? [];
    const impactOrder = ['minor', 'moderate', 'serious', 'critical'];
    const strongestImpact = accepted.reduce((current, occurrence) =>
      impactOrder.indexOf(own(occurrence, 'impact')) > impactOrder.indexOf(current) ? own(occurrence, 'impact') : current, 'minor');
    const expectedTargets = accepted.map(occurrence => ({
      selector: own(own(occurrence, 'target'), 'selector'),
      framePath: own(own(occurrence, 'target'), 'framePath'),
      message: own(occurrence, 'justification'),
    }));
    if (own(checked.rule, 'impact') !== strongestImpact ||
      own(checked.rule, 'confidence') !== (checked.outcome === 'failed' ? 'high' : 'low') ||
      !exactData(own(checked.rule, 'targets'), expectedTargets)) {
      errors.push(`Resumo da regra ${checked.ruleId} não foi derivado das ocorrências aceitas.`);
    }
  }
  if (errors.length > 0) return Object.freeze({ errors: Object.freeze(errors), ruleResults: Object.freeze([]), occurrences: Object.freeze([]) });
  return Object.freeze({
    errors: Object.freeze([]),
    ruleResults: Object.freeze([...validatedRules.values()].map(value => value.rule)),
    occurrences: Object.freeze([...(occurrences ?? [])]),
  });
}
