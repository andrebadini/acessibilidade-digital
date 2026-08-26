import { normalizeAuditUrl } from '../core/url.js';
import { createSubmissionGate, isMessageForAudit, isSafeReportUrl, reducePanelState } from './panel-state.js';

const form = document.querySelector('#audit-form');
const input = document.querySelector('#audit-url');
const submit = form.querySelector('button[type="submit"]');
const status = document.querySelector('#audit-status');
const latestReport = document.querySelector('#latest-report');
const submissionGate = createSubmissionGate();
let activeAuditId = null;
let panelState = null;

function setStatus(message) {
  status.textContent = message;
}

function setSubmitting(isSubmitting) {
  submit.disabled = isSubmitting;
}

function clearReport() {
  latestReport.removeAttribute('href');
  latestReport.hidden = true;
  latestReport.setAttribute('aria-disabled', 'true');
}

function showReport(url) {
  latestReport.href = url;
  latestReport.hidden = false;
  latestReport.removeAttribute('aria-disabled');
}

function finishActiveAudit() {
  activeAuditId = null;
  submissionGate.release();
  setSubmitting(false);
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!submissionGate.tryAcquire()) return;
  let url;
  try {
    url = normalizeAuditUrl(input.value);
  } catch (error) {
    finishActiveAudit();
    setStatus(error instanceof Error ? error.message : 'Não foi possível validar o endereço.');
    input.focus();
    return;
  }

  clearReport();
  setSubmitting(true);
  setStatus('Preparando a auditoria.');
  try {
    chrome.runtime.sendMessage({ type: 'START_AUDIT', url }, (response) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        finishActiveAudit();
        setStatus(`Não foi possível iniciar a auditoria: ${runtimeError.message}`);
        return;
      }
      if (!response || response.ok !== true || typeof response.auditId !== 'string') {
        finishActiveAudit();
        setStatus(response?.error || 'Não foi possível iniciar a auditoria.');
        return;
      }
      activeAuditId = response.auditId;
      panelState = { auditId: activeAuditId, status: 'running', percent: 0, message: 'Auditoria preparada. A coleta será iniciada em breve.', reviewUrl: null };
      setStatus(panelState.message);
    });
  } catch (error) {
    finishActiveAudit();
    setStatus(error instanceof Error ? `Não foi possível iniciar a auditoria: ${error.message}` : 'Não foi possível iniciar a auditoria.');
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (!message || typeof message !== 'object' || !isMessageForAudit(message, activeAuditId)) return;
  panelState = reducePanelState(panelState, message, chrome.runtime.getURL('/'));
  setStatus(panelState.message);
  if (message.type === 'AUDIT_PROGRESS') return;
  if (message.type === 'AUDIT_COMPLETE') {
    if (panelState.reviewUrl) showReport(panelState.reviewUrl);
    else clearReport();
    finishActiveAudit();
    return;
  }
  if (message.type === 'AUDIT_FAILED') {
    clearReport();
    setStatus(typeof message.error === 'string' ? message.error : 'A auditoria não pôde ser concluída.');
    finishActiveAudit();
  }
});

function restoreLatest() {
  try {
    chrome.runtime.sendMessage({ type: 'GET_LAST_AUDIT' }, response => {
      if (chrome.runtime.lastError || !response?.ok || !response.state?.auditId) return;
      const saved = response.state;
      panelState = {
        auditId: saved.auditId,
        status: saved.status || 'running',
        percent: Number.isFinite(saved.percent) ? saved.percent : 0,
        message: saved.message || 'Auditoria em andamento.',
        reviewUrl: isSafeReportUrl(saved.reviewUrl, chrome.runtime.getURL('/')) ? saved.reviewUrl : null,
      };
      setStatus(panelState.message);
      if (['running', 'idle'].includes(panelState.status)) {
        activeAuditId = panelState.auditId;
        setSubmitting(true);
        submissionGate.tryAcquire();
      } else if (panelState.reviewUrl) showReport(panelState.reviewUrl);
    });
  } catch {
    // A restauração é opcional; o formulário permanece utilizável.
  }
}

restoreLatest();
