import { captureElement, captureFullPage } from '../browser/capture-evidence.js';
import { collectPage } from '../browser/collect-page.js';
import {
  NBR17225_ITEMS,
  buildSnapshotIndexes,
  buildStableSelector,
  mergeProbesIntoSnapshot,
  normalizeProbes,
  normalizeSnapshot,
  runCoreAudit,
  sanitizeHtmlSnippet,
  sanitizeResourceUrl,
} from '../core/index.js';
import { normalizeAuditUrl } from '../core/url.js';
import { runDynamicProbes } from '../collector/dynamic-probes.js';

const SCHEMA_VERSION = 1;
const METHODOLOGY = Object.freeze({ name: 'Audita MT — ABNT NBR 17225 e WCAG 2.2', version: '1.0.0', ruleCount: 130, itemCount: 146 });

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

function fallbackItems() {
  return NBR17225_ITEMS.map(item => ({ ...item, wcag: item.wcag.map(reference => ({ ...reference })), outcome: 'cantTell', ruleResults: [] }));
}

function targetNodeId(target) {
  if (typeof target === 'string' || Number.isSafeInteger(target)) return String(target);
  if (target && (typeof target.nodeId === 'string' || Number.isSafeInteger(target.nodeId))) return String(target.nodeId);
  return null;
}

function makeOccurrences(auditId, ruleResults, itemResults) {
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
      add({
        itemId,
        ruleId: result.ruleId,
        outcome: result.outcome,
        mode: result.mode,
        nodeId: nodeId && nodeId !== 'document' ? nodeId : null,
        evidenceIds: [],
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
      justification: item.humanReason || 'O item depende de revisão humana no nível da página.',
    });
  }
  return occurrences;
}

function manualQueue(occurrences, itemResults) {
  const itemById = new Map(itemResults.map(item => [item.id, item]));
  return occurrences.filter(occurrence => occurrence.outcome === 'cantTell' || occurrence.mode !== 'automated').map(occurrence => {
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

function draftModel(state) {
  const model = {
    schemaVersion: SCHEMA_VERSION,
    auditId: state.auditId,
    requestedUrl: state.requestedUrl,
    finalUrl: state.finalUrl || state.requestedUrl,
    timestamps: { startedAt: state.startedAt, ...(state.endedAt ? { endedAt: state.endedAt } : {}) },
    environment: state.environment,
    methodology: METHODOLOGY,
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
    progress: state.progress,
    report: state.report,
    reproducibility: {
      methodologyVersion: METHODOLOGY.version,
      snapshotHash: stableHash(state.snapshot || null),
      ruleResultsHash: stableHash(state.ruleResults),
      evidenceHash: stableHash(state.artifacts.map(artifact => ({ evidenceId: artifact.evidenceId, kind: artifact.kind, nodeId: artifact.nodeId || null, hash: artifact.hash }))),
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
    ruleResults: [], itemResults: fallbackItems(), occurrences: [], manualReview: [],
    artifacts: [], fullPage: null,
    report: { status: 'pending', reviewUrl: null, artifact: { status: 'pending', formats: [] } },
  };
  let tab = null;
  let cdp = null;
  let fatal = false;
  let recoverableFailure = false;

  const progress = async (phase, message, percent) => {
    const previous = state.progress.at(-1)?.percent ?? -1;
    const entry = { type: 'AUDIT_PROGRESS', sessionId: auditId, auditId, phase, message, percent: Math.max(previous, percent), at: canonicalNow(now) };
    state.progress.push(entry);
    try { await chromeAdapter.emitProgress?.(entry); } catch { /* Progress transport must not abort the audit. */ }
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
    if (signal?.aborted) throw signal.reason || new DOMException('Operação cancelada', 'AbortError');
    await progress('opening', 'Abrindo o site', 5);
    tab = await chromeAdapter.createTab({ url: 'about:blank', active: false });
    if (!Number.isInteger(tab?.id)) throw new Error('Tab inválida');
    await chromeAdapter.navigateTab(tab.id, navigationUrl, { signal });
    const navigation = await chromeAdapter.waitForStable(tab.id, { signal, timeoutMs: 30_000 });
    state.finalUrl = safeUrl(navigation?.url || await chromeAdapter.getFinalUrl?.(tab.id) || navigationUrl);
    cdp = await chromeAdapter.connectCdp(tab.id, { signal });
    if (!cdp || typeof cdp.command !== 'function') throw new Error('CDP inválido');

    let pristineMetrics = {};
    try {
      pristineMetrics = await cdp.command('Page.getLayoutMetrics', {});
      state.fullPage = await (chromeAdapter.captureFullPage || captureFullPage)(cdp, pristineMetrics);
      const artifact = {
        evidenceId: state.fullPage.evidenceId,
        kind: 'full-page',
        state: 'pristine',
        dataUrl: state.fullPage.dataUrl,
        metadata: state.fullPage.metadata,
        hash: stableHash(state.fullPage.dataUrl),
      };
      state.artifacts.push(artifact);
    } catch {
      recoverable('FULL_PAGE_CAPTURE_FAILED', 'Não foi possível capturar a página completa no estado original.');
    }

    try {
      const environment = await chromeAdapter.getEnvironment?.(tab.id, cdp, pristineMetrics);
      if (environment && typeof environment === 'object') state.environment = {
        chromeVersion: typeof environment.chromeVersion === 'string' ? environment.chromeVersion : '',
        viewport: {
          width: Number.isFinite(environment.viewport?.width) ? environment.viewport.width : null,
          height: Number.isFinite(environment.viewport?.height) ? environment.viewport.height : null,
          deviceScaleFactor: Number.isFinite(environment.viewport?.deviceScaleFactor) ? environment.viewport.deviceScaleFactor : null,
        },
      };
    } catch {
      recoverable('ENVIRONMENT_UNAVAILABLE', 'Os metadados públicos do ambiente não puderam ser lidos.');
    }

    await progress('collecting', 'Lendo a estrutura', 25);
    let raw;
    try {
      raw = chromeAdapter.collectPage
        ? await chromeAdapter.collectPage(cdp, tab.id, { signal })
        : await collectPage(cdp, tab.id, { executeScript: chromeAdapter.executeScript, signal });
      state.snapshot = normalizeSnapshot(raw);
    } catch (error) {
      fail('COLLECTION_FAILED', 'A estrutura da página não pôde ser coletada com segurança.', error);
    }
    if (fatal) throw Object.assign(new Error('AUDIT_FATAL_HANDLED'), { auditHandled: true });

    try {
      const rawProbes = chromeAdapter.runDynamicProbes
        ? await chromeAdapter.runDynamicProbes(tab.id, cdp, { signal })
        : await runDynamicProbes({ adapter: chromeAdapter.createProbeAdapter?.(tab.id, cdp), signal });
      state.snapshot = mergeProbesIntoSnapshot(state.snapshot, normalizeProbes(rawProbes));
    } catch {
      recoverable('DYNAMIC_PROBES_FAILED', 'As verificações dinâmicas não puderam ser concluídas.');
    }

    await progress('testing', 'Verificando acessibilidade', 50);
    try {
      const core = await runCoreAudit(state.snapshot);
      state.ruleResults = [...core.ruleResults];
      state.itemResults = [...core.itemResults];
    } catch (error) {
      fail('CORE_AUDIT_FAILED', 'O núcleo de regras não pôde concluir a auditoria.', error);
    }
    if (fatal) throw Object.assign(new Error('AUDIT_FATAL_HANDLED'), { auditHandled: true });

    await progress('evidence', 'Preparando evidências', 72);
    state.occurrences = makeOccurrences(auditId, state.ruleResults, state.itemResults);
    const indexes = buildSnapshotIndexes(state.snapshot);
    const artifactByNode = new Map();
    for (const occurrence of state.occurrences) {
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
          const response = await cdp.command('DOM.getOuterHTML', { backendNodeId: node.backendNodeId });
          snippet = sanitizeHtmlSnippet(typeof response?.outerHTML === 'string' ? response.outerHTML : '');
        } catch {
          recoverable('SNIPPET_CAPTURE_FAILED', 'O trecho de código do elemento não pôde ser capturado.', { occurrenceId: occurrence.occurrenceId });
        }
        let thumbnail = null;
        try {
          thumbnail = await (chromeAdapter.captureElement || captureElement)(cdp, node.rect, {
            ...(state.snapshot.document.layoutMetrics || raw.layoutMetrics || pristineMetrics),
            fullPageEvidenceId: state.fullPage?.evidenceId || null,
          });
          if (thumbnail.status !== 'captured') {
            recoverable('ELEMENT_CAPTURE_FAILED', 'A miniatura do elemento não pôde ser capturada.', { occurrenceId: occurrence.occurrenceId });
          }
        } catch {
          recoverable('ELEMENT_CAPTURE_FAILED', 'A miniatura do elemento não pôde ser capturada.', { occurrenceId: occurrence.occurrenceId });
        }
        const selector = buildStableSelector(node, indexes);
        const artifact = {
          evidenceId: `element-${stableHash(`${auditId}\u0000${node.nodeId}`)}`,
          kind: 'element', nodeId: node.nodeId, backendNodeId: node.backendNodeId,
          selector, snippet,
          ...(thumbnail?.status === 'captured' ? { dataUrl: thumbnail.dataUrl, fullPageEvidenceId: thumbnail.fullPageEvidenceId } : {}),
          ...(node.media?.currentSrc ? { mediaUrl: safeUrl(node.media.currentSrc) } : {}),
        };
        artifact.hash = stableHash({ selector, snippet, thumbnail: thumbnail?.evidenceId || null, mediaUrl: artifact.mediaUrl || null });
        artifactByNode.set(node.nodeId, artifact);
        state.artifacts.push(artifact);
        occurrence.evidenceIds.push(artifact.evidenceId);
      } catch {
        recoverable('EVIDENCE_CAPTURE_FAILED', 'As evidências de uma ocorrência não puderam ser preparadas.', { occurrenceId: occurrence.occurrenceId });
      }
    }
    state.manualReview = manualQueue(state.occurrences, state.itemResults);

    await progress('reporting', 'Gerando relatório', 92);
    state.status = recoverableFailure ? 'partial' : 'complete';
    try {
      const handoff = await chromeAdapter.handoffReport?.(draftModel({ ...state, endedAt: canonicalNow(now) }));
      state.report = {
        status: 'review-ready',
        reviewUrl: safeInternalUrl(handoff?.reviewUrl),
        artifact: { status: 'pending', formats: [] },
      };
    } catch {
      recoverable('REPORT_HANDOFF_FAILED', 'A fila de revisão não pôde ser preparada.');
      state.status = 'partial';
    }
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
    if (!state.occurrences.length && state.ruleResults.length) state.occurrences = makeOccurrences(auditId, state.ruleResults, state.itemResults);
    if (!state.manualReview.length && state.occurrences.length) state.manualReview = manualQueue(state.occurrences, state.itemResults);
    return draftModel(state);
  }
}
