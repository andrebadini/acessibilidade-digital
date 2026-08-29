import assert from 'node:assert/strict';
import test from 'node:test';

import { createOwnedTabRegistry } from '../../src/background/owned-tabs.js';

function createSessionArea() {
  const values = {};
  return {
    values,
    async get(key) { return Object.hasOwn(values, key) ? { [key]: structuredClone(values[key]) } : {}; },
    async set(entries) { Object.assign(values, structuredClone(entries)); },
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
  ownerId: 'owner-a', auditId: 'audit-a', sessionCapabilityId: 'session-a',
  tabId: 41, windowId: 9, cleanupMode: 'always',
};

test('registers the exact owned-tab record and applies owner/audit/tab/state CAS transitions', async () => {
  const { owned } = fixture();
  assert.deepEqual(Object.keys(owned), ['registerCreated', 'transition', 'removeOwned', 'markCleanupPending', 'get']);
  const record = await owned.registerCreated(created);
  assert.deepEqual(Object.keys(record), [
    'version', 'ownerId', 'auditId', 'sessionCapabilityId', 'tabId', 'windowId',
    'cleanupMode', 'state', 'createdAt', 'updatedAt',
  ]);
  assert.equal(record.state, 'created');
  const observing = await owned.transition({
    ownerId: 'owner-a', auditId: 'audit-a', tabId: 41,
    fromState: 'created', toState: 'observing',
  });
  assert.equal(observing.state, 'observing');
  await assert.rejects(() => owned.transition({
    ownerId: 'owner-a', auditId: 'audit-a', tabId: 41,
    fromState: 'created', toState: 'removed',
  }), /OWNERSHIP_DENIED/u);
});

test('refuses foreign tab removal and journals failed owned cleanup', async () => {
  const { adapter, calls, owned } = fixture();
  await owned.registerCreated(created);
  await assert.rejects(() => owned.removeOwned({ ownerId: 'owner-a', tabId: 99 }), /OWNERSHIP_DENIED/u);
  assert.deepEqual(calls, []);
  adapter.removeError = true;
  assert.equal((await owned.removeOwned({ ownerId: 'owner-a', tabId: 41 })).state, 'cleanup-pending');
  assert.deepEqual(calls, [41]);
  assert.equal((await owned.get('owner-a')).state, 'cleanup-pending');
});

test('removes only the exact owned tab and never registers the same owner twice', async () => {
  const { calls, owned } = fixture();
  await owned.registerCreated(created);
  await assert.rejects(() => owned.registerCreated(created), /OWNERSHIP_DENIED/u);
  const removed = await owned.removeOwned({ ownerId: 'owner-a', tabId: 41 });
  assert.equal(removed.state, 'removed');
  assert.deepEqual(calls, [41]);
  assert.equal((await owned.get('owner-a')).state, 'removed');
});

test('rejects malformed or transplanted ownership records before any tab effect', async () => {
  const { sessionArea, calls, owned } = fixture();
  await owned.registerCreated(created);
  sessionArea.values['audita:owned-tab:v1:owner-a'].extra = true;
  await assert.rejects(() => owned.removeOwned({ ownerId: 'owner-a', tabId: 41 }), /OWNERSHIP_DENIED/u);
  assert.deepEqual(calls, []);
});
