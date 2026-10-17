// Mensagens leigas para o desfecho da exportação. Os recibos continuam fechados e
// validados em outro lugar; aqui só traduzimos os códigos já aceitos para uma frase
// que diga o que aconteceu e o que a pessoa pode fazer. Sem isso, uma falha de
// download deixava a aba de exportação muda e o relatório preso em "na fila".

const FORMAT_ORDER = Object.freeze(['html', 'pdf', 'csv', 'json']);
const FORMAT_LABELS = Object.freeze({ html: 'HTML', pdf: 'PDF', csv: 'CSV', json: 'JSON' });
const FAILURE_REASONS = Object.freeze({
  ARTIFACT_BYTES_INVALID: 'o conteúdo do arquivo não pôde ser lido',
  ARTIFACT_HASH_FAILED: 'a integridade do arquivo não pôde ser verificada',
  ARTIFACT_BLOB_FAILED: 'o arquivo não pôde ser preparado',
  DOWNLOAD_START_TIMEOUT: 'o download não começou a tempo',
  DOWNLOAD_START_FAILED: 'o navegador não conseguiu iniciar o download',
  DOWNLOAD_WAIT_TIMEOUT: 'o download demorou demais e foi encerrado',
  DOWNLOAD_INTERRUPTED: 'o navegador interrompeu o download',
});
const GUIDANCE = 'Confira se há espaço livre no disco e se a pasta de downloads permite gravação. '
  + 'Depois volte à aba do relatório e exporte novamente.';
const PRINT_RESSALVA_GUIDANCE = 'Os arquivos baixados podem ser usados normalmente. '
  + 'Se a exportação repetir a ressalva, confira as permissões da pasta de downloads e tente de novo.';

function label(format) {
  return Object.hasOwn(FORMAT_LABELS, format) ? FORMAT_LABELS[format] : null;
}

function messageText(value) {
  return typeof value === 'string' && value.trim() ? value : null;
}

function limitationLines(receipt) {
  if (!Array.isArray(receipt?.limitations)) return [];
  return receipt.limitations.filter(value => typeof value === 'string' && value.trim());
}

/**
 * Descreve o desfecho durável já gravado pela exportação.
 * `tone` é `error` quando nenhum arquivo saiu, `warning` quando saiu com ressalvas e
 * `info` quando tudo foi entregue. Retorna sempre texto simples em português.
 */
export function describeExportDelivery(latest = {}) {
  const status = latest?.exportStatus;
  const receipt = latest?.deliveryReceipt;
  if (status === 'failed' || receipt?.status === 'failed') {
    return Object.freeze({
      tone: 'error',
      headline: 'Não foi possível preparar os arquivos do relatório.',
      lines: Object.freeze([messageText(latest?.message) ?? 'A preparação dos arquivos foi interrompida.']),
      guidance: GUIDANCE,
    });
  }
  const formats = Array.isArray(receipt?.formats) ? receipt.formats : [];
  if (formats.length === 0) {
    return Object.freeze({
      tone: 'error',
      headline: 'Nenhum arquivo do relatório foi baixado.',
      lines: Object.freeze([messageText(latest?.message) ?? 'A exportação terminou sem registrar os arquivos.']),
      guidance: GUIDANCE,
    });
  }
  const entriesByFormat = new Map();
  let recognized = 0;
  for (const entry of formats) {
    if (!entry || !Object.hasOwn(FORMAT_LABELS, entry.format)) continue;
    recognized += 1;
    const entries = entriesByFormat.get(entry.format) ?? [];
    entries.push(entry);
    entriesByFormat.set(entry.format, entries);
  }
  // Só há sucesso quando os quatro formatos aparecem uma única vez e todos estão
  // completos. Um recibo truncado, duplicado ou com formato desconhecido não pode
  // virar "os quatro arquivos foram baixados".
  const delivered = FORMAT_ORDER.filter(format => {
    const entries = entriesByFormat.get(format);
    return entries?.length === 1 && entries[0]?.status === 'complete';
  });
  const incomplete = FORMAT_ORDER
    .filter(format => !delivered.includes(format))
    .map(format => entriesByFormat.get(format)?.[0] ?? { format });
  const unverifiable = recognized !== formats.length || formats.length !== FORMAT_ORDER.length;
  if (incomplete.length === 0 && !unverifiable) {
    const limitations = limitationLines(receipt);
    if (limitations.length === 0) {
      return Object.freeze({
        tone: 'info',
        headline: 'Os quatro arquivos foram baixados e o recibo local foi confirmado.',
        lines: Object.freeze([]),
        guidance: null,
      });
    }
    return Object.freeze({
      tone: 'warning',
      headline: 'Os arquivos foram baixados, mas a exportação registrou ressalvas.',
      lines: Object.freeze([...limitations]),
      guidance: PRINT_RESSALVA_GUIDANCE,
    });
  }
  if (incomplete.length === 0) {
    return Object.freeze({
      tone: 'error',
      headline: 'O recibo da exportação não pôde ser conferido.',
      lines: Object.freeze(['O registro dos arquivos não descreve os quatro formatos esperados.']),
      guidance: GUIDANCE,
    });
  }
  const lines = [];
  if (delivered.length > 0) lines.push(`Baixados: ${delivered.map(label).join(', ')}.`);
  lines.push(`Não baixados: ${incomplete.map(entry => label(entry.format) ?? entry.format).join(', ')}.`);
  for (const entry of incomplete) {
    const reason = Object.hasOwn(FAILURE_REASONS, entry.failureCode)
      ? FAILURE_REASONS[entry.failureCode]
      : 'o download não foi concluído';
    lines.push(`${label(entry.format) ?? entry.format}: ${reason}.`);
  }
  return Object.freeze({
    tone: 'error',
    headline: delivered.length > 0
      ? 'Alguns arquivos do relatório não puderam ser baixados.'
      : 'Nenhum arquivo do relatório foi baixado.',
    lines: Object.freeze(lines),
    guidance: GUIDANCE,
  });
}

export function exportDeliveryText(outcome) {
  if (!outcome) return '';
  return [outcome.headline, ...(outcome.lines ?? []), outcome.guidance]
    .filter(value => typeof value === 'string' && value.trim()).join(' ');
}
