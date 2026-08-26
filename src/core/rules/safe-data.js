const CIRCULAR = '[circular]';
const ERROR = '[error]';
const UNAVAILABLE = '[unavailable]';
let readonlyViewCreations = 0;

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

function readonlyError() {
  throw new TypeError('Readonly execution view cannot be mutated');
}

const READONLY_HANDLER = Object.freeze({
  set: readonlyError,
  defineProperty: readonlyError,
  deleteProperty: readonlyError,
  setPrototypeOf: readonlyError,
  preventExtensions: target => Reflect.preventExtensions(target)
});

function immutableBuiltin(target, mutators, wrapResult, custom = {}) {
  let proxy;
  proxy = new Proxy(target, {
    ...READONLY_HANDLER,
    get(actual, property) {
      if (mutators.has(property)) return readonlyError;
      if (Object.hasOwn(custom, property)) return custom[property](actual, proxy);
      const result = Reflect.get(actual, property, actual);
      if (property === 'constructor') return result;
      if (typeof result !== 'function') return result;
      return (...args) => wrapResult(Reflect.apply(result, actual, args));
    }
  });
  return proxy;
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
      let then;
      try { then = result?.then; } catch { return createReadonlyView(null); }
      if (typeof then === 'function') return Promise.resolve(result).then(createReadonlyView);
      return createReadonlyView(result);
    };
    seen.set(value, wrapper);
    return Object.freeze(wrapper);
  }

  if (value instanceof Date) {
    const clone = Object.freeze(new Date(value.getTime()));
    const proxy = immutableBuiltin(
      clone,
      new Set(['setDate', 'setFullYear', 'setHours', 'setMilliseconds', 'setMinutes', 'setMonth', 'setSeconds', 'setTime', 'setUTCDate', 'setUTCFullYear', 'setUTCHours', 'setUTCMilliseconds', 'setUTCMinutes', 'setUTCMonth', 'setUTCSeconds', 'setYear']),
      result => result
    );
    seen.set(value, proxy);
    return proxy;
  }
  if (value instanceof Map) {
    const clone = new Map();
    const proxy = immutableBuiltin(
      clone,
      new Set(['set', 'delete', 'clear']),
      result => result,
      {
        forEach: (actual, readonly) => (callback, thisArg) => Map.prototype.forEach.call(
          actual,
          (entryValue, key) => callback.call(thisArg, entryValue, key, readonly)
        )
      }
    );
    seen.set(value, proxy);
    for (const [key, entryValue] of Map.prototype.entries.call(value)) {
      clone.set(cloneReadonlyValue(key, seen), cloneReadonlyValue(entryValue, seen));
    }
    Object.freeze(clone);
    return proxy;
  }
  if (value instanceof Set) {
    const clone = new Set();
    const proxy = immutableBuiltin(
      clone,
      new Set(['add', 'delete', 'clear']),
      result => result,
      {
        forEach: (actual, readonly) => (callback, thisArg) => Set.prototype.forEach.call(
          actual,
          entryValue => callback.call(thisArg, entryValue, entryValue, readonly)
        )
      }
    );
    seen.set(value, proxy);
    for (const entryValue of Set.prototype.values.call(value)) {
      clone.add(cloneReadonlyValue(entryValue, seen));
    }
    Object.freeze(clone);
    return proxy;
  }
  if (value instanceof ArrayBuffer) {
    const clone = value.slice(0);
    Object.freeze(clone);
    const proxy = immutableBuiltin(
      clone,
      new Set(['resize', 'transfer', 'transferToFixedLength']),
      result => result
    );
    seen.set(value, proxy);
    return proxy;
  }
  if (ArrayBuffer.isView(value)) {
    const clone = value instanceof DataView
      ? new DataView(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength))
      : new value.constructor(value);
    const mutators = value instanceof DataView
      ? new Set(Object.getOwnPropertyNames(DataView.prototype).filter(name => name.startsWith('set')))
      : new Set(['copyWithin', 'fill', 'reverse', 'set', 'setFromBase64', 'setFromHex', 'sort']);
    const wrapTypedResult = result => (
      result instanceof ArrayBuffer || ArrayBuffer.isView(result)
        ? cloneReadonlyValue(result, new WeakMap())
        : result
    );
    const custom = {
      buffer: actual => actual.buffer.slice(actual.byteOffset, actual.byteOffset + actual.byteLength)
    };
    if (!(value instanceof DataView)) {
      for (const method of ['every', 'filter', 'find', 'findIndex', 'findLast', 'findLastIndex', 'forEach', 'map', 'some']) {
        custom[method] = (actual, readonly) => (callback, thisArg) => wrapTypedResult(
          Reflect.apply(actual[method], actual, [
            (entry, index) => callback.call(thisArg, entry, index, readonly)
          ])
        );
      }
      for (const method of ['reduce', 'reduceRight']) {
        custom[method] = (actual, readonly) => function readonlyReduce(callback, initialValue) {
          const args = [
            (accumulator, entry, index) => callback(accumulator, entry, index, readonly)
          ];
          if (arguments.length > 1) args.push(initialValue);
          return Reflect.apply(actual[method], actual, args);
        };
      }
    }
    const proxy = immutableBuiltin(clone, mutators, wrapTypedResult, custom);
    seen.set(value, proxy);
    return proxy;
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
 * Creates one independent deeply readonly view without freezing or mutating
 * the caller's values. Built-in mutable types retain their observable type
 * and read methods while proxies reject their internal-slot mutators.
 */
export function createReadonlyView(value) {
  readonlyViewCreations += 1;
  return cloneReadonlyValue(value, new WeakMap());
}

/** Read-only diagnostic counter used to verify cloning cost at execution boundaries. */
export function getReadonlyViewDiagnostics() {
  return Object.freeze({ creations: readonlyViewCreations });
}

export function cloneJsonSafeArray(value) {
  const clone = cloneJsonSafe(value);
  return Array.isArray(clone) ? clone : Object.freeze([]);
}
