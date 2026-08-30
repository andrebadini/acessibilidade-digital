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
import { validateExecutionCheckpoint } from './execution-checkpoint.js';
import {
  createLegacyCompatibilityHandler,
  parseLegacyCompatMessage,
  projectLegacyPanelLatestV1,
} from './legacy-compat-protocol.js';
import {
  PANEL_PORT_NAME,
  createPanelPortCoordinator,
} from './panel-port.js';
import { getPersonaController } from './persona-runtime.js';
import { runAttachedAuditExecution } from './run-audit.js';
import { createSidePanelIntentRouter } from './side-panel-intent-router.js';
import { createReportLaunchAuthority } from './report-launch.js';
import { createExportLaunchAuthority } from './export-launch.js';
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

async function readStored(sessionArea, key, parser) {
  const read = async () => {
    const envelope = await sessionArea.get(key);
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw new Error('STORAGE_DENIED');
    const value = own(envelope, key);
    if (value === undefined) return null;
    const parsed = parser(value);
    if (!parsed) throw new Error('STORAGE_DENIED');
    return parsed;
  };
  const first = await read();
  const second = await read();
  if (!same(first, second)) throw new Error('STORAGE_DENIED');
  return first;
}

function denseArray(value) {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
    const keys = Reflect.ownKeys(value);
    const expected = ['length', ...Array.from({ length: value.length }, (_unused, index) => String(index))];
    if (keys.length !== expected.length || expected.some(key => !keys.includes(key))) return null;
    const copy = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      copy.push(descriptor.value);
    }
    return copy;
  } catch { return null; }
}

function canonicalCheckpoint(auditId, value) {
  const root = exact(value, ['version', 'auditId', 'pages'], true);
  const pages = root ? denseArray(root.pages) : null;
  if (!root || root.version !== 1 || root.auditId !== auditId || !pages || pages.length === 0) return null;
  const pageOrder = [];
  for (const page of pages) {
    const pageId = own(page, 'pageId');
    if (typeof pageId !== 'string') return null;
    pageOrder.push(pageId);
  }
  try { return validateExecutionCheckpoint({ auditId, checkpoint: value, pageOrder }); }
  catch { return null; }
}

function checkpointRecord(value) {
  const record = exact(value, ['version', 'auditId', 'sessionCapabilityId', 'windowId', 'checkpoint'], true);
  if (!record || record.version !== 1 || !AUDIT_ID.test(record.auditId ?? '') ||
    !CAPABILITY.test(record.sessionCapabilityId ?? '') || !Number.isSafeInteger(record.windowId) || record.windowId < 0 ||
    !record.checkpoint || typeof record.checkpoint !== 'object') return null;
  const checkpoint = canonicalCheckpoint(record.auditId, record.checkpoint);
  return checkpoint ? freeze({ ...record, checkpoint }) : null;
}

function checkpointProgresses(existing, incoming) {
  const oldPages = existing.checkpoint.pages;
  const newPages = incoming.checkpoint.pages;
  if (newPages.length < oldPages.length) return false;
  for (let index = 0; index < oldPages.length; index += 1) {
    const prior = oldPages[index];
    const next = newPages[index];
    if (!next || prior.pageId !== next.pageId || prior.attempted !== next.attempted ||
      prior.startedAt !== next.startedAt || prior.rulesVersion !== next.rulesVersion ||
      prior.inventoryVersion !== next.inventoryVersion || prior.inventoryHash !== next.inventoryHash) return false;
    const nextOutcomes = new Map(next.outcomes.map(row => [row.ruleId, row.outcome]));
    if (prior.outcomes.some(row => nextOutcomes.get(row.ruleId) !== row.outcome)) return false;
  }
  return true;
}

export function createCheckpointAdapters(sessionArea) {
  async function persistCheckpoint(raw) {
    try {
      const args = exact(raw, ['auditId', 'sessionCapabilityId', 'windowId', 'checkpoint']);
      const record = checkpointRecord(args && { version: 1, ...args });
      if (!record) throw new Error('CHECKPOINT_PERSIST_DENIED');
      const key = executionCheckpointStorageKey(record.auditId);
      const existing = await readStored(sessionArea, key, checkpointRecord);
      if (existing !== null && (existing.auditId !== record.auditId ||
        existing.sessionCapabilityId !== record.sessionCapabilityId || existing.windowId !== record.windowId ||
        !checkpointProgresses(existing, record))) throw new Error('CHECKPOINT_PERSIST_DENIED');
      await sessionArea.set({ [key]: record });
      const confirmed = await readStored(sessionArea, key, checkpointRecord);
      if (!confirmed || !same(confirmed, record)) throw new Error('CHECKPOINT_PERSIST_DENIED');
      return confirmed;
    } catch {
      throw new Error('CHECKPOINT_PERSIST_DENIED');
    }
  }

  async function removeCheckpoint(raw) {
    const args = exact(raw, ['auditId', 'sessionCapabilityId', 'windowId']);
    if (!args || !AUDIT_ID.test(args.auditId ?? '') ||
      !((args.sessionCapabilityId === null && args.windowId === null) ||
        (CAPABILITY.test(args.sessionCapabilityId ?? '') && Number.isSafeInteger(args.windowId) && args.windowId >= 0))) {
      return Object.freeze({ removed: false });
    }
    try {
      const key = executionCheckpointStorageKey(args.auditId);
      const current = await readStored(sessionArea, key, checkpointRecord);
      if (current === null) return Object.freeze({ removed: false });
      const correlated = current.auditId === args.auditId &&
        (args.sessionCapabilityId === null ||
          (current.sessionCapabilityId === args.sessionCapabilityId && current.windowId === args.windowId));
      if (!correlated) throw new Error('CHECKPOINT_REMOVE_DENIED');
      await sessionArea.remove(key);
      if (await readStored(sessionArea, key, checkpointRecord) !== null) throw new Error('CHECKPOINT_REMOVE_DENIED');
      return Object.freeze({ removed: true });
    } catch {
      throw new Error('CHECKPOINT_REMOVE_DENIED');
    }
  }

  return Object.freeze({ persistCheckpoint, removeCheckpoint });
}

function copyReadyRuntime(value) {
  const runtime = exact(value, ['authority', 'auditStarter', 'chromeAdapter', 'reportLaunch', 'exportLaunch'], true) ??
    exact(value, ['authority', 'auditStarter', 'chromeAdapter'], true);
  if (!runtime || !runtime.authority || !runtime.auditStarter || !runtime.chromeAdapter) throw new Error('WORKER_UNAVAILABLE');
  return freeze(runtime);
}

function createCompatibilityAdapters({ chromeApi, auditStore, sessionArea, modelNow }) {
  const checkpoints = createCheckpointAdapters(sessionArea);
  const now = () => canonicalModelTime(modelNow);

  async function readLegacyLastAudit() {
    try {
      await auditStore.cleanupExpiredAudits({ now: now(), limit: 25 });
      const latest = (await auditStore.getLatest()) ?? null;
      return freeze({
        ok: true,
        state: projectLegacyPanelLatestV1(latest, chromeApi.runtime.id),
      });
    }
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
      await sendRuntimeMessage(chromeApi, createAuditDeletedEvent({ scope: 'all', reason: 'delete-all' })).catch(() => {});
      return freeze({ ok: true, deleted: result.deleted });
    } catch (error) {
      return error instanceof AuditDeleteBusyError || own(error, 'code') === 'AUDIT_DELETE_BUSY'
        ? Object.freeze({ ok: false, code: 'AUDIT_DELETE_BUSY' })
        : Object.freeze({ ok: false, code: 'COMPATIBILITY_FAILED' });
    }
  }

  return freeze({
    readLegacyLastAudit, notifyLegacyReviewCommitted,
    deleteLegacyAudit, deleteAllLegacyAudits,
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
  const launchApisAvailable = typeof chromeApi.tabs?.create === 'function' && typeof chromeApi.tabs?.update === 'function' &&
    typeof chromeApi.tabs?.get === 'function' && typeof chromeApi.tabs?.remove === 'function';
  const unavailableLaunch = freeze({
    async openRegisteredReport() { return { ok: false, code: 'REPORT_OPEN_DENIED' }; },
    async connect() { return { ok: false, code: 'CONTEXT_DENIED' }; },
    async authorizeExport() { return { ok: false, code: 'REPORT_EXPORT_DENIED' }; },
    async validateConsumer() { return false; },
    async requestExport() { return { ok: false, code: 'REPORT_EXPORT_DENIED' }; },
    async complete() { return { ok: false, code: 'EXPORT_COMPLETE_DENIED' }; },
    async handleTabUpdated() { return false; }, async handleTabRemoved() { return false; }, async handleWindowRemoved() { return false; },
  });
  const reportLaunch = launchApisAvailable ? createReportLaunchAuthority({ chromeApi, sessionArea, epochNow, randomBytes: bytes }) : unavailableLaunch;
  const exportCompletionStore = Object.freeze({
    ...auditStore,
    async emitTerminal(event) { await chromeAdapter.emitProgress(event); },
    async completeExport(auditId, { attemptId, receipt }) {
      const durable = await auditStore.getExportReceipt(auditId);
      if (!same(durable, receipt)) throw new Error('EXPORT_RECEIPT_DENIED');
      if (durable.attemptId !== attemptId) throw new Error('EXPORT_COMPLETE_DENIED');
      return Object.freeze({ completed: true, deleted: false });
    },
  });
  const exportLaunch = launchApisAvailable ? createExportLaunchAuthority({
    chromeApi, sessionArea, auditStore: exportCompletionStore, reportLaunch, epochNow, modelNow, randomBytes: bytes,
  }) : unavailableLaunch;
  const router = createSidePanelIntentRouter({
    chromeApi, authority, auditStarter, panelCoordinator, chromeAdapter,
    readReportRevision: ({ auditId }) => auditStore.getReportRevision(auditId),
    buildPanelResultBundle, revokeViewOnly, epochNow, modelNow,
    createAuditId: options.createAuditId ?? defaultAuditId, reportLaunch, exportLaunch,
  });
  const compatibilityAdapters = createCompatibilityAdapters({ chromeApi, auditStore, sessionArea, modelNow });
  const compatibilityHandler = createLegacyCompatibilityHandler({
    chromeApi,
    readLegacyLastAudit: compatibilityAdapters.readLegacyLastAudit,
    notifyLegacyReviewCommitted: compatibilityAdapters.notifyLegacyReviewCommitted,
    deleteLegacyAudit: compatibilityAdapters.deleteLegacyAudit,
    deleteAllLegacyAudits: compatibilityAdapters.deleteAllLegacyAudits,
  });
  const personaController = options.personaController ?? getPersonaController(chromeApi, { logger: options.logger });
  const recovery = await auditStarter.recoverAuthorizedAuditLifecycle();
  if (recovery?.ok !== true) throw new Error('WORKER_UNAVAILABLE');
  return {
    readyRuntime: copyReadyRuntime({ authority, auditStarter, chromeAdapter, reportLaunch, exportLaunch }),
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
