import { projectAuditResourceOrigin } from '../privacy.js';
import { normalizeAuditUrl } from '../url.js';

const MAX_UNIQUE_URLS = 20;
const MAX_INPUT_CODE_UNITS = 64 * 1024;
const MAX_NONEMPTY_LINES = 200;
const MAX_LINE_CODE_UNITS = 8_192;

const MESSAGES = Object.freeze({
  BATCH_EMPTY: 'Informe ao menos uma URL para auditoria em lote.',
  BATCH_INPUT_TOO_LARGE: 'A lista excede o limite seguro de 64 KiB.',
  BATCH_LINE_COUNT_EXCEEDED: 'O lote aceita no máximo 200 linhas não vazias para validação.',
  BATCH_LINE_TOO_LONG: 'A linha excede o limite seguro de 8192 caracteres.',
  BATCH_LIMIT_EXCEEDED: 'O lote aceita no máximo 20 URLs únicas.',
  DUPLICATE_URL: 'A URL repete uma entrada anterior e não será auditada novamente.',
  EMBEDDED_CREDENTIALS: 'A linha contém credenciais embutidas, que não são permitidas.',
  INVALID_URL: 'A linha não contém uma URL HTTP ou HTTPS válida.',
});

/** Normalizes an explicit, bounded list while keeping full navigation URLs volatile. */
export function normalizeUrlList(input) {
  if (typeof input !== 'string') throw new TypeError('A lista de URLs precisa ser fornecida em texto.');
  if (input.length > MAX_INPUT_CODE_UNITS) {
    return freezeResult({
      entries: [], warnings: [],
      errors: [issue(0, 'BATCH_INPUT_TOO_LARGE')],
    });
  }

  const entries = [];
  const errors = [];
  const warnings = [];
  const navigationFirstLine = new Map();
  let nonemptyCount = 0;

  const lines = input.split(/\r\n|\r|\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = index + 1;
    const raw = lines[index];
    if (!raw.trim()) continue;
    nonemptyCount += 1;
    if (nonemptyCount > MAX_NONEMPTY_LINES) {
      errors.push(issue(line, 'BATCH_LINE_COUNT_EXCEEDED'));
      break;
    }
    if (raw.length > MAX_LINE_CODE_UNITS) {
      errors.push(issue(line, 'BATCH_LINE_TOO_LONG'));
      continue;
    }

    let navigationUrl;
    try {
      navigationUrl = normalizeAuditUrl(raw);
    } catch (error) {
      const code = /credenciais/iu.test(error instanceof Error ? error.message : '')
        ? 'EMBEDDED_CREDENTIALS'
        : 'INVALID_URL';
      errors.push(issue(line, code));
      continue;
    }
    const reportUrl = projectAuditResourceOrigin(navigationUrl);
    const navigationDuplicate = navigationFirstLine.get(navigationUrl);
    if (navigationDuplicate !== undefined) {
      warnings.push(issue(line, 'DUPLICATE_URL', navigationDuplicate));
      continue;
    }
    if (entries.length >= MAX_UNIQUE_URLS) {
      errors.push(issue(line, 'BATCH_LIMIT_EXCEEDED'));
      continue;
    }
    navigationFirstLine.set(navigationUrl, line);
    entries.push({ line, navigationUrl, reportUrl });
  }

  if (nonemptyCount === 0) errors.push(issue(0, 'BATCH_EMPTY'));
  return freezeResult({ entries, errors, warnings });
}

function issue(line, code, firstLine) {
  return {
    line,
    code,
    ...(firstLine === undefined ? {} : { firstLine }),
    message: MESSAGES[code],
  };
}

function freezeResult(value) {
  const entries = Object.freeze(value.entries.map(entry => Object.freeze({ ...entry })));
  const errors = Object.freeze(value.errors.map(error => Object.freeze({ ...error })));
  const warnings = Object.freeze(value.warnings.map(warning => Object.freeze({ ...warning })));
  return Object.freeze({ entries, errors, warnings });
}
