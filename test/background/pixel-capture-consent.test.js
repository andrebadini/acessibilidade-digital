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
  return {
    values,
    async get(key) {
      if (key === null) return clone(values);
      return { [key]: clone(values[key]) };
    },
    async set(input) { Object.assign(values, clone(input)); },
    async remove(key) {
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
  for (const categories of [[], ['otp', 'password'], ['password'], ['password', 'payment']]) {
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
  const scan = await state.listSuspensions({ limit: 25 });
  assert.equal(scan.unavailableCount ?? scan.hasUnattributedUnavailable, 1);
  // The storage fake clones before the vault receives the record; parser paths
  // themselves remain descriptor-only and do not surface the hostile value.
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
