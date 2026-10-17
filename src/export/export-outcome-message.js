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
  DOWNLOAD_CANCELLED: 'você cancelou o salvamento',
});
const GUIDANCE = 'Confira se há espaço livre no disco e se a pasta de downloads permite gravação. '
  + 'Depois volte à aba do relatório e exporte novamente.';
const CANCEL_GUIDANCE = 'Se quiser o arquivo, exporte novamente e confirme o salvamento na janela do navegador.';
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

// Ausente significa "os quatro", preservando as mensagens e os testes anteriores à
// exportação por formato. Uma lista explícita precisa ser um subconjunto canônico.
function requestedList(value) {
  if (value === undefined) return null;
  try {
    const source = typeof value === 'string' ? (value === '' ? [] : value.split(',')) : value;
    if (!Array.isArray(source) || source.length === 0) return null;
    const ordered = FORMAT_ORDER.filter(format => source.includes(format));
    return ordered.length === source.length ? ordered : null;
  } catch {
    return null;
  }
}

function joinLabels(formats) {
  const labels = formats.map(label);
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return `${labels[0]} e ${labels[1]}`;
  return `${labels.slice(0, -1).join(', ')} e ${labels.at(-1)}`;
}

function failureReason(entry) {
  return Object.hasOwn(FAILURE_REASONS, entry.failureCode)
    ? FAILURE_REASONS[entry.failureCode]
    : 'o arquivo não foi preparado';
}

function perFormatResults(formats, delivered, entriesByFormat) {
  return Object.freeze(formats.map(format => {
    if (delivered.includes(format)) {
      return Object.freeze({ format, ok: true, text: `${label(format)} baixado.` });
    }
    const entry = entriesByFormat.get(format)?.[0] ?? { format };
    return Object.freeze({ format, ok: false, text: `${label(format)} não foi baixado: ${failureReason(entry)}.` });
  }));
}

/**
 * Descreve o desfecho durável já gravado pela exportação.
 * `tone` é `error` quando nenhum arquivo saiu, `warning` quando saiu com ressalvas e
 * `info` quando tudo o que foi pedido foi entregue. Retorna sempre texto simples.
 */
export function describeExportDelivery(latest = {}, requestedFormats = undefined) {
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
  const requested = requestedList(requestedFormats);
  if (formats.length === 0 && requested === null) {
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
  const expected = requested ?? FORMAT_ORDER;
  const delivered = expected.filter(format => {
    const entries = entriesByFormat.get(format);
    return entries?.length === 1 && entries[0]?.status === 'complete';
  });
  const incomplete = expected
    .filter(format => !delivered.includes(format))
    .map(format => entriesByFormat.get(format)?.[0] ?? { format });
  const unverifiable = recognized !== formats.length ||
    formats.some(entry => !Object.hasOwn(FORMAT_LABELS, entry.format) || !expected.includes(entry.format)) ||
    expected.some(format => (entriesByFormat.get(format)?.length ?? 0) > 1) ||
    formats.length > expected.length;
  const results = perFormatResults(expected, delivered, entriesByFormat);
  if (formats.length === 0) {
    return Object.freeze({
      tone: 'error',
      headline: expected.length === 1
        ? `${label(expected[0])} não foi baixado.`
        : 'Nenhum dos arquivos pedidos foi baixado.',
      lines: Object.freeze([messageText(latest?.message) ?? 'A exportação terminou sem registrar os arquivos.']),
      guidance: GUIDANCE,
      results,
    });
  }
  if (incomplete.length === 0 && !unverifiable) {
    const limitations = limitationLines(receipt);
    if (limitations.length === 0) {
      return Object.freeze({
        tone: 'info',
        headline: expected.length === FORMAT_ORDER.length
          ? 'Os quatro arquivos foram baixados e o recibo local foi confirmado.'
          : `${joinLabels(expected)} ${expected.length === 1 ? 'baixado' : 'baixados'} e o recibo local foi confirmado.`,
        lines: Object.freeze([]),
        guidance: null,
        results,
      });
    }
    return Object.freeze({
      tone: 'warning',
      headline: expected.length === FORMAT_ORDER.length
        ? 'Os arquivos foram baixados, mas a exportação registrou ressalvas.'
        : 'Os arquivos pedidos foram baixados, mas a exportação registrou ressalvas.',
      lines: Object.freeze([...limitations]),
      guidance: PRINT_RESSALVA_GUIDANCE,
      results,
    });
  }
  if (incomplete.length === 0) {
    return Object.freeze({
      tone: 'error',
      headline: 'O recibo da exportação não pôde ser conferido.',
      lines: Object.freeze([expected.length === FORMAT_ORDER.length
        ? 'O registro dos arquivos não descreve os quatro formatos esperados.'
        : 'O registro dos arquivos não descreve os formatos pedidos.']),
      guidance: GUIDANCE,
      results,
    });
  }
  const lines = [];
  if (delivered.length > 0) lines.push(`Baixados: ${delivered.map(label).join(', ')}.`);
  lines.push(`Não baixados: ${incomplete.map(entry => label(entry.format) ?? entry.format).join(', ')}.`);
  for (const entry of incomplete) {
    lines.push(`${label(entry.format) ?? entry.format}: ${failureReason(entry)}.`);
  }
  const allCancelled = incomplete.every(entry => entry.failureCode === 'DOWNLOAD_CANCELLED');
  return Object.freeze({
    tone: 'error',
    headline: expected.length === FORMAT_ORDER.length
      ? delivered.length > 0
        ? 'Alguns arquivos do relatório não puderam ser baixados.'
        : 'Nenhum arquivo do relatório foi baixado.'
      : expected.length === 1
        ? `${label(expected[0])} não foi baixado.`
        : delivered.length > 0
          ? 'Alguns dos arquivos pedidos não puderam ser baixados.'
          : 'Nenhum dos arquivos pedidos foi baixado.',
    lines: Object.freeze(lines),
    guidance: allCancelled ? CANCEL_GUIDANCE : GUIDANCE,
    results,
  });
}

export function exportDeliveryText(outcome) {
  if (!outcome) return '';
  return [outcome.headline, ...(outcome.lines ?? []), outcome.guidance]
    .filter(value => typeof value === 'string' && value.trim()).join(' ');
}
