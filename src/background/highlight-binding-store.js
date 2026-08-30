import { validateHighlightBindingV1 } from './highlight-binding.js';

const REGISTRY_KEY = 'audita:highlight-bindings:v1';
const REGISTRY_KEYS = Object.freeze(['version', 'bindingsByAuditPage', 'activeOverlayByTab']);
const OVERLAY_KEYS = Object.freeze([
  'version', 'tabId', 'windowId', 'topDocumentId', 'documentId', 'frameId', 'nonce',
  'auditId', 'occurrenceId', 'createdAt', 'expiresAt', 'state', 'revision',
]);
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const IDENTIFIER = /^[A-Za-z0-9._:-]{1,200}$/u;
const DOCUMENT_ID = /^[A-Za-z0-9._:-]{1,240}$/u;
const NONCE = /^[A-Za-z0-9_-]{22}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const TTL_MS = 30 * 60_000;
const MAX_REGISTRY_ENTRIES = 4_096;
const MAX_TOTAL_TARGETS = 5_000;
const MODEL_DIVERGENCE_SENTINEL = Object.freeze(Object.create(null));

function exactDataRecord(value, expectedKeys) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== expectedKeys.length || keys.some(key => typeof key !== 'string') ||
      expectedKeys.some(key => !keys.includes(key))) return null;
    const result = Object.create(null);
    for (const key of expectedKeys) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    return null;
  }
}

function dynamicDataEntries(value, maximum = MAX_REGISTRY_ENTRIES) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length > maximum || keys.some(key => typeof key !== 'string' || DANGEROUS_KEYS.has(key))) return null;
    const entries = [];
    for (const key of keys) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      entries.push([key, descriptor.value]);
    }
    return entries;
  } catch {
    return null;
  }
}

function boundedId(value) {
  return typeof value === 'string' && IDENTIFIER.test(value) && !DANGEROUS_KEYS.has(value);
}

function chromeId(value, { positive = false } = {}) {
  return Number.isSafeInteger(value) && (positive ? value > 0 : value >= 0);
}

function safeTimestamp(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function bindingKey(binding) {
  return `${binding.auditId}\u0000${binding.pageId}`;
}

function overlayKey(tabId) {
  return String(tabId);
}

function overlayRecord(value) {
  const record = exactDataRecord(value, OVERLAY_KEYS);
  if (!record || record.version !== 1 || !chromeId(record.tabId) || !chromeId(record.windowId) ||
    typeof record.topDocumentId !== 'string' || !DOCUMENT_ID.test(record.topDocumentId) ||
    typeof record.documentId !== 'string' || !DOCUMENT_ID.test(record.documentId) ||
    !chromeId(record.frameId) || typeof record.nonce !== 'string' || !NONCE.test(record.nonce) ||
    !boundedId(record.auditId) ||
    !boundedId(record.occurrenceId) || !safeTimestamp(record.createdAt) ||
    !safeTimestamp(record.expiresAt) || record.expiresAt < record.createdAt ||
    !Number.isSafeInteger(record.createdAt + TTL_MS) || record.expiresAt > record.createdAt + TTL_MS ||
    !['installing', 'active', 'clearing'].includes(record.state) ||
    !Number.isSafeInteger(record.revision) || record.revision < 1) return null;
  return {
    version: 1,
    tabId: record.tabId,
    windowId: record.windowId,
    topDocumentId: record.topDocumentId,
    documentId: record.documentId,
    frameId: record.frameId,
    nonce: record.nonce,
    auditId: record.auditId,
    occurrenceId: record.occurrenceId,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    state: record.state,
    revision: record.revision,
  };
}

function newRegistry() {
  return {
    version: 1,
    bindingsByAuditPage: Object.create(null),
    activeOverlayByTab: Object.create(null),
  };
}

function divergentModel() {
  throw new Error('Modelo divergente.');
}

function markRegistryModelDivergence() {
  throw MODEL_DIVERGENCE_SENTINEL;
}

function registryRecord(value) {
  const record = exactDataRecord(value, REGISTRY_KEYS);
  if (!record || record.version !== 1) return null;
  const bindingEntries = dynamicDataEntries(record.bindingsByAuditPage);
  const overlayEntries = dynamicDataEntries(record.activeOverlayByTab);
  if (!bindingEntries || !overlayEntries) return null;
  const registry = newRegistry();
  const identityByAudit = new Map();
  const occurrenceByAudit = new Map();
  let totalTargets = 0;
  try {
    for (const [key, rawBinding] of bindingEntries) {
      const binding = validateHighlightBindingV1(rawBinding);
      if (key !== bindingKey(binding) || Object.hasOwn(registry.bindingsByAuditPage, key)) return null;
      const identity = identityByAudit.get(binding.auditId);
      if (identity && (identity.modelRevision !== binding.modelRevision || identity.modelHash !== binding.modelHash)) {
        markRegistryModelDivergence();
      }
      identityByAudit.set(binding.auditId, {
        modelRevision: binding.modelRevision, modelHash: binding.modelHash,
      });
      const occurrences = occurrenceByAudit.get(binding.auditId) ?? new Set();
      for (const occurrenceId of Object.keys(binding.targets)) {
        if (occurrences.has(occurrenceId)) return null;
        occurrences.add(occurrenceId);
      }
      occurrenceByAudit.set(binding.auditId, occurrences);
      totalTargets += Object.keys(binding.targets).length;
      if (totalTargets > MAX_TOTAL_TARGETS) return null;
      registry.bindingsByAuditPage[key] = binding;
    }
    for (const [key, rawOverlay] of overlayEntries) {
      const overlay = overlayRecord(rawOverlay);
      if (!overlay || key !== overlayKey(overlay.tabId) || Object.hasOwn(registry.activeOverlayByTab, key)) return null;
      registry.activeOverlayByTab[key] = deepFreezePlain(overlay);
    }
  } catch (error) {
    if (error === MODEL_DIVERGENCE_SENTINEL) throw error;
    return null;
  }
  return registry;
}

function copyRegistry(registry) {
  const copy = newRegistry();
  for (const [key, binding] of Object.entries(registry.bindingsByAuditPage)) {
    copy.bindingsByAuditPage[key] = binding;
  }
  for (const [key, overlay] of Object.entries(registry.activeOverlayByTab)) {
    copy.activeOverlayByTab[key] = overlay;
  }
  return copy;
}

function overlayMatchesStoredBinding(registry, overlay) {
  const matches = Object.values(registry.bindingsByAuditPage).filter(binding =>
    binding.auditId === overlay.auditId && Object.hasOwn(binding.targets, overlay.occurrenceId));
  if (matches.length !== 1) return false;
  const binding = matches[0];
  const target = binding.targets[overlay.occurrenceId];
  return binding.tabId === overlay.tabId && binding.windowId === overlay.windowId &&
    binding.topDocumentId === overlay.topDocumentId && target.documentId === overlay.documentId &&
    target.frameId === overlay.frameId && overlay.createdAt >= binding.createdAt &&
    overlay.createdAt < binding.expiresAt && overlay.expiresAt === binding.expiresAt;
}

function deepFreezePlain(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const key of Object.keys(value)) deepFreezePlain(value[key]);
  return Object.freeze(value);
}

function sameValue(left, right) {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object' ||
    Array.isArray(left) !== Array.isArray(right)) return false;
  const leftKeys = Reflect.ownKeys(left);
  const rightKeys = Reflect.ownKeys(right);
  if (leftKeys.length !== rightKeys.length || leftKeys.some(key => !rightKeys.includes(key))) return false;
  return leftKeys.every(key => sameValue(left[key], right[key]));
}

function nextRevision(revision) {
  if (!Number.isSafeInteger(revision) || revision < 1 || revision >= Number.MAX_SAFE_INTEGER) {
    throw new Error('HIGHLIGHT_OVERLAY_REVISION_OVERFLOW');
  }
  return revision + 1;
}

function success(overlay) {
  return deepFreezePlain({ ok: true, overlay });
}

function failure(code) {
  return Object.freeze({ ok: false, code });
}

function inputError() {
  throw new TypeError('HIGHLIGHT_INPUT_INVALID');
}

function readTabId(value) {
  if (!chromeId(value)) inputError();
  return value;
}

function readAuditId(value) {
  if (!boundedId(value)) inputError();
  return value;
}

function readCasInput(value) {
  const input = exactDataRecord(value, ['tabId', 'nonce', 'expectedRevision']);
  if (!input || !chromeId(input.tabId) || typeof input.nonce !== 'string' || !NONCE.test(input.nonce) ||
    !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) inputError();
  return input;
}

function readFindInput(value) {
  const short = exactDataRecord(value, ['auditId', 'occurrenceId']);
  const complete = short ? null : exactDataRecord(value, [
    'auditId', 'occurrenceId', 'expectedModelRevision', 'expectedModelHash',
  ]);
  const input = short ?? complete;
  if (!input || !boundedId(input.auditId) || !boundedId(input.occurrenceId)) inputError();
  if (complete && (!Number.isSafeInteger(complete.expectedModelRevision) || complete.expectedModelRevision < 1 ||
    typeof complete.expectedModelHash !== 'string' || !SHA256.test(complete.expectedModelHash))) divergentModel();
  if (!short && !complete) {
    const partial = exactDataRecord(value, ['auditId', 'occurrenceId', 'expectedModelRevision']);
    if (partial && boundedId(partial.auditId) && boundedId(partial.occurrenceId)) divergentModel();
  }
  return input;
}

function ownMethod(value, name) {
  try {
    const descriptor = value && typeof value === 'object'
      ? Reflect.getOwnPropertyDescriptor(value, name)
      : null;
    return descriptor?.enumerable && Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'function'
      ? descriptor.value
      : null;
  } catch {
    return null;
  }
}

export function createHighlightBindingStore(raw = undefined) {
  const options = exactDataRecord(raw, ['sessionArea', 'now']);
  const sessionArea = options?.sessionArea;
  const get = ownMethod(sessionArea, 'get');
  const set = ownMethod(sessionArea, 'set');
  if (!options || !get || !set || typeof options.now !== 'function') {
    throw new TypeError('HIGHLIGHT_BINDING_STORE_INVALID');
  }

  let tail = Promise.resolve();
  let lastNow = null;
  const serialize = operation => {
    const pending = tail.then(operation, operation);
    tail = pending.then(() => undefined, () => undefined);
    return pending;
  };

  function readNow() {
    const value = options.now();
    if (!safeTimestamp(value) || (lastNow !== null && value < lastNow)) {
      throw new TypeError('HIGHLIGHT_CLOCK_INVALID');
    }
    lastNow = value;
    return value;
  }

  async function loadRegistry() {
    try {
      const envelope = await Reflect.apply(get, sessionArea, [REGISTRY_KEY]);
      if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw new Error();
      const prototype = Reflect.getPrototypeOf(envelope);
      if (prototype !== Object.prototype && prototype !== null) throw new Error();
      const keys = Reflect.ownKeys(envelope);
      if (keys.length === 0) return deepFreezePlain(newRegistry());
      if (keys.length !== 1 || keys[0] !== REGISTRY_KEY) throw new Error();
      const descriptor = Reflect.getOwnPropertyDescriptor(envelope, REGISTRY_KEY);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error();
      const registry = registryRecord(descriptor.value);
      if (!registry) throw new Error();
      return deepFreezePlain(registry);
    } catch (error) {
      if (error === MODEL_DIVERGENCE_SENTINEL) divergentModel();
      throw new Error('HIGHLIGHT_REGISTRY_INVALID');
    }
  }

  async function persist(rawRegistry) {
    let registry;
    try {
      registry = registryRecord(rawRegistry);
      if (!registry) throw new Error();
    } catch (error) {
      if (error === MODEL_DIVERGENCE_SENTINEL) divergentModel();
      throw new Error('HIGHLIGHT_REGISTRY_INVALID');
    }
    const frozen = deepFreezePlain(registry);
    try {
      await Reflect.apply(set, sessionArea, [{ [REGISTRY_KEY]: frozen }]);
      const confirmed = await loadRegistry();
      if (!sameValue(confirmed, frozen)) throw new Error();
      return confirmed;
    } catch {
      throw new Error('HIGHLIGHT_REGISTRY_WRITE_DENIED');
    }
  }

  const put = rawBinding => serialize(async () => {
    let binding;
    try { binding = validateHighlightBindingV1(rawBinding); } catch { inputError(); }
    let actionAt = readNow();
    if (binding.createdAt > actionAt) throw new TypeError('HIGHLIGHT_CLOCK_INVALID');
    if (binding.expiresAt <= actionAt) throw new Error('HIGHLIGHT_BINDING_EXPIRED');
    const registry = await loadRegistry();
    actionAt = readNow();
    if (binding.createdAt > actionAt) throw new TypeError('HIGHLIGHT_CLOCK_INVALID');
    if (binding.expiresAt <= actionAt) throw new Error('HIGHLIGHT_BINDING_EXPIRED');
    const existingIdentity = Object.values(registry.bindingsByAuditPage)
      .find(value => value.auditId === binding.auditId);
    if (existingIdentity && (existingIdentity.modelRevision !== binding.modelRevision ||
      existingIdentity.modelHash !== binding.modelHash)) divergentModel();
    const key = bindingKey(binding);
    const existing = registry.bindingsByAuditPage[key];
    if (existing) {
      if (sameValue(existing, binding)) {
        actionAt = readNow();
        if (binding.createdAt > actionAt) throw new TypeError('HIGHLIGHT_CLOCK_INVALID');
        if (binding.expiresAt <= actionAt) throw new Error('HIGHLIGHT_BINDING_EXPIRED');
        return validateHighlightBindingV1(existing);
      }
      throw new Error('HIGHLIGHT_BINDING_CONFLICT');
    }
    if (Object.keys(registry.bindingsByAuditPage).length >= MAX_REGISTRY_ENTRIES) {
      throw new Error('HIGHLIGHT_BINDING_CAPACITY');
    }
    const targetCount = Object.values(registry.bindingsByAuditPage)
      .reduce((total, value) => total + Object.keys(value.targets).length, 0);
    if (targetCount + Object.keys(binding.targets).length > MAX_TOTAL_TARGETS) {
      throw new Error('HIGHLIGHT_BINDING_CAPACITY');
    }
    const next = copyRegistry(registry);
    next.bindingsByAuditPage[key] = binding;
    actionAt = readNow();
    if (binding.createdAt > actionAt) throw new TypeError('HIGHLIGHT_CLOCK_INVALID');
    if (binding.expiresAt <= actionAt) throw new Error('HIGHLIGHT_BINDING_EXPIRED');
    const persisted = await persist(next);
    actionAt = readNow();
    if (binding.createdAt > actionAt) throw new TypeError('HIGHLIGHT_CLOCK_INVALID');
    if (binding.expiresAt <= actionAt) throw new Error('HIGHLIGHT_BINDING_EXPIRED');
    return validateHighlightBindingV1(persisted.bindingsByAuditPage[key]);
  });

  const findTarget = rawInput => serialize(async () => {
    const input = readFindInput(rawInput);
    readNow();
    const registry = await loadRegistry();
    let actionAt = readNow();
    const matches = [];
    for (const binding of Object.values(registry.bindingsByAuditPage)) {
      if (binding.auditId === input.auditId && Object.hasOwn(binding.targets, input.occurrenceId)) {
        matches.push(binding);
      }
    }
    if (matches.length > 1) throw new Error('HIGHLIGHT_REGISTRY_INVALID');
    const matched = matches[0] ?? null;
    if (matched && Object.hasOwn(input, 'expectedModelRevision') &&
      (matched.modelRevision !== input.expectedModelRevision || matched.modelHash !== input.expectedModelHash)) {
      divergentModel();
    }
    for (const binding of Object.values(registry.bindingsByAuditPage)) {
      if (binding.createdAt > actionAt) throw new TypeError('HIGHLIGHT_CLOCK_INVALID');
    }
    const expiredKeys = Object.entries(registry.bindingsByAuditPage)
      .filter(([_key, binding]) => binding.expiresAt <= actionAt)
      .map(([key]) => key);
    if (expiredKeys.length > 0) {
      const next = copyRegistry(registry);
      for (const key of expiredKeys) delete next.bindingsByAuditPage[key];
      actionAt = readNow();
      for (const binding of Object.values(registry.bindingsByAuditPage)) {
        if (binding.createdAt > actionAt) throw new TypeError('HIGHLIGHT_CLOCK_INVALID');
      }
      await persist(next);
    }
    actionAt = readNow();
    if (!matched || matched.expiresAt <= actionAt) return null;
    if (matched.createdAt > actionAt) throw new TypeError('HIGHLIGHT_CLOCK_INVALID');
    const binding = validateHighlightBindingV1(matched);
    return deepFreezePlain({ binding, target: binding.targets[input.occurrenceId] });
  });

  const beginOverlay = rawOverlay => serialize(async () => {
    const overlay = overlayRecord(rawOverlay);
    if (!overlay || overlay.state !== 'installing' || overlay.revision !== 1) inputError();
    let actionAt = readNow();
    if (overlay.createdAt > actionAt) throw new TypeError('HIGHLIGHT_CLOCK_INVALID');
    if (overlay.expiresAt <= actionAt) return failure('HIGHLIGHT_OVERLAY_EXPIRED');
    const registry = await loadRegistry();
    actionAt = readNow();
    if (overlay.createdAt > actionAt) throw new TypeError('HIGHLIGHT_CLOCK_INVALID');
    if (overlay.expiresAt <= actionAt) return failure('HIGHLIGHT_OVERLAY_EXPIRED');
    if (!overlayMatchesStoredBinding(registry, overlay)) {
      return failure('HIGHLIGHT_OVERLAY_BINDING_MISMATCH');
    }
    const key = overlayKey(overlay.tabId);
    if (Object.hasOwn(registry.activeOverlayByTab, key)) return failure('HIGHLIGHT_OVERLAY_CONFLICT');
    if (Object.keys(registry.activeOverlayByTab).length >= MAX_REGISTRY_ENTRIES) {
      return failure('HIGHLIGHT_OVERLAY_CONFLICT');
    }
    const next = copyRegistry(registry);
    next.activeOverlayByTab[key] = deepFreezePlain(overlay);
    actionAt = readNow();
    if (overlay.createdAt > actionAt) throw new TypeError('HIGHLIGHT_CLOCK_INVALID');
    if (overlay.expiresAt <= actionAt) return failure('HIGHLIGHT_OVERLAY_EXPIRED');
    const persisted = await persist(next);
    actionAt = readNow();
    if (overlay.createdAt > actionAt) throw new TypeError('HIGHLIGHT_CLOCK_INVALID');
    if (overlay.expiresAt <= actionAt) return failure('HIGHLIGHT_OVERLAY_EXPIRED');
    return success(persisted.activeOverlayByTab[key]);
  });

  const activateOverlay = rawInput => serialize(async () => {
    const input = readCasInput(rawInput);
    readNow();
    const registry = await loadRegistry();
    let actionAt = readNow();
    const owner = registry.activeOverlayByTab[overlayKey(input.tabId)];
    if (!owner) return failure('HIGHLIGHT_OVERLAY_NOT_FOUND');
    if (owner.nonce !== input.nonce || owner.revision !== input.expectedRevision) {
      return failure('HIGHLIGHT_OVERLAY_CAS_MISMATCH');
    }
    if (owner.state !== 'installing') return failure('HIGHLIGHT_OVERLAY_TRANSITION_INVALID');
    if (owner.createdAt > actionAt) throw new TypeError('HIGHLIGHT_CLOCK_INVALID');
    if (owner.expiresAt <= actionAt) return failure('HIGHLIGHT_OVERLAY_EXPIRED');
    const updated = deepFreezePlain({ ...owner, state: 'active', revision: nextRevision(owner.revision) });
    const next = copyRegistry(registry);
    next.activeOverlayByTab[overlayKey(owner.tabId)] = updated;
    actionAt = readNow();
    if (owner.createdAt > actionAt) throw new TypeError('HIGHLIGHT_CLOCK_INVALID');
    if (owner.expiresAt <= actionAt) return failure('HIGHLIGHT_OVERLAY_EXPIRED');
    const persisted = await persist(next);
    actionAt = readNow();
    if (owner.createdAt > actionAt) throw new TypeError('HIGHLIGHT_CLOCK_INVALID');
    if (owner.expiresAt <= actionAt) return failure('HIGHLIGHT_OVERLAY_EXPIRED');
    return success(persisted.activeOverlayByTab[overlayKey(owner.tabId)]);
  });

  const beginOverlayClear = rawInput => serialize(async () => {
    const input = readCasInput(rawInput);
    const registry = await loadRegistry();
    const owner = registry.activeOverlayByTab[overlayKey(input.tabId)];
    if (!owner) return failure('HIGHLIGHT_OVERLAY_NOT_FOUND');
    if (owner.nonce !== input.nonce || owner.revision !== input.expectedRevision) {
      return failure('HIGHLIGHT_OVERLAY_CAS_MISMATCH');
    }
    if (!['installing', 'active'].includes(owner.state)) return failure('HIGHLIGHT_OVERLAY_TRANSITION_INVALID');
    const updated = deepFreezePlain({ ...owner, state: 'clearing', revision: nextRevision(owner.revision) });
    const next = copyRegistry(registry);
    next.activeOverlayByTab[overlayKey(owner.tabId)] = updated;
    const persisted = await persist(next);
    return success(persisted.activeOverlayByTab[overlayKey(owner.tabId)]);
  });

  const completeOverlayClear = rawInput => serialize(async () => {
    const input = readCasInput(rawInput);
    const registry = await loadRegistry();
    const owner = registry.activeOverlayByTab[overlayKey(input.tabId)];
    if (!owner) return failure('HIGHLIGHT_OVERLAY_NOT_FOUND');
    if (owner.nonce !== input.nonce || owner.revision !== input.expectedRevision) {
      return failure('HIGHLIGHT_OVERLAY_CAS_MISMATCH');
    }
    if (owner.state !== 'clearing') return failure('HIGHLIGHT_OVERLAY_TRANSITION_INVALID');
    const next = copyRegistry(registry);
    delete next.activeOverlayByTab[overlayKey(owner.tabId)];
    await persist(next);
    return success(null);
  });

  const getActiveOverlay = rawTabId => serialize(async () => {
    const tabId = readTabId(rawTabId);
    const registry = await loadRegistry();
    const owner = registry.activeOverlayByTab[overlayKey(tabId)];
    return owner ? deepFreezePlain({ ...owner }) : null;
  });

  const listRecoverableOverlays = () => serialize(async () => {
    const registry = await loadRegistry();
    return deepFreezePlain(Object.values(registry.activeOverlayByTab).map(owner => ({ ...owner })));
  });

  const invalidateTab = rawTabId => serialize(async () => {
    const tabId = readTabId(rawTabId);
    const registry = await loadRegistry();
    if (Object.hasOwn(registry.activeOverlayByTab, overlayKey(tabId))) {
      throw new Error('HIGHLIGHT_OVERLAY_ACTIVE');
    }
    const next = copyRegistry(registry);
    let changed = false;
    for (const [key, binding] of Object.entries(next.bindingsByAuditPage)) {
      if (binding.tabId === tabId) { delete next.bindingsByAuditPage[key]; changed = true; }
    }
    if (changed) await persist(next);
    return changed;
  });

  const deleteAudit = rawAuditId => serialize(async () => {
    const auditId = readAuditId(rawAuditId);
    const registry = await loadRegistry();
    if (Object.values(registry.activeOverlayByTab).some(owner => owner.auditId === auditId)) {
      throw new Error('HIGHLIGHT_OVERLAY_ACTIVE');
    }
    const next = copyRegistry(registry);
    let changed = false;
    for (const [key, binding] of Object.entries(next.bindingsByAuditPage)) {
      if (binding.auditId === auditId) { delete next.bindingsByAuditPage[key]; changed = true; }
    }
    if (changed) await persist(next);
    return changed;
  });

  const purgeExpired = () => serialize(async () => {
    const actionAt = readNow();
    const registry = await loadRegistry();
    const next = copyRegistry(registry);
    let removed = 0;
    for (const [key, binding] of Object.entries(next.bindingsByAuditPage)) {
      if (binding.createdAt > actionAt) throw new TypeError('HIGHLIGHT_CLOCK_INVALID');
      if (binding.expiresAt <= actionAt) { delete next.bindingsByAuditPage[key]; removed += 1; }
    }
    if (removed > 0) await persist(next);
    return removed;
  });

  const snapshot = () => serialize(async () => {
    const registry = await loadRegistry();
    const copy = copyRegistry(registry);
    for (const [key, binding] of Object.entries(copy.bindingsByAuditPage)) {
      copy.bindingsByAuditPage[key] = validateHighlightBindingV1(binding);
    }
    for (const [key, overlay] of Object.entries(copy.activeOverlayByTab)) {
      copy.activeOverlayByTab[key] = deepFreezePlain({ ...overlay });
    }
    return deepFreezePlain(copy);
  });

  return Object.freeze({
    put,
    findTarget,
    deleteAudit,
    beginOverlay,
    activateOverlay,
    beginOverlayClear,
    completeOverlayClear,
    getActiveOverlay,
    listRecoverableOverlays,
    invalidateTab,
    purgeExpired,
    snapshot,
  });
}
