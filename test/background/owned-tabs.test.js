import assert from 'node:assert/strict';
import test from 'node:test';

import { createOwnedTabRegistry } from '../../src/background/owned-tabs.js';

function cloneForStorage(value) {
  try { return structuredClone(value); } catch { return value; }
}

function createSessionArea() {
  const values = {};
  const calls = [];
  return {
    values,
    calls,
    async get(key) {
      if (key === null) return cloneForStorage(values);
      return Object.hasOwn(values, key) ? { [key]: cloneForStorage(values[key]) } : {};
    },
    async set(entries) {
      calls.push({ type: 'set', entries });
      for (const [key, value] of Object.entries(entries)) values[key] = cloneForStorage(value);
    },
    async remove(keys) {
      calls.push({ type: 'remove', keys: Array.isArray(keys) ? [...keys] : [keys] });
      for (const key of (Array.isArray(keys) ? keys : [keys])) delete values[key];
    },
  };
}

function fixture() {
  const sessionArea = createSessionArea();
  const calls = [];
  const adapter = {
    removeError: false,
    async removeTab(tabId) {
      calls.push(tabId);
      if (this.removeError) throw new Error('PRIVATE_REMOVE_DETAIL');
    },
  };
  let tick = 0;
  const owned = createOwnedTabRegistry({
    sessionArea, chromeAdapter: adapter,
    now: () => new Date(Date.UTC(2026, 7, 29, 10, 0, tick++)).toISOString(),
  });
  return { sessionArea, adapter, calls, owned };
}

const created = {
  ownershipId: 'owner-a', auditId: 'audit-a', purpose: 'audit',
  tabId: 41, windowId: 9, cleanupMode: 'always',
};

test('registers an exact OwnedDisposableTabV2 in its own namespace', async () => {
  const { sessionArea, owned } = fixture();
  const record = await owned.registerCreated(created);

  assert.deepEqual(Object.keys(record), [
    'version', 'ownershipId', 'auditId', 'purpose', 'tabId', 'windowId',
    'cleanupMode', 'state', 'createdAt', 'updatedAt',
  ]);
  assert.equal(record.version, 2);
  assert.equal(record.state, 'created');
  assert.equal(Object.hasOwn(record, 'sessionCapabilityId'), false);
  assert.equal(Object.hasOwn(record, 'ownerId'), false);
  assert.ok(Object.hasOwn(sessionArea.values, 'audita:owned-tab:v2:owner-a'));
  assert.equal(Object.hasOwn(sessionArea.values, 'audita:owned-tab:v1:owner-a'), false);
  await assert.rejects(() => owned.registerCreated({
    ...created, ownerId: 'legacy-owner', sessionCapabilityId: 'legacy-session',
  }), /OWNERSHIP_DENIED/u);
});

test('supports consent retention and re-entry with full ownership CAS', async () => {
  const { owned } = fixture();
  await owned.registerCreated(created);
  await owned.transition({ ownershipId: 'owner-a', auditId: 'audit-a', tabId: 41, fromState: 'created', toState: 'observing' });
  const paused = await owned.transition({
    ownershipId: 'owner-a', auditId: 'audit-a', tabId: 41,
    fromState: 'observing', toState: 'retained-for-consent',
  });
  assert.equal(paused.state, 'retained-for-consent');
  const resumed = await owned.transition({
    ownershipId: 'owner-a', auditId: 'audit-a', tabId: 41,
    fromState: 'retained-for-consent', toState: 'observing',
  });
  assert.equal(resumed.state, 'observing');
  await assert.rejects(() => owned.transition({
    ownershipId: 'owner-b', auditId: 'audit-a', tabId: 41,
    fromState: 'observing', toState: 'cleanup-pending',
  }), /OWNERSHIP_DENIED/u);
  await assert.rejects(() => owned.transition({
    ownershipId: 'owner-a', auditId: 'audit-b', tabId: 41,
    fromState: 'observing', toState: 'cleanup-pending',
  }), /OWNERSHIP_DENIED/u);
});

test('allows consent retention to terminate without ever changing its identity', async () => {
  const { calls, owned } = fixture();
  await owned.registerCreated(created);
  await owned.transition({ ownershipId: 'owner-a', auditId: 'audit-a', tabId: 41, fromState: 'created', toState: 'observing' });
  await owned.transition({ ownershipId: 'owner-a', auditId: 'audit-a', tabId: 41, fromState: 'observing', toState: 'retained-for-consent' });
  const removed = await owned.removeOwned({
    ownershipId: 'owner-a', auditId: 'audit-a', tabId: 41, fromState: 'retained-for-consent',
  });
  assert.equal(removed.state, 'removed');
  assert.deepEqual(calls, [41]);
  assert.deepEqual(await owned.get('owner-a'), { ...removed });
});

test('failed cleanup leaves a V2 cleanup-pending journal without exposing remove details', async () => {
  const { adapter, calls, owned } = fixture();
  await owned.registerCreated(created);
  adapter.removeError = true;
  const pending = await owned.removeOwned({
    ownershipId: 'owner-a', auditId: 'audit-a', tabId: 41, fromState: 'created',
  });
  assert.equal(pending.state, 'cleanup-pending');
  assert.deepEqual(calls, [41]);
  assert.equal((await owned.get('owner-a')).state, 'cleanup-pending');
});

test('clearAudit cleans only proven V2 owners for the requested audit', async () => {
  const { calls, owned } = fixture();
  await owned.registerCreated(created);
  await owned.registerCreated({ ...created, ownershipId: 'owner-b', auditId: 'audit-b', tabId: 42 });
  const removedCount = await owned.clearAudit('audit-a');
  assert.equal(removedCount, 1);
  assert.deepEqual(calls, [41]);
  assert.equal((await owned.get('owner-a')).state, 'removed');
  assert.equal((await owned.get('owner-b')).state, 'created');
});

test('cleans a well-formed V1 record only as exact-tab recovery and removes the legacy record', async () => {
  const { sessionArea, calls, owned } = fixture();
  sessionArea.values['audita:owned-tab:v1:legacy-owner'] = {
    version: 1, ownerId: 'legacy-owner', auditId: 'audit-legacy', sessionCapabilityId: 'session-legacy',
    tabId: 77, windowId: 8, cleanupMode: 'always', state: 'cleanup-pending',
    createdAt: '2026-08-29T10:00:00.000Z', updatedAt: '2026-08-29T10:00:00.000Z',
  };
  sessionArea.values['audita:owned-tab:v1:foreign-owner'] = {
    version: 1, ownerId: 'foreign-owner', auditId: 'audit-foreign', sessionCapabilityId: 'session-foreign',
    tabId: 88, windowId: 8, cleanupMode: 'always', state: 'cleanup-pending',
    createdAt: '2026-08-29T10:00:00.000Z', updatedAt: '2026-08-29T10:00:00.000Z',
  };

  assert.equal(await owned.clearAudit('audit-legacy'), 1);
  assert.deepEqual(calls, [77]);
  assert.equal(Object.hasOwn(sessionArea.values, 'audita:owned-tab:v1:legacy-owner'), false);
  assert.equal(Object.hasOwn(sessionArea.values, 'audita:owned-tab:v1:foreign-owner'), true);
  assert.equal(Object.keys(sessionArea.values).some(key => key.startsWith('audita:owned-tab:v2:')), false);
});

test('never effects a malformed, transplanted, or hostile V1 record', async () => {
  const { sessionArea, calls, owned } = fixture();
  sessionArea.values['audita:owned-tab:v1:transplanted'] = {
    version: 1, ownerId: 'different-owner', auditId: 'audit-target', sessionCapabilityId: 'session',
    tabId: 99, windowId: 8, cleanupMode: 'always', state: 'cleanup-pending',
    createdAt: '2026-08-29T10:00:00.000Z', updatedAt: '2026-08-29T10:00:00.000Z',
  };
  sessionArea.values['audita:owned-tab:v1:malformed'] = {
    version: 1, ownerId: 'malformed', auditId: 'audit-target', sessionCapabilityId: 'session',
    tabId: 100, windowId: 8, cleanupMode: 'always', state: 'cleanup-pending', extra: true,
    createdAt: '2026-08-29T10:00:00.000Z', updatedAt: '2026-08-29T10:00:00.000Z',
  };
  const hostile = new Proxy({}, {
    ownKeys() { throw new Error('PRIVATE_DESCRIPTOR'); },
  });
  sessionArea.values['audita:owned-tab:v1:hostile'] = hostile;

  assert.equal(await owned.clearAudit('audit-target'), 0);
  assert.deepEqual(calls, []);
  assert.equal(Object.hasOwn(sessionArea.values, 'audita:owned-tab:v1:transplanted'), true);
  assert.equal(Object.hasOwn(sessionArea.values, 'audita:owned-tab:v1:malformed'), true);
  assert.equal(Object.hasOwn(sessionArea.values, 'audita:owned-tab:v1:hostile'), true);
});

test('restarted registries fail closed on a transplanted V2 record before tab effects', async () => {
  const first = fixture();
  await first.owned.registerCreated(created);
  const second = createOwnedTabRegistry({
    sessionArea: first.sessionArea, chromeAdapter: first.adapter,
    now: () => '2026-08-29T10:00:00.000Z',
  });
  first.sessionArea.values['audita:owned-tab:v2:owner-a'].ownershipId = 'owner-b';
  await assert.rejects(() => second.removeOwned({
    ownershipId: 'owner-a', auditId: 'audit-a', tabId: 41, fromState: 'created',
  }), /OWNERSHIP_DENIED/u);
  assert.deepEqual(first.calls, []);
});

test('serializes transitions for the same ownership but not independent owners', async () => {
  const { sessionArea, adapter } = fixture();
  const make = () => createOwnedTabRegistry({ sessionArea, chromeAdapter: adapter, now: () => '2026-08-29T11:00:00.000Z' });
  const first = make();
  const second = make();
  await first.registerCreated(created);
  const results = await Promise.allSettled([
    first.transition({ ownershipId: 'owner-a', auditId: 'audit-a', tabId: 41, fromState: 'created', toState: 'observing' }),
    second.transition({ ownershipId: 'owner-a', auditId: 'audit-a', tabId: 41, fromState: 'created', toState: 'cleanup-pending' }),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected' && /OWNERSHIP_DENIED/u.test(result.reason?.message)).length, 1);

  const records = await Promise.all([
    first.registerCreated({ ...created, ownershipId: 'owner-b', auditId: 'audit-b', tabId: 42 }),
    second.registerCreated({ ...created, ownershipId: 'owner-c', auditId: 'audit-c', tabId: 43 }),
  ]);
  assert.deepEqual(records.map(record => record.ownershipId).sort(), ['owner-b', 'owner-c']);
});

test('clearAudit waits for an in-flight registration of the same audit before completing', async () => {
  const { sessionArea, owned } = fixture();
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const originalSet = sessionArea.set.bind(sessionArea);
  let blockedOnce = true;
  sessionArea.set = async entries => {
    if (blockedOnce && Object.keys(entries).some(key => key.startsWith('audita:owned-tab:v2:'))) {
      blockedOnce = false;
      await blocked;
    }
    await originalSet(entries);
  };
  const registration = owned.registerCreated({ ...created, ownershipId: 'racing-owner', auditId: 'racing-audit' });
  await new Promise(resolve => setImmediate(resolve));
  const clearing = owned.clearAudit('racing-audit');
  release();
  await Promise.all([registration, clearing]);
  assert.equal((await owned.get('racing-owner')).state, 'removed');
});

test('uses readback to make a committed V2 set that throws non-orphaning', async () => {
  const { sessionArea, owned } = fixture();
  const originalSet = sessionArea.set.bind(sessionArea);
  let throwOnce = true;
  sessionArea.set = async entries => {
    await originalSet(entries);
    if (throwOnce) {
      throwOnce = false;
      throw new Error('COMMIT_THEN_THROW');
    }
  };
  const record = await owned.registerCreated({ ...created, ownershipId: 'committed-owner' });
  assert.equal(record.state, 'created');
  assert.equal((await owned.get('committed-owner')).state, 'created');
  throwOnce = true;
  const observing = await owned.transition({
    ownershipId: 'committed-owner', auditId: 'audit-a', tabId: 41,
    fromState: 'created', toState: 'observing',
  });
  assert.equal(observing.state, 'observing');
});

test('uses readback to make a committed V1 removal that throws count as cleanup', async () => {
  const { sessionArea, owned } = fixture();
  const key = 'audita:owned-tab:v1:legacy-throw';
  sessionArea.values[key] = {
    version: 1, ownerId: 'legacy-throw', auditId: 'audit-throw', sessionCapabilityId: 'session-legacy',
    tabId: 91, windowId: 8, cleanupMode: 'always', state: 'cleanup-pending',
    createdAt: '2026-08-29T10:00:00.000Z', updatedAt: '2026-08-29T10:00:00.000Z',
  };
  const originalRemove = sessionArea.remove.bind(sessionArea);
  sessionArea.remove = async keys => {
    await originalRemove(keys);
    throw new Error('REMOVE_COMMIT_THEN_THROW');
  };
  assert.equal(await owned.clearAudit('audit-throw'), 1);
  assert.equal(Object.hasOwn(sessionArea.values, key), false);
});

test('does not delete a V1 record replaced after tab cleanup even when audit and tab match', async () => {
  const { sessionArea, calls, owned } = fixture();
  const key = 'audita:owned-tab:v1:legacy-swap';
  const original = {
    version: 1, ownerId: 'legacy-swap', auditId: 'audit-swap', sessionCapabilityId: 'session-old',
    tabId: 92, windowId: 8, cleanupMode: 'always', state: 'cleanup-pending',
    createdAt: '2026-08-29T10:00:00.000Z', updatedAt: '2026-08-29T10:00:00.000Z',
  };
  sessionArea.values[key] = original;
  const replacement = { ...original, sessionCapabilityId: 'session-new' };
  const adapter = {
    async removeTab(tabId) {
      calls.push(tabId);
      sessionArea.values[key] = replacement;
    },
  };
  const registry = createOwnedTabRegistry({
    sessionArea, chromeAdapter: adapter, now: () => '2026-08-29T10:00:00.000Z',
  });
  assert.equal(await registry.clearAudit('audit-swap'), 0);
  assert.deepEqual(calls, [92]);
  assert.deepEqual(sessionArea.values[key], replacement);
});

test('does not deadlock when an ownershipId collides with the audit queue key', async () => {
  const { owned } = fixture();
  await owned.registerCreated({ ...created, ownershipId: 'audit:a', auditId: 'a' });
  const clearing = owned.clearAudit('a');
  const result = await Promise.race([
    clearing,
    new Promise((_, reject) => setTimeout(() => reject(new Error('OWNERSHIP_QUEUE_DEADLOCK')), 100)),
  ]);
  assert.equal(result, 1);
});

test('clearAudit derives the CAS state from a fresh owner read after a stale snapshot', async () => {
  const { sessionArea, calls, owned } = fixture();
  await owned.registerCreated({ ...created, auditId: 'audit-race-state' });
  await owned.registerCreated({ ...created, ownershipId: 'state-owner-b', auditId: 'audit-race-state', tabId: 42 });
  const originalGet = sessionArea.get.bind(sessionArea);
  let snapshotTaken = false;
  sessionArea.get = async key => {
    const result = await originalGet(key);
    if (key === null && !snapshotTaken) {
      snapshotTaken = true;
      queueMicrotask(() => {
        sessionArea.values['audita:owned-tab:v2:owner-a'].state = 'observing';
      });
    }
    return result;
  };
  assert.equal(await owned.clearAudit('audit-race-state'), 2);
  assert.deepEqual(calls.sort((a, b) => a - b), [41, 42]);
  assert.equal((await owned.get('owner-a')).state, 'removed');
  assert.equal((await owned.get('state-owner-b')).state, 'removed');
});

test('clearAudit isolates a transplanted owner and still cleans other owners of the audit', async () => {
  const { sessionArea, calls, owned } = fixture();
  await owned.registerCreated({ ...created, auditId: 'audit-transplant' });
  await owned.registerCreated({ ...created, ownershipId: 'transplant-owner-b', auditId: 'audit-transplant', tabId: 43 });
  const originalGet = sessionArea.get.bind(sessionArea);
  let snapshotTaken = false;
  sessionArea.get = async key => {
    const result = await originalGet(key);
    if (key === null && !snapshotTaken) {
      snapshotTaken = true;
      queueMicrotask(() => {
        sessionArea.values['audita:owned-tab:v2:owner-a'].ownershipId = 'foreign-owner';
      });
    }
    return result;
  };
  assert.equal(await owned.clearAudit('audit-transplant'), 1);
  assert.deepEqual(calls, [43]);
  assert.equal((await owned.get('transplant-owner-b')).state, 'removed');
});

test('clearAudit skips malformed V2 and V1 timestamps and still cleans later valid owners', async () => {
  const { sessionArea, calls, owned } = fixture();
  sessionArea.values['audita:owned-tab:v2:bad-time'] = {
    version: 2, ownershipId: 'bad-time', auditId: 'audit-bad-time', purpose: 'audit',
    tabId: 101, windowId: 8, cleanupMode: 'always', state: 'created',
    createdAt: 'not-a-time', updatedAt: '2026-08-29T10:00:00.000Z',
  };
  sessionArea.values['audita:owned-tab:v1:bad-time-v1'] = {
    version: 1, ownerId: 'bad-time-v1', auditId: 'audit-bad-time', sessionCapabilityId: 'session',
    tabId: 102, windowId: 8, cleanupMode: 'always', state: 'cleanup-pending',
    createdAt: '2026-08-29T10:00:00.000Z', updatedAt: 'not-a-time',
  };
  await owned.registerCreated({ ...created, ownershipId: 'good-time', auditId: 'audit-bad-time', tabId: 103 });
  sessionArea.values['audita:owned-tab:v1:good-time-v1'] = {
    version: 1, ownerId: 'good-time-v1', auditId: 'audit-bad-time', sessionCapabilityId: 'session',
    tabId: 104, windowId: 8, cleanupMode: 'always', state: 'cleanup-pending',
    createdAt: '2026-08-29T10:00:00.000Z', updatedAt: '2026-08-29T10:00:00.000Z',
  };

  assert.equal(await owned.clearAudit('audit-bad-time'), 2);
  assert.deepEqual(calls.sort((a, b) => a - b), [103, 104]);
  assert.equal(Object.hasOwn(sessionArea.values, 'audita:owned-tab:v2:bad-time'), true);
  assert.equal(Object.hasOwn(sessionArea.values, 'audita:owned-tab:v1:bad-time-v1'), true);
});

test('clearAudit rejects an operational V2 remove failure and preserves cleanup-pending state', async () => {
  const { adapter, owned } = fixture();
  await owned.registerCreated({ ...created, auditId: 'audit-operational-v2' });
  adapter.removeError = true;
  await assert.rejects(() => owned.clearAudit('audit-operational-v2'), /OWNERSHIP_DENIED/u);
  assert.equal((await owned.get('owner-a')).state, 'cleanup-pending');
});

test('clearAudit rejects an operational V1 remove failure and preserves the legacy record', async () => {
  const { sessionArea, adapter, owned } = fixture();
  const key = 'audita:owned-tab:v1:operational-v1';
  sessionArea.values[key] = {
    version: 1, ownerId: 'operational-v1', auditId: 'audit-operational-v1', sessionCapabilityId: 'session',
    tabId: 105, windowId: 8, cleanupMode: 'always', state: 'cleanup-pending',
    createdAt: '2026-08-29T10:00:00.000Z', updatedAt: '2026-08-29T10:00:00.000Z',
  };
  adapter.removeError = true;
  await assert.rejects(() => owned.clearAudit('audit-operational-v1'), /OWNERSHIP_DENIED/u);
  assert.equal(Object.hasOwn(sessionArea.values, key), true);
});

test('rejects the V2-only cleanup mode on V1 without touching it or blocking later valid V1 cleanup', async () => {
  const { sessionArea, calls, owned } = fixture();
  const invalidKey = 'audita:owned-tab:v1:legacy-v2-mode';
  sessionArea.values[invalidKey] = {
    version: 1, ownerId: 'legacy-v2-mode', auditId: 'audit-legacy-mode', sessionCapabilityId: 'session',
    tabId: 110, windowId: 8, cleanupMode: 'pre-observation-failure', state: 'cleanup-pending',
    createdAt: '2026-08-29T10:00:00.000Z', updatedAt: '2026-08-29T10:00:00.000Z',
  };
  const validKey = 'audita:owned-tab:v1:legacy-valid-mode';
  sessionArea.values[validKey] = {
    version: 1, ownerId: 'legacy-valid-mode', auditId: 'audit-legacy-mode', sessionCapabilityId: 'session',
    tabId: 111, windowId: 8, cleanupMode: 'retain-after-observation', state: 'cleanup-pending',
    createdAt: '2026-08-29T10:00:00.000Z', updatedAt: '2026-08-29T10:00:00.000Z',
  };
  assert.equal(await owned.clearAudit('audit-legacy-mode'), 1);
  assert.deepEqual(calls, [111]);
  assert.equal(Object.hasOwn(sessionArea.values, invalidKey), true);
  assert.equal(Object.hasOwn(sessionArea.values, validKey), false);
});
