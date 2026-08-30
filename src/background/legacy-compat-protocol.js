import {
  capturedUtf8Length,
  copyDenseDataArray,
  copyExactDataRecord,
  deepFreeze,
  readSafeOwnEnumerableDataType,
} from './worker-protocol.js';

const MAX_ENVELOPE_BYTES = 4096;
const AUDIT_ID = /^[A-Za-z0-9._:-]{1,160}$/u;
const LEASE_OWNER_ID = /^[A-Za-z0-9._:-]{1,200}$/u;
const REVIEW_PATH = '/src/review/index.html';
const PANEL_PATH = '/src/panel/index.html';
const EXPORT_PATH = '/src/export/index.html';
const COMPLETE_FORMATS = Object.freeze(['html', 'json', 'csv', 'pdf']);
const ALLOWED_FORMATS = Object.freeze([
  Object.freeze(['html', 'json']),
  Object.freeze(['html', 'json', 'csv']),
  Object.freeze(['html', 'json', 'pdf']),
  COMPLETE_FORMATS,
]);
const SCHEMAS = deepFreeze({
  GET_LAST_AUDIT: ['type'],
  REVIEW_COMMITTED: ['type', 'auditId', 'exportRevision'],
  REQUEST_EXPORT: ['type', 'auditId'],
  REQUEST_DELETE_AUDIT: ['type', 'auditId'],
  REQUEST_DELETE_ALL_AUDITS: ['type'],
  EXPORT_PROGRESS: ['type', 'auditId', 'status', 'message', 'exportRevision', 'exportAttempt', 'leaseOwnerId'],
  EXPORT_FAILED: ['type', 'auditId', 'status', 'error', 'exportRevision', 'exportAttempt', 'leaseOwnerId'],
  EXPORT_BUSY: ['type', 'auditId', 'status', 'error', 'exportRevision', 'exportAttempt', 'leaseOwnerId'],
  EXPORT_INVALIDATED: ['type', 'auditId', 'status', 'error', 'exportRevision', 'exportAttempt', 'leaseOwnerId'],
  EXPORT_COMPLETE: ['type', 'auditId', 'status', 'formats', 'exportRevision', 'exportAttempt', 'leaseOwnerId', 'localAuditDeleted'],
});

const FACTORY_KEYS = [
  'chromeApi', 'readLegacyLastAudit', 'notifyLegacyReviewCommitted', 'queueLegacyExport',
  'deleteLegacyAudit', 'deleteAllLegacyAudits', 'acknowledgeLegacyExportEvent',
];

export function parseLegacyCompatMessage(message) {
  const type = readSafeOwnEnumerableDataType(message);
  if (!type.found || !Object.hasOwn(SCHEMAS, type.value)) return denied('UNKNOWN_MESSAGE');
  const copy = copyExactDataRecord(message, SCHEMAS[type.value]);
  if (!copy) return denied('COMPATIBILITY_DENIED');
  if (copy.type === 'EXPORT_COMPLETE') {
    const formats = copyDenseDataArray(copy.formats);
    if (!formats) return denied('COMPATIBILITY_DENIED');
    copy.formats = formats;
  }
  if (!hasPrimitiveCompatibilityShape(copy)) return denied('COMPATIBILITY_DENIED');
  const byteLength = capturedUtf8Length(copy);
  if (byteLength === null || byteLength > MAX_ENVELOPE_BYTES || !validCompatibilityEnvelope(copy)) {
    return denied('COMPATIBILITY_DENIED');
  }
  return deepFreeze({ ok: true, value: copy });
}

export function createLegacyCompatibilityHandler(options) {
  const input = copyExactDataRecord(options, FACTORY_KEYS);
  if (!input || typeof input.chromeApi?.runtime?.id !== 'string' || !input.chromeApi.runtime.id ||
    typeof input.chromeApi.runtime.getContexts !== 'function' ||
    FACTORY_KEYS.slice(1).some(key => typeof input[key] !== 'function')) {
    throw new TypeError('COMPATIBILITY_HANDLER_INVALID');
  }

  async function dispatch(args) {
    try {
      const request = copyExactDataRecord(args, ['envelope', 'sender']);
      if (!request || !Object.isFrozen(request.envelope)) return compatibilityDenied();
      const parsed = parseLegacyCompatMessage(request.envelope);
      if (!parsed.ok) return compatibilityDenied();
      const envelope = parsed.value;
      if (!await proveCompatibilitySurface(input.chromeApi, request.sender, envelope)) return compatibilityDenied();
      let output;
      if (envelope.type === 'GET_LAST_AUDIT') output = await input.readLegacyLastAudit();
      else if (envelope.type === 'REVIEW_COMMITTED') output = await input.notifyLegacyReviewCommitted({ auditId: envelope.auditId, exportRevision: envelope.exportRevision });
      else if (envelope.type === 'REQUEST_EXPORT') output = await input.queueLegacyExport({ auditId: envelope.auditId });
      else if (envelope.type === 'REQUEST_DELETE_AUDIT') output = await input.deleteLegacyAudit({ auditId: envelope.auditId });
      else if (envelope.type === 'REQUEST_DELETE_ALL_AUDITS') output = await input.deleteAllLegacyAudits();
      else output = await input.acknowledgeLegacyExportEvent({ event: envelope });
      return copyAdapterOutput(envelope, output, input.chromeApi.runtime.id) ?? compatibilityFailed();
    } catch {
      return compatibilityFailed();
    }
  }

  return Object.freeze({ dispatch });
}

function hasPrimitiveCompatibilityShape(value) {
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'formats') {
      if (!Array.isArray(entry) || entry.some(format => typeof format !== 'string')) return false;
    } else if (!['string', 'number', 'boolean'].includes(typeof entry)) return false;
  }
  return true;
}

function validCompatibilityEnvelope(value) {
  if (['GET_LAST_AUDIT', 'REQUEST_DELETE_ALL_AUDITS'].includes(value.type)) return true;
  if (!AUDIT_ID.test(value.auditId ?? '')) return false;
  if (value.type === 'REVIEW_COMMITTED') return validRevision(value.exportRevision);
  if (['REQUEST_EXPORT', 'REQUEST_DELETE_AUDIT'].includes(value.type)) return true;
  if (!validRevision(value.exportRevision) || !validAttempt(value.exportAttempt) ||
    !LEASE_OWNER_ID.test(value.leaseOwnerId ?? '')) return false;
  if (value.type === 'EXPORT_PROGRESS') return value.status === 'running' && validNonemptyProse(value.message);
  if (value.type === 'EXPORT_FAILED') return value.status === 'failed' && validNonemptyProse(value.error);
  if (value.type === 'EXPORT_BUSY') return value.status === 'busy' && validNonemptyProse(value.error);
  if (value.type === 'EXPORT_INVALIDATED') return value.status === 'preparing' && validNonemptyProse(value.error);
  const formats = ALLOWED_FORMATS.some(expected => sameArray(value.formats, expected));
  return ['complete', 'partial'].includes(value.status) && formats && typeof value.localAuditDeleted === 'boolean' &&
    (value.status !== 'complete' || sameArray(value.formats, COMPLETE_FORMATS)) &&
    (value.localAuditDeleted !== true || sameArray(value.formats, COMPLETE_FORMATS));
}

async function proveCompatibilitySurface(chromeApi, sender, envelope) {
  try {
    const id = readOwnData(sender, 'id');
    const documentId = readOwnData(sender, 'documentId');
    const senderUrl = readOwnData(sender, 'url');
    const frameId = readOwnData(sender, 'frameId');
    if (!id.found || id.value !== chromeApi.runtime.id || !documentId.found ||
      typeof documentId.value !== 'string' || !documentId.value || !senderUrl.found ||
      typeof senderUrl.value !== 'string' || !frameId.found || frameId.value !== 0) return false;
    const expected = expectedSurface(envelope);
    const url = new URL(senderUrl.value);
    if (url.protocol !== 'chrome-extension:' || url.hostname !== chromeApi.runtime.id || url.username ||
      url.password || url.port || url.hash || url.pathname !== expected.path || !validSurfaceQuery(url, expected, envelope)) return false;
    const contexts = copyDenseDataArray(await chromeApi.runtime.getContexts({ documentIds: [documentId.value] }));
    if (!contexts) return false;
    const matches = contexts.filter(context => contextMatches(context, documentId.value, senderUrl.value, expected.contextType));
    return matches.length === 1;
  } catch {
    return false;
  }
}

function expectedSurface(envelope) {
  if (['GET_LAST_AUDIT', 'REQUEST_DELETE_ALL_AUDITS'].includes(envelope.type)) return { path: PANEL_PATH, contextType: 'SIDE_PANEL', query: 'none' };
  if (['REVIEW_COMMITTED', 'REQUEST_EXPORT', 'REQUEST_DELETE_AUDIT'].includes(envelope.type)) return { path: REVIEW_PATH, contextType: 'TAB', query: 'audit' };
  return { path: EXPORT_PATH, contextType: 'TAB', query: 'legacy-export' };
}

function validSurfaceQuery(url, expected, envelope) {
  const keys = [...url.searchParams.keys()];
  if (expected.query === 'none') return keys.length === 0 && url.search === '';
  if (expected.query === 'audit') {
    return keys.length === 1 && keys[0] === 'auditId' && url.searchParams.getAll('auditId').length === 1 &&
      url.searchParams.get('auditId') === envelope.auditId;
  }
  return keys.length === 3 && new Set(keys).size === 3 && keys.every(key => ['auditId', 'leaseOwnerId', 'exportAttempt'].includes(key)) &&
    url.searchParams.getAll('auditId').length === 1 && url.searchParams.get('auditId') === envelope.auditId &&
    url.searchParams.getAll('leaseOwnerId').length === 1 && url.searchParams.get('leaseOwnerId') === envelope.leaseOwnerId &&
    url.searchParams.getAll('exportAttempt').length === 1 && url.searchParams.get('exportAttempt') === String(envelope.exportAttempt);
}

function contextMatches(context, documentId, documentUrl, contextType) {
  try {
    const prototype = Object.getPrototypeOf(context);
    if (prototype !== Object.prototype && prototype !== null) return false;
  } catch {
    return false;
  }
  const id = readOwnData(context, 'documentId');
  const url = readOwnData(context, 'documentUrl');
  const type = readOwnData(context, 'contextType');
  const windowId = readOwnData(context, 'windowId');
  if (!id.found || id.value !== documentId || !url.found || url.value !== documentUrl || !type.found ||
    type.value !== contextType || !windowId.found || !safeChromeId(windowId.value)) return false;
  if (contextType === 'TAB') {
    const tabId = readOwnData(context, 'tabId');
    if (!tabId.found || !safeChromeId(tabId.value)) return false;
  }
  return true;
}

function copyAdapterOutput(envelope, output, runtimeId) {
  if (envelope.type === 'GET_LAST_AUDIT') return copyLastAuditResponse(output, runtimeId);
  if (envelope.type === 'REVIEW_COMMITTED') return copyAckResponse(output, true);
  if (envelope.type === 'REQUEST_EXPORT') return copyQueueResponse(output, envelope.auditId);
  if (envelope.type === 'REQUEST_DELETE_AUDIT') return copyDeleteOneResponse(output, envelope.auditId);
  if (envelope.type === 'REQUEST_DELETE_ALL_AUDITS') return copyDeleteAllResponse(output);
  return copyAckResponse(output, false);
}

function copyLastAuditResponse(output, runtimeId) {
  const failure = copyExactDataRecord(output, ['ok', 'code']);
  if (failure && failure.ok === false && failure.code === 'COMPATIBILITY_FAILED') return deepFreeze(failure);
  const response = copyExactDataRecord(output, ['ok', 'state']);
  if (!response || response.ok !== true) return null;
  if (response.state === null) return deepFreeze(response);
  const state = copyLegacyLatest(response.state, runtimeId);
  return state ? deepFreeze({ ok: true, state }) : null;
}

function copyAckResponse(output, allowDenied) {
  const success = copyExactDataRecord(output, ['ok']);
  if (success?.ok === true) return deepFreeze(success);
  const failure = copyExactDataRecord(output, ['ok', 'code']);
  const codes = allowDenied ? ['COMPATIBILITY_DENIED', 'COMPATIBILITY_FAILED'] : ['COMPATIBILITY_FAILED'];
  return failure?.ok === false && codes.includes(failure.code) ? deepFreeze(failure) : null;
}

function copyQueueResponse(output, auditId) {
  const success = copyExactDataRecord(output, ['ok', 'auditId', 'state', 'exportRevision', 'exportAttempt', 'leaseOwnerId']);
  if (success && success.ok === true && success.auditId === auditId && success.state === 'queued' &&
    validRevision(success.exportRevision) && validAttempt(success.exportAttempt) && LEASE_OWNER_ID.test(success.leaseOwnerId ?? '')) {
    return deepFreeze(success);
  }
  const failure = copyExactDataRecord(output, ['ok', 'auditId', 'state', 'code', 'retryable', 'retryAt']);
  if (!failure || failure.ok !== false || failure.auditId !== auditId || failure.retryable !== true ||
    (failure.retryAt !== null && typeof failure.retryAt !== 'string')) return null;
  const expected = {
    busy: 'EXPORT_BUSY',
    stale: 'AUDIT_REVISION_CONFLICT',
    failed: 'EXPORT_PREPARE_FAILED',
  };
  return expected[failure.state] === failure.code ? deepFreeze(failure) : null;
}

function copyDeleteOneResponse(output, auditId) {
  const success = copyExactDataRecord(output, ['ok', 'auditId', 'deleted']);
  if (success && success.ok === true && success.auditId === auditId && success.deleted === true) return deepFreeze(success);
  return copyBusyOrFailed(output);
}

function copyDeleteAllResponse(output) {
  const success = copyExactDataRecord(output, ['ok', 'deleted']);
  if (success && success.ok === true && Number.isSafeInteger(success.deleted) && success.deleted >= 0) return deepFreeze(success);
  return copyBusyOrFailed(output);
}

function copyBusyOrFailed(output) {
  const failure = copyExactDataRecord(output, ['ok', 'code']);
  return failure?.ok === false && ['AUDIT_DELETE_BUSY', 'COMPATIBILITY_FAILED'].includes(failure.code)
    ? deepFreeze(failure)
    : null;
}

function copyLegacyLatest(value, runtimeId) {
  const allowed = [
    'auditId', 'mode', 'status', 'percent', 'message', 'reviewUrl', 'exportStatus', 'exportRevision',
    'exportAttempt', 'leaseOwnerId', 'total', 'pageNumber', 'statusCounts',
  ];
  const state = copyAllowedDataRecord(value, allowed);
  if (!state || !AUDIT_ID.test(state.auditId ?? '') || ![
    'idle', 'validating', 'queued', 'running', 'cancelling', 'complete', 'partial', 'failed', 'cancelled', 'paused',
  ].includes(state.status)) return null;
  if (Object.hasOwn(state, 'mode') && !['single', 'batch'].includes(state.mode)) return null;
  if (Object.hasOwn(state, 'percent') && (typeof state.percent !== 'number' || !Number.isFinite(state.percent) || state.percent < 0 || state.percent > 100)) return null;
  if (Object.hasOwn(state, 'message') && (typeof state.message !== 'string' || codePoints(state.message) > 512)) return null;
  if (Object.hasOwn(state, 'reviewUrl') && !validReviewUrl(state.reviewUrl, runtimeId, state.auditId)) return null;
  if (Object.hasOwn(state, 'exportStatus') && ![
    'unavailable', 'preparing', 'queued', 'running', 'delivering', 'complete', 'partial', 'failed', 'busy',
  ].includes(state.exportStatus)) return null;
  if (Object.hasOwn(state, 'exportRevision') && !validRevision(state.exportRevision)) return null;
  if (Object.hasOwn(state, 'exportAttempt') && !validAttempt(state.exportAttempt)) return null;
  if (Object.hasOwn(state, 'leaseOwnerId') && !LEASE_OWNER_ID.test(state.leaseOwnerId ?? '')) return null;
  if (Object.hasOwn(state, 'total') && (!Number.isSafeInteger(state.total) || state.total < 1 || state.total > 20 || state.mode !== 'batch')) return null;
  if (Object.hasOwn(state, 'pageNumber') && (!Number.isSafeInteger(state.pageNumber) || !Number.isSafeInteger(state.total) || state.pageNumber < 0 || state.pageNumber > state.total)) return null;
  if (Object.hasOwn(state, 'statusCounts')) {
    if (!Number.isSafeInteger(state.total)) return null;
    const counts = copyExactDataRecord(state.statusCounts, ['cancelled', 'complete', 'failed', 'partial']);
    if (!counts || Object.values(counts).some(count => !Number.isSafeInteger(count) || count < 0 || count > 20) ||
      Object.values(counts).reduce((sum, count) => sum + count, 0) > state.total) return null;
    state.statusCounts = counts;
  }
  return deepFreeze(state);
}

function copyAllowedDataRecord(value, allowedKeys) {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return null;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some(key => typeof key !== 'string' || !allowedKeys.includes(key))) return null;
    const copy = {};
    for (const key of ownKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) return null;
      copy[key] = descriptor.value;
    }
    return copy;
  } catch {
    return null;
  }
}

function validReviewUrl(value, runtimeId, auditId) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    const keys = [...url.searchParams.keys()];
    return url.protocol === 'chrome-extension:' && url.hostname === runtimeId && !url.username && !url.password &&
      !url.port && !url.hash && url.pathname === REVIEW_PATH && keys.length === 1 && keys[0] === 'auditId' &&
      url.searchParams.getAll('auditId').length === 1 && url.searchParams.get('auditId') === auditId;
  } catch {
    return false;
  }
}

function readOwnData(value, key) {
  try {
    if (value === null || typeof value !== 'object') return { found: false };
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable === true && Object.hasOwn(descriptor, 'value')
      ? { found: true, value: descriptor.value }
      : { found: false };
  } catch {
    return { found: false };
  }
}

function validRevision(value) { return Number.isSafeInteger(value) && value >= 0; }
function validAttempt(value) { return Number.isSafeInteger(value) && value >= 1; }
function safeChromeId(value) { return Number.isSafeInteger(value) && value >= 0; }
function validNonemptyProse(value) { return typeof value === 'string' && codePoints(value) >= 1 && codePoints(value) <= 512; }
function codePoints(value) { return [...value].length; }
function sameArray(value, expected) { return value.length === expected.length && value.every((entry, index) => entry === expected[index]); }
function denied(code) { return Object.freeze({ ok: false, code }); }
function compatibilityDenied() { return Object.freeze({ ok: false, code: 'COMPATIBILITY_DENIED' }); }
function compatibilityFailed() { return Object.freeze({ ok: false, code: 'COMPATIBILITY_FAILED' }); }
