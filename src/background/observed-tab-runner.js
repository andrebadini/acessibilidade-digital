import { canonicalTime } from './run-audit.js';
import { isObservedTargetV1 } from './audit-pipeline.js';
import { isCapturePolicyV1 } from '../core/privacy/capture-policy.js';
import { canonicalStringify } from '../core/report/canonical-json.js';

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

function captureExact(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    const keys = Reflect.ownKeys(value);
    if (keys.length !== expected.length || expected.some(key => !keys.includes(key))) return null;
    const copy = {};
    for (const key of expected) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      copy[key] = descriptor.value;
    }
    return copy;
  } catch { return null; }
}

function captureTarget(target) {
  if (!target || typeof target !== 'object' || Array.isArray(target)) return false;
  const kind = Object.getOwnPropertyDescriptor(target, 'kind');
  if (!kind?.enumerable || !Object.hasOwn(kind, 'value')) return null;
  const copy = captureExact(target, TARGET_KEYS[kind.value] ?? []);
  if (!copy) return null;
  if (copy.kind === 'attached') {
    return Number.isSafeInteger(copy.tabId) && copy.tabId >= 0 &&
      Number.isSafeInteger(copy.windowId) && copy.windowId >= 0 && validId(copy.documentId) &&
      typeof copy.initialUrlEvidence === 'string' && DIGEST.test(copy.initialUrlSessionDigest) ? Object.freeze(copy) : null;
  }
  return validId(copy.ownerId) && typeof copy.navigationToken === 'string' &&
    /^[A-Za-z0-9_-]{22}$/u.test(copy.navigationToken) &&
    ['always', 'retain-after-observation'].includes(copy.cleanupMode) ? Object.freeze(copy) : null;
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

function diagnosticStatus(signal, code) {
  return signal?.aborted || code === 'AUDIT_ABORTED' ? 'cancelled' : 'failed';
}

async function safeModel(factory, auditId, code, status) {
  if (typeof factory !== 'function') {
    return Object.freeze({
      schemaVersion: 2, auditId,
      session: Object.freeze({ status, diagnostics: Object.freeze([Object.freeze({ code })]) }),
    });
  }
  return factory({ auditId, code, status });
}

function captureDecision(value) {
  const statusDescriptor = value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, 'status') : null;
  if (!statusDescriptor?.enumerable || !Object.hasOwn(statusDescriptor, 'value')) return null;
  const keys = {
    'no-pixels': ['status', 'limitationCode'],
    'privacy-paused': ['status', 'pauseId'],
    allowed: ['status', 'consentCapabilityId', 'documentId', 'urlSessionDigest'],
    'target-changed': ['status'], aborted: ['status'],
  }[statusDescriptor.value];
  return keys ? captureExact(value, keys) : null;
}

function capturePause(value, disposable) {
  const keys = ['version', 'auditId', 'pauseId', 'sessionCapabilityId', 'observedTarget', 'capturePolicy', 'signals', 'checkpoint', 'startedAt'];
  if (disposable) keys.splice(4, 0, 'ownerId');
  const copy = captureExact(value, keys);
  if (!copy) return null;
  try {
    copy.signals = sanitizeSignals(copy.signals);
    copy.checkpoint = safePlainData(copy.checkpoint);
  } catch { return null; }
  return copy;
}

function safePlainData(value, seen = new WeakSet()) {
  if (value === null || ['string', 'boolean'].includes(typeof value)) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (!value || typeof value !== 'object' || seen.has(value)) throw new TypeError('OBSERVED_RUNNER_DENIED');
  seen.add(value);
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string')) throw new TypeError('OBSERVED_RUNNER_DENIED');
  if (Array.isArray(value)) {
    const expected = ['length', ...Array.from({ length: value.length }, (_v, index) => String(index))];
    if (keys.length !== expected.length || expected.some(key => !keys.includes(key))) throw new TypeError('OBSERVED_RUNNER_DENIED');
    return Array.from({ length: value.length }, (_v, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new TypeError('OBSERVED_RUNNER_DENIED');
      return safePlainData(descriptor.value, seen);
    });
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new TypeError('OBSERVED_RUNNER_DENIED');
  const copy = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new TypeError('OBSERVED_RUNNER_DENIED');
    copy[key] = safePlainData(descriptor.value, seen);
  }
  return copy;
}

function sanitizeSignals(signals) {
  if (!Array.isArray(signals) || Object.getPrototypeOf(signals) !== Array.prototype) throw new TypeError('PRIVACY_PROBE_INVALID');
  let keys;
  try { keys = Reflect.ownKeys(signals); } catch { throw new TypeError('PRIVACY_PROBE_INVALID'); }
  const expected = ['length', ...Array.from({ length: signals.length }, (_v, index) => String(index))];
  if (keys.length !== expected.length || expected.some(key => !keys.includes(key))) throw new TypeError('PRIVACY_PROBE_INVALID');
  return Object.freeze(Array.from({ length: signals.length }, (_v, index) => {
    const row = Object.getOwnPropertyDescriptor(signals, String(index));
    const value = row?.enumerable && Object.hasOwn(row, 'value') ? captureExact(row.value, ['category', 'count']) : null;
    if (!value || !validId(value.category) || !Number.isSafeInteger(value.count) || value.count < 1) {
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
  const safeTarget = captureTarget(target);
  const safeDecision = captureDecision(privacyDecision);
  if (!validId(auditId) || !validId(sessionCapabilityId) || !safeTarget ||
    !isCapturePolicyV1(capturePolicy) || !safeDecision ||
    !checkpointRecorder || typeof checkpointRecorder.snapshot !== 'function' ||
    !chromeAdapter || typeof chromeAdapter.probeDocumentIdentity !== 'function' || typeof pipeline !== 'function' ||
    (target.kind === 'disposable' && (!ownedTabs || !rawNavigationVault))) {
    throw new TypeError('OBSERVED_RUNNER_DENIED');
  }
  target = safeTarget;
  privacyDecision = safeDecision;
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
    const removed = await ownedTabs.removeOwned({ ownerId: target.ownerId, auditId, tabId, fromState: current?.state });
    ownershipState = removed.state;
  };

  try {
    if (signal?.aborted) throw signal.reason ?? new DOMException('Operação cancelada.', 'AbortError');
    let resumePause = null;
    let urlEvidence = target.kind === 'attached' ? target.initialUrlEvidence : '';
    if (resumePauseId !== undefined) {
      const rawPause = typeof privacyState?.getPause === 'function' ? await privacyState.getPause(resumePauseId) : null;
      resumePause = capturePause(rawPause, target.kind === 'disposable');
      if (!resumePause || resumePause.version !== 1 || resumePause.auditId !== auditId ||
        resumePause.pauseId !== resumePauseId || resumePause.sessionCapabilityId !== sessionCapabilityId ||
        (target.kind === 'disposable' && resumePause.ownerId !== target.ownerId) ||
        !isObservedTargetV1(resumePause.observedTarget) || !isCapturePolicyV1(resumePause.capturePolicy) ||
        canonicalStringify(resumePause.capturePolicy) !== canonicalStringify(capturePolicy) ||
        canonicalStringify(resumePause.checkpoint) !== canonicalStringify(checkpointRecorder.snapshot())) {
        code = 'PRIVACY_TARGET_CHANGED';
        throw new Error(code);
      }
      tabId = resumePause.observedTarget.tabId;
      windowId = resumePause.observedTarget.windowId;
      urlEvidence = resumePause.observedTarget.urlEvidence;
      if (target.kind === 'disposable') {
        const owned = await ownedTabs.get(target.ownerId);
        if (!owned || owned.auditId !== auditId || owned.tabId !== tabId || owned.state !== 'observing') {
          code = 'PRIVACY_TARGET_CHANGED'; throw new Error(code);
        }
      }
    } else if (target.kind === 'disposable') {
      if (typeof chromeAdapter.createTab !== 'function' || typeof chromeAdapter.navigateTab !== 'function' ||
        typeof chromeAdapter.waitForStable !== 'function') throw new TypeError('OBSERVED_RUNNER_DENIED');
      const created = await chromeAdapter.createTab({ url: 'about:blank', active: true });
      if (!Number.isSafeInteger(created?.id) || created.id < 0 || !Number.isSafeInteger(created?.windowId) || created.windowId < 0) {
        throw new Error('TARGET_CREATION_FAILED');
      }
      tabId = created.id;
      windowId = created.windowId;
      let registered;
      try {
        registered = await ownedTabs.registerCreated({
          ownerId: target.ownerId, auditId, sessionCapabilityId, tabId, windowId,
          cleanupMode: target.cleanupMode,
        });
      } catch {
        try { await chromeAdapter.removeTab(tabId); ownershipState = 'removed'; }
        catch { ownershipState = 'cleanup-pending'; }
        throw new Error('OWNERSHIP_REGISTRATION_FAILED');
      }
      if (registered.state !== 'created') {
        ownershipState = 'cleanup-pending';
        throw new Error('OWNERSHIP_REGISTRATION_FAILED');
      }
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
      if (!proofMatches(resumePause.observedTarget, firstProof)) {
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
    if (target.kind === 'disposable' && resumePauseId === undefined) {
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
        version: 1, auditId, pauseId: privacyDecision.pauseId, sessionCapabilityId,
        ...(target.kind === 'disposable' ? { ownerId: target.ownerId } : {}), observedTarget,
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
      checkpoint: piped.checkpoint, observationState: 'observed', ownershipState,
    });
  } catch (error) {
    if (error?.name === 'AbortError' || signal?.aborted) code = 'AUDIT_ABORTED';
    else if (!['TARGET_CHANGED', 'PRIVACY_TARGET_CHANGED'].includes(code)) code = 'AUDIT_FAILED';
    try { await cleanupDisposable(); } catch { ownershipState = 'cleanup-pending'; }
    return Object.freeze({
      status: 'failed',
      model: await safeModel(failureModelFactory, auditId, code, diagnosticStatus(signal, code)),
      checkpoint: checkpointRecorder.snapshot(),
      observedTarget,
      observationState: observedTarget ? observationState : (tabId === null ? 'not-started' : 'pre-observation-failure'),
      ownershipState,
    });
  }
}
