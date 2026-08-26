import { createAuditSession } from './session.js';
import { normalizeAuditUrl } from '../core/url.js';

export function registerServiceWorker(chromeApi, options = {}) {
  if (!chromeApi?.action?.onClicked || !chromeApi?.runtime?.onMessage || !chromeApi?.tabs?.create) {
    throw new TypeError('As APIs Chrome necessárias não estão disponíveis.');
  }
  const sessions = options.sessions ?? new Map();
  const createId = options.createId ?? (() => crypto.randomUUID());
  const now = options.now ?? (() => new Date().toISOString());

  chromeApi.action.onClicked.addListener(() => chromeApi.tabs.create({
    url: chromeApi.runtime.getURL('src/panel/index.html'),
  }));

  chromeApi.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.type !== 'START_AUDIT') return false;
    try {
      const requestedUrl = normalizeAuditUrl(message.url);
      const auditId = createId();
      const session = createAuditSession({ id: auditId, requestedUrl, startedAt: now() });
      sessions.set(auditId, session);
      sendResponse({ ok: true, auditId, state: session.state });
    } catch (error) {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : 'Não foi possível preparar a auditoria.' });
    }
    return true;
  });

  return sessions;
}

if (typeof chrome !== 'undefined') {
  registerServiceWorker(chrome);
}
