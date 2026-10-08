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

// Endereço do documento sem o fragmento, reduzido a um token de comparação só em memória (nunca persistido
// nem registrado). Serve para reconhecer navegação de fragmento no mesmo documento: carrosséis, âncoras e SPAs
// antigas trocam #... sozinhos a cada poucos segundos, e cada troca chegava aqui como "loading" + url e
// abortava a auditoria em andamento e reiniciava o painel (bateria de páginas hostis, 1.1.53). A prova de
// documento (documentId + digest) continua sendo a autoridade: se o documento tiver mudado de fato, ela
// detecta.
function addressTokenFactory() {
  const salt = [];
  try {
    const bytes = new Uint32Array(2);
    globalThis.crypto.getRandomValues(bytes);
    salt.push(bytes[0], bytes[1]);
  } catch { salt.push(0x811c9dc5, 0x01000193); }
  return url => {
    let address;
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) return null;
      parsed.hash = '';
      address = parsed.href;
    } catch { return null; }
    let first = salt[0] >>> 0;
    let second = salt[1] >>> 0;
    for (let index = 0; index < address.length; index += 1) {
      const code = address.charCodeAt(index);
      first = Math.imul(first ^ code, 0x01000193) >>> 0;
      second = Math.imul(second ^ code, 0x5bd1e995) >>> 0;
    }
    return `${first.toString(36)}.${second.toString(36)}.${address.length}`;
  };
}

export function createAuditLifecycle(raw) {
  const input = exact(raw, ['chromeApi', 'getReadyRuntime']) ??
    exact(raw, ['chromeApi', 'getReadyRuntime', 'rebindPanelForNavigation']) ??
    exact(raw, ['chromeApi', 'getReadyRuntime', 'rebindPanelForNavigation', 'notePanelNavigationInterruption']);
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
    (Object.hasOwn(input, 'notePanelNavigationInterruption') &&
      typeof input.notePanelNavigationInterruption !== 'function') ||
    typeof windowRemoved?.addListener !== 'function' || typeof windowRemoved.removeListener !== 'function') {
    throw new TypeError('AUDIT_LIFECYCLE_INVALID');
  }

  let registered = false;
  const tabTails = new Map();
  const addressToken = addressTokenFactory();
  const lastAddress = new Map();

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
      let settlement = null;
      try { settlement = await runtime.auditStarter.abortAttachedAuditForTarget({ tabId, windowId: null, reasonCode }); }
      catch { /* a failed unified liquidation remains fail-closed */ }
      if (personaReason !== null) {
        await bestEffort(() => runtime.highlightController?.invalidateTab?.(tabId, personaReason));
      }
      if (settlement?.handled !== true) {
        await bestEffort(() => runtime.authority.invalidateForTab(tabId, reasonCode));
      }
      if (personaReason !== null) {
        await bestEffort(() => runtime.personaCoordinator?.invalidateTab?.(tabId, personaReason));
      }
      if (changeInfo !== null) {
        await bestEffort(() => runtime.reportLaunch?.handleTabUpdated?.(tabId, changeInfo));
        await bestEffort(() => runtime.exportLaunch?.handleTabUpdated?.(tabId, changeInfo));
        if (reasonCode === 'TAB_LOADING' && typeof input.rebindPanelForNavigation === 'function') {
          // O painel desta aba vai ser recriado; se uma auditoria acabou de ser interrompida pela navegação,
          // o painel novo precisa dizer isso em vez de voltar ao início em silêncio.
          if (settlement?.aborted === true && typeof settlement.auditId === 'string' &&
            typeof input.notePanelNavigationInterruption === 'function') {
            await bestEffort(() => input.notePanelNavigationInterruption({ tabId, auditId: settlement.auditId }));
          }
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
      let settlement = null;
      try {
        settlement = await runtime.auditStarter.abortAttachedAuditForTarget({
          tabId: null, windowId, reasonCode: 'WINDOW_REMOVED',
        });
      } catch { /* a failed unified liquidation remains fail-closed */ }
      if (settlement?.handled !== true) {
        await bestEffort(() => runtime.authority.invalidateForWindow(windowId, 'WINDOW_REMOVED'));
      }
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
    if (url.found && typeof url.value === 'string') {
      const next = addressToken(url.value);
      const previous = lastAddress.get(tabId);
      if (next === null) lastAddress.delete(tabId); else lastAddress.set(tabId, next);
      // Mesmo endereço, só o fragmento mudou, sem navegação pendente: mesmo documento.
      if (reason && previous !== undefined && next !== null && previous === next &&
        !(pendingUrl.found && typeof pendingUrl.value === 'string' && pendingUrl.value !== '')) return;
    }
    if (reason) scheduleTab(tabId, () => invalidateTab(tabId, reason, changeInfo,
      reason === 'TAB_DISCARDED' ? 'discarded' : 'navigation'));
  };
  const onTabRemoved = tabId => {
    if (safeChromeId(tabId)) lastAddress.delete(tabId);
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
    // Semente: endereço atual de cada aba, para que a primeira troca de fragmento já seja reconhecida.
    try {
      const pending = typeof input.chromeApi.tabs.query === 'function' ? input.chromeApi.tabs.query({}) : null;
      if (pending && typeof pending.then === 'function') {
        void pending.then(tabs => {
          for (const tab of Array.isArray(tabs) ? tabs : []) {
            const id = ownData(tab, 'id');
            const tabUrl = ownData(tab, 'url');
            if (!id.found || !safeChromeId(id.value) || !tabUrl.found || typeof tabUrl.value !== 'string') continue;
            if (lastAddress.has(id.value)) continue;
            const token = addressToken(tabUrl.value);
            if (token !== null) lastAddress.set(id.value, token);
          }
        }, () => {});
      }
    } catch { /* sem semente: a primeira mudança de endereço de cada aba invalida, como antes */ }
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
