const PANEL_PATHNAME = '/src/panel/index.html';
const PANEL_PATH = 'src/panel/index.html';
const DEFAULT_TTL_MS = 60_000;
const TOKEN = /^[A-Za-z0-9_-]{43}$/u;
const RECORD_PREFIX = 'audita:panel-launch:record:v1:';
const INDEX_PREFIX = 'audita:panel-launch:index:v1:';
const SHARED = new WeakMap();
const ABSENT = Symbol('absent');
const INVALID = Symbol('invalid');
const RECORD_KEYS = Object.freeze([
  'version', 'token', 'tabId', 'windowId', 'generation', 'state', 'contextId', 'documentId',
  'issuedAt', 'expiresAt',
]);
const INDEX_KEYS = Object.freeze([
  'version', 'tabId', 'token', 'generation', 'state', 'issuedAt', 'expiresAt',
]);
const ADMISSION_KEYS = Object.freeze([
  'ok', 'token', 'tabId', 'windowId', 'generation', 'contextId', 'documentId', 'url', 'syntheticSender',
]);

function exact(value, keys) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return null;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== keys.length || ownKeys.some(key => typeof key !== 'string' || !keys.includes(key))) return null;
    const copy = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      copy[key] = descriptor.value;
    }
    return copy;
  } catch { return null; }
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function fail(code = 'PANEL_LAUNCH_DENIED') {
  return Object.freeze({ ok: false, code });
}

function safeChromeId(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function safeEpoch(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validOpaqueId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,512}$/u.test(value);
}

function parseRecord(value) {
  const row = exact(value, RECORD_KEYS);
  if (!row || row.version !== 1 || !TOKEN.test(row.token ?? '') || !safeChromeId(row.tabId) ||
    !safeChromeId(row.windowId) || !Number.isSafeInteger(row.generation) || row.generation < 1 ||
    !['issued', 'admitted'].includes(row.state) || !safeEpoch(row.issuedAt) || !safeEpoch(row.expiresAt) ||
    row.expiresAt <= row.issuedAt) return null;
  const issuedIdentity = row.state === 'issued' && row.contextId === null && row.documentId === null;
  const admittedIdentity = row.state === 'admitted' && validOpaqueId(row.contextId) && validOpaqueId(row.documentId);
  return issuedIdentity || admittedIdentity ? Object.freeze(row) : null;
}

function parseIndex(value) {
  const row = exact(value, INDEX_KEYS);
  return row && row.version === 1 && safeChromeId(row.tabId) && TOKEN.test(row.token ?? '') &&
    Number.isSafeInteger(row.generation) && row.generation >= 1 && ['issued', 'admitted'].includes(row.state) &&
    safeEpoch(row.issuedAt) && safeEpoch(row.expiresAt) && row.expiresAt > row.issuedAt
    ? Object.freeze(row) : null;
}

function sameRecord(left, right, keys) {
  return Boolean(left && right && keys.every(key => left[key] === right[key]));
}

function correlated(record, index) {
  return Boolean(record && index && record.tabId === index.tabId && record.token === index.token &&
    record.generation === index.generation && record.state === index.state &&
    record.issuedAt === index.issuedAt && record.expiresAt === index.expiresAt);
}

function envelopeValue(envelope, key, allowedKeys = [key]) {
  try {
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return INVALID;
    const ownKeys = Reflect.ownKeys(envelope);
    if (ownKeys.some(candidate => typeof candidate !== 'string' || !allowedKeys.includes(candidate))) return INVALID;
    const descriptor = Object.getOwnPropertyDescriptor(envelope, key);
    if (!descriptor) return ABSENT;
    return descriptor.enumerable && Object.hasOwn(descriptor, 'value') ? descriptor.value : INVALID;
  } catch { return INVALID; }
}

function encodeToken(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 32) throw new Error('denied');
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const token = btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
  if (!TOKEN.test(token)) throw new Error('denied');
  return token;
}

function recordKey(token) { return `${RECORD_PREFIX}${token}`; }
function indexKey(tabId) { return `${INDEX_PREFIX}${tabId}`; }
function pathFor(token) { return `${PANEL_PATH}?launch=${token}`; }
function urlFor(runtimeId, token) { return `chrome-extension://${runtimeId}${PANEL_PATHNAME}?launch=${token}`; }

function parseSender(raw, runtimeId) {
  const input = exact(raw, ['sender']);
  const sender = exact(input?.sender, ['id', 'url', 'origin']);
  if (!sender || sender.id !== runtimeId || sender.origin !== `chrome-extension://${runtimeId}` ||
    typeof sender.url !== 'string') return null;
  try {
    const url = new URL(sender.url);
    const launchValues = url.searchParams.getAll('launch');
    const onlyLaunch = [...url.searchParams.keys()].length === 1 && launchValues.length === 1;
    const token = launchValues[0];
    if (url.protocol !== 'chrome-extension:' || url.hostname !== runtimeId || url.username !== '' ||
      url.password !== '' || url.port !== '' || url.pathname !== PANEL_PATHNAME || url.hash !== '' ||
      !onlyLaunch || !TOKEN.test(token ?? '') || sender.url !== urlFor(runtimeId, token)) return null;
    return Object.freeze({ sender: Object.freeze(sender), token, url: sender.url });
  } catch { return null; }
}

function ownData(value, key) {
  try {
    if (!value || typeof value !== 'object') return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  } catch { return undefined; }
}

function parseContext(value, expectedUrl) {
  const contextType = ownData(value, 'contextType');
  const contextId = ownData(value, 'contextId');
  const documentId = ownData(value, 'documentId');
  const documentUrl = ownData(value, 'documentUrl');
  const tabId = ownData(value, 'tabId');
  const windowId = ownData(value, 'windowId');
  if (contextType !== 'SIDE_PANEL' || !validOpaqueId(contextId) || !validOpaqueId(documentId) ||
    documentUrl !== expectedUrl || tabId !== -1 || windowId !== -1) return null;
  return Object.freeze({ contextId, documentId });
}

function createAdmission(runtimeId, record, url) {
  return deepFreeze({
    ok: true,
    token: record.token,
    tabId: record.tabId,
    windowId: record.windowId,
    generation: record.generation,
    contextId: record.contextId,
    documentId: record.documentId,
    url,
    syntheticSender: {
      id: runtimeId,
      url,
      origin: `chrome-extension://${runtimeId}`,
      documentId: record.documentId,
    },
  });
}

function parseAdmission(value, runtimeId) {
  const row = exact(value, ADMISSION_KEYS);
  const syntheticSender = exact(row?.syntheticSender, ['id', 'url', 'origin', 'documentId']);
  if (!row || row.ok !== true || !TOKEN.test(row.token ?? '') || !safeChromeId(row.tabId) ||
    !safeChromeId(row.windowId) || !Number.isSafeInteger(row.generation) || row.generation < 1 ||
    !validOpaqueId(row.contextId) || !validOpaqueId(row.documentId) ||
    row.url !== urlFor(runtimeId, row.token) || !syntheticSender || syntheticSender.id !== runtimeId ||
    syntheticSender.url !== row.url || syntheticSender.origin !== `chrome-extension://${runtimeId}` ||
    syntheticSender.documentId !== row.documentId) return null;
  return createAdmission(runtimeId, row, row.url);
}

function parseIssued(value) {
  const row = exact(value, ['ok', 'token', 'path', 'generation']);
  return row && row.ok === true && TOKEN.test(row.token ?? '') && row.path === pathFor(row.token) &&
    Number.isSafeInteger(row.generation) && row.generation >= 1 ? Object.freeze(row) : null;
}

function sharedState(sessionArea) {
  let state = SHARED.get(sessionArea);
  if (!state) {
    state = {
      tail: Promise.resolve(), byTab: new Map(), byToken: new Map(), generations: new Map(),
      initialized: false, initialization: null,
    };
    SHARED.set(sessionArea, state);
  }
  return state;
}

function serialize(state, operation) {
  const current = state.tail.then(operation, operation);
  state.tail = current.then(() => undefined, () => undefined);
  return current;
}

export function createPanelLaunchAuthority({
  chromeApi,
  sessionArea,
  now,
  randomBytes,
  ttlMs = DEFAULT_TTL_MS,
} = {}) {
  if (typeof chromeApi?.runtime?.id !== 'string' || chromeApi.runtime.id.length === 0 ||
    typeof chromeApi.runtime.getContexts !== 'function' || typeof sessionArea?.get !== 'function' ||
    typeof sessionArea.set !== 'function' || typeof sessionArea.remove !== 'function' ||
    typeof now !== 'function' || typeof randomBytes !== 'function' ||
    !Number.isSafeInteger(ttlMs) || ttlMs < 1) {
    throw new TypeError('PANEL_LAUNCH_AUTHORITY_INVALID');
  }

  const state = sharedState(sessionArea);

  function readNow() {
    const value = now();
    if (!safeEpoch(value)) throw new Error('denied');
    return value;
  }

  async function readPair(token) {
    const firstEnvelope = await sessionArea.get(recordKey(token));
    const first = parseRecord(envelopeValue(firstEnvelope, recordKey(token)));
    if (!first || first.token !== token) return null;
    const keys = [recordKey(token), indexKey(first.tabId)];
    const secondEnvelope = await sessionArea.get(keys);
    const second = parseRecord(envelopeValue(secondEnvelope, keys[0], keys));
    const index = parseIndex(envelopeValue(secondEnvelope, keys[1], keys));
    return sameRecord(first, second, RECORD_KEYS) && correlated(second, index)
      ? Object.freeze({ record: second, index }) : null;
  }

  async function readIndexedPair(tabId) {
    const key = indexKey(tabId);
    const envelope = await sessionArea.get(key);
    const stored = envelopeValue(envelope, key);
    if (stored === ABSENT) return Object.freeze({ absent: true });
    const index = parseIndex(stored);
    if (!index || index.tabId !== tabId) return null;
    const pair = await readPair(index.token);
    return pair && sameRecord(pair.index, index, INDEX_KEYS) ? pair : null;
  }

  async function writePair(record, index) {
    await sessionArea.set({ [recordKey(record.token)]: record, [indexKey(record.tabId)]: index });
    const verified = await readPair(record.token);
    return Boolean(verified && sameRecord(verified.record, record, RECORD_KEYS) &&
      sameRecord(verified.index, index, INDEX_KEYS));
  }

  async function removePair(record) {
    const keys = [recordKey(record.token), indexKey(record.tabId)];
    await sessionArea.remove(keys);
    const envelope = await sessionArea.get(keys);
    return keys.every(key => envelopeValue(envelope, key, keys) === ABSENT);
  }

  function forget(record) {
    if (state.byToken.get(record.token)?.generation === record.generation) state.byToken.delete(record.token);
    if (state.byTab.get(record.tabId)?.token === record.token) state.byTab.delete(record.tabId);
  }

  async function eraseExpired(record) {
    if (!await removePair(record)) return false;
    forget(record);
    return true;
  }

  async function removeKeys(keys) {
    if (keys.length === 0) return true;
    await sessionArea.remove(keys);
    const envelope = await sessionArea.get(keys);
    return keys.every(key => envelopeValue(envelope, key, keys) === ABSENT);
  }

  function snapshot(value) {
    try {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) return null;
      const output = new Map();
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== 'string') return null;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
        output.set(key, descriptor.value);
      }
      return output;
    } catch { return null; }
  }

  function initialize(initializationBarrier = Promise.resolve(true)) {
    if (state.initialized) return Promise.resolve(true);
    if (state.initialization) return state.initialization;
    const operation = serialize(state, async () => {
      try {
        if (state.initialized) return true;
        if (await initializationBarrier !== true) return false;
        const stored = snapshot(await sessionArea.get(null));
        if (!stored) return false;
        const launchKeys = [...stored.keys()].filter(key =>
          key.startsWith(RECORD_PREFIX) || key.startsWith(INDEX_PREFIX));
        const retained = new Set();
        const removals = new Set();
        const hydratedByTab = new Map();
        const hydratedByToken = new Map();
        const generations = new Map();

        for (const key of launchKeys.filter(candidate => candidate.startsWith(INDEX_PREFIX))) {
          const tabText = key.slice(INDEX_PREFIX.length);
          if (!/^(0|[1-9][0-9]*)$/u.test(tabText)) { removals.add(key); continue; }
          const tabId = Number(tabText);
          if (!safeChromeId(tabId)) { removals.add(key); continue; }
          const index = parseIndex(stored.get(key));
          const recordStorageKey = index ? recordKey(index.token) : null;
          const record = recordStorageKey ? parseRecord(stored.get(recordStorageKey)) : null;
          if (!index || index.tabId !== tabId || !record || !correlated(record, index) ||
            hydratedByTab.has(tabId) || hydratedByToken.has(index.token)) {
            removals.add(key);
            if (recordStorageKey) removals.add(recordStorageKey);
            continue;
          }
          generations.set(tabId, Math.max(generations.get(tabId) ?? 0, index.generation));
          retained.add(key);
          retained.add(recordStorageKey);
          if (record.state === 'issued') {
            removals.add(key);
            removals.add(recordStorageKey);
            continue;
          }
          const url = urlFor(chromeApi.runtime.id, record.token);
          const contexts = await chromeApi.runtime.getContexts({
            contextTypes: ['SIDE_PANEL'], documentUrls: [url],
          });
          const context = Array.isArray(contexts) && contexts.length === 1
            ? parseContext(contexts[0], url)
            : null;
          if (!context || context.contextId !== record.contextId || context.documentId !== record.documentId) {
            removals.add(key);
            removals.add(recordStorageKey);
            continue;
          }
          const reservation = {
            ...record, persistence: Promise.resolve(true), persistenceState: 'ready', connected: false,
          };
          hydratedByTab.set(tabId, reservation);
          hydratedByToken.set(record.token, reservation);
        }
        for (const key of launchKeys) if (!retained.has(key)) removals.add(key);
        if (!await removeKeys([...removals])) return false;
        const pending = [...state.byToken.values()].filter(reservation =>
          reservation?.persistenceState === 'pending' &&
          state.byTab.get(reservation.tabId) === reservation &&
          state.byToken.get(reservation.token) === reservation);
        for (const reservation of pending) {
          if (hydratedByTab.has(reservation.tabId) || hydratedByToken.has(reservation.token)) continue;
          hydratedByTab.set(reservation.tabId, reservation);
          hydratedByToken.set(reservation.token, reservation);
          generations.set(reservation.tabId,
            Math.max(generations.get(reservation.tabId) ?? 0, reservation.generation));
        }
        state.byTab = hydratedByTab;
        state.byToken = hydratedByToken;
        state.generations = generations;
        state.initialized = true;
        return true;
      } catch { return false; }
    });
    state.initialization = operation.then(result => {
      if (!result) state.initialization = null;
      return result;
    }, () => {
      state.initialization = null;
      return false;
    });
    return state.initialization;
  }

  function issue(raw) {
    const input = exact(raw, ['tabId', 'windowId']);
    if ((!state.initialized && !state.initialization) || !input ||
      !safeChromeId(input.tabId) || !safeChromeId(input.windowId)) return fail();
    let issuedAt;
    let token;
    let rotatesFrom = null;
    try {
      issuedAt = now();
      if (!safeEpoch(issuedAt) || issuedAt > Number.MAX_SAFE_INTEGER - ttlMs) throw new Error('denied');
      const existing = state.byTab.get(input.tabId);
      if (existing && (existing.state === 'admitted' || existing.expiresAt > issuedAt)) {
        return fail('PANEL_LAUNCH_CONFLICT');
      }
      if (existing) {
        rotatesFrom = existing;
        state.byTab.delete(input.tabId);
        state.byToken.delete(existing.token);
      }
      token = encodeToken(randomBytes(32));
      if (state.byToken.has(token)) return fail('PANEL_LAUNCH_CONFLICT');
    } catch { return fail(); }

    const generation = (state.generations.get(input.tabId) ?? 0) + 1;
    if (!Number.isSafeInteger(generation)) return fail();
    const expiresAt = issuedAt + ttlMs;
    const record = {
      version: 1, token, tabId: input.tabId, windowId: input.windowId, generation,
      state: 'issued', contextId: null, documentId: null, issuedAt, expiresAt,
    };
    const index = {
      version: 1, tabId: input.tabId, token, generation, state: 'issued', issuedAt, expiresAt,
    };
    const reservation = { ...record, persistence: null, persistenceState: 'pending', connected: false };
    state.generations.set(input.tabId, generation);
    state.byTab.set(input.tabId, reservation);
    state.byToken.set(token, reservation);
    reservation.persistence = serialize(state, async () => {
      try {
        if (!state.initialized || state.byTab.get(input.tabId) !== reservation ||
          state.byToken.get(token) !== reservation) throw new Error('denied');
        if (rotatesFrom) {
          const priorPersisted = await rotatesFrom.persistence;
          const prior = await readPair(rotatesFrom.token);
          if (prior) {
            if (!priorPersisted || prior.record.tabId !== input.tabId ||
              prior.record.generation !== rotatesFrom.generation || prior.record.expiresAt > issuedAt ||
              !await removePair(prior.record)) throw new Error('denied');
          } else if (priorPersisted) {
            throw new Error('denied');
          }
        } else {
          const prior = await readIndexedPair(input.tabId);
          if (!prior) throw new Error('denied');
          if (!prior.absent) {
            if (prior.record.state === 'admitted' || prior.record.expiresAt > issuedAt ||
              !await removePair(prior.record)) throw new Error('denied');
          }
        }
        const tokenEnvelope = await sessionArea.get(recordKey(token));
        if (envelopeValue(tokenEnvelope, recordKey(token)) !== ABSENT) throw new Error('denied');
        const persisted = await writePair(record, index);
        if (!persisted) throw new Error('denied');
        return persisted;
      } catch {
        if (state.byTab.get(input.tabId) === reservation) state.byTab.delete(input.tabId);
        if (state.byToken.get(token) === reservation) state.byToken.delete(token);
        return false;
      }
    }).then(persisted => {
      reservation.persistenceState = persisted ? 'ready' : 'failed';
      return persisted;
    }, () => {
      reservation.persistenceState = 'failed';
      return false;
    });

    return Object.freeze({ ok: true, token, path: pathFor(token), generation });
  }

  function isReady(raw) {
    const issued = parseIssued(raw);
    if (!state.initialized || !issued) return false;
    const reservation = state.byToken.get(issued.token);
    if (!reservation || reservation.generation !== issued.generation || reservation.state !== 'issued' ||
      reservation.persistenceState !== 'ready' || state.byTab.get(reservation.tabId) !== reservation) return false;
    try {
      const current = now();
      return safeEpoch(current) && current >= reservation.issuedAt && current < reservation.expiresAt;
    } catch { return false; }
  }

  async function whenReady(raw) {
    const issued = parseIssued(raw);
    if (!issued) return false;
    const reservation = state.byToken.get(issued.token);
    if (!reservation || reservation.generation !== issued.generation ||
      state.byTab.get(reservation.tabId) !== reservation || !await reservation.persistence) return false;
    if (state.byToken.get(issued.token) !== reservation || state.byTab.get(reservation.tabId) !== reservation ||
      reservation.persistenceState !== 'ready') return false;
    if (reservation.state === 'admitted') return true;
    if (reservation.state !== 'issued') return false;
    try {
      const current = now();
      return safeEpoch(current) && current >= reservation.issuedAt && current < reservation.expiresAt;
    } catch { return false; }
  }

  async function admitPort(raw) {
    const parsedSender = parseSender(raw, chromeApi.runtime.id);
    if (!parsedSender) return fail();
    const reservation = state.byToken.get(parsedSender.token);
    if (reservation && !await reservation.persistence) return fail();
    return serialize(state, async () => {
      try {
        const pair = await readPair(parsedSender.token);
        const live = pair ? state.byToken.get(pair.record.token) : null;
        if (pair?.record.state === 'admitted' && (!live || live.connected)) return fail();
        const proofStartedAt = readNow();
        if (!pair || pair.record.issuedAt > proofStartedAt) return fail();
        if (pair.record.state === 'issued' && proofStartedAt >= pair.record.expiresAt) {
          await eraseExpired(pair.record);
          return fail();
        }
        const contexts = await chromeApi.runtime.getContexts({
          contextTypes: ['SIDE_PANEL'], documentUrls: [parsedSender.url],
        });
        const proofFinishedAt = readNow();
        if (proofFinishedAt < proofStartedAt) return fail();
        if (pair.record.state === 'issued' && proofFinishedAt >= pair.record.expiresAt) {
          await eraseExpired(pair.record);
          return fail();
        }
        if (!Array.isArray(contexts) || contexts.length !== 1) return fail();
        const context = parseContext(contexts[0], parsedSender.url);
        if (!context) return fail();
        if (pair.record.state === 'admitted') {
          if (pair.record.contextId !== context.contextId ||
            pair.record.documentId !== context.documentId) return fail();
          live.connected = true;
          return createAdmission(chromeApi.runtime.id, pair.record, parsedSender.url);
        }
        const admittedRecord = {
          ...pair.record, state: 'admitted', contextId: context.contextId, documentId: context.documentId,
        };
        const admittedIndex = { ...pair.index, state: 'admitted' };
        if (!await writePair(admittedRecord, admittedIndex)) return fail();
        if (live) {
          live.state = 'admitted';
          live.contextId = context.contextId;
          live.documentId = context.documentId;
          live.connected = true;
        }
        return createAdmission(chromeApi.runtime.id, admittedRecord, parsedSender.url);
      } catch { return fail(); }
    });
  }

  async function reprove(raw) {
    const admission = parseAdmission(raw, chromeApi.runtime.id);
    if (!admission) return fail();
    return serialize(state, async () => {
      try {
        const pair = await readPair(admission.token);
        if (!pair || pair.record.state !== 'admitted' || pair.record.tabId !== admission.tabId ||
          pair.record.windowId !== admission.windowId || pair.record.generation !== admission.generation ||
          pair.record.contextId !== admission.contextId || pair.record.documentId !== admission.documentId ||
          pair.record.issuedAt > pair.record.expiresAt) return fail();
        const contexts = await chromeApi.runtime.getContexts({
          contextTypes: ['SIDE_PANEL'], documentUrls: [admission.url],
        });
        if (!Array.isArray(contexts) || contexts.length !== 1) return fail();
        const context = parseContext(contexts[0], admission.url);
        if (!context || context.contextId !== admission.contextId || context.documentId !== admission.documentId) return fail();
        return admission;
      } catch { return fail(); }
    });
  }

  async function revoke(raw) {
    const admission = parseAdmission(raw, chromeApi.runtime.id);
    const issued = admission ? null : parseIssued(raw);
    const claim = admission ?? issued;
    if (!claim) return fail();
    const reservation = state.byToken.get(claim.token);
    if (reservation && !await reservation.persistence) return fail();
    return serialize(state, async () => {
      try {
        const pair = await readPair(claim.token);
        if (!pair || pair.record.generation !== claim.generation ||
          (admission && (pair.record.state !== 'admitted' || pair.record.tabId !== admission.tabId ||
            pair.record.windowId !== admission.windowId || pair.record.contextId !== admission.contextId ||
            pair.record.documentId !== admission.documentId))) return fail();
        if (!await removePair(pair.record)) return fail();
        forget(pair.record);
        return Object.freeze({ ok: true, revoked: true });
      } catch { return fail(); }
    });
  }

  return Object.freeze({ initialize, issue, isReady, whenReady, admitPort, reprove, revoke });
}
