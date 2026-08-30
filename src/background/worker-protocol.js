const MAX_ENVELOPE_BYTES = 4096;
const OPAQUE_ID = /^[A-Za-z0-9_-]{20,240}$/u;
const AUDIT_ID = /^[A-Za-z0-9._:-]{1,160}$/u;
const PERSONA_MODES = new Set(['reader', 'achromatopsia', 'motor']);

const MESSAGE_SCHEMAS = deepFreeze({
  PREPARE_POPUP_CAPABILITIES: ['type', 'requestId'],
  PREPARE_PANEL_CAPABILITY: ['type', 'requestId'],
  POPUP_START_AUDIT: ['type', 'capabilityId', 'captureMode', 'includeQuery', 'deleteAfterCompleteExport'],
  PANEL_START_ATTACHED_AUDIT: ['type', 'capabilityId', 'captureMode', 'includeQuery', 'deleteAfterCompleteExport'],
  POPUP_START_PERSONA: ['type', 'capabilityId', 'mode'],
  PANEL_CANCEL_AUDIT: ['type', 'sessionCapabilityId', 'auditId'],
  PANEL_OPEN_REPORT: ['type', 'sessionCapabilityId', 'auditId'],
  REPORT_REQUEST_EXPORT: ['type', 'sessionCapabilityId', 'auditId'],
  PANEL_REHYDRATE_VIEW: ['type', 'auditId'],
  REPORT_CONNECT: ['type', 'auditId'],
  EXPORT_CONNECT: ['type', 'auditId'],
  EXPORT_COMPLETE: ['type', 'sessionCapabilityId', 'auditId', 'attemptId'],
});

export function parseWorkerMessage(message) {
  const type = readSafeOwnEnumerableDataType(message);
  if (!type.found || !Object.hasOwn(MESSAGE_SCHEMAS, type.value)) return failure('UNKNOWN_MESSAGE');
  const copy = copyExactDataRecord(message, MESSAGE_SCHEMAS[type.value]);
  if (!copy) return failure('INVALID_MESSAGE');
  if (!hasFlatPrimitiveShape(copy)) return failure('INVALID_MESSAGE');
  const byteLength = capturedUtf8Length(copy);
  if (byteLength === null) return failure('INVALID_MESSAGE');
  if (byteLength > MAX_ENVELOPE_BYTES) return failure('MESSAGE_TOO_LARGE');
  if (!validWorkerEnvelope(copy)) return failure('INVALID_MESSAGE');
  return deepFreeze({ ok: true, value: copy });
}

function hasFlatPrimitiveShape(value) {
  return Object.values(value).every(entry => ['string', 'boolean'].includes(typeof entry));
}

function validWorkerEnvelope(value) {
  if (['PREPARE_POPUP_CAPABILITIES', 'PREPARE_PANEL_CAPABILITY'].includes(value.type)) {
    return AUDIT_ID.test(value.requestId ?? '');
  }
  if (['POPUP_START_AUDIT', 'PANEL_START_ATTACHED_AUDIT'].includes(value.type)) {
    return OPAQUE_ID.test(value.capabilityId ?? '') && value.captureMode === 'no-pixels' &&
      value.includeQuery === false && value.deleteAfterCompleteExport === false;
  }
  if (value.type === 'POPUP_START_PERSONA') {
    return OPAQUE_ID.test(value.capabilityId ?? '') && PERSONA_MODES.has(value.mode);
  }
  if (['PANEL_CANCEL_AUDIT', 'PANEL_OPEN_REPORT', 'REPORT_REQUEST_EXPORT'].includes(value.type)) {
    return OPAQUE_ID.test(value.sessionCapabilityId ?? '') && AUDIT_ID.test(value.auditId ?? '');
  }
  if (value.type === 'EXPORT_COMPLETE') {
    return OPAQUE_ID.test(value.sessionCapabilityId ?? '') && AUDIT_ID.test(value.auditId ?? '') &&
      /^(?:[1-9][0-9]*)$/u.test(value.attemptId ?? '') && Number.isSafeInteger(Number(value.attemptId));
  }
  return AUDIT_ID.test(value.auditId ?? '');
}

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
