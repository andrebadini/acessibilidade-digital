import { createReviewDecision } from '../core/review/decisions.js';
import { accessibilityGuidance } from '../core/report/plain-language-guidance.js';
import { createInstalledCoreRuleInventory } from '../core/rules/core-rule-inventory.js';
import { buildCompleteReportSummary } from '../panel/panel-summary.js';
import { createAuditStore } from '../storage/audit-store.js';
import { createDestructiveDialog } from '../ui/destructive-dialog.js';
import { parseAuditDeletedEvent } from '../core/audit-deleted-event.js';
import { createAuthorizedReviewDecisionCommitter, getPendingReviewEntries, isSafeEvidenceImageUrl, normalizeReviewAuditId } from './review-state.js';
import { applyReportSourceControls, buildReportView, renderReportView, updateReportHighlightAction } from './report-view.js';
import { REPORT_PORT_NAME } from '../background/report-port.js';
import { createReportHighlightPolicy } from './report-highlight-policy.js';

const ANSWERS = ['conforme', 'não conforme', 'não foi possível determinar'];
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
  const matches = auditModel.occurrences.filter(value => value?.occurrenceId === occurrenceId);
  return matches.length === 1 ? matches[0] : null;
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
  const response = await sendWorkerRequest({
    type, sessionCapabilityId: reportSessionCapabilityId, auditId: auditModel.auditId,
    ...(occurrenceId === null ? {} : { occurrenceId }),
  });
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
    const response = await sendWorkerRequest({
      type: 'REPORT_DELETE_AUDIT', sessionCapabilityId: reportSessionCapabilityId,
      auditId: auditModel.auditId,
    });
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

async function requestExport({ deleteAfterCompleteExport = false } = {}) {
  if (!auditModel?.auditId) return;
  regenerate.disabled = true;
  status.textContent = 'Solicitando a geração do relatório.';
  const response = await sendWorkerRequest({
    type: 'REPORT_REQUEST_EXPORT', sessionCapabilityId: reportSessionCapabilityId, auditId: auditModel.auditId,
    deleteAfterCompleteExport: deleteAfterCompleteExport === true,
  });
  regenerate.disabled = false;
  status.textContent = response?.ok ? 'Relatório atualizado na fila de geração.' : 'Não foi possível gerar o relatório atualizado.';
}

async function returnToAuditedPage() {
  if (reportSessionState !== 'result' || !auditModel?.auditId || !reportSessionCapabilityId) return;
  returnToPage.disabled = true;
  status.textContent = 'Retornando à página auditada e ao painel lateral.';
  const response = await sendWorkerRequest({
    type: 'REPORT_RETURN_TO_SOURCE',
    sessionCapabilityId: reportSessionCapabilityId,
    auditId: auditModel.auditId,
  });
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

function appendText(parent, tag, value, className) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = value;
  parent.append(element);
  return element;
}

function evidenceFor(occurrence) {
  const ids = new Set(occurrence.evidenceRefs || occurrence.evidenceIds || []);
  return (Array.isArray(auditModel.evidence) ? auditModel.evidence : []).filter(item => ids.has(item.evidenceId));
}

function nextUnanswered(card) {
  let next = card.nextElementSibling;
  while (next?.classList.contains('answered')) next = next.nextElementSibling;
  if (next) next.open = true;
  (next?.querySelector('summary') || document.querySelector('a[href="#report-root"]'))?.focus();
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
  reviewTarget.open = previousTarget?.open === true;
  // Keep the actual forms: notes, pending buttons and their handlers are not rebuilt.
  reviewTarget.parentElement.insertBefore(reviewControls, reviewTarget);
  reviewTarget.append(list);
  reportRoot.replaceChildren(report);
  evidenceAnchorById = new Map(view.technicalEvidence.map((evidence, index) =>
    [evidence.evidenceId, `report-evidence-${index + 1}`]));
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

async function saveDecision(occurrence, answer, note, card, trigger) {
  if (!auditModel || !reportSessionCapabilityId) return;
  const session = reportSessionCapabilityId;
  const evaluatorName = evaluator.value.trim();
  if (!evaluatorName) {
    status.textContent = 'Informe o nome da pessoa avaliadora antes de responder.';
    evaluator.focus();
    return;
  }
  const decision = createReviewDecision({
    auditId: auditModel.auditId, itemId: occurrence.itemId, occurrenceId: occurrence.occurrenceId,
    answer, evaluator: evaluatorName, note, decidedAt: new Date().toISOString(), mode: occurrence.mode === 'manual' ? 'manual' : 'assisted',
  });
  const committed = await commitDecision({
    auditModel,
    input: decision,
    requestCommit: authorizedDecision => sendWorkerRequest({
      type: 'REPORT_COMMIT_REVIEW_DECISION', sessionCapabilityId: reportSessionCapabilityId,
      auditId: authorizedDecision.auditId, itemId: authorizedDecision.itemId,
      occurrenceId: authorizedDecision.occurrenceId, answer: authorizedDecision.answer,
      evaluator: authorizedDecision.evaluator, decidedAt: authorizedDecision.decidedAt,
      mode: authorizedDecision.mode, note: authorizedDecision.note ?? '',
    }),
    loadReportRevision: auditId => store.getReportRevision(auditId),
    controls: card.querySelectorAll('button'),
    retryFocus: trigger,
    onPendingChange(pending) {
      card.toggleAttribute('aria-busy', pending);
      if (pending) status.textContent = `Salvando decisão para o item ${occurrence.itemId}.`;
    },
  });
  if (committed.status === 'duplicate') return;
  if (!auditModel || auditModel.auditId !== decision.auditId || reportSessionCapabilityId !== session) return;
  card.removeAttribute('aria-busy');
  card.classList.add('answered');
  nextUnanswered(card);
  if (committed.modelRevision <= reportModelRevision) return;
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
}

function renderCard(entry) {
  const occurrence = auditModel.occurrences.find(value => value.occurrenceId === entry.occurrenceId);
  const item = auditModel.itemResults.find(value => value.id === entry.itemId);
  if (!occurrence || !item) return;
  const card = document.createElement('details');
  card.className = 'review-card';
  card.id = `review-${occurrence.occurrenceId.replace(/[^A-Za-z0-9_-]/gu, '-')}`;
  appendText(card, 'summary', `Item ${item.id} — ${entry.question || item.title}`);
  const guidance = accessibilityGuidance({ itemId: item.id, title: item.title, outcome: 'cantTell',
    observed: entry.reason || occurrence.justification || item.humanReason });
  appendText(card, 'h3', 'Como revisar este resultado');
  appendText(card, 'p', guidance.impact);
  appendText(card, 'p', guidance.observed);
  const steps = document.createElement('ol');
  for (const step of guidance.reviewSteps) appendText(steps, 'li', step);
  card.append(steps);
  appendText(card, 'p', guidance.example);
  appendText(card, 'p', 'Escolha “conforme” somente se você conseguiu verificar que o requisito é atendido; “não conforme” se confirmou a barreira. Se não conseguiu testar ou ficou em dúvida, escolha “não foi possível determinar”. A dúvida não deve virar aprovação nem reprovação. Descreva na nota o que testou e o que aconteceu.');
  appendText(card, 'p', `ABNT NBR 17225 — item ${item.id} (${item.classification || 'classificação não informada'}).`);
  if (typeof item.printedId === 'string' && item.printedId !== item.id) {
    appendText(card, 'p', `Nota editorial: a impressão consultada mostra “${item.printedId}”; esta ferramenta usa a referência normalizada “${item.id}” da Seção 5, sem atribuir errata à ABNT.`);
  }
  const wcag = (item.wcag || []).map(reference => `${reference.id || reference} nível ${reference.level || ''}`.trim()).join(', ');
  appendText(card, 'p', `WCAG: ${wcag || 'sem referência vinculada'}.`);
  appendText(card, 'p', `Razão: ${entry.reason || occurrence.justification || item.humanReason || 'revisão humana necessária'}.`);
  const technical = document.createElement('details');
  appendText(technical, 'summary', 'Consultar código e evidências desta revisão');
  card.append(technical);
  for (const evidence of evidenceFor(occurrence)) {
    if (evidence.selector?.css) appendText(technical, 'code', `Seletor: ${evidence.selector.css}`);
    if (evidence.snippet) appendText(technical, 'code', evidence.snippet);
    // The original full-page image is already in the report annex. Refer to it
    // instead of embedding the same potentially large raster in every form.
    if (evidence.kind === 'full-page') {
      const anchor = evidenceAnchorById.get(evidence.evidenceId);
      if (anchor) {
        const link = appendText(technical, 'a', 'Ver captura completa da página nas evidências');
        link.href = `#${anchor}`;
        link.addEventListener('click', event => {
          const target = document.getElementById(anchor);
          if (!target) return;
          event.preventDefault();
          for (let parent = target.parentElement; parent; parent = parent.parentElement) {
            if (parent.tagName === 'DETAILS') parent.open = true;
          }
          target.setAttribute('tabindex', '-1'); target.focus(); target.scrollIntoView({ block: 'start' });
        });
      } else appendText(technical, 'p', 'Captura completa indisponível nesta revisão.');
      continue;
    }
    if (isSafeEvidenceImageUrl(evidence.dataUrl, chrome.runtime.getURL('/'))) {
      const image = document.createElement('img');
      image.className = 'evidence-media';
      image.src = evidence.dataUrl;
      image.alt = evidence.kind === 'full-page' ? 'Captura completa da página auditada' : `Captura do elemento relacionado ao item ${item.id}`;
      technical.append(image);
    }
  }
  const noteLabel = appendText(card, 'label', 'Nota opcional');
  const note = document.createElement('textarea');
  note.rows = 3;
  noteLabel.append(note);
  const answers = document.createElement('div');
  answers.className = 'answers';
  for (const answer of ANSWERS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = answer;
    button.addEventListener('click', () => {
      void saveDecision(occurrence, answer, note.value, card, button).catch(() => { status.textContent = 'Não foi possível salvar a decisão.'; });
    });
    answers.append(button);
  }
  const skip = document.createElement('button');
  skip.type = 'button';
  skip.textContent = 'Pular revisão';
  skip.addEventListener('click', () => { status.textContent = 'Revisão pulada; o resultado permanece indeterminado.'; nextUnanswered(card); });
  answers.append(skip);
  card.append(answers);
  list.append(card);
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
  for (const entry of getPendingReviewEntries(auditModel)) renderCard(entry);
  const latest = await store.getLatest();
  status.textContent = latest?.auditId === id && latest?.exportCleanupPending === true ? EXPORT_CLEANUP_MESSAGE
    : `${summary.counts.errors.occurrences} falhas confirmadas; ${summary.counts.humanReview.occurrences} suspeitas a confirmar. Checklist separado: ${summary.checklist?.length ?? 0} verificações ainda sem conclusão.`;
}

void start().catch(() => { status.textContent = 'Não foi possível carregar a revisão.'; });
