import { isSensitiveKeyName, SENSITIVE_KEY } from '../privacy.js';
// QUINTO vocabulário do produto, e o único que ainda era só em inglês: com ele, um `title="senha …"`
// virava seletor CSS e o valor ia inteiro para o relatório, o modelo e os artefatos (Critical da revisão
// da 1.1.31). Passa a usar o mesmo vocabulário compartilhado do resto do produto.
const SENSITIVE = SENSITIVE_KEY;
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

// Contagens por índice, calculadas uma vez. Antes, cada seletor varria TODOS os nós do índice (id único,
// atributo semântico único) e todos os irmãos de cada ancestral: numa vitrine com dezenas de milhares de
// nós isso era quadrático e custava minutos (bateria de páginas hostis, 1.1.53). Mesmos seletores de antes.
const INDEX_STATS = new WeakMap();
function indexContainer(index) {
  if (index?.byNodeId instanceof Map) return index.byNodeId;
  if (index?.byId && typeof index.byId === 'object') return index.byId;
  return null;
}
function indexSize(container) {
  return container instanceof Map ? container.size : Object.keys(container).length;
}
function indexStats(index) {
  const container = indexContainer(index);
  if (!container) return null;
  const size = indexSize(container);
  const cached = INDEX_STATS.get(container);
  if (cached && cached.size === size) return cached;
  const ids = new Map();
  const semantic = new Map();
  for (const candidate of nodesFromIndex(index)) {
    const scope = scopeKey(candidate);
    const id = candidate?.attributes?.id;
    if (typeof id === 'string') ids.set(`${scope}\u0000${id}`, (ids.get(`${scope}\u0000${id}`) ?? 0) + 1);
    for (const name of SEMANTIC_ATTRIBUTES) {
      const value = candidate?.attributes?.[name];
      if (typeof value !== 'string') continue;
      const key = `${scope}\u0000${tagOf(candidate)}\u0000${name}\u0000${value}`;
      semantic.set(key, (semantic.get(key) ?? 0) + 1);
    }
  }
  const stats = { size, ids, semantic, positions: new Map() };
  INDEX_STATS.set(container, stats);
  return stats;
}

function idIsUnique(id, node, index) {
  const stats = indexStats(index);
  if (!stats) return false;
  return stats.ids.get(`${scopeKey(node)}\u0000${id}`) === 1;
}

function semanticSelector(node, index) {
  for (const name of SEMANTIC_ATTRIBUTES) {
    const value = typeof node?.attributes?.[name] === 'string' ? node.attributes[name].trim() : '';
    if (!value || isSensitiveKeyName(`${name} ${value}`)) continue;
    const stats = indexStats(index);
    const matches = stats ? stats.semantic.get(`${scopeKey(node)}\u0000${tagOf(node)}\u0000${name}\u0000${value}`) ?? 0 : 0;
    if (matches <= 1) return `${tagOf(node)}[${name}="${escapeCssString(value)}"]`;
  }
  return '';
}

function siblingPosition(parent, current, tag, index) {
  const stats = indexStats(index);
  const compute = () => {
    const positions = new Map();
    const totals = new Map();
    const firstIndex = new Map();
    for (const id of parent.children) {
      const candidate = byNodeId(index, id);
      if (!candidate) continue;
      const candidateTag = tagOf(candidate);
      const position = totals.get(candidateTag) ?? 0;
      totals.set(candidateTag, position + 1);
      const key = String(candidate.nodeId);
      if (!firstIndex.has(`${candidateTag}\u0000${key}`)) firstIndex.set(`${candidateTag}\u0000${key}`, position);
      positions.set(key, positions.get(key) ?? position);
    }
    return { firstIndex, totals };
  };
  let entry = stats?.positions.get(parent);
  if (!entry) {
    entry = compute();
    stats?.positions.set(parent, entry);
  }
  const position = entry.firstIndex.get(`${tag}\u0000${String(current.nodeId)}`);
  return { position: position ?? -1, total: entry.totals.get(tag) ?? 0 };
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
      const { position, total } = siblingPosition(parent, current, tag, index);
      if (total > 1 && position >= 0) part += `:nth-of-type(${position + 1})`;
    }
    parts.unshift(part);
    current = parent;
  }
  return parts.join(' > ') || 'element';
}

function safePath(value) {
  return (Array.isArray(value) ? value : []).map(String).filter(part => part && !isSensitiveKeyName(part));
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
    if (id && !isSensitiveKeyName(id) && idIsUnique(id, current, index)) {
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
