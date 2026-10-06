import { REVIEW_SURFACE, deriveTrustedExtensionContext } from './target-capabilities.js';
import { canonicalAuditId } from '../storage/audit-retention.js';

const AUDIT_ID = /^[A-Za-z0-9._:-]{1,160}$/u;
const CAPABILITY = /^[A-Za-z0-9_-]{22}$/u;
const DIGEST = /^hmac-sha256:[A-Za-z0-9_-]{43}$/u;
const PATH = '/src/review/index.html';
const TTL_MS = 30 * 60 * 1000;
const CONNECT_TIMEOUT_MS = 2_000;
const REPORT_INTENTS = Object.freeze([
  'export', 'review-commit', 'delete-audit', 'delete-all', 'highlight', 'return-source',
]);
const BASE_REPORT_INTENTS = Object.freeze(['export', 'review-commit', 'delete-audit', 'delete-all']);
const REPORT_INTENT_SET = new Set(REPORT_INTENTS);
const PAGE_AIDS = new Set(['zoom-200', 'reflow-320', 'text-spacing', 'reset']);
// Espaçamentos da WCAG 1.4.12 / ABNT 5.12.1 a 5.12.4, aplicados juntos e sem alterar outros estilos.
const TEXT_SPACING_CSS = '* { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; } p { margin-bottom: 2em !important; }';
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
  const v1 = exact(value, ['version', 'auditId', 'tabId', 'windowId', 'path', 'documentId', 'state', 'issuedAt', 'expiresAt']);
  const v2 = exact(value, ['version', 'auditId', 'tabId', 'windowId', 'path', 'documentId', 'state', 'issuedAt', 'expiresAt', 'sourceSessionCapabilityId', 'sourceSessionState']);
  const row = v2 ?? v1;
  if (!row || ![1, 2].includes(row.version) || !AUDIT_ID.test(row.auditId ?? '') || !safeId(row.tabId) || !safeId(row.windowId) ||
    row.path !== PATH || !['allocated', 'awaiting-connection', 'connected', 'revoked'].includes(row.state) ||
    !Number.isSafeInteger(row.issuedAt) || !Number.isSafeInteger(row.expiresAt) || row.issuedAt < 0 || row.expiresAt <= row.issuedAt ||
    (['allocated', 'awaiting-connection'].includes(row.state) && row.documentId !== null) ||
    (row.state === 'connected' && (typeof row.documentId !== 'string' || !row.documentId))) return null;
  if (row.state === 'revoked' && row.documentId !== null && (typeof row.documentId !== 'string' || !row.documentId)) return null;
  if (row.version === 2 && (!CAPABILITY.test(row.sourceSessionCapabilityId ?? '') ||
    !['result', 'view-only'].includes(row.sourceSessionState))) return null;
  return freeze(row);
}
function consumerRecord(value) {
  const row = exact(value, ['version', 'sessionCapabilityId', 'auditId', 'tabId', 'windowId', 'documentId', 'intents', 'state', 'issuedAt', 'expiresAt']);
  if (!row || row.version !== 1 || !CAPABILITY.test(row.sessionCapabilityId ?? '') || !AUDIT_ID.test(row.auditId ?? '') ||
    !safeId(row.tabId) || !safeId(row.windowId) || typeof row.documentId !== 'string' || !row.documentId ||
    !Array.isArray(row.intents) || ![BASE_REPORT_INTENTS, REPORT_INTENTS].some(expected => row.intents.length === expected.length &&
      row.intents.every((intent, index) => intent === expected[index])) ||
    !['active', 'revoked'].includes(row.state) || !Number.isSafeInteger(row.issuedAt) || !Number.isSafeInteger(row.expiresAt)) return null;
  return freeze(row);
}
function currentAttachedBinding(value) {
  const binding = exact(value, ['kind', 'tabId', 'documentId', 'urlSessionDigest']);
  return binding?.kind === 'attached' && safeId(binding.tabId) && typeof binding.documentId === 'string' && binding.documentId &&
    DIGEST.test(binding.urlSessionDigest ?? '') ? binding : null;
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
  const input = exact(raw, ['chromeApi', 'sessionArea', 'epochNow', 'randomBytes']) ??
    exact(raw, ['chromeApi', 'sessionArea', 'epochNow', 'randomBytes', 'sourceSessionAuthority']) ??
    exact(raw, [
      'chromeApi', 'sessionArea', 'epochNow', 'randomBytes',
      'sourceSessionAuthority', 'sourcePanelAuthority',
    ]);
  if (!input || typeof input.chromeApi?.runtime?.id !== 'string' || typeof input.chromeApi.runtime.getURL !== 'function' ||
    typeof input.chromeApi.runtime.getContexts !== 'function' || typeof input.chromeApi?.tabs?.create !== 'function' ||
    typeof input.chromeApi.tabs.update !== 'function' || typeof input.chromeApi.tabs.get !== 'function' ||
    typeof input.chromeApi.tabs.remove !== 'function' || typeof input.sessionArea?.get !== 'function' ||
    typeof input.sessionArea.set !== 'function' || typeof input.epochNow !== 'function' || typeof input.randomBytes !== 'function' ||
    (Object.hasOwn(input, 'sourceSessionAuthority') && typeof input.sourceSessionAuthority?.reauthorizeReportSource !== 'function') ||
    (Object.hasOwn(input, 'sourcePanelAuthority') &&
      typeof input.sourcePanelAuthority?.hasOpenPanelForSource !== 'function')) {
    throw new TypeError('REPORT_LAUNCH_INVALID');
  }
  const getLaunch = async auditId => {
    if (!AUDIT_ID.test(auditId ?? '')) return null;
    const record = await stored(input.sessionArea, launchKey(auditId), launchRecord);
    return record?.auditId === auditId ? record : null;
  };
  const getConsumer = id => CAPABILITY.test(id ?? '') ? stored(input.sessionArea, consumerKey(id), consumerRecord) : Promise.resolve(null);
  // Estado das ajudas de verificação por aba (zoom anterior e folha de espaçamento), só em memória.
  const pageAidState = new Map();

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

  async function setupOpen(auditId, windowId, source = null) {
    const existing = await getLaunch(auditId);
    if (existing && existing.state === 'connected' && await focusConnected(existing, auditId)) return { existing, created: false };
    if (existing && ['allocated', 'awaiting-connection'].includes(existing.state) &&
      liveLaunchAt(existing, auditId, readEpoch(input.epochNow))) {
      return { existing, created: false };
    }
    const tab = await tabCall(input.chromeApi.tabs, 'create', { url: 'about:blank', active: true, windowId });
    if (!safeId(tab?.id) || tab.windowId !== windowId) throw new Error('REPORT_OPEN_FAILED');
    const now = readEpoch(input.epochNow);
    const allocated = freeze(source === null
      ? { version: 1, auditId, tabId: tab.id, windowId, path: PATH, documentId: null, state: 'allocated', issuedAt: now, expiresAt: now + TTL_MS }
      : { version: 2, auditId, tabId: tab.id, windowId, path: PATH, documentId: null, state: 'allocated', issuedAt: now, expiresAt: now + TTL_MS,
        sourceSessionCapabilityId: source.sourceSessionCapabilityId, sourceSessionState: source.sourceSessionState });
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

  async function openRegisteredReport(raw = {}) {
    const legacy = exact(raw, ['auditId', 'windowId']);
    const v2 = exact(raw, ['auditId', 'windowId', 'sourceSessionCapabilityId', 'sourceSessionState']);
    const request = v2 ?? legacy;
    if (!request || !AUDIT_ID.test(request.auditId ?? '') || !safeId(request.windowId) ||
      (v2 && (!CAPABILITY.test(v2.sourceSessionCapabilityId ?? '') || !['result', 'view-only'].includes(v2.sourceSessionState) ||
        typeof input.sourceSessionAuthority?.reauthorizeReportSource !== 'function'))) throw new Error('REPORT_OPEN_FAILED');
    const setup = await serialize(input.sessionArea, request.auditId, () => setupOpen(request.auditId, request.windowId, v2));
    if (setup.existing.state === 'connected') return freeze({ ok: true, auditId: request.auditId, state: 'connected', tabId: setup.existing.tabId });
    const connected = await waitForConnection(request.auditId);
    return freeze({ ok: true, auditId: request.auditId, state: 'connected', tabId: connected.tabId });
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
      let state = 'view-only';
      let intents = BASE_REPORT_INTENTS;
      if (launch.version === 2) {
        let source;
        try {
          source = await input.sourceSessionAuthority.reauthorizeReportSource({
            sessionCapabilityId: launch.sourceSessionCapabilityId, auditId, state: launch.sourceSessionState,
          });
        } catch { return fail('REPORT_CONNECT_DENIED'); }
        if (source?.ok !== true || source.state !== launch.sourceSessionState) return fail('REPORT_CONNECT_DENIED');
        if (source.state === 'result' && currentAttachedBinding(source.binding)) {
          state = 'result';
          intents = REPORT_INTENTS;
        }
      }
      const sessionCapabilityId = opaqueId(input.randomBytes);
      const consumer = freeze({
        version: 1, sessionCapabilityId, auditId, tabId: launch.tabId, windowId: launch.windowId,
        documentId: sender.documentId, intents: [...intents], state: 'active', issuedAt: now, expiresAt: launch.expiresAt,
      });
      if (!await writeConfirmed(input.sessionArea, consumerKey(sessionCapabilityId), consumer, consumerRecord)) return fail('REPORT_CONNECT_DENIED');
      const current = await getLaunch(auditId);
      if (!current || current.state !== launch.state || current.tabId !== launch.tabId) {
        await writeConfirmed(input.sessionArea, consumerKey(sessionCapabilityId), freeze({ ...consumer, state: 'revoked' }), consumerRecord);
        return fail('REPORT_CONNECT_DENIED');
      }
      const connected = await writeConfirmed(input.sessionArea, launchKey(auditId), freeze({ ...launch, documentId: sender.documentId, state: 'connected' }), launchRecord);
      if (!connected) return fail('REPORT_CONNECT_DENIED');
      return freeze({ ok: true, auditId, sessionCapabilityId, state });
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

  async function authorizedSourceBinding({ sessionCapabilityId, auditId, sender } = {}) {
    const authorized = await authorizeIntent({
      sessionCapabilityId, auditId, intent: 'return-source', sender,
    });
    if (authorized.ok !== true) {
      return authorized.code === 'CONTEXT_DENIED' ? authorized : fail('REPORT_RETURN_DENIED');
    }
    if (typeof input.sourceSessionAuthority?.reauthorizeReportSource !== 'function' ||
      typeof input.chromeApi.windows?.update !== 'function' ||
      typeof input.chromeApi.sidePanel?.open !== 'function') return fail('REPORT_RETURN_DENIED');
    const launch = await getLaunch(auditId);
    if (launch?.version !== 2 || launch.sourceSessionState !== 'result' ||
      !CAPABILITY.test(launch.sourceSessionCapabilityId ?? '')) return fail('REPORT_RETURN_DENIED');
    let source;
    try {
      source = await input.sourceSessionAuthority.reauthorizeReportSource({
        sessionCapabilityId: launch.sourceSessionCapabilityId,
        auditId,
        state: launch.sourceSessionState,
      });
    } catch { return fail('REPORT_RETURN_DENIED'); }
    const proof = exact(source, ['ok', 'state', 'binding', 'windowId', 'live']);
    const binding = currentAttachedBinding(proof?.binding);
    if (proof?.ok !== true || proof.state !== 'result' || proof.live !== true ||
      !safeId(proof.windowId) || !binding) return fail('REPORT_RETURN_DENIED');
    return freeze({ ok: true, windowId: proof.windowId, tabId: binding.tabId, documentId: binding.documentId });
  }

  async function focusSource(source) {
    await input.chromeApi.windows.update(source.windowId, { focused: true });
    await input.chromeApi.tabs.update(source.tabId, { active: true });
  }

  async function returnToSource({ sessionCapabilityId, auditId, sender } = {}) {
    const source = await authorizedSourceBinding({ sessionCapabilityId, auditId, sender });
    if (source.ok !== true) return source;
    try {
      await focusSource(source);
      if (typeof input.sourcePanelAuthority?.hasOpenPanelForSource === 'function') {
        let alreadyOpen = false;
        try {
          alreadyOpen = await input.sourcePanelAuthority.hasOpenPanelForSource({
            tabId: source.tabId,
            windowId: source.windowId,
          });
        } catch {
          alreadyOpen = false;
        }
        if (alreadyOpen === true) return freeze({ ok: true, state: 'source-focused' });
      }
      await input.chromeApi.sidePanel.open({ tabId: source.tabId });
      return freeze({ ok: true, state: 'source-focused' });
    } catch { return fail('REPORT_RETURN_DENIED'); }
  }

  // Ajudas de verificação para a revisão guiada. Todas são reversíveis com 'reset' e só agem na aba
  // auditada, já provada pela sessão de origem: zoom por aba (não grava preferência do site) e uma
  // folha de estilo de espaçamento inserida e removida pela própria extensão.
  async function applyPageAid({ sessionCapabilityId, auditId, sender, aid } = {}) {
    if (!PAGE_AIDS.has(aid)) return fail('PAGE_AID_DENIED');
    const source = await authorizedSourceBinding({ sessionCapabilityId, auditId, sender });
    if (source.ok !== true) return source.code === 'CONTEXT_DENIED' ? source : fail('PAGE_AID_DENIED');
    const tabs = input.chromeApi.tabs;
    const scripting = input.chromeApi.scripting;
    if (typeof tabs.setZoom !== 'function' || typeof tabs.setZoomSettings !== 'function' ||
      typeof scripting?.insertCSS !== 'function' || typeof scripting.removeCSS !== 'function') {
      return fail('PAGE_AID_UNAVAILABLE');
    }
    // O documento provado pela sessão de origem: se a aba navegou, a folha não cai em outra página.
    const target = { tabId: source.tabId, documentIds: [source.documentId] };
    const state = pageAidState.get(source.tabId) ?? { documentId: source.documentId, priorZoom: null, spacing: false };
    if (state.documentId !== source.documentId) { state.documentId = source.documentId; state.priorZoom = null; state.spacing = false; }
    try {
      await focusSource(source);
      if (aid === 'zoom-200' || aid === 'reflow-320') {
        if (state.priorZoom === null && typeof tabs.getZoom === 'function') {
          try { state.priorZoom = await tabs.getZoom(source.tabId); } catch { state.priorZoom = 0; }
        }
        if (state.priorZoom === null) state.priorZoom = 0;
        await tabs.setZoomSettings(source.tabId, { mode: 'automatic', scope: 'per-tab' });
        let factor = 2;
        if (aid === 'reflow-320') {
          const tab = await tabs.get(source.tabId);
          const width = Number.isFinite(tab?.width) && tab.width > 0 ? tab.width : 1280;
          // WCAG 1.4.10: 320 px CSS equivalem a 400% de zoom numa janela de 1280 px.
          factor = Math.min(5, Math.max(1, width / 320));
        }
        await tabs.setZoom(source.tabId, factor);
        pageAidState.set(source.tabId, state);
        return freeze({ ok: true, aid, state: 'applied', zoomPercent: Math.round(factor * 100) });
      }
      if (aid === 'text-spacing') {
        if (!state.spacing) await scripting.insertCSS({ target, css: TEXT_SPACING_CSS, origin: 'USER' });
        state.spacing = true;
        pageAidState.set(source.tabId, state);
        return freeze({ ok: true, aid, state: 'applied', zoomPercent: null });
      }
      if (state.spacing) {
        try { await scripting.removeCSS({ target, css: TEXT_SPACING_CSS, origin: 'USER' }); } catch { /* documento já mudou */ }
      }
      // Só mexe no zoom se uma ajuda o alterou, e devolve exatamente o fator que a pessoa usava.
      if (state.priorZoom !== null) await tabs.setZoom(source.tabId, state.priorZoom);
      pageAidState.delete(source.tabId);
      return freeze({ ok: true, aid, state: 'reset', zoomPercent: null });
    } catch { return fail('PAGE_AID_FAILED'); }
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

  async function deletionGraph(auditId) {
    const inventory = await input.sessionArea.get(null);
    const root = exact(inventory, Reflect.ownKeys(inventory));
    if (!root) throw new Error('REPORT_CLEANUP_DENIED');
    const rows = new Map();
    const targets = new Map();
    const addTarget = row => {
      let target = targets.get(row.tabId);
      if (!target) {
        target = { tabId: row.tabId, windowId: row.windowId, documents: new Set(), launch: null };
        targets.set(row.tabId, target);
      }
      if (target.windowId !== row.windowId) throw new Error('REPORT_CLEANUP_DENIED');
      if (row.documentId !== null) target.documents.add(row.documentId);
      return target;
    };
    for (const [key, value] of Object.entries(root)) {
      if (key === launchKey(auditId)) {
        const launch = launchRecord(value);
        if (!launch || launch.auditId !== auditId) throw new Error('REPORT_CLEANUP_DENIED');
        rows.set(key, launch); addTarget(launch).launch = launch;
      } else if (key.startsWith('audita:report-launch:v1:') && ownDataDescriptor(value, 'auditId')?.value === auditId) {
        throw new Error('REPORT_CLEANUP_DENIED');
      } else if (key.startsWith('audita:report-consumer:v1:') && ownDataDescriptor(value, 'auditId')?.value === auditId) {
        const consumer = consumerRecord(value);
        if (!consumer || key !== consumerKey(consumer.sessionCapabilityId)) throw new Error('REPORT_CLEANUP_DENIED');
        rows.set(key, consumer); addTarget(consumer);
      } else if (key.startsWith('audita:report-launch-tab:v1:') && value === auditId) {
        const tabId = Number(key.slice('audita:report-launch-tab:v1:'.length));
        if (!safeId(tabId) || key !== indexKey(tabId)) throw new Error('REPORT_CLEANUP_DENIED');
        rows.set(key, value);
      }
    }
    for (const target of targets.values()) {
      const key = indexKey(target.tabId);
      if (Object.hasOwn(root, key) && root[key] !== auditId) throw new Error('REPORT_CLEANUP_DENIED');
      rows.set(key, root[key]);
    }
    return { rows, targets: [...targets.values()].sort((left, right) => left.tabId - right.tabId) };
  }

  async function deletionRowsMatch(rows) {
    const inventory = await input.sessionArea.get([...rows.keys()]);
    const root = exact(inventory, Reflect.ownKeys(inventory));
    if (!root || Object.keys(root).some(key => !rows.has(key))) return false;
    for (const [key, expected] of rows) {
      if (expected === undefined) { if (Object.hasOwn(root, key)) return false; }
      else if (typeof expected === 'string') { if (root[key] !== expected) return false; }
      else {
        const actual = exact(root[key], Object.keys(expected));
        if (!actual || JSON.stringify(actual) !== JSON.stringify(expected)) return false;
      }
    }
    return true;
  }

  async function replaceDeletionRows(rows, replacements) {
    if (!await deletionRowsMatch(rows)) return false;
    if (Object.keys(replacements).length > 0) {
      try { await input.sessionArea.set(replacements); } catch { /* readback resolves an ambiguous write */ }
      for (const [key, value] of Object.entries(replacements)) rows.set(key, value);
    }
    return deletionRowsMatch(rows);
  }

  async function tabAbsenceConfirmed(tabId) {
    if (typeof input.chromeApi.tabs.query !== 'function') return false;
    const tabs = await input.chromeApi.tabs.query({});
    if (!Array.isArray(tabs)) return false;
    for (const tab of tabs) {
      const id = ownDataDescriptor(tab, 'id');
      if (!id || !safeId(id.value) || id.value === tabId) return false;
    }
    return true;
  }

  async function deletionDocumentProof(target, auditId) {
    let tab;
    try { tab = tabSnapshot(await input.chromeApi.tabs.get(target.tabId)); }
    catch { return await tabAbsenceConfirmed(target.tabId) ? { absent: true } : null; }
    const expectedUrl = canonicalUrl(input.chromeApi, auditId);
    if (!exactConnectedTab(tab, target, expectedUrl)) return null;
    const contexts = await input.chromeApi.runtime.getContexts({ tabIds: [target.tabId], contextTypes: ['TAB'] });
    if (!Array.isArray(contexts) || contexts.length !== 1) return null;
    const context = contexts[0];
    if (context?.contextType !== 'TAB' || context.tabId !== target.tabId || context.windowId !== target.windowId ||
      context.documentUrl !== expectedUrl || typeof context.documentId !== 'string' || !context.documentId) return null;
    if (!target.documents.has(context.documentId) && target.launch?.documentId !== null) return null;
    const stableTab = tabSnapshot(await input.chromeApi.tabs.get(target.tabId));
    if (!exactConnectedTab(stableTab, target, expectedUrl)) return null;
    return { absent: false, documentId: context.documentId };
  }

  async function clearAudit(auditId) {
    try { canonicalAuditId(auditId); } catch { return false; }
    return serialize(input.sessionArea, auditId, async () => {
      try {
        if (typeof input.sessionArea.remove !== 'function') return false;
        const { rows, targets } = await deletionGraph(auditId);
        if (rows.size === 0) return true;
        const revoked = {};
        for (const [key, value] of rows) {
          if (value && typeof value === 'object' && value.state !== 'revoked') revoked[key] = freeze({ ...value, state: 'revoked' });
        }
        if (!await replaceDeletionRows(rows, revoked)) return false;
        for (const target of targets) {
          let proof = await deletionDocumentProof(target, auditId);
          if (!proof) return false;
          if (!proof.absent && target.launch?.documentId === null) {
            const key = launchKey(auditId);
            const bound = freeze({ ...rows.get(key), documentId: proof.documentId });
            if (!await replaceDeletionRows(rows, { [key]: bound })) return false;
            target.launch = bound; target.documents.add(proof.documentId);
          }
          if (!await deletionRowsMatch(rows)) return false;
          if (!proof.absent) {
            proof = await deletionDocumentProof(target, auditId);
            if (!proof) return false;
            if (!proof.absent) {
              try { await input.chromeApi.tabs.remove(target.tabId); } catch { /* only confirmed absence allows cleanup */ }
              if (!await tabAbsenceConfirmed(target.tabId)) return false;
            }
          }
        }
        if (!await deletionRowsMatch(rows)) return false;
        const keys = [...rows].filter(([, value]) => value !== undefined).map(([key]) => key);
        try { await input.sessionArea.remove(keys); } catch { /* verify even when removal reports failure */ }
        return deletionRowsMatch(new Map([...rows.keys()].map(key => [key, undefined])));
      } catch { return false; }
    });
  }

  async function handleTabRemoved(tabId) {
    const auditId = safeId(tabId) ? await auditIdForTab(tabId) : null; if (!auditId) return false;
    return serialize(input.sessionArea, auditId, async () => {
      const launch = await getLaunch(auditId);
      if (!launch || launch.tabId !== tabId) return false;
      await revokeLaunch(launch);
      return true;
    });
  }
  async function handleWindowRemoved(windowId) {
    if (!safeId(windowId)) return false;
    const envelope = await input.sessionArea.get(null); let changed = false;
    for (const [key, value] of Object.entries(envelope ?? {})) {
      const launch = key.startsWith('audita:report-launch:v1:') ? launchRecord(value) : null;
      if (launch?.windowId === windowId && launch.state !== 'revoked') {
        const revoked = await serialize(input.sessionArea, launch.auditId, async () => {
          const current = await getLaunch(launch.auditId);
          if (!current || current.windowId !== windowId || current.tabId !== launch.tabId ||
            current.issuedAt !== launch.issuedAt || current.state === 'revoked') return false;
          await revokeLaunch(current);
          return true;
        });
        changed = revoked || changed;
      }
    }
    return changed;
  }

  return freeze({
    openRegisteredReport, connect, authorizeIntent, authorizeExport, returnToSource, applyPageAid,
    validateConsumer, getLaunch, getConsumer,
    handleTabUpdated, handleTabRemoved, handleWindowRemoved,
    clearAudit,
  });
}
