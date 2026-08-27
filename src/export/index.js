import { createDownloadsAdapter } from '../browser/download-artifacts.js';
import { enrichAuditForReport } from '../core/report/enrich-audit.js';
import { createBrandAsset } from '../core/report/html.js';
import { normalizeReviewAuditId } from '../review/review-state.js';
import { createAuditStore } from '../storage/audit-store.js';
import { createExportTabAdapter } from './chrome-export-adapter.js';
import { persistExportFailure, persistExportSuccess } from './export-controller.js';
import { runReportExport } from './report-export.js';

const status = document.querySelector('#export-status');
const store = createAuditStore();
const auditId = normalizeReviewAuditId(new URL(location.href).searchParams.get('auditId'));
let sourceModel = null;
let latestState = null;

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
  const raw = await store.getAudit(auditId);
  if (!raw || !Object.hasOwn(raw, 'auditId') || raw.auditId !== auditId) throw new Error('Auditoria não encontrada no armazenamento local.');
  sourceModel = raw;
  const latest = await store.getLatest();
  latestState = latest;
  await store.setLatest({ ...(latest?.auditId === auditId ? latest : {}), auditId, exportStatus: 'running', message: 'Gerando os arquivos do relatório.' });
  notify({ type: 'EXPORT_PROGRESS', auditId, status: 'running', message: 'Gerando os arquivos do relatório.' });
  const manifestVersion = chrome.runtime.getManifest().version;
  const model = await enrichAuditForReport(raw, {
    manifestVersion,
    rulesVersion: raw.methodology?.version,
    browserVersion: raw.environment?.chromeVersion || navigator.userAgent,
    timezone: raw.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  sourceModel = model;
  const brandResponse = await fetch(chrome.runtime.getURL('assets/gov-mt-logo.png'), { signal: AbortSignal.timeout(15_000) });
  if (!brandResponse.ok) throw new Error('Não foi possível carregar a marca local.');
  const brand = await createBrandAsset(await brandResponse.arrayBuffer());
  const result = await runReportExport({ auditModel: model, brand }, {
    urlApi: globalThis.URL,
    tabAdapter: createExportTabAdapter(chrome),
    downloadsAdapter: createDownloadsAdapter(chrome),
  });
  const persisted = await persistExportSuccess({ auditId, result, latest }, store);
  notify({ type: 'EXPORT_COMPLETE', auditId, status: persisted.latest.exportStatus, formats: result.formats.map(format => format.format) });
  status.textContent = persisted.latest.message;
  await closeOwnTab();
}

async function fail(error) {
  void error;
  let message = 'Não foi possível preparar os artefatos do relatório.';
  if (auditId) {
    try {
      if (sourceModel) {
        const persisted = await persistExportFailure({ auditId, model: sourceModel, latest: latestState, cause: error }, store);
        message = persisted.latest.message;
      } else {
        await store.setLatest({ auditId, exportStatus: 'failed', message });
      }
    } catch {
      try { await store.setLatest({ auditId, exportStatus: 'failed', message }); } catch {}
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
