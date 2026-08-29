import {
  AXE_ALLOWED_RULE_IDS,
  AXE_PROVENANCE,
  AXE_TARGET_UNAVAILABLE,
  canonicalizeAxeDiagnosticsWithMetadata,
  sanitizeAxeStructuralSelector,
} from '../../browser/axe-adapter.js';
import { CONSUMER_ACCESSIBILITY_FIXED_BASIS } from '../legal/consumer-basis.js';
import { NBR17225_ITEMS } from '../normative/nbr17225.js';
import { axeNbrMappingForRule } from '../normative/axe-nbr-crosswalk.js';
import { section508ReferencesForWcag } from '../normative/section508.js';

const MAX_FRAMES = 64;
const MAX_GROUPS_PER_TYPE = 100;
const MAX_NODES_PER_GROUP = 100;
const MAX_OCCURRENCES = 256;
const MAX_RAW_DIAGNOSTICS = 256;
const AUDITA_RULES_VERSION = '1.0.0';
const SAFE_ID = /^[a-z][a-z0-9._:-]{0,127}$/iu;
const OUTCOME_PRIORITY = Object.freeze({ failed: 3, cantTell: 2, untested: 1 });
const ITEM_BY_ID = new Map(NBR17225_ITEMS.map(item => [item.id, item]));
const ALLOWED_RULE_IDS = new Set(AXE_ALLOWED_RULE_IDS);

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value) || Object.isFrozen(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function readOwnData(value, property) {
  try {
    if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
      return { value: undefined, readable: false, ownData: false };
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, property);
    if (!descriptor) return { value: undefined, readable: true, ownData: false };
    if (!Object.hasOwn(descriptor, 'value')) return { value: undefined, readable: false, ownData: false };
    return { value: descriptor.value, readable: true, ownData: true };
  } catch { return { value: undefined, readable: false, ownData: false }; }
}

function safeRead(value, property) {
  return readOwnData(value, property).value;
}

function safeIsArray(value) {
  try { return Array.isArray(value); } catch { return false; }
}

function inspectArray(value, property, max = MAX_OCCURRENCES) {
  const propertyRead = readOwnData(value, property);
  const candidate = propertyRead.value;
  if (!propertyRead.readable || !propertyRead.ownData) {
    return { values: [], declaredLength: 0, valid: false, readable: propertyRead.readable };
  }
  let isArray;
  try { isArray = Array.isArray(candidate); } catch {
    return { values: [], declaredLength: 0, valid: false, readable: false };
  }
  if (!isArray) return { values: [], declaredLength: 0, valid: false, readable: true };
  const lengthRead = readOwnData(candidate, 'length');
  const length = lengthRead.value;
  if (!lengthRead.readable || !lengthRead.ownData || !Number.isSafeInteger(length) || length < 0) {
    return { values: [], declaredLength: 0, valid: false, readable: lengthRead.readable };
  }
  const boundedLength = Math.min(length, max);
  const output = new Array(boundedLength);
  let readable = true;
  for (let index = 0; index < boundedLength; index += 1) {
    const entryRead = readOwnData(candidate, String(index));
    if (!entryRead.readable) readable = false;
    output[index] = entryRead.value;
  }
  return { values: output, declaredLength: length, valid: true, readable };
}

function safeArray(value, property, max = MAX_OCCURRENCES) {
  return inspectArray(value, property, max).values;
}

function declaredArrayLength(value, property) {
  const inspected = inspectArray(value, property, 0);
  return inspected.valid ? inspected.declaredLength : 0;
}

function canonicalId(value, fallback) {
  return typeof value === 'string' && SAFE_ID.test(value) ? value : fallback;
}

function safeImpact(value) {
  return ['minor', 'moderate', 'serious', 'critical'].includes(value) ? value : 'minor';
}

function stableHash(value) {
  let hash = 0x811c9dc5;
  for (const character of value) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function selectorFromTarget(value, depth = 0) {
  if (typeof value === 'string') return sanitizeAxeStructuralSelector(value);
  let isArray = false;
  try { isArray = Array.isArray(value); } catch { return AXE_TARGET_UNAVAILABLE; }
  if (!isArray || depth > 3) return AXE_TARGET_UNAVAILABLE;
  const length = safeRead(value, 'length');
  if (!Number.isSafeInteger(length) || length < 0) return AXE_TARGET_UNAVAILABLE;
  for (let index = Math.min(length, 16) - 1; index >= 0; index -= 1) {
    const selector = selectorFromTarget(safeRead(value, String(index)), depth + 1);
    if (selector !== AXE_TARGET_UNAVAILABLE) return selector;
  }
  return AXE_TARGET_UNAVAILABLE;
}

function validProvenance(input) {
  return sameDataRecord(input, AXE_PROVENANCE);
}

function sameDataRecord(actual, expected, seen = new WeakMap()) {
  if (actual === expected) return true;
  if (actual === null || expected === null || typeof actual !== 'object' || typeof expected !== 'object') return actual === expected;
  if (safeIsArray(actual) !== safeIsArray(expected)) return false;
  if (seen.get(actual) === expected) return true;
  seen.set(actual, expected);
  let actualKeys;
  let expectedKeys;
  try {
    actualKeys = Object.keys(actual).sort();
    expectedKeys = Object.keys(expected).sort();
  } catch { return false; }
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) return false;
  for (const key of expectedKeys) {
    const actualDescriptor = (() => { try { return Object.getOwnPropertyDescriptor(actual, key); } catch { return null; } })();
    const expectedDescriptor = Object.getOwnPropertyDescriptor(expected, key);
    if (!actualDescriptor || !expectedDescriptor || !Object.hasOwn(actualDescriptor, 'value') || !Object.hasOwn(expectedDescriptor, 'value') ||
      !sameDataRecord(actualDescriptor.value, expectedDescriptor.value, seen)) return false;
  }
  return true;
}

function summaryCounts(frames) {
  const summary = {};
  for (const resultType of ['violations', 'incomplete', 'passes', 'inapplicable']) {
    let groups = 0;
    let nodes = 0;
    for (const frame of frames) {
      const entries = safeArray(safeRead(frame, 'result'), resultType, MAX_GROUPS_PER_TYPE);
      for (const group of entries) {
        if (!ALLOWED_RULE_IDS.has(safeRead(group, 'id'))) continue;
        const nodeCount = safeArray(group, 'nodes', MAX_NODES_PER_GROUP).length;
        if ((resultType === 'violations' || resultType === 'incomplete') && nodeCount === 0) continue;
        groups += 1;
        nodes += nodeCount;
      }
    }
    summary[resultType] = { groups, nodes };
  }
  return summary;
}

function exactStringArray(value, expected) {
  let array = false;
  try { array = Array.isArray(value); } catch { return false; }
  if (!array || safeRead(value, 'length') !== expected.length) return false;
  return expected.every((entry, index) => safeRead(value, String(index)) === entry);
}

function targetNodeIdForStructuralSelector(snapshot, selector) {
  if (selector === AXE_TARGET_UNAVAILABLE || sanitizeAxeStructuralSelector(selector) !== selector) return null;
  const inspected = inspectArray(snapshot, 'nodes', 50_000);
  if (!inspected.valid || !inspected.readable || inspected.declaredLength > 50_000) return null;
  const byId = new Map();
  for (const node of inspected.values) {
    const nodeId = safeRead(node, 'nodeId');
    if ((typeof nodeId !== 'string' && !Number.isSafeInteger(nodeId)) || byId.has(String(nodeId))) return null;
    byId.set(String(nodeId), node);
  }
  const documentNodeId = safeRead(safeRead(snapshot, 'document'), 'nodeId');
  const selectorNodes = new Map();
  for (const node of inspected.values) {
    const path = inspectArray(node, 'framePath', 2);
    if (!path.valid || !path.readable || path.declaredLength !== 0) continue;
    const compounds = [];
    const visited = new Set();
    let current = node;
    let valid = true;
    while (current && compounds.length < 12) {
      const nodeId = safeRead(current, 'nodeId');
      const nodeKey = String(nodeId);
      if (visited.has(nodeKey)) { valid = false; break; }
      visited.add(nodeKey);
      const tag = typeof safeRead(current, 'tagName') === 'string' ? safeRead(current, 'tagName').toLowerCase() : '';
      if (sanitizeAxeStructuralSelector(tag) !== tag || tag.includes('>')) { valid = false; break; }
      let compound = tag;
      const parentId = safeRead(current, 'parentId');
      const parent = parentId === null || parentId === undefined ? null : byId.get(String(parentId));
      if (parent) {
        const children = inspectArray(parent, 'children', 2_048);
        if (!children.valid || !children.readable || children.declaredLength > 2_048) { valid = false; break; }
        let sameTag = 0;
        let position = 0;
        let occurrencesOfCurrent = 0;
        for (const childId of children.values) {
          const child = byId.get(String(childId));
          if (!child) { valid = false; break; }
          if (String(childId) === nodeKey) occurrencesOfCurrent += 1;
          const childTag = typeof safeRead(child, 'tagName') === 'string' ? safeRead(child, 'tagName').toLowerCase() : '';
          if (childTag === tag) {
            sameTag += 1;
            if (String(childId) === nodeKey) position = sameTag;
          }
        }
        if (!valid || occurrencesOfCurrent !== 1 || position === 0) { valid = false; break; }
        if (sameTag > 1) compound += `:nth-of-type(${position})`;
      } else if (!(tag === 'html' && (parentId === null || parentId === undefined || String(parentId) === String(documentNodeId)))) {
        valid = false;
        break;
      }
      compounds.unshift(compound);
      if (tag === 'html') break;
      current = parent;
    }
    if (!valid || compounds[0] !== 'html' || compounds.length === 0 || compounds.length > 12) continue;
    const structural = compounds.join(' > ');
    if (structural.length > 256 || sanitizeAxeStructuralSelector(structural) !== structural) continue;
    const matches = selectorNodes.get(structural) ?? [];
    matches.push(safeRead(node, 'nodeId'));
    selectorNodes.set(structural, matches);
  }
  const matches = selectorNodes.get(selector) ?? [];
  return matches.length === 1 ? matches[0] : null;
}

function authoritativeCoreTarget(options, mapping, nodeId) {
  const inspected = inspectArray(options, 'coreRuleResults', 256);
  if (!inspected.valid || !inspected.readable || inspected.declaredLength > 256) return false;
  const candidates = inspected.values.filter(rule => safeRead(rule, 'ruleId') === mapping.auditaRuleId);
  if (candidates.length !== 1) return false;
  const rule = candidates[0];
  if (safeRead(rule, 'outcome') !== 'failed' || safeRead(rule, 'mode') !== 'automated' ||
    !sameDataRecord(safeRead(rule, 'source'), {
      engine: 'audita-core', ruleId: mapping.auditaRuleId, version: AUDITA_RULES_VERSION,
    }) || !exactStringArray(safeRead(rule, 'nbrItems'), [mapping.nbrItemRef]) ||
    !exactStringArray(safeRead(rule, 'wcag'), [...mapping.wcagRefs])) return false;
  const targets = inspectArray(rule, 'targets', 256);
  if (!targets.valid || !targets.readable || targets.declaredLength > 256) return false;
  return targets.values.filter(target => String(safeRead(target, 'nodeId')) === String(nodeId)).length === 1;
}

function publishedFindingCounts(occurrences, resultType) {
  const retained = occurrences.filter(occurrence => occurrence.engineResultType === resultType);
  const groups = new Set(retained.map(occurrence =>
    `${occurrence.source.engineRuleId}\u0000${occurrence.framePath.join('/')}`));
  return { groups: groups.size, nodes: retained.length };
}

function correlatedTargetNodeId(options, { axeRuleId, mapping, frameId, selector }) {
  if (mapping?.targetScope !== 'node' || axeRuleId !== 'target-size' || frameId !== 0 || selector === AXE_TARGET_UNAVAILABLE) return null;
  return targetNodeIdForStructuralSelector(options.snapshot, selector);
}

function derivedApplicability(options, { axeRuleId, mapping, pageId, frameId, selector, correlatedNodeId }) {
  if (selector === AXE_TARGET_UNAVAILABLE || frameId !== 0 || options.rulesVersion !== AUDITA_RULES_VERSION) return null;
  const item = ITEM_BY_ID.get(mapping.nbrItemRef);
  const snapshot = options.snapshot;
  if (mapping.targetScope === 'node') {
    const nodeId = correlatedNodeId;
    if (nodeId === null || !authoritativeCoreTarget(options, mapping, nodeId) || !item?.ruleIds.includes(mapping.auditaRuleId)) return null;
    return deepFreeze({
      confirmed: true, pageId, frameId, target: selector, nodeId, nbrItemRef: mapping.nbrItemRef,
      source: { engine: 'audita-core', ruleId: mapping.auditaRuleId, version: AUDITA_RULES_VERSION },
    });
  }
  const document = safeRead(snapshot, 'document');
  if (!snapshot || typeof snapshot !== 'object' || !document || typeof document !== 'object') return null;
  let ruleId = null;
  let confirmed = false;
  if (axeRuleId === 'html-has-lang' && selector === 'html' &&
    safeRead(document, 'language') === '') {
    ruleId = 'page-language';
    confirmed = true;
  } else if (axeRuleId === 'document-title' && selector === 'html' &&
    safeRead(document, 'title') === '') {
    ruleId = 'page-title';
    confirmed = true;
  }
  if (!confirmed || !item?.ruleIds.includes(ruleId)) return null;
  return deepFreeze({
    confirmed: true, pageId, frameId, target: selector, nbrItemRef: mapping.nbrItemRef,
    source: { engine: 'audita-core', ruleId, version: AUDITA_RULES_VERSION },
  });
}

function ruleKey(axeRuleId) {
  return `axe.${axeRuleId}`;
}

function makeSource(axeRuleId) {
  return {
    engine: AXE_PROVENANCE.engine,
    ruleId: ruleKey(axeRuleId),
    version: AXE_PROVENANCE.version,
    engineRuleId: axeRuleId,
  };
}

function strongestImpact(first, second) {
  const order = ['minor', 'moderate', 'serious', 'critical'];
  return order.indexOf(second) > order.indexOf(first) ? second : first;
}

function limitationText(status) {
  if (status === 'disabled') return 'O motor suplementar axe-core está desativado pelo gate MV3/CSP; o motor próprio Audita continuou sem sondar o axe.';
  if (status === 'partial') return 'O motor suplementar axe-core teve cobertura parcial; somente resultados vinculados a frames concluídos foram considerados.';
  return null;
}

function containsTruncationMetadata(value) {
  const metadata = safeRead(value, 'truncation');
  if (safeRead(metadata, 'truncated') === true) return true;
  for (const key of ['violations', 'incomplete', 'passes', 'inapplicable', 'groups', 'nodes', 'tags', 'target', 'any', 'all', 'none']) {
    if (safeRead(safeRead(metadata, key), 'truncated') === true) return true;
  }
  return false;
}

function hasNestedResultTruncation(result) {
  if (containsTruncationMetadata(result)) return true;
  for (const resultType of ['violations', 'incomplete', 'passes', 'inapplicable']) {
    if (declaredArrayLength(result, resultType) > MAX_GROUPS_PER_TYPE) return true;
    for (const group of safeArray(result, resultType, MAX_GROUPS_PER_TYPE)) {
      if (containsTruncationMetadata(group) || declaredArrayLength(group, 'nodes') > MAX_NODES_PER_GROUP) return true;
      for (const node of safeArray(group, 'nodes', MAX_NODES_PER_GROUP)) {
        if (containsTruncationMetadata(node)) return true;
      }
    }
  }
  return false;
}

export function normalizeAxeResults(input, options = {}) {
  const pageId = typeof options.pageId === 'string' && /^[A-Za-z0-9._:-]{1,200}$/u.test(options.pageId)
    ? options.pageId
    : 'page-1';
  const inputStatus = safeRead(input, 'status');
  const requestedStatus = ['complete', 'partial', 'disabled'].includes(inputStatus) ? inputStatus : 'partial';
  const diagnosticCollection = inspectArray(input, 'diagnostics', MAX_RAW_DIAGNOSTICS);
  const diagnostics = diagnosticCollection.values.map(entry => {
    const code = safeRead(entry, 'code');
    return {
      code: ['AXE_FEATURE_DISABLED', 'AXE_PROVENANCE_INVALID'].includes(code)
        ? 'AXE_DIAGNOSTIC_UNAVAILABLE'
        : code,
      frameId: safeRead(entry, 'frameId'),
    };
  });
  const limitations = [];

  if (!validProvenance(safeRead(input, 'provenance'))) {
    return deepFreeze({
      status: 'partial', provenance: structuredClone(AXE_PROVENANCE),
      diagnostics: [{ code: 'AXE_PROVENANCE_INVALID', frameId: null }],
      limitations: [limitationText('partial'), 'A proveniência do resultado axe não corresponde ao pacote verificado; nenhum achado foi publicado.'],
      ruleResults: [], occurrences: [],
      technicalSummary: {
        violations: { groups: 0, nodes: 0 }, incomplete: { groups: 0, nodes: 0 },
        passes: { groups: 0, nodes: 0 }, inapplicable: { groups: 0, nodes: 0 },
      },
    });
  }

  if (requestedStatus === 'disabled') {
    return deepFreeze({
      status: 'disabled', provenance: structuredClone(AXE_PROVENANCE),
      diagnostics: [{ code: 'AXE_FEATURE_DISABLED', frameId: null }], limitations: [limitationText('disabled')],
      ruleResults: [], occurrences: [],
      technicalSummary: {
        violations: { groups: 0, nodes: 0 }, incomplete: { groups: 0, nodes: 0 },
        passes: { groups: 0, nodes: 0 }, inapplicable: { groups: 0, nodes: 0 },
      },
    });
  }

  if (!diagnosticCollection.valid || !diagnosticCollection.readable) {
    diagnostics.push({ code: 'AXE_DIAGNOSTIC_UNAVAILABLE', frameId: null });
  }

  const rawFrames = safeArray(input, 'frames', MAX_FRAMES);
  const frames = [];
  const seenFrameIds = new Set();
  let topologyPartial = requestedStatus !== 'complete';
  for (const frame of rawFrames) {
    const frameId = safeRead(frame, 'frameId');
    const frameStatus = safeRead(frame, 'status');
    if (!Number.isSafeInteger(frameId) || frameId < 0) {
      diagnostics.push({ code: 'AXE_FRAME_INVALID', frameId: null });
      topologyPartial = true;
      continue;
    }
    if (seenFrameIds.has(frameId)) {
      diagnostics.push({ code: 'AXE_FRAME_DUPLICATE', frameId });
      topologyPartial = true;
      continue;
    }
    seenFrameIds.add(frameId);
    if (frameStatus !== 'success') {
      diagnostics.push({ code: frameStatus === 'missing' ? 'AXE_FRAME_MISSING' : 'AXE_FRAME_FAILED', frameId });
      topologyPartial = true;
      continue;
    }
    const frameResult = safeRead(frame, 'result');
    let resultIsArray = false;
    try { resultIsArray = Array.isArray(frameResult); } catch { resultIsArray = true; }
    if (!frameResult || typeof frameResult !== 'object' || resultIsArray) {
      diagnostics.push({ code: 'AXE_FRAME_RESULT_INVALID', frameId });
      topologyPartial = true;
      continue;
    }
    frames.push(frame);
  }
  if (frames.length === 0) topologyPartial = true;
  if (diagnostics.length > 0) topologyPartial = true;
  let truncated = diagnostics.some(entry => entry.code === 'AXE_RESULTS_TRUNCATED') ||
    declaredArrayLength(input, 'frames') > MAX_FRAMES || diagnosticCollection.declaredLength > MAX_RAW_DIAGNOSTICS;
  if (frames.some(frame => hasNestedResultTruncation(safeRead(frame, 'result')))) truncated = true;
  const technicalSummary = summaryCounts(frames);
  const occurrences = [];
  const ruleById = new Map();

  for (const frame of frames) {
    const frameId = safeRead(frame, 'frameId');
    for (const resultType of ['violations', 'incomplete']) {
      const frameResult = safeRead(frame, 'result');
      if (containsTruncationMetadata(frameResult)) truncated = true;
      const rawGroups = safeArray(frameResult, resultType, MAX_GROUPS_PER_TYPE);
      if (declaredArrayLength(frameResult, resultType) > MAX_GROUPS_PER_TYPE) truncated = true;
      for (const [groupIndex, group] of rawGroups.entries()) {
        const axeRuleId = canonicalId(safeRead(group, 'id'), 'axe-id-unavailable');
        if (!ALLOWED_RULE_IDS.has(axeRuleId)) continue;
        const mapping = axeNbrMappingForRule(axeRuleId);
        const item = mapping ? ITEM_BY_ID.get(mapping.nbrItemRef) : null;
        const rawNodes = safeArray(group, 'nodes', MAX_NODES_PER_GROUP);
        if (containsTruncationMetadata(group)) truncated = true;
        if (declaredArrayLength(group, 'nodes') > MAX_NODES_PER_GROUP) truncated = true;
        for (const [nodeIndex, node] of rawNodes.entries()) {
          if (occurrences.length >= MAX_OCCURRENCES) { truncated = true; break; }
          const selector = selectorFromTarget(safeRead(node, 'target'));
          if (containsTruncationMetadata(node)) truncated = true;
          const correlatedNodeId = mapping
            ? correlatedTargetNodeId(options, { axeRuleId, mapping, frameId, selector })
            : null;
          const applicabilityEvidence = resultType === 'violations' && mapping
            ? derivedApplicability(options, { axeRuleId, mapping, pageId, frameId, selector, correlatedNodeId })
            : null;
          const mappedOutcome = resultType === 'incomplete' || (mapping && !applicabilityEvidence) || selector === AXE_TARGET_UNAVAILABLE
            ? 'cantTell'
            : 'failed';
          const outcome = mapping ? mappedOutcome : (selector === AXE_TARGET_UNAVAILABLE ? 'cantTell' : resultType === 'violations' ? 'failed' : 'cantTell');
          const classification = item?.classification ?? 'best-practice';
          const impact = safeImpact(safeRead(node, 'impact') ?? safeRead(group, 'impact'));
          const source = makeSource(axeRuleId);
          const conditionText = mapping?.rationale || 'Achado suplementar do axe-core sem vínculo curado com item ABNT.';
          const justification = mapping && resultType === 'violations' && !applicabilityEvidence
            ? `${conditionText} A aplicabilidade ao item ABNT ainda exige confirmação pelo motor próprio ou revisão.`
            : conditionText;
          const occurrenceId = `occurrence-axe-${stableHash([options.auditId ?? '', pageId, frameId, axeRuleId, selector, resultType, groupIndex, nodeIndex].join('\u0000'))}`;
          const itemWcagRefs = item?.wcag.map(reference => reference.id) ?? [];
          const sourceWcagRefs = mapping ? [...mapping.wcagRefs] : [];
          const testedWcagRefs = outcome === 'failed' ? [...sourceWcagRefs] : [];
          occurrences.push({
            occurrenceId, pageId, itemId: mapping?.nbrItemRef ?? null,
            ruleId: source.ruleId, engineRuleId: axeRuleId, engineResultType: resultType, outcome, mode: 'automated',
            classification, impact, confidence: outcome === 'failed' ? 'high' : 'low',
            source, nodeId: correlatedNodeId, selector, framePath: frameId === 0 ? [] : [`frame:${frameId}`],
            equivalenceKey: mapping?.equivalenceKey ?? `axe:${axeRuleId}`,
            presentationTargetKey: mapping?.targetScope === 'document'
              ? 'document'
              : correlatedNodeId !== null ? `node:${correlatedNodeId}` : `selector:${frameId}:${selector}`,
            target: { nodeId: correlatedNodeId, selector, framePath: frameId === 0 ? [] : [`frame:${frameId}`] },
            nbrItemRef: mapping?.nbrItemRef ?? null,
            itemWcagRefs, sourceWcagRefs, testedWcagRefs,
            wcagRefs: [...testedWcagRefs],
            foreignBenchmarkRefs: [...section508ReferencesForWcag(testedWcagRefs)],
            accessiblePreview: null, evidenceIds: [], evidenceRefs: [],
            justification,
            applicabilityEvidence,
            legalAnalysis: outcome === 'failed' && mapping
              ? { basisRef: CONSUMER_ACCESSIBILITY_FIXED_BASIS.id }
              : null,
          });

          const existing = ruleById.get(source.ruleId);
          const target = { nodeId: correlatedNodeId, selector, framePath: frameId === 0 ? [] : [`frame:${frameId}`], message: justification };
          if (!existing) {
            ruleById.set(source.ruleId, {
              ruleId: source.ruleId, engineRuleId: axeRuleId, outcome, mode: 'automated',
              targets: [target], summary: conditionText,
              limitations: mapping && !applicabilityEvidence && resultType === 'violations'
                ? ['A aplicabilidade ABNT não foi confirmada; o resultado permanece cantTell.']
                : [],
              nbrItems: mapping ? [mapping.nbrItemRef] : [],
              wcag: mapping ? [...mapping.wcagRefs] : [], classification, impact, confidence: outcome === 'failed' ? 'high' : 'low', source,
            });
          } else {
            existing.targets.push(target);
            existing.impact = strongestImpact(existing.impact, impact);
            if (OUTCOME_PRIORITY[outcome] > OUTCOME_PRIORITY[existing.outcome]) existing.outcome = outcome;
            if (existing.outcome === 'failed') existing.confidence = 'high';
          }
        }
      }
    }
  }
  technicalSummary.violations = publishedFindingCounts(occurrences, 'violations');
  technicalSummary.incomplete = publishedFindingCounts(occurrences, 'incomplete');
  const combinedDiagnostics = canonicalizeAxeDiagnosticsWithMetadata(diagnostics);
  if (combinedDiagnostics.truncated) truncated = true;
  if (truncated && !diagnostics.some(entry => entry.code === 'AXE_RESULTS_TRUNCATED')) diagnostics.push({ code: 'AXE_RESULTS_TRUNCATED', frameId: null });
  const canonicalDiagnostics = canonicalizeAxeDiagnosticsWithMetadata(diagnostics).diagnostics;
  const status = topologyPartial || truncated ? 'partial' : 'complete';
  if (status === 'partial') limitations.push(limitationText('partial'));
  if (truncated) limitations.push('Os resultados axe excederam limites locais de segurança; contagens e achados publicados são truncados.');

  return deepFreeze({
    status, provenance: structuredClone(AXE_PROVENANCE), diagnostics: canonicalDiagnostics, limitations,
    ruleResults: [...ruleById.values()], occurrences, technicalSummary,
  });
}
