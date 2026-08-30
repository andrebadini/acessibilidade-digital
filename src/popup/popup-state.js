const PREPARATION_KEYS = [
  'auditCapabilityId',
  'expiresAt',
  'ok',
  'personaCapabilityId',
  'requestId',
  'windowId',
];

const fixedState = state => Object.freeze({
  auditReady: state.auditReady,
  otherReady: state.otherReady,
  preparing: state.preparing,
  inFlight: state.inFlight,
  message: state.message,
});

function exactDataRecord(value, expectedKeys) {
  let keys;
  let prototype;
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    return null;
  }
  if (prototype !== Object.prototype) return null;
  if (keys.some(key => typeof key !== 'string') || keys.length !== expectedKeys.length ||
    keys.slice().sort().some((key, index) => key !== expectedKeys[index])) return null;
  const record = Object.create(null);
  for (const key of expectedKeys) {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) return null;
      record[key] = descriptor.value;
    } catch {
      return null;
    }
  }
  return record;
}

function validOpaqueId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{22}$/u.test(value);
}

function validRequestId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{16,128}$/u.test(value);
}

function parsePreparation(value, requestId, now) {
  const record = exactDataRecord(value, PREPARATION_KEYS);
  if (!record || record.ok !== true || record.requestId !== requestId ||
    !validOpaqueId(record.auditCapabilityId) || !validOpaqueId(record.personaCapabilityId) ||
    !Number.isSafeInteger(record.windowId) || record.windowId < 0 ||
    !Number.isSafeInteger(record.expiresAt) || record.expiresAt <= now) return null;
  return Object.freeze({
    auditCapabilityId: record.auditCapabilityId,
    personaCapabilityId: record.personaCapabilityId,
    windowId: record.windowId,
    expiresAt: record.expiresAt,
  });
}

export function createPopupAuditMessage(capabilityId) {
  if (!validOpaqueId(capabilityId)) throw new TypeError('Autorização local inválida.');
  return Object.freeze({
    type: 'POPUP_START_AUDIT',
    capabilityId,
    captureMode: 'no-pixels',
    includeQuery: false,
    deleteAfterCompleteExport: false,
  });
}

export function createPopupController(options = {}) {
  const now = options.now ?? Date.now;
  const createRequestId = options.createRequestId ?? (() => crypto.randomUUID());
  const sendMessage = options.sendMessage;
  const sidePanelOpen = options.sidePanelOpen;
  const onStateChange = options.onStateChange ?? (() => {});
  if (typeof now !== 'function' || typeof createRequestId !== 'function' ||
    typeof sendMessage !== 'function' || typeof sidePanelOpen !== 'function' ||
    typeof onStateChange !== 'function') throw new TypeError('Dependências do popup inválidas.');

  let prepared = null;
  let preparationGeneration = 0;
  let preparing = false;
  let inFlight = false;
  let message = '';

  const snapshotState = () => fixedState({
    auditReady: prepared !== null && !inFlight,
    otherReady: prepared !== null && !inFlight,
    preparing,
    inFlight,
    message,
  });
  const notify = () => onStateChange(snapshotState());
  const invalidateIfExpired = () => {
    if (!prepared || prepared.expiresAt > now()) return false;
    prepared = null;
    message = 'A autorização local expirou. Preparando uma nova tentativa.';
    notify();
    return true;
  };

  async function prepareCapabilities() {
    const requestId = createRequestId();
    const generation = ++preparationGeneration;
    prepared = null;
    preparing = true;
    message = 'Preparando ações locais.';
    notify();
    if (!validRequestId(requestId)) {
      if (generation === preparationGeneration) {
        preparing = false;
        message = 'Não foi possível preparar as ações locais.';
        notify();
      }
      return false;
    }
    let response;
    try {
      response = await sendMessage({ type: 'PREPARE_POPUP_CAPABILITIES', requestId });
    } catch {
      response = null;
    }
    if (generation !== preparationGeneration) return false;
    try {
      prepared = parsePreparation(response, requestId, now());
    } catch {
      prepared = null;
    }
    preparing = false;
    message = prepared ? '' : 'Não foi possível preparar as ações locais.';
    notify();
    return prepared !== null;
  }

  async function handleAuditClick() {
    invalidateIfExpired();
    const clickSnapshot = prepared;
    if (!clickSnapshot || inFlight) return false;
    inFlight = true;
    message = '';
    notify();
    let panelOpened = false;
    try {
      const opening = sidePanelOpen({ windowId: clickSnapshot.windowId });
      await opening;
      panelOpened = true;
      const response = await sendMessage(createPopupAuditMessage(clickSnapshot.auditCapabilityId));
      if (prepared === clickSnapshot) prepared = null;
      if (!response || typeof response !== 'object' || response.ok !== true) {
        message = 'Não foi possível iniciar a auditoria local.';
        return false;
      }
      message = 'Auditoria iniciada no painel lateral.';
      return true;
    } catch {
      if (prepared === clickSnapshot) prepared = null;
      message = panelOpened
        ? 'Não foi possível iniciar a auditoria local.'
        : 'Não foi possível abrir o painel lateral.';
      return false;
    } finally {
      inFlight = false;
      notify();
    }
  }

  async function handleOtherClick() {
    invalidateIfExpired();
    const clickSnapshot = prepared;
    if (!clickSnapshot || inFlight) return false;
    inFlight = true;
    message = '';
    notify();
    try {
      const opening = sidePanelOpen({ windowId: clickSnapshot.windowId });
      await opening;
      message = 'Painel lateral aberto.';
      return true;
    } catch {
      message = 'Não foi possível abrir o painel lateral.';
      return false;
    } finally {
      inFlight = false;
      notify();
    }
  }

  return Object.freeze({
    prepareCapabilities,
    handleAuditClick,
    handleOtherClick,
    refreshValidity: invalidateIfExpired,
    getState: snapshotState,
  });
}
