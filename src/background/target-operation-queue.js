const MAX_DOCUMENT_ID_LENGTH = 512;

function readOwnData(object, key) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) return null;
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(object, key);
  } catch {
    return null;
  }
  return descriptor?.enumerable === true && Object.hasOwn(descriptor, 'value')
    ? descriptor.value
    : null;
}

function validatedTargetKey(target) {
  const tabId = readOwnData(target, 'tabId');
  const documentId = readOwnData(target, 'documentId');
  if (!Number.isSafeInteger(tabId) || tabId <= 0 || typeof documentId !== 'string' ||
    documentId.length < 1 || documentId.length > MAX_DOCUMENT_ID_LENGTH ||
    /[\u0000-\u001F\u007F]/u.test(documentId)) {
    throw new TypeError('Alvo inválido.');
  }
  return `${tabId}\u0000${documentId}`;
}

export function createTargetOperationQueue() {
  const tails = new Map();
  const activeLocks = new WeakMap();

  function withTarget(target, operation) {
    const key = validatedTargetKey(target);
    if (typeof operation !== 'function') throw new TypeError('Operação inválida.');

    const predecessor = tails.get(key) ?? Promise.resolve();
    const execute = async () => {
      const lock = Object.freeze(Object.create(null));
      activeLocks.set(lock, key);
      try {
        return await operation(lock);
      } finally {
        activeLocks.delete(lock);
      }
    };
    const result = predecessor.then(execute, execute);
    const tail = result.then(() => undefined, () => undefined);
    tails.set(key, tail);
    void tail.finally(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return result;
  }

  function assertHeld(lock, target) {
    const key = validatedTargetKey(target);
    if (!lock || typeof lock !== 'object' || activeLocks.get(lock) !== key) {
      throw new Error('Lock inválido.');
    }
    return true;
  }

  return Object.freeze({ withTarget, assertHeld });
}
