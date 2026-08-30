const TOKEN = /^[A-Za-z0-9_-]{43}$/u;

function exact(value, keys) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return null;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== keys.length || ownKeys.some(key => typeof key !== 'string' || !keys.includes(key))) return null;
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
    const descriptor = value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, key) : null;
    return descriptor?.enumerable && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  } catch { return undefined; }
}

function safeChromeId(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validIssued(value) {
  const issued = exact(value, ['ok', 'token', 'path', 'generation']);
  return issued?.ok === true && TOKEN.test(issued.token ?? '') &&
    issued.path === `src/panel/index.html?launch=${issued.token}` &&
    Number.isSafeInteger(issued.generation) && issued.generation >= 1 ? Object.freeze(issued) : null;
}

export function createPanelLauncher(raw) {
  const input = exact(raw, ['chromeApi', 'launchAuthority', 'logger']);
  if (!input || typeof input.chromeApi?.sidePanel?.setOptions !== 'function' ||
    typeof input.chromeApi.sidePanel.open !== 'function' ||
    typeof input.launchAuthority?.issue !== 'function' || typeof input.launchAuthority.whenReady !== 'function' ||
    typeof input.launchAuthority.revoke !== 'function' ||
    typeof input.logger?.error !== 'function') throw new TypeError('PANEL_LAUNCHER_INVALID');

  const log = code => {
    try { input.logger.error(code); } catch { /* diagnostics cannot own launch state */ }
  };
  const revoke = issued => {
    try { void Promise.resolve(input.launchAuthority.revoke(issued)).catch(() => {}); }
    catch { /* expiry remains the final fail-closed cleanup */ }
  };
  const hasLastError = () => {
    try { return Boolean(input.chromeApi.runtime?.lastError); }
    catch { return true; }
  };

  function launch(tab, onOpened = undefined) {
    const tabId = ownData(tab, 'id');
    const windowId = ownData(tab, 'windowId');
    if (!safeChromeId(tabId) || !safeChromeId(windowId) ||
      (onOpened !== undefined && typeof onOpened !== 'function')) return false;
    let issued;
    try { issued = validIssued(input.launchAuthority.issue({ tabId, windowId })); }
    catch { issued = null; }
    if (!issued) {
      log('PANEL_LAUNCH_UNAVAILABLE');
      return false;
    }
    let setOptionsFinished = false;
    const onSetOptions = () => {
      if (setOptionsFinished) return;
      setOptionsFinished = true;
      if (hasLastError()) {
        revoke(issued);
        log('PANEL_LAUNCH_UNAVAILABLE');
        return;
      }
      let openFinished = false;
      const onOpen = () => {
        if (openFinished) return;
        openFinished = true;
        if (hasLastError()) {
          revoke(issued);
          log('PANEL_LAUNCH_UNAVAILABLE');
          return;
        }
        let readiness;
        try { readiness = input.launchAuthority.whenReady(issued); }
        catch { readiness = false; }
        void Promise.resolve(readiness).then(ready => {
          if (ready !== true) {
            revoke(issued);
            log('PANEL_LAUNCH_UNAVAILABLE');
            return;
          }
          try { onOpened?.(); } catch { log('PANEL_LAUNCH_CALLBACK_FAILED'); }
        }, () => {
          revoke(issued);
          log('PANEL_LAUNCH_UNAVAILABLE');
        });
      };
      try { input.chromeApi.sidePanel.open({ tabId }, onOpen); }
      catch {
        openFinished = true;
        revoke(issued);
        log('PANEL_LAUNCH_UNAVAILABLE');
      }
    };
    try {
      input.chromeApi.sidePanel.setOptions({ tabId, enabled: true, path: issued.path }, onSetOptions);
      return true;
    } catch {
      setOptionsFinished = true;
      revoke(issued);
      log('PANEL_LAUNCH_UNAVAILABLE');
      return false;
    }
  }

  return Object.freeze({ launch });
}
