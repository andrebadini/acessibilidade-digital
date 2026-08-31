import { isCapturePolicyV1 } from '../core/privacy/capture-policy.js';
import { isEvidenceUrlV1 } from '../core/privacy/evidence-url.js';

const PREFIX = 'audita:pixel-capture:v1:';
const TTL_MS = 600_000;
const CATEGORIES = Object.freeze(['password', 'otp', 'payment', 'private-marker']);
const STATES = new WeakMap();
const JOURNAL_KEYS = Object.freeze(['version', 'revision', 'auditId', 'consentId', 'tabId', 'windowId', 'documentId', 'mode', 'capturePolicy', 'categories', 'issuedAt', 'updatedAt', 'expiresAt', 'cleanupAttempts', 'cleanupNotBefore', 'state', 'resumePhase', 'revokeReason', 'urlEvidence', 'urlSessionDigest', 'source']);
const MODES = new Set(['full-evidence', 'element-only']);
const REASONS = new Set(['PIXEL_CONSENT_EXPIRED', 'PIXEL_CONSENT_DOCUMENT_CHANGED', 'PIXEL_RESUME_INTERRUPTED', 'AUDIT_CANCELLED', 'AUDIT_DELETED', 'SESSION_ENDED']);

function error(code) { return new Error(code); }
function unavailable() { return error('PIXEL_STATE_UNAVAILABLE'); }
function validAuditId(value) { return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,160}$/u.test(value); }
function validConsentId(value) { return typeof value === 'string' && /^[A-Za-z0-9_-]{22}$/u.test(value); }
function validOpaque(value) { return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,160}$/u.test(value); }
function validDigest(value) { return typeof value === 'string' && /^hmac-sha256:[A-Za-z0-9_-]{43}$/u.test(value); }
function validEpoch(value) { return Number.isSafeInteger(value) && value >= 0; }
function validPositive(value) { return Number.isSafeInteger(value) && value > 0; }
function validPolicy(value) {
  try { return !!value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value)) && isCapturePolicyV1(value); }
  catch { return false; }
}

function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
  try {
    const own = Reflect.ownKeys(value);
    if (own.length !== keys.length || keys.some(key => !own.includes(key))) return null;
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
    const expected = ['length', ...Array.from({ length: value.length }, (_unused, index) => String(index))];
    if (own.length !== expected.length || expected.some(key => !own.includes(key))) return null;
    const copy = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      copy.push(descriptor.value);
    }
    return copy;
  } catch { return null; }
}

function freeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freeze(child, seen);
  return Object.freeze(value);
}

function same(left, right) {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) !== Array.isArray(right)) return false;
  const leftKeys = Reflect.ownKeys(left); const rightKeys = Reflect.ownKeys(right);
  return leftKeys.length === rightKeys.length && leftKeys.every(key => rightKeys.includes(key) && same(left[key], right[key]));
}

function categories(value, { allowEmpty = false, preserveOrder = false } = {}) {
  const parsed = dense(value);
  if (!parsed || !allowEmpty && parsed.length === 0 || parsed.some(item => !CATEGORIES.includes(item)) || new Set(parsed).size !== parsed.length) return null;
  return freeze(preserveOrder ? [...parsed] : CATEGORIES.filter(item => parsed.includes(item)));
}

function source(value) {
  const attached = exact(value, ['kind']);
  if (attached?.kind === 'attached') return freeze(attached);
  const owned = exact(value, ['kind', 'ownershipId', 'cleanupMode', 'pageId']);
  if (!owned || owned.kind !== 'owned-disposable' || !validOpaque(owned.ownershipId) || !['always', 'pre-observation-failure'].includes(owned.cleanupMode) || owned.pageId !== null && !validOpaque(owned.pageId)) return null;
  return freeze(owned);
}

function observedTarget(value) {
  const attached = exact(value, ['version', 'kind', 'tabId', 'windowId', 'documentId', 'urlEvidence', 'urlSessionDigest']);
  const owned = exact(value, ['version', 'kind', 'ownershipId', 'tabId', 'windowId', 'documentId', 'urlEvidence', 'urlSessionDigest', 'cleanupMode', 'pageId']);
  const parsed = attached?.kind === 'attached' ? attached : owned?.kind === 'owned-disposable' ? owned : null;
  if (!parsed || parsed.version !== 'ObservedTargetV1' || !validPositive(parsed.tabId) || !validPositive(parsed.windowId) || !validOpaque(parsed.documentId) || !isEvidenceUrlV1(parsed.urlEvidence) || !validDigest(parsed.urlSessionDigest)) return null;
  const parsedSource = parsed.kind === 'attached' ? source({ kind: 'attached' }) : source({ kind: 'owned-disposable', ownershipId: parsed.ownershipId, cleanupMode: parsed.cleanupMode, pageId: parsed.pageId });
  return parsedSource ? freeze({ ...parsed, source: parsedSource }) : null;
}

function proof(value) {
  const attached = exact(value, ['kind', 'tabId', 'windowId', 'documentId', 'urlSessionDigest']);
  const owned = exact(value, ['kind', 'ownershipId', 'tabId', 'windowId', 'documentId', 'urlSessionDigest', 'cleanupMode', 'pageId']);
  const parsed = attached?.kind === 'attached' ? attached : owned?.kind === 'owned-disposable' ? owned : null;
  if (!parsed || !validPositive(parsed.tabId) || !validPositive(parsed.windowId) || !validOpaque(parsed.documentId) || !validDigest(parsed.urlSessionDigest)) return null;
  const parsedSource = parsed.kind === 'attached' ? source({ kind: 'attached' }) : source({ kind: 'owned-disposable', ownershipId: parsed.ownershipId, cleanupMode: parsed.cleanupMode, pageId: parsed.pageId });
  return parsedSource ? freeze({ ...parsed, source: parsedSource }) : null;
}

function parseJournal(value) {
  const journal = exact(value, JOURNAL_KEYS);
  const parsedCategories = journal && categories(journal.categories, { allowEmpty: true });
  const parsedSource = journal && source(journal.source);
  if (!journal || !parsedCategories || journal.version !== 'PixelCaptureJournalV1' || !validPositive(journal.revision) || !validAuditId(journal.auditId) || !validConsentId(journal.consentId) || !validPositive(journal.tabId) || !validPositive(journal.windowId) || !validOpaque(journal.documentId) || !MODES.has(journal.mode) || !validPolicy(journal.capturePolicy) || journal.capturePolicy.mode !== journal.mode || !validEpoch(journal.issuedAt) || !validEpoch(journal.updatedAt) || !validEpoch(journal.expiresAt) || journal.updatedAt < journal.issuedAt || journal.expiresAt <= journal.issuedAt || journal.expiresAt - journal.issuedAt > TTL_MS || !isEvidenceUrlV1(journal.urlEvidence) || journal.urlEvidence.queryIncluded && !journal.capturePolicy.includeQuery || !validDigest(journal.urlSessionDigest) || !parsedSource || !['paused', 'resuming', 'revoked', 'finished'].includes(journal.state)) return null;
  if (journal.state === 'resuming' && !['consent-claimed', 'session-running', 'runner-started'].includes(journal.resumePhase) || journal.state !== 'resuming' && journal.resumePhase !== null || journal.state === 'revoked' && !REASONS.has(journal.revokeReason) || journal.state !== 'revoked' && journal.revokeReason !== null) return null;
  if (!Number.isSafeInteger(journal.cleanupAttempts) || journal.cleanupAttempts < 0 || journal.state === 'paused' || journal.state === 'resuming' ? journal.cleanupAttempts !== 0 || journal.cleanupNotBefore !== null : !validEpoch(journal.cleanupNotBefore)) return null;
  return freeze({ ...journal, categories: parsedCategories, source: parsedSource });
}

function stateFor(sessionArea) {
  let state = STATES.get(sessionArea);
  if (!state) { state = { tail: Promise.resolve(), highWater: null }; STATES.set(sessionArea, state); }
  return state;
}

function token(randomBytes) {
  let bytes;
  try { bytes = randomBytes(16); } catch { throw unavailable(); }
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 16) throw unavailable();
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

function suspension(journal) {
  return freeze({ version: 'AuditSuspensionV1', revision: journal.revision, auditId: journal.auditId, consentId: journal.consentId, tabId: journal.tabId, windowId: journal.windowId, documentId: journal.documentId, urlEvidence: journal.urlEvidence, urlSessionDigest: journal.urlSessionDigest, mode: journal.mode, capturePolicy: journal.capturePolicy, categories: [...journal.categories], issuedAt: journal.issuedAt, updatedAt: journal.updatedAt, expiresAt: journal.expiresAt, cleanupAttempts: journal.cleanupAttempts, cleanupNotBefore: journal.cleanupNotBefore, state: journal.state, resumePhase: journal.resumePhase, revokeReason: journal.revokeReason, source: journal.source });
}

function makeClaim(journal, claimedAt) {
  return freeze({ version: 'PixelCaptureClaimV1', auditId: journal.auditId, consentId: journal.consentId, tabId: journal.tabId, windowId: journal.windowId, documentId: journal.documentId, mode: journal.mode, categories: [...journal.categories], urlSessionDigest: journal.urlSessionDigest, expiresAt: journal.expiresAt, source: journal.source, claimedAt });
}

export function createPixelCaptureStateV1({ sessionArea, now, randomBytes }) {
  if (!sessionArea || typeof sessionArea.get !== 'function' || typeof sessionArea.set !== 'function' || typeof sessionArea.remove !== 'function' || typeof now !== 'function' || typeof randomBytes !== 'function') throw unavailable();
  const shared = stateFor(sessionArea);
  const serial = operation => {
    const result = shared.tail.then(operation, operation);
    shared.tail = result.catch(() => {});
    return result;
  };
  const at = () => {
    let value;
    try { value = now(); } catch { throw unavailable(); }
    if (!validEpoch(value) || shared.highWater !== null && value < shared.highWater) throw unavailable();
    shared.highWater = value;
    return value;
  };
  const key = auditId => `${PREFIX}${auditId}`;
  const read = async auditId => {
    let value;
    try { value = (await sessionArea.get(key(auditId)))?.[key(auditId)]; } catch { throw unavailable(); }
    if (value === undefined) return null;
    const parsed = parseJournal(value);
    if (!parsed || parsed.auditId !== auditId) throw unavailable();
    return parsed;
  };
  const write = async journal => {
    try { await sessionArea.set({ [key(journal.auditId)]: journal }); } catch { /* confirmed read-back decides */ }
    const confirmed = await read(journal.auditId);
    if (!confirmed || !same(confirmed, journal)) throw unavailable();
  };
  const erase = async auditId => {
    try { await sessionArea.remove(key(auditId)); } catch { /* confirmed read-back decides */ }
    let result;
    try { result = await sessionArea.get(key(auditId)); } catch { throw unavailable(); }
    if (result?.[key(auditId)] !== undefined) throw unavailable();
  };
  const all = async () => {
    let values;
    try { values = await sessionArea.get(null); } catch { throw unavailable(); }
    if (!values || typeof values !== 'object' || Array.isArray(values)) throw unavailable();
    let keys;
    try { keys = Reflect.ownKeys(values); } catch { throw unavailable(); }
    const output = [];
    for (const item of keys) {
      if (typeof item !== 'string' || !item.startsWith(PREFIX)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(values, item);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw unavailable();
      const record = parseJournal(descriptor.value);
      if (!record || item !== key(record.auditId)) throw unavailable();
      output.push(record);
    }
    return output;
  };
  const recovery = async request => {
    const input = exact(request, ['limit', 'includeResuming']);
    const currentAt = at();
    if (!input || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 25 || typeof input.includeResuming !== 'boolean') throw unavailable();
    let values;
    try { values = await sessionArea.get(null); } catch { throw unavailable(); }
    if (!values || typeof values !== 'object' || Array.isArray(values)) throw unavailable();
    const records = []; let unavailableCount = 0; let blockingCount = 0;
    for (const item of Reflect.ownKeys(values)) {
      if (typeof item !== 'string' || !item.startsWith(PREFIX)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(values, item);
      const record = descriptor && Object.hasOwn(descriptor, 'value') ? parseJournal(descriptor.value) : null;
      if (!record || item !== key(record.auditId)) { unavailableCount += 1; continue; }
      if (record.state === 'resuming' || record.state === 'revoked' && record.revokeReason === 'PIXEL_RESUME_INTERRUPTED') blockingCount += 1;
      if (input.includeResuming && record.state === 'resuming') records.push(record);
      else if (record.state === 'paused' && record.expiresAt <= currentAt || ['revoked', 'finished'].includes(record.state) && record.cleanupNotBefore <= currentAt) records.push(record);
    }
    const priority = { resuming: 0, paused: 1, revoked: 1, finished: 1 };
    const due = record => record.state === 'paused' ? record.expiresAt : record.cleanupNotBefore;
    records.sort((left, right) => priority[left.state] - priority[right.state] || due(left) - due(right) || left.auditId.localeCompare(right.auditId));
    return freeze({ version: 'PixelRecoveryScanV1', candidates: freeze(records.slice(0, input.limit).map(suspension)), unavailableCount, blockingCount });
  };

  return Object.freeze({
    pause: request => serial(async () => {
      const input = exact(request, ['auditId', 'observedTarget', 'mode', 'capturePolicy', 'categories', 'authorityExpiresAt']);
      const target = input && observedTarget(input.observedTarget);
      const sensitive = input && categories(input.categories);
      const issuedAt = at();
      if (!input || !validAuditId(input.auditId) || !target || !MODES.has(input.mode) || !validPolicy(input.capturePolicy) || input.capturePolicy.mode !== input.mode || !sensitive || !validEpoch(input.authorityExpiresAt) || input.authorityExpiresAt <= issuedAt) throw unavailable();
      if (await read(input.auditId)) throw error('PIXEL_CONSENT_EXISTS');
      const journal = freeze({ version: 'PixelCaptureJournalV1', revision: 1, auditId: input.auditId, consentId: token(randomBytes), tabId: target.tabId, windowId: target.windowId, documentId: target.documentId, mode: input.mode, capturePolicy: input.capturePolicy, categories: sensitive, issuedAt, updatedAt: issuedAt, expiresAt: Math.min(input.authorityExpiresAt, issuedAt + TTL_MS), cleanupAttempts: 0, cleanupNotBefore: null, state: 'paused', resumePhase: null, revokeReason: null, urlEvidence: target.urlEvidence, urlSessionDigest: target.urlSessionDigest, source: target.source });
      await write(journal);
      return suspension(journal);
    }),
    claimAndBeginResume: request => serial(async () => {
      const input = exact(request, ['auditId', 'consentId', 'proof', 'mode', 'categories']);
      const currentProof = input && proof(input.proof);
      const currentCategories = input && categories(input.categories, { allowEmpty: true, preserveOrder: true });
      const claimedAt = at();
      if (!input || !validAuditId(input.auditId) || !validConsentId(input.consentId) || !currentProof || !MODES.has(input.mode) || !currentCategories) throw unavailable();
      const current = await read(input.auditId);
      if (!current) throw error('PIXEL_CONSENT_MISSING');
      if (current.consentId !== input.consentId) throw error('PIXEL_CONSENT_STALE');
      if (current.state !== 'paused') throw error('PIXEL_CONSENT_ALREADY_USED');
      if (claimedAt >= current.expiresAt) throw error('PIXEL_CONSENT_EXPIRED');
      if (current.mode !== input.mode || current.tabId !== currentProof.tabId || current.windowId !== currentProof.windowId || current.documentId !== currentProof.documentId || current.urlSessionDigest !== currentProof.urlSessionDigest || !same(current.source, currentProof.source)) {
        const revoked = freeze({ ...current, revision: current.revision + 1, updatedAt: claimedAt, cleanupAttempts: 0, cleanupNotBefore: claimedAt, state: 'revoked', resumePhase: null, revokeReason: 'PIXEL_CONSENT_DOCUMENT_CHANGED' });
        await write(revoked);
        throw error('PIXEL_CONSENT_DOCUMENT_CHANGED');
      }
      if (!same(current.categories, currentCategories)) {
        const rotated = freeze({ ...current, revision: current.revision + 1, consentId: token(randomBytes), categories: categories(currentCategories, { allowEmpty: true }), updatedAt: claimedAt });
        await write(rotated);
        throw error('PIXEL_CONSENT_SIGNALS_CHANGED');
      }
      const updated = freeze({ ...current, revision: current.revision + 1, updatedAt: claimedAt, state: 'resuming', resumePhase: 'consent-claimed' });
      await write(updated);
      return makeClaim(updated, claimedAt);
    }),
    markSessionRunning: request => serial(async () => {
      const input = exact(request, ['auditId', 'consentId']);
      const updatedAt = at();
      if (!input || !validAuditId(input.auditId) || !validConsentId(input.consentId)) throw error('PIXEL_RESUME_TRANSITION_INVALID');
      const current = await read(input.auditId);
      if (!current || current.consentId !== input.consentId || current.state !== 'resuming' || current.resumePhase !== 'consent-claimed') throw error('PIXEL_RESUME_TRANSITION_INVALID');
      if (updatedAt >= current.expiresAt) throw error('PIXEL_CONSENT_EXPIRED');
      const updated = freeze({ ...current, revision: current.revision + 1, updatedAt, resumePhase: 'session-running' });
      await write(updated);
      return suspension(updated);
    }),
    gateRunnerStart: request => serial(async () => {
      const input = exact(request, ['auditId', 'consentId', 'proof', 'categories']);
      const currentProof = input && proof(input.proof);
      const currentCategories = input && categories(input.categories, { allowEmpty: true, preserveOrder: true });
      const updatedAt = at();
      if (!input || !validAuditId(input.auditId) || !validConsentId(input.consentId) || !currentProof || !currentCategories) throw error('PIXEL_RESUME_TRANSITION_INVALID');
      const current = await read(input.auditId);
      if (!current || current.consentId !== input.consentId || current.state !== 'resuming' || current.resumePhase !== 'session-running') throw error('PIXEL_RESUME_TRANSITION_INVALID');
      if (updatedAt >= current.expiresAt) throw error('PIXEL_CONSENT_EXPIRED');
      if (current.tabId !== currentProof.tabId || current.windowId !== currentProof.windowId || current.documentId !== currentProof.documentId || current.urlSessionDigest !== currentProof.urlSessionDigest || !same(current.source, currentProof.source)) {
        const revoked = freeze({ ...current, revision: current.revision + 1, updatedAt, cleanupAttempts: 0, cleanupNotBefore: updatedAt, state: 'revoked', resumePhase: null, revokeReason: 'PIXEL_CONSENT_DOCUMENT_CHANGED' });
        await write(revoked);
        throw error('PIXEL_CONSENT_DOCUMENT_CHANGED');
      }
      if (same(current.categories, currentCategories)) {
        const updated = freeze({ ...current, revision: current.revision + 1, updatedAt, resumePhase: 'runner-started' });
        await write(updated);
        return freeze({ version: 'PixelRunnerGateResultV1', status: 'ready', suspension: suspension(updated) });
      }
      const updated = freeze({ ...current, revision: current.revision + 1, consentId: token(randomBytes), categories: categories(currentCategories, { allowEmpty: true }), updatedAt, cleanupAttempts: 0, cleanupNotBefore: null, state: 'paused', resumePhase: null, revokeReason: null });
      await write(updated);
      return freeze({ version: 'PixelRunnerGateResultV1', status: 'repaused', suspension: suspension(updated) });
    }),
    readSuspension: auditId => serial(async () => {
      at();
      if (!validAuditId(auditId)) throw unavailable();
      const current = await read(auditId);
      return current ? suspension(current) : null;
    }),
    listSuspensions: request => serial(async () => {
      at();
      const input = exact(request, ['limit']);
      if (!input || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 25) throw unavailable();
      let records; let unavailableCount = 0;
      try { records = await all(); } catch { unavailableCount = 1; records = []; }
      records.sort((left, right) => left.expiresAt - right.expiresAt || left.auditId.localeCompare(right.auditId));
      return freeze({ version: 'PixelSuspensionScanV1', suspensions: freeze(records.slice(0, input.limit).map(suspension)), unavailableCount });
    }),
    listRecoveryCandidates: request => serial(async () => recovery(request)),
    nextExpiresAt: () => serial(async () => {
      at();
      const deadlines = (await all()).map(record => record.state === 'paused' ? record.expiresAt : ['revoked', 'finished'].includes(record.state) ? record.cleanupNotBefore : null).filter(value => value !== null);
      return deadlines.length === 0 ? null : Math.min(...deadlines);
    }),
    revokeAudit: request => serial(async () => {
      const updatedAt = at();
      const input = exact(request, ['auditId', 'consentId', 'reason']);
      if (!input || !validAuditId(input.auditId) || !validConsentId(input.consentId) || !REASONS.has(input.reason)) throw unavailable();
      const current = await read(input.auditId);
      if (!current) return freeze({ version: 'PixelRevokeResultV1', status: 'missing', suspension: null });
      if (current.consentId !== input.consentId) return freeze({ version: 'PixelRevokeResultV1', status: 'mismatch', suspension: null });
      if (current.state === 'finished') return freeze({ version: 'PixelRevokeResultV1', status: 'finished', suspension: suspension(current) });
      if (current.state === 'revoked') return freeze({ version: 'PixelRevokeResultV1', status: 'already-revoked', suspension: suspension(current) });
      const updated = freeze({ ...current, revision: current.revision + 1, updatedAt, cleanupAttempts: 0, cleanupNotBefore: updatedAt, state: 'revoked', resumePhase: null, revokeReason: input.reason });
      await write(updated);
      return freeze({ version: 'PixelRevokeResultV1', status: 'revoked', suspension: suspension(updated) });
    }),
    deferCleanup: request => serial(async () => {
      const input = exact(request, ['auditId', 'consentId', 'expectedRevision']);
      const updatedAt = at();
      if (!input || !validAuditId(input.auditId) || !validConsentId(input.consentId) || !validPositive(input.expectedRevision)) throw unavailable();
      const current = await read(input.auditId);
      if (!current || current.consentId !== input.consentId || current.revision !== input.expectedRevision || !['revoked', 'finished'].includes(current.state)) return null;
      const attempts = current.cleanupAttempts + 1;
      const delay = Math.min(600_000, 60_000 * (2 ** (attempts - 1)));
      const updated = freeze({ ...current, revision: current.revision + 1, updatedAt, cleanupAttempts: attempts, cleanupNotBefore: updatedAt + delay });
      await write(updated);
      return suspension(updated);
    }),
    finish: request => serial(async () => {
      const input = exact(request, ['auditId', 'consentId']);
      at();
      if (!input || !validAuditId(input.auditId) || !validConsentId(input.consentId)) throw unavailable();
      const current = await read(input.auditId);
      if (!current || current.consentId !== input.consentId) return false;
      if (current.state !== 'finished') {
        if (!(current.state === 'revoked' || current.state === 'resuming' && current.resumePhase === 'runner-started')) return false;
        const terminalAt = at();
        const terminal = freeze({ ...current, revision: current.revision + 1, updatedAt: terminalAt, cleanupAttempts: 0, cleanupNotBefore: terminalAt, state: 'finished', resumePhase: null, revokeReason: null });
        await write(terminal);
      }
      await erase(input.auditId);
      return true;
    }),
  });
}
