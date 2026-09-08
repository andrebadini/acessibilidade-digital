import { decodePngDataUrl } from '../core/evidence/png.js';
import { sanitizeHtmlSnippetSource } from '../core/evidence/snippet.js';
import { CONSUMER_ACCESSIBILITY_FIXED_BASIS } from '../core/legal/consumer-basis.js';
import { projectAuditResourceOrigin, sanitizeEvidenceUrl } from '../core/privacy.js';
import { createAuditModel } from '../core/report/audit-model.js';
import { findingKind } from '../core/report/finding-kind.js';
import { displayedWcagRefs } from '../core/report/tested-criteria.js';
import { accessibilityGuidance, recordedLabelComparisons } from '../core/report/plain-language-guidance.js';
import { assertPanelClassificationV1, deriveResultContextV1 } from './panel-result-contract.js';
import {
  INTERACTIVE_PANEL_LIMITATION,
  MAX_INTERACTIVE_PANEL_OCCURRENCES,
} from './panel-projection-policy.js';

const GROUP_NAMES = Object.freeze(['failed', 'alerts', 'humanReview', 'passed']);
const CONSULT_ACTION = Object.freeze({
  kind: 'consult-evidence',
  reason: 'Esta verificação não possui um elemento único destacável no estado atual.',
});

function detailDenied() {
  throw new TypeError('PANEL_DETAIL_OCCURRENCE_DENIED');
}

function copyData(value, seen = new WeakMap()) {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
  if (!value || typeof value !== 'object' || seen.has(value)) detailDenied();
  let prototype;
  let keys;
  try {
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch { detailDenied(); }
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype) detailDenied();
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    const length = lengthDescriptor?.value;
    const expected = ['length', ...Array.from({ length }, (_item, index) => String(index))];
    if (!Number.isSafeInteger(length) || length < 0 || length > 100_000 ||
      keys.length !== expected.length || expected.some(key => !keys.includes(key))) detailDenied();
    const output = [];
    seen.set(value, output);
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) detailDenied();
      output.push(copyData(descriptor.value, seen));
    }
    return output;
  }
  if (prototype !== Object.prototype && prototype !== null) detailDenied();
  const output = {};
  seen.set(value, output);
  for (const key of keys) {
    if (typeof key !== 'string') detailDenied();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) detailDenied();
    output[key] = copyData(descriptor.value, seen);
  }
  return output;
}

function snapshotSummary(input, auditId) {
  let summary;
  try { summary = copyData(input); } catch { detailDenied(); }
  if (!summary || summary.version !== 1 || summary.auditId !== auditId || !summary.groups ||
    Object.keys(summary.groups).length !== GROUP_NAMES.length ||
    GROUP_NAMES.some(groupName => !Array.isArray(summary.groups[groupName]))) detailDenied();
  return summary;
}

function matchingCard(summary, occurrenceId) {
  const matches = [];
  for (const groupName of GROUP_NAMES) {
    for (const card of summary.groups[groupName]) {
      if (!card || !Array.isArray(card.occurrenceIds)) detailDenied();
      if (card.occurrenceIds.includes(occurrenceId)) matches.push({ groupName, card });
    }
  }
  for (const card of summary.checklist ?? []) {
    if (!card || !Array.isArray(card.occurrenceIds)) detailDenied();
    if (card.occurrenceIds.includes(occurrenceId)) matches.push({ groupName: 'humanReview', card });
  }
  if (matches.length !== 1) detailDenied();
  const match = matches[0];
  try {
    assertPanelClassificationV1(match.groupName, match.card.classification, match.card.displayOutcome);
  } catch { detailDenied(); }
  return match.card;
}

function ruleIndex(model) {
  const index = new Map();
  for (const rule of model.ruleResults) {
    const key = JSON.stringify([rule.source.engine, rule.source.ruleId]);
    if (index.has(key)) detailDenied();
    index.set(key, rule);
  }
  return index;
}

function evidenceForOccurrence(occurrence, evidenceById) {
  const evidence = [];
  for (const evidenceId of occurrence.evidenceRefs) {
    const artifact = evidenceById.get(evidenceId);
    if (!artifact || artifact.pageId !== occurrence.pageId) detailDenied();
    if (artifact.nodeId !== undefined && artifact.nodeId !== null && artifact.nodeId !== occurrence.nodeId) detailDenied();
    evidence.push(artifact);
  }
  return evidence;
}

function correlatedLocator(occurrence, evidence) {
  let selector = occurrence.target.selector;
  let framePath = [...occurrence.target.framePath];
  for (const artifact of evidence) {
    if (!artifact.selector || (artifact.nodeId !== undefined && artifact.nodeId !== null && artifact.nodeId !== occurrence.nodeId)) continue;
    const css = artifact.selector.css;
    const frames = artifact.selector.framePath ?? [];
    const exactNodeCorrelation = occurrence.nodeId !== null && occurrence.nodeId !== undefined &&
      artifact.nodeId === occurrence.nodeId;
    if (selector && css && selector !== css && !exactNodeCorrelation) detailDenied();
    if (framePath.length > 0 && frames.length > 0 && JSON.stringify(framePath) !== JSON.stringify(frames)) detailDenied();
    if (!selector && css) selector = css;
    if (framePath.length === 0 && frames.length > 0) framePath = [...frames];
  }
  return { selector, framePath };
}

function accessibilityNodeMatches(occurrence, artifact) {
  if (occurrence.nodeId !== null) return artifact.nodeId === occurrence.nodeId;
  return artifact.nodeId === undefined || artifact.nodeId === null;
}

function accessibilityBlock(occurrence, evidence) {
  const artifact = evidence.find(value => value.accessibility && accessibilityNodeMatches(occurrence, value));
  return {
    name: artifact?.accessibility?.name ?? null,
    nameSource: artifact?.accessibility?.nameSource ?? null,
    announcementPreview: artifact?.accessibility?.announcementPreview ?? null,
  };
}

function correctionFor(occurrence, rule, item) {
  const matchingTarget = rule?.targets?.find(target => {
    if (typeof target === 'string' || Number.isSafeInteger(target)) return String(target) === occurrence.nodeId;
    return target && String(target.nodeId ?? '') === String(occurrence.nodeId ?? '');
  });
  if (matchingTarget && typeof matchingTarget === 'object' && typeof matchingTarget.message === 'string' && matchingTarget.message) {
    return matchingTarget.message;
  }
  if (typeof item?.humanReason === 'string' && item.humanReason) return item.humanReason;
  return rule?.summary ?? occurrence.justification;
}

function safeDataUrl(value) {
  if (typeof value !== 'string') return '';
  try {
    decodePngDataUrl(value);
    return value;
  } catch {
    return '';
  }
}

function previewBlock(evidence) {
  return evidence.map(artifact => {
    const mediaUrl = typeof artifact.mediaUrl === 'string' ? sanitizeEvidenceUrl(artifact.mediaUrl) : '';
    return {
      evidenceId: artifact.evidenceId,
      kind: artifact.kind,
      dataUrl: safeDataUrl(artifact.dataUrl),
      mediaUrl: /^https?:\/\//u.test(mediaUrl) ? mediaUrl : '',
      origin: /^https?:\/\//u.test(mediaUrl) ? projectAuditResourceOrigin(mediaUrl) : '',
    };
  });
}

function technicalSnippet(evidence) {
  const rawSnippet = evidence.find(artifact => typeof artifact.snippet === 'string')?.snippet;
  if (typeof rawSnippet !== 'string') return null;
  return sanitizeHtmlSnippetSource(rawSnippet) || null;
}

function legalReferenceFor({ occurrence, card, item, decision }) {
  const official = item && occurrence.nbrItemRef === item.id;
  const originalEligible = occurrence.legalAnalysis?.basisRef === CONSUMER_ACCESSIBILITY_FIXED_BASIS.id;
  const reviewedEligible = occurrence.outcome === 'cantTell' && decision?.answer === 'não conforme' &&
    typeof decision.evaluator === 'string' && decision.evaluator.length > 0 &&
    typeof decision.decidedAt === 'string' && decision.decidedAt.length > 0 &&
    typeof decision.note === 'string' && decision.note.length > 0;
  if (card.displayOutcome !== 'failed' || !official || item.classification !== 'requirement' || (!originalEligible && !reviewedEligible)) return null;
  return {
    basisRef: CONSUMER_ACCESSIBILITY_FIXED_BASIS.id,
    abntItem: item.id,
    statement: `Inconformidade ao item ${item.id} da ABNT NBR 17225:2025`,
    qualification: null,
  };
}

function targetBlock(occurrences, selectedOccurrenceId) {
  const index = occurrences.findIndex(occurrence => occurrence.occurrenceId === selectedOccurrenceId);
  const occurrence = index >= 0 ? occurrences[index] : null;
  if (!occurrence) detailDenied();
  return [{
    nodeId: occurrence.nodeId,
    position: index + 1,
    total: occurrences.length,
  }];
}

function expectedDisplayOutcome(occurrences, decisionByOccurrence) {
  const priority = { failed: 5, cantTell: 4, untested: 3, passed: 2, inapplicable: 1 };
  const outcomes = occurrences.map(occurrence => {
    if (['failed', 'passed'].includes(occurrence.outcome)) return occurrence.outcome;
    const answer = decisionByOccurrence.get(occurrence.occurrenceId)?.answer;
    if (answer === 'não conforme') return 'failed';
    if (answer === 'conforme') return 'passed';
    return 'cantTell';
  });
  return outcomes.reduce((best, outcome) => priority[outcome] > priority[best] ? outcome : best, 'inapplicable');
}

function freeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value) || Object.isFrozen(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freeze(child, seen);
  return Object.freeze(value);
}

function buildPanelDetailFromCanonical(model, summary, occurrenceId) {
  if (typeof occurrenceId !== 'string') detailDenied();
  const card = matchingCard(summary, occurrenceId);
  const occurrenceById = new Map(model.occurrences.map(occurrence => [occurrence.occurrenceId, occurrence]));
  const occurrence = occurrenceById.get(occurrenceId);
  if (!occurrence || card.checkKey !== JSON.stringify([occurrence.pageId, occurrence.source.engine, occurrence.source.ruleId])) detailDenied();
  const rules = ruleIndex(model);
  const rule = rules.get(JSON.stringify([occurrence.source.engine, occurrence.source.ruleId]));
  const item = occurrence.nbrItemRef === null
    ? null
    : model.itemResults.find(candidate => candidate.id === occurrence.nbrItemRef) ?? null;
  const evidenceById = new Map(model.evidence.map(artifact => [artifact.evidenceId, artifact]));
  const cardOccurrences = card.occurrenceIds.map(id => occurrenceById.get(id));
  const decisionByOccurrence = new Map(model.reviewDecisions.map(candidate => [candidate.occurrenceId, candidate]));
  const checklist = findingKind(occurrence, rule, decisionByOccurrence.get(occurrenceId)) === 'checklist';
  const authoritativeOccurrences = model.occurrences
    .filter(candidate => JSON.stringify([candidate.pageId, candidate.source.engine, candidate.source.ruleId]) === card.checkKey)
    .filter(candidate => (findingKind(candidate, rule, decisionByOccurrence.get(candidate.occurrenceId)) === 'checklist') === checklist)
    .sort((left, right) => left.occurrenceId.localeCompare(right.occurrenceId));
  const authoritativeOccurrenceIds = authoritativeOccurrences.map(candidate => candidate.occurrenceId);
  const exactOccurrenceSet = JSON.stringify(card.occurrenceIds) === JSON.stringify(authoritativeOccurrenceIds);
  const boundedPrefix = summary.limitations.codes.includes(INTERACTIVE_PANEL_LIMITATION) &&
    card.occurrenceIds.length > 0 && card.occurrenceIds.length <= MAX_INTERACTIVE_PANEL_OCCURRENCES &&
    card.occurrenceIds.length < authoritativeOccurrenceIds.length &&
    JSON.stringify(card.occurrenceIds) === JSON.stringify(authoritativeOccurrenceIds.slice(0, card.occurrenceIds.length));
  if (cardOccurrences.some(value => !value) || (!exactOccurrenceSet && !boundedPrefix)) {
    detailDenied();
  }
  const itemById = new Map(model.itemResults.map(candidate => [candidate.id, candidate]));
  const expectedAbntItemIds = [...new Set(authoritativeOccurrences
    .map(candidate => candidate.nbrItemRef)
    .filter(candidate => itemById.has(candidate)))]
    .sort((left, right) => left.localeCompare(right));
  const expectedWcag = displayedWcagRefs(authoritativeOccurrences, rule, expectedAbntItemIds
    .flatMap(itemId => itemById.get(itemId).wcag.map(reference => reference.id))
    .concat(rule?.wcag ?? []));
  if (JSON.stringify(card.abntItemIds) !== JSON.stringify(expectedAbntItemIds) ||
    JSON.stringify(card.wcag) !== JSON.stringify(expectedWcag)) detailDenied();
  if (expectedDisplayOutcome(authoritativeOccurrences, decisionByOccurrence) !== card.displayOutcome ||
    deriveResultContextV1({ occurrences: authoritativeOccurrences, evidenceById }) !== card.context) detailDenied();
  const evidence = evidenceForOccurrence(occurrence, evidenceById);
  const locator = correlatedLocator(occurrence, evidence);
  const decision = model.reviewDecisions.find(candidate => candidate.occurrenceId === occurrenceId) ?? null;
  const title = item?.title ?? rule?.summary ?? occurrence.justification;
  const reason = occurrence.justification || rule?.summary || title;
  const selectedOutcome = ['failed', 'passed'].includes(occurrence.outcome) ? occurrence.outcome
    : decision?.answer === 'não conforme' ? 'failed' : decision?.answer === 'conforme' ? 'passed' : occurrence.outcome;
  const rawCorrection = correctionFor(occurrence, rule, item);
  const guidance = accessibilityGuidance({
    itemId: item?.id, title, outcome: selectedOutcome, observed: reason,
    correction: rawCorrection === reason || rawCorrection === item?.humanReason ? '' : rawCorrection,
  });
  const selectedWcag = displayedWcagRefs([occurrence], rule, (item?.wcag ?? []).map(ref => ref.id));
  const normativeWcag = (item?.wcag ?? []).filter(ref => selectedWcag.includes(ref.id));
  const detail = {
    version: 1,
    auditId: model.auditId,
    occurrenceId,
    checkKey: card.checkKey,
    heading: {
      title,
      classification: card.classification,
      impact: occurrence.impact,
      context: card.context,
    },
    affected: {
      audience: guidance.impact,
      reason: guidance.example,
    },
    observed: [guidance.observed, ...recordedLabelComparisons(item?.id,
      evidence.filter(artifact => accessibilityNodeMatches(occurrence, artifact))).map(row => row.text)].join('\n'),
    correction: [guidance.correction, 'Como conferir:', ...guidance.reviewSteps.map((step, index) => `${index + 1}. ${step}`),
      'Ao revisar, marque conforme somente se o comportamento esperado foi confirmado; não conforme se você comprovou a barreira; inconclusivo se faltarem condições ou conhecimento para decidir.'].join('\n'),
    targets: targetBlock(authoritativeOccurrences, occurrenceId),
    accessibility: accessibilityBlock(occurrence, evidence),
    normative: {
      wcag: normativeWcag.map(reference => reference.id),
      level: normativeWcag.map(reference => reference.level),
      abntItem: item?.id ?? null,
      classification: item?.classification ?? null,
    },
    legalReference: legalReferenceFor({ occurrence, card, item, decision }),
    previews: previewBlock(evidence),
    technical: {
      selector: locator.selector,
      framePath: locator.framePath,
      snippet: technicalSnippet(evidence),
      styles: [],
      engine: occurrence.source.engine,
      ruleId: occurrence.source.ruleId,
      version: occurrence.source.version,
      hashes: evidence.map(artifact => artifact.hash).filter(hash => typeof hash === 'string'),
    },
    action: { ...CONSULT_ACTION },
  };
  return freeze(detail);
}

export function createPanelDetailProjector({ model: inputModel, summary: inputSummary, highlightAvailability: _availability }) {
  let model;
  try { model = createAuditModel(inputModel); } catch { throw new TypeError('PANEL_DETAIL_MODEL_DENIED'); }
  const summary = snapshotSummary(inputSummary, model.auditId);
  const project = occurrenceId => buildPanelDetailFromCanonical(model, summary, occurrenceId);
  return Object.freeze(project);
}

export function buildPanelDetail({ model, summary, occurrenceId, highlightAvailability }) {
  return createPanelDetailProjector({ model, summary, highlightAvailability })(occurrenceId);
}
