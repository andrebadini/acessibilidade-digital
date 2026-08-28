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
import { normalizeAuditUrl } from '../core/url.js';
import { axeEquivalenceForAuditaRule } from '../core/normative/axe-nbr-crosswalk.js';
import { runDynamicProbes } from '../collector/dynamic-probes.js';
import { section508ReferencesForWcag } from '../core/normative/section508.js';

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

function canonicalNow(now) {
  const value = typeof now === 'function' ? now() : new Date().toISOString();
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

function safeInternalUrl(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value);
    if (!['chrome-extension:', 'blob:'].includes(url.protocol)) return safeUrl(value) || null;
    url.username = '';
    url.password = '';
    for (const key of [...url.searchParams.keys()]) if (/(?:pass|token|secret|auth|session|cookie|csrf|otp|key)/iu.test(key)) url.searchParams.delete(key);
    return url.href;
  } catch {
    return null;
  }
}

function diagnostic(code, message, at, recoverable = false, details = {}) {
  return { code, message, at, recoverable, ...details };
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
      const sourceWcagRefs = result.ruleId === 'new-window-link-warning' ? [] : [...itemWcagRefs];
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
      itemWcagRefs: item.wcag.map(reference => reference.id), sourceWcagRefs: [], testedWcagRefs: [],
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
  if (state.occurrenceIdsAllocated) return;
  const oldToNew = new Map();
  state.occurrences = state.occurrences.map((occurrence, index) => {
    const occurrenceId = `occurrence-${occurrence.pageId}-${String(index + 1).padStart(6, '0')}`;
    oldToNew.set(occurrence.occurrenceId, occurrenceId);
    return { ...occurrence, occurrenceId };
  });
  if (state.axe) {
    const axeIds = state.occurrences.filter(occurrence => occurrence.source?.engine === 'axe-core').map(occurrence => occurrence.occurrenceId);
    const axe = structuredClone(state.axe);
    axe.occurrences = axe.occurrences.map((occurrence, index) => ({ ...occurrence, occurrenceId: axeIds[index] }));
    state.axe = deepFreeze(axe);
  }
  state.diagnostics = state.diagnostics.map(entry => entry.occurrenceId && oldToNew.has(entry.occurrenceId)
    ? { ...entry, occurrenceId: oldToNew.get(entry.occurrenceId) }
    : entry);
  state.occurrenceIdsAllocated = true;
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
    const selector = occurrence.target?.selector ?? occurrence.selector;
    const candidates = typeof selector === 'string' ? selectorToNodeIds.get(selector) : null;
    if (candidates?.length === 1) occurrence.presentationTargetKey = `node:${candidates[0]}`;
  }
}

function manualQueue(occurrences, itemResults) {
  const itemById = new Map(itemResults.map(item => [item.id, item]));
  return occurrences.filter(occurrence => occurrence.itemId &&
    (occurrence.outcome === 'cantTell' || occurrence.mode !== 'automated')).map(occurrence => {
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
    axe: state.axe,
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
export async function runAudit({ url, chromeAdapter, now = () => new Date().toISOString(), idFactory = () => crypto.randomUUID(), signal, closeAuditTab = true }) {
  if (!chromeAdapter || typeof chromeAdapter !== 'object') throw new TypeError('O adapter Chrome é obrigatório.');
  const navigationUrl = normalizeAuditUrl(url);
  const generatedId = idFactory('audit');
  const auditId = typeof generatedId === 'string' ? generatedId.trim() : '';
  if (!/^[A-Za-z0-9._:-]{1,160}$/u.test(auditId)) throw new TypeError('O identificador da auditoria é inválido.');
  const state = {
    auditId,
    requestedUrl: safeUrl(navigationUrl),
    finalUrl: '',
    startedAt: canonicalNow(now),
    endedAt: '',
    environment: { chromeVersion: '', viewport: { width: null, height: null, deviceScaleFactor: null } },
    status: 'running', diagnostics: [], progress: [], snapshot: null,
    occurrenceIdsAllocated: false,
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
    const entry = { type: 'AUDIT_PROGRESS', sessionId: auditId, auditId, phase, message, percent: Math.max(previous, percent), at: canonicalNow(now) };
    try { await chromeAdapter.emitProgress?.(entry); } catch { /* Progress transport must not abort the audit. */ }
    throwIfAborted(signal);
    state.progress.push(entry);
  };
  const recoverable = (code, message, details = {}) => {
    recoverableFailure = true;
    state.diagnostics.push(diagnostic(code, message, canonicalNow(now), true, details));
  };
  const fail = (code, message, error) => {
    fatal = true;
    state.status = error?.name === 'AbortError' || signal?.aborted ? 'cancelled' : 'failed';
    state.diagnostics.push(diagnostic(code, message, canonicalNow(now), false));
  };

  try {
    throwIfAborted(signal);
    await progress('opening', 'Abrindo o site', 5);
    tab = await awaitStep(() => chromeAdapter.createTab({ url: 'about:blank', active: false }));
    if (!Number.isInteger(tab?.id)) throw new Error('Tab inválida');
    await awaitStep(() => chromeAdapter.navigateTab(tab.id, navigationUrl, { signal }));
    const navigation = await awaitStep(() => chromeAdapter.waitForStable(tab.id, { signal, timeoutMs: 30_000 }));
    const observedUrl = navigation?.url || await awaitStep(() => chromeAdapter.getFinalUrl?.(tab.id)) || navigationUrl;
    state.finalUrl = safeUrl(observedUrl);
    cdp = await awaitStep(() => chromeAdapter.connectCdp(tab.id, { signal }));
    if (!cdp || typeof cdp.command !== 'function') throw new Error('CDP inválido');

    let pristineMetrics = {};
    try {
      pristineMetrics = await awaitStep(() => cdp.command('Page.getLayoutMetrics', {}));
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
      if (environment && typeof environment === 'object') state.environment = {
        chromeVersion: typeof environment.chromeVersion === 'string' ? environment.chromeVersion : '',
        viewport: {
          width: Number.isFinite(environment.viewport?.width) ? environment.viewport.width : null,
          height: Number.isFinite(environment.viewport?.height) ? environment.viewport.height : null,
          deviceScaleFactor: Number.isFinite(environment.viewport?.deviceScaleFactor) ? environment.viewport.deviceScaleFactor : null,
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
      state.snapshot = normalizeSnapshot(raw);
      state.accessibilityWidgets = detectAccessibilityWidgets(state.snapshot.document?.accessibilityWidgetSignals);
    } catch (error) {
      fail('COLLECTION_FAILED', 'A estrutura da página não pôde ser coletada com segurança.', error);
    }

    state.axe = normalizeAxeResults(state.rawAxe, {
      pageId: 'page-1', auditId, snapshot: state.snapshot, rulesVersion: METHODOLOGY.version,
    });
    state.rawAxe = null;
    state.limitations.push(...state.axe.limitations);
    if (state.axe.status === 'disabled') {
      state.diagnostics.push(diagnostic(
        'AXE_FEATURE_DISABLED',
        'O motor suplementar axe-core permaneceu desativado pelo gate MV3/CSP; o motor próprio continuou normalmente.',
        canonicalNow(now), true,
      ));
    } else if (state.axe.status === 'partial') {
      recoverable('AXE_EXECUTION_FAILED', 'O motor suplementar axe-core teve cobertura parcial; o motor próprio continuou normalmente.');
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
      const hybrid = mergeAxeSupplementalResults(core, state.axe);
      state.editorialRuleResults = [...await runEditorialRules(state.snapshot)];
      state.ruleResults = [...hybrid.ruleResults, ...state.editorialRuleResults];
      state.itemResults = [...hybrid.itemResults];
    } catch (error) {
      fail('CORE_AUDIT_FAILED', 'O núcleo de regras não pôde concluir a auditoria.', error);
    }
    if (fatal) throw Object.assign(new Error('AUDIT_FATAL_HANDLED'), { auditHandled: true });

    await progress('evidence', 'Preparando evidências', 72);
    state.occurrences = [
      ...makeOccurrences(auditId, state.coreRuleResults, state.itemResults),
      ...structuredClone(state.axe.occurrences),
    ];
    const indexes = buildSnapshotIndexes(state.snapshot);
    const artifactByNode = new Map();
    const canCaptureElements = Boolean(state.fullPage);
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
              fullPageEvidenceId: state.fullPage.evidenceId,
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
            fullPageEvidenceId: thumbnail.fullPageEvidenceId,
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
    state.presentation = dedupeFindingsForPresentation(state.occurrences);

    await progress('reporting', 'Gerando relatório', 92);
    throwIfAborted(signal);
    state.status = recoverableFailure ? 'partial' : 'complete';
    try {
      const handoffModel = await awaitStep(() => draftModel({ ...state, endedAt: canonicalNow(now) }));
      const handoff = await awaitStep(() => chromeAdapter.handoffReport?.(handoffModel));
      state.report = {
        status: 'review-ready',
        reviewUrl: safeInternalUrl(handoff?.reviewUrl),
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
      try { await cdp.disconnect(); } catch { state.diagnostics.push(diagnostic('CDP_DISCONNECT_FAILED', 'A sessão de depuração não pôde ser encerrada automaticamente.', canonicalNow(now), false)); if (state.status === 'complete') state.status = 'partial'; }
    }
    if (tab && closeAuditTab !== false) {
      try { await chromeAdapter.removeTab(tab.id); } catch { state.diagnostics.push(diagnostic('TAB_CLOSE_FAILED', 'A aba descartável não pôde ser fechada automaticamente.', canonicalNow(now), false)); if (state.status === 'complete') state.status = 'partial'; }
    }
  }
  return finalize();

  async function finalize() {
    if (state.status === 'running') state.status = recoverableFailure ? 'partial' : fatal ? 'failed' : 'complete';
    state.endedAt = canonicalNow(now);
    if (!state.occurrences.length && state.coreRuleResults.length) {
      state.occurrences = makeOccurrences(auditId, state.coreRuleResults, state.itemResults);
    }
    if (state.occurrences.length) allocateOccurrenceIds(state);
    if (!state.manualReview.length && state.occurrences.length) state.manualReview = manualQueue(state.occurrences, state.itemResults);
    return draftModel(state);
  }
}
