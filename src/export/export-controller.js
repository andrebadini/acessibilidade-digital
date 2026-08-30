import {
  createExportIssue,
  PDF_GENERATION_FAILURE_CODES,
  REPORT_GENERATION_ISSUE_CODES,
} from './export-issues.js';
import { canonicalStringify } from '../core/report/canonical-json.js';
import {
  finalizeGeneratedModel,
  generatedReportExportAttempt,
  generatedReportExportLeaseOwnerId,
  generatedReportExportSnapshotCapability,
  isGeneratedReportExportResult,
  verifyGeneratedReportExportResult,
} from './report-export.js';
import { inspectAuditSnapshotCapability } from '../storage/audit-store.js';
import { renderOccurrenceCsv } from '../core/report/csv.js';
import { renderTechnicalJson } from '../core/report/earl-json.js';
import { renderHtmlReport } from '../core/report/html.js';
import { sha256Hex } from '../core/report/hash.js';
import { verifyAuditIntegritySnapshot } from '../core/report/integrity.js';
import {
  ARTIFACT_FAILURE_CONTRACT,
  artifactCleanupLimitation,
  artifactFailureLimitation,
  bindDeliveryArtifactBaseName,
  buildArtifactBaseName,
} from '../browser/download-artifacts.js';

import { EXPORT_FORMATS_V1 } from './export-formats.js';
const REQUIRED_FORMATS = new Set(['html', 'json']);
const PRINT_CLEANUP_LIMITATION = createExportIssue('REPORT_PRINT_CLEANUP_LIMITED').message;
const RESULT_KEYS = new Set([
  'model', 'html', 'json', 'csv', 'pdf', 'formats', 'deliveryReceipt', 'limitations', 'pdfFallback',
]);
const SUCCESS_REQUESTS = new WeakMap();
const FAILURE_REQUESTS = new WeakMap();

/**
 * Creates the only request capability accepted by failure persistence. Callers
 * never get access to the persistence snapshot stored behind this token.
 */
export function createExportFailureRequest(request) {
  const outer = cloneOuterRecord(
    request,
    new Set(['snapshotCapability', 'leaseOwnerId', 'exportAttempt', 'latest', 'at']),
    ['snapshotCapability', 'leaseOwnerId', 'exportAttempt'],
    'Solicitação de falha de exportação',
  );
  const snapshot = inspectAuditSnapshotCapability(outer.snapshotCapability);
  if (!snapshot) throw new TypeError('Capacidade de snapshot da auditoria inválida para persistência.');
  const auditId = validAuditId(snapshot.auditId);
  const leaseOwnerId = validAuditId(outer.leaseOwnerId);
  const exportAttempt = validExportAttempt(outer.exportAttempt);
  let envelope;
  try {
    const source = { auditId, model: snapshot.model };
    if (outer.latest !== undefined) source.latest = outer.latest;
    if (outer.at !== undefined) source.at = outer.at;
    envelope = JSON.parse(canonicalStringify(source));
  } catch {
    throw new TypeError('Solicitação de falha de exportação contém proxy, propriedade não segura ou valor inválido.');
  }
  if (!envelope.model || !Object.hasOwn(envelope.model, 'auditId') || envelope.model.auditId !== auditId) {
    throw new TypeError('Modelo e auditId de exportação não estão correlacionados.');
  }
  const token = Object.freeze(Object.create(null));
  FAILURE_REQUESTS.set(token, Object.freeze({
    auditId,
    model: envelope.model,
    latest: safeLatest(envelope.latest, auditId),
    at: canonicalAt(envelope.at),
    expectedRevision: snapshot.revision,
    snapshotCapability: outer.snapshotCapability,
    leaseOwnerId,
    exportAttempt,
  }));
  return token;
}

/**
 * Creates a single-use persistence capability for one exact, privately issued
 * report result and one captured audit revision.
 */
export function createExportSuccessRequest(request) {
  const outer = cloneOuterRecord(
    request,
    new Set(['auditId', 'result', 'latest']),
    ['auditId', 'result'],
    'Solicitação de exportação',
  );
  const auditId = validAuditId(outer.auditId);
  if (!isGeneratedReportExportResult(outer.result)) {
    throw new TypeError('Resultado de exportação não foi emitido pela geração local confiável.');
  }
  const snapshotCapability = generatedReportExportSnapshotCapability(outer.result);
  const leaseOwnerId = generatedReportExportLeaseOwnerId(outer.result);
  const exportAttempt = generatedReportExportAttempt(outer.result);
  const snapshot = inspectAuditSnapshotCapability(snapshotCapability);
  if (!snapshot || snapshot.auditId !== auditId || !leaseOwnerId ||
    !Number.isSafeInteger(exportAttempt) || exportAttempt < 1) {
    throw new TypeError('Resultado e capacidade de snapshot da auditoria não estão correlacionados.');
  }
  const token = Object.freeze(Object.create(null));
  SUCCESS_REQUESTS.set(token, Object.freeze({
    auditId,
    result: outer.result,
    latest: snapshotLatest(outer.latest, auditId),
    expectedRevision: snapshot.revision,
    snapshotCapability,
    leaseOwnerId,
    exportAttempt,
  }));
  return token;
}

export async function persistExportFailure(request, store) {
  const envelope = consumeOpaqueRequest(FAILURE_REQUESTS, request, 'Solicitação de falha de exportação');
  assertRevisionStore(store);
  const { auditId, expectedRevision } = envelope;
  const issue = createExportIssue('REPORT_EXPORT_PREPARATION_FAILED');
  const model = await finalizeGeneratedModel(envelope.model, envelope.at, [issue], false, false, false);
  const latest = {
    ...envelope.latest,
    auditId,
    status: model.session.status,
    percent: 100,
    exportStatus: 'failed',
    exportRevision: expectedRevision + 1,
    message: issue.message,
    deliveryReceipt: { status: 'failed', formats: [], limitations: [issue.message] },
  };
  await store.commitAuditIfRevisionWithExportLease(
    auditId,
    model,
    latest,
    envelope.snapshotCapability,
    {
      ownerId: envelope.leaseOwnerId,
      exportAttempt: envelope.exportAttempt,
      now: new Date().toISOString(),
      release: true,
    },
  );
  return { model, latest };
}

export async function persistExportSuccess(request, store) {
  const envelope = consumeOpaqueRequest(SUCCESS_REQUESTS, request, 'Solicitação de exportação');
  assertSuccessStore(store);
  const { auditId, expectedRevision } = envelope;
  const outerResult = cloneOuterRecord(envelope.result, RESULT_KEYS, [...RESULT_KEYS], 'Resultado de exportação');
  let result;
  try {
    result = JSON.parse(canonicalStringify({
      model: outerResult.model,
      formats: outerResult.formats,
      json: outerResult.json,
      deliveryReceipt: outerResult.deliveryReceipt,
      limitations: outerResult.limitations,
    }));
  } catch {
    throw new TypeError('Resultado de exportação contém propriedade não segura ou valor inválido.');
  }
  const html = snapshotTextArtifact(outerResult.html, 'HTML');
  const csv = outerResult.csv === null ? null : snapshotTextArtifact(outerResult.csv, 'CSV');
  const pdf = outerResult.pdf === null ? null : snapshotPdfArtifact(outerResult.pdf);
  if (typeof outerResult.pdfFallback !== 'boolean') throw new TypeError('Estado de fallback PDF inválido no resultado de exportação.');
  const pdfFallback = outerResult.pdfFallback;
  const latestSnapshot = envelope.latest;
  let serializedModel;
  try { serializedModel = JSON.parse(result.json).audit; } catch {
    throw new TypeError('JSON técnico do resultado de exportação inválido.');
  }
  const verifiedModel = await verifyAuditIntegritySnapshot(result.model);
  if (!Object.hasOwn(serializedModel, 'auditId') || verifiedModel.auditId !== auditId || serializedModel.auditId !== auditId
    || canonicalStringify(serializedModel) !== canonicalStringify(verifiedModel)) {
    throw new TypeError('Resultado e auditId de exportação não estão correlacionados.');
  }
  const prepared = preparedArtifactFormats(verifiedModel);
  prepared.baseName = await bindDeliveryArtifactBaseName(
    prepared.baseName,
    envelope.leaseOwnerId,
    envelope.exportAttempt,
  );
  const receipt = normalizeDeliveryReceipt(result.deliveryReceipt, prepared);
  validateArtifactCorrelation({
    model: verifiedModel,
    html,
    json: result.json,
    csv,
    pdf,
    formats: result.formats,
    limitations: result.limitations,
    pdfFallback,
    receipt,
    prepared,
  });
  await validateArtifactHashes({ html, json: result.json, csv, pdf }, receipt.formats);
  const verifiedCapability = await verifyGeneratedReportExportResult(envelope.result, {
    model: verifiedModel,
    html,
    json: result.json,
    csv,
    pdf,
    formats: result.formats,
    deliveryReceipt: result.deliveryReceipt,
    limitations: result.limitations,
    pdfFallback,
  });
  if (verifiedCapability !== envelope.snapshotCapability) {
    throw new TypeError('Proveniência do snapshot de exportação inválida ou ausente.');
  }
  const exportStatus = prepared.missing.length > 0 || verifiedModel.report.artifact.status === 'partial' || receipt.status !== 'complete'
    ? 'partial'
    : 'complete';
  const latest = {
    ...latestSnapshot,
    auditId,
    status: verifiedModel.session.status,
    percent: 100,
    exportStatus,
    exportRevision: expectedRevision + 1,
    message: exportStatus === 'complete' ? 'Arquivos do relatório gerados.' : 'Relatório gerado com limitações.',
    deliveryReceipt: receipt,
  };
  const finalized = await store.finalizeExportAndMaybeDelete(
    auditId,
    verifiedModel,
    latest,
    envelope.snapshotCapability,
    {
      ownerId: envelope.leaseOwnerId,
      exportAttempt: envelope.exportAttempt,
      now: new Date().toISOString(),
      release: true,
      clearDeliveryJournal: true,
      deleteAfterCompleteExport: true,
    },
  );
  return { model: verifiedModel, latest, deleted: finalized?.deleted === true };
}

function normalizeDeliveryReceipt(value, preparedFormats) {
  let receipt;
  try { receipt = JSON.parse(canonicalStringify(value)); } catch {
    throw new TypeError('Recibo de entrega contém propriedade não segura ou valor inválido.');
  }
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) ||
    canonicalStringify(Object.keys(receipt).sort()) !== canonicalStringify(['formats', 'limitations', 'status']) ||
    !['complete', 'partial'].includes(receipt.status) || !Array.isArray(receipt.formats) ||
    !Array.isArray(receipt.limitations)) {
    throw new TypeError('Recibo de entrega inválido.');
  }
  const expectedMime = {
    html: 'text/html;charset=utf-8',
    json: 'application/json;charset=utf-8',
    csv: 'text/csv;charset=utf-8',
    pdf: 'application/pdf',
  };
  const seen = new Set();
  const seenDownloadIds = new Set();
  let commonBaseName = null;
  const formats = receipt.formats.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
      !['complete', 'timeout', 'interrupted'].includes(entry.status) ||
      !Object.hasOwn(expectedMime, entry.format) || seen.has(entry.format) ||
      entry.format !== preparedFormats.formats[index]) {
      throw new TypeError('Formato duplicado, desconhecido ou fora de ordem no recibo de entrega.');
    }
    const keys = Object.keys(entry).sort();
    const complete = entry.status === 'complete';
    const failure = complete ? null : ARTIFACT_FAILURE_CONTRACT[entry.failureCode];
    const hasDownloadId = Object.hasOwn(entry, 'downloadId');
    const expectedKeys = [
      'filename', 'format', 'mimeType', 'sha256', 'status',
      ...(complete ? ['byteSize'] : []),
      ...(complete ? [] : ['failureCode']),
      ...((complete || failure?.hasDownloadId) ? ['downloadId'] : []),
    ].sort();
    const hashValid = complete || failure?.hasHash
      ? typeof entry.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(entry.sha256)
      : entry.sha256 === null;
    if (!failure && !complete || canonicalStringify(keys) !== canonicalStringify(expectedKeys) ||
      typeof entry.filename !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9.-]{0,240}$/u.test(entry.filename) ||
      !entry.filename.endsWith(`.${entry.format}`) || entry.mimeType !== expectedMime[entry.format] || !hashValid ||
      (complete && (!Number.isSafeInteger(entry.byteSize) || entry.byteSize < 0)) ||
      (hasDownloadId && (!Number.isSafeInteger(entry.downloadId) || entry.downloadId < 0)) ||
      (complete && !hasDownloadId) || (!complete && entry.status !== failure.status)) {
      throw new TypeError('Formato no recibo de entrega possui arquivo, MIME, hash ou status inválido.');
    }
    if (hasDownloadId && seenDownloadIds.has(entry.downloadId)) {
      throw new TypeError('ID de download duplicado no recibo de entrega.');
    }
    if (hasDownloadId) seenDownloadIds.add(entry.downloadId);
    const baseName = entry.filename.slice(0, -(entry.format.length + 1));
    if (commonBaseName === null) commonBaseName = baseName;
    else if (baseName !== commonBaseName) throw new TypeError('Arquivos do recibo de entrega não compartilham o mesmo nome-base.');
    if (baseName !== preparedFormats.baseName) throw new TypeError('Nome-base do artefato no recibo de entrega não corresponde ao relatório.');
    seen.add(entry.format);
    return { ...entry };
  });
  if (formats.length !== preparedFormats.formats.length) throw new TypeError('Recibo de entrega não corresponde aos formatos preparados.');
  if (receipt.limitations.some(value => typeof value !== 'string' || !value.trim() || value.length > 1_000)) {
    throw new TypeError('Limitação no recibo de entrega inválida.');
  }
  const requiredLimitations = [
    ...preparedFormats.missingLimitations,
    ...formats.filter(entry => entry.status !== 'complete')
      .map(entry => artifactFailureLimitation(entry.format, entry.failureCode)),
  ];
  const allowedCleanup = new Set(formats
    .filter(entry => entry.status === 'complete' || entry.failureCode?.startsWith('DOWNLOAD_'))
    .map(entry => artifactCleanupLimitation(entry.format)));
  allowedCleanup.add(PRINT_CLEANUP_LIMITATION);
  const seenLimitations = new Set();
  for (const limitation of receipt.limitations) {
    if (seenLimitations.has(limitation) || (!requiredLimitations.includes(limitation) && !allowedCleanup.has(limitation))) {
      throw new TypeError('Limitação no recibo de entrega não corresponde a uma etapa controlada.');
    }
    seenLimitations.add(limitation);
  }
  if (requiredLimitations.some(limitation => !seenLimitations.has(limitation))) {
    throw new TypeError('Recibo de entrega omite a limitação controlada de um artefato.');
  }
  const limitations = [...receipt.limitations];
  const status = preparedFormats.missing.length === 0 && formats.every(entry => entry.status === 'complete') && limitations.length === 0
    ? 'complete'
    : 'partial';
  if (receipt.status !== status) throw new TypeError('Status do recibo de entrega inválido.');
  return { status, formats, limitations };
}

function preparedArtifactFormats(model) {
  const report = model?.report;
  const artifact = report?.artifact;
  const values = artifact?.formats;
  if (!report || !artifact || !['complete', 'partial'].includes(report.status) ||
    !['complete', 'partial'].includes(artifact.status) || typeof artifact.pdfFallback !== 'boolean' ||
    !Array.isArray(artifact.limitations) || !Array.isArray(values)) {
    throw new TypeError('Estado dos formatos preparados do relatório inválido.');
  }
  const formats = values.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
      canonicalStringify(Object.keys(entry).sort()) !== canonicalStringify(['format', 'status']) ||
      entry.status !== 'prepared' || !EXPORT_FORMATS_V1.includes(entry.format)) {
      throw new TypeError('Formatos preparados do relatório inválidos ou fora de ordem.');
    }
    return entry.format;
  });
  const expected = EXPORT_FORMATS_V1.filter(format => formats.includes(format));
  if ([...REQUIRED_FORMATS].some(format => !formats.includes(format)) ||
    canonicalStringify(formats) !== canonicalStringify(expected)) {
    throw new TypeError('Formatos preparados do relatório duplicados, incompletos ou fora de ordem.');
  }
  const missing = EXPORT_FORMATS_V1.filter(format => !formats.includes(format));
  const missingLimitations = [];
  const generatedAt = model.timestamps?.generatedAt;
  if (typeof generatedAt !== 'string' || new Date(generatedAt).toISOString() !== generatedAt) {
    throw new TypeError('Instante de geração do relatório inválido.');
  }
  if (!Array.isArray(model.session?.diagnostics) || !Array.isArray(model.limitations)) {
    throw new TypeError('Diagnósticos ou limitações do relatório inválidos.');
  }
  const diagnostics = model.session.diagnostics;
  const currentGenerationIssues = [];
  const seenIssueCodes = new Set();
  for (const diagnostic of diagnostics) {
    if (diagnostic?.at !== generatedAt || !REPORT_GENERATION_ISSUE_CODES.includes(diagnostic?.code)) continue;
    if (!diagnostic || typeof diagnostic !== 'object' || Array.isArray(diagnostic) ||
      canonicalStringify(Reflect.ownKeys(diagnostic).sort()) !== canonicalStringify(['at', 'code', 'message', 'recoverable']) ||
      diagnostic.message !== createExportIssue(diagnostic.code).message || diagnostic.recoverable !== true ||
      seenIssueCodes.has(diagnostic.code)) {
      throw new TypeError('Diagnóstico de geração duplicado ou fora do esquema controlado.');
    }
    seenIssueCodes.add(diagnostic.code);
    currentGenerationIssues.push(diagnostic);
  }
  const currentMessages = currentGenerationIssues.map(diagnostic => diagnostic.message);
  if (canonicalStringify(artifact.limitations) !== canonicalStringify(currentMessages) ||
    currentMessages.some(message => !model.limitations.includes(message))) {
    throw new TypeError('Limitações do artefato não correspondem aos diagnósticos controlados da geração atual.');
  }
  if (currentGenerationIssues.length > 0) {
    if (artifact.status !== 'partial' || report.status !== 'partial') {
      throw new TypeError('Diagnósticos de geração exigem artefato e relatório parciais.');
    }
  } else {
    const expectedReportStatus = model.session?.status === 'complete' ? 'complete' : 'partial';
    if (artifact.status !== 'complete' || report.status !== expectedReportStatus) {
      throw new TypeError('Status do artefato ou relatório não corresponde aos diagnósticos de geração.');
    }
  }
  const taggingIssues = currentGenerationIssues.filter(diagnostic => diagnostic.code === 'REPORT_PDF_TAGGING_UNSUPPORTED');
  if (artifact.pdfFallback !== (taggingIssues.length === 1)) {
    throw new TypeError('Fallback PDF não corresponde ao diagnóstico controlado da geração atual.');
  }
  if (missing.length > 0) {
    if (artifact.status !== 'partial' || report.status !== 'partial' ||
      !Array.isArray(model.session.diagnostics) || !Array.isArray(model.limitations)) {
      throw new TypeError('Omissão de formato exige relatório e artefato parciais.');
    }
    if (missing.includes('pdf') && artifact.pdfFallback !== false) {
      throw new TypeError('PDF ausente não pode declarar fallback gerado.');
    }
    for (const format of missing) {
      const codes = format === 'csv' ? ['REPORT_CSV_UNAVAILABLE'] : PDF_GENERATION_FAILURE_CODES;
      const matching = currentGenerationIssues.filter(diagnostic => codes.includes(diagnostic.code));
      if (matching.length !== 1) {
        throw new TypeError(`O formato ${format.toUpperCase()} ausente não possui diagnóstico e limitação de geração controlados.`);
      }
      missingLimitations.push(matching[0].message);
    }
  }
  const currentCsvUnavailable = currentGenerationIssues.some(diagnostic => diagnostic.code === 'REPORT_CSV_UNAVAILABLE');
  const currentPdfUnavailable = currentGenerationIssues.some(diagnostic => PDF_GENERATION_FAILURE_CODES.includes(diagnostic.code));
  if (formats.includes('csv') && currentCsvUnavailable || formats.includes('pdf') && currentPdfUnavailable) {
    throw new TypeError('Diagnóstico de geração não corresponde aos formatos preparados.');
  }
  return { formats, missing, missingLimitations, baseName: buildArtifactBaseName(model.auditId, generatedAt) };
}

function snapshotLatest(value, auditId) {
  let clone;
  try { clone = value === undefined ? {} : JSON.parse(canonicalStringify(value)); } catch {
    throw new TypeError('Estado mais recente contém propriedade não segura ou valor inválido.');
  }
  if (!clone || typeof clone !== 'object' || Array.isArray(clone) || (clone.auditId !== undefined && clone.auditId !== auditId)) return {};
  delete clone.message;
  delete clone.deliveryReceipt;
  return clone;
}

function safeLatest(value, auditId) {
  try { return snapshotLatest(value, auditId); } catch { return {}; }
}

function validateArtifactCorrelation({
  model, html, json, csv, pdf, formats, limitations, pdfFallback, receipt, prepared,
}) {
  if (canonicalStringify(formats) !== canonicalStringify(receipt.formats)) {
    throw new TypeError('Formatos do resultado e do recibo de entrega não estão correlacionados.');
  }
  if (pdfFallback !== model.report.artifact.pdfFallback) {
    throw new TypeError('Estado de fallback PDF não corresponde ao modelo final.');
  }
  const hasCsv = prepared.formats.includes('csv');
  const hasPdf = prepared.formats.includes('pdf');
  if (hasCsv !== (csv !== null) || hasPdf !== (pdf !== null)) {
    throw new TypeError('Artefatos CSV ou PDF não correspondem aos formatos preparados.');
  }
  if (html !== renderHtmlReport(model) || json !== renderTechnicalJson(model)) {
    throw new TypeError('HTML ou JSON técnico não corresponde ao modelo final.');
  }
  if (hasCsv && (csv !== renderOccurrenceCsv(model) || !csv.startsWith('\uFEFF'))) {
    throw new TypeError('CSV não corresponde às ocorrências do modelo final.');
  }
  const expectedLimitations = [...new Set([...model.report.artifact.limitations, ...receipt.limitations])];
  if (canonicalStringify(limitations) !== canonicalStringify(expectedLimitations)) {
    throw new TypeError('Limitações do resultado não correspondem às etapas controladas.');
  }
}

async function validateArtifactHashes(artifacts, formats) {
  for (const entry of formats) {
    if (entry.sha256 === null) continue;
    const artifact = artifacts[entry.format];
    const byteSize = typeof artifact === 'string'
      ? new TextEncoder().encode(artifact).byteLength
      : artifact?.byteLength;
    if (artifact === null || artifact === undefined || await sha256Hex(artifact) !== entry.sha256 ||
      (entry.status === 'complete' && byteSize !== entry.byteSize)) {
      throw new TypeError(`Hash do artefato ${entry.format.toUpperCase()} não corresponde ao resultado.`);
    }
  }
}

function snapshotTextArtifact(value, format) {
  if (typeof value !== 'string') throw new TypeError(`Artefato ${format} inválido no resultado de exportação.`);
  return value;
}

function snapshotPdfArtifact(value) {
  let source;
  if (value instanceof ArrayBuffer) source = new Uint8Array(value);
  else if (ArrayBuffer.isView(value)) source = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  else throw new TypeError('Artefato PDF inválido no resultado de exportação.');
  const bytes = Uint8Array.from(source);
  if (bytes.length < 5 || bytes[0] !== 0x25 || bytes[1] !== 0x50 || bytes[2] !== 0x44 || bytes[3] !== 0x46 || bytes[4] !== 0x2d) {
    throw new TypeError('Artefato PDF não possui assinatura válida.');
  }
  return bytes;
}

function consumeOpaqueRequest(registry, request, label) {
  if (!request || typeof request !== 'object') {
    throw new TypeError(`${label} inválida ou já consumida.`);
  }
  const envelope = registry.get(request);
  if (!envelope) throw new TypeError(`${label} inválida ou já consumida.`);
  registry.delete(request);
  return envelope;
}

function assertRevisionStore(store) {
  if (!store || typeof store.commitAuditIfRevisionWithExportLease !== 'function') {
    throw new TypeError('Store de auditoria sem lease e compare-and-swap de exportação.');
  }
}

function assertSuccessStore(store) {
  assertRevisionStore(store);
  if (typeof store.finalizeExportAndMaybeDelete !== 'function') {
    throw new TypeError('Store de auditoria sem finalização atômica de retenção.');
  }
}

function cloneOuterRecord(value, allowedKeys, requiredKeys, label) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError();
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key !== 'string' || !allowedKeys.has(key))) throw new TypeError();
    const clone = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new TypeError();
      clone[key] = descriptor.value;
    }
    if (requiredKeys.some(key => !Object.hasOwn(clone, key))) throw new TypeError();
    return clone;
  } catch {
    throw new TypeError(`${label} contém propriedade não segura ou esquema inválido.`);
  }
}

function validAuditId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/u.test(value)) throw new TypeError('auditId de exportação inválido.');
  return value;
}

function validExportAttempt(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('Tentativa de exportação inválida.');
  return value;
}

function canonicalAt(value) {
  const raw = value ?? new Date().toISOString();
  const date = raw instanceof Date ? raw : new Date(raw);
  if (!Number.isFinite(date.getTime())) throw new TypeError('Instante de exportação inválido.');
  return date.toISOString();
}
