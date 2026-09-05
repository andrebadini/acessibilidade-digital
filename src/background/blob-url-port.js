import { BLOB_URL_PORT_NAME, isExportBlobUrlV1, parseBlobPortMessageV1 } from '../export/blob-url-protocol.js';
import { canonicalRetentionInstant } from '../storage/audit-retention.js';
import { createBlobUrlRegistryV1 } from './blob-url-registry.js';
import { deriveExportLeaseOwner } from './export-launch.js';
import { deriveTrustedExtensionContext, EXPORT_SURFACE } from './target-capabilities.js';

const TIMEOUT_MS = 5000;
const MAX_PENDING = 32;
function unavailable() { return new Error('BLOB_PORT_UNAVAILABLE'); }
function own(value, key) {
  const descriptor = value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, key) : null;
  if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw unavailable();
  return descriptor.value;
}
function nativeSender(value) {
  const tab = own(value, 'tab');
  return Object.freeze({ id: own(value, 'id'), url: own(value, 'url'), documentId: own(value, 'documentId'),
    frameId: own(value, 'frameId'), tab: Object.freeze({ id: own(tab, 'id'), windowId: own(tab, 'windowId') }) });
}

export function createBlobUrlPortBridgeV1({ chromeApi, sessionArea, exportLaunch, auditStore, now } = {}) {
  let getContexts; let getLaunch; let getSession; let getLease; let extensionId;
  try {
    const bind = (owner, name) => {
      const method = owner?.[name];
      if (typeof method !== 'function') throw unavailable();
      return method.bind(owner);
    };
    extensionId = chromeApi.runtime.id;
    if (typeof extensionId !== 'string' || !/^[a-p]{32}$/u.test(extensionId) || typeof now !== 'function') throw unavailable();
    getContexts = bind(chromeApi.runtime, 'getContexts');
    getLaunch = bind(exportLaunch, 'getLaunch');
    getSession = bind(exportLaunch, 'getSession');
    getLease = bind(auditStore, 'getExportLeaseState');
  } catch { throw unavailable(); }
  const trustedChrome = { runtime: { id: extensionId, getContexts } };
  const bindings = new Map();
  const owners = new Map();
  let disposed = false;
  const current = () => {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0 || !Number.isFinite(new Date(value).getTime())) throw unavailable();
    return value;
  };
  const expectedUrl = auditId => `chrome-extension://${extensionId}${EXPORT_SURFACE.path}?auditId=${auditId}`;
  const active = binding => !disposed && bindings.get(binding.port) === binding && binding.ready;

  function disconnect(binding) {
    if (bindings.get(binding.port) !== binding) return;
    bindings.delete(binding.port);
    if (owners.get(binding.sender.documentId) === binding) owners.delete(binding.sender.documentId);
    for (const pending of binding.revocations.values()) {
      clearTimeout(pending.timer); pending.reject(unavailable());
    }
    binding.revocations.clear();
    try { binding.port.onMessage.removeListener(binding.onMessage); } catch {}
    try { binding.port.onDisconnect.removeListener(binding.onDisconnect); } catch {}
    try { binding.port.disconnect(); } catch {}
  }

  async function isOwnerAlive({ ownerDocumentId }) {
    if (disposed) throw unavailable();
    const contexts = await getContexts({ documentIds: [ownerDocumentId] });
    if (disposed || !Array.isArray(contexts) || Object.getPrototypeOf(contexts) !== Array.prototype ||
      Reflect.ownKeys(contexts).length !== contexts.length + 1) throw unavailable();
    if (contexts.length === 0) return false;
    if (contexts.length !== 1) throw unavailable();
    const context = contexts[0];
    const url = new URL(own(context, 'documentUrl'));
    const auditId = url.searchParams.get('auditId');
    if (own(context, 'documentId') !== ownerDocumentId || own(context, 'contextType') !== 'TAB' ||
      own(context, 'frameId') !== 0 || !/^[A-Za-z0-9_-]{1,160}$/u.test(auditId ?? '') ||
      url.href !== expectedUrl(auditId)) throw unavailable();
    for (const key of ['tabId', 'windowId']) {
      const id = own(context, key);
      if (!Number.isSafeInteger(id) || id < 0) throw unavailable();
    }
    return true;
  }

  function revokeInOwner({ auditId, blobUrl, ownerDocumentId }) {
    const binding = owners.get(ownerDocumentId);
    if (!binding || !active(binding) || binding.auditId !== auditId || !isExportBlobUrlV1(blobUrl, extensionId)) {
      return Promise.reject(unavailable());
    }
    const requestId = ++binding.revokeSequence;
    if (!Number.isSafeInteger(requestId)) return Promise.reject(unavailable());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => disconnect(binding), TIMEOUT_MS);
      binding.revocations.set(requestId, { resolve, reject, timer });
      try { binding.port.postMessage({ type: 'revoke', requestId, blobUrl }); }
      catch { disconnect(binding); }
    });
  }

  const registry = createBlobUrlRegistryV1({ sessionArea, isOwnerAlive, revokeInOwner });

  async function authorizeRegister(binding) {
    const [launch, session] = await Promise.all([getLaunch(binding.auditId), getSession(binding.sessionCapabilityId)]);
    if (!active(binding)) throw unavailable();
    const { sender, auditId } = binding;
    if (!launch || !session || launch.state !== 'connected' || session.state !== 'active' ||
      launch.auditId !== auditId || session.auditId !== auditId || session.sessionCapabilityId !== binding.sessionCapabilityId ||
      launch.documentId !== sender.documentId || session.launchDocumentId !== sender.documentId ||
      launch.tabId !== sender.tab.id || session.launchTabId !== sender.tab.id || launch.windowId !== sender.tab.windowId ||
      launch.path !== EXPORT_SURFACE.path || session.expectedRevision !== launch.expectedRevision ||
      session.attemptId !== launch.attemptId || session.expiresAt !== launch.expiresAt) throw unavailable();
    const before = current();
    const lease = await getLease(auditId, { now: new Date(before).toISOString() });
    if (!active(binding)) throw unavailable();
    const at = current();
    if (at < before || !Number.isSafeInteger(launch.issuedAt) || !Number.isSafeInteger(session.issuedAt) ||
      at < launch.issuedAt || at < session.issuedAt || !Number.isSafeInteger(launch.expiresAt) ||
      launch.expiresAt <= at || !Number.isSafeInteger(session.expiresAt) || session.expiresAt <= at ||
      lease?.active !== true || lease.phase !== 'delivering' || canonicalRetentionInstant(lease.retryAt).milliseconds <= at ||
      lease.revision !== launch.expectedRevision || lease.exportAttempt !== Number(launch.attemptId) ||
      lease.ownerId !== deriveExportLeaseOwner(auditId, launch.attemptId)) throw unavailable();
  }

  async function acceptHello(binding, message) {
    const context = await deriveTrustedExtensionContext({ sender: binding.sender, chromeApi: trustedChrome, surface: EXPORT_SURFACE });
    if (disposed || bindings.get(binding.port) !== binding || binding.sender.frameId !== 0 ||
      context.tabId !== binding.sender.tab.id || context.windowId !== binding.sender.tab.windowId ||
      context.documentUrl !== expectedUrl(message.auditId)) throw unavailable();
    binding.auditId = message.auditId;
    binding.sessionCapabilityId = message.sessionCapabilityId;
    binding.ready = true;
    const previous = owners.get(binding.sender.documentId);
    if (previous && previous !== binding) disconnect(previous);
    owners.set(binding.sender.documentId, binding);
    binding.port.postMessage({ type: 'ready' });
  }

  function receive(binding, raw) {
    const message = parseBlobPortMessageV1(raw, 'client');
    if (!message) { disconnect(binding); return; }
    if (message.type === 'hello') {
      if (binding.hello) { disconnect(binding); return; }
      binding.hello = true;
      void acceptHello(binding, message).catch(() => disconnect(binding));
      return;
    }
    if (!active(binding)) { disconnect(binding); return; }
    // ACK dispatch must never wait behind the registry operation awaiting this very ACK.
    if (message.type === 'revoked') {
      const pending = binding.revocations.get(message.requestId);
      if (!pending) { disconnect(binding); return; }
      binding.revocations.delete(message.requestId);
      clearTimeout(pending.timer);
      if (message.ok === true) pending.resolve(true);
      else pending.reject(unavailable());
      return;
    }
    if (binding.requests.has(message.requestId) || binding.pending >= MAX_PENDING) { disconnect(binding); return; }
    binding.requests.add(message.requestId);
    binding.pending += 1;
    const operation = async () => {
      if (!active(binding)) return;
      let ok = false;
      try {
        if (!isExportBlobUrlV1(message.blobUrl, extensionId)) throw unavailable();
        if (message.type === 'register') await authorizeRegister(binding);
        if (!active(binding)) throw unavailable();
        await registry[message.type]({ auditId: binding.auditId, blobUrl: message.blobUrl, ownerDocumentId: binding.sender.documentId });
        ok = true;
      } catch { /* Only the closed boolean result crosses the Port. */ }
      if (active(binding)) {
        try { binding.port.postMessage({ type: 'result', requestId: message.requestId, ok }); }
        catch { disconnect(binding); }
      }
    };
    binding.tail = binding.tail.then(operation).catch(() => disconnect(binding)).finally(() => { binding.pending -= 1; });
  }

  function attachPort(port) {
    if (disposed || port?.name !== BLOB_URL_PORT_NAME || bindings.has(port)) return false;
    let binding;
    try {
      for (const method of ['postMessage', 'disconnect']) if (typeof port[method] !== 'function') throw unavailable();
      for (const event of ['onMessage', 'onDisconnect']) for (const method of ['addListener', 'removeListener']) {
        if (typeof port[event]?.[method] !== 'function') throw unavailable();
      }
      binding = { port, sender: nativeSender(port.sender), hello: false, ready: false,
        auditId: null, sessionCapabilityId: null, requests: new Set(), revocations: new Map(),
        pending: 0, revokeSequence: 0, tail: Promise.resolve() };
      binding.onMessage = value => receive(binding, value);
      binding.onDisconnect = () => disconnect(binding);
      bindings.set(port, binding);
      port.onMessage.addListener(binding.onMessage);
      port.onDisconnect.addListener(binding.onDisconnect);
      return true;
    } catch {
      if (binding) disconnect(binding);
      else try { port?.disconnect?.(); } catch {}
      return false;
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const binding of [...bindings.values()]) disconnect(binding);
  }
  return Object.freeze({ registry, attachPort, dispose });
}
