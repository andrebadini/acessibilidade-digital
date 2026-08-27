import { captureElement, captureFullPage } from '../browser/capture-evidence.js';
import { collectPage } from '../browser/collect-page.js';
import {
  NBR17225_ITEMS,
  buildAnnouncementPreview,
  buildSnapshotIndexes,
  buildStableSelector,
  computeAccessibleText,
  mergeProbesIntoSnapshot,
  normalizeProbes,
  normalizeSnapshot,
  runCoreAudit,
  sanitizeHtmlSnippetSource,
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

function editableControl(node) {
  const tag = normalizedText(node?.tagName).toLowerCase();
  const contenteditable = normalizedText(nodeAttribute(node, 'contenteditable')).toLowerCase();
  return ['input', 'select', 'textarea'].includes(tag) || (
    Object.hasOwn(node?.attributes || {}, 'contenteditable') && !['false', 'inherit'].includes(contenteditable)
  );
}

function observedBoolean(node, property, ariaName) {
  const direct = Object.hasOwn(node || {}, property) ? node[property] : undefined;
  if (direct === true || direct === false || (property === 'checked' && direct === 'mixed')) return direct;
  const form = Object.hasOwn(node?.form || {}, property) ? node.form[property] : undefined;
  if (form === true || form === false || (property === 'checked' && form === 'mixed')) return form;
  const aria = normalizedText(nodeAttribute(node, ariaName)).toLowerCase();
  if (aria === 'true') return true;
  if (aria === 'false') return false;
  if (property === 'checked' && aria === 'mixed') return 'mixed';
  if (property === 'invalid' && ['grammar', 'spelling'].includes(aria)) return true;
  return undefined;
}

function observedPresence(node, property, ariaName, nativeName = property) {
  const direct = Object.hasOwn(node || {}, property) ? node[property] : undefined;
  const form = Object.hasOwn(node?.form || {}, property) ? node.form[property] : undefined;
  const aria = normalizedText(nodeAttribute(node, ariaName)).toLowerCase();
  const native = Object.hasOwn(node?.attributes || {}, nativeName) ? true : undefined;
  const sources = [direct, form, aria === 'true' ? true : aria === 'false' ? false : undefined, native];
  if (sources.includes(true)) return true;
  if (sources.includes(false)) return false;
  return undefined;
}

function nativeRole(node) {
  const tag = normalizedText(node?.tagName).toLowerCase();
  const type = normalizedText(nodeAttribute(node, 'type') || node?.form?.type || 'text').toLowerCase();
  if (tag === 'button') return 'button';
  if (tag === 'a' && nodeAttribute(node, 'href') !== undefined) return 'link';
  if (tag === 'select') {
    return Object.hasOwn(node?.attributes || {}, 'multiple') || node?.form?.multiple === true ? 'listbox' : 'combobox';
  }
  if (tag === 'textarea') return 'textbox';
  if (tag === 'img') return 'img';
  if (tag === 'input') {
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (['button', 'image', 'reset', 'submit'].includes(type)) return 'button';
    if (type === 'range') return 'slider';
    if (type === 'number') return 'spinbutton';
    if (['', 'email', 'password', 'search', 'tel', 'text', 'url'].includes(type)) return 'textbox';
  }
  return '';
}

const CHECKED_ROLES = new Set(['checkbox', 'menuitemcheckbox', 'menuitemradio', 'radio', 'switch']);
const SELECTED_ROLES = new Set(['gridcell', 'option', 'row', 'tab', 'treeitem']);
const EXPANDED_ROLES = new Set(['button', 'combobox', 'link', 'menuitem', 'row', 'treeitem']);
const DISABLED_ROLES = new Set(['button', 'checkbox', 'combobox', 'link', 'listbox', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'radio', 'slider', 'spinbutton', 'switch', 'tab', 'textbox', 'treeitem']);
const REQUIRED_ROLES = new Set(['checkbox', 'combobox', 'listbox', 'radio', 'slider', 'spinbutton', 'switch', 'textbox']);
const INVALID_ROLES = new Set(['checkbox', 'combobox', 'listbox', 'radio', 'slider', 'spinbutton', 'switch', 'textbox']);

function compatibleState(node, role, property, ariaName, roles, presence = false) {
  if (!roles.has(role)) return undefined;
  return presence ? observedPresence(node, property, ariaName) : observedBoolean(node, property, ariaName);
}

function elementAccessibility(node, indexes) {
  const text = computeAccessibleText(node, indexes, {
    name: normalizedText(node?.accessibleName),
    description: normalizedText(node?.accessibleDescription),
  });
  const role = normalizedText(node?.axRole || node?.role || nodeAttribute(node, 'role') || nativeRole(node)).toLowerCase();
  const editable = editableControl(node);
  const checked = compatibleState(node, role, 'checked', 'aria-checked', CHECKED_ROLES);
  const selected = compatibleState(node, role, 'selected', 'aria-selected', SELECTED_ROLES);
  const expanded = compatibleState(node, role, 'expanded', 'aria-expanded', EXPANDED_ROLES);
  const disabled = compatibleState(node, role, 'disabled', 'aria-disabled', DISABLED_ROLES, true);
  const required = compatibleState(node, role, 'required', 'aria-required', REQUIRED_ROLES, true);
  const invalid = compatibleState(node, role, 'invalid', 'aria-invalid', INVALID_ROLES);
  const previewProperties = {
    ...text, role, checked, selected, expanded, disabled, required, invalid,
  };
  const states = [];
  if (checked === true) states.push('marcado');
  if (checked === false) states.push('desmarcado');
  if (checked === 'mixed') states.push('parcialmente marcado');
  if (selected === true) states.push('selecionado');
  if (selected === false) states.push('não selecionado');
  if (expanded === true) states.push('expandido');
  if (expanded === false) states.push('recolhido');
  if (disabled === true) states.push('indisponível');
  if (required === true) states.push('obrigatório');
  if (invalid === true) states.push('inválido');
  return {
    ...text,
    role,
    ...(editable ? { valueStatus: 'omitted-privacy' } : {}),
    states,
    visibleText: editable ? '' : normalizedText(node?.visibleText),
    announcementPreview: buildAnnouncementPreview(previewProperties).text,
  };
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
        hash: stableHash(state.fullPage.dataUrl),
      };
      state.artifacts.push(artifact);
    } catch (error) {
      rethrowAbort(error, signal);
      recoverable('FULL_PAGE_CAPTURE_FAILED', 'Não foi possível capturar a página completa no estado original.');
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
    } catch (error) {
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
          snippet = sanitizeHtmlSnippetSource(typeof response?.outerHTML === 'string' ? response.outerHTML : '');
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
        const accessibility = elementAccessibility(node, indexes);
        const artifact = {
          evidenceId: `element-${stableHash(`${auditId}\u0000${node.nodeId}`)}`,
          kind: 'element', nodeId: node.nodeId, backendNodeId: node.backendNodeId,
          selector, snippet, accessibility,
          ...(thumbnail?.status === 'captured' ? { dataUrl: thumbnail.dataUrl, fullPageEvidenceId: thumbnail.fullPageEvidenceId } : {}),
          ...(node.media?.currentSrc ? { mediaUrl: safeUrl(node.media.currentSrc) } : {}),
        };
        artifact.hash = stableHash({ selector, snippet, thumbnail: thumbnail?.evidenceId || null, mediaUrl: artifact.mediaUrl || null, accessibility });
        artifactByNode.set(node.nodeId, artifact);
        state.artifacts.push(artifact);
        occurrence.evidenceIds.push(artifact.evidenceId);
      } catch (error) {
        rethrowAbort(error, signal);
        recoverable('EVIDENCE_CAPTURE_FAILED', 'As evidências de uma ocorrência não puderam ser preparadas.', { occurrenceId: occurrence.occurrenceId });
      }
      throwIfAborted(signal);
    }
    state.manualReview = manualQueue(state.occurrences, state.itemResults);

    await progress('reporting', 'Gerando relatório', 92);
    throwIfAborted(signal);
    state.status = recoverableFailure ? 'partial' : 'complete';
    try {
      const handoff = await awaitStep(() => chromeAdapter.handoffReport?.(draftModel({ ...state, endedAt: canonicalNow(now) })));
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
    if (!state.occurrences.length && state.ruleResults.length) state.occurrences = makeOccurrences(auditId, state.ruleResults, state.itemResults);
    if (!state.manualReview.length && state.occurrences.length) state.manualReview = manualQueue(state.occurrences, state.itemResults);
    return draftModel(state);
  }
}
