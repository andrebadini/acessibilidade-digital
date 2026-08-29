import assert from 'node:assert/strict';
import test from 'node:test';

import { createOwnedTabRegistry } from '../../src/background/owned-tabs.js';
import { createRawNavigationVaultV1 } from '../../src/background/raw-navigation-vault.js';
import { runObservedTabAudit } from '../../src/background/observed-tab-runner.js';
import { createCapturePolicyV1 } from '../../src/core/privacy/capture-policy.js';

const DIGEST_A = `hmac-sha256:${'A'.repeat(43)}`;
const DIGEST_B = `hmac-sha256:${'B'.repeat(43)}`;

function createSessionArea() {
  const values = {};
  return {
    async get(key) {
      if (key === null) return structuredClone(values);
      return Object.hasOwn(values, key) ? { [key]: structuredClone(values[key]) } : {};
    },
    async set(entries) { Object.assign(values, structuredClone(entries)); },
    async remove(key) { delete values[key]; },
  };
}

function checkpointRecorder() {
  const snapshot = Object.freeze({ version: 1, auditId: 'audit-a', pages: Object.freeze([]) });
  return Object.freeze({ snapshot: () => snapshot });
}

function safeFailureModel({ auditId, code, status }) {
  return Object.freeze({
    schemaVersion: 2, auditId,
    session: Object.freeze({ status, diagnostics: Object.freeze([Object.freeze({ code })]) }),
  });
}

function privacyStore() {
  const records = new Map();
  return {
    records,
    async persistPause(value) { records.set(value.pauseId, structuredClone(value)); },
    async getPause(pauseId) { return records.has(pauseId) ? structuredClone(records.get(pauseId)) : null; },
  };
}

function attachedFixture({ proofs, pipelineError, decision, store = privacyStore(), signal } = {}) {
  const calls = {
    createTab: 0, navigateTab: 0, removeTab: 0, collect: 0, pixelOperations: 0,
    readInputValue: 0, captureVisibleTab: 0, captureScreenshot: 0, order: [],
  };
  const queue = [...(proofs ?? [{ tabId: 17, windowId: 9, documentId: 'document-a', urlSessionDigest: DIGEST_A }, { tabId: 17, windowId: 9, documentId: 'document-a', urlSessionDigest: DIGEST_A }])];
  const chromeAdapter = {
    async createTab() { calls.createTab += 1; },
    async navigateTab() { calls.navigateTab += 1; },
    async removeTab() { calls.removeTab += 1; },
    async probeDocumentIdentity() { return structuredClone(queue.shift() ?? queue.at(-1)); },
    async probePrivacySignals() {
      calls.order.push('probe-structure-without-values');
      return [{ category: 'password-field', count: 1 }];
    },
  };
  const pipeline = async ({ capturePolicy }) => {
    calls.collect += 1;
    if (capturePolicy.captureFullPage || capturePolicy.captureElements || capturePolicy.composeAnnouncementMap) calls.pixelOperations += 1;
    if (pipelineError) throw pipelineError;
    return {
      model: Object.freeze({ schemaVersion: 2, auditId: 'audit-a', session: Object.freeze({ status: 'complete', diagnostics: Object.freeze([]) }) }),
      checkpoint: checkpointRecorder().snapshot(), observationState: 'observed',
    };
  };
  const resolvedDecision = decision ?? { status: 'no-pixels', limitationCode: 'PIXEL_CAPTURE_OMITTED' };
  const args = {
    auditId: 'audit-a', sessionCapabilityId: 'session-a',
    target: {
      kind: 'attached', tabId: 17, windowId: 9, documentId: 'document-a',
      initialUrlEvidence: 'https://example.test/path', initialUrlSessionDigest: DIGEST_A,
    },
    capturePolicy: createCapturePolicyV1({ mode: resolvedDecision.status === 'no-pixels' ? 'no-pixels' : 'full-evidence', includeQuery: false }),
    privacyDecision: resolvedDecision,
    checkpointRecorder: checkpointRecorder(), signal,
    chromeAdapter, pipeline, privacyState: store,
    consentAuthority: { async consume() { return true; } },
    failureModelFactory: safeFailureModel,
    now: () => '2026-08-29T10:00:00.000Z',
  };
  return { args, calls, store };
}

test('attached target is never created navigated or removed on every exit', async () => {
  for (const exit of ['success', 'cancel', 'timeout', 'cdp-failure', 'worker-interruption']) {
    const controller = new AbortController();
    if (exit === 'cancel') controller.abort(new DOMException('cancelled', 'AbortError'));
    const pipelineError = exit === 'success' || exit === 'cancel' ? null : Object.assign(new Error('PRIVATE_NATIVE_DETAIL'), { name: exit === 'timeout' ? 'TimeoutError' : 'Error' });
    const { args, calls } = attachedFixture({ pipelineError, signal: controller.signal });
    await runObservedTabAudit(args);
    assert.deepEqual(
      { create: calls.createTab, navigate: calls.navigateTab, remove: calls.removeTab },
      { create: 0, navigate: 0, remove: 0 },
      exit,
    );
  }
});

test('registers disposable ownership before navigation and retains an observed URL audit', async () => {
  const order = [];
  const sessionArea = createSessionArea();
  const chromeAdapter = {
    async createTab(options) { order.push('create-about-blank'); assert.deepEqual(options, { url: 'about:blank', active: true }); return { id: 41, windowId: 9 }; },
    async navigateTab(tabId, rawUrl) { order.push('navigate'); assert.equal(tabId, 41); assert.equal(rawUrl, 'https://example.test/?secret=ERASE'); },
    async waitForStable() {},
    async probeDocumentIdentity() { return { tabId: 41, windowId: 9, documentId: 'document-a', urlSessionDigest: DIGEST_A }; },
    async getEvidenceUrl() { return 'https://example.test/'; },
    async removeTab() { order.push('remove'); },
  };
  const underlyingOwned = createOwnedTabRegistry({ sessionArea, chromeAdapter, now: () => '2026-08-29T10:00:00.000Z' });
  const ownedTabs = {
    ...underlyingOwned,
    async registerCreated(value) { order.push('register-owner'); return underlyingOwned.registerCreated(value); },
  };
  const rawNavigationVault = createRawNavigationVaultV1({
    sessionArea, now: () => 1_788_000_000_000,
    randomBytes: length => new Uint8Array(length).fill(7),
  });
  const issued = await rawNavigationVault.putInternal({ ownerId: 'owner-a', rawUrl: 'https://example.test/?secret=ERASE' });
  const result = await runObservedTabAudit({
    auditId: 'audit-a', sessionCapabilityId: 'session-a',
    target: { kind: 'disposable', ownerId: 'owner-a', navigationToken: issued.navigationToken, cleanupMode: 'retain-after-observation' },
    capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    privacyDecision: { status: 'no-pixels', limitationCode: 'PIXEL_CAPTURE_OMITTED' },
    checkpointRecorder: checkpointRecorder(), chromeAdapter, ownedTabs, rawNavigationVault,
    pipeline: async () => ({ model: Object.freeze({ auditId: 'audit-a' }), checkpoint: checkpointRecorder().snapshot(), observationState: 'observed' }),
    failureModelFactory: safeFailureModel, now: () => '2026-08-29T10:00:00.000Z',
  });
  assert.deepEqual(order.slice(0, 3), ['create-about-blank', 'register-owner', 'navigate']);
  assert.equal(result.ownershipState, 'retained-for-review');
  assert.equal((await ownedTabs.get('owner-a')).state, 'retained-for-review');
  assert.doesNotMatch(JSON.stringify(result), /ERASE|navigationToken/u);
  assert.doesNotMatch(JSON.stringify(result.model), /owner-a|tabId|documentId|urlSessionDigest/u);
});

test('privacy pause survives recreation and requires document reproving', async () => {
  const store = privacyStore();
  const pausedFixture = attachedFixture({ decision: { status: 'privacy-paused', pauseId: 'pause-1' }, store });
  pausedFixture.args.chromeAdapter.probePrivacySignals = async () => [];
  const paused = await runObservedTabAudit(pausedFixture.args);
  assert.equal(paused.status, 'paused');
  assert.equal(store.records.has('pause-1'), true);

  const resumedFixture = attachedFixture({
    decision: { status: 'allowed', consentCapabilityId: 'consent-a', documentId: 'document-a', urlSessionDigest: DIGEST_A },
    proofs: [{ tabId: 17, windowId: 9, documentId: 'changed', urlSessionDigest: DIGEST_B }], store,
  });
  resumedFixture.args.resumePauseId = paused.pauseId;
  const resumed = await runObservedTabAudit(resumedFixture.args);
  assert.equal(resumed.status, 'failed');
  assert.equal(resumed.model.session.diagnostics.at(-1).code, 'PRIVACY_TARGET_CHANGED');
  assert.equal(resumedFixture.calls.pixelOperations, 0);
});

test('never reads values or captures pixels before an allowed decision', async () => {
  const { args, calls } = attachedFixture({ decision: { status: 'privacy-paused', pauseId: 'pause-2' } });
  const originalPersist = args.privacyState.persistPause;
  args.privacyState.persistPause = async value => { calls.order.push('persist-privacy-pause'); await originalPersist(value); };
  const result = await runObservedTabAudit(args);
  assert.equal(result.status, 'paused');
  assert.deepEqual(calls.order, ['probe-structure-without-values', 'persist-privacy-pause']);
  assert.equal(calls.readInputValue, 0);
  assert.equal(calls.captureVisibleTab, 0);
  assert.equal(calls.captureScreenshot, 0);
  assert.equal(calls.collect, 0);
});

test('same-document SPA URL change fails digest reproving before collection', async () => {
  const { args, calls } = attachedFixture({ proofs: [
    { tabId: 17, windowId: 9, documentId: 'document-a', urlSessionDigest: DIGEST_A },
    { tabId: 17, windowId: 9, documentId: 'document-a', urlSessionDigest: DIGEST_B },
  ] });
  const result = await runObservedTabAudit(args);
  assert.equal(result.status, 'failed');
  assert.equal(result.model.session.diagnostics.at(-1).code, 'TARGET_CHANGED');
  assert.equal(calls.collect, 0);
  assert.equal(calls.pixelOperations, 0);
});

test('no-pixels skips structural probes while allowed capture consumes one-use consent', async () => {
  const noPixels = attachedFixture();
  const completed = await runObservedTabAudit(noPixels.args);
  assert.equal(completed.status, 'completed');
  assert.deepEqual(noPixels.calls.order, []);
  assert.equal(noPixels.calls.pixelOperations, 0);

  const allowed = attachedFixture({ decision: { status: 'allowed', consentCapabilityId: 'consent-a', documentId: 'document-a', urlSessionDigest: DIGEST_A } });
  allowed.args.chromeAdapter.probePrivacySignals = async () => [];
  let consumed = 0;
  allowed.args.consentAuthority = { async consume(input) { consumed += 1; assert.equal(input.consentCapabilityId, 'consent-a'); return true; } };
  assert.equal((await runObservedTabAudit(allowed.args)).status, 'completed');
  assert.equal(consumed, 1);
  assert.equal(allowed.calls.pixelOperations, 1);
});

test('disposable pre-observation failure removes only owned tab and exposes cleanup-pending', async () => {
  const sessionArea = createSessionArea();
  const adapter = {
    async createTab() { return { id: 41, windowId: 9 }; },
    async navigateTab() { throw new Error('PRIVATE_NAVIGATION_ERROR'); },
    async waitForStable() { throw new Error('must not wait'); },
    async probeDocumentIdentity() { throw new Error('must not probe'); },
    async removeTab() { throw new Error('PRIVATE_REMOVE_ERROR'); },
  };
  const ownedTabs = createOwnedTabRegistry({ sessionArea, chromeAdapter: adapter, now: () => '2026-08-29T10:00:00.000Z' });
  const rawNavigationVault = createRawNavigationVaultV1({ sessionArea, now: () => 1_788_000_000_000, randomBytes: length => new Uint8Array(length).fill(8) });
  const issued = await rawNavigationVault.putInternal({ ownerId: 'owner-a', rawUrl: 'https://example.test/?secret=PRIVATE' });
  const result = await runObservedTabAudit({
    auditId: 'audit-a', sessionCapabilityId: 'session-a',
    target: { kind: 'disposable', ownerId: 'owner-a', navigationToken: issued.navigationToken, cleanupMode: 'retain-after-observation' },
    capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    privacyDecision: { status: 'no-pixels', limitationCode: 'PIXEL_CAPTURE_OMITTED' },
    checkpointRecorder: checkpointRecorder(), chromeAdapter: adapter, ownedTabs, rawNavigationVault,
    pipeline: async () => { throw new Error('must not run'); }, failureModelFactory: safeFailureModel,
    now: () => '2026-08-29T10:00:00.000Z',
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.observationState, 'pre-observation-failure');
  assert.equal(result.ownershipState, 'cleanup-pending');
  assert.equal((await ownedTabs.get('owner-a')).state, 'cleanup-pending');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|example\.test|owner-a|navigationToken/u);
});

test('rehydrates a disposable pause without creating, navigating, or consuming its token again', async () => {
  const sessionArea = createSessionArea();
  const store = privacyStore();
  const calls = { create: 0, navigate: 0, remove: 0, pipeline: 0 };
  const adapter = {
    async createTab() { calls.create += 1; return { id: 41, windowId: 9 }; },
    async navigateTab() { calls.navigate += 1; }, async waitForStable() {},
    async probeDocumentIdentity() { return { tabId: 41, windowId: 9, documentId: 'document-a', urlSessionDigest: DIGEST_A }; },
    async getEvidenceUrl() { return 'https://example.test/'; }, async probePrivacySignals() { return []; },
    async removeTab() { calls.remove += 1; },
  };
  const ownedTabs = createOwnedTabRegistry({ sessionArea, chromeAdapter: adapter, now: () => '2026-08-29T10:00:00.000Z' });
  const vault = createRawNavigationVaultV1({ sessionArea, now: () => 1_788_000_000_000, randomBytes: length => new Uint8Array(length).fill(9) });
  const issued = await vault.putInternal({ ownerId: 'owner-a', rawUrl: 'https://example.test/?secret=ERASE' });
  const policy = createCapturePolicyV1({ mode: 'element-only', includeQuery: false });
  const base = {
    auditId: 'audit-a', sessionCapabilityId: 'session-a',
    target: { kind: 'disposable', ownerId: 'owner-a', navigationToken: issued.navigationToken, cleanupMode: 'always' },
    capturePolicy: policy, checkpointRecorder: checkpointRecorder(), chromeAdapter: adapter,
    ownedTabs, rawNavigationVault: vault, privacyState: store, failureModelFactory: safeFailureModel,
    pipeline: async () => { calls.pipeline += 1; return { model: { auditId: 'audit-a' }, checkpoint: checkpointRecorder().snapshot() }; },
    consentAuthority: { async consume() { return true; } }, now: () => '2026-08-29T10:00:00.000Z',
  };
  const paused = await runObservedTabAudit({ ...base, privacyDecision: { status: 'privacy-paused', pauseId: 'pause-a' } });
  assert.equal(paused.status, 'paused');
  assert.deepEqual(Object.keys(store.records.get('pause-a')), [
    'version', 'auditId', 'pauseId', 'sessionCapabilityId', 'ownerId', 'observedTarget',
    'capturePolicy', 'signals', 'checkpoint', 'startedAt',
  ]);
  const resumed = await runObservedTabAudit({
    ...base, resumePauseId: 'pause-a',
    privacyDecision: { status: 'allowed', consentCapabilityId: 'consent-a', documentId: 'document-a', urlSessionDigest: DIGEST_A },
  });
  assert.equal(resumed.status, 'completed', JSON.stringify(resumed));
  assert.deepEqual(calls, { create: 1, navigate: 1, remove: 1, pipeline: 1 });
});

test('persists and rereads cleanup state when ownership registration storage fails once', async () => {
  const sessionArea = createSessionArea();
  const originalSet = sessionArea.set.bind(sessionArea);
  let failed = false;
  sessionArea.set = async entries => {
    if (!failed && Object.keys(entries).some(key => key.startsWith('audita:owned-tab:v1:'))) {
      failed = true; throw new Error('PRIVATE_SET_FAILURE');
    }
    return originalSet(entries);
  };
  const calls = [];
  const adapter = {
    async createTab() { calls.push('create'); return { id: 41, windowId: 9 }; },
    async navigateTab() { calls.push('navigate'); }, async waitForStable() {},
    async probeDocumentIdentity() { throw new Error('must not probe'); },
    async removeTab() { calls.push('remove'); },
  };
  const ownedTabs = createOwnedTabRegistry({ sessionArea, chromeAdapter: adapter, now: () => '2026-08-29T10:00:00.000Z' });
  const vault = createRawNavigationVaultV1({ sessionArea, now: () => 1_788_000_000_000, randomBytes: length => new Uint8Array(length).fill(10) });
  const issued = await vault.putInternal({ ownerId: 'owner-a', rawUrl: 'https://example.test/' });
  const result = await runObservedTabAudit({
    auditId: 'audit-a', sessionCapabilityId: 'session-a',
    target: { kind: 'disposable', ownerId: 'owner-a', navigationToken: issued.navigationToken, cleanupMode: 'always' },
    capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    privacyDecision: { status: 'no-pixels', limitationCode: 'PIXEL_CAPTURE_OMITTED' },
    checkpointRecorder: checkpointRecorder(), chromeAdapter: adapter, ownedTabs, rawNavigationVault: vault,
    pipeline: async () => { throw new Error('must not run'); }, failureModelFactory: safeFailureModel,
    now: () => '2026-08-29T10:00:00.000Z',
  });
  assert.equal(result.ownershipState, 'removed');
  assert.deepEqual(calls, ['create', 'remove']);
  assert.equal((await ownedTabs.get('owner-a')).state, 'removed');
});
