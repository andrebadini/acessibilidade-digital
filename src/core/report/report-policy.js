import {
  PDF_GENERATION_FAILURE_CODES,
  REPORT_GENERATION_ISSUE_CODES,
} from './diagnostic-policy.js';
import { canonicalStringify } from './canonical-json.js';
import { EXPORT_FORMATS_V1 } from '../../export/export-formats.js';

const GENERATION_CODES = new Set([...REPORT_GENERATION_ISSUE_CODES, 'REPORT_EXPORT_PREPARATION_FAILED']);
const PDF_FAILURE_CODES = new Set(PDF_GENERATION_FAILURE_CODES);

export function validateReportState(model) {
  const report = model.report;
  if (!report || typeof report !== 'object' || Array.isArray(report) ||
    canonicalStringify(Object.keys(report).sort()) !== canonicalStringify(['artifact', 'reviewUrl', 'status'])) {
    throw new TypeError('Estado do relatório inválido.');
  }
  if (['pending', 'review-ready'].includes(report.status)) {
    validatePendingReport(report);
    return report;
  }
  if (!['complete', 'partial'].includes(report.status) || report.reviewUrl !== null) {
    throw new TypeError('Estado final do relatório inválido.');
  }

  const generationDiagnostics = model.session.diagnostics.filter(entry => GENERATION_CODES.has(entry.code));
  const generationCodes = new Set(generationDiagnostics.map(entry => entry.code));
  const pdfCauses = generationDiagnostics.filter(entry => PDF_FAILURE_CODES.has(entry.code));
  if (pdfCauses.length > 1 ||
    (generationCodes.has('REPORT_EXPORT_PREPARATION_FAILED') && generationDiagnostics.length !== 1)) {
    throw new TypeError('Diagnósticos da tentativa de geração são concorrentes ou causalmente incompatíveis.');
  }
  const artifact = report.artifact;
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact) ||
    canonicalStringify(Object.keys(artifact).sort()) !==
      canonicalStringify(['formats', 'limitations', 'pdfFallback', 'status'].sort()) ||
    !['complete', 'partial'].includes(artifact.status) || typeof artifact.pdfFallback !== 'boolean' ||
    !Array.isArray(artifact.formats) || !Array.isArray(artifact.limitations)) {
    throw new TypeError('Artefato final do relatório inválido.');
  }

  const formats = validatePreparedFormats(artifact.formats);
  const expectedLimitations = generationDiagnostics.map(entry => entry.message);
  if (canonicalStringify(artifact.limitations) !== canonicalStringify(expectedLimitations)) {
    throw new TypeError('Limitações do artefato divergem dos diagnósticos da geração atual.');
  }
  const hasPreparationFailure = generationCodes.has('REPORT_EXPORT_PREPARATION_FAILED');
  if (hasPreparationFailure !== (formats.length === 0)) {
    throw new TypeError('Falha de preparação e lista de formatos são incoerentes.');
  }
  if (formats.length > 0 && (!formats.includes('html') || !formats.includes('json'))) {
    throw new TypeError('A geração preparada deve conter HTML e JSON.');
  }
  const pdfFailed = [...generationCodes].some(code => PDF_FAILURE_CODES.has(code));
  const csvFailed = generationCodes.has('REPORT_CSV_UNAVAILABLE');
  const taggingFallback = generationCodes.has('REPORT_PDF_TAGGING_UNSUPPORTED');
  // A exportação por formato pode preparar só o que foi pedido: ausência de CSV ou PDF
  // sem diagnóstico significa "não pedido", não falha. O que continua proibido é um
  // diagnóstico de falha conviver com o formato declarado como preparado.
  if ((pdfFailed && formats.includes('pdf')) || (csvFailed && formats.includes('csv')) ||
    artifact.pdfFallback !== taggingFallback || (taggingFallback && pdfFailed)) {
    throw new TypeError('Formatos preparados contradizem os diagnósticos da geração.');
  }
  const expectedArtifactStatus = generationDiagnostics.length === 0 ? 'complete' : 'partial';
  const expectedReportStatus = generationDiagnostics.length === 0 && model.session.status === 'complete'
    ? 'complete' : 'partial';
  if (artifact.status !== expectedArtifactStatus || report.status !== expectedReportStatus) {
    throw new TypeError('Status do relatório diverge da execução e da geração atual.');
  }
  return report;
}

export function isCanonicalInternalReviewUrl(value, auditId, expectedExtensionId) {
  if (value === null) return true;
  if (typeof value !== 'string' || value.length < 1 || value.length > 2_048 || value !== value.trim() ||
    typeof auditId !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/u.test(auditId)) return false;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'chrome-extension:' || !/^[a-p]{32}$/u.test(parsed.hostname) ||
      (expectedExtensionId !== undefined &&
        (!/^[a-p]{32}$/u.test(expectedExtensionId) || parsed.hostname !== expectedExtensionId)) ||
      parsed.username || parsed.password || parsed.hash || parsed.pathname !== '/src/review/index.html' ||
      [...parsed.searchParams.keys()].length !== 1 || parsed.searchParams.getAll('auditId').length !== 1 ||
      parsed.searchParams.get('auditId') !== auditId) return false;
    const expected = new URL(`chrome-extension://${parsed.hostname}/src/review/index.html`);
    expected.searchParams.set('auditId', auditId);
    return parsed.href === expected.href && value === expected.href;
  } catch {
    return false;
  }
}

export function canonicalInternalReviewUrl(value, auditId, expectedExtensionId) {
  if (value !== null && !/^[a-p]{32}$/u.test(expectedExtensionId ?? '') ||
    !isCanonicalInternalReviewUrl(value, auditId, expectedExtensionId)) {
    throw new TypeError('URL interna de revisão inválida.');
  }
  return value;
}

export function preparedReportFormats({ hasCsv, hasPdf }) {
  return EXPORT_FORMATS_V1.filter(format => (format !== 'csv' || hasCsv) && (format !== 'pdf' || hasPdf))
    .map(format => ({ format, status: 'prepared' }));
}

function validatePendingReport(report) {
  const artifact = report.artifact;
  if (report.reviewUrl !== null ||
    !artifact || typeof artifact !== 'object' || Array.isArray(artifact) ||
    canonicalStringify(Object.keys(artifact).sort()) !== canonicalStringify(['formats', 'status']) ||
    artifact.status !== 'pending' || !Array.isArray(artifact.formats) || artifact.formats.length !== 0) {
    throw new TypeError('Relatório pendente possui alegação de artefato ou URL incoerente.');
  }
}

function validatePreparedFormats(entries) {
  const formats = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
      canonicalStringify(Object.keys(entry).sort()) !== canonicalStringify(['format', 'status']) ||
      entry.status !== 'prepared' || !EXPORT_FORMATS_V1.includes(entry.format) || formats.includes(entry.format)) {
      throw new TypeError('Formato preparado inválido ou duplicado.');
    }
    formats.push(entry.format);
  }
  const expected = EXPORT_FORMATS_V1.filter(format => formats.includes(format));
  if (canonicalStringify(formats) !== canonicalStringify(expected)) {
    throw new TypeError('Formatos preparados estão fora da ordem canônica.');
  }
  return formats;
}
