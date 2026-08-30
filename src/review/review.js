import { createReviewDecision } from '../core/review/decisions.js';
import { createInstalledCoreRuleInventory } from '../core/rules/core-rule-inventory.js';
import { createPanelResultBundleV1 } from '../panel/panel-result-bundle.js';
import { createAuditStore } from '../storage/audit-store.js';
import { createDestructiveDialog } from '../ui/destructive-dialog.js';
import { parseAuditDeletedEvent } from '../core/audit-deleted-event.js';
import { createAuthorizedReviewDecisionCommitter, getPendingReviewEntries, isSafeEvidenceImageUrl, normalizeReviewAuditId } from './review-state.js';
import { buildReportView, renderReportView } from './report-view.js';

const ANSWERS = ['conforme', 'não conforme', 'não foi possível determinar'];
const list = document.querySelector('#review-list');
const reportRoot = document.querySelector('#report-root');
const reviewControls = document.querySelector('.review-controls');
const status = document.querySelector('#review-status');
const evaluator = document.querySelector('#review-evaluator');
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
let reportSessionCapabilityId = null;

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
  reportSessionCapabilityId = null;
  list.replaceChildren();
  evaluator.disabled = true;
  regenerate.disabled = true;
  deleteAudit.disabled = true;
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
    if (response.ok === true) renderDeletedAudit();
    return response;
  },
  successMessage: 'Auditoria local excluída. Downloads já salvos foram preservados.',
  failureMessage: 'Não foi possível excluir a auditoria local.',
});

deleteAudit.addEventListener('click', () => deleteAuditController.open(deleteAudit));

async function requestExport() {
  if (!auditModel?.auditId) return;
  regenerate.disabled = true;
  status.textContent = 'Solicitando a geração do relatório.';
  const response = await sendWorkerRequest({
    type: 'REPORT_REQUEST_EXPORT', sessionCapabilityId: reportSessionCapabilityId, auditId: auditModel.auditId,
  });
  regenerate.disabled = false;
  status.textContent = response?.ok ? 'Relatório atualizado na fila de geração.' : 'Não foi possível gerar o relatório atualizado.';
}

regenerate.addEventListener('click', () => { void requestExport(); });

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
  (next?.querySelector('button') || document.querySelector('a[href="../panel/index.html"]'))?.focus();
}

async function saveDecision(occurrence, answer, note, card, trigger) {
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
  auditModel = committed.model;
  card.removeAttribute('aria-busy');
  card.classList.add('answered');
  status.textContent = `Decisão salva para o item ${occurrence.itemId}.`;
  nextUnanswered(card);
}

function renderCard(entry) {
  const occurrence = auditModel.occurrences.find(value => value.occurrenceId === entry.occurrenceId);
  const item = auditModel.itemResults.find(value => value.id === entry.itemId);
  if (!occurrence || !item) return;
  const card = document.createElement('article');
  card.className = 'review-card';
  card.id = `review-${occurrence.occurrenceId.replace(/[^A-Za-z0-9_-]/gu, '-')}`;
  appendText(card, 'h3', entry.question || `O item “${item.title}” está conforme no contexto apresentado?`);
  appendText(card, 'p', `ABNT NBR 17225 — item ${item.id} (${item.classification || 'classificação não informada'}).`);
  if (typeof item.printedId === 'string' && item.printedId !== item.id) {
    appendText(card, 'p', `Nota editorial: a impressão consultada mostra “${item.printedId}”; esta ferramenta usa a referência normalizada “${item.id}” da Seção 5, sem atribuir errata à ABNT.`);
  }
  const wcag = (item.wcag || []).map(reference => `${reference.id || reference} nível ${reference.level || ''}`.trim()).join(', ');
  appendText(card, 'p', `WCAG: ${wcag || 'sem referência vinculada'}.`);
  appendText(card, 'p', `Razão: ${entry.reason || occurrence.justification || item.humanReason || 'revisão humana necessária'}.`);
  for (const evidence of evidenceFor(occurrence)) {
    if (evidence.selector?.css) appendText(card, 'code', `Seletor: ${evidence.selector.css}`);
    if (evidence.snippet) appendText(card, 'code', evidence.snippet);
    if (isSafeEvidenceImageUrl(evidence.dataUrl, chrome.runtime.getURL('/'))) {
      const image = document.createElement('img');
      image.className = 'evidence-media';
      image.src = evidence.dataUrl;
      image.alt = evidence.kind === 'full-page' ? 'Captura completa da página auditada' : `Captura do elemento relacionado ao item ${item.id}`;
      card.append(image);
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
  if (!connected?.ok || connected.auditId !== id || connected.state !== 'view-only') { status.textContent = 'Relatório não autorizado.'; return; }
  reportSessionCapabilityId = connected.sessionCapabilityId;
  const [revision, inventory] = await Promise.all([store.getReportRevision(id), createInstalledCoreRuleInventory()]);
  if (!revision || revision.auditId !== id) { status.textContent = 'Auditoria não encontrada.'; return; }
  const bundle = await createPanelResultBundleV1({ reportRevision: revision, inventory });
  const view = buildReportView({ model: revision.model, summary: bundle.summary, modelRevision: revision.modelRevision, modelHash: revision.modelHash });
  auditModel = revision.model;
  const report = renderReportView({ view, document, onExport: () => { void requestExport(); } });
  reportRoot.replaceChildren(report);
  const reviewTarget = report.querySelector('[data-review-controls-target]');
  reviewTarget.append(reviewControls, list);
  deleteAudit.disabled = false;
  for (const entry of getPendingReviewEntries(auditModel)) renderCard(entry);
  const latest = await store.getLatest();
  status.textContent = latest?.auditId === id && latest?.exportCleanupPending === true ? EXPORT_CLEANUP_MESSAGE
    : list.childElementCount ? `${list.childElementCount} ocorrências aguardam revisão.` : 'Não há ocorrências para revisar.';
}

void start().catch(() => { status.textContent = 'Não foi possível carregar a revisão.'; });
