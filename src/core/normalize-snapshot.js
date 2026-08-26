import { assertSnapshotV1 } from './snapshot-schema.js';
import { redactSensitiveText } from './privacy.js';

const SENSITIVE = /(?:pass(?:word|wd)?|token|secret|auth(?:orization)?|session|cookie|csrf|xsrf|otp|one[-_ ]?time|api[-_ ]?key)/iu;
const URL_ATTRIBUTES = new Set(['action', 'cite', 'formaction', 'href', 'poster', 'src']);
const EXECUTABLE_TEXT_PARENTS = new Set(['script', 'style', 'template']);

function cleanText(value) {
  return typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '';
}

export function sanitizeResourceUrl(value, base) {
  if (typeof value !== 'string' || value.trim() === '') return '';
  if (/^data:/iu.test(value)) return value.replace(/#.*$/u, '');
  try {
    const url = new URL(value, base);
    if (!['http:', 'https:', 'blob:'].includes(url.protocol)) return '';
    url.username = '';
    url.password = '';
    for (const key of [...url.searchParams.keys()]) if (SENSITIVE.test(key)) url.searchParams.delete(key);
    if (SENSITIVE.test(url.hash)) url.hash = '';
    return url.href;
  } catch {
    return '';
  }
}

function sensitiveElement(tagName, attributes) {
  if (tagName !== 'input') return false;
  const type = cleanText(attributes.type || 'text').toLowerCase();
  const autocomplete = cleanText(attributes.autocomplete).toLowerCase();
  return type === 'password' || ['current-password', 'new-password', 'one-time-code'].includes(autocomplete) ||
    (type === 'hidden' && SENSITIVE.test(`${attributes.id || ''} ${attributes.name || ''} ${autocomplete}`));
}

function sanitizeAttributes(input, tagName, base) {
  const output = {};
  const normalizedInput = Object.fromEntries(Object.entries(input || {}).map(([name, value]) => [String(name).toLowerCase(), value]));
  for (const [name, rawValue] of Object.entries(normalizedInput)) {
    if (/^on/iu.test(name) || name === 'srcdoc') continue;
    if (name === 'value' && sensitiveElement(tagName, normalizedInput)) continue;
    let value = typeof rawValue === 'string' ? rawValue : rawValue === true ? '' : String(rawValue ?? '');
    if (URL_ATTRIBUTES.has(name)) value = sanitizeResourceUrl(value, base);
    output[name] = value;
  }
  return output;
}

function stringAt(strings, value) {
  if (typeof value === 'number') return typeof strings[value] === 'string' ? strings[value] : '';
  return typeof value === 'string' ? value : '';
}

function sparseMap(value, strings, resolveStrings = false) {
  const result = new Map();
  if (!value || !Array.isArray(value.index)) return result;
  for (let position = 0; position < value.index.length; position += 1) {
    const item = Array.isArray(value.value) ? value.value[position] : true;
    result.set(value.index[position], resolveStrings ? stringAt(strings, item) : item);
  }
  return result;
}

function axString(value) {
  if (typeof value === 'string') return cleanText(value);
  if (!value || typeof value !== 'object') return '';
  if (typeof value.value === 'string' || typeof value.value === 'number' || typeof value.value === 'boolean') return cleanText(String(value.value));
  return '';
}

function copyRect(value) {
  if (Array.isArray(value) && value.length >= 4 && value.slice(0, 4).every(Number.isFinite)) {
    return { x: value[0], y: value[1], width: value[2], height: value[3] };
  }
  if (value && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(value[key]))) {
    return { x: value.x, y: value.y, width: value.width, height: value.height };
  }
  return null;
}

function copyRuntime(record, base) {
  const result = {};
  for (const key of ['visibleText', 'focusable', 'interaction', 'interactive', 'required', 'checked', 'disabled', 'active', 'hidden', 'shadowHost', 'shadowRootMode']) {
    if (typeof record?.[key] === 'string' || typeof record?.[key] === 'boolean' || record?.[key] === null) result[key] = record[key];
  }
  if (typeof record?.selectorHint === 'string' && !SENSITIVE.test(record.selectorHint)) result.selectorHint = record.selectorHint;
  const rect = copyRect(record?.rect);
  if (rect) result.rect = rect;
  if (record?.styles && typeof record.styles === 'object' && !Array.isArray(record.styles)) {
    result.styles = Object.fromEntries(Object.entries(record.styles).filter(([, value]) => typeof value === 'string'));
  }
  if (record?.form && typeof record.form === 'object' && !Array.isArray(record.form)) {
    result.form = Object.fromEntries(Object.entries(record.form).filter(([, value]) => ['string', 'boolean', 'number'].includes(typeof value)));
  }
  if (record?.media && typeof record.media === 'object' && !Array.isArray(record.media)) {
    result.media = {};
    for (const [key, value] of Object.entries(record.media)) {
      if (key === 'currentSrc' || key === 'src') result.media[key] = sanitizeResourceUrl(value, base);
      else if (['string', 'boolean', 'number'].includes(typeof value) || value === null) result.media[key] = value;
    }
  }
  if (Array.isArray(record?.animations)) {
    result.animations = record.animations.map(item => ({
      playState: typeof item?.playState === 'string' ? item.playState : '',
      currentTime: Number.isFinite(item?.currentTime) ? item.currentTime : null
    }));
  }
  return result;
}

function normalizeSimplified(raw) {
  if (raw.format !== 'simplified-v1' || !Array.isArray(raw.nodes)) throw new TypeError('Formato simplificado de DOMSnapshot não reconhecido.');
  const base = sanitizeResourceUrl(raw.document?.url || '') || 'https://invalid.local/';
  const idByBackend = new Map(raw.nodes.map((node, index) => [node.backendNodeId, `n-${node.backendNodeId ?? `fixture-${index + 1}`}`]));
  const axByBackend = new Map();
  for (const ax of Array.isArray(raw.axTree) ? raw.axTree : raw.axTree?.nodes || []) {
    if (Number.isFinite(ax?.backendDOMNodeId) && !axByBackend.has(ax.backendDOMNodeId)) axByBackend.set(ax.backendDOMNodeId, ax);
  }
  const nodes = raw.nodes.map((node, index) => {
    const tagName = cleanText(node.tagName).toLowerCase();
    const attributes = sanitizeAttributes(node.attributes, tagName, base);
    const sensitive = sensitiveElement(tagName, attributes);
    const runtimeData = copyRuntime(node, base);
    const normalized = {
      nodeId: idByBackend.get(node.backendNodeId) || `n-fixture-${index + 1}`,
      parentId: node.parentBackendNodeId == null ? null : idByBackend.get(node.parentBackendNodeId) || null,
      children: [],
      tagName,
      attributes,
      backendNodeId: Number.isFinite(node.backendNodeId) ? node.backendNodeId : null,
      frameId: cleanText(node.frameId || 'main'),
      framePath: Array.isArray(node.framePath) ? node.framePath.map(String) : [],
      selectorHint: typeof node.selectorHint === 'string' && !SENSITIVE.test(node.selectorHint) ? node.selectorHint : '',
      text: sensitive || EXECUTABLE_TEXT_PARENTS.has(tagName) ? '' : cleanText(node.text),
      visibleText: sensitive ? '' : cleanText(node.visibleText ?? node.text),
      hidden: node.hidden === true || (tagName === 'input' && cleanText(attributes.type).toLowerCase() === 'hidden'),
      ...runtimeData
    };
    const ax = axByBackend.get(node.backendNodeId);
    if (ax) {
      const role = axString(ax.role);
      const name = axString(ax.name);
      const description = axString(ax.description);
      const value = sensitive ? '' : axString(ax.value);
      if (role) normalized.axRole = role;
      if (name) normalized.accessibleName = name;
      if (description) normalized.accessibleDescription = description;
      if (value) normalized.axValue = value;
    }
    return normalized;
  });
  const byId = new Map(nodes.map(node => [node.nodeId, node]));
  for (const node of nodes) if (node.parentId && byId.has(node.parentId)) byId.get(node.parentId).children.push(node.nodeId);
  return assertSnapshotV1({
    schemaVersion: 1,
    document: { nodeId: 'document', title: cleanText(raw.document?.title), url: sanitizeResourceUrl(raw.document?.url || ''), language: cleanText(raw.document?.language), warnings: [] },
    nodes
  });
}

function normalizeColumnar(raw) {
  const capture = raw.domSnapshot;
  if (!capture || !Array.isArray(capture.strings) || !Array.isArray(capture.documents)) {
    throw new TypeError('DOMSnapshot columnar ausente ou inválido.');
  }
  const strings = capture.strings;
  const documents = capture.documents;
  const styleNames = Array.isArray(capture.computedStyles) ? capture.computedStyles : [];
  const records = [];
  const byDocumentAndIndex = new Map();
  const referencedDocuments = new Set();
  const contentDocumentByHost = new Map();

  documents.forEach((document, documentIndex) => {
    const nodes = document.nodes || {};
    const count = Array.isArray(nodes.nodeType) ? nodes.nodeType.length : 0;
    const shadowTypes = sparseMap(nodes.shadowRootType, strings, true);
    const contentDocuments = sparseMap(nodes.contentDocumentIndex, strings, false);
    for (const [hostIndex, childDocumentIndex] of contentDocuments) {
      if (Number.isInteger(childDocumentIndex)) {
        referencedDocuments.add(childDocumentIndex);
        contentDocumentByHost.set(`${documentIndex}:${hostIndex}`, childDocumentIndex);
      }
    }
    const frameId = stringAt(strings, document.frameId) || String(document.frameId ?? (documentIndex === 0 ? 'main' : `frame-${documentIndex}`));
    const base = sanitizeResourceUrl(stringAt(strings, document.documentURL)) || 'https://invalid.local/';
    const layoutByNode = new Map();
    let elementOrder = 0;
    if (document.layout && Array.isArray(document.layout.nodeIndex)) {
      document.layout.nodeIndex.forEach((nodeIndex, layoutIndex) => {
        const rect = copyRect(document.layout.bounds?.[layoutIndex]);
        const styles = {};
        const styleRow = document.layout.styles?.[layoutIndex];
        if (Array.isArray(styleRow)) styleNames.forEach((name, index) => {
          const value = stringAt(strings, styleRow[index]);
          if (value !== '') styles[name] = value;
        });
        layoutByNode.set(nodeIndex, { ...(rect ? { rect } : {}), ...(Object.keys(styles).length ? { styles } : {}) });
      });
    }
    for (let nodeIndex = 0; nodeIndex < count; nodeIndex += 1) {
      const rawName = stringAt(strings, nodes.nodeName?.[nodeIndex]);
      const tagName = rawName.startsWith('#') ? rawName.toLowerCase() : rawName.toLowerCase();
      const rawAttributes = {};
      const attributeRow = nodes.attributes?.[nodeIndex];
      if (Array.isArray(attributeRow)) for (let i = 0; i + 1 < attributeRow.length; i += 2) {
        rawAttributes[stringAt(strings, attributeRow[i]).toLowerCase()] = stringAt(strings, attributeRow[i + 1]);
      }
      const backendNodeId = Number.isFinite(nodes.backendNodeId?.[nodeIndex]) ? nodes.backendNodeId[nodeIndex] : null;
      const id = backendNodeId !== null ? `n-${backendNodeId}` : `n-d${documentIndex}-${nodeIndex}`;
      const record = {
        id, documentIndex, nodeIndex, nodeType: nodes.nodeType[nodeIndex], tagName,
        backendNodeId, frameId, base,
        parentIndex: Number.isInteger(nodes.parentIndex?.[nodeIndex]) ? nodes.parentIndex[nodeIndex] : -1,
        attributes: sanitizeAttributes(rawAttributes, tagName, base),
        rawText: stringAt(strings, nodes.nodeValue?.[nodeIndex]),
        shadowRootType: shadowTypes.get(nodeIndex) || null,
        layout: layoutByNode.get(nodeIndex) || {},
        childDocumentIndex: contentDocumentByHost.get(`${documentIndex}:${nodeIndex}`)
      };
      if (record.nodeType === 1) {
        record.elementOrder = elementOrder;
        elementOrder += 1;
      }
      records.push(record);
      byDocumentAndIndex.set(`${documentIndex}:${nodeIndex}`, record);
    }
  });

  const axByBackend = new Map();
  for (const ax of Array.isArray(raw.axTree) ? raw.axTree : raw.axTree?.nodes || []) {
    if (Number.isFinite(ax?.backendDOMNodeId) && !axByBackend.has(ax.backendDOMNodeId)) axByBackend.set(ax.backendDOMNodeId, ax);
  }
  const runtimeByBackend = new Map();
  const runtimeBySelector = new Map();
  const runtimeByUrlSelector = new Map();
  const runtimeByUrlOrder = new Map();
  for (const entry of Array.isArray(raw.pageData) ? raw.pageData : []) {
    const data = entry?.result && typeof entry.result === 'object' ? entry.result : entry;
    const frameId = String(entry?.frameId ?? data?.frameId ?? '');
    const runtimeUrl = sanitizeResourceUrl(data?.url || '');
    for (const node of Array.isArray(data?.nodes) ? data.nodes : []) {
      if (Number.isFinite(node.backendNodeId)) runtimeByBackend.set(node.backendNodeId, node);
      if (typeof node.selectorHint === 'string') {
        runtimeBySelector.set(`${frameId}:${node.selectorHint}`, node);
        if (runtimeUrl) runtimeByUrlSelector.set(`${runtimeUrl}:${node.selectorHint}`, node);
      }
      if (runtimeUrl && Number.isSafeInteger(node.order) && typeof node.tagName === 'string') {
        runtimeByUrlOrder.set(`${runtimeUrl}:${node.order}:${node.tagName.toLowerCase()}`, node);
      }
    }
  }

  const rootsByDocument = new Map();
  const childrenByRecord = new Map();
  for (const record of records) childrenByRecord.set(record, []);
  for (const record of records) {
    const parent = byDocumentAndIndex.get(`${record.documentIndex}:${record.parentIndex}`);
    if (parent) childrenByRecord.get(parent).push(record);
    else {
      const roots = rootsByDocument.get(record.documentIndex) || [];
      roots.push(record);
      rootsByDocument.set(record.documentIndex, roots);
    }
  }
  const documentHost = new Map();
  for (const record of records) if (Number.isInteger(record.childDocumentIndex)) documentHost.set(record.childDocumentIndex, record);

  const ordered = [];
  const framePaths = new Map();
  const visitRecord = (record, framePath) => {
    if (record.nodeType !== 9) {
      ordered.push(record);
      framePaths.set(record, framePath);
    }
    for (const child of childrenByRecord.get(record) || []) visitRecord(child, framePath);
    if (Number.isInteger(record.childDocumentIndex)) {
      for (const root of rootsByDocument.get(record.childDocumentIndex) || []) visitRecord(root, [...framePath, record.id]);
    }
  };
  const visitDocument = documentIndex => {
    const host = documentHost.get(documentIndex);
    const path = host ? [...(framePaths.get(host) || []), host.id] : [];
    for (const root of rootsByDocument.get(documentIndex) || []) visitRecord(root, path);
  };
  documents.forEach((_, index) => { if (!referencedDocuments.has(index)) visitDocument(index); });
  documents.forEach((_, index) => {
    if (!ordered.some(record => record.documentIndex === index)) visitDocument(index);
  });

  const outputByRecord = new Map();
  const descendantText = (record) => {
    if (EXECUTABLE_TEXT_PARENTS.has(record.tagName) || sensitiveElement(record.tagName, record.attributes)) return '';
    const parts = [record.rawText];
    for (const child of childrenByRecord.get(record) || []) parts.push(descendantText(child));
    return cleanText(parts.join(' '));
  };
  const nodes = ordered.map(record => {
    const host = documentHost.get(record.documentIndex);
    const parent = byDocumentAndIndex.get(`${record.documentIndex}:${record.parentIndex}`);
    const effectiveParent = parent?.nodeType === 9 ? host || null : parent || host || null;
    const idSelector = record.attributes.id ? `#${record.attributes.id}` : '';
    const runtime = runtimeByBackend.get(record.backendNodeId) || runtimeBySelector.get(`${record.frameId}:${idSelector}`) ||
      runtimeByUrlSelector.get(`${record.base}:${idSelector}`) ||
      runtimeByUrlOrder.get(`${record.base}:${record.elementOrder}:${record.tagName}`) || null;
    const runtimeData = runtime ? copyRuntime(runtime, record.base) : {};
    const sensitive = sensitiveElement(record.tagName, record.attributes);
    const ax = axByBackend.get(record.backendNodeId);
    const selectorHint = runtimeData.selectorHint || (record.attributes.id && !SENSITIVE.test(record.attributes.id) ? `#${record.attributes.id}` : '');
    const node = {
      nodeId: record.id,
      parentId: effectiveParent && effectiveParent.nodeType !== 9 ? effectiveParent.id : null,
      children: [],
      tagName: record.tagName,
      attributes: record.attributes,
      backendNodeId: record.backendNodeId,
      frameId: record.frameId,
      framePath: framePaths.get(record) || [],
      selectorHint,
      text: descendantText(record),
      visibleText: sensitive ? '' : cleanText(runtimeData.visibleText ?? descendantText(record)),
      hidden: runtimeData.hidden === true || Object.hasOwn(record.attributes, 'hidden') || record.attributes['aria-hidden'] === 'true' ||
        (record.tagName === 'input' && cleanText(record.attributes.type).toLowerCase() === 'hidden') ||
        record.layout.styles?.display === 'none' || record.layout.styles?.visibility === 'hidden',
      ...record.layout,
      ...runtimeData
    };
    if (record.shadowRootType) node.shadowRootType = record.shadowRootType;
    if (ax) {
      const role = axString(ax.role);
      const name = axString(ax.name);
      const description = axString(ax.description);
      const value = sensitive ? '' : axString(ax.value);
      if (role) node.axRole = role;
      if (name) node.accessibleName = name;
      if (description) node.accessibleDescription = description;
      if (value) node.axValue = value;
    }
    outputByRecord.set(record, node);
    return node;
  });
  for (const record of ordered) {
    const node = outputByRecord.get(record);
    for (const child of childrenByRecord.get(record) || []) {
      const childNode = outputByRecord.get(child);
      if (childNode) node.children.push(childNode.nodeId);
    }
    if (Number.isInteger(record.childDocumentIndex)) {
      for (const root of rootsByDocument.get(record.childDocumentIndex) || []) {
        const candidates = root.nodeType === 9 ? childrenByRecord.get(root) || [] : [root];
        for (const child of candidates) {
          const childNode = outputByRecord.get(child);
          if (childNode) node.children.push(childNode.nodeId);
        }
      }
    }
  }

  const primary = documents[0] || {};
  const primaryRoot = (rootsByDocument.get(0) || []).find(record => record.nodeType === 9);
  const html = primaryRoot ? (childrenByRecord.get(primaryRoot) || []).find(record => record.tagName === 'html') : null;
  const document = {
    nodeId: 'document',
    title: cleanText(stringAt(strings, primary.title)),
    url: sanitizeResourceUrl(stringAt(strings, primary.documentURL)),
    language: cleanText(html?.attributes.lang || stringAt(strings, primary.contentLanguage)),
    layoutMetrics: raw.layoutMetrics && typeof raw.layoutMetrics === 'object' ? JSON.parse(JSON.stringify(raw.layoutMetrics)) : {},
    warnings: (Array.isArray(raw.warnings) ? raw.warnings : []).map(item => ({ code: cleanText(item?.code), frameId: item?.frameId ?? null, message: redactSensitiveText(cleanText(item?.message)) }))
  };
  return assertSnapshotV1({ schemaVersion: 1, document, nodes });
}

/** Normalizes a CDP DOMSnapshot/AX/runtime bundle into public SnapshotV1. */
export function normalizeSnapshot(raw) {
  if (!raw || typeof raw !== 'object') throw new TypeError('Dados brutos de DOMSnapshot são obrigatórios.');
  if (raw.format === 'simplified-v1') return normalizeSimplified(raw);
  return normalizeColumnar(raw);
}
