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
  assert.equal(await vault.clearExpired(), 3);
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
