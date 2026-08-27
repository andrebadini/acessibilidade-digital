import { downloadArtifacts, buildArtifactBaseName } from '../browser/download-artifacts.js';
import { renderPdf } from '../browser/render-pdf.js';
import { renderTechnicalJson } from '../core/report/earl-json.js';
import { enrichAuditForReport } from '../core/report/enrich-audit.js';
import { renderHtmlReport } from '../core/report/html.js';
import { createExportIssue, issueForPrintStage } from './export-issues.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const PDF_COMMAND_TIMEOUT_MS = 45_000;

export async function runReportExport(request, dependencies) {
  validateDependencies(dependencies);
  const original = sanitizeReportMessages(request?.auditModel);
  const at = canonicalNow(request?.now);
  const timeoutMs = request?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('Timeout de exportação inválido.');
  let model = original;
  let html = renderHtmlReport(model, request?.brand ? { brand: request.brand } : {});
  let pdf = null;
  let printResult = null;
  const generationIssues = [];
  const printUrl = dependencies.urlApi.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
  let tabId = null;
  let cdp = null;
  let stage = 'tab';
  try {
    const tab = await adoptBoundary(
      dependencies.tabAdapter.createPrintTab({ url: printUrl, active: false }), timeoutMs,
      lateTab => Number.isSafeInteger(lateTab?.id) ? dependencies.tabAdapter.removeTab(lateTab.id) : undefined,
    );
    if (!Number.isSafeInteger(tab?.id)) throw new TypeError('A aba de impressão não forneceu ID válido.');
    tabId = tab.id;
    stage = 'load';
    await boundary(dependencies.tabAdapter.waitForReady(tabId, { timeoutMs }), timeoutMs, 'A preparação da aba de impressão excedeu o tempo limite.');
    stage = 'cdp';
    cdp = await adoptBoundary(
      dependencies.tabAdapter.connectCdp(tabId, { commandTimeoutMs: PDF_COMMAND_TIMEOUT_MS }), timeoutMs,
      lateCdp => lateCdp?.disconnect?.(),
    );
    stage = 'assets';
    await boundary(dependencies.tabAdapter.waitForAssets(cdp, { timeoutMs }), timeoutMs, 'A preparação de fontes e imagens excedeu o tempo limite.');
    stage = 'pdf';
    printResult = await boundary((dependencies.pdfRenderer ?? renderPdf)(cdp), Math.max(timeoutMs, PDF_COMMAND_TIMEOUT_MS + 5_000), 'A impressão do PDF excedeu o tempo limite.');
    pdf = printResult.bytes;
    if (printResult.usedFallback) generationIssues.push(createExportIssue('REPORT_PDF_TAGGING_UNSUPPORTED'));
  } catch (error) {
    generationIssues.push(issueForPrintStage(stage, error));
  } finally {
    if (cdp) {
      try { await boundary(cdp.disconnect(), timeoutMs, 'A desconexão de impressão excedeu o tempo limite.'); } catch { generationIssues.push(createExportIssue('REPORT_PRINT_CLEANUP_LIMITED')); }
    }
    if (tabId !== null) {
      try { await boundary(dependencies.tabAdapter.removeTab(tabId), timeoutMs, 'A remoção da aba de impressão excedeu o tempo limite.'); } catch { generationIssues.push(createExportIssue('REPORT_PRINT_CLEANUP_LIMITED')); }
    }
    try { dependencies.urlApi.revokeObjectURL(printUrl); } catch { generationIssues.push(createExportIssue('REPORT_PRINT_CLEANUP_LIMITED')); }
  }

  model = await finalizeGeneratedModel(model, at, generationIssues, Boolean(pdf), Boolean(printResult?.usedFallback));
  html = renderHtmlReport(model, request?.brand ? { brand: request.brand } : {});
  const json = renderTechnicalJson(model);
  const baseName = buildArtifactBaseName(model.finalUrl, at);
  const downloads = await downloadArtifacts({ baseName, html, json, ...(pdf ? { pdf } : {}) }, dependencies.downloadsAdapter, { timeoutMs });
  const deliveryReceipt = {
    status: downloads.formats.every(format => format.status === 'complete') && downloads.limitations.length === 0 ? 'complete' : 'partial',
    formats: downloads.formats,
    limitations: downloads.limitations,
  };
  return {
    model,
    html,
    json,
    formats: downloads.formats,
    deliveryReceipt,
    limitations: [...new Set([...generationIssues.map(issue => issue.message), ...downloads.limitations])],
    pdfFallback: Boolean(printResult?.usedFallback),
  };
}

export async function finalizeGeneratedModel(model, at, issues, hasPdf, pdfFallback = false, artifactsPrepared = true) {
  const next = sanitizeReportMessages(model);
  const controlled = dedupeIssues(issues);
  if (controlled.length && !['failed', 'cancelled'].includes(next.session.status)) next.session.status = 'partial';
  next.session.partial = next.session.status === 'partial';
  const messages = controlled.map(issue => issue.message);
  next.limitations = [...new Set([...(next.limitations ?? []), ...messages])];
  next.session.diagnostics = [...(next.session.diagnostics ?? []), ...controlled.map(issue => ({
    code: issue.code,
    message: issue.message,
    at,
    recoverable: true,
  }))];
  const reportStatus = controlled.length || next.session.status !== 'complete' ? 'partial' : 'complete';
  next.report = {
    ...(next.report ?? {}),
    status: reportStatus,
    artifact: {
      status: controlled.length ? 'partial' : 'complete',
      pdfFallback,
      limitations: messages,
      formats: artifactsPrepared
        ? ['html', 'json', ...(hasPdf ? ['pdf'] : [])].map(format => ({ format, status: 'prepared' }))
        : [],
    },
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

function adoptBoundary(promise, timeoutMs, disposeLate) {
  let timedOut = false;
  let timer;
  const source = Promise.resolve(promise);
  void source.then(value => {
    if (!timedOut) return;
    void Promise.resolve().then(() => disposeLate(value)).catch(() => {});
  }, () => {});
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new DOMException('Operação excedeu o tempo limite.', 'TimeoutError'));
    }, timeoutMs);
  });
  return Promise.race([source, timeout]).finally(() => clearTimeout(timer));
}

function dedupeIssues(issues) {
  const byCode = new Map();
  for (const issue of issues) if (issue?.code && issue?.message && !byCode.has(issue.code)) byCode.set(issue.code, issue);
  return [...byCode.values()];
}

function sanitizeReportMessages(value) {
  const model = structuredClone(value);
  if (Array.isArray(model?.limitations)) model.limitations = model.limitations.map(sanitizeFailureText);
  if (Array.isArray(model?.session?.diagnostics)) {
    model.session.diagnostics = model.session.diagnostics.map(entry => ({
      ...entry,
      message: sanitizeFailureText(entry.message),
      ...(Object.hasOwn(entry, 'details') ? { details: sanitizeFailureValue(entry.details) } : {}),
    }));
  }
  if (Array.isArray(model?.report?.artifact?.limitations)) {
    model.report.artifact.limitations = model.report.artifact.limitations.map(sanitizeFailureText);
  }
  return model;
}

function sanitizeFailureValue(value) {
  if (typeof value === 'string') return sanitizeFailureText(value);
  if (Array.isArray(value)) return value.map(sanitizeFailureValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, sanitizeFailureValue(child)]));
}

function sanitizeFailureText(value) {
  const text = typeof value === 'string' ? value : 'Limitação técnica não detalhada.';
  return text
    .replace(/\b(?:blob:[^\s<>"']+|(?:https?|chrome-extension):\/\/[^\s<>"']+)/giu, '[endereço omitido]')
    .replace(/\b(?:token|password|passwd|pass|secret|auth|session|otp|api[-_]?key)\s*[:=]\s*[^\s,;]+/giu, '[credencial redigida]')
    .replace(/\b[A-Z0-9_-]*SECRET[A-Z0-9_-]*\b/giu, '[redigido]')
    .replace(/\s+/gu, ' ')
    .trim() || 'Limitação técnica não detalhada.';
}
