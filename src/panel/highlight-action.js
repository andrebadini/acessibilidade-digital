const EVIDENCE_REASON = 'Esta verificação não possui um elemento único destacável no estado atual.';
const UNAVAILABLE_REASONS = new Set([
  'page-or-process', 'no-binding', 'expired', 'inaccessible', 'ambiguous', 'shadow-root',
  'document-changed', 'live-proof-failed',
]);

/**
 * Projects only a worker-approved binding state into one visible detail action.
 * The UI never derives a target from technical evidence or page data.
 */
export function highlightActionForOccurrence({ occurrence, bindingStatus, activeOccurrenceId } = {}) {
  const occurrenceId = typeof occurrence?.occurrenceId === 'string' ? occurrence.occurrenceId : null;
  if (!occurrenceId) return evidenceAction();
  if (activeOccurrenceId === occurrenceId) return freezeAction({ kind: 'clear', label: 'Limpar destaque', enabled: true, reason: null });
  if (['checking', 'unchecked'].includes(bindingStatus?.state)) {
    return freezeAction({ kind: 'checking', label: 'Verificando possibilidade de destaque', enabled: false, reason: null });
  }
  if (bindingStatus?.state === 'available') {
    return freezeAction({ kind: 'highlight', label: 'Ver e destacar na página', enabled: true, reason: null });
  }
  if (bindingStatus?.state === 'unavailable' && !UNAVAILABLE_REASONS.has(bindingStatus.reason)) return evidenceAction();
  return evidenceAction();
}

export async function runHighlightAction({ request, onState } = {}) {
  if (typeof request !== 'function' || typeof onState !== 'function') throw new TypeError('HIGHLIGHT_ACTION_INVALID');
  onState('busy');
  try { return await request(); }
  finally { onState('idle'); }
}

export function shouldApplyHighlightState(current, incoming) {
  if (!current || !incoming || typeof current !== 'object' || typeof incoming !== 'object') return false;
  if (incoming.state === 'active' && typeof incoming.occurrenceId === 'string' && incoming.occurrenceId) {
    return current.state !== 'active' || current.occurrenceId !== incoming.occurrenceId;
  }
  if (incoming.state === 'clear' && incoming.occurrenceId === null) {
    return current.state !== 'idle' || current.occurrenceId !== null;
  }
  return false;
}

export function createHighlightStateSynchronizer(raw) {
  const input = exactData(raw, ['requestCurrent', 'applyState']);
  if (!input || typeof input.requestCurrent !== 'function' || typeof input.applyState !== 'function') {
    throw new TypeError('HIGHLIGHT_SYNCHRONIZER_INVALID');
  }
  let eventRevision = 0;
  let synchronizationRevision = 0;

  function apply(value) {
    try { input.applyState(value); return true; }
    catch { return false; }
  }

  function publish(rawState) {
    const state = highlightState(rawState);
    if (!state) return false;
    eventRevision += 1;
    synchronizationRevision += 1;
    return apply(state);
  }

  async function synchronize() {
    const observedEvents = eventRevision;
    const ticket = ++synchronizationRevision;
    let response;
    try { response = await input.requestCurrent(); }
    catch { return false; }
    if (ticket !== synchronizationRevision || observedEvents !== eventRevision) return false;
    const result = exactData(response, ['ok', 'highlight']);
    const state = result?.ok === true ? highlightState(result.highlight) : null;
    return state ? apply(state) : false;
  }

  function invalidate() {
    synchronizationRevision += 1;
  }

  return Object.freeze({ publish, synchronize, invalidate });
}

function highlightState(value) {
  const clear = exactData(value, ['state']);
  if (clear?.state === 'clear') return Object.freeze({ state: 'clear', occurrenceId: null });
  const active = exactData(value, ['state', 'occurrenceId']);
  return active?.state === 'active' && typeof active.occurrenceId === 'string' &&
    /^[A-Za-z0-9._:-]{1,200}$/u.test(active.occurrenceId)
    ? Object.freeze(active)
    : null;
}

function exactData(value, keys) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return null;
    const own = Reflect.ownKeys(value);
    if (own.length !== keys.length || own.some(key => typeof key !== 'string' || !keys.includes(key))) return null;
    const copy = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      copy[key] = descriptor.value;
    }
    return copy;
  } catch { return null; }
}

function evidenceAction() {
  return freezeAction({ kind: 'evidence', label: 'Consultar evidências', enabled: true, reason: EVIDENCE_REASON });
}

function freezeAction(value) {
  return Object.freeze(value);
}
