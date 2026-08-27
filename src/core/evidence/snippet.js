const SENSITIVE = /(?:pass(?:word|wd)?|token|secret|auth(?:orization)?|session|cookie|csrf|xsrf|otp|one[-_ ]?time|api[-_ ]?key)/iu;
const EXECUTABLE = new Set(['script', 'style', 'template']);
const URL_ATTRIBUTES = new Set(['action', 'cite', 'formaction', 'href', 'poster', 'src']);
const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

function scanTag(html, start) {
  let quote = '';
  for (let index = start + 1; index < html.length; index += 1) {
    const character = html[index];
    if (quote) {
      if (character === quote) quote = '';
    } else if (character === '"' || character === "'") quote = character;
    else if (character === '>') return { text: html.slice(start, index + 1), end: index + 1 };
  }
  return null;
}

function parseTag(token) {
  const closing = /^<\s*\//u.test(token);
  const selfClosing = /\/\s*>$/u.test(token);
  const inner = token.slice(1, -1).replace(/^\s*\//u, '').replace(/\/\s*$/u, '');
  const nameMatch = /^\s*([^\s/>]+)/u.exec(inner);
  if (!nameMatch) return null;
  const name = nameMatch[1].toLowerCase();
  if (!/^[a-z][a-z0-9:-]*$/u.test(name)) return null;
  if (closing) return { name, closing, selfClosing, attributes: [] };
  const attributes = [];
  let position = nameMatch.index + nameMatch[0].length;
  while (position < inner.length) {
    while (/\s/u.test(inner[position] || '')) position += 1;
    if (position >= inner.length) break;
    const attrMatch = /^[^\s=/>]+/u.exec(inner.slice(position));
    if (!attrMatch) break;
    const attrName = attrMatch[0].toLowerCase();
    position += attrMatch[0].length;
    while (/\s/u.test(inner[position] || '')) position += 1;
    let value = null;
    if (inner[position] === '=') {
      position += 1;
      while (/\s/u.test(inner[position] || '')) position += 1;
      const quote = inner[position];
      if (quote === '"' || quote === "'") {
        position += 1;
        const end = inner.indexOf(quote, position);
        value = end < 0 ? inner.slice(position) : inner.slice(position, end);
        position = end < 0 ? inner.length : end + 1;
      } else {
        const unquoted = /^[^\s>]+/u.exec(inner.slice(position));
        value = unquoted?.[0] ?? '';
        position += value.length;
      }
    }
    attributes.push({ name: attrName, value });
  }
  return { name, closing, selfClosing, attributes };
}

function sanitizeUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const absolute = /^[a-z][a-z0-9+.-]*:/iu.test(value);
  try {
    const url = new URL(value, 'https://snippet.invalid/');
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    url.username = '';
    url.password = '';
    for (const key of [...url.searchParams.keys()]) if (SENSITIVE.test(key)) url.searchParams.delete(key);
    if (SENSITIVE.test(url.hash)) url.hash = '';
    if (absolute) return url.href;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}

function escapeAttribute(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
}

function sanitizeText(value) {
  return value
    .replace(/\b(Bearer)(\s+)([^\s<]+)/giu, '$1$2[redacted]')
    .replace(/\b(authorization|password|passwd|token|secret|api[-_ ]?key|csrf|xsrf|otp)\b(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s<]+)/giu, '$1$2[redacted]');
}

function contentEditableTag(parsed) {
  if (parsed.closing || ['input', 'select', 'textarea'].includes(parsed.name)) return false;
  const values = Object.fromEntries(parsed.attributes.map(attribute => [attribute.name, attribute.value ?? '']));
  const value = String(values.contenteditable ?? '').trim().toLowerCase();
  return Object.hasOwn(values, 'contenteditable') && !['false', 'inherit'].includes(value);
}

function safeIdRefs(value) {
  const tokens = String(value ?? '').trim().split(/\s+/u).filter(Boolean);
  return tokens.length > 0 && tokens.every(token => /^[a-z_][a-z0-9_.:-]*$/iu.test(token) && !SENSITIVE.test(token))
    ? tokens.join(' ')
    : null;
}

function sanitizeTag(parsed, { contentEditableRoot = false, stripAttributes = false } = {}) {
  if (parsed.closing) return `</${parsed.name}>`;
  const values = Object.fromEntries(parsed.attributes.map(attribute => [attribute.name, attribute.value ?? '']));
  const contenteditable = String(values.contenteditable ?? '').trim().toLowerCase();
  const editable = ['input', 'select', 'textarea'].includes(parsed.name) || (
    Object.hasOwn(values, 'contenteditable') && !['false', 'inherit'].includes(contenteditable)
  );
  const output = [];
  for (const attribute of parsed.attributes) {
    const { name } = attribute;
    if (stripAttributes) continue;
    if (contentEditableRoot && !['contenteditable', 'role', 'tabindex', 'aria-labelledby', 'aria-describedby'].includes(name)) continue;
    if (/^on/iu.test(name) || name === 'srcdoc' || name === 'style') continue;
    if (name === 'xlink:href' || name === 'ping' || name === 'srcset') continue;
    if ((parsed.name === 'object' && name === 'data') || (parsed.name === 'embed' && name === 'src')) continue;
    if (parsed.name === 'meta' && String(values['http-equiv']).toLowerCase() === 'refresh' && name === 'content') continue;
    if (SENSITIVE.test(name) && !['id', 'name', 'autocomplete'].includes(name)) continue;
    if (editable && ['value', 'aria-valuenow', 'aria-valuetext'].includes(name)) continue;
    if (name === 'value' && (parsed.name === 'option' || SENSITIVE.test(`${values.id || ''} ${values.name || ''} ${values.autocomplete || ''}`))) continue;
    if (parsed.name === 'option' && (name === 'selected' || name === 'aria-selected')) continue;
    let value = attribute.value;
    if (value !== null && (name === 'type' || name === 'autocomplete')) value = value.toLowerCase();
    if (contentEditableRoot && name === 'contenteditable') {
      const normalized = String(value ?? '').trim().toLowerCase();
      if (!['', 'true', 'plaintext-only'].includes(normalized)) continue;
      value = normalized;
    }
    if (contentEditableRoot && name === 'role') {
      const normalized = String(value ?? '').trim().toLowerCase();
      if (!/^[a-z][a-z0-9-]*(?:\s+[a-z][a-z0-9-]*)*$/u.test(normalized) || SENSITIVE.test(normalized)) continue;
      value = normalized;
    }
    if (contentEditableRoot && name === 'tabindex') {
      const normalized = String(value ?? '').trim();
      if (!/^-?\d+$/u.test(normalized)) continue;
      value = String(Number(normalized));
    }
    if (contentEditableRoot && (name === 'aria-labelledby' || name === 'aria-describedby')) {
      value = safeIdRefs(value);
      if (value === null) continue;
    }
    if (URL_ATTRIBUTES.has(name)) {
      value = sanitizeUrl(value);
      if (value === null) continue;
    }
    output.push(value === null ? name : `${name}="${escapeAttribute(value)}"`);
  }
  return `<${parsed.name}${output.length ? ` ${output.join(' ')}` : ''}${parsed.selfClosing ? ' /' : ''}>`;
}

function escapeHtmlText(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

/**
 * Sanitizes untrusted HTML into readable source for a later text-encoding boundary.
 * The result must never be inserted as markup; report renderers must HTML-escape it.
 */
export function sanitizeHtmlSnippetSource(html, { privateTextDescendant = false } = {}) {
  if (typeof html !== 'string') return '';
  let output = '';
  let position = 0;
  const privateStructure = [];
  let pendingPrivateRoot = privateTextDescendant === true;
  const privateOnly = pendingPrivateRoot;
  while (position < html.length) {
    const opening = html.indexOf('<', position);
    if (opening < 0) {
      if (!privateStructure.length && !pendingPrivateRoot) output += sanitizeText(html.slice(position));
      break;
    }
    if (!privateStructure.length && !pendingPrivateRoot) output += sanitizeText(html.slice(position, opening));
    if (html.startsWith('<!--', opening)) {
      const end = html.indexOf('-->', opening + 4);
      position = end < 0 ? html.length : end + 3;
      continue;
    }
    const token = scanTag(html, opening);
    if (!token) {
      if (!privateStructure.length && !pendingPrivateRoot) output += '&lt;';
      position = opening + 1;
      continue;
    }
    const parsed = parseTag(token.text);
    if (!parsed) {
      if (!privateStructure.length && !pendingPrivateRoot) output += '&lt;';
      position = opening + 1;
      continue;
    }
    if (EXECUTABLE.has(parsed.name)) {
      if (!parsed.closing && !parsed.selfClosing) {
        const lower = html.toLowerCase();
        const closeStart = lower.indexOf(`</${parsed.name}`, token.end);
        if (closeStart >= 0) {
          const closeToken = scanTag(html, closeStart);
          position = closeToken?.end ?? html.length;
          continue;
        }
      }
      position = token.end;
      continue;
    }
    if (privateStructure.length) {
      if (parsed.closing) {
        if (privateStructure.at(-1) === parsed.name) {
          privateStructure.pop();
          if (!privateStructure.length) {
            output += sanitizeTag(parsed);
            if (privateOnly) break;
          }
        }
      } else if (!parsed.selfClosing && !VOID_ELEMENTS.has(parsed.name)) {
        privateStructure.push(parsed.name);
      }
      position = token.end;
      continue;
    }
    if (pendingPrivateRoot && parsed.closing) {
      position = token.end;
      continue;
    }
    const forcedPrivateRoot = pendingPrivateRoot;
    output += sanitizeTag(parsed, {
      contentEditableRoot: contentEditableTag(parsed),
      stripAttributes: forcedPrivateRoot,
    });
    if (forcedPrivateRoot) pendingPrivateRoot = false;
    if (!parsed.closing && !parsed.selfClosing && !VOID_ELEMENTS.has(parsed.name)) {
      const values = Object.fromEntries(parsed.attributes.map(attribute => [attribute.name, attribute.value ?? '']));
      const contenteditable = String(values.contenteditable ?? '').trim().toLowerCase();
      if (parsed.name === 'textarea' || (
        Object.hasOwn(values, 'contenteditable') && !['false', 'inherit'].includes(contenteditable)
      ) || forcedPrivateRoot) privateStructure.push(parsed.name);
    }
    if (forcedPrivateRoot && (parsed.selfClosing || VOID_ELEMENTS.has(parsed.name))) break;
    position = token.end;
  }
  return output.replace(/\s+/gu, ' ').trim();
}

/** Sanitizes and HTML-encodes untrusted source for inert direct display. */
export function sanitizeHtmlSnippet(html) {
  return escapeHtmlText(sanitizeHtmlSnippetSource(html));
}
