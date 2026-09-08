import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import test from 'node:test';

import { AXE_PROVENANCE } from '../../src/browser/axe-adapter.js';
import {
  canonicalTime,
  createOwnershipId,
  runAttachedAuditExecution,
  runAudit,
  runAuditExecution,
  runUrlAudit,
} from '../../src/background/run-audit.js';
import { AUDIT_EXECUTION_INTERNAL } from '../../src/background/chrome-adapter.js';
import { createCapturePolicyV1 } from '../../src/core/privacy/capture-policy.js';
import { sanitizeEvidenceUrlV1 } from '../../src/core/privacy/evidence-url.js';
import { enrichAuditForReport } from '../../src/core/report/enrich-audit.js';
import { createAuditModel } from '../../src/core/report/audit-model.js';
import { createInstalledCoreRuleInventory } from '../../src/core/rules/core-rule-inventory.js';
import { remapAuditPage } from '../../src/core/batch/remap-audit.js';
import { renderTechnicalJson } from '../../src/core/report/earl-json.js';
import { renderHtmlReport } from '../../src/core/report/html.js';
import { createAnnotationMapFixture } from '../report/annotation-map-fixture.js';
import { captureElement as captureElementEvidence, captureFullPage as captureFullPageEvidence } from '../../src/browser/capture-evidence.js';
import { createPixelPrivacyGateV1 } from '../../src/background/pixel-privacy-gate.js';
import { createScriptedPixelCommitClockV1 } from '../../src/background/pixel-commit-clock.js';
import { runObservedTabAudit } from '../../src/background/observed-tab-runner.js';
import { createRawNavigationVaultV1 } from '../../src/background/raw-navigation-vault.js';
import { createSessionUrlDigestManager } from '../../src/core/privacy/session-url-digest.js';
import { ATTACHED_COPY_RELOADED_MESSAGE } from '../../src/core/report/diagnostic-policy.js';
import { createPanelResultBundleV1 } from '../../src/panel/panel-result-bundle.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const TEST_EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';
const TEST_DIGEST = `hmac-sha256:${'A'.repeat(43)}`;
const TEST_EVIDENCE_URL = sanitizeEvidenceUrlV1('https://example.test/final?secret=REMOVE', { includeQuery: false });
const EMPTY_SIGNALS = Object.freeze({ version: 'SensitiveCaptureSignalsV1', detected: false, categories: Object.freeze([]) });
const PASSWORD_SIGNALS = Object.freeze({ version: 'SensitiveCaptureSignalsV1', detected: true, categories: Object.freeze(['password']) });
const PASSWORD_PAYMENT_SIGNALS = Object.freeze({
  version: 'SensitiveCaptureSignalsV1',
  detected: true,
  categories: Object.freeze(['password', 'payment']),
});

function attachedPixelGate(policy, calls, {
  auditId = 'audit-attached-pixels', consentId = null, runnerStatus = 'ready', beforeGateResult = null,
  commitClock = createScriptedPixelCommitClockV1({ epochs: Array(8).fill(1_788_000_000_010) }),
  suspensionUpdatedAt = 1_788_000_000_010,
} = {}) {
  const suspension = ({ state, resumePhase, token, categories }) => ({
    version: 'AuditSuspensionV1', revision: 1, auditId, consentId: token,
    tabId: 42, windowId: 9, documentId: 'document-a', urlEvidence: TEST_EVIDENCE_URL,
    urlSessionDigest: TEST_DIGEST, mode: policy.mode, capturePolicy: policy, categories,
    issuedAt: 1_788_000_000_000, updatedAt: suspensionUpdatedAt, expiresAt: 1_788_000_600_000,
    cleanupAttempts: 0, cleanupNotBefore: null, state, resumePhase, revokeReason: null, source: { kind: 'attached' },
  });
  return createPixelPrivacyGateV1({
    pixelState: {
      async pause(value) { calls.push('pause'); return suspension({ state: 'paused', resumePhase: null, token: 'B'.repeat(21) + 'Q', categories: value.categories }); },
      async gateRunnerStart(value) {
        calls.push('gate');
        await beforeGateResult?.();
        return runnerStatus === 'ready'
          ? { version: 'PixelRunnerGateResultV1', status: 'ready', suspension: suspension({ state: 'resuming', resumePhase: 'runner-started', token: consentId, categories: value.categories }) }
          : { version: 'PixelRunnerGateResultV1', status: 'repaused', suspension: suspension({ state: 'paused', resumePhase: null, token: 'C'.repeat(21) + 'Q', categories: value.categories }) };
      },
    },
    consentId, authorityExpiresAt: 1_900_000_000_000, commitClock,
    async afterPixels() { calls.push('after'); },
  });
}

function ownedPixelGate(policy, calls, {
  auditId, ownershipId, consentId = null, runnerStatus = 'ready',
  urlEvidence = TEST_EVIDENCE_URL,
  cleanupMode = 'pre-observation-failure',
  commitClock = createScriptedPixelCommitClockV1({ epochs: Array(8).fill(1_788_000_000_010) }),
} = {}) {
  const source = Object.freeze({
    kind: 'owned-disposable', ownershipId,
    cleanupMode, pageId: 'page-1',
  });
  const suspension = ({ state, resumePhase, token, categories }) => ({
    version: 'AuditSuspensionV1', revision: 1, auditId, consentId: token,
    tabId: 42, windowId: 9, documentId: 'document-a', urlEvidence,
    urlSessionDigest: TEST_DIGEST, mode: policy.mode, capturePolicy: policy, categories,
    issuedAt: 1_788_000_000_000, updatedAt: 1_788_000_000_010, expiresAt: 1_788_000_600_000,
    cleanupAttempts: 0, cleanupNotBefore: null, state, resumePhase, revokeReason: null, source,
  });
  return createPixelPrivacyGateV1({
    pixelState: {
      async pause(value) {
        calls.push('pause');
        return suspension({ state: 'paused', resumePhase: null, token: 'B'.repeat(21) + 'Q', categories: value.categories });
      },
      async gateRunnerStart(value) {
        calls.push('gate');
        return runnerStatus === 'ready'
          ? { version: 'PixelRunnerGateResultV1', status: 'ready', suspension: suspension({ state: 'resuming', resumePhase: 'runner-started', token: consentId, categories: value.categories }) }
          : { version: 'PixelRunnerGateResultV1', status: 'repaused', suspension: suspension({ state: 'paused', resumePhase: null, token: 'C'.repeat(21) + 'Q', categories: value.categories }) };
      },
    },
    consentId, authorityExpiresAt: 1_900_000_000_000, commitClock,
    async afterPixels() { calls.push('after'); },
  });
}

function unreadEvidenceProxy(evidence, onRead) {
  return new Proxy({ ...evidence }, {
    get(target, key, receiver) {
      onRead(key);
      return Reflect.get(target, key, receiver);
    },
  });
}

test('exports the single canonical audit timestamp normalizer used by observed runners', () => {
  assert.equal(canonicalTime('2026-08-29T10:00:00-04:00'), '2026-08-29T14:00:00.000Z');
  assert.throws(() => canonicalTime('not-a-time'), /relógio/u);
});

test('single URL resolves its one-use vault token only inside the observed runner adapter', async () => {
  const calls = [];
  const checkpointStore = Object.freeze({
    async writeSanitized(auditId, checkpoint) { calls.push(['checkpoint', auditId, checkpoint]); },
  });
  const rawNavigationVault = Object.freeze({
    async take(token, options) {
      calls.push(['take', token, options]);
      return 'https://example.test/final?token=REMOVE';
    },
  });
  const capturePolicy = createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false });
  const result = await runUrlAudit({
    auditId: 'audit-url-1', ownershipId: `owner_${'A'.repeat(22)}`, navigationToken: 'N'.repeat(22),
    windowId: 9,
    navigationPurpose: 'single-url', evidenceUrl: TEST_EVIDENCE_URL, sessionDigest: TEST_DIGEST,
    rawNavigationVault, chromeAdapter: Object.freeze({ marker: 'adapter' }), capturePolicy,
    checkpointStore, onProgress() {}, now: () => '2026-09-01T12:00:00.000Z', signal: undefined,
    expectedExtensionId: TEST_EXTENSION_ID,
    async auditRunner(input) {
      calls.push(['runner', input.target]);
      assert.deepEqual(input.target, {
        kind: 'owned-disposable', ownershipId: `owner_${'A'.repeat(22)}`,
        navigationToken: 'N'.repeat(22), cleanupMode: 'pre-observation-failure', pageId: 'page-1',
      });
      assert.equal(await input.chromeAdapter.resolveNavigationToken('N'.repeat(22)),
        'https://example.test/final?token=REMOVE');
      await input.onCheckpoint(Object.freeze({ safe: true }));
      return Object.freeze({
        status: 'complete', model: Object.freeze({ auditId: 'audit-url-1' }),
        observedTarget: Object.freeze({ kind: 'owned-disposable' }),
        observationState: 'observed', ownershipState: 'retained-for-review',
      });
    },
  });
  assert.equal(result.status, 'complete');
  assert.deepEqual(calls.map(entry => entry[0]), ['runner', 'take', 'checkpoint']);
  assert.deepEqual(calls[1], ['take', 'N'.repeat(22), {
    auditId: 'audit-url-1', purpose: 'single-url',
    expectedEvidenceUrl: TEST_EVIDENCE_URL, expectedSessionDigest: TEST_DIGEST,
  }]);
});

test('attached-copy resolves only its scoped vault token and forces cleanup always', async () => {
  const calls = [];
  const result = await runUrlAudit({
    auditId: 'audit-attached-copy-runner',
    ownershipId: `owner_${'C'.repeat(22)}`,
    navigationToken: 'C'.repeat(22),
    windowId: 9,
    navigationPurpose: 'attached-copy',
    evidenceUrl: TEST_EVIDENCE_URL,
    sessionDigest: TEST_DIGEST,
    rawNavigationVault: Object.freeze({
      async take(token, options) {
        calls.push(['take', token, options]);
        return 'https://example.test/final?private=REMOVE';
      },
    }),
    chromeAdapter: Object.freeze({ marker: 'adapter' }),
    capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    checkpointStore: Object.freeze({ async writeSanitized() {} }),
    onProgress() {},
    now: () => '2026-09-01T12:00:00.000Z',
    signal: undefined,
    expectedExtensionId: TEST_EXTENSION_ID,
    async auditRunner(input) {
      assert.deepEqual(input.target, {
        kind: 'owned-disposable',
        ownershipId: `owner_${'C'.repeat(22)}`,
        navigationToken: 'C'.repeat(22),
        cleanupMode: 'always',
        pageId: 'page-1',
      });
      assert.equal(await input.chromeAdapter.resolveNavigationToken('C'.repeat(22)),
        'https://example.test/final?private=REMOVE');
      return Object.freeze({
        status: 'complete', model: Object.freeze({ auditId: 'audit-attached-copy-runner' }),
        observedTarget: Object.freeze({ kind: 'owned-disposable' }),
        observationState: 'observed', ownershipState: 'removed',
      });
    },
  });

  assert.equal(result.ownershipState, 'removed');
  assert.deepEqual(calls, [['take', 'C'.repeat(22), {
    auditId: 'audit-attached-copy-runner',
    purpose: 'attached-copy',
    expectedEvidenceUrl: TEST_EVIDENCE_URL,
    expectedSessionDigest: TEST_DIGEST,
  }]]);
});

test('batch page resolves only its scoped vault token in no-pixels mode and always removes the owned tab', async () => {
  const calls = [];
  const result = await runUrlAudit({
    auditId: 'audit-batch-page-runner',
    ownershipId: `owner_${'B'.repeat(22)}`,
    navigationToken: 'B'.repeat(22),
    windowId: 9,
    navigationPurpose: 'batch-page',
    evidenceUrl: TEST_EVIDENCE_URL,
    sessionDigest: TEST_DIGEST,
    rawNavigationVault: Object.freeze({
      async take(token, options) {
        calls.push(['take', token, options]);
        return 'https://example.test/final?private=REMOVE';
      },
    }),
    chromeAdapter: Object.freeze({ marker: 'adapter' }),
    capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    checkpointStore: Object.freeze({ async writeSanitized() {} }),
    onProgress() {},
    now: () => '2026-09-01T12:00:00.000Z',
    signal: undefined,
    expectedExtensionId: TEST_EXTENSION_ID,
    async auditRunner(input) {
      assert.deepEqual(input.target, {
        kind: 'owned-disposable',
        ownershipId: `owner_${'B'.repeat(22)}`,
        navigationToken: 'B'.repeat(22),
        cleanupMode: 'always',
        pageId: 'page-1',
      });
      assert.equal(await input.chromeAdapter.resolveNavigationToken('B'.repeat(22)),
        'https://example.test/final?private=REMOVE');
      return Object.freeze({
        status: 'complete', model: Object.freeze({ auditId: 'audit-batch-page-runner' }),
        observedTarget: Object.freeze({ kind: 'owned-disposable' }),
        observationState: 'observed', ownershipState: 'removed',
      });
    },
  });

  assert.equal(result.ownershipState, 'removed');
  assert.deepEqual(calls, [['take', 'B'.repeat(22), {
    auditId: 'audit-batch-page-runner',
    purpose: 'batch-page',
    expectedEvidenceUrl: TEST_EVIDENCE_URL,
    expectedSessionDigest: TEST_DIGEST,
  }]]);
});

test('batch page sensitive preflight retains its inactive owner for consent with zero raster', async () => {
  const auditId = 'audit-batch-page-sensitive';
  const ownershipId = `owner_${'B'.repeat(22)}`;
  const checkpoints = [];
  const adapter = fakeAdapter({
    canonicalInternals: true, sessionValues: {}, trackCaptureCalls: true,
    sensitiveSignals: PASSWORD_SIGNALS,
  });
  const policy = createCapturePolicyV1({ mode: 'full-evidence', includeQuery: false });

  const result = await runUrlAudit({
    auditId, ownershipId, windowId: 9,
    navigationToken: 'B'.repeat(22), navigationPurpose: 'batch-page',
    evidenceUrl: TEST_EVIDENCE_URL, sessionDigest: TEST_DIGEST,
    rawNavigationVault: Object.freeze({ async take() { return 'https://example.test/final?private=REMOVE'; } }),
    chromeAdapter: adapter, capturePolicy: policy,
    privacyGate: ownedPixelGate(policy, [], { auditId, ownershipId, cleanupMode: 'always' }),
    checkpointStore: Object.freeze({
      async writeSanitized(_auditId, checkpoint) { checkpoints.push(checkpoint); },
    }),
    onProgress() {}, now: () => '2026-09-01T12:00:00.000Z', signal: undefined,
    expectedExtensionId: TEST_EXTENSION_ID, auditRunner: runObservedTabAudit,
  });

  assert.equal(result.status, 'privacy-paused');
  assert.equal(result.ownershipState, 'retained-for-consent');
  assert.equal(adapter.counts.screenshots, 0);
  assert.equal(checkpoints.length > 0, true);
});

test('batch page consent resumes the same owner without creating navigating or consuming its URL token again', async () => {
  const auditId = 'audit-batch-page-resume';
  const ownershipId = `owner_${'Q'.repeat(22)}`;
  const checkpoints = [];
  const tokenCalls = [];
  const policy = createCapturePolicyV1({ mode: 'element-only', includeQuery: false });
  const adapter = fakeAdapter({
    canonicalInternals: true, sessionValues: {}, trackCaptureCalls: true,
    sensitiveSignals: PASSWORD_SIGNALS,
  });
  const paused = await runUrlAudit({
    auditId, ownershipId, windowId: 9,
    navigationToken: 'Q'.repeat(22), navigationPurpose: 'batch-page',
    evidenceUrl: TEST_EVIDENCE_URL, sessionDigest: TEST_DIGEST,
    rawNavigationVault: Object.freeze({
      async take(token) { tokenCalls.push(token); return 'https://example.test/final?private=REMOVE'; },
    }),
    chromeAdapter: adapter, capturePolicy: policy,
    privacyGate: ownedPixelGate(policy, [], { auditId, ownershipId, cleanupMode: 'always' }),
    checkpointStore: Object.freeze({
      async writeSanitized(_auditId, checkpoint) { checkpoints.push(checkpoint); },
    }),
    onProgress() {}, now: () => '2026-09-01T12:00:00.000Z', signal: undefined,
    expectedExtensionId: TEST_EXTENSION_ID, auditRunner: runObservedTabAudit,
  });
  assert.equal(paused.status, 'privacy-paused');
  assert.equal(paused.ownershipState, 'retained-for-consent');

  const forbidden = [];
  adapter.createTab = async () => { forbidden.push('create'); };
  adapter.navigateTab = async () => { forbidden.push('navigate'); };
  adapter.waitForStable = async () => { forbidden.push('stable'); };
  adapter.probeSensitiveCaptureSignals = async () => EMPTY_SIGNALS;
  const resumed = await runUrlAudit({
    auditId,
    requestedUrlEvidence: TEST_EVIDENCE_URL,
    resumeTarget: Object.freeze({
      kind: 'owned-disposable-resume', ownershipId,
      tabId: paused.observedTarget.tabId, windowId: paused.observedTarget.windowId,
      documentId: paused.observedTarget.documentId,
      initialUrlEvidence: paused.observedTarget.urlEvidence,
      initialUrlSessionDigest: paused.observedTarget.urlSessionDigest,
      navigationPurpose: 'batch-page', cleanupMode: 'always', pageId: 'page-1',
    }),
    resumeCheckpoint: checkpoints.at(-1), chromeAdapter: adapter, capturePolicy: policy,
    privacyGate: ownedPixelGate(policy, [], {
      auditId, ownershipId, consentId: 'A'.repeat(21) + 'Q', cleanupMode: 'always',
    }),
    checkpointStore: Object.freeze({ async writeSanitized() {} }),
    onProgress() {}, now: () => '2026-09-01T12:00:01.000Z', signal: undefined,
    expectedExtensionId: TEST_EXTENSION_ID, auditRunner: runObservedTabAudit,
  });

  assert.equal(resumed.status, 'complete');
  assert.equal(resumed.ownershipState, 'removed');
  assert.equal(resumed.observedTarget.ownershipId, ownershipId);
  assert.deepEqual(forbidden, []);
  assert.deepEqual(tokenCalls, ['Q'.repeat(22)]);
});

test('batch page resume captures no thumbnail after its retained document navigates', async () => {
  const auditId = 'audit-batch-page-raster-drift';
  const ownershipId = `owner_${'R'.repeat(22)}`;
  const checkpoints = [];
  let documentId = 'document-a';
  const policy = createCapturePolicyV1({ mode: 'full-evidence', includeQuery: false });
  const adapter = fakeAdapter({
    canonicalInternals: true,
    sessionValues: {},
    trackCaptureCalls: true,
    sensitiveSignals: PASSWORD_SIGNALS,
    async afterFullPage() { documentId = 'document-b'; },
    composeMap: async input => createAnnotationMapFixture({ sourceEvidenceId: input.fullPageEvidence.evidenceId }),
  });
  adapter.probeDocumentIdentity = async tabId => ({
    tabId, windowId: 9, documentId, urlSessionDigest: TEST_DIGEST,
  });
  const paused = await runUrlAudit({
    auditId, ownershipId, windowId: 9,
    navigationToken: 'R'.repeat(22), navigationPurpose: 'batch-page',
    evidenceUrl: TEST_EVIDENCE_URL, sessionDigest: TEST_DIGEST,
    rawNavigationVault: Object.freeze({
      async take() { return 'https://example.test/final?private=REMOVE'; },
    }),
    chromeAdapter: adapter, capturePolicy: policy,
    privacyGate: ownedPixelGate(policy, [], { auditId, ownershipId, cleanupMode: 'always' }),
    checkpointStore: Object.freeze({
      async writeSanitized(_auditId, checkpoint) { checkpoints.push(checkpoint); },
    }),
    onProgress() {}, now: () => '2026-09-01T12:00:00.000Z', signal: undefined,
    expectedExtensionId: TEST_EXTENSION_ID, auditRunner: runObservedTabAudit,
  });
  assert.equal(paused.status, 'privacy-paused');

  await assert.rejects(() => runUrlAudit({
    auditId,
    requestedUrlEvidence: TEST_EVIDENCE_URL,
    resumeTarget: Object.freeze({
      kind: 'owned-disposable-resume', ownershipId,
      tabId: paused.observedTarget.tabId, windowId: paused.observedTarget.windowId,
      documentId: paused.observedTarget.documentId,
      initialUrlEvidence: paused.observedTarget.urlEvidence,
      initialUrlSessionDigest: paused.observedTarget.urlSessionDigest,
      navigationPurpose: 'batch-page', cleanupMode: 'always', pageId: 'page-1',
    }),
    resumeCheckpoint: checkpoints.at(-1), chromeAdapter: adapter, capturePolicy: policy,
    privacyGate: ownedPixelGate(policy, [], {
      auditId, ownershipId, consentId: 'A'.repeat(21) + 'Q', cleanupMode: 'always',
    }),
    checkpointStore: Object.freeze({ async writeSanitized() {} }),
    onProgress() {}, now: () => '2026-09-01T12:00:01.000Z', signal: undefined,
    expectedExtensionId: TEST_EXTENSION_ID, auditRunner: runObservedTabAudit,
  }), /OBSERVED_RUNNER_DENIED/u);

  assert.equal(adapter.counts.fullPageCalls, 1);
  assert.equal(adapter.counts.elementCalls, 0);
  assert.equal(adapter.counts.screenshots, 1, 'document B must produce zero thumbnail rasters');
});

test('single URL denies a swapped private URL whose sanitized evidence still matches the authorized address', async () => {
  const values = {};
  const sessionArea = {
    async get(key) {
      if (key === null) return structuredClone(values);
      return Object.hasOwn(values, key) ? { [key]: structuredClone(values[key]) } : {};
    },
    async set(entries) { Object.assign(values, structuredClone(entries)); },
    async remove(key) {
      for (const entry of Array.isArray(key) ? key : [key]) delete values[entry];
    },
  };
  const digestManager = createSessionUrlDigestManager({
    sessionArea, subtle: webcrypto.subtle,
    randomBytes: length => new Uint8Array(length).fill(7),
    now: () => 1_788_000_000_000,
  });
  const vault = createRawNavigationVaultV1({
    sessionArea, digestManager, now: () => 1_788_000_000_000,
    randomBytes: length => new Uint8Array(length).fill(9),
  });
  const issued = await vault.put('https://example.test/path?account=ORIGINAL#one', {
    auditId: 'audit-url-swap', purpose: 'single-url', ttlMs: 600_000, includeQuery: false,
  });
  const rawKey = Object.keys(values).find(key => key.startsWith('audita:raw-navigation:v1:'));
  values[rawKey] = {
    ...values[rawKey], rawUrl: 'https://example.test/path?account=SWAPPED#two',
  };
  let released = null;
  let failure = null;
  try {
    await runUrlAudit({
      auditId: 'audit-url-swap', ownershipId: `owner_${'A'.repeat(22)}`,
      windowId: 9, navigationToken: issued.navigationToken, navigationPurpose: 'single-url',
      evidenceUrl: issued.evidenceUrl, sessionDigest: issued.sessionDigest, rawNavigationVault: vault,
      chromeAdapter: Object.freeze({}),
      capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
      checkpointStore: Object.freeze({ async writeSanitized() {} }),
      onProgress() {}, now: () => '2026-09-01T12:00:00.000Z', signal: undefined,
      expectedExtensionId: TEST_EXTENSION_ID,
      async auditRunner(input) {
        released = await input.chromeAdapter.resolveNavigationToken(input.target.navigationToken);
        return Object.freeze({
          status: 'complete', model: Object.freeze({ auditId: 'audit-url-swap' }),
          observedTarget: Object.freeze({ kind: 'owned-disposable' }),
          observationState: 'observed', ownershipState: 'retained-for-review',
        });
      },
    });
  } catch (error) { failure = error; }

  assert.ok(failure, 'uma URL privada trocada deve ser negada antes da navegação');
  assert.equal(released, null);
  assert.equal(Object.hasOwn(values, rawKey), false);
  assert.doesNotMatch(String(failure), /ORIGINAL|SWAPPED|account/iu);
});

test('single URL refuses every pixel policy without its exact branded privacy gate', async () => {
  let effects = 0;
  const base = {
    auditId: 'audit-url-pixels', ownershipId: `owner_${'A'.repeat(22)}`, navigationToken: 'N'.repeat(22),
    windowId: 9,
    navigationPurpose: 'single-url', evidenceUrl: TEST_EVIDENCE_URL, sessionDigest: TEST_DIGEST,
    rawNavigationVault: { async take() { effects += 1; return 'https://example.test/'; } },
    chromeAdapter: Object.freeze({}), checkpointStore: { async writeSanitized() { effects += 1; } },
    onProgress() {}, now: () => '2026-09-01T12:00:00.000Z', signal: undefined,
    expectedExtensionId: TEST_EXTENSION_ID, async auditRunner() { effects += 1; },
  };
  for (const mode of ['full-evidence', 'element-only']) {
    await assert.rejects(() => runUrlAudit({
      ...base, capturePolicy: createCapturePolicyV1({ mode, includeQuery: false }),
    }), /URL_AUDIT_DENIED/u);
  }
  assert.equal(effects, 0);
});

test('single URL executes full-evidence and element-only without silently changing the selected mode', async t => {
  for (const mode of ['full-evidence', 'element-only']) await t.test(mode, async () => {
    const auditId = `audit-url-${mode}`;
    const safeOwnershipId = `owner_${(mode === 'full-evidence' ? 'F' : 'E').repeat(22)}`;
    const calls = [];
    const sessionValues = {};
    const adapter = fakeAdapter({ canonicalInternals: true, sessionValues, trackCaptureCalls: true });
    const policy = createCapturePolicyV1({ mode, includeQuery: false });
    const result = await runUrlAudit({
      auditId, ownershipId: safeOwnershipId, windowId: 9,
      navigationToken: 'N'.repeat(22), navigationPurpose: 'single-url',
      evidenceUrl: TEST_EVIDENCE_URL, sessionDigest: TEST_DIGEST,
      rawNavigationVault: Object.freeze({ async take() { return 'https://example.test/final?secret=REMOVE'; } }),
      chromeAdapter: adapter, capturePolicy: policy,
      privacyGate: ownedPixelGate(policy, calls, { auditId, ownershipId: safeOwnershipId }),
      checkpointStore: Object.freeze({ async writeSanitized() {} }),
      onProgress() {}, now: () => '2026-09-01T12:00:00.000Z', signal: undefined,
      expectedExtensionId: TEST_EXTENSION_ID, auditRunner: runObservedTabAudit,
    });

    assert.equal(result.status, 'complete');
    assert.equal(adapter.counts.fullPageCalls, mode === 'full-evidence' ? 1 : 0);
    assert.equal(adapter.counts.elementCalls > 0, true);
    assert.equal(calls.at(-1), 'after');
  });
});

test('attached-copy executes both pixel modes in an inactive disposable tab and removes it after observation', async t => {
  for (const mode of ['full-evidence', 'element-only']) await t.test(mode, async () => {
    const auditId = `audit-copy-${mode}`;
    const ownershipId = `owner_${(mode === 'full-evidence' ? 'F' : 'E').repeat(22)}`;
    const calls = [];
    const sessionValues = {};
    const createRequests = [];
    const adapter = fakeAdapter({ canonicalInternals: true, sessionValues, trackCaptureCalls: true });
    const baseCreate = adapter.createTab;
    adapter.createTab = async details => {
      createRequests.push(structuredClone(details));
      return baseCreate(details);
    };
    const policy = createCapturePolicyV1({ mode, includeQuery: false });

    const result = await runUrlAudit({
      auditId, ownershipId, windowId: 9,
      navigationToken: 'C'.repeat(22), navigationPurpose: 'attached-copy',
      evidenceUrl: TEST_EVIDENCE_URL, sessionDigest: TEST_DIGEST,
      rawNavigationVault: Object.freeze({ async take() { return 'https://example.test/final?secret=REMOVE'; } }),
      chromeAdapter: adapter, capturePolicy: policy,
      privacyGate: ownedPixelGate(policy, calls, { auditId, ownershipId, cleanupMode: 'always' }),
      checkpointStore: Object.freeze({ async writeSanitized() {} }),
      onProgress() {}, now: () => '2026-09-01T12:00:00.000Z', signal: undefined,
      expectedExtensionId: TEST_EXTENSION_ID, auditRunner: runObservedTabAudit,
    });

    assert.equal(result.status, 'complete');
    assert.equal(result.ownershipState, 'removed');
    assert.equal(result.observedTarget.cleanupMode, 'always');
    assert.deepEqual(createRequests, [{ url: 'about:blank', active: false, windowId: 9 }]);
    assert.equal(adapter.counts.fullPageCalls, mode === 'full-evidence' ? 1 : 0);
    assert.equal(adapter.counts.elementCalls > 0, true);
    assert.equal(calls.at(-1), 'after');
    assert.doesNotMatch(JSON.stringify({ result, sessionValues }), /secret=REMOVE/u);
  });
});

test('single URL sensitive preflight retains its owned tab for consent with zero raster', async () => {
  const auditId = 'audit-url-sensitive-owned';
  const ownershipId = `owner_${'S'.repeat(22)}`;
  const calls = [];
  const checkpoints = [];
  const adapter = fakeAdapter({
    canonicalInternals: true, sessionValues: {}, trackCaptureCalls: true,
    sensitiveSignals: PASSWORD_SIGNALS,
  });
  const policy = createCapturePolicyV1({ mode: 'full-evidence', includeQuery: false });
  const result = await runUrlAudit({
    auditId, ownershipId, windowId: 9, navigationToken: 'N'.repeat(22), navigationPurpose: 'single-url',
    evidenceUrl: TEST_EVIDENCE_URL, sessionDigest: TEST_DIGEST,
    rawNavigationVault: Object.freeze({ async take() { return 'https://example.test/final?secret=REMOVE'; } }),
    chromeAdapter: adapter, capturePolicy: policy,
    privacyGate: ownedPixelGate(policy, calls, { auditId, ownershipId }),
    checkpointStore: Object.freeze({ async writeSanitized(_auditId, checkpoint) { checkpoints.push(checkpoint); } }),
    onProgress() {}, now: () => '2026-09-01T12:00:00.000Z', signal: undefined,
    expectedExtensionId: TEST_EXTENSION_ID, auditRunner: runObservedTabAudit,
  });

  assert.equal(result.status, 'privacy-paused');
  assert.equal(result.ownershipState, 'retained-for-consent');
  assert.equal(adapter.counts.screenshots, 0);
  assert.equal(checkpoints.length > 0, true);
  assert.equal(calls.includes('after'), false);
});

test('single URL resume uses the retained owner without creating navigating or consuming a URL token again', async () => {
  const auditId = 'audit-url-resume-owned';
  const ownershipId = `owner_${'R'.repeat(22)}`;
  const sessionValues = {};
  const checkpoints = [];
  const policy = createCapturePolicyV1({ mode: 'element-only', includeQuery: false });
  const pauseCalls = [];
  const adapter = fakeAdapter({
    canonicalInternals: true, sessionValues, trackCaptureCalls: true,
    sensitiveSignals: PASSWORD_SIGNALS,
  });
  const paused = await runUrlAudit({
    auditId, ownershipId, windowId: 9, navigationToken: 'N'.repeat(22), navigationPurpose: 'single-url',
    evidenceUrl: TEST_EVIDENCE_URL, sessionDigest: TEST_DIGEST,
    rawNavigationVault: Object.freeze({ async take() { return 'https://example.test/final?secret=REMOVE'; } }),
    chromeAdapter: adapter, capturePolicy: policy,
    privacyGate: ownedPixelGate(policy, pauseCalls, { auditId, ownershipId }),
    checkpointStore: Object.freeze({ async writeSanitized(_auditId, checkpoint) { checkpoints.push(checkpoint); } }),
    onProgress() {}, now: () => '2026-09-01T12:00:00.000Z', signal: undefined,
    expectedExtensionId: TEST_EXTENSION_ID, auditRunner: runObservedTabAudit,
  });
  assert.equal(paused.status, 'privacy-paused');
  const resumeCheckpoint = checkpoints.at(-1);
  const forbidden = [];
  adapter.createTab = async () => { forbidden.push('create'); };
  adapter.navigateTab = async () => { forbidden.push('navigate'); };
  adapter.waitForStable = async () => { forbidden.push('stable'); };
  adapter.probeSensitiveCaptureSignals = async () => EMPTY_SIGNALS;
  const resumeCalls = [];
  const resumed = await runUrlAudit({
    auditId,
    requestedUrlEvidence: TEST_EVIDENCE_URL,
    resumeTarget: Object.freeze({
      kind: 'owned-disposable-resume', ownershipId,
      tabId: paused.observedTarget.tabId, windowId: paused.observedTarget.windowId,
      documentId: paused.observedTarget.documentId,
      initialUrlEvidence: paused.observedTarget.urlEvidence,
      initialUrlSessionDigest: paused.observedTarget.urlSessionDigest,
      navigationPurpose: 'single-url',
      cleanupMode: 'pre-observation-failure', pageId: 'page-1',
    }),
    resumeCheckpoint,
    chromeAdapter: adapter, capturePolicy: policy,
    privacyGate: ownedPixelGate(policy, resumeCalls, {
      auditId, ownershipId, consentId: 'A'.repeat(21) + 'Q',
    }),
    checkpointStore: Object.freeze({ async writeSanitized() {} }),
    onProgress() {}, now: () => '2026-09-01T12:00:01.000Z', signal: undefined,
    expectedExtensionId: TEST_EXTENSION_ID, auditRunner: runObservedTabAudit,
  });

  assert.equal(resumed.status, 'complete');
  assert.equal(resumed.ownershipState, 'retained-for-review');
  assert.deepEqual(forbidden, []);
  assert.equal(resumeCalls.includes('gate'), true);
});

test('attached-copy resume transports its purpose explicitly and removes the retained owner without navigating again', async () => {
  const auditId = 'audit-copy-resume-owned';
  const ownershipId = `owner_${'C'.repeat(22)}`;
  const sessionValues = {};
  const checkpoints = [];
  const policy = createCapturePolicyV1({ mode: 'element-only', includeQuery: false });
  const adapter = fakeAdapter({
    canonicalInternals: true, sessionValues, trackCaptureCalls: true,
    sensitiveSignals: PASSWORD_SIGNALS,
  });
  const paused = await runUrlAudit({
    auditId, ownershipId, windowId: 9, navigationToken: 'C'.repeat(22), navigationPurpose: 'attached-copy',
    evidenceUrl: TEST_EVIDENCE_URL, sessionDigest: TEST_DIGEST,
    rawNavigationVault: Object.freeze({ async take() { return 'https://example.test/final?secret=REMOVE'; } }),
    chromeAdapter: adapter, capturePolicy: policy,
    privacyGate: ownedPixelGate(policy, [], { auditId, ownershipId, cleanupMode: 'always' }),
    checkpointStore: Object.freeze({ async writeSanitized(_auditId, checkpoint) { checkpoints.push(checkpoint); } }),
    onProgress() {}, now: () => '2026-09-01T12:00:00.000Z', signal: undefined,
    expectedExtensionId: TEST_EXTENSION_ID, auditRunner: runObservedTabAudit,
  });
  assert.equal(paused.status, 'privacy-paused');
  assert.equal(paused.ownershipState, 'retained-for-consent');

  const forbidden = [];
  adapter.createTab = async () => { forbidden.push('create'); };
  adapter.navigateTab = async () => { forbidden.push('navigate'); };
  adapter.waitForStable = async () => { forbidden.push('stable'); };
  adapter.probeSensitiveCaptureSignals = async () => EMPTY_SIGNALS;
  const resumed = await runUrlAudit({
    auditId,
    requestedUrlEvidence: TEST_EVIDENCE_URL,
    resumeTarget: Object.freeze({
      kind: 'owned-disposable-resume', ownershipId,
      tabId: paused.observedTarget.tabId, windowId: paused.observedTarget.windowId,
      documentId: paused.observedTarget.documentId,
      initialUrlEvidence: paused.observedTarget.urlEvidence,
      initialUrlSessionDigest: paused.observedTarget.urlSessionDigest,
      navigationPurpose: 'attached-copy', cleanupMode: 'always', pageId: 'page-1',
    }),
    resumeCheckpoint: checkpoints.at(-1), chromeAdapter: adapter, capturePolicy: policy,
    privacyGate: ownedPixelGate(policy, [], {
      auditId, ownershipId, consentId: 'A'.repeat(21) + 'Q', cleanupMode: 'always',
    }),
    checkpointStore: Object.freeze({ async writeSanitized() {} }),
    onProgress() {}, now: () => '2026-09-01T12:00:01.000Z', signal: undefined,
    expectedExtensionId: TEST_EXTENSION_ID, auditRunner: runObservedTabAudit,
  });

  assert.equal(resumed.status, 'complete');
  assert.equal(resumed.ownershipState, 'removed');
  assert.equal(resumed.observedTarget.cleanupMode, 'always');
  assert.deepEqual(forbidden, []);
});

test('single URL element-only resume with no element consumes consent before pixel-free persistence', async () => {
  const auditId = 'audit-url-resume-no-elements';
  const ownershipId = `owner_${'Z'.repeat(22)}`;
  const sessionValues = {};
  const checkpoints = [];
  const policy = createCapturePolicyV1({ mode: 'element-only', includeQuery: false });
  const emptyPage = rawPage();
  emptyPage.nodes = [];
  emptyPage.axTree.nodes = [];
  const adapter = fakeAdapter({
    canonicalInternals: true, sessionValues, page: emptyPage,
    trackCaptureCalls: true, sensitiveSignals: PASSWORD_SIGNALS,
  });
  const paused = await runUrlAudit({
    auditId, ownershipId, windowId: 9, navigationToken: 'N'.repeat(22), navigationPurpose: 'single-url',
    evidenceUrl: TEST_EVIDENCE_URL, sessionDigest: TEST_DIGEST,
    rawNavigationVault: Object.freeze({ async take() { return 'https://example.test/final?secret=REMOVE'; } }),
    chromeAdapter: adapter, capturePolicy: policy,
    privacyGate: ownedPixelGate(policy, [], { auditId, ownershipId }),
    checkpointStore: Object.freeze({ async writeSanitized(_auditId, checkpoint) { checkpoints.push(checkpoint); } }),
    onProgress() {}, now: () => '2026-09-01T12:00:00.000Z', signal: undefined,
    expectedExtensionId: TEST_EXTENSION_ID, auditRunner: runObservedTabAudit,
  });
  assert.equal(paused.status, 'privacy-paused');

  adapter.probeSensitiveCaptureSignals = async () => EMPTY_SIGNALS;
  const resumeCalls = [];
  const persisted = [];
  const resumed = await runUrlAudit({
    auditId,
    requestedUrlEvidence: TEST_EVIDENCE_URL,
    resumeTarget: Object.freeze({
      kind: 'owned-disposable-resume', ownershipId,
      tabId: paused.observedTarget.tabId, windowId: paused.observedTarget.windowId,
      documentId: paused.observedTarget.documentId,
      initialUrlEvidence: paused.observedTarget.urlEvidence,
      initialUrlSessionDigest: paused.observedTarget.urlSessionDigest,
      navigationPurpose: 'single-url',
      cleanupMode: 'pre-observation-failure', pageId: 'page-1',
    }),
    resumeCheckpoint: checkpoints.at(-1), chromeAdapter: adapter, capturePolicy: policy,
    privacyGate: ownedPixelGate(policy, resumeCalls, {
      auditId, ownershipId, consentId: 'A'.repeat(21) + 'Q',
    }),
    checkpointStore: Object.freeze({
      async writeSanitized() {},
      async persistAuditModel(model, target) { persisted.push({ model, target }); },
    }),
    onProgress() {}, now: () => '2026-09-01T12:00:01.000Z', signal: undefined,
    expectedExtensionId: TEST_EXTENSION_ID, auditRunner: runObservedTabAudit,
  });

  assert.equal(resumed.status, 'complete');
  assert.equal(adapter.counts.screenshots, 0);
  assert.equal(adapter.counts.fullPageCalls, 0);
  assert.equal(adapter.counts.elementCalls, 0);
  assert.equal(resumeCalls.filter(value => value === 'gate').length, 1);
  assert.deepEqual(resumeCalls, ['gate', 'after']);
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].model.auditId, auditId);
  assert.equal(persisted[0].target.ownershipId, ownershipId);
});

test('single URL redirect resume preserves the sanitized requested URL outside the final observed target', async () => {
  const auditId = 'audit-url-resume-redirect';
  const ownershipId = `owner_${'Y'.repeat(22)}`;
  const requestedUrlEvidence = sanitizeEvidenceUrlV1(
    'https://requested.example/start?secret=REMOVE',
    { includeQuery: false },
  );
  const finalUrlEvidence = sanitizeEvidenceUrlV1(
    'https://final.example/dest?session=REMOVE',
    { includeQuery: false },
  );
  const sessionValues = {};
  const checkpoints = [];
  const page = rawPage();
  page.document.url = 'https://final.example/dest?session=REMOVE';
  const policy = createCapturePolicyV1({ mode: 'full-evidence', includeQuery: false });
  const adapter = fakeAdapter({
    canonicalInternals: true, sessionValues, page,
    trackCaptureCalls: true, sensitiveSignals: PASSWORD_SIGNALS,
  });
  adapter.waitForStable = async () => ({ url: 'https://final.example/dest?session=REMOVE' });
  adapter.getEvidenceUrl = async () => finalUrlEvidence;
  adapter.getFinalUrl = async () => 'https://final.example/dest?session=REMOVE';
  const paused = await runUrlAudit({
    auditId, ownershipId, windowId: 9, navigationToken: 'N'.repeat(22), navigationPurpose: 'single-url',
    evidenceUrl: requestedUrlEvidence, sessionDigest: TEST_DIGEST,
    rawNavigationVault: Object.freeze({ async take() { return 'https://requested.example/start?secret=REMOVE'; } }),
    chromeAdapter: adapter, capturePolicy: policy,
    privacyGate: ownedPixelGate(policy, [], { auditId, ownershipId, urlEvidence: finalUrlEvidence }),
    checkpointStore: Object.freeze({ async writeSanitized(_auditId, checkpoint) { checkpoints.push(checkpoint); } }),
    onProgress() {}, now: () => '2026-09-01T12:00:00.000Z', signal: undefined,
    expectedExtensionId: TEST_EXTENSION_ID, auditRunner: runObservedTabAudit,
  });
  assert.equal(paused.status, 'privacy-paused');
  assert.equal(paused.observedTarget.urlEvidence.href, finalUrlEvidence.href);

  adapter.probeSensitiveCaptureSignals = async () => EMPTY_SIGNALS;
  const persisted = [];
  const resumed = await runUrlAudit({
    auditId,
    requestedUrlEvidence,
    resumeTarget: Object.freeze({
      kind: 'owned-disposable-resume', ownershipId,
      tabId: paused.observedTarget.tabId, windowId: paused.observedTarget.windowId,
      documentId: paused.observedTarget.documentId,
      initialUrlEvidence: paused.observedTarget.urlEvidence,
      initialUrlSessionDigest: paused.observedTarget.urlSessionDigest,
      navigationPurpose: 'single-url',
      cleanupMode: 'pre-observation-failure', pageId: 'page-1',
    }),
    resumeCheckpoint: checkpoints.at(-1), chromeAdapter: adapter, capturePolicy: policy,
    privacyGate: ownedPixelGate(policy, [], {
      auditId, ownershipId, consentId: 'A'.repeat(21) + 'Q', urlEvidence: finalUrlEvidence,
    }),
    checkpointStore: Object.freeze({
      async writeSanitized() {},
      async persistAuditModel(model) { persisted.push(model); },
    }),
    onProgress() {}, now: () => '2026-09-01T12:00:01.000Z', signal: undefined,
    expectedExtensionId: TEST_EXTENSION_ID, auditRunner: runObservedTabAudit,
  });

  assert.equal(resumed.status, 'complete');
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].requestedUrl, requestedUrlEvidence.href);
  assert.equal(persisted[0].finalUrl, finalUrlEvidence.href);
  assert.equal(persisted[0].pages[0].requestedUrl, requestedUrlEvidence.href);
  assert.equal(persisted[0].pages[0].finalUrl, finalUrlEvidence.href);
  assert.notEqual(persisted[0].requestedUrl, persisted[0].finalUrl);
  assert.doesNotMatch(JSON.stringify({ resumed, persisted }), /secret=REMOVE|session=REMOVE/u);
});

test('single URL full evidence starts no thumbnail after document A changes to B', async () => {
  const auditId = 'audit-url-owned-drift';
  const ownershipId = `owner_${'D'.repeat(22)}`;
  const calls = [];
  let proofCount = 0;
  const adapter = fakeAdapter({ canonicalInternals: true, sessionValues: {}, trackCaptureCalls: true });
  adapter.probeDocumentIdentity = async tabId => {
    proofCount += 1;
    return proofCount < 4
      ? { tabId, windowId: 9, documentId: 'document-a', urlSessionDigest: TEST_DIGEST }
      : { tabId, windowId: 9, documentId: 'document-b', urlSessionDigest: `hmac-sha256:${'B'.repeat(43)}` };
  };
  const policy = createCapturePolicyV1({ mode: 'full-evidence', includeQuery: false });
  await assert.rejects(() => runUrlAudit({
    auditId, ownershipId, windowId: 9, navigationToken: 'N'.repeat(22), navigationPurpose: 'single-url',
    evidenceUrl: TEST_EVIDENCE_URL, sessionDigest: TEST_DIGEST,
    rawNavigationVault: Object.freeze({ async take() { return 'https://example.test/final?secret=REMOVE'; } }),
    chromeAdapter: adapter, capturePolicy: policy,
    privacyGate: ownedPixelGate(policy, calls, { auditId, ownershipId }),
    checkpointStore: Object.freeze({ async writeSanitized() {} }),
    onProgress() {}, now: () => '2026-09-01T12:00:00.000Z', signal: undefined,
    expectedExtensionId: TEST_EXTENSION_ID, auditRunner: runObservedTabAudit,
  }), /OBSERVED_RUNNER_DENIED/u);
  assert.equal(adapter.counts.screenshots, 1);
});

test('single URL full evidence starts zero raster when document A changes before its first capture', async t => {
  for (const changeAt of [2, 3]) await t.test(`proof-${changeAt}`, async () => {
    const auditId = `audit-url-owned-first-drift-${changeAt}`;
    const ownershipId = `owner_${String(changeAt).repeat(22)}`;
    const calls = [];
    let proofCount = 0;
    const adapter = fakeAdapter({ canonicalInternals: true, sessionValues: {}, trackCaptureCalls: true });
    adapter.probeDocumentIdentity = async tabId => {
      proofCount += 1;
      return proofCount < changeAt
        ? { tabId, windowId: 9, documentId: 'document-a', urlSessionDigest: TEST_DIGEST }
        : { tabId, windowId: 9, documentId: 'document-b', urlSessionDigest: `hmac-sha256:${'B'.repeat(43)}` };
    };
    const policy = createCapturePolicyV1({ mode: 'full-evidence', includeQuery: false });
    await assert.rejects(() => runUrlAudit({
      auditId, ownershipId, windowId: 9, navigationToken: 'N'.repeat(22), navigationPurpose: 'single-url',
      evidenceUrl: TEST_EVIDENCE_URL, sessionDigest: TEST_DIGEST,
      rawNavigationVault: Object.freeze({ async take() { return 'https://example.test/final?secret=REMOVE'; } }),
      chromeAdapter: adapter, capturePolicy: policy,
      privacyGate: ownedPixelGate(policy, calls, { auditId, ownershipId }),
      checkpointStore: Object.freeze({ async writeSanitized() {} }),
      onProgress() {}, now: () => '2026-09-01T12:00:00.000Z', signal: undefined,
      expectedExtensionId: TEST_EXTENSION_ID, auditRunner: runObservedTabAudit,
    }), /OBSERVED_RUNNER_DENIED/u);
    assert.equal(adapter.counts.screenshots, 0);
  });
});

test('ownership IDs contain exactly 128 CSPRNG bits', () => {
  assert.equal(createOwnershipId(length => new Uint8Array(length).fill(1)), 'owner_AQEBAQEBAQEBAQEBAQEBAQ');
  assert.match(createOwnershipId(length => new Uint8Array(length).fill(255)), /^owner_[A-Za-z0-9_-]{22}$/u);
  assert.throws(() => createOwnershipId(() => new Uint8Array(15)), /OWNERSHIP_ID_INVALID/u);
});

function rawPage() {
  return {
    format: 'simplified-v1',
    document: { url: 'https://example.test/final?token=REMOVE&view=public', title: 'Página', language: 'pt-BR' },
    coverage: { runtime: { outcome: 'complete' }, accessibility: { outcome: 'complete' } },
    warnings: [],
    layoutMetrics: { cssContentSize: { width: 800, height: 1200 }, cssLayoutViewport: { clientWidth: 800, clientHeight: 600 } },
    nodes: [
      { backendNodeId: 1, tagName: 'button', focusable: true, attributes: { id: 'ok' }, text: 'OK', parentBackendNodeId: null, rect: { x: 10, y: 20, width: 80, height: 30 } },
      { backendNodeId: 2, tagName: 'button', attributes: { id: 'other' }, text: 'Outro', parentBackendNodeId: null, rect: { x: 10, y: 60, width: 80, height: 30 } },
      { backendNodeId: 3, tagName: 'video', attributes: { id: 'clip' }, text: '', parentBackendNodeId: null, rect: { x: 10, y: 100, width: 320, height: 180 }, media: { kind: 'video', currentSrc: 'https://user:pass@example.test/clip.mp4?token=REMOVE&lang=pt' } },
    ],
    axTree: { nodes: [] },
  };
}

function pageWithAxName(name) {
  const page = rawPage();
  page.nodes[0] = {
    ...page.nodes[0],
    attributes: {
      ...page.nodes[0].attributes,
      'aria-label': 'Fallback DOM',
      'aria-selected': 'true',
      'aria-expanded': 'false',
      'aria-invalid': 'grammar',
    },
    checked: 'mixed',
    disabled: true,
    required: true,
  };
  page.axTree.nodes = [{
    backendDOMNodeId: 1,
    role: { value: 'button' },
    name: { value: name },
    description: { value: 'Envia o formulário' },
    value: { value: 'Pronto' },
  }];
  return page;
}

function pageWithSensitiveControl(secret) {
  const page = rawPage();
  page.nodes[0] = {
    ...page.nodes[0],
    tagName: 'input',
    attributes: { id: 'credential', type: 'password', autocomplete: 'current-password', value: secret },
    text: secret,
    visibleText: secret,
    form: { type: 'password', value: secret, currentValue: secret },
  };
  page.axTree.nodes = [{
    backendDOMNodeId: 1,
    role: { value: 'textbox' },
    name: { value: 'Senha da conta' },
    value: { value: secret },
  }];
  return page;
}

function pageWithEditableSecret(secret) {
  const page = rawPage();
  page.nodes[0] = {
    ...page.nodes[0],
    tagName: 'input',
    attributes: { id: 'api-field', type: 'text', name: 'api_key', value: secret },
    text: secret,
    visibleText: secret,
    form: { type: 'text', value: secret, currentValue: secret, rawValue: secret, inputValue: secret },
  };
  page.axTree.nodes = [{
    backendDOMNodeId: 1,
    role: { value: 'textbox' },
    name: { value: 'Chave da API' },
    description: { value: 'Informe a chave' },
    value: { value: secret },
  }];
  return page;
}

function pageWithFormCheckbox() {
  const page = rawPage();
  page.nodes[0] = {
    ...page.nodes[0],
    tagName: 'input',
    attributes: { id: 'terms', type: 'checkbox', 'aria-disabled': 'true', 'aria-required': 'true', 'aria-invalid': 'true' },
    form: { type: 'checkbox', checked: true, disabled: false, required: false },
  };
  page.axTree.nodes = [{ backendDOMNodeId: 1, role: { value: 'checkbox' }, name: { value: 'Aceito os termos' } }];
  return page;
}

function pageWithContentEditableSecret(secret) {
  const page = rawPage();
  page.nodes.push({
    backendNodeId: 8, tagName: 'div', parentBackendNodeId: null,
    attributes: { role: 'button', tabindex: '0', 'aria-label': 'Painel público' },
    text: 'Estrutura pública', visibleText: `Conteúdo público ${secret}`,
    focusable: true, interactive: true, interaction: 'button',
    rect: { x: 8, y: 8, width: 160, height: 96 },
  });
  page.nodes[0] = {
    ...page.nodes[0], tagName: 'div', parentBackendNodeId: 8,
    attributes: {
      id: secret, name: secret, contenteditable: 'true', role: 'textbox', tabindex: '0',
      title: secret, 'aria-label': secret, 'aria-description': secret,
      'aria-labelledby': 'editor-label', 'aria-describedby': 'editor-description',
      'data-private': secret, href: `https://example.test/editor?view=${secret}`,
    },
    selectorHint: `#${secret}`,
    text: secret, visibleText: secret, focusable: true, interactive: true, interaction: 'text-entry',
    media: { kind: 'video', currentSrc: `https://example.test/editor-media?view=${secret}` },
  };
  page.nodes.push({
    backendNodeId: 4, tagName: 'div', parentBackendNodeId: 1,
    attributes: {
      id: secret, name: secret, title: secret, 'aria-label': secret,
      'data-private': secret, src: `https://example.test/child?view=${secret}`,
    },
    selectorHint: `#${secret}`, text: secret, visibleText: secret,
    interactive: true, interaction: 'button',
    media: { kind: 'video', currentSrc: `https://example.test/child-media?view=${secret}` },
    rect: { x: 12, y: 24, width: 40, height: 20 },
  });
  page.nodes.push({
    backendNodeId: 5, tagName: 'input', parentBackendNodeId: 1,
    attributes: { id: secret, name: secret, type: 'text', title: secret, 'data-private': secret, value: secret },
    selectorHint: `#${secret}`, text: secret, visibleText: secret,
    form: { type: 'text', value: secret, currentValue: secret },
    rect: { x: 12, y: 48, width: 80, height: 24 },
  });
  page.nodes.push(
    { backendNodeId: 6, tagName: 'span', parentBackendNodeId: null, attributes: { id: 'editor-label' }, text: 'Editor externo seguro' },
    { backendNodeId: 7, tagName: 'span', parentBackendNodeId: null, attributes: { id: 'editor-description' }, text: 'Descrição externa segura' },
  );
  page.axTree.nodes = [
    { backendDOMNodeId: 8, role: { value: 'button' }, name: { value: 'Painel público' } },
    { backendDOMNodeId: 1, role: { value: 'textbox' }, name: { value: secret }, description: { value: secret }, value: { value: secret } },
    { backendDOMNodeId: 4, role: { value: 'generic' }, name: { value: secret }, description: { value: secret }, value: { value: secret } },
    { backendDOMNodeId: 5, role: { value: 'textbox' }, name: { value: 'Campo interno seguro' }, description: { value: 'Descrição do campo segura' }, value: { value: secret } },
  ];
  return page;
}

function pageWithSelect({ attributeMultiple = false, formMultiple = false, axRole = '' } = {}) {
  const page = rawPage();
  page.nodes[0] = {
    ...page.nodes[0], tagName: 'select',
    attributes: { id: 'choice', ...(attributeMultiple ? { multiple: '' } : {}) },
    form: { type: 'select', multiple: formMultiple },
  };
  page.axTree.nodes = axRole ? [{ backendDOMNodeId: 1, role: { value: axRole }, name: { value: 'Escolha' } }] : [];
  return page;
}

function pageWithFallbackInput(type) {
  const page = rawPage();
  page.nodes[0] = { ...page.nodes[0], tagName: 'input', attributes: { id: `field-${type}`, type }, form: { type } };
  page.axTree.nodes = [];
  return page;
}

function fakeAdapter(options = {}) {
  const events = [];
  const page = options.page || rawPage();
  let screenshots = 0;
  let fullPageCalls = 0;
  let elementCalls = 0;
  let disconnects = 0;
  let removals = 0;
  const cdp = {
    async command(method, params = {}) {
      if (method === 'Page.getLayoutMetrics') return page.layoutMetrics;
      if (method === 'Page.captureScreenshot') {
        screenshots += 1;
        const pristine = screenshots === 1;
        events.push(pristine ? 'full-page' : `thumbnail:${params.clip?.y}`);
        if (options.fullPageFailure && pristine) {
          throw options.fullPageFailure instanceof Error ? options.fullPageFailure : new Error('capture unavailable');
        }
        return { data: PNG };
      }
      if (method === 'DOM.getOuterHTML') {
        if (options.snippetFailureNode === params.backendNodeId) throw new Error('node vanished');
        options.afterSnippet?.(params.backendNodeId);
        return { outerHTML: options.outerHtml?.(params.backendNodeId) ?? `<button data-token="SECRET">Node ${params.backendNodeId}</button>` };
      }
      return {};
    },
    async disconnect() {
      disconnects += 1;
      events.push('disconnect');
      if (options.disconnectFailure) throw new Error('detalhe privado de desconexão');
    },
  };
  const sessionValues = options.sessionValues ?? {};
  let randomValue = 0;
  const adapter = {
    events,
    get counts() { return { screenshots, fullPageCalls, elementCalls, disconnects, removals }; },
    async createTab() {
      events.push('create-tab');
      if (options.createTabFailure) throw new Error('detalhe privado de criação');
      return Object.hasOwn(options, 'createTabResult') ? options.createTabResult : { id: 42, windowId: 9 };
    },
    async navigateTab(_id, url) { events.push(`navigate:${url}`); },
    async waitForStable(_id, { signal } = {}) {
      events.push('stable');
      if (options.waitFailure) throw options.waitFailure;
      if (signal?.aborted) throw signal.reason;
      return { url: 'https://example.test/final?token=REMOVE&view=public' };
    },
    async probeDocumentIdentity(tabId) { return { tabId, windowId: 9, documentId: 'document-a', urlSessionDigest: `hmac-sha256:${'A'.repeat(43)}` }; },
    async getEvidenceUrl() { return 'https://example.test/final?view=public'; },
    async probePrivacySignals() { return []; },
    async probeSensitiveCaptureSignals() {
      events.push('sensitive-probe');
      await options.duringSensitiveProbe?.();
      return options.sensitiveSignals ?? EMPTY_SIGNALS;
    },
    async connectCdp() { events.push('connect-cdp'); return cdp; },
    async runAxeInTab() {
      events.push('axe');
      if (options.axeFailure) throw options.axeFailure;
      return options.axeRun || {
        status: 'disabled', provenance: AXE_PROVENANCE, frames: [],
        diagnostics: [{ code: 'AXE_FEATURE_DISABLED', frameId: null }],
      };
    },
    async collectPage() {
      events.push('collect');
      options.afterCollect?.();
      if (options.collectError) throw options.collectError;
      if (options.collectFailure) throw new Error('DOM unavailable');
      return page;
    },
    async runDynamicProbes() { events.push('probes'); return options.rawProbes || { focus: { completed: false, events: [] }, warnings: [], actions: [] }; },
    async getEnvironment() {
      return Object.hasOwn(options, 'environmentResult')
        ? options.environmentResult
        : { chromeVersion: 'Chrome/140.0', viewport: { width: 800, height: 600, deviceScaleFactor: 1 } };
    },
    async getFinalUrl() { return 'https://example.test/final?token=REMOVE&view=public'; },
    async emitProgress(message) {
      events.push(`progress:${message.percent}`);
      return options.onEmitProgress?.(message);
    },
    async handoffReport(model) { events.push('handoff'); return options.handoff || { reviewUrl: `chrome-extension://${TEST_EXTENSION_ID}/src/review/index.html?auditId=${model.auditId}`, artifact: { status: 'pending', formats: [] } }; },
    async removeTab(id) {
      if (!Object.hasOwn(options, 'createTabResult')) assert.equal(id, 42);
      removals += 1;
      events.push(`remove-tab:${String(id)}`);
      if (options.removeTabFailure) throw new Error('detalhe privado de fechamento');
    },
  };
  if (options.trackCaptureCalls) {
    adapter.captureFullPage = async (...args) => {
      fullPageCalls += 1;
      const result = await captureFullPageEvidence(...args);
      await options.afterFullPage?.();
      return result;
    };
    adapter.captureElement = async (...args) => {
      elementCalls += 1;
      const result = await captureElementEvidence(...args);
      await options.afterElement?.();
      return result;
    };
  }
  const canonicalInternal = Object.assign(Object.create(null), {
    sessionArea: {
      async get(key) { return Object.hasOwn(sessionValues, key) ? { [key]: structuredClone(sessionValues[key]) } : {}; },
      async set(entries) { Object.assign(sessionValues, structuredClone(entries)); },
      async remove(key) { delete sessionValues[key]; },
    },
    randomBytes(length) { return new Uint8Array(length).fill(++randomValue); },
    capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    ...(options.onExecutionCheckpoint ? { onExecutionCheckpoint: options.onExecutionCheckpoint } : {}),
    ...(options.persistAuditModel ? { persistAuditModel: options.persistAuditModel } : {}),
  });
  const internal = options.canonicalInternals
    ? Object.freeze(canonicalInternal)
    : Object.freeze({
      sessionArea: {
        async get(key) { return Object.hasOwn(sessionValues, key) ? { [key]: structuredClone(sessionValues[key]) } : {}; },
        async set(entries) { Object.assign(sessionValues, structuredClone(entries)); },
        async remove(key) { delete sessionValues[key]; },
      },
      randomBytes(length) { return new Uint8Array(length).fill(++randomValue); },
      epochNow: () => 1_788_000_000_000,
      capturePolicy: createCapturePolicyV1({ mode: options.mode ?? (options.noPixels ? 'no-pixels' : 'full-evidence'), includeQuery: false }),
      privacyDecision: options.noPixels || options.mode === 'no-pixels'
        ? Object.freeze({ status: 'no-pixels', limitationCode: 'PIXEL_CAPTURE_OMITTED' })
        : Object.freeze({
          status: 'allowed', consentCapabilityId: 'consent-a', documentId: 'document-a',
          urlSessionDigest: `hmac-sha256:${'A'.repeat(43)}`,
        }),
      ...(options.noPixels || options.mode === 'no-pixels' ? {} : { consentAuthority: Object.freeze({ async consume() { return true; } }) }),
    });
  Object.defineProperty(adapter, AUDIT_EXECUTION_INTERNAL, {
    enumerable: false,
    value: internal,
  });
  if (options.composeMap || options.mapFailure) adapter.composeAnnouncementMap = async input => {
    events.push('map');
    if (options.mapFailure) throw options.mapFailure;
    return options.composeMap(input);
  };
  return adapter;
}

test('single URL production façade composes the observed pipeline and retains its audited tab for review', async () => {
  const sessionValues = {};
  const adapter = fakeAdapter({ noPixels: true, canonicalInternals: true, sessionValues });
  const checkpoints = [];
  let tokenTakes = 0;
  const result = await runUrlAudit({
    auditId: 'audit-url-production', ownershipId: `owner_${'O'.repeat(22)}`,
    windowId: 9,
    navigationToken: 'N'.repeat(22), navigationPurpose: 'single-url',
    evidenceUrl: sanitizeEvidenceUrlV1('https://example.test/final?secret=REMOVE', { includeQuery: false }),
    sessionDigest: TEST_DIGEST,
    rawNavigationVault: Object.freeze({
      async take(token, options) {
        tokenTakes += 1;
        assert.equal(token, 'N'.repeat(22));
        assert.deepEqual(options, {
          auditId: 'audit-url-production', purpose: 'single-url',
          expectedEvidenceUrl: sanitizeEvidenceUrlV1('https://example.test/final?secret=REMOVE', { includeQuery: false }),
          expectedSessionDigest: TEST_DIGEST,
        });
        return 'https://example.test/final?secret=REMOVE';
      },
    }),
    chromeAdapter: adapter,
    capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    checkpointStore: Object.freeze({ async writeSanitized(auditId, checkpoint) { checkpoints.push({ auditId, checkpoint }); } }),
    onProgress() {}, now: clock, signal: undefined, expectedExtensionId: TEST_EXTENSION_ID,
    auditRunner: runObservedTabAudit,
  });

  assert.equal(result.status, 'complete');
  assert.equal(result.model.auditId, 'audit-url-production');
  assert.equal(result.observationState, 'observed');
  assert.equal(result.ownershipState, 'retained-for-review');
  assert.equal(result.observedTarget.ownershipId, `owner_${'O'.repeat(22)}`);
  assert.equal(tokenTakes, 1);
  assert.equal(checkpoints.length > 0, true);
  assert.equal(adapter.counts.screenshots, 0);
  assert.doesNotMatch(JSON.stringify({ result, checkpoints }), /secret=REMOVE|NNNNNNNNNNNNNNNNNNNNNN/u);
});

test('attached-copy production façade creates only an inactive tab and removes it after observation', async () => {
  const sessionValues = {};
  const adapter = fakeAdapter({ noPixels: true, canonicalInternals: true, sessionValues });
  const createRequests = [];
  const baseCreate = adapter.createTab;
  adapter.createTab = async details => {
    createRequests.push(structuredClone(details));
    return baseCreate(details);
  };
  const result = await runUrlAudit({
    auditId: 'audit-attached-copy-production', ownershipId: `owner_${'C'.repeat(22)}`,
    windowId: 9,
    navigationToken: 'C'.repeat(22), navigationPurpose: 'attached-copy',
    evidenceUrl: TEST_EVIDENCE_URL, sessionDigest: TEST_DIGEST,
    rawNavigationVault: Object.freeze({
      async take(_token, options) {
        assert.equal(options.purpose, 'attached-copy');
        return 'https://example.test/final?secret=REMOVE';
      },
    }),
    chromeAdapter: adapter,
    capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    checkpointStore: Object.freeze({ async writeSanitized() {} }),
    onProgress() {}, now: clock, signal: undefined, expectedExtensionId: TEST_EXTENSION_ID,
    auditRunner: runObservedTabAudit,
  });

  assert.equal(result.status, 'complete');
  assert.equal(result.ownershipState, 'removed');
  assert.equal(result.observedTarget.cleanupMode, 'always');
  assert.deepEqual(createRequests, [{ url: 'about:blank', active: false, windowId: 9 }]);
  const ownerKey = Object.keys(sessionValues).find(key => key.startsWith('audita:owned-tab:v2:'));
  assert.equal(sessionValues[ownerKey].state, 'removed');
  assert.equal(Object.hasOwn(result.observedTarget, 'navigationToken'), false);
  assert.equal(result.model.session.status, 'complete');
  assert.equal(result.model.session.diagnostics.filter(entry =>
    entry.code === 'ATTACHED_COPY_RELOADED' && entry.message === ATTACHED_COPY_RELOADED_MESSAGE).length, 1);
  assert.equal(result.model.pages[0].diagnostics.filter(entry =>
    entry.code === 'ATTACHED_COPY_RELOADED' && entry.message === ATTACHED_COPY_RELOADED_MESSAGE).length, 1);
  assert.deepEqual(result.model.limitations.filter(value => value === ATTACHED_COPY_RELOADED_MESSAGE), [
    ATTACHED_COPY_RELOADED_MESSAGE,
  ]);
  assert.doesNotMatch(JSON.stringify({ result, sessionValues }), /secret=REMOVE/u);
});

test('single URL creates its blank tab in the authorized window and never releases the raw URL on a cross-window result', async () => {
  const sessionValues = {};
  const adapter = fakeAdapter({ noPixels: true, canonicalInternals: true, sessionValues });
  const createRequests = [];
  const removed = [];
  let tokenTakes = 0;
  adapter.createTab = async details => {
    createRequests.push(details);
    return { id: 77, windowId: 10 };
  };
  adapter.removeTab = async tabId => { removed.push(tabId); };

  const result = await runUrlAudit({
    auditId: 'audit-url-window-bound', ownershipId: `owner_${'W'.repeat(22)}`,
    windowId: 9, navigationToken: 'N'.repeat(22), navigationPurpose: 'single-url',
    evidenceUrl: TEST_EVIDENCE_URL, sessionDigest: TEST_DIGEST,
    rawNavigationVault: Object.freeze({
      async take() { tokenTakes += 1; return 'https://example.test/final?secret=REMOVE'; },
    }),
    chromeAdapter: adapter,
    capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    checkpointStore: Object.freeze({ async writeSanitized() {} }),
    onProgress() {}, now: clock, signal: undefined, expectedExtensionId: TEST_EXTENSION_ID,
    auditRunner: runObservedTabAudit,
  });

  assert.equal(result.status, 'failed');
  assert.deepEqual(createRequests, [{ url: 'about:blank', active: false, windowId: 9 }]);
  assert.deepEqual(removed, [77]);
  assert.equal(tokenTakes, 0);
  assert.equal(adapter.events.some(event => event.startsWith('navigate:')), false);
  assert.doesNotMatch(JSON.stringify({ result, sessionValues }), /secret=REMOVE|NNNNNNNNNNNNNNNNNNNNNN/u);
});

const clock = (() => {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 7, 26, 14, 0, tick++)).toISOString();
})();

test('enhanced contrast reports only AAA while minimum remains independently inconclusive', async () => {
  const page = rawPage();
  const channel = (1.055 * (((6.386 - 1) / 20) ** (1 / 2.4)) - 0.055) * 255;
  Object.assign(page.nodes[0], {
    styles: { color: '#000', 'background-color': `rgb(${channel}, ${channel}, ${channel})`,
      'font-size': '16px', 'font-weight': '400', opacity: '1', 'background-image': 'none' },
    contrastReliable: true,
  });
  const model = await runAudit({
    url: 'https://example.test/', chromeAdapter: fakeAdapter({ page, noPixels: true }),
    now: clock, idFactory: () => 'audit-enhanced-contrast',
  });
  const occurrence = model.occurrences.find(value => value.ruleId === 'text-contrast-enhanced');
  assert.equal(occurrence?.outcome, 'failed');
  assert.deepEqual(occurrence.itemWcagRefs, ['1.4.3', '1.4.6']);
  assert.deepEqual(occurrence.sourceWcagRefs, ['1.4.3', '1.4.6']);
  assert.deepEqual(occurrence.testedWcagRefs, ['1.4.6']);
  assert.deepEqual(occurrence.wcagRefs, ['1.4.6']);
  assert.deepEqual(occurrence.foreignBenchmarkRefs, []);
  assert.equal(model.itemResults.find(item => item.id === '5.11.3').outcome, 'cantTell');
  const report = await enrichAuditForReport(model, {
    now: () => '2026-08-26T16:00:00.000Z', timezone: 'America/Cuiaba',
    manifestVersion: '1.1.9', rulesVersion: '1.0.0', browserVersion: 'Chrome/147.0.0.0',
  });
  const exported = report.occurrences.find(value => value.ruleId === 'text-contrast-enhanced');
  assert.equal(exported.classification, 'recommendation');
  assert.deepEqual(exported.testedWcagRefs, ['1.4.6']);
  assert.equal(exported.outcome, 'failed');
  assert.equal(report.itemResults.find(item => item.id === '5.11.3').outcome, 'cantTell');
});

function legacyOccurrenceHash(value) {
  let hash = 0x811c9dc5;
  for (const character of value) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

test('keeps diagnostics and evidence correlated when two new findings have the same legacy hash ID', async () => {
  const auditId = 'audit-real-collision';
  const firstBackendId = 180154;
  const secondBackendId = 300601;
  const signature = (backendId, ordinal) => [
    auditId, '5.8.6', 'target-size-enhanced', `n-${backendId}`, ordinal,
  ].join('\u0000');
  assert.equal(legacyOccurrenceHash(signature(firstBackendId, 10)), legacyOccurrenceHash(signature(secondBackendId, 11)));

  const page = rawPage();
  page.nodes = [firstBackendId, secondBackendId].map((backendNodeId, index) => ({
    backendNodeId,
    tagName: 'button',
    attributes: {},
    text: `Alvo ${index + 1}`,
    parentBackendNodeId: null,
    rect: { x: index * 30, y: 0, width: 20, height: 20 },
  }));
  const model = await runAudit({
    url: 'https://example.test/',
    chromeAdapter: fakeAdapter({
      page,
      snippetFailureNode: firstBackendId,
      rawProbes: {
        focus: { completed: false, events: [] },
        targetSizes: [firstBackendId, secondBackendId].map(backendNodeId => ({
          nodeId: `n-${backendNodeId}`, width: 20, height: 20,
          exception: 'none', exceptionProof: 'complete',
        })),
        warnings: [], actions: [],
      },
    }),
    now: clock,
    idFactory: () => auditId,
  });

  const occurrences = model.occurrences.filter(value => value.ruleId === 'target-size-enhanced');
  assert.equal(occurrences.length, 2);
  assert.equal(new Set(occurrences.map(value => value.occurrenceId)).size, 2);
  const first = occurrences.find(value => value.nodeId === `n-${firstBackendId}`);
  const second = occurrences.find(value => value.nodeId === `n-${secondBackendId}`);
  const diagnostic = model.session.diagnostics.find(value => value.code === 'SNIPPET_CAPTURE_FAILED');
  assert.equal(diagnostic.details.occurrenceId, first.occurrenceId);
  assert.notEqual(diagnostic.details.occurrenceId, second.occurrenceId);
  for (const occurrence of occurrences) {
    const elementEvidence = model.evidence.artifacts.find(value => value.nodeId === occurrence.nodeId);
    assert.ok(elementEvidence);
    assert.ok(occurrence.evidenceIds.includes(elementEvidence.evidenceId));
  }
});

test('runs the 130→146 pipeline through the canonical no-pixels boundary before collection, probes and rules', async () => {
  const adapter = fakeAdapter();
  const model = await runAudit({
    url: ' example.test/start?password=REMOVE&view=public ', chromeAdapter: adapter,
    now: clock, idFactory: () => 'audit-1', closeAuditTab: true,
  });
  assert.equal(model.auditId, 'audit-1');
  assert.equal(model.ruleResults.length, 131);
  assert.equal(model.methodology.coreRuleCount, 130);
  assert.equal(model.methodology.supplementalRuleCount, 1);
  assert.equal(model.ruleResults.find(rule => rule.ruleId === 'editorial.placeholder-text').outcome, 'inapplicable');
  assert.equal(model.itemResults.length, 146);
  assert.equal(model.session.status, 'complete');
  assert.equal(model.axe.status, 'disabled');
  assert.ok(model.limitations.some(value => /axe-core|MV3|CSP/i.test(value)));
  assert.ok(model.session.diagnostics.some(value => value.code === 'AXE_FEATURE_DISABLED'));
  assert.ok(model.session.diagnostics.some(value => value.code === 'PIXEL_CAPTURE_OMITTED'));
  assert.equal(model.requestedUrl, 'https://example.test/start');
  assert.equal(model.finalUrl, 'https://example.test/final');
  assert.equal(adapter.events.includes('full-page'), false);
  assert.ok(adapter.events.indexOf('axe') < adapter.events.indexOf('collect'));
  assert.ok(adapter.events.indexOf('axe') < adapter.events.indexOf('probes'));
  assert.equal(adapter.counts.screenshots, 0);
  assert.equal(adapter.counts.disconnects, 1);
  assert.equal(adapter.counts.removals, 1);
  assert.equal(model.evidence.artifacts.filter(item => item.kind === 'full-page').length, 0);
  assert.ok(model.evidence.artifacts.every(item => /^[a-f0-9]{64}$/u.test(item.hash)));
  for (const key of ['snapshotHash', 'ruleResultsHash', 'evidenceHash']) {
    assert.match(model.reproducibility[key], /^[a-f0-9]{64}$/u, key);
  }
  assert.equal(model.evidence.artifacts.filter(item => item.nodeId === 'n-1').length, 1);
  assert.equal(Object.hasOwn(model.evidence.artifacts.find(item => item.nodeId === 'n-1'), 'dataUrl'), false);
  assert.ok(model.occurrences.length > 0);
  assert.deepEqual(model.occurrences.map(value => value.occurrenceId), model.occurrences.map((_value, index) =>
    `occurrence-page-1-${String(index + 1).padStart(6, '0')}`));
  for (const occurrence of model.occurrences) {
    assert.ok(['failed', 'cantTell'].includes(occurrence.outcome));
    assert.ok(occurrence.evidenceIds.length > 0 || occurrence.justification);
    if (occurrence.nodeId) {
      const elementEvidence = model.evidence.artifacts.find(item => item.nodeId === occurrence.nodeId);
      assert.ok(elementEvidence);
      assert.ok(occurrence.evidenceIds.includes(elementEvidence.evidenceId));
    }
  }
  for (const item of model.itemResults.filter(value => value.outcome === 'cantTell' && ['manual', 'assisted'].includes(value.evaluation))) {
    assert.ok(model.occurrences.some(occurrence => occurrence.itemId === item.id));
  }
  const percents = model.progress.map(entry => entry.percent);
  assert.deepEqual(percents, [...percents].sort((a, b) => a - b));
  assert.deepEqual(model.progress.map(entry => entry.message), [
    'Abrindo o site', 'Lendo a estrutura', 'Verificando acessibilidade',
    'Preparando evidências', 'Gerando relatório', 'Auditoria concluída',
  ]);
  assert.equal(Object.isFrozen(model), true);
  assert.equal(Object.isFrozen(model.occurrences), true);
  assert.doesNotThrow(() => JSON.stringify(model));
  assert.doesNotMatch(JSON.stringify(model), /REMOVE|SECRET|user:pass|password=/i);
});

test('public compatibility path defaults to an owned proof boundary and performs no pixel operation without consent', async () => {
  const sessionValues = {};
  const adapter = fakeAdapter({ noPixels: true, sessionValues });
  const model = await runAudit({
    url: 'https://example.test/?secret=ERASE', chromeAdapter: adapter,
    now: clock, idFactory: () => 'audit-owned-no-pixels',
  });
  assert.equal(adapter.counts.screenshots, 0);
  assert.ok(adapter.events.indexOf('create-tab') < adapter.events.findIndex(value => value.startsWith('navigate:')));
  assert.ok(adapter.events.findIndex(value => value.startsWith('navigate:')) < adapter.events.findIndex(value => value.startsWith('remove-tab:')));
  const ownedRecords = Object.values(sessionValues).filter(value => value?.version === 2 && value?.purpose === 'audit');
  assert.equal(ownedRecords.length, 1);
  assert.equal(ownedRecords[0].auditId, model.auditId);
  assert.equal(ownedRecords[0].state, 'removed');
  assert.equal(Object.hasOwn(model, 'checkpoint'), false);
  assert.doesNotMatch(JSON.stringify(model), /owner-|navigationToken|urlSessionDigest|ERASE/u);
});

test('public compatibility path rejects an adapter without canonical authority before any browser effect', async () => {
  const base = fakeAdapter({ trackCaptureCalls: true });
  const adapter = { ...base };

  await assert.rejects(runAudit({
    url: 'https://example.test/?secret=ERASE', chromeAdapter: adapter,
    now: clock, idFactory: () => 'audit-public-without-authority',
  }), /AUDIT_EXECUTION_DENIED/u);

  assert.deepEqual(base.events, []);
  assert.equal(base.counts.screenshots, 0);
  assert.equal(base.counts.removals, 0);
});

test('public compatibility path cannot activate a legacy pixel policy without the canonical no-pixels boundary', async () => {
  const base = fakeAdapter({ trackCaptureCalls: true });
  const sessionValues = {};
  const adapter = { ...base };
  Object.defineProperty(adapter, AUDIT_EXECUTION_INTERNAL, {
    value: Object.freeze({
      sessionArea: {
        async get(key) { return Object.hasOwn(sessionValues, key) ? { [key]: structuredClone(sessionValues[key]) } : {}; },
        async set(entries) { Object.assign(sessionValues, structuredClone(entries)); },
        async remove(key) { delete sessionValues[key]; },
      },
      randomBytes(length) { return new Uint8Array(length).fill(7); },
      capturePolicy: createCapturePolicyV1({ mode: 'full-evidence', includeQuery: false }),
    }),
  });

  const model = await runAudit({
    url: 'https://example.test/', chromeAdapter: adapter,
    now: clock, idFactory: () => 'audit-public-pixel-policy-denied',
  });

  assert.equal(model.auditId, 'audit-public-pixel-policy-denied');
  assert.equal(base.counts.screenshots, 0);
  assert.equal(base.counts.fullPageCalls, 0);
  assert.equal(base.counts.elementCalls, 0);
  assert.equal(Object.values(sessionValues).some(value => value?.version === 2 && value?.state === 'removed'), true);
});

test('attached execution uses no owned-tab or URL-vault effects and returns the closed terminal union', async () => {
  const adapter = fakeAdapter({ noPixels: true });
  const persisted = [];
  const checkpoints = [];
  const result = await runAttachedAuditExecution({
    auditId: 'audit-attached-1',
    sessionCapabilityId: 'S'.repeat(22),
    target: {
      kind: 'attached', tabId: 42, windowId: 9, documentId: 'document-a',
      initialUrlEvidence: 'https://example.test/',
      initialUrlSessionDigest: `hmac-sha256:${'A'.repeat(43)}`,
    },
    capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    chromeAdapter: adapter,
    modelNow: clock,
    expectedExtensionId: TEST_EXTENSION_ID,
    onCheckpoint: async checkpoint => { checkpoints.push(checkpoint); },
    persistAuditModel: async model => { persisted.push(model); },
  });

  assert.deepEqual(Object.keys(result), ['version', 'auditId', 'state', 'failureCode', 'model', 'checkpoint']);
  assert.equal(result.version, 1);
  assert.equal(result.auditId, 'audit-attached-1');
  assert.equal(result.state, 'model');
  assert.equal(result.failureCode, null);
  assert.ok(['complete', 'partial'].includes(result.model.session.status));
  assert.equal(result.checkpoint.auditId, 'audit-attached-1');
  assert.equal(result.checkpoint.pages[0].startedAt, result.model.pages[0].timestamps.startedAt);
  assert.equal(persisted.length, 1);
  assert.ok(checkpoints.length > 0);
  assert.equal(adapter.events.includes('create-tab'), false);
  assert.equal(adapter.events.some(value => value.startsWith('navigate:')), false);
  assert.equal(adapter.events.some(value => value.startsWith('remove-tab:')), false);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.checkpoint), true);
});

test('attached full-evidence derives one map from the authorized pristine source after element capture', async () => {
  const auditId = 'audit-attached-pixels';
  const policy = createCapturePolicyV1({ mode: 'full-evidence', includeQuery: false });
  const gateCalls = [];
  const adapter = fakeAdapter({
    trackCaptureCalls: true,
    composeMap: async input => createAnnotationMapFixture({ sourceEvidenceId: input.fullPageEvidence.evidenceId }),
  });
  let proof = 0;
  adapter.probeDocumentIdentity = async tabId => {
    proof += 1; adapter.events.push(`proof-${proof}`);
    return { tabId, windowId: 9, documentId: 'document-a', urlSessionDigest: TEST_DIGEST };
  };
  const result = await runAttachedAuditExecution({
    auditId, sessionCapabilityId: 'S'.repeat(22),
    target: { kind: 'attached', tabId: 42, windowId: 9, documentId: 'document-a', initialUrlEvidence: TEST_EVIDENCE_URL, initialUrlSessionDigest: TEST_DIGEST },
    capturePolicy: policy, privacyGate: attachedPixelGate(policy, gateCalls, { auditId }),
    chromeAdapter: adapter, modelNow: clock, expectedExtensionId: TEST_EXTENSION_ID,
    onCheckpoint: async () => {}, persistAuditModel: async () => {},
  });
  assert.equal(result.state, 'model');
  assert.equal(result.model.session.status, 'complete');
  assert.equal(adapter.counts.fullPageCalls, 1);
  assert.equal(adapter.events.filter(event => event === 'map').length, 1);
  const map = result.model.evidence.find(artifact => artifact.kind === 'announcement-map');
  const original = result.model.evidence.find(artifact => artifact.kind === 'full-page');
  assert.equal(map?.derivation.sourceHash, original.hash);
  assert.equal(map?.fullPageEvidenceId, original.evidenceId);
  assert.ok(adapter.counts.elementCalls > 0);
  assert.ok(adapter.events.indexOf('map') > adapter.events.findLastIndex(event => event.startsWith('thumbnail:')));
  const raster = adapter.events.indexOf('full-page');
  assert.deepEqual(adapter.events.slice(raster - 3, raster), ['proof-2', 'sensitive-probe', 'proof-3']);
  assert.deepEqual(gateCalls, ['after']);
});

test('navigation during map composition denies the terminal commit and exposes no derived model', async () => {
  const auditId = 'audit-map-document-changed';
  const policy = createCapturePolicyV1({ mode: 'full-evidence', includeQuery: false });
  let documentId = 'document-a';
  let persisted = 0;
  const adapter = fakeAdapter({ trackCaptureCalls: true, composeMap: async input => {
    documentId = 'document-b';
    return createAnnotationMapFixture({ sourceEvidenceId: input.fullPageEvidence.evidenceId });
  } });
  adapter.probeDocumentIdentity = async tabId => ({ tabId, windowId: 9, documentId, urlSessionDigest: TEST_DIGEST });
  const result = await runAttachedAuditExecution({
    auditId, sessionCapabilityId: 'S'.repeat(22),
    target: { kind: 'attached', tabId: 42, windowId: 9, documentId: 'document-a', initialUrlEvidence: TEST_EVIDENCE_URL, initialUrlSessionDigest: TEST_DIGEST },
    capturePolicy: policy, privacyGate: attachedPixelGate(policy, [], { auditId }),
    chromeAdapter: adapter, modelNow: clock, expectedExtensionId: TEST_EXTENSION_ID,
    onCheckpoint: async () => {}, persistAuditModel: async () => { persisted += 1; },
  });
  assert.equal(adapter.events.filter(event => event === 'map').length, 1);
  assert.equal(persisted, 0);
  assert.equal(result.model, null);
  assert.equal(result.failureCode, 'TARGET_CHANGED');
});

test('a rejected map preserves the pristine capture and records an explicit derivation failure', async () => {
  for (const corrupt of ['source-id', 'page-id', 'source-hash', 'geometry-hash', 'segment-hash']) {
    const auditId = `audit-map-rejected-${corrupt}`;
    const policy = createCapturePolicyV1({ mode: 'full-evidence', includeQuery: false });
    const adapter = fakeAdapter({ trackCaptureCalls: true, composeMap: async input => {
      const map = await createAnnotationMapFixture({ sourceEvidenceId: input.fullPageEvidence.evidenceId });
      if (corrupt === 'source-id') map.fullPageEvidenceId = 'foreign-source';
      if (corrupt === 'page-id') map.pageId = 'foreign-page';
      if (corrupt === 'source-hash') map.derivation.sourceHash = 'e'.repeat(64);
      if (corrupt === 'geometry-hash') map.derivation.geometrySnapshotHash = 'e'.repeat(64);
      if (corrupt === 'segment-hash') map.segments[0].contentHash = 'e'.repeat(64);
      return map;
    } });
    const result = await runAttachedAuditExecution({
      auditId, sessionCapabilityId: 'S'.repeat(22),
      target: { kind: 'attached', tabId: 42, windowId: 9, documentId: 'document-a', initialUrlEvidence: TEST_EVIDENCE_URL, initialUrlSessionDigest: TEST_DIGEST },
      capturePolicy: policy, privacyGate: attachedPixelGate(policy, [], { auditId }),
      chromeAdapter: adapter, modelNow: clock, expectedExtensionId: TEST_EXTENSION_ID,
      onCheckpoint: async () => {}, persistAuditModel: async () => {},
    });
    assert.equal(adapter.events.filter(event => event === 'map').length, 1, corrupt);
    assert.equal(result.state, 'model', corrupt);
    assert.equal(result.model.evidence.some(artifact => artifact.kind === 'full-page' && artifact.state === 'pristine'), true, corrupt);
    assert.equal(result.model.evidence.some(artifact => artifact.kind === 'announcement-map'), false, corrupt);
    assert.ok(result.model.session.diagnostics.some(diagnostic => diagnostic.code === 'ANNOTATION_MAP_OUTPUT_INVALID'), corrupt);
  }
});

test('attached full-evidence denies every thumbnail after the observed document changes following the full-page raster', async () => {
  const auditId = 'audit-attached-raster-drift';
  const policy = createCapturePolicyV1({ mode: 'full-evidence', includeQuery: false });
  const gateCalls = [];
  let documentId = 'document-a';
  const adapter = fakeAdapter({
    trackCaptureCalls: true,
    async afterFullPage() { documentId = 'document-b'; },
    composeMap: async input => createAnnotationMapFixture({ sourceEvidenceId: input.fullPageEvidence.evidenceId }),
  });
  adapter.probeDocumentIdentity = async tabId => ({
    tabId, windowId: 9, documentId, urlSessionDigest: TEST_DIGEST,
  });

  const result = await runAttachedAuditExecution({
    auditId, sessionCapabilityId: 'S'.repeat(22),
    target: { kind: 'attached', tabId: 42, windowId: 9, documentId: 'document-a', initialUrlEvidence: TEST_EVIDENCE_URL, initialUrlSessionDigest: TEST_DIGEST },
    capturePolicy: policy, privacyGate: attachedPixelGate(policy, gateCalls, { auditId }),
    chromeAdapter: adapter, modelNow: clock, expectedExtensionId: TEST_EXTENSION_ID,
    onCheckpoint: async () => {}, persistAuditModel: async () => { throw new Error('must-not-persist'); },
  });

  assert.equal(result.state, 'revoked');
  assert.equal(result.failureCode, 'TARGET_CHANGED');
  assert.equal(adapter.counts.fullPageCalls, 1);
  assert.equal(adapter.counts.elementCalls, 0);
  assert.equal(adapter.counts.screenshots, 1, 'no raster from document B may start');
});

test('attached full-evidence re-proves the same document before every raster without consuming consent again', async () => {
  const auditId = 'audit-attached-each-raster-proof';
  const consentId = 'A'.repeat(21) + 'Q';
  const policy = createCapturePolicyV1({ mode: 'full-evidence', includeQuery: false });
  const gateCalls = [];
  let proofCount = 0;
  const adapter = fakeAdapter({
    trackCaptureCalls: true,
    sensitiveSignals: PASSWORD_SIGNALS,
    composeMap: async input => createAnnotationMapFixture({ sourceEvidenceId: input.fullPageEvidence.evidenceId }),
  });
  adapter.probeDocumentIdentity = async tabId => {
    proofCount += 1;
    adapter.events.push(`proof-${proofCount}`);
    return { tabId, windowId: 9, documentId: 'document-a', urlSessionDigest: TEST_DIGEST };
  };

  const result = await runAttachedAuditExecution({
    auditId, sessionCapabilityId: 'S'.repeat(22),
    target: { kind: 'attached', tabId: 42, windowId: 9, documentId: 'document-a', initialUrlEvidence: TEST_EVIDENCE_URL, initialUrlSessionDigest: TEST_DIGEST },
    capturePolicy: policy,
    privacyGate: attachedPixelGate(policy, gateCalls, { auditId, consentId }),
    chromeAdapter: adapter, modelNow: clock, expectedExtensionId: TEST_EXTENSION_ID,
    onCheckpoint: async () => {}, persistAuditModel: async () => {},
  });

  assert.equal(result.state, 'model');
  assert.equal(adapter.counts.fullPageCalls, 1);
  assert.equal(adapter.counts.elementCalls > 0, true);
  const rasterIndexes = adapter.events
    .map((value, index) => /^(?:full-page|thumbnail:)/u.test(value) ? index : -1)
    .filter(index => index >= 0);
  assert.equal(rasterIndexes.length, adapter.counts.screenshots);
  for (const index of rasterIndexes) assert.match(adapter.events[index - 1], /^proof-\d+$/u);
  assert.deepEqual(gateCalls, ['gate', 'after'], 'one-shot consent is gated once even across multiple rasters');
});

test('attached full-evidence keeps a partial report while refusing every later raster after sensitive content expands', async () => {
  const auditId = 'audit-attached-sensitive-expansion';
  const consentId = 'A'.repeat(21) + 'Q';
  const policy = createCapturePolicyV1({ mode: 'full-evidence', includeQuery: false });
  const gateCalls = [];
  let sensitiveReads = 0;
  let persisted = 0;
  const adapter = fakeAdapter({
    trackCaptureCalls: true,
    sensitiveSignals: PASSWORD_SIGNALS,
    composeMap: async input => createAnnotationMapFixture({ sourceEvidenceId: input.fullPageEvidence.evidenceId }),
  });
  adapter.probeSensitiveCaptureSignals = async () => {
    sensitiveReads += 1;
    adapter.events.push(`sensitive-probe-${sensitiveReads}`);
    return sensitiveReads < 4 ? PASSWORD_SIGNALS : PASSWORD_PAYMENT_SIGNALS;
  };

  const result = await runAttachedAuditExecution({
    auditId, sessionCapabilityId: 'S'.repeat(22),
    target: {
      kind: 'attached', tabId: 42, windowId: 9, documentId: 'document-a',
      initialUrlEvidence: TEST_EVIDENCE_URL, initialUrlSessionDigest: TEST_DIGEST,
    },
    capturePolicy: policy,
    privacyGate: attachedPixelGate(policy, gateCalls, { auditId, consentId }),
    chromeAdapter: adapter, modelNow: clock, expectedExtensionId: TEST_EXTENSION_ID,
    onCheckpoint: async () => {}, persistAuditModel: async () => { persisted += 1; },
  });

  assert.equal(result.state, 'model');
  assert.equal(result.failureCode, null);
  assert.equal(result.model.session.status, 'partial');
  assert.equal(persisted, 1);
  assert.equal(adapter.counts.fullPageCalls, 1);
  assert.equal(adapter.counts.elementCalls, 0);
  assert.equal(adapter.counts.screenshots, 1, 'newly sensitive content must never reach a later raster');
  assert.equal(result.model.session.diagnostics.some(entry => entry.code === 'ELEMENT_CAPTURE_FAILED'), true);
  assert.deepEqual(gateCalls, ['gate', 'after']);
});

test('attached full-evidence falls back to a pixel-free partial report when sensitive content expands before the first raster', async () => {
  const auditId = 'audit-attached-sensitive-expansion-before-first-raster';
  const consentId = 'A'.repeat(21) + 'Q';
  const policy = createCapturePolicyV1({ mode: 'full-evidence', includeQuery: false });
  const gateCalls = [];
  let sensitiveReads = 0;
  let persisted = 0;
  const adapter = fakeAdapter({
    trackCaptureCalls: true,
    sensitiveSignals: PASSWORD_SIGNALS,
    composeMap: async input => createAnnotationMapFixture({ sourceEvidenceId: input.fullPageEvidence.evidenceId }),
  });
  adapter.probeSensitiveCaptureSignals = async () => {
    sensitiveReads += 1;
    adapter.events.push(`sensitive-probe-${sensitiveReads}`);
    return sensitiveReads < 3 ? PASSWORD_SIGNALS : PASSWORD_PAYMENT_SIGNALS;
  };

  const result = await runAttachedAuditExecution({
    auditId, sessionCapabilityId: 'S'.repeat(22),
    target: {
      kind: 'attached', tabId: 42, windowId: 9, documentId: 'document-a',
      initialUrlEvidence: TEST_EVIDENCE_URL, initialUrlSessionDigest: TEST_DIGEST,
    },
    capturePolicy: policy,
    privacyGate: attachedPixelGate(policy, gateCalls, { auditId, consentId }),
    chromeAdapter: adapter, modelNow: clock, expectedExtensionId: TEST_EXTENSION_ID,
    onCheckpoint: async () => {}, persistAuditModel: async () => { persisted += 1; },
  });

  assert.equal(result.state, 'model');
  assert.equal(result.failureCode, null);
  assert.equal(result.model.session.status, 'partial');
  assert.equal(persisted, 1);
  assert.equal(adapter.counts.screenshots, 0);
  assert.equal(adapter.counts.fullPageCalls, 0);
  assert.equal(adapter.counts.elementCalls, 0);
  assert.equal(result.model.session.diagnostics.some(entry => entry.code === 'FULL_PAGE_CAPTURE_FAILED'), true);
  assert.equal(result.model.session.diagnostics.some(entry => entry.code === 'ELEMENT_CAPTURE_SKIPPED_NO_FULL_PAGE'), true);
  assert.deepEqual(gateCalls, ['gate', 'after']);
});

test('attached element-only keeps a pixel-free partial report when sensitive content expands before the first thumbnail', async () => {
  const auditId = 'audit-attached-element-sensitive-expansion';
  const consentId = 'A'.repeat(21) + 'Q';
  const policy = createCapturePolicyV1({ mode: 'element-only', includeQuery: false });
  const gateCalls = [];
  let sensitiveReads = 0;
  let persisted = 0;
  const adapter = fakeAdapter({ trackCaptureCalls: true, sensitiveSignals: PASSWORD_SIGNALS });
  adapter.probeSensitiveCaptureSignals = async () => {
    sensitiveReads += 1;
    adapter.events.push(`sensitive-probe-${sensitiveReads}`);
    return sensitiveReads < 3 ? PASSWORD_SIGNALS : PASSWORD_PAYMENT_SIGNALS;
  };

  const result = await runAttachedAuditExecution({
    auditId, sessionCapabilityId: 'S'.repeat(22),
    target: {
      kind: 'attached', tabId: 42, windowId: 9, documentId: 'document-a',
      initialUrlEvidence: TEST_EVIDENCE_URL, initialUrlSessionDigest: TEST_DIGEST,
    },
    capturePolicy: policy,
    privacyGate: attachedPixelGate(policy, gateCalls, { auditId, consentId }),
    chromeAdapter: adapter, modelNow: clock, expectedExtensionId: TEST_EXTENSION_ID,
    onCheckpoint: async () => {}, persistAuditModel: async () => { persisted += 1; },
  });

  assert.equal(result.state, 'model');
  assert.equal(result.failureCode, null);
  assert.equal(result.model.session.status, 'partial');
  assert.equal(persisted, 1);
  assert.equal(adapter.counts.screenshots, 0);
  assert.equal(adapter.counts.fullPageCalls, 0);
  assert.equal(adapter.counts.elementCalls, 0);
  assert.equal(result.model.session.diagnostics.some(entry => entry.code === 'ELEMENT_CAPTURE_FAILED'), true);
  assert.deepEqual(gateCalls, ['gate', 'after']);
});

test('attached full-evidence abort immediately before a later raster starts no later raster effect', async () => {
  const auditId = 'audit-attached-later-raster-abort';
  const consentId = 'A'.repeat(21) + 'Q';
  const policy = createCapturePolicyV1({ mode: 'full-evidence', includeQuery: false });
  const controller = new AbortController();
  const gateCalls = [];
  let proofCount = 0;
  const adapter = fakeAdapter({
    trackCaptureCalls: true,
    sensitiveSignals: PASSWORD_SIGNALS,
    composeMap: async input => createAnnotationMapFixture({ sourceEvidenceId: input.fullPageEvidence.evidenceId }),
  });
  adapter.probeDocumentIdentity = async tabId => {
    proofCount += 1;
    if (proofCount === 4) controller.abort(new DOMException('PRIVATE_LATER_RASTER_ABORT', 'AbortError'));
    return { tabId, windowId: 9, documentId: 'document-a', urlSessionDigest: TEST_DIGEST };
  };

  const result = await runAttachedAuditExecution({
    auditId, sessionCapabilityId: 'S'.repeat(22),
    target: { kind: 'attached', tabId: 42, windowId: 9, documentId: 'document-a', initialUrlEvidence: TEST_EVIDENCE_URL, initialUrlSessionDigest: TEST_DIGEST },
    capturePolicy: policy,
    privacyGate: attachedPixelGate(policy, gateCalls, { auditId, consentId }),
    chromeAdapter: adapter, modelNow: clock, signal: controller.signal, expectedExtensionId: TEST_EXTENSION_ID,
    onCheckpoint: async () => {}, persistAuditModel: async () => {},
  });

  assert.equal(adapter.counts.fullPageCalls, 1);
  assert.equal(adapter.counts.elementCalls, 0);
  assert.equal(adapter.counts.screenshots, 1);
  assert.equal(result.state, 'revoked');
  assert.equal(result.failureCode, 'AUDIT_FAILED');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_LATER_RASTER_ABORT/u);
});

test('attached element-only omits full page and map without a false operational failure', async () => {
  const auditId = 'audit-attached-elements';
  const policy = createCapturePolicyV1({ mode: 'element-only', includeQuery: false });
  const gateCalls = [];
  let persisted = 0;
  const adapter = fakeAdapter({
    trackCaptureCalls: true,
    composeMap: async input => createAnnotationMapFixture({ sourceEvidenceId: input.fullPageEvidence.evidenceId }),
  });
  const result = await runAttachedAuditExecution({
    auditId, sessionCapabilityId: 'S'.repeat(22),
    target: { kind: 'attached', tabId: 42, windowId: 9, documentId: 'document-a', initialUrlEvidence: TEST_EVIDENCE_URL, initialUrlSessionDigest: TEST_DIGEST },
    capturePolicy: policy, privacyGate: attachedPixelGate(policy, gateCalls, { auditId }),
    chromeAdapter: adapter, modelNow: clock, expectedExtensionId: TEST_EXTENSION_ID,
    onCheckpoint: async () => {}, persistAuditModel: async () => { persisted += 1; },
  });
  assert.equal(result.state, 'model');
  assert.equal(persisted, 1);
  assert.equal(adapter.counts.fullPageCalls, 0);
  assert.equal(adapter.events.includes('map'), false);
  assert.equal(result.model.session.diagnostics.some(entry => entry.code === 'FULL_PAGE_CAPTURE_FAILED'), false);
  assert.deepEqual(gateCalls, ['after']);
});

test('attached sensitive preflight pauses with a durable checkpoint and zero raster or cleanup', async () => {
  const auditId = 'audit-attached-sensitive';
  const policy = createCapturePolicyV1({ mode: 'full-evidence', includeQuery: false });
  const gateCalls = [];
  const adapter = fakeAdapter({ trackCaptureCalls: true, sensitiveSignals: PASSWORD_SIGNALS,
    composeMap: async input => createAnnotationMapFixture({ sourceEvidenceId: input.fullPageEvidence.evidenceId }),
  });
  const result = await runAttachedAuditExecution({
    auditId, sessionCapabilityId: 'S'.repeat(22),
    target: { kind: 'attached', tabId: 42, windowId: 9, documentId: 'document-a', initialUrlEvidence: TEST_EVIDENCE_URL, initialUrlSessionDigest: TEST_DIGEST },
    capturePolicy: policy, privacyGate: attachedPixelGate(policy, gateCalls, { auditId }),
    chromeAdapter: adapter, modelNow: clock, expectedExtensionId: TEST_EXTENSION_ID,
    onCheckpoint: async () => {}, persistAuditModel: async () => { throw new Error('must-not-persist'); },
  });
  assert.deepEqual(Object.keys(result), ['version', 'auditId', 'state', 'failureCode', 'model', 'checkpoint']);
  assert.equal(result.state, 'privacy-paused');
  assert.equal(result.checkpoint.auditId, auditId);
  assert.equal(adapter.counts.screenshots, 0);
  assert.equal(adapter.events.includes('map'), false);
  assert.deepEqual(gateCalls, ['pause']);
});

test('the attached map compositor stays dormant without an authorized pristine capture', async () => {
  for (const mode of ['no-pixels', 'full-evidence']) {
    const auditId = `audit-map-no-source-${mode}`;
    const policy = createCapturePolicyV1({ mode, includeQuery: false });
    const adapter = fakeAdapter({ trackCaptureCalls: true, fullPageFailure: new Error('PRIVATE_CAPTURE_FAILURE'),
      composeMap: async input => createAnnotationMapFixture({ sourceEvidenceId: input.fullPageEvidence.evidenceId }),
    });
    const result = await runAttachedAuditExecution({
      auditId, sessionCapabilityId: 'S'.repeat(22),
      target: { kind: 'attached', tabId: 42, windowId: 9, documentId: 'document-a', initialUrlEvidence: TEST_EVIDENCE_URL, initialUrlSessionDigest: TEST_DIGEST },
      capturePolicy: policy,
      privacyGate: mode === 'no-pixels' ? undefined : attachedPixelGate(policy, [], { auditId }),
      chromeAdapter: adapter, modelNow: clock, expectedExtensionId: TEST_EXTENSION_ID,
      onCheckpoint: async () => {}, persistAuditModel: async () => {},
    });
    assert.equal(result.state, 'model', mode);
    assert.equal(adapter.events.includes('map'), false, mode);
    assert.equal(result.model.evidence.some(artifact => ['full-page', 'announcement-map'].includes(artifact.kind)), false, mode);
    assert.equal(result.model.session.diagnostics.some(entry => entry.code.startsWith('ANNOTATION_MAP_')), false, mode);
    if (mode === 'no-pixels') assert.equal(adapter.counts.screenshots, 0);
    else assert.ok(result.model.session.diagnostics.some(entry => entry.code === 'FULL_PAGE_CAPTURE_FAILED'));
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_CAPTURE_FAILURE/u);
  }
});

test('attached privacy resume preserves the original empty checkpoint when the model clock advances', async () => {
  const auditId = 'audit-attached-resume-checkpoint';
  const policy = createCapturePolicyV1({ mode: 'full-evidence', includeQuery: false });
  const adapter = fakeAdapter({
    trackCaptureCalls: true,
    sensitiveSignals: PASSWORD_SIGNALS,
    composeMap: async input => createAnnotationMapFixture({ sourceEvidenceId: input.fullPageEvidence.evidenceId }),
  });
  const target = {
    kind: 'attached', tabId: 42, windowId: 9, documentId: 'document-a',
    initialUrlEvidence: TEST_EVIDENCE_URL, initialUrlSessionDigest: TEST_DIGEST,
  };
  const paused = await runAttachedAuditExecution({
    auditId, sessionCapabilityId: 'S'.repeat(22), target, capturePolicy: policy,
    privacyGate: attachedPixelGate(policy, [], { auditId }),
    chromeAdapter: adapter, modelNow: () => '2026-08-29T10:00:00.000Z',
    expectedExtensionId: TEST_EXTENSION_ID,
    onCheckpoint: async () => {}, persistAuditModel: async () => { throw new Error('must-not-persist'); },
  });
  assert.equal(paused.state, 'privacy-paused');
  assert.deepEqual(paused.checkpoint.pages[0].outcomes, []);
  assert.equal(paused.checkpoint.pages[0].startedAt, '2026-08-29T10:00:00.000Z');
  assert.equal(adapter.counts.screenshots, 0);

  const resumedCheckpoints = [];
  const resumed = await runAttachedAuditExecution({
    auditId, sessionCapabilityId: 'S'.repeat(22), target, capturePolicy: policy,
    privacyGate: attachedPixelGate(policy, [], { auditId, consentId: 'A'.repeat(21) + 'Q' }),
    resumeCheckpoint: paused.checkpoint,
    chromeAdapter: adapter, modelNow: () => '2026-08-29T10:05:00.000Z',
    expectedExtensionId: TEST_EXTENSION_ID,
    onCheckpoint: async checkpoint => { resumedCheckpoints.push(checkpoint); },
    persistAuditModel: async () => {},
  });

  assert.equal(resumed.state, 'model');
  assert.deepEqual(resumedCheckpoints[0], paused.checkpoint);
  assert.equal(resumed.checkpoint.pages[0].startedAt, '2026-08-29T10:00:00.000Z');
  assert.equal(resumed.model.pages[0].timestamps.startedAt, '2026-08-29T10:00:00.000Z');
  assert.equal(adapter.counts.screenshots > 0, true);
});

test('attached privacy resume rejects impossible or hostile checkpoints before browser effects without echo', async () => {
  const auditId = 'audit-attached-resume-denied';
  const policy = createCapturePolicyV1({ mode: 'full-evidence', includeQuery: false });
  const adapter = fakeAdapter({
    trackCaptureCalls: true,
    sensitiveSignals: PASSWORD_SIGNALS,
    composeMap: async input => createAnnotationMapFixture({ sourceEvidenceId: input.fullPageEvidence.evidenceId }),
  });
  const target = {
    kind: 'attached', tabId: 42, windowId: 9, documentId: 'document-a',
    initialUrlEvidence: TEST_EVIDENCE_URL, initialUrlSessionDigest: TEST_DIGEST,
  };
  const paused = await runAttachedAuditExecution({
    auditId, sessionCapabilityId: 'S'.repeat(22), target, capturePolicy: policy,
    privacyGate: attachedPixelGate(policy, [], { auditId }),
    chromeAdapter: adapter, modelNow: () => '2026-08-29T10:00:00.000Z',
    expectedExtensionId: TEST_EXTENSION_ID,
    onCheckpoint: async () => {}, persistAuditModel: async () => { throw new Error('must-not-persist'); },
  });
  assert.equal(paused.state, 'privacy-paused');

  const changed = mutate => {
    const value = structuredClone(paused.checkpoint);
    mutate(value);
    return value;
  };
  const marker = 'PRIVATE_RESUME_CHECKPOINT_MARKER';
  let getterCalls = 0;
  const accessor = { version: 1, auditId };
  Object.defineProperty(accessor, 'pages', {
    enumerable: true,
    get() { getterCalls += 1; throw new Error(marker); },
  });
  const hostile = new Proxy({}, { ownKeys() { throw new Error(marker); } });
  const extra = changed(() => {});
  extra.private = marker;
  const symbol = changed(() => {});
  symbol[Symbol(marker)] = true;
  const invalid = [
    changed(value => { value.auditId = 'audit-foreign'; }),
    changed(value => { value.pages[0].pageId = 'page-foreign'; }),
    changed(value => { value.pages[0].inventoryHash = 'b'.repeat(64); }),
    changed(value => { value.pages[0].outcomes.push({ ruleId: 'resume.private', outcome: 'passed' }); }),
    extra,
    symbol,
    accessor,
    hostile,
  ];
  let browserEffects = 0;
  let checkpointEffects = 0;
  let persistenceEffects = 0;
  let modelClockReads = 0;
  adapter.probeDocumentIdentity = async () => { browserEffects += 1; throw new Error(marker); };
  adapter.probeSensitiveCaptureSignals = async () => { browserEffects += 1; throw new Error(marker); };
  const eventsBefore = adapter.events.length;
  const screenshotsBefore = adapter.counts.screenshots;

  for (const resumeCheckpoint of invalid) {
    await assert.rejects(() => runAttachedAuditExecution({
      auditId, sessionCapabilityId: 'S'.repeat(22), target, capturePolicy: policy,
      privacyGate: attachedPixelGate(policy, [], { auditId, consentId: 'A'.repeat(21) + 'Q' }),
      resumeCheckpoint,
      chromeAdapter: adapter,
      modelNow: () => { modelClockReads += 1; return '2026-08-29T10:05:00.000Z'; },
      expectedExtensionId: TEST_EXTENSION_ID,
      onCheckpoint: async () => { checkpointEffects += 1; },
      persistAuditModel: async () => { persistenceEffects += 1; },
    }), error => {
      assert.equal(error.message, 'ATTACHED_AUDIT_EXECUTION_DENIED');
      assert.doesNotMatch(error.message, new RegExp(marker, 'u'));
      return true;
    });
  }

  assert.equal(getterCalls, 0);
  assert.equal(browserEffects, 0);
  assert.equal(checkpointEffects, 0);
  assert.equal(persistenceEffects, 0);
  assert.equal(modelClockReads, 0);
  assert.equal(adapter.events.length, eventsBefore);
  assert.equal(adapter.counts.screenshots, screenshotsBefore);
});

test('attached element collection failure before raster still performs cleanup once without persistence', async () => {
  const auditId = 'audit-attached-element-failure';
  const policy = createCapturePolicyV1({ mode: 'element-only', includeQuery: false });
  const gateCalls = [];
  let persisted = 0;
  const adapter = fakeAdapter({ trackCaptureCalls: true, collectFailure: true });
  await runAttachedAuditExecution({
    auditId, sessionCapabilityId: 'S'.repeat(22),
    target: { kind: 'attached', tabId: 42, windowId: 9, documentId: 'document-a', initialUrlEvidence: TEST_EVIDENCE_URL, initialUrlSessionDigest: TEST_DIGEST },
    capturePolicy: policy, privacyGate: attachedPixelGate(policy, gateCalls, { auditId }),
    chromeAdapter: adapter, modelNow: clock, expectedExtensionId: TEST_EXTENSION_ID,
    onCheckpoint: async () => {}, persistAuditModel: async () => { persisted += 1; },
  });
  assert.equal(adapter.counts.screenshots, 0);
  assert.equal(persisted, 0);
  assert.deepEqual(gateCalls, ['after']);
});

test('attached document drift at the final pixel boundary produces zero raster', async () => {
  const auditId = 'audit-attached-drift';
  const policy = createCapturePolicyV1({ mode: 'full-evidence', includeQuery: false });
  const gateCalls = [];
  const adapter = fakeAdapter({
    trackCaptureCalls: true,
    composeMap: async input => createAnnotationMapFixture({ sourceEvidenceId: input.fullPageEvidence.evidenceId }),
  });
  let proofs = 0;
  adapter.probeDocumentIdentity = async tabId => {
    proofs += 1;
    return { tabId, windowId: 9, documentId: proofs === 1 ? 'document-a' : 'document-b', urlSessionDigest: TEST_DIGEST };
  };
  const result = await runAttachedAuditExecution({
    auditId, sessionCapabilityId: 'S'.repeat(22),
    target: { kind: 'attached', tabId: 42, windowId: 9, documentId: 'document-a', initialUrlEvidence: TEST_EVIDENCE_URL, initialUrlSessionDigest: TEST_DIGEST },
    capturePolicy: policy, privacyGate: attachedPixelGate(policy, gateCalls, { auditId }),
    chromeAdapter: adapter, modelNow: clock, expectedExtensionId: TEST_EXTENSION_ID,
    onCheckpoint: async () => {}, persistAuditModel: async () => { throw new Error('must-not-persist'); },
  });
  assert.equal(result.state, 'revoked');
  assert.equal(result.failureCode, 'TARGET_CHANGED');
  assert.equal(adapter.counts.screenshots, 0);
});

test('attached navigation during the fresh sensitive probe produces zero raster', async () => {
  const auditId = 'audit-attached-probe-navigation';
  const policy = createCapturePolicyV1({ mode: 'full-evidence', includeQuery: false });
  const gateCalls = [];
  let documentId = 'document-a';
  let sensitiveProbes = 0;
  const adapter = fakeAdapter({
    trackCaptureCalls: true,
    async duringSensitiveProbe() {
      sensitiveProbes += 1;
      if (sensitiveProbes === 2) documentId = 'document-b';
    },
    composeMap: async input => createAnnotationMapFixture({ sourceEvidenceId: input.fullPageEvidence.evidenceId }),
  });
  adapter.probeDocumentIdentity = async tabId => ({
    tabId, windowId: 9, documentId, urlSessionDigest: TEST_DIGEST,
  });

  const result = await runAttachedAuditExecution({
    auditId, sessionCapabilityId: 'S'.repeat(22),
    target: { kind: 'attached', tabId: 42, windowId: 9, documentId: 'document-a', initialUrlEvidence: TEST_EVIDENCE_URL, initialUrlSessionDigest: TEST_DIGEST },
    capturePolicy: policy, privacyGate: attachedPixelGate(policy, gateCalls, { auditId }),
    chromeAdapter: adapter, modelNow: clock, expectedExtensionId: TEST_EXTENSION_ID,
    onCheckpoint: async () => {}, persistAuditModel: async () => { throw new Error('must-not-persist'); },
  });

  assert.equal(result.state, 'revoked');
  assert.equal(result.failureCode, 'TARGET_CHANGED');
  assert.equal(adapter.counts.screenshots, 0);
});

test('attached abort during the fresh sensitive probe produces zero raster', async () => {
  const auditId = 'audit-attached-probe-abort';
  const policy = createCapturePolicyV1({ mode: 'full-evidence', includeQuery: false });
  const controller = new AbortController();
  const gateCalls = [];
  let sensitiveProbes = 0;
  const adapter = fakeAdapter({
    trackCaptureCalls: true,
    async duringSensitiveProbe() {
      sensitiveProbes += 1;
      if (sensitiveProbes === 2) controller.abort(new DOMException('PRIVATE_PIXEL_ABORT', 'AbortError'));
    },
    composeMap: async input => createAnnotationMapFixture({ sourceEvidenceId: input.fullPageEvidence.evidenceId }),
  });

  const result = await runAttachedAuditExecution({
    auditId, sessionCapabilityId: 'S'.repeat(22),
    target: { kind: 'attached', tabId: 42, windowId: 9, documentId: 'document-a', initialUrlEvidence: TEST_EVIDENCE_URL, initialUrlSessionDigest: TEST_DIGEST },
    capturePolicy: policy, privacyGate: attachedPixelGate(policy, gateCalls, { auditId }),
    chromeAdapter: adapter, modelNow: clock, signal: controller.signal, expectedExtensionId: TEST_EXTENSION_ID,
    onCheckpoint: async () => {}, persistAuditModel: async () => { throw new Error('must-not-persist'); },
  });

  assert.equal(adapter.counts.screenshots, 0);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_PIXEL_ABORT/u);
});

test('attached navigation while the runner gate is pending produces zero raster', async () => {
  const auditId = 'audit-attached-gate-navigation';
  const policy = createCapturePolicyV1({ mode: 'full-evidence', includeQuery: false });
  const consentId = 'A'.repeat(21) + 'Q';
  const gateCalls = [];
  let documentId = 'document-a';
  const adapter = fakeAdapter({
    trackCaptureCalls: true,
    composeMap: async input => createAnnotationMapFixture({ sourceEvidenceId: input.fullPageEvidence.evidenceId }),
  });
  adapter.probeDocumentIdentity = async tabId => ({
    tabId, windowId: 9, documentId, urlSessionDigest: TEST_DIGEST,
  });
  const gate = attachedPixelGate(policy, gateCalls, {
    auditId, consentId, async beforeGateResult() { documentId = 'document-b'; },
  });

  const result = await runAttachedAuditExecution({
    auditId, sessionCapabilityId: 'S'.repeat(22),
    target: { kind: 'attached', tabId: 42, windowId: 9, documentId: 'document-a', initialUrlEvidence: TEST_EVIDENCE_URL, initialUrlSessionDigest: TEST_DIGEST },
    capturePolicy: policy, privacyGate: gate,
    chromeAdapter: adapter, modelNow: clock, expectedExtensionId: TEST_EXTENSION_ID,
    onCheckpoint: async () => {}, persistAuditModel: async () => { throw new Error('must-not-persist'); },
  });

  assert.equal(result.state, 'revoked');
  assert.equal(result.failureCode, 'TARGET_CHANGED');
  assert.equal(adapter.counts.screenshots, 0);
  assert.deepEqual(gateCalls, ['gate', 'after']);
});

test('attached consent expiring between gate authorization and final proof starts zero raster, persists nothing and cleans once', async () => {
  const auditId = 'audit-attached-expired-at-raster';
  const policy = createCapturePolicyV1({ mode: 'full-evidence', includeQuery: false });
  const consentId = 'A'.repeat(21) + 'Q';
  const gateCalls = [];
  const clockValues = [1_788_000_599_999, 1_788_000_600_000];
  let persisted = 0;
  const adapter = fakeAdapter({
    trackCaptureCalls: true,
    composeMap: async input => createAnnotationMapFixture({ sourceEvidenceId: input.fullPageEvidence.evidenceId }),
  });
  const result = await runAttachedAuditExecution({
    auditId, sessionCapabilityId: 'S'.repeat(22),
    target: {
      kind: 'attached', tabId: 42, windowId: 9, documentId: 'document-a',
      initialUrlEvidence: TEST_EVIDENCE_URL, initialUrlSessionDigest: TEST_DIGEST,
    },
    capturePolicy: policy,
    privacyGate: attachedPixelGate(policy, gateCalls, {
      auditId, consentId,
      commitClock: createScriptedPixelCommitClockV1({ epochs: clockValues }),
      suspensionUpdatedAt: clockValues[0],
    }),
    chromeAdapter: adapter, modelNow: clock, expectedExtensionId: TEST_EXTENSION_ID,
    onCheckpoint: async () => {}, persistAuditModel: async () => { persisted += 1; },
  });

  assert.equal(result.state, 'revoked');
  assert.equal(adapter.counts.screenshots, 0);
  assert.equal(adapter.counts.fullPageCalls, 0);
  assert.equal(adapter.counts.elementCalls, 0);
  assert.equal(persisted, 0);
  assert.deepEqual(gateCalls, ['gate', 'after']);
});

test('attached resumed category change repauses before raster and gate replay cannot recapture', async () => {
  const auditId = 'audit-attached-repause';
  const policy = createCapturePolicyV1({ mode: 'full-evidence', includeQuery: false });
  const consentId = 'A'.repeat(21) + 'Q';
  const gateCalls = [];
  const adapter = fakeAdapter({
    trackCaptureCalls: true, sensitiveSignals: PASSWORD_SIGNALS,
    composeMap: async input => createAnnotationMapFixture({ sourceEvidenceId: input.fullPageEvidence.evidenceId }),
  });
  const gate = attachedPixelGate(policy, gateCalls, { auditId, consentId, runnerStatus: 'repaused' });
  const input = {
    auditId, sessionCapabilityId: 'S'.repeat(22),
    target: { kind: 'attached', tabId: 42, windowId: 9, documentId: 'document-a', initialUrlEvidence: TEST_EVIDENCE_URL, initialUrlSessionDigest: TEST_DIGEST },
    capturePolicy: policy, privacyGate: gate, chromeAdapter: adapter, modelNow: clock,
    expectedExtensionId: TEST_EXTENSION_ID, onCheckpoint: async () => {}, persistAuditModel: async () => {},
  };
  const result = await runAttachedAuditExecution(input);
  assert.equal(result.state, 'privacy-paused');
  assert.equal(adapter.counts.screenshots, 0);
  assert.deepEqual(gateCalls, ['gate']);
  await assert.rejects(() => runAttachedAuditExecution(input), /PIXEL_PRIVACY_GATE_DENIED|ATTACHED_AUDIT_EXECUTION_DENIED/u);
  assert.equal(adapter.counts.screenshots, 0);
});

test('attached caller projects EvidenceUrlV1 through the canonical runner without legacy runner arguments', async () => {
  const adapter = fakeAdapter({ noPixels: true });
  const checkpoints = [];
  const result = await runAttachedAuditExecution({
    auditId: 'audit-attached-canonical',
    sessionCapabilityId: 'S'.repeat(22),
    target: {
      kind: 'attached', tabId: 42, windowId: 9, documentId: 'document-a',
      initialUrlEvidence: TEST_EVIDENCE_URL,
      initialUrlSessionDigest: TEST_DIGEST,
    },
    capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    chromeAdapter: adapter,
    modelNow: clock,
    expectedExtensionId: TEST_EXTENSION_ID,
    onCheckpoint: async checkpoint => { checkpoints.push(checkpoint); },
    persistAuditModel: async () => {},
  });

  assert.equal(result.state, 'model');
  assert.equal(result.failureCode, null);
  assert.equal(result.model.auditId, 'audit-attached-canonical');
  assert.ok(['complete', 'partial', 'cancelled'].includes(result.model.session.status));
  assert.ok(checkpoints.length > 0);
  assert.equal(adapter.events.includes('create-tab'), false);
  assert.equal(adapter.events.some(value => value.startsWith('navigate:')), false);
  assert.equal(adapter.events.some(value => value.startsWith('remove-tab:')), false);
  assert.equal(adapter.counts.screenshots, 0);
});

test('attached cancellation at the first checkpoint preserves the observed target as a cancelled model', async () => {
  const controller = new AbortController();
  const adapter = fakeAdapter({ noPixels: true });
  const requested = sanitizeEvidenceUrlV1(
    'https://example.test/area/page?secret=REMOVE',
    { includeQuery: false },
  );
  let checkpointCalls = 0;
  let persisted = 0;
  const result = await runAttachedAuditExecution({
    auditId: 'audit-attached-first-checkpoint-cancel',
    sessionCapabilityId: 'S'.repeat(22),
    target: {
      kind: 'attached', tabId: 42, windowId: 9, documentId: 'document-a',
      initialUrlEvidence: requested,
      initialUrlSessionDigest: TEST_DIGEST,
    },
    capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    chromeAdapter: adapter,
    modelNow: clock,
    signal: controller.signal,
    expectedExtensionId: TEST_EXTENSION_ID,
    onCheckpoint: async () => {
      checkpointCalls += 1;
      if (checkpointCalls === 1) {
        controller.abort(new DOMException('PRIVATE_ATTACHED_CHECKPOINT_ABORT', 'AbortError'));
      }
    },
    persistAuditModel: async () => { persisted += 1; },
  });

  assert.equal(result.state, 'model');
  assert.equal(result.failureCode, null);
  assert.equal(result.model.session.status, 'cancelled');
  assert.equal(result.model.requestedUrl, requested.href);
  assert.equal(result.model.finalUrl, requested.href);
  assert.deepEqual(
    result.model.session.diagnostics.filter(entry =>
      ['PIXEL_CAPTURE_OMITTED', 'FULL_PAGE_CAPTURE_OMITTED', 'FULL_PAGE_CAPTURE_NOT_ATTEMPTED'].includes(entry.code),
    ).map(entry => entry.code),
    ['PIXEL_CAPTURE_OMITTED'],
  );
  assert.equal(result.model.session.diagnostics.some(entry => entry.code === 'FULL_PAGE_CAPTURE_FAILED'), false);
  assert.equal(result.checkpoint.auditId, 'audit-attached-first-checkpoint-cancel');
  assert.equal(result.checkpoint.pages[0].pageId, 'page-1');
  assert.equal(adapter.events.includes('collect'), false);
  assert.equal(persisted, 0);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_ATTACHED_CHECKPOINT_ABORT|REMOVE|secret=/u);
});

test('attached pre-capture cancellation projects one factual capture diagnostic for each pixel mode', async t => {
  for (const [mode, expectedCode] of [
    ['no-pixels', 'PIXEL_CAPTURE_OMITTED'],
    ['element-only', 'FULL_PAGE_CAPTURE_OMITTED'],
    ['full-evidence', 'FULL_PAGE_CAPTURE_NOT_ATTEMPTED'],
  ]) await t.test(mode, async () => {
    const auditId = `audit-attached-pre-capture-${mode}`;
    const policy = createCapturePolicyV1({ mode, includeQuery: false });
    const controller = new AbortController();
    const gateCalls = [];
    const adapter = fakeAdapter({
      trackCaptureCalls: true,
      composeMap: async input => createAnnotationMapFixture({ sourceEvidenceId: input.fullPageEvidence.evidenceId }),
    });
    let checkpoints = 0;
    const result = await runAttachedAuditExecution({
      auditId, sessionCapabilityId: 'S'.repeat(22),
      target: { kind: 'attached', tabId: 42, windowId: 9, documentId: 'document-a', initialUrlEvidence: TEST_EVIDENCE_URL, initialUrlSessionDigest: TEST_DIGEST },
      capturePolicy: policy,
      privacyGate: mode === 'no-pixels' ? undefined : attachedPixelGate(policy, gateCalls, { auditId }),
      chromeAdapter: adapter, modelNow: clock, signal: controller.signal, expectedExtensionId: TEST_EXTENSION_ID,
      onCheckpoint: async () => {
        checkpoints += 1;
        if (checkpoints === 1) controller.abort(new DOMException('PRIVATE_PRE_CAPTURE_ABORT', 'AbortError'));
      },
      persistAuditModel: async () => { throw new Error('must-not-persist'); },
    });
    const captureCodes = result.model.session.diagnostics.filter(entry =>
      ['FULL_PAGE_CAPTURE_FAILED', 'PIXEL_CAPTURE_OMITTED', 'FULL_PAGE_CAPTURE_OMITTED', 'FULL_PAGE_CAPTURE_NOT_ATTEMPTED'].includes(entry.code),
    ).map(entry => entry.code);
    assert.equal(result.model.session.status, 'cancelled');
    assert.deepEqual(captureCodes, [expectedCode]);
    assert.equal(adapter.counts.screenshots, 0);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_PRE_CAPTURE_ABORT/u);
  });
});

test('attached caller copies EvidenceUrlV1 through data descriptors without property reads', async () => {
  const adapter = fakeAdapter({ noPixels: true });
  let directReads = 0;
  const result = await runAttachedAuditExecution({
    auditId: 'audit-attached-evidence-descriptors',
    sessionCapabilityId: 'S'.repeat(22),
    target: {
      kind: 'attached', tabId: 42, windowId: 9, documentId: 'document-a',
      initialUrlEvidence: unreadEvidenceProxy(TEST_EVIDENCE_URL, () => { directReads += 1; }),
      initialUrlSessionDigest: TEST_DIGEST,
    },
    capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    chromeAdapter: adapter,
    modelNow: clock,
    expectedExtensionId: TEST_EXTENSION_ID,
    onCheckpoint: async () => {},
    persistAuditModel: async () => {},
  });

  assert.equal(result.state, 'model');
  assert.equal(directReads, 0);
});

test('attached caller captures browser effects before its first asynchronous boundary', async () => {
  const adapter = fakeAdapter({ noPixels: true });
  const replacements = [];
  const running = runAttachedAuditExecution({
    auditId: 'audit-attached-effect-snapshot',
    sessionCapabilityId: 'S'.repeat(22),
    target: {
      kind: 'attached', tabId: 42, windowId: 9, documentId: 'document-a',
      initialUrlEvidence: TEST_EVIDENCE_URL,
      initialUrlSessionDigest: TEST_DIGEST,
    },
    capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    chromeAdapter: adapter, modelNow: clock, expectedExtensionId: TEST_EXTENSION_ID,
    onCheckpoint: async () => {}, persistAuditModel: async () => {},
  });
  for (const name of [
    'probeDocumentIdentity', 'connectCdp', 'runAxeInTab', 'collectPage',
    'runDynamicProbes', 'getEnvironment', 'emitProgress', 'handoffReport',
  ]) {
    adapter[name] = async () => {
      replacements.push(name);
      throw new Error(`PRIVATE_ATTACHED_REPLACEMENT_${name}`);
    };
  }

  const result = await running;
  assert.equal(result.state, 'model');
  assert.deepEqual(replacements, []);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_ATTACHED_REPLACEMENT/u);
});

test('attached caller preserves the sanitized requested path when no redirect occurred', async () => {
  const adapter = fakeAdapter({ noPixels: true, collectFailure: true });
  const requested = sanitizeEvidenceUrlV1(
    'https://example.test/area/page?secret=REMOVE',
    { includeQuery: false },
  );
  const result = await runAttachedAuditExecution({
    auditId: 'audit-attached-requested-path',
    sessionCapabilityId: 'S'.repeat(22),
    target: {
      kind: 'attached', tabId: 42, windowId: 9, documentId: 'document-a',
      initialUrlEvidence: requested,
      initialUrlSessionDigest: TEST_DIGEST,
    },
    capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    chromeAdapter: adapter,
    modelNow: clock,
    expectedExtensionId: TEST_EXTENSION_ID,
    onCheckpoint: async () => {},
    persistAuditModel: async () => {},
  });

  assert.equal(result.state, 'model');
  assert.equal(result.model.requestedUrl, requested.href);
  assert.equal(result.model.finalUrl, requested.href);
  assert.equal(result.model.pages[0].requestedUrl, requested.href);
  assert.equal(result.model.pages[0].finalUrl, requested.href);
  assert.doesNotMatch(JSON.stringify(result), /REMOVE|secret=/u);
});

test('attached execution rejects a custom page id before time, checkpoint or browser effects', async () => {
  const adapter = fakeAdapter({ noPixels: true });
  let probeCalls = 0;
  let nowCalls = 0;
  let checkpointCalls = 0;
  adapter.probeDocumentIdentity = async tabId => {
    probeCalls += 1;
    return { tabId, windowId: 9, documentId: 'document-a', urlSessionDigest: TEST_DIGEST };
  };

  await assert.rejects(runAttachedAuditExecution({
    auditId: 'audit-attached-custom-page-denied',
    sessionCapabilityId: 'S'.repeat(22),
    target: {
      kind: 'attached', tabId: 42, windowId: 9, documentId: 'document-a',
      initialUrlEvidence: TEST_EVIDENCE_URL,
      initialUrlSessionDigest: TEST_DIGEST,
    },
    capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    chromeAdapter: adapter,
    modelNow: () => { nowCalls += 1; return '2026-08-29T12:00:00.000Z'; },
    pageId: 'page-custom',
    expectedExtensionId: TEST_EXTENSION_ID,
    onCheckpoint: async () => { checkpointCalls += 1; },
    persistAuditModel: async () => {},
  }), /ATTACHED_AUDIT_EXECUTION_DENIED/u);

  assert.equal(nowCalls, 0);
  assert.equal(probeCalls, 0);
  assert.equal(checkpointCalls, 0);
  assert.deepEqual(adapter.events, []);
});

test('owned standalone execution rejects a custom page id before RNG, vault or browser effects', async () => {
  const sessionValues = {};
  const adapter = fakeAdapter({ noPixels: true, canonicalInternals: true, sessionValues });
  let idCalls = 0;

  await assert.rejects(runAuditExecution({
    url: 'https://example.test/',
    chromeAdapter: adapter,
    now: clock,
    idFactory: () => { idCalls += 1; return 'audit-owned-custom-page-denied'; },
    pageId: 'page-custom',
    checkpointAuditId: null,
    expectedExtensionId: TEST_EXTENSION_ID,
  }), /AUDIT_EXECUTION_DENIED/u);

  assert.equal(idCalls, 0);
  assert.deepEqual(adapter.events, []);
  assert.deepEqual(sessionValues, {});
});

test('owned batch child accepts a custom parent page id with a projected checkpoint', async () => {
  const checkpoints = [];
  const adapter = fakeAdapter({ noPixels: true, canonicalInternals: true });
  const execution = await runAuditExecution({
    url: 'https://example.test/',
    chromeAdapter: adapter,
    now: clock,
    idFactory: () => 'audit-owned-parent-page',
    pageId: 'page-custom',
    checkpointAuditId: 'batch-parent',
    onCheckpoint: async checkpoint => { checkpoints.push(checkpoint); },
    expectedExtensionId: TEST_EXTENSION_ID,
  });

  assert.equal(execution.observationState, 'observed');
  assert.equal(execution.observedTarget.pageId, null);
  assert.equal(execution.checkpoint.auditId, 'batch-parent');
  assert.equal(execution.checkpoint.pages[0].pageId, 'page-custom');
  assert.equal(checkpoints.at(-1).auditId, 'batch-parent');
  assert.equal(checkpoints.at(-1).pages[0].pageId, 'page-custom');
});

test('owned caller uses V2 ownership, a fresh token and only the closed R18 status union', async () => {
  const sessionValues = {};
  const checkpoints = [];
  const persisted = [];
  const adapter = fakeAdapter({
    noPixels: true,
    canonicalInternals: true,
    sessionValues,
    onExecutionCheckpoint: async checkpoint => { checkpoints.push(checkpoint); },
    persistAuditModel: async model => { persisted.push(model); },
  });
  const execution = await runAuditExecution({
    url: 'https://example.test/final?secret=REMOVE',
    chromeAdapter: adapter,
    now: clock,
    idFactory: () => 'audit-owned-canonical',
    closeAuditTab: true,
    expectedExtensionId: TEST_EXTENSION_ID,
    pageId: 'page-1',
    cleanupMode: 'always',
  });

  assert.ok(['complete', 'partial', 'cancelled'].includes(execution.status));
  assert.equal(execution.status, execution.model.session.status);
  assert.notEqual(execution.status, 'completed');
  assert.equal(execution.observationState, 'observed');
  assert.equal(execution.ownershipState, 'removed');
  assert.deepEqual(Reflect.ownKeys(execution.observedTarget), [
    'version', 'kind', 'ownershipId', 'tabId', 'windowId', 'documentId',
    'urlEvidence', 'urlSessionDigest', 'cleanupMode', 'pageId',
  ]);
  assert.equal(execution.observedTarget.version, 'ObservedTargetV1');
  assert.equal(execution.observedTarget.kind, 'owned-disposable');
  assert.equal(execution.observedTarget.cleanupMode, 'always');
  assert.equal(execution.observedTarget.pageId, 'page-1');
  assert.deepEqual(execution.observedTarget.urlEvidence, TEST_EVIDENCE_URL);
  assert.equal(Object.hasOwn(execution.observedTarget, 'ownerId'), false);
  assert.equal(Object.hasOwn(execution.observedTarget, 'navigationToken'), false);
  assert.ok(checkpoints.length > 0);
  assert.equal(persisted.length, 1);
  assert.equal(adapter.counts.screenshots, 0);

  const v2Keys = Object.keys(sessionValues).filter(key => key.startsWith('audita:owned-tab:v2:'));
  assert.equal(v2Keys.length, 1);
  const owner = sessionValues[v2Keys[0]];
  assert.deepEqual(Reflect.ownKeys(owner), [
    'version', 'ownershipId', 'auditId', 'purpose', 'tabId', 'windowId',
    'cleanupMode', 'state', 'createdAt', 'updatedAt',
  ]);
  assert.equal(owner.version, 2);
  assert.equal(owner.auditId, 'audit-owned-canonical');
  assert.equal(owner.ownershipId, execution.observedTarget.ownershipId);
  assert.equal(owner.state, 'removed');
  assert.equal(Object.hasOwn(owner, 'ownerId'), false);
  assert.equal(Object.hasOwn(owner, 'sessionCapabilityId'), false);
  assert.equal(Object.keys(sessionValues).some(key => key.startsWith('audita:owned-tab:v1:')), false);
  assert.doesNotMatch(JSON.stringify({ execution, sessionValues }), /REMOVE|navigationToken|sessionCapabilityId/u);
});

test('owned caller copies returned EvidenceUrlV1 through data descriptors without property reads', async () => {
  const adapter = fakeAdapter({ noPixels: true, canonicalInternals: true });
  let directReads = 0;
  adapter.getEvidenceUrl = () => unreadEvidenceProxy(TEST_EVIDENCE_URL, () => { directReads += 1; });

  const execution = await runAuditExecution({
    url: 'https://example.test/final?secret=REMOVE',
    chromeAdapter: adapter,
    now: clock,
    idFactory: () => 'audit-owned-evidence-descriptors',
    expectedExtensionId: TEST_EXTENSION_ID,
    cleanupMode: 'always',
  });

  assert.ok(['complete', 'partial', 'failed'].includes(execution.status));
  assert.equal(directReads, 0);
});

test('owned caller preserves distinct sanitized requested and observed URLs across a cross-origin redirect', async () => {
  const adapter = fakeAdapter({ noPixels: true, canonicalInternals: true });
  adapter.waitForStable = async () => ({ url: 'https://final.example.test/dest?token=REMOVE_FINAL' });
  adapter.getEvidenceUrl = async () => 'https://final.example.test/dest?token=REMOVE_FINAL';

  const execution = await runAuditExecution({
    url: 'https://requested.example.test/start?secret=REMOVE_REQUEST',
    chromeAdapter: adapter,
    now: clock,
    idFactory: () => 'audit-owned-cross-origin-redirect',
    expectedExtensionId: TEST_EXTENSION_ID,
    cleanupMode: 'always',
  });

  assert.equal(execution.model.requestedUrl, 'https://requested.example.test/start');
  assert.equal(execution.model.finalUrl, 'https://final.example.test/dest');
  assert.equal(execution.model.pages[0].requestedUrl, 'https://requested.example.test/start');
  assert.equal(execution.model.pages[0].finalUrl, 'https://final.example.test/dest');
  assert.equal(execution.observedTarget.urlEvidence.href, 'https://final.example.test/dest');
  assert.doesNotMatch(JSON.stringify(execution), /REMOVE_REQUEST|REMOVE_FINAL|secret=|token=/u);
});

test('owned execution propagates a checkpoint rejection after observation instead of fabricating a terminal result', async () => {
  const adapter = fakeAdapter({
    noPixels: true,
    canonicalInternals: true,
    onExecutionCheckpoint: async () => { throw new Error('PRIVATE_CHECKPOINT_REJECTION'); },
  });

  await assert.rejects(runAuditExecution({
    url: 'https://example.test/final?secret=REMOVE',
    chromeAdapter: adapter,
    now: clock,
    idFactory: () => 'audit-owned-checkpoint-rejection',
    expectedExtensionId: TEST_EXTENSION_ID,
    cleanupMode: 'always',
  }), error => {
    assert.doesNotMatch(String(error), /PRIVATE_CHECKPOINT_REJECTION/u);
    return true;
  });
});

test('owned execution never persists an uncorrelated dependency AbortError as a cancelled audit', async () => {
  const persisted = [];
  const adapter = fakeAdapter({
    noPixels: true,
    canonicalInternals: true,
    collectError: new DOMException('PRIVATE_ABORT_SPOOF', 'AbortError'),
    persistAuditModel: async model => { persisted.push(model); },
  });

  const execution = await runAuditExecution({
    url: 'https://example.test/',
    chromeAdapter: adapter,
    now: clock,
    idFactory: () => 'audit-owned-abort-spoof',
    expectedExtensionId: TEST_EXTENSION_ID,
    cleanupMode: 'always',
  });

  assert.equal(execution.status, 'failed');
  assert.equal(execution.model.session.status, 'failed');
  assert.deepEqual(persisted.map(model => model.session.status), ['failed']);
  assert.doesNotMatch(JSON.stringify(execution), /PRIVATE_ABORT_SPOOF/u);
});

test('owned cancellation after observation returns only with a factual V2 cleanup state', async t => {
  for (const scenario of [
    { name: 'removed', removeTabFailure: false },
    { name: 'cleanup-pending', removeTabFailure: true },
  ]) await t.test(scenario.name, async () => {
    const controller = new AbortController();
    const sessionValues = {};
    const adapter = fakeAdapter({
      noPixels: true,
      canonicalInternals: true,
      sessionValues,
      removeTabFailure: scenario.removeTabFailure,
      afterCollect: () => controller.abort(new DOMException('PRIVATE_POST_OBSERVATION_ABORT', 'AbortError')),
    });

    const execution = await runAuditExecution({
      url: 'https://example.test/?secret=REMOVE',
      chromeAdapter: adapter,
      now: clock,
      idFactory: () => `audit-owned-cancel-${scenario.name}`,
      signal: controller.signal,
      expectedExtensionId: TEST_EXTENSION_ID,
      cleanupMode: 'always',
    });

    assert.equal(execution.status, 'cancelled');
    assert.equal(execution.model.session.status, 'cancelled');
    assert.equal(execution.observationState, 'observed');
    assert.equal(execution.ownershipState, scenario.name);
    assert.equal(execution.checkpoint.pages[0].pageId, 'page-1');
    const owner = Object.values(sessionValues).find(value => value?.version === 2 && value?.purpose === 'audit');
    assert.equal(owner?.state, scenario.name);
    assert.doesNotMatch(JSON.stringify({ execution, sessionValues }), /PRIVATE_POST_OBSERVATION_ABORT|REMOVE/u);
  });
});

test('owned cancellation at the first checkpoint preserves observed identity and factual cleanup', async t => {
  for (const scenario of [
    { name: 'removed', removeTabFailure: false },
    { name: 'cleanup-pending', removeTabFailure: true },
  ]) await t.test(scenario.name, async () => {
    const controller = new AbortController();
    const sessionValues = {};
    let checkpointCalls = 0;
    let persisted = 0;
    const adapter = fakeAdapter({
      noPixels: true,
      canonicalInternals: true,
      sessionValues,
      removeTabFailure: scenario.removeTabFailure,
      onExecutionCheckpoint: async () => {
        checkpointCalls += 1;
        if (checkpointCalls === 1) {
          controller.abort(new DOMException('PRIVATE_FIRST_CHECKPOINT_ABORT', 'AbortError'));
        }
      },
      persistAuditModel: async () => { persisted += 1; },
    });

    const execution = await runAuditExecution({
      url: 'https://example.test/requested/path?secret=REMOVE',
      chromeAdapter: adapter,
      now: clock,
      idFactory: () => `audit-owned-checkpoint-cancel-${scenario.name}`,
      signal: controller.signal,
      expectedExtensionId: TEST_EXTENSION_ID,
      cleanupMode: 'always',
    });

    assert.equal(execution.status, 'cancelled');
    assert.equal(execution.model.session.status, 'cancelled');
    assert.equal(execution.observationState, 'observed');
    assert.equal(execution.ownershipState, scenario.name);
    assert.equal(execution.model.requestedUrl, 'https://example.test/requested/path');
    assert.equal(execution.model.finalUrl, execution.observedTarget.urlEvidence.href);
    assert.equal(execution.checkpoint.pages[0].pageId, 'page-1');
    assert.equal(adapter.events.includes('collect'), false);
    assert.equal(persisted, 0);
    assert.equal(Object.values(sessionValues).find(value => value?.version === 2)?.state, scenario.name);
    assert.doesNotMatch(JSON.stringify({ execution, sessionValues }), /PRIVATE_FIRST_CHECKPOINT_ABORT|REMOVE/u);
  });
});

test('owned final proof failure takes precedence over simultaneous cancellation after factual cleanup', async t => {
  for (const scenario of ['target-changed', 'proof-unavailable']) await t.test(scenario, async () => {
    const controller = new AbortController();
    const sessionValues = {};
    let proofCount = 0;
    let persisted = 0;
    const adapter = fakeAdapter({
      noPixels: true,
      canonicalInternals: true,
      sessionValues,
      persistAuditModel: async () => { persisted += 1; },
    });
    adapter.probeDocumentIdentity = async tabId => {
      proofCount += 1;
      if (proofCount === 2) {
        controller.abort(new DOMException('PRIVATE_OWNED_FINAL_PROOF_ABORT', 'AbortError'));
        if (scenario === 'proof-unavailable') throw new Error('PRIVATE_OWNED_FINAL_PROOF_UNAVAILABLE');
        return {
          tabId, windowId: 9, documentId: 'document-changed',
          urlSessionDigest: `hmac-sha256:${'B'.repeat(43)}`,
        };
      }
      return { tabId, windowId: 9, documentId: 'document-a', urlSessionDigest: TEST_DIGEST };
    };

    await assert.rejects(runAuditExecution({
      url: 'https://example.test/?secret=REMOVE',
      chromeAdapter: adapter,
      now: clock,
      idFactory: () => `audit-owned-final-proof-${scenario}`,
      signal: controller.signal,
      expectedExtensionId: TEST_EXTENSION_ID,
      cleanupMode: 'always',
    }), error => {
      assert.match(String(error), /OBSERVED_RUNNER_DENIED/u);
      assert.doesNotMatch(String(error), /PRIVATE_OWNED_FINAL_PROOF|REMOVE/u);
      return true;
    });

    assert.equal(proofCount, 2);
    assert.equal(persisted, 0);
    assert.equal(Object.values(sessionValues).find(value => value?.version === 2)?.state, 'removed');
    assert.doesNotMatch(JSON.stringify(sessionValues), /PRIVATE_OWNED_FINAL_PROOF|REMOVE/u);
  });
});

test('owned simultaneous cancellation remains cancelled when its final proof is valid', async () => {
  const controller = new AbortController();
  const sessionValues = {};
  let proofCount = 0;
  const adapter = fakeAdapter({ noPixels: true, canonicalInternals: true, sessionValues });
  adapter.probeDocumentIdentity = async tabId => {
    proofCount += 1;
    if (proofCount === 2) controller.abort(new DOMException('PRIVATE_VALID_FINAL_PROOF_ABORT', 'AbortError'));
    return { tabId, windowId: 9, documentId: 'document-a', urlSessionDigest: TEST_DIGEST };
  };

  const execution = await runAuditExecution({
    url: 'https://example.test/',
    chromeAdapter: adapter,
    now: clock,
    idFactory: () => 'audit-owned-valid-final-proof-cancel',
    signal: controller.signal,
    expectedExtensionId: TEST_EXTENSION_ID,
    cleanupMode: 'always',
  });

  assert.equal(proofCount, 2);
  assert.equal(execution.status, 'cancelled');
  assert.equal(execution.ownershipState, 'removed');
  assert.equal(execution.model.session.status, 'cancelled');
  assert.doesNotMatch(JSON.stringify(execution), /PRIVATE_VALID_FINAL_PROOF_ABORT/u);
});

test('owned cancellation may retain the observed tab only under the explicit review cleanup mode', async () => {
  const controller = new AbortController();
  const sessionValues = {};
  const adapter = fakeAdapter({
    noPixels: true,
    canonicalInternals: true,
    sessionValues,
    afterCollect: () => controller.abort(new DOMException('PRIVATE_RETAINED_ABORT', 'AbortError')),
  });
  const execution = await runAuditExecution({
    url: 'https://example.test/', chromeAdapter: adapter, now: clock,
    idFactory: () => 'audit-owned-cancel-retained', signal: controller.signal,
    closeAuditTab: false, expectedExtensionId: TEST_EXTENSION_ID,
  });

  assert.equal(execution.status, 'cancelled');
  assert.equal(execution.model.session.status, 'cancelled');
  assert.equal(execution.ownershipState, 'retained-for-review');
  assert.equal(adapter.counts.removals, 0);
  assert.equal(Object.values(sessionValues).find(value => value?.version === 2)?.state, 'retained-for-review');
  assert.doesNotMatch(JSON.stringify({ execution, sessionValues }), /PRIVATE_RETAINED_ABORT/u);

  const compatibilityController = new AbortController();
  const compatibilityAdapter = fakeAdapter({
    noPixels: true,
    canonicalInternals: true,
    afterCollect: () => compatibilityController.abort(new DOMException('PRIVATE_COMPAT_RETAINED_ABORT', 'AbortError')),
  });
  const draft = await runAudit({
    url: 'https://example.test/', chromeAdapter: compatibilityAdapter, now: clock,
    idFactory: () => 'audit-compat-cancel-retained', signal: compatibilityController.signal,
    closeAuditTab: false, expectedExtensionId: TEST_EXTENSION_ID,
  });
  assert.equal(draft.session.status, 'cancelled');
  assert.equal(draft.progress.at(-1)?.phase, 'cancelled');
  assert.equal(compatibilityAdapter.counts.removals, 0);
  assert.doesNotMatch(JSON.stringify(draft), /PRIVATE_COMPAT_RETAINED_ABORT/u);
});

test('owned cleanup uses the remove effect captured before asynchronous callbacks can mutate the adapter', async () => {
  let adapter;
  let originalCalls = 0;
  let replacementCalls = 0;
  adapter = fakeAdapter({
    noPixels: true,
    canonicalInternals: true,
    afterCollect() {
      adapter.removeTab = async () => { replacementCalls += 1; };
    },
  });
  const originalRemove = adapter.removeTab.bind(adapter);
  adapter.removeTab = async tabId => {
    originalCalls += 1;
    return originalRemove(tabId);
  };

  const execution = await runAuditExecution({
    url: 'https://example.test/',
    chromeAdapter: adapter,
    now: clock,
    idFactory: () => 'audit-owned-remove-toctou',
    expectedExtensionId: TEST_EXTENSION_ID,
    cleanupMode: 'always',
  });

  assert.equal(execution.ownershipState, 'removed');
  assert.equal(originalCalls, 1);
  assert.equal(replacementCalls, 0);
});

test('owned execution captures every browser effect before its first asynchronous boundary', async () => {
  const adapter = fakeAdapter({ noPixels: true, canonicalInternals: true });
  const replacements = [];
  const running = runAuditExecution({
    url: 'https://example.test/', chromeAdapter: adapter, now: clock,
    idFactory: () => 'audit-owned-effect-snapshot', expectedExtensionId: TEST_EXTENSION_ID,
    cleanupMode: 'always',
  });
  for (const name of [
    'createTab', 'navigateTab', 'waitForStable', 'probeDocumentIdentity',
    'getEvidenceUrl', 'getFinalUrl', 'removeTab',
  ]) {
    adapter[name] = async () => {
      replacements.push(name);
      throw new Error(`PRIVATE_REPLACEMENT_${name}`);
    };
  }

  const execution = await running;
  assert.equal(execution.observationState, 'observed');
  assert.equal(execution.ownershipState, 'removed');
  assert.deepEqual(replacements, []);
  assert.doesNotMatch(JSON.stringify(execution), /PRIVATE_REPLACEMENT/u);
});

test('pre-observation owned failure returns failed with no fabricated model or observed target', async () => {
  const sessionValues = {};
  const persisted = [];
  const adapter = fakeAdapter({
    noPixels: true,
    canonicalInternals: true,
    sessionValues,
    createTabFailure: true,
    persistAuditModel: async model => { persisted.push(model); },
  });
  const execution = await runAuditExecution({
    url: 'https://example.test/private?secret=REMOVE',
    chromeAdapter: adapter,
    now: clock,
    idFactory: () => 'audit-owned-pre-observation',
    closeAuditTab: true,
    expectedExtensionId: TEST_EXTENSION_ID,
    pageId: 'page-1',
    cleanupMode: 'always',
  });

  assert.equal(execution.status, 'failed');
  assert.notEqual(execution.status, 'failed-before-observation');
  assert.equal(execution.model, null);
  assert.equal(execution.observedTarget, null);
  assert.equal(execution.observationState, 'pre-observation-failure');
  assert.ok(['removed', 'cleanup-pending'].includes(execution.ownershipState));
  assert.deepEqual(persisted, []);
  assert.equal(adapter.counts.screenshots, 0);
  assert.equal(Object.keys(sessionValues).some(key => key.startsWith('audita:owned-tab:v1:')), false);
  assert.doesNotMatch(JSON.stringify({ execution, sessionValues }), /REMOVE|sessionCapabilityId/u);
});

test('attached execution re-proves inside persistence and commits nothing after document drift', async () => {
  const adapter = fakeAdapter({ noPixels: true });
  let proof = 0;
  adapter.probeDocumentIdentity = async tabId => {
    proof += 1;
    return {
      tabId, windowId: 9,
      documentId: proof >= 3 ? 'document-b' : 'document-a',
      urlSessionDigest: `hmac-sha256:${(proof >= 3 ? 'B' : 'A').repeat(43)}`,
    };
  };
  let persisted = 0;
  const result = await runAttachedAuditExecution({
    auditId: 'audit-attached-drift', sessionCapabilityId: 'S'.repeat(22),
    target: {
      kind: 'attached', tabId: 42, windowId: 9, documentId: 'document-a',
      initialUrlEvidence: 'https://example.test/', initialUrlSessionDigest: `hmac-sha256:${'A'.repeat(43)}`,
    },
    capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    chromeAdapter: adapter, modelNow: clock, expectedExtensionId: TEST_EXTENSION_ID,
    onCheckpoint: async () => {}, persistAuditModel: async () => { persisted += 1; },
  });
  assert.deepEqual({ state: result.state, code: result.failureCode, model: result.model }, {
    state: 'revoked', code: 'TARGET_CHANGED', model: null,
  });
  assert.equal(persisted, 0);
});

test('attached execution classifies a divergent first document proof as TARGET_CHANGED', async () => {
  const adapter = fakeAdapter({ noPixels: true });
  adapter.probeDocumentIdentity = async tabId => ({
    tabId,
    windowId: 9,
    documentId: 'document-b',
    urlSessionDigest: `hmac-sha256:${'B'.repeat(43)}`,
  });
  let persisted = 0;

  const result = await runAttachedAuditExecution({
    auditId: 'audit-attached-first-proof-drift', sessionCapabilityId: 'S'.repeat(22),
    target: {
      kind: 'attached', tabId: 42, windowId: 9, documentId: 'document-a',
      initialUrlEvidence: TEST_EVIDENCE_URL, initialUrlSessionDigest: TEST_DIGEST,
    },
    capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    chromeAdapter: adapter, modelNow: clock, expectedExtensionId: TEST_EXTENSION_ID,
    onCheckpoint: async () => {}, persistAuditModel: async () => { persisted += 1; },
  });

  assert.deepEqual({ state: result.state, failureCode: result.failureCode, model: result.model }, {
    state: 'revoked', failureCode: 'TARGET_CHANGED', model: null,
  });
  assert.equal(persisted, 0);
});

test('attached execution persists a dependency AbortError as failed when its signal is not aborted', async () => {
  const adapter = fakeAdapter({
    noPixels: true,
    collectError: new DOMException('PRIVATE_ABORT_DETAIL', 'AbortError'),
  });
  let persisted = 0;
  const result = await runAttachedAuditExecution({
    auditId: 'audit-attached-abort-spoof', sessionCapabilityId: 'S'.repeat(22),
    target: {
      kind: 'attached', tabId: 42, windowId: 9, documentId: 'document-a',
      initialUrlEvidence: 'https://example.test/', initialUrlSessionDigest: `hmac-sha256:${'A'.repeat(43)}`,
    },
    capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    chromeAdapter: adapter, modelNow: clock, expectedExtensionId: TEST_EXTENSION_ID,
    onCheckpoint: async () => {}, persistAuditModel: async () => { persisted += 1; },
  });
  assert.equal(result.state, 'model');
  assert.equal(result.failureCode, null);
  assert.equal(result.model.session.status, 'failed');
  assert.equal(result.model.pages[0].status, 'failed');
  assert.equal(persisted, 1);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_ABORT_DETAIL/u);
});

test('attached execution persists and returns a canonical failed terminal model', async () => {
  const adapter = fakeAdapter({ noPixels: true, collectFailure: true });
  const persisted = [];
  const result = await runAttachedAuditExecution({
    auditId: 'audit-attached-failed-model', sessionCapabilityId: 'S'.repeat(22),
    target: {
      kind: 'attached', tabId: 42, windowId: 9, documentId: 'document-a',
      initialUrlEvidence: TEST_EVIDENCE_URL, initialUrlSessionDigest: TEST_DIGEST,
    },
    capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    chromeAdapter: adapter, modelNow: clock, expectedExtensionId: TEST_EXTENSION_ID,
    onCheckpoint: async () => {}, persistAuditModel: async model => { persisted.push(model); },
  });

  assert.equal(result.state, 'model');
  assert.equal(result.failureCode, null);
  assert.equal(result.model.session.status, 'failed');
  assert.equal(persisted.length, 1);
  assert.deepEqual(persisted[0], result.model);
});

test('attached execution preserves a canonical cancelled model for a genuinely aborted signal', async () => {
  const controller = new AbortController();
  const adapter = fakeAdapter({
    noPixels: true,
    afterCollect() { controller.abort(new DOMException('PRIVATE_USER_CANCEL_DETAIL', 'AbortError')); },
  });
  const result = await runAttachedAuditExecution({
    auditId: 'audit-attached-real-abort', sessionCapabilityId: 'S'.repeat(22),
    target: {
      kind: 'attached', tabId: 42, windowId: 9, documentId: 'document-a',
      initialUrlEvidence: 'https://example.test/', initialUrlSessionDigest: `hmac-sha256:${'A'.repeat(43)}`,
    },
    capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    chromeAdapter: adapter, modelNow: clock, signal: controller.signal,
    expectedExtensionId: TEST_EXTENSION_ID, onCheckpoint: async () => {}, persistAuditModel: async () => {},
  });
  assert.equal(result.state, 'model');
  assert.equal(result.failureCode, null);
  assert.equal(result.model.session.status, 'cancelled');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_USER_CANCEL_DETAIL/u);
});

test('attached execution never persists complete when cancellation wins the final document proof', async () => {
  const controller = new AbortController();
  const adapter = fakeAdapter({ noPixels: true });
  let proofCount = 0;
  adapter.probeDocumentIdentity = async tabId => {
    proofCount += 1;
    if (proofCount === 3) controller.abort(new Error('PRIVATE_FINAL_PROOF_CANCEL_DETAIL'));
    return {
      tabId,
      windowId: 9,
      documentId: 'document-a',
      urlSessionDigest: `hmac-sha256:${'A'.repeat(43)}`,
    };
  };
  const persisted = [];

  const result = await runAttachedAuditExecution({
    auditId: 'audit-attached-final-proof-abort', sessionCapabilityId: 'S'.repeat(22),
    target: {
      kind: 'attached', tabId: 42, windowId: 9, documentId: 'document-a',
      initialUrlEvidence: 'https://example.test/', initialUrlSessionDigest: `hmac-sha256:${'A'.repeat(43)}`,
    },
    capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    chromeAdapter: adapter, modelNow: clock, signal: controller.signal,
    expectedExtensionId: TEST_EXTENSION_ID, onCheckpoint: async () => {},
    persistAuditModel: async model => { persisted.push(model); },
  });

  assert.equal(controller.signal.aborted, true);
  assert.equal(result.state, 'model');
  assert.equal(result.model.session.status, 'cancelled');
  assert.equal(persisted.length, 0);
  assert.equal(result.model.progress, undefined, 'o V2 persistido não retém telemetria transitória de progresso');
  assert.equal(result.model.session.diagnostics.find(entry =>
    ['AUDIT_ABORTED', 'NAVIGATION_FAILED'].includes(entry.code) && entry.recoverable === false)?.at,
  result.model.timestamps.endedAt);
  assert.equal(result.model.report.status, 'pending');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_FINAL_PROOF_CANCEL_DETAIL/u);
});

test('attached final proof failure takes precedence over a simultaneous cancellation', async t => {
  for (const scenario of [
    { name: 'target-changed', failureCode: 'TARGET_CHANGED' },
    { name: 'proof-unavailable', failureCode: 'AUDIT_FAILED' },
  ]) await t.test(scenario.name, async () => {
    const controller = new AbortController();
    const adapter = fakeAdapter({ noPixels: true });
    let proofCount = 0;
    adapter.probeDocumentIdentity = async tabId => {
      proofCount += 1;
      if (proofCount === 3) {
        controller.abort(new DOMException('PRIVATE_FINAL_PROOF_ABORT', 'AbortError'));
        if (scenario.name === 'proof-unavailable') throw new Error('PRIVATE_FINAL_PROOF_UNAVAILABLE');
        return {
          tabId, windowId: 9, documentId: 'document-b',
          urlSessionDigest: `hmac-sha256:${'B'.repeat(43)}`,
        };
      }
      return {
        tabId, windowId: 9, documentId: 'document-a',
        urlSessionDigest: `hmac-sha256:${'A'.repeat(43)}`,
      };
    };
    let persisted = 0;

    const result = await runAttachedAuditExecution({
      auditId: `audit-attached-final-proof-${scenario.name}`,
      sessionCapabilityId: 'S'.repeat(22),
      target: {
        kind: 'attached', tabId: 42, windowId: 9, documentId: 'document-a',
        initialUrlEvidence: 'https://example.test/', initialUrlSessionDigest: `hmac-sha256:${'A'.repeat(43)}`,
      },
      capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
      chromeAdapter: adapter, modelNow: clock, signal: controller.signal,
      expectedExtensionId: TEST_EXTENSION_ID, onCheckpoint: async () => {},
      persistAuditModel: async () => { persisted += 1; },
    });

    assert.equal(result.state, 'revoked');
    assert.equal(result.failureCode, scenario.failureCode);
    assert.equal(result.model, null);
    assert.equal(persisted, 0);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_FINAL_PROOF_ABORT|PRIVATE_FINAL_PROOF_UNAVAILABLE/u);
  });
});

test('attached runner proof unavailability cannot be reclassified as cancellation', async () => {
  const controller = new AbortController();
  const adapter = fakeAdapter({ noPixels: true });
  let proofCount = 0;
  adapter.probeDocumentIdentity = async tabId => {
    proofCount += 1;
    if (proofCount === 2) {
      controller.abort(new DOMException('PRIVATE_RUNNER_PROOF_ABORT', 'AbortError'));
      throw new Error('PRIVATE_RUNNER_PROOF_UNAVAILABLE');
    }
    return {
      tabId, windowId: 9, documentId: 'document-a',
      urlSessionDigest: `hmac-sha256:${'A'.repeat(43)}`,
    };
  };
  let persisted = 0;

  const result = await runAttachedAuditExecution({
    auditId: 'audit-attached-runner-proof-unavailable',
    sessionCapabilityId: 'S'.repeat(22),
    target: {
      kind: 'attached', tabId: 42, windowId: 9, documentId: 'document-a',
      initialUrlEvidence: 'https://example.test/', initialUrlSessionDigest: `hmac-sha256:${'A'.repeat(43)}`,
    },
    capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    chromeAdapter: adapter, modelNow: clock, signal: controller.signal,
    expectedExtensionId: TEST_EXTENSION_ID, onCheckpoint: async () => {},
    persistAuditModel: async () => { persisted += 1; },
  });

  assert.equal(proofCount, 2);
  assert.equal(result.state, 'revoked');
  assert.equal(result.failureCode, 'AUDIT_FAILED');
  assert.equal(result.model, null);
  assert.equal(persisted, 0);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_RUNNER_PROOF_ABORT|PRIVATE_RUNNER_PROOF_UNAVAILABLE/u);
});

test('attached execution rejects hostile or extra façade fields before probing', async () => {
  const adapter = fakeAdapter({ noPixels: true });
  let reads = 0;
  const args = {
    auditId: 'audit-hostile-facade', sessionCapabilityId: 'S'.repeat(22),
    target: {
      kind: 'attached', tabId: 42, windowId: 9, documentId: 'document-a',
      initialUrlEvidence: 'https://example.test/', initialUrlSessionDigest: `hmac-sha256:${'A'.repeat(43)}`,
    },
    capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    chromeAdapter: adapter, modelNow: clock, signal: undefined,
    expectedExtensionId: TEST_EXTENSION_ID, onCheckpoint: async () => {}, persistAuditModel: async () => {},
    extra: 'PRIVATE',
  };
  Object.defineProperty(args, 'auditId', { enumerable: true, get() { reads += 1; return 'audit-hostile-facade'; } });
  await assert.rejects(runAttachedAuditExecution(args), /ATTACHED_AUDIT_EXECUTION_DENIED/u);
  assert.equal(reads, 0);
  assert.equal(adapter.events.length, 0);
});

test('uses one conservative durable URL projection and exposes no model before observation', async () => {
  const rawUrl = 'https://example.test/pessoa/CPF-123456789?case=7&secret=x#fragmento';
  const model = await runAudit({
    url: rawUrl, chromeAdapter: fakeAdapter({ noPixels: true }),
    now: clock, idFactory: () => 'audit-safe-url-success',
  });
  const failed = await runAuditExecution({
    url: rawUrl, chromeAdapter: fakeAdapter({ noPixels: true, canonicalInternals: true, waitFailure: new Error('PRIVATE_NATIVE_URL') }),
    now: clock, idFactory: () => 'audit-safe-url-failure',
  });
  assert.deepEqual({
    requestedUrl: model.requestedUrl,
    finalUrl: model.finalUrl,
    snapshotUrl: model.snapshot?.document?.url ?? null,
  }, {
    requestedUrl: 'https://example.test/pessoa/:redacted-2', finalUrl: 'https://example.test/final',
    snapshotUrl: 'https://example.test/',
  });
  assert.equal(failed.observationState, 'pre-observation-failure');
  assert.equal(failed.model, null);
  assert.equal(failed.observedTarget, null);
  const durable = JSON.stringify({ model, failed });
  assert.match(durable, /https:\/\/example\.test/u);
  assert.doesNotMatch(durable, /CPF-123456789|case=7|secret=x|fragmento|PRIVATE_NATIVE_URL|\?case=7|&secret=x/u);
});

test('forces legacy element-only and full-evidence hints through the canonical no-pixels boundary', async () => {
  const elementOnly = fakeAdapter({ mode: 'element-only', trackCaptureCalls: true });
  const elementModel = await runAudit({
    url: 'https://example.test/', chromeAdapter: elementOnly, now: clock, idFactory: () => 'audit-element-only',
  });
  assert.equal(elementOnly.counts.fullPageCalls, 0);
  assert.equal(elementOnly.counts.elementCalls, 0);
  assert.equal(elementModel.evidence.artifacts.some(artifact => artifact.kind === 'full-page'), false);
  assert.equal(elementModel.evidence.artifacts.some(artifact => artifact.kind === 'announcement-map'), false);
  const element = elementModel.evidence.artifacts.find(artifact => artifact.kind === 'element');
  assert.ok(element);
  assert.equal(Object.hasOwn(element, 'dataUrl'), false);
  assert.equal(Object.hasOwn(element, 'fullPageEvidenceId'), false);

  const noPixels = fakeAdapter({ mode: 'no-pixels', trackCaptureCalls: true });
  await runAudit({ url: 'https://example.test/', chromeAdapter: noPixels, now: clock, idFactory: () => 'audit-no-pixels-route' });
  assert.equal(noPixels.counts.screenshots, 0);
  assert.equal(noPixels.counts.fullPageCalls, 0);
  assert.equal(noPixels.counts.elementCalls, 0);

  const full = fakeAdapter({ mode: 'full-evidence', trackCaptureCalls: true });
  const fullModel = await runAudit({ url: 'https://example.test/', chromeAdapter: full, now: clock, idFactory: () => 'audit-full-route' });
  assert.equal(full.counts.screenshots, 0);
  assert.equal(full.counts.fullPageCalls, 0);
  assert.equal(full.counts.elementCalls, 0);
  assert.equal(fullModel.evidence.artifacts.some(artifact => artifact.kind === 'full-page'), false);
  assert.equal(fullModel.evidence.artifacts.some(artifact => artifact.kind === 'element' && artifact.dataUrl), false);
});

test('orders capture→axe→collect→probes→core→normalize, correlates target-size by node and drops raw axe', async () => {
  const page = rawPage();
  page.nodes = [
    { backendNodeId: 10, tagName: 'html', attributes: {}, text: '', parentBackendNodeId: null, rect: { x: 0, y: 0, width: 800, height: 600 } },
    { backendNodeId: 11, tagName: 'body', attributes: {}, text: '', parentBackendNodeId: 10, rect: { x: 0, y: 0, width: 800, height: 600 } },
    { backendNodeId: 12, tagName: 'button', attributes: { id: 'continue-button' }, text: 'Continuar', parentBackendNodeId: 11, rect: { x: 10, y: 20, width: 20, height: 20 } },
  ];
  const options = {
    page,
    rawProbes: {
      focus: { completed: false, events: [] },
      targetSizes: [{ nodeId: 'n-12', width: 20, height: 20, exception: 'none', exceptionProof: 'complete' }],
      warnings: [], actions: [],
    },
  };
  const adapter = fakeAdapter(options);
  let normalizeObserved = false;
  options.axeRun = new Proxy({
    status: 'complete', provenance: AXE_PROVENANCE, diagnostics: [], privateRaw: 'AXE_RAW_PRIVATE_SENTINEL',
    frames: [{ frameId: 0, status: 'success', result: {
      violations: [{ id: 'target-size', impact: 'serious', nodes: [{ impact: 'serious', target: 'html > body > button' }] }],
      incomplete: [], passes: [], inapplicable: [],
    } }],
  }, {
    getOwnPropertyDescriptor(target, property) {
      if (!normalizeObserved) {
        normalizeObserved = true;
        adapter.events.push('normalize-axe');
      }
      return Reflect.getOwnPropertyDescriptor(target, property);
    },
  });

  const model = await runAudit({
    url: 'https://example.test/', chromeAdapter: adapter,
    now: clock, idFactory: () => 'audit-target-size-order',
  });
  const axe = model.occurrences.find(occurrence => occurrence.ruleId === 'axe.target-size');
  const core = model.occurrences.find(occurrence => occurrence.ruleId === 'target-size-minimum');

  assert.ok(adapter.events.indexOf('full-page') < adapter.events.indexOf('axe'));
  assert.ok(adapter.events.indexOf('axe') < adapter.events.indexOf('collect'));
  assert.ok(adapter.events.indexOf('collect') < adapter.events.indexOf('probes'));
  assert.ok(adapter.events.indexOf('probes') < adapter.events.indexOf('normalize-axe'));
  assert.equal(core.outcome, 'failed');
  assert.equal(core.nodeId, 'n-12');
  assert.equal(axe.outcome, 'failed', 'conclusion proves core authority existed before axe normalization');
  assert.equal(axe.nodeId, 'n-12');
  assert.equal(axe.applicabilityEvidence.nodeId, 'n-12');
  const group = model.presentation.groups.find(entry => entry.occurrenceIds.includes(core.occurrenceId));
  assert.deepEqual(group.occurrenceIds, [core.occurrenceId, axe.occurrenceId]);
  assert.doesNotMatch(JSON.stringify(model), /AXE_RAW_PRIVATE_SENTINEL/u);

  const reportOptions = {
    now: () => '2026-08-26T16:00:00.000Z', timezone: 'America/Cuiaba',
    manifestVersion: '0.1.0', rulesVersion: '1.0.0', browserVersion: 'Chrome/147.0.0.0',
  };
  const report = await enrichAuditForReport(model, reportOptions);
  assert.doesNotThrow(() => createAuditModel(report));
  assert.doesNotThrow(() => renderHtmlReport(report));
  const axeReportOccurrence = report.occurrences.find(occurrence => occurrence.ruleId === 'axe.target-size');
  const correlatedEvidence = report.evidence.find(evidence =>
    axeReportOccurrence.evidenceRefs.includes(evidence.evidenceId) && evidence.nodeId === axeReportOccurrence.nodeId);
  assert.equal(axeReportOccurrence.target.selector, 'html > body > button');
  assert.equal(correlatedEvidence.selector.css, '#continue-button');
  const inventory = await createInstalledCoreRuleInventory();
  const checkpoint = {
    version: 1, auditId: report.auditId,
    pages: [{
      pageId: 'page-1', attempted: true, startedAt: report.pages[0].timestamps.startedAt,
      rulesVersion: inventory.rulesVersion, inventoryVersion: inventory.inventoryVersion,
      inventoryHash: inventory.sha256,
      outcomes: [{ ruleId: 'target-size-minimum', outcome: core.outcome }],
    }],
  };
  const bundle = await createPanelResultBundleV1({
    inventory,
    reportRevision: {
      version: 1, auditId: report.auditId, modelRevision: 1,
      modelHash: report.integrity.canonicalModelHash, model: report, checkpoint,
    },
  });
  assert.equal(bundle.details.find(detail => detail.occurrenceId === axeReportOccurrence.occurrenceId).technical.selector,
    'html > body > button');
  const technical = JSON.parse(renderTechnicalJson(report));
  assert.equal(technical.assertions.length, 146);
  assert.deepEqual(technical.audit, report);

  const attacks = [
    candidate => {
      candidate.occurrences.find(value => value.ruleId === 'axe.target-size').applicabilityEvidence.nodeId = 'n-11';
      candidate.axe.occurrences.find(value => value.ruleId === 'axe.target-size').applicabilityEvidence.nodeId = 'n-11';
    },
    candidate => {
      candidate.occurrences.push(structuredClone(candidate.occurrences.find(value => value.ruleId === 'axe.target-size')));
      candidate.axe.occurrences.push(structuredClone(candidate.axe.occurrences.find(value => value.ruleId === 'axe.target-size')));
    },
    candidate => {
      candidate.occurrences.find(value => value.ruleId === 'axe.target-size').outcome = 'cantTell';
      candidate.axe.occurrences.find(value => value.ruleId === 'axe.target-size').outcome = 'cantTell';
    },
  ];
  for (const mutate of attacks) {
    const candidate = structuredClone(report);
    mutate(candidate);
    candidate.integrity.canonicalModelHash = 'pending';
    candidate.integrity.evidenceManifestHash = 'pending';
    assert.throws(() => createAuditModel(candidate), /modelo|axe|inválid|ocorrência/iu);
    await assert.rejects(enrichAuditForReport(candidate, reportOptions), /modelo|axe|inválid|ocorrência/iu);
    assert.throws(() => renderHtmlReport(candidate), /modelo|axe|inválid|ocorrência/iu);
    assert.throws(() => renderTechnicalJson(candidate), /modelo|axe|inválid|ocorrência/iu);
  }
});

test('does not invoke the map compositor while the public façade is in no-pixels mode', async () => {
  let pristineBefore;
  let pristineAfter;
  let observedDeviceScaleFactor;
  const adapter = fakeAdapter({
    composeMap: async input => {
      observedDeviceScaleFactor = input.layoutMetrics.deviceScaleFactor;
      pristineBefore = JSON.stringify(input.fullPageEvidence);
      const artifact = await createAnnotationMapFixture({ sourceEvidenceId: input.fullPageEvidence.evidenceId });
      pristineAfter = JSON.stringify(input.fullPageEvidence);
      return artifact;
    },
  });
  const model = await runAudit({
    url: 'https://example.test/', chromeAdapter: adapter,
    now: clock, idFactory: () => 'audit-annotation-map',
  });
  const map = model.evidence.artifacts.find(artifact => artifact.kind === 'announcement-map');
  const pristine = model.evidence.artifacts.find(artifact => artifact.kind === 'full-page');

  assert.equal(map, undefined);
  assert.equal(pristine, undefined);
  assert.equal(pristineBefore, undefined);
  assert.equal(pristineAfter, undefined);
  assert.equal(observedDeviceScaleFactor, undefined);
  assert.equal(adapter.events.includes('map'), false);
  assert.equal(model.session.status, 'complete');
  assert.ok(model.session.diagnostics.some(entry => entry.code === 'PIXEL_CAPTURE_OMITTED'));
});

test('does not expose a dormant map compositor failure while pixels are disabled', async () => {
  const adapter = fakeAdapter({
    mapFailure: Object.assign(new Error('PRIVATE-RAW-ERROR'), { code: 'ANNOTATION_MAP_COMPOSITOR_UNAVAILABLE' }),
  });
  const model = await runAudit({
    url: 'https://example.test/', chromeAdapter: adapter,
    now: clock, idFactory: () => 'audit-annotation-map-failure',
  });

  assert.equal(model.evidence.artifacts.some(artifact => artifact.kind === 'full-page'), false);
  assert.equal(model.evidence.artifacts.some(artifact => artifact.kind === 'announcement-map'), false);
  assert.equal(model.session.status, 'complete');
  assert.equal(model.session.diagnostics.some(entry => entry.code === 'ANNOTATION_MAP_COMPOSITOR_UNAVAILABLE'), false);
  assert.equal(adapter.events.includes('map'), false);
  assert.doesNotMatch(JSON.stringify(model), /PRIVATE-RAW-ERROR/u);
});

test('does not claim a printable-segment map failure when the compositor never ran', async () => {
  const adapter = fakeAdapter({
    mapFailure: Object.assign(new Error('PRIVATE-RAW-ERROR'), { code: 'ANNOTATION_MAP_PRINT_SEGMENT_LIMIT' }),
  });
  const model = await runAudit({
    url: 'https://example.test/', chromeAdapter: adapter,
    now: clock, idFactory: () => 'audit-annotation-map-print-limit',
  });

  assert.equal(model.session.status, 'complete');
  assert.equal(model.session.diagnostics.some(entry => entry.code === 'ANNOTATION_MAP_PRINT_SEGMENT_LIMIT'), false);
  assert.equal(adapter.events.includes('map'), false);
  assert.doesNotMatch(JSON.stringify(model), /PRIVATE-RAW-ERROR/u);
});

test('integrates the recommendation failure, editorial occurrence and informational widget inventory without cross-contamination', async () => {
  const page = rawPage();
  page.nodes.push(
    {
      backendNodeId: 20, tagName: 'a', attributes: { href: '/ajuda', target: '  _BLANK  ' },
      text: 'Ajuda', visibleText: 'Ajuda', parentBackendNodeId: null,
      adjacentNewWindowWarning: false, linkPurposeContext: 'missing-context',
      rect: { x: 10, y: 200, width: 80, height: 24 },
    },
    {
      backendNodeId: 21, tagName: 'p', attributes: {},
      text: 'Lorem ipsum PRIVATE-MATCH-SENTINEL', visibleText: 'Lorem ipsum PRIVATE-MATCH-SENTINEL',
      parentBackendNodeId: null, rect: { x: 10, y: 240, width: 300, height: 40 },
    },
  );
  page.axTree.nodes.push({
    backendDOMNodeId: 20, role: { value: 'link' }, name: { value: 'Ajuda' },
  });
  page.widgetObservations = {
    coverage: 'complete', widgets: {
      vlibras: { dom: true, script: false, global: false },
      'hand-talk': { dom: false, script: false, global: false },
    },
  };
  const snippetNodeIds = [];
  const model = await runAudit({
    url: 'https://example.test/',
    chromeAdapter: fakeAdapter({ page, afterSnippet: backendNodeId => snippetNodeIds.push(backendNodeId) }),
    now: clock, idFactory: () => 'audit-complementary',
  });

  assert.equal(model.methodology.coreRuleCount, 130);
  assert.equal(model.itemResults.length, 146);
  assert.equal(model.itemResults.find(item => item.id === '5.7.6').outcome, 'failed');
  assert.deepEqual(model.accessibilityWidgets, {
    detector: 'audita.accessibility-widgets', version: '1.0.0', coverage: 'complete',
    widgets: [
      { id: 'vlibras', status: 'present', signals: ['dom-signature'] },
      { id: 'hand-talk', status: 'absent', signals: [] },
    ],
  });
  assert.equal(model.ruleResults.some(rule => rule.ruleId === 'vlibras' || rule.ruleId === 'hand-talk'), false);

  const editorialRule = model.ruleResults.find(rule => rule.ruleId === 'editorial.placeholder-text');
  const editorial = model.occurrences.find(occurrence => occurrence.ruleId === 'editorial.placeholder-text');
  const newWindow = model.occurrences.find(occurrence => occurrence.ruleId === 'new-window-link-warning');
  assert.equal(editorialRule.outcome, 'failed');
  assert.equal(editorial.itemId, null);
  assert.equal(editorial.nbrItemRef, null);
  assert.deepEqual(editorial.evidenceIds, []);
  assert.deepEqual(editorial.target, { nodeId: 'n-21', selector: null, framePath: [] });
  assert.equal(model.manualReview.some(entry => entry.occurrenceId === editorial.occurrenceId), false);
  assert.equal(snippetNodeIds.includes(21), false);
  assert.equal(newWindow.itemId, '5.7.6');
  assert.equal(newWindow.outcome, 'failed');

  const report = await enrichAuditForReport(model, {
    now: () => '2026-08-26T16:00:00.000Z', timezone: 'America/Cuiaba',
    manifestVersion: '0.1.0', rulesVersion: '1.0.0', browserVersion: 'Chrome/147.0.0.0',
  });
  const reportEditorial = report.occurrences.find(occurrence => occurrence.ruleId === 'editorial.placeholder-text');
  const reportNewWindow = report.occurrences.find(occurrence => occurrence.ruleId === 'new-window-link-warning');
  assert.deepEqual(reportEditorial.wcagRefs, []);
  assert.deepEqual(reportEditorial.foreignBenchmarkRefs, []);
  assert.deepEqual(reportEditorial.evidenceRefs, []);
  assert.equal(reportEditorial.accessiblePreview, null);
  assert.equal(reportEditorial.legalAnalysis, null);
  assert.deepEqual(reportNewWindow.reason, {
    code: 'missing-new-window-warning',
    context: { behavior: 'target-blank', warning: 'absent' },
  });
  assert.deepEqual(reportNewWindow.itemWcagRefs, ['2.4.4', '2.4.9', '3.2.5']);
  assert.deepEqual(reportNewWindow.sourceWcagRefs, []);
  assert.deepEqual(reportNewWindow.testedWcagRefs, []);
  assert.deepEqual(reportNewWindow.wcagRefs, []);
  assert.deepEqual(reportNewWindow.foreignBenchmarkRefs, []);
  assert.deepEqual(reportNewWindow.legalAnalysis, { basisRef: 'br.consumer.accessibility.fixed.v2' });
  assert.equal(reportNewWindow.classification, 'recommendation');
  assert.deepEqual(reportNewWindow.legalAnalysis, { basisRef: 'br.consumer.accessibility.fixed.v2' });
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE-MATCH-SENTINEL/iu);
});

test('rejects a forged disabled axe payload even when the report has no axe findings', async () => {
  const model = await runAudit({
    url: 'https://example.test/', chromeAdapter: fakeAdapter(),
    now: clock, idFactory: () => 'audit-disabled-axe-boundary',
  });
  for (const mutate of [
    value => { value.axe.privateText = 'Paciente HIV positivo'; },
    value => { value.axe.diagnostics[0].privateText = 'Paciente HIV positivo'; },
    value => { value.axe.technicalSummary.passes.nodes = 1; },
  ]) {
    const forged = structuredClone(model);
    mutate(forged);
    await assert.rejects(enrichAuditForReport(forged, {
      now: () => '2026-08-26T16:00:00.000Z', timezone: 'America/Cuiaba',
      manifestVersion: '0.1.0', rulesVersion: '1.0.0', browserVersion: 'Chrome/147.0.0.0',
    }), /axe|inválid|esquema|resumo/i);
  }
});

test('integrates a confirmed top-frame axe violation with provenance, ABNT outcome and fixed legal reference', async t => {
  const page = rawPage();
  page.document.language = '';
  const axeRun = {
    status: 'complete', provenance: AXE_PROVENANCE, diagnostics: [],
    frames: [{ frameId: 0, status: 'success', result: {
      violations: [{
        id: 'html-has-lang', impact: 'serious', tags: ['wcag2a', 'wcag311', 'section508'],
        nodes: [{ impact: 'serious', target: ['html'], html: '<html data-private="NÃO-PERSISTIR">', failureSummary: 'NÃO-PERSISTIR' }],
      }],
      incomplete: [], passes: [{ id: 'document-title', nodes: [] }], inapplicable: [],
    } }],
  };
  const adapter = fakeAdapter({ page, axeRun });
  const model = await runAudit({
    url: 'https://example.test/', chromeAdapter: adapter,
    now: clock, idFactory: () => 'audit-axe-confirmed',
  });
  const axeOccurrence = model.occurrences.find(occurrence => occurrence.source?.engine === 'axe-core');
  const coreOccurrence = model.occurrences.find(occurrence => occurrence.ruleId === 'page-language');

  assert.equal(model.ruleResults.length, 132);
  assert.equal(model.itemResults.find(item => item.id === '5.13.2').outcome, 'failed');
  assert.equal(axeOccurrence.outcome, 'failed');
  assert.equal(axeOccurrence.itemId, '5.13.2');
  assert.equal(axeOccurrence.applicabilityEvidence.source.ruleId, 'page-language');
  assert.deepEqual(axeOccurrence.legalAnalysis, { basisRef: 'br.consumer.accessibility.fixed.v2' });
  assert.equal(axeOccurrence.nodeId, null);
  assert.deepEqual(axeOccurrence.evidenceIds, []);
  assert.equal(model.evidence.artifacts.some(item => item.kind === 'full-page'), false);
  assert.equal(model.axe.provenance.version, '4.13.0');
  assert.equal(model.axe.provenance.config.rules['target-size'].enabled, true);
  assert.equal(model.ruleResults.some(rule => rule.outcome === 'passed' && rule.source?.engine === 'axe-core'), false);
  assert.doesNotMatch(JSON.stringify(model), /NÃO-PERSISTIR|section508/iu);
  assert.ok(adapter.events.indexOf('axe') < adapter.events.indexOf('collect'));
  assert.ok(adapter.events.indexOf('axe') < adapter.events.indexOf('probes'));
  assert.ok(coreOccurrence);
  const corroboratedGroup = model.presentation.groups.find(group =>
    group.occurrenceIds.includes(coreOccurrence.occurrenceId));
  assert.deepEqual(corroboratedGroup.occurrenceIds, [coreOccurrence.occurrenceId, axeOccurrence.occurrenceId]);
  assert.deepEqual(corroboratedGroup.sources.map(source => source.engine), ['audita-core', 'axe-core']);
  assert.ok(corroboratedGroup.occurrenceIds.every(id => model.occurrences.some(occurrence => occurrence.occurrenceId === id)));

  const report = await enrichAuditForReport(model, {
    now: () => '2026-08-26T16:00:00.000Z', timezone: 'America/Cuiaba',
    manifestVersion: '0.1.0', rulesVersion: '1.0.0', browserVersion: 'Chrome/147.0.0.0',
  });
  const reportOccurrence = report.occurrences.find(occurrence => occurrence.source.engine === 'axe-core');
  assert.equal(report.schemaVersion, 2);
  assert.equal(reportOccurrence.target.selector, 'html');
  assert.equal(reportOccurrence.impact, 'serious');
  assert.equal(reportOccurrence.confidence, 'high');
  assert.deepEqual(reportOccurrence.legalAnalysis, { basisRef: 'br.consumer.accessibility.fixed.v2' });
  assert.deepEqual(reportOccurrence.wcagRefs, reportOccurrence.testedWcagRefs);
  assert.deepEqual(reportOccurrence.foreignBenchmarkRefs.map(reference => reference.criterionId), reportOccurrence.testedWcagRefs);
  const forgedResultType = structuredClone(report);
  forgedResultType.occurrences.find(occurrence => occurrence.source.engine === 'axe-core').engineResultType = 'incomplete';
  await assert.rejects(enrichAuditForReport(forgedResultType, {
    now: () => '2026-08-26T16:00:00.000Z', timezone: 'America/Cuiaba',
    manifestVersion: '0.1.0', rulesVersion: '1.0.0', browserVersion: 'Chrome/147.0.0.0',
  }), /axe|suplement|diverge|inválid/i);

  const mutations = [
    ['axe summary', value => { value.ruleResults.find(rule => rule.source?.engine === 'axe-core').summary = 'Prontuário privado Oliveira'; }],
    ['axe justification', value => { value.occurrences.find(item => item.source?.engine === 'axe-core').justification = 'Prontuário privado Oliveira'; }],
    ['axe rule extra field', value => { value.ruleResults.find(rule => rule.source?.engine === 'axe-core').privateText = 'Prontuário privado Oliveira'; }],
    ['axe occurrence extra field', value => { value.occurrences.find(item => item.source?.engine === 'axe-core').privateText = 'Prontuário privado Oliveira'; }],
    ['axe target extra field', value => { value.occurrences.find(item => item.source?.engine === 'axe-core').target.privateText = 'Prontuário privado Oliveira'; }],
    ['ABNT aggregate divergence', value => { value.itemResults.find(item => item.id === '5.13.2').outcome = 'cantTell'; }],
    ['axe identity divergence', value => {
      const rule = value.ruleResults.find(item => item.source?.engine === 'axe-core');
      const occurrence = value.occurrences.find(item => item.source?.engine === 'axe-core');
      const normalizedRule = value.axe.ruleResults[0];
      const normalizedOccurrence = value.axe.occurrences[0];
      for (const target of [rule, normalizedRule]) {
        target.ruleId = 'axe.fake-rule'; target.engineRuleId = 'fake-rule';
        target.source.ruleId = 'axe.fake-rule'; target.source.engineRuleId = 'fake-rule';
      }
      for (const target of [occurrence, normalizedOccurrence]) {
        target.ruleId = 'axe.fake-rule'; target.engineRuleId = 'fake-rule';
        target.source.ruleId = 'axe.fake-rule'; target.source.engineRuleId = 'fake-rule';
      }
    }],
  ];
  for (const [name, mutate] of mutations) await t.test(name, async () => {
      const forged = structuredClone(model);
      mutate(forged);
      await assert.rejects(enrichAuditForReport(forged, {
        now: () => '2026-08-26T16:00:00.000Z', timezone: 'America/Cuiaba',
        manifestVersion: '0.1.0', rulesVersion: '1.0.0', browserVersion: 'Chrome/147.0.0.0',
      }), /axe|suplement|autoritativ|diverge|inválid/i);
    });
});

test('preserves the canonical axe selector target when evidence independently resolves the same element', async () => {
  const page = rawPage();
  page.nodes.push({
    backendNodeId: 4,
    tagName: 'img',
    attributes: { src: '/missing-alt.png' },
    text: '',
    parentBackendNodeId: null,
    rect: { x: 10, y: 300, width: 80, height: 80 },
  });
  const axeRun = {
    status: 'complete', provenance: AXE_PROVENANCE, diagnostics: [],
    frames: [{ frameId: 0, status: 'success', result: {
      violations: [{
        id: 'image-alt', impact: 'critical',
        nodes: [{ impact: 'critical', target: ['img'] }],
      }],
      incomplete: [], passes: [], inapplicable: [],
    } }],
  };

  const model = await runAudit({
    url: 'https://example.test/', chromeAdapter: fakeAdapter({ page, axeRun }),
    now: clock, idFactory: () => 'audit-axe-selector-evidence',
  });
  const projected = model.occurrences.find(occurrence => occurrence.source?.engine === 'axe-core');
  const normalized = model.axe.occurrences.find(occurrence => occurrence.occurrenceId === projected?.occurrenceId);

  assert.equal(projected.nodeId, null);
  assert.equal(normalized.nodeId, null);
  assert.equal(projected.presentationTargetKey, normalized.presentationTargetKey);
  assert.equal(projected.presentationTargetKey, 'selector:0:img');
  await assert.doesNotReject(enrichAuditForReport(model, {
    now: () => '2026-08-26T16:00:00.000Z', timezone: 'America/Cuiaba',
    manifestVersion: '0.1.0', rulesVersion: '1.0.0', browserVersion: 'Chrome/147.0.0.0',
  }));
});

test('keeps a conclusive axe occurrence auditable when pixels are deliberately omitted', async () => {
  const page = rawPage();
  page.document.language = '';
  const axeRun = {
    status: 'complete', provenance: AXE_PROVENANCE, diagnostics: [],
    frames: [{ frameId: 0, status: 'success', result: {
      violations: [{ id: 'html-has-lang', impact: 'serious', nodes: [{ impact: 'serious', target: ['html'] }] }],
      incomplete: [], passes: [], inapplicable: [],
    } }],
  };
  const model = await runAudit({
    url: 'https://example.test/', chromeAdapter: fakeAdapter({ page, axeRun, fullPageFailure: new Error('capture') }),
    now: clock, idFactory: () => 'audit-axe-no-pristine',
  });
  assert.equal(model.evidence.artifacts.some(item => item.kind === 'full-page' && item.state === 'pristine'), false);
  assert.ok(model.session.diagnostics.some(item => item.code === 'PIXEL_CAPTURE_OMITTED' &&
    item.message === 'Nenhuma captura raster foi coletada no modo sem imagens.'));
  await assert.doesNotReject(enrichAuditForReport(model, {
    now: () => '2026-08-26T16:00:00.000Z', timezone: 'America/Cuiaba',
    manifestVersion: '0.1.0', rulesVersion: '1.0.0', browserVersion: 'Chrome/147.0.0.0',
  }));
});

test('rejects a forged failed item when validated axe evidence is only cantTell', async () => {
  const axeRun = {
    status: 'complete', provenance: AXE_PROVENANCE, diagnostics: [],
    frames: [{ frameId: 0, status: 'success', result: {
      violations: [],
      incomplete: [{ id: 'document-title', impact: 'serious', nodes: [{ impact: 'serious', target: ['html'] }] }],
      passes: [], inapplicable: [],
    } }],
  };
  const model = await runAudit({
    url: 'https://example.test/', chromeAdapter: fakeAdapter({ axeRun }),
    now: clock, idFactory: () => 'audit-axe-cant-tell',
  });
  assert.equal(model.itemResults.find(item => item.id === '5.13.1').outcome, 'cantTell');
  const enrichOptions = {
    now: () => '2026-08-26T16:00:00.000Z', timezone: 'America/Cuiaba',
    manifestVersion: '0.1.0', rulesVersion: '1.0.0', browserVersion: 'Chrome/147.0.0.0',
  };
  await assert.doesNotReject(enrichAuditForReport(model, enrichOptions));
  const forged = structuredClone(model);
  forged.itemResults.find(item => item.id === '5.13.1').outcome = 'failed';
  await assert.rejects(enrichAuditForReport(forged, enrichOptions), /autoritativ|diverge|axe|inválid/i);

  const forgedReview = structuredClone(model);
  Object.assign(forgedReview.itemResults.find(item => item.id === '5.13.1'), {
    originalOutcome: 'cantTell', reviewedOutcome: 'failed', outcome: 'failed',
    review: { mode: 'assisted', evaluator: 'forjado', decidedAt: '2026-08-26T15:00:00.000Z', decisionIds: [] },
  });
  const projectedReview = await enrichAuditForReport(forgedReview, enrichOptions);
  const projectedItem = projectedReview.itemResults.find(item => item.id === '5.13.1');
  assert.equal(projectedItem.outcome, 'cantTell');
  assert.equal(Object.hasOwn(projectedItem, 'reviewedOutcome'), false);
  assert.equal(Object.hasOwn(projectedItem, 'review'), false);
});

for (const fixture of [
  { ruleId: 'input-image-alt', target: 'input', itemId: '5.2.2', wcag: ['1.1.1', '2.4.4', '2.4.9'], sourceWcag: ['1.1.1'] },
  { ruleId: 'meta-viewport', target: 'meta', itemId: '5.13.5', wcag: ['1.4.4', '1.4.10'], sourceWcag: ['1.4.4'] },
  { ruleId: 'aria-roles', target: 'div', itemId: '5.13.12', wcag: ['1.3.1', '4.1.2'], sourceWcag: ['4.1.2'] },
  { ruleId: 'frame-title', target: 'iframe', itemId: '5.13.4', wcag: ['1.3.1', '4.1.2'], sourceWcag: ['4.1.2'] },
]) {
  test(`keeps item context but claims no tested WCAG/508 coverage for incomplete ${fixture.ruleId}`, async () => {
    const axeRun = {
      status: 'complete', provenance: AXE_PROVENANCE, diagnostics: [],
      frames: [{ frameId: 0, status: 'success', result: {
        violations: [], incomplete: [{
          id: fixture.ruleId, impact: 'serious',
          nodes: [{ impact: 'serious', target: [fixture.target] }],
        }], passes: [], inapplicable: [],
      } }],
    };
    const model = await runAudit({
      url: 'https://example.test/', chromeAdapter: fakeAdapter({ axeRun }), now: clock,
      idFactory: () => `audit-axe-${fixture.ruleId}`,
    });
    const report = await enrichAuditForReport(model, {
      now: () => '2026-08-26T16:00:00.000Z', timezone: 'America/Cuiaba',
      manifestVersion: '0.1.0', rulesVersion: '1.0.0', browserVersion: 'Chrome/147.0.0.0',
    });
    const occurrence = report.occurrences.find(item => item.source?.engine === 'axe-core');
    assert.equal(occurrence.nbrItemRef, fixture.itemId);
    assert.deepEqual(occurrence.itemWcagRefs, fixture.wcag);
    assert.deepEqual(occurrence.sourceWcagRefs, fixture.sourceWcag);
    assert.deepEqual(occurrence.testedWcagRefs, []);
    assert.deepEqual(occurrence.wcagRefs, []);
    assert.deepEqual(occurrence.foreignBenchmarkRefs, []);
    assert.equal(occurrence.outcome, 'cantTell');
    assert.equal(occurrence.legalAnalysis, null);
  });
}

test('keeps the Audita core running when axe throws and records a bounded partial diagnostic', async () => {
  const adapter = fakeAdapter({ axeFailure: new Error('PRIVATE axe failure details') });
  const model = await runAudit({
    url: 'https://example.test/', chromeAdapter: adapter,
    now: clock, idFactory: () => 'audit-axe-partial',
  });

  assert.equal(model.session.status, 'partial');
  assert.equal(model.axe.status, 'partial', 'partial supplemental coverage deterministically marks the audit recoverable/partial');
  assert.equal(model.ruleResults.length, 131);
  assert.equal(model.itemResults.length, 146);
  assert.ok(model.session.diagnostics.some(entry => entry.code === 'AXE_EXECUTION_FAILED'));
  assert.doesNotMatch(JSON.stringify(model), /PRIVATE axe failure details/iu);
  assert.ok(adapter.events.includes('collect'));
  assert.ok(adapter.events.includes('probes'));

  const enrichOptions = {
    now: () => '2026-08-26T16:00:00.000Z', timezone: 'America/Cuiaba',
    manifestVersion: '0.1.0', rulesVersion: '1.0.0', browserVersion: 'Chrome/147.0.0.0',
  };
  const forgedSession = structuredClone(model);
  forgedSession.session.status = 'complete';
  await assert.rejects(enrichAuditForReport(forgedSession, enrichOptions), /axe|partial|parcial|session|cobertura/i);

  const report = await enrichAuditForReport(model, enrichOptions);
  const forgedPage = structuredClone(report);
  forgedPage.pages[0].status = 'complete';
  await assert.rejects(enrichAuditForReport(forgedPage, enrichOptions), /axe|partial|parcial|página|cobertura/i);
});

test('normalizes a revoked raw axe collection before report enrichment without proxy exceptions', async () => {
  const pair = Proxy.revocable([], {});
  pair.revoke();
  const model = await runAudit({
    url: 'https://example.test/', chromeAdapter: fakeAdapter({
      axeRun: { status: 'complete', provenance: AXE_PROVENANCE, diagnostics: [], frames: pair.proxy },
    }),
    now: clock, idFactory: () => 'audit-axe-revoked-raw',
  });
  assert.equal(model.axe.status, 'partial');
  assert.deepEqual(model.axe.occurrences, []);
  await assert.doesNotReject(enrichAuditForReport(model, {
    now: () => '2026-08-26T16:00:00.000Z', timezone: 'America/Cuiaba',
    manifestVersion: '0.1.0', rulesVersion: '1.0.0', browserVersion: 'Chrome/147.0.0.0',
  }));
});

test('attaches normalized AX accessibility to element evidence, its hash and the final HTML', async () => {
  const first = await runAudit({
    url: 'https://example.test/', chromeAdapter: fakeAdapter({ page: pageWithAxName('Confirmar pedido') }),
    now: clock, idFactory: () => 'audit-accessibility',
  });
  const second = await runAudit({
    url: 'https://example.test/', chromeAdapter: fakeAdapter({ page: pageWithAxName('Enviar pedido') }),
    now: clock, idFactory: () => 'audit-accessibility',
  });
  const evidence = first.evidence.artifacts.find(artifact => artifact.nodeId === 'n-1');
  const changed = second.evidence.artifacts.find(artifact => artifact.nodeId === 'n-1');

  assert.deepEqual(evidence.accessibility, {
    name: 'Confirmar pedido',
    nameSource: 'accessibility-tree',
    description: 'Envia o formulário',
    descriptionSource: 'accessibility-tree',
    role: 'button',
    states: ['recolhido', 'indisponível'],
    visibleText: 'OK',
    announcementPreview: 'Confirmar pedido, botão, Envia o formulário, recolhido, indisponível',
  });
  assert.notEqual(evidence.hash, changed.hash);

  const report = await enrichAuditForReport(first, {
    now: () => '2026-08-26T16:00:00.000Z', timezone: 'America/Cuiaba',
    manifestVersion: '0.1.0', rulesVersion: '1.0.0', browserVersion: 'Chrome/147.0.0.0',
  });
  const html = renderHtmlReport(report);
  assert.match(html, /Nome acessível<\/dt><dd>Confirmar pedido/iu);
  assert.match(html, /Prévia de anúncio<\/dt><dd>Confirmar pedido, botão/iu);
  assert.match(html, /não é transcrição literal/iu);
});

test('never discloses sensitive control values in accessibility, hashes or final HTML', async () => {
  const firstSecret = 'TOPSECRET-current-password';
  const secondSecret = 'OTHERSECRET-current-password';
  const run = secret => runAudit({
    url: 'https://example.test/',
    chromeAdapter: fakeAdapter({
      page: pageWithSensitiveControl(secret),
      outerHtml: backendNodeId => backendNodeId === 1
        ? `<input type="password" autocomplete="current-password" value="${secret}">`
        : `<button>Node ${backendNodeId}</button>`,
    }),
    now: clock, idFactory: () => 'audit-sensitive-accessibility',
  });
  const [first, second] = await Promise.all([run(firstSecret), run(secondSecret)]);
  const evidence = first.evidence.artifacts.find(artifact => artifact.nodeId === 'n-1');
  const changed = second.evidence.artifacts.find(artifact => artifact.nodeId === 'n-1');

  assert.equal(evidence.accessibility.name, 'Senha da conta');
  assert.equal(Object.hasOwn(evidence.accessibility, 'value'), false);
  assert.doesNotMatch(evidence.accessibility.announcementPreview, /TOPSECRET|current-password/iu);
  assert.equal(evidence.hash, changed.hash);

  const report = await enrichAuditForReport(first, {
    now: () => '2026-08-26T16:00:00.000Z', timezone: 'America/Cuiaba',
    manifestVersion: '0.1.0', rulesVersion: '1.0.0', browserVersion: 'Chrome/147.0.0.0',
  });
  const html = renderHtmlReport(report);
  assert.doesNotMatch(`${JSON.stringify(first)}\n${evidence.hash}\n${html}`, /TOPSECRET-current-password/iu);
  assert.match(html, /Nome acessível<\/dt><dd>Senha da conta/iu);
  assert.match(html, /Prévia de anúncio/iu);
});

test('removes an ordinary api_key current value from snapshot, evidence, preview, hash and HTML', async () => {
  const run = secret => runAudit({
    url: 'https://example.test/',
    chromeAdapter: fakeAdapter({
      page: pageWithEditableSecret(secret),
      outerHtml: backendNodeId => backendNodeId === 1
        ? `<input id="api-field" type="text" name="api_key" value="${secret}">`
        : `<button>Node ${backendNodeId}</button>`,
    }),
    now: clock,
    idFactory: () => 'audit-api-key-privacy',
  });
  const [first, second] = await Promise.all([run('TOPSECRET-one'), run('TOPSECRET-two')]);
  const node = first.snapshot.nodes.find(item => item.nodeId === 'n-1');
  const evidence = first.evidence.artifacts.find(artifact => artifact.nodeId === 'n-1');
  const changed = second.evidence.artifacts.find(artifact => artifact.nodeId === 'n-1');

  assert.equal(node.valueStatus, 'omitted-privacy');
  assert.equal(Object.hasOwn(node.attributes, 'value'), false);
  assert.equal(Object.hasOwn(node, 'axValue'), false);
  for (const key of ['value', 'currentValue', 'rawValue', 'inputValue']) assert.equal(Object.hasOwn(node.form, key), false);
  assert.equal(evidence.accessibility.valueStatus, 'omitted-privacy');
  assert.equal(Object.hasOwn(evidence.accessibility, 'value'), false);
  assert.doesNotMatch(evidence.accessibility.announcementPreview, /TOPSECRET|valor/iu);
  assert.doesNotMatch(evidence.snippet, /TOPSECRET|\bvalue=/iu);
  assert.equal(evidence.hash, changed.hash);
  assert.doesNotMatch(JSON.stringify(first), /TOPSECRET/iu);

  const report = await enrichAuditForReport(first, {
    now: () => '2026-08-26T16:00:00.000Z', timezone: 'America/Cuiaba',
    manifestVersion: '0.1.0', rulesVersion: '1.0.0', browserVersion: 'Chrome/147.0.0.0',
  });
  const html = renderHtmlReport(report);
  assert.match(html, /Valor<\/dt><dd>não coletado por privacidade/iu);
  assert.doesNotMatch(html, /TOPSECRET/iu);
});

test('removes a nested contenteditable secret from model, evidence, preview, hash, snippet and HTML', async () => {
  const run = secret => runAudit({
    url: 'https://example.test/',
    chromeAdapter: fakeAdapter({
      page: pageWithContentEditableSecret(secret),
      outerHtml: backendNodeId => {
        if (backendNodeId === 1) return `<div id="${secret}" name="${secret}" contenteditable="true" role="textbox" tabindex="0" aria-labelledby="editor-label" aria-describedby="editor-description" aria-label="${secret}" title="${secret}" data-private="${secret}" href="https://example.test/?view=${secret}"><div title="${secret}">${secret}</div></div>`;
        if (backendNodeId === 4) return `<div id="${secret}" title="${secret}" data-private="${secret}">${secret}</div>`;
        if (backendNodeId === 5) return `<input id="${secret}" name="${secret}" type="text" title="${secret}" data-private="${secret}" value="${secret}">`;
        return '<button id="other">Outro</button>';
      },
    }),
    now: clock,
    idFactory: () => 'audit-contenteditable-privacy',
  });
  const [first, second] = await Promise.all([run('TOPSECRET-editor-one'), run('TOPSECRET-editor-two')]);
  const evidence = first.evidence.artifacts.find(artifact => artifact.nodeId === 'n-1');
  const ancestor = first.snapshot.nodes.find(node => node.nodeId === 'n-8');
  const ancestorEvidence = first.evidence.artifacts.find(artifact => artifact.nodeId === 'n-8');
  const changed = second.evidence.artifacts.find(artifact => artifact.nodeId === 'n-1');
  const descendantEvidence = first.evidence.artifacts.find(artifact => artifact.nodeId === 'n-4');
  const nestedControlEvidence = first.evidence.artifacts.find(artifact => artifact.nodeId === 'n-5');

  assert.equal(ancestor.text, 'Estrutura pública');
  assert.equal(ancestor.visibleText, '');
  assert.ok(ancestorEvidence);
  assert.equal(ancestorEvidence.accessibility.name, 'Painel público');
  assert.equal(ancestorEvidence.accessibility.visibleText, '');
  assert.equal(evidence.snippet, '<div contenteditable="true" role="textbox" tabindex="0" aria-labelledby="editor-label" aria-describedby="editor-description"></div>');
  assert.equal(evidence.accessibility.name, 'Editor externo seguro');
  assert.equal(evidence.accessibility.nameSource, 'aria-labelledby');
  assert.equal(evidence.accessibility.description, 'Descrição externa segura');
  assert.equal(evidence.accessibility.descriptionSource, 'aria-describedby');
  assert.match(evidence.accessibility.announcementPreview, /Editor externo seguro, campo de texto, Descrição externa segura/iu);
  assert.ok(descendantEvidence);
  assert.equal(descendantEvidence.snippet, '<div></div>');
  assert.ok(nestedControlEvidence);
  assert.equal(nestedControlEvidence.snippet, '<input>');
  assert.equal(nestedControlEvidence.accessibility.name, 'Campo interno seguro');
  assert.equal(nestedControlEvidence.accessibility.description, 'Descrição do campo segura');
  assert.equal(evidence.hash, changed.hash);
  assert.deepEqual(
    first.evidence.artifacts.map(artifact => artifact.hash),
    second.evidence.artifacts.map(artifact => artifact.hash),
  );
  for (const artifact of first.evidence.artifacts) assert.doesNotMatch(JSON.stringify(artifact), /TOPSECRET/iu);
  const leakedContexts = [...JSON.stringify(first).matchAll(/.{0,80}TOPSECRET.{0,80}/giu)].map(match => match[0]);
  assert.deepEqual(leakedContexts, []);

  const report = await enrichAuditForReport(first, {
    now: () => '2026-08-26T16:00:00.000Z', timezone: 'America/Cuiaba',
    manifestVersion: '0.1.0', rulesVersion: '1.0.0', browserVersion: 'Chrome/147.0.0.0',
  });
  const html = renderHtmlReport(report);
  assert.doesNotMatch(html, /TOPSECRET/iu);
  assert.match(html, /Nome acessível<\/dt><dd>Editor externo seguro/iu);
  assert.match(html, /Prévia de anúncio<\/dt><dd>Editor externo seguro, campo de texto, Descrição externa segura/iu);
});

test('lets true ARIA presence win over false node.form state and ignores aria-selected on a button', async () => {
  const checkboxModel = await runAudit({
    url: 'https://example.test/', chromeAdapter: fakeAdapter({ page: pageWithFormCheckbox() }),
    now: clock, idFactory: () => 'audit-form-checkbox',
  });
  const buttonModel = await runAudit({
    url: 'https://example.test/', chromeAdapter: fakeAdapter({ page: pageWithAxName('Continuar') }),
    now: clock, idFactory: () => 'audit-button-states',
  });
  const checkbox = checkboxModel.evidence.artifacts.find(artifact => artifact.nodeId === 'n-1').accessibility;
  const button = buttonModel.evidence.artifacts.find(artifact => artifact.nodeId === 'n-1').accessibility;

  assert.deepEqual(checkbox.states, ['marcado', 'indisponível', 'obrigatório', 'inválido']);
  assert.match(checkbox.announcementPreview, /marcado, indisponível, obrigatório, inválido/iu);
  assert.doesNotMatch(button.states.join(' '), /selecionado|marcado|obrigatório|inválido/iu);
  assert.deepEqual(button.states, ['recolhido', 'indisponível']);
});

test('uses conservative native roles for range, number, text-like and unknown inputs without AX', async () => {
  const expected = new Map([
    ['range', 'slider'], ['number', 'spinbutton'], ['checkbox', 'checkbox'], ['radio', 'radio'],
    ['button', 'button'], ['text', 'textbox'], ['color', ''],
  ]);
  for (const [type, role] of expected) {
    const model = await runAudit({
      url: 'https://example.test/', chromeAdapter: fakeAdapter({ page: pageWithFallbackInput(type) }),
      now: clock, idFactory: () => `audit-role-${type}`,
    });
    const evidence = model.evidence.artifacts.find(artifact => artifact.nodeId === 'n-1');
    assert.equal(evidence.accessibility.role, role, type);
  }
});

test('maps multiple select to listbox, simple select to combobox and keeps AX role priority', async () => {
  const formMultiple = pageWithSelect({ formMultiple: true });
  formMultiple.nodes[0].form.disabled = true;
  formMultiple.nodes[0].form.required = true;
  const cases = [
    ['attribute', pageWithSelect({ attributeMultiple: true }), 'listbox'],
    ['form', formMultiple, 'listbox'],
    ['simple', pageWithSelect(), 'combobox'],
    ['ax-priority', pageWithSelect({ attributeMultiple: true, axRole: 'combobox' }), 'combobox'],
  ];
  for (const [label, page, expected] of cases) {
    const model = await runAudit({
      url: 'https://example.test/', chromeAdapter: fakeAdapter({ page }),
      now: clock, idFactory: () => `audit-select-${label}`,
    });
    const accessibility = model.evidence.artifacts.find(artifact => artifact.nodeId === 'n-1').accessibility;
    assert.equal(accessibility.role, expected, label);
    assert.match(accessibility.announcementPreview, expected === 'listbox' ? /caixa de listagem/iu : /caixa de combinação/iu);
    if (label === 'form') assert.deepEqual(accessibility.states, ['indisponível', 'obrigatório']);
  }
});

test('stores readable sanitized snippets and the report encodes them exactly once', async () => {
  const secret = 'TOPSECRET-snippet';
  const run = outerHtml => runAudit({
    url: 'https://example.test/',
    chromeAdapter: fakeAdapter({
      outerHtml: backendNodeId => backendNodeId === 1
        ? outerHtml
        : `<button>Node ${backendNodeId}</button>`,
    }),
    now: clock,
    idFactory: () => 'audit-readable-snippet',
  });
  const model = await run(`<iframe title="Mapa" src="javascript:${secret}" onload="steal()"></iframe><button aria-label="Abrir">Abrir</button></code><script>${secret}</script>`);
  const changed = await run('<iframe title="Mapa"></iframe><button aria-label="Abrir">Outro texto</button></code>');
  const evidence = model.evidence.artifacts.find(artifact => artifact.nodeId === 'n-1');
  const changedEvidence = changed.evidence.artifacts.find(artifact => artifact.nodeId === 'n-1');

  assert.equal(evidence.snippet, '<iframe title="Mapa"></iframe><button aria-label="Abrir">Abrir</button></code>');
  assert.notEqual(evidence.hash, changedEvidence.hash);
  assert.doesNotMatch(JSON.stringify(model), /TOPSECRET|javascript:|onload=|<script/iu);

  const report = await enrichAuditForReport(model, {
    now: () => '2026-08-26T16:00:00.000Z', timezone: 'America/Cuiaba',
    manifestVersion: '0.1.0', rulesVersion: '1.0.0', browserVersion: 'Chrome/147.0.0.0',
  });
  const html = renderHtmlReport(report);
  const encodedSnippet = html.match(/<pre><code>([^]*?)<\/code><\/pre>/u)?.[1];

  assert.match(html, /&lt;iframe title=&quot;Mapa&quot;&gt;&lt;\/iframe&gt;/u);
  assert.match(html, /&lt;button aria-label=&quot;Abrir&quot;&gt;Abrir&lt;\/button&gt;/u);
  assert.doesNotMatch(html, /&amp;lt;(?:iframe|button)/u);
  assert.doesNotMatch(html, /TOPSECRET|javascript:|onload=/iu);
  assert.equal((html.match(/<script>/gu) || []).length, 1, 'somente o script estático do relatório é permitido');
  assert.equal(decodeHtmlText(encodedSnippet), evidence.snippet);
});

function decodeHtmlText(value) {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&');
}

test('keeps a structural snippet failure partial while no-pixels never retries screenshots', async () => {
  const page = rawPage();
  // Keep a second concrete finding: generic page questions no longer select every control.
  page.nodes[1].attributes.role = 'presentation';
  const adapter = fakeAdapter({ page, fullPageFailure: new DOMException('capture timeout', 'TimeoutError'), snippetFailureNode: 1 });
  const model = await runAudit({ url: 'https://example.test/', chromeAdapter: adapter, now: clock, idFactory: () => 'audit-partial' });
  assert.equal(model.session.status, 'partial');
  assert.ok(model.session.diagnostics.some(item => item.code === 'PIXEL_CAPTURE_OMITTED'));
  assert.ok(model.session.diagnostics.some(item => item.code === 'SNIPPET_CAPTURE_FAILED'));
  assert.equal(model.session.diagnostics.some(item => item.code === 'ELEMENT_CAPTURE_SKIPPED_NO_FULL_PAGE'), false);
  assert.ok(adapter.events.includes('collect'));
  assert.equal(adapter.counts.screenshots, 0);
  assert.equal(adapter.events.some(event => event.startsWith('thumbnail:')), false);
  const element = model.evidence.artifacts.find(item => item.nodeId === 'n-2');
  assert.ok(element);
  assert.ok(element.selector?.css);
  assert.match(element.snippet, /Node 2/);
  assert.equal(Object.hasOwn(element, 'dataUrl'), false);
  assert.equal(adapter.counts.disconnects, 1);
  assert.equal(adapter.counts.removals, 1);
});

test('returns failed on structural collection failure and still cleans only the disposable tab', async () => {
  const adapter = fakeAdapter({ collectFailure: true });
  const model = await runAudit({ url: 'https://example.test/', chromeAdapter: adapter, now: clock, idFactory: () => 'audit-failed' });
  assert.equal(model.session.status, 'failed');
  assert.ok(model.session.diagnostics.some(item => item.code === 'COLLECTION_FAILED'));
  assert.equal(adapter.counts.disconnects, 1);
  assert.equal(adapter.counts.removals, 1);
  assert.equal(adapter.events.includes('handoff'), false);
  assert.equal(model.progress.at(-1).percent < 100, true);
  const report = await enrichAuditForReport(model, {
    now: () => '2026-08-26T16:00:00.000Z', timezone: 'America/Cuiaba',
    manifestVersion: '0.1.0', rulesVersion: '1.0.0', browserVersion: 'Chrome/147.0.0.0',
  });
  assert.equal(report.session.status, 'failed');
  assert.equal(report.pages[0].axeStatus, report.axe?.status ?? 'not-run');
  assert.equal(report.session.diagnostics.some(entry => entry.code === 'AXE_FEATURE_DISABLED'), false);
});

test('does not claim an axe fallback when collection fails before the core audit starts', async () => {
  const model = await runAudit({
    url: 'https://example.test/',
    chromeAdapter: fakeAdapter({ collectFailure: true }),
    now: clock,
    idFactory: () => 'audit-collection-before-core',
  });

  assert.equal(model.session.status, 'failed');
  assert.equal(Object.hasOwn(model, 'axe'), false);
  assert.equal(model.session.diagnostics.some(entry => entry.code === 'AXE_FEATURE_DISABLED'), false);

  const report = await enrichAuditForReport(model, {
    now: () => '2026-08-26T16:00:00.000Z', timezone: 'America/Cuiaba',
    manifestVersion: '0.1.0', rulesVersion: '1.0.0', browserVersion: 'Chrome/147.0.0.0',
  });
  assert.equal(report.pages[0].axeStatus, 'not-run');
  assert.equal(Object.hasOwn(report, 'axe'), false);
  assert.equal(report.session.diagnostics.some(entry => entry.code === 'AXE_FEATURE_DISABLED'), false);
});

test('returns no report model or requested URL after a pre-observation tab failure', async () => {
  const execution = await runAuditExecution({
    url: 'https://example.test/requested?secret=REMOVE',
    chromeAdapter: fakeAdapter({ createTabFailure: true, canonicalInternals: true }),
    now: clock,
    idFactory: () => 'audit-url-not-observed',
  });

  assert.equal(execution.observationState, 'pre-observation-failure');
  assert.equal(execution.model, null);
  assert.equal(execution.observedTarget, null);
  assert.equal(execution.status, 'failed');
  assert.doesNotMatch(JSON.stringify(execution), /requested|secret|REMOVE/u);
});

test('distinguishes pre-observation creation and navigation failures only through factual effects', async t => {
  const reportOptions = {
    now: () => '2026-08-26T16:00:00.000Z', timezone: 'America/Cuiaba',
    manifestVersion: '0.1.0', rulesVersion: '1.0.0', browserVersion: 'Chrome/147.0.0.0',
  };
  for (const scenario of [
    { name: 'createTab', options: { createTabFailure: true }, navigated: false },
    {
      name: 'navigation', options: { waitFailure: new Error('detalhe privado de navegação') },
      navigated: true,
    },
  ]) await t.test(scenario.name, async () => {
    const adapter = fakeAdapter({ ...scenario.options, canonicalInternals: true });
    const execution = await runAuditExecution({
      url: 'https://example.test/', chromeAdapter: adapter, now: clock,
      idFactory: () => `audit-execution-${scenario.name.toLowerCase()}`,
    });
    assert.equal(execution.observationState, 'pre-observation-failure');
    assert.equal(execution.model, null);
    assert.equal(execution.observedTarget, null);
    assert.equal(execution.ownershipState, 'removed');
    assert.equal(adapter.events.some(entry => entry.startsWith('navigate:')), scenario.navigated);
    assert.doesNotMatch(JSON.stringify(execution), /detalhe privado/u);
  });

  await t.test('historical complete audit', async () => {
    const draft = await runAudit({
      url: 'https://example.test/', chromeAdapter: fakeAdapter(), now: clock,
      idFactory: () => 'audit-execution-historical-complete',
    });
    const historicalDraft = structuredClone(draft);
    delete historicalDraft.attempted;
    delete historicalDraft.finalUrlObserved;
    const historical = await enrichAuditForReport(historicalDraft, reportOptions);
    assert.equal(historical.pages[0].attempted, true);
    assert.equal(historical.pages[0].finalUrlObserved, true);
  });
});

test('does not claim or clean ownership when createTab returns an invalid resource', async () => {
  const sessionValues = {};
  const adapter = fakeAdapter({
    createTabResult: { id: 'PRIVATE_INVALID_TAB_ID' }, canonicalInternals: true, sessionValues,
  });
  const execution = await runAuditExecution({
    url: 'https://example.test/', chromeAdapter: adapter, now: clock,
    idFactory: () => 'audit-invalid-tab-resource',
  });

  assert.equal(adapter.counts.removals, 0);
  assert.equal(adapter.events.some(entry => entry.startsWith('remove-tab:')), false);
  assert.equal(Object.values(sessionValues).some(value => value?.version === 2), false);
  assert.equal(execution.observationState, 'pre-observation-failure');
  assert.equal(execution.model, null);
  assert.equal(execution.observedTarget, null);
  assert.equal(execution.ownershipState, 'removed');
  assert.doesNotMatch(JSON.stringify(execution), /PRIVATE_INVALID_TAB_ID/u);
});

test('records a missing environment as a factual partial cause', async () => {
  const draft = await runAudit({
    url: 'https://example.test/', chromeAdapter: fakeAdapter({ environmentResult: undefined }), now: clock,
    idFactory: () => 'audit-missing-environment',
  });
  assert.equal(draft.session.status, 'partial');
  assert.equal(draft.session.diagnostics.some(entry => entry.code === 'ENVIRONMENT_UNAVAILABLE'), true);
});

test('does not let a collection AbortError spoof cancellation without an aborted signal', async () => {
  const draft = await runAudit({
    url: 'https://example.test/',
    chromeAdapter: fakeAdapter({ collectError: new DOMException('cancelada', 'AbortError') }),
    now: clock,
    idFactory: () => 'audit-abort-during-collection',
  });
  assert.equal(draft.session.status, 'failed');
  assert.doesNotMatch(JSON.stringify(draft), /cancelada/u);
});

test('keeps cleanup failures explicit but recoverable in a valid partial audit model', async t => {
  for (const scenario of [
    { name: 'CDP', option: 'disconnectFailure', code: 'CDP_DISCONNECT_FAILED' },
    { name: 'aba', option: 'removeTabFailure', code: 'TAB_CLOSE_FAILED' },
  ]) await t.test(scenario.name, async () => {
    const sessionValues = {};
    const adapter = fakeAdapter({ [scenario.option]: true, sessionValues });
    const pending = runAudit({
      url: 'https://example.test/', chromeAdapter: adapter, now: clock,
      idFactory: () => `audit-cleanup-${scenario.name.toLowerCase()}`,
    });

    if (scenario.name === 'aba') {
      await assert.rejects(pending, /AUDIT_EXECUTION_DENIED/u);
      const owner = Object.values(sessionValues).find(value => value?.version === 2);
      assert.equal(owner?.state, 'cleanup-pending');
      assert.equal(adapter.counts.removals, 1);
      return;
    }
    const model = await pending;

    assert.equal(model.session.status, 'partial');
    assert.equal(model.session.partial, true);
    const cleanupDiagnostic = model.session.diagnostics.find(entry => entry.code === scenario.code);
    assert.ok(cleanupDiagnostic);
    assert.equal(cleanupDiagnostic.recoverable, true);
    assert.doesNotMatch(JSON.stringify(model), /detalhe privado/iu);
    await assert.doesNotReject(() => enrichAuditForReport(model, {
      now: () => '2026-08-26T16:00:00.000Z', timezone: 'America/Cuiaba',
      manifestVersion: '0.1.0', rulesVersion: '1.0.0', browserVersion: 'Chrome/147.0.0.0',
    }));
  });
});

test('does not treat an uncorrelated navigation AbortError as user cancellation', async () => {
  const aborted = new DOMException('Operação cancelada', 'AbortError');
  const adapter = fakeAdapter({ waitFailure: aborted, canonicalInternals: true });
  const execution = await runAuditExecution({
    url: 'https://example.test/', chromeAdapter: adapter, now: clock, idFactory: () => 'audit-cancelled',
  });
  assert.equal(execution.status, 'failed');
  assert.equal(execution.observationState, 'pre-observation-failure');
  assert.equal(execution.model, null);
  assert.equal(adapter.counts.disconnects, 0);
  assert.equal(adapter.counts.removals, 1);
  assert.doesNotMatch(JSON.stringify(execution), /cancelada/u);
});

test('can preserve the disposable audit tab only when explicitly configured', async () => {
  const adapter = fakeAdapter();
  await runAudit({ url: 'https://example.test/', chromeAdapter: adapter, now: clock, idFactory: () => 'audit-open', closeAuditTab: false });
  assert.equal(adapter.counts.disconnects, 1);
  assert.equal(adapter.counts.removals, 0);
});

test('rejects unsafe generated audit IDs before opening a tab', async () => {
  const adapter = fakeAdapter();
  await assert.rejects(runAudit({ url: 'https://example.test/', chromeAdapter: adapter, now: clock, idFactory: () => 'token=SECRET' }), /AUDIT_EXECUTION_DENIED/u);
  assert.equal(adapter.events.includes('create-tab'), false);
});

test('accepts only a JSON-safe report placeholder and never copies handoff secrets', async () => {
  const adapter = fakeAdapter({ handoff: {
    reviewUrl: 'chrome-extension://test/src/review/index.html?auditId=audit-safe&token=REMOVE',
    artifact: { status: 'ready', formats: ['pdf', 'html'], authorization: 'Bearer REMOVE' },
  } });
  const model = await runAudit({ url: 'https://example.test/', chromeAdapter: adapter, now: clock, idFactory: () => 'audit-safe' });
  assert.deepEqual(model.report.artifact, { status: 'pending', formats: [] });
  assert.doesNotMatch(JSON.stringify(model), /REMOVE|Bearer|authorization|"pdf"|"html"/i);
});

test('validated handoff capability cannot be persisted by runAudit or alter report hashes', async () => {
  const auditId = 'audit-transient-review';
  const makeClock = () => {
    let tick = 0;
    return () => new Date(Date.UTC(2026, 7, 29, 10, 0, tick++)).toISOString();
  };
  const trustedReviewUrl =
    `chrome-extension://${TEST_EXTENSION_ID}/src/review/index.html?auditId=${auditId}`;
  const hostileReviewUrl =
    `chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba/src/review/index.html?auditId=${auditId}`;
  const trusted = await runAudit({
    url: 'https://example.test/',
    chromeAdapter: fakeAdapter({ handoff: { reviewUrl: trustedReviewUrl } }),
    now: makeClock(), idFactory: () => auditId, expectedExtensionId: TEST_EXTENSION_ID,
  });
  const hostile = await runAudit({
    url: 'https://example.test/',
    chromeAdapter: fakeAdapter({ handoff: { reviewUrl: hostileReviewUrl } }),
    now: makeClock(), idFactory: () => auditId, expectedExtensionId: TEST_EXTENSION_ID,
  });

  for (const model of [trusted, hostile]) {
    assert.deepEqual(model.report, {
      status: 'review-ready',
      reviewUrl: null,
      artifact: { status: 'pending', formats: [] },
    });
  }
  assert.deepEqual(trusted.reproducibility, hostile.reproducibility);
  assert.doesNotMatch(JSON.stringify([trusted, hostile]), /abcdefghijklmnopabcdefghijklmnop|ponmlkjihgfedcbaponmlkjihgfedcba/u);
});

test('cancels immediately when the signal aborts after collection', async () => {
  const controller = new AbortController();
  const adapter = fakeAdapter({ afterCollect: () => controller.abort(new DOMException('cancelada', 'AbortError')) });
  const model = await runAudit({
    url: 'https://example.test/', chromeAdapter: adapter,
    now: clock, idFactory: () => 'audit-abort-collect', signal: controller.signal,
  });
  assert.equal(model.session.status, 'cancelled');
  assert.equal(model.progress.some(entry => entry.phase === 'complete' || /concluída/iu.test(entry.message)), false);
  assert.deepEqual(
    { phase: model.progress.at(-1)?.phase, message: model.progress.at(-1)?.message, at: model.progress.at(-1)?.at },
    { phase: 'cancelled', message: 'Auditoria cancelada', at: model.timestamps.endedAt },
  );
  assert.equal(model.report.status, 'pending');
  assert.equal(adapter.events.includes('handoff'), false);
  assert.equal(adapter.counts.disconnects, 1);
  assert.equal(adapter.counts.removals, 1);
});

test('stops the occurrence loop immediately when evidence capture observes abort', async () => {
  const controller = new AbortController();
  const adapter = fakeAdapter({ afterSnippet: backendNodeId => {
    if (backendNodeId === 1) controller.abort(new DOMException('cancelada', 'AbortError'));
  } });
  const model = await runAudit({
    url: 'https://example.test/', chromeAdapter: adapter,
    now: clock, idFactory: () => 'audit-abort-evidence', signal: controller.signal,
  });
  assert.equal(model.session.status, 'cancelled');
  assert.equal(model.progress.some(entry => entry.phase === 'complete' || /concluída/iu.test(entry.message)), false);
  assert.equal(model.progress.at(-1)?.phase, 'cancelled');
  assert.equal(model.timestamps.endedAt, model.progress.at(-1)?.at);
  assert.equal(adapter.events.includes('handoff'), false);
  assert.equal(adapter.counts.disconnects, 1);
  assert.equal(adapter.counts.removals, 1);
});

test('marks timed-out or incomplete dynamic probes partial with a fixed diagnostic', async () => {
  const adapter = fakeAdapter({ rawProbes: {
    focus: { completed: false, events: [] }, warnings: [{ code: 'TIMEOUT' }], actions: [],
  } });
  const model = await runAudit({ url: 'https://example.test/', chromeAdapter: adapter, now: clock, idFactory: () => 'audit-probe-timeout' });
  assert.equal(model.session.status, 'partial');
  assert.ok(model.session.diagnostics.some(entry => entry.code === 'DYNAMIC_PROBES_INCOMPLETE'));
});

test('does not let a stalled progress transport block the terminal audit model', async () => {
  const adapter = fakeAdapter({
    noPixels: true,
    onEmitProgress(message) {
      return message.percent === 100 ? new Promise(() => {}) : undefined;
    },
  });
  let timer;
  const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(null), 500); });
  let model;
  try {
    model = await Promise.race([
      runAudit({
        url: 'https://example.test/', chromeAdapter: adapter,
        now: clock, idFactory: () => 'audit-stalled-progress',
      }),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }

  assert.ok(model, 'a telemetria de progresso pendente não pode impedir o relatório');
  assert.equal(model.progress.at(-1)?.percent, 100);
  assert.ok(['complete', 'partial'].includes(model.session.status));
});
