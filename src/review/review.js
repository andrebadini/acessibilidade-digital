import { createReviewDecision } from '../core/review/decisions.js';
import { applyExportEvent, restoreExportEventState } from '../panel/panel-state.js';
import { createAuditStore } from '../storage/audit-store.js';
import { createDestructiveDialog } from '../ui/destructive-dialog.js';
import { createReviewDecisionCommitter, getPendingReviewEntries, isSafeEvidenceImageUrl, normalizeReviewAuditId } from './review-state.js';

const ANSWERS = ['conforme', 'não conforme', 'não foi possível determinar'];
const list = document.querySelector('#review-list');
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
const commitDecision = createReviewDecisionCommitter();
let auditModel;
let exportEventState = {};

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
  exportEventState = {};
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
  async onConfirm() {
    if (!auditModel?.auditId) return { ok: false, error: 'Auditoria não encontrada ou já excluída.' };
    const response = await sendWorkerRequest({
      type: 'REQUEST_DELETE_AUDIT', auditId: auditModel.auditId,
    });
    if (response.ok === true) renderDeletedAudit();
    return response;
  },
  successMessage: 'Auditoria local excluída. Downloads já salvos foram preservados.',
  failureMessage: 'Não foi possível excluir a auditoria local.',
});

deleteAudit.addEventListener('click', () => deleteAuditController.open(deleteAudit));

regenerate.addEventListener('click', () => {
  if (!auditModel?.auditId) return;
  regenerate.disabled = true;
  status.textContent = 'Solicitando a geração do relatório.';
  chrome.runtime.sendMessage({ type: 'REQUEST_EXPORT', auditId: auditModel.auditId }, response => {
    regenerate.disabled = false;
    if (chrome.runtime.lastError || !response?.ok) status.textContent = response?.error || 'Não foi possível gerar o relatório atualizado.';
    else {
      const next = applyExportEvent(exportEventState, response, 'queued');
      if (next === exportEventState) return;
      exportEventState = next;
      status.textContent = 'Relatório atualizado na fila de geração.';
    }
  });
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === 'AUDIT_DELETED' && isAuthorizedDeletionMessage(sender) &&
    (message.scope === 'all' || message.auditId === auditModel?.auditId)) {
    renderDeletedAudit();
    status.textContent = 'Auditoria local excluída. Downloads já salvos foram preservados.';
    return;
  }
  if (!auditModel || message?.auditId !== auditModel.auditId) return;
  let nextStatus = null;
  let text = null;
  if (message.type === 'EXPORT_PROGRESS') {
    nextStatus = 'running';
    text = message.message || 'Gerando os arquivos do relatório.';
  }
  if (message.type === 'EXPORT_COMPLETE') {
    nextStatus = message.status === 'partial' ? 'partial' : 'complete';
    text = nextStatus === 'partial' ? 'Relatório gerado com limitações.' : 'Arquivos do relatório gerados.';
  }
  if (message.type === 'EXPORT_FAILED') {
    nextStatus = 'failed';
    text = message.error || 'Não foi possível gerar os arquivos do relatório.';
  }
  if (message.type === 'EXPORT_INVALIDATED') {
    nextStatus = 'preparing';
    text = message.error || 'A auditoria foi atualizada; gere o relatório novamente.';
  }
  if (!nextStatus) return;
  const next = applyExportEvent(exportEventState, message, nextStatus);
  if (next === exportEventState) return;
  exportEventState = next;
  status.textContent = text;
});

function safeAuditId() {
  const value = new URL(location.href).searchParams.get('auditId');
  return normalizeReviewAuditId(value);
}

function isAuthorizedDeletionMessage(sender) {
  if (!sender || sender.id !== chrome.runtime.id) return false;
  if (sender.url === undefined) return !sender.tab;
  try {
    const url = new URL(sender.url);
    return url.protocol === 'chrome-extension:' && url.hostname === chrome.runtime.id && !url.hash &&
      ['/src/background/service-worker.js', '/src/export/index.html'].includes(url.pathname);
  } catch { return false; }
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
    store,
    controls: card.querySelectorAll('button'),
    retryFocus: trigger,
    onPendingChange(pending) {
      card.toggleAttribute('aria-busy', pending);
      if (pending) status.textContent = `Salvando decisão para o item ${occurrence.itemId}.`;
    },
  });
  if (committed.status === 'duplicate') return;
  auditModel = committed.model;
  if (Number.isSafeInteger(committed.exportRevision) && committed.exportRevision >= 0) {
    try {
      chrome.runtime.sendMessage({
        type: 'REVIEW_COMMITTED', auditId: auditModel.auditId,
        exportRevision: committed.exportRevision,
      }, () => { void chrome.runtime.lastError; });
    } catch {}
  }
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
  appendText(card, 'h2', entry.question || `O item “${item.title}” está conforme no contexto apresentado?`);
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
  const latest = await store.getLatest();
  const id = safeAuditId() || normalizeReviewAuditId(latest?.auditId);
  if (!id) { status.textContent = 'Auditoria não identificada.'; return; }
  auditModel = await store.getAudit(id);
  if (!auditModel || auditModel.auditId !== id) { status.textContent = 'Auditoria não encontrada.'; return; }
  deleteAudit.disabled = false;
  if (latest?.auditId === id) exportEventState = restoreExportEventState(latest);
  for (const entry of getPendingReviewEntries(auditModel)) renderCard(entry);
  status.textContent = latest?.auditId === id && latest?.exportCleanupPending === true
    ? EXPORT_CLEANUP_MESSAGE
    : list.childElementCount ? `${list.childElementCount} ocorrências aguardam revisão.` : 'Não há ocorrências para revisar.';
}

void start().catch(() => { status.textContent = 'Não foi possível carregar a revisão.'; });
