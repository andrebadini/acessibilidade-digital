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

function publicTakeOptions(issued, auditId, purpose) {
  return {
    auditId,
    purpose,
    expectedEvidenceUrl: issued.evidenceUrl,
    expectedSessionDigest: issued.sessionDigest,
  };
}

async function restartedPublicVault(sessionArea, clock) {
  const moduleUrl = new URL('../../src/background/raw-navigation-vault.js', import.meta.url);
  moduleUrl.searchParams.set('workerRestart', `${Date.now()}-${Math.random()}`);
  const { createRawNavigationVaultV1: createRestartedVault } = await import(moduleUrl.href);
  const digestManager = createSessionUrlDigestManager({
    sessionArea, subtle: webcrypto.subtle,
    randomBytes: length => new Uint8Array(length).fill(12), now: () => clock.value,
  });
  return createRestartedVault({
    sessionArea, digestManager, now: () => clock.value,
    randomBytes: length => new Uint8Array(length).fill(13),
  });
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
  assert.equal(await vault.take(issued.navigationToken, publicTakeOptions(issued, 'audit-1', 'single-url')),
    'https://example.test/a?secret=1');
  await assert.rejects(vault.take(issued.navigationToken, publicTakeOptions(issued, 'audit-1', 'single-url')),
    /expirada ou consumida/iu);
});

test('public vault consumes and denies a swapped private URL with the same sanitized evidence', async () => {
  const { sessionArea, vault } = publicFixture();
  const originalUrl = 'https://example.test/path?account=ORIGINAL#one';
  const swappedUrl = 'https://example.test/path?account=SWAPPED#two';
  const issued = await vault.put(originalUrl, {
    auditId: 'audit-swap', purpose: 'single-url', ttlMs: 600_000, includeQuery: false,
  });
  const key = `audita:raw-navigation:v1:${issued.navigationToken}`;
  sessionArea.values[key].rawUrl = swappedUrl;

  await assert.rejects(
    vault.take(issued.navigationToken, publicTakeOptions(issued, 'audit-swap', 'single-url')),
    error => {
      assert.match(error.message, /expirada ou consumida/iu);
      assert.doesNotMatch(error.message, /ORIGINAL|SWAPPED|account|hmac-sha256/iu);
      return true;
    },
  );
  assert.deepEqual(await sessionArea.get(key), {});
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
    await assert.rejects(vault.take(issued.navigationToken, publicTakeOptions(issued, 'audit-1', otherPurpose)),
      /finalidade não corresponde/iu);
    await assert.rejects(vault.take(issued.navigationToken, publicTakeOptions(issued, 'audit-2', purpose)),
      /auditoria não corresponde/iu);
    assert.equal(await vault.take(issued.navigationToken, publicTakeOptions(issued, 'audit-1', purpose)),
      `https://example.test/${purpose}`);
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
      error => error?.message === 'RAW_NAVIGATION_CLEANUP_PENDING',
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
    error => error?.message === 'RAW_NAVIGATION_CLEANUP_PENDING',
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
  assert.equal(await first.take(winner.navigationToken, publicTakeOptions(winner, 'audit-lock', 'single-url')),
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
  await assert.rejects(vault.take(issued.navigationToken, publicTakeOptions(issued, 'audit-clock', 'single-url')),
    /expirada ou consumida/iu);
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
      ? await vault.take(issued.navigationToken, publicTakeOptions(issued, 'audit-complete', 'single-url'))
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

test('persists failed public and legacy take cleanup across a restarted worker', async () => {
  const markerKey = 'audita:raw-navigation-cleanup:v1';
  for (const removeMode of ['noop', 'throw']) for (const kind of ['public', 'legacy']) {
    const { sessionArea, clock, vault } = publicFixture();
    const issued = kind === 'public'
      ? await vault.put('https://example.test/take-pending?secret=NEVER', {
        auditId: 'audit-take-pending', purpose: 'single-url', ttlMs: 600_000, includeQuery: false,
      })
      : await vault.putInternal({ ownerId: 'owner-take-pending', rawUrl: 'https://example.test/take-pending?secret=NEVER' });
    sessionArea.removeMode = removeMode;
    const consume = kind === 'public'
      ? () => vault.take(issued.navigationToken, publicTakeOptions(issued, 'audit-take-pending', 'single-url'))
      : () => vault.takeInternal({ ownerId: 'owner-take-pending', navigationToken: issued.navigationToken });
    await assert.rejects(consume(), /RAW_NAVIGATION_CLEANUP_PENDING/u);
    const marker = sessionArea.values[markerKey];
    assert.equal(marker.version, 1);
    assert.deepEqual(Object.keys(marker), ['version', 'scope', 'keys']);
    assert.equal(marker.scope, 'keys');
    assert.equal(marker.keys.every(key => /^audita:raw-navigation(?::|-)\w/u.test(key)), true);
    assert.doesNotMatch(JSON.stringify(marker), /NEVER|https:\/\//u);
    const restarted = await restartedPublicVault(sessionArea, clock);
    await assert.rejects(restarted.put('https://example.test/blocked?secret=NEVER', {
      auditId: 'audit-restart-blocked', purpose: 'single-url', ttlMs: 600_000, includeQuery: false,
    }), /RAW_NAVIGATION_CLEANUP_PENDING/u);
    sessionArea.removeMode = 'normal';
    const recovered = await restarted.put('https://example.test/recovered', {
      auditId: 'audit-restart-recovered', purpose: 'single-url', ttlMs: 600_000, includeQuery: false,
    });
    assert.match(recovered.navigationToken, /^[A-Za-z0-9_-]{22}$/u);
    assert.equal(Object.hasOwn(sessionArea.values, markerKey), false);
  }
});

test('persists a partial queue cleanup barrier across restart until removal recovers', async () => {
  const markerKey = 'audita:raw-navigation-cleanup:v1';
  const { sessionArea, clock, vault } = publicFixture();
  const entries = [await batchEntry(vault, 'audit-restart-queue', 1, 'restart-queue')];
  clock.value += 1_000;
  entries.push(await batchEntry(vault, 'audit-restart-queue', 2, 'restart-queue-later'));
  const originalSet = sessionArea.set.bind(sessionArea);
  sessionArea.set = async writes => {
    const queueKey = Object.keys(writes).find(key => key.startsWith('audita:raw-navigation-queue:v1:'));
    if (!queueKey) return originalSet(writes);
    sessionArea.values[queueKey] = structuredClone(writes[queueKey]);
    throw new Error('partial queue');
  };
  sessionArea.removeMode = 'noop';
  await assert.rejects(vault.putQueue({ auditId: 'audit-restart-queue', entries }), /RAW_NAVIGATION_CLEANUP_PENDING/u);
  assert.equal(Object.hasOwn(sessionArea.values, markerKey), true);
  const restarted = await restartedPublicVault(sessionArea, clock);
  await assert.rejects(restarted.readQueue('audit-restart-queue'), /RAW_NAVIGATION_CLEANUP_PENDING/u);
  sessionArea.removeMode = 'normal';
  assert.equal(await restarted.readQueue('audit-restart-queue'), null);
  assert.equal(Object.hasOwn(sessionArea.values, markerKey), false);
});

test('confirms a completed cleanup marker write without executing hostile marker getters', async () => {
  const markerKey = 'audita:raw-navigation-cleanup:v1';
  const { sessionArea, vault } = publicFixture();
  const issued = await vault.put('https://example.test/marker-write?secret=NEVER', {
    auditId: 'audit-marker-write', purpose: 'single-url', ttlMs: 600_000, includeQuery: false,
  });
  const originalSet = sessionArea.set.bind(sessionArea);
  let markerWrites = 0;
  sessionArea.set = async writes => {
    await originalSet(writes);
    if (Object.hasOwn(writes, markerKey)) { markerWrites += 1; throw new Error('marker persisted then threw'); }
  };
  assert.equal(await vault.take(issued.navigationToken,
    publicTakeOptions(issued, 'audit-marker-write', 'single-url')),
  'https://example.test/marker-write?secret=NEVER');
  assert.equal(markerWrites, 1);
  assert.equal(Object.hasOwn(sessionArea.values, markerKey), false);

  let getCalls = 0;
  const originalGet = sessionArea.get.bind(sessionArea);
  sessionArea.get = async key => key === markerKey ? { [markerKey]: new Proxy({ version: 1, keys: [] }, {
    get() { getCalls += 1; throw new Error('HOSTILE_MARKER_GET'); },
  }) } : originalGet(key);
  await assert.rejects(vault.put('https://example.test/marker-hostile', {
    auditId: 'audit-marker-hostile', purpose: 'single-url', ttlMs: 600_000, includeQuery: false,
  }), /RAW_NAVIGATION_CLEANUP_PENDING/u);
  assert.equal(getCalls, 0);

  const accessorMap = {};
  Object.defineProperty(accessorMap, markerKey, {
    enumerable: true,
    get() { getCalls += 1; throw new Error('HOSTILE_MARKER_ACCESSOR'); },
  });
  sessionArea.get = async key => key === markerKey ? accessorMap : originalGet(key);
  await assert.rejects(vault.put('https://example.test/marker-accessor', {
    auditId: 'audit-marker-accessor', purpose: 'single-url', ttlMs: 600_000, includeQuery: false,
  }), /RAW_NAVIGATION_CLEANUP_PENDING/u);
  assert.equal(getCalls, 0);
});

test('routes invalidate and audit cleanup removal failures through the persistent barrier', async () => {
  const { sessionArea, vault } = fixture();
  const legacy = await vault.putInternal({ ownerId: 'owner-cleanup', rawUrl: 'https://example.test/invalidate?secret=NEVER' });
  sessionArea.removeMode = 'noop';
  await assert.rejects(vault.invalidateInternal({ ownerId: 'owner-cleanup', navigationToken: legacy.navigationToken }), /RAW_NAVIGATION_CLEANUP_PENDING/u);
  await assert.rejects(vault.putInternal({ ownerId: 'owner-next', rawUrl: 'https://example.test/blocked' }), /RAW_NAVIGATION_CLEANUP_PENDING/u);
  sessionArea.removeMode = 'normal';
  await vault.putInternal({ ownerId: 'owner-after', rawUrl: 'https://example.test/after' });

  const { sessionArea: publicArea, vault: publicVault } = publicFixture();
  await publicVault.put('https://example.test/clear-audit?secret=NEVER', {
    auditId: 'audit-clear-pending', purpose: 'single-url', ttlMs: 600_000, includeQuery: false,
  });
  publicArea.removeMode = 'throw';
  await assert.rejects(publicVault.clearAudit('audit-clear-pending'), /RAW_NAVIGATION_CLEANUP_PENDING/u);
  publicArea.removeMode = 'normal';
  assert.equal(await publicVault.clearAudit('audit-clear-pending'), 0);
});

test('persists precise cleanup for malformed raw keys selected by audit cleanup', async () => {
  const markerKey = 'audita:raw-navigation-cleanup:v1';
  const rawKey = 'audita:raw-navigation:v1:not-a-token';
  const queueKey = 'audita:raw-navigation-queue:v1:not-an-audit!';
  const { sessionArea, clock, vault } = publicFixture();
  sessionArea.values[rawKey] = { auditId: 'audit-malformed-cleanup' };
  sessionArea.values[queueKey] = { malformed: true };
  sessionArea.removeMode = 'throw';
  await assert.rejects(vault.clearAudit('audit-malformed-cleanup'), /RAW_NAVIGATION_CLEANUP_PENDING/u);
  assert.deepEqual(sessionArea.values[markerKey], { version: 1, scope: 'audit', auditId: 'audit-malformed-cleanup' });
  const restarted = await restartedPublicVault(sessionArea, clock);
  await assert.rejects(restarted.put('https://example.test/blocked-after-audit', {
    auditId: 'audit-blocked-after-audit', purpose: 'single-url', ttlMs: 600_000, includeQuery: false,
  }), /RAW_NAVIGATION_CLEANUP_PENDING/u);
  sessionArea.removeMode = 'normal';
  await restarted.put('https://example.test/recovered-after-audit', {
    auditId: 'audit-recovered-after-audit', purpose: 'single-url', ttlMs: 600_000, includeQuery: false,
  });
  assert.equal(Object.hasOwn(sessionArea.values, rawKey), false);
  assert.equal(Object.hasOwn(sessionArea.values, queueKey), true);
  assert.equal(Object.hasOwn(sessionArea.values, markerKey), false);
});

test('persists precise cleanup for malformed expiry keys and escalates malformed markers', async () => {
  const markerKey = 'audita:raw-navigation-cleanup:v1';
  const rawKey = 'audita:raw-navigation:v1:bad';
  const queueKey = 'audita:raw-navigation-queue:v1:bad!';
  const { sessionArea, clock, vault } = publicFixture();
  sessionArea.values[rawKey] = { malformed: true };
  sessionArea.values[queueKey] = { malformed: true };
  sessionArea.removeMode = 'noop';
  await assert.rejects(vault.clearExpired(), /RAW_NAVIGATION_CLEANUP_PENDING/u);
  assert.deepEqual(sessionArea.values[markerKey], { version: 1, scope: 'expired', cutoff: clock.value });
  sessionArea.values[markerKey] = { version: 99, secret: 'forbidden' };
  const restarted = await restartedPublicVault(sessionArea, clock);
  await assert.rejects(restarted.readQueue('audit-any'), /RAW_NAVIGATION_CLEANUP_PENDING/u);
  assert.deepEqual(sessionArea.values[markerKey], { version: 1, scope: 'namespace' });
  sessionArea.removeMode = 'normal';
  await restarted.put('https://example.test/recovered-after-expiry', {
    auditId: 'audit-recovered-after-expiry', purpose: 'single-url', ttlMs: 600_000, includeQuery: false,
  });
  assert.equal(Object.hasOwn(sessionArea.values, rawKey), false);
  assert.equal(Object.hasOwn(sessionArea.values, queueKey), false);
  assert.equal(Object.hasOwn(sessionArea.values, markerKey), false);
});

test('escalates an oversized precise cleanup marker to descriptor-safe namespace cleanup', async () => {
  const markerKey = 'audita:raw-navigation-cleanup:v1';
  const { sessionArea, clock } = publicFixture();
  const keys = Array.from({ length: 257 }, (_unused, index) =>
    `audita:raw-navigation:v1:${String(index).padStart(22, 'A')}`);
  sessionArea.values[markerKey] = { version: 1, scope: 'keys', keys };
  let getterCalls = 0;
  let returnHostileMap = true;
  const hostileMap = {};
  Object.defineProperty(hostileMap, 'audita:raw-navigation:v1:hostile!', {
    enumerable: true,
    get() { getterCalls += 1; throw new Error('HOSTILE_NAMESPACE_GET'); },
  });
  const originalGet = sessionArea.get.bind(sessionArea);
  sessionArea.get = async key => key === null && returnHostileMap ? hostileMap : originalGet(key);
  sessionArea.removeMode = 'noop';
  const restarted = await restartedPublicVault(sessionArea, clock);
  await assert.rejects(restarted.put('https://example.test/oversized-blocked', {
    auditId: 'audit-oversized-blocked', purpose: 'single-url', ttlMs: 600_000, includeQuery: false,
  }), /RAW_NAVIGATION_CLEANUP_PENDING/u);
  assert.deepEqual(sessionArea.values[markerKey], { version: 1, scope: 'namespace' });
  assert.equal(getterCalls, 0);
  sessionArea.removeMode = 'normal';
  returnHostileMap = false;
  await restarted.put('https://example.test/oversized-recovered', {
    auditId: 'audit-oversized-recovered', purpose: 'single-url', ttlMs: 600_000, includeQuery: false,
  });
  assert.equal(getterCalls, 0);
  assert.equal(Object.hasOwn(sessionArea.values, markerKey), false);
});

test('quarantines an exact-shape invalid legacy record through restart without retaining its URL', async () => {
  const markerKey = 'audita:raw-navigation-cleanup:v1';
  const navigationToken = 'L'.repeat(22);
  const key = `audita:raw-navigation:v1:${navigationToken}`;
  const { sessionArea, clock, vault } = publicFixture();
  sessionArea.values[key] = {
    version: 999, navigationToken, ownerId: 'owner-invalid', rawUrl: 'https://example.test/legacy?secret=NEVER',
    issuedAt: 0, expiresAt: 'never', state: 'prepared',
  };
  sessionArea.removeMode = 'noop';
  await assert.rejects(vault.clearExpired(), /RAW_NAVIGATION_CLEANUP_PENDING/u);
  assert.deepEqual(sessionArea.values[markerKey], { version: 1, scope: 'expired', cutoff: clock.value });
  assert.doesNotMatch(JSON.stringify(sessionArea.values[markerKey]), /NEVER|https:\/\//u);
  const restarted = await restartedPublicVault(sessionArea, clock);
  await assert.rejects(restarted.put('https://example.test/blocked-invalid-legacy', {
    auditId: 'audit-invalid-legacy', purpose: 'single-url', ttlMs: 600_000, includeQuery: false,
  }), /RAW_NAVIGATION_CLEANUP_PENDING/u);
  sessionArea.removeMode = 'normal';
  await restarted.put('https://example.test/recovered-invalid-legacy', {
    auditId: 'audit-recovered-invalid-legacy', purpose: 'single-url', ttlMs: 600_000, includeQuery: false,
  });
  assert.equal(Object.hasOwn(sessionArea.values, key), false);
  assert.equal(Object.hasOwn(sessionArea.values, markerKey), false);
});

test('expires only semantically valid legacy records and purges exact invalid public and queue shapes', async () => {
  const { sessionArea, clock, vault } = publicFixture();
  const legacy = await vault.putInternal({ ownerId: 'owner-valid-expiry', rawUrl: 'https://example.test/legacy-valid' });
  const publicToken = 'P'.repeat(22);
  const queueAuditId = 'audit-invalid-queue';
  sessionArea.values[`audita:raw-navigation:v1:${publicToken}`] = {
    version: 'RawNavigationUrlV1', auditId: 'audit-invalid-public', purpose: 'single-url', rawUrl: 'https://example.test/public?secret=NEVER',
    issuedAt: NaN, expiresAt: 600_000,
  };
  sessionArea.values[`audita:raw-navigation-queue:v1:${queueAuditId}`] = {
    version: 999, auditId: queueAuditId, ownerOperationId: 'Q'.repeat(22), revision: 1,
    issuedAt: 0, expiresAt: 7_200_000, nextIndex: 0, entries: [],
  };
  clock.value += 60_000;
  assert.equal(await vault.clearExpired(), 3);
  assert.equal(Object.hasOwn(sessionArea.values, `audita:raw-navigation:v1:${legacy.navigationToken}`), false);
  assert.equal(Object.keys(sessionArea.values).some(key => key.includes('invalid-public') || key.includes(queueAuditId)), false);
});

test('purges canonical legacy public and queue records issued after the cleanup clock', async () => {
  const { sessionArea, clock, vault } = publicFixture();
  const futureIssuedAt = clock.value + 1_000;
  const legacyToken = 'F'.repeat(22);
  const publicToken = 'G'.repeat(22);
  sessionArea.values[`audita:raw-navigation:v1:${legacyToken}`] = {
    version: 1, navigationToken: legacyToken, ownerId: 'owner-future', rawUrl: 'https://example.test/legacy-future',
    issuedAt: futureIssuedAt, expiresAt: futureIssuedAt + 60_000, state: 'prepared',
  };
  sessionArea.values[`audita:raw-navigation:v1:${publicToken}`] = {
    version: 'RawNavigationUrlV1', auditId: 'audit-future-public', purpose: 'single-url', rawUrl: 'https://example.test/public-future',
    issuedAt: futureIssuedAt, expiresAt: futureIssuedAt + 600_000,
  };
  const entry = await batchEntry(vault, 'audit-future-queue', 1, 'future-queue');
  await vault.putQueue({ auditId: 'audit-future-queue', entries: [entry] });
  const queueKey = 'audita:raw-navigation-queue:v1:audit-future-queue';
  const queueTokenKey = `audita:raw-navigation:v1:${entry.navigationToken}`;
  sessionArea.values[queueKey].issuedAt += 1_000;
  sessionArea.values[queueKey].expiresAt += 1_000;
  sessionArea.values[queueTokenKey].issuedAt += 1_000;
  sessionArea.values[queueTokenKey].expiresAt += 1_000;
  assert.equal(await vault.clearExpired(), 4);
  assert.equal(Object.hasOwn(sessionArea.values, queueKey), false);
});

test('accepts destructive remove commit-then-throw for public legacy and pending marker cleanup', async () => {
  for (const kind of ['public', 'legacy']) {
    const { sessionArea, vault } = publicFixture();
    const issued = kind === 'public'
      ? await vault.put('https://example.test/remove-throw?secret=NEVER', {
        auditId: 'audit-remove-throw', purpose: 'single-url', ttlMs: 600_000, includeQuery: false,
      })
      : await vault.putInternal({ ownerId: 'owner-remove-throw', rawUrl: 'https://example.test/remove-throw?secret=NEVER' });
    const originalRemove = sessionArea.remove.bind(sessionArea);
    sessionArea.remove = async keys => { await originalRemove(keys); throw new Error('remove completed then threw'); };
    const raw = kind === 'public'
      ? await vault.take(issued.navigationToken, publicTakeOptions(issued, 'audit-remove-throw', 'single-url'))
      : await vault.takeInternal({ ownerId: 'owner-remove-throw', navigationToken: issued.navigationToken });
    assert.equal(raw, 'https://example.test/remove-throw?secret=NEVER');
  }

  const { sessionArea, vault } = publicFixture();
  const issued = await vault.put('https://example.test/marker-remove-throw?secret=NEVER', {
    auditId: 'audit-marker-remove-throw', purpose: 'single-url', ttlMs: 600_000, includeQuery: false,
  });
  sessionArea.removeMode = 'noop';
  await assert.rejects(vault.take(issued.navigationToken,
    publicTakeOptions(issued, 'audit-marker-remove-throw', 'single-url')),
  /RAW_NAVIGATION_CLEANUP_PENDING/u);
  sessionArea.removeMode = 'normal';
  const originalRemove = sessionArea.remove.bind(sessionArea);
  sessionArea.remove = async keys => { await originalRemove(keys); throw new Error('remove completed then threw'); };
  const recovered = await vault.put('https://example.test/marker-recovered', {
    auditId: 'audit-marker-recovered', purpose: 'single-url', ttlMs: 600_000, includeQuery: false,
  });
  assert.match(recovered.navigationToken, /^[A-Za-z0-9_-]{22}$/u);
});

test('clearAudit selects malformed raw and queue records by own auditId without selecting a foreign audit', async () => {
  const { sessionArea, vault } = publicFixture();
  const rawTarget = 'audita:raw-navigation:v1:not-a-token';
  const queueTarget = 'audita:raw-navigation-queue:v1:not-an-audit!';
  const canonicalQueueTarget = 'audita:raw-navigation-queue:v1:audit-clear-target';
  const foreign = `audita:raw-navigation:v1:${'Z'.repeat(22)}`;
  sessionArea.values[rawTarget] = { auditId: 'audit-clear-target', malformed: true };
  sessionArea.values[queueTarget] = { auditId: 'audit-clear-target', malformed: true };
  sessionArea.values[canonicalQueueTarget] = { auditId: 'audit-clear-foreign', malformed: true };
  sessionArea.values[foreign] = { auditId: 'audit-clear-foreign', malformed: true };
  assert.equal(await vault.clearAudit('audit-clear-target'), 2);
  assert.equal(Object.hasOwn(sessionArea.values, rawTarget), false);
  assert.equal(Object.hasOwn(sessionArea.values, queueTarget), true);
  assert.equal(Object.hasOwn(sessionArea.values, canonicalQueueTarget), false);
  assert.equal(Object.hasOwn(sessionArea.values, foreign), true);
});

test('persists malformed clearAudit keys precisely across restart without touching another audit', async () => {
  const markerKey = 'audita:raw-navigation-cleanup:v1';
  for (const removeMode of ['noop', 'throw']) {
    const target = `audita:raw-navigation:v1:${removeMode === 'noop' ? 'malformed-audit-a!' : 'x'.repeat(600)}`;
    const { sessionArea, clock, vault } = publicFixture();
    const foreign = await vault.put('https://example.test/audit-b?secret=NEVER', {
      auditId: 'audit-clear-b', purpose: 'single-url', ttlMs: 600_000, includeQuery: false,
    });
    const foreignKey = `audita:raw-navigation:v1:${foreign.navigationToken}`;
    sessionArea.values[target] = { auditId: 'audit-clear-a', malformed: true };
    sessionArea.removeMode = removeMode;
    await assert.rejects(vault.clearAudit('audit-clear-a'), /RAW_NAVIGATION_CLEANUP_PENDING/u);
    assert.deepEqual(sessionArea.values[markerKey], { version: 1, scope: 'audit', auditId: 'audit-clear-a' });
    assert.doesNotMatch(JSON.stringify(sessionArea.values[markerKey]), /NEVER|https:\/\//u);
    const restarted = await restartedPublicVault(sessionArea, clock);
    await assert.rejects(restarted.put('https://example.test/clear-audit-blocked', {
      auditId: 'audit-clear-blocked', purpose: 'single-url', ttlMs: 600_000, includeQuery: false,
    }), /RAW_NAVIGATION_CLEANUP_PENDING/u);
    sessionArea.removeMode = 'normal';
    await restarted.put('https://example.test/clear-audit-recovered', {
      auditId: 'audit-clear-recovered', purpose: 'single-url', ttlMs: 600_000, includeQuery: false,
    });
    assert.equal(Object.hasOwn(sessionArea.values, target), false);
    assert.equal(Object.hasOwn(sessionArea.values, foreignKey), true);
    assert.equal(Object.hasOwn(sessionArea.values, markerKey), false);
  }
});

test('forged queues never remove a foreign batch token during read or replace cleanup', async () => {
  for (const status of ['pending', 'running', 'finished']) {
    const { sessionArea, clock, vault } = publicFixture();
    const foreignEntry = await batchEntry(vault, `audit-foreign-${status}`, 1, `foreign-${status}`);
    const foreignKey = `audita:raw-navigation:v1:${foreignEntry.navigationToken}`;
    const foreignRecord = sessionArea.values[foreignKey];
    const auditId = `audit-forged-${status}`;
    const queueKey = `audita:raw-navigation-queue:v1:${auditId}`;
    sessionArea.values[queueKey] = {
      version: 1, auditId, ownerOperationId: 'O'.repeat(22), revision: 1,
      issuedAt: foreignRecord.issuedAt, expiresAt: foreignRecord.expiresAt,
      nextIndex: status === 'finished' ? 1 : 0,
      entries: [{ ...foreignEntry, status }],
    };
    await assert.rejects(vault.readQueue(auditId), /fila de navegação desatualizada/iu);
    assert.equal(Object.hasOwn(sessionArea.values, queueKey), false);
    assert.equal(Object.hasOwn(sessionArea.values, foreignKey), true);

    sessionArea.values[queueKey] = {
      version: 1, auditId, ownerOperationId: 'O'.repeat(22), revision: 1,
      issuedAt: foreignRecord.issuedAt, expiresAt: foreignRecord.expiresAt,
      nextIndex: status === 'finished' ? 1 : 0,
      entries: [{ ...foreignEntry, status }],
    };
    const desired = structuredClone(sessionArea.values[queueKey]);
    desired.revision = 2;
    if (status === 'pending') desired.entries[0].status = 'running';
    await assert.rejects(vault.replaceQueue(auditId, desired, {
      expectedRevision: 1, expectedState: { nextIndex: status === 'finished' ? 1 : 0, status },
    }), /fila de navegação desatualizada/iu);
    assert.equal(Object.hasOwn(sessionArea.values, queueKey), false);
    assert.equal(Object.hasOwn(sessionArea.values, foreignKey), true);
    clock.value = foreignRecord.expiresAt;
    sessionArea.values[queueKey] = {
      version: 1, auditId, ownerOperationId: 'O'.repeat(22), revision: 1,
      issuedAt: foreignRecord.issuedAt, expiresAt: foreignRecord.expiresAt,
      nextIndex: status === 'finished' ? 1 : 0,
      entries: [{ ...foreignEntry, status }],
    };
    await assert.rejects(vault.replaceQueue(auditId, desired, {
      expectedRevision: 1, expectedState: { nextIndex: status === 'finished' ? 1 : 0, status },
    }), /fila de navegação desatualizada/iu);
    assert.equal(Object.hasOwn(sessionArea.values, queueKey), false);
    assert.equal(Object.hasOwn(sessionArea.values, foreignKey), true);
  }
});

test('journals audit cleanup by auditId without leaking malformed key names or deleting a foreign audit', async () => {
  const markerKey = 'audita:raw-navigation-cleanup:v1';
  for (const removeMode of ['noop', 'throw']) {
    const { sessionArea, clock, vault } = publicFixture();
    const foreign = await vault.put('https://example.test/audit-b?secret=NEVER', {
      auditId: 'audit-journal-b', purpose: 'single-url', ttlMs: 600_000, includeQuery: false,
    });
    const foreignKey = `audita:raw-navigation:v1:${foreign.navigationToken}`;
    const targetKeys = Array.from({ length: 257 }, (_unused, index) =>
      `audita:raw-navigation:v1:https://example.test/audit-a/${index}?secret=NEVER`);
    for (const key of targetKeys) sessionArea.values[key] = { auditId: 'audit-journal-a', malformed: true };
    sessionArea.removeMode = removeMode;
    await assert.rejects(vault.clearAudit('audit-journal-a'), /RAW_NAVIGATION_CLEANUP_PENDING/u);
    assert.deepEqual(sessionArea.values[markerKey], { version: 1, scope: 'audit', auditId: 'audit-journal-a' });
    assert.doesNotMatch(JSON.stringify(sessionArea.values[markerKey]), /NEVER|https:\/\//u);
    const restarted = await restartedPublicVault(sessionArea, clock);
    await assert.rejects(restarted.put('https://example.test/audit-journal-blocked', {
      auditId: 'audit-journal-blocked', purpose: 'single-url', ttlMs: 600_000, includeQuery: false,
    }), /RAW_NAVIGATION_CLEANUP_PENDING/u);
    sessionArea.removeMode = 'normal';
    await restarted.put('https://example.test/audit-journal-recovered', {
      auditId: 'audit-journal-recovered', purpose: 'single-url', ttlMs: 600_000, includeQuery: false,
    });
    assert.equal(targetKeys.every(key => !Object.hasOwn(sessionArea.values, key)), true);
    assert.equal(Object.hasOwn(sessionArea.values, foreignKey), true);
    assert.equal(Object.hasOwn(sessionArea.values, markerKey), false);
  }
});

test('journals expiry cleanup by cutoff without deleting nonexpired foreign authority', async () => {
  const markerKey = 'audita:raw-navigation-cleanup:v1';
  for (const removeMode of ['noop', 'throw']) {
    const { sessionArea, clock, vault } = publicFixture();
    const foreign = await vault.put('https://example.test/expiry-b?secret=NEVER', {
      auditId: 'audit-expiry-b', purpose: 'single-url', ttlMs: 600_000, includeQuery: false,
    });
    const foreignKey = `audita:raw-navigation:v1:${foreign.navigationToken}`;
    const targetKeys = Array.from({ length: 257 }, (_unused, index) =>
      `audita:raw-navigation:v1:https://example.test/expiry-a/${index}?secret=NEVER`);
    for (const key of targetKeys) sessionArea.values[key] = { malformed: true };
    sessionArea.removeMode = removeMode;
    await assert.rejects(vault.clearExpired(), /RAW_NAVIGATION_CLEANUP_PENDING/u);
    assert.deepEqual(sessionArea.values[markerKey], { version: 1, scope: 'expired', cutoff: clock.value });
    assert.doesNotMatch(JSON.stringify(sessionArea.values[markerKey]), /NEVER|https:\/\//u);
    const restarted = await restartedPublicVault(sessionArea, clock);
    await assert.rejects(restarted.put('https://example.test/expiry-journal-blocked', {
      auditId: 'audit-expiry-blocked', purpose: 'single-url', ttlMs: 600_000, includeQuery: false,
    }), /RAW_NAVIGATION_CLEANUP_PENDING/u);
    sessionArea.removeMode = 'normal';
    await restarted.put('https://example.test/expiry-journal-recovered', {
      auditId: 'audit-expiry-recovered', purpose: 'single-url', ttlMs: 600_000, includeQuery: false,
    });
    assert.equal(targetKeys.every(key => !Object.hasOwn(sessionArea.values, key)), true);
    assert.equal(Object.hasOwn(sessionArea.values, foreignKey), true);
    assert.equal(Object.hasOwn(sessionArea.values, markerKey), false);
  }
});

test('queues a persistent cleanup barrier when queue token reads are unavailable', async () => {
  const markerKey = 'audita:raw-navigation-cleanup:v1';
  for (const method of ['read', 'replace']) for (const status of ['pending', 'running', 'finished']) {
    const { sessionArea, clock, vault } = publicFixture();
    const auditId = `audit-queue-read-${method}-${status}`;
    const entry = await batchEntry(vault, auditId, 1, `${method}-${status}`);
    await vault.putQueue({ auditId, entries: [entry] });
    const queueKey = `audita:raw-navigation-queue:v1:${auditId}`;
    const tokenKey = `audita:raw-navigation:v1:${entry.navigationToken}`;
    const current = structuredClone(sessionArea.values[queueKey]);
    current.nextIndex = status === 'finished' ? 1 : 0;
    current.entries[0].status = status;
    sessionArea.values[queueKey] = current;
    const foreign = await batchEntry(vault, `audit-queue-foreign-${method}-${status}`, 1, `foreign-${method}-${status}`);
    const foreignKey = `audita:raw-navigation:v1:${foreign.navigationToken}`;
    const originalGet = sessionArea.get.bind(sessionArea);
    sessionArea.get = async key => key === tokenKey ? Promise.reject(new Error('TOKEN_READ_UNAVAILABLE')) : originalGet(key);
    const run = method === 'read'
      ? () => vault.readQueue(auditId)
      : () => {
        const desired = structuredClone(current);
        desired.revision = 2;
        if (status === 'pending') desired.entries[0].status = 'running';
        return vault.replaceQueue(auditId, desired, {
          expectedRevision: 1, expectedState: { nextIndex: current.nextIndex, status },
        });
      };
    await assert.rejects(run(), /RAW_NAVIGATION_CLEANUP_PENDING/u);
    assert.deepEqual(sessionArea.values[markerKey], { version: 1, scope: 'queue', auditId });
    assert.equal(Object.hasOwn(sessionArea.values, queueKey), true);
    assert.equal(Object.hasOwn(sessionArea.values, tokenKey), true);
    const restarted = await restartedPublicVault(sessionArea, clock);
    await assert.rejects(restarted.put('https://example.test/queue-read-blocked', {
      auditId: 'audit-queue-read-blocked', purpose: 'single-url', ttlMs: 600_000, includeQuery: false,
    }), /RAW_NAVIGATION_CLEANUP_PENDING/u);
    sessionArea.get = originalGet;
    await restarted.put('https://example.test/queue-read-recovered', {
      auditId: 'audit-queue-read-recovered', purpose: 'single-url', ttlMs: 600_000, includeQuery: false,
    });
    assert.equal(Object.hasOwn(sessionArea.values, queueKey), false);
    assert.equal(Object.hasOwn(sessionArea.values, tokenKey), false);
    assert.equal(Object.hasOwn(sessionArea.values, foreignKey), true);
    assert.equal(Object.hasOwn(sessionArea.values, markerKey), false);
  }
});

test('recovers a valid queue marker when its queue is absent or malformed without guessing token ownership', async () => {
  const markerKey = 'audita:raw-navigation-cleanup:v1';
  for (const state of ['absent', 'malformed']) {
    const auditId = `audit-queue-${state}`;
    const queueKey = `audita:raw-navigation-queue:v1:${auditId}`;
    const { sessionArea, clock } = publicFixture();
    sessionArea.values[markerKey] = { version: 1, scope: 'queue', auditId };
    if (state === 'malformed') sessionArea.values[queueKey] = { malformed: true };
    const restarted = await restartedPublicVault(sessionArea, clock);
    await restarted.put('https://example.test/queue-marker-recovered', {
      auditId: `audit-queue-marker-${state}`, purpose: 'single-url', ttlMs: 600_000, includeQuery: false,
    });
    assert.equal(Object.hasOwn(sessionArea.values, queueKey), false);
    assert.equal(Object.hasOwn(sessionArea.values, markerKey), false);
  }
});

test('clearAudit treats only its exact queue key and proven raw records as audit authority', async () => {
  const markerKey = 'audita:raw-navigation-cleanup:v1';
  for (const removeMode of ['normal', 'noop', 'throw']) {
    const { sessionArea, clock, vault } = publicFixture();
    const queueA = 'audita:raw-navigation-queue:v1:audit-authority-a';
    const rawA = 'audita:raw-navigation:v1:https://example.test/a?secret=NEVER';
    const queueB = 'audita:raw-navigation-queue:v1:audit-authority-b';
    const rawB = 'audita:raw-navigation:v1:not-a-token-b';
    const hostileQueue = 'audita:raw-navigation-queue:v1:https://example.test/a?secret=NEVER';
    sessionArea.values[queueA] = { auditId: 'audit-authority-b', malformed: true };
    sessionArea.values[rawA] = { auditId: 'audit-authority-a', malformed: true };
    sessionArea.values[queueB] = { auditId: 'audit-authority-a', malformed: true };
    sessionArea.values[rawB] = { auditId: 'audit-authority-b', malformed: true };
    sessionArea.values[hostileQueue] = { auditId: 'audit-authority-a', malformed: true };
    sessionArea.removeMode = removeMode;
    if (removeMode === 'normal') {
      assert.equal(await vault.clearAudit('audit-authority-a'), 2);
    } else {
      await assert.rejects(vault.clearAudit('audit-authority-a'), /RAW_NAVIGATION_CLEANUP_PENDING/u);
      assert.deepEqual(sessionArea.values[markerKey], { version: 1, scope: 'audit', auditId: 'audit-authority-a' });
      assert.doesNotMatch(JSON.stringify(sessionArea.values[markerKey]), /NEVER|https:\/\//u);
      const restarted = await restartedPublicVault(sessionArea, clock);
      await assert.rejects(restarted.put('https://example.test/audit-authority-blocked', {
        auditId: 'audit-authority-blocked', purpose: 'single-url', ttlMs: 600_000, includeQuery: false,
      }), /RAW_NAVIGATION_CLEANUP_PENDING/u);
      sessionArea.removeMode = 'normal';
      await restarted.put('https://example.test/audit-authority-recovered', {
        auditId: 'audit-authority-recovered', purpose: 'single-url', ttlMs: 600_000, includeQuery: false,
      });
    }
    assert.equal(Object.hasOwn(sessionArea.values, queueA), false);
    assert.equal(Object.hasOwn(sessionArea.values, rawA), false);
    assert.equal(Object.hasOwn(sessionArea.values, queueB), true);
    assert.equal(Object.hasOwn(sessionArea.values, rawB), true);
    assert.equal(Object.hasOwn(sessionArea.values, hostileQueue), true);
  }
});

test('keeps a queue valid after consuming its running entry while preserving the next pending token', async () => {
  const { sessionArea, clock, vault } = publicFixture();
  const auditId = 'audit-running-consumed';
  const entries = [
    await batchEntry(vault, auditId, 1, 'running-consumed-one'),
    await batchEntry(vault, auditId, 2, 'running-consumed-two'),
  ];
  await vault.putQueue({ auditId, entries });
  const pending = await vault.readQueue(auditId);
  const running = structuredClone(pending);
  running.revision = 2;
  running.entries[0].status = 'running';
  await vault.replaceQueue(auditId, running, {
    expectedRevision: 1, expectedState: { nextIndex: 0, status: 'pending' },
  });
  assert.equal(await vault.take(entries[0].navigationToken, publicTakeOptions(entries[0], auditId, 'batch-page')),
    'https://example.test/running-consumed-one?private=1');
  const restarted = await restartedPublicVault(sessionArea, clock);
  const afterConsumption = await restarted.readQueue(auditId);
  assert.equal(afterConsumption.entries[0].status, 'running');
  assert.equal(Object.hasOwn(sessionArea.values, `audita:raw-navigation:v1:${entries[1].navigationToken}`), true);
  const finished = structuredClone(afterConsumption);
  finished.revision = 3;
  finished.nextIndex = 1;
  finished.entries[0].status = 'finished';
  await restarted.replaceQueue(auditId, finished, {
    expectedRevision: 2, expectedState: { nextIndex: 0, status: 'running' },
  });
  const afterFinished = await restarted.readQueue(auditId);
  assert.equal(afterFinished.nextIndex, 1);
  assert.equal(afterFinished.entries[1].status, 'pending');
  assert.equal(await restarted.take(entries[1].navigationToken, publicTakeOptions(entries[1], auditId, 'batch-page')),
    'https://example.test/running-consumed-two?private=2');
});
