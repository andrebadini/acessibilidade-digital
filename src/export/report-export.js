import { downloadArtifacts, buildArtifactBaseName } from '../browser/download-artifacts.js';
import { renderPdf } from '../browser/render-pdf.js';
import { renderOccurrenceCsv } from '../core/report/csv.js';
import { canonicalStringify } from '../core/report/canonical-json.js';
import { renderTechnicalJson } from '../core/report/earl-json.js';
import { enrichAuditForReport } from '../core/report/enrich-audit.js';
import { renderHtmlReport } from '../core/report/html.js';
import { createExportIssue, issueForPrintStage, PDF_GENERATION_FAILURE_CODES } from './export-issues.js';
import { attestReportExportResult } from './export-provenance.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const PDF_COMMAND_TIMEOUT_MS = 45_000;
const MAX_FINALIZATION_PASSES = 6;

class OwnershipTransferTimeoutError extends DOMException {
  constructor() {
    super('Operação excedeu o tempo limite.', 'TimeoutError');
  }
}

export async function runReportExport(request, dependencies) {
  validateDependencies(dependencies);
  const original = sanitizeReportMessages(request?.auditModel);
  const at = canonicalNow(request?.now);
  const timeoutMs = request?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('Timeout de exportação inválido.');
  const generationIssues = [];
  const printCleanupLimitations = [];
  let hasCsv = true;
  let hasPdf = true;
  let expectedPdfFallback = false;
  let model = null;
  let html = null;
  let json = null;
  let csv = null;
  let pdf = null;
  let pdfFallback = false;
  let settled = false;

  for (let pass = 0; pass < MAX_FINALIZATION_PASSES; pass += 1) {
    model = await finalizeGeneratedModel(original, at, generationIssues, hasPdf, expectedPdfFallback, true, hasCsv);
    html = renderHtmlReport(model);
    json = renderTechnicalJson(model);

    if (hasCsv) {
      try {
        csv = renderCanonicalCsv(model, dependencies.csvRenderer);
      } catch {
        csv = null;
        hasCsv = false;
        addIssue(generationIssues, createExportIssue('REPORT_CSV_UNAVAILABLE'));
        continue;
      }
    } else {
      csv = null;
    }

    if (!hasPdf) {
      pdf = null;
      pdfFallback = false;
      settled = true;
      break;
    }

    const printed = await printFinalHtml(html, dependencies, timeoutMs, expectedPdfFallback);
    if (printed.cleanupLimited) {
      addUnique(printCleanupLimitations, createExportIssue('REPORT_PRINT_CLEANUP_LIMITED').message);
    }
    if (printed.issue) {
      hasPdf = false;
      expectedPdfFallback = false;
      removeIssue(generationIssues, 'REPORT_PDF_TAGGING_UNSUPPORTED');
      addIssue(generationIssues, printed.issue);
      continue;
    }
    if (printed.usedFallback !== expectedPdfFallback) {
      if (!expectedPdfFallback && printed.usedFallback) {
        expectedPdfFallback = true;
        addIssue(generationIssues, createExportIssue('REPORT_PDF_TAGGING_UNSUPPORTED'));
      } else {
        hasPdf = false;
        expectedPdfFallback = false;
        removeIssue(generationIssues, 'REPORT_PDF_TAGGING_UNSUPPORTED');
        addIssue(generationIssues, createExportIssue('REPORT_PDF_UNAVAILABLE'));
      }
      continue;
    }
    pdf = printed.bytes;
    pdfFallback = expectedPdfFallback;
    settled = true;
    break;
  }

  if (!settled) {
    hasCsv = false;
    hasPdf = false;
    expectedPdfFallback = false;
    csv = null;
    pdf = null;
    pdfFallback = false;
    removeIssue(generationIssues, 'REPORT_PDF_TAGGING_UNSUPPORTED');
    addIssue(generationIssues, createExportIssue('REPORT_CSV_UNAVAILABLE'));
    addIssue(generationIssues, createExportIssue('REPORT_PDF_UNAVAILABLE'));
    model = await finalizeGeneratedModel(original, at, generationIssues, false, false, true, false);
    html = renderHtmlReport(model);
    json = renderTechnicalJson(model);
  }

  const baseName = buildArtifactBaseName(model.finalUrl, at);
  const downloads = await downloadArtifacts({
    baseName, html, json, ...(csv === null ? {} : { csv }), ...(pdf ? { pdf } : {}),
  }, dependencies.downloadsAdapter, { timeoutMs });
  const missingGenerationLimitations = [];
  if (csv === null) missingGenerationLimitations.push(createExportIssue('REPORT_CSV_UNAVAILABLE').message);
  if (!pdf) {
    const pdfIssue = generationIssues.find(issue => PDF_GENERATION_FAILURE_CODES.includes(issue.code));
    missingGenerationLimitations.push((pdfIssue ?? createExportIssue('REPORT_PDF_UNAVAILABLE')).message);
  }
  const deliveryLimitations = [...new Set([
    ...missingGenerationLimitations,
    ...printCleanupLimitations,
    ...downloads.limitations,
  ])];
  const deliveryReceipt = {
    status: downloads.formats.length === 4 && downloads.formats.every(format => format.status === 'complete') && deliveryLimitations.length === 0
      ? 'complete'
      : 'partial',
    formats: downloads.formats,
    limitations: deliveryLimitations,
  };
  const result = {
    model,
    html,
    json,
    csv,
    pdf,
    formats: downloads.formats,
    deliveryReceipt,
    limitations: [...new Set([
      ...generationIssues.map(issue => issue.message),
      ...printCleanupLimitations,
      ...downloads.limitations,
    ])],
    pdfFallback,
  };
  return attestReportExportResult(result);
}

async function printFinalHtml(html, dependencies, timeoutMs, forceCompatible) {
  let bytes = null;
  let usedFallback = false;
  let issue = null;
  let cleanupLimited = false;
  let printUrl = null;
  let tabId = null;
  let cdp = null;
  let stage = 'blob';
  try {
    printUrl = dependencies.urlApi.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
    if (typeof printUrl !== 'string' || !printUrl.startsWith('blob:')) {
      throw new TypeError('A preparação da impressão não forneceu Blob URL válido.');
    }
    stage = 'tab';
    const tab = await adoptBoundary(
      dependencies.tabAdapter.createPrintTab({ url: printUrl, active: false }), timeoutMs,
      lateTab => {
        try { return dependencies.tabAdapter.removeTab(snapshotTabId(lateTab)); } catch { return undefined; }
      },
    );
    tabId = snapshotTabId(tab);
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
    const renderedPdf = await boundary(
      (dependencies.pdfRenderer ?? renderPdf)(cdp, forceCompatible ? { forceCompatible: true } : undefined),
      Math.max(timeoutMs, PDF_COMMAND_TIMEOUT_MS + 5_000),
      'A impressão do PDF excedeu o tempo limite.',
    );
    const checkedPdf = snapshotPdfResult(renderedPdf);
    bytes = checkedPdf.bytes;
    usedFallback = checkedPdf.usedFallback;
  } catch (error) {
    if (error instanceof OwnershipTransferTimeoutError) cleanupLimited = true;
    issue = issueForPrintStage(stage, error);
  } finally {
    if (cdp) {
      try { await boundary(cdp.disconnect(), timeoutMs, 'A desconexão de impressão excedeu o tempo limite.'); } catch { cleanupLimited = true; }
    }
    if (tabId !== null) {
      try { await boundary(dependencies.tabAdapter.removeTab(tabId), timeoutMs, 'A remoção da aba de impressão excedeu o tempo limite.'); } catch { cleanupLimited = true; }
    }
    if (printUrl !== null) {
      try { dependencies.urlApi.revokeObjectURL(printUrl); } catch { cleanupLimited = true; }
    }
  }
  return { bytes, usedFallback, issue, cleanupLimited };
}

function renderCanonicalCsv(model, csvRenderer) {
  const canonicalCsv = renderOccurrenceCsv(model);
  const renderedCsv = csvRenderer ? csvRenderer(model) : canonicalCsv;
  if (typeof renderedCsv !== 'string' || renderedCsv !== canonicalCsv) {
    throw new TypeError('O renderizador CSV não retornou a projeção canônica esperada.');
  }
  return renderedCsv;
}

export async function finalizeGeneratedModel(model, at, issues, hasPdf, pdfFallback = false, artifactsPrepared = true, hasCsv = true) {
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
        ? ['html', 'json', ...(hasCsv ? ['csv'] : []), ...(hasPdf ? ['pdf'] : [])]
          .map(format => ({ format, status: 'prepared' }))
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

function snapshotPdfResult(value) {
  if (value === null || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError('O renderizador PDF não retornou um registro válido.');
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 3 || !['bytes', 'usedFallback', 'limitations'].every(key => keys.includes(key))) {
    throw new TypeError('O renderizador PDF não retornou o esquema esperado.');
  }
  const fields = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
      throw new TypeError('O renderizador PDF retornou campos inseguros.');
    }
    fields[key] = descriptor.value;
  }
  if (typeof fields.usedFallback !== 'boolean' || !Array.isArray(fields.limitations)) {
    throw new TypeError('O renderizador PDF retornou metadados inválidos.');
  }
  const limitations = snapshotStringArray(fields.limitations);
  if (!fields.usedFallback && limitations.length !== 0) {
    throw new TypeError('O renderizador PDF retornou limitações incompatíveis.');
  }
  const bytes = snapshotPdfBytes(fields.bytes);
  try { structuredClone(value); } catch { throw new TypeError('O renderizador PDF retornou proxy ou valor inseguro.'); }
  return { bytes, usedFallback: fields.usedFallback };
}

function snapshotTabId(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError('A aba de impressão não forneceu registro válido.');
  }
  const keys = Reflect.ownKeys(value);
  if (!keys.includes('id')) throw new TypeError('A aba de impressão não forneceu ID válido.');
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError('A aba de impressão retornou propriedade insegura.');
    }
  }
  const id = Object.getOwnPropertyDescriptor(value, 'id').value;
  if (!Number.isSafeInteger(id) || id < 0) throw new TypeError('A aba de impressão não forneceu ID válido.');
  try { structuredClone(value); } catch { throw new TypeError('A aba de impressão retornou proxy ou valor inseguro.'); }
  return id;
}

function snapshotStringArray(value) {
  if (Object.getPrototypeOf(value) !== Array.prototype) throw new TypeError('Lista de limitações PDF inválida.');
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, 'value') || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0 || lengthDescriptor.value > 8) {
    throw new TypeError('Lista de limitações PDF inválida.');
  }
  const values = [];
  for (let index = 0; index < lengthDescriptor.value; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable || typeof descriptor.value !== 'string') {
      throw new TypeError('Lista de limitações PDF inválida.');
    }
    values.push(descriptor.value);
  }
  if (Reflect.ownKeys(value).length !== lengthDescriptor.value + 1) throw new TypeError('Lista de limitações PDF inválida.');
  return values;
}

function snapshotPdfBytes(value) {
  let source;
  if (value instanceof ArrayBuffer) {
    source = new Uint8Array(value);
  } else if (ArrayBuffer.isView(value)) {
    source = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  } else {
    throw new TypeError('O renderizador PDF não retornou bytes válidos.');
  }
  const bytes = Uint8Array.from(source);
  if (bytes.length < 5 || bytes[0] !== 0x25 || bytes[1] !== 0x50 || bytes[2] !== 0x44 || bytes[3] !== 0x46 || bytes[4] !== 0x2d) {
    throw new TypeError('O renderizador PDF não retornou assinatura válida.');
  }
  return bytes;
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
      reject(new OwnershipTransferTimeoutError());
    }, timeoutMs);
  });
  return Promise.race([source, timeout]).finally(() => clearTimeout(timer));
}

function dedupeIssues(issues) {
  const byCode = new Map();
  for (const issue of issues) if (issue?.code && issue?.message && !byCode.has(issue.code)) byCode.set(issue.code, issue);
  return [...byCode.values()];
}

function addIssue(issues, issue) {
  if (!issues.some(current => current.code === issue.code)) issues.push(issue);
}

function removeIssue(issues, code) {
  const index = issues.findIndex(issue => issue.code === code);
  if (index >= 0) issues.splice(index, 1);
}

function addUnique(values, value) {
  if (!values.includes(value)) values.push(value);
}

function sanitizeReportMessages(value) {
  let model;
  try {
    const serialized = canonicalStringify(value);
    structuredClone(value);
    model = JSON.parse(serialized);
  } catch {
    throw new TypeError('Modelo de auditoria contém propriedade não segura ou valor inválido.');
  }
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
