import assert from 'node:assert/strict';
import test from 'node:test';

import { createPageRelocationOfferStore, PAGE_RELOCATION_OFFER_TTL_MS } from '../../src/background/page-relocation-offer.js';

const EPOCH = 1_788_000_000_000;
const DIGEST = `hmac-sha256:${'A'.repeat(43)}`;
const offer = (overrides = {}) => ({
  auditId: 'audit-one', tabId: 17, windowId: 9, documentId: 'document-reloaded',
  urlSessionDigest: DIGEST, scope: 'page-markers', expiresAt: EPOCH + 1_800_000,
  ...overrides,
});
const identity = (overrides = {}) => ({
  auditId: 'audit-one', tabId: 17, windowId: 9, documentId: 'document-reloaded', scope: 'page-markers',
  ...overrides,
});

function store(now = () => EPOCH) {
  return createPageRelocationOfferStore({ now });
}

test('register snapshots the attempt and accept only matches the exact live document', () => {
  const offers = store();
  const input = offer();
  assert.equal(offers.register(input), true);
  input.tabId = 99;
  input.documentId = 'changed';
  const recorded = offers.read(identity());
  assert.equal(recorded.tabId, 17);
  assert.equal(recorded.documentId, 'document-reloaded');
  assert.equal(Object.isFrozen(recorded), true);
  assert.equal(offers.accept(identity()), true);
  // Nada é consumido: repetir a tentativa continua valendo enquanto a oferta viver.
  assert.equal(offers.accept(identity()), true);
});

test('accept refuses another document, another tab, another window, another origin or another scope', () => {
  const offers = store();
  assert.equal(offers.register(offer()), true);
  assert.equal(offers.accept(identity({ documentId: 'document-third' })), false);
  assert.equal(offers.accept(identity({ tabId: 18 })), false);
  assert.equal(offers.accept(identity({ windowId: 10 })), false);
  assert.equal(offers.accept(identity({ auditId: 'audit-two' })), false);
  assert.equal(offers.accept(identity({ scope: 'highlight' })), false);
  assert.equal(offers.accept(identity()), true);
});

test('a second scope on the same tab and audit is offered and accepted on its own', () => {
  const offers = store();
  assert.equal(offers.register(offer({ scope: 'highlight' })), true);
  assert.equal(offers.accept(identity({ scope: 'page-markers' })), false);
  assert.equal(offers.accept(identity({ scope: 'highlight' })), true);
});

test('the offer expires with the audited window and never outlives its own ceiling', () => {
  let now = EPOCH;
  const offers = store(() => now);
  // O teto é o menor entre o que o chamador pediu, o TTL do store e o TTL do próprio módulo.
  assert.equal(offers.register(offer({ expiresAt: EPOCH + 10 * PAGE_RELOCATION_OFFER_TTL_MS })), true);
  assert.equal(offers.read(identity()).expiresAt, EPOCH + PAGE_RELOCATION_OFFER_TTL_MS);
  now = EPOCH + PAGE_RELOCATION_OFFER_TTL_MS;
  assert.equal(offers.accept(identity()), false);
  assert.equal(offers.read(identity()), null);
  // A entrada vencida não volta a valer nem é reaceita por um documento igual.
  assert.equal(offers.register(offer()), true);
  assert.equal(offers.accept(identity()), true);
});

test('the offer never outlives the audit: the shorter deadline wins', () => {
  const offers = store();
  assert.equal(offers.register(offer({ expiresAt: EPOCH + 60_000 })), true);
  assert.equal(offers.read(identity()).expiresAt, EPOCH + 60_000);
  assert.equal(offers.register(offer({ expiresAt: EPOCH - 1 })), false);
  assert.equal(offers.read(identity()).expiresAt, EPOCH + 60_000);
});

test('clearAudit and clearTab retire the invitations of one audit or one tab only', () => {
  const offers = store();
  assert.equal(offers.register(offer()), true);
  assert.equal(offers.register(offer({ auditId: 'audit-two' })), true);
  assert.equal(offers.register(offer({ scope: 'highlight' })), true);
  assert.equal(offers.register(offer({ tabId: 18, auditId: 'audit-three' })), true);
  assert.equal(offers.clearAudit('audit-one'), true);
  assert.equal(offers.accept(identity()), false);
  assert.equal(offers.accept(identity({ scope: 'highlight' })), false);
  assert.equal(offers.clearAudit('audit-one'), false);
  assert.equal(offers.clearTab(18), true);
  assert.equal(offers.accept(identity({ auditId: 'audit-three', tabId: 18 })), false);
  assert.equal(offers.accept(identity({ auditId: 'audit-two' })), true);
});

test('the store holds a bounded number of invitations and evicts the oldest one', () => {
  let now = EPOCH;
  const offers = createPageRelocationOfferStore({ now: () => now, capacity: 2 });
  assert.equal(offers.register(offer({ auditId: 'audit-one' })), true);
  now += 1_000;
  assert.equal(offers.register(offer({ auditId: 'audit-two' })), true);
  now += 1_000;
  assert.equal(offers.register(offer({ auditId: 'audit-three' })), true);
  assert.equal(offers.size(), 2);
  assert.equal(offers.read(identity({ auditId: 'audit-one' })), null);
  assert.equal(offers.read(identity({ auditId: 'audit-two' }))?.auditId, 'audit-two');
});

test('re-registering the same identity refreshes the invitation instead of growing the store', () => {
  let now = EPOCH;
  const offers = createPageRelocationOfferStore({ now: () => now, capacity: 1 });
  assert.equal(offers.register(offer()), true);
  now += 1_000;
  assert.equal(offers.register(offer()), true);
  assert.equal(offers.size(), 1);
  assert.equal(offers.read(identity()).createdAt, now);
});

test('rejects malformed invitations, hostile accessors and a regressing clock', () => {
  const offers = store();
  assert.equal(offers.register({ ...offer(), scope: 'report' }), false);
  assert.equal(offers.register({ ...offer(), tabId: 0 }), false);
  assert.equal(offers.register({ ...offer(), windowId: -1 }), false);
  assert.equal(offers.register({ ...offer(), documentId: 'document with space' }), false);
  assert.equal(offers.register({ ...offer(), urlSessionDigest: 'plain' }), false);
  assert.equal(offers.register({ ...offer(), expiresAt: EPOCH + 0.5 }), false);
  assert.equal(offers.register({ ...offer(), extra: true }), false);
  assert.equal(offers.register(offer()), true);
  assert.equal(offers.accept({ ...identity(), extra: true }), false);
  assert.equal(offers.accept(identity({ documentId: 17 })), false);
  const hostile = Object.defineProperty({}, 'documentId', { get() { throw new Error('no'); } });
  assert.equal(offers.accept(hostile), false);
  assert.equal(offers.size(), 1);
  const backwards = createPageRelocationOfferStore({ now: (() => {
    let value = EPOCH;
    return () => { const current = value; value = EPOCH - 1; return current; };
  })() });
  assert.equal(backwards.register(offer()), true);
  assert.equal(backwards.accept(identity()), false);
});

test('rejects an invalid factory configuration', () => {
  assert.throws(() => createPageRelocationOfferStore({}), TypeError);
  assert.throws(() => createPageRelocationOfferStore({ now: () => EPOCH, ttlMs: 0 }), TypeError);
  assert.throws(() => createPageRelocationOfferStore({ now: () => EPOCH, capacity: 0 }), TypeError);
});
