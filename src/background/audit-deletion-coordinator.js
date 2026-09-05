import { canonicalAuditId, canonicalRetentionInstant, validateDeletionTombstoneV1 } from '../storage/audit-retention.js';

const SHARED = new WeakMap();
const DENIED = Object.freeze({ status: 'denied', code: 'AUDIT_DELETION_DENIED' });
const DEPENDENCIES = Object.freeze({
  store: ['stageAuditDeletionV1', 'listDeletionTombstonesV1', 'recordDeletionCleanupFailureV1', 'completeAuditDeletionV1'],
  authority: ['clearAudit', 'finalizeAudit'], panelPortRegistry: ['clearAudit'], reportPortRegistry: ['clearAudit'],
  highlightController: ['clearAudit'], highlightBindingStore: ['deleteAudit'],
  reportLaunch: ['clearAudit'], exportLaunch: ['clearAudit'], rawNavigationVault: ['clearAudit'],
  pixelCaptureState: ['readSuspension', 'revokeAudit', 'finish'],
  ownedDisposableTabStore: ['clearAudit', 'purgeRemovedAudit'], blobRegistry: ['clearAudit'],
});
const REQUEST_KEYS = ['auditId', 'reason', 'expectedRevision', 'terminalReceipt', 'manualAuthorization'];
const SUSPENSION_KEYS = ['version', 'revision', 'auditId', 'consentId', 'tabId', 'windowId', 'documentId',
  'urlEvidence', 'urlSessionDigest', 'mode', 'capturePolicy', 'categories', 'issuedAt', 'updatedAt',
  'expiresAt', 'cleanupAttempts', 'cleanupNotBefore', 'state', 'resumePhase', 'revokeReason', 'source'];
const OPAQUE = /^[A-Za-z0-9._:-]{1,160}$/u;
const CONSENT = /^[A-Za-z0-9_-]{21}[AQgw]$/u;
const DIGEST = /^hmac-sha256:[A-Za-z0-9_-]{43}$/u;

function unavailable() { return new Error('AUDIT_DELETION_UNAVAILABLE'); }
function count(value) { return Number.isSafeInteger(value) && value >= 0; }
function own(value, key) {
  const descriptor = value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, key) : null;
  if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw unavailable();
  return descriptor.value;
}
function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw unavailable();
  const present = Reflect.ownKeys(value);
  if (present.length !== keys.length || present.some(key => !keys.includes(key))) throw unavailable();
  return Object.fromEntries(keys.map(key => [key, own(value, key)]));
}
function dense(value, maximum) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw unavailable();
  const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
  if (!count(length) || length > maximum || Reflect.ownKeys(value).length !== length + 1) throw unavailable();
  return Array.from({ length }, (_unused, index) => own(value, String(index)));
}
function requireConfirmation(confirmed) { if (!confirmed) throw unavailable(); }

function pixelSuspension(value, auditId) {
  const record = exact(value, SUSPENSION_KEYS);
  // The pixel state validates its journal; this boundary retains only cleanup identity and acknowledgement state.
  requireConfirmation(record.version === 'AuditSuspensionV1' && record.auditId === auditId &&
    count(record.revision) && record.revision > 0 && typeof record.consentId === 'string' && CONSENT.test(record.consentId) &&
    count(record.tabId) && count(record.windowId) && typeof record.documentId === 'string' && OPAQUE.test(record.documentId) &&
    typeof record.urlSessionDigest === 'string' && DIGEST.test(record.urlSessionDigest) &&
    count(record.updatedAt) &&
    ['paused', 'resuming', 'revoked', 'finished'].includes(record.state));
  return Object.freeze({ auditId: record.auditId, consentId: record.consentId, tabId: record.tabId,
    windowId: record.windowId, documentId: record.documentId, urlSessionDigest: record.urlSessionDigest,
    revision: record.revision, updatedAt: record.updatedAt, state: record.state, revokeReason: record.revokeReason });
}

function confirmedRevocation(value, previous) {
  const result = exact(value, ['version', 'status', 'suspension']);
  requireConfirmation(result.version === 'PixelRevokeResultV1');
  if (result.status === 'missing') return result.suspension === null;
  if (!['revoked', 'already-revoked', 'finished'].includes(result.status)) return false;
  const current = pixelSuspension(result.suspension, previous.auditId);
  const immutable = ['auditId', 'consentId', 'tabId', 'windowId', 'documentId', 'urlSessionDigest'];
  if (!immutable.every(key => current[key] === previous[key]) ||
    current.revision < previous.revision || current.updatedAt < previous.updatedAt) return false;
  if (result.status === 'finished') return current.state === 'finished';
  return current.state === 'revoked' && (result.status === 'already-revoked' ||
    current.revokeReason === 'AUDIT_DELETED' && current.revision > previous.revision);
}

function samePixelIdentity(left, right) {
  return left && right && ['auditId', 'consentId', 'tabId', 'windowId', 'documentId', 'urlSessionDigest']
    .every(key => left[key] === right[key]);
}

export function createAuditDeletionCoordinatorV1(raw) {
  let input; const calls = {};
  try {
    input = exact(raw, [...Object.keys(DEPENDENCIES), 'now']);
    requireConfirmation(typeof input.now === 'function');
    for (const [name, methods] of Object.entries(DEPENDENCIES)) {
      const dependency = input[name]; calls[name] = {};
      for (const method of methods) {
        const captured = own(dependency, method);
        requireConfirmation(typeof captured === 'function');
        calls[name][method] = (...args) => Reflect.apply(captured, dependency, args);
      }
    }
  } catch { throw unavailable(); }
  const now = input.now;
  let shared = SHARED.get(input.store);
  if (!shared) { shared = { tails: new Map(), scans: new Set() }; SHARED.set(input.store, shared); }

  function withAudit(auditId, operation) {
    const result = (shared.tails.get(auditId) ?? Promise.resolve()).then(operation);
    const tail = result.catch(() => {});
    shared.tails.set(auditId, tail);
    void tail.then(() => { if (shared.tails.get(auditId) === tail) shared.tails.delete(auditId); });
    return result.catch(() => { throw unavailable(); });
  }

  async function cleanup(tombstone, at) {
    const { auditId } = tombstone;
    try {
      const authority = exact(await calls.authority.clearAudit(auditId), ['ok', 'invalidated']);
      requireConfirmation(authority.ok === true && count(authority.invalidated));
      requireConfirmation(await calls.panelPortRegistry.clearAudit(auditId) === true);
      requireConfirmation(count(await calls.reportPortRegistry.clearAudit(auditId)));
      const overlay = exact(await calls.highlightController.clearAudit(auditId, 'audit-deleted'), ['ok', 'state']);
      requireConfirmation(overlay.ok === true && overlay.state === 'clear');
      requireConfirmation(typeof await calls.highlightBindingStore.deleteAudit(auditId) === 'boolean');
      requireConfirmation(count(await calls.rawNavigationVault.clearAudit(auditId)));
      const suspension = await calls.pixelCaptureState.readSuspension(auditId);
      const candidate = suspension === null ? null : pixelSuspension(suspension, auditId);
      if (suspension !== null) {
        const result = await calls.pixelCaptureState.revokeAudit({ auditId, consentId: candidate.consentId, reason: 'AUDIT_DELETED' });
        requireConfirmation(confirmedRevocation(result, candidate));
      }
      requireConfirmation(count(await calls.blobRegistry.clearAudit(auditId)));
      requireConfirmation(await calls.exportLaunch.clearAudit(auditId) === true);
      requireConfirmation(await calls.reportLaunch.clearAudit(auditId) === true);
      requireConfirmation(count(await calls.ownedDisposableTabStore.clearAudit(auditId)));
      // Keep cleanup identity until all dependent resources have been closed.
      const remaining = await calls.pixelCaptureState.readSuspension(auditId);
      if (remaining !== null) {
        const terminal = pixelSuspension(remaining, auditId);
        requireConfirmation(samePixelIdentity(candidate, terminal) && ['revoked', 'finished'].includes(terminal.state));
        requireConfirmation(await calls.pixelCaptureState.finish({ auditId, consentId: terminal.consentId }) === true);
      }
      requireConfirmation(count(await calls.ownedDisposableTabStore.purgeRemovedAudit(auditId)));
      const finalAuthority = exact(await calls.authority.finalizeAudit(auditId), ['ok', 'purged']);
      requireConfirmation(finalAuthority.ok === true && count(finalAuthority.purged));
      requireConfirmation(typeof await calls.store.completeAuditDeletionV1({ auditId }) === 'boolean');
      // A list already in flight may still return this completed tombstone.
      for (const scan of shared.scans) scan.add(auditId);
      return Object.freeze({ status: 'complete', auditId });
    } catch {
      requireConfirmation(await calls.store.recordDeletionCleanupFailureV1({ auditId, at }) === true);
      return Object.freeze({ status: 'pending', auditId });
    }
  }

  async function request(value) {
    let request;
    try {
      request = exact(value, REQUEST_KEYS);
      canonicalAuditId(request.auditId);
      requireConfirmation(request.reason === 'retention-expired' && request.expectedRevision === null &&
        request.terminalReceipt === null && request.manualAuthorization === null);
    } catch { return DENIED; }
    return withAudit(request.auditId, async () => {
      const at = canonicalRetentionInstant(now()).iso;
      const result = await calls.store.stageAuditDeletionV1({ auditId: request.auditId, reason: request.reason, now: at,
        expectedRevision: null, terminalReceipt: null });
      if (own(result, 'status') === 'denied') {
        const denied = exact(result, ['status', 'code']);
        requireConfirmation(denied.code === DENIED.code);
        return DENIED;
      }
      const staged = exact(result, ['status', 'tombstone']);
      requireConfirmation(staged.status === 'staged');
      const tombstone = validateDeletionTombstoneV1(staged.tombstone, request.auditId);
      return cleanup(tombstone, at);
    });
  }

  async function resumePending(value) {
    const completedDuringScan = new Set();
    try {
      const { limit } = exact(value, ['limit']);
      requireConfirmation(Number.isSafeInteger(limit) && limit >= 1 && limit <= 25);
      shared.scans.add(completedDuringScan);
      const tombstones = dense(await calls.store.listDeletionTombstonesV1({ limit }), limit)
        .map(value => validateDeletionTombstoneV1(value));
      requireConfirmation(new Set(tombstones.map(value => value.auditId)).size === tombstones.length);
      let failed = false;
      for (const tombstone of tombstones) {
        try {
          await withAudit(tombstone.auditId, async () => {
            if (completedDuringScan.has(tombstone.auditId)) return;
            const at = canonicalRetentionInstant(now()).iso;
            await cleanup(tombstone, at);
          });
        } catch { failed = true; }
      }
      requireConfirmation(!failed);
    } catch { throw unavailable(); }
    finally { shared.scans.delete(completedDuringScan); }
  }

  return Object.freeze({ request, resumePending });
}
