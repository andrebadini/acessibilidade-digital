import {
  AXE_ALLOWED_RULE_IDS,
  AXE_DIAGNOSTIC_CODES,
  AXE_PROVENANCE,
  AXE_TARGET_UNAVAILABLE,
  canonicalizeAxeDiagnostics,
  sanitizeAxeStructuralSelector,
} from '../../browser/axe-adapter.js';
import { CONSUMER_ACCESSIBILITY_FIXED_BASIS } from '../legal/consumer-basis.js';
import { axeNbrMappingForRule } from '../normative/axe-nbr-crosswalk.js';
import { NBR17225_ITEMS } from '../normative/nbr17225.js';
import { section508ReferencesForWcag } from '../normative/section508.js';
import { inconclusiveAxeText } from './result-text.js';

const ITEM_BY_ID = new Map(NBR17225_ITEMS.map(item => [item.id, item]));
const ALLOWED_RULE_IDS = new Set(AXE_ALLOWED_RULE_IDS);
const PRIORITY = Object.freeze({ cantTell: 1, failed: 2 });
const RULE_KEYS = Object.freeze(['classification', 'confidence', 'engineRuleId', 'impact', 'limitations', 'mode', 'nbrItems', 'outcome', 'ruleId', 'source', 'summary', 'targets', 'wcag']);
const OCCURRENCE_KEYS = Object.freeze(['accessiblePreview', 'applicabilityEvidence', 'classification', 'confidence', 'engineResultType', 'engineRuleId', 'equivalenceKey', 'evidenceIds', 'evidenceRefs', 'foreignBenchmarkRefs', 'framePath', 'impact', 'itemId', 'itemWcagRefs', 'justification', 'legalAnalysis', 'mode', 'nbrItemRef', 'nodeId', 'occurrenceId', 'outcome', 'pageId', 'presentationTargetKey', 'ruleId', 'selector', 'source', 'sourceWcagRefs', 'target', 'testedWcagRefs', 'wcagRefs']);
const CONFIRMATION_SUFFIX = ' A aplicabilidade ao item ABNT ainda exige confirmação pelo motor próprio ou revisão.';
const TOP_LEVEL_KEYS = Object.freeze(['diagnostics', 'limitations', 'occurrences', 'provenance', 'ruleResults', 'status', 'technicalSummary']);
const RESULT_TYPES = Object.freeze(['violations', 'incomplete', 'passes', 'inapplicable']);
const PARTIAL_LIMITATION = 'O motor suplementar axe-core teve cobertura parcial; somente resultados vinculados a frames concluídos foram considerados.';
const DISABLED_LIMITATION = 'O motor suplementar axe-core está desativado pelo gate MV3/CSP; o motor próprio Audita continuou sem sondar o axe.';
const TRUNCATED_LIMITATION = 'Os resultados axe excederam limites locais de segurança; contagens e achados publicados são truncados.';
const PROVENANCE_LIMITATION = 'A proveniência do resultado axe não corresponde ao pacote verificado; nenhum achado foi publicado.';
const DIAGNOSTIC_CODE_SET = new Set(AXE_DIAGNOSTIC_CODES);
const MAX_NORMALIZED_OCCURRENCES = 256;

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
  if (!exactKeys(target, ['framePath', 'message', 'nodeId', 'selector'])) return false;
  const nodeId = own(target, 'nodeId');
  return (nodeId === null || typeof nodeId === 'string' || Number.isSafeInteger(nodeId)) &&
    validSelector(own(target, 'selector')) && validFramePath(own(target, 'framePath')) && own(target, 'message') === rationale;
}

function validSelector(value) {
  return value === AXE_TARGET_UNAVAILABLE || sanitizeAxeStructuralSelector(value) === value;
}

function validateTopLevel(input, errors) {
  if (!exactKeys(input, TOP_LEVEL_KEYS)) errors.push('Payload axe superior possui esquema inválido.');
  const status = own(input, 'status');
  if (!['complete', 'partial', 'disabled'].includes(status)) errors.push('Status axe inválido.');
  const diagnostics = boundedArray(input, 'diagnostics', 64);
  const limitations = boundedArray(input, 'limitations', 4);
  if (!diagnostics || diagnostics.some(entry => !exactKeys(entry, ['code', 'frameId']) ||
    !DIAGNOSTIC_CODE_SET.has(own(entry, 'code')) ||
    (own(entry, 'frameId') !== null && (!Number.isSafeInteger(own(entry, 'frameId')) || own(entry, 'frameId') < 0)))) {
    errors.push('Diagnósticos axe inválidos.');
  }
  if (diagnostics && !exactData(diagnostics, canonicalizeAxeDiagnostics(diagnostics))) {
    errors.push('Diagnósticos axe não estão no conjunto único e na ordem canônica.');
  }
  if (!limitations || limitations.some(value => ![PARTIAL_LIMITATION, DISABLED_LIMITATION, TRUNCATED_LIMITATION, PROVENANCE_LIMITATION].includes(value))) {
    errors.push('Limitações axe inválidas.');
  }
  const diagnosticCodes = (diagnostics ?? []).map(entry => own(entry, 'code'));
  const truncated = diagnosticCodes.includes('AXE_RESULTS_TRUNCATED');
  const provenanceInvalid = diagnosticCodes.includes('AXE_PROVENANCE_INVALID');
  let expectedLimitations = null;
  if (status === 'complete') expectedLimitations = [];
  if (status === 'disabled') expectedLimitations = [DISABLED_LIMITATION];
  if (status === 'partial') {
    expectedLimitations = [PARTIAL_LIMITATION];
    if (truncated) expectedLimitations.push(TRUNCATED_LIMITATION);
    if (provenanceInvalid) expectedLimitations.push(PROVENANCE_LIMITATION);
  }
  if (!expectedLimitations || !exactData(limitations, expectedLimitations)) errors.push('Limitações axe não formam o conjunto canônico para o estado declarado.');
  if (status === 'complete' && (diagnostics?.length ?? 0) !== 0) errors.push('Execução axe completa contém diagnósticos.');
  if (status === 'disabled' && !exactData(diagnostics, [{ code: 'AXE_FEATURE_DISABLED', frameId: null }])) {
    errors.push('Execução axe desativada diverge do estado canônico.');
  }
  if (status !== 'disabled' && diagnosticCodes.includes('AXE_FEATURE_DISABLED')) errors.push('Diagnóstico de gate axe diverge do estado declarado.');
  if (provenanceInvalid && !exactData(diagnostics, [{ code: 'AXE_PROVENANCE_INVALID', frameId: null }])) {
    errors.push('Diagnóstico de proveniência axe não forma o estado canônico isolado.');
  }

  const summary = own(input, 'technicalSummary');
  if (!exactKeys(summary, RESULT_TYPES)) {
    errors.push('Resumo técnico axe possui esquema inválido.');
  } else {
    for (const type of RESULT_TYPES) {
      const count = own(summary, type);
      if (!exactKeys(count, ['groups', 'nodes']) || !Number.isSafeInteger(own(count, 'groups')) || !Number.isSafeInteger(own(count, 'nodes')) ||
        own(count, 'groups') < 0 || own(count, 'groups') > 6_400 || own(count, 'nodes') < 0 || own(count, 'nodes') > 640_000) {
        errors.push(`Resumo técnico axe inválido para ${type}.`);
      }
    }
  }
  const rules = boundedArray(input, 'ruleResults', MAX_NORMALIZED_OCCURRENCES);
  const occurrences = boundedArray(input, 'occurrences', MAX_NORMALIZED_OCCURRENCES);
  if (status === 'disabled' && (((rules?.length ?? 0) !== 0) || ((occurrences?.length ?? 0) !== 0) ||
    RESULT_TYPES.some(type => own(own(summary, type), 'groups') !== 0 || own(own(summary, type), 'nodes') !== 0))) {
    errors.push('Execução axe desativada publicou resultados.');
  }
  return { rules, occurrences, status, summary, truncated, provenanceInvalid };
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

function authoritativeCoreTarget(options, mapping, nodeId) {
  const coreRules = boundedArray(options, 'coreRuleResults', 256);
  if (!coreRules) return false;
  const candidates = coreRules.filter(rule => own(rule, 'ruleId') === mapping.auditaRuleId);
  if (candidates.length !== 1) return false;
  const rule = candidates[0];
  const expectedSource = { engine: 'audita-core', ruleId: mapping.auditaRuleId, version: '1.0.0' };
  const targets = boundedArray(rule, 'targets', 256);
  return own(rule, 'outcome') === 'failed' && own(rule, 'mode') === 'automated' &&
    exactData(own(rule, 'source'), expectedSource) && exactStrings(own(rule, 'nbrItems'), [mapping.nbrItemRef]) &&
    exactStrings(own(rule, 'wcag'), [...mapping.wcagRefs]) && targets !== null &&
    targets.filter(target => String(own(target, 'nodeId')) === String(nodeId)).length === 1;
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
  if (!ALLOWED_RULE_IDS.has(engineRuleId) || !mapping) {
    errors.push(`Regra ${ruleId} não pertence ao catálogo axe fechado.`);
    return null;
  }
  const expectedItems = [mapping.nbrItemRef];
  const expectedWcag = [...mapping.wcagRefs];
  const expectedClassification = ITEM_BY_ID.get(mapping.nbrItemRef)?.classification;
  if (!exactStrings(own(rule, 'nbrItems'), expectedItems) || !exactStrings(own(rule, 'wcag'), expectedWcag) ||
    own(rule, 'classification') !== expectedClassification || !exactKeys(rule, RULE_KEYS)) {
    errors.push(`Regra ${ruleId} diverge do crosswalk curado.`);
    return null;
  }
  const rationale = mapping.rationale;
  const targets = boundedArray(rule, 'targets', 256);
  const limitations = boundedArray(rule, 'limitations', 4);
  const inconclusive = inconclusiveAxeText(ITEM_BY_ID.get(mapping.nbrItemRef));
  const allowedJustifications = new Set([rationale, `${rationale}${CONFIRMATION_SUFFIX}`, inconclusive]);
  if (!targets || !limitations || ![rationale, inconclusive].includes(own(rule, 'summary')) ||
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
  const engineResultType = own(occurrence, 'engineResultType');
  const itemId = mapping?.nbrItemRef ?? null;
  const sourceWcag = mapping ? [...mapping.wcagRefs] : [];
  const itemWcag = itemId ? ITEM_BY_ID.get(itemId)?.wcag.map(reference => reference.id) ?? [] : [];
  const testedWcag = outcome === 'failed' ? sourceWcag : [];
  const classification = mapping ? ITEM_BY_ID.get(itemId)?.classification : 'best-practice';
  if (!['violations', 'incomplete'].includes(engineResultType) || !Object.hasOwn(PRIORITY, outcome) ||
    (engineResultType === 'incomplete' && outcome !== 'cantTell') || (outcome === 'failed' && engineResultType !== 'violations') ||
    own(occurrence, 'nbrItemRef') !== itemId || own(occurrence, 'itemId') !== itemId ||
    own(occurrence, 'classification') !== classification ||
    !exactStrings(own(occurrence, 'itemWcagRefs'), itemWcag) ||
    !exactStrings(own(occurrence, 'sourceWcagRefs'), sourceWcag) ||
    !exactStrings(own(occurrence, 'testedWcagRefs'), testedWcag) ||
    !exactStrings(own(occurrence, 'wcagRefs'), testedWcag) ||
    !exactData(own(occurrence, 'foreignBenchmarkRefs'), [...section508ReferencesForWcag(testedWcag)])) {
    errors.push(`Ocorrência de ${ruleId} diverge do crosswalk curado.`);
    return false;
  }
  const rationale = engineResultType === 'incomplete'
    ? inconclusiveAxeText(mapping ? ITEM_BY_ID.get(mapping.nbrItemRef) : null)
    : mapping?.rationale ?? UNMAPPED_RATIONALE;
  const justification = own(occurrence, 'justification');
  const target = own(occurrence, 'target');
  const selector = own(target, 'selector');
  const framePath = own(target, 'framePath');
  const occurrenceNodeId = own(occurrence, 'nodeId');
  const targetNodeId = own(target, 'nodeId');
  const nodeScopedBinding = mapping?.targetScope !== 'document' && occurrenceNodeId !== null;
  const expectedPresentationTargetKey = mapping?.targetScope === 'document'
    ? 'document'
    : nodeScopedBinding ? `node:${occurrenceNodeId}` : `selector:${frameIdFor(occurrence)}:${selector}`;
  const expectedJustification = engineResultType === 'violations' && mapping && outcome === 'cantTell'
    ? `${rationale}${CONFIRMATION_SUFFIX}`
    : rationale;
  // Historical exports used the exact curated rationale for incomplete too.
  // Accept that finite legacy wording without granting a confirmed outcome.
  const historicalIncompleteText = engineResultType === 'incomplete' && outcome === 'cantTell' &&
    mapping && justification === mapping.rationale;
  if ((justification !== expectedJustification && !historicalIncompleteText) ||
    !exactKeys(target, ['framePath', 'nodeId', 'selector']) || targetNodeId !== occurrenceNodeId ||
    (nodeScopedBinding
      ? (!(typeof occurrenceNodeId === 'string' || Number.isSafeInteger(occurrenceNodeId)) ||
        (engineRuleId !== 'target-size' && outcome !== 'cantTell') || frameIdFor(occurrence) !== 0 || selector === AXE_TARGET_UNAVAILABLE)
      : occurrenceNodeId !== null) || own(occurrence, 'selector') !== selector ||
    !exactData(own(occurrence, 'framePath'), framePath) || !validFramePath(framePath) || !validSelector(selector) ||
    !(/^(?:occurrence-axe-[0-9a-f]{8}|occurrence-[A-Za-z0-9._:-]{1,200}-\d{6})$/u.test(own(occurrence, 'occurrenceId')) ||
      (options?.batch === true && /^occurrence-axe-[0-9a-f]{32}$/u.test(own(occurrence, 'occurrenceId')))) ||
    !/^[A-Za-z0-9._:-]{1,200}$/u.test(own(occurrence, 'pageId')) ||
    own(occurrence, 'accessiblePreview') !== null || !exactData(own(occurrence, 'evidenceIds'), []) ||
    !exactData(own(occurrence, 'evidenceRefs'), []) || own(occurrence, 'mode') !== 'automated' ||
    !['minor', 'moderate', 'serious', 'critical'].includes(own(occurrence, 'impact')) ||
    own(occurrence, 'confidence') !== (outcome === 'failed' ? 'high' : 'low') ||
    own(occurrence, 'equivalenceKey') !== (mapping?.equivalenceKey ?? `axe:${engineRuleId}`) ||
    own(occurrence, 'presentationTargetKey') !== expectedPresentationTargetKey) {
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
    ...(mapping.targetScope === 'node' ? { nodeId: occurrenceNodeId } : {}),
    nbrItemRef: mapping.nbrItemRef,
    source: { engine: 'audita-core', ruleId: mapping.auditaRuleId, version: options.rulesVersion },
  };
  if (options.rulesVersion !== '1.0.0' || own(occurrence, 'equivalenceKey') !== mapping.equivalenceKey ||
    (mapping.targetScope === 'document' && (frameId !== 0 || selector !== 'html')) ||
    (mapping.targetScope === 'node' && (frameId !== 0 || !authoritativeCoreTarget(options, mapping, occurrenceNodeId))) ||
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
  const { rules, occurrences, status, summary, truncated, provenanceInvalid } = validateTopLevel(input, errors);
  if (!exactData(own(input, 'provenance'), AXE_PROVENANCE)) errors.push('Proveniência/configuração axe inválida.');
  if (!rules || !occurrences) errors.push('Coleções suplementares axe inválidas ou acima do limite.');
  const validatedRules = new Map();
  for (const rule of rules ?? []) {
    const checked = validateRule(rule, errors);
    if (!checked || validatedRules.has(checked.ruleId)) errors.push('Regra axe inválida ou duplicada.');
    else validatedRules.set(checked.ruleId, checked);
  }
  const strongest = new Map();
  const acceptedByRule = new Map();
  const acceptedByResultType = new Map([['violations', []], ['incomplete', []]]);
  const occurrenceIds = new Set();
  const conclusiveNodeBindings = new Set();
  for (const occurrence of occurrences ?? []) {
    const occurrenceId = own(occurrence, 'occurrenceId');
    if (occurrenceIds.has(occurrenceId)) {
      errors.push('Ocorrência axe duplicada.');
      continue;
    }
    occurrenceIds.add(occurrenceId);
    const checkedRule = validatedRules.get(own(occurrence, 'ruleId'));
    if (!checkedRule || !validateOccurrence(occurrence, checkedRule, options, errors)) continue;
    if (checkedRule.mapping?.targetScope === 'node' && own(occurrence, 'outcome') === 'failed') {
      const binding = [checkedRule.engineRuleId, own(occurrence, 'pageId'), frameIdFor(occurrence),
        own(occurrence, 'nodeId'), own(occurrence, 'selector')].join('\u0000');
      if (conclusiveNodeBindings.has(binding)) {
        errors.push('Conclusão axe por nó está duplicada.');
        continue;
      }
      conclusiveNodeBindings.add(binding);
    }
    const previous = strongest.get(checkedRule.ruleId);
    const outcome = own(occurrence, 'outcome');
    if (!previous || PRIORITY[outcome] > PRIORITY[previous]) strongest.set(checkedRule.ruleId, outcome);
    const accepted = acceptedByRule.get(checkedRule.ruleId) ?? [];
    accepted.push(occurrence);
    acceptedByRule.set(checkedRule.ruleId, accepted);
    acceptedByResultType.get(own(occurrence, 'engineResultType')).push(occurrence);
  }
  for (const checked of validatedRules.values()) {
    if (strongest.get(checked.ruleId) !== checked.outcome) errors.push(`Agregação declarada de ${checked.ruleId} não corresponde às ocorrências.`);
    const accepted = acceptedByRule.get(checked.ruleId) ?? [];
    const mapping = axeNbrMappingForRule(own(checked.rule, 'engineRuleId'));
    const incompleteOccurrences = accepted.filter(occurrence => own(occurrence, 'engineResultType') === 'incomplete');
    const historical = incompleteOccurrences.length > 0 && incompleteOccurrences.every(occurrence =>
      own(occurrence, 'justification') === mapping?.rationale);
    const expectedSummary = checked.outcome !== 'failed' && incompleteOccurrences.length > 0 && !historical
      ? inconclusiveAxeText(ITEM_BY_ID.get(mapping?.nbrItemRef)) : mapping?.rationale;
    const impactOrder = ['minor', 'moderate', 'serious', 'critical'];
    const strongestImpact = accepted.reduce((current, occurrence) =>
      impactOrder.indexOf(own(occurrence, 'impact')) > impactOrder.indexOf(current) ? own(occurrence, 'impact') : current, 'minor');
    const expectedTargets = accepted.map(occurrence => ({
      nodeId: own(occurrence, 'nodeId'),
      selector: own(own(occurrence, 'target'), 'selector'),
      framePath: own(own(occurrence, 'target'), 'framePath'),
      message: own(occurrence, 'justification'),
    }));
    if (own(checked.rule, 'summary') !== expectedSummary || own(checked.rule, 'impact') !== strongestImpact ||
      own(checked.rule, 'confidence') !== (checked.outcome === 'failed' ? 'high' : 'low') ||
      !exactData(own(checked.rule, 'targets'), expectedTargets)) {
      errors.push(`Resumo da regra ${checked.ruleId} não foi derivado das ocorrências aceitas.`);
    }
  }
  const summaryIsNumeric = summary && RESULT_TYPES.every(type => {
    const value = own(summary, type);
    return Number.isSafeInteger(own(value, 'groups')) && Number.isSafeInteger(own(value, 'nodes'));
  });
  if (summaryIsNumeric && occurrences) {
    const mismatch = ['violations', 'incomplete'].some(resultType => {
      const accepted = acceptedByResultType.get(resultType);
      const expectedGroups = new Set(accepted.map(occurrence =>
        `${own(occurrence, 'engineRuleId')}\u0000${frameIdFor(occurrence)}`)).size;
      const declared = own(summary, resultType);
      return own(declared, 'nodes') !== accepted.length || own(declared, 'groups') !== expectedGroups;
    });
    if (mismatch) {
      errors.push('Resumo técnico axe não corresponde às ocorrências retidas e ao estado de truncamento.');
    }
  }
  if (provenanceInvalid && ((rules?.length ?? 0) !== 0 || (occurrences?.length ?? 0) !== 0 ||
    RESULT_TYPES.some(type => own(own(summary, type), 'groups') !== 0 || own(own(summary, type), 'nodes') !== 0))) {
    errors.push('Falha de proveniência axe publicou contagens ou achados.');
  }
  if (errors.length > 0) return Object.freeze({ errors: Object.freeze(errors), ruleResults: Object.freeze([]), occurrences: Object.freeze([]) });
  return Object.freeze({
    errors: Object.freeze([]),
    ruleResults: Object.freeze([...validatedRules.values()].map(value => value.rule)),
    occurrences: Object.freeze([...(occurrences ?? [])]),
  });
}
