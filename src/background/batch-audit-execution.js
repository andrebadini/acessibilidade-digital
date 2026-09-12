import { isCapturePolicyV1 } from '../core/privacy/capture-policy.js';
import { isEvidenceUrlV1 } from '../core/privacy/evidence-url.js';
import { createInstalledCoreRuleInventory } from '../core/rules/core-rule-inventory.js';
import { createPageCheckpointRecorder, validateExecutionCheckpoint } from './execution-checkpoint.js';
import { canonicalTime } from './run-audit.js';
import { createBatchExecutionRunner } from './run-batch.js';

const FACTORY_KEYS = Object.freeze([
  'rawNavigationVault', 'authority', 'ownedTabRegistry', 'batchProgressStore', 'createOwnershipId',
  'runBatch', 'runUrlAuditExecution', 'readBatchCorrelation', 'emitProgress',
  'tryEnterFinalization',
]);
const PIXEL_FACTORY_KEYS = Object.freeze([...FACTORY_KEYS, 'createPixelPrivacyGate']);
const RUN_KEYS = Object.freeze([
  'auditId', 'capabilityId', 'sessionCapabilityId', 'windowId', 'acceptedCount',
  'capturePolicy', 'now', 'signal', 'reportOptions', 'onExecutionCheckpoint',
]);
const PIXEL_RUN_KEYS = Object.freeze([...RUN_KEYS, 'onPrivacyPaused', 'onPixelPageFinished']);
const RECOVERY_KEYS = Object.freeze([
  'auditId', 'capabilityId', 'sessionCapabilityId', 'windowId', 'capturePolicy', 'now', 'signal',
  'reportOptions', 'onExecutionCheckpoint', 'onPrivacyPaused', 'onPixelPageFinished',
  'consentId', 'resumeTarget', 'resumeCheckpoint',
]);
const RESUME_KEYS = Object.freeze(['auditId', 'pageId', 'ownershipId', 'consentId']);
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

function copyOwnerInState(value, expected, state) {
  const owner = exact(value, OWNER_KEYS);
  return owner?.version === 2 && owner.ownershipId === expected.ownershipId &&
    owner.auditId === expected.auditId && owner.purpose === 'audit' &&
    Number.isSafeInteger(owner.tabId) && owner.tabId >= 0 && owner.windowId === expected.windowId &&
    owner.cleanupMode === 'always' && owner.state === state
    ? freeze(owner)
    : null;
}

function copyPausedTarget(value, expected) {
  const target = exact(value, [
    'version', 'kind', 'ownershipId', 'tabId', 'windowId', 'documentId',
    'urlEvidence', 'urlSessionDigest', 'cleanupMode', 'pageId',
  ]);
  const evidence = target && copyEvidence(target.urlEvidence);
  return target?.version === 'ObservedTargetV1' && target.kind === 'owned-disposable' &&
    target.ownershipId === expected.ownershipId && Number.isSafeInteger(target.tabId) && target.tabId >= 0 &&
    target.windowId === expected.windowId && AUDIT_ID.test(target.documentId ?? '') && evidence &&
    DIGEST.test(target.urlSessionDigest ?? '') && target.cleanupMode === 'always' && target.pageId === 'page-1'
    ? freeze({ ...target, urlEvidence: evidence })
    : null;
}

function copyRecoveryTarget(value, expected) {
  const target = exact(value, [
    'version', 'kind', 'ownershipId', 'tabId', 'windowId', 'documentId',
    'urlEvidence', 'urlSessionDigest', 'cleanupMode', 'pageId',
  ]);
  const evidence = target && copyEvidence(target.urlEvidence);
  return target?.version === 'ObservedTargetV1' && target.kind === 'owned-disposable' &&
    target.ownershipId === expected.ownershipId && target.pageId === expected.pageId &&
    Number.isSafeInteger(target.tabId) && target.tabId >= 0 && target.windowId === expected.windowId &&
    AUDIT_ID.test(target.documentId ?? '') && evidence && DIGEST.test(target.urlSessionDigest ?? '') &&
    target.cleanupMode === 'always'
    ? freeze({ ...target, urlEvidence: evidence })
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
  const dependencies = exact(rawDependencies, PIXEL_FACTORY_KEYS) ?? exact(rawDependencies, FACTORY_KEYS);
  if (!dependencies ||
    typeof dependencies.rawNavigationVault?.readQueue !== 'function' ||
    typeof dependencies.rawNavigationVault.replaceQueue !== 'function' ||
    typeof dependencies.rawNavigationVault.take !== 'function' ||
    typeof dependencies.rawNavigationVault.clearAudit !== 'function' ||
    typeof dependencies.authority?.transitionBatchAuditSession !== 'function' ||
    typeof dependencies.ownedTabRegistry?.get !== 'function' ||
    typeof dependencies.ownedTabRegistry.removeOwned !== 'function' ||
    typeof dependencies.batchProgressStore?.writeDraft !== 'function' ||
    typeof dependencies.batchProgressStore.markCompleted !== 'function' ||
    typeof dependencies.batchProgressStore.readCompleted !== 'function' ||
    typeof dependencies.batchProgressStore.clearAudit !== 'function' ||
    typeof dependencies.batchProgressStore.discardAudit !== 'function' ||
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

  const pendingResumes = new Map();

  async function waitForResume(metadata, onPrivacyPaused, signal) {
    if (pendingResumes.has(metadata.auditId)) throw new Error('BATCH_PIXEL_RESUME_DENIED');
    let resolveResume;
    let rejectResume;
    let abortListener = null;
    const resumed = new Promise((resolve, reject) => {
      resolveResume = resolve;
      rejectResume = reject;
    });
    const pending = freeze({
      ...metadata,
      resolve: value => resolveResume(value),
      reject: error => rejectResume(error),
    });
    pendingResumes.set(metadata.auditId, pending);
    if (signal?.aborted) {
      pendingResumes.delete(metadata.auditId);
      throw signal.reason ?? new DOMException('Operação cancelada.', 'AbortError');
    }
    if (typeof signal?.addEventListener === 'function') {
      abortListener = () => {
        if (pendingResumes.get(metadata.auditId) !== pending) return;
        pendingResumes.delete(metadata.auditId);
        rejectResume(signal.reason ?? new DOMException('Operação cancelada.', 'AbortError'));
      };
      signal.addEventListener('abort', abortListener, { once: true });
    }
    try {
      await onPrivacyPaused(freeze({
        auditId: metadata.auditId,
        childAuditId: metadata.childAuditId,
        pageId: metadata.pageId,
        ownershipId: metadata.ownershipId,
      }));
      return await resumed;
    } finally {
      if (pendingResumes.get(metadata.auditId) === pending) pendingResumes.delete(metadata.auditId);
      signal?.removeEventListener?.('abort', abortListener);
    }
  }

  async function execute(raw, recoveryMode) {
    let args = recoveryMode ? exact(raw, RECOVERY_KEYS) : exact(raw, PIXEL_RUN_KEYS) ?? exact(raw, RUN_KEYS);
    const policy = args && exact(args.capturePolicy, [
      'version', 'mode', 'includeQuery', 'captureFullPage', 'captureElements', 'composeAnnouncementMap',
    ]);
    if (!args || !AUDIT_ID.test(args.auditId ?? '') || !CAPABILITY.test(args.capabilityId ?? '') ||
      !CAPABILITY.test(args.sessionCapabilityId ?? '') || !Number.isSafeInteger(args.windowId) || args.windowId < 0 ||
      (!recoveryMode && (!Number.isSafeInteger(args.acceptedCount) || args.acceptedCount < 2 || args.acceptedCount > 20)) ||
      !policy || !isCapturePolicyV1(policy) || policy.includeQuery !== false ||
      (policy.mode !== 'no-pixels' && (typeof dependencies.createPixelPrivacyGate !== 'function' ||
        typeof args.onPrivacyPaused !== 'function' ||
        typeof args.onPixelPageFinished !== 'function')) ||
      (recoveryMode && (policy.mode === 'no-pixels' ||
        !/^[A-Za-z0-9_-]{21}[AQgw]$/u.test(args.consentId ?? '') ||
        typeof args.onPixelPageFinished !== 'function')) ||
      typeof args.now !== 'function' || !args.signal || typeof args.signal !== 'object' ||
      typeof args.onExecutionCheckpoint !== 'function') throw new TypeError('BATCH_AUDIT_EXECUTION_DENIED');
    let initialQueue;
    if (recoveryMode) {
      const rawQueue = await dependencies.rawNavigationVault.readQueue(args.auditId);
      const queue = exact(rawQueue, QUEUE_KEYS);
      const values = queue && dense(queue.entries);
      if (!values || values.length < 2 || values.length > 20) throw new Error('BATCH_AUDIT_EXECUTION_DENIED');
      initialQueue = copyQueue(rawQueue, args.auditId, values.length);
      // AbortSignal is a live browser service, not immutable request data.
      const { signal, ...recoveredArgs } = args;
      args = Object.freeze({ ...freeze(recoveredArgs), signal, acceptedCount: values.length });
    } else {
      initialQueue = await readQueue(args.auditId, args.acceptedCount);
    }
    const initialCorrelation = await readCorrelation(args);
    const recoveryPageId = recoveryMode && initialQueue ? `page-${initialQueue.nextIndex + 1}` : null;
    const recoveryTarget = recoveryMode && initialCorrelation ? copyRecoveryTarget(args.resumeTarget, {
      ownershipId: initialCorrelation.activeOwnershipId,
      pageId: recoveryPageId,
      windowId: args.windowId,
    }) : null;
    const completed = recoveryMode ? await dependencies.batchProgressStore.readCompleted({ auditId: args.auditId }) : null;
    const completedPages = recoveryMode && completed !== null ? dense(completed?.pages) : [];
    const completedSeeds = recoveryMode && completedPages
      ? completedPages.map(page => freeze({
          pageId: page.pageId,
          model: page.model,
          failure: page.failure ?? null,
          checkpoint: page.checkpoint,
        }))
      : [];
    const pageOrderForRecovery = initialQueue
      ? initialQueue.entries.map((_entry, index) => `page-${index + 1}`)
      : [];
    let recoveryCheckpoint = null;
    if (recoveryMode && initialQueue && recoveryPageId) {
      try {
        recoveryCheckpoint = validateExecutionCheckpoint({
          auditId: args.auditId,
          checkpoint: args.resumeCheckpoint,
          pageOrder: pageOrderForRecovery.slice(0, initialQueue.nextIndex + 1),
        });
      } catch { recoveryCheckpoint = null; }
    }
    if (!initialCorrelation || !initialQueue ||
      (!recoveryMode && (initialCorrelation.activePageId !== null || initialCorrelation.activeOwnershipId !== null ||
        initialQueue.nextIndex !== 0 || initialQueue.entries[0].status !== 'pending')) ||
      (recoveryMode && (!recoveryTarget || initialQueue.nextIndex >= args.acceptedCount ||
        initialQueue.entries[initialQueue.nextIndex]?.status !== 'running' ||
        initialCorrelation.activePageId !== recoveryPageId ||
        initialCorrelation.activeOwnershipId !== recoveryTarget.ownershipId || !recoveryCheckpoint ||
        (initialQueue.nextIndex === 0
          ? completed !== null
          : !completed || completed.auditId !== args.auditId || completedPages === null ||
            completedPages.length !== initialQueue.nextIndex)))) {
      throw new Error('BATCH_AUDIT_EXECUTION_DENIED');
    }
    const recoveryOwner = recoveryMode ? copyOwnerInState(
      await dependencies.ownedTabRegistry.get(recoveryTarget.ownershipId),
      { ownershipId: recoveryTarget.ownershipId, auditId: `${args.auditId}:${recoveryPageId}`, windowId: args.windowId },
      'retained-for-consent',
    ) : null;
    if (recoveryMode && (!recoveryOwner || recoveryOwner.tabId !== recoveryTarget.tabId ||
      recoveryTarget.urlEvidence.href !== initialQueue.entries[initialQueue.nextIndex].evidenceUrl.href ||
      recoveryTarget.urlSessionDigest !== initialQueue.entries[initialQueue.nextIndex].sessionDigest)) {
      throw new Error('BATCH_AUDIT_EXECUTION_DENIED');
    }
    const inventory = await createInstalledCoreRuleInventory();
    const entries = initialQueue.entries.map(entry => freeze({
      line: entry.line,
      navigationUrl: entry.evidenceUrl.href,
      evidenceUrl: { ...entry.evidenceUrl },
    }));
    const pageOrder = entries.map((_entry, index) => `page-${index + 1}`);
    let latestCheckpoint = recoveryMode ? recoveryCheckpoint : null;
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
      const recoveringPage = recoveryMode && pageIndex === initialQueue.nextIndex;
      const expectedStatus = recoveringPage ? 'running' : 'pending';
      if (!pendingQueue || pendingQueue.nextIndex !== pageIndex || entry?.status !== expectedStatus ||
        options.url !== entry.evidenceUrl.href) throw new Error('BATCH_PAGE_EXECUTION_DENIED');
      const ownershipId = recoveringPage ? recoveryTarget.ownershipId : dependencies.createOwnershipId();
      if (!OWNER_ID.test(ownershipId ?? '')) throw new Error('BATCH_PAGE_EXECUTION_DENIED');
      if (!recoveringPage) {
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
      }
      const correlated = await readCorrelation(args);
      if (!correlated || correlated.activePageId !== options.pageId || correlated.activeOwnershipId !== ownershipId) {
        throw new Error('BATCH_PAGE_EXECUTION_DENIED');
      }
      let tokenConsumed = recoveringPage;
      let pageCheckpoint = recoveringPage ? freeze({
        version: 1,
        auditId: args.auditId,
        pages: freeze([{ ...recoveryCheckpoint.pages.at(-1) }]),
      }) : null;
      let childCheckpoint = recoveringPage ? validateExecutionCheckpoint({
        auditId: childAuditId,
        checkpoint: {
          version: 1,
          auditId: childAuditId,
          pages: [{ ...recoveryCheckpoint.pages.at(-1), pageId: 'page-1' }],
        },
        pageOrder: ['page-1'],
      }) : null;
      let pageConsentId = recoveringPage ? args.consentId : null;
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
      const createGate = consentId => policy.mode === 'no-pixels' ? null : dependencies.createPixelPrivacyGate(freeze({
        batchAuditId: args.auditId,
        childAuditId,
        pageId: options.pageId,
        ownershipId,
        consentId,
        authorityExpiresAt: correlated.expiresAt,
        capturePolicy: freeze({ ...policy }),
      }));
      const checkpointPage = async checkpoint => {
        childCheckpoint = validateExecutionCheckpoint({
          auditId: childAuditId, checkpoint, pageOrder: ['page-1'],
        });
        pageCheckpoint = projectCheckpoint(checkpoint, childAuditId, args.auditId, options.pageId);
        await options.onCheckpoint(pageCheckpoint);
      };
      const initialGate = createGate(recoveringPage ? args.consentId : null);
      let observed = recoveringPage
        ? await dependencies.runUrlAuditExecution({
            auditId: childAuditId,
            requestedUrlEvidence: entry.evidenceUrl,
            resumeTarget: freeze({
              kind: 'owned-disposable-resume',
              ownershipId,
              tabId: recoveryTarget.tabId,
              windowId: recoveryTarget.windowId,
              documentId: recoveryTarget.documentId,
              initialUrlEvidence: recoveryTarget.urlEvidence,
              initialUrlSessionDigest: recoveryTarget.urlSessionDigest,
              navigationPurpose: 'batch-page',
              cleanupMode: 'always',
              pageId: 'page-1',
            }),
            resumeCheckpoint: childCheckpoint,
            capturePolicy: freeze({ ...policy }),
            privacyGate: initialGate,
            modelNow: args.now,
            signal: options.signal,
            onProgress: event => options.chromeAdapter.emitProgress(event),
            onCheckpoint: checkpointPage,
            async persistAuditModel() {},
          })
        : await dependencies.runUrlAuditExecution({
            auditId: childAuditId,
            ownershipId,
            windowId: args.windowId,
            navigationToken: entry.navigationToken,
            navigationPurpose: 'batch-page',
            evidenceUrl: entry.evidenceUrl,
            sessionDigest: entry.sessionDigest,
            rawNavigationVault: navigationVault,
            capturePolicy: freeze({ ...policy }),
            ...(initialGate ? { privacyGate: initialGate } : {}),
            modelNow: args.now,
            signal: options.signal,
            onProgress: event => options.chromeAdapter.emitProgress(event),
            onCheckpoint: checkpointPage,
            async persistAuditModel() {},
          });
      let result = exact(observed, [
        'status', 'model', 'observedTarget', 'observationState', 'ownershipState',
      ]) ?? exact(observed, [
        'status', 'model', 'observedTarget', 'observationState', 'ownershipState', 'signals',
      ]);
      if (recoveringPage && result?.status === 'privacy-paused') {
        throw new Error('BATCH_PAGE_EXECUTION_DENIED');
      }
      if (result?.status === 'privacy-paused') {
        const pausedTarget = copyPausedTarget(result.observedTarget, {
          ownershipId, windowId: args.windowId,
        });
        const retainedOwner = copyOwnerInState(await dependencies.ownedTabRegistry.get(ownershipId), {
          ownershipId, auditId: childAuditId, windowId: args.windowId,
        }, 'retained-for-consent');
        if (result.model !== null || result.observationState !== 'observed' ||
          result.ownershipState !== 'retained-for-consent' || !pausedTarget || !retainedOwner ||
          !pageCheckpoint || !childCheckpoint || !tokenConsumed) {
          throw new Error('BATCH_PAGE_EXECUTION_DENIED');
        }
        const pausedPages = [
          ...(latestCheckpoint?.pages ?? []),
          pageCheckpoint.pages[0],
        ];
        latestCheckpoint = validateExecutionCheckpoint({
          auditId: args.auditId,
          checkpoint: { version: 1, auditId: args.auditId, pages: pausedPages },
          pageOrder: pageOrder.slice(0, pausedPages.length),
        });
        await args.onExecutionCheckpoint(latestCheckpoint);
        const resumedPage = await waitForResume({
          auditId: args.auditId, childAuditId, pageId: options.pageId, ownershipId,
          authorityExpiresAt: correlated.expiresAt, capturePolicy: policy,
        }, args.onPrivacyPaused, options.signal);
        const resumeGate = resumedPage.gate;
        pageConsentId = resumedPage.consentId;
        observed = await dependencies.runUrlAuditExecution({
          auditId: childAuditId,
          requestedUrlEvidence: entry.evidenceUrl,
          resumeTarget: freeze({
            kind: 'owned-disposable-resume', ownershipId,
            tabId: pausedTarget.tabId, windowId: pausedTarget.windowId,
            documentId: pausedTarget.documentId,
            initialUrlEvidence: pausedTarget.urlEvidence,
            initialUrlSessionDigest: pausedTarget.urlSessionDigest,
            navigationPurpose: 'batch-page', cleanupMode: 'always', pageId: 'page-1',
          }),
          resumeCheckpoint: childCheckpoint,
          capturePolicy: freeze({ ...policy }),
          privacyGate: resumeGate,
          modelNow: args.now,
          signal: options.signal,
          onProgress: event => options.chromeAdapter.emitProgress(event),
          onCheckpoint: async checkpoint => {
            childCheckpoint = validateExecutionCheckpoint({
              auditId: childAuditId, checkpoint, pageOrder: ['page-1'],
            });
            pageCheckpoint = projectCheckpoint(checkpoint, childAuditId, args.auditId, options.pageId);
            await options.onCheckpoint(pageCheckpoint);
          },
          async persistAuditModel() {},
        });
        result = exact(observed, [
          'status', 'model', 'observedTarget', 'observationState', 'ownershipState',
        ]) ?? exact(observed, [
          'status', 'model', 'observedTarget', 'observationState', 'ownershipState', 'signals',
        ]);
      }
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
            childCheckpoint = validateExecutionCheckpoint({
              auditId: childAuditId, checkpoint, pageOrder: ['page-1'],
            });
            pageCheckpoint = projectCheckpoint(checkpoint, childAuditId, args.auditId, options.pageId);
            await options.onCheckpoint(pageCheckpoint);
          },
        });
        await recorder.started();
      }
      const cleanupConfirmed = Boolean(owner) || factualPreObservationFailure && rawOwner === null;
      if (!result || !pageCheckpoint || result.ownershipState !== 'removed' || !cleanupConfirmed ||
        !childCheckpoint || !tokenConsumed && !factualPreObservationFailure) {
        throw new Error('BATCH_PAGE_CLEANUP_UNCONFIRMED');
      }
      const failure = factualPreObservationFailure ? freeze({
        version: 1,
        kind: 'pre-observation-failure',
        attempted: true,
        startedAt: childCheckpoint.pages[0].startedAt,
        endedAt: canonicalTime(args.now()),
        urlEvidence: entry.evidenceUrl,
      }) : null;
      const draft = exact(await dependencies.batchProgressStore.writeDraft({
        auditId: args.auditId,
        pageId: options.pageId,
        childAuditId,
        model: result.model,
        failure,
        checkpoint: childCheckpoint,
        expectedCompletedCount: pageIndex,
      }), ['version', 'auditId', 'revision', 'page']);
      if (!draft || draft.version !== 1 || draft.auditId !== args.auditId ||
        draft.revision !== pageIndex * 2 + 1 || draft.page?.pageId !== options.pageId ||
        draft.page?.childAuditId !== childAuditId || draft.page?.state !== 'draft') {
        throw new Error('BATCH_PROGRESS_WRITE_DENIED');
      }
      const completed = exact(await dependencies.batchProgressStore.markCompleted({
        auditId: args.auditId,
        pageId: options.pageId,
        expectedRevision: draft.revision,
      }), ['version', 'auditId', 'revision', 'page']);
      if (!completed || completed.version !== 1 || completed.auditId !== args.auditId ||
        completed.revision !== pageIndex * 2 + 2 || completed.page?.pageId !== options.pageId ||
        completed.page?.childAuditId !== childAuditId || completed.page?.state !== 'completed') {
        throw new Error('BATCH_PROGRESS_COMPLETE_DENIED');
      }
      if (pageConsentId !== null) {
        await args.onPixelPageFinished(freeze({
          auditId: args.auditId,
          childAuditId,
          pageId: options.pageId,
          ownershipId,
          consentId: pageConsentId,
        }));
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
      return freeze({ model: result.model, failure, checkpoint: pageCheckpoint, ownershipState: 'removed' });
    });
    const model = await dependencies.runBatch({
      entries,
      batchAuditId: args.auditId,
      batchStartedAt: canonicalTime(initialQueue.issuedAt),
      chromeAdapter: Object.freeze({
        emitProgress: event => dependencies.emitProgress(event),
        tryEnterFinalization: () => dependencies.tryEnterFinalization(),
        async handoffReport() { return { reviewUrl: null, artifact: { status: 'pending', formats: [] } }; },
      }),
      runner,
      now: args.now,
      signal: args.signal,
      reportOptions: args.reportOptions,
      ...(recoveryMode ? { completedPages: completedSeeds } : {}),
      onExecutionCheckpoint: async checkpoint => {
        latestCheckpoint = validateExecutionCheckpoint({
          auditId: args.auditId, checkpoint, pageOrder: pageOrder.slice(0, checkpoint.pages.length),
        });
        await args.onExecutionCheckpoint(latestCheckpoint);
      },
      ...(policy.mode === 'no-pixels' ? {} : { pageTimeoutMs: 660_000 }),
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
    return recoveryMode
      ? freeze({ model, checkpoint, acceptedCount: args.acceptedCount })
      : freeze({ model, checkpoint });
  }

  const run = raw => execute(raw, false);
  const recover = raw => execute(raw, true);

  async function resume(raw) {
    const args = exact(raw, RESUME_KEYS);
    const pending = args && pendingResumes.get(args.auditId);
    if (!args || !AUDIT_ID.test(args.auditId ?? '') || !/^page-([1-9]|1[0-9]|20)$/u.test(args.pageId ?? '') ||
      !OWNER_ID.test(args.ownershipId ?? '') || !/^[A-Za-z0-9_-]{21}[AQgw]$/u.test(args.consentId ?? '') ||
      !pending || pending.pageId !== args.pageId || pending.ownershipId !== args.ownershipId) {
      throw new Error('BATCH_PIXEL_RESUME_DENIED');
    }
    pendingResumes.delete(args.auditId);
    try {
      const gate = dependencies.createPixelPrivacyGate(freeze({
        batchAuditId: pending.auditId,
        childAuditId: pending.childAuditId,
        pageId: pending.pageId,
        ownershipId: pending.ownershipId,
        consentId: args.consentId,
        authorityExpiresAt: pending.authorityExpiresAt,
        capturePolicy: freeze({ ...pending.capturePolicy }),
      }));
      pending.resolve(freeze({ gate, consentId: args.consentId }));
      return true;
    } catch (error) {
      pending.reject(error);
      throw new Error('BATCH_PIXEL_RESUME_DENIED');
    }
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

  async function clearProgress(raw) {
    const args = exact(raw, ['auditId']);
    if (!args || !AUDIT_ID.test(args.auditId ?? '')) throw new TypeError('BATCH_PROGRESS_CLEAR_DENIED');
    const cleared = exact(await dependencies.batchProgressStore.clearAudit(args), ['auditId', 'cleared']);
    if (!cleared || cleared.auditId !== args.auditId || cleared.cleared !== true ||
      await dependencies.batchProgressStore.readCompleted(args) !== null) {
      throw new Error('BATCH_PROGRESS_CLEAR_DENIED');
    }
    return true;
  }

  async function discardProgress(raw) {
    const args = exact(raw, ['auditId']);
    if (!args || !AUDIT_ID.test(args.auditId ?? '')) throw new TypeError('BATCH_PROGRESS_DISCARD_DENIED');
    const discarded = exact(await dependencies.batchProgressStore.discardAudit(args), ['auditId', 'discarded']);
    if (!discarded || discarded.auditId !== args.auditId || discarded.discarded !== true ||
      await dependencies.batchProgressStore.readCompleted(args) !== null) {
      throw new Error('BATCH_PROGRESS_DISCARD_DENIED');
    }
    return true;
  }

  return Object.freeze({ run, recover, resume, cleanup, clearProgress, discardProgress });
}
