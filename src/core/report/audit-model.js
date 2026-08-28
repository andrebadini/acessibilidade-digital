import { sanitizeResourceUrl } from '../normalize-snapshot.js';
import { CONSUMER_ACCESSIBILITY_FIXED_BASIS, consumerBasisForOccurrence } from '../legal/consumer-basis.js';
import { NBR17225_EDITORIAL_NOTES, NBR17225_ITEMS } from '../normative/nbr17225.js';
import { NORMATIVE_SOURCE_LEDGER } from '../normative/source-ledger.js';
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
import { assertClosedAuditShape } from './closed-schema.js';
import { projectEvidenceManifest, REPORT_HASH_BASE, verifyIntegrityLinks } from './integrity-chain.js';
import { sha256Hex } from './hash.js';
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
export const LEGACY_V2_NORMATIVE_LIMITATION = 'Proveniência legada: a separação entre contexto do item, mapeamento da fonte e critérios WCAG testados não foi registrada; nenhuma cobertura WCAG ou Section 508 foi inferida na migração.';
const NORMATIVE_FIELDS = Object.freeze(['itemWcagRefs', 'sourceWcagRefs', 'testedWcagRefs']);
const CORE_RULE_METADATA = new Map(NBR17225_ITEMS.flatMap(item => item.ruleIds.map(ruleId => [ruleId, Object.freeze({
  itemId: item.id,
  mode: item.evaluation,
  wcag: Object.freeze(item.wcag.map(reference => reference.id)),
})])));
const VERIFIED_LEGACY_SNAPSHOTS = new WeakMap();

export const V1_MIGRATION_DEFAULTS = Object.freeze({
  pageId: 'page-1',
  impact: 'minor',
  confidence: 'low',
  sourceEngine: 'audita-core',
  manualSourceEngine: 'audita-manual-review',
});

export function createAuditModel(input) {
  const legacyIds = VERIFIED_LEGACY_SNAPSHOTS.get(input);
  const model = createAuditModelInternal(input, legacyIds ?? new Set(), legacyIds !== undefined);
  if (legacyIds) VERIFIED_LEGACY_SNAPSHOTS.set(model, legacyIds);
  return model;
}

/**
 * Verifies the untouched legacy chain, migrates conservatively, rehashes and
 * validates the resulting V2 model. This is the only legacy migration issuer.
 */
export async function verifyAndMigrateLegacyAuditV2(input) {
  let source;
  try { source = JSON.parse(canonicalStringify(input)); } catch {
    throw new TypeError('Modelo V2 legado contém propriedade não segura ou valor inválido.');
  }
  if (source.schemaVersion !== 2) throw new TypeError('A migração normativa aceita somente modelo V2 legado.');
  const scan = scanNormativeFieldPresence(source);
  if (!scan.hasLegacy) {
    throw new TypeError('O modelo não contém migração normativa legada verificável.');
  }

  await verifyIntegrityLinks(source);
  if (scan.hasPartial) {
    throw new TypeError('Ocorrência possui separação normativa parcial.');
  }

  const legacyIds = scan.legacyIds;
  migrateLegacyV2NormativeFields(source, legacyIds);
  source = await rehashLegacyIntegrityLinks(source);
  const model = createAuditModelInternal(source, legacyIds, true);
  await verifyIntegrityLinks(model);
  VERIFIED_LEGACY_SNAPSHOTS.set(model, new Set(legacyIds));
  return model;
}

function createAuditModelInternal(input, legacyNormativeIds = new Set(), verifiedLegacyLineage = false) {
  const source = JSON.parse(canonicalStringify(input));
  assertClosedAuditShape(source);
  if (source.schemaVersion === 2) {
    if (!verifiedLegacyLineage && Array.isArray(source.limitations) &&
      source.limitations.includes(LEGACY_V2_NORMATIVE_LIMITATION)) {
      throw new TypeError('Snapshot derivado de migração V2 exige a linhagem exata verificada no processo.');
    }
    const scan = scanNormativeFieldPresence(source);
    if (scan.hasLegacy) {
      throw new TypeError('A integridade V2 legada deve ser verificada antes da migração normativa.');
    }
    if (scan.hasPartial) {
      throw new TypeError('Ocorrência possui separação normativa parcial.');
    }
  }
  const model = source.schemaVersion === 1 ? migrateV1Record(source) : source;
  if (model.schemaVersion !== 2) throw new TypeError('schemaVersion de relatório inválida.');
  if (model.accessibilityWidgets === undefined) model.accessibilityWidgets = unknownAccessibilityWidgetInventory();
  const validatedAxe = assertAxeSupplementalIntegrity(model, model.versions?.rules ?? model.methodology?.version, legacyNormativeIds);
  requiredId(model.auditId, 'auditId');
  validateRequestedScope(model.requestedScope);
  const pageById = validatePages(model.pages);
  validatePagesMatchRequestedScope(model.pages, model.requestedScope);
  projectPrimaryPageCompatibility(model);
  model.requestedUrl = reportUrl(model.requestedUrl, 'requestedUrl');
  model.finalUrl = reportUrl(model.finalUrl, 'finalUrl');
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
  projectOccurrenceCompatibility(model.occurrences, ruleById);
  if (Array.isArray(model.evidence)) {
    model.evidence = model.evidence.map(artifact => sanitizeEvidenceArtifactUrls(artifact));
  }
  const graph = validateEvidenceAndOccurrences(
    model, ruleById, pageById, legacyNormativeIds, model.requestedScope.mode,
  );
  validateSinglePageCoreOccurrenceCompleteness(model, ruleById);
  validateAxeEvidenceBinding(model, validatedAxe);
  const reviewGraph = validateReview(model, graph);
  validateAxeItemAggregation(model, validatedAxe, reviewGraph);
  validatePassedItemAuthority(model.itemResults, ruleById, reviewGraph);
  validateNormative(model.normative);
  return deepFreeze(model);
}

function allOccurrenceCollections(model) {
  const collections = [];
  if (Array.isArray(model.occurrences)) collections.push(model.occurrences);
  if (Array.isArray(model.axe?.occurrences)) collections.push(model.axe.occurrences);
  if (Array.isArray(model.axePages)) {
    for (const page of model.axePages) if (Array.isArray(page?.result?.occurrences)) collections.push(page.result.occurrences);
  }
  return collections;
}

function scanNormativeFieldPresence(model) {
  const legacyIds = new Set();
  let hasPartial = false;
  let hasLegacy = false;
  for (const collection of allOccurrenceCollections(model)) {
    for (const occurrence of collection) {
      if (!occurrence || typeof occurrence !== 'object' || Array.isArray(occurrence)) continue;
      const present = NORMATIVE_FIELDS.filter(field => Object.hasOwn(occurrence, field));
      if (present.length > 0 && present.length < NORMATIVE_FIELDS.length) {
        hasPartial = true;
      }
      if (present.length === 0) {
        hasLegacy = true;
        if (typeof occurrence.occurrenceId === 'string') legacyIds.add(occurrence.occurrenceId);
      }
    }
  }
  return { hasLegacy, legacyIds, hasPartial };
}

function migrateLegacyV2NormativeFields(model, occurrenceIds) {
  for (const collection of allOccurrenceCollections(model)) {
    for (const occurrence of collection) {
      if (!occurrence || typeof occurrence !== 'object' || Array.isArray(occurrence) ||
        !occurrenceIds.has(occurrence.occurrenceId) || NORMATIVE_FIELDS.some(field => Object.hasOwn(occurrence, field))) continue;
      const item = NBR17225_ITEMS.find(entry => entry.id === (occurrence.nbrItemRef ?? occurrence.itemId));
      occurrence.itemWcagRefs = ['audita-manual-review', 'audita-editorial'].includes(occurrence.source?.engine)
        ? []
        : item?.wcag.map(reference => reference.id) ?? [];
      occurrence.sourceWcagRefs = [];
      occurrence.testedWcagRefs = [];
      occurrence.wcagRefs = [];
      occurrence.foreignBenchmarkRefs = [];
    }
  }
  for (const rule of model.ruleResults ?? []) {
    if (rule?.source?.engine !== 'audita-core' || rule.wcag !== undefined) continue;
    const metadata = CORE_RULE_METADATA.get(rule.ruleId);
    if (metadata) rule.wcag = [...metadata.wcag];
  }
  if (!Array.isArray(model.limitations)) model.limitations = [];
  if (!model.limitations.includes(LEGACY_V2_NORMATIVE_LIMITATION)) model.limitations.push(LEGACY_V2_NORMATIVE_LIMITATION);
  if (model.normative === undefined) {
    model.normative = expectedNormativeRecord();
  } else if (model.normative && typeof model.normative === 'object' && !Array.isArray(model.normative) &&
    model.normative.sources === undefined) {
    model.normative.sources = structuredClone(NORMATIVE_SOURCE_LEDGER);
  }
}

async function rehashLegacyIntegrityLinks(input) {
  const model = structuredClone(input);
  const evidenceManifestHash = await sha256Hex(canonicalStringify(projectEvidenceManifest(model.evidence)));
  model.integrity = {
    algorithm: 'SHA-256', evidenceManifestHash, canonicalModelHash: 'pending', hashBase: REPORT_HASH_BASE,
  };
  const hashInput = structuredClone(model);
  delete hashInput.integrity.canonicalModelHash;
  model.integrity.canonicalModelHash = await sha256Hex(canonicalStringify(hashInput));
  return model;
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
  const source = JSON.parse(canonicalStringify(input));
  if (source.schemaVersion !== 1) throw new TypeError('A migração explícita aceita somente relatórios V1.');
  return createAuditModel(migrateV1Record(source));
}

function migrateV1Record(model) {
  assertAxeSupplementalIntegrity(model, model.versions?.rules ?? model.methodology?.version);
  const pageId = V1_MIGRATION_DEFAULTS.pageId;
  const requestedUrl = sanitizeResourceUrl(model.requestedUrl);
  const finalUrl = sanitizeResourceUrl(model.finalUrl);
  const itemById = new Map(NBR17225_ITEMS.map(item => [item.id, item]));
  const evidenceInput = Array.isArray(model.evidence)
    ? model.evidence
    : model.evidence?.artifacts ?? [];
  const evidence = evidenceInput.map(artifact => sanitizeEvidenceArtifactUrls({
    ...artifact,
    pageId: artifact.pageId ?? pageId,
  }));
  const evidenceById = new Map(evidence.map(artifact => [artifact.evidenceId, artifact]));
  const sourceVersion = model.versions?.rules ?? model.methodology?.version ?? 'unknown';
  const ruleResults = (model.ruleResults ?? []).map(rule => {
    const nbrItems = [...(rule.nbrItems ?? [])];
    const source = rule.source ?? {
      engine: V1_MIGRATION_DEFAULTS.sourceEngine,
      ruleId: rule.ruleId,
      version: sourceVersion,
    };
    const registered = source.engine === V1_MIGRATION_DEFAULTS.sourceEngine
      ? CORE_RULE_METADATA.get(rule.ruleId)
      : null;
    const unsupportedPass = rule.outcome === 'passed' &&
      (nbrItems.some(itemId => !itemById.get(itemId)?.ruleIds.includes(rule.ruleId)) ||
        !hasCorePassProvenance(source, rule.ruleId, sourceVersion));
    return {
      ...rule,
      outcome: unsupportedPass ? 'cantTell' : rule.outcome,
      nbrItems,
      ...(Array.isArray(rule.wcag) ? { wcag: [...rule.wcag] } : registered ? { wcag: [...registered.wcag] } : {}),
      source,
    };
  });
  const ruleById = new Map(ruleResults.map(rule => [rule.ruleId, rule]));
  const authoritativePassedItems = new Set(ruleResults
    .filter(rule => rule.outcome === 'passed')
    .flatMap(rule => rule.nbrItems));
  const itemResults = (model.itemResults ?? []).map(item => item.outcome === 'passed' &&
    item.reviewedOutcome !== 'passed' && !authoritativePassedItems.has(item.id)
    ? { ...item, outcome: 'cantTell' }
    : item);
  const occurrences = (model.occurrences ?? []).map(occurrence => {
    const {
      selector: legacySelector,
      framePath: legacyFramePath,
      ...canonicalOccurrenceInput
    } = occurrence;
    const item = itemById.get(occurrence.itemId);
    const evidenceRefs = [...(occurrence.evidenceIds ?? [])];
    const targetEvidence = evidenceRefs.map(id => evidenceById.get(id)).find(artifact =>
      occurrence.nodeId && artifact?.nodeId === occurrence.nodeId)
      ?? evidenceRefs.map(id => evidenceById.get(id)).find(Boolean);
    const ruleId = occurrence.ruleId ?? `manual:${occurrence.itemId ?? occurrence.occurrenceId}`;
    const source = occurrence.source ?? {
      engine: occurrence.ruleId === null
        ? V1_MIGRATION_DEFAULTS.manualSourceEngine
        : V1_MIGRATION_DEFAULTS.sourceEngine,
      ruleId,
      version: sourceVersion,
    };
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
    return {
      ...canonicalOccurrenceInput,
      outcome,
      pageId,
      classification: source.engine === 'axe-core' && CLASSIFICATIONS.includes(occurrence.classification)
        ? occurrence.classification
        : item?.classification ?? 'editorial',
      impact: IMPACT_LEVELS.includes(occurrence.impact) ? occurrence.impact : V1_MIGRATION_DEFAULTS.impact,
      confidence: CONFIDENCE_LEVELS.includes(occurrence.confidence) ? occurrence.confidence : V1_MIGRATION_DEFAULTS.confidence,
      source,
      ...(source.engine === 'axe-core' ? {
        selector: legacySelector,
        framePath: legacyFramePath,
      } : {}),
      nbrItemRef: item?.id ?? null,
      itemWcagRefs, sourceWcagRefs, testedWcagRefs,
      wcagRefs: [...testedWcagRefs],
      foreignBenchmarkRefs: [...section508ReferencesForWcag(testedWcagRefs)],
      ...(ruleId === 'new-window-link-warning' ? {
        reason: occurrence.reason ?? (outcome === 'failed'
          ? { code: 'missing-new-window-warning', context: { behavior: 'unknown', warning: 'absent' } }
          : { code: 'new-window-warning-observation-incomplete', context: { behavior: 'unknown', warning: 'unknown' } }),
      } : {}),
      target: {
        nodeId: occurrence.target?.nodeId ?? occurrence.nodeId ?? null,
        selector: occurrence.target?.selector ?? legacySelector ?? targetEvidence?.selector?.css ?? null,
        framePath: [...(occurrence.target?.framePath ?? legacyFramePath ?? targetEvidence?.selector?.framePath ?? [])],
      },
      accessiblePreview: occurrence.accessiblePreview ?? targetEvidence?.accessibility?.announcementPreview ?? null,
      evidenceRefs,
      legalAnalysis: legalBasis ? { basisRef: legalBasis.id } : null,
    };
  });
  const ruleCount = model.methodology?.ruleCount;
  return {
    ...model,
    schemaVersion: 2,
    requestedScope: { mode: 'single', urls: [requestedUrl] },
    pages: [{
      pageId,
      requestedUrl,
      finalUrl,
      status: model.session?.status,
      timestamps: { ...model.timestamps },
      viewport: { ...model.environment?.viewport },
    }],
    methodology: {
      ...model.methodology,
      coreRuleCount: EXPECTED_RULE_COUNT,
      supplementalRuleCount: Number.isSafeInteger(ruleCount)
        ? Math.max(0, ruleCount - EXPECTED_RULE_COUNT)
        : 0,
    },
    ruleResults,
    itemResults,
    occurrences,
    accessibilityWidgets: model.accessibilityWidgets ?? unknownAccessibilityWidgetInventory(),
    evidence,
    evidenceStateCount: Array.isArray(model.evidence) ? model.evidenceStateCount ?? 0 : model.evidence?.stateCount ?? 0,
    normative: migrateV1NormativeRecord(model.normative),
    integrity: model.integrity ?? { algorithm: 'unavailable', status: 'not-recorded-v1' },
  };
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
    ...normative,
    ...(normative.editorialNotes === undefined
      ? { editorialNotes: NBR17225_EDITORIAL_NOTES.map(note => ({ ...note })) }
      : {}),
    ...(normative.sources === undefined ? { sources: structuredClone(NORMATIVE_SOURCE_LEDGER) } : {}),
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

function assertAxeSupplementalIntegrity(model, rulesVersion, legacyNormativeIds = new Set()) {
  const reportRules = axeRulesFrom(model);
  const reportOccurrences = axeOccurrencesFrom(model);
  const batchChecked = model.requestedScope?.mode === 'batch' && model.axePages !== undefined
    ? validateBatchAxePages(model, rulesVersion, legacyNormativeIds)
    : undefined;
  if (reportRules.length === 0 && reportOccurrences.length === 0 && model.axe === undefined) {
    if (batchChecked === undefined || (batchChecked.occurrences.length === 0 && batchChecked.status !== 'partial')) return null;
  }
  const checked = batchChecked ?? validateNormalizedAxeSupplemental(model.axe, { rulesVersion, legacyNormativeIds });
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

function validateBatchAxePages(model, rulesVersion, legacyNormativeIds) {
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
    const checked = validateNormalizedAxeSupplemental(entry.result, { rulesVersion, batch: true, legacyNormativeIds });
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

function validateAxeItemAggregation(model, checked, reviewGraph) {
  if (!checked) return;
  const coreRules = (model.ruleResults ?? []).filter(rule => rule?.source?.engine !== 'axe-core');
  const aggregate = new Map(aggregateItems(coreRules, NBR17225_ITEMS).map(item => [item.id, item.outcome]));
  for (const occurrence of checked.occurrences) {
    if (!occurrence.nbrItemRef) continue;
    const previous = aggregate.get(occurrence.nbrItemRef);
    if (occurrence.outcome === 'failed' || (occurrence.outcome === 'cantTell' && previous !== 'failed')) {
      aggregate.set(occurrence.nbrItemRef, occurrence.outcome);
    }
  }
  for (const item of model.itemResults ?? []) {
    const expected = aggregate.get(item.id);
    if (!expected) continue;
    if (item.reviewedOutcome === undefined) {
      if (item.outcome === expected) continue;
      throw new TypeError(`Resultado do item ${item.id} diverge das fontes autoritativas aceitas.`);
    }
    const queue = [...reviewGraph.queueByOccurrence.entries()].filter(([, entry]) => entry.itemId === item.id);
    const decisions = queue.map(([occurrenceId]) => reviewGraph.decisionByOccurrence.get(occurrenceId)).filter(Boolean);
    let reviewedExpected = 'cantTell';
    if (expected === 'failed' || decisions.some(decision => decision.answer === 'não conforme')) reviewedExpected = 'failed';
    else if (queue.length > 0 && decisions.length === queue.length && decisions.every(decision => decision.answer === 'conforme')) reviewedExpected = 'passed';
    if (item.originalOutcome !== expected || item.reviewedOutcome !== reviewedExpected || item.outcome !== reviewedExpected) {
      throw new TypeError(`Revisão do item ${item.id} diverge das fontes e decisões validadas.`);
    }
  }
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

function projectPrimaryPageCompatibility(model) {
  const primary = model.pages[0];
  model.requestedUrl = primary.requestedUrl;
  model.finalUrl = primary.finalUrl;
  model.timestamps = { ...primary.timestamps };
  model.environment = {
    ...(model.environment ?? {}),
    viewport: { ...primary.viewport },
  };
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
  return sanitized;
}

function validateRequestedScope(scope) {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope) ||
    !['single', 'batch'].includes(scope.mode) || !Array.isArray(scope.urls) || !scope.urls.length) {
    throw new TypeError('requestedScope inválido.');
  }
  const seen = new Set();
  scope.urls = scope.urls.map((url, index) => {
    const normalized = reportUrl(url, `requestedScope.urls[${index}]`);
    if (seen.has(normalized)) throw new TypeError('requestedScope contém URL duplicada.');
    seen.add(normalized);
    return normalized;
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
    page.requestedUrl = reportUrl(page.requestedUrl, `pages[${index}].requestedUrl`);
    page.finalUrl = reportUrl(page.finalUrl, `pages[${index}].finalUrl`);
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
  canonicalText(integrity.canonicalModelHash, 'integrity.canonicalModelHash');
  canonicalText(integrity.evidenceManifestHash, 'integrity.evidenceManifestHash');
  if (integrity.hashBase !== undefined) canonicalText(integrity.hashBase, 'integrity.hashBase');
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
  for (const expected of NBR17225_ITEMS) {
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
  return NBR17225_ITEMS.map(expected => byId.get(expected.id));
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

function projectOccurrenceCompatibility(occurrences, ruleById) {
  if (!Array.isArray(occurrences)) return;
  for (const occurrence of occurrences) {
    if (!occurrence || typeof occurrence !== 'object' || Array.isArray(occurrence)) continue;
    if (occurrence.itemId === undefined) occurrence.itemId = occurrence.nbrItemRef;
    if (occurrence.ruleId === undefined) {
      occurrence.ruleId = occurrence.source?.engine === V1_MIGRATION_DEFAULTS.manualSourceEngine
        ? null
        : occurrence.source?.ruleId;
    }
    if (occurrence.mode === undefined) {
      occurrence.mode = ruleById.get(occurrence.source?.ruleId)?.mode
        ?? (occurrence.source?.engine === V1_MIGRATION_DEFAULTS.manualSourceEngine ? 'manual' : undefined);
    }
    if (occurrence.nodeId === undefined) occurrence.nodeId = occurrence.target?.nodeId;
    if (occurrence.evidenceIds === undefined && Array.isArray(occurrence.evidenceRefs)) {
      occurrence.evidenceIds = [...occurrence.evidenceRefs];
    }
  }
}

function validateEvidenceAndOccurrences(model, ruleById, pageById, legacyNormativeIds = new Set(), scopeMode = 'single') {
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
    validateWcagAndForeignReferences(occurrence, item, sourceRule, label, legacyNormativeIds, scopeMode);
    validateTarget(occurrence.target, label);
    if (occurrence.nodeId !== occurrence.target.nodeId) {
      throw new TypeError(`${label} possui identidade de alvo incoerente.`);
    }
    if (occurrence.accessiblePreview !== null && typeof occurrence.accessiblePreview !== 'string') {
      throw new TypeError(`${label}.accessiblePreview inválida.`);
    }
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
    if (occurrence.source?.engine !== 'audita-core' || !['failed', 'cantTell'].includes(occurrence.outcome)) continue;
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

function validatePassedItemAuthority(items, ruleById, reviewGraph) {
  for (const item of items) {
    if (item.outcome !== 'passed') continue;
    const reviewedPass = item.reviewedOutcome === 'passed' && hasValidatedConformityReview(item, reviewGraph);
    if (item.reviewedOutcome === 'passed' && !reviewedPass) {
      throw new TypeError(`Item ABNT ${item.id} não pode ser aprovado por revisão sem decisões conformes válidas do mesmo item.`);
    }
    const authoritativePass = item.ruleIds.some(ruleId => {
      const rule = ruleById.get(ruleId);
      return rule?.outcome === 'passed' && rule.nbrItems.includes(item.id);
    });
    if (!reviewedPass && !authoritativePass) {
      throw new TypeError(`Item ABNT ${item.id} não pode ser aprovado sem resultado autoritativo ou revisão humana.`);
    }
  }
}

function hasValidatedConformityReview(item, { decisionByOccurrence, queueByOccurrence }) {
  if (!Array.isArray(item.review?.decisionIds) || item.review.decisionIds.length === 0) return false;
  const declaredIds = new Set(item.review.decisionIds);
  if (declaredIds.size !== item.review.decisionIds.length) return false;
  const actualIds = new Set();
  for (const [occurrenceId, entry] of queueByOccurrence) {
    if (entry.itemId !== item.id) continue;
    const decision = decisionByOccurrence.get(occurrenceId);
    if (!decision || decision.itemId !== item.id || decision.answer !== 'conforme') return false;
    actualIds.add(decision.decisionId);
  }
  return actualIds.size > 0 && actualIds.size === declaredIds.size &&
    [...actualIds].every(decisionId => declaredIds.has(decisionId));
}

function hasCorePassProvenance(source, ruleId, rulesVersion) {
  return source?.engine === V1_MIGRATION_DEFAULTS.sourceEngine &&
    source.ruleId === ruleId && source.version === rulesVersion;
}

function validateSource(source, label) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new TypeError(`${label} inválida.`);
  for (const field of ['engine', 'ruleId', 'version']) canonicalText(source[field], `${label}.${field}`);
}

function validateWcagAndForeignReferences(occurrence, item, sourceRule, occurrenceLabel, legacyNormativeIds, scopeMode) {
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
    const legacy = legacyNormativeIds.has(occurrence.occurrenceId);
    authoritativeSourceWcag = legacy || occurrence.source.ruleId === 'new-window-link-warning'
      ? []
      : [...new Set((sourceRule?.wcag ?? []).filter(reference => expectedItemWcag.includes(reference)))];
    authoritativeTestedWcag = !legacy && occurrence.source.ruleId !== 'new-window-link-warning' && occurrence.outcome === 'failed'
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
