import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertPixelPipelineAuthorizedV1,
  createPixelRasterBoundaryV1,
  createPixelPipelinePreflightV1,
  createPixelPrivacyGateV1,
  didPixelRasterStartV1,
  didPixelRasterTargetChangeV1,
  isPixelRasterBoundaryV1,
  isPixelPrivacyGateV1,
} from '../../src/background/pixel-privacy-gate.js';
import {
  createScriptedPixelCommitClockV1,
  readPixelCommitEpochV1,
} from '../../src/background/pixel-commit-clock.js';
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
const CLOCK_EPOCH = 1_800_000_000_010;
const commitClock = (epochs = Array(8).fill(CLOCK_EPOCH)) =>
  createScriptedPixelCommitClockV1({ epochs });

function suspension({
  state = 'paused', resumePhase = null, consentId = 'B'.repeat(21) + 'Q',
  policy = POLICY, categories = SENSITIVE.categories, evidence = TARGET.urlEvidence,
  issuedAt = 1_800_000_000_000, updatedAt = CLOCK_EPOCH,
  expiresAt = 1_800_000_600_000,
} = {}) {
  return {
    version: 'AuditSuspensionV1', revision: 1, auditId: 'audit-1', consentId,
    tabId: 7, windowId: 3, documentId: 'doc-1', urlEvidence: evidence,
    urlSessionDigest: DIGEST, mode: policy.mode, capturePolicy: policy,
    categories, issuedAt, updatedAt, expiresAt,
    cleanupAttempts: 0, cleanupNotBefore: null, state, resumePhase,
    revokeReason: null, source: { kind: 'attached' },
  };
}

function fixture({
  consentId = null,
  gateResult = 'ready',
  pauseValue = null,
  runnerSuspension = null,
  clock = commitClock(),
} = {}) {
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
    commitClock: clock,
    async afterPixels() { calls.push(['after-pixels']); },
  });
  return { gate, calls };
}

function deferred() {
  let resolve;
  const promise = new Promise(currentResolve => { resolve = currentResolve; });
  return { promise, resolve };
}

async function rasterFixture({
  policy = POLICY,
  consentId = null,
  clock = commitClock(),
  signal = new AbortController().signal,
  probeDocumentIdentity = async () => PROOF,
  probeSensitiveCaptureSignals = async () => EMPTY,
  captureFullPage = async () => 'full-page',
  captureElement = async () => 'element',
  gateResult = 'ready',
  runnerSuspension = null,
  beforeGateResult = async () => {},
} = {}) {
  const cleanup = [];
  const gate = createPixelPrivacyGateV1({
    pixelState: {
      async pause() { throw new Error('unexpected pause'); },
      async gateRunnerStart(value) {
        await beforeGateResult();
        return gateResult === 'ready'
          ? {
              version: 'PixelRunnerGateResultV1', status: 'ready',
              suspension: runnerSuspension ?? suspension({
                state: 'resuming', resumePhase: 'runner-started', consentId,
                policy, categories: value.categories,
              }),
            }
          : {
              version: 'PixelRunnerGateResultV1', status: 'repaused',
              suspension: runnerSuspension ?? suspension({
                consentId: 'C'.repeat(21) + 'Q', policy, categories: value.categories,
              }),
            };
      },
    },
    consentId, authorityExpiresAt: 1_900_000_000_000, commitClock: clock,
    async afterPixels() { cleanup.push('after'); },
  });
  await gate.preflight({ auditId: 'audit-1', observedTarget: TARGET, capturePolicy: policy, signals: EMPTY });
  const boundary = createPixelRasterBoundaryV1({
    auditId: 'audit-1', observedTarget: TARGET, capturePolicy: policy, privacyGate: gate,
    probeDocumentIdentity, probeSensitiveCaptureSignals, signal,
    captureFullPage: policy.captureFullPage ? captureFullPage : null,
    captureElement: policy.captureElements ? captureElement : null,
  });
  return { boundary, gate, cleanup };
}

test('pixel raster boundary is opaque and rejects hostile factory envelopes before effects', async () => {
  let effects = 0;
  const { gate } = fixture();
  await gate.preflight({ auditId: 'audit-1', observedTarget: TARGET, capturePolicy: POLICY, signals: EMPTY });
  const base = {
    auditId: 'audit-1', observedTarget: TARGET, capturePolicy: POLICY, privacyGate: gate,
    probeDocumentIdentity: async () => { effects += 1; return PROOF; },
    probeSensitiveCaptureSignals: async () => { effects += 1; return EMPTY; },
    signal: new AbortController().signal,
    captureFullPage: async () => { effects += 1; },
    captureElement: async () => { effects += 1; },
  };
  const getter = { ...base };
  Object.defineProperty(getter, 'captureFullPage', {
    enumerable: true,
    get() { effects += 1; return async () => {}; },
  });
  const symbol = { ...base, [Symbol('private')]: true };
  for (const input of [
    { ...base, privacyGate: { ...gate } },
    { ...base, extra: true },
    getter,
    symbol,
    new Proxy(base, { ownKeys() { throw new Error('PRIVATE_FACTORY_PROXY'); } }),
  ]) assert.throws(() => createPixelRasterBoundaryV1(input), /PIXEL_PRIVACY_GATE_DENIED/u);
  assert.equal(effects, 0);

  const boundary = createPixelRasterBoundaryV1(base);
  assert.equal(isPixelRasterBoundaryV1(boundary), true);
  const copiedBoundary = { ...boundary };
  assert.equal(isPixelRasterBoundaryV1(copiedBoundary), false);
  await assert.rejects(() => copiedBoundary.captureFullPage(), /PIXEL_CAPTURE_BOUNDARY_DENIED/u);
  assert.equal(effects, 0);
  assert.equal(Object.isFrozen(boundary), true);
});

test('first raster probes fresh signals, proves twice, commits once and later rasters re-prove without replay', async () => {
  const events = [];
  let proof = 0;
  const { boundary, gate } = await rasterFixture({
    probeSensitiveCaptureSignals: async () => { events.push('signals'); return EMPTY; },
    probeDocumentIdentity: async () => { proof += 1; events.push(`proof-${proof}`); return PROOF; },
    captureFullPage: () => { events.push('full-page'); return Promise.resolve('full'); },
    captureElement: () => { events.push('element'); return Promise.resolve('element'); },
  });

  assert.equal(await boundary.captureFullPage('opaque-cdp'), 'full');
  assert.deepEqual(events, ['signals', 'proof-1', 'proof-2', 'full-page']);
  assert.equal(await boundary.captureElement('opaque-cdp', { x: 1 }), 'element');
  assert.deepEqual(events, ['signals', 'proof-1', 'proof-2', 'full-page', 'proof-3', 'element']);
  assert.equal(didPixelRasterStartV1(boundary), true);
  assert.equal(didPixelRasterTargetChangeV1(boundary), false);
  assert.equal(assertPixelPipelineAuthorizedV1(gate, { auditId: 'audit-1', capturePolicy: POLICY }), true);
});

test('first raster fails closed for expired, non-monotonic or invalid private clocks', async t => {
  const deadline = 1_900_000_000_000;
  const scenarios = [
    ['equal deadline', [deadline - 1, deadline]],
    ['rollback', [deadline - 1, deadline - 2]],
    ['exhausted', [deadline - 1]],
  ];
  for (const [name, values] of scenarios) await t.test(name, async () => {
    let rasters = 0;
    const { boundary, gate } = await rasterFixture({
      clock: commitClock(values),
      captureFullPage: async () => { rasters += 1; },
    });
    await assert.rejects(() => boundary.captureFullPage(), error => {
      assert.equal(error.message, 'PIXEL_CAPTURE_BOUNDARY_DENIED');
      assert.doesNotMatch(String(error), /PRIVATE_CLOCK/u);
      return true;
    });
    assert.equal(rasters, 0);
    assert.equal(didPixelRasterStartV1(boundary), false);
    assert.throws(
      () => assertPixelPipelineAuthorizedV1(gate, { auditId: 'audit-1', capturePolicy: POLICY }),
      /PIXEL_PRIVACY_GATE_DENIED/u,
    );
  });
});

test('one branded clock rejects a rollback that crosses gate instances before another raster', async () => {
  const sharedClock = commitClock([100, 101, 99]);
  let rasters = 0;
  const first = await rasterFixture({
    clock: sharedClock,
    captureFullPage: async () => { rasters += 1; return 'first'; },
  });
  assert.equal(await first.boundary.captureFullPage(), 'first');

  const second = await rasterFixture({
    clock: sharedClock,
    captureFullPage: async () => { rasters += 1; return 'second'; },
  });
  await assert.rejects(() => second.boundary.captureFullPage(), /PIXEL_CAPTURE_BOUNDARY_DENIED/u);
  assert.equal(rasters, 1);
  assert.equal(didPixelRasterStartV1(second.boundary), false);
});

test('a canonical resumed suspension promotes updatedAt before the final commit-clock read', async () => {
  const consentId = 'A'.repeat(21) + 'Q';
  const authorizationAt = CLOCK_EPOCH;
  const suspensionUpdatedAt = CLOCK_EPOCH + 10;
  let rasters = 0;
  const { boundary } = await rasterFixture({
    consentId,
    clock: commitClock([authorizationAt, suspensionUpdatedAt - 1]),
    runnerSuspension: suspension({
      state: 'resuming', resumePhase: 'runner-started', consentId,
      updatedAt: suspensionUpdatedAt, expiresAt: suspensionUpdatedAt + 100,
    }),
    captureFullPage: async () => { rasters += 1; },
  });
  await assert.rejects(() => boundary.captureFullPage(), /PIXEL_CAPTURE_BOUNDARY_DENIED/u);
  assert.equal(rasters, 0);
});

test('runner suspension is descriptor-copied once instead of validating one proxy view and consuming another', async () => {
  const consentId = 'A'.repeat(21) + 'Q';
  const invalid = suspension({
    state: 'resuming', resumePhase: 'runner-started', consentId,
    expiresAt: 1_800_000_000_001,
  });
  const valid = suspension({ state: 'resuming', resumePhase: 'runner-started', consentId });
  const keys = Reflect.ownKeys(invalid);
  let descriptorReads = 0;
  const alternating = new Proxy(invalid, {
    ownKeys() { return keys; },
    getOwnPropertyDescriptor(_target, key) {
      const source = descriptorReads < keys.length ? invalid : valid;
      descriptorReads += 1;
      return Object.getOwnPropertyDescriptor(source, key);
    },
  });
  const { gate } = fixture({ consentId, runnerSuspension: alternating });
  await gate.preflight({ auditId: 'audit-1', observedTarget: TARGET, capturePolicy: POLICY, signals: EMPTY });
  await assert.rejects(() => gate.authorizeFirstPixel({
    auditId: 'audit-1', observedTarget: TARGET, capturePolicy: POLICY, proof: PROOF, signals: EMPTY,
  }), /PIXEL_PRIVACY_GATE_DENIED/u);
});

test('document drift or native abort after the final proof starts no raster', async t => {
  await t.test('document drift while runner gate is pending', async () => {
    let documentId = 'doc-1';
    let rasters = 0;
    const consentId = 'A'.repeat(21) + 'Q';
    const { boundary } = await rasterFixture({
      consentId,
      probeDocumentIdentity: async () => ({ ...PROOF, documentId }),
      beforeGateResult: async () => { documentId = 'doc-2'; },
      captureFullPage: async () => { rasters += 1; },
    });
    await assert.rejects(() => boundary.captureFullPage(), /PIXEL_CAPTURE_BOUNDARY_DENIED/u);
    assert.equal(rasters, 0);
    assert.equal(didPixelRasterTargetChangeV1(boundary), true);
  });

  await t.test('abort on final proof return', async () => {
    const controller = new AbortController();
    let proofs = 0;
    let rasters = 0;
    const { boundary } = await rasterFixture({
      signal: controller.signal,
      probeDocumentIdentity: async () => {
        proofs += 1;
        if (proofs === 2) controller.abort(new DOMException('PRIVATE_ABORT', 'AbortError'));
        return PROOF;
      },
      captureFullPage: async () => { rasters += 1; },
    });
    await assert.rejects(() => boundary.captureFullPage(), error => {
      assert.equal(error.message, 'PIXEL_CAPTURE_BOUNDARY_DENIED');
      assert.doesNotMatch(String(error), /PRIVATE_ABORT/u);
      return true;
    });
    assert.equal(rasters, 0);
  });
});

test('concurrent first-raster attempts invoke at most one captured effect', async () => {
  const hold = deferred();
  let probes = 0;
  let rasters = 0;
  const { boundary } = await rasterFixture({
    probeSensitiveCaptureSignals: async () => { probes += 1; await hold.promise; return EMPTY; },
    captureFullPage: async () => { rasters += 1; return 'done'; },
  });
  const first = boundary.captureFullPage();
  await Promise.resolve();
  const second = boundary.captureFullPage();
  hold.resolve();
  const results = await Promise.allSettled([first, second]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.equal(probes, 1);
  assert.equal(rasters, 1);
});

test('a started raster remains factual across sync throw or rejection and cleanup is one-shot', async t => {
  for (const [name, effect] of [
    ['sync throw', () => { throw new Error('PRIVATE_SYNC_RASTER'); }],
    ['promise rejection', async () => { throw new Error('PRIVATE_ASYNC_RASTER'); }],
  ]) await t.test(name, async () => {
    const { boundary, gate, cleanup } = await rasterFixture({ captureFullPage: effect });
    await assert.rejects(() => boundary.captureFullPage(), error => {
      assert.equal(error.message, 'PIXEL_CAPTURE_BOUNDARY_DENIED');
      assert.doesNotMatch(String(error), /PRIVATE_(?:SYNC|ASYNC)_RASTER/u);
      return true;
    });
    assert.equal(didPixelRasterStartV1(boundary), true);
    await gate.afterPixels({ auditId: 'audit-1', pixelStarted: true });
    await assert.rejects(() => gate.afterPixels({ auditId: 'audit-1', pixelStarted: true }), /PIXEL_PRIVACY_GATE_DENIED/u);
    assert.deepEqual(cleanup, ['after']);
  });
});

test('only element-only may settle without a raster and its attestation permanently denies late capture', async () => {
  const policy = createCapturePolicyV1({ mode: 'element-only', includeQuery: false });
  let rasters = 0;
  const { boundary, gate } = await rasterFixture({
    policy,
    captureElement: async () => { rasters += 1; },
  });
  await boundary.settle();
  assert.equal(assertPixelPipelineAuthorizedV1(gate, { auditId: 'audit-1', capturePolicy: policy }), true);
  await assert.rejects(() => boundary.captureElement(), /PIXEL_CAPTURE_BOUNDARY_DENIED/u);
  assert.equal(rasters, 0);
  assert.equal(didPixelRasterStartV1(boundary), false);

  const full = await rasterFixture();
  await assert.rejects(() => full.boundary.settle(), /PIXEL_CAPTURE_BOUNDARY_DENIED/u);
  assert.throws(
    () => assertPixelPipelineAuthorizedV1(full.gate, { auditId: 'audit-1', capturePolicy: POLICY }),
    /PIXEL_PRIVACY_GATE_DENIED/u,
  );
  await full.gate.afterPixels({ auditId: 'audit-1', pixelStarted: false });
});

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

test('gate accepts only a branded commit clock from a closed own data descriptor', () => {
  let effects = 0;
  const clock = commitClock();
  const base = {
    pixelState: {
      async pause() { effects += 1; },
      async gateRunnerStart() { effects += 1; },
    },
    consentId: null,
    authorityExpiresAt: 1_900_000_000_000,
    commitClock: clock,
    async afterPixels() { effects += 1; },
  };
  const accessor = { ...base };
  Object.defineProperty(accessor, 'commitClock', {
    enumerable: true,
    get() { effects += 1; return clock; },
  });
  for (const input of [
    accessor,
    { ...base, commitClock: { ...clock } },
    { ...base, commitClock: new Proxy(clock, {}) },
    { ...base, [Symbol('private')]: true },
    { ...base, extra: true },
    new Proxy(base, { ownKeys() { throw new Error('PRIVATE_GATE_PROXY'); } }),
  ]) assert.throws(() => createPixelPrivacyGateV1(input), /PIXEL_PRIVACY_GATE_DENIED/u);
  assert.equal(effects, 0);
  const gate = createPixelPrivacyGateV1(base);
  assert.equal(Object.hasOwn(gate, 'commitClock'), false);
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
            issuedAt: 1_800_000_000_000, updatedAt: CLOCK_EPOCH, expiresAt: 1_800_000_600_000,
            cleanupAttempts: 0, cleanupNotBefore: null, state: 'paused', resumePhase: null,
            revokeReason: null, source: { kind: 'attached' },
          };
        },
        async gateRunnerStart() { throw new Error('unexpected'); },
      },
      consentId: null, authorityExpiresAt: 1_900_000_000_000,
      commitClock: commitClock(), async afterPixels() {},
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
            issuedAt: 1_800_000_000_000, updatedAt: CLOCK_EPOCH, expiresAt: 1_800_000_600_000,
            cleanupAttempts: 0, cleanupNotBefore: null, state: 'paused', resumePhase: null,
            revokeReason: null, source: { kind: 'attached' },
          };
        },
        async gateRunnerStart() { throw new Error('unexpected'); },
      },
      consentId: null, authorityExpiresAt: 1_900_000_000_000,
      commitClock: commitClock(), async afterPixels() {},
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

test('a ready gate without a raster commit or explicit settle cannot attest the pipeline', async () => {
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
  assert.throws(
    () => assertPixelPipelineAuthorizedV1(gate, { auditId: 'audit-1', capturePolicy: POLICY }),
    /PIXEL_PRIVACY_GATE_DENIED/u,
  );
  await assert.rejects(() => gate.afterPixels({ auditId: 'audit-1', pixelStarted: true }), /PIXEL_PRIVACY_GATE_DENIED/u);
  await gate.afterPixels({ auditId: 'audit-1', pixelStarted: false });
  await assert.rejects(() => gate.afterPixels({ auditId: 'audit-1', pixelStarted: false }), /PIXEL_PRIVACY_GATE_DENIED/u);
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
    commitClock: commitClock(),
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
    commitClock: commitClock(),
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
    () => gate.afterPixels({ auditId: 'audit-1', pixelStarted: false }),
    error => error?.message === 'PIXEL_PRIVACY_GATE_DENIED' && !String(error).includes('PRIVATE_AFTER_PIXELS_DETAIL'),
  );
  assert.equal(cleanupCalls, 1);
  await assert.rejects(
    () => gate.afterPixels({ auditId: 'audit-1', pixelStarted: false }),
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
    commitClock: commitClock(),
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
    commitClock: commitClock(),
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
