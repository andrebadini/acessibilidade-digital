const SENSITIVE = /(?:pass(?:word|wd)?|token|secret|auth(?:orization)?|session|cookie|csrf|xsrf|otp|one[-_ ]?time|api[-_ ]?key)/iu;
const SEMANTIC_ATTRIBUTES = Object.freeze(['data-testid', 'data-test', 'aria-label', 'name', 'role', 'title', 'alt']);

/** CSS.escape-compatible escaping without depending on a browser global. */
export function escapeCssIdentifier(value) {
  const input = String(value);
  let result = '';
  for (let index = 0; index < input.length; index += 1) {
    const code = input.codePointAt(index);
    const character = String.fromCodePoint(code);
    if (code > 0xffff) index += 1;
    if (code === 0) result += '\uFFFD';
    else if ((code >= 1 && code <= 31) || code === 127 ||
      (index === 0 && code >= 48 && code <= 57) ||
      (index === 1 && code >= 48 && code <= 57 && input.codePointAt(0) === 45)) {
      result += `\\${code.toString(16)} `;
    } else if (index === 0 && code === 45 && input.length === 1) result += '\\-';
    else if (code >= 128 || code === 45 || code === 95 || (code >= 48 && code <= 57) ||
      (code >= 65 && code <= 90) || (code >= 97 && code <= 122)) result += character;
    else result += `\\${character}`;
  }
  return result;
}

function escapeCssString(value) {
  let output = '';
  for (const character of String(value)) {
    const code = character.codePointAt(0);
    if (character === '"' || character === '\\' || code < 32 || code === 127) output += `\\${code.toString(16)} `;
    else output += character;
  }
  return output;
}

function tagOf(node) {
  const value = typeof node?.tagName === 'string' ? node.tagName.trim().toLowerCase() : '';
  return /^[a-z][a-z0-9-]*$/u.test(value) ? value : '*';
}

function nodesFromIndex(index) {
  if (index?.byNodeId instanceof Map) return [...index.byNodeId.values()];
  if (index?.byId instanceof Map) return [...index.byId.values()];
  if (index?.byId && typeof index.byId === 'object') return Object.values(index.byId);
  return [];
}

function byNodeId(index, id) {
  if (index?.byNodeId instanceof Map) return index.byNodeId.get(String(id));
  if (index?.byId instanceof Map) return index.byId.get(String(id));
  return index?.byId?.[String(id)];
}

function idIsUnique(id, index) {
  const values = index?.byDomId instanceof Map ? index.byDomId.get(id) : index?.byDomId?.[id];
  if (Array.isArray(values)) return values.length === 1;
  if (values) return true;
  return nodesFromIndex(index).filter(node => node?.attributes?.id === id).length === 1;
}

function semanticSelector(node, index) {
  for (const name of SEMANTIC_ATTRIBUTES) {
    const value = typeof node?.attributes?.[name] === 'string' ? node.attributes[name].trim() : '';
    if (!value || SENSITIVE.test(`${name} ${value}`)) continue;
    const matches = nodesFromIndex(index).filter(candidate => tagOf(candidate) === tagOf(node) && candidate?.attributes?.[name] === value);
    if (matches.length <= 1) return `${tagOf(node)}[${name}="${escapeCssString(value)}"]`;
  }
  return '';
}

function nthPath(node, index) {
  const parts = [];
  const visited = new Set();
  let current = node;
  while (current && !visited.has(String(current.nodeId))) {
    visited.add(String(current.nodeId));
    const tag = tagOf(current);
    let part = tag;
    const parent = current.parentId == null ? null : byNodeId(index, current.parentId);
    if (parent && Array.isArray(parent.children)) {
      const siblings = parent.children.map(id => byNodeId(index, id)).filter(candidate => candidate && tagOf(candidate) === tag);
      if (siblings.length > 1) {
        const position = siblings.findIndex(candidate => String(candidate.nodeId) === String(current.nodeId));
        if (position >= 0) part += `:nth-of-type(${position + 1})`;
      }
    }
    parts.unshift(part);
    current = parent;
  }
  return parts.join(' > ') || '*';
}

function safePath(value) {
  return (Array.isArray(value) ? value : []).map(String).filter(part => part && !SENSITIVE.test(part));
}

/** Builds a deterministic selector without embedding credential-like data. */
export function buildStableSelector(node, index = {}) {
  if (!node || typeof node !== 'object') throw new TypeError('O nó da evidência é inválido.');
  const id = typeof node.attributes?.id === 'string' ? node.attributes.id.trim() : '';
  let css;
  let confidence;
  if (id && !SENSITIVE.test(id) && idIsUnique(id, index)) {
    css = `#${escapeCssIdentifier(id)}`;
    confidence = 'high';
  } else {
    css = semanticSelector(node, index);
    confidence = css ? 'medium' : 'low';
    if (!css) css = nthPath(node, index);
  }
  const shadowPath = safePath(node.shadowPath);
  if (shadowPath.length > 0) css = `${shadowPath.join(' >>> ')} >>> ${css}`;
  return { css, framePath: safePath(node.framePath), confidence };
}
