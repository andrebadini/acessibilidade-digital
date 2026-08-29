import assert from 'node:assert/strict';
import test from 'node:test';

import { createRawNavigationVaultV1 } from '../../src/background/raw-navigation-vault.js';

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
      delete values[key];
    },
  };
}

function fixture() {
  const sessionArea = createSessionArea();
  let value = 0;
  const vault = createRawNavigationVaultV1({
    sessionArea,
    now: () => 1_788_000_000_000,
    randomBytes: length => new Uint8Array(length).fill(++value),
  });
  return { sessionArea, vault };
}

test('takes a raw URL once, erases it before return and never leaks it', async () => {
  const { sessionArea, vault } = fixture();
  assert.deepEqual(Object.keys(vault), ['putInternal', 'takeInternal', 'invalidateInternal']);
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
