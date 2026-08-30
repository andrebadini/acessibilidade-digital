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
      if (basic.version !== 1 || !['probe', 'inspect', 'clear'].includes(basic.op)) return null;
      return basic;
    }
    var install = ownDataRecord(value, ['version', 'op', 'mode']);
    if (!install || install.version !== 1 || install.op !== 'install' ||
      !['reader', 'achromatopsia', 'motor'].includes(install.mode)) return null;
    return install;
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
