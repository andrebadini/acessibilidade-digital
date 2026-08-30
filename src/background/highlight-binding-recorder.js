const AUDIT_ID = /^[A-Za-z0-9._:-]{1,200}$/u;

function exactDataRecord(value, expectedKeys) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== expectedKeys.length || keys.some(key => typeof key !== 'string') ||
      expectedKeys.some(key => !keys.includes(key))) return null;
    const output = Object.create(null);
    for (const key of expectedKeys) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      output[key] = descriptor.value;
    }
    return output;
  } catch {
    return null;
  }
}

function ownMethod(value, name) {
  try {
    const descriptor = value && typeof value === 'object'
      ? Reflect.getOwnPropertyDescriptor(value, name)
      : null;
    return descriptor?.enumerable && Object.hasOwn(descriptor, 'value') &&
      typeof descriptor.value === 'function' ? descriptor.value : null;
  } catch {
    return null;
  }
}

function validRequest(value) {
  const request = exactDataRecord(value, ['snapshot', 'observedTarget']);
  const auditId = request?.snapshot?.model?.auditId;
  return request && request.snapshot && typeof request.snapshot === 'object' &&
    request.observedTarget && typeof request.observedTarget === 'object' &&
    typeof auditId === 'string' && AUDIT_ID.test(auditId)
    ? { ...request, auditId }
    : null;
}

export function createHighlightBindingRecorder(raw = undefined) {
  const options = exactDataRecord(raw, [
    'bindingStore', 'chromeAdapter', 'digestManager', 'now', 'recordBinding', 'scheduleExpiry',
  ]);
  const put = ownMethod(options?.bindingStore, 'put');
  const deleteAudit = ownMethod(options?.bindingStore, 'deleteAudit');
  if (!options || !put || !deleteAudit || !options.chromeAdapter || !options.digestManager ||
    typeof options.now !== 'function' || typeof options.recordBinding !== 'function' ||
    typeof options.scheduleExpiry !== 'function') {
    throw new TypeError('HIGHLIGHT_BINDING_RECORDER_INVALID');
  }

  async function record(rawRequest) {
    const request = validRequest(rawRequest);
    if (!request) throw new TypeError('HIGHLIGHT_BINDING_RECORD_INPUT_INVALID');
    const input = Object.freeze({
      snapshot: request.snapshot,
      observedTarget: request.observedTarget,
      chromeAdapter: options.chromeAdapter,
      digestManager: options.digestManager,
      now: options.now,
    });
    let binding;
    try {
      binding = await options.recordBinding(input);
    } catch {
      throw new Error('HIGHLIGHT_BINDING_RECORD_FAILED');
    }
    if (binding === null) return null;

    try {
      const persisted = await Reflect.apply(put, options.bindingStore, [binding]);
      if (!persisted || persisted.auditId !== request.auditId ||
        !Number.isSafeInteger(persisted.expiresAt) || persisted.expiresAt < 0) {
        throw new Error('persisted binding mismatch');
      }
      await options.scheduleExpiry();
      return persisted;
    } catch {
      try {
        await Reflect.apply(deleteAudit, options.bindingStore, [request.auditId]);
      } catch {
        throw new Error('HIGHLIGHT_BINDING_CLEANUP_UNCONFIRMED');
      }
      throw new Error('HIGHLIGHT_BINDING_RECORD_FAILED');
    }
  }

  return Object.freeze({ record });
}
