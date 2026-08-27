import { downloadArtifacts, buildArtifactBaseName } from '../browser/download-artifacts.js';
import { renderPdf } from '../browser/render-pdf.js';
import { renderTechnicalJson } from '../core/report/earl-json.js';
import { enrichAuditForReport } from '../core/report/enrich-audit.js';
import { renderHtmlReport } from '../core/report/html.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const PDF_COMMAND_TIMEOUT_MS = 45_000;

export async function runReportExport(request, dependencies) {
  validateDependencies(dependencies);
  const original = structuredClone(request?.auditModel);
  const at = canonicalNow(request?.now);
  const timeoutMs = request?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('Timeout de exportação inválido.');
  let model = original;
  let html = renderHtmlReport(model, request?.brand ? { brand: request.brand } : {});
  let pdf = null;
  let printResult = null;
  const exportLimitations = [];
  const printUrl = dependencies.urlApi.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
  let tabId = null;
  let cdp = null;
  try {
    const tab = await boundary(dependencies.tabAdapter.createPrintTab({ url: printUrl, active: false }), timeoutMs, 'A criação da aba de impressão excedeu o tempo limite.');
    if (!Number.isSafeInteger(tab?.id)) throw new TypeError('A aba de impressão não forneceu ID válido.');
    tabId = tab.id;
    await boundary(dependencies.tabAdapter.waitForReady(tabId, { timeoutMs }), timeoutMs, 'A preparação da aba de impressão excedeu o tempo limite.');
    cdp = await boundary(dependencies.tabAdapter.connectCdp(tabId, { commandTimeoutMs: PDF_COMMAND_TIMEOUT_MS }), timeoutMs, 'A conexão de impressão excedeu o tempo limite.');
    await boundary(dependencies.tabAdapter.waitForAssets(cdp, { timeoutMs }), timeoutMs, 'A preparação de fontes e imagens excedeu o tempo limite.');
    printResult = await boundary((dependencies.pdfRenderer ?? renderPdf)(cdp), Math.max(timeoutMs, PDF_COMMAND_TIMEOUT_MS + 5_000), 'A impressão do PDF excedeu o tempo limite.');
    pdf = printResult.bytes;
    exportLimitations.push(...(printResult.limitations ?? []));
  } catch (error) {
    exportLimitations.push(`O PDF não foi gerado: ${safeErrorMessage(error)}.`);
  } finally {
    if (cdp) {
      try { await boundary(cdp.disconnect(), timeoutMs, 'A desconexão de impressão excedeu o tempo limite.'); } catch (error) { exportLimitations.push(`A conexão de impressão exigiu limpeza adicional: ${safeErrorMessage(error)}.`); }
    }
    if (tabId !== null) {
      try { await boundary(dependencies.tabAdapter.removeTab(tabId), timeoutMs, 'A remoção da aba de impressão excedeu o tempo limite.'); } catch (error) { exportLimitations.push(`A aba temporária de impressão já não estava disponível: ${safeErrorMessage(error)}.`); }
    }
    dependencies.urlApi.revokeObjectURL(printUrl);
  }

  if (!pdf) model = await markExportPartial(model, at, exportLimitations);
  html = renderHtmlReport(model, request?.brand ? { brand: request.brand } : {});
  const json = renderTechnicalJson(model);
  const baseName = buildArtifactBaseName(model.finalUrl, at);
  const downloads = await downloadArtifacts({ baseName, html, json, ...(pdf ? { pdf } : {}) }, dependencies.downloadsAdapter, { timeoutMs });
  exportLimitations.push(...downloads.limitations);
  if (downloads.limitations.length) model = await markExportPartial(model, at, downloads.limitations);
  return {
    model,
    html,
    json,
    formats: downloads.formats,
    limitations: [...new Set(exportLimitations)],
    pdfFallback: Boolean(printResult?.usedFallback),
  };
}

async function markExportPartial(model, at, limitations) {
  const next = structuredClone(model);
  if (!['failed', 'cancelled'].includes(next.session.status)) next.session.status = 'partial';
  next.session.partial = true;
  const messages = [...new Set(limitations.filter(Boolean))];
  next.limitations = [...new Set([...(next.limitations ?? []), ...messages])];
  next.session.diagnostics = [...(next.session.diagnostics ?? []), ...messages.map((message, index) => ({
    code: `REPORT_EXPORT_PARTIAL_${index + 1}`,
    message,
    at,
    recoverable: true,
  }))];
  next.report = {
    ...(next.report ?? {}),
    status: 'partial',
    artifact: { ...(next.report?.artifact ?? {}), status: 'partial', formats: next.report?.artifact?.formats ?? [] },
  };
  return enrichAuditForReport(next, {
    now: () => at,
    timezone: next.timezone,
    manifestVersion: next.versions?.extension,
    rulesVersion: next.versions?.rules,
    browserVersion: next.versions?.browser,
  });
}

function canonicalNow(now) {
  const raw = typeof now === 'function' ? now() : new Date().toISOString();
  const date = raw instanceof Date ? raw : new Date(raw);
  if (!Number.isFinite(date.getTime())) throw new TypeError('Instante de exportação inválido.');
  return date.toISOString();
}

function safeErrorMessage(error) {
  const message = String(error?.message ?? 'erro não identificado').replace(/[\r\n\t]+/gu, ' ').trim();
  return message.slice(0, 300) || 'erro não identificado';
}

function validateDependencies(dependencies) {
  if (!dependencies?.urlApi || typeof dependencies.urlApi.createObjectURL !== 'function' || typeof dependencies.urlApi.revokeObjectURL !== 'function') {
    throw new TypeError('API de Blob URL indisponível.');
  }
  for (const method of ['createPrintTab', 'waitForReady', 'connectCdp', 'waitForAssets', 'removeTab']) {
    if (typeof dependencies.tabAdapter?.[method] !== 'function') throw new TypeError(`Adaptador de aba sem ${method}.`);
  }
  if (!dependencies.downloadsAdapter) throw new TypeError('Adaptador de downloads indisponível.');
}

function boundary(promise, timeoutMs, message) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new DOMException(message, 'TimeoutError')), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}
