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
  const input = exact(raw, ['chromeApi', 'getReadyRuntime']) ??
    exact(raw, ['chromeApi', 'getReadyRuntime', 'rebindPanelForNavigation']);
  const updated = input?.chromeApi?.tabs?.onUpdated;
  const removed = input?.chromeApi?.tabs?.onRemoved;
  const detached = input?.chromeApi?.tabs?.onDetached;
  const windowRemoved = input?.chromeApi?.windows?.onRemoved;
  const detachedAvailable = typeof detached?.addListener === 'function' && typeof detached.removeListener === 'function';
  const detachedMalformed = detached !== undefined && !detachedAvailable;
  if (!input || typeof input.getReadyRuntime !== 'function' ||
    typeof updated?.addListener !== 'function' || typeof updated.removeListener !== 'function' ||
    typeof removed?.addListener !== 'function' || typeof removed.removeListener !== 'function' ||
    detachedMalformed ||
    (Object.hasOwn(input, 'rebindPanelForNavigation') && typeof input.rebindPanelForNavigation !== 'function') ||
    typeof windowRemoved?.addListener !== 'function' || typeof windowRemoved.removeListener !== 'function') {
    throw new TypeError('AUDIT_LIFECYCLE_INVALID');
  }

  let registered = false;
  const tabTails = new Map();

  function scheduleTab(tabId, operation) {
    const prior = tabTails.get(tabId) ?? Promise.resolve();
    const current = prior.then(operation, operation);
    const tail = current.then(() => undefined, () => undefined);
    tabTails.set(tabId, tail);
    void tail.then(() => {
      if (tabTails.get(tabId) === tail) tabTails.delete(tabId);
    });
  }

  async function bestEffort(operation) {
    try { await operation(); } catch { /* each lifecycle stage is independently fail-closed */ }
  }

  async function invalidateTab(tabId, reasonCode, changeInfo = null, personaReason = null) {
    try {
      const runtime = await input.getReadyRuntime();
      await bestEffort(() => runtime.auditStarter.abortAttachedAuditForTarget({ tabId, windowId: null, reasonCode }));
      if (personaReason !== null) {
        await bestEffort(() => runtime.highlightController?.invalidateTab?.(tabId, personaReason));
      }
      await bestEffort(() => runtime.authority.invalidateForTab(tabId, reasonCode));
      if (personaReason !== null) {
        await bestEffort(() => runtime.personaCoordinator?.invalidateTab?.(tabId, personaReason));
      }
      if (changeInfo !== null) {
        await bestEffort(() => runtime.reportLaunch?.handleTabUpdated?.(tabId, changeInfo));
        await bestEffort(() => runtime.exportLaunch?.handleTabUpdated?.(tabId, changeInfo));
        if (reasonCode === 'TAB_LOADING' && typeof input.rebindPanelForNavigation === 'function') {
          await bestEffort(() => input.rebindPanelForNavigation({ tabId }));
        }
      } else {
        await bestEffort(() => runtime.reportLaunch?.handleTabRemoved?.(tabId));
        await bestEffort(() => runtime.exportLaunch?.handleTabRemoved?.(tabId));
      }
    } catch { /* readiness and invalidation failures are closed no-ops */ }
  }

  async function invalidateWindow(windowId) {
    try {
      const runtime = await input.getReadyRuntime();
      await bestEffort(() => runtime.auditStarter.abortAttachedAuditForTarget({ tabId: null, windowId, reasonCode: 'WINDOW_REMOVED' }));
      await bestEffort(() => runtime.authority.invalidateForWindow(windowId, 'WINDOW_REMOVED'));
      await bestEffort(() => runtime.personaCoordinator?.invalidateWindow?.(windowId, 'window-changed'));
      await bestEffort(() => runtime.reportLaunch?.handleWindowRemoved?.(windowId));
      await bestEffort(() => runtime.exportLaunch?.handleWindowRemoved?.(windowId));
    } catch { /* readiness and invalidation failures are closed no-ops */ }
  }

  const onUpdated = (tabId, changeInfo) => {
    if (!safeChromeId(tabId)) return;
    const status = ownData(changeInfo, 'status');
    const url = ownData(changeInfo, 'url');
    const pendingUrl = ownData(changeInfo, 'pendingUrl');
    const discarded = ownData(changeInfo, 'discarded');
    const reason = status.found && status.value === 'loading'
      ? 'TAB_LOADING'
      : url.found && typeof url.value === 'string'
        ? 'TAB_URL_CHANGED'
        : pendingUrl.found && typeof pendingUrl.value === 'string'
          ? 'TAB_PENDING_URL'
          : discarded.found && discarded.value === true
            ? 'TAB_DISCARDED'
          : null;
    if (reason) scheduleTab(tabId, () => invalidateTab(tabId, reason, changeInfo,
      reason === 'TAB_DISCARDED' ? 'discarded' : 'navigation'));
  };
  const onTabRemoved = tabId => {
    if (safeChromeId(tabId)) scheduleTab(tabId, () => invalidateTab(tabId, 'TAB_REMOVED', null, 'tab-removed'));
  };
  const onTabDetached = tabId => {
    if (safeChromeId(tabId)) scheduleTab(tabId, () => invalidateTab(tabId, 'TAB_REMOVED', null, 'window-changed'));
  };
  const onWindowRemoved = windowId => { if (safeChromeId(windowId)) void invalidateWindow(windowId); };

  function register() {
    if (registered) return false;
    registered = true;
    updated.addListener(onUpdated);
    removed.addListener(onTabRemoved);
    if (detachedAvailable) detached.addListener(onTabDetached);
    windowRemoved.addListener(onWindowRemoved);
    return true;
  }

  function dispose() {
    if (!registered) return false;
    registered = false;
    updated.removeListener(onUpdated);
    removed.removeListener(onTabRemoved);
    if (detachedAvailable) detached.removeListener(onTabDetached);
    windowRemoved.removeListener(onWindowRemoved);
    return true;
  }

  return Object.freeze({ register, dispose });
}
