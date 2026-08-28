import { sanitizeEvidenceUrl } from '../core/privacy.js';

export function isMessageForAudit(message, auditId) {
  return Boolean(auditId)
    && Boolean(message)
    && (message.auditId === auditId || message.sessionId === auditId);
}

export function isSafeReportUrl(value, extensionBaseUrl) {
  if (typeof value !== 'string' || typeof extensionBaseUrl !== 'string') return false;
  try {
    const own = new URL(extensionBaseUrl);
    const url = new URL(value);
    if (url.protocol === 'chrome-extension:') {
      return url.protocol === own.protocol && url.hostname === own.hostname;
    }
    if (url.protocol !== 'blob:') return false;
    const blobOrigin = new URL(url.pathname);
    return blobOrigin.protocol === own.protocol && blobOrigin.hostname === own.hostname;
  } catch {
    return false;
  }
}

export function createSubmissionGate() {
  let held = false;
  return {
    tryAcquire() {
      if (held) return false;
      held = true;
      return true;
    },
    release() { held = false; },
  };
}

export function parseContextPrefillMessage(message, currentPanelTabId) {
  const parsed = clonePersonaRecord(message);
  if (!personaExactKeys(parsed, ['type', 'requestId', 'panelTabId', 'prefill']) ||
    parsed.type !== 'AUDIT_CONTEXT_PREFILL' || !personaIdentifier(parsed.requestId) ||
    !Number.isSafeInteger(parsed.panelTabId) || parsed.panelTabId < 0 ||
    parsed.panelTabId !== currentPanelTabId ||
    !personaExactKeys(parsed.prefill, ['kind', 'url', 'autoStarted']) ||
    !['page', 'link'].includes(parsed.prefill.kind) || parsed.prefill.autoStarted !== true ||
    typeof parsed.prefill.url !== 'string' || parsed.prefill.url.length === 0 || parsed.prefill.url.length > 4_096 ||
    sanitizeEvidenceUrl(parsed.prefill.url) !== parsed.prefill.url) return null;
  return {
    requestId: parsed.requestId, panelTabId: parsed.panelTabId,
    kind: parsed.prefill.kind, url: parsed.prefill.url, autoStarted: true,
  };
}

export function contextProtocolMessageType(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return null;
  let descriptor;
  try { descriptor = Object.getOwnPropertyDescriptor(message, 'type'); } catch { return null; }
  return descriptor && Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'string'
    ? descriptor.value
    : null;
}

export function createContextPrefillAck(requestId, panelTabId, accepted) {
  return createContextProtocolAck('CONTEXT_PREFILL_ACK', requestId, panelTabId, accepted);
}

export function createContextPrefillCommitAck(requestId, panelTabId, accepted) {
  return createContextProtocolAck('CONTEXT_PREFILL_COMMIT_ACK', requestId, panelTabId, accepted);
}

export function shouldApplyRestoredAudit({ requestedEpoch, currentEpoch, contextPending, activeAuditId }) {
  return Number.isSafeInteger(requestedEpoch) && requestedEpoch >= 0 && requestedEpoch === currentEpoch &&
    contextPending === false && activeAuditId === null;
}

export function reduceContextCommitDelivery(contextPrefill, requestId, delivery) {
  if (!contextPrefill || contextPrefill.requestId !== requestId) {
    return { contextPrefill: contextPrefill ?? null, releaseGate: false };
  }
  let descriptors;
  try { descriptors = Object.getOwnPropertyDescriptors(delivery); } catch { descriptors = null; }
  const exactDelivery = descriptors && Object.keys(descriptors).sort().join(',') === 'response,runtimeFailed' &&
    Object.values(descriptors).every(descriptor => Object.hasOwn(descriptor, 'value'));
  const response = exactDelivery ? clonePersonaRecord(descriptors.response.value) : null;
  const successful = exactDelivery && descriptors.runtimeFailed.value === false &&
    personaExactKeys(response, ['ok']) && response.ok === true;
  return successful
    ? { contextPrefill, releaseGate: false }
    : { contextPrefill: null, releaseGate: true };
}

export function sendContextProtocolAck(chromeApi, message, callback) {
  if (typeof chromeApi?.runtime?.sendMessage !== 'function' || typeof callback !== 'function') {
    throw new TypeError('Transporte do protocolo de contexto indisponível.');
  }
  let settled = false;
  const finish = (value, runtimeFailed) => {
    if (settled) return;
    settled = true;
    callback(value, runtimeFailed);
  };
  const chromeCallback = value => {
    let runtimeFailed = true;
    try { runtimeFailed = Boolean(chromeApi.runtime.lastError); } catch { /* falha fechada */ }
    finish(value, runtimeFailed);
  };
  try {
    const result = chromeApi.runtime.sendMessage(message, chromeCallback);
    if (result && typeof result.then === 'function') {
      result.catch(() => {});
    }
  } catch {
    finish(undefined, true);
  }
}

export function resolveCurrentPanelTabId(chromeApi, timeoutMs = 3_000) {
  if (typeof chromeApi?.tabs?.getCurrent !== 'function') return Promise.resolve(null);
  return new Promise(resolve => {
    let settled = false;
    const timer = setTimeout(() => finish(null), Math.max(1, timeoutMs));
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const callback = tab => {
      try {
        if (chromeApi.runtime?.lastError) return finish(null);
      } catch { return finish(null); }
      let descriptor;
      try { descriptor = Object.getOwnPropertyDescriptor(tab, 'id'); } catch { return finish(null); }
      const tabId = descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : null;
      finish(Number.isSafeInteger(tabId) && tabId >= 0 ? tabId : null);
    };
    try {
      const result = chromeApi.tabs.getCurrent(callback);
      if (result && typeof result.then === 'function') result.catch(() => {});
    } catch { finish(null); }
  });
}

export function parseContextPrefillCommitMessage(message, currentPanelTabId) {
  const parsed = clonePersonaRecord(message);
  if (!personaExactKeys(parsed, ['type', 'requestId', 'panelTabId']) ||
    parsed.type !== 'AUDIT_CONTEXT_PREFILL_COMMIT' || !personaIdentifier(parsed.requestId) ||
    !Number.isSafeInteger(parsed.panelTabId) || parsed.panelTabId < 0 ||
    parsed.panelTabId !== currentPanelTabId) return null;
  return { requestId: parsed.requestId, panelTabId: parsed.panelTabId };
}

function createContextProtocolAck(type, requestId, panelTabId, accepted) {
  if (!personaIdentifier(requestId) || !Number.isSafeInteger(panelTabId) || panelTabId < 0 ||
    typeof accepted !== 'boolean') return null;
  return { type, requestId, panelTabId, accepted };
}

export function reducePanelState(current, message, extensionBaseUrl = '') {
  if (!current || typeof current !== 'object' || !message || typeof message !== 'object') return current;
  if (!isMessageForAudit(message, current.auditId)) return current;
  if (message.type === 'AUDIT_PROGRESS') {
    if (['complete', 'partial', 'failed', 'cancelled'].includes(current.status)) return current;
    const percent = Number.isFinite(message.percent) ? Math.max(0, Math.min(100, message.percent)) : current.percent;
    if (percent < (current.percent ?? 0)) return current;
    return {
      ...current,
      status: 'running',
      percent,
      message: typeof message.message === 'string' ? message.message : current.message,
    };
  }
  if (message.type === 'AUDIT_COMPLETE') {
    const preservedExportStatus = ['queued', 'running', 'delivering', 'complete', 'partial', 'failed'].includes(current.exportStatus)
      ? current.exportStatus
      : message.exportStatus === 'preparing' ? 'preparing' : current.exportStatus;
    return {
      ...current,
      status: message.status === 'partial' ? 'partial' : 'complete',
      percent: 100,
      message: message.status === 'partial' ? 'Auditoria concluída com limitações.' : 'Auditoria concluída.',
      reviewUrl: isSafeReportUrl(message.reviewUrl, extensionBaseUrl) ? message.reviewUrl : null,
      ...(preservedExportStatus ? { exportStatus: preservedExportStatus } : {}),
    };
  }
  if (message.type === 'AUDIT_FAILED') {
    return {
      ...current,
      status: message.status === 'cancelled' ? 'cancelled' : 'failed',
      message: typeof message.error === 'string' ? message.error : 'A auditoria não pôde ser concluída.',
      reviewUrl: null,
    };
  }
  if (message.type === 'AUDIT_REVIEW_UPDATED') {
    const incomingRevision = message.exportRevision;
    if (!Number.isSafeInteger(incomingRevision) || incomingRevision < 0) return current;
    const currentRevision = Number.isSafeInteger(current.exportRevision) && current.exportRevision >= 0
      ? current.exportRevision
      : null;
    if (currentRevision !== null && incomingRevision <= currentRevision) return current;
    const { exportAttempt: _exportAttempt, leaseOwnerId: _leaseOwnerId, deliveryReceipt: _deliveryReceipt, ...rest } = current;
    return {
      ...rest,
      exportStatus: 'preparing',
      exportRevision: incomingRevision,
      message: 'A revisão foi atualizada; gere o relatório novamente.',
    };
  }
  if (message.type === 'EXPORT_PROGRESS') {
    return applyExportEvent(current, message, 'running', {
      message: typeof message.message === 'string' ? message.message : 'Gerando os arquivos do relatório.',
    });
  }
  if (message.type === 'EXPORT_COMPLETE') {
    const exportStatus = message.status === 'partial' ? 'partial' : 'complete';
    return applyExportEvent(current, message, exportStatus, {
      message: exportStatus === 'partial' ? 'Relatório gerado com limitações.' : 'Arquivos do relatório gerados.',
    });
  }
  if (message.type === 'EXPORT_FAILED') {
    return applyExportEvent(current, message, 'failed', {
      message: typeof message.error === 'string' ? message.error : 'Não foi possível gerar os arquivos do relatório.',
    });
  }
  if (message.type === 'EXPORT_INVALIDATED') {
    return applyExportEvent(current, message, 'preparing', {
      message: typeof message.error === 'string'
        ? message.error
        : 'A auditoria foi atualizada; gere o relatório novamente.',
    });
  }
  return current;
}

export function applyExportEvent(current, message, exportStatus, patch = {}) {
  const incomingRevision = message.exportRevision;
  const incomingAttempt = message.exportAttempt;
  const incomingOwner = message.leaseOwnerId;
  if (!Number.isSafeInteger(incomingRevision) || incomingRevision < 0 ||
    !Number.isSafeInteger(incomingAttempt) || incomingAttempt < 1 ||
    typeof incomingOwner !== 'string' || !VALID_CORRELATION_ID.test(incomingOwner) ||
    !EXPORT_STATUSES.has(exportStatus)) return current;
  const currentRevision = Number.isSafeInteger(current.exportRevision) && current.exportRevision >= 0
    ? current.exportRevision
    : null;
  const currentAttempt = Number.isSafeInteger(current.exportAttempt) && current.exportAttempt >= 1
    ? current.exportAttempt
    : null;
  if (currentRevision !== null && incomingRevision < currentRevision) return current;
  if (currentAttempt !== null) {
    if (incomingAttempt < currentAttempt) return current;
    if (incomingAttempt === currentAttempt) {
      if (typeof current.leaseOwnerId === 'string' && current.leaseOwnerId !== incomingOwner) return current;
      if (incomingRevision === currentRevision && (
        (EXPORT_PHASE_ORDER[exportStatus] ?? -1) < (EXPORT_PHASE_ORDER[current.exportStatus] ?? -1) ||
        EXPORT_TERMINAL_STATUSES.has(current.exportStatus)
      )) return current;
    }
  }
  return {
    ...current,
    ...patch,
    exportStatus,
    exportRevision: incomingRevision,
    exportAttempt: incomingAttempt,
    leaseOwnerId: incomingOwner,
  };
}

export function restoreExportEventState(saved) {
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return {};
  const restored = {};
  if (EXPORT_STATUSES.has(saved.exportStatus)) restored.exportStatus = saved.exportStatus;
  if (Number.isSafeInteger(saved.exportRevision) && saved.exportRevision >= 0) {
    restored.exportRevision = saved.exportRevision;
  }
  if (Number.isSafeInteger(saved.exportAttempt) && saved.exportAttempt >= 1) {
    restored.exportAttempt = saved.exportAttempt;
  }
  if (typeof saved.leaseOwnerId === 'string' && VALID_CORRELATION_ID.test(saved.leaseOwnerId)) {
    restored.leaseOwnerId = saved.leaseOwnerId;
  }
  return restored;
}

export function createInitialPersonaState() {
  return {
    connection: 'connecting', bound: false, targetTabId: null, token: null, generation: 0,
    activeMode: null, reader: personaIdleReader(), limitations: [], coverage: null,
    preferences: { voiceId: '', rate: 1 }, pending: null,
    helloRequestId: null,
    message: 'Conectando as simulações à aba de origem.', code: null,
  };
}

export function createPersonaHello(requestId) {
  if (!personaIdentifier(requestId)) return null;
  return {
    protocol: PERSONA_PROTOCOL, version: 1, type: 'hello', requestId,
  };
}

export function expectPersonaHello(current, requestId) {
  if (!current || current.connection !== 'connecting' || !personaIdentifier(requestId)) return current;
  return { ...current, helloRequestId: requestId };
}

export function queuePersonaCommand(current, requestId, command, args = {}) {
  if (!current || current.connection !== 'ready' || current.bound !== true || current.pending ||
    !personaIdentifier(current.token) || !Number.isSafeInteger(current.generation) ||
    !personaIdentifier(requestId) || !validPersonaCommand(command, args)) return null;
  return {
    state: {
      ...current,
      pending: { requestId, command },
      message: personaPendingMessage(command, args),
      code: null,
    },
    message: {
      protocol: PERSONA_PROTOCOL, version: 1, type: 'command', requestId,
      token: current.token, generation: current.generation, command,
      args: personaCopyArgs(command, args),
    },
  };
}

export function reducePersonaState(current, message) {
  if (!current || typeof current !== 'object') return current;
  const parsed = clonePersonaRecord(message);
  if (!parsed || parsed.protocol !== PERSONA_PROTOCOL || parsed.version !== 1 ||
    !personaIdentifier(parsed.requestId)) return current;
  if (parsed.type === 'error') return reducePersonaError(current, parsed);
  if (parsed.type !== 'state') return current;
  if (parsed.ok === false && parsed.bound === false) {
    if (!personaExactKeys(parsed, PERSONA_UNBOUND_KEYS) || !personaIdentifier(parsed.code) ||
      !personaText(parsed.message, 512)) return current;
    if (['connecting', 'unbound'].includes(current.connection) &&
      current.helloRequestId !== parsed.requestId) return current;
    return {
      ...createInitialPersonaState(), connection: 'unbound', message: parsed.message,
      code: parsed.code,
    };
  }
  if (!personaExactKeys(parsed, PERSONA_STATE_KEYS) || parsed.ok !== true || parsed.bound !== true ||
    !Number.isSafeInteger(parsed.targetTabId) || parsed.targetTabId < 0 || !personaIdentifier(parsed.token) ||
    !Number.isSafeInteger(parsed.generation) || parsed.generation < 0 ||
    (parsed.activeMode !== null && !PERSONA_MODES.has(parsed.activeMode)) ||
    parsed.coverage !== 'dom-fallback-top-document-open-shadow' ||
    !personaPreferences(parsed.preferences)) return current;
  const reader = personaReader(parsed.reader);
  const limitations = personaLimitations(parsed.limitations);
  if (!reader || !limitations) return current;

  const isInitial = current.connection === 'connecting' || current.connection === 'unbound';
  if (isInitial && current.helloRequestId !== parsed.requestId) return current;
  const tokenMatches = current.token === parsed.token;
  const targetMatches = current.targetTabId === parsed.targetTabId;
  const requestMatches = current.pending?.requestId === parsed.requestId;
  const sameGenerationEvent = tokenMatches && targetMatches && parsed.generation === current.generation;
  if (!isInitial && (!tokenMatches || !targetMatches)) return current;
  if (!isInitial && !requestMatches && !sameGenerationEvent) return current;
  if (!isInitial && parsed.generation < current.generation) return current;
  return {
    connection: 'ready', bound: true, targetTabId: parsed.targetTabId, token: parsed.token,
    generation: parsed.generation, activeMode: parsed.activeMode, reader, limitations,
    coverage: parsed.coverage, preferences: { ...parsed.preferences },
    pending: requestMatches ? null : current.pending,
    helloRequestId: null,
    message: personaReadyMessage(parsed.activeMode, reader, limitations), code: null,
  };
}

function reducePersonaError(current, parsed) {
  if (!personaExactKeys(parsed, PERSONA_ERROR_KEYS) || parsed.ok !== false || parsed.bound !== true ||
    !personaIdentifier(parsed.code) || !personaText(parsed.message, 512)) return current;
  const requestMatches = current.pending?.requestId === parsed.requestId;
  const helloMatches = current.connection === 'connecting' && current.helloRequestId === parsed.requestId;
  if (!requestMatches && !helloMatches && parsed.code !== 'PERSONA_TARGET_CHANGED') return current;
  if (helloMatches) {
    return {
      ...current, connection: 'error', token: null, activeMode: null, helloRequestId: null,
      reader: personaIdleReader(current.preferences), limitations: [], pending: null,
      message: parsed.message, code: parsed.code,
    };
  }
  if (parsed.code === 'PERSONA_TARGET_CHANGED') {
    return {
      ...current, connection: 'error', token: null, activeMode: null,
      reader: personaIdleReader(current.preferences), limitations: [], pending: null, helloRequestId: null,
      message: parsed.message, code: parsed.code,
    };
  }
  return {
    ...current, pending: null, helloRequestId: null, message: parsed.message, code: parsed.code,
  };
}

function validPersonaCommand(command, args) {
  if (command === 'activate') return personaExactKeys(args, ['mode']) && PERSONA_MODES.has(args.mode);
  if (command === 'preferences') return personaPreferences(args);
  if (command === 'reader-action') {
    return personaExactKeys(args, ['action']) && PERSONA_READER_ACTIONS.has(args.action);
  }
  return (command === 'stop' || command === 'go-target') && personaExactKeys(args, []);
}

function personaCopyArgs(command, args) {
  if (command === 'activate') return { mode: args.mode };
  if (command === 'preferences') return { voiceId: args.voiceId, rate: args.rate };
  if (command === 'reader-action') return { action: args.action };
  return {};
}

function personaPreferences(value) {
  return personaExactKeys(value, ['voiceId', 'rate']) && personaVoiceId(value.voiceId) &&
    typeof value.rate === 'number' && Number.isFinite(value.rate) && value.rate >= 0.5 && value.rate <= 2;
}

function personaReader(value) {
  if (!personaExactKeys(value, PERSONA_READER_KEYS) || !['idle', 'playing', 'paused'].includes(value.playback) ||
    !Number.isSafeInteger(value.index) || value.index < -1 || value.index > 2_000 ||
    !Number.isSafeInteger(value.total) || value.total < 0 || value.total > 2_000 ||
    !personaText(value.caption, 2_048) || typeof value.canPrevious !== 'boolean' ||
    typeof value.canNext !== 'boolean' || !personaText(value.speechAvailability, 32) ||
    !personaVoiceId(value.voiceId) || typeof value.rate !== 'number' || !Number.isFinite(value.rate) ||
    value.rate < 0.5 || value.rate > 2) return null;
  return {
    playback: value.playback, index: value.index, total: value.total, caption: value.caption,
    canPrevious: value.canPrevious, canNext: value.canNext,
    speechAvailability: value.speechAvailability, voiceId: value.voiceId, rate: value.rate,
  };
}

function personaLimitations(value) {
  if (!Array.isArray(value) || value.length > 64) return null;
  const result = [];
  for (const item of value) {
    const truncated = item?.truncated === true;
    const expectedKeys = truncated ? ['code', 'count', 'truncated'] : ['code', 'count'];
    if (!personaExactKeys(item, expectedKeys) || !personaText(item.code, 64) ||
      !Number.isSafeInteger(item.count) || item.count < 1 || item.count > 10_000) return null;
    if (truncated && item.code !== 'dom-traversal-truncated') return null;
    result.push(truncated
      ? { code: item.code, count: item.count, truncated: true }
      : { code: item.code, count: item.count });
  }
  return result;
}

function personaIdleReader(preferences = {}) {
  return {
    playback: 'idle', index: -1, total: 0, caption: '', canPrevious: false, canNext: false,
    speechAvailability: 'unknown', voiceId: personaVoiceId(preferences.voiceId) ? preferences.voiceId : '',
    rate: typeof preferences.rate === 'number' && preferences.rate >= 0.5 && preferences.rate <= 2 ? preferences.rate : 1,
  };
}

function personaPendingMessage(command, args) {
  if (command === 'activate') return `Ativando ${PERSONA_MODE_LABELS[args.mode]}.`;
  if (command === 'stop' || (command === 'reader-action' && args.action === 'stop')) return 'Encerrando a simulação.';
  if (command === 'go-target') return 'Abrindo a aba simulada.';
  if (command === 'preferences') return 'Salvando voz e velocidade neste navegador.';
  return 'Executando o controle de leitura simulada.';
}

function personaReadyMessage(activeMode, reader, limitations) {
  if (activeMode === 'reader') {
    if (reader.speechAvailability === 'busy') return 'Leitura simulada ativa; a fala da página está ocupada e a legenda continua disponível.';
    if (['unavailable', 'error'].includes(reader.speechAvailability)) return 'Leitura simulada ativa sem fala; use a legenda e a navegação.';
    return reader.playback === 'paused' ? 'Leitura simulada pausada.' : 'Leitura simulada ativa.';
  }
  if (activeMode === 'achromatopsia') return 'Simulação qualitativa de acromatopsia ativa.';
  if (activeMode === 'motor') return 'Simulação motora/teclado ativa. Pressione Escape três vezes para sair.';
  return limitations.length ? 'Simulação encerrada; há limitações de cobertura registradas.' : 'Nenhuma simulação ativa.';
}

function clonePersonaRecord(value) {
  const result = clonePersonaData(value, 0, { count: 0 });
  return result.ok && result.value && typeof result.value === 'object' && !Array.isArray(result.value)
    ? result.value
    : null;
}

function clonePersonaData(value, depth, budget) {
  if (depth > 8 || budget.count > 256) return { ok: false };
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return { ok: true, value };
  if (typeof value === 'number' && Number.isFinite(value)) return { ok: true, value };
  if (!value || typeof value !== 'object') return { ok: false };
  let descriptors;
  try { descriptors = Object.getOwnPropertyDescriptors(value); } catch { return { ok: false }; }
  if (Array.isArray(value)) {
    if (value.length > 64 || Object.keys(descriptors).some(key => key !== 'length' && !/^\d+$/u.test(key))) return { ok: false };
    const output = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[index];
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) return { ok: false };
      budget.count += 1;
      const child = clonePersonaData(descriptor.value, depth + 1, budget);
      if (!child.ok) return child;
      output.push(child.value);
    }
    return { ok: true, value: output };
  }
  const output = Object.create(null);
  for (const key of Object.keys(descriptors)) {
    const descriptor = descriptors[key];
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) return { ok: false };
    budget.count += 1;
    const child = clonePersonaData(descriptor.value, depth + 1, budget);
    if (!child.ok) return child;
    output[key] = child.value;
  }
  return { ok: true, value: output };
}

function personaExactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  const wanted = expected.slice().sort();
  return keys.length === wanted.length && keys.every((key, index) => key === wanted[index]);
}

function personaIdentifier(value) {
  return typeof value === 'string' && VALID_CORRELATION_ID.test(value);
}

function personaVoiceId(value) {
  return typeof value === 'string' && Array.from(value).length <= 200 && !/[\u0000-\u001f\u007f]/u.test(value);
}

function personaText(value, maximum) {
  return typeof value === 'string' && Array.from(value).length <= maximum && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
}

const PERSONA_PROTOCOL = 'audita-persona-panel';
const PERSONA_MODES = new Set(['reader', 'achromatopsia', 'motor']);
const PERSONA_READER_ACTIONS = new Set(['start', 'pause', 'resume', 'stop', 'repeat', 'previous', 'next']);
const PERSONA_MODE_LABELS = Object.freeze({
  reader: 'a leitura simulada', achromatopsia: 'a simulação de acromatopsia', motor: 'a simulação motora/teclado',
});
const PERSONA_READER_KEYS = [
  'playback', 'index', 'total', 'caption', 'canPrevious', 'canNext',
  'speechAvailability', 'voiceId', 'rate',
];
const PERSONA_STATE_KEYS = [
  'protocol', 'version', 'type', 'requestId', 'ok', 'bound', 'targetTabId', 'token', 'generation',
  'activeMode', 'reader', 'limitations', 'coverage', 'preferences',
];
const PERSONA_UNBOUND_KEYS = ['protocol', 'version', 'type', 'requestId', 'ok', 'bound', 'code', 'message'];
const PERSONA_ERROR_KEYS = ['protocol', 'version', 'type', 'requestId', 'ok', 'bound', 'code', 'message'];
const EXPORT_STATUSES = new Set(['preparing', 'queued', 'running', 'delivering', 'complete', 'partial', 'failed']);
const EXPORT_PHASE_ORDER = Object.freeze({
  preparing: 0,
  queued: 1,
  running: 2,
  delivering: 3,
  complete: 4,
  partial: 4,
  failed: 4,
});
const EXPORT_TERMINAL_STATUSES = new Set(['complete', 'partial', 'failed']);
const VALID_CORRELATION_ID = /^[A-Za-z0-9._:-]{1,200}$/u;
