import { sanitizeResourceUrl } from '../normalize-snapshot.js';
import { CONSUMER_ACCESSIBILITY_FIXED_BASIS, consumerBasisForOccurrence } from '../legal/consumer-basis.js';
import { NBR17225_EDITORIAL_NOTES, NBR17225_ITEMS } from '../normative/nbr17225.js';
import { NORMATIVE_SOURCE_LEDGER } from '../normative/source-ledger.js';
import { axeEquivalenceForAuditaRule } from '../normative/axe-nbr-crosswalk.js';
import { section508ReferencesForWcag, SECTION508_REVISED_CROSSWALK } from '../normative/section508.js';
import {
  CLASSIFICATIONS,
  CONFIDENCE_LEVELS,
  IMPACT_LEVELS,
  OUTCOMES,
  TEST_MODES,
} from '../result.js';
import { createReviewDecision, REVIEW_MODES } from '../review/decisions.js';
import { canonicalStringify } from './canonical-json.js';
import { projectClosedAuditShape } from './closed-schema.js';
import { auditModelInputError, captureAuditInput } from './audit-input.js';
import { REPORT_HASH_BASE } from './integrity-chain.js';
import { validateNormalizedAxeSupplemental } from '../axe/validate-supplemental.js';
import { aggregateItems } from '../rules/aggregate-items.js';
import { unknownAccessibilityWidgetInventory } from '../detection/accessibility-widgets.js';
import { validateAnnotationMapArtifact } from '../evidence/annotation-map-artifact.js';
import {
  AUDITA_RULES_VERSION,
  hasRegisteredSource,
  registeredOccurrenceSource,
  registeredRuleSource,
} from '../provenance.js';

const SESSION_STATUSES = new Set(['complete', 'partial', 'failed', 'cancelled']);
const REVIEW_STATUSES = new Set(['unanswered', 'answered']);
const METHODOLOGY_NAME = 'Audita Acessibilidade — ABNT NBR 17225 e WCAG 2.2';
const EXPECTED_RULE_COUNT = 130;
const URL_VALUE_KEYS = new Set(['action', 'cite', 'formaction', 'href', 'poster', 'src', 'currentsrc']);
const NORMATIVE_FIELDS = Object.freeze(['itemWcagRefs', 'sourceWcagRefs', 'testedWcagRefs']);
const CORE_RULE_METADATA = new Map(NBR17225_ITEMS.flatMap(item => item.ruleIds.map(ruleId => [ruleId, Object.freeze({
  itemId: item.id,
  mode: item.evaluation,
  wcag: Object.freeze(item.wcag.map(reference => reference.id)),
})])));

export const V1_MIGRATION_DEFAULTS = Object.freeze({
  pageId: 'page-1',
  impact: 'minor',
  confidence: 'low',
  sourceEngine: 'audita-core',
  manualSourceEngine: 'audita-manual-review',
});

export function createAuditModel(input) {
  try {
    return createAuditModelInternal(captureAuditInput(input));
  } catch {
    throw auditModelInputError();
  }
}

function createAuditModelInternal(captured) {
  const source = captured.schemaVersion === 1
    ? captured
    : projectClosedAuditShape(captured);
  const model = source.schemaVersion === 1
    ? projectClosedAuditShape(migrateV1Record(source))
    : source;
  if (model.schemaVersion !== 2) throw new TypeError('schemaVersion de relatório inválida.');
  const validatedAxe = assertAxeSupplementalIntegrity(model, model.versions?.rules ?? model.methodology?.version);
  requiredId(model.auditId, 'auditId');
  validateRequestedScope(model.requestedScope);
  const pageById = validatePages(model.pages);
  validatePagesMatchRequestedScope(model.pages, model.requestedScope);
  validatePrimaryPageCompatibility(model);
  reportUrl(model.requestedUrl, 'requestedUrl');
  reportUrl(model.finalUrl, 'finalUrl');
  validateTimestamps(model.timestamps);
  requiredText(model.timezone, 'timezone');
  validateVersions(model.versions);
  validateMethodology(model.methodology, model.versions, model.reproducibility);
  validateEnvironment(model.environment);
  validateScope(model.scope);
  validateSession(model.session);
  validateBatchSessionStatus(model);
  validateAxeCoverageStatus(model, validatedAxe);
  validateProgress(model.progress, model.auditId);
  validateLimitations(model.limitations);
  validateAccessibilityWidgets(model.accessibilityWidgets);
  validateIntegrity(model.integrity);
  model.itemResults = validateItems(model.itemResults);
  const ruleById = validateRules(
    model.ruleResults,
    new Map(model.itemResults.map(item => [item.id, item])),
    model.versions.rules,
  );
  if (Array.isArray(model.evidence)) {
    model.evidence = model.evidence.map(artifact => {
      const sanitized = sanitizeEvidenceArtifactUrls(artifact);
      if (canonicalStringify(sanitized) !== canonicalStringify(artifact)) {
        throw new TypeError('Evidência V2 contém URL não canônica.');
      }
      return sanitized;
    });
  }
  const graph = validateEvidenceAndOccurrences(model, ruleById, pageById, model.requestedScope.mode);
  validateSinglePageCoreOccurrenceCompleteness(model, ruleById);
  validateAxeEvidenceBinding(model, validatedAxe);
  const reviewGraph = validateReview(model, graph);
  validateItemAuthority(model, ruleById, validatedAxe, reviewGraph);
  validateNormative(model.normative);
  return deepFreeze(model);
}

function validateBatchSessionStatus(model) {
  if (model.requestedScope?.mode !== 'batch') return;
  const statuses = model.pages.map(page => page.status);
  const expected = statuses.some(value => value === 'cancelled')
    ? 'cancelled'
    : statuses.every(value => value === 'complete')
      ? 'complete'
      : statuses.every(value => value === 'failed') ? 'failed' : 'partial';
  if (model.session.status !== expected) throw new TypeError(`Status da sessão diverge das páginas do lote: esperado ${expected}.`);
}

/** Explicit compatibility boundary. Every unknown V1 occurrence quality field is conservative. */
export function migrateAuditV1ToV2(input) {
  try {
    const source = captureAuditInput(input);
    if (source.schemaVersion !== 1) throw new TypeError();
    return createAuditModel(migrateV1Record(source));
  } catch {
    throw auditModelInputError();
  }
}

function migrateV1Record(model) {
  const validatedAxe = assertAxeSupplementalIntegrity(model, model.versions?.rules ?? model.methodology?.version);
  const pageId = V1_MIGRATION_DEFAULTS.pageId;
  const requestedUrl = sanitizeResourceUrl(model.requestedUrl);
  const finalUrl = sanitizeResourceUrl(model.finalUrl);
  const itemById = new Map(NBR17225_ITEMS.map(item => [item.id, item]));
  const evidenceInput = Array.isArray(model.evidence)
    ? model.evidence
    : model.evidence?.artifacts ?? [];
  const evidence = evidenceInput.map(artifact => projectV1Evidence(artifact, pageId));
  const evidenceById = new Map(evidence.map(artifact => [artifact.evidenceId, artifact]));
  const sourceVersion = model.versions?.rules ?? model.methodology?.version ?? 'unknown';
  const downgradedRuleIds = unprovedFailedV1RuleIds(model, itemById, sourceVersion);
  const ruleResults = (model.ruleResults ?? []).map(rule => {
    const nbrItems = [...(rule.nbrItems ?? [])];
    const source = projectSource(rule.source ?? {
      engine: V1_MIGRATION_DEFAULTS.sourceEngine,
      ruleId: rule.ruleId,
      version: sourceVersion,
    });
    const registered = source.engine === V1_MIGRATION_DEFAULTS.sourceEngine
      ? CORE_RULE_METADATA.get(rule.ruleId)
      : null;
    const unsupportedPass = rule.outcome === 'passed' &&
      (nbrItems.some(itemId => !itemById.get(itemId)?.ruleIds.includes(rule.ruleId)) ||
        !hasCorePassProvenance(source, rule.ruleId, sourceVersion));
    const output = projectRuleResult(rule);
    output.outcome = unsupportedPass || downgradedRuleIds.has(rule.ruleId) ? 'cantTell' : rule.outcome;
    output.nbrItems = nbrItems;
    output.wcag = Array.isArray(rule.wcag) ? [...rule.wcag] : registered ? [...registered.wcag] : [];
    output.source = source;
    return output;
  });
  const ruleById = new Map(ruleResults.map(rule => [rule.ruleId, rule]));
  const projectedItemResults = (model.itemResults ?? []).map(projectItemResult);
  const occurrences = (model.occurrences ?? []).map(occurrence => {
    const legacySelector = occurrence.selector;
    const legacyFramePath = occurrence.framePath;
    const item = itemById.get(occurrence.itemId);
    const evidenceRefs = [...(occurrence.evidenceIds ?? [])];
    const targetEvidence = evidenceRefs.map(id => evidenceById.get(id)).find(artifact =>
      occurrence.nodeId && artifact?.nodeId === occurrence.nodeId)
      ?? evidenceRefs.map(id => evidenceById.get(id)).find(Boolean);
    const ruleId = occurrence.ruleId ?? `manual:${occurrence.itemId ?? occurrence.occurrenceId}`;
    const source = projectSource(occurrence.source ?? {
      engine: occurrence.ruleId === null
        ? V1_MIGRATION_DEFAULTS.manualSourceEngine
        : V1_MIGRATION_DEFAULTS.sourceEngine,
      ruleId,
      version: sourceVersion,
    });
    const itemWcagRefs = source.engine === V1_MIGRATION_DEFAULTS.manualSourceEngine
      ? []
      : item?.wcag.map(reference => reference.id) ?? [];
    const sourceWcagRefs = ruleId === 'new-window-link-warning'
      ? []
      : Array.isArray(occurrence.sourceWcagRefs)
      ? occurrence.sourceWcagRefs.filter(reference => itemWcagRefs.includes(reference))
      : Array.isArray(ruleById.get(ruleId)?.wcag)
        ? ruleById.get(ruleId).wcag.filter(reference => itemWcagRefs.includes(reference))
        : [];
    const supportedPass = item?.ruleIds.includes(ruleId) &&
      ruleById.get(ruleId)?.outcome === 'passed' &&
      hasCorePassProvenance(source, ruleId, sourceVersion);
    let outcome = occurrence.outcome === 'passed' && !supportedPass ? 'cantTell' : occurrence.outcome;
    if (source.engine === V1_MIGRATION_DEFAULTS.manualSourceEngine) outcome = 'cantTell';
    if (source.engine === V1_MIGRATION_DEFAULTS.sourceEngine && downgradedRuleIds.has(ruleId)) outcome = 'cantTell';
    const testedInput = Array.isArray(occurrence.testedWcagRefs)
      ? occurrence.testedWcagRefs
      : Array.isArray(occurrence.wcagRefs) ? occurrence.wcagRefs : [];
    let testedWcagRefs = outcome === 'failed'
      ? testedInput.filter(reference => sourceWcagRefs.includes(reference))
      : [];
    if (source.engine === V1_MIGRATION_DEFAULTS.sourceEngine && outcome === 'failed' &&
      ruleId !== 'new-window-link-warning' &&
      canonicalStringify(testedWcagRefs) !== canonicalStringify(sourceWcagRefs)) {
      outcome = 'cantTell';
      testedWcagRefs = [];
    }
    const legalBasis = consumerBasisForOccurrence({
      outcome,
      nbrItemRef: item?.id ?? null,
    });
    const output = projectOccurrenceBase(occurrence);
    output.occurrenceId = occurrence.occurrenceId;
    output.pageId = pageId;
    output.outcome = outcome;
    output.classification = source.engine === 'axe-core' && CLASSIFICATIONS.includes(occurrence.classification)
      ? occurrence.classification : item?.classification ?? 'editorial';
    output.impact = IMPACT_LEVELS.includes(occurrence.impact) ? occurrence.impact : V1_MIGRATION_DEFAULTS.impact;
    output.confidence = CONFIDENCE_LEVELS.includes(occurrence.confidence) ? occurrence.confidence : V1_MIGRATION_DEFAULTS.confidence;
    output.source = source;
    output.nbrItemRef = item?.id ?? null;
    output.itemWcagRefs = itemWcagRefs;
    output.sourceWcagRefs = sourceWcagRefs;
    output.testedWcagRefs = testedWcagRefs;
    output.wcagRefs = [...testedWcagRefs];
    output.foreignBenchmarkRefs = [...section508ReferencesForWcag(testedWcagRefs)];
    output.target = {
      nodeId: occurrence.target?.nodeId ?? occurrence.nodeId ?? null,
      selector: occurrence.target?.selector ?? legacySelector ?? targetEvidence?.selector?.css ?? null,
      framePath: [...(occurrence.target?.framePath ?? legacyFramePath ?? targetEvidence?.selector?.framePath ?? [])],
    };
    output.accessiblePreview = occurrence.accessiblePreview ?? targetEvidence?.accessibility?.announcementPreview ?? null;
    output.evidenceRefs = evidenceRefs;
    output.legalAnalysis = legalBasis ? { basisRef: legalBasis.id } : null;
    if (source.engine === 'axe-core') {
      output.selector = legacySelector ?? output.target.selector;
      output.framePath = [...(legacyFramePath ?? output.target.framePath)];
    }
    if (ruleId === 'new-window-link-warning') {
      output.reason = projectReason(occurrence.reason ?? (outcome === 'failed'
        ? { code: 'missing-new-window-warning', context: { behavior: 'unknown', warning: 'absent' } }
        : { code: 'new-window-warning-observation-incomplete', context: { behavior: 'unknown', warning: 'unknown' } }));
    }
    return output;
  });
  const itemResults = deriveMigratedItemResults(
    projectedItemResults, ruleResults, validatedAxe, downgradedRuleIds,
  );
  const manualReview = projectManualReview(model.manualReview ?? []);
  const queuedOccurrenceIds = new Set(manualReview.map(entry => entry.occurrenceId));
  for (const occurrence of occurrences) {
    const migratedManual = occurrence.source.engine === V1_MIGRATION_DEFAULTS.manualSourceEngine;
    const sourceRule = ruleById.get(occurrence.source.ruleId);
    const reviewableCantTell = occurrence.outcome === 'cantTell' && (migratedManual ||
      downgradedRuleIds.has(occurrence.ruleId) ||
      (occurrence.source.engine === V1_MIGRATION_DEFAULTS.sourceEngine && sourceRule?.mode !== 'automated'));
    if (!reviewableCantTell || queuedOccurrenceIds.has(occurrence.occurrenceId)) continue;
    const item = itemById.get(occurrence.itemId);
    manualReview.push({
      occurrenceId: occurrence.occurrenceId, itemId: occurrence.itemId, ruleId: occurrence.ruleId,
      mode: occurrence.mode === 'manual' ? 'manual' : 'assisted', status: 'unanswered',
      question: `O item “${item?.title ?? occurrence.itemId}” está conforme no contexto observado?`,
      reason: migratedManual
        ? 'A ocorrência V1 depende de uma decisão humana explícita.'
        : downgradedRuleIds.has(occurrence.ruleId)
          ? 'A evidência V1 não registra cobertura normativa autoritativa completa.'
          : 'A ocorrência V1 inconclusiva depende de uma decisão humana explícita.',
    });
    queuedOccurrenceIds.add(occurrence.occurrenceId);
  }
  const ruleCount = model.methodology?.ruleCount;
  const timestamps = projectTimestamps(model.timestamps);
  const viewport = projectViewport(model.environment?.viewport);
  const output = {
    schemaVersion: 2,
    auditId: model.auditId,
    requestedScope: { mode: 'single', urls: [requestedUrl] },
    pages: [{
      pageId, requestedUrl, finalUrl,
      status: model.session?.status,
      timestamps, viewport,
    }],
    requestedUrl, finalUrl, timestamps,
    timezone: model.timezone,
    versions: projectVersions(model.versions),
    environment: { chromeVersion: model.environment?.chromeVersion, viewport },
    scope: projectScope(model.scope),
    methodology: {
      name: model.methodology?.name, version: model.methodology?.version,
      coreRuleCount: EXPECTED_RULE_COUNT,
      supplementalRuleCount: Number.isSafeInteger(ruleCount)
        ? Math.max(0, ruleCount - EXPECTED_RULE_COUNT)
        : 0,
      ruleCount, itemCount: model.methodology?.itemCount,
    },
    session: projectSession(model.session),
    limitations: projectStringArray(model.limitations),
    ruleResults, itemResults, occurrences, evidence,
    evidenceStateCount: Array.isArray(model.evidence) ? model.evidenceStateCount ?? 0 : model.evidence?.stateCount ?? 0,
    manualReview,
    reviewDecisions: projectReviewDecisions(model.reviewDecisions ?? []),
    report: projectReport(model.report),
    reproducibility: projectReproducibility(model.reproducibility),
    normative: migrateV1NormativeRecord(model.normative),
    integrity: model.integrity ?? { algorithm: 'unavailable', status: 'not-recorded-v1' },
  };
  if (model.snapshot !== undefined && model.snapshot !== null) output.snapshot = summarizeV1Snapshot(model.snapshot);
  output.accessibilityWidgets = projectAccessibilityWidgets(model.accessibilityWidgets ?? unknownAccessibilityWidgetInventory());
  if (model.axe !== undefined) output.axe = projectV1Axe(model.axe, ruleResults, occurrences);
  return output;
}

function unprovedFailedV1RuleIds(model, itemById, rulesVersion) {
  const downgraded = new Set();
  for (const rule of model.ruleResults ?? []) {
    const source = rule.source ?? { engine: V1_MIGRATION_DEFAULTS.sourceEngine, ruleId: rule.ruleId, version: rulesVersion };
    if (source.engine !== V1_MIGRATION_DEFAULTS.sourceEngine || rule.outcome !== 'failed') continue;
    const occurrences = (model.occurrences ?? []).filter(value => value?.ruleId === rule.ruleId);
    const fullyProved = occurrences.length > 0 && occurrences.every(occurrence => {
      const item = itemById.get(occurrence.itemId);
      const itemWcag = item?.wcag.map(reference => reference.id) ?? [];
      const expectedSource = rule.ruleId === 'new-window-link-warning'
        ? [] : [...new Set((rule.wcag ?? CORE_RULE_METADATA.get(rule.ruleId)?.wcag ?? [])
          .filter(reference => itemWcag.includes(reference)))];
      const tested = occurrence.testedWcagRefs ?? occurrence.wcagRefs;
      return occurrence.outcome === 'failed' && item?.ruleIds.includes(rule.ruleId) &&
        hasCorePassProvenance(occurrence.source, rule.ruleId, rulesVersion) &&
        sameStringList(occurrence.itemWcagRefs, itemWcag) &&
        sameStringList(occurrence.sourceWcagRefs, expectedSource) &&
        sameStringList(tested, expectedSource) &&
        sameStringList(occurrence.wcagRefs, expectedSource);
    });
    if (!fullyProved) downgraded.add(rule.ruleId);
  }
  return downgraded;
}

function sameStringList(actual, expected) {
  return Array.isArray(actual) && canonicalStringify(actual) === canonicalStringify(expected);
}

function projectV1Evidence(artifact, pageId) {
  const output = {};
  for (const key of [
    'evidenceId', 'kind', 'hash', 'pixelState', 'pixelContentHash', 'state', 'dataUrl',
    'nodeId', 'backendNodeId', 'snippet', 'fullPageEvidenceId', 'mediaUrl',
    'derivation', 'status', 'segments', 'legend', 'counts', 'limits', 'limitations',
  ]) copyOwnData(output, artifact, key);
  output.pageId = artifact.pageId ?? pageId;
  if (artifact.selector !== undefined) {
    output.selector = { css: artifact.selector?.css ?? null, framePath: [...(artifact.selector?.framePath ?? [])] };
  }
  if (artifact.accessibility !== undefined) {
    output.accessibility = projectRecord(artifact.accessibility, [
      'announcementPreview', 'description', 'descriptionSource', 'name', 'nameSource', 'role', 'states', 'valueStatus', 'visibleText',
    ]);
  }
  if (artifact.metadata !== undefined) output.metadata = projectRecord(artifact.metadata, ['annotationMargin', 'clip', 'height', 'highlightBox', 'kind', 'mimeType', 'width']);
  return sanitizeEvidenceArtifactUrls(output);
}

function projectRuleResult(rule) {
  const output = projectRecord(rule, [
    'ruleId', 'outcome', 'mode', 'classification', 'impact', 'confidence', 'engineRuleId',
    'summary', 'limitations',
  ]);
  output.targets = (rule.targets ?? []).map(projectRuleTarget);
  output.nbrItems = [...(rule.nbrItems ?? [])];
  output.wcag = [...(rule.wcag ?? [])];
  return output;
}

function projectRuleTarget(target) {
  if (target === null || typeof target === 'string' || Number.isSafeInteger(target)) return target;
  const output = projectRecord(target, ['nodeId', 'selectorHint', 'message', 'selector', 'framePath']);
  if (target.data !== undefined) output.data = projectRecord(target.data, [
    'attribute', 'behavior', 'coverageKey', 'declaredPurpose', 'durationSeconds', 'flashesPerSecond',
    'height', 'itemId', 'iterationCount', 'largeText', 'level', 'previousLevel', 'ratio', 'reason',
    'role', 'states', 'threshold', 'totalDurationSeconds', 'width',
  ]);
  return output;
}

function projectItemResult(item) {
  const output = projectRecord(item, [
    'id', 'printedId', 'title', 'classification', 'evaluation', 'humanReason', 'outcome',
    'originalOutcome', 'reviewedOutcome',
  ]);
  output.wcag = (item.wcag ?? []).map(reference => projectRecord(reference, ['id', 'level', 'printedLevel']));
  output.ruleIds = [...(item.ruleIds ?? [])];
  output.ruleResults = (item.ruleResults ?? []).map(value => typeof value === 'string' ? value : value?.ruleId)
    .filter(value => typeof value === 'string');
  if (item.review !== undefined) {
    output.review = projectRecord(item.review, ['mode', 'evaluator', 'decidedAt', 'decisionIds']);
  }
  return output;
}

function projectOccurrenceBase(occurrence) {
  const output = {
    occurrenceId: occurrence.occurrenceId,
    pageId: occurrence.pageId ?? V1_MIGRATION_DEFAULTS.pageId,
    outcome: occurrence.outcome,
    classification: occurrence.classification,
    impact: occurrence.impact,
    confidence: occurrence.confidence,
    source: occurrence.source,
    nbrItemRef: occurrence.nbrItemRef ?? occurrence.itemId ?? null,
    itemWcagRefs: [...(occurrence.itemWcagRefs ?? [])],
    sourceWcagRefs: [...(occurrence.sourceWcagRefs ?? [])],
    testedWcagRefs: [...(occurrence.testedWcagRefs ?? [])],
    wcagRefs: [...(occurrence.wcagRefs ?? [])],
    foreignBenchmarkRefs: (occurrence.foreignBenchmarkRefs ?? []).map(value => projectRecord(value, ['benchmarkId', 'criterionId', 'level'])),
    target: { nodeId: occurrence.nodeId ?? null, selector: null, framePath: [] },
    accessiblePreview: occurrence.accessiblePreview ?? null,
    evidenceRefs: [...(occurrence.evidenceRefs ?? occurrence.evidenceIds ?? [])],
    legalAnalysis: occurrence.legalAnalysis === null || occurrence.legalAnalysis === undefined
      ? null : projectRecord(occurrence.legalAnalysis, ['basisRef']),
    itemId: occurrence.itemId ?? occurrence.nbrItemRef ?? null,
    ruleId: occurrence.ruleId ?? null,
    mode: occurrence.mode,
    nodeId: occurrence.nodeId ?? occurrence.target?.nodeId ?? null,
    evidenceIds: [...(occurrence.evidenceIds ?? occurrence.evidenceRefs ?? [])],
    justification: occurrence.justification ?? 'A ocorrência V1 não registrou justificativa textual.',
  };
  for (const key of ['engineRuleId', 'engineResultType', 'equivalenceKey', 'presentationTargetKey']) copyOwnData(output, occurrence, key);
  if (occurrence.applicabilityEvidence !== undefined) output.applicabilityEvidence = copyJsonValue(occurrence.applicabilityEvidence);
  return output;
}

function projectReason(reason) {
  return { code: reason.code, context: { behavior: reason.context?.behavior, warning: reason.context?.warning } };
}

function projectSource(source) {
  const output = projectRecord(source, ['engine', 'ruleId', 'version']);
  copyOwnData(output, source, 'engineRuleId');
  return output;
}

function projectManualReview(entries) {
  return entries.map(entry => projectRecord(entry, [
    'auditId', 'decisionId', 'itemId', 'mode', 'occurrenceId', 'question', 'reason', 'ruleId', 'status',
  ]));
}

function projectReviewDecisions(entries) {
  return entries.map(entry => projectRecord(entry, [
    'answer', 'auditId', 'decidedAt', 'decisionId', 'evaluator', 'itemId', 'mode', 'note', 'occurrenceId',
  ]));
}

function projectTimestamps(value) {
  const startedAt = value?.startedAt;
  const endedAt = value?.endedAt ?? startedAt;
  return { startedAt, endedAt, generatedAt: value?.generatedAt ?? endedAt };
}

function projectViewport(value) {
  return {
    width: value?.width ?? null,
    height: value?.height ?? null,
    deviceScaleFactor: value?.deviceScaleFactor ?? null,
  };
}

function projectVersions(value) {
  return { extension: value?.extension, rules: value?.rules, browser: value?.browser };
}

function projectScope(value) {
  return { kind: value?.kind, description: value?.description };
}

function projectSession(value) {
  return {
    status: value?.status,
    diagnostics: (value?.diagnostics ?? []).map(entry => projectRecord(entry, ['at', 'code', 'message', 'recoverable'])),
    partial: value?.partial,
  };
}

function projectStringArray(value) {
  return Array.isArray(value) ? value.filter(entry => typeof entry === 'string').map(entry => entry) : [];
}

function projectReport(value) {
  const artifact = value?.artifact ?? {};
  const outputArtifact = projectRecord(artifact, ['status', 'pdfFallback', 'limitations']);
  outputArtifact.formats = (artifact.formats ?? []).map(format => typeof format === 'string'
    ? format : projectRecord(format, ['format', 'status']));
  return { status: value?.status, reviewUrl: value?.reviewUrl ?? null, artifact: outputArtifact };
}

function projectReproducibility(value) {
  return projectRecord(value ?? {}, [
    'methodologyVersion', 'snapshotHash', 'ruleResultsHash', 'evidenceHash', 'capturedStateCount',
  ]);
}

function projectAccessibilityWidgets(value) {
  return {
    detector: value.detector, version: value.version, coverage: value.coverage,
    widgets: value.widgets.map(widget => ({ id: widget.id, status: widget.status, signals: [...widget.signals] })),
  };
}

function summarizeV1Snapshot(snapshot) {
  const coverageSource = snapshot.coverage ?? snapshot.document?.coverage ?? {};
  const coverage = projectRecord(coverageSource, ['runtime', 'accessibility', 'frames']);
  const warnings = (snapshot.warnings ?? snapshot.document?.warnings ?? [])
    .filter(value => value && typeof value.code === 'string' && /^[A-Z0-9_:-]{1,120}$/u.test(value.code))
    .map(value => ({ code: value.code }));
  return {
    schemaVersion: Number.isSafeInteger(snapshot.schemaVersion) ? snapshot.schemaVersion : 1,
    retention: 'summary-only',
    nodeCount: Array.isArray(snapshot.nodes) ? snapshot.nodes.length : 0,
    coverage, warnings,
  };
}

function projectV1Axe(axe, rules, occurrences) {
  return {
    status: axe.status,
    provenance: copyJsonValue(axe.provenance),
    diagnostics: (axe.diagnostics ?? []).map(value => projectRecord(value, ['code', 'frameId'])),
    limitations: projectStringArray(axe.limitations),
    ruleResults: rules.filter(rule => rule.source?.engine === 'axe-core').map(copyJsonValue),
    occurrences: occurrences.filter(value => value.source?.engine === 'axe-core').map(value => ({
      ...copyJsonValue(value), evidenceIds: [], evidenceRefs: [],
    })),
    technicalSummary: copyJsonValue(axe.technicalSummary),
  };
}

function projectRecord(source, keys) {
  const output = {};
  for (const key of keys) copyOwnData(output, source, key);
  return output;
}

function copyOwnData(output, source, key) {
  if (source && Object.hasOwn(source, key) && source[key] !== undefined) output[key] = copyJsonValue(source[key]);
}

function copyJsonValue(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(copyJsonValue);
  const output = {};
  for (const key of Object.keys(value)) output[key] = copyJsonValue(value[key]);
  return output;
}

function expectedNormativeRecord() {
  return {
    edition: 'ABNT NBR 17225:2025',
    wcag: 'WCAG 2.2',
    editorialNotes: NBR17225_EDITORIAL_NOTES.map(note => ({ ...note })),
    sources: structuredClone(NORMATIVE_SOURCE_LEDGER),
  };
}

function migrateV1NormativeRecord(normative) {
  if (normative === undefined) return expectedNormativeRecord();
  if (!normative || typeof normative !== 'object' || Array.isArray(normative)) return normative;
  return {
    edition: normative.edition,
    wcag: normative.wcag,
    editorialNotes: normative.editorialNotes === undefined
      ? NBR17225_EDITORIAL_NOTES.map(note => ({ ...note }))
      : copyJsonValue(normative.editorialNotes),
    sources: normative.sources === undefined
      ? structuredClone(NORMATIVE_SOURCE_LEDGER)
      : copyJsonValue(normative.sources),
  };
}

function axeRulesFrom(model) {
  return Array.isArray(model.ruleResults)
    ? model.ruleResults.filter(rule => rule?.source?.engine === 'axe-core' || String(rule?.ruleId ?? '').startsWith('axe.'))
    : [];
}

function axeOccurrencesFrom(model) {
  return Array.isArray(model.occurrences)
    ? model.occurrences.filter(occurrence => occurrence?.source?.engine === 'axe-core' || String(occurrence?.ruleId ?? '').startsWith('axe.'))
    : [];
}

function authoritativeAxeOccurrence(value) {
  return {
    occurrenceId: value.occurrenceId, pageId: value.pageId, ruleId: value.ruleId,
    engineRuleId: value.engineRuleId, engineResultType: value.engineResultType, outcome: value.outcome,
    itemId: value.itemId ?? value.nbrItemRef, nbrItemRef: value.nbrItemRef ?? value.itemId,
    classification: value.classification, impact: value.impact, confidence: value.confidence,
    source: value.source,
    equivalenceKey: value.equivalenceKey,
    presentationTargetKey: value.presentationTargetKey,
    mode: value.mode, nodeId: value.nodeId, selector: value.selector, framePath: value.framePath,
    accessiblePreview: value.accessiblePreview,
    justification: value.justification,
    applicabilityEvidence: value.applicabilityEvidence ?? null,
    legalAnalysis: value.legalAnalysis ?? null,
    itemWcagRefs: value.itemWcagRefs,
    sourceWcagRefs: value.sourceWcagRefs,
    testedWcagRefs: value.testedWcagRefs,
    wcagRefs: value.wcagRefs,
    foreignBenchmarkRefs: value.foreignBenchmarkRefs,
  };
}

function assertAxeSupplementalIntegrity(model, rulesVersion) {
  const reportRules = axeRulesFrom(model);
  const reportOccurrences = axeOccurrencesFrom(model);
  const batchChecked = model.requestedScope?.mode === 'batch' && model.axePages !== undefined
    ? validateBatchAxePages(model, rulesVersion)
    : undefined;
  if (reportRules.length === 0 && reportOccurrences.length === 0 && model.axe === undefined) {
    if (batchChecked === undefined || (batchChecked.occurrences.length === 0 && batchChecked.status !== 'partial')) return null;
  }
  const checked = batchChecked ?? validateNormalizedAxeSupplemental(model.axe, { rulesVersion });
  if (checked.errors.length > 0) throw new TypeError(`Suplemento axe inválido: ${checked.errors.join('; ')}`);
  if (reportRules.length !== checked.ruleResults.length || reportOccurrences.length !== checked.occurrences.length) {
    throw new TypeError('Suplemento axe do relatório diverge do cluster normalizado.');
  }
  const checkedRules = new Map(checked.ruleResults.map(rule => [rule.ruleId, rule]));
  for (const rule of reportRules) {
    const expected = checkedRules.get(rule.ruleId);
    if (!expected || canonicalStringify(rule) !== canonicalStringify(expected)) {
      throw new TypeError(`Regra suplementar ${rule.ruleId} diverge do cluster axe validado.`);
    }
  }
  const checkedOccurrences = new Map(checked.occurrences.map(value => [value.occurrenceId, value]));
  for (const [occurrenceIndex, occurrence] of reportOccurrences.entries()) {
    const label = `Ocorrência suplementar #${occurrenceIndex + 1}`;
    const expected = checkedOccurrences.get(occurrence.occurrenceId);
    const actualKeys = Object.keys(occurrence).sort();
    const expectedKeys = Object.keys(expected ?? {}).sort();
    if (!expected || !validAxeTargetBinding(occurrence, expected, model.schemaVersion) ||
      canonicalStringify(actualKeys) !== canonicalStringify(expectedKeys) ||
      canonicalStringify(authoritativeAxeOccurrence(occurrence)) !== canonicalStringify(authoritativeAxeOccurrence(expected))) {
      throw new TypeError(`${label} diverge do cluster axe validado.`);
    }
    if (model.schemaVersion === 1) {
      if (canonicalStringify(occurrence.wcagRefs) !== canonicalStringify(expected.wcagRefs) ||
        canonicalStringify(occurrence.foreignBenchmarkRefs) !== canonicalStringify(expected.foreignBenchmarkRefs)) {
        throw new TypeError(`${label} diverge das referências originais do mapeamento axe.`);
      }
    } else {
      const item = NBR17225_ITEMS.find(entry => entry.id === expected.nbrItemRef);
      const fullWcag = item?.wcag.map(reference => reference.id) ?? [];
      if (canonicalStringify(occurrence.itemWcagRefs) !== canonicalStringify(fullWcag) ||
        canonicalStringify(occurrence.sourceWcagRefs) !== canonicalStringify(expected.sourceWcagRefs) ||
        canonicalStringify(occurrence.testedWcagRefs) !== canonicalStringify(expected.testedWcagRefs) ||
        canonicalStringify(occurrence.wcagRefs) !== canonicalStringify(expected.testedWcagRefs) ||
        canonicalStringify(occurrence.foreignBenchmarkRefs) !== canonicalStringify([...section508ReferencesForWcag(expected.testedWcagRefs)])) {
        throw new TypeError(`${label} possui expansão WCAG/estrangeira incompatível com o item ABNT.`);
      }
    }
  }
  return checked;
}

function validAxeTargetBinding(occurrence, expected, schemaVersion) {
  const target = occurrence?.target;
  if (!target || typeof target !== 'object' || Array.isArray(target)) return false;
  if (occurrence.nodeId !== expected.nodeId || occurrence.selector !== expected.selector ||
    canonicalStringify(occurrence.framePath) !== canonicalStringify(expected.framePath)) return false;
  const keys = Object.keys(target).sort();
  const v2Target = canonicalStringify(keys) === canonicalStringify(['framePath', 'nodeId', 'selector']) &&
    target.nodeId === occurrence.nodeId && target.selector === occurrence.selector &&
    canonicalStringify(target.framePath) === canonicalStringify(occurrence.framePath);
  if (schemaVersion === 2) return v2Target;
  const normalizedTarget = canonicalStringify(keys) === canonicalStringify(['framePath', 'message', 'selector']) &&
    target.selector === occurrence.selector && target.message === occurrence.justification &&
    canonicalStringify(target.framePath) === canonicalStringify(occurrence.framePath);
  return v2Target || normalizedTarget;
}

function validateBatchAxePages(model, rulesVersion) {
  if (!Array.isArray(model.axePages) || model.axePages.length > 20) {
    throw new TypeError('Envelopes axe do lote inválidos.');
  }
  const pageById = new Map(model.pages.map(page => [page.pageId, page]));
  const seen = new Set();
  const checkedPages = [];
  for (const entry of model.axePages) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
      canonicalStringify(Object.keys(entry).sort()) !== canonicalStringify(['pageId', 'result']) ||
      typeof entry.pageId !== 'string' || seen.has(entry.pageId) || !pageById.has(entry.pageId)) {
      throw new TypeError('Envelope axe do lote referencia página inválida ou duplicada.');
    }
    seen.add(entry.pageId);
    const checked = validateNormalizedAxeSupplemental(entry.result, { rulesVersion, batch: true });
    if (checked.errors.length > 0) throw new TypeError(`Envelope axe da página ${entry.pageId} possui payload inválido.`);
    if (checked.occurrences.some(value => value.pageId !== entry.pageId)) throw new TypeError(`Envelope axe da página ${entry.pageId} possui ocorrência cruzada.`);
    if (pageById.get(entry.pageId).axeStatus !== entry.result.status) throw new TypeError(`Envelope axe da página ${entry.pageId} diverge do estado da página.`);
    checkedPages.push({ ...checked, status: entry.result.status });
  }
  const occurrences = checkedPages.flatMap(value => value.occurrences);
  const grouped = new Map();
  for (const rule of checkedPages.flatMap(value => value.ruleResults)) {
    const values = grouped.get(rule.ruleId) ?? [];
    values.push(rule);
    grouped.set(rule.ruleId, values);
  }
  const ruleResults = [...grouped.values()].map(values => {
    const outcome = values.some(value => value.outcome === 'failed') ? 'failed' : 'cantTell';
    const impactOrder = { critical: 4, serious: 3, moderate: 2, minor: 1 };
    const impact = values.reduce((best, value) => impactOrder[value.impact] > impactOrder[best] ? value.impact : best, 'minor');
    const limitations = [];
    for (const limitation of values.flatMap(value => value.limitations)) if (!limitations.includes(limitation)) limitations.push(limitation);
    return {
      ...structuredClone(values[0]), outcome,
      targets: values.flatMap(value => structuredClone(value.targets)),
      limitations, impact, confidence: outcome === 'failed' ? 'high' : 'low',
      summary: `Resultado agregado de ${values.length} de ${model.pages.length} ${model.pages.length === 1 ? 'página' : 'páginas'}: ${outcome === 'failed' ? 'falha confirmada' : 'não foi possível concluir'}.`,
    };
  });
  return { errors: [], occurrences, ruleResults, status: checkedPages.some(value => value.status === 'partial') ? 'partial' : 'complete' };
}

function validateAxeEvidenceBinding(model, checked) {
  if (!checked) return;
  const conclusiveIds = new Set(checked.occurrences
    .filter(occurrence => occurrence.outcome === 'failed' && occurrence.legalAnalysis?.basisRef === CONSUMER_ACCESSIBILITY_FIXED_BASIS.id)
    .map(occurrence => occurrence.occurrenceId));
  for (const [occurrenceIndex, occurrence] of (model.occurrences ?? []).entries()) {
    if (!conclusiveIds.has(occurrence.occurrenceId)) continue;
    const pristine = (model.evidence ?? []).filter(artifact => artifact.pageId === occurrence.pageId &&
      artifact.kind === 'full-page' && artifact.state === 'pristine');
    if (pristine.length > 0) {
      if (!pristine.some(artifact => occurrence.evidenceRefs.includes(artifact.evidenceId))) {
        throw new TypeError(`Ocorrência axe conclusiva #${occurrenceIndex + 1} não referencia a captura integral original da mesma página.`);
      }
      continue;
    }
    const explicitAbsence = model.session?.diagnostics?.some(entry => entry.code === 'FULL_PAGE_CAPTURE_FAILED' &&
      entry.message === 'Não foi possível capturar a página completa no estado original.' && entry.recoverable === true &&
      canonicalStringify(Object.keys(entry).sort()) === canonicalStringify(['at', 'code', 'message', 'recoverable'])) ||
      model.limitations?.some(value => value === 'A captura integral original da página não estava disponível para vinculação ao achado axe conclusivo.');
    if (!explicitAbsence) throw new TypeError(`Ocorrência axe conclusiva #${occurrenceIndex + 1} não possui captura integral original nem limitação explícita.`);
  }
}

function validateAxeCoverageStatus(model, checked) {
  const partialPageIds = new Set((model.axePages ?? [])
    .filter(entry => entry?.result?.status === 'partial').map(entry => entry.pageId));
  if (!checked || (model.axe?.status !== 'partial' && partialPageIds.size === 0)) return;
  if (model.session?.status === 'complete') {
    throw new TypeError('Cobertura axe parcial não pode pertencer a uma sessão declarada completa.');
  }
  if (model.requestedScope?.mode === 'single' && model.pages?.[0]?.status === 'complete') {
    throw new TypeError('Cobertura axe parcial não pode pertencer a uma página única declarada completa.');
  }
  if (model.requestedScope?.mode === 'batch' && model.pages?.some(page => partialPageIds.has(page.pageId) && page.status === 'complete')) {
    throw new TypeError('Cobertura axe parcial não pode pertencer a uma página do lote declarada completa.');
  }
}

function deriveAuthoritativeItemStates(ruleResults, checkedAxe) {
  const coreRules = (ruleResults ?? []).filter(rule => rule?.source?.engine === 'audita-core');
  const states = new Map(aggregateItems(coreRules, NBR17225_ITEMS).map(item => [item.id, {
    outcome: item.outcome,
    ruleResults: item.ruleResults.map(rule => rule.ruleId),
  }]));
  for (const occurrence of checkedAxe?.occurrences ?? []) {
    if (!occurrence.nbrItemRef || !states.has(occurrence.nbrItemRef)) continue;
    const state = states.get(occurrence.nbrItemRef);
    if (occurrence.outcome === 'failed' || (occurrence.outcome === 'cantTell' && state.outcome !== 'failed')) {
      state.outcome = occurrence.outcome;
    }
  }
  return states;
}

function deriveMigratedItemResults(items, ruleResults, checkedAxe, downgradedRuleIds) {
  const states = deriveAuthoritativeItemStates(ruleResults, checkedAxe);
  return items.map(item => {
    const state = states.get(item.id);
    if (!state) return item;
    const output = { ...item };
    const hasReviewState = ['originalOutcome', 'reviewedOutcome', 'review'].some(field =>
      Object.hasOwn(output, field));
    const coordinatedDowngrade = item.outcome === 'failed' && state.outcome === 'cantTell' &&
      state.ruleResults.some(ruleId => downgradedRuleIds.has(ruleId));
    if (canonicalStringify(item.ruleResults) !== canonicalStringify(state.ruleResults) ||
      (!hasReviewState && item.outcome !== state.outcome && !coordinatedDowngrade)) {
      throw new TypeError('Resultado de item V1 diverge das fontes autoritativas capturadas.');
    }
    output.ruleResults = [...state.ruleResults];
    if (!hasReviewState || coordinatedDowngrade) output.outcome = state.outcome;
    return output;
  });
}

function validateItemAuthority(model, ruleById, checkedAxe, reviewGraph) {
  const states = deriveAuthoritativeItemStates(model.ruleResults, checkedAxe);
  const checkedFailedAxeIds = new Set((checkedAxe?.occurrences ?? [])
    .filter(occurrence => occurrence.outcome === 'failed' && occurrence.nbrItemRef)
    .map(occurrence => occurrence.occurrenceId));
  const occurrencesByItem = new Map();
  for (const occurrence of model.occurrences) {
    if (!occurrence.nbrItemRef) continue;
    const occurrences = occurrencesByItem.get(occurrence.nbrItemRef) ?? [];
    occurrences.push(occurrence);
    occurrencesByItem.set(occurrence.nbrItemRef, occurrences);
  }

  for (const item of model.itemResults) {
    const state = states.get(item.id);
    if (!state || canonicalStringify(item.ruleResults) !== canonicalStringify(state.ruleResults)) {
      throw new TypeError('Resultado de item diverge das regras autoritativas.');
    }
    const itemOccurrences = occurrencesByItem.get(item.id) ?? [];
    if (state.outcome === 'failed' && !hasAuthoritativeFailedOccurrence(
      itemOccurrences, ruleById, checkedFailedAxeIds,
    )) {
      throw new TypeError('Resultado de item falho não possui ocorrência conclusiva autoritativa.');
    }
    validateCantTellOrigins(itemOccurrences, ruleById, reviewGraph);

    const decisions = itemOccurrences
      .map(occurrence => reviewGraph.decisionByOccurrence.get(occurrence.occurrenceId))
      .filter(Boolean);
    const reviewFields = ['originalOutcome', 'reviewedOutcome', 'review'];
    const presentReviewFields = reviewFields.filter(field => Object.hasOwn(item, field));
    if (decisions.length === 0) {
      if (presentReviewFields.length > 0 || item.outcome !== state.outcome) {
        throw new TypeError('Resultado de item diverge das fontes autoritativas ou possui revisão sem decisão.');
      }
      continue;
    }
    if (presentReviewFields.length !== reviewFields.length) {
      throw new TypeError('Resultado de item possui revisão incompleta ou sem grafo de decisões válido.');
    }

    const reviewedOutcome = deriveReviewedItemOutcome(state.outcome, itemOccurrences, decisions);
    const expectedReview = deriveItemReviewSummary(decisions);
    if (item.originalOutcome !== state.outcome || item.reviewedOutcome !== reviewedOutcome ||
      item.outcome !== reviewedOutcome || canonicalStringify(item.review) !== canonicalStringify(expectedReview)) {
      throw new TypeError('Revisão do item diverge das fontes e decisões autoritativas validadas.');
    }
  }
}

function hasAuthoritativeFailedOccurrence(occurrences, ruleById, checkedFailedAxeIds) {
  return occurrences.some(occurrence => {
    if (occurrence.outcome !== 'failed') return false;
    if (occurrence.source.engine === 'axe-core') return checkedFailedAxeIds.has(occurrence.occurrenceId);
    if (occurrence.source.engine !== 'audita-core') return false;
    const sourceRule = ruleById.get(occurrence.source.ruleId);
    return sourceRule?.outcome === 'failed' && sourceRule.nbrItems.includes(occurrence.nbrItemRef);
  });
}

function validateCantTellOrigins(occurrences, ruleById, { queueByOccurrence }) {
  for (const occurrence of occurrences) {
    if (occurrence.outcome !== 'cantTell') continue;
    const sourceRule = ruleById.get(occurrence.source.ruleId);
    const requiresQueue = occurrence.source.engine === 'audita-manual-review' ||
      (occurrence.source.engine === 'audita-core' && sourceRule?.mode !== 'automated');
    if (requiresQueue && !queueByOccurrence.has(occurrence.occurrenceId)) {
      throw new TypeError('Ocorrência inconclusiva revisável não possui fila humana coerente.');
    }
  }
}

function deriveReviewedItemOutcome(originalOutcome, occurrences, decisions) {
  if (originalOutcome === 'failed' || decisions.some(decision => decision.answer === 'não conforme')) {
    return 'failed';
  }
  if (decisions.length === occurrences.length && decisions.every(decision => decision.answer === 'conforme')) {
    return 'passed';
  }
  return 'cantTell';
}

function deriveItemReviewSummary(decisions) {
  const modes = [...new Set(decisions.map(decision => decision.mode))];
  const evaluators = [...new Set(decisions.map(decision => decision.evaluator))];
  const latest = [...decisions].sort((a, b) => a.decidedAt.localeCompare(b.decidedAt)).at(-1);
  return {
    mode: modes.length === 1 ? modes[0] : 'manual',
    evaluator: evaluators.join(', '),
    decidedAt: latest.decidedAt,
    decisionIds: decisions.map(decision => decision.decisionId),
  };
}

/** Privacy boundary for persisted evidence metadata; embedded image payloads remain evidence content. */
export function sanitizeEvidenceArtifactUrls(input, ancestors = new WeakSet()) {
  if (input === null || typeof input !== 'object') return input;
  if (ancestors.has(input)) return null;
  ancestors.add(input);
  try {
    if (Array.isArray(input)) return input.map(value => sanitizeEvidenceArtifactUrls(value, ancestors));
    const output = {};
    for (const [key, value] of Object.entries(input)) {
      const lowerKey = key.toLowerCase();
      const embeddedDataUrl = lowerKey.endsWith('dataurl');
      const urlBearing = !embeddedDataUrl && (URL_VALUE_KEYS.has(lowerKey) || lowerKey.endsWith('url') || lowerKey.endsWith('uri'));
      output[key] = urlBearing && typeof value === 'string'
        ? sanitizeResourceUrl(value)
        : sanitizeEvidenceArtifactUrls(value, ancestors);
    }
    return output;
  } finally {
    ancestors.delete(input);
  }
}

function validatePrimaryPageCompatibility(model) {
  const primary = model.pages[0];
  if (model.requestedUrl !== primary.requestedUrl || model.finalUrl !== primary.finalUrl ||
    canonicalStringify(model.environment?.viewport) !== canonicalStringify(primary.viewport) ||
    (model.requestedScope.mode === 'single' &&
      canonicalStringify(model.timestamps) !== canonicalStringify(primary.timestamps))) {
    throw new TypeError('Campos primários do V2 divergem da página canônica.');
  }
}

function requiredText(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} deve ser texto não vazio.`);
  return value.trim();
}

function requiredId(value, label) {
  const id = requiredText(value, label);
  if (id !== value) throw new TypeError(`${label} deve estar em forma canônica, sem espaços externos.`);
  if (!/^[A-Za-z0-9._:-]{1,200}$/u.test(id)) throw new TypeError(`${label} inválido.`);
  return id;
}

function canonicalText(value, label) {
  const text = requiredText(value, label);
  if (text !== value) throw new TypeError(`${label} deve estar em forma canônica, sem espaços externos.`);
  return text;
}

function reportUrl(value, label) {
  requiredText(value, label);
  const sanitized = sanitizeResourceUrl(value);
  if (!/^https?:\/\//u.test(sanitized)) throw new TypeError(`${label} deve ser URL HTTP(S) segura.`);
  if (sanitized !== value) throw new TypeError(`${label} deve estar em forma canônica.`);
  return sanitized;
}

function validateRequestedScope(scope) {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope) ||
    !['single', 'batch'].includes(scope.mode) || !Array.isArray(scope.urls) || !scope.urls.length) {
    throw new TypeError('requestedScope inválido.');
  }
  const seen = new Set();
  scope.urls.forEach((url, index) => {
    const normalized = reportUrl(url, `requestedScope.urls[${index}]`);
    if (seen.has(normalized)) throw new TypeError('requestedScope contém URL duplicada.');
    seen.add(normalized);
  });
  if (scope.mode === 'single' && scope.urls.length !== 1) {
    throw new TypeError('requestedScope single deve conter exatamente uma URL.');
  }
}

function validatePages(pages) {
  if (!Array.isArray(pages) || !pages.length) throw new TypeError('pages deve conter ao menos uma página.');
  const byId = new Map();
  for (const [index, page] of pages.entries()) {
    if (!page || typeof page !== 'object' || Array.isArray(page)) throw new TypeError(`pages[${index}] inválida.`);
    const pageId = requiredId(page.pageId, `pages[${index}].pageId`);
    if (byId.has(pageId)) throw new TypeError(`pageId duplicado: ${pageId}.`);
    reportUrl(page.requestedUrl, `pages[${index}].requestedUrl`);
    reportUrl(page.finalUrl, `pages[${index}].finalUrl`);
    if (!SESSION_STATUSES.has(page.status)) throw new TypeError(`pages[${index}].status inválido.`);
    validateTimestamps(page.timestamps, `pages[${index}].timestamps`);
    validateViewport(page.viewport, `pages[${index}].viewport`);
    byId.set(pageId, page);
  }
  return byId;
}

function validatePagesMatchRequestedScope(pages, requestedScope) {
  const pageUrls = pages.map(page => page.requestedUrl);
  if (canonicalStringify(pageUrls) !== canonicalStringify(requestedScope.urls)) {
    throw new TypeError('pages deve corresponder exatamente às URLs do requestedScope na ordem solicitada.');
  }
}

function validateTimestamps(timestamps, label = 'timestamps') {
  if (!timestamps || typeof timestamps !== 'object' || Array.isArray(timestamps)) throw new TypeError(`${label} inválidos.`);
  for (const key of ['startedAt', 'endedAt', 'generatedAt']) canonicalInstant(timestamps[key], `${label}.${key}`);
}

function canonicalInstant(value, label) {
  if (typeof value !== 'string' || !value || value.trim() !== value) throw new TypeError(`${label} deve ser ISO canônico.`);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) throw new TypeError(`${label} deve ser ISO canônico.`);
  return value;
}

function validateVersions(versions) {
  if (!versions || typeof versions !== 'object' || Array.isArray(versions)) throw new TypeError('versions inválido.');
  for (const key of ['extension', 'rules', 'browser']) requiredText(versions[key], `versions.${key}`);
  if (versions.rules !== AUDITA_RULES_VERSION) {
    throw new TypeError('Versão das regras não registrada pela metodologia local.');
  }
}

function validateMethodology(methodology, versions, reproducibility) {
  if (!methodology || typeof methodology !== 'object' || Array.isArray(methodology)) throw new TypeError('methodology inválida.');
  if (canonicalText(methodology.name, 'methodology.name') !== METHODOLOGY_NAME) throw new TypeError('Nome da metodologia inválido.');
  const version = canonicalText(methodology.version, 'methodology.version');
  if (version !== versions.rules) throw new TypeError('Versão da metodologia incoerente com a versão das regras.');
  if (!Number.isSafeInteger(methodology.coreRuleCount) || methodology.coreRuleCount !== EXPECTED_RULE_COUNT) {
    throw new TypeError('methodology.coreRuleCount deve registrar exatamente as 130 regras próprias.');
  }
  if (!Number.isSafeInteger(methodology.supplementalRuleCount) || methodology.supplementalRuleCount < 0) {
    throw new TypeError('methodology.supplementalRuleCount inválido.');
  }
  if (!Number.isSafeInteger(methodology.ruleCount) ||
    methodology.ruleCount !== methodology.coreRuleCount + methodology.supplementalRuleCount) {
    throw new TypeError('methodology.ruleCount deve somar regras próprias e suplementares.');
  }
  if (!Number.isSafeInteger(methodology.itemCount) || methodology.itemCount !== NBR17225_ITEMS.length) throw new TypeError('methodology.itemCount deve registrar os 146 itens oficiais.');
  if (reproducibility?.methodologyVersion !== undefined && reproducibility.methodologyVersion !== version) {
    throw new TypeError('Versão reprodutível da metodologia incoerente.');
  }
}

function validateEnvironment(environment) {
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)) throw new TypeError('environment inválido.');
  validateViewport(environment.viewport, 'viewport');
}

function validateViewport(viewport, label) {
  if (!viewport || typeof viewport !== 'object' || Array.isArray(viewport)) throw new TypeError(`${label} inválido.`);
  const values = ['width', 'height', 'deviceScaleFactor'].map(key => viewport[key]);
  if (values.every(value => value === null)) return;
  if (!values.every(value => Number.isFinite(value) && value > 0)) throw new TypeError(`${label} deve ser integralmente observado ou integralmente não disponível.`);
}

function validateScope(scope) {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) throw new TypeError('scope inválido.');
  requiredText(scope.kind, 'scope.kind');
  requiredText(scope.description, 'scope.description');
}

function validateSession(session) {
  if (!session || typeof session !== 'object' || Array.isArray(session) || !SESSION_STATUSES.has(session.status)) throw new TypeError('session inválida.');
  if (!Array.isArray(session.diagnostics)) throw new TypeError('session.diagnostics deve ser lista.');
  for (const [index, diagnostic] of session.diagnostics.entries()) {
    if (!diagnostic || typeof diagnostic !== 'object' || Array.isArray(diagnostic)) throw new TypeError(`session.diagnostics[${index}] deve ser objeto.`);
    requiredId(diagnostic.code, `session.diagnostics[${index}].code`);
    canonicalText(diagnostic.message, `session.diagnostics[${index}].message`);
    canonicalInstant(diagnostic.at, `session.diagnostics[${index}].at`);
    if (typeof diagnostic.recoverable !== 'boolean') throw new TypeError(`session.diagnostics[${index}].recoverable deve ser booleano.`);
  }
}

function validateProgress(progress, auditId) {
  if (progress === undefined) return;
  if (!Array.isArray(progress)) throw new TypeError('progress deve ser lista.');
  let previousPercent = -1;
  for (const [index, entry] of progress.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new TypeError(`progress[${index}] deve ser objeto.`);
    if (entry.type !== 'AUDIT_PROGRESS') throw new TypeError(`progress[${index}].type inválido.`);
    if (requiredId(entry.auditId, `progress[${index}].auditId`) !== auditId
      || requiredId(entry.sessionId, `progress[${index}].sessionId`) !== auditId) {
      throw new TypeError(`progress[${index}] pertence a outra auditoria ou sessão.`);
    }
    canonicalText(entry.phase, `progress[${index}].phase`);
    canonicalText(entry.message, `progress[${index}].message`);
    if (!Number.isFinite(entry.percent) || entry.percent < 0 || entry.percent > 100 || entry.percent < previousPercent) {
      throw new TypeError(`progress[${index}].percent deve ser monotônico entre 0 e 100.`);
    }
    canonicalInstant(entry.at, `progress[${index}].at`);
    previousPercent = entry.percent;
  }
}

function validateLimitations(limitations) {
  if (!Array.isArray(limitations) || limitations.some(value => typeof value !== 'string' || !value.trim())) {
    throw new TypeError('limitations deve conter textos não vazios.');
  }
}

function validateIntegrity(integrity) {
  if (!integrity || typeof integrity !== 'object' || Array.isArray(integrity)) {
    throw new TypeError('integrity deve ser um registro explícito.');
  }
  if (integrity.algorithm === 'unavailable') {
    if (canonicalStringify(integrity) !== canonicalStringify({
      algorithm: 'unavailable', status: 'not-recorded-v1',
    })) throw new TypeError('Registro de integridade V1 indisponível inválido.');
    return;
  }
  if (integrity.algorithm !== 'SHA-256') throw new TypeError('Algoritmo de integridade inválido.');
  const pendingOrHash = value => value === 'pending' || /^[a-f0-9]{64}$/u.test(value ?? '');
  if (!pendingOrHash(integrity.canonicalModelHash) || !pendingOrHash(integrity.evidenceManifestHash) ||
    integrity.hashBase !== REPORT_HASH_BASE) {
    throw new TypeError('Metadados de integridade SHA-256 inválidos.');
  }
}

function validateItems(items) {
  if (!Array.isArray(items) || items.length !== NBR17225_ITEMS.length) throw new TypeError('O modelo deve conter exatamente 146 resultados de item.');
  const byId = new Map();
  for (const item of items) {
    const id = requiredId(item?.id, 'item.id');
    if (byId.has(id)) throw new TypeError(`Item duplicado: ${id}.`);
    byId.set(id, item);
    if (!OUTCOMES.includes(item.outcome)) throw new TypeError(`Resultado inválido no item ${id}.`);
    for (const field of ['originalOutcome', 'reviewedOutcome']) {
      if (item[field] !== undefined && !OUTCOMES.includes(item[field])) throw new TypeError(`${field} inválido no item ${id}.`);
    }
  }
  for (const [index, expected] of NBR17225_ITEMS.entries()) {
    if (items[index]?.id !== expected.id) throw new TypeError('Resultados de item estão fora da ordem canônica.');
    const item = byId.get(expected.id);
    if (!item) throw new TypeError(`Catálogo normativo não contém o item oficial ${expected.id}.`);
    for (const field of ['id', 'printedId', 'title', 'classification', 'evaluation', 'humanReason']) {
      if (item[field] !== expected[field]) throw new TypeError(`Metadado normativo adulterado em ${expected.id}.${field}.`);
    }
    if (canonicalStringify(item.wcag) !== canonicalStringify(expected.wcag)
      || canonicalStringify(item.ruleIds) !== canonicalStringify(expected.ruleIds)) {
      throw new TypeError(`Referências normativas adulteradas no item ${expected.id}.`);
    }
  }
  return items;
}

function validateRules(rules, itemById, rulesVersion) {
  if (!Array.isArray(rules)) throw new TypeError('ruleResults deve ser lista.');
  const byId = new Map();
  for (const rule of rules) {
    const id = requiredId(rule?.ruleId, 'ruleId');
    if (byId.has(id)) throw new TypeError(`Regra duplicada: ${id}.`);
    if (!OUTCOMES.includes(rule.outcome) || !TEST_MODES.includes(rule.mode)) throw new TypeError(`Regra ${id} inválida.`);
    if (!Array.isArray(rule.nbrItems)) throw new TypeError(`Regra ${id}.nbrItems deve ser lista.`);
    const linked = new Set();
    for (const itemId of rule.nbrItems) {
      const canonicalItemId = requiredId(itemId, `Regra ${id}.nbrItems`);
      const item = itemById.get(canonicalItemId);
      if (!item) throw new TypeError(`Regra ${id} referencia item desconhecido.`);
      if (linked.has(canonicalItemId)) throw new TypeError(`Regra ${id} contém vínculo de item duplicado.`);
      if (rule.outcome === 'passed' && !item.ruleIds.includes(id)) {
        throw new TypeError(`Regra suplementar ${id} não pode aprovar automaticamente o item ABNT ${canonicalItemId}.`);
      }
      if (rule.outcome === 'passed' && !hasCorePassProvenance(rule.source, id, rulesVersion)) {
        throw new TypeError(`Regra ${id} não pode aprovar item ABNT sem proveniência audita-core na versão da metodologia.`);
      }
      linked.add(canonicalItemId);
    }
    if (rule.classification !== undefined && !CLASSIFICATIONS.includes(rule.classification)) {
      throw new TypeError(`Regra ${id} possui classificação inválida.`);
    }
    if (rule.impact !== undefined && !IMPACT_LEVELS.includes(rule.impact)) throw new TypeError(`Regra ${id} possui impacto inválido.`);
    if (rule.confidence !== undefined && !CONFIDENCE_LEVELS.includes(rule.confidence)) throw new TypeError(`Regra ${id} possui confiança inválida.`);
    validateSource(rule.source, `Regra ${id}.source`);
    const registeredSource = registeredRuleSource(rule, rulesVersion);
    if (!registeredSource || !hasRegisteredSource(rule.source, registeredSource)) {
      throw new TypeError(`Regra ${id} possui proveniência incoerente com o registro local.`);
    }
    if (rule.source.engine === 'audita-core') {
      const metadata = CORE_RULE_METADATA.get(id);
      if (!metadata || rule.mode !== metadata.mode ||
        canonicalStringify(rule.nbrItems) !== canonicalStringify([metadata.itemId]) ||
        !Array.isArray(rule.wcag) || canonicalStringify(rule.wcag) !== canonicalStringify(metadata.wcag)) {
        throw new TypeError(`Regra ${id} possui mapeamento WCAG incoerente com o registro local.`);
      }
    }
    if (id.startsWith('editorial.') || rule.classification === 'editorial' || rule.source?.engine === 'audita-editorial') {
      validateEditorialRuleResult(rule, id, rulesVersion);
    }
    byId.set(id, rule);
  }
  return byId;
}

function validateEvidenceAndOccurrences(model, ruleById, pageById, scopeMode = 'single') {
  if (!Array.isArray(model.evidence)) throw new TypeError('evidence deve ser lista no modelo V2.');
  const evidenceIds = new Set();
  const artifactById = new Map();
  const announcementMapByPage = new Map();
  for (const artifact of model.evidence) {
    const id = requiredId(artifact?.evidenceId, 'evidenceId');
    if (evidenceIds.has(id)) throw new TypeError(`Evidência duplicada: ${id}.`);
    const pageId = requiredId(artifact?.pageId, `Evidência ${id}.pageId`);
    if (!pageById.has(pageId)) throw new TypeError(`Evidência ${id} referencia página desconhecida.`);
    if (artifact.hash !== undefined && typeof artifact.hash !== 'string') {
      throw new TypeError(`Evidência ${id}.hash deve ser texto quando presente.`);
    }
    evidenceIds.add(id);
    artifactById.set(id, artifact);
    if (artifact.kind === 'announcement-map') {
      if (announcementMapByPage.has(pageId)) throw new TypeError(`Mapa de anúncios duplicado na página ${pageId}.`);
      announcementMapByPage.set(pageId, artifact);
    }
  }
  for (const artifact of model.evidence) {
    if (artifact.fullPageEvidenceId !== undefined) {
      const fullPageId = requiredId(artifact.fullPageEvidenceId, `Evidência ${artifact.evidenceId}.fullPageEvidenceId`);
      const fullPage = artifactById.get(fullPageId);
      if (fullPage?.kind !== 'full-page') throw new TypeError(`Evidência ${artifact.evidenceId} referencia captura integral desconhecida.`);
      if (fullPage.pageId !== artifact.pageId) throw new TypeError(`Evidência ${artifact.evidenceId} referencia captura integral de outra página.`);
    }
    if (artifact.kind === 'announcement-map') {
      validateAnnotationMapArtifact(artifact, { sourceArtifact: artifactById.get(artifact.fullPageEvidenceId) });
    }
  }
  if (!Array.isArray(model.occurrences)) throw new TypeError('occurrences deve ser lista.');
  const itemById = new Map(model.itemResults.map(item => [item.id, item]));
  const itemIds = new Set(itemById.keys());
  const occurrenceById = new Map();
  for (const [occurrenceIndex, occurrence] of model.occurrences.entries()) {
    const label = `Ocorrência #${occurrenceIndex + 1}`;
    const id = requiredId(occurrence?.occurrenceId, 'occurrenceId');
    if (occurrenceById.has(id)) throw new TypeError(`${label} possui identidade duplicada.`);
    const pageId = requiredId(occurrence.pageId, `${label}.pageId`);
    if (!pageById.has(pageId)) throw new TypeError(`${label} referencia página desconhecida.`);
    if (!OUTCOMES.includes(occurrence.outcome) || !CLASSIFICATIONS.includes(occurrence.classification) ||
      !IMPACT_LEVELS.includes(occurrence.impact) || !CONFIDENCE_LEVELS.includes(occurrence.confidence)) {
      throw new TypeError(`${label} possui resultado, classificação, impacto ou confiança inválidos.`);
    }
    validateSource(occurrence.source, `${label}.source`);
    const registeredSource = registeredOccurrenceSource(occurrence, model.versions.rules);
    if (!registeredSource || !hasRegisteredSource(occurrence.source, registeredSource)) {
      throw new TypeError(`${label} possui proveniência incoerente com o registro local.`);
    }
    const sourceRule = ruleById.get(occurrence.source.ruleId);
    const migratedManual = occurrence.source.engine === V1_MIGRATION_DEFAULTS.manualSourceEngine && occurrence.ruleId === null;
    if (!sourceRule && !migratedManual) throw new TypeError(`${label} referencia regra desconhecida.`);
    if (migratedManual && occurrence.outcome !== 'cantTell') {
      throw new TypeError(`${label} de revisão manual deve permanecer cantTell até a decisão humana.`);
    }
    if (sourceRule && occurrence.mode !== undefined && sourceRule.mode !== occurrence.mode) {
      throw new TypeError(`${label} possui modo de regra incoerente.`);
    }
    if ((!migratedManual && occurrence.ruleId !== occurrence.source.ruleId) ||
      (migratedManual && occurrence.ruleId !== null)) {
      throw new TypeError(`${label} possui regra legada incoerente.`);
    }

    const item = occurrence.nbrItemRef === null ? null : itemById.get(occurrence.nbrItemRef);
    if (occurrence.nbrItemRef !== null && !item) throw new TypeError(`${label} referencia item desconhecido.`);
    const normativeClassification = ['requirement', 'recommendation'].includes(occurrence.classification);
    if (normativeClassification && (!item || item.classification !== occurrence.classification)) {
      throw new TypeError(`${label} possui classificação normativa incoerente.`);
    }
    if (!normativeClassification && item) throw new TypeError(`${label} suplementar não pode inventar item ABNT.`);
    if (sourceRule && item && !sourceRule.nbrItems.includes(item.id)) {
      throw new TypeError(`${label} possui vínculo de item incoerente.`);
    }
    if (occurrence.outcome === 'passed' && item &&
      (!sourceRule || sourceRule.outcome !== 'passed' || !item.ruleIds.includes(sourceRule.ruleId) ||
        !hasCorePassProvenance(occurrence.source, sourceRule.ruleId, model.versions.rules))) {
      throw new TypeError(`${label} não pode aprovar item ABNT sem resultado autoritativo aprovado.`);
    }
    if (occurrence.itemId !== undefined && occurrence.itemId !== occurrence.nbrItemRef) {
      throw new TypeError(`${label} possui item legado incoerente.`);
    }
    validateWcagAndForeignReferences(occurrence, item, sourceRule, label, scopeMode);
    validateTarget(occurrence.target, label);
    if (occurrence.nodeId !== occurrence.target.nodeId) {
      throw new TypeError(`${label} possui identidade de alvo incoerente.`);
    }
    if (occurrence.accessiblePreview !== null && typeof occurrence.accessiblePreview !== 'string') {
      throw new TypeError(`${label}.accessiblePreview inválida.`);
    }
    validateEquivalenceIdentity(occurrence, artifactById);
    if (occurrence.justification !== undefined && typeof occurrence.justification !== 'string') {
      throw new TypeError(`${label}.justification deve ser texto quando presente.`);
    }
    validateOccurrenceReason(occurrence, sourceRule, label);
    validateLegalAnalysis(occurrence, label);
    if (occurrence.classification === 'editorial' || occurrence.source.engine === 'audita-editorial') {
      validateEditorialOccurrence(occurrence, sourceRule, label);
    }
    for (const forbidden of ['violatedLaw', 'illegal', 'liability', 'sanction']) {
      if (Object.hasOwn(occurrence, forbidden)) throw new TypeError(`${label} contém conclusão jurídica proibida.`);
    }
    if (!Array.isArray(occurrence.evidenceRefs)) throw new TypeError(`${label} deve listar evidências.`);
    const links = new Set();
    for (const evidenceId of occurrence.evidenceRefs) {
      const canonicalEvidenceId = requiredId(evidenceId, `${label}.evidenceRefs`);
      if (!evidenceIds.has(canonicalEvidenceId)) throw new TypeError(`${label} referencia evidência desconhecida.`);
      if (links.has(canonicalEvidenceId)) throw new TypeError(`${label} contém evidência duplicada.`);
      if (artifactById.get(canonicalEvidenceId).pageId !== pageId) throw new TypeError(`${label} referencia evidência de outra página.`);
      if (artifactById.get(canonicalEvidenceId).kind === 'announcement-map') {
        throw new TypeError(`${label} não pode vincular o mapa derivado da página.`);
      }
      links.add(canonicalEvidenceId);
    }
    if (occurrence.evidenceIds !== undefined && canonicalStringify(occurrence.evidenceIds) !== canonicalStringify(occurrence.evidenceRefs)) {
      throw new TypeError(`${label} possui evidências legadas incoerentes.`);
    }
    occurrenceById.set(id, occurrence);
  }
  return { itemIds, ruleById, occurrenceById, evidenceIds };
}

function validateEquivalenceIdentity(occurrence, artifactById) {
  if (occurrence.source.engine === 'axe-core' || occurrence.source.engine === 'audita-editorial') return;
  const hasEquivalence = Object.hasOwn(occurrence, 'equivalenceKey');
  const hasPresentation = Object.hasOwn(occurrence, 'presentationTargetKey');
  if (!hasEquivalence && !hasPresentation) return;
  if (!hasEquivalence || !hasPresentation) throw new TypeError('Identidade de equivalência incompleta.');
  if (occurrence.source.engine === V1_MIGRATION_DEFAULTS.manualSourceEngine) {
    if (occurrence.equivalenceKey !== `manual:${occurrence.nbrItemRef}` || occurrence.presentationTargetKey !== null) {
      throw new TypeError('Identidade de equivalência manual incoerente.');
    }
    return;
  }
  if (occurrence.source.engine !== V1_MIGRATION_DEFAULTS.sourceEngine) return;
  const equivalence = axeEquivalenceForAuditaRule(occurrence.source.ruleId);
  const expectedEquivalence = equivalence?.equivalenceKey ?? `audita:${occurrence.source.ruleId}`;
  let expectedTarget = equivalence?.targetScope === 'document' ? 'document'
    : occurrence.nodeId ? `node:${occurrence.nodeId}` : null;
  if (expectedTarget === null) {
    const evidenceNodes = [...new Set((occurrence.evidenceRefs ?? [])
      .map(id => artifactById.get(id)?.nodeId).filter(value => typeof value === 'string' && value))];
    if (evidenceNodes.length === 1) expectedTarget = `node:${evidenceNodes[0]}`;
  }
  if (occurrence.equivalenceKey !== expectedEquivalence || occurrence.presentationTargetKey !== expectedTarget) {
    throw new TypeError('Identidade de equivalência core incoerente.');
  }
}

function canonicalCoreTargetNodeId(target) {
  let value = null;
  if (typeof target === 'string' || Number.isSafeInteger(target)) value = String(target);
  else if (target && (typeof target.nodeId === 'string' || Number.isSafeInteger(target.nodeId))) {
    value = String(target.nodeId);
  }
  return value === 'document' ? null : value;
}

function coreOccurrenceTuple(ruleId, itemId, nodeId, outcome) {
  return canonicalStringify([ruleId, itemId, nodeId, outcome]);
}

function validateSinglePageCoreOccurrenceCompleteness(model, ruleById) {
  if (model.requestedScope.mode !== 'single') return;
  const expected = new Map();
  for (const rule of ruleById.values()) {
    if (rule.source?.engine !== 'audita-core' || !['failed', 'cantTell'].includes(rule.outcome)) continue;
    const targets = rule.targets.length > 0 ? rule.targets : [null];
    for (const itemId of rule.nbrItems) for (const target of targets) {
      const key = coreOccurrenceTuple(rule.ruleId, itemId, canonicalCoreTargetNodeId(target), rule.outcome);
      expected.set(key, (expected.get(key) ?? 0) + 1);
    }
  }
  if ([...expected.values()].some(count => count !== 1)) {
    throw new TypeError('Regra core single-page possui produto item/alvo duplicado ou ambíguo.');
  }

  const actual = new Map();
  for (const occurrence of model.occurrences) {
    if (occurrence.source?.engine !== 'audita-core') continue;
    const key = coreOccurrenceTuple(
      occurrence.source.ruleId, occurrence.nbrItemRef, occurrence.nodeId, occurrence.outcome,
    );
    actual.set(key, (actual.get(key) ?? 0) + 1);
  }
  if (actual.size !== expected.size || [...expected].some(([key, count]) => actual.get(key) !== count) ||
    [...actual.values()].some(count => count !== 1)) {
    throw new TypeError('Cobertura de ocorrências core single-page está incompleta ou duplicada.');
  }
}

function validateOccurrenceReason(occurrence, sourceRule, occurrenceLabel) {
  if (occurrence.source?.ruleId !== 'new-window-link-warning') {
    if (occurrence.reason !== undefined) throw new TypeError(`${occurrenceLabel} possui razão estruturada não autorizada.`);
    return;
  }
  const reason = occurrence.reason;
  const expectedCode = occurrence.outcome === 'failed'
    ? 'missing-new-window-warning'
    : 'new-window-warning-observation-incomplete';
  const expectedWarning = occurrence.outcome === 'failed' ? 'absent' : 'unknown';
  const sourceTarget = sourceRule?.targets?.find(target => target && typeof target === 'object' &&
    (target.nodeId ?? null) === (occurrence.nodeId ?? null));
  const expectedBehavior = ['target-blank', 'observed-new-window'].includes(sourceTarget?.data?.behavior)
    ? sourceTarget.data.behavior
    : 'unknown';
  if (!reason || !exactKeys(reason, ['code', 'context']) || reason.code !== expectedCode ||
    !reason.context || !exactKeys(reason.context, ['behavior', 'warning']) ||
    reason.context.behavior !== expectedBehavior || reason.context.warning !== expectedWarning ||
    canonicalStringify(occurrence.sourceWcagRefs) !== '[]' || canonicalStringify(occurrence.testedWcagRefs) !== '[]' ||
    canonicalStringify(occurrence.wcagRefs) !== '[]' || canonicalStringify(occurrence.foreignBenchmarkRefs) !== '[]') {
    throw new TypeError(`${occurrenceLabel} de nova janela possui razão ou alegação normativa inválida.`);
  }
}

function exactKeys(value, expected) {
  return canonicalStringify(Object.keys(value).sort()) === canonicalStringify([...expected].sort());
}

function validateEditorialRuleResult(rule, id, rulesVersion) {
  const expectedKeys = [
    'ruleId', 'outcome', 'mode', 'classification', 'impact', 'confidence', 'source',
    'nbrItems', 'wcag', 'targets', 'summary', 'limitations',
  ];
  const expectedSummary = rule.outcome === 'failed'
    ? 'Há conteúdo provisório inequívoco na página.'
    : rule.outcome === 'cantTell'
      ? 'A verificação editorial ficou incompleta devido ao limite de varredura.'
      : 'Não foi observado conteúdo provisório inequívoco.';
  if (id !== 'editorial.placeholder-text' || !exactKeys(rule, expectedKeys) ||
    !['failed', 'cantTell', 'inapplicable'].includes(rule.outcome) || rule.mode !== 'automated' ||
    rule.classification !== 'editorial' || rule.impact !== 'minor' || rule.confidence !== 'high' ||
    rule.source.engine !== 'audita-editorial' || rule.source.ruleId !== id ||
    rule.source.version !== rulesVersion || !exactKeys(rule.source, ['engine', 'ruleId', 'version']) ||
    canonicalStringify(rule.nbrItems) !== '[]' || canonicalStringify(rule.wcag) !== '[]' ||
    !validateEditorialLimitations(rule.limitations, rule.outcome, rule.targets) || rule.summary !== expectedSummary ||
    !Array.isArray(rule.targets) || rule.targets.length > 64 ||
    (rule.outcome === 'failed') !== (rule.targets.length > 0) ||
    (rule.outcome === 'cantTell' && rule.targets.length !== 0)) {
    throw new TypeError(`Regra editorial ${id} possui esquema inválido.`);
  }
  for (const target of rule.targets) {
    if (!target || typeof target !== 'object' || !exactKeys(target, ['nodeId', 'selectorHint', 'message', 'data']) ||
      requiredId(target.nodeId, `Regra editorial ${id}.target.nodeId`) !== target.nodeId ||
      target.selectorHint !== '' || target.message !== 'Substitua o conteúdo provisório antes da publicação.' ||
      !target.data || !exactKeys(target.data, ['reason']) || target.data.reason !== 'placeholder-text') {
      throw new TypeError(`Regra editorial ${id} possui alvo inválido.`);
    }
  }
}

function validateEditorialLimitations(limitations, outcome, targets) {
  if (!Array.isArray(limitations) || limitations.length > 2) return false;
  const expectedOrder = ['EDITORIAL_NODE_SCAN_TRUNCATED', 'BATCH_PAGE_COVERAGE_INCOMPLETE', 'EDITORIAL_RESULT_LIMIT_REACHED'];
  let previous = -1;
  for (const limitation of limitations) {
    if (!limitation || typeof limitation !== 'object' || Array.isArray(limitation)) return false;
    const index = expectedOrder.indexOf(limitation.code);
    if (index <= previous) return false;
    previous = index;
    if (limitation.code === 'EDITORIAL_NODE_SCAN_TRUNCATED') {
      if (!exactKeys(limitation, ['code', 'retainedNodeCount']) || limitation.retainedNodeCount !== 5_000) return false;
    } else if (limitation.code === 'BATCH_PAGE_COVERAGE_INCOMPLETE') {
      if (!exactKeys(limitation, ['code']) || outcome !== 'cantTell') return false;
    } else if (limitation.code === 'EDITORIAL_RESULT_LIMIT_REACHED') {
      if (!exactKeys(limitation, ['code', 'retainedResultCount']) || limitation.retainedResultCount !== 64 ||
        outcome !== 'failed' || !Array.isArray(targets) || targets.length !== 64) return false;
    } else return false;
  }
  if (outcome === 'inapplicable') return limitations.length === 0;
  if (outcome === 'cantTell') {
    return limitations.length === 1 && ['EDITORIAL_NODE_SCAN_TRUNCATED', 'BATCH_PAGE_COVERAGE_INCOMPLETE'].includes(limitations[0].code);
  }
  return true;
}

function validateEditorialOccurrence(occurrence, sourceRule, occurrenceLabel) {
  const expectedKeys = [
    'occurrenceId', 'pageId', 'outcome', 'classification', 'impact', 'confidence', 'source',
    'nbrItemRef', 'itemWcagRefs', 'sourceWcagRefs', 'testedWcagRefs', 'wcagRefs', 'foreignBenchmarkRefs', 'target', 'accessiblePreview',
    'evidenceRefs', 'legalAnalysis', 'itemId', 'ruleId', 'mode', 'nodeId', 'evidenceIds',
    'justification',
  ];
  if (!exactKeys(occurrence, expectedKeys) || occurrence.outcome !== 'failed' ||
    occurrence.classification !== 'editorial' || occurrence.impact !== 'minor' ||
    occurrence.confidence !== 'high' || occurrence.source.engine !== 'audita-editorial' ||
    occurrence.source.ruleId !== 'editorial.placeholder-text' || occurrence.ruleId !== occurrence.source.ruleId ||
    occurrence.mode !== 'automated' || occurrence.nbrItemRef !== null || occurrence.itemId !== null ||
    occurrence.nodeId !== occurrence.target.nodeId || occurrence.target.selector !== null ||
    canonicalStringify(occurrence.target.framePath) !== '[]' || occurrence.accessiblePreview !== null ||
    canonicalStringify(occurrence.itemWcagRefs) !== '[]' || canonicalStringify(occurrence.sourceWcagRefs) !== '[]' ||
    canonicalStringify(occurrence.testedWcagRefs) !== '[]' || canonicalStringify(occurrence.wcagRefs) !== '[]' ||
    canonicalStringify(occurrence.foreignBenchmarkRefs) !== '[]' ||
    canonicalStringify(occurrence.evidenceRefs) !== '[]' || canonicalStringify(occurrence.evidenceIds) !== '[]' ||
    occurrence.legalAnalysis !== null || occurrence.justification !== 'Há conteúdo provisório inequívoco na página.' ||
    !sourceRule || sourceRule.outcome !== 'failed') {
    throw new TypeError(`${occurrenceLabel} editorial possui esquema inválido.`);
  }
}

function validateAccessibilityWidgets(inventory) {
  if (!inventory || typeof inventory !== 'object' || Array.isArray(inventory) ||
    !exactKeys(inventory, ['detector', 'version', 'coverage', 'widgets']) ||
    inventory.detector !== 'audita.accessibility-widgets' || inventory.version !== '1.0.0' ||
    !['complete', 'partial', 'unavailable'].includes(inventory.coverage) ||
    !Array.isArray(inventory.widgets) || inventory.widgets.length !== 2) {
    throw new TypeError('Inventário de widgets de acessibilidade inválido.');
  }
  const ids = ['vlibras', 'hand-talk'];
  const signalOrder = ['dom-signature', 'script-signature', 'global-signature'];
  for (let index = 0; index < ids.length; index += 1) {
    const widget = inventory.widgets[index];
    if (!widget || typeof widget !== 'object' || Array.isArray(widget) ||
      !exactKeys(widget, ['id', 'status', 'signals']) || widget.id !== ids[index] ||
      !['present', 'absent', 'unknown'].includes(widget.status) || !Array.isArray(widget.signals)) {
      throw new TypeError('Inventário de widgets possui item, ordem ou campo inválido.');
    }
    const positions = widget.signals.map(signal => signalOrder.indexOf(signal));
    if (positions.some(position => position < 0) || new Set(positions).size !== positions.length ||
      positions.some((position, signalIndex) => signalIndex > 0 && position <= positions[signalIndex - 1])) {
      throw new TypeError('Inventário de widgets possui sinal inválido ou fora de ordem.');
    }
    const expectedStatus = positions.length > 0 ? 'present' : inventory.coverage === 'complete' ? 'absent' : 'unknown';
    if (widget.status !== expectedStatus) throw new TypeError('Inventário de widgets possui status incoerente com cobertura e sinais.');
  }
}

function hasCorePassProvenance(source, ruleId, rulesVersion) {
  return source?.engine === V1_MIGRATION_DEFAULTS.sourceEngine &&
    source.ruleId === ruleId && source.version === rulesVersion;
}

function validateSource(source, label) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new TypeError(`${label} inválida.`);
  for (const field of ['engine', 'ruleId', 'version']) canonicalText(source[field], `${label}.${field}`);
}

function validateWcagAndForeignReferences(occurrence, item, sourceRule, occurrenceLabel, scopeMode) {
  for (const field of [...NORMATIVE_FIELDS, 'wcagRefs']) {
    if (!Array.isArray(occurrence[field])) throw new TypeError(`${occurrenceLabel}.${field} deve ser lista.`);
    if (new Set(occurrence[field]).size !== occurrence[field].length || occurrence[field].some(reference => typeof reference !== 'string')) {
      throw new TypeError(`${occurrenceLabel}.${field} possui referência inválida ou duplicada.`);
    }
  }
  const expectedItemWcag = item?.wcag.map(reference => reference.id) ?? [];
  let authoritativeItemWcag = expectedItemWcag;
  let authoritativeSourceWcag = occurrence.sourceWcagRefs;
  let authoritativeTestedWcag = occurrence.testedWcagRefs;
  if (occurrence.source.engine === 'audita-manual-review' || occurrence.source.engine === 'audita-editorial') {
    authoritativeItemWcag = [];
    authoritativeSourceWcag = [];
    authoritativeTestedWcag = [];
  } else if (occurrence.source.engine === 'audita-core') {
    authoritativeSourceWcag = occurrence.source.ruleId === 'new-window-link-warning'
      ? []
      : [...new Set((sourceRule?.wcag ?? []).filter(reference => expectedItemWcag.includes(reference)))];
    authoritativeTestedWcag = occurrence.source.ruleId !== 'new-window-link-warning' && occurrence.outcome === 'failed'
      ? [...authoritativeSourceWcag]
      : [];
    const outcomeBound = sourceRule && (scopeMode === 'single'
      ? occurrence.outcome === sourceRule.outcome
      : (
        (occurrence.outcome === 'failed' && sourceRule.outcome === 'failed') ||
        (occurrence.outcome === 'cantTell' && ['failed', 'cantTell'].includes(sourceRule.outcome)) ||
        (occurrence.outcome === 'passed' && sourceRule.outcome === 'passed') ||
        (occurrence.outcome === 'inapplicable' && sourceRule.outcome === 'inapplicable') ||
        (occurrence.outcome === 'untested' && sourceRule.outcome === 'untested')
      ));
    if (!outcomeBound) {
      throw new TypeError(`${occurrenceLabel} possui resultado incoerente com a regra autoritativa.`);
    }
  }
  if (canonicalStringify(occurrence.itemWcagRefs) !== canonicalStringify(authoritativeItemWcag) ||
    canonicalStringify(occurrence.sourceWcagRefs) !== canonicalStringify(authoritativeSourceWcag) ||
    canonicalStringify(occurrence.testedWcagRefs) !== canonicalStringify(authoritativeTestedWcag) ||
    canonicalStringify(occurrence.wcagRefs) !== canonicalStringify(authoritativeTestedWcag)) {
    throw new TypeError(`${occurrenceLabel} possui separação WCAG incoerente.`);
  }
  if (!Array.isArray(occurrence.foreignBenchmarkRefs)) throw new TypeError(`${occurrenceLabel}.foreignBenchmarkRefs deve ser lista.`);
  const expectedForeign = [...section508ReferencesForWcag(authoritativeTestedWcag)];
  if (canonicalStringify(occurrence.foreignBenchmarkRefs) !== canonicalStringify(expectedForeign) ||
    occurrence.foreignBenchmarkRefs.some(reference => reference.benchmarkId !== SECTION508_REVISED_CROSSWALK.id)) {
    throw new TypeError(`${occurrenceLabel} possui referência estrangeira que não deriva dos critérios testados.`);
  }
}

function validateTarget(target, occurrenceLabel) {
  if (!target || typeof target !== 'object' || Array.isArray(target)) throw new TypeError(`${occurrenceLabel}.target inválido.`);
  if (target.nodeId !== null) requiredId(target.nodeId, `${occurrenceLabel}.target.nodeId`);
  if (target.selector !== null && (typeof target.selector !== 'string' || target.selector.trim() !== target.selector)) {
    throw new TypeError(`${occurrenceLabel}.target.selector inválido.`);
  }
  if (!Array.isArray(target.framePath) || target.framePath.some(value => typeof value !== 'string')) {
    throw new TypeError(`${occurrenceLabel}.target.framePath inválido.`);
  }
}

function validateLegalAnalysis(occurrence, occurrenceLabel) {
  const expected = consumerBasisForOccurrence(occurrence);
  if (!expected) {
    if (occurrence.legalAnalysis !== null) throw new TypeError(`${occurrenceLabel} não pode conter análise jurídica.`);
    return;
  }
  if (canonicalStringify(occurrence.legalAnalysis) !== canonicalStringify({ basisRef: CONSUMER_ACCESSIBILITY_FIXED_BASIS.id })) {
    throw new TypeError(`${occurrenceLabel} deve referenciar a base consumerista fixa.`);
  }
}

function validateReview(model, { itemIds, occurrenceById }) {
  if (!Array.isArray(model.manualReview) || !Array.isArray(model.reviewDecisions)) throw new TypeError('Fila e decisões de revisão devem ser listas.');
  const queueByOccurrence = new Map();
  for (const [entryIndex, entry] of model.manualReview.entries()) {
    const label = `Fila de revisão #${entryIndex + 1}`;
    const occurrenceId = requiredId(entry?.occurrenceId, 'manualReview.occurrenceId');
    if (queueByOccurrence.has(occurrenceId)) throw new TypeError(`${label} possui ocorrência duplicada.`);
    const occurrence = occurrenceById.get(occurrenceId);
    if (!occurrence) throw new TypeError(`${label} referencia ocorrência desconhecida.`);
    if (!itemIds.has(entry.itemId) || entry.itemId !== occurrence.itemId) throw new TypeError(`${label} referencia item incoerente.`);
    if (entry.ruleId !== occurrence.ruleId) throw new TypeError(`${label} referencia regra incoerente.`);
    if (!REVIEW_MODES.includes(entry.mode)) throw new TypeError(`${label} possui modo inválido.`);
    const expectedMode = occurrence.mode === 'manual' ? 'manual' : 'assisted';
    if (entry.mode !== expectedMode) throw new TypeError(`${label} possui modo incoerente.`);
    if (!REVIEW_STATUSES.has(entry.status)) throw new TypeError(`${label} possui status inválido.`);
    canonicalText(entry.question, `${label}.question`);
    canonicalText(entry.reason, `${label}.reason`);
    if (entry.auditId !== undefined && entry.auditId !== model.auditId) throw new TypeError(`${label} pertence a outra auditoria.`);
    queueByOccurrence.set(occurrenceId, entry);
  }

  const decisionIds = new Set();
  const decisionByOccurrence = new Map();
  for (const decision of model.reviewDecisions) {
    const normalized = createReviewDecision(decision);
    const decisionId = requiredId(decision.decisionId, 'reviewDecision.decisionId');
    if (decisionId !== normalized.decisionId) throw new TypeError(`Identificador de decisão incoerente: ${decisionId}.`);
    if (decisionIds.has(decisionId) || decisionByOccurrence.has(normalized.occurrenceId)) throw new TypeError('Decisão de revisão duplicada ou ambígua.');
    if (normalized.auditId !== model.auditId) throw new TypeError('Decisão pertence a outra auditoria.');
    const occurrence = occurrenceById.get(normalized.occurrenceId);
    if (!occurrence || occurrence.itemId !== normalized.itemId) throw new TypeError('Decisão referencia item ou ocorrência desconhecidos.');
    const queue = queueByOccurrence.get(normalized.occurrenceId);
    if (!queue || queue.mode !== normalized.mode) throw new TypeError('Decisão não corresponde à fila de revisão.');
    for (const field of ['auditId', 'itemId', 'occurrenceId', 'answer', 'evaluator', 'decidedAt', 'mode', 'note']) {
      if (decision[field] !== normalized[field]) throw new TypeError(`Decisão ${decisionId} não está em forma canônica.`);
    }
    decisionIds.add(decisionId);
    decisionByOccurrence.set(normalized.occurrenceId, normalized);
  }
  for (const [occurrenceId, entry] of queueByOccurrence) {
    const decision = decisionByOccurrence.get(occurrenceId);
    if (entry.status === 'answered') {
      if (!decision || entry.decisionId !== decision.decisionId) throw new TypeError('Fila respondida não referencia sua decisão.');
    } else if (decision || entry.decisionId !== undefined) {
      throw new TypeError('Fila não respondida não pode conter decisão.');
    }
  }
  return { decisionByOccurrence, queueByOccurrence };
}

function validateNormative(normative) {
  if (!normative || typeof normative !== 'object' || Array.isArray(normative) ||
    canonicalStringify(normative) !== canonicalStringify(expectedNormativeRecord())) {
    throw new TypeError('Registro normativo ou ledger de fontes adulterado ou ausente.');
  }
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value) || Object.isFrozen(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}
