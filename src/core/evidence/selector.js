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
  return /^[a-z][a-z0-9-]*$/u.test(value) ? value : 'element';
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

function scopeKey(node) {
  const frame = (Array.isArray(node?.framePath) ? node.framePath : []).map(String).join('/');
  const shadow = node?.shadowHostId && node?.shadowRootId ? String(node.shadowRootId) : 'document';
  return `${frame}\u0000${shadow}`;
}

function idIsUnique(id, node, index) {
  return nodesFromIndex(index).filter(candidate =>
    candidate?.attributes?.id === id && scopeKey(candidate) === scopeKey(node)
  ).length === 1;
}

function semanticSelector(node, index) {
  for (const name of SEMANTIC_ATTRIBUTES) {
    const value = typeof node?.attributes?.[name] === 'string' ? node.attributes[name].trim() : '';
    if (!value || SENSITIVE.test(`${name} ${value}`)) continue;
    const matches = nodesFromIndex(index).filter(candidate => scopeKey(candidate) === scopeKey(node) &&
      tagOf(candidate) === tagOf(node) && candidate?.attributes?.[name] === value);
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
    if (current.shadowRootType || String(current.nodeId) === String(node.shadowRootId || '')) break;
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
  return parts.join(' > ') || 'element';
}

function safePath(value) {
  return (Array.isArray(value) ? value : []).map(String).filter(part => part && !SENSITIVE.test(part));
}

/** Builds a deterministic selector without embedding credential-like data. */
export function buildStableSelector(node, index = {}) {
  if (!node || typeof node !== 'object') throw new TypeError('O nó da evidência é inválido.');
  const visited = new Set();
  const build = current => {
    if (!current || visited.has(String(current.nodeId))) return { css: 'element', confidence: 'low' };
    visited.add(String(current.nodeId));
    const id = typeof current.attributes?.id === 'string' ? current.attributes.id.trim() : '';
    let css;
    let confidence;
    if (id && !SENSITIVE.test(id) && idIsUnique(id, current, index)) {
      css = `${tagOf(current)}#${escapeCssIdentifier(id)}`;
      confidence = 'high';
    } else {
      // A structural path plus independently recorded classes can be proved again
      // on the live page without exporting arbitrary text attributes as authority.
      const classed = typeof current.attributes?.class === 'string' && current.attributes.class.trim();
      css = classed ? '' : semanticSelector(current, index);
      confidence = css ? 'medium' : 'low';
      if (!css) css = nthPath(current, index);
    }
    if (current.shadowHostId && current.shadowRootId) {
      const host = byNodeId(index, current.shadowHostId);
      if (host) {
        const hostSelector = build(host);
        const ranks = { high: 2, medium: 1, low: 0 };
        confidence = ranks[hostSelector.confidence] < ranks[confidence] ? hostSelector.confidence : confidence;
        css = `${hostSelector.css} >>> ${css}`;
      }
    } else {
      const legacyShadowPath = safePath(current.shadowPath).filter(part => /^(?:[#.][^\s>]+|[a-z][a-z0-9-]*)$/iu.test(part));
      if (legacyShadowPath.length > 0) css = `${legacyShadowPath.join(' >>> ')} >>> ${css}`;
    }
    return { css, confidence };
  };
  const built = build(node);
  return { css: built.css, framePath: safePath(node.framePath), confidence: built.confidence };
}
