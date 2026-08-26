import { createAuditSession } from './session.js';
import { normalizeAuditUrl } from '../core/url.js';

const PANEL_PATH = '/src/panel/index.html';
const sessionKey = (id) => `audita-mt:session:${id}`;

export function isAuthorizedPanelSender(sender, runtimeId) {
  if (!sender || sender.id !== runtimeId || typeof sender.url !== 'string') return false;
  try {
    const url = new URL(sender.url);
    return url.protocol === 'chrome-extension:'
      && url.hostname === runtimeId
      && url.pathname === PANEL_PATH
      && !url.search
      && !url.hash;
  } catch {
    return false;
  }
}

export function createSessionStore(chromeApi, fallback = new Map()) {
  const storage = chromeApi?.storage?.session ?? chromeApi?.storage?.local;
  if (!storage) {
    return {
      async set(id, value) { fallback.set(id, value); },
      async get(id) { return fallback.get(id); },
    };
  }
  return {
    async set(id, value) { await invokeStorage(chromeApi, storage, 'set', { [sessionKey(id)]: value }); },
    async get(id) {
      const result = await invokeStorage(chromeApi, storage, 'get', sessionKey(id));
      return result?.[sessionKey(id)];
    },
  };
}

export function registerServiceWorker(chromeApi, options = {}) {
  if (!chromeApi?.action?.onClicked || !chromeApi?.runtime?.onMessage || !chromeApi?.tabs?.create) {
    throw new TypeError('As APIs Chrome necessárias não estão disponíveis.');
  }
  const sessions = options.sessionStore ?? createSessionStore(chromeApi, options.sessions);
  const createId = options.createId ?? (() => crypto.randomUUID());
  const now = options.now ?? (() => new Date().toISOString());
  const logger = options.logger ?? console;

  chromeApi.action.onClicked.addListener(() => {
    void Promise.resolve()
      .then(() => chromeApi.tabs.create({ url: chromeApi.runtime.getURL('src/panel/index.html') }))
      .catch(() => logger.error('Não foi possível abrir o painel de auditoria.'));
  });

  chromeApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.type !== 'START_AUDIT') return false;
    if (!isAuthorizedPanelSender(sender, chromeApi.runtime.id)) {
      sendResponse({ ok: false, error: 'Origem da mensagem não autorizada.' });
      return true;
    }
    try {
      const requestedUrl = normalizeAuditUrl(message.url);
      const auditId = createId();
      const session = createAuditSession({ id: auditId, requestedUrl, startedAt: now() });
      void sessions.set(auditId, session)
        .then(() => sendResponse({ ok: true, auditId, state: session.state }))
        .catch(() => sendResponse({ ok: false, error: 'Não foi possível preparar a auditoria.' }));
    } catch (error) {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : 'Não foi possível preparar a auditoria.' });
    }
    return true;
  });

  return sessions;
}

function invokeStorage(chromeApi, storage, method, argument) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (handler, value) => {
      if (settled) return;
      settled = true;
      handler(value);
    };
    try {
      const result = storage[method](argument, (value) => {
        const lastError = chromeApi?.runtime?.lastError;
        if (lastError) finish(reject, new Error(lastError.message || 'Falha no armazenamento da extensão.'));
        else finish(resolve, value);
      });
      if (result && typeof result.then === 'function') result.then((value) => finish(resolve, value), (error) => finish(reject, error));
    } catch (error) {
      finish(reject, error);
    }
  });
}

if (typeof chrome !== 'undefined') {
  registerServiceWorker(chrome);
}
