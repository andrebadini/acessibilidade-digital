import { createDownloadsAdapter } from '../browser/download-artifacts.js';
import { enrichAuditForReport } from '../core/report/enrich-audit.js';
import { createBrandAsset } from '../core/report/html.js';
import { normalizeReviewAuditId } from '../review/review-state.js';
import { createAuditStore } from '../storage/audit-store.js';
import { createExportTabAdapter } from './chrome-export-adapter.js';
import { runReportExport } from './report-export.js';

const status = document.querySelector('#export-status');
const store = createAuditStore();
const auditId = normalizeReviewAuditId(new URL(location.href).searchParams.get('auditId'));

void start().catch(error => fail(error));

async function start() {
  if (!auditId) throw new TypeError('Auditoria não identificada.');
  const execute = async lock => {
    if (!lock) {
      status.textContent = 'Este relatório já está sendo gerado em outra aba.';
      return;
    }
    await generate();
  };
  if (navigator.locks?.request) await navigator.locks.request(`audita-mt-export:${auditId}`, { ifAvailable: true }, execute);
  else await generate();
}

async function generate() {
  const raw = await store.getAudit(auditId);
  if (!raw || raw.auditId !== auditId) throw new Error('Auditoria não encontrada no armazenamento local.');
  const latest = await store.getLatest();
  await store.setLatest({ ...(latest ?? {}), auditId, exportStatus: 'running', message: 'Gerando os arquivos do relatório.' });
  notify({ type: 'EXPORT_PROGRESS', auditId, status: 'running', message: 'Gerando os arquivos do relatório.' });
  const manifestVersion = chrome.runtime.getManifest().version;
  const model = await enrichAuditForReport(raw, {
    manifestVersion,
    rulesVersion: raw.methodology?.version,
    browserVersion: raw.environment?.chromeVersion || navigator.userAgent,
    timezone: raw.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  const brandResponse = await fetch(chrome.runtime.getURL('assets/gov-mt-logo.png'), { signal: AbortSignal.timeout(15_000) });
  if (!brandResponse.ok) throw new Error('Não foi possível carregar a marca local.');
  const brand = await createBrandAsset(await brandResponse.arrayBuffer());
  const result = await runReportExport({ auditModel: model, brand }, {
    urlApi: globalThis.URL,
    tabAdapter: createExportTabAdapter(chrome),
    downloadsAdapter: createDownloadsAdapter(chrome),
  });
  const exportStatus = result.limitations.length || result.formats.some(format => format.status !== 'complete') ? 'partial' : 'complete';
  const persisted = await enrichAuditForReport({
    ...structuredClone(result.model),
    report: {
      ...(result.model.report ?? {}),
      status: exportStatus,
      artifact: {
        status: exportStatus,
        pdfFallback: result.pdfFallback,
        limitations: result.limitations,
        formats: result.formats.map(({ format, filename, mimeType, status: formatStatus, sha256 }) => ({ format, filename, mimeType, status: formatStatus, sha256 })),
      },
    },
  }, {
    manifestVersion,
    rulesVersion: result.model.versions.rules,
    browserVersion: result.model.versions.browser,
    timezone: result.model.timezone,
  });
  const nextLatest = {
    ...(latest ?? {}), auditId, status: persisted.session.status, percent: 100,
    exportStatus, message: exportStatus === 'complete' ? 'Arquivos do relatório gerados.' : 'Relatório gerado com limitações.',
  };
  await store.commitAudit(auditId, persisted, nextLatest);
  notify({ type: 'EXPORT_COMPLETE', auditId, status: exportStatus, formats: result.formats.map(format => format.format) });
  status.textContent = nextLatest.message;
  await closeOwnTab();
}

async function fail(error) {
  const message = error instanceof Error ? error.message : 'Não foi possível gerar o relatório.';
  status.textContent = message;
  if (auditId) {
    try {
      const latest = await store.getLatest();
      await store.setLatest({ ...(latest ?? {}), auditId, exportStatus: 'failed', message });
    } catch {}
    notify({ type: 'EXPORT_FAILED', auditId, status: 'failed', error: message });
  }
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
