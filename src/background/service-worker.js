import { createAuditSession, interruptBatchCheckpoint } from './session.js';
import { normalizeAuditUrl } from '../core/url.js';
import { createChromeAdapter } from './chrome-adapter.js';
import { runAudit } from './run-audit.js';
import { runBatch } from './run-batch.js';
import { normalizeUrlList } from '../core/batch/normalize-url-list.js';
import {
  createAuditStore,
  isAuditExportLeaseConflict,
  isAuditRevisionConflict,
} from '../storage/audit-store.js';
import { sanitizeResourceUrl } from '../core/normalize-snapshot.js';
import { createExportFailureRequest, persistExportFailure } from '../export/export-controller.js';
import { getPersonaController } from './persona-runtime.js';
import { registerAuditContextMenus } from './context-menu.js';

const PANEL_PATH = '/src/panel/index.html';
const REVIEW_PATH = '/src/review/index.html';
const EXPORT_PATH = '/src/export/index.html';
const sessionKey = (id) => `audita-mt:session:${id}`;
const ACTIVE_BATCH_KEY = 'audita-mt:session:active-batch';
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
  const storage = chromeApi?.storage?.session;
  if (!storage) {
    return {
      async set(id, value) { fallback.set(id, value); },
      async get(id) { return fallback.get(id); },
      async setActiveBatch(value) { fallback.set(ACTIVE_BATCH_KEY, value); },
      async getActiveBatch() { return fallback.get(ACTIVE_BATCH_KEY); },
      async clearActiveBatch() { fallback.delete(ACTIVE_BATCH_KEY); },
    };
  }
  return {
    async set(id, value) {
      fallback.set(id, value);
      try { await invokeStorage(chromeApi, storage, 'set', { [sessionKey(id)]: value }); } catch { /* fallback efêmero */ }
    },
    async get(id) {
      try {
        const result = await invokeStorage(chromeApi, storage, 'get', sessionKey(id));
        return result?.[sessionKey(id)] ?? fallback.get(id);
      } catch { return fallback.get(id); }
    },
    async setActiveBatch(value) {
      fallback.set(ACTIVE_BATCH_KEY, value);
      try { await invokeStorage(chromeApi, storage, 'set', { [ACTIVE_BATCH_KEY]: value }); } catch { /* fallback efêmero */ }
    },
    async getActiveBatch() {
      try {
        const result = await invokeStorage(chromeApi, storage, 'get', ACTIVE_BATCH_KEY);
        return result?.[ACTIVE_BATCH_KEY] ?? fallback.get(ACTIVE_BATCH_KEY);
      } catch { return fallback.get(ACTIVE_BATCH_KEY); }
    },
    async clearActiveBatch() {
      fallback.delete(ACTIVE_BATCH_KEY);
      if (typeof storage.remove === 'function') {
        try { await invokeStorage(chromeApi, storage, 'remove', ACTIVE_BATCH_KEY); } catch { /* fallback efêmero */ }
      }
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
  const batchRunner = options.batchRunner ?? runBatch;
  const auditStore = options.auditStore ?? createAuditStore(options.auditStoreOptions);
  const chromeAdapterFactory = options.chromeAdapterFactory ?? createChromeAdapter;
  const createExportOwnerId = options.createExportOwnerId ?? (() => crypto.randomUUID());
  let activeJob = null;
  const activeExports = new Map();
  const personaController = options.personaController ?? getPersonaController(chromeApi, { logger });
  const contextMenuController = options.contextMenuController ?? registerAuditContextMenus(chromeApi, {
    logger,
    createRequestId: options.createContextRequestId,
    prefillTimeoutMs: options.contextPrefillTimeoutMs,
    openPanel(value) {
      if (!personaController) throw new Error('Controlador de personas indisponível.');
      return personaController.openPanel(value);
    },
    issueBindingLease(value) {
      if (typeof personaController?.issueBindingLease !== 'function') throw new Error('Controlador de personas indisponível.');
      return personaController.issueBindingLease(value);
    },
    consumeBindingLease(value) {
      if (typeof personaController?.consumeBindingLease !== 'function') throw new Error('Controlador de personas indisponível.');
      return personaController.consumeBindingLease(value);
    },
    beginSingleAudit,
  });
  const startupReady = restoreInterruptedBatchCheckpoint();

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
    if (contextMenuController?.handlePanelProtocolMessage(message, sender, sendResponse)) return true;
    const knownTypes = ['START_AUDIT', 'START_BATCH', 'CANCEL_AUDIT', 'GET_LAST_AUDIT', 'REQUEST_EXPORT', 'REVIEW_COMMITTED', 'EXPORT_PROGRESS', 'EXPORT_COMPLETE', 'EXPORT_FAILED', 'EXPORT_BUSY', 'EXPORT_INVALIDATED'];
    if (!message || !knownTypes.includes(message.type)) return false;
    if (!isAuthorizedExtensionSender(sender, chromeApi.runtime.id)) {
      sendResponse({ ok: false, error: 'Origem da mensagem não autorizada.' });
      return true;
    }
    if (['START_AUDIT', 'START_BATCH', 'CANCEL_AUDIT'].includes(message.type) && !isAuthorizedPanelSender(sender, chromeApi.runtime.id)) {
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
      void startupReady.then(() => restorableLatestState()).then(value => sendResponse({ ok: true, state: value ?? null }), () => sendResponse({ ok: false, error: 'Não foi possível restaurar a última auditoria.' }));
      return true;
    }
    const senderKey = panelOwnerKey(sender);
    if (message.type === 'CANCEL_AUDIT') {
      if (!activeJob || activeJob.auditId !== message.auditId || activeJob.senderKey !== senderKey) {
        sendResponse({ ok: false, error: 'Cancelamento não autorizado.' });
      } else if (activeJob.phase !== 'running') {
        sendResponse({
          ok: false, code: 'AUDIT_CANCEL_TOO_LATE',
          error: 'A auditoria já está na etapa final e não pode mais ser cancelada.',
        });
      } else {
        activeJob.controller.abort(new DOMException('Auditoria cancelada pela pessoa usuária.', 'AbortError'));
        sendResponse({ ok: true, auditId: activeJob.auditId, state: 'cancelling' });
      }
      return true;
    }
    if (message.type === 'START_BATCH') {
      try {
        const started = beginBatchAudit({ input: message.urls, senderKey });
        sendResponse(started.response);
      } catch (error) {
        sendResponse({ ok: false, error: error instanceof Error ? error.message : 'Não foi possível preparar o lote.' });
      }
      return true;
    }
    try {
      const started = beginSingleAudit({ navigationUrl: message.url, senderKey });
      sendResponse(started.response);
    } catch (error) {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : 'Não foi possível preparar a auditoria.' });
    }
    return true;
  });

  return sessions;

  function beginSingleAudit({ navigationUrl, senderKey }) {
    if (typeof senderKey !== 'string' || senderKey.length === 0 || senderKey.length > 512) {
      throw new TypeError('Correlação da auditoria inválida.');
    }
    const requestedUrl = normalizeAuditUrl(navigationUrl);
    if (activeJob) {
      if (activeJob.senderKey !== senderKey || activeJob.mode !== 'single') return busyAudit();
      return {
        response: { ok: true, auditId: activeJob.auditId, state: 'running', duplicate: true },
        completion: activeJob.completion,
      };
    }
    const storedUrl = sanitizeResourceUrl(requestedUrl);
    const auditId = createId();
    const session = createAuditSession({ id: auditId, requestedUrl: storedUrl, startedAt: now() });
    const entry = { auditId, senderKey, mode: 'single', phase: 'running', controller: new AbortController(), completion: null };
    activeJob = entry;
    entry.completion = runInBackground({ auditId, navigationUrl: requestedUrl, session, senderKey, entry });
    return { response: { ok: true, auditId, state: session.state }, completion: entry.completion };
  }

  async function runInBackground({ auditId, navigationUrl, session, senderKey, entry }) {
    let committed = false;
    try {
      await startupReady;
      await sessions.set(auditId, session);
      await auditStore.setLatest({ auditId, status: 'running', percent: 0, message: 'Preparando a auditoria.' });
      const adapter = chromeAdapterFactory(chromeApi);
      const pipelineAdapter = {
        ...adapter,
        async enterFinalization() { entry.phase = 'finalizing'; },
        async handoffReport(model) {
          entry.phase = 'finalizing';
          return adapter.handoffReport?.(model);
        },
        async emitProgress(progress) {
          await Promise.allSettled([
            auditStore.setLatest({ auditId, status: 'running', percent: progress.percent, message: progress.message }),
            sendRuntimeMessage(chromeApi, progress),
          ]);
        },
      };
      const model = await runner({ url: navigationUrl, chromeAdapter: pipelineAdapter, now, idFactory: () => auditId, closeAuditTab: true, signal: entry.controller.signal });
      entry.phase = 'finalizing';
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
      if (activeJob === entry) activeJob = null;
    }
  }

  function beginBatchAudit({ input, senderKey }) {
    if (typeof senderKey !== 'string' || senderKey.length === 0 || senderKey.length > 512) {
      throw new TypeError('Correlação da auditoria inválida.');
    }
    if (activeJob) return busyAudit();
    const normalized = normalizeUrlList(input);
    if (normalized.errors.length > 0 || normalized.entries.length === 0) {
      return {
        response: {
          ok: false, code: 'BATCH_INVALID',
          errors: normalized.entries.length === 0 && normalized.errors.length === 0
            ? [{ line: 0, code: 'BATCH_EMPTY', message: 'Informe ao menos uma URL.' }]
            : normalized.errors,
          warnings: normalized.warnings,
        },
        completion: null,
      };
    }
    const auditId = createId();
    const entry = { auditId, senderKey, mode: 'batch', phase: 'running', controller: new AbortController(), completion: null };
    activeJob = entry;
    entry.completion = runBatchInBackground({ auditId, normalized, entry });
    return {
      response: { ok: true, auditId, state: 'idle', total: normalized.entries.length, warnings: normalized.warnings },
      completion: entry.completion,
    };
  }

  async function runBatchInBackground({ auditId, normalized, entry }) {
    let committed = false;
    let persistedStatusCounts = emptyBatchStatusCounts();
    try {
      await startupReady;
      await auditStore.setLatest({
        auditId, mode: 'batch', status: 'running', percent: 0, message: 'Preparando o lote explícito.',
        pageNumber: 0, total: normalized.entries.length, statusCounts: { ...persistedStatusCounts },
      });
      const adapter = chromeAdapterFactory(chromeApi);
      const closeCancellationBoundary = () => {
        const cancellationWon = entry.controller.signal.aborted;
        entry.phase = 'finalizing';
        return !cancellationWon;
      };
      const pipelineAdapter = {
        ...adapter,
        tryEnterFinalization: closeCancellationBoundary,
        async enterFinalization() { return closeCancellationBoundary(); },
        async handoffReport(model) {
          entry.phase = 'finalizing';
          return adapter.handoffReport?.(model);
        },
        async emitProgress(progress) {
          const nextCounts = copyBatchStatusCounts(progress.statusCounts, normalized.entries.length);
          if (nextCounts) persistedStatusCounts = nextCounts;
          await Promise.allSettled([
            auditStore.setLatest({
              auditId, mode: 'batch', status: 'running', percent: progress.percent,
              message: progress.message, pageNumber: progress.pageNumber, total: progress.total,
              statusCounts: { ...persistedStatusCounts },
            }),
            sendRuntimeMessage(chromeApi, progress),
          ]);
        },
      };
      const model = await batchRunner({
        entries: normalized.entries, batchAuditId: auditId, chromeAdapter: pipelineAdapter,
        now, signal: entry.controller.signal,
        reportOptions: options.reportOptions ?? defaultBatchReportOptions(chromeApi),
        onCheckpoint: async checkpoint => {
          await sessions.set(auditId, checkpoint);
          await sessions.setActiveBatch?.(checkpoint);
        },
      });
      entry.phase = 'finalizing';
      const status = model?.session?.status || 'failed';
      const reviewUrl = model?.report?.reviewUrl || null;
      const latestState = {
        auditId, mode: 'batch', status, percent: 100,
        message: batchTerminalMessage(status), reviewUrl, exportStatus: 'preparing',
        total: model?.pages?.length ?? normalized.entries.length,
        statusCounts: countPageStatuses(model?.pages),
      };
      await auditStore.commitAudit(auditId, model, latestState);
      committed = true;
      await sessions.clearActiveBatch?.();
      await Promise.allSettled([
        sendRuntimeMessage(chromeApi, {
          type: 'AUDIT_COMPLETE', auditId, sessionId: auditId, status, reviewUrl,
          exportStatus: 'preparing', total: latestState.total, statusCounts: latestState.statusCounts,
        }),
        startAutomaticExport(auditId),
      ]);
    } catch {
      if (!committed) await Promise.allSettled([
        auditStore.setLatest({ auditId, mode: 'batch', status: 'failed', percent: 0, message: 'O lote não pôde ser iniciado.' }),
        sendRuntimeMessage(chromeApi, { type: 'AUDIT_FAILED', auditId, sessionId: auditId, status: 'failed', error: 'O lote não pôde ser iniciado.' }),
      ]);
      logger.error('O lote em segundo plano falhou de forma controlada.');
    } finally {
      if (activeJob === entry) activeJob = null;
    }
  }

  function busyAudit() {
    return {
      response: { ok: false, code: 'AUDIT_BUSY', error: 'Já existe uma auditoria em andamento.' },
      completion: activeJob?.completion ?? null,
    };
  }

  async function restoreInterruptedBatchCheckpoint() {
    try {
      const checkpoint = await sessions.getActiveBatch?.();
      if (!checkpoint || checkpoint.mode !== 'batch') return;
      const [snapshot, latest] = await Promise.all([
        auditStore.getAuditSnapshot?.(checkpoint.id),
        auditStore.getLatest?.(),
      ]);
      const terminal = ['complete', 'partial', 'failed', 'cancelled'].includes(checkpoint.state);
      const committed = terminal && snapshot?.model?.auditId === checkpoint.id &&
        snapshot.model?.session?.status === checkpoint.state &&
        latest?.auditId === checkpoint.id && latest.status === checkpoint.state;
      if (committed || (latest?.auditId && latest.auditId !== checkpoint.id)) {
        await clearActiveCheckpointIfCurrent(checkpoint);
        return;
      }
      const interrupted = interruptBatchCheckpoint(checkpoint, queueTime());
      await sessions.set(interrupted.id, interrupted);
      const currentLatest = await auditStore.getLatest?.();
      if (currentLatest?.auditId && currentLatest.auditId !== interrupted.id) {
        await clearActiveCheckpointIfCurrent(checkpoint);
        return;
      }
      await auditStore.setLatest({
        auditId: interrupted.id, mode: 'batch', status: 'failed', percent: 0,
        message: 'O lote foi interrompido por reinício do worker e não pode ser retomado automaticamente.',
        total: interrupted.total, statusCounts: interrupted.statusCounts, exportStatus: 'unavailable',
      });
      await clearActiveCheckpointIfCurrent(checkpoint);
    } catch {
      logger.error('Não foi possível registrar a interrupção do lote anterior.');
    }
  }

  async function clearActiveCheckpointIfCurrent(checkpoint) {
    const current = await sessions.getActiveBatch?.();
    if (!current || (current.id === checkpoint.id && current.updatedAt === checkpoint.updatedAt)) {
      await sessions.clearActiveBatch?.();
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

function panelOwnerKey(sender) {
  if (Number.isSafeInteger(sender?.tab?.id) && sender.tab.id >= 0) return `panel-tab:${sender.tab.id}`;
  return `panel-document:${sender?.id}:${sender?.documentId || sender?.url}`;
}

function defaultBatchReportOptions(chromeApi) {
  const manifestVersion = chromeApi?.runtime?.getManifest?.().version;
  return {
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    manifestVersion: typeof manifestVersion === 'string' && manifestVersion ? manifestVersion : 'desconhecida',
    rulesVersion: '1.0.0',
    browserVersion: detectBrowserVersion(),
  };
}

function detectBrowserVersion() {
  const match = typeof navigator !== 'undefined' ? navigator.userAgent?.match(/(?:Chrome|Chromium)\/([0-9.]+)/u) : null;
  return match?.[1] ?? 'não disponível';
}

function countPageStatuses(pages) {
  const counts = { complete: 0, partial: 0, failed: 0, cancelled: 0 };
  for (const page of Array.isArray(pages) ? pages : []) {
    if (Object.hasOwn(counts, page?.status)) counts[page.status] += 1;
  }
  return counts;
}

function emptyBatchStatusCounts() {
  return { complete: 0, partial: 0, failed: 0, cancelled: 0 };
}

function copyBatchStatusCounts(value, total) {
  const keys = ['cancelled', 'complete', 'failed', 'partial'];
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== keys.join(',')) return null;
  const output = emptyBatchStatusCounts();
  let sum = 0;
  for (const key of keys) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0 || value[key] > total) return null;
    output[key] = value[key];
    sum += value[key];
  }
  return sum <= total ? output : null;
}

function batchTerminalMessage(status) {
  if (status === 'complete') return 'Lote concluído.';
  if (status === 'cancelled') return 'Lote cancelado; os resultados disponíveis podem ser revisados.';
  if (status === 'failed') return 'Lote encerrado sem páginas concluídas; o registro pode ser revisado.';
  return 'Lote concluído com limitações.';
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
