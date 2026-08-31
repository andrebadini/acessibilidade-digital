const PRESERVED_FAILURE_CODES = new Set([
  'AUDIT_DOWNLOAD_CLEANUP_PENDING',
  'AUDIT_EXPORT_RESERVATION_PENDING',
]);
const MAX_PROTOTYPE_DEPTH = 32;
const DEFAULT_RECOVERY_PROBE_TIMEOUT_MS = 5_000;

export function shouldPreserveExportTabAndLease(error) {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) return false;
  const visited = new WeakSet();
  let current = error;
  try {
    for (let depth = 0; current !== null && depth < MAX_PROTOTYPE_DEPTH; depth += 1) {
      if ((typeof current !== 'object' && typeof current !== 'function') || visited.has(current)) return false;
      visited.add(current);
      const descriptor = Reflect.getOwnPropertyDescriptor(current, 'code');
      if (descriptor) {
        return Object.hasOwn(descriptor, 'value') && PRESERVED_FAILURE_CODES.has(descriptor.value);
      }
      current = Reflect.getPrototypeOf(current);
    }
  } catch { /* hostile reflection fails closed without reading accessors */ }
  return false;
}

export async function advancePendingExportCleanup(dependencies, options = undefined) {
  const readJournal = ownFunction(dependencies, 'readJournal');
  const reconcile = ownFunction(dependencies, 'reconcile');
  if (!readJournal || !reconcile) return 'waiting';
  const timeoutMs = recoveryProbeTimeout(options);
  let journal;
  try {
    const probe = await settleProbe(Reflect.apply(readJournal, dependencies, []), timeoutMs);
    if (probe.status !== 'fulfilled') return 'waiting';
    journal = captureJournal(probe.value);
  } catch {
    return 'waiting';
  }
  if (journal.length === 0) return 'resolved';
  if (journal.some(entry => !Object.hasOwn(entry, 'downloadId'))) return 'waiting';
  try { await settleProbe(Reflect.apply(reconcile, dependencies, [journal]), timeoutMs); }
  catch { /* retry from durable state */ }
  return 'waiting';
}

function recoveryProbeTimeout(options) {
  try {
    if (options === undefined) return DEFAULT_RECOVERY_PROBE_TIMEOUT_MS;
    if (!options || typeof options !== 'object' || Array.isArray(options)) return DEFAULT_RECOVERY_PROBE_TIMEOUT_MS;
    const descriptor = Reflect.getOwnPropertyDescriptor(options, 'timeoutMs');
    const value = descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_RECOVERY_PROBE_TIMEOUT_MS;
  } catch {
    return DEFAULT_RECOVERY_PROBE_TIMEOUT_MS;
  }
}

function settleProbe(promise, timeoutMs) {
  return new Promise(resolve => {
    let settled = false;
    let timer;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    Promise.resolve(promise).then(
      value => finish({ status: 'fulfilled', value }),
      () => finish({ status: 'rejected' }),
    );
    timer = setTimeout(() => finish({ status: 'timeout' }), timeoutMs);
  });
}

function ownFunction(value, key) {
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

function captureJournal(value) {
  if (!Array.isArray(value) || Reflect.getPrototypeOf(value) !== Array.prototype) throw new TypeError();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const length = descriptors.length;
  if (!length || !Object.hasOwn(length, 'value') || !Number.isSafeInteger(length.value) ||
    length.value < 0 || length.value > 4 || Reflect.ownKeys(descriptors).length !== length.value + 1) throw new TypeError();
  const captured = [];
  for (let index = 0; index < length.value; index += 1) {
    const slot = descriptors[String(index)];
    if (!slot?.enumerable || !Object.hasOwn(slot, 'value')) throw new TypeError();
    const entry = slot.value;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
      ![Object.prototype, null].includes(Reflect.getPrototypeOf(entry))) throw new TypeError();
    const entryDescriptors = Object.getOwnPropertyDescriptors(entry);
    const copy = {};
    for (const key of Reflect.ownKeys(entryDescriptors)) {
      const descriptor = entryDescriptors[key];
      if (typeof key !== 'string' || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new TypeError();
      copy[key] = descriptor.value;
    }
    if (Object.hasOwn(copy, 'downloadId') && (!Number.isSafeInteger(copy.downloadId) || copy.downloadId < 0)) throw new TypeError();
    captured.push(copy);
  }
  structuredClone(captured);
  return captured;
}
