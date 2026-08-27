import { createDownloadsAdapter } from '../browser/download-artifacts.js';
import { normalizeReviewAuditId } from '../review/review-state.js';
import { createAuditStore, isAuditRevisionConflict } from '../storage/audit-store.js';
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
const auditId = normalizeReviewAuditId(new URL(location.href).searchParams.get('auditId'));
let sourceModel = null;
let latestState = null;
let sourceRevision = null;
let sourceSnapshotCapability = null;

void start().catch(error => fail(error));

async function start() {
  if (!auditId) throw new TypeError('Auditoria não identificada.');
  const execute = async lock => {
    if (!lock) {
      status.textContent = 'Este relatório já está sendo gerado em outra aba.';
      await closeOwnTab();
      return;
    }
    await generate();
  };
  if (navigator.locks?.request) await navigator.locks.request(`audita-mt-export:${auditId}`, { ifAvailable: true }, execute);
  else await generate();
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
    message: 'Gerando os arquivos do relatório.',
  };
  await store.setLatest(latestState);
  notify({ type: 'EXPORT_PROGRESS', auditId, status: 'running', message: 'Gerando os arquivos do relatório.' });
  const manifestVersion = chrome.runtime.getManifest().version;
  const result = await runReportExport({
    auditSnapshotCapability: sourceSnapshotCapability,
    manifestVersion,
    browserVersion: raw.environment?.chromeVersion || navigator.userAgent,
    timezone: raw.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  }, {
    urlApi: globalThis.URL,
    tabAdapter: createExportTabAdapter(chrome),
    downloadsAdapter: createDownloadsAdapter(chrome),
    async reserveDelivery({ model }) {
      const nextRevision = sourceRevision + 1;
      const reservationLatest = {
        ...latestState,
        auditId,
        status: model.session.status,
        exportStatus: 'delivering',
        exportRevision: nextRevision,
        message: 'Transferindo os arquivos do relatório.',
      };
      const reservation = await store.commitAuditIfRevision(
        auditId,
        model,
        reservationLatest,
        sourceSnapshotCapability,
      );
      sourceRevision = reservation.revision;
      sourceSnapshotCapability = reservation.capability;
      latestState = reservationLatest;
      return reservation;
    },
  });
  const persisted = await persistExportSuccess(createExportSuccessRequest({
    auditId,
    result,
    latest: latestState,
  }), store);
  notify({ type: 'EXPORT_COMPLETE', auditId, status: persisted.latest.exportStatus, formats: result.formats.map(format => format.format) });
  status.textContent = persisted.latest.message;
  await closeOwnTab();
}

async function fail(error) {
  let message = 'Não foi possível preparar os artefatos do relatório.';
  if (auditId) {
    try {
      if (sourceModel && sourceSnapshotCapability) {
        const persisted = await persistExportFailure(createExportFailureRequest({
          snapshotCapability: sourceSnapshotCapability,
          latest: latestState,
        }), store);
        message = persisted.latest.message;
      } else {
        await store.setLatest({ auditId, exportStatus: 'failed', message });
      }
    } catch (persistenceError) {
      if (isAuditRevisionConflict(persistenceError) || isAuditRevisionConflict(error)) {
        message = 'A auditoria foi atualizada durante a exportação; a versão mais nova foi preservada.';
      } else if (!sourceModel) {
        try { await store.setLatest({ auditId, exportStatus: 'failed', message }); } catch {}
      }
    }
    notify({ type: 'EXPORT_FAILED', auditId, status: 'failed', error: message });
  }
  status.textContent = message;
  await closeOwnTab();
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
