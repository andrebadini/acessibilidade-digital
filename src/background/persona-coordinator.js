const TARGET_KEYS = ['tabId', 'windowId', 'documentId', 'urlSessionDigest'];
const CONSUMER_KEYS = ['extensionId', 'documentId', 'path', 'windowId'];
const MODES = new Set(['reader', 'achromatopsia', 'motor']);
const LEASE_ID = /^lease-[A-Za-z0-9_-]{22}$/u;

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

export function createPersonaCoordinator({
  leaseStore,
  targetQueue,
  personaRuntime,
  probeDocument,
  scheduleExpiry,
} = {}) {
  const storeMethods = [
    'claimPrepared', 'activate', 'beginSetMode', 'commitSetMode', 'rollbackSetMode',
    'beginStop', 'completeStop', 'rehydrate', 'revoke', 'findOwner', 'snapshot',
    'listRecoverable', 'listExpired', 'prepareInvalidRegistryRecovery',
    'finalizeInvalidRegistryRecovery',
  ];
  if (!leaseStore || storeMethods.some(name => typeof leaseStore[name] !== 'function') ||
    !targetQueue || typeof targetQueue.withTarget !== 'function' || typeof targetQueue.assertHeld !== 'function' ||
    !personaRuntime || typeof personaRuntime.apply !== 'function' ||
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
    const prepared = await leaseStore.claimPrepared({ target, consumer, mode });
    if (!prepared.ok) return storeFailure(prepared);
    let installed;
    try {
      installed = await personaRuntime.apply({ target, op: 'install', mode });
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
      try { installed = await personaRuntime.apply({ target, op: 'install', mode }); }
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
          : await personaRuntime.apply({ target, op: 'install', mode: priorMode });
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
      try {
        stopping = await leaseStore.beginStop({ leaseId, consumer, explicit: true });
      } catch {
        const revoked = await revokeAfterLiveFailure({ target, reason: 'runtime-failure', lock });
        return revoked.ok || revoked.code === 'PERSONA_STATE_FAILED'
          ? failure('PERSONA_STATE_FAILED')
          : failure('PERSONA_CLEANUP_UNCONFIRMED');
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
    stop,
    rehydrateLocked,
    revokeTargetLocked,
    recover,
    expireDue,
    invalidateTab,
    invalidateWindow,
  });
}
