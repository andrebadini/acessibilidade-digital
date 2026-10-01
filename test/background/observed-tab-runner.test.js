import assert from 'node:assert/strict';
import test from 'node:test';

import {
  readObservedAuditInterruption,
  runObservedTabAudit,
} from '../../src/background/observed-tab-runner.js';
import { createObservedPipelineRunner } from '../../src/background/audit-pipeline.js';
import { createPixelPipelinePreflightV1, createPixelPrivacyGateV1, createPixelRasterBoundaryV1 } from '../../src/background/pixel-privacy-gate.js';
import { createScriptedPixelCommitClockV1 } from '../../src/background/pixel-commit-clock.js';
import { createAuditModel } from '../../src/core/report/audit-model.js';
import { createCapturePolicyV1 } from '../../src/core/privacy/capture-policy.js';
import { sanitizeEvidenceUrlV1 } from '../../src/core/privacy/evidence-url.js';
import { SAMPLE_AUDIT } from '../../fixtures/audits/sample-audit.js';

const DIGEST = `hmac-sha256:${'A'.repeat(43)}`;
const NAV_TOKEN = 'A'.repeat(22);
const EVIDENCE = sanitizeEvidenceUrlV1('https://example.test/a', { includeQuery: false });
const POLICY = createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false });
const FULL_POLICY = createCapturePolicyV1({ mode: 'full-evidence', includeQuery: false });
const ELEMENT_POLICY = createCapturePolicyV1({ mode: 'element-only', includeQuery: false });
const QUERY_POLICY = createCapturePolicyV1({ mode: 'no-pixels', includeQuery: true });
const QUERY_EVIDENCE = sanitizeEvidenceUrlV1('https://example.test/a?secret=1', { includeQuery: true });
const NOW = () => '2026-08-31T12:00:00.000Z';
const EMPTY_SIGNALS = Object.freeze({ version: 'SensitiveCaptureSignalsV1', detected: false, categories: Object.freeze([]) });
const SENSITIVE_SIGNALS = Object.freeze({ version: 'SensitiveCaptureSignalsV1', detected: true, categories: Object.freeze(['password']) });

function deferred() {
  let resolve;
  const promise = new Promise(currentResolve => { resolve = currentResolve; });
  return { promise, resolve };
}

function model() {
  const copy = structuredClone(SAMPLE_AUDIT);
  copy.auditId = 'audit-1';
  copy.finalUrl = EVIDENCE.href;
  copy.pages[0].finalUrl = EVIDENCE.href;
  return createAuditModel(copy);
}

function checkpoint() {
  return { version: 1, auditId: 'audit-1', pages: [{ pageId: 'page-1', attempted: true,
    startedAt: NOW(), rulesVersion: '1.0.0', inventoryVersion: '1.0.0', inventoryHash: 'a'.repeat(64), outcomes: [] }] };
}

function ownedRecord({ state = 'created', tabId = 41, windowId = 3, cleanupMode = 'always' } = {}) {
  return Object.freeze({ version: 2, ownershipId: 'ownership-1', auditId: 'audit-1', purpose: 'audit',
    tabId, windowId, cleanupMode, state,
    createdAt: NOW(), updatedAt: NOW() });
}

function ownedPrivacyGate({ policy, calls, consentId = null, sensitive = SENSITIVE_SIGNALS } = {}) {
  const source = Object.freeze({
    kind: 'owned-disposable', ownershipId: 'ownership-1',
    cleanupMode: 'pre-observation-failure', pageId: 'page-1',
  });
  const suspension = ({ state, resumePhase, token, categories }) => ({
    version: 'AuditSuspensionV1', revision: 1, auditId: 'audit-1', consentId: token,
    tabId: 41, windowId: 3, documentId: 'doc-1', urlEvidence: EVIDENCE,
    urlSessionDigest: DIGEST, mode: policy.mode, capturePolicy: policy, categories,
    issuedAt: 1_800_000_000_000, updatedAt: 1_800_000_000_010, expiresAt: 1_800_000_600_000,
    cleanupAttempts: 0, cleanupNotBefore: null, state, resumePhase,
    revokeReason: null, source,
  });
  return createPixelPrivacyGateV1({
    pixelState: {
      // O portão nunca pausa: sinal sensível não barra a captura.
      async pause() { calls.push('pause'); throw new Error('PIXEL_GATE_MUST_NOT_PAUSE'); },
      async gateRunnerStart(value) {
        calls.push('gate');
        return {
          version: 'PixelRunnerGateResultV1', status: 'ready',
          suspension: suspension({ state: 'resuming', resumePhase: 'runner-started', token: consentId, categories: value.categories }),
        };
      },
    },
    consentId, authorityExpiresAt: 1_900_000_000_000,
    commitClock: createScriptedPixelCommitClockV1({ epochs: Array(8).fill(1_800_000_000_010) }),
    async afterPixels() { calls.push('after'); },
  });
}

function attachedTarget(overrides = {}) {
  return {
    kind: 'attached', tabId: 7, windowId: 3, documentId: 'doc-1',
    initialUrlEvidence: EVIDENCE, initialUrlSessionDigest: DIGEST, ...overrides,
  };
}

async function observedResult(input, status = 'partial') {
  await input.beforePersist({ observedTarget: input.observedTarget });
  return { model: model(), status, checkpoint: checkpoint(), observationState: 'observed' };
}

function makePrivacyGate({ policy = FULL_POLICY, calls = [], consentId = null, sensitive = SENSITIVE_SIGNALS } = {}) {
  return createPixelPrivacyGateV1({
    pixelState: {
      // O portão nunca pausa: sinal sensível não barra a captura.
      async pause() { calls.push(['pause']); throw new Error('PIXEL_GATE_MUST_NOT_PAUSE'); },
      async gateRunnerStart() { throw new Error('unexpected resume'); },
    },
    consentId, authorityExpiresAt: 1_900_000_000_000,
    commitClock: createScriptedPixelCommitClockV1({ epochs: Array(8).fill(1_800_000_000_010) }),
    async afterPixels() { calls.push('after-pixels'); },
  });
}

function fixture({ policy = POLICY, target = attachedTarget(), modelStatus = 'partial', adapter = {}, signal, pipelineMarker = false, startedMarker = false, pipelineServices = {}, privacyGate = undefined } = {}) {
  const calls = [];
  const gate = privacyGate === undefined
    ? policy.mode === 'no-pixels' ? null : makePrivacyGate({ policy, calls })
    : privacyGate;
  const checkpointRecorder = { async started() { if (startedMarker) calls.push('started'); }, async record() {}, snapshot() { return checkpoint(); } };
  const services = {
    async collectObservedPage() { if (pipelineMarker) calls.push('pipeline'); return { snapshot: { title: 'safe' } }; },
    async runCoreRules() { return { ruleResults: [] }; },
    async buildAuditModel() { return model(); },
    async persistAuditModel() {},
    ...pipelineServices,
  };
  const probeSensitiveCaptureSignals = typeof adapter.probeSensitiveCaptureSignals === 'function'
    ? adapter.probeSensitiveCaptureSignals
    : async () => { calls.push('probe-sensitive'); return EMPTY_SIGNALS; };
  const pixelPreflight = gate === null ? null : createPixelPipelinePreflightV1(gate, { probeSensitiveCaptureSignals });
  const canonicalPipeline = createObservedPipelineRunner({
    checkpointRecorder, services,
    ...(gate === null ? {} : { privacyGate: gate, pixelPreflight }),
  });
  const chromeAdapter = {
    async probeDocumentIdentity(tabId) {
      calls.push(['probe-document', tabId]);
      return { tabId: target.tabId ?? 7, windowId: target.windowId ?? 3, documentId: 'doc-1', urlSessionDigest: DIGEST };
    },
    probeSensitiveCaptureSignals,
    runPipeline: canonicalPipeline,
    ...adapter,
  };
  const input = {
    auditId: 'audit-1', target, chromeAdapter, capturePolicy: policy,
    privacyGate: gate,
    onCheckpoint: async value => { calls.push(['checkpoint', value]); }, now: NOW, signal,
    expectedExtensionId: 'extension-id',
  };
  return { input, calls };
}

test('rejects legacy arguments before any adapter effect, including getter and symbol extras', async () => {
  const { input, calls } = fixture();
  for (const key of ['privacyDecision', 'checkpointRecorder', 'extra']) {
    const hostile = { ...input, [key]: key === 'extra' ? true : { status: 'no-pixels' } };
    await assert.rejects(() => runObservedTabAudit(hostile), /OBSERVED_RUNNER_DENIED/u);
  }
  let getterCalls = 0;
  const getterInput = { ...input };
  Object.defineProperty(getterInput, 'privacyDecision', { enumerable: true, get() { getterCalls += 1; return {}; } });
  getterInput[Symbol('legacy')] = true;
  await assert.rejects(() => runObservedTabAudit(getterInput), /OBSERVED_RUNNER_DENIED/u);
  assert.equal(getterCalls, 0);
  assert.deepEqual(calls, []);
  await assert.rejects(() => runObservedTabAudit({ ...input, capturePolicy: QUERY_POLICY, target: attachedTarget({ initialUrlEvidence: QUERY_EVIDENCE }) }), /OBSERVED_RUNNER_DENIED/u);
  assert.deepEqual(calls, []);
});

test('rejects every unbranded or mismatched pixel gate and owned pixel policy before effects', async () => {
  const { input, calls } = fixture({ policy: FULL_POLICY });
  const realGate = input.privacyGate;
  let getterCalls = 0;
  const getterGate = {};
  Object.defineProperty(getterGate, 'preflight', { enumerable: true, get() { getterCalls += 1; return realGate.preflight; } });
  getterGate.authorizeFirstPixel = realGate.authorizeFirstPixel;
  getterGate.afterPixels = realGate.afterPixels;
  getterGate[Symbol('extra')] = true;
  for (const privacyGate of [
    {}, { ...realGate }, { ...realGate, extra: true },
    { preflight: realGate.preflight.bind(realGate), authorizeFirstPixel: realGate.authorizeFirstPixel, afterPixels: realGate.afterPixels },
    getterGate,
  ]) await assert.rejects(() => runObservedTabAudit({ ...input, privacyGate }), /OBSERVED_RUNNER_DENIED/u);
  assert.equal(getterCalls, 0);
  assert.deepEqual(calls, []);

  let ownedEffects = 0;
  const owned = fixture({
    policy: ELEMENT_POLICY,
    target: { kind: 'owned-disposable', ownershipId: 'ownership-1', navigationToken: NAV_TOKEN, cleanupMode: 'always', pageId: 'page-1' },
    adapter: { async createTab() { ownedEffects += 1; return { id: 41, windowId: 3 }; } },
  });
  await assert.rejects(() => runObservedTabAudit(owned.input), /OBSERVED_RUNNER_DENIED/u);
  assert.equal(ownedEffects, 0);
});

test('rejects legacy observed targets and string evidence before probing or pipeline', async () => {
  for (const target of [
    { ...attachedTarget(), version: 1 },
    { kind: 'attached', tabId: 7, windowId: 3, documentId: 'doc-1', initialUrlEvidence: 'https://example.test', initialUrlSessionDigest: DIGEST },
    { version: 'ObservedTargetV1', kind: 'disposable', ownerId: 'owner-1', tabId: 7, windowId: 3, documentId: 'doc-1', urlEvidence: EVIDENCE, urlSessionDigest: DIGEST },
    { kind: 'owned-disposable', ownershipId: 'ownership-1', tabId: 41, windowId: 3, documentId: 'doc-1', initialUrlEvidence: EVIDENCE, initialUrlSessionDigest: DIGEST, navigationToken: NAV_TOKEN, cleanupMode: 'always', pageId: 'page-1' },
    { version: 'ObservedTargetV1', kind: 'owned-disposable', ownershipId: 'ownership-1', tabId: 41, windowId: 3, documentId: 'doc-1', urlEvidence: EVIDENCE, urlSessionDigest: DIGEST, cleanupMode: 'always', pageId: 'page-1' },
    { kind: 'owned-disposable-resume', ownershipId: 'ownership-1', tabId: 41, windowId: 3, documentId: 'doc-1', initialUrlEvidence: EVIDENCE, initialUrlSessionDigest: DIGEST, cleanupMode: 'always', pageId: 'page-1' },
    { kind: 'owned-disposable-resume', ownershipId: 'ownership-1', tabId: 41, windowId: 3, documentId: 'doc-1', initialUrlEvidence: EVIDENCE, initialUrlSessionDigest: DIGEST, cleanupMode: 'pre-observation-failure', pageId: null },
  ]) {
    const { input, calls } = fixture({ target });
    await assert.rejects(() => runObservedTabAudit(input), /OBSERVED_RUNNER_DENIED/u);
    assert.deepEqual(calls, []);
  }
});

test('no-pixels completes without privacy gate, consent, probe or pixel calls', async () => {
  const calls = [];
  const { input } = fixture({ pipelineMarker: true, adapter: {
    async probeDocumentIdentity() { calls.push('probe'); return { tabId: 7, windowId: 3, documentId: 'doc-1', urlSessionDigest: DIGEST }; },
    async captureFullPage() { calls.push('full-page'); }, async captureElement() { calls.push('element'); },
  } });
  assert.equal(input.privacyGate, null);
  const result = await runObservedTabAudit(input);
  assert.equal(result.status, 'partial');
  assert.equal(result.observationState, 'observed');
  assert.equal(result.ownershipState, 'attached');
  assert.deepEqual(calls, ['probe', 'probe']);

  const withGate = fixture().input;
  withGate.privacyGate = makePrivacyGate({ calls });
  await assert.rejects(() => runObservedTabAudit(withGate), /OBSERVED_RUNNER_DENIED/u);
  assert.deepEqual(calls, ['probe', 'probe']);
});

test('sensitive attached preflight arms and the audit proceeds to a terminal result', async () => {
  const calls = [];
  const gate = makePrivacyGate({ policy: FULL_POLICY, calls });
  const { input, calls: runnerCalls } = fixture({
    policy: FULL_POLICY, privacyGate: gate,
    pipelineMarker: true, startedMarker: true,
    pipelineServices: {
      async collectObservedPage({ observedTarget }) {
        runnerCalls.push('pipeline');
        const boundary = createPixelRasterBoundaryV1({
          auditId: 'audit-1', observedTarget, capturePolicy: FULL_POLICY, privacyGate: gate,
          async probeDocumentIdentity() { return { tabId: 7, windowId: 3, documentId: 'doc-1', urlSessionDigest: DIGEST }; },
          async probeSensitiveCaptureSignals() { return SENSITIVE_SIGNALS; }, signal: undefined,
          async captureFullPage() { calls.push('full-page'); },
          async captureElement() { calls.push('element'); },
        });
        await boundary.captureFullPage();
        return { snapshot: { title: 'safe' } };
      },
    },
    adapter: { async probeSensitiveCaptureSignals() { calls.push('sensitive-probe'); return SENSITIVE_SIGNALS; } },
  });
  const result = await runObservedTabAudit(input);
  assert.equal(result.status, 'partial');
  assert.equal(result.model.auditId, 'audit-1');
  assert.deepEqual(result.observedTarget, {
    version: 'ObservedTargetV1', kind: 'attached', tabId: 7, windowId: 3,
    documentId: 'doc-1', urlEvidence: EVIDENCE, urlSessionDigest: DIGEST,
  });
  assert.equal(result.observationState, 'observed');
  assert.equal(result.ownershipState, 'attached');
  assert.equal(calls.filter(call => Array.isArray(call) && call[0] === 'pause').length, 0);
  assert.equal(runnerCalls.filter(call => call === 'started').length, 1);
  assert.equal(runnerCalls.includes('pipeline'), true);
  assert.equal(calls.includes('full-page'), true);
});

test('fresh owned pixel audit with sensitive signals proceeds and captures without pausing', async () => {
  const calls = [];
  const gate = ownedPrivacyGate({ policy: FULL_POLICY, calls });
  let state = 'created';
  const { input } = fixture({
    policy: FULL_POLICY,
    privacyGate: gate,
    target: {
      kind: 'owned-disposable', ownershipId: 'ownership-1', navigationToken: NAV_TOKEN,
      cleanupMode: 'pre-observation-failure', pageId: 'page-1',
    },
    pipelineServices: {
      async collectObservedPage({ observedTarget }) {
        const boundary = createPixelRasterBoundaryV1({
          auditId: 'audit-1', observedTarget, capturePolicy: FULL_POLICY, privacyGate: gate,
          async probeDocumentIdentity() { return { tabId: 41, windowId: 3, documentId: 'doc-1', urlSessionDigest: DIGEST }; },
          async probeSensitiveCaptureSignals() { return SENSITIVE_SIGNALS; }, signal: undefined,
          async captureFullPage() { calls.push('raster'); },
          async captureElement() { calls.push('element'); },
        });
        await boundary.captureFullPage();
        return { snapshot: { title: 'safe' } };
      },
    },
    adapter: {
      async createTab() { calls.push('create'); return { id: 41, windowId: 3 }; },
      async resolveNavigationToken() { calls.push('vault'); return 'https://example.test/a'; },
      async navigateTab() { calls.push('navigate'); },
      async waitForStable() { calls.push('stable'); },
      async getEvidenceUrl() { return EVIDENCE; },
      async probeDocumentIdentity() { return { tabId: 41, windowId: 3, documentId: 'doc-1', urlSessionDigest: DIGEST }; },
      async probeSensitiveCaptureSignals() { return SENSITIVE_SIGNALS; },
      async removeTab() { calls.push('remove'); },
      ownedTabs: {
        async registerCreated() { state = 'created'; return ownedRecord({ state, cleanupMode: 'pre-observation-failure' }); },
        async get() { return ownedRecord({ state, cleanupMode: 'pre-observation-failure' }); },
        async transition({ fromState, toState }) {
          assert.equal(state, fromState);
          state = toState;
          return ownedRecord({ state, cleanupMode: 'pre-observation-failure' });
        },
        async removeOwned() { throw new Error('must retain review'); },
        async markCleanupPending() { throw new Error('must not pending'); },
      },
    },
  });

  const result = await runObservedTabAudit(input);
  assert.equal(result.status, 'partial');
  assert.equal(result.model.auditId, 'audit-1');
  assert.equal(result.ownershipState, 'retained-for-review');
  assert.equal(state, 'retained-for-review');
  assert.equal(calls.includes('raster'), true);
  assert.equal(calls.includes('pause'), false);
});

test('owned consent resume CASes retained owner and captures without create navigate or vault reuse', async () => {
  const calls = [];
  const consentId = 'A'.repeat(21) + 'Q';
  const gate = ownedPrivacyGate({ policy: ELEMENT_POLICY, calls, consentId, sensitive: EMPTY_SIGNALS });
  let state = 'retained-for-consent';
  const resumeTarget = {
    kind: 'owned-disposable-resume', ownershipId: 'ownership-1',
    tabId: 41, windowId: 3, documentId: 'doc-1',
    initialUrlEvidence: EVIDENCE, initialUrlSessionDigest: DIGEST,
    navigationPurpose: 'single-url',
    cleanupMode: 'pre-observation-failure', pageId: 'page-1',
  };
  const { input } = fixture({
    policy: ELEMENT_POLICY, privacyGate: gate, target: resumeTarget,
    pipelineServices: {
      async collectObservedPage({ observedTarget }) {
        const boundary = createPixelRasterBoundaryV1({
          auditId: 'audit-1', observedTarget, capturePolicy: ELEMENT_POLICY, privacyGate: gate,
          async probeDocumentIdentity() { return { tabId: 41, windowId: 3, documentId: 'doc-1', urlSessionDigest: DIGEST }; },
          async probeSensitiveCaptureSignals() { return EMPTY_SIGNALS; }, signal: undefined,
          captureFullPage: null,
          async captureElement() { calls.push('thumbnail'); },
        });
        await boundary.captureElement();
        return { snapshot: { title: 'safe' } };
      },
    },
    adapter: {
      async createTab() { calls.push('forbidden-create'); },
      async navigateTab() { calls.push('forbidden-navigate'); },
      async waitForStable() { calls.push('forbidden-stable'); },
      async resolveNavigationToken() { calls.push('forbidden-vault'); },
      async getEvidenceUrl() { calls.push('forbidden-evidence'); },
      async removeTab() { calls.push('remove'); },
      async probeDocumentIdentity() { return { tabId: 41, windowId: 3, documentId: 'doc-1', urlSessionDigest: DIGEST }; },
      async probeSensitiveCaptureSignals() { return EMPTY_SIGNALS; },
      ownedTabs: {
        async registerCreated() { throw new Error('must-not-register'); },
        async get() { return ownedRecord({ state, cleanupMode: 'pre-observation-failure' }); },
        async transition({ fromState, toState }) {
          assert.equal(state, fromState);
          state = toState;
          return ownedRecord({ state, cleanupMode: 'pre-observation-failure' });
        },
        async removeOwned() { throw new Error('must retain review'); },
        async markCleanupPending() { throw new Error('must retain review'); },
      },
    },
  });

  const result = await runObservedTabAudit(input);
  assert.equal(result.status, 'partial');
  assert.equal(result.ownershipState, 'retained-for-review');
  assert.equal(state, 'retained-for-review');
  assert.deepEqual(calls.filter(value => /^forbidden/u.test(value)), []);
  assert.equal(calls.filter(value => value === 'thumbnail').length, 1);
});

test('owned consent resume rejects a foreign owner record before pipeline or raster', async () => {
  const calls = [];
  const consentId = 'A'.repeat(21) + 'Q';
  const gate = ownedPrivacyGate({ policy: ELEMENT_POLICY, calls, consentId, sensitive: EMPTY_SIGNALS });
  const { input } = fixture({
    policy: ELEMENT_POLICY, privacyGate: gate,
    target: {
      kind: 'owned-disposable-resume', ownershipId: 'ownership-1',
      tabId: 41, windowId: 3, documentId: 'doc-1',
      initialUrlEvidence: EVIDENCE, initialUrlSessionDigest: DIGEST,
      navigationPurpose: 'single-url',
      cleanupMode: 'pre-observation-failure', pageId: 'page-1',
    },
    pipelineServices: {
      async collectObservedPage() { calls.push('pipeline'); throw new Error('must-not-collect'); },
    },
    adapter: {
      async removeTab() { calls.push('remove'); },
      async probeDocumentIdentity() { calls.push('probe'); throw new Error('must-not-probe'); },
      ownedTabs: {
        async registerCreated() { throw new Error('must-not-register'); },
        async get() { return { ...ownedRecord({ state: 'retained-for-consent', cleanupMode: 'pre-observation-failure' }), ownershipId: 'ownership-foreign' }; },
        async transition() { calls.push('transition'); throw new Error('must-not-transition'); },
        async removeOwned() { calls.push('remove-owned'); throw new Error('must-not-remove'); },
        async markCleanupPending() { calls.push('pending'); throw new Error('must-not-pending'); },
      },
    },
  });
  await assert.rejects(() => runObservedTabAudit(input));
  assert.deepEqual(calls, []);
});

test('concurrent owned consent replay loser cannot clean or mutate the winning observing owner', async () => {
  const target = Object.freeze({
    kind: 'owned-disposable-resume', ownershipId: 'ownership-1',
    tabId: 41, windowId: 3, documentId: 'doc-1',
    initialUrlEvidence: EVIDENCE, initialUrlSessionDigest: DIGEST,
    navigationPurpose: 'single-url',
    cleanupMode: 'pre-observation-failure', pageId: 'page-1',
  });
  const bothReadRetained = deferred();
  const winnerConfirmed = deferred();
  const releaseWinner = deferred();
  let retainedReads = 0;
  let state = 'retained-for-consent';
  const loserMutations = [];
  const sharedGet = async () => {
    if (state === 'retained-for-consent' && retainedReads < 2) {
      retainedReads += 1;
      if (retainedReads === 2) bothReadRetained.resolve();
      await bothReadRetained.promise;
      return ownedRecord({ state: 'retained-for-consent', cleanupMode: 'pre-observation-failure' });
    }
    if (state === 'observing') winnerConfirmed.resolve();
    return ownedRecord({ state, cleanupMode: 'pre-observation-failure' });
  };
  const winnerCalls = [];
  const winnerGate = ownedPrivacyGate({
    policy: ELEMENT_POLICY, calls: winnerCalls, consentId: 'A'.repeat(21) + 'Q', sensitive: EMPTY_SIGNALS,
  });
  const winner = fixture({
    policy: ELEMENT_POLICY, privacyGate: winnerGate, target,
    pipelineServices: {
      async collectObservedPage({ observedTarget }) {
        await releaseWinner.promise;
        const boundary = createPixelRasterBoundaryV1({
          auditId: 'audit-1', observedTarget, capturePolicy: ELEMENT_POLICY, privacyGate: winnerGate,
          async probeDocumentIdentity() { return { tabId: 41, windowId: 3, documentId: 'doc-1', urlSessionDigest: DIGEST }; },
          async probeSensitiveCaptureSignals() { return EMPTY_SIGNALS; }, signal: undefined,
          captureFullPage: null, async captureElement() { winnerCalls.push('thumbnail'); },
        });
        await boundary.captureElement();
        return { snapshot: { title: 'safe' } };
      },
    },
    adapter: {
      async removeTab() {},
      async probeDocumentIdentity() { return { tabId: 41, windowId: 3, documentId: 'doc-1', urlSessionDigest: DIGEST }; },
      async probeSensitiveCaptureSignals() { return EMPTY_SIGNALS; },
      ownedTabs: {
        async registerCreated() { throw new Error('must-not-register'); },
        get: sharedGet,
        async transition({ fromState, toState }) {
          assert.equal(state, fromState);
          state = toState;
          return ownedRecord({ state, cleanupMode: 'pre-observation-failure' });
        },
        async removeOwned() { throw new Error('must-not-remove'); },
        async markCleanupPending() { throw new Error('must-not-pend'); },
      },
    },
  });
  const loserCalls = [];
  const loserGate = ownedPrivacyGate({
    policy: ELEMENT_POLICY, calls: loserCalls, consentId: 'A'.repeat(21) + 'Q', sensitive: EMPTY_SIGNALS,
  });
  const loser = fixture({
    policy: ELEMENT_POLICY, privacyGate: loserGate, target,
    pipelineServices: {
      async collectObservedPage() { loserCalls.push('pipeline'); throw new Error('must-not-collect'); },
    },
    adapter: {
      async removeTab() { loserMutations.push('remove-tab'); },
      async probeDocumentIdentity() { loserCalls.push('probe'); throw new Error('must-not-probe'); },
      async probeSensitiveCaptureSignals() { return EMPTY_SIGNALS; },
      ownedTabs: {
        async registerCreated() { throw new Error('must-not-register'); },
        get: sharedGet,
        async transition({ fromState }) {
          assert.equal(fromState, 'retained-for-consent');
          await winnerConfirmed.promise;
          throw new Error('CAS_LOST');
        },
        async removeOwned() { loserMutations.push('remove-owned'); throw new Error('state-mismatch'); },
        async markCleanupPending() {
          loserMutations.push('cleanup-pending');
          state = 'cleanup-pending';
          return ownedRecord({ state, cleanupMode: 'pre-observation-failure' });
        },
      },
    },
  });

  const winningRun = runObservedTabAudit(winner.input);
  const losingRun = runObservedTabAudit(loser.input).then(
    value => ({ value, error: null }),
    error => ({ value: null, error }),
  );
  const losingOutcome = await losingRun;
  const stateBeforeWinnerContinues = state;
  const mutationsBeforeWinnerContinues = [...loserMutations];
  releaseWinner.resolve();
  const winningOutcome = await winningRun;

  assert.match(String(losingOutcome.error), /OBSERVED_RUNNER_DENIED/u);
  assert.equal(losingOutcome.value, null);
  assert.equal(stateBeforeWinnerContinues, 'observing');
  assert.deepEqual(mutationsBeforeWinnerContinues, []);
  assert.equal(winningOutcome.status, 'partial');
  assert.equal(winningOutcome.ownershipState, 'retained-for-review');
});

test('exposes an observed interruption only through the private reader after factual cleanup', async () => {
  const controller = new AbortController();
  const { input } = fixture({ signal: controller.signal });
  input.chromeAdapter.runPipeline = createObservedPipelineRunner({
    checkpointRecorder: {
      async started() { controller.abort(new DOMException('PRIVATE_CHECKPOINT_ABORT', 'AbortError')); },
      async record() {},
      snapshot() { return checkpoint(); },
    },
    services: {
      async collectObservedPage() { throw new Error('must-not-collect'); },
      async runCoreRules() { throw new Error('must-not-run'); },
      async buildAuditModel() { throw new Error('must-not-build'); },
      async persistAuditModel() { throw new Error('must-not-persist'); },
    },
  });

  let interruption = null;
  await assert.rejects(runObservedTabAudit(input), error => {
    assert.match(String(error), /OBSERVED_RUNNER_DENIED/u);
    interruption = readObservedAuditInterruption(error);
    assert.equal(readObservedAuditInterruption(error), interruption);
    assert.equal(readObservedAuditInterruption(new TypeError('OBSERVED_RUNNER_DENIED')), null);
    return true;
  });
  assert.deepEqual(Reflect.ownKeys(interruption), [
    'version', 'auditId', 'observationState', 'observedTarget', 'ownershipState', 'reason',
  ]);
  assert.equal(interruption.version, 1);
  assert.equal(interruption.auditId, 'audit-1');
  assert.equal(interruption.observationState, 'observed');
  assert.equal(interruption.ownershipState, 'attached');
  assert.equal(interruption.reason, 'cancelled');
  assert.equal(interruption.observedTarget.version, 'ObservedTargetV1');
  assert.equal(Object.isFrozen(interruption), true);
  assert.doesNotMatch(JSON.stringify(interruption), /PRIVATE_CHECKPOINT_ABORT/u);
});

test('final proof failure takes precedence over a simultaneous cancellation in private interruption metadata', async t => {
  for (const scenario of [
    { name: 'target-changed', expectedReason: 'failed' },
    { name: 'proof-unavailable', expectedReason: 'failed' },
    { name: 'valid-proof', expectedReason: 'cancelled' },
  ]) await t.test(scenario.name, async () => {
    const controller = new AbortController();
    let proofCount = 0;
    const { input } = fixture({ signal: controller.signal, adapter: {
      async probeDocumentIdentity(tabId) {
        proofCount += 1;
        if (proofCount === 2) {
          controller.abort(new DOMException('PRIVATE_FINAL_PROOF_ABORT', 'AbortError'));
          if (scenario.name === 'proof-unavailable') throw new Error('PRIVATE_FINAL_PROOF_UNAVAILABLE');
          if (scenario.name === 'target-changed') {
            return { tabId, windowId: 3, documentId: 'doc-changed', urlSessionDigest: `hmac-sha256:${'B'.repeat(43)}` };
          }
        }
        return { tabId, windowId: 3, documentId: 'doc-1', urlSessionDigest: DIGEST };
      },
    } });

    let interruption = null;
    await assert.rejects(runObservedTabAudit(input), error => {
      interruption = readObservedAuditInterruption(error);
      assert.match(String(error), /OBSERVED_RUNNER_DENIED/u);
      return true;
    });
    assert.equal(proofCount, 2);
    assert.equal(interruption?.reason, scenario.expectedReason);
    assert.equal(interruption?.ownershipState, 'attached');
    assert.doesNotMatch(JSON.stringify(interruption), /PRIVATE_FINAL_PROOF/u);
  });
});

test('accepts a canonical observed model only when its wrapper status matches', async () => {
  const { input } = fixture({ modelStatus: 'partial' });
  const result = await runObservedTabAudit(input);
  assert.equal(result.status, 'partial');
  assert.equal(result.observationState, 'observed');
  assert.equal(result.model.session.status, 'partial');
});

test('copies the validated CapturePolicy before the first await and prevents no-pixels TOCTOU', async () => {
  const policy = { ...POLICY };
  let received;
  const { input } = fixture({ policy, pipelineServices: {
    async collectObservedPage({ capturePolicy }) { received = capturePolicy; return { snapshot: { title: 'safe' } }; },
  }, adapter: {
    async probeDocumentIdentity() {
      policy.mode = 'full-evidence'; policy.captureElements = true;
      return { tabId: 7, windowId: 3, documentId: 'doc-1', urlSessionDigest: DIGEST };
    },
  } });
  const result = await runObservedTabAudit(input);
  assert.equal(result.status, 'partial');
  assert.equal(received.mode, 'no-pixels');
  assert.equal(Object.isFrozen(received), true);
});

test('navigation failure before observation returns failed with null model and target', async () => {
  const { input, calls } = fixture({ adapter: {
    async probeDocumentIdentity() { calls.push('unexpected-probe'); throw new Error('PRIVATE_PROBE'); },
    async navigateTab() { calls.push('navigate'); throw new Error('PRIVATE_NAV'); },
    async createTab() { calls.push('create'); return { id: 41, windowId: 3, active: true, status: 'loading' }; },
    async resolveNavigationToken() { return 'https://example.test/a'; }, async waitForStable() { calls.push('stable'); },
    async getEvidenceUrl() { return EVIDENCE; }, async removeTab() {},
  }, target: { kind: 'owned-disposable', ownershipId: 'ownership-1', navigationToken: NAV_TOKEN, cleanupMode: 'always', pageId: 'page-1' }});
  let state = 'created';
  input.chromeAdapter.ownedTabs = {
    async registerCreated() { state = 'created'; return ownedRecord({ state }); }, async get() { return ownedRecord({ state }); },
    async transition({ toState }) { state = toState; return ownedRecord({ state }); },
    async removeOwned() { calls.push('remove'); state = 'removed'; return ownedRecord({ state }); },
    async markCleanupPending() { state = 'cleanup-pending'; return ownedRecord({ state }); },
  };
  const result = await runObservedTabAudit(input);
  assert.equal(result.status, 'failed');
  assert.equal(result.model, null);
  assert.equal(result.observedTarget, null);
  assert.equal(result.observationState, 'pre-observation-failure');
  assert.equal(['removed', 'cleanup-pending'].includes(result.ownershipState), true);
});

test('owned disposable observed target carries ownership V2 and cleanup mode', async () => {
  const calls = [];
  const { input } = fixture({ target: {
    kind: 'owned-disposable', ownershipId: 'ownership-1', navigationToken: NAV_TOKEN, cleanupMode: 'always', pageId: 'page-1',
  }, adapter: {
    async probeDocumentIdentity() { calls.push('probe'); return { tabId: 41, windowId: 3, documentId: 'doc-1', urlSessionDigest: DIGEST }; },
    async createTab() { calls.push('create'); return { id: 41, windowId: 3, active: true, status: 'loading' }; },
    async resolveNavigationToken() { return 'https://example.test/a'; },
    async navigateTab() { calls.push('navigate'); }, async waitForStable() { calls.push('stable'); },
    async getEvidenceUrl() { return EVIDENCE; },
    async removeTab() { calls.push('remove'); },
    ownedTabs: (() => { let state = 'created'; return {
      async registerCreated() { state = 'created'; return ownedRecord({ state }); }, async get() { return ownedRecord({ state }); },
      async transition({ toState }) { state = toState; return ownedRecord({ state }); },
      async removeOwned() { calls.push('remove'); state = 'removed'; return ownedRecord({ state }); },
      async markCleanupPending() { state = 'cleanup-pending'; return ownedRecord({ state }); },
    }; })(),
  }});
  const result = await runObservedTabAudit(input);
  assert.equal(result.status, 'partial');
  assert.equal(result.observedTarget.version, 'ObservedTargetV1');
  assert.equal(result.observedTarget.kind, 'owned-disposable');
  assert.equal(result.observedTarget.ownershipId, 'ownership-1');
  assert.equal(result.observedTarget.cleanupMode, 'always');
  assert.equal(result.observedTarget.pageId, 'page-1');
  assert.deepEqual(calls, ['create', 'navigate', 'stable', 'probe', 'probe', 'remove']);
});

test('completes an owned target with null pageId when model URL evidence matches', async () => {
  let state = 'created';
  const { input } = fixture({ target: {
    kind: 'owned-disposable', ownershipId: 'ownership-1', navigationToken: NAV_TOKEN, cleanupMode: 'always', pageId: null,
  }, adapter: {
    async probeDocumentIdentity() { return { tabId: 41, windowId: 3, documentId: 'doc-1', urlSessionDigest: DIGEST }; },
    async createTab() { return { id: 41, windowId: 3 }; }, async resolveNavigationToken() { return 'https://example.test/a'; },
    async navigateTab() {}, async waitForStable() {}, async getEvidenceUrl() { return EVIDENCE; }, async removeTab() {},
    ownedTabs: {
      async registerCreated() { return ownedRecord({ state: 'created' }); }, async get() { return ownedRecord({ state }); },
      async transition({ toState }) { state = toState; return ownedRecord({ state }); },
      async removeOwned() { state = 'removed'; return ownedRecord({ state }); },
      async markCleanupPending() { state = 'cleanup-pending'; return ownedRecord({ state }); },
    },
  } });
  const result = await runObservedTabAudit(input);
  assert.equal(result.status, 'partial');
  assert.equal(result.observedTarget.pageId, null);
});

test('rejects dynamic owned evidence carrying query data before forming observedTarget', async () => {
  const { input } = fixture({ target: { kind: 'owned-disposable', ownershipId: 'ownership-1', navigationToken: NAV_TOKEN, cleanupMode: 'always', pageId: 'page-1' }, adapter: {
    async createTab() { return { id: 41, windowId: 3, active: true }; }, async resolveNavigationToken() { return 'https://example.test/a'; },
    async navigateTab() {}, async waitForStable() {}, async getEvidenceUrl() { return QUERY_EVIDENCE; }, async removeTab() {},
    async probeDocumentIdentity() { return { tabId: 41, windowId: 3, documentId: 'doc-1', urlSessionDigest: DIGEST }; },
    ownedTabs: (() => { let state = 'created'; return { async registerCreated() { state = 'created'; return ownedRecord({ state }); }, async get() { return ownedRecord({ state }); }, async transition({ toState }) { state = toState; return ownedRecord({ state }); }, async removeOwned() { state = 'removed'; return ownedRecord({ state }); }, async markCleanupPending() { state = 'cleanup-pending'; return ownedRecord({ state }); } }; })(),
  } });
  const outcome = await runObservedTabAudit(input);
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.observedTarget, null);
});

test('validates the complete owned adapter and registry bundle before createTab', async () => {
  let created = 0;
  const { input } = fixture({ target: { kind: 'owned-disposable', ownershipId: 'ownership-1', navigationToken: NAV_TOKEN, cleanupMode: 'always', pageId: 'page-1' }, adapter: {
    async createTab() { created += 1; return { id: 41, windowId: 3 }; },
    ownedTabs: { async registerCreated() {}, async transition() {}, async removeOwned() {}, async markCleanupPending() {} },
  } });
  await assert.rejects(() => runObservedTabAudit(input), /OBSERVED_RUNNER_DENIED/u);
  assert.equal(created, 0);
});

test('rejects navigation tokens outside the exact 22-character base64url contract', async () => {
  for (const navigationToken of ['token_123', 'A'.repeat(21), 'A'.repeat(23), `A${'!'.repeat(21)}`]) {
    const { input, calls } = fixture({ target: { kind: 'owned-disposable', ownershipId: 'ownership-1', navigationToken, cleanupMode: 'always', pageId: 'page-1' } });
    await assert.rejects(() => runObservedTabAudit(input), /OBSERVED_RUNNER_DENIED/u);
    assert.deepEqual(calls, []);
  }
});

test('rejects an accessor Tab.id without probing and removes a resolved native Tab exactly once', async () => {
  let idReads = 0;
  const { input } = fixture({ target: { kind: 'owned-disposable', ownershipId: 'ownership-1', navigationToken: NAV_TOKEN, cleanupMode: 'always', pageId: 'page-1' }, adapter: {
    async createTab() { const tab = { windowId: 3, active: true }; Object.defineProperty(tab, 'id', { enumerable: true, get() { idReads += 1; return 41; } }); return tab; },
    async navigateTab() {}, async waitForStable() {}, async resolveNavigationToken() { return 'https://example.test/a'; }, async getEvidenceUrl() { return EVIDENCE; },
    async probeDocumentIdentity() { throw new Error('must-not-probe'); }, async removeTab() { throw new Error('must-not-direct-remove'); },
    ownedTabs: { async registerCreated() { return ownedRecord(); }, async get() { return null; }, async transition() { return ownedRecord({ state: 'observing' }); }, async removeOwned() { return ownedRecord({ state: 'removed' }); }, async markCleanupPending() { return ownedRecord({ state: 'cleanup-pending' }); } },
  } });
  const outcome = await runObservedTabAudit(input);
  assert.equal(outcome.status, 'failed');
  assert.equal(idReads, 0);
});

test('cleans the exact tab when createTab resolves and abort is observed before navigation', async () => {
  const controller = new AbortController();
  const calls = [];
  const { input } = fixture({ signal: controller.signal, target: { kind: 'owned-disposable', ownershipId: 'ownership-1', navigationToken: NAV_TOKEN, cleanupMode: 'always', pageId: 'page-1' }, adapter: {
    async createTab() { controller.abort(); return { id: 41, windowId: 3, active: true }; },
    async navigateTab() { calls.push('navigate'); }, async waitForStable() {}, async resolveNavigationToken() { return 'https://example.test/a'; }, async getEvidenceUrl() { return EVIDENCE; },
    async probeDocumentIdentity() { calls.push('probe'); throw new Error('must-not-probe'); },
    async removeTab(tabId) { calls.push(['direct-remove', tabId]); },
    ownedTabs: { async registerCreated() { throw new Error('must-not-register'); }, async get() { return null; }, async transition() {}, async removeOwned() {}, async markCleanupPending() {} },
  } });
  const outcome = await runObservedTabAudit(input);
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.ownershipState, 'removed');
  assert.deepEqual(calls, [['direct-remove', 41]]);
});

test('returns pre-observation failure without a null-tab cleanup when abort wins before create', async () => {
  const controller = new AbortController();
  controller.abort();
  let creates = 0;
  const { input } = fixture({ signal: controller.signal, target: { kind: 'owned-disposable', ownershipId: 'ownership-1', navigationToken: NAV_TOKEN, cleanupMode: 'always', pageId: 'page-1' }, adapter: {
    async createTab() { creates += 1; return { id: 41, windowId: 3 }; }, async resolveNavigationToken() { return 'https://example.test/a'; },
    async navigateTab() {}, async waitForStable() {}, async getEvidenceUrl() { return EVIDENCE; }, async removeTab() { throw new Error('must-not-remove-null-tab'); },
    ownedTabs: { async registerCreated() { throw new Error('must-not-register'); }, async get() { return null; }, async transition() {}, async removeOwned() {}, async markCleanupPending() {} },
  } });
  const outcome = await runObservedTabAudit(input);
  assert.equal(creates, 0);
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.model, null);
  assert.equal(outcome.observedTarget, null);
  assert.equal(outcome.ownershipState, 'removed');
});

test('fences a late abort after pipeline and does not invoke checkpoint after cancellation', async () => {
  const controller = new AbortController();
  const { input, calls } = fixture({ signal: controller.signal, pipelineServices: {
    async persistAuditModel() { controller.abort(); },
  } });
  const result = await runObservedTabAudit(input);
  assert.equal(result.status, 'partial');
  assert.notEqual(result.model, null);
  assert.equal(result.observedTarget !== null, true);
  assert.equal(calls.some(call => call[0] === 'checkpoint'), false);
});

test('rejects result envelopes with accessor or extra fields without reading the accessor', async () => {
  let getterReads = 0;
  const { input } = fixture({ adapter: {
    async runPipeline() {
      const result = { model: model(), status: 'partial', checkpoint: checkpoint(), observationState: 'observed' };
      Object.defineProperty(result, 'extra', { enumerable: true, get() { getterReads += 1; return 'secret'; } });
      return result;
    },
  } });
  await assert.rejects(() => runObservedTabAudit(input), /OBSERVED_RUNNER_DENIED/u);
  assert.equal(getterReads, 0);
});

test('rejects an arbitrary runPipeline before probing or persistence', async () => {
  let probed = 0;
  let persisted = 0;
  const { input } = fixture({ adapter: {
    async probeDocumentIdentity() { probed += 1; return { tabId: 7, windowId: 3, documentId: 'doc-1', urlSessionDigest: DIGEST }; },
    async runPipeline() { persisted += 1; return {}; },
  } });
  await assert.rejects(() => runObservedTabAudit(input), /OBSERVED_RUNNER_DENIED/u);
  assert.equal(probed, 0);
  assert.equal(persisted, 0);
});

test('rejects query-bearing durable model URLs without exposing secrets', async () => {
  let persisted = 0;
  const secretUrl = 'https://example.test/a?q=Bearer-super-secret-value';
  const secretModel = structuredClone(SAMPLE_AUDIT);
  secretModel.auditId = 'audit-1';
  secretModel.requestedUrl = secretUrl;
  secretModel.pages[0].requestedUrl = secretUrl;
  secretModel.finalUrl = EVIDENCE.href;
  secretModel.pages[0].finalUrl = EVIDENCE.href;
  const { input } = fixture({ pipelineServices: {
    async buildAuditModel() { return secretModel; },
    async persistAuditModel() { persisted += 1; },
  } });
  await assert.rejects(() => runObservedTabAudit(input), error => !String(error).includes('Bearer-super-secret-value'));
  assert.equal(persisted, 0);
});

test('rejects a terminal model for another audit before exposing the result', async () => {
  const { input } = fixture({ adapter: {
    async runPipeline() { return { model: { auditId: 'other-audit', session: { status: 'complete' } }, checkpoint: { version: 1 }, observationState: 'observed' }; },
  } });
  await assert.rejects(() => runObservedTabAudit(input), /OBSERVED_RUNNER_DENIED/u);
});

test('requires exact V2 journal records and removes a freshly-created tab when registration threw before commit', async () => {
  const calls = [];
  const { input } = fixture({ target: { kind: 'owned-disposable', ownershipId: 'ownership-1', navigationToken: NAV_TOKEN, cleanupMode: 'always', pageId: 'page-1' }, adapter: {
    async createTab() { calls.push('create'); return { id: 41, windowId: 3 }; },
    async navigateTab() { calls.push('navigate'); }, async waitForStable() { calls.push('stable'); },
    async resolveNavigationToken() { return 'https://example.test/a'; }, async getEvidenceUrl() { return EVIDENCE; },
    async probeDocumentIdentity() { calls.push('probe'); return { tabId: 41, windowId: 3, documentId: 'doc-1', urlSessionDigest: DIGEST }; },
    async removeTab(tabId) { calls.push(['direct-remove', tabId]); },
    ownedTabs: {
      async registerCreated() { throw new Error('before-commit'); }, async get() { return null; },
      async transition() { return ownedRecord({ state: 'observing' }); },
      async removeOwned() { throw new Error('must-not-journal-remove'); },
      async markCleanupPending() { throw new Error('must-not-pending'); },
    },
  } });
  const result = await runObservedTabAudit(input);
  assert.equal(result.status, 'failed');
  assert.equal(result.model, null);
  assert.equal(result.ownershipState, 'removed');
  assert.deepEqual(calls, ['create', ['direct-remove', 41]]);
});

test('treats commit-then-throw as journal-owned and cleans through removeOwned', async () => {
  const calls = [];
  let state = 'created';
  const { input } = fixture({ target: { kind: 'owned-disposable', ownershipId: 'ownership-1', navigationToken: NAV_TOKEN, cleanupMode: 'always', pageId: 'page-1' }, adapter: {
    async createTab() { calls.push('create'); return { id: 41, windowId: 3 }; },
    async navigateTab() { calls.push('navigate'); throw new Error('must-not-navigate'); }, async waitForStable() {},
    async resolveNavigationToken() { return 'https://example.test/a'; }, async getEvidenceUrl() { return EVIDENCE; },
    async probeDocumentIdentity() { throw new Error('must-not-probe'); }, async removeTab() { calls.push('direct-remove'); },
    ownedTabs: {
      async registerCreated() { throw new Error('commit-then-throw'); }, async get() { return ownedRecord({ state }); },
      async transition() { return ownedRecord({ state: 'observing' }); },
      async removeOwned() { calls.push('journal-remove'); state = 'removed'; return ownedRecord({ state }); },
      async markCleanupPending() { state = 'cleanup-pending'; return ownedRecord({ state }); },
    },
  } });
  const result = await runObservedTabAudit(input);
  assert.equal(result.status, 'failed');
  assert.equal(result.ownershipState, 'removed');
  assert.deepEqual(calls, ['create', 'journal-remove']);
});

test('rejects a no-op ownership journal instead of reporting a false removal', async () => {
  let state = 'created';
  const { input } = fixture({ target: { kind: 'owned-disposable', ownershipId: 'ownership-1', navigationToken: NAV_TOKEN, cleanupMode: 'always', pageId: 'page-1' }, adapter: {
    async createTab() { return { id: 41, windowId: 3 }; }, async resolveNavigationToken() { return 'https://example.test/a'; },
    async navigateTab() {}, async waitForStable() {}, async getEvidenceUrl() { return EVIDENCE; },
    async probeDocumentIdentity() { return { tabId: 41, windowId: 3, documentId: 'doc-1', urlSessionDigest: DIGEST }; },
    async removeTab() { throw new Error('must-not-remove-unjournaled'); },
    ownedTabs: {
      async registerCreated() { return ownedRecord({ state: 'created' }); }, async get() { return ownedRecord({ state }); },
      async transition() { state = 'observing'; return ownedRecord({ state }); },
      async removeOwned() { return ownedRecord({ state: 'removed' }); },
      async markCleanupPending() { return ownedRecord({ state: 'cleanup-pending' }); },
    },
  } });
  await assert.rejects(() => runObservedTabAudit(input), /OBSERVED_RUNNER_DENIED|CLEANUP_UNCONFIRMED/u);
});

test('rejects an ownership cleanup-mode flip before navigation/pipeline', async () => {
  let state = 'created';
  let pipelines = 0;
  const { input } = fixture({ pipelineServices: { async collectObservedPage() { pipelines += 1; return { snapshot: { title: 'safe' } }; } }, target: { kind: 'owned-disposable', ownershipId: 'ownership-1', navigationToken: NAV_TOKEN, cleanupMode: 'always', pageId: 'page-1' }, adapter: {
    async createTab() { return { id: 41, windowId: 3 }; }, async resolveNavigationToken() { return 'https://example.test/a'; },
    async navigateTab() {}, async waitForStable() {}, async getEvidenceUrl() { return EVIDENCE; }, async removeTab() {},
    ownedTabs: {
      async registerCreated() { return ownedRecord({ state: 'created' }); }, async get() { return ownedRecord({ state }); },
      async transition() { return { ...ownedRecord({ state: 'observing' }), cleanupMode: 'pre-observation-failure' }; },
      async removeOwned() { state = 'removed'; return ownedRecord({ state }); },
      async markCleanupPending() { state = 'cleanup-pending'; return ownedRecord({ state }); },
    },
  } });
  const outcome = await runObservedTabAudit(input);
  assert.equal(outcome.observationState, 'pre-observation-failure');
  assert.equal(pipelines, 0);
});

test('uses the preflight-captured removeTab despite persistence mutating adapter and owner methods', async () => {
  let adapterRef;
  let ownerRef;
  let present = true;
  let originalRemoves = 0;
  let state = 'created';
  const { input } = fixture({ pipelineServices: {
    async persistAuditModel() {
      adapterRef.removeTab = async () => { throw new Error('mutated-remove'); };
      ownerRef.removeOwned = async () => null;
      present = false;
    },
  }, target: { kind: 'owned-disposable', ownershipId: 'ownership-1', navigationToken: NAV_TOKEN, cleanupMode: 'always', pageId: 'page-1' }, adapter: {
    async createTab() { return { id: 41, windowId: 3 }; }, async resolveNavigationToken() { return 'https://example.test/a'; },
    async navigateTab() {}, async waitForStable() {}, async getEvidenceUrl() { return EVIDENCE; },
    async probeDocumentIdentity() { return { tabId: 41, windowId: 3, documentId: 'doc-1', urlSessionDigest: DIGEST }; },
    async removeTab() { originalRemoves += 1; },
    ownedTabs: {
      async registerCreated() { return ownedRecord({ state: 'created' }); },
      async get() { return present ? ownedRecord({ state }) : null; },
      async transition({ toState }) { state = toState; return ownedRecord({ state }); },
      async removeOwned() { state = 'removed'; return {}; },
      async markCleanupPending() { state = 'cleanup-pending'; return ownedRecord({ state }); },
    },
  } });
  adapterRef = input.chromeAdapter;
  ownerRef = input.chromeAdapter.ownedTabs;
  const outcome = await runObservedTabAudit(input);
  assert.equal(outcome.status, 'partial');
  assert.equal(outcome.ownershipState, 'removed');
  assert.equal(originalRemoves, 1);
});
