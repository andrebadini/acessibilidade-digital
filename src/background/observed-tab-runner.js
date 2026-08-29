import { canonicalTime } from './run-audit.js';
import { isObservedTargetV1 } from './audit-pipeline.js';
import { isCapturePolicyV1 } from '../core/privacy/capture-policy.js';

const DIGEST = /^hmac-sha256:[A-Za-z0-9_-]{43}$/u;
const TARGET_KEYS = Object.freeze({
  attached: Object.freeze(['kind', 'tabId', 'windowId', 'documentId', 'initialUrlEvidence', 'initialUrlSessionDigest']),
  disposable: Object.freeze(['kind', 'ownerId', 'navigationToken', 'cleanupMode']),
});

function validId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,160}$/u.test(value);
}

function exactKeys(value, expected) {
  try {
    const keys = Reflect.ownKeys(value);
    return keys.length === expected.length && expected.every(key => keys.includes(key));
  } catch {
    return false;
  }
}

function validTarget(target) {
  if (!target || typeof target !== 'object' || Array.isArray(target)) return false;
  const keys = TARGET_KEYS[target.kind];
  if (!keys || !exactKeys(target, keys)) return false;
  if (target.kind === 'attached') {
    return Number.isSafeInteger(target.tabId) && target.tabId >= 0 &&
      Number.isSafeInteger(target.windowId) && target.windowId >= 0 && validId(target.documentId) &&
      typeof target.initialUrlEvidence === 'string' && DIGEST.test(target.initialUrlSessionDigest);
  }
  return validId(target.ownerId) && typeof target.navigationToken === 'string' &&
    /^[A-Za-z0-9_-]{22}$/u.test(target.navigationToken) &&
    ['always', 'retain-after-observation'].includes(target.cleanupMode);
}

function proofMatches(left, right) {
  return left && right && left.tabId === right.tabId && left.windowId === right.windowId &&
    left.documentId === right.documentId && left.urlSessionDigest === right.urlSessionDigest;
}

function validProof(proof, tabId, windowId) {
  return proof && proof.tabId === tabId && proof.windowId === windowId && validId(proof.documentId) && DIGEST.test(proof.urlSessionDigest);
}

function makeObserved(target, proof, urlEvidence) {
  const observed = target.kind === 'attached'
    ? { version: 1, kind: 'attached', tabId: proof.tabId, windowId: proof.windowId, documentId: proof.documentId, urlSessionDigest: proof.urlSessionDigest, urlEvidence }
    : { version: 1, kind: 'disposable', ownerId: target.ownerId, tabId: proof.tabId, windowId: proof.windowId, documentId: proof.documentId, urlSessionDigest: proof.urlSessionDigest, urlEvidence };
  return Object.freeze(observed);
}

function diagnosticStatus(signal) {
  return signal?.aborted ? 'cancelled' : 'failed';
}

function safeModel(factory, auditId, code, status) {
  if (typeof factory !== 'function') {
    return Object.freeze({
      schemaVersion: 2, auditId,
      session: Object.freeze({ status, diagnostics: Object.freeze([Object.freeze({ code })]) }),
    });
  }
  return factory({ auditId, code, status });
}

function sanitizeSignals(signals) {
  if (!Array.isArray(signals)) throw new TypeError('PRIVACY_PROBE_INVALID');
  return Object.freeze(signals.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !exactKeys(value, ['category', 'count']) ||
      !validId(value.category) || !Number.isSafeInteger(value.count) || value.count < 1) {
      throw new TypeError('PRIVACY_PROBE_INVALID');
    }
    return Object.freeze({ category: value.category, count: value.count });
  }));
}

export async function runObservedTabAudit({
  auditId,
  sessionCapabilityId,
  target,
  capturePolicy,
  privacyDecision,
  checkpointRecorder,
  signal,
  chromeAdapter,
  ownedTabs,
  rawNavigationVault,
  pipeline,
  privacyState,
  consentAuthority,
  failureModelFactory,
  resumePauseId,
  now = () => new Date().toISOString(),
}) {
  if (!validId(auditId) || !validId(sessionCapabilityId) || !validTarget(target) ||
    !isCapturePolicyV1(capturePolicy) || !privacyDecision || typeof privacyDecision !== 'object' ||
    !checkpointRecorder || typeof checkpointRecorder.snapshot !== 'function' ||
    !chromeAdapter || typeof chromeAdapter.probeDocumentIdentity !== 'function' || typeof pipeline !== 'function' ||
    (target.kind === 'disposable' && (!ownedTabs || !rawNavigationVault))) {
    throw new TypeError('OBSERVED_RUNNER_DENIED');
  }
  const startedAt = canonicalTime(now());
  let tabId = target.kind === 'attached' ? target.tabId : null;
  let windowId = target.kind === 'attached' ? target.windowId : null;
  let observedTarget = null;
  let observationState = 'not-started';
  let ownershipState = target.kind === 'attached' ? 'attached' : 'removed';
  let paused = false;
  let code = 'AUDIT_FAILED';

  const cleanupDisposable = async () => {
    if (target.kind !== 'disposable' || tabId === null || paused) return;
    const current = await ownedTabs.get(target.ownerId);
    if (current?.state === 'removed') {
      ownershipState = 'removed';
      return;
    }
    if (observationState === 'observed' && target.cleanupMode === 'retain-after-observation') {
      const retained = current?.state === 'observing'
        ? await ownedTabs.transition({ ownerId: target.ownerId, auditId, tabId, fromState: 'observing', toState: 'retained-for-review' })
        : current;
      ownershipState = retained?.state === 'retained-for-review' ? 'retained-for-review' : 'cleanup-pending';
      return;
    }
    const removed = await ownedTabs.removeOwned({ ownerId: target.ownerId, tabId });
    ownershipState = removed.state;
  };

  try {
    if (signal?.aborted) throw signal.reason ?? new DOMException('Operação cancelada.', 'AbortError');
    let urlEvidence = target.kind === 'attached' ? target.initialUrlEvidence : '';
    if (target.kind === 'disposable') {
      if (typeof chromeAdapter.createTab !== 'function' || typeof chromeAdapter.navigateTab !== 'function' ||
        typeof chromeAdapter.waitForStable !== 'function') throw new TypeError('OBSERVED_RUNNER_DENIED');
      const created = await chromeAdapter.createTab({ url: 'about:blank', active: true });
      if (!Number.isSafeInteger(created?.id) || created.id < 0 || !Number.isSafeInteger(created?.windowId) || created.windowId < 0) {
        throw new Error('TARGET_CREATION_FAILED');
      }
      tabId = created.id;
      windowId = created.windowId;
      await ownedTabs.registerCreated({
        ownerId: target.ownerId, auditId, sessionCapabilityId, tabId, windowId,
        cleanupMode: target.cleanupMode,
      });
      let navigationUrl = null;
      try {
        navigationUrl = await rawNavigationVault.takeInternal({ ownerId: target.ownerId, navigationToken: target.navigationToken });
        await chromeAdapter.navigateTab(tabId, navigationUrl, { signal });
      } finally {
        navigationUrl = null;
      }
      await chromeAdapter.waitForStable(tabId, { signal, timeoutMs: 30_000 });
      urlEvidence = typeof chromeAdapter.getEvidenceUrl === 'function'
        ? await chromeAdapter.getEvidenceUrl(tabId, capturePolicy.includeQuery)
        : '';
    }

    const firstProof = await chromeAdapter.probeDocumentIdentity(tabId);
    if (!validProof(firstProof, tabId, windowId)) {
      code = 'TARGET_CHANGED';
      throw new Error(code);
    }
    if (resumePauseId !== undefined) {
      const pause = typeof privacyState?.getPause === 'function' ? await privacyState.getPause(resumePauseId) : null;
      if (!pause || pause.auditId !== auditId || pause.pauseId !== resumePauseId ||
        !isObservedTargetV1(pause.observedTarget) || !proofMatches(pause.observedTarget, firstProof)) {
        code = 'PRIVACY_TARGET_CHANGED';
        throw new Error(code);
      }
    } else if (target.kind === 'attached' &&
      (target.documentId !== firstProof.documentId || target.initialUrlSessionDigest !== firstProof.urlSessionDigest)) {
      code = 'TARGET_CHANGED';
      throw new Error(code);
    }
    observedTarget = makeObserved(target, firstProof, urlEvidence);
    observationState = 'observed';
    if (target.kind === 'disposable') {
      await ownedTabs.transition({ ownerId: target.ownerId, auditId, tabId, fromState: 'created', toState: 'observing' });
    }

    if (privacyDecision.status === 'no-pixels') {
      if (capturePolicy.mode !== 'no-pixels' || privacyDecision.limitationCode !== 'PIXEL_CAPTURE_OMITTED' ||
        !exactKeys(privacyDecision, ['status', 'limitationCode'])) throw new TypeError('PRIVACY_DECISION_DENIED');
    } else if (privacyDecision.status === 'privacy-paused') {
      if (capturePolicy.mode === 'no-pixels' || !exactKeys(privacyDecision, ['status', 'pauseId']) ||
        !validId(privacyDecision.pauseId) || typeof chromeAdapter.probePrivacySignals !== 'function' ||
        typeof privacyState?.persistPause !== 'function') throw new TypeError('PRIVACY_DECISION_DENIED');
      const signals = sanitizeSignals(await chromeAdapter.probePrivacySignals(tabId));
      await privacyState.persistPause({
        version: 1, auditId, pauseId: privacyDecision.pauseId, observedTarget,
        capturePolicy, signals, checkpoint: checkpointRecorder.snapshot(), startedAt,
      });
      paused = true;
      return Object.freeze({
        status: 'paused', auditId, pauseId: privacyDecision.pauseId,
        checkpoint: checkpointRecorder.snapshot(), observedTarget,
      });
    } else if (privacyDecision.status === 'allowed') {
      if (capturePolicy.mode === 'no-pixels' || !exactKeys(privacyDecision, ['status', 'consentCapabilityId', 'documentId', 'urlSessionDigest']) ||
        !validId(privacyDecision.consentCapabilityId) || privacyDecision.documentId !== observedTarget.documentId ||
        privacyDecision.urlSessionDigest !== observedTarget.urlSessionDigest ||
        typeof chromeAdapter.probePrivacySignals !== 'function' || typeof consentAuthority?.consume !== 'function') {
        throw new TypeError('PRIVACY_DECISION_DENIED');
      }
      sanitizeSignals(await chromeAdapter.probePrivacySignals(tabId));
      const consumed = await consentAuthority.consume({
        consentCapabilityId: privacyDecision.consentCapabilityId, auditId,
        documentId: observedTarget.documentId, urlSessionDigest: observedTarget.urlSessionDigest,
      });
      if (consumed !== true) throw new TypeError('PRIVACY_DECISION_DENIED');
    } else if (privacyDecision.status === 'target-changed') {
      code = 'PRIVACY_TARGET_CHANGED';
      throw new Error(code);
    } else if (privacyDecision.status === 'aborted') {
      code = 'AUDIT_ABORTED';
      throw new DOMException('Operação cancelada.', 'AbortError');
    } else {
      throw new TypeError('PRIVACY_DECISION_DENIED');
    }

    const finalProof = await chromeAdapter.probeDocumentIdentity(tabId);
    if (!validProof(finalProof, tabId, windowId) || !proofMatches(observedTarget, finalProof)) {
      code = 'TARGET_CHANGED';
      throw new Error(code);
    }
    const piped = await pipeline({ auditId, observedTarget, capturePolicy, checkpointRecorder, signal });
    await cleanupDisposable();
    return Object.freeze({
      status: 'completed', model: piped.model, observedTarget,
      observationState: 'observed', ownershipState,
    });
  } catch (error) {
    if (error?.name === 'AbortError' || signal?.aborted) code = 'AUDIT_ABORTED';
    else if (!['TARGET_CHANGED', 'PRIVACY_TARGET_CHANGED'].includes(code)) code = 'AUDIT_FAILED';
    try { await cleanupDisposable(); } catch { ownershipState = 'cleanup-pending'; }
    return Object.freeze({
      status: 'failed',
      model: safeModel(failureModelFactory, auditId, code, diagnosticStatus(signal)),
      observedTarget,
      observationState: observedTarget ? observationState : (tabId === null ? 'not-started' : 'pre-observation-failure'),
      ownershipState,
    });
  }
}
