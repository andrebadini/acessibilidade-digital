import { createReviewDecision } from '../core/review/decisions.js';
import { createAuditStore } from '../storage/audit-store.js';
import { createReviewDecisionCommitter, getPendingReviewEntries, isSafeEvidenceImageUrl, normalizeReviewAuditId } from './review-state.js';

const ANSWERS = ['conforme', 'não conforme', 'não foi possível determinar'];
const list = document.querySelector('#review-list');
const status = document.querySelector('#review-status');
const evaluator = document.querySelector('#review-evaluator');
const regenerate = document.querySelector('#regenerate-report');
const store = createAuditStore();
const commitDecision = createReviewDecisionCommitter();
let auditModel;

regenerate.addEventListener('click', () => {
  if (!auditModel?.auditId) return;
  regenerate.disabled = true;
  status.textContent = 'Relatório atualizado na fila de geração.';
  chrome.runtime.sendMessage({ type: 'REQUEST_EXPORT', auditId: auditModel.auditId }, response => {
    regenerate.disabled = false;
    if (chrome.runtime.lastError || !response?.ok) status.textContent = response?.error || 'Não foi possível gerar o relatório atualizado.';
    else status.textContent = response.duplicate ? 'A geração do relatório já está em andamento.' : 'Relatório atualizado na fila de geração.';
  });
});

chrome.runtime.onMessage.addListener(message => {
  if (!auditModel || message?.auditId !== auditModel.auditId) return;
  if (message.type === 'EXPORT_PROGRESS') status.textContent = message.message || 'Gerando os arquivos do relatório.';
  if (message.type === 'EXPORT_COMPLETE') status.textContent = message.status === 'partial' ? 'Relatório gerado com limitações.' : 'Arquivos do relatório gerados.';
  if (message.type === 'EXPORT_FAILED') status.textContent = message.error || 'Não foi possível gerar os arquivos do relatório.';
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
  const ids = new Set(occurrence.evidenceIds || []);
  return (auditModel.evidence?.artifacts || []).filter(item => ids.has(item.evidenceId));
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
  appendText(card, 'p', `ABNT NBR 17225 — item ${item.printedId || item.id} (${item.classification || 'classificação não informada'}).`);
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
  const id = safeAuditId() || normalizeReviewAuditId((await store.getLatest())?.auditId);
  if (!id) { status.textContent = 'Auditoria não identificada.'; return; }
  auditModel = await store.getAudit(id);
  if (!auditModel || auditModel.auditId !== id) { status.textContent = 'Auditoria não encontrada.'; return; }
  for (const entry of getPendingReviewEntries(auditModel)) renderCard(entry);
  status.textContent = list.childElementCount ? `${list.childElementCount} ocorrências aguardam revisão.` : 'Não há ocorrências para revisar.';
}

void start().catch(() => { status.textContent = 'Não foi possível carregar a revisão.'; });
