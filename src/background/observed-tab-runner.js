import { isEvidenceUrlV1, sanitizeEvidenceUrlV1 } from '../core/privacy/evidence-url.js';
import { createAuditModel } from '../core/report/audit-model.js';
import { validateExecutionCheckpoint } from './execution-checkpoint.js';
import { isObservedPipelineRunner } from './audit-pipeline.js';

const DIGEST = /^hmac-sha256:[A-Za-z0-9_-]{43}$/u;
const ID = /^[A-Za-z0-9._:-]{1,160}$/u;
const TOKEN = /^[A-Za-z0-9_-]{22}$/u;
const R18_STATUS = new Set(['complete', 'partial', 'cancelled', 'failed']);
const OWNED_RECORD_KEYS = Object.freeze(['version', 'ownershipId', 'auditId', 'purpose', 'tabId', 'windowId', 'cleanupMode', 'state', 'createdAt', 'updatedAt']);
const RESULT_KEYS = Object.freeze(['model', 'status', 'checkpoint', 'observationState']);
const RUNNER_KEYS = Object.freeze([
  'auditId', 'target', 'chromeAdapter', 'capturePolicy', 'privacyGate',
  'onCheckpoint', 'now', 'signal', 'expectedExtensionId',
]);

function denied() { return new TypeError('OBSERVED_RUNNER_DENIED'); }
function validId(value) { return typeof value === 'string' && ID.test(value); }
function validChromeId(value) { return Number.isSafeInteger(value) && value >= 0; }
function validTime(value) {
  try { return typeof value === 'string' && new Date(value).toISOString() === value; } catch { return false; }
}

function captureCallable(value, key) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function') return null;
    return descriptor.value.bind(value);
  } catch { return null; }
}

function copyPolicy(value) {
  const copy = captureExact(value, ['version', 'mode', 'includeQuery', 'captureFullPage', 'captureElements', 'composeAnnouncementMap']);
  const expected = {
    'full-evidence': [true, true, true], 'element-only': [false, true, false], 'no-pixels': [false, false, false],
  }[copy?.mode];
  if (!copy || copy.version !== 'CapturePolicyV1' || !expected || typeof copy.includeQuery !== 'boolean' ||
    copy.captureFullPage !== expected[0] || copy.captureElements !== expected[1] || copy.composeAnnouncementMap !== expected[2]) return null;
  return Object.freeze(copy);
}

function copyOwnedRecord(value, expected = {}) {
  const copy = captureExact(value, OWNED_RECORD_KEYS);
  if (!copy || copy.version !== 2 || !validId(copy.ownershipId) || !validId(copy.auditId) ||
    copy.purpose !== 'audit' || !validChromeId(copy.tabId) || !validChromeId(copy.windowId) ||
    !['always', 'pre-observation-failure'].includes(copy.cleanupMode) ||
    !['created', 'observing', 'retained-for-review', 'retained-for-consent', 'cleanup-pending', 'removed'].includes(copy.state) ||
    !validTime(copy.createdAt) || !validTime(copy.updatedAt) ||
    Object.entries(expected).some(([key, value]) => copy[key] !== value)) return null;
  return Object.freeze(copy);
}

function copyPlain(value, seen = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (!value || typeof value !== 'object' || seen.has(value)) return null;
  seen.add(value);
  let keys;
  try { keys = Reflect.ownKeys(value); } catch { return null; }
  if (keys.some(key => typeof key !== 'string' || ['rawUrl', 'navigationToken', 'navigationUrl', 'sessionCapabilityId'].includes(key))) return null;
  let isArray;
  try { isArray = Array.isArray(value); } catch { return null; }
  if (isArray) {
    let lengthDescriptor;
    try { lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length'); } catch { return null; }
    const length = lengthDescriptor?.value;
    if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, 'value') || !Number.isSafeInteger(length) || length < 0) return null;
    const expected = ['length', ...Array.from({ length }, (_v, index) => String(index))];
    if (keys.length !== expected.length || expected.some(key => !keys.includes(key))) return null;
    const copy = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      const child = copyPlain(descriptor.value, seen);
      if (child === null && descriptor.value !== null) return null;
      copy.push(child);
    }
    return Object.freeze(copy);
  }
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const copy = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      const child = copyPlain(descriptor.value, seen);
      if (child === null && descriptor.value !== null) return null;
      copy[key] = child;
    }
    return Object.freeze(copy);
  } catch { return null; }
}

function snapshotModel(value, seen = new WeakMap()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (!value || typeof value !== 'object') return null;
  if (seen.has(value)) return seen.get(value);
  let keys;
  try { keys = Reflect.ownKeys(value); } catch { return null; }
  if (keys.some(key => typeof key !== 'string' || ['rawUrl', 'navigationToken', 'navigationUrl', 'sessionCapabilityId'].includes(key))) return null;
  let isArray;
  try { isArray = Array.isArray(value); } catch { return null; }
  if (isArray) {
    let lengthDescriptor;
    try { lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length'); } catch { return null; }
    const length = lengthDescriptor?.value;
    if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, 'value') || !Number.isSafeInteger(length) || length < 0) return null;
    const expected = ['length', ...Array.from({ length }, (_v, index) => String(index))];
    if (keys.length !== expected.length || expected.some(key => !keys.includes(key))) return null;
    const copy = [];
    seen.set(value, copy);
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      const child = snapshotModel(descriptor.value, seen);
      if (child === null && descriptor.value !== null) return null;
      copy.push(child);
    }
    return copy;
  }
  let prototype;
  try { prototype = Object.getPrototypeOf(value); } catch { return null; }
  if (prototype !== Object.prototype && prototype !== null) return null;
  const copy = {};
  seen.set(value, copy);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
    const child = snapshotModel(descriptor.value, seen);
    if (child === null && descriptor.value !== null) return null;
    copy[key] = child;
  }
  return copy;
}

function resultEnvelope(value, expectedAuditId, expectedTarget) {
  const copy = captureExact(value, RESULT_KEYS);
  if (!copy || copy.observationState !== 'observed' || !R18_STATUS.has(copy.status)) return null;
  const snapshot = snapshotModel(copy.model);
  if (!snapshot) return null;
  let model;
  try { model = createAuditModel(snapshot); } catch { return null; }
  const auditId = Object.getOwnPropertyDescriptor(model, 'auditId');
  const status = model?.session?.status;
  if (!auditId?.enumerable || !Object.hasOwn(auditId, 'value') || !validId(auditId.value) || auditId.value !== expectedAuditId ||
    !R18_STATUS.has(status) || status !== copy.status || !modelMatchesObservedTarget(model, expectedTarget)) return null;
  const checkpoint = copyPlain(copy.checkpoint);
  if (!checkpoint || !Array.isArray(checkpoint.pages) || checkpoint.pages.length === 0) return null;
  let canonical;
  try { canonical = validateExecutionCheckpoint({ auditId: expectedAuditId, checkpoint, pageOrder: model.pages.map(page => page.pageId) }); } catch { return null; }
  return canonical ? Object.freeze({ ...copy, model, checkpoint: canonical }) : null;
}

function modelMatchesObservedTarget(model, target) {
  try {
    if (model.requestedScope?.mode !== 'single' || !Array.isArray(model.pages) || model.pages.length !== 1) return false;
    const page = model.pages[0];
    if (page.attempted !== true || page.finalUrlObserved !== true || typeof page.finalUrl !== 'string') return false;
    if (target.kind === 'owned-disposable' && target.pageId !== null &&
      (!validId(target.pageId) || page.pageId !== target.pageId)) return false;
    const evidence = sanitizeEvidenceUrlV1(page.finalUrl, { includeQuery: false });
    return evidence.href === target.urlEvidence.href && evidence.queryIncluded === target.urlEvidence.queryIncluded &&
      evidence.redactedSegments === target.urlEvidence.redactedSegments;
  } catch { return false; }
}

function assertNotAborted(signal) {
  if (!signal || typeof signal !== 'object') return;
  try {
    let cursor = signal;
    let descriptor = null;
    while (cursor && !descriptor) {
      descriptor = Object.getOwnPropertyDescriptor(cursor, 'aborted');
      cursor = Object.getPrototypeOf(cursor);
    }
    const aborted = descriptor && Object.hasOwn(descriptor, 'value')
      ? descriptor.value
      : descriptor?.get ? descriptor.get.call(signal) : false;
    if (aborted === true) throw new Error('AUDIT_ABORTED');
  } catch (error) {
    if (error?.message === 'AUDIT_ABORTED') throw error;
    throw denied();
  }
}

function captureExact(value, expected) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== expected.length || keys.some(key => typeof key !== 'string') ||
      expected.some(key => !keys.includes(key))) return null;
    const output = {};
    for (const key of expected) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      output[key] = descriptor.value;
    }
    return output;
  } catch { return null; }
}

function captureChromeTab(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const id = Object.getOwnPropertyDescriptor(value, 'id');
    const windowId = Object.getOwnPropertyDescriptor(value, 'windowId');
    if (!id?.enumerable || !Object.hasOwn(id, 'value') || !windowId?.enumerable || !Object.hasOwn(windowId, 'value')) return null;
    return { id: id.value, windowId: windowId.value };
  } catch { return null; }
}

function captureArgs(input) {
  return captureExact(input, RUNNER_KEYS);
}

function copyEvidence(value) {
  const record = captureExact(value, ['version', 'href', 'queryIncluded', 'redactedSegments']);
  if (!record || !isEvidenceUrlV1(record)) return null;
  return Object.freeze(record);
}

function copyTarget(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  let keys;
  let kindDescriptor;
  try {
    keys = Reflect.ownKeys(input);
    kindDescriptor = Object.getOwnPropertyDescriptor(input, 'kind');
  } catch { return null; }
  if (!kindDescriptor?.enumerable || !Object.hasOwn(kindDescriptor, 'value')) return null;
  const kind = kindDescriptor.value;

  // The output shape can be re-entered internally after a target has already
  // been proved. It contains no navigation secret or capability.
  if (kind === 'attached' && keys.length === 7 && keys.includes('version')) {
    const record = captureExact(input, ['version', 'kind', 'tabId', 'windowId', 'documentId', 'urlEvidence', 'urlSessionDigest']);
    if (!record || record.version !== 'ObservedTargetV1' || !validChromeId(record.tabId) ||
      !validChromeId(record.windowId) || !validId(record.documentId) || !copyEvidence(record.urlEvidence) ||
      !DIGEST.test(record.urlSessionDigest)) return null;
    return Object.freeze({ kind, tabId: record.tabId, windowId: record.windowId, documentId: record.documentId,
      initialUrlEvidence: copyEvidence(record.urlEvidence), initialUrlSessionDigest: record.urlSessionDigest,
      navigationToken: null, cleanupMode: null, pageId: null, preRegistered: true });
  }
  const attached = captureExact(input, ['kind', 'tabId', 'windowId', 'documentId', 'initialUrlEvidence', 'initialUrlSessionDigest']);
  if (attached && kind === 'attached' && validChromeId(attached.tabId) && validChromeId(attached.windowId) &&
    validId(attached.documentId) && copyEvidence(attached.initialUrlEvidence) && DIGEST.test(attached.initialUrlSessionDigest)) {
    return Object.freeze({ ...attached, initialUrlEvidence: copyEvidence(attached.initialUrlEvidence), navigationToken: null,
      cleanupMode: null, pageId: null, preRegistered: true });
  }

  // A disposable target is issued with a navigation token. A caller may know
  // the reserved tab already, but must never pass the raw navigation URL.
  const owned = captureExact(input, ['kind', 'ownershipId', 'navigationToken', 'cleanupMode', 'pageId']);
  if (owned && kind === 'owned-disposable' && validId(owned.ownershipId) &&
    typeof owned.navigationToken === 'string' && TOKEN.test(owned.navigationToken) &&
    ['always', 'pre-observation-failure'].includes(owned.cleanupMode) &&
    (owned.pageId === null || validId(owned.pageId))) {
    return Object.freeze({ ...owned, tabId: null, windowId: null, documentId: null,
      initialUrlEvidence: null, initialUrlSessionDigest: null, preRegistered: false });
  }
  return null;
}

function makeObserved(target, proof, evidence) {
  if (target.kind === 'owned-disposable') return Object.freeze({
    version: 'ObservedTargetV1', kind: 'owned-disposable', ownershipId: target.ownershipId,
    tabId: proof.tabId, windowId: proof.windowId, documentId: proof.documentId,
    urlEvidence: copyEvidence(evidence), urlSessionDigest: proof.urlSessionDigest,
    cleanupMode: target.cleanupMode, pageId: target.pageId ?? null,
  });
  return Object.freeze({ version: 'ObservedTargetV1', kind: 'attached', tabId: proof.tabId,
    windowId: proof.windowId, documentId: proof.documentId, urlEvidence: copyEvidence(evidence),
    urlSessionDigest: proof.urlSessionDigest });
}

function validProof(proof, target) {
  const copy = captureExact(proof, ['tabId', 'windowId', 'documentId', 'urlSessionDigest']);
  return copy && validChromeId(copy.tabId) && validChromeId(copy.windowId) && validId(copy.documentId) &&
    DIGEST.test(copy.urlSessionDigest) && copy.tabId === target.tabId && copy.windowId === target.windowId &&
    (target.documentId === undefined || target.documentId === null || copy.documentId === target.documentId) &&
    (target.urlSessionDigest === undefined || target.urlSessionDigest === null || copy.urlSessionDigest === target.urlSessionDigest)
    ? Object.freeze(copy) : null;
}

function modelStatus(value) {
  try {
    const model = Object.getOwnPropertyDescriptor(value, 'model');
    const session = model?.enumerable && Object.hasOwn(model, 'value') ? Object.getOwnPropertyDescriptor(model.value, 'session') : null;
    const status = session?.enumerable && Object.hasOwn(session, 'value') ? Object.getOwnPropertyDescriptor(session.value, 'status') : null;
    return status?.enumerable && Object.hasOwn(status, 'value') ? status.value : null;
  } catch { return null; }
}

function adapterPipeline(adapter) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(adapter, 'runPipeline');
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value') || !isObservedPipelineRunner(descriptor.value)) return null;
    return descriptor.value;
  } catch { return null; }
}

function ownershipApi(adapter) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(adapter, 'ownedTabs');
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value') || !descriptor.value || typeof descriptor.value !== 'object') return null;
    return descriptor.value;
  } catch { return null; }
}

function captureOwnedBundle(adapter) {
  const owner = ownershipApi(adapter);
  if (!owner) return null;
  const methods = {};
  for (const name of ['registerCreated', 'transition', 'removeOwned', 'markCleanupPending']) {
    methods[name] = captureCallable(owner, name);
    if (!methods[name]) return null;
  }
  methods.get = captureCallable(owner, 'get');
  if (!methods.get) return null;
  return { owner, methods };
}

async function cleanupOwned(bundle, adapter, target, auditId, state, observed, signal, removeTab) {
  if (target.kind !== 'owned-disposable') return 'attached';
  const owner = bundle?.methods;
  if (!owner?.get) throw new Error('CLEANUP_UNCONFIRMED');
  const expected = { ownershipId: target.ownershipId, auditId, purpose: 'audit', tabId: target.tabId,
    windowId: target.windowId, cleanupMode: target.cleanupMode };
  let directAttempted = false;
  const read = async () => {
    const raw = await owner.get(target.ownershipId);
    if (raw === null) return null;
    const record = copyOwnedRecord(raw, expected);
    if (!record) throw new Error('OWNERSHIP_RECORD_UNCONFIRMED');
    return record;
  };
  const confirm = async (expectedState) => {
    const record = await read();
    if (!record || record.state !== expectedState) throw new Error('OWNERSHIP_RECORD_UNCONFIRMED');
    return record;
  };
  const directAfterAbsent = async () => {
    const absent = await read();
    if (absent !== null) throw new Error('CLEANUP_UNCONFIRMED');
    directAttempted = true;
    return removeUnregistered(adapter, target.tabId, signal, removeTab);
  };
  try {
    if (observed && target.cleanupMode === 'pre-observation-failure') {
      const record = await owner.transition({ ownershipId: target.ownershipId, auditId,
        tabId: target.tabId, fromState: 'observing', toState: 'retained-for-review' });
      const valid = copyOwnedRecord(record, { ...expected, state: 'retained-for-review' });
      if (!valid) throw new Error('OWNERSHIP_TRANSITION_INVALID');
      await confirm('retained-for-review');
      try { assertNotAborted(signal); } catch { /* transition committed; report its exact state */ }
      return 'retained-for-review';
    }
    const record = await owner.removeOwned({ ownershipId: target.ownershipId, auditId, tabId: target.tabId, fromState: state });
    const valid = copyOwnedRecord(record, expected);
    if (!valid) {
      const current = await read();
      if (current?.state === 'removed') { await confirm('removed'); return 'removed'; }
      if (current) {
        const pending = await owner.markCleanupPending({ ownershipId: target.ownershipId, auditId, tabId: target.tabId, fromState: current.state });
        if (!copyOwnedRecord(pending, { ...expected, state: 'cleanup-pending' })) throw new Error('OWNERSHIP_PENDING_INVALID');
        await confirm('cleanup-pending');
        return 'cleanup-pending';
      }
      return directAfterAbsent();
    }
    await confirm(valid.state);
    if (!['removed', 'cleanup-pending'].includes(valid.state)) throw new Error('OWNERSHIP_REMOVE_INVALID');
    try { assertNotAborted(signal); } catch { /* removal committed; report its exact state */ }
    return valid.state;
  } catch {
    if (directAttempted) throw new Error('CLEANUP_UNCONFIRMED');
    const current = await read();
    if (current?.state === 'removed') { await confirm('removed'); return 'removed'; }
    if (current && validChromeId(target.tabId)) {
      try {
        const pending = await owner.markCleanupPending({ ownershipId: target.ownershipId, auditId, tabId: target.tabId, fromState: current.state });
        if (!copyOwnedRecord(pending, { ...expected, state: 'cleanup-pending' })) throw new Error('OWNERSHIP_PENDING_INVALID');
        await confirm('cleanup-pending');
        try { assertNotAborted(signal); } catch { /* journal transition committed */ }
        return 'cleanup-pending';
      } catch { /* journal remains authoritative */ }
    }
    return directAfterAbsent();
  }
}

async function removeUnregistered(adapter, tabId, signal, capturedRemoveTab = null) {
  const remove = capturedRemoveTab ?? captureCallable(adapter, 'removeTab');
  if (!remove || !validChromeId(tabId)) throw new Error('CLEANUP_UNCONFIRMED');
  try {
    await remove(tabId);
    try { assertNotAborted(signal); } catch { /* direct removal committed */ }
    return 'removed';
  } catch { throw new Error('CLEANUP_UNCONFIRMED'); }
}

export async function runObservedTabAudit(input) {
  const args = captureArgs(input);
  if (!args) throw denied();
  const { auditId, target: rawTarget, chromeAdapter, capturePolicy, privacyGate, onCheckpoint, now, signal, expectedExtensionId } = args;
  const target = copyTarget(rawTarget);
  const pipeline = chromeAdapter && typeof chromeAdapter === 'object' ? adapterPipeline(chromeAdapter) : null;
  const policy = copyPolicy(capturePolicy);
  const probeDocumentIdentity = chromeAdapter && typeof chromeAdapter === 'object' ? captureCallable(chromeAdapter, 'probeDocumentIdentity') : null;
  const removeTab = chromeAdapter && typeof chromeAdapter === 'object' ? captureCallable(chromeAdapter, 'removeTab') : null;
  const ownedBundle = target?.kind === 'owned-disposable' && chromeAdapter && typeof chromeAdapter === 'object'
    ? captureOwnedBundle(chromeAdapter) : null;
  const navigateTab = target?.kind === 'owned-disposable' ? captureCallable(chromeAdapter, 'navigateTab') : null;
  const waitForStable = target?.kind === 'owned-disposable' ? captureCallable(chromeAdapter, 'waitForStable') : null;
  const resolveNavigationToken = target?.kind === 'owned-disposable' ? captureCallable(chromeAdapter, 'resolveNavigationToken') : null;
  const getEvidenceUrl = target?.kind === 'owned-disposable' ? captureCallable(chromeAdapter, 'getEvidenceUrl') : null;
  if (!validId(auditId) || !target || !chromeAdapter || typeof chromeAdapter !== 'object' ||
    !policy || policy.mode !== 'no-pixels' || policy.includeQuery !== false ||
    (target.initialUrlEvidence?.queryIncluded && !policy.includeQuery) ||
    typeof onCheckpoint !== 'function' || typeof now !== 'function' ||
    (expectedExtensionId !== undefined && typeof expectedExtensionId !== 'string') ||
    !probeDocumentIdentity || !pipeline ||
    (target.kind === 'owned-disposable' && (!ownedBundle || !navigateTab || !waitForStable || !resolveNavigationToken || !getEvidenceUrl || !removeTab))) throw denied();

  let tabId = target.tabId;
  let windowId = target.windowId;
  let ownershipState = target.kind === 'attached' ? 'attached' : 'cleanup-pending';
  let observedTarget = null;
  let observed = false;
  let terminalModel = null;
  let attestation = null;
  let journalCommitted = false;
  let createdTab = false;
  try {
    assertNotAborted(signal);
    if (target.kind === 'owned-disposable' && !target.preRegistered) {
      const createTab = captureCallable(chromeAdapter, 'createTab');
      if (!createTab) throw new Error('TARGET_CREATION_FAILED');
      const created = captureChromeTab(await createTab({ url: 'about:blank', active: true }));
      if (validChromeId(created?.id) && validChromeId(created?.windowId)) {
        tabId = created.id; windowId = created.windowId;
        createdTab = true;
      }
      assertNotAborted(signal);
      if (!validChromeId(created?.id) || !validChromeId(created?.windowId)) throw new Error('TARGET_CREATION_FAILED');
      const registered = await ownedBundle.methods.registerCreated({ ownershipId: target.ownershipId, auditId, purpose: 'audit', tabId, windowId, cleanupMode: target.cleanupMode });
      assertNotAborted(signal);
      if (!copyOwnedRecord(registered, { ownershipId: target.ownershipId, auditId, purpose: 'audit', tabId, windowId, cleanupMode: target.cleanupMode, state: 'created' })) throw new Error('OWNERSHIP_REGISTRATION_INVALID');
      const registeredRead = await ownedBundle.methods.get(target.ownershipId);
      assertNotAborted(signal);
      if (!copyOwnedRecord(registeredRead, { ownershipId: target.ownershipId, auditId, purpose: 'audit', tabId, windowId, cleanupMode: target.cleanupMode, state: 'created' })) throw new Error('OWNERSHIP_REGISTRATION_UNCONFIRMED');
      journalCommitted = true;
      ownershipState = 'created';
      const navigationUrl = await resolveNavigationToken(target.navigationToken);
      assertNotAborted(signal);
      if (typeof navigationUrl !== 'string') throw new Error('NAVIGATION_TOKEN_UNAVAILABLE');
      await navigateTab(tabId, navigationUrl, { signal });
      assertNotAborted(signal);
      await waitForStable(tabId, { signal, timeoutMs: 30_000 });
      assertNotAborted(signal);
    }
    const proof = validProof(await probeDocumentIdentity(tabId), { tabId, windowId });
    assertNotAborted(signal);
    if (!proof || (target.documentId !== null && target.documentId !== undefined && proof.documentId !== target.documentId) ||
      (target.initialUrlSessionDigest && proof.urlSessionDigest !== target.initialUrlSessionDigest)) throw new Error('TARGET_CHANGED');
    const evidence = target.initialUrlEvidence ?? (target.kind === 'owned-disposable' ? await getEvidenceUrl(tabId, policy.includeQuery) : null);
    assertNotAborted(signal);
    const safeEvidence = copyEvidence(evidence);
    if (!safeEvidence || safeEvidence.queryIncluded) throw new Error('TARGET_EVIDENCE_INVALID');
    observedTarget = makeObserved({ ...target, tabId, windowId }, proof, safeEvidence);
    if (target.kind === 'owned-disposable' && ownershipState === 'created') {
      const transitioned = await ownedBundle.methods.transition({ ownershipId: target.ownershipId, auditId, tabId,
        fromState: 'created', toState: 'observing' });
      assertNotAborted(signal);
      if (!copyOwnedRecord(transitioned, { ownershipId: target.ownershipId, auditId, purpose: 'audit', tabId, windowId, cleanupMode: target.cleanupMode, state: 'observing' })) throw new Error('OWNERSHIP_TRANSITION_INVALID');
      const transitionedRead = await ownedBundle.methods.get(target.ownershipId);
      assertNotAborted(signal);
      if (!copyOwnedRecord(transitionedRead, { ownershipId: target.ownershipId, auditId, purpose: 'audit', tabId, windowId,
        cleanupMode: target.cleanupMode, state: 'observing' })) throw new Error('OWNERSHIP_TRANSITION_UNCONFIRMED');
    } else if (target.kind === 'owned-disposable') {
      throw new Error('OWNERSHIP_CHANGED');
    }
    observed = true; ownershipState = target.kind === 'attached' ? 'attached' : 'observing';

    const beforePersist = async ({ observedTarget: finalTarget }) => {
      const finalKeys = finalTarget?.kind === 'owned-disposable'
        ? ['version', 'kind', 'ownershipId', 'tabId', 'windowId', 'documentId', 'urlEvidence', 'urlSessionDigest', 'cleanupMode', 'pageId']
        : ['version', 'kind', 'tabId', 'windowId', 'documentId', 'urlEvidence', 'urlSessionDigest'];
      const capturedTarget = captureExact(finalTarget, finalKeys);
      if (!capturedTarget || capturedTarget.version !== 'ObservedTargetV1' || capturedTarget.kind !== observedTarget.kind ||
        capturedTarget.tabId !== observedTarget.tabId || capturedTarget.windowId !== observedTarget.windowId ||
        capturedTarget.documentId !== observedTarget.documentId || capturedTarget.urlSessionDigest !== observedTarget.urlSessionDigest ||
        !copyEvidence(capturedTarget.urlEvidence) || capturedTarget.urlEvidence.href !== observedTarget.urlEvidence.href ||
        capturedTarget.urlEvidence.queryIncluded !== observedTarget.urlEvidence.queryIncluded ||
        (capturedTarget.kind === 'owned-disposable' &&
          (capturedTarget.ownershipId !== observedTarget.ownershipId || capturedTarget.cleanupMode !== observedTarget.cleanupMode ||
            capturedTarget.pageId !== observedTarget.pageId))) throw denied();
      const finalProof = validProof(await probeDocumentIdentity(capturedTarget.tabId), capturedTarget);
      assertNotAborted(signal);
      if (!finalProof) throw new Error('TARGET_CHANGED');
      attestation = finalProof;
      return finalProof;
    };
    const result = resultEnvelope(await pipeline({ auditId, observedTarget, capturePolicy: policy, signal, beforePersist }), auditId, observedTarget);
    if (!result) throw new Error('AUDIT_RESULT_INVALID');
    if (!validProof(attestation, observedTarget)) throw new Error('AUDIT_ATTESTATION_MISSING');
    terminalModel = result.model;
    const status = modelStatus(result);
    if (!R18_STATUS.has(status)) throw new Error('AUDIT_RESULT_INVALID');
    ownershipState = await cleanupOwned(ownedBundle, chromeAdapter, { ...target, tabId, windowId }, auditId, ownershipState, true, signal, removeTab);
    return Object.freeze({ status, model: result.model, observedTarget, observationState: 'observed', ownershipState });
  } catch (error) {
    let preCreateAbsent = false;
    if (target.kind === 'owned-disposable' && !createdTab && !journalCommitted && !validChromeId(tabId)) {
      const absence = await ownedBundle.methods.get(target.ownershipId);
      if (absence !== null) throw new Error('OWNERSHIP_PREEXISTING');
      ownershipState = 'removed';
      preCreateAbsent = true;
    }
    if (target.kind === 'owned-disposable' && createdTab && !journalCommitted) {
      let persisted = null;
      let absentConfirmed = false;
      if (ownedBundle?.methods.get) {
        try {
          const rawRecord = await ownedBundle.methods.get(target.ownershipId);
          absentConfirmed = rawRecord === null;
          persisted = absentConfirmed ? null : copyOwnedRecord(rawRecord, { ownershipId: target.ownershipId, auditId,
            purpose: 'audit', tabId, windowId, cleanupMode: target.cleanupMode });
        } catch { persisted = null; }
      }
      if (persisted) { journalCommitted = true; ownershipState = persisted.state; }
      else if (absentConfirmed) ownershipState = await removeUnregistered(chromeAdapter, tabId, signal, removeTab);
      else throw new Error('CLEANUP_UNCONFIRMED');
    }
    if ((!createdTab || journalCommitted) && !preCreateAbsent) ownershipState = await cleanupOwned(ownedBundle, chromeAdapter, { ...target, tabId, windowId }, auditId, ownershipState, observed, signal, removeTab);
    if (observed) throw denied();
    let aborted = false;
    try { assertNotAborted(signal); } catch { aborted = true; }
    return Object.freeze({ status: observed && aborted ? 'cancelled' : 'failed', model: observed && typeof terminalModel !== 'undefined' ? terminalModel : null,
      observedTarget: observed ? observedTarget : null, observationState: observed ? 'observed' : 'pre-observation-failure', ownershipState });
  }
}
