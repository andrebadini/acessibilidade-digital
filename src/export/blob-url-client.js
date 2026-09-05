import { BLOB_URL_PORT_NAME, isExportBlobUrlV1, parseBlobPortMessageV1 } from './blob-url-protocol.js';

const TIMEOUT_MS = 5_000;
function unavailable() { return new Error('BLOB_CLIENT_UNAVAILABLE'); }
function own(value, key) {
  const descriptor = value && ['object', 'function'].includes(typeof value)
    ? Object.getOwnPropertyDescriptor(value, key) : null;
  if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw unavailable();
  return descriptor.value;
}
function callable(value, key) {
  // Native APIs may expose inherited or non-enumerable methods; capture the callable and its receiver once.
  const method = value?.[key];
  if (typeof method !== 'function') throw unavailable();
  return (...args) => Reflect.apply(method, value, args);
}

export function createExportBlobUrlClientV1(raw) {
  let runtime; let connect; let revokeObjectURL; let extensionId; let hello;
  try {
    const keys = ['runtime', 'urlApi', 'auditId', 'sessionCapabilityId'];
    if (!raw || typeof raw !== 'object' || Object.getPrototypeOf(raw) !== Object.prototype ||
      Reflect.ownKeys(raw).length !== keys.length || keys.some(key => !Object.hasOwn(raw, key))) throw unavailable();
    runtime = own(raw, 'runtime'); extensionId = runtime?.id;
    connect = callable(runtime, 'connect'); revokeObjectURL = callable(own(raw, 'urlApi'), 'revokeObjectURL');
    hello = parseBlobPortMessageV1({ type: 'hello', auditId: own(raw, 'auditId'),
      sessionCapabilityId: own(raw, 'sessionCapabilityId') }, 'client');
    if (!hello || typeof extensionId !== 'string' || !/^[a-p]{32}$/u.test(extensionId)) throw unavailable();
  } catch { throw unavailable(); }

  const resources = new Map();
  const operations = [];
  let current = null;
  let disposed = false;
  let reconnectTimer = null;
  let reconnectDelay = 250;

  function hasWork() {
    return operations.length > 0 || [...resources.values()].some(resource => resource.state !== 'released');
  }

  function close(connection, disconnect) {
    clearTimeout(connection.helloTimer);
    try { connection.removeMessage?.(connection.onMessage); } catch {}
    try { connection.removeDisconnect?.(connection.onDisconnect); } catch {}
    if (disconnect) try { connection.disconnect?.(); } catch {}
  }

  function finish(operation, ok, advance = true) {
    const index = operations.indexOf(operation);
    if (index === -1) return;
    operations.splice(index, 1);
    clearTimeout(operation.timer);
    if (operation.connection?.active === operation) operation.connection.active = null;
    if (ok) operation.resolve();
    else operation.reject(unavailable());
    if (!hasWork() && reconnectTimer !== null) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (advance) pump();
  }

  function scheduleReconnect() {
    if (disposed || current || reconnectTimer !== null || !hasWork()) return;
    const delay = reconnectDelay;
    reconnectDelay = Math.min(reconnectDelay * 2, TIMEOUT_MS);
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connectNow(); }, delay);
  }

  function lost(connection, disconnect = true) {
    if (current !== connection) return;
    current = null;
    close(connection, disconnect);
    for (const operation of [...operations]) {
      operation.connection = null; operation.requestId = null;
      if (operation.type === 'register') finish(operation, false, false);
    }
    scheduleReconnect();
  }

  function send(connection, message) {
    try { connection.post(message); return true; }
    catch { lost(connection); return false; }
  }

  function receive(connection, value) {
    if (disposed || current !== connection) return;
    const message = parseBlobPortMessageV1(value, 'worker');
    if (!message) { lost(connection); return; }
    if (message.type === 'ready') {
      if (connection.ready) return;
      connection.ready = true;
      clearTimeout(connection.helloTimer);
      reconnectDelay = 250;
      pump();
    } else if (message.type === 'revoke') {
      // This listener must remain outside the request queue: RELEASE may itself be waiting for this ACK.
      const resource = isExportBlobUrlV1(message.blobUrl, extensionId) && resources.get(message.blobUrl);
      let ok = false;
      if (resource) {
        try {
          if (resource.state === 'live') {
            revokeObjectURL(message.blobUrl);
            resource.state = 'revoked';
          }
          ok = true;
        } catch {}
      }
      send(connection, { type: 'revoked', requestId: message.requestId, ok });
    } else if (message.type === 'result') {
      const operation = connection.active;
      if (!operation || operation.requestId !== message.requestId) return;
      const resource = resources.get(operation.blobUrl);
      const ok = message.ok && (operation.type === 'release' || resource?.state === 'live');
      if (ok && operation.type === 'release') resource.state = 'released';
      finish(operation, ok);
    }
  }

  function connectNow() {
    if (disposed || current || !hasWork()) return;
    const connection = { ready: false, nextId: 0, active: null, helloTimer: null };
    current = connection;
    try {
      const port = connect({ name: BLOB_URL_PORT_NAME });
      connection.post = callable(port, 'postMessage');
      connection.disconnect = callable(port, 'disconnect');
      const onMessage = port?.onMessage; const onDisconnect = port?.onDisconnect;
      const addMessage = callable(onMessage, 'addListener'); const addDisconnect = callable(onDisconnect, 'addListener');
      connection.removeMessage = callable(onMessage, 'removeListener');
      connection.removeDisconnect = callable(onDisconnect, 'removeListener');
      connection.onMessage = value => receive(connection, value);
      connection.onDisconnect = () => lost(connection, false);
      addMessage(connection.onMessage); addDisconnect(connection.onDisconnect);
      connection.helloTimer = setTimeout(() => lost(connection), TIMEOUT_MS);
      send(connection, hello);
    } catch { lost(connection); }
  }

  function pump() {
    if (disposed) return;
    if (!current) {
      if (reconnectTimer === null) connectNow();
      return;
    }
    const connection = current;
    if (!connection.ready || connection.active || operations.length === 0) return;
    const operation = operations[0];
    if (operation.type === 'register' && resources.get(operation.blobUrl)?.state !== 'live') {
      finish(operation, false); return;
    }
    if (!Number.isSafeInteger(connection.nextId + 1)) { lost(connection); return; }
    operation.requestId = ++connection.nextId;
    operation.connection = connection;
    connection.active = operation;
    send(connection, { type: operation.type, requestId: operation.requestId, blobUrl: operation.blobUrl });
  }

  function enqueue(type, blobUrl) {
    return new Promise((resolve, reject) => {
      const operation = { type, blobUrl, resolve, reject, connection: null, requestId: null, timer: null };
      operation.timer = setTimeout(() => finish(operation, false), TIMEOUT_MS);
      operations.push(operation);
      pump();
    });
  }

  async function register(blobUrl) {
    if (disposed || !isExportBlobUrlV1(blobUrl, extensionId)) throw unavailable();
    const previous = resources.get(blobUrl);
    if (previous && previous.state !== 'live') throw unavailable();
    if (!previous) resources.set(blobUrl, { state: 'live' });
    return enqueue('register', blobUrl);
  }

  async function release(blobUrl) {
    if (disposed || !isExportBlobUrlV1(blobUrl, extensionId) || !resources.has(blobUrl)) throw unavailable();
    if (resources.get(blobUrl).state === 'released') return;
    return enqueue('release', blobUrl);
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    clearTimeout(reconnectTimer); reconnectTimer = null;
    if (current) { const connection = current; current = null; close(connection, true); }
    for (const operation of [...operations]) finish(operation, false, false);
    for (const [blobUrl, resource] of resources) {
      if (resource.state !== 'live') continue;
      try { revokeObjectURL(blobUrl); resource.state = 'revoked'; } catch {}
    }
  }

  return Object.freeze({ blobLifecycle: Object.freeze({ register, release }), dispose });
}
