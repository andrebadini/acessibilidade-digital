import { REVIEW_SURFACE, deriveTrustedExtensionContext } from './target-capabilities.js';

const AUDIT_ID = /^[A-Za-z0-9._:-]{1,160}$/u;
const CAPABILITY = /^[A-Za-z0-9_-]{22}$/u;
const PATH = '/src/review/index.html';
const TTL_MS = 30 * 60 * 1000;
const CONNECT_TIMEOUT_MS = 2_000;
const REPORT_INTENTS = Object.freeze(['export', 'review-commit', 'delete-audit', 'delete-all']);
const REPORT_INTENT_SET = new Set(REPORT_INTENTS);
const SHARED_QUEUES = new WeakMap();

const launchKey = auditId => `audita:report-launch:v1:${auditId}`;
const indexKey = tabId => `audita:report-launch-tab:v1:${tabId}`;
const consumerKey = id => `audita:report-consumer:v1:${id}`;

function fail(code) { return Object.freeze({ ok: false, code }); }
function safeId(value) { return Number.isSafeInteger(value) && value >= 0; }
function ownDataDescriptor(value, key, optional = false) {
  try {
    if (!value || typeof value !== 'object') return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) return optional ? Object.freeze({ present: false, value: undefined }) : null;
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
    return Object.freeze({ present: true, value: descriptor.value });
  } catch { return null; }
}
function tabSnapshot(value) {
  const id = ownDataDescriptor(value, 'id');
  const windowId = ownDataDescriptor(value, 'windowId');
  const url = ownDataDescriptor(value, 'url');
  const pendingUrl = ownDataDescriptor(value, 'pendingUrl', true);
  if (!id || !windowId || !url || !pendingUrl) return null;
  return Object.freeze({
    id: id.value, windowId: windowId.value, url: url.value,
    pendingUrlPresent: pendingUrl.present, pendingUrl: pendingUrl.value,
  });
}
function exactStagingTab(tab, launch, expectedUrl) {
  if (!tab || tab.id !== launch.tabId || tab.windowId !== launch.windowId) return false;
  if (tab.url === expectedUrl) return !tab.pendingUrlPresent || tab.pendingUrl === expectedUrl;
  return tab.url === 'about:blank' && tab.pendingUrlPresent && tab.pendingUrl === expectedUrl;
}
function exactConnectedTab(tab, launch, expectedUrl) {
  return Boolean(tab && tab.id === launch.tabId && tab.windowId === launch.windowId &&
    tab.url === expectedUrl && !tab.pendingUrlPresent);
}
function freeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value); for (const child of Object.values(value)) freeze(child, seen); return Object.freeze(value);
}
function exact(value, keys) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return null;
    const own = Reflect.ownKeys(value);
    if (own.length !== keys.length || own.some(key => typeof key !== 'string' || !keys.includes(key))) return null;
    const copy = {};
    for (const key of keys) { const descriptor = Object.getOwnPropertyDescriptor(value, key); if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null; copy[key] = descriptor.value; }
    return copy;
  } catch { return null; }
}
function launchRecord(value) {
  const row = exact(value, ['version', 'auditId', 'tabId', 'windowId', 'path', 'documentId', 'state', 'issuedAt', 'expiresAt']);
  if (!row || row.version !== 1 || !AUDIT_ID.test(row.auditId ?? '') || !safeId(row.tabId) || !safeId(row.windowId) ||
    row.path !== PATH || !['allocated', 'awaiting-connection', 'connected', 'revoked'].includes(row.state) ||
    !Number.isSafeInteger(row.issuedAt) || !Number.isSafeInteger(row.expiresAt) || row.issuedAt < 0 || row.expiresAt <= row.issuedAt ||
    (['allocated', 'awaiting-connection'].includes(row.state) && row.documentId !== null) ||
    (row.state === 'connected' && (typeof row.documentId !== 'string' || !row.documentId))) return null;
  if (row.state === 'revoked' && row.documentId !== null && (typeof row.documentId !== 'string' || !row.documentId)) return null;
  return freeze(row);
}
function consumerRecord(value) {
  const row = exact(value, ['version', 'sessionCapabilityId', 'auditId', 'tabId', 'windowId', 'documentId', 'intents', 'state', 'issuedAt', 'expiresAt']);
  if (!row || row.version !== 1 || !CAPABILITY.test(row.sessionCapabilityId ?? '') || !AUDIT_ID.test(row.auditId ?? '') ||
    !safeId(row.tabId) || !safeId(row.windowId) || typeof row.documentId !== 'string' || !row.documentId ||
    !Array.isArray(row.intents) || row.intents.length !== REPORT_INTENTS.length ||
    row.intents.some((intent, index) => intent !== REPORT_INTENTS[index]) ||
    !['active', 'revoked'].includes(row.state) || !Number.isSafeInteger(row.issuedAt) || !Number.isSafeInteger(row.expiresAt)) return null;
  return freeze(row);
}
function readEpoch(fn) { const value = fn(); if (!Number.isSafeInteger(value) || value < 0) throw new Error('REPORT_CLOCK_DENIED'); return value; }
function liveLaunchAt(launch, auditId, now) {
  return Boolean(launch && launch.auditId === auditId && launch.issuedAt <= now && now < launch.expiresAt);
}
function exactLiveConsumerGraph(consumer, launch, sessionCapabilityId, auditId, intent, now) {
  return Boolean(consumer && launch && consumer.sessionCapabilityId === sessionCapabilityId &&
    consumer.auditId === auditId && launch.auditId === auditId &&
    consumer.state === 'active' && launch.state === 'connected' && consumer.intents.includes(intent) &&
    launch.issuedAt <= consumer.issuedAt && consumer.issuedAt <= now && now < consumer.expiresAt &&
    now < launch.expiresAt && consumer.expiresAt === launch.expiresAt &&
    consumer.tabId === launch.tabId && consumer.windowId === launch.windowId &&
    consumer.documentId === launch.documentId);
}
function canonicalUrl(chromeApi, auditId) {
  const url = new URL(chromeApi.runtime.getURL('src/review/index.html'));
  url.searchParams.set('auditId', auditId);
  if (url.pathname !== PATH || url.hash || [...url.searchParams.keys()].length !== 1 || url.searchParams.getAll('auditId').length !== 1) throw new Error();
  return url.href;
}
function opaqueId(randomBytes) {
  const bytes = randomBytes(16);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 16) throw new Error();
  let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
  const id = btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/gu, '');
  if (!CAPABILITY.test(id)) throw new Error(); return id;
}
async function stored(area, key, parse) {
  const envelope = await area.get(key);
  const root = exact(envelope, Object.hasOwn(envelope ?? {}, key) ? [key] : []);
  return root && Object.hasOwn(root, key) ? parse(root[key]) : null;
}
async function writeConfirmed(area, key, value, parse) {
  await area.set({ [key]: value });
  const confirmed = await stored(area, key, parse);
  return confirmed && JSON.stringify(confirmed) === JSON.stringify(value) ? confirmed : null;
}
function queuesFor(area) { let map = SHARED_QUEUES.get(area); if (!map) { map = new Map(); SHARED_QUEUES.set(area, map); } return map; }
function serialize(area, key, task) {
  const queues = queuesFor(area); const prior = queues.get(key) ?? Promise.resolve();
  const operation = prior.then(task, task); const tail = operation.then(() => undefined, () => undefined); queues.set(key, tail);
  return operation.finally(() => { if (queues.get(key) === tail) queues.delete(key); });
}
async function tabCall(receiver, method, ...args) {
  try { return await receiver[method](...args); } catch { throw new Error('REPORT_OPEN_FAILED'); }
}

export function createReportLaunchAuthority(raw) {
  const input = exact(raw, ['chromeApi', 'sessionArea', 'epochNow', 'randomBytes']);
  if (!input || typeof input.chromeApi?.runtime?.id !== 'string' || typeof input.chromeApi.runtime.getURL !== 'function' ||
    typeof input.chromeApi.runtime.getContexts !== 'function' || typeof input.chromeApi?.tabs?.create !== 'function' ||
    typeof input.chromeApi.tabs.update !== 'function' || typeof input.chromeApi.tabs.get !== 'function' ||
    typeof input.chromeApi.tabs.remove !== 'function' || typeof input.sessionArea?.get !== 'function' ||
    typeof input.sessionArea.set !== 'function' || typeof input.epochNow !== 'function' || typeof input.randomBytes !== 'function') {
    throw new TypeError('REPORT_LAUNCH_INVALID');
  }
  const getLaunch = async auditId => {
    if (!AUDIT_ID.test(auditId ?? '')) return null;
    const record = await stored(input.sessionArea, launchKey(auditId), launchRecord);
    return record?.auditId === auditId ? record : null;
  };
  const getConsumer = id => CAPABILITY.test(id ?? '') ? stored(input.sessionArea, consumerKey(id), consumerRecord) : Promise.resolve(null);

  async function focusConnected(record, expectedAuditId) {
    const now = readEpoch(input.epochNow);
    if (!liveLaunchAt(record, expectedAuditId, now) || record.state !== 'connected') return false;
    let tab; let contexts;
    try {
      tab = await input.chromeApi.tabs.get(record.tabId);
      contexts = await input.chromeApi.runtime.getContexts({ documentIds: [record.documentId] });
    } catch { return false; }
    const expected = canonicalUrl(input.chromeApi, record.auditId);
    const exactContext = Array.isArray(contexts) && contexts.filter(context => context?.contextType === 'TAB' &&
      context.documentId === record.documentId && context.documentUrl === expected && context.tabId === record.tabId && context.windowId === record.windowId).length === 1;
    if (!exactConnectedTab(tabSnapshot(tab), record, expected) || !exactContext) return false;
    try {
      await input.chromeApi.tabs.update(record.tabId, { active: true });
      if (typeof input.chromeApi.windows?.update === 'function') await input.chromeApi.windows.update(record.windowId, { focused: true });
      return true;
    } catch { return false; }
  }

  async function setupOpen(auditId, windowId) {
    const existing = await getLaunch(auditId);
    if (existing && existing.state === 'connected' && await focusConnected(existing, auditId)) return { existing, created: false };
    if (existing && ['allocated', 'awaiting-connection'].includes(existing.state) &&
      liveLaunchAt(existing, auditId, readEpoch(input.epochNow))) {
      return { existing, created: false };
    }
    const tab = await tabCall(input.chromeApi.tabs, 'create', { url: 'about:blank', active: true, windowId });
    if (!safeId(tab?.id) || tab.windowId !== windowId) throw new Error('REPORT_OPEN_FAILED');
    const now = readEpoch(input.epochNow);
    const allocated = freeze({ version: 1, auditId, tabId: tab.id, windowId, path: PATH, documentId: null, state: 'allocated', issuedAt: now, expiresAt: now + TTL_MS });
    const persisted = await writeConfirmed(input.sessionArea, launchKey(auditId), allocated, launchRecord);
    if (!persisted) { try { await input.chromeApi.tabs.remove(tab.id); } catch {} throw new Error('REPORT_OPEN_FAILED'); }
    await input.sessionArea.set({ [indexKey(tab.id)]: auditId });
    try { await tabCall(input.chromeApi.tabs, 'update', tab.id, { url: canonicalUrl(input.chromeApi, auditId), active: true }); }
    catch (error) {
      const current = await getLaunch(auditId);
      if (current?.tabId === tab.id && current.state === 'allocated') {
        await writeConfirmed(input.sessionArea, launchKey(auditId), freeze({ ...current, state: 'revoked' }), launchRecord);
        try { await input.chromeApi.tabs.remove(tab.id); } catch {}
      }
      throw error;
    }
    const current = await getLaunch(auditId);
    if (!current || current.tabId !== tab.id || current.state !== 'allocated') throw new Error('REPORT_OPEN_FAILED');
    const awaiting = await writeConfirmed(input.sessionArea, launchKey(auditId), freeze({ ...current, state: 'awaiting-connection' }), launchRecord);
    if (!awaiting) throw new Error('REPORT_OPEN_FAILED');
    return { existing: awaiting, created: true };
  }

  async function waitForConnection(auditId) {
    const deadline = readEpoch(input.epochNow) + CONNECT_TIMEOUT_MS;
    // A real monotonic clock may be fixed in deterministic tests, so also bound attempts.
    for (let attempt = 0; attempt < 210; attempt += 1) {
      const current = await getLaunch(auditId);
      const now = readEpoch(input.epochNow);
      if (!liveLaunchAt(current, auditId, now) || current.state === 'revoked') throw new Error('REPORT_CONNECT_DENIED');
      if (current?.state === 'connected') return current;
      if (now > deadline) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('REPORT_CONNECT_TIMEOUT');
  }

  async function openRegisteredReport({ auditId, windowId } = {}) {
    if (!AUDIT_ID.test(auditId ?? '') || !safeId(windowId)) throw new Error('REPORT_OPEN_FAILED');
    const setup = await serialize(input.sessionArea, auditId, () => setupOpen(auditId, windowId));
    if (setup.existing.state === 'connected') return freeze({ ok: true, auditId, state: 'connected', tabId: setup.existing.tabId });
    const connected = await waitForConnection(auditId);
    return freeze({ ok: true, auditId, state: 'connected', tabId: connected.tabId });
  }

  async function connect({ auditId, sender } = {}) {
    if (!AUDIT_ID.test(auditId ?? '')) return fail('REPORT_CONNECT_DENIED');
    let context;
    try { context = await deriveTrustedExtensionContext({ sender, chromeApi: input.chromeApi, surface: REVIEW_SURFACE }); }
    catch { return fail('CONTEXT_DENIED'); }
    return serialize(input.sessionArea, auditId, async () => {
      const launch = await getLaunch(auditId);
      const now = readEpoch(input.epochNow);
      if (!liveLaunchAt(launch, auditId, now) || !['allocated', 'awaiting-connection'].includes(launch.state) ||
        context.tabId !== launch.tabId || context.windowId !== launch.windowId || context.documentUrl !== canonicalUrl(input.chromeApi, auditId)) {
        return fail('REPORT_CONNECT_DENIED');
      }
      const sessionCapabilityId = opaqueId(input.randomBytes);
      const consumer = freeze({
        version: 1, sessionCapabilityId, auditId, tabId: launch.tabId, windowId: launch.windowId,
        documentId: sender.documentId, intents: [...REPORT_INTENTS], state: 'active', issuedAt: now, expiresAt: launch.expiresAt,
      });
      if (!await writeConfirmed(input.sessionArea, consumerKey(sessionCapabilityId), consumer, consumerRecord)) return fail('REPORT_CONNECT_DENIED');
      const current = await getLaunch(auditId);
      if (!current || current.state !== launch.state || current.tabId !== launch.tabId) {
        await writeConfirmed(input.sessionArea, consumerKey(sessionCapabilityId), freeze({ ...consumer, state: 'revoked' }), consumerRecord);
        return fail('REPORT_CONNECT_DENIED');
      }
      const connected = await writeConfirmed(input.sessionArea, launchKey(auditId), freeze({ ...launch, documentId: sender.documentId, state: 'connected' }), launchRecord);
      if (!connected) return fail('REPORT_CONNECT_DENIED');
      return freeze({ ok: true, auditId, sessionCapabilityId, state: 'view-only' });
    });
  }

  async function authorizeIntent({ sessionCapabilityId, auditId, intent, sender } = {}) {
    if (!CAPABILITY.test(sessionCapabilityId ?? '') || !AUDIT_ID.test(auditId ?? '') || !REPORT_INTENT_SET.has(intent)) {
      return fail('REPORT_INTENT_DENIED');
    }
    let context;
    try { context = await deriveTrustedExtensionContext({ sender, chromeApi: input.chromeApi, surface: REVIEW_SURFACE }); }
    catch { return fail('CONTEXT_DENIED'); }
    const [consumer, launch] = await Promise.all([getConsumer(sessionCapabilityId), getLaunch(auditId)]);
    const now = readEpoch(input.epochNow);
    if (!exactLiveConsumerGraph(consumer, launch, sessionCapabilityId, auditId, intent, now) ||
      consumer.documentId !== sender.documentId || consumer.tabId !== context.tabId || consumer.windowId !== context.windowId ||
      launch.documentId !== sender.documentId || launch.tabId !== context.tabId || launch.windowId !== context.windowId) {
      return fail('REPORT_INTENT_DENIED');
    }
    return freeze({ ok: true, auditId, windowId: consumer.windowId, sessionCapabilityId, intent });
  }

  async function authorizeExport({ sessionCapabilityId, auditId, sender } = {}) {
    const authorized = await authorizeIntent({ sessionCapabilityId, auditId, intent: 'export', sender });
    if (authorized.ok !== true) {
      return authorized.code === 'CONTEXT_DENIED' ? authorized : fail('REPORT_EXPORT_DENIED');
    }
    return freeze({
      ok: true, auditId: authorized.auditId, windowId: authorized.windowId,
      sessionCapabilityId: authorized.sessionCapabilityId,
    });
  }

  async function validateConsumer(sessionCapabilityId, auditId) {
    if (!CAPABILITY.test(sessionCapabilityId ?? '') || !AUDIT_ID.test(auditId ?? '')) return false;
    const [consumer, launch] = await Promise.all([getConsumer(sessionCapabilityId), getLaunch(auditId)]);
    const now = readEpoch(input.epochNow);
    return exactLiveConsumerGraph(consumer, launch, sessionCapabilityId, auditId, 'export', now);
  }

  async function revokeLaunch(launch) {
    if (!launch || launch.state === 'revoked') return;
    if (launch.documentId) {
      const envelope = await input.sessionArea.get(null);
      for (const [key, value] of Object.entries(envelope ?? {})) {
        if (!key.startsWith('audita:report-consumer:v1:')) continue;
        const consumer = consumerRecord(value);
        if (consumer?.auditId === launch.auditId && consumer.state === 'active') {
          await writeConfirmed(input.sessionArea, key, freeze({ ...consumer, state: 'revoked' }), consumerRecord);
        }
      }
    }
    await writeConfirmed(input.sessionArea, launchKey(launch.auditId), freeze({ ...launch, state: 'revoked' }), launchRecord);
  }

  async function auditIdForTab(tabId) {
    const envelope = await input.sessionArea.get(indexKey(tabId));
    const value = envelope?.[indexKey(tabId)];
    return AUDIT_ID.test(value ?? '') ? value : null;
  }

  async function readOwnedTab(launch) {
    try { return tabSnapshot(await input.chromeApi.tabs.get(launch.tabId)); } catch { return null; }
  }

  async function connectedDocumentProof(launch, expectedUrl) {
    const tab = await readOwnedTab(launch);
    if (!exactConnectedTab(tab, launch, expectedUrl)) return Object.freeze({ exact: false, tab });
    let contexts;
    try { contexts = await input.chromeApi.runtime.getContexts({ documentIds: [launch.documentId] }); }
    catch { return Object.freeze({ exact: false, tab }); }
    const exactContext = Array.isArray(contexts) && contexts.filter(context => context?.contextType === 'TAB' &&
      context.documentId === launch.documentId && context.documentUrl === expectedUrl &&
      context.tabId === launch.tabId && context.windowId === launch.windowId).length === 1;
    return Object.freeze({ exact: exactContext, tab });
  }

  async function transitionReload(launch) {
    await revokeLaunchConsumers(launch.auditId);
    const current = await getLaunch(launch.auditId);
    if (!current || current.state !== 'connected' || current.documentId !== launch.documentId) {
      await revokeLaunch(current);
      return;
    }
    await writeConfirmed(input.sessionArea, launchKey(launch.auditId),
      freeze({ ...current, documentId: null, state: 'awaiting-connection' }), launchRecord);
  }

  async function handleTabUpdated(tabId, changeInfo) {
    if (!safeId(tabId)) return false;
    const auditId = await auditIdForTab(tabId); if (!auditId) return false;
    return serialize(input.sessionArea, auditId, async () => {
      const launch = await getLaunch(auditId); if (!launch || launch.tabId !== tabId || launch.state === 'revoked') return false;
      const url = typeof changeInfo?.url === 'string' ? changeInfo.url : null;
      const navigationStarted = url !== null || changeInfo?.status === 'loading';
      if (!navigationStarted) return false;
      const expectedUrl = canonicalUrl(input.chromeApi, auditId);
      if (launch.state === 'connected') {
        const proof = await connectedDocumentProof(launch, expectedUrl);
        if (proof.exact) return false;
        if (exactStagingTab(proof.tab, launch, expectedUrl)) await transitionReload(launch);
        else await revokeLaunch(launch);
        return true;
      }
      if (url !== null && url !== 'about:blank' && url !== expectedUrl) {
        await revokeLaunch(launch); return true;
      }
      const current = await readOwnedTab(launch);
      if (exactStagingTab(current, launch, expectedUrl)) return false;
      await revokeLaunch(launch); return true;
    });
  }

  async function revokeLaunchConsumers(auditId) {
    const envelope = await input.sessionArea.get(null);
    for (const [key, value] of Object.entries(envelope ?? {})) {
      const consumer = key.startsWith('audita:report-consumer:v1:') ? consumerRecord(value) : null;
      if (consumer?.auditId === auditId && consumer.state === 'active') {
        await writeConfirmed(input.sessionArea, key, freeze({ ...consumer, state: 'revoked' }), consumerRecord);
      }
    }
  }

  async function handleTabRemoved(tabId) {
    const auditId = safeId(tabId) ? await auditIdForTab(tabId) : null; if (!auditId) return false;
    return serialize(input.sessionArea, auditId, async () => { const launch = await getLaunch(auditId); await revokeLaunch(launch); return true; });
  }
  async function handleWindowRemoved(windowId) {
    if (!safeId(windowId)) return false;
    const envelope = await input.sessionArea.get(null); let changed = false;
    for (const [key, value] of Object.entries(envelope ?? {})) {
      const launch = key.startsWith('audita:report-launch:v1:') ? launchRecord(value) : null;
      if (launch?.windowId === windowId && launch.state !== 'revoked') { await serialize(input.sessionArea, launch.auditId, () => revokeLaunch(launch)); changed = true; }
    }
    return changed;
  }

  return freeze({
    openRegisteredReport, connect, authorizeIntent, authorizeExport, validateConsumer, getLaunch, getConsumer,
    handleTabUpdated, handleTabRemoved, handleWindowRemoved,
  });
}
