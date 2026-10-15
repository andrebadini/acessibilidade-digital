import { sanitizeEvidenceUrlV1 } from '../core/privacy/evidence-url.js';
import { runAuditaPageMarkersCommand } from '../browser/page-markers-overlay.js';
import { bindAuditaPageMarkersPort } from '../browser/page-markers-port.js';
import { projectPageMarkers } from './page-marker-projection.js';
import { findingKind } from '../core/report/finding-kind.js';
import { AUDIT_EXECUTION_INTERNAL } from './chrome-adapter.js';
import { createPageRelocationOfferStore } from './page-relocation-offer.js';

const INSTALLATION_ID = /^[A-Za-z0-9_-]{22}$/u;
const AUDIT_ID = /^[A-Za-z0-9._:-]{1,200}$/u;
const DOCUMENT_ID = /^[A-Za-z0-9._:-]{1,240}$/u;
const DIGEST = /^hmac-sha256:[A-Za-z0-9_-]{43}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const INVALIDATION_REASONS = Object.freeze(['navigation', 'discarded', 'tab-removed', 'window-changed']);
const TYPES = new Set(['PANEL_SHOW_PAGE_MARKERS', 'PANEL_SHOW_PAGE_MARKERS_RELOADED',
  'PANEL_HIDE_PAGE_MARKERS', 'PANEL_SELECT_PAGE_MARKER', 'PANEL_FILTER_PAGE_MARKERS']);
// Every 64-fold ceiling in this path — targets, signals, ordinals — moved to the same bound so a
// page with more than 64 findings stops losing its signals past the 64th.
const MAX_PAGE_MARKER_TARGETS = 500;

function ownData(object, key) {
  try {
    const descriptor = object && typeof object === 'object' ? Reflect.getOwnPropertyDescriptor(object, key) : null;
    return descriptor?.enumerable && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  } catch { return undefined; }
}
function ownCallable(object, key) { const value = ownData(object, key); return typeof value === 'function' ? value : null; }
function exactData(value, fields) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Reflect.getPrototypeOf(value))) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== fields.length || fields.some(field => !keys.includes(field)) ||
      keys.some(key => typeof key !== 'string' || !fields.includes(key))) return null;
    const copy = Object.create(null);
    for (const field of fields) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, field);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      copy[field] = descriptor.value;
    }
    return copy;
  } catch { return null; }
}
function denseArray(value, maximum = 10_000) {
  try {
    if (!Array.isArray(value)) return null;
    const length = Reflect.getOwnPropertyDescriptor(value, 'length')?.value;
    const keys = Reflect.ownKeys(value);
    if (!Number.isSafeInteger(length) || length < 0 || length > maximum || keys.length !== length + 1) return null;
    const copy = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      copy.push(descriptor.value);
    }
    return copy;
  } catch { return null; }
}
function failure(code) { return Object.freeze({ ok: false, code }); }
function freezeGraph(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeGraph(child);
    Object.freeze(value);
  }
  return value;
}
function clearMarkers(modelRevision) {
  return freezeGraph({ ok: true, markers: { state: 'clear', modelRevision, groups: [],
    counts: { markers: 0, located: 0, unlocated: 0, general: 0, omitted: 0 }, selectedOrdinal: null, reasons: [] } });
}
function parseVisibleOrdinals(value) {
  if (value === '') return [];
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]?|[1-4][0-9]{2})(?:,(?:0|[1-9][0-9]?|[1-4][0-9]{2}))*$/u.test(value)) return null;
  const parts = value.split(',');
  const values = parts.map(Number);
  for (let index = 0; index < values.length; index += 1) {
    if (String(values[index]) !== parts[index] || (index > 0 && values[index - 1] >= values[index])) return null;
  }
  return values;
}
function parseEnvelope(value) {
  const type = ownData(value, 'type');
  if (!TYPES.has(type)) return null;
  const extras = type === 'PANEL_SELECT_PAGE_MARKER' ? ['ordinal', 'scroll']
    : type === 'PANEL_FILTER_PAGE_MARKERS' ? ['visibleOrdinals'] : [];
  // A variante "página recarregada" tem o mesmo envelope do pedido original: quem aceita ou não é o
  // worker, contra a oferta de recolocação e o documento vivo, nunca o painel.
  const record = exactData(value, ['type', 'auditId', 'sessionCapabilityId', 'windowId', 'modelRevision', ...extras]);
  if (!record || !AUDIT_ID.test(record.auditId ?? '') || !INSTALLATION_ID.test(record.sessionCapabilityId ?? '') ||
    !Number.isSafeInteger(record.windowId) || record.windowId < 0 ||
    !Number.isSafeInteger(record.modelRevision) || record.modelRevision < 1) return null;
  if (type === 'PANEL_SELECT_PAGE_MARKER' && (!Number.isSafeInteger(record.ordinal) || record.ordinal < 0 ||
    record.ordinal >= MAX_PAGE_MARKER_TARGETS || typeof record.scroll !== 'boolean')) return null;
  if (type === 'PANEL_FILTER_PAGE_MARKERS') {
    record.ordinals = parseVisibleOrdinals(record.visibleOrdinals);
    if (!record.ordinals) return null;
  }
  return record;
}
function validProof(value) {
  const proof = exactData(value, ['tabId', 'windowId', 'documentId', 'urlSessionDigest']);
  return proof && Number.isSafeInteger(proof.tabId) && proof.tabId > 0 &&
    Number.isSafeInteger(proof.windowId) && proof.windowId >= 0 && DOCUMENT_ID.test(proof.documentId ?? '') &&
    DIGEST.test(proof.urlSessionDigest ?? '') ? proof : null;
}
function sameProof(proof, origin) {
  return proof && proof.tabId === origin.tabId && proof.windowId === origin.windowId &&
    proof.documentId === origin.documentId && proof.urlSessionDigest === origin.urlSessionDigest;
}
function provesDocumentAbsent(proof, origin) {
  return Boolean(proof && proof.documentId !== origin.documentId);
}
// Mesma aba, mesma janela, mesmo endereço (o digest de sessão cobre origem, caminho e consulta) e um
// documento novo: é exatamente o que uma recarga produz. Qualquer outra diferença é outra página.
function documentRelation(origin, proof) {
  if (!proof) return 'absent';
  if (proof.tabId !== origin.tabId || proof.windowId !== origin.windowId) return 'changed';
  if (proof.documentId === origin.documentId) return 'same';
  return proof.urlSessionDigest === origin.urlSessionDigest ? 'reloaded' : 'changed';
}

function inspectAuditaPageMarkersOwnership(installationId, environment = globalThis) {
  try {
    const validInstallationId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{22}$/u.test(value);
    const descriptor = Reflect.getOwnPropertyDescriptor(environment, '__auditaPageMarkersOverlayV1');
    if (!descriptor) return 'absent';
    if (!Object.hasOwn(descriptor, 'value') || descriptor.enumerable || !descriptor.configurable || descriptor.writable ||
      !descriptor.value || typeof descriptor.value !== 'object') return 'foreign';
    const state = descriptor.value;
    const version = Reflect.getOwnPropertyDescriptor(state, 'version');
    const installed = Reflect.getOwnPropertyDescriptor(state, 'installationId');
    const dispose = Reflect.getOwnPropertyDescriptor(state, 'dispose');
    const execute = Reflect.getOwnPropertyDescriptor(state, 'execute');
    if (![version, installed, dispose, execute].every(item => item && Object.hasOwn(item, 'value')) ||
      version.value !== 1 || typeof dispose.value !== 'function' || typeof execute.value !== 'function' ||
      !validInstallationId(installed.value)) return 'foreign';
    return installed.value === installationId ? 'own' : 'foreign';
  } catch { return 'unknown'; }
}

export function createPageMarkersController({ originCache, modelAuthority, loadPanelResultBundle, authority,
  chromeApi, chromeAdapter, targetQueue, now, createInstallationId, publish, setTimer, clearTimer,
  relocationOffers = null } = {}) {
  const getOrigin = ownCallable(originCache, 'get');
  const clearOriginAudit = ownCallable(originCache, 'clearAudit');
  const clearOriginTab = ownCallable(originCache, 'clearTab');
  const loadValidated = ownCallable(modelAuthority, 'loadValidated');
  const authorizeSession = ownCallable(authority, 'authorizeSession');
  const probeDocumentIdentity = ownCallable(chromeAdapter, 'probeDocumentIdentity');
  let internal = null;
  try {
    const descriptor = Reflect.getOwnPropertyDescriptor(chromeAdapter, AUDIT_EXECUTION_INTERNAL);
    internal = descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : null;
  } catch { internal = null; }
  const snapshotAttachedCopySource = ownCallable(internal, 'snapshotAttachedCopySource');
  const scripting = ownData(chromeApi, 'scripting');
  const executeScript = ownCallable(scripting, 'executeScript');
  const runtimeId = ownData(ownData(chromeApi, 'runtime'), 'id');
  const withTarget = ownCallable(targetQueue, 'withTarget');
  const assertHeld = ownCallable(targetQueue, 'assertHeld');
  if (!getOrigin || !clearOriginAudit || !clearOriginTab || !loadValidated || typeof loadPanelResultBundle !== 'function' ||
    !authorizeSession || !probeDocumentIdentity || !snapshotAttachedCopySource || !executeScript ||
    typeof runtimeId !== 'string' || !runtimeId || !withTarget || !assertHeld || typeof now !== 'function' ||
    typeof createInstallationId !== 'function' || typeof publish !== 'function' || typeof setTimer !== 'function' ||
    typeof clearTimer !== 'function') throw new TypeError('PAGE_MARKERS_CONTROLLER_INVALID');

  const records = new Map();
  const auditGenerations = new Map();
  const tabGenerations = new Map();
  const panelGenerations = new Map();
  let lastNow = null;
  function readNow() {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0 || (lastNow !== null && value < lastNow))
      throw new TypeError('PAGE_MARKERS_CONTROLLER_INVALID');
    lastNow = value; return value;
  }
  // A oferta de recolocação é memória de "mesmo endereço, documento novo" e nada mais. Sem uma
  // instância injetada, o controlador mantém a sua: recolocar continua exigindo que a tentativa
  // anterior tenha classificado o caso e que a segunda confirmação encontre o mesmo documento vivo.
  const offers = relocationOffers ?? createPageRelocationOfferStore({ now: () => readNow() });
  const registerOffer = ownCallable(offers, 'register');
  const acceptOffer = ownCallable(offers, 'accept');
  const clearOfferAudit = ownCallable(offers, 'clearAudit');
  const clearOfferTab = ownCallable(offers, 'clearTab');
  if (!registerOffer || !acceptOffer) throw new TypeError('PAGE_MARKERS_CONTROLLER_INVALID');
  function offerRelocation(request, origin, proof) {
    try {
      return Reflect.apply(registerOffer, offers, [Object.freeze({ auditId: request.auditId, tabId: origin.tabId,
        windowId: origin.windowId, documentId: proof.documentId, urlSessionDigest: proof.urlSessionDigest,
        scope: 'page-markers', expiresAt: origin.expiresAt })]) === true;
    } catch { return false; }
  }
  function relocationAccepted(request, origin, proof, liveDocumentId) {
    if (documentRelation(origin, proof) !== 'reloaded' || proof.documentId !== liveDocumentId) return false;
    try {
      return Reflect.apply(acceptOffer, offers, [Object.freeze({ auditId: request.auditId, tabId: origin.tabId,
        windowId: origin.windowId, documentId: liveDocumentId, scope: 'page-markers' })]) === true;
    } catch { return false; }
  }
  // Uma recarga sem oferta (ou com a oferta vencida) volta a oferecer: o painel mostra o mesmo
  // convite e a nova tentativa é a que decide. Endereço diferente continua sendo outra página.
  function changedFailure(request, origin, proof) {
    if (documentRelation(origin, proof) !== 'reloaded') return failure('PAGE_MARKERS_DOCUMENT_CHANGED');
    offerRelocation(request, origin, proof);
    return failure('PAGE_MARKERS_RELOADED_PAGE');
  }
  // O documento antigo sumiu de verdade (o mesmo tabId agora serve outro documento): não há o que
  // limpar na página nem o que anunciar ao painel, que é justamente quem está pedindo os sinais na
  // versão nova. Sem isto, o registro antigo ficaria como zumbi até o TTL.
  function retireAbsentRecords(request, tabId, liveDocumentId) {
    for (const [key, record] of [...records]) {
      if (record.tabId !== tabId || record.documentId === liveDocumentId) continue;
      if (record.auditId !== request.auditId || record.sessionCapabilityId !== request.sessionCapabilityId) continue;
      records.delete(key);
      cancelRecord(record);
    }
  }
  const targetKey = target => `${target.tabId}\u0000${target.documentId}`;
  const panelKey = (windowId, sessionCapabilityId) => `${windowId}\u0000${sessionCapabilityId}`;
  const generation = (map, key) => map.get(key) ?? 0;
  const advance = (map, key) => map.set(key, generation(map, key) + 1);
  function currentConnection(callback) { try { return Reflect.apply(callback, undefined, []) === true; } catch { return false; } }
  function captureGenerations(request, origin) {
    return Object.freeze({ audit: generation(auditGenerations, request.auditId),
      tab: origin ? generation(tabGenerations, origin.tabId) : 0,
      panel: generation(panelGenerations, panelKey(request.windowId, request.sessionCapabilityId)) });
  }
  function generationsCurrent(request, origin, captured) {
    return generation(auditGenerations, request.auditId) === captured.audit &&
      (!origin || generation(tabGenerations, origin.tabId) === captured.tab) &&
      generation(panelGenerations, panelKey(request.windowId, request.sessionCapabilityId)) === captured.panel;
  }
  async function authorized(request, sender, panelWindowId) {
    try {
      const result = await Reflect.apply(authorizeSession, authority, [{ sessionCapabilityId: request.sessionCapabilityId,
        auditId: request.auditId, consumer: 'panel', intent: 'review-markers', sender, claimedWindowId: panelWindowId }]);
      const session = ownData(result, 'session'); const context = ownData(result, 'context');
      const binding = ownData(session, 'targetBinding'); const expiresAt = ownData(session, 'expiresAt');
      const mode = ownData(session, 'mode');
      if (ownData(result, 'ok') !== true || ownData(session, 'auditId') !== request.auditId ||
        ownData(session, 'sessionCapabilityId') !== request.sessionCapabilityId ||
        ownData(session, 'windowId') !== request.windowId || ownData(context, 'windowId') !== request.windowId ||
        !['result', 'view-only'].includes(ownData(session, 'state')) || typeof mode !== 'string' || !mode || mode === 'batch' ||
        !binding || typeof binding !== 'object' || ownData(binding, 'kind') === 'batch' ||
        !Number.isSafeInteger(expiresAt) || expiresAt <= readNow()) return null;
      return { session, expiresAt };
    } catch { return null; }
  }
  async function executeInDocument(record, func, argument) {
    const results = denseArray(await Reflect.apply(executeScript, scripting, [{
      target: { tabId: record.tabId, documentIds: [record.documentId] }, world: 'ISOLATED', func, args: [argument] }]), 1);
    if (!results || results.length !== 1) return null;
    const wrapper = exactData(results[0], ['frameId', 'documentId', 'result']);
    return wrapper && wrapper.frameId === 0 && wrapper.documentId === record.documentId ? wrapper.result : null;
  }
  function exactSuccess(value) { return exactData(value, ['ok'])?.ok === true; }
  function detachPort(record, disconnect = true) {
    const binding = record.portBinding; if (!binding) return; record.portBinding = null;
    try { binding.port.onMessage.removeListener(binding.onMessage); } catch {}
    try { binding.port.onDisconnect.removeListener(binding.onDisconnect); } catch {}
    if (disconnect) try { binding.port.disconnect(); } catch {}
  }
  function cancelRecord(record) {
    record.cancelled = true;
    if (record.helloResolve) { const resolve = record.helloResolve; record.helloResolve = null; resolve(false); }
    if (record.helloTimer !== null) { try { clearTimer(record.helloTimer); } catch {} record.helloTimer = null; }
    if (record.expiryTimer !== null) { try { clearTimer(record.expiryTimer); } catch {} record.expiryTimer = null; }
    detachPort(record);
  }
  async function safelyPublish(record, state, selectedOrdinal) {
    if (!currentConnection(record.isCurrent)) return;
    try { await publish({ windowId: record.windowId, sessionCapabilityId: record.sessionCapabilityId,
      auditId: record.auditId, modelRevision: record.modelRevision, state, selectedOrdinal }); } catch {}
  }
  async function finalizeCleanup(record, state) {
    if (records.get(targetKey(record)) === record) records.delete(targetKey(record));
    cancelRecord(record);
    if (record.publishedActive && !record.publishedClear) { record.publishedClear = true; await safelyPublish(record, 'clear', null); }
    return Object.freeze({ ok: true, state });
  }
  async function cleanupLocked(record, lock, knownAbsent = false) {
    const target = Object.freeze({ tabId: record.tabId, documentId: record.documentId });
    Reflect.apply(assertHeld, targetQueue, [lock, target]); cancelRecord(record);
    if (knownAbsent) return finalizeCleanup(record, 'absent');
    try {
      const proof = validProof(await Reflect.apply(probeDocumentIdentity, chromeAdapter, [record.tabId]));
      if (provesDocumentAbsent(proof, record)) return finalizeCleanup(record, 'absent');
    } catch {}
    let cleared = null;
    try { cleared = await executeInDocument(record, runAuditaPageMarkersCommand,
      Object.freeze({ version: 1, op: 'clear', installationId: record.installationId })); } catch {}
    if (exactSuccess(cleared)) return finalizeCleanup(record, 'clear');
    let ownership = 'unknown';
    try { ownership = await executeInDocument(record, inspectAuditaPageMarkersOwnership, record.installationId); } catch {}
    if (ownership === 'absent' || ownership === 'foreign') return finalizeCleanup(record, 'absent');
    return failure('PAGE_MARKERS_CLEANUP_UNCONFIRMED');
  }
  function scheduleCleanup(record, knownAbsent = false) {
    cancelRecord(record);
    const target = Object.freeze({ tabId: record.tabId, documentId: record.documentId });
    void Reflect.apply(withTarget, targetQueue, [target, lock => cleanupLocked(record, lock, knownAbsent)]).catch(() => {});
  }
  function senderMatches(record, sender) {
    const tab = ownData(sender, 'tab');
    return ownData(sender, 'id') === runtimeId && ownData(tab, 'id') === record.tabId &&
      ownData(tab, 'windowId') === record.windowId && ownData(sender, 'documentId') === record.documentId &&
      ownData(sender, 'frameId') === 0;
  }
  function recordForInstallation(installationId) {
    for (const record of records.values()) if (record.installationId === installationId) return record;
    return null;
  }
  function attachPort(port) {
    let record = null;
    for (const candidate of records.values()) {
      if (!candidate.cancelled && !candidate.portBinding && ownData(port, 'name') === 'audita-page-markers-v1' &&
        senderMatches(candidate, ownData(port, 'sender'))) { record = candidate; break; }
    }
    const onMessageHook = ownData(port, 'onMessage'); const onDisconnectHook = ownData(port, 'onDisconnect');
    if (!record || typeof onMessageHook?.addListener !== 'function' || typeof onMessageHook?.removeListener !== 'function' ||
      typeof onDisconnectHook?.addListener !== 'function' || typeof onDisconnectHook?.removeListener !== 'function' ||
      typeof ownData(port, 'disconnect') !== 'function') return false;
    const onMessage = message => {
      const type = ownData(message, 'type'); const parsed = exactData(message, ['type', 'installationId']);
      if (!parsed || !['AUDITA_PAGE_MARKERS_HELLO', 'AUDITA_PAGE_MARKERS_PING'].includes(type) ||
        parsed.installationId !== record.installationId || record.cancelled || readNow() >= record.expiresAt) {
        scheduleCleanup(record); return;
      }
      if (type === 'AUDITA_PAGE_MARKERS_HELLO' && record.state === 'installing' && record.helloResolve) {
        const resolve = record.helloResolve; record.helloResolve = null;
        if (record.helloTimer !== null) { try { clearTimer(record.helloTimer); } catch {} record.helloTimer = null; }
        resolve(true);
      }
    };
    const onDisconnect = () => scheduleCleanup(record);
    try {
      onMessageHook.addListener(onMessage); onDisconnectHook.addListener(onDisconnect);
      record.portBinding = { port, onMessage, onDisconnect }; return true;
    } catch { detachPort(record, false); return false; }
  }
  function parseInstallResult(value, targets) {
    const result = exactData(value, ['ok', 'locatedMarkerIds', 'unlocated']);
    const located = result && denseArray(result.locatedMarkerIds, MAX_PAGE_MARKER_TARGETS);
    const unlocated = result && denseArray(result.unlocated, MAX_PAGE_MARKER_TARGETS);
    if (!result || result.ok !== true || !located || !unlocated || located.some(id => typeof id !== 'string') ||
      new Set(located).size !== located.length) return null;
    const unlocatedReasons = new Map();
    for (const value of unlocated) { const row = exactData(value, ['markerId', 'reason']);
      if (!row || typeof row.markerId !== 'string' || typeof row.reason !== 'string' ||
        unlocatedReasons.has(row.markerId)) return null; unlocatedReasons.set(row.markerId, row.reason); }
    const expected = targets.map(target => target.markerId).sort();
    const partition = [...located, ...unlocatedReasons.keys()].sort();
    if (partition.length !== expected.length || partition.some((id, index) => id !== expected[index]) ||
      new Set(partition).size !== partition.length) return null;
    return { located: new Set(located), unlocated: unlocatedReasons };
  }
  function captureBundle(bundle, snapshot) {
    const root = exactData(bundle, ['version', 'auditId', 'modelRevision', 'modelHash', 'summary', 'details']);
    const details = root && denseArray(root.details);
    if (!root || root.version !== 1 || root.auditId !== snapshot.model.auditId || root.modelRevision !== snapshot.modelRevision ||
      root.modelHash !== snapshot.modelHash || !details) return null;
    const occurrenceIds = [];
    for (const value of details.slice(0, MAX_PAGE_MARKER_TARGETS)) { const occurrenceId = ownData(value, 'occurrenceId');
      if (typeof occurrenceId !== 'string' || !occurrenceId || occurrenceIds.includes(occurrenceId)) return null;
      occurrenceIds.push(occurrenceId); }
    return { occurrenceIds, totalDetails: details.length };
  }
  // The three match shapes the projection emits, copied field by field so nothing extra reaches
  // the page and the page's own exact-key validation keeps working.
  // Chrome serializes injected arguments as JSON and drops null values, so the structural shape
  // travels without the fields the page did not record.
  function wireMatch(match) {
    if (Object.hasOwn(match, 'attribute')) {
      return { tag: match.tag, attribute: { name: match.attribute.name, value: match.attribute.value } };
    }
    if (!Object.hasOwn(match, 'path')) return { tag: match.tag, id: match.id };
    const wired = { tag: match.tag, classes: [...match.classes], path: match.path };
    for (const field of ['id', 'role', 'type']) {
      if (match[field] !== null) wired[field] = match[field];
    }
    return wired;
  }
  function buildPlan(snapshot, bundle) {
    if (snapshot.model.requestedScope?.mode !== 'single' ||
      !Array.isArray(snapshot.model.pages) || snapshot.model.pages.length !== 1) return null;
    const page = snapshot.model.pages[0]; const projection = projectPageMarkers({ snapshot, pageId: page.pageId });
    const signalByOccurrence = new Map(projection.private.signals.map(signal => [signal.occurrenceId, signal]));
    const selectionToOrdinal = new Map(); const ordinalToSelection = new Map();
    bundle.occurrenceIds.forEach((occurrenceId, ordinal) => { const signal = signalByOccurrence.get(occurrenceId);
      if (signal) { selectionToOrdinal.set(signal.selectionId, ordinal); ordinalToSelection.set(ordinal, signal.selectionId); } });
    const generalSelections = new Set(projection.public.general.map(row => row.selectionId).filter(id => selectionToOrdinal.has(id)));
    const unlocatedReasons = new Map();
    for (const row of projection.public.unlocated) {
      if (selectionToOrdinal.has(row.selectionId)) unlocatedReasons.set(row.selectionId, row.reason);
    }
    const markerNumbers = new Map(projection.public.markers.map(marker => [marker.markerId, marker.number]));
    const grouped = new Map();
    for (const candidate of projection.private.candidates) {
      const signals = candidate.selectionIds.map(id => projection.private.signals.find(row => row.selectionId === id))
        .filter(signal => signal && selectionToOrdinal.has(signal.selectionId));
      if (!signals.length) continue;
      const key = JSON.stringify(candidate.match);
      if (!grouped.has(key)) grouped.set(key, { markerId: candidate.markerId, number: markerNumbers.get(candidate.markerId),
        match: candidate.match, corroboration: candidate.corroboration ?? null, signals: [] });
      grouped.get(key).signals.push(...signals.map(signal => ({ selectionId: signal.selectionId, classification: signal.classification })));
    }
    const targets = [...grouped.values()]; const markerSelections = new Set(targets.flatMap(t => t.signals.map(s => s.selectionId)));
    for (const selectionId of ordinalToSelection.values())
      if (!generalSelections.has(selectionId) && !markerSelections.has(selectionId) && !unlocatedReasons.has(selectionId)) {
        unlocatedReasons.set(selectionId, 'unresolved');
      }
    const explicitlyUnlocated = new Set(unlocatedReasons.keys());
    const decisions = new Map(snapshot.model.reviewDecisions.map(row => [row.occurrenceId, row]));
    const rules = new Map(snapshot.model.ruleResults.map(row => [JSON.stringify([row.source.engine, row.source.ruleId]), row]));
    // "Não se aplica" encerra a pergunta sem achado: não conta como ocorrência omitida dos sinais.
    const findings = snapshot.model.occurrences.filter(row => decisions.get(row.occurrenceId)?.answer !== 'não se aplica' &&
      findingKind(row, rules.get(JSON.stringify([row.source.engine, row.source.ruleId])), decisions.get(row.occurrenceId)) !== 'checklist');
    return { page, targets, ordinalToSelection, selectionToOrdinal, generalSelections, explicitlyUnlocated,
      unlocatedReasons, markerSelections,
      offered: ordinalToSelection.size, omitted: findings.filter(row => !bundle.occurrenceIds.includes(row.occurrenceId)).length };
  }
  function activeResult(record) {
    return freezeGraph({ ok: true, markers: { state: 'active', modelRevision: record.modelRevision,
      groups: record.groups.map(group => ({ number: group.number, ordinals: [...group.ordinals] })),
      counts: { ...record.counts }, selectedOrdinal: record.selectedOrdinal,
      reasons: record.reasons.map(row => ({ ...row })) } });
  }
  // Plain-language reason for a signal that did not appear, in the vocabulary the panel shows.
  function reasonGroups(plan, installed) {
    const counts = new Map();
    const add = (selectionId, reason) => {
      if (!plan.selectionToOrdinal.has(selectionId)) return;
      counts.set(reason, (counts.get(reason) ?? 0) + 1);
    };
    for (const [selectionId, reason] of plan.unlocatedReasons) add(selectionId, reason);
    for (const row of plan.targets) {
      const reason = installed.unlocated.get(row.markerId);
      if (!reason) continue;
      for (const signal of row.signals) add(signal.selectionId, reason);
    }
    return [...counts.entries()].map(([reason, count]) => ({ reason, count }))
      .sort((left, right) => left.reason.localeCompare(right.reason));
  }

  async function show(request, sender, panelWindowId, isCurrent, originBefore, captured) {
    const reloadMode = request.type === 'PANEL_SHOW_PAGE_MARKERS_RELOADED';
    const firstAuthorization = await authorized(request, sender, panelWindowId);
    if (!firstAuthorization) return failure('PAGE_MARKERS_NOT_AUTHORIZED');
    if (!currentConnection(isCurrent) || !generationsCurrent(request, originBefore, captured))
      return failure('PAGE_MARKERS_UNAVAILABLE');
    const origin = Reflect.apply(getOrigin, originCache, [request.auditId]);
    if (!origin || !originBefore || !sameProof(origin, originBefore) || origin.expiresAt <= readNow())
      return failure('PAGE_MARKERS_UNAVAILABLE');
    // Alvo da operação é o documento vivo. No modo recarregado ele é outro documento da mesma aba e
    // do mesmo endereço; no modo normal continua sendo o documento auditado.
    let liveDocumentId = origin.documentId;
    if (reloadMode) {
      let preProof = null;
      try { preProof = validProof(await Reflect.apply(probeDocumentIdentity, chromeAdapter, [origin.tabId])); } catch {}
      const relation = documentRelation(origin, preProof);
      if (relation === 'changed' || relation === 'absent') return changedFailure(request, origin, preProof);
      if (relation === 'reloaded') liveDocumentId = preProof.documentId;
    }
    const target = Object.freeze({ tabId: origin.tabId, documentId: liveDocumentId });
    try {
      return await Reflect.apply(withTarget, targetQueue, [target, async lock => {
        Reflect.apply(assertHeld, targetQueue, [lock, target]);
        if (!currentConnection(isCurrent) || !generationsCurrent(request, origin, captured))
          return failure('PAGE_MARKERS_UNAVAILABLE');
        const currentOrigin = Reflect.apply(getOrigin, originCache, [request.auditId]);
        if (!currentOrigin || !sameProof(currentOrigin, origin) || currentOrigin.expiresAt <= readNow())
          return failure('PAGE_MARKERS_UNAVAILABLE');
        const prior = records.get(targetKey(target));
        if (prior) {
          if (prior.cancelled) return failure('PAGE_MARKERS_CLEANUP_UNCONFIRMED');
          return prior.auditId === request.auditId && prior.sessionCapabilityId === request.sessionCapabilityId &&
            prior.windowId === request.windowId && prior.modelRevision === request.modelRevision && prior.state === 'active'
            ? activeResult(prior) : failure('PAGE_MARKERS_UNAVAILABLE');
        }
        let snapshot; let rawBundle;
        try {
          [snapshot, rawBundle] = await Promise.all([
            Reflect.apply(loadValidated, modelAuthority, [{ auditId: request.auditId }]),
            loadPanelResultBundle({ auditId: request.auditId }),
          ]);
        } catch { return failure('PAGE_MARKERS_STALE_RESULT'); }
        if (!currentConnection(isCurrent) || !generationsCurrent(request, origin, captured))
          return failure('PAGE_MARKERS_UNAVAILABLE');
        if (!snapshot || snapshot.modelRevision !== request.modelRevision || snapshot.model?.auditId !== request.auditId ||
          !HASH.test(snapshot.modelHash ?? '') || snapshot.modelHash !== snapshot.model.integrity?.canonicalModelHash)
          return failure('PAGE_MARKERS_STALE_RESULT');
        const bundle = captureBundle(rawBundle, snapshot);
        if (!bundle) return failure('PAGE_MARKERS_STALE_RESULT');
        let plan;
        try { plan = buildPlan(snapshot, bundle); } catch { return failure('PAGE_MARKERS_STALE_RESULT'); }
        if (!plan) return failure('PAGE_MARKERS_UNAVAILABLE');
        let proof = null;
        try { proof = validProof(await Reflect.apply(probeDocumentIdentity, chromeAdapter, [origin.tabId])); } catch {}
        const relation = documentRelation(origin, proof);
        let relocated = false;
        if (relation === 'reloaded') {
          // Recolocar exige o convite do painel e a oferta registrada por uma tentativa anterior,
          // sempre contra o documento que estiver vivo agora.
          if (!reloadMode || !relocationAccepted(request, origin, proof, liveDocumentId))
            return changedFailure(request, origin, proof);
          relocated = true;
        } else if (relation !== 'same') {
          return changedFailure(request, origin, proof);
        } else if (liveDocumentId !== origin.documentId) {
          // A pré-checagem viu um documento novo e o vivo voltou a ser o auditado: nenhum dos dois
          // alvos serve sem uma nova decisão do usuário.
          return changedFailure(request, origin, proof);
        }
        // A prova viva que governa todo o resto do fluxo: o documento auditado no modo normal, o
        // documento recarregado no modo explícito.
        const reference = relocated ? proof : origin;
        let source; let sanitizedSource;
        try {
          source = exactData(await Reflect.apply(snapshotAttachedCopySource, internal, [Object.freeze({ ...proof })]),
            ['version', 'tabId', 'windowId', 'documentId', 'urlSessionDigest', 'rawUrl']);
          if (!source || source.version !== 'AttachedCopySourceV1' || !sameProof(source, reference)) throw new Error('source');
          const rawUrl = source.rawUrl;
          sanitizedSource = sanitizeEvidenceUrlV1(rawUrl, { includeQuery: false }).href;
          source = null;
        } catch { source = null; return changedFailure(request, origin, proof); }
        if (sanitizedSource !== plan.page.finalUrl) return changedFailure(request, origin, proof);
        const secondAuthorization = await authorized(request, sender, panelWindowId);
        if (!secondAuthorization || !currentConnection(isCurrent) || !generationsCurrent(request, origin, captured))
          return failure('PAGE_MARKERS_NOT_AUTHORIZED');
        let effectProof;
        try { effectProof = validProof(await Reflect.apply(probeDocumentIdentity, chromeAdapter, [origin.tabId])); } catch {}
        if (!currentConnection(isCurrent) || !generationsCurrent(request, origin, captured))
          return failure('PAGE_MARKERS_UNAVAILABLE');
        if (!sameProof(effectProof, reference)) return changedFailure(request, origin, effectProof);
        const startedAt = readNow();
        const expiresAt = Math.min(origin.expiresAt, firstAuthorization.expiresAt, secondAuthorization.expiresAt);
        const ttlMs = Math.min(1_800_000, expiresAt - startedAt);
        if (ttlMs < 1) return failure('PAGE_MARKERS_UNAVAILABLE');
        const installationId = createInstallationId();
        if (!INSTALLATION_ID.test(installationId ?? '')) return failure('PAGE_MARKERS_UNAVAILABLE');
        if (relocated) retireAbsentRecords(request, target.tabId, reference.documentId);
        const record = { installationId, auditId: request.auditId, sessionCapabilityId: request.sessionCapabilityId,
          windowId: origin.windowId, tabId: origin.tabId, documentId: reference.documentId,
          urlSessionDigest: reference.urlSessionDigest, relocated, modelRevision: snapshot.modelRevision, expiresAt,
          state: 'installing', cancelled: false, isCurrent, helloResolve: null, helloTimer: null,
          expiryTimer: null, portBinding: null, selectedOrdinal: null, groups: [], counts: null, reasons: [],
          ordinalToSelection: plan.ordinalToSelection, selectionToOrdinal: plan.selectionToOrdinal,
          markerSelections: plan.markerSelections, publishedActive: false, publishedClear: false };
        records.set(targetKey(record), record);
        const hello = new Promise(resolve => {
          record.helloResolve = resolve;
          record.helloTimer = setTimer(() => {
            record.helloTimer = null;
            if (record.helloResolve) { const finish = record.helloResolve; record.helloResolve = null;
              cancelRecord(record); finish(false); }
          }, 5_000);
        });
        // A corroboração só viaja na recolocação: cada sinal só é desenhado se o elemento
        // reencontrado pelo mesmo locator estrito ainda trouxer o nome acessível ou o texto
        // registrados na auditoria. No modo normal o documento é o mesmo, e nada é acrescentado.
        const installCommand = freezeGraph({ version: 1, op: 'install', installationId, ttlMs,
          targets: plan.targets.map(row => ({ markerId: row.markerId, number: row.number,
            match: wireMatch(row.match),
            ...(relocated && row.corroboration ? { corroboration: { ...row.corroboration } } : {}),
            signals: row.signals.map(signal => ({ ...signal })) })) });
        let installed;
        try { installed = parseInstallResult(await executeInDocument(record, runAuditaPageMarkersCommand, installCommand), plan.targets); }
        catch { installed = null; }
        if (record.cancelled || !currentConnection(isCurrent) || !generationsCurrent(request, origin, captured) ||
          readNow() >= expiresAt) {
          const cleaned = await cleanupLocked(record, lock);
          return cleaned.ok ? failure('PAGE_MARKERS_UNAVAILABLE') : cleaned;
        }
        if (!installed) {
          const cleaned = await cleanupLocked(record, lock);
          return cleaned.ok ? failure('PAGE_MARKERS_UNAVAILABLE') : cleaned;
        }
        let bound = false;
        try { bound = exactSuccess(await executeInDocument(record, bindAuditaPageMarkersPort, installationId)); } catch {}
        if (!bound || !await hello) {
          const cleaned = await cleanupLocked(record, lock);
          return cleaned.ok ? failure('PAGE_MARKERS_UNAVAILABLE') : cleaned;
        }
        let finalProof;
        try { finalProof = validProof(await Reflect.apply(probeDocumentIdentity, chromeAdapter, [origin.tabId])); } catch {}
        if (!sameProof(finalProof, reference)) {
          await cleanupLocked(record, lock, provesDocumentAbsent(finalProof, record));
          return changedFailure(request, origin, finalProof);
        }
        const finalAuthorization = await authorized(request, sender, panelWindowId);
        if (!finalAuthorization || !currentConnection(isCurrent) || !generationsCurrent(request, origin, captured) ||
          readNow() >= expiresAt || record.cancelled) {
          const cleaned = await cleanupLocked(record, lock);
          return cleaned.ok ? failure('PAGE_MARKERS_NOT_AUTHORIZED') : cleaned;
        }
        const groups = []; let located = 0;
        for (const row of plan.targets) {
          if (!installed.located.has(row.markerId)) continue;
          const ordinals = row.signals.map(signal => plan.selectionToOrdinal.get(signal.selectionId))
            .filter(Number.isSafeInteger).sort((a, b) => a - b);
          groups.push({ number: row.number, ordinals }); located += ordinals.length;
        }
        record.groups = groups;
        record.counts = { markers: groups.length, located,
          unlocated: plan.offered - plan.generalSelections.size - located,
          general: plan.generalSelections.size, omitted: plan.omitted };
        record.reasons = reasonGroups(plan, installed);
        record.state = 'active';
        record.expiryTimer = setTimer(() => scheduleCleanup(record), Math.max(1, expiresAt - readNow()));
        record.publishedActive = true;
        await safelyPublish(record, 'active', null);
        return activeResult(record);
      }]);
    } catch { return failure('PAGE_MARKERS_UNAVAILABLE'); }
  }

  // Depois de uma recarga aceita, o registro vivo está no documento novo: a chave do cache de
  // origem (o documento auditado) não o encontra, e a busca pela sessão é o que garante que
  // "selecionar", "filtrar" e "remover sinais" alcancem a instalação que está de fato na página.
  function liveRecord(request, originBefore) {
    const byOrigin = originBefore ? records.get(targetKey(originBefore)) : null;
    if (byOrigin) return byOrigin;
    return [...records.values()].find(candidate => candidate.auditId === request.auditId &&
      candidate.sessionCapabilityId === request.sessionCapabilityId &&
      candidate.windowId === request.windowId) ?? null;
  }

  async function mutate(request, sender, panelWindowId, isCurrent, originBefore, captured) {
    const auth = await authorized(request, sender, panelWindowId);
    if (!auth) return failure('PAGE_MARKERS_NOT_AUTHORIZED');
    if (!originBefore || !currentConnection(isCurrent) || !generationsCurrent(request, originBefore, captured))
      return failure('PAGE_MARKERS_UNAVAILABLE');
    const record = liveRecord(request, originBefore);
    if (!record || record.cancelled || record.state !== 'active' || record.auditId !== request.auditId ||
      record.sessionCapabilityId !== request.sessionCapabilityId || record.windowId !== request.windowId ||
      record.modelRevision !== request.modelRevision) return failure('PAGE_MARKERS_UNAVAILABLE');
    const target = Object.freeze({ tabId: record.tabId, documentId: record.documentId });
    return Reflect.apply(withTarget, targetQueue, [target, async lock => {
      Reflect.apply(assertHeld, targetQueue, [lock, target]);
      if (records.get(targetKey(record)) !== record || record.cancelled || !currentConnection(isCurrent) ||
        !generationsCurrent(request, originBefore, captured)) return failure('PAGE_MARKERS_UNAVAILABLE');
      let proof;
      try { proof = validProof(await Reflect.apply(probeDocumentIdentity, chromeAdapter, [record.tabId])); } catch {}
      if (!sameProof(proof, record)) {
        await cleanupLocked(record, lock, provesDocumentAbsent(proof, record));
        return failure('PAGE_MARKERS_DOCUMENT_CHANGED');
      }
      const secondAuth = await authorized(request, sender, panelWindowId);
      if (!secondAuth || record.cancelled || !currentConnection(isCurrent) ||
        !generationsCurrent(request, originBefore, captured)) return failure('PAGE_MARKERS_NOT_AUTHORIZED');
      let command;
      if (request.type === 'PANEL_SELECT_PAGE_MARKER') {
        const selectionId = record.ordinalToSelection.get(request.ordinal);
        if (!selectionId) return failure('PAGE_MARKERS_INVALID');
        command = { version: 1, op: 'select', installationId: record.installationId, selectionId, scroll: request.scroll };
      } else {
        if (request.ordinals.some(ordinal => !record.ordinalToSelection.has(ordinal))) return failure('PAGE_MARKERS_INVALID');
        command = { version: 1, op: 'filter', installationId: record.installationId,
          selectionIds: request.ordinals.map(ordinal => record.ordinalToSelection.get(ordinal))
            .filter(selectionId => record.markerSelections.has(selectionId)) };
      }
      let effect;
      try { effect = await executeInDocument(record, runAuditaPageMarkersCommand, freezeGraph(command)); } catch { effect = null; }
      const success = exactData(effect, ['ok']);
      let selectionUnavailable = false;
      if (success?.ok !== true) {
        const unavailable = exactData(effect, ['ok', 'reason']);
        selectionUnavailable = request.type === 'PANEL_SELECT_PAGE_MARKER' && unavailable?.ok === false &&
          unavailable.reason === 'selection-unavailable';
        if (!selectionUnavailable) return failure('PAGE_MARKERS_UNAVAILABLE');
      }
      let finalProof;
      try { finalProof = validProof(await Reflect.apply(probeDocumentIdentity, chromeAdapter, [record.tabId])); } catch {}
      if (!sameProof(finalProof, record)) {
        await cleanupLocked(record, lock, provesDocumentAbsent(finalProof, record));
        return failure('PAGE_MARKERS_DOCUMENT_CHANGED');
      }
      if (record.cancelled || !currentConnection(isCurrent) || !generationsCurrent(request, originBefore, captured))
        return failure('PAGE_MARKERS_UNAVAILABLE');
      if (selectionUnavailable) {
        record.selectedOrdinal = null;
        await safelyPublish(record, 'active', null);
        return failure('PAGE_MARKERS_SELECTION_UNAVAILABLE');
      }
      if (request.type === 'PANEL_SELECT_PAGE_MARKER') record.selectedOrdinal = request.ordinal;
      else if (record.selectedOrdinal !== null && !request.ordinals.includes(record.selectedOrdinal)) record.selectedOrdinal = null;
      await safelyPublish(record, 'active', record.selectedOrdinal);
      return activeResult(record);
    }]).catch(() => failure('PAGE_MARKERS_UNAVAILABLE'));
  }

  async function hide(request, sender, panelWindowId, isCurrent, originBefore, captured) {
    const auth = await authorized(request, sender, panelWindowId);
    if (!auth) return failure('PAGE_MARKERS_NOT_AUTHORIZED');
    if (!currentConnection(isCurrent) || !generationsCurrent(request, originBefore, captured))
      return failure('PAGE_MARKERS_UNAVAILABLE');
    const record = liveRecord(request, originBefore);
    if (!record) return clearMarkers(request.modelRevision);
    if (record.auditId !== request.auditId || record.sessionCapabilityId !== request.sessionCapabilityId ||
      record.windowId !== request.windowId || record.modelRevision !== request.modelRevision)
      return failure('PAGE_MARKERS_NOT_AUTHORIZED');
    const target = Object.freeze({ tabId: record.tabId, documentId: record.documentId });
    const result = await Reflect.apply(withTarget, targetQueue, [target, lock => cleanupLocked(record, lock)])
      .catch(() => failure('PAGE_MARKERS_CLEANUP_UNCONFIRMED'));
    return result.ok ? clearMarkers(request.modelRevision) : result;
  }
  async function dispatch(raw) {
    const input = exactData(raw, ['envelope', 'sender', 'panelWindowId', 'isCurrent']);
    const request = input && parseEnvelope(input.envelope);
    if (!input || !request || request.windowId !== input.panelWindowId || typeof input.isCurrent !== 'function')
      return failure('PAGE_MARKERS_INVALID');
    const originBefore = Reflect.apply(getOrigin, originCache, [request.auditId]);
    if (originBefore && ['PANEL_SHOW_PAGE_MARKERS', 'PANEL_SHOW_PAGE_MARKERS_RELOADED', 'PANEL_HIDE_PAGE_MARKERS']
      .includes(request.type)) advance(tabGenerations, originBefore.tabId);
    const captured = captureGenerations(request, originBefore);
    if (!currentConnection(input.isCurrent)) return failure('PAGE_MARKERS_NOT_AUTHORIZED');
    if (['PANEL_SHOW_PAGE_MARKERS', 'PANEL_SHOW_PAGE_MARKERS_RELOADED'].includes(request.type))
      return show(request, input.sender, input.panelWindowId, input.isCurrent, originBefore, captured);
    if (request.type === 'PANEL_HIDE_PAGE_MARKERS')
      return hide(request, input.sender, input.panelWindowId, input.isCurrent, originBefore, captured);
    return mutate(request, input.sender, input.panelWindowId, input.isCurrent, originBefore, captured);
  }
  function handleRuntimeMessage(message, sender) {
    const type = ownData(message, 'type');
    const fields = type === 'AUDITA_PAGE_MARKER_SELECTED' ? ['type', 'installationId', 'selectionId']
      : type === 'AUDITA_PAGE_MARKERS_CLEARED' ? ['type', 'installationId'] : [];
    const parsed = fields.length ? exactData(message, fields) : null;
    const record = parsed && recordForInstallation(parsed.installationId);
    if (!record || record.cancelled || record.state !== 'active' || !senderMatches(record, sender) ||
      !currentConnection(record.isCurrent)) return false;
    if (type === 'AUDITA_PAGE_MARKER_SELECTED') {
      const ordinal = record.selectionToOrdinal.get(parsed.selectionId);
      if (!Number.isSafeInteger(ordinal) || !record.markerSelections.has(parsed.selectionId)) return false;
      record.selectedOrdinal = ordinal;
      void safelyPublish(record, 'active', ordinal);
      return true;
    }
    scheduleCleanup(record, true);
    return true;
  }
  async function clearMatching(predicate) {
    const selected = [...records.values()].filter(predicate);
    let ok = true;
    for (const record of selected) cancelRecord(record);
    for (const record of selected) {
      const target = Object.freeze({ tabId: record.tabId, documentId: record.documentId });
      const result = await Reflect.apply(withTarget, targetQueue, [target, lock => cleanupLocked(record, lock)])
        .catch(() => failure('PAGE_MARKERS_CLEANUP_UNCONFIRMED'));
      if (!result.ok) ok = false;
    }
    return ok;
  }
  async function clearAudit(auditId) {
    if (!AUDIT_ID.test(auditId ?? '')) return false;
    advance(auditGenerations, auditId);
    try { Reflect.apply(clearOriginAudit, originCache, [auditId]); } catch {}
    if (clearOfferAudit) { try { Reflect.apply(clearOfferAudit, offers, [auditId]); } catch {} }
    return clearMatching(record => record.auditId === auditId);
  }
  // A aba navegou: o que estava desenhado na página foi embora com o documento antigo, então os
  // sinais e o convite são retirados. A procedência da auditoria (a que endereço e a que documento
  // ela pertence) fica, porque é ela que permite ao painel oferecer a versão recarregada em vez de
  // um erro; todo uso dela volta a ser conferido contra o documento vivo, e a recarga ainda exige o
  // gesto do leitor. Quando a aba realmente sai (fechada, descartada) a procedência vai junto.
  async function invalidateTab(tabId, reason = null) {
    if (!Number.isSafeInteger(tabId) || tabId <= 0 ||
      (reason !== null && !INVALIDATION_REASONS.includes(reason))) return false;
    advance(tabGenerations, tabId);
    if (reason !== 'navigation') { try { Reflect.apply(clearOriginTab, originCache, [tabId]); } catch {} }
    if (clearOfferTab) { try { Reflect.apply(clearOfferTab, offers, [tabId]); } catch {} }
    return clearMatching(record => record.tabId === tabId);
  }
  async function closePanel(raw) {
    const input = exactData(raw, ['windowId', 'sessionCapabilityId']);
    if (!input || !Number.isSafeInteger(input.windowId) || input.windowId < 0 ||
      !INSTALLATION_ID.test(input.sessionCapabilityId ?? '')) return false;
    advance(panelGenerations, panelKey(input.windowId, input.sessionCapabilityId));
    return clearMatching(record => record.windowId === input.windowId && record.sessionCapabilityId === input.sessionCapabilityId);
  }
  async function clearForTargetLocked(rawTarget, reason, lock) {
    const target = exactData(rawTarget, ['tabId', 'documentId']);
    if (!target || !Number.isSafeInteger(target.tabId) || target.tabId <= 0 || !DOCUMENT_ID.test(target.documentId ?? '') ||
      typeof reason !== 'string' || reason.length < 1 || reason.length > 100) throw new TypeError('PAGE_MARKERS_INVALID');
    Reflect.apply(assertHeld, targetQueue, [lock, target]);
    advance(tabGenerations, target.tabId);
    const record = records.get(targetKey(target));
    if (!record) return Object.freeze({ ok: true, state: 'absent' });
    cancelRecord(record);
    return cleanupLocked(record, lock);
  }
  return Object.freeze({ dispatch, attachPort, handleRuntimeMessage, clearAudit, invalidateTab, closePanel, clearForTargetLocked });
}
