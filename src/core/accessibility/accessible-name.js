const NO_SOURCE = 'none';

function normalizeText(value) {
  return typeof value === 'string'
    ? value.replace(/\s+/gu, ' ').trim()
    : '';
}

function attributesOf(node) {
  return node && typeof node.attributes === 'object' && node.attributes !== null
    ? node.attributes
    : {};
}

function attribute(node, name) {
  const value = attributesOf(node)[name];
  return typeof value === 'string' ? value : value === true ? '' : undefined;
}

function tagOf(node) {
  return normalizeText(node?.tagName).toLowerCase();
}

function isHidden(node) {
  const attributes = attributesOf(node);
  return node?.hidden === true
    || Object.hasOwn(attributes, 'hidden')
    || attributes['aria-hidden'] === true
    || attributes['aria-hidden'] === 'true';
}

function nodesFromIndex(index) {
  if (index instanceof Map) return [...index.values()];
  if (Array.isArray(index)) return index;
  if (index && typeof index === 'object') return Object.values(index);
  return [];
}

function nodeId(node) {
  return normalizeText(node?.id) || normalizeText(attribute(node, 'id'));
}

function findById(index, id) {
  if (!id) return undefined;
  if (index instanceof Map) return index.get(id);
  if (Array.isArray(index)) return index.find(node => nodeId(node) === id);
  if (index && typeof index === 'object') return index[id] ?? nodesFromIndex(index).find(node => nodeId(node) === id);
  return undefined;
}

function hasAttribute(node, name) {
  return Object.hasOwn(attributesOf(node), name);
}

function textFromContents(node, allowHidden) {
  if (!node || (!allowHidden && isHidden(node))) return '';

  const ownText = normalizeText(node.text);
  const childText = Array.isArray(node.children)
    ? node.children.map(child => textFromContents(child, allowHidden)).filter(Boolean).join(' ')
    : '';

  return normalizeText([ownText, childText].filter(Boolean).join(' '));
}

const CONTENT_NAME_TAGS = new Set(['a', 'button', 'label', 'legend', 'option', 'summary']);
const CONTENT_NAME_ROLES = new Set([
  'button', 'checkbox', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'option', 'radio', 'switch', 'tab', 'treeitem'
]);
const LABELABLE_TAGS = new Set(['button', 'input', 'meter', 'output', 'progress', 'select', 'textarea']);

function roleOf(node) {
  return normalizeText(attribute(node, 'role')).toLowerCase();
}

function isLabelable(node) {
  const tag = tagOf(node);
  return LABELABLE_TAGS.has(tag) && !(tag === 'input' && normalizeText(attribute(node, 'type')).toLowerCase() === 'hidden');
}

function acceptsContents(node, fromReference) {
  if (fromReference) return true;
  const role = roleOf(node);
  if (role) return CONTENT_NAME_ROLES.has(role);
  return CONTENT_NAME_TAGS.has(tagOf(node));
}

function axText(axNode, property) {
  if (!axNode || typeof axNode !== 'object') return '';
  const candidate = axNode[property];
  if (typeof candidate === 'string') return normalizeText(candidate);
  if (candidate && typeof candidate === 'object' && typeof candidate.value === 'string') {
    return normalizeText(candidate.value);
  }
  return '';
}

function resolveReferences(ids, index, visiting) {
  const parts = [];
  for (const id of normalizeText(ids).split(' ')) {
    if (!id) continue;
    const referenced = findById(index, id);
    if (!referenced || visiting.has(referenced)) continue;

    const text = fallbackName(referenced, index, new Set(visiting), true, true).value;
    if (text) parts.push(text);
  }
  return normalizeText(parts.join(' '));
}

function nativeLabelText(node, index, visiting) {
  if (!isLabelable(node)) return '';

  const labels = Array.isArray(node?.labels) ? node.labels : [];
  const fromLabels = labels.map(label => {
    if (typeof label === 'string') {
      const referenced = findById(index, label);
      return referenced
        ? fallbackName(referenced, index, new Set(visiting), true, true).value
        : normalizeText(label);
    }
    return fallbackName(label, index, new Set(visiting), true, true).value;
  }).filter(Boolean);

  const id = nodeId(node);
  const fromFor = id
    ? nodesFromIndex(index)
      .filter(candidate => tagOf(candidate) === 'label' && attribute(candidate, 'for') === id)
      .map(label => fallbackName(label, index, new Set(visiting), true, true).value)
      .filter(Boolean)
    : [];

  return normalizeText([...fromLabels, ...fromFor].join(' '));
}

function fallbackName(node, index, visiting = new Set(), allowHiddenRoot = false, fromReference = false) {
  if (!node || (!allowHiddenRoot && isHidden(node))) return { value: '', source: NO_SOURCE };
  if (visiting.has(node)) return { value: '', source: NO_SOURCE };

  const nextVisiting = new Set(visiting);
  nextVisiting.add(node);

  const labelledBy = attribute(node, 'aria-labelledby');
  if (labelledBy) {
    const value = resolveReferences(labelledBy, index, nextVisiting);
    if (value) return { value, source: 'aria-labelledby' };
  }

  const ariaLabel = normalizeText(attribute(node, 'aria-label'));
  if (ariaLabel) return { value: ariaLabel, source: 'aria-label' };

  const nativeLabel = nativeLabelText(node, index, nextVisiting);
  if (nativeLabel) return { value: nativeLabel, source: 'label' };

  const isImageInput = tagOf(node) === 'input' && normalizeText(attribute(node, 'type')).toLowerCase() === 'image';
  if (hasAttribute(node, 'alt') && (['area', 'img'].includes(tagOf(node)) || isImageInput)) {
    return { value: normalizeText(attribute(node, 'alt')), source: 'alt' };
  }

  if (acceptsContents(node, fromReference)) {
    const contents = textFromContents(node, allowHiddenRoot && isHidden(node));
    if (contents) return { value: contents, source: 'contents' };
  }

  const title = normalizeText(attribute(node, 'title'));
  if (title) return { value: title, source: 'title' };

  return { value: '', source: NO_SOURCE };
}

function fallbackDescription(node, index, finalName) {
  const describedBy = attribute(node, 'aria-describedby');
  if (describedBy) {
    const value = resolveReferences(describedBy, index, new Set([node]));
    if (value) return { value, source: 'aria-describedby' };
  }

  const title = normalizeText(attribute(node, 'title'));
  if (title && title !== finalName) {
    return { value: title, source: 'title' };
  }

  return { value: '', source: NO_SOURCE };
}

/**
 * Computes a conservative, serializable accessible-text estimate.
 *
 * Chromium's AX name and description are preferred when supplied. The DOM
 * fallback intentionally covers only deterministic sources; it is not a full
 * implementation of the Accessible Name and Description Computation.
 */
export function computeAccessibleText(node, index, axNode) {
  const axName = axText(axNode, 'name');
  const axDescription = axText(axNode, 'description');
  const fallback = fallbackName(node, index);
  const name = axName || fallback.value;
  const description = fallbackDescription(node, index, name);

  return {
    name,
    nameSource: axName ? 'accessibility-tree' : fallback.source,
    description: axDescription || description.value,
    descriptionSource: axDescription ? 'accessibility-tree' : description.source
  };
}
