import { assertBindingMatchesModel } from './highlight-binding.js';
import { createPageRelocationOfferStore } from './page-relocation-offer.js';

const IDENTIFIER = /^[A-Za-z0-9._:-]{1,200}$/u;
const NONCE = /^[A-Za-z0-9_-]{22}$/u;
const DOCUMENT_PROOF_ID = /^[A-Za-z0-9._:-]{1,240}$/u;
const PROOF_DIGEST = /^hmac-sha256:[A-Za-z0-9_-]{43}$/u;
const DANGEROUS_IDS = new Set(['__proto__', 'prototype', 'constructor']);
const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function exactRecord(value, expectedKeys) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== expectedKeys.length || keys.some(key => typeof key !== 'string') ||
      expectedKeys.some(key => !keys.includes(key))) return null;
    const output = Object.create(null);
    for (const key of expectedKeys) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      output[key] = descriptor.value;
    }
    return output;
  } catch {
    return null;
  }
}

function ownData(value, key) {
  try {
    const descriptor = value && typeof value === 'object'
      ? Reflect.getOwnPropertyDescriptor(value, key)
      : null;
    return descriptor?.enumerable && Object.hasOwn(descriptor, 'value')
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

function callable(value, key) {
  const method = ownData(value, key);
  return typeof method === 'function' ? method : null;
}

function validId(value) {
  return typeof value === 'string' && IDENTIFIER.test(value) && !DANGEROUS_IDS.has(value);
}

function validChromeId(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function failure(code) {
  return Object.freeze({ ok: false, code });
}

function clearSuccess() {
  return Object.freeze({ ok: true, highlight: Object.freeze({ state: 'clear' }) });
}

function activeSuccess(occurrenceId) {
  return Object.freeze({
    ok: true,
    highlight: Object.freeze({ state: 'active', occurrenceId }),
  });
}

function lifecycleSuccess(values = {}) {
  return Object.freeze({ ok: true, ...values });
}

const ABSENT_EVENT_REASONS = new Set(['navigation', 'discarded', 'tab-removed']);

function highlightRequest(value) {
  const record = exactRecord(value, ['sessionCapabilityId', 'auditId', 'occurrenceId', 'sender']);
  return record && validId(record.sessionCapabilityId) && validId(record.auditId) &&
    validId(record.occurrenceId) && record.sender && typeof record.sender === 'object'
    ? record
    : null;
}

function clearRequest(value) {
  const record = exactRecord(value, ['sessionCapabilityId', 'auditId', 'sender']);
  return record && validId(record.sessionCapabilityId) && validId(record.auditId) &&
    record.sender && typeof record.sender === 'object'
    ? record
    : null;
}

function targetIdentity(value) {
  const tabId = ownData(value, 'tabId');
  const documentId = ownData(value, 'documentId');
  return validChromeId(tabId) && typeof documentId === 'string' && documentId.length >= 1 &&
    documentId.length <= 512 && !/[\u0000-\u001F\u007F]/u.test(documentId)
    ? Object.freeze({ tabId, documentId })
    : null;
}

function createNonce(randomBytes) {
  let source;
  try { source = randomBytes(16); } catch { return null; }
  if (!(source instanceof Uint8Array) || source.byteLength !== 16) return null;
  const bytes = Uint8Array.from(source);
  let output = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      output += BASE64URL[(buffer >>> bits) & 63];
      buffer &= (1 << bits) - 1;
    }
  }
  if (bits > 0) output += BASE64URL[(buffer << (6 - bits)) & 63];
  return NONCE.test(output) ? output : null;
}

function kindAndMarker(model, occurrenceId) {
  if (!Array.isArray(model?.occurrences) || model.occurrences.length > 5_000) return null;
  const matches = [];
  for (let index = 0; index < model.occurrences.length; index += 1) {
    const occurrence = model.occurrences[index];
    if (occurrence?.occurrenceId === occurrenceId) matches.push({ occurrence, index });
  }
  if (matches.length !== 1) return null;
  const [{ occurrence, index }] = matches;
  const decisions = Array.isArray(model.reviewDecisions)
    ? model.reviewDecisions.filter(value => value?.occurrenceId === occurrenceId)
    : [];
  if (decisions.length > 1) return null;
  if (occurrence.outcome === 'failed' || decisions[0]?.answer === 'não conforme') {
    return Object.freeze({ kind: 'failed', markerNumber: index + 1 });
  }
  const queues = Array.isArray(model.manualReview)
    ? model.manualReview.filter(value => value?.occurrenceId === occurrenceId)
    : [];
  if (occurrence.outcome === 'cantTell' && queues.length === 1 && queues[0].status === 'unanswered') {
    return Object.freeze({ kind: 'manual', markerNumber: index + 1 });
  }
  return null;
}

function liveFailureCode(reason) {
  return new Map([
    ['invalid-input', 'HIGHLIGHT_INPUT_INVALID'],
    ['page-or-process', 'HIGHLIGHT_PAGE_OR_PROCESS'],
    ['window-changed', 'HIGHLIGHT_WINDOW_CHANGED'],
    ['url-changed', 'HIGHLIGHT_URL_CHANGED'],
    ['expired', 'HIGHLIGHT_EXPIRED'],
    ['ambiguous', 'HIGHLIGHT_AMBIGUOUS'],
    ['document-changed', 'HIGHLIGHT_DOCUMENT_CHANGED'],
    ['inaccessible', 'HIGHLIGHT_INACCESSIBLE'],
    ['shadow-root', 'HIGHLIGHT_SHADOW_ROOT'],
    ['live-proof-failed', 'HIGHLIGHT_LIVE_PROOF_FAILED'],
  ]).get(reason) ?? 'HIGHLIGHT_LIVE_PROOF_FAILED';
}

export function createHighlightController({
  chromeApi,
  chromeAdapter,
  sessionAuthority,
  modelAuthority,
  bindingStore,
  liveVerifier,
  targetQueue,
  now,
  randomBytes,
  relocationOffers = null,
} = {}) {
  const authorizeSession = callable(sessionAuthority, 'authorizeSession');
  const loadValidated = callable(modelAuthority, 'loadValidated');
  const findTarget = callable(bindingStore, 'findTarget');
  const beginOverlay = callable(bindingStore, 'beginOverlay');
  const activateOverlay = callable(bindingStore, 'activateOverlay');
  const beginOverlayClear = callable(bindingStore, 'beginOverlayClear');
  const completeOverlayClear = callable(bindingStore, 'completeOverlayClear');
  const getActiveOverlay = callable(bindingStore, 'getActiveOverlay');
  const listRecoverableOverlays = callable(bindingStore, 'listRecoverableOverlays');
  const invalidateStoredTab = callable(bindingStore, 'invalidateTab');
  const purgeExpiredBindings = callable(bindingStore, 'purgeExpired');
  const verifyLive = callable(liveVerifier, 'verify');
  const injectHighlight = callable(chromeAdapter, 'injectHighlight');
  // Opcional: sem uma sonda de identidade de documento o destaque não tem como reconhecer uma
  // recarga, e o comportamento é exatamente o de antes.
  const probeDocumentIdentity = callable(chromeAdapter, 'probeDocumentIdentity');
  const tabs = ownData(chromeApi, 'tabs');
  const getTab = callable(tabs, 'get');
  const withTarget = callable(targetQueue, 'withTarget');
  const assertHeld = callable(targetQueue, 'assertHeld');
  const runtimeId = chromeApi?.runtime?.id;
  if (!authorizeSession || !loadValidated || !findTarget || !beginOverlay || !activateOverlay ||
    !beginOverlayClear || !completeOverlayClear || !getActiveOverlay || !listRecoverableOverlays ||
    !invalidateStoredTab || !purgeExpiredBindings || !verifyLive || !injectHighlight || !withTarget ||
    !assertHeld || typeof now !== 'function' || typeof randomBytes !== 'function' ||
    typeof runtimeId !== 'string' || runtimeId.length < 1) {
    throw new TypeError('HIGHLIGHT_CONTROLLER_INVALID');
  }

  const offers = relocationOffers ?? createPageRelocationOfferStore({ now: () => readNow() });
  const registerOffer = callable(offers, 'register');
  const acceptOffer = callable(offers, 'accept');
  const clearOfferAudit = callable(offers, 'clearAudit');
  const clearOfferTab = callable(offers, 'clearTab');
  if (!registerOffer || !acceptOffer) throw new TypeError('HIGHLIGHT_CONTROLLER_INVALID');

  function validProof(value) {
    const tabId = ownData(value, 'tabId');
    const windowId = ownData(value, 'windowId');
    const documentId = ownData(value, 'documentId');
    const urlSessionDigest = ownData(value, 'urlSessionDigest');
    return validChromeId(tabId) && validChromeId(windowId) &&
      typeof documentId === 'string' && DOCUMENT_PROOF_ID.test(documentId) &&
      typeof urlSessionDigest === 'string' && PROOF_DIGEST.test(urlSessionDigest)
      ? Object.freeze({ tabId, windowId, documentId, urlSessionDigest })
      : null;
  }

  // Mesmo endereço (o digest de sessão cobre origem, caminho e consulta), mesma aba e janela, e um
  // documento diferente: é uma recarga. Só o quadro principal pode ser recolocado, porque é o único
  // cujo documento novo o worker consegue provar sem repetir a captura de estrutura do alvo.
  async function inspectRelocation(binding, target) {
    if (!probeDocumentIdentity || !target || target.frameId !== 0) return null;
    let proof;
    try { proof = validProof(await Reflect.apply(probeDocumentIdentity, chromeAdapter, [binding.tabId])); } catch { return null; }
    if (!proof || proof.tabId !== binding.tabId || proof.windowId !== binding.windowId ||
      proof.documentId === binding.topDocumentId || proof.urlSessionDigest !== binding.topUrlSessionDigest) return null;
    return proof;
  }

  function offerRelocation(binding, proof) {
    try {
      return Reflect.apply(registerOffer, offers, [Object.freeze({ auditId: binding.auditId, tabId: binding.tabId,
        windowId: binding.windowId, documentId: proof.documentId, urlSessionDigest: proof.urlSessionDigest,
        scope: 'highlight', expiresAt: binding.expiresAt })]) === true;
    } catch { return false; }
  }

  function relocationAccepted(binding, proof, liveDocumentId) {
    if (!proof || proof.documentId !== liveDocumentId) return false;
    try {
      return Reflect.apply(acceptOffer, offers, [Object.freeze({ auditId: binding.auditId, tabId: binding.tabId,
        windowId: binding.windowId, documentId: liveDocumentId, scope: 'highlight' })]) === true;
    } catch { return false; }
  }

  // Uma tentativa em que a página recarregou e a recolocação é possível vira convite, com o mesmo
  // código do painel dos sinais. Qualquer outro caso continua sendo "a página mudou".
  async function changedFailure(binding, target) {
    const proof = await inspectRelocation(binding, target);
    if (!proof) return failure('HIGHLIGHT_DOCUMENT_CHANGED');
    offerRelocation(binding, proof);
    return failure('HIGHLIGHT_RELOADED_PAGE');
  }

  let lastNow = null;
  function readNow() {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0 || (lastNow !== null && value < lastNow)) {
      throw new TypeError('HIGHLIGHT_CONTROLLER_CLOCK_INVALID');
    }
    lastNow = value;
    return value;
  }

  async function authorized(request) {
    let result;
    try {
      result = await Reflect.apply(authorizeSession, sessionAuthority, [{
        sessionCapabilityId: request.sessionCapabilityId,
        auditId: request.auditId,
        intent: 'highlight',
        sender: request.sender,
      }]);
    } catch {
      return false;
    }
    const session = ownData(result, 'session');
    // O painel volta como leitura do resultado (sessão "view-only") quando a aba navegou depois da
    // auditoria, e é justamente aí que a versão recarregada pode ser destacada. O que autoriza
    // desenhar não é o estado da sessão: é a ligação durável registrada na auditoria somada à prova
    // do documento vivo — a mesma página auditada ou a versão recarregada do mesmo endereço, sempre
    // reconferida contra a estrutura registrada. Para a leitura continuar sem os poderes da
    // auditoria, "cancelar" e "confirmar pixels" seguem fora da tabela dela.
    return ownData(result, 'ok') === true && ownData(session, 'auditId') === request.auditId &&
      ['result', 'view-only'].includes(ownData(session, 'state'));
  }

  async function loadBoundTarget(request) {
    if (!await authorized(request)) return { ok: false, code: 'HIGHLIGHT_NOT_AUTHORIZED' };
    let snapshot;
    let found;
    try {
      snapshot = await Reflect.apply(loadValidated, modelAuthority, [{ auditId: request.auditId }]);
      found = await Reflect.apply(findTarget, bindingStore, [{
        auditId: request.auditId,
        occurrenceId: request.occurrenceId,
        expectedModelRevision: snapshot.modelRevision,
        expectedModelHash: snapshot.modelHash,
      }]);
      if (!found) return { ok: false, code: 'HIGHLIGHT_NO_BINDING' };
      const binding = assertBindingMatchesModel({ binding: found.binding, snapshot });
      if (binding.expiresAt <= readNow()) return { ok: false, code: 'HIGHLIGHT_EXPIRED' };
      return { ok: true, snapshot, binding, target: binding.targets[request.occurrenceId] };
    } catch {
      return { ok: false, code: 'HIGHLIGHT_STATE_FAILED' };
    }
  }

  function confirmedInjection(result, owner) {
    return ownData(result, 'ok') === true && ownData(result, 'nonce') === owner.nonce &&
      ownData(result, 'documentId') === owner.documentId && ownData(result, 'frameId') === owner.frameId;
  }

  function confirmedLiveProof(result, binding, target) {
    return ownData(result, 'ok') === true && ownData(result, 'tabId') === binding.tabId &&
      ownData(result, 'windowId') === binding.windowId && ownData(result, 'documentId') === target.documentId &&
      ownData(result, 'frameId') === target.frameId;
  }

  async function transitionOwnerToClearing(owner) {
    if (owner.state === 'clearing') return { ok: true, owner };
    if (!['installing', 'active'].includes(owner.state)) return { ok: false };
    const result = await Reflect.apply(beginOverlayClear, bindingStore, [{
      tabId: owner.tabId,
      nonce: owner.nonce,
      expectedRevision: owner.revision,
    }]);
    return result?.ok === true ? { ok: true, owner: result.overlay } : { ok: false };
  }

  async function ownerDocumentConfirmedAbsent(owner) {
    if (!getTab) return false;
    let tab;
    try { tab = await Reflect.apply(getTab, tabs, [owner.tabId]); }
    catch { return false; }
    return ownData(tab, 'id') === owner.tabId &&
      (ownData(tab, 'discarded') === true || ownData(tab, 'status') === 'loading');
  }

  async function clearOwner(owner, { alreadyAbsent = false, allowAbsentProof = false } = {}) {
    let clearing;
    try { clearing = await transitionOwnerToClearing(owner); }
    catch { return failure('HIGHLIGHT_CLEANUP_UNCONFIRMED'); }
    if (!clearing.ok) return failure('HIGHLIGHT_CLEANUP_UNCONFIRMED');
    const current = clearing.owner;
    if (!alreadyAbsent) {
      let result;
      try {
        result = await Reflect.apply(injectHighlight, chromeAdapter, [{
          tabId: current.tabId,
          documentId: current.documentId,
          command: Object.freeze({ version: 1, op: 'clear', nonce: current.nonce }),
        }]);
      } catch {
        result = null;
      }
      if (!confirmedInjection(result, current)) {
        if (!allowAbsentProof || !await ownerDocumentConfirmedAbsent(current)) {
          return failure('HIGHLIGHT_CLEANUP_UNCONFIRMED');
        }
        alreadyAbsent = true;
      }
    }
    let completed;
    try {
      completed = await Reflect.apply(completeOverlayClear, bindingStore, [{
        tabId: current.tabId,
        nonce: current.nonce,
        expectedRevision: current.revision,
      }]);
    } catch {
      return failure('HIGHLIGHT_CLEANUP_UNCONFIRMED');
    }
    return completed?.ok === true
      ? lifecycleSuccess({ state: 'clear', alreadyAbsent })
      : failure('HIGHLIGHT_CLEANUP_UNCONFIRMED');
  }

  async function compensateNonce(tabId, nonce) {
    let owner;
    try { owner = await Reflect.apply(getActiveOverlay, bindingStore, [tabId]); }
    catch { return failure('HIGHLIGHT_CLEANUP_UNCONFIRMED'); }
    if (!owner || owner.nonce !== nonce) return failure('HIGHLIGHT_CLEANUP_UNCONFIRMED');
    return clearOwner(owner);
  }

  async function availability(rawRequest) {
    const request = highlightRequest(rawRequest);
    if (!request) return failure('HIGHLIGHT_INPUT_INVALID');
    const loaded = await loadBoundTarget(request);
    if (loaded.ok) {
      return Object.freeze({
        ok: true,
        bindingStatus: Object.freeze({ state: 'available' }),
      });
    }
    if (loaded.code === 'HIGHLIGHT_NOT_AUTHORIZED') return failure(loaded.code);
    const reasons = new Map([
      ['HIGHLIGHT_NO_BINDING', 'no-binding'],
      ['HIGHLIGHT_EXPIRED', 'expired'],
      ['HIGHLIGHT_STATE_FAILED', 'live-proof-failed'],
    ]);
    return Object.freeze({
      ok: true,
      bindingStatus: Object.freeze({
        state: 'unavailable',
        reason: reasons.get(loaded.code) ?? 'live-proof-failed',
      }),
    });
  }

  async function currentState(rawRequest) {
    const request = clearRequest(rawRequest);
    if (!request) return failure('HIGHLIGHT_INPUT_INVALID');
    if (!await authorized(request)) return failure('HIGHLIGHT_NOT_AUTHORIZED');
    let owners;
    let actionAt;
    try {
      actionAt = readNow();
      owners = (await Reflect.apply(listRecoverableOverlays, bindingStore, []))
        .filter(owner => owner.auditId === request.auditId);
    } catch {
      return failure('HIGHLIGHT_STATE_FAILED');
    }
    if (owners.length === 0) return clearSuccess();
    if (owners.length !== 1) return failure('HIGHLIGHT_STATE_FAILED');
    const [owner] = owners;
    if (owner.state !== 'active' || owner.expiresAt <= actionAt || !validId(owner.occurrenceId)) {
      return failure('HIGHLIGHT_STATE_FAILED');
    }
    return activeSuccess(owner.occurrenceId);
  }

  async function highlight(rawRequest) {
    const request = highlightRequest(rawRequest);
    if (!request) return failure('HIGHLIGHT_INPUT_INVALID');
    const inspected = await loadBoundTarget(request);
    if (!inspected.ok) return failure(inspected.code);
    const queueTarget = Object.freeze({
      tabId: inspected.binding.tabId,
      documentId: inspected.binding.topDocumentId,
    });
    try {
      return await Reflect.apply(withTarget, targetQueue, [queueTarget, async lock => {
        Reflect.apply(assertHeld, targetQueue, [lock, queueTarget]);
        const current = await loadBoundTarget(request);
        if (!current.ok) return failure(current.code);
        if (current.binding.tabId !== queueTarget.tabId || current.binding.topDocumentId !== queueTarget.documentId) {
          return changedFailure(current.binding, current.target);
        }
        const marker = kindAndMarker(current.snapshot.model, request.occurrenceId);
        if (!marker) return failure('HIGHLIGHT_NOT_APPLICABLE');
        let live;
        try {
          live = await Reflect.apply(verifyLive, liveVerifier, [{
            binding: current.binding,
            target: current.target,
          }]);
        } catch {
          live = null;
        }
        if (ownData(live, 'ok') !== true) {
          // O documento do topo mudou com o mesmo endereço: a verificação de estrutura do alvo não
          // tem como ser refeita contra o documento auditado, e a recolocação é oferecida em vez do
          // erro. Todo o resto continua com o código de sempre.
          if (ownData(live, 'reason') === 'document-changed') return changedFailure(current.binding, current.target);
          return failure(liveFailureCode(ownData(live, 'reason')));
        }
        if (!confirmedLiveProof(live, current.binding, current.target)) {
          return failure('HIGHLIGHT_LIVE_PROOF_FAILED');
        }

        const prior = await Reflect.apply(getActiveOverlay, bindingStore, [current.binding.tabId]);
        if (prior) {
          const cleared = await clearOwner(prior);
          if (!cleared.ok) return cleared;
        }

        const nonce = createNonce(randomBytes);
        if (!nonce) return failure('HIGHLIGHT_STATE_FAILED');
        const createdAt = readNow();
        if (createdAt >= current.binding.expiresAt) return failure('HIGHLIGHT_EXPIRED');
        const owner = Object.freeze({
          version: 1,
          tabId: current.binding.tabId,
          windowId: current.binding.windowId,
          topDocumentId: current.binding.topDocumentId,
          documentId: current.target.documentId,
          frameId: current.target.frameId,
          nonce,
          auditId: current.binding.auditId,
          occurrenceId: request.occurrenceId,
          createdAt,
          expiresAt: current.binding.expiresAt,
          state: 'installing',
          revision: 1,
        });
        let begun;
        try { begun = await Reflect.apply(beginOverlay, bindingStore, [owner]); }
        catch { return failure('HIGHLIGHT_STATE_FAILED'); }
        if (begun?.ok !== true) {
          const retained = await Reflect.apply(getActiveOverlay, bindingStore, [owner.tabId]);
          if (retained?.nonce === nonce) {
            const compensated = await clearOwner(retained);
            if (!compensated.ok) return compensated;
          }
          return failure('HIGHLIGHT_STATE_FAILED');
        }

        const command = Object.freeze({
          version: 1,
          op: 'install',
          nonce,
          documentId: owner.documentId,
          frameId: owner.frameId,
          selector: current.target.selector,
          structuralSignature: current.target.structuralSignature,
          kind: marker.kind,
          markerNumber: marker.markerNumber,
        });
        let injected;
        try {
          injected = await Reflect.apply(injectHighlight, chromeAdapter, [{
            tabId: owner.tabId,
            documentId: owner.documentId,
            command,
          }]);
        } catch {
          injected = null;
        }
        if (!confirmedInjection(injected, owner)) {
          const compensated = await compensateNonce(owner.tabId, nonce);
          return compensated.ok ? failure('HIGHLIGHT_INJECTION_FAILED') : compensated;
        }

        let activated;
        try {
          activated = await Reflect.apply(activateOverlay, bindingStore, [{
            tabId: owner.tabId,
            nonce,
            expectedRevision: begun.overlay.revision,
          }]);
        } catch {
          activated = null;
        }
        if (activated?.ok !== true) {
          const compensated = await compensateNonce(owner.tabId, nonce);
          return compensated.ok ? failure('HIGHLIGHT_STATE_FAILED') : compensated;
        }
        return activeSuccess(request.occurrenceId);
      }]);
    } catch {
      return failure('HIGHLIGHT_STATE_FAILED');
    }
  }

  // Recolocação do destaque numa página recarregada: mesmo endereço, documento novo, quadro
  // principal, e só depois do convite aceito no painel. A estrutura registrada continua sendo
  // conferida dentro da página, contra o documento auditado (`signedDocumentId`), porque o documento
  // novo tem outro id; a identidade da aba, da janela e do endereço é provada de novo aqui, antes e
  // depois do efeito.
  async function highlightReloaded(rawRequest) {
    const request = highlightRequest(rawRequest);
    if (!request) return failure('HIGHLIGHT_INPUT_INVALID');
    const inspected = await loadBoundTarget(request);
    if (!inspected.ok) return failure(inspected.code);
    const firstProof = await inspectRelocation(inspected.binding, inspected.target);
    if (!firstProof) return changedFailure(inspected.binding, inspected.target);
    if (!relocationAccepted(inspected.binding, firstProof, firstProof.documentId)) {
      offerRelocation(inspected.binding, firstProof);
      return failure('HIGHLIGHT_RELOADED_PAGE');
    }
    const queueTarget = Object.freeze({ tabId: inspected.binding.tabId, documentId: firstProof.documentId });
    try {
      return await Reflect.apply(withTarget, targetQueue, [queueTarget, async lock => {
        Reflect.apply(assertHeld, targetQueue, [lock, queueTarget]);
        const current = await loadBoundTarget(request);
        if (!current.ok) return failure(current.code);
        if (current.binding.tabId !== queueTarget.tabId ||
          current.binding.topDocumentId !== inspected.binding.topDocumentId) {
          return failure('HIGHLIGHT_DOCUMENT_CHANGED');
        }
        const proof = await inspectRelocation(current.binding, current.target);
        if (!proof) return changedFailure(current.binding, current.target);
        // A oferta vale para um documento específico: se a aba recarregou de novo no meio do
        // caminho, a recolocação é oferecida outra vez em vez de acontecer sobre outra página.
        if (proof.documentId !== queueTarget.documentId || !relocationAccepted(current.binding, proof, proof.documentId)) {
          offerRelocation(current.binding, proof);
          return failure('HIGHLIGHT_RELOADED_PAGE');
        }
        const marker = kindAndMarker(current.snapshot.model, request.occurrenceId);
        if (!marker) return failure('HIGHLIGHT_NOT_APPLICABLE');

        const prior = await Reflect.apply(getActiveOverlay, bindingStore, [current.binding.tabId]);
        if (prior) {
          const cleared = await clearOwner(prior);
          if (!cleared.ok) return cleared;
        }

        const nonce = createNonce(randomBytes);
        if (!nonce) return failure('HIGHLIGHT_STATE_FAILED');
        const createdAt = readNow();
        if (createdAt >= current.binding.expiresAt) return failure('HIGHLIGHT_EXPIRED');
        const owner = Object.freeze({
          version: 1,
          tabId: current.binding.tabId,
          windowId: current.binding.windowId,
          topDocumentId: proof.documentId,
          documentId: proof.documentId,
          frameId: 0,
          nonce,
          auditId: current.binding.auditId,
          occurrenceId: request.occurrenceId,
          createdAt,
          expiresAt: current.binding.expiresAt,
          state: 'installing',
          revision: 1,
          relocatedFrom: current.binding.topDocumentId,
        });
        let begun;
        try { begun = await Reflect.apply(beginOverlay, bindingStore, [owner]); }
        catch { return failure('HIGHLIGHT_STATE_FAILED'); }
        if (begun?.ok !== true) {
          const retained = await Reflect.apply(getActiveOverlay, bindingStore, [owner.tabId]);
          if (retained?.nonce === nonce) {
            const compensated = await clearOwner(retained);
            if (!compensated.ok) return compensated;
          }
          return failure('HIGHLIGHT_STATE_FAILED');
        }

        const command = Object.freeze({
          version: 1,
          op: 'install',
          nonce,
          documentId: owner.documentId,
          signedDocumentId: current.binding.topDocumentId,
          frameId: owner.frameId,
          selector: current.target.selector,
          structuralSignature: current.target.structuralSignature,
          kind: marker.kind,
          markerNumber: marker.markerNumber,
        });
        let injected;
        try {
          injected = await Reflect.apply(injectHighlight, chromeAdapter, [{
            tabId: owner.tabId,
            documentId: owner.documentId,
            command,
          }]);
        } catch {
          injected = null;
        }
        if (!confirmedInjection(injected, owner)) {
          const compensated = await compensateNonce(owner.tabId, nonce);
          return compensated.ok ? failure('HIGHLIGHT_INJECTION_FAILED') : compensated;
        }
        // Depois do efeito, o documento vivo precisa continuar sendo aquele que a oferta nomeou.
        const settled = await inspectRelocation(current.binding, current.target);
        if (!settled || settled.documentId !== proof.documentId) {
          const compensated = await compensateNonce(owner.tabId, nonce);
          return compensated.ok ? failure('HIGHLIGHT_DOCUMENT_CHANGED') : compensated;
        }

        let activated;
        try {
          activated = await Reflect.apply(activateOverlay, bindingStore, [{
            tabId: owner.tabId,
            nonce,
            expectedRevision: begun.overlay.revision,
          }]);
        } catch {
          activated = null;
        }
        if (activated?.ok !== true) {
          const compensated = await compensateNonce(owner.tabId, nonce);
          return compensated.ok ? failure('HIGHLIGHT_STATE_FAILED') : compensated;
        }
        return activeSuccess(request.occurrenceId);
      }]);
    } catch {
      return failure('HIGHLIGHT_STATE_FAILED');
    }
  }

  async function clear(rawRequest) {
    const request = clearRequest(rawRequest);
    if (!request) return failure('HIGHLIGHT_INPUT_INVALID');
    if (!await authorized(request)) return failure('HIGHLIGHT_NOT_AUTHORIZED');
    let owners;
    try {
      owners = (await Reflect.apply(listRecoverableOverlays, bindingStore, []))
        .filter(owner => owner.auditId === request.auditId);
    } catch {
      return failure('HIGHLIGHT_STATE_FAILED');
    }
    for (const inspected of owners) {
      const queueTarget = Object.freeze({ tabId: inspected.tabId, documentId: inspected.topDocumentId });
      let result;
      try {
        result = await Reflect.apply(withTarget, targetQueue, [queueTarget, async lock => {
          Reflect.apply(assertHeld, targetQueue, [lock, queueTarget]);
          if (!await authorized(request)) return failure('HIGHLIGHT_NOT_AUTHORIZED');
          const owner = await Reflect.apply(getActiveOverlay, bindingStore, [inspected.tabId]);
          if (!owner || owner.auditId !== request.auditId || owner.nonce !== inspected.nonce) {
            return lifecycleSuccess({ state: 'absent' });
          }
          return clearOwner(owner);
        }]);
      } catch {
        return failure('HIGHLIGHT_STATE_FAILED');
      }
      if (!result.ok) return result;
    }
    return clearSuccess();
  }

  async function clearForTargetLocked(rawTarget, reason, lock) {
    const target = targetIdentity(rawTarget);
    if (!target || typeof reason !== 'string' || reason.length < 1 || reason.length > 100) {
      throw new TypeError('HIGHLIGHT_INPUT_INVALID');
    }
    Reflect.apply(assertHeld, targetQueue, [lock, target]);
    const owner = await Reflect.apply(getActiveOverlay, bindingStore, [target.tabId]);
    if (!owner || owner.topDocumentId !== target.documentId) return lifecycleSuccess({ state: 'absent' });
    const cleared = await clearOwner(owner);
    return cleared.ok ? lifecycleSuccess({ state: 'clear' }) : cleared;
  }

  async function clearAudit(auditId, reason) {
    if (!validId(auditId) || typeof reason !== 'string' || reason.length < 1 || reason.length > 100) {
      throw new TypeError('HIGHLIGHT_INPUT_INVALID');
    }
    // O convite para recolocar o destaque morre junto com a auditoria: nada de oferecer de novo
    // uma auditoria que já foi descartada.
    try { clearOfferAudit(auditId); } catch { /* ofertas vencidas não impedem a limpeza */ }
    let owners;
    try {
      owners = (await Reflect.apply(listRecoverableOverlays, bindingStore, []))
        .filter(owner => owner.auditId === auditId);
    } catch {
      return failure('HIGHLIGHT_STATE_FAILED');
    }
    for (const inspected of owners) {
      const target = Object.freeze({ tabId: inspected.tabId, documentId: inspected.topDocumentId });
      const result = await Reflect.apply(withTarget, targetQueue, [target, async lock => {
        Reflect.apply(assertHeld, targetQueue, [lock, target]);
        const owner = await Reflect.apply(getActiveOverlay, bindingStore, [inspected.tabId]);
        if (!owner || owner.auditId !== auditId || owner.nonce !== inspected.nonce) {
          return lifecycleSuccess({ state: 'absent' });
        }
        return clearOwner(owner);
      }]);
      if (!result.ok) return result;
    }
    return lifecycleSuccess({ state: 'clear' });
  }

  async function invalidateContent(value) {
    const input = exactRecord(value, ['message', 'sender']);
    const message = input && exactRecord(input.message, ['type', 'nonce']);
    const sender = input?.sender;
    const tab = ownData(sender, 'tab');
    const tabId = ownData(tab, 'id');
    const windowId = ownData(tab, 'windowId');
    const documentId = ownData(sender, 'documentId');
    const frameId = ownData(sender, 'frameId');
    if (!input || !message || message.type !== 'AUDITA_HIGHLIGHT_INVALIDATED' ||
      typeof message.nonce !== 'string' || !NONCE.test(message.nonce) || ownData(sender, 'id') !== runtimeId ||
      !validChromeId(tabId) || !validChromeId(windowId) || typeof documentId !== 'string' ||
      !validChromeId(frameId)) return failure('HIGHLIGHT_INVALIDATION_IGNORED');
    let inspected;
    try { inspected = await Reflect.apply(getActiveOverlay, bindingStore, [tabId]); }
    catch { return failure('HIGHLIGHT_INVALIDATION_IGNORED'); }
    if (!inspected || inspected.state !== 'active' || inspected.nonce !== message.nonce ||
      inspected.windowId !== windowId || inspected.documentId !== documentId || inspected.frameId !== frameId) {
      return failure('HIGHLIGHT_INVALIDATION_IGNORED');
    }
    const target = Object.freeze({ tabId, documentId: inspected.topDocumentId });
    try {
      return await Reflect.apply(withTarget, targetQueue, [target, async lock => {
        Reflect.apply(assertHeld, targetQueue, [lock, target]);
        const owner = await Reflect.apply(getActiveOverlay, bindingStore, [tabId]);
        if (!owner || owner.state !== 'active' || owner.nonce !== message.nonce ||
          owner.windowId !== windowId || owner.documentId !== documentId || owner.frameId !== frameId) {
          return failure('HIGHLIGHT_INVALIDATION_IGNORED');
        }
        const cleared = await clearOwner(owner, { alreadyAbsent: true });
        return cleared.ok
          ? Object.freeze({ ok: true, auditId: owner.auditId, highlight: Object.freeze({ state: 'clear' }) })
          : cleared;
      }]);
    } catch {
      return failure('HIGHLIGHT_INVALIDATION_IGNORED');
    }
  }

  async function invalidateTab(tabId, reason) {
    if (!validChromeId(tabId) || typeof reason !== 'string' || reason.length < 1 || reason.length > 100) {
      throw new TypeError('HIGHLIGHT_INPUT_INVALID');
    }
    try { clearOfferTab(tabId); } catch { /* ofertas vencidas não impedem a limpeza */ }
    let owner;
    try { owner = await Reflect.apply(getActiveOverlay, bindingStore, [tabId]); }
    catch { return failure('HIGHLIGHT_STATE_FAILED'); }
    const clearedAuditIds = [];
    if (owner) {
      const target = Object.freeze({ tabId, documentId: owner.topDocumentId });
      const cleared = await Reflect.apply(withTarget, targetQueue, [target, async lock => {
        Reflect.apply(assertHeld, targetQueue, [lock, target]);
        const current = await Reflect.apply(getActiveOverlay, bindingStore, [tabId]);
        return current
          ? clearOwner(current, { alreadyAbsent: ABSENT_EVENT_REASONS.has(reason), allowAbsentProof: true })
          : lifecycleSuccess({ state: 'absent' });
      }]);
      if (!cleared.ok) return cleared;
      clearedAuditIds.push(owner.auditId);
    }
    // Navegação: o destaque desenhado sai (o documento dele já não existe), mas as ligações
    // duráveis da auditoria ficam. São elas que guardam o seletor e a assinatura com que o painel
    // volta a oferecer o destaque na versão recarregada; cada uso é conferido de novo contra o
    // documento vivo, com o mesmo endereço e o gesto do leitor. Aba fechada ou descartada leva
    // tudo junto.
    if (reason === 'navigation') {
      return lifecycleSuccess({ state: 'invalidated', clearedAuditIds: Object.freeze(clearedAuditIds) });
    }
    try {
      await Reflect.apply(invalidateStoredTab, bindingStore, [tabId]);
      return lifecycleSuccess({ state: 'invalidated', clearedAuditIds: Object.freeze(clearedAuditIds) });
    } catch {
      return failure('HIGHLIGHT_STATE_FAILED');
    }
  }

  function recoveredClear(owner, cleared, invalidateBinding) {
    return cleared.ok
      ? lifecycleSuccess({
        state: 'clear', auditId: owner.auditId, tabId: owner.tabId,
        invalidateBinding: invalidateBinding || cleared.alreadyAbsent === true,
      })
      : cleared;
  }

  async function recoverOwner(inspected) {
    const target = Object.freeze({ tabId: inspected.tabId, documentId: inspected.topDocumentId });
    return Reflect.apply(withTarget, targetQueue, [target, async lock => {
      Reflect.apply(assertHeld, targetQueue, [lock, target]);
      const owner = await Reflect.apply(getActiveOverlay, bindingStore, [inspected.tabId]);
      if (!owner || owner.nonce !== inspected.nonce) return lifecycleSuccess({ state: 'absent' });
      if (owner.state !== 'active' || owner.expiresAt <= readNow()) {
        const cleared = await clearOwner(owner, { allowAbsentProof: true });
        return recoveredClear(owner, cleared, owner.expiresAt <= lastNow);
      }
      let snapshot;
      let found;
      try {
        snapshot = await Reflect.apply(loadValidated, modelAuthority, [{ auditId: owner.auditId }]);
        found = await Reflect.apply(findTarget, bindingStore, [{
          auditId: owner.auditId,
          occurrenceId: owner.occurrenceId,
          expectedModelRevision: snapshot.modelRevision,
          expectedModelHash: snapshot.modelHash,
        }]);
        if (!found) return recoveredClear(owner, await clearOwner(owner, { allowAbsentProof: true }), true);
        const binding = assertBindingMatchesModel({ binding: found.binding, snapshot });
        const targetRecord = binding.targets[owner.occurrenceId];
        if (!targetRecord || targetRecord.documentId !== owner.documentId || targetRecord.frameId !== owner.frameId) {
          return recoveredClear(owner, await clearOwner(owner, { alreadyAbsent: true }), true);
        }
        const live = await Reflect.apply(verifyLive, liveVerifier, [{ binding, target: targetRecord }]);
        if (!confirmedLiveProof(live, binding, targetRecord)) {
          const reason = ownData(live, 'reason');
          const cleared = await clearOwner(owner, {
            alreadyAbsent: ['page-or-process', 'document-changed'].includes(reason),
            allowAbsentProof: true,
          });
          return recoveredClear(owner, cleared, true);
        }
        const marker = kindAndMarker(snapshot.model, owner.occurrenceId);
        if (!marker) return recoveredClear(owner, await clearOwner(owner, { allowAbsentProof: true }), true);
        const injected = await Reflect.apply(injectHighlight, chromeAdapter, [{
          tabId: owner.tabId,
          documentId: owner.documentId,
          command: Object.freeze({
            version: 1,
            op: 'install',
            nonce: owner.nonce,
            documentId: owner.documentId,
            frameId: owner.frameId,
            selector: targetRecord.selector,
            structuralSignature: targetRecord.structuralSignature,
            kind: marker.kind,
            markerNumber: marker.markerNumber,
          }),
        }]);
        return confirmedInjection(injected, owner)
          ? lifecycleSuccess({ state: 'active' })
          : recoveredClear(owner, await clearOwner(owner, { allowAbsentProof: true }), true);
      } catch {
        return recoveredClear(owner, await clearOwner(owner, { allowAbsentProof: true }), true);
      }
    }]);
  }

  async function recover() {
    let owners;
    try { owners = await Reflect.apply(listRecoverableOverlays, bindingStore, []); }
    catch { return failure('HIGHLIGHT_STATE_FAILED'); }
    let recovered = 0;
    const clearedAuditIds = new Set();
    for (const owner of owners) {
      let result;
      try { result = await recoverOwner(owner); }
      catch { result = failure('HIGHLIGHT_CLEANUP_UNCONFIRMED'); }
      if (!result.ok) return result;
      if (result.state === 'clear' && validId(result.auditId)) clearedAuditIds.add(result.auditId);
      if (result.invalidateBinding === true) {
        try { await Reflect.apply(invalidateStoredTab, bindingStore, [result.tabId]); }
        catch { return failure('HIGHLIGHT_STATE_FAILED'); }
      }
      recovered += 1;
    }
    return lifecycleSuccess({ recovered, clearedAuditIds: Object.freeze([...clearedAuditIds]) });
  }

  async function expireDue() {
    let owners;
    let actionAt;
    try {
      actionAt = readNow();
      owners = await Reflect.apply(listRecoverableOverlays, bindingStore, []);
    } catch {
      return failure('HIGHLIGHT_STATE_FAILED');
    }
    const clearedAuditIds = new Set();
    for (const owner of owners.filter(value => value.expiresAt <= actionAt)) {
      let result;
      try { result = await recoverOwner(owner); }
      catch { result = failure('HIGHLIGHT_CLEANUP_UNCONFIRMED'); }
      if (!result.ok) return result;
      if (result.state === 'clear' && validId(result.auditId)) clearedAuditIds.add(result.auditId);
    }
    try {
      const purged = await Reflect.apply(purgeExpiredBindings, bindingStore, []);
      return lifecycleSuccess({ purged, clearedAuditIds: Object.freeze([...clearedAuditIds]) });
    } catch {
      return failure('HIGHLIGHT_STATE_FAILED');
    }
  }

  return Object.freeze({
    currentState,
    availability,
    highlight,
    highlightReloaded,
    clear,
    clearForTargetLocked,
    clearAudit,
    invalidateContent,
    invalidateTab,
    recover,
    expireDue,
  });
}
