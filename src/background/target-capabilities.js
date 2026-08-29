export const POPUP_SURFACE = Object.freeze({ path: '/src/popup/index.html', contextType: 'POPUP', allowQuery: false });
export const PANEL_SURFACE = Object.freeze({ path: '/src/panel/index.html', contextType: 'SIDE_PANEL', allowQuery: false });
export const REVIEW_SURFACE = Object.freeze({ path: '/src/review/index.html', contextType: 'TAB', allowQuery: 'auditId-only' });
export const EXPORT_SURFACE = Object.freeze({ path: '/src/export/index.html', contextType: 'TAB', allowQuery: 'auditId-only' });

const TRUSTED_SURFACES = new Set([POPUP_SURFACE, PANEL_SURFACE, REVIEW_SURFACE, EXPORT_SURFACE]);
const SURFACE_BY_PATH = new Map([...TRUSTED_SURFACES].map(surface => [surface.path, surface]));
const TARGET_PREFIX = 'audita:target-capability:v1:';
const SESSION_PREFIX = 'audita:audit-session-capability:v1:';
const CAPABILITY_ID = /^[A-Za-z0-9_-]{22}$/u;
const MODEL_ID = /^[A-Za-z0-9._:-]{1,200}$/u;
const DIGEST = /^hmac-sha256:[A-Za-z0-9_-]{43}$/u;
const TARGET_KEYS = ['version', 'capabilityId', 'kind', 'tabId', 'windowId', 'documentId', 'initialUrlEvidence', 'initialUrlSessionDigest', 'createdBy', 'allowedIntent', 'issuer', 'issuedAt', 'expiresAt', 'state'];
const SESSION_KEYS = ['version', 'sessionCapabilityId', 'auditId', 'windowId', 'mode', 'targetBinding', 'consumers', 'intents', 'state', 'issuedAt', 'expiresAt'];
const PROOF_KEYS = ['tabId', 'windowId', 'documentId', 'urlSessionDigest'];
const CONSUMERS = deepFreeze([
  { name: 'panel', path: PANEL_SURFACE.path, contextType: PANEL_SURFACE.contextType },
  { name: 'review', path: REVIEW_SURFACE.path, contextType: REVIEW_SURFACE.contextType },
]);
const INTENTS = deepFreeze({
  panel: { running: ['cancel'], result: ['open-report'], 'view-only': ['open-report'] },
  review: { running: [], result: ['export'], 'view-only': ['export'] },
});

export async function deriveTrustedExtensionContext({ sender, chromeApi, surface }) {
  try {
    if (!TRUSTED_SURFACES.has(surface)) throw new Error('CONTEXT_DENIED');
    if (sender?.id !== chromeApi?.runtime?.id || typeof sender.documentId !== 'string' || !sender.documentId ||
      typeof sender.url !== 'string') throw new Error('CONTEXT_DENIED');
    const url = new URL(sender.url);
    const credentialsEmpty = url.username === '' && url.password === '' && url.port === '';
    const auditIds = url.searchParams.getAll('auditId');
    const queryAllowed = surface.allowQuery === true || (surface.allowQuery === 'auditId-only' &&
      [...url.searchParams.keys()].every(key => key === 'auditId') && auditIds.length === 1 &&
      /^[A-Za-z0-9_-]{1,160}$/u.test(auditIds[0]));
    if (url.protocol !== 'chrome-extension:' || url.hostname !== chromeApi.runtime.id || !credentialsEmpty ||
      url.pathname !== surface.path || url.hash !== '' || (!queryAllowed && url.search !== '')) {
      throw new Error('CONTEXT_DENIED');
    }
    const contexts = await chromeApi.runtime.getContexts({ documentIds: [sender.documentId] });
    if (!Array.isArray(contexts)) throw new Error('CONTEXT_DENIED');
    const exact = contexts.filter(value => value?.documentId === sender.documentId && value.documentUrl === sender.url &&
      value.contextType === surface.contextType && Number.isInteger(value.windowId));
    if (exact.length !== 1) throw new Error('CONTEXT_DENIED');
    return deepFreeze({
      issuer: { type: 'extension-document', documentId: sender.documentId, path: surface.path },
      windowId: exact[0].windowId,
      tabId: Number.isInteger(exact[0].tabId) ? exact[0].tabId : null,
      contextType: exact[0].contextType,
      documentUrl: exact[0].documentUrl,
    });
  } catch {
    throw new Error('CONTEXT_DENIED');
  }
}

export const targetCapabilityStorageKey = capabilityId => `${TARGET_PREFIX}${capabilityId}`;
export const sessionCapabilityStorageKey = sessionCapabilityId => `${SESSION_PREFIX}${sessionCapabilityId}`;

export function createTargetCapabilityAuthority({
  chromeApi,
  sessionArea = chromeApi?.storage?.session,
  now = Date.now,
  randomBytes = defaultRandomBytes,
  probeDocument,
  capabilityTtlMs = 60_000,
  sessionTtlMs = 30 * 60_000,
} = {}) {
  if (!chromeApi?.runtime?.id || !sessionArea || typeof sessionArea.get !== 'function' ||
    typeof sessionArea.set !== 'function' || typeof now !== 'function' || typeof randomBytes !== 'function' ||
    typeof probeDocument !== 'function' || !Number.isSafeInteger(capabilityTtlMs) || capabilityTtlMs < 1 ||
    !Number.isSafeInteger(sessionTtlMs) || sessionTtlMs < 1) throw new TypeError('CAPABILITY_AUTHORITY_INVALID');
  let tail = Promise.resolve();
  const serialize = operation => {
    const pending = tail.then(operation, operation);
    tail = pending.catch(() => {});
    return pending;
  };

  const prepare = args => serialize(async () => {
    const issuedAt = readNow(now);
    const capabilityId = createCapabilityId(randomBytes);
    const record = createTargetRecord({ ...args, capabilityId, issuedAt, expiresAt: issuedAt + capabilityTtlMs, state: 'prepared' });
    await sessionArea.set({ [targetCapabilityStorageKey(capabilityId)]: record });
    return deepFreeze({ ok: true, capabilityId, expiresAt: record.expiresAt });
  });

  const claimAndIssueAuditSession = args => serialize(() => claimCommon(args, false));
  const claimWorkerEventAndIssueAuditSession = args => serialize(() => claimCommon(args, true));

  async function claimCommon(args, workerEvent) {
    if (!isPlainRecord(args) || !CAPABILITY_ID.test(args.capabilityId ?? '')) return unavailable();
    const key = targetCapabilityStorageKey(args.capabilityId);
    const target = (await sessionArea.get(key))?.[key];
    const currentTime = readNow(now);
    if (!validTargetRecord(target) || target.state !== 'prepared' || target.expiresAt <= currentTime ||
      target.allowedIntent !== args.allowedIntent || args.allowedIntent !== 'start-audit' || !MODEL_ID.test(args.auditId ?? '') ||
      typeof args.mode !== 'string' || !MODEL_ID.test(args.mode)) return unavailable();
    if (workerEvent) {
      if (!validWorkerIssuer(target.issuer) || args.eventNonce !== target.issuer.eventNonce ||
        args.windowId !== target.windowId || args.senderContext !== undefined) return unavailable();
    } else if (!validExtensionClaimContext(target, args.senderContext, chromeApi.runtime.id)) return unavailable();
    let proof;
    try { proof = await probeDocument(target.tabId); } catch { return unavailable(); }
    if (!validProof(proof) || proof.tabId !== target.tabId || proof.windowId !== target.windowId ||
      proof.documentId !== target.documentId || proof.urlSessionDigest !== target.initialUrlSessionDigest) return unavailable();
    let sessionCapabilityId;
    try { sessionCapabilityId = createCapabilityId(randomBytes); } catch { return unavailable(); }
    const session = createSessionRecord({
      sessionCapabilityId,
      auditId: args.auditId,
      windowId: target.windowId,
      mode: args.mode,
      targetBinding: target.kind === 'attached'
        ? { kind: 'attached', tabId: target.tabId, documentId: target.documentId, urlSessionDigest: target.initialUrlSessionDigest }
        : { kind: 'disposable', ownerId: target.capabilityId },
      state: 'running',
      issuedAt: currentTime,
      expiresAt: currentTime + sessionTtlMs,
    });
    const claimed = { ...target, state: 'claimed' };
    await sessionArea.set({
      [key]: claimed,
      [sessionCapabilityStorageKey(sessionCapabilityId)]: session,
    });
    return deepFreeze({
      ok: true,
      capabilityId: target.capabilityId,
      sessionCapabilityId,
      auditId: session.auditId,
      expiresAt: session.expiresAt,
    });
  }

  const authorizeSession = args => serialize(async () => {
    if (!isPlainRecord(args) || !CAPABILITY_ID.test(args.sessionCapabilityId ?? '') || !MODEL_ID.test(args.auditId ?? '') ||
      !['panel', 'review'].includes(args.consumer) || typeof args.intent !== 'string') return sessionDenied();
    const descriptor = CONSUMERS.find(value => value.name === args.consumer);
    const surface = SURFACE_BY_PATH.get(descriptor.path);
    let context;
    try { context = await deriveTrustedExtensionContext({ sender: args.sender, chromeApi, surface }); }
    catch { return sessionDenied(); }
    const key = sessionCapabilityStorageKey(args.sessionCapabilityId);
    const session = (await sessionArea.get(key))?.[key];
    const currentTime = readNow(now);
    const allowed = validSessionRecord(session) && session.expiresAt > currentTime && session.auditId === args.auditId &&
      session.windowId === context.windowId && context.issuer.path === descriptor.path &&
      context.contextType === descriptor.contextType && session.consumers.some(value => sameConsumer(value, descriptor)) &&
      session.intents[args.consumer]?.[session.state]?.includes(args.intent) === true;
    if (!allowed) return sessionDenied();
    if (surface.allowQuery === 'auditId-only' && new URL(context.documentUrl).searchParams.get('auditId') !== args.auditId) {
      return sessionDenied();
    }
    return deepFreeze({ ok: true, session: deepFreeze(structuredClone(session)), context });
  });

  const transitionAuditSession = args => serialize(async () => {
    if (!isPlainRecord(args) || !CAPABILITY_ID.test(args.sessionCapabilityId ?? '') || !MODEL_ID.test(args.auditId ?? '')) {
      return transitionDenied();
    }
    const key = sessionCapabilityStorageKey(args.sessionCapabilityId);
    const session = (await sessionArea.get(key))?.[key];
    const allowed = validSessionRecord(session) && session.auditId === args.auditId && session.expiresAt > readNow(now) &&
      ((session.state === 'running' && ['result', 'revoked'].includes(args.nextState)) ||
        (['result', 'view-only'].includes(session.state) && args.nextState === 'revoked'));
    if (!allowed) return transitionDenied();
    const changed = { ...session, state: args.nextState };
    await sessionArea.set({ [key]: changed });
    return deepFreeze({ ok: true, sessionCapabilityId: session.sessionCapabilityId, auditId: session.auditId, state: changed.state });
  });

  const invalidateCapability = (capabilityId, reason) => serialize(async () => {
    if (!CAPABILITY_ID.test(capabilityId ?? '') || typeof reason !== 'string' || !reason) return unavailable();
    const key = targetCapabilityStorageKey(capabilityId);
    const target = (await sessionArea.get(key))?.[key];
    if (!validTargetRecord(target)) return unavailable();
    if (target.state !== 'invalidated') await sessionArea.set({ [key]: { ...target, state: 'invalidated' } });
    return deepFreeze({ ok: true, capabilityId });
  });

  const invalidateForTab = (tabId, reason) => invalidateBy(
    record => (validTargetRecord(record) && record.tabId === tabId) ||
      (validSessionRecord(record) && record.targetBinding.kind === 'attached' && record.targetBinding.tabId === tabId),
    reason,
  );
  const invalidateForWindow = (windowId, reason) => invalidateBy(
    record => (validTargetRecord(record) || validSessionRecord(record)) && record.windowId === windowId,
    reason,
  );

  function invalidateBy(predicate, reason) {
    return serialize(async () => {
      if (typeof reason !== 'string' || !reason) return unavailable();
      const all = await sessionArea.get(null);
      const changes = {};
      for (const [key, record] of Object.entries(all ?? {})) {
        if (!predicate(record)) continue;
        if (validTargetRecord(record) && record.state !== 'invalidated') changes[key] = { ...record, state: 'invalidated' };
        if (validSessionRecord(record) && record.state !== 'revoked') changes[key] = { ...record, state: 'revoked' };
      }
      if (Object.keys(changes).length > 0) await sessionArea.set(changes);
      return deepFreeze({ ok: true, invalidated: Object.keys(changes).length });
    });
  }

  const rehydrateViewOnly = args => serialize(async () => {
    if (!isPlainRecord(args) || !MODEL_ID.test(args.auditId ?? '') || !MODEL_ID.test(args.mode ?? '') ||
      !Number.isSafeInteger(args.windowId) || !validTargetBinding(args.targetBinding)) return sessionDenied();
    const currentTime = readNow(now);
    const sessionCapabilityId = createCapabilityId(randomBytes);
    const session = createSessionRecord({
      sessionCapabilityId,
      auditId: args.auditId,
      windowId: args.windowId,
      mode: args.mode,
      targetBinding: structuredClone(args.targetBinding),
      state: 'view-only',
      issuedAt: currentTime,
      expiresAt: currentTime + sessionTtlMs,
    });
    await sessionArea.set({ [sessionCapabilityStorageKey(sessionCapabilityId)]: session });
    return deepFreeze({ ok: true, sessionCapabilityId, auditId: args.auditId, expiresAt: session.expiresAt });
  });

  return Object.freeze({
    prepare,
    claimAndIssueAuditSession,
    claimWorkerEventAndIssueAuditSession,
    authorizeSession,
    transitionAuditSession,
    invalidateCapability,
    invalidateForTab,
    invalidateForWindow,
    rehydrateViewOnly,
  });
}

function createTargetRecord(value) {
  if (!isPlainRecord(value) || !['attached', 'disposable'].includes(value.kind) ||
    !CAPABILITY_ID.test(value.capabilityId ?? '') || !safeChromeId(value.tabId) || !safeChromeId(value.windowId) ||
    !validDocumentId(value.documentId) || !validEvidenceUrl(value.initialUrlEvidence) ||
    !DIGEST.test(value.initialUrlSessionDigest ?? '') || !['user', 'audit'].includes(value.createdBy) ||
    !['start-audit', 'start-persona'].includes(value.allowedIntent) || !validIssuer(value.issuer) ||
    !safeTime(value.issuedAt) || !safeTime(value.expiresAt) || value.expiresAt <= value.issuedAt || value.state !== 'prepared') {
    throw new TypeError('CAPABILITY_PREPARE_DENIED');
  }
  return {
    version: 1,
    capabilityId: value.capabilityId,
    kind: value.kind,
    tabId: value.tabId,
    windowId: value.windowId,
    documentId: value.documentId,
    initialUrlEvidence: value.initialUrlEvidence,
    initialUrlSessionDigest: value.initialUrlSessionDigest,
    createdBy: value.createdBy,
    allowedIntent: value.allowedIntent,
    issuer: structuredClone(value.issuer),
    issuedAt: value.issuedAt,
    expiresAt: value.expiresAt,
    state: value.state,
  };
}

function createSessionRecord(value) {
  return {
    version: 1,
    sessionCapabilityId: value.sessionCapabilityId,
    auditId: value.auditId,
    windowId: value.windowId,
    mode: value.mode,
    targetBinding: structuredClone(value.targetBinding),
    consumers: structuredClone(CONSUMERS),
    intents: structuredClone(INTENTS),
    state: value.state,
    issuedAt: value.issuedAt,
    expiresAt: value.expiresAt,
  };
}

function validTargetRecord(value) {
  return isPlainRecord(value) && hasExactKeys(value, TARGET_KEYS) && value.version === 1 &&
    CAPABILITY_ID.test(value.capabilityId ?? '') && ['attached', 'disposable'].includes(value.kind) &&
    safeChromeId(value.tabId) && safeChromeId(value.windowId) && validDocumentId(value.documentId) &&
    validEvidenceUrl(value.initialUrlEvidence) && DIGEST.test(value.initialUrlSessionDigest ?? '') &&
    ['user', 'audit'].includes(value.createdBy) && ['start-audit', 'start-persona'].includes(value.allowedIntent) &&
    validIssuer(value.issuer) && safeTime(value.issuedAt) && safeTime(value.expiresAt) && value.expiresAt > value.issuedAt &&
    ['prepared', 'claimed', 'invalidated'].includes(value.state);
}

function validSessionRecord(value) {
  return isPlainRecord(value) && hasExactKeys(value, SESSION_KEYS) && value.version === 1 &&
    CAPABILITY_ID.test(value.sessionCapabilityId ?? '') && MODEL_ID.test(value.auditId ?? '') &&
    safeChromeId(value.windowId) && MODEL_ID.test(value.mode ?? '') && validTargetBinding(value.targetBinding) &&
    Array.isArray(value.consumers) && value.consumers.length === CONSUMERS.length &&
    value.consumers.every((entry, index) => sameConsumer(entry, CONSUMERS[index])) &&
    sameJson(value.intents, INTENTS) && ['running', 'result', 'view-only', 'revoked'].includes(value.state) &&
    safeTime(value.issuedAt) && safeTime(value.expiresAt) && value.expiresAt > value.issuedAt;
}

function validTargetBinding(value) {
  if (!isPlainRecord(value)) return false;
  if (value.kind === 'attached') return hasExactKeys(value, ['kind', 'tabId', 'documentId', 'urlSessionDigest']) &&
    safeChromeId(value.tabId) && validDocumentId(value.documentId) && DIGEST.test(value.urlSessionDigest ?? '');
  return value.kind === 'disposable' && hasExactKeys(value, ['kind', 'ownerId']) && MODEL_ID.test(value.ownerId ?? '');
}

function validExtensionClaimContext(target, context, runtimeId) {
  if (!validExtensionIssuer(target.issuer) || !isPlainRecord(context) ||
    !hasExactKeys(context, ['issuer', 'windowId', 'tabId', 'contextType', 'documentUrl']) ||
    !validExtensionIssuer(context.issuer)) return false;
  const surface = SURFACE_BY_PATH.get(target.issuer.path);
  return Boolean(surface && context.issuer.documentId === target.issuer.documentId &&
    context.issuer.path === target.issuer.path && context.windowId === target.windowId &&
    context.contextType === surface.contextType &&
    context.documentUrl === `chrome-extension://${runtimeId}${surface.path}`);
}

function validIssuer(value) { return validExtensionIssuer(value) || validWorkerIssuer(value); }
function validExtensionIssuer(value) {
  return isPlainRecord(value) && hasExactKeys(value, ['type', 'documentId', 'path']) &&
    value.type === 'extension-document' && validDocumentId(value.documentId) && SURFACE_BY_PATH.has(value.path);
}
function validWorkerIssuer(value) {
  return isPlainRecord(value) && hasExactKeys(value, ['type', 'event', 'eventNonce']) &&
    value.type === 'worker-event' && value.event === 'context-menu' &&
    typeof value.eventNonce === 'string' && /^[A-Za-z0-9._:-]{20,240}$/u.test(value.eventNonce);
}
function validProof(value) {
  return isPlainRecord(value) && hasExactKeys(value, PROOF_KEYS) && safeChromeId(value.tabId) && safeChromeId(value.windowId) &&
    validDocumentId(value.documentId) && DIGEST.test(value.urlSessionDigest ?? '');
}
function validDocumentId(value) { return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,240}$/u.test(value); }
function validEvidenceUrl(value) {
  if (typeof value !== 'string' || value.length > 8192) return false;
  try {
    const parsed = new URL(value);
    return ['http:', 'https:'].includes(parsed.protocol) && parsed.href === value &&
      parsed.username === '' && parsed.password === '' && parsed.hash === '';
  } catch { return false; }
}
function safeChromeId(value) { return Number.isSafeInteger(value) && value >= 0; }
function safeTime(value) { return Number.isSafeInteger(value) && value >= 0; }
function readNow(now) {
  const value = now();
  if (!safeTime(value)) throw new TypeError('CAPABILITY_TIME_INVALID');
  return value;
}
function createCapabilityId(randomBytes) {
  const bytes = randomBytes(16);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 16) throw new TypeError('CAPABILITY_RANDOM_INVALID');
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/gu, '');
}
function defaultRandomBytes(length) {
  const value = new Uint8Array(length);
  crypto.getRandomValues(value);
  return value;
}
function sameConsumer(first, second) {
  return isPlainRecord(first) && hasExactKeys(first, ['name', 'path', 'contextType']) &&
    first.name === second.name && first.path === second.path && first.contextType === second.contextType;
}
function sameJson(first, second) {
  try { return JSON.stringify(first) === JSON.stringify(second); } catch { return false; }
}
function isPlainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function hasExactKeys(value, keys) {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}
function unavailable() { return Object.freeze({ ok: false, code: 'CAPABILITY_UNAVAILABLE' }); }
function sessionDenied() { return Object.freeze({ ok: false, code: 'SESSION_DENIED' }); }
function transitionDenied() { return Object.freeze({ ok: false, code: 'SESSION_TRANSITION_DENIED' }); }
