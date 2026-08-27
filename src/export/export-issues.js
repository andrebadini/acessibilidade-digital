const MESSAGES = Object.freeze({
  REPORT_PDF_UNAVAILABLE: 'O PDF não foi gerado devido a uma limitação técnica local.',
  REPORT_CSV_UNAVAILABLE: 'O CSV não foi gerado devido a uma limitação técnica local.',
  REPORT_PDF_TAGGING_UNSUPPORTED: 'O PDF foi gerado sem marcação estrutural adicional e sem outline porque o navegador não aceitou esses parâmetros.',
  REPORT_PRINT_TAB_TIMEOUT: 'A criação da aba temporária de impressão excedeu o tempo limite.',
  REPORT_PRINT_TAB_FAILED: 'A aba temporária de impressão não pôde ser criada.',
  REPORT_PRINT_LOAD_TIMEOUT: 'O carregamento da página de impressão excedeu o tempo limite.',
  REPORT_PRINT_LOAD_FAILED: 'A página de impressão não pôde ser preparada.',
  REPORT_PRINT_CDP_TIMEOUT: 'A conexão local de impressão excedeu o tempo limite.',
  REPORT_PRINT_CDP_FAILED: 'A conexão local de impressão não pôde ser estabelecida.',
  REPORT_PRINT_ASSETS_TIMEOUT: 'A preparação local de fontes e imagens excedeu o tempo limite.',
  REPORT_PRINT_ASSETS_FAILED: 'Fontes e imagens do relatório não puderam ser confirmadas.',
  REPORT_PRINT_CLEANUP_LIMITED: 'A limpeza de um recurso temporário de impressão não pôde ser confirmada.',
  REPORT_DOWNLOAD_START_FAILED: 'Um artefato não pôde iniciar o download.',
  REPORT_DOWNLOAD_TIMEOUT: 'Um artefato excedeu o tempo limite de download.',
  REPORT_DOWNLOAD_INTERRUPTED: 'Um artefato teve o download interrompido.',
  REPORT_DOWNLOAD_CLEANUP_LIMITED: 'A liberação de um endereço temporário de download não pôde ser confirmada.',
  REPORT_EXPORT_PREPARATION_FAILED: 'Não foi possível preparar os artefatos do relatório.',
});

export const PDF_GENERATION_FAILURE_CODES = Object.freeze([
  'REPORT_PRINT_TAB_TIMEOUT', 'REPORT_PRINT_TAB_FAILED',
  'REPORT_PRINT_LOAD_TIMEOUT', 'REPORT_PRINT_LOAD_FAILED',
  'REPORT_PRINT_CDP_TIMEOUT', 'REPORT_PRINT_CDP_FAILED',
  'REPORT_PRINT_ASSETS_TIMEOUT', 'REPORT_PRINT_ASSETS_FAILED',
  'REPORT_PDF_UNAVAILABLE',
]);

export const REPORT_GENERATION_ISSUE_CODES = Object.freeze([
  ...PDF_GENERATION_FAILURE_CODES,
  'REPORT_CSV_UNAVAILABLE',
  'REPORT_PDF_TAGGING_UNSUPPORTED',
]);

export function createExportIssue(code, format) {
  if (!Object.hasOwn(MESSAGES, code)) throw new TypeError('Código de limitação de exportação desconhecido.');
  const suffix = typeof format === 'string' && /^(?:html|json|csv|pdf)$/u.test(format) ? ` Formato: ${format.toUpperCase()}.` : '';
  return Object.freeze({ code, message: `${MESSAGES[code]}${suffix}` });
}

export function issueForPrintStage(stage, error) {
  const timeout = safeErrorName(error) === 'TimeoutError';
  const code = ({
    tab: timeout ? 'REPORT_PRINT_TAB_TIMEOUT' : 'REPORT_PRINT_TAB_FAILED',
    load: timeout ? 'REPORT_PRINT_LOAD_TIMEOUT' : 'REPORT_PRINT_LOAD_FAILED',
    cdp: timeout ? 'REPORT_PRINT_CDP_TIMEOUT' : 'REPORT_PRINT_CDP_FAILED',
    assets: timeout ? 'REPORT_PRINT_ASSETS_TIMEOUT' : 'REPORT_PRINT_ASSETS_FAILED',
    pdf: 'REPORT_PDF_UNAVAILABLE',
  })[stage] ?? 'REPORT_PDF_UNAVAILABLE';
  return createExportIssue(code);
}

function safeErrorName(value) {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return '';
  try {
    let current = value;
    for (let depth = 0; current && depth < 8; depth += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(current, 'name');
      if (descriptor) {
        if (Object.hasOwn(descriptor, 'value')) return typeof descriptor.value === 'string' ? descriptor.value : '';
        if (current === globalThis.DOMException?.prototype && typeof descriptor.get === 'function') {
          try { return Reflect.apply(descriptor.get, value, []); } catch { return ''; }
        }
        return '';
      }
      current = Object.getPrototypeOf(current);
    }
  } catch {}
  return '';
}
