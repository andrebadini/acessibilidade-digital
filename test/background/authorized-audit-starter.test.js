import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ACTIVE_AUDIT_JOB_KEY,
  createAuthorizedAuditStarter,
  executionCheckpointStorageKey,
  readActiveAuditJobForWorker,
  retentionPreferenceStorageKey,
} from '../../src/background/authorized-audit-starter.js';
import { createTargetCapabilityAuthority } from '../../src/background/target-capabilities.js';
import { createCapturePolicyV1 } from '../../src/core/privacy/capture-policy.js';
import { createInstalledCoreRuleInventory } from '../../src/core/rules/core-rule-inventory.js';
import { enrichAuditForReport } from '../../src/core/report/enrich-audit.js';
import { createAuditModel } from '../../src/core/report/audit-model.js';
import { createPanelResultBundleV1 } from '../../src/panel/panel-result-bundle.js';
import { SAMPLE_AUDIT } from '../../fixtures/audits/sample-audit.js';
import { reportInput } from '../report/helpers.js';

const DIGEST = `hmac-sha256:${'A'.repeat(43)}`;
const EPOCH = 1_788_000_000_000;

function sessionArea() {
  const values = Object.create(null);
  return {
    values,
    async get(key) {
      if (key === null) return structuredClone(values);
      if (Array.isArray(key)) return Object.fromEntries(key.filter(name => Object.hasOwn(values, name)).map(name => [name, structuredClone(values[name])]));
      return Object.hasOwn(values, key) ? { [key]: structuredClone(values[key]) } : {};
    },
    async set(entries) { Object.assign(values, structuredClone(entries)); },
    async remove(key) {
      for (const name of Array.isArray(key) ? key : [key]) delete values[name];
    },
  };
}

async function reportFixture(auditId, status = 'partial') {
  const draft = status === 'cancelled'
    ? createAuditModel(reportInput({
        auditId,
        session: {
          status: 'cancelled', partial: false,
          diagnostics: [{
            code: 'NAVIGATION_FAILED', message: 'A auditoria foi cancelada.',
            at: '2026-08-26T14:00:30.000Z', recoverable: false,
          }],
        },
      }))
    : structuredClone(SAMPLE_AUDIT);
  if (status !== 'cancelled') {
    draft.auditId = auditId;
    draft.session.status = status;
    draft.session.partial = status === 'partial';
    draft.integrity.canonicalModelHash = 'pending';
    draft.integrity.evidenceManifestHash = 'pending';
  }
  const model = await enrichAuditForReport(draft, {
    now: () => '2026-08-29T12:00:00.000Z', timezone: 'America/Cuiaba',
    manifestVersion: '0.1.0', rulesVersion: '1.0.0', browserVersion: 'Chrome/147.0.0.0',
  });
  const inventory = await createInstalledCoreRuleInventory();
  const checkpoint = {
    version: 1, auditId,
    pages: model.pages.map(page => ({
      pageId: page.pageId, attempted: page.attempted,
      startedAt: page.attempted ? page.timestamps.startedAt : null,
      rulesVersion: inventory.rulesVersion, inventoryVersion: inventory.inventoryVersion,
      inventoryHash: inventory.sha256, outcomes: [],
    })),
  };
  return { model, checkpoint, inventory };
}

async function authorityFixture(area, windowId = 9) {
  let random = 0;
  const authority = createTargetCapabilityAuthority({
    chromeApi: { runtime: { id: 'abcdefghijklmnopabcdefghijklmnop' } },
    sessionArea: area, now: () => EPOCH, randomBytes: length => new Uint8Array(length).fill(++random),
    probeDocument: async tabId => ({ tabId, windowId, documentId: 'document-a', urlSessionDigest: DIGEST }),
  });
  const prepared = await authority.prepare({
    kind: 'attached', tabId: 17, windowId, documentId: 'document-a',
    initialUrlEvidence: 'https://example.test/', initialUrlSessionDigest: DIGEST,
    createdBy: 'user', allowedIntent: 'start-audit',
    issuer: { type: 'extension-document', documentId: 'panel-doc', path: '/src/panel/index.html' },
  });
  const senderContext = {
    issuer: { type: 'extension-document', documentId: 'panel-doc', path: '/src/panel/index.html' },
    windowId, tabId: null, contextType: 'SIDE_PANEL',
    documentUrl: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/src/panel/index.html',
  };
  return { authority, capabilityId: prepared.capabilityId, senderContext };
}

function panelCoordinator(order = []) {
  return {
    async withWindowLock(windowId, fn) { order.push(`window:${windowId}:enter`); const value = await fn(); order.push(`window:${windowId}:leave`); return value; },
    async publishRegisteredBootstrap(value) { order.push('bootstrap'); assert.equal(value.windowId >= 0, true); return true; },
    async publishResult(value) { order.push(`publish:${value.state}`); return true; },
    async disconnectSession() { order.push('disconnect'); return true; },
  };
}

function dependencyFixture({ area, authority, execution, order = [], reportByAudit = new Map(), latest = { value: null } }) {
  return {
    authority, sessionArea: area, panelCoordinator: panelCoordinator(order),
    runAttachedAuditExecution: execution,
    async persistLatest({ state }) { order.push(`latest:${state.status}`); latest.value = structuredClone(state); return structuredClone(state); },
    async persistCheckpoint(value) {
      order.push('checkpoint');
      area.values[executionCheckpointStorageKey(value.auditId)] = structuredClone({ version: 1, ...value });
      return Object.freeze({ version: 1, ...structuredClone(value) });
    },
    async removeCheckpoint({ auditId, sessionCapabilityId, windowId }) {
      order.push('checkpoint-remove');
      const key = executionCheckpointStorageKey(auditId);
      const current = area.values[key];
      if (current && current.auditId === auditId && current.sessionCapabilityId === sessionCapabilityId && current.windowId === windowId) {
        delete area.values[key]; return Object.freeze({ removed: true });
      }
      return Object.freeze({ removed: false });
    },
    async commitTerminalAudit({ auditId, model, checkpoint, latestState, expectedRevision }) {
      order.push('commit');
      assert.equal(expectedRevision, 1);
      reportByAudit.set(auditId, Object.freeze({
        version: 1, auditId, modelRevision: 1, modelHash: model.integrity.canonicalModelHash, model, checkpoint,
      }));
      latest.value = structuredClone(latestState);
      return Object.freeze({ revision: 1, modelHash: model.integrity.canonicalModelHash });
    },
    async readAuditSnapshot({ auditId }) { return reportByAudit.has(auditId) ? { model: reportByAudit.get(auditId).model, revision: 1 } : { model: undefined, revision: 0 }; },
    async readReportRevision({ auditId }) { return reportByAudit.get(auditId) ?? null; },
    async readLatest() { return structuredClone(latest.value); },
    async buildPanelResultBundle({ reportRevision }) {
      const fixture = reportByAudit.get(reportRevision.auditId);
      const inventory = fixture?.inventory ?? await createInstalledCoreRuleInventory();
      return createPanelResultBundleV1({ reportRevision, inventory });
    },
    epochNow: () => EPOCH + 1,
    modelNow: () => '2026-08-29T12:00:00.000Z',
    createAbortController: () => new AbortController(),
  };
}

test('rejects a hostile retention intent before claim, journal or other effect', async () => {
  const area = sessionArea();
  const prepared = await authorityFixture(area);
  let executions = 0;
  const dependencies = dependencyFixture({ area, authority: prepared.authority, execution: async () => { executions += 1; } });
  const starter = createAuthorizedAuditStarter(dependencies);
  let reads = 0;
  const preference = { version: 1, deleteAfterCompleteExport: false };
  Object.defineProperty(preference, 'deleteAfterCompleteExport', { enumerable: true, get() { reads += 1; return false; } });
  const result = await starter.beginAuthorizedAudit({
    capabilityId: prepared.capabilityId, eventNonce: null, auditId: 'audit-hostile-intent',
    capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    retentionPreference: preference, senderContext: prepared.senderContext,
  });
  assert.deepEqual(result.response, { ok: false, code: 'AUDIT_START_FAILED' });
  assert.equal(reads, 0);
  assert.equal(executions, 0);
  assert.equal(Object.hasOwn(area.values, ACTIVE_AUDIT_JOB_KEY), false);
});

test('journals, claims, checkpoints and atomically settles a result before publication', async () => {
  const area = sessionArea();
  const prepared = await authorityFixture(area);
  const report = await reportFixture('audit-attached-result');
  const order = [];
  const reportByAudit = new Map();
  const execution = async ({ onCheckpoint, persistAuditModel }) => {
    order.push('run');
    await onCheckpoint(report.checkpoint);
    await persistAuditModel(report.model);
    return Object.freeze({
      version: 1, auditId: report.model.auditId, state: 'model', failureCode: null,
      model: report.model, checkpoint: report.checkpoint,
    });
  };
  const dependencies = dependencyFixture({ area, authority: prepared.authority, execution, order, reportByAudit });
  dependencies.buildPanelResultBundle = ({ reportRevision }) => createPanelResultBundleV1({ reportRevision, inventory: report.inventory });
  const starter = createAuthorizedAuditStarter(dependencies);
  const started = await starter.beginAuthorizedAudit({
    capabilityId: prepared.capabilityId, eventNonce: null, auditId: report.model.auditId,
    capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    retentionPreference: { version: 1, deleteAfterCompleteExport: false }, senderContext: prepared.senderContext,
  });
  assert.deepEqual(started.response, { ok: true, auditId: report.model.auditId, state: 'running' });
  assert.match(started.sessionCapabilityId, /^[A-Za-z0-9_-]{22}$/u);
  const active = await readActiveAuditJobForWorker({ sessionArea: area });
  assert.equal(active.auditId, report.model.auditId);
  const completion = await started.completion;
  assert.deepEqual(completion, { ok: true, auditId: report.model.auditId, state: 'result', revision: 1 });
  assert.equal(Object.hasOwn(area.values, ACTIVE_AUDIT_JOB_KEY), false);
  assert.equal(Object.hasOwn(area.values, executionCheckpointStorageKey(report.model.auditId)), false);
  assert.deepEqual(area.values[retentionPreferenceStorageKey(report.model.auditId)], {
    version: 1, auditId: report.model.auditId, deleteAfterCompleteExport: false,
    createdAt: EPOCH + 1, expiresAt: EPOCH + 30 * 60_000,
  });
  assert.ok(order.indexOf('commit') < order.indexOf('publish:result'));
  assert.ok(order.indexOf('checkpoint-remove') < order.indexOf('publish:result'));
});

test('recovers a durable running job as interrupted without resuming collection', async () => {
  const area = sessionArea();
  const prepared = await authorityFixture(area);
  const never = new Promise(() => {});
  const latest = { value: null };
  let executionCalls = 0;
  const dependencies = dependencyFixture({
    area, authority: prepared.authority, latest,
    execution: async () => { executionCalls += 1; return never; },
  });
  const starter = createAuthorizedAuditStarter(dependencies);
  const started = await starter.beginAuthorizedAudit({
    capabilityId: prepared.capabilityId, eventNonce: null, auditId: 'audit-recover-running',
    capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    retentionPreference: { version: 1, deleteAfterCompleteExport: false }, senderContext: prepared.senderContext,
  });
  assert.equal(started.response.ok, true);
  const recovered = createAuthorizedAuditStarter(dependencyFixture({
    area, authority: prepared.authority, latest,
    execution: async () => { throw new Error('must not resume'); },
  }));
  assert.deepEqual(await recovered.recoverAuthorizedAuditLifecycle(), {
    ok: true, state: 'interrupted', auditId: 'audit-recover-running', revision: null,
  });
  assert.equal(executionCalls, 1);
  assert.equal(latest.value.failureCode, 'AUDIT_INTERRUPTED');
  assert.equal(Object.hasOwn(area.values, ACTIVE_AUDIT_JOB_KEY), false);
});

test('blocks starts and recovery on malformed singleton state instead of overwriting it', async () => {
  const area = sessionArea();
  const prepared = await authorityFixture(area);
  area.values[ACTIVE_AUDIT_JOB_KEY] = { version: 1, auditId: 'foreign', state: 'running', secret: 'PRIVATE' };
  const starter = createAuthorizedAuditStarter(dependencyFixture({
    area, authority: prepared.authority, execution: async () => { throw new Error('must not run'); },
  }));
  assert.deepEqual(await starter.recoverAuthorizedAuditLifecycle(), {
    ok: false, state: 'blocked', auditId: null, revision: null, code: 'AUDIT_RECOVERY_REQUIRED',
  });
  const started = await starter.beginAuthorizedAudit({
    capabilityId: prepared.capabilityId, eventNonce: null, auditId: 'audit-blocked',
    capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    retentionPreference: { version: 1, deleteAfterCompleteExport: false }, senderContext: prepared.senderContext,
  });
  assert.deepEqual(started.response, { ok: false, code: 'AUDIT_RECOVERY_REQUIRED' });
  assert.equal(area.values[ACTIVE_AUDIT_JOB_KEY].secret, 'PRIVATE');
});

test('commits a canonical cancelled model exactly once when the runner bypasses persistence', async () => {
  const area = sessionArea();
  const prepared = await authorityFixture(area);
  const report = await reportFixture('audit-cancelled-once', 'cancelled');
  let commits = 0;
  const reportByAudit = new Map();
  const dependencies = dependencyFixture({
    area, authority: prepared.authority, reportByAudit,
    execution: async () => Object.freeze({
      version: 1, auditId: report.model.auditId, state: 'model', failureCode: null,
      model: report.model, checkpoint: report.checkpoint,
    }),
  });
  const originalCommit = dependencies.commitTerminalAudit;
  dependencies.commitTerminalAudit = async value => { commits += 1; return originalCommit(value); };
  dependencies.buildPanelResultBundle = ({ reportRevision }) => createPanelResultBundleV1({ reportRevision, inventory: report.inventory });
  const started = await createAuthorizedAuditStarter(dependencies).beginAuthorizedAudit({
    capabilityId: prepared.capabilityId, eventNonce: null, auditId: report.model.auditId,
    capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    retentionPreference: { version: 1, deleteAfterCompleteExport: false }, senderContext: prepared.senderContext,
  });
  assert.deepEqual(await started.completion, {
    ok: true, auditId: report.model.auditId, state: 'result', revision: 1,
  });
  assert.equal(commits, 1);
});

test('reconciles a confirmed finalizing revision and preserves a different latest audit', async () => {
  const area = sessionArea();
  const prepared = await authorityFixture(area);
  const report = await reportFixture('audit-finalizing-recovery');
  const reportByAudit = new Map();
  const latest = { value: null };
  let committedResolve;
  const committed = new Promise(resolve => { committedResolve = resolve; });
  const execution = async ({ onCheckpoint, persistAuditModel }) => {
    await onCheckpoint(report.checkpoint);
    await persistAuditModel(report.model);
    committedResolve();
    return new Promise(() => {});
  };
  const dependencies = dependencyFixture({ area, authority: prepared.authority, execution, reportByAudit, latest });
  dependencies.buildPanelResultBundle = ({ reportRevision }) => createPanelResultBundleV1({ reportRevision, inventory: report.inventory });
  const first = createAuthorizedAuditStarter(dependencies);
  const started = await first.beginAuthorizedAudit({
    capabilityId: prepared.capabilityId, eventNonce: null, auditId: report.model.auditId,
    capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    retentionPreference: { version: 1, deleteAfterCompleteExport: false }, senderContext: prepared.senderContext,
  });
  assert.equal(started.response.ok, true);
  await committed;
  assert.deepEqual(await readActiveAuditJobForWorker({ sessionArea: area }), {
    version: 1, auditId: report.model.auditId, capabilityId: prepared.capabilityId,
    sessionCapabilityId: started.sessionCapabilityId, windowId: 9, mode: 'attached',
    state: 'finalizing', commitState: 'confirmed', expectedTerminalRevision: 1,
    createdAt: EPOCH + 1, updatedAt: EPOCH + 1,
  });
  latest.value = {
    version: 1, auditId: 'newer-audit', status: 'running', percent: 0,
    message: 'Preparando a auditoria.', failureCode: null, modelRevision: null,
    updatedAt: '2026-08-29T12:00:01.000Z',
  };
  const recoveredDependencies = dependencyFixture({
    area, authority: prepared.authority, reportByAudit, latest,
    execution: async () => { throw new Error('must not resume'); },
  });
  recoveredDependencies.buildPanelResultBundle = ({ reportRevision }) => createPanelResultBundleV1({ reportRevision, inventory: report.inventory });
  const recovery = await createAuthorizedAuditStarter(recoveredDependencies).recoverAuthorizedAuditLifecycle();
  assert.deepEqual(recovery, { ok: true, state: 'reconciled', auditId: report.model.auditId, revision: 1 });
  assert.equal(latest.value.auditId, 'newer-audit');
  assert.equal(Object.hasOwn(area.values, ACTIVE_AUDIT_JOB_KEY), false);
});

test('active-job reader denies storage envelope drift and never returns the first record', async () => {
  const area = sessionArea();
  const record = {
    version: 1, auditId: 'audit-drift', capabilityId: 'A'.repeat(22), sessionCapabilityId: 'B'.repeat(22),
    windowId: 9, mode: 'attached', state: 'running', commitState: 'none', expectedTerminalRevision: null,
    createdAt: EPOCH, updatedAt: EPOCH,
  };
  let reads = 0;
  area.get = async key => {
    reads += 1;
    return { [key]: { ...record, updatedAt: EPOCH + reads - 1 } };
  };
  await assert.rejects(readActiveAuditJobForWorker({ sessionArea: area }), error => error?.message === 'ACTIVE_AUDIT_JOB_DENIED');
  assert.equal(reads, 2);
});
