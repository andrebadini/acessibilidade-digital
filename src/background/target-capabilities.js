export const PANEL_SURFACE = Object.freeze({ path: '/src/panel/index.html', contextType: 'SIDE_PANEL', allowQuery: false });
export const REVIEW_SURFACE = Object.freeze({ path: '/src/review/index.html', contextType: 'TAB', allowQuery: 'auditId-only' });
export const EXPORT_SURFACE = Object.freeze({ path: '/src/export/index.html', contextType: 'TAB', allowQuery: 'auditId-only' });

const TRUSTED_SURFACES = new Set([PANEL_SURFACE, REVIEW_SURFACE, EXPORT_SURFACE]);
const SURFACE_BY_PATH = new Map([...TRUSTED_SURFACES].map(surface => [surface.path, surface]));
const TARGET_PREFIX = 'audita:target-capability:v1:';
const SESSION_PREFIX = 'audita:audit-session-capability:v1:';
const CAPABILITY_ID = /^[A-Za-z0-9_-]{22}$/u;
const MODEL_ID = /^[A-Za-z0-9._:-]{1,200}$/u;
const DIGEST = /^hmac-sha256:[A-Za-z0-9_-]{43}$/u;
const TARGET_KEYS = ['version', 'capabilityId', 'kind', 'tabId', 'windowId', 'documentId', 'initialUrlEvidence', 'initialUrlSessionDigest', 'createdBy', 'allowedIntent', 'issuer', 'sessionCapabilityId', 'issuedAt', 'expiresAt', 'state'];
const SESSION_KEYS = ['version', 'sessionCapabilityId', 'auditId', 'windowId', 'mode', 'targetBinding', 'consumers', 'intents', 'state', 'issuedAt', 'expiresAt'];
const PROOF_KEYS = ['tabId', 'windowId', 'documentId', 'urlSessionDigest'];
const PREPARE_KEYS = ['kind', 'tabId', 'windowId', 'documentId', 'initialUrlEvidence', 'initialUrlSessionDigest', 'createdBy', 'allowedIntent', 'issuer'];
const EXTENSION_CLAIM_KEYS = ['capabilityId', 'auditId', 'mode', 'allowedIntent', 'senderContext'];
const WORKER_CLAIM_KEYS = ['capabilityId', 'auditId', 'mode', 'allowedIntent', 'eventNonce', 'senderContext'];
const AUTHORIZE_KEYS = ['sessionCapabilityId', 'auditId', 'consumer', 'intent', 'sender'];
const PANEL_AUTHORIZE_KEYS = [...AUTHORIZE_KEYS, 'claimedWindowId'];
const TRANSITION_KEYS = ['sessionCapabilityId', 'auditId', 'nextState'];
const REHYDRATE_KEYS = ['auditId', 'windowId', 'mode'];
const CONSUMERS = deepFreeze([
  { name: 'panel', path: PANEL_SURFACE.path, contextType: PANEL_SURFACE.contextType },
  { name: 'review', path: REVIEW_SURFACE.path, contextType: REVIEW_SURFACE.contextType },
]);
const INTENTS = deepFreeze({
  panel: { running: ['cancel'], result: ['open-report'], 'view-only': ['open-report'] },
  review: { running: [], result: ['export'], 'view-only': ['export'] },
});

export async function deriveTrustedExtensionContext({ sender, chromeApi, surface, claimedWindowId } = {}) {
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
    const isPanel = surface === PANEL_SURFACE;
    if ((isPanel && !safeChromeId(claimedWindowId)) || (!isPanel && claimedWindowId !== undefined)) {
      throw new Error('CONTEXT_DENIED');
    }
    const contexts = readDataArray(await chromeApi.runtime.getContexts({ documentIds: [sender.documentId] }));
    if (!contexts || contexts.length !== 1) throw new Error('CONTEXT_DENIED');
    const candidate = contexts[0];
    const documentId = readDataProperty(candidate, 'documentId');
    const documentUrl = readDataProperty(candidate, 'documentUrl');
    const contextType = readDataProperty(candidate, 'contextType');
    const nativeWindowId = readDataProperty(candidate, 'windowId');
    if (!documentId.found || documentId.value !== sender.documentId || !documentUrl.found ||
      documentUrl.value !== sender.url || !contextType.found || contextType.value !== surface.contextType ||
      !nativeWindowId.found) throw new Error('CONTEXT_DENIED');
    let windowId;
    let tabId = null;
    if (isPanel) {
      if (nativeWindowId.value !== -1 && nativeWindowId.value !== claimedWindowId) throw new Error('CONTEXT_DENIED');
      await provePanelWindowClaim(chromeApi, claimedWindowId);
      windowId = claimedWindowId;
    } else {
      const nativeTabId = readDataProperty(candidate, 'tabId');
      if (!safeChromeId(nativeWindowId.value) || !nativeTabId.found || !safeChromeId(nativeTabId.value)) {
        throw new Error('CONTEXT_DENIED');
      }
      windowId = nativeWindowId.value;
      tabId = nativeTabId.value;
    }
    return deepFreeze({
      issuer: { type: 'extension-document', documentId: sender.documentId, path: surface.path },
      windowId,
      tabId,
      contextType: contextType.value,
      documentUrl: documentUrl.value,
    });
  } catch {
    throw new Error('CONTEXT_DENIED');
  }
}

export const targetCapabilityStorageKey = capabilityId => `${TARGET_PREFIX}${capabilityId}`;
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

export async function readAttachedAuditCorrelationForRecovery(args) {
  try {
    const input = readDataRecord(args, ['sessionArea', 'capabilityId', 'auditId']);
    if (!input || typeof input.sessionArea?.get !== 'function' || !CAPABILITY_ID.test(input.capabilityId ?? '') ||
      !MODEL_ID.test(input.auditId ?? '')) throw new Error('denied');
    const targetKey = targetCapabilityStorageKey(input.capabilityId);
    const firstTarget = parseTargetRecord(readExactStoredValue(await input.sessionArea.get(targetKey), targetKey));
    if (!validRecoveryTarget(firstTarget, input.capabilityId)) throw new Error('denied');
    let firstSession = null;
    let secondSession = null;
    let sessionKey = null;
    if (firstTarget.sessionCapabilityId !== null) {
      sessionKey = sessionCapabilityStorageKey(firstTarget.sessionCapabilityId);
      firstSession = parseSessionRecord(readExactStoredValue(await input.sessionArea.get(sessionKey), sessionKey));
      if (!validRecoverySession(firstSession, firstTarget, input.auditId)) throw new Error('denied');
    }
    const secondTarget = parseTargetRecord(readExactStoredValue(await input.sessionArea.get(targetKey), targetKey));
    if (!secondTarget || !sameGraph(firstTarget, secondTarget)) throw new Error('denied');
    if (sessionKey !== null) {
      secondSession = parseSessionRecord(readExactStoredValue(await input.sessionArea.get(sessionKey), sessionKey));
      if (!secondSession || !sameGraph(firstSession, secondSession)) throw new Error('denied');
    }
    return deepFreeze({
      version: 1, capabilityId: firstTarget.capabilityId, auditId: input.auditId, windowId: firstTarget.windowId,
      targetState: firstTarget.state, sessionCapabilityId: firstTarget.sessionCapabilityId,
      sessionState: firstSession?.state ?? null, issuedAt: firstTarget.issuedAt, expiresAt: firstTarget.expiresAt,
    });
  } catch {
    throw new Error('AUDIT_RECOVERY_CORRELATION_DENIED');
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
    const input = readDataRecord(args, PREPARE_KEYS);
    if (!input) throw new TypeError('CAPABILITY_PREPARE_DENIED');
    const issuedAt = readNow(now);
    const capabilityId = createCapabilityId(randomBytes);
    const record = createTargetRecord({ ...input, capabilityId, issuedAt, expiresAt: issuedAt + capabilityTtlMs, state: 'prepared' });
    await sessionArea.set({ [targetCapabilityStorageKey(capabilityId)]: record });
    return deepFreeze({ ok: true, capabilityId, expiresAt: record.expiresAt });
  });

  const claimAndIssueAuditSession = args => serialize(() => claimCommon(args, false));
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
        : { kind: 'disposable', ownerId: target.capabilityId },
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
    const allowed = session && session.sessionCapabilityId === input.sessionCapabilityId &&
      session.expiresAt > currentTime && session.auditId === input.auditId &&
      session.windowId === context.windowId && context.issuer.path === descriptor.path &&
      context.contextType === descriptor.contextType && session.consumers.some(value => sameConsumer(value, descriptor)) &&
      session.intents[input.consumer]?.[session.state]?.includes(input.intent) === true;
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
    const allowed = session && session.sessionCapabilityId === input.sessionCapabilityId &&
      session.auditId === input.auditId &&
      ((session.state === 'running' && ['result', 'revoked'].includes(input.nextState)) ||
        (['result', 'view-only'].includes(session.state) && input.nextState === 'revoked'));
    if (!allowed) return transitionDenied();
    const changed = { ...session, state: input.nextState };
    await sessionArea.set({ [key]: changed });
    return deepFreeze({ ok: true, sessionCapabilityId: session.sessionCapabilityId, auditId: session.auditId, state: changed.state });
  });

  const invalidateCapability = (capabilityId, reason) => serialize(async () => {
    if (!CAPABILITY_ID.test(capabilityId ?? '') || typeof reason !== 'string' || !reason) return unavailable();
    const key = targetCapabilityStorageKey(capabilityId);
    const target = parseTargetRecord(readStoredValue(await sessionArea.get(key), key));
    if (!target || target.capabilityId !== capabilityId) return unavailable();
    if (target.state !== 'invalidated') await sessionArea.set({ [key]: { ...target, state: 'invalidated' } });
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
      for (const [key, rawRecord] of readStorageEntries(all)) {
        const target = parseTargetRecord(rawRecord);
        const session = parseSessionRecord(rawRecord);
        const record = target && key === targetCapabilityStorageKey(target.capabilityId)
          ? { type: 'target', value: target }
          : session && key === sessionCapabilityStorageKey(session.sessionCapabilityId)
            ? { type: 'session', value: session }
            : null;
        if (!record || !predicate(record)) continue;
        if (record.type === 'target' && record.value.state !== 'invalidated') changes[key] = { ...record.value, state: 'invalidated' };
        if (record.type === 'session' && record.value.state !== 'revoked') changes[key] = { ...record.value, state: 'revoked' };
      }
      if (Object.keys(changes).length > 0) await sessionArea.set(changes);
      return deepFreeze({ ok: true, invalidated: Object.keys(changes).length });
    });
  }

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
  const issuer = parseIssuer(value.issuer);
  if (!['attached', 'disposable'].includes(value.kind) || !CAPABILITY_ID.test(value.capabilityId ?? '') ||
    !safeChromeId(value.tabId) || !safeChromeId(value.windowId) || !validDocumentId(value.documentId) ||
    !validEvidenceUrl(value.initialUrlEvidence) || !DIGEST.test(value.initialUrlSessionDigest ?? '') ||
    !['user', 'audit'].includes(value.createdBy) || value.allowedIntent !== 'start-audit' ||
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

function parseTargetRecord(value) {
  const record = readDataRecord(value, TARGET_KEYS);
  if (!record) return null;
  const issuer = parseIssuer(record.issuer);
  if (record.version !== 1 || !CAPABILITY_ID.test(record.capabilityId ?? '') ||
    !['attached', 'disposable'].includes(record.kind) || !safeChromeId(record.tabId) ||
    !safeChromeId(record.windowId) || !validDocumentId(record.documentId) ||
    !validEvidenceUrl(record.initialUrlEvidence) || !DIGEST.test(record.initialUrlSessionDigest ?? '') ||
    !['user', 'audit'].includes(record.createdBy) || record.allowedIntent !== 'start-audit' ||
    !issuer || !safeTime(record.issuedAt) || !safeTime(record.expiresAt) || record.expiresAt <= record.issuedAt ||
    !['prepared', 'claimed', 'invalidated'].includes(record.state) ||
    (record.state === 'prepared' && record.sessionCapabilityId !== null) ||
    (record.state === 'claimed' && !CAPABILITY_ID.test(record.sessionCapabilityId ?? '')) ||
    (record.state === 'invalidated' && record.sessionCapabilityId !== null && !CAPABILITY_ID.test(record.sessionCapabilityId ?? ''))) return null;
  return { ...record, issuer };
}

function parseSessionRecord(value) {
  const record = readDataRecord(value, SESSION_KEYS);
  if (!record) return null;
  const targetBinding = parseTargetBinding(record.targetBinding);
  const consumers = parseConsumers(record.consumers);
  const intents = parseIntents(record.intents);
  if (record.version !== 1 || !CAPABILITY_ID.test(record.sessionCapabilityId ?? '') ||
    !MODEL_ID.test(record.auditId ?? '') || !safeChromeId(record.windowId) || !MODEL_ID.test(record.mode ?? '') ||
    !targetBinding || !consumers || !intents || !['running', 'result', 'view-only', 'revoked'].includes(record.state) ||
    (targetBinding.kind === 'view-only' && !['view-only', 'revoked'].includes(record.state)) ||
    (record.state === 'view-only' && targetBinding.kind !== 'view-only') ||
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
  const binding = readDataRecord(value, ['kind', 'ownerId']);
  return binding && binding.kind === 'disposable' && MODEL_ID.test(binding.ownerId ?? '') ? binding : null;
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
    parsedContext.documentUrl === `chrome-extension://${runtimeId}${surface.path}`);
}

function parseIssuer(value) { return parseExtensionIssuer(value) ?? parseWorkerIssuer(value); }
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
  const panel = readDataRecord(intents.panel, ['running', 'result', 'view-only']);
  const review = readDataRecord(intents.review, ['running', 'result', 'view-only']);
  if (!panel || !review || !sameDataArray(panel.running, ['cancel']) ||
    !sameDataArray(panel.result, ['open-report']) || !sameDataArray(panel['view-only'], ['open-report']) ||
    !sameDataArray(review.running, []) || !sameDataArray(review.result, ['export']) ||
    !sameDataArray(review['view-only'], ['export'])) return null;
  return {
    panel: { running: ['cancel'], result: ['open-report'], 'view-only': ['open-report'] },
    review: { running: [], result: ['export'], 'view-only': ['export'] },
  };
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
    !['running', 'result', 'view-only', 'revoked'].includes(session.state)) return false;
  if (session.targetBinding.kind === 'view-only') return ['view-only', 'revoked'].includes(session.state);
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
