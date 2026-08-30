import { createInstalledCoreRuleInventory } from '../core/rules/core-rule-inventory.js';
import { createSessionUrlDigestManager } from '../core/privacy/session-url-digest.js';
import { createAuditDeletedEvent } from '../core/audit-deleted-event.js';
import { createPanelResultBundleV1 } from '../panel/panel-result-bundle.js';
import {
  AuditDeleteBusyError,
  createAuditStore,
} from '../storage/audit-store.js';
import {
  ACTIVE_AUDIT_JOB_KEY,
  createAuthorizedAuditStarter,
  executionCheckpointStorageKey,
  readActiveAuditJobForWorker,
} from './authorized-audit-starter.js';
import { createAuditLifecycle } from './audit-lifecycle.js';
import { composeChromeAdapter, createChromeAdapter } from './chrome-adapter.js';
import { registerAuditContextMenus } from './context-menu.js';
import {
  createLegacyCompatibilityHandler,
  parseLegacyCompatMessage,
} from './legacy-compat-protocol.js';
import {
  PANEL_PORT_NAME,
  createPanelPortCoordinator,
} from './panel-port.js';
import { getPersonaController } from './persona-runtime.js';
import { runAttachedAuditExecution } from './run-audit.js';
import { createSidePanelIntentRouter } from './side-panel-intent-router.js';
import {
  createTargetCapabilityAuthority,
  readAuditSessionForWorker,
} from './target-capabilities.js';
import { parseWorkerMessage } from './worker-protocol.js';

export const SESSION_ACCESS_LEVEL_DENIED = 'SESSION_ACCESS_LEVEL_DENIED';

const PERSONA_PORT_NAME = 'audita-persona-v1';
const AUDIT_ID = /^[A-Za-z0-9._:-]{1,160}$/u;
const CAPABILITY = /^[A-Za-z0-9_-]{22}$/u;

function freeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freeze(child, seen);
  return Object.freeze(value);
}

function exact(value, keys, allowNullPrototype = false) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && (!allowNullPrototype || prototype !== null)) return null;
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

function own(value, key) {
  try {
    const descriptor = value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, key) : null;
    return descriptor?.enumerable && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  } catch { return undefined; }
}

function same(left, right) {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) !== Array.isArray(right)) return false;
  const leftKeys = Reflect.ownKeys(left);
  const rightKeys = Reflect.ownKeys(right);
  return leftKeys.length === rightKeys.length && leftKeys.every(key => rightKeys.includes(key) && same(left[key], right[key]));
}

function canonicalModelTime(modelNow) {
  const value = modelNow();
  if (typeof value !== 'string') throw new Error('WORKER_UNAVAILABLE');
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) throw new Error('WORKER_UNAVAILABLE');
  return value;
}

function randomBytes(length) {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

function base64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/gu, '');
}

function defaultNonce() { return base64Url(randomBytes(16)); }
function defaultAuditId() { return globalThis.crypto.randomUUID(); }

async function invokeChrome(chromeApi, receiver, name, ...args) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (handler, value) => { if (!settled) { settled = true; handler(value); } };
    try {
      const returned = receiver[name](...args, value => {
        if (chromeApi.runtime?.lastError) finish(reject, new Error('CHROME_API_DENIED'));
        else finish(resolve, value);
      });
      if (returned && typeof returned.then === 'function') returned.then(value => finish(resolve, value), () => finish(reject, new Error('CHROME_API_DENIED')));
      else if (receiver[name].length <= args.length) finish(resolve, returned);
    } catch { finish(reject, new Error('CHROME_API_DENIED')); }
  });
}

async function sendRuntimeMessage(chromeApi, message) {
  if (typeof chromeApi.runtime?.sendMessage !== 'function') return;
  await invokeChrome(chromeApi, chromeApi.runtime, 'sendMessage', message);
}

async function readStored(sessionArea, key) {
  const read = async () => {
    const envelope = await sessionArea.get(key);
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw new Error('STORAGE_DENIED');
    const value = own(envelope, key);
    if (value === undefined) return null;
    return value;
  };
  const first = await read();
  const second = await read();
  if (!same(first, second)) throw new Error('STORAGE_DENIED');
  return first;
}

function checkpointRecord(value) {
  const record = exact(value, ['version', 'auditId', 'sessionCapabilityId', 'windowId', 'checkpoint'], true);
  if (!record || record.version !== 1 || !AUDIT_ID.test(record.auditId ?? '') ||
    !CAPABILITY.test(record.sessionCapabilityId ?? '') || !Number.isSafeInteger(record.windowId) || record.windowId < 0 ||
    !record.checkpoint || typeof record.checkpoint !== 'object') return null;
  return freeze(structuredClone(record));
}

function createCheckpointAdapters(sessionArea) {
  const prefix = executionCheckpointStorageKey('');
  async function persistCheckpoint(raw) {
    const args = exact(raw, ['auditId', 'sessionCapabilityId', 'windowId', 'checkpoint']);
    const record = checkpointRecord(args && { version: 1, ...args });
    if (!record) throw new Error('CHECKPOINT_PERSIST_DENIED');
    const key = executionCheckpointStorageKey(record.auditId);
    const existingRaw = await readStored(sessionArea, key);
    if (existingRaw !== null) {
      const existing = checkpointRecord(existingRaw);
      if (!existing || existing.auditId !== record.auditId || existing.sessionCapabilityId !== record.sessionCapabilityId ||
        existing.windowId !== record.windowId) throw new Error('CHECKPOINT_PERSIST_DENIED');
      const oldPages = Array.isArray(existing.checkpoint.pages) ? existing.checkpoint.pages : [];
      const newPages = Array.isArray(record.checkpoint.pages) ? record.checkpoint.pages : [];
      if (newPages.length < oldPages.length) throw new Error('CHECKPOINT_PERSIST_DENIED');
    }
    await sessionArea.set({ [key]: record });
    const confirmed = checkpointRecord(await readStored(sessionArea, key));
    if (!confirmed || !same(confirmed, record)) throw new Error('CHECKPOINT_PERSIST_DENIED');
    return confirmed;
  }

  async function removeCheckpoint(raw) {
    const args = exact(raw, ['auditId', 'sessionCapabilityId', 'windowId']);
    if (!args || !AUDIT_ID.test(args.auditId ?? '') ||
      !((args.sessionCapabilityId === null && args.windowId === null) ||
        (CAPABILITY.test(args.sessionCapabilityId ?? '') && Number.isSafeInteger(args.windowId) && args.windowId >= 0))) {
      return Object.freeze({ removed: false });
    }
    const key = executionCheckpointStorageKey(args.auditId);
    const currentRaw = await readStored(sessionArea, key);
    if (currentRaw === null) return Object.freeze({ removed: false });
    const current = checkpointRecord(currentRaw);
    const correlated = current && current.auditId === args.auditId &&
      (args.sessionCapabilityId === null ||
        (current.sessionCapabilityId === args.sessionCapabilityId && current.windowId === args.windowId));
    if (!correlated) return Object.freeze({ removed: false });
    await sessionArea.remove(key);
    if (await readStored(sessionArea, key) !== null) throw new Error('CHECKPOINT_REMOVE_DENIED');
    return Object.freeze({ removed: true });
  }

  async function pruneCheckpoints() {
    const envelope = await sessionArea.get(null);
    let keys;
    try {
      if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(envelope))) throw new Error('CHECKPOINT_PRUNE_DENIED');
      keys = Reflect.ownKeys(envelope);
      if (keys.some(key => typeof key !== 'string')) throw new Error('CHECKPOINT_PRUNE_DENIED');
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(envelope, key);
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error('CHECKPOINT_PRUNE_DENIED');
      }
    } catch { throw new Error('CHECKPOINT_PRUNE_DENIED'); }
    const owned = keys.filter(key => key.startsWith(prefix));
    if (owned.length > 0) await sessionArea.remove(owned);
    const confirmed = await sessionArea.get(null);
    try {
      if (!confirmed || typeof confirmed !== 'object' || Array.isArray(confirmed) ||
        Reflect.ownKeys(confirmed).some(key => typeof key !== 'string' || key.startsWith(prefix))) {
        throw new Error('CHECKPOINT_PRUNE_DENIED');
      }
    } catch { throw new Error('CHECKPOINT_PRUNE_DENIED'); }
    return Object.freeze({ removed: owned.length });
  }

  return Object.freeze({ persistCheckpoint, removeCheckpoint, pruneCheckpoints });
}

function copyReadyRuntime(value) {
  const runtime = exact(value, ['authority', 'auditStarter', 'chromeAdapter'], true);
  if (!runtime || !runtime.authority || !runtime.auditStarter || !runtime.chromeAdapter) throw new Error('WORKER_UNAVAILABLE');
  return freeze(runtime);
}

function createCompatibilityAdapters({ chromeApi, auditStore, sessionArea, modelNow, createExportOwnerId }) {
  const checkpoints = createCheckpointAdapters(sessionArea);
  const now = () => canonicalModelTime(modelNow);

  async function readLegacyLastAudit() {
    try { return freeze({ ok: true, state: (await auditStore.getLatest()) ?? null }); }
    catch { return Object.freeze({ ok: false, code: 'COMPATIBILITY_FAILED' }); }
  }

  async function notifyLegacyReviewCommitted({ auditId, exportRevision }) {
    try {
      const snapshot = await auditStore.getAuditSnapshot(auditId);
      if (snapshot?.model?.auditId !== auditId || snapshot.revision !== exportRevision) {
        return Object.freeze({ ok: false, code: 'COMPATIBILITY_DENIED' });
      }
      await sendRuntimeMessage(chromeApi, { type: 'AUDIT_REVIEW_UPDATED', auditId, exportRevision });
      return Object.freeze({ ok: true });
    } catch { return Object.freeze({ ok: false, code: 'COMPATIBILITY_FAILED' }); }
  }

  async function queueLegacyExport({ auditId }) {
    try {
      const [snapshot, latest] = await Promise.all([auditStore.getAuditSnapshot(auditId), auditStore.getLatest()]);
      if (snapshot?.model?.auditId !== auditId || !snapshot.capability || !Number.isSafeInteger(snapshot.revision)) {
        return freeze({ ok: false, auditId, state: 'failed', code: 'EXPORT_PREPARE_FAILED', retryable: true, retryAt: null });
      }
      const leaseOwnerId = createExportOwnerId();
      if (!AUDIT_ID.test(leaseOwnerId ?? '')) throw new Error('denied');
      const latestState = {
        ...(latest?.auditId === auditId ? latest : {}), auditId,
        exportStatus: 'queued', exportRevision: snapshot.revision, exportQueuedAt: now(),
        leaseOwnerId, message: 'Relatório na fila de geração.',
      };
      delete latestState.exportAttempt;
      const lease = await auditStore.acquireExportLease(auditId, snapshot.capability, {
        ownerId: leaseOwnerId, now: latestState.exportQueuedAt, latestState,
      });
      if (!lease?.acquired) {
        return freeze({ ok: false, auditId, state: 'busy', code: 'EXPORT_BUSY', retryable: true, retryAt: typeof lease?.retryAt === 'string' ? lease.retryAt : null });
      }
      if (!Number.isSafeInteger(lease.exportAttempt) || lease.exportAttempt < 1) throw new Error('denied');
      const query = `auditId=${encodeURIComponent(auditId)}&leaseOwnerId=${encodeURIComponent(leaseOwnerId)}&exportAttempt=${lease.exportAttempt}`;
      await invokeChrome(chromeApi, chromeApi.tabs, 'create', {
        url: chromeApi.runtime.getURL(`src/export/index.html?${query}`), active: false,
      });
      return freeze({
        ok: true, auditId, state: 'queued', exportRevision: snapshot.revision,
        exportAttempt: lease.exportAttempt, leaseOwnerId,
      });
    } catch {
      return freeze({ ok: false, auditId, state: 'failed', code: 'EXPORT_PREPARE_FAILED', retryable: true, retryAt: null });
    }
  }

  async function deleteLegacyAudit({ auditId }) {
    try {
      const active = await readActiveAuditJobForWorker({ sessionArea });
      if (active?.auditId === auditId) return Object.freeze({ ok: false, code: 'AUDIT_DELETE_BUSY' });
      const snapshot = await auditStore.getAuditSnapshot(auditId);
      if (snapshot?.model?.auditId !== auditId || !snapshot.capability) return Object.freeze({ ok: false, code: 'COMPATIBILITY_FAILED' });
      const result = await auditStore.deleteAudit(auditId, snapshot.capability, { now: now() });
      if (result?.deleted !== true) return Object.freeze({ ok: false, code: 'COMPATIBILITY_FAILED' });
      await checkpoints.removeCheckpoint({ auditId, sessionCapabilityId: null, windowId: null });
      await sendRuntimeMessage(chromeApi, createAuditDeletedEvent({ auditId, reason: 'delete-one' })).catch(() => {});
      return freeze({ ok: true, auditId, deleted: true });
    } catch (error) {
      return error instanceof AuditDeleteBusyError || own(error, 'code') === 'AUDIT_DELETE_BUSY'
        ? Object.freeze({ ok: false, code: 'AUDIT_DELETE_BUSY' })
        : Object.freeze({ ok: false, code: 'COMPATIBILITY_FAILED' });
    }
  }

  async function deleteAllLegacyAudits() {
    try {
      if (await readActiveAuditJobForWorker({ sessionArea }) !== null) return Object.freeze({ ok: false, code: 'AUDIT_DELETE_BUSY' });
      const result = await auditStore.deleteAllAudits({ now: now() });
      if (!Number.isSafeInteger(result?.deleted) || result.deleted < 0) throw new Error('denied');
      await checkpoints.pruneCheckpoints();
      await sendRuntimeMessage(chromeApi, createAuditDeletedEvent({ scope: 'all', reason: 'delete-all' })).catch(() => {});
      return freeze({ ok: true, deleted: result.deleted });
    } catch (error) {
      return error instanceof AuditDeleteBusyError || own(error, 'code') === 'AUDIT_DELETE_BUSY'
        ? Object.freeze({ ok: false, code: 'AUDIT_DELETE_BUSY' })
        : Object.freeze({ ok: false, code: 'COMPATIBILITY_FAILED' });
    }
  }

  async function acknowledgeLegacyExportEvent({ event }) {
    try {
      if (event.type === 'EXPORT_COMPLETE' && event.localAuditDeleted === true) {
        const [snapshot, retention, latest] = await Promise.all([
          auditStore.getAuditSnapshot(event.auditId), auditStore.getAuditRetention(event.auditId), auditStore.getLatest(),
        ]);
        if (snapshot?.model === undefined && retention === undefined && latest?.auditId !== event.auditId) {
          await checkpoints.removeCheckpoint({ auditId: event.auditId, sessionCapabilityId: null, windowId: null });
          await sendRuntimeMessage(chromeApi, createAuditDeletedEvent({ auditId: event.auditId, reason: 'complete-export' })).catch(() => {});
        }
      }
      return Object.freeze({ ok: true });
    } catch { return Object.freeze({ ok: true }); }
  }

  return freeze({
    readLegacyLastAudit, notifyLegacyReviewCommitted, queueLegacyExport,
    deleteLegacyAudit, deleteAllLegacyAudits, acknowledgeLegacyExportEvent,
  });
}

async function buildDefaultRuntime(chromeApi, options) {
  const sessionArea = chromeApi.storage.session;
  const epochNow = options.epochNow ?? Date.now;
  const modelNow = options.modelNow ?? (() => new Date().toISOString());
  const bytes = options.randomBytes ?? randomBytes;
  const digestManager = createSessionUrlDigestManager({
    sessionArea, subtle: options.subtle ?? globalThis.crypto?.subtle, randomBytes: bytes, now: epochNow,
  });
  const baseAdapter = (options.chromeAdapterFactory ?? createChromeAdapter)(chromeApi, { sessionUrlDigestManager: digestManager });
  const chromeAdapter = options.chromeAdapterOverrides
    ? composeChromeAdapter(baseAdapter, options.chromeAdapterOverrides)
    : Object.freeze(baseAdapter);
  const authority = createTargetCapabilityAuthority({
    chromeApi, sessionArea, now: epochNow, randomBytes: bytes,
    probeDocument: tabId => chromeAdapter.probeDocumentIdentity(tabId),
  });
  const auditStore = options.auditStore ?? createAuditStore(options.auditStoreOptions);
  const inventory = await createInstalledCoreRuleInventory();
  const buildPanelResultBundle = ({ reportRevision }) => createPanelResultBundleV1({ reportRevision, inventory });
  const checkpoints = createCheckpointAdapters(sessionArea);
  const revokeViewOnly = async ({ sessionCapabilityId, auditId }) => {
    try {
      const before = await readAuditSessionForWorker({ sessionArea, sessionCapabilityId, auditId });
      if (before.state !== 'view-only' || before.targetBinding?.kind !== 'view-only') return false;
      const result = await authority.transitionAuditSession({ sessionCapabilityId, auditId, nextState: 'revoked' });
      if (result?.ok !== true) return false;
      const after = await readAuditSessionForWorker({ sessionArea, sessionCapabilityId, auditId });
      return after.state === 'revoked' && after.targetBinding?.kind === 'view-only';
    } catch { return false; }
  };
  const loadPanelResultBundle = async ({ auditId }) => {
    const reportRevision = await auditStore.getReportRevision(auditId);
    return reportRevision ? buildPanelResultBundle({ reportRevision }) : null;
  };
  const panelCoordinator = createPanelPortCoordinator({
    chromeApi, sessionArea,
    readActiveJob: () => readActiveAuditJobForWorker({ sessionArea }),
    readAuditSession: ({ sessionCapabilityId, auditId }) => readAuditSessionForWorker({ sessionArea, sessionCapabilityId, auditId }),
    loadPanelResultBundle,
    rehydrateViewOnly: value => authority.rehydrateViewOnly(value),
    revokeViewOnly,
    epochNow,
    setTimer: (callback, delay) => setTimeout(callback, delay),
    clearTimer: timer => clearTimeout(timer),
  });
  const persistLatest = async ({ state }) => { await auditStore.setLatest(state); return freeze(structuredClone(state)); };
  const commitTerminalAudit = async ({ auditId, model, checkpoint, latestState, expectedRevision }) => {
    if (expectedRevision !== 1) throw new Error('TERMINAL_COMMIT_DENIED');
    const result = await auditStore.commitAuditWithCheckpointIfAbsent(
      auditId, model, checkpoint, latestState,
      { now: canonicalModelTime(modelNow), deleteAfterCompleteExport: false },
    );
    if (result?.revision !== 1 || typeof result.modelHash !== 'string') throw new Error('TERMINAL_COMMIT_DENIED');
    return Object.freeze({ revision: 1, modelHash: result.modelHash });
  };
  const auditStarter = createAuthorizedAuditStarter({
    authority, sessionArea, panelCoordinator,
    runAttachedAuditExecution: args => runAttachedAuditExecution({
      ...args, chromeAdapter, expectedExtensionId: chromeApi.runtime.id,
    }),
    persistLatest, persistCheckpoint: checkpoints.persistCheckpoint, removeCheckpoint: checkpoints.removeCheckpoint,
    commitTerminalAudit,
    readAuditSnapshot: ({ auditId }) => auditStore.getAuditSnapshot(auditId),
    readReportRevision: ({ auditId }) => auditStore.getReportRevision(auditId),
    readLatest: () => auditStore.getLatest(), buildPanelResultBundle,
    epochNow, modelNow, createAbortController: () => new AbortController(),
  });
  const router = createSidePanelIntentRouter({
    chromeApi, authority, auditStarter, panelCoordinator, chromeAdapter,
    readReportRevision: ({ auditId }) => auditStore.getReportRevision(auditId),
    buildPanelResultBundle, revokeViewOnly, epochNow, modelNow,
    createAuditId: options.createAuditId ?? defaultAuditId,
  });
  const compatibilityAdapters = createCompatibilityAdapters({
    chromeApi, auditStore, sessionArea, modelNow,
    createExportOwnerId: options.createExportOwnerId ?? defaultAuditId,
  });
  const compatibilityHandler = createLegacyCompatibilityHandler({
    chromeApi,
    readLegacyLastAudit: compatibilityAdapters.readLegacyLastAudit,
    notifyLegacyReviewCommitted: compatibilityAdapters.notifyLegacyReviewCommitted,
    queueLegacyExport: compatibilityAdapters.queueLegacyExport,
    deleteLegacyAudit: compatibilityAdapters.deleteLegacyAudit,
    deleteAllLegacyAudits: compatibilityAdapters.deleteAllLegacyAudits,
    acknowledgeLegacyExportEvent: compatibilityAdapters.acknowledgeLegacyExportEvent,
  });
  const personaController = options.personaController ?? getPersonaController(chromeApi, { logger: options.logger });
  const recovery = await auditStarter.recoverAuthorizedAuditLifecycle();
  if (recovery?.ok !== true) throw new Error('WORKER_UNAVAILABLE');
  return {
    readyRuntime: copyReadyRuntime({ authority, auditStarter, chromeAdapter }),
    router, compatibilityHandler, panelCoordinator, personaController,
  };
}

function parseBuiltRuntime(value) {
  const built = exact(value, ['readyRuntime', 'router', 'compatibilityHandler', 'panelCoordinator', 'personaController'], true);
  if (!built || typeof built.router?.dispatch !== 'function' || typeof built.compatibilityHandler?.dispatch !== 'function' ||
    typeof built.panelCoordinator?.attachPanelPort !== 'function') throw new Error('WORKER_UNAVAILABLE');
  return { ...built, readyRuntime: copyReadyRuntime(built.readyRuntime) };
}

export function registerServiceWorker(chromeApi, options = {}) {
  if (!chromeApi?.runtime?.onMessage?.addListener || !chromeApi.runtime.onMessage.removeListener ||
    !chromeApi?.runtime?.onConnect?.addListener || !chromeApi.runtime.onConnect.removeListener ||
    !chromeApi?.storage?.session) throw new TypeError('SERVICE_WORKER_INVALID');
  const logger = options.logger ?? { error() {} };
  const epochNow = options.epochNow ?? Date.now;
  const createEventNonce = options.createEventNonce ?? defaultNonce;
  const createAuditId = options.createAuditId ?? defaultAuditId;

  let router = options.router ?? null;
  let compatibilityHandler = options.compatibilityHandler ?? null;
  let panelCoordinator = options.panelCoordinator ?? null;
  let personaController = options.personaController ?? null;
  let resolveStartup;
  let rejectStartup;
  let startupReady;

  if (options.startupReady) {
    startupReady = Promise.resolve(options.startupReady).then(copyReadyRuntime);
  } else {
    startupReady = new Promise((resolve, reject) => { resolveStartup = resolve; rejectStartup = reject; });
  }
  const getReadyRuntime = () => startupReady;

  const messageListener = (message, sender, sendResponse) => {
    const primary = parseWorkerMessage(message);
    let compatibility = null;
    let kind = 'primary';
    if (!primary.ok && primary.code === 'UNKNOWN_MESSAGE') {
      compatibility = parseLegacyCompatMessage(message);
      if (!compatibility.ok && compatibility.code === 'UNKNOWN_MESSAGE') return false;
      kind = 'compatibility';
    }
    void startupReady.then(async () => {
      if (kind === 'primary') {
        if (!primary.ok) return primary.code === 'MESSAGE_TOO_LARGE'
          ? Object.freeze({ ok: false, code: 'MESSAGE_TOO_LARGE' })
          : Object.freeze({ ok: false, code: 'INVALID_MESSAGE' });
        try { return await router.dispatch({ envelope: primary.value, sender }); }
        catch { return Object.freeze({ ok: false, code: 'WORKER_UNAVAILABLE' }); }
      }
      if (!compatibility.ok) return Object.freeze({ ok: false, code: 'COMPATIBILITY_DENIED' });
      try { return await compatibilityHandler.dispatch({ envelope: compatibility.value, sender }); }
      catch { return Object.freeze({ ok: false, code: 'COMPATIBILITY_FAILED' }); }
    }, () => kind === 'primary'
      ? Object.freeze({ ok: false, code: 'WORKER_UNAVAILABLE' })
      : Object.freeze({ ok: false, code: 'COMPATIBILITY_FAILED' }))
      .then(response => {
        try { sendResponse(response); } catch { /* one closed response attempt */ }
      });
    return true;
  };

  const connectListener = port => {
    const name = own(port, 'name');
    void startupReady.then(() => {
      if (name === PANEL_PORT_NAME) panelCoordinator.attachPanelPort(port);
      else if (name === PERSONA_PORT_NAME && personaController?.attachPanelPort) personaController.attachPanelPort(port);
      else {
        try { port?.disconnect?.(); } catch { /* fixed denial */ }
      }
    }, () => {
      try { port?.disconnect?.(); } catch { /* fixed denial */ }
    });
  };

  chromeApi.runtime.onMessage.addListener(messageListener);
  chromeApi.runtime.onConnect.addListener(connectListener);

  const lifecycle = createAuditLifecycle({ chromeApi, getReadyRuntime });
  lifecycle.register();
  const contextMenus = registerAuditContextMenus(chromeApi, {
    getReadyRuntime, createEventNonce, createAuditId, epochNow, logger,
  });
  void startupReady.then(() => contextMenus.installMenus(), () => false);

  if (!options.startupReady) {
    Promise.resolve().then(async () => {
      try {
        if (typeof chromeApi.storage.session.setAccessLevel !== 'function') throw new Error(SESSION_ACCESS_LEVEL_DENIED);
        await invokeChrome(chromeApi, chromeApi.storage.session, 'setAccessLevel', { accessLevel: 'TRUSTED_CONTEXTS' });
      } catch {
        logger.error(SESSION_ACCESS_LEVEL_DENIED);
        rejectStartup(new Error('WORKER_UNAVAILABLE'));
        return;
      }
      try {
        const built = parseBuiltRuntime(options.buildRuntime
          ? await options.buildRuntime({ chromeApi, sessionArea: chromeApi.storage.session })
          : await buildDefaultRuntime(chromeApi, { ...options, logger, epochNow, createAuditId }));
        router = built.router;
        compatibilityHandler = built.compatibilityHandler;
        panelCoordinator = built.panelCoordinator;
        personaController = built.personaController;
        resolveStartup(built.readyRuntime);
      } catch {
        rejectStartup(new Error('WORKER_UNAVAILABLE'));
      }
    });
  }

  function dispose() {
    chromeApi.runtime.onMessage.removeListener(messageListener);
    chromeApi.runtime.onConnect.removeListener(connectListener);
    lifecycle.dispose();
    contextMenus.dispose();
  }

  return Object.freeze({ startupReady, dispose });
}

export async function initializeServiceWorker(chromeApi, options = {}) {
  const registration = registerServiceWorker(chromeApi, options);
  try { await registration.startupReady; return registration; }
  catch { return null; }
}

if (typeof chrome !== 'undefined') registerServiceWorker(chrome);
