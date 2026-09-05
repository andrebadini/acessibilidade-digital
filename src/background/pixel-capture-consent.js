import { isCapturePolicyV1 } from '../core/privacy/capture-policy.js';
import { isEvidenceUrlV1 } from '../core/privacy/evidence-url.js';
import { canonicalAuditId } from '../storage/audit-retention.js';

const PREFIX = 'audita:pixel-capture:v1:';
const TTL_MS = 600_000;
const CATEGORIES = Object.freeze(['password', 'otp', 'payment', 'private-marker']);
const JOURNAL_KEYS = Object.freeze([
  'version', 'revision', 'auditId', 'consentId', 'tabId', 'windowId',
  'documentId', 'mode', 'capturePolicy', 'categories', 'issuedAt', 'updatedAt',
  'expiresAt', 'cleanupAttempts', 'cleanupNotBefore', 'state', 'resumePhase',
  'revokeReason', 'urlEvidence', 'urlSessionDigest', 'source',
]);
const POLICY_KEYS = Object.freeze([
  'version', 'mode', 'includeQuery', 'captureFullPage', 'captureElements',
  'composeAnnouncementMap',
]);
const EVIDENCE_URL_KEYS = Object.freeze(['version', 'href', 'queryIncluded', 'redactedSegments']);
const MODES = new Set(['full-evidence', 'element-only']);
const REASONS = new Set([
  'PIXEL_CONSENT_EXPIRED', 'PIXEL_CONSENT_DOCUMENT_CHANGED',
  'PIXEL_RESUME_INTERRUPTED', 'AUDIT_CANCELLED', 'AUDIT_DELETED', 'SESSION_ENDED',
]);
const MISSING = Symbol('missing');
const NO_RECORD = Symbol('no-record');
const COORDINATOR_KEY = Symbol.for('audita.pixel-capture-state.coordinator.v1');
const priorCoordinator = globalThis[COORDINATOR_KEY];
const COORDINATOR = priorCoordinator?.states instanceof WeakMap &&
  priorCoordinator?.queue?.tail instanceof Promise
  ? priorCoordinator
  : Object.freeze({
    states: new WeakMap(),
    queue: { tail: Promise.resolve() },
  });
if (globalThis[COORDINATOR_KEY] !== COORDINATOR) globalThis[COORDINATOR_KEY] = COORDINATOR;

function error(code) { return new Error(code); }
function unavailable() { return error('PIXEL_STATE_UNAVAILABLE'); }
function validAuditId(value) { return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,160}$/u.test(value); }
function validConsentId(value) { return typeof value === 'string' && /^[A-Za-z0-9_-]{21}[AQgw]$/u.test(value); }
function validOpaque(value) { return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,160}$/u.test(value); }
function validDigest(value) { return typeof value === 'string' && /^hmac-sha256:[A-Za-z0-9_-]{43}$/u.test(value); }
function validEpoch(value) { return Number.isSafeInteger(value) && value >= 0; }
function validPositive(value) { return Number.isSafeInteger(value) && value > 0; }

function exact(value, keys) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
    const own = Reflect.ownKeys(value);
    if (own.length !== keys.length || own.some(key => typeof key !== 'string') ||
      keys.some(key => !own.includes(key))) return null;
    const copy = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      copy[key] = descriptor.value;
    }
    return copy;
  } catch {
    return null;
  }
}

function dense(value) {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
    const own = Reflect.ownKeys(value);
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, 'value') ||
      !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) return null;
    const expected = ['length', ...Array.from({ length: lengthDescriptor.value }, (_unused, index) => String(index))];
    if (own.length !== expected.length || expected.some(key => !own.includes(key))) return null;
    const copy = [];
    for (let index = 0; index < lengthDescriptor.value; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      copy.push(descriptor.value);
    }
    return copy;
  } catch {
    return null;
  }
}

function deepFrozenCopy(value) {
  try {
    if (!value || typeof value !== 'object') return value;
    const array = dense(value);
    if (array) return Object.freeze(array.map(deepFrozenCopy));
    if (Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw unavailable();
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key !== 'string')) throw unavailable();
    const copy = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw unavailable();
      copy[key] = deepFrozenCopy(descriptor.value);
    }
    return Object.freeze(copy);
  } catch {
    throw unavailable();
  }
}

function same(left, right) {
  try {
    if (left === right) return true;
    if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
    const leftArray = dense(left);
    const rightArray = dense(right);
    if (leftArray || rightArray) {
      return !!leftArray && !!rightArray && leftArray.length === rightArray.length &&
        leftArray.every((item, index) => same(item, rightArray[index]));
    }
    if (Array.isArray(left) || Array.isArray(right) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(left)) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(right))) return false;
    const leftKeys = Reflect.ownKeys(left);
    const rightKeys = Reflect.ownKeys(right);
    if (leftKeys.length !== rightKeys.length || leftKeys.some(key => typeof key !== 'string' || !rightKeys.includes(key))) return false;
    return leftKeys.every(key => {
      const leftDescriptor = Object.getOwnPropertyDescriptor(left, key);
      const rightDescriptor = Object.getOwnPropertyDescriptor(right, key);
      return !!leftDescriptor?.enumerable && !!rightDescriptor?.enumerable &&
        Object.hasOwn(leftDescriptor, 'value') && Object.hasOwn(rightDescriptor, 'value') &&
        same(leftDescriptor.value, rightDescriptor.value);
    });
  } catch {
    return false;
  }
}

function categories(value, { allowEmpty = false } = {}) {
  const parsed = dense(value);
  if (!parsed || (!allowEmpty && parsed.length === 0) ||
    parsed.some(item => !CATEGORIES.includes(item)) || new Set(parsed).size !== parsed.length) return null;
  return Object.freeze(CATEGORIES.filter(item => parsed.includes(item)));
}

function capturePolicy(value) {
  const parsed = exact(value, POLICY_KEYS);
  if (!parsed || !isCapturePolicyV1(parsed)) return null;
  return deepFrozenCopy(parsed);
}

function evidenceUrl(value) {
  const parsed = exact(value, EVIDENCE_URL_KEYS);
  if (!parsed || !isEvidenceUrlV1(parsed)) return null;
  return deepFrozenCopy(parsed);
}

function source(value) {
  const attached = exact(value, ['kind']);
  if (attached?.kind === 'attached') return Object.freeze(attached);
  const owned = exact(value, ['kind', 'ownershipId', 'cleanupMode', 'pageId']);
  if (!owned || owned.kind !== 'owned-disposable' || !validOpaque(owned.ownershipId) ||
    !['always', 'pre-observation-failure'].includes(owned.cleanupMode) ||
    (owned.pageId !== null && !validOpaque(owned.pageId))) return null;
  return Object.freeze(owned);
}

function observedTarget(value) {
  const attached = exact(value, [
    'version', 'kind', 'tabId', 'windowId', 'documentId', 'urlEvidence', 'urlSessionDigest',
  ]);
  const owned = exact(value, [
    'version', 'kind', 'ownershipId', 'tabId', 'windowId', 'documentId',
    'urlEvidence', 'urlSessionDigest', 'cleanupMode', 'pageId',
  ]);
  const parsed = attached?.kind === 'attached' ? attached : owned?.kind === 'owned-disposable' ? owned : null;
  if (!parsed || parsed.version !== 'ObservedTargetV1' || !validEpoch(parsed.tabId) ||
    !validEpoch(parsed.windowId) || !validOpaque(parsed.documentId) || !validDigest(parsed.urlSessionDigest)) return null;
  const parsedEvidence = evidenceUrl(parsed.urlEvidence);
  const parsedSource = parsed.kind === 'attached'
    ? source({ kind: 'attached' })
    : source({ kind: 'owned-disposable', ownershipId: parsed.ownershipId,
      cleanupMode: parsed.cleanupMode, pageId: parsed.pageId });
  if (!parsedEvidence || !parsedSource) return null;
  return Object.freeze({
    tabId: parsed.tabId, windowId: parsed.windowId, documentId: parsed.documentId,
    urlEvidence: parsedEvidence, urlSessionDigest: parsed.urlSessionDigest, source: parsedSource,
  });
}

function proof(value) {
  const attached = exact(value, ['kind', 'tabId', 'windowId', 'documentId', 'urlSessionDigest']);
  const owned = exact(value, [
    'kind', 'ownershipId', 'tabId', 'windowId', 'documentId',
    'urlSessionDigest', 'cleanupMode', 'pageId',
  ]);
  const parsed = attached?.kind === 'attached' ? attached : owned?.kind === 'owned-disposable' ? owned : null;
  if (!parsed || !validEpoch(parsed.tabId) || !validEpoch(parsed.windowId) ||
    !validOpaque(parsed.documentId) || !validDigest(parsed.urlSessionDigest)) return null;
  const parsedSource = parsed.kind === 'attached'
    ? source({ kind: 'attached' })
    : source({ kind: 'owned-disposable', ownershipId: parsed.ownershipId,
      cleanupMode: parsed.cleanupMode, pageId: parsed.pageId });
  if (!parsedSource) return null;
  return Object.freeze({
    tabId: parsed.tabId, windowId: parsed.windowId, documentId: parsed.documentId,
    urlSessionDigest: parsed.urlSessionDigest, source: parsedSource,
  });
}

function parseJournal(value) {
  const journal = exact(value, JOURNAL_KEYS);
  if (!journal) return null;
  const parsedPolicy = capturePolicy(journal.capturePolicy);
  const parsedCategories = categories(journal.categories, { allowEmpty: true });
  const parsedEvidence = evidenceUrl(journal.urlEvidence);
  const parsedSource = source(journal.source);
  if (journal.version !== 'PixelCaptureJournalV1' || !validPositive(journal.revision) ||
    !validAuditId(journal.auditId) || !validConsentId(journal.consentId) ||
    !validEpoch(journal.tabId) || !validEpoch(journal.windowId) ||
    !validOpaque(journal.documentId) || !MODES.has(journal.mode) || !parsedPolicy ||
    parsedPolicy.mode !== journal.mode || !parsedCategories ||
    !same(journal.categories, parsedCategories) || !validEpoch(journal.issuedAt) ||
    !validEpoch(journal.updatedAt) || !validEpoch(journal.expiresAt) ||
    journal.updatedAt < journal.issuedAt || journal.expiresAt <= journal.issuedAt ||
    journal.expiresAt - journal.issuedAt > TTL_MS || !parsedEvidence ||
    (parsedEvidence.queryIncluded && !parsedPolicy.includeQuery) ||
    !validDigest(journal.urlSessionDigest) || !parsedSource ||
    !['paused', 'resuming', 'revoked', 'finished'].includes(journal.state)) return null;
  if ((journal.state === 'resuming' && !['consent-claimed', 'session-running', 'runner-started'].includes(journal.resumePhase)) ||
    (journal.state !== 'resuming' && journal.resumePhase !== null) ||
    (journal.state === 'revoked' && !REASONS.has(journal.revokeReason)) ||
    (journal.state !== 'revoked' && journal.revokeReason !== null)) return null;
  if (!Number.isSafeInteger(journal.cleanupAttempts) || journal.cleanupAttempts < 0 ||
    journal.cleanupAttempts > 31) return null;
  if (['paused', 'resuming'].includes(journal.state)) {
    if (journal.cleanupAttempts !== 0 || journal.cleanupNotBefore !== null) return null;
  } else if (!validEpoch(journal.cleanupNotBefore) || journal.cleanupNotBefore < journal.updatedAt) return null;
  return Object.freeze({
    version: 'PixelCaptureJournalV1', revision: journal.revision,
    auditId: journal.auditId, consentId: journal.consentId,
    tabId: journal.tabId, windowId: journal.windowId, documentId: journal.documentId,
    mode: journal.mode, capturePolicy: parsedPolicy, categories: parsedCategories,
    issuedAt: journal.issuedAt, updatedAt: journal.updatedAt, expiresAt: journal.expiresAt,
    cleanupAttempts: journal.cleanupAttempts, cleanupNotBefore: journal.cleanupNotBefore,
    state: journal.state, resumePhase: journal.resumePhase, revokeReason: journal.revokeReason,
    urlEvidence: parsedEvidence, urlSessionDigest: journal.urlSessionDigest, source: parsedSource,
  });
}

function stateFor(sessionArea) {
  let state = COORDINATOR.states.get(sessionArea);
  if (!state) {
    state = { highWater: null, barriers: new Set() };
    COORDINATOR.states.set(sessionArea, state);
  } else if (!(state.barriers instanceof Set)) {
    state.barriers = new Set();
  }
  return state;
}

function serial(operation) {
  const result = COORDINATOR.queue.tail.then(operation, operation);
  COORDINATOR.queue.tail = result.then(() => undefined, () => undefined);
  return result;
}

function consentToken(randomBytes, previous = null) {
  try {
    const bytes = randomBytes(16);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 16) throw unavailable();
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const value = btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
    if (!validConsentId(value) || value === previous) throw unavailable();
    return value;
  } catch {
    throw unavailable();
  }
}

function safeAdd(left, right) {
  const result = left + right;
  return Number.isSafeInteger(result) && result >= 0 ? result : null;
}

function nextRevision(journal) {
  return journal.revision < Number.MAX_SAFE_INTEGER ? journal.revision + 1 : null;
}

function updatedJournal(current, updatedAt, changes) {
  const revision = nextRevision(current);
  if (revision === null || !validEpoch(updatedAt) || updatedAt < current.updatedAt) throw unavailable();
  const parsed = parseJournal({ ...current, ...changes, revision, updatedAt });
  if (!parsed) throw unavailable();
  return parsed;
}

function suspension(journal) {
  return deepFrozenCopy({
    version: 'AuditSuspensionV1', revision: journal.revision,
    auditId: journal.auditId, consentId: journal.consentId,
    tabId: journal.tabId, windowId: journal.windowId, documentId: journal.documentId,
    urlEvidence: journal.urlEvidence, urlSessionDigest: journal.urlSessionDigest,
    mode: journal.mode, capturePolicy: journal.capturePolicy, categories: journal.categories,
    issuedAt: journal.issuedAt, updatedAt: journal.updatedAt, expiresAt: journal.expiresAt,
    cleanupAttempts: journal.cleanupAttempts, cleanupNotBefore: journal.cleanupNotBefore,
    state: journal.state, resumePhase: journal.resumePhase, revokeReason: journal.revokeReason,
    source: journal.source,
  });
}

function claim(journal, claimedAt) {
  return deepFrozenCopy({
    version: 'PixelCaptureClaimV1', auditId: journal.auditId, consentId: journal.consentId,
    tabId: journal.tabId, windowId: journal.windowId, documentId: journal.documentId,
    urlSessionDigest: journal.urlSessionDigest, mode: journal.mode, categories: journal.categories,
    claimedAt, expiresAt: journal.expiresAt, source: journal.source,
  });
}

function revokeResult(status, journal = null) {
  return deepFrozenCopy({
    version: 'PixelRevokeResultV1', status,
    suspension: journal ? suspension(journal) : null,
  });
}

function bindingMatches(journal, currentProof) {
  return journal.tabId === currentProof.tabId && journal.windowId === currentProof.windowId &&
    journal.documentId === currentProof.documentId &&
    journal.urlSessionDigest === currentProof.urlSessionDigest &&
    same(journal.source, currentProof.source);
}

function storageValue(result, storageKey) {
  try {
    if (!result || typeof result !== 'object' || Array.isArray(result) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(result))) throw unavailable();
    const descriptor = Object.getOwnPropertyDescriptor(result, storageKey);
    if (!descriptor) return MISSING;
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw unavailable();
    return descriptor.value === undefined ? MISSING : descriptor.value;
  } catch {
    throw unavailable();
  }
}

export function createPixelCaptureStateV1(options) {
  let sessionArea; let now; let randomBytes;
  try {
    ({ sessionArea, now, randomBytes } = options ?? {});
    if (!sessionArea || typeof sessionArea.get !== 'function' ||
      typeof sessionArea.set !== 'function' || typeof sessionArea.remove !== 'function' ||
      typeof now !== 'function' || typeof randomBytes !== 'function') throw unavailable();
  } catch {
    throw unavailable();
  }
  const shared = stateFor(sessionArea);
  const at = () => {
    let value;
    try { value = now(); } catch { throw unavailable(); }
    if (!validEpoch(value) || (shared.highWater !== null && value < shared.highWater)) throw unavailable();
    shared.highWater = value;
    return value;
  };
  const key = auditId => `${PREFIX}${auditId}`;
  const read = async auditId => {
    const storageKey = key(auditId);
    let result;
    try { result = await sessionArea.get(storageKey); } catch { throw unavailable(); }
    const value = storageValue(result, storageKey);
    if (value === MISSING) return null;
    const parsed = parseJournal(value);
    if (!parsed || parsed.auditId !== auditId) throw unavailable();
    return parsed;
  };
  const assertFresh = (journal, currentAt) => {
    if (currentAt < journal.updatedAt) throw unavailable();
  };
  const write = async (journal, expected) => {
    const desired = parseJournal(journal);
    if (!desired) throw unavailable();
    const before = await read(desired.auditId);
    if (expected === NO_RECORD ? before !== null : !before || !same(before, expected)) throw unavailable();
    try { await sessionArea.set({ [key(desired.auditId)]: deepFrozenCopy(desired) }); }
    catch { /* read-back is authoritative */ }
    const confirmed = await read(desired.auditId);
    if (!confirmed || !same(confirmed, desired)) throw unavailable();
    return confirmed;
  };
  const erase = async auditId => {
    const storageKey = key(auditId);
    try { await sessionArea.remove(storageKey); } catch { /* read-back is authoritative */ }
    let result;
    try { result = await sessionArea.get(storageKey); } catch { throw unavailable(); }
    if (storageValue(result, storageKey) !== MISSING) throw unavailable();
  };
  const scanNamespace = async () => {
    let values;
    try { values = await sessionArea.get(null); } catch { throw unavailable(); }
    let own;
    try {
      if (!values || typeof values !== 'object' || Array.isArray(values) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(values))) throw unavailable();
      own = Reflect.ownKeys(values);
    } catch {
      throw unavailable();
    }
    const records = [];
    const unavailableAuditIds = new Set();
    let hasUnattributedUnavailable = false;
    for (const item of own) {
      if (typeof item !== 'string' || !item.startsWith(PREFIX)) continue;
      const suffix = item.slice(PREFIX.length);
      let descriptor;
      try { descriptor = Object.getOwnPropertyDescriptor(values, item); } catch { descriptor = null; }
      const record = descriptor?.enumerable && Object.hasOwn(descriptor, 'value')
        ? parseJournal(descriptor.value)
        : null;
      if (!record || item !== key(record.auditId)) {
        if (validAuditId(suffix)) unavailableAuditIds.add(suffix);
        else hasUnattributedUnavailable = true;
        continue;
      }
      records.push(record);
    }
    return {
      records,
      unavailableAuditIds: [...unavailableAuditIds].sort(),
      hasUnattributedUnavailable,
    };
  };
  const ensureUnblocked = auditId => {
    if (shared.barriers.has(auditId)) throw unavailable();
  };
  const revokeBindingMismatch = async (current, currentAt) => {
    try {
      const revoked = updatedJournal(current, currentAt, {
        cleanupAttempts: 0,
        cleanupNotBefore: currentAt,
        state: 'revoked',
        resumePhase: null,
        revokeReason: 'PIXEL_CONSENT_DOCUMENT_CHANGED',
      });
      await write(revoked, current);
      shared.barriers.delete(current.auditId);
    } catch {
      shared.barriers.add(current.auditId);
      throw unavailable();
    }
    throw error('PIXEL_CONSENT_DOCUMENT_CHANGED');
  };

  return Object.freeze({
    pause: request => serial(async () => {
      const input = exact(request, [
        'auditId', 'observedTarget', 'mode', 'capturePolicy', 'categories', 'authorityExpiresAt',
      ]);
      const target = input && observedTarget(input.observedTarget);
      const policy = input && capturePolicy(input.capturePolicy);
      const sensitive = input && categories(input.categories);
      if (!input || !validAuditId(input.auditId) || !target || !MODES.has(input.mode) ||
        !policy || policy.mode !== input.mode ||
        (target.urlEvidence.queryIncluded && !policy.includeQuery) || !sensitive ||
        !validEpoch(input.authorityExpiresAt)) throw unavailable();
      const issuedAt = at();
      const ttlDeadline = safeAdd(issuedAt, TTL_MS);
      if (ttlDeadline === null || input.authorityExpiresAt <= issuedAt) throw unavailable();
      const existing = await scanNamespace();
      if (existing.records.some(record => record.updatedAt > issuedAt)) throw unavailable();
      if (await read(input.auditId)) throw error('PIXEL_CONSENT_EXISTS');
      const journal = parseJournal({
        version: 'PixelCaptureJournalV1', revision: 1, auditId: input.auditId,
        consentId: consentToken(randomBytes), tabId: target.tabId, windowId: target.windowId,
        documentId: target.documentId, mode: input.mode, capturePolicy: policy,
        categories: sensitive, issuedAt, updatedAt: issuedAt,
        expiresAt: Math.min(input.authorityExpiresAt, ttlDeadline),
        cleanupAttempts: 0, cleanupNotBefore: null, state: 'paused', resumePhase: null,
        revokeReason: null, urlEvidence: target.urlEvidence,
        urlSessionDigest: target.urlSessionDigest, source: target.source,
      });
      if (!journal) throw unavailable();
      return suspension(await write(journal, NO_RECORD));
    }),

    claimAndBeginResume: request => serial(async () => {
      const input = exact(request, ['auditId', 'consentId', 'proof', 'mode', 'categories']);
      const currentProof = input && proof(input.proof);
      const currentCategories = input && categories(input.categories, { allowEmpty: true });
      if (!input || !validAuditId(input.auditId) || !validConsentId(input.consentId) ||
        !currentProof || !MODES.has(input.mode) || !currentCategories) throw unavailable();
      ensureUnblocked(input.auditId);
      const current = await read(input.auditId);
      if (!current) throw error('PIXEL_CONSENT_MISSING');
      const claimedAt = at();
      assertFresh(current, claimedAt);
      if (current.consentId !== input.consentId) throw error('PIXEL_CONSENT_STALE');
      if (current.state !== 'paused') throw error('PIXEL_CONSENT_ALREADY_USED');
      if (claimedAt >= current.expiresAt) throw error('PIXEL_CONSENT_EXPIRED');
      if (current.mode !== input.mode || !bindingMatches(current, currentProof)) {
        return revokeBindingMismatch(current, claimedAt);
      }
      if (!same(current.categories, currentCategories)) {
        try {
          const rotated = updatedJournal(current, claimedAt, {
            consentId: consentToken(randomBytes, current.consentId),
            categories: currentCategories,
          });
          await write(rotated, current);
        } catch {
          shared.barriers.add(current.auditId);
          throw unavailable();
        }
        throw error('PIXEL_CONSENT_SIGNALS_CHANGED');
      }
      const resumed = updatedJournal(current, claimedAt, {
        state: 'resuming', resumePhase: 'consent-claimed',
      });
      const confirmed = await write(resumed, current);
      const confirmedAt = at();
      assertFresh(confirmed, confirmedAt);
      if (confirmedAt >= confirmed.expiresAt) throw error('PIXEL_CONSENT_EXPIRED');
      return claim(confirmed, claimedAt);
    }),

    markSessionRunning: request => serial(async () => {
      const input = exact(request, ['auditId', 'consentId']);
      if (!input || !validAuditId(input.auditId) || !validConsentId(input.consentId)) {
        throw error('PIXEL_RESUME_TRANSITION_INVALID');
      }
      ensureUnblocked(input.auditId);
      const current = await read(input.auditId);
      if (!current) throw error('PIXEL_RESUME_TRANSITION_INVALID');
      const updatedAt = at();
      assertFresh(current, updatedAt);
      if (current.consentId !== input.consentId || current.state !== 'resuming' ||
        current.resumePhase !== 'consent-claimed') throw error('PIXEL_RESUME_TRANSITION_INVALID');
      if (updatedAt >= current.expiresAt) throw error('PIXEL_CONSENT_EXPIRED');
      const running = updatedJournal(current, updatedAt, { resumePhase: 'session-running' });
      const confirmed = await write(running, current);
      const confirmedAt = at();
      assertFresh(confirmed, confirmedAt);
      if (confirmedAt >= confirmed.expiresAt) throw error('PIXEL_CONSENT_EXPIRED');
      return suspension(confirmed);
    }),

    gateRunnerStart: request => serial(async () => {
      const input = exact(request, ['auditId', 'consentId', 'proof', 'categories']);
      const currentProof = input && proof(input.proof);
      const currentCategories = input && categories(input.categories, { allowEmpty: true });
      if (!input || !validAuditId(input.auditId) || !validConsentId(input.consentId) ||
        !currentProof || !currentCategories) throw error('PIXEL_RESUME_TRANSITION_INVALID');
      ensureUnblocked(input.auditId);
      const current = await read(input.auditId);
      if (!current) throw error('PIXEL_RESUME_TRANSITION_INVALID');
      const updatedAt = at();
      assertFresh(current, updatedAt);
      if (current.consentId !== input.consentId || current.state !== 'resuming' ||
        current.resumePhase !== 'session-running') throw error('PIXEL_RESUME_TRANSITION_INVALID');
      if (updatedAt >= current.expiresAt) throw error('PIXEL_CONSENT_EXPIRED');
      if (!bindingMatches(current, currentProof)) return revokeBindingMismatch(current, updatedAt);
      if (same(current.categories, currentCategories)) {
        const ready = updatedJournal(current, updatedAt, { resumePhase: 'runner-started' });
        const confirmed = await write(ready, current);
        const confirmedAt = at();
        assertFresh(confirmed, confirmedAt);
        if (confirmedAt >= confirmed.expiresAt) throw error('PIXEL_CONSENT_EXPIRED');
        return deepFrozenCopy({
          version: 'PixelRunnerGateResultV1', status: 'ready',
          suspension: suspension(confirmed),
        });
      }
      let replacementConsentId;
      try { replacementConsentId = consentToken(randomBytes, current.consentId); }
      catch {
        shared.barriers.add(current.auditId);
        throw unavailable();
      }
      const repaused = updatedJournal(current, updatedAt, {
        consentId: replacementConsentId, categories: currentCategories,
        cleanupAttempts: 0, cleanupNotBefore: null,
        state: 'paused', resumePhase: null, revokeReason: null,
      });
      let confirmed;
      try { confirmed = await write(repaused, current); }
      catch {
        shared.barriers.add(current.auditId);
        throw unavailable();
      }
      return deepFrozenCopy({
        version: 'PixelRunnerGateResultV1', status: 'repaused', suspension: suspension(confirmed),
      });
    }),

    readSuspension: auditId => serial(async () => {
      try { canonicalAuditId(auditId); } catch { throw unavailable(); }
      const currentAt = at();
      const current = await read(auditId);
      if (!current) return null;
      assertFresh(current, currentAt);
      return suspension(current);
    }),

    listSuspensions: request => serial(async () => {
      const input = exact(request, ['limit']);
      if (!input || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 25) throw unavailable();
      at();
      const scan = await scanNamespace();
      scan.records.sort((left, right) => left.expiresAt - right.expiresAt || left.auditId.localeCompare(right.auditId));
      return deepFrozenCopy({
        version: 'PixelSuspensionScanV1',
        suspensions: scan.records.slice(0, input.limit).map(suspension),
        unavailableAuditIds: scan.unavailableAuditIds,
        hasUnattributedUnavailable: scan.hasUnattributedUnavailable,
      });
    }),

    listRecoveryCandidates: request => serial(async () => {
      const input = exact(request, ['limit', 'includeResuming']);
      if (!input || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 25 ||
        typeof input.includeResuming !== 'boolean') throw unavailable();
      const currentAt = at();
      const scan = await scanNamespace();
      let blockingCount = 0;
      const candidates = [];
      for (const record of scan.records) {
        if (record.state === 'resuming') blockingCount += 1;
        if ((input.includeResuming && record.state === 'resuming') ||
          (record.state === 'paused' && record.expiresAt <= currentAt) ||
          (['revoked', 'finished'].includes(record.state) && record.cleanupNotBefore <= currentAt)) {
          candidates.push(record);
        }
      }
      const priority = { resuming: 0, paused: 1, revoked: 1, finished: 1 };
      const due = record => ['paused', 'resuming'].includes(record.state)
        ? record.expiresAt
        : record.cleanupNotBefore;
      candidates.sort((left, right) => priority[left.state] - priority[right.state] ||
        due(left) - due(right) || left.auditId.localeCompare(right.auditId));
      return deepFrozenCopy({
        version: 'PixelRecoveryScanV1',
        candidates: candidates.slice(0, input.limit).map(suspension),
        unavailableAuditIds: scan.unavailableAuditIds,
        hasUnattributedUnavailable: scan.hasUnattributedUnavailable,
        blockingCount,
      });
    }),

    nextExpiresAt: () => serial(async () => {
      at();
      const scan = await scanNamespace();
      const deadlines = scan.records.flatMap(record =>
        record.state === 'paused' ? [record.expiresAt] :
          ['revoked', 'finished'].includes(record.state) ? [record.cleanupNotBefore] : []);
      return deadlines.length === 0 ? null : Math.min(...deadlines);
    }),

    revokeAudit: request => serial(async () => {
      const input = exact(request, ['auditId', 'consentId', 'reason']);
      if (!input || !validAuditId(input.auditId) || !validConsentId(input.consentId) ||
        !REASONS.has(input.reason)) throw unavailable();
      const updatedAt = at();
      const current = await read(input.auditId);
      if (!current) {
        return revokeResult('missing');
      }
      assertFresh(current, updatedAt);
      if (current.consentId !== input.consentId) {
        return revokeResult('mismatch');
      }
      if (current.state === 'finished') {
        shared.barriers.delete(input.auditId);
        return revokeResult('finished', current);
      }
      if (current.state === 'revoked') {
        shared.barriers.delete(input.auditId);
        return revokeResult('already-revoked', current);
      }
      let confirmed;
      try {
        const revoked = updatedJournal(current, updatedAt, {
          cleanupAttempts: 0, cleanupNotBefore: updatedAt,
          state: 'revoked', resumePhase: null, revokeReason: input.reason,
        });
        confirmed = await write(revoked, current);
      } catch {
        shared.barriers.add(input.auditId);
        throw unavailable();
      }
      shared.barriers.delete(input.auditId);
      return revokeResult('revoked', confirmed);
    }),

    deferCleanup: request => serial(async () => {
      const input = exact(request, ['auditId', 'consentId', 'expectedRevision']);
      if (!input || !validAuditId(input.auditId) || !validConsentId(input.consentId) ||
        !validPositive(input.expectedRevision)) throw unavailable();
      const updatedAt = at();
      const current = await read(input.auditId);
      if (!current) return null;
      assertFresh(current, updatedAt);
      if (current.consentId !== input.consentId || current.revision !== input.expectedRevision ||
        !['revoked', 'finished'].includes(current.state)) return null;
      if (nextRevision(current) === null) throw unavailable();
      const attempts = Math.min(31, current.cleanupAttempts + 1);
      const delay = Math.min(TTL_MS, 60_000 * (2 ** (attempts - 1)));
      const cleanupNotBefore = safeAdd(updatedAt, delay);
      if (cleanupNotBefore === null) throw unavailable();
      const deferred = updatedJournal(current, updatedAt, { cleanupAttempts: attempts, cleanupNotBefore });
      return suspension(await write(deferred, current));
    }),

    finish: request => serial(async () => {
      const input = exact(request, ['auditId', 'consentId']);
      if (!input || !validAuditId(input.auditId) || !validConsentId(input.consentId)) throw unavailable();
      const terminalAt = at();
      let current = await read(input.auditId);
      if (!current) return false;
      assertFresh(current, terminalAt);
      if (current.consentId !== input.consentId) return false;
      if (current.state !== 'finished') {
        if (!(current.state === 'revoked' ||
          (current.state === 'resuming' && current.resumePhase === 'runner-started'))) return false;
        const terminal = updatedJournal(current, terminalAt, {
          cleanupAttempts: 0, cleanupNotBefore: terminalAt,
          state: 'finished', resumePhase: null, revokeReason: null,
        });
        current = await write(terminal, current);
      }
      await erase(input.auditId);
      shared.barriers.delete(input.auditId);
      return true;
    }),
  });
}
