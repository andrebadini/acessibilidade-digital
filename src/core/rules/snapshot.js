export function hasOwn(value, field) {
  return value !== null && typeof value === 'object' && Object.hasOwn(value, field);
}

export function normalizeText(value) {
  return typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '';
}

export function normalizedComparableText(value) {
  return normalizeText(value).normalize('NFKC').toLocaleLowerCase('pt-BR');
}

export function attributesOf(node) {
  return node && typeof node.attributes === 'object' && node.attributes !== null &&
    !Array.isArray(node.attributes)
    ? node.attributes
    : {};
}

export function attribute(node, name) {
  if (!Object.hasOwn(attributesOf(node), name)) return undefined;
  const value = attributesOf(node)[name];
  if (typeof value === 'string') return value;
  return value === true ? '' : undefined;
}

export function hasAttribute(node, name) {
  return Object.hasOwn(attributesOf(node), name);
}

export function tagOf(node) {
  return normalizeText(node?.tagName).toLowerCase();
}

export function roleOf(node) {
  return normalizeText(node?.role || attribute(node, 'role')).toLowerCase();
}

export function nodeIdOf(node) {
  const value = node?.nodeId;
  return typeof value === 'string' || Number.isSafeInteger(value) ? value : null;
}

export function selectorOf(node) {
  return typeof node?.selectorHint === 'string' ? node.selectorHint : '';
}

export function snapshotParts(snapshot) {
  if (
    snapshot === null || typeof snapshot !== 'object' ||
    !hasOwn(snapshot, 'document') || snapshot.document === null ||
    typeof snapshot.document !== 'object' || Array.isArray(snapshot.document) ||
    !hasOwn(snapshot, 'nodes') || !Array.isArray(snapshot.nodes) ||
    !hasOwn(snapshot, 'byId') || snapshot.byId === null ||
    typeof snapshot.byId !== 'object' || Array.isArray(snapshot.byId)
  ) {
    return null;
  }
  return { document: snapshot.document, nodes: snapshot.nodes };
}

export function nodeIndex(nodes) {
  const index = new Map();
  for (const node of nodes) {
    const id = nodeIdOf(node);
    if (id !== null) index.set(String(id), node);
  }
  return index;
}

export function domIdIndex(nodes) {
  const index = new Map();
  for (const node of nodes) {
    const id = normalizeText(attribute(node, 'id'));
    if (!id) continue;
    const matches = index.get(id) ?? [];
    matches.push(node);
    index.set(id, matches);
  }
  return index;
}

export function references(value) {
  return normalizeText(value).split(' ').filter(Boolean);
}

export function invalidReferences(node, attributeNames, ids) {
  for (const name of attributeNames) {
    if (!hasAttribute(node, name)) continue;
    for (const id of references(attribute(node, name))) {
      const count = ids.get(id)?.length ?? 0;
      if (count !== 1) {
        return {
          attribute: name,
          reason: count === 0 ? 'missing-idref' : 'ambiguous-idref'
        };
      }
    }
  }
  return null;
}

export function ancestorNodes(node, index) {
  const ancestors = [];
  const visited = new Set();
  let parentId = node?.parentId;
  while (parentId !== null && parentId !== undefined && !visited.has(String(parentId))) {
    visited.add(String(parentId));
    const parent = index.get(String(parentId));
    if (!parent) return { ancestors, complete: false };
    ancestors.push(parent);
    parentId = parent.parentId;
  }
  return { ancestors, complete: true };
}

export function descendantsOf(node, index) {
  if (!Array.isArray(node?.children)) return null;
  const descendants = [];
  const queue = [...node.children];
  const visited = new Set();
  while (queue.length > 0) {
    const id = String(queue.shift());
    if (visited.has(id)) continue;
    visited.add(id);
    const child = index.get(id);
    if (!child) return null;
    descendants.push(child);
    if (!Array.isArray(child.children)) return null;
    queue.push(...child.children);
  }
  return descendants;
}

export function isHidden(node) {
  return node?.hidden === true || hasAttribute(node, 'hidden') ||
    attribute(node, 'aria-hidden') === 'true';
}

export function target(node, message, data = {}) {
  return {
    nodeId: nodeIdOf(node),
    selectorHint: selectorOf(node),
    message,
    data
  };
}

export function documentTarget(document, message, data = {}) {
  return {
    nodeId: nodeIdOf(document),
    selectorHint: '',
    message,
    data
  };
}

export function result(outcome, summary, targets = [], limitations = []) {
  return { outcome, targets, summary, limitations };
}

export function missingSnapshotResult() {
  return result(
    'cantTell',
    'Não foi possível avaliar a regra com o snapshot estrutural disponível.',
    [],
    ['O snapshot deve conter document, nodes e byId em formato serializável.']
  );
}

const NATIVE_CONTROL_TAGS = new Set(['button', 'select', 'textarea']);
const INPUT_CONTROL_TYPES = new Set([
  'button', 'checkbox', 'color', 'date', 'datetime-local', 'email', 'file', 'image',
  'month', 'number', 'password', 'radio', 'range', 'reset', 'search', 'submit',
  'tel', 'text', 'time', 'url', 'week'
]);
const COMPONENT_ROLES = new Set([
  'button', 'checkbox', 'combobox', 'link', 'listbox', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'option', 'radio', 'searchbox', 'slider', 'spinbutton', 'switch',
  'tab', 'textbox', 'treeitem'
]);

export function isNativeControl(node) {
  const tag = tagOf(node);
  if (NATIVE_CONTROL_TAGS.has(tag)) return true;
  if (tag === 'a') return hasAttribute(node, 'href');
  if (tag !== 'input') return false;
  const type = normalizeText(attribute(node, 'type') ?? 'text').toLowerCase();
  return INPUT_CONTROL_TYPES.has(type) && type !== 'hidden';
}

export function isComponent(node) {
  return !isHidden(node) && (isNativeControl(node) || COMPONENT_ROLES.has(roleOf(node)) ||
    node?.interaction === 'link' || node?.interaction === 'button');
}

export function isFormField(node) {
  if (isHidden(node)) return false;
  const tag = tagOf(node);
  if (tag === 'select' || tag === 'textarea') return true;
  if (tag !== 'input') return false;
  const type = normalizeText(attribute(node, 'type') ?? 'text').toLowerCase();
  return !['button', 'hidden', 'image', 'reset', 'submit'].includes(type);
}
