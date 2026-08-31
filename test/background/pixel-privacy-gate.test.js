import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertPixelPipelineAuthorizedV1,
  createPixelPipelinePreflightV1,
  createPixelPrivacyGateV1,
  isPixelPrivacyGateV1,
} from '../../src/background/pixel-privacy-gate.js';
import { createCapturePolicyV1 } from '../../src/core/privacy/capture-policy.js';
import { sanitizeEvidenceUrlV1 } from '../../src/core/privacy/evidence-url.js';

const DIGEST = `hmac-sha256:${'A'.repeat(43)}`;
const POLICY = createCapturePolicyV1({ mode: 'full-evidence', includeQuery: false });
const TARGET = Object.freeze({
  version: 'ObservedTargetV1', kind: 'attached', tabId: 7, windowId: 3,
  documentId: 'doc-1', urlSessionDigest: DIGEST,
  urlEvidence: sanitizeEvidenceUrlV1('https://example.test/a', { includeQuery: false }),
});
const PROOF = Object.freeze({ tabId: 7, windowId: 3, documentId: 'doc-1', urlSessionDigest: DIGEST });
const EMPTY = Object.freeze({ version: 'SensitiveCaptureSignalsV1', detected: false, categories: Object.freeze([]) });
const SENSITIVE = Object.freeze({
  version: 'SensitiveCaptureSignalsV1', detected: true,
  categories: Object.freeze(['password', 'private-marker']),
});

function suspension({
  state = 'paused', resumePhase = null, consentId = 'B'.repeat(21) + 'Q',
  policy = POLICY, categories = SENSITIVE.categories, evidence = TARGET.urlEvidence,
  expiresAt = 1_800_000_600_000,
} = {}) {
  return {
    version: 'AuditSuspensionV1', revision: 1, auditId: 'audit-1', consentId,
    tabId: 7, windowId: 3, documentId: 'doc-1', urlEvidence: evidence,
    urlSessionDigest: DIGEST, mode: policy.mode, capturePolicy: policy,
    categories, issuedAt: 1_800_000_000_000,
    updatedAt: 1_800_000_000_001, expiresAt,
    cleanupAttempts: 0, cleanupNotBefore: null, state, resumePhase,
    revokeReason: null, source: { kind: 'attached' },
  };
}

function fixture({ consentId = null, gateResult = 'ready', pauseValue = null, runnerSuspension = null } = {}) {
  const calls = [];
  const pixelState = {
    async pause(value) { calls.push(['pause', value]); return pauseValue ?? suspension(); },
    async gateRunnerStart(value) {
      calls.push(['gate-runner', value]);
      return gateResult === 'ready'
        ? { version: 'PixelRunnerGateResultV1', status: 'ready', suspension: runnerSuspension ?? suspension({ state: 'resuming', resumePhase: 'runner-started', consentId }) }
        : { version: 'PixelRunnerGateResultV1', status: 'repaused', suspension: runnerSuspension ?? suspension({ consentId: 'C'.repeat(21) + 'Q' }) };
    },
  };
  const gate = createPixelPrivacyGateV1({
    pixelState, consentId, authorityExpiresAt: 1_900_000_000_000,
    async afterPixels() { calls.push(['after-pixels']); },
  });
  return { gate, calls };
}

function deferred() {
  let resolve;
  const promise = new Promise(currentResolve => { resolve = currentResolve; });
  return { promise, resolve };
}

test('only the exact branded frozen gate is accepted', () => {
  const { gate } = fixture();
  assert.equal(isPixelPrivacyGateV1(gate), true);
  for (const candidate of [
    {}, { ...gate }, { ...gate, extra: true },
    { preflight: gate.preflight.bind(gate), authorizeFirstPixel: gate.authorizeFirstPixel, afterPixels: gate.afterPixels },
  ]) assert.equal(isPixelPrivacyGateV1(candidate), false);
  let getterCalls = 0;
  const hostile = {};
  Object.defineProperty(hostile, 'preflight', { enumerable: true, get() { getterCalls += 1; return gate.preflight; } });
  hostile.authorizeFirstPixel = gate.authorizeFirstPixel;
  hostile.afterPixels = gate.afterPixels;
  hostile[Symbol('extra')] = true;
  assert.equal(isPixelPrivacyGateV1(hostile), false);
  assert.equal(getterCalls, 0);
  assert.equal(Object.isFrozen(gate), true);
});

test('validation never invokes policy or evidence getters', async () => {
  const { gate } = fixture();
  let getterCalls = 0;
  const policy = { ...POLICY };
  Object.defineProperty(policy, 'mode', { enumerable: true, get() { getterCalls += 1; return 'full-evidence'; } });
  await assert.rejects(() => gate.preflight({
    auditId: 'audit-1', observedTarget: TARGET, capturePolicy: policy, signals: EMPTY,
  }), /PIXEL_PRIVACY_GATE_DENIED/u);
  const target = { ...TARGET };
  const evidence = { ...TARGET.urlEvidence };
  Object.defineProperty(evidence, 'href', { enumerable: true, get() { getterCalls += 1; return TARGET.urlEvidence.href; } });
  target.urlEvidence = evidence;
  const { gate: secondGate } = fixture();
  await assert.rejects(() => secondGate.preflight({
    auditId: 'audit-1', observedTarget: target, capturePolicy: POLICY, signals: EMPTY,
  }), /PIXEL_PRIVACY_GATE_DENIED/u);
  assert.equal(getterCalls, 0);
});

test('pipeline preflight validates its binding before probing', async () => {
  let probes = 0;
  const { gate } = fixture();
  const preflight = createPixelPipelinePreflightV1(gate, {
    async probeSensitiveCaptureSignals() { probes += 1; return EMPTY; },
  });
  for (const request of [
    { auditId: 'audit-1', observedTarget: { ...TARGET, documentId: '' }, capturePolicy: POLICY },
    { auditId: 'audit-1', observedTarget: TARGET, capturePolicy: { ...POLICY, includeQuery: true } },
  ]) await assert.rejects(() => preflight(request), /PIXEL_PRIVACY_GATE_DENIED/u);
  assert.equal(probes, 0);
});

test('pause and resume results must preserve the exact policy, evidence, expiry and consent binding', async t => {
  for (const scenario of [
    { name: 'mode mismatch', pauseValue: { ...suspension(), mode: 'element-only' } },
    { name: 'evidence mismatch', pauseValue: { ...suspension(), urlEvidence: { ...TARGET.urlEvidence, redactedSegments: TARGET.urlEvidence.redactedSegments + 1 } } },
    { name: 'expiry above authority', pauseValue: suspension({ expiresAt: 1_900_000_000_001 }) },
  ]) await t.test(scenario.name, async () => {
    const { gate } = fixture(scenario);
    await assert.rejects(() => gate.preflight({
      auditId: 'audit-1', observedTarget: TARGET, capturePolicy: POLICY, signals: SENSITIVE,
    }), /PIXEL_PRIVACY_GATE_DENIED/u);
  });

  const currentConsentId = 'A'.repeat(21) + 'Q';
  for (const scenario of [
    { name: 'ready foreign consent', gateResult: 'ready', runnerSuspension: suspension({ state: 'resuming', resumePhase: 'runner-started', consentId: 'C'.repeat(21) + 'Q' }) },
    { name: 'repaused same consent', gateResult: 'repaused', runnerSuspension: suspension({ consentId: currentConsentId }) },
  ]) await t.test(scenario.name, async () => {
    const { gate } = fixture({ ...scenario, consentId: currentConsentId });
    await gate.preflight({ auditId: 'audit-1', observedTarget: TARGET, capturePolicy: POLICY, signals: EMPTY });
    await assert.rejects(() => gate.authorizeFirstPixel({
      auditId: 'audit-1', observedTarget: TARGET, capturePolicy: POLICY, proof: PROOF, signals: SENSITIVE,
    }), /PIXEL_PRIVACY_GATE_DENIED/u);
  });
});

test('concurrent preflight and final authorization can perform each FSM transition only once', async t => {
  await t.test('preflight pause', async () => {
    const hold = deferred();
    let pauses = 0;
    const { gate } = fixture();
    const original = gate;
    const suspensionGate = createPixelPrivacyGateV1({
      pixelState: {
        async pause(value) {
          pauses += 1;
          await hold.promise;
          return {
            version: 'AuditSuspensionV1', revision: 1, auditId: value.auditId, consentId: 'B'.repeat(21) + 'Q',
            tabId: 7, windowId: 3, documentId: 'doc-1', urlEvidence: TARGET.urlEvidence,
            urlSessionDigest: DIGEST, mode: POLICY.mode, capturePolicy: POLICY, categories: SENSITIVE.categories,
            issuedAt: 1_800_000_000_000, updatedAt: 1_800_000_000_001, expiresAt: 1_800_000_600_000,
            cleanupAttempts: 0, cleanupNotBefore: null, state: 'paused', resumePhase: null,
            revokeReason: null, source: { kind: 'attached' },
          };
        },
        async gateRunnerStart() { throw new Error('unexpected'); },
      },
      consentId: null, authorityExpiresAt: 1_900_000_000_000, async afterPixels() {},
    });
    assert.equal(isPixelPrivacyGateV1(original), true);
    const first = suspensionGate.preflight({ auditId: 'audit-1', observedTarget: TARGET, capturePolicy: POLICY, signals: SENSITIVE });
    await Promise.resolve();
    const second = suspensionGate.preflight({ auditId: 'audit-1', observedTarget: TARGET, capturePolicy: POLICY, signals: SENSITIVE });
    hold.resolve();
    const outcomes = await Promise.allSettled([first, second]);
    assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1);
    assert.equal(outcomes.filter(outcome => outcome.status === 'rejected' && /PIXEL_PRIVACY_GATE_DENIED/u.test(String(outcome.reason))).length, 1);
    assert.equal(pauses, 1);
  });

  await t.test('final pause', async () => {
    const hold = deferred();
    let pauses = 0;
    const suspensionGate = createPixelPrivacyGateV1({
      pixelState: {
        async pause(value) {
          pauses += 1;
          await hold.promise;
          return {
            version: 'AuditSuspensionV1', revision: 1, auditId: value.auditId, consentId: 'B'.repeat(21) + 'Q',
            tabId: 7, windowId: 3, documentId: 'doc-1', urlEvidence: TARGET.urlEvidence,
            urlSessionDigest: DIGEST, mode: POLICY.mode, capturePolicy: POLICY, categories: SENSITIVE.categories,
            issuedAt: 1_800_000_000_000, updatedAt: 1_800_000_000_001, expiresAt: 1_800_000_600_000,
            cleanupAttempts: 0, cleanupNotBefore: null, state: 'paused', resumePhase: null,
            revokeReason: null, source: { kind: 'attached' },
          };
        },
        async gateRunnerStart() { throw new Error('unexpected'); },
      },
      consentId: null, authorityExpiresAt: 1_900_000_000_000, async afterPixels() {},
    });
    await suspensionGate.preflight({ auditId: 'audit-1', observedTarget: TARGET, capturePolicy: POLICY, signals: EMPTY });
    const request = { auditId: 'audit-1', observedTarget: TARGET, capturePolicy: POLICY, proof: PROOF, signals: SENSITIVE };
    const first = suspensionGate.authorizeFirstPixel(request);
    await Promise.resolve();
    const second = suspensionGate.authorizeFirstPixel(request);
    hold.resolve();
    const outcomes = await Promise.allSettled([first, second]);
    assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1);
    assert.equal(outcomes.filter(outcome => outcome.status === 'rejected' && /PIXEL_PRIVACY_GATE_DENIED/u.test(String(outcome.reason))).length, 1);
    assert.equal(pauses, 1);
  });
});

test('initial sensitive preflight pauses exactly once and never settles pixels', async () => {
  const { gate, calls } = fixture();
  const result = await gate.preflight({
    auditId: 'audit-1', observedTarget: TARGET, capturePolicy: POLICY, signals: SENSITIVE,
  });
  assert.deepEqual(result, { status: 'privacy-paused', signals: SENSITIVE });
  assert.equal(calls.filter(([name]) => name === 'pause').length, 1);
  await gate.afterPixels({ auditId: 'audit-1', pixelStarted: false });
  assert.equal(calls.filter(([name]) => name === 'after-pixels').length, 0);
});

test('allowed initial gesture authorizes once, attests pipeline and calls afterPixels once', async () => {
  const { gate, calls } = fixture();
  assert.deepEqual(await gate.preflight({
    auditId: 'audit-1', observedTarget: TARGET, capturePolicy: POLICY, signals: EMPTY,
  }), { status: 'armed' });
  assert.deepEqual(await gate.authorizeFirstPixel({
    auditId: 'audit-1', observedTarget: TARGET, capturePolicy: POLICY, proof: PROOF, signals: EMPTY,
  }), { status: 'ready' });
  await assert.rejects(() => gate.authorizeFirstPixel({
    auditId: 'audit-1', observedTarget: TARGET, capturePolicy: POLICY, proof: PROOF, signals: EMPTY,
  }), /PIXEL_PRIVACY_GATE_DENIED/u);
  assert.equal(assertPixelPipelineAuthorizedV1(gate, { auditId: 'audit-1', capturePolicy: POLICY }), true);
  assert.throws(
    () => assertPixelPipelineAuthorizedV1(gate, { auditId: 'audit-1', capturePolicy: POLICY }),
    /PIXEL_PRIVACY_GATE_DENIED/u,
  );
  await gate.afterPixels({ auditId: 'audit-1', pixelStarted: true });
  await assert.rejects(() => gate.afterPixels({ auditId: 'audit-1', pixelStarted: true }), /PIXEL_PRIVACY_GATE_DENIED/u);
  assert.equal(calls.filter(([name]) => name === 'after-pixels').length, 1);
});

test('fresh sensitive signals repause initial or resumed attempts without authorizing pixels', async t => {
  for (const scenario of [
    { name: 'initial', consentId: null, gateResult: 'ready', expectedCall: 'pause' },
    { name: 'resumed', consentId: 'A'.repeat(21) + 'Q', gateResult: 'repaused', expectedCall: 'gate-runner' },
  ]) await t.test(scenario.name, async () => {
    const { gate, calls } = fixture(scenario);
    await gate.preflight({
      auditId: 'audit-1', observedTarget: TARGET, capturePolicy: POLICY,
      signals: scenario.consentId ? SENSITIVE : EMPTY,
    });
    const result = await gate.authorizeFirstPixel({
      auditId: 'audit-1', observedTarget: TARGET, capturePolicy: POLICY, proof: PROOF, signals: SENSITIVE,
    });
    assert.deepEqual(result, { status: 'privacy-paused', signals: SENSITIVE });
    assert.equal(calls.filter(([name]) => name === scenario.expectedCall).length, 1);
    await gate.afterPixels({ auditId: 'audit-1', pixelStarted: false });
    assert.equal(calls.filter(([name]) => name === 'after-pixels').length, 0);
    assert.throws(
      () => assertPixelPipelineAuthorizedV1(gate, { auditId: 'audit-1', capturePolicy: POLICY }),
      /PIXEL_PRIVACY_GATE_DENIED/u,
    );
  });
});

test('element-only can explicitly settle an allowed attempt with no raster', async () => {
  const policy = createCapturePolicyV1({ mode: 'element-only', includeQuery: false });
  const { gate, calls } = fixture();
  await gate.preflight({ auditId: 'audit-1', observedTarget: TARGET, capturePolicy: policy, signals: EMPTY });
  await gate.authorizeFirstPixel({
    auditId: 'audit-1', observedTarget: TARGET, capturePolicy: policy, proof: PROOF, signals: EMPTY,
  });
  assert.equal(assertPixelPipelineAuthorizedV1(gate, { auditId: 'audit-1', capturePolicy: policy }), true);
  await gate.afterPixels({ auditId: 'audit-1', pixelStarted: false });
  assert.equal(calls.filter(([name]) => name === 'after-pixels').length, 1);
});

test('armed collection failure cleans once without creating a pipeline attestation', async () => {
  const { gate, calls } = fixture();
  await gate.preflight({ auditId: 'audit-1', observedTarget: TARGET, capturePolicy: POLICY, signals: EMPTY });
  await gate.afterPixels({ auditId: 'audit-1', pixelStarted: false });
  assert.equal(calls.filter(([name]) => name === 'after-pixels').length, 1);
  assert.throws(
    () => assertPixelPipelineAuthorizedV1(gate, { auditId: 'audit-1', capturePolicy: POLICY }),
    /PIXEL_PRIVACY_GATE_DENIED/u,
  );
  await assert.rejects(() => gate.afterPixels({ auditId: 'audit-1', pixelStarted: false }), /PIXEL_PRIVACY_GATE_DENIED/u);
});

test('a private runner-gate failure stays closed and remains cleanup-eligible exactly once', async () => {
  let cleanupCalls = 0;
  const gate = createPixelPrivacyGateV1({
    pixelState: {
      async pause() { throw new Error('unexpected'); },
      async gateRunnerStart() { throw new Error('PRIVATE_RUNNER_GATE_DETAIL'); },
    },
    consentId: 'A'.repeat(21) + 'Q',
    authorityExpiresAt: 1_900_000_000_000,
    async afterPixels() { cleanupCalls += 1; },
  });
  await gate.preflight({ auditId: 'audit-1', observedTarget: TARGET, capturePolicy: POLICY, signals: EMPTY });

  await assert.rejects(
    () => gate.authorizeFirstPixel({
      auditId: 'audit-1', observedTarget: TARGET, capturePolicy: POLICY, proof: PROOF, signals: EMPTY,
    }),
    error => error?.message === 'PIXEL_PRIVACY_GATE_DENIED' && !String(error).includes('PRIVATE_RUNNER_GATE_DETAIL'),
  );
  await gate.afterPixels({ auditId: 'audit-1', pixelStarted: false });
  assert.equal(cleanupCalls, 1);
  await assert.rejects(
    () => gate.afterPixels({ auditId: 'audit-1', pixelStarted: false }),
    /PIXEL_PRIVACY_GATE_DENIED/u,
  );
});

test('a private cleanup failure is closed and cannot replay the callback', async () => {
  let cleanupCalls = 0;
  const gate = createPixelPrivacyGateV1({
    pixelState: {
      async pause() { throw new Error('unexpected'); },
      async gateRunnerStart() { throw new Error('unexpected'); },
    },
    consentId: null,
    authorityExpiresAt: 1_900_000_000_000,
    async afterPixels() {
      cleanupCalls += 1;
      throw new Error('PRIVATE_AFTER_PIXELS_DETAIL');
    },
  });
  await gate.preflight({ auditId: 'audit-1', observedTarget: TARGET, capturePolicy: POLICY, signals: EMPTY });
  await gate.authorizeFirstPixel({
    auditId: 'audit-1', observedTarget: TARGET, capturePolicy: POLICY, proof: PROOF, signals: EMPTY,
  });

  await assert.rejects(
    () => gate.afterPixels({ auditId: 'audit-1', pixelStarted: true }),
    error => error?.message === 'PIXEL_PRIVACY_GATE_DENIED' && !String(error).includes('PRIVATE_AFTER_PIXELS_DETAIL'),
  );
  assert.equal(cleanupCalls, 1);
  await assert.rejects(
    () => gate.afterPixels({ auditId: 'audit-1', pixelStarted: true }),
    /PIXEL_PRIVACY_GATE_DENIED/u,
  );
  assert.equal(cleanupCalls, 1);
});

test('a private pause failure is normalized without disclosure', async () => {
  const gate = createPixelPrivacyGateV1({
    pixelState: {
      async pause() { throw new Error('PRIVATE_PAUSE_DETAIL'); },
      async gateRunnerStart() { throw new Error('unexpected'); },
    },
    consentId: null,
    authorityExpiresAt: 1_900_000_000_000,
    async afterPixels() {},
  });
  await assert.rejects(
    () => gate.preflight({ auditId: 'audit-1', observedTarget: TARGET, capturePolicy: POLICY, signals: SENSITIVE }),
    error => error?.message === 'PIXEL_PRIVACY_GATE_DENIED' && !String(error).includes('PRIVATE_PAUSE_DETAIL'),
  );
});

test('a private final pause failure remains cleanup-eligible exactly once', async () => {
  let cleanupCalls = 0;
  const gate = createPixelPrivacyGateV1({
    pixelState: {
      async pause() { throw new Error('PRIVATE_FINAL_PAUSE_DETAIL'); },
      async gateRunnerStart() { throw new Error('unexpected'); },
    },
    consentId: null,
    authorityExpiresAt: 1_900_000_000_000,
    async afterPixels() { cleanupCalls += 1; },
  });
  await gate.preflight({ auditId: 'audit-1', observedTarget: TARGET, capturePolicy: POLICY, signals: EMPTY });
  await assert.rejects(
    () => gate.authorizeFirstPixel({
      auditId: 'audit-1', observedTarget: TARGET, capturePolicy: POLICY, proof: PROOF, signals: SENSITIVE,
    }),
    error => error?.message === 'PIXEL_PRIVACY_GATE_DENIED' && !String(error).includes('PRIVATE_FINAL_PAUSE_DETAIL'),
  );
  await gate.afterPixels({ auditId: 'audit-1', pixelStarted: false });
  assert.equal(cleanupCalls, 1);
});
