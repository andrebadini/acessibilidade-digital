import { copyPanelResultBundleV1 } from '../panel/panel-result-bundle.js';
import { isCapturePolicyV1 } from '../core/privacy/capture-policy.js';
import { isEvidenceUrlV1 } from '../core/privacy/evidence-url.js';
import { canonicalAuditId } from '../storage/audit-retention.js';
import { capturedUtf8Length, parsePanelPortIntent } from './worker-protocol.js';
import { parseStorageGetEnvelope } from './storage-get-envelope.js';

export const PANEL_PORT_NAME = 'audita-panel-v1';
export const panelBootstrapStorageKey = windowId => `audita:panel-bootstrap:v1:${windowId}`;

const FACTORY_KEYS = Object.freeze([
  'chromeApi', 'sessionArea', 'readActiveJob', 'readAuditSession', 'readPixelSuspension', 'loadPanelResultBundle',
  'rehydrateViewOnly', 'revokeViewOnly', 'epochNow', 'setTimer', 'clearTimer',
  'launchAuthority', 'dispatchPanelIntent', 'authorizeHighlightSession',
]);
const BOOTSTRAP_KEYS = Object.freeze([
  'version', 'kind', 'auditId', 'sessionCapabilityId', 'windowId', 'createdAt', 'expiresAt', 'state',
]);
const CAPTURE_BOOTSTRAP_KEYS = Object.freeze([...BOOTSTRAP_KEYS, 'captureMode']);
const SESSION_KEYS = Object.freeze([
  'version', 'sessionCapabilityId', 'auditId', 'windowId', 'mode', 'targetBinding', 'state', 'issuedAt', 'expiresAt',
]);
const ACTIVE_KEYS = Object.freeze([
  'version', 'auditId', 'capabilityId', 'sessionCapabilityId', 'windowId', 'mode',
  'state', 'commitState', 'expectedTerminalRevision', 'createdAt', 'updatedAt',
]);
const SUSPENSION_KEYS = Object.freeze([
  'version', 'revision', 'auditId', 'consentId', 'tabId', 'windowId', 'documentId',
  'urlEvidence', 'urlSessionDigest', 'mode', 'capturePolicy', 'categories',
  'issuedAt', 'updatedAt', 'expiresAt', 'cleanupAttempts', 'cleanupNotBefore',
  'state', 'resumePhase', 'revokeReason', 'source',
]);
const CAPTURE_POLICY_KEYS = Object.freeze([
  'version', 'mode', 'includeQuery', 'captureFullPage', 'captureElements', 'composeAnnouncementMap',
]);
const EVIDENCE_URL_KEYS = Object.freeze(['version', 'href', 'queryIncluded', 'redactedSegments']);
const AUDIT_ID = /^[A-Za-z0-9._:-]{1,160}$/u;
const BATCH_PAGE_ID = /^page-([1-9]|1[0-9]|20)$/u;
const OCCURRENCE_ID = /^[A-Za-z0-9._:-]{1,200}$/u;
const CAPABILITY = /^[A-Za-z0-9_-]{22}$/u;
const DIGEST = /^hmac-sha256:[A-Za-z0-9_-]{43}$/u;
const CONSENT_ID = /^[A-Za-z0-9_-]{21}[AQgw]$/u;
const CAPTURE_MODES = new Set(['full-evidence', 'element-only', 'no-pixels']);
const PIXEL_MODES = new Set(['full-evidence', 'element-only']);
const SENSITIVE_CATEGORIES = Object.freeze(['password', 'otp', 'payment', 'private-marker']);
const PRIVACY_PAUSE_MESSAGE = 'A página contém conteúdo potencialmente sensível. Confirme para capturar imagens visíveis.';
const START_JOURNAL_KEY = 'audita:start-journal:v1';
const HIGHLIGHT_INTENT_TYPES = new Set([
  'GET_HIGHLIGHT_AVAILABILITY', 'HIGHLIGHT_OCCURRENCE', 'CLEAR_HIGHLIGHT',
]);
const PAGE_MARKERS_INTENT_TYPES = new Set([
  'PANEL_SHOW_PAGE_MARKERS', 'PANEL_HIDE_PAGE_MARKERS', 'PANEL_SELECT_PAGE_MARKER', 'PANEL_FILTER_PAGE_MARKERS',
]);
const AUTHORIZED_SESSION_KEYS = Object.freeze([
  'version', 'sessionCapabilityId', 'auditId', 'windowId', 'mode', 'targetBinding',
  'consumers', 'intents', 'state', 'issuedAt', 'expiresAt',
]);
const TERMINAL_DELIVERY_KEYS = Object.freeze(['version', 'state']);
const LAUNCH_RETIREMENT_KEYS = Object.freeze(['version', 'state']);
const terminalDeliveries = new WeakSet();

function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function exact(value, keys, allowNullPrototype = false) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && (!allowNullPrototype || prototype !== null)) return null;
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

function terminalDelivery(state) {
  const receipt = Object.freeze({ version: 1, state });
  terminalDeliveries.add(receipt);
  return receipt;
}

function launchRetirementState(value) {
  const receipt = exact(value, LAUNCH_RETIREMENT_KEYS);
  return receipt?.version === 1 && ['released', 'revoked', 'denied'].includes(receipt.state)
    ? receipt.state
    : 'denied';
}

export function isTerminalDeliveryV1(value) {
  if (!value || typeof value !== 'object' || !terminalDeliveries.has(value)) return false;
  const receipt = exact(value, TERMINAL_DELIVERY_KEYS);
  return Boolean(receipt?.version === 1 && ['delivered', 'deferred', 'denied'].includes(receipt.state));
}

function own(value, key) {
  try {
    const descriptor = value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, key) : null;
    return descriptor?.enumerable && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  } catch { return undefined; }
}

function optionalOwn(value, key) {
  try {
    if (!value || typeof value !== 'object') return { found: false, invalid: true };
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) return { found: false, invalid: false };
    return descriptor.enumerable && Object.hasOwn(descriptor, 'value')
      ? { found: true, invalid: false, value: descriptor.value }
      : { found: true, invalid: true };
  } catch { return { found: true, invalid: true }; }
}

function safeChromeId(value) { return Number.isSafeInteger(value) && value >= 0; }
function safeEpoch(value) { return Number.isSafeInteger(value) && value >= 0; }

function same(left, right) {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) !== Array.isArray(right)) return false;
  const leftKeys = Reflect.ownKeys(left);
  const rightKeys = Reflect.ownKeys(right);
  return leftKeys.length === rightKeys.length && leftKeys.every(key => rightKeys.includes(key) && same(left[key], right[key]));
}

function parseBootstrap(value) {
  const captureRecord = exact(value, CAPTURE_BOOTSTRAP_KEYS, true);
  const record = captureRecord ?? exact(value, BOOTSTRAP_KEYS, true);
  return record && record.version === 1 && record.kind === 'audit-session' && AUDIT_ID.test(record.auditId ?? '') &&
    CAPABILITY.test(record.sessionCapabilityId ?? '') && safeChromeId(record.windowId) && safeEpoch(record.createdAt) &&
    safeEpoch(record.expiresAt) && record.expiresAt > record.createdAt && ['pending', 'consumed'].includes(record.state)
    && (!captureRecord || CAPTURE_MODES.has(record.captureMode))
    ? freeze(record) : null;
}

function parseSession(value) {
  const record = exact(value, SESSION_KEYS, true);
  if (!record || record.version !== 1 || !CAPABILITY.test(record.sessionCapabilityId ?? '') ||
    !AUDIT_ID.test(record.auditId ?? '') || !safeChromeId(record.windowId) || !['attached', 'single', 'batch'].includes(record.mode) ||
    !['running', 'privacy-paused', 'result', 'view-only', 'revoked'].includes(record.state) || !safeEpoch(record.issuedAt) ||
    !safeEpoch(record.expiresAt) || record.expiresAt <= record.issuedAt) return null;
  const viewOnlyBinding = exact(record.targetBinding, ['kind'], true);
  const attachedBinding = exact(record.targetBinding, ['kind', 'tabId', 'documentId', 'urlSessionDigest'], true);
  const disposableBinding = exact(record.targetBinding, ['kind', 'ownershipId', 'state'], true);
  const batchBinding = exact(record.targetBinding, ['kind', 'activePageId', 'activeOwnershipId'], true);
  const validViewOnly = record.mode === 'attached' && viewOnlyBinding?.kind === 'view-only' &&
    ['view-only', 'revoked'].includes(record.state);
  const validAttached = record.mode === 'attached' && attachedBinding?.kind === 'attached' && safeChromeId(attachedBinding.tabId) &&
    typeof attachedBinding.documentId === 'string' && attachedBinding.documentId.length > 0 &&
    attachedBinding.documentId.length <= 512 && DIGEST.test(attachedBinding.urlSessionDigest ?? '') &&
    record.state !== 'view-only';
  const validDisposable = record.mode === 'single' && disposableBinding?.kind === 'disposable' &&
    AUDIT_ID.test(disposableBinding.ownershipId ?? '') &&
    ['pending', 'observing', 'retained-for-review', 'retained-for-consent', 'cleanup-pending', 'removed']
      .includes(disposableBinding.state) && record.state !== 'view-only' &&
    (record.state !== 'privacy-paused' || disposableBinding.state === 'retained-for-consent');
  const emptyBatch = batchBinding?.activePageId === null && batchBinding?.activeOwnershipId === null;
  const activeBatch = BATCH_PAGE_ID.test(batchBinding?.activePageId ?? '') &&
    /^owner_[A-Za-z0-9_-]{22}$/u.test(batchBinding?.activeOwnershipId ?? '');
  const validBatch = record.mode === 'batch' && batchBinding?.kind === 'batch' &&
    (emptyBatch || activeBatch) && record.state !== 'view-only' &&
    (record.state !== 'privacy-paused' || activeBatch);
  if (!validViewOnly && !validAttached && !validDisposable && !validBatch) return null;
  return freeze(record);
}

function parseActive(value) {
  if (value === null) return null;
  const record = exact(value, ACTIVE_KEYS, true);
  if (!record || record.version !== 1 || !AUDIT_ID.test(record.auditId ?? '') ||
    !CAPABILITY.test(record.capabilityId ?? '') || !CAPABILITY.test(record.sessionCapabilityId ?? '') ||
    !safeChromeId(record.windowId) || !['attached', 'single', 'batch'].includes(record.mode) || !safeEpoch(record.createdAt) ||
    !safeEpoch(record.updatedAt) || record.updatedAt < record.createdAt) return undefined;
  if (record.state === 'running' && record.commitState === 'none' && record.expectedTerminalRevision === null) return freeze(record);
  if (record.state === 'privacy-paused' && record.commitState === 'none' && record.expectedTerminalRevision === null) return freeze(record);
  if (record.state === 'finalizing' && ['pending', 'confirmed'].includes(record.commitState) && record.expectedTerminalRevision === 1) return freeze(record);
  return undefined;
}

function canonicalSensitiveCategories(value) {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
    const length = Object.getOwnPropertyDescriptor(value, 'length');
    if (!length || !Object.hasOwn(length, 'value') || !Number.isSafeInteger(length.value) ||
      length.value < 1 || length.value > SENSITIVE_CATEGORIES.length) return null;
    const expected = ['length', ...Array.from({ length: length.value }, (_unused, index) => String(index))];
    const keys = Reflect.ownKeys(value);
    if (keys.length !== expected.length || expected.some(key => !keys.includes(key))) return null;
    const copy = [];
    for (let index = 0; index < length.value; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value') ||
        !SENSITIVE_CATEGORIES.includes(descriptor.value)) return null;
      copy.push(descriptor.value);
    }
    const canonical = SENSITIVE_CATEGORIES.filter(category => copy.includes(category));
    return canonical.length === copy.length && canonical.every((category, index) => category === copy[index])
      ? Object.freeze(canonical)
      : null;
  } catch {
    return null;
  }
}

function parseSuspension(value) {
  const record = exact(value, SUSPENSION_KEYS, true);
  const policy = record && exact(record.capturePolicy, CAPTURE_POLICY_KEYS, true);
  const evidence = record && exact(record.urlEvidence, EVIDENCE_URL_KEYS, true);
  const categories = record && canonicalSensitiveCategories(record.categories);
  const attachedSource = record && exact(record.source, ['kind'], true);
  const ownedSource = record && exact(record.source, ['kind', 'ownershipId', 'cleanupMode', 'pageId'], true);
  const source = attachedSource?.kind === 'attached' ? attachedSource
    : ownedSource?.kind === 'owned-disposable' && /^owner_[A-Za-z0-9_-]{22}$/u.test(ownedSource.ownershipId ?? '') &&
      ['always', 'pre-observation-failure'].includes(ownedSource.cleanupMode) && BATCH_PAGE_ID.test(ownedSource.pageId ?? '')
      ? ownedSource : null;
  if (!record || record.version !== 'AuditSuspensionV1' || !Number.isSafeInteger(record.revision) ||
    record.revision < 1 || !AUDIT_ID.test(record.auditId ?? '') || !CONSENT_ID.test(record.consentId ?? '') ||
    !safeChromeId(record.tabId) || !safeChromeId(record.windowId) ||
    typeof record.documentId !== 'string' || record.documentId.length < 1 || record.documentId.length > 512 ||
    /[\u0000-\u001F\u007F]/u.test(record.documentId) || !DIGEST.test(record.urlSessionDigest ?? '') ||
    !PIXEL_MODES.has(record.mode) || !policy || !isCapturePolicyV1(policy) || policy.mode !== record.mode ||
    !evidence || !isEvidenceUrlV1(evidence) || !categories || !source ||
    !safeEpoch(record.issuedAt) || !safeEpoch(record.updatedAt) || !safeEpoch(record.expiresAt) ||
    record.updatedAt < record.issuedAt || record.expiresAt <= record.issuedAt ||
    record.cleanupAttempts !== 0 || record.cleanupNotBefore !== null || record.state !== 'paused' ||
    record.resumePhase !== null || record.revokeReason !== null) return null;
  return freeze({
    ...record,
    capturePolicy: { ...policy },
    urlEvidence: { ...evidence },
    categories: [...categories],
    source: { ...source },
  });
}

function hello(value) {
  const record = exact(value, ['protocol', 'version', 'type']);
  return record && record.protocol === 'audita-panel' && record.version === 1 && record.type === 'bootstrap' &&
    capturedUtf8Length(record) <= 4096 ? freeze(record) : null;
}

function intentPacket(value) {
  const record = exact(value, ['protocol', 'version', 'type', 'requestId', 'envelope']);
  const byteLength = record ? capturedUtf8Length(record) : null;
  if (!record || record.protocol !== 'audita-panel' || record.version !== 1 || record.type !== 'intent' ||
    !AUDIT_ID.test(record.requestId ?? '') || byteLength === null || byteLength > 4096) return null;
  return freeze({ requestId: record.requestId, envelope: record.envelope });
}

function reviewHeartbeatPacket(value) {
  const record = exact(value, ['protocol', 'version', 'type']);
  return record?.protocol === 'audita-panel' && record.version === 1 && record.type === 'review-heartbeat'
    ? freeze(record) : null;
}

function revokedCancelResponse(value, auditId) {
  const response = exact(value, ['ok', 'auditId', 'state']);
  return response?.ok === true && response.auditId === auditId && response.state === 'revoked'
    ? freeze(response)
    : null;
}

function highlightStatePacket(value) {
  const record = exact(value, ['version', 'type', 'auditId', 'occurrenceId', 'state']);
  const byteLength = record ? capturedUtf8Length(record) : null;
  if (!record || record.version !== 1 || record.type !== 'HIGHLIGHT_STATE_CHANGED' ||
    !AUDIT_ID.test(record.auditId ?? '') || byteLength === null || byteLength > 4096) return null;
  if (record.state === 'active' && OCCURRENCE_ID.test(record.occurrenceId ?? '')) return freeze(record);
  if (record.state === 'clear' && record.occurrenceId === null) return freeze(record);
  return null;
}

function safeStringArray(value, maximum = 16) {
  try {
    if (!Array.isArray(value) || value.length > maximum) return null;
    const copy = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string') return null;
      copy.push(descriptor.value);
    }
    return Reflect.ownKeys(value).length === value.length + 1 ? copy : null;
  } catch { return null; }
}

function authorizedHighlightPublication(value, binding, actionAt) {
  const authorization = exact(value, ['ok', 'session', 'context'], true);
  const session = authorization && exact(authorization.session, AUTHORIZED_SESSION_KEYS, true);
  const attachedTarget = session && exact(session.targetBinding, ['kind', 'tabId', 'documentId', 'urlSessionDigest'], true);
  const disposableTarget = session && exact(session.targetBinding, ['kind', 'ownershipId', 'state'], true);
  const target = attachedTarget?.kind === 'attached'
    ? attachedTarget
    : disposableTarget?.kind === 'disposable' ? disposableTarget : null;
  const intents = session && exact(session.intents, ['panel', 'review'], true);
  const panelIntents = intents && (
    exact(intents.panel, ['running', 'privacy-paused', 'result', 'view-only'], true) ??
    exact(intents.panel, ['running', 'result', 'view-only'], true)
  );
  const resultIntents = panelIntents && safeStringArray(panelIntents.result);
  const context = authorization && exact(authorization.context, ['issuer', 'windowId', 'tabId', 'contextType', 'documentUrl'], true);
  const issuer = context && exact(context.issuer, ['type', 'documentId', 'path'], true);
  const targetAuthorized = Boolean(
    session?.mode === 'attached' && target?.kind === 'attached' && target.tabId === binding.admission?.tabId &&
      typeof target.documentId === 'string' && target.documentId.length >= 1 && target.documentId.length <= 512 &&
      DIGEST.test(target.urlSessionDigest ?? '') ||
    session?.mode === 'single' && target?.kind === 'disposable' && target.state === 'retained-for-review' &&
      /^owner_[A-Za-z0-9_-]{22}$/u.test(target.ownershipId ?? ''),
  );
  return Boolean(authorization?.ok === true && session && target && targetAuthorized && resultIntents &&
    session.version === 1 && session.sessionCapabilityId === binding.sessionCapabilityId &&
    session.auditId === binding.auditId && session.windowId === binding.windowId &&
    session.state === 'result' && safeEpoch(session.issuedAt) && safeEpoch(session.expiresAt) &&
    session.issuedAt <= actionAt && actionAt < session.expiresAt &&
    resultIntents.includes('highlight') &&
    context.windowId === binding.windowId && context.tabId === null && context.contextType === 'SIDE_PANEL' &&
    context.documentUrl === binding.sender.url && issuer?.type === 'extension-document' &&
    issuer.documentId === binding.issuerDocumentId && issuer.path === '/src/panel/index.html');
}

function pageMarkersEvent(value) {
  const record = exact(value, ['windowId', 'sessionCapabilityId', 'auditId', 'modelRevision', 'state', 'selectedOrdinal']);
  if (!record || !safeChromeId(record.windowId) || typeof record.auditId !== 'string' || !AUDIT_ID.test(record.auditId) ||
    typeof record.sessionCapabilityId !== 'string' || !CAPABILITY.test(record.sessionCapabilityId) ||
    !Number.isSafeInteger(record.modelRevision) || record.modelRevision < 1 ||
    !['active', 'clear'].includes(record.state) ||
    (record.selectedOrdinal !== null && (!Number.isSafeInteger(record.selectedOrdinal) || record.selectedOrdinal < 0 || record.selectedOrdinal >= 64)) ||
    (record.state === 'clear' && record.selectedOrdinal !== null)) return null;
  return record;
}

function authorizedPageMarkersPublication(value, binding, actionAt) {
  const authorization = exact(value, ['ok', 'session', 'context'], true);
  const session = authorization && exact(authorization.session, AUTHORIZED_SESSION_KEYS, true);
  const context = authorization && exact(authorization.context, ['issuer', 'windowId', 'tabId', 'contextType', 'documentUrl'], true);
  const issuer = context && exact(context.issuer, ['type', 'documentId', 'path'], true);
  const intents = session && exact(session.intents, ['panel', 'review'], true);
  const panel = intents && (exact(intents.panel, ['running', 'privacy-paused', 'result', 'view-only'], true) ??
    exact(intents.panel, ['running', 'result', 'view-only'], true));
  const allowed = panel && ['result', 'view-only'].includes(session.state) && safeStringArray(panel[session.state]);
  return Boolean(authorization?.ok === true && session?.version === 1 &&
    session.sessionCapabilityId === binding.sessionCapabilityId && session.auditId === binding.auditId &&
    session.windowId === binding.windowId && ['attached', 'single'].includes(session.mode) &&
    own(session.targetBinding, 'kind') !== 'batch' && allowed && allowed.includes('review-markers') &&
    safeEpoch(actionAt) && safeEpoch(session.issuedAt) && safeEpoch(session.expiresAt) &&
    session.issuedAt <= actionAt && actionAt < session.expiresAt &&
    context?.windowId === binding.windowId && context.tabId === null && context.contextType === 'SIDE_PANEL' &&
    context.documentUrl === binding.sender.url && issuer?.type === 'extension-document' &&
    issuer.documentId === binding.issuerDocumentId && issuer.path === '/src/panel/index.html');
}

function packet(state, auditId, sessionCapabilityId, result, captureMode = null) {
  const output = {
    protocol: 'audita-panel', version: 1, type: 'bootstrap-result',
    state, auditId, sessionCapabilityId, result,
  };
  if (state === 'running' && CAPTURE_MODES.has(captureMode)) output.captureMode = captureMode;
  return freeze(output);
}

function privacyPausedPacket(suspension, sessionCapabilityId, session) {
  const packet = {
    protocol: 'audita-panel', version: 1, type: 'privacy-paused',
    auditId: suspension.auditId,
    sessionCapabilityId,
    mode: suspension.mode,
    categories: [...suspension.categories],
    message: PRIVACY_PAUSE_MESSAGE,
  };
  if (suspension.source.kind === 'attached') packet.consentId = suspension.consentId;
  if (session.mode === 'batch') packet.pageNumber = Number(suspension.source.pageId.slice('page-'.length));
  return freeze(packet);
}

function deniedRegistration() {
  return Object.freeze({ registered: false, delivered: false, code: 'AUDIT_REHYDRATE_DENIED' });
}

function recoveryRequiredRegistration() {
  return Object.freeze({ registered: false, delivered: false, code: 'AUDIT_RECOVERY_REQUIRED' });
}

export function createPanelPortCoordinator(raw) {
  const input = exact(raw, FACTORY_KEYS) ?? exact(raw, [...FACTORY_KEYS, 'authorizePageMarkersSession', 'closePanelMarkers']);
  if (!input || typeof input.chromeApi?.runtime?.id !== 'string' ||
    typeof input.sessionArea?.get !== 'function' || typeof input.sessionArea.set !== 'function' ||
    typeof input.readActiveJob !== 'function' || typeof input.readAuditSession !== 'function' ||
    typeof input.readPixelSuspension !== 'function' ||
    typeof input.loadPanelResultBundle !== 'function' || typeof input.rehydrateViewOnly !== 'function' ||
    typeof input.revokeViewOnly !== 'function' || typeof input.epochNow !== 'function' ||
    typeof input.setTimer !== 'function' || typeof input.clearTimer !== 'function' ||
    typeof input.launchAuthority?.admitPort !== 'function' || typeof input.launchAuthority.reprove !== 'function' ||
    typeof input.launchAuthority.retirePort !== 'function' || typeof input.dispatchPanelIntent !== 'function' ||
    typeof input.authorizeHighlightSession !== 'function' ||
    (Object.hasOwn(input, 'authorizePageMarkersSession') &&
      (typeof input.authorizePageMarkersSession !== 'function' || typeof input.closePanelMarkers !== 'function'))) {
    throw new TypeError('PANEL_PORT_COORDINATOR_INVALID');
  }

  const windowTails = new Map();
  const bindings = new WeakMap();
  const liveByWindow = new Map();
  const scopeStates = new WeakMap();
  const scopeDeniedSentinel = Object.freeze(Object.create(null));
  const activeConflictSentinel = Object.freeze(Object.create(null));
  let scopeMarker = null;
  const authorizePageMarkersSession = input.authorizePageMarkersSession;
  const closePanelMarkers = input.closePanelMarkers;

  function invalidateMarkerReceipt(binding) {
    const receipt = binding.markerReceipt;
    binding.markerReceipt = null;
    if (!receipt) return;
    // Cancel the controller synchronously. Its owned retry state must not hold
    // the existing panel retirement/window lock while script cleanup settles.
    try { Promise.resolve(closePanelMarkers({ windowId: receipt.windowId, sessionCapabilityId: receipt.sessionCapabilityId })).catch(() => {}); }
    catch { /* Controller keeps unconfirmed owned cleanup for retry. */ }
  }

  function currentMarkerReceipt(binding, receipt, admission) {
    return Boolean(receipt && connected(binding) && binding.state === 'bound-session' &&
      binding.markerReceipt === receipt && binding.admission === admission &&
      binding.windowId === receipt.windowId && binding.auditId === receipt.auditId &&
      binding.sessionCapabilityId === receipt.sessionCapabilityId);
  }

  function assertScope(scope, windowId) {
    const state = scopeStates.get(scope);
    if (!state?.active || state.windowId !== windowId) throw scopeDeniedSentinel;
  }

  function exposeScopeFailure(error) {
    if (error === scopeDeniedSentinel) throw new Error('PANEL_SCOPE_DENIED');
    throw error;
  }

  function createScope(windowId) {
    let scope;
    const invoke = operation => rawArgs => {
      try {
        assertScope(scope, windowId);
        if (own(rawArgs, 'windowId') !== windowId) return Promise.resolve(false);
        return Promise.resolve(operation(rawArgs, () => assertScope(scope, windowId))).catch(exposeScopeFailure);
      } catch (error) {
        return Promise.reject(error === scopeDeniedSentinel ? new Error('PANEL_SCOPE_DENIED') : error);
      }
    };
    const invokeTerminal = rawArgs => {
      try {
        assertScope(scope, windowId);
        if (own(rawArgs, 'windowId') !== windowId) return Promise.resolve(terminalDelivery('denied'));
        return Promise.resolve(publishResult(rawArgs, () => assertScope(scope, windowId))).catch(exposeScopeFailure);
      } catch (error) {
        return Promise.reject(error === scopeDeniedSentinel ? new Error('PANEL_SCOPE_DENIED') : error);
      }
    };
    scope = Object.freeze({
      registerPendingBootstrap: invoke(registerPendingBootstrap),
      publishRegisteredBootstrap: invoke(publishRegisteredBootstrap),
      publishResult: invokeTerminal,
      registerAndPublishViewOnly: invoke(registerAndPublishViewOnly),
      publishPrivacyPaused: invoke(publishPrivacyPaused),
      publishRunningResume: invoke(publishRunningResume),
      disconnectSession: invoke(disconnectSession),
    });
    scopeStates.set(scope, { windowId, active: true });
    return scope;
  }

  function withWindowLock(windowId, fn) {
    if (!safeChromeId(windowId) || typeof fn !== 'function') return Promise.reject(new TypeError('PANEL_WINDOW_LOCK_DENIED'));
    if (scopeMarker?.windowId === windowId) return Promise.reject(new Error('PANEL_WINDOW_LOCK_REENTRANT'));
    const previous = windowTails.get(windowId) ?? Promise.resolve();
    const run = async () => {
      const marker = { windowId };
      const scope = createScope(windowId);
      scopeMarker = marker;
      let returned;
      try {
        try { returned = fn(scope); }
        finally { if (scopeMarker === marker) scopeMarker = null; }
        return await returned;
      }
      finally { scopeStates.get(scope).active = false; }
    };
    const operation = previous.then(run, run);
    windowTails.set(windowId, operation.catch(() => {}));
    return operation;
  }

  function reassert(assertOwned) { assertOwned?.(); }

  async function readBootstrap(windowId, assertOwned = null) {
    const key = panelBootstrapStorageKey(windowId);
    const read = async () => {
      const envelope = await input.sessionArea.get(key);
      reassert(assertOwned);
      const parsed = parseStorageGetEnvelope(envelope, key);
      if (!parsed) throw new Error('PANEL_BOOTSTRAP_DENIED');
      if (parsed.state === 'absent') return null;
      const value = parseBootstrap(parsed.value);
      if (!value) throw new Error('PANEL_BOOTSTRAP_DENIED');
      return value;
    };
    const first = await read();
    reassert(assertOwned);
    const second = await read();
    reassert(assertOwned);
    if (!same(first, second)) throw new Error('PANEL_BOOTSTRAP_DENIED');
    return first;
  }

  function replacementOutcome(state, record, rollback = null) {
    return Object.freeze({ state, record, rollback });
  }

  async function reconcileBootstrapReplacement(operation, assertOwned) {
    let current;
    try {
      current = await readBootstrap(operation.candidate.windowId, assertOwned);
      reassert(assertOwned);
    } catch (error) {
      if (error === scopeDeniedSentinel) throw error;
      return replacementOutcome('recovery-required', null);
    }
    if (same(current, operation.previous)) return replacementOutcome('rolled-back', operation.previous);
    if (!same(current, operation.candidate)) return replacementOutcome('recovery-required', null);

    try {
      reassert(assertOwned);
      if (operation.previous === null) {
        await input.sessionArea.remove(panelBootstrapStorageKey(operation.candidate.windowId));
      } else {
        await input.sessionArea.set({
          [panelBootstrapStorageKey(operation.candidate.windowId)]: operation.previous,
        });
      }
      reassert(assertOwned);
    } catch (error) {
      if (error === scopeDeniedSentinel) throw error;
      // The storage effect may have landed before rejecting; the confirming read below is authoritative.
    }

    try {
      const restored = await readBootstrap(operation.candidate.windowId, assertOwned);
      reassert(assertOwned);
      return same(restored, operation.previous)
        ? replacementOutcome('rolled-back', operation.previous)
        : replacementOutcome('recovery-required', null);
    } catch (error) {
      if (error === scopeDeniedSentinel) throw error;
      return replacementOutcome('recovery-required', null);
    }
  }

  async function replaceBootstrap(previousValue, candidateValue, assertOwned = null) {
    const previous = previousValue === null ? null : parseBootstrap(previousValue);
    const candidate = parseBootstrap(candidateValue);
    if (!candidate || (previousValue !== null && !previous) ||
      (previous !== null && previous.windowId !== candidate.windowId)) {
      throw new Error('PANEL_BOOTSTRAP_DENIED');
    }
    const operation = Object.freeze({ previous, candidate });
    const rollback = () => reconcileBootstrapReplacement(operation, assertOwned);
    try {
      const current = await readBootstrap(candidate.windowId, assertOwned);
      reassert(assertOwned);
      if (!same(current, previous)) return replacementOutcome('recovery-required', null);
    } catch (error) {
      if (error === scopeDeniedSentinel) throw error;
      return replacementOutcome('recovery-required', null);
    }
    try {
      reassert(assertOwned);
      await input.sessionArea.set({ [panelBootstrapStorageKey(candidate.windowId)]: candidate });
      reassert(assertOwned);
      const confirmed = await readBootstrap(candidate.windowId, assertOwned);
      reassert(assertOwned);
      if (same(confirmed, candidate)) return replacementOutcome('committed', confirmed, rollback);
    } catch (error) {
      if (error === scopeDeniedSentinel) throw error;
    }
    return reconcileBootstrapReplacement(operation, assertOwned);
  }

  async function readSession(sessionCapabilityId, auditId, assertOwned = null) {
    const value = parseSession(await input.readAuditSession({ sessionCapabilityId, auditId }));
    reassert(assertOwned);
    if (!value || value.sessionCapabilityId !== sessionCapabilityId || value.auditId !== auditId) throw new Error('PANEL_SESSION_DENIED');
    return value;
  }

  async function readActive(assertOwned = null) {
    const value = parseActive(await input.readActiveJob());
    reassert(assertOwned);
    if (value === undefined) throw new Error('PANEL_ACTIVE_DENIED');
    return value;
  }

  async function readSuspension(auditId, assertOwned = null) {
    const value = parseSuspension(await input.readPixelSuspension(auditId));
    reassert(assertOwned);
    if (!value || value.auditId !== auditId) throw new Error('PANEL_PRIVACY_PAUSE_DENIED');
    return value;
  }

  async function requireActiveAbsent(assertOwned) {
    try {
      const active = await readActive(assertOwned);
      reassert(assertOwned);
      if (active !== null) throw activeConflictSentinel;
    } catch (error) {
      if (error === scopeDeniedSentinel) throw error;
      throw activeConflictSentinel;
    }
  }

  async function confirmStartJournalAbsent(assertOwned = null) {
    const read = async () => {
      const envelope = await input.sessionArea.get(START_JOURNAL_KEY);
      reassert(assertOwned);
      const parsed = parseStorageGetEnvelope(envelope, START_JOURNAL_KEY);
      if (!parsed) throw new Error('PANEL_START_JOURNAL_DENIED');
      return parsed.state === 'present';
    };
    const first = await read();
    reassert(assertOwned);
    if (first) return false;
    const second = await read();
    reassert(assertOwned);
    return !second;
  }

  function snapshotSender(port) {
    const sender = own(port, 'sender');
    const copy = exact(sender, ['id', 'url', 'origin'], true);
    return copy?.id === input.chromeApi.runtime.id && typeof copy.url === 'string' &&
      copy.origin === `chrome-extension://${input.chromeApi.runtime.id}` ? freeze(copy) : null;
  }

  function connected(binding) {
    return binding && binding.state !== 'disconnected' && bindings.get(binding.port) === binding;
  }

  function removeTemporary(binding, assertOwned = null) {
    if (binding.deadline !== null) {
      reassert(assertOwned);
      input.clearTimer(binding.deadline);
      binding.deadline = null;
    }
    reassert(assertOwned);
    try { binding.port.onMessage.removeListener(binding.onHello); } catch { /* fixed cleanup */ }
  }

  function disconnect(binding, assertOwned = null, nativeAlreadyDisconnected = false) {
    if (!binding) return Promise.resolve('denied');
    if (binding.retirement) return binding.retirement;
    if (binding.state === 'disconnected') return Promise.resolve(binding.retirementState ?? 'denied');
    reassert(assertOwned);
    binding.state = 'disconnected';
    invalidateMarkerReceipt(binding);
    removeTemporary(binding, assertOwned);
    reassert(assertOwned);
    try { binding.port.onMessage.removeListener(binding.onBoundMessage); } catch { /* fixed cleanup */ }
    reassert(assertOwned);
    try { binding.port.onDisconnect.removeListener(binding.onDisconnect); } catch { /* fixed cleanup */ }
    reassert(assertOwned);
    bindings.delete(binding.port);
    reassert(assertOwned);
    if (binding.windowId !== null && liveByWindow.get(binding.windowId) === binding) liveByWindow.delete(binding.windowId);
    const admissionClaim = binding.admission;
    binding.admission = null;
    binding.inFlightIntent = null;
    binding.retiringCancel = null;
    if (!admissionClaim) {
      binding.retirementState = 'denied';
      if (!nativeAlreadyDisconnected) {
        reassert(assertOwned);
        try { binding.port.disconnect(); } catch { /* fixed cleanup */ }
      }
      binding.retirement = Promise.resolve('denied');
      return binding.retirement;
    }
    const retirement = (async () => {
      let state = 'denied';
      try {
        const admission = await admissionClaim;
        reassert(assertOwned);
        if (admission?.ok === true) {
          state = launchRetirementState(await input.launchAuthority.retirePort(admission));
          reassert(assertOwned);
        }
      } catch (error) {
        if (error === scopeDeniedSentinel) throw error;
        state = 'denied';
      }
      binding.retirementState = state;
      if (!nativeAlreadyDisconnected) {
        reassert(assertOwned);
        try { binding.port.disconnect(); } catch { /* fixed cleanup */ }
      }
      return state;
    })();
    binding.retirement = retirement;
    return retirement;
  }

  async function reprove(binding, assertOwned = null) {
    const context = await input.launchAuthority.reprove(binding.admission);
    reassert(assertOwned);
    return connected(binding) && context?.ok === true && context.windowId === binding.windowId &&
      context.documentId === binding.issuerDocumentId && context.url === binding.sender.url &&
      context.token === binding.admission?.token && context.generation === binding.admission?.generation
      ? context : null;
  }

  function send(binding, value, assertOwned = null) {
    reassert(assertOwned);
    if (!connected(binding)) throw new Error('PANEL_PORT_DISCONNECTED');
    const isBootstrap = value.type === 'bootstrap-result';
    const isPause = value.type === 'privacy-paused';
    let nextReceipt = binding.markerReceipt;
    if (closePanelMarkers && (isBootstrap || isPause)) {
      const result = isBootstrap && ['result', 'view-only'].includes(value.state) ? value.result : null;
      const unchanged = result && nextReceipt && nextReceipt.auditId === value.auditId &&
        nextReceipt.sessionCapabilityId === value.sessionCapabilityId && nextReceipt.modelRevision === result.modelRevision;
      if (!unchanged) {
        invalidateMarkerReceipt(binding);
        nextReceipt = result ? Object.freeze({ windowId: binding.windowId, auditId: value.auditId,
          sessionCapabilityId: value.sessionCapabilityId, modelRevision: result.modelRevision,
          detailCount: Math.min(64, result.details.length) }) : null;
      }
    }
    binding.port.postMessage(value);
    if (closePanelMarkers && (isBootstrap || isPause) && connected(binding)) binding.markerReceipt = nextReceipt;
  }

  function bind(binding, windowId, state, auditId = null, sessionCapabilityId = null, assertOwned = null) {
    reassert(assertOwned);
    if (binding.markerReceipt && (state !== 'bound-session' || binding.markerReceipt.windowId !== windowId ||
      binding.markerReceipt.auditId !== auditId || binding.markerReceipt.sessionCapabilityId !== sessionCapabilityId)) {
      invalidateMarkerReceipt(binding);
    }
    binding.windowId = windowId;
    binding.state = state;
    binding.auditId = auditId;
    binding.sessionCapabilityId = sessionCapabilityId;
    liveByWindow.set(windowId, binding);
  }

  async function runningCorrelation(bootstrap, assertOwned = null) {
    const session = await readSession(bootstrap.sessionCapabilityId, bootstrap.auditId, assertOwned);
    reassert(assertOwned);
    const active = await readActive(assertOwned);
    reassert(assertOwned);
    return session.state === 'running' && session.windowId === bootstrap.windowId && active?.state === 'running' &&
      active.auditId === bootstrap.auditId && active.sessionCapabilityId === bootstrap.sessionCapabilityId &&
      active.windowId === bootstrap.windowId ? { session, active } : null;
  }

  function privacyPauseCorrelation(bootstrap, session, active, suspension, currentTime) {
    const attachedTarget = exact(session.targetBinding, ['kind', 'tabId', 'documentId', 'urlSessionDigest'], true);
    const disposableTarget = exact(session.targetBinding, ['kind', 'ownershipId', 'state'], true);
    const batchTarget = exact(session.targetBinding, ['kind', 'activePageId', 'activeOwnershipId'], true);
    const attached = session.mode === 'attached' && attachedTarget?.kind === 'attached' &&
      suspension.source.kind === 'attached' && suspension.tabId === attachedTarget.tabId &&
      suspension.documentId === attachedTarget.documentId &&
      suspension.urlSessionDigest === attachedTarget.urlSessionDigest;
    const single = session.mode === 'single' && disposableTarget?.kind === 'disposable' &&
      disposableTarget.state === 'retained-for-consent' && suspension.source.kind === 'owned-disposable' &&
      suspension.source.ownershipId === disposableTarget.ownershipId &&
      ['always', 'pre-observation-failure'].includes(suspension.source.cleanupMode) &&
      suspension.source.pageId === 'page-1';
    const batch = session.mode === 'batch' && batchTarget?.kind === 'batch' &&
      BATCH_PAGE_ID.test(batchTarget.activePageId ?? '') &&
      /^owner_[A-Za-z0-9_-]{22}$/u.test(batchTarget.activeOwnershipId ?? '') &&
      suspension.source.kind === 'owned-disposable' &&
      suspension.source.pageId === batchTarget.activePageId &&
      suspension.source.ownershipId === batchTarget.activeOwnershipId &&
      suspension.source.cleanupMode === 'always';
    return session.state === 'privacy-paused' && active?.mode === session.mode &&
      session.windowId === bootstrap.windowId && (attached || single || batch) &&
      active?.state === 'privacy-paused' && active.auditId === bootstrap.auditId &&
      active.sessionCapabilityId === bootstrap.sessionCapabilityId && active.windowId === bootstrap.windowId &&
      suspension.auditId === bootstrap.auditId && suspension.windowId === bootstrap.windowId &&
      suspension.mode === suspension.capturePolicy.mode && suspension.issuedAt <= currentTime &&
      bootstrap.createdAt <= currentTime && currentTime < bootstrap.expiresAt &&
      currentTime < suspension.expiresAt && currentTime < session.expiresAt;
  }

  async function stablePrivacyPauseCorrelation(bootstrap, assertOwned = null) {
    const read = async () => {
      const session = await readSession(bootstrap.sessionCapabilityId, bootstrap.auditId, assertOwned);
      reassert(assertOwned);
      const active = await readActive(assertOwned);
      reassert(assertOwned);
      const suspension = await readSuspension(bootstrap.auditId, assertOwned);
      reassert(assertOwned);
      const currentTime = input.epochNow();
      if (!safeEpoch(currentTime) || !privacyPauseCorrelation(bootstrap, session, active, suspension, currentTime)) {
        throw new Error('PANEL_PRIVACY_PAUSE_DENIED');
      }
      return freeze({ session, active, suspension });
    };
    const first = await read();
    reassert(assertOwned);
    const second = await read();
    reassert(assertOwned);
    return same(first, second) ? second : null;
  }

  async function stableRunningResumeCorrelation(bootstrap, assertOwned = null) {
    const first = await runningCorrelation(bootstrap, assertOwned);
    reassert(assertOwned);
    const second = await runningCorrelation(bootstrap, assertOwned);
    reassert(assertOwned);
    const currentTime = input.epochNow();
    return first && second && same(first, second) && safeEpoch(currentTime) &&
      bootstrap.createdAt <= currentTime && currentTime < bootstrap.expiresAt &&
      currentTime < second.session.expiresAt ? second : null;
  }

  async function deliverPrivacyPaused(binding, bootstrap, establishClientCorrelation = false, assertOwned = null) {
    if (!['pending', 'consumed'].includes(bootstrap.state)) throw new Error('PANEL_BOOTSTRAP_DENIED');
    const correlation = await stablePrivacyPauseCorrelation(bootstrap, assertOwned);
    reassert(assertOwned);
    if (!correlation) throw new Error('PANEL_PRIVACY_PAUSE_DENIED');
    const context = await reprove(binding, assertOwned);
    reassert(assertOwned);
    if (!context) throw new Error('PANEL_CONTEXT_DENIED');
    if (establishClientCorrelation) {
      send(binding, packet(
        'running', bootstrap.auditId, bootstrap.sessionCapabilityId, null, bootstrap.captureMode,
      ), assertOwned);
    }
    send(binding, privacyPausedPacket(
      correlation.suspension, bootstrap.sessionCapabilityId, correlation.session,
    ), assertOwned);
    bind(binding, bootstrap.windowId, 'bound-privacy-paused', bootstrap.auditId, bootstrap.sessionCapabilityId, assertOwned);
    return true;
  }

  async function deliverRunning(binding, bootstrap, rotate, assertOwned = null) {
    const correlation = await runningCorrelation(bootstrap, assertOwned);
    reassert(assertOwned);
    const journalAbsent = correlation ? await confirmStartJournalAbsent(assertOwned) : false;
    reassert(assertOwned);
    if (!correlation || !journalAbsent) {
      throw new Error('PANEL_RUNNING_DENIED');
    }
    let current = bootstrap;
    if (rotate) {
      const rotation = await replaceBootstrap(bootstrap, { ...bootstrap, state: 'pending' }, assertOwned);
      reassert(assertOwned);
      if (rotation.state !== 'committed') throw new Error('PANEL_BOOTSTRAP_DENIED');
      current = rotation.record;
    }
    if (current.state !== 'pending') throw new Error('PANEL_BOOTSTRAP_DENIED');
    const consumption = await replaceBootstrap(current, { ...current, state: 'consumed' }, assertOwned);
    reassert(assertOwned);
    if (consumption.state !== 'committed') throw new Error('PANEL_BOOTSTRAP_DENIED');
    current = consumption.record;
    const context = await reprove(binding, assertOwned);
    reassert(assertOwned);
    if (!context) throw new Error('PANEL_CONTEXT_DENIED');
    send(binding, packet(
      'running', current.auditId, current.sessionCapabilityId, null, current.captureMode,
    ), assertOwned);
    bind(binding, current.windowId, 'bound-session', current.auditId, current.sessionCapabilityId, assertOwned);
    return true;
  }

  async function recoverTerminal(binding, bootstrap, session) {
    let minted = null;
    let replacement = null;
    try {
      if (await readActive() !== null || !['result', 'view-only', 'revoked'].includes(session.state)) throw new Error('PANEL_TERMINAL_DENIED');
      const resultBundle = copyPanelResultBundleV1(await input.loadPanelResultBundle({ auditId: bootstrap.auditId }));
      if (await readActive() !== null) throw new Error('PANEL_TERMINAL_DENIED');
      const disposableTarget = exact(session.targetBinding, ['kind', 'ownershipId', 'state'], true);
      const retainedSingleResult = bootstrap.state === 'consumed' && session.mode === 'single' &&
        session.state === 'result' && disposableTarget?.kind === 'disposable' &&
        disposableTarget.state === 'retained-for-review' &&
        /^owner_[A-Za-z0-9_-]{22}$/u.test(disposableTarget.ownershipId ?? '');
      if (retainedSingleResult) {
        const confirmedSession = await readSession(bootstrap.sessionCapabilityId, bootstrap.auditId);
        const confirmedAt = input.epochNow();
        if (!same(session, confirmedSession) || !safeEpoch(confirmedAt) || confirmedAt >= confirmedSession.expiresAt ||
          await readActive() !== null || !await reprove(binding) || await readActive() !== null) {
          throw new Error('PANEL_TERMINAL_DENIED');
        }
        const finalSession = await readSession(bootstrap.sessionCapabilityId, bootstrap.auditId);
        if (!same(confirmedSession, finalSession)) throw new Error('PANEL_TERMINAL_DENIED');
        send(binding, packet('result', bootstrap.auditId, bootstrap.sessionCapabilityId, resultBundle));
        bind(binding, bootstrap.windowId, 'bound-session', bootstrap.auditId, bootstrap.sessionCapabilityId);
        return true;
      }
      minted = await input.rehydrateViewOnly({ auditId: bootstrap.auditId, windowId: bootstrap.windowId, mode: 'attached' });
      if (await readActive() !== null) throw new Error('PANEL_TERMINAL_DENIED');
      if (minted?.ok !== true || minted.auditId !== bootstrap.auditId || !CAPABILITY.test(minted.sessionCapabilityId ?? '') ||
        !safeEpoch(minted.expiresAt)) throw new Error('PANEL_TERMINAL_DENIED');
      const createdAt = input.epochNow();
      if (!safeEpoch(createdAt) || createdAt >= minted.expiresAt) throw new Error('PANEL_TERMINAL_DENIED');
      if (await readActive() !== null) throw new Error('PANEL_TERMINAL_DENIED');
      replacement = Object.freeze({
        version: 1, kind: 'audit-session', auditId: bootstrap.auditId,
        sessionCapabilityId: minted.sessionCapabilityId, windowId: bootstrap.windowId,
        createdAt, expiresAt: minted.expiresAt, state: 'consumed',
      });
      const operation = await replaceBootstrap(bootstrap, replacement);
      if (operation.state !== 'committed') throw new Error('PANEL_TERMINAL_DENIED');
      replacement = operation;
      if (await readActive() !== null) throw new Error('PANEL_TERMINAL_DENIED');
      if (!await reprove(binding)) throw new Error('PANEL_TERMINAL_DENIED');
      if (await readActive() !== null) throw new Error('PANEL_TERMINAL_DENIED');
      send(binding, packet('view-only', replacement.record.auditId, replacement.record.sessionCapabilityId, resultBundle));
      bind(binding, replacement.record.windowId, 'bound-session', replacement.record.auditId, replacement.record.sessionCapabilityId);
      return true;
    } catch {
      if (replacement?.state === 'committed') {
        try { await replacement.rollback(); }
        catch { /* publication remains denied */ }
      }
      if (minted?.ok === true && CAPABILITY.test(minted.sessionCapabilityId ?? '')) {
        let revoked = false;
        try { revoked = await input.revokeViewOnly({ sessionCapabilityId: minted.sessionCapabilityId, auditId: bootstrap.auditId }); }
        catch { revoked = false; }
        if (!revoked) return false;
      }
      return false;
    }
  }

  async function handleHello(binding) {
    try {
      const admission = await binding.admission;
      if (admission?.ok !== true) throw new Error('PANEL_CONTEXT_DENIED');
      if (!connected(binding)) { await binding.retirement; return; }
      binding.admission = admission;
      binding.issuerDocumentId = admission.documentId;
      await withWindowLock(admission.windowId, async () => {
        binding.windowId = admission.windowId;
        if (!await reprove(binding)) throw new Error('PANEL_CONTEXT_DENIED');
        const incumbent = liveByWindow.get(admission.windowId);
        if (incumbent && incumbent !== binding && connected(incumbent)) throw new Error('PANEL_INCUMBENT');
        const currentTime = input.epochNow();
        if (!safeEpoch(currentTime)) throw new Error('PANEL_CLOCK_DENIED');
        bind(binding, admission.windowId, 'proving-hello');
        const bootstrap = await readBootstrap(admission.windowId);
        if (!bootstrap) {
          bind(binding, admission.windowId, 'bound-idle');
          send(binding, packet('initial', null, null, null));
          return;
        }
        if (bootstrap.windowId !== admission.windowId || bootstrap.createdAt > currentTime || bootstrap.expiresAt <= currentTime) {
          throw new Error('PANEL_BOOTSTRAP_DENIED');
        }
        bind(binding, admission.windowId, 'proving-hello', bootstrap.auditId, bootstrap.sessionCapabilityId);
        const session = await readSession(bootstrap.sessionCapabilityId, bootstrap.auditId);
        if (session.windowId !== bootstrap.windowId) throw new Error('PANEL_SESSION_DENIED');
        if (session.state === 'running') {
          await deliverRunning(binding, bootstrap, bootstrap.state === 'consumed');
          return;
        }
        if (session.state === 'privacy-paused') {
          await deliverPrivacyPaused(binding, bootstrap, true);
          return;
        }
        if (!await recoverTerminal(binding, bootstrap, session)) throw new Error('PANEL_TERMINAL_DENIED');
      });
    } catch { await disconnect(binding); }
  }

  async function processIntent(binding, request) {
    let inFlight = null;
    try {
      if (request.generation !== binding.intentGeneration) return;
      if (!connected(binding) || !await reprove(binding)) throw new Error('PANEL_CONTEXT_DENIED');
      const parsed = parsePanelPortIntent(request.envelope, binding.windowId);
      if (!parsed.ok) throw new Error('PANEL_INTENT_DENIED');
      if (request.generation !== binding.intentGeneration || binding.inFlightIntent !== null) {
        throw new Error('PANEL_INTENT_DENIED');
      }
      inFlight = Object.freeze({
        requestId: request.requestId,
        type: parsed.value.type,
        auditId: own(parsed.value, 'auditId') ?? null,
        sessionCapabilityId: own(parsed.value, 'sessionCapabilityId') ?? null,
        windowId: binding.windowId,
        generation: binding.admission.generation,
        queueGeneration: request.generation,
        originState: binding.state,
      });
      binding.inFlightIntent = inFlight;
      const dispatchRequest = {
        envelope: parsed.value,
        sender: binding.admission.syntheticSender,
        launchTabId: binding.admission.tabId,
      };
      if (HIGHLIGHT_INTENT_TYPES.has(parsed.value.type)) dispatchRequest.panelWindowId = binding.windowId;
      if (PAGE_MARKERS_INTENT_TYPES.has(parsed.value.type)) {
        const receipt = binding.markerReceipt;
        const admission = binding.admission;
        dispatchRequest.panelWindowId = binding.windowId;
        dispatchRequest.isCurrent = () => currentMarkerReceipt(binding, receipt, admission) &&
          receipt.modelRevision === parsed.value.modelRevision && receipt.auditId === parsed.value.auditId &&
          receipt.sessionCapabilityId === parsed.value.sessionCapabilityId;
        if (!dispatchRequest.isCurrent()) throw new Error('PANEL_INTENT_DENIED');
      }
      const response = await input.dispatchPanelIntent(dispatchRequest);
      if (binding.retiringCancel === inFlight || binding.state === 'retiring-cancel') {
        const retired = revokedCancelResponse(response, inFlight.auditId);
        if (!retired || binding.retiringCancel !== inFlight ||
          inFlight.type !== 'PANEL_CANCEL_AUDIT' || inFlight.originState !== 'bound-privacy-paused') {
          throw new Error('PANEL_CANCEL_RETIREMENT_DENIED');
        }
        await withWindowLock(inFlight.windowId, async () => {
          if (!connected(binding) || binding.state !== 'retiring-cancel' ||
            binding.retiringCancel !== inFlight || binding.inFlightIntent !== inFlight ||
            binding.admission?.generation !== inFlight.generation ||
            binding.intentGeneration !== inFlight.queueGeneration) throw new Error('PANEL_CANCEL_RETIREMENT_DENIED');
          if (await readBootstrap(inFlight.windowId) !== null) throw new Error('PANEL_CANCEL_RETIREMENT_DENIED');
          await requireActiveAbsent();
          if (!await reprove(binding)) throw new Error('PANEL_CONTEXT_DENIED');
          if (await readBootstrap(inFlight.windowId) !== null) throw new Error('PANEL_CANCEL_RETIREMENT_DENIED');
          await requireActiveAbsent();
          if (!connected(binding) || binding.state !== 'retiring-cancel' ||
            binding.retiringCancel !== inFlight || binding.inFlightIntent !== inFlight ||
            binding.admission?.generation !== inFlight.generation ||
            binding.intentGeneration !== inFlight.queueGeneration) throw new Error('PANEL_CANCEL_RETIREMENT_DENIED');
          if (!Number.isSafeInteger(binding.intentGeneration) ||
            binding.intentGeneration >= Number.MAX_SAFE_INTEGER) throw new Error('PANEL_CANCEL_RETIREMENT_DENIED');
          binding.intentGeneration += 1;
          binding.inFlightIntent = null;
          binding.retiringCancel = null;
          bind(binding, inFlight.windowId, 'bound-idle');
          send(binding, freeze({
            protocol: 'audita-panel', version: 1, type: 'intent-result',
            requestId: inFlight.requestId, response: retired,
          }));
        });
        return;
      }
      if (inFlight.type === 'PANEL_CANCEL_AUDIT' && inFlight.originState === 'bound-privacy-paused') {
        throw new Error('PANEL_CANCEL_RETIREMENT_DENIED');
      }
      if (!connected(binding) || !await reprove(binding)) throw new Error('PANEL_CONTEXT_DENIED');
      const responseBytes = capturedUtf8Length(response);
      if (responseBytes === null || responseBytes > 4096) throw new Error('PANEL_RESPONSE_DENIED');
      send(binding, freeze({
        protocol: 'audita-panel', version: 1, type: 'intent-result',
        requestId: request.requestId, response,
      }));
    } catch { await disconnect(binding); }
    finally {
      if (binding.inFlightIntent === inFlight) binding.inFlightIntent = null;
      if (binding.retiringCancel === inFlight && binding.state !== 'retiring-cancel') binding.retiringCancel = null;
    }
  }

  function processReviewHeartbeat(binding) {
    if (binding.heartbeatInFlight !== null) return;
    const receipt = binding.markerReceipt;
    const admission = binding.admission;
    if (!currentMarkerReceipt(binding, receipt, admission)) return;
    const operation = Object.freeze({});
    binding.heartbeatInFlight = operation;
    void (async () => {
      try {
        if (!await reprove(binding) || !currentMarkerReceipt(binding, receipt, admission)) return;
        const authorized = await authorizePageMarkersSession({
          sessionCapabilityId: receipt.sessionCapabilityId,
          auditId: receipt.auditId,
          claimedWindowId: receipt.windowId,
          sender: admission.syntheticSender,
        });
        if (!currentMarkerReceipt(binding, receipt, admission)) return;
        if (!authorizedPageMarkersPublication(authorized, binding, input.epochNow())) return;
      } catch { /* Heartbeats never alter the existing Port or marker lifecycle. */ }
      finally {
        if (binding.heartbeatInFlight === operation) binding.heartbeatInFlight = null;
      }
    })();
  }

  function receiveBound(binding, value) {
    if (!connected(binding)) {
      void disconnect(binding);
      return;
    }
    if (authorizePageMarkersSession && reviewHeartbeatPacket(value)) {
      processReviewHeartbeat(binding);
      return;
    }
    const request = intentPacket(value);
    if (!request || binding.seenRequestIds.has(request.requestId)) {
      void disconnect(binding);
      return;
    }
    binding.seenRequestIds.add(request.requestId);
    if (binding.seenRequestIds.size > 1024) {
      void disconnect(binding);
      return;
    }
    if (binding.state === 'retiring-cancel') return;
    if (!['bound-idle', 'bound-session', 'bound-privacy-paused'].includes(binding.state)) {
      void disconnect(binding);
      return;
    }
    const queued = Object.freeze({
      requestId: request.requestId,
      envelope: request.envelope,
      generation: binding.intentGeneration,
    });
    const operation = binding.intentTail.then(
      () => processIntent(binding, queued),
      () => processIntent(binding, queued),
    );
    binding.intentTail = operation.catch(() => {});
  }

  function attachPanelPort(port) {
    const name = own(port, 'name');
    const sender = snapshotSender(port);
    if (name !== PANEL_PORT_NAME || !sender || typeof port?.postMessage !== 'function' ||
      typeof port?.disconnect !== 'function' || typeof port?.onMessage?.addListener !== 'function' ||
      typeof port.onMessage.removeListener !== 'function' || typeof port?.onDisconnect?.addListener !== 'function' ||
      typeof port.onDisconnect.removeListener !== 'function') {
      try { port?.disconnect?.(); } catch { /* fixed denial */ }
      return false;
    }
    const binding = {
      port, sender, state: 'awaiting-hello', windowId: null, auditId: null, sessionCapabilityId: null,
      issuerDocumentId: null, admission: null, deadline: null, onHello: null, onBoundMessage: null, onDisconnect: null,
      intentTail: Promise.resolve(), seenRequestIds: new Set(), intentGeneration: 0,
      inFlightIntent: null, retiringCancel: null,
      retirement: null, retirementState: null,
      markerReceipt: null, markerPublication: null,
      heartbeatInFlight: null,
    };
    binding.onBoundMessage = value => receiveBound(binding, value);
    binding.onDisconnect = () => { void disconnect(binding, null, true); };
    binding.onHello = value => {
      if (binding.state !== 'awaiting-hello') { void disconnect(binding); return; }
      removeTemporary(binding);
      if (!hello(value)) { void disconnect(binding); return; }
      binding.state = 'proving-hello';
      binding.admission = Promise.resolve(input.launchAuthority.admitPort({ sender })).catch(() => null);
      port.onMessage.addListener(binding.onBoundMessage);
      void handleHello(binding);
    };
    bindings.set(port, binding);
    port.onMessage.addListener(binding.onHello);
    port.onDisconnect.addListener(binding.onDisconnect);
    binding.deadline = input.setTimer(() => { void disconnect(binding); }, 5000);
    return true;
  }

  function registerPendingBootstrap(rawArgs, assertOwned) {
    const args = exact(rawArgs, [
      'auditId', 'sessionCapabilityId', 'windowId', 'createdAt', 'expiresAt', 'captureMode',
    ]);
    if (!args || !CAPTURE_MODES.has(args.captureMode)) return Promise.resolve(false);
    return (async () => {
      try {
        assertOwned();
        const session = await readSession(args.sessionCapabilityId, args.auditId, assertOwned);
        assertOwned();
        const currentTime = input.epochNow();
        if (session.state !== 'running' || session.windowId !== args.windowId || session.expiresAt !== args.expiresAt ||
          !safeEpoch(args.createdAt) || args.createdAt < session.issuedAt || args.createdAt >= args.expiresAt ||
          !safeEpoch(currentTime) || currentTime >= args.expiresAt) return false;
        const existing = await readBootstrap(args.windowId, assertOwned);
        assertOwned();
        if (existing && (existing.auditId !== args.auditId || existing.sessionCapabilityId !== args.sessionCapabilityId ||
          existing.windowId !== args.windowId)) return false;
        assertOwned();
        const replacement = await replaceBootstrap(existing, {
          version: 1, kind: 'audit-session', auditId: args.auditId, sessionCapabilityId: args.sessionCapabilityId,
          windowId: args.windowId, createdAt: args.createdAt, expiresAt: args.expiresAt, state: 'pending',
          captureMode: args.captureMode,
        }, assertOwned);
        assertOwned();
        return replacement.state === 'committed';
      } catch (error) {
        if (error === scopeDeniedSentinel) throw error;
        return false;
      }
    })();
  }

  function publishRegisteredBootstrap(rawArgs, assertOwned) {
    const args = exact(rawArgs, ['auditId', 'sessionCapabilityId', 'windowId']);
    if (!args) return Promise.resolve(false);
    return (async () => {
      try {
        assertOwned();
        const bootstrap = await readBootstrap(args.windowId, assertOwned);
        assertOwned();
        if (!bootstrap || bootstrap.state !== 'pending' || bootstrap.auditId !== args.auditId ||
          bootstrap.sessionCapabilityId !== args.sessionCapabilityId || bootstrap.windowId !== args.windowId) return false;
        const session = await readSession(args.sessionCapabilityId, args.auditId, assertOwned);
        assertOwned();
        const active = await readActive(assertOwned);
        assertOwned();
        if (session.state !== 'running' || session.windowId !== args.windowId || active?.state !== 'running' ||
          active.auditId !== args.auditId || active.sessionCapabilityId !== args.sessionCapabilityId ||
          active.windowId !== args.windowId) return false;
        const journalAbsent = await confirmStartJournalAbsent(assertOwned);
        assertOwned();
        if (!journalAbsent) return false;
        const binding = liveByWindow.get(args.windowId);
        if (connected(binding) && binding.state === 'bound-idle') {
          const delivered = await deliverRunning(binding, bootstrap, false, assertOwned);
          assertOwned();
          return delivered;
        }
        return true;
      } catch (error) {
        if (error === scopeDeniedSentinel) throw error;
        return false;
      }
    })();
  }

  function publishPrivacyPaused(rawArgs, assertOwned) {
    const args = exact(rawArgs, ['auditId', 'sessionCapabilityId', 'windowId']);
    if (!args) return Promise.resolve(false);
    return (async () => {
      let binding = null;
      try {
        assertOwned();
        const bootstrap = await readBootstrap(args.windowId, assertOwned);
        assertOwned();
        if (!bootstrap || bootstrap.auditId !== args.auditId ||
          bootstrap.sessionCapabilityId !== args.sessionCapabilityId || bootstrap.windowId !== args.windowId) return false;
        binding = liveByWindow.get(args.windowId);
        if (!connected(binding)) {
          const correlation = await stablePrivacyPauseCorrelation(bootstrap, assertOwned);
          assertOwned();
          return Boolean(correlation);
        }
        if (binding.auditId !== args.auditId || binding.sessionCapabilityId !== args.sessionCapabilityId ||
          !['bound-session', 'bound-privacy-paused'].includes(binding.state)) return false;
        return await deliverPrivacyPaused(binding, bootstrap, false, assertOwned);
      } catch (error) {
        if (error === scopeDeniedSentinel) throw error;
        if (connected(binding)) {
          try { await disconnect(binding, assertOwned); } catch { /* fixed fail-closed disconnect */ }
        }
        return false;
      }
    })();
  }

  function publishRunningResume(rawArgs, assertOwned) {
    const args = exact(rawArgs, ['auditId', 'sessionCapabilityId', 'windowId']);
    if (!args) return Promise.resolve(false);
    return (async () => {
      let binding = null;
      try {
        assertOwned();
        const bootstrap = await readBootstrap(args.windowId, assertOwned);
        assertOwned();
        if (!bootstrap || bootstrap.auditId !== args.auditId ||
          bootstrap.sessionCapabilityId !== args.sessionCapabilityId || bootstrap.windowId !== args.windowId ||
          !['pending', 'consumed'].includes(bootstrap.state)) return false;
        const correlation = await stableRunningResumeCorrelation(bootstrap, assertOwned);
        assertOwned();
        if (!correlation) return false;
        binding = liveByWindow.get(args.windowId);
        if (!connected(binding)) return true;
        if (binding.auditId !== args.auditId || binding.sessionCapabilityId !== args.sessionCapabilityId ||
          !['bound-session', 'bound-privacy-paused'].includes(binding.state)) return false;
        let current = bootstrap;
        if (current.state === 'pending') {
          const consumption = await replaceBootstrap(current, { ...current, state: 'consumed' }, assertOwned);
          assertOwned();
          if (consumption.state !== 'committed') return false;
          current = consumption.record;
          if (!await stableRunningResumeCorrelation(current, assertOwned)) return false;
          assertOwned();
        }
        const context = await reprove(binding, assertOwned);
        assertOwned();
        if (!context) return false;
        send(binding, packet(
          'running', args.auditId, args.sessionCapabilityId, null, current.captureMode,
        ), assertOwned);
        bind(binding, args.windowId, 'bound-session', args.auditId, args.sessionCapabilityId, assertOwned);
        return true;
      } catch (error) {
        if (error === scopeDeniedSentinel) throw error;
        if (connected(binding)) {
          try { await disconnect(binding, assertOwned); } catch { /* fixed fail-closed disconnect */ }
        }
        return false;
      }
    })();
  }

  function publishResult(rawArgs, assertOwned) {
    const args = exact(rawArgs, ['auditId', 'sessionCapabilityId', 'windowId', 'state', 'resultBundle']);
    if (!args) return Promise.resolve(terminalDelivery('denied'));
    return (async () => {
      let binding = null;
      try {
        assertOwned();
        if (!['result', 'view-only'].includes(args.state)) return terminalDelivery('denied');
        const resultBundle = copyPanelResultBundleV1(args.resultBundle);
        if (resultBundle.auditId !== args.auditId) return terminalDelivery('denied');
        const session = await readSession(args.sessionCapabilityId, args.auditId, assertOwned);
        assertOwned();
        const bootstrap = await readBootstrap(args.windowId, assertOwned);
        assertOwned();
        binding = liveByWindow.get(args.windowId);
        if (session.state !== args.state || session.windowId !== args.windowId || !bootstrap ||
          bootstrap.auditId !== args.auditId || bootstrap.sessionCapabilityId !== args.sessionCapabilityId) {
          return terminalDelivery('denied');
        }
        if (!connected(binding)) return terminalDelivery('deferred');
        if (binding.auditId !== args.auditId || binding.sessionCapabilityId !== args.sessionCapabilityId) {
          return terminalDelivery('deferred');
        }
        const context = await reprove(binding, assertOwned);
        assertOwned();
        if (!context) {
          const retirement = await disconnect(binding, assertOwned);
          return terminalDelivery(['released', 'revoked'].includes(retirement) ? 'deferred' : 'denied');
        }
        send(binding, packet(args.state, args.auditId, args.sessionCapabilityId, resultBundle), assertOwned);
        return terminalDelivery('delivered');
      } catch (error) {
        if (error === scopeDeniedSentinel) throw error;
        if (binding) {
          let retirement = 'denied';
          try { retirement = await disconnect(binding, assertOwned); }
          catch (retireError) {
            if (retireError === scopeDeniedSentinel) throw retireError;
          }
          return terminalDelivery(['released', 'revoked'].includes(retirement) ? 'deferred' : 'denied');
        }
        return terminalDelivery('denied');
      }
    })();
  }

  function registerAndPublishViewOnly(rawArgs, assertOwned) {
    const args = exact(rawArgs, ['auditId', 'sessionCapabilityId', 'windowId', 'createdAt', 'expiresAt', 'resultBundle']);
    if (!args) return Promise.resolve(deniedRegistration());
    return (async () => {
      let registered = false;
      let previous = null;
      let replacement = null;
      let replacementStage = null;
      try {
        assertOwned();
        const resultBundle = copyPanelResultBundleV1(args.resultBundle);
        if (resultBundle.auditId !== args.auditId) return deniedRegistration();
        const session = await readSession(args.sessionCapabilityId, args.auditId, assertOwned);
        assertOwned();
        const currentTime = input.epochNow();
        if (session.state !== 'view-only' || session.windowId !== args.windowId || session.expiresAt !== args.expiresAt ||
          !safeEpoch(args.createdAt) || args.createdAt < session.issuedAt || args.createdAt >= args.expiresAt ||
          !safeEpoch(currentTime) || currentTime >= args.expiresAt) return deniedRegistration();
        await requireActiveAbsent(assertOwned);
        assertOwned();
        previous = await readBootstrap(args.windowId, assertOwned);
        assertOwned();
        if (previous) {
          if (previous.auditId !== args.auditId || previous.windowId !== args.windowId) return deniedRegistration();
          const oldSession = await readSession(previous.sessionCapabilityId, previous.auditId, assertOwned);
          assertOwned();
          if (!['result', 'view-only', 'revoked'].includes(oldSession.state) || oldSession.windowId !== args.windowId) return deniedRegistration();
        }
        await requireActiveAbsent(assertOwned);
        assertOwned();
        const pendingOperation = await replaceBootstrap(previous, {
          version: 1, kind: 'audit-session', auditId: args.auditId, sessionCapabilityId: args.sessionCapabilityId,
          windowId: args.windowId, createdAt: args.createdAt, expiresAt: args.expiresAt, state: 'pending',
        }, assertOwned);
        assertOwned();
        if (pendingOperation.state === 'recovery-required') return recoveryRequiredRegistration();
        if (pendingOperation.state !== 'committed') return deniedRegistration();
        const pending = pendingOperation.record;
        replacement = pendingOperation;
        replacementStage = 'pending';
        await requireActiveAbsent(assertOwned);
        assertOwned();
        registered = true;
        const binding = liveByWindow.get(args.windowId);
        if (!connected(binding)) return Object.freeze({ registered: true, delivered: false });
        if (binding.auditId && binding.auditId !== args.auditId) return Object.freeze({ registered: true, delivered: false });
        await requireActiveAbsent(assertOwned);
        assertOwned();
        const consumedOperation = await replaceBootstrap(pending, { ...pending, state: 'consumed' }, assertOwned);
        assertOwned();
        if (consumedOperation.state === 'recovery-required') return recoveryRequiredRegistration();
        if (consumedOperation.state !== 'committed') return Object.freeze({ registered: true, delivered: false });
        const consumed = consumedOperation.record;
        replacement = consumedOperation;
        replacementStage = 'consumed';
        await requireActiveAbsent(assertOwned);
        assertOwned();
        const context = await reprove(binding, assertOwned);
        assertOwned();
        if (!context) return Object.freeze({ registered: true, delivered: false });
        await requireActiveAbsent(assertOwned);
        assertOwned();
        send(binding, packet('view-only', consumed.auditId, consumed.sessionCapabilityId, resultBundle), assertOwned);
        bind(binding, args.windowId, 'bound-session', args.auditId, args.sessionCapabilityId, assertOwned);
        return Object.freeze({ registered: true, delivered: true });
      } catch (error) {
        if (error === scopeDeniedSentinel) throw error;
        if (error === activeConflictSentinel) {
          if (replacement) {
            try {
              const restored = await replacement.rollback();
              assertOwned();
              if (restored.state === 'recovery-required') return recoveryRequiredRegistration();
              if (restored.state !== 'rolled-back') return recoveryRequiredRegistration();
              if (replacementStage === 'consumed') return Object.freeze({ registered: true, delivered: false });
            }
            catch (restoreError) {
              if (restoreError === scopeDeniedSentinel) throw restoreError;
              return recoveryRequiredRegistration();
            }
          }
          return deniedRegistration();
        }
        return registered ? Object.freeze({ registered: true, delivered: false }) : deniedRegistration();
      }
    })();
  }

  function disconnectSession(rawArgs, assertOwned) {
    const args = exact(rawArgs, ['auditId', 'sessionCapabilityId', 'windowId', 'reasonCode']);
    if (!args || typeof args.reasonCode !== 'string' || !args.reasonCode) return Promise.resolve(false);
    return (async () => {
      try {
        assertOwned();
        const binding = liveByWindow.get(args.windowId);
        const inFlight = connected(binding) ? binding.inFlightIntent : null;
        const retiring = args.reasonCode === 'AUDIT_CANCELLED' &&
          binding?.state === 'bound-privacy-paused' && binding.auditId === args.auditId &&
          binding.sessionCapabilityId === args.sessionCapabilityId && inFlight?.type === 'PANEL_CANCEL_AUDIT' &&
          inFlight.auditId === args.auditId && inFlight.sessionCapabilityId === args.sessionCapabilityId &&
          inFlight.windowId === args.windowId && inFlight.generation === binding.admission?.generation &&
          inFlight.queueGeneration === binding.intentGeneration &&
          inFlight.originState === 'bound-privacy-paused';
        if (retiring) {
          binding.state = 'retiring-cancel';
          binding.retiringCancel = inFlight;
        } else if (connected(binding) && binding.auditId === args.auditId &&
          binding.sessionCapabilityId === args.sessionCapabilityId) await disconnect(binding, assertOwned);
        const bootstrap = await readBootstrap(args.windowId, assertOwned);
        assertOwned();
        if (bootstrap === null) {
          if (retiring) throw new Error('PANEL_CANCEL_RETIREMENT_DENIED');
          return true;
        }
        if (bootstrap.auditId !== args.auditId || bootstrap.sessionCapabilityId !== args.sessionCapabilityId ||
          bootstrap.windowId !== args.windowId) {
          if (retiring) throw new Error('PANEL_CANCEL_RETIREMENT_DENIED');
          return false;
        }
        assertOwned();
        try { await input.sessionArea.remove(panelBootstrapStorageKey(args.windowId)); }
        catch { /* a storage rejection may follow a committed removal; confirm below */ }
        assertOwned();
        const removed = await readBootstrap(args.windowId, assertOwned);
        assertOwned();
        if (removed !== null) {
          if (retiring) throw new Error('PANEL_CANCEL_RETIREMENT_DENIED');
          return false;
        }
        return true;
      } catch (error) {
        if (error === scopeDeniedSentinel) throw error;
        const binding = liveByWindow.get(args.windowId);
        if (connected(binding) && binding.state === 'retiring-cancel') {
          try { await disconnect(binding, assertOwned); } catch { /* fixed fail-closed disconnect */ }
        }
        return false;
      }
    })();
  }

  async function clearAudit(auditId) {
    try { canonicalAuditId(auditId); } catch { return false; }
    for (const binding of liveByWindow.values()) {
      if (binding.markerReceipt?.auditId === auditId) invalidateMarkerReceipt(binding);
    }
    try {
      const raw = await input.sessionArea.get(null);
      const inventory = exact(raw, Reflect.ownKeys(raw), true);
      if (!inventory) return false;
      const windows = new Map();
      for (const [key, value] of Object.entries(inventory)) {
        if (!key.startsWith('audita:panel-bootstrap:v1:') || own(value, 'auditId') !== auditId) continue;
        const bootstrap = parseBootstrap(value);
        if (!bootstrap || key !== panelBootstrapStorageKey(bootstrap.windowId)) return false;
        windows.set(bootstrap.windowId, true);
      }
      for (const binding of liveByWindow.values()) {
        if (!connected(binding)) continue;
        if (binding.auditId === auditId) windows.set(binding.windowId, true);
        else if (binding.state === 'proving-hello' && binding.auditId === null && !windows.has(binding.windowId)) {
          windows.set(binding.windowId, false);
        }
      }
      for (const [windowId, knownOwnAtScan] of [...windows].sort(([left], [right]) => left - right)) {
        const cleared = await withWindowLock(windowId, async scope => {
          let complete = true;
          const bootstrap = await readBootstrap(windowId);
          if (bootstrap?.auditId === auditId) {
            complete = await scope.disconnectSession({
              auditId, sessionCapabilityId: bootstrap.sessionCapabilityId, windowId, reasonCode: 'AUDIT_DELETED',
            });
          } else if (bootstrap && knownOwnAtScan) complete = false;
          const binding = liveByWindow.get(windowId);
          if (connected(binding) && binding.auditId === auditId) {
            const detached = await scope.disconnectSession({
              auditId, sessionCapabilityId: binding.sessionCapabilityId, windowId, reasonCode: 'AUDIT_DELETED',
            });
            complete = detached && complete;
          }
          return complete;
        });
        if (!cleared) return false;
      }
      return true;
    } catch { return false; }
  }

  async function publishHighlightState(rawEvent) {
    const event = highlightStatePacket(rawEvent);
    if (!event) return Object.freeze({ delivered: 0 });
    let delivered = 0;
    const candidates = [...liveByWindow.values()].filter(binding => connected(binding) &&
      binding.state === 'bound-session' && binding.auditId === event.auditId);
    for (const binding of candidates) {
      try {
        if (!await reprove(binding)) {
          await disconnect(binding);
          continue;
        }
        const actionAt = input.epochNow();
        if (!safeEpoch(actionAt)) {
          await disconnect(binding);
          continue;
        }
        const authorization = await input.authorizeHighlightSession({
          sessionCapabilityId: binding.sessionCapabilityId,
          auditId: binding.auditId,
          claimedWindowId: binding.windowId,
          sender: binding.admission.syntheticSender,
        });
        if (!authorizedHighlightPublication(authorization, binding, actionAt)) {
          await disconnect(binding);
          continue;
        }
        send(binding, event);
        delivered += 1;
      } catch { await disconnect(binding); }
    }
    return Object.freeze({ delivered });
  }

  async function publishPageMarkersState(rawEvent) {
    const event = pageMarkersEvent(rawEvent);
    if (!event) return Object.freeze({ delivered: 0 });
    const binding = liveByWindow.get(event.windowId);
    const receipt = binding?.markerReceipt;
    const admission = binding?.admission;
    if (!currentMarkerReceipt(binding, receipt, admission) || receipt.auditId !== event.auditId ||
      receipt.sessionCapabilityId !== event.sessionCapabilityId || receipt.modelRevision !== event.modelRevision ||
      (event.selectedOrdinal !== null && event.selectedOrdinal >= receipt.detailCount)) return Object.freeze({ delivered: 0 });
    const sequence = Object.freeze({});
    binding.markerPublication = sequence;
    const current = () => currentMarkerReceipt(binding, receipt, admission) && binding.markerPublication === sequence;
    try {
      if (!await reprove(binding) || !current()) return Object.freeze({ delivered: 0 });
      const authorized = await authorizePageMarkersSession({ sessionCapabilityId: receipt.sessionCapabilityId,
        auditId: receipt.auditId, claimedWindowId: receipt.windowId, sender: admission.syntheticSender });
      if (!current() || !authorizedPageMarkersPublication(authorized, binding, input.epochNow())) return Object.freeze({ delivered: 0 });
      send(binding, freeze({ version: 1, type: 'PAGE_MARKERS_STATE_CHANGED', auditId: event.auditId,
        modelRevision: event.modelRevision, state: event.state, selectedOrdinal: event.selectedOrdinal }));
      return Object.freeze({ delivered: 1 });
    } catch { return Object.freeze({ delivered: 0 }); }
  }

  return Object.freeze({
    attachPanelPort,
    withWindowLock,
    publishHighlightState,
    clearAudit,
    ...(closePanelMarkers ? { publishPageMarkersState } : {}),
  });
}
