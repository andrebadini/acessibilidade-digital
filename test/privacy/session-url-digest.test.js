import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import test from 'node:test';

import {
  SESSION_HMAC_KEY,
  createSessionHmacKeyBytes,
  createPixelAttemptDigest,
  createSessionPixelAttemptDigestAuthority,
  createSessionUrlDigest,
  createSessionUrlDigestManager,
} from '../../src/core/privacy/session-url-digest.js';

function createSessionArea(initial = {}) {
  const values = structuredClone(initial);
  const writes = [];
  return {
    writes,
    async get(key) {
      if (key === null) return structuredClone(values);
      if (typeof key === 'string') return Object.hasOwn(values, key) ? { [key]: structuredClone(values[key]) } : {};
      throw new TypeError('test storage key');
    },
    async set(entries) {
      writes.push(structuredClone(entries));
      Object.assign(values, structuredClone(entries));
    },
    async remove(key) {
      for (const value of Array.isArray(key) ? key : [key]) delete values[value];
    },
  };
}

test('exports the stateless HMAC primitives consumed by later milestones', async () => {
  const key = createSessionHmacKeyBytes(length => new Uint8Array(length).fill(7));
  assert.equal(key.byteLength, 32);
  assert.match(
    await createSessionUrlDigest('https://example.test/?secret=1', key, webcrypto.subtle),
    /^hmac-sha256:[A-Za-z0-9_-]{43}$/u,
  );
});

test('derives a domain-separated pixel attempt digest without widening the URL manager', async () => {
  const key = createSessionHmacKeyBytes(length => new Uint8Array(length).fill(7));
  const attempt = await createPixelAttemptDigest({
    auditId: 'audit-1', consentId: 'A'.repeat(22),
  }, key, webcrypto.subtle);
  const urlLike = await createSessionUrlDigest(
    `https://example.test/audit-1/${'A'.repeat(22)}`,
    key,
    webcrypto.subtle,
  );
  assert.match(attempt, /^hmac-sha256:[A-Za-z0-9_-]{43}$/u);
  assert.notEqual(attempt, urlLike);

  const sessionArea = createSessionArea();
  const authority = createSessionPixelAttemptDigestAuthority({
    sessionArea,
    subtle: webcrypto.subtle,
    randomBytes: length => new Uint8Array(length).fill(9),
    now: () => 123,
  });
  assert.deepEqual(Object.keys(authority), ['digestAttempt']);
  assert.equal(
    await authority.digestAttempt({ auditId: 'audit-1', consentId: 'A'.repeat(22) }),
    await authority.digestAttempt({ auditId: 'audit-1', consentId: 'A'.repeat(22) }),
  );
});

test('pixel attempt digest rejects malformed or accessor-bearing audit-consent pairs before HMAC', async () => {
  const key = new Uint8Array(32).fill(7);
  for (const value of [
    { auditId: 'audit-1', consentId: 'short' },
    { auditId: 'audit-1', consentId: 'A'.repeat(22), extra: true },
    Object.assign(Object.create({ inherited: true }), { auditId: 'audit-1', consentId: 'A'.repeat(22) }),
  ]) await assert.rejects(() => createPixelAttemptDigest(value, key, webcrypto.subtle), /PIXEL_ATTEMPT_DIGEST_INVALID/u);
  let getterCalls = 0;
  const hostile = { auditId: 'audit-1' };
  Object.defineProperty(hostile, 'consentId', { enumerable: true, get() { getterCalls += 1; return 'A'.repeat(22); } });
  await assert.rejects(() => createPixelAttemptDigest(hostile, key, webcrypto.subtle), /PIXEL_ATTEMPT_DIGEST_INVALID/u);
  assert.equal(getterCalls, 0);
});

test('rejects a non-byte or wrong-length CSPRNG result and invalid digest keys', async () => {
  for (const randomBytes of [() => new Array(32).fill(1), () => new Uint8Array(31), () => new Uint8Array(33)]) {
    assert.throws(() => createSessionHmacKeyBytes(randomBytes), /HMAC_KEY_GENERATION_FAILED/u);
  }
  for (const key of [new Array(32).fill(1), new Uint8Array(31), new Uint8Array(33)]) {
    await assert.rejects(
      () => createSessionUrlDigest('https://example.test/', key, webcrypto.subtle),
      /HMAC_KEY_INVALID/u,
    );
  }
});

test('rejects non-ArrayBuffer and non-32-byte HMAC signatures', async () => {
  const key = new Uint8Array(32).fill(7);
  for (const signature of [new Uint8Array(32), new ArrayBuffer(31), new ArrayBuffer(33), 'not-bytes']) {
    const subtle = {
      async importKey() { return {}; },
      async sign() { return signature; },
    };
    await assert.rejects(
      () => createSessionUrlDigest('https://example.test/', key, subtle),
      /HMAC_SIGNATURE_INVALID/u,
    );
  }
});

test('replaces a hostile key record without invoking accessors', async () => {
  let getterCalls = 0;
  const hostile = { version: 1, createdAt: 1 };
  Object.defineProperty(hostile, 'keyBase64Url', {
    enumerable: true,
    get() { getterCalls += 1; return 'A'.repeat(43); },
  });
  const sessionArea = createSessionArea();
  const originalGet = sessionArea.get;
  sessionArea.get = async key => sessionArea.writes.length === 0 && key === SESSION_HMAC_KEY
    ? { [key]: hostile }
    : originalGet.call(sessionArea, key);
  const manager = createSessionUrlDigestManager({
    sessionArea,
    subtle: webcrypto.subtle,
    randomBytes: length => new Uint8Array(length).fill(31),
    now: () => 10,
  });
  await manager.digest('https://example.test/');
  assert.equal(getterCalls, 0);
  assert.equal(sessionArea.writes.length, 1);
});

test('rejects a no-op HMAC key write and accepts commit-then-throw only after exact reread', async () => {
  const noOp = createSessionArea();
  noOp.set = async () => {};
  const denied = createSessionPixelAttemptDigestAuthority({
    sessionArea: noOp, subtle: webcrypto.subtle,
    randomBytes: length => new Uint8Array(length).fill(5), now: () => 10,
  });
  await assert.rejects(
    () => denied.digestAttempt({ auditId: 'audit-1', consentId: 'A'.repeat(21) + 'Q' }),
    /HMAC_KEY_GENERATION_FAILED/u,
  );

  const committed = createSessionArea();
  const baseSet = committed.set;
  committed.set = async entries => {
    await baseSet.call(committed, entries);
    throw new Error('native-private-error');
  };
  const accepted = createSessionPixelAttemptDigestAuthority({
    sessionArea: committed, subtle: webcrypto.subtle,
    randomBytes: length => new Uint8Array(length).fill(6), now: () => 10,
  });
  assert.match(
    await accepted.digestAttempt({ auditId: 'audit-1', consentId: 'A'.repeat(21) + 'Q' }),
    /^hmac-sha256:/u,
  );
});

test('digests the complete canonical URL and never stores its plaintext', async () => {
  const sessionArea = createSessionArea();
  const manager = createSessionUrlDigestManager({
    sessionArea,
    subtle: webcrypto.subtle,
    randomBytes: length => new Uint8Array(length).fill(11),
    now: () => 1_788_000_000_000,
  });
  const first = await manager.digest('https://example.test/a?token=SEGREDO-NAO-LOGAR#one');
  const changedQuery = await manager.digest('https://example.test/a?token=outro#one');
  const changedFragment = await manager.digest('https://example.test/a?token=SEGREDO-NAO-LOGAR#two');
  assert.notEqual(first, changedQuery);
  assert.notEqual(first, changedFragment);
  assert.doesNotMatch(JSON.stringify(await sessionArea.get(null)), /SEGREDO-NAO-LOGAR/u);
  assert.equal(sessionArea.writes.length, 1, 'the same valid session key is reused');
});

test('stores only one exact key record with an unpadded 32-byte base64url key', async () => {
  const sessionArea = createSessionArea();
  const manager = createSessionUrlDigestManager({
    sessionArea,
    subtle: webcrypto.subtle,
    randomBytes: length => new Uint8Array(length).fill(19),
    now: () => 123_456,
  });
  await manager.digest('https://example.test/');
  const stored = (await sessionArea.get(SESSION_HMAC_KEY))[SESSION_HMAC_KEY];
  assert.deepEqual(Object.keys(stored), ['version', 'keyBase64Url', 'createdAt']);
  assert.equal(stored.version, 1);
  assert.match(stored.keyBase64Url, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(stored.createdAt, 123_456);
  assert.deepEqual(Object.keys(await sessionArea.get(null)), [SESSION_HMAC_KEY]);
});

test('reuses an exact valid key record independently of property insertion order', async () => {
  const sessionArea = createSessionArea({
    [SESSION_HMAC_KEY]: {
      createdAt: 123_456,
      keyBase64Url: 'ExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExM',
      version: 1,
    },
  });
  const manager = createSessionUrlDigestManager({
    sessionArea,
    subtle: webcrypto.subtle,
    randomBytes: length => new Uint8Array(length).fill(99),
    now: () => 999,
  });
  await manager.digest('https://example.test/');
  assert.equal(sessionArea.writes.length, 0);
});

test('replaces every malformed key-record shape before digesting', async () => {
  const malformed = [
    { version: 1, keyBase64Url: 'A'.repeat(43), createdAt: 1, extra: true },
    { version: 1, keyBase64Url: 'A'.repeat(43) + '=', createdAt: 1 },
    { version: 1, keyBase64Url: '+'.repeat(43), createdAt: 1 },
    { version: 1, keyBase64Url: 'AQ', createdAt: 1 },
    { version: 1, keyBase64Url: 'A'.repeat(43), createdAt: 1.5 },
  ];
  for (const value of malformed) {
    const sessionArea = createSessionArea({ [SESSION_HMAC_KEY]: value });
    const manager = createSessionUrlDigestManager({
      sessionArea,
      subtle: webcrypto.subtle,
      randomBytes: length => new Uint8Array(length).fill(23),
      now: () => 99,
    });
    await manager.digest('https://example.test/');
    assert.deepEqual((await sessionArea.get(SESSION_HMAC_KEY))[SESSION_HMAC_KEY], {
      version: 1,
      keyBase64Url: 'FxcXFxcXFxcXFxcXFxcXFxcXFxcXFxcXFxcXFxcXFxc',
      createdAt: 99,
    });
  }
});

test('rejects noncanonical or non-HTTP URL strings before key persistence', async () => {
  const sessionArea = createSessionArea();
  const manager = createSessionUrlDigestManager({
    sessionArea,
    subtle: webcrypto.subtle,
    randomBytes: length => new Uint8Array(length).fill(1),
    now: () => 10,
  });
  for (const value of [' example.test ', 'https://EXAMPLE.test', 'chrome-extension://test/page.html']) {
    await assert.rejects(() => manager.digest(value), /HMAC_URL_INVALID/u);
  }
  assert.deepEqual(await sessionArea.get(null), {});
});

test('destroy wins against an interleaved digest and rejects later use', async () => {
  let releaseGet;
  const getGate = new Promise(resolve => { releaseGet = resolve; });
  const sessionArea = createSessionArea();
  const originalGet = sessionArea.get;
  sessionArea.get = async key => {
    await getGate;
    return originalGet.call(sessionArea, key);
  };
  const manager = createSessionUrlDigestManager({
    sessionArea,
    subtle: webcrypto.subtle,
    randomBytes: length => new Uint8Array(length).fill(29),
    now: () => 1,
  });
  assert.deepEqual(Object.keys(manager), ['digest', 'destroy']);
  const pending = manager.digest('https://example.test/?token=private');
  const destroyed = manager.destroy();
  releaseGet();
  await Promise.allSettled([pending, destroyed]);
  assert.deepEqual(await sessionArea.get(SESSION_HMAC_KEY), {});
  await assert.rejects(() => manager.digest('https://example.test/'), /HMAC_MANAGER_DESTROYED/u);
});

test('a new worker manager reuses a valid session key while a new session creates a new key', async () => {
  const firstSession = createSessionArea();
  const firstWorker = createSessionUrlDigestManager({
    sessionArea: firstSession, subtle: webcrypto.subtle,
    randomBytes: length => new Uint8Array(length).fill(3), now: () => 10,
  });
  const firstDigest = await firstWorker.digest('https://example.test/restart');
  const restartedWorker = createSessionUrlDigestManager({
    sessionArea: firstSession, subtle: webcrypto.subtle,
    randomBytes: length => new Uint8Array(length).fill(4), now: () => 11,
  });
  assert.equal(await restartedWorker.digest('https://example.test/restart'), firstDigest);
  assert.equal(firstSession.writes.length, 1);

  const secondSession = createSessionArea();
  const secondWorker = createSessionUrlDigestManager({
    sessionArea: secondSession, subtle: webcrypto.subtle,
    randomBytes: length => new Uint8Array(length).fill(4), now: () => 11,
  });
  assert.notEqual(await secondWorker.digest('https://example.test/restart'), firstDigest);
  assert.equal(secondSession.writes.length, 1);
});

test('concurrent digest callers create exactly one session HMAC key record', async () => {
  const sessionArea = createSessionArea();
  const manager = createSessionUrlDigestManager({
    sessionArea, subtle: webcrypto.subtle,
    randomBytes: length => new Uint8Array(length).fill(12), now: () => 123,
  });
  const digests = await Promise.all([
    manager.digest('https://example.test/concurrent-a'),
    manager.digest('https://example.test/concurrent-b'),
    manager.digest('https://example.test/concurrent-c'),
  ]);
  assert.equal(new Set(digests).size, 3);
  assert.equal(sessionArea.writes.filter(write => Object.hasOwn(write, SESSION_HMAC_KEY)).length, 1);
});

test('URL manager and pixel attempt authority converge on one confirmed session key under first-use concurrency', async () => {
  const sessionArea = createSessionArea();
  const urlManager = createSessionUrlDigestManager({
    sessionArea, subtle: webcrypto.subtle,
    randomBytes: length => new Uint8Array(length).fill(3), now: () => 100,
  });
  const attemptAuthority = createSessionPixelAttemptDigestAuthority({
    sessionArea, subtle: webcrypto.subtle,
    randomBytes: length => new Uint8Array(length).fill(4), now: () => 100,
  });
  const pair = { auditId: 'audit-concurrent', consentId: 'Z'.repeat(21) + 'g' };
  const [_urlDigest, firstAttempt] = await Promise.all([
    urlManager.digest('https://example.test/concurrent-authorities'),
    attemptAuthority.digestAttempt(pair),
  ]);
  const restarted = createSessionPixelAttemptDigestAuthority({
    sessionArea, subtle: webcrypto.subtle,
    randomBytes: length => new Uint8Array(length).fill(9), now: () => 101,
  });
  assert.equal(await restarted.digestAttempt(pair), firstAttempt);
  assert.equal(sessionArea.writes.filter(write => Object.hasOwn(write, SESSION_HMAC_KEY)).length, 1);
});

test('destroy linearizes after an in-flight attempt digest and prevents every later authority from recreating the key', async () => {
  const sessionArea = createSessionArea();
  let releaseSign;
  const signGate = new Promise(resolve => { releaseSign = resolve; });
  const subtle = {
    importKey: (...args) => webcrypto.subtle.importKey(...args),
    async sign(...args) { await signGate; return webcrypto.subtle.sign(...args); },
  };
  const attempt = createSessionPixelAttemptDigestAuthority({
    sessionArea, subtle, randomBytes: length => new Uint8Array(length).fill(7), now: () => 10,
  });
  const url = createSessionUrlDigestManager({
    sessionArea, subtle: webcrypto.subtle,
    randomBytes: length => new Uint8Array(length).fill(8), now: () => 10,
  });
  const pending = attempt.digestAttempt({ auditId: 'audit-1', consentId: 'A'.repeat(21) + 'Q' });
  const destroying = url.destroy();
  releaseSign();
  await pending;
  await destroying;
  assert.deepEqual(await sessionArea.get(SESSION_HMAC_KEY), {});
  const restarted = createSessionPixelAttemptDigestAuthority({
    sessionArea, subtle: webcrypto.subtle,
    randomBytes: length => new Uint8Array(length).fill(9), now: () => 11,
  });
  await assert.rejects(
    () => restarted.digestAttempt({ auditId: 'audit-1', consentId: 'A'.repeat(21) + 'Q' }),
    /HMAC_MANAGER_DESTROYED/u,
  );
  assert.deepEqual(await sessionArea.get(SESSION_HMAC_KEY), {});
});

test('destroy treats a surviving own accessor key as present without invoking it', async () => {
  let getterCalls = 0;
  const envelope = {};
  Object.defineProperty(envelope, SESSION_HMAC_KEY, {
    enumerable: true,
    get() { getterCalls += 1; return { version: 1 }; },
  });
  const sessionArea = {
    async get() { return envelope; },
    async set() {},
    async remove() {},
  };
  const manager = createSessionUrlDigestManager({
    sessionArea, subtle: webcrypto.subtle,
    randomBytes: length => new Uint8Array(length).fill(9), now: () => 11,
  });
  await assert.rejects(() => manager.destroy(), /HMAC_KEY_DESTRUCTION_FAILED/u);
  assert.equal(getterCalls, 0);
});
