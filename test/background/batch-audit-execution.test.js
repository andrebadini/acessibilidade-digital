import assert from 'node:assert/strict';
import test from 'node:test';

import { createBatchAuditExecutionV1 } from '../../src/background/batch-audit-execution.js';
import { createBatchProgressStoreV1 } from '../../src/background/batch-progress-store.js';
import { runBatch } from '../../src/background/run-batch.js';
import { renderHtmlReport } from '../../src/core/report/html.js';
import { createFakeIndexedDb } from '../support/fake-indexeddb.js';
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

function progressStoreFixture() {
  const records = new Map();
  return Object.freeze({
    async writeDraft(value) {
      if (value.model === null) {
        assert.ok(value.failure, 'a null model requires a factual failure record');
        assert.deepEqual(Reflect.ownKeys(value.failure).sort(), [
          'attempted', 'endedAt', 'kind', 'startedAt', 'urlEvidence', 'version',
        ]);
        assert.equal(value.failure.version, 1);
        assert.equal(value.failure.kind, 'pre-observation-failure');
        assert.equal(value.failure.attempted, true);
        assert.equal(value.failure.startedAt, STARTED_AT);
        assert.equal(value.failure.endedAt, STARTED_AT);
        assert.equal(value.failure.urlEvidence.queryIncluded, false);
        assert.equal(value.failure.urlEvidence.redactedSegments, 0);
      }
      const current = records.get(value.auditId) ?? { revision: 0, pages: [] };
      assert.equal(current.pages.length, value.expectedCompletedCount);
      const page = Object.freeze({
        pageId: value.pageId, childAuditId: value.childAuditId, state: 'draft',
        model: value.model, failure: value.failure ?? null, checkpoint: value.checkpoint,
      });
      const next = { revision: current.revision + 1, pages: [...current.pages, page] };
      records.set(value.auditId, next);
      return Object.freeze({ version: 1, auditId: value.auditId, revision: next.revision, page });
    },
    async markCompleted(value) {
      const current = records.get(value.auditId);
      assert.equal(current.revision, value.expectedRevision);
      assert.equal(current.pages.at(-1).pageId, value.pageId);
      const page = Object.freeze({ ...current.pages.at(-1), state: 'completed' });
      const next = { revision: current.revision + 1, pages: [...current.pages.slice(0, -1), page] };
      records.set(value.auditId, next);
      return Object.freeze({ version: 1, auditId: value.auditId, revision: next.revision, page });
    },
    async readCompleted({ auditId }) {
      const current = records.get(auditId);
      return current ? Object.freeze({
        version: 1, auditId, revision: current.revision,
        pages: Object.freeze(current.pages.filter(page => page.state === 'completed')),
      }) : null;
    },
    async clearAudit({ auditId }) { records.delete(auditId); return Object.freeze({ auditId, cleared: true }); },
    async discardAudit({ auditId }) { records.delete(auditId); return Object.freeze({ auditId, discarded: true }); },
  });
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
    batchProgressStore: progressStoreFixture(),
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

for (const recovered of [false, true]) test(`two sensitive batch pages finish each one-shot consent before the next page starts (recovered: ${recovered})`, async () => {
  const auditId = 'batch-pixel-pause';
  let queue = queueFixture(auditId);
  let activePageId = null;
  let activeOwnershipId = null;
  let cleared = false;
  let ownerCounter = 0;
  const owners = new Map();
  const events = [];
  const rawUrls = new Map([
    ['A'.repeat(22), 'https://one.example.test/private?token=REMOVE'],
    ['B'.repeat(22), 'https://two.example.test/secret?token=REMOVE'],
  ]);
  const pauses = [];
  let notifyPause;
  const nextPause = () => new Promise(resolve => { notifyPause = resolve; });
  let paused = nextPause();
  if (recovered) {
    ownerCounter = 1;
    activePageId = 'page-1';
    activeOwnershipId = `owner_${'A'.repeat(22)}`;
    queue.revision = 2;
    queue.entries[0].status = 'running';
    rawUrls.delete('A'.repeat(22));
    owners.set(activeOwnershipId, {
      version: 2, ownershipId: activeOwnershipId, auditId: `${auditId}:page-1`,
      purpose: 'audit', tabId: 71, windowId: 9, cleanupMode: 'always',
      state: 'retained-for-consent', createdAt: STARTED_AT, updatedAt: STARTED_AT,
    });
    pauses.push({ auditId, childAuditId: `${auditId}:page-1`, pageId: 'page-1', ownershipId: activeOwnershipId });
  }

  const execution = createBatchAuditExecutionV1({
    batchProgressStore: progressStoreFixture(),
    rawNavigationVault: {
      async readQueue() { return cleared ? null : structuredClone(queue); },
      async replaceQueue(_requestedAuditId, desired) { queue = structuredClone(desired); },
      async take(token) { events.push(`take:${token[0]}`); const raw = rawUrls.get(token); rawUrls.delete(token); return raw; },
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
    createPixelPrivacyGate(input) {
      events.push(`gate:${input.pageId}:${input.consentId === null ? 'initial' : 'resume'}`);
      return Object.freeze({ input });
    },
    async runUrlAuditExecution(request) {
      const pageId = request.auditId.endsWith('page-1') ? 'page-1' : 'page-2';
      const owner = owners.get(request.ownershipId ?? request.resumeTarget?.ownershipId);
      if (Object.hasOwn(request, 'resumeTarget')) {
        events.push(`resume:${pageId}`);
        assert.equal(request.resumeTarget.ownershipId, owner.ownershipId);
        assert.equal(request.resumeTarget.tabId, owner.tabId);
        assert.equal(Object.hasOwn(request, 'navigationToken'), false);
        assert.equal(Object.hasOwn(request, 'rawNavigationVault'), false);
        owners.set(owner.ownershipId, { ...owner, state: 'removed' });
        await request.onCheckpoint(checkpoint(request.auditId, 'page-1'));
        return {
          status: 'complete', model: { auditId: request.auditId },
          observedTarget: request.resumeTarget, observationState: 'observed', ownershipState: 'removed',
        };
      }
      await request.rawNavigationVault.take(request.navigationToken, {
        auditId: request.auditId, purpose: request.navigationPurpose,
        expectedEvidenceUrl: request.evidenceUrl, expectedSessionDigest: request.sessionDigest,
      });
      const record = {
        version: 2, ownershipId: request.ownershipId, auditId: request.auditId,
        purpose: 'audit', tabId: 70 + ownerCounter, windowId: 9, cleanupMode: 'always',
        state: 'retained-for-consent',
        createdAt: STARTED_AT, updatedAt: STARTED_AT,
      };
      owners.set(request.ownershipId, record);
      await request.onCheckpoint(checkpoint(request.auditId, 'page-1'));
      events.push(`initial:${pageId}`);
      return {
        status: 'privacy-paused', model: null,
        observedTarget: {
          version: 'ObservedTargetV1', kind: 'owned-disposable', ownershipId: request.ownershipId,
          tabId: record.tabId, windowId: 9, documentId: `document-${pageId}`,
          urlEvidence: request.evidenceUrl, urlSessionDigest: request.sessionDigest,
          cleanupMode: 'always', pageId: 'page-1',
        },
        observationState: 'observed', ownershipState: 'retained-for-consent',
        signals: { version: 'SensitiveCaptureSignalsV1', detected: true, categories: ['password'] },
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
          onCheckpoint: async value => { pages[index] = value.pages[0]; },
        });
        events.push(`runner-done:${pageId}`);
        assert.equal(result.ownershipState, 'removed');
        await request.onExecutionCheckpoint({ version: 1, auditId, pages: [...pages] });
      }
      return { auditId, session: { status: 'complete' } };
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

  const running = execution[recovered ? 'recover' : 'run']({
    auditId, capabilityId: 'C'.repeat(22), sessionCapabilityId: 'S'.repeat(22), windowId: 9,
    ...(recovered ? {
      consentId: 'A'.repeat(21) + 'Q',
      resumeTarget: {
        version: 'ObservedTargetV1', kind: 'owned-disposable', ownershipId: activeOwnershipId,
        tabId: 71, windowId: 9, documentId: 'document-page-1',
        urlEvidence: queue.entries[0].evidenceUrl, urlSessionDigest: queue.entries[0].sessionDigest,
        cleanupMode: 'always', pageId: 'page-1',
      },
      resumeCheckpoint: checkpoint(auditId, 'page-1'),
    } : { acceptedCount: 2 }),
    capturePolicy: createCapturePolicyV1({ mode: 'full-evidence', includeQuery: false }),
    now: () => STARTED_AT, signal: new AbortController().signal,
    reportOptions: {
      timezone: 'America/Cuiaba', manifestVersion: '1.0.6', rulesVersion: '1.0.0',
      browserVersion: 'Chrome/152.0.0.0', expectedExtensionId: EXTENSION_ID,
    },
    async onExecutionCheckpoint() {},
    async onPrivacyPaused(value) {
      events.push(`paused:${value.pageId}`);
      pauses.push(value);
      notifyPause(value);
    },
    async onPixelPageFinished(value) {
      events.push(`consent-finished:${value.pageId}`);
      assert.equal(value.auditId, auditId);
      assert.equal(value.childAuditId, `${auditId}:${value.pageId}`);
      assert.equal(value.ownershipId, pauses.at(-1).ownershipId);
      assert.match(value.consentId, /^[A-Za-z0-9_-]{21}[AQgw]$/u);
    },
  });

  const completedBeforePause = running.then(() => { throw new Error('BATCH_FINISHED_BEFORE_SECOND_CONSENT'); });
  const firstPause = recovered ? pauses[0] : await Promise.race([paused, completedBeforePause]);
  assert.equal(firstPause.auditId, auditId);
  assert.equal(firstPause.pageId, 'page-1');
  assert.equal(firstPause.ownershipId, activeOwnershipId);
  assert.equal(queue.nextIndex, 0);
  assert.equal(queue.entries[0].status, 'running');
  assert.equal(queue.entries[1].status, 'pending');
  assert.equal(events.includes('initial:page-2'), false);
  assert.equal(owners.get(activeOwnershipId).state, 'retained-for-consent');

  if (!recovered) {
    paused = nextPause();
    assert.equal(await execution.resume({
      auditId, pageId: firstPause.pageId, ownershipId: firstPause.ownershipId,
      consentId: 'A'.repeat(21) + 'Q',
    }), true);
  }
  const secondPause = await Promise.race([paused, completedBeforePause]);
  assert.equal(secondPause.pageId, 'page-2');
  assert.notEqual(secondPause.ownershipId, firstPause.ownershipId);
  assert.equal(events.indexOf('consent-finished:page-1') < events.indexOf('initial:page-2'), true);
  assert.equal(await execution.resume({
    auditId, pageId: secondPause.pageId, ownershipId: secondPause.ownershipId,
    consentId: 'B'.repeat(21) + 'Q',
  }), true);
  await running;

  assert.deepEqual(events.filter(value => /^(initial|resume|runner-done):/u.test(value)), [
    ...(!recovered ? ['initial:page-1'] : []), 'resume:page-1', 'runner-done:page-1',
    'initial:page-2', 'resume:page-2', 'runner-done:page-2',
  ]);
  assert.deepEqual(events.filter(value => value.startsWith('consent-finished:')), [
    'consent-finished:page-1', 'consent-finished:page-2',
  ]);
  assert.equal(queue.nextIndex, 2);
  assert.equal(activePageId, null);
  assert.equal(activeOwnershipId, null);
  assert.equal(cleared, true);
  await assert.rejects(() => execution.resume({
    auditId, pageId: firstPause.pageId, ownershipId: firstPause.ownershipId,
    consentId: 'A'.repeat(21) + 'Q',
  }), /BATCH_PIXEL_RESUME_DENIED/u);
  await assert.rejects(() => execution.resume({
    auditId, pageId: secondPause.pageId, ownershipId: secondPause.ownershipId,
    consentId: 'B'.repeat(21) + 'Q',
  }), /BATCH_PIXEL_RESUME_DENIED/u);
});

test('restart accepts no completed-progress record while the first batch page is paused', async () => {
  const auditId = 'batch-recover-first-page';
  const ownershipId = `owner_${'R'.repeat(22)}`;
  const queue = queueFixture(auditId);
  queue.revision = 2;
  queue.entries[0].status = 'running';
  let reachedBatchRunner = false;
  const execution = createBatchAuditExecutionV1({
    rawNavigationVault: {
      async readQueue(requestedAuditId) {
        assert.equal(requestedAuditId, auditId);
        return structuredClone(queue);
      },
      async replaceQueue() { throw new Error('REPLACE_MUST_NOT_RUN'); },
      async take() { throw new Error('TAKE_MUST_NOT_RUN'); },
      async clearAudit() { throw new Error('CLEAR_MUST_NOT_RUN'); },
    },
    authority: {
      async transitionBatchAuditSession() { throw new Error('TRANSITION_MUST_NOT_RUN'); },
    },
    ownedTabRegistry: {
      async get(requestedOwnershipId) {
        assert.equal(requestedOwnershipId, ownershipId);
        return {
          version: 2,
          ownershipId,
          auditId: `${auditId}:page-1`,
          purpose: 'audit',
          tabId: 91,
          windowId: 9,
          cleanupMode: 'always',
          state: 'retained-for-consent',
          createdAt: STARTED_AT,
          updatedAt: STARTED_AT,
        };
      },
      async removeOwned() { throw new Error('REMOVE_MUST_NOT_RUN'); },
    },
    batchProgressStore: {
      async writeDraft() { throw new Error('WRITE_MUST_NOT_RUN'); },
      async markCompleted() { throw new Error('COMPLETE_MUST_NOT_RUN'); },
      async readCompleted({ auditId: requestedAuditId }) {
        assert.equal(requestedAuditId, auditId);
        return null;
      },
      async clearAudit() { throw new Error('PROGRESS_CLEAR_MUST_NOT_RUN'); },
      async discardAudit() { throw new Error('PROGRESS_DISCARD_MUST_NOT_RUN'); },
    },
    createOwnershipId() { return `owner_${'N'.repeat(22)}`; },
    async runBatch(request) {
      reachedBatchRunner = true;
      assert.deepEqual(request.completedPages, []);
      assert.equal(request.batchStartedAt, new Date(queue.issuedAt).toISOString());
      throw new Error('RECOVERY_RUN_REACHED');
    },
    async runUrlAuditExecution() { throw new Error('URL_RUN_MUST_NOT_RUN'); },
    async readBatchCorrelation() {
      return {
        version: 1,
        capabilityId: 'C'.repeat(22),
        auditId,
        sessionCapabilityId: 'S'.repeat(22),
        windowId: 9,
        capabilityState: 'claimed',
        sessionState: 'running',
        activePageId: 'page-1',
        activeOwnershipId: ownershipId,
        issuedAt: 1_788_000_000_000,
        expiresAt: 1_788_001_800_000,
      };
    },
    async emitProgress() {},
    tryEnterFinalization() { return true; },
    createPixelPrivacyGate() { return Object.freeze({}); },
  });

  await assert.rejects(() => execution.recover({
    auditId,
    capabilityId: 'C'.repeat(22),
    sessionCapabilityId: 'S'.repeat(22),
    windowId: 9,
    capturePolicy: createCapturePolicyV1({ mode: 'full-evidence', includeQuery: false }),
    now: () => STARTED_AT,
    signal: new AbortController().signal,
    reportOptions: {
      timezone: 'America/Cuiaba',
      manifestVersion: '1.0.6',
      rulesVersion: '1.0.0',
      browserVersion: 'Chrome/152.0.0.0',
      expectedExtensionId: EXTENSION_ID,
    },
    async onExecutionCheckpoint() {},
    async onPrivacyPaused() {},
    async onPixelPageFinished() {},
    consentId: `${'A'.repeat(21)}Q`,
    resumeTarget: {
      version: 'ObservedTargetV1',
      kind: 'owned-disposable',
      ownershipId,
      tabId: 91,
      windowId: 9,
      documentId: 'document-page-1',
      urlEvidence: queue.entries[0].evidenceUrl,
      urlSessionDigest: queue.entries[0].sessionDigest,
      cleanupMode: 'always',
      pageId: 'page-1',
    },
    resumeCheckpoint: checkpoint(auditId, 'page-1'),
  }), /RECOVERY_RUN_REACHED/u);
  assert.equal(reachedBatchRunner, true);
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
  const batchProgressStore = createBatchProgressStoreV1({ indexedDB: createFakeIndexedDb() });
  const execution = createBatchAuditExecutionV1({
    batchProgressStore,
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
      return {
        status: 'failed', model: null, observedTarget: null,
        observationState: 'pre-observation-failure', ownershipState: 'removed',
      };
    },
    runBatch,
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
  assert.equal(result.model.pages.length, 2);
  assert.deepEqual(result.model.pages.map(page => page.status), ['failed', 'failed']);
  assert.equal(result.model.pages[0].diagnostics[0].code, 'BATCH_PAGE_FAILED');
  assert.match(renderHtmlReport(result.model), /^<!doctype html>/u);
  assert.equal(result.checkpoint.pages[0].attempted, true);
  assert.deepEqual(result.checkpoint.pages[0].outcomes, []);
  assert.equal(queue.nextIndex, 2);
  assert.equal(cleared, true);
  const persisted = await batchProgressStore.readCompleted({ auditId });
  assert.equal(persisted.pages[0].model, null);
  assert.equal(persisted.pages[0].failure.kind, 'pre-observation-failure');
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
  const batchProgressStore = progressStoreFixture();
  await batchProgressStore.writeDraft({
    auditId, pageId: 'page-1', childAuditId: `${auditId}:page-1`,
    model: { auditId: `${auditId}:page-1` }, checkpoint: checkpoint(`${auditId}:page-1`, 'page-1'),
    expectedCompletedCount: 0,
  });
  const execution = createBatchAuditExecutionV1({
    batchProgressStore,
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
  assert.notEqual(await batchProgressStore.readCompleted({ auditId }), null);
  assert.equal(await execution.discardProgress({ auditId }), true);
  assert.equal(await batchProgressStore.readCompleted({ auditId }), null);
  await assert.rejects(() => execution.discardProgress({ auditId, extra: true }), /BATCH_PROGRESS_DISCARD_DENIED/u);
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
    batchProgressStore: progressStoreFixture(),
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
    batchProgressStore: progressStoreFixture(),
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
