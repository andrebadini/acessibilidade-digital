import assert from 'node:assert/strict';
import test from 'node:test';

import { createPageMarkerOriginCache } from '../../src/background/page-marker-origin-cache.js';

const EPOCH = 1_788_000_000_000;
const DIGEST = `hmac-sha256:${'A'.repeat(43)}`;
const origin = (overrides = {}) => ({
  auditId: 'audit-one', tabId: 17, windowId: 9, documentId: 'document-original',
  urlSessionDigest: DIGEST, createdAt: EPOCH, expiresAt: EPOCH + 1_800_000,
  ...overrides,
});
function cache(now = () => EPOCH) {
  return createPageMarkerOriginCache({ now });
}

test('register snapshots input and get returns distinct frozen records', () => {
  const store = cache();
  const input = origin();
  assert.equal(store.register(input), true);
  input.tabId = 99;
  input.documentId = 'changed';
  const first = store.get('audit-one');
  assert.deepEqual(first, origin());
  assert.equal(Object.isFrozen(first), true);
  assert.notEqual(first, store.get('audit-one'));
  assert.throws(() => { first.tabId = 99; }, TypeError);
  assert.equal(store.get('audit-one').tabId, 17);
});

test('clearAudit and clearTab isolate unrelated audits and tabs', () => {
  const store = cache();
  for (const row of [origin(), origin({ auditId: 'audit-two' }), origin({ auditId: 'audit-three', tabId: 18 })]) {
    assert.equal(store.register(row), true);
  }
  assert.equal(store.clearAudit('audit-one'), true);
  assert.equal(store.clearAudit('audit-one'), false);
  assert.equal(store.get('audit-two').tabId, 17);
  assert.equal(store.clearTab(17), 1);
  assert.equal(store.clearTab(17), 0);
  assert.deepEqual(store.get('audit-three'), origin({ auditId: 'audit-three', tabId: 18 }));
});

test('malformed envelopes are neutral and accessors are never invoked', () => {
  const store = cache();
  assert.equal(store.register(origin()), true);
  let accessorCalls = 0;
  const accessor = origin({ auditId: 'audit-getter' });
  Object.defineProperty(accessor, 'documentId', { enumerable: true, get() { accessorCalls += 1; throw new Error('private'); } });
  const hidden = origin();
  Object.defineProperty(hidden, 'tabId', { value: 17, enumerable: false });
  const missing = origin();
  delete missing.documentId;
  for (const input of [null, [], 'url', accessor, hidden, missing,
    { ...origin(), rawUrl: 'https://private.test/' }, { ...origin(), model: {} },
    { ...origin(), [Symbol('extra')]: true }, Object.create(origin()),
    new Proxy({}, { ownKeys() { throw new Error('private'); } })]) {
    assert.equal(store.register(input), false);
    assert.deepEqual(store.get('audit-one'), origin());
  }
  assert.equal(accessorCalls, 0);
});

test('identifier and time violations are rejected without replacing valid origin', () => {
  const store = cache();
  assert.equal(store.register(origin()), true);
  for (const override of [
    { auditId: '' }, { auditId: '__proto__' }, { auditId: 'https://example.test' }, { auditId: 'a'.repeat(201) },
    { tabId: -1 }, { tabId: 1.5 }, { tabId: '17' }, { windowId: NaN },
    { documentId: '' }, { documentId: 'a'.repeat(241) }, { documentId: 'document/foreign' },
    { urlSessionDigest: 'raw-url' }, { urlSessionDigest: `hmac-sha256:${'A'.repeat(42)}` },
    { createdAt: -1 }, { createdAt: EPOCH + 1 }, { expiresAt: EPOCH },
    { expiresAt: EPOCH + 1_800_001 }, { expiresAt: Number.MAX_SAFE_INTEGER + 1 },
  ]) assert.equal(store.register(origin(override)), false);
  assert.deepEqual(store.get('audit-one'), origin());
  for (const invalid of [null, {}, '', '__proto__', 17]) {
    assert.equal(store.get(invalid), null);
    assert.equal(store.clearAudit(invalid), false);
  }
  for (const invalid of [-1, '17', {}, NaN]) assert.equal(store.clearTab(invalid), 0);
});

test('zero Chrome ids and epoch times are valid and exact expiry purges permanently', () => {
  let time = 0;
  const store = cache(() => time);
  const row = origin({ tabId: 0, windowId: 0, createdAt: 0, expiresAt: 1 });
  assert.equal(store.register(row), true);
  assert.deepEqual(store.get(row.auditId), row);
  time = 1;
  assert.equal(store.get(row.auditId), null);
  time = 0;
  assert.equal(store.get(row.auditId), null);
});

test('duplicate is idempotent and cannot renew TTL or overwrite identity', () => {
  let time = EPOCH;
  const store = cache(() => time);
  assert.equal(store.register(origin()), true);
  time += 500;
  assert.equal(store.register(origin()), true);
  for (const override of [{ expiresAt: EPOCH + 1_799_999 }, { createdAt: EPOCH + 500, expiresAt: EPOCH + 1_800_500 },
    { tabId: 18 }, { windowId: 10 }, { documentId: 'document-other' }, { urlSessionDigest: `hmac-sha256:${'B'.repeat(43)}` }]) {
    assert.equal(store.register(origin(override)), false);
  }
  assert.deepEqual(store.get('audit-one'), origin());
  time = EPOCH + 1_800_000;
  assert.equal(store.get('audit-one'), null);
});

test('capacity evicts oldest created origin with insertion order as tie breaker, not access order', () => {
  const store = cache();
  for (let index = 0; index < 128; index += 1) {
    assert.equal(store.register(origin({ auditId: `audit-${index}` })), true);
  }
  assert.ok(store.get('audit-0'));
  assert.equal(store.register(origin({ auditId: 'audit-0' })), true);
  assert.equal(store.register(origin({ auditId: 'audit-128' })), true);
  assert.equal(store.get('audit-0'), null);
  assert.ok(store.get('audit-1'));
  assert.equal(store.clearTab(17), 128);

  const byCreated = cache();
  for (let index = 0; index < 128; index += 1) {
    assert.equal(byCreated.register(origin({ auditId: `audit-${index}`, createdAt: EPOCH - index,
      expiresAt: EPOCH + 1000 })), true);
  }
  assert.equal(byCreated.register(origin({ auditId: 'audit-new' })), true);
  assert.equal(byCreated.get('audit-127'), null);
  assert.ok(byCreated.get('audit-0'));
});

test('expired entries are pruned before capacity eviction', () => {
  let time = EPOCH;
  const store = cache(() => time);
  assert.equal(store.register(origin({ auditId: 'oldest-live', createdAt: EPOCH - 100, expiresAt: EPOCH + 100 })), true);
  for (let index = 1; index < 128; index += 1) {
    assert.equal(store.register(origin({ auditId: `expired-${index}`, expiresAt: EPOCH + 1 })), true);
  }
  time += 1;
  assert.equal(store.register(origin({ auditId: 'new-live', createdAt: time, expiresAt: time + 100 })), true);
  assert.ok(store.get('oldest-live'));
  assert.equal(store.clearTab(17), 2);
});

test('clock errors and invalid readings fail closed without leaking thrown values', () => {
  let reading = EPOCH;
  const secret = new Error('private-clock-payload');
  const store = cache(() => { if (reading === 'throw') throw secret; return reading; });
  assert.equal(store.register(origin()), true);
  for (const bad of ['throw', NaN, -1, Infinity, '0', {}, EPOCH - 1]) {
    reading = bad;
    assert.equal(store.get('audit-one'), null);
    assert.equal(store.register(origin({ auditId: 'other' })), false);
  }
  assert.equal(store.clearAudit('audit-one'), true);
  assert.equal(store.clearTab(17), 0);
});

test('register copies descriptors before clock callback can mutate caller input', () => {
  const input = origin();
  const store = cache(() => { input.tabId = 99; return EPOCH; });
  assert.equal(store.register(input), true);
  assert.equal(store.get('audit-one').tabId, 17);
});

test('new factory has no recovery or shared state from an earlier instance', () => {
  const first = cache();
  assert.equal(first.register(origin()), true);
  const second = cache();
  assert.equal(second.get('audit-one'), null);
  assert.equal(second.clearTab(17), 0);
  assert.ok(first.get('audit-one'));
});
