import { createReviewDecision } from '../core/review/decisions.js';
import { createInstalledCoreRuleInventory } from '../core/rules/core-rule-inventory.js';
import { buildCompleteReportSummary } from '../panel/panel-summary.js';
import { createAuditStore } from '../storage/audit-store.js';
import { createDestructiveDialog } from '../ui/destructive-dialog.js';
import { parseAuditDeletedEvent } from '../core/audit-deleted-event.js';
import {
  createAuthorizedReviewBatchCommitter, createAuthorizedReviewDecisionCommitter, isSafeEvidenceImageUrl, normalizeReviewAuditId,
} from './review-state.js';
import {
  ANSWER_LABELS, CLASSIFICATION_WORDS, GLOSSARY, IMAGE_PURPOSES, LAY_ANSWERS, LAY_GROUPS, PAGE_AID_DESCRIPTIONS, PAGE_AIDS,
  aidLabel, buildLayReviewPlan, draftFinding, formatLocalInstant, imageFindingText, imagePlan, layReviewProgress,
} from '../core/report/lay-review.js';
import { applyReportSourceControls, buildReportView, renderReportView, updateReportHighlightAction } from './report-view.js';
import { REPORT_PORT_NAME } from '../background/report-port.js';
import { createReportHighlightPolicy } from './report-highlight-policy.js';

// Respostas canônicas: conforme, não conforme, não foi possível determinar e não se aplica. A tela as
// oferece em linguagem simples (LAY_ANSWERS): Sim, Não, Não consegui verificar, Não existe nesta página.
const list = document.querySelector('#review-list');
const reportRoot = document.querySelector('#report-root');
const reviewControls = document.querySelector('.review-controls');
const status = document.querySelector('#review-status');
const evaluator = document.querySelector('#review-evaluator');
const returnToPage = document.querySelector('#return-to-page');
const reportSourceExplanation = document.querySelector('#report-source-explanation');
const regenerate = document.querySelector('#regenerate-report');
const deleteAudit = document.querySelector('#delete-audit');
const deleteAuditDialog = document.querySelector('#delete-audit-dialog');
const deleteAuditCancel = document.querySelector('#delete-audit-cancel');
const deleteAuditConfirm = document.querySelector('#delete-audit-confirm');
const deleteAuditDialogStatus = document.querySelector('#delete-audit-dialog-status');
const EXPORT_CLEANUP_MESSAGE = 'Um arquivo obsoleto da exportação não pôde ser removido com confirmação; tente gerar o relatório novamente.';
const store = createAuditStore();
const commitDecision = createAuthorizedReviewDecisionCommitter();
const commitDecisionBatch = createAuthorizedReviewBatchCommitter();
let auditModel;
let reportBasis = null;
let reportModelRevision = 0;
let evidenceAnchorById = new Map();
let reportSessionCapabilityId = null;
let reportSessionState = null;
let reportHighlightPort = null;
let activeHighlightOccurrenceId = null;
const highlightAvailability = new Map();
let reportReconnectTimer = null;
let reportReconnectAttempts = 0;
const REPORT_RECONNECT_DELAYS = Object.freeze([250, 1_000, 3_000]);

function exactRecord(value, keys) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return null;
    const own = Reflect.ownKeys(value);
    if (own.length !== keys.length || own.some(key => typeof key !== 'string' || !keys.includes(key))) return null;
    const copy = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      copy[key] = descriptor.value;
    }
    return copy;
  } catch { return null; }
}

function sendWorkerRequest(message) {
  return new Promise(resolve => {
    try {
      chrome.runtime.sendMessage(message, response => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: 'Não foi possível concluir a operação local.' });
          return;
        }
        resolve(response && typeof response === 'object'
          ? response
          : { ok: false, error: 'Não foi possível concluir a operação local.' });
      });
    } catch {
      resolve({ ok: false, error: 'Não foi possível concluir a operação local.' });
    }
  });
}

// A autorização do relatório vale 30 minutos e a revisão guiada costuma levar mais que isso. Vencido o
// prazo, toda resposta, exportação e destaque era recusada ("o relatório perdeu a autorização"). O
// relatório renova a própria autorização enquanto está aberto (a cada poucos minutos, ao voltar para a
// aba e antes de uma ação depois de um intervalo) e, se uma ação for recusada por autorização, renova e
// repete uma vez. A capacidade é a mesma: exportações em andamento não são afetadas.
const REPORT_RENEW_INTERVAL_MS = 4 * 60_000;
const RENEWABLE_DENIALS = new Set([
  'REPORT_OPERATION_DENIED', 'REPORT_EXPORT_DENIED', 'REPORT_INTENT_DENIED', 'REPORT_RETURN_DENIED',
  'PAGE_AID_DENIED', 'HIGHLIGHT_NOT_AUTHORIZED', 'HIGHLIGHT_RETURN_FAILED', 'CONTEXT_DENIED',
]);
let reportRenewal = null;
let reportRenewedAt = 0;
let lastCommitFailureCode = null;
let reportViewLimitations = [];

function renewableDenial(response) {
  if (response?.ok === true) return false;
  return typeof response?.code !== 'string' || RENEWABLE_DENIALS.has(response.code);
}

function applyReportSessionState(previousState) {
  if (previousState === reportSessionState) return;
  if (reportSessionState !== 'result') {
    // A página auditada mudou ou a sessão dela venceu: o relatório segue para revisão e exportação.
    activeHighlightOccurrenceId = null;
    highlightAvailability.clear();
    reportHighlightPolicy.invalidateKnown();
    if (reportReconnectTimer !== null) clearTimeout(reportReconnectTimer);
    reportReconnectTimer = null;
    try { reportHighlightPort?.disconnect?.(); } catch { /* closed locally */ }
    reportHighlightPort = null;
    for (const node of list.querySelectorAll('button.lay-show')) node.hidden = true;
  } else {
    for (const node of list.querySelectorAll('button.lay-show')) node.hidden = false;
    reportReconnectAttempts = 0;
    connectReportHighlightState();
  }
  try {
    applyReportSourceControls({
      reportSessionState, limitations: reportViewLimitations,
      returnControl: returnToPage, explanation: reportSourceExplanation,
    });
  } catch { returnToPage.disabled = reportSessionState !== 'result'; }
}

async function renewReportSession() {
  const id = auditModel?.auditId ?? safeAuditId();
  if (!id || !reportSessionCapabilityId) return false;
  if (reportRenewal) return reportRenewal;
  reportRenewal = (async () => {
    const connected = await sendWorkerRequest({ type: 'REPORT_CONNECT', auditId: id });
    const connection = exactRecord(connected, ['ok', 'auditId', 'sessionCapabilityId', 'state']);
    if (connection?.ok !== true || connection.auditId !== id ||
      !/^[A-Za-z0-9_-]{22}$/u.test(connection.sessionCapabilityId ?? '') ||
      !['result', 'view-only'].includes(connection.state) || (auditModel && auditModel.auditId !== id)) return false;
    const previousState = reportSessionState;
    const previousCapability = reportSessionCapabilityId;
    reportSessionCapabilityId = connection.sessionCapabilityId;
    reportSessionState = connection.state;
    reportRenewedAt = Date.now();
    if (previousCapability !== reportSessionCapabilityId && reportSessionState === 'result') {
      try { reportHighlightPort?.disconnect?.(); } catch { /* closed locally */ }
      reportHighlightPort = null;
      reportReconnectAttempts = 0;
      connectReportHighlightState();
    }
    applyReportSessionState(previousState);
    return true;
  })().finally(() => { reportRenewal = null; });
  return reportRenewal;
}

// Envia uma ação do relatório com a autorização em dia; uma recusa por autorização renova e repete.
async function sendAuthorizedRequest(build) {
  if (!reportSessionCapabilityId) return { ok: false, error: 'Não foi possível concluir a operação local.' };
  if (Date.now() - reportRenewedAt > REPORT_RENEW_INTERVAL_MS) await renewReportSession();
  const response = await sendWorkerRequest(build(reportSessionCapabilityId));
  if (!renewableDenial(response) || !await renewReportSession()) return response;
  return sendWorkerRequest(build(reportSessionCapabilityId));
}

setInterval(() => { if (auditModel && reportSessionCapabilityId) void renewReportSession(); }, REPORT_RENEW_INTERVAL_MS);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && auditModel && reportSessionCapabilityId &&
    Date.now() - reportRenewedAt > 60_000) void renewReportSession();
});

function renderDeletedAudit() {
  auditModel = null;
  reportBasis = null;
  reportSessionCapabilityId = null;
  reportSessionState = null;
  activeHighlightOccurrenceId = null;
  highlightAvailability.clear();
  if (reportReconnectTimer !== null) clearTimeout(reportReconnectTimer);
  reportReconnectTimer = null;
  reportReconnectAttempts = REPORT_RECONNECT_DELAYS.length;
  reportHighlightPolicy.invalidateKnown();
  try { reportHighlightPort?.disconnect?.(); } catch { /* closed locally */ }
  reportHighlightPort = null;
  list.replaceChildren();
  evaluator.disabled = true;
  returnToPage.disabled = true;
  returnToPage.hidden = false;
  reportSourceExplanation.hidden = true;
  regenerate.disabled = true;
  deleteAudit.disabled = true;
}

function reportOccurrence(occurrenceId) {
  if (typeof occurrenceId !== 'string' || !auditModel || !Array.isArray(auditModel.occurrences)) return null;
  const { occurrenceCounts, occurrenceById } = modelLookups(auditModel);
  return occurrenceCounts.get(occurrenceId) === 1 ? occurrenceById.get(occurrenceId) : null;
}

function announceReportHighlight(message) {
  const region = reportRoot.querySelector?.('[role="status"][aria-live="polite"]');
  if (region && typeof message === 'string') region.textContent = message;
}

function refreshReportHighlightControl(occurrenceId) {
  return updateReportHighlightAction({
    root: reportRoot, occurrenceId,
    bindingStatus: highlightAvailability.get(occurrenceId) ?? { state: 'unavailable', reason: 'live-proof-failed' },
    activeOccurrenceId: activeHighlightOccurrenceId,
  });
}

function refreshAllReportHighlightControls() {
  for (const occurrenceId of highlightAvailability.keys()) refreshReportHighlightControl(occurrenceId);
}

async function handleReportHighlightIntent(intent, { announce = true } = {}) {
  if (reportSessionState !== 'result' || !auditModel?.auditId || !reportSessionCapabilityId ||
    !intent || typeof intent !== 'object') return false;
  const type = intent.type;
  if (!['GET_HIGHLIGHT_AVAILABILITY', 'HIGHLIGHT_OCCURRENCE', 'CLEAR_HIGHLIGHT'].includes(type)) return false;
  const occurrenceId = type === 'CLEAR_HIGHLIGHT' ? null : intent.occurrenceId;
  if (type !== 'CLEAR_HIGHLIGHT' && !reportOccurrence(occurrenceId)) return false;
  if (type === 'HIGHLIGHT_OCCURRENCE' && highlightAvailability.get(occurrenceId)?.state !== 'available') {
    if (announce) announceReportHighlight('Verifique novamente a disponibilidade antes de destacar este item.');
    return false;
  }
  if (type === 'CLEAR_HIGHLIGHT' && !activeHighlightOccurrenceId) return false;
  if (type === 'GET_HIGHLIGHT_AVAILABILITY') {
    highlightAvailability.set(occurrenceId, { state: 'checking' });
    refreshReportHighlightControl(occurrenceId);
  }
  const auditId = auditModel.auditId;
  const response = await sendAuthorizedRequest(sessionCapabilityId => ({
    type, sessionCapabilityId, auditId,
    ...(occurrenceId === null ? {} : { occurrenceId }),
  }));
  if (type === 'GET_HIGHLIGHT_AVAILABILITY') {
    const success = exactRecord(response, ['ok', 'bindingStatus']);
    const available = exactRecord(success?.bindingStatus, ['state']);
    const unavailable = exactRecord(success?.bindingStatus, ['state', 'reason']);
    highlightAvailability.set(occurrenceId, success?.ok === true && available?.state === 'available'
      ? { state: 'available' }
      : success?.ok === true && unavailable?.state === 'unavailable'
        ? { state: 'unavailable', reason: unavailable.reason }
        : { state: 'unavailable', reason: 'live-proof-failed' });
    refreshReportHighlightControl(occurrenceId);
    if (announce) announceReportHighlight(highlightAvailability.get(occurrenceId).state === 'available'
      ? 'Este item pode ser destacado na página auditada.'
      : 'Destaque ao vivo indisponível; consulte as evidências registradas.');
    return success?.ok === true;
  }
  if (type === 'HIGHLIGHT_OCCURRENCE') {
    const success = exactRecord(response, ['ok', 'highlight']);
    const highlighted = exactRecord(success?.highlight, ['state', 'occurrenceId']);
    if (success?.ok === true && highlighted?.state === 'active' && highlighted.occurrenceId === occurrenceId) {
      activeHighlightOccurrenceId = occurrenceId;
      refreshAllReportHighlightControls();
      announceReportHighlight('Destaque visível na página auditada.');
      return true;
    }
    highlightAvailability.set(occurrenceId, { state: 'unavailable', reason: 'live-proof-failed' });
    refreshReportHighlightControl(occurrenceId);
    announceReportHighlight('O destaque foi negado ou perdeu validade. Verifique novamente ou consulte as evidências registradas.');
    return false;
  }
  const success = exactRecord(response, ['ok', 'highlight']);
  const cleared = exactRecord(success?.highlight, ['state']);
  if (success?.ok === true && cleared?.state === 'clear') {
    activeHighlightOccurrenceId = null;
    refreshAllReportHighlightControls();
    announceReportHighlight('Destaque removido da página auditada.');
    void reportHighlightPolicy.recheckKnown();
    return true;
  }
  announceReportHighlight('Não foi possível confirmar a remoção do destaque.');
  return false;
}

const reportHighlightPolicy = createReportHighlightPolicy({
  requestAvailability: (occurrenceId, options) => handleReportHighlightIntent({
    type: 'GET_HIGHLIGHT_AVAILABILITY', occurrenceId,
  }, options),
  maximumKnown: 40,
  maximumQueued: 8,
});

function scheduleReportHighlightReconnect() {
  if (reportReconnectTimer !== null || reportReconnectAttempts >= REPORT_RECONNECT_DELAYS.length ||
    reportSessionState !== 'result' || !auditModel?.auditId || !reportSessionCapabilityId) return;
  const delay = REPORT_RECONNECT_DELAYS[reportReconnectAttempts];
  reportReconnectAttempts += 1;
  reportReconnectTimer = setTimeout(() => {
    reportReconnectTimer = null;
    connectReportHighlightState();
  }, delay);
}

function connectReportHighlightState() {
  if (reportSessionState !== 'result' || !auditModel?.auditId || !reportSessionCapabilityId ||
    typeof chrome.runtime.connect !== 'function') return;
  try {
    const port = chrome.runtime.connect({ name: REPORT_PORT_NAME });
    reportHighlightPort = port;
    port.onMessage.addListener(value => {
      const event = exactRecord(value, ['version', 'type', 'auditId', 'occurrenceId', 'state']);
      if (!event || event.version !== 1 || event.type !== 'HIGHLIGHT_STATE_CHANGED' || event.auditId !== auditModel?.auditId) return;
      if (event.state === 'active' && reportOccurrence(event.occurrenceId)) {
        activeHighlightOccurrenceId = event.occurrenceId;
        highlightAvailability.set(event.occurrenceId, { state: 'available' });
        reportReconnectAttempts = 0;
        refreshAllReportHighlightControls();
      } else if (event.state === 'clear' && event.occurrenceId === null) {
        activeHighlightOccurrenceId = null;
        reportReconnectAttempts = 0;
        for (const occurrenceId of highlightAvailability.keys()) {
          highlightAvailability.set(occurrenceId, { state: 'checking' });
        }
        refreshAllReportHighlightControls();
        void reportHighlightPolicy.recheckKnown();
      }
    });
    port.onDisconnect.addListener(() => {
      if (reportHighlightPort !== port) return;
      reportHighlightPort = null;
      for (const occurrenceId of highlightAvailability.keys()) {
        highlightAvailability.set(occurrenceId, { state: 'checking' });
      }
      refreshAllReportHighlightControls();
      announceReportHighlight('A conexão de destaque foi interrompida. Tentaremos restabelecê-la com limite de segurança.');
      scheduleReportHighlightReconnect();
    });
    port.postMessage({
      protocol: 'audita-report', version: 1, type: 'hello',
      auditId: auditModel.auditId, sessionCapabilityId: reportSessionCapabilityId,
    });
    void reportHighlightPolicy.recheckKnown();
  } catch {
    reportHighlightPort = null;
    scheduleReportHighlightReconnect();
  }
}

const deleteAuditController = createDestructiveDialog({
  dialog: deleteAuditDialog,
  cancelButton: deleteAuditCancel,
  confirmButton: deleteAuditConfirm,
  status,
  dialogStatus: deleteAuditDialogStatus,
  stableFocus: status,
  async onConfirm() {
    if (!auditModel?.auditId) return { ok: false, error: 'Auditoria não encontrada ou já excluída.' };
    const auditId = auditModel.auditId;
    const response = await sendAuthorizedRequest(sessionCapabilityId => ({
      type: 'REPORT_DELETE_AUDIT', sessionCapabilityId, auditId,
    }));
    if (response.ok === true) {
      renderDeletedAudit();
      if (response.status === 'pending') deleteAuditController.completeSuccess(
        'Os dados da auditoria já não estão disponíveis localmente. A limpeza de recursos permanece pendente e será retomada automaticamente. Os arquivos já baixados foram preservados.',
      );
    }
    return response;
  },
  successMessage: 'Auditoria local excluída. Downloads já salvos foram preservados.',
  failureMessage: 'Não foi possível excluir a auditoria local.',
});

deleteAudit.addEventListener('click', () => deleteAuditController.open(deleteAudit));

// The worker acknowledges the request before the files exist, and the export tab closes
// itself on failure without telling this page. Without a deadline the screen would keep
// saying "na fila de geração" forever, with no file, no error and no way forward, so the
// request is bounded and an unconfirmed outcome is reported as exactly that.
const EXPORT_CONFIRMATION_TIMEOUT_MS = 120_000;
let exportConfirmationTimer = null;

async function requestExport({ deleteAfterCompleteExport = false } = {}) {
  if (!auditModel?.auditId) return;
  const requestedAuditId = auditModel.auditId;
  regenerate.disabled = true;
  status.textContent = 'Solicitando a geração do relatório.';
  clearTimeout(exportConfirmationTimer);
  exportConfirmationTimer = setTimeout(() => {
    if (auditModel?.auditId !== requestedAuditId) return;
    regenerate.disabled = false;
    status.textContent = 'A geração dos arquivos não foi confirmada, então os arquivos não foram baixados. '
      + 'Tente novamente; se persistir, feche as abas de exportação abertas antes de repetir.';
  }, EXPORT_CONFIRMATION_TIMEOUT_MS);
  let response = null;
  try {
    response = await sendAuthorizedRequest(sessionCapabilityId => ({
      type: 'REPORT_REQUEST_EXPORT', sessionCapabilityId, auditId: requestedAuditId,
      deleteAfterCompleteExport: deleteAfterCompleteExport === true,
    }));
  } catch { /* the bounded notice above still reports the unconfirmed outcome */ }
  clearTimeout(exportConfirmationTimer);
  exportConfirmationTimer = null;
  regenerate.disabled = false;
  status.textContent = response?.ok ? 'Relatório atualizado na fila de geração.' : 'Não foi possível gerar o relatório atualizado.';
}

async function returnToAuditedPage() {
  if (reportSessionState !== 'result' || !auditModel?.auditId || !reportSessionCapabilityId) return;
  returnToPage.disabled = true;
  status.textContent = 'Retornando à página auditada e ao painel lateral.';
  const auditId = auditModel.auditId;
  const response = await sendAuthorizedRequest(sessionCapabilityId => ({
    type: 'REPORT_RETURN_TO_SOURCE', sessionCapabilityId, auditId,
  }));
  const returned = exactRecord(response, ['ok', 'state']);
  if (returned?.ok === true && returned.state === 'source-focused') {
    returnToPage.disabled = false;
    status.textContent = 'Página auditada e painel lateral abertos.';
    return;
  }
  returnToPage.disabled = false;
  status.textContent = 'Não foi possível retornar à página auditada. Ela pode ter sido fechada ou alterada.';
}

regenerate.addEventListener('click', () => { void requestExport({
  deleteAfterCompleteExport: document.querySelector('[data-report-delete-after-export]')?.checked === true,
}); });
returnToPage.addEventListener('click', () => { void returnToAuditedPage(); });

chrome.runtime.onMessage.addListener((message, sender) => {
  const deletion = parseAuditDeletedEvent(message, sender, {
    id: chrome.runtime.id,
    workerUrl: chrome.runtime.getURL('src/background/service-worker.js'),
  });
  if (deletion && (deletion.scope === 'all' || deletion.auditId === auditModel?.auditId)) {
    deleteAuditController.completeSuccess();
    renderDeletedAudit();
    return;
  }
  if (message?.type === 'AUDIT_DELETED') return;
});

function safeAuditId() {
  const value = new URL(location.href).searchParams.get('auditId');
  return normalizeReviewAuditId(value);
}


// Páginas muito grandes podem gerar milhares de revisões pendentes. Buscas lineares por cartão tornavam a
// abertura do relatório quadrática, e milhares de formulários deixavam a aba inutilizável. Os índices são
// calculados uma vez por modelo e a revisão guiada mostra um lote limitado de cartões por parte; o botão
// "Mostrar mais" carrega o lote seguinte.
const REVIEW_CARD_LIMIT = 40;
const MODEL_LOOKUPS = new WeakMap();
function modelLookups(model) {
  let lookups = MODEL_LOOKUPS.get(model);
  if (!lookups) {
    const evidence = Array.isArray(model?.evidence) ? model.evidence : [];
    const occurrenceCounts = new Map();
    const occurrenceById = new Map();
    for (const value of Array.isArray(model?.occurrences) ? model.occurrences : []) {
      const id = value?.occurrenceId;
      occurrenceCounts.set(id, (occurrenceCounts.get(id) ?? 0) + 1);
      if (!occurrenceById.has(id)) occurrenceById.set(id, value);
    }
    const itemById = new Map();
    for (const value of Array.isArray(model?.itemResults) ? model.itemResults : []) {
      if (!itemById.has(value?.id)) itemById.set(value?.id, value);
    }
    const evidencePositions = new Map();
    evidence.forEach((value, index) => {
      const positions = evidencePositions.get(value?.evidenceId) ?? [];
      positions.push(index);
      evidencePositions.set(value?.evidenceId, positions);
    });
    lookups = { evidence, occurrenceCounts, occurrenceById, itemById, evidencePositions };
    if (model && typeof model === 'object') MODEL_LOOKUPS.set(model, lookups);
  }
  return lookups;
}


function mountReportView(view) {
  const previousTarget = reportRoot.querySelector('[data-review-controls-target]');
  const focused = document.activeElement;
  const restoreFocus = focused && (list.contains(focused) || reviewControls.contains(focused));
  const report = renderReportView({
    view, document, onExport: options => { void requestExport(options); },
    onHighlightIntent: reportSessionState === 'result' ? value => {
      if (value?.type === 'GET_HIGHLIGHT_AVAILABILITY') void reportHighlightPolicy.requestExplicit(value.occurrenceId);
      else void handleReportHighlightIntent(value);
    } : null,
  });
  const reviewTarget = report.querySelector('[data-review-controls-target]');
  // A revisão guiada abre por padrão: é o caminho principal de quem não tem formação técnica.
  reviewTarget.open = previousTarget ? previousTarget.open === true : true;
  // Keep the actual forms: notes, pending buttons and their handlers are not rebuilt.
  reviewTarget.parentElement.insertBefore(reviewControls, reviewTarget);
  reviewTarget.append(list);
  reportRoot.replaceChildren(report);
  evidenceAnchorById = new Map(view.technicalEvidence.map((evidence, index) =>
    [evidence.evidenceId, `report-evidence-${index + 1}`]));
  reportViewLimitations = view.executive.limitations;
  applyReportSourceControls({
    reportSessionState, limitations: view.executive.limitations,
    returnControl: returnToPage, explanation: reportSourceExplanation,
  });
  refreshAllReportHighlightControls();
  if (restoreFocus) focused.focus({ preventScroll: true });
}

async function refreshCommittedReport(committed) {
  const basis = reportBasis;
  if (!basis || basis.auditId !== committed.model.auditId) return false;
  const summary = await buildCompleteReportSummary({
    model: committed.model, executionCheckpoint: basis.checkpoint, inventory: basis.inventory,
  });
  if (reportBasis !== basis || auditModel !== committed.model ||
    reportModelRevision !== committed.modelRevision || !reportSessionCapabilityId) return false;
  const view = buildReportView({ model: committed.model, summary,
    modelRevision: committed.modelRevision, modelHash: committed.modelHash });
  mountReportView(view);
  return true;
}

// Uma decisão por ocorrência, pelo canal autorizado. `final` marca a última gravação de uma
// resposta: só ela marca o cartão como respondido e leva ao próximo cartão pendente.
async function saveDecision(occurrence, answer, note, card, trigger, { revise = false, final = true } = {}) {
  if (!auditModel || !reportSessionCapabilityId) return false;
  const session = reportSessionCapabilityId;
  const evaluatorName = evaluator.value.trim();
  if (!evaluatorName) {
    status.textContent = 'Informe o nome da pessoa avaliadora antes de responder.';
    evaluator.focus();
    return false;
  }
  const decision = createReviewDecision({
    auditId: auditModel.auditId, itemId: occurrence.itemId, occurrenceId: occurrence.occurrenceId,
    answer, evaluator: evaluatorName, note, decidedAt: new Date().toISOString(), mode: occurrence.mode === 'manual' ? 'manual' : 'assisted',
  });
  const committed = await commitDecision({
    auditModel,
    input: decision,
    requestCommit: authorizedDecision => sendAuthorizedRequest(sessionCapabilityId => ({
      type: 'REPORT_COMMIT_REVIEW_DECISION', sessionCapabilityId,
      auditId: authorizedDecision.auditId, itemId: authorizedDecision.itemId,
      occurrenceId: authorizedDecision.occurrenceId, answer: authorizedDecision.answer,
      evaluator: authorizedDecision.evaluator, decidedAt: authorizedDecision.decidedAt,
      mode: authorizedDecision.mode, note: authorizedDecision.note ?? '',
      ...(revise ? { revise: true } : {}),
    })).then(response => { lastCommitFailureCode = response?.ok === true ? null : response?.code ?? null; return response; }),
    loadReportRevision: auditId => store.getReportRevision(auditId),
    controls: card.querySelectorAll('button'),
    retryFocus: trigger,
    onPendingChange(pending) {
      card.toggleAttribute('aria-busy', pending);
      if (pending) status.textContent = `Salvando decisão para o item ${occurrence.itemId}.`;
    },
  });
  if (committed.status === 'duplicate') return false;
  if (!auditModel || auditModel.auditId !== decision.auditId || reportSessionCapabilityId !== session) return false;
  card.removeAttribute('aria-busy');
  if (final) {
    card.classList.add('answered');
    nextUnanswered(card);
  }
  if (committed.modelRevision <= reportModelRevision) return true;
  auditModel = committed.model;
  reportModelRevision = committed.modelRevision;
  status.textContent = `Decisão salva para o item ${occurrence.itemId}. Atualizando o relatório.`;
  try {
    if (await refreshCommittedReport(committed)) {
      status.textContent = `Decisão salva para o item ${occurrence.itemId}. Relatório atualizado; filtros de visualização redefinidos.`;
    }
  } catch {
    if (auditModel === committed.model && reportSessionCapabilityId === session) {
      status.textContent = `Decisão salva para o item ${occurrence.itemId}, mas não foi possível atualizar a visualização. Reabra o relatório para consultar e imprimir a revisão atualizada.`;
    }
  }
  return true;
}

function nextUnanswered(card) {
  const key = typeof card?.getAttribute === 'function' ? card.getAttribute('data-lay-card') : null;
  if (key) { advanceFrom(key); return; }
  let next = card.nextElementSibling;
  while (next?.classList.contains('answered')) next = next.nextElementSibling;
  if (next) next.open = true;
  (next?.querySelector('summary') || document.querySelector('a[href="#report-root"]'))?.focus();
}

// Uma resposta grava todas as ocorrências que ela decide numa só gravação autorizada (antes era uma
// gravação completa do modelo por ocorrência, em sequência) e atualiza o relatório uma vez.
async function saveDecisionBatch(entries, card, trigger) {
  if (!auditModel || !reportSessionCapabilityId || !Array.isArray(entries) || entries.length === 0) return false;
  const session = reportSessionCapabilityId;
  const evaluatorName = evaluator.value.trim();
  if (!evaluatorName) {
    status.textContent = 'Informe o nome da pessoa avaliadora antes de responder.';
    evaluator.focus();
    return false;
  }
  const auditId = auditModel.auditId;
  const decidedAt = new Date().toISOString();
  const inputs = entries.map(({ occurrence, answer, note }) => ({
    auditId, itemId: occurrence.itemId, occurrenceId: occurrence.occurrenceId, answer, evaluator: evaluatorName,
    note, decidedAt, mode: occurrence.mode === 'manual' ? 'manual' : 'assisted',
  }));
  const reviseByOccurrence = new Map(entries.map(entry => [entry.occurrence.occurrenceId, entry.revise === true]));
  const items = [...new Set(entries.map(entry => entry.occurrence.itemId))].join(', ');
  const committed = await commitDecisionBatch({
    inputs,
    requestCommit: decisions => sendAuthorizedRequest(sessionCapabilityId => ({
      type: 'REPORT_COMMIT_REVIEW_BATCH', sessionCapabilityId, auditId, evaluator: evaluatorName, decidedAt,
      decisions: JSON.stringify(decisions.map(decision => ({
        itemId: decision.itemId, occurrenceId: decision.occurrenceId, answer: decision.answer,
        mode: decision.mode, note: decision.note ?? '', revise: reviseByOccurrence.get(decision.occurrenceId) === true,
      }))),
    })).then(response => { lastCommitFailureCode = response?.ok === true ? null : response?.code ?? null; return response; }),
    loadReportRevision: id => store.getReportRevision(id),
    controls: card.querySelectorAll('button'),
    retryFocus: trigger,
    onPendingChange(pending) {
      card.toggleAttribute('aria-busy', pending);
      if (pending) status.textContent = `Salvando a resposta (item ${items}).`;
    },
  });
  if (committed.status === 'duplicate') return false;
  if (!auditModel || auditModel.auditId !== auditId || reportSessionCapabilityId !== session) return false;
  card.removeAttribute('aria-busy');
  if (committed.modelRevision <= reportModelRevision) return true;
  auditModel = committed.model;
  reportModelRevision = committed.modelRevision;
  status.textContent = `Decisão salva para o item ${items}. Atualizando o relatório.`;
  try {
    await refreshCommittedReport(committed);
  } catch {
    if (auditModel === committed.model && reportSessionCapabilityId === session) {
      status.textContent = `Decisão salva para o item ${items}, mas não foi possível atualizar a visualização. Reabra o relatório para consultar e imprimir a revisão atualizada.`;
    }
  }
  return true;
}


// ---------------------------------------------------------------------------------------------
// Revisão guiada (linguagem simples). A pessoa responde sobre o que vê; cada resposta grava, pelo
// mesmo canal autorizado de antes, uma decisão canônica por ocorrência. Os cartões são atualizados
// um a um, para que notas ainda não salvas em outros cartões nunca se percam.
// ---------------------------------------------------------------------------------------------

const layState = {
  cardNodes: new Map(),
  openCards: new Set(),
  revising: new Set(),
  imagePurpose: new Map(),
  imageFollowUps: new Map(),
  visible: { requirement: REVIEW_CARD_LIMIT, recommendation: REVIEW_CARD_LIMIT },
  showRecommendations: true,
  activeAids: new Set(),
  header: null,
  aidBar: null,
};

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function button(text, className, onClick) {
  const node = el('button', text, className);
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
}

function cardDomId(key) {
  return `lay-card-${key.replace(/[^A-Za-z0-9_-]/gu, '-')}`;
}

function capitalized(value) {
  return value ? `${value.charAt(0).toLocaleUpperCase('pt-BR')}${value.slice(1)}` : value;
}

function questionAnswered(question) {
  return question.entries.every(value => value.decision);
}

function cardTitle(card) {
  if (card.elementLevel) return capitalized(card.element?.label ?? 'Elemento da página');
  const question = card.questions[0];
  return question ? question.item.title : 'Pergunta sobre a página';
}

function evaluatorNameOrWarn() {
  const name = evaluator.value.trim();
  if (!name) {
    status.textContent = 'Antes de responder, informe o nome da pessoa avaliadora no campo acima.';
    evaluator.focus();
    return null;
  }
  if ([...name].length > 160) {
    status.textContent = 'O nome da pessoa avaliadora pode ter no máximo 160 caracteres.';
    evaluator.focus();
    return null;
  }
  return name;
}

function noteProblem(note, required) {
  const text = typeof note === 'string' ? note.trim() : '';
  if (required && !text) return 'Descreva o que você constatou antes de registrar “não atende”. Essa frase vai para o quadro de constatações.';
  if ([...text].length > 4000) return 'A descrição pode ter no máximo 4.000 caracteres.';
  return null;
}

// Grava várias respostas (as ocorrências de uma pergunta, ou todas as perguntas de uma imagem) em
// sequência. Cada uma passa pela autorização do relatório; uma falha interrompe e é anunciada.
async function commitAnswers(card, plan, trigger) {
  if (!auditModel || !reportSessionCapabilityId) return false;
  if (!evaluatorNameOrWarn()) return false;
  const node = layState.cardNodes.get(card.key);
  if (!node) return false;
  const entries = [];
  for (const { target, answer, note, itemId } of plan) {
    const text = typeof note === 'string' ? note.trim() : '';
    // Uma ocorrência já decidida só é regravada quando a pessoa pediu "Rever resposta"; uma nova
    // tentativa depois de falha parcial não cria revisão falsa da resposta que já estava salva.
    const revising = layState.revising.has(`${card.key}|${itemId ?? target.entry.itemId}`);
    if (target.decision && (!revising || (target.decision.answer === answer && (target.decision.note ?? '') === text))) continue;
    if (entries.some(entry => entry.occurrence.occurrenceId === target.occurrence.occurrenceId)) continue;
    entries.push({ occurrence: target.occurrence, answer, note: text, revise: Boolean(target.decision) });
  }
  // Quando esta resposta completa o cartão, a revisão já segue para o próximo enquanto a gravação
  // termina: em páginas grandes a gravação leva alguns segundos e a pessoa não precisa esperar. O
  // cartão fica marcado como "salvando" e, se a gravação falhar, volta aberto com o aviso.
  const decidedNow = new Set(entries.map(entry => entry.occurrence.occurrenceId));
  const completes = entries.length > 0 && card.questions.every(question => question.entries.every(value =>
    value.decision || decidedNow.has(value.occurrence.occurrenceId)));
  if (completes) {
    node.open = false;
    node.setAttribute('data-lay-saving', '');
    layState.openCards.delete(card.key);
    advanceFrom(card.key);
  }
  let saved = 0;
  // Lotes de até 64 decisões (limite do envelope); na prática uma resposta decide poucas ocorrências.
  for (let start = 0; start < entries.length; start += 64) {
    try {
      if (await saveDecisionBatch(entries.slice(start, start + 64), node, trigger)) saved += Math.min(64, entries.length - start);
    } catch (error) {
      node.removeAttribute('aria-busy');
      status.textContent = describeSaveFailure(error);
      const failed = refreshLayCard(card.key);
      if (completes && failed) { failed.open = true; layState.openCards.add(card.key); }
      return false;
    }
    if (!auditModel) return false;
  }
  for (const key of [...layState.revising]) if (key.startsWith(`${card.key}|`)) layState.revising.delete(key);
  const fresh = refreshLayCard(card.key);
  status.textContent = saved > 0
    ? 'Resposta salva. O relatório e o quadro de constatações foram atualizados.'
    : 'Nada a salvar: essa resposta já estava registrada.';
  if (completes) {
    if (fresh) fresh.open = false;
  } else if (fresh?.classList.contains('answered')) {
    layState.openCards.delete(card.key);
    fresh.open = false;
    advanceFrom(card.key);
  } else if (fresh) {
    // Ainda há perguntas neste cartão: o foco vai para a próxima sem resposta.
    fresh.open = true;
    fresh.querySelector('.lay-answer-form button, .lay-image-classifier button')?.focus();
  }
  return true;
}

function describeSaveFailure(error) {
  const message = typeof error?.message === 'string' ? error.message : '';
  if (/mudou repetidamente/u.test(message)) return 'A auditoria mudou durante o salvamento. Tente responder de novo.';
  if (/não foi autorizada/u.test(message)) {
    // A autorização é renovada sozinha; esta mensagem só aparece quando nem a renovação foi aceita.
    if (lastCommitFailureCode === 'REPORT_OPERATION_FAILED') return 'A resposta não foi gravada: o armazenamento local recusou a gravação. Tente de novo em alguns segundos.';
    if (lastCommitFailureCode === null || lastCommitFailureCode === undefined) return 'A resposta não chegou à extensão. Tente de novo em alguns segundos.';
    return 'A resposta não foi aceita: não foi possível renovar a autorização deste relatório. Reabra o relatório pelo painel e tente de novo.';
  }
  return 'Não foi possível salvar a resposta. Confira o nome da pessoa avaliadora e o tamanho da descrição e tente de novo.';
}

async function requestPageAid(aid) {
  if (reportSessionState !== 'result' || !auditModel?.auditId || !reportSessionCapabilityId) {
    status.textContent = 'As ajudas na página só funcionam enquanto a página auditada continua aberta na aba original.';
    return;
  }
  const auditId = auditModel.auditId;
  const response = await sendAuthorizedRequest(sessionCapabilityId => ({
    type: 'REPORT_PAGE_AID', sessionCapabilityId, auditId, aid,
  }));
  if (response?.ok === true) {
    if (aid === 'reset') layState.activeAids.clear(); else layState.activeAids.add(aid);
    updateAidBar();
    status.textContent = aid === 'reset'
      ? 'A página auditada voltou ao normal.'
      : `Aplicado na página auditada: ${PAGE_AID_DESCRIPTIONS[aid]}${response.zoomPercent ? ` (zoom de ${response.zoomPercent}%)` : ''}. Observe a página e volte a esta aba para responder.`;
    return;
  }
  status.textContent = 'Não foi possível aplicar a ajuda na página auditada. Ela pode ter sido fechada, recarregada ou alterada.';
}

function updateAidBar() {
  const bar = layState.aidBar;
  if (!bar) return;
  bar.replaceChildren();
  bar.hidden = layState.activeAids.size === 0;
  if (!layState.activeAids.size) return;
  const active = [...layState.activeAids].map(value => PAGE_AID_DESCRIPTIONS[value]).join(' e ');
  bar.append(el('p', `Ajuda ativa na página auditada: ${active}. Lembre-se de registrar na descrição que a verificação usou essa ajuda.`));
  bar.append(button('Voltar a página ao normal', 'lay-aid-reset', () => { void requestPageAid('reset'); }));
}

function aidControls(aid) {
  if (!aid) return null;
  const wrap = el('div', undefined, 'lay-aids');
  if (aid === 'tab' || aid === 'grayscale') {
    wrap.append(el('p', aid === 'tab'
      ? 'Ajuda: vá para a página auditada, clique numa área vazia e use a tecla Tab. No painel lateral, “Conferir leitura por Tab” mostra a sequência com explicações.'
      : 'Ajuda: no painel lateral, “Acromatopsia” mostra a página em tons de cinza, para ver o que depende só da cor.'));
    wrap.append(button('Ir para a página auditada', 'lay-aid', () => { void returnToAuditedPage(); }));
    return wrap;
  }
  const pageAid = PAGE_AIDS[aid];
  if (!pageAid) return null;
  wrap.append(button(aidLabel(aid), 'lay-aid', () => { void requestPageAid(pageAid); }));
  wrap.append(button('Voltar ao normal', 'lay-aid-reset', () => { void requestPageAid('reset'); }));
  return wrap;
}

function highlightableOccurrence(card) {
  const entries = card.questions.flatMap(question => question.entries);
  const usable = entries.find(value => !value.decision && reportOccurrence(value.occurrence.occurrenceId)) ??
    entries.find(value => value.decision?.answer === 'não conforme' && reportOccurrence(value.occurrence.occurrenceId));
  return usable?.occurrence.occurrenceId ?? null;
}

async function showOnPage(card, trigger) {
  const occurrenceId = highlightableOccurrence(card);
  if (!occurrenceId) {
    status.textContent = 'O destaque ao vivo vale para perguntas pendentes ou respondidas com “Não”. Use a captura registrada no cartão.';
    return;
  }
  if (reportSessionState !== 'result') {
    status.textContent = 'A página auditada mudou ou foi fechada, então o destaque ao vivo não está mais disponível. Use a captura registrada no cartão.';
    return;
  }
  trigger.disabled = true;
  try {
    const available = await handleReportHighlightIntent({ type: 'GET_HIGHLIGHT_AVAILABILITY', occurrenceId }, { announce: false });
    if (!available || highlightAvailability.get(occurrenceId)?.state !== 'available') {
      const reason = highlightAvailability.get(occurrenceId)?.reason;
      status.textContent = reason === 'no-binding'
        ? 'Este elemento não tem localização registrada para destaque nesta auditoria. Use a captura registrada no cartão.'
        : 'Não é possível destacar este elemento agora (a página auditada pode ter mudado). Use a captura registrada no cartão.';
      return;
    }
    if (await handleReportHighlightIntent({ type: 'HIGHLIGHT_OCCURRENCE', occurrenceId }, { announce: false })) {
      status.textContent = 'O elemento está destacado na página auditada. Volte a esta aba para responder.';
    }
  } finally { trigger.disabled = false; }
}

function objectBlock(card) {
  const block = el('div', undefined, 'lay-object');
  const evidence = card.evidence;
  if (evidence && isSafeEvidenceImageUrl(evidence.dataUrl, chrome.runtime.getURL('/'))) {
    const image = document.createElement('img');
    image.className = 'lay-thumb';
    image.src = evidence.dataUrl;
    image.alt = `Captura do elemento: ${card.element?.label ?? 'elemento da página'}`;
    block.append(image);
  }
  const facts = document.createElement('dl');
  const fact = (label, value) => { facts.append(el('dt', label), el('dd', value)); };
  if (card.elementLevel) {
    fact('O que é', capitalized(card.element?.roleWord ?? 'elemento'));
    fact('Nome lido pela extensão', card.element?.name ? `“${card.element.name}”` : 'nenhum (o leitor de tela não teria o que anunciar)');
    if (card.element?.visibleText && card.element.visibleText !== card.element.name) fact('Texto visível', `“${card.element.visibleText}”`);
    if (card.imageCard) {
      const alt = card.element?.altAttribute;
      fact('Texto alternativo', alt === null ? 'ausente' : alt === '' ? 'vazio (marcada como enfeite)' : alt ? `“${alt}”` : 'não informado');
    }
  } else {
    fact('Onde olhar', 'Na página auditada como um todo.');
  }
  block.append(facts);
  if (card.elementLevel && reportSessionState === 'result' && highlightableOccurrence(card)) {
    const show = button('Mostrar na página', 'lay-show', event => { void showOnPage(card, event.currentTarget); });
    block.append(show);
  }
  return block;
}

function answeredLine(question, card) {
  const decisions = question.entries.map(value => value.decision).filter(Boolean);
  const latest = [...decisions].sort((a, b) => a.decidedAt.localeCompare(b.decidedAt)).at(-1);
  const wrap = el('div', undefined, 'lay-answered');
  wrap.setAttribute('data-lay-answer', latest.answer);
  const revisions = latest.revisions?.length ? ` · revista ${latest.revisions.length} ${latest.revisions.length === 1 ? 'vez' : 'vezes'}` : '';
  wrap.append(el('p', `Resposta registrada: ${ANSWER_LABELS[latest.answer]} — ${latest.evaluator}, ${formatLocalInstant(latest.decidedAt, auditModel.timezone)}${revisions}.`));
  if (latest.note) wrap.append(el('p', `Descrição: ${latest.note}`, 'lay-answered-note'));
  wrap.append(button('Rever resposta', 'lay-revise', () => {
    layState.revising.add(`${card.key}|${question.itemId}`);
    refreshLayCard(card.key);
  }));
  return wrap;
}

function answerForm(card, question) {
  const form = el('div', undefined, 'lay-answer-form');
  const answers = el('div', undefined, 'lay-answers');
  const finding = el('div', undefined, 'lay-finding');
  finding.hidden = true;
  const findingLabel = el('label', 'O que você constatou (obrigatório para “Não”). Esta frase vai para o quadro de constatações; ajuste o rascunho ao que você viu.');
  const findingText = document.createElement('textarea');
  findingText.rows = 4;
  findingText.maxLength = 4000;
  findingText.value = draftFinding({ itemId: question.itemId, element: card.element, hint: question.hints[0], aids: [...layState.activeAids] });
  findingLabel.append(findingText);
  const noteBox = document.createElement('details');
  noteBox.className = 'lay-note';
  noteBox.append(el('summary', 'Acrescentar observação (opcional)'));
  const note = document.createElement('textarea');
  note.rows = 2;
  note.maxLength = 4000;
  note.setAttribute('aria-label', `Observação opcional sobre o item ${question.itemId}`);
  noteBox.append(note);
  const targets = () => question.entries;
  const submit = async (answer, text, trigger, required = false) => {
    const problem = noteProblem(text, required);
    if (problem) { status.textContent = problem; (required ? findingText : note).focus(); return; }
    await commitAnswers(card, targets().map(target => ({ target, answer, note: text, itemId: question.itemId })), trigger);
  };
  for (const option of LAY_ANSWERS) {
    // Em cartões de elemento, "não existe nesta página" seria estranho: o elemento existe, o item é que não se aplica.
    const label = option.answer === 'não se aplica' && card.elementLevel ? 'Não se aplica a este elemento' : option.label;
    const choice = button(label, `lay-answer lay-answer--${option.answer.replace(/\s+/gu, '-')}`, event => {
      if (option.answer === 'não conforme') {
        finding.hidden = false;
        findingText.focus();
        return;
      }
      void submit(option.answer, note.value, event.currentTarget);
    });
    choice.setAttribute('data-lay-answer', option.answer);
    choice.title = option.meaning;
    answers.append(choice);
  }
  answers.append(button('Pular revisão por enquanto', 'lay-skip', () => {
    status.textContent = 'Pergunta pulada; ela continua sem conclusão e pode ser respondida depois.';
    advanceFrom(card.key);
  }));
  const confirm = button('Registrar “não atende”', 'lay-confirm-fail', event => {
    void submit('não conforme', findingText.value, event.currentTarget, true);
  });
  const cancel = button('Cancelar', 'lay-cancel', () => { finding.hidden = true; });
  const findingActions = el('div', undefined, 'lay-finding-actions');
  findingActions.append(confirm, cancel);
  finding.append(findingLabel, findingActions);
  form.append(answers, finding, noteBox);
  return form;
}

function questionBlock(card, question) {
  const item = question.item;
  const node = el('li', undefined, 'lay-question');
  node.setAttribute('data-lay-question', question.itemId);
  node.append(el('p', question.guide?.question ?? `A página atende a “${item.title}”?`, 'lay-q'));
  const meta = `ABNT NBR 17225 — item ${item.id} · ${CLASSIFICATION_WORDS[item.classification] ?? 'item'} · ${item.title}`;
  node.append(el('p', meta, 'lay-meta'));
  if (typeof item.printedId === 'string' && item.printedId !== item.id) {
    node.append(el('p', `Nota editorial: a impressão consultada mostra “${item.printedId}”; esta ferramenta usa a referência normalizada “${item.id}” da Seção 5.`, 'lay-meta'));
  }
  for (const hint of question.hints) node.append(el('p', `Pista da extensão: ${hint}`, 'lay-hint'));
  if (question.alreadyFailed) node.append(el('p', 'A verificação automática já registrou falha neste elemento para este item. Sua resposta confirma ou não a suspeita do outro motor.', 'lay-hint'));
  const how = document.createElement('details');
  how.className = 'lay-how';
  how.append(el('summary', 'Como verificar'));
  const steps = document.createElement('ol');
  for (const step of question.guide?.steps ?? []) steps.append(el('li', step));
  how.append(steps);
  const aids = aidControls(question.guide?.aid);
  if (aids) how.append(aids);
  if (question.guide?.technical) how.append(el('p', 'Este item depende de exame do código. Sem apoio técnico, “Não consegui verificar” é a resposta honesta; ela não aprova nem reprova.', 'lay-hint'));
  node.append(how);
  for (const term of question.guide?.terms ?? []) {
    if (GLOSSARY[term]) {
      const p = el('p', undefined, 'lay-term');
      p.append(el('dfn', term), document.createTextNode(`: ${GLOSSARY[term]}`));
      node.append(p);
    }
  }
  const revising = layState.revising.has(`${card.key}|${question.itemId}`);
  if (questionAnswered(question) && !revising) node.append(answeredLine(question, card));
  else {
    if (revising) node.append(el('p', 'Revendo a resposta. A anterior continua registrada no histórico.', 'lay-hint'));
    node.append(answerForm(card, question));
  }
  return node;
}

function imageClassifier(card) {
  const section = el('section', undefined, 'lay-image-classifier');
  section.append(el('p', 'Para que serve esta imagem?', 'lay-q'));
  section.append(el('p', 'Uma resposta aqui resolve os itens 5.2.1 a 5.2.6 desta imagem. Se preferir, responda item por item mais abaixo.', 'lay-meta'));
  const options = el('div', undefined, 'lay-purposes');
  options.setAttribute('role', 'group');
  options.setAttribute('aria-label', 'Finalidade da imagem');
  const chosen = layState.imagePurpose.get(card.key) ?? null;
  for (const purpose of IMAGE_PURPOSES) {
    const choice = button(purpose.label, 'lay-purpose', () => {
      layState.imagePurpose.set(card.key, purpose.id);
      layState.imageFollowUps.set(card.key, new Map());
      refreshLayCard(card.key);
      layState.cardNodes.get(card.key)?.querySelector('.lay-image-plan')?.focus();
    });
    choice.setAttribute('aria-pressed', String(chosen === purpose.id));
    choice.append(el('small', `Ex.: ${purpose.example}`));
    options.append(choice);
  }
  section.append(options);
  if (!chosen) return section;
  const plan = imagePlan({ purpose: chosen, element: card.element });
  const followUps = layState.imageFollowUps.get(card.key) ?? new Map();
  const box = el('div', undefined, 'lay-image-plan');
  box.tabIndex = -1;
  box.append(el('p', 'Com essa resposta, a extensão conclui:', 'lay-meta'));
  const list = document.createElement('ul');
  const questionsById = new Map(card.questions.map(question => [question.itemId, question]));
  const failing = [];
  let complete = true;
  for (const [itemId, step] of Object.entries(plan)) {
    const question = questionsById.get(itemId);
    if (!question) continue;
    const row = el('li');
    const label = `${itemId} ${question.item.title}`;
    if (step.answer) {
      row.append(el('span', `${label}: ${ANSWER_LABELS[step.answer]} — ${step.reason}.`));
      if (step.answer === 'não conforme') failing.push({ itemId, reason: step.reason });
    } else {
      const answer = followUps.get(itemId) ?? null;
      row.append(el('span', `${label}: ${step.followUp}`));
      for (const [label, value] of [['Sim', 'conforme'], ['Não', 'não conforme'], ['Não sei', 'não foi possível determinar']]) {
        const choice = button(label, 'lay-answer', () => {
          followUps.set(itemId, value); layState.imageFollowUps.set(card.key, followUps); refreshLayCard(card.key);
        });
        choice.setAttribute('aria-pressed', String(answer === value));
        row.append(choice);
      }
      if (!answer) complete = false;
      if (answer === 'não conforme') failing.push({ itemId, reason: `a resposta à pergunta “${step.followUp}” foi “não”` });
    }
    list.append(row);
  }
  box.append(list);
  const findingLabel = el('label', 'Descrição da constatação (usada nos itens que não atendem; ajuste ao que você viu):');
  const findingText = document.createElement('textarea');
  findingText.rows = 3;
  findingText.maxLength = 4000;
  findingText.value = failing.map(value => imageFindingText({
    itemId: value.itemId, element: card.element, reason: value.reason, withItem: failing.length > 1,
  })).join(' ');
  findingLabel.append(findingText);
  if (failing.length) box.append(findingLabel);
  const purposeLabel = IMAGE_PURPOSES.find(value => value.id === chosen)?.label ?? chosen;
  const save = button('Registrar as respostas desta imagem', 'lay-confirm', async event => {
    if (!complete) { status.textContent = 'Responda às perguntas de acompanhamento antes de registrar.'; return; }
    const problem = failing.length ? noteProblem(findingText.value, true) : null;
    if (problem) { status.textContent = problem; findingText.focus(); return; }
    const entries = [];
    for (const [itemId, step] of Object.entries(plan)) {
      const question = questionsById.get(itemId);
      if (!question) continue;
      const answer = step.answer ?? followUps.get(itemId);
      const note = answer === 'não conforme' ? findingText.value
        : answer === 'não se aplica' ? `Finalidade informada: ${purposeLabel}. Não se aplica porque ${step.reason}.`
          : answer === 'não foi possível determinar' ? `Finalidade informada: ${purposeLabel}. Sem conclusão: “${step.followUp}” — a pessoa avaliadora não soube responder.`
            : `Finalidade informada: ${purposeLabel}.${step.reason ? ` ${capitalized(step.reason)}.` : ''}`;
      for (const target of question.entries) entries.push({ target, answer, note, itemId });
    }
    await commitAnswers(card, entries, event.currentTarget);
  });
  box.append(save);
  section.append(box);
  return section;
}

function renderCardNode(card) {
  const node = document.createElement('details');
  node.className = 'lay-card';
  node.id = cardDomId(card.key);
  node.setAttribute('data-lay-card', card.key);
  node.setAttribute('data-lay-group', card.groupId);
  node.classList.toggle('answered', card.answered);
  node.open = layState.openCards.has(card.key);
  node.addEventListener('toggle', () => {
    if (node.open) layState.openCards.add(card.key); else layState.openCards.delete(card.key);
  });
  const summary = el('summary');
  summary.append(el('span', cardTitle(card), 'lay-card-title'));
  const pending = card.questions.filter(question => !questionAnswered(question)).length;
  summary.append(el('span', pending === 0 ? 'respondido' : `${pending} ${pending === 1 ? 'pergunta' : 'perguntas'}`, `lay-badge${pending === 0 ? ' lay-badge--done' : ''}`));
  if (!card.requirement) summary.append(el('span', 'recomendação', 'lay-badge lay-badge--rec'));
  node.append(summary);
  node.append(objectBlock(card));
  const allPending = card.questions.every(question => question.entries.every(value => !value.decision));
  if (card.imageCard && allPending && card.questions.some(question => question.itemId.startsWith('5.2.'))) {
    node.append(imageClassifier(card));
    const byItem = document.createElement('details');
    byItem.className = 'lay-by-item';
    byItem.append(el('summary', 'Responder os itens de imagem um por um'));
    const imageList = el('ol', undefined, 'lay-questions');
    const others = el('ol', undefined, 'lay-questions');
    for (const question of card.questions) {
      (question.itemId.startsWith('5.2.') ? imageList : others).append(questionBlock(card, question));
    }
    byItem.append(imageList);
    node.append(byItem);
    if (others.childElementCount) node.append(others);
  } else {
    const list = el('ol', undefined, 'lay-questions');
    for (const question of card.questions) list.append(questionBlock(card, question));
    node.append(list);
  }
  return node;
}

function currentPlan() {
  return auditModel ? buildLayReviewPlan(auditModel) : [];
}

function renderProgress(plan) {
  const header = layState.header;
  if (!header) return;
  const progress = layReviewProgress(plan);
  const box = header.querySelector('[data-lay-progress]');
  box.replaceChildren();
  for (const [kind, label] of [['requirement', 'Requisitos (obrigatórios)'], ['recommendation', 'Recomendações (opcionais)']]) {
    const value = progress[kind];
    if (!value.total) continue;
    const line = el('p', `${label}: ${value.answered} de ${value.total} perguntas respondidas`);
    const meter = document.createElement('progress');
    meter.max = value.total;
    meter.value = value.answered;
    meter.setAttribute('aria-label', label);
    box.append(line, meter);
  }
}

function advanceFrom(key) {
  const nodes = [...list.querySelectorAll('details.lay-card')];
  const index = nodes.findIndex(node => node.getAttribute('data-lay-card') === key);
  const next = nodes.slice(index + 1).find(node => !node.classList.contains('answered') && !node.closest('[hidden]'));
  if (next) {
    next.open = true;
    layState.openCards.add(next.getAttribute('data-lay-card'));
    next.querySelector('summary')?.focus();
  } else {
    document.querySelector('a[href="#report-root"]')?.focus();
  }
}

function refreshLayCard(key) {
  const plan = currentPlan();
  renderProgress(plan);
  const card = plan.find(value => value.key === key);
  const old = layState.cardNodes.get(key);
  if (!card || !old) return;
  const fresh = renderCardNode(card);
  old.replaceWith(fresh);
  layState.cardNodes.set(key, fresh);
  updateGroupCounts(plan);
  return fresh;
}

function updateGroupCounts(plan) {
  for (const counter of list.querySelectorAll('[data-lay-group-count]')) {
    const [part, groupId] = counter.getAttribute('data-lay-group-count').split(':');
    const cards = plan.filter(card => (card.requirement ? 'requirement' : 'recommendation') === part && card.groupId === groupId);
    const pending = cards.filter(card => !card.answered).length;
    counter.textContent = pending ? `${pending} de ${cards.length} pendentes` : 'tudo respondido';
  }
}

function renderPart(plan, part) {
  const cards = plan.filter(card => (card.requirement ? 'requirement' : 'recommendation') === part);
  const container = el('section', undefined, `lay-part lay-part--${part}`);
  container.setAttribute('data-lay-part', part);
  if (!cards.length) return null;
  container.append(el('h3', part === 'requirement'
    ? 'Parte 1 — Requisitos (obrigatórios para a conformidade regular)'
    : 'Parte 2 — Recomendações (opcionais; contam para a conformidade plena)'));
  const limit = layState.visible[part];
  let shown = 0;
  for (const group of LAY_GROUPS) {
    const groupCards = cards.filter(card => card.groupId === group.id);
    if (!groupCards.length) continue;
    const groupNode = el('section', undefined, 'lay-group');
    groupNode.id = `lay-${part}-${group.id}`;
    const heading = el('h4', group.label);
    const counter = el('span', '', 'lay-group-count');
    counter.setAttribute('data-lay-group-count', `${part}:${group.id}`);
    heading.append(document.createTextNode(' '), counter);
    groupNode.append(heading, el('p', group.description, 'lay-meta'));
    for (const card of groupCards) {
      if (shown >= limit) break;
      const node = renderCardNode(card);
      layState.cardNodes.set(card.key, node);
      groupNode.append(node);
      shown += 1;
    }
    if (groupNode.querySelector('details.lay-card')) container.append(groupNode);
    if (shown >= limit) break;
  }
  if (cards.length > shown) {
    const more = button(`Mostrar mais ${Math.min(REVIEW_CARD_LIMIT, cards.length - shown)} de ${cards.length - shown} cartões restantes`, 'lay-more', () => {
      layState.visible[part] += REVIEW_CARD_LIMIT;
      renderLayReview();
    });
    more.setAttribute('data-review-omitted', String(cards.length - shown));
    container.append(more);
  }
  return container;
}

function renderLayHeader() {
  const header = el('section', undefined, 'lay-header');
  header.append(el('h3', 'Revisão guiada, em linguagem simples'));
  header.append(el('p', 'A extensão só conclui sozinha o que consegue medir. O restante depende do seu olhar. Aqui as perguntas são sobre o que você vê na página; suas respostas são traduzidas para os itens da ABNT NBR 17225:2025 e alimentam o quadro de constatações.'));
  const howto = el('ol', undefined, 'lay-howto');
  for (const step of [
    'Informe seu nome no campo “Nome da pessoa avaliadora”, acima.',
    'Comece pela Parte 1 (requisitos). Abra um cartão, leia a pergunta e use “Mostrar na página” para ver o elemento destacado.',
    'Responda “Sim”, “Não”, “Não consegui verificar” ou “Não existe nesta página” (nos elementos, “Não se aplica a este elemento”). Na dúvida, “Não consegui verificar”: ela não aprova nem reprova.',
    'Ao responder “Não”, descreva o que constatou. A frase vai para o quadro de constatações, pronta para citar.',
    'Errou? Use “Rever resposta”. A resposta anterior fica guardada no histórico.',
  ]) howto.append(el('li', step));
  header.append(howto);
  const progress = el('div', undefined, 'lay-progress');
  progress.setAttribute('data-lay-progress', '');
  header.append(progress);
  const toggleLabel = el('label', undefined, 'lay-toggle');
  const toggle = document.createElement('input');
  toggle.type = 'checkbox';
  toggle.checked = layState.showRecommendations;
  toggle.addEventListener('change', () => {
    layState.showRecommendations = toggle.checked;
    const part = list.querySelector('[data-lay-part="recommendation"]');
    if (part) part.hidden = !toggle.checked;
  });
  toggleLabel.append(toggle, document.createTextNode(' Mostrar também as recomendações (opcionais)'));
  header.append(toggleLabel);
  const glossary = document.createElement('details');
  glossary.className = 'lay-glossary';
  glossary.append(el('summary', 'Glossário: o que significam os termos'));
  const terms = document.createElement('dl');
  for (const [term, definition] of Object.entries(GLOSSARY)) terms.append(el('dt', capitalized(term)), el('dd', definition));
  glossary.append(terms);
  header.append(glossary);
  const aidBar = el('div', undefined, 'lay-aid-bar');
  aidBar.setAttribute('role', 'status');
  aidBar.hidden = true;
  layState.aidBar = aidBar;
  header.append(aidBar);
  layState.header = header;
  return header;
}

function renderLayReview() {
  layState.cardNodes.clear();
  const plan = currentPlan();
  list.replaceChildren();
  if (!plan.length) {
    list.append(el('p', 'Não há perguntas de revisão humana nesta auditoria.'));
    return;
  }
  list.append(renderLayHeader());
  for (const part of ['requirement', 'recommendation']) {
    const node = renderPart(plan, part);
    if (!node) continue;
    if (part === 'recommendation') node.hidden = !layState.showRecommendations;
    list.append(node);
  }
  renderProgress(plan);
  updateGroupCounts(plan);
  updateAidBar();
}

async function start() {
  const id = safeAuditId();
  if (!id) { status.textContent = 'Auditoria não identificada.'; return; }
  const connected = await sendWorkerRequest({ type: 'REPORT_CONNECT', auditId: id });
  const connection = exactRecord(connected, ['ok', 'auditId', 'sessionCapabilityId', 'state']);
  if (connection?.ok !== true || connection.auditId !== id ||
    !/^[A-Za-z0-9_-]{22}$/u.test(connection.sessionCapabilityId ?? '') ||
    !['result', 'view-only'].includes(connection.state)) { status.textContent = 'Relatório não autorizado.'; return; }
  reportSessionCapabilityId = connected.sessionCapabilityId;
  reportSessionState = connected.state;
  reportRenewedAt = Date.now();
  const [revision, inventory] = await Promise.all([store.getReportRevision(id), createInstalledCoreRuleInventory()]);
  if (!revision || revision.auditId !== id) { status.textContent = 'Auditoria não encontrada.'; return; }
  const summary = await buildCompleteReportSummary({
    model: revision.model, executionCheckpoint: revision.checkpoint, inventory,
  });
  const view = buildReportView({ model: revision.model, summary, modelRevision: revision.modelRevision, modelHash: revision.modelHash });
  auditModel = revision.model;
  reportModelRevision = revision.modelRevision;
  reportBasis = { auditId: id, checkpoint: revision.checkpoint, inventory };
  mountReportView(view);
  deleteAudit.disabled = false;
  if (reportSessionState === 'result') {
    connectReportHighlightState();
  }
  renderLayReview();
  const latest = await store.getLatest();
  status.textContent = latest?.auditId === id && latest?.exportCleanupPending === true ? EXPORT_CLEANUP_MESSAGE
    : reportStatusLine(summary);
}

// The stored counts distinguish checks from occurrences: one requirement can fail on several
// elements. Naming the occurrence total "falhas" made the summary look inconsistent with the
// panel and with the summary cards, which show both numbers, so the line names what it counts
// and keeps the two totals apart.
function reportStatusLine(summary) {
  const counts = summary?.counts ?? {};
  const number = value => (Number.isSafeInteger(value) ? value : 0);
  const failures = `${number(counts.errors?.checkKeys)} ${number(counts.errors?.checkKeys) === 1 ? 'verificação' : 'verificações'} com falha confirmada (${number(counts.errors?.occurrences)} ${number(counts.errors?.occurrences) === 1 ? 'ocorrência' : 'ocorrências'})`;
  const suspects = `${number(counts.humanReview?.checkKeys)} ${number(counts.humanReview?.checkKeys) === 1 ? 'verificação' : 'verificações'} sob revisão humana (${number(counts.humanReview?.occurrences)} ${number(counts.humanReview?.occurrences) === 1 ? 'ocorrência' : 'ocorrências'})`;
  const checklist = number(summary?.checklist?.length);
  return `${failures}; ${suspects}. Checklist separado: ${checklist} ${checklist === 1 ? 'verificação ainda sem conclusão' : 'verificações ainda sem conclusão'}.`;
}

void start().catch(() => { status.textContent = 'Não foi possível carregar a revisão.'; });
