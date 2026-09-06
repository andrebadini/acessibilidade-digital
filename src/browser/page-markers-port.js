export function bindAuditaPageMarkersPort(installationId, environment = globalThis) {
  function ownValue(object, key) {
    try {
      const descriptor = object && typeof object === 'object'
        ? Reflect.getOwnPropertyDescriptor(object, key)
        : null;
      return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
    } catch {
      return undefined;
    }
  }

  function ownedSlot(name) {
    try {
      const descriptor = Reflect.getOwnPropertyDescriptor(environment, name);
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable ||
        !descriptor.configurable || descriptor.writable || !descriptor.value ||
        typeof descriptor.value !== 'object') return null;
      return descriptor.value;
    } catch {
      return null;
    }
  }

  function exactOverlay() {
    const overlay = ownedSlot('__auditaPageMarkersOverlayV1');
    if (!overlay || ownValue(overlay, 'version') !== 1 ||
      ownValue(overlay, 'installationId') !== installationId ||
      typeof ownValue(overlay, 'dispose') !== 'function' ||
      typeof ownValue(overlay, 'execute') !== 'function') return null;
    return overlay;
  }

  if (typeof installationId !== 'string' || !/^[A-Za-z0-9_-]{22}$/u.test(installationId)) {
    return { ok: false };
  }
  const overlay = exactOverlay();
  if (!overlay) return { ok: false };
  const prior = ownedSlot('__auditaPageMarkersPortV1');
  if (prior) {
    return ownValue(prior, 'version') === 1 && ownValue(prior, 'installationId') === installationId &&
      ownValue(prior, 'overlay') === overlay && typeof ownValue(prior, 'dispose') === 'function'
      ? { ok: true }
      : { ok: false };
  }
  try {
    if (Reflect.getOwnPropertyDescriptor(environment, '__auditaPageMarkersPortV1')) return { ok: false };
  } catch {
    return { ok: false };
  }

  const runtime = environment?.chrome?.runtime;
  const setTimer = environment?.setTimeout;
  const clearTimer = environment?.clearTimeout;
  if (!runtime || typeof runtime.connect !== 'function' || typeof setTimer !== 'function' ||
    typeof clearTimer !== 'function') return { ok: false };

  let port;
  try { port = runtime.connect({ name: 'audita-page-markers-v1' }); }
  catch { return { ok: false }; }
  const onDisconnect = port?.onDisconnect;
  if (!port || typeof port.postMessage !== 'function' || typeof port.disconnect !== 'function' ||
    !onDisconnect || typeof onDisconnect.addListener !== 'function' ||
    typeof onDisconnect.removeListener !== 'function') return { ok: false };

  const overlayDispose = ownValue(overlay, 'dispose');
  let state = null;
  let timer = null;
  let stopped = false;
  function ownsBinderSlot() {
    return ownedSlot('__auditaPageMarkersPortV1') === state;
  }
  function cleanup(disconnectPort = true) {
    if (stopped) return;
    stopped = true;
    if (timer !== null) {
      try { Reflect.apply(clearTimer, environment, [timer]); } catch {}
      timer = null;
    }
    try { onDisconnect.removeListener(cleanup); } catch {}
    try { Reflect.apply(overlayDispose, overlay, [true]); } catch {}
    if (ownsBinderSlot()) {
      try { Reflect.deleteProperty(environment, '__auditaPageMarkersPortV1'); } catch {}
    }
    if (disconnectPort) {
      try { port.disconnect(); } catch {}
    }
  }
  function heartbeat() {
    timer = null;
    if (stopped) return;
    if (exactOverlay() !== overlay || !ownsBinderSlot()) {
      cleanup();
      return;
    }
    try {
      port.postMessage({ type: 'AUDITA_PAGE_MARKERS_PING', installationId });
      timer = Reflect.apply(setTimer, environment, [heartbeat, 20_000]);
    } catch {
      cleanup();
    }
  }

  state = Object.freeze({ version: 1, installationId, overlay, dispose: cleanup });
  try {
    Object.defineProperty(environment, '__auditaPageMarkersPortV1', {
      value: state, enumerable: false, configurable: true, writable: false,
    });
    if (!ownsBinderSlot()) throw new Error('registration failed');
    onDisconnect.addListener(cleanup);
    port.postMessage({ type: 'AUDITA_PAGE_MARKERS_HELLO', installationId });
    timer = Reflect.apply(setTimer, environment, [heartbeat, 20_000]);
    return { ok: true };
  } catch {
    cleanup();
    return { ok: false };
  }
}
