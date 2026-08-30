import { captureElement, captureFullPage } from '../browser/capture-evidence.js';
import { collectPage } from '../browser/collect-page.js';
import { AXE_PROVENANCE, runAxeInTab } from '../browser/axe-adapter.js';
import { dedupeFindingsForPresentation } from '../core/axe/dedupe-findings.js';
import { normalizeAxeResults } from '../core/axe/normalize-axe-results.js';
import {
  NBR17225_ITEMS,
  buildSnapshotIndexes,
  buildStableSelector,
  hashEvidenceArtifact,
  mergeProbesIntoSnapshot,
  mergeAxeSupplementalResults,
  normalizeProbes,
  normalizeSnapshot,
  projectElementAccessibility,
  detectAccessibilityWidgets,
  runCoreAudit,
  runEditorialRules,
  sanitizeHtmlSnippetSource,
  sanitizeResourceUrl,
} from '../core/index.js';
import { canonicalStringify } from '../core/report/canonical-json.js';
import { sha256Hex } from '../core/report/hash.js';
import { canonicalInternalReviewUrl } from '../core/report/report-policy.js';
import { normalizeAuditUrl } from '../core/url.js';
import { axeEquivalenceForAuditaRule } from '../core/normative/axe-nbr-crosswalk.js';
import { runDynamicProbes } from '../collector/dynamic-probes.js';
import { section508ReferencesForWcag } from '../core/normative/section508.js';
import { AUDIT_EXECUTION_INTERNAL } from './chrome-adapter.js';
import { projectAuditResourceOrigin } from '../core/privacy.js';
import { createOwnedTabRegistry } from './owned-tabs.js';
import { createRawNavigationVaultV1 } from './raw-navigation-vault.js';
import { runObservedTabAudit } from './observed-tab-runner.js';
import { executeObservedAuditPipeline } from './audit-pipeline.js';
import { createPageCheckpointRecorder } from './execution-checkpoint.js';
import { createInstalledCoreRuleInventory } from '../core/rules/core-rule-inventory.js';
import { createCapturePolicyV1, isCapturePolicyV1 } from '../core/privacy/capture-policy.js';
import { enrichAuditForReport } from '../core/report/enrich-audit.js';
import { createAuditModel } from '../core/report/audit-model.js';
import { validateExecutionCheckpoint } from './execution-checkpoint.js';

const SCHEMA_VERSION = 1;
const METHODOLOGY = Object.freeze({ name: 'Audita Acessibilidade — ABNT NBR 17225 e WCAG 2.2', version: '1.0.0', ruleCount: 130, itemCount: 146 });
const ANNOTATION_MAP_DIAGNOSTIC_CODES = new Set([
  'ANNOTATION_MAP_MV3_E2E_UNAVAILABLE',
  'ANNOTATION_MAP_COMPOSITOR_UNAVAILABLE',
  'ANNOTATION_MAP_SOURCE_INVALID',
  'ANNOTATION_MAP_SOURCE_HASH_MISMATCH',
  'ANNOTATION_MAP_SOURCE_LIMIT',
  'ANNOTATION_MAP_GEOMETRY_INVALID',
  'ANNOTATION_MAP_SEGMENT_LIMIT',
  'ANNOTATION_MAP_PRINT_SEGMENT_LIMIT',
  'ANNOTATION_MAP_LEGEND_PRINT_LIMIT',
  'ANNOTATION_MAP_LEGEND_WIDTH_LIMIT',
  'ANNOTATION_MAP_DERIVED_BYTES_LIMIT',
  'ANNOTATION_MAP_OUTPUT_INVALID',
  'ANNOTATION_MAP_TIMEOUT',
]);

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value) || Object.isFrozen(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

export function canonicalTime(value = new Date().toISOString()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError('O relógio da auditoria retornou uma data inválida.');
  return date.toISOString();
}

function stableHash(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (const character of text) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function safeUrl(value) {
  if (typeof value !== 'string') return '';
  return sanitizeResourceUrl(value);
}

function validateTransientReviewUrl(value, auditId, expectedExtensionId) {
  try { canonicalInternalReviewUrl(value ?? null, auditId, expectedExtensionId); } catch { /* capability descartada */ }
}

function diagnostic(code, message, at, recoverable = false, details = {}) {
  return {
    code, message, at, recoverable,
    ...(Object.keys(details).length > 0 ? { details: { ...details } } : {}),
  };
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  if (signal.reason?.name === 'AbortError') throw signal.reason;
  throw new DOMException('Operação cancelada.', 'AbortError');
}

function rethrowAbort(error, signal) {
  if (error?.name === 'AbortError' || signal?.aborted) {
    if (error?.name === 'AbortError') throw error;
    throwIfAborted(signal);
  }
}

function probesTimedOut(raw, normalized) {
  if (raw?.timedOut === true || raw?.incompleteReason === 'timeout') return true;
  return [...(Array.isArray(raw?.warnings) ? raw.warnings : []), ...(Array.isArray(normalized?.warnings) ? normalized.warnings : [])]
    .some(warning => typeof warning?.code === 'string' && /TIMEOUT/u.test(warning.code));
}

function fallbackItems() {
  return NBR17225_ITEMS.map(item => ({ ...item, wcag: item.wcag.map(reference => ({ ...reference })), outcome: 'cantTell', ruleResults: [] }));
}

function targetNodeId(target) {
  if (typeof target === 'string' || Number.isSafeInteger(target)) return String(target);
  if (target && (typeof target.nodeId === 'string' || Number.isSafeInteger(target.nodeId))) return String(target.nodeId);
  return null;
}

function normalizedText(value) {
  return typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '';
}

function nodeAttribute(node, name) {
  const value = node?.attributes?.[name];
  return typeof value === 'string' ? value : value === true ? '' : undefined;
}

function privateTextElement(node) {
  const tag = normalizedText(node?.tagName).toLowerCase();
  if (tag === 'textarea') return true;
  if (['input', 'select'].includes(tag)) return false;
  const contenteditable = normalizedText(nodeAttribute(node, 'contenteditable')).toLowerCase();
  return Object.hasOwn(node?.attributes || {}, 'contenteditable') && !['false', 'inherit'].includes(contenteditable);
}

function hasPrivateTextAncestor(node, indexes) {
  const visited = new Set();
  let current = node?.parentId ? indexes.byNodeId.get(node.parentId) : null;
  while (current && !visited.has(current.nodeId)) {
    visited.add(current.nodeId);
    if (privateTextElement(current)) return true;
    current = current.parentId ? indexes.byNodeId.get(current.parentId) : null;
  }
  return false;
}

function makeOccurrences(auditId, ruleResults, itemResults) {
  const itemById = new Map(NBR17225_ITEMS.map(item => [item.id, item]));
  const occurrences = [];
  const add = input => {
    const signature = [auditId, input.itemId, input.ruleId || 'manual', input.nodeId || 'document', occurrences.length].join('\u0000');
    occurrences.push({ occurrenceId: `occurrence-${stableHash(signature)}`, ...input });
  };
  for (const result of ruleResults) {
    if (!['failed', 'cantTell'].includes(result.outcome)) continue;
    const itemIds = Array.isArray(result.nbrItems) ? result.nbrItems : [];
    const targets = Array.isArray(result.targets) && result.targets.length ? result.targets : [null];
    for (const itemId of itemIds) for (const target of targets) {
      const nodeId = targetNodeId(target);
      const equivalence = axeEquivalenceForAuditaRule(result.ruleId);
      const itemWcagRefs = itemById.get(itemId)?.wcag.map(reference => reference.id) ?? [];
      const sourceWcagRefs = result.ruleId === 'new-window-link-warning'
        ? []
        : [...new Set((Array.isArray(result.wcag) ? result.wcag : [])
          .filter(reference => itemWcagRefs.includes(reference)))];
      const testedWcagRefs = result.outcome === 'failed' ? [...sourceWcagRefs] : [];
      add({
        itemId,
        nbrItemRef: itemId,
        ruleId: result.ruleId,
        outcome: result.outcome,
        mode: result.mode,
        nodeId: nodeId && nodeId !== 'document' ? nodeId : null,
        pageId: 'page-1',
        source: { engine: 'audita-core', ruleId: result.ruleId, version: METHODOLOGY.version },
        target: {
          nodeId: nodeId && nodeId !== 'document' ? nodeId : null,
          selector: null,
          framePath: [],
        },
        equivalenceKey: equivalence?.equivalenceKey ?? `audita:${result.ruleId}`,
        presentationTargetKey: equivalence?.targetScope === 'document'
          ? 'document'
          : nodeId && nodeId !== 'document' ? `node:${nodeId}` : null,
        evidenceIds: [],
        itemWcagRefs, sourceWcagRefs, testedWcagRefs,
        wcagRefs: [...testedWcagRefs],
        foreignBenchmarkRefs: [...section508ReferencesForWcag(testedWcagRefs)],
        ...(result.ruleId === 'new-window-link-warning' ? {
          reason: result.outcome === 'failed'
            ? { code: 'missing-new-window-warning', context: {
              behavior: ['target-blank', 'observed-new-window'].includes(target?.data?.behavior) ? target.data.behavior : 'unknown',
              warning: 'absent',
            } }
            : { code: 'new-window-warning-observation-incomplete', context: {
              behavior: ['target-blank', 'observed-new-window'].includes(target?.data?.behavior) ? target.data.behavior : 'unknown',
              warning: 'unknown',
            } },
        } : {}),
        justification: typeof target?.message === 'string' && target.message.trim() ? target.message.trim() : result.summary || 'A ocorrência exige verificação humana.',
      });
    }
  }
  for (const item of itemResults) {
    if (item.outcome !== 'cantTell' || !['manual', 'assisted'].includes(item.evaluation)) continue;
    if (occurrences.some(occurrence => occurrence.itemId === item.id)) continue;
    add({
      itemId: item.id, ruleId: null, outcome: 'cantTell', mode: item.evaluation,
      nodeId: null, evidenceIds: [],
      pageId: 'page-1', nbrItemRef: item.id,
      source: { engine: 'audita-manual-review', ruleId: `manual:${item.id}`, version: METHODOLOGY.version },
      target: { nodeId: null, selector: null, framePath: [] },
      equivalenceKey: `manual:${item.id}`, presentationTargetKey: null,
      itemWcagRefs: [], sourceWcagRefs: [], testedWcagRefs: [],
      wcagRefs: [], foreignBenchmarkRefs: [],
      justification: item.humanReason || 'O item depende de revisão humana no nível da página.',
    });
  }
  return occurrences;
}

function makeEditorialOccurrences(auditId, ruleResults) {
  const occurrences = [];
  for (const rule of ruleResults) {
    if (rule.ruleId !== 'editorial.placeholder-text' || rule.outcome !== 'failed') continue;
    for (const value of rule.targets.slice(0, 64)) {
      const nodeId = targetNodeId(value);
      const signature = [auditId, rule.ruleId, nodeId || 'document', occurrences.length].join('\u0000');
      occurrences.push({
        occurrenceId: `occurrence-${stableHash(signature)}`,
        itemId: null,
        nbrItemRef: null,
        ruleId: rule.ruleId,
        outcome: 'failed',
        mode: 'automated',
        classification: 'editorial',
        impact: 'minor',
        confidence: 'high',
        nodeId,
        pageId: 'page-1',
        source: { engine: 'audita-editorial', ruleId: rule.ruleId, version: METHODOLOGY.version },
        target: { nodeId, selector: null, framePath: [] },
        itemWcagRefs: [],
        sourceWcagRefs: [],
        testedWcagRefs: [],
        wcagRefs: [],
        foreignBenchmarkRefs: [],
        accessiblePreview: null,
        evidenceIds: [],
        legalAnalysis: null,
        justification: 'Há conteúdo provisório inequívoco na página.',
      });
    }
  }
  return occurrences;
}

function allocateOccurrenceIds(state) {
  state.occurrences = state.occurrences.map((occurrence, index) => {
    const occurrenceId = `occurrence-${occurrence.pageId}-${String(index + 1).padStart(6, '0')}`;
    return { ...occurrence, occurrenceId };
  });
  if (state.axe) {
    const axeIds = state.occurrences.filter(occurrence => occurrence.source?.engine === 'axe-core').map(occurrence => occurrence.occurrenceId);
    const axe = structuredClone(state.axe);
    axe.occurrences = axe.occurrences.map((occurrence, index) => ({ ...occurrence, occurrenceId: axeIds[index] }));
    state.axe = deepFreeze(axe);
  }
}

function resolvePresentationTargets(occurrences, artifacts) {
  const selectorToNodeIds = new Map();
  for (const artifact of artifacts) {
    const selector = artifact?.selector?.css;
    if (typeof selector !== 'string' || !selector || !artifact.nodeId) continue;
    const ids = selectorToNodeIds.get(selector) ?? [];
    ids.push(artifact.nodeId);
    selectorToNodeIds.set(selector, ids);
  }
  for (const occurrence of occurrences) {
    if (occurrence.classification === 'editorial') continue;
    if (occurrence.presentationTargetKey === 'document') continue;
    if (occurrence.nodeId) {
      occurrence.presentationTargetKey = `node:${occurrence.nodeId}`;
      continue;
    }
    if (occurrence.source?.engine === 'axe-core') continue;
    const selector = occurrence.target?.selector ?? occurrence.selector;
    const candidates = typeof selector === 'string' ? selectorToNodeIds.get(selector) : null;
    if (candidates?.length === 1) occurrence.presentationTargetKey = `node:${candidates[0]}`;
  }
}

function manualQueue(occurrences, itemResults) {
  const itemById = new Map(itemResults.map(item => [item.id, item]));
  return occurrences.filter(occurrence =>
    occurrence.itemId && occurrence.outcome === 'cantTell').map(occurrence => {
    const item = itemById.get(occurrence.itemId);
    return {
      occurrenceId: occurrence.occurrenceId,
      itemId: occurrence.itemId,
      ruleId: occurrence.ruleId,
      mode: occurrence.mode === 'manual' ? 'manual' : 'assisted',
      status: 'unanswered',
      question: `O requisito “${item?.title || occurrence.itemId}” está conforme no contexto apresentado?`,
      reason: occurrence.justification,
    };
  });
}

async function draftModel(state) {
  const snapshotHash = await sha256Hex(canonicalStringify(state.snapshot || null));
  const ruleResultsHash = await sha256Hex(canonicalStringify(state.ruleResults));
  const evidenceHash = await sha256Hex(canonicalStringify(state.artifacts.map(artifact => ({
    evidenceId: artifact.evidenceId, kind: artifact.kind, nodeId: artifact.nodeId || null, hash: artifact.hash,
  }))));
  const model = {
    schemaVersion: SCHEMA_VERSION,
    auditId: state.auditId,
    requestedUrl: state.requestedUrl,
    finalUrl: state.finalUrl || state.requestedUrl,
    attempted: state.attempted,
    finalUrlObserved: state.finalUrlObserved,
    timestamps: { startedAt: state.startedAt, ...(state.endedAt ? { endedAt: state.endedAt } : {}) },
    environment: state.environment,
    methodology: {
      ...METHODOLOGY,
      ruleCount: state.ruleResults.length,
      coreRuleCount: state.coreRuleResults.length,
      supplementalRuleCount: Math.max(0, state.ruleResults.length - state.coreRuleResults.length),
    },
    session: { status: state.status, diagnostics: state.diagnostics, partial: state.status === 'partial' },
    snapshot: state.snapshot ? {
      schemaVersion: state.snapshot.schemaVersion,
      document: state.snapshot.document,
      nodes: state.snapshot.nodes,
      coverage: state.snapshot.document?.coverage || {},
      warnings: state.snapshot.document?.warnings || [],
    } : null,
    ruleResults: state.ruleResults,
    itemResults: state.itemResults,
    occurrences: state.occurrences,
    evidence: { stateCount: state.fullPage ? 1 : 0, artifacts: state.artifacts },
    manualReview: state.manualReview,
    reviewDecisions: [],
    ...(state.axe === undefined ? {} : { axe: state.axe }),
    accessibilityWidgets: state.accessibilityWidgets,
    limitations: state.limitations,
    presentation: state.presentation,
    progress: state.progress,
    report: state.report,
    reproducibility: {
      methodologyVersion: METHODOLOGY.version,
      snapshotHash,
      ruleResultsHash,
      evidenceHash,
      capturedStateCount: state.fullPage ? 1 : 0,
    },
  };
  return deepFreeze(structuredClone(model));
}

/** Runs one local audit in one disposable tab using only injected Chrome effects. */
async function runLegacyAudit({
  url, chromeAdapter, now = () => new Date().toISOString(), idFactory = () => crypto.randomUUID(), signal,
  closeAuditTab = true, expectedExtensionId, startedAt: suppliedStartedAt,
}) {
  if (!chromeAdapter || typeof chromeAdapter !== 'object') throw new TypeError('O adapter Chrome é obrigatório.');
  const navigationUrl = normalizeAuditUrl(url);
  const generatedId = idFactory('audit');
  const auditId = typeof generatedId === 'string' ? generatedId.trim() : '';
  if (!/^[A-Za-z0-9._:-]{1,160}$/u.test(auditId)) throw new TypeError('O identificador da auditoria é inválido.');
  const state = {
    auditId,
    requestedUrl: projectAuditResourceOrigin(navigationUrl),
    finalUrl: '',
    attempted: false,
    finalUrlObserved: false,
    startedAt: suppliedStartedAt === undefined ? canonicalTime(now()) : canonicalTime(suppliedStartedAt),
    endedAt: '',
    environment: { chromeVersion: '', viewport: { width: null, height: null, deviceScaleFactor: null } },
    status: 'running', diagnostics: [], progress: [], snapshot: null,
    ruleResults: [], coreRuleResults: [], itemResults: fallbackItems(), occurrences: [], manualReview: [],
    editorialRuleResults: [],
    axe: normalizeAxeResults({ status: 'disabled', provenance: AXE_PROVENANCE, frames: [], diagnostics: [{ code: 'AXE_FEATURE_DISABLED' }] }, { pageId: 'page-1' }),
    rawAxe: null, limitations: [], presentation: { groups: [], occurrenceCount: 0, hiddenOccurrenceCount: 0 },
    accessibilityWidgets: detectAccessibilityWidgets(null),
    artifacts: [], fullPage: null,
    report: { status: 'pending', reviewUrl: null, artifact: { status: 'pending', formats: [] } },
  };
  let tab = null;
  let cdp = null;
  let fatal = false;
  let recoverableFailure = false;

  const awaitStep = async operation => {
    throwIfAborted(signal);
    const value = await operation();
    throwIfAborted(signal);
    return value;
  };

  const progress = async (phase, message, percent) => {
    throwIfAborted(signal);
    const previous = state.progress.at(-1)?.percent ?? -1;
    const entry = { type: 'AUDIT_PROGRESS', sessionId: auditId, auditId, phase, message, percent: Math.max(previous, percent), at: canonicalTime(now()) };
    try { await chromeAdapter.emitProgress?.(entry); } catch { /* Progress transport must not abort the audit. */ }
    throwIfAborted(signal);
    state.progress.push(entry);
  };
  const recoverable = (code, message, details = {}) => {
    recoverableFailure = true;
    const signature = canonicalStringify({ code, message, details });
    if (!state.diagnostics.some(entry => canonicalStringify({
      code: entry.code, message: entry.message, details: entry.details ?? {},
    }) === signature)) {
      state.diagnostics.push(diagnostic(code, message, canonicalTime(now()), true, details));
    }
  };
  const appendDiagnosticOnce = (code, message, recoverableValue) => {
    if (!state.diagnostics.some(entry => entry.code === code && entry.message === message &&
      entry.recoverable === recoverableValue)) {
      state.diagnostics.push(diagnostic(code, message, canonicalTime(now()), recoverableValue));
    }
  };
  const settleFatalAxeObservation = () => {
    if (state.coreRuleResults.length > 0) return;
    if (state.diagnostics.some(entry => entry.code === 'COLLECTION_FAILED')) {
      state.axe = undefined;
      state.rawAxe = null;
      return;
    }
    if (['disabled', 'partial'].includes(state.rawAxe?.status)) {
      state.axe = normalizeAxeResults(state.rawAxe, {
        pageId: 'page-1', auditId, snapshot: state.snapshot,
        coreRuleResults: [], rulesVersion: METHODOLOGY.version,
      });
      if (state.axe.status === 'disabled') appendDiagnosticOnce(
        'AXE_FEATURE_DISABLED',
        'O motor suplementar axe-core permaneceu desativado pelo gate MV3/CSP; o motor próprio continuou normalmente.',
        true,
      );
      if (state.axe.status === 'partial') appendDiagnosticOnce(
        'AXE_EXECUTION_FAILED',
        'O motor suplementar axe-core teve cobertura parcial; o motor próprio continuou normalmente.',
        true,
      );
    } else {
      state.axe = undefined;
    }
    state.rawAxe = null;
  };
  const fail = (code, message, error) => {
    fatal = true;
    state.status = error?.name === 'AbortError' || signal?.aborted ? 'cancelled' : 'failed';
    state.diagnostics.push(diagnostic(code, message, canonicalTime(now()), false));
  };

  try {
    throwIfAborted(signal);
    await progress('opening', 'Abrindo o site', 5);
    const createdTab = await awaitStep(() => chromeAdapter.createTab({ url: 'about:blank', active: false }));
    if (!Number.isInteger(createdTab?.id)) throw new Error('Tab inválida');
    tab = createdTab;
    await awaitStep(() => {
      state.attempted = true;
      return chromeAdapter.navigateTab(tab.id, navigationUrl, { signal });
    });
    const navigation = await awaitStep(() => chromeAdapter.waitForStable(tab.id, { signal, timeoutMs: 30_000 }));
    const observedUrl = navigation?.url || await awaitStep(() => chromeAdapter.getFinalUrl?.(tab.id)) || navigationUrl;
    state.finalUrl = projectAuditResourceOrigin(observedUrl);
    state.finalUrlObserved = true;
    cdp = await awaitStep(() => chromeAdapter.connectCdp(tab.id, { signal }));
    if (!cdp || typeof cdp.command !== 'function') throw new Error('CDP inválido');

    let pristineMetrics = {};
    try {
      pristineMetrics = await awaitStep(() => cdp.command('Page.getLayoutMetrics', {}));
      if (chromeAdapter.captureFullPageEnabled === false) throw new Error('PIXEL_CAPTURE_OMITTED');
      state.fullPage = await awaitStep(() => (chromeAdapter.captureFullPage || captureFullPage)(cdp, pristineMetrics));
      const artifact = {
        evidenceId: state.fullPage.evidenceId,
        kind: 'full-page',
        state: 'pristine',
        dataUrl: state.fullPage.dataUrl,
        metadata: state.fullPage.metadata,
        hash: state.fullPage.hash,
      };
      state.artifacts.push(artifact);
    } catch (error) {
      rethrowAbort(error, signal);
      recoverable('FULL_PAGE_CAPTURE_FAILED', 'Não foi possível capturar a página completa no estado original.');
    }

    try {
      const axeRunner = typeof chromeAdapter.runAxeInTab === 'function'
        ? chromeAdapter.runAxeInTab.bind(chromeAdapter)
        : runAxeInTab;
      state.rawAxe = await awaitStep(() => axeRunner(tab.id));
    } catch (error) {
      rethrowAbort(error, signal);
      state.rawAxe = {
        status: 'partial', provenance: AXE_PROVENANCE, frames: [],
        diagnostics: [{ code: 'AXE_EXECUTION_FAILED', frameId: null }],
      };
    }

    try {
      const environment = await awaitStep(() => chromeAdapter.getEnvironment?.(tab.id, cdp, pristineMetrics));
      const viewport = environment?.viewport;
      if (!environment || typeof environment !== 'object' || typeof environment.chromeVersion !== 'string' ||
        !environment.chromeVersion.trim() || !viewport ||
        ![viewport.width, viewport.height, viewport.deviceScaleFactor].every(value => Number.isFinite(value) && value > 0)) {
        throw new TypeError('Ambiente incompleto.');
      }
      state.environment = {
        chromeVersion: environment.chromeVersion,
        viewport: {
          width: viewport.width,
          height: viewport.height,
          deviceScaleFactor: viewport.deviceScaleFactor,
        },
      };
    } catch (error) {
      rethrowAbort(error, signal);
      recoverable('ENVIRONMENT_UNAVAILABLE', 'Os metadados públicos do ambiente não puderam ser lidos.');
    }

    await progress('collecting', 'Lendo a estrutura', 25);
    let raw;
    try {
      raw = chromeAdapter.collectPage
        ? await awaitStep(() => chromeAdapter.collectPage(cdp, tab.id, { signal }))
        : await awaitStep(() => collectPage(cdp, tab.id, { executeScript: chromeAdapter.executeScript, signal }));
      state.snapshot = structuredClone(normalizeSnapshot(raw));
      state.snapshot.document.url = projectAuditResourceOrigin(state.snapshot.document.url);
      state.accessibilityWidgets = detectAccessibilityWidgets(state.snapshot.document?.accessibilityWidgetSignals);
    } catch (error) {
      rethrowAbort(error, signal);
      fail('COLLECTION_FAILED', 'A estrutura da página não pôde ser coletada com segurança.', error);
    }

    if (fatal) throw Object.assign(new Error('AUDIT_FATAL_HANDLED'), { auditHandled: true });

    try {
      const rawProbes = chromeAdapter.runDynamicProbes
        ? await awaitStep(() => chromeAdapter.runDynamicProbes(tab.id, cdp, { signal }))
        : await awaitStep(() => runDynamicProbes({ adapter: chromeAdapter.createProbeAdapter?.(tab.id, cdp), signal }));
      const normalizedProbes = normalizeProbes(rawProbes);
      if (probesTimedOut(rawProbes, normalizedProbes)) recoverable('DYNAMIC_PROBES_INCOMPLETE', 'As verificações dinâmicas atingiram o tempo limite.');
      state.snapshot = mergeProbesIntoSnapshot(state.snapshot, normalizedProbes);
      throwIfAborted(signal);
    } catch (error) {
      rethrowAbort(error, signal);
      recoverable('DYNAMIC_PROBES_FAILED', 'As verificações dinâmicas não puderam ser concluídas.');
    }

    await progress('testing', 'Verificando acessibilidade', 50);
    try {
      const core = await awaitStep(() => runCoreAudit(state.snapshot));
      state.coreRuleResults = [...core.ruleResults];
      state.axe = normalizeAxeResults(state.rawAxe, {
        pageId: 'page-1', auditId, snapshot: state.snapshot,
        coreRuleResults: state.coreRuleResults, rulesVersion: METHODOLOGY.version,
      });
      state.limitations.push(...state.axe.limitations);
      if (state.axe.status === 'disabled') {
        state.diagnostics.push(diagnostic(
          'AXE_FEATURE_DISABLED',
          'O motor suplementar axe-core permaneceu desativado pelo gate MV3/CSP; o motor próprio continuou normalmente.',
          canonicalTime(now()), true,
        ));
      } else if (state.axe.status === 'partial') {
        recoverable('AXE_EXECUTION_FAILED', 'O motor suplementar axe-core teve cobertura parcial; o motor próprio continuou normalmente.');
      }
      const hybrid = mergeAxeSupplementalResults(core, state.axe);
      state.editorialRuleResults = [...await runEditorialRules(state.snapshot)];
      state.ruleResults = [...hybrid.ruleResults, ...state.editorialRuleResults];
      state.itemResults = [...hybrid.itemResults];
    } catch (error) {
      rethrowAbort(error, signal);
      fail('CORE_AUDIT_FAILED', 'O núcleo de regras não pôde concluir a auditoria.', error);
      settleFatalAxeObservation();
    } finally {
      state.rawAxe = null;
    }
    if (fatal) throw Object.assign(new Error('AUDIT_FATAL_HANDLED'), { auditHandled: true });

    await progress('evidence', 'Preparando evidências', 72);
    state.occurrences = [
      ...makeOccurrences(auditId, state.coreRuleResults, state.itemResults),
      ...structuredClone(state.axe.occurrences),
    ];
    allocateOccurrenceIds(state);
    const indexes = buildSnapshotIndexes(state.snapshot);
    const artifactByNode = new Map();
    const canCaptureElements = Boolean(state.fullPage) || chromeAdapter.captureElementsWithoutFullPage === true;
    if (!canCaptureElements && state.occurrences.some(occurrence => occurrence.nodeId)) {
      recoverable('ELEMENT_CAPTURE_SKIPPED_NO_FULL_PAGE', 'As miniaturas de elementos não foram tentadas porque a captura original da página falhou.');
    }
    for (const occurrence of state.occurrences) {
      throwIfAborted(signal);
      if (state.fullPage) occurrence.evidenceIds.push(state.fullPage.evidenceId);
      if (!occurrence.nodeId) continue;
      if (artifactByNode.has(occurrence.nodeId)) {
        occurrence.evidenceIds.push(artifactByNode.get(occurrence.nodeId).evidenceId);
        continue;
      }
      const node = indexes.byNodeId.get(occurrence.nodeId);
      if (!node) {
        recoverable('EVIDENCE_NODE_MISSING', 'Um elemento relacionado à ocorrência não estava mais disponível.', { occurrenceId: occurrence.occurrenceId });
        continue;
      }
      try {
        let snippet = '';
        try {
          const response = await awaitStep(() => cdp.command('DOM.getOuterHTML', { backendNodeId: node.backendNodeId }));
          snippet = sanitizeHtmlSnippetSource(typeof response?.outerHTML === 'string' ? response.outerHTML : '', {
            privateTextDescendant: hasPrivateTextAncestor(node, indexes),
          });
        } catch (error) {
          rethrowAbort(error, signal);
          recoverable('SNIPPET_CAPTURE_FAILED', 'O trecho de código do elemento não pôde ser capturado.', { occurrenceId: occurrence.occurrenceId });
        }
        let thumbnail = null;
        if (canCaptureElements) {
          try {
            thumbnail = await awaitStep(() => (chromeAdapter.captureElement || captureElement)(cdp, node.rect, {
              ...(state.snapshot.document.layoutMetrics || raw.layoutMetrics || pristineMetrics),
              ...(state.fullPage ? { fullPageEvidenceId: state.fullPage.evidenceId } : {}),
            }));
            if (thumbnail.status !== 'captured') {
              recoverable('ELEMENT_CAPTURE_FAILED', 'A miniatura do elemento não pôde ser capturada.', { occurrenceId: occurrence.occurrenceId });
            }
          } catch (error) {
            rethrowAbort(error, signal);
            recoverable('ELEMENT_CAPTURE_FAILED', 'A miniatura do elemento não pôde ser capturada.', { occurrenceId: occurrence.occurrenceId });
          }
        }
        const selector = buildStableSelector(node, indexes);
        const accessibility = projectElementAccessibility(node, indexes);
        const artifact = {
          evidenceId: `element-${stableHash(`${auditId}\u0000${node.nodeId}`)}`,
          kind: 'element', nodeId: node.nodeId, backendNodeId: node.backendNodeId,
          selector, snippet, accessibility,
          ...(thumbnail?.status === 'captured' ? {
            dataUrl: thumbnail.dataUrl,
            ...(thumbnail.fullPageEvidenceId ? { fullPageEvidenceId: thumbnail.fullPageEvidenceId } : {}),
            metadata: thumbnail.metadata,
          } : {}),
          ...(node.media?.currentSrc ? { mediaUrl: safeUrl(node.media.currentSrc) } : {}),
        };
        artifact.hash = await awaitStep(() => hashEvidenceArtifact(artifact));
        artifactByNode.set(node.nodeId, artifact);
        state.artifacts.push(artifact);
        occurrence.evidenceIds.push(artifact.evidenceId);
      } catch (error) {
        rethrowAbort(error, signal);
        recoverable('EVIDENCE_CAPTURE_FAILED', 'As evidências de uma ocorrência não puderam ser preparadas.', { occurrenceId: occurrence.occurrenceId });
      }
      throwIfAborted(signal);
    }
    if (state.fullPage && typeof chromeAdapter.composeAnnouncementMap === 'function') {
      const pristineArtifact = state.artifacts.find(artifact => artifact.kind === 'full-page' && artifact.state === 'pristine');
      const sourceBefore = canonicalStringify(pristineArtifact);
      const observedMapMetrics = state.snapshot.document?.layoutMetrics || raw.layoutMetrics || pristineMetrics;
      try {
        const map = await awaitStep(() => chromeAdapter.composeAnnouncementMap({
          pageId: 'page-1',
          snapshot: state.snapshot,
          fullPageEvidence: structuredClone({ ...pristineArtifact, pageId: 'page-1' }),
          layoutMetrics: {
            ...observedMapMetrics,
            deviceScaleFactor: Number.isFinite(observedMapMetrics?.deviceScaleFactor)
              ? observedMapMetrics.deviceScaleFactor
              : state.environment.viewport.deviceScaleFactor,
          },
          signal,
        }));
        if (canonicalStringify(pristineArtifact) !== sourceBefore) {
          throw Object.assign(new Error('A captura pristine foi alterada durante a derivação.'), { code: 'ANNOTATION_MAP_SOURCE_INVALID' });
        }
        const recomputedMapHash = await awaitStep(() => hashEvidenceArtifact(map, {
          sourceArtifact: structuredClone({ ...pristineArtifact, pageId: 'page-1' }),
        }));
        if (map?.hash !== recomputedMapHash) {
          throw Object.assign(new Error('O hash do mapa derivado não corresponde ao conteúdo.'), { code: 'ANNOTATION_MAP_OUTPUT_INVALID' });
        }
        state.artifacts.push(structuredClone(map));
        if (map.status === 'partial') {
          recoverable('ANNOTATION_MAP_PARTIAL', 'O mapa visual foi gerado com cobertura parcial e limitações explícitas.');
        }
      } catch (error) {
        rethrowAbort(error, signal);
        const code = ANNOTATION_MAP_DIAGNOSTIC_CODES.has(error?.code) ? error.code : 'ANNOTATION_MAP_OUTPUT_INVALID';
        recoverable(code, 'O mapa visual derivado não pôde ser gerado localmente; a captura original foi preservada.');
      }
    }
    state.occurrences.push(...makeEditorialOccurrences(auditId, state.editorialRuleResults));
    allocateOccurrenceIds(state);
    state.manualReview = manualQueue(state.occurrences, state.itemResults);
    resolvePresentationTargets(state.occurrences, state.artifacts);
    const canonicalNodeByOccurrenceId = new Map(state.occurrences
      .filter(occurrence => occurrence.nodeId && occurrence.target?.nodeId === occurrence.nodeId &&
        occurrence.presentationTargetKey === `node:${occurrence.nodeId}`)
      .map(occurrence => [occurrence.occurrenceId, occurrence.nodeId]));
    state.presentation = dedupeFindingsForPresentation(state.occurrences, { canonicalNodeByOccurrenceId });

    await progress('reporting', 'Gerando relatório', 92);
    throwIfAborted(signal);
    state.status = recoverableFailure ? 'partial' : 'complete';
    try {
      const handoffModel = await awaitStep(() => draftModel({ ...state, endedAt: canonicalTime(now()) }));
      const handoff = await awaitStep(() => chromeAdapter.handoffReport?.(handoffModel));
      validateTransientReviewUrl(handoff?.reviewUrl, auditId, expectedExtensionId);
      state.report = {
        status: 'review-ready',
        reviewUrl: null,
        artifact: { status: 'pending', formats: [] },
      };
    } catch (error) {
      rethrowAbort(error, signal);
      recoverable('REPORT_HANDOFF_FAILED', 'A fila de revisão não pôde ser preparada.');
      state.status = 'partial';
    }
    throwIfAborted(signal);
    await progress('complete', 'Auditoria concluída', 100);
  } catch (error) {
    if (!error?.auditHandled) fail('NAVIGATION_FAILED', error?.name === 'AbortError' || signal?.aborted ? 'A auditoria foi cancelada.' : 'O site não pôde ser aberto de forma estável.', error);
  } finally {
    if (cdp) {
      try { await cdp.disconnect(); } catch { state.diagnostics.push(diagnostic('CDP_DISCONNECT_FAILED', 'A sessão de depuração não pôde ser encerrada automaticamente.', canonicalTime(now()), true)); if (state.status === 'complete') state.status = 'partial'; }
    }
    if (tab && closeAuditTab !== false) {
      try { await chromeAdapter.removeTab(tab.id); } catch { state.diagnostics.push(diagnostic('TAB_CLOSE_FAILED', 'A aba descartável não pôde ser fechada automaticamente.', canonicalTime(now()), true)); if (state.status === 'complete') state.status = 'partial'; }
    }
  }
  return finalize();

  async function finalize() {
    if (state.status === 'running') state.status = recoverableFailure ? 'partial' : fatal ? 'failed' : 'complete';
    if (['failed', 'cancelled'].includes(state.status)) settleFatalAxeObservation();
    if (state.finalUrlObserved && !state.fullPage &&
      !state.diagnostics.some(entry => entry.code === 'FULL_PAGE_CAPTURE_FAILED')) {
      appendDiagnosticOnce(
        'FULL_PAGE_CAPTURE_FAILED',
        'Não foi possível capturar a página completa no estado original.',
        true,
      );
    }
    state.endedAt = canonicalTime(now());
    if (!state.occurrences.length && state.coreRuleResults.length) {
      state.occurrences = makeOccurrences(auditId, state.coreRuleResults, state.itemResults);
    }
    if (state.occurrences.length) allocateOccurrenceIds(state);
    if (!state.manualReview.length && state.occurrences.length) state.manualReview = manualQueue(state.occurrences, state.itemResults);
    return draftModel(state);
  }
}

function opaqueId(randomBytes, prefix) {
  const bytes = randomBytes(16);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 16) throw new TypeError('AUDIT_EXECUTION_DENIED');
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return `${prefix}-${btoa(text).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '')}`;
}

function createPauseStore(sessionArea) {
  const prefix = 'audita:privacy-pause:v1:';
  return Object.freeze({
    async persistPause(record) {
      const key = `${prefix}${record.pauseId}`;
      try {
        await sessionArea.set({ [key]: record });
        const verified = (await sessionArea.get(key))?.[key];
        if (!verified) throw new Error();
      } catch { throw new Error('PRIVACY_STATE_UNAVAILABLE'); }
    },
    async getPause(pauseId) {
      try { return (await sessionArea.get(`${prefix}${pauseId}`))?.[`${prefix}${pauseId}`] ?? null; }
      catch { throw new Error('PRIVACY_STATE_UNAVAILABLE'); }
    },
  });
}

function internalContract(chromeAdapter) {
  const descriptor = chromeAdapter && typeof chromeAdapter === 'object'
    ? Object.getOwnPropertyDescriptor(chromeAdapter, AUDIT_EXECUTION_INTERNAL)
    : null;
  const value = descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : null;
  if (!value?.sessionArea || typeof value.sessionArea.get !== 'function' || typeof value.sessionArea.set !== 'function' ||
    typeof value.sessionArea.remove !== 'function' || typeof value.randomBytes !== 'function') {
    throw new TypeError('AUDIT_EXECUTION_DENIED');
  }
  return value;
}

function ownValue(value, key) {
  const descriptor = value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, key) : null;
  return descriptor?.enumerable && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
}

function captureExactRecord(value, keys) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return null;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== keys.length || ownKeys.some(key => typeof key !== 'string' || !keys.includes(key))) return null;
    const copy = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      copy[key] = descriptor.value;
    }
    return copy;
  } catch { return null; }
}

function attachedTarget(value) {
  const target = captureExactRecord(value, [
    'kind', 'tabId', 'windowId', 'documentId', 'initialUrlEvidence', 'initialUrlSessionDigest',
  ]);
  if (!target || target.kind !== 'attached' || !Number.isSafeInteger(target.tabId) || target.tabId < 0 ||
    !Number.isSafeInteger(target.windowId) || target.windowId < 0 ||
    typeof target.documentId !== 'string' || !/^[A-Za-z0-9._:-]{1,240}$/u.test(target.documentId) ||
    typeof target.initialUrlSessionDigest !== 'string' ||
    !/^hmac-sha256:[A-Za-z0-9_-]{43}$/u.test(target.initialUrlSessionDigest)) throw new TypeError('ATTACHED_AUDIT_EXECUTION_DENIED');
  try {
    const url = new URL(target.initialUrlEvidence);
    if (!['http:', 'https:'].includes(url.protocol) || url.href !== target.initialUrlEvidence ||
      url.username || url.password || url.hash) throw new Error();
  } catch { throw new TypeError('ATTACHED_AUDIT_EXECUTION_DENIED'); }
  return Object.freeze(target);
}

function proofMatchesAttached(value, target) {
  const proof = captureExactRecord(value, ['tabId', 'windowId', 'documentId', 'urlSessionDigest']);
  return Boolean(proof && proof.tabId === target.tabId && proof.windowId === target.windowId &&
    proof.documentId === target.documentId && proof.urlSessionDigest === target.initialUrlSessionDigest);
}

function captureAttachedFacadeArgs(value) {
  const allowed = [
    'auditId', 'sessionCapabilityId', 'target', 'capturePolicy', 'chromeAdapter', 'modelNow', 'signal',
    'expectedExtensionId', 'pageId', 'onCheckpoint', 'persistAuditModel',
  ];
  const required = [
    'auditId', 'sessionCapabilityId', 'target', 'capturePolicy', 'chromeAdapter', 'modelNow',
    'onCheckpoint', 'persistAuditModel',
  ];
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key !== 'string' || !allowed.includes(key)) || required.some(key => !keys.includes(key))) return null;
    const copy = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      copy[key] = descriptor.value;
    }
    return copy;
  } catch { return null; }
}

/** Production attached-page façade. It never accepts or owns a raw navigation target. */
export async function runAttachedAuditExecution(rawArgs = {}) {
  const args = captureAttachedFacadeArgs(rawArgs);
  if (!args) throw new TypeError('ATTACHED_AUDIT_EXECUTION_DENIED');
  const {
    auditId, sessionCapabilityId, target: inputTarget, capturePolicy, chromeAdapter, modelNow,
    signal, expectedExtensionId, pageId = 'page-1', onCheckpoint, persistAuditModel,
  } = args;
  const target = attachedTarget(inputTarget);
  if (typeof auditId !== 'string' || !/^[A-Za-z0-9._:-]{1,160}$/u.test(auditId) ||
    typeof sessionCapabilityId !== 'string' || !/^[A-Za-z0-9_-]{22}$/u.test(sessionCapabilityId) ||
    !isCapturePolicyV1(capturePolicy) || capturePolicy.mode !== 'no-pixels' || capturePolicy.includeQuery !== false ||
    typeof modelNow !== 'function' || typeof onCheckpoint !== 'function' || typeof persistAuditModel !== 'function' ||
    !chromeAdapter || typeof chromeAdapter.probeDocumentIdentity !== 'function') {
    throw new TypeError('ATTACHED_AUDIT_EXECUTION_DENIED');
  }
  const inventory = await createInstalledCoreRuleInventory();
  const startedAt = canonicalTime(modelNow());
  const checkpointRecorder = await createPageCheckpointRecorder({
    auditId, pageId, startedAt, rulesVersion: inventory.rulesVersion, inventory, onCheckpoint,
  });
  let legacyDraft = null;
  let terminalModel = null;
  let closedFailureCode = 'AUDIT_FAILED';
  const pipeline = args => executeObservedAuditPipeline({
    ...args,
    services: {
      async collectObservedPage({ observedTarget }) {
        const observedAdapter = {
          ...chromeAdapter,
          captureFullPageEnabled: false,
          captureElementsEnabled: false,
          captureElementsWithoutFullPage: false,
          async createTab() { return { id: observedTarget.tabId, windowId: observedTarget.windowId }; },
          async navigateTab() {},
          async waitForStable() { return { url: observedTarget.urlEvidence }; },
          async removeTab() {},
          async captureFullPage() { throw new Error('PIXEL_CAPTURE_OMITTED'); },
          async captureElement() { throw new Error('PIXEL_CAPTURE_OMITTED'); },
          composeAnnouncementMap: undefined,
        };
        legacyDraft = await runLegacyAudit({
          url: target.initialUrlEvidence, chromeAdapter: observedAdapter, now: modelNow,
          idFactory: () => auditId, signal, closeAuditTab: false, expectedExtensionId, startedAt,
        });
        terminalModel = await enrichAuditForReport(legacyDraft, {
          now: modelNow, expectedExtensionId,
          browserVersion: legacyDraft.environment?.chromeVersion || 'não disponível',
          rulesVersion: legacyDraft.methodology?.version || inventory.rulesVersion,
        });
        return { version: 1, kind: 'legacy-observation' };
      },
      async runCoreRules() {
        return { ruleResults: terminalModel.ruleResults.filter(result => result.source?.engine === 'audita-core') };
      },
      async buildAuditModel() { return terminalModel; },
      async persistAuditModel(model) {
        const finalProof = await chromeAdapter.probeDocumentIdentity(target.tabId);
        if (!proofMatchesAttached(finalProof, target)) args.failTargetChanged();
        if (signal?.aborted) throw new Error('AUDIT_ABORTED');
        if (!signal?.aborted && model?.session?.status === 'cancelled') throw new Error('AUDIT_FAILED');
        await persistAuditModel(model);
      },
    },
  });
  const failureModelFactory = async ({ code, status }) => {
    closedFailureCode = code;
    if (code !== 'AUDIT_ABORTED') return Object.freeze({
      schemaVersion: 2, auditId,
      session: Object.freeze({ status, diagnostics: Object.freeze([Object.freeze({ code })]) }),
    });
    const draft = legacyDraft ?? await runLegacyAudit({
      url: target.initialUrlEvidence,
      chromeAdapter: { async createTab() { throw new Error('AUDIT_ABORTED'); } },
      now: modelNow, idFactory: () => auditId, signal: undefined, closeAuditTab: false, expectedExtensionId, startedAt,
    });
    const cancelled = structuredClone(draft);
    cancelled.session.status = 'cancelled';
    cancelled.session.partial = false;
    const cancellationAt = canonicalTime(cancelled.timestamps?.endedAt ?? modelNow());
    if (!cancelled.session.diagnostics.some(entry => entry?.code === 'NAVIGATION_FAILED' &&
      entry?.message === 'A auditoria foi cancelada.' && entry?.recoverable === false)) {
      cancelled.session.diagnostics.push(diagnostic(
        'NAVIGATION_FAILED', 'A auditoria foi cancelada.', cancellationAt, false,
      ));
    }
    cancelled.session.diagnostics.push(diagnostic('AUDIT_ABORTED', 'A auditoria foi cancelada.', cancellationAt, false));
    return enrichAuditForReport(cancelled, {
      now: modelNow, expectedExtensionId,
      browserVersion: cancelled.environment?.chromeVersion || 'não disponível',
      rulesVersion: cancelled.methodology?.version || inventory.rulesVersion,
    });
  };
  const observed = await runObservedTabAudit({
    auditId, sessionCapabilityId, target, capturePolicy,
    privacyDecision: Object.freeze({ status: 'no-pixels', limitationCode: 'PIXEL_CAPTURE_OMITTED' }),
    checkpointRecorder, signal, chromeAdapter, pipeline, failureModelFactory, now: modelNow,
  });
  const lastCheckpoint = (() => {
    try {
      return validateExecutionCheckpoint({ auditId, checkpoint: observed.checkpoint, pageOrder: [pageId] });
    } catch { return null; }
  })();
  if (observed.status === 'completed' || closedFailureCode === 'AUDIT_ABORTED') {
    let model;
    try { model = createAuditModel(observed.model); } catch { throw new TypeError('ATTACHED_AUDIT_EXECUTION_DENIED'); }
    if (model.auditId !== auditId || !['complete', 'partial', 'cancelled'].includes(model.session.status) || !lastCheckpoint) {
      throw new TypeError('ATTACHED_AUDIT_EXECUTION_DENIED');
    }
    return deepFreeze({ version: 1, auditId, state: 'model', failureCode: null, model, checkpoint: lastCheckpoint });
  }
  const failureCode = closedFailureCode === 'TARGET_CHANGED' ? 'TARGET_CHANGED'
    : closedFailureCode === 'PRIVACY_TARGET_CHANGED' ? 'PRIVACY_PAUSED'
      : 'AUDIT_FAILED';
  return deepFreeze({
    version: 1, auditId, state: 'revoked', failureCode, model: null, checkpoint: lastCheckpoint,
  });
}

/** Internal orchestration result; its pipeline persists only a validated AuditModel V2. */
export async function runAuditExecution({
  url, chromeAdapter, now = () => new Date().toISOString(), idFactory = () => crypto.randomUUID(), signal,
  closeAuditTab = true, expectedExtensionId, pageId = 'page-1', cleanupMode,
  checkpointAuditId = null,
}) {
  const internals = internalContract(chromeAdapter);
  let navigationUrl = normalizeAuditUrl(url);
  const requestedEvidence = projectAuditResourceOrigin(navigationUrl);
  const generatedId = idFactory('audit');
  const auditId = typeof generatedId === 'string' ? generatedId.trim() : '';
  if (!/^[A-Za-z0-9._:-]{1,160}$/u.test(auditId)) throw new TypeError('O identificador da auditoria é inválido.');
  const privacyState = internals.privacyState ?? createPauseStore(internals.sessionArea);
  const resumeRecord = internals.resumePauseId
    ? await privacyState.getPause(internals.resumePauseId)
    : null;
  const resumedOwnerId = ownValue(resumeRecord, 'ownerId');
  const resumedSessionId = ownValue(resumeRecord, 'sessionCapabilityId');
  const ownerId = resumeRecord ? resumedOwnerId : opaqueId(internals.randomBytes, 'owner');
  const sessionCapabilityId = resumeRecord ? resumedSessionId : opaqueId(internals.randomBytes, 'session');
  if (resumeRecord && (!/^[A-Za-z0-9._:-]{1,160}$/u.test(ownerId ?? '') || !/^[A-Za-z0-9._:-]{1,160}$/u.test(sessionCapabilityId ?? ''))) {
    throw new TypeError('AUDIT_EXECUTION_DENIED');
  }
  const rawNavigationVault = createRawNavigationVaultV1({
    sessionArea: internals.sessionArea, now: internals.epochNow ?? Date.now,
    randomBytes: internals.randomBytes,
  });
  const issued = resumeRecord
    ? { navigationToken: 'A'.repeat(22) }
    : await rawNavigationVault.putInternal({ ownerId, rawUrl: navigationUrl });
  navigationUrl = null;
  const ownedTabs = createOwnedTabRegistry({ sessionArea: internals.sessionArea, chromeAdapter, now });
  const inventory = await createInstalledCoreRuleInventory();
  const resumeCheckpoint = ownValue(resumeRecord, 'checkpoint');
  const resumePages = ownValue(resumeCheckpoint, 'pages');
  const resumePage = ownValue(resumePages, '0');
  const checkpointStartedAt = ownValue(resumePage, 'startedAt');
  const checkpointRecorder = await createPageCheckpointRecorder({
    auditId: checkpointAuditId ?? auditId, pageId,
    startedAt: resumeRecord ? canonicalTime(checkpointStartedAt) : canonicalTime(now()),
    rulesVersion: inventory.rulesVersion, inventory,
    onCheckpoint: internals.onExecutionCheckpoint ?? (async () => {}),
  });
  const resumedPolicy = ownValue(resumeRecord, 'capturePolicy');
  const capturePolicy = isCapturePolicyV1(internals.capturePolicy)
    ? internals.capturePolicy
    : isCapturePolicyV1(resumedPolicy) ? resumedPolicy
    : createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false });
  const privacyDecision = internals.privacyDecision ?? (
    capturePolicy.mode === 'no-pixels'
      ? Object.freeze({ status: 'no-pixels', limitationCode: 'PIXEL_CAPTURE_OMITTED' })
      : null
  );
  if (!privacyDecision) throw new TypeError('AUDIT_EXECUTION_DENIED');
  let legacyDraft = null;
  let legacyModel = null;
  const pipeline = args => executeObservedAuditPipeline({
    ...args,
    services: {
      async collectObservedPage({ observedTarget }) {
        const observedAdapter = {
          ...chromeAdapter,
          captureFullPageEnabled: capturePolicy.captureFullPage,
          captureElementsEnabled: capturePolicy.captureElements,
          captureElementsWithoutFullPage: capturePolicy.mode === 'element-only',
          async createTab() { return { id: observedTarget.tabId, windowId: observedTarget.windowId }; },
          async navigateTab() {},
          async waitForStable() { return { url: observedTarget.urlEvidence || requestedEvidence }; },
          async removeTab(tabId) {
            if (closeAuditTab === false) return;
            const current = await ownedTabs.get(ownerId);
            const removed = await ownedTabs.removeOwned({ ownerId, auditId, tabId, fromState: current?.state });
            if (removed.state !== 'removed') throw new Error('TAB_CLOSE_FAILED');
          },
          ...(capturePolicy.captureFullPage ? {} : {
            async captureFullPage() { throw new Error('PIXEL_CAPTURE_OMITTED'); },
          }),
          ...(capturePolicy.captureElements ? {} : {
            async captureElement() { throw new Error('PIXEL_CAPTURE_OMITTED'); },
          }),
          ...(capturePolicy.composeAnnouncementMap ? {} : { composeAnnouncementMap: undefined }),
        };
        const draft = await runLegacyAudit({
          url: requestedEvidence, chromeAdapter: observedAdapter, now,
          idFactory: () => auditId, signal, closeAuditTab, expectedExtensionId,
        });
        legacyDraft = draft;
        legacyModel = await enrichAuditForReport(draft, {
          now, expectedExtensionId,
          browserVersion: draft.environment?.chromeVersion || 'não disponível',
          rulesVersion: draft.methodology?.version || '1.0.0',
        });
        return { version: 1, kind: 'legacy-observation' };
      },
      async runCoreRules() { return { ruleResults: legacyModel.ruleResults.filter(result => result.source?.engine === 'audita-core') }; },
      async buildAuditModel() { return legacyModel; },
      async persistAuditModel(model) { await internals.persistAuditModel?.(model); },
    },
  });
  const failureModelFactory = async ({ code, status }) => {
    const draft = await runLegacyAudit({
      url: requestedEvidence,
      chromeAdapter: { async createTab() { throw new Error('AUDIT_FAILED'); } },
      now, idFactory: () => auditId, signal: undefined, closeAuditTab: false, expectedExtensionId,
    });
    const compatible = structuredClone(draft);
    compatible.session.status = status;
    compatible.session.partial = false;
    if (code === 'AUDIT_ABORTED') compatible.session.diagnostics.push(diagnostic(
      'AUDIT_ABORTED', 'A auditoria foi cancelada.', canonicalTime(now()), false,
    ));
    const failedDraft = deepFreeze(compatible);
    if (!legacyDraft) legacyDraft = failedDraft;
    return failedDraft;
  };
  let navigationAttempted = false;
  const executionAdapter = {
    ...chromeAdapter,
    async navigateTab(...args) {
      navigationAttempted = true;
      return chromeAdapter.navigateTab(...args);
    },
  };
  const resumedOwnership = resumeRecord ? await ownedTabs.get(ownerId) : null;
  const observed = await runObservedTabAudit({
    auditId, sessionCapabilityId,
    target: { kind: 'disposable', ownerId, navigationToken: issued.navigationToken, cleanupMode: cleanupMode ?? resumedOwnership?.cleanupMode ?? (closeAuditTab === false ? 'retain-after-observation' : 'always') },
    capturePolicy, privacyDecision, checkpointRecorder, signal, chromeAdapter: executionAdapter, ownedTabs, rawNavigationVault,
    pipeline, privacyState,
    consentAuthority: internals.consentAuthority, failureModelFactory,
    resumePauseId: internals.resumePauseId, now,
  });
  const spoofedLegacyCancellation = !signal?.aborted && observed.status === 'failed' &&
    legacyDraft?.session?.status === 'cancelled';
  let compatibleModel = spoofedLegacyCancellation ? observed.model : (legacyDraft ?? observed.model);
  if (observed.ownershipState === 'cleanup-pending' && legacyModel) compatibleModel = legacyModel;
  if (navigationAttempted && compatibleModel?.schemaVersion === 1 && compatibleModel.attempted !== true) {
    const mutable = structuredClone(compatibleModel);
    mutable.attempted = true;
    compatibleModel = deepFreeze(mutable);
  }
  if (observed.ownershipState === 'cleanup-pending' && compatibleModel?.schemaVersion === 1 &&
    !compatibleModel.session.diagnostics.some(value => value.code === 'TAB_CLOSE_FAILED')) {
    const mutable = structuredClone(compatibleModel);
    mutable.session.diagnostics.push(diagnostic(
      'TAB_CLOSE_FAILED', 'A aba descartável não pôde ser fechada automaticamente.', canonicalTime(now()), true,
    ));
    if (mutable.session.status === 'complete') mutable.session.status = 'partial';
    mutable.session.partial = mutable.session.status === 'partial';
    compatibleModel = deepFreeze(mutable);
  }
  return Object.freeze({ ...observed, model: compatibleModel });
}

/** Compatibility façade: exact legacy call shape and model-only return. */
export async function runAudit({ url, chromeAdapter, now = () => new Date().toISOString(), idFactory = () => crypto.randomUUID(), signal, closeAuditTab = true, expectedExtensionId }) {
  const execution = await runAuditExecution({ url, chromeAdapter, now, idFactory, signal, closeAuditTab, expectedExtensionId });
  return execution.model;
}
