const CIRCULAR = '[circular]';
const ERROR = '[error]';
const UNAVAILABLE = '[unavailable]';

function defineData(target, key, value) {
  Object.defineProperty(target, key, {
    configurable: false,
    enumerable: true,
    writable: false,
    value
  });
}

function ownEnumerableNames(value) {
  try {
    return Object.keys(value).sort();
  } catch {
    return null;
  }
}

function descriptorValue(value, key) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : UNAVAILABLE;
  } catch {
    return UNAVAILABLE;
  }
}

function typedArrayName(value) {
  return value instanceof DataView ? 'DataView' : value.constructor.name;
}

function canonicalObject(type, value) {
  return Object.freeze({ type, value });
}

function cloneJsonSafeValue(value, ancestors) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return `[bigint:${value}]`;
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return null;
  if (typeof value !== 'object') return null;
  if (value instanceof Error) return ERROR;
  if (ancestors.has(value)) return CIRCULAR;

  ancestors.add(value);
  try {
    if (value instanceof Date) {
      const time = value.getTime();
      return canonicalObject('Date', Number.isFinite(time) ? value.toISOString() : null);
    }
    if (value instanceof Map) {
      const entries = [];
      for (const [key, entryValue] of Map.prototype.entries.call(value)) {
        entries.push(Object.freeze([
          cloneJsonSafeValue(key, ancestors),
          cloneJsonSafeValue(entryValue, ancestors)
        ]));
      }
      return canonicalObject('Map', Object.freeze(entries));
    }
    if (value instanceof Set) {
      const values = [];
      for (const entryValue of Set.prototype.values.call(value)) {
        values.push(cloneJsonSafeValue(entryValue, ancestors));
      }
      return canonicalObject('Set', Object.freeze(values));
    }
    if (value instanceof ArrayBuffer) {
      return canonicalObject('ArrayBuffer', Object.freeze([...new Uint8Array(value)]));
    }
    if (ArrayBuffer.isView(value)) {
      const values = value instanceof DataView
        ? [...new Uint8Array(value.buffer, value.byteOffset, value.byteLength)]
        : [...value];
      return canonicalObject(typedArrayName(value), Object.freeze(
        values.map(entryValue => cloneJsonSafeValue(entryValue, ancestors))
      ));
    }
    if (Array.isArray(value)) {
      const clone = [];
      for (let index = 0; index < value.length; index += 1) {
        clone.push(cloneJsonSafeValue(descriptorValue(value, String(index)), ancestors));
      }
      return Object.freeze(clone);
    }

    const names = ownEnumerableNames(value);
    if (names === null) return UNAVAILABLE;
    const clone = {};
    for (const name of names) {
      defineData(clone, name, cloneJsonSafeValue(descriptorValue(value, name), ancestors));
    }
    return Object.freeze(clone);
  } catch {
    return UNAVAILABLE;
  } finally {
    ancestors.delete(value);
  }
}

/**
 * Produces a deterministic, deeply frozen data-only representation that is
 * safe to serialize with JSON.stringify without invoking source getters.
 */
export function cloneJsonSafe(value) {
  return cloneJsonSafeValue(value, new WeakSet());
}

function cloneReadonlyValue(value, seen) {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    return value;
  }
  if (seen.has(value)) return seen.get(value);

  if (typeof value === 'function') {
    const original = value;
    const wrapper = function readonlyContextFunction(...args) {
      const result = Reflect.apply(original, this, args);
      if (
        result !== null && (typeof result === 'object' || typeof result === 'function') &&
        typeof result.then === 'function'
      ) {
        return Promise.resolve(result).then(createReadonlyView);
      }
      return createReadonlyView(result);
    };
    seen.set(value, wrapper);
    return Object.freeze(wrapper);
  }

  if (value instanceof Date) {
    const clone = new Date(value.getTime());
    seen.set(value, clone);
    return Object.freeze(clone);
  }
  if (value instanceof Map) {
    const clone = new Map();
    seen.set(value, clone);
    for (const [key, entryValue] of Map.prototype.entries.call(value)) {
      clone.set(cloneReadonlyValue(key, seen), cloneReadonlyValue(entryValue, seen));
    }
    return Object.freeze(clone);
  }
  if (value instanceof Set) {
    const clone = new Set();
    seen.set(value, clone);
    for (const entryValue of Set.prototype.values.call(value)) {
      clone.add(cloneReadonlyValue(entryValue, seen));
    }
    return Object.freeze(clone);
  }
  if (value instanceof ArrayBuffer) {
    const clone = value.slice(0);
    seen.set(value, clone);
    return clone;
  }
  if (ArrayBuffer.isView(value)) {
    const clone = value instanceof DataView
      ? new DataView(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength))
      : new value.constructor(value);
    seen.set(value, clone);
    return clone;
  }

  const clone = Array.isArray(value) ? [] : {};
  seen.set(value, clone);
  const names = ownEnumerableNames(value);
  if (names !== null) {
    for (const name of names) {
      defineData(clone, name, cloneReadonlyValue(descriptorValue(value, name), seen));
    }
  }
  return Object.freeze(clone);
}

/**
 * Creates a separate deeply frozen view for one rule without freezing or
 * mutating the caller's snapshot or context objects.
 */
export function createReadonlyView(value) {
  return cloneReadonlyValue(value, new WeakMap());
}

export function cloneJsonSafeArray(value) {
  const clone = cloneJsonSafe(value);
  return Array.isArray(clone) ? clone : Object.freeze([]);
}
