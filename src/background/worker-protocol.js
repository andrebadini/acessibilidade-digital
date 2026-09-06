const MAX_ENVELOPE_BYTES = 4096;
const MAX_REVIEW_DECISION_ENVELOPE_BYTES = 24 * 1024;
const MAX_BATCH_ENVELOPE_BYTES = 164 * 1024;
const OPAQUE_ID = /^[A-Za-z0-9_-]{20,240}$/u;
const AUDIT_ID = /^[A-Za-z0-9._:-]{1,160}$/u;
const REVIEW_ID = /^[A-Za-z0-9._:-]{1,200}$/u;
const PERSONA_MODES = new Set(['reader', 'achromatopsia', 'motor']);
const READER_ACTIONS = new Set(['previous', 'repeat', 'pause', 'resume', 'next', 'stop']);
const AUTONOMOUS_PERSONA_REASONS = new Set(['emergency-stop', 'lifecycle-stop', 'reader-terminal']);
const REVIEW_ANSWERS = new Set(['conforme', 'não conforme', 'não foi possível determinar']);
const REVIEW_MODES = new Set(['assisted', 'manual']);
const HIGHLIGHT_NONCE = /^[A-Za-z0-9_-]{22}$/u;
const CONSENT_ID = /^[A-Za-z0-9_-]{21}[AQgw]$/u;
const CAPTURE_MODES = new Set(['full-evidence', 'element-only', 'no-pixels']);
const PIXEL_CAPTURE_MODES = new Set(['full-evidence', 'element-only']);
const PANEL_PORT_TYPES = new Set([
  'PREPARE_PANEL_CAPABILITY', 'PREPARE_PANEL_NAVIGATION_CAPABILITY', 'PREPARE_PANEL_PERSONA_CAPABILITY',
  'PANEL_START_ATTACHED_AUDIT', 'PANEL_START_URL_AUDIT', 'PANEL_START_BATCH_AUDIT',
  'CONFIRM_PIXEL_CAPTURE', 'PANEL_CONFIRM_PIXEL_CAPTURE',
  'PANEL_START_PERSONA', 'PANEL_REHYDRATE_PERSONA',
  'PANEL_SET_PERSONA_MODE', 'PANEL_READER_STATE', 'PANEL_READER_ACTION',
  'PANEL_READER_ENABLE_VOICE',
  'PANEL_STOP_PERSONA', 'PANEL_CANCEL_AUDIT',
  'PANEL_OPEN_REPORT', 'PANEL_REHYDRATE_VIEW',
  'PANEL_SHOW_PAGE_MARKERS', 'PANEL_HIDE_PAGE_MARKERS',
  'PANEL_SELECT_PAGE_MARKER', 'PANEL_FILTER_PAGE_MARKERS',
]);
const SHARED_HIGHLIGHT_TYPES = new Set([
  'GET_HIGHLIGHT_STATE', 'GET_HIGHLIGHT_AVAILABILITY', 'HIGHLIGHT_OCCURRENCE', 'CLEAR_HIGHLIGHT',
]);

const MESSAGE_SCHEMAS = deepFreeze({
  PREPARE_PANEL_CAPABILITY: ['type', 'requestId', 'windowId'],
  PREPARE_PANEL_NAVIGATION_CAPABILITY: ['type', 'requestId', 'intent', 'windowId'],
  PREPARE_PANEL_PERSONA_CAPABILITY: ['type', 'requestId', 'windowId'],
  PANEL_START_ATTACHED_AUDIT: ['type', 'capabilityId', 'captureMode', 'includeQuery', 'deleteAfterCompleteExport', 'windowId'],
  PANEL_START_URL_AUDIT: ['type', 'capabilityId', 'url', 'captureMode', 'includeQuery', 'deleteAfterCompleteExport', 'windowId'],
  PANEL_START_BATCH_AUDIT: ['type', 'capabilityId', 'urls', 'captureMode', 'includeQuery', 'deleteAfterCompleteExport', 'windowId'],
  CONFIRM_PIXEL_CAPTURE: ['type', 'sessionCapabilityId', 'auditId', 'consentId', 'mode', 'accepted', 'windowId'],
  PANEL_CONFIRM_PIXEL_CAPTURE: ['type', 'sessionCapabilityId', 'auditId', 'mode', 'accepted', 'windowId'],
  PANEL_START_PERSONA: ['type', 'capabilityId', 'mode', 'windowId'],
  PANEL_REHYDRATE_PERSONA: ['type', 'capabilityId', 'windowId'],
  PANEL_SET_PERSONA_MODE: ['type', 'leaseId', 'mode', 'windowId'],
  PANEL_READER_STATE: ['type', 'leaseId', 'windowId'],
  PANEL_READER_ACTION: ['type', 'leaseId', 'action', 'windowId'],
  PANEL_READER_ENABLE_VOICE: ['type', 'leaseId', 'windowId'],
  PANEL_STOP_PERSONA: ['type', 'leaseId', 'windowId'],
  PANEL_CANCEL_AUDIT: ['type', 'sessionCapabilityId', 'auditId', 'windowId'],
  PANEL_OPEN_REPORT: ['type', 'sessionCapabilityId', 'auditId', 'windowId'],
  PANEL_SHOW_PAGE_MARKERS: ['type', 'sessionCapabilityId', 'auditId', 'windowId', 'modelRevision'],
  PANEL_HIDE_PAGE_MARKERS: ['type', 'sessionCapabilityId', 'auditId', 'windowId', 'modelRevision'],
  PANEL_SELECT_PAGE_MARKER: ['type', 'sessionCapabilityId', 'auditId', 'windowId', 'modelRevision', 'ordinal', 'scroll'],
  PANEL_FILTER_PAGE_MARKERS: ['type', 'sessionCapabilityId', 'auditId', 'windowId', 'modelRevision', 'visibleOrdinals'],
  REPORT_REQUEST_EXPORT: ['type', 'sessionCapabilityId', 'auditId'],
  REPORT_RETURN_TO_SOURCE: ['type', 'sessionCapabilityId', 'auditId'],
  REPORT_COMMIT_REVIEW_DECISION: [
    'type', 'sessionCapabilityId', 'auditId', 'itemId', 'occurrenceId',
    'answer', 'evaluator', 'decidedAt', 'mode', 'note',
  ],
  REPORT_DELETE_AUDIT: ['type', 'sessionCapabilityId', 'auditId'],
  REPORT_DELETE_ALL_AUDITS: ['type', 'sessionCapabilityId', 'auditId'],
  GET_HIGHLIGHT_STATE: ['type', 'sessionCapabilityId', 'auditId'],
  GET_HIGHLIGHT_AVAILABILITY: ['type', 'sessionCapabilityId', 'auditId', 'occurrenceId'],
  HIGHLIGHT_OCCURRENCE: ['type', 'sessionCapabilityId', 'auditId', 'occurrenceId'],
  CLEAR_HIGHLIGHT: ['type', 'sessionCapabilityId', 'auditId'],
  AUDITA_HIGHLIGHT_INVALIDATED: ['type', 'nonce'],
  AUDITA_PERSONA_AUTONOMOUS_STOP: ['type', 'leaseId', 'reason'],
  PANEL_REHYDRATE_VIEW: ['type', 'auditId', 'windowId'],
  REPORT_CONNECT: ['type', 'auditId'],
  EXPORT_CONNECT: ['type', 'auditId'],
  EXPORT_COMPLETE: ['type', 'sessionCapabilityId', 'auditId', 'attemptId'],
});

export function parseWorkerMessage(message) {
  const type = readSafeOwnEnumerableDataType(message);
  if (!type.found || !Object.hasOwn(MESSAGE_SCHEMAS, type.value)) return failure('UNKNOWN_MESSAGE');
  const copy = copyExactDataRecord(message, MESSAGE_SCHEMAS[type.value]) ??
    (type.value === 'REPORT_REQUEST_EXPORT'
      ? copyExactDataRecord(message, [...MESSAGE_SCHEMAS[type.value], 'deleteAfterCompleteExport']) : null);
  if (!copy) return failure('INVALID_MESSAGE');
  if (!hasFlatPrimitiveShape(copy)) return failure('INVALID_MESSAGE');
  const byteLength = capturedUtf8Length(copy);
  if (byteLength === null) return failure('INVALID_MESSAGE');
  const maximumBytes = copy.type === 'REPORT_COMMIT_REVIEW_DECISION'
    ? MAX_REVIEW_DECISION_ENVELOPE_BYTES
    : copy.type === 'PANEL_START_BATCH_AUDIT'
      ? MAX_BATCH_ENVELOPE_BYTES
      : MAX_ENVELOPE_BYTES;
  if (byteLength > maximumBytes) return failure('MESSAGE_TOO_LARGE');
  if (!validWorkerEnvelope(copy)) return failure('INVALID_MESSAGE');
  return deepFreeze({ ok: true, value: copy });
}

export function parsePanelPortIntent(message, windowId) {
  const type = readSafeOwnEnumerableDataType(message);
  if (!type.found || (!PANEL_PORT_TYPES.has(type.value) && !SHARED_HIGHLIGHT_TYPES.has(type.value)) || !safeChromeId(windowId)) {
    return failure('INVALID_MESSAGE');
  }
  const panelOnly = PANEL_PORT_TYPES.has(type.value);
  const expected = panelOnly
    ? MESSAGE_SCHEMAS[type.value].filter(key => key !== 'windowId')
    : MESSAGE_SCHEMAS[type.value];
  const copy = copyExactDataRecord(message, expected);
  if (!copy) return failure('INVALID_MESSAGE');
  const parsed = parseWorkerMessage(panelOnly ? { ...copy, windowId } : copy);
  return parsed.ok ? parsed : failure(parsed.code === 'MESSAGE_TOO_LARGE' ? 'MESSAGE_TOO_LARGE' : 'INVALID_MESSAGE');
}

export function isPanelPortIntent(message) {
  const type = readSafeOwnEnumerableDataType(message);
  return type.found && PANEL_PORT_TYPES.has(type.value);
}

function hasFlatPrimitiveShape(value) {
  return Object.values(value).every(entry => ['string', 'boolean', 'number'].includes(typeof entry));
}

function validWorkerEnvelope(value) {
  if (['PANEL_SHOW_PAGE_MARKERS', 'PANEL_HIDE_PAGE_MARKERS', 'PANEL_SELECT_PAGE_MARKER', 'PANEL_FILTER_PAGE_MARKERS'].includes(value.type)) {
    if (!validOpaqueId(value.sessionCapabilityId) || !validAuditId(value.auditId) || !safeChromeId(value.windowId) ||
      !Number.isSafeInteger(value.modelRevision) || value.modelRevision < 1) return false;
    if (value.type === 'PANEL_SELECT_PAGE_MARKER') return validMarkerOrdinal(value.ordinal) && typeof value.scroll === 'boolean';
    if (value.type === 'PANEL_FILTER_PAGE_MARKERS') return validMarkerFilter(value.visibleOrdinals);
    return true;
  }
  if (value.type === 'PREPARE_PANEL_NAVIGATION_CAPABILITY') {
    return validAuditId(value.requestId) && ['single', 'batch'].includes(value.intent) && safeChromeId(value.windowId);
  }
  if (['PREPARE_PANEL_CAPABILITY', 'PREPARE_PANEL_PERSONA_CAPABILITY'].includes(value.type)) {
    return validAuditId(value.requestId) && safeChromeId(value.windowId);
  }
  if (value.type === 'PANEL_START_ATTACHED_AUDIT') {
    return validOpaqueId(value.capabilityId) && CAPTURE_MODES.has(value.captureMode) &&
      value.includeQuery === false && value.deleteAfterCompleteExport === false && safeChromeId(value.windowId);
  }
  if (value.type === 'PANEL_START_URL_AUDIT') {
    return validOpaqueId(value.capabilityId) && boundedCanonicalText(value.url, 2_048, false) &&
      CAPTURE_MODES.has(value.captureMode) && value.includeQuery === false &&
      value.deleteAfterCompleteExport === false && safeChromeId(value.windowId);
  }
  if (value.type === 'PANEL_START_BATCH_AUDIT') {
    return validOpaqueId(value.capabilityId) && boundedCanonicalText(value.urls, 41_000, false) &&
      CAPTURE_MODES.has(value.captureMode) && value.includeQuery === false &&
      value.deleteAfterCompleteExport === false && safeChromeId(value.windowId);
  }
  if (value.type === 'CONFIRM_PIXEL_CAPTURE') {
    return validOpaqueId(value.sessionCapabilityId) && validAuditId(value.auditId) &&
      CONSENT_ID.test(value.consentId ?? '') && PIXEL_CAPTURE_MODES.has(value.mode) &&
      value.accepted === true && safeChromeId(value.windowId);
  }
  if (value.type === 'PANEL_CONFIRM_PIXEL_CAPTURE') {
    return validOpaqueId(value.sessionCapabilityId) && validAuditId(value.auditId) &&
      PIXEL_CAPTURE_MODES.has(value.mode) && value.accepted === true && safeChromeId(value.windowId);
  }
  if (value.type === 'PANEL_START_PERSONA') {
    return validOpaqueId(value.capabilityId) && PERSONA_MODES.has(value.mode) && safeChromeId(value.windowId);
  }
  if (value.type === 'PANEL_REHYDRATE_PERSONA') {
    return validOpaqueId(value.capabilityId) && safeChromeId(value.windowId);
  }
  if (value.type === 'PANEL_SET_PERSONA_MODE') {
    return validOpaqueId(value.leaseId) && PERSONA_MODES.has(value.mode) && safeChromeId(value.windowId);
  }
  if (['PANEL_READER_STATE', 'PANEL_READER_ENABLE_VOICE'].includes(value.type)) {
    return validOpaqueId(value.leaseId) && safeChromeId(value.windowId);
  }
  if (value.type === 'PANEL_READER_ACTION') {
    return validOpaqueId(value.leaseId) && READER_ACTIONS.has(value.action) && safeChromeId(value.windowId);
  }
  if (value.type === 'PANEL_STOP_PERSONA') {
    return validOpaqueId(value.leaseId) && safeChromeId(value.windowId);
  }
  if (['PANEL_CANCEL_AUDIT', 'PANEL_OPEN_REPORT'].includes(value.type)) {
    return validOpaqueId(value.sessionCapabilityId) && validAuditId(value.auditId) &&
      safeChromeId(value.windowId);
  }
  if (['REPORT_REQUEST_EXPORT', 'REPORT_RETURN_TO_SOURCE', 'REPORT_DELETE_AUDIT', 'REPORT_DELETE_ALL_AUDITS'].includes(value.type)) {
    return validOpaqueId(value.sessionCapabilityId) && validAuditId(value.auditId) &&
      (!Object.hasOwn(value, 'deleteAfterCompleteExport') || typeof value.deleteAfterCompleteExport === 'boolean');
  }
  if (['GET_HIGHLIGHT_AVAILABILITY', 'HIGHLIGHT_OCCURRENCE'].includes(value.type)) {
    return validOpaqueId(value.sessionCapabilityId) && validAuditId(value.auditId) && validReviewId(value.occurrenceId);
  }
  if (['GET_HIGHLIGHT_STATE', 'CLEAR_HIGHLIGHT'].includes(value.type)) {
    return validOpaqueId(value.sessionCapabilityId) && validAuditId(value.auditId);
  }
  if (value.type === 'AUDITA_HIGHLIGHT_INVALIDATED') return HIGHLIGHT_NONCE.test(value.nonce ?? '');
  if (value.type === 'AUDITA_PERSONA_AUTONOMOUS_STOP') {
    return validOpaqueId(value.leaseId) && /^lease-[A-Za-z0-9_-]{22}$/u.test(value.leaseId) &&
      AUTONOMOUS_PERSONA_REASONS.has(value.reason);
  }
  if (value.type === 'REPORT_COMMIT_REVIEW_DECISION') {
    return validOpaqueId(value.sessionCapabilityId) && validAuditId(value.auditId) &&
      validReviewId(value.itemId) && validReviewId(value.occurrenceId) &&
      REVIEW_ANSWERS.has(value.answer) && REVIEW_MODES.has(value.mode) &&
      canonicalInstant(value.decidedAt) && boundedCanonicalText(value.evaluator, 160, false) &&
      boundedCanonicalText(value.note, 4_000, true);
  }
  if (value.type === 'EXPORT_COMPLETE') {
    return validOpaqueId(value.sessionCapabilityId) && validAuditId(value.auditId) && validAttemptId(value.attemptId);
  }
  if (value.type === 'PANEL_REHYDRATE_VIEW') {
    return validAuditId(value.auditId) && safeChromeId(value.windowId);
  }
  return validAuditId(value.auditId);
}

function validOpaqueId(value) { return typeof value === 'string' && OPAQUE_ID.test(value); }
function validMarkerOrdinal(value) { return Number.isSafeInteger(value) && value >= 0 && value < 64; }
function validMarkerFilter(value) {
  if (typeof value !== 'string' || value.length > 181) return false;
  if (value === '') return true;
  const parts = value.split(',');
  return parts.every((part, index) => {
    const ordinal = Number(part);
    return validMarkerOrdinal(ordinal) && String(ordinal) === part && (index === 0 || ordinal > Number(parts[index - 1]));
  });
}
function validAuditId(value) { return typeof value === 'string' && AUDIT_ID.test(value); }
function validReviewId(value) { return typeof value === 'string' && REVIEW_ID.test(value); }
function canonicalInstant(value) {
  if (typeof value !== 'string' || value === '') return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}
function boundedCanonicalText(value, maximum, optional) {
  if (typeof value !== 'string' || value !== value.trim() || (!optional && value === '')) return false;
  let count = 0;
  for (const _character of value) {
    count += 1;
    if (count > maximum) return false;
  }
  return true;
}
function validAttemptId(value) {
  return typeof value === 'string' && /^(?:[1-9][0-9]*)$/u.test(value) && Number.isSafeInteger(Number(value));
}
function safeChromeId(value) { return Number.isSafeInteger(value) && value >= 0; }

export function readSafeOwnEnumerableDataType(value) {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return { found: false };
    const descriptor = Object.getOwnPropertyDescriptor(value, 'type');
    if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value') ||
      typeof descriptor.value !== 'string') return { found: false };
    return { found: true, value: descriptor.value };
  } catch {
    return { found: false };
  }
}

export function copyExactDataRecord(value, expectedKeys) {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) return null;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== expectedKeys.length || ownKeys.some(key => typeof key !== 'string' || !expectedKeys.includes(key))) {
      return null;
    }
    const copy = {};
    for (const key of expectedKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) return null;
      copy[key] = descriptor.value;
    }
    return copy;
  } catch {
    return null;
  }
}

export function copyDenseDataArray(value) {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
    const length = Object.getOwnPropertyDescriptor(value, 'length');
    if (!length || !Object.hasOwn(length, 'value') || !Number.isSafeInteger(length.value) || length.value < 0) return null;
    const ownKeys = Reflect.ownKeys(value);
    const expected = Array.from({ length: length.value }, (_, index) => String(index));
    if (ownKeys.length !== expected.length + 1 || !ownKeys.includes('length') ||
      ownKeys.some(key => typeof key !== 'string' || (key !== 'length' && !expected.includes(key)))) return null;
    const copy = [];
    for (const key of expected) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) return null;
      copy.push(descriptor.value);
    }
    return copy;
  } catch {
    return null;
  }
}

export function capturedUtf8Length(value) {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return null;
  }
}

export function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function failure(code) { return Object.freeze({ ok: false, code }); }
