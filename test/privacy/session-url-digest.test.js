import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import test from 'node:test';

import {
  SESSION_HMAC_KEY,
  createSessionHmacKeyBytes,
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
