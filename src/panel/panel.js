import { normalizeAuditUrl } from '../core/url.js';

const form = document.querySelector('#audit-form');
const input = document.querySelector('#audit-url');
const submit = form.querySelector('button[type="submit"]');
const status = document.querySelector('#audit-status');
const latestReport = document.querySelector('#latest-report');

function setStatus(message) {
  status.textContent = message;
}

function setSubmitting(isSubmitting) {
  submit.disabled = isSubmitting;
}

function showReport(url) {
  if (typeof url !== 'string' || !url) return;
  latestReport.href = url;
  latestReport.hidden = false;
  latestReport.removeAttribute('aria-disabled');
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  let url;
  try {
    url = normalizeAuditUrl(input.value);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : 'Não foi possível validar o endereço.');
    input.focus();
    return;
  }

  setSubmitting(true);
  setStatus('Preparando a auditoria.');
  try {
    chrome.runtime.sendMessage({ type: 'START_AUDIT', url }, (response) => {
      const runtimeError = chrome.runtime.lastError;
      setSubmitting(false);
      if (runtimeError) {
        setStatus(`Não foi possível iniciar a auditoria: ${runtimeError.message}`);
        return;
      }
      if (!response || response.ok !== true) {
        setStatus(response?.error || 'Não foi possível iniciar a auditoria.');
        return;
      }
      setStatus('Auditoria preparada. A coleta será iniciada em breve.');
    });
  } catch (error) {
    setSubmitting(false);
    setStatus(error instanceof Error ? `Não foi possível iniciar a auditoria: ${error.message}` : 'Não foi possível iniciar a auditoria.');
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'AUDIT_PROGRESS' && typeof message.message === 'string') {
    setStatus(message.message);
  }
  if (message.type === 'AUDIT_COMPLETE') {
    setStatus('Auditoria concluída.');
    showReport(message.reportUrl);
  }
  if (message.type === 'AUDIT_FAILED') {
    setStatus(typeof message.error === 'string' ? message.error : 'A auditoria não pôde ser concluída.');
  }
});
