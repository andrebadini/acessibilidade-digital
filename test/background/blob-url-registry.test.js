import test from 'node:test';
import assert from 'node:assert/strict';
import * as registryModule from '../../src/background/blob-url-registry.js';

const EXTENSION = 'a'.repeat(32);
const URL_A = `blob:chrome-extension://${EXTENSION}/11111111-1111-4111-8111-111111111111`;
const URL_B = `blob:chrome-extension://${EXTENSION}/22222222-2222-4222-8222-222222222222`;
const URL_C = `blob:chrome-extension://${EXTENSION}/33333333-3333-4333-8333-333333333333`;
const OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_OWNER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ENTRY = Object.freeze({ auditId: 'audit-a', blobUrl: URL_A, ownerDocumentId: OWNER });
const PREFIX = 'audita:blob-url:v1:';
const CLOSED = 'audita:blob-url-closed:v1:';
const keyFor = url => `${PREFIX}${encodeURIComponent(url)}`;
const closedKey = id => `${CLOSED}${id}`;
const persisted = entry => ({ version: 1, ...entry });
const copy = value => value === undefined ? undefined : structuredClone(value);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fixture() {
  const values = new Map();
  const live = new Set([OWNER, OTHER_OWNER]);
  const blobs = new Set([URL_A, URL_B, URL_C]);
  const calls = [];
  const sessionArea = {
    async get(key) { return key === null ? Object.fromEntries([...values].map(([k, v]) => [k, copy(v)])) :
      values.has(key) ? { [key]: copy(values.get(key)) } : {}; },
    async set(rows) { for (const [key, value] of Object.entries(rows)) values.set(key, copy(value)); },
    async remove(key) { values.delete(key); },
  };
  const callbacks = {
    async isOwnerAlive(owner) {
      assert.deepEqual(Object.keys(owner), ['ownerDocumentId']);
      assert.ok(Object.isFrozen(owner));
      calls.push(['alive', owner.ownerDocumentId]);
      return live.has(owner.ownerDocumentId);
    },
    async revokeInOwner(entry) {
      assert.ok(Object.isFrozen(entry));
      assert.deepEqual(Object.keys(entry).sort(), ['auditId', 'blobUrl', 'ownerDocumentId']);
      calls.push(['revoke', entry.blobUrl, entry.ownerDocumentId]);
      blobs.delete(entry.blobUrl);
      return true;
    },
  };
  const create = () => registryModule.createBlobUrlRegistryV1({ sessionArea,
    isOwnerAlive: owner => callbacks.isOwnerAlive(owner), revokeInOwner: entry => callbacks.revokeInOwner(entry) });
  return { values, live, blobs, calls, sessionArea, callbacks, create };
}

const denied = operation => assert.rejects(operation, error => {
  assert.equal(error.message, 'BLOB_REGISTRY_UNAVAILABLE');
  assert.equal(error.cause, undefined);
  return true;
});

test('registration and cleanup accept the full canonical audit identifier range', async t => {
  for (const [length, accepted] of [[160, true], [161, true], [200, true], [201, false]]) {
    await t.test(`${length} characters`, async () => {
      const env = fixture(); const registry = env.create();
      const auditId = 'a'.repeat(length); const entry = { ...ENTRY, auditId };
      if (!accepted) {
        await denied(registry.register(entry)); await denied(registry.clearAudit(auditId));
        assert.equal(env.values.size, 0); assert.deepEqual(env.calls, []); return;
      }
      await registry.register(entry);
      assert.deepEqual(env.values.get(keyFor(URL_A)), persisted(entry));
      assert.equal(await registry.clearAudit(auditId), 1);
      assert.equal(env.values.has(keyFor(URL_A)), false);
      assert.equal(await env.create().clearAudit(auditId), 0);
    });
  }
});

test('registration is durable, idempotent and exclusive to one audit and owner', async () => {
  const env = fixture(); const registry = env.create();
  await registry.register(ENTRY);
  await registry.register(ENTRY);
  assert.deepEqual([...env.values], [[keyFor(URL_A), persisted(ENTRY)]]);
  await denied(registry.register({ ...ENTRY, auditId: 'audit-b' }));
  await denied(registry.register({ ...ENTRY, ownerDocumentId: OTHER_OWNER }));
  assert.deepEqual([...env.values], [[keyFor(URL_A), persisted(ENTRY)]]);
  assert.deepEqual(env.calls, []);
});

test('clear confirms owner revocation, preserves foreign resources and retires the audit', async () => {
  const env = fixture(); const registry = env.create();
  const foreign = { ...ENTRY, auditId: 'audit-b', blobUrl: URL_B, ownerDocumentId: OTHER_OWNER };
  await registry.register(ENTRY); await registry.register(foreign);
  env.values.set('persona-independent', { active: true });
  assert.equal(await registry.clearAudit('audit-a'), 1);
  assert.equal(env.blobs.has(URL_A), false); assert.equal(env.blobs.has(URL_B), true);
  assert.deepEqual(env.calls, [['alive', OWNER], ['revoke', URL_A, OWNER]]);
  assert.equal(env.values.has(keyFor(URL_A)), false);
  assert.deepEqual(env.values.get(keyFor(URL_B)), persisted(foreign));
  assert.deepEqual(env.values.get('persona-independent'), { active: true });
  assert.deepEqual(env.values.get(closedKey('audit-a')), { version: 1, auditId: 'audit-a' });
  assert.equal(await registry.clearAudit('audit-a'), 0);
  await denied(registry.register({ ...ENTRY, blobUrl: URL_C }));
  await denied(env.create().register({ ...ENTRY, blobUrl: URL_C }));
  assert.equal(env.values.has(keyFor(URL_C)), false);
  assert.equal(env.calls.length, 2);
});

test('explicit owner absence removes the journal without calling an unavailable owner', async () => {
  const env = fixture(); env.values.set(keyFor(URL_A), persisted(ENTRY)); env.live.delete(OWNER);
  assert.equal(await env.create().clearAudit('audit-a'), 1);
  assert.deepEqual(env.calls, [['alive', OWNER]]);
  assert.equal(env.values.has(keyFor(URL_A)), false);
});

test('release proves revocation, is tuple-bound, and does not retire an active audit', async () => {
  const env = fixture(); const registry = env.create(); await registry.register(ENTRY);
  await denied(registry.release({ ...ENTRY, ownerDocumentId: OTHER_OWNER }));
  await denied(registry.release({ ...ENTRY, auditId: 'audit-b' }));
  assert.deepEqual(env.calls, []);
  await registry.release(ENTRY); await registry.release(ENTRY);
  assert.equal(env.blobs.has(URL_A), false); assert.equal(env.values.size, 0);
  await registry.register({ ...ENTRY, blobUrl: URL_B });
  assert.equal(env.values.has(keyFor(URL_B)), true);
});

test('unconfirmed owner status or revocation retains evidence and allows retry', async t => {
  for (const method of ['isOwnerAlive', 'revokeInOwner']) {
    for (const result of [undefined, null, {}, 1, 'true', 'throw', ...(method === 'revokeInOwner' ? [false] : [])]) {
      await t.test(`${method} ${String(result)}`, async () => {
        const env = fixture(); const registry = env.create(); await registry.register(ENTRY);
        const original = env.callbacks[method];
        env.callbacks[method] = async () => { if (result === 'throw') throw new Error('PRIVATE_SENTINEL'); return result; };
        await denied(registry.clearAudit('audit-a'));
        assert.deepEqual(env.values.get(keyFor(URL_A)), persisted(ENTRY));
        assert.equal(env.blobs.has(URL_A), true);
        env.callbacks[method] = original;
        assert.equal(await registry.clearAudit('audit-a'), 1);
        assert.equal(env.blobs.has(URL_A), false);
      });
    }
  }
});

test('storage acknowledgement handles no-op, pre-commit failure and commit-then-throw', async t => {
  for (const operation of ['register', 'clear-marker', 'remove']) {
    for (const behavior of ['noop', 'throw', 'commit-throw']) {
      await t.test(`${operation} ${behavior}`, async () => {
        const env = fixture(); const registry = env.create();
        if (operation !== 'register') await registry.register(ENTRY);
        const method = operation === 'remove' ? 'remove' : 'set';
        const original = env.sessionArea[method];
        env.sessionArea[method] = async value => {
          if (behavior === 'commit-throw') await original(value);
          if (behavior !== 'noop') throw new Error('PRIVATE_SENTINEL');
        };
        const run = () => operation === 'register' ? registry.register(ENTRY) : registry.clearAudit('audit-a');
        if (behavior === 'commit-throw') await run(); else await denied(run());
        if (operation === 'clear-marker' && behavior !== 'commit-throw') assert.deepEqual(env.calls, []);
        if (operation === 'remove' && behavior !== 'commit-throw') {
          assert.equal(env.values.has(keyFor(URL_A)), true); assert.equal(env.blobs.has(URL_A), false);
        }
        env.sessionArea[method] = original;
        await run();
        assert.equal(env.values.has(keyFor(URL_A)), operation === 'register');
      });
    }
  }
});

test('unavailable inventory or readback is not mistaken for an empty registry', async t => {
  for (const behavior of ['inventory-throw', 'inventory-null', 'read-throw', 'read-null']) {
    await t.test(behavior, async () => {
      const env = fixture(); const registry = env.create(); await registry.register(ENTRY);
      const original = env.sessionArea.get;
      env.sessionArea.get = async key => {
        if (behavior.startsWith(key === null ? 'inventory' : 'read')) {
          if (behavior.endsWith('throw')) throw new Error('PRIVATE_SENTINEL');
          return null;
        }
        return original(key);
      };
      await denied(registry.clearAudit('audit-a'));
      assert.equal(env.values.has(keyFor(URL_A)), true); assert.equal(env.blobs.has(URL_A), true);
      env.sessionArea.get = original;
      assert.equal(await registry.clearAudit('audit-a'), 1);
    });
  }
});

test('malformed and transplanted own records remain pending without foreign revocation', async t => {
  for (const kind of ['extra', 'wrong-key', 'invalid-url', 'invalid-owner']) {
    await t.test(kind, async () => {
      const env = fixture(); const record = persisted(ENTRY);
      if (kind === 'extra') record.content = 'PRIVATE_SENTINEL';
      if (kind === 'invalid-url') record.blobUrl = 'https://private.test/account';
      if (kind === 'invalid-owner') record.ownerDocumentId = null;
      const key = kind === 'wrong-key' ? keyFor(URL_B) : keyFor(URL_A);
      env.values.set(key, record);
      await denied(env.create().clearAudit('audit-a'));
      assert.deepEqual(env.values.get(key), record); assert.deepEqual(env.calls, []);
    });
  }
});

test('record replacement before or after owner proof never deletes or revokes foreign resources', async t => {
  for (const stage of ['inventory', 'alive', 'revoke']) {
    await t.test(stage, async () => {
      const env = fixture(); const registry = env.create(); await registry.register(ENTRY);
      const foreign = persisted({ ...ENTRY, auditId: 'audit-b', ownerDocumentId: OTHER_OWNER });
      const replace = () => env.values.set(keyFor(URL_A), foreign);
      if (stage === 'inventory') {
        const original = env.sessionArea.get;
        env.sessionArea.get = async key => { const result = await original(key); if (key === null) replace(); return result; };
      } else {
        const method = stage === 'alive' ? 'isOwnerAlive' : 'revokeInOwner';
        const original = env.callbacks[method];
        env.callbacks[method] = async entry => { const result = await original(entry); replace(); return result; };
      }
      await denied(registry.clearAudit('audit-a'));
      assert.deepEqual(env.values.get(keyFor(URL_A)), foreign);
      assert.equal(env.calls.some(call => call[0] === 'revoke' && call[2] === OTHER_OWNER), false);
      if (stage !== 'revoke') assert.equal(env.calls.some(call => call[0] === 'revoke'), false);
    });
  }
});

test('one pending owner does not prevent cleaning other own resources', async () => {
  const env = fixture(); const registry = env.create(); await registry.register(ENTRY);
  await registry.register({ ...ENTRY, blobUrl: URL_B, ownerDocumentId: OTHER_OWNER });
  const original = env.callbacks.revokeInOwner;
  env.callbacks.revokeInOwner = entry => entry.ownerDocumentId === OWNER ? false : original(entry);
  await denied(registry.clearAudit('audit-a'));
  assert.equal(env.values.has(keyFor(URL_A)), true); assert.equal(env.values.has(keyFor(URL_B)), false);
  env.callbacks.revokeInOwner = original;
  assert.equal(await env.create().clearAudit('audit-a'), 1);
});

test('two factories serialize in-flight registration, deletion and late registrations', async () => {
  const env = fixture(); const first = env.create(); const second = env.create();
  const entered = deferred(); const unblock = deferred(); const original = env.sessionArea.set;
  env.sessionArea.set = async rows => {
    if (Object.hasOwn(rows, keyFor(URL_A))) { entered.resolve(); await unblock.promise; }
    return original(rows);
  };
  const register = first.register(ENTRY); await entered.promise;
  const clear = second.clearAudit('audit-a');
  const late = denied(first.register({ ...ENTRY, blobUrl: URL_C }));
  unblock.resolve(); await register;
  assert.equal(await clear, 1); await late;
  assert.equal(env.values.has(keyFor(URL_A)), false); assert.equal(env.values.has(keyFor(URL_C)), false);
  await second.register({ ...ENTRY, auditId: 'audit-b', blobUrl: URL_B });
  assert.equal(env.values.has(keyFor(URL_B)), true);
});

test('closed marker survives factory recreation and denies registration even when no blobs existed', async () => {
  const env = fixture(); assert.equal(await env.create().clearAudit('audit-a'), 0);
  await denied(env.create().register(ENTRY));
  assert.deepEqual([...env.values], [[closedKey('audit-a'), { version: 1, auditId: 'audit-a' }]]);
});

test('invalid input is rejected without storage or owner effects and without supplied content in errors', async () => {
  const env = fixture(); const registry = env.create();
  let accesses = 0;
  const invalid = [null, { ...ENTRY, auditId: '' }, { ...ENTRY, auditId: 'https://private.test' },
    { ...ENTRY, ownerDocumentId: '' }, { ...ENTRY, blobUrl: 'blob:https://private.test/sensitive' },
    { ...ENTRY, blobUrl: `${URL_A}?private=1` }, { ...ENTRY, model: 'PRIVATE_SENTINEL' },
    Object.defineProperty({ ...ENTRY }, 'blobUrl', { get() { accesses++; return URL_A; }, enumerable: true })];
  for (const entry of invalid) { await denied(registry.register(entry)); await denied(registry.release(entry)); }
  await denied(registry.clearAudit('https://private.test'));
  assert.equal(accesses, 0); assert.equal(env.values.size, 0); assert.deepEqual(env.calls, []);
});
