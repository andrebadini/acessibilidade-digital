import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import test from 'node:test';

import { createPersonaLeaseStore } from '../../src/background/persona-lease-store.js';
import { createTargetOperationQueue } from '../../src/background/target-operation-queue.js';
import { createFakeLockManager } from './fake-lock-manager.js';

let coordinatorModule = {};
try { coordinatorModule = await import('../../src/background/persona-coordinator.js'); } catch { /* RED */ }

const DIGEST_A = `hmac-sha256:${'A'.repeat(43)}`;
const DIGEST_B = `hmac-sha256:${'B'.repeat(43)}`;
const REGISTRY_KEY = 'audita:persona-leases:v1';
const target = Object.freeze({
  tabId: 7, windowId: 3, documentId: 'document-main', urlSessionDigest: DIGEST_A,
});
const secondTarget = Object.freeze({
  tabId: 8, windowId: 4, documentId: 'document-second', urlSessionDigest: DIGEST_B,
});
const sameWindowTarget = Object.freeze({
  tabId: 9, windowId: 3, documentId: 'document-same-window', urlSessionDigest: DIGEST_B,
});
const consumer = Object.freeze({
  extensionId: 'test-extension',
  documentId: 'side-panel-window:3',
  path: '/src/panel/index.html',
  windowId: 3,
});
const reopenedConsumer = Object.freeze({
  ...consumer,
  documentId: 'side-panel-window:3-reopened',
});

function readerState(overrides = {}) {
  return Object.freeze({
    version: 1,
    playback: 'playing',
    index: 0,
    total: 2,
    caption: 'Início, título nível 1',
    canPrevious: false,
    canNext: true,
    speechAvailability: 'available',
    voiceId: 'local-a',
    rate: 1,
    ...overrides,
  });
}

function consumerFor(targetValue, suffix = '') {
  return Object.freeze({
    extensionId: 'test-extension',
    documentId: `side-panel-window:${targetValue.windowId}${suffix}`,
    path: '/src/panel/index.html',
    windowId: targetValue.windowId,
  });
}

function sessionAreaFixture() {
  const data = Object.create(null);
  return {
    data,
    async get(key) {
      if (!Object.hasOwn(data, key)) return {};
      return { [key]: structuredClone(data[key]) };
    },
    async set(values) {
      for (const [key, value] of Object.entries(values)) data[key] = structuredClone(value);
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function coordinatorFixture(options = {}) {
  assert.equal(
    typeof coordinatorModule.createPersonaCoordinator,
    'function',
    'o coordenador transacional de personas precisa existir',
  );
  let nowValue = options.now ?? 1_000_000;
  let randomCounter = 0;
  const sessionArea = sessionAreaFixture();
  const leaseStore = createPersonaLeaseStore({
    sessionArea,
    lockManager: createFakeLockManager(),
    now: () => nowValue,
    randomBytes(length) {
      const bytes = new Uint8Array(length);
      randomCounter += 1;
      bytes[length - 2] = (randomCounter >> 8) & 0xff;
      bytes[length - 1] = randomCounter & 0xff;
      return bytes;
    },
  });
  const baseTargetQueue = createTargetOperationQueue();
  const targetQueue = options.targetQueueFactory?.(baseTargetQueue) ?? baseTargetQueue;
  const runtimeCalls = [];
  const runtimeQueue = [];
  const readerCalls = [];
  const readerQueue = [];
  const runtimeModes = new Map();
  let beforeRuntimeApply = null;
  let beforeRuntimeReader = null;
  const personaRuntime = {
    async apply(input) {
      runtimeCalls.push(structuredClone(input));
      await beforeRuntimeApply?.(input);
      const queued = runtimeQueue.length ? runtimeQueue.shift() : null;
      const result = queued ?? (input.op === 'install'
        ? { ok: true, documentId: input.target.documentId, frameId: 0, mode: input.mode }
        : input.op === 'clear'
          ? { ok: true, documentId: input.target.documentId, frameId: 0, mode: null }
          : {
              ok: true, documentId: input.target.documentId, frameId: 0,
              mode: runtimeModes.get(input.target.documentId) ?? null,
            });
      if (result.ok === true) {
        if (input.op === 'install') runtimeModes.set(input.target.documentId, result.mode);
        if (input.op === 'clear' && result.mode === null) runtimeModes.set(input.target.documentId, null);
      }
      return structuredClone(result);
    },
    async reader(input) {
      readerCalls.push(structuredClone(input));
      await beforeRuntimeReader?.(input);
      const queued = readerQueue.length ? readerQueue.shift() : null;
      const result = queued ?? {
        ok: true,
        documentId: input.target.documentId,
        frameId: 0,
        kind: 'state',
        ...(input.command.op === 'action' ? { actionStatus: 'accepted' } : {}),
        state: readerState(),
      };
      return structuredClone(result);
    },
  };
  const proofQueue = [];
  const probeCalls = [];
  const probeDocument = async tabId => {
    probeCalls.push(tabId);
    if (proofQueue.length) {
      const next = proofQueue.shift();
      if (next instanceof Error) throw next;
      return structuredClone(next);
    }
    const found = [target, secondTarget].find(candidate => candidate.tabId === tabId);
    if (!found) throw new Error('TARGET_DOCUMENT_UNAVAILABLE');
    return structuredClone(found);
  };
  const scheduleCalls = [];
  let renewalCalls = 0;
  const coordinatorLeaseStore = Object.fromEntries([
    'claimPrepared', 'activate', 'beginSetMode', 'commitSetMode', 'rollbackSetMode',
    'renewExplicitAction',
    'beginStop', 'completeStop', 'rehydrate', 'revoke', 'findOwner', 'snapshot',
    'listRecoverable', 'listExpired', 'prepareInvalidRegistryRecovery',
    'finalizeInvalidRegistryRecovery',
  ].map(name => [name, (...args) => leaseStore[name](...args)]));
  coordinatorLeaseStore.renewExplicitAction = (...args) => {
    renewalCalls += 1;
    return leaseStore.renewExplicitAction(...args);
  };
  Object.assign(coordinatorLeaseStore, options.leaseStoreOverrides || {});
  const coordinator = coordinatorModule.createPersonaCoordinator({
    leaseStore: coordinatorLeaseStore,
    targetQueue,
    personaRuntime,
    probeDocument,
    scheduleExpiry: async deadline => {
      scheduleCalls.push(deadline);
      await options.scheduleExpiry?.(deadline, scheduleCalls.length);
    },
  });
  return {
    coordinator, leaseStore, targetQueue, runtimeCalls, runtimeQueue, runtimeModes,
    readerCalls, readerQueue, proofQueue, probeCalls, scheduleCalls, sessionArea,
    advance(milliseconds) { nowValue += milliseconds; },
    setNow(value) { nowValue = value; },
    readNow() { return nowValue; },
    readRenewalCalls() { return renewalCalls; },
    beforeRuntimeApply(hook) { beforeRuntimeApply = hook; },
    beforeRuntimeReader(hook) { beforeRuntimeReader = hook; },
  };
}

async function claimActive(fixture, targetValue = target, mode = 'reader', owner = consumerFor(targetValue)) {
  return fixture.targetQueue.withTarget(targetValue, lock => fixture.coordinator.claimLocked({
    target: targetValue,
    consumer: owner,
    mode,
    lock,
  }));
}

async function prepareDirect(fixture, targetValue, owner, mode = 'reader') {
  const prepared = await fixture.leaseStore.claimPrepared({ target: targetValue, consumer: owner, mode });
  assert.equal(prepared.ok, true);
  return prepared.lease;
}

async function activateDirect(fixture, targetValue, owner, mode = 'reader') {
  const prepared = await prepareDirect(fixture, targetValue, owner, mode);
  const active = await fixture.leaseStore.activate({
    leaseId: prepared.leaseId,
    expectedRevision: prepared.revision,
  });
  assert.equal(active.ok, true);
  return active.lease;
}

test('claim verifies the held target, reprobes, installs and activates one lease', async () => {
  const fixture = coordinatorFixture();
  const result = await claimActive(fixture, target, 'reader', consumer);
  assert.equal(result.ok, true);
  assert.equal(result.lease.state, 'active');
  assert.equal(result.lease.activeMode, 'reader');
  assert.deepEqual(fixture.probeCalls, [7, 7]);
  assert.deepEqual(fixture.runtimeCalls.map(call => [call.op, call.mode ?? null]), [['install', 'reader']]);
  assert.equal((await fixture.leaseStore.findOwner(target)).leaseId, result.lease.leaseId);
  assert.equal(fixture.scheduleCalls.at(-1), result.lease.expiresAt);
});

test('a command-observed autonomous stop revokes the stale owner before a fresh start', async () => {
  const fixture = coordinatorFixture();
  const first = await claimActive(fixture, target, 'motor', consumer);
  assert.equal(first.ok, true);
  fixture.runtimeModes.set(target.documentId, null);

  const second = await claimActive(fixture, target, 'reader', reopenedConsumer);

  assert.equal(second.ok, true);
  assert.equal(second.lease.activeMode, 'reader');
  assert.equal(second.lease.leaseId === first.lease.leaseId, false);
  assert.equal((await fixture.leaseStore.findOwner(target)).leaseId, second.lease.leaseId);
  const stale = (await fixture.leaseStore.snapshot()).leases[first.lease.leaseId];
  assert.equal(stale.state, 'revoked');
  assert.equal(stale.revokeReason, 'runtime-failure');
  assert.deepEqual(fixture.runtimeCalls.map(call => [call.op, call.mode ?? null]), [
    ['install', 'motor'],
    ['inspect', null],
    ['clear', null],
    ['install', 'reader'],
  ]);
});

test('claim clears and revokes after installation failure', async () => {
  const fixture = coordinatorFixture();
  fixture.runtimeQueue.push({ ok: false, reason: 'runtime-error' });
  const result = await claimActive(fixture, target, 'reader', consumer);
  assert.deepEqual(result, { ok: false, code: 'PERSONA_RUNTIME_FAILED' });
  assert.deepEqual(fixture.runtimeCalls.map(call => call.op), ['install', 'clear']);
  assert.equal(await fixture.leaseStore.findOwner(target), null);
  const leases = Object.values((await fixture.leaseStore.snapshot()).leases);
  assert.equal(leases[0].state, 'revoked');
  assert.equal(leases[0].revokeReason, 'runtime-failure');
});

test('claim keeps a stopping owner when failed installation cannot be cleared', async () => {
  const fixture = coordinatorFixture();
  fixture.runtimeQueue.push(
    { ok: false, reason: 'runtime-error' },
    { ok: false, reason: 'cleanup-unconfirmed' },
  );
  const result = await claimActive(fixture, target, 'reader', consumer);
  assert.deepEqual(result, { ok: false, code: 'PERSONA_CLEANUP_UNCONFIRMED' });
  assert.equal((await fixture.leaseStore.findOwner(target)).state, 'stopping');
});

test('an activate that persists then throws after live installation is cleared and revoked', async () => {
  const fixture = coordinatorFixture({
    leaseStoreOverrides: {
      async activate(...args) {
        await fixture.leaseStore.activate(...args);
        throw new Error('session storage failed after injection');
      },
    },
  });
  const result = await claimActive(fixture, target, 'reader', consumer);
  assert.deepEqual(result, { ok: false, code: 'PERSONA_STATE_FAILED' });
  assert.deepEqual(fixture.runtimeCalls.map(call => call.op), ['install', 'clear']);
  assert.equal(await fixture.leaseStore.findOwner(target), null);
});

test('uncertain state cleanup reports unconfirmed when its conservative clear also fails', async () => {
  const fixture = coordinatorFixture({
    leaseStoreOverrides: {
      async activate() { throw new Error('session storage failed after injection'); },
      async beginStop() { throw new Error('session storage remains unavailable'); },
    },
  });
  fixture.runtimeQueue.push(
    { ok: true, documentId: target.documentId, frameId: 0, mode: 'reader' },
    { ok: false, reason: 'cleanup-unconfirmed' },
  );
  const result = await claimActive(fixture, target, 'reader', consumer);
  assert.deepEqual(result, { ok: false, code: 'PERSONA_CLEANUP_UNCONFIRMED' });
  assert.equal((await fixture.leaseStore.findOwner(target)).state, 'prepared');
});

test('a changed document is rejected before any lease or runtime mutation', async () => {
  const fixture = coordinatorFixture();
  fixture.proofQueue.push({ ...target, documentId: 'reloaded-document' });
  const result = await claimActive(fixture, target, 'reader', consumer);
  assert.deepEqual(result, { ok: false, code: 'PERSONA_TARGET_CHANGED' });
  assert.equal(await fixture.leaseStore.findOwner(target), null);
  assert.deepEqual(fixture.runtimeCalls, []);
});

test('claim revokes a prepared runtime when navigation wins immediately after installation', async () => {
  const fixture = coordinatorFixture();
  fixture.proofQueue.push(target, { ...target, documentId: 'reloaded-document' });
  const result = await claimActive(fixture, target, 'reader', consumer);
  assert.deepEqual(result, { ok: false, code: 'PERSONA_TARGET_CHANGED' });
  assert.equal(await fixture.leaseStore.findOwner(target), null);
  assert.deepEqual(fixture.runtimeCalls.map(call => call.op), ['install', 'clear']);
});

test('claim rejects counterfeit or expired lock tokens before probing', async () => {
  const fixture = coordinatorFixture();
  await assert.rejects(
    () => fixture.coordinator.claimLocked({ target, consumer, mode: 'reader', lock: Object.freeze({}) }),
    /lock inválido/iu,
  );
  assert.deepEqual(fixture.probeCalls, []);
});

test('serializes expiry scheduling so a stale independent completion cannot overwrite the newest deadline', async () => {
  const firstSchedule = deferred();
  const fixture = coordinatorFixture({
    scheduleExpiry: async (_deadline, position) => {
      if (position === 1) await firstSchedule.promise;
    },
  });
  const first = claimActive(fixture, target, 'reader', consumer);
  const second = claimActive(fixture, secondTarget, 'motor', consumerFor(secondTarget));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fixture.scheduleCalls.length, 1);
  firstSchedule.resolve();
  await Promise.all([first, second]);
  assert.equal(fixture.scheduleCalls.length, 2);
  assert.equal(fixture.scheduleCalls.at(-1), 1_000_000 + 30 * 60_000);
});

test('a scheduling failure clears and revokes the live lease before returning without a leaseId', async () => {
  let failuresRemaining = 2;
  const fixture = coordinatorFixture({
    scheduleExpiry: async () => {
      if (failuresRemaining > 0) {
        failuresRemaining -= 1;
        throw new Error('alarms unavailable');
      }
    },
  });
  const claimed = await claimActive(fixture, target, 'reader', consumer);
  assert.deepEqual(claimed, { ok: false, code: 'PERSONA_EXPIRY_SCHEDULE_FAILED' });
  assert.equal(Object.hasOwn(claimed, 'leaseId'), false);
  assert.equal(Object.hasOwn(claimed, 'lease'), false);
  assert.equal(await fixture.leaseStore.findOwner(target), null);
  assert.deepEqual(fixture.runtimeCalls.map(call => call.op), ['install', 'clear']);
  assert.equal(fixture.scheduleCalls.length, 2);
  assert.equal(fixture.scheduleCalls.at(-1), null);
});

test('concurrent locked claims never cross-acquire targets when expiry scheduling stays unavailable', async () => {
  const lockContext = new AsyncLocalStorage();
  const crossAcquisitions = [];
  const fixture = coordinatorFixture({
    targetQueueFactory(base) {
      return {
        assertHeld: (...args) => base.assertHeld(...args),
        withTarget(receivedTarget, operation) {
          const heldDocumentId = lockContext.getStore();
          if (heldDocumentId && heldDocumentId !== receivedTarget.documentId) {
            crossAcquisitions.push([heldDocumentId, receivedTarget.documentId]);
            throw new Error('CROSS_TARGET_LOCK');
          }
          return base.withTarget(receivedTarget, lock =>
            lockContext.run(receivedTarget.documentId, () => operation(lock)));
        },
      };
    },
    async scheduleExpiry() { throw new Error('alarms persistently unavailable'); },
  });

  const outcomes = await Promise.all([
    claimActive(fixture, target, 'reader', consumer),
    claimActive(fixture, secondTarget, 'motor', consumerFor(secondTarget)),
  ]);

  assert.deepEqual(crossAcquisitions, []);
  assert.deepEqual(outcomes, [
    { ok: false, code: 'PERSONA_EXPIRY_SCHEDULE_FAILED' },
    { ok: false, code: 'PERSONA_EXPIRY_SCHEDULE_FAILED' },
  ]);
  assert.equal(await fixture.leaseStore.findOwner(target), null);
  assert.equal(await fixture.leaseStore.findOwner(secondTarget), null);
  assert.equal(fixture.runtimeModes.get(target.documentId), null);
  assert.equal(fixture.runtimeModes.get(secondTarget.documentId), null);
});

test('setMode commits the new mode under the same target queue', async () => {
  const fixture = coordinatorFixture();
  const claimed = await claimActive(fixture, target, 'reader', consumer);
  fixture.runtimeCalls.length = 0;
  const result = await fixture.coordinator.setMode({
    leaseId: claimed.lease.leaseId,
    consumer,
    mode: 'motor',
  });
  assert.equal(result.ok, true);
  assert.equal(result.lease.activeMode, 'motor');
  assert.equal(result.lease.pendingMode, null);
  assert.deepEqual(fixture.runtimeCalls.map(call => [call.op, call.mode ?? null]), [['install', 'motor']]);
});

test('authenticated reader state and reader stop preserve the active reader lease', async () => {
  const fixture = coordinatorFixture();
  const claimed = await claimActive(fixture, target, 'reader', consumer);
  fixture.runtimeCalls.length = 0;
  fixture.probeCalls.length = 0;

  const stateResult = await fixture.coordinator.readerCommand({
    leaseId: claimed.lease.leaseId,
    consumer,
    command: { version: 1, op: 'state' },
  });
  assert.deepEqual(stateResult, { ok: true, kind: 'state', state: readerState() });
  assert.deepEqual(fixture.readerCalls, [{
    target,
    command: { version: 1, op: 'state' },
  }]);
  assert.deepEqual(fixture.probeCalls, [target.tabId, target.tabId]);

  fixture.readerQueue.push({
    ok: true,
    documentId: target.documentId,
    frameId: 0,
    kind: 'state',
    actionStatus: 'accepted',
    state: readerState({
      playback: 'idle', index: -1, total: 0, caption: '', canNext: false,
    }),
  });
  const stopped = await fixture.coordinator.readerCommand({
    leaseId: claimed.lease.leaseId,
    consumer,
    command: { version: 1, op: 'action', action: 'stop' },
  });
  assert.equal(stopped.ok, true);
  assert.equal(stopped.state.playback, 'idle');
  const owner = await fixture.leaseStore.findOwner(target);
  assert.equal(owner.leaseId, claimed.lease.leaseId);
  assert.equal(owner.state, 'active');
  assert.equal(owner.activeMode, 'reader');
  assert.equal(owner.pendingMode, null);
  assert.deepEqual(fixture.runtimeCalls, []);
});

test('reader stop keeps a truthful playing state while its owned utterance settles', async () => {
  const fixture = coordinatorFixture();
  const claimed = await claimActive(fixture, target, 'reader', consumer);
  fixture.readerQueue.push({
    ok: true,
    documentId: target.documentId,
    frameId: 0,
    kind: 'state',
    actionStatus: 'accepted',
    state: readerState({ playback: 'playing' }),
  });

  assert.deepEqual(await fixture.coordinator.readerCommand({
    leaseId: claimed.lease.leaseId,
    consumer,
    command: { version: 1, op: 'action', action: 'stop' },
  }), {
    ok: true,
    kind: 'state',
    state: readerState({ playback: 'playing' }),
  });
  const owner = await fixture.leaseStore.findOwner(target);
  assert.equal(owner.leaseId, claimed.lease.leaseId);
  assert.equal(owner.activeMode, 'reader');
  assert.equal(owner.revision, claimed.lease.revision + 1);
});

test('reader state is observational while explicit actions renew the lease by CAS', async () => {
  const fixture = coordinatorFixture();
  const claimed = await claimActive(fixture, target, 'reader', consumer);
  fixture.advance(10_000);

  assert.equal((await fixture.coordinator.readerCommand({
    leaseId: claimed.lease.leaseId,
    consumer,
    command: { version: 1, op: 'state' },
  })).ok, true);
  const observed = await fixture.leaseStore.findOwner(target);
  assert.equal(observed.revision, claimed.lease.revision);
  assert.equal(observed.lastExplicitActionAt, claimed.lease.lastExplicitActionAt);
  assert.equal(observed.expiresAt, claimed.lease.expiresAt);

  assert.equal((await fixture.coordinator.readerCommand({
    leaseId: claimed.lease.leaseId,
    consumer,
    command: { version: 1, op: 'action', action: 'next' },
  })).ok, true);
  const renewed = await fixture.leaseStore.findOwner(target);
  assert.equal(renewed.revision, claimed.lease.revision + 1);
  assert.equal(renewed.lastExplicitActionAt, fixture.readNow());
  assert.equal(renewed.expiresAt, fixture.readNow() + 30 * 60_000);
});

test('a rejected reader action returns closed and never renews the lease', async () => {
  const fixture = coordinatorFixture();
  const claimed = await claimActive(fixture, target, 'reader', consumer);
  fixture.advance(5_000);
  fixture.runtimeCalls.length = 0;
  fixture.readerQueue.push({
    ok: true,
    documentId: target.documentId,
    frameId: 0,
    kind: 'state',
    actionStatus: 'rejected',
    state: readerState(),
  });

  assert.deepEqual(await fixture.coordinator.readerCommand({
    leaseId: claimed.lease.leaseId,
    consumer,
    command: { version: 1, op: 'action', action: 'next' },
  }), { ok: false, code: 'PERSONA_READER_ACTION_REJECTED' });
  const owner = await fixture.leaseStore.findOwner(target);
  assert.equal(owner.revision, claimed.lease.revision);
  assert.equal(owner.lastExplicitActionAt, claimed.lease.lastExplicitActionAt);
  assert.equal(owner.expiresAt, claimed.lease.expiresAt);
  assert.equal(fixture.readRenewalCalls(), 0);
  assert.deepEqual(fixture.runtimeCalls, []);
});

test('rejected reader preferences and voice requests never renew the lease', async () => {
  for (const { command, reason, code } of [
    {
      command: { version: 1, op: 'preferences', voiceId: 'missing-local-voice', rate: 1 },
      reason: 'voice-unavailable',
      code: 'PERSONA_READER_VOICE_UNAVAILABLE',
    },
    {
      command: { version: 1, op: 'voices', explicitUserGesture: true },
      reason: 'gesture-required',
      code: 'PERSONA_READER_GESTURE_REQUIRED',
    },
  ]) {
    const fixture = coordinatorFixture();
    const claimed = await claimActive(fixture, target, 'reader', consumer);
    fixture.advance(5_000);
    fixture.readerQueue.push({ ok: false, reason });

    assert.deepEqual(await fixture.coordinator.readerCommand({
      leaseId: claimed.lease.leaseId,
      consumer,
      command,
    }), { ok: false, code });
    const owner = await fixture.leaseStore.findOwner(target);
    assert.equal(owner.revision, claimed.lease.revision);
    assert.equal(owner.lastExplicitActionAt, claimed.lease.lastExplicitActionAt);
    assert.equal(owner.expiresAt, claimed.lease.expiresAt);
    assert.equal(fixture.readRenewalCalls(), 0);
  }
});

test('a terminal reader action compensates its mutation instead of renewing', async () => {
  const fixture = coordinatorFixture();
  const claimed = await claimActive(fixture, target, 'reader', consumer);
  fixture.runtimeCalls.length = 0;
  fixture.readerQueue.push({
    ok: true,
    documentId: target.documentId,
    frameId: 0,
    kind: 'state',
    actionStatus: 'terminal',
    state: readerState({ speechAvailability: 'error' }),
  });

  assert.deepEqual(await fixture.coordinator.readerCommand({
    leaseId: claimed.lease.leaseId,
    consumer,
    command: { version: 1, op: 'action', action: 'next' },
  }), { ok: false, code: 'PERSONA_READER_ACTION_TERMINAL' });
  assert.equal(fixture.readRenewalCalls(), 0);
  assert.deepEqual(fixture.runtimeCalls.map(call => call.op), ['clear']);
  assert.equal(await fixture.leaseStore.findOwner(target), null);
});

test('preferences and gesture-authorized voice inventory also renew the reader lease', async () => {
  const fixture = coordinatorFixture();
  const claimed = await claimActive(fixture, target, 'reader', consumer);
  fixture.advance(1_000);
  assert.equal((await fixture.coordinator.readerCommand({
    leaseId: claimed.lease.leaseId,
    consumer,
    command: { version: 1, op: 'preferences', voiceId: 'local-a', rate: 1 },
  })).ok, true);
  const afterPreference = await fixture.leaseStore.findOwner(target);
  assert.equal(afterPreference.revision, claimed.lease.revision + 1);

  fixture.advance(1_000);
  fixture.readerQueue.push({
    ok: true,
    documentId: target.documentId,
    frameId: 0,
    kind: 'voices',
    status: 'available',
    voices: [{ id: 'local-a', label: 'Voz local A', lang: 'pt-BR' }],
  });
  assert.equal((await fixture.coordinator.readerCommand({
    leaseId: claimed.lease.leaseId,
    consumer,
    command: { version: 1, op: 'voices', explicitUserGesture: true },
  })).ok, true);
  const afterInventory = await fixture.leaseStore.findOwner(target);
  assert.equal(afterInventory.revision, afterPreference.revision + 1);
  assert.equal(afterInventory.lastExplicitActionAt, fixture.readNow());
});

test('an explicit reader action may cross the old deadline and renew after runtime completion', async () => {
  const fixture = coordinatorFixture();
  const claimed = await claimActive(fixture, target, 'reader', consumer);
  fixture.advance(30 * 60_000 - 1);
  fixture.beforeRuntimeReader(() => fixture.advance(1));

  const result = await fixture.coordinator.readerCommand({
    leaseId: claimed.lease.leaseId,
    consumer,
    command: { version: 1, op: 'action', action: 'next' },
  });

  assert.equal(result.ok, true);
  const renewed = await fixture.leaseStore.findOwner(target);
  assert.equal(renewed.lastExplicitActionAt, fixture.readNow());
  assert.equal(renewed.expiresAt, fixture.readNow() + 30 * 60_000);
});

test('a failed renewal after reader mutation compensates by clearing and revoking', async () => {
  let failRenewal = false;
  const fixture = coordinatorFixture({
    leaseStoreOverrides: {
      async renewExplicitAction(...args) {
        if (failRenewal) return { ok: false, code: 'PERSONA_REVISION_MISMATCH' };
        return fixture.leaseStore.renewExplicitAction(...args);
      },
    },
  });
  const claimed = await claimActive(fixture, target, 'reader', consumer);
  failRenewal = true;
  fixture.runtimeCalls.length = 0;

  assert.deepEqual(await fixture.coordinator.readerCommand({
    leaseId: claimed.lease.leaseId,
    consumer,
    command: { version: 1, op: 'action', action: 'next' },
  }), { ok: false, code: 'PERSONA_STATE_FAILED' });
  assert.equal(fixture.readerCalls.length, 1);
  assert.deepEqual(fixture.runtimeCalls.map(call => call.op), ['clear']);
  assert.equal(await fixture.leaseStore.findOwner(target), null);
});

test('a renewal that persists then throws is also cleared and revoked', async () => {
  let failAfterPersist = false;
  const fixture = coordinatorFixture({
    leaseStoreOverrides: {
      async renewExplicitAction(...args) {
        const result = await fixture.leaseStore.renewExplicitAction(...args);
        if (failAfterPersist) throw new Error('uncertain renewal persistence');
        return result;
      },
    },
  });
  const claimed = await claimActive(fixture, target, 'reader', consumer);
  failAfterPersist = true;
  fixture.runtimeCalls.length = 0;

  assert.deepEqual(await fixture.coordinator.readerCommand({
    leaseId: claimed.lease.leaseId,
    consumer,
    command: { version: 1, op: 'action', action: 'next' },
  }), { ok: false, code: 'PERSONA_STATE_FAILED' });
  assert.deepEqual(fixture.runtimeCalls.map(call => call.op), ['clear']);
  assert.equal(await fixture.leaseStore.findOwner(target), null);
});

test('reader commands authenticate the exact consumer and require an active stable reader lease', async () => {
  const fixture = coordinatorFixture();
  const reader = await claimActive(fixture, target, 'reader', consumer);
  const impostor = { ...consumer, documentId: 'side-panel-window:impostor' };
  assert.deepEqual(await fixture.coordinator.readerCommand({
    leaseId: reader.lease.leaseId,
    consumer: impostor,
    command: { version: 1, op: 'state' },
  }), { ok: false, code: 'PERSONA_CONSUMER_MISMATCH' });
  assert.deepEqual(fixture.readerCalls, []);

  const motor = await claimActive(fixture, secondTarget, 'motor', consumerFor(secondTarget));
  assert.deepEqual(await fixture.coordinator.readerCommand({
    leaseId: motor.lease.leaseId,
    consumer: consumerFor(secondTarget),
    command: { version: 1, op: 'state' },
  }), { ok: false, code: 'PERSONA_READER_INACTIVE' });
  assert.deepEqual(fixture.readerCalls, []);
});

test('reader voice inventory requires a trusted explicit gesture and stays minimal', async () => {
  const fixture = coordinatorFixture();
  const claimed = await claimActive(fixture, target, 'reader', consumer);
  assert.deepEqual(await fixture.coordinator.readerCommand({
    leaseId: claimed.lease.leaseId,
    consumer,
    command: { version: 1, op: 'voices', explicitUserGesture: false },
  }), { ok: false, code: 'PERSONA_READER_GESTURE_REQUIRED' });
  assert.deepEqual(fixture.readerCalls, []);

  fixture.readerQueue.push({
    ok: true,
    documentId: target.documentId,
    frameId: 0,
    kind: 'voices',
    status: 'available',
    voices: [{ id: 'local-a', label: 'Voz local A', lang: 'pt-BR' }],
  });
  assert.deepEqual(await fixture.coordinator.readerCommand({
    leaseId: claimed.lease.leaseId,
    consumer,
    command: { version: 1, op: 'voices', explicitUserGesture: true },
  }), {
    ok: true,
    kind: 'voices',
    status: 'available',
    voices: [{ id: 'local-a', label: 'Voz local A', lang: 'pt-BR' }],
  });

  fixture.readerQueue.push({
    ok: true,
    documentId: target.documentId,
    frameId: 0,
    kind: 'voices',
    status: 'unavailable',
    voices: [],
  });
  assert.deepEqual(await fixture.coordinator.readerCommand({
    leaseId: claimed.lease.leaseId,
    consumer,
    command: { version: 1, op: 'voices', explicitUserGesture: true },
  }), {
    ok: true,
    kind: 'voices',
    status: 'unavailable',
    voices: [],
  });
});

test('reader command validation is exact and never evaluates accessor properties', async () => {
  const fixture = coordinatorFixture();
  const claimed = await claimActive(fixture, target, 'reader', consumer);
  for (const args of [
    { leaseId: claimed.lease.leaseId, consumer, command: { version: 1, op: 'state' }, extra: true },
    { leaseId: claimed.lease.leaseId, consumer, command: { version: 1, op: 'action', action: 'clear' } },
    { leaseId: claimed.lease.leaseId, consumer, command: { version: 1, op: 'preferences', voiceId: 'local-a', rate: 0.49 } },
    { leaseId: 'lease-invalid', consumer, command: { version: 1, op: 'state' } },
  ]) {
    await assert.rejects(
      () => fixture.coordinator.readerCommand(args),
      /PERSONA_INPUT_INVALID/u,
    );
  }

  let reads = 0;
  const hostile = {
    leaseId: claimed.lease.leaseId,
    consumer,
    command: { version: 1, op: 'state' },
  };
  Object.defineProperty(hostile.command, 'op', {
    enumerable: true,
    get() { reads += 1; return 'state'; },
  });
  await assert.rejects(
    () => fixture.coordinator.readerCommand(hostile),
    /PERSONA_INPUT_INVALID/u,
  );
  assert.equal(reads, 0);
});

test('reader commands recheck navigation and expiry after the runtime and revoke safely', async () => {
  const navigated = coordinatorFixture();
  const navigationLease = await claimActive(navigated, target, 'reader', consumer);
  navigated.runtimeCalls.length = 0;
  navigated.proofQueue.push(target, { ...target, documentId: 'reloaded-document' });
  assert.deepEqual(await navigated.coordinator.readerCommand({
    leaseId: navigationLease.lease.leaseId,
    consumer,
    command: { version: 1, op: 'state' },
  }), { ok: false, code: 'PERSONA_TARGET_CHANGED' });
  assert.equal(await navigated.leaseStore.findOwner(target), null);
  assert.deepEqual(navigated.runtimeCalls.map(call => call.op), ['clear']);

  const expired = coordinatorFixture();
  const expiryLease = await claimActive(expired, target, 'reader', consumer);
  expired.runtimeCalls.length = 0;
  expired.advance(30 * 60_000 - 1);
  expired.beforeRuntimeReader(() => expired.advance(1));
  assert.deepEqual(await expired.coordinator.readerCommand({
    leaseId: expiryLease.lease.leaseId,
    consumer,
    command: { version: 1, op: 'state' },
  }), { ok: false, code: 'PERSONA_EXPIRED' });
  assert.equal(await expired.leaseStore.findOwner(target), null);
  assert.deepEqual(expired.runtimeCalls.map(call => call.op), ['clear']);
});

test('terminal reader result failures are compensated under the target lock', async () => {
  for (const result of [
    { ok: false, reason: 'runtime-error' },
    {
      ok: true,
      documentId: target.documentId,
      frameId: 0,
      kind: 'state',
      state: { ...readerState(), caption: 'altered\ncaption' },
    },
  ]) {
    const fixture = coordinatorFixture();
    const claimed = await claimActive(fixture, target, 'reader', consumer);
    fixture.runtimeCalls.length = 0;
    fixture.readerQueue.push(result);
    assert.deepEqual(await fixture.coordinator.readerCommand({
      leaseId: claimed.lease.leaseId,
      consumer,
      command: { version: 1, op: 'state' },
    }), { ok: false, code: 'PERSONA_READER_RUNTIME_FAILED' });
    assert.equal(await fixture.leaseStore.findOwner(target), null);
    assert.deepEqual(fixture.runtimeCalls.map(call => call.op), ['clear']);
  }
});

test('setMode restores the prior mode and rolls back after a runtime failure', async () => {
  const fixture = coordinatorFixture();
  const claimed = await claimActive(fixture, target, 'reader', consumer);
  fixture.runtimeCalls.length = 0;
  fixture.runtimeQueue.push(
    { ok: false, reason: 'runtime-error' },
    { ok: true, documentId: target.documentId, frameId: 0, mode: 'reader' },
  );
  const result = await fixture.coordinator.setMode({
    leaseId: claimed.lease.leaseId,
    consumer,
    mode: 'motor',
  });
  assert.deepEqual(result, { ok: false, code: 'PERSONA_RUNTIME_FAILED' });
  const owner = await fixture.leaseStore.findOwner(target);
  assert.equal(owner.state, 'active');
  assert.equal(owner.activeMode, 'reader');
  assert.equal(owner.pendingMode, null);
  assert.deepEqual(fixture.runtimeCalls.map(call => [call.op, call.mode ?? null]), [
    ['install', 'motor'], ['install', 'reader'],
  ]);
});

test('a thrown commit after live mode change restores and rolls back the prior mode', async () => {
  let throwCommit = false;
  const fixture = coordinatorFixture({
    leaseStoreOverrides: {
      async commitSetMode(...args) {
        if (throwCommit) throw new Error('session storage failed after mode switch');
        return fixture.leaseStore.commitSetMode(...args);
      },
    },
  });
  const claimed = await claimActive(fixture, target, 'reader', consumer);
  throwCommit = true;
  fixture.runtimeCalls.length = 0;
  const result = await fixture.coordinator.setMode({
    leaseId: claimed.lease.leaseId,
    consumer,
    mode: 'motor',
  });
  assert.deepEqual(result, { ok: false, code: 'PERSONA_STATE_FAILED' });
  const owner = await fixture.leaseStore.findOwner(target);
  assert.equal(owner.activeMode, 'reader');
  assert.equal(owner.pendingMode, null);
  assert.deepEqual(fixture.runtimeCalls.map(call => [call.op, call.mode ?? null]), [
    ['install', 'motor'], ['install', 'reader'],
  ]);
});

test('a commit that persists then throws cannot be rolled back and is cleared and revoked', async () => {
  let throwAfterCommit = false;
  const fixture = coordinatorFixture({
    leaseStoreOverrides: {
      async commitSetMode(...args) {
        const committed = await fixture.leaseStore.commitSetMode(...args);
        if (throwAfterCommit) throw new Error('session storage answered after committing');
        return committed;
      },
    },
  });
  const claimed = await claimActive(fixture, target, 'reader', consumer);
  throwAfterCommit = true;
  fixture.runtimeCalls.length = 0;
  const result = await fixture.coordinator.setMode({
    leaseId: claimed.lease.leaseId,
    consumer,
    mode: 'motor',
  });
  assert.deepEqual(result, { ok: false, code: 'PERSONA_STATE_FAILED' });
  assert.equal(await fixture.leaseStore.findOwner(target), null);
  assert.deepEqual(fixture.runtimeCalls.map(call => [call.op, call.mode ?? null]), [
    ['install', 'motor'], ['install', 'reader'], ['clear', null],
  ]);
});

test('a rollback throw after prior-mode restoration is cleared and revoked', async () => {
  let throwCommit = false;
  const fixture = coordinatorFixture({
    leaseStoreOverrides: {
      async commitSetMode(...args) {
        if (throwCommit) throw new Error('commit unavailable');
        return fixture.leaseStore.commitSetMode(...args);
      },
      async rollbackSetMode() { throw new Error('rollback unavailable'); },
    },
  });
  const claimed = await claimActive(fixture, target, 'reader', consumer);
  throwCommit = true;
  fixture.runtimeCalls.length = 0;
  const result = await fixture.coordinator.setMode({
    leaseId: claimed.lease.leaseId,
    consumer,
    mode: 'motor',
  });
  assert.deepEqual(result, { ok: false, code: 'PERSONA_STATE_FAILED' });
  assert.equal(await fixture.leaseStore.findOwner(target), null);
  assert.deepEqual(fixture.runtimeCalls.map(call => [call.op, call.mode ?? null]), [
    ['install', 'motor'], ['install', 'reader'], ['clear', null],
  ]);
});

test('setMode revokes after failed activation and failed restoration when final clear is confirmed', async () => {
  const fixture = coordinatorFixture();
  const claimed = await claimActive(fixture, target, 'reader', consumer);
  fixture.runtimeCalls.length = 0;
  fixture.runtimeQueue.push(
    { ok: false, reason: 'runtime-error' },
    { ok: false, reason: 'runtime-error' },
    { ok: true, documentId: target.documentId, frameId: 0, mode: null },
  );
  const result = await fixture.coordinator.setMode({
    leaseId: claimed.lease.leaseId,
    consumer,
    mode: 'motor',
  });
  assert.deepEqual(result, { ok: false, code: 'PERSONA_REVOKED_AFTER_RUNTIME_FAILURE' });
  assert.equal(await fixture.leaseStore.findOwner(target), null);
  assert.deepEqual(fixture.runtimeCalls.map(call => [call.op, call.mode ?? null]), [
    ['install', 'motor'], ['install', 'reader'], ['clear', null],
  ]);
});

test('setMode never reaches the runtime for a different Side Panel consumer', async () => {
  const fixture = coordinatorFixture();
  const claimed = await claimActive(fixture, target, 'reader', consumer);
  fixture.runtimeCalls.length = 0;
  const impostor = { ...consumer, documentId: 'side-panel-window:other' };
  const result = await fixture.coordinator.setMode({
    leaseId: claimed.lease.leaseId,
    consumer: impostor,
    mode: 'motor',
  });
  assert.deepEqual(result, { ok: false, code: 'PERSONA_CONSUMER_MISMATCH' });
  assert.deepEqual(fixture.runtimeCalls, []);
});

test('a thrown beginSetMode conservatively clears and revokes the live prior mode', async () => {
  let throwBegin = true;
  const fixture = coordinatorFixture({
    leaseStoreOverrides: {
      async beginSetMode(...args) {
        if (throwBegin) {
          throwBegin = false;
          throw new Error('uncertain pending-mode persistence');
        }
        return fixture.leaseStore.beginSetMode(...args);
      },
    },
  });
  const claimed = await claimActive(fixture, target, 'reader', consumer);
  fixture.runtimeCalls.length = 0;
  const result = await fixture.coordinator.setMode({
    leaseId: claimed.lease.leaseId,
    consumer,
    mode: 'motor',
  });
  assert.deepEqual(result, { ok: false, code: 'PERSONA_STATE_FAILED' });
  assert.equal(await fixture.leaseStore.findOwner(target), null);
  assert.deepEqual(fixture.runtimeCalls.map(call => call.op), ['clear']);
});

test('a rejected beginSetMode clears and revokes an expired live prior mode', async () => {
  let rejectBegin = false;
  const fixture = coordinatorFixture({
    leaseStoreOverrides: {
      async beginSetMode(...args) {
        if (rejectBegin) {
          rejectBegin = false;
          return { ok: false, code: 'PERSONA_EXPIRED' };
        }
        return fixture.leaseStore.beginSetMode(...args);
      },
    },
  });
  const claimed = await claimActive(fixture, target, 'reader', consumer);
  rejectBegin = true;
  fixture.runtimeCalls.length = 0;
  const result = await fixture.coordinator.setMode({
    leaseId: claimed.lease.leaseId,
    consumer,
    mode: 'motor',
  });
  assert.deepEqual(result, { ok: false, code: 'PERSONA_EXPIRED' });
  assert.equal(await fixture.leaseStore.findOwner(target), null);
  assert.deepEqual(fixture.runtimeCalls.map(call => call.op), ['clear']);
});

test('explicit stop retries clear once and preserves a stopping owner if absence remains unconfirmed', async () => {
  const fixture = coordinatorFixture();
  const claimed = await claimActive(fixture, target, 'reader', consumer);
  fixture.runtimeCalls.length = 0;
  fixture.runtimeQueue.push(
    { ok: false, reason: 'cleanup-unconfirmed' },
    { ok: false, reason: 'cleanup-unconfirmed' },
  );
  const result = await fixture.coordinator.stop({
    leaseId: claimed.lease.leaseId,
    consumer,
    explicit: true,
  });
  assert.deepEqual(result, { ok: false, code: 'PERSONA_CLEANUP_UNCONFIRMED' });
  assert.equal((await fixture.leaseStore.findOwner(target)).state, 'stopping');
  assert.deepEqual(fixture.runtimeCalls.map(call => call.op), ['clear', 'clear']);
});

test('explicit stop can finish its authenticated stopping lease after owned speech ends', async () => {
  const fixture = coordinatorFixture();
  const claimed = await claimActive(fixture, target, 'reader', consumer);
  fixture.runtimeQueue.push(
    { ok: false, reason: 'cleanup-unconfirmed' },
    { ok: false, reason: 'cleanup-unconfirmed' },
  );

  assert.deepEqual(await fixture.coordinator.stop({
    leaseId: claimed.lease.leaseId,
    consumer,
    explicit: true,
  }), { ok: false, code: 'PERSONA_CLEANUP_UNCONFIRMED' });
  const stopping = await fixture.leaseStore.findOwner(target);
  assert.equal(stopping.state, 'stopping');

  const completed = await fixture.coordinator.stop({
    leaseId: claimed.lease.leaseId,
    consumer,
    explicit: true,
  });
  assert.equal(completed.ok, true);
  assert.equal(completed.lease.state, 'revoked');
  assert.equal(await fixture.leaseStore.findOwner(target), null);
});

test('a thrown beginStop still attempts conservative clear and revocation under the held lock', async () => {
  let throwBegin = true;
  const fixture = coordinatorFixture({
    leaseStoreOverrides: {
      async beginStop(...args) {
        if (throwBegin) {
          throwBegin = false;
          throw new Error('uncertain stopping persistence');
        }
        return fixture.leaseStore.beginStop(...args);
      },
    },
  });
  const claimed = await claimActive(fixture, target, 'reader', consumer);
  fixture.runtimeCalls.length = 0;
  const result = await fixture.coordinator.stop({
    leaseId: claimed.lease.leaseId,
    consumer,
    explicit: true,
  });
  assert.deepEqual(result, { ok: false, code: 'PERSONA_STATE_FAILED' });
  assert.equal(await fixture.leaseStore.findOwner(target), null);
  assert.deepEqual(fixture.runtimeCalls.map(call => call.op), ['clear']);
});

test('a rejected explicit beginStop still clears and revokes an expired live mode', async () => {
  let rejectBegin = false;
  const fixture = coordinatorFixture({
    leaseStoreOverrides: {
      async beginStop(...args) {
        if (rejectBegin) {
          rejectBegin = false;
          return { ok: false, code: 'PERSONA_EXPIRED' };
        }
        return fixture.leaseStore.beginStop(...args);
      },
    },
  });
  const claimed = await claimActive(fixture, target, 'reader', consumer);
  rejectBegin = true;
  fixture.runtimeCalls.length = 0;
  const result = await fixture.coordinator.stop({
    leaseId: claimed.lease.leaseId,
    consumer,
    explicit: true,
  });
  assert.deepEqual(result, { ok: false, code: 'PERSONA_EXPIRED' });
  assert.equal(await fixture.leaseStore.findOwner(target), null);
  assert.deepEqual(fixture.runtimeCalls.map(call => call.op), ['clear']);
});

test('confirmed explicit stop creates a terminal tombstone and releases target ownership', async () => {
  const fixture = coordinatorFixture();
  const claimed = await claimActive(fixture, target, 'reader', consumer);
  fixture.advance(1_000);
  const result = await fixture.coordinator.stop({
    leaseId: claimed.lease.leaseId,
    consumer,
    explicit: true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.lease.state, 'revoked');
  assert.equal(result.lease.activeMode, null);
  assert.equal(result.lease.revokeReason, 'explicit-stop');
  assert.equal(result.lease.expiresAt, claimed.lease.expiresAt + 1_000);
  assert.equal(await fixture.leaseStore.findOwner(target), null);
});

test('explicit stop revokes the old owner so a fresh capability can start and activate the target', async () => {
  const fixture = coordinatorFixture();
  const first = await claimActive(fixture, target, 'reader', consumer);
  const stopped = await fixture.coordinator.stop({
    leaseId: first.lease.leaseId,
    consumer,
    explicit: true,
  });
  assert.equal(stopped.ok, true);
  assert.equal(stopped.lease.state, 'revoked');
  assert.equal(stopped.lease.revokeReason, 'explicit-stop');
  assert.equal(await fixture.leaseStore.findOwner(target), null);

  assert.deepEqual(await fixture.coordinator.setMode({
    leaseId: first.lease.leaseId,
    consumer,
    mode: 'motor',
  }), { ok: false, code: 'PERSONA_NOT_FOUND' });
  assert.deepEqual(await fixture.coordinator.stop({
    leaseId: first.lease.leaseId,
    consumer,
    explicit: true,
  }), { ok: false, code: 'PERSONA_NOT_FOUND' });

  const second = await claimActive(fixture, target, 'motor', consumer);
  assert.equal(second.ok, true);
  assert.notEqual(second.lease.leaseId, first.lease.leaseId);
  assert.equal(second.lease.state, 'active');
  assert.equal(second.lease.activeMode, 'motor');
});

test('restart recovery does not resurrect or rehydrate an explicitly stopped lease', async () => {
  const fixture = coordinatorFixture();
  const claimed = await claimActive(fixture, target, 'reader', consumer);
  const stopped = await fixture.coordinator.stop({
    leaseId: claimed.lease.leaseId,
    consumer,
    explicit: true,
  });
  assert.equal(stopped.ok, true);
  fixture.runtimeCalls.length = 0;

  assert.deepEqual(await fixture.coordinator.recover(), {
    ok: true,
    processed: 0,
    revoked: 0,
    retained: 0,
  });
  const rehydrated = await fixture.targetQueue.withTarget(target, lock =>
    fixture.coordinator.rehydrateLocked({ target, consumer: reopenedConsumer, lock }));
  assert.deepEqual(rehydrated, { ok: false, code: 'PERSONA_NOT_FOUND' });
  assert.deepEqual(fixture.runtimeCalls, []);
});

test('a thrown final stop persistence leaves a recoverable stopping owner and returns a closed code', async () => {
  const fixture = coordinatorFixture({
    leaseStoreOverrides: {
      async completeStop() { throw new Error('session storage failed after clear'); },
    },
  });
  const claimed = await claimActive(fixture, target, 'reader', consumer);
  fixture.runtimeCalls.length = 0;
  const result = await fixture.coordinator.stop({
    leaseId: claimed.lease.leaseId,
    consumer,
    explicit: true,
  });
  assert.deepEqual(result, { ok: false, code: 'PERSONA_STATE_FAILED' });
  assert.equal((await fixture.leaseStore.findOwner(target)).state, 'stopping');
  assert.deepEqual(fixture.runtimeCalls.map(call => call.op), ['clear']);
  assert.equal(fixture.scheduleCalls.length >= 2, true);
});

test('locked revocation clears and attempts terminal revoke when beginStop throws', async () => {
  let throwBegin = false;
  const fixture = coordinatorFixture({
    leaseStoreOverrides: {
      async beginStop(...args) {
        if (throwBegin) throw new Error('uncertain stopping transition');
        return fixture.leaseStore.beginStop(...args);
      },
    },
  });
  await claimActive(fixture, target, 'reader', consumer);
  throwBegin = true;
  fixture.runtimeCalls.length = 0;
  const result = await fixture.targetQueue.withTarget(target, lock =>
    fixture.coordinator.revokeTargetLocked({ target, reason: 'audit-start', lock }));
  assert.deepEqual(result, { ok: false, code: 'PERSONA_STATE_FAILED' });
  assert.equal(await fixture.leaseStore.findOwner(target), null);
  assert.deepEqual(fixture.runtimeCalls.map(call => call.op), ['clear']);
});

test('successful locked revocation returns the exact cleanup-barrier envelope', async () => {
  const fixture = coordinatorFixture();
  await claimActive(fixture, target, 'reader', consumer);
  fixture.runtimeCalls.length = 0;
  const result = await fixture.targetQueue.withTarget(target, lock =>
    fixture.coordinator.revokeTargetLocked({ target, reason: 'audit-start', lock }));
  assert.deepEqual(result, { ok: true, state: 'revoked' });
  assert.equal(await fixture.leaseStore.findOwner(target), null);
  assert.deepEqual(fixture.runtimeCalls.map(call => call.op), ['clear']);
});

test('locked revocation confirms exact runtime cleanup before reporting an absent owner', async () => {
  const fixture = coordinatorFixture();

  const absent = await fixture.targetQueue.withTarget(target, lock =>
    fixture.coordinator.revokeTargetLocked({ target, reason: 'audit-start', lock }));
  assert.deepEqual(absent, { ok: true, state: 'absent' });
  assert.deepEqual(fixture.runtimeCalls, [{ target, op: 'clear' }]);

  fixture.runtimeCalls.length = 0;
  fixture.runtimeQueue.push({ ok: false, reason: 'cleanup-unconfirmed' });
  const unconfirmed = await fixture.targetQueue.withTarget(target, lock =>
    fixture.coordinator.revokeTargetLocked({ target, reason: 'audit-start', lock }));
  assert.deepEqual(unconfirmed, { ok: false, code: 'PERSONA_CLEANUP_UNCONFIRMED' });
  assert.deepEqual(fixture.runtimeCalls, [{ target, op: 'clear' }]);
});

test('locked revocation clears a known target when owner storage cannot be read', async () => {
  let rejectReads = false;
  const fixture = coordinatorFixture({
    leaseStoreOverrides: {
      async findOwner(...args) {
        if (rejectReads) throw new Error('lease registry unavailable');
        return fixture.leaseStore.findOwner(...args);
      },
    },
  });
  await claimActive(fixture, target, 'reader', consumer);
  rejectReads = true;
  fixture.runtimeCalls.length = 0;
  const result = await fixture.targetQueue.withTarget(target, lock =>
    fixture.coordinator.revokeTargetLocked({ target, reason: 'audit-start', lock }));
  assert.deepEqual(result, { ok: false, code: 'PERSONA_STATE_FAILED' });
  assert.deepEqual(fixture.runtimeCalls.map(call => call.op), ['clear']);
  rejectReads = false;
  assert.equal((await fixture.leaseStore.findOwner(target)).state, 'active');
});

test('rehydrate requires the same live document and mode while preserving expiry', async () => {
  const fixture = coordinatorFixture();
  const claimed = await claimActive(fixture, target, 'reader', consumer);
  fixture.runtimeCalls.length = 0;
  const result = await fixture.targetQueue.withTarget(target, lock => fixture.coordinator.rehydrateLocked({
    target,
    consumer: reopenedConsumer,
    lock,
  }));
  assert.equal(result.ok, true);
  assert.equal(result.lease.expiresAt, claimed.lease.expiresAt);
  assert.equal(result.lease.consumer.documentId, reopenedConsumer.documentId);
  assert.deepEqual(fixture.runtimeCalls.map(call => call.op), ['inspect']);
});

test('rehydrate clears and revokes an owner whose injected mode no longer matches', async () => {
  const fixture = coordinatorFixture();
  await claimActive(fixture, target, 'reader', consumer);
  fixture.runtimeCalls.length = 0;
  fixture.runtimeQueue.push(
    { ok: true, documentId: target.documentId, frameId: 0, mode: 'motor' },
    { ok: true, documentId: target.documentId, frameId: 0, mode: null },
  );
  const result = await fixture.targetQueue.withTarget(target, lock => fixture.coordinator.rehydrateLocked({
    target,
    consumer: reopenedConsumer,
    lock,
  }));
  assert.deepEqual(result, { ok: false, code: 'PERSONA_RUNTIME_MISMATCH' });
  assert.equal(await fixture.leaseStore.findOwner(target), null);
  assert.deepEqual(fixture.runtimeCalls.map(call => call.op), ['inspect', 'clear']);
});

test('rehydrate never transfers ownership when navigation wins after runtime inspection', async () => {
  const fixture = coordinatorFixture();
  await claimActive(fixture, target, 'reader', consumer);
  fixture.runtimeCalls.length = 0;
  fixture.proofQueue.push(target, { ...target, documentId: 'reloaded-document' });
  const result = await fixture.targetQueue.withTarget(target, lock => fixture.coordinator.rehydrateLocked({
    target,
    consumer: reopenedConsumer,
    lock,
  }));
  assert.deepEqual(result, { ok: false, code: 'PERSONA_TARGET_CHANGED' });
  assert.equal(await fixture.leaseStore.findOwner(target), null);
  assert.deepEqual(fixture.runtimeCalls.map(call => call.op), ['inspect', 'clear']);
});

test('rehydrate revokes when the lease expires during its live runtime inspection', async () => {
  const fixture = coordinatorFixture();
  await claimActive(fixture, target, 'reader', consumer);
  fixture.runtimeCalls.length = 0;
  fixture.advance(30 * 60_000 - 1);
  fixture.beforeRuntimeApply(async input => {
    if (input.op === 'inspect') fixture.advance(1);
  });
  const result = await fixture.targetQueue.withTarget(target, lock => fixture.coordinator.rehydrateLocked({
    target,
    consumer: reopenedConsumer,
    lock,
  }));
  assert.deepEqual(result, { ok: false, code: 'PERSONA_EXPIRED' });
  assert.equal(await fixture.leaseStore.findOwner(target), null);
  assert.deepEqual(fixture.runtimeCalls.map(call => call.op), ['inspect', 'clear']);
});

test('a rehydrate that persists then throws clears and revokes the live runtime', async () => {
  let throwAfterRehydrate = false;
  const fixture = coordinatorFixture({
    leaseStoreOverrides: {
      async rehydrate(...args) {
        const rehydrated = await fixture.leaseStore.rehydrate(...args);
        if (throwAfterRehydrate) throw new Error('session storage answered after consumer transfer');
        return rehydrated;
      },
    },
  });
  await claimActive(fixture, target, 'reader', consumer);
  throwAfterRehydrate = true;
  fixture.runtimeCalls.length = 0;
  const result = await fixture.targetQueue.withTarget(target, lock => fixture.coordinator.rehydrateLocked({
    target,
    consumer: reopenedConsumer,
    lock,
  }));
  assert.deepEqual(result, { ok: false, code: 'PERSONA_STATE_FAILED' });
  assert.equal(await fixture.leaseStore.findOwner(target), null);
  assert.deepEqual(fixture.runtimeCalls.map(call => call.op), ['inspect', 'clear']);
});

test('a rejected rehydrate clears and revokes a lease that expired at the store boundary', async () => {
  let rejectRehydrate = false;
  const fixture = coordinatorFixture({
    leaseStoreOverrides: {
      async rehydrate(...args) {
        if (rejectRehydrate) {
          rejectRehydrate = false;
          return { ok: false, code: 'PERSONA_EXPIRED' };
        }
        return fixture.leaseStore.rehydrate(...args);
      },
    },
  });
  await claimActive(fixture, target, 'reader', consumer);
  rejectRehydrate = true;
  fixture.runtimeCalls.length = 0;
  const result = await fixture.targetQueue.withTarget(target, lock => fixture.coordinator.rehydrateLocked({
    target,
    consumer: reopenedConsumer,
    lock,
  }));
  assert.deepEqual(result, { ok: false, code: 'PERSONA_EXPIRED' });
  assert.equal(await fixture.leaseStore.findOwner(target), null);
  assert.deepEqual(fixture.runtimeCalls.map(call => call.op), ['inspect', 'clear']);
});

test('recover never installs: it clears prepared records and revokes active runtime mismatches', async () => {
  const fixture = coordinatorFixture();
  await prepareDirect(fixture, target, consumer, 'reader');
  await activateDirect(fixture, secondTarget, consumerFor(secondTarget), 'motor');
  fixture.runtimeModes.set(secondTarget.documentId, 'reader');

  const result = await fixture.coordinator.recover();
  assert.equal(result.ok, true);
  assert.equal(await fixture.leaseStore.findOwner(target), null);
  assert.equal(await fixture.leaseStore.findOwner(secondTarget), null);
  assert.equal(fixture.runtimeCalls.some(call => call.op === 'install'), false);
  assert.deepEqual(fixture.runtimeCalls.map(call => call.op), ['clear', 'inspect', 'clear']);
});

test('recover rechecks expiry after inspection instead of preserving a lease that crossed its deadline', async () => {
  const fixture = coordinatorFixture();
  await claimActive(fixture, target, 'reader', consumer);
  fixture.runtimeCalls.length = 0;
  fixture.advance(30 * 60_000 - 1);
  fixture.beforeRuntimeApply(async input => {
    if (input.op === 'inspect') fixture.advance(1);
  });
  const result = await fixture.coordinator.recover();
  assert.equal(result.ok, true);
  assert.equal(await fixture.leaseStore.findOwner(target), null);
  assert.deepEqual(fixture.runtimeCalls.map(call => call.op), ['inspect', 'clear']);
});

test('recover treats a future-dated lease after clock regression as due instead of scheduling it far ahead', async () => {
  const futureNow = 315_360_001_000;
  const fixture = coordinatorFixture({ now: futureNow });
  await claimActive(fixture, target, 'reader', consumer);
  fixture.runtimeCalls.length = 0;
  fixture.setNow(1_000);

  const result = await fixture.coordinator.recover();

  assert.equal(result.ok, true);
  assert.equal(await fixture.leaseStore.findOwner(target), null);
  assert.deepEqual(fixture.runtimeCalls.map(call => call.op), ['clear']);
  assert.equal(fixture.scheduleCalls.at(-1), null);
});

test('recover continues after one target throws and aggregates a closed failure after later cleanup', async () => {
  let throwForFirst = false;
  const fixture = coordinatorFixture({
    leaseStoreOverrides: {
      async findOwner(receivedTarget) {
        if (throwForFirst && receivedTarget.documentId === target.documentId) {
          throw new Error('first target storage read failed');
        }
        return fixture.leaseStore.findOwner(receivedTarget);
      },
    },
  });
  await activateDirect(fixture, target, consumer, 'reader');
  await prepareDirect(fixture, secondTarget, consumerFor(secondTarget), 'motor');
  throwForFirst = true;

  const result = await fixture.coordinator.recover();

  assert.deepEqual(result, {
    ok: false, code: 'PERSONA_STATE_FAILED', processed: 2, revoked: 1, retained: 0,
  });
  throwForFirst = false;
  assert.notEqual(await fixture.leaseStore.findOwner(target), null);
  assert.equal(await fixture.leaseStore.findOwner(secondTarget), null);
  assert.deepEqual(fixture.runtimeCalls.map(call => call.target.documentId), [secondTarget.documentId]);
});

test('invalid-registry recovery resets only after every recognizable target is confirmed clear', async () => {
  const recoverable = coordinatorFixture();
  await claimActive(recoverable, target, 'reader', consumer);
  recoverable.runtimeCalls.length = 0;
  recoverable.sessionArea.data[REGISTRY_KEY].ownerByTarget = Object.create(null);

  const recovered = await recoverable.coordinator.recover();

  assert.deepEqual(recovered, { ok: true, processed: 1, revoked: 1, retained: 0 });
  assert.deepEqual(recoverable.runtimeCalls, [{ target, op: 'clear' }]);
  assert.deepEqual(await recoverable.leaseStore.snapshot(), {
    version: 1, leases: {}, ownerByTarget: {},
  });

  const unrecognizable = coordinatorFixture();
  await claimActive(unrecognizable, target, 'reader', consumer);
  await claimActive(unrecognizable, secondTarget, 'motor', consumerFor(secondTarget));
  unrecognizable.runtimeCalls.length = 0;
  const malformedLease = Object.values(unrecognizable.sessionArea.data[REGISTRY_KEY].leases)
    .find(lease => lease.target.documentId === secondTarget.documentId);
  malformedLease.target.documentId = '';
  const malformedBefore = unrecognizable.sessionArea.data[REGISTRY_KEY];

  assert.deepEqual(await unrecognizable.coordinator.recover(), {
    ok: false, code: 'PERSONA_STATE_FAILED',
  });
  assert.deepEqual(unrecognizable.runtimeCalls, [{ target, op: 'clear' }]);
  assert.strictEqual(unrecognizable.sessionArea.data[REGISTRY_KEY], malformedBefore);

  const unconfirmed = coordinatorFixture();
  await claimActive(unconfirmed, target, 'reader', consumer);
  await claimActive(unconfirmed, secondTarget, 'motor', consumerFor(secondTarget));
  unconfirmed.runtimeCalls.length = 0;
  unconfirmed.sessionArea.data[REGISTRY_KEY].ownerByTarget = Object.create(null);
  const unconfirmedBefore = unconfirmed.sessionArea.data[REGISTRY_KEY];
  unconfirmed.runtimeQueue.push({ ok: false, reason: 'cleanup-unconfirmed' });

  assert.deepEqual(await unconfirmed.coordinator.recover(), {
    ok: false, code: 'PERSONA_CLEANUP_UNCONFIRMED',
  });
  assert.deepEqual(unconfirmed.runtimeCalls.map(call => call.target.documentId), [
    target.documentId, secondTarget.documentId,
  ]);
  assert.strictEqual(unconfirmed.sessionArea.data[REGISTRY_KEY], unconfirmedBefore);
});

test('invalid-registry cleanup runs outside the serialized lease-store section', async () => {
  const fixture = coordinatorFixture();
  await claimActive(fixture, target, 'reader', consumer);
  fixture.runtimeCalls.length = 0;
  fixture.sessionArea.data[REGISTRY_KEY].ownerByTarget = Object.create(null);
  fixture.beforeRuntimeApply(async input => {
    if (input.op !== 'clear') return;
    const concurrentRead = fixture.leaseStore.listExpired().then(
      () => 'settled',
      () => 'settled',
    );
    const state = await Promise.race([
      concurrentRead,
      new Promise(resolve => setImmediate(() => resolve('blocked'))),
    ]);
    assert.equal(state, 'settled');
  });

  assert.deepEqual(await fixture.coordinator.recover(), {
    ok: true, processed: 1, revoked: 1, retained: 0,
  });
  assert.equal(Object.keys((await fixture.leaseStore.snapshot()).leases).length, 0);
});

test('invalid-registry finalize fails closed when the prepared envelope changes during cleanup', async () => {
  const fixture = coordinatorFixture();
  await claimActive(fixture, target, 'reader', consumer);
  fixture.runtimeCalls.length = 0;
  fixture.sessionArea.data[REGISTRY_KEY].ownerByTarget = Object.create(null);
  const concurrentReplacement = {
    version: 1,
    leases: Object.create(null),
    ownerByTarget: Object.create(null),
  };
  fixture.beforeRuntimeApply(async input => {
    if (input.op === 'clear') fixture.sessionArea.data[REGISTRY_KEY] = concurrentReplacement;
  });

  assert.deepEqual(await fixture.coordinator.recover(), {
    ok: false, code: 'PERSONA_STATE_FAILED',
  });
  assert.strictEqual(fixture.sessionArea.data[REGISTRY_KEY], concurrentReplacement);
});

test('owner-key A pointing to lease target B clears both candidates and can never authorize reset', async () => {
  const fixture = coordinatorFixture();
  const claimed = await claimActive(fixture, secondTarget, 'motor', consumerFor(secondTarget));
  fixture.runtimeCalls.length = 0;
  fixture.runtimeModes.set(target.documentId, 'reader');
  const registry = fixture.sessionArea.data[REGISTRY_KEY];
  registry.ownerByTarget = Object.create(null);
  registry.ownerByTarget[`${target.tabId}\u0000${target.documentId}`] = claimed.lease.leaseId;
  const registryBefore = registry;

  assert.deepEqual(await fixture.coordinator.recover(), {
    ok: false, code: 'PERSONA_STATE_FAILED',
  });
  assert.deepEqual(fixture.runtimeCalls.map(call => [
    call.target.tabId, call.target.documentId, call.op,
  ]), [
    [secondTarget.tabId, secondTarget.documentId, 'clear'],
    [target.tabId, target.documentId, 'clear'],
  ]);
  assert.equal(fixture.runtimeModes.get(secondTarget.documentId), null);
  assert.equal(fixture.runtimeModes.get(target.documentId), null);
  assert.strictEqual(fixture.sessionArea.data[REGISTRY_KEY], registryBefore);
});

test('expireDue clears only leases due according to the lease-store clock and reschedules the nearest owner', async () => {
  const fixture = coordinatorFixture();
  await claimActive(fixture, target, 'reader', consumer);
  fixture.advance(30 * 60_000);
  const result = await fixture.coordinator.expireDue();
  assert.equal(result.ok, true);
  assert.equal(await fixture.leaseStore.findOwner(target), null);
  assert.equal(fixture.runtimeCalls.at(-1).op, 'clear');
  assert.equal(fixture.scheduleCalls.at(-1), null);
});

test('tab and window invalidation clear and revoke exactly the matching owners', async () => {
  const fixture = coordinatorFixture();
  await claimActive(fixture, target, 'reader', consumer);
  await claimActive(fixture, secondTarget, 'motor', consumerFor(secondTarget));
  fixture.runtimeCalls.length = 0;

  assert.equal((await fixture.coordinator.invalidateTab(target.tabId, 'navigation')).ok, true);
  assert.equal(await fixture.leaseStore.findOwner(target), null);
  assert.notEqual(await fixture.leaseStore.findOwner(secondTarget), null);
  assert.deepEqual(fixture.runtimeCalls.map(call => call.target.tabId), [target.tabId]);

  fixture.runtimeCalls.length = 0;
  assert.equal((await fixture.coordinator.invalidateWindow(secondTarget.windowId, 'window-changed')).ok, true);
  assert.equal(await fixture.leaseStore.findOwner(secondTarget), null);
  assert.deepEqual(fixture.runtimeCalls.map(call => call.target.tabId), [secondTarget.tabId]);
});

test('window invalidation continues after one target throws and revokes later matching owners', async () => {
  let throwForFirst = false;
  const fixture = coordinatorFixture({
    targetQueueFactory(base) {
      return {
        assertHeld: (...args) => base.assertHeld(...args),
        async withTarget(receivedTarget, operation) {
          if (throwForFirst && receivedTarget.documentId === target.documentId) {
            throw new Error('first matching target queue failed');
          }
          return base.withTarget(receivedTarget, operation);
        },
      };
    },
  });
  await activateDirect(fixture, target, consumer, 'reader');
  await activateDirect(fixture, sameWindowTarget, consumerFor(sameWindowTarget), 'motor');
  throwForFirst = true;

  const result = await fixture.coordinator.invalidateWindow(target.windowId, 'window-changed');

  assert.deepEqual(result, {
    ok: false, code: 'PERSONA_STATE_FAILED', processed: 2, revoked: 1,
  });
  throwForFirst = false;
  assert.notEqual(await fixture.leaseStore.findOwner(target), null);
  assert.equal(await fixture.leaseStore.findOwner(sameWindowTarget), null);
  assert.deepEqual(fixture.runtimeCalls.map(call => call.target.documentId), [sameWindowTarget.documentId]);
});

test('a live cleanup failure during invalidation remains recoverable and blocks release', async () => {
  const fixture = coordinatorFixture();
  await claimActive(fixture, target, 'reader', consumer);
  fixture.runtimeQueue.push({ ok: false, reason: 'runtime-error' });
  const result = await fixture.coordinator.invalidateTab(target.tabId, 'navigation');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'PERSONA_CLEANUP_UNCONFIRMED');
  assert.equal((await fixture.leaseStore.findOwner(target)).state, 'stopping');
});
