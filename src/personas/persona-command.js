export function applyAuditaPersonaCommand(command, environment = globalThis) {
  function ownDataRecord(value, expectedKeys) {
    try {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
      var prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) return null;
      var keys = Reflect.ownKeys(value);
      if (keys.length !== expectedKeys.length ||
        keys.some(function unexpected(key) {
          return typeof key !== 'string' || !expectedKeys.includes(key);
        })) return null;
      var copy = Object.create(null);
      for (var index = 0; index < expectedKeys.length; index += 1) {
        var key = expectedKeys[index];
        var descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) return null;
        copy[key] = descriptor.value;
      }
      return copy;
    } catch (_error) {
      return null;
    }
  }

  function ownDataValue(value, key) {
    try {
      if (!value || (typeof value !== 'object' && typeof value !== 'function')) return undefined;
      var descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
    } catch (_error) {
      return undefined;
    }
  }

  function safePlatformValue(holder, key) {
    function readPlatformGetter(descriptor) {
      if (!descriptor || typeof descriptor.get !== 'function' || descriptor.set !== undefined) return undefined;
      var source;
      try {
        source = Function.prototype.toString.call(descriptor.get).replace(/\s+/gu, ' ').trim();
      } catch (_error) {
        return undefined;
      }
      if (key !== 'document' ||
        !/^(?:function )?get document\(\) \{ \[native code\] \}$/u.test(source)) return undefined;
      var candidate;
      try { candidate = descriptor.get.call(holder); } catch (_error) { return undefined; }
      var DocumentConstructor = typeof Document === 'function' ? Document : null;
      var documentPrototype = ownDataValue(DocumentConstructor, 'prototype');
      if (!candidate || !documentPrototype) return undefined;
      try {
        var current = Object.getPrototypeOf(candidate);
        for (var depth = 0; current && depth < 16; depth += 1) {
          if (current === documentPrototype) return candidate;
          current = Object.getPrototypeOf(current);
        }
      } catch (_error) { return undefined; }
      return undefined;
    }

    try {
      if (!holder || (typeof holder !== 'object' && typeof holder !== 'function')) return undefined;
      var own = Object.getOwnPropertyDescriptor(holder, key);
      if (own) {
        if (Object.hasOwn(own, 'value')) return own.value;
        return own.configurable === false ? readPlatformGetter(own) : undefined;
      }
      var current = Object.getPrototypeOf(holder);
      for (var depth = 0; current && depth < 8; depth += 1) {
        var descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (descriptor) {
          if (Object.hasOwn(descriptor, 'value')) return descriptor.value;
          return readPlatformGetter(descriptor);
        }
        current = Object.getPrototypeOf(current);
      }
    } catch (_error) {
      return undefined;
    }
    return undefined;
  }

  function parseCommand(value) {
    var basic = ownDataRecord(value, ['version', 'op']);
    if (basic) {
      if (basic.version !== 1 || !['probe', 'inspect', 'clear', 'reader-state'].includes(basic.op)) return null;
      return basic;
    }
    var three = ownDataRecord(value, ['version', 'op', 'mode']);
    if (three && three.version === 1 && three.op === 'install' &&
      ['reader', 'achromatopsia', 'motor'].includes(three.mode)) return three;
    var action = ownDataRecord(value, ['version', 'op', 'action']);
    if (action && action.version === 1 && action.op === 'reader-action' &&
      ['previous', 'repeat', 'pause', 'resume', 'next', 'stop'].includes(action.action)) return action;
    var voices = ownDataRecord(value, ['version', 'op', 'explicitUserGesture']);
    if (voices && voices.version === 1 && voices.op === 'reader-voices' &&
      typeof voices.explicitUserGesture === 'boolean') return voices;
    var preferences = ownDataRecord(value, ['version', 'op', 'voiceId', 'rate']);
    if (preferences && preferences.version === 1 && preferences.op === 'reader-preferences' &&
      typeof preferences.voiceId === 'string' && preferences.voiceId.length >= 1 &&
      preferences.voiceId.length <= 200 && preferences.voiceId === preferences.voiceId.trim() &&
      !/[\u0000-\u001f\u007f]/u.test(preferences.voiceId) &&
      typeof preferences.rate === 'number' && Number.isFinite(preferences.rate) &&
      preferences.rate >= 0.5 && preferences.rate <= 2) return preferences;
    return null;
  }

  function canonicalText(value, limit, allowEmpty) {
    if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/u.test(value)) return null;
    var normalized = Array.from(value.replace(/\s+/gu, ' ').trim()).slice(0, limit).join('');
    if ((!allowEmpty && !normalized) || normalized !== value) return null;
    return normalized;
  }

  function projectReaderState(value) {
    var rootState = ownDataRecord(value, ['activeMode', 'reader', 'limitations', 'coverage']);
    var readerState = rootState && ownDataRecord(rootState.reader, [
      'playback', 'index', 'total', 'caption', 'canPrevious', 'canNext',
      'speechAvailability', 'voiceId', 'rate',
    ]);
    if (!rootState || rootState.activeMode !== 'reader' || !readerState ||
      !['idle', 'playing', 'paused'].includes(readerState.playback) ||
      !Number.isSafeInteger(readerState.index) || !Number.isSafeInteger(readerState.total) ||
      readerState.total < 0 || readerState.total > 2000 ||
      typeof readerState.canPrevious !== 'boolean' || typeof readerState.canNext !== 'boolean' ||
      !['available', 'unavailable', 'busy', 'error'].includes(readerState.speechAvailability) ||
      typeof readerState.rate !== 'number' || !Number.isFinite(readerState.rate) ||
      readerState.rate < 0.5 || readerState.rate > 2) return null;
    var caption = canonicalText(readerState.caption, 2048, true);
    var voiceId = canonicalText(readerState.voiceId, 200, true);
    if (caption === null || voiceId === null) return null;
    if (readerState.playback === 'idle') {
      if (readerState.index !== -1 || readerState.total !== 0 || caption !== '' ||
        readerState.canPrevious || readerState.canNext) return null;
    } else if (readerState.total < 1 || readerState.index < 0 || readerState.index >= readerState.total || !caption ||
      readerState.canPrevious !== (readerState.index > 0) ||
      readerState.canNext !== (readerState.index < readerState.total - 1)) return null;
    return {
      version: 1,
      playback: readerState.playback,
      index: readerState.index,
      total: readerState.total,
      caption: caption,
      canPrevious: readerState.canPrevious,
      canNext: readerState.canNext,
      speechAvailability: readerState.speechAvailability,
      voiceId: voiceId,
      rate: readerState.rate,
    };
  }

  function projectVoiceInventory(value) {
    var inventory = ownDataRecord(value, ['status', 'voices']);
    if (!inventory || !['available', 'unavailable', 'error'].includes(inventory.status) ||
      !Array.isArray(inventory.voices)) return null;
    if (inventory.status === 'error') return { status: 'error', voices: [] };
    var length;
    var keys;
    try {
      length = Object.getOwnPropertyDescriptor(inventory.voices, 'length')?.value;
      keys = Reflect.ownKeys(inventory.voices);
    } catch (_error) { return null; }
    if (!Number.isSafeInteger(length) || length < 0 || length > 128 || keys.length !== length + 1) return null;
    var voices = [];
    var ids = new Set();
    for (var position = 0; position < length; position += 1) {
      var row = Object.getOwnPropertyDescriptor(inventory.voices, String(position));
      var voice = row?.enumerable && Object.hasOwn(row, 'value')
        ? ownDataRecord(row.value, ['id', 'label', 'lang'])
        : null;
      var id = voice && canonicalText(voice.id, 200, false);
      var label = voice && canonicalText(voice.label, 200, false);
      var lang = voice && canonicalText(voice.lang, 64, true);
      if (!voice || id === null || label === null || lang === null || ids.has(id)) return null;
      ids.add(id);
      voices.push({ id: id, label: label, lang: lang });
    }
    if (inventory.status === 'unavailable' && voices.length !== 0) return null;
    return { status: inventory.status, voices: voices };
  }

  function projectReaderActionOutcome(value) {
    var outcome = ownDataRecord(value, ['actionStatus', 'state']);
    if (!outcome || !['accepted', 'rejected', 'terminal'].includes(outcome.actionStatus)) return null;
    var projectedState = projectReaderState(outcome.state);
    return projectedState
      ? { actionStatus: outcome.actionStatus, state: projectedState }
      : null;
  }

  function sameReaderState(left, right) {
    return Boolean(left && right && [
      'version', 'playback', 'index', 'total', 'caption', 'canPrevious', 'canNext',
      'speechAvailability', 'voiceId', 'rate',
    ].every(function sameValue(key) { return left[key] === right[key]; }));
  }

  function namespaceObservation(holder) {
    try {
      if (!holder || (typeof holder !== 'object' && typeof holder !== 'function')) {
        return { present: false, namespace: null };
      }
      var key = Symbol.for('audita.accessible-preview.runtime.v1');
      var descriptor = Object.getOwnPropertyDescriptor(holder, key);
      if (!descriptor) return { present: false, namespace: null };
      if (!Object.hasOwn(descriptor, 'value')) return { present: true, namespace: null };
      var candidate = descriptor.value;
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate) ||
        Object.getPrototypeOf(candidate) !== null || !Object.isFrozen(candidate) ||
        ownDataValue(candidate, 'brand') !== 'audita-accessible-preview' ||
        ownDataValue(candidate, 'version') !== 1 ||
        typeof ownDataValue(candidate, 'createContentRuntime') !== 'function' ||
        typeof ownDataValue(candidate, 'getContentSingleton') !== 'function' ||
        typeof ownDataValue(candidate, 'setContentSingleton') !== 'function') {
        return { present: true, namespace: null };
      }
      return { present: true, namespace: candidate };
    } catch (_error) {
      return { present: true, namespace: null };
    }
  }

  function modeFromRuntime(runtime) {
    if (!runtime || typeof runtime !== 'object' || !Object.isFrozen(runtime) ||
      typeof ownDataValue(runtime, 'activate') !== 'function' ||
      typeof ownDataValue(runtime, 'stop') !== 'function' ||
      typeof ownDataValue(runtime, 'getState') !== 'function') return { ok: false };
    var state = ownDataValue(runtime, 'getState').call(runtime);
    var mode = ownDataValue(state, 'activeMode');
    return mode === null || ['reader', 'achromatopsia', 'motor'].includes(mode)
      ? { ok: true, mode: mode }
      : { ok: false };
  }

  function readSingleton(namespace) {
    return ownDataValue(namespace, 'getContentSingleton').call(namespace);
  }

  function createSingleton(namespace, holder) {
    var candidate = ownDataValue(namespace, 'createContentRuntime').call(namespace, {
      document: safePlatformValue(holder, 'document'),
      window: holder,
    });
    return ownDataValue(namespace, 'setContentSingleton').call(namespace, candidate);
  }

  function installBridge(holder, namespace, runtime) {
    var current = Object.getOwnPropertyDescriptor(holder, '__auditaPersonaV1');
    if (current) {
      var value = Object.hasOwn(current, 'value') ? current.value : null;
      if (current.enumerable !== false || current.configurable !== true || current.writable !== false ||
        !value || typeof value !== 'object' || !Object.isFrozen(value) ||
        ownDataValue(value, 'version') !== 1 || ownDataValue(value, 'namespace') !== namespace ||
        ownDataValue(value, 'runtime') !== runtime) return false;
      return true;
    }
    var correlation = Object.assign(Object.create(null), {
      version: 1,
      namespace: namespace,
      runtime: runtime,
    });
    Object.freeze(correlation);
    Object.defineProperty(holder, '__auditaPersonaV1', {
      value: correlation,
      enumerable: false,
      configurable: true,
      writable: false,
    });
    return true;
  }

  function clearBridge(holder, namespace, runtime) {
    var current = Object.getOwnPropertyDescriptor(holder, '__auditaPersonaV1');
    if (!current) return true;
    var value = Object.hasOwn(current, 'value') ? current.value : null;
    if (current.enumerable !== false || current.configurable !== true || current.writable !== false ||
      !value || typeof value !== 'object' || !Object.isFrozen(value) ||
      ownDataValue(value, 'version') !== 1 || ownDataValue(value, 'namespace') !== namespace ||
      ownDataValue(value, 'runtime') !== runtime) return false;
    return Reflect.deleteProperty(holder, '__auditaPersonaV1') &&
      !Object.getOwnPropertyDescriptor(holder, '__auditaPersonaV1');
  }

  var parsed = parseCommand(command);
  if (!parsed) return { ok: false, reason: 'invalid-command' };
  var observation = namespaceObservation(environment);

  if (parsed.op === 'probe') {
    var probeMode = null;
    if (observation.namespace) {
      try {
        var probeRuntime = readSingleton(observation.namespace);
        if (probeRuntime) {
          var probeState = modeFromRuntime(probeRuntime);
          if (probeState.ok) probeMode = probeState.mode;
        }
      } catch (_error) { /* probe never executes or repairs a broken runtime */ }
    }
    return { ok: true, present: observation.present, mode: probeMode };
  }

  if (!observation.present) return { ok: false, reason: 'runtime-missing' };
  if (!observation.namespace) return { ok: false, reason: 'runtime-brand-mismatch' };

  try {
    var runtime = readSingleton(observation.namespace);
    if (!runtime && parsed.op === 'install') {
      runtime = createSingleton(observation.namespace, environment);
    }
    if (!runtime) return { ok: false, reason: 'runtime-missing' };
    var initial = modeFromRuntime(runtime);
    if (!initial.ok) return { ok: false, reason: 'runtime-error' };

    if (parsed.op === 'install') {
      ownDataValue(runtime, 'activate').call(runtime, parsed.mode);
      var installed = modeFromRuntime(runtime);
      if (!installed.ok || installed.mode !== parsed.mode ||
        !installBridge(environment, observation.namespace, runtime)) {
        return { ok: false, reason: 'runtime-error' };
      }
      return { ok: true, mode: installed.mode };
    }

    if (parsed.op === 'inspect') return { ok: true, mode: initial.mode };

    if (parsed.op.startsWith('reader-')) {
      if (initial.mode !== 'reader') return { ok: false, reason: 'reader-inactive' };
      if (parsed.op === 'reader-voices') {
        if (parsed.explicitUserGesture !== true) return { ok: false, reason: 'gesture-required' };
        var listVoices = ownDataValue(runtime, 'listReaderVoices');
        if (typeof listVoices !== 'function') return { ok: false, reason: 'runtime-error' };
        var projectedInventory = projectVoiceInventory(listVoices.call(runtime));
        if (!projectedInventory || projectedInventory.status === 'error') {
          return { ok: false, reason: 'runtime-error' };
        }
        return {
          ok: true,
          kind: 'voices',
          status: projectedInventory.status,
          voices: projectedInventory.voices,
        };
      }
      var projectedAction = null;
      if (parsed.op === 'reader-action') {
        var readerAction = ownDataValue(runtime, 'readerAction');
        if (typeof readerAction !== 'function') return { ok: false, reason: 'runtime-error' };
        projectedAction = projectReaderActionOutcome(readerAction.call(runtime, parsed.action));
        if (!projectedAction) return { ok: false, reason: 'runtime-error' };
      } else if (parsed.op === 'reader-preferences') {
        var setPreferences = ownDataValue(runtime, 'setPreferences');
        if (typeof setPreferences !== 'function') return { ok: false, reason: 'runtime-error' };
        setPreferences.call(runtime, { voiceId: parsed.voiceId, rate: parsed.rate });
      }
      var projectedState = projectReaderState(ownDataValue(runtime, 'getState').call(runtime));
      if (!projectedState) return { ok: false, reason: 'runtime-error' };
      if (projectedAction && !sameReaderState(projectedAction.state, projectedState)) {
        return { ok: false, reason: 'runtime-error' };
      }
      if (parsed.op === 'reader-preferences' &&
        (projectedState.voiceId !== parsed.voiceId || projectedState.rate !== parsed.rate)) {
        return { ok: false, reason: 'voice-unavailable' };
      }
      return projectedAction
        ? {
            ok: true,
            kind: 'state',
            actionStatus: projectedAction.actionStatus,
            state: projectedState,
          }
        : { ok: true, kind: 'state', state: projectedState };
    }

    ownDataValue(runtime, 'stop').call(runtime);
    var cleared = modeFromRuntime(runtime);
    if (!cleared.ok) return { ok: false, reason: 'runtime-error' };
    if (cleared.mode !== null || !clearBridge(environment, observation.namespace, runtime)) {
      return { ok: false, reason: 'cleanup-unconfirmed' };
    }
    return { ok: true, mode: null };
  } catch (_error) {
    return { ok: false, reason: 'runtime-error' };
  }
}
