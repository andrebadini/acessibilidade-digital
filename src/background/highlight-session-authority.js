const DENIED = Object.freeze({ ok: false, code: 'SESSION_INTENT_DENIED' });
const SESSION_ID = /^[A-Za-z0-9_-]{20,240}$/u;
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

function safeChromeId(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function safeSender(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function validRequest(value) {
  const record = exactDataRecord(value, ['sessionCapabilityId', 'auditId', 'intent', 'sender']);
  return record && typeof record.sessionCapabilityId === 'string' && SESSION_ID.test(record.sessionCapabilityId) &&
    typeof record.auditId === 'string' && AUDIT_ID.test(record.auditId) &&
    record.intent === 'highlight' && record.sender && typeof record.sender === 'object'
    ? record
    : null;
}

export function createHighlightSessionAuthorityBridge(raw = undefined) {
  const options = exactDataRecord(raw, ['authority', 'reportLaunch']);
  const authorize = ownMethod(options?.authority, 'authorizeSession');
  const authorizeReport = ownMethod(options?.reportLaunch, 'authorizeIntent');
  if (!options || !authorize || !authorizeReport) throw new TypeError('HIGHLIGHT_SESSION_AUTHORITY_INVALID');

  const contexts = new WeakMap();

  function createToken(context) {
    const token = Object.freeze(Object.create(null));
    contexts.set(token, Object.freeze(context));
    return token;
  }

  function createPanelSender(rawContext) {
    const context = exactDataRecord(rawContext, ['sender', 'windowId']);
    if (!context || !safeSender(context.sender) || !safeChromeId(context.windowId)) return DENIED;
    return createToken({ consumer: 'panel', sender: context.sender, claimedWindowId: context.windowId });
  }

  function createReviewSender(rawContext) {
    const context = exactDataRecord(rawContext, ['sender']);
    if (!context || !safeSender(context.sender)) return DENIED;
    return createToken({ consumer: 'review', sender: context.sender });
  }

  const sessionAuthority = Object.freeze({
    async authorizeSession(rawRequest) {
      const request = validRequest(rawRequest);
      const context = request ? contexts.get(request.sender) : null;
      if (!context) return DENIED;
      try {
        if (context.consumer === 'review') {
          const result = await Reflect.apply(authorizeReport, options.reportLaunch, [{
            sessionCapabilityId: request.sessionCapabilityId,
            auditId: request.auditId,
            intent: request.intent,
            sender: context.sender,
          }]);
          return result?.ok === true && result.auditId === request.auditId &&
            result.sessionCapabilityId === request.sessionCapabilityId && result.intent === request.intent
            ? Object.freeze({
              ok: true,
              session: Object.freeze({ auditId: request.auditId, state: 'result' }),
            })
            : DENIED;
        }
        const input = {
          sessionCapabilityId: request.sessionCapabilityId,
          auditId: request.auditId,
          consumer: context.consumer,
          intent: request.intent,
          sender: context.sender,
          ...(context.consumer === 'panel' ? { claimedWindowId: context.claimedWindowId } : {}),
        };
        return await Reflect.apply(authorize, options.authority, [input]);
      } catch {
        return DENIED;
      }
    },
  });

  return Object.freeze({ sessionAuthority, createPanelSender, createReviewSender });
}
