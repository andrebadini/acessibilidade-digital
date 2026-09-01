import { isCapturePolicyV1 } from '../core/privacy/capture-policy.js';
import { isEvidenceUrlV1 } from '../core/privacy/evidence-url.js';
import { createInstalledCoreRuleInventory } from '../core/rules/core-rule-inventory.js';
import { createPageCheckpointRecorder, validateExecutionCheckpoint } from './execution-checkpoint.js';
import { canonicalTime } from './run-audit.js';
import { createBatchExecutionRunner } from './run-batch.js';

const FACTORY_KEYS = Object.freeze([
  'rawNavigationVault', 'authority', 'ownedTabRegistry', 'createOwnershipId',
  'runBatch', 'runUrlAuditExecution', 'readBatchCorrelation', 'emitProgress',
  'tryEnterFinalization',
]);
const RUN_KEYS = Object.freeze([
  'auditId', 'capabilityId', 'sessionCapabilityId', 'windowId', 'acceptedCount',
  'capturePolicy', 'now', 'signal', 'reportOptions', 'onExecutionCheckpoint',
]);
const CLEANUP_KEYS = Object.freeze([
  'auditId', 'capabilityId', 'sessionCapabilityId', 'windowId',
]);
const QUEUE_KEYS = Object.freeze([
  'version', 'auditId', 'ownerOperationId', 'revision', 'issuedAt', 'expiresAt', 'nextIndex', 'entries',
]);
const QUEUE_ENTRY_KEYS = Object.freeze([
  'line', 'navigationToken', 'evidenceUrl', 'sessionDigest', 'status',
]);
const EVIDENCE_KEYS = Object.freeze(['version', 'href', 'queryIncluded', 'redactedSegments']);
const OWNER_KEYS = Object.freeze([
  'version', 'ownershipId', 'auditId', 'purpose', 'tabId', 'windowId',
  'cleanupMode', 'state', 'createdAt', 'updatedAt',
]);
const RUNNER_OPTION_KEYS = Object.freeze([
  'url', 'chromeAdapter', 'expectedExtensionId', 'now', 'idFactory', 'signal',
  'closeAuditTab', 'pageId', 'cleanupMode', 'checkpointAuditId', 'onCheckpoint',
]);
const AUDIT_ID = /^[A-Za-z0-9._:-]{1,160}$/u;
const CAPABILITY = /^[A-Za-z0-9_-]{22}$/u;
const OWNER_ID = /^owner_[A-Za-z0-9_-]{22}$/u;
const TOKEN = /^[A-Za-z0-9_-]{22}$/u;
const DIGEST = /^hmac-sha256:[A-Za-z0-9_-]{43}$/u;

function freeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freeze(child, seen);
  return Object.freeze(value);
}

function exact(value, keys) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
    const own = Reflect.ownKeys(value);
    if (own.length !== keys.length || own.some(key => typeof key !== 'string' || !keys.includes(key))) return null;
    const copy = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      copy[key] = descriptor.value;
    }
    return copy;
  } catch { return null; }
}

function dense(value) {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
    const own = Reflect.ownKeys(value);
    const expected = ['length', ...Array.from({ length: value.length }, (_entry, index) => String(index))];
    if (own.length !== expected.length || expected.some(key => !own.includes(key))) return null;
    return Array.from({ length: value.length }, (_entry, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new TypeError();
      return descriptor.value;
    });
  } catch { return null; }
}

function copyEvidence(value) {
  const evidence = exact(value, EVIDENCE_KEYS);
  return evidence && isEvidenceUrlV1(evidence) && evidence.queryIncluded === false
    ? freeze({ ...evidence })
    : null;
}

function copyQueue(value, auditId, acceptedCount) {
  const queue = exact(value, QUEUE_KEYS);
  const values = queue && dense(queue.entries);
  if (!queue || queue.version !== 1 || queue.auditId !== auditId || !TOKEN.test(queue.ownerOperationId ?? '') ||
    !Number.isSafeInteger(queue.revision) || queue.revision < 1 ||
    !Number.isSafeInteger(queue.issuedAt) || queue.issuedAt < 0 ||
    !Number.isSafeInteger(queue.expiresAt) || queue.expiresAt <= queue.issuedAt ||
    !Number.isSafeInteger(queue.nextIndex) || queue.nextIndex < 0 || queue.nextIndex > acceptedCount ||
    !values || values.length !== acceptedCount) return null;
  const lines = new Set();
  const tokens = new Set();
  const entries = values.map(value => {
    const entry = exact(value, QUEUE_ENTRY_KEYS);
    const evidenceUrl = entry && copyEvidence(entry.evidenceUrl);
    if (!entry || !Number.isSafeInteger(entry.line) || entry.line < 1 || lines.has(entry.line) ||
      !TOKEN.test(entry.navigationToken ?? '') || tokens.has(entry.navigationToken) || !evidenceUrl ||
      !DIGEST.test(entry.sessionDigest ?? '') || !['pending', 'running', 'finished'].includes(entry.status)) return null;
    lines.add(entry.line);
    tokens.add(entry.navigationToken);
    return freeze({ ...entry, evidenceUrl });
  });
  if (entries.some(entry => entry === null)) return null;
  for (let index = 0; index < queue.nextIndex; index += 1) if (entries[index].status !== 'finished') return null;
  if (queue.nextIndex === entries.length) {
    if (entries.some(entry => entry.status !== 'finished')) return null;
  } else if (!['pending', 'running'].includes(entries[queue.nextIndex].status) ||
    entries.slice(queue.nextIndex + 1).some(entry => entry.status !== 'pending')) return null;
  return freeze({ ...queue, entries });
}

function copyCorrelation(value, expected) {
  const correlation = exact(value, [
    'version', 'capabilityId', 'auditId', 'sessionCapabilityId', 'windowId',
    'capabilityState', 'sessionState', 'activePageId', 'activeOwnershipId', 'issuedAt', 'expiresAt',
  ]);
  const empty = correlation?.activePageId === null && correlation?.activeOwnershipId === null;
  const active = AUDIT_ID.test(correlation?.activePageId ?? '') && OWNER_ID.test(correlation?.activeOwnershipId ?? '');
  return correlation?.version === 1 && correlation.capabilityId === expected.capabilityId &&
    correlation.auditId === expected.auditId && correlation.sessionCapabilityId === expected.sessionCapabilityId &&
    correlation.windowId === expected.windowId && correlation.capabilityState === 'claimed' &&
    correlation.sessionState === 'running' && (empty || active) &&
    Number.isSafeInteger(correlation.issuedAt) && Number.isSafeInteger(correlation.expiresAt) &&
    correlation.expiresAt > correlation.issuedAt ? freeze(correlation) : null;
}

function copyOwner(value, expected) {
  const owner = exact(value, OWNER_KEYS);
  return owner?.version === 2 && owner.ownershipId === expected.ownershipId &&
    owner.auditId === expected.auditId && owner.purpose === 'audit' &&
    Number.isSafeInteger(owner.tabId) && owner.tabId >= 0 && owner.windowId === expected.windowId &&
    owner.cleanupMode === 'always' && owner.state === 'removed'
    ? freeze(owner)
    : null;
}

function copyOwnerForCleanup(value, expected) {
  if (value === null) return null;
  const owner = exact(value, OWNER_KEYS);
  return owner?.version === 2 && owner.ownershipId === expected.ownershipId &&
    owner.auditId === expected.auditId && owner.purpose === 'audit' &&
    Number.isSafeInteger(owner.tabId) && owner.tabId >= 0 && owner.windowId === expected.windowId &&
    owner.cleanupMode === 'always' &&
    ['created', 'observing', 'retained-for-review', 'retained-for-consent', 'cleanup-pending', 'removed'].includes(owner.state)
    ? freeze(owner)
    : undefined;
}

function copyCleanupCorrelation(value, expected) {
  const correlation = exact(value, [
    'version', 'capabilityId', 'auditId', 'sessionCapabilityId', 'windowId',
    'capabilityState', 'sessionState', 'activePageId', 'activeOwnershipId', 'issuedAt', 'expiresAt',
  ]);
  const empty = correlation?.activePageId === null && correlation?.activeOwnershipId === null;
  const active = /^page-([1-9]|1[0-9]|20)$/u.test(correlation?.activePageId ?? '') &&
    OWNER_ID.test(correlation?.activeOwnershipId ?? '');
  return correlation?.version === 1 && correlation.capabilityId === expected.capabilityId &&
    correlation.auditId === expected.auditId && correlation.sessionCapabilityId === expected.sessionCapabilityId &&
    correlation.windowId === expected.windowId && ['claimed', 'invalidated'].includes(correlation.capabilityState) &&
    ['running', 'revoked', 'result'].includes(correlation.sessionState) && (empty || active) &&
    Number.isSafeInteger(correlation.issuedAt) && Number.isSafeInteger(correlation.expiresAt) &&
    correlation.expiresAt > correlation.issuedAt ? freeze(correlation) : null;
}

function projectCheckpoint(checkpoint, childAuditId, parentAuditId, pageId) {
  const child = validateExecutionCheckpoint({
    auditId: childAuditId,
    checkpoint,
    pageOrder: ['page-1'],
  });
  return validateExecutionCheckpoint({
    auditId: parentAuditId,
    checkpoint: {
      version: 1,
      auditId: parentAuditId,
      pages: [{ ...child.pages[0], pageId }],
    },
    pageOrder: [pageId],
  });
}

export function createBatchAuditExecutionV1(rawDependencies) {
  const dependencies = exact(rawDependencies, FACTORY_KEYS);
  if (!dependencies ||
    typeof dependencies.rawNavigationVault?.readQueue !== 'function' ||
    typeof dependencies.rawNavigationVault.replaceQueue !== 'function' ||
    typeof dependencies.rawNavigationVault.take !== 'function' ||
    typeof dependencies.rawNavigationVault.clearAudit !== 'function' ||
    typeof dependencies.authority?.transitionBatchAuditSession !== 'function' ||
    typeof dependencies.ownedTabRegistry?.get !== 'function' ||
    typeof dependencies.ownedTabRegistry.removeOwned !== 'function' ||
    typeof dependencies.createOwnershipId !== 'function' || typeof dependencies.runBatch !== 'function' ||
    typeof dependencies.runUrlAuditExecution !== 'function' || typeof dependencies.readBatchCorrelation !== 'function' ||
    typeof dependencies.emitProgress !== 'function' || typeof dependencies.tryEnterFinalization !== 'function') {
    throw new TypeError('BATCH_AUDIT_EXECUTION_INVALID');
  }

  const readQueue = async (auditId, acceptedCount) => copyQueue(
    await dependencies.rawNavigationVault.readQueue(auditId), auditId, acceptedCount,
  );

  const transitionQueue = async ({ auditId, acceptedCount, pageIndex, fromStatus, toStatus }) => {
    const current = await readQueue(auditId, acceptedCount);
    if (!current || current.nextIndex !== pageIndex || current.entries[pageIndex]?.status !== fromStatus) {
      throw new Error('BATCH_QUEUE_DENIED');
    }
    const entries = current.entries.map((entry, index) => index === pageIndex
      ? { ...entry, status: toStatus }
      : { ...entry });
    const desired = freeze({
      ...current,
      revision: current.revision + 1,
      nextIndex: toStatus === 'finished' ? current.nextIndex + 1 : current.nextIndex,
      entries,
    });
    await dependencies.rawNavigationVault.replaceQueue(auditId, desired, {
      expectedRevision: current.revision,
      expectedState: { nextIndex: current.nextIndex, status: fromStatus },
    });
    const confirmed = await readQueue(auditId, acceptedCount);
    if (!confirmed || confirmed.revision !== desired.revision || confirmed.nextIndex !== desired.nextIndex ||
      (toStatus === 'finished'
        ? confirmed.entries[pageIndex]?.status !== 'finished'
        : confirmed.entries[pageIndex]?.status !== toStatus)) throw new Error('BATCH_QUEUE_DENIED');
    return confirmed;
  };

  const readCorrelation = async args => copyCorrelation(
    await dependencies.readBatchCorrelation({ capabilityId: args.capabilityId, auditId: args.auditId }), args,
  );

  async function run(raw) {
    const args = exact(raw, RUN_KEYS);
    const policy = args && exact(args.capturePolicy, [
      'version', 'mode', 'includeQuery', 'captureFullPage', 'captureElements', 'composeAnnouncementMap',
    ]);
    if (!args || !AUDIT_ID.test(args.auditId ?? '') || !CAPABILITY.test(args.capabilityId ?? '') ||
      !CAPABILITY.test(args.sessionCapabilityId ?? '') || !Number.isSafeInteger(args.windowId) || args.windowId < 0 ||
      !Number.isSafeInteger(args.acceptedCount) || args.acceptedCount < 2 || args.acceptedCount > 20 ||
      !policy || !isCapturePolicyV1(policy) || policy.mode !== 'no-pixels' || policy.includeQuery !== false ||
      typeof args.now !== 'function' || !args.signal || typeof args.signal !== 'object' ||
      typeof args.onExecutionCheckpoint !== 'function') throw new TypeError('BATCH_AUDIT_EXECUTION_DENIED');
    const initialCorrelation = await readCorrelation(args);
    const initialQueue = await readQueue(args.auditId, args.acceptedCount);
    if (!initialCorrelation || initialCorrelation.activePageId !== null || initialCorrelation.activeOwnershipId !== null ||
      !initialQueue || initialQueue.nextIndex !== 0 || initialQueue.entries[0].status !== 'pending') {
      throw new Error('BATCH_AUDIT_EXECUTION_DENIED');
    }
    const inventory = await createInstalledCoreRuleInventory();
    const entries = initialQueue.entries.map(entry => freeze({
      line: entry.line,
      navigationUrl: entry.evidenceUrl.href,
      evidenceUrl: { ...entry.evidenceUrl },
    }));
    const pageOrder = entries.map((_entry, index) => `page-${index + 1}`);
    let latestCheckpoint = null;
    const runner = createBatchExecutionRunner(async rawOptions => {
      const options = exact(rawOptions, RUNNER_OPTION_KEYS);
      const pageMatch = options && /^page-([1-9]|1[0-9]|20)$/u.exec(options.pageId ?? '');
      const pageIndex = pageMatch ? Number(pageMatch[1]) - 1 : -1;
      const childAuditId = options && typeof options.idFactory === 'function' ? options.idFactory() : null;
      if (!options || pageIndex < 0 || pageIndex >= args.acceptedCount || childAuditId !== `${args.auditId}:${options.pageId}` ||
        options.checkpointAuditId !== args.auditId || options.cleanupMode !== 'always' || options.closeAuditTab !== true ||
        typeof options.onCheckpoint !== 'function' || options.signal !== args.signal && typeof options.signal !== 'object') {
        throw new Error('BATCH_PAGE_EXECUTION_DENIED');
      }
      const pendingQueue = await readQueue(args.auditId, args.acceptedCount);
      const entry = pendingQueue?.entries[pageIndex];
      if (!pendingQueue || pendingQueue.nextIndex !== pageIndex || entry?.status !== 'pending' ||
        options.url !== entry.evidenceUrl.href) throw new Error('BATCH_PAGE_EXECUTION_DENIED');
      const ownershipId = dependencies.createOwnershipId();
      if (!OWNER_ID.test(ownershipId ?? '')) throw new Error('BATCH_PAGE_EXECUTION_DENIED');
      await transitionQueue({
        auditId: args.auditId, acceptedCount: args.acceptedCount, pageIndex,
        fromStatus: 'pending', toStatus: 'running',
      });
      const bound = await dependencies.authority.transitionBatchAuditSession({
        sessionCapabilityId: args.sessionCapabilityId,
        auditId: args.auditId,
        fromPageId: null,
        fromOwnershipId: null,
        toPageId: options.pageId,
        toOwnershipId: ownershipId,
      });
      if (bound?.ok !== true || bound.activePageId !== options.pageId || bound.activeOwnershipId !== ownershipId) {
        throw new Error('BATCH_PAGE_EXECUTION_DENIED');
      }
      const correlated = await readCorrelation(args);
      if (!correlated || correlated.activePageId !== options.pageId || correlated.activeOwnershipId !== ownershipId) {
        throw new Error('BATCH_PAGE_EXECUTION_DENIED');
      }
      let tokenConsumed = false;
      let pageCheckpoint = null;
      const navigationVault = Object.freeze({
        async take(navigationToken, request) {
          const captured = exact(request, [
            'auditId', 'purpose', 'expectedEvidenceUrl', 'expectedSessionDigest',
          ]);
          const evidenceUrl = captured && copyEvidence(captured.expectedEvidenceUrl);
          if (!captured || captured.auditId !== childAuditId || captured.purpose !== 'batch-page' ||
            navigationToken !== entry.navigationToken || !evidenceUrl ||
            evidenceUrl.href !== entry.evidenceUrl.href || captured.expectedSessionDigest !== entry.sessionDigest || tokenConsumed) {
            throw new Error('BATCH_PAGE_EXECUTION_DENIED');
          }
          const rawUrl = await dependencies.rawNavigationVault.take(navigationToken, {
            auditId: args.auditId,
            purpose: 'batch-page',
            expectedEvidenceUrl: entry.evidenceUrl,
            expectedSessionDigest: entry.sessionDigest,
          });
          tokenConsumed = true;
          return rawUrl;
        },
      });
      const observed = await dependencies.runUrlAuditExecution({
        auditId: childAuditId,
        ownershipId,
        windowId: args.windowId,
        navigationToken: entry.navigationToken,
        navigationPurpose: 'batch-page',
        evidenceUrl: entry.evidenceUrl,
        sessionDigest: entry.sessionDigest,
        rawNavigationVault: navigationVault,
        capturePolicy: freeze({ ...policy }),
        modelNow: args.now,
        signal: options.signal,
        onProgress: event => options.chromeAdapter.emitProgress(event),
        onCheckpoint: async checkpoint => {
          pageCheckpoint = projectCheckpoint(checkpoint, childAuditId, args.auditId, options.pageId);
          await options.onCheckpoint(pageCheckpoint);
        },
        async persistAuditModel() {},
      });
      const result = exact(observed, [
        'status', 'model', 'observedTarget', 'observationState', 'ownershipState',
      ]) ?? exact(observed, [
        'status', 'model', 'observedTarget', 'observationState', 'ownershipState', 'signals',
      ]);
      const rawOwner = await dependencies.ownedTabRegistry.get(ownershipId);
      const owner = copyOwner(rawOwner, {
        ownershipId, auditId: childAuditId, windowId: args.windowId,
      });
      const factualPreObservationFailure = result?.status === 'failed' && result.model === null &&
        result.observedTarget === null && result.observationState === 'pre-observation-failure' &&
        result.ownershipState === 'removed';
      if (factualPreObservationFailure && pageCheckpoint === null) {
        const recorder = await createPageCheckpointRecorder({
          auditId: childAuditId,
          pageId: 'page-1',
          startedAt: canonicalTime(args.now()),
          rulesVersion: inventory.rulesVersion,
          inventory,
          onCheckpoint: async checkpoint => {
            pageCheckpoint = projectCheckpoint(checkpoint, childAuditId, args.auditId, options.pageId);
            await options.onCheckpoint(pageCheckpoint);
          },
        });
        await recorder.started();
      }
      const cleanupConfirmed = Boolean(owner) || factualPreObservationFailure && rawOwner === null;
      if (!result || !pageCheckpoint || result.ownershipState !== 'removed' || !cleanupConfirmed ||
        !tokenConsumed && !factualPreObservationFailure) {
        throw new Error('BATCH_PAGE_CLEANUP_UNCONFIRMED');
      }
      const cleared = await dependencies.authority.transitionBatchAuditSession({
        sessionCapabilityId: args.sessionCapabilityId,
        auditId: args.auditId,
        fromPageId: options.pageId,
        fromOwnershipId: ownershipId,
        toPageId: null,
        toOwnershipId: null,
      });
      if (cleared?.ok !== true || cleared.activePageId !== null || cleared.activeOwnershipId !== null) {
        throw new Error('BATCH_PAGE_CLEANUP_UNCONFIRMED');
      }
      const clearedCorrelation = await readCorrelation(args);
      if (!clearedCorrelation || clearedCorrelation.activePageId !== null || clearedCorrelation.activeOwnershipId !== null) {
        throw new Error('BATCH_PAGE_CLEANUP_UNCONFIRMED');
      }
      await transitionQueue({
        auditId: args.auditId, acceptedCount: args.acceptedCount, pageIndex,
        fromStatus: 'running', toStatus: 'finished',
      });
      return freeze({ model: result.model, checkpoint: pageCheckpoint, ownershipState: 'removed' });
    });
    const model = await dependencies.runBatch({
      entries,
      batchAuditId: args.auditId,
      chromeAdapter: Object.freeze({
        emitProgress: event => dependencies.emitProgress(event),
        tryEnterFinalization: () => dependencies.tryEnterFinalization(),
        async handoffReport() { return { reviewUrl: null, artifact: { status: 'pending', formats: [] } }; },
      }),
      runner,
      now: args.now,
      signal: args.signal,
      reportOptions: args.reportOptions,
      onExecutionCheckpoint: async checkpoint => {
        latestCheckpoint = validateExecutionCheckpoint({
          auditId: args.auditId, checkpoint, pageOrder: pageOrder.slice(0, checkpoint.pages.length),
        });
        await args.onExecutionCheckpoint(latestCheckpoint);
      },
    });
    const finalQueue = await readQueue(args.auditId, args.acceptedCount);
    const finalCorrelation = await readCorrelation(args);
    if (!finalQueue || finalQueue.nextIndex !== args.acceptedCount ||
      finalQueue.entries.some(entry => entry.status !== 'finished') || !finalCorrelation ||
      finalCorrelation.activePageId !== null || finalCorrelation.activeOwnershipId !== null || !latestCheckpoint) {
      throw new Error('BATCH_AUDIT_CLEANUP_UNCONFIRMED');
    }
    const checkpoint = validateExecutionCheckpoint({
      auditId: args.auditId, checkpoint: latestCheckpoint, pageOrder,
    });
    await dependencies.rawNavigationVault.clearAudit(args.auditId);
    if (await dependencies.rawNavigationVault.readQueue(args.auditId) !== null) {
      throw new Error('BATCH_AUDIT_CLEANUP_UNCONFIRMED');
    }
    return freeze({ model, checkpoint });
  }

  async function cleanup(raw) {
    const args = exact(raw, CLEANUP_KEYS);
    if (!args || !AUDIT_ID.test(args.auditId ?? '') || !CAPABILITY.test(args.capabilityId ?? '') ||
      !(args.sessionCapabilityId === null || CAPABILITY.test(args.sessionCapabilityId ?? '')) ||
      !Number.isSafeInteger(args.windowId) || args.windowId < 0) {
      throw new TypeError('BATCH_AUDIT_CLEANUP_DENIED');
    }
    if (args.sessionCapabilityId === null) {
      await dependencies.rawNavigationVault.clearAudit(args.auditId);
      if (await dependencies.rawNavigationVault.readQueue(args.auditId) !== null) {
        throw new Error('BATCH_AUDIT_CLEANUP_UNCONFIRMED');
      }
      return true;
    }
    let correlation = copyCleanupCorrelation(await dependencies.readBatchCorrelation({
      capabilityId: args.capabilityId,
      auditId: args.auditId,
    }), args);
    if (!correlation) throw new Error('BATCH_AUDIT_CLEANUP_DENIED');
    if (correlation.activePageId !== null) {
      const childAuditId = `${args.auditId}:${correlation.activePageId}`;
      const expectedOwner = {
        ownershipId: correlation.activeOwnershipId,
        auditId: childAuditId,
        windowId: args.windowId,
      };
      let owner = copyOwnerForCleanup(
        await dependencies.ownedTabRegistry.get(correlation.activeOwnershipId),
        expectedOwner,
      );
      if (owner === undefined) throw new Error('BATCH_AUDIT_CLEANUP_DENIED');
      if (owner === null) throw new Error('BATCH_AUDIT_CLEANUP_UNCONFIRMED');
      if (owner !== null && owner.state !== 'removed') {
        await dependencies.ownedTabRegistry.removeOwned({
          ownershipId: owner.ownershipId,
          auditId: owner.auditId,
          tabId: owner.tabId,
          fromState: owner.state,
        });
        owner = copyOwnerForCleanup(
          await dependencies.ownedTabRegistry.get(correlation.activeOwnershipId),
          expectedOwner,
        );
        if (!owner || owner.state !== 'removed') throw new Error('BATCH_AUDIT_CLEANUP_UNCONFIRMED');
      }
      const cleared = await dependencies.authority.transitionBatchAuditSession({
        sessionCapabilityId: args.sessionCapabilityId,
        auditId: args.auditId,
        fromPageId: correlation.activePageId,
        fromOwnershipId: correlation.activeOwnershipId,
        toPageId: null,
        toOwnershipId: null,
      });
      if (cleared?.ok !== true || cleared.activePageId !== null || cleared.activeOwnershipId !== null) {
        throw new Error('BATCH_AUDIT_CLEANUP_UNCONFIRMED');
      }
      correlation = copyCleanupCorrelation(await dependencies.readBatchCorrelation({
        capabilityId: args.capabilityId,
        auditId: args.auditId,
      }), args);
      if (!correlation || correlation.activePageId !== null || correlation.activeOwnershipId !== null) {
        throw new Error('BATCH_AUDIT_CLEANUP_UNCONFIRMED');
      }
    }
    await dependencies.rawNavigationVault.clearAudit(args.auditId);
    if (await dependencies.rawNavigationVault.readQueue(args.auditId) !== null) {
      throw new Error('BATCH_AUDIT_CLEANUP_UNCONFIRMED');
    }
    return true;
  }

  return Object.freeze({ run, cleanup });
}
