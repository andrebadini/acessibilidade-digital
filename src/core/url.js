const RESTRICTED_SCHEMES = new Set([
  'about:',
  'chrome:',
  'chrome-extension:',
  'data:',
  'file:',
  'javascript:',
]);

export function normalizeAuditUrl(value) {
  if (typeof value !== 'string') {
    throw new TypeError('A URL precisa ser um endereço em texto.');
  }

  const trimmed = value.trim();
  if (!trimmed) {
    throw new TypeError('Informe um endereço para auditoria.');
  }
  if (/[\u0000-\u001F\u007F-\u009F\\\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/.test(trimmed)) {
    throw new TypeError('A URL contém caracteres não permitidos.');
  }
  if (/^[/?#]/.test(trimmed) || hasMalformedOrUnsupportedScheme(trimmed)) {
    throw new TypeError('Informe uma URL HTTP ou HTTPS válida.');
  }

  const candidate = hasExplicitWebScheme(trimmed) || hasRestrictedScheme(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  let url;
  try {
    url = new URL(candidate);
  } catch {
    throw new TypeError('Informe uma URL HTTP ou HTTPS válida.');
  }

  if (RESTRICTED_SCHEMES.has(url.protocol) || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
    throw new TypeError('A URL deve usar HTTP ou HTTPS.');
  }
  if (!url.hostname) {
    throw new TypeError('Informe uma URL HTTP ou HTTPS válida.');
  }
  if (url.username || url.password) {
    throw new TypeError('URLs com credenciais embutidas não são permitidas.');
  }

  return url.href;
}

function hasExplicitWebScheme(value) {
  return /^https?:\/\//i.test(value);
}

function hasRestrictedScheme(value) {
  return /^(?:about|chrome|chrome-extension|data|file|javascript):/i.test(value);
}

function hasMalformedOrUnsupportedScheme(value) {
  if (!/^[a-z][a-z\d+.-]*:/i.test(value)) return false;
  if (hasExplicitWebScheme(value) || hasRestrictedScheme(value)) return false;
  if (/^https?:/i.test(value)) return true;
  return !/^[^/?#:]+:\d+(?:[/?#]|$)/.test(value);
}
