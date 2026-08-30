export const SENSITIVE_KEY = /(?:pass(?:word|wd)?|token|secret|auth(?:orization)?|session|cookie|csrf|xsrf|otp|one[-_ ]?time|api[-_ ]?key)/iu;

// Public storage failures stay independent from browser/IndexedDB error details,
// which may disclose URLs, database names or implementation-specific values.
export const AUDIT_STORAGE_UNAVAILABLE_MESSAGE = 'Não foi possível salvar a auditoria no armazenamento local. Libere espaço ou verifique as permissões e tente novamente.';

/** Marco 1 durable projection: resource identity is limited to its canonical origin. */
export function projectAuditResourceOrigin(value) {
  if (typeof value !== 'string' || value.length === 0) return '';
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.href !== value) return '';
    return `${parsed.origin}/`;
  } catch {
    return '';
  }
}

const URL_ATTRIBUTE_KEYS = new Set(['action', 'cite', 'formaction', 'href', 'poster', 'src', 'currentSrc']);

const FIXED_WARNING_MESSAGES = Object.freeze({
  FRAME_RUNTIME_BLOCKED: 'A coleta runtime de um frame foi bloqueada.',
  RUNTIME_FRAME_MISSING: 'Um frame esperado não retornou dados runtime.',
  AX_FRAME_UNAVAILABLE: 'A árvore de acessibilidade de um frame não ficou disponível.',
  RUNTIME_MATCH_AMBIGUOUS: 'Dados runtime ambíguos não foram associados.',
  WARNINGS_UNAVAILABLE: 'Os avisos de coleta não puderam ser normalizados com segurança.',
  TIMEOUT: 'Uma medição excedeu o tempo limite.',
  ABORTED: 'A medição foi cancelada.',
  PROBE_FAILED: 'Uma medição dinâmica não pôde ser concluída.'
});

const WARNING_FIELDS = new Set(['code', 'frameId', 'message']);
const MAX_WARNING_CODE_LENGTH = 128;
const MAX_WARNING_MESSAGE_LENGTH = 1_024;
const MAX_WARNING_ITEMS = 1_024;

function projectWarning(input) {
  try {
    if (input === null || typeof input !== 'object') return null;
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(input);
    if (keys.length > WARNING_FIELDS.size ||
      keys.some(key => typeof key !== 'string' || !WARNING_FIELDS.has(key))) return null;
    const projected = {};
    const present = new Set();
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) return null;
      projected[key] = descriptor.value;
      present.add(key);
    }
    if (!present.has('code') || typeof projected.code !== 'string' ||
      projected.code.length > MAX_WARNING_CODE_LENGTH ||
      (present.has('message') && (typeof projected.message !== 'string' ||
        projected.message.length > MAX_WARNING_MESSAGE_LENGTH)) ||
      (present.has('frameId') && projected.frameId !== null &&
        typeof projected.frameId !== 'string' && !Number.isSafeInteger(projected.frameId))) return null;
    return { projected, present };
  } catch {
    return null;
  }
}

function sanitizeProjectedWarning(observation) {
  const requested = observation ? observation.projected.code.trim().toUpperCase() : '';
  const code = Object.hasOwn(FIXED_WARNING_MESSAGES, requested) ? requested : 'PROBE_FAILED';
  const warning = { code, message: FIXED_WARNING_MESSAGES[code] };
  if (!observation) return warning;
  const { frameId } = observation.projected;
  if (typeof frameId === 'string' && /^[a-z0-9_-]{1,128}$/iu.test(frameId) && !SENSITIVE_KEY.test(frameId)) warning.frameId = frameId;
  else if (Number.isSafeInteger(frameId)) warning.frameId = frameId;
  else if (observation.present.has('frameId')) warning.frameId = null;
  return warning;
}

function snapshotWarningCollection(input) {
  if (input === undefined || input === null) return { available: true, values: [] };
  try {
    if (!Array.isArray(input)) return { available: false, values: [] };
    const lengthDescriptor = Object.getOwnPropertyDescriptor(input, 'length');
    if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, 'value') ||
      !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0 ||
      lengthDescriptor.value > MAX_WARNING_ITEMS) return { available: false, values: [] };
    const values = new Array(lengthDescriptor.value);
    for (let index = 0; index < lengthDescriptor.value; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) return { available: false, values: [] };
      values[index] = descriptor.value;
    }
    return { available: true, values };
  } catch {
    return { available: false, values: [] };
  }
}

function unavailableWarnings() {
  return [sanitizeProjectedWarning(projectWarning({ code: 'WARNINGS_UNAVAILABLE' }))];
}

export function sanitizeWarning(input) {
  return sanitizeProjectedWarning(projectWarning(input));
}

export function sanitizeWarnings(input) {
  const collection = snapshotWarningCollection(input);
  if (!collection.available) return unavailableWarnings();
  const warnings = [];
  for (const inputWarning of collection.values) {
    const projected = projectWarning(inputWarning);
    if (!projected) return unavailableWarnings();
    warnings.push(sanitizeProjectedWarning(projected));
  }
  return warnings;
}

export function sanitizeEvidenceUrl(value, base = undefined) {
  if (typeof value !== 'string' || value.trim() === '') return '';
  if (/^data:/iu.test(value)) return 'data:[redacted]';
  if (/^blob:/iu.test(value)) return 'blob:[redacted]';
  try {
    const url = base ? new URL(value, base) : new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    url.username = '';
    url.password = '';
    for (const key of [...url.searchParams.keys()]) if (SENSITIVE_KEY.test(key)) url.searchParams.delete(key);
    if (SENSITIVE_KEY.test(url.hash)) url.hash = '';
    return url.href;
  } catch {
    return '';
  }
}

export function backgroundImageKind(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!normalized || normalized === 'none') return 'none';
  const hasUrl = /url\s*\(/u.test(normalized);
  const hasGradient = /(?:repeating-)?(?:linear|radial|conic)-gradient\s*\(/u.test(normalized);
  if (hasUrl && hasGradient) return 'mixed';
  if (hasUrl) return 'url';
  if (hasGradient) return 'gradient';
  return 'mixed';
}

export function redactSensitiveText(value) {
  return String(value ?? '')
    .replace(/\b(Bearer)(\s+)([^\s<]+)/giu, '$1$2[redacted]')
    .replace(/\b(authorization|password|passwd|token|secret|api[-_ ]?key|csrf|xsrf|otp|session|cookie)\b(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s<]+)/giu, '$1$2[redacted]')
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+:[^/@\s]+@/giu, '$1[redacted]@');
}

export function sanitizeJsonData(value, ancestors = new WeakSet()) {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return redactSensitiveText(value);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'object' || ancestors.has(value)) return null;
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map(item => sanitizeJsonData(item, ancestors));
    const output = {};
    for (const [key, item] of Object.entries(value)) {
      if (SENSITIVE_KEY.test(key)) output[key] = '[redacted]';
      else if (URL_ATTRIBUTE_KEYS.has(key) && typeof item === 'string') output[key] = sanitizeEvidenceUrl(item);
      else output[key] = sanitizeJsonData(item, ancestors);
    }
    return output;
  } finally {
    ancestors.delete(value);
  }
}

function editableControl(node) {
  const tagName = String(node?.tagName || '').toLowerCase();
  const attributes = node?.attributes && typeof node.attributes === 'object' ? node.attributes : {};
  const contenteditable = String(attributes.contenteditable ?? '').trim().toLowerCase();
  return ['input', 'select', 'textarea'].includes(tagName) || (
    Object.hasOwn(attributes, 'contenteditable') && !['false', 'inherit'].includes(contenteditable)
  );
}

function contentEditableControl(node) {
  const tagName = String(node?.tagName || '').toLowerCase();
  if (['input', 'select', 'textarea'].includes(tagName)) return false;
  const attributes = node?.attributes && typeof node.attributes === 'object' ? node.attributes : {};
  const value = String(attributes.contenteditable ?? '').trim().toLowerCase();
  return Object.hasOwn(attributes, 'contenteditable') && !['false', 'inherit'].includes(value);
}

function safeIdRefs(value) {
  const tokens = String(value ?? '').trim().split(/\s+/u).filter(Boolean);
  return tokens.length > 0 && tokens.every(token => /^[a-z_][a-z0-9_.:-]*$/iu.test(token) && !SENSITIVE_KEY.test(token))
    ? tokens.join(' ')
    : '';
}

function contentEditableRootAttributes(attributes) {
  const output = {};
  for (const [name, rawValue] of Object.entries(attributes || {})) {
    const value = String(rawValue ?? '').trim();
    if (name === 'contenteditable') {
      const normalized = value.toLowerCase();
      if (['', 'true', 'plaintext-only'].includes(normalized)) output[name] = normalized;
    } else if (name === 'role') {
      const normalized = value.toLowerCase();
      if (/^[a-z][a-z0-9-]*(?:\s+[a-z][a-z0-9-]*)*$/u.test(normalized) && !SENSITIVE_KEY.test(normalized)) output[name] = normalized;
    } else if (name === 'tabindex') {
      if (/^-?\d+$/u.test(value)) output[name] = String(Number(value));
    } else if (name === 'aria-labelledby' || name === 'aria-describedby') {
      const references = safeIdRefs(value);
      if (references) output[name] = references;
    }
  }
  return output;
}

function removeRuntimeValues(value, ancestors = new WeakSet()) {
  if (!value || typeof value !== 'object' || ancestors.has(value)) return;
  ancestors.add(value);
  try {
    for (const key of Object.keys(value)) {
      if (/^(?:value|currentValue|rawValue|inputValue)$/iu.test(key)) delete value[key];
      else removeRuntimeValues(value[key], ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

/** Final privacy boundary for a fully merged normalized node. */
export function redactNormalizedNode(input, {
  executable = false,
  privateText = false,
  privateTextRoot = false,
  privateTextDescendant = false,
  privateTextAncestor = false,
  preserveAccessibleText = false,
} = {}) {
  const node = sanitizeJsonData(input);
  node.attributes = node.attributes && typeof node.attributes === 'object' ? node.attributes : {};
  for (const name of Object.keys(node.attributes)) {
    if (name === 'style' || name === 'srcdoc' || /^on/iu.test(name)) delete node.attributes[name];
  }
  const editable = editableControl(node);
  if (editable) {
    delete node.attributes.value;
    delete node.attributes['aria-valuenow'];
    delete node.attributes['aria-valuetext'];
    delete node.axValue;
    node.text = '';
    node.visibleText = '';
    removeRuntimeValues(node);
    delete node.form?.selectedIndex;
    delete node.form?.selectionStart;
    delete node.form?.selectionEnd;
    node.valueStatus = 'omitted-privacy';
  }
  if (node.tagName === 'option') {
    delete node.attributes.value;
    delete node.attributes.selected;
    delete node.attributes['aria-selected'];
    delete node.selected;
    delete node.form?.selected;
  }
  if (privateText) {
    node.text = '';
    node.visibleText = '';
    removeRuntimeValues(node);
    if (!preserveAccessibleText) {
      delete node.axValue;
      delete node.accessibleName;
      delete node.accessibleDescription;
    }
  }
  if (privateTextAncestor) node.visibleText = '';
  if (privateTextRoot && contentEditableControl(node)) {
    node.attributes = contentEditableRootAttributes(node.attributes);
    node.selectorHint = '';
    delete node.media;
  }
  if (privateTextDescendant) {
    node.attributes = {};
    node.selectorHint = '';
    delete node.media;
    delete node.form;
    delete node.styles;
    delete node.animations;
    delete node.backgroundImageKind;
    delete node.axValue;
    if (!preserveAccessibleText) {
      delete node.accessibleName;
      delete node.accessibleDescription;
    }
  }
  if (executable) {
    node.text = '';
    node.visibleText = '';
    delete node.axValue;
    delete node.accessibleName;
    delete node.accessibleDescription;
  }
  if (node.styles && typeof node.styles === 'object') {
    const rawBackground = node.styles['background-image'] ?? node.styles.backgroundImage;
    if (rawBackground !== undefined && node.backgroundImageKind === undefined) node.backgroundImageKind = backgroundImageKind(rawBackground);
    delete node.styles['background-image'];
    delete node.styles.backgroundImage;
  }
  return node;
}
