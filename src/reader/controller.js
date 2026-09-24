import { tabReadingPageCommand } from './page-inspector.js';
import { createReadingReport, attachReadingVisuals } from './report-model.js';
import { captureReadingVisuals } from './visual-capture.js';
import { targetOperationLockName } from '../background/target-operation-queue.js';

const TOKEN = /^[A-Za-z0-9_-]{43}$/u;
const PREFIX = 'audita.reading-launch.';
const TTL = 10 * 60 * 1000;
const ACTIVE_PREFIX = 'audita.reading-active.';
const failure = () => new Error('A página mudou ou a sessão expirou. Abra a conferência novamente pelo painel.');
const busyFailure = () => Object.assign(new Error('Auditoria em andamento.'), { code: 'AUDIT_BUSY' });
function httpTab(tab) {
  if (!Number.isSafeInteger(tab?.id) || tab.id < 0 || tab.pendingUrl || tab.status === 'loading') throw failure();
  const url = new URL(tab.url);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw failure();
  return tab;
}
function newToken() {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

export async function openReadingReport(api, { token = newToken(), now = Date.now() } = {}) {
  if (!TOKEN.test(token)) throw failure();
  const tabs = await api.tabs.query({ active: true, currentWindow: true });
  if (tabs.length !== 1) throw failure();
  const tab = httpTab(tabs[0]);
  const loaded = await api.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, world: 'ISOLATED', files: ['src/core/accessibility/accessible-preview-runtime.classic.js'] });
  if (loaded.length !== 1 || typeof loaded[0].documentId !== 'string' || !loaded[0].documentId ||
    httpTab(await api.tabs.get(tab.id)).url !== tab.url) throw failure();
  const key = PREFIX + token;
  await api.storage.session.set({ [key]: { tabId: tab.id, documentId: loaded[0].documentId, expiresAt: now + TTL } });
  try { return await api.tabs.create({ url: api.runtime.getURL(`src/reader/index.html?launch=${token}`) }); }
  catch (error) { await api.storage.session.remove(key); throw error; }
}

export async function consumeReadingLaunch(api, href, now = Date.now(), { lockManager = globalThis.navigator?.locks } = {}) {
  const url = new URL(href);
  const expected = new URL(api.runtime.getURL('src/reader/index.html'));
  const token = url.searchParams.get('launch');
  if (url.origin !== expected.origin || url.hostname !== expected.hostname || url.protocol !== expected.protocol ||
    url.pathname !== expected.pathname || url.hash || url.searchParams.size !== 1 || !TOKEN.test(token ?? '')) throw failure();
  if (typeof lockManager?.request !== 'function') throw failure();
  const key = PREFIX + token;
  // Storage get/remove is not atomic: duplicate report tabs must share this lock
  // so exactly one document can claim the capability, including across contexts.
  return lockManager.request(`audita:reading-launch:v1:${token}`, { mode: 'exclusive' }, async lock => {
    if (!lock) throw failure();
    const record = (await api.storage.session.get(key))[key];
    await api.storage.session.remove(key);
    if (!record || !Number.isSafeInteger(record.tabId) || record.tabId < 0 || typeof record.documentId !== 'string' ||
      !record.documentId || record.documentId.length > 512 || !Number.isFinite(record.expiresAt) ||
      record.expiresAt <= now || record.expiresAt > now + TTL) throw failure();
    return { tabId: record.tabId, documentId: record.documentId, sessionId: token };
  });
}

export function createReadingController(api, { tabId, documentId, sessionId }, { lockManager = globalThis.navigator?.locks } = {}) {
  const lockName = targetOperationLockName({ tabId, documentId });
  const activeKey = ACTIVE_PREFIX + tabId;
  let sourceUrl = null;
  let report = null;
  let busy = false;
  let expiresAt = 0;
  const withLock = operation => {
    if (typeof lockManager?.request !== 'function') throw failure();
    return lockManager.request(lockName, { mode: 'exclusive', ifAvailable: true }, async lock => {
      if (!lock) throw busyFailure();
      const states = await api.storage.session.get(['audita:active-audit-job:v1', 'audita:start-journal:v1']);
      if (states['audita:active-audit-job:v1'] || states['audita:start-journal:v1']) throw busyFailure();
      return operation();
    });
  };
  const execute = async command => {
    const results = await api.scripting.executeScript({ target: { tabId, documentIds: [documentId] }, world: 'ISOLATED', func: tabReadingPageCommand, args: [{ ...command, sessionId }] });
    if (results.length !== 1 || results[0].documentId !== documentId) throw failure();
    return results[0].result;
  };
  const current = async () => {
    const tab = httpTab(await api.tabs.get(tabId));
    if (tab.url !== sourceUrl || Date.now() >= expiresAt) throw failure();
    return tab;
  };
  async function collect() {
    if (busy) throw failure();
    busy = true;
    try { return await withLock(async () => {
      const tab = httpTab(await api.tabs.get(tabId));
      // A refresh stays attached to the original document. New navigation requires
      // another explicit launch from the panel, rather than silently changing pages.
      if (sourceUrl !== null && tab.url !== sourceUrl) throw failure();
      sourceUrl = tab.url;
      expiresAt = Date.now() + TTL;
      await current();
      // The same native Web Lock is held by the worker throughout an audit.
      // The cleanup barrier can revoke this record before collecting any pixels.
      await api.storage.session.set({ [activeKey]: { documentId, sessionId, expiresAt } });
      const raw = await execute({ type: 'collect' });
      if (raw?.sessionId !== sessionId) throw failure();
      let built = createReadingReport(raw, { origin: new URL(sourceUrl).origin });
      try {
        const visuals = await captureReadingVisuals(api, { tabId, entries: built.entries });
        built = attachReadingVisuals(built, visuals);
      } catch {
        built = attachReadingVisuals(built, { elementImages: {}, fullPage: null, limitations: ['visual-capture-unavailable'] });
      }
      report = built;
      return report;
    }); } finally { busy = false; }
  }
  async function action(type, elementId, extra = {}) {
    if (busy || !report || elementId && !report.entries.some(entry => entry.id === elementId)) throw failure();
    busy = true;
    try { return await withLock(async () => {
      const tab = await current();
      const active = (await api.storage.session.get(activeKey))[activeKey];
      if (active?.documentId !== documentId || active?.sessionId !== sessionId || active.expiresAt <= Date.now()) throw failure();
      const result = await execute({ type, ...(elementId ? { elementId } : {}), ...extra });
      if (result?.reason === 'page-changed') throw Object.assign(failure(), { code: 'PAGE_CHANGED' });
      if (result?.reason === 'walk-escaped') throw Object.assign(new Error('Percurso encerrado com Escape.'), { code: 'WALK_ESCAPED' });
      if (result?.ok !== true || result.sessionId !== sessionId) throw failure();
      if (type !== 'clear') {
        await api.tabs.update(tabId, { active: true });
        if (Number.isSafeInteger(tab.windowId)) await api.windows.update(tab.windowId, { focused: true });
      }
      return result;
    }); } finally { busy = false; }
  }
  // walkEscapes: no percurso guiado, número de Escape já vistos na página; um Escape posterior encerra o percurso.
  const highlight = (id, { walkEscapes } = {}) => action('highlight', id,
    Number.isSafeInteger(walkEscapes) && walkEscapes >= 0 ? { walkEscapes } : {});
  return { collect, highlight, observe: () => action('observe'), clear: () => action('clear') };
}
