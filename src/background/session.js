const ACTIVE_STATES = new Set(['navigating', 'collecting', 'testing', 'capturing', 'partial', 'reporting']);
const TERMINAL_STATES = new Set(['complete', 'failed', 'cancelled']);
const BATCH_TERMINAL_STATES = new Set(['complete', 'partial', 'failed', 'cancelled']);
const BATCH_PAGE_STATUSES = new Set(['complete', 'partial', 'failed', 'cancelled']);

const TRANSITIONS = {
  idle: { NAVIGATE: 'navigating' },
  navigating: { COLLECT: 'collecting' },
  collecting: { TEST: 'testing' },
  testing: { CAPTURE: 'capturing' },
  capturing: { REPORT: 'reporting', CAPTURE_FAILED: 'partial' },
  partial: { REPORT: 'reporting' },
  reporting: { COMPLETE: 'complete' },
};

export function createAuditSession({ id, requestedUrl, startedAt }) {
  if (typeof id !== 'string' || !id || typeof requestedUrl !== 'string' || !requestedUrl || typeof startedAt !== 'string' || !startedAt) {
    throw new TypeError('Sessão de auditoria inválida.');
  }
  return freezeSession({
    id,
    requestedUrl,
    startedAt,
    state: 'idle',
    diagnostics: [],
    partial: false,
  });
}

export function transitionSession(session, event) {
  if (!session || typeof session !== 'object' || !event || typeof event.type !== 'string') {
    throw new TypeError('Evento de sessão inválido.');
  }
  if (TERMINAL_STATES.has(session.state)) {
    throw new Error(`A sessão está em estado terminal: ${session.state}.`);
  }
  if (event.type === 'CAPTURE_FAILED' && event.diagnostic === undefined) {
    throw new TypeError('Diagnóstico de captura obrigatório.');
  }

  if (event.type === 'FAIL' || event.type === 'CANCEL') {
    if (!ACTIVE_STATES.has(session.state)) throw new Error(`Transição inválida: ${session.state} → ${event.type}.`);
    return withDiagnostic({
      ...session,
      state: event.type === 'FAIL' ? 'failed' : 'cancelled',
      ...(event.at ? { endedAt: event.at } : {}),
    }, event.diagnostic, event.at);
  }

  const nextState = TRANSITIONS[session.state]?.[event.type];
  if (!nextState) {
    throw new Error(`Transição inválida: ${session.state} → ${event.type}.`);
  }
  return withDiagnostic({
    ...session,
    state: nextState,
    partial: session.partial || event.type === 'CAPTURE_FAILED',
    ...(event.type === 'COMPLETE' && event.at ? { completedAt: event.at } : {}),
  }, event.type === 'CAPTURE_FAILED' ? event.diagnostic : undefined, event.at);
}

export function createBatchSession({ id, total, startedAt }) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/u.test(id) ||
    !Number.isSafeInteger(total) || total < 1 || total > 20 ||
    typeof startedAt !== 'string' || !startedAt) {
    throw new TypeError('Sessão de lote inválida.');
  }
  return freezeBatchSession({
    id,
    mode: 'batch',
    state: 'idle',
    total,
    currentIndex: 0,
    completedCount: 0,
    statusCounts: { complete: 0, partial: 0, failed: 0, cancelled: 0 },
    cancelRequested: false,
    startedAt,
    updatedAt: startedAt,
    resumable: false,
  });
}

export function transitionBatchSession(session, event) {
  assertBatchSession(session);
  if (!event || typeof event !== 'object' || typeof event.type !== 'string') {
    throw new TypeError('Evento de lote inválido.');
  }
  if (BATCH_TERMINAL_STATES.has(session.state)) {
    throw new Error(`A sessão de lote está em estado terminal: ${session.state}.`);
  }
  if (event.type === 'CANCEL' && session.state === 'cancelling') return session;
  const at = typeof event.at === 'string' && event.at ? event.at : session.updatedAt;
  const simpleTransitions = {
    idle: { VALIDATE: 'validating' },
    validating: { QUEUE: 'queued' },
    queued: { START: 'running', CANCEL: 'cancelling' },
    running: { CANCEL: 'cancelling' },
  };
  const simpleState = simpleTransitions[session.state]?.[event.type];
  if (simpleState) {
    return freezeBatchSession({
      ...session,
      state: simpleState,
      cancelRequested: session.cancelRequested || event.type === 'CANCEL',
      updatedAt: at,
    });
  }
  if (session.state === 'running' && event.type === 'PAGE_FINISHED') {
    if (!BATCH_PAGE_STATUSES.has(event.status) || session.completedCount >= session.total) {
      throw new TypeError('Resultado de página do lote inválido.');
    }
    return freezeBatchSession({
      ...session,
      currentIndex: session.currentIndex + 1,
      completedCount: session.completedCount + 1,
      statusCounts: {
        ...session.statusCounts,
        [event.status]: session.statusCounts[event.status] + 1,
      },
      updatedAt: at,
    });
  }
  if (session.state === 'running' && event.type === 'FINISH') {
    if (session.completedCount !== session.total) throw new Error('Transição inválida: o lote ainda possui páginas pendentes.');
    return freezeBatchSession({ ...session, state: batchTerminalStatus(session), updatedAt: at });
  }
  if (session.state === 'cancelling' && event.type === 'MARK_REMAINING_CANCELLED') {
    const count = event.count;
    if (!Number.isSafeInteger(count) || count < 0 || session.completedCount + count !== session.total) {
      throw new TypeError('Quantidade cancelada do lote inválida.');
    }
    return freezeBatchSession({
      ...session,
      state: 'cancelled',
      currentIndex: session.total,
      completedCount: session.total,
      statusCounts: { ...session.statusCounts, cancelled: session.statusCounts.cancelled + count },
      updatedAt: at,
    });
  }
  throw new Error(`Transição inválida: ${session.state} → ${event.type}.`);
}

export function interruptBatchCheckpoint(checkpoint, at) {
  assertBatchSession(checkpoint);
  if (typeof at !== 'string' || !at) throw new TypeError('Instante de interrupção inválido.');
  return freezeBatchSession({ ...checkpoint, state: 'failed', updatedAt: at, resumable: false });
}

function batchTerminalStatus(session) {
  if (session.cancelRequested || session.statusCounts.cancelled > 0) return 'cancelled';
  if (session.statusCounts.complete === session.total) return 'complete';
  if (session.statusCounts.failed === session.total) return 'failed';
  return 'partial';
}

function assertBatchSession(session) {
  if (!session || typeof session !== 'object' || session.mode !== 'batch' ||
    typeof session.id !== 'string' || !Number.isSafeInteger(session.total) || session.total < 1 || session.total > 20 ||
    !Number.isSafeInteger(session.currentIndex) || session.currentIndex < 0 || session.currentIndex > session.total ||
    !Number.isSafeInteger(session.completedCount) || session.completedCount < 0 || session.completedCount > session.total ||
    typeof session.cancelRequested !== 'boolean' || session.resumable !== false ||
    typeof session.startedAt !== 'string' || typeof session.updatedAt !== 'string' ||
    !session.statusCounts || typeof session.statusCounts !== 'object') {
    throw new TypeError('Sessão de lote inválida.');
  }
  for (const status of BATCH_PAGE_STATUSES) {
    if (!Number.isSafeInteger(session.statusCounts[status]) || session.statusCounts[status] < 0) {
      throw new TypeError('Contagens de estado do lote inválidas.');
    }
  }
}

function freezeBatchSession(session) {
  const statusCounts = Object.freeze({ ...session.statusCounts });
  return Object.freeze({ ...session, statusCounts });
}

function withDiagnostic(session, diagnostic, at) {
  const diagnostics = diagnostic === undefined
    ? session.diagnostics
    : [...session.diagnostics, normalizeDiagnostic(diagnostic, at)];
  return freezeSession({ ...session, diagnostics });
}

function normalizeDiagnostic(diagnostic, at) {
  const value = typeof diagnostic === 'string'
    ? { code: 'SESSION_EVENT', message: diagnostic }
    : diagnostic;
  if (!value || typeof value !== 'object' || typeof value.message !== 'string' || !value.message.trim() || !isJsonSafe(diagnostic)) {
    throw new TypeError('Diagnóstico de sessão inválido.');
  }
  const normalized = {
    ...(typeof value.code === 'string' ? { code: value.code } : {}),
    message: value.message.trim(),
    ...(at ? { at } : {}),
  };
  JSON.stringify(normalized);
  return normalized;
}

function isJsonSafe(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  const safe = Array.isArray(value)
    ? value.every((item) => isJsonSafe(item, seen))
    : Object.keys(value).every((key) => isJsonSafe(value[key], seen));
  seen.delete(value);
  return safe;
}

function freezeSession(session) {
  const diagnostics = Object.freeze(session.diagnostics.map((diagnostic) => Object.freeze({ ...diagnostic })));
  return Object.freeze({ ...session, diagnostics });
}
