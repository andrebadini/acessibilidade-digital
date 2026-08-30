const ABSENT = Object.freeze({ state: 'absent' });

export function parseStorageGetEnvelope(envelope, key) {
  try {
    if (typeof key !== 'string' || key.length === 0 || !envelope || typeof envelope !== 'object' ||
      Array.isArray(envelope)) return null;
    const prototype = Object.getPrototypeOf(envelope);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(envelope);
    if (keys.length === 0) return ABSENT;
    if (keys.length !== 1 || keys[0] !== key) return null;
    const descriptor = Object.getOwnPropertyDescriptor(envelope, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value') || descriptor.value === undefined) return null;
    return Object.freeze({ state: 'present', value: descriptor.value });
  } catch {
    return null;
  }
}
