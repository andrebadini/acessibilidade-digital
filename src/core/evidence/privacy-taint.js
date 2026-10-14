import { isEditableAccessibilityNode } from '../accessibility/element-accessibility.js';

/**
 * Auxiliares de ancestralidade e de contaminação por privacidade compartilhados pelos mapas
 * derivados (mapa de anúncios e mapa do teclado).
 *
 * A regra é sempre a mesma: um nó que guarda valor digitado, ou que depende de um nó assim, não
 * pode ser projetado. Extraído de `src/browser/annotation-map.js` na 1.1.58 para que o mapa do
 * teclado aplique exatamente a mesma fronteira — duas cópias da mesma política de privacidade
 * divergem na primeira correção.
 */
const PRIVATE_ATTRIBUTE = /(?:^(?:data-(?:audita-)?private|data-nosnippet)$|pass(?:word|wd)?|token|secret|auth(?:orization)?|session|cookie|csrf|xsrf|otp|one[-_ ]?time|api[-_ ]?key)/iu;

function normalizedText(value) {
  return typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '';
}

function safeTag(node) {
  const value = normalizedText(node?.tagName).toLowerCase();
  return /^[a-z][a-z0-9-]{0,63}$/u.test(value) ? value : 'element';
}

export function privateMarker(node) {
  if (node?.privacyReferenceStatus === 'omitted-privacy') return true;
  for (const [name, value] of Object.entries(node?.attributes || {})) {
    if (PRIVATE_ATTRIBUTE.test(name) || String(value ?? '') === '[redacted]') return true;
  }
  return node?.valueStatus === 'omitted-privacy' && !['input', 'select', 'textarea'].includes(safeTag(node));
}

export function ancestorState(node, indexes, predicate) {
  const visited = new Set();
  let current = node;
  while (current && !visited.has(String(current.nodeId))) {
    visited.add(String(current.nodeId));
    if (predicate(current)) return true;
    current = current.parentId === null || current.parentId === undefined ? null : indexes.byNodeId.get(String(current.parentId));
  }
  return false;
}

export function privacyTaintedNodeIds(snapshot, indexes) {
  const dependents = new Map();
  const addDependency = (source, consumer) => {
    const sourceId = String(source.nodeId);
    const values = dependents.get(sourceId) ?? new Set();
    values.add(String(consumer.nodeId));
    dependents.set(sourceId, values);
  };
  for (const node of snapshot.nodes) {
    for (const attribute of ['aria-labelledby', 'aria-describedby']) {
      const references = normalizedText(node.attributes?.[attribute]).split(' ').filter(Boolean);
      for (const reference of references) {
        const matches = indexes.byDomId.get(reference);
        for (const match of matches ?? []) addDependency(match, node);
      }
    }
    for (const labelId of Array.isArray(node.labels) ? node.labels : []) {
      const label = indexes.byNodeId.get(String(labelId));
      if (label) addDependency(label, node);
    }
    if (['button', 'input', 'meter', 'output', 'progress', 'select', 'textarea'].includes(safeTag(node))) {
      const visited = new Set();
      let ancestor = node.parentId === null || node.parentId === undefined
        ? null
        : indexes.byNodeId.get(String(node.parentId));
      while (ancestor && !visited.has(String(ancestor.nodeId))) {
        visited.add(String(ancestor.nodeId));
        if (safeTag(ancestor) === 'label') addDependency(ancestor, node);
        ancestor = ancestor.parentId === null || ancestor.parentId === undefined
          ? null
          : indexes.byNodeId.get(String(ancestor.parentId));
      }
    }
  }
  for (const label of snapshot.nodes.filter(node => safeTag(node) === 'label')) {
    const targetId = normalizedText(label.attributes?.for);
    const matches = targetId ? indexes.byDomId.get(targetId) : null;
    for (const match of matches ?? []) addDependency(label, match);
  }

  const tainted = new Set();
  const queue = [];
  const taintWithAncestors = node => {
    const visited = new Set();
    let current = node;
    while (current && !visited.has(String(current.nodeId))) {
      const nodeId = String(current.nodeId);
      visited.add(nodeId);
      if (!tainted.has(nodeId)) {
        tainted.add(nodeId);
        queue.push(nodeId);
      }
      current = current.parentId === null || current.parentId === undefined
        ? null
        : indexes.byNodeId.get(String(current.parentId));
    }
  };
  const taintSensitiveSubtree = root => {
    const pending = [root];
    const visited = new Set();
    for (let offset = 0; offset < pending.length; offset += 1) {
      const node = pending[offset];
      if (!node || visited.has(String(node.nodeId))) continue;
      visited.add(String(node.nodeId));
      taintWithAncestors(node);
      for (const childId of Array.isArray(node.children) ? node.children : []) {
        pending.push(indexes.byNodeId.get(String(childId)));
      }
    }
  };
  for (const node of snapshot.nodes) {
    if (isEditableAccessibilityNode(node) || privateMarker(node)) taintSensitiveSubtree(node);
  }
  for (let offset = 0; offset < queue.length; offset += 1) {
    for (const dependentId of dependents.get(queue[offset]) ?? []) {
      taintWithAncestors(indexes.byNodeId.get(dependentId));
    }
  }
  return tainted;
}
