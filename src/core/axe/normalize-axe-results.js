import { AXE_PROVENANCE, AXE_TARGET_UNAVAILABLE, sanitizeAxeStructuralSelector } from '../../browser/axe-adapter.js';
import { CONSUMER_ACCESSIBILITY_FIXED_BASIS } from '../legal/consumer-basis.js';
import { NBR17225_ITEMS } from '../normative/nbr17225.js';
import { axeNbrMappingForRule } from '../normative/axe-nbr-crosswalk.js';
import { section508ReferencesForWcag } from '../normative/section508.js';

const MAX_FRAMES = 64;
const MAX_GROUPS_PER_TYPE = 100;
const MAX_NODES_PER_GROUP = 100;
const MAX_OCCURRENCES = 256;
const AUDITA_RULES_VERSION = '1.0.0';
const SAFE_ID = /^[a-z][a-z0-9._:-]{0,127}$/iu;
const OUTCOME_PRIORITY = Object.freeze({ failed: 3, cantTell: 2, untested: 1 });
const ITEM_BY_ID = new Map(NBR17225_ITEMS.map(item => [item.id, item]));

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value) || Object.isFrozen(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function safeRead(value, property) {
  try {
    if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, property);
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  } catch { return undefined; }
}

function safeIsArray(value) {
  try { return Array.isArray(value); } catch { return false; }
}

function safeArray(value, property, max = MAX_OCCURRENCES) {
  const candidate = safeRead(value, property);
  if (!safeIsArray(candidate)) return [];
  let length;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(candidate, 'length');
    length = descriptor && Object.hasOwn(descriptor, 'value') && Number.isSafeInteger(descriptor.value) && descriptor.value >= 0
      ? descriptor.value
      : 0;
  } catch { return []; }
  const boundedLength = Math.min(length, max);
  const output = new Array(boundedLength);
  for (let index = 0; index < boundedLength; index += 1) output[index] = safeRead(candidate, String(index));
  return output;
}

function declaredArrayLength(value, property) {
  const candidate = safeRead(value, property);
  if (!safeIsArray(candidate)) return 0;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(candidate, 'length');
    return descriptor && Object.hasOwn(descriptor, 'value') && Number.isSafeInteger(descriptor.value) && descriptor.value >= 0
      ? descriptor.value
      : 0;
  } catch { return 0; }
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

function diagnostic(value) {
  const code = canonicalId(safeRead(value, 'code'), 'AXE_DIAGNOSTIC_UNAVAILABLE');
  const frameId = safeRead(value, 'frameId');
  return { code, frameId: Number.isSafeInteger(frameId) && frameId >= 0 ? frameId : null };
}

function summaryCounts(frames) {
  const summary = {};
  for (const resultType of ['violations', 'incomplete', 'passes', 'inapplicable']) {
    let groups = 0;
    let nodes = 0;
    for (const frame of frames) {
      const entries = safeArray(safeRead(frame, 'result'), resultType, MAX_GROUPS_PER_TYPE);
      groups += entries.length;
      nodes += entries.reduce((count, group) => count + safeArray(group, 'nodes', MAX_NODES_PER_GROUP).length, 0);
    }
    summary[resultType] = { groups, nodes };
  }
  return summary;
}

function derivedApplicability(options, { axeRuleId, mapping, pageId, frameId, selector }) {
  if (selector === AXE_TARGET_UNAVAILABLE || frameId !== 0 || options.rulesVersion !== AUDITA_RULES_VERSION) return null;
  const item = ITEM_BY_ID.get(mapping.nbrItemRef);
  const snapshot = options.snapshot;
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

export function normalizeAxeResults(input, options = {}) {
  const pageId = typeof options.pageId === 'string' && /^[A-Za-z0-9._:-]{1,200}$/u.test(options.pageId)
    ? options.pageId
    : 'page-1';
  const inputStatus = safeRead(input, 'status');
  const requestedStatus = ['complete', 'partial', 'disabled'].includes(inputStatus) ? inputStatus : 'partial';
  const diagnostics = safeArray(input, 'diagnostics', 64).map(diagnostic);
  const limitations = [];

  if (!validProvenance(safeRead(input, 'provenance'))) {
    diagnostics.push({ code: 'AXE_PROVENANCE_INVALID', frameId: null });
    return deepFreeze({
      status: 'partial', provenance: structuredClone(AXE_PROVENANCE), diagnostics,
      limitations: [limitationText('partial'), 'A proveniência do resultado axe não corresponde ao pacote verificado; nenhum achado foi publicado.'],
      ruleResults: [], occurrences: [],
      technicalSummary: {
        violations: { groups: 0, nodes: 0 }, incomplete: { groups: 0, nodes: 0 },
        passes: { groups: 0, nodes: 0 }, inapplicable: { groups: 0, nodes: 0 },
      },
    });
  }

  if (requestedStatus === 'disabled') {
    if (!diagnostics.some(entry => entry.code === 'AXE_FEATURE_DISABLED')) diagnostics.push({ code: 'AXE_FEATURE_DISABLED', frameId: null });
    return deepFreeze({
      status: 'disabled', provenance: structuredClone(AXE_PROVENANCE), diagnostics, limitations: [limitationText('disabled')],
      ruleResults: [], occurrences: [],
      technicalSummary: {
        violations: { groups: 0, nodes: 0 }, incomplete: { groups: 0, nodes: 0 },
        passes: { groups: 0, nodes: 0 }, inapplicable: { groups: 0, nodes: 0 },
      },
    });
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
  if (diagnostics.some(entry => /TIMEOUT|FAIL|MISSING|MISMATCH|TOPOLOGY|UNAVAILABLE|INVALID|TRUNCAT/iu.test(entry.code))) topologyPartial = true;
  let truncated = declaredArrayLength(input, 'frames') > MAX_FRAMES || declaredArrayLength(input, 'diagnostics') > 64;
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
        const mapping = axeNbrMappingForRule(axeRuleId);
        const item = mapping ? ITEM_BY_ID.get(mapping.nbrItemRef) : null;
        const rawNodes = safeArray(group, 'nodes', MAX_NODES_PER_GROUP);
        if (containsTruncationMetadata(group)) truncated = true;
        if (declaredArrayLength(group, 'nodes') > MAX_NODES_PER_GROUP) truncated = true;
        for (const [nodeIndex, node] of rawNodes.entries()) {
          if (occurrences.length >= MAX_OCCURRENCES) { truncated = true; break; }
          const selector = selectorFromTarget(safeRead(node, 'target'));
          if (containsTruncationMetadata(node)) truncated = true;
          const applicabilityEvidence = resultType === 'violations' && mapping
            ? derivedApplicability(options, { axeRuleId, mapping, pageId, frameId, selector })
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
          occurrences.push({
            occurrenceId, pageId, itemId: mapping?.nbrItemRef ?? null,
            ruleId: source.ruleId, engineRuleId: axeRuleId, outcome, mode: 'automated',
            classification, impact, confidence: outcome === 'failed' ? 'high' : 'low',
            source, nodeId: null, selector, framePath: frameId === 0 ? [] : [`frame:${frameId}`],
            equivalenceKey: mapping?.equivalenceKey ?? `axe:${axeRuleId}`,
            presentationTargetKey: mapping?.targetScope === 'document'
              ? 'document'
              : `selector:${frameId}:${selector}`,
            target: { nodeId: null, selector, framePath: frameId === 0 ? [] : [`frame:${frameId}`] },
            nbrItemRef: mapping?.nbrItemRef ?? null,
            wcagRefs: mapping ? [...mapping.wcagRefs] : [],
            foreignBenchmarkRefs: mapping ? [...section508ReferencesForWcag(mapping.wcagRefs)] : [],
            accessiblePreview: null, evidenceIds: [], evidenceRefs: [],
            justification,
            applicabilityEvidence,
            legalAnalysis: outcome === 'failed' && mapping
              ? { basisRef: CONSUMER_ACCESSIBILITY_FIXED_BASIS.id }
              : null,
          });

          const existing = ruleById.get(source.ruleId);
          const target = { selector, framePath: frameId === 0 ? [] : [`frame:${frameId}`], message: justification };
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
  if (truncated && !diagnostics.some(entry => entry.code === 'AXE_RESULTS_TRUNCATED')) diagnostics.push({ code: 'AXE_RESULTS_TRUNCATED', frameId: null });
  const status = topologyPartial || truncated ? 'partial' : 'complete';
  if (status === 'partial') limitations.push(limitationText('partial'));
  if (truncated) limitations.push('Os resultados axe excederam limites locais de segurança; contagens e achados publicados são truncados.');

  return deepFreeze({
    status, provenance: structuredClone(AXE_PROVENANCE), diagnostics, limitations,
    ruleResults: [...ruleById.values()], occurrences, technicalSummary,
  });
}
