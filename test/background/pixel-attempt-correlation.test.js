import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import test from 'node:test';

import {
  createPixelAttemptDigest,
  createPixelDirectAttemptDigest,
  createSessionPixelAttemptDigestAuthority,
} from '../../src/core/privacy/session-url-digest.js';
import {
  createPixelAttemptCorrelationV1,
  createPixelAttemptStoreBindingV1,
  runPixelAttemptCommitAuthorizationV1,
} from '../../src/background/pixel-attempt-correlation.js';

function sessionArea() {
  const values = {};
  return {
    values,
    async get(key) {
      if (key === null) return structuredClone(values);
      return Object.hasOwn(values, key) ? { [key]: structuredClone(values[key]) } : {};
    },
    async set(entries) { Object.assign(values, structuredClone(entries)); },
    async remove(key) { delete values[key]; },
  };
}

function attemptAuthority(area, fill = 7) {
  return createSessionPixelAttemptDigestAuthority({
    sessionArea: area, subtle: webcrypto.subtle,
    randomBytes: length => new Uint8Array(length).fill(fill), now: () => 10,
  });
}

async function expectedAttempt(auditId, consentId, fill = 7) {
  return createPixelAttemptDigest(
    { auditId, consentId }, new Uint8Array(32).fill(fill), webcrypto.subtle,
  );
}

function correlationFor({ area, store, fill = 7, now = () => 100, authority } = {}) {
  const attempt = authority ?? attemptAuthority(area, fill);
  return createPixelAttemptCorrelationV1({
    sessionArea: area, attemptAuthority: attempt, now,
    storeBinding: createPixelAttemptStoreBindingV1(store, area),
  });
}

test('prepares an exact non-authorizing marker and keeps raw consent out of persisted state', async () => {
  const area = sessionArea();
  const store = Object.freeze({ name: 'store-a' });
  const coordinator = correlationFor({ area, store });
  const consentId = 'B'.repeat(21) + 'g';
  const digest = await expectedAttempt('audit-1', consentId);
  const capability = await coordinator.prepare({
    auditId: 'audit-1', consentId, pageId: null, ownershipId: null, expiresAt: 200,
  });
  assert.deepEqual(Object.keys(capability), []);
  const markerKey = `audita:pixel-attempt:v1:audit-1:${digest.slice('hmac-sha256:'.length)}`;
  assert.deepEqual(area.values[markerKey], {
    version: 1, auditId: 'audit-1', attemptDigest: digest,
    pageId: null, ownershipId: null, preparedAt: 100, expiresAt: 200,
  });
  assert.doesNotMatch(JSON.stringify(area.values), /B{21}g/u);
  assert.equal(await runPixelAttemptCommitAuthorizationV1(capability, store, async projected => {
    assert.deepEqual(projected, { auditId: 'audit-1', attemptDigest: digest, pageId: null, ownershipId: null });
    return true;
  }), true);
});

test('direct attempt is attached-only, domain-separated and never carries a consent claim', async () => {
  // A captura que o portão de privacidade autoriza SEM pausa (página sem sinal sensível) recebe uma
  // tentativa DIRETA: `consentId` nulo, apenas para o alvo anexado, com digesto de domínio próprio.
  // Ela não pode valer como consentimento nem servir a alvo de posse/página (URL, lote).
  const area = sessionArea();
  const store = Object.freeze({ name: 'store-a' });
  const coordinator = correlationFor({ area, store });
  const digest = await createPixelDirectAttemptDigest(
    { auditId: 'audit-1' }, new Uint8Array(32).fill(7), webcrypto.subtle,
  );
  const consentDigest = await expectedAttempt('audit-1', 'B'.repeat(21) + 'g');
  assert.notEqual(digest, consentDigest);
  const capability = await coordinator.prepare({
    auditId: 'audit-1', consentId: null, pageId: null, ownershipId: null, expiresAt: 200,
  });
  assert.deepEqual(Object.keys(capability), []);
  const markerKey = `audita:pixel-attempt:v1:audit-1:${digest.slice('hmac-sha256:'.length)}`;
  assert.deepEqual(area.values[markerKey], {
    version: 1, auditId: 'audit-1', attemptDigest: digest,
    pageId: null, ownershipId: null, preparedAt: 100, expiresAt: 200,
  });
  // Sem consentimento cru no estado persistido e sem marcador do caminho consentido.
  assert.equal(JSON.stringify(area.values).includes('consentId'), false);
  assert.equal(Object.keys(area.values).includes(
    `audita:pixel-attempt:v1:audit-1:${consentDigest.slice('hmac-sha256:'.length)}`,
  ), false);
  assert.equal(await coordinator.markerMatches({
    auditId: 'audit-1', attemptDigest: digest, pageId: null, ownershipId: null,
  }), true);
  assert.equal(await coordinator.markerMatches({
    auditId: 'audit-1', attemptDigest: consentDigest, pageId: null, ownershipId: null,
  }), false);
  // Fronteira: tentativa direta não existe para alvo de posse/página nem com consentimento malformado.
  for (const request of [
    { auditId: 'audit-1', consentId: null, pageId: 'page_1', ownershipId: null, expiresAt: 200 },
    { auditId: 'audit-1', consentId: null, pageId: null, ownershipId: 'owner_' + 'a'.repeat(22), expiresAt: 200 },
    { auditId: 'audit-1', consentId: 'curto', pageId: null, ownershipId: null, expiresAt: 200 },
    { auditId: '', consentId: null, pageId: null, ownershipId: null, expiresAt: 200 },
  ]) {
    await assert.rejects(
      () => coordinator.prepare(request),
      /PIXEL_ATTEMPT_CORRELATION_INVALID/u,
    );
  }
  assert.equal(await coordinator.remove({
    auditId: 'audit-1', attemptDigest: digest, pageId: null, ownershipId: null,
  }), true);
  assert.equal(area.values[markerKey], undefined);
});

test('fails closed for marker drift and removes only an exactly correlated marker', async () => {
  const area = sessionArea();
  const store = Object.freeze({ name: 'store-a' });
  const coordinator = correlationFor({ area, store });
  const consentId = 'B'.repeat(21) + 'g';
  const digest = await expectedAttempt('audit-1', consentId);
  const capability = await coordinator.prepare({
    auditId: 'audit-1', consentId, pageId: 'page-1', ownershipId: null, expiresAt: 200,
  });
  const exact = { auditId: 'audit-1', attemptDigest: digest, pageId: 'page-1', ownershipId: null };
  assert.equal(await coordinator.markerMatches(exact), true);
  const markerKey = `audita:pixel-attempt:v1:audit-1:${digest.slice('hmac-sha256:'.length)}`;
  area.values[markerKey].attemptDigest = `hmac-sha256:${'C'.repeat(43)}`;
  assert.equal(await coordinator.markerMatches(exact), false);
  assert.equal(await coordinator.remove(exact), false);
  await assert.rejects(
    () => runPixelAttemptCommitAuthorizationV1(capability, store, async () => true),
    /PIXEL_ATTEMPT_CORRELATION_INVALID/u,
  );
  assert.ok(area.values[markerKey]);
});

test('binding and capability are exact to one store and one session area', async () => {
  const areaA = sessionArea();
  const areaB = sessionArea();
  const storeA = Object.freeze({ name: 'store-a' });
  const storeB = Object.freeze({ name: 'store-b' });
  const bindingA = createPixelAttemptStoreBindingV1(storeA, areaA);
  assert.throws(() => createPixelAttemptStoreBindingV1(storeA, areaB), /PIXEL_ATTEMPT_CORRELATION_INVALID/u);
  assert.throws(() => createPixelAttemptCorrelationV1({
    sessionArea: areaB, attemptAuthority: attemptAuthority(areaB), now: () => 100, storeBinding: bindingA,
  }), /PIXEL_ATTEMPT_CORRELATION_INVALID/u);
  const coordinator = createPixelAttemptCorrelationV1({
    sessionArea: areaA, attemptAuthority: attemptAuthority(areaA), now: () => 100, storeBinding: bindingA,
  });
  const capability = await coordinator.prepare({
    auditId: 'audit-1', consentId: 'A'.repeat(21) + 'Q', pageId: null,
    ownershipId: null, expiresAt: 200,
  });
  assert.equal(await runPixelAttemptCommitAuthorizationV1(capability, storeA, async () => true), true);
  await assert.rejects(
    () => runPixelAttemptCommitAuthorizationV1(capability, storeB, async () => true),
    /PIXEL_ATTEMPT_CORRELATION_INVALID/u,
  );
});

test('correlator rejects an arbitrary digest function or an authority branded for another session', () => {
  const areaA = sessionArea();
  const areaB = sessionArea();
  const store = Object.freeze({ name: 'store-a' });
  const binding = createPixelAttemptStoreBindingV1(store, areaA);
  assert.throws(() => createPixelAttemptCorrelationV1({
    sessionArea: areaA, attemptAuthority: { digestAttempt: async () => `hmac-sha256:${'A'.repeat(43)}` },
    now: () => 100, storeBinding: binding,
  }), /PIXEL_ATTEMPT_CORRELATION_INVALID/u);
  assert.throws(() => createPixelAttemptCorrelationV1({
    sessionArea: areaA, attemptAuthority: attemptAuthority(areaB), now: () => 100, storeBinding: binding,
  }), /PIXEL_ATTEMPT_CORRELATION_INVALID/u);
});

test('attempt-specific keys and shared serialization prevent remove A from deleting rotated B', async () => {
  const area = sessionArea();
  const store = Object.freeze({ name: 'store-a' });
  const authority = attemptAuthority(area);
  const first = correlationFor({ area, store, authority, now: () => 100 });
  const second = correlationFor({ area, store, authority, now: () => 101 });
  const consentA = 'A'.repeat(21) + 'Q';
  const consentB = 'B'.repeat(21) + 'g';
  const attemptA = {
    auditId: 'audit-1', attemptDigest: await expectedAttempt('audit-1', consentA),
    pageId: null, ownershipId: null,
  };
  const attemptB = {
    auditId: 'audit-1', attemptDigest: await expectedAttempt('audit-1', consentB),
    pageId: null, ownershipId: null,
  };
  await first.prepare({ auditId: 'audit-1', consentId: consentA, pageId: null, ownershipId: null, expiresAt: 200 });
  await second.prepare({ auditId: 'audit-1', consentId: consentB, pageId: null, ownershipId: null, expiresAt: 200 });
  assert.equal(await first.remove(attemptA), true);
  assert.equal(await second.markerMatches(attemptB), true);
  assert.equal(await first.remove(attemptA), true, 'exact already-absent cleanup is idempotent');
});

test('authorized commit holds the audit-session queue until its operation settles', async () => {
  const area = sessionArea();
  const store = Object.freeze({ name: 'store-a' });
  const coordinator = correlationFor({ area, store });
  const consentId = 'A'.repeat(21) + 'Q';
  const attempt = {
    auditId: 'audit-lock', attemptDigest: await expectedAttempt('audit-lock', consentId),
    pageId: null, ownershipId: null,
  };
  const capability = await coordinator.prepare({
    auditId: attempt.auditId, consentId, pageId: null, ownershipId: null, expiresAt: 200,
  });
  let releaseCommit;
  let commitStarted;
  const started = new Promise(resolve => { commitStarted = resolve; });
  const gate = new Promise(resolve => { releaseCommit = resolve; });
  let removeSettled = false;
  const committing = runPixelAttemptCommitAuthorizationV1(capability, store, async () => {
    commitStarted();
    await gate;
    return true;
  });
  await started;
  const removing = coordinator.remove(attempt).then(result => {
    removeSettled = true;
    return result;
  });
  await Promise.resolve();
  assert.equal(removeSettled, false);
  releaseCommit();
  assert.equal(await committing, true);
  assert.equal(await removing, true);
});

test('malformed marker at the exact attempt key is blocking and never overwritten', async () => {
  const area = sessionArea();
  const store = Object.freeze({ name: 'store-a' });
  const consentId = 'A'.repeat(21) + 'Q';
  const digest = await expectedAttempt('audit-1', consentId);
  area.values[`audita:pixel-attempt:v1:audit-1:${digest.slice('hmac-sha256:'.length)}`] = { malformed: true };
  const coordinator = correlationFor({ area, store });
  await assert.rejects(
    () => coordinator.prepare({ auditId: 'audit-1', consentId, pageId: null, ownershipId: null, expiresAt: 200 }),
    /PIXEL_ATTEMPT_CORRELATION_INVALID/u,
  );
  assert.deepEqual(area.values[`audita:pixel-attempt:v1:audit-1:${digest.slice('hmac-sha256:'.length)}`], { malformed: true });
});

test('restart reuses an exact confirmed marker and native commit-then-throw is decided by reread', async () => {
  const area = sessionArea();
  const store = Object.freeze({ name: 'store-a' });
  const authority = attemptAuthority(area);
  const originalSet = area.set;
  area.set = async entries => {
    await originalSet.call(area, entries);
    throw new Error('native-private-set');
  };
  const first = correlationFor({ area, store, authority, now: () => 100 });
  const request = {
    auditId: 'audit-restart', consentId: 'A'.repeat(21) + 'Q',
    pageId: 'page-1', ownershipId: 'owner-1', expiresAt: 200,
  };
  const firstCapability = await first.prepare(request);
  const restarted = correlationFor({ area, store, authority, now: () => 101 });
  const restartedCapability = await restarted.prepare(request);
  assert.equal(await runPixelAttemptCommitAuthorizationV1(firstCapability, store, async () => true), true);
  assert.equal(await runPixelAttemptCommitAuthorizationV1(restartedCapability, store, async () => true), true);

  const expected = {
    auditId: request.auditId,
    attemptDigest: await expectedAttempt(request.auditId, request.consentId),
    pageId: request.pageId, ownershipId: request.ownershipId,
  };
  const originalRemove = area.remove;
  area.remove = async key => {
    await originalRemove.call(area, key);
    throw new Error('native-private-remove');
  };
  assert.equal(await restarted.remove(expected), true);
});

test('no-op marker persistence and IDs beyond the upstream limit fail closed', async () => {
  const area = sessionArea();
  const store = Object.freeze({ name: 'store-a' });
  const authority = attemptAuthority(area);
  await authority.digestAttempt({ auditId: 'preseed', consentId: 'A'.repeat(21) + 'Q' });
  area.set = async () => {};
  const coordinator = correlationFor({ area, store, authority });
  await assert.rejects(
    () => coordinator.prepare({
      auditId: 'audit-1', consentId: 'A'.repeat(21) + 'Q', pageId: null, ownershipId: null, expiresAt: 200,
    }),
    /PIXEL_ATTEMPT_CORRELATION_INVALID/u,
  );
  for (const [pageId, ownershipId] of [['P'.repeat(161), null], [null, 'O'.repeat(161)]]) {
    await assert.rejects(
      () => coordinator.prepare({
        auditId: 'audit-1', consentId: 'A'.repeat(21) + 'Q', pageId, ownershipId, expiresAt: 200,
      }),
      /PIXEL_ATTEMPT_CORRELATION_INVALID/u,
    );
  }
});
