const OPAQUE_CAPABILITY = /^[A-Za-z0-9_-]{20,240}$/u;
const PERSONA_LEASE_ID = /^lease-[A-Za-z0-9_-]{22}$/u;
const PANEL_TO_WORKER_MODE = Object.freeze({
  reader: 'reader',
  achromatopsia: 'achromatopsia',
  keyboard: 'motor',
});
const WORKER_TO_PANEL_MODE = Object.freeze({
  reader: 'reader',
  achromatopsia: 'achromatopsia',
  motor: 'keyboard',
});
const READER_ACTIONS = new Set(['previous', 'repeat', 'pause', 'resume', 'next']);
const ABSENT_PERSONA_CODES = new Set([
  'PERSONA_NOT_FOUND', 'PERSONA_EXPIRED', 'PERSONA_TARGET_CHANGED',
  'PERSONA_RUNTIME_MISMATCH', 'PERSONA_REVOKED_AFTER_RUNTIME_FAILURE',
  'PERSONA_READER_ACTION_TERMINAL',
]);
const AMBIGUOUS_PERSONA_CODES = new Set([
  'PERSONA_STATE_FAILED', 'PERSONA_RUNTIME_FAILED', 'PERSONA_READER_RUNTIME_FAILED',
  'PERSONA_CLEANUP_UNCONFIRMED', 'PERSONA_READER_INACTIVE',
]);

export function createPanelPersonaSession(raw) {
  const input = exactRecord(raw, ['requestIntent', 'createRequestId', 'onEvent']);
  if (!input || typeof input.requestIntent !== 'function' || typeof input.createRequestId !== 'function' ||
    typeof input.onEvent !== 'function') throw new TypeError('PANEL_PERSONA_SESSION_INVALID');

  let activeLease = null;
  let operation = false;
  let operationRevision = 0;
  let readerRefreshPending = false;
  let lastReaderSnapshot = null;
  let lastReaderLease = null;

  function emit(event) {
    if (['PERSONA_SELECTED', 'PERSONA_ENDED', 'PERSONA_SYNCHRONIZED_NONE'].includes(event.type)) {
      lastReaderSnapshot = null;
      lastReaderLease = null;
    }
    try { input.onEvent(deepFreeze({ ...event })); } catch { /* UI callbacks never own the session. */ }
  }

  function publishReaderState(reader, deduplicate = false) {
    const snapshot = JSON.stringify(reader);
    if (deduplicate && lastReaderLease === activeLease && lastReaderSnapshot === snapshot) return;
    lastReaderLease = activeLease;
    lastReaderSnapshot = snapshot;
    emit({ type: 'PERSONA_READER_STATE', ...reader });
  }

  function clearAbsentLease(response) {
    const failure = exactRecord(response, ['ok', 'code']);
    if (failure?.ok !== false || !ABSENT_PERSONA_CODES.has(failure.code) || !activeLease) return false;
    activeLease = null;
    emit({ type: 'PERSONA_ENDED' });
    return true;
  }

  async function reconcileAmbiguousFailure(response, fallbackCode) {
    const failure = exactRecord(response, ['ok', 'code']);
    if (failure?.ok !== false || !AMBIGUOUS_PERSONA_CODES.has(failure.code) || !activeLease) return null;
    const synchronized = await synchronizeCore();
    return synchronized.ok && synchronized.state === 'none'
      ? frozenResult(false, 'PANEL_PERSONA_ENDED')
      : frozenResult(false, fallbackCode);
  }

  async function request(envelope) {
    try { return await input.requestIntent(deepFreeze({ ...envelope })); }
    catch { return null; }
  }

  async function preparedCapability() {
    let requestId;
    try { requestId = input.createRequestId(); } catch { return null; }
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9._:-]{1,160}$/u.test(requestId)) return null;
    const response = exactRecord(await request({
      type: 'PREPARE_PANEL_PERSONA_CAPABILITY', requestId,
    }), ['ok', 'requestId', 'capabilityId']);
    return response?.ok === true && response.requestId === requestId &&
      OPAQUE_CAPABILITY.test(response.capabilityId ?? '')
      ? response.capabilityId
      : null;
  }

  async function refreshReaderStateCore() {
    if (!activeLease || activeLease.activeMode !== 'reader') return false;
    const reader = parseReaderResponse(await request({
      type: 'PANEL_READER_STATE', leaseId: activeLease.leaseId,
    }));
    if (!reader) return false;
    publishReaderState(reader);
    return true;
  }

  async function refreshReaderState() {
    if (operation || readerRefreshPending || activeLease?.activeMode !== 'reader') return false;
    const lease = activeLease;
    const revision = operationRevision;
    readerRefreshPending = true;
    try {
      const response = await request({ type: 'PANEL_READER_STATE', leaseId: lease.leaseId });
      if (activeLease !== lease || operation || operationRevision !== revision) return false;
      const reader = parseReaderResponse(response);
      if (!reader) {
        clearAbsentLease(response);
        return false;
      }
      publishReaderState(reader, true);
      return true;
    } finally {
      readerRefreshPending = false;
    }
  }

  async function synchronizeCore() {
    const capabilityId = await preparedCapability();
    if (!capabilityId) {
      emit({ type: 'PERSONA_FAILED' });
      return frozenResult(false, 'PANEL_PERSONA_SYNC_FAILED');
    }
    const response = await request({ type: 'PANEL_REHYDRATE_PERSONA', capabilityId });
    const lease = parsePersonaLease(response, null, null);
    if (!lease) {
      const failure = exactRecord(response, ['ok', 'code']);
      if (failure?.ok === false && ABSENT_PERSONA_CODES.has(failure.code)) {
        activeLease = null;
        emit({ type: 'PERSONA_SYNCHRONIZED_NONE' });
        return frozenResult(true, 'none');
      }
      emit({ type: 'PERSONA_FAILED' });
      return frozenResult(false, 'PANEL_PERSONA_SYNC_FAILED');
    }
    activeLease = lease;
    emit({ type: 'PERSONA_SELECTED', mode: WORKER_TO_PANEL_MODE[lease.activeMode] });
    if (lease.activeMode !== 'reader') {
      return frozenActive(WORKER_TO_PANEL_MODE[lease.activeMode], undefined);
    }
    const readerState = await refreshReaderStateCore();
    if (!readerState) emit({ type: 'PERSONA_FAILED' });
    return frozenActive('reader', readerState);
  }

  async function synchronize() {
    if (operation) return frozenResult(false, 'PANEL_PERSONA_BUSY');
    operationRevision += 1;
    operation = true;
    try { return await synchronizeCore(); }
    finally { operation = false; }
  }

  async function select(panelMode) {
    const workerMode = PANEL_TO_WORKER_MODE[panelMode];
    if (!workerMode || operation) return frozenResult(false, 'PANEL_PERSONA_BUSY');
    operationRevision += 1;
    operation = true;
    const priorLease = activeLease;
    try {
      let response;
      if (priorLease === null) {
        const capabilityId = await preparedCapability();
        if (!capabilityId) {
          emit({ type: 'PERSONA_FAILED' });
          return frozenResult(false, 'PANEL_PERSONA_START_FAILED');
        }
        response = await request({ type: 'PANEL_START_PERSONA', capabilityId, mode: workerMode });
      } else {
        response = await request({
          type: 'PANEL_SET_PERSONA_MODE', leaseId: priorLease.leaseId, mode: workerMode,
        });
      }
      let expectedLeaseId = priorLease?.leaseId ?? null;
      let lease = parsePersonaLease(response, workerMode, expectedLeaseId);
      if (!lease && priorLease !== null && clearAbsentLease(response)) {
        const capabilityId = await preparedCapability();
        if (!capabilityId) {
          emit({ type: 'PERSONA_FAILED' });
          return frozenResult(false, 'PANEL_PERSONA_START_FAILED');
        }
        response = await request({ type: 'PANEL_START_PERSONA', capabilityId, mode: workerMode });
        expectedLeaseId = null;
        lease = parsePersonaLease(response, workerMode, expectedLeaseId);
      }
      if (!lease) {
        const failure = exactRecord(response, ['ok', 'code']);
        if (expectedLeaseId === null && failure?.ok === false && failure.code === 'PERSONA_CONFLICT') {
          return synchronizeCore();
        }
        const reconciled = await reconcileAmbiguousFailure(response, 'PANEL_PERSONA_START_FAILED');
        if (reconciled) return reconciled;
        emit({ type: 'PERSONA_FAILED' });
        return frozenResult(false, 'PANEL_PERSONA_START_FAILED');
      }
      activeLease = lease;
      emit({ type: 'PERSONA_SELECTED', mode: WORKER_TO_PANEL_MODE[lease.activeMode] });
      if (lease.activeMode !== 'reader') {
        return frozenActive(WORKER_TO_PANEL_MODE[lease.activeMode], undefined);
      }
      const readerState = await refreshReaderStateCore();
      if (!readerState) emit({ type: 'PERSONA_FAILED' });
      return frozenActive('reader', readerState);
    } finally {
      operation = false;
    }
  }

  async function readerAction(action) {
    if (operation || !READER_ACTIONS.has(action) || !activeLease || activeLease.activeMode !== 'reader') {
      return frozenResult(false, 'PANEL_PERSONA_BUSY');
    }
    operationRevision += 1;
    operation = true;
    try {
      const response = await request({
        type: 'PANEL_READER_ACTION', leaseId: activeLease.leaseId, action,
      });
      const reader = parseReaderResponse(response);
      if (!reader) {
        if (clearAbsentLease(response)) return frozenResult(false, 'PANEL_PERSONA_ENDED');
        const reconciled = await reconcileAmbiguousFailure(response, 'PANEL_READER_ACTION_FAILED');
        if (reconciled) return reconciled;
        emit({ type: 'PERSONA_FAILED' });
        return frozenResult(false, 'PANEL_READER_ACTION_FAILED');
      }
      publishReaderState(reader);
      return frozenActive('reader', true);
    } finally {
      operation = false;
    }
  }

  async function enableVoice() {
    if (operation || !activeLease || activeLease.activeMode !== 'reader') {
      return frozenResult(false, 'PANEL_PERSONA_BUSY');
    }
    operationRevision += 1;
    operation = true;
    try {
      const response = await request({
        type: 'PANEL_READER_ENABLE_VOICE', leaseId: activeLease.leaseId,
      });
      const reader = parseReaderResponse(response);
      if (reader) {
        publishReaderState(reader);
        return deepFreeze({ ok: true, state: 'active', voiceId: reader.voiceId });
      }
      const failure = exactRecord(response, ['ok', 'code']);
      if (failure?.ok === false && failure.code === 'PERSONA_READER_VOICE_UNAVAILABLE') {
        emit({ type: 'PERSONA_READER_VOICE_UNAVAILABLE' });
        return frozenResult(false, 'VOICE_UNAVAILABLE');
      }
      if (clearAbsentLease(response)) return frozenResult(false, 'PANEL_PERSONA_ENDED');
      const reconciled = await reconcileAmbiguousFailure(response, 'PANEL_READER_VOICE_FAILED');
      if (reconciled) return reconciled;
      emit({ type: 'PERSONA_FAILED' });
      return frozenResult(false, 'PANEL_READER_VOICE_FAILED');
    } finally {
      operation = false;
    }
  }

  async function stop() {
    if (operation || !activeLease) return frozenResult(false, 'PANEL_PERSONA_BUSY');
    operationRevision += 1;
    operation = true;
    try {
      const rawResponse = await request({
        type: 'PANEL_STOP_PERSONA', leaseId: activeLease.leaseId,
      });
      const response = exactRecord(rawResponse, ['ok', 'lease']);
      if (!response || response.ok !== true || response.lease !== null) {
        if (clearAbsentLease(rawResponse)) return frozenResult(true, 'none');
        const reconciled = await reconcileAmbiguousFailure(rawResponse, 'PANEL_PERSONA_STOP_FAILED');
        if (reconciled) return reconciled;
        emit({ type: 'PERSONA_FAILED' });
        return frozenResult(false, 'PANEL_PERSONA_STOP_FAILED');
      }
      activeLease = null;
      emit({ type: 'PERSONA_ENDED' });
      return frozenResult(true, 'none');
    } finally {
      operation = false;
    }
  }

  async function afterAuditAttempt(value) {
    const parsed = exactRecord(value, ['started']);
    if (!parsed || typeof parsed.started !== 'boolean') return frozenResult(false, 'PANEL_PERSONA_INPUT_INVALID');
    if (operation) return frozenResult(false, 'PANEL_PERSONA_BUSY');
    operationRevision += 1;
    if (parsed.started) {
      if (activeLease) emit({ type: 'PERSONA_ENDED' });
      activeLease = null;
      return frozenResult(true, 'none');
    }
    operation = true;
    try { return await synchronizeCore(); }
    finally { operation = false; }
  }

  return Object.freeze({ synchronize, select, readerAction, refreshReaderState, enableVoice, stop, afterAuditAttempt });
}

function parsePersonaLease(value, expectedMode, expectedLeaseId) {
  const response = exactRecord(value, ['ok', 'lease']);
  const lease = exactRecord(response?.lease, ['leaseId', 'activeMode', 'expiresAt']);
  if (!response || response.ok !== true || !lease || !PERSONA_LEASE_ID.test(lease.leaseId ?? '') ||
    !(lease.activeMode in WORKER_TO_PANEL_MODE) ||
    (expectedMode !== null && lease.activeMode !== expectedMode) ||
    !Number.isSafeInteger(lease.expiresAt) || lease.expiresAt < 0 ||
    (expectedLeaseId !== null && lease.leaseId !== expectedLeaseId)) return null;
  return deepFreeze({ ...lease });
}

function parseReaderResponse(value) {
  const response = exactRecord(value, ['ok', 'readerState']);
  const reader = exactRecord(response?.readerState, [
    'version', 'playback', 'index', 'total', 'caption', 'canPrevious', 'canNext',
    'speechAvailability', 'voiceId', 'rate',
  ]);
  if (!response || response.ok !== true || !reader || reader.version !== 1 ||
    !['idle', 'playing', 'paused'].includes(reader.playback) ||
    !Number.isSafeInteger(reader.index) || !Number.isSafeInteger(reader.total) ||
    reader.total < 0 || reader.total > 2000 || typeof reader.canPrevious !== 'boolean' ||
    typeof reader.canNext !== 'boolean' ||
    !['available', 'unavailable', 'busy', 'error'].includes(reader.speechAvailability) ||
    typeof reader.rate !== 'number' || !Number.isFinite(reader.rate) || reader.rate < 0.5 || reader.rate > 2 ||
    !canonicalText(reader.caption, 2048, true) || !canonicalText(reader.voiceId, 200, true)) return null;
  if (reader.playback === 'idle') {
    if (reader.index !== -1 || reader.total !== 0 || reader.caption !== '' ||
      reader.canPrevious || reader.canNext) return null;
  } else if (reader.total < 1 || reader.index < 0 || reader.index >= reader.total || reader.caption === '' ||
    reader.canPrevious !== (reader.index > 0) || reader.canNext !== (reader.index < reader.total - 1)) return null;
  return deepFreeze({ ...reader });
}

function canonicalText(value, maximum, allowEmpty) {
  if (typeof value !== 'string' || /[\u0000-\u001F\u007F]/u.test(value)) return false;
  const normalized = Array.from(value.replace(/\s+/gu, ' ').trim()).slice(0, maximum).join('');
  return Boolean(allowEmpty || normalized) && normalized === value;
}

function exactRecord(value, keys) {
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

function frozenResult(ok, value) {
  return ok ? deepFreeze({ ok: true, state: value }) : deepFreeze({ ok: false, code: value });
}

function frozenActive(mode, readerState) {
  return deepFreeze({ ok: true, state: 'active', mode, ...(readerState === undefined ? {} : { readerState }) });
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}
