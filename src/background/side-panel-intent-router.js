import { createCapturePolicyV1 } from '../core/privacy/capture-policy.js';
import {
  PANEL_SURFACE,
  deriveTrustedExtensionContext,
} from './target-capabilities.js';
import { parseWorkerMessage } from './worker-protocol.js';

const FACTORY_KEYS = Object.freeze([
  'chromeApi', 'authority', 'auditStarter', 'panelCoordinator', 'chromeAdapter',
  'readReportRevision', 'buildPanelResultBundle', 'revokeViewOnly',
  'epochNow', 'modelNow', 'createAuditId', 'reportLaunch', 'exportLaunch',
]);
const LEGACY_FACTORY_KEYS = Object.freeze(FACTORY_KEYS.filter(key => !['reportLaunch', 'exportLaunch'].includes(key)));
const AUDIT_ID = /^[A-Za-z0-9._:-]{1,160}$/u;
const CAPABILITY = /^[A-Za-z0-9_-]{20,240}$/u;
const DIGEST = /^hmac-sha256:[A-Za-z0-9_-]{43}$/u;
const START_CODES = new Set([
  'AUDIT_BUSY', 'AUDIT_RECOVERY_REQUIRED', 'TARGET_UNAVAILABLE', 'AUDIT_ID_COLLISION', 'AUDIT_START_FAILED',
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
  const input = exact(raw, FACTORY_KEYS) ?? exact(raw, LEGACY_FACTORY_KEYS);
  const coordinator = exact(input?.panelCoordinator, ['attachPanelPort', 'withWindowLock']);
  if (!input || typeof input.chromeApi?.runtime?.id !== 'string' || typeof input.chromeApi?.runtime?.getContexts !== 'function' ||
    typeof input.chromeApi?.windows?.get !== 'function' || typeof input.chromeApi?.tabs?.query !== 'function' ||
    !input.authority || !input.auditStarter || !coordinator ||
    typeof coordinator.attachPanelPort !== 'function' || typeof coordinator.withWindowLock !== 'function' ||
    typeof input.chromeAdapter?.probeDocumentIdentity !== 'function' || typeof input.chromeAdapter?.getEvidenceUrl !== 'function' ||
    typeof input.readReportRevision !== 'function' || typeof input.buildPanelResultBundle !== 'function' ||
    typeof input.revokeViewOnly !== 'function' || typeof input.epochNow !== 'function' ||
    typeof input.modelNow !== 'function' || typeof input.createAuditId !== 'function') {
    throw new TypeError('SIDE_PANEL_ROUTER_INVALID');
  }

  async function proveSurface(sender, surface, claimedWindowId) {
    return deriveTrustedExtensionContext({
      sender, chromeApi: input.chromeApi, surface, claimedWindowId,
    });
  }

  async function selectedTarget(context) {
    const tabs = await queryTabs(input.chromeApi, { active: true, windowId: context.windowId });
    const tab = activeTab(tabs, context.windowId);
    if (!tab) throw new Error('TARGET_UNAVAILABLE');
    const proof = proofRecord(await input.chromeAdapter.probeDocumentIdentity(tab.id), tab.id, context.windowId);
    if (!proof) throw new Error('TARGET_UNAVAILABLE');
    const initialUrlEvidence = await input.chromeAdapter.getEvidenceUrl(tab.id, false);
    if (!canonicalHttpUrl(initialUrlEvidence)) throw new Error('TARGET_UNAVAILABLE');
    return freeze({ proof, initialUrlEvidence });
  }

  async function preparePanel(envelope, sender) {
    let context;
    try { context = await proveSurface(sender, PANEL_SURFACE, envelope.windowId); }
    catch { return fail('CONTEXT_DENIED'); }
    try {
      const target = await selectedTarget(context);
      const prepared = await input.authority.prepare({
        kind: 'attached', tabId: target.proof.tabId, windowId: target.proof.windowId,
        documentId: target.proof.documentId, initialUrlEvidence: target.initialUrlEvidence,
        initialUrlSessionDigest: target.proof.urlSessionDigest, createdBy: 'user',
        allowedIntent: 'start-audit', issuer: context.issuer,
      });
      if (prepared?.ok !== true || !CAPABILITY.test(prepared.capabilityId ?? '') || !Number.isSafeInteger(prepared.expiresAt)) throw new Error();
      return freeze({ ok: true, requestId: envelope.requestId, capabilityId: prepared.capabilityId, expiresAt: prepared.expiresAt });
    } catch { return fail('TARGET_UNAVAILABLE'); }
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
          capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
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
      if (result?.ok === true && result.auditId === envelope.auditId && result.state === 'cancelling') return freeze(result);
      return result?.ok === false && ['AUDIT_CANCEL_DENIED', 'AUDIT_CANCEL_TOO_LATE'].includes(result.code)
        ? fail(result.code) : fail('AUDIT_CANCEL_DENIED');
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
      if (!registered || registered.registered !== true || typeof registered.delivered !== 'boolean') {
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
      if (authorized?.ok !== true || authorized.session?.auditId !== envelope.auditId || !safeChromeId(authorized.context?.windowId)) {
        return fail('REPORT_OPEN_DENIED');
      }
      const opened = await input.reportLaunch.openRegisteredReport({ auditId: envelope.auditId, windowId: authorized.context.windowId });
      return opened?.ok === true ? freeze({ ok: true, auditId: envelope.auditId, state: 'connected' }) : fail('REPORT_OPEN_DENIED');
    } catch { return fail('REPORT_OPEN_DENIED'); }
  }

  async function dispatch(rawRequest) {
    const request = exact(rawRequest, ['envelope', 'sender']);
    if (!request || !Object.isFrozen(request.envelope)) return fail('INVALID_MESSAGE');
    const parsed = parseWorkerMessage(request.envelope);
    if (!parsed.ok) return parsed.code === 'MESSAGE_TOO_LARGE' ? fail('MESSAGE_TOO_LARGE') : fail('INVALID_MESSAGE');
    const envelope = parsed.value;
    if (envelope.type === 'PREPARE_PANEL_CAPABILITY') return preparePanel(envelope, request.sender);
    if (envelope.type === 'PANEL_START_ATTACHED_AUDIT') return startAttached(envelope, request.sender);
    if (envelope.type === 'PANEL_CANCEL_AUDIT') return cancel(envelope, request.sender);
    if (envelope.type === 'PANEL_OPEN_REPORT') return openReport(envelope, request.sender);
    if (envelope.type === 'REPORT_CONNECT') return input.reportLaunch?.connect?.({ auditId: envelope.auditId, sender: request.sender }) ?? fail('FEATURE_UNAVAILABLE');
    if (envelope.type === 'REPORT_REQUEST_EXPORT') return input.exportLaunch?.requestExport?.({
      auditId: envelope.auditId, sessionCapabilityId: envelope.sessionCapabilityId, sender: request.sender,
    }) ?? fail('FEATURE_UNAVAILABLE');
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
