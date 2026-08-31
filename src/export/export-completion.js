const AUDIT_ID = /^[A-Za-z0-9._:-]{1,200}$/u;
const CAPABILITY = /^[A-Za-z0-9_-]{22,128}$/u;
const ATTEMPT = /^[1-9][0-9]*$/u;
const BURST_SIZE = 3;

export async function awaitExportCompletionAcknowledgement(request, dependencies, options = undefined) {
  const captured = captureRequest(request);
  const send = ownMethod(dependencies, 'send');
  const wait = ownMethod(dependencies, 'wait');
  if (!send || !wait) throw new TypeError('Confirmação local da exportação indisponível.');
  const policy = capturePolicy(options);
  const message = Object.freeze({ type: 'EXPORT_COMPLETE', ...captured });
  let retryDelayMs = policy.initialRetryDelayMs;

  for (;;) {
    for (let attempt = 0; attempt < BURST_SIZE; attempt += 1) {
      let response;
      try {
        const outcome = await settleWithin(
          Promise.resolve().then(() => Reflect.apply(send, dependencies, [message])),
          policy.requestTimeoutMs,
        );
        response = outcome.status === 'fulfilled' ? captureTerminalAck(outcome.value, captured.auditId) : null;
      } catch { response = null; }
      if (response) return response;
    }
    try {
      await settleWithin(
        Promise.resolve().then(() => Reflect.apply(wait, dependencies, [retryDelayMs])),
        Math.max(policy.requestTimeoutMs, retryDelayMs + policy.requestTimeoutMs),
      );
    } catch { /* a failed delay cannot surrender a durable completion receipt */ }
    retryDelayMs = Math.min(policy.maxRetryDelayMs, retryDelayMs * 2);
  }
}

function captureRequest(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Reflect.getPrototypeOf(value))) throw new TypeError();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const expected = ['auditId', 'sessionCapabilityId', 'attemptId'];
    if (Reflect.ownKeys(descriptors).length !== expected.length || expected.some(key => {
      const descriptor = descriptors[key];
      return !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value');
    })) throw new TypeError();
    const auditId = descriptors.auditId.value;
    const sessionCapabilityId = descriptors.sessionCapabilityId.value;
    const attemptId = descriptors.attemptId.value;
    if (!AUDIT_ID.test(auditId ?? '') || !CAPABILITY.test(sessionCapabilityId ?? '') || !ATTEMPT.test(attemptId ?? '')) {
      throw new TypeError();
    }
    return Object.freeze({ sessionCapabilityId, auditId, attemptId });
  } catch {
    throw new TypeError('Identidade da confirmação de exportação inválida.');
  }
}

function captureTerminalAck(value, auditId) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Reflect.getPrototypeOf(value))) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const expected = ['ok', 'auditId', 'state'];
    if (Reflect.ownKeys(descriptors).length !== expected.length || expected.some(key => {
      const descriptor = descriptors[key];
      return !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value');
    })) return null;
    if (descriptors.ok.value !== true || descriptors.auditId.value !== auditId || descriptors.state.value !== 'terminal') return null;
    structuredClone(value);
    return Object.freeze({ ok: true, auditId, state: 'terminal' });
  } catch {
    return null;
  }
}

function ownMethod(value, key) {
  try {
    const descriptor = value && (typeof value === 'object' || typeof value === 'function')
      ? Reflect.getOwnPropertyDescriptor(value, key)
      : null;
    return descriptor && Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'function'
      ? descriptor.value
      : null;
  } catch {
    return null;
  }
}

function capturePolicy(options) {
  const defaults = { requestTimeoutMs: 5_000, initialRetryDelayMs: 250, maxRetryDelayMs: 5_000 };
  if (options === undefined) return defaults;
  try {
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError();
    const descriptors = Object.getOwnPropertyDescriptors(options);
    const allowed = new Set(Object.keys(defaults));
    if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !allowed.has(key))) throw new TypeError();
    const policy = { ...defaults };
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value') ||
        !Number.isFinite(descriptor.value) || descriptor.value <= 0) throw new TypeError();
      policy[key] = descriptor.value;
    }
    if (policy.initialRetryDelayMs > policy.maxRetryDelayMs) throw new TypeError();
    return policy;
  } catch {
    throw new TypeError('Política da confirmação de exportação inválida.');
  }
}

function settleWithin(promise, timeoutMs) {
  return new Promise(resolve => {
    let settled = false;
    let timer;
    const finish = outcome => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    Promise.resolve(promise).then(
      value => finish({ status: 'fulfilled', value }),
      () => finish({ status: 'rejected' }),
    );
    timer = setTimeout(() => finish({ status: 'timeout' }), timeoutMs);
  });
}
