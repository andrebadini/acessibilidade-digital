import { createCapturePolicyV1 } from '../core/privacy/capture-policy.js';
import { isEvidenceUrlV1 } from '../core/privacy/evidence-url.js';
import {
  PANEL_SURFACE,
  deriveTrustedExtensionContext,
} from './target-capabilities.js';
import { parseWorkerMessage } from './worker-protocol.js';

const LAUNCH_FACTORY_KEYS = Object.freeze([
  'chromeApi', 'authority', 'auditStarter', 'panelCoordinator', 'chromeAdapter',
  'personaStart', 'personaCoordinator',
  'readReportRevision', 'buildPanelResultBundle', 'revokeViewOnly',
  'epochNow', 'modelNow', 'createAuditId', 'reportLaunch', 'exportLaunch',
]);
const FACTORY_KEYS = Object.freeze([...LAUNCH_FACTORY_KEYS, 'reportOperations']);
const LEGACY_FACTORY_KEYS = Object.freeze(LAUNCH_FACTORY_KEYS.filter(key => !['reportLaunch', 'exportLaunch'].includes(key)));
const HIGHLIGHT_DEPENDENCY_KEYS = Object.freeze([
  'highlightController', 'highlightSessionBridge', 'publishHighlightState',
]);
const HIGHLIGHT_FACTORY_KEYS = Object.freeze([...FACTORY_KEYS, ...HIGHLIGHT_DEPENDENCY_KEYS]);
const HIGHLIGHT_LAUNCH_FACTORY_KEYS = Object.freeze([...LAUNCH_FACTORY_KEYS, ...HIGHLIGHT_DEPENDENCY_KEYS]);
const HIGHLIGHT_LEGACY_FACTORY_KEYS = Object.freeze([...LEGACY_FACTORY_KEYS, ...HIGHLIGHT_DEPENDENCY_KEYS]);
const URL_DEPENDENCY_KEYS = Object.freeze(['urlAuditStarter', 'rawNavigationVault', 'createOwnershipId']);
const URL_HIGHLIGHT_FACTORY_KEYS = Object.freeze([...HIGHLIGHT_FACTORY_KEYS, ...URL_DEPENDENCY_KEYS]);
const URL_HIGHLIGHT_LAUNCH_FACTORY_KEYS = Object.freeze([...HIGHLIGHT_LAUNCH_FACTORY_KEYS, ...URL_DEPENDENCY_KEYS]);
const URL_HIGHLIGHT_LEGACY_FACTORY_KEYS = Object.freeze([...HIGHLIGHT_LEGACY_FACTORY_KEYS, ...URL_DEPENDENCY_KEYS]);
const AUDIT_ID = /^[A-Za-z0-9._:-]{1,160}$/u;
const OCCURRENCE_ID = /^[A-Za-z0-9._:-]{1,200}$/u;
const CAPABILITY = /^[A-Za-z0-9_-]{20,240}$/u;
const DIGEST = /^hmac-sha256:[A-Za-z0-9_-]{43}$/u;
const LEASE_ID = /^lease-[A-Za-z0-9_-]{22}$/u;
const PERSONA_MODES = new Set(['reader', 'achromatopsia', 'motor']);
const READER_ACTIONS = new Set(['previous', 'repeat', 'pause', 'resume', 'next', 'stop']);
const AUTONOMOUS_PERSONA_REASONS = new Set(['emergency-stop', 'lifecycle-stop', 'reader-terminal']);
const READER_STATE_KEYS = Object.freeze([
  'version', 'playback', 'index', 'total', 'caption', 'canPrevious', 'canNext',
  'speechAvailability', 'voiceId', 'rate',
]);
const PANEL_PORT_TYPES = new Set([
  'PREPARE_PANEL_CAPABILITY', 'PREPARE_PANEL_NAVIGATION_CAPABILITY', 'PREPARE_PANEL_PERSONA_CAPABILITY',
  'PANEL_START_ATTACHED_AUDIT', 'PANEL_START_URL_AUDIT', 'CONFIRM_PIXEL_CAPTURE', 'PANEL_CONFIRM_PIXEL_CAPTURE',
  'PANEL_START_PERSONA', 'PANEL_REHYDRATE_PERSONA',
  'PANEL_SET_PERSONA_MODE', 'PANEL_READER_STATE', 'PANEL_READER_ACTION',
  'PANEL_READER_ENABLE_VOICE',
  'PANEL_STOP_PERSONA', 'PANEL_CANCEL_AUDIT',
  'PANEL_OPEN_REPORT', 'PANEL_REHYDRATE_VIEW',
]);
const HIGHLIGHT_TYPES = new Set([
  'GET_HIGHLIGHT_STATE', 'GET_HIGHLIGHT_AVAILABILITY', 'HIGHLIGHT_OCCURRENCE', 'CLEAR_HIGHLIGHT',
]);
const HIGHLIGHT_FAILURE_CODES = new Set([
  'HIGHLIGHT_AMBIGUOUS', 'HIGHLIGHT_CLEANUP_UNCONFIRMED', 'HIGHLIGHT_DOCUMENT_CHANGED',
  'HIGHLIGHT_EXPIRED', 'HIGHLIGHT_INACCESSIBLE', 'HIGHLIGHT_INJECTION_FAILED',
  'HIGHLIGHT_INPUT_INVALID', 'HIGHLIGHT_LIVE_PROOF_FAILED', 'HIGHLIGHT_NOT_APPLICABLE',
  'HIGHLIGHT_NOT_AUTHORIZED', 'HIGHLIGHT_NO_BINDING', 'HIGHLIGHT_PAGE_OR_PROCESS',
  'HIGHLIGHT_SHADOW_ROOT', 'HIGHLIGHT_STATE_FAILED', 'HIGHLIGHT_URL_CHANGED',
  'HIGHLIGHT_WINDOW_CHANGED',
]);
const HIGHLIGHT_UNAVAILABLE_REASONS = new Set(['no-binding', 'expired', 'live-proof-failed']);
const PERSONA_CODES = new Set([
  'CAPABILITY_UNAVAILABLE', 'PERSONA_NOT_FOUND', 'PERSONA_EXPIRED', 'PERSONA_CONFLICT',
  'PERSONA_RUNTIME_FAILED', 'PERSONA_CLEANUP_UNCONFIRMED', 'PERSONA_CONSUMER_MISMATCH',
  'PERSONA_STATE_FAILED', 'PERSONA_TARGET_CHANGED', 'PERSONA_READER_INACTIVE',
  'PERSONA_READER_ACTION_REJECTED', 'PERSONA_READER_ACTION_TERMINAL',
  'PERSONA_READER_GESTURE_REQUIRED', 'PERSONA_READER_VOICE_UNAVAILABLE',
  'PERSONA_READER_RUNTIME_FAILED',
  'PERSONA_REVOKED_AFTER_RUNTIME_FAILURE',
]);
const START_CODES = new Set([
  'AUDIT_BUSY', 'AUDIT_RECOVERY_REQUIRED', 'TARGET_UNAVAILABLE', 'AUDIT_ID_COLLISION', 'AUDIT_START_FAILED',
  'HIGHLIGHT_CLEANUP_UNCONFIRMED', 'PERSONA_CLEANUP_UNCONFIRMED',
]);
const PIXEL_CONFIRM_CODES = new Set([
  'PIXEL_CONSENT_EXPIRED', 'PIXEL_CONSENT_DOCUMENT_CHANGED', 'PIXEL_CONSENT_ALREADY_USED',
  'PIXEL_CONSENT_STALE', 'AUDIT_RECOVERY_REQUIRED', 'AUDIT_CANCELLED',
]);

function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

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

function own(value, key) {
  try {
    const descriptor = value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, key) : null;
    return descriptor?.enumerable && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  } catch { return undefined; }
}

function optionalOwnData(value, key) {
  try {
    if (!value || typeof value !== 'object') return { found: false, invalid: true };
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) return { found: false, invalid: false };
    return descriptor.enumerable && Object.hasOwn(descriptor, 'value')
      ? { found: true, invalid: false, value: descriptor.value }
      : { found: true, invalid: true };
  } catch { return { found: true, invalid: true }; }
}

function canonicalHttpUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const parsed = new URL(value);
    return ['http:', 'https:'].includes(parsed.protocol) && parsed.href === value && parsed.username === '' && parsed.password === '';
  } catch { return false; }
}

function safeChromeId(value) { return Number.isSafeInteger(value) && value >= 0; }

async function queryTabs(chromeApi, queryInfo) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (handler, value) => { if (!settled) { settled = true; handler(value); } };
    try {
      const returned = chromeApi.tabs.query(queryInfo, value => {
        if (chromeApi.runtime?.lastError) finish(reject, new Error('TARGET_UNAVAILABLE'));
        else finish(resolve, value);
      });
      if (returned && typeof returned.then === 'function') returned.then(value => finish(resolve, value), () => finish(reject, new Error('TARGET_UNAVAILABLE')));
      else if (returned !== undefined) finish(resolve, returned);
    } catch { finish(reject, new Error('TARGET_UNAVAILABLE')); }
  });
}

function activeTab(value, windowId) {
  if (!Array.isArray(value) || value.length !== 1) return null;
  const tab = value[0];
  const id = own(tab, 'id');
  const tabWindow = own(tab, 'windowId');
  const status = own(tab, 'status');
  const url = own(tab, 'url');
  const pending = optionalOwnData(tab, 'pendingUrl');
  return safeChromeId(id) && tabWindow === windowId && status === 'complete' && canonicalHttpUrl(url) &&
    !pending.invalid && (!pending.found || pending.value === null || pending.value === '') ? { id, windowId } : null;
}

function proofRecord(value, tabId, windowId) {
  const proof = exact(value, ['tabId', 'windowId', 'documentId', 'urlSessionDigest']);
  return proof && proof.tabId === tabId && proof.windowId === windowId &&
    typeof proof.documentId === 'string' && proof.documentId && DIGEST.test(proof.urlSessionDigest ?? '') ? proof : null;
}

function fail(code) { return Object.freeze({ ok: false, code }); }

export function createSidePanelIntentRouter(raw) {
  const input = exact(raw, URL_HIGHLIGHT_FACTORY_KEYS) ?? exact(raw, URL_HIGHLIGHT_LAUNCH_FACTORY_KEYS) ??
    exact(raw, URL_HIGHLIGHT_LEGACY_FACTORY_KEYS) ?? exact(raw, HIGHLIGHT_FACTORY_KEYS) ??
    exact(raw, HIGHLIGHT_LAUNCH_FACTORY_KEYS) ?? exact(raw, HIGHLIGHT_LEGACY_FACTORY_KEYS);
  const hasUrlAudit = Boolean(input && Object.hasOwn(input, 'urlAuditStarter'));
  const coordinator = exact(input?.panelCoordinator, ['attachPanelPort', 'withWindowLock', 'publishHighlightState']);
  const reportOperations = input?.reportOperations
    ? exact(input.reportOperations, ['commitReviewDecision', 'deleteAudit', 'deleteAllAudits'])
    : null;
  if (!input || typeof input.chromeApi?.runtime?.id !== 'string' || typeof input.chromeApi?.runtime?.getContexts !== 'function' ||
    typeof input.chromeApi?.windows?.get !== 'function' || typeof input.chromeApi?.tabs?.query !== 'function' ||
    !input.authority || !input.auditStarter || !coordinator ||
    typeof input.auditStarter.resumePrivacyPausedAudit !== 'function' ||
    typeof input.personaStart?.start !== 'function' || typeof input.personaStart?.rehydrate !== 'function' ||
    typeof input.personaCoordinator?.setMode !== 'function' ||
    typeof input.personaCoordinator?.readerCommand !== 'function' ||
    typeof input.personaCoordinator?.stop !== 'function' ||
    typeof input.personaCoordinator?.autonomousStop !== 'function' ||
    typeof coordinator.attachPanelPort !== 'function' || typeof coordinator.withWindowLock !== 'function' ||
    typeof input.chromeAdapter?.probeDocumentIdentity !== 'function' || typeof input.chromeAdapter?.getEvidenceUrl !== 'function' ||
    typeof input.readReportRevision !== 'function' || typeof input.buildPanelResultBundle !== 'function' ||
    typeof input.revokeViewOnly !== 'function' || typeof input.epochNow !== 'function' ||
    typeof input.modelNow !== 'function' || typeof input.createAuditId !== 'function' ||
    typeof input.highlightController?.currentState !== 'function' ||
    typeof input.highlightController?.availability !== 'function' ||
    typeof input.highlightController?.highlight !== 'function' ||
    typeof input.highlightController?.clear !== 'function' ||
    typeof input.highlightController?.invalidateContent !== 'function' ||
    typeof input.highlightSessionBridge?.createPanelSender !== 'function' ||
    typeof input.highlightSessionBridge?.createReviewSender !== 'function' ||
    typeof input.publishHighlightState !== 'function' ||
    (hasUrlAudit && (typeof input.urlAuditStarter?.beginAuthorizedUrlAudit !== 'function' ||
      typeof input.rawNavigationVault?.put !== 'function' || typeof input.rawNavigationVault?.clearAudit !== 'function' ||
      typeof input.createOwnershipId !== 'function' ||
      typeof input.authority.prepareNavigationForPanel !== 'function')) ||
    (Object.hasOwn(input, 'reportOperations') && (!reportOperations ||
      Object.values(reportOperations).some(operation => typeof operation !== 'function')))) {
    throw new TypeError('SIDE_PANEL_ROUTER_INVALID');
  }

  async function proveSurface(sender, surface, claimedWindowId) {
    return deriveTrustedExtensionContext({
      sender, chromeApi: input.chromeApi, surface, claimedWindowId,
    });
  }

  async function selectedTarget(context, launchTabId) {
    const tabs = await queryTabs(input.chromeApi, { active: true, windowId: context.windowId });
    const tab = activeTab(tabs, context.windowId);
    if (!tab || tab.id !== launchTabId) throw new Error('TARGET_UNAVAILABLE');
    const proof = proofRecord(await input.chromeAdapter.probeDocumentIdentity(tab.id), tab.id, context.windowId);
    if (!proof) throw new Error('TARGET_UNAVAILABLE');
    const initialUrlEvidence = await input.chromeAdapter.getEvidenceUrl(tab.id, false);
    if (!canonicalHttpUrl(initialUrlEvidence)) throw new Error('TARGET_UNAVAILABLE');
    return freeze({ proof, initialUrlEvidence });
  }

  async function preparePanel(envelope, sender, launchTabId) {
    let context;
    try { context = await proveSurface(sender, PANEL_SURFACE, envelope.windowId); }
    catch { return fail('CONTEXT_DENIED'); }
    try {
      const target = await selectedTarget(context, launchTabId);
      const prepared = await input.authority.prepare({
        kind: 'attached', tabId: target.proof.tabId, windowId: target.proof.windowId,
        documentId: target.proof.documentId, initialUrlEvidence: target.initialUrlEvidence,
        initialUrlSessionDigest: target.proof.urlSessionDigest, createdBy: 'user',
        allowedIntent: 'start-audit', issuer: context.issuer,
      });
      if (prepared?.ok !== true || !CAPABILITY.test(prepared.capabilityId ?? '') || !Number.isSafeInteger(prepared.expiresAt)) throw new Error();
      return freeze({ ok: true, requestId: envelope.requestId, capabilityId: prepared.capabilityId });
    } catch { return fail('TARGET_UNAVAILABLE'); }
  }

  async function preparePanelNavigation(envelope, sender) {
    if (!hasUrlAudit) return fail('FEATURE_UNAVAILABLE');
    let context;
    try { context = await proveSurface(sender, PANEL_SURFACE, envelope.windowId); }
    catch { return fail('CONTEXT_DENIED'); }
    try {
      const prepared = await input.authority.prepareNavigationForPanel({
        intent: 'single', senderContext: context,
      });
      if (prepared?.ok !== true || !CAPABILITY.test(prepared.capabilityId ?? '') ||
        !Number.isSafeInteger(prepared.expiresAt)) throw new Error();
      return freeze({ ok: true, requestId: envelope.requestId, capabilityId: prepared.capabilityId });
    } catch { return fail('TARGET_UNAVAILABLE'); }
  }

  async function preparePanelPersona(envelope, sender, launchTabId) {
    let context;
    try { context = await proveSurface(sender, PANEL_SURFACE, envelope.windowId); }
    catch { return fail('CONTEXT_DENIED'); }
    try {
      const target = await selectedTarget(context, launchTabId);
      const prepared = await input.authority.prepare({
        kind: 'attached', tabId: target.proof.tabId, windowId: target.proof.windowId,
        documentId: target.proof.documentId, initialUrlEvidence: target.initialUrlEvidence,
        initialUrlSessionDigest: target.proof.urlSessionDigest, createdBy: 'user',
        allowedIntent: 'start-persona', issuer: context.issuer,
      });
      if (prepared?.ok !== true || !CAPABILITY.test(prepared.capabilityId ?? '') ||
        !Number.isSafeInteger(prepared.expiresAt)) throw new Error();
      return freeze({ ok: true, requestId: envelope.requestId, capabilityId: prepared.capabilityId });
    } catch { return fail('TARGET_UNAVAILABLE'); }
  }

  function personaConsumer(context) {
    return freeze({
      extensionId: input.chromeApi.runtime.id,
      documentId: context.issuer.documentId,
      path: PANEL_SURFACE.path,
      windowId: context.windowId,
    });
  }

  function projectPersonaResult(result, stopped = false) {
    const failed = exact(result, ['ok', 'code']);
    if (failed?.ok === false) return fail(PERSONA_CODES.has(failed.code) ? failed.code : 'PERSONA_RUNTIME_FAILED');
    const success = exact(result, ['ok', 'lease']);
    if (!success || success.ok !== true || !success.lease || typeof success.lease !== 'object') {
      return fail('PERSONA_RUNTIME_FAILED');
    }
    if (stopped) return freeze({ ok: true, lease: null });
    const leaseId = own(success.lease, 'leaseId');
    const activeMode = own(success.lease, 'activeMode');
    const expiresAt = own(success.lease, 'expiresAt');
    if (!LEASE_ID.test(leaseId ?? '') || !PERSONA_MODES.has(activeMode) ||
      !Number.isSafeInteger(expiresAt) || expiresAt < 0) return fail('PERSONA_RUNTIME_FAILED');
    return freeze({ ok: true, lease: { leaseId, activeMode, expiresAt } });
  }

  function canonicalReaderText(value, maximum, allowEmpty) {
    if (typeof value !== 'string' || /[\u0000-\u001F\u007F]/u.test(value)) return null;
    const normalized = Array.from(value.replace(/\s+/gu, ' ').trim()).slice(0, maximum).join('');
    return (allowEmpty || normalized) && normalized === value ? normalized : null;
  }

  function projectReaderState(value) {
    const readerState = exact(value, READER_STATE_KEYS);
    if (!readerState || readerState.version !== 1 ||
      !['idle', 'playing', 'paused'].includes(readerState.playback) ||
      !Number.isSafeInteger(readerState.index) || !Number.isSafeInteger(readerState.total) ||
      readerState.total < 0 || readerState.total > 2000 ||
      typeof readerState.canPrevious !== 'boolean' || typeof readerState.canNext !== 'boolean' ||
      !['available', 'unavailable', 'busy', 'error'].includes(readerState.speechAvailability) ||
      typeof readerState.rate !== 'number' || !Number.isFinite(readerState.rate) ||
      readerState.rate < 0.5 || readerState.rate > 2) return null;
    const caption = canonicalReaderText(readerState.caption, 2048, true);
    const voiceId = canonicalReaderText(readerState.voiceId, 200, true);
    if (caption === null || voiceId === null) return null;
    if (readerState.playback === 'idle') {
      if (readerState.index !== -1 || readerState.total !== 0 || caption !== '' ||
        readerState.canPrevious || readerState.canNext) return null;
    } else if (readerState.total < 1 || readerState.index < 0 || readerState.index >= readerState.total ||
      caption === '' || readerState.canPrevious !== (readerState.index > 0) ||
      readerState.canNext !== (readerState.index < readerState.total - 1)) return null;
    return freeze({ ...readerState, caption, voiceId });
  }

  function projectReaderResult(result) {
    const failed = exact(result, ['ok', 'code']);
    if (failed?.ok === false) {
      return fail(PERSONA_CODES.has(failed.code) ? failed.code : 'PERSONA_READER_RUNTIME_FAILED');
    }
    const success = exact(result, ['ok', 'kind', 'state']);
    const readerState = success?.ok === true && success.kind === 'state'
      ? projectReaderState(success.state)
      : null;
    return readerState
      ? freeze({ ok: true, readerState })
      : fail('PERSONA_READER_RUNTIME_FAILED');
  }

  function preferredLocalVoice(result) {
    const success = exact(result, ['ok', 'kind', 'status', 'voices']);
    if (!success || success.ok !== true || success.kind !== 'voices' ||
      !['available', 'unavailable'].includes(success.status) || !Array.isArray(success.voices)) return null;
    let length;
    let keys;
    try {
      length = Object.getOwnPropertyDescriptor(success.voices, 'length')?.value;
      keys = Reflect.ownKeys(success.voices);
    } catch { return null; }
    if (!Number.isSafeInteger(length) || length < 0 || length > 128 || keys.length !== length + 1 ||
      (success.status === 'unavailable' && length !== 0)) return null;
    const voices = [];
    const ids = new Set();
    for (let index = 0; index < length; index += 1) {
      let voice;
      try {
        const descriptor = Object.getOwnPropertyDescriptor(success.voices, String(index));
        voice = descriptor?.enumerable && Object.hasOwn(descriptor, 'value')
          ? exact(descriptor.value, ['id', 'label', 'lang'])
          : null;
      } catch { return null; }
      const id = voice && canonicalReaderText(voice.id, 200, false);
      const label = voice && canonicalReaderText(voice.label, 200, false);
      const lang = voice && canonicalReaderText(voice.lang, 64, true);
      if (!voice || id === null || label === null || lang === null || ids.has(id)) return null;
      ids.add(id);
      voices.push({ id, lang });
    }
    if (success.status !== 'available' || voices.length === 0) return false;
    return voices.find(voice => voice.lang.toLowerCase() === 'pt-br') ??
      voices.find(voice => voice.lang.toLowerCase().startsWith('pt-')) ?? voices[0];
  }

  async function withPersonaContext(envelope, sender, operation) {
    let context;
    try { context = await proveSurface(sender, PANEL_SURFACE, envelope.windowId); }
    catch { return fail('CONTEXT_DENIED'); }
    try { return projectPersonaResult(await operation(context)); }
    catch { return fail('PERSONA_RUNTIME_FAILED'); }
  }

  function startPersona(envelope, sender) {
    return withPersonaContext(envelope, sender, context => input.personaStart.start({
      capabilityId: envelope.capabilityId,
      mode: envelope.mode,
      senderContext: context,
      consumer: personaConsumer(context),
    }));
  }

  function rehydratePersona(envelope, sender) {
    return withPersonaContext(envelope, sender, context => input.personaStart.rehydrate({
      capabilityId: envelope.capabilityId,
      senderContext: context,
      consumer: personaConsumer(context),
    }));
  }

  function setPersonaMode(envelope, sender) {
    return withPersonaContext(envelope, sender, context => input.personaCoordinator.setMode({
      leaseId: envelope.leaseId,
      consumer: personaConsumer(context),
      mode: envelope.mode,
    }));
  }

  async function readerPersona(envelope, sender) {
    let context;
    try { context = await proveSurface(sender, PANEL_SURFACE, envelope.windowId); }
    catch { return fail('CONTEXT_DENIED'); }
    const command = envelope.type === 'PANEL_READER_STATE'
      ? freeze({ version: 1, op: 'state' })
      : READER_ACTIONS.has(envelope.action)
        ? freeze({ version: 1, op: 'action', action: envelope.action })
        : null;
    if (!command) return fail('INVALID_MESSAGE');
    try {
      return projectReaderResult(await input.personaCoordinator.readerCommand({
        leaseId: envelope.leaseId,
        consumer: personaConsumer(context),
        command,
      }));
    } catch { return fail('PERSONA_READER_RUNTIME_FAILED'); }
  }

  async function enableReaderVoice(envelope, sender) {
    let context;
    try { context = await proveSurface(sender, PANEL_SURFACE, envelope.windowId); }
    catch { return fail('CONTEXT_DENIED'); }
    const consumer = personaConsumer(context);
    let inventory;
    try {
      inventory = await input.personaCoordinator.readerCommand({
        leaseId: envelope.leaseId,
        consumer,
        command: freeze({ version: 1, op: 'voices', explicitUserGesture: true }),
      });
    } catch { return fail('PERSONA_READER_RUNTIME_FAILED'); }
    const failed = exact(inventory, ['ok', 'code']);
    if (failed?.ok === false) {
      return fail(PERSONA_CODES.has(failed.code) ? failed.code : 'PERSONA_READER_RUNTIME_FAILED');
    }
    const selected = preferredLocalVoice(inventory);
    if (selected === false) return fail('PERSONA_READER_VOICE_UNAVAILABLE');
    if (!selected) return fail('PERSONA_READER_RUNTIME_FAILED');
    try {
      return projectReaderResult(await input.personaCoordinator.readerCommand({
        leaseId: envelope.leaseId,
        consumer,
        command: freeze({ version: 1, op: 'preferences', voiceId: selected.id, rate: 1 }),
      }));
    } catch { return fail('PERSONA_READER_RUNTIME_FAILED'); }
  }

  async function stopPersona(envelope, sender) {
    let context;
    try { context = await proveSurface(sender, PANEL_SURFACE, envelope.windowId); }
    catch { return fail('CONTEXT_DENIED'); }
    try {
      return projectPersonaResult(await input.personaCoordinator.stop({
        leaseId: envelope.leaseId,
        consumer: personaConsumer(context),
        explicit: true,
      }), true);
    } catch { return fail('PERSONA_RUNTIME_FAILED'); }
  }

  async function autonomousPersonaStop(envelope, sender) {
    const extensionId = own(sender, 'id');
    const documentId = own(sender, 'documentId');
    const frameId = own(sender, 'frameId');
    const senderTab = own(sender, 'tab');
    const tabId = own(senderTab, 'id');
    const windowId = own(senderTab, 'windowId');
    if (extensionId !== input.chromeApi.runtime.id || frameId !== 0 ||
      !Number.isSafeInteger(tabId) || tabId <= 0 || !safeChromeId(windowId) ||
      typeof documentId !== 'string' || documentId.length < 1 || documentId.length > 512 ||
      /[\u0000-\u001F\u007F]/u.test(documentId) ||
      !LEASE_ID.test(envelope.leaseId ?? '') || !AUTONOMOUS_PERSONA_REASONS.has(envelope.reason)) {
      return fail('CONTEXT_DENIED');
    }
    try {
      await input.personaCoordinator.autonomousStop({
        leaseId: envelope.leaseId,
        tabId,
        windowId,
        documentId,
        reason: envelope.reason,
      });
      return freeze({ ok: true, state: 'acknowledged' });
    } catch {
      return fail('PERSONA_AUTONOMOUS_STOP_UNAVAILABLE');
    }
  }

  async function startAttached(envelope, sender) {
    let context;
    try { context = await proveSurface(sender, PANEL_SURFACE, envelope.windowId); }
    catch { return fail('CONTEXT_DENIED'); }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let auditId;
      try { auditId = input.createAuditId(); } catch { return fail('AUDIT_START_FAILED'); }
      if (!AUDIT_ID.test(auditId ?? '')) return fail('AUDIT_START_FAILED');
      try {
        const started = await input.auditStarter.beginAuthorizedAudit({
          capabilityId: envelope.capabilityId, eventNonce: null, auditId,
          capturePolicy: createCapturePolicyV1({ mode: envelope.captureMode, includeQuery: false }),
          retentionPreference: Object.freeze({ version: 1, deleteAfterCompleteExport: false }),
          senderContext: context,
        });
        const response = started?.response;
        if (response?.ok === true && response.auditId === auditId && response.state === 'running') {
          return freeze({ ok: true, auditId, state: 'running' });
        }
        if (response?.ok === false && response.code === 'AUDIT_ID_COLLISION') continue;
        return response?.ok === false && START_CODES.has(response.code) ? fail(response.code) : fail('AUDIT_START_FAILED');
      } catch { return fail('AUDIT_START_FAILED'); }
    }
    return fail('AUDIT_ID_COLLISION');
  }

  async function startUrl(envelope, sender) {
    if (!hasUrlAudit || !['full-evidence', 'element-only', 'no-pixels'].includes(envelope.captureMode) ||
      envelope.includeQuery !== false ||
      envelope.deleteAfterCompleteExport !== false || !canonicalHttpUrl(envelope.url)) return fail('AUDIT_START_FAILED');
    let context;
    try { context = await proveSurface(sender, PANEL_SURFACE, envelope.windowId); }
    catch { return fail('CONTEXT_DENIED'); }
    let auditId = null;
    try {
      auditId = input.createAuditId();
      const ownershipId = input.createOwnershipId();
      if (!AUDIT_ID.test(auditId ?? '') || !/^owner_[A-Za-z0-9_-]{22}$/u.test(ownershipId ?? '')) throw new Error();
      const issued = exact(await input.rawNavigationVault.put(envelope.url, {
        auditId, purpose: 'single-url', ttlMs: 600_000, includeQuery: false,
      }), ['navigationToken', 'evidenceUrl', 'sessionDigest', 'expiresAt']);
      const evidenceUrl = issued && exact(issued.evidenceUrl, ['version', 'href', 'queryIncluded', 'redactedSegments']);
      if (!issued || !/^[A-Za-z0-9_-]{22}$/u.test(issued.navigationToken ?? '') ||
        !evidenceUrl || !isEvidenceUrlV1(evidenceUrl) || evidenceUrl.queryIncluded !== false ||
        !/^hmac-sha256:[A-Za-z0-9_-]{43}$/u.test(issued.sessionDigest ?? '') ||
        !Number.isSafeInteger(issued.expiresAt)) throw new Error();
      const started = await input.urlAuditStarter.beginAuthorizedUrlAudit({
        capabilityId: envelope.capabilityId,
        auditId,
        senderContext: context,
        capturePolicy: createCapturePolicyV1({ mode: envelope.captureMode, includeQuery: false }),
        retentionPreference: Object.freeze({ version: 1, deleteAfterCompleteExport: false }),
        plan: freeze({
          kind: 'single', ownershipId, navigationToken: issued.navigationToken,
          navigationPurpose: 'single-url', evidenceUrl: { ...evidenceUrl }, sessionDigest: issued.sessionDigest,
        }),
      });
      const response = started?.response;
      if (response?.ok === true && response.auditId === auditId && response.state === 'running') {
        return freeze({ ok: true, auditId, state: 'running' });
      }
      try { await input.rawNavigationVault.clearAudit(auditId); } catch { return fail('AUDIT_RECOVERY_REQUIRED'); }
      return response?.ok === false && START_CODES.has(response.code) ? fail(response.code) : fail('AUDIT_START_FAILED');
    } catch {
      if (AUDIT_ID.test(auditId ?? '')) {
        try { await input.rawNavigationVault.clearAudit(auditId); }
        catch { return fail('AUDIT_RECOVERY_REQUIRED'); }
      }
      return fail('AUDIT_START_FAILED');
    }
  }

  async function confirmPixelCapture(envelope, sender) {
    try {
      const authorized = exact(await input.authority.authorizeSession({
        sessionCapabilityId: envelope.sessionCapabilityId, auditId: envelope.auditId,
        consumer: 'panel', intent: 'confirm-pixels', sender,
        claimedWindowId: envelope.windowId,
      }), ['ok', 'session', 'context']);
      const session = authorized?.session;
      const context = authorized?.context;
      const targetBinding = own(session, 'targetBinding');
      const attachedBinding = exact(targetBinding, ['kind', 'tabId', 'documentId', 'urlSessionDigest']);
      const disposableBinding = exact(targetBinding, ['kind', 'ownershipId', 'state']);
      const attachedConfirmation = envelope.type === 'CONFIRM_PIXEL_CAPTURE' &&
        own(session, 'mode') === 'attached' && attachedBinding?.kind === 'attached' &&
        safeChromeId(attachedBinding.tabId) && typeof attachedBinding.documentId === 'string' &&
        attachedBinding.documentId.length >= 1 && attachedBinding.documentId.length <= 512 &&
        !/[\u0000-\u001F\u007F]/u.test(attachedBinding.documentId) &&
        DIGEST.test(attachedBinding.urlSessionDigest ?? '');
      const disposableConfirmation = envelope.type === 'PANEL_CONFIRM_PIXEL_CAPTURE' &&
        own(session, 'mode') === 'single' && disposableBinding?.kind === 'disposable' &&
        /^owner_[A-Za-z0-9_-]{22}$/u.test(disposableBinding.ownershipId ?? '') &&
        disposableBinding.state === 'retained-for-consent';
      if (authorized?.ok !== true || own(session, 'auditId') !== envelope.auditId ||
        own(session, 'sessionCapabilityId') !== envelope.sessionCapabilityId ||
        own(session, 'windowId') !== envelope.windowId || own(context, 'windowId') !== envelope.windowId ||
        own(session, 'state') !== 'privacy-paused' ||
        (!attachedConfirmation && !disposableConfirmation)) return fail('PIXEL_CONFIRM_DENIED');

      const resumeRequest = disposableConfirmation ? {
        auditId: envelope.auditId,
        sessionCapabilityId: envelope.sessionCapabilityId,
        windowId: envelope.windowId,
        mode: envelope.mode,
      } : {
        auditId: envelope.auditId,
        sessionCapabilityId: envelope.sessionCapabilityId,
        windowId: envelope.windowId,
        consentId: envelope.consentId,
        mode: envelope.mode,
      };
      const resumed = exact(await input.auditStarter.resumePrivacyPausedAudit(resumeRequest), [
        'response', 'sessionCapabilityId', 'completion',
      ]);
      if (!resumed || resumed.sessionCapabilityId !== envelope.sessionCapabilityId) {
        return fail('PIXEL_CONFIRM_DENIED');
      }
      const success = exact(resumed.response, ['ok', 'auditId', 'state']);
      if (success?.ok === true && success.auditId === envelope.auditId &&
        ['running', 'privacy-paused'].includes(success.state) && resumed.completion instanceof Promise) {
        return freeze({ ok: true, auditId: envelope.auditId, state: success.state });
      }
      const failed = exact(resumed.response, ['ok', 'code']);
      if (failed?.ok === false && PIXEL_CONFIRM_CODES.has(failed.code) && resumed.completion === null) {
        return fail(failed.code);
      }
      return fail('PIXEL_CONFIRM_DENIED');
    } catch {
      return fail('PIXEL_CONFIRM_DENIED');
    }
  }

  async function cancel(envelope, sender) {
    try {
      const authorized = await input.authority.authorizeSession({
        sessionCapabilityId: envelope.sessionCapabilityId, auditId: envelope.auditId,
        consumer: 'panel', intent: 'cancel', sender,
        claimedWindowId: envelope.windowId,
      });
      if (authorized?.ok !== true || authorized.session?.auditId !== envelope.auditId ||
        authorized.session.sessionCapabilityId !== envelope.sessionCapabilityId ||
        !safeChromeId(authorized.context?.windowId)) return fail('AUDIT_CANCEL_DENIED');
      const result = await input.auditStarter.abortAuthorizedAudit({
        auditId: envelope.auditId, sessionCapabilityId: envelope.sessionCapabilityId,
        windowId: authorized.context.windowId, reasonCode: 'USER_CANCELLED',
      });
      const success = exact(result, ['ok', 'auditId', 'state']);
      if (success?.ok === true && success.auditId === envelope.auditId &&
        ['cancelling', 'revoked'].includes(success.state)) return freeze(success);
      const failed = exact(result, ['ok', 'code']);
      return failed?.ok === false && ['AUDIT_CANCEL_DENIED', 'AUDIT_CANCEL_TOO_LATE'].includes(failed.code)
        ? fail(failed.code) : fail('AUDIT_CANCEL_DENIED');
    } catch { return fail('AUDIT_CANCEL_DENIED'); }
  }

  async function rehydrate(envelope, sender) {
    let minted = null;
    let recoveryRequired = false;
    try {
      const reportRevision = await input.readReportRevision({ auditId: envelope.auditId });
      if (!reportRevision) return fail('AUDIT_REHYDRATE_DENIED');
      const resultBundle = await input.buildPanelResultBundle({ reportRevision });
      const context = await proveSurface(sender, PANEL_SURFACE, envelope.windowId);
      minted = await input.authority.rehydrateViewOnly({ auditId: envelope.auditId, windowId: context.windowId, mode: 'attached' });
      if (minted?.ok !== true || minted.auditId !== envelope.auditId || !CAPABILITY.test(minted.sessionCapabilityId ?? '') ||
        !Number.isSafeInteger(minted.expiresAt)) throw new Error('mint-denied');
      const createdAt = input.epochNow();
      if (!Number.isSafeInteger(createdAt) || createdAt < 0 || createdAt >= minted.expiresAt) throw new Error('clock-denied');
      let registration;
      try {
        registration = await input.panelCoordinator.withWindowLock(context.windowId, scope =>
          scope.registerAndPublishViewOnly({
            auditId: envelope.auditId, sessionCapabilityId: minted.sessionCapabilityId,
            windowId: context.windowId, createdAt, expiresAt: minted.expiresAt, resultBundle,
          }));
      } catch { registration = null; }
      const registered = exact(registration, ['registered', 'delivered']);
      if (!registered || registered.registered !== true || registered.delivered !== true) {
        const denied = exact(registration, ['registered', 'delivered', 'code']);
        recoveryRequired = denied?.registered === false && denied.delivered === false &&
          denied.code === 'AUDIT_RECOVERY_REQUIRED';
        throw new Error('register-denied');
      }
      return freeze({ ok: true, auditId: envelope.auditId, state: 'view-only' });
    } catch {
      if (minted?.ok === true && CAPABILITY.test(minted.sessionCapabilityId ?? '')) {
        let revoked = false;
        try {
          revoked = await input.revokeViewOnly({
            sessionCapabilityId: minted.sessionCapabilityId,
            auditId: envelope.auditId,
          });
        } catch { /* cleanup remains unconfirmed */ }
        if (revoked !== true) return fail('AUDIT_RECOVERY_REQUIRED');
      }
      if (recoveryRequired) return fail('AUDIT_RECOVERY_REQUIRED');
      return fail('AUDIT_REHYDRATE_DENIED');
    }
  }

  async function openReport(envelope, sender) {
    if (typeof input.reportLaunch?.openRegisteredReport !== 'function') return fail('FEATURE_UNAVAILABLE');
    try {
      const authorized = await input.authority.authorizeSession({
        sessionCapabilityId: envelope.sessionCapabilityId, auditId: envelope.auditId,
        consumer: 'panel', intent: 'open-report', sender,
        claimedWindowId: envelope.windowId,
      });
      if (authorized?.ok !== true || authorized.session?.auditId !== envelope.auditId ||
        authorized.session?.sessionCapabilityId !== envelope.sessionCapabilityId ||
        !['result', 'view-only'].includes(authorized.session?.state) || !safeChromeId(authorized.context?.windowId)) {
        return fail('REPORT_OPEN_DENIED');
      }
      const opened = await input.reportLaunch.openRegisteredReport({
        auditId: envelope.auditId,
        windowId: authorized.context.windowId,
        sourceSessionCapabilityId: envelope.sessionCapabilityId,
        sourceSessionState: authorized.session.state,
      });
      return opened?.ok === true ? freeze({ ok: true, auditId: envelope.auditId, state: 'connected' }) : fail('REPORT_OPEN_DENIED');
    } catch { return fail('REPORT_OPEN_DENIED'); }
  }

  async function mutateReport(envelope, sender, intent) {
    if (!reportOperations || typeof input.reportLaunch?.authorizeIntent !== 'function') return fail('FEATURE_UNAVAILABLE');
    try {
      const authorization = await input.reportLaunch.authorizeIntent({
        auditId: envelope.auditId,
        sessionCapabilityId: envelope.sessionCapabilityId,
        intent,
        sender,
      });
      if (authorization?.ok !== true || authorization.auditId !== envelope.auditId || authorization.intent !== intent) {
        return fail('REPORT_OPERATION_DENIED');
      }
      if (intent === 'review-commit') return await reportOperations.commitReviewDecision({
        auditId: envelope.auditId, itemId: envelope.itemId, occurrenceId: envelope.occurrenceId,
        answer: envelope.answer, evaluator: envelope.evaluator, decidedAt: envelope.decidedAt,
        mode: envelope.mode, note: envelope.note,
      });
      if (intent === 'delete-audit') return await reportOperations.deleteAudit({ auditId: envelope.auditId });
      return await reportOperations.deleteAllAudits();
    } catch { return fail('REPORT_OPERATION_FAILED'); }
  }

  function projectHighlightFailure(result) {
    const failed = exact(result, ['ok', 'code']);
    return failed?.ok === false
      ? fail(HIGHLIGHT_FAILURE_CODES.has(failed.code) ? failed.code : 'HIGHLIGHT_OPERATION_FAILED')
      : null;
  }

  async function highlightIntent(envelope, sender, panelWindowId = null) {
    let token;
    try {
      token = panelWindowId === null
        ? input.highlightSessionBridge.createReviewSender({ sender })
        : input.highlightSessionBridge.createPanelSender({ sender, windowId: panelWindowId });
    } catch { return fail('CONTEXT_DENIED'); }
    if (!token || typeof token !== 'object') return fail('CONTEXT_DENIED');
    if (panelWindowId === null && ['HIGHLIGHT_OCCURRENCE', 'CLEAR_HIGHLIGHT'].includes(envelope.type)) {
      if (typeof input.reportLaunch?.returnToSource !== 'function') return fail('HIGHLIGHT_RETURN_FAILED');
      let returned;
      try {
        returned = await input.reportLaunch.returnToSource({
          sessionCapabilityId: envelope.sessionCapabilityId,
          auditId: envelope.auditId,
          sender,
        });
      } catch {
        return fail('HIGHLIGHT_RETURN_FAILED');
      }
      const focused = exact(returned, ['ok', 'state']);
      if (focused?.ok !== true || focused.state !== 'source-focused') return fail('HIGHLIGHT_RETURN_FAILED');
    }
    const request = {
      sessionCapabilityId: envelope.sessionCapabilityId,
      auditId: envelope.auditId,
      ...(['GET_HIGHLIGHT_STATE', 'CLEAR_HIGHLIGHT'].includes(envelope.type)
        ? {} : { occurrenceId: envelope.occurrenceId }),
      sender: token,
    };
    let result;
    try {
      if (envelope.type === 'GET_HIGHLIGHT_STATE') {
        result = await input.highlightController.currentState(request);
        const failed = projectHighlightFailure(result);
        if (failed) return failed;
        const success = exact(result, ['ok', 'highlight']);
        const clearState = exact(success?.highlight, ['state']);
        const activeState = exact(success?.highlight, ['state', 'occurrenceId']);
        if (success?.ok === true && clearState?.state === 'clear') {
          return freeze({ ok: true, highlight: { state: 'clear' } });
        }
        if (success?.ok === true && activeState?.state === 'active' &&
          OCCURRENCE_ID.test(activeState.occurrenceId ?? '')) {
          return freeze({ ok: true, highlight: { state: 'active', occurrenceId: activeState.occurrenceId } });
        }
        return fail('HIGHLIGHT_OPERATION_FAILED');
      }
      if (envelope.type === 'GET_HIGHLIGHT_AVAILABILITY') {
        result = await input.highlightController.availability(request);
        const failed = projectHighlightFailure(result);
        if (failed) return failed;
        const available = exact(result, ['ok', 'bindingStatus']);
        const status = exact(available?.bindingStatus, ['state']) ??
          exact(available?.bindingStatus, ['state', 'reason']);
        if (available?.ok !== true || !status) return fail('HIGHLIGHT_OPERATION_FAILED');
        if (status.state === 'available' && Reflect.ownKeys(status).length === 1) {
          return freeze({ ok: true, bindingStatus: { state: 'available' } });
        }
        if (status.state === 'unavailable' && HIGHLIGHT_UNAVAILABLE_REASONS.has(status.reason)) {
          return freeze({ ok: true, bindingStatus: { state: 'unavailable', reason: status.reason } });
        }
        return fail('HIGHLIGHT_OPERATION_FAILED');
      }
      if (envelope.type === 'HIGHLIGHT_OCCURRENCE') {
        result = await input.highlightController.highlight(request);
        const failed = projectHighlightFailure(result);
        if (failed) return failed;
        const success = exact(result, ['ok', 'highlight']);
        const state = exact(success?.highlight, ['state', 'occurrenceId']);
        if (success?.ok !== true || state?.state !== 'active' || state.occurrenceId !== envelope.occurrenceId) {
          return fail('HIGHLIGHT_OPERATION_FAILED');
        }
        const event = freeze({
          version: 1, type: 'HIGHLIGHT_STATE_CHANGED', auditId: envelope.auditId,
          occurrenceId: envelope.occurrenceId, state: 'active',
        });
        try { await input.publishHighlightState(event); } catch { /* the correlated response still carries authoritative state */ }
        return freeze({ ok: true, highlight: { state: 'active', occurrenceId: envelope.occurrenceId } });
      }
      result = await input.highlightController.clear(request);
      const failed = projectHighlightFailure(result);
      if (failed) return failed;
      const success = exact(result, ['ok', 'highlight']);
      const state = exact(success?.highlight, ['state']);
      if (success?.ok !== true || state?.state !== 'clear') return fail('HIGHLIGHT_OPERATION_FAILED');
      const event = freeze({
        version: 1, type: 'HIGHLIGHT_STATE_CHANGED', auditId: envelope.auditId,
        occurrenceId: null, state: 'clear',
      });
      try { await input.publishHighlightState(event); } catch { /* the correlated response still carries authoritative state */ }
      return freeze({ ok: true, highlight: { state: 'clear' } });
    } catch { return fail('HIGHLIGHT_OPERATION_FAILED'); }
  }

  async function invalidateContentHighlight(envelope, sender) {
    let result;
    try {
      result = await input.highlightController.invalidateContent({ message: envelope, sender });
    } catch {
      return fail('HIGHLIGHT_INVALIDATION_IGNORED');
    }
    const success = exact(result, ['ok', 'auditId', 'highlight']);
    const state = exact(success?.highlight, ['state']);
    if (success?.ok !== true || !AUDIT_ID.test(success.auditId ?? '') || state?.state !== 'clear') {
      return fail('HIGHLIGHT_INVALIDATION_IGNORED');
    }
    const event = freeze({
      version: 1, type: 'HIGHLIGHT_STATE_CHANGED', auditId: success.auditId,
      occurrenceId: null, state: 'clear',
    });
    try { await input.publishHighlightState(event); }
    catch { /* durable state is already clear; consumers reprove before their next action */ }
    return freeze({ ok: true, highlight: { state: 'clear' } });
  }

  async function dispatch(rawRequest) {
    const request = exact(rawRequest, ['envelope', 'sender']) ??
      exact(rawRequest, ['envelope', 'sender', 'launchTabId']) ??
      exact(rawRequest, ['envelope', 'sender', 'launchTabId', 'panelWindowId']) ??
      exact(rawRequest, ['envelope', 'sender', 'panelWindowId']);
    if (!request || !Object.isFrozen(request.envelope)) return fail('INVALID_MESSAGE');
    const parsed = parseWorkerMessage(request.envelope);
    if (!parsed.ok) return parsed.code === 'MESSAGE_TOO_LARGE' ? fail('MESSAGE_TOO_LARGE') : fail('INVALID_MESSAGE');
    const envelope = parsed.value;
    const panelIntent = PANEL_PORT_TYPES.has(envelope.type);
    const highlight = HIGHLIGHT_TYPES.has(envelope.type);
    const hasLaunchTab = Object.hasOwn(request, 'launchTabId');
    const hasPanelWindow = Object.hasOwn(request, 'panelWindowId');
    if (panelIntent && (!hasLaunchTab || hasPanelWindow || !safeChromeId(request.launchTabId))) return fail('CONTEXT_DENIED');
    if (highlight) {
      const panelLane = hasLaunchTab && hasPanelWindow && safeChromeId(request.launchTabId) &&
        safeChromeId(request.panelWindowId);
      const reportLane = !hasLaunchTab && !hasPanelWindow;
      if (!panelLane && !reportLane) return fail('CONTEXT_DENIED');
    } else if (!panelIntent && (hasLaunchTab || hasPanelWindow)) return fail('CONTEXT_DENIED');
    if (envelope.type === 'PREPARE_PANEL_CAPABILITY') return preparePanel(envelope, request.sender, request.launchTabId);
    if (envelope.type === 'PREPARE_PANEL_NAVIGATION_CAPABILITY') return preparePanelNavigation(envelope, request.sender);
    if (envelope.type === 'PREPARE_PANEL_PERSONA_CAPABILITY') return preparePanelPersona(envelope, request.sender, request.launchTabId);
    if (envelope.type === 'PANEL_START_ATTACHED_AUDIT') return startAttached(envelope, request.sender);
    if (envelope.type === 'PANEL_START_URL_AUDIT') return startUrl(envelope, request.sender);
    if (['CONFIRM_PIXEL_CAPTURE', 'PANEL_CONFIRM_PIXEL_CAPTURE'].includes(envelope.type)) {
      return confirmPixelCapture(envelope, request.sender);
    }
    if (envelope.type === 'PANEL_START_PERSONA') return startPersona(envelope, request.sender);
    if (envelope.type === 'PANEL_REHYDRATE_PERSONA') return rehydratePersona(envelope, request.sender);
    if (envelope.type === 'PANEL_SET_PERSONA_MODE') return setPersonaMode(envelope, request.sender);
    if (['PANEL_READER_STATE', 'PANEL_READER_ACTION'].includes(envelope.type)) {
      return readerPersona(envelope, request.sender);
    }
    if (envelope.type === 'PANEL_READER_ENABLE_VOICE') {
      return enableReaderVoice(envelope, request.sender);
    }
    if (envelope.type === 'PANEL_STOP_PERSONA') return stopPersona(envelope, request.sender);
    if (envelope.type === 'PANEL_CANCEL_AUDIT') return cancel(envelope, request.sender);
    if (envelope.type === 'PANEL_OPEN_REPORT') return openReport(envelope, request.sender);
    if (highlight) return highlightIntent(envelope, request.sender, hasPanelWindow ? request.panelWindowId : null);
    if (envelope.type === 'AUDITA_HIGHLIGHT_INVALIDATED') {
      return invalidateContentHighlight(envelope, request.sender);
    }
    if (envelope.type === 'AUDITA_PERSONA_AUTONOMOUS_STOP') {
      return autonomousPersonaStop(envelope, request.sender);
    }
    if (envelope.type === 'REPORT_CONNECT') return input.reportLaunch?.connect?.({ auditId: envelope.auditId, sender: request.sender }) ?? fail('FEATURE_UNAVAILABLE');
    if (envelope.type === 'REPORT_RETURN_TO_SOURCE') return input.reportLaunch?.returnToSource?.({
      sessionCapabilityId: envelope.sessionCapabilityId, auditId: envelope.auditId, sender: request.sender,
    }) ?? fail('FEATURE_UNAVAILABLE');
    if (envelope.type === 'REPORT_REQUEST_EXPORT') return input.exportLaunch?.requestExport?.({
      auditId: envelope.auditId, sessionCapabilityId: envelope.sessionCapabilityId, sender: request.sender,
    }) ?? fail('FEATURE_UNAVAILABLE');
    if (envelope.type === 'REPORT_COMMIT_REVIEW_DECISION') return mutateReport(envelope, request.sender, 'review-commit');
    if (envelope.type === 'REPORT_DELETE_AUDIT') return mutateReport(envelope, request.sender, 'delete-audit');
    if (envelope.type === 'REPORT_DELETE_ALL_AUDITS') return mutateReport(envelope, request.sender, 'delete-all');
    if (envelope.type === 'EXPORT_CONNECT') return input.exportLaunch?.connect?.({ auditId: envelope.auditId, sender: request.sender }) ?? fail('FEATURE_UNAVAILABLE');
    if (envelope.type === 'EXPORT_COMPLETE') return input.exportLaunch?.complete?.({
      sessionCapabilityId: envelope.sessionCapabilityId, auditId: envelope.auditId,
      attemptId: envelope.attemptId, sender: request.sender,
    }) ?? fail('FEATURE_UNAVAILABLE');
    if (envelope.type === 'PANEL_REHYDRATE_VIEW') return rehydrate(envelope, request.sender);
    return fail('FEATURE_UNAVAILABLE');
  }

  return Object.freeze({ dispatch });
}
