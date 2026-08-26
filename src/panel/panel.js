import { normalizeAuditUrl } from '../core/url.js';
import { createSubmissionGate, isMessageForAudit, isSafeReportUrl } from './panel-state.js';

const form = document.querySelector('#audit-form');
const input = document.querySelector('#audit-url');
const submit = form.querySelector('button[type="submit"]');
const status = document.querySelector('#audit-status');
const latestReport = document.querySelector('#latest-report');
const submissionGate = createSubmissionGate();
let activeAuditId = null;

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
      submissionGate.release();
      setSubmitting(false);
      if (runtimeError) {
        activeAuditId = null;
        setStatus(`Não foi possível iniciar a auditoria: ${runtimeError.message}`);
        return;
      }
      if (!response || response.ok !== true || typeof response.auditId !== 'string') {
        activeAuditId = null;
        setStatus(response?.error || 'Não foi possível iniciar a auditoria.');
        return;
      }
      activeAuditId = response.auditId;
      setStatus('Auditoria preparada. A coleta será iniciada em breve.');
    });
  } catch (error) {
    finishActiveAudit();
    setStatus(error instanceof Error ? `Não foi possível iniciar a auditoria: ${error.message}` : 'Não foi possível iniciar a auditoria.');
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (!message || typeof message !== 'object' || !isMessageForAudit(message, activeAuditId)) return;
  if (message.type === 'AUDIT_PROGRESS' && typeof message.message === 'string') {
    setStatus(message.message);
    return;
  }
  if (message.type === 'AUDIT_COMPLETE') {
    if (isSafeReportUrl(message.reportUrl, chrome.runtime.getURL('/'))) {
      showReport(message.reportUrl);
      setStatus('Auditoria concluída.');
    } else {
      clearReport();
      setStatus('Auditoria concluída, mas o relatório está indisponível.');
    }
    finishActiveAudit();
    return;
  }
  if (message.type === 'AUDIT_FAILED') {
    clearReport();
    setStatus(typeof message.error === 'string' ? message.error : 'A auditoria não pôde ser concluída.');
    finishActiveAudit();
  }
});
