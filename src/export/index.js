import { createDownloadsAdapter, reconcileStaleDownloads } from '../browser/download-artifacts.js';
import { normalizeReviewAuditId } from '../review/review-state.js';
import {
  createAuditStore,
  isAuditExportLeaseConflict,
  isAuditRevisionConflict,
} from '../storage/audit-store.js';
import { createExportTabAdapter } from './chrome-export-adapter.js';
import {
  createExportFailureRequest,
  createExportSuccessRequest,
  persistExportFailure,
  persistExportSuccess,
} from './export-controller.js';
import { runReportExport } from './report-export.js';

const status = document.querySelector('#export-status');
const store = createAuditStore();
const downloadsAdapter = createDownloadsAdapter(chrome);
const auditId = normalizeReviewAuditId(new URL(location.href).searchParams.get('auditId'));
const leaseOwnerId = normalizeReviewAuditId(new URL(location.href).searchParams.get('leaseOwnerId'));
const exportAttempt = readExportAttempt(new URL(location.href).searchParams.get('exportAttempt'));
const EXPORT_CLEANUP_MESSAGE = 'Um arquivo obsoleto da exportação não pôde ser removido com confirmação; tente gerar o relatório novamente.';
let sourceModel = null;
let latestState = null;
let sourceRevision = null;
let sourceSnapshotCapability = null;
let leaseClaimed = false;

void start().catch(error => fail(error));

async function start() {
  if (!auditId || !leaseOwnerId || !exportAttempt) {
    throw new TypeError('Auditoria, tentativa ou exclusividade de exportação não identificada.');
  }
  await generate();
}

async function generate() {
  const snapshot = await store.getAuditSnapshot(auditId);
  const raw = snapshot.model;
  if (!raw || !Object.hasOwn(raw, 'auditId') || raw.auditId !== auditId) throw new Error('Auditoria não encontrada no armazenamento local.');
  sourceModel = raw;
  sourceRevision = snapshot.revision;
  sourceSnapshotCapability = snapshot.capability;
  const latest = await store.getLatest();
  latestState = {
    ...(latest?.auditId === auditId ? latest : {}),
    auditId,
    exportStatus: 'running',
    exportRevision: sourceRevision,
    exportAttempt,
    leaseOwnerId,
    message: 'Gerando os arquivos do relatório.',
  };
  await store.claimExportLease(auditId, sourceSnapshotCapability, {
    ownerId: leaseOwnerId,
    exportAttempt,
    now: new Date().toISOString(),
    ttlMs: 10 * 60 * 1000,
    latestState,
  });
  leaseClaimed = true;
  await reconcileStaleDownloads(
    await store.getExportDeliveryJournal(auditId),
    downloadsAdapter,
    (entry, outcome) => store.resolveExportDelivery(auditId, {
      ...entry,
      now: new Date().toISOString(),
      outcome,
    }),
  );
  delete latestState.exportCleanupPending;
  delete latestState.exportCleanupMessage;
  notify({
    type: 'EXPORT_PROGRESS', auditId, status: 'running', message: 'Gerando os arquivos do relatório.',
    exportRevision: sourceRevision, exportAttempt, leaseOwnerId,
  });
  const manifestVersion = chrome.runtime.getManifest().version;
  const result = await runReportExport({
    auditSnapshotCapability: sourceSnapshotCapability,
    exportLeaseOwnerId: leaseOwnerId,
    exportAttempt,
    manifestVersion,
    browserVersion: raw.environment?.chromeVersion || navigator.userAgent,
    timezone: raw.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  }, {
    urlApi: globalThis.URL,
    tabAdapter: createExportTabAdapter(chrome),
    downloadsAdapter,
    async reserveDelivery({ model }) {
      const nextRevision = sourceRevision + 1;
      const reservationLatest = {
        ...latestState,
        auditId,
        status: model.session.status,
        exportStatus: 'delivering',
        exportRevision: nextRevision,
        exportAttempt,
        leaseOwnerId,
        message: 'Transferindo os arquivos do relatório.',
      };
      const reservation = await store.commitAuditIfRevisionWithExportLease(
        auditId,
        model,
        reservationLatest,
        sourceSnapshotCapability,
        {
          ownerId: leaseOwnerId,
          exportAttempt,
          now: new Date().toISOString(),
          ttlMs: 10 * 60 * 1000,
          phase: 'delivering',
        },
      );
      sourceRevision = reservation.revision;
      sourceSnapshotCapability = reservation.capability;
      latestState = reservationLatest;
      return reservation;
    },
    async assertDelivery({ snapshotCapability, exportLeaseOwnerId }) {
      if (exportLeaseOwnerId !== leaseOwnerId || typeof store.assertExportLease !== 'function') {
        throw new TypeError('Exclusividade da entrega não pôde ser revalidada.');
      }
      return store.assertExportLease(auditId, snapshotCapability, {
        ownerId: leaseOwnerId,
        exportAttempt,
        now: new Date().toISOString(),
        phase: 'delivering',
      });
    },
    async recordDelivery({ snapshotCapability, exportLeaseOwnerId, state, format, filename, downloadId }) {
      if (exportLeaseOwnerId !== leaseOwnerId) {
        throw new TypeError('Journal de entrega não correlacionado.');
      }
      if (state === 'cleaned' || state === 'cleanup-failed') {
        return store.resolveExportDelivery(auditId, {
          ownerId: leaseOwnerId,
          exportAttempt,
          now: new Date().toISOString(),
          format,
          filename,
          ...(downloadId === undefined ? {} : { downloadId }),
          outcome: state,
        });
      }
      return store.recordExportDelivery(auditId, snapshotCapability, {
        ownerId: leaseOwnerId,
        exportAttempt,
        now: new Date().toISOString(),
        format,
        filename,
        ...(downloadId === undefined ? {} : { downloadId }),
        state,
      });
    },
  });
  const persisted = await persistExportSuccess(createExportSuccessRequest({
    auditId,
    result,
    latest: latestState,
  }), store);
  notify({
    type: 'EXPORT_COMPLETE', auditId, status: persisted.latest.exportStatus,
    formats: result.formats.map(format => format.format),
    exportRevision: persisted.latest.exportRevision, exportAttempt, leaseOwnerId,
    localAuditDeleted: persisted.deleted,
  });
  if (persisted.deleted) {
    notify({ type: 'AUDIT_DELETED', auditId });
    status.textContent = 'Os quatro arquivos foram baixados e a auditoria local foi excluída. Os downloads permanecem no dispositivo.';
  } else status.textContent = persisted.latest.message;
  await closeOwnTab();
}

async function fail(error) {
  let message = 'Não foi possível preparar os artefatos do relatório.';
  let busy = isAuditExportLeaseConflict(error);
  let invalidated = isAuditRevisionConflict(error) || hasRevisionConflictCause(error);
  let persistedFailure = null;
  if (auditId) {
    try {
      if (leaseClaimed && sourceModel && sourceSnapshotCapability) {
        persistedFailure = await persistExportFailure(createExportFailureRequest({
          snapshotCapability: sourceSnapshotCapability,
          leaseOwnerId,
          latest: latestState,
        }), store);
        message = persistedFailure.latest.message;
      }
    } catch (persistenceError) {
      if (isAuditExportLeaseConflict(persistenceError) || busy) {
        busy = true;
        message = 'Este relatório já está sendo gerado em outra aba; tente novamente após a conclusão.';
      } else if (isAuditRevisionConflict(persistenceError) || isAuditRevisionConflict(error)) {
        invalidated = true;
        message = 'A auditoria foi atualizada durante a exportação; a versão mais nova foi preservada.';
      }
    }
    if (busy) message = 'Este relatório já está sendo gerado em outra aba; tente novamente após a conclusão.';
    const refreshed = leaseClaimed ? await store.getLatest().catch(() => null) : null;
    if (persistedFailure?.latest?.exportCleanupPending === true ||
      (refreshed?.auditId === auditId && refreshed.exportCleanupPending === true)) {
      message = EXPORT_CLEANUP_MESSAGE;
    }
    if (leaseClaimed && invalidated) {
      if (refreshed?.auditId === auditId && Number.isSafeInteger(refreshed.exportRevision) &&
        refreshed.exportAttempt === exportAttempt) {
        notify({
          type: 'EXPORT_INVALIDATED',
          auditId,
          status: 'preparing',
          error: message,
          exportRevision: refreshed.exportRevision,
          exportAttempt,
          leaseOwnerId,
        });
      }
    }
    if (leaseClaimed && (persistedFailure || busy)) {
      notify({
        type: busy ? 'EXPORT_BUSY' : 'EXPORT_FAILED',
        auditId,
        status: busy ? 'busy' : 'failed',
        error: message,
        exportRevision: persistedFailure?.latest?.exportRevision ?? sourceRevision,
        exportAttempt,
        leaseOwnerId,
      });
    }
  }
  status.textContent = message;
  if (!busy) await closeOwnTab();
}

function readExportAttempt(value) {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/u.test(value)) return null;
  const attempt = Number(value);
  return Number.isSafeInteger(attempt) ? attempt : null;
}

function hasRevisionConflictCause(value) {
  try {
    const descriptor = value && (typeof value === 'object' || typeof value === 'function')
      ? Object.getOwnPropertyDescriptor(value, 'causeCode')
      : null;
    return descriptor && Object.hasOwn(descriptor, 'value') && descriptor.value === 'AUDIT_REVISION_CONFLICT';
  } catch {
    return false;
  }
}

function notify(message) {
  try {
    const result = chrome.runtime.sendMessage(message);
    if (result && typeof result.catch === 'function') result.catch(() => {});
  } catch {}
}

async function closeOwnTab() {
  try {
    const own = await chrome.tabs.getCurrent();
    if (Number.isSafeInteger(own?.id)) await chrome.tabs.remove(own.id);
  } catch {}
}
