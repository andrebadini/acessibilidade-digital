import assert from 'node:assert/strict';
import test from 'node:test';

import { createPixelCaptureStateV1 } from '../../src/background/pixel-capture-consent.js';
import { createCapturePolicyV1 } from '../../src/core/privacy/capture-policy.js';
import { sanitizeEvidenceUrlV1 } from '../../src/core/privacy/evidence-url.js';

const NOW = 1_800_000_000_000;
const TEN_MINUTES = 600_000;
const DIGEST = `hmac-sha256:${'a'.repeat(43)}`;
const JOURNAL_PREFIX = 'audita:pixel-capture:v1:';

function clone(value) { return value === undefined ? undefined : structuredClone(value); }

function memorySessionArea(initial = {}) {
  const values = clone(initial);
  const calls = { get: 0, set: 0, remove: 0 };
  return {
    values, calls,
    async get(key) {
      calls.get += 1;
      if (key === null) return clone(values);
      return { [key]: clone(values[key]) };
    },
    async set(input) { calls.set += 1; Object.assign(values, clone(input)); },
    async remove(key) {
      calls.remove += 1;
      for (const item of Array.isArray(key) ? key : [key]) delete values[item];
    },
  };
}

function bytesFactory() {
  let next = 1;
  return length => new Uint8Array(length).fill(next++);
}

function stateFixture({ sessionArea = memorySessionArea(), now = () => NOW } = {}) {
  return { sessionArea, state: createPixelCaptureStateV1({ sessionArea, now, randomBytes: bytesFactory() }) };
}

function target(documentId = 'doc-a') {
  return {
    version: 'ObservedTargetV1',
    kind: 'attached',
    tabId: 7,
    windowId: 3,
    documentId,
    urlEvidence: sanitizeEvidenceUrlV1('https://example.test/account?secret=1'),
    urlSessionDigest: DIGEST,
  };
}

const fullEvidence = createCapturePolicyV1({ mode: 'full-evidence', includeQuery: false });

function pauseInput(overrides = {}) {
  return {
    auditId: 'audit-1', observedTarget: target(), mode: 'full-evidence', capturePolicy: fullEvidence,
    categories: ['password', 'otp'], authorityExpiresAt: NOW + TEN_MINUTES,
    ...overrides,
  };
}

function proof(documentId = 'doc-a') {
  return {
    kind: 'attached', tabId: 7, windowId: 3, documentId,
    urlSessionDigest: DIGEST,
  };
}

test('pauses under one closed journal then claims once with exact audit tab document mode and categories', async () => {
  const { sessionArea, state } = stateFixture();
  const paused = await state.pause(pauseInput());
  assert.deepEqual(paused, {
    version: 'AuditSuspensionV1', revision: 1, auditId: 'audit-1', consentId: paused.consentId,
    tabId: 7, windowId: 3, documentId: 'doc-a', mode: 'full-evidence', capturePolicy: fullEvidence,
    categories: ['password', 'otp'], issuedAt: NOW, updatedAt: NOW, expiresAt: NOW + TEN_MINUTES,
    cleanupAttempts: 0, cleanupNotBefore: null,
    state: 'paused', resumePhase: null, revokeReason: null,
    urlEvidence: target().urlEvidence, urlSessionDigest: DIGEST, source: { kind: 'attached' },
  });
  assert.equal(Object.isFrozen(paused), true);
  assert.equal(Object.isFrozen(paused.categories), true);
  assert.deepEqual(Object.keys(sessionArea.values), [`${JOURNAL_PREFIX}audit-1`]);
  assert.equal(JSON.stringify(sessionArea.values).includes('secret=1'), false);

  const claim = await state.claimAndBeginResume({
    auditId: 'audit-1', consentId: paused.consentId, proof: proof(), mode: 'full-evidence', categories: ['password', 'otp'],
  });
  assert.deepEqual(claim, {
    version: 'PixelCaptureClaimV1', auditId: 'audit-1', consentId: paused.consentId,
    tabId: 7, windowId: 3, documentId: 'doc-a', mode: 'full-evidence', categories: ['password', 'otp'],
    urlSessionDigest: DIGEST, expiresAt: NOW + TEN_MINUTES, source: { kind: 'attached' }, claimedAt: NOW,
  });
  await assert.rejects(state.claimAndBeginResume({
    auditId: 'audit-1', consentId: paused.consentId, proof: proof(), mode: 'full-evidence', categories: ['password', 'otp'],
  }), /PIXEL_CONSENT_ALREADY_USED/u);
});

test('atomically revokes a binding mismatch before reporting document changed', async () => {
  const { state } = stateFixture();
  const paused = await state.pause(pauseInput());
  await assert.rejects(state.claimAndBeginResume({ auditId: 'audit-1', consentId: paused.consentId, proof: proof('doc-b'), mode: 'full-evidence', categories: ['password', 'otp'] }), /PIXEL_CONSENT_DOCUMENT_CHANGED/u);
  const revoked = await state.readSuspension('audit-1');
  assert.deepEqual([revoked.state, revoked.revokeReason], ['revoked', 'PIXEL_CONSENT_DOCUMENT_CHANGED']);
});

test('rotates consent on every sensitive signal drift without extending its absolute deadline', async () => {
  const { state } = stateFixture();
  const paused = await state.pause(pauseInput());
  for (const categories of [[], ['password'], ['password', 'payment']]) {
    const current = await state.readSuspension('audit-1');
    await assert.rejects(state.claimAndBeginResume({
      auditId: 'audit-1', consentId: current.consentId, proof: proof(), mode: 'full-evidence', categories,
    }), /PIXEL_CONSENT_SIGNALS_CHANGED/u);
    const replacement = await state.readSuspension('audit-1');
    assert.equal(replacement.state, 'paused');
    assert.equal(replacement.expiresAt, paused.expiresAt);
    assert.notEqual(replacement.consentId, paused.consentId);
  }
});

test('treats the same sensitive category set in a different order as unchanged', async () => {
  const { state } = stateFixture();
  const paused = await state.pause(pauseInput());
  const claim = await state.claimAndBeginResume({ auditId: 'audit-1', consentId: paused.consentId, proof: proof(), mode: 'full-evidence', categories: ['otp', 'password'] });
  assert.equal(claim.consentId, paused.consentId);
});

test('rejects an approval delayed behind a rotated consent without consuming the replacement', async () => {
  const { state } = stateFixture();
  const first = await state.pause(pauseInput({ categories: ['password'] }));
  await assert.rejects(state.claimAndBeginResume({
    auditId: 'audit-1', consentId: first.consentId, proof: proof(), mode: 'full-evidence', categories: ['otp'],
  }), /PIXEL_CONSENT_SIGNALS_CHANGED/u);
  const replacement = await state.readSuspension('audit-1');
  await assert.rejects(state.claimAndBeginResume({
    auditId: 'audit-1', consentId: first.consentId, proof: proof(), mode: 'full-evidence', categories: ['password'],
  }), /PIXEL_CONSENT_STALE/u);
  assert.equal((await state.readSuspension('audit-1')).consentId, replacement.consentId);
  assert.equal((await state.readSuspension('audit-1')).state, 'paused');
});

test('allows only write-ahead resume phases and removes a matching terminal journal', async () => {
  const { state } = stateFixture();
  const paused = await state.pause(pauseInput({ categories: ['payment'] }));
  await state.claimAndBeginResume({
    auditId: 'audit-1', consentId: paused.consentId, proof: proof(), mode: 'full-evidence', categories: ['payment'],
  });
  await state.markSessionRunning({ auditId: 'audit-1', consentId: paused.consentId });
  const running = await state.gateRunnerStart({ auditId: 'audit-1', consentId: paused.consentId, proof: proof(), categories: ['payment'] });
  assert.equal(running.status, 'ready');
  assert.equal(await state.finish({ auditId: 'audit-1', consentId: paused.consentId }), true);
  assert.equal(await state.readSuspension('audit-1'), null);
  assert.equal(await state.finish({ auditId: 'audit-1', consentId: paused.consentId }), false);
});

test('serializes separate factories and accepts a confirmed set commit that throws', async () => {
  const sessionArea = memorySessionArea();
  const originalSet = sessionArea.set.bind(sessionArea);
  let first = true;
  sessionArea.set = async input => {
    await originalSet(input);
    if (first) { first = false; throw new Error('commit then throw'); }
  };
  const firstState = createPixelCaptureStateV1({ sessionArea, now: () => NOW, randomBytes: bytesFactory() });
  const secondState = createPixelCaptureStateV1({ sessionArea, now: () => NOW, randomBytes: bytesFactory() });
  const [one, two] = await Promise.allSettled([
    firstState.pause(pauseInput()), secondState.pause(pauseInput()),
  ]);
  assert.equal([one, two].filter(result => result.status === 'fulfilled').length, 1);
  assert.equal((await secondState.readSuspension('audit-1')).revision, 1);
});

test('fails closed on malformed records, time rollback, expired pause, and hostile descriptors', async () => {
  const { sessionArea, state } = stateFixture({ now: (() => { let value = NOW; return () => value; })() });
  sessionArea.values[`${JOURNAL_PREFIX}audit-1`] = { version: 'PixelCaptureJournalV1', auditId: 'audit-1' };
  await assert.rejects(state.readSuspension('audit-1'), /PIXEL_STATE_UNAVAILABLE/u);

  let getterReads = 0;
  const hostile = {};
  Object.defineProperty(hostile, 'auditId', { enumerable: true, get() { getterReads += 1; throw new Error('GET'); } });
  sessionArea.values[`${JOURNAL_PREFIX}audit-2`] = hostile;
  await assert.rejects(state.listSuspensions({ limit: 25 }), /PIXEL_STATE_UNAVAILABLE/u);
  // The storage fake clones before the vault receives the record; parser paths
  // themselves remain descriptor-only; a failed global storage read is closed.
  assert.equal(getterReads <= 1, true);
});

test('rejects a capture policy with a hostile prototype before persisting a journal', async () => {
  const { sessionArea, state } = stateFixture();
  const hostilePolicy = Object.assign(Object.create({ inherited: true }), fullEvidence);
  await assert.rejects(state.pause(pauseInput({ capturePolicy: hostilePolicy })), /PIXEL_STATE_UNAVAILABLE/u);
  assert.deepEqual(sessionArea.values, {});
});

test('rejects no-pixels before random generation or session persistence', async () => {
  const sessionArea = memorySessionArea();
  let randomCalls = 0;
  const state = createPixelCaptureStateV1({ sessionArea, now: () => NOW, randomBytes(length) { randomCalls += 1; return new Uint8Array(length); } });
  await assert.rejects(state.pause(pauseInput({ mode: 'no-pixels', capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }) })), /PIXEL_STATE_UNAVAILABLE/u);
  assert.equal(randomCalls, 0);
  assert.deepEqual(sessionArea.values, {});
});

test('rejects an evidence query not authorized by policy before entropy or persistence', async () => {
  const sessionArea = memorySessionArea();
  let randomCalls = 0;
  const state = createPixelCaptureStateV1({
    sessionArea,
    now: () => NOW,
    randomBytes(length) { randomCalls += 1; return new Uint8Array(length); },
  });
  const observedTarget = target();
  observedTarget.urlEvidence = sanitizeEvidenceUrlV1('https://example.test/account?private=NEVER_STORE', { includeQuery: true });

  await assert.rejects(state.pause(pauseInput({ observedTarget })), /PIXEL_STATE_UNAVAILABLE/u);
  assert.equal(randomCalls, 0);
  assert.equal(sessionArea.calls.set, 0);
  assert.deepEqual(sessionArea.values, {});
});

test('emits and accepts only canonical sixteen-byte base64url consent ids', async () => {
  const { sessionArea, state } = stateFixture();
  const paused = await state.pause(pauseInput());
  assert.match(paused.consentId, /^[A-Za-z0-9_-]{21}[AQgw]$/u);

  const key = `${JOURNAL_PREFIX}audit-1`;
  sessionArea.values[key].consentId = `${'A'.repeat(21)}B`;
  await assert.rejects(state.readSuspension('audit-1'), /PIXEL_STATE_UNAVAILABLE/u);
});

test('keeps valid scans usable while attributing malformed private records without reading accessors', async () => {
  const seededArea = memorySessionArea();
  const seededState = createPixelCaptureStateV1({ sessionArea: seededArea, now: () => NOW, randomBytes: bytesFactory() });
  await seededState.pause(pauseInput({ auditId: 'audit-b', authorityExpiresAt: NOW + 120_000 }));
  const valid = clone(seededArea.values[`${JOURNAL_PREFIX}audit-b`]);
  let getterReads = 0;
  const root = {};
  Object.defineProperty(root, `${JOURNAL_PREFIX}audit-a`, {
    enumerable: true,
    get() { getterReads += 1; throw new Error('PRIVATE_QUERY_NEVER_SURFACE'); },
  });
  Object.defineProperty(root, `${JOURNAL_PREFIX}bad/audit`, {
    enumerable: true,
    value: { nativeError: 'PRIVATE_QUERY_NEVER_SURFACE' },
  });
  Object.defineProperty(root, `${JOURNAL_PREFIX}audit-b`, { enumerable: true, value: valid });
  const sessionArea = {
    async get(key) {
      if (key === null) return root;
      return Object.hasOwn(root, key) ? { [key]: Object.getOwnPropertyDescriptor(root, key).value } : {};
    },
    async set() { throw new Error('not used'); },
    async remove() { throw new Error('not used'); },
  };
  const state = createPixelCaptureStateV1({ sessionArea, now: () => NOW, randomBytes: bytesFactory() });

  const scan = await state.listSuspensions({ limit: 25 });
  assert.deepEqual(scan, {
    version: 'PixelSuspensionScanV1',
    suspensions: [await seededState.readSuspension('audit-b')],
    unavailableAuditIds: ['audit-a'],
    hasUnattributedUnavailable: true,
  });
  assert.equal(Object.isFrozen(scan.unavailableAuditIds), true);
  assert.equal(getterReads, 0);
  assert.equal(await state.nextExpiresAt(), NOW + 120_000);
  assert.equal(getterReads, 0);
});

test('shares a volatile fail-closed barrier until an exact revocation is confirmed', async () => {
  const sessionArea = memorySessionArea();
  const firstState = createPixelCaptureStateV1({ sessionArea, now: () => NOW, randomBytes: bytesFactory() });
  const secondState = createPixelCaptureStateV1({ sessionArea, now: () => NOW, randomBytes: bytesFactory() });
  const paused = await firstState.pause(pauseInput());
  const normalSet = sessionArea.set.bind(sessionArea);
  sessionArea.set = async () => { sessionArea.calls.set += 1; };

  await assert.rejects(firstState.claimAndBeginResume({
    auditId: 'audit-1', consentId: paused.consentId, proof: proof('doc-b'), mode: 'full-evidence', categories: ['password', 'otp'],
  }), error => error?.message === 'PIXEL_STATE_UNAVAILABLE');
  await assert.rejects(secondState.claimAndBeginResume({
    auditId: 'audit-1', consentId: paused.consentId, proof: proof(), mode: 'full-evidence', categories: ['password', 'otp'],
  }), error => error?.message === 'PIXEL_STATE_UNAVAILABLE');
  await assert.rejects(secondState.markSessionRunning({ auditId: 'audit-1', consentId: paused.consentId }), error => error?.message === 'PIXEL_STATE_UNAVAILABLE');
  await assert.rejects(secondState.gateRunnerStart({
    auditId: 'audit-1', consentId: paused.consentId, proof: proof(), categories: ['password', 'otp'],
  }), error => error?.message === 'PIXEL_STATE_UNAVAILABLE');

  sessionArea.set = normalSet;
  const revoked = await secondState.revokeAudit({ auditId: 'audit-1', consentId: paused.consentId, reason: 'AUDIT_CANCELLED' });
  assert.equal(revoked.status, 'revoked');
  assert.equal(revoked.suspension.revokeReason, 'AUDIT_CANCELLED');
  const repeated = await firstState.revokeAudit({ auditId: 'audit-1', consentId: paused.consentId, reason: 'SESSION_ENDED' });
  assert.equal(repeated.status, 'already-revoked');
  assert.equal(repeated.suspension.revokeReason, 'AUDIT_CANCELLED');
});

test('rejects unsafe revisions before set and saturates cleanup attempts at thirty-one', async () => {
  const { sessionArea, state } = stateFixture();
  const paused = await state.pause(pauseInput());
  const revoked = await state.revokeAudit({ auditId: 'audit-1', consentId: paused.consentId, reason: 'AUDIT_CANCELLED' });
  const key = `${JOURNAL_PREFIX}audit-1`;
  sessionArea.values[key].revision = Number.MAX_SAFE_INTEGER;
  const setCalls = sessionArea.calls.set;
  await assert.rejects(state.deferCleanup({
    auditId: 'audit-1', consentId: paused.consentId, expectedRevision: Number.MAX_SAFE_INTEGER,
  }), /PIXEL_STATE_UNAVAILABLE/u);
  assert.equal(sessionArea.calls.set, setCalls);
  assert.equal(sessionArea.values[key].revision, Number.MAX_SAFE_INTEGER);

  sessionArea.values[key] = clone(revoked.suspension);
  sessionArea.values[key].version = 'PixelCaptureJournalV1';
  sessionArea.values[key].cleanupAttempts = 31;
  sessionArea.values[key].revision = 20;
  const saturated = await state.deferCleanup({ auditId: 'audit-1', consentId: paused.consentId, expectedRevision: 20 });
  assert.equal(saturated.cleanupAttempts, 31);
  assert.equal(saturated.cleanupNotBefore, NOW + TEN_MINUTES);
  assert.equal(saturated.revision, 21);

  sessionArea.values[key].cleanupAttempts = 32;
  await assert.rejects(state.readSuspension('audit-1'), /PIXEL_STATE_UNAVAILABLE/u);
});

test('rejects epoch arithmetic overflow before persistence', async () => {
  const sessionArea = memorySessionArea();
  const nearLimit = Number.MAX_SAFE_INTEGER - 300_000;
  const state = createPixelCaptureStateV1({ sessionArea, now: () => nearLimit, randomBytes: bytesFactory() });
  await assert.rejects(state.pause(pauseInput({ authorityExpiresAt: Number.MAX_SAFE_INTEGER })), /PIXEL_STATE_UNAVAILABLE/u);
  assert.equal(sessionArea.calls.set, 0);
});

test('reads and confirms removal through own data descriptors without invoking getters', async () => {
  const key = `${JOURNAL_PREFIX}audit-1`;
  let getterReads = 0;
  const hostileReadArea = {
    async get() {
      const result = {};
      Object.defineProperty(result, key, { enumerable: true, get() { getterReads += 1; throw new Error('PRIVATE'); } });
      return result;
    },
    async set() {}, async remove() {},
  };
  const hostileReadState = createPixelCaptureStateV1({ sessionArea: hostileReadArea, now: () => NOW, randomBytes: bytesFactory() });
  await assert.rejects(hostileReadState.readSuspension('audit-1'), /PIXEL_STATE_UNAVAILABLE/u);
  assert.equal(getterReads, 0);

  const sessionArea = memorySessionArea();
  const state = createPixelCaptureStateV1({ sessionArea, now: () => NOW, randomBytes: bytesFactory() });
  const paused = await state.pause(pauseInput());
  await state.revokeAudit({ auditId: 'audit-1', consentId: paused.consentId, reason: 'AUDIT_CANCELLED' });
  const originalGet = sessionArea.get.bind(sessionArea);
  let afterRemove = false;
  sessionArea.remove = async () => { sessionArea.calls.remove += 1; afterRemove = true; };
  sessionArea.get = async requested => {
    if (!afterRemove) return originalGet(requested);
    const result = {};
    Object.defineProperty(result, key, { enumerable: true, get() { getterReads += 1; throw new Error('PRIVATE'); } });
    return result;
  };
  await assert.rejects(state.finish({ auditId: 'audit-1', consentId: paused.consentId }), /PIXEL_STATE_UNAVAILABLE/u);
  assert.equal(getterReads, 0);
});

test('fails closed for throw-before noop partial and foreign set outcomes', async () => {
  for (const mode of ['throw-before', 'noop', 'partial', 'foreign']) {
    const sessionArea = memorySessionArea();
    sessionArea.set = async input => {
      sessionArea.calls.set += 1;
      const [key, requested] = Object.entries(clone(input))[0];
      if (mode === 'throw-before') throw new Error('PRIVATE_NATIVE_ERROR');
      if (mode === 'noop') return;
      if (mode === 'partial') { sessionArea.values[key] = { version: requested.version, auditId: requested.auditId }; return; }
      sessionArea.values[key] = { ...requested, auditId: 'foreign-audit' };
    };
    const state = createPixelCaptureStateV1({ sessionArea, now: () => NOW, randomBytes: bytesFactory() });
    await assert.rejects(state.pause(pauseInput()), error => error?.message === 'PIXEL_STATE_UNAVAILABLE');
    assert.equal(JSON.stringify(sessionArea.values).includes('PRIVATE_NATIVE_ERROR'), false);
    if (['throw-before', 'noop'].includes(mode)) assert.equal(await state.readSuspension('audit-1'), null);
    else await assert.rejects(state.readSuspension('audit-1'), /PIXEL_STATE_UNAVAILABLE/u);
  }
});

test('accepts remove commit-then-throw but blocks noop and foreign replacement', async () => {
  for (const mode of ['commit-then-throw', 'noop', 'foreign']) {
    const sessionArea = memorySessionArea();
    const state = createPixelCaptureStateV1({ sessionArea, now: () => NOW, randomBytes: bytesFactory() });
    const paused = await state.pause(pauseInput());
    await state.revokeAudit({ auditId: 'audit-1', consentId: paused.consentId, reason: 'AUDIT_CANCELLED' });
    sessionArea.remove = async requested => {
      sessionArea.calls.remove += 1;
      if (mode === 'noop') return;
      if (mode === 'foreign') {
        sessionArea.values[requested] = { version: 'FOREIGN_PRIVATE_STATE', auditId: 'audit-1' };
        return;
      }
      delete sessionArea.values[requested];
      throw new Error('PRIVATE_NATIVE_ERROR');
    };
    const result = state.finish({ auditId: 'audit-1', consentId: paused.consentId });
    if (mode === 'commit-then-throw') {
      assert.equal(await result, true);
      assert.equal(Object.hasOwn(sessionArea.values, `${JOURNAL_PREFIX}audit-1`), false);
    } else {
      await assert.rejects(result, /PIXEL_STATE_UNAVAILABLE/u);
      assert.equal(Object.hasOwn(sessionArea.values, `${JOURNAL_PREFIX}audit-1`), true);
    }
  }
});

test('revalidates expiry binding and categories at the final runner gate', async () => {
  for (const scenario of ['expired', 'document-changed', 'signals-changed']) {
    const clock = { value: NOW };
    const { state } = stateFixture({ now: () => clock.value });
    const paused = await state.pause(pauseInput({ categories: ['payment'], authorityExpiresAt: NOW + 100 }));
    await state.claimAndBeginResume({ auditId: 'audit-1', consentId: paused.consentId, proof: proof(), mode: 'full-evidence', categories: ['payment'] });
    await state.markSessionRunning({ auditId: 'audit-1', consentId: paused.consentId });
    if (scenario === 'expired') {
      clock.value = NOW + 100;
      await assert.rejects(state.gateRunnerStart({ auditId: 'audit-1', consentId: paused.consentId, proof: proof(), categories: ['payment'] }), /PIXEL_CONSENT_EXPIRED/u);
      assert.equal((await state.readSuspension('audit-1')).resumePhase, 'session-running');
    } else if (scenario === 'document-changed') {
      await assert.rejects(state.gateRunnerStart({ auditId: 'audit-1', consentId: paused.consentId, proof: proof('doc-b'), categories: ['payment'] }), /PIXEL_CONSENT_DOCUMENT_CHANGED/u);
      assert.equal((await state.readSuspension('audit-1')).state, 'revoked');
    } else {
      const gate = await state.gateRunnerStart({ auditId: 'audit-1', consentId: paused.consentId, proof: proof(), categories: [] });
      assert.equal(gate.status, 'repaused');
      assert.notEqual(gate.suspension.consentId, paused.consentId);
      assert.equal(gate.suspension.expiresAt, NOW + 100);
      assert.deepEqual(gate.suspension.categories, []);
    }
    assert.notEqual((await state.readSuspension('audit-1')).resumePhase, 'runner-started');
  }
});

test('makes a stale recovery projection harmless after consent rotation', async () => {
  const { state } = stateFixture();
  const paused = await state.pause(pauseInput({ categories: ['password'] }));
  const stale = (await state.listSuspensions({ limit: 25 })).suspensions[0];
  await assert.rejects(state.claimAndBeginResume({
    auditId: 'audit-1', consentId: paused.consentId, proof: proof(), mode: 'full-evidence', categories: ['otp'],
  }), /PIXEL_CONSENT_SIGNALS_CHANGED/u);
  const result = await state.revokeAudit({ auditId: stale.auditId, consentId: stale.consentId, reason: 'PIXEL_CONSENT_EXPIRED' });
  assert.deepEqual(result, { version: 'PixelRevokeResultV1', status: 'mismatch', suspension: null });
  assert.equal((await state.readSuspension('audit-1')).state, 'paused');
});

test('serializes one claim across factories and never exposes raw query or native errors', async () => {
  const sessionArea = memorySessionArea();
  const firstState = createPixelCaptureStateV1({ sessionArea, now: () => NOW, randomBytes: bytesFactory() });
  const secondState = createPixelCaptureStateV1({ sessionArea, now: () => NOW, randomBytes: bytesFactory() });
  const paused = await firstState.pause(pauseInput());
  const claims = await Promise.allSettled([
    firstState.claimAndBeginResume({ auditId: 'audit-1', consentId: paused.consentId, proof: proof(), mode: 'full-evidence', categories: ['password', 'otp'] }),
    secondState.claimAndBeginResume({ auditId: 'audit-1', consentId: paused.consentId, proof: proof(), mode: 'full-evidence', categories: ['password', 'otp'] }),
  ]);
  assert.equal(claims.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(claims.filter(result => result.status === 'rejected').length, 1);
  const serialized = JSON.stringify(sessionArea.values);
  assert.equal(serialized.includes('secret=1'), false);
  assert.equal(serialized.includes('PRIVATE_NATIVE_ERROR'), false);

  const callsBefore = { ...sessionArea.calls };
  await assert.rejects(firstState.pause(pauseInput({ auditId: 'https://example.test/?secret=NEVER_KEY' })), /PIXEL_STATE_UNAVAILABLE/u);
  assert.equal(sessionArea.calls.get, callsBefore.get);
  assert.equal(sessionArea.calls.set, callsBefore.set);
});

test('serializes wrappers over the same backing so only one consent claim succeeds', async () => {
  const backing = {};
  const wrapper = () => ({
    async get(key) {
      await Promise.resolve();
      if (key === null) return clone(backing);
      return Object.hasOwn(backing, key) ? { [key]: clone(backing[key]) } : {};
    },
    async set(input) { await Promise.resolve(); Object.assign(backing, clone(input)); },
    async remove(key) { await Promise.resolve(); for (const item of Array.isArray(key) ? key : [key]) delete backing[item]; },
  });
  const firstState = createPixelCaptureStateV1({ sessionArea: wrapper(), now: () => NOW, randomBytes: bytesFactory() });
  const secondState = createPixelCaptureStateV1({ sessionArea: wrapper(), now: () => NOW, randomBytes: bytesFactory() });
  const paused = await firstState.pause(pauseInput());

  const claims = await Promise.allSettled([
    firstState.claimAndBeginResume({ auditId: 'audit-1', consentId: paused.consentId, proof: proof(), mode: 'full-evidence', categories: ['password', 'otp'] }),
    secondState.claimAndBeginResume({ auditId: 'audit-1', consentId: paused.consentId, proof: proof(), mode: 'full-evidence', categories: ['password', 'otp'] }),
  ]);
  assert.equal(claims.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(claims.filter(result => result.status === 'rejected').length, 1);
});

test('rejects clock rollback against the persisted journal through a replacement wrapper', async () => {
  const backing = {};
  const wrapper = () => ({
    async get(key) {
      if (key === null) return clone(backing);
      return Object.hasOwn(backing, key) ? { [key]: clone(backing[key]) } : {};
    },
    async set(input) { Object.assign(backing, clone(input)); },
    async remove(key) { for (const item of Array.isArray(key) ? key : [key]) delete backing[item]; },
  });
  const newerState = createPixelCaptureStateV1({ sessionArea: wrapper(), now: () => NOW + 100, randomBytes: bytesFactory() });
  await newerState.pause(pauseInput({ authorityExpiresAt: NOW + TEN_MINUTES }));
  const restartedState = createPixelCaptureStateV1({ sessionArea: wrapper(), now: () => NOW, randomBytes: bytesFactory() });

  await assert.rejects(restartedState.readSuspension('audit-1'), /PIXEL_STATE_UNAVAILABLE/u);
  assert.equal(await restartedState.nextExpiresAt(), NOW + TEN_MINUTES);
});

test('refuses a consent rotation when entropy repeats the previous token', async () => {
  const sessionArea = memorySessionArea();
  const state = createPixelCaptureStateV1({
    sessionArea,
    now: () => NOW,
    randomBytes: length => new Uint8Array(length),
  });
  const paused = await state.pause(pauseInput({ categories: ['password'] }));
  const before = clone(sessionArea.values[`${JOURNAL_PREFIX}audit-1`]);
  const setCalls = sessionArea.calls.set;

  await assert.rejects(state.claimAndBeginResume({
    auditId: 'audit-1', consentId: paused.consentId, proof: proof(), mode: 'full-evidence', categories: ['otp'],
  }), error => error?.message === 'PIXEL_STATE_UNAVAILABLE');
  assert.equal(sessionArea.calls.set, setCalls);
  assert.deepEqual(sessionArea.values[`${JOURNAL_PREFIX}audit-1`], before);
  await assert.rejects(state.claimAndBeginResume({
    auditId: 'audit-1', consentId: paused.consentId, proof: proof(), mode: 'full-evidence', categories: ['password'],
  }), error => error?.message === 'PIXEL_STATE_UNAVAILABLE');
  assert.equal((await state.revokeAudit({
    auditId: 'audit-1', consentId: paused.consentId, reason: 'AUDIT_CANCELLED',
  })).status, 'revoked');
});

test('returns deeply frozen copies independent from caller and persisted objects', async () => {
  const sessionArea = memorySessionArea();
  const state = createPixelCaptureStateV1({ sessionArea, now: () => NOW, randomBytes: bytesFactory() });
  const input = pauseInput();
  const paused = await state.pause(input);
  const journal = sessionArea.values[`${JOURNAL_PREFIX}audit-1`];

  assert.notEqual(paused.capturePolicy, input.capturePolicy);
  assert.notEqual(paused.urlEvidence, input.observedTarget.urlEvidence);
  assert.notEqual(paused.capturePolicy, journal.capturePolicy);
  assert.notEqual(paused.urlEvidence, journal.urlEvidence);
  assert.notEqual(paused.categories, journal.categories);
  assert.notEqual(paused.source, journal.source);
  assert.equal(Object.isFrozen(paused.capturePolicy), true);
  assert.equal(Object.isFrozen(paused.urlEvidence), true);
  assert.equal(Object.isFrozen(paused.source), true);
});

test('turns revoked proxies into fixed state errors without invoking accessors', async () => {
  const sessionArea = memorySessionArea();
  const state = createPixelCaptureStateV1({ sessionArea, now: () => NOW, randomBytes: bytesFactory() });
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();

  await assert.rejects(state.pause(proxy), error => error?.message === 'PIXEL_STATE_UNAVAILABLE');
  assert.equal(sessionArea.calls.set, 0);
});

test('accepts zero-valued Chrome tab and window identifiers', async () => {
  const { state } = stateFixture();
  const observedTarget = target();
  observedTarget.tabId = 0;
  observedTarget.windowId = 0;
  const paused = await state.pause(pauseInput({ observedTarget }));
  assert.deepEqual([paused.tabId, paused.windowId], [0, 0]);
  const currentProof = proof();
  currentProof.tabId = 0;
  currentProof.windowId = 0;
  const claim = await state.claimAndBeginResume({
    auditId: 'audit-1', consentId: paused.consentId, proof: currentProof,
    mode: 'full-evidence', categories: ['password', 'otp'],
  });
  assert.deepEqual([claim.tabId, claim.windowId], [0, 0]);
});

test('never reads a message getter from hostile thrown values', async () => {
  let messageReads = 0;
  const hostileThrown = {};
  Object.defineProperty(hostileThrown, 'message', {
    get() { messageReads += 1; throw new Error('PRIVATE_THROWN_VALUE'); },
  });
  const hostileOptions = new Proxy({}, { get() { throw hostileThrown; } });
  assert.throws(
    () => createPixelCaptureStateV1(hostileOptions),
    error => error?.message === 'PIXEL_STATE_UNAVAILABLE',
  );

  const key = `${JOURNAL_PREFIX}audit-1`;
  const hostileResult = new Proxy({}, { getPrototypeOf() { throw hostileThrown; } });
  const state = createPixelCaptureStateV1({
    sessionArea: {
      async get(requested) { return requested === key ? hostileResult : {}; },
      async set() {}, async remove() {},
    },
    now: () => NOW,
    randomBytes: bytesFactory(),
  });
  await assert.rejects(state.readSuspension('audit-1'), error => error?.message === 'PIXEL_STATE_UNAVAILABLE');
  assert.equal(messageReads, 0);
});

test('keeps the shared barrier when a binding revocation cannot be built safely', async () => {
  const sessionArea = memorySessionArea();
  const firstState = createPixelCaptureStateV1({ sessionArea, now: () => NOW, randomBytes: bytesFactory() });
  const secondState = createPixelCaptureStateV1({ sessionArea, now: () => NOW, randomBytes: bytesFactory() });
  const paused = await firstState.pause(pauseInput());
  const key = `${JOURNAL_PREFIX}audit-1`;
  sessionArea.values[key].revision = Number.MAX_SAFE_INTEGER;

  await assert.rejects(firstState.claimAndBeginResume({
    auditId: 'audit-1', consentId: paused.consentId, proof: proof('doc-b'),
    mode: 'full-evidence', categories: ['password', 'otp'],
  }), error => error?.message === 'PIXEL_STATE_UNAVAILABLE');
  sessionArea.values[key].revision = 1;
  await assert.rejects(secondState.claimAndBeginResume({
    auditId: 'audit-1', consentId: paused.consentId, proof: proof(),
    mode: 'full-evidence', categories: ['password', 'otp'],
  }), error => error?.message === 'PIXEL_STATE_UNAVAILABLE');
  assert.equal((await secondState.revokeAudit({
    auditId: 'audit-1', consentId: paused.consentId, reason: 'AUDIT_CANCELLED',
  })).status, 'revoked');
});

test('blocks stale approval when an explicit revocation cannot be confirmed', async () => {
  const sessionArea = memorySessionArea();
  const state = createPixelCaptureStateV1({ sessionArea, now: () => NOW, randomBytes: bytesFactory() });
  const paused = await state.pause(pauseInput());
  const normalSet = sessionArea.set.bind(sessionArea);
  sessionArea.set = async () => { sessionArea.calls.set += 1; };
  await assert.rejects(state.revokeAudit({
    auditId: 'audit-1', consentId: paused.consentId, reason: 'AUDIT_CANCELLED',
  }), error => error?.message === 'PIXEL_STATE_UNAVAILABLE');
  sessionArea.set = normalSet;
  await assert.rejects(state.claimAndBeginResume({
    auditId: 'audit-1', consentId: paused.consentId, proof: proof(),
    mode: 'full-evidence', categories: ['password', 'otp'],
  }), error => error?.message === 'PIXEL_STATE_UNAVAILABLE');
  assert.equal((await state.revokeAudit({
    auditId: 'audit-1', consentId: paused.consentId, reason: 'AUDIT_CANCELLED',
  })).status, 'revoked');
});

test('rejects a new audit when a replacement wrapper observes persisted clock rollback', async () => {
  const backing = {};
  const calls = { set: 0 };
  const wrapper = () => ({
    async get(key) {
      if (key === null) return clone(backing);
      return Object.hasOwn(backing, key) ? { [key]: clone(backing[key]) } : {};
    },
    async set(input) { calls.set += 1; Object.assign(backing, clone(input)); },
    async remove(key) { for (const item of Array.isArray(key) ? key : [key]) delete backing[item]; },
  });
  const newerState = createPixelCaptureStateV1({
    sessionArea: wrapper(), now: () => NOW + 1, randomBytes: bytesFactory(),
  });
  await newerState.pause(pauseInput({ auditId: 'audit-clock-a', authorityExpiresAt: NOW + TEN_MINUTES }));
  const setCalls = calls.set;
  const rolledBackState = createPixelCaptureStateV1({
    sessionArea: wrapper(), now: () => NOW, randomBytes: bytesFactory(),
  });

  await assert.rejects(rolledBackState.pause(pauseInput({
    auditId: 'audit-clock-b', authorityExpiresAt: NOW + TEN_MINUTES,
  })), error => error?.message === 'PIXEL_STATE_UNAVAILABLE');
  assert.equal(calls.set, setCalls);
  assert.equal(Object.hasOwn(backing, `${JOURNAL_PREFIX}audit-clock-b`), false);
});

test('isolates a failed binding-revocation barrier to the exact session area', async () => {
  const firstArea = memorySessionArea();
  const secondArea = memorySessionArea();
  const firstState = createPixelCaptureStateV1({
    sessionArea: firstArea, now: () => NOW, randomBytes: bytesFactory(),
  });
  const secondState = createPixelCaptureStateV1({
    sessionArea: secondArea, now: () => NOW, randomBytes: bytesFactory(),
  });
  const firstPaused = await firstState.pause(pauseInput({ auditId: 'audit-area-barrier' }));
  const secondPaused = await secondState.pause(pauseInput({ auditId: 'audit-area-barrier' }));
  assert.equal(firstPaused.consentId, secondPaused.consentId);

  const normalSet = firstArea.set.bind(firstArea);
  firstArea.set = async () => { firstArea.calls.set += 1; };
  await assert.rejects(firstState.claimAndBeginResume({
    auditId: firstPaused.auditId, consentId: firstPaused.consentId, proof: proof('doc-b'),
    mode: 'full-evidence', categories: ['password', 'otp'],
  }), error => error?.message === 'PIXEL_STATE_UNAVAILABLE');
  firstArea.set = normalSet;

  const independentClaim = await secondState.claimAndBeginResume({
    auditId: secondPaused.auditId, consentId: secondPaused.consentId, proof: proof(),
    mode: 'full-evidence', categories: ['password', 'otp'],
  });
  assert.equal(independentClaim.auditId, secondPaused.auditId);
  assert.equal(independentClaim.consentId, secondPaused.consentId);
});
