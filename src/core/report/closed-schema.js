import { NBR17225_EDITORIAL_NOTES } from '../normative/nbr17225.js';
import { NORMATIVE_SOURCE_LEDGER } from '../normative/source-ledger.js';
import { canonicalStringify } from './canonical-json.js';

const ROOT_KEYS = new Set([
  'accessibilityWidgets', 'auditId', 'axe', 'axePages', 'environment', 'evidence',
  'evidenceStateCount', 'finalUrl', 'integrity', 'itemResults', 'limitations',
  'manualReview', 'methodology', 'normative', 'occurrences', 'pages', 'presentation',
  'progress', 'report', 'reproducibility', 'requestedScope', 'requestedUrl',
  'reviewDecisions', 'ruleResults', 'schemaVersion', 'scope', 'session', 'snapshot',
  'timestamps', 'timezone', 'versions',
]);

const BASE_OCCURRENCE_KEYS = [
  'accessiblePreview', 'classification', 'confidence', 'evidenceIds', 'evidenceRefs',
  'foreignBenchmarkRefs', 'impact', 'itemId', 'itemWcagRefs', 'justification',
  'legalAnalysis', 'mode', 'nbrItemRef', 'nodeId', 'occurrenceId', 'outcome',
  'pageId', 'ruleId', 'source', 'sourceWcagRefs', 'target', 'testedWcagRefs',
  'wcagRefs',
];
const CORE_OCCURRENCE_KEYS = new Set([
  ...BASE_OCCURRENCE_KEYS, 'equivalenceKey', 'presentationTargetKey', 'reason',
]);
const MANUAL_OCCURRENCE_KEYS = new Set([
  ...BASE_OCCURRENCE_KEYS, 'equivalenceKey', 'presentationTargetKey',
]);
const EDITORIAL_OCCURRENCE_KEYS = new Set(BASE_OCCURRENCE_KEYS);
const V1_CORE_OR_MANUAL_OCCURRENCE_KEYS = new Set([
  ...CORE_OCCURRENCE_KEYS, 'framePath', 'selector',
]);
const AXE_OCCURRENCE_KEYS = new Set([
  ...BASE_OCCURRENCE_KEYS, 'applicabilityEvidence', 'engineResultType', 'engineRuleId',
  'equivalenceKey', 'framePath', 'presentationTargetKey', 'selector',
]);
const SOURCE_KEYS = new Set(['engine', 'ruleId', 'version']);
const TARGET_KEYS = new Set(['framePath', 'nodeId', 'selector']);
const REASON_KEYS = new Set(['code', 'context']);
const REASON_CONTEXT_KEYS = new Set(['behavior', 'warning']);
const LEGAL_ANALYSIS_KEYS = new Set(['basisRef']);
const NORMATIVE_KEYS = new Set(['edition', 'editorialNotes', 'sources', 'wcag']);

function hasOnlyKeys(value, allowed) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).every(key => allowed.has(key));
}

function occurrenceCollections(model) {
  const collections = [];
  if (Array.isArray(model?.occurrences)) collections.push(model.occurrences);
  if (Array.isArray(model?.axe?.occurrences)) collections.push(model.axe.occurrences);
  if (Array.isArray(model?.axePages)) {
    for (const page of model.axePages) if (Array.isArray(page?.result?.occurrences)) collections.push(page.result.occurrences);
  }
  return collections;
}

function allowedOccurrenceKeys(occurrence, schemaVersion) {
  const engine = occurrence?.source?.engine;
  if (engine === 'axe-core') return AXE_OCCURRENCE_KEYS;
  if (engine === 'audita-editorial') return EDITORIAL_OCCURRENCE_KEYS;
  if (schemaVersion === 1) return V1_CORE_OR_MANUAL_OCCURRENCE_KEYS;
  if (engine === 'audita-manual-review' || occurrence?.ruleId === null) return MANUAL_OCCURRENCE_KEYS;
  return CORE_OCCURRENCE_KEYS;
}

function assertClosedOccurrence(occurrence, schemaVersion) {
  if (!hasOnlyKeys(occurrence, allowedOccurrenceKeys(occurrence, schemaVersion))) {
    throw new TypeError(occurrence?.source?.engine === 'axe-core'
      ? 'Ocorrência axe contém campo não reconhecido.'
      : 'Ocorrência contém campo não reconhecido.');
  }
  const engine = occurrence?.source?.engine;
  if (engine === 'axe-core') return;
  if (occurrence.source !== undefined && !hasOnlyKeys(occurrence.source, SOURCE_KEYS)) {
    throw new TypeError('Fonte de ocorrência contém campo não reconhecido.');
  }
  if (occurrence.target !== undefined && !hasOnlyKeys(occurrence.target, TARGET_KEYS)) {
    throw new TypeError('Alvo de ocorrência contém campo não reconhecido.');
  }
  if (occurrence.reason !== undefined && (!hasOnlyKeys(occurrence.reason, REASON_KEYS) ||
    !hasOnlyKeys(occurrence.reason.context, REASON_CONTEXT_KEYS))) {
    throw new TypeError('Razão de ocorrência contém campo não reconhecido.');
  }
  if (occurrence.legalAnalysis !== undefined && occurrence.legalAnalysis !== null &&
    !hasOnlyKeys(occurrence.legalAnalysis, LEGAL_ANALYSIS_KEYS)) {
    throw new TypeError('Análise jurídica de ocorrência contém campo não reconhecido.');
  }
}

function assertClosedNormative(normative) {
  if (normative === undefined) return;
  if (!hasOnlyKeys(normative, NORMATIVE_KEYS)) {
    throw new TypeError('Registro normativo contém campo não reconhecido.');
  }
  if (normative.edition !== undefined && normative.edition !== 'ABNT NBR 17225:2025') {
    throw new TypeError('Registro normativo contém edição não reconhecida.');
  }
  if (normative.wcag !== undefined && normative.wcag !== 'WCAG 2.2') {
    throw new TypeError('Registro normativo contém versão WCAG não reconhecida.');
  }
  if (normative.editorialNotes !== undefined &&
    canonicalStringify(normative.editorialNotes) !== canonicalStringify(NBR17225_EDITORIAL_NOTES)) {
    throw new TypeError('Registro normativo contém notas não reconhecidas.');
  }
  if (normative.sources !== undefined &&
    canonicalStringify(normative.sources) !== canonicalStringify(NORMATIVE_SOURCE_LEDGER)) {
    throw new TypeError('Registro normativo contém fontes não reconhecidas.');
  }
}

/** Rejects unknown report data before any spread, migration, enrichment or hash issuance. */
export function assertClosedAuditShape(model) {
  if (!hasOnlyKeys(model, ROOT_KEYS)) throw new TypeError('Modelo contém campo não reconhecido.');
  for (const collection of occurrenceCollections(model)) {
    for (const occurrence of collection) assertClosedOccurrence(occurrence, model.schemaVersion);
  }
  assertClosedNormative(model.normative);
}
