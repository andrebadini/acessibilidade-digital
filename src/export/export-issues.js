import {
  EXPORT_ISSUE_MESSAGES,
  PDF_GENERATION_FAILURE_CODES,
  REPORT_GENERATION_ISSUE_CODES,
  canonicalExportIssueMessage,
} from '../core/report/diagnostic-policy.js';

export { PDF_GENERATION_FAILURE_CODES, REPORT_GENERATION_ISSUE_CODES };

export const REPORT_EXPORT_INPUT_ERROR_CODE = 'REPORT_EXPORT_INPUT_INVALID';
export const REPORT_EXPORT_INPUT_ERROR_MESSAGE = 'Solicitação de geração de relatório inválida.';

const MAX_EXPORT_ISSUES = 32;
const ISSUE_KEYS = Object.freeze(['code', 'message']);

export function reportExportInputError() {
  const error = new TypeError(REPORT_EXPORT_INPUT_ERROR_MESSAGE);
  Object.defineProperty(error, 'code', {
    value: REPORT_EXPORT_INPUT_ERROR_CODE, enumerable: true, configurable: false, writable: false,
  });
  return error;
}

export function createExportIssue(code) {
  const message = canonicalExportIssueMessage(code);
  if (message === null) throw reportExportInputError();
  return Object.freeze({ code, message });
}

export function captureCanonicalExportIssues(input, { allowedCodes = null } = {}) {
  try {
    if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) throw new TypeError();
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const length = descriptors.length?.value;
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_EXPORT_ISSUES ||
      Reflect.ownKeys(descriptors).length !== length + 1) throw new TypeError();
    const allowed = allowedCodes === null ? null : new Set(allowedCodes);
    const output = [];
    const seen = new Set();
    for (let index = 0; index < length; index += 1) {
      const entry = descriptors[String(index)];
      if (!entry?.enumerable || !Object.hasOwn(entry, 'value')) throw new TypeError();
      const issue = entry.value;
      if (!issue || typeof issue !== 'object' || Array.isArray(issue) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(issue))) throw new TypeError();
      const fields = Object.getOwnPropertyDescriptors(issue);
      const keys = Reflect.ownKeys(fields);
      if (keys.length !== ISSUE_KEYS.length || ISSUE_KEYS.some(key => !keys.includes(key)) ||
        keys.some(key => typeof key !== 'string')) throw new TypeError();
      const code = ownEnumerableData(fields, 'code');
      const message = ownEnumerableData(fields, 'message');
      if (typeof code !== 'string' || message !== canonicalExportIssueMessage(code) ||
        (allowed && !allowed.has(code)) || seen.has(code)) throw new TypeError();
      seen.add(code);
      output.push(Object.freeze({ code, message }));
    }
    return Object.freeze(output);
  } catch {
    throw reportExportInputError();
  }
}

function ownEnumerableData(descriptors, key) {
  const descriptor = descriptors[key];
  if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new TypeError();
  return descriptor.value;
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

export const EXPORT_ISSUE_MESSAGE_CATALOG = EXPORT_ISSUE_MESSAGES;
