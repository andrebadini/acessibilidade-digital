import assert from 'node:assert/strict';
import test from 'node:test';

import { createBatchAuditExecutionV1 } from '../../src/background/batch-audit-execution.js';
import { createCapturePolicyV1 } from '../../src/core/privacy/capture-policy.js';
import { sanitizeEvidenceUrlV1 } from '../../src/core/privacy/evidence-url.js';

const DIGEST = `hmac-sha256:${'A'.repeat(43)}`;
const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';
const STARTED_AT = '2026-09-01T12:00:00.000Z';

function checkpoint(auditId, pageId) {
  return Object.freeze({
    version: 1,
    auditId,
    pages: [Object.freeze({
      pageId,
      attempted: true,
      startedAt: STARTED_AT,
      rulesVersion: '1.0.0',
      inventoryVersion: 'CoreRuleInventoryV1',
      inventoryHash: 'a'.repeat(64),
      outcomes: [],
    })],
  });
}

function queueFixture(auditId) {
  return {
    version: 1,
    auditId,
    ownerOperationId: 'Q'.repeat(22),
    revision: 1,
    issuedAt: 1_788_000_000_000,
    expiresAt: 1_788_007_200_000,
    nextIndex: 0,
    entries: [
      {
        line: 1,
        navigationToken: 'A'.repeat(22),
        evidenceUrl: sanitizeEvidenceUrlV1('https://one.example.test/private?token=REMOVE', { includeQuery: false }),
        sessionDigest: DIGEST,
        status: 'pending',
      },
      {
        line: 2,
        navigationToken: 'B'.repeat(22),
        evidenceUrl: sanitizeEvidenceUrlV1('https://two.example.test/secret?token=REMOVE', { includeQuery: false }),
        sessionDigest: DIGEST,
        status: 'pending',
      },
    ],
  };
}

test('runs a tokenized batch sequentially, proves cleanup, and never gives raw URLs to runBatch', async () => {
  const auditId = 'batch-execution-1';
  let queue = queueFixture(auditId);
  let activePageId = null;
  let activeOwnershipId = null;
  const owners = new Map();
  const rawUrls = new Map([
    ['A'.repeat(22), 'https://one.example.test/private?token=REMOVE'],
    ['B'.repeat(22), 'https://two.example.test/secret?token=REMOVE'],
  ]);
  const calls = [];
  const childProgress = [];
  let ownerCounter = 0;
  let cleared = false;
  const rawNavigationVault = {
    async readQueue(requestedAuditId) {
      assert.equal(requestedAuditId, auditId);
      return cleared ? null : structuredClone(queue);
    },
    async replaceQueue(requestedAuditId, desired, options) {
      assert.equal(requestedAuditId, auditId);
      assert.equal(options.expectedRevision, queue.revision);
      queue = structuredClone(desired);
    },
    async take(token, request) {
      assert.equal(request.auditId, auditId);
      assert.equal(request.purpose, 'batch-page');
      const raw = rawUrls.get(token);
      rawUrls.delete(token);
      return raw;
    },
    async clearAudit(requestedAuditId) {
      assert.equal(requestedAuditId, auditId);
      cleared = true;
      rawUrls.clear();
      return 1;
    },
  };
  const authority = {
    async transitionBatchAuditSession(request) {
      assert.equal(request.auditId, auditId);
      assert.equal(request.sessionCapabilityId, 'S'.repeat(22));
      assert.equal(request.fromPageId, activePageId);
      assert.equal(request.fromOwnershipId, activeOwnershipId);
      activePageId = request.toPageId;
      activeOwnershipId = request.toOwnershipId;
      return {
        ok: true,
        sessionCapabilityId: request.sessionCapabilityId,
        auditId,
        activePageId,
        activeOwnershipId,
      };
    },
  };
  const readBatchCorrelation = async () => ({
    version: 1,
    capabilityId: 'C'.repeat(22),
    auditId,
    sessionCapabilityId: 'S'.repeat(22),
    windowId: 9,
    capabilityState: 'claimed',
    sessionState: 'running',
    activePageId,
    activeOwnershipId,
    issuedAt: 1_788_000_000_000,
    expiresAt: 1_788_001_800_000,
  });
  const runUrlAuditExecution = async request => {
    const raw = await request.rawNavigationVault.take(request.navigationToken, {
      auditId: request.auditId,
      purpose: request.navigationPurpose,
      expectedEvidenceUrl: request.evidenceUrl,
      expectedSessionDigest: request.sessionDigest,
    });
    assert.match(raw, /token=REMOVE/u);
    await request.onProgress({ type: 'AUDIT_PROGRESS', auditId: request.auditId, percent: 50 });
    await request.onCheckpoint(checkpoint(request.auditId, 'page-1'));
    owners.set(request.ownershipId, {
      version: 2,
      ownershipId: request.ownershipId,
      auditId: request.auditId,
      purpose: 'audit',
      tabId: 40 + ownerCounter,
      windowId: 9,
      cleanupMode: 'always',
      state: 'removed',
      createdAt: STARTED_AT,
      updatedAt: STARTED_AT,
    });
    return {
      status: 'complete',
      model: { auditId: request.auditId },
      observedTarget: null,
      observationState: 'observed',
      ownershipState: 'removed',
    };
  };
  const executionCheckpoints = [];
  const runBatch = async request => {
    assert.equal(request.entries.some(entry => /REMOVE|token=/u.test(entry.navigationUrl)), false);
    const pages = [];
    for (let index = 0; index < request.entries.length; index += 1) {
      calls.push(`page-${index + 1}`);
      const result = await request.runner({
        url: request.entries[index].navigationUrl,
        chromeAdapter: { async emitProgress(value) { childProgress.push(structuredClone(value)); } },
        expectedExtensionId: EXTENSION_ID,
        now: request.now,
        idFactory: () => `${auditId}:page-${index + 1}`,
        signal: request.signal,
        closeAuditTab: true,
        pageId: `page-${index + 1}`,
        cleanupMode: 'always',
        checkpointAuditId: auditId,
        onCheckpoint: async value => pages.push(value.pages[0]),
      });
      assert.equal(result.ownershipState, 'removed');
      await request.onExecutionCheckpoint({ version: 1, auditId, pages: [...pages] });
    }
    return { auditId, session: { status: 'complete' } };
  };
  const execution = createBatchAuditExecutionV1({
    rawNavigationVault,
    authority,
    ownedTabRegistry: {
      async get(ownershipId) { return structuredClone(owners.get(ownershipId) ?? null); },
      async removeOwned() { throw new Error('REMOVE_MUST_NOT_RUN'); },
    },
    createOwnershipId() { ownerCounter += 1; return `owner_${String.fromCharCode(64 + ownerCounter).repeat(22)}`; },
    runBatch,
    runUrlAuditExecution,
    readBatchCorrelation,
    async emitProgress() {},
    tryEnterFinalization() { return true; },
  });

  const result = await execution.run({
    auditId,
    capabilityId: 'C'.repeat(22),
    sessionCapabilityId: 'S'.repeat(22),
    windowId: 9,
    acceptedCount: 2,
    capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    now: () => STARTED_AT,
    signal: new AbortController().signal,
    reportOptions: {
      timezone: 'America/Cuiaba',
      manifestVersion: '1.0.5',
      rulesVersion: '1.0.0',
      browserVersion: 'Chrome/152.0.0.0',
      expectedExtensionId: EXTENSION_ID,
    },
    onExecutionCheckpoint: async value => executionCheckpoints.push(value),
  });

  assert.deepEqual(calls, ['page-1', 'page-2']);
  assert.deepEqual(childProgress.map(event => event.percent), [50, 50]);
  assert.equal(result.model.auditId, auditId);
  assert.deepEqual(result.checkpoint.pages.map(page => page.pageId), ['page-1', 'page-2']);
  assert.deepEqual(executionCheckpoints.at(-1).pages.map(page => page.pageId), ['page-1', 'page-2']);
  assert.equal(activePageId, null);
  assert.equal(activeOwnershipId, null);
  assert.equal(queue.nextIndex, 2);
  assert.equal(queue.entries.every(entry => entry.status === 'finished'), true);
  assert.equal(cleared, true);
  assert.doesNotMatch(JSON.stringify(result), /REMOVE|token=/u);
});

test('continues after a proven pre-observation page failure with a factual empty checkpoint', async () => {
  const auditId = 'batch-pre-observation';
  let queue = queueFixture(auditId);
  let activePageId = null;
  let activeOwnershipId = null;
  let ownerCounter = 0;
  let cleared = false;
  const owners = new Map();
  const rawUrls = new Map([
    ['A'.repeat(22), 'https://one.example.test/private?token=REMOVE'],
    ['B'.repeat(22), 'https://two.example.test/secret?token=REMOVE'],
  ]);
  const executed = [];
  const execution = createBatchAuditExecutionV1({
    rawNavigationVault: {
      async readQueue() { return cleared ? null : structuredClone(queue); },
      async replaceQueue(_requestedAuditId, desired) { queue = structuredClone(desired); },
      async take(token) { const raw = rawUrls.get(token); rawUrls.delete(token); return raw; },
      async clearAudit() { cleared = true; rawUrls.clear(); return 1; },
    },
    authority: {
      async transitionBatchAuditSession(request) {
        assert.equal(request.fromPageId, activePageId);
        assert.equal(request.fromOwnershipId, activeOwnershipId);
        activePageId = request.toPageId;
        activeOwnershipId = request.toOwnershipId;
        return { ok: true, activePageId, activeOwnershipId };
      },
    },
    ownedTabRegistry: {
      async get(ownershipId) { return structuredClone(owners.get(ownershipId) ?? null); },
      async removeOwned() { throw new Error('REMOVE_MUST_NOT_RUN'); },
    },
    createOwnershipId() {
      ownerCounter += 1;
      return `owner_${String.fromCharCode(64 + ownerCounter).repeat(22)}`;
    },
    async runUrlAuditExecution(request) {
      await request.rawNavigationVault.take(request.navigationToken, {
        auditId: request.auditId,
        purpose: request.navigationPurpose,
        expectedEvidenceUrl: request.evidenceUrl,
        expectedSessionDigest: request.sessionDigest,
      });
      executed.push(request.auditId);
      if (request.auditId.endsWith('page-1')) {
        return {
          status: 'failed', model: null, observedTarget: null,
          observationState: 'pre-observation-failure', ownershipState: 'removed',
        };
      }
      await request.onCheckpoint(checkpoint(request.auditId, 'page-1'));
      owners.set(request.ownershipId, {
        version: 2, ownershipId: request.ownershipId, auditId: request.auditId,
        purpose: 'audit', tabId: 82, windowId: 9, cleanupMode: 'always', state: 'removed',
        createdAt: STARTED_AT, updatedAt: STARTED_AT,
      });
      return {
        status: 'complete', model: { auditId: request.auditId }, observedTarget: null,
        observationState: 'observed', ownershipState: 'removed',
      };
    },
    async runBatch(request) {
      const pages = [];
      for (let index = 0; index < request.entries.length; index += 1) {
        const pageId = `page-${index + 1}`;
        const result = await request.runner({
          url: request.entries[index].navigationUrl,
          chromeAdapter: { async emitProgress() {} }, expectedExtensionId: EXTENSION_ID,
          now: request.now, idFactory: () => `${auditId}:${pageId}`, signal: request.signal,
          closeAuditTab: true, pageId, cleanupMode: 'always', checkpointAuditId: auditId,
          onCheckpoint: async value => pages.push(value.pages[0]),
        });
        assert.equal(result.ownershipState, 'removed');
        assert.equal(result.checkpoint.pages[0].pageId, pageId);
        await request.onExecutionCheckpoint({ version: 1, auditId, pages: [...pages] });
      }
      return { auditId, pages: executed.length };
    },
    async readBatchCorrelation() {
      return {
        version: 1, capabilityId: 'C'.repeat(22), auditId,
        sessionCapabilityId: 'S'.repeat(22), windowId: 9,
        capabilityState: 'claimed', sessionState: 'running', activePageId, activeOwnershipId,
        issuedAt: 1_788_000_000_000, expiresAt: 1_788_001_800_000,
      };
    },
    async emitProgress() {},
    tryEnterFinalization() { return true; },
  });

  const result = await execution.run({
    auditId, capabilityId: 'C'.repeat(22), sessionCapabilityId: 'S'.repeat(22), windowId: 9,
    acceptedCount: 2, capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    now: () => STARTED_AT, signal: new AbortController().signal,
    reportOptions: {
      timezone: 'America/Cuiaba', manifestVersion: '1.0.5', rulesVersion: '1.0.0',
      browserVersion: 'Chrome/152.0.0.0', expectedExtensionId: EXTENSION_ID,
    },
    async onExecutionCheckpoint() {},
  });

  assert.deepEqual(executed, [`${auditId}:page-1`, `${auditId}:page-2`]);
  assert.equal(result.model.pages, 2);
  assert.equal(result.checkpoint.pages[0].attempted, true);
  assert.deepEqual(result.checkpoint.pages[0].outcomes, []);
  assert.equal(queue.nextIndex, 2);
  assert.equal(cleared, true);
  assert.doesNotMatch(JSON.stringify(result), /REMOVE|token=/u);
});

test('cleanup removes only the correlated active page before clearing its binding and queue', async () => {
  const auditId = 'batch-cleanup-1';
  const ownershipId = `owner_${'Z'.repeat(22)}`;
  const childAuditId = `${auditId}:page-2`;
  let queue = queueFixture(auditId);
  let activePageId = 'page-2';
  let activeOwnershipId = ownershipId;
  let owner = {
    version: 2, ownershipId, auditId: childAuditId, purpose: 'audit', tabId: 91, windowId: 9,
    cleanupMode: 'always', state: 'observing', createdAt: STARTED_AT, updatedAt: STARTED_AT,
  };
  const removals = [];
  const execution = createBatchAuditExecutionV1({
    rawNavigationVault: {
      async readQueue() { return queue === null ? null : structuredClone(queue); },
      async replaceQueue() { throw new Error('REPLACE_MUST_NOT_RUN'); },
      async take() { throw new Error('TAKE_MUST_NOT_RUN'); },
      async clearAudit(requestedAuditId) { assert.equal(requestedAuditId, auditId); queue = null; return 1; },
    },
    authority: {
      async transitionBatchAuditSession(request) {
        assert.deepEqual(request, {
          sessionCapabilityId: 'S'.repeat(22), auditId,
          fromPageId: 'page-2', fromOwnershipId: ownershipId,
          toPageId: null, toOwnershipId: null,
        });
        activePageId = null;
        activeOwnershipId = null;
        return { ok: true, activePageId, activeOwnershipId };
      },
    },
    ownedTabRegistry: {
      async get(requestedOwnershipId) {
        assert.equal(requestedOwnershipId, ownershipId);
        return structuredClone(owner);
      },
      async removeOwned(request) {
        removals.push(structuredClone(request));
        assert.deepEqual(request, {
          ownershipId, auditId: childAuditId, tabId: 91, fromState: 'observing',
        });
        owner = { ...owner, state: 'removed' };
        return structuredClone(owner);
      },
    },
    createOwnershipId() { return `owner_${'A'.repeat(22)}`; },
    async runBatch() { throw new Error('RUN_MUST_NOT_RUN'); },
    async runUrlAuditExecution() { throw new Error('RUN_MUST_NOT_RUN'); },
    async readBatchCorrelation() {
      return {
        version: 1, capabilityId: 'C'.repeat(22), auditId,
        sessionCapabilityId: 'S'.repeat(22), windowId: 9,
        capabilityState: 'claimed', sessionState: 'running', activePageId, activeOwnershipId,
        issuedAt: 1_788_000_000_000, expiresAt: 1_788_001_800_000,
      };
    },
    async emitProgress() {},
    tryEnterFinalization() { return true; },
  });

  assert.equal(await execution.cleanup({
    auditId, capabilityId: 'C'.repeat(22), sessionCapabilityId: 'S'.repeat(22), windowId: 9,
  }), true);
  assert.equal(removals.length, 1);
  assert.equal(owner.state, 'removed');
  assert.equal(activePageId, null);
  assert.equal(activeOwnershipId, null);
  assert.equal(queue, null);
});

test('cleanup keeps the batch recoverable when its active owner remains cleanup-pending', async () => {
  const auditId = 'batch-cleanup-pending';
  const ownershipId = `owner_${'P'.repeat(22)}`;
  const owner = {
    version: 2, ownershipId, auditId: `${auditId}:page-1`, purpose: 'audit', tabId: 92, windowId: 9,
    cleanupMode: 'always', state: 'cleanup-pending', createdAt: STARTED_AT, updatedAt: STARTED_AT,
  };
  let queueCleared = false;
  let bindingCleared = false;
  const execution = createBatchAuditExecutionV1({
    rawNavigationVault: {
      async readQueue() { return queueCleared ? null : queueFixture(auditId); },
      async replaceQueue() { throw new Error('REPLACE_MUST_NOT_RUN'); },
      async take() { throw new Error('TAKE_MUST_NOT_RUN'); },
      async clearAudit() { queueCleared = true; },
    },
    authority: {
      async transitionBatchAuditSession() { bindingCleared = true; throw new Error('BINDING_MUST_NOT_CLEAR'); },
    },
    ownedTabRegistry: {
      async get() { return structuredClone(owner); },
      async removeOwned() { return structuredClone(owner); },
    },
    createOwnershipId() { return `owner_${'A'.repeat(22)}`; },
    async runBatch() { throw new Error('RUN_MUST_NOT_RUN'); },
    async runUrlAuditExecution() { throw new Error('RUN_MUST_NOT_RUN'); },
    async readBatchCorrelation() {
      return {
        version: 1, capabilityId: 'C'.repeat(22), auditId,
        sessionCapabilityId: 'S'.repeat(22), windowId: 9,
        capabilityState: 'claimed', sessionState: 'running',
        activePageId: 'page-1', activeOwnershipId: ownershipId,
        issuedAt: 1_788_000_000_000, expiresAt: 1_788_001_800_000,
      };
    },
    async emitProgress() {},
    tryEnterFinalization() { return true; },
  });

  await assert.rejects(() => execution.cleanup({
    auditId, capabilityId: 'C'.repeat(22), sessionCapabilityId: 'S'.repeat(22), windowId: 9,
  }), /BATCH_AUDIT_CLEANUP_UNCONFIRMED/u);
  assert.equal(bindingCleared, false);
  assert.equal(queueCleared, false);
});

test('cleanup fails closed when an active batch binding has no ownership journal', async () => {
  const auditId = 'batch-cleanup-missing-owner';
  const ownershipId = `owner_${'M'.repeat(22)}`;
  let queueCleared = false;
  let bindingCleared = false;
  const execution = createBatchAuditExecutionV1({
    rawNavigationVault: {
      async readQueue() { return queueCleared ? null : queueFixture(auditId); },
      async replaceQueue() { throw new Error('REPLACE_MUST_NOT_RUN'); },
      async take() { throw new Error('TAKE_MUST_NOT_RUN'); },
      async clearAudit() { queueCleared = true; },
    },
    authority: {
      async transitionBatchAuditSession() { bindingCleared = true; throw new Error('BINDING_MUST_NOT_CLEAR'); },
    },
    ownedTabRegistry: {
      async get() { return null; },
      async removeOwned() { throw new Error('REMOVE_MUST_NOT_RUN'); },
    },
    createOwnershipId() { return `owner_${'A'.repeat(22)}`; },
    async runBatch() { throw new Error('RUN_MUST_NOT_RUN'); },
    async runUrlAuditExecution() { throw new Error('RUN_MUST_NOT_RUN'); },
    async readBatchCorrelation() {
      return {
        version: 1, capabilityId: 'C'.repeat(22), auditId,
        sessionCapabilityId: 'S'.repeat(22), windowId: 9,
        capabilityState: 'claimed', sessionState: 'running',
        activePageId: 'page-1', activeOwnershipId: ownershipId,
        issuedAt: 1_788_000_000_000, expiresAt: 1_788_001_800_000,
      };
    },
    async emitProgress() {},
    tryEnterFinalization() { return true; },
  });

  await assert.rejects(() => execution.cleanup({
    auditId, capabilityId: 'C'.repeat(22), sessionCapabilityId: 'S'.repeat(22), windowId: 9,
  }), /BATCH_AUDIT_CLEANUP_UNCONFIRMED/u);
  assert.equal(bindingCleared, false);
  assert.equal(queueCleared, false);
});
