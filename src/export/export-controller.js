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
  const preparedFormats = preparedArtifactFormats(result.model);
  const receipt = normalizeDeliveryReceipt(result.deliveryReceipt, preparedFormats);
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
  let commonBaseName = null;
  const formats = receipt.formats.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
      !['complete', 'timeout', 'interrupted'].includes(entry.status) ||
      !Object.hasOwn(expectedMime, entry.format) || seen.has(entry.format) ||
      entry.format !== preparedFormats[index]) {
      throw new TypeError('Formato duplicado, desconhecido ou fora de ordem no recibo de entrega.');
    }
    const keys = Object.keys(entry).sort();
    const expectedKeys = ['filename', 'format', 'mimeType', 'sha256', 'status', ...(Object.hasOwn(entry, 'downloadId') ? ['downloadId'] : [])].sort();
    if (canonicalStringify(keys) !== canonicalStringify(expectedKeys) ||
      typeof entry.filename !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9.-]{0,240}$/u.test(entry.filename) ||
      !entry.filename.endsWith(`.${entry.format}`) || entry.mimeType !== expectedMime[entry.format] ||
      typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(entry.sha256) ||
      (entry.downloadId !== undefined && (!Number.isSafeInteger(entry.downloadId) || entry.downloadId < 0)) ||
      (entry.status === 'complete' && entry.downloadId === undefined)) {
      throw new TypeError('Formato no recibo de entrega possui arquivo, MIME, hash ou status inválido.');
    }
    const baseName = entry.filename.slice(0, -(entry.format.length + 1));
    if (commonBaseName === null) commonBaseName = baseName;
    else if (baseName !== commonBaseName) throw new TypeError('Arquivos do recibo de entrega não compartilham o mesmo nome-base.');
    seen.add(entry.format);
    return { ...entry };
  });
  if (formats.length !== preparedFormats.length) throw new TypeError('Recibo de entrega não corresponde aos formatos preparados.');
  const limitations = formats.filter(entry => entry.status !== 'complete').map(entry => entry.status === 'timeout'
    ? `O artefato ${entry.format.toUpperCase()} excedeu o tempo limite de download.`
    : `O artefato ${entry.format.toUpperCase()} teve o download interrompido.`);
  if (receipt.limitations.some(value => typeof value !== 'string' || !value.trim() || value.length > 1_000)) {
    throw new TypeError('Limitação no recibo de entrega inválida.');
  }
  if (receipt.limitations.length > limitations.length) limitations.push('A limpeza de um recurso temporário de download não pôde ser confirmada.');
  const status = formats.every(entry => entry.status === 'complete') && limitations.length === 0 ? 'complete' : 'partial';
  if (receipt.status !== status) throw new TypeError('Status do recibo de entrega inválido.');
  return { status, formats, limitations };
}

function preparedArtifactFormats(model) {
  const values = model?.report?.artifact?.formats;
  if (!Array.isArray(values)) throw new TypeError('Formatos preparados do relatório inválidos.');
  const order = ['html', 'json', 'csv', 'pdf'];
  const formats = values.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
      canonicalStringify(Object.keys(entry).sort()) !== canonicalStringify(['format', 'status']) ||
      entry.status !== 'prepared' || !order.includes(entry.format)) {
      throw new TypeError('Formatos preparados do relatório inválidos ou fora de ordem.');
    }
    return entry.format;
  });
  const expected = order.filter(format => formats.includes(format));
  if (formats[0] !== 'html' || formats[1] !== 'json' ||
    canonicalStringify(formats) !== canonicalStringify(expected)) {
    throw new TypeError('Formatos preparados do relatório duplicados, incompletos ou fora de ordem.');
  }
  return formats;
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
