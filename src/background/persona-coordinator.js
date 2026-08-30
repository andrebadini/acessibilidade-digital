const TARGET_KEYS = ['tabId', 'windowId', 'documentId', 'urlSessionDigest'];
const CONSUMER_KEYS = ['extensionId', 'documentId', 'path', 'windowId'];
const MODES = new Set(['reader', 'achromatopsia', 'motor']);
const LEASE_ID = /^lease-[A-Za-z0-9_-]{22}$/u;
const READER_ACTIONS = new Set(['previous', 'repeat', 'pause', 'resume', 'next', 'stop']);
const AUTONOMOUS_REASONS = new Set(['emergency-stop', 'lifecycle-stop', 'reader-terminal']);
const READER_STATE_KEYS = [
  'version', 'playback', 'index', 'total', 'caption', 'canPrevious', 'canNext',
  'speechAvailability', 'voiceId', 'rate',
];

function ownRecord(value, keys) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== keys.length ||
      ownKeys.some(key => typeof key !== 'string' || !keys.includes(key))) return null;
    const copy = Object.create(null);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      copy[key] = descriptor.value;
    }
    return copy;
  } catch {
    return null;
  }
}

function sameTarget(leftValue, rightValue) {
  const left = ownRecord(leftValue, TARGET_KEYS);
  const right = ownRecord(rightValue, TARGET_KEYS);
  return Boolean(left && right && left.tabId === right.tabId && left.windowId === right.windowId &&
    left.documentId === right.documentId && left.urlSessionDigest === right.urlSessionDigest);
}

function sameConsumer(leftValue, rightValue) {
  const left = ownRecord(leftValue, CONSUMER_KEYS);
  const right = ownRecord(rightValue, CONSUMER_KEYS);
  return Boolean(left && right && left.extensionId === right.extensionId &&
    left.documentId === right.documentId && left.path === right.path && left.windowId === right.windowId);
}

function successLease(lease) {
  return Object.freeze({ ok: true, lease });
}

function failure(code) {
  return Object.freeze({ ok: false, code });
}

function storeFailure(result, fallback = 'PERSONA_STATE_FAILED') {
  return failure(typeof result?.code === 'string' ? result.code : fallback);
}

function activeLeases(snapshot) {
  if (!snapshot?.leases || typeof snapshot.leases !== 'object') return [];
  return Object.values(snapshot.leases).filter(lease => lease?.state !== 'revoked');
}

function canonicalText(value, limit, allowEmpty) {
  if (typeof value !== 'string' || /[\u0000-\u001F\u007F]/u.test(value)) return null;
  const normalized = Array.from(value.replace(/\s+/gu, ' ').trim()).slice(0, limit).join('');
  return (allowEmpty || normalized) && normalized === value ? normalized : null;
}

function validConsumer(value) {
  const parsed = ownRecord(value, CONSUMER_KEYS);
  return parsed && typeof parsed.extensionId === 'string' && parsed.extensionId.length >= 1 &&
    parsed.extensionId.length <= 128 && /^[A-Za-z0-9_-]+$/u.test(parsed.extensionId) &&
    canonicalText(parsed.documentId, 512, false) !== null &&
    typeof parsed.path === 'string' && parsed.path.length >= 1 && parsed.path.length <= 512 &&
    parsed.path.startsWith('/') && !parsed.path.includes('?') && !parsed.path.includes('#') &&
    !/[\u0000-\u001F\u007F]/u.test(parsed.path) &&
    Number.isSafeInteger(parsed.windowId) && parsed.windowId >= 0
    ? Object.freeze({
        extensionId: parsed.extensionId,
        documentId: parsed.documentId,
        path: parsed.path,
        windowId: parsed.windowId,
      })
    : null;
}

function parseReaderCommand(value) {
  const basic = ownRecord(value, ['version', 'op']);
  if (basic && basic.version === 1 && basic.op === 'state') {
    return Object.freeze({ version: 1, op: 'state' });
  }
  const action = ownRecord(value, ['version', 'op', 'action']);
  if (action && action.version === 1 && action.op === 'action' && READER_ACTIONS.has(action.action)) {
    return Object.freeze({ version: 1, op: 'action', action: action.action });
  }
  const voices = ownRecord(value, ['version', 'op', 'explicitUserGesture']);
  if (voices && voices.version === 1 && voices.op === 'voices' &&
    typeof voices.explicitUserGesture === 'boolean') {
    return Object.freeze({
      version: 1,
      op: 'voices',
      explicitUserGesture: voices.explicitUserGesture,
    });
  }
  const preferences = ownRecord(value, ['version', 'op', 'voiceId', 'rate']);
  const voiceId = preferences && canonicalText(preferences.voiceId, 200, false);
  if (preferences && preferences.version === 1 && preferences.op === 'preferences' &&
    voiceId !== null && typeof preferences.rate === 'number' && Number.isFinite(preferences.rate) &&
    preferences.rate >= 0.5 && preferences.rate <= 2) {
    return Object.freeze({
      version: 1,
      op: 'preferences',
      voiceId,
      rate: preferences.rate,
    });
  }
  return null;
}

function parseReaderRequest(value) {
  const request = ownRecord(value, ['leaseId', 'consumer', 'command']);
  if (!request || !LEASE_ID.test(request.leaseId ?? '')) return null;
  const consumer = validConsumer(request.consumer);
  const command = parseReaderCommand(request.command);
  return consumer && command
    ? Object.freeze({ leaseId: request.leaseId, consumer, command })
    : null;
}

function parseAutonomousStopRequest(value) {
  const request = ownRecord(value, ['leaseId', 'tabId', 'windowId', 'documentId', 'reason']);
  const documentId = request && canonicalText(request.documentId, 512, false);
  return request && LEASE_ID.test(request.leaseId ?? '') &&
    Number.isSafeInteger(request.tabId) && request.tabId > 0 &&
    Number.isSafeInteger(request.windowId) && request.windowId >= 0 &&
    documentId !== null && AUTONOMOUS_REASONS.has(request.reason)
    ? Object.freeze({
        leaseId: request.leaseId,
        tabId: request.tabId,
        windowId: request.windowId,
        documentId,
        reason: request.reason,
      })
    : null;
}

function projectReaderState(value) {
  const state = ownRecord(value, READER_STATE_KEYS);
  if (!state || state.version !== 1 || !['idle', 'playing', 'paused'].includes(state.playback) ||
    !Number.isSafeInteger(state.index) || !Number.isSafeInteger(state.total) ||
    state.total < 0 || state.total > 2000 || typeof state.canPrevious !== 'boolean' ||
    typeof state.canNext !== 'boolean' ||
    !['available', 'unavailable', 'busy', 'error'].includes(state.speechAvailability) ||
    typeof state.rate !== 'number' || !Number.isFinite(state.rate) ||
    state.rate < 0.5 || state.rate > 2) return null;
  const caption = canonicalText(state.caption, 2048, true);
  const voiceId = canonicalText(state.voiceId, 200, true);
  if (caption === null || voiceId === null) return null;
  if (state.playback === 'idle') {
    if (state.index !== -1 || state.total !== 0 || caption !== '' ||
      state.canPrevious || state.canNext) return null;
  } else if (state.total < 1 || state.index < 0 || state.index >= state.total || !caption ||
    state.canPrevious !== (state.index > 0) ||
    state.canNext !== (state.index < state.total - 1)) return null;
  return Object.freeze({
    version: 1,
    playback: state.playback,
    index: state.index,
    total: state.total,
    caption,
    canPrevious: state.canPrevious,
    canNext: state.canNext,
    speechAvailability: state.speechAvailability,
    voiceId,
    rate: state.rate,
  });
}

function projectReaderVoices(value) {
  if (!Array.isArray(value)) return null;
  let length;
  let keys;
  try {
    length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
    keys = Reflect.ownKeys(value);
  } catch { return null; }
  if (!Number.isSafeInteger(length) || length < 0 || length > 128 || keys.length !== length + 1) {
    return null;
  }
  const ids = new Set();
  const voices = [];
  for (let index = 0; index < length; index += 1) {
    let voice;
    try {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      voice = descriptor?.enumerable && Object.hasOwn(descriptor, 'value')
        ? ownRecord(descriptor.value, ['id', 'label', 'lang'])
        : null;
    } catch { return null; }
    const id = voice && canonicalText(voice.id, 200, false);
    const label = voice && canonicalText(voice.label, 200, false);
    const lang = voice && canonicalText(voice.lang, 64, true);
    if (!voice || id === null || label === null || lang === null || ids.has(id)) return null;
    ids.add(id);
    voices.push(Object.freeze({ id, label, lang }));
  }
  return Object.freeze(voices);
}

function parseReaderRuntimeResult(value, target, command) {
  const failed = ownRecord(value, ['ok', 'reason']);
  if (failed && failed.ok === false && [
    'document-missing', 'result-mismatch', 'runtime-error', 'reader-inactive',
    'gesture-required', 'voice-unavailable',
  ].includes(failed.reason)) return Object.freeze({ ok: false, reason: failed.reason });

  const actionResult = ownRecord(value, [
    'ok', 'documentId', 'frameId', 'kind', 'actionStatus', 'state',
  ]);
  if (actionResult && actionResult.ok === true && actionResult.documentId === target.documentId &&
    actionResult.frameId === 0 && actionResult.kind === 'state' && command.op === 'action' &&
    ['accepted', 'rejected', 'terminal'].includes(actionResult.actionStatus)) {
    const state = projectReaderState(actionResult.state);
    return state ? Object.freeze({
      ok: true,
      kind: 'state',
      actionStatus: actionResult.actionStatus,
      state,
    }) : null;
  }

  const stateResult = ownRecord(value, ['ok', 'documentId', 'frameId', 'kind', 'state']);
  if (stateResult && stateResult.ok === true && stateResult.documentId === target.documentId &&
    stateResult.frameId === 0 && stateResult.kind === 'state' &&
    ['state', 'preferences'].includes(command.op)) {
    const state = projectReaderState(stateResult.state);
    if (!state || (command.op === 'preferences' &&
      (state.voiceId !== command.voiceId || state.rate !== command.rate))) return null;
    return Object.freeze({ ok: true, kind: 'state', state });
  }

  const voicesResult = ownRecord(value, [
    'ok', 'documentId', 'frameId', 'kind', 'status', 'voices',
  ]);
  if (voicesResult && voicesResult.ok === true && voicesResult.documentId === target.documentId &&
    voicesResult.frameId === 0 && voicesResult.kind === 'voices' && command.op === 'voices' &&
    ['available', 'unavailable'].includes(voicesResult.status)) {
    const voices = projectReaderVoices(voicesResult.voices);
    if (!voices || (voicesResult.status === 'unavailable' && voices.length !== 0)) return null;
    return Object.freeze({
      ok: true,
      kind: 'voices',
      status: voicesResult.status,
      voices,
    });
  }
  return null;
}

export function createPersonaCoordinator({
  leaseStore,
  targetQueue,
  personaRuntime,
  probeDocument,
  scheduleExpiry,
} = {}) {
  const storeMethods = [
    'claimPrepared', 'activate', 'beginSetMode', 'commitSetMode', 'renewExplicitAction', 'rollbackSetMode',
    'beginStop', 'completeStop', 'rehydrate', 'revoke', 'findOwner', 'snapshot',
    'listRecoverable', 'listExpired', 'prepareInvalidRegistryRecovery',
    'finalizeInvalidRegistryRecovery',
  ];
  if (!leaseStore || storeMethods.some(name => typeof leaseStore[name] !== 'function') ||
    !targetQueue || typeof targetQueue.withTarget !== 'function' || typeof targetQueue.assertHeld !== 'function' ||
    !personaRuntime || typeof personaRuntime.apply !== 'function' || typeof personaRuntime.reader !== 'function' ||
    typeof probeDocument !== 'function' || typeof scheduleExpiry !== 'function') {
    throw new TypeError('PERSONA_COORDINATOR_INVALID');
  }

  let scheduleTail = Promise.resolve();

  function rescheduleExpiry() {
    const operation = scheduleTail.then(async () => {
      const leases = activeLeases(await leaseStore.snapshot());
      const deadlines = leases.map(lease => lease.expiresAt)
        .filter(value => Number.isSafeInteger(value) && value >= 0);
      await scheduleExpiry(deadlines.length ? Math.min(...deadlines) : null);
    });
    scheduleTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async function quiesceUnscheduledLeases(held = null) {
    let candidates;
    try {
      candidates = activeLeases(await leaseStore.snapshot());
      if (held) candidates = candidates.filter(candidate => sameTarget(candidate.target, held.target));
    } catch {
      return false;
    }
    let confirmed = true;
    for (const candidate of candidates) {
      try {
        const outcome = held && sameTarget(candidate.target, held.target)
          ? await revokeTargetCore({ target: candidate.target, reason: 'runtime-failure', lock: held.lock })
          : await targetQueue.withTarget(candidate.target, lock =>
              revokeTargetCore({ target: candidate.target, reason: 'runtime-failure', lock }));
        if (!outcome.ok) confirmed = false;
      } catch {
        confirmed = false;
      }
    }
    return confirmed;
  }

  async function finish(operation, held = null) {
    let result;
    try {
      result = await operation();
    } catch (error) {
      let message = '';
      try { message = typeof error?.message === 'string' ? error.message : ''; } catch { /* closed below */ }
      if (message === 'PERSONA_INPUT_INVALID' || /lock inválido/iu.test(message)) throw error;
      result = failure('PERSONA_STATE_FAILED');
    }
    try {
      await rescheduleExpiry();
      return result;
    } catch {
      await quiesceUnscheduledLeases(held);
      try {
        await rescheduleExpiry();
      } catch { /* sem alarme confirmado, a resposta permanece fechada */ }
      return result?.ok === false ? result : failure('PERSONA_EXPIRY_SCHEDULE_FAILED');
    }
  }

  async function liveTargetMatches(target) {
    try {
      return sameTarget(await probeDocument(target.tabId), target);
    } catch {
      return false;
    }
  }

  function confirmedRuntimeSuccess(result, target, expectedMode) {
    return result?.ok === true && result.documentId === target.documentId && result.frameId === 0 &&
      result.mode === expectedMode;
  }

  async function clearTarget(target) {
    let result;
    try {
      result = await personaRuntime.apply({ target, op: 'clear' });
    } catch {
      return { confirmed: false, missing: false };
    }
    if (confirmedRuntimeSuccess(result, target, null)) return { confirmed: true, missing: false };
    if (result?.ok === false && result.reason === 'document-missing') {
      return { confirmed: true, missing: true };
    }
    return { confirmed: false, missing: false };
  }

  async function currentOwner(target, leaseId = null) {
    const owner = await leaseStore.findOwner(target);
    return owner && (leaseId === null || owner.leaseId === leaseId) ? owner : null;
  }

  async function attemptTarget(target, operation) {
    try {
      return await targetQueue.withTarget(target, operation);
    } catch {
      return failure('PERSONA_STATE_FAILED');
    }
  }

  async function leaseById(leaseId) {
    if (!LEASE_ID.test(leaseId ?? '')) return null;
    const snapshot = await leaseStore.snapshot();
    const lease = snapshot.leases?.[leaseId];
    return lease?.state === 'revoked' ? null : lease ?? null;
  }

  async function expiredLeaseIds() {
    return new Set((await leaseStore.listExpired()).map(lease => lease.leaseId));
  }

  async function clearAndAttemptTerminalRevoke({ target, owner, reason }) {
    const cleared = await clearTarget(target);
    if (!cleared.confirmed) return failure('PERSONA_CLEANUP_UNCONFIRMED');
    let current = owner;
    if (!current) {
      try { current = await currentOwner(target); }
      catch { return failure('PERSONA_STATE_FAILED'); }
    }
    if (!current) return failure('PERSONA_STATE_FAILED');
    try {
      await leaseStore.revoke({ leaseId: current.leaseId, reason });
    } catch {
      return failure('PERSONA_STATE_FAILED');
    }
    return failure('PERSONA_STATE_FAILED');
  }

  async function revokeTargetCore({ target, reason, lock }) {
    targetQueue.assertHeld(lock, target);
    let owner;
    try { owner = await currentOwner(target); }
    catch { return clearAndAttemptTerminalRevoke({ target, owner: null, reason }); }
    if (!owner) {
      const cleared = await clearTarget(target);
      return cleared.confirmed
        ? Object.freeze({ ok: true, state: 'absent' })
        : failure('PERSONA_CLEANUP_UNCONFIRMED');
    }
    let stopping;
    try {
      stopping = await leaseStore.beginStop({
        leaseId: owner.leaseId,
        consumer: null,
        explicit: false,
      });
    } catch {
      return clearAndAttemptTerminalRevoke({ target, owner, reason });
    }
    if (!stopping.ok) return clearAndAttemptTerminalRevoke({ target, owner, reason });
    const cleared = await clearTarget(target);
    if (!cleared.confirmed) return failure('PERSONA_CLEANUP_UNCONFIRMED');
    const revoked = await leaseStore.revoke({ leaseId: owner.leaseId, reason });
    if (!revoked.ok) return storeFailure(revoked);
    return Object.freeze({ ok: true, state: 'revoked' });
  }

  async function revokeAfterLiveFailure({ target, reason, lock }) {
    try {
      return await revokeTargetCore({ target, reason, lock });
    } catch {
      return clearAndAttemptTerminalRevoke({ target, owner: null, reason });
    }
  }

  async function compensateReaderFailure({ target, reason, code, lock }) {
    const revoked = await revokeAfterLiveFailure({ target, reason, lock });
    if (revoked.ok) return failure(code);
    return revoked.code === 'PERSONA_CLEANUP_UNCONFIRMED'
      ? failure('PERSONA_CLEANUP_UNCONFIRMED')
      : failure('PERSONA_STATE_FAILED');
  }

  async function expireRejectedLiveLease({ rejected, target, lock }) {
    if (rejected?.code !== 'PERSONA_EXPIRED') return storeFailure(rejected);
    const revoked = await revokeAfterLiveFailure({ target, reason: 'expired', lock });
    if (revoked.ok) return storeFailure(rejected);
    return revoked.code === 'PERSONA_CLEANUP_UNCONFIRMED'
      ? failure('PERSONA_CLEANUP_UNCONFIRMED')
      : failure('PERSONA_STATE_FAILED');
  }

  async function claimLockedCore({ target, consumer, mode, lock }) {
    targetQueue.assertHeld(lock, target);
    if (!MODES.has(mode)) throw new TypeError('PERSONA_INPUT_INVALID');
    if (!await liveTargetMatches(target)) return failure('PERSONA_TARGET_CHANGED');
    const priorOwner = await currentOwner(target);
    if (priorOwner) {
      let inspected;
      try { inspected = await personaRuntime.apply({ target, op: 'inspect' }); }
      catch { inspected = null; }
      if (confirmedRuntimeSuccess(inspected, target, null)) {
        const revoked = await revokeTargetCore({ target, reason: 'runtime-failure', lock });
        if (!revoked.ok) return revoked.code === 'PERSONA_CLEANUP_UNCONFIRMED'
          ? revoked
          : failure('PERSONA_STATE_FAILED');
      }
    }
    const prepared = await leaseStore.claimPrepared({ target, consumer, mode });
    if (!prepared.ok) return storeFailure(prepared);
    let installed;
    try {
      installed = await personaRuntime.apply({
        target, op: 'install', mode, leaseId: prepared.lease.leaseId,
      });
    } catch {
      installed = null;
    }
    if (confirmedRuntimeSuccess(installed, target, mode)) {
      if (!await liveTargetMatches(target)) {
        const revoked = await revokeAfterLiveFailure({ target, reason: 'navigation', lock });
        return revoked.ok ? failure('PERSONA_TARGET_CHANGED') : failure('PERSONA_CLEANUP_UNCONFIRMED');
      }
      let activated;
      try {
        activated = await leaseStore.activate({
          leaseId: prepared.lease.leaseId,
          expectedRevision: prepared.lease.revision,
        });
      } catch {
        activated = null;
      }
      if (activated?.ok) return successLease(activated.lease);
      const revoked = await revokeAfterLiveFailure({ target, reason: 'runtime-failure', lock });
      return revoked.code === 'PERSONA_STATE_FAILED'
        ? failure('PERSONA_STATE_FAILED')
        : revoked.ok
          ? failure('PERSONA_STATE_FAILED')
          : failure('PERSONA_CLEANUP_UNCONFIRMED');
    }
    const revoked = await revokeAfterLiveFailure({ target, reason: 'runtime-failure', lock });
    if (revoked.code === 'PERSONA_STATE_FAILED') return failure('PERSONA_STATE_FAILED');
    return revoked.ok
      ? failure('PERSONA_RUNTIME_FAILED')
      : failure('PERSONA_CLEANUP_UNCONFIRMED');
  }

  function claimLocked(args) {
    return finish(() => claimLockedCore(args), args);
  }

  async function setModeCore({ leaseId, consumer, mode }) {
    if (!MODES.has(mode)) throw new TypeError('PERSONA_INPUT_INVALID');
    const initial = await leaseById(leaseId);
    if (!initial) return failure('PERSONA_NOT_FOUND');
    if (!sameConsumer(initial.consumer, consumer)) return failure('PERSONA_CONSUMER_MISMATCH');
    const target = initial.target;
    return targetQueue.withTarget(target, async lock => {
      targetQueue.assertHeld(lock, target);
      const owner = await currentOwner(target, leaseId);
      if (!owner) return failure('PERSONA_NOT_FOUND');
      if (!sameConsumer(owner.consumer, consumer)) return failure('PERSONA_CONSUMER_MISMATCH');
      if (!await liveTargetMatches(target)) {
        const revoked = await revokeTargetCore({ target, reason: 'runtime-failure', lock });
        return revoked.ok ? failure('PERSONA_TARGET_CHANGED') : failure('PERSONA_CLEANUP_UNCONFIRMED');
      }
      const priorMode = owner.activeMode;
      let begun;
      try {
        begun = await leaseStore.beginSetMode({ leaseId, consumer, mode });
      } catch {
        const revoked = await revokeAfterLiveFailure({ target, reason: 'runtime-failure', lock });
        return revoked.ok || revoked.code === 'PERSONA_STATE_FAILED'
          ? failure('PERSONA_STATE_FAILED')
          : failure('PERSONA_CLEANUP_UNCONFIRMED');
      }
      if (!begun.ok) return expireRejectedLiveLease({ rejected: begun, target, lock });
      let installed;
      try { installed = await personaRuntime.apply({ target, op: 'install', mode, leaseId }); }
      catch { installed = null; }
      let stateFailure = false;
      if (confirmedRuntimeSuccess(installed, target, mode)) {
        if (!await liveTargetMatches(target)) {
          const revoked = await revokeAfterLiveFailure({ target, reason: 'navigation', lock });
          return revoked.ok ? failure('PERSONA_TARGET_CHANGED') : failure('PERSONA_CLEANUP_UNCONFIRMED');
        }
        let committed;
        try {
          committed = await leaseStore.commitSetMode({
            leaseId,
            expectedRevision: begun.lease.revision,
          });
        } catch {
          committed = null;
        }
        if (committed?.ok) return successLease(committed.lease);
        stateFailure = true;
      }

      let restored;
      try {
        restored = priorMode === null
          ? await personaRuntime.apply({ target, op: 'clear' })
          : await personaRuntime.apply({ target, op: 'install', mode: priorMode, leaseId });
      } catch {
        restored = null;
      }
      if (confirmedRuntimeSuccess(restored, target, priorMode)) {
        let rolledBack;
        try {
          rolledBack = await leaseStore.rollbackSetMode({
            leaseId,
            expectedRevision: begun.lease.revision,
          });
        } catch {
          rolledBack = null;
        }
        if (rolledBack?.ok) return failure(stateFailure ? 'PERSONA_STATE_FAILED' : 'PERSONA_RUNTIME_FAILED');
      }

      const revoked = await revokeAfterLiveFailure({ target, reason: 'runtime-failure', lock });
      if (revoked.code === 'PERSONA_STATE_FAILED') return failure('PERSONA_STATE_FAILED');
      return revoked.ok
        ? failure(stateFailure ? 'PERSONA_STATE_FAILED' : 'PERSONA_REVOKED_AFTER_RUNTIME_FAILURE')
        : failure('PERSONA_CLEANUP_UNCONFIRMED');
    });
  }

  function setMode(args) {
    return finish(() => setModeCore(args));
  }

  async function readerCommandCore({ leaseId, consumer, command }) {
    const initial = await leaseById(leaseId);
    if (!initial) return failure('PERSONA_NOT_FOUND');
    if (!sameConsumer(initial.consumer, consumer)) return failure('PERSONA_CONSUMER_MISMATCH');
    const target = initial.target;
    return targetQueue.withTarget(target, async lock => {
      targetQueue.assertHeld(lock, target);
      let owner;
      try { owner = await currentOwner(target, leaseId); }
      catch {
        return compensateReaderFailure({
          target, reason: 'runtime-failure', code: 'PERSONA_STATE_FAILED', lock,
        });
      }
      if (!owner) return failure('PERSONA_NOT_FOUND');
      if (!sameConsumer(owner.consumer, consumer)) return failure('PERSONA_CONSUMER_MISMATCH');
      if (owner.state !== 'active' || owner.pendingMode !== null) {
        return compensateReaderFailure({
          target, reason: 'runtime-failure', code: 'PERSONA_STATE_FAILED', lock,
        });
      }
      if (owner.activeMode !== 'reader') return failure('PERSONA_READER_INACTIVE');

      let expired;
      try { expired = (await expiredLeaseIds()).has(leaseId); }
      catch {
        return compensateReaderFailure({
          target, reason: 'runtime-failure', code: 'PERSONA_STATE_FAILED', lock,
        });
      }
      if (expired) {
        return compensateReaderFailure({
          target, reason: 'expired', code: 'PERSONA_EXPIRED', lock,
        });
      }
      if (!await liveTargetMatches(target)) {
        return compensateReaderFailure({
          target, reason: 'navigation', code: 'PERSONA_TARGET_CHANGED', lock,
        });
      }
      if (command.op === 'voices' && command.explicitUserGesture !== true) {
        return failure('PERSONA_READER_GESTURE_REQUIRED');
      }

      let rawResult;
      try { rawResult = await personaRuntime.reader({ target, command }); }
      catch { rawResult = null; }

      if (command.op === 'state') {
        try { expired = (await expiredLeaseIds()).has(leaseId); }
        catch {
          return compensateReaderFailure({
            target, reason: 'runtime-failure', code: 'PERSONA_STATE_FAILED', lock,
          });
        }
        if (expired) {
          return compensateReaderFailure({
            target, reason: 'expired', code: 'PERSONA_EXPIRED', lock,
          });
        }
      }
      if (!await liveTargetMatches(target)) {
        return compensateReaderFailure({
          target, reason: 'navigation', code: 'PERSONA_TARGET_CHANGED', lock,
        });
      }

      let current;
      try { current = await currentOwner(target, leaseId); }
      catch {
        return compensateReaderFailure({
          target, reason: 'runtime-failure', code: 'PERSONA_STATE_FAILED', lock,
        });
      }
      if (!current || !sameConsumer(current.consumer, consumer) || current.state !== 'active' ||
        current.activeMode !== 'reader' || current.pendingMode !== null || current.revision !== owner.revision) {
        return compensateReaderFailure({
          target, reason: 'runtime-failure', code: 'PERSONA_STATE_FAILED', lock,
        });
      }

      const result = parseReaderRuntimeResult(rawResult, target, command);
      if (result?.ok && result.kind === 'state' && command.op === 'action') {
        if (result.actionStatus === 'rejected') {
          return failure('PERSONA_READER_ACTION_REJECTED');
        }
        if (result.actionStatus === 'terminal') {
          return compensateReaderFailure({
            target,
            reason: 'runtime-failure',
            code: 'PERSONA_READER_ACTION_TERMINAL',
            lock,
          });
        }
      }
      let publicResult = null;
      if (result?.ok) {
        publicResult = result.kind === 'state'
          ? Object.freeze({ ok: true, kind: 'state', state: result.state })
          : Object.freeze({
              ok: true,
              kind: 'voices',
              status: result.status,
              voices: result.voices,
            });
      } else if (result?.reason === 'gesture-required') {
        publicResult = failure('PERSONA_READER_GESTURE_REQUIRED');
      } else if (result?.reason === 'voice-unavailable') {
        publicResult = failure('PERSONA_READER_VOICE_UNAVAILABLE');
      }
      if (publicResult?.ok === false) return publicResult;
      if (publicResult && command.op === 'state') return publicResult;
      if (publicResult) {
        let renewed;
        try {
          renewed = await leaseStore.renewExplicitAction({
            leaseId,
            consumer,
            expectedRevision: owner.revision,
          });
        } catch { renewed = null; }
        if (!renewed?.ok || !renewed.lease || renewed.lease.leaseId !== leaseId ||
          renewed.lease.state !== 'active' || renewed.lease.activeMode !== 'reader' ||
          renewed.lease.pendingMode !== null || renewed.lease.revision !== owner.revision + 1 ||
          !sameTarget(renewed.lease.target, target) || !sameConsumer(renewed.lease.consumer, consumer)) {
          return compensateReaderFailure({
            target, reason: 'runtime-failure', code: 'PERSONA_STATE_FAILED', lock,
          });
        }
        if (!await liveTargetMatches(target)) {
          return compensateReaderFailure({
            target, reason: 'navigation', code: 'PERSONA_TARGET_CHANGED', lock,
          });
        }
        let renewedOwner;
        try { renewedOwner = await currentOwner(target, leaseId); }
        catch { renewedOwner = null; }
        if (!renewedOwner || renewedOwner.revision !== renewed.lease.revision ||
          renewedOwner.state !== 'active' || renewedOwner.activeMode !== 'reader' ||
          renewedOwner.pendingMode !== null || !sameConsumer(renewedOwner.consumer, consumer)) {
          return compensateReaderFailure({
            target, reason: 'runtime-failure', code: 'PERSONA_STATE_FAILED', lock,
          });
        }
        return publicResult;
      }
      if (result?.reason === 'reader-inactive') {
        return compensateReaderFailure({
          target, reason: 'runtime-failure', code: 'PERSONA_READER_INACTIVE', lock,
        });
      }
      if (result?.reason === 'document-missing') {
        return compensateReaderFailure({
          target, reason: 'navigation', code: 'PERSONA_TARGET_CHANGED', lock,
        });
      }
      return compensateReaderFailure({
        target, reason: 'runtime-failure', code: 'PERSONA_READER_RUNTIME_FAILED', lock,
      });
    });
  }

  function readerCommand(value) {
    return finish(() => {
      const input = parseReaderRequest(value);
      if (!input) throw new TypeError('PERSONA_INPUT_INVALID');
      return readerCommandCore(input);
    });
  }

  async function stopCore({ leaseId, consumer, explicit }) {
    if (explicit !== true) throw new TypeError('PERSONA_INPUT_INVALID');
    const initial = await leaseById(leaseId);
    if (!initial) return failure('PERSONA_NOT_FOUND');
    if (!sameConsumer(initial.consumer, consumer)) return failure('PERSONA_CONSUMER_MISMATCH');
    const target = initial.target;
    return targetQueue.withTarget(target, async lock => {
      const owner = await currentOwner(target, leaseId);
      if (!owner) return failure('PERSONA_NOT_FOUND');
      if (!sameConsumer(owner.consumer, consumer)) return failure('PERSONA_CONSUMER_MISMATCH');
      if (!await liveTargetMatches(target)) {
        const revoked = await revokeTargetCore({ target, reason: 'navigation', lock });
        return revoked.ok ? failure('PERSONA_TARGET_CHANGED') : failure('PERSONA_CLEANUP_UNCONFIRMED');
      }
      let stopping;
      if (owner.state === 'stopping' && owner.pendingMode === null) {
        stopping = { ok: true, lease: owner };
      } else {
        try {
          stopping = await leaseStore.beginStop({ leaseId, consumer, explicit: true });
        } catch {
          const revoked = await revokeAfterLiveFailure({ target, reason: 'runtime-failure', lock });
          return revoked.ok || revoked.code === 'PERSONA_STATE_FAILED'
            ? failure('PERSONA_STATE_FAILED')
            : failure('PERSONA_CLEANUP_UNCONFIRMED');
        }
      }
      if (!stopping.ok) return expireRejectedLiveLease({ rejected: stopping, target, lock });
      let cleared = await clearTarget(target);
      if (!cleared.confirmed) cleared = await clearTarget(target);
      if (!cleared.confirmed) return failure('PERSONA_CLEANUP_UNCONFIRMED');
      if (cleared.missing) {
        const revoked = await leaseStore.revoke({ leaseId, reason: 'navigation' });
        return revoked.ok ? failure('PERSONA_TARGET_CHANGED') : storeFailure(revoked);
      }
      if (!await liveTargetMatches(target)) {
        const revoked = await leaseStore.revoke({ leaseId, reason: 'navigation' });
        return revoked.ok ? failure('PERSONA_TARGET_CHANGED') : storeFailure(revoked);
      }
      const completed = await leaseStore.completeStop({
        leaseId,
        expectedRevision: stopping.lease.revision,
        explicit: true,
      });
      return completed.ok ? successLease(completed.lease) : storeFailure(completed);
    });
  }

  function stop(args) {
    return finish(() => stopCore(args));
  }

  async function autonomousStopCore({ leaseId, tabId, windowId, documentId, reason }) {
    const initial = await leaseById(leaseId);
    if (!initial || initial.target.tabId !== tabId || initial.target.windowId !== windowId ||
      initial.target.documentId !== documentId) return failure('PERSONA_NOT_FOUND');
    const target = initial.target;
    return targetQueue.withTarget(target, async lock => {
      targetQueue.assertHeld(lock, target);
      const owner = await currentOwner(target, leaseId);
      if (!owner || owner.target.tabId !== tabId || owner.target.windowId !== windowId ||
        owner.target.documentId !== documentId) return failure('PERSONA_NOT_FOUND');
      return revokeTargetCore({
        target,
        reason: reason === 'lifecycle-stop' ? 'navigation' : 'runtime-failure',
        lock,
      });
    });
  }

  function autonomousStop(value) {
    const input = parseAutonomousStopRequest(value);
    if (!input) throw new TypeError('PERSONA_INPUT_INVALID');
    return finish(() => autonomousStopCore(input));
  }

  async function rehydrateLockedCore({ target, consumer, lock }) {
    targetQueue.assertHeld(lock, target);
    const owner = await currentOwner(target);
    if (!owner) return failure('PERSONA_NOT_FOUND');
    if ((await expiredLeaseIds()).has(owner.leaseId)) {
      const revoked = await revokeTargetCore({ target, reason: 'expired', lock });
      return revoked.ok ? failure('PERSONA_EXPIRED') : failure('PERSONA_CLEANUP_UNCONFIRMED');
    }
    if (!await liveTargetMatches(target)) {
      const revoked = await revokeTargetCore({ target, reason: 'recovery', lock });
      return revoked.ok ? failure('PERSONA_TARGET_CHANGED') : failure('PERSONA_CLEANUP_UNCONFIRMED');
    }
    let inspected;
    try { inspected = await personaRuntime.apply({ target, op: 'inspect' }); }
    catch { inspected = null; }
    if ((await expiredLeaseIds()).has(owner.leaseId)) {
      const revoked = await revokeTargetCore({ target, reason: 'expired', lock });
      return revoked.ok ? failure('PERSONA_EXPIRED') : failure('PERSONA_CLEANUP_UNCONFIRMED');
    }
    if (!await liveTargetMatches(target)) {
      const revoked = await revokeTargetCore({ target, reason: 'navigation', lock });
      return revoked.ok ? failure('PERSONA_TARGET_CHANGED') : failure('PERSONA_CLEANUP_UNCONFIRMED');
    }
    if (!confirmedRuntimeSuccess(inspected, target, owner.activeMode) || owner.pendingMode !== null) {
      const revoked = await revokeTargetCore({ target, reason: 'runtime-failure', lock });
      return revoked.ok ? failure('PERSONA_RUNTIME_MISMATCH') : failure('PERSONA_CLEANUP_UNCONFIRMED');
    }
    let rehydrated;
    try {
      rehydrated = await leaseStore.rehydrate({ target, consumer });
    } catch {
      const revoked = await revokeAfterLiveFailure({ target, reason: 'runtime-failure', lock });
      return revoked.ok || revoked.code === 'PERSONA_STATE_FAILED'
        ? failure('PERSONA_STATE_FAILED')
        : failure('PERSONA_CLEANUP_UNCONFIRMED');
    }
    return rehydrated.ok
      ? successLease(rehydrated.lease)
      : expireRejectedLiveLease({ rejected: rehydrated, target, lock });
  }

  function rehydrateLocked(args) {
    return finish(() => rehydrateLockedCore(args), args);
  }

  function revokeTargetLocked(args) {
    return finish(() => revokeTargetCore(args), args);
  }

  async function recoverCore() {
    let snapshot;
    try {
      snapshot = await leaseStore.snapshot();
    } catch (error) {
      let message = '';
      try { message = typeof error?.message === 'string' ? error.message : ''; } catch { /* fechado */ }
      if (message !== 'PERSONA_REGISTRY_INVALID') return failure('PERSONA_STATE_FAILED');
      const prepared = await leaseStore.prepareInvalidRegistryRecovery();
      if (!prepared.ok) return storeFailure(prepared);
      let failureCode = null;
      for (const target of prepared.targets) {
        const outcome = await attemptTarget(target, async lock => {
          targetQueue.assertHeld(lock, target);
          const cleared = await clearTarget(target);
          return cleared.confirmed
            ? Object.freeze({ ok: true, state: 'clear' })
            : failure('PERSONA_CLEANUP_UNCONFIRMED');
        });
        if (!outcome.ok && failureCode === null) failureCode = outcome.code;
      }
      if (failureCode !== null) return failure(failureCode);
      if (!prepared.resetAllowed) return failure('PERSONA_STATE_FAILED');
      const reset = await leaseStore.finalizeInvalidRegistryRecovery(prepared.token);
      return reset.ok
        ? Object.freeze({
            ok: true,
            processed: reset.processed,
            revoked: reset.processed,
            retained: 0,
          })
        : storeFailure(reset);
    }
    const initiallyExpired = await expiredLeaseIds();
    let processed = 0;
    let revokedCount = 0;
    let retained = 0;
    let failureCode = null;
    for (const candidate of activeLeases(snapshot)) {
      const outcome = await attemptTarget(candidate.target, async lock => {
        const owner = await currentOwner(candidate.target, candidate.leaseId);
        if (!owner) return Object.freeze({ ok: true, state: 'absent' });
        if (initiallyExpired.has(owner.leaseId)) {
          return revokeTargetCore({ target: owner.target, reason: 'expired', lock });
        }
        if (owner.state === 'prepared' || owner.state === 'stopping' || owner.pendingMode !== null) {
          return revokeTargetCore({ target: owner.target, reason: 'recovery', lock });
        }
        if (!await liveTargetMatches(owner.target)) {
          return revokeTargetCore({ target: owner.target, reason: 'recovery', lock });
        }
        let inspected;
        try { inspected = await personaRuntime.apply({ target: owner.target, op: 'inspect' }); }
        catch { inspected = null; }
        if ((await expiredLeaseIds()).has(owner.leaseId)) {
          return revokeTargetCore({ target: owner.target, reason: 'expired', lock });
        }
        if (!await liveTargetMatches(owner.target)) {
          return revokeTargetCore({ target: owner.target, reason: 'navigation', lock });
        }
        if (!confirmedRuntimeSuccess(inspected, owner.target, owner.activeMode)) {
          return revokeTargetCore({ target: owner.target, reason: 'runtime-failure', lock });
        }
        return Object.freeze({ ok: true, state: 'retained' });
      });
      processed += 1;
      if (outcome.ok && outcome.state === 'revoked') revokedCount += 1;
      else if (outcome.ok && outcome.state === 'retained') retained += 1;
      else if (!outcome.ok && failureCode === null) failureCode = outcome.code;
    }
    return failureCode
      ? Object.freeze({ ok: false, code: failureCode, processed, revoked: revokedCount, retained })
      : Object.freeze({ ok: true, processed, revoked: revokedCount, retained });
  }

  function recover() {
    return finish(recoverCore);
  }

  async function expireDueCore() {
    const due = await leaseStore.listExpired();
    let revokedCount = 0;
    let failureCode = null;
    for (const candidate of due) {
      const outcome = await attemptTarget(candidate.target, async lock => {
        const currentDue = await leaseStore.listExpired();
        if (!currentDue.some(lease => lease.leaseId === candidate.leaseId)) {
          return Object.freeze({ ok: true, state: 'not-due' });
        }
        const owner = await currentOwner(candidate.target, candidate.leaseId);
        return owner
          ? revokeTargetCore({ target: owner.target, reason: 'expired', lock })
          : Object.freeze({ ok: true, state: 'absent' });
      });
      if (outcome.ok && outcome.state === 'revoked') revokedCount += 1;
      else if (!outcome.ok && failureCode === null) failureCode = outcome.code;
    }
    return failureCode
      ? Object.freeze({ ok: false, code: failureCode, processed: due.length, revoked: revokedCount })
      : Object.freeze({ ok: true, processed: due.length, revoked: revokedCount });
  }

  function expireDue() {
    return finish(expireDueCore);
  }

  async function invalidateMatching(predicate, reason) {
    const candidates = activeLeases(await leaseStore.snapshot()).filter(predicate);
    let revokedCount = 0;
    let failureCode = null;
    for (const candidate of candidates) {
      const outcome = await attemptTarget(candidate.target, lock =>
        revokeTargetCore({ target: candidate.target, reason, lock }));
      if (outcome.ok && outcome.state === 'revoked') revokedCount += 1;
      else if (!outcome.ok && failureCode === null) failureCode = outcome.code;
    }
    return failureCode
      ? Object.freeze({ ok: false, code: failureCode, processed: candidates.length, revoked: revokedCount })
      : Object.freeze({ ok: true, processed: candidates.length, revoked: revokedCount });
  }

  function invalidateTab(tabId, reason) {
    if (!Number.isSafeInteger(tabId) || tabId <= 0) throw new TypeError('PERSONA_INPUT_INVALID');
    return finish(() => invalidateMatching(lease => lease.target.tabId === tabId, reason));
  }

  function invalidateWindow(windowId, reason) {
    if (!Number.isSafeInteger(windowId) || windowId < 0) throw new TypeError('PERSONA_INPUT_INVALID');
    return finish(() => invalidateMatching(lease => lease.target.windowId === windowId, reason));
  }

  return Object.freeze({
    claimLocked,
    setMode,
    readerCommand,
    stop,
    autonomousStop,
    rehydrateLocked,
    revokeTargetLocked,
    recover,
    expireDue,
    invalidateTab,
    invalidateWindow,
  });
}
