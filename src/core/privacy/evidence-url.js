import { normalizeAuditUrl } from '../url.js';

const INVALID_URL_MESSAGE = 'URL de evidência HTTP(S) inválida.';
const INVALID_OPTIONS_MESSAGE = 'Opções de URL de evidência inválidas.';
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,63}$/u;
const REDACTED_SEGMENT = /^:redacted-[1-9][0-9]*$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const EMAIL = /^[^@/\s]+@[^@/\s]+\.[^@/\s]+$/u;
const LONG_NUMBER = /\d{7,}/u;
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;
const OPTION_KEYS = new Set(['base', 'includeQuery']);
const FORBIDDEN_URL_INPUT = /[\u0000-\u001F\u007F-\u009F\\\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;

export function canonicalNavigationUrl(rawUrl, options = undefined) {
  const { base } = captureOptions(options);
  try {
    if (typeof rawUrl !== 'string' || FORBIDDEN_URL_INPUT.test(rawUrl.trim())) throw new TypeError();
    if (base === undefined) return normalizeAuditUrl(rawUrl);
    const canonicalBase = normalizeAuditUrl(base);
    const resolved = new URL(rawUrl, canonicalBase);
    return normalizeAuditUrl(resolved.href);
  } catch {
    throw new TypeError(INVALID_URL_MESSAGE);
  }
}

export function sanitizeEvidenceUrlV1(rawUrl, options = undefined) {
  const { base, includeQuery } = captureOptions(options);
  const navigationUrl = canonicalNavigationUrl(rawUrl, base === undefined ? undefined : { base });
  let parsed;
  try {
    parsed = new URL(navigationUrl);
  } catch {
    throw new TypeError(INVALID_URL_MESSAGE);
  }
  parsed.hash = '';
  let ordinal = 0;
  let redactedSegments = 0;
  parsed.pathname = parsed.pathname.split('/').map(encoded => {
    if (encoded === '') return '';
    ordinal += 1;
    const decoded = decodeSegmentOnce(encoded);
    if (decoded.ok && REDACTED_SEGMENT.test(decoded.value)) {
      redactedSegments += 1;
      return decoded.value;
    }
    if (!decoded.ok || !safePathSegment(decoded.value)) {
      redactedSegments += 1;
      return `:redacted-${ordinal}`;
    }
    return encodeURIComponent(decoded.value)
      .replace(/%2E/giu, '.')
      .replace(/%7E/giu, '~');
  }).join('/');
  if (!includeQuery) parsed.search = '';
  return Object.freeze({
    version: 'EvidenceUrlV1',
    href: parsed.href,
    queryIncluded: includeQuery && parsed.search.length > 0,
    redactedSegments,
  });
}

export function isEvidenceUrlV1(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length !== 4 || keys.some(key => typeof key !== 'string' ||
      !['version', 'href', 'queryIncluded', 'redactedSegments'].includes(key)) ||
      Object.values(descriptors).some(descriptor => !descriptor.enumerable || !Object.hasOwn(descriptor, 'value'))) return false;
    const candidate = {
      version: descriptors.version.value,
      href: descriptors.href.value,
      queryIncluded: descriptors.queryIncluded.value,
      redactedSegments: descriptors.redactedSegments.value,
    };
    if (candidate.version !== 'EvidenceUrlV1' || typeof candidate.href !== 'string' ||
      typeof candidate.queryIncluded !== 'boolean' || !Number.isSafeInteger(candidate.redactedSegments) ||
      candidate.redactedSegments < 0) return false;
    const canonical = sanitizeEvidenceUrlV1(candidate.href, { includeQuery: candidate.queryIncluded });
    return canonical.href === candidate.href && canonical.queryIncluded === candidate.queryIncluded &&
      canonical.redactedSegments === candidate.redactedSegments;
  } catch {
    return false;
  }
}

function captureOptions(options) {
  if (options === undefined) return { base: undefined, includeQuery: false };
  try {
    if (!options || typeof options !== 'object' || Array.isArray(options) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(options))) throw new TypeError();
    const descriptors = Object.getOwnPropertyDescriptors(options);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some(key => typeof key !== 'string' || !OPTION_KEYS.has(key)) ||
      Object.values(descriptors).some(descriptor => !descriptor.enumerable || !Object.hasOwn(descriptor, 'value'))) throw new TypeError();
    const base = descriptors.base?.value;
    const includeQuery = descriptors.includeQuery?.value ?? false;
    if (base !== undefined && typeof base !== 'string' || typeof includeQuery !== 'boolean') throw new TypeError();
    return { base, includeQuery };
  } catch {
    throw new TypeError(INVALID_OPTIONS_MESSAGE);
  }
}

function decodeSegmentOnce(encoded) {
  try {
    return { ok: true, value: decodeURIComponent(encoded) };
  } catch {
    return { ok: false, value: '' };
  }
}

function safePathSegment(value) {
  return SAFE_SEGMENT.test(value) && !UUID.test(value) && !EMAIL.test(value) &&
    !LONG_NUMBER.test(value) && !JWT.test(value) && !highEntropyToken(value);
}

function highEntropyToken(value) {
  if (!/^[A-Za-z0-9_-]{24,}$/u.test(value)) return false;
  const classes = [/[a-z]/u, /[A-Z]/u, /\d/u, /[_-]/u]
    .filter(pattern => pattern.test(value)).length;
  return classes >= 3 || new Set(value).size / value.length >= 0.65;
}
