import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import test from 'node:test';

import { createRawNavigationVaultV1 } from '../../src/background/raw-navigation-vault.js';
import { createSessionUrlDigestManager } from '../../src/core/privacy/session-url-digest.js';

function createSessionArea() {
  const values = {};
  let removeMode = 'normal';
  let setMode = 'normal';
  let getMode = 'normal';
  return {
    values,
    set removeMode(value) { removeMode = value; },
    set setMode(value) { setMode = value; },
    set getMode(value) { getMode = value; },
    async get(key) {
      if (getMode === 'throw') throw new Error('PRIVATE_GET_FAILURE');
      if (key === null) return structuredClone(values);
      return Object.hasOwn(values, key) ? { [key]: structuredClone(values[key]) } : {};
    },
    async set(entries) {
      if (setMode === 'throw') throw new Error('PRIVATE_SET_FAILURE');
      if (setMode === 'noop') return;
      Object.assign(values, structuredClone(entries));
    },
    async remove(key) {
      if (removeMode === 'throw') throw new Error('PRIVATE_REMOVE_FAILURE');
      if (removeMode === 'noop') return;
      for (const entry of Array.isArray(key) ? key : [key]) delete values[entry];
    },
  };
}

function fixture() {
  const sessionArea = createSessionArea();
  let value = 0;
  const digestManager = createSessionUrlDigestManager({
    sessionArea,
    subtle: webcrypto.subtle,
    randomBytes: length => new Uint8Array(length).fill(7),
    now: () => 1_788_000_000_000,
  });
  const vault = createRawNavigationVaultV1({
    sessionArea,
    now: () => 1_788_000_000_000,
    randomBytes: length => new Uint8Array(length).fill(++value),
    digestManager,
  });
  return { sessionArea, vault, digestManager };
}

function publicFixture({ sessionArea = createSessionArea(), clock = { value: 1_788_000_000_000 }, entropy = { value: 20 } } = {}) {
  const digestManager = createSessionUrlDigestManager({
    sessionArea, subtle: webcrypto.subtle,
    randomBytes: length => new Uint8Array(length).fill(6), now: () => clock.value,
  });
  const vault = createRawNavigationVaultV1({
    sessionArea, digestManager, now: () => clock.value,
    randomBytes: length => new Uint8Array(length).fill(++entropy.value),
  });
  return { sessionArea, clock, entropy, digestManager, vault };
}

async function batchEntry(vault, auditId, line, path) {
  const issued = await vault.put(`https://example.test/${path}?private=${line}`, {
    auditId, purpose: 'batch-page', ttlMs: 7_200_000, includeQuery: false,
  });
  return { line, navigationToken: issued.navigationToken, evidenceUrl: issued.evidenceUrl,
    sessionDigest: issued.sessionDigest, status: 'pending' };
}

test('takes a raw URL once, erases it before return and never leaks it', async () => {
  const { sessionArea, vault } = fixture();
  assert.deepEqual(Object.keys(vault), [
    'putInternal', 'takeInternal', 'invalidateInternal',
    'put', 'take', 'putQueue', 'readQueue', 'replaceQueue', 'clearAudit', 'clearExpired',
  ]);
  const secretUrl = 'https://example.test/?token=SEGREDO-NAO-LOGAR#private';
  const issued = await vault.putInternal({ ownerId: 'owner-a', rawUrl: secretUrl });
  const key = `audita:raw-navigation:v1:${issued.navigationToken}`;
  assert.deepEqual(Object.keys((await sessionArea.get(key))[key]), [
    'version', 'navigationToken', 'ownerId', 'rawUrl', 'issuedAt', 'expiresAt', 'state',
  ]);
  assert.equal(await vault.takeInternal({ ownerId: 'owner-a', navigationToken: issued.navigationToken }), secretUrl);
  assert.deepEqual(await sessionArea.get(key), {});
  await assert.rejects(
    () => vault.takeInternal({ ownerId: 'owner-a', navigationToken: issued.navigationToken }),
    /RAW_NAVIGATION_UNAVAILABLE/u,
  );
  assert.doesNotMatch(JSON.stringify(await sessionArea.get(null)), /SEGREDO-NAO-LOGAR/u);
});

test('public vault stores only a scoped one-shot URL and uses the shared HMAC manager', async () => {
  const sessionArea = createSessionArea();
  const digestManager = createSessionUrlDigestManager({
    sessionArea,
    subtle: webcrypto.subtle,
    randomBytes: length => new Uint8Array(length).fill(7),
    now: () => 1_788_004_800_000,
  });
  const vault = createRawNavigationVaultV1({
    sessionArea,
    digestManager,
    now: () => '2026-08-29T12:00:00.000Z',
    randomBytes: length => new Uint8Array(length).fill(5),
  });

  const issued = await vault.put('https://example.test/a?secret=1', {
    auditId: 'audit-1', purpose: 'single-url', ttlMs: 600_000, includeQuery: false,
  });
  assert.match(issued.sessionDigest, /^hmac-sha256:[A-Za-z0-9_-]{43}$/u);
  assert.equal(Object.hasOwn(issued, 'rawUrl'), false);
  assert.deepEqual((await sessionArea.get('audita:session-hmac-key:v1'))['audita:session-hmac-key:v1'], {
    version: 1,
    keyBase64Url: 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc',
    createdAt: 1_788_004_800_000,
  });
  assert.deepEqual(issued.evidenceUrl, {
    version: 'EvidenceUrlV1', href: 'https://example.test/a', queryIncluded: false, redactedSegments: 0,
  });
  assert.equal(await vault.take(issued.navigationToken, {
    auditId: 'audit-1', purpose: 'single-url',
  }), 'https://example.test/a?secret=1');
  await assert.rejects(vault.take(issued.navigationToken, {
    auditId: 'audit-1', purpose: 'single-url',
  }), /expirada ou consumida/iu);
});

test('public vault rejects cross-purpose and cross-audit claims without consuming the record', async () => {
  const { vault } = fixture();
  for (const purpose of ['single-url', 'batch-page', 'context-menu-link', 'current-state-assist']) {
    const issued = await vault.put(`https://example.test/${purpose}`, {
      auditId: 'audit-1', purpose,
      ttlMs: purpose === 'batch-page' ? 7_200_000 : 600_000,
      includeQuery: false,
    });
    const otherPurpose = purpose === 'single-url' ? 'batch-page' : 'single-url';
    await assert.rejects(vault.take(issued.navigationToken, {
      auditId: 'audit-1', purpose: otherPurpose,
    }), /finalidade não corresponde/iu);
    await assert.rejects(vault.take(issued.navigationToken, {
      auditId: 'audit-2', purpose,
    }), /auditoria não corresponde/iu);
    assert.equal(await vault.take(issued.navigationToken, {
      auditId: 'audit-1', purpose,
    }), `https://example.test/${purpose}`);
  }
});

test('queue keeps an absolute two-hour deadline and rejects stale revision or state replacement', async () => {
  let now = 1_788_000_000_000;
  const operationStartedAt = now;
  const sessionArea = createSessionArea();
  const digestManager = createSessionUrlDigestManager({
    sessionArea, subtle: webcrypto.subtle,
    randomBytes: length => new Uint8Array(length).fill(9), now: () => now,
  });
  let entropy = 0;
  const vault = createRawNavigationVaultV1({
    sessionArea, digestManager, now: () => now,
    randomBytes: length => new Uint8Array(length).fill(8 + ++entropy),
  });
  const issued = await vault.put('https://example.test/batch?private=1', {
    auditId: 'audit-queue', purpose: 'batch-page', ttlMs: 7_200_000, includeQuery: false,
  });
  const expiring = await vault.put('https://example.test/expired-batch?private=1', {
    auditId: 'audit-expired', purpose: 'batch-page', ttlMs: 7_200_000, includeQuery: false,
  });
  now += 1_000;
  const laterIssued = await vault.put('https://example.test/batch-later?private=1', {
    auditId: 'audit-queue', purpose: 'batch-page', ttlMs: 7_200_000, includeQuery: false,
  });
  await vault.putQueue({
    auditId: 'audit-queue',
    entries: [{ line: 1, navigationToken: issued.navigationToken, evidenceUrl: issued.evidenceUrl,
      sessionDigest: issued.sessionDigest, status: 'pending' },
    { line: 2, navigationToken: laterIssued.navigationToken, evidenceUrl: laterIssued.evidenceUrl,
      sessionDigest: laterIssued.sessionDigest, status: 'pending' }],
  });
  const first = await vault.readQueue('audit-queue');
  assert.equal(first.revision, 1);
  assert.equal(first.issuedAt, operationStartedAt);
  assert.equal(first.expiresAt, operationStartedAt + 7_200_000);
  assert.equal((await sessionArea.get(`audita:raw-navigation:v1:${laterIssued.navigationToken}`))[
    `audita:raw-navigation:v1:${laterIssued.navigationToken}`
  ].expiresAt, operationStartedAt + 7_200_000);
  assert.match(first.ownerOperationId, /^[A-Za-z0-9_-]{22}$/u);
  const next = structuredClone(first);
  next.revision = 2;
  next.entries[0].status = 'running';
  const foreignOwner = structuredClone(next);
  foreignOwner.ownerOperationId = 'F'.repeat(22);
  await assert.rejects(vault.replaceQueue('audit-queue', foreignOwner, {
    expectedRevision: 1, expectedState: { nextIndex: 0, status: 'pending' },
  }), /fila de navegação desatualizada/iu);
  assert.equal((await vault.readQueue('audit-queue')).revision, 1);
  await vault.replaceQueue('audit-queue', next, {
    expectedRevision: 1, expectedState: { nextIndex: 0, status: 'pending' },
  });
  await assert.rejects(vault.replaceQueue('audit-queue', next, {
    expectedRevision: 1, expectedState: { nextIndex: 0, status: 'pending' },
  }), /fila de navegação desatualizada/iu);
  now = operationStartedAt + 7_200_000;
  await assert.rejects(vault.putQueue({
    auditId: 'audit-expired',
    entries: [{ line: 1, navigationToken: expiring.navigationToken, evidenceUrl: expiring.evidenceUrl,
      sessionDigest: expiring.sessionDigest, status: 'pending' }],
  }), /RAW_NAVIGATION_INVALID/u);
  assert.equal(await vault.readQueue('audit-queue'), null);
  assert.equal(await vault.clearExpired(), 1);
});

test('fails closed without returning raw URL when removal cannot be verified', async () => {
  for (const removeMode of ['noop', 'throw']) {
    const { sessionArea, vault } = fixture();
    const issued = await vault.putInternal({ ownerId: 'owner-a', rawUrl: 'https://example.test/?secret=NEVER_RETURN' });
    sessionArea.removeMode = removeMode;
    await assert.rejects(
      () => vault.takeInternal({ ownerId: 'owner-a', navigationToken: issued.navigationToken }),
      error => error?.message === 'RAW_NAVIGATION_UNAVAILABLE',
    );
  }
});

test('serializes one-shot consumption and binds invalidation to the exact owner', async () => {
  const { sessionArea, vault } = fixture();
  const issued = await vault.putInternal({ ownerId: 'owner-a', rawUrl: 'https://example.test/path' });
  const attempts = await Promise.allSettled([
    vault.takeInternal({ ownerId: 'owner-a', navigationToken: issued.navigationToken }),
    vault.takeInternal({ ownerId: 'owner-a', navigationToken: issued.navigationToken }),
  ]);
  assert.equal(attempts.filter(value => value.status === 'fulfilled').length, 1);
  assert.equal(attempts.filter(value => value.status === 'rejected').length, 1);

  const foreign = await vault.putInternal({ ownerId: 'owner-a', rawUrl: 'https://example.test/other' });
  await assert.rejects(
    () => vault.invalidateInternal({ ownerId: 'owner-b', navigationToken: foreign.navigationToken }),
    /RAW_NAVIGATION_UNAVAILABLE/u,
  );
  assert.notDeepEqual(await sessionArea.get(`audita:raw-navigation:v1:${foreign.navigationToken}`), {});
  assert.deepEqual(await vault.invalidateInternal({ ownerId: 'owner-a', navigationToken: foreign.navigationToken }), { invalidated: true });
});

test('rejects noncanonical URLs and malformed persisted records without exposing their value', async () => {
  const { sessionArea, vault } = fixture();
  for (const rawUrl of [' example.test ', 'https://EXAMPLE.test', 'ftp://example.test/']) {
    await assert.rejects(() => vault.putInternal({ ownerId: 'owner-a', rawUrl }), /RAW_NAVIGATION_INVALID/u);
  }
  const issued = await vault.putInternal({ ownerId: 'owner-a', rawUrl: 'https://example.test/?secret=HIDDEN' });
  const key = `audita:raw-navigation:v1:${issued.navigationToken}`;
  sessionArea.values[key].extra = true;
  await assert.rejects(
    () => vault.takeInternal({ ownerId: 'owner-a', navigationToken: issued.navigationToken }),
    error => error?.message === 'RAW_NAVIGATION_UNAVAILABLE',
  );
});

test('fails closed on invalid clocks, overflow, and unverifiable put storage', async () => {
  for (const clockValue of [NaN, Infinity, -1, Number.MAX_SAFE_INTEGER]) {
    const sessionArea = createSessionArea();
    const vault = createRawNavigationVaultV1({
      sessionArea, now: () => clockValue,
      randomBytes: length => new Uint8Array(length).fill(3),
    });
    await assert.rejects(
      () => vault.putInternal({ ownerId: 'owner-a', rawUrl: 'https://example.test/' }),
      /RAW_NAVIGATION_INVALID/u,
    );
  }
  for (const setMode of ['throw', 'noop']) {
    const { sessionArea, vault } = fixture();
    sessionArea.setMode = setMode;
    await assert.rejects(
      () => vault.putInternal({ ownerId: 'owner-a', rawUrl: 'https://example.test/?secret=PRIVATE' }),
      error => error?.message === 'RAW_NAVIGATION_UNAVAILABLE',
    );
  }
});

test('never returns a raw URL when the consumption clock or storage read fails', async () => {
  let current = 1_788_000_000_000;
  const sessionArea = createSessionArea();
  const vault = createRawNavigationVaultV1({
    sessionArea, now: () => current,
    randomBytes: length => new Uint8Array(length).fill(4),
  });
  const issued = await vault.putInternal({ ownerId: 'owner-a', rawUrl: 'https://example.test/?secret=NEVER' });
  current = NaN;
  await assert.rejects(
    () => vault.takeInternal({ ownerId: 'owner-a', navigationToken: issued.navigationToken }),
    error => error?.message === 'RAW_NAVIGATION_UNAVAILABLE',
  );
  current = 1_788_000_000_001;
  sessionArea.getMode = 'throw';
  await assert.rejects(
    () => vault.takeInternal({ ownerId: 'owner-a', navigationToken: issued.navigationToken }),
    error => error?.message === 'RAW_NAVIGATION_UNAVAILABLE',
  );
});

test('shares one namespace lock across vault instances for token issuance and queue CAS', async () => {
  const sessionArea = createSessionArea();
  const clock = { value: 1_788_000_000_000 };
  const digestManager = createSessionUrlDigestManager({
    sessionArea, subtle: webcrypto.subtle,
    randomBytes: length => new Uint8Array(length).fill(3), now: () => clock.value,
  });
  let tokenCalls = 0;
  const collidingThenUnique = length => new Uint8Array(length).fill(++tokenCalls <= 2 ? 1 : tokenCalls);
  const first = createRawNavigationVaultV1({
    sessionArea, digestManager, now: () => clock.value, randomBytes: collidingThenUnique,
  });
  const second = createRawNavigationVaultV1({
    sessionArea, digestManager, now: () => clock.value, randomBytes: collidingThenUnique,
  });
  const issued = await Promise.allSettled([
    first.put('https://example.test/first?private=1', { auditId: 'audit-lock', purpose: 'single-url', ttlMs: 600_000, includeQuery: false }),
    second.put('https://example.test/second?private=2', { auditId: 'audit-lock', purpose: 'single-url', ttlMs: 600_000, includeQuery: false }),
  ]);
  assert.equal(issued.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(issued.filter(result => result.status === 'rejected').length, 1);
  const winner = issued.find(result => result.status === 'fulfilled').value;
  assert.equal(await first.take(winner.navigationToken, { auditId: 'audit-lock', purpose: 'single-url' }),
    'https://example.test/first?private=1');

  const entryA = await batchEntry(first, 'audit-cas', 1, 'cas-a');
  const entryB = await batchEntry(first, 'audit-cas', 2, 'cas-b');
  await first.putQueue({ auditId: 'audit-cas', entries: [entryA, entryB] });
  const current = await first.readQueue('audit-cas');
  const left = structuredClone(current); left.revision = 2; left.entries[0].status = 'running';
  const right = structuredClone(current); right.revision = 2; right.entries[0].status = 'running';
  const writes = await Promise.allSettled([
    first.replaceQueue('audit-cas', left, { expectedRevision: 1, expectedState: { nextIndex: 0, status: 'pending' } }),
    second.replaceQueue('audit-cas', right, { expectedRevision: 1, expectedState: { nextIndex: 0, status: 'pending' } }),
  ]);
  assert.equal(writes.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(writes.filter(result => result.status === 'rejected').length, 1);
});

test('rejects hostile, empty, mismatched, and non-pending queue creation before persistence', async () => {
  const { sessionArea, vault } = publicFixture();
  const entry = await batchEntry(vault, 'audit-queue-check', 1, 'queue-a');
  const foreign = await batchEntry(vault, 'audit-foreign', 1, 'queue-b');
  const queryEntry = await batchEntry(vault, 'audit-query-check', 1, 'query-a');
  let getterCalls = 0;
  const hostile = {};
  Object.defineProperty(hostile, 'auditId', { enumerable: true, get() { getterCalls += 1; return 'audit-queue-check'; } });
  await assert.rejects(vault.putQueue(hostile), /RAW_NAVIGATION_INVALID/u);
  assert.equal(getterCalls, 0);
  await assert.rejects(vault.putQueue({ auditId: 'audit-empty', entries: [] }), /RAW_NAVIGATION_INVALID/u);
  await assert.rejects(vault.putQueue({
    auditId: 'audit-queue-check', entries: [{ ...entry, evidenceUrl: foreign.evidenceUrl, sessionDigest: foreign.sessionDigest }],
  }), /RAW_NAVIGATION_INVALID/u);
  const expandedQuery = {
    ...queryEntry,
    evidenceUrl: { ...queryEntry.evidenceUrl, href: 'https://example.test/query-a?private=1', queryIncluded: true },
  };
  await assert.rejects(vault.putQueue({ auditId: 'audit-query-check', entries: [expandedQuery] }), /RAW_NAVIGATION_INVALID/u);
  await assert.rejects(vault.putQueue({
    auditId: 'audit-queue-check', entries: [{ ...entry, status: 'running' }],
  }), /RAW_NAVIGATION_INVALID/u);
  assert.equal(Object.keys(await sessionArea.get(null)).some(key => key.startsWith('audita:raw-navigation-queue:v1:')), false);
});

test('permits only immutable, one-step queue transitions', async () => {
  const { vault } = publicFixture();
  const entries = [await batchEntry(vault, 'audit-state', 1, 'state-a'), await batchEntry(vault, 'audit-state', 2, 'state-b')];
  await vault.putQueue({ auditId: 'audit-state', entries });
  const current = await vault.readQueue('audit-state');
  const impossible = structuredClone(current);
  impossible.revision = 2; impossible.nextIndex = 1; impossible.entries[1].status = 'running';
  await assert.rejects(vault.replaceQueue('audit-state', impossible, {
    expectedRevision: 1, expectedState: { nextIndex: 0, status: 'pending' },
  }), /fila de navegação desatualizada/iu);
  const mutatedMetadata = structuredClone(current);
  mutatedMetadata.revision = 2; mutatedMetadata.entries[0].evidenceUrl.href = 'https://example.test/other';
  await assert.rejects(vault.replaceQueue('audit-state', mutatedMetadata, {
    expectedRevision: 1, expectedState: { nextIndex: 0, status: 'pending' },
  }), /fila de navegação desatualizada/iu);
  const advanced = structuredClone(current);
  advanced.revision = 2; advanced.nextIndex = 1; advanced.entries[0].status = 'finished';
  await vault.replaceQueue('audit-state', advanced, {
    expectedRevision: 1, expectedState: { nextIndex: 0, status: 'pending' },
  });
});

test('rolls back partial writes and rejects backwards clocks without reanimating a token', async () => {
  const { sessionArea, clock, vault } = publicFixture();
  const originalSet = sessionArea.set.bind(sessionArea);
  let partial = true;
  sessionArea.set = async entries => {
    if (!partial || Object.hasOwn(entries, 'audita:session-hmac-key:v1')) return originalSet(entries);
    const [key] = Object.keys(entries);
    if (key.startsWith('audita:raw-navigation-queue:v1:')) sessionArea.values[key] = structuredClone(entries[key]);
    throw new Error('partial set');
  };
  await assert.rejects(vault.put('https://example.test/rollback?private=1', {
    auditId: 'audit-rollback', purpose: 'single-url', ttlMs: 600_000, includeQuery: false,
  }), /expirada ou consumida/iu);
  assert.equal(Object.keys(sessionArea.values).some(key => key.startsWith('audita:raw-navigation:v1:')), false);
  partial = false;
  const queueEntries = [
    await batchEntry(vault, 'audit-queue-rollback', 1, 'rollback-a'),
  ];
  clock.value += 1_000;
  queueEntries.push(await batchEntry(vault, 'audit-queue-rollback', 2, 'rollback-b'));
  partial = true;
  await assert.rejects(vault.putQueue({ auditId: 'audit-queue-rollback', entries: queueEntries }), /fila de navegação desatualizada/iu);
  assert.equal(Object.keys(sessionArea.values).some(key => key === 'audita:raw-navigation-queue:v1:audit-queue-rollback' ||
    queueEntries.some(entry => key === `audita:raw-navigation:v1:${entry.navigationToken}`)), false);
  partial = false;
  const issued = await vault.put('https://example.test/clock?private=1', {
    auditId: 'audit-clock', purpose: 'single-url', ttlMs: 600_000, includeQuery: false,
  });
  clock.value -= 1;
  await assert.rejects(vault.take(issued.navigationToken, { auditId: 'audit-clock', purpose: 'single-url' }), /expirada ou consumida/iu);
  assert.equal(Object.hasOwn(sessionArea.values, `audita:raw-navigation:v1:${issued.navigationToken}`), false);
});

test('invalidates queue tokens when a replace write and conservative restore both fail', async () => {
  const { sessionArea, vault } = publicFixture();
  const entries = [await batchEntry(vault, 'audit-replace-rollback', 1, 'replace-a')];
  await vault.putQueue({ auditId: 'audit-replace-rollback', entries });
  const current = await vault.readQueue('audit-replace-rollback');
  const desired = structuredClone(current);
  desired.revision = 2; desired.entries[0].status = 'running';
  const originalSet = sessionArea.set.bind(sessionArea);
  sessionArea.set = async writes => {
    const [key] = Object.keys(writes);
    sessionArea.values[key] = { corrupt: true };
    throw new Error('partial replace');
  };
  await assert.rejects(vault.replaceQueue('audit-replace-rollback', desired, {
    expectedRevision: 1, expectedState: { nextIndex: 0, status: 'pending' },
  }), /fila de navegação desatualizada/iu);
  sessionArea.set = originalSet;
  assert.equal(Object.hasOwn(sessionArea.values, 'audita:raw-navigation-queue:v1:audit-replace-rollback'), false);
  assert.equal(Object.hasOwn(sessionArea.values, `audita:raw-navigation:v1:${entries[0].navigationToken}`), false);
});

test('liquidates an expired queue and its tokens when replace observes the deadline', async () => {
  const { sessionArea, clock, vault } = publicFixture();
  const entries = [await batchEntry(vault, 'audit-replace-expired', 1, 'expired-a')];
  await vault.putQueue({ auditId: 'audit-replace-expired', entries });
  const current = await vault.readQueue('audit-replace-expired');
  const desired = structuredClone(current);
  desired.revision = 2; desired.entries[0].status = 'running';
  clock.value += 7_200_000;
  await assert.rejects(vault.replaceQueue('audit-replace-expired', desired, {
    expectedRevision: 1, expectedState: { nextIndex: 0, status: 'pending' },
  }), /fila de navegação desatualizada/iu);
  assert.equal(Object.hasOwn(sessionArea.values, 'audita:raw-navigation-queue:v1:audit-replace-expired'), false);
  assert.equal(Object.hasOwn(sessionArea.values, `audita:raw-navigation:v1:${entries[0].navigationToken}`), false);
});

test('cleans malformed namespace records without invoking scan accessors', async () => {
  const { sessionArea, vault } = publicFixture();
  sessionArea.values['audita:raw-navigation:v1:bad'] = { auditId: 'audit-clean', malformed: true };
  sessionArea.values['audita:raw-navigation-queue:v1:audit-clean'] = { malformed: true };
  assert.equal(await vault.clearAudit('audit-clean'), 2);
  sessionArea.values['audita:raw-navigation:v1:other'] = { malformed: true };
  sessionArea.values['audita:raw-navigation-queue:v1:other'] = { malformed: true };
  assert.equal(await vault.clearExpired(), 2);

  let getterCalls = 0;
  const hostileMap = {};
  Object.defineProperty(hostileMap, 'audita:raw-navigation:v1:hostile', {
    enumerable: true, get() { getterCalls += 1; throw new Error('getter executed'); },
  });
  const originalGet = sessionArea.get.bind(sessionArea);
  sessionArea.get = async key => key === null ? hostileMap : originalGet(key);
  await assert.rejects(vault.clearExpired(), /RAW_NAVIGATION_UNAVAILABLE/u);
  assert.equal(getterCalls, 0);
});

test('accepts an exact write that storage persists before throwing for one-shot and legacy records', async () => {
  for (const removeMode of ['noop', 'throw']) for (const kind of ['public', 'legacy']) {
    const { sessionArea, vault } = publicFixture();
    const originalSet = sessionArea.set.bind(sessionArea);
    sessionArea.set = async writes => {
      await originalSet(writes);
      if (Object.keys(writes).some(key => key.startsWith('audita:raw-navigation:v1:'))) throw new Error('set completed then threw');
    };
    sessionArea.removeMode = removeMode;
    const issued = kind === 'public'
      ? await vault.put('https://example.test/complete-then-throw?secret=1', {
        auditId: 'audit-complete', purpose: 'single-url', ttlMs: 600_000, includeQuery: false,
      })
      : await vault.putInternal({ ownerId: 'owner-complete', rawUrl: 'https://example.test/complete-then-throw?secret=1' });
    assert.match(issued.navigationToken, /^[A-Za-z0-9_-]{22}$/u);
    sessionArea.removeMode = 'normal';
    const raw = kind === 'public'
      ? await vault.take(issued.navigationToken, { auditId: 'audit-complete', purpose: 'single-url' })
      : await vault.takeInternal({ ownerId: 'owner-complete', navigationToken: issued.navigationToken });
    assert.equal(raw, 'https://example.test/complete-then-throw?secret=1');
  }
});

test('accepts exact queue and replace writes that storage persists before throwing', async () => {
  for (const removeMode of ['noop', 'throw']) {
    const { sessionArea, vault } = publicFixture();
    const entries = [await batchEntry(vault, 'audit-complete-queue', 1, 'complete-queue')];
    const originalSet = sessionArea.set.bind(sessionArea);
    sessionArea.set = async writes => {
      await originalSet(writes);
      if (Object.keys(writes).some(key => key.startsWith('audita:raw-navigation-queue:v1:'))) throw new Error('set completed then threw');
    };
    sessionArea.removeMode = removeMode;
    await vault.putQueue({ auditId: 'audit-complete-queue', entries });
    const current = await vault.readQueue('audit-complete-queue');
    const desired = structuredClone(current);
    desired.revision = 2;
    desired.entries[0].status = 'running';
    await vault.replaceQueue('audit-complete-queue', desired, {
      expectedRevision: 1, expectedState: { nextIndex: 0, status: 'pending' },
    });
    assert.equal((await vault.readQueue('audit-complete-queue')).revision, 2);
  }
});

test('blocks authority behind confirmed cleanup and never returns a partially persisted queue', async () => {
  const { sessionArea, clock, vault } = publicFixture();
  const entries = [await batchEntry(vault, 'audit-pending-cleanup', 1, 'pending-cleanup')];
  clock.value += 1_000;
  entries.push(await batchEntry(vault, 'audit-pending-cleanup', 2, 'pending-cleanup-later'));
  const originalSet = sessionArea.set.bind(sessionArea);
  sessionArea.set = async writes => {
    const queueKey = Object.keys(writes).find(key => key.startsWith('audita:raw-navigation-queue:v1:'));
    if (!queueKey) return originalSet(writes);
    sessionArea.values[queueKey] = structuredClone(writes[queueKey]);
    throw new Error('partial set');
  };
  sessionArea.removeMode = 'noop';
  await assert.rejects(vault.putQueue({ auditId: 'audit-pending-cleanup', entries }), /RAW_NAVIGATION_CLEANUP_PENDING/u);
  await assert.rejects(vault.readQueue('audit-pending-cleanup'), /RAW_NAVIGATION_CLEANUP_PENDING/u);
  await assert.rejects(vault.put('https://example.test/blocked?secret=1', {
    auditId: 'audit-blocked', purpose: 'single-url', ttlMs: 600_000, includeQuery: false,
  }), /RAW_NAVIGATION_CLEANUP_PENDING/u);
  sessionArea.removeMode = 'normal';
  assert.equal(await vault.readQueue('audit-pending-cleanup'), null);
  assert.equal(Object.keys(sessionArea.values).some(key => key.includes('audit-pending-cleanup')), false);
});

test('never returns a queue when one of its pending token records is incomplete', async () => {
  const { sessionArea, vault } = publicFixture();
  const entries = [await batchEntry(vault, 'audit-incomplete-read', 1, 'incomplete-read')];
  await vault.putQueue({ auditId: 'audit-incomplete-read', entries });
  delete sessionArea.values[`audita:raw-navigation:v1:${entries[0].navigationToken}`];
  await assert.rejects(vault.readQueue('audit-incomplete-read'), /fila de navegação desatualizada/iu);
  assert.equal(Object.hasOwn(sessionArea.values, 'audita:raw-navigation-queue:v1:audit-incomplete-read'), false);
});

test('copies evidence descriptors without invoking proxy gets and rejects queue no-op or terminal replacements', async () => {
  const { vault } = publicFixture();
  const entry = await batchEntry(vault, 'audit-proxy-entry', 1, 'proxy-entry');
  let getCalls = 0;
  const proxyEntry = { ...entry, evidenceUrl: new Proxy(entry.evidenceUrl, {
    get() { getCalls += 1; throw new Error('HOSTILE_PROXY_GET'); },
  }) };
  await vault.putQueue({ auditId: 'audit-proxy-entry', entries: [proxyEntry] });
  assert.equal(getCalls, 0);
  const running = await vault.readQueue('audit-proxy-entry');
  const noOp = structuredClone(running);
  noOp.revision = 2;
  await assert.rejects(vault.replaceQueue('audit-proxy-entry', noOp, {
    expectedRevision: 1, expectedState: { nextIndex: 0, status: 'pending' },
  }), /fila de navegação desatualizada/iu);
  const terminal = structuredClone(running);
  terminal.revision = 2;
  terminal.nextIndex = 1;
  terminal.entries[0].status = 'finished';
  await vault.replaceQueue('audit-proxy-entry', terminal, {
    expectedRevision: 1, expectedState: { nextIndex: 0, status: 'pending' },
  });
  const afterTerminal = structuredClone(terminal);
  afterTerminal.revision = 3;
  await assert.rejects(vault.replaceQueue('audit-proxy-entry', afterTerminal, {
    expectedRevision: 2, expectedState: { nextIndex: 1, status: 'finished' },
  }), /fila de navegação desatualizada/iu);
});
