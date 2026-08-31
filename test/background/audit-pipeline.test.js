import assert from 'node:assert/strict';
import test from 'node:test';

import { createObservedPipelineRunner, executeObservedAuditPipeline, isObservedTargetV1 } from '../../src/background/audit-pipeline.js';
import { createCapturePolicyV1 } from '../../src/core/privacy/capture-policy.js';
import { sanitizeEvidenceUrlV1 } from '../../src/core/privacy/evidence-url.js';
import { SAMPLE_AUDIT } from '../../fixtures/audits/sample-audit.js';

const AUDIT_ID = SAMPLE_AUDIT.auditId;
const DIGEST = `hmac-sha256:${'A'.repeat(43)}`;
const EVIDENCE = sanitizeEvidenceUrlV1(SAMPLE_AUDIT.finalUrl, { includeQuery: false });
const POLICY = createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false });
const TARGET = Object.freeze({ version: 'ObservedTargetV1', kind: 'attached', tabId: 7, windowId: 3, documentId: 'doc-1', urlSessionDigest: DIGEST, urlEvidence: EVIDENCE });

function recorder() {
  const checkpoints = [];
  return { async started() {}, async record(value) { checkpoints.push(value); }, snapshot() { return { version: 1, auditId: AUDIT_ID, pages: [{ pageId: 'page-1', attempted: true, startedAt: '2026-08-31T12:00:00.000Z', rulesVersion: '1.0.0', inventoryVersion: '1.0.0', inventoryHash: 'a'.repeat(64), outcomes: [] }] }; } };
}

function services({ collection = { snapshot: { title: 'safe' } }, status = 'complete' } = {}) {
  return {
    async collectObservedPage() { return collection; },
    async runCoreRules() { return { ruleResults: [] }; },
    async buildAuditModel() { return SAMPLE_AUDIT; },
    async persistAuditModel() {},
  };
}

const BEFORE_PERSIST = async () => ({ tabId: 7, windowId: 3, documentId: 'doc-1', urlSessionDigest: DIGEST });

test('accepts only final attached ObservedTargetV1 with EvidenceUrlV1', () => {
  assert.equal(isObservedTargetV1(TARGET), true);
  assert.equal(isObservedTargetV1({ ...TARGET, version: 1 }), false);
  assert.equal(isObservedTargetV1({ ...TARGET, urlEvidence: TARGET.urlEvidence.href }), false);
  assert.equal(isObservedTargetV1({ ...TARGET, kind: 'disposable', ownerId: 'owner-1' }), false);
  assert.equal(isObservedTargetV1({ ...TARGET, rawUrl: 'https://example.test/?secret=1' }), false);
});

test('factory creates the only accepted canonical pipeline runner', async () => {
  const runner = createObservedPipelineRunner({ checkpointRecorder: recorder(), services: services() });
  const result = await runner({ auditId: AUDIT_ID, observedTarget: TARGET, capturePolicy: POLICY, signal: undefined, beforePersist: BEFORE_PERSIST });
  assert.equal(result.model.auditId, AUDIT_ID);
});

test('accepts owned-disposable V2 target and preserves its closed ownership fields', () => {
  const target = {
    version: 'ObservedTargetV1', kind: 'owned-disposable', ownershipId: 'ownership-1',
    tabId: 41, windowId: 3, documentId: 'doc-1', urlSessionDigest: DIGEST,
    urlEvidence: EVIDENCE, cleanupMode: 'always', pageId: 'page-1',
  };
  assert.equal(isObservedTargetV1(target), true);
  for (const invalid of [
    { ...target, ownerId: 'legacy-owner' }, { ...target, cleanupMode: 'retain-after-observation' },
    { ...target, pageId: 4 }, { ...target, ownershipId: '' },
  ]) assert.equal(isObservedTargetV1(invalid), false);
});

test('rejects legacy targets before collection, checkpoints, or persistence', async () => {
  let calls = 0;
  for (const observedTarget of [
    { ...TARGET, version: 1 }, { ...TARGET, urlEvidence: TARGET.urlEvidence.href },
    { ...TARGET, ownerId: 'owner-1' },
  ]) {
    const check = recorder();
    await assert.rejects(() => executeObservedAuditPipeline({
      auditId: AUDIT_ID, observedTarget, capturePolicy: POLICY, checkpointRecorder: check,
      signal: undefined, beforePersist: BEFORE_PERSIST,
      services: { ...services(), async collectObservedPage() { calls += 1; } },
    }), /OBSERVED_PIPELINE_DENIED/u);
  }
  assert.equal(calls, 0);
});

test('runs the pipeline with the final target and keeps internals out of the model', async () => {
  const check = recorder();
  let received;
  let persistContext;
  const result = await executeObservedAuditPipeline({
    auditId: AUDIT_ID, observedTarget: TARGET, capturePolicy: POLICY, checkpointRecorder: check,
    signal: undefined, beforePersist: BEFORE_PERSIST,
    services: {
      ...services(),
      async collectObservedPage(input) { received = input.observedTarget; return { snapshot: { title: 'safe' } }; },
      async persistAuditModel(_model, context) { persistContext = context; },
    },
  });
  assert.deepEqual(received, TARGET);
  assert.equal(result.model.auditId, AUDIT_ID);
  assert.equal(result.status, result.model.session.status);
  assert.equal(result.observationState, 'observed');
  assert.deepEqual(persistContext.observedTarget, TARGET);
  assert.equal(Object.hasOwn(result.model, 'observedTarget'), false);
});

test('rejects sensitive internal fields and accessors before core/model work', async () => {
  let getterCalls = 0;
  const hostile = { safe: true };
  Object.defineProperty(hostile, 'ownerId', { enumerable: true, get() { getterCalls += 1; return 'private'; } });
  let later = 0;
  await assert.rejects(() => executeObservedAuditPipeline({
    auditId: AUDIT_ID, observedTarget: TARGET, capturePolicy: POLICY, checkpointRecorder: recorder(),
    signal: undefined, beforePersist: BEFORE_PERSIST,
    services: {
      async collectObservedPage() { return hostile; }, async runCoreRules() { later += 1; return { ruleResults: [] }; },
      async buildAuditModel() { later += 1; return { schemaVersion: 2, auditId: AUDIT_ID, session: { status: 'complete' } }; },
      async persistAuditModel() { later += 1; },
    },
  }), /OBSERVED_PIPELINE_DENIED/u);
  assert.equal(getterCalls, 0);
  assert.equal(later, 0);
});

test('rejects extra top-level, service, and checkpoint envelope keys before any await', async () => {
  let started = 0;
  const check = recorder();
  check.started = async () => { started += 1; };
  const base = { auditId: AUDIT_ID, observedTarget: TARGET, capturePolicy: POLICY, checkpointRecorder: check, signal: undefined, beforePersist: BEFORE_PERSIST, services: services() };
  await assert.rejects(() => executeObservedAuditPipeline({ ...base, extra: true }), /OBSERVED_PIPELINE_DENIED/u);
  const hostileServices = { ...services() };
  Object.defineProperty(hostileServices, 'extra', { enumerable: true, get() { throw new Error('must-not-read'); } });
  await assert.rejects(() => executeObservedAuditPipeline({ ...base, services: hostileServices }), /OBSERVED_PIPELINE_DENIED/u);
  const hostileCheckpoint = { ...check };
  Object.defineProperty(hostileCheckpoint, 'extra', { enumerable: true, get() { throw new Error('must-not-read'); } });
  await assert.rejects(() => executeObservedAuditPipeline({ ...base, checkpointRecorder: hostileCheckpoint }), /OBSERVED_PIPELINE_DENIED/u);
  assert.equal(started, 0);
});

test('copies CapturePolicy before collection and fences abort before persistence', async () => {
  const policy = { ...POLICY };
  const controller = new AbortController();
  let persisted = 0;
  const result = await executeObservedAuditPipeline({
    auditId: AUDIT_ID, observedTarget: TARGET, capturePolicy: policy, checkpointRecorder: recorder(), signal: controller.signal,
    beforePersist: BEFORE_PERSIST, services: {
      async collectObservedPage({ capturePolicy }) { policy.mode = 'full-evidence'; assert.equal(capturePolicy.mode, 'no-pixels'); return { snapshot: { title: 'safe' } }; },
      async runCoreRules() { return { ruleResults: [] }; },
      async buildAuditModel() { controller.abort(); return SAMPLE_AUDIT; },
      async persistAuditModel() { persisted += 1; },
    },
  }).catch(error => error);
  assert.equal(result instanceof Error, true);
  assert.equal(persisted, 0);
});

test('records rule inventory/checkpoint through the closed recorder envelope', async () => {
  const checkpoints = [];
  const check = { async started() {}, async record(value) { checkpoints.push(value); }, snapshot() { return { version: 1, auditId: AUDIT_ID, pages: [{ pageId: 'page-1', attempted: true, startedAt: '2026-08-31T12:00:00.000Z', rulesVersion: '1.0.0', inventoryVersion: '1.0.0', inventoryHash: 'a'.repeat(64), outcomes: [] }] }; } };
  const result = await executeObservedAuditPipeline({
    auditId: AUDIT_ID, observedTarget: TARGET, capturePolicy: POLICY, checkpointRecorder: check,
    signal: undefined, beforePersist: BEFORE_PERSIST,
    services: {
      async collectObservedPage() { return { snapshot: { title: 'safe' } }; },
      async runCoreRules() { return { ruleResults: [{ ruleId: 'rule-1', outcome: 'untested' }] }; },
      async buildAuditModel() { return SAMPLE_AUDIT; }, async persistAuditModel() {},
    },
  });
  assert.deepEqual(checkpoints, [{ ruleId: 'rule-1', outcome: 'untested' }]);
  assert.equal(result.checkpoint.version, 1);
  assert.equal(result.checkpoint.pages[0].pageId, 'page-1');
});

test('rejects a built model whose auditId does not match the pipeline audit', async () => {
  const wrong = structuredClone(SAMPLE_AUDIT);
  wrong.auditId = 'other-audit';
  await assert.rejects(() => executeObservedAuditPipeline({
    auditId: AUDIT_ID, observedTarget: TARGET, capturePolicy: POLICY, checkpointRecorder: recorder(),
    signal: undefined, beforePersist: BEFORE_PERSIST,
    services: { ...services(), async buildAuditModel() { return wrong; } },
  }), /OBSERVED_PIPELINE_DENIED/u);
});

test('proves the final document immediately before persistence and validates checkpoint before that commit', async () => {
  const order = [];
  const result = await executeObservedAuditPipeline({
    auditId: AUDIT_ID, observedTarget: TARGET, capturePolicy: POLICY, checkpointRecorder: recorder(), signal: undefined,
    beforePersist: async ({ observedTarget }) => { order.push('prove'); assert.deepEqual(observedTarget, TARGET); return { tabId: 7, windowId: 3, documentId: 'doc-1', urlSessionDigest: DIGEST }; }, services: {
      async collectObservedPage() { order.push('collect'); return { snapshot: { title: 'safe' } }; },
      async runCoreRules() { order.push('rules'); return { ruleResults: [] }; },
      async buildAuditModel() { order.push('build'); return SAMPLE_AUDIT; },
      async persistAuditModel() { order.push('persist'); },
    },
  });
  assert.equal(result.model.auditId, AUDIT_ID);
  assert.deepEqual(order, ['collect', 'rules', 'build', 'prove', 'persist']);
});

test('rejects checkpoint secrets before the final proof or persistence', async () => {
  let proved = 0;
  const check = { async started() {}, async record() {}, snapshot() { return { rawUrl: 'https://secret.test/?token=x' }; } };
  await assert.rejects(() => executeObservedAuditPipeline({
    auditId: AUDIT_ID, observedTarget: TARGET, capturePolicy: POLICY, checkpointRecorder: check, signal: undefined,
    beforePersist: BEFORE_PERSIST,
    services: { ...services(), async persistAuditModel() { proved += 1; } },
  }), /OBSERVED_PIPELINE_DENIED/u);
  assert.equal(proved, 0);
});

test('rejects a changed final document before persistence', async () => {
  let persisted = 0;
  await assert.rejects(() => executeObservedAuditPipeline({
    auditId: AUDIT_ID, observedTarget: TARGET, capturePolicy: POLICY, checkpointRecorder: recorder(), signal: undefined,
    beforePersist: async () => ({ tabId: 7, windowId: 3, documentId: 'changed-doc', urlSessionDigest: DIGEST }),
    services: { ...services(), async persistAuditModel() { persisted += 1; } },
  }), /OBSERVED_PIPELINE_DENIED/u);
  assert.equal(persisted, 0);
});

test('propagates a persist commit-then-throw after the final proof', async () => {
  let proved = 0;
  await assert.rejects(() => executeObservedAuditPipeline({
    auditId: AUDIT_ID, observedTarget: TARGET, capturePolicy: POLICY, checkpointRecorder: recorder(), signal: undefined,
    beforePersist: async () => { proved += 1; return { tabId: 7, windowId: 3, documentId: 'doc-1', urlSessionDigest: DIGEST }; },
    services: { ...services(), async persistAuditModel() { throw new Error('commit-then-throw'); } },
  }), /commit-then-throw/u);
  assert.equal(proved, 1);
});

test('rejects a minimal non-canonical model before proof or persistence', async () => {
  let proved = 0;
  await assert.rejects(() => executeObservedAuditPipeline({
    auditId: AUDIT_ID, observedTarget: TARGET, capturePolicy: POLICY, checkpointRecorder: recorder(), signal: undefined,
    beforePersist: async () => { proved += 1; return { tabId: 7, windowId: 3, documentId: 'doc-1', urlSessionDigest: DIGEST }; },
    services: { ...services(), async buildAuditModel() { return { schemaVersion: 2, auditId: AUDIT_ID, session: { status: 'partial' } }; } },
  }), /OBSERVED_PIPELINE_DENIED/u);
  assert.equal(proved, 0);
});

test('derives checkpoint page order from the canonical model, not the checkpoint payload', async () => {
  const mismatched = recorder();
  mismatched.snapshot = () => ({ version: 1, auditId: AUDIT_ID, pages: [{ pageId: 'other-page', attempted: true,
    startedAt: '2026-08-31T12:00:00.000Z', rulesVersion: '1.0.0', inventoryVersion: '1.0.0', inventoryHash: 'a'.repeat(64), outcomes: [] }] });
  await assert.rejects(() => executeObservedAuditPipeline({
    auditId: AUDIT_ID, observedTarget: TARGET, capturePolicy: POLICY, checkpointRecorder: mismatched, signal: undefined,
    beforePersist: BEFORE_PERSIST, services: services(),
  }), /OBSERVED_PIPELINE_DENIED/u);
});

test('rejects an owned target whose pageId diverges from the canonical page before persistence', async () => {
  let persisted = 0;
  const owned = { ...TARGET, kind: 'owned-disposable', ownershipId: 'ownership-1', cleanupMode: 'always', pageId: 'page-2' };
  await assert.rejects(() => executeObservedAuditPipeline({
    auditId: AUDIT_ID, observedTarget: owned, capturePolicy: POLICY, checkpointRecorder: recorder(), signal: undefined,
    beforePersist: async () => ({ tabId: 7, windowId: 3, documentId: 'doc-1', urlSessionDigest: DIGEST }),
    services: { ...services(), async persistAuditModel() { persisted += 1; } },
  }), /OBSERVED_PIPELINE_DENIED/u);
  assert.equal(persisted, 0);
});

test('accepts an owned target with null pageId when the observed page and URL are canonical', async () => {
  const owned = { ...TARGET, kind: 'owned-disposable', ownershipId: 'ownership-1', cleanupMode: 'always', pageId: null };
  const result = await executeObservedAuditPipeline({
    auditId: AUDIT_ID, observedTarget: owned, capturePolicy: POLICY, checkpointRecorder: recorder(), signal: undefined,
    beforePersist: async () => ({ tabId: 7, windowId: 3, documentId: 'doc-1', urlSessionDigest: DIGEST }),
    services: services(),
  });
  assert.equal(result.model.pages.length, 1);
  assert.equal(result.model.pages[0].finalUrl, SAMPLE_AUDIT.finalUrl);
});

test('rejects a canonical model whose final URL evidence diverges before persistence', async () => {
  let persisted = 0;
  const divergent = structuredClone(SAMPLE_AUDIT);
  divergent.pages[0].finalUrl = 'https://different.example/other';
  divergent.finalUrl = divergent.pages[0].finalUrl;
  await assert.rejects(() => executeObservedAuditPipeline({
    auditId: AUDIT_ID, observedTarget: TARGET, capturePolicy: POLICY, checkpointRecorder: recorder(), signal: undefined,
    beforePersist: BEFORE_PERSIST,
    services: { ...services(), async buildAuditModel() { return divergent; }, async persistAuditModel() { persisted += 1; } },
  }), /OBSERVED_PIPELINE_DENIED/u);
  assert.equal(persisted, 0);
});
