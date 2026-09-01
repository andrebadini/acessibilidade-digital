const CLOCKS = new WeakMap();
const NATIVE_DATE_NOW = Date.now;
const NATIVE_REFLECT_APPLY = Reflect.apply;

function denied() { return new TypeError('PIXEL_COMMIT_CLOCK_DENIED'); }

function exactEpochsInput(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
    const own = Reflect.ownKeys(value);
    if (own.length !== 1 || own[0] !== 'epochs') return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, 'epochs');
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
    const epochs = descriptor.value;
    if (!Array.isArray(epochs) || Object.getPrototypeOf(epochs) !== Array.prototype) return null;
    const lengthDescriptor = Object.getOwnPropertyDescriptor(epochs, 'length');
    const length = lengthDescriptor?.value;
    const keys = Reflect.ownKeys(epochs);
    if (!Object.hasOwn(lengthDescriptor ?? {}, 'value') || !Number.isSafeInteger(length) || length < 1 ||
      keys.length !== length + 1 || !keys.includes('length')) return null;
    const copy = [];
    for (let index = 0; index < length; index += 1) {
      const item = Object.getOwnPropertyDescriptor(epochs, String(index));
      if (!item?.enumerable || !Object.hasOwn(item, 'value') ||
        !Number.isSafeInteger(item.value) || item.value < 0) return null;
      copy.push(item.value);
    }
    return Object.freeze(copy);
  } catch { return null; }
}

function createClock(metadata) {
  const clock = Object.freeze(Object.create(null));
  CLOCKS.set(clock, metadata);
  return clock;
}

export function createNativePixelCommitClockV1() {
  if (arguments.length !== 0) throw denied();
  return createClock({ kind: 'native', highWater: -1, failed: false });
}

export function createScriptedPixelCommitClockV1(input) {
  const epochs = exactEpochsInput(input);
  if (!epochs) throw denied();
  return createClock({ kind: 'scripted', epochs, index: 0, highWater: -1, failed: false });
}

export function isPixelCommitClockV1(value) {
  return Boolean(value && typeof value === 'object' && CLOCKS.has(value));
}

export function readPixelCommitEpochV1(clock) {
  const metadata = clock && typeof clock === 'object' ? CLOCKS.get(clock) : null;
  if (!metadata || metadata.failed) throw denied();
  let value;
  try {
    if (metadata.kind === 'native') {
      value = NATIVE_REFLECT_APPLY(NATIVE_DATE_NOW, Date, []);
    } else {
      if (metadata.index >= metadata.epochs.length) throw denied();
      value = metadata.epochs[metadata.index];
      metadata.index += 1;
    }
  } catch {
    metadata.failed = true;
    throw denied();
  }
  if (!Number.isSafeInteger(value) || value < 0 || value < metadata.highWater) {
    metadata.failed = true;
    throw denied();
  }
  metadata.highWater = value;
  return value;
}
