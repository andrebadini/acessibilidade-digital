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
    return descriptor?.enumerable && Object.hasOwn(descriptor, 'value')
      ? { found: true, value: descriptor.value }
      : { found: false };
  } catch { return { found: false }; }
}

function safeChromeId(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export function createAuditLifecycle(raw) {
  const input = exact(raw, ['chromeApi', 'getReadyRuntime']);
  const updated = input?.chromeApi?.tabs?.onUpdated;
  const removed = input?.chromeApi?.tabs?.onRemoved;
  const windowRemoved = input?.chromeApi?.windows?.onRemoved;
  if (!input || typeof input.getReadyRuntime !== 'function' ||
    typeof updated?.addListener !== 'function' || typeof updated.removeListener !== 'function' ||
    typeof removed?.addListener !== 'function' || typeof removed.removeListener !== 'function' ||
    typeof windowRemoved?.addListener !== 'function' || typeof windowRemoved.removeListener !== 'function') {
    throw new TypeError('AUDIT_LIFECYCLE_INVALID');
  }

  let registered = false;

  async function invalidateTab(tabId, reasonCode, changeInfo = null) {
    try {
      const runtime = await input.getReadyRuntime();
      await runtime.auditStarter.abortAttachedAuditForTarget({ tabId, windowId: null, reasonCode });
      await runtime.authority.invalidateForTab(tabId, reasonCode);
      if (changeInfo !== null) {
        await runtime.reportLaunch?.handleTabUpdated?.(tabId, changeInfo);
        await runtime.exportLaunch?.handleTabUpdated?.(tabId, changeInfo);
      } else {
        await runtime.reportLaunch?.handleTabRemoved?.(tabId);
        await runtime.exportLaunch?.handleTabRemoved?.(tabId);
      }
    } catch { /* readiness and invalidation failures are closed no-ops */ }
  }

  async function invalidateWindow(windowId) {
    try {
      const runtime = await input.getReadyRuntime();
      await runtime.auditStarter.abortAttachedAuditForTarget({ tabId: null, windowId, reasonCode: 'WINDOW_REMOVED' });
      await runtime.authority.invalidateForWindow(windowId, 'WINDOW_REMOVED');
      await runtime.reportLaunch?.handleWindowRemoved?.(windowId);
      await runtime.exportLaunch?.handleWindowRemoved?.(windowId);
    } catch { /* readiness and invalidation failures are closed no-ops */ }
  }

  const onUpdated = (tabId, changeInfo) => {
    if (!safeChromeId(tabId)) return;
    const status = ownData(changeInfo, 'status');
    const url = ownData(changeInfo, 'url');
    const pendingUrl = ownData(changeInfo, 'pendingUrl');
    const reason = status.found && status.value === 'loading'
      ? 'TAB_LOADING'
      : url.found && typeof url.value === 'string'
        ? 'TAB_URL_CHANGED'
        : pendingUrl.found && typeof pendingUrl.value === 'string'
          ? 'TAB_PENDING_URL'
          : null;
    if (reason) void invalidateTab(tabId, reason, changeInfo);
  };
  const onTabRemoved = tabId => { if (safeChromeId(tabId)) void invalidateTab(tabId, 'TAB_REMOVED'); };
  const onWindowRemoved = windowId => { if (safeChromeId(windowId)) void invalidateWindow(windowId); };

  function register() {
    if (registered) return false;
    registered = true;
    updated.addListener(onUpdated);
    removed.addListener(onTabRemoved);
    windowRemoved.addListener(onWindowRemoved);
    return true;
  }

  function dispose() {
    if (!registered) return false;
    registered = false;
    updated.removeListener(onUpdated);
    removed.removeListener(onTabRemoved);
    windowRemoved.removeListener(onWindowRemoved);
    return true;
  }

  return Object.freeze({ register, dispose });
}
