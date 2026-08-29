import { unknownAccessibilityWidgetInventory } from '../detection/accessibility-widgets.js';
import { sanitizeResourceUrl } from '../normalize-snapshot.js';
import { NBR17225_EDITORIAL_NOTES, NBR17225_ITEMS } from '../normative/nbr17225.js';
import { NORMATIVE_SOURCE_LEDGER } from '../normative/source-ledger.js';
import { aggregateItems } from '../rules/aggregate-items.js';
import { canonicalStringify } from '../report/canonical-json.js';
import { REPORT_HASH_BASE } from '../report/integrity-chain.js';

const OUTCOME_PRIORITY = Object.freeze({ failed: 5, cantTell: 4, untested: 3, passed: 2, inapplicable: 1 });
const IMPACT_PRIORITY = Object.freeze({ critical: 4, serious: 3, moderate: 2, minor: 1 });

export function createBatchReportTemplate({ timezone, manifestVersion, rulesVersion, browserVersion }) {
  if (typeof timezone !== 'string' || !timezone || typeof manifestVersion !== 'string' || !manifestVersion ||
    rulesVersion !== '1.0.0' || typeof browserVersion !== 'string' || !browserVersion) {
    throw new TypeError('Template explícito de relatório do lote inválido.');
  }
  return deepFreeze({
    timezone,
    versions: { extension: manifestVersion, rules: rulesVersion, browser: browserVersion },
    methodology: {
      name: 'Audita Acessibilidade — ABNT NBR 17225 e WCAG 2.2',
      version: rulesVersion, ruleCount: 130, coreRuleCount: 130,
      supplementalRuleCount: 0, itemCount: 146,
    },
    environment: {
      chromeVersion: browserVersion,
      viewport: { width: null, height: null, deviceScaleFactor: null },
    },
    normative: {
      edition: 'ABNT NBR 17225:2025', wcag: 'WCAG 2.2',
      editorialNotes: NBR17225_EDITORIAL_NOTES.map(note => ({ ...note })),
      sources: structuredClone(NORMATIVE_SOURCE_LEDGER),
    },
  });
}

export function createBatchFailurePage({
  pageId, requestedUrl, status, attempted, startedAt, endedAt, code, message,
}) {
  if (!['failed', 'cancelled'].includes(status) || typeof attempted !== 'boolean') {
    throw new TypeError('Estado de página sem resultado inválido.');
  }
  const reportUrl = sanitizeResourceUrl(requestedUrl);
  if (!/^https?:\/\//u.test(reportUrl)) throw new TypeError('Identidade segura da página inválida.');
  const diagnostic = { code, message, at: endedAt, recoverable: false };
  return deepFreeze({
    page: {
      pageId, requestedUrl: reportUrl, finalUrl: reportUrl, finalUrlObserved: false,
      attempted, status, timestamps: { startedAt, endedAt, generatedAt: endedAt },
      viewport: { width: null, height: null, deviceScaleFactor: null },
      diagnostics: [diagnostic], limitations: [message], coverage: {},
      accessibilityWidgets: unknownAccessibilityWidgetInventory(), axeStatus: 'not-run',
    },
    ruleResults: [], itemResults: [], occurrences: [], evidence: [], manualReview: [],
    reviewDecisions: [], axe: null, template: null,
  });
}

export function aggregateBatchAudits({
  batchAuditId, pageResults, startedAt, endedAt, status, progress = [], diagnostics = [], template: explicitTemplate,
}) {
  if (!Array.isArray(pageResults) || pageResults.length < 1 || pageResults.length > 20 ||
    !['complete', 'partial', 'failed', 'cancelled'].includes(status)) {
    throw new TypeError('Resultados do lote inválidos.');
  }
  const template = pageResults.find(result => result.template)?.template ?? explicitTemplate;
  if (!template) throw new TypeError('Lote sem página auditada exige template explícito do relatório.');
  const expectedNormative = {
    edition: 'ABNT NBR 17225:2025', wcag: 'WCAG 2.2',
    editorialNotes: NBR17225_EDITORIAL_NOTES.map(note => ({ ...note })),
    sources: structuredClone(NORMATIVE_SOURCE_LEDGER),
  };
  if (template.normative === undefined ||
    canonicalStringify(template.normative) !== canonicalStringify(expectedNormative)) {
    throw new TypeError('Template do lote não contém o ledger normativo exato.');
  }
  const pages = pageResults.map(result => {
    const page = structuredClone(result.page);
    if (!Object.hasOwn(page.timestamps, 'generatedAt')) page.timestamps.generatedAt = endedAt;
    return page;
  });
  assertPageOrderAndIdentity(pages);
  const derivedStatus = deriveBatchStatus(pages);
  if (status !== derivedStatus) throw new TypeError(`Status da sessão diverge das páginas do lote: esperado ${derivedStatus}.`);
  const hasCoverageBlocker = pages.some(page => ['failed', 'cancelled'].includes(page.status));
  const ruleResults = aggregateRules(pageResults.flatMap(result => result.ruleResults), hasCoverageBlocker, pages.length);
  const occurrences = pageResults.flatMap(result => result.occurrences.map(value => structuredClone(value)));
  const evidence = pageResults.flatMap(result => result.evidence.map(value => structuredClone(value)));
  const manualReview = pageResults.flatMap(result => result.manualReview.map(value => structuredClone(value)));
  const reviewDecisions = pageResults.flatMap(result => result.reviewDecisions.map(value => structuredClone(value)));
  assertGlobalGraph(pages, occurrences, evidence);
  const coreRules = ruleResults.filter(rule => rule.source?.engine !== 'axe-core');
  const aggregatedItems = new Map(aggregateItems(coreRules, NBR17225_ITEMS).map(item => [item.id, item]));
  const itemResults = NBR17225_ITEMS.map(item => ({
    ...structuredClone(item),
    outcome: aggregatedItems.get(item.id)?.outcome ?? 'cantTell',
    ruleResults: (aggregatedItems.get(item.id)?.ruleResults ?? []).map(rule => rule.ruleId),
  }));
  applyAxeItemOutcomes(itemResults, occurrences);
  const supplementalRuleCount = ruleResults.filter(rule => rule.source?.engine !== 'audita-core').length;
  const primary = pages[0];
  const pageDiagnostics = pages.flatMap(page => page.diagnostics ?? []);
  const limitations = [...new Set(pages.flatMap(page => page.limitations ?? []))];
  const capturedStateCount = evidence.filter(artifact => artifact.kind === 'full-page' && artifact.state === 'pristine').length;
  return {
    schemaVersion: 2,
    auditId: batchAuditId,
    requestedScope: { mode: 'batch', urls: pages.map(page => page.requestedUrl) },
    pages,
    requestedUrl: primary.requestedUrl,
    finalUrl: primary.finalUrl,
    timestamps: { startedAt, endedAt, generatedAt: endedAt },
    timezone: template.timezone,
    versions: structuredClone(template.versions),
    environment: { ...structuredClone(template.environment), viewport: structuredClone(primary.viewport) },
    scope: {
      kind: 'explicit-url-batch',
      description: `${pages.length} páginas correspondentes à lista explícita de ${pages.length} URLs; páginas e estados não solicitados não foram inferidos.`,
    },
    methodology: {
      ...structuredClone(template.methodology),
      coreRuleCount: 130,
      supplementalRuleCount,
      ruleCount: 130 + supplementalRuleCount,
      itemCount: 146,
    },
    session: { status, diagnostics: [...diagnostics.map(value => structuredClone(value)), ...pageDiagnostics.map(value => structuredClone(value))], partial: status === 'partial' },
    ruleResults,
    itemResults,
    occurrences,
    evidence,
    evidenceStateCount: capturedStateCount,
    manualReview,
    reviewDecisions,
    axePages: pageResults.filter(result => result.axe).map(result => ({
      pageId: result.page.pageId, result: structuredClone(result.axe),
    })),
    accessibilityWidgets: structuredClone(primary.accessibilityWidgets),
    limitations,
    report: { status: 'pending', reviewUrl: null, artifact: { status: 'pending', formats: [] } },
    reproducibility: {
      methodologyVersion: template.versions.rules,
      snapshotHash: 'not-retained-batch',
      ruleResultsHash: 'pending',
      evidenceHash: 'pending',
      capturedStateCount,
    },
    normative: structuredClone(template.normative),
    integrity: { algorithm: 'SHA-256', evidenceManifestHash: 'pending', canonicalModelHash: 'pending', hashBase: REPORT_HASH_BASE },
  };
}

function aggregateRules(rules, hasCoverageBlocker, totalPages) {
  const grouped = new Map();
  for (const rule of rules) {
    const group = grouped.get(rule.ruleId) ?? [];
    group.push(rule);
    grouped.set(rule.ruleId, group);
  }
  const output = [];
  for (const group of grouped.values()) {
    const strongest = group.reduce((best, rule) => OUTCOME_PRIORITY[rule.outcome] > OUTCOME_PRIORITY[best.outcome] ? rule : best);
    let outcome = strongest.outcome;
    if (hasCoverageBlocker && outcome !== 'failed') outcome = 'cantTell';
    const result = {
      ...structuredClone(strongest),
      outcome,
      summary: aggregateSummary(outcome, group.length, totalPages),
      targets: group.flatMap(rule => structuredClone(rule.targets ?? [])),
      limitations: uniqueValues(group.flatMap(rule => rule.limitations ?? [])),
    };
    if (result.source?.engine === 'axe-core') {
      result.impact = group.reduce((best, rule) => IMPACT_PRIORITY[rule.impact] > IMPACT_PRIORITY[best] ? rule.impact : best, 'minor');
      result.confidence = outcome === 'failed' ? 'high' : 'low';
    }
    if (result.source?.engine === 'audita-editorial') normalizeEditorialRule(result);
    output.push(result);
  }
  return output;
}

function aggregateSummary(outcome, count, totalPages) {
  const labels = {
    failed: 'falha confirmada', cantTell: 'não foi possível concluir', untested: 'não testado',
    passed: 'verificação aprovada', inapplicable: 'não aplicável',
  };
  return `Resultado agregado de ${count} de ${totalPages} ${totalPages === 1 ? 'página' : 'páginas'}: ${labels[outcome]}.`;
}

function deriveBatchStatus(pages) {
  const statuses = pages.map(page => page.status);
  if (statuses.some(value => value === 'cancelled')) return 'cancelled';
  if (statuses.every(value => value === 'complete')) return 'complete';
  if (statuses.every(value => value === 'failed')) return 'failed';
  return 'partial';
}

function normalizeEditorialRule(rule) {
  rule.targets = rule.targets.slice(0, 64);
  rule.outcome = rule.targets.length > 0 ? 'failed' : rule.outcome === 'cantTell' ? 'cantTell' : 'inapplicable';
  rule.summary = rule.outcome === 'failed'
    ? 'Há conteúdo provisório inequívoco na página.'
    : rule.outcome === 'cantTell'
      ? 'A verificação editorial ficou incompleta devido ao limite de varredura.'
      : 'Não foi observado conteúdo provisório inequívoco.';
  const limitations = [];
  if (rule.limitations.some(value => value?.code === 'EDITORIAL_NODE_SCAN_TRUNCATED')) {
    limitations.push({ code: 'EDITORIAL_NODE_SCAN_TRUNCATED', retainedNodeCount: 5_000 });
  }
  if (rule.outcome === 'cantTell' && limitations.length === 0) {
    limitations.push({ code: 'BATCH_PAGE_COVERAGE_INCOMPLETE' });
  }
  if (rule.targets.length === 64) limitations.push({ code: 'EDITORIAL_RESULT_LIMIT_REACHED', retainedResultCount: 64 });
  rule.limitations = limitations;
}

function applyAxeItemOutcomes(items, occurrences) {
  const byId = new Map(items.map(item => [item.id, item]));
  for (const occurrence of occurrences) {
    if (occurrence.source?.engine !== 'axe-core' || !occurrence.nbrItemRef) continue;
    const item = byId.get(occurrence.nbrItemRef);
    if (item && OUTCOME_PRIORITY[occurrence.outcome] > OUTCOME_PRIORITY[item.outcome]) item.outcome = occurrence.outcome;
  }
}

function assertPageOrderAndIdentity(pages) {
  const ids = new Set();
  const urls = new Set();
  for (const [index, page] of pages.entries()) {
    if (page.pageId !== `page-${index + 1}` || ids.has(page.pageId) || urls.has(page.requestedUrl)) {
      throw new TypeError('Páginas do lote não preservam ordem ou identidade única.');
    }
    ids.add(page.pageId);
    urls.add(page.requestedUrl);
  }
}

function assertGlobalGraph(pages, occurrences, evidence) {
  const pageIds = new Set(pages.map(page => page.pageId));
  const occurrenceIds = new Set();
  const artifactById = new Map();
  for (const artifact of evidence) {
    if (artifactById.has(artifact.evidenceId) || !pageIds.has(artifact.pageId)) throw new TypeError('Grafo global contém evidência duplicada ou página desconhecida.');
    artifactById.set(artifact.evidenceId, artifact);
  }
  for (const occurrence of occurrences) {
    if (occurrenceIds.has(occurrence.occurrenceId) || !pageIds.has(occurrence.pageId)) throw new TypeError('Grafo global contém ocorrência duplicada ou página desconhecida.');
    occurrenceIds.add(occurrence.occurrenceId);
    for (const evidenceId of occurrence.evidenceRefs) {
      if (artifactById.get(evidenceId)?.pageId !== occurrence.pageId) throw new TypeError('Ocorrência global cruza evidências de páginas distintas.');
    }
  }
}

function uniqueValues(values) {
  const seen = new Set();
  const output = [];
  for (const value of values) {
    const key = canonicalStringify(value);
    if (!seen.has(key)) { seen.add(key); output.push(structuredClone(value)); }
  }
  return output;
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value) || Object.isFrozen(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}
