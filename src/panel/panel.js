import { normalizeAuditUrl } from '../core/url.js';
import { normalizeUrlList } from '../core/batch/normalize-url-list.js';
import { createDestructiveDialog } from '../ui/destructive-dialog.js';
import { parseAuditDeletedEvent } from '../core/audit-deleted-event.js';
import {
  createInitialPersonaState,
  createContextPrefillAck,
  createContextPrefillCommitAck,
  createPersonaHello,
  contextProtocolMessageType,
  expectPersonaHello,
  formatBatchWarning,
  createSubmissionGate,
  isMessageForAudit,
  isSafeReportUrl,
  parseContextPrefillCommitMessage,
  parseContextPrefillMessage,
  queuePersonaCommand,
  reduceContextCommitDelivery,
  reducePersonaState,
  reducePanelState,
  restoreExportEventState,
  resolveCurrentPanelTabId,
  sendContextProtocolAck,
  shouldApplyRestoredAudit,
} from './panel-state.js';

const form = document.querySelector('#audit-form');
const input = document.querySelector('#audit-url');
const submit = form.querySelector('button[type="submit"]');
const status = document.querySelector('#audit-status');
const latestReport = document.querySelector('#latest-report');
const batchInput = document.querySelector('#audit-urls');
const batchFields = document.querySelector('#batch-fields');
const singleFields = document.querySelector('#single-fields');
const batchErrors = document.querySelector('#batch-errors');
const batchWarnings = document.querySelector('#batch-warnings');
const batchProgress = document.querySelector('#batch-progress');
const batchSummary = document.querySelector('#batch-summary');
const cancelAudit = document.querySelector('#cancel-audit');
const deleteAfterExport = document.querySelector('#delete-after-export');
const deleteAllAudits = document.querySelector('#delete-all-audits');
const deleteAllDialog = document.querySelector('#delete-all-dialog');
const deleteAllCancel = document.querySelector('#delete-all-cancel');
const deleteAllConfirm = document.querySelector('#delete-all-confirm');
const deleteAllDialogStatus = document.querySelector('#delete-all-dialog-status');
const submissionGate = createSubmissionGate();
let activeAuditId = null;
let panelState = null;
let personaState = createInitialPersonaState();
let personaPort = null;
let personaRequestSequence = 0;
let personaLocalVoiceIds = new Set();
let personaVoiceInventoryStatus = 'unavailable';
let personaVoiceClear = { voiceId: '', attempts: 0, requestId: null };
let contextPrefill = null;
let currentPanelTabIdPromise = null;
const seenContextPrefills = new Set();
let panelLifecycleEpoch = 0;

const personaSection = document.querySelector('#persona-section');
const personaModeButtons = Array.from(document.querySelectorAll('[data-persona-mode]'));
const personaTarget = document.querySelector('#persona-target');
const personaDisabledReason = document.querySelector('#persona-disabled-reason');
const personaLiveStatus = document.querySelector('#persona-live-status');
const personaGoTarget = document.querySelector('#persona-go-target');
const personaStopAll = document.querySelector('#persona-stop-all');
const personaReconnect = document.querySelector('#persona-reconnect');
const personaReaderToggle = document.querySelector('#persona-reader-toggle');
const personaReaderStop = document.querySelector('#persona-reader-stop');
const personaReaderRepeat = document.querySelector('#persona-reader-repeat');
const personaReaderPrevious = document.querySelector('#persona-reader-previous');
const personaReaderNext = document.querySelector('#persona-reader-next');
const personaVoice = document.querySelector('#persona-voice');
const personaRate = document.querySelector('#persona-rate');
const personaRateOutput = document.querySelector('#persona-rate-output');
const personaCaption = document.querySelector('#persona-caption');
const personaReaderPosition = document.querySelector('#persona-reader-position');
const personaCoverage = document.querySelector('#persona-coverage');
const personaLimitationsList = document.querySelector('#persona-limitations-list');

function setStatus(message) {
  status.textContent = message;
}

function setSubmitting(isSubmitting) {
  submit.disabled = isSubmitting;
  cancelAudit.hidden = !isSubmitting;
  deleteAfterExport.disabled = isSubmitting;
  deleteAllAudits.disabled = isSubmitting;
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

const deleteAllController = createDestructiveDialog({
  dialog: deleteAllDialog,
  cancelButton: deleteAllCancel,
  confirmButton: deleteAllConfirm,
  status,
  dialogStatus: deleteAllDialogStatus,
  stableFocus: status,
  async onConfirm() {
    const response = await sendWorkerRequest({ type: 'REQUEST_DELETE_ALL_AUDITS' });
    if (response.ok === true) {
      activeAuditId = null;
      panelState = null;
      submissionGate.release();
      clearReport();
      renderBatchState(null);
      setSubmitting(false);
    }
    return response;
  },
  successMessage: 'Todas as auditorias locais foram excluídas. Downloads já salvos foram preservados.',
  failureMessage: 'Não foi possível excluir as auditorias locais.',
});

deleteAllAudits.addEventListener('click', () => deleteAllController.open(deleteAllAudits));

function selectedAuditMode() {
  return form.elements['audit-mode']?.value === 'batch' ? 'batch' : 'single';
}

function selectAuditMode(mode) {
  const radio = form.querySelector(`input[name="audit-mode"][value="${mode}"]`);
  if (radio) radio.checked = true;
  const batch = mode === 'batch';
  batchFields.hidden = !batch;
  singleFields.hidden = batch;
  input.required = !batch;
}

for (const radio of form.querySelectorAll('input[name="audit-mode"]')) {
  radio.addEventListener('change', () => selectAuditMode(selectedAuditMode()));
}

function renderBatchErrors(errors = []) {
  batchErrors.replaceChildren(...errors.map(error => {
    const item = document.createElement('li');
    item.textContent = error.line > 0 ? `Linha ${error.line}: ${error.message}` : error.message;
    return item;
  }));
}

function renderBatchWarnings(warnings = []) {
  batchWarnings.replaceChildren(...warnings.map(formatBatchWarning).filter(Boolean).map(text => {
    const item = document.createElement('li');
    item.textContent = text;
    return item;
  }));
}

function renderBatchState(state) {
  const batch = state?.mode === 'batch' || Number.isSafeInteger(state?.total);
  batchProgress.hidden = !batch;
  batchSummary.hidden = !batch;
  if (!batch) return;
  batchProgress.textContent = `${state.pageNumber ?? 0} de ${state.total ?? 0} páginas.`;
  const counts = state.statusCounts ?? {};
  batchSummary.textContent = `Concluídas: ${counts.complete ?? 0}; parciais: ${counts.partial ?? 0}; falhas: ${counts.failed ?? 0}; canceladas: ${counts.cancelled ?? 0}.`;
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
  panelLifecycleEpoch += 1;
  const mode = selectedAuditMode();
  let request;
  if (mode === 'batch') {
    const normalized = normalizeUrlList(batchInput.value);
    const errors = normalized.entries.length === 0 && normalized.errors.length === 0
      ? [{ line: 0, message: 'Informe ao menos uma URL.' }]
      : normalized.errors;
    renderBatchErrors(errors);
    renderBatchWarnings(normalized.warnings);
    if (errors.length > 0) {
      finishActiveAudit(); setStatus('Corrija a lista antes de iniciar.'); batchInput.focus(); return;
    }
    request = {
      type: 'START_BATCH', urls: batchInput.value,
      deleteAfterCompleteExport: deleteAfterExport.checked,
    };
  } else {
    try {
      request = {
        type: 'START_AUDIT', url: normalizeAuditUrl(input.value),
        deleteAfterCompleteExport: deleteAfterExport.checked,
      };
    }
    catch (error) {
      finishActiveAudit();
      setStatus(error instanceof Error ? error.message : 'Não foi possível validar o endereço.');
      input.focus();
      return;
    }
  }

  clearReport();
  setSubmitting(true);
  setStatus('Preparando a auditoria.');
  try {
    chrome.runtime.sendMessage(request, (response) => {
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
      if (mode === 'batch') renderBatchWarnings(response.warnings ?? []);
      panelState = {
        auditId: activeAuditId, mode, status: 'running', percent: 0,
        message: mode === 'batch' ? 'Lote preparado. A primeira página será iniciada em breve.' : 'Auditoria preparada. A coleta será iniciada em breve.',
        reviewUrl: null, ...(mode === 'batch' ? { total: response.total, pageNumber: 0 } : {}),
      };
      setStatus(panelState.message);
      renderBatchState(panelState);
    });
  } catch (error) {
    finishActiveAudit();
    setStatus(error instanceof Error ? `Não foi possível iniciar a auditoria: ${error.message}` : 'Não foi possível iniciar a auditoria.');
  }
});

cancelAudit.addEventListener('click', () => {
  if (!activeAuditId) return;
  cancelAudit.disabled = true;
  setStatus('Cancelamento solicitado; aguardando a limpeza da página ativa.');
  chrome.runtime.sendMessage({ type: 'CANCEL_AUDIT', auditId: activeAuditId }, response => {
    cancelAudit.disabled = false;
    if (chrome.runtime.lastError || response?.ok !== true) {
      setStatus(response?.error || 'Não foi possível solicitar o cancelamento.');
    }
  });
});

chrome.runtime.onMessage.addListener((message, sender) => {
  const messageType = contextProtocolMessageType(message);
  if (messageType === null) return false;
  if (messageType === 'AUDIT_CONTEXT_PREFILL') {
    void handleContextPrefill(message, sender);
    return false;
  }
  if (messageType === 'AUDIT_CONTEXT_PREFILL_COMMIT') {
    void handleContextPrefillCommit(message, sender);
    return false;
  }
  if (messageType === 'AUDIT_DELETED') {
    const deletion = parseAuditDeletedEvent(message, sender, {
      id: chrome.runtime.id,
      workerUrl: chrome.runtime.getURL('src/background/service-worker.js'),
    });
    if (deletion && (deletion.scope === 'all' || deletion.auditId === (activeAuditId ?? panelState?.auditId))) {
      if (deletion.scope === 'all') deleteAllController.completeSuccess();
      activeAuditId = null;
      panelState = null;
      submissionGate.release();
      clearReport();
      renderBatchState(null);
      setSubmitting(false);
      if (deletion.scope !== 'all') setStatus('A auditoria local foi excluída. Downloads já salvos foram preservados.');
    }
    return false;
  }
  if (!message || typeof message !== 'object' || !isMessageForAudit(message, activeAuditId ?? panelState?.auditId)) return;
  panelState = reducePanelState(panelState, message, chrome.runtime.getURL('/'));
  setStatus(panelState.message);
  renderBatchState(panelState);
  if (messageType === 'AUDIT_PROGRESS') return;
  if (messageType === 'AUDIT_COMPLETE') {
    if (panelState.reviewUrl) showReport(panelState.reviewUrl);
    else clearReport();
    finishActiveAudit();
    return;
  }
  if (messageType === 'AUDIT_FAILED') {
    clearReport();
    setStatus(typeof message.error === 'string' ? message.error : 'A auditoria não pôde ser concluída.');
    finishActiveAudit();
  }
});

async function handleContextPrefill(message, sender) {
  if (!isAuthorizedWorkerMessage(sender)) return;
  const panelTabId = await currentPanelTabId();
  const parsed = parseContextPrefillMessage(message, panelTabId);
  if (!parsed) return;
  if (seenContextPrefills.has(parsed.requestId) || contextPrefill || !submissionGate.tryAcquire()) {
    sendContextAck(createContextPrefillAck(parsed.requestId, panelTabId, false));
    return;
  }
  panelLifecycleEpoch += 1;
  seenContextPrefills.add(parsed.requestId);
  while (seenContextPrefills.size > 128) seenContextPrefills.delete(seenContextPrefills.values().next().value);
  contextPrefill = { requestId: parsed.requestId, panelTabId, committed: false };
  selectAuditMode('single');
  input.value = parsed.url;
  clearReport();
  setSubmitting(true);
  setStatus(parsed.kind === 'link'
    ? 'Preparando a auditoria do link solicitado pelo menu de contexto.'
    : 'Preparando a auditoria da página solicitada pelo menu de contexto.');
  sendContextAck(createContextPrefillAck(parsed.requestId, panelTabId, parsed.autoStarted), (response, runtimeFailed) => {
    if (!contextPrefill || contextPrefill.requestId !== parsed.requestId) return;
    contextPrefill = null;
    if (runtimeFailed || !response || response.ok !== true || typeof response.auditId !== 'string') {
      finishActiveAudit();
      setStatus(response?.error || 'Não foi possível iniciar a auditoria pelo menu de contexto.');
      return;
    }
    activeAuditId = response.auditId;
    panelState = {
      auditId: activeAuditId, status: 'running', percent: 0,
      message: 'Auditoria preparada. A coleta será iniciada em breve.', reviewUrl: null,
    };
    setStatus(panelState.message);
  });
}

async function handleContextPrefillCommit(message, sender) {
  if (!isAuthorizedWorkerMessage(sender)) return;
  const panelTabId = await currentPanelTabId();
  const parsed = parseContextPrefillCommitMessage(message, panelTabId);
  const accepted = Boolean(parsed && contextPrefill && !contextPrefill.committed &&
    contextPrefill.requestId === parsed.requestId && contextPrefill.panelTabId === parsed.panelTabId);
  if (accepted) contextPrefill.committed = true;
  const requestId = parsed?.requestId;
  if (requestId) sendContextAck(createContextPrefillCommitAck(requestId, panelTabId, accepted), (response, runtimeFailed) => {
    const outcome = reduceContextCommitDelivery(contextPrefill, requestId, { response, runtimeFailed });
    contextPrefill = outcome.contextPrefill;
    if (!outcome.releaseGate) return;
    finishActiveAudit();
    setStatus('A conexão com a auditoria do menu foi interrompida; o formulário está disponível novamente.');
  });
}

function isAuthorizedWorkerMessage(sender) {
  if (!sender || sender.id !== chrome.runtime.id || sender.tab) return false;
  if (sender.url === undefined) return true;
  return sender.url === chrome.runtime.getURL('src/background/service-worker.js');
}

function currentPanelTabId() {
  if (currentPanelTabIdPromise) return currentPanelTabIdPromise;
  currentPanelTabIdPromise = resolveCurrentPanelTabId(chrome);
  return currentPanelTabIdPromise;
}

function sendContextAck(message, callback = () => {}) {
  if (!message) return;
  sendContextProtocolAck(chrome, message, callback);
}

function restoreLatest() {
  const requestedEpoch = panelLifecycleEpoch;
  try {
    chrome.runtime.sendMessage({ type: 'GET_LAST_AUDIT' }, response => {
      if (chrome.runtime.lastError || !response?.ok || !response.state?.auditId) return;
      if (!shouldApplyRestoredAudit({
        requestedEpoch, currentEpoch: panelLifecycleEpoch,
        contextPending: Boolean(contextPrefill), activeAuditId,
      })) return;
      const saved = response.state;
      panelState = {
        auditId: saved.auditId,
        mode: saved.mode === 'batch' ? 'batch' : 'single',
        status: saved.status || 'running',
        percent: Number.isFinite(saved.percent) ? saved.percent : 0,
        message: saved.message || 'Auditoria em andamento.',
        reviewUrl: isSafeReportUrl(saved.reviewUrl, chrome.runtime.getURL('/')) ? saved.reviewUrl : null,
        exportStatus: saved.exportStatus || 'unavailable',
        ...restoreExportEventState(saved),
        ...(Number.isSafeInteger(saved.total) ? { total: saved.total, pageNumber: saved.pageNumber ?? 0, statusCounts: saved.statusCounts } : {}),
      };
      setStatus(panelState.message);
      renderBatchState(panelState);
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

function nextPersonaRequestId(prefix = 'panel') {
  personaRequestSequence += 1;
  return `${prefix}-${Date.now()}-${personaRequestSequence}`;
}

function connectPersonas() {
  personaVoiceClear = { voiceId: '', attempts: 0, requestId: null };
  personaState = createInitialPersonaState();
  renderPersonas();
  try {
    const port = chrome.runtime.connect({ name: 'audita-persona-v1' });
    personaPort = port;
    port.onMessage.addListener(message => {
      if (personaPort !== port) return;
      const previous = personaState;
      const reduced = reducePersonaState(previous, message);
      if (reduced !== previous && personaVoiceClear.requestId &&
        previous.pending?.requestId === personaVoiceClear.requestId && reduced.pending === null) {
        personaVoiceClear = { ...personaVoiceClear, requestId: null };
      }
      personaState = reduced;
      renderPersonas();
    });
    port.onDisconnect.addListener(() => {
      if (personaPort !== port) return;
      personaPort = null;
      personaState = {
        ...createInitialPersonaState(), connection: 'error',
        message: 'A conexão com a aba simulada foi encerrada.', code: 'PERSONA_PORT_DISCONNECTED',
      };
      renderPersonas();
    });
    const hello = createPersonaHello(nextPersonaRequestId('hello'));
    if (hello) {
      personaState = expectPersonaHello(personaState, hello.requestId);
      port.postMessage(hello);
    }
  } catch {
    personaPort = null;
    personaState = {
      ...createInitialPersonaState(), connection: 'error',
      message: 'Não foi possível conectar as simulações à aba de origem.', code: 'PERSONA_PORT_FAILED',
    };
    renderPersonas();
  }
}

function reconnectPersonas() {
  personaVoiceClear = { voiceId: '', attempts: 0, requestId: null };
  if (!personaPort) {
    connectPersonas();
    return;
  }
  personaState = createInitialPersonaState();
  renderPersonas();
  const hello = createPersonaHello(nextPersonaRequestId('hello'));
  personaState = expectPersonaHello(personaState, hello?.requestId);
  try { personaPort.postMessage(hello); }
  catch {
    try { personaPort.disconnect(); } catch { /* a renderização já permanece fail-closed */ }
  }
}

function sendPersonaCommand(command, args = {}) {
  if (!personaPort) return null;
  const queued = queuePersonaCommand(personaState, nextPersonaRequestId(command), command, args);
  if (!queued) return null;
  personaState = queued.state;
  renderPersonas();
  try { personaPort.postMessage(queued.message); }
  catch {
    personaState = {
      ...personaState, connection: 'error', token: null, activeMode: null, pending: null,
      message: 'Não foi possível enviar o controle à aba simulada.', code: 'PERSONA_PORT_FAILED',
    };
    renderPersonas();
  }
  return queued.message.requestId;
}

function renderPersonas() {
  if (!personaSection) return;
  const ready = personaState.connection === 'ready' && personaState.bound && Boolean(personaState.token);
  const pending = Boolean(personaState.pending);
  personaSection.setAttribute('aria-busy', pending ? 'true' : 'false');
  personaTarget.textContent = ready ? 'A aba de origem está vinculada a este painel.' : personaState.message;
  personaLiveStatus.textContent = personaState.message;
  for (const button of personaModeButtons) {
    const pressed = personaState.activeMode === button.dataset.personaMode;
    button.setAttribute('aria-pressed', String(pressed));
    button.disabled = !ready || pending;
  }
  personaGoTarget.disabled = !ready || pending;
  personaStopAll.disabled = !ready || pending || personaState.activeMode === null;
  personaReconnect.hidden = !['error'].includes(personaState.connection);
  personaReconnect.disabled = pending;

  const readerActive = personaState.activeMode === 'reader';
  personaReaderToggle.disabled = !ready || pending;
  personaReaderToggle.textContent = readerActive
    ? (personaState.reader.playback === 'idle'
        ? 'Iniciar novamente'
        : (personaState.reader.playback === 'paused' ? 'Continuar leitura' : 'Pausar leitura'))
    : 'Iniciar leitura';
  personaReaderStop.disabled = !ready || pending || !readerActive;
  personaReaderRepeat.disabled = !ready || pending || !readerActive || personaState.reader.total === 0;
  personaReaderPrevious.disabled = !ready || pending || !readerActive || !personaState.reader.canPrevious;
  personaReaderNext.disabled = !ready || pending || !readerActive || !personaState.reader.canNext;
  personaVoice.disabled = !ready || pending || personaLocalVoiceIds.size === 0;
  personaRate.disabled = !ready || pending;
  syncPersonaPreferences();
  personaCaption.textContent = personaState.reader.caption || 'Nenhum anúncio disponível.';
  const currentPosition = personaState.reader.index >= 0 ? personaState.reader.index + 1 : 0;
  personaReaderPosition.textContent = `Item ${currentPosition} de ${personaState.reader.total}.`;
  personaCoverage.textContent = personaState.coverage
    ? 'Fallback DOM: documento principal e Shadow DOM aberto. Frames e Shadow DOM fechado não são coordenados.'
    : 'A cobertura será informada após conectar à página.';
  renderPersonaLimitations();

  if (!ready) personaDisabledReason.textContent = personaState.message;
  else if (pending) personaDisabledReason.textContent = 'Aguarde a confirmação da página antes de enviar outro controle.';
  else if (!readerActive) personaDisabledReason.textContent = 'Os controles de reprodução ficam disponíveis ao ativar Leitura simulada.';
  else if (personaState.reader.speechAvailability === 'error' || personaVoiceInventoryStatus === 'error') {
    personaDisabledReason.textContent = 'Não foi possível validar uma voz local; legenda e navegação continuam funcionando.';
  } else if (personaState.reader.speechAvailability === 'unavailable' || personaLocalVoiceIds.size === 0) {
    personaDisabledReason.textContent = 'Nenhuma voz local validada está disponível; legenda e navegação continuam funcionando.';
  } else if (personaState.reader.speechAvailability === 'busy') {
    personaDisabledReason.textContent = 'A página já usa a fila de fala; a ferramenta preserva essa fala e mantém a legenda.';
  } else personaDisabledReason.textContent = 'Controles disponíveis para a leitura simulada.';
}

function syncPersonaPreferences() {
  const storedVoiceId = typeof personaState.preferences?.voiceId === 'string'
    ? personaState.preferences.voiceId
    : '';
  const voiceId = personaLocalVoiceIds.has(storedVoiceId) ? storedVoiceId : '';
  personaVoice.value = voiceId;
  const rate = Number(personaState.preferences?.rate);
  const safeRate = Number.isFinite(rate) && rate >= 0.5 && rate <= 2 ? rate : 1;
  personaRate.value = String(safeRate);
  personaRateOutput.value = `${safeRate.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}×`;
  if (!storedVoiceId || voiceId) {
    personaVoiceClear = { voiceId: '', attempts: 0, requestId: null };
    return;
  }
  if (personaVoiceClear.voiceId !== storedVoiceId) {
    personaVoiceClear = { voiceId: storedVoiceId, attempts: 0, requestId: null };
  }
  const ready = personaState.connection === 'ready' && personaState.bound && Boolean(personaState.token);
  if (!ready || personaState.pending || personaVoiceClear.requestId || personaVoiceClear.attempts >= 2) return;
  personaVoiceClear = { ...personaVoiceClear, attempts: personaVoiceClear.attempts + 1 };
  const requestId = sendPersonaCommand('preferences', { voiceId: '', rate: safeRate });
  personaVoiceClear = { ...personaVoiceClear, requestId };
}

function renderPersonaLimitations() {
  personaLimitationsList.replaceChildren();
  const limitations = personaState.limitations || [];
  if (!limitations.length) {
    const item = document.createElement('li');
    item.textContent = 'Frames permanecem fora da fila; Shadow DOM fechado pode ser indetectável.';
    personaLimitationsList.appendChild(item);
    return;
  }
  for (const limitation of limitations) {
    const item = document.createElement('li');
    item.textContent = personaLimitationText(limitation);
    personaLimitationsList.appendChild(item);
  }
}

function personaLimitationText(limitation) {
  const labels = {
    'frame-uncoordinated': 'frame não coordenado',
    'frame-sandboxed': 'frame isolado por sandbox',
    'dom-traversal-truncated': 'elementos não inspecionados porque a varredura DOM atingiu o limite seguro',
  };
  const label = labels[limitation.code] || 'conteúdo fora da cobertura automática';
  const suffix = limitation.truncated === true
    ? ' A fila é parcial e não representa cobertura integral da página.'
    : '';
  return `${limitation.count} ocorrência(s): ${label}.${suffix}`;
}

function panelDataMethod(value, key) {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return null;
  try {
    let current = value;
    for (let depth = 0; current && depth < 4; depth += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor) {
        return Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'function'
          ? descriptor.value
          : null;
      }
      current = Object.getPrototypeOf(current);
    }
  } catch { return null; }
  return null;
}

function readPanelSpeechSynthesis() {
  try {
    const own = Object.getOwnPropertyDescriptor(globalThis, 'speechSynthesis');
    if (own) {
      return Object.hasOwn(own, 'value')
        ? { status: own.value ? 'available' : 'unavailable', synthesis: own.value || null }
        : { status: 'error', synthesis: null };
    }
    let current = Object.getPrototypeOf(globalThis);
    for (let depth = 0; current && depth < 3; depth += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(current, 'speechSynthesis');
      if (descriptor) {
        if (typeof descriptor.get !== 'function' || descriptor.set !== undefined) {
          return { status: 'error', synthesis: null };
        }
        const synthesis = descriptor.get.call(globalThis);
        return { status: synthesis ? 'available' : 'unavailable', synthesis: synthesis || null };
      }
      current = Object.getPrototypeOf(current);
    }
  } catch { return { status: 'error', synthesis: null }; }
  return { status: 'unavailable', synthesis: null };
}

function densePanelVoiceEntries(value) {
  try {
    if (!Array.isArray(value)) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const length = descriptors.length;
    if (!length || !Object.hasOwn(length, 'value') || !Number.isSafeInteger(length.value) ||
      length.value < 0 || length.value > 128 || Reflect.ownKeys(descriptors).length !== length.value + 1) return null;
    const entries = new Array(length.value);
    for (let index = 0; index < length.value; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) return null;
      entries[index] = descriptor.value;
    }
    return entries;
  } catch { return null; }
}

function panelNativeVoicePrototype() {
  try {
    const constructorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'SpeechSynthesisVoice');
    const Constructor = constructorDescriptor && Object.hasOwn(constructorDescriptor, 'value')
      ? constructorDescriptor.value
      : null;
    if (typeof Constructor !== 'function') return null;
    const prototypeDescriptor = Object.getOwnPropertyDescriptor(Constructor, 'prototype');
    return prototypeDescriptor && Object.hasOwn(prototypeDescriptor, 'value')
      ? prototypeDescriptor.value
      : null;
  } catch { return null; }
}

function projectPanelVoice(voice, nativePrototype) {
  if (!voice || typeof voice !== 'object') return null;
  let descriptors;
  try { descriptors = Object.getOwnPropertyDescriptors(voice); } catch { return null; }
  const ownLocal = descriptors.localService;
  if (ownLocal && !Object.hasOwn(ownLocal, 'value')) return null;
  let read;
  if (ownLocal) {
    read = key => {
      const descriptor = descriptors[key];
      if (!descriptor) return { present: false, value: undefined };
      return Object.hasOwn(descriptor, 'value') ? { present: true, value: descriptor.value } : null;
    };
  } else {
    try {
      if (!nativePrototype || Object.getPrototypeOf(voice) !== nativePrototype) return { local: false };
    } catch { return null; }
    read = key => {
      try {
        const descriptor = Object.getOwnPropertyDescriptor(nativePrototype, key);
        if (!descriptor || typeof descriptor.get !== 'function' || descriptor.set !== undefined) return null;
        return { present: true, value: descriptor.get.call(voice) };
      } catch { return null; }
    };
  }
  const local = read('localService');
  if (!local) return null;
  if (!local.present || local.value !== true) return { local: false };
  const uri = read('voiceURI');
  if (!uri || !uri.present || typeof uri.value !== 'string' || uri.value !== uri.value.trim() ||
    Array.from(uri.value).length < 1 || Array.from(uri.value).length > 200 ||
    /[\u0000-\u001f\u007f]/u.test(uri.value)) return null;
  const name = read('name');
  const language = read('lang');
  if (!name || !language || (name.present && typeof name.value !== 'string') ||
    (language.present && typeof language.value !== 'string')) return null;
  const safeName = name.present
    ? Array.from(name.value.replace(/\s+/gu, ' ').trim()).slice(0, 120).join('')
    : '';
  const safeLanguage = language.present
    ? language.value.replace(/[^A-Za-z0-9-]/gu, '').slice(0, 35)
    : '';
  return { local: true, voiceId: uri.value, name: safeName || 'Voz local', language: safeLanguage };
}

function readPanelLocalVoices() {
  const speech = readPanelSpeechSynthesis();
  if (!speech.synthesis) return { status: speech.status, voices: [] };
  const synthesis = speech.synthesis;
  const getVoices = panelDataMethod(synthesis, 'getVoices');
  if (!getVoices) return { status: 'error', voices: [] };
  try {
    const entries = densePanelVoiceEntries(getVoices.call(synthesis));
    if (!entries) return { status: 'error', voices: [] };
    const voices = [];
    const ids = new Set();
    const nativePrototype = panelNativeVoicePrototype();
    for (const entry of entries) {
      const projected = projectPanelVoice(entry, nativePrototype);
      if (!projected) return { status: 'error', voices: [] };
      if (!projected.local) continue;
      if (ids.has(projected.voiceId)) return { status: 'error', voices: [] };
      ids.add(projected.voiceId);
      voices.push(projected);
    }
    return { status: 'available', voices };
  } catch { return { status: 'error', voices: [] }; }
}

function loadPersonaVoices() {
  if (!personaVoice) return;
  const inventory = readPanelLocalVoices();
  personaVoiceInventoryStatus = inventory.status;
  personaLocalVoiceIds = new Set(inventory.voices.map(voice => voice.voiceId));
  const defaultOption = document.createElement('option');
  defaultOption.value = '';
  defaultOption.textContent = inventory.status === 'error'
    ? 'Não foi possível validar vozes locais'
    : (inventory.voices.length ? 'Selecione uma voz local' : 'Nenhuma voz local disponível');
  personaVoice.replaceChildren(defaultOption);
  for (const voice of inventory.voices) {
    const option = document.createElement('option');
    option.value = voice.voiceId;
    option.textContent = voice.language ? `${voice.name} (${voice.language})` : voice.name;
    personaVoice.appendChild(option);
  }
  syncPersonaPreferences();
  renderPersonas();
}

for (const button of personaModeButtons) {
  button.addEventListener('click', () => {
    const mode = button.dataset.personaMode;
    if (personaState.activeMode === mode) sendPersonaCommand('stop');
    else sendPersonaCommand('activate', { mode });
  });
}
personaGoTarget?.addEventListener('click', () => sendPersonaCommand('go-target'));
personaStopAll?.addEventListener('click', () => sendPersonaCommand('stop'));
personaReconnect?.addEventListener('click', reconnectPersonas);
personaReaderToggle?.addEventListener('click', () => {
  if (personaState.activeMode !== 'reader') sendPersonaCommand('activate', { mode: 'reader' });
  else sendPersonaCommand('reader-action', {
    action: personaState.reader.playback === 'idle'
      ? 'start'
      : (personaState.reader.playback === 'paused' ? 'resume' : 'pause'),
  });
});
personaReaderStop?.addEventListener('click', () => sendPersonaCommand('reader-action', { action: 'stop' }));
personaReaderRepeat?.addEventListener('click', () => sendPersonaCommand('reader-action', { action: 'repeat' }));
personaReaderPrevious?.addEventListener('click', () => sendPersonaCommand('reader-action', { action: 'previous' }));
personaReaderNext?.addEventListener('click', () => sendPersonaCommand('reader-action', { action: 'next' }));
personaVoice?.addEventListener('change', () => sendPersonaCommand('preferences', {
  voiceId: personaLocalVoiceIds.has(personaVoice.value) ? personaVoice.value : '',
  rate: Number(personaRate.value),
}));
personaRate?.addEventListener('input', () => {
  const value = Number(personaRate.value);
  personaRateOutput.value = `${value.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}×`;
});
personaRate?.addEventListener('change', () => sendPersonaCommand('preferences', {
  voiceId: personaLocalVoiceIds.has(personaVoice.value) ? personaVoice.value : '',
  rate: Number(personaRate.value),
}));
try {
  const synthesis = readPanelSpeechSynthesis().synthesis;
  const addVoicesListener = panelDataMethod(synthesis, 'addEventListener');
  addVoicesListener?.call(synthesis, 'voiceschanged', loadPersonaVoices);
} catch { /* absence of a safe listener keeps the inventory fail-closed */ }

loadPersonaVoices();
connectPersonas();
