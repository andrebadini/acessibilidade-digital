export const PERSONA_CLASSIC_FILES = Object.freeze([
  'src/core/accessibility/accessible-preview-runtime.classic.js',
  'src/personas/screen-reader-module.js',
  'src/personas/content.js',
]);
export const PERSONA_CSS_FILES = Object.freeze(['src/personas/personas.css']);
export const PERSONA_SESSION_KEY = 'audita:persona:bindings:v1';
export const PERSONA_LOCAL_KEYS = Object.freeze({
  voiceId: 'audita:persona:voiceId',
  rate: 'audita:persona:rate',
});

const PANEL_PATH = '/src/panel/index.html';
const PANEL_PORT = 'audita-persona-v1';
const CONTENT_PORT = 'audita-persona-content-v1';
const PANEL_PROTOCOL = 'audita-persona-panel';
const CONTENT_PROTOCOL = 'audita-persona-content';
const MODES = new Set(['reader', 'achromatopsia', 'motor']);
const READER_ACTIONS = new Set(['start', 'pause', 'resume', 'stop', 'repeat', 'previous', 'next']);
const IDENTIFIER = /^[A-Za-z0-9._:-]{1,200}$/u;

function installPersonaBindingProof(panelTabId, targetTabId) {
  'use strict';
  var proofKey = Symbol.for('audita.persona.binding-proof.v1');
  var checkerKey = Symbol.for('audita.persona.binding-proof-checker.v1');
  var cleanupKey = Symbol.for('audita.persona.binding-proof-cleanup.v1');
  var proof;
  var checker;
  var cleanup;
  var revoke;
  var navigationTarget = null;
  var revoked = false;
  try {
    if (!Number.isSafeInteger(panelTabId) || panelTabId < 0 ||
      !Number.isSafeInteger(targetTabId) || targetTabId < 0) return false;
    var priorProof = Object.getOwnPropertyDescriptor(globalThis, proofKey);
    var priorChecker = Object.getOwnPropertyDescriptor(globalThis, checkerKey);
    var priorCleanup = Object.getOwnPropertyDescriptor(globalThis, cleanupKey);
    if (priorProof || priorChecker || priorCleanup) {
      if (!priorProof || !Object.hasOwn(priorProof, 'value') || priorProof.enumerable !== false ||
        priorProof.configurable !== true || priorProof.writable !== false || !priorProof.value ||
        Object.getPrototypeOf(priorProof.value) !== null || !Object.isFrozen(priorProof.value) ||
        Object.keys(priorProof.value).join(',') !== 'version,panelTabId,targetTabId' ||
        priorProof.value.version !== 1 || !Number.isSafeInteger(priorProof.value.panelTabId) ||
        priorProof.value.panelTabId < 0 || !Number.isSafeInteger(priorProof.value.targetTabId) ||
        priorProof.value.targetTabId < 0 ||
        !priorChecker || !Object.hasOwn(priorChecker, 'value') || typeof priorChecker.value !== 'function' ||
        priorChecker.enumerable !== false || priorChecker.configurable !== true || priorChecker.writable !== false ||
        !Object.isFrozen(priorChecker.value) ||
        !priorCleanup || !Object.hasOwn(priorCleanup, 'value') || typeof priorCleanup.value !== 'function' ||
        priorCleanup.enumerable !== false || priorCleanup.configurable !== true || priorCleanup.writable !== false ||
        !Object.isFrozen(priorCleanup.value)) return false;
      if (priorCleanup.value() !== true) return false;
    }
    if (Object.getOwnPropertyDescriptor(globalThis, proofKey) ||
      Object.getOwnPropertyDescriptor(globalThis, checkerKey) ||
      Object.getOwnPropertyDescriptor(globalThis, cleanupKey)) return false;
    var expectedHref = globalThis.location && globalThis.location.href;
    if (typeof expectedHref !== 'string' || expectedHref.length < 1 || expectedHref.length > 8192) return false;

    proof = Object.create(null);
    Object.defineProperties(proof, {
      version: { value: 1, enumerable: true, configurable: false, writable: false },
      panelTabId: { value: panelTabId, enumerable: true, configurable: false, writable: false },
      targetTabId: { value: targetTabId, enumerable: true, configurable: false, writable: false },
    });
    Object.freeze(proof);
    checker = function bindingProofChecker(expectedPanelTabId, expectedTargetTabId) {
      try {
        if (revoked || expectedPanelTabId !== panelTabId || expectedTargetTabId !== targetTabId ||
          !globalThis.location || globalThis.location.href !== expectedHref) return false;
        var descriptor = Object.getOwnPropertyDescriptor(globalThis, proofKey);
        return Boolean(descriptor && Object.hasOwn(descriptor, 'value') && descriptor.value === proof &&
          descriptor.enumerable === false && descriptor.configurable === true && descriptor.writable === false &&
          Object.getPrototypeOf(proof) === null && Object.isFrozen(proof) &&
          proof.version === 1 && proof.panelTabId === panelTabId && proof.targetTabId === targetTabId &&
          Object.keys(proof).join(',') === 'version,panelTabId,targetTabId');
      } catch (_error) { return false; }
    };
    Object.freeze(checker);
    revoke = function bindingProofRevoke() { revoked = true; };
    Object.freeze(revoke);
    cleanup = function bindingProofCleanup() {
      try {
        globalThis.removeEventListener?.('pagehide', cleanup);
        globalThis.removeEventListener?.('hashchange', revoke);
        globalThis.removeEventListener?.('popstate', revoke);
        if (navigationTarget && typeof navigationTarget.removeEventListener === 'function') {
          navigationTarget.removeEventListener('navigate', revoke);
          navigationTarget.removeEventListener('currententrychange', revoke);
        }
        revoked = true;
        var proofDescriptor = Object.getOwnPropertyDescriptor(globalThis, proofKey);
        var checkerDescriptor = Object.getOwnPropertyDescriptor(globalThis, checkerKey);
        var cleanupDescriptor = Object.getOwnPropertyDescriptor(globalThis, cleanupKey);
        if (proofDescriptor && Object.hasOwn(proofDescriptor, 'value') && proofDescriptor.value === proof) delete globalThis[proofKey];
        if (checkerDescriptor && Object.hasOwn(checkerDescriptor, 'value') && checkerDescriptor.value === checker) delete globalThis[checkerKey];
        if (cleanupDescriptor && Object.hasOwn(cleanupDescriptor, 'value') && cleanupDescriptor.value === cleanup) delete globalThis[cleanupKey];
        return !Object.getOwnPropertyDescriptor(globalThis, proofKey) &&
          !Object.getOwnPropertyDescriptor(globalThis, checkerKey) &&
          !Object.getOwnPropertyDescriptor(globalThis, cleanupKey);
      } catch (_error) { return false; }
    };
    Object.freeze(cleanup);
    Object.defineProperties(globalThis, {
      [proofKey]: { value: proof, enumerable: false, configurable: true, writable: false },
      [checkerKey]: { value: checker, enumerable: false, configurable: true, writable: false },
      [cleanupKey]: { value: cleanup, enumerable: false, configurable: true, writable: false },
    });
    globalThis.addEventListener?.('pagehide', cleanup, { once: true });
    globalThis.addEventListener?.('hashchange', revoke);
    globalThis.addEventListener?.('popstate', revoke);
    navigationTarget = globalThis.navigation;
    if (navigationTarget && typeof navigationTarget.addEventListener === 'function' &&
      typeof navigationTarget.removeEventListener === 'function') {
      navigationTarget.addEventListener('navigate', revoke);
      navigationTarget.addEventListener('currententrychange', revoke);
    } else navigationTarget = null;
    return checker(panelTabId, targetTabId) === true;
  } catch (_error) {
    try {
      if (typeof cleanup === 'function') cleanup();
      var proofDescriptor = Object.getOwnPropertyDescriptor(globalThis, proofKey);
      var checkerDescriptor = Object.getOwnPropertyDescriptor(globalThis, checkerKey);
      var cleanupDescriptor = Object.getOwnPropertyDescriptor(globalThis, cleanupKey);
      if (proofDescriptor && Object.hasOwn(proofDescriptor, 'value') && proofDescriptor.value === proof) delete globalThis[proofKey];
      if (checkerDescriptor && Object.hasOwn(checkerDescriptor, 'value') && checkerDescriptor.value === checker) delete globalThis[checkerKey];
      if (cleanupDescriptor && Object.hasOwn(cleanupDescriptor, 'value') && cleanupDescriptor.value === cleanup) delete globalThis[cleanupKey];
    } catch (_ignored) { /* instalação parcial permanece inválida e nunca é aceita */ }
    return false;
  }
}

function checkPersonaBindingProof(panelTabId, targetTabId) {
  'use strict';
  try {
    if (!Number.isSafeInteger(panelTabId) || panelTabId < 0 ||
      !Number.isSafeInteger(targetTabId) || targetTabId < 0) return false;
    var checkerKey = Symbol.for('audita.persona.binding-proof-checker.v1');
    var descriptor = Object.getOwnPropertyDescriptor(globalThis, checkerKey);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function' ||
      descriptor.enumerable !== false || descriptor.configurable !== true || descriptor.writable !== false ||
      !Object.isFrozen(descriptor.value)) return false;
    return descriptor.value(panelTabId, targetTabId) === true;
  } catch (_error) { return false; }
}

function clearPersonaBindingProof(panelTabId, targetTabId) {
  'use strict';
  try {
    if (!Number.isSafeInteger(panelTabId) || panelTabId < 0 ||
      !Number.isSafeInteger(targetTabId) || targetTabId < 0) return false;
    var proofKey = Symbol.for('audita.persona.binding-proof.v1');
    var cleanupKey = Symbol.for('audita.persona.binding-proof-cleanup.v1');
    var proofDescriptor = Object.getOwnPropertyDescriptor(globalThis, proofKey);
    var cleanupDescriptor = Object.getOwnPropertyDescriptor(globalThis, cleanupKey);
    if (!proofDescriptor || !Object.hasOwn(proofDescriptor, 'value') ||
      proofDescriptor.enumerable !== false || proofDescriptor.configurable !== true || proofDescriptor.writable !== false ||
      !cleanupDescriptor || !Object.hasOwn(cleanupDescriptor, 'value') || typeof cleanupDescriptor.value !== 'function' ||
      cleanupDescriptor.enumerable !== false || cleanupDescriptor.configurable !== true || cleanupDescriptor.writable !== false ||
      !Object.isFrozen(cleanupDescriptor.value)) return false;
    var proof = proofDescriptor.value;
    if (!proof || Object.getPrototypeOf(proof) !== null || !Object.isFrozen(proof) ||
      Object.keys(proof).join(',') !== 'version,panelTabId,targetTabId' || proof.version !== 1 ||
      proof.panelTabId !== panelTabId || proof.targetTabId !== targetTabId) return false;
    return cleanupDescriptor.value() === true;
  } catch (_error) { return false; }
}

export function createPersonaController(chromeApi, options = {}) {
  if (!chromeApi?.runtime?.getURL || !chromeApi?.tabs?.create || !chromeApi?.tabs?.get ||
    !chromeApi?.scripting?.executeScript || !chromeApi?.storage?.session || !chromeApi?.storage?.local) {
    throw new TypeError('APIs Chrome insuficientes para controlar personas.');
  }
  const logger = options.logger ?? { error() {} };
  const randomToken = options.randomToken ?? (() => crypto.randomUUID());
  const nextRequestId = options.requestId ?? (() => crypto.randomUUID());
  const panelCommitDelay = typeof options.panelCommitDelay === 'function'
    ? options.panelCommitDelay
    : (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  const bindings = new Map();
  const owners = new Map();
  const targets = new Map();
  const openingByTarget = new Map();
  const panelReservations = new Map();
  const pendingPanelPorts = new Map();
  const operationQueues = new Map();
  const proofQueues = new Map();
  const bindingLeases = new WeakMap();
  let ownershipQueue = Promise.resolve();
  let persistenceQueue = Promise.resolve();
  const earlyTabEvents = [];
  let earlyEventsOverflowed = false;
  let bindingsReady = false;
  const ready = restoreBindings().finally(() => {
    bindingsReady = true;
    if (earlyEventsOverflowed) {
      for (const panelTabId of [...bindings.keys()]) void unbindPanel(panelTabId, false);
      earlyTabEvents.length = 0;
      return;
    }
    for (const event of earlyTabEvents.splice(0)) {
      if (event.type === 'removed') handleTabRemoved(event.tabId);
      else handleTabUpdated(event.tabId, event.changeInfo, event.tab);
    }
  });

  chromeApi.tabs.onUpdated?.addListener?.(handleTabUpdated);
  chromeApi.tabs.onRemoved?.addListener?.(handleTabRemoved);

  return Object.freeze({
    openPanel,
    issueBindingLease,
    consumeBindingLease,
    attachPanelPort,
    handleTabUpdated,
    handleTabRemoved,
    getBinding(panelTabId) {
      const binding = bindings.get(panelTabId);
      return binding ? { panelTabId: binding.panelTabId, targetTabId: binding.targetTabId } : null;
    },
    getOwnerPanel(targetTabId) { return owners.get(targetTabId) ?? null; },
  });

  async function restoreBindings() {
    let stored;
    try { stored = (await storageGet(chromeApi.storage.session, PERSONA_SESSION_KEY))?.[PERSONA_SESSION_KEY]; }
    catch { return; }
    if (stored === undefined) return;
    if (!Array.isArray(stored) || stored.length > 64) {
      try { await storageSet(chromeApi.storage.session, { [PERSONA_SESSION_KEY]: [] }); } catch { /* sem owner em falha */ }
      return;
    }
    const candidates = [];
    const seenPanels = new Set();
    const seenTargets = new Set();
    for (const entry of stored) {
      const parsed = parseNumericBinding(entry);
      if (!parsed || seenPanels.has(parsed.panelTabId) || seenTargets.has(parsed.targetTabId)) continue;
      seenPanels.add(parsed.panelTabId);
      seenTargets.add(parsed.targetTabId);
      const validation = await validateStoredBinding(parsed);
      if (validation?.matches) candidates.push({ ...parsed, proofDocumentId: validation.documentId });
      else await clearBindingProof(parsed.panelTabId, parsed.targetTabId, validation?.documentId ?? null);
    }
    if (!await persistRestoredSnapshot(candidates)) return;
    let stable = true;
    for (const candidate of candidates) {
      const validation = await validateStoredBinding(candidate);
      if (!validation?.matches || validation.documentId !== candidate.proofDocumentId) {
        stable = false;
        await clearBindingProof(candidate.panelTabId, candidate.targetTabId, candidate.proofDocumentId);
      }
    }
    if (!stable) {
      try { await storageSet(chromeApi.storage.session, { [PERSONA_SESSION_KEY]: [] }); } catch { /* sem owner em churn */ }
      for (const candidate of candidates) {
        await clearBindingProof(candidate.panelTabId, candidate.targetTabId, candidate.proofDocumentId);
      }
      return;
    }
    for (const parsed of candidates) {
      if (bindings.has(parsed.panelTabId) || owners.has(parsed.targetTabId)) continue;
      const binding = createBinding(parsed.panelTabId, parsed.targetTabId, parsed.proofDocumentId);
      bindings.set(binding.panelTabId, binding);
      owners.set(binding.targetTabId, binding.panelTabId);
    }
  }

  async function persistRestoredSnapshot(entries) {
    const snapshot = entries
      .map(entry => ({ panelTabId: entry.panelTabId, targetTabId: entry.targetTabId }))
      .sort((a, b) => a.panelTabId - b.panelTabId);
    try {
      await storageSet(chromeApi.storage.session, { [PERSONA_SESSION_KEY]: snapshot });
      return true;
    } catch {
      logger.error('Não foi possível sanear vínculos restaurados de persona.');
      return false;
    }
  }

  async function validateStoredBinding(binding) {
    let target;
    try { target = await chromeApi.tabs.get(binding.targetTabId); }
    catch { return null; }
    if (!isCompleteHttpTab(target, binding.targetTabId)) return null;
    let panel = null;
    try { panel = await chromeApi.tabs.get(binding.panelTabId); }
    catch { /* a prova do alvo ainda deve ser saneada quando o painel desapareceu */ }
    const observation = await observeBindingProof(
      binding.panelTabId, binding.targetTabId, binding.proofDocumentId,
    );
    if (!observation) return null;
    return {
      documentId: observation.documentId,
      matches: isExactPanelTab(panel) && observation.result === true,
    };
  }

  async function persistBindings() {
    const value = [...bindings.values()]
      .map(binding => ({ panelTabId: binding.panelTabId, targetTabId: binding.targetTabId }))
      .sort((a, b) => a.panelTabId - b.panelTabId);
    const snapshot = value.map(binding => ({ ...binding }));
    const operation = persistenceQueue.catch(() => {}).then(() =>
      storageSet(chromeApi.storage.session, { [PERSONA_SESSION_KEY]: snapshot }));
    persistenceQueue = operation;
    await operation;
  }

  async function serializeOwnership(operation) {
    const current = ownershipQueue.catch(() => {}).then(operation);
    ownershipQueue = current;
    return current;
  }

  async function serializeProof(targetTabId, operation) {
    const previous = proofQueues.get(targetTabId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    proofQueues.set(targetTabId, current);
    try { return await current; }
    finally { if (proofQueues.get(targetTabId) === current) proofQueues.delete(targetTabId); }
  }

  async function executeBindingProofResult(targetTabId, panelTabId, operation, documentId = null) {
    let results;
    try {
      results = await chromeApi.scripting.executeScript({
        target: documentId
          ? { tabId: targetTabId, documentIds: [documentId] }
          : { tabId: targetTabId, frameIds: [0] },
        world: 'ISOLATED',
        func: operation,
        args: [panelTabId, targetTabId],
      });
    } catch { return null; }
    if (!Array.isArray(results) || results.length !== 1) return null;
    const result = results[0];
    if (result?.frameId !== 0 || !boundedIdentifier(result?.documentId) || typeof result.result !== 'boolean') return null;
    if (documentId && result.documentId !== documentId) return null;
    return { documentId: result.documentId, result: result.result };
  }

  async function executeBindingProof(targetTabId, panelTabId, operation, documentId = null) {
    const observation = await executeBindingProofResult(
      targetTabId, panelTabId, operation, documentId,
    );
    return observation?.result === true ? observation.documentId : null;
  }

  function observeBindingProof(panelTabId, targetTabId, documentId = null) {
    return serializeProof(targetTabId, () =>
      executeBindingProofResult(targetTabId, panelTabId, checkPersonaBindingProof, documentId));
  }

  function checkBindingProof(panelTabId, targetTabId, documentId = null) {
    return serializeProof(targetTabId, () =>
      executeBindingProof(targetTabId, panelTabId, checkPersonaBindingProof, documentId));
  }

  function clearBindingProof(panelTabId, targetTabId, documentId = null) {
    return serializeProof(targetTabId, async () => {
      const observation = documentId ? null : await executeBindingProofResult(
        targetTabId, panelTabId, checkPersonaBindingProof,
      );
      const exactDocumentId = documentId || observation?.documentId;
      if (!exactDocumentId) return false;
      return Boolean(await executeBindingProof(
        targetTabId, panelTabId, clearPersonaBindingProof, exactDocumentId,
      ));
    });
  }

  async function validateReservationEndpoints(source, panelTabId, reservation) {
    if (panelReservations.get(panelTabId) !== reservation) return false;
    let panel;
    let target;
    try {
      [panel, target] = await Promise.all([
        chromeApi.tabs.get(panelTabId),
        chromeApi.tabs.get(source.id),
      ]);
    } catch { return false; }
    return panelReservations.get(panelTabId) === reservation && isExactPanelTab(panel) &&
      isCompleteHttpTab(target, source.id, source.url);
  }

  function establishReservationProof(source, panelTabId, reservation) {
    return serializeProof(source.id, async () => {
      if (!await validateReservationEndpoints(source, panelTabId, reservation)) return false;
      const proofDocumentId = await executeBindingProof(source.id, panelTabId, installPersonaBindingProof);
      if (!proofDocumentId) return null;
      reservation.proofDocumentId = proofDocumentId;
      if (!await validateReservationEndpoints(source, panelTabId, reservation) ||
        !await executeBindingProof(source.id, panelTabId, checkPersonaBindingProof, proofDocumentId) ||
        !await validateReservationEndpoints(source, panelTabId, reservation)) {
        await executeBindingProof(source.id, panelTabId, clearPersonaBindingProof, proofDocumentId);
        reservation.proofDocumentId = null;
        return null;
      }
      return proofDocumentId;
    });
  }

  function checkReservationProof(source, panelTabId, reservation) {
    return serializeProof(source.id, async () => {
      if (!await validateReservationEndpoints(source, panelTabId, reservation)) return false;
      if (!reservation.proofDocumentId || !await executeBindingProof(
        source.id, panelTabId, checkPersonaBindingProof, reservation.proofDocumentId,
      )) return false;
      return validateReservationEndpoints(source, panelTabId, reservation);
    });
  }

  async function validateBindingEndpoints(binding) {
    let panel;
    let target;
    try {
      [panel, target] = await Promise.all([
        chromeApi.tabs.get(binding.panelTabId),
        chromeApi.tabs.get(binding.targetTabId),
      ]);
    } catch { return false; }
    return bindings.get(binding.panelTabId) === binding && !binding.releaseRequested &&
      isExactPanelTab(panel) && isCompleteHttpTab(target, binding.targetTabId);
  }

  async function validateBindingLeaseEndpoints(binding, sourceUrl) {
    let panel;
    let target;
    try {
      [panel, target] = await Promise.all([
        chromeApi.tabs.get(binding.panelTabId),
        chromeApi.tabs.get(binding.targetTabId),
      ]);
    } catch { return false; }
    return bindings.get(binding.panelTabId) === binding && owners.get(binding.targetTabId) === binding.panelTabId &&
      !binding.releaseRequested && isExactPanelTab(panel) && !hasPendingNavigation(panel) &&
      isCompleteHttpTab(target, binding.targetTabId, sourceUrl) && !hasPendingNavigation(target);
  }

  async function issueBindingLease(value) {
    await ready;
    const request = parseBindingLeaseRequest(value);
    if (!request) return null;
    const binding = bindings.get(request.panelTabId);
    if (!binding || binding.targetTabId !== request.targetTabId ||
      owners.get(request.targetTabId) !== request.panelTabId || binding.releaseRequested ||
      !binding.port || binding.panelDocumentId !== request.panelDocumentId ||
      binding.proofRequired || !boundedIdentifier(binding.proofDocumentId) ||
      !await validateBindingLeaseEndpoints(binding, request.sourceUrl)) return null;
    const proofDocumentId = binding.proofDocumentId;
    const proofEpoch = binding.proofEpoch;
    const portEpoch = binding.portEpoch;
    // A observação pinada no documento alvo é a última operação assíncrona; daqui até a emissão só há checks locais.
    if (await checkBindingProof(binding.panelTabId, binding.targetTabId, proofDocumentId) !== proofDocumentId ||
      bindings.get(request.panelTabId) !== binding || owners.get(request.targetTabId) !== request.panelTabId ||
      binding.releaseRequested || !binding.port || binding.panelDocumentId !== request.panelDocumentId ||
      binding.portEpoch !== portEpoch || binding.proofRequired || binding.proofDocumentId !== proofDocumentId ||
      binding.proofEpoch !== proofEpoch) return null;
    const lease = Object.freeze(Object.create(null));
    bindingLeases.set(lease, {
      binding,
      panelTabId: request.panelTabId,
      targetTabId: request.targetTabId,
      panelDocumentId: request.panelDocumentId,
      proofDocumentId,
      proofEpoch,
      portEpoch,
    });
    return lease;
  }

  function consumeBindingLease(lease) {
    if (!lease || typeof lease !== 'object') return false;
    const capability = bindingLeases.get(lease);
    if (!capability) return false;
    bindingLeases.delete(lease);
    const binding = capability.binding;
    return bindings.get(capability.panelTabId) === binding &&
      owners.get(capability.targetTabId) === capability.panelTabId &&
      binding.panelTabId === capability.panelTabId && binding.targetTabId === capability.targetTabId &&
      !binding.releaseRequested && binding.port && binding.panelDocumentId === capability.panelDocumentId &&
      binding.portEpoch === capability.portEpoch && !binding.proofRequired &&
      binding.proofDocumentId === capability.proofDocumentId && binding.proofEpoch === capability.proofEpoch;
  }

  function establishCurrentBindingProof(binding, expectedSourceUrl = null, forceInstall = false) {
    return serializeProof(binding.targetTabId, async () => {
      if (!await validateBindingEndpoints(binding)) return false;
      if (expectedSourceUrl) {
        let liveTarget;
        try { liveTarget = await chromeApi.tabs.get(binding.targetTabId); } catch { return false; }
        if (!isCompleteHttpTab(liveTarget, binding.targetTabId, expectedSourceUrl)) return false;
      }
      if (!forceInstall && !binding.proofRequired) {
        if (!binding.proofDocumentId || !await executeBindingProof(
          binding.targetTabId, binding.panelTabId, checkPersonaBindingProof, binding.proofDocumentId,
        )) return false;
        return validateBindingEndpoints(binding);
      }
      const oldDocumentId = binding.proofDocumentId;
      if (oldDocumentId) {
        binding.proofDocumentId = null;
        binding.proofRequired = true;
        advanceProofEpoch(binding);
        advanceProofEpoch(binding);
        await executeBindingProof(
          binding.targetTabId, binding.panelTabId, clearPersonaBindingProof, oldDocumentId,
        );
      }
      const proofDocumentId = await executeBindingProof(
        binding.targetTabId, binding.panelTabId, installPersonaBindingProof,
      );
      if (!proofDocumentId) return false;
      advanceProofEpoch(binding);
      if (!await validateBindingEndpoints(binding) ||
        !await executeBindingProof(
          binding.targetTabId, binding.panelTabId, checkPersonaBindingProof, proofDocumentId,
        ) || !await validateBindingEndpoints(binding)) {
        await executeBindingProof(
          binding.targetTabId, binding.panelTabId, clearPersonaBindingProof, proofDocumentId,
        );
        advanceProofEpoch(binding);
        return false;
      }
      binding.proofDocumentId = proofDocumentId;
      binding.proofRequired = false;
      return true;
    });
  }

  async function openPanel({ sourceTab, auditPrefill: _auditPrefill } = {}) {
    await ready;
    const source = parseSourceTab(sourceTab);
    if (!source) return chromeApi.tabs.create({ url: chromeApi.runtime.getURL('src/panel/index.html') });
    if (openingByTarget.has(source.id)) return openingByTarget.get(source.id);
    const operation = serializeOwnership(() => openOwnedPanel(source)).finally(() => {
      if (openingByTarget.get(source.id) === operation) openingByTarget.delete(source.id);
    });
    openingByTarget.set(source.id, operation);
    return operation;
  }

  async function openOwnedPanel(source) {
    const existingPanelId = owners.get(source.id);
    if (existingPanelId !== undefined) {
      try {
        const existing = await chromeApi.tabs.get(existingPanelId);
        const existingBinding = bindings.get(existingPanelId);
        if (existing?.id === existingPanelId && isExactPanelTab(existing) &&
          existingBinding && !existingBinding.releaseRequested) {
          const proofReady = await establishCurrentBindingProof(existingBinding, source.url, true);
          if (proofReady) await chromeApi.tabs.update?.(existingPanelId, { active: true });
          if (proofReady && bindings.get(existingPanelId) === existingBinding && !existingBinding.releaseRequested &&
            owners.get(source.id) === existingPanelId) return existing;
        }
      } catch { /* a transição abaixo libera qualquer owner desaparecido */ }
      await releasePanelBinding(existingPanelId, true, {
        requestId: 'owner-invalid',
        message: 'O painel anterior não está mais disponível. As simulações foram encerradas.',
        code: 'PERSONA_PANEL_CHANGED',
      });
    }
    const panel = await chromeApi.tabs.create({ url: chromeApi.runtime.getURL('src/panel/index.html') });
    if (!Number.isSafeInteger(panel?.id) || panel.id < 0) throw new Error('O navegador não retornou a aba do painel.');
    const reservation = Object.seal({
      panelTabId: panel.id,
      targetTabId: source.id,
      sourceUrl: source.url,
      proofDocumentId: null,
    });
    if (panelReservations.has(panel.id)) {
      await safeRemoveTab(panel.id);
      disconnectPendingPanelPorts(panel.id);
      throw personaError('PERSONA_TARGET_CHANGED');
    }
    panelReservations.set(panel.id, reservation);
    const committed = await waitForPanelCommit(source, panel.id, reservation);
    if (!committed) {
      cancelPanelReservation(panel.id, reservation);
      await safeRemoveTab(panel.id);
      throw personaError('PERSONA_TARGET_CHANGED');
    }
    let proofDocumentId = null;
    let binding = null;
    let persistenceAttempted = false;
    try {
      proofDocumentId = await establishReservationProof(source, panel.id, reservation);
      if (!proofDocumentId || bindings.has(panel.id) || owners.has(source.id)) {
        throw personaError('PERSONA_TARGET_CHANGED');
      }
      binding = createBinding(panel.id, source.id, proofDocumentId);
      bindings.set(panel.id, binding);
      owners.set(source.id, panel.id);
      persistenceAttempted = true;
      await persistBindings();
      if (bindings.get(panel.id) !== binding || binding.releaseRequested || owners.get(source.id) !== panel.id ||
        !await checkReservationProof(source, panel.id, reservation)) throw personaError('PERSONA_TARGET_CHANGED');
      panelReservations.delete(panel.id);
      promotePendingPanelPorts(panel.id);
      return committed.panel;
    } catch (error) {
      if (binding && bindings.get(panel.id) === binding) bindings.delete(panel.id);
      if (owners.get(source.id) === panel.id) owners.delete(source.id);
      cancelPanelReservation(panel.id, reservation);
      await safeRemoveTab(panel.id);
      const rollbackOperations = [];
      if (proofDocumentId) {
        rollbackOperations.push(clearBindingProof(panel.id, source.id, proofDocumentId));
      }
      if (persistenceAttempted) rollbackOperations.push(persistBindings());
      const rollbackResults = await Promise.allSettled(rollbackOperations);
      if (rollbackResults.some(result => result.status === 'rejected')) {
        logger.error('Não foi possível concluir todo o rollback do vínculo provisório de persona.');
      }
      throw personaError(error?.code || 'PERSONA_TARGET_CHANGED');
    }
  }

  async function waitForPanelCommit(source, panelTabId, reservation) {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (panelReservations.get(panelTabId) !== reservation) return null;
      let liveSource;
      let livePanel;
      try {
        [liveSource, livePanel] = await Promise.all([
          chromeApi.tabs.get(source.id),
          chromeApi.tabs.get(panelTabId),
        ]);
      } catch { return null; }
      if (!isCompleteHttpTab(liveSource, source.id, source.url)) return null;
      if (livePanel?.id !== panelTabId) return null;
      if (isExactPanelTab(livePanel)) return { source, panel: livePanel };
      if (!isPendingExactPanelTab(livePanel) || attempt === 39) return null;
      try { await panelCommitDelay(25); } catch { return null; }
    }
    return null;
  }

  function attachPanelPort(port) {
    const sender = parsePanelPort(port, chromeApi.runtime.id);
    if (!sender) return false;
    const pending = {
      port, sender, messages: [], disconnected: false, settled: false,
      bufferMessage: null, bufferDisconnect: null,
    };
    pending.bufferMessage = message => {
      if (pending.messages.length < 16) pending.messages.push(message);
    };
    pending.bufferDisconnect = () => {
      pending.disconnected = true;
      pending.messages.length = 0;
      dropPendingPanelPort(pending);
    };
    addPendingPanelPort(pending);
    port.onMessage.addListener(pending.bufferMessage);
    port.onDisconnect.addListener(pending.bufferDisconnect);
    void ready.then(() => {
      void serializeOwnership(() => settlePendingPanelPort(pending));
    }, () => settlePendingPanelPort(pending, {
      unboundMessage: 'Não foi possível restaurar a aba alvo deste painel.',
    }));
    return true;
  }

  function addPendingPanelPort(pending) {
    let ports = pendingPanelPorts.get(pending.sender.panelTabId);
    if (!ports) {
      ports = new Set();
      pendingPanelPorts.set(pending.sender.panelTabId, ports);
    }
    ports.add(pending);
  }

  function dropPendingPanelPort(pending) {
    const ports = pendingPanelPorts.get(pending.sender.panelTabId);
    ports?.delete(pending);
    if (ports?.size === 0) pendingPanelPorts.delete(pending.sender.panelTabId);
  }

  function settlePendingPanelPort(pending, options = {}) {
    if (pending.settled) return;
    pending.settled = true;
    dropPendingPanelPort(pending);
    pending.port.onMessage.removeListener?.(pending.bufferMessage);
    pending.port.onDisconnect.removeListener?.(pending.bufferDisconnect);
    if (pending.disconnected) return;
    const messages = pending.messages.splice(0);
    if (options.disconnect === true) {
      try { pending.port.disconnect?.(); } catch { /* painel provisório já pode ter fechado */ }
      return;
    }
    if (options.unboundMessage) {
      finishAttachUnboundPanelPort(pending.port, messages, options.unboundMessage);
      return;
    }
    finishAttachPanelPort(pending.port, pending.sender, messages);
  }

  function promotePendingPanelPorts(panelTabId) {
    const ports = [...(pendingPanelPorts.get(panelTabId) || [])];
    for (const pending of ports) settlePendingPanelPort(pending);
  }

  function disconnectPendingPanelPorts(panelTabId) {
    const ports = [...(pendingPanelPorts.get(panelTabId) || [])];
    for (const pending of ports) settlePendingPanelPort(pending, { disconnect: true });
  }

  function cancelPanelReservation(panelTabId, expectedReservation) {
    const reservation = panelReservations.get(panelTabId);
    if (!reservation || (expectedReservation && reservation !== expectedReservation)) return false;
    panelReservations.delete(panelTabId);
    disconnectPendingPanelPorts(panelTabId);
    return true;
  }

  function finishAttachPanelPort(port, sender, pendingMessages) {
    const binding = bindings.get(sender.panelTabId);
    if (!binding || binding.releaseRequested) {
      finishAttachUnboundPanelPort(port, pendingMessages, 'Nenhuma aba alvo foi registrada para este painel.');
      return;
    }
    binding.detachPort?.();
    binding.portEpoch += 1;
    binding.port = port;
    binding.panelDocumentId = sender.documentId;
    binding.seenRequests.clear();
    const portEpoch = binding.portEpoch;
    const messageListener = message => { void handlePanelMessage(binding, port, portEpoch, message); };
    const disconnectListener = () => {
      if (binding.port !== port || binding.portEpoch !== portEpoch) return;
      binding.detachPort?.();
      binding.port = null;
      binding.panelDocumentId = null;
      void serialize(binding.targetTabId, () => cleanupTarget(binding.targetTabId, 'panel-disconnect', true));
    };
    port.onMessage.addListener(messageListener);
    port.onDisconnect.addListener(disconnectListener);
    binding.detachPort = () => {
      port.onMessage.removeListener?.(messageListener);
      port.onDisconnect.removeListener?.(disconnectListener);
      if (binding.detachPort) binding.detachPort = null;
    };
    for (const message of pendingMessages) messageListener(message);
  }

  function finishAttachUnboundPanelPort(port, pendingMessages, message) {
    let connected = true;
    const messageListener = candidate => {
      if (!connected) return;
      const parsed = parsePanelMessage(candidate);
      if (!parsed) {
        safePost(port, errorState('unknown', 'PERSONA_MESSAGE_REJECTED', 'Comando de persona inválido.'));
        return;
      }
      safePost(port, unboundState(parsed.requestId, message));
    };
    const disconnectListener = () => {
      connected = false;
      port.onMessage.removeListener?.(messageListener);
      port.onDisconnect.removeListener?.(disconnectListener);
    };
    port.onMessage.addListener(messageListener);
    port.onDisconnect.addListener(disconnectListener);
    for (const candidate of pendingMessages) messageListener(candidate);
  }

  async function handlePanelMessage(binding, port, portEpoch, message) {
    const parsed = parsePanelMessage(message);
    if (!parsed) {
      safePost(port, errorState('unknown', 'PERSONA_MESSAGE_REJECTED', 'Comando de persona inválido.'));
      return;
    }
    if (binding.port !== port || binding.portEpoch !== portEpoch) return;
    if (binding.seenRequests.has(parsed.requestId)) {
      safePost(port, errorState(parsed.requestId, 'PERSONA_REPLAY_REJECTED', 'Comando repetido foi rejeitado.'));
      return;
    }
    binding.seenRequests.add(parsed.requestId);
    trimSet(binding.seenRequests, 128);
    if (parsed.type === 'hello') {
      await serialize(binding.targetTabId, () => initializePanel(binding, port, portEpoch, parsed.requestId));
      return;
    }
    const target = targets.get(binding.targetTabId);
    if (!target || parsed.token !== target.token || parsed.generation !== target.generation) {
      safePost(port, errorState(parsed.requestId, 'PERSONA_CORRELATION_REJECTED', 'Comando não correlacionado à aba alvo.'));
      return;
    }
    await serialize(binding.targetTabId, async () => {
      try {
        assertQueuedPanelCommand(binding, port, portEpoch, target, parsed);
        const state = await executePanelCommand(binding, port, portEpoch, target, parsed);
        if (binding.port === port && binding.portEpoch === portEpoch) safePost(port, panelState(parsed.requestId, binding, target, state));
      } catch (error) {
        if (binding.port !== port || binding.portEpoch !== portEpoch) return;
        const code = error?.code || (parsed.command === 'activate' ? 'PERSONA_ACTIVATION_FAILED' : 'PERSONA_COMMAND_FAILED');
        safePost(port, errorState(parsed.requestId, code, publicErrorMessage(code)));
      }
    });
  }

  async function initializePanel(binding, port, portEpoch, requestId) {
    await ready;
    if (binding.port !== port || binding.portEpoch !== portEpoch) return;
    if (!await establishCurrentBindingProof(binding)) {
      void unbindPanel(binding.panelTabId, false, {
        requestId,
        message: 'A aba alvo mudou ou não está mais disponível.',
        code: 'PERSONA_TARGET_CHANGED',
      });
      return;
    }
    if (binding.port !== port || binding.portEpoch !== portEpoch) return;
    const existingTarget = targets.get(binding.targetTabId);
    if (existingTarget?.token) await cleanupTarget(binding.targetTabId, 'panel-reinitialize', true);
    if (binding.port !== port || binding.portEpoch !== portEpoch) return;
    const token = randomTokenOnce(randomToken);
    if (!token) {
      safePost(port, errorState(requestId, 'PERSONA_TOKEN_FAILED', 'Não foi possível iniciar a sessão de persona.'));
      return;
    }
    const preferences = await readPreferences();
    if (binding.port !== port || binding.portEpoch !== portEpoch) return;
    let target = targets.get(binding.targetTabId);
    if (!target) target = createTarget(binding.targetTabId, binding.panelTabId);
    target.ownerPanelTabId = binding.panelTabId;
    target.token = token;
    target.generation = 0;
    target.epoch += 1;
    target.activeMode = null;
    target.contentDocumentId = null;
    target.initialized = false;
    target.cssInserted = false;
    target.preferences = preferences;
    target.reader = idleReader(preferences);
    target.limitations = [];
    target.seenEvents.clear();
    target.inFlight = null;
    targets.set(target.targetTabId, target);
    safePost(port, panelState(requestId, binding, target));
  }

  async function serialize(targetTabId, operation) {
    const previous = operationQueues.get(targetTabId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    operationQueues.set(targetTabId, current);
    try { return await current; }
    finally { if (operationQueues.get(targetTabId) === current) operationQueues.delete(targetTabId); }
  }

  async function readPreferences() {
    let stored = {};
    try { stored = await storageGet(chromeApi.storage.local, Object.values(PERSONA_LOCAL_KEYS)); } catch { /* defaults */ }
    return normalizePreferences({
      voiceId: stored?.[PERSONA_LOCAL_KEYS.voiceId],
      rate: stored?.[PERSONA_LOCAL_KEYS.rate],
    });
  }

  async function executePanelCommand(binding, port, portEpoch, target, parsed) {
    const operation = { epoch: target.epoch, token: target.token, portEpoch };
    assertOperation(binding, port, target, operation);
    if (parsed.command === 'go-target') {
      await chromeApi.tabs.update?.(target.targetTabId, { active: true });
      assertOperation(binding, port, target, operation);
      return currentTargetState(target);
    }
    if (parsed.command === 'preferences') {
      const preferences = normalizePreferences(parsed.args);
      await storageSet(chromeApi.storage.local, {
        [PERSONA_LOCAL_KEYS.voiceId]: preferences.voiceId,
        [PERSONA_LOCAL_KEYS.rate]: preferences.rate,
      });
      assertOperation(binding, port, target, operation);
      target.preferences = preferences;
      if (target.initialized) {
        await sendContentCommand(binding, port, target, operation, 'preferences', { preferences });
      } else target.generation += 1;
      return currentTargetState(target);
    }
    if (parsed.command === 'activate') {
      try {
        await ensureInjected(binding, port, target, operation);
        const activated = await sendContentCommand(binding, port, target, operation, 'activate', {
          mode: parsed.args.mode,
          preferences: target.preferences,
        });
        if (activated.activeMode !== parsed.args.mode) throw personaError('PERSONA_ACTIVATION_FAILED');
        if (!target.contentPort) await connectContentPort(target);
      } catch (error) {
        await sendBestEffortStop(target);
        await rollbackPartialActivation(target);
        invalidateFailedActivation(target);
        throw personaError('PERSONA_TARGET_CHANGED');
      }
      return currentTargetState(target);
    }
    if (parsed.command === 'reader-action') {
      if (!target.initialized || target.activeMode !== 'reader') throw personaError('PERSONA_COMMAND_FAILED');
      await sendContentCommand(binding, port, target, operation, 'reader-action', { action: parsed.args.action });
      if (parsed.args.action === 'stop') await removePersonaCss(target, operation, binding, port);
      return currentTargetState(target);
    }
    if (parsed.command === 'stop') {
      await cleanupTarget(target.targetTabId, 'panel-command', false, { binding, port, operation });
      return currentTargetState(target);
    }
    throw personaError('PERSONA_COMMAND_FAILED');
  }

  async function ensureInjected(binding, port, target, operation) {
    if (!target.initialized) {
      let results;
      try {
        results = await chromeApi.scripting.executeScript({
          target: { tabId: target.targetTabId, frameIds: [0] },
          world: 'ISOLATED',
          files: PERSONA_CLASSIC_FILES,
        });
        assertOperation(binding, port, target, operation);
        const injection = Array.isArray(results)
          ? results.find(result => result?.frameId === 0 && boundedIdentifier(result?.documentId))
          : null;
        if (!injection) throw personaError('PERSONA_ACTIVATION_FAILED');
        target.pendingDocumentId = injection.documentId;
      } catch (error) {
        if (error?.code) throw error;
        throw personaError(target.epoch !== operation.epoch ? 'PERSONA_TARGET_CHANGED' : 'PERSONA_ACTIVATION_FAILED');
      }
    }
    if (!target.cssInserted) {
      try {
        await chromeApi.scripting.insertCSS({
          target: { tabId: target.targetTabId, frameIds: [0] },
          files: PERSONA_CSS_FILES,
          origin: 'AUTHOR',
        });
        assertOperation(binding, port, target, operation);
        target.cssInserted = true;
      } catch (error) {
        await rollbackPartialActivation(target);
        if (error?.code) throw error;
        throw personaError(target.epoch !== operation.epoch ? 'PERSONA_TARGET_CHANGED' : 'PERSONA_ACTIVATION_FAILED');
      }
    }
    if (!target.initialized) {
      target.contentDocumentId = target.pendingDocumentId;
      target.pendingDocumentId = null;
      try {
        await sendContentCommand(binding, port, target, operation, 'initialize', {});
        target.initialized = true;
      } catch (error) {
        await rollbackPartialActivation(target);
        throw error;
      }
    }
  }

  async function sendContentCommand(binding, port, target, operation, command, args) {
    assertOperation(binding, port, target, operation);
    const generation = target.generation + 1;
    const requestId = randomTokenOnce(nextRequestId);
    if (!requestId || !target.token || !target.contentDocumentId) throw personaError('PERSONA_CORRELATION_REJECTED');
    const message = {
      protocol: CONTENT_PROTOCOL,
      version: 1,
      type: 'command',
      requestId,
      token: target.token,
      generation,
      documentId: target.contentDocumentId,
      command,
      args,
    };
    const correlation = {
      targetTabId: target.targetTabId,
      token: target.token,
      documentId: target.contentDocumentId,
      epoch: target.epoch,
      attemptedGeneration: generation,
      cssInserted: target.cssInserted,
      contentPort: target.contentPort,
    };
    const inFlight = {
      generation, token: target.token, documentId: target.contentDocumentId,
      events: [], overflowed: false,
    };
    target.inFlight = inFlight;
    try {
      const response = await chromeApi.tabs.sendMessage(target.targetTabId, message, {
        frameId: 0,
        documentId: target.contentDocumentId,
      });
      assertOperation(binding, port, target, operation);
      const ack = parseContentAck(response, message);
      if (!ack) throw new Error('ACK de conteúdo ausente ou inválido.');
      target.generation = generation;
      applyContentState(target, ack.state);
      if (target.inFlight === inFlight) target.inFlight = null;
      await reconcileInFlightEvents(target, inFlight, operation, binding, port);
      return currentTargetState(target);
    } catch {
      if (target.inFlight === inFlight) target.inFlight = null;
      await recoverUncertainCommand(target, correlation);
      throw personaError('PERSONA_TARGET_CHANGED');
    }
  }

  async function recoverUncertainCommand(target, correlation) {
    const stoppedExecutedCommand = await sendRecoveryStop(correlation, correlation.attemptedGeneration + 1);
    if (!stoppedExecutedCommand) await sendRecoveryStop(correlation, correlation.attemptedGeneration);

    try { correlation.contentPort?.disconnect?.(); } catch { /* disconnect local encerra a persona mesmo sem ACK */ }
    if (correlation.cssInserted) {
      try {
        await chromeApi.scripting.removeCSS({
          target: { tabId: correlation.targetTabId, frameIds: [0] },
          files: PERSONA_CSS_FILES,
          origin: 'AUTHOR',
        });
      } catch { /* a navegação pode já ter removido o documento */ }
    }

    if (targets.get(correlation.targetTabId) !== target || target.token !== correlation.token ||
      target.contentDocumentId !== correlation.documentId || target.epoch !== correlation.epoch) return;
    target.epoch += 1;
    target.generation = correlation.attemptedGeneration + 1;
    target.token = null;
    target.initialized = false;
    target.contentDocumentId = null;
    target.pendingDocumentId = null;
    target.activeMode = null;
    target.reader = idleReader(target.preferences);
    target.limitations = [];
    target.cssInserted = false;
    target.inFlight = null;
    if (target.contentPort === correlation.contentPort) target.contentPort = null;
    target.seenEvents.clear();
  }

  async function sendRecoveryStop(correlation, generation) {
    const requestId = randomTokenOnce(nextRequestId);
    if (!requestId) return false;
    const message = {
      protocol: CONTENT_PROTOCOL, version: 1, type: 'command', requestId,
      token: correlation.token, generation, documentId: correlation.documentId,
      command: 'stop', args: {},
    };
    try {
      const response = await chromeApi.tabs.sendMessage(correlation.targetTabId, message, {
        frameId: 0, documentId: correlation.documentId,
      });
      return Boolean(parseContentAck(response, message));
    } catch { return false; }
  }

  async function connectContentPort(target) {
    if (typeof chromeApi.tabs.connect !== 'function' || !target.contentDocumentId) {
      throw personaError('PERSONA_ACTIVATION_FAILED');
    }
    let port;
    try {
      port = chromeApi.tabs.connect(target.targetTabId, {
        name: CONTENT_PORT, frameId: 0, documentId: target.contentDocumentId,
      });
    } catch { throw personaError('PERSONA_ACTIVATION_FAILED'); }
    target.contentPort = port;
    target.seenEvents.clear();
    const token = target.token;
    const documentId = target.contentDocumentId;
    const generation = target.generation;
    const epoch = target.epoch;
    const eventListener = message => {
      const parsed = parseContentEvent(message);
      if (!parsed || targets.get(target.targetTabId) !== target || target.contentPort !== port ||
        parsed.token !== token || parsed.documentId !== documentId || target.seenEvents.has(parsed.eventId)) return;
      if (parsed.generation !== target.generation) {
        const inFlight = target.inFlight;
        if (!inFlight || parsed.generation !== inFlight.generation || parsed.token !== inFlight.token ||
          parsed.documentId !== inFlight.documentId) return;
        if (parsed.event === 'lifecycle-stop') {
          invalidateBindingProof(bindings.get(target.ownerPanelTabId));
        }
        target.seenEvents.add(parsed.eventId);
        trimSet(target.seenEvents, 128);
        if (inFlight.events.length < 16) inFlight.events.push(parsed);
        else inFlight.overflowed = true;
        return;
      }
      if (parsed.event === 'lifecycle-stop') {
        invalidateBindingProof(bindings.get(target.ownerPanelTabId));
      }
      target.seenEvents.add(parsed.eventId);
      trimSet(target.seenEvents, 128);
      if (parsed.state) {
        applyContentState(target, parsed.state);
        const binding = bindings.get(target.ownerPanelTabId);
        if (binding?.port) safePost(binding.port, panelState(parsed.eventId, binding, target));
        return;
      }
      void serialize(target.targetTabId, async () => {
        if (targets.get(target.targetTabId) !== target || target.token !== token ||
          target.contentDocumentId !== documentId || target.generation !== parsed.generation) return;
        target.activeMode = null;
        target.reader = idleReader(target.preferences);
        target.limitations = [];
        try { await removePersonaCss(target); } catch { target.cssInserted = false; }
        const binding = bindings.get(target.ownerPanelTabId);
        if (binding?.port) safePost(binding.port, panelState(parsed.eventId, binding, target));
      });
    };
    port.onMessage?.addListener?.(eventListener);
    let handshakeSettled = false;
    let handshakeBound = false;
    let handshakeTimer = null;
    let resolveHandshake;
    let rejectHandshake;
    const handshake = new Promise((resolve, reject) => {
      resolveHandshake = resolve;
      rejectHandshake = reject;
    });
    const finishHandshake = error => {
      if (handshakeSettled) return;
      handshakeSettled = true;
      if (handshakeTimer !== null) clearTimeout(handshakeTimer);
      port.onMessage?.removeListener?.(handshakeListener);
      if (error) rejectHandshake(error);
      else resolveHandshake();
    };
    const handshakeListener = message => {
      const ack = parseContentBoundAck(message, { token, generation, documentId });
      if (!ack || targets.get(target.targetTabId) !== target || target.contentPort !== port) return;
      handshakeBound = true;
      finishHandshake(null);
    };
    port.onMessage?.addListener?.(handshakeListener);
    const disconnectListener = () => {
      const wasCurrent = target.contentPort === port;
      if (wasCurrent) target.contentPort = null;
      finishHandshake(personaError('PERSONA_TARGET_CHANGED'));
      if (wasCurrent && handshakeBound) {
        void reconcileContentPortDisconnect(target, { token, documentId, epoch });
      }
    };
    port.onDisconnect?.addListener?.(disconnectListener);
    try {
      port.postMessage?.({
        protocol: CONTENT_PROTOCOL, version: 1, type: 'bind-events', token,
        generation, documentId,
      });
    } catch {
      if (target.contentPort === port) target.contentPort = null;
      finishHandshake(personaError('PERSONA_ACTIVATION_FAILED'));
      try { port.disconnect?.(); } catch { /* handshake failure is contained */ }
    }
    if (!handshakeSettled) {
      handshakeTimer = setTimeout(() => {
        if (target.contentPort === port) target.contentPort = null;
        finishHandshake(personaError('PERSONA_ACTIVATION_FAILED'));
        try { port.disconnect?.(); } catch { /* timeout encerra o canal parcial */ }
      }, 1500);
    }
    await handshake;
  }

  async function reconcileContentPortDisconnect(target, correlation) {
    await serialize(target.targetTabId, async () => {
      if (targets.get(target.targetTabId) !== target || target.token !== correlation.token ||
        target.contentDocumentId !== correlation.documentId || target.epoch !== correlation.epoch ||
        target.contentPort) return;
      if (target.activeMode === null && !target.cssInserted) return;
      target.activeMode = null;
      target.reader = idleReader(target.preferences);
      target.limitations = [];
      try { await removePersonaCss(target); } catch { target.cssInserted = false; }
      const binding = bindings.get(target.ownerPanelTabId);
      if (binding?.port) safePost(binding.port, panelState('content-port-disconnect', binding, target));
    });
  }

  async function reconcileInFlightEvents(target, inFlight, operation, binding, port) {
    let lifecycleStop = inFlight.overflowed;
    for (const event of inFlight.events) {
      if (lifecycleStop) break;
      if (event.state) applyContentState(target, event.state);
      else lifecycleStop = true;
    }
    if (!lifecycleStop) return;
    target.activeMode = null;
    target.reader = idleReader(target.preferences);
    target.limitations = [];
    try { await removePersonaCss(target, operation, binding, port); }
    catch { target.cssInserted = false; }
  }

  function assertOperation(binding, port, target, operation) {
    if (target.epoch !== operation.epoch || target.token !== operation.token) throw personaError('PERSONA_TARGET_CHANGED');
    if (binding.port !== port || binding.portEpoch !== operation.portEpoch ||
      owners.get(target.targetTabId) !== binding.panelTabId) throw personaError('PERSONA_CORRELATION_REJECTED');
  }

  function assertQueuedPanelCommand(binding, port, portEpoch, target, parsed) {
    if (bindings.get(binding.panelTabId) !== binding || binding.port !== port ||
      binding.portEpoch !== portEpoch || binding.releaseRequested ||
      owners.get(binding.targetTabId) !== binding.panelTabId ||
      targets.get(binding.targetTabId) !== target || parsed.token !== target.token ||
      parsed.generation !== target.generation) throw personaError('PERSONA_CORRELATION_REJECTED');
  }

  async function removePersonaCss(target, operation, binding, port) {
    if (!target.cssInserted) return;
    await chromeApi.scripting.removeCSS({
      target: { tabId: target.targetTabId, frameIds: [0] },
      files: PERSONA_CSS_FILES,
      origin: 'AUTHOR',
    });
    if (operation && binding && port) assertOperation(binding, port, target, operation);
    target.cssInserted = false;
  }

  async function rollbackPartialActivation(target) {
    const needsCssRollback = target.cssInserted || target.initialized || target.contentDocumentId || target.pendingDocumentId;
    if (needsCssRollback) {
      try {
        await chromeApi.scripting.removeCSS({
          target: { tabId: target.targetTabId, frameIds: [0] },
          files: PERSONA_CSS_FILES,
          origin: 'AUTHOR',
        });
      } catch { /* rollback is best effort and remains visible as activation failure */ }
    }
    try { target.contentPort?.disconnect?.(); } catch { /* o canal antigo não pode possuir a nova sessão */ }
    target.contentPort = null;
    target.cssInserted = false;
    target.initialized = false;
    target.contentDocumentId = null;
    target.pendingDocumentId = null;
    target.activeMode = null;
    target.reader = idleReader(target.preferences);
    target.limitations = [];
    target.inFlight = null;
  }

  function invalidateFailedActivation(target) {
    target.epoch += 1;
    target.generation += 1;
    target.token = null;
    target.seenEvents.clear();
  }

  async function cleanupTarget(targetTabId, _reason, invalidate, context = {}) {
    const target = targets.get(targetTabId);
    if (!target) return;
    let commandError = null;
    if (target.initialized && target.token && target.contentDocumentId && context.binding && context.port && context.operation) {
      try { await sendContentCommand(context.binding, context.port, target, context.operation, 'stop', {}); }
      catch (error) { commandError = error; }
    } else await sendBestEffortStop(target);
    try { await removePersonaCss(target, context.operation, context.binding, context.port); } catch { /* inert CSS without classes */ }
    try { target.contentPort?.disconnect?.(); } catch { /* the content port may already be closed */ }
    target.contentPort = null;
    target.activeMode = null;
    target.reader = idleReader(target.preferences);
    target.limitations = [];
    target.cssInserted = false;
    if (invalidate) {
      target.epoch += 1;
      target.generation += 1;
      target.token = null;
      target.initialized = false;
      target.contentDocumentId = null;
      target.pendingDocumentId = null;
      target.seenEvents.clear();
      target.inFlight = null;
    }
    if (commandError) throw commandError;
  }

  async function sendBestEffortStop(target) {
    if (!target.initialized || !target.token || !target.contentDocumentId) return;
    const generation = target.generation + 1;
    const requestId = randomTokenOnce(nextRequestId);
    if (!requestId) return;
    const message = {
      protocol: CONTENT_PROTOCOL, version: 1, type: 'command', requestId,
      token: target.token, generation, documentId: target.contentDocumentId,
      command: 'stop', args: {},
    };
    try {
      const response = await chromeApi.tabs.sendMessage(target.targetTabId, message, {
        frameId: 0, documentId: target.contentDocumentId,
      });
      const ack = parseContentAck(response, message);
      if (ack) {
        target.generation = generation;
        applyContentState(target, ack.state);
      }
    } catch { /* cleanup is fail-closed and does not depend on an ACK */ }
  }

  function handleTabUpdated(tabId, changeInfo = {}, tab = {}) {
    if (!bindingsReady) {
      bufferEarlyTabEvent({ type: 'updated', tabId, changeInfo: copyTabEventRecord(changeInfo), tab: copyTabEventRecord(tab) });
      return;
    }
    const reservation = panelReservations.get(tabId);
    if (reservation) {
      const nextPanelUrl = typeof changeInfo.url === 'string' ? changeInfo.url : tab.url;
      const remainsProvisional = isPendingExactPanelTab(tab);
      if (typeof nextPanelUrl === 'string' && !isExactPanelUrl(nextPanelUrl) && !remainsProvisional) {
        cancelPanelReservation(tabId, reservation);
      }
    }
    for (const pendingReservation of [...panelReservations.values()]) {
      if (pendingReservation.targetTabId !== tabId) continue;
      const nextSourceUrl = typeof changeInfo.url === 'string' ? changeInfo.url : tab.url;
      if (changeInfo.status === 'loading' ||
        (typeof nextSourceUrl === 'string' && nextSourceUrl !== pendingReservation.sourceUrl)) {
        cancelPanelReservation(pendingReservation.panelTabId, pendingReservation);
      }
    }
    if (bindings.has(tabId)) {
      const nextPanelUrl = typeof changeInfo.url === 'string' ? changeInfo.url : tab.url;
      if (typeof nextPanelUrl === 'string' && !isExactPanelUrl(nextPanelUrl)) {
        void unbindPanel(tabId, true, {
          requestId: 'panel-navigation',
          message: 'O painel navegou para outra página. As simulações foram encerradas.',
          code: 'PERSONA_PANEL_CHANGED',
        });
      }
      return;
    }
    if (!Object.hasOwn(changeInfo, 'url') && changeInfo.status !== 'loading') return;
    const panelTabId = owners.get(tabId);
    const binding = panelTabId === undefined ? null : bindings.get(panelTabId);
    if (!binding) return;
    invalidateBindingProof(binding);
    const target = targets.get(tabId);
    if (target) {
      target.epoch += 1;
      target.generation += 1;
      try { target.contentPort?.disconnect?.(); } catch { /* navegação também encerra o canal local */ }
      target.contentPort = null;
      target.token = null;
      target.activeMode = null;
      target.contentDocumentId = null;
      target.pendingDocumentId = null;
      target.initialized = false;
      target.cssInserted = false;
      target.reader = idleReader(target.preferences);
      target.limitations = [];
      target.seenEvents.clear();
      target.inFlight = null;
    }
    const nextUrl = typeof changeInfo.url === 'string' ? changeInfo.url : tab?.url;
    if (typeof nextUrl === 'string' && !isHttpUrl(nextUrl)) {
      void unbindPanel(binding.panelTabId, false, {
        requestId: 'target-navigation',
        message: 'A aba alvo saiu de uma página web compatível. As simulações foram desabilitadas.',
        code: 'PERSONA_TARGET_CHANGED',
      });
    } else if (binding?.port) {
      safePost(binding.port, errorState('navigation', 'PERSONA_TARGET_CHANGED', 'A aba alvo navegou; ative novamente a simulação.'));
    }
  }

  function invalidateBindingProof(binding) {
    if (!binding || bindings.get(binding.panelTabId) !== binding) return;
    const proofDocumentId = binding.proofDocumentId;
    binding.proofDocumentId = null;
    binding.proofRequired = true;
    advanceProofEpoch(binding);
    if (proofDocumentId) {
      advanceProofEpoch(binding);
      void clearBindingProof(binding.panelTabId, binding.targetTabId, proofDocumentId);
    }
  }

  function handleTabRemoved(tabId) {
    if (!bindingsReady) {
      bufferEarlyTabEvent({ type: 'removed', tabId });
      return;
    }
    cancelPanelReservation(tabId);
    for (const reservation of [...panelReservations.values()]) {
      if (reservation.targetTabId === tabId) cancelPanelReservation(reservation.panelTabId, reservation);
    }
    if (bindings.has(tabId)) {
      void unbindPanel(tabId, true, {
        requestId: 'panel-removed',
        message: 'O painel foi fechado. As simulações foram encerradas.',
        code: 'PERSONA_PANEL_REMOVED',
      });
      return;
    }
    const panelTabId = owners.get(tabId);
    if (panelTabId !== undefined) {
      void unbindPanel(panelTabId, false, {
        requestId: 'target-removed',
        message: 'A aba de origem foi fechada. As simulações foram desabilitadas.',
        code: 'PERSONA_TARGET_REMOVED',
      });
    }
  }

  function unbindPanel(panelTabId, cleanupContent, notice) {
    const binding = bindings.get(panelTabId);
    if (!binding) return Promise.resolve();
    requestBindingRelease(binding, notice);
    return serializeOwnership(() => releasePanelBinding(panelTabId, cleanupContent, notice));
  }

  function requestBindingRelease(binding, notice) {
    if (bindings.get(binding.panelTabId) !== binding || binding.releaseRequested) return;
    binding.releaseRequested = true;
    advanceProofEpoch(binding);
    binding.portEpoch += 1;
    if (binding.port && notice) safePost(binding.port, unboundState(notice.requestId, notice.message, notice.code));
    const stalePort = binding.port;
    binding.detachPort?.();
    binding.port = null;
    binding.panelDocumentId = null;
    try { stalePort?.disconnect?.(); } catch { /* o painel pode já estar desconectado */ }
  }

  async function releasePanelBinding(panelTabId, cleanupContent, notice) {
    const binding = bindings.get(panelTabId);
    if (!binding) return;
    requestBindingRelease(binding, notice);
    bindings.delete(panelTabId);
    if (owners.get(binding.targetTabId) === panelTabId) owners.delete(binding.targetTabId);
    const proofDocumentId = binding.proofDocumentId;
    binding.proofDocumentId = null;
    binding.proofRequired = true;
    advanceProofEpoch(binding);
    try { await persistBindings(); }
    catch { logger.error('Não foi possível atualizar o vínculo local de persona.'); }
    finally {
      if (proofDocumentId) {
        advanceProofEpoch(binding);
        await clearBindingProof(binding.panelTabId, binding.targetTabId, proofDocumentId);
      }
    }
    const ownedTarget = targets.get(binding.targetTabId);
    if (ownedTarget && ownedTarget.ownerPanelTabId === panelTabId) {
      await serialize(binding.targetTabId, () => cleanupTarget(
        binding.targetTabId, cleanupContent ? 'panel-release' : 'target-release', true,
      ));
      if (targets.get(binding.targetTabId) === ownedTarget && ownedTarget.ownerPanelTabId === panelTabId) {
        targets.delete(binding.targetTabId);
      }
    }
  }

  async function safeRemoveTab(tabId) {
    try { await chromeApi.tabs.remove?.(tabId); } catch { /* rollback best effort */ }
  }

  function bufferEarlyTabEvent(event) {
    if (!Number.isSafeInteger(event.tabId) || event.tabId < 0 || earlyEventsOverflowed) return;
    if (earlyTabEvents.length >= 256) {
      earlyEventsOverflowed = true;
      earlyTabEvents.length = 0;
      return;
    }
    earlyTabEvents.push(event);
  }

  function isExactPanelUrl(value) {
    return typeof value === 'string' && value === chromeApi.runtime.getURL('src/panel/index.html');
  }

  function isExactPanelTab(tab) {
    return Number.isSafeInteger(tab?.id) && tab.status === 'complete' && isExactPanelUrl(tab.url);
  }

  function isPendingExactPanelTab(tab) {
    if (!Number.isSafeInteger(tab?.id) || tab.status !== 'loading') return false;
    if (isExactPanelUrl(tab.url)) return true;
    if (!isExactPanelUrl(tab.pendingUrl)) return false;
    return tab.url === undefined || tab.url === '' || tab.url === 'about:blank';
  }
}

function createBinding(panelTabId, targetTabId, proofDocumentId = null) {
  return {
    panelTabId, targetTabId, port: null, panelDocumentId: null,
    proofDocumentId, proofRequired: !proofDocumentId,
    proofEpoch: proofDocumentId ? 1n : 0n,
    portEpoch: 0, seenRequests: new Set(), detachPort: null, releaseRequested: false,
  };
}

function advanceProofEpoch(binding) {
  binding.proofEpoch += 1n;
}

function createTarget(targetTabId, ownerPanelTabId) {
  return {
    targetTabId, ownerPanelTabId, token: null, generation: 0, epoch: 0,
    activeMode: null, contentDocumentId: null, initialized: false, cssInserted: false,
    preferences: { voiceId: '', rate: 1 }, reader: idleReader(), limitations: [],
    contentPort: null, seenEvents: new Set(), inFlight: null,
  };
}

function parseSourceTab(value) {
  const record = copyAllowedRecord(value, ['id', 'url']);
  if (!record || !Number.isSafeInteger(record.id) || record.id < 0 || !isHttpUrl(record.url)) return null;
  return { id: record.id, url: record.url };
}

function parseBindingLeaseRequest(value) {
  const record = copyExactRecord(value, ['panelTabId', 'targetTabId', 'sourceUrl', 'panelDocumentId']);
  if (!record || !Number.isSafeInteger(record.panelTabId) || record.panelTabId < 0 ||
    !Number.isSafeInteger(record.targetTabId) || record.targetTabId < 0 || !isHttpUrl(record.sourceUrl) ||
    !boundedIdentifier(record.panelDocumentId)) return null;
  return record;
}

function parseNumericBinding(value) {
  const record = copyExactRecord(value, ['panelTabId', 'targetTabId']);
  if (!record || !Number.isSafeInteger(record.panelTabId) || record.panelTabId < 0 ||
    !Number.isSafeInteger(record.targetTabId) || record.targetTabId < 0) return null;
  return record;
}

function isCompleteHttpTab(value, expectedId, expectedUrl = null) {
  const record = copyAllowedRecord(value, ['id', 'url', 'status']);
  return Boolean(record && record.id === expectedId && record.status === 'complete' && isHttpUrl(record.url) &&
    (expectedUrl === null || record.url === expectedUrl));
}

function hasPendingNavigation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return true;
  let descriptors;
  try { descriptors = Object.getOwnPropertyDescriptors(value); } catch { return true; }
  if (Object.values(descriptors).some(descriptor => !Object.hasOwn(descriptor, 'value'))) return true;
  const descriptor = descriptors.pendingUrl;
  return Boolean(descriptor && descriptor.value !== undefined && descriptor.value !== '');
}

function isHttpUrl(value) {
  if (typeof value !== 'string' || value.length > 4096) return false;
  try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; }
}

function parsePanelPort(port, runtimeId) {
  if (!port || port.name !== PANEL_PORT || port.sender?.id !== runtimeId || port.sender?.frameId !== 0 ||
    !Number.isSafeInteger(port.sender?.tab?.id) || !boundedIdentifier(port.sender?.documentId) ||
    typeof port.sender?.url !== 'string') return null;
  try {
    const url = new URL(port.sender.url);
    if (url.protocol !== 'chrome-extension:' || url.hostname !== runtimeId || url.pathname !== PANEL_PATH || url.search || url.hash) return null;
  } catch { return null; }
  return { panelTabId: port.sender.tab.id, documentId: port.sender.documentId };
}

function boundedIdentifier(value) {
  return typeof value === 'string' && IDENTIFIER.test(value);
}

function randomTokenOnce(factory) {
  let value;
  try { value = factory(); } catch { return null; }
  return boundedIdentifier(value) ? value : null;
}

function trimSet(set, maximum) {
  while (set.size > maximum) set.delete(set.values().next().value);
}

function storageGet(area, key) { return Promise.resolve(area.get(key)); }
function storageSet(area, value) { return Promise.resolve(area.set(value)); }

function copyAllowedRecord(value, required) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  let descriptors;
  try { descriptors = Object.getOwnPropertyDescriptors(value); } catch { return null; }
  if (Object.values(descriptors).some(descriptor => !Object.hasOwn(descriptor, 'value'))) return null;
  if (required.some(key => !Object.hasOwn(descriptors, key))) return null;
  return Object.fromEntries(required.map(key => [key, descriptors[key].value]));
}

function copyExactRecord(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  let descriptors;
  try { descriptors = Object.getOwnPropertyDescriptors(value); } catch { return null; }
  if (Object.values(descriptors).some(descriptor => !Object.hasOwn(descriptor, 'value'))) return null;
  const keys = Object.keys(descriptors).sort();
  const allowed = new Set([...required, ...optional]);
  if (required.some(key => !Object.hasOwn(descriptors, key)) || keys.some(key => !allowed.has(key))) return null;
  return Object.fromEntries(keys.map(key => [key, descriptors[key].value]));
}

function copyTabEventRecord(value) {
  const record = copyAllowedRecord(value, []);
  if (!record && (!value || typeof value !== 'object')) return {};
  let descriptors;
  try { descriptors = Object.getOwnPropertyDescriptors(value); } catch { return {}; }
  const result = {};
  for (const key of ['status', 'url']) {
    const descriptor = descriptors[key];
    if (descriptor && Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'string' && descriptor.value.length <= 4096) {
      result[key] = descriptor.value;
    }
  }
  return result;
}

function parsePanelMessage(value) {
  const cloned = cloneDataRecord(value);
  if (!cloned) return null;
  const common = ['protocol', 'version', 'type', 'requestId'];
  if (cloned.type === 'hello') {
    if (!hasExactKeys(cloned, common)) return null;
  } else if (cloned.type === 'command') {
    if (!hasExactKeys(cloned, [...common, 'token', 'generation', 'command', 'args'])) return null;
  } else return null;
  if (cloned.protocol !== PANEL_PROTOCOL || cloned.version !== 1 || !boundedIdentifier(cloned.requestId)) return null;
  if (cloned.type === 'hello') return cloned;
  if (!boundedIdentifier(cloned.token) || !Number.isSafeInteger(cloned.generation) || cloned.generation < 0 ||
    !validPanelArgs(cloned.command, cloned.args)) return null;
  return cloned;
}

function validPanelArgs(command, args) {
  if (command === 'activate') return hasExactKeys(args, ['mode']) && MODES.has(args.mode);
  if (command === 'preferences') return validPreferences(args);
  if (command === 'reader-action') return hasExactKeys(args, ['action']) && READER_ACTIONS.has(args.action);
  return (command === 'stop' || command === 'go-target') && hasExactKeys(args, []);
}

function parseContentAck(value, expected) {
  const cloned = cloneDataRecord(value);
  if (!cloned || !hasExactKeys(cloned, [
    'protocol', 'version', 'type', 'requestId', 'token', 'generation', 'documentId', 'ok', 'state',
  ]) || cloned.protocol !== CONTENT_PROTOCOL || cloned.version !== 1 || cloned.type !== 'ack' || cloned.ok !== true ||
    cloned.requestId !== expected.requestId || cloned.token !== expected.token ||
    cloned.generation !== expected.generation || cloned.documentId !== expected.documentId) return null;
  const state = sanitizeContentState(cloned.state);
  return state ? { state } : null;
}

function parseContentBoundAck(value, expected) {
  const cloned = cloneDataRecord(value);
  if (!cloned || !hasExactKeys(cloned, [
    'protocol', 'version', 'type', 'token', 'generation', 'documentId',
  ]) || cloned.protocol !== CONTENT_PROTOCOL || cloned.version !== 1 || cloned.type !== 'events-bound' ||
    cloned.token !== expected.token || cloned.generation !== expected.generation ||
    cloned.documentId !== expected.documentId) return null;
  return cloned;
}

function parseContentEvent(value) {
  const cloned = cloneDataRecord(value);
  if (!cloned || cloned.protocol !== CONTENT_PROTOCOL || cloned.version !== 1 || cloned.type !== 'event' ||
    !boundedIdentifier(cloned.eventId) || !boundedIdentifier(cloned.token) ||
    !boundedIdentifier(cloned.documentId) || !Number.isSafeInteger(cloned.generation) || cloned.generation < 1 ||
    !['state', 'emergency-stop', 'lifecycle-stop'].includes(cloned.event)) return null;
  if (cloned.event === 'state') {
    if (!hasExactKeys(cloned, [
      'protocol', 'version', 'type', 'event', 'eventId', 'token', 'generation', 'documentId', 'state',
    ])) return null;
    const state = sanitizeContentState(cloned.state);
    return state ? { ...cloned, state } : null;
  }
  if (!hasExactKeys(cloned, [
    'protocol', 'version', 'type', 'event', 'eventId', 'token', 'generation', 'documentId',
  ])) return null;
  return { ...cloned, state: null };
}

function sanitizeContentState(value) {
  if (!hasExactKeys(value, ['activeMode', 'reader', 'limitations', 'coverage']) ||
    (value.activeMode !== null && !MODES.has(value.activeMode)) ||
    value.coverage !== 'dom-fallback-top-document-open-shadow' || !Array.isArray(value.limitations) ||
    value.limitations.length > 64) return null;
  const reader = sanitizeReader(value.reader);
  if (!reader) return null;
  const limitations = [];
  for (const entry of value.limitations) {
    const truncated = entry?.truncated === true;
    const expectedKeys = truncated ? ['code', 'count', 'truncated'] : ['code', 'count'];
    if (!hasExactKeys(entry, expectedKeys) || !boundedText(entry.code, 64) ||
      !Number.isSafeInteger(entry.count) || entry.count < 1 || entry.count > 10_000) return null;
    if (truncated && entry.code !== 'dom-traversal-truncated') return null;
    limitations.push(truncated
      ? { code: entry.code, count: entry.count, truncated: true }
      : { code: entry.code, count: entry.count });
  }
  return {
    activeMode: value.activeMode,
    reader,
    limitations,
    coverage: value.coverage,
  };
}

function sanitizeReader(value) {
  if (!hasExactKeys(value, [
    'playback', 'index', 'total', 'caption', 'canPrevious', 'canNext',
    'speechAvailability', 'voiceId', 'rate',
  ]) || !['idle', 'playing', 'paused'].includes(value.playback) ||
    !Number.isSafeInteger(value.index) || value.index < -1 || value.index > 2_000 ||
    !Number.isSafeInteger(value.total) || value.total < 0 || value.total > 2_000 ||
    !boundedText(value.caption, 2_048) || value.canPrevious !== Boolean(value.canPrevious) ||
    value.canNext !== Boolean(value.canNext) || !boundedText(value.speechAvailability, 32) ||
    !boundedVoiceId(value.voiceId) || !validRate(value.rate)) return null;
  return {
    playback: value.playback,
    index: value.index,
    total: value.total,
    caption: value.caption,
    canPrevious: value.canPrevious,
    canNext: value.canNext,
    speechAvailability: value.speechAvailability,
    voiceId: value.voiceId,
    rate: value.rate,
  };
}

function applyContentState(target, value) {
  const state = sanitizeContentState(value);
  if (!state) throw personaError('PERSONA_CORRELATION_REJECTED');
  target.activeMode = state.activeMode;
  target.reader = state.reader;
  target.limitations = state.limitations;
}

function normalizePreferences(value = {}) {
  const voiceId = boundedVoiceId(value.voiceId) ? value.voiceId : '';
  const rate = validRate(value.rate) ? value.rate : 1;
  return { voiceId, rate };
}

function validPreferences(value) {
  return hasExactKeys(value, ['voiceId', 'rate']) && boundedVoiceId(value.voiceId) && validRate(value.rate);
}

function boundedVoiceId(value) {
  return typeof value === 'string' && Array.from(value).length <= 200 && !/[\u0000-\u001f\u007f]/u.test(value);
}

function validRate(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0.5 && value <= 2;
}

function boundedText(value, maximum) {
  return typeof value === 'string' && Array.from(value).length <= maximum && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
}

function idleReader(preferences = {}) {
  return {
    playback: 'idle', index: -1, total: 0, caption: '', canPrevious: false, canNext: false,
    speechAvailability: 'unknown', voiceId: boundedVoiceId(preferences.voiceId) ? preferences.voiceId : '',
    rate: validRate(preferences.rate) ? preferences.rate : 1,
  };
}

function currentTargetState(target) {
  return {
    activeMode: target.activeMode,
    reader: { ...target.reader },
    limitations: target.limitations.map(item => ({ ...item })),
    coverage: 'dom-fallback-top-document-open-shadow',
  };
}

function panelState(requestId, binding, target, value = currentTargetState(target)) {
  return {
    protocol: PANEL_PROTOCOL,
    version: 1,
    type: 'state',
    requestId,
    ok: true,
    bound: true,
    targetTabId: binding.targetTabId,
    token: target.token,
    generation: target.generation,
    activeMode: value.activeMode,
    reader: { ...value.reader },
    limitations: value.limitations.map(item => ({ ...item })),
    coverage: value.coverage,
    preferences: { ...target.preferences },
  };
}

function unboundState(requestId, message, code = 'PERSONA_UNBOUND') {
  return {
    protocol: PANEL_PROTOCOL, version: 1, type: 'state', requestId, ok: false, bound: false,
    code, message,
  };
}

function errorState(requestId, code, message) {
  return {
    protocol: PANEL_PROTOCOL, version: 1, type: 'error', requestId,
    ok: false, bound: true, code, message,
  };
}

function publicErrorMessage(code) {
  const messages = {
    PERSONA_TARGET_CHANGED: 'A aba alvo mudou durante a operação. Ative novamente a simulação.',
    PERSONA_CORRELATION_REJECTED: 'A resposta da aba alvo não pôde ser confirmada.',
    PERSONA_ACTIVATION_FAILED: 'Não foi possível ativar a simulação nesta página.',
    PERSONA_COMMAND_FAILED: 'Não foi possível executar este controle da simulação.',
  };
  return messages[code] || 'Não foi possível concluir a operação de persona.';
}

function personaError(code) {
  const error = new Error(publicErrorMessage(code));
  error.code = code;
  return error;
}

function safePost(port, message) {
  try { port?.postMessage?.(message); } catch { /* a porta pode fechar entre a validação e o ACK */ }
}

function hasExactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  const wanted = expected.slice().sort();
  return keys.length === wanted.length && keys.every((key, index) => key === wanted[index]);
}

function cloneDataRecord(value) {
  const copied = copyDeepData(value, 0, { count: 0 });
  if (!copied.ok || !copied.value || typeof copied.value !== 'object' || Array.isArray(copied.value)) return null;
  try {
    if (typeof structuredClone === 'function') structuredClone(value);
  } catch { return null; }
  return copied.value;
}

function copyDeepData(value, depth, budget) {
  if (depth > 8 || budget.count > 256) return { ok: false };
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return { ok: true, value };
  if (typeof value === 'number' && Number.isFinite(value)) return { ok: true, value };
  if (!value || typeof value !== 'object') return { ok: false };
  if (Array.isArray(value)) {
    if (value.length > 64) return { ok: false };
    const descriptorMap = safeDescriptors(value);
    if (!descriptorMap) return { ok: false };
    const allowedKeys = Array.from({ length: value.length }, (_, index) => String(index));
    if (Object.keys(descriptorMap).some(key => key !== 'length' && !allowedKeys.includes(key))) return { ok: false };
    const output = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptorMap[index];
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) return { ok: false };
      budget.count += 1;
      const copied = copyDeepData(descriptor.value, depth + 1, budget);
      if (!copied.ok) return copied;
      output.push(copied.value);
    }
    return { ok: true, value: output };
  }
  const descriptors = safeDescriptors(value);
  if (!descriptors) return { ok: false };
  const output = Object.create(null);
  for (const key of Object.keys(descriptors)) {
    const descriptor = descriptors[key];
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) return { ok: false };
    budget.count += 1;
    const copied = copyDeepData(descriptor.value, depth + 1, budget);
    if (!copied.ok) return copied;
    output[key] = copied.value;
  }
  return { ok: true, value: output };
}

function safeDescriptors(value) {
  try { return Object.getOwnPropertyDescriptors(value); } catch { return null; }
}
