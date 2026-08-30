const HIGHLIGHT_REGISTRY_KEY = 'audita:highlight-bindings:v1';

function exactDataRecord(value, expectedKeys) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== expectedKeys.length ||
      keys.some(key => typeof key !== 'string' || !expectedKeys.includes(key))) return null;
    const copy = Object.create(null);
    for (const key of expectedKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      copy[key] = descriptor.value;
    }
    return copy;
  } catch {
    return null;
  }
}

function exactEmptyEnvelope(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return (prototype === Object.prototype || prototype === null) && Reflect.ownKeys(value).length === 0;
  } catch {
    return false;
  }
}

function success(state) {
  return Object.freeze({ ok: true, state });
}

function failure(code) {
  return Object.freeze({ ok: false, code });
}

function confirmedCleanup(value, states) {
  const record = exactDataRecord(value, ['ok', 'state']);
  return Boolean(record && record.ok === true && states.includes(record.state));
}

export function createLiveAidCleanup(raw) {
  const input = exactDataRecord(raw, ['highlightCleaner', 'personaCoordinator', 'targetQueue']);
  if (!input || typeof input.highlightCleaner?.clearForTargetLocked !== 'function' ||
    typeof input.personaCoordinator?.revokeTargetLocked !== 'function' ||
    typeof input.targetQueue?.assertHeld !== 'function') {
    throw new TypeError('LIVE_AID_CLEANUP_INVALID');
  }

  async function clearForAuditLocked(rawArgs) {
    const args = exactDataRecord(rawArgs, ['target', 'lock']);
    if (!args) throw new TypeError('LIVE_AID_CLEANUP_INPUT_INVALID');
    input.targetQueue.assertHeld(args.lock, args.target);

    let highlight;
    try {
      highlight = await input.highlightCleaner.clearForTargetLocked(
        args.target,
        'audit-start',
        args.lock,
      );
    } catch {
      highlight = null;
    }

    let persona;
    try {
      persona = await input.personaCoordinator.revokeTargetLocked({
        target: args.target,
        reason: 'audit-start',
        lock: args.lock,
      });
    } catch {
      persona = null;
    }

    if (!confirmedCleanup(highlight, ['absent', 'clear', 'revoked'])) {
      return failure('HIGHLIGHT_CLEANUP_UNCONFIRMED');
    }
    if (!confirmedCleanup(persona, ['absent', 'revoked'])) {
      return failure('PERSONA_CLEANUP_UNCONFIRMED');
    }
    return success('clear');
  }

  return Object.freeze({ clearForAuditLocked });
}

export function createAbsentHighlightCleaner(raw) {
  const input = exactDataRecord(raw, ['sessionArea', 'targetQueue']);
  if (!input || typeof input.sessionArea?.get !== 'function' ||
    typeof input.targetQueue?.assertHeld !== 'function') {
    throw new TypeError('HIGHLIGHT_CLEANER_INVALID');
  }

  async function clearForTargetLocked(target, reason, lock) {
    if (reason !== 'audit-start') throw new TypeError('HIGHLIGHT_CLEANER_INPUT_INVALID');
    input.targetQueue.assertHeld(lock, target);
    let envelope;
    try {
      envelope = await input.sessionArea.get(HIGHLIGHT_REGISTRY_KEY);
    } catch {
      return failure('HIGHLIGHT_CLEANUP_UNCONFIRMED');
    }
    return exactEmptyEnvelope(envelope)
      ? success('absent')
      : failure('HIGHLIGHT_CLEANUP_UNCONFIRMED');
  }

  return Object.freeze({ clearForTargetLocked });
}
