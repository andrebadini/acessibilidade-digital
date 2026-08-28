import { normalizeAuditUrl } from '../core/url.js';
import { normalizeUrlList } from '../core/batch/normalize-url-list.js';
import {
  createInitialPersonaState,
  createContextPrefillAck,
  createContextPrefillCommitAck,
  createPersonaHello,
  contextProtocolMessageType,
  expectPersonaHello,
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
const batchProgress = document.querySelector('#batch-progress');
const batchSummary = document.querySelector('#batch-summary');
const cancelAudit = document.querySelector('#cancel-audit');
const submissionGate = createSubmissionGate();
let activeAuditId = null;
let panelState = null;
let personaState = createInitialPersonaState();
let personaPort = null;
let personaRequestSequence = 0;
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
}

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
    if (errors.length > 0) {
      finishActiveAudit(); setStatus('Corrija a lista antes de iniciar.'); batchInput.focus(); return;
    }
    request = { type: 'START_BATCH', urls: batchInput.value };
  } else {
    try { request = { type: 'START_AUDIT', url: normalizeAuditUrl(input.value) }; }
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
  personaState = createInitialPersonaState();
  renderPersonas();
  try {
    const port = chrome.runtime.connect({ name: 'audita-persona-v1' });
    personaPort = port;
    port.onMessage.addListener(message => {
      if (personaPort !== port) return;
      personaState = reducePersonaState(personaState, message);
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
  if (!personaPort) return;
  const queued = queuePersonaCommand(personaState, nextPersonaRequestId(command), command, args);
  if (!queued) return;
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
  personaVoice.disabled = !ready || pending;
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
  else if (['unavailable', 'error'].includes(personaState.reader.speechAvailability)) {
    personaDisabledReason.textContent = 'A fala não está disponível; legenda e navegação continuam funcionando.';
  } else if (personaState.reader.speechAvailability === 'busy') {
    personaDisabledReason.textContent = 'A página já usa a fila de fala; a ferramenta preserva essa fala e mantém a legenda.';
  } else personaDisabledReason.textContent = 'Controles disponíveis para a leitura simulada.';
}

function syncPersonaPreferences() {
  const voiceId = personaState.preferences?.voiceId || '';
  if (!Array.from(personaVoice.options).some(option => option.value === voiceId) && voiceId) {
    const unavailable = document.createElement('option');
    unavailable.value = voiceId;
    unavailable.textContent = 'Voz salva indisponível nesta sessão';
    personaVoice.appendChild(unavailable);
  }
  personaVoice.value = voiceId;
  const rate = Number(personaState.preferences?.rate);
  const safeRate = Number.isFinite(rate) && rate >= 0.5 && rate <= 2 ? rate : 1;
  personaRate.value = String(safeRate);
  personaRateOutput.value = `${safeRate.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}×`;
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

function loadPersonaVoices() {
  if (!personaVoice) return;
  let voices = [];
  try { voices = globalThis.speechSynthesis?.getVoices?.() || []; } catch { voices = []; }
  const safe = voices.filter(voice => typeof voice?.voiceURI === 'string' &&
    Array.from(voice.voiceURI).length <= 200 && !/[\u0000-\u001f\u007f]/u.test(voice.voiceURI));
  const defaultOption = document.createElement('option');
  defaultOption.value = '';
  defaultOption.textContent = 'Voz padrão do navegador';
  personaVoice.replaceChildren(defaultOption);
  for (const voice of safe.slice(0, 128)) {
    const option = document.createElement('option');
    option.value = voice.voiceURI;
    const name = typeof voice.name === 'string' ? voice.name.replace(/\s+/gu, ' ').trim().slice(0, 120) : 'Voz disponível';
    const language = typeof voice.lang === 'string' ? voice.lang.replace(/[^A-Za-z0-9-]/gu, '').slice(0, 35) : '';
    option.textContent = language ? `${name} (${language})` : name;
    personaVoice.appendChild(option);
  }
  syncPersonaPreferences();
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
  voiceId: personaVoice.value, rate: Number(personaRate.value),
}));
personaRate?.addEventListener('input', () => {
  const value = Number(personaRate.value);
  personaRateOutput.value = `${value.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}×`;
});
personaRate?.addEventListener('change', () => sendPersonaCommand('preferences', {
  voiceId: personaVoice.value, rate: Number(personaRate.value),
}));
globalThis.speechSynthesis?.addEventListener?.('voiceschanged', loadPersonaVoices);

loadPersonaVoices();
connectPersonas();
