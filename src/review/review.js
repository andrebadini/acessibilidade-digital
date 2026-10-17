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
import {
  keyboardMapCountsText, keyboardMapPresentation, KEYBOARD_MAP_INTRO,
} from '../core/report/keyboard-map-presentation.js';
import {
  EVIDENCE_CROP_ELEMENT_ORIGIN_ARIA, EVIDENCE_CROP_PAGE_ORIGIN_ARIA, EVIDENCE_CROP_REGION_LEGEND,
  elementCropSource, evidenceCropDisplaySize, evidenceMediaParts,
} from '../core/report/evidence-crop.js';
import { EVIDENCE_HIGHLIGHT_UNMARKED_LEGEND } from '../core/report/evidence-highlight.js';
import { GUIDED_REVIEW_TREATMENT_V1 } from '../core/report/evidence-treatment.js';
import {
  documentRectToSegmentPixels, integerDocumentArea, segmentPixelsToDocumentRect,
} from '../core/keyboard/keyboard-map-geometry.js';
import { canonicalReviewMarks, describeReviewAreaPosition, REVIEW_MARKS_LIMITS, REVIEW_MARKS_VERSION } from '../core/review/review-marks.js';
import { applyReportSourceControls, buildReportView, renderReportView, updateReportHighlightAction } from './report-view.js';
import { cropImageRegistry } from './crop-image-registry.js';
import { REPORT_PORT_NAME } from '../background/report-port.js';
import { createReportHighlightPolicy } from './report-highlight-policy.js';
import {
  buildTabReadingPlan, tabReadingProgress, tabReadingRowLabel,
  TAB_READING_ANSWER_TEXT, TAB_READING_ANSWERS, TAB_READING_HINT_LABEL, TAB_READING_INTRO,
  TAB_READING_LISTEN_LABEL, TAB_READING_NO_VOICE_MESSAGE, TAB_READING_QUESTION, TAB_READING_SECTION_TITLE,
} from '../core/report/tab-reading-plan.js';
import { createSpeaker } from '../reader/speech.js';
import { describeExportDelivery, exportDeliveryText } from '../export/export-outcome-message.js';

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
const zoomDialog = document.querySelector('#lay-zoom-dialog');
const zoomBody = document.querySelector('#lay-zoom-body');
const zoomClose = document.querySelector('#lay-zoom-close');
// Confirmação da marcação em bloco da leitura por Tab. É uma caixa de diálogo nativa, como a da
// exclusão: quem responde 20 pontos de uma vez precisa confirmar de forma explícita o que vai gravar.
const tabBulkDialog = document.querySelector('#lay-tab-bulk-dialog');
const tabBulkSummary = document.querySelector('#lay-tab-bulk-summary');
const tabBulkCancel = document.querySelector('#lay-tab-bulk-cancel');
const tabBulkConfirm = document.querySelector('#lay-tab-bulk-confirm');
const tabBulkDialogStatus = document.querySelector('#lay-tab-bulk-dialog-status');
const EXPORT_CLEANUP_MESSAGE = 'Um arquivo obsoleto da exportação não pôde ser removido com confirmação; tente gerar o relatório novamente.';
// Ajuda "keyboard-map" do item 5.1.13: a pergunta olha o mapa, não o código. As três respostas abaixo
// são as mesmas respostas canônicas, com o rótulo que a pessoa entende sem conhecer ABNT nem WCAG.
const KEYBOARD_MAP_QUESTION = 'Olhe o mapa. Algum menu, botão, link ou campo que você usaria está SEM caixa azul numerada?';
const KEYBOARD_MAP_FINDING_PROMPT = 'Descreva qual item ficou sem caixa (por exemplo: os cartões Consumidor, Fornecedor, Servidor e Ouvidoria da seção Serviços abrem menus só com o mouse)';
const KEYBOARD_MAP_ANSWERS = Object.freeze([
  Object.freeze({ answer: 'não conforme', label: 'Sim, falta caixa em algum item' }),
  Object.freeze({ answer: 'conforme', label: 'Não, todos os itens que uso têm caixa' }),
  Object.freeze({ answer: 'não foi possível determinar', label: 'Não consegui verificar' }),
]);
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
    // O botão só volta a aparecer se a nota ao lado dele não for a explicação de "sem localização":
    // toda nota do cartão usa a mesma classe, e só ela recebe a marca `data-lay-no-binding`.
    for (const node of list.querySelectorAll('button.lay-show')) node.hidden = Boolean(node.nextElementSibling?.hasAttribute?.('data-lay-no-binding'));
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

// Marcar em bloco a leitura por Tab: a confirmação é uma caixa de diálogo própria e o trabalho de
// gravação fica em `tabBulkRun`, trocado a cada abertura — a caixa não conhece a seção nem o modelo.
let tabBulkRun = null;
const tabBulkController = createDestructiveDialog({
  dialog: tabBulkDialog,
  cancelButton: tabBulkCancel,
  confirmButton: tabBulkConfirm,
  status,
  dialogStatus: tabBulkDialogStatus,
  stableFocus: status,
  onConfirm: () => (typeof tabBulkRun === 'function' ? tabBulkRun() : { ok: false, error: 'Não há nada para marcar nesta seção.' }),
  successMessage: 'Respostas em bloco registradas.',
  failureMessage: 'Não foi possível registrar as respostas em bloco.',
});

// A imagem ampliada sai do documento ao fechar: a mesma captura de página inteira não fica pendurada na
// aba depois que a pessoa já olhou o recorte. O `<dialog>` nativo fecha no Escape e no botão Fechar, e
// devolve o foco ao botão do cartão que o abriu.
zoomClose?.addEventListener('click', () => zoomDialog.close());
zoomDialog?.addEventListener('close', () => zoomBody.replaceChildren());

// The worker acknowledges the request before the files exist, and the export tab reports
// the outcome only through the durable receipt. Without a deadline the screen would keep
// saying "na fila de geração" forever, with no file, no error and no way forward, so the
// request is bounded and an unconfirmed outcome is reported as exactly that. Quatro
// formatos podem levar 30 s cada, além da impressão do PDF: o limite acompanha esse
// trabalho e continua finito.
const EXPORT_CONFIRMATION_TIMEOUT_MS = 300_000;
const EXPORT_OUTCOME_POLL_MS = 1_500;
let exportConfirmationTimer = null;

async function requestExport({ deleteAfterCompleteExport = false } = {}) {
  if (!auditModel?.auditId) return;
  const requestedAuditId = auditModel.auditId;
  // A resposta do worker confirma apenas o pedido, não os arquivos. Sem acompanhar o
  // recibo durável, a tela ficava em "na fila de geração" mesmo quando o download
  // falhava. A leitura é barata e limitada; em teste ou contexto sem store, é ignorada.
  const canWatchOutcome = typeof store !== 'undefined' && store && typeof store.getLatest === 'function';
  let baselineAttempt = 0;
  if (canWatchOutcome) {
    try {
      const previous = await store.getLatest();
      if (previous?.auditId === requestedAuditId && Number.isSafeInteger(previous.exportAttempt)) {
        baselineAttempt = previous.exportAttempt;
      }
    } catch { /* the bounded notice below still reports the unconfirmed outcome */ }
  }
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
  status.textContent = response?.ok ? 'Relatório atualizado na fila de geração.' : describeExportFailure(response?.code);
  if (response?.ok && canWatchOutcome) void watchExportOutcome(requestedAuditId, baselineAttempt);
}

// Em página grande a exportação leva dezenas de segundos; um segundo pedido nesse intervalo era
// recusado com uma mensagem genérica, como se a geração tivesse falhado.
function describeExportFailure(code) {
  if (code === 'EXPORT_ALREADY_ACTIVE') {
    return 'Já há uma geração do relatório em andamento para esta auditoria. Aguarde os arquivos terminarem de baixar (a aba de exportação fecha sozinha) e tente de novo.';
  }
  if (code === 'EXPORT_LEASE_DENIED') return 'Outra exportação desta auditoria ainda está terminando. Tente de novo em alguns segundos.';
  return 'Não foi possível gerar o relatório atualizado.';
}

// Acompanha o recibo durável até o desfecho. O limite de tempo é o mesmo do aviso de
// confirmação: se nada terminal aparecer, a tela diz que não houve confirmação e como
// tentar de novo, em vez de continuar prometendo uma fila que não anda.
async function watchExportOutcome(requestedAuditId, baselineAttempt) {
  const deadline = Date.now() + EXPORT_CONFIRMATION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, EXPORT_OUTCOME_POLL_MS));
    if (auditModel?.auditId !== requestedAuditId) return;
    let latest = null;
    try { latest = await store.getLatest(); } catch { latest = null; }
    if (!latest || latest.auditId !== requestedAuditId) continue;
    const attempt = Number.isSafeInteger(latest.exportAttempt) ? latest.exportAttempt : 0;
    if (attempt <= baselineAttempt) continue;
    // Durante a exportação o journal tem entradas em andamento, o que também marca
    // exportCleanupPending. Só é uma limpeza realmente presa quando a tentativa desta
    // exportação não está mais em andamento (ou já terminou com ressalva).
    if (latest.exportCleanupPending === true &&
      !['running', 'delivering'].includes(latest.exportStatus) &&
      !['complete', 'partial', 'failed'].includes(latest.exportStatus)) {
      status.textContent = EXPORT_CLEANUP_MESSAGE;
      regenerate.disabled = false;
      return;
    }
    if (!['complete', 'partial', 'failed'].includes(latest.exportStatus)) continue;
    status.textContent = exportDeliveryText(describeExportDelivery(latest));
    regenerate.disabled = false;
    return;
  }
  if (auditModel?.auditId !== requestedAuditId) return;
  regenerate.disabled = false;
  status.textContent = 'A geração dos arquivos não foi confirmada, então os arquivos não foram baixados. '
    + 'Tente novamente; se persistir, feche as abas de exportação abertas antes de repetir.';
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
// Leitura por Tab: a seção mostra blocos de 20 pontos, com "Mostrar mais" para o bloco seguinte. Uma
// sequência de Tab de uma página grande tem centenas de paradas; desenhar todas de uma vez deixaria a
// aba pesada por causa dos recortes.
const TAB_READING_BLOCK = 20;
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
  const inputs = entries.map(({ occurrence, answer, note, marks }) => ({
    auditId, itemId: occurrence.itemId, occurrenceId: occurrence.occurrenceId, answer, evaluator: evaluatorName,
    note, marks: marks ?? null, decidedAt, mode: occurrence.mode === 'manual' ? 'manual' : 'assisted',
  }));
  const reviseByOccurrence = new Map(entries.map(entry => [entry.occurrence.occurrenceId, entry.revise === true]));
  const items = [...new Set(entries.map(entry => entry.occurrence.itemId))].join(', ');
  const committed = await commitDecisionBatch({
    inputs,
    requestCommit: decisions => sendAuthorizedRequest(sessionCapabilityId => ({
      type: 'REPORT_COMMIT_REVIEW_BATCH', sessionCapabilityId, auditId, evaluator: evaluatorName, decidedAt,
      decisions: JSON.stringify(decisions.map(decision => ({
        itemId: decision.itemId, occurrenceId: decision.occurrenceId, answer: decision.answer,
        mode: decision.mode, note: decision.note ?? '', marks: decision.marks ?? null,
        revise: reviseByOccurrence.get(decision.occurrenceId) === true,
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
  // Marcas por cartão (itens sem caixa e áreas desenhadas no mapa do teclado), fora do DOM porque o
  // formulário é remontado a cada resposta.
  marks: new Map(),
  visible: { requirement: REVIEW_CARD_LIMIT, recommendation: REVIEW_CARD_LIMIT },
  showRecommendations: true,
  activeAids: new Set(),
  header: null,
  aidBar: null,
  // Leitura por Tab: a seção é remontada a cada resposta, então o que é do estado (não do desenho) mora
  // aqui — a janela de linhas, o filtro, o que a pessoa digitou e o ponto aberto para "o que deveria
  // dizer". Sem isto, cada resposta apagaria o texto ainda não registrado das outras linhas.
  tab: { visible: 0, onlyPending: false },
  tabNodes: new Map(),
  tabDrafts: new Map(),
  tabAsking: new Set(),
  tabRevising: new Set(),
  tabSection: null,
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
  for (const { target, answer, note, itemId, marks } of plan) {
    const text = typeof note === 'string' ? note.trim() : '';
    const apontamentos = marks ?? null;
    // Uma ocorrência já decidida só é regravada quando a pessoa pediu "Rever resposta"; uma nova
    // tentativa depois de falha parcial não cria revisão falsa da resposta que já estava salva. As
    // marcas entram na comparação: revisar só o apontamento (mesma resposta, mesma descrição) é uma
    // mudança de verdade e precisa ser gravada.
    const revising = layState.revising.has(`${card.key}|${itemId ?? target.entry.itemId}`);
    if (target.decision && (!revising ||
      (target.decision.answer === answer && (target.decision.note ?? '') === text &&
        JSON.stringify(target.decision.marks ?? null) === JSON.stringify(apontamentos)))) continue;
    if (entries.some(entry => entry.occurrence.occurrenceId === target.occurrence.occurrenceId)) continue;
    entries.push({ occurrence: target.occurrence, answer, note: text, marks: apontamentos, revise: Boolean(target.decision) });
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
  if (aid === 'tab' || aid === 'grayscale' || aid === 'keyboard-map') {
    wrap.append(el('p', aid === 'keyboard-map'
      ? 'Ajuda: percorra a página auditada com a tecla Tab, do começo ao fim, e compare com o mapa (ou com a lista numerada) mostrado acima. Clique numa área vazia antes de começar.'
      : aid === 'tab'
        ? 'Ajuda: vá para a página auditada, clique numa área vazia e use a tecla Tab. No painel lateral, “Conferir leitura por Tab” mostra a sequência com explicações.'
        : 'Ajuda: no painel lateral, “Acromatopsia” mostra a página em tons de cinza, para o que depende só da cor.'));
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

/**
 * Onde a pessoa encontra o elemento: a imagem deste mesmo cartão quando ela existe; sem imagem, o tipo
 * e o nome do elemento, que é o que sobra para reconhecê-lo na página. Nenhuma frase aponta para outro
 * lugar — a imagem, quando existe, está logo acima, no cartão que a pessoa tem aberto.
 */
function locateSentence(card, hasImage) {
  if (hasImage) return 'A imagem deste elemento está no recorte acima, neste mesmo cartão.';
  const label = card?.element?.label;
  return `${label ? `Elemento desta pergunta: ${label}. ` : ''}Esta auditoria não guardou imagem deste elemento.`;
}

function cardHasImage(node) {
  const scope = typeof node?.closest === 'function' ? node.closest('.lay-card') ?? node : node;
  return Boolean(scope?.querySelector?.('.lay-crop'));
}

async function showOnPage(card, trigger) {
  const occurrenceId = highlightableOccurrence(card);
  const locate = locateSentence(card, cardHasImage(trigger));
  if (!occurrenceId) {
    status.textContent = `O destaque ao vivo vale para perguntas pendentes ou respondidas com “Não”. ${locate}`;
    return;
  }
  if (reportSessionState !== 'result') {
    status.textContent = `A página auditada mudou ou foi fechada, então o destaque ao vivo não está mais disponível. ${locate}`;
    return;
  }
  trigger.disabled = true;
  try {
    const available = await handleReportHighlightIntent({ type: 'GET_HIGHLIGHT_AVAILABILITY', occurrenceId }, { announce: false });
    if (!available || highlightAvailability.get(occurrenceId)?.state !== 'available') {
      const reason = highlightAvailability.get(occurrenceId)?.reason;
      status.textContent = reason === 'no-binding'
        ? `Este elemento não tem localização registrada nesta auditoria, então não dá para destacá-lo na página. ${locate}`
        : `Não é possível destacar este elemento agora (a página auditada pode ter mudado). ${locate}`;
      return;
    }
    if (await handleReportHighlightIntent({ type: 'HIGHLIGHT_OCCURRENCE', occurrenceId }, { announce: false })) {
      status.textContent = 'O elemento está destacado na página auditada. Volte a esta aba para responder.';
    }
  } finally { trigger.disabled = false; }
}

// Nem todo elemento tem localização registrada para destaque (por exemplo, além do limite de
// miniaturas). Ao abrir o cartão, a disponibilidade é consultada (é barata) e, sem localização, o botão
// dá lugar a uma explicação, em vez de oferecer um destaque que só seria recusado depois do clique.
// A explicação ocupa a mesma nota do cartão (`lay-locate-note`), para não repetir a frase que já está lá.
async function checkShowOnPage(card, node) {
  const show = node.querySelector('button.lay-show');
  const occurrenceId = highlightableOccurrence(card);
  if (!show || show.hidden || !occurrenceId || reportSessionState !== 'result' ||
    highlightAvailability.get(occurrenceId)?.state === 'available') return;
  if (!await handleReportHighlightIntent({ type: 'GET_HIGHLIGHT_AVAILABILITY', occurrenceId }, { announce: false })) return;
  const availability = highlightAvailability.get(occurrenceId);
  if (availability?.state !== 'unavailable' || availability.reason !== 'no-binding' || !show.isConnected) return;
  const explanation = `Este elemento não tem localização registrada nesta auditoria, então não dá para destacá-lo na página. ${locateSentence(card, cardHasImage(node))}`;
  const note = node.querySelector('.lay-locate-note');
  show.hidden = true;
  if (note) {
    note.textContent = explanation;
    note.setAttribute('data-lay-no-binding', '');
  } else {
    const created = el('p', explanation, 'lay-locate-note');
    created.setAttribute('data-lay-no-binding', '');
    show.after(created);
  }
}

/**
 * Imagem do elemento para o cartão. A ordem é a mesma do produto: a miniatura do elemento quando ela
 * foi guardada; sem ela, o recorte da captura da página inteira na região do elemento, quando a
 * geometria dos mapas permite posicioná-lo; sem nenhuma das duas, nenhuma imagem — e o cartão diz isso
 * com todas as letras. Nenhuma posição é adivinhada: `elementCropSource` devolve `null` sem geometria.
 */
const CARD_MEDIA = new WeakMap();

function cardMedia(card) {
  if (!card.elementLevel) return null;
  if (CARD_MEDIA.has(card)) return CARD_MEDIA.get(card);
  const media = cardMediaUncached(card);
  CARD_MEDIA.set(card, media);
  return media;
}

function cardMediaUncached(card) {
  const evidence = card.evidence;
  if (evidence && isSafeEvidenceImageUrl(evidence.dataUrl, chrome.runtime.getURL('/'))) {
    const parts = evidenceMediaParts(evidence, GUIDED_REVIEW_TREATMENT_V1);
    // Miniatura sem quadro confiável aparece crua, como no relatório, mas ainda é a imagem do elemento.
    return parts ? { ...parts, dataUrl: evidence.dataUrl, origin: 'element' } : { rawDataUrl: evidence.dataUrl, origin: 'element' };
  }
  // `elementEvidence` leva a posição gravada na captura integral (1.1.62) para dentro da derivação do
  // recorte: sem ela, o cartão só saberia recortar pela geometria dos mapas, que as auditorias novas não
  // têm mais.
  const source = elementCropSource({
    evidence: modelLookups(auditModel).evidence, pageId: card.pageId, nodeId: card.nodeId,
    elementEvidence: evidence ?? null,
  });
  const parts = source && evidenceMediaParts(source.artifact, GUIDED_REVIEW_TREATMENT_V1, source.view);
  return parts ? { ...parts, dataUrl: source.artifact.dataUrl, origin: 'page' } : null;
}

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
// Cada PNG entra uma vez no documento e os recortes o referenciam por `<use>`: sem isto, a mesma captura
// de página inteira seria copiada na marcação de cada cartão que a usa. O registro é o mesmo do relatório
// — ver `crop-image-registry.js`.
function cropImageReference(dataUrl, size) {
  const registry = cropImageRegistry(document);
  // O relatório desenha no mesmo documento e pendura o registro na raiz dele; aqui só se cria o registro
  // quando ainda não há nenhum — mover para o corpo o que já está no documento quebraria os `<use>` do
  // relatório sem necessidade.
  if (!registry.node.isConnected) registry.attach(document.body);
  return registry.reference(dataUrl, size);
}

function cropSvg(media, display) {
  const svg = document.createElementNS(SVG_NAMESPACE, 'svg');
  svg.setAttribute('class', 'lay-crop-svg');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', cropAriaLabel(media));
  svg.setAttribute('viewBox', `${media.view.x} ${media.view.y} ${media.view.width} ${media.view.height}`);
  svg.setAttribute('width', String(display.width));
  svg.setAttribute('height', String(display.height));
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.setAttribute('focusable', 'false');
  const use = document.createElementNS(SVG_NAMESPACE, 'use');
  use.setAttribute('href', `#${cropImageReference(media.dataUrl, media.image)}`);
  use.setAttribute('width', String(media.image.width));
  use.setAttribute('height', String(media.image.height));
  svg.append(use);
  for (const shape of media.shapes) {
    const node = document.createElementNS(SVG_NAMESPACE, shape.kind);
    for (const [name, value] of Object.entries(shape.attributes)) node.setAttribute(name, String(value));
    svg.append(node);
  }
  return svg;
}

function cropAriaLabel(media) {
  const origin = media.origin === 'page' ? EVIDENCE_CROP_PAGE_ORIGIN_ARIA : EVIDENCE_CROP_ELEMENT_ORIGIN_ARIA;
  return `${origin} ${media.legend}`;
}

function cropCaption(media) {
  return media.origin === 'page' ? `${media.legend} ${EVIDENCE_CROP_REGION_LEGEND}` : media.legend;
}

function zoomDisplaySize(media) {
  return evidenceCropDisplaySize(media.view, { longestSide: 880, maxWidth: 880, maxHeight: 620, maxScale: 6 }) ?? media.display;
}

// A imagem ampliada abre numa caixa de diálogo nativa: o Escape fecha e o foco volta para o cartão.
function openCropZoom(media) {
  if (!zoomDialog || typeof zoomDialog.showModal !== 'function') return;
  const figure = el('figure', undefined, 'lay-crop lay-crop--zoom');
  figure.append(cropSvg(media, zoomDisplaySize(media)));
  figure.append(el('figcaption', cropCaption(media), 'lay-crop-caption'));
  zoomBody.replaceChildren(figure);
  zoomDialog.showModal();
}

// `legend` curta: na coluna estreita da leitura por Tab a legenda completa (contorno + contexto +
// origem do recorte) empurrava a imagem para fora da tela. Ali cabe "Contorno vermelho: este elemento.
// Clique para ampliar."; quem abrir o recorte ampliado lê a explicação inteira.
function cropBlock(media, card, options = {}) {
  const short = options.shortLegend === true;
  const figure = el('figure', undefined, 'lay-crop');
  if (media.rawDataUrl) {
    const image = document.createElement('img');
    image.className = 'lay-thumb';
    image.src = media.rawDataUrl;
    image.alt = `Captura do elemento: ${card.element?.label ?? 'elemento da página'}`;
    figure.append(image);
    // Sem marcação não há contorno: a frase curta diria que o elemento está contornado quando não está.
    figure.append(el('figcaption', EVIDENCE_HIGHLIGHT_UNMARKED_LEGEND, 'lay-crop-caption'));
    return figure;
  }
  const zoom = el('button');
  zoom.type = 'button';
  zoom.className = 'lay-crop-zoom';
  zoom.setAttribute('aria-label', 'Ampliar o recorte deste elemento');
  zoom.append(cropSvg(media, media.display));
  zoom.addEventListener('click', () => openCropZoom(media));
  figure.append(zoom);
  figure.append(el('figcaption', short ? 'Contorno vermelho: este elemento.' : cropCaption(media), 'lay-crop-caption'));
  figure.append(el('p', short ? 'Clique para ampliar.' : 'Clique na imagem para ver o recorte ampliado.', 'lay-crop-hint'));
  return figure;
}

function objectBlock(card) {
  const block = el('div', undefined, 'lay-object');
  const media = cardMedia(card);
  if (media) block.append(cropBlock(media, card));
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
  const highlightable = card.elementLevel && reportSessionState === 'result' && highlightableOccurrence(card);
  if (highlightable) {
    block.append(button('Mostrar na página', 'lay-show', event => { void showOnPage(card, event.currentTarget); }));
  }
  // Sem imagem no cartão, o que resta é dizer o que procurar e como: o tipo e o nome do elemento, o
  // destaque ao vivo quando ele existe, e a frase honesta quando a auditoria não guardou imagem.
  if (card.elementLevel && !media) {
    const hint = highlightable ? ' Use “Mostrar na página” para vê-lo destacado na página auditada.' : '';
    block.append(el('p', `${locateSentence(card, false)}${hint}`, 'lay-locate-note'));
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

/**
 * Mapa do teclado no cartão do 5.1.13.
 *
 * Mostra a imagem quando a auditoria teve pixels e, sempre, a lista numerada — que é a única forma
 * de responder no modo sem imagens. Nada aqui decide: a pessoa olha e responde.
 */
// ---- Apontar no mapa do teclado (item 5.1.13) ----
//
// Depois de "Sim, falta caixa em algum item", a pessoa pode APONTAR o que ficou sem caixa: marcar os
// itens suspeitos na lista e desenhar até cinco áreas sobre a imagem. A descrição continua obrigatória
// — o apontamento é opcional e serve para o relatório mostrar onde olhar.
// O limite de áreas vem de REVIEW_MARKS_LIMITS (esquema fechado) e é lido dentro das funções: nenhuma
// constante de topo pode depender de um `import`, porque os testes de renderização executam este
// arquivo num DOM falso sem os módulos importados.
const MARKS_AREA_STEP = 8;
const MARKS_MIN_SIZE = 8;
const MARKS_NEW_AREA_RATIO = 0.15;
const MARKS_MIN_NEW_AREA = 40;

/** Estado das marcas de um cartão. Fica fora do DOM: o formulário é remontado a cada atualização. */
function marksState(cardKey, question) {
  const existing = layState.marks.get(cardKey);
  if (existing) return existing;
  const decisions = question.entries.map(entry => entry.decision).filter(Boolean);
  const latest = [...decisions].sort((left, right) => left.decidedAt.localeCompare(right.decidedAt)).at(-1);
  const marks = latest?.marks ?? null;
  const state = {
    suspects: new Set(marks?.suspects ?? []),
    areas: (marks?.areas ?? []).map(area => ({ ...area })),
    selected: null,
  };
  layState.marks.set(cardKey, state);
  return state;
}

/** Marcas prontas para gravar: `null` quando a pessoa não apontou nada. */
function marksForSubmit(cardKey, question) {
  const state = layState.marks.get(cardKey);
  if (!state) return null;
  try {
    return canonicalReviewMarks({
      version: REVIEW_MARKS_VERSION,
      suspects: [...state.suspects],
      areas: state.areas.map(area => ({ ...area })),
    });
  } catch {
    return null;
  }
}

let marksDocumentSize = null;

function describeMarksArea(area, number) {
  const where = describeReviewAreaPosition(area, marksDocumentSize);
  return where ? `Área ${number}, ${where}.` : `Área ${number}.`;
}

/**
 * Lista dos itens laranja do mapa e superfície de desenho.
 *
 * O desenho usa SVG e não gera pixel novo: a imagem guardada entra inteira e cada área é um
 * `<rect>` sobre ela. A mesma escolha vale para o relatório, e evita atributo de estilo — que a
 * política de segurança do relatório bloqueia.
 */
function keyboardMarksBlock(card, question) {
  const model = auditModel;
  const map = (model?.evidence ?? [])
    .find(artifact => artifact.kind === 'keyboard-map' && artifact.pageId === card.pageId);
  const geometry = map?.derivation?.geometry;
  marksDocumentSize = geometry?.sourceCssSize ?? null;
  const segments = Array.isArray(map?.segments) ? map.segments : [];
  if (!map || !geometry || segments.length === 0) return null;
  const projection = keyboardMapPresentation([{ pageId: card.pageId }], [map])[0];
  const state = marksState(card.key, question);
  const block = el('div', undefined, 'lay-marks');
  block.setAttribute('data-lay-marks', card.key);
  block.append(el('p', 'Marque os itens que ficaram sem caixa azul (opcional).', 'lay-map-subtitle'));

  // O anúncio do apontamento tem a sua própria região viva: marcações e áreas não disputam a linha de
  // status da página, que fala do registro da resposta.
  const live = el('p', undefined, 'lay-marks-status');
  live.setAttribute('aria-live', 'polite');
  live.setAttribute('data-lay-marks-status', '');
  const announce = message => { live.textContent = message; };

  if (projection.suspects.length > 0) {
    const list = el('ul', undefined, 'lay-marks-suspects');
    for (const suspect of projection.suspects) {
      const item = el('li');
      const label = el('label');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.value = String(suspect.number);
      // O atributo marca a caixa já apontada numa resposta anterior; o estado vivo é lido do próprio
      // elemento no evento de mudança.
      if (state.suspects.has(suspect.number)) box.setAttribute('checked', '');
      box.setAttribute('data-lay-marks-suspect', String(suspect.number));
      box.addEventListener('change', () => {
        if (box.checked) state.suspects.add(suspect.number);
        else state.suspects.delete(suspect.number);
        announce(box.checked
          ? `Item “${suspect.name}” marcado como sem caixa azul.`
          : `Item “${suspect.name}” desmarcado.`);
      });
      label.append(box, el('span', ` ${suspect.name} — ${suspect.reason}`));
      item.append(label);
      list.append(item);
    }
    block.append(list);
  } else {
    block.append(el('p', 'Esta página não tem itens laranja na lista do mapa; marque uma área na imagem se algo ficou sem caixa.', 'lay-hint'));
  }

  const areas = el('ol', undefined, 'lay-marks-areas');
  const removeRow = el('div', undefined, 'lay-marks-remove');
  const surface = el('div', undefined, 'lay-marks-surface');
  surface.setAttribute('tabindex', '0');
  surface.setAttribute('role', 'group');
  surface.setAttribute('aria-label', 'Mapa do teclado para marcar áreas. Use as setas para mover a área escolhida, Shift com as setas para redimensionar e Delete para remover.');
  const figures = [];

  const drawAreas = () => {
    for (const figure of figures) {
      for (const rect of figure.rects.values()) rect.remove();
      figure.rects.clear();
      state.areas.forEach((area, index) => {
        const painted = documentRectToSegmentPixels(figure.segment, geometry, area);
        if (!painted) return;
        const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        rect.setAttribute('x', String(painted.x));
        rect.setAttribute('y', String(painted.y));
        rect.setAttribute('width', String(painted.width));
        rect.setAttribute('height', String(painted.height));
        rect.setAttribute('class', `lay-marks-area${state.selected === index ? ' lay-marks-area--selected' : ''}`);
        rect.setAttribute('data-lay-marks-area', String(index + 1));
        figure.svg.append(rect);
        figure.rects.set(index, rect);
      });
    }
    areas.replaceChildren();
    for (const [index, area] of state.areas.entries()) {
      const chosen = state.selected === index;
      const item = el('li');
      item.setAttribute('data-lay-marks-area-list', String(index + 1));
      const choose = button(`${describeMarksArea(area, index + 1)}${chosen ? ' (área escolhida)' : ''}`,
        `lay-marks-pick${chosen ? ' lay-marks-pick--selected' : ''}`, () => {
          state.selected = index;
          drawAreas();
          surface.focus();
          announce(`${describeMarksArea(area, index + 1)} Área escolhida. Use as setas para mover, Shift com as setas para redimensionar e Delete para remover.`);
        });
      choose.setAttribute('aria-pressed', chosen ? 'true' : 'false');
      item.append(choose);
      areas.append(item);
    }
    removeRow.replaceChildren();
    for (const [index] of state.areas.entries()) {
      removeRow.append(button(`Remover área ${index + 1}`, 'lay-marks-remove-button', () => removeArea(index)));
    }
  };

  const removeArea = index => {
    const removed = state.areas[index];
    if (!removed) return;
    state.areas.splice(index, 1);
    if (state.selected !== null) {
      state.selected = state.selected === index ? null : state.selected > index ? state.selected - 1 : state.selected;
    }
    drawAreas();
    announce(`Área removida: ${describeMarksArea(removed, index + 1)} Restam ${state.areas.length} ${state.areas.length === 1 ? 'área' : 'áreas'} marcadas.`);
  };

  const commitArea = rect => {
    const area = integerDocumentArea(rect, geometry.sourceCssSize);
    if (!area) return null;
    if (area.width < MARKS_MIN_SIZE || area.height < MARKS_MIN_SIZE) return null;
    if (state.areas.length >= REVIEW_MARKS_LIMITS.maxAreas) {
      announce(`O limite é de ${REVIEW_MARKS_LIMITS.maxAreas} áreas marcadas. Remova uma área antes de marcar outra.`);
      return null;
    }
    state.areas.push(area);
    state.selected = state.areas.length - 1;
    drawAreas();
    announce(`${describeMarksArea(area, state.areas.length)} Área marcada. Use as setas para mover, Shift com as setas para redimensionar e Delete para remover.`);
    return area;
  };

  // Centro do pedaço do mapa que está à vista: é onde "Adicionar área" cria o retângulo.
  const visibleCenter = () => {
    const rect = surface.getBoundingClientRect();
    const visibleTop = Math.max(rect.top, 0);
    const visibleBottom = Math.min(rect.bottom, window.innerHeight) - visibleTop;
    const centerY = visibleBottom > 0 ? visibleTop + visibleBottom / 2 : rect.top + rect.height / 2;
    return { x: rect.left + rect.width / 2, y: centerY };
  };

  const addAreaAtCenter = () => {
    if (state.areas.length >= REVIEW_MARKS_LIMITS.maxAreas) {
      announce(`O limite é de ${REVIEW_MARKS_LIMITS.maxAreas} áreas marcadas. Remova uma área antes de marcar outra.`);
      return;
    }
    const figure = figures[0];
    if (!figure) return;
    const box = figure.svg.getBoundingClientRect();
    const center = visibleCenter();
    const point = segmentPixelsToDocumentRect(figure.segment, geometry, {
      x: (center.x - box.left) * (figure.segment.width / box.width),
      y: (center.y - box.top) * (figure.segment.height / box.height),
      width: 0, height: 0,
    });
    const size = {
      width: Math.max(MARKS_MIN_NEW_AREA, Math.round(geometry.sourceCssSize.width * MARKS_NEW_AREA_RATIO)),
      height: Math.max(MARKS_MIN_NEW_AREA, Math.round(figure.segment.sourceCssClip.height * MARKS_NEW_AREA_RATIO)),
    };
    commitArea({ x: point.x - size.width / 2, y: point.y - size.height / 2, ...size });
  };

  const moveSelected = (dx, dy, resize) => {
    const index = state.selected;
    if (index === null || !state.areas[index]) {
      announce('Escolha uma área na lista antes de mover.');
      return;
    }
    const current = state.areas[index];
    const next = integerDocumentArea(resize
      ? { ...current, width: current.width + dx, height: current.height + dy }
      : { ...current, x: current.x + dx, y: current.y + dy }, geometry.sourceCssSize);
    if (!next) return;
    state.areas[index] = next;
    drawAreas();
    announce(describeMarksArea(next, index + 1));
  };

  surface.addEventListener('keydown', event => {
    const step = MARKS_AREA_STEP;
    if (event.key === 'ArrowLeft') { event.preventDefault(); moveSelected(-step, 0, event.shiftKey); return; }
    if (event.key === 'ArrowRight') { event.preventDefault(); moveSelected(step, 0, event.shiftKey); return; }
    if (event.key === 'ArrowUp') { event.preventDefault(); moveSelected(0, -step, event.shiftKey); return; }
    if (event.key === 'ArrowDown') { event.preventDefault(); moveSelected(0, step, event.shiftKey); return; }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      if (state.selected === null) return;
      event.preventDefault();
      removeArea(state.selected);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); addAreaAtCenter(); }
  });

  for (const segment of segments) {
    if (!isSafeEvidenceImageUrl(segment.dataUrl, chrome.runtime.getURL('/'))) continue;
    const figure = el('figure');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${segment.width} ${segment.height}`);
    svg.setAttribute('width', String(segment.width));
    svg.setAttribute('height', String(segment.height));
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    svg.setAttribute('class', 'lay-marks-image');
    svg.setAttribute('data-lay-marks-segment', String(segment.index));
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', `Trecho ${segment.index} do mapa do teclado para marcar áreas.`);
    const image = document.createElementNS('http://www.w3.org/2000/svg', 'image');
    image.setAttribute('x', '0');
    image.setAttribute('y', '0');
    image.setAttribute('width', String(segment.width));
    image.setAttribute('height', String(segment.height));
    image.setAttribute('href', segment.dataUrl);
    svg.append(image);
    const record = { svg, segment, rects: new Map() };
    figures.push(record);
    let drawing = null;
    let start = null;
    svg.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      const target = event.target;
      if (target?.getAttribute?.('data-lay-marks-area')) {
        const index = Number(target.getAttribute('data-lay-marks-area')) - 1;
        state.selected = index;
        drawAreas();
        surface.focus();
        announce(`${describeMarksArea(state.areas[index], index + 1)} Área escolhida.`);
        return;
      }
      const box = svg.getBoundingClientRect();
      start = {
        x: (event.clientX - box.left) * (segment.width / box.width),
        y: (event.clientY - box.top) * (segment.height / box.height),
      };
      drawing = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      drawing.setAttribute('class', 'lay-marks-area lay-marks-area--drawing');
      drawing.setAttribute('x', String(start.x));
      drawing.setAttribute('y', String(start.y));
      drawing.setAttribute('width', '0');
      drawing.setAttribute('height', '0');
      svg.append(drawing);
      svg.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    });
    svg.addEventListener('pointermove', event => {
      if (!drawing || !start) return;
      const box = svg.getBoundingClientRect();
      const current = {
        x: (event.clientX - box.left) * (segment.width / box.width),
        y: (event.clientY - box.top) * (segment.height / box.height),
      };
      drawing.setAttribute('x', String(Math.min(start.x, current.x)));
      drawing.setAttribute('y', String(Math.min(start.y, current.y)));
      drawing.setAttribute('width', String(Math.abs(current.x - start.x)));
      drawing.setAttribute('height', String(Math.abs(current.y - start.y)));
    });
    const finish = event => {
      if (!drawing || !start) return;
      const painted = {
        x: Number(drawing.getAttribute('x')), y: Number(drawing.getAttribute('y')),
        width: Number(drawing.getAttribute('width')), height: Number(drawing.getAttribute('height')),
      };
      drawing.remove();
      drawing = null;
      start = null;
      svg.releasePointerCapture?.(event.pointerId);
      const area = segmentPixelsToDocumentRect(segment, geometry, painted);
      if (!area) return;
      if (area.width < MARKS_MIN_SIZE || area.height < MARKS_MIN_SIZE) {
        announce('A área marcada ficou pequena demais; clique e arraste para desenhar um retângulo maior.');
        return;
      }
      commitArea(area);
    };
    svg.addEventListener('pointerup', finish);
    svg.addEventListener('pointercancel', finish);
    figure.append(svg, el('figcaption', `Trecho ${segment.index} do mapa do teclado.`));
    surface.append(figure);
  }
  if (figures.length === 0) return null;

  const actions = el('div', undefined, 'lay-marks-actions');
  actions.append(button('Adicionar área', 'lay-marks-add', addAreaAtCenter));
  const help = el('p', 'Para marcar com o mouse: clique e arraste sobre a imagem. Pelo teclado: use “Adicionar área”, escolha a área na lista e mova com as setas; Shift com as setas redimensiona e Delete remove.', 'lay-hint');
  block.append(help, surface, actions, removeRow, areas, live);
  drawAreas();
  if (state.areas.length > 0) {
    live.textContent = `${state.areas.length} ${state.areas.length === 1 ? 'área marcada' : 'áreas marcadas'} nesta resposta.`;
  }
  return block;
}

function keyboardMapBlock() {
  const model = auditModel;
  const maps = Array.isArray(model?.evidence)
    ? model.evidence.filter(artifact => artifact.kind === 'keyboard-map')
    : [];
  if (maps.length === 0) return null;
  const block = el('div', undefined, 'lay-keyboard-map');
  block.append(el('p', KEYBOARD_MAP_QUESTION, 'lay-q'), el('p', KEYBOARD_MAP_INTRO, 'lay-meta'));
  const pages = (model.pages ?? []).map(page => ({ pageId: page.pageId }));
  for (const map of keyboardMapPresentation(pages, maps)) {
    const page = el('div', undefined, 'lay-keyboard-map-page');
    page.append(el('h3', map.title, 'lay-map-title'), el('p', map.summary, 'lay-meta'));
    if (map.counts) page.append(el('p', keyboardMapCountsText(map.counts), 'lay-meta'));
    for (const segment of map.segments) {
      if (!isSafeEvidenceImageUrl(segment.dataUrl, chrome.runtime.getURL('/'))) continue;
      const figure = document.createElement('figure');
      const image = document.createElement('img');
      image.className = 'lay-thumb lay-keyboard-map-thumb';
      image.src = segment.dataUrl;
      image.alt = segment.caption;
      image.width = segment.width;
      image.height = segment.height;
      figure.append(image, el('figcaption', segment.caption));
      page.append(figure);
    }
    if (map.stops.length) {
      page.append(el('p', 'Onde o Tab para, na ordem:', 'lay-map-subtitle'));
      const stops = el('ol', undefined, 'lay-keyboard-map-stops');
      for (const entry of map.stops) {
        // O número vem da própria lista ordenada (`value`): repeti-lo no texto aparecia como "1. 1. …".
        const item = el('li', `${entry.name} (${entry.kind})`);
        item.setAttribute('value', String(entry.number));
        item.setAttribute('data-keyboard-map-stop', String(entry.number));
        stops.append(item);
      }
      page.append(stops);
    }
    if (map.suspects.length) {
      page.append(el('p', 'Itens que parecem clicáveis e o Tab não alcança:', 'lay-map-subtitle'));
      // No desenho os suspeitos levam "?", não número: a lista é sem ordem, para não sugerir um número
      // que a pessoa não vai achar na imagem.
      const suspects = el('ul', undefined, 'lay-keyboard-map-suspects');
      for (const entry of map.suspects) {
        const item = el('li', `${entry.name} — ${entry.reason}`);
        item.setAttribute('data-keyboard-map-suspect', String(entry.number));
        suspects.append(item);
      }
      page.append(suspects);
    }
    for (const limitation of map.limitations) page.append(el('p', `Limite desta verificação: ${limitation}`, 'lay-hint'));
    block.append(page);
  }
  return block;
}

function answerForm(card, question) {
  const form = el('div', undefined, 'lay-answer-form');
  const answers = el('div', undefined, 'lay-answers');
  const finding = el('div', undefined, 'lay-finding');
  finding.hidden = true;
  const keyboardMap = question.guide?.aid === 'keyboard-map' ? keyboardMapBlock() : null;
  const findingLabel = el('label', keyboardMap
    ? `${KEYBOARD_MAP_FINDING_PROMPT} (obrigatório). Esta frase vai para o quadro de constatações; ajuste o rascunho ao que você viu.`
    : 'O que você constatou (obrigatório para “Não”). Esta frase vai para o quadro de constatações; ajuste o rascunho ao que você viu.');
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
  const submit = async (answer, text, trigger, required = false, marks = null) => {
    const problem = noteProblem(text, required);
    if (problem) { status.textContent = problem; (required ? findingText : note).focus(); return; }
    await commitAnswers(card, targets().map(target => ({
      target, answer, note: text, itemId: question.itemId, marks: answer === 'não conforme' ? marks : null,
    })), trigger);
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
  const skip = button('Pular revisão por enquanto', 'lay-skip', () => {
    status.textContent = 'Pergunta pulada; ela continua sem conclusão e pode ser respondida depois.';
    advanceFrom(card.key);
  });
  answers.append(skip);
  const confirm = button('Registrar “não atende”', 'lay-confirm-fail', event => {
    void submit('não conforme', findingText.value, event.currentTarget, true, marksForSubmit(card.key, question));
  });
  const cancel = button('Cancelar', 'lay-cancel', () => { finding.hidden = true; });
  const findingActions = el('div', undefined, 'lay-finding-actions');
  findingActions.append(confirm, cancel);
  finding.append(findingLabel, findingActions);
  // O apontamento no mapa só aparece no caminho de "falta caixa em algum item": é ali que faz sentido
  // dizer QUAIS itens e ONDE. O bloco (com a imagem do mapa) é montado só quando a pessoa escolhe
  // "Sim, falta caixa" — montá-lo escondido duplicaria a imagem do mapa em toda a página.
  let marksBlock = null;
  const showMarksBlock = () => {
    if (marksBlock || !keyboardMap) return;
    marksBlock = keyboardMarksBlock(card, question);
    if (marksBlock) finding.insertBefore(marksBlock, findingActions);
  };
  if (keyboardMap) {
    // Três respostas com o vocabulário do mapa, no lugar do grupo genérico: duas fileiras de botões
    // com dois caminhos de "não conforme" confundiriam quem só quer conferir o mapa. "Sim" cai no
    // mesmo caminho de "Não" e exige a descrição do item que ficou sem caixa antes de registrar.
    const choices = el('div', undefined, 'lay-answers lay-keyboard-map-answers');
    choices.setAttribute('role', 'group');
    choices.setAttribute('aria-label', KEYBOARD_MAP_QUESTION);
    for (const option of KEYBOARD_MAP_ANSWERS) {
      const choice = button(option.label, `lay-answer lay-answer--${option.answer.replace(/\s+/gu, '-')}`, event => {
        if (option.answer === 'não conforme') {
          finding.hidden = false;
          showMarksBlock();
          findingText.focus();
          return;
        }
        void submit(option.answer, note.value, event.currentTarget);
      });
      choice.setAttribute('data-lay-answer', option.answer);
      choices.append(choice);
    }
    choices.append(skip);
    form.append(keyboardMap, choices, finding, noteBox);
  } else form.append(answers, finding, noteBox);
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
    if (node.open) void checkShowOnPage(card, node);
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
    'Na seção “Leitura por Tab”, mais abaixo, você confere ponto por ponto se o que o leitor de tela fala corresponde a cada elemento onde a tecla Tab para.',
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
  const tabRows = tabReadingRows();
  list.replaceChildren();
  layState.tabSection = null;
  if (!plan.length && !tabRows.length) {
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
  if (plan.length) {
    renderProgress(plan);
    updateGroupCounts(plan);
  }
  updateAidBar();
  if (tabRows.length) {
    const section = tabReadingSection(tabRows);
    layState.tabSection = section;
    list.append(section);
  }
}

// ---------------------------------------------------------------------------------------------
// Leitura por Tab — seção própria da verificação guiada.
//
// Uma linha por parada da sequência estimada de Tab: o recorte do elemento, o nome e a função, o que o
// leitor de tela falaria e a pergunta. A pergunta é a mesma em todas as paradas e por isso NÃO aparece
// nos cartões comuns deste item (`buildLayReviewPlan` a deixa fora): aqui o ponto da sequência e o
// anúncio a comparar ficam lado a lado, que é exatamente o que a pergunta pede.
//
// Nada aqui decide nem altera o modelo: cada resposta grava uma decisão canônica pelo mesmo canal
// autorizado dos cartões. A seção é remontada a cada resposta, então o texto digitado, o ponto com o
// campo "o que deveria dizer" aberto e o tamanho da janela de linhas vivem em `layState.tab*`.
// ---------------------------------------------------------------------------------------------

const TAB_READING_BULK_NOTE = 'Conferido em bloco: o anúncio estimado corresponde ao elemento.';

function tabReadingRows() {
  return auditModel ? buildTabReadingPlan(auditModel) : [];
}

function tabReadingProgressText(progress) {
  return `${progress.answered} de ${progress.total} conferidos`;
}

// O leitor em voz alta nasce no primeiro clique e só liga com voz local em português; sem voz local, o
// botão avisa que a extensão não manda texto para serviço de voz on-line (ver `src/reader/speech.js`).
let tabReadingSpeaker = null;
let tabReadingSpeakerReady = null;

function prepareTabReadingSpeaker() {
  if (!tabReadingSpeaker) {
    tabReadingSpeaker = createSpeaker();
    tabReadingSpeakerReady = tabReadingSpeaker.prepare()
      .then(() => tabReadingSpeaker.setEnabled(Boolean(tabReadingSpeaker.voice())))
      .catch(() => false);
  }
  return tabReadingSpeakerReady;
}

async function speakTabReadingRow(row) {
  if (!row.announcement) {
    status.textContent = 'Este ponto não tem prévia de anúncio para ler em voz alta.';
    return;
  }
  const enabled = await prepareTabReadingSpeaker();
  if (!enabled) {
    status.textContent = TAB_READING_NO_VOICE_MESSAGE;
    return;
  }
  status.textContent = `Lendo em voz alta: ${row.announcement}`;
  await tabReadingSpeaker.speak(row.announcement);
}

function tabReadingStateTone(answer) {
  if (answer === 'conforme') return 'sim';
  if (answer === 'não conforme') return 'nao';
  return 'nao-sei';
}

function tabReadingImageCell(row) {
  const cell = document.createElement('td');
  // O rótulo da coluna vai em cada célula: em tela estreita a tabela se empilha e cada célula precisa
  // dizer a que coluna pertence sem depender do cabeçalho, que sai de vista.
  cell.setAttribute('data-tab-cell', 'Imagem do elemento');
  const media = cardMedia(row);
  if (media) cell.append(cropBlock(media, row, { shortLegend: true }));
  else cell.append(el('p', 'A auditoria não guardou imagem deste elemento.', 'lay-crop-caption'));
  return cell;
}

// O seletor CSS vai fechado dentro de "Detalhe técnico": para quem audita a página ele é útil, mas na
// coluna estreita ele empurrava para fora o que a pessoa precisa ler ("Tab 3 · botão"). O destaque
// fica com a ordem e o tipo do elemento; o jargão espera quem quiser abrir.
function tabReadingElementCell(row) {
  const cell = document.createElement('td');
  cell.setAttribute('data-tab-cell', 'Ordem / elemento');
  cell.append(el('p', `Tab ${row.number} · ${row.element?.roleWord ?? 'elemento'}`, 'lay-tab-order'));
  const selector = row.evidence?.selector?.css;
  if (typeof selector === 'string' && selector) {
    const details = document.createElement('details');
    details.className = 'lay-tab-detail';
    details.append(el('summary', 'Detalhe técnico'), el('code', selector, 'lay-tab-selector'));
    cell.append(details);
  }
  return cell;
}

function tabReadingNameCell(row) {
  const cell = document.createElement('td');
  cell.setAttribute('data-tab-cell', 'Nome e função');
  const name = row.element?.name;
  cell.append(el('p', name ? `“${name}”` : 'Sem nome acessível', name ? '' : 'no-name'));
  cell.append(el('p', capitalized(row.element?.roleWord ?? 'elemento'), 'lay-meta'));
  return cell;
}

function tabReadingAnnouncementCell(row) {
  const cell = document.createElement('td');
  cell.setAttribute('data-tab-cell', 'Anúncio estimado');
  cell.append(el('p', row.announcement ?? 'Prévia não disponível'));
  if (row.announcement) {
    const listen = button(TAB_READING_LISTEN_LABEL, 'lay-tab-listen', () => { void speakTabReadingRow(row); });
    listen.setAttribute('aria-label', `${TAB_READING_LISTEN_LABEL} o anúncio estimado de ${tabReadingRowLabel(row)}`);
    cell.append(listen);
  }
  return cell;
}

// Frase de leigo para a resposta registrada, compartilhada com o arquivo entregue
// (`TAB_READING_ANSWER_TEXT`): a pessoa responde "Sim / Não / Não sei" a uma pergunta sobre o anúncio;
// repetir aqui o rótulo jurídico ("Não conforme (não atende ao item)") obrigaria ela a traduzir o próprio
// clique. O quadro segue a resposta pela cor (`data-lay-answer`, a mesma chave dos cartões comuns) — antes
// o atributo era outro e o CSS deixava o quadro verde em qualquer resposta.
function tabReadingAnsweredLine(row) {
  const decision = row.decision;
  const wrap = el('div', undefined, 'lay-answered');
  wrap.setAttribute('data-lay-answer', decision.answer);
  const revisions = decision.revisions?.length ? ` · revista ${decision.revisions.length} ${decision.revisions.length === 1 ? 'vez' : 'vezes'}` : '';
  wrap.append(el('p', TAB_READING_ANSWER_TEXT[decision.answer] ?? `Sua resposta: ${ANSWER_LABELS[decision.answer]}.`));
  wrap.append(el('p', `${decision.evaluator}, ${formatLocalInstant(decision.decidedAt, auditModel.timezone)}${revisions}.`, 'lay-answered-meta'));
  if (decision.note) {
    wrap.append(el('p', `${decision.answer === 'não conforme' ? 'O que deveria dizer' : 'Observação'}: ${decision.note}`, 'lay-answered-note'));
  }
  wrap.append(button('Rever resposta', 'lay-revise', () => {
    layState.tabRevising.add(row.occurrenceId);
    const fresh = refreshTabReading();
    focusTabReadingRow(fresh, row.occurrenceId, 'answers');
  }));
  return wrap;
}

function tabReadingAnswerForm(row) {
  const form = el('div', undefined, 'lay-answer-form');
  const answers = el('div', undefined, 'lay-answers');
  answers.setAttribute('role', 'group');
  answers.setAttribute('aria-label', `${TAB_READING_QUESTION} ${tabReadingRowLabel(row)}.`);
  const asking = layState.tabAsking.has(row.occurrenceId);
  const finding = el('div', undefined, 'lay-finding');
  finding.hidden = !asking;
  const findingLabel = el('label', 'O que deveria dizer? (opcional)');
  const findingText = document.createElement('textarea');
  findingText.rows = 3;
  findingText.maxLength = 4000;
  findingText.value = layState.tabDrafts.get(row.occurrenceId) ?? '';
  findingText.setAttribute('aria-label', `O que deveria dizer no lugar do anúncio atual — ${tabReadingRowLabel(row)}`);
  findingText.addEventListener('input', () => layState.tabDrafts.set(row.occurrenceId, findingText.value));
  findingLabel.append(findingText);
  const actions = el('div', undefined, 'lay-finding-actions');
  actions.append(
    button('Registrar “Não”', 'lay-confirm-fail', event => {
      void saveTabReadingAnswer(row, 'não conforme', findingText.value, event.currentTarget);
    }),
    button('Cancelar', 'lay-cancel', () => {
      layState.tabAsking.delete(row.occurrenceId);
      const fresh = refreshTabReading();
      focusTabReadingRow(fresh, row.occurrenceId, 'answers');
    }),
  );
  finding.append(findingLabel, el('p', 'Deixando em branco, a constatação diz apenas que o anúncio não corresponde ao elemento.', 'lay-hint'), actions);
  for (const option of TAB_READING_ANSWERS) {
    const choice = button(option.label, `lay-answer lay-answer--${option.tone}`, event => {
      if (option.answer === 'não conforme') {
        layState.tabAsking.add(row.occurrenceId);
        const fresh = refreshTabReading();
        focusTabReadingRow(fresh, row.occurrenceId, 'note');
        return;
      }
      void saveTabReadingAnswer(row, option.answer, '', event.currentTarget);
    });
    choice.setAttribute('data-tab-reading-answer', option.answer);
    // O rótulo de cada botão nomeia o elemento: quem navega por leitor de tela ouve "Sim — Tab 3, botão
    // “Buscar”" em vez de três "Sim" soltos pelo documento inteiro.
    choice.setAttribute('aria-label', `${option.label} — ${tabReadingRowLabel(row)}`);
    answers.append(choice);
  }
  form.append(answers, finding);
  return form;
}

function tabReadingQuestionCell(row) {
  const cell = document.createElement('td');
  cell.className = 'lay-tab-question';
  cell.setAttribute('data-tab-cell', 'Pergunta');
  cell.append(el('p', TAB_READING_QUESTION, 'lay-q'));
  for (const hint of row.hints) cell.append(el('p', `${TAB_READING_HINT_LABEL}: ${hint}`, 'lay-hint'));
  if (row.answered && !layState.tabRevising.has(row.occurrenceId)) cell.append(tabReadingAnsweredLine(row));
  else {
    if (layState.tabRevising.has(row.occurrenceId)) cell.append(el('p', 'Revendo a resposta. A anterior continua registrada no histórico.', 'lay-hint'));
    cell.append(tabReadingAnswerForm(row));
  }
  return cell;
}

function tabReadingRowNode(row) {
  const tr = document.createElement('tr');
  tr.className = 'lay-tab-row';
  tr.setAttribute('data-tab-reading-row', row.occurrenceId);
  if (row.answered) tr.setAttribute('data-tab-reading-state', tabReadingStateTone(row.decision.answer));
  tr.append(tabReadingImageCell(row), tabReadingElementCell(row), tabReadingNameCell(row),
    tabReadingAnnouncementCell(row), tabReadingQuestionCell(row));
  return tr;
}

/** Janela de linhas: blocos de 20, com o filtro de pendentes por cima. */
function tabReadingWindow(rows) {
  const state = layState.tab;
  if (!Number.isSafeInteger(state.visible) || state.visible <= 0) state.visible = TAB_READING_BLOCK;
  const filtered = state.onlyPending ? rows.filter(row => !row.answered) : rows;
  return {
    filtered,
    shown: filtered.slice(0, state.visible),
    hidden: Math.max(0, filtered.length - state.visible),
  };
}

function nextPendingTabReadingRow(rows, occurrenceId) {
  const state = layState.tab;
  const filtered = state.onlyPending ? rows.filter(row => !row.answered) : rows;
  const index = filtered.findIndex(row => row.occurrenceId === occurrenceId);
  return filtered.slice(index + 1).find(row => !row.answered) ?? filtered.find(row => !row.answered) ?? null;
}

/** O próximo ponto pode estar fora da janela: sem isto o foco iria para uma linha que não está na tela. */
function ensureTabReadingRowVisible(row) {
  if (!row || !layState.tabSection) return;
  const rows = tabReadingRows();
  const state = layState.tab;
  const filtered = state.onlyPending ? rows.filter(value => !value.answered) : rows;
  const index = filtered.findIndex(value => value.occurrenceId === row.occurrenceId);
  if (index >= state.visible) state.visible = Math.ceil((index + 1) / TAB_READING_BLOCK) * TAB_READING_BLOCK;
}

/**
 * Foco depois de responder, filtrar ou ampliar: a linha seguinte ainda sem resposta. Sem isto a pessoa
 * teria que voltar ao começo da tabela a cada resposta — e a sequência de Tab é o que está sendo
 * conferido, então perder o lugar é perder o fio.
 */
function focusTabReadingRow(section, occurrenceId, target = 'answers') {
  const scope = section ?? layState.tabSection;
  if (!scope || typeof scope.querySelectorAll !== 'function') return;
  const nodes = [...scope.querySelectorAll('tr[data-tab-reading-row]')];
  const index = nodes.findIndex(node => node.getAttribute?.('data-tab-reading-row') === occurrenceId);
  const pending = nodes.filter(node => !node.getAttribute?.('data-tab-reading-state'));
  const next = nodes.slice(index + 1).find(node => !node.getAttribute?.('data-tab-reading-state')) ?? pending[0] ?? null;
  const selector = target === 'note' ? '.lay-tab-question textarea' : target === 'answers' ? '.lay-tab-question .lay-answers button' : '.lay-tab-question button';
  const targetNode = next
    ? next.querySelector?.(selector) ?? next.querySelector?.('button')
    : scope.querySelector?.('[data-tab-reading-done]');
  try { targetNode?.focus?.(); } catch { /* foco é conveniência: perder ele não invalida a resposta */ }
}

async function saveTabReadingAnswer(row, answer, note, trigger) {
  if (!auditModel || !reportSessionCapabilityId) return false;
  if (!evaluatorNameOrWarn()) return false;
  const problem = noteProblem(note, false);
  if (problem) { status.textContent = problem; return false; }
  const occurrence = reportOccurrence(row.occurrenceId);
  const auditId = auditModel.auditId;
  if (!occurrence) { status.textContent = 'Este ponto da sequência de Tab não está mais nesta auditoria.'; return false; }
  const node = layState.tabNodes.get(row.occurrenceId) ?? layState.tabSection ?? list;
  const text = typeof note === 'string' ? note.trim() : '';
  let saved = false;
  try {
    saved = await saveDecisionBatch([{ occurrence, answer, note: text, revise: Boolean(row.decision) }], node, trigger);
  } catch (error) {
    node.removeAttribute?.('aria-busy');
    status.textContent = describeSaveFailure(error);
    refreshTabReading();
    return false;
  }
  if (!auditModel || auditModel.auditId !== auditId) return false;
  layState.tabDrafts.delete(row.occurrenceId);
  layState.tabAsking.delete(row.occurrenceId);
  layState.tabRevising.delete(row.occurrenceId);
  if (saved) {
    const next = nextPendingTabReadingRow(tabReadingRows(), row.occurrenceId);
    ensureTabReadingRowVisible(next);
    status.textContent = next
      ? `Resposta salva. Próximo ponto da sequência: ${tabReadingRowLabel(next)}.`
      : 'Resposta salva. Todos os pontos desta lista foram conferidos.';
  } else status.textContent = 'Nada a salvar: essa resposta já estava registrada.';
  const fresh = refreshTabReading();
  focusTabReadingRow(fresh, row.occurrenceId);
  return saved;
}

function openTabBulkConfirmation(rows, trigger) {
  if (!rows.length || !evaluatorNameOrWarn()) return;
  const first = rows[0];
  const last = rows[rows.length - 1];
  const points = rows.length === 1 ? '1 ponto' : `${rows.length} pontos`;
  tabBulkSummary.textContent = `Isto grava “Sim” (o anúncio corresponde ao elemento) em ${points}, de Tab ${first.number} a Tab ${last.number}. Cada ponto vira uma resposta registrada em seu nome no item 5.13.10 e pode ser revisto depois, um por um.`;
  tabBulkRun = () => runTabBulkMarking(rows);
  tabBulkController.open(trigger);
}

/** Grava "Sim" nos pontos pendentes do bloco, em lotes (o envelope aceita até 64 decisões por vez). */
async function runTabBulkMarking(rows) {
  if (!auditModel || !reportSessionCapabilityId) return { ok: false, error: 'A revisão não está ativa nesta auditoria.' };
  if (!evaluatorNameOrWarn()) return { ok: false, error: 'Informe o nome da pessoa avaliadora antes de responder.' };
  const auditId = auditModel.auditId;
  const entries = [];
  for (const row of rows) {
    const occurrence = reportOccurrence(row.occurrenceId);
    if (occurrence && !row.answered) entries.push({ occurrence, answer: 'conforme', note: TAB_READING_BULK_NOTE });
  }
  if (!entries.length) return { ok: false, error: 'Nenhum ponto pendente neste bloco.' };
  const node = layState.tabSection ?? list;
  try {
    for (let start = 0; start < entries.length; start += 64) {
      await saveDecisionBatch(entries.slice(start, start + 64), node, tabBulkConfirm);
      if (!auditModel || auditModel.auditId !== auditId) break;
    }
  } catch (error) {
    status.textContent = describeSaveFailure(error);
    refreshTabReading();
    return { ok: false, error: describeSaveFailure(error) };
  }
  if (!auditModel || auditModel.auditId !== auditId) return { ok: false, error: 'A auditoria mudou durante o salvamento. Tente de novo.' };
  layState.tabDrafts.clear();
  const fresh = refreshTabReading();
  focusTabReadingRow(fresh, entries.at(-1).occurrence.occurrenceId);
  return { ok: true };
}

function tabReadingSection(rows) {
  const state = layState.tab;
  const section = el('section', undefined, 'lay-tab-reading');
  section.id = 'lay-tab-reading';
  const heading = el('h3', TAB_READING_SECTION_TITLE);
  heading.id = 'lay-tab-reading-title';
  section.setAttribute('aria-labelledby', heading.id);
  section.append(heading);
  section.append(el('p', TAB_READING_INTRO, 'lay-meta'));
  const progress = tabReadingProgress(rows);
  const progressLine = el('p', tabReadingProgressText(progress), 'lay-tab-progress');
  progressLine.setAttribute('data-tab-reading-progress', `${progress.answered}/${progress.total}`);
  section.append(progressLine);
  const meter = document.createElement('progress');
  meter.max = progress.total;
  meter.value = progress.answered;
  meter.setAttribute('aria-label', 'Pontos da sequência de Tab conferidos');
  section.append(meter);
  const controls = el('div', undefined, 'lay-tab-controls');
  const onlyPendingLabel = el('label', undefined, 'lay-toggle');
  const onlyPending = document.createElement('input');
  onlyPending.type = 'checkbox';
  onlyPending.checked = state.onlyPending;
  onlyPending.addEventListener('change', () => {
    state.onlyPending = onlyPending.checked;
    state.visible = TAB_READING_BLOCK;
    refreshTabReading()?.querySelector?.('input[type="checkbox"]')?.focus?.();
  });
  onlyPendingLabel.append(onlyPending, document.createTextNode(' Só pendentes'));
  controls.append(onlyPendingLabel);
  section.append(controls);

  const { filtered, shown, hidden } = tabReadingWindow(rows);
  layState.tabNodes.clear();
  if (!filtered.length) {
    const done = el('p', 'Todos os pontos desta sequência foram conferidos.', 'lay-tab-progress');
    done.setAttribute('data-tab-reading-done', '');
    done.tabIndex = -1;
    section.append(done);
    return section;
  }
  const scroll = el('div', undefined, 'lay-tab-scroll');
  scroll.tabIndex = 0;
  scroll.setAttribute('role', 'region');
  scroll.setAttribute('aria-label', `${TAB_READING_SECTION_TITLE}: tabela dos pontos conferidos`);
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  for (const name of ['Imagem do elemento', 'Ordem / elemento', 'Nome e função', 'Anúncio estimado', 'Pergunta']) {
    const th = el('th', name);
    th.scope = 'col';
    headerRow.append(th);
  }
  thead.append(headerRow);
  table.append(thead);
  const tbody = document.createElement('tbody');
  for (const row of shown) {
    const node = tabReadingRowNode(row);
    layState.tabNodes.set(row.occurrenceId, node);
    tbody.append(node);
  }
  table.append(tbody);
  scroll.append(table);
  section.append(scroll);

  const bulk = button('Marcar todos os pendentes deste bloco como “Sim”', 'lay-tab-bulk', event => {
    openTabBulkConfirmation(shown.filter(row => !row.answered), event.currentTarget);
  });
  const pendingInBlock = shown.filter(row => !row.answered).length;
  bulk.disabled = pendingInBlock === 0;
  if (pendingInBlock === 0) bulk.title = 'Nenhum ponto pendente nas linhas mostradas.';
  section.append(bulk);
  if (hidden > 0) {
    const step = Math.min(TAB_READING_BLOCK, hidden);
    const more = button(`Mostrar mais ${step} de ${hidden} ${hidden === 1 ? 'ponto' : 'pontos'}`, 'lay-more', () => {
      state.visible += TAB_READING_BLOCK;
      const fresh = refreshTabReading();
      focusTabReadingRow(fresh, shown.at(-1)?.occurrenceId ?? '', 'answers');
    });
    more.setAttribute('data-tab-reading-more', String(hidden));
    section.append(more);
  }
  return section;
}

function refreshTabReading() {
  const current = layState.tabSection;
  const rows = tabReadingRows();
  const fresh = rows.length ? tabReadingSection(rows) : null;
  if (fresh && current && typeof current.replaceWith === 'function') current.replaceWith(fresh);
  else if (fresh && !current) list.append(fresh);
  if (fresh) layState.tabSection = fresh;
  return fresh ?? current;
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
