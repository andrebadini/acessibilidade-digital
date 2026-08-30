import { validateExecutionCheckpoint } from '../background/execution-checkpoint.js';
import { createAuditModel } from '../core/report/audit-model.js';
import { verifyCoreRuleInventory } from '../core/rules/core-rule-inventory.js';
import {
  assertPanelClassificationV1,
  classifyPanelResultV1,
  deriveResultContextV1,
} from './panel-result-contract.js';

const COVERED_OUTCOMES = new Set(['passed', 'failed', 'inapplicable']);
const GROUP_NAMES = Object.freeze(['failed', 'alerts', 'humanReview', 'passed']);
const IMPACT_ORDER = Object.freeze({ critical: 4, serious: 3, moderate: 2, minor: 1 });
const OUTCOME_ORDER = Object.freeze({ failed: 5, cantTell: 4, untested: 3, passed: 2, inapplicable: 1 });
const FRAME_LIMITATION = 'Frames cross-origin ou com sandbox não observados aparecem como limitação.';
const CLOSED_SHADOW_LIMITATION = 'Shadow DOM fechado não pode ser inspecionado automaticamente.';

function checkpointDenied() {
  throw new TypeError('CHECKPOINT_GRAPH_DENIED');
}

function correlateCheckpointModel(checkpoint, model) {
  for (let index = 0; index < checkpoint.pages.length; index += 1) {
    const page = checkpoint.pages[index];
    const modelPage = model.pages[index];
    if (page.pageId !== modelPage.pageId || page.attempted !== modelPage.attempted ||
      (page.attempted && page.startedAt !== modelPage.timestamps.startedAt)) checkpointDenied();
  }
}

function validateCheckpointInventory(checkpoint, inventory, model) {
  const installed = new Set(inventory.ruleIds);
  const ruleById = new Map(model.ruleResults
    .filter(rule => rule.source.engine === 'audita-core')
    .map(rule => [rule.ruleId, rule]));
  for (const page of checkpoint.pages) {
    if (page.rulesVersion !== inventory.rulesVersion || page.inventoryVersion !== inventory.inventoryVersion ||
      page.inventoryHash !== inventory.sha256) checkpointDenied();
    for (const row of page.outcomes) {
      if (!installed.has(row.ruleId)) checkpointDenied();
      if (model.requestedScope.mode === 'single') {
        const modelRule = ruleById.get(row.ruleId);
        if (!modelRule || modelRule.outcome !== row.outcome) checkpointDenied();
      }
    }
  }
}

export function coveragePercent(numerator, denominator) {
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) ||
    numerator < 0 || denominator <= 0 || numerator > denominator) {
    throw new TypeError('COVERAGE_PERCENT_DENIED');
  }
  const tenths = Math.floor((numerator * 1000 * 2 + denominator) / (2 * denominator));
  return `${Math.floor(tenths / 10)},${tenths % 10}%`;
}

function checkKey(pageId, engine, ruleId) {
  return JSON.stringify([pageId, engine, ruleId]);
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function strongerOutcome(values) {
  return values.reduce((best, value) => OUTCOME_ORDER[value] > OUTCOME_ORDER[best] ? value : best, 'inapplicable');
}

function displayOutcomeForOccurrences(occurrences, decisionByOccurrence) {
  return strongerOutcome(occurrences.map(occurrence => {
    if (['failed', 'passed'].includes(occurrence.outcome)) return occurrence.outcome;
    const answer = decisionByOccurrence.get(occurrence.occurrenceId)?.answer;
    if (answer === 'não conforme') return 'failed';
    if (answer === 'conforme') return 'passed';
    return 'cantTell';
  }));
}

function groupForOccurrences(occurrences, displayOutcome) {
  if (displayOutcome === 'passed') return 'passed';
  const normative = occurrences.some(occurrence => ['requirement', 'recommendation'].includes(occurrence.classification));
  if (displayOutcome === 'failed') return normative ? 'failed' : 'alerts';
  if (displayOutcome === 'cantTell' && normative) return 'humanReview';
  return null;
}

function authoritativeRuleIndex(model) {
  const byIdentity = new Map();
  for (const rule of model.ruleResults) {
    const identity = JSON.stringify([rule.source.engine, rule.source.ruleId]);
    if (byIdentity.has(identity)) throw new TypeError('PANEL_RULE_IDENTITY_DENIED');
    byIdentity.set(identity, rule);
  }
  return byIdentity;
}

function evidenceIndex(model) {
  return new Map(model.evidence.map(evidence => [evidence.evidenceId, evidence]));
}

function firstAccessibility(occurrences, evidenceById) {
  for (const occurrence of occurrences) {
    for (const evidenceId of occurrence.evidenceRefs) {
      const evidence = evidenceById.get(evidenceId);
      if (evidence?.nodeId !== undefined && evidence.nodeId !== null && evidence.nodeId !== occurrence.nodeId) continue;
      if (evidence?.accessibility) return evidence.accessibility;
    }
  }
  return null;
}

function impactFor(occurrences) {
  if (occurrences.length === 0) return null;
  let best = occurrences[0].impact;
  for (let index = 1; index < occurrences.length; index += 1) {
    if (IMPACT_ORDER[occurrences[index].impact] > IMPACT_ORDER[best]) best = occurrences[index].impact;
  }
  return best;
}

function cardMetadata(occurrences, rule, itemById) {
  const abntItemIds = uniqueSorted(occurrences.map(occurrence => occurrence.nbrItemRef).filter(id => itemById.has(id)));
  const wcag = uniqueSorted(abntItemIds.flatMap(id => itemById.get(id).wcag.map(reference => reference.id))
    .concat(rule?.wcag ?? []));
  const item = abntItemIds.length === 1 ? itemById.get(abntItemIds[0]) : null;
  return { abntItemIds, wcag, title: item?.title ?? rule?.summary ?? occurrences[0].justification };
}

function occurrenceCard({ key, occurrences, rule, itemById, evidenceById, decisionByOccurrence }) {
  const originalOutcome = strongerOutcome(occurrences.map(occurrence => occurrence.outcome));
  const displayOutcome = displayOutcomeForOccurrences(occurrences, decisionByOccurrence);
  const groupName = groupForOccurrences(occurrences, displayOutcome);
  if (groupName === null) return null;
  const classification = classifyPanelResultV1(groupName);
  assertPanelClassificationV1(groupName, classification, displayOutcome);
  const metadata = cardMetadata(occurrences, rule, itemById);
  const accessibility = firstAccessibility(occurrences, evidenceById);
  const occurrenceIds = uniqueSorted(occurrences.map(occurrence => occurrence.occurrenceId));
  const evidenceIds = uniqueSorted(occurrences.flatMap(occurrence => occurrence.evidenceRefs));
  return {
    groupName,
    card: {
      checkKey: key,
      pageId: occurrences[0].pageId,
      engine: occurrences[0].source.engine,
      ruleId: occurrences[0].source.ruleId,
      originalOutcome,
      displayOutcome,
      title: metadata.title,
      impact: impactFor(occurrences),
      wcag: metadata.wcag,
      abntItemIds: metadata.abntItemIds,
      occurrenceIds,
      classification,
      context: deriveResultContextV1({ occurrences, evidenceById }),
      accessibleName: accessibility?.name ?? null,
      announcement: accessibility?.announcementPreview ?? null,
      evidence: { evidenceIds, highlightAvailable: false },
    },
  };
}

function passedCard(pageId, rule, itemById) {
  const groupName = 'passed';
  const classification = classifyPanelResultV1(groupName);
  assertPanelClassificationV1(groupName, classification, 'passed');
  const items = uniqueSorted(rule.nbrItems.filter(id => itemById.has(id)));
  const wcag = uniqueSorted(items.flatMap(id => itemById.get(id).wcag.map(reference => reference.id)).concat(rule.wcag));
  return {
    checkKey: checkKey(pageId, 'audita-core', rule.ruleId),
    pageId,
    engine: 'audita-core',
    ruleId: rule.ruleId,
    originalOutcome: 'passed',
    displayOutcome: 'passed',
    title: items.length === 1 ? itemById.get(items[0]).title : rule.summary,
    impact: null,
    wcag,
    abntItemIds: items,
    occurrenceIds: [],
    classification,
    context: 'page-or-process',
    accessibleName: null,
    announcement: null,
    evidence: { evidenceIds: [], highlightAvailable: false },
  };
}

function buildGroups(model, checkpoint, verifiedInventory) {
  const groups = { failed: [], alerts: [], humanReview: [], passed: [] };
  const ruleByIdentity = authoritativeRuleIndex(model);
  const itemById = new Map(model.itemResults.map(item => [item.id, item]));
  const evidenceById = evidenceIndex(model);
  const decisionByOccurrence = new Map(model.reviewDecisions.map(decision => [decision.occurrenceId, decision]));
  const occurrencesByKey = new Map();
  for (const occurrence of model.occurrences) {
    const key = checkKey(occurrence.pageId, occurrence.source.engine, occurrence.source.ruleId);
    const values = occurrencesByKey.get(key) ?? [];
    values.push(occurrence);
    occurrencesByKey.set(key, values);
  }
  for (const [key, occurrences] of [...occurrencesByKey].sort(([left], [right]) => left.localeCompare(right))) {
    const rule = ruleByIdentity.get(JSON.stringify([occurrences[0].source.engine, occurrences[0].source.ruleId]));
    const projected = occurrenceCard({ key, occurrences, rule, itemById, evidenceById, decisionByOccurrence });
    if (projected && (verifiedInventory || projected.groupName !== 'passed')) {
      groups[projected.groupName].push(projected.card);
    }
  }
  if (verifiedInventory) {
    const coreRuleById = new Map(model.ruleResults
      .filter(rule => rule.source.engine === 'audita-core')
      .map(rule => [rule.ruleId, rule]));
    for (const page of checkpoint.pages) {
      for (const row of page.outcomes) {
        if (row.outcome !== 'passed') continue;
        const key = checkKey(page.pageId, 'audita-core', row.ruleId);
        if (occurrencesByKey.has(key)) continue;
        const rule = coreRuleById.get(row.ruleId);
        if (!rule) checkpointDenied();
        groups.passed.push(passedCard(page.pageId, rule, itemById));
      }
    }
  }
  for (const groupName of GROUP_NAMES) groups[groupName].sort((left, right) => left.checkKey.localeCompare(right.checkKey));
  return groups;
}

function distribution(cards, field) {
  const counts = new Map();
  for (const card of cards) {
    const ids = field === 'impact' ? (card.impact ? [card.impact] : [])
      : field === 'wcag' ? card.wcag
        : card.abntItemIds;
    for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return [...counts].sort(([left], [right]) => left.localeCompare(right))
    .map(([id, count]) => ({ id, count }));
}

function limitationCodes(model) {
  const limitations = new Set();
  for (const evidence of model.evidence) {
    if (evidence.kind !== 'announcement-map' || !Array.isArray(evidence.limitations)) continue;
    if (evidence.limitations.includes('frame-content-omitted')) limitations.add(FRAME_LIMITATION);
    if (evidence.limitations.includes('closed-shadow-root-omitted')) limitations.add(CLOSED_SHADOW_LIMITATION);
  }
  return [...limitations];
}

function freeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value) || Object.isFrozen(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freeze(child, seen);
  return Object.freeze(value);
}

export async function buildPanelSummary({ model: inputModel, executionCheckpoint, inventory: inputInventory }) {
  const model = createAuditModel(inputModel);
  let checkpoint;
  try {
    checkpoint = validateExecutionCheckpoint({
      auditId: model.auditId,
      checkpoint: executionCheckpoint,
      pageOrder: model.pages.map(page => page.pageId),
    });
  } catch {
    checkpointDenied();
  }
  correlateCheckpointModel(checkpoint, model);
  let inventory = null;
  try {
    inventory = await verifyCoreRuleInventory(inputInventory);
  } catch (error) {
    if (!(error instanceof TypeError) || error.message !== 'CORE_INVENTORY_UNVERIFIED') throw error;
  }
  if (inventory) validateCheckpointInventory(checkpoint, inventory, model);
  const groups = buildGroups(model, checkpoint, inventory);
  const cards = GROUP_NAMES.flatMap(groupName => groups[groupName]);
  const attemptedPages = checkpoint.pages.filter(page => page.attempted);
  const denominator = inventory ? attemptedPages.length * inventory.ruleIds.length : 0;
  const numerator = inventory ? attemptedPages.reduce((total, page) =>
    total + page.outcomes.filter(row => COVERED_OUTCOMES.has(row.outcome)).length, 0) : 0;
  const coverage = !inventory
    ? { status: 'unavailable', reason: 'CORE_INVENTORY_UNVERIFIED' }
    : denominator === 0
      ? { status: 'unavailable', reason: 'EXECUTION_NOT_STARTED' }
      : { status: 'available', numerator, denominator, percent: coveragePercent(numerator, denominator) };
  const occurrenceCount = groupName => uniqueSorted(groups[groupName].flatMap(card => card.occurrenceIds)).length;
  const keyForOutcome = (pageId, ruleId) => checkKey(pageId, 'audita-core', ruleId);
  const summary = {
    version: 1,
    auditId: model.auditId,
    identity: { finalUrl: model.finalUrl, completedAt: model.timestamps.endedAt, status: model.session.status },
    coverage,
    counts: {
      errors: { checkKeys: groups.failed.length, occurrences: occurrenceCount('failed') },
      alerts: { checkKeys: groups.alerts.length, occurrences: occurrenceCount('alerts') },
      humanReview: { checkKeys: groups.humanReview.length, occurrences: occurrenceCount('humanReview') },
      positive: { checkKeys: groups.passed.length, occurrences: occurrenceCount('passed') },
    },
    distributions: {
      impact: distribution(cards, 'impact'),
      wcag: distribution(cards, 'wcag'),
      abnt: distribution(cards, 'abnt'),
    },
    limitations: {
      codes: limitationCodes(model),
      notStartedPageIds: checkpoint.pages.filter(page => !page.attempted).map(page => page.pageId),
      inapplicableCheckKeys: inventory ? uniqueSorted(checkpoint.pages.flatMap(page => page.outcomes
        .filter(row => row.outcome === 'inapplicable').map(row => keyForOutcome(page.pageId, row.ruleId)))) : [],
      untestedCheckKeys: inventory ? uniqueSorted(checkpoint.pages.flatMap(page => page.outcomes
        .filter(row => row.outcome === 'untested').map(row => keyForOutcome(page.pageId, row.ruleId)))) : [],
    },
    groups,
  };
  return freeze(summary);
}
