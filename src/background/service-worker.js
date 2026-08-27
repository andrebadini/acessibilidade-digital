import { createAuditSession } from './session.js';
import { normalizeAuditUrl } from '../core/url.js';
import { createChromeAdapter } from './chrome-adapter.js';
import { runAudit } from './run-audit.js';
import { createAuditStore } from '../storage/audit-store.js';
import { sanitizeResourceUrl } from '../core/normalize-snapshot.js';
import { createExportFailureRequest, persistExportFailure } from '../export/export-controller.js';

const PANEL_PATH = '/src/panel/index.html';
const REVIEW_PATH = '/src/review/index.html';
const EXPORT_PATH = '/src/export/index.html';
const EXPORT_QUEUE_TTL_MS = 2 * 60 * 1000;
const sessionKey = (id) => `audita-mt:session:${id}`;

export function isAuthorizedPanelSender(sender, runtimeId) {
  return isAuthorizedExtensionSender(sender, runtimeId, PANEL_PATH);
}

export function isAuthorizedExtensionSender(sender, runtimeId, requiredPath) {
  if (!sender || sender.id !== runtimeId || typeof sender.url !== 'string') return false;
  try {
    const url = new URL(sender.url);
    if (url.protocol !== 'chrome-extension:' || url.hostname !== runtimeId || url.hash) return false;
    const paths = requiredPath ? [requiredPath] : [PANEL_PATH, REVIEW_PATH, EXPORT_PATH];
    if (!paths.includes(url.pathname)) return false;
    if (url.pathname === PANEL_PATH) return !url.search;
    if (!url.search) return url.pathname === REVIEW_PATH;
    if ([...url.searchParams.keys()].length !== 1 || !url.searchParams.has('auditId')) return false;
    return validAuditId(url.searchParams.get('auditId'));
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
  const logger = options.logger ?? { error() {} };
  const runner = options.runner ?? runAudit;
  const auditStore = options.auditStore ?? createAuditStore(options.auditStoreOptions);
  const chromeAdapterFactory = options.chromeAdapterFactory ?? createChromeAdapter;
  const activeBySender = new Map();
  const activeExports = new Map();

  chromeApi.action.onClicked.addListener(() => {
    void Promise.resolve()
      .then(() => chromeApi.tabs.create({ url: chromeApi.runtime.getURL('src/panel/index.html') }))
      .catch(() => logger.error('Não foi possível abrir o painel de auditoria.'));
  });

  chromeApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const knownTypes = ['START_AUDIT', 'GET_LAST_AUDIT', 'REQUEST_EXPORT', 'EXPORT_PROGRESS', 'EXPORT_COMPLETE', 'EXPORT_FAILED'];
    if (!message || !knownTypes.includes(message.type)) return false;
    if (!isAuthorizedExtensionSender(sender, chromeApi.runtime.id)) {
      sendResponse({ ok: false, error: 'Origem da mensagem não autorizada.' });
      return true;
    }
    if (message.type === 'START_AUDIT' && !isAuthorizedPanelSender(sender, chromeApi.runtime.id)) {
      sendResponse({ ok: false, error: 'Origem da mensagem não autorizada.' });
      return true;
    }
    if (message.type.startsWith('EXPORT_')) {
      if (new URL(sender.url).pathname !== EXPORT_PATH || !validAuditId(message.auditId)
        || new URL(sender.url).searchParams.get('auditId') !== message.auditId) {
        sendResponse({ ok: false, error: 'Exportação não correlacionada.' });
      } else sendResponse({ ok: true });
      return true;
    }
    if (message.type === 'REQUEST_EXPORT') {
      const senderUrl = new URL(sender.url);
      const reviewMismatch = senderUrl.pathname === REVIEW_PATH && senderUrl.searchParams.get('auditId') !== message.auditId;
      if (!validAuditId(message.auditId) || ![PANEL_PATH, REVIEW_PATH].includes(senderUrl.pathname) || reviewMismatch) {
        sendResponse({ ok: false, error: 'Pedido de exportação inválido.' });
        return true;
      }
      if (activeExports.has(message.auditId)) {
        sendResponse({ ok: true, auditId: message.auditId, state: 'queued', duplicate: true });
        return true;
      }
      const queued = queueRequestedExport(message.auditId);
      activeExports.set(message.auditId, queued);
      void queued.then(sendResponse, () => sendResponse({ ok: false, error: 'Não foi possível preparar o relatório.' }))
        .finally(() => { if (activeExports.get(message.auditId) === queued) activeExports.delete(message.auditId); });
      return true;
    }
    if (message.type === 'GET_LAST_AUDIT') {
      void restorableLatestState().then(value => sendResponse({ ok: true, state: value ?? null }), () => sendResponse({ ok: false, error: 'Não foi possível restaurar a última auditoria.' }));
      return true;
    }
    try {
      const requestedUrl = normalizeAuditUrl(message.url);
      const storedUrl = sanitizeResourceUrl(requestedUrl);
      const senderKey = `${sender.id}:${sender.documentId || sender.tab?.id || sender.url}`;
      const existing = activeBySender.get(senderKey);
      if (existing) {
        sendResponse({ ok: true, auditId: existing, state: 'running', duplicate: true });
        return true;
      }
      const auditId = createId();
      const session = createAuditSession({ id: auditId, requestedUrl: storedUrl, startedAt: now() });
      activeBySender.set(senderKey, auditId);
      sendResponse({ ok: true, auditId, state: session.state });
      void runInBackground({ auditId, navigationUrl: requestedUrl, session, senderKey });
    } catch (error) {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : 'Não foi possível preparar a auditoria.' });
    }
    return true;
  });

  return sessions;

  async function runInBackground({ auditId, navigationUrl, session, senderKey }) {
    let committed = false;
    try {
      await sessions.set(auditId, session);
      await auditStore.setLatest({ auditId, status: 'running', percent: 0, message: 'Preparando a auditoria.' });
      const adapter = chromeAdapterFactory(chromeApi);
      const pipelineAdapter = {
        ...adapter,
        async emitProgress(progress) {
          await Promise.allSettled([
            auditStore.setLatest({ auditId, status: 'running', percent: progress.percent, message: progress.message }),
            sendRuntimeMessage(chromeApi, progress),
          ]);
        },
      };
      const model = await runner({ url: navigationUrl, chromeAdapter: pipelineAdapter, now, idFactory: () => auditId, closeAuditTab: true });
      const status = model?.session?.status || 'failed';
      const reviewUrl = model?.report?.reviewUrl || null;
      const canExport = ['complete', 'partial'].includes(status);
      const latestState = { auditId, status, percent: canExport ? 100 : model?.progress?.at?.(-1)?.percent || 0, message: status === 'partial' ? 'Auditoria concluída com limitações.' : status === 'complete' ? 'Auditoria concluída.' : 'A auditoria não pôde ser concluída.', reviewUrl, exportStatus: canExport ? 'queued' : 'unavailable', ...(canExport ? { exportQueuedAt: queueTime() } : {}) };
      await auditStore.commitAudit(auditId, model, latestState);
      committed = true;
      if (canExport) {
        await Promise.allSettled([
          sendRuntimeMessage(chromeApi, { type: 'AUDIT_COMPLETE', auditId, sessionId: auditId, status, reviewUrl, exportStatus: 'queued' }),
          startAutomaticExport(auditId),
        ]);
      } else {
        await sendRuntimeMessage(chromeApi, { type: 'AUDIT_FAILED', auditId, sessionId: auditId, status, error: status === 'cancelled' ? 'A auditoria foi cancelada.' : 'A auditoria não pôde ser concluída.' }).catch(() => {});
      }
    } catch {
      if (!committed) {
        await Promise.allSettled([
          auditStore.setLatest({ auditId, status: 'failed', percent: 0, message: 'A auditoria não pôde ser iniciada.' }),
          sendRuntimeMessage(chromeApi, { type: 'AUDIT_FAILED', auditId, sessionId: auditId, status: 'failed', error: 'A auditoria não pôde ser iniciada.' }),
        ]);
      }
      logger.error('A auditoria em segundo plano falhou de forma controlada.');
    } finally {
      if (activeBySender.get(senderKey) === auditId) activeBySender.delete(senderKey);
    }
  }

  async function queueRequestedExport(auditId) {
    const [snapshot, latest] = await Promise.all([auditStore.getAuditSnapshot(auditId), auditStore.getLatest()]);
    const { model, revision } = snapshot;
    if (!model || !Object.hasOwn(model, 'auditId') || model.auditId !== auditId) return { ok: false, error: 'Auditoria não encontrada.' };
    if (latest?.auditId === auditId && latest.exportRevision === revision &&
      ['queued', 'running', 'delivering'].includes(latest.exportStatus) && queueIsFresh(latest.exportQueuedAt)) {
      return { ok: true, auditId, state: latest.exportStatus, duplicate: true };
    }
    const correlatedLatest = latest?.auditId === auditId ? latest : {};
    await auditStore.setLatest({
      ...correlatedLatest,
      auditId,
      exportStatus: 'queued',
      exportRevision: revision,
      exportQueuedAt: queueTime(),
      message: 'Relatório na fila de geração.',
    });
    try {
      await openExportPage(auditId);
      return { ok: true, auditId, state: 'queued' };
    } catch (error) {
      await persistExportFailure(createExportFailureRequest({
        snapshotCapability: snapshot.capability,
        latest,
        at: queueTime(),
      }), auditStore);
      throw error;
    }
  }

  async function startAutomaticExport(auditId) {
    const [snapshot, latest] = await Promise.all([auditStore.getAuditSnapshot(auditId), auditStore.getLatest()]);
    await auditStore.setLatest({
      ...(latest?.auditId === auditId ? latest : {}),
      auditId,
      exportStatus: 'queued',
      exportRevision: snapshot.revision,
      exportQueuedAt: queueTime(),
      message: 'Relatório na fila de geração.',
    });
    try {
      await openExportPage(auditId);
    } catch {
      const failed = await persistExportFailure(createExportFailureRequest({
        snapshotCapability: snapshot.capability,
        latest,
        at: queueTime(),
      }), auditStore);
      await sendRuntimeMessage(chromeApi, { type: 'EXPORT_FAILED', auditId, status: 'failed', error: failed.latest.message }).catch(() => {});
    }
  }

  async function openExportPage(auditId) {
    return chromeApi.tabs.create({
      url: chromeApi.runtime.getURL(`src/export/index.html?auditId=${encodeURIComponent(auditId)}`),
      active: false,
    });
  }

  function queueTime() {
    const value = now();
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) throw new TypeError('Relógio de exportação inválido.');
    return date.toISOString();
  }

  function queueIsFresh(value) {
    if (typeof value !== 'string') return false;
    try {
      if (new Date(value).toISOString() !== value) return false;
      const age = new Date(queueTime()).getTime() - new Date(value).getTime();
      return age >= 0 && age <= EXPORT_QUEUE_TTL_MS;
    } catch {
      return false;
    }
  }

  async function restorableLatestState() {
    const latest = await auditStore.getLatest();
    if (!latest || !['queued', 'running', 'delivering', 'complete', 'partial'].includes(latest.exportStatus) ||
      typeof auditStore.getAuditSnapshot !== 'function' || !validAuditId(latest.auditId)) return latest;
    const snapshot = await auditStore.getAuditSnapshot(latest.auditId);
    if (latest.exportRevision === snapshot.revision) return latest;
    return {
      ...latest,
      exportStatus: 'failed',
      message: 'A auditoria foi atualizada durante a exportação; gere o relatório novamente.',
    };
  }
}

function validAuditId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,200}$/u.test(value);
}

function sendRuntimeMessage(chromeApi, message) {
  if (typeof chromeApi.runtime?.sendMessage !== 'function') return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (handler, value) => { if (!settled) { settled = true; handler(value); } };
    try {
      const result = chromeApi.runtime.sendMessage(message, value => {
        const error = chromeApi.runtime.lastError;
        if (error) finish(reject, new Error(error.message || 'Falha ao enviar progresso.'));
        else finish(resolve, value);
      });
      if (result && typeof result.then === 'function') result.then(value => finish(resolve, value), error => finish(reject, error));
      else if (chromeApi.runtime.sendMessage.length < 2) finish(resolve);
    } catch (error) {
      finish(reject, error);
    }
  });
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
