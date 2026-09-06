export const PAGE_MARKERS_PORT_NAME = 'audita-page-markers-v1';

const INSTALLATION_ID = /^[A-Za-z0-9_-]{22}$/u;
// IDs come from the full projection; 64 limits offered details, not their IDs.
const SELECTION_ID = /^s[1-9][0-9]{0,15}$/u;

function ownData(value, key) {
  try {
    const descriptor = value && typeof value === 'object'
      ? Reflect.getOwnPropertyDescriptor(value, key)
      : null;
    return descriptor?.enumerable && Object.hasOwn(descriptor, 'value')
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

function ownCallable(value, key) {
  const candidate = ownData(value, key);
  return typeof candidate === 'function' ? candidate : null;
}

function exactData(value, fields) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Reflect.getPrototypeOf(value))) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== fields.length || fields.some(field => !keys.includes(field)) ||
      keys.some(key => typeof key !== 'string' || !fields.includes(key))) return null;
    const copy = {};
    for (const field of fields) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, field);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      copy[field] = descriptor.value;
    }
    return Object.freeze(copy);
  } catch {
    return null;
  }
}

function pageRuntimeMessage(value) {
  const type = ownData(value, 'type');
  const fields = type === 'AUDITA_PAGE_MARKER_SELECTED'
    ? ['type', 'installationId', 'selectionId']
    : type === 'AUDITA_PAGE_MARKERS_CLEARED'
      ? ['type', 'installationId']
      : null;
  const message = fields && exactData(value, fields);
  if (!message || !INSTALLATION_ID.test(message.installationId ?? '')) return null;
  if (type === 'AUDITA_PAGE_MARKER_SELECTED') {
    if (!SELECTION_ID.test(message.selectionId ?? '') ||
      !Number.isSafeInteger(Number(message.selectionId.slice(1)))) return null;
  }
  return message;
}

export function isPageMarkersRuntimeMessage(value) {
  return pageRuntimeMessage(value) !== null;
}

const NOT_DELIVERED = Object.freeze({ delivered: 0 });

export function createPageMarkersWorkerLifecycle(raw = {}) {
  const input = exactData(raw, ['publish']);
  const publishState = input && ownCallable(input, 'publish');
  if (!publishState) throw new TypeError('PAGE_MARKERS_WORKER_LIFECYCLE_INVALID');

  let active = true;
  let generation = 0;

  function isActive() {
    return active;
  }

  async function publish(event) {
    const ticket = generation;
    await Promise.resolve();
    if (!active || ticket !== generation) return NOT_DELIVERED;
    try {
      const result = await Reflect.apply(publishState, input, [event]);
      return active && ticket === generation ? result : NOT_DELIVERED;
    } catch {
      return NOT_DELIVERED;
    }
  }

  function dispose() {
    if (!active) return false;
    active = false;
    generation += 1;
    return true;
  }

  return Object.freeze({ isActive, publish, dispose });
}

export function createPageMarkersWorkerBridge(raw = {}) {
  const input = exactData(raw, ['controller']) ?? exactData(raw, ['controller', 'lifecycle']);
  const attachControllerPort = input && ownCallable(input.controller, 'attachPort');
  const handleControllerMessage = input && ownCallable(input.controller, 'handleRuntimeMessage');
  const lifecycle = input && ownData(input, 'lifecycle');
  const closeLifecycle = lifecycle === undefined ? null : ownCallable(lifecycle, 'dispose');
  if (!attachControllerPort || !handleControllerMessage || (lifecycle !== undefined && !closeLifecycle)) {
    throw new TypeError('PAGE_MARKERS_WORKER_BRIDGE_INVALID');
  }

  const ownedPorts = new Map();
  let disposed = false;

  function attachPort(port) {
    if (disposed || ownData(port, 'name') !== PAGE_MARKERS_PORT_NAME || ownedPorts.has(port)) return false;
    const onDisconnect = ownData(port, 'onDisconnect');
    const addDisconnect = ownCallable(onDisconnect, 'addListener');
    const removeDisconnect = ownCallable(onDisconnect, 'removeListener');
    const disconnect = ownCallable(port, 'disconnect');
    if (!addDisconnect || !removeDisconnect || !disconnect) return false;
    const release = () => {
      ownedPorts.delete(port);
      try { Reflect.apply(removeDisconnect, onDisconnect, [release]); } catch {}
    };
    try {
      Reflect.apply(addDisconnect, onDisconnect, [release]);
      if (Reflect.apply(attachControllerPort, input.controller, [port]) !== true) {
        release();
        return false;
      }
      ownedPorts.set(port, Object.freeze({ onDisconnect, removeDisconnect, disconnect, release }));
      return true;
    } catch {
      release();
      return false;
    }
  }

  function handleRuntimeMessage(message, sender) {
    if (disposed) return false;
    const captured = pageRuntimeMessage(message);
    if (!captured) return false;
    try {
      return Reflect.apply(handleControllerMessage, input.controller, [captured, sender]) === true;
    } catch {
      return false;
    }
  }

  function dispose() {
    if (disposed) return false;
    disposed = true;
    try { if (closeLifecycle) Reflect.apply(closeLifecycle, lifecycle, []); } catch {}
    const channels = [...ownedPorts.entries()];
    ownedPorts.clear();
    for (const [port, owned] of channels) {
      try { Reflect.apply(owned.removeDisconnect, owned.onDisconnect, [owned.release]); } catch {}
      try { Reflect.apply(owned.disconnect, port, []); } catch {}
    }
    return true;
  }

  return Object.freeze({ attachPort, handleRuntimeMessage, dispose });
}
