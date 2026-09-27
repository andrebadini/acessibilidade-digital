import { createCapturePolicyV1 } from '../core/privacy/capture-policy.js';

export const CONTEXT_MENU_IDS = Object.freeze({ page: 'audita.accessibility.audit-page' });
export const CONTEXT_MENU_ITEMS = Object.freeze([Object.freeze({
  id: CONTEXT_MENU_IDS.page,
  title: 'Auditar esta página com Audita Acessibilidade',
  contexts: Object.freeze(['page']),
  documentUrlPatterns: Object.freeze(['http://*/*', 'https://*/*']),
})]);

const AUDIT_ID = /^[A-Za-z0-9._:-]{1,160}$/u;
const NONCE = /^[A-Za-z0-9_-]{22}$/u;

function exact(value, keys) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return null;
    const own = Reflect.ownKeys(value);
    if (own.length !== keys.length || own.some(key => typeof key !== 'string' || !keys.includes(key))) return null;
    const copy = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      copy[key] = descriptor.value;
    }
    return copy;
  } catch { return null; }
}

function ownData(value, key) {
  try {
    if (!value || typeof value !== 'object') return { found: false };
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) return { found: false };
    return descriptor?.enumerable && Object.hasOwn(descriptor, 'value')
      ? { found: true, value: descriptor.value }
      : { found: true, invalid: true };
  } catch { return { found: true, invalid: true }; }
}

function safeChromeId(value) { return Number.isSafeInteger(value) && value >= 0; }

function canonicalHttpUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const parsed = new URL(value);
    return ['http:', 'https:'].includes(parsed.protocol) && parsed.href === value &&
      parsed.username === '' && parsed.password === '';
  } catch { return false; }
}

export function parseContextMenuClick(info, tab) {
  const menuItemId = ownData(info, 'menuItemId');
  const frameId = ownData(info, 'frameId');
  const tabId = ownData(tab, 'id');
  const windowId = ownData(tab, 'windowId');
  const status = ownData(tab, 'status');
  const url = ownData(tab, 'url');
  const pendingUrl = ownData(tab, 'pendingUrl');
  if (!menuItemId.found || menuItemId.value !== CONTEXT_MENU_IDS.page || !frameId.found || frameId.value !== 0 ||
    !tabId.found || !safeChromeId(tabId.value) || !windowId.found || !safeChromeId(windowId.value) ||
    !status.found || !['complete', 'loading'].includes(status.value) || !url.found || !canonicalHttpUrl(url.value) ||
    pendingUrl.invalid || (pendingUrl.found && pendingUrl.value !== null && pendingUrl.value !== '')) return null;
  return Object.freeze({ tabId: tabId.value, windowId: windowId.value });
}

function cloneMenuItem(item) {
  return {
    id: item.id, title: item.title,
    contexts: [...item.contexts], documentUrlPatterns: [...item.documentUrlPatterns],
  };
}

async function invoke(chromeApi, receiver, name, ...args) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (handler, value) => { if (!settled) { settled = true; handler(value); } };
    try {
      const result = receiver[name](...args, value => {
        if (chromeApi.runtime?.lastError) finish(reject, new Error('CHROME_API_DENIED'));
        else finish(resolve, value);
      });
      if (result && typeof result.then === 'function') result.then(value => finish(resolve, value), () => finish(reject, new Error('CHROME_API_DENIED')));
      else if (receiver[name].length <= args.length) finish(resolve, result);
    } catch { finish(reject, new Error('CHROME_API_DENIED')); }
  });
}

export function registerAuditContextMenus(chromeApi, rawOptions) {
  const options = exact(rawOptions, ['getReadyRuntime', 'createEventNonce', 'createAuditId', 'epochNow', 'logger', 'launchPanel']);
  if (!options || typeof options.getReadyRuntime !== 'function' || typeof options.createEventNonce !== 'function' ||
    typeof options.createAuditId !== 'function' || typeof options.epochNow !== 'function' ||
    typeof options.launchPanel !== 'function' ||
    typeof options.logger?.error !== 'function' || typeof chromeApi?.runtime?.onInstalled?.addListener !== 'function' ||
    typeof chromeApi.runtime.onInstalled.removeListener !== 'function' ||
    typeof chromeApi?.contextMenus?.onClicked?.addListener !== 'function' ||
    typeof chromeApi.contextMenus.onClicked.removeListener !== 'function' ||
    typeof chromeApi.contextMenus.removeAll !== 'function' || typeof chromeApi.contextMenus.create !== 'function') {
    throw new TypeError('CONTEXT_MENU_INVALID');
  }

  let disposed = false;
  let installTail = Promise.resolve();

  async function installOnce() {
    if (disposed) return false;
    try {
      await invoke(chromeApi, chromeApi.contextMenus, 'removeAll');
      for (const item of CONTEXT_MENU_ITEMS) {
        await invoke(chromeApi, chromeApi.contextMenus, 'create', cloneMenuItem(item));
      }
      return true;
    } catch {
      try { await invoke(chromeApi, chromeApi.contextMenus, 'removeAll'); } catch { /* fixed rollback */ }
      options.logger.error('CONTEXT_MENU_INSTALL_FAILED');
      return false;
    }
  }

  function installMenus() {
    const operation = installTail.then(installOnce, installOnce);
    installTail = operation.catch(() => false);
    return operation;
  }

  const onInstalled = () => {
    void options.getReadyRuntime().then(() => installMenus(), () => {
      options.logger.error('CONTEXT_MENU_UNAVAILABLE');
    });
  };

  const onClicked = (info, tab) => {
    const admitted = parseContextMenuClick(info, tab);
    if (!admitted || disposed) return;
    const startAudit = () => {
      void Promise.resolve().then(async () => {
        try {
          const runtime = await options.getReadyRuntime();
          const proof = await runtime.chromeAdapter.probeDocumentIdentity(admitted.tabId);
          if (!proof || proof.tabId !== admitted.tabId || proof.windowId !== admitted.windowId ||
            typeof proof.documentId !== 'string' || !proof.documentId ||
            !/^hmac-sha256:[A-Za-z0-9_-]{43}$/u.test(proof.urlSessionDigest ?? '')) throw new Error('denied');
          const initialUrlEvidence = await runtime.chromeAdapter.getEvidenceUrl(admitted.tabId, false);
          if (!canonicalHttpUrl(initialUrlEvidence)) throw new Error('denied');
          const eventNonce = options.createEventNonce();
          const auditId = options.createAuditId();
          const epoch = options.epochNow();
          if (!NONCE.test(eventNonce ?? '') || !AUDIT_ID.test(auditId ?? '') || !Number.isSafeInteger(epoch) || epoch < 0) throw new Error('denied');
          const prepared = await runtime.authority.prepare({
            kind: 'attached', tabId: proof.tabId, windowId: proof.windowId, documentId: proof.documentId,
            initialUrlEvidence, initialUrlSessionDigest: proof.urlSessionDigest,
            createdBy: 'user', allowedIntent: 'start-audit',
            issuer: { type: 'worker-event', event: 'context-menu', eventNonce },
          });
          if (prepared?.ok !== true || !NONCE.test(prepared.capabilityId ?? '')) throw new Error('denied');
          const started = await runtime.auditStarter.beginAuthorizedAudit({
            capabilityId: prepared.capabilityId, eventNonce, auditId,
            capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
            retentionPreference: Object.freeze({ version: 1, deleteAfterCompleteExport: false }),
            senderContext: null,
          });
          if (started?.response?.ok !== true || started.response.auditId !== auditId || started.response.state !== 'running') {
            throw new Error('denied');
          }
        } catch {
          options.logger.error('CONTEXT_MENU_UNAVAILABLE');
        }
      });
    };
    try {
      // The launcher owns the callback-only setOptions -> open gesture chain.
      if (options.launchPanel({ id: admitted.tabId, windowId: admitted.windowId }, startAudit) !== true) {
        throw new Error('denied');
      }
    } catch {
      options.logger.error('CONTEXT_MENU_OPEN_FAILED');
    }
  };

  chromeApi.runtime.onInstalled.addListener(onInstalled);
  chromeApi.contextMenus.onClicked.addListener(onClicked);

  function dispose() {
    if (disposed) return false;
    disposed = true;
    chromeApi.runtime.onInstalled.removeListener(onInstalled);
    chromeApi.contextMenus.onClicked.removeListener(onClicked);
    return true;
  }

  return Object.freeze({ installMenus, dispose });
}
