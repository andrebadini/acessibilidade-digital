import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ACTIVE_AUDIT_JOB_KEY,
  createAuthorizedAuditStarter,
  executionCheckpointStorageKey,
  readActiveAuditJobForWorker,
  retentionPreferenceStorageKey,
} from '../../src/background/authorized-audit-starter.js';
import { panelBootstrapStorageKey } from '../../src/background/panel-port.js';
import {
  createTargetCapabilityAuthority,
  readAttachedAuditCorrelationForRecovery,
  readAuditSessionForWorker,
} from '../../src/background/target-capabilities.js';
import { createCapturePolicyV1 } from '../../src/core/privacy/capture-policy.js';
import { createInstalledCoreRuleInventory } from '../../src/core/rules/core-rule-inventory.js';
import { enrichAuditForReport } from '../../src/core/report/enrich-audit.js';
import { createAuditModel } from '../../src/core/report/audit-model.js';
import { createPanelResultBundleV1 } from '../../src/panel/panel-result-bundle.js';
import { SAMPLE_AUDIT } from '../../fixtures/audits/sample-audit.js';
import { reportInput } from '../report/helpers.js';

const DIGEST = `hmac-sha256:${'A'.repeat(43)}`;
const EPOCH = 1_788_000_000_000;
const START_JOURNAL_KEY = 'audita:start-journal:v1';

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

function panelCoordinator(order = [], overrides = {}) {
  const scope = Object.freeze({
    async registerPendingBootstrap(value) { order.push('bootstrap-register'); assert.equal(value.windowId >= 0, true); return true; },
    async publishRegisteredBootstrap(value) { order.push('bootstrap'); assert.equal(value.windowId >= 0, true); return true; },
    async publishResult(value) { order.push(`publish:${value.state}`); return true; },
    async registerAndPublishViewOnly() { return { registered: true, delivered: false }; },
    async disconnectSession() { order.push('disconnect'); return true; },
    ...overrides,
  });
  return Object.freeze({
    attachPanelPort() { return true; },
    async withWindowLock(windowId, fn) {
      order.push(`window:${windowId}:enter`);
      const value = await fn(scope);
      order.push(`window:${windowId}:leave`);
      return value;
    },
  });
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
    async readAuditSnapshot({ auditId }) {
      return reportByAudit.has(auditId)
        ? { model: reportByAudit.get(auditId).model, revision: 1, capability: Object.freeze(Object.create(null)) }
        : { model: undefined, revision: 0, capability: null };
    },
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

function instrumentAuthority(authority, effects) {
  return Object.freeze({
    ...authority,
    async claimAndIssueAuditSession(args) {
      effects.claims += 1;
      return authority.claimAndIssueAuditSession(args);
    },
    async claimWorkerEventAndIssueAuditSession(args) {
      effects.claims += 1;
      return authority.claimWorkerEventAndIssueAuditSession(args);
    },
  });
}

function instrumentJournalStorage(area, createEnvelope = null) {
  const effects = { writes: 0, removals: 0 };
  const originalGet = area.get.bind(area);
  const originalSet = area.set.bind(area);
  const originalRemove = area.remove.bind(area);
  if (createEnvelope) {
    area.get = async key => key === START_JOURNAL_KEY ? createEnvelope() : originalGet(key);
  }
  area.set = async entries => {
    if (Object.hasOwn(entries, START_JOURNAL_KEY)) effects.writes += 1;
    return originalSet(entries);
  };
  area.remove = async key => {
    if ((Array.isArray(key) && key.includes(START_JOURNAL_KEY)) || key === START_JOURNAL_KEY) effects.removals += 1;
    return originalRemove(key);
  };
  return effects;
}

function malformedJournalEnvelopeCases(getterState) {
  const journal = {
    version: 1, capabilityId: 'A'.repeat(22), auditId: 'hostile-audit', windowId: 9,
    state: 'prepared', sessionCapabilityId: null, createdAt: EPOCH, updatedAt: EPOCH,
  };
  return [
    ['accessor', () => {
      const envelope = {};
      Object.defineProperty(envelope, START_JOURNAL_KEY, {
        enumerable: true,
        get() { getterState.calls += 1; return journal; },
      });
      return envelope;
    }],
    ['non-enumerable', () => {
      const envelope = {};
      Object.defineProperty(envelope, START_JOURNAL_KEY, { enumerable: false, value: journal });
      return envelope;
    }],
    ['symbol', () => ({ [START_JOURNAL_KEY]: journal, [Symbol('private')]: true })],
    ['extra key', () => ({ [START_JOURNAL_KEY]: journal, extra: true })],
    ['wrong key', () => ({ other: journal })],
    ['custom prototype', () => Object.assign(Object.create({ inherited: true }), { [START_JOURNAL_KEY]: journal })],
    ['explicit undefined', () => ({ [START_JOURNAL_KEY]: undefined })],
    ['defined invalid row', () => ({ [START_JOURNAL_KEY]: null })],
    ['array', () => []],
    ['primitive', () => 7],
    ['ownKeys failure', () => new Proxy({ [START_JOURNAL_KEY]: journal }, {
      ownKeys() { throw new Error('PRIVATE_OWN_KEYS_FAILURE'); },
    })],
    ['descriptor failure', () => new Proxy({ [START_JOURNAL_KEY]: journal }, {
      getOwnPropertyDescriptor() { throw new Error('PRIVATE_DESCRIPTOR_FAILURE'); },
    })],
  ];
}

test('explicit undefined start-journal storage blocks begin before overwrite, claim, bootstrap or publication', async () => {
  const area = sessionArea();
  const prepared = await authorityFixture(area);
  area.values[START_JOURNAL_KEY] = undefined;
  const effects = { claims: 0 };
  const order = [];
  const storageEffects = instrumentJournalStorage(area);
  const starter = createAuthorizedAuditStarter(dependencyFixture({
    area,
    authority: instrumentAuthority(prepared.authority, effects),
    order,
    execution: async () => Object.freeze({
      version: 1, auditId: 'audit-undefined-journal', state: 'revoked',
      failureCode: 'AUDIT_FAILED', model: null, checkpoint: null,
    }),
  }));

  const started = await starter.beginAuthorizedAudit({
    capabilityId: prepared.capabilityId, eventNonce: null, auditId: 'audit-undefined-journal',
    capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    retentionPreference: { version: 1, deleteAfterCompleteExport: false }, senderContext: prepared.senderContext,
  });
  if (started.completion) await started.completion;

  assert.deepEqual(started.response, { ok: false, code: 'AUDIT_RECOVERY_REQUIRED' });
  assert.equal(started.sessionCapabilityId, null);
  assert.equal(effects.claims, 0);
  assert.equal(storageEffects.writes, 0);
  assert.equal(storageEffects.removals, 0);
  assert.deepEqual(order, []);
  assert.equal(Object.hasOwn(area.values, START_JOURNAL_KEY), true);
  assert.equal(area.values[START_JOURNAL_KEY], undefined);
});

test('explicit undefined start-journal storage blocks lifecycle recovery instead of reporting idle', async () => {
  const area = sessionArea();
  const prepared = await authorityFixture(area);
  area.values[START_JOURNAL_KEY] = undefined;
  const order = [];
  const storageEffects = instrumentJournalStorage(area);
  const recovered = await createAuthorizedAuditStarter(dependencyFixture({
    area, authority: prepared.authority, order,
    execution: async () => { throw new Error('must not resume'); },
  })).recoverAuthorizedAuditLifecycle();

  assert.deepEqual(recovered, {
    ok: false, state: 'blocked', auditId: null, revision: null, code: 'AUDIT_RECOVERY_REQUIRED',
  });
  assert.equal(storageEffects.writes, 0);
  assert.equal(storageEffects.removals, 0);
  assert.deepEqual(order, []);
  assert.equal(Object.hasOwn(area.values, START_JOURNAL_KEY), true);
  assert.equal(area.values[START_JOURNAL_KEY], undefined);
});

test('hostile start-journal storage envelopes block begin and recovery with zero effects', async t => {
  const getterState = { calls: 0 };
  for (const [name, createEnvelope] of malformedJournalEnvelopeCases(getterState)) {
    await t.test(name, async () => {
      const beginArea = sessionArea();
      const prepared = await authorityFixture(beginArea);
      const beginEffects = { claims: 0 };
      const beginOrder = [];
      const beginStorageEffects = instrumentJournalStorage(beginArea, createEnvelope);
      const started = await createAuthorizedAuditStarter(dependencyFixture({
        area: beginArea,
        authority: instrumentAuthority(prepared.authority, beginEffects),
        order: beginOrder,
        execution: async () => { throw new Error('must not run'); },
      })).beginAuthorizedAudit({
        capabilityId: prepared.capabilityId, eventNonce: null, auditId: `audit-hostile-${name.replaceAll(' ', '-')}`,
        capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
        retentionPreference: { version: 1, deleteAfterCompleteExport: false }, senderContext: prepared.senderContext,
      });

      assert.deepEqual(started.response, { ok: false, code: 'AUDIT_RECOVERY_REQUIRED' });
      assert.equal(started.sessionCapabilityId, null);
      assert.equal(beginEffects.claims, 0);
      assert.equal(beginStorageEffects.writes, 0);
      assert.equal(beginStorageEffects.removals, 0);
      assert.deepEqual(beginOrder, []);

      const recoveryArea = sessionArea();
      const recoveryPrepared = await authorityFixture(recoveryArea);
      const recoveryOrder = [];
      const recoveryStorageEffects = instrumentJournalStorage(recoveryArea, createEnvelope);
      const recovered = await createAuthorizedAuditStarter(dependencyFixture({
        area: recoveryArea, authority: recoveryPrepared.authority, order: recoveryOrder,
        execution: async () => { throw new Error('must not resume'); },
      })).recoverAuthorizedAuditLifecycle();

      assert.deepEqual(recovered, {
        ok: false, state: 'blocked', auditId: null, revision: null, code: 'AUDIT_RECOVERY_REQUIRED',
      });
      assert.equal(recoveryStorageEffects.writes, 0);
      assert.equal(recoveryStorageEffects.removals, 0);
      assert.deepEqual(recoveryOrder, []);
    });
  }
  assert.equal(getterState.calls, 0);
});

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

test('native dependency messages cannot spoof TARGET_UNAVAILABLE selection', async () => {
  const area = sessionArea();
  const prepared = await authorityFixture(area);
  const dependencies = dependencyFixture({
    area, authority: prepared.authority,
    execution: async () => { throw new Error('must not run'); },
  });
  dependencies.readAuditSnapshot = async () => { throw new Error('TARGET_UNAVAILABLE'); };

  const started = await createAuthorizedAuditStarter(dependencies).beginAuthorizedAudit({
    capabilityId: prepared.capabilityId, eventNonce: null, auditId: 'audit-native-target-spoof',
    capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    retentionPreference: { version: 1, deleteAfterCompleteExport: false }, senderContext: prepared.senderContext,
  });

  assert.deepEqual(started.response, { ok: false, code: 'AUDIT_START_FAILED' });
});

test('starts from the exact missing snapshot contract returned by the real audit store', async () => {
  const area = sessionArea();
  const prepared = await authorityFixture(area);
  const dependencies = dependencyFixture({
    area, authority: prepared.authority,
    execution: async ({ auditId }) => Object.freeze({
      version: 1, auditId, state: 'revoked', failureCode: 'AUDIT_FAILED', model: null, checkpoint: null,
    }),
  });
  dependencies.readAuditSnapshot = async () => ({ model: undefined, revision: 0, capability: null });

  const started = await createAuthorizedAuditStarter(dependencies).beginAuthorizedAudit({
    capabilityId: prepared.capabilityId, eventNonce: null, auditId: 'audit-real-missing-snapshot',
    capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    retentionPreference: { version: 1, deleteAfterCompleteExport: false }, senderContext: prepared.senderContext,
  });

  assert.deepEqual(started.response, { ok: true, auditId: 'audit-real-missing-snapshot', state: 'running' });
  assert.match(started.sessionCapabilityId, /^[A-Za-z0-9_-]{22}$/u);
  await started.completion;
});

test('rejects malformed missing-snapshot lookalikes before claim or persistence', async t => {
  let getterCalls = 0;
  const accessor = { model: undefined, revision: 0 };
  Object.defineProperty(accessor, 'capability', {
    enumerable: true,
    get() { getterCalls += 1; return null; },
  });
  const cases = [
    ['legacy two-key shape', { model: undefined, revision: 0 }],
    ['extra key', { model: undefined, revision: 0, capability: null, extra: true }],
    ['non-null capability without a model', { model: undefined, revision: 0, capability: Object.freeze(Object.create(null)) }],
    ['nonzero revision without a model', { model: undefined, revision: 1, capability: null }],
    ['accessor capability', accessor],
  ];
  for (const [name, snapshot] of cases) {
    await t.test(name, async () => {
      const area = sessionArea();
      const prepared = await authorityFixture(area);
      const effects = { claims: 0 };
      const order = [];
      const dependencies = dependencyFixture({
        area, authority: instrumentAuthority(prepared.authority, effects), order,
        execution: async () => { throw new Error('must not run'); },
      });
      dependencies.readAuditSnapshot = async () => snapshot;

      const started = await createAuthorizedAuditStarter(dependencies).beginAuthorizedAudit({
        capabilityId: prepared.capabilityId, eventNonce: null, auditId: `audit-hostile-snapshot-${name.replaceAll(' ', '-')}`,
        capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
        retentionPreference: { version: 1, deleteAfterCompleteExport: false }, senderContext: prepared.senderContext,
      });

      assert.deepEqual(started.response, { ok: false, code: 'AUDIT_ID_COLLISION' });
      assert.equal(started.sessionCapabilityId, null);
      assert.equal(effects.claims, 0);
      assert.deepEqual(order, []);
    });
  }
  assert.equal(getterCalls, 0);
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
  dependencies.panelCoordinator = panelCoordinator(order, {
    async registerPendingBootstrap(value) {
      assert.equal(Object.hasOwn(area.values, 'audita:start-journal:v1'), true);
      assert.equal(Object.hasOwn(area.values, ACTIVE_AUDIT_JOB_KEY), false);
      order.push('bootstrap-register');
      return true;
    },
    async publishRegisteredBootstrap() {
      assert.equal(Object.hasOwn(area.values, 'audita:start-journal:v1'), false);
      assert.equal(Object.hasOwn(area.values, ACTIVE_AUDIT_JOB_KEY), true);
      order.push('bootstrap');
      return true;
    },
  });
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
  assert.ok(order.indexOf('bootstrap-register') < order.indexOf('latest:running'));
  assert.ok(order.indexOf('latest:running') < order.indexOf('bootstrap'));
  assert.ok(order.indexOf('bootstrap') < order.indexOf('run'));
});

test('compensates a false bootstrap publication instead of reporting a running audit', async () => {
  const area = sessionArea();
  const prepared = await authorityFixture(area);
  let executions = 0;
  const dependencies = dependencyFixture({
    area, authority: prepared.authority,
    execution: async () => { executions += 1; },
  });
  dependencies.panelCoordinator = panelCoordinator([], { publishRegisteredBootstrap: async () => false });
  const starter = createAuthorizedAuditStarter(dependencies);

  const started = await starter.beginAuthorizedAudit({
    capabilityId: prepared.capabilityId, eventNonce: null, auditId: 'audit-bootstrap-false',
    capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    retentionPreference: { version: 1, deleteAfterCompleteExport: false }, senderContext: prepared.senderContext,
  });

  assert.deepEqual(started.response, { ok: false, code: 'AUDIT_START_FAILED' });
  assert.equal(started.sessionCapabilityId, null);
  assert.equal(executions, 0);
  assert.equal(Object.hasOwn(area.values, ACTIVE_AUDIT_JOB_KEY), false);
  assert.equal(Object.hasOwn(area.values, retentionPreferenceStorageKey('audit-bootstrap-false')), false);
  assert.equal(Object.hasOwn(area.values, 'audita:start-journal:v1'), false);
});

test('journal removal failure after ACTIVE triggers complete verified start compensation', async () => {
  const area = sessionArea();
  const prepared = await authorityFixture(area);
  const latest = { value: null };
  let executions = 0;
  const originalRemove = area.remove.bind(area);
  let journalRemovals = 0;
  area.remove = async key => {
    if (key === 'audita:start-journal:v1' && journalRemovals++ === 0) return;
    return originalRemove(key);
  };
  const dependencies = dependencyFixture({
    area, authority: prepared.authority, latest,
    execution: async () => { executions += 1; },
  });
  dependencies.panelCoordinator = panelCoordinator([], {
    async registerPendingBootstrap(value) {
      area.values[panelBootstrapStorageKey(value.windowId)] = {
        version: 1, kind: 'audit-session', ...structuredClone(value), state: 'pending',
      };
      return true;
    },
    async publishRegisteredBootstrap(value) {
      return true;
    },
    async publishResult() { return true; },
    async disconnectSession({ auditId, sessionCapabilityId, windowId }) {
      const key = panelBootstrapStorageKey(windowId);
      const bootstrap = area.values[key];
      if (bootstrap && bootstrap.auditId === auditId && bootstrap.sessionCapabilityId === sessionCapabilityId) delete area.values[key];
      return !Object.hasOwn(area.values, key);
    },
  });
  const starter = createAuthorizedAuditStarter(dependencies);

  const started = await starter.beginAuthorizedAudit({
    capabilityId: prepared.capabilityId, eventNonce: null, auditId: 'audit-active-compensation',
    capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    retentionPreference: { version: 1, deleteAfterCompleteExport: false }, senderContext: prepared.senderContext,
  });

  assert.deepEqual(started.response, { ok: false, code: 'AUDIT_START_FAILED' });
  assert.equal(executions, 0);
  assert.equal(Object.hasOwn(area.values, ACTIVE_AUDIT_JOB_KEY), false);
  assert.equal(Object.hasOwn(area.values, executionCheckpointStorageKey('audit-active-compensation')), false);
  assert.equal(Object.hasOwn(area.values, panelBootstrapStorageKey(9)), false);
  assert.equal(Object.hasOwn(area.values, retentionPreferenceStorageKey('audit-active-compensation')), false);
  assert.equal(Object.hasOwn(area.values, 'audita:start-journal:v1'), false);
  assert.equal(latest.value.auditId, 'audit-active-compensation');
  assert.equal(latest.value.failureCode, 'AUDIT_FAILED');
  const correlation = await readAttachedAuditCorrelationForRecovery({
    sessionArea: area, capabilityId: prepared.capabilityId, auditId: 'audit-active-compensation',
  });
  assert.equal(correlation.targetState, 'invalidated');
  const revoked = await readAuditSessionForWorker({
    sessionArea: area, sessionCapabilityId: correlation.sessionCapabilityId, auditId: 'audit-active-compensation',
  });
  assert.equal(revoked.state, 'revoked');
});

test('incomplete post-ACTIVE compensation returns recovery-required and keeps ACTIVE recoverable', async () => {
  const area = sessionArea();
  const prepared = await authorityFixture(area);
  const originalRemove = area.remove.bind(area);
  let journalRemovals = 0;
  area.remove = async key => {
    if (key === 'audita:start-journal:v1' && journalRemovals++ === 0) return;
    return originalRemove(key);
  };
  const dependencies = dependencyFixture({
    area, authority: prepared.authority,
    execution: async () => { throw new Error('must not run'); },
  });
  dependencies.panelCoordinator = panelCoordinator([], { disconnectSession: async () => false });

  const started = await createAuthorizedAuditStarter(dependencies).beginAuthorizedAudit({
    capabilityId: prepared.capabilityId, eventNonce: null, auditId: 'audit-compensation-blocked',
    capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    retentionPreference: { version: 1, deleteAfterCompleteExport: false }, senderContext: prepared.senderContext,
  });

  assert.deepEqual(started.response, { ok: false, code: 'AUDIT_RECOVERY_REQUIRED' });
  const active = await readActiveAuditJobForWorker({ sessionArea: area });
  assert.equal(active.auditId, 'audit-compensation-blocked');
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

test('running recovery preserves a supported foreign legacy export latest record', async () => {
  const area = sessionArea();
  const prepared = await authorityFixture(area);
  const latest = { value: null };
  const starter = createAuthorizedAuditStarter(dependencyFixture({
    area, authority: prepared.authority, latest,
    execution: async () => new Promise(() => {}),
  }));
  const started = await starter.beginAuthorizedAudit({
    capabilityId: prepared.capabilityId, eventNonce: null, auditId: 'audit-recover-foreign-latest',
    capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    retentionPreference: { version: 1, deleteAfterCompleteExport: false }, senderContext: prepared.senderContext,
  });
  assert.equal(started.response.ok, true);
  latest.value = {
    auditId: 'foreign-export-audit', status: 'complete', exportStatus: 'queued', exportRevision: 3,
  };

  const recovered = createAuthorizedAuditStarter(dependencyFixture({
    area, authority: prepared.authority, latest,
    execution: async () => { throw new Error('must not resume'); },
  }));
  assert.deepEqual(await recovered.recoverAuthorizedAuditLifecycle(), {
    ok: true, state: 'interrupted', auditId: 'audit-recover-foreign-latest', revision: null,
  });
  assert.deepEqual(latest.value, {
    auditId: 'foreign-export-audit', status: 'complete', exportStatus: 'queued', exportRevision: 3,
  });
});

test('running recovery blocks and retains ACTIVE when durable panel cleanup cannot be confirmed', async () => {
  const area = sessionArea();
  const prepared = await authorityFixture(area);
  const latest = { value: null };
  const starter = createAuthorizedAuditStarter(dependencyFixture({
    area, authority: prepared.authority, latest,
    execution: async () => new Promise(() => {}),
  }));
  const started = await starter.beginAuthorizedAudit({
    capabilityId: prepared.capabilityId, eventNonce: null, auditId: 'audit-recovery-cleanup-blocked',
    capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    retentionPreference: { version: 1, deleteAfterCompleteExport: false }, senderContext: prepared.senderContext,
  });
  assert.equal(started.response.ok, true);
  const dependencies = dependencyFixture({
    area, authority: prepared.authority, latest,
    execution: async () => { throw new Error('must not resume'); },
  });
  dependencies.panelCoordinator = panelCoordinator([], { disconnectSession: async () => false });

  assert.deepEqual(await createAuthorizedAuditStarter(dependencies).recoverAuthorizedAuditLifecycle(), {
    ok: false, state: 'blocked', auditId: null, revision: null, code: 'AUDIT_RECOVERY_REQUIRED',
  });
  const active = await readActiveAuditJobForWorker({ sessionArea: area });
  assert.equal(active.auditId, 'audit-recovery-cleanup-blocked');
});

test('prepared-journal recovery blocks and preserves a concurrent replacement during cleanup', async () => {
  const area = sessionArea();
  const prepared = await authorityFixture(area);
  area.values['audita:start-journal:v1'] = {
    version: 1, capabilityId: prepared.capabilityId, auditId: 'audit-prepared-replacement', windowId: 9,
    state: 'prepared', sessionCapabilityId: null, createdAt: EPOCH, updatedAt: EPOCH,
  };
  const replacement = {
    version: 1, capabilityId: 'R'.repeat(22), auditId: 'foreign-replacement', windowId: 11,
    state: 'prepared', sessionCapabilityId: null, createdAt: EPOCH + 1, updatedAt: EPOCH + 1,
  };
  const originalRemove = area.remove.bind(area);
  area.remove = async key => {
    if (key === 'audita:start-journal:v1') {
      area.values[key] = structuredClone(replacement);
      return;
    }
    return originalRemove(key);
  };
  const recovery = await createAuthorizedAuditStarter(dependencyFixture({
    area, authority: prepared.authority,
    execution: async () => { throw new Error('must not resume'); },
  })).recoverAuthorizedAuditLifecycle();

  assert.deepEqual(recovery, {
    ok: false, state: 'blocked', auditId: null, revision: null, code: 'AUDIT_RECOVERY_REQUIRED',
  });
  assert.deepEqual(area.values['audita:start-journal:v1'], replacement);
});

test('revoked settlement blocks and retains recoverable ACTIVE when durable panel cleanup fails', async () => {
  const area = sessionArea();
  const prepared = await authorityFixture(area);
  const dependencies = dependencyFixture({
    area, authority: prepared.authority,
    execution: async () => Object.freeze({
      version: 1, auditId: 'audit-settlement-blocked', state: 'revoked',
      failureCode: 'AUDIT_FAILED', model: null, checkpoint: null,
    }),
  });
  dependencies.panelCoordinator = panelCoordinator([], { disconnectSession: async () => false });
  const started = await createAuthorizedAuditStarter(dependencies).beginAuthorizedAudit({
    capabilityId: prepared.capabilityId, eventNonce: null, auditId: 'audit-settlement-blocked',
    capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    retentionPreference: { version: 1, deleteAfterCompleteExport: false }, senderContext: prepared.senderContext,
  });

  assert.deepEqual(await started.completion, {
    ok: false, auditId: 'audit-settlement-blocked', state: 'blocked', code: 'AUDIT_RECOVERY_REQUIRED',
  });
  const active = await readActiveAuditJobForWorker({ sessionArea: area });
  assert.equal(active.auditId, 'audit-settlement-blocked');
  assert.equal(active.state, 'running');
});

test('revoked settlement succeeds without a live port after correlated durable bootstrap cleanup', async () => {
  const area = sessionArea();
  const prepared = await authorityFixture(area);
  const dependencies = dependencyFixture({
    area, authority: prepared.authority,
    execution: async () => Object.freeze({
      version: 1, auditId: 'audit-no-live-settlement', state: 'revoked',
      failureCode: 'AUDIT_FAILED', model: null, checkpoint: null,
    }),
  });
  dependencies.panelCoordinator = panelCoordinator([], {
    async registerPendingBootstrap(value) {
      area.values[panelBootstrapStorageKey(value.windowId)] = {
        version: 1, kind: 'audit-session', ...structuredClone(value), state: 'pending',
      };
      return true;
    },
    async publishRegisteredBootstrap() { return true; },
    async publishResult() { return false; },
    async disconnectSession({ auditId, sessionCapabilityId, windowId }) {
      const key = panelBootstrapStorageKey(windowId);
      const bootstrap = area.values[key];
      if (!bootstrap || bootstrap.auditId !== auditId || bootstrap.sessionCapabilityId !== sessionCapabilityId) return false;
      delete area.values[key];
      return true;
    },
  });
  const started = await createAuthorizedAuditStarter(dependencies).beginAuthorizedAudit({
    capabilityId: prepared.capabilityId, eventNonce: null, auditId: 'audit-no-live-settlement',
    capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    retentionPreference: { version: 1, deleteAfterCompleteExport: false }, senderContext: prepared.senderContext,
  });

  assert.deepEqual(await started.completion, {
    ok: true, auditId: 'audit-no-live-settlement', state: 'revoked', code: 'AUDIT_FAILED',
  });
  assert.equal(Object.hasOwn(area.values, panelBootstrapStorageKey(9)), false);
  assert.equal(Object.hasOwn(area.values, ACTIVE_AUDIT_JOB_KEY), false);
});

test('native runner messages cannot spoof AUDIT_REVOKED selection', async () => {
  const area = sessionArea();
  const prepared = await authorityFixture(area);
  const started = await createAuthorizedAuditStarter(dependencyFixture({
    area, authority: prepared.authority,
    execution: async () => { throw new Error('AUDIT_REVOKED'); },
  })).beginAuthorizedAudit({
    capabilityId: prepared.capabilityId, eventNonce: null, auditId: 'audit-native-revoked-spoof',
    capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    retentionPreference: { version: 1, deleteAfterCompleteExport: false }, senderContext: prepared.senderContext,
  });

  assert.deepEqual(await started.completion, {
    ok: true, auditId: 'audit-native-revoked-spoof', state: 'revoked', code: 'AUDIT_FAILED',
  });
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

test('an accepted user cancellation wins before ACTIVE enters finalizing and commits only the cancelled model', async () => {
  const area = sessionArea();
  const prepared = await authorityFixture(area);
  const auditId = 'audit-cancel-before-finalizing';
  const terminal = await reportFixture(auditId);
  const cancelled = await reportFixture(auditId, 'cancelled');
  const reportByAudit = new Map();
  const committedStatuses = [];
  let releaseBundle;
  let reachedBundle;
  const bundleReached = new Promise(resolve => { reachedBundle = resolve; });
  const bundleGate = new Promise(resolve => { releaseBundle = resolve; });
  const execution = async ({ onCheckpoint, persistAuditModel }) => {
    await onCheckpoint(terminal.checkpoint);
    try {
      await persistAuditModel(terminal.model);
      assert.fail('the pre-cancel terminal candidate must not commit');
    } catch {
      await onCheckpoint(cancelled.checkpoint);
      return Object.freeze({
        version: 1, auditId, state: 'model', failureCode: null,
        model: cancelled.model, checkpoint: cancelled.checkpoint,
      });
    }
  };
  const dependencies = dependencyFixture({ area, authority: prepared.authority, execution, reportByAudit });
  const commit = dependencies.commitTerminalAudit;
  dependencies.commitTerminalAudit = async value => {
    committedStatuses.push(value.model.session.status);
    return commit(value);
  };
  dependencies.buildPanelResultBundle = async ({ reportRevision }) => {
    if (reportRevision.model.session.status !== 'cancelled') {
      reachedBundle();
      await bundleGate;
    }
    return createPanelResultBundleV1({ reportRevision, inventory: terminal.inventory });
  };
  const starter = createAuthorizedAuditStarter(dependencies);
  const started = await starter.beginAuthorizedAudit({
    capabilityId: prepared.capabilityId, eventNonce: null, auditId,
    capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    retentionPreference: { version: 1, deleteAfterCompleteExport: false }, senderContext: prepared.senderContext,
  });
  await bundleReached;

  const cancellation = await starter.abortAuthorizedAudit({
    auditId, sessionCapabilityId: started.sessionCapabilityId, windowId: 9, reasonCode: 'USER_CANCELLED',
  });
  releaseBundle();
  const completion = await started.completion;

  assert.deepEqual(cancellation, { ok: true, auditId, state: 'cancelling' });
  assert.deepEqual(completion, { ok: true, auditId, state: 'result', revision: 1 });
  assert.deepEqual(committedStatuses, ['cancelled']);
  assert.equal(reportByAudit.get(auditId).model.session.status, 'cancelled');
  const session = await readAuditSessionForWorker({
    sessionArea: area, sessionCapabilityId: started.sessionCapabilityId, auditId,
  });
  assert.equal(session.state, 'result');
  assert.equal(Object.hasOwn(area.values, ACTIVE_AUDIT_JOB_KEY), false);
});

test('finalizing fallback reconciles a witnessed commit after the commit adapter return is denied', async () => {
  const area = sessionArea();
  const prepared = await authorityFixture(area);
  const report = await reportFixture('audit-finalizing-fallback');
  const reportByAudit = new Map();
  const dependencies = dependencyFixture({
    area, authority: prepared.authority, reportByAudit,
    execution: async ({ onCheckpoint, persistAuditModel }) => {
      await onCheckpoint(report.checkpoint);
      await persistAuditModel(report.model);
      throw new Error('must not continue after denied adapter return');
    },
  });
  const commit = dependencies.commitTerminalAudit;
  dependencies.commitTerminalAudit = async value => {
    await commit(value);
    return Object.freeze({ revision: 1, modelHash: '0'.repeat(64) });
  };
  dependencies.buildPanelResultBundle = ({ reportRevision }) => createPanelResultBundleV1({
    reportRevision, inventory: report.inventory,
  });
  const started = await createAuthorizedAuditStarter(dependencies).beginAuthorizedAudit({
    capabilityId: prepared.capabilityId, eventNonce: null, auditId: report.model.auditId,
    capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    retentionPreference: { version: 1, deleteAfterCompleteExport: false }, senderContext: prepared.senderContext,
  });

  assert.deepEqual(await started.completion, {
    ok: true, auditId: report.model.auditId, state: 'result', revision: 1,
  });
  assert.equal(Object.hasOwn(area.values, ACTIVE_AUDIT_JOB_KEY), false);
});

test('settlement blocks with finalizing ACTIVE when result publication returns a non-boolean confirmation', async () => {
  const area = sessionArea();
  const prepared = await authorityFixture(area);
  const report = await reportFixture('audit-publication-confirmation');
  const reportByAudit = new Map();
  const dependencies = dependencyFixture({
    area, authority: prepared.authority, reportByAudit,
    execution: async ({ onCheckpoint, persistAuditModel }) => {
      await onCheckpoint(report.checkpoint);
      await persistAuditModel(report.model);
      return Object.freeze({
        version: 1, auditId: report.model.auditId, state: 'model', failureCode: null,
        model: report.model, checkpoint: report.checkpoint,
      });
    },
  });
  dependencies.buildPanelResultBundle = ({ reportRevision }) => createPanelResultBundleV1({
    reportRevision, inventory: report.inventory,
  });
  dependencies.panelCoordinator = panelCoordinator([], { publishResult: async () => undefined });
  const started = await createAuthorizedAuditStarter(dependencies).beginAuthorizedAudit({
    capabilityId: prepared.capabilityId, eventNonce: null, auditId: report.model.auditId,
    capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    retentionPreference: { version: 1, deleteAfterCompleteExport: false }, senderContext: prepared.senderContext,
  });

  assert.deepEqual(await started.completion, {
    ok: false, auditId: report.model.auditId, state: 'blocked', code: 'AUDIT_RECOVERY_REQUIRED',
  });
  const active = await readActiveAuditJobForWorker({ sessionArea: area });
  assert.equal(active.state, 'finalizing');
  assert.equal(active.commitState, 'confirmed');
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
