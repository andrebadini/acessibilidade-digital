import { normalizeAuditUrl } from '../core/url.js';
import { sanitizeResourceUrl } from '../core/normalize-snapshot.js';

export const CONTEXT_MENU_IDS = Object.freeze({
  page: 'audita.accessibility.audit-page',
  link: 'audita.accessibility.audit-link',
});

const WEB_PATTERNS = Object.freeze(['http://*/*', 'https://*/*']);

export const CONTEXT_MENU_ITEMS = Object.freeze([
  Object.freeze({
    id: CONTEXT_MENU_IDS.page,
    title: 'Auditar esta página com Audita Acessibilidade',
    contexts: Object.freeze(['page']),
    documentUrlPatterns: WEB_PATTERNS,
  }),
  Object.freeze({
    id: CONTEXT_MENU_IDS.link,
    title: 'Auditar este link com Audita Acessibilidade',
    contexts: Object.freeze(['link']),
    documentUrlPatterns: WEB_PATTERNS,
    targetUrlPatterns: WEB_PATTERNS,
  }),
]);

const INFO_KEYS = new Set([
  'button', 'checked', 'editable', 'frameId', 'frameUrl', 'linkUrl', 'mediaType',
  'menuItemId', 'modifiers', 'pageUrl', 'parentMenuItemId', 'selectionText', 'srcUrl',
  'wasChecked',
]);
const ACK_TYPES = new Set(['CONTEXT_PREFILL_ACK', 'CONTEXT_PREFILL_COMMIT_ACK']);
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/u;
const DOCUMENT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/u;
const FIXED_REGISTRATION_ERROR = 'Não foi possível registrar os atalhos do menu de contexto.';
const FIXED_START_ERROR = 'Não foi possível iniciar a auditoria pelo menu de contexto.';

export function parseContextMenuClick(info, tab) {
  const clicked = copyDataRecord(info, INFO_KEYS, true);
  const source = copyDataRecord(tab, null, false);
  // ClickInFrame do Chromium envia 0 explicitamente no documento superior; ausência falha fechada.
  if (!clicked || !source || !safeInteger(source.id) || typeof source.url !== 'string' ||
    !safeInteger(clicked.frameId)) return null;
  const frameId = clicked.frameId;
  const sourceUrl = strictHttpUrl(source.url);
  const pageUrl = strictHttpUrl(clicked.pageUrl);
  if (!sourceUrl || !pageUrl || withoutFragment(sourceUrl) !== withoutFragment(pageUrl)) return null;

  if (clicked.menuItemId === CONTEXT_MENU_IDS.page) {
    if (frameId !== 0) return null;
    return { kind: 'page', sourceTabId: source.id, sourceUrl, auditUrl: pageUrl, frameId: 0 };
  }
  if (clicked.menuItemId !== CONTEXT_MENU_IDS.link) return null;
  const linkUrl = strictHttpUrl(clicked.linkUrl);
  if (!linkUrl) return null;
  if (frameId > 0) {
    if (!strictHttpUrl(clicked.frameUrl)) return null;
  } else if (clicked.frameUrl !== undefined) {
    const frameUrl = strictHttpUrl(clicked.frameUrl);
    if (!frameUrl || withoutFragment(frameUrl) !== withoutFragment(pageUrl)) return null;
  }
  return {
    kind: 'link', sourceTabId: source.id, sourceUrl,
    auditUrl: linkUrl, frameId,
  };
}

export function registerAuditContextMenus(chromeApi, options = {}) {
  if (!chromeApi?.runtime?.onInstalled?.addListener || !chromeApi?.contextMenus?.onClicked?.addListener ||
    typeof chromeApi.contextMenus.removeAll !== 'function' || typeof chromeApi.contextMenus.create !== 'function' ||
    typeof chromeApi.runtime.sendMessage !== 'function' || typeof chromeApi.runtime.getURL !== 'function' ||
    typeof chromeApi.tabs?.get !== 'function') {
    throw new TypeError('APIs Chrome insuficientes para o menu de contexto.');
  }
  const logger = options.logger ?? { error() {} };
  const openPanel = options.openPanel;
  const issueBindingLease = options.issueBindingLease;
  const consumeBindingLease = options.consumeBindingLease;
  const beginSingleAudit = options.beginSingleAudit;
  if (typeof openPanel !== 'function' || typeof issueBindingLease !== 'function' ||
    typeof consumeBindingLease !== 'function' || typeof beginSingleAudit !== 'function') {
    throw new TypeError('Dependências do menu de contexto indisponíveis.');
  }
  const createRequestId = options.createRequestId ?? (() => crypto.randomUUID());
  const timeoutMs = Number.isFinite(options.prefillTimeoutMs) ? options.prefillTimeoutMs : 2_000;
  const apiCallbackTimeoutMs = Number.isFinite(options.apiCallbackTimeoutMs) ? options.apiCallbackTimeoutMs : 2_000;
  const decisionTimeoutMs = Number.isFinite(options.decisionTimeoutMs) ? options.decisionTimeoutMs : 4_000;
  const activeSources = new Set();
  const pendingPrefills = new Map();
  const pendingCommits = new Map();
  const seenProtocolRequests = new Set();
  let installQueue = Promise.resolve();

  const installedListener = () => { void installMenus(); };
  const clickedListener = (info, tab) => {
    const admission = parseContextMenuClick(info, tab);
    if (!admission || activeSources.has(admission.sourceTabId)) return;
    activeSources.add(admission.sourceTabId);
    void executeClick(admission)
      .catch(() => logger.error(FIXED_START_ERROR))
      .finally(() => activeSources.delete(admission.sourceTabId));
  };
  chromeApi.runtime.onInstalled.addListener(installedListener);
  chromeApi.contextMenus.onClicked.addListener(clickedListener);

  return Object.freeze({
    installMenus,
    handlePanelProtocolMessage,
    isSourceActive(tabId) { return activeSources.has(tabId); },
  });

  function installMenus() {
    const operation = installQueue.catch(() => false).then(installOnce);
    installQueue = operation;
    return operation;
  }

  async function installOnce() {
    try {
      await invokeChromeCallback(chromeApi, chromeApi.contextMenus, 'removeAll', [], apiCallbackTimeoutMs);
      for (const item of CONTEXT_MENU_ITEMS) {
        await invokeChromeCallback(chromeApi, chromeApi.contextMenus, 'create', [cloneMenuItem(item)], apiCallbackTimeoutMs);
      }
      return true;
    } catch {
      try { await invokeChromeCallback(chromeApi, chromeApi.contextMenus, 'removeAll', [], apiCallbackTimeoutMs); } catch { /* rollback best-effort */ }
      logger.error(FIXED_REGISTRATION_ERROR);
      return false;
    }
  }

  async function executeClick(admission) {
    let acceptedAck = null;
    let decisionDeadline = null;
    try {
      const source = await requireSourceTab(admission, admission.sourceUrl);
      const opened = await openPanel({ sourceTab: { id: source.id, url: source.url } });
      const panelId = copySafeTabId(opened);
      if (panelId === null) throw new Error('Painel inválido.');
      await requirePanelTab(panelId);
      await requireSourceTab(admission, source.url);

      const requestId = createRequestId();
      if (!validIdentifier(requestId) || seenProtocolRequests.has(requestId)) throw new Error('Correlação inválida.');
      seenProtocolRequests.add(requestId);
      trimSet(seenProtocolRequests, 256);
      const sanitizedUrl = sanitizeResourceUrl(admission.auditUrl);
      if (!sanitizedUrl) throw new Error('Representação pública inválida.');
      acceptedAck = await requestPrefill({
        type: 'AUDIT_CONTEXT_PREFILL', requestId, panelTabId: panelId,
        prefill: { kind: admission.kind, url: sanitizedUrl, autoStarted: true },
      });
      if (!acceptedAck.accepted) throw new Error('Painel ocupado.');

      decisionDeadline = createDecisionDeadline(decisionTimeoutMs);
      await decisionDeadline.wait(Promise.all([
        requireSourceTab(admission, source.url),
        requirePanelTab(panelId),
      ]));
      await decisionDeadline.wait(requestCommit(requestId, panelId, acceptedAck.documentId));
      const bindingLease = await decisionDeadline.wait(issueBindingLease({
        panelTabId: panelId,
        targetTabId: admission.sourceTabId,
        sourceUrl: source.url,
        panelDocumentId: acceptedAck.documentId,
      }));
      decisionDeadline.assertActive();
      if (!bindingLease || typeof bindingLease !== 'object') throw new Error('Vínculo do painel inválido.');
      // A prova final, presa ao documentId do ACK, é o último await; consumo e início seguem no mesmo microtask.
      if (consumeBindingLease(bindingLease) !== true) throw new Error('Vínculo do painel alterado.');
      const started = beginSingleAudit({
        navigationUrl: admission.auditUrl,
        senderKey: `panel-tab:${panelId}`,
      });
      if (!started || !started.response || started.response.ok !== true ||
        !started.completion || typeof started.completion.then !== 'function') {
        throw new Error('Início não confirmado.');
      }
      decisionDeadline.clear();
      decisionDeadline = null;
      acceptedAck.respond(started.response);
      await started.completion;
    } catch (error) {
      acceptedAck?.respond({ ok: false, error: FIXED_START_ERROR });
      throw error;
    } finally {
      decisionDeadline?.clear();
    }
  }

  function requestPrefill(message) {
    return requestProtocol(pendingPrefills, message.requestId, {
      panelTabId: message.panelTabId,
      expectedDocumentId: null,
    }, message);
  }

  function requestCommit(requestId, panelTabId, documentId) {
    return requestProtocol(pendingCommits, requestId, {
      panelTabId,
      expectedDocumentId: documentId,
    }, { type: 'AUDIT_CONTEXT_PREFILL_COMMIT', requestId, panelTabId });
  }

  function requestProtocol(store, requestId, correlation, message) {
    if (store.has(requestId)) return Promise.reject(new Error('Correlação já pendente.'));
    return new Promise((resolve, reject) => {
      const pending = { ...correlation, resolve, reject, timer: null };
      pending.timer = setTimeout(() => {
        if (store.get(requestId) !== pending) return;
        store.delete(requestId);
        reject(new Error('ACK do painel não recebido.'));
      }, Math.max(1, timeoutMs));
      store.set(requestId, pending);
      try { sendOneWay(chromeApi, message); }
      catch (error) {
        clearTimeout(pending.timer);
        store.delete(requestId);
        reject(error);
      }
    });
  }

  function handlePanelProtocolMessage(message, sender, sendResponse) {
    const declaredType = dataProperty(message, 'type');
    if (!ACK_TYPES.has(declaredType)) return false;
    const parsed = parseAckEnvelope(message);
    if (!parsed) {
      safeRespond(sendResponse, { ok: false, error: 'ACK de painel não correlacionado.' });
      return true;
    }
    const store = parsed.type === 'CONTEXT_PREFILL_ACK' ? pendingPrefills : pendingCommits;
    const pending = store.get(parsed.requestId);
    const panelSender = parsePanelSender(sender, chromeApi.runtime.id);
    const correlated = Boolean(pending && panelSender && parsed.panelTabId === pending.panelTabId &&
      panelSender.panelTabId === pending.panelTabId &&
      (pending.expectedDocumentId === null || panelSender.documentId === pending.expectedDocumentId));
    if (!correlated) {
      safeRespond(sendResponse, { ok: false, error: 'ACK de painel não correlacionado.' });
      return true;
    }
    store.delete(parsed.requestId);
    clearTimeout(pending.timer);
    if (parsed.type === 'CONTEXT_PREFILL_ACK') {
      let responded = false;
      pending.resolve({
        accepted: parsed.accepted,
        documentId: panelSender.documentId,
        respond(value) {
          if (responded) return false;
          responded = true;
          safeRespond(sendResponse, value);
          return true;
        },
      });
    } else {
      safeRespond(sendResponse, { ok: parsed.accepted });
      if (parsed.accepted) pending.resolve(true);
      else pending.reject(new Error('Confirmação do painel recusada.'));
    }
    return true;
  }

  async function requireSourceTab(admission, exactUrl) {
    const tab = await chromeApi.tabs.get(admission.sourceTabId);
    const parsed = copyDataRecord(tab, null, false);
    if (!parsed || parsed.id !== admission.sourceTabId || parsed.status !== 'complete') throw new Error('Aba de origem indisponível.');
    const url = strictHttpUrl(parsed.url);
    if (!url || (typeof parsed.pendingUrl === 'string' && parsed.pendingUrl !== '') ||
      (exactUrl ? url !== exactUrl : withoutFragment(url) !== withoutFragment(admission.sourceUrl))) {
      throw new Error('Aba de origem alterada.');
    }
    return { id: parsed.id, url };
  }

  async function requirePanelTab(panelTabId) {
    const tab = await chromeApi.tabs.get(panelTabId);
    const parsed = copyDataRecord(tab, null, false);
    const expectedUrl = chromeApi.runtime.getURL('src/panel/index.html');
    if (!parsed || parsed.id !== panelTabId || parsed.status !== 'complete' || parsed.url !== expectedUrl ||
      (typeof parsed.pendingUrl === 'string' && parsed.pendingUrl !== '')) {
      throw new Error('Painel alterado.');
    }
    return { id: panelTabId, url: expectedUrl };
  }
}

function dataProperty(value, key) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  let descriptor;
  try { descriptor = Object.getOwnPropertyDescriptor(value, key); } catch { return null; }
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : null;
}

function parseAckEnvelope(value) {
  const parsed = copyDataRecord(value, new Set(['accepted', 'panelTabId', 'requestId', 'type']), true);
  if (!parsed || !ACK_TYPES.has(parsed.type) || !validIdentifier(parsed.requestId) ||
    !safeInteger(parsed.panelTabId) || typeof parsed.accepted !== 'boolean') return null;
  return parsed;
}

function parsePanelSender(value, runtimeId) {
  const sender = copyDataRecord(value, null, false);
  if (!sender || sender.id !== runtimeId || sender.frameId !== 0 || !validDocumentId(sender.documentId) ||
    sender.url !== `chrome-extension://${runtimeId}/src/panel/index.html`) return null;
  const tab = copyDataRecord(sender.tab, null, false);
  if (!tab || !safeInteger(tab.id)) return null;
  return { panelTabId: tab.id, documentId: sender.documentId };
}

function copySafeTabId(value) {
  const tab = copyDataRecord(value, null, false);
  return tab && safeInteger(tab.id) ? tab.id : null;
}

function copyDataRecord(value, allowedKeys = null, exact = false) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  let descriptors;
  try { descriptors = Object.getOwnPropertyDescriptors(value); } catch { return null; }
  if (Object.values(descriptors).some(descriptor => !Object.hasOwn(descriptor, 'value'))) return null;
  const keys = Object.keys(descriptors);
  if (allowedKeys && exact && keys.some(key => !allowedKeys.has(key))) return null;
  return Object.fromEntries(keys
    .filter(key => !allowedKeys || allowedKeys.has(key))
    .map(key => [key, descriptors[key].value]));
}

function strictHttpUrl(value) {
  if (typeof value !== 'string' || value !== value.trim() || value.length > 4_096 || !/^https?:\/\//iu.test(value)) return null;
  try { return normalizeAuditUrl(value); } catch { return null; }
}

function withoutFragment(value) {
  const url = new URL(value);
  url.hash = '';
  return url.href;
}

function safeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validIdentifier(value) {
  return typeof value === 'string' && REQUEST_ID_PATTERN.test(value);
}

function validDocumentId(value) {
  return typeof value === 'string' && DOCUMENT_ID_PATTERN.test(value);
}

function cloneMenuItem(item) {
  return Object.fromEntries(Object.entries(item).map(([key, value]) => [key, Array.isArray(value) ? [...value] : value]));
}

function invokeChromeCallback(chromeApi, owner, method, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(reject, new Error('A API do navegador não respondeu.')), Math.max(1, timeoutMs));
    const finish = (handler, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      handler(value);
    };
    const callback = value => {
      const runtimeError = chromeApi.runtime?.lastError;
      if (runtimeError) finish(reject, new Error('A API do navegador recusou a operação.'));
      else finish(resolve, value);
    };
    try {
      const result = owner[method](...args, callback);
      if (result && typeof result.then === 'function') {
        result.catch(() => {});
      }
    } catch {
      finish(reject, new Error('A API do navegador recusou a operação.'));
    }
  });
}

function sendOneWay(chromeApi, message) {
  const result = chromeApi.runtime.sendMessage(message, () => { void chromeApi.runtime.lastError; });
  if (result && typeof result.catch === 'function') result.catch(() => {});
}

function safeRespond(sendResponse, value) {
  try { sendResponse?.(value); } catch { /* documento receptor pode ter sido encerrado */ }
}

function trimSet(values, maximum) {
  while (values.size > maximum) values.delete(values.values().next().value);
}

function createDecisionDeadline(timeoutMs) {
  const duration = Math.max(1, timeoutMs);
  const expiresAt = Date.now() + duration;
  let expired = false;
  let rejectDeadline;
  const deadline = new Promise((_, reject) => { rejectDeadline = reject; });
  const timer = setTimeout(() => {
    expired = true;
    rejectDeadline(new Error('Prazo da decisão do menu de contexto expirado.'));
  }, duration);
  return {
    wait(operation) { return Promise.race([Promise.resolve(operation), deadline]); },
    assertActive() {
      if (expired || Date.now() >= expiresAt) throw new Error('Prazo da decisão do menu de contexto expirado.');
    },
    clear() { clearTimeout(timer); },
  };
}
