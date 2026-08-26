const ACTIVE_STATES = new Set(['navigating', 'collecting', 'testing', 'capturing', 'partial', 'reporting']);
const TERMINAL_STATES = new Set(['complete', 'failed', 'cancelled']);

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
