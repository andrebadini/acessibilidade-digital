export const PANEL_SURFACE = Object.freeze({ path: '/src/panel/index.html', contextType: 'SIDE_PANEL', allowQuery: 'launch-only' });
export const REVIEW_SURFACE = Object.freeze({ path: '/src/review/index.html', contextType: 'TAB', allowQuery: 'auditId-only' });
export const EXPORT_SURFACE = Object.freeze({ path: '/src/export/index.html', contextType: 'TAB', allowQuery: 'auditId-only' });

const TRUSTED_SURFACES = new Set([PANEL_SURFACE, REVIEW_SURFACE, EXPORT_SURFACE]);
const SURFACE_BY_PATH = new Map([...TRUSTED_SURFACES].map(surface => [surface.path, surface]));
const SESSION_AREA_TAILS = new WeakMap();
const TARGET_PREFIX = 'audita:target-capability:v1:';
const NAVIGATION_PREFIX = 'audita:navigation-capability:v1:';
const SESSION_PREFIX = 'audita:audit-session-capability:v1:';
const CAPABILITY_ID = /^[A-Za-z0-9_-]{22}$/u;
const MODEL_ID = /^[A-Za-z0-9._:-]{1,200}$/u;
const DIGEST = /^hmac-sha256:[A-Za-z0-9_-]{43}$/u;
const TARGET_KEYS = ['version', 'capabilityId', 'kind', 'tabId', 'windowId', 'documentId', 'initialUrlEvidence', 'initialUrlSessionDigest', 'createdBy', 'allowedIntent', 'issuer', 'sessionCapabilityId', 'issuedAt', 'expiresAt', 'state'];
const SESSION_KEYS = ['version', 'sessionCapabilityId', 'auditId', 'windowId', 'mode', 'targetBinding', 'consumers', 'intents', 'state', 'issuedAt', 'expiresAt'];
const PROOF_KEYS = ['tabId', 'windowId', 'documentId', 'urlSessionDigest'];
const PREPARE_KEYS = ['kind', 'tabId', 'windowId', 'documentId', 'initialUrlEvidence', 'initialUrlSessionDigest', 'createdBy', 'allowedIntent', 'issuer'];
const PERSONA_CLAIM_KEYS = ['capabilityId', 'intent', 'senderContext'];
const AUDIT_INSPECT_KEYS = ['capabilityId', 'allowedIntent', 'eventNonce', 'senderContext'];
const EXTENSION_CLAIM_KEYS = ['capabilityId', 'auditId', 'mode', 'allowedIntent', 'senderContext'];
const WORKER_CLAIM_KEYS = ['capabilityId', 'auditId', 'mode', 'allowedIntent', 'eventNonce', 'senderContext'];
const AUTHORIZE_KEYS = ['sessionCapabilityId', 'auditId', 'consumer', 'intent', 'sender'];
const PANEL_AUTHORIZE_KEYS = [...AUTHORIZE_KEYS, 'claimedWindowId'];
const TRANSITION_KEYS = ['sessionCapabilityId', 'auditId', 'nextState'];
const DISPOSABLE_TRANSITION_KEYS = ['sessionCapabilityId', 'auditId', 'ownershipId', 'fromState', 'toState'];
const BATCH_TRANSITION_KEYS = [
  'sessionCapabilityId', 'auditId', 'fromPageId', 'fromOwnershipId', 'toPageId', 'toOwnershipId',
];
const REHYDRATE_KEYS = ['auditId', 'windowId', 'mode'];
const NAVIGATION_PREPARE_KEYS = ['intent', 'senderContext'];
const NAVIGATION_CLAIM_KEYS = ['capabilityId', 'auditId', 'ownershipId', 'intent', 'senderContext'];
const ATTACHED_COPY_EXCHANGE_KEYS = ['capabilityId', 'intent', 'senderContext'];
const ATTACHED_COPY_CLAIM_KEYS = ['capabilityId', 'auditId', 'ownershipId', 'senderContext'];
const NAVIGATION_KEYS = ['version', 'capabilityId', 'intent', 'windowId', 'issuer', 'sessionCapabilityId', 'issuedAt', 'expiresAt', 'state'];
const DISPOSABLE_BINDING_STATES = new Set([
  'pending', 'observing', 'retained-for-review', 'retained-for-consent', 'cleanup-pending', 'removed',
]);
const CONSUMERS = deepFreeze([
  { name: 'panel', path: PANEL_SURFACE.path, contextType: PANEL_SURFACE.contextType },
  { name: 'review', path: REVIEW_SURFACE.path, contextType: REVIEW_SURFACE.contextType },
]);
const INTENTS = deepFreeze({
  panel: { running: ['cancel'], 'privacy-paused': ['cancel', 'confirm-pixels'], result: ['open-report', 'highlight', 'review-markers'], 'view-only': ['open-report', 'review-markers'] },
  review: { running: [], 'privacy-paused': [], result: ['export', 'highlight'], 'view-only': ['export'] },
});
const PRE_MARKERS_INTENTS = deepFreeze({
  panel: { running: ['cancel'], 'privacy-paused': ['cancel', 'confirm-pixels'], result: ['open-report', 'highlight'], 'view-only': ['open-report'] },
  review: { running: [], 'privacy-paused': [], result: ['export', 'highlight'], 'view-only': ['export'] },
});
const PRE_PRIVACY_INTENTS = deepFreeze({
  panel: { running: ['cancel'], result: ['open-report', 'highlight'], 'view-only': ['open-report'] },
  review: { running: [], result: ['export', 'highlight'], 'view-only': ['export'] },
});
const LEGACY_STORAGE_INTENTS = deepFreeze({
  panel: { running: ['cancel'], result: ['open-report'], 'view-only': ['open-report'] },
  review: { running: [], result: ['export'], 'view-only': ['export'] },
});

export async function deriveTrustedExtensionContext({ sender, chromeApi, surface, claimedWindowId } = {}) {
  try {
    if (!TRUSTED_SURFACES.has(surface)) throw new Error('CONTEXT_DENIED');
    const isPanel = surface === PANEL_SURFACE;
    const senderId = readDataProperty(sender, 'id');
    const senderUrl = readDataProperty(sender, 'url');
    const senderDocumentId = readOptionalDataProperty(sender, 'documentId');
    if (!senderId.found || senderId.value !== chromeApi?.runtime?.id || !senderUrl.found ||
      typeof senderUrl.value !== 'string' ||
      senderDocumentId.invalid || !senderDocumentId.found ||
      typeof senderDocumentId.value !== 'string' || !senderDocumentId.value) throw new Error('CONTEXT_DENIED');
    const url = new URL(senderUrl.value);
    const credentialsEmpty = url.username === '' && url.password === '' && url.port === '';
    const auditIds = url.searchParams.getAll('auditId');
    const launchTokens = url.searchParams.getAll('launch');
    const queryAllowed = surface.allowQuery === true || (surface.allowQuery === 'auditId-only' &&
      [...url.searchParams.keys()].every(key => key === 'auditId') && auditIds.length === 1 &&
      /^[A-Za-z0-9_-]{1,160}$/u.test(auditIds[0])) ||
      (surface.allowQuery === 'launch-only' &&
        [...url.searchParams.keys()].every(key => key === 'launch') && launchTokens.length === 1 &&
        /^[A-Za-z0-9_-]{43}$/u.test(launchTokens[0]));
    if (url.protocol !== 'chrome-extension:' || url.hostname !== chromeApi.runtime.id || !credentialsEmpty ||
      url.pathname !== surface.path || url.hash !== '' ||
      (!queryAllowed && (url.search !== '' || surface.allowQuery === 'launch-only'))) {
      throw new Error('CONTEXT_DENIED');
    }
    if ((isPanel && !safeChromeId(claimedWindowId)) || (!isPanel && claimedWindowId !== undefined)) {
      throw new Error('CONTEXT_DENIED');
    }
    const contexts = readDataArray(await chromeApi.runtime.getContexts({ documentIds: [senderDocumentId.value] }));
    if (!contexts || contexts.length !== 1) throw new Error('CONTEXT_DENIED');
    const candidate = contexts[0];
    const documentId = readDataProperty(candidate, 'documentId');
    const candidateUrl = readDataProperty(candidate, 'documentUrl');
    const candidateType = readDataProperty(candidate, 'contextType');
    const candidateWindowId = readDataProperty(candidate, 'windowId');
    if (!documentId.found || documentId.value !== senderDocumentId.value || !candidateUrl.found ||
      candidateUrl.value !== senderUrl.value || !candidateType.found || candidateType.value !== surface.contextType ||
      !candidateWindowId.found) throw new Error('CONTEXT_DENIED');
    const documentUrl = candidateUrl.value;
    const contextType = candidateType.value;
    const nativeWindowId = candidateWindowId.value;
    let windowId;
    let tabId = null;
    if (isPanel) {
      if (nativeWindowId !== -1 && nativeWindowId !== claimedWindowId) throw new Error('CONTEXT_DENIED');
      await provePanelWindowClaim(chromeApi, claimedWindowId);
      windowId = claimedWindowId;
    } else {
      const nativeTabId = readDataProperty(candidate, 'tabId');
      if (!safeChromeId(nativeWindowId) || !nativeTabId.found || !safeChromeId(nativeTabId.value)) {
        throw new Error('CONTEXT_DENIED');
      }
      windowId = nativeWindowId;
      tabId = nativeTabId.value;
    }
    return deepFreeze({
      issuer: {
        type: 'extension-document',
        documentId: senderDocumentId.value,
        path: surface.path,
      },
      windowId,
      tabId,
      contextType,
      documentUrl,
    });
  } catch {
    throw new Error('CONTEXT_DENIED');
  }
}

export const targetCapabilityStorageKey = capabilityId => `${TARGET_PREFIX}${capabilityId}`;
export const navigationCapabilityStorageKey = capabilityId => `${NAVIGATION_PREFIX}${capabilityId}`;
export const sessionCapabilityStorageKey = sessionCapabilityId => `${SESSION_PREFIX}${sessionCapabilityId}`;

export async function readPreparedAttachedAuditFact(args) {
  try {
    const input = readDataRecord(args, ['sessionArea', 'capabilityId', 'epochNow']);
    if (!input || typeof input.sessionArea?.get !== 'function' || !CAPABILITY_ID.test(input.capabilityId ?? '') ||
      typeof input.epochNow !== 'function') throw new Error('denied');
    const key = targetCapabilityStorageKey(input.capabilityId);
    const first = parseTargetRecord(readExactStoredValue(await input.sessionArea.get(key), key));
    const firstNow = readEpoch(input.epochNow);
    const second = parseTargetRecord(readExactStoredValue(await input.sessionArea.get(key), key));
    const secondNow = readEpoch(input.epochNow);
    if (!first || !second || !sameGraph(first, second) || secondNow < firstNow ||
      first.capabilityId !== input.capabilityId || first.kind !== 'attached' || first.allowedIntent !== 'start-audit' ||
      first.state !== 'prepared' || first.sessionCapabilityId !== null || first.issuedAt > firstNow ||
      first.expiresAt <= secondNow) throw new Error('denied');
    return deepFreeze({
      version: 1, capabilityId: first.capabilityId, windowId: first.windowId,
      issuedAt: first.issuedAt, expiresAt: first.expiresAt,
    });
  } catch {
    throw new Error('PREPARED_AUDIT_FACT_DENIED');
  }
}

export async function readClaimedAttachedAuditGrant(args) {
  try {
    const input = readDataRecord(args, ['sessionArea', 'capabilityId', 'sessionCapabilityId', 'auditId', 'epochNow']);
    if (!input || typeof input.sessionArea?.get !== 'function' || !CAPABILITY_ID.test(input.capabilityId ?? '') ||
      !CAPABILITY_ID.test(input.sessionCapabilityId ?? '') || !MODEL_ID.test(input.auditId ?? '') ||
      typeof input.epochNow !== 'function') throw new Error('denied');
    const targetKey = targetCapabilityStorageKey(input.capabilityId);
    const sessionKey = sessionCapabilityStorageKey(input.sessionCapabilityId);
    const keys = [targetKey, sessionKey];
    const firstEnvelope = await input.sessionArea.get(keys);
    const firstValues = readExactStoredValues(firstEnvelope, keys);
    const firstTarget = parseTargetRecord(firstValues?.[targetKey]);
    const firstSession = parseSessionRecord(firstValues?.[sessionKey]);
    const firstNow = readEpoch(input.epochNow);
    const secondEnvelope = await input.sessionArea.get(keys);
    const secondValues = readExactStoredValues(secondEnvelope, keys);
    const secondTarget = parseTargetRecord(secondValues?.[targetKey]);
    const secondSession = parseSessionRecord(secondValues?.[sessionKey]);
    const secondNow = readEpoch(input.epochNow);
    if (!firstTarget || !firstSession || !secondTarget || !secondSession ||
      !sameGraph(firstTarget, secondTarget) || !sameGraph(firstSession, secondSession) || secondNow < firstNow ||
      !validClaimedCorrelation(firstTarget, firstSession, input) || firstTarget.expiresAt <= secondNow ||
      firstSession.expiresAt <= secondNow || firstTarget.issuedAt > firstNow || firstSession.issuedAt > firstNow) throw new Error('denied');
    return deepFreeze({
      version: 1,
      capabilityId: firstTarget.capabilityId,
      auditId: firstSession.auditId,
      sessionCapabilityId: firstSession.sessionCapabilityId,
      windowId: firstSession.windowId,
      issuedAt: firstSession.issuedAt,
      expiresAt: firstSession.expiresAt,
      target: {
        kind: 'attached', tabId: firstTarget.tabId, windowId: firstTarget.windowId,
        documentId: firstTarget.documentId, initialUrlEvidence: firstTarget.initialUrlEvidence,
        initialUrlSessionDigest: firstTarget.initialUrlSessionDigest,
      },
    });
  } catch {
    throw new Error('CLAIMED_AUDIT_GRANT_DENIED');
  }
}

export async function readAuditSessionForWorker(args) {
  try {
    const input = readDataRecord(args, ['sessionArea', 'sessionCapabilityId', 'auditId']);
    if (!input || typeof input.sessionArea?.get !== 'function' || !CAPABILITY_ID.test(input.sessionCapabilityId ?? '') ||
      !MODEL_ID.test(input.auditId ?? '')) throw new Error('denied');
    const key = sessionCapabilityStorageKey(input.sessionCapabilityId);
    const session = parseSessionRecord(readExactStoredValue(await input.sessionArea.get(key), key));
    if (!session || session.sessionCapabilityId !== input.sessionCapabilityId || session.auditId !== input.auditId) throw new Error('denied');
    return copyWorkerSession(session);
  } catch {
    throw new Error('AUDIT_SESSION_READ_DENIED');
  }
}

export async function readNavigationAuditCorrelationForRecovery(args) {
  try {
    const input = readDataRecord(args, ['sessionArea', 'capabilityId', 'auditId']);
    if (!input || typeof input.sessionArea?.get !== 'function' || !CAPABILITY_ID.test(input.capabilityId ?? '') ||
      !MODEL_ID.test(input.auditId ?? '')) throw new Error('denied');
    const navigationKey = navigationCapabilityStorageKey(input.capabilityId);
    const firstNavigation = parseNavigationRecord(readExactStoredValue(await input.sessionArea.get(navigationKey), navigationKey));
    if (!firstNavigation || !CAPABILITY_ID.test(firstNavigation.sessionCapabilityId ?? '')) throw new Error('denied');
    const sessionKey = sessionCapabilityStorageKey(firstNavigation.sessionCapabilityId);
    const firstSession = parseSessionRecord(readExactStoredValue(await input.sessionArea.get(sessionKey), sessionKey));
    const secondNavigation = parseNavigationRecord(readExactStoredValue(await input.sessionArea.get(navigationKey), navigationKey));
    const secondSession = parseSessionRecord(readExactStoredValue(await input.sessionArea.get(sessionKey), sessionKey));
    if (!firstSession || !secondNavigation || !secondSession || !sameGraph(firstNavigation, secondNavigation) ||
      !sameGraph(firstSession, secondSession) || firstNavigation.capabilityId !== input.capabilityId ||
      firstSession.auditId !== input.auditId || firstSession.sessionCapabilityId !== firstNavigation.sessionCapabilityId ||
      firstSession.windowId !== firstNavigation.windowId || firstSession.mode !== 'single' ||
      firstSession.targetBinding.kind !== 'disposable') throw new Error('denied');
    return deepFreeze({
      version: 1, capabilityId: firstNavigation.capabilityId, auditId: firstSession.auditId,
      sessionCapabilityId: firstSession.sessionCapabilityId, windowId: firstSession.windowId,
      capabilityState: firstNavigation.state, sessionState: firstSession.state,
      navigationPurpose: firstNavigation.intent === 'attached-copy' ? 'attached-copy' : 'single-url',
      ownershipId: firstSession.targetBinding.ownershipId, ownershipState: firstSession.targetBinding.state,
      issuedAt: firstSession.issuedAt, expiresAt: firstSession.expiresAt,
    });
  } catch { throw new Error('NAVIGATION_AUDIT_CORRELATION_DENIED'); }
}

export async function readBatchAuditCorrelationForRecovery(args) {
  try {
    const input = readDataRecord(args, ['sessionArea', 'capabilityId', 'auditId']);
    if (!input || typeof input.sessionArea?.get !== 'function' || !CAPABILITY_ID.test(input.capabilityId ?? '') ||
      !MODEL_ID.test(input.auditId ?? '')) throw new Error('denied');
    const navigationKey = navigationCapabilityStorageKey(input.capabilityId);
    const firstNavigation = parseNavigationRecord(readExactStoredValue(await input.sessionArea.get(navigationKey), navigationKey));
    if (!firstNavigation || firstNavigation.intent !== 'batch' ||
      !CAPABILITY_ID.test(firstNavigation.sessionCapabilityId ?? '')) throw new Error('denied');
    const sessionKey = sessionCapabilityStorageKey(firstNavigation.sessionCapabilityId);
    const firstSession = parseSessionRecord(readExactStoredValue(await input.sessionArea.get(sessionKey), sessionKey));
    const secondNavigation = parseNavigationRecord(readExactStoredValue(await input.sessionArea.get(navigationKey), navigationKey));
    const secondSession = parseSessionRecord(readExactStoredValue(await input.sessionArea.get(sessionKey), sessionKey));
    if (!firstSession || !secondNavigation || !secondSession || !sameGraph(firstNavigation, secondNavigation) ||
      !sameGraph(firstSession, secondSession) || firstNavigation.capabilityId !== input.capabilityId ||
      firstSession.auditId !== input.auditId || firstSession.sessionCapabilityId !== firstNavigation.sessionCapabilityId ||
      firstSession.windowId !== firstNavigation.windowId || firstSession.mode !== 'batch' ||
      firstSession.targetBinding.kind !== 'batch') throw new Error('denied');
    return deepFreeze({
      version: 1,
      capabilityId: firstNavigation.capabilityId,
      auditId: firstSession.auditId,
      sessionCapabilityId: firstSession.sessionCapabilityId,
      windowId: firstSession.windowId,
      capabilityState: firstNavigation.state,
      sessionState: firstSession.state,
      activePageId: firstSession.targetBinding.activePageId,
      activeOwnershipId: firstSession.targetBinding.activeOwnershipId,
      issuedAt: firstSession.issuedAt,
      expiresAt: firstSession.expiresAt,
    });
  } catch { throw new Error('BATCH_AUDIT_CORRELATION_DENIED'); }
}

export async function readAttachedCopyNavigationForRecovery(args) {
  try {
    const input = readDataRecord(args, ['sessionArea', 'capabilityId']);
    if (!input || typeof input.sessionArea?.get !== 'function' ||
      !CAPABILITY_ID.test(input.capabilityId ?? '')) throw new Error('denied');
    const targetKey = targetCapabilityStorageKey(input.capabilityId);
    const navigationKey = navigationCapabilityStorageKey(input.capabilityId);
    const keys = [targetKey, navigationKey];
    const firstValues = readExactStoredValues(await input.sessionArea.get(keys), keys);
    const secondValues = readExactStoredValues(await input.sessionArea.get(keys), keys);
    const firstTarget = parseTargetRecord(firstValues?.[targetKey]);
    const firstNavigation = parseNavigationRecord(firstValues?.[navigationKey]);
    const secondTarget = parseTargetRecord(secondValues?.[targetKey]);
    const secondNavigation = parseNavigationRecord(secondValues?.[navigationKey]);
    if (!firstTarget || !firstNavigation || !secondTarget || !secondNavigation ||
      !sameGraph(firstTarget, secondTarget) || !sameGraph(firstNavigation, secondNavigation) ||
      firstTarget.capabilityId !== input.capabilityId || firstTarget.kind !== 'attached' ||
      firstTarget.allowedIntent !== 'start-audit' || firstTarget.state !== 'invalidated' ||
      firstTarget.sessionCapabilityId !== null || firstNavigation.capabilityId !== input.capabilityId ||
      firstNavigation.intent !== 'attached-copy' || firstNavigation.windowId !== firstTarget.windowId ||
      !sameGraph(firstNavigation.issuer, firstTarget.issuer)) throw new Error('denied');
    return deepFreeze({
      version: 1,
      capabilityId: firstNavigation.capabilityId,
      windowId: firstNavigation.windowId,
      targetState: firstTarget.state,
      navigationState: firstNavigation.state,
      sessionCapabilityId: firstNavigation.sessionCapabilityId,
    });
  } catch {
    throw new Error('ATTACHED_COPY_NAVIGATION_RECOVERY_DENIED');
  }
}

async function readAttachedAuditRecoveryGraph(args) {
  const input = readDataRecord(args, ['sessionArea', 'capabilityId', 'auditId']);
  if (!input || typeof input.sessionArea?.get !== 'function' || !CAPABILITY_ID.test(input.capabilityId ?? '') ||
    !MODEL_ID.test(input.auditId ?? '')) throw new Error('denied');
  const targetKey = targetCapabilityStorageKey(input.capabilityId);
  const firstTarget = parseTargetRecord(readExactStoredValue(await input.sessionArea.get(targetKey), targetKey));
  if (!validRecoveryTarget(firstTarget, input.capabilityId)) throw new Error('denied');
  let firstSession = null;
  let sessionKey = null;
  if (firstTarget.sessionCapabilityId !== null) {
    sessionKey = sessionCapabilityStorageKey(firstTarget.sessionCapabilityId);
    firstSession = parseSessionRecord(readExactStoredValue(await input.sessionArea.get(sessionKey), sessionKey));
    if (!validRecoverySession(firstSession, firstTarget, input.auditId)) throw new Error('denied');
  }
  const secondTarget = parseTargetRecord(readExactStoredValue(await input.sessionArea.get(targetKey), targetKey));
  if (!secondTarget || !sameGraph(firstTarget, secondTarget)) throw new Error('denied');
  if (sessionKey !== null) {
    const secondSession = parseSessionRecord(readExactStoredValue(await input.sessionArea.get(sessionKey), sessionKey));
    if (!secondSession || !sameGraph(firstSession, secondSession)) throw new Error('denied');
  }
  return deepFreeze({ auditId: input.auditId, target: firstTarget, session: firstSession });
}

export async function readAttachedAuditCorrelationForRecovery(args) {
  try {
    const { auditId, target, session } = await readAttachedAuditRecoveryGraph(args);
    return deepFreeze({
      version: 1, capabilityId: target.capabilityId, auditId, windowId: target.windowId,
      targetState: target.state, sessionCapabilityId: target.sessionCapabilityId,
      sessionState: session?.state ?? null, issuedAt: target.issuedAt, expiresAt: target.expiresAt,
    });
  } catch {
    throw new Error('AUDIT_RECOVERY_CORRELATION_DENIED');
  }
}

export async function readAttachedAuditRecoveryGrant(args) {
  try {
    const { auditId, target, session } = await readAttachedAuditRecoveryGraph(args);
    if (target.initialUrlEvidence.includes('?')) throw new Error('denied');
    return deepFreeze({
      version: 1,
      capabilityId: target.capabilityId,
      auditId,
      sessionCapabilityId: target.sessionCapabilityId,
      windowId: target.windowId,
      issuedAt: target.issuedAt,
      expiresAt: target.expiresAt,
      targetState: target.state,
      sessionState: session?.state ?? null,
      target: {
        kind: 'attached', tabId: target.tabId, windowId: target.windowId,
        documentId: target.documentId, initialUrlEvidence: target.initialUrlEvidence,
        initialUrlSessionDigest: target.initialUrlSessionDigest,
      },
    });
  } catch {
    throw new Error('AUDIT_RECOVERY_GRANT_DENIED');
  }
}

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
    typeof sessionArea.set !== 'function' || typeof sessionArea.remove !== 'function' ||
    typeof now !== 'function' || typeof randomBytes !== 'function' ||
    typeof probeDocument !== 'function' || !Number.isSafeInteger(capabilityTtlMs) || capabilityTtlMs < 1 ||
    !Number.isSafeInteger(sessionTtlMs) || sessionTtlMs < 1) throw new TypeError('CAPABILITY_AUTHORITY_INVALID');
  const serialize = operation => {
    const tail = SESSION_AREA_TAILS.get(sessionArea) ?? Promise.resolve();
    const pending = tail.then(operation, operation);
    SESSION_AREA_TAILS.set(sessionArea, pending.catch(() => {}));
    return pending;
  };

  const prepare = args => serialize(async () => {
    const input = readDataRecord(args, PREPARE_KEYS);
    if (!input) throw new TypeError('CAPABILITY_PREPARE_DENIED');
    const issuedAt = readNow(now);
    const capabilityId = createCapabilityId(randomBytes);
    const record = createTargetRecord({ ...input, capabilityId, issuedAt, expiresAt: issuedAt + capabilityTtlMs, state: 'prepared' });
    await sessionArea.set({ [targetCapabilityStorageKey(capabilityId)]: record });
    return deepFreeze({ ok: true, capabilityId, expiresAt: record.expiresAt });
  });

  const prepareNavigationForPanel = args => serialize(async () => {
    const input = readDataRecord(args, NAVIGATION_PREPARE_KEYS);
    const context = input && parsePanelNavigationContext(input.senderContext, chromeApi.runtime.id);
    if (!input || !['single', 'batch'].includes(input.intent) || !context) throw new TypeError('CAPABILITY_PREPARE_DENIED');
    const issuedAt = readNow(now);
    const capabilityId = createCapabilityId(randomBytes);
    const record = {
      version: 1,
      capabilityId,
      intent: input.intent,
      windowId: context.windowId,
      issuer: context.issuer,
      sessionCapabilityId: null,
      issuedAt,
      expiresAt: issuedAt + capabilityTtlMs,
      state: 'prepared',
    };
    await sessionArea.set({ [navigationCapabilityStorageKey(capabilityId)]: record });
    return deepFreeze({ ok: true, capabilityId, expiresAt: record.expiresAt });
  });

  const exchangeAttachedForNavigationCopy = args => serialize(async () => {
    const input = readDataRecord(args, ATTACHED_COPY_EXCHANGE_KEYS);
    const context = input && parsePanelNavigationContext(input.senderContext, chromeApi.runtime.id);
    if (!input || !CAPABILITY_ID.test(input.capabilityId ?? '') || input.intent !== 'attached-copy' || !context) {
      return unavailable();
    }
    const targetKey = targetCapabilityStorageKey(input.capabilityId);
    const navigationKey = navigationCapabilityStorageKey(input.capabilityId);
    let firstEnvelope;
    try { firstEnvelope = await sessionArea.get([targetKey, navigationKey]); }
    catch { return unavailable(); }
    const target = parseTargetRecord(readStoredValue(firstEnvelope, targetKey));
    const existingNavigation = readDataProperty(firstEnvelope, navigationKey);
    const proofStartedAt = readNow(now);
    const issuer = target && parsePanelIssuer(target.issuer);
    if (!target || existingNavigation.found || target.capabilityId !== input.capabilityId ||
      target.kind !== 'attached' || target.createdBy !== 'user' || target.allowedIntent !== 'start-audit' ||
      target.state !== 'prepared' || target.sessionCapabilityId !== null || target.issuedAt > proofStartedAt ||
      target.expiresAt <= proofStartedAt || !issuer || context.windowId !== target.windowId ||
      !sameGraph(context.issuer, issuer)) return unavailable();
    let proof;
    try { proof = parseProof(await probeDocument(target.tabId)); }
    catch { return unavailable(); }
    const proofFinishedAt = readNow(now);
    if (proofFinishedAt < proofStartedAt || target.expiresAt <= proofFinishedAt || !proof ||
      proof.tabId !== target.tabId || proof.windowId !== target.windowId ||
      proof.documentId !== target.documentId || proof.urlSessionDigest !== target.initialUrlSessionDigest) {
      return unavailable();
    }
    let confirmingEnvelope;
    try { confirmingEnvelope = await sessionArea.get([targetKey, navigationKey]); }
    catch { return unavailable(); }
    const confirmingTarget = parseTargetRecord(readStoredValue(confirmingEnvelope, targetKey));
    if (!confirmingTarget || !sameGraph(confirmingTarget, target) ||
      readDataProperty(confirmingEnvelope, navigationKey).found) return unavailable();
    const commitStartedAt = readNow(now);
    if (commitStartedAt < proofFinishedAt || target.expiresAt <= commitStartedAt) return unavailable();
    const invalidated = { ...target, state: 'invalidated' };
    const navigation = {
      version: 1,
      capabilityId: target.capabilityId,
      intent: 'attached-copy',
      windowId: target.windowId,
      issuer,
      sessionCapabilityId: null,
      issuedAt: target.issuedAt,
      expiresAt: target.expiresAt,
      state: 'prepared',
    };
    try {
      await sessionArea.set({ [targetKey]: invalidated, [navigationKey]: navigation });
    } catch { /* An exact readback confirms commit-then-throw. */ }
    let confirmedValues;
    try { confirmedValues = readExactStoredValues(await sessionArea.get([targetKey, navigationKey]), [targetKey, navigationKey]); }
    catch { return unavailable(); }
    const confirmedTarget = parseTargetRecord(confirmedValues?.[targetKey]);
    const confirmedNavigation = parseNavigationRecord(confirmedValues?.[navigationKey]);
    if (!confirmedTarget || !confirmedNavigation || !sameGraph(confirmedTarget, invalidated) ||
      !sameGraph(confirmedNavigation, navigation)) return unavailable();
    return deepFreeze({ ok: true, capabilityId: target.capabilityId, expiresAt: target.expiresAt });
  });

  const inspectPreparedTarget = args => serialize(() => provePersonaTarget(args, false));
  const claimPreparedTarget = args => serialize(() => provePersonaTarget(args, true));
  const inspectPreparedAuditTarget = args => serialize(async () => {
    const input = readDataRecord(args, AUDIT_INSPECT_KEYS);
    if (!input || !CAPABILITY_ID.test(input.capabilityId ?? '') || input.allowedIntent !== 'start-audit') {
      return unavailable();
    }
    const key = targetCapabilityStorageKey(input.capabilityId);
    const target = parseTargetRecord(readStoredValue(await sessionArea.get(key), key));
    const proofStartedAt = readNow(now);
    if (!target || target.capabilityId !== input.capabilityId || target.kind !== 'attached' ||
      target.state !== 'prepared' || target.sessionCapabilityId !== null ||
      target.allowedIntent !== 'start-audit' || target.expiresAt <= proofStartedAt) return unavailable();
    const workerEvent = typeof input.eventNonce === 'string' && input.senderContext === null;
    const extension = input.eventNonce === null && validExtensionClaimContext(
      target,
      input.senderContext,
      chromeApi.runtime.id,
    );
    if (workerEvent) {
      const issuer = parseWorkerIssuer(target.issuer);
      if (!issuer || issuer.eventNonce !== input.eventNonce) return unavailable();
    } else if (!extension) return unavailable();
    let proof;
    try { proof = parseProof(await probeDocument(target.tabId)); }
    catch { return unavailable(); }
    const proofFinishedAt = readNow(now);
    if (proofFinishedAt < proofStartedAt || target.expiresAt <= proofFinishedAt || !proof ||
      proof.tabId !== target.tabId || proof.windowId !== target.windowId ||
      proof.documentId !== target.documentId ||
      proof.urlSessionDigest !== target.initialUrlSessionDigest) return unavailable();
    return deepFreeze({
      ok: true,
      target: {
        tabId: target.tabId,
        windowId: target.windowId,
        documentId: target.documentId,
        urlSessionDigest: target.initialUrlSessionDigest,
      },
    });
  });

  async function provePersonaTarget(args, consume) {
    const input = readDataRecord(args, PERSONA_CLAIM_KEYS);
    if (!input || !CAPABILITY_ID.test(input.capabilityId ?? '') || input.intent !== 'start-persona') {
      return unavailable();
    }
    const key = targetCapabilityStorageKey(input.capabilityId);
    const target = parseTargetRecord(readStoredValue(await sessionArea.get(key), key));
    const proofStartedAt = readNow(now);
    if (isPersonaTarget(target) && target.capabilityId === input.capabilityId &&
      (target.state !== 'prepared' || target.expiresAt <= proofStartedAt)) {
      await sessionArea.remove(key);
      return unavailable();
    }
    if (!target || target.capabilityId !== input.capabilityId || target.kind !== 'attached' ||
      target.state !== 'prepared' || target.sessionCapabilityId !== null ||
      target.allowedIntent !== 'start-persona' || target.issuedAt > proofStartedAt ||
      target.expiresAt <= proofStartedAt ||
      !validPersonaClaimContext(target, input.senderContext, chromeApi.runtime.id)) return unavailable();
    let proof;
    try { proof = parseProof(await probeDocument(target.tabId)); }
    catch { return unavailable(); }
    const proofFinishedAt = readNow(now);
    if (proofFinishedAt < proofStartedAt || target.expiresAt <= proofFinishedAt || !proof ||
      proof.tabId !== target.tabId || proof.windowId !== target.windowId ||
      proof.documentId !== target.documentId ||
      proof.urlSessionDigest !== target.initialUrlSessionDigest) return unavailable();
    if (consume) await sessionArea.remove(key);
    return deepFreeze({
      ok: true,
      target: {
        tabId: target.tabId,
        windowId: target.windowId,
        documentId: target.documentId,
        urlSessionDigest: target.initialUrlSessionDigest,
      },
    });
  }

  const claimAndIssueAuditSession = args => serialize(() => claimCommon(args, false));
  const claimNavigationAndIssueAuditSession = args => serialize(async () => {
    const input = readDataRecord(args, NAVIGATION_CLAIM_KEYS);
    const single = input?.intent === 'single' && /^owner_[A-Za-z0-9_-]{22}$/u.test(input.ownershipId ?? '');
    const batch = input?.intent === 'batch' && input.ownershipId === null;
    if (!input || !CAPABILITY_ID.test(input.capabilityId ?? '') || !MODEL_ID.test(input.auditId ?? '') ||
      (!single && !batch)) return unavailable();
    const key = navigationCapabilityStorageKey(input.capabilityId);
    const record = parseNavigationRecord(readStoredValue(await sessionArea.get(key), key));
    const currentTime = readNow(now);
    const context = parsePanelNavigationContext(input.senderContext, chromeApi.runtime.id);
    if (!record || record.capabilityId !== input.capabilityId || record.intent !== input.intent ||
      record.state !== 'prepared' || record.sessionCapabilityId !== null || record.issuedAt > currentTime ||
      record.expiresAt <= currentTime || !context || context.windowId !== record.windowId ||
      !sameGraph(context.issuer, record.issuer)) return unavailable();
    let sessionCapabilityId;
    try { sessionCapabilityId = createCapabilityId(randomBytes); } catch { return unavailable(); }
    const session = createSessionRecord({
      sessionCapabilityId,
      auditId: input.auditId,
      windowId: record.windowId,
      mode: input.intent,
      targetBinding: single
        ? { kind: 'disposable', ownershipId: input.ownershipId, state: 'pending' }
        : { kind: 'batch', activePageId: null, activeOwnershipId: null },
      state: 'running',
      issuedAt: currentTime,
      expiresAt: currentTime + sessionTtlMs,
    });
    const claimed = { ...record, sessionCapabilityId, state: 'claimed' };
    await sessionArea.set({
      [key]: claimed,
      [sessionCapabilityStorageKey(sessionCapabilityId)]: session,
    });
    return deepFreeze({
      ok: true, capabilityId: record.capabilityId, sessionCapabilityId,
      auditId: session.auditId, expiresAt: session.expiresAt,
    });
  });
  const claimExchangedAttachedCopyAndIssueAuditSession = args => serialize(async () => {
    const input = readDataRecord(args, ATTACHED_COPY_CLAIM_KEYS);
    if (!input || !CAPABILITY_ID.test(input.capabilityId ?? '') || !MODEL_ID.test(input.auditId ?? '') ||
      !/^owner_[A-Za-z0-9_-]{22}$/u.test(input.ownershipId ?? '')) return unavailable();
    const navigationKey = navigationCapabilityStorageKey(input.capabilityId);
    const record = parseNavigationRecord(readStoredValue(await sessionArea.get(navigationKey), navigationKey));
    const currentTime = readNow(now);
    const context = parsePanelNavigationContext(input.senderContext, chromeApi.runtime.id);
    if (!record || record.capabilityId !== input.capabilityId || record.intent !== 'attached-copy' ||
      record.state !== 'prepared' || record.sessionCapabilityId !== null || record.issuedAt > currentTime ||
      record.expiresAt <= currentTime || !context || context.windowId !== record.windowId ||
      !sameGraph(context.issuer, record.issuer)) return unavailable();
    let sessionCapabilityId;
    try { sessionCapabilityId = createCapabilityId(randomBytes); } catch { return unavailable(); }
    const session = createSessionRecord({
      sessionCapabilityId,
      auditId: input.auditId,
      windowId: record.windowId,
      mode: 'single',
      targetBinding: { kind: 'disposable', ownershipId: input.ownershipId, state: 'pending' },
      state: 'running',
      issuedAt: currentTime,
      expiresAt: currentTime + sessionTtlMs,
    });
    const claimed = { ...record, sessionCapabilityId, state: 'claimed' };
    const sessionKey = sessionCapabilityStorageKey(sessionCapabilityId);
    try { await sessionArea.set({ [navigationKey]: claimed, [sessionKey]: session }); }
    catch { /* Exact readback below confirms commit-then-throw. */ }
    let confirmedNavigation;
    let confirmedSession;
    try {
      const confirmed = readExactStoredValues(
        await sessionArea.get([navigationKey, sessionKey]),
        [navigationKey, sessionKey],
      );
      confirmedNavigation = parseNavigationRecord(confirmed?.[navigationKey]);
      confirmedSession = parseSessionRecord(confirmed?.[sessionKey]);
    } catch { return unavailable(); }
    if (!confirmedNavigation || !confirmedSession || !sameGraph(confirmedNavigation, claimed) ||
      !sameGraph(confirmedSession, session)) return unavailable();
    return deepFreeze({
      ok: true, capabilityId: record.capabilityId, sessionCapabilityId,
      auditId: session.auditId, expiresAt: session.expiresAt,
    });
  });
  const claimWorkerEventAndIssueAuditSession = args => serialize(() => claimCommon(args, true));

  async function claimCommon(args, workerEvent) {
    const input = readDataRecord(args, workerEvent ? WORKER_CLAIM_KEYS : EXTENSION_CLAIM_KEYS);
    if (!input || !CAPABILITY_ID.test(input.capabilityId ?? '') || (workerEvent && input.senderContext !== null)) return unavailable();
    const key = targetCapabilityStorageKey(input.capabilityId);
    const target = parseTargetRecord(readStoredValue(await sessionArea.get(key), key));
    const proofStartedAt = readNow(now);
    if (!target || target.capabilityId !== input.capabilityId ||
      target.state !== 'prepared' || target.expiresAt <= proofStartedAt ||
      target.allowedIntent !== input.allowedIntent || input.allowedIntent !== 'start-audit' || !MODEL_ID.test(input.auditId ?? '') ||
      typeof input.mode !== 'string' || !MODEL_ID.test(input.mode)) return unavailable();
    if (workerEvent) {
      if (!parseWorkerIssuer(target.issuer) || input.eventNonce !== target.issuer.eventNonce) return unavailable();
    } else if (!validExtensionClaimContext(target, input.senderContext, chromeApi.runtime.id)) return unavailable();
    let proof;
    try { proof = await probeDocument(target.tabId); } catch { return unavailable(); }
    proof = parseProof(proof);
    if (!proof || proof.tabId !== target.tabId || proof.windowId !== target.windowId ||
      proof.documentId !== target.documentId || proof.urlSessionDigest !== target.initialUrlSessionDigest) return unavailable();
    let sessionCapabilityId;
    try { sessionCapabilityId = createCapabilityId(randomBytes); } catch { return unavailable(); }
    const issuedAt = readNow(now);
    if (target.expiresAt <= issuedAt) return unavailable();
    const session = createSessionRecord({
      sessionCapabilityId,
      auditId: input.auditId,
      windowId: target.windowId,
      mode: input.mode,
      targetBinding: target.kind === 'attached'
        ? { kind: 'attached', tabId: target.tabId, documentId: target.documentId, urlSessionDigest: target.initialUrlSessionDigest }
        : { kind: 'disposable', ownershipId: target.capabilityId, state: 'pending' },
      state: 'running',
      issuedAt,
      expiresAt: issuedAt + sessionTtlMs,
    });
    const claimed = { ...target, sessionCapabilityId, state: 'claimed' };
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
    const input = readDataRecord(args, AUTHORIZE_KEYS) ?? readDataRecord(args, PANEL_AUTHORIZE_KEYS);
    if (!input || !CAPABILITY_ID.test(input.sessionCapabilityId ?? '') || !MODEL_ID.test(input.auditId ?? '') ||
      !['panel', 'review'].includes(input.consumer) || typeof input.intent !== 'string' ||
      (input.consumer === 'panel' && !safeChromeId(input.claimedWindowId)) ||
      (input.consumer === 'review' && Object.hasOwn(input, 'claimedWindowId'))) return sessionDenied();
    const descriptor = CONSUMERS.find(value => value.name === input.consumer);
    const surface = SURFACE_BY_PATH.get(descriptor.path);
    let context;
    try {
      context = await deriveTrustedExtensionContext({
        sender: input.sender,
        chromeApi,
        surface,
        ...(input.consumer === 'panel' ? { claimedWindowId: input.claimedWindowId } : {}),
      });
    }
    catch { return sessionDenied(); }
    const key = sessionCapabilityStorageKey(input.sessionCapabilityId);
    const session = parseSessionRecord(readStoredValue(await sessionArea.get(key), key));
    const currentTime = readNow(now);
    const stateIntents = session?.intents[input.consumer]?.[session.state] ??
      (session?.state === 'privacy-paused' ? (input.consumer === 'panel' ? ['cancel'] : []) : null);
    const allowed = session && session.sessionCapabilityId === input.sessionCapabilityId &&
      !(input.intent === 'review-markers' && (session.mode === 'batch' || session.targetBinding.kind === 'batch')) &&
      session.expiresAt > currentTime && session.auditId === input.auditId &&
      session.windowId === context.windowId && context.issuer.path === descriptor.path &&
      context.contextType === descriptor.contextType && session.consumers.some(value => sameConsumer(value, descriptor)) &&
      stateIntents?.includes(input.intent) === true;
    if (!allowed) return sessionDenied();
    if (surface.allowQuery === 'auditId-only' && new URL(context.documentUrl).searchParams.get('auditId') !== input.auditId) {
      return sessionDenied();
    }
    return deepFreeze({ ok: true, session: deepFreeze(structuredClone(session)), context });
  });

  const transitionAuditSession = args => serialize(async () => {
    const input = readDataRecord(args, TRANSITION_KEYS);
    if (!input || !CAPABILITY_ID.test(input.sessionCapabilityId ?? '') || !MODEL_ID.test(input.auditId ?? '')) {
      return transitionDenied();
    }
    const key = sessionCapabilityStorageKey(input.sessionCapabilityId);
    const session = parseSessionRecord(readStoredValue(await sessionArea.get(key), key));
    const activeBatchTarget = session?.targetBinding.kind === 'batch' &&
      MODEL_ID.test(session.targetBinding.activePageId ?? '') &&
      /^owner_[A-Za-z0-9_-]{22}$/u.test(session.targetBinding.activeOwnershipId ?? '');
    const pausableTarget = session?.targetBinding.kind === 'attached' || activeBatchTarget ||
      (session?.targetBinding.kind === 'disposable' && session.targetBinding.state === 'retained-for-consent');
    const resumableTarget = session?.targetBinding.kind === 'attached' || activeBatchTarget ||
      (session?.targetBinding.kind === 'disposable' && session.targetBinding.state === 'observing');
    const allowed = session && session.sessionCapabilityId === input.sessionCapabilityId &&
      session.auditId === input.auditId &&
      ((session.state === 'running' && (input.nextState === 'privacy-paused'
        ? pausableTarget : ['result', 'revoked'].includes(input.nextState))) ||
        (session.state === 'privacy-paused' && (input.nextState === 'running'
          ? resumableTarget : input.nextState === 'revoked')) ||
        (['result', 'view-only'].includes(session.state) && input.nextState === 'revoked'));
    if (!allowed) return transitionDenied();
    const changed = { ...session, state: input.nextState };
    try { await sessionArea.set({ [key]: changed }); } catch { /* readback confirms commit-then-throw */ }
    let confirmed;
    try { confirmed = parseSessionRecord(readStoredValue(await sessionArea.get(key), key)); }
    catch { return transitionDenied(); }
    if (!confirmed || !sameGraph(confirmed, changed)) return transitionDenied();
    return deepFreeze({ ok: true, sessionCapabilityId: session.sessionCapabilityId, auditId: session.auditId, state: changed.state });
  });

  const transitionDisposableAuditSession = args => serialize(async () => {
    const input = readDataRecord(args, DISPOSABLE_TRANSITION_KEYS);
    if (!input || !CAPABILITY_ID.test(input.sessionCapabilityId ?? '') || !MODEL_ID.test(input.auditId ?? '') ||
      !MODEL_ID.test(input.ownershipId ?? '') || !DISPOSABLE_BINDING_STATES.has(input.fromState) ||
      !DISPOSABLE_BINDING_STATES.has(input.toState)) return transitionDenied();
    const allowed = new Set([
      'pending:observing', 'pending:retained-for-review', 'pending:cleanup-pending', 'pending:removed',
      'observing:retained-for-review', 'observing:retained-for-consent', 'observing:cleanup-pending', 'observing:removed',
      'retained-for-consent:observing', 'retained-for-consent:cleanup-pending', 'retained-for-consent:removed',
      'retained-for-review:cleanup-pending', 'retained-for-review:removed', 'cleanup-pending:removed',
    ]);
    if (!allowed.has(`${input.fromState}:${input.toState}`)) return transitionDenied();
    const key = sessionCapabilityStorageKey(input.sessionCapabilityId);
    const session = parseSessionRecord(readStoredValue(await sessionArea.get(key), key));
    if (!session || session.sessionCapabilityId !== input.sessionCapabilityId || session.auditId !== input.auditId ||
      session.targetBinding.kind !== 'disposable' || session.targetBinding.ownershipId !== input.ownershipId ||
      session.targetBinding.state !== input.fromState) return transitionDenied();
    const changed = { ...session, targetBinding: { ...session.targetBinding, state: input.toState } };
    try { await sessionArea.set({ [key]: changed }); } catch { /* readback confirms commit-then-throw */ }
    let confirmed;
    try { confirmed = parseSessionRecord(readStoredValue(await sessionArea.get(key), key)); }
    catch { return transitionDenied(); }
    if (!confirmed || !sameGraph(confirmed, changed)) return transitionDenied();
    return deepFreeze({
      ok: true, sessionCapabilityId: session.sessionCapabilityId, auditId: session.auditId,
      ownershipId: input.ownershipId, state: input.toState,
    });
  });

  const transitionBatchAuditSession = args => serialize(async () => {
    const input = readDataRecord(args, BATCH_TRANSITION_KEYS);
    const fromEmpty = input?.fromPageId === null && input?.fromOwnershipId === null;
    const toEmpty = input?.toPageId === null && input?.toOwnershipId === null;
    const validPair = (pageId, ownershipId) => MODEL_ID.test(pageId ?? '') &&
      /^owner_[A-Za-z0-9_-]{22}$/u.test(ownershipId ?? '');
    if (!input || !CAPABILITY_ID.test(input.sessionCapabilityId ?? '') || !MODEL_ID.test(input.auditId ?? '') ||
      (!fromEmpty && !validPair(input.fromPageId, input.fromOwnershipId)) ||
      (!toEmpty && !validPair(input.toPageId, input.toOwnershipId)) || fromEmpty === toEmpty) {
      return transitionDenied();
    }
    const key = sessionCapabilityStorageKey(input.sessionCapabilityId);
    const session = parseSessionRecord(readStoredValue(await sessionArea.get(key), key));
    const recoveryClear = session?.state === 'revoked' && !fromEmpty && toEmpty;
    if (!session || session.sessionCapabilityId !== input.sessionCapabilityId || session.auditId !== input.auditId ||
      session.mode !== 'batch' || !(session.state === 'running' || recoveryClear) || session.targetBinding.kind !== 'batch' ||
      session.targetBinding.activePageId !== input.fromPageId ||
      session.targetBinding.activeOwnershipId !== input.fromOwnershipId) return transitionDenied();
    const changed = {
      ...session,
      targetBinding: { kind: 'batch', activePageId: input.toPageId, activeOwnershipId: input.toOwnershipId },
    };
    try { await sessionArea.set({ [key]: changed }); } catch { /* readback confirms commit-then-throw */ }
    let confirmed;
    try { confirmed = parseSessionRecord(readStoredValue(await sessionArea.get(key), key)); }
    catch { return transitionDenied(); }
    if (!confirmed || !sameGraph(confirmed, changed)) return transitionDenied();
    return deepFreeze({
      ok: true, sessionCapabilityId: session.sessionCapabilityId, auditId: session.auditId,
      activePageId: input.toPageId, activeOwnershipId: input.toOwnershipId,
    });
  });

  const invalidateCapability = (capabilityId, reason) => serialize(async () => {
    if (!CAPABILITY_ID.test(capabilityId ?? '') || typeof reason !== 'string' || !reason) return unavailable();
    const targetKey = targetCapabilityStorageKey(capabilityId);
    const navigationKey = navigationCapabilityStorageKey(capabilityId);
    const targetEnvelope = await sessionArea.get(targetKey);
    const navigationEnvelope = await sessionArea.get(navigationKey);
    const targetProperty = readDataProperty(targetEnvelope, targetKey);
    const navigationProperty = readDataProperty(navigationEnvelope, navigationKey);
    const target = targetProperty.found ? parseTargetRecord(targetProperty.value) : null;
    const navigation = navigationProperty.found ? parseNavigationRecord(navigationProperty.value) : null;
    if (targetProperty.found && (!target || target.capabilityId !== capabilityId) ||
      navigationProperty.found && (!navigation || navigation.capabilityId !== capabilityId) ||
      !target && !navigation) return unavailable();
    if (isPersonaTarget(target)) {
      if (navigation) return unavailable();
      try { await sessionArea.remove(targetKey); } catch { /* exact absence below is authoritative */ }
      if (readDataProperty(await sessionArea.get(targetKey), targetKey).found) return unavailable();
      return deepFreeze({ ok: true, capabilityId });
    }
    const targetChanged = target && target.state !== 'invalidated' ? { ...target, state: 'invalidated' } : target;
    const navigationChanged = navigation && navigation.state !== 'invalidated'
      ? { ...navigation, state: 'invalidated' }
      : navigation;
    const targetSessionId = target?.sessionCapabilityId ?? null;
    const navigationSessionId = navigation?.sessionCapabilityId ?? null;
    if (targetSessionId && navigationSessionId && targetSessionId !== navigationSessionId) return unavailable();
    const sessionCapabilityId = navigationSessionId ?? targetSessionId;
    let session = null;
    let changedSession = null;
    let sessionKey = null;
    if (sessionCapabilityId !== null) {
      sessionKey = sessionCapabilityStorageKey(sessionCapabilityId);
      session = parseSessionRecord(readStoredValue(await sessionArea.get(sessionKey), sessionKey));
      if (!session || session.sessionCapabilityId !== sessionCapabilityId || session.windowId !==
        (navigation?.windowId ?? target?.windowId)) return unavailable();
      changedSession = reason === 'AUDIT_START_COMPENSATED' && session.state === 'running'
        ? { ...session, state: 'revoked' }
        : session;
    }
    const changes = {};
    if (targetChanged && !sameGraph(targetChanged, target)) changes[targetKey] = targetChanged;
    if (navigationChanged && !sameGraph(navigationChanged, navigation)) changes[navigationKey] = navigationChanged;
    if (changedSession && !sameGraph(changedSession, session)) changes[sessionKey] = changedSession;
    try { if (Object.keys(changes).length > 0) await sessionArea.set(changes); }
    catch { /* Exact readback below confirms commit-then-throw. */ }
    const confirmedTarget = targetChanged
      ? parseTargetRecord(readStoredValue(await sessionArea.get(targetKey), targetKey))
      : null;
    const confirmedNavigation = navigationChanged
      ? parseNavigationRecord(readStoredValue(await sessionArea.get(navigationKey), navigationKey))
      : null;
    const confirmedSession = changedSession
      ? parseSessionRecord(readStoredValue(await sessionArea.get(sessionKey), sessionKey))
      : null;
    if (targetChanged && (!confirmedTarget || !sameGraph(confirmedTarget, targetChanged)) ||
      navigationChanged && (!confirmedNavigation || !sameGraph(confirmedNavigation, navigationChanged)) ||
      changedSession && (!confirmedSession || !sameGraph(confirmedSession, changedSession))) return unavailable();
    return deepFreeze({ ok: true, capabilityId });
  });

  const invalidateForTab = (tabId, reason) => invalidateBy(
    record => (record.type === 'target' && record.value.tabId === tabId) ||
      (record.type === 'session' && record.value.targetBinding.kind === 'attached' && record.value.targetBinding.tabId === tabId),
    reason,
  );
  const invalidateForWindow = (windowId, reason) => invalidateBy(
    record => record.value.windowId === windowId,
    reason,
  );

  function invalidateBy(predicate, reason) {
    return serialize(async () => {
      if (typeof reason !== 'string' || !reason) return unavailable();
      const all = await sessionArea.get(null);
      const changes = {};
      const removals = [];
      for (const [key, rawRecord] of readStorageEntries(all)) {
        const target = parseTargetRecord(rawRecord);
        const navigation = parseNavigationRecord(rawRecord);
        const session = parseSessionRecord(rawRecord);
        const record = target && key === targetCapabilityStorageKey(target.capabilityId)
          ? { type: 'target', value: target }
          : navigation && key === navigationCapabilityStorageKey(navigation.capabilityId)
            ? { type: 'navigation', value: navigation }
          : session && key === sessionCapabilityStorageKey(session.sessionCapabilityId)
            ? { type: 'session', value: session }
            : null;
        if (!record || !predicate(record)) continue;
        if (record.type === 'target' && isPersonaTarget(record.value)) removals.push(key);
        else if (['target', 'navigation'].includes(record.type) && record.value.state !== 'invalidated') changes[key] = { ...record.value, state: 'invalidated' };
        if (record.type === 'session' && record.value.state !== 'revoked') changes[key] = { ...record.value, state: 'revoked' };
      }
      if (Object.keys(changes).length > 0) await sessionArea.set(changes);
      if (removals.length > 0) await sessionArea.remove(removals);
      return deepFreeze({ ok: true, invalidated: Object.keys(changes).length + removals.length });
    });
  }

  const clearAudit = auditId => serialize(async () => {
    if (typeof auditId !== 'string' || !MODEL_ID.test(auditId)) return unavailable();
    try {
      const raw = await sessionArea.get(null);
      const inventory = readDataRecord(raw, Reflect.ownKeys(raw));
      if (!inventory) return unavailable();
      const entries = Object.entries(inventory);
      const sessions = new Map();
      const expected = new Map();
      const changes = {};
      const plan = (key, record, state, parse) => {
        const changed = record.state === state ? record : { ...record, state };
        expected.set(key, { record: changed, parse });
        if (record.state !== state) changes[key] = changed;
      };
      for (const [key, value] of entries) {
        if (!key.startsWith(SESSION_PREFIX) || readDataProperty(value, 'auditId').value !== auditId) continue;
        const session = parseSessionRecord(value);
        if (!session || key !== sessionCapabilityStorageKey(session.sessionCapabilityId)) return unavailable();
        sessions.set(session.sessionCapabilityId, session);
        plan(key, session, 'revoked', parseSessionRecord);
      }
      for (const [key, value] of entries) {
        const targetKind = key.startsWith(TARGET_PREFIX);
        if (!targetKind && !key.startsWith(NAVIGATION_PREFIX)) continue;
        const session = sessions.get(readDataProperty(value, 'sessionCapabilityId').value);
        if (!session) continue;
        const parse = targetKind ? parseTargetRecord : parseNavigationRecord;
        const record = parse(value);
        const storageKey = targetKind ? targetCapabilityStorageKey : navigationCapabilityStorageKey;
        if (!record || key !== storageKey(record.capabilityId) || record.windowId !== session.windowId ||
          (targetKind && isPersonaTarget(record))) return unavailable();
        plan(key, record, 'invalidated', parse);
      }
      const keys = [...expected.keys()];
      const invalidated = Object.keys(changes).length;
      try { if (invalidated > 0) await sessionArea.set(changes); }
      catch { /* Confirm every planned record, including commit-then-throw. */ }
      if (keys.length > 0) {
        const confirmed = readExactStoredValues(await sessionArea.get(keys), keys);
        if (!confirmed) return unavailable();
        for (const [key, value] of expected) {
          const record = value.parse(confirmed[key]);
          if (!record || !sameGraph(record, value.record)) return unavailable();
        }
      }
      return deepFreeze({ ok: true, invalidated });
    } catch { return unavailable(); }
  });

  const finalizeAudit = auditId => serialize(async () => {
    if (typeof auditId !== 'string' || !MODEL_ID.test(auditId)) return unavailable();
    try {
      const raw = await sessionArea.get(null);
      const inventory = readDataRecord(raw, Reflect.ownKeys(raw));
      if (!inventory) return unavailable();
      const entries = Object.entries(inventory);
      const sessions = new Map();
      const sessionKeys = [];
      const childKeys = [];
      for (const [key, value] of entries) {
        if (!key.startsWith(SESSION_PREFIX) || readDataProperty(value, 'auditId').value !== auditId) continue;
        const session = parseSessionRecord(value);
        if (!session || key !== sessionCapabilityStorageKey(session.sessionCapabilityId) || session.state !== 'revoked') {
          return unavailable();
        }
        sessions.set(session.sessionCapabilityId, session);
        sessionKeys.push(key);
      }
      for (const [key, value] of entries) {
        const targetKind = key.startsWith(TARGET_PREFIX);
        if (!targetKind && !key.startsWith(NAVIGATION_PREFIX)) continue;
        const session = sessions.get(readDataProperty(value, 'sessionCapabilityId').value);
        if (!session) continue;
        const parse = targetKind ? parseTargetRecord : parseNavigationRecord;
        const record = parse(value);
        const storageKey = targetKind ? targetCapabilityStorageKey : navigationCapabilityStorageKey;
        if (!record || key !== storageKey(record.capabilityId) || record.windowId !== session.windowId ||
          record.state !== 'invalidated' || (targetKind && isPersonaTarget(record))) return unavailable();
        childKeys.push(key);
      }
      const removeConfirmed = async keys => {
        if (keys.length === 0) return true;
        try { await sessionArea.remove(keys); } catch { /* Confirm commit-then-throw before retrying. */ }
        return Boolean(readDataRecord(await sessionArea.get(keys), []));
      };
      if (!await removeConfirmed(childKeys) || !await removeConfirmed(sessionKeys)) return unavailable();
      return deepFreeze({ ok: true, purged: childKeys.length + sessionKeys.length });
    } catch { return unavailable(); }
  });

  const rehydrateViewOnly = args => serialize(async () => {
    const input = readDataRecord(args, REHYDRATE_KEYS);
    if (!input || !MODEL_ID.test(input.auditId ?? '') || input.mode !== 'attached' ||
      !safeChromeId(input.windowId)) return sessionDenied();
    const currentTime = readNow(now);
    const sessionCapabilityId = createCapabilityId(randomBytes);
    const session = createSessionRecord({
      sessionCapabilityId,
      auditId: input.auditId,
      windowId: input.windowId,
      mode: input.mode,
      targetBinding: { kind: 'view-only' },
      state: 'view-only',
      issuedAt: currentTime,
      expiresAt: currentTime + sessionTtlMs,
    });
    await sessionArea.set({ [sessionCapabilityStorageKey(sessionCapabilityId)]: session });
    return deepFreeze({ ok: true, sessionCapabilityId, auditId: input.auditId, expiresAt: session.expiresAt });
  });

  return Object.freeze({
    prepare,
    prepareNavigationForPanel,
    exchangeAttachedForNavigationCopy,
    inspectPreparedTarget,
    claimPreparedTarget,
    inspectPreparedAuditTarget,
    claimAndIssueAuditSession,
    claimNavigationAndIssueAuditSession,
    claimExchangedAttachedCopyAndIssueAuditSession,
    claimWorkerEventAndIssueAuditSession,
    authorizeSession,
    transitionAuditSession,
    transitionDisposableAuditSession,
    transitionBatchAuditSession,
    invalidateCapability,
    invalidateForTab,
    invalidateForWindow,
    clearAudit,
    finalizeAudit,
    rehydrateViewOnly,
  });
}

function createTargetRecord(value) {
  const issuer = parseIssuer(value.issuer);
  const personaTarget = value.kind === 'attached' && value.createdBy === 'user' &&
    value.allowedIntent === 'start-persona' && Boolean(parsePanelIssuer(value.issuer));
  const auditTarget = ['user', 'audit'].includes(value.createdBy) && value.allowedIntent === 'start-audit';
  if (!['attached', 'disposable'].includes(value.kind) || !CAPABILITY_ID.test(value.capabilityId ?? '') ||
    !safeChromeId(value.tabId) || !safeChromeId(value.windowId) || !validDocumentId(value.documentId) ||
    !validEvidenceUrl(value.initialUrlEvidence) || !DIGEST.test(value.initialUrlSessionDigest ?? '') ||
    (!auditTarget && !personaTarget) ||
    !issuer || !safeTime(value.issuedAt) || !safeTime(value.expiresAt) ||
    value.expiresAt <= value.issuedAt || value.state !== 'prepared') {
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
    issuer,
    sessionCapabilityId: null,
    issuedAt: value.issuedAt,
    expiresAt: value.expiresAt,
    state: value.state,
  };
}

function isPersonaTarget(value) {
  return Boolean(value && value.kind === 'attached' && value.createdBy === 'user' &&
    value.allowedIntent === 'start-persona' && parsePanelIssuer(value.issuer));
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
    intents: structuredClone(value.mode === 'batch' ? PRE_MARKERS_INTENTS : INTENTS),
    state: value.state,
    issuedAt: value.issuedAt,
    expiresAt: value.expiresAt,
  };
}

function parseTargetRecord(value) {
  const record = readDataRecord(value, TARGET_KEYS);
  if (!record) return null;
  const issuer = parseIssuer(record.issuer);
  const personaTarget = record.kind === 'attached' && record.createdBy === 'user' &&
    record.allowedIntent === 'start-persona' && Boolean(parsePanelIssuer(record.issuer));
  const auditTarget = ['user', 'audit'].includes(record.createdBy) && record.allowedIntent === 'start-audit';
  if (record.version !== 1 || !CAPABILITY_ID.test(record.capabilityId ?? '') ||
    !['attached', 'disposable'].includes(record.kind) || !safeChromeId(record.tabId) ||
    !safeChromeId(record.windowId) || !validDocumentId(record.documentId) ||
    !validEvidenceUrl(record.initialUrlEvidence) || !DIGEST.test(record.initialUrlSessionDigest ?? '') ||
    (!auditTarget && !personaTarget) ||
    !issuer || !safeTime(record.issuedAt) || !safeTime(record.expiresAt) || record.expiresAt <= record.issuedAt ||
    !['prepared', 'claimed', 'invalidated'].includes(record.state) ||
    (record.state === 'prepared' && record.sessionCapabilityId !== null) ||
    (record.state === 'claimed' && (personaTarget
      ? record.sessionCapabilityId !== null
      : !CAPABILITY_ID.test(record.sessionCapabilityId ?? ''))) ||
    (record.state === 'invalidated' && record.sessionCapabilityId !== null && !CAPABILITY_ID.test(record.sessionCapabilityId ?? ''))) return null;
  return { ...record, issuer };
}

function parseNavigationRecord(value) {
  const record = readDataRecord(value, NAVIGATION_KEYS);
  const issuer = record && parsePanelIssuer(record.issuer);
  if (!record || record.version !== 1 || !CAPABILITY_ID.test(record.capabilityId ?? '') ||
    !['single', 'batch', 'attached-copy'].includes(record.intent) || !safeChromeId(record.windowId) || !issuer ||
    !safeTime(record.issuedAt) || !safeTime(record.expiresAt) || record.expiresAt <= record.issuedAt ||
    !['prepared', 'claimed', 'invalidated'].includes(record.state) ||
    (record.state === 'prepared' && record.sessionCapabilityId !== null) ||
    (['claimed', 'invalidated'].includes(record.state) && record.sessionCapabilityId !== null &&
      !CAPABILITY_ID.test(record.sessionCapabilityId ?? ''))) return null;
  return { ...record, issuer };
}

function parsePanelNavigationContext(value, runtimeId) {
  const context = readDataRecord(value, ['issuer', 'windowId', 'tabId', 'contextType', 'documentUrl']);
  const issuer = context && parsePanelIssuer(context.issuer);
  if (!context || !issuer || !safeChromeId(context.windowId) || context.tabId !== null ||
    context.contextType !== PANEL_SURFACE.contextType ||
    !validExtensionSurfaceUrl(context.documentUrl, runtimeId, PANEL_SURFACE)) return null;
  return { ...context, issuer };
}

function parseSessionRecord(value) {
  const record = readDataRecord(value, SESSION_KEYS);
  if (!record) return null;
  const targetBinding = parseTargetBinding(record.targetBinding);
  const consumers = parseConsumers(record.consumers);
  const intents = parseIntents(record.intents);
  if (record.version !== 1 || !CAPABILITY_ID.test(record.sessionCapabilityId ?? '') ||
    !MODEL_ID.test(record.auditId ?? '') || !safeChromeId(record.windowId) || !MODEL_ID.test(record.mode ?? '') ||
    !targetBinding || !consumers || !intents || !['running', 'privacy-paused', 'result', 'view-only', 'revoked'].includes(record.state) ||
    (targetBinding.kind === 'view-only' && !['view-only', 'revoked'].includes(record.state)) ||
    (record.state === 'view-only' && targetBinding.kind !== 'view-only') ||
    (record.state === 'privacy-paused' && targetBinding.kind !== 'attached' && targetBinding.kind !== 'batch' &&
      !(targetBinding.kind === 'disposable' &&
        ['retained-for-consent', 'observing'].includes(targetBinding.state))) ||
    !safeTime(record.issuedAt) || !safeTime(record.expiresAt) || record.expiresAt <= record.issuedAt) return null;
  return { ...record, targetBinding, consumers, intents };
}

function parseTargetBinding(value) {
  const kind = readDataProperty(value, 'kind');
  if (!kind.found) return null;
  if (kind.value === 'attached') {
    const binding = readDataRecord(value, ['kind', 'tabId', 'documentId', 'urlSessionDigest']);
    return binding && safeChromeId(binding.tabId) && validDocumentId(binding.documentId) &&
      DIGEST.test(binding.urlSessionDigest ?? '') ? binding : null;
  }
  if (kind.value === 'view-only') {
    const binding = readDataRecord(value, ['kind']);
    return binding?.kind === 'view-only' ? binding : null;
  }
  if (kind.value === 'batch') {
    const binding = readDataRecord(value, ['kind', 'activePageId', 'activeOwnershipId']);
    const empty = binding?.activePageId === null && binding?.activeOwnershipId === null;
    const active = MODEL_ID.test(binding?.activePageId ?? '') &&
      /^owner_[A-Za-z0-9_-]{22}$/u.test(binding?.activeOwnershipId ?? '');
    return binding && (empty || active) ? binding : null;
  }
  const binding = readDataRecord(value, ['kind', 'ownershipId', 'state']);
  return binding && binding.kind === 'disposable' && MODEL_ID.test(binding.ownershipId ?? '') &&
    DISPOSABLE_BINDING_STATES.has(binding.state) ? binding : null;
}

function validExtensionClaimContext(target, context, runtimeId) {
  const targetIssuer = parseExtensionIssuer(target.issuer);
  const parsedContext = readDataRecord(context, ['issuer', 'windowId', 'tabId', 'contextType', 'documentUrl']);
  const contextIssuer = parsedContext && parseExtensionIssuer(parsedContext.issuer);
  if (!targetIssuer || !parsedContext || !contextIssuer) return false;
  const surface = SURFACE_BY_PATH.get(targetIssuer.path);
  return Boolean(surface && contextIssuer.documentId === targetIssuer.documentId &&
    contextIssuer.path === targetIssuer.path && parsedContext.windowId === target.windowId &&
    parsedContext.contextType === surface.contextType &&
    validExtensionSurfaceUrl(parsedContext.documentUrl, runtimeId, surface));
}

function validPersonaClaimContext(target, context, runtimeId) {
  const targetIssuer = parsePanelIssuer(target.issuer);
  const parsedContext = readDataRecord(context, ['issuer', 'windowId', 'tabId', 'contextType', 'documentUrl']);
  const contextIssuer = parsedContext && parsePanelIssuer(parsedContext.issuer);
  return Boolean(targetIssuer && parsedContext && contextIssuer &&
    contextIssuer.documentId === targetIssuer.documentId &&
    parsedContext.windowId === target.windowId && parsedContext.tabId === null &&
    parsedContext.contextType === PANEL_SURFACE.contextType &&
    validExtensionSurfaceUrl(parsedContext.documentUrl, runtimeId, PANEL_SURFACE));
}

function validExtensionSurfaceUrl(value, runtimeId, surface) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    if (url.protocol !== 'chrome-extension:' || url.hostname !== runtimeId || url.pathname !== surface.path ||
      url.username !== '' || url.password !== '' || url.port !== '' || url.hash !== '') return false;
    if (surface.allowQuery === false) return url.search === '';
    if (surface.allowQuery === 'launch-only') {
      const tokens = url.searchParams.getAll('launch');
      return [...url.searchParams.keys()].every(key => key === 'launch') && tokens.length === 1 &&
        /^[A-Za-z0-9_-]{43}$/u.test(tokens[0]);
    }
    if (surface.allowQuery === 'auditId-only') {
      const auditIds = url.searchParams.getAll('auditId');
      return [...url.searchParams.keys()].every(key => key === 'auditId') && auditIds.length === 1 &&
        /^[A-Za-z0-9_-]{1,160}$/u.test(auditIds[0]);
    }
    return surface.allowQuery === true;
  } catch {
    return false;
  }
}

function parseIssuer(value) { return parseExtensionIssuer(value) ?? parseWorkerIssuer(value); }
function parsePanelIssuer(value) {
  const issuer = parseExtensionIssuer(value);
  return issuer?.path === PANEL_SURFACE.path ? issuer : null;
}
function parseExtensionIssuer(value) {
  const issuer = readDataRecord(value, ['type', 'documentId', 'path']);
  return issuer && issuer.type === 'extension-document' && validDocumentId(issuer.documentId) &&
    SURFACE_BY_PATH.has(issuer.path) ? issuer : null;
}
function parseWorkerIssuer(value) {
  const issuer = readDataRecord(value, ['type', 'event', 'eventNonce']);
  return issuer && issuer.type === 'worker-event' && issuer.event === 'context-menu' &&
    typeof issuer.eventNonce === 'string' && /^[A-Za-z0-9._:-]{20,240}$/u.test(issuer.eventNonce) ? issuer : null;
}
function parseProof(value) {
  const proof = readDataRecord(value, PROOF_KEYS);
  return proof && safeChromeId(proof.tabId) && safeChromeId(proof.windowId) &&
    validDocumentId(proof.documentId) && DIGEST.test(proof.urlSessionDigest ?? '') ? proof : null;
}
function parseConsumers(value) {
  const entries = readDataArray(value);
  if (!entries || entries.length !== CONSUMERS.length) return null;
  const consumers = entries.map((entry, index) => {
    const consumer = readDataRecord(entry, ['name', 'path', 'contextType']);
    return consumer && sameConsumer(consumer, CONSUMERS[index]) ? consumer : null;
  });
  return consumers.every(Boolean) ? consumers : null;
}
function parseIntents(value) {
  const intents = readDataRecord(value, ['panel', 'review']);
  if (!intents) return null;
  const panel = readDataRecord(intents.panel, ['running', 'privacy-paused', 'result', 'view-only']);
  const review = readDataRecord(intents.review, ['running', 'privacy-paused', 'result', 'view-only']);
  if (panel && review) {
    for (const allowed of [INTENTS, PRE_MARKERS_INTENTS]) {
      if (sameDataArray(panel.running, allowed.panel.running) &&
        sameDataArray(panel['privacy-paused'], allowed.panel['privacy-paused']) &&
        sameDataArray(panel.result, allowed.panel.result) &&
        sameDataArray(panel['view-only'], allowed.panel['view-only']) &&
        sameDataArray(review.running, allowed.review.running) &&
        sameDataArray(review['privacy-paused'], allowed.review['privacy-paused']) &&
        sameDataArray(review.result, allowed.review.result) &&
        sameDataArray(review['view-only'], allowed.review['view-only'])) {
        return structuredClone(allowed);
      }
    }
  }
  const oldPanel = readDataRecord(intents.panel, ['running', 'result', 'view-only']);
  const oldReview = readDataRecord(intents.review, ['running', 'result', 'view-only']);
  if (!oldPanel || !oldReview) return null;
  for (const stored of [PRE_PRIVACY_INTENTS, LEGACY_STORAGE_INTENTS]) {
    if (sameDataArray(oldPanel.running, stored.panel.running) &&
      sameDataArray(oldPanel.result, stored.panel.result) &&
      sameDataArray(oldPanel['view-only'], stored.panel['view-only']) &&
      sameDataArray(oldReview.running, stored.review.running) &&
      sameDataArray(oldReview.result, stored.review.result) &&
      sameDataArray(oldReview['view-only'], stored.review['view-only'])) return structuredClone(stored);
  }
  return null;
}
function validClaimedCorrelation(target, session, input) {
  return target.capabilityId === input.capabilityId && target.kind === 'attached' && target.allowedIntent === 'start-audit' &&
    target.state === 'claimed' && target.sessionCapabilityId === input.sessionCapabilityId &&
    session.sessionCapabilityId === input.sessionCapabilityId && session.auditId === input.auditId &&
    session.windowId === target.windowId && session.mode === 'attached' && session.state === 'running' &&
    session.targetBinding.kind === 'attached' && session.targetBinding.tabId === target.tabId &&
    session.targetBinding.documentId === target.documentId &&
    session.targetBinding.urlSessionDigest === target.initialUrlSessionDigest;
}
function validRecoveryTarget(target, capabilityId) {
  return Boolean(target && target.capabilityId === capabilityId && target.kind === 'attached' &&
    target.allowedIntent === 'start-audit' && ['prepared', 'claimed', 'invalidated'].includes(target.state));
}
function validRecoverySession(session, target, auditId) {
  if (!session || session.sessionCapabilityId !== target.sessionCapabilityId || session.auditId !== auditId ||
    session.windowId !== target.windowId || session.mode !== 'attached' ||
    !['running', 'privacy-paused', 'result', 'view-only', 'revoked'].includes(session.state)) return false;
  if (session.targetBinding.kind === 'view-only') return ['view-only', 'revoked'].includes(session.state);
  if (session.state === 'privacy-paused' && session.targetBinding.kind !== 'attached') return false;
  return session.targetBinding.kind === 'attached' && session.targetBinding.tabId === target.tabId &&
    session.targetBinding.documentId === target.documentId &&
    session.targetBinding.urlSessionDigest === target.initialUrlSessionDigest;
}
function copyWorkerSession(session) {
  return deepFreeze({
    version: 1,
    sessionCapabilityId: session.sessionCapabilityId,
    auditId: session.auditId,
    windowId: session.windowId,
    mode: session.mode,
    targetBinding: structuredClone(session.targetBinding),
    state: session.state,
    issuedAt: session.issuedAt,
    expiresAt: session.expiresAt,
  });
}
function readEpoch(epochNow) {
  const value = epochNow();
  if (!safeTime(value)) throw new TypeError('CAPABILITY_TIME_INVALID');
  return value;
}
function sameGraph(first, second) {
  if (Object.is(first, second)) return true;
  if (first === null || second === null || typeof first !== 'object' || typeof second !== 'object' ||
    Array.isArray(first) !== Array.isArray(second)) return false;
  const firstKeys = Reflect.ownKeys(first);
  const secondKeys = Reflect.ownKeys(second);
  return firstKeys.length === secondKeys.length && firstKeys.every(key => secondKeys.includes(key) && sameGraph(first[key], second[key]));
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
async function provePanelWindowClaim(chromeApi, windowId) {
  if (typeof chromeApi?.windows?.get !== 'function' || typeof chromeApi?.tabs?.query !== 'function') {
    throw new Error('CONTEXT_DENIED');
  }
  const browserWindow = await chromeApi.windows.get(windowId, { populate: false });
  const verifiedWindowId = readDataProperty(browserWindow, 'id');
  const windowType = readDataProperty(browserWindow, 'type');
  if (!verifiedWindowId.found || verifiedWindowId.value !== windowId ||
    !windowType.found || windowType.value !== 'normal') throw new Error('CONTEXT_DENIED');
  const tabs = readDataArray(await chromeApi.tabs.query({ active: true, windowId }));
  if (!tabs || tabs.length !== 1 || !validPanelActiveTab(tabs[0], windowId)) throw new Error('CONTEXT_DENIED');
}
function validPanelActiveTab(tab, windowId) {
  const tabId = readDataProperty(tab, 'id');
  const tabWindowId = readDataProperty(tab, 'windowId');
  const active = readDataProperty(tab, 'active');
  const status = readDataProperty(tab, 'status');
  const url = readDataProperty(tab, 'url');
  const pendingUrl = readOptionalDataProperty(tab, 'pendingUrl');
  return tabId.found && safeChromeId(tabId.value) && tabWindowId.found && tabWindowId.value === windowId &&
    active.found && active.value === true &&
    status.found && status.value === 'complete' && url.found && canonicalHttpUrl(url.value) &&
    !pendingUrl.invalid && (!pendingUrl.found || pendingUrl.value === null || pendingUrl.value === '');
}
function canonicalHttpUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const parsed = new URL(value);
    return ['http:', 'https:'].includes(parsed.protocol) && parsed.href === value &&
      parsed.username === '' && parsed.password === '';
  } catch { return false; }
}
function readOptionalDataProperty(value, key) {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return { found: false, invalid: true };
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return { found: false, invalid: true };
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) return { found: false, invalid: false };
    return descriptor.enumerable === true && Object.hasOwn(descriptor, 'value')
      ? { found: true, invalid: false, value: descriptor.value }
      : { found: true, invalid: true };
  } catch {
    return { found: true, invalid: true };
  }
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
  const consumer = readDataRecord(first, ['name', 'path', 'contextType']);
  return Boolean(consumer && consumer.name === second.name && consumer.path === second.path &&
    consumer.contextType === second.contextType);
}
function sameDataArray(value, expected) {
  const entries = readDataArray(value);
  return Boolean(entries && entries.length === expected.length && entries.every((entry, index) => entry === expected[index]));
}
function readDataRecord(value, expectedKeys) {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== expectedKeys.length || ownKeys.some(key => typeof key !== 'string' || !expectedKeys.includes(key))) {
      return null;
    }
    const record = {};
    for (const key of expectedKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) return null;
      record[key] = descriptor.value;
    }
    return record;
  } catch {
    return null;
  }
}
function readDataProperty(value, key) {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return { found: false };
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return { found: false };
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && descriptor.enumerable === true && Object.hasOwn(descriptor, 'value')
      ? { found: true, value: descriptor.value }
      : { found: false };
  } catch {
    return { found: false };
  }
}
function readDataArray(value) {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, 'value') || !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0) return null;
    const expectedKeys = Array.from({ length: lengthDescriptor.value }, (_, index) => String(index));
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== expectedKeys.length + 1 || !ownKeys.includes('length') ||
      ownKeys.some(key => typeof key !== 'string' || (key !== 'length' && !expectedKeys.includes(key)))) return null;
    const entries = [];
    for (const key of expectedKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) return null;
      entries.push(descriptor.value);
    }
    return entries;
  } catch {
    return null;
  }
}
function readStoredValue(envelope, key) {
  const descriptor = readDataProperty(envelope, key);
  return descriptor.found ? descriptor.value : undefined;
}
function readExactStoredValue(envelope, key) {
  return readExactStoredValues(envelope, [key])?.[key];
}
function readExactStoredValues(envelope, keys) {
  try {
    if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) return null;
    const prototype = Object.getPrototypeOf(envelope);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const ownKeys = Reflect.ownKeys(envelope);
    if (ownKeys.length !== keys.length || ownKeys.some(key => typeof key !== 'string' || !keys.includes(key))) return null;
    const values = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(envelope, key);
      if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) return null;
      values[key] = descriptor.value;
    }
    return values;
  } catch {
    return null;
  }
}
function readStorageEntries(value) {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
    const entries = [];
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor?.enumerable === true && Object.hasOwn(descriptor, 'value')) entries.push([key, descriptor.value]);
    }
    return entries;
  } catch {
    return [];
  }
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
