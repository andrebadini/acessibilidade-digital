import { createAuditSession } from './session.js';
import { normalizeAuditUrl } from '../core/url.js';
import { createChromeAdapter } from './chrome-adapter.js';
import { runAudit } from './run-audit.js';
import {
  createAuditStore,
  isAuditExportLeaseConflict,
  isAuditRevisionConflict,
} from '../storage/audit-store.js';
import { sanitizeResourceUrl } from '../core/normalize-snapshot.js';
import { createExportFailureRequest, persistExportFailure } from '../export/export-controller.js';
import { getPersonaController } from './persona-runtime.js';

const PANEL_PATH = '/src/panel/index.html';
const REVIEW_PATH = '/src/review/index.html';
const EXPORT_PATH = '/src/export/index.html';
const sessionKey = (id) => `audita-mt:session:${id}`;
const EXPORT_BUSY_MESSAGE = 'Este relatório já está sendo gerado; tente novamente após a conclusão.';
const EXPORT_CLEANUP_MESSAGE = 'Um arquivo obsoleto da exportação não pôde ser removido com confirmação; tente gerar o relatório novamente.';

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
    const keys = [...url.searchParams.keys()].sort();
    if (url.pathname === REVIEW_PATH) {
      return keys.length === 1 && keys[0] === 'auditId' && validAuditId(url.searchParams.get('auditId'));
    }
    return url.pathname === EXPORT_PATH && keys.length === 3 && keys[0] === 'auditId' &&
      keys[1] === 'exportAttempt' && keys[2] === 'leaseOwnerId' &&
      validAuditId(url.searchParams.get('auditId')) &&
      validExportAttempt(url.searchParams.get('exportAttempt')) &&
      validAuditId(url.searchParams.get('leaseOwnerId'));
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
  const createExportOwnerId = options.createExportOwnerId ?? (() => crypto.randomUUID());
  const activeBySender = new Map();
  const activeExports = new Map();
  const personaController = options.personaController ?? getPersonaController(chromeApi, { logger });

  chromeApi.action.onClicked.addListener((sourceTab) => {
    void Promise.resolve()
      .then(() => {
        if (!personaController) throw new Error('Controlador de personas indisponível.');
        return personaController.openPanel({ sourceTab });
      })
      .catch(() => logger.error('Não foi possível abrir o painel de auditoria.'));
  });

  chromeApi.runtime.onConnect?.addListener?.((port) => {
    personaController?.attachPanelPort(port);
  });

  chromeApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const knownTypes = ['START_AUDIT', 'GET_LAST_AUDIT', 'REQUEST_EXPORT', 'REVIEW_COMMITTED', 'EXPORT_PROGRESS', 'EXPORT_COMPLETE', 'EXPORT_FAILED', 'EXPORT_BUSY', 'EXPORT_INVALIDATED'];
    if (!message || !knownTypes.includes(message.type)) return false;
    if (!isAuthorizedExtensionSender(sender, chromeApi.runtime.id)) {
      sendResponse({ ok: false, error: 'Origem da mensagem não autorizada.' });
      return true;
    }
    if (message.type === 'START_AUDIT' && !isAuthorizedPanelSender(sender, chromeApi.runtime.id)) {
      sendResponse({ ok: false, error: 'Origem da mensagem não autorizada.' });
      return true;
    }
    if (message.type === 'REVIEW_COMMITTED') {
      const reviewSender = new URL(sender.url);
      if (reviewSender.pathname !== REVIEW_PATH || !validAuditId(message.auditId) ||
        reviewSender.searchParams.get('auditId') !== message.auditId ||
        !Number.isSafeInteger(message.exportRevision) || message.exportRevision < 0) {
        sendResponse({ ok: false, error: 'Revisão não correlacionada.' });
        return true;
      }
      void Promise.all([auditStore.getAuditSnapshot(message.auditId), auditStore.getLatest()]).then(
        async ([snapshot, latest]) => {
          if (snapshot?.model?.auditId !== message.auditId || snapshot.revision !== message.exportRevision ||
            latest?.auditId !== message.auditId || latest.exportRevision !== message.exportRevision) {
            sendResponse({ ok: false, error: 'Revisão não correlacionada.' });
            return;
          }
          try {
            await sendRuntimeMessage(chromeApi, {
              type: 'AUDIT_REVIEW_UPDATED', auditId: message.auditId,
              exportRevision: message.exportRevision,
            });
            sendResponse({ ok: true });
          } catch {
            sendResponse({ ok: false, error: 'Não foi possível notificar a revisão.' });
          }
        },
        () => sendResponse({ ok: false, error: 'Não foi possível confirmar a revisão.' }),
      );
      return true;
    }
    if (message.type.startsWith('EXPORT_')) {
      const exportSender = new URL(sender.url);
      if (exportSender.pathname !== EXPORT_PATH || !validAuditId(message.auditId) ||
        exportSender.searchParams.get('auditId') !== message.auditId ||
        !validAuditId(message.leaseOwnerId) ||
        exportSender.searchParams.get('leaseOwnerId') !== message.leaseOwnerId ||
        !validExportAttempt(message.exportAttempt) ||
        Number(exportSender.searchParams.get('exportAttempt')) !== message.exportAttempt ||
        !Number.isSafeInteger(message.exportRevision) || message.exportRevision < 0) {
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
        sendResponse(exportBusyResponse(message.auditId));
        return true;
      }
      const queued = queueRequestedExport(message.auditId);
      activeExports.set(message.auditId, queued);
      void queued.then(sendResponse, error => sendResponse(exportQueueErrorResponse(message.auditId, error)))
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
      const latestState = { auditId, status, percent: canExport ? 100 : model?.progress?.at?.(-1)?.percent || 0, message: status === 'partial' ? 'Auditoria concluída com limitações.' : status === 'complete' ? 'Auditoria concluída.' : 'A auditoria não pôde ser concluída.', reviewUrl, exportStatus: canExport ? 'preparing' : 'unavailable' };
      await auditStore.commitAudit(auditId, model, latestState);
      committed = true;
      if (canExport) {
        await Promise.allSettled([
          sendRuntimeMessage(chromeApi, { type: 'AUDIT_COMPLETE', auditId, sessionId: auditId, status, reviewUrl, exportStatus: 'preparing' }),
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
    if (typeof auditStore.acquireExportLease !== 'function') {
      throw new TypeError('Armazenamento sem exclusividade persistente de exportação.');
    }
    const ownerId = createExportOwnerIdOnce(createExportOwnerId);
    if (!ownerId) throw new TypeError('Identificador de exclusividade da exportação inválido.');
    const correlatedLatest = latest?.auditId === auditId ? latest : {};
    const queuedLatest = {
      ...correlatedLatest,
      auditId,
      exportStatus: 'queued',
      exportRevision: revision,
      exportQueuedAt: queueTime(),
      leaseOwnerId: ownerId,
      message: 'Relatório na fila de geração.',
    };
    delete queuedLatest.exportAttempt;
    const lease = await auditStore.acquireExportLease(auditId, snapshot.capability, {
      ownerId,
      now: queuedLatest.exportQueuedAt,
      latestState: queuedLatest,
    });
    if (!lease?.acquired) return exportBusyResponse(auditId, lease?.retryAt);
    if (!validExportAttempt(lease.exportAttempt)) {
      throw new TypeError('Tentativa persistente da exportação inválida.');
    }
    const exportAttempt = lease.exportAttempt;
    const leasedLatest = { ...queuedLatest, exportAttempt };
    try {
      await openExportPage(auditId, ownerId, exportAttempt);
      return {
        ok: true, auditId, state: 'queued', exportRevision: revision,
        exportAttempt, leaseOwnerId: ownerId,
      };
    } catch (error) {
      await persistExportFailure(createExportFailureRequest({
        snapshotCapability: snapshot.capability,
        leaseOwnerId: ownerId,
        latest: leasedLatest,
        at: queueTime(),
      }), auditStore);
      throw error;
    }
  }

  async function startAutomaticExport(auditId) {
    try {
      await queueRequestedExport(auditId);
    } catch {
      const latest = await auditStore.getLatest().catch(() => null);
      if (latest?.auditId === auditId && latest.exportStatus === 'failed' &&
        validAuditId(latest.leaseOwnerId) && validExportAttempt(latest.exportAttempt) &&
        Number.isSafeInteger(latest.exportRevision) && latest.exportRevision >= 0) {
        await sendRuntimeMessage(chromeApi, {
          type: 'EXPORT_FAILED', auditId, status: 'failed',
          error: typeof latest.message === 'string' ? latest.message : 'Não foi possível preparar o relatório.',
          exportRevision: latest.exportRevision,
          exportAttempt: latest.exportAttempt,
          leaseOwnerId: latest.leaseOwnerId,
        }).catch(() => {});
      }
    }
  }

  async function openExportPage(auditId, leaseOwnerId, exportAttempt) {
    return chromeApi.tabs.create({
      url: chromeApi.runtime.getURL(`src/export/index.html?auditId=${encodeURIComponent(auditId)}&leaseOwnerId=${encodeURIComponent(leaseOwnerId)}&exportAttempt=${exportAttempt}`),
      active: false,
    });
  }

  function queueTime() {
    const value = now();
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) throw new TypeError('Relógio de exportação inválido.');
    return date.toISOString();
  }

  async function restorableLatestState() {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const latest = await auditStore.getLatest();
      const resolved = await resolveRestorableLatestState(latest);
      const confirmedLatest = await auditStore.getLatest();
      if (sameStoredLatest(latest, confirmedLatest)) return resolved;
    }
    const latest = await auditStore.getLatest();
    if (latest && ['queued', 'running', 'delivering'].includes(latest.exportStatus)) {
      return {
        ...latest,
        exportStatus: 'preparing',
        message: latest.exportCleanupPending === true
          ? EXPORT_CLEANUP_MESSAGE
          : 'O estado da geração está sendo atualizado; aguarde ou tente novamente.',
      };
    }
    return latest;
  }

  async function resolveRestorableLatestState(latest) {
    if (!latest || !['preparing', 'queued', 'running', 'delivering', 'complete', 'partial'].includes(latest.exportStatus) ||
      typeof auditStore.getAuditSnapshot !== 'function' || !validAuditId(latest.auditId)) return latest;
    if (latest.exportStatus === 'preparing') return latest.exportCleanupPending === true
      ? { ...latest, message: EXPORT_CLEANUP_MESSAGE }
      : latest;
    if (!Number.isSafeInteger(latest.exportRevision) || latest.exportRevision < 0) {
      return {
        ...latest,
        exportStatus: 'preparing',
        message: 'Preparando a geração do relatório; tente novamente se ela não iniciar.',
      };
    }
    const snapshot = await auditStore.getAuditSnapshot(latest.auditId);
    if (latest.exportRevision === snapshot.revision) {
      if (['queued', 'running', 'delivering'].includes(latest.exportStatus) &&
        typeof auditStore.getExportLeaseState === 'function') {
        if (!validExportAttempt(latest.exportAttempt) || !validAuditId(latest.leaseOwnerId)) {
          return {
            ...latest,
            exportStatus: 'preparing',
            message: 'A geração anterior não possui correlação válida; solicite o relatório novamente.',
          };
        }
        const lease = await auditStore.getExportLeaseState(latest.auditId, { now: queueTime() });
        if (!lease?.active || lease.revision !== snapshot.revision || lease.phase !== latest.exportStatus ||
          lease.exportAttempt !== latest.exportAttempt || lease.ownerId !== latest.leaseOwnerId) {
          return {
            ...latest,
            exportStatus: 'preparing',
            message: latest.exportCleanupPending === true
              ? EXPORT_CLEANUP_MESSAGE
              : 'A geração anterior foi interrompida; solicite o relatório novamente.',
          };
        }
      }
      return latest;
    }
    return {
      ...latest,
      exportStatus: 'failed',
      message: 'A auditoria foi atualizada durante a exportação; gere o relatório novamente.',
    };
  }
}

function sameStoredLatest(first, second) {
  try { return JSON.stringify(first) === JSON.stringify(second); } catch { return false; }
}

function createExportOwnerIdOnce(factory) {
  const value = factory();
  return validAuditId(value) ? value : null;
}

function exportBusyResponse(auditId, retryAt) {
  return {
    ok: false,
    auditId,
    state: 'busy',
    code: 'EXPORT_BUSY',
    retryable: true,
    ...(typeof retryAt === 'string' ? { retryAt } : {}),
    error: EXPORT_BUSY_MESSAGE,
  };
}

function exportQueueErrorResponse(auditId, error) {
  if (isAuditExportLeaseConflict(error)) return exportBusyResponse(auditId);
  if (isAuditRevisionConflict(error)) {
    return {
      ok: false,
      auditId,
      state: 'stale',
      code: 'AUDIT_REVISION_CONFLICT',
      retryable: true,
      error: 'A auditoria foi atualizada; solicite novamente o relatório revisado.',
    };
  }
  return { ok: false, auditId, state: 'failed', retryable: true, error: 'Não foi possível preparar o relatório.' };
}

function validAuditId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,200}$/u.test(value);
}

function validExportAttempt(value) {
  const attempt = typeof value === 'string' && /^[1-9][0-9]*$/u.test(value) ? Number(value) : value;
  return Number.isSafeInteger(attempt) && attempt >= 1;
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
