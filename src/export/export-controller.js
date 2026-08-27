import { createExportIssue } from './export-issues.js';
import { canonicalStringify } from '../core/report/canonical-json.js';
import { finalizeGeneratedModel } from './report-export.js';

export async function persistExportFailure(request, store) {
  if (!store || typeof store.commitAudit !== 'function') throw new TypeError('Store de auditoria inválido.');
  const auditId = validAuditId(request?.auditId);
  if (!request?.model || !Object.hasOwn(request.model, 'auditId') || request.model.auditId !== auditId) throw new TypeError('Modelo e auditId de exportação não estão correlacionados.');
  const at = canonicalNow(request.now);
  const issue = createExportIssue('REPORT_EXPORT_PREPARATION_FAILED');
  const model = await finalizeGeneratedModel(request.model, at, [issue], false, false, false);
  const latest = {
    ...(safeLatest(request.latest, auditId)),
    auditId,
    status: model.session.status,
    percent: 100,
    exportStatus: 'failed',
    message: issue.message,
    deliveryReceipt: { status: 'failed', formats: [], limitations: [issue.message] },
  };
  await store.commitAudit(auditId, model, latest);
  return { model, latest };
}

export async function persistExportSuccess(request, store) {
  if (!store || typeof store.commitAudit !== 'function') throw new TypeError('Store de auditoria inválido.');
  const auditId = validAuditId(request?.auditId);
  const result = request?.result;
  const serializedModel = JSON.parse(result?.json).audit;
  if (!result?.model || !Object.hasOwn(result.model, 'auditId') || !Object.hasOwn(serializedModel, 'auditId')
    || result.model.auditId !== auditId || serializedModel.auditId !== auditId
    || canonicalStringify(serializedModel) !== canonicalStringify(result.model)) {
    throw new TypeError('Resultado e auditId de exportação não estão correlacionados.');
  }
  const receipt = normalizeDeliveryReceipt(result.deliveryReceipt);
  const exportStatus = result.model.report?.artifact?.status === 'partial' || receipt.status !== 'complete' ? 'partial' : 'complete';
  const latest = {
    ...safeLatest(request.latest, auditId),
    auditId,
    status: result.model.session.status,
    percent: 100,
    exportStatus,
    message: exportStatus === 'complete' ? 'Arquivos do relatório gerados.' : 'Relatório gerado com limitações.',
    deliveryReceipt: receipt,
  };
  await store.commitAudit(auditId, result.model, latest);
  return { model: result.model, latest };
}

function normalizeDeliveryReceipt(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.formats)) throw new TypeError('Recibo de entrega inválido.');
  const formats = value.formats.map(entry => {
    if (!entry || !['html', 'json', 'pdf'].includes(entry.format) || !['complete', 'timeout', 'interrupted'].includes(entry.status)) {
      throw new TypeError('Formato no recibo de entrega inválido.');
    }
    const normalized = { format: entry.format, status: entry.status };
    if (typeof entry.filename === 'string' && /^[A-Za-z0-9][A-Za-z0-9.-]{0,240}$/u.test(entry.filename)) normalized.filename = entry.filename;
    if (typeof entry.mimeType === 'string' && /^[a-z]+\/[a-z0-9.+-]+(?:;charset=utf-8)?$/u.test(entry.mimeType)) normalized.mimeType = entry.mimeType;
    if (Number.isSafeInteger(entry.downloadId) && entry.downloadId >= 0) normalized.downloadId = entry.downloadId;
    if (typeof entry.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(entry.sha256)) normalized.sha256 = entry.sha256;
    return normalized;
  });
  const limitations = formats.filter(entry => entry.status !== 'complete').map(entry => entry.status === 'timeout'
    ? `O artefato ${entry.format.toUpperCase()} excedeu o tempo limite de download.`
    : `O artefato ${entry.format.toUpperCase()} teve o download interrompido.`);
  if ((value.limitations?.length ?? 0) > limitations.length) limitations.push('A limpeza de um recurso temporário de download não pôde ser confirmada.');
  const status = formats.every(entry => entry.status === 'complete') && limitations.length === 0 ? 'complete' : 'partial';
  return { status, formats, limitations };
}

function safeLatest(value, auditId) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || (value.auditId !== undefined && value.auditId !== auditId)) return {};
  const clone = structuredClone(value);
  delete clone.message;
  delete clone.deliveryReceipt;
  return clone;
}

function validAuditId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/u.test(value)) throw new TypeError('auditId de exportação inválido.');
  return value;
}

function canonicalNow(now) {
  const raw = typeof now === 'function' ? now() : new Date().toISOString();
  const date = raw instanceof Date ? raw : new Date(raw);
  if (!Number.isFinite(date.getTime())) throw new TypeError('Instante de exportação inválido.');
  return date.toISOString();
}
