import assert from 'node:assert/strict';
import test from 'node:test';

import { createPersonaLeaseStore } from '../../src/background/persona-lease-store.js';
import { createFakeLockManager } from './fake-lock-manager.js';

const REGISTRY_KEY = 'audita:persona-leases:v1';
const STORE_LOCK_NAME = 'audita:persona-lease-store:v1';
const TTL_MS = 30 * 60_000;
const target = Object.freeze({
  tabId: 7,
  windowId: 3,
  documentId: 'document-main',
  urlSessionDigest: `hmac-sha256:${'A'.repeat(43)}`,
});
const otherTarget = Object.freeze({
  ...target,
  tabId: 8,
  documentId: 'document-other',
  urlSessionDigest: `hmac-sha256:${'B'.repeat(43)}`,
});
const panelA = Object.freeze({
  extensionId: 'abcdefghijklmnopabcdefghijklmnop',
  documentId: 'side-panel-document-a',
  path: '/src/panel/index.html',
  windowId: 3,
});
const panelB = Object.freeze({ ...panelA, documentId: 'side-panel-document-b' });

function createSessionArea(initial = {}) {
  let values = structuredClone(initial);
  const writes = [];
  return {
    writes,
    async get(key) {
      if (key !== REGISTRY_KEY) throw new TypeError('unexpected storage key');
      return Object.hasOwn(values, key) ? { [key]: structuredClone(values[key]) } : {};
    },
    async set(entries) {
      writes.push(structuredClone(entries));
      values = { ...values, ...structuredClone(entries) };
    },
    inspect() {
      return structuredClone(values);
    },
    replace(next) {
      values = structuredClone(next);
    },
  };
}

function createClock(value = 1_000) {
  return { value };
}

function createDeterministicRandom() {
  let sequence = 0;
  const requested = [];
  const randomBytes = length => {
    requested.push(length);
    sequence += 1;
    return Uint8Array.from({ length }, (_, index) => (sequence * 17 + index) % 256);
  };
  randomBytes.requested = requested;
  return randomBytes;
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

function createFixture({
  initial = {},
  clock = createClock(),
  randomBytes = createDeterministicRandom(),
  lockManager = createFakeLockManager(),
} = {}) {
  const sessionArea = createSessionArea(initial);
  const store = createPersonaLeaseStore({
    sessionArea,
    now: () => clock.value,
    randomBytes,
    lockManager,
  });
  return { store, sessionArea, clock, randomBytes, lockManager };
}

function capacityLeaseId(index) {
  return `lease-${index.toString(36).padStart(22, '0')}`;
}

function createCapacityRegistry({ revoked }) {
  const leases = Object.create(null);
  const ownerByTarget = Object.create(null);
  for (let index = 0; index < 4_096; index += 1) {
    const leaseId = capacityLeaseId(index);
    const leaseTarget = {
      tabId: index + 100,
      windowId: 3,
      documentId: `capacity-document-${index}`,
      urlSessionDigest: `hmac-sha256:${'C'.repeat(43)}`,
    };
    leases[leaseId] = {
      version: 1,
      leaseId,
      target: leaseTarget,
      consumer: panelA,
      activeMode: revoked ? null : 'reader',
      pendingMode: null,
      createdAt: index,
      lastExplicitActionAt: index,
      expiresAt: index + TTL_MS,
      state: revoked ? 'revoked' : 'active',
      revision: 2,
      revokeReason: revoked ? 'recovery' : null,
    };
    if (!revoked) ownerByTarget[`${leaseTarget.tabId}\u0000${leaseTarget.documentId}`] = leaseId;
  }
  return { version: 1, leases, ownerByTarget };
}

async function prepareAndActivate(store, mode = 'reader', selectedTarget = target, consumer = panelA) {
  const prepared = await store.claimPrepared({ target: selectedTarget, consumer, mode });
  assert.equal(prepared.ok, true);
  const active = await store.activate({
    leaseId: prepared.lease.leaseId,
    expectedRevision: prepared.lease.revision,
  });
  assert.equal(active.ok, true);
  return active.lease;
}

test('creates one exact prepared owner using 16 CSPRNG bytes and the injected clock', async () => {
  const { store, sessionArea, randomBytes } = createFixture();
  const result = await store.claimPrepared({ target, consumer: panelA, mode: 'reader' });

  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result.lease), [
    'version', 'leaseId', 'target', 'consumer', 'activeMode', 'pendingMode',
    'createdAt', 'lastExplicitActionAt', 'expiresAt', 'state', 'revision', 'revokeReason',
  ]);
  assert.match(result.lease.leaseId, /^lease-[A-Za-z0-9_-]{22}$/u);
  assert.deepEqual(randomBytes.requested, [16]);
  assert.deepEqual(result.lease.target, target);
  assert.deepEqual(result.lease.consumer, panelA);
  assert.equal(result.lease.activeMode, null);
  assert.equal(result.lease.pendingMode, 'reader');
  assert.equal(result.lease.createdAt, 1_000);
  assert.equal(result.lease.lastExplicitActionAt, 1_000);
  assert.equal(result.lease.expiresAt, 1_000 + TTL_MS);
  assert.equal(result.lease.state, 'prepared');
  assert.equal(result.lease.revision, 1);
  assert.equal(result.lease.revokeReason, null);
  assert.equal(sessionArea.writes.length, 1);
  assert.deepEqual(Object.keys(sessionArea.writes[0]), [REGISTRY_KEY]);
});

test('serializes concurrent claims to one owner per document', async () => {
  const { store } = createFixture();
  const [left, right] = await Promise.all([
    store.claimPrepared({ target, consumer: panelA, mode: 'reader' }),
    store.claimPrepared({ target, consumer: panelA, mode: 'motor' }),
  ]);
  assert.equal([left, right].filter(result => result.ok).length, 1);
  assert.deepEqual([left, right].find(result => !result.ok), {
    ok: false,
    code: 'PERSONA_CONFLICT',
  });
  const snapshot = await store.snapshot();
  assert.equal(Object.keys(snapshot.ownerByTarget).length, 1);
  assert.equal(
    Object.values(snapshot.ownerByTarget)[0],
    [left, right].find(result => result.ok).lease.leaseId,
  );
});

test('prunes the oldest revoked tombstone deterministically before a full-registry claim', async () => {
  const registry = createCapacityRegistry({ revoked: true });
  const { store, sessionArea } = createFixture({ initial: { [REGISTRY_KEY]: registry } });
  const freshTarget = {
    ...target,
    tabId: 5_000,
    documentId: 'capacity-document-new',
    urlSessionDigest: `hmac-sha256:${'D'.repeat(43)}`,
  };
  const result = await store.claimPrepared({ target: freshTarget, consumer: panelA, mode: 'motor' });

  assert.equal(result.ok, true);
  const snapshot = await store.snapshot();
  assert.equal(Object.keys(snapshot.leases).length, 4_096);
  assert.equal(Object.hasOwn(snapshot.leases, capacityLeaseId(0)), false);
  assert.equal(Object.hasOwn(snapshot.leases, capacityLeaseId(1)), true);
  assert.equal(snapshot.ownerByTarget[`5000\u0000capacity-document-new`], result.lease.leaseId);
  assert.equal(sessionArea.writes.length, 1);
});

test('breaks equal-age tombstone ties by locale-independent leaseId code units', async () => {
  const registry = createCapacityRegistry({ revoked: true });
  const lowerCodeUnitId = `lease-${'A'.repeat(22)}`;
  const localeSensitiveId = `lease-_${'A'.repeat(21)}`;
  const first = registry.leases[capacityLeaseId(0)];
  const second = registry.leases[capacityLeaseId(1)];
  delete registry.leases[capacityLeaseId(0)];
  delete registry.leases[capacityLeaseId(1)];
  registry.leases[lowerCodeUnitId] = { ...first, leaseId: lowerCodeUnitId };
  registry.leases[localeSensitiveId] = {
    ...second,
    leaseId: localeSensitiveId,
    createdAt: first.createdAt,
    lastExplicitActionAt: first.lastExplicitActionAt,
    expiresAt: first.expiresAt,
  };
  const { store } = createFixture({ initial: { [REGISTRY_KEY]: registry } });
  const result = await store.claimPrepared({
    target: {
      ...target,
      tabId: 5_000,
      documentId: 'capacity-document-new',
      urlSessionDigest: `hmac-sha256:${'D'.repeat(43)}`,
    },
    consumer: panelA,
    mode: 'motor',
  });

  assert.equal(result.ok, true);
  const snapshot = await store.snapshot();
  assert.equal(Object.hasOwn(snapshot.leases, lowerCodeUnitId), false);
  assert.equal(Object.hasOwn(snapshot.leases, localeSensitiveId), true);
});

test('a full registry without revoked tombstones rejects a claim without writing', async () => {
  const registry = createCapacityRegistry({ revoked: false });
  const { store, sessionArea } = createFixture({ initial: { [REGISTRY_KEY]: registry } });
  const freshTarget = {
    ...target,
    tabId: 5_000,
    documentId: 'capacity-document-new',
    urlSessionDigest: `hmac-sha256:${'D'.repeat(43)}`,
  };
  assert.deepEqual(await store.claimPrepared({ target: freshTarget, consumer: panelA, mode: 'motor' }), {
    ok: false,
    code: 'PERSONA_CONFLICT',
  });
  assert.equal(sessionArea.writes.length, 0);
});

test('fails closed on a CSPRNG identifier collision without replacing either owner', async () => {
  const sessionArea = createSessionArea();
  const randomBytes = length => new Uint8Array(length).fill(9);
  const store = createPersonaLeaseStore({
    sessionArea,
    lockManager: createFakeLockManager(),
    now: () => 1_000,
    randomBytes,
  });
  const first = await store.claimPrepared({ target, consumer: panelA, mode: 'reader' });
  await assert.rejects(
    () => store.claimPrepared({ target: otherTarget, consumer: panelA, mode: 'motor' }),
    /PERSONA_LEASE_ID_COLLISION/u,
  );

  assert.equal((await store.findOwner(target)).leaseId, first.lease.leaseId);
  assert.equal(await store.findOwner(otherTarget), null);
  assert.equal(sessionArea.writes.length, 1);
});

test('uses only the injected clock and rehydrate does not renew', async () => {
  const clock = createClock(1_000);
  const { store } = createFixture({ clock });
  const prepared = await store.claimPrepared({ target, consumer: panelA, mode: 'reader' });
  const active = await store.activate({
    leaseId: prepared.lease.leaseId,
    expectedRevision: prepared.lease.revision,
  });
  assert.equal(active.lease.expiresAt, 1_801_000);
  clock.value = 900_000;
  const rehydrated = await store.rehydrate({ target, consumer: panelB });
  assert.equal(rehydrated.ok, true);
  assert.equal(rehydrated.lease.expiresAt, 1_801_000);
  assert.equal(rehydrated.lease.lastExplicitActionAt, 1_000);
  assert.deepEqual(rehydrated.lease.consumer, panelB);
  assert.equal(rehydrated.lease.revision, active.lease.revision + 1);
});

test('rehydrate requires the exact stored window and URL HMAC for the target', async () => {
  const { store, sessionArea } = createFixture();
  const lease = await prepareAndActivate(store);
  const writesBefore = sessionArea.writes.length;

  for (const [forgedTarget, forgedConsumer] of [
    [{ ...target, windowId: target.windowId + 1 }, { ...panelB, windowId: target.windowId + 1 }],
    [{ ...target, urlSessionDigest: `hmac-sha256:${'Z'.repeat(43)}` }, panelB],
  ]) {
    assert.deepEqual(await store.rehydrate({ target: forgedTarget, consumer: forgedConsumer }), {
      ok: false,
      code: 'PERSONA_TARGET_MISMATCH',
    });
  }
  assert.equal((await store.findOwner(target)).leaseId, lease.leaseId);
  assert.equal(sessionArea.writes.length, writesBefore);
});

test('findOwner returns a lease only for the complete stored target proof', async () => {
  const { store } = createFixture();
  const lease = await prepareAndActivate(store);

  assert.equal((await store.findOwner(target)).leaseId, lease.leaseId);
  assert.equal(await store.findOwner({ ...target, windowId: target.windowId + 1 }), null);
  assert.equal(await store.findOwner({
    ...target,
    urlSessionDigest: `hmac-sha256:${'Z'.repeat(43)}`,
  }), null);
});

test('activate promotes the prepared mode without changing its timestamps', async () => {
  const { store, clock } = createFixture();
  const prepared = await store.claimPrepared({ target, consumer: panelA, mode: 'achromatopsia' });
  clock.value = 50_000;
  const active = await store.activate({
    leaseId: prepared.lease.leaseId,
    expectedRevision: prepared.lease.revision,
  });

  assert.equal(active.ok, true);
  assert.equal(active.lease.state, 'active');
  assert.equal(active.lease.activeMode, 'achromatopsia');
  assert.equal(active.lease.pendingMode, null);
  assert.equal(active.lease.createdAt, 1_000);
  assert.equal(active.lease.lastExplicitActionAt, 1_000);
  assert.equal(active.lease.expiresAt, 1_801_000);
  assert.equal(active.lease.revision, 2);
});

test('commits a pending mode using a fresh internal action time', async () => {
  const { store, clock } = createFixture();
  const lease = await prepareAndActivate(store);
  clock.value = 20_000;
  const changing = await store.beginSetMode({
    leaseId: lease.leaseId,
    consumer: panelA,
    mode: 'motor',
  });
  assert.equal(changing.ok, true);
  assert.equal(changing.lease.activeMode, 'reader');
  assert.equal(changing.lease.pendingMode, 'motor');
  assert.equal(changing.lease.expiresAt, 1_801_000);

  clock.value = 40_000;
  const committed = await store.commitSetMode({
    leaseId: lease.leaseId,
    expectedRevision: changing.lease.revision,
  });
  assert.equal(committed.ok, true);
  assert.equal(committed.lease.activeMode, 'motor');
  assert.equal(committed.lease.pendingMode, null);
  assert.equal(committed.lease.lastExplicitActionAt, 40_000);
  assert.equal(committed.lease.expiresAt, 40_000 + TTL_MS);
});

test('a revision-matched successful commit renews even when runtime work crossed the old deadline', async () => {
  const { store, clock } = createFixture();
  const lease = await prepareAndActivate(store);
  const changing = await store.beginSetMode({
    leaseId: lease.leaseId,
    consumer: panelA,
    mode: 'motor',
  });
  clock.value = lease.expiresAt + 1;
  const committed = await store.commitSetMode({
    leaseId: lease.leaseId,
    expectedRevision: changing.lease.revision,
  });

  assert.equal(committed.ok, true);
  assert.equal(committed.lease.activeMode, 'motor');
  assert.equal(committed.lease.lastExplicitActionAt, clock.value);
  assert.equal(committed.lease.expiresAt, clock.value + TTL_MS);
});

test('a regressed clock cannot create non-monotonic commit or stop timestamps', async () => {
  const { store, clock, sessionArea } = createFixture();
  const lease = await prepareAndActivate(store);
  const changing = await store.beginSetMode({
    leaseId: lease.leaseId,
    consumer: panelA,
    mode: 'motor',
  });
  clock.value = lease.lastExplicitActionAt - 1;
  const writesBeforeCommit = sessionArea.writes.length;
  await assert.rejects(() => store.commitSetMode({
    leaseId: lease.leaseId,
    expectedRevision: changing.lease.revision,
  }), /PERSONA_CLOCK_INVALID/u);
  assert.equal(sessionArea.writes.length, writesBeforeCommit);

  const restored = await store.rollbackSetMode({
    leaseId: lease.leaseId,
    expectedRevision: changing.lease.revision,
  });
  clock.value = restored.lease.lastExplicitActionAt;
  const stopping = await store.beginStop({
    leaseId: restored.lease.leaseId,
    consumer: panelA,
    explicit: true,
  });
  clock.value = restored.lease.lastExplicitActionAt - 1;
  const writesBeforeStop = sessionArea.writes.length;
  await assert.rejects(() => store.completeStop({
    leaseId: stopping.lease.leaseId,
    expectedRevision: stopping.lease.revision,
    explicit: true,
  }), /PERSONA_CLOCK_INVALID/u);
  assert.equal(sessionArea.writes.length, writesBeforeStop);
});

test('rolls back a pending mode without renewing or changing the active mode', async () => {
  const { store, clock } = createFixture();
  const lease = await prepareAndActivate(store);
  const originalExpiry = lease.expiresAt;
  const changing = await store.beginSetMode({
    leaseId: lease.leaseId,
    consumer: panelA,
    mode: 'motor',
  });
  clock.value += 20_000;
  const restored = await store.rollbackSetMode({
    leaseId: lease.leaseId,
    expectedRevision: changing.lease.revision,
  });
  assert.equal(restored.ok, true);
  assert.equal(restored.lease.activeMode, 'reader');
  assert.equal(restored.lease.pendingMode, null);
  assert.equal(restored.lease.lastExplicitActionAt, 1_000);
  assert.equal(restored.lease.expiresAt, originalExpiry);
});

test('rollback remains available after expiry so a failed runtime change is recoverable', async () => {
  const { store, clock } = createFixture();
  const lease = await prepareAndActivate(store);
  const changing = await store.beginSetMode({
    leaseId: lease.leaseId,
    consumer: panelA,
    mode: 'motor',
  });
  clock.value = lease.expiresAt + 1;
  const restored = await store.rollbackSetMode({
    leaseId: lease.leaseId,
    expectedRevision: changing.lease.revision,
  });

  assert.equal(restored.ok, true);
  assert.equal(restored.lease.activeMode, 'reader');
  assert.equal(restored.lease.pendingMode, null);
  assert.equal(restored.lease.expiresAt, lease.expiresAt);
  assert.equal((await store.listExpired())[0].leaseId, lease.leaseId);
});

test('does not rehydrate an in-flight mode transition and internal cleanup clears it', async () => {
  const { store, sessionArea } = createFixture();
  const lease = await prepareAndActivate(store);
  const changing = await store.beginSetMode({
    leaseId: lease.leaseId,
    consumer: panelA,
    mode: 'motor',
  });
  const writesBefore = sessionArea.writes.length;

  assert.deepEqual(await store.rehydrate({ target, consumer: panelB }), {
    ok: false,
    code: 'PERSONA_TRANSITION_INVALID',
  });
  assert.equal(sessionArea.writes.length, writesBefore);

  const stopping = await store.beginStop({
    leaseId: changing.lease.leaseId,
    consumer: null,
    explicit: false,
  });
  assert.equal(stopping.ok, true);
  assert.equal(stopping.lease.state, 'stopping');
  assert.equal(stopping.lease.activeMode, 'reader');
  assert.equal(stopping.lease.pendingMode, null);
});

test('explicit stop requires the consumer and renews only after confirmed completion', async () => {
  const { store, clock } = createFixture();
  const lease = await prepareAndActivate(store);
  clock.value = 20_000;
  const stopping = await store.beginStop({
    leaseId: lease.leaseId,
    consumer: panelA,
    explicit: true,
  });
  assert.equal(stopping.ok, true);
  assert.equal(stopping.lease.state, 'stopping');
  assert.equal(stopping.lease.activeMode, 'reader');
  assert.equal(stopping.lease.expiresAt, lease.expiresAt);

  clock.value = 30_000;
  const stopped = await store.completeStop({
    leaseId: lease.leaseId,
    expectedRevision: stopping.lease.revision,
    explicit: true,
  });
  assert.equal(stopped.ok, true);
  assert.equal(stopped.lease.state, 'active');
  assert.equal(stopped.lease.activeMode, null);
  assert.equal(stopped.lease.pendingMode, null);
  assert.equal(stopped.lease.lastExplicitActionAt, 30_000);
  assert.equal(stopped.lease.expiresAt, 30_000 + TTL_MS);
});

test('an explicitly stopped lease can safely start and commit a new mode', async () => {
  const { store, clock } = createFixture();
  const lease = await prepareAndActivate(store);
  const stopping = await store.beginStop({
    leaseId: lease.leaseId,
    consumer: panelA,
    explicit: true,
  });
  const stopped = await store.completeStop({
    leaseId: lease.leaseId,
    expectedRevision: stopping.lease.revision,
    explicit: true,
  });
  assert.equal(stopped.lease.activeMode, null);

  const previousExpiry = stopped.lease.expiresAt;
  const restarting = await store.beginSetMode({
    leaseId: lease.leaseId,
    consumer: panelA,
    mode: 'motor',
  });
  assert.equal(restarting.ok, true);
  assert.equal(restarting.lease.activeMode, null);
  assert.equal(restarting.lease.pendingMode, 'motor');
  assert.equal(restarting.lease.expiresAt, previousExpiry);

  clock.value = stopped.lease.lastExplicitActionAt + 50_000;
  const restarted = await store.commitSetMode({
    leaseId: lease.leaseId,
    expectedRevision: restarting.lease.revision,
  });
  assert.equal(restarted.ok, true);
  assert.equal(restarted.lease.activeMode, 'motor');
  assert.equal(restarted.lease.pendingMode, null);
  assert.equal(restarted.lease.lastExplicitActionAt, clock.value);
  assert.equal(restarted.lease.expiresAt, clock.value + TTL_MS);
});

test('worker-internal stop accepts recoverable states, requires null consumer and never renews', async () => {
  const { store, clock } = createFixture();
  const prepared = await store.claimPrepared({ target, consumer: panelA, mode: 'reader' });
  clock.value = 90_000;
  const stopping = await store.beginStop({
    leaseId: prepared.lease.leaseId,
    consumer: null,
    explicit: false,
  });
  assert.equal(stopping.ok, true);
  assert.equal(stopping.lease.state, 'stopping');
  assert.equal(stopping.lease.pendingMode, null);
  assert.equal(stopping.lease.lastExplicitActionAt, prepared.lease.lastExplicitActionAt);
  assert.equal(stopping.lease.expiresAt, prepared.lease.expiresAt);

  const repeated = await store.beginStop({
    leaseId: prepared.lease.leaseId,
    consumer: null,
    explicit: false,
  });
  assert.equal(repeated.ok, true);
  assert.equal(repeated.lease.state, 'stopping');
  assert.equal(repeated.lease.revision, stopping.lease.revision + 1);

  const denied = await store.beginStop({
    leaseId: prepared.lease.leaseId,
    consumer: panelA,
    explicit: false,
  });
  assert.deepEqual(denied, { ok: false, code: 'PERSONA_CONSUMER_MISMATCH' });
});

test('recovery identifies prepared and stopping records without mutation', async () => {
  const { store, sessionArea, clock } = createFixture();
  await store.claimPrepared({ target, consumer: panelA, mode: 'reader' });
  const other = await store.claimPrepared({ target: otherTarget, consumer: panelA, mode: 'motor' });
  await store.beginStop({ leaseId: other.lease.leaseId, consumer: null, explicit: false });
  const writesBefore = sessionArea.writes.length;
  clock.value = 500_000;

  assert.deepEqual(
    (await store.listRecoverable()).map(value => value.state).sort(),
    ['prepared', 'stopping'],
  );
  assert.equal(sessionArea.writes.length, writesBefore);
});

test('lists expired owners using the injected clock without automatic cleanup', async () => {
  const { store, sessionArea, clock } = createFixture();
  const lease = await prepareAndActivate(store);
  clock.value = lease.expiresAt;
  const writesBefore = sessionArea.writes.length;

  const expired = await store.listExpired();
  assert.equal(expired.length, 1);
  assert.equal(expired[0].leaseId, lease.leaseId);
  assert.equal((await store.findOwner(target)).leaseId, lease.leaseId);
  assert.equal(sessionArea.writes.length, writesBefore);
});

test('revoke retains a closed terminal record and removes only its owner', async () => {
  const { store, sessionArea, clock } = createFixture();
  const lease = await prepareAndActivate(store);
  clock.value = 80_000;
  const revoked = await store.revoke({ leaseId: lease.leaseId, reason: 'audit-start' });

  assert.equal(revoked.ok, true);
  assert.equal(revoked.lease.state, 'revoked');
  assert.equal(revoked.lease.revokeReason, 'audit-start');
  assert.equal(revoked.lease.lastExplicitActionAt, lease.lastExplicitActionAt);
  assert.equal(revoked.lease.expiresAt, lease.expiresAt);
  assert.equal(await store.findOwner(target), null);
  const snapshot = await store.snapshot();
  assert.equal(snapshot.leases[lease.leaseId].state, 'revoked');
  assert.equal(Object.keys(snapshot.ownerByTarget).length, 0);
  assert.equal(sessionArea.writes.length, 3);
});

test('rejects wrong revisions, consumers, states and modes without persisting', async () => {
  const { store, sessionArea } = createFixture();
  const prepared = await store.claimPrepared({ target, consumer: panelA, mode: 'reader' });
  const writesAfterClaim = sessionArea.writes.length;

  assert.deepEqual(await store.commitSetMode({
    leaseId: prepared.lease.leaseId,
    expectedRevision: prepared.lease.revision,
  }), { ok: false, code: 'PERSONA_TRANSITION_INVALID' });
  assert.deepEqual(await store.activate({
    leaseId: prepared.lease.leaseId,
    expectedRevision: prepared.lease.revision + 1,
  }), { ok: false, code: 'PERSONA_REVISION_MISMATCH' });
  assert.deepEqual(await store.beginSetMode({
    leaseId: prepared.lease.leaseId,
    consumer: panelA,
    mode: 'motor',
  }), { ok: false, code: 'PERSONA_TRANSITION_INVALID' });
  assert.deepEqual(await store.beginStop({
    leaseId: prepared.lease.leaseId,
    consumer: panelA,
    explicit: true,
  }), { ok: false, code: 'PERSONA_TRANSITION_INVALID' });

  const active = await store.activate({
    leaseId: prepared.lease.leaseId,
    expectedRevision: prepared.lease.revision,
  });
  const writesAfterActivate = sessionArea.writes.length;
  assert.deepEqual(await store.beginSetMode({
    leaseId: active.lease.leaseId,
    consumer: panelB,
    mode: 'motor',
  }), { ok: false, code: 'PERSONA_CONSUMER_MISMATCH' });
  assert.deepEqual(await store.beginSetMode({
    leaseId: active.lease.leaseId,
    consumer: panelA,
    mode: 'reader',
  }), { ok: false, code: 'PERSONA_TRANSITION_INVALID' });
  assert.equal(writesAfterClaim, 1);
  assert.equal(writesAfterActivate, 2);
  assert.equal(sessionArea.writes.length, writesAfterActivate);
});

test('expired owners fail closed and remain available for cleanup', async () => {
  const { store, clock, sessionArea } = createFixture();
  const lease = await prepareAndActivate(store);
  clock.value = lease.expiresAt;
  const writesBefore = sessionArea.writes.length;

  assert.deepEqual(await store.rehydrate({ target, consumer: panelB }), {
    ok: false,
    code: 'PERSONA_EXPIRED',
  });
  assert.deepEqual(await store.beginSetMode({
    leaseId: lease.leaseId,
    consumer: panelA,
    mode: 'motor',
  }), { ok: false, code: 'PERSONA_EXPIRED' });
  assert.equal(sessionArea.writes.length, writesBefore);

  const stopping = await store.beginStop({
    leaseId: lease.leaseId,
    consumer: null,
    explicit: false,
  });
  assert.equal(stopping.ok, true);
  assert.equal(stopping.lease.state, 'stopping');
});

test('future-dated leases deny runtime authorization without blocking conservative cleanup', async () => {
  const futureActionAt = 315_360_001_000;

  const preparedFixture = createFixture({ clock: createClock(futureActionAt) });
  const prepared = await preparedFixture.store.claimPrepared({
    target,
    consumer: panelA,
    mode: 'reader',
  });
  assert.equal(prepared.lease.createdAt, futureActionAt);
  assert.equal(prepared.lease.lastExplicitActionAt, futureActionAt);
  assert.equal(prepared.lease.expiresAt, 315_361_801_000);
  preparedFixture.clock.value = 1_000;
  const preparedWrites = preparedFixture.sessionArea.writes.length;
  assert.deepEqual(await preparedFixture.store.activate({
    leaseId: prepared.lease.leaseId,
    expectedRevision: prepared.lease.revision,
  }), { ok: false, code: 'PERSONA_EXPIRED' });
  assert.equal(preparedFixture.sessionArea.writes.length, preparedWrites);

  const activeFixture = createFixture({ clock: createClock(futureActionAt) });
  const active = await prepareAndActivate(activeFixture.store);
  activeFixture.clock.value = 1_000;
  const activeWrites = activeFixture.sessionArea.writes.length;
  assert.deepEqual(await activeFixture.store.beginSetMode({
    leaseId: active.leaseId,
    consumer: panelA,
    mode: 'motor',
  }), { ok: false, code: 'PERSONA_EXPIRED' });
  assert.deepEqual(await activeFixture.store.rehydrate({ target, consumer: panelB }), {
    ok: false,
    code: 'PERSONA_EXPIRED',
  });
  assert.equal(activeFixture.sessionArea.writes.length, activeWrites);

  const cleanupFixture = createFixture({ clock: createClock(futureActionAt) });
  const cleanupLease = await prepareAndActivate(cleanupFixture.store);
  const pending = await cleanupFixture.store.beginSetMode({
    leaseId: cleanupLease.leaseId,
    consumer: panelA,
    mode: 'motor',
  });
  cleanupFixture.clock.value = 1_000;
  const rolledBack = await cleanupFixture.store.rollbackSetMode({
    leaseId: pending.lease.leaseId,
    expectedRevision: pending.lease.revision,
  });
  assert.equal(rolledBack.ok, true);
  const stopping = await cleanupFixture.store.beginStop({
    leaseId: rolledBack.lease.leaseId,
    consumer: null,
    explicit: false,
  });
  assert.equal(stopping.ok, true);
  const revoked = await cleanupFixture.store.revoke({
    leaseId: stopping.lease.leaseId,
    reason: 'recovery',
  });
  assert.equal(revoked.ok, true);
  assert.equal(await cleanupFixture.store.findOwner(target), null);
});

test('returns recursively frozen copies that cannot mutate storage', async () => {
  const { store } = createFixture();
  const claimed = await store.claimPrepared({ target, consumer: panelA, mode: 'reader' });
  const snapshot = await store.snapshot();

  for (const value of [
    claimed,
    claimed.lease,
    claimed.lease.target,
    claimed.lease.consumer,
    snapshot,
    snapshot.leases,
    snapshot.ownerByTarget,
    snapshot.leases[claimed.lease.leaseId],
  ]) assert.equal(Object.isFrozen(value), true);

  assert.throws(() => { claimed.lease.target.tabId = 99; }, TypeError);
  assert.throws(() => { snapshot.ownerByTarget.forged = 'lease-forged'; }, TypeError);
  assert.equal((await store.findOwner(target)).target.tabId, 7);
});

test('rejects malformed persisted registries without repair or accessor reads', async () => {
  const malformed = [
    { version: 1, leases: {}, ownerByTarget: {}, extra: true },
    { version: 2, leases: {}, ownerByTarget: {} },
    { version: 1, leases: [], ownerByTarget: {} },
    { version: 1, leases: {}, ownerByTarget: { '7\u0000document-main': 'lease-missing' } },
  ];
  for (const registry of malformed) {
    const { store, sessionArea } = createFixture({ initial: { [REGISTRY_KEY]: registry } });
    await assert.rejects(() => store.snapshot(), /PERSONA_REGISTRY_INVALID/u);
    assert.equal(sessionArea.writes.length, 0);
  }

  let reads = 0;
  const hostile = { version: 1, leases: {} };
  Object.defineProperty(hostile, 'ownerByTarget', {
    enumerable: true,
    get() {
      reads += 1;
      return {};
    },
  });
  const sessionArea = createSessionArea();
  sessionArea.get = async () => ({ [REGISTRY_KEY]: hostile });
  const store = createPersonaLeaseStore({
    sessionArea,
    lockManager: createFakeLockManager(),
    now: () => 1_000,
    randomBytes: createDeterministicRandom(),
  });
  await assert.rejects(() => store.snapshot(), /PERSONA_REGISTRY_INVALID/u);
  assert.equal(reads, 0);
});

test('validates the complete persisted lease including HMAC, monotonic time and ownership', async () => {
  const { store, sessionArea } = createFixture();
  const claimed = await store.claimPrepared({ target, consumer: panelA, mode: 'reader' });
  const persisted = sessionArea.inspect()[REGISTRY_KEY];
  const leaseId = claimed.lease.leaseId;

  for (const mutate of [
    lease => { lease.target.urlSessionDigest = `sha256:${'A'.repeat(64)}`; },
    lease => { lease.lastExplicitActionAt = lease.createdAt - 1; },
    lease => { lease.expiresAt = lease.lastExplicitActionAt; },
    lease => { lease.pendingMode = null; },
    lease => { lease.consumer.extra = true; },
  ]) {
    const changed = structuredClone(persisted);
    mutate(changed.leases[leaseId]);
    sessionArea.replace({ [REGISTRY_KEY]: changed });
    await assert.rejects(() => store.snapshot(), /PERSONA_REGISTRY_INVALID/u);
  }
});

test('rejects persisted leases whose expiry is not the exact safe TTL derivation', async () => {
  const { store, sessionArea } = createFixture();
  const claimed = await store.claimPrepared({ target, consumer: panelA, mode: 'reader' });
  const persisted = sessionArea.inspect()[REGISTRY_KEY];
  const leaseId = claimed.lease.leaseId;

  for (const mutate of [
    lease => { lease.expiresAt = lease.lastExplicitActionAt + TTL_MS + 1; },
    lease => { lease.expiresAt = lease.lastExplicitActionAt + TTL_MS - 1; },
    lease => {
      lease.lastExplicitActionAt = Number.MAX_SAFE_INTEGER - TTL_MS + 1;
      lease.expiresAt = Number.MAX_SAFE_INTEGER;
    },
  ]) {
    const changed = structuredClone(persisted);
    mutate(changed.leases[leaseId]);
    sessionArea.replace({ [REGISTRY_KEY]: changed });
    await assert.rejects(() => store.snapshot(), /PERSONA_REGISTRY_INVALID/u);
  }
});

test('reopens from the one persisted registry and preserves exact owner identity', async () => {
  const clock = createClock();
  const sessionArea = createSessionArea();
  const lockManager = createFakeLockManager();
  const first = createPersonaLeaseStore({
    sessionArea,
    lockManager,
    now: () => clock.value,
    randomBytes: createDeterministicRandom(),
  });
  const claimed = await first.claimPrepared({ target, consumer: panelA, mode: 'reader' });
  const reopened = createPersonaLeaseStore({
    sessionArea,
    lockManager,
    now: () => clock.value,
    randomBytes: createDeterministicRandom(),
  });

  const owner = await reopened.findOwner(target);
  assert.equal(owner.leaseId, claimed.lease.leaseId);
  assert.deepEqual(Object.keys(sessionArea.inspect()), [REGISTRY_KEY]);
});

test('a shared exclusive Web Lock prevents a stale finalize from erasing a newer owner from another store', async () => {
  const clock = createClock();
  const sessionArea = createSessionArea();
  const lockManager = createFakeLockManager();
  const first = createPersonaLeaseStore({
    sessionArea,
    lockManager,
    now: () => clock.value,
    randomBytes: createDeterministicRandom(),
  });
  const second = createPersonaLeaseStore({
    sessionArea,
    lockManager,
    now: () => clock.value,
    randomBytes: createDeterministicRandom(),
  });
  await prepareAndActivate(first);
  const invalid = sessionArea.inspect()[REGISTRY_KEY];
  invalid.ownerByTarget = Object.create(null);
  sessionArea.replace({ [REGISTRY_KEY]: invalid });
  const preparedFirst = await first.prepareInvalidRegistryRecovery();
  const preparedSecond = await second.prepareInvalidRegistryRecovery();
  assert.equal(preparedFirst.ok, true);
  assert.equal(preparedSecond.ok, true);

  const firstResetEntered = deferred();
  const releaseFirstReset = deferred();
  const originalSet = sessionArea.set;
  let blockFirstReset = true;
  sessionArea.set = async entries => {
    const registry = entries[REGISTRY_KEY];
    const isReset = registry && Object.keys(registry.leases).length === 0 &&
      Object.keys(registry.ownerByTarget).length === 0;
    if (blockFirstReset && isReset) {
      blockFirstReset = false;
      firstResetEntered.resolve();
      await releaseFirstReset.promise;
    }
    return originalSet.call(sessionArea, entries);
  };

  const finalizedFirst = first.finalizeInvalidRegistryRecovery(preparedFirst.token);
  await firstResetEntered.promise;
  const ownerCreated = deferred();
  const competing = (async () => {
    const finalized = await second.finalizeInvalidRegistryRecovery(preparedSecond.token);
    const claimed = await second.claimPrepared({ target, consumer: panelA, mode: 'reader' });
    assert.equal(claimed.ok, true);
    const activated = await second.activate({
      leaseId: claimed.lease.leaseId,
      expectedRevision: claimed.lease.revision,
    });
    assert.equal(activated.ok, true);
    ownerCreated.resolve();
    return finalized;
  })();
  const overtook = await Promise.race([
    ownerCreated.promise.then(() => true),
    new Promise(resolve => setImmediate(() => resolve(false))),
  ]);
  releaseFirstReset.resolve();

  assert.equal((await finalizedFirst).ok, true);
  const competingFinalize = await competing;
  assert.equal(overtook, false);
  assert.deepEqual(competingFinalize, { ok: false, code: 'PERSONA_STATE_FAILED' });
  assert.equal((await second.findOwner(target)).state, 'active');
});

test('every store operation requests and validates the one exact exclusive Web Lock', async () => {
  const { store, lockManager } = createFixture();
  await store.snapshot();
  assert.deepEqual(lockManager.calls, [{
    name: STORE_LOCK_NAME,
    options: { mode: 'exclusive' },
  }]);

  const invalidGrants = [
    null,
    { name: 'audita:other-lock', mode: 'exclusive' },
    { name: STORE_LOCK_NAME, mode: 'shared' },
  ];
  for (const granted of invalidGrants) {
    const invalid = createPersonaLeaseStore({
      sessionArea: createSessionArea(),
      lockManager: { request: (_name, _options, callback) => callback(granted) },
      now: () => 1_000,
      randomBytes: createDeterministicRandom(),
    });
    await assert.rejects(() => invalid.snapshot(), /PERSONA_STORE_LOCK_INVALID/u);
  }
});

test('a rejected Web Lock request does not poison later serialized store operations', async () => {
  const shared = createFakeLockManager();
  let rejectFirst = true;
  const lockManager = {
    request(...args) {
      if (rejectFirst) {
        rejectFirst = false;
        return Promise.reject(new Error('web lock unavailable'));
      }
      return shared.request(...args);
    },
  };
  const store = createPersonaLeaseStore({
    sessionArea: createSessionArea(),
    lockManager,
    now: () => 1_000,
    randomBytes: createDeterministicRandom(),
  });

  await assert.rejects(() => store.snapshot(), /web lock unavailable/u);
  assert.deepEqual(await store.snapshot(), { version: 1, leases: {}, ownerByTarget: {} });
});

test('validates constructor, exact public inputs, clock and CSPRNG boundaries', async () => {
  const sessionArea = createSessionArea();
  for (const args of [
    {},
    { sessionArea, now: () => 0, randomBytes: createDeterministicRandom() },
    { sessionArea, lockManager: {}, now: () => 0, randomBytes: createDeterministicRandom() },
    { sessionArea, lockManager: createFakeLockManager(), now: null, randomBytes: createDeterministicRandom() },
    { sessionArea: {}, lockManager: createFakeLockManager(), now: () => 0, randomBytes: createDeterministicRandom() },
  ]) assert.throws(() => createPersonaLeaseStore(args), /PERSONA_LEASE_STORE_INVALID/u);

  const { store } = createFixture();
  await assert.rejects(() => store.claimPrepared({
    target,
    consumer: panelA,
    mode: 'reader',
    forged: true,
  }), /PERSONA_INPUT_INVALID/u);
  await assert.rejects(() => store.claimPrepared({ target, consumer: panelA, mode: 'visual' }), /PERSONA_INPUT_INVALID/u);

  const badClock = createPersonaLeaseStore({
    sessionArea: createSessionArea(),
    lockManager: createFakeLockManager(),
    now: () => Date.now() + 0.5,
    randomBytes: createDeterministicRandom(),
  });
  await assert.rejects(
    () => badClock.claimPrepared({ target, consumer: panelA, mode: 'reader' }),
    /PERSONA_CLOCK_INVALID/u,
  );

  for (const randomBytes of [
    () => new Array(16).fill(1),
    () => new Uint8Array(15),
    () => new Uint8Array(17),
  ]) {
    const invalidRandom = createPersonaLeaseStore({
      sessionArea: createSessionArea(),
      lockManager: createFakeLockManager(),
      now: () => 1_000,
      randomBytes,
    });
    await assert.rejects(
      () => invalidRandom.claimPrepared({ target, consumer: panelA, mode: 'reader' }),
      /Entropia insuficiente/iu,
    );
  }
});

test('continues serial mutations after a rejected persistence attempt', async () => {
  const sessionArea = createSessionArea();
  const originalSet = sessionArea.set;
  let attempts = 0;
  sessionArea.set = async entries => {
    attempts += 1;
    if (attempts === 1) throw new Error('storage unavailable');
    return originalSet.call(sessionArea, entries);
  };
  const store = createPersonaLeaseStore({
    sessionArea,
    lockManager: createFakeLockManager(),
    now: () => 1_000,
    randomBytes: createDeterministicRandom(),
  });

  await assert.rejects(
    () => store.claimPrepared({ target, consumer: panelA, mode: 'reader' }),
    /storage unavailable/u,
  );
  const next = await store.claimPrepared({ target, consumer: panelA, mode: 'motor' });
  assert.equal(next.ok, true);
  assert.equal((await store.findOwner(target)).activeMode, null);
  assert.equal(attempts, 2);
});
