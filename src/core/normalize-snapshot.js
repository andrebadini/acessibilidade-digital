import { assertSnapshotV1 } from './snapshot-schema.js';
import { escapeCssIdentifier } from './evidence/selector.js';
import {
  backgroundImageKind,
  isPairedCredentialIdentity,
  redactCredentialLabelTail,
  redactNormalizedNode,
  sanitizeEvidenceUrl,
  sanitizeJsonData,
  sanitizeWarnings
} from './privacy.js';

const SENSITIVE = /(?:pass(?:word|wd)?|token|secret|auth(?:orization)?|session|cookie|csrf|xsrf|otp|one[-_ ]?time|api[-_ ]?key)/iu;
const URL_ATTRIBUTES = new Set(['action', 'cite', 'formaction', 'href', 'poster', 'src']);
// Media resources are fetched by the page, not navigated to by the reader, so their query string is
// never the address under test: it is cache-busting, a CDN signature or a parameter the page
// reflected from typed input. Measured in Chrome, `src="/foto.png?q=<CPF>"` reached the snapshot
// intact because the name-based filter only knows English credential vocabulary. Navigation
// attributes keep their query, because there the address is exactly what the audit evaluates.
const RESOURCE_ONLY_ATTRIBUTES = new Set(['src', 'poster']);
const RESOURCE_ONLY_TAGS = new Set(['img', 'image', 'video', 'audio', 'source', 'track', 'iframe', 'embed', 'object', 'input']);
const EXECUTABLE_TEXT_PARENTS = new Set(['script', 'style', 'template']);
const LINK_CONTEXT_STATES = new Set(['potential-context', 'missing-context', 'unknown-context']);
const NEW_WINDOW_BEHAVIORS = new Set(['new-window', 'same-window', 'unknown']);
const MAX_FRAME_ID_LENGTH = 256;
const MAX_FRAME_PATH_ITEMS = 64;

function cleanText(value) {
  return typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '';
}

function viewportDeclaration(content) {
  if (typeof content !== 'string' || content.length > 2048) return {};
  const output = {};
  const seen = new Set();
  for (const part of content.toLowerCase().split(/[,;]/u)) {
    const [name, value, extra] = part.split('=').map(value => value.trim());
    if (!['user-scalable', 'maximum-scale'].includes(name)) continue;
    if (seen.has(name) || extra !== undefined) return {};
    seen.add(name);
    if (name === 'user-scalable') {
      if (!['yes', 'no', '1', '0'].includes(value)) return {};
      output.userScalable = value === 'yes' || value === '1';
    } else {
      if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/u.test(value ?? '')) return {};
      const number = Number(value);
      if (!Number.isFinite(number) || number <= 0) return {};
      output.maximumScale = number;
    }
  }
  return output;
}

function ownData(value, key) {
  try {
    const descriptor = value !== null && typeof value === 'object'
      ? Object.getOwnPropertyDescriptor(value, key)
      : null;
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function primitiveFrameId(value, fallback = '') {
  if (typeof value === 'string' && value.length <= MAX_FRAME_ID_LENGTH) return cleanText(value);
  if (Number.isSafeInteger(value)) return String(value);
  return fallback;
}

function primitiveFramePath(value) {
  try {
    if (!Array.isArray(value)) return [];
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, 'value') ||
      !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0 ||
      lengthDescriptor.value > MAX_FRAME_PATH_ITEMS) return [];
    const output = new Array(lengthDescriptor.value);
    for (let index = 0; index < lengthDescriptor.value; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) return [];
      const frameId = primitiveFrameId(descriptor.value, null);
      if (typeof frameId !== 'string' || frameId === '') return [];
      output[index] = frameId;
    }
    return output;
  } catch {
    return [];
  }
}

const INVALID_WARNING_COLLECTION = Object.freeze({});

function normalizedWarnings(raw, internalWarnings = []) {
  let input;
  try {
    const descriptor = raw !== null && typeof raw === 'object'
      ? Object.getOwnPropertyDescriptor(raw, 'warnings')
      : null;
    input = !descriptor ? undefined
      : Object.hasOwn(descriptor, 'value') ? descriptor.value
        : INVALID_WARNING_COLLECTION;
  } catch {
    input = INVALID_WARNING_COLLECTION;
  }
  const external = sanitizeWarnings(input);
  const internal = sanitizeWarnings(internalWarnings);
  return external.concat(internal);
}

function normalizedWidgetSignals(raw) {
  const input = ownData(raw, 'widgetObservations');
  const coverage = ownData(input, 'coverage');
  const rawWidgets = ownData(input, 'widgets');
  let complete = ['complete', 'partial', 'unavailable'].includes(coverage);
  const widgets = {};
  for (const id of ['vlibras', 'hand-talk']) {
    const rawWidget = ownData(rawWidgets, id);
    widgets[id] = {};
    for (const field of ['dom', 'script', 'global']) {
      const value = ownData(rawWidget, field);
      if (typeof value === 'boolean') widgets[id][field] = value;
      else {
        widgets[id][field] = false;
        complete = false;
      }
    }
  }
  return {
    coverage: complete ? coverage : coverage === 'complete' ? 'partial' : 'unavailable',
    widgets,
  };
}

function placeholderMatch(value) {
  const normalized = cleanText(value).slice(0, 4096).normalize('NFKC').toLocaleLowerCase('pt-BR');
  return /(?:^|[^\p{L}])lorem\s+ipsum(?:[^\p{L}]|$)/u.test(normalized);
}

function redactPlaceholderText(node) {
  if (!node || node.hidden || editableElement(node.tagName, node.attributes) || EXECUTABLE_TEXT_PARENTS.has(node.tagName) ||
    (!placeholderMatch(node.text) && !placeholderMatch(node.visibleText))) return node;
  const output = { ...node, text: '', visibleText: '', placeholderTextCandidate: true };
  for (const field of ['accessibleName', 'accessibleDescription', 'axValue']) {
    if (placeholderMatch(output[field])) output[field] = '';
  }
  return output;
}

export function sanitizeResourceUrl(value, base) {
  return sanitizeEvidenceUrl(value, base);
}

// The shared sanitizer keeps non-sensitive query parameters, which is right for a navigation
// address and wrong for a fetched resource. This resolves and cleans the URL, then drops the query
// and the fragment, so the snapshot keeps the origin and the path that identify the file.
function stripUrlQuery(value, base) {
  const cleaned = sanitizeResourceUrl(value, base);
  if (cleaned === '' || /^(?:data|blob):/iu.test(cleaned)) return cleaned;
  try {
    const url = new URL(cleaned);
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return cleaned;
  }
}

function editableElement(tagName, attributes) {
  if (['input', 'select', 'textarea'].includes(tagName)) return true;
  const contenteditable = cleanText(attributes.contenteditable).toLowerCase();
  return Object.hasOwn(attributes, 'contenteditable') && !['false', 'inherit'].includes(contenteditable);
}

function identityAttributeText(value) {
  return Array.isArray(value) ? value.map(cleanText).filter(Boolean).join(' ') : cleanText(value);
}
// O RÓTULO NO IDENTIFICADOR DO PRÓPRIO ELEMENTO (`<div id="senhaassinatura">borboleta</div>`,
// `<div class="chavepix" title="girassol">`): o texto e os atributos desse elemento SÃO o valor, e nem o
// sinal de conteúdo do trecho nem o campo `value` do controle editável olham para eles. A revisão da
// 1.1.40 mediu o valor chegando ao modelo e ao JSON por esse caminho (Important I-1). A decisão é a
// mesma do trecho entregue: identificador de credencial torna o elemento raiz de texto privado.
// Elementos cujo texto é NOME acessível, não o valor do campo (mesma decisão do trecho entregue).
const LABEL_BEARING_TAGS = new Set(['a', 'area', 'button', 'input', 'label', 'legend', 'option',
  'select', 'summary', 'textarea']);
function credentialIdentityAttributes(tagName, attributes) {
  if (LABEL_BEARING_TAGS.has(tagName) || !attributes || typeof attributes !== 'object') return false;
  for (const name of ['id', 'class']) {
    const value = identityAttributeText(attributes[name]);
    if (value === '') continue;
    if (name === 'class') {
      if (value.split(/\s+/u).some(token => token.length > 0 && isPairedCredentialIdentity(token))) return true;
      continue;
    }
    if (isPairedCredentialIdentity(value)) return true;
  }
  return false;
}
function privateTextElement(tagName, attributes) {
  // Identificador de credencial é declaração da página: o conteúdo do elemento é tratado como VALOR,
  // sempre. A 1.1.43 tentou condicionar isso à forma do texto e a revisão mediu 198.360 de 198.360 formas
  // reabertas com valor longo, pontuado ou acima de 64 caracteres (e dois desvios estruturais: pilha por
  // nome de tag e profundidade 8). O preço do outro lado — texto de elemento com id ambíguo que vira
  // tarja — é medido e declarado.
  return tagName === 'textarea' || (editableElement(tagName, attributes) && !['input', 'select'].includes(tagName)) ||
    credentialIdentityAttributes(tagName, attributes);
}

function markPrivateReferenceConsumers(nodes, privateReferenceIds) {
  if (privateReferenceIds.size === 0) return;
  for (const node of nodes) {
    let contaminated = false;
    for (const attribute of ['aria-labelledby', 'aria-describedby']) {
      const references = cleanText(node.attributes?.[attribute]).split(' ').filter(Boolean);
      if (!references.some(reference => privateReferenceIds.has(reference))) continue;
      delete node.attributes[attribute];
      contaminated = true;
    }
    if (!contaminated) continue;
    delete node.accessibleName;
    delete node.accessibleDescription;
    node.privacyReferenceStatus = 'omitted-privacy';
  }
}

function ancestorsOfMatching(items, matches, parentOf) {
  const ancestors = new Set();
  for (const item of items) {
    if (!matches(item)) continue;
    const visited = new Set();
    let current = parentOf(item);
    while (current && !visited.has(current)) {
      visited.add(current);
      ancestors.add(current);
      current = parentOf(current);
    }
  }
  return ancestors;
}

function sanitizeAttributes(input, tagName, base) {
  const output = {};
  const normalizedInput = Object.fromEntries(Object.entries(input || {}).map(([name, value]) => [String(name).toLowerCase(), value]));
  for (const [name, rawValue] of Object.entries(normalizedInput)) {
    if (tagName === 'meta' && cleanText(normalizedInput.name).toLowerCase() === 'viewport' && name === 'content') continue;
    if (/^on/iu.test(name) || name === 'srcdoc' || name === 'style') continue;
    if (editableElement(tagName, normalizedInput) && ['value', 'aria-valuenow', 'aria-valuetext'].includes(name)) continue;
    if (tagName === 'option' && name === 'value') continue;
    if (tagName === 'option' && (name === 'selected' || name === 'aria-selected')) continue;
    let value = typeof rawValue === 'string' ? rawValue : rawValue === true ? '' : String(rawValue ?? '');
    if (RESOURCE_ONLY_ATTRIBUTES.has(name) && RESOURCE_ONLY_TAGS.has(tagName)) value = stripUrlQuery(value, base);
    else if (URL_ATTRIBUTES.has(name)) value = sanitizeResourceUrl(value, base);
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

// O nome acessível e a descrição nascem de atributos do autor (`placeholder`, `alt`, `title`,
// `aria-label`) e são entregues no relatório como nome e prévia de anúncio. O sanitizador de trecho
// descarta o ATRIBUTO que menciona credencial, mas o texto já calculado pelo navegador seguia inteiro:
// `placeholder="senha abc"` chegava como nome acessível `senha abc` (I1 da revisão da 1.1.28). Aqui a
// mesma decisão é aplicada ao TEXTO — palavra de credencial COM conteúdo depois é tarjada, e o rótulo
// puro (`Senha`, `Digite sua senha`) continua sendo evidência.
function projectAccessibleText(value) {
  return redactCredentialLabelTail(value);
}

function hasAxString(value) {
  if (typeof value === 'string') return true;
  return Boolean(value && typeof value === 'object' &&
    (typeof value.value === 'string' || typeof value.value === 'number' || typeof value.value === 'boolean'));
}

/**
 * O nome acessível de um nó de TEXTO PRIVADO (`div[role=textbox][contenteditable]`, `textarea`) pode ser
 * preservado na redação? Só quando ele é VAZIO. Nome vazio não carrega informação — e é a vaziez que
 * permite à regra apontar o defeito real de 5.13.10 (componente sem nome) em vez de ficar em "não
 * coletado". Nome NÃO vazio continua retirado por POLÍTICA, e a política está medida: a árvore de
 * acessibilidade do Chrome reporta as MESMAS fontes para um contenteditable com e sem texto digitado
 * (`relatedElement`/`aria-labelledby`, sem nenhuma fonte `contents`), então nada na medição prova que o
 * nome não venha do conteúdo — e o conteúdo é o que a pessoa digitou. O teste E2E do 5.9.1 fixa essa
 * fronteira ("a name that may come from contents must stay redacted").
 */
function preservableAccessibleName(node) {
  return node.accessibleName === '';
}

const TEXT_BLOCK_TAGS = new Set(['article', 'aside', 'blockquote', 'dd', 'div', 'dt', 'figcaption', 'li', 'main', 'p', 'section', 'td', 'th']);
const BLOCK_TEXT_DISPLAYS = new Set(['block', 'flow-root', 'flex', 'grid', 'list-item', 'table']);

function cssPixels(value) {
  const match = typeof value === 'string' && value.trim().match(/^(-?(?:\d+|\d*\.\d+))px$/u);
  return match && Number.isFinite(Number(match[1])) ? Number(match[1]) : null;
}

function deriveRuleObservations(node) {
  const styles = node.styles && typeof node.styles === 'object' ? node.styles : {};
  const display = cleanText(styles.display).toLowerCase();
  const text = cleanText(node.visibleText || node.text);
  if (text && (node.hasRenderedBox === true || (node.hasRenderedBox !== false && !node.hidden)) && !node.tagName.startsWith('#') && (TEXT_BLOCK_TAGS.has(node.tagName) || BLOCK_TEXT_DISPLAYS.has(display))) {
    node.textBlock = true;
    const textAlign = cleanText(styles['text-align'] || styles.textAlign);
    if (textAlign) node.textAlign = textAlign;
  }
  const foreground = cleanText(styles.color);
  const background = cleanText(styles['background-color'] || styles.backgroundColor);
  const fontSizePx = cssPixels(styles['font-size'] || styles.fontSize);
  const fontWeight = cleanText(styles['font-weight'] || styles.fontWeight);
  const fullyOpaque = Number(cleanText(styles.opacity)) === 1;
  if (text && foreground && background && fontSizePx !== null && fontWeight && typeof node.backgroundImageKind === 'string') {
    node.contrast = {
      foreground,
      background,
      backgroundImage: node.backgroundImageKind,
      ...(cleanText(styles['font-family'] || styles.fontFamily) ? { fontFamily: cleanText(styles['font-family'] || styles.fontFamily) } : {}),
      fontSizePx,
      fontWeight,
      reliable: node.contrastReliable === true && fullyOpaque
    };
  }
  const media = node.media;
  if (!media || typeof media !== 'object' || Array.isArray(media) || !['audio', 'video'].includes(node.tagName)) return;
  for (const field of ['durationSeconds', 'muted', 'autoplay', 'hasAudio', 'mediaTiming']) {
    if (Object.hasOwn(media, field)) node[field] = media[field];
  }
  if (Array.isArray(media.captionTracks)) node.captionTracks = media.captionTracks.map(track => ({ ...track }));
  if (media.controls === true) {
    node.audioControl = {
      canPause: media.controls,
      canStop: false,
      independentVolume: media.controls
    };
  }
}

function observedAxHeadingLevel(ax) {
  if (!Array.isArray(ax?.properties)) return undefined;
  const value = ax.properties.find(property => property?.name === 'level')?.value?.value;
  return Number.isSafeInteger(value) ? value : undefined;
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
  const charactersPerLine = ownData(record, 'charactersPerLine');
  if (Number.isSafeInteger(charactersPerLine) && charactersPerLine > 0 && charactersPerLine <= 2048) {
    result.charactersPerLine = charactersPerLine;
  }
  if (typeof record?.hasRenderedBox === 'boolean') result.hasRenderedBox = record.hasRenderedBox;
  for (const key of ['visibleText', 'focusable', 'interaction', 'interactive', 'required', 'requiredIndicator', 'checked', 'disabled', 'active', 'hidden', 'shadowHost', 'shadowRootMode', 'contrastReliable']) {
    if (typeof record?.[key] === 'string' || typeof record?.[key] === 'boolean' || record?.[key] === null) result[key] = record[key];
  }
  if (typeof record?.selectorHint === 'string' && !SENSITIVE.test(record.selectorHint)) result.selectorHint = record.selectorHint;
  const viewportRect = copyRect(record?.viewportRect);
  const documentRect = copyRect(record?.documentRect);
  if (viewportRect) result.viewportRect = viewportRect;
  if (documentRect) result.documentRect = documentRect;
  const targetSizeRect = copyRect(record?.targetSizeRect);
  if (targetSizeRect) result.targetSizeRect = targetSizeRect;
  if (record?.styles && typeof record.styles === 'object' && !Array.isArray(record.styles)) {
    result.styles = {};
    for (const [name, value] of Object.entries(record.styles)) {
      if (typeof value !== 'string') continue;
      if (name === 'background-image' || name === 'backgroundImage') result.backgroundImageKind = backgroundImageKind(value);
      else result.styles[name] = value;
    }
  }
  if (record?.form && typeof record.form === 'object' && !Array.isArray(record.form)) {
    result.form = Object.fromEntries(Object.entries(record.form).filter(([, value]) => ['string', 'boolean', 'number'].includes(typeof value)));
  }
  if (record?.media && typeof record.media === 'object' && !Array.isArray(record.media)) {
    result.media = {};
    for (const [key, value] of Object.entries(record.media)) {
      if (key === 'currentSrc' || key === 'src') result.media[key] = sanitizeResourceUrl(value, base);
      else if (key === 'captionTracks' && Array.isArray(value)) {
        result.media.captionTracks = value.map(track => ({
          ...(typeof track?.kind === 'string' ? { kind: cleanText(track.kind) } : {}),
          ...(typeof track?.srclang === 'string' ? { srclang: cleanText(track.srclang) } : {})
        }));
      }
      else if (['string', 'boolean', 'number'].includes(typeof value) || value === null) result.media[key] = value;
    }
  }
  if (Array.isArray(record?.animations)) {
    result.animations = record.animations.map(item => ({
      playState: typeof item?.playState === 'string' ? item.playState : '',
      currentTime: Number.isFinite(item?.currentTime) ? item.currentTime : null
    }));
  }
  const linkPurposeContext = ownData(record, 'linkPurposeContext');
  if (LINK_CONTEXT_STATES.has(linkPurposeContext)) result.linkPurposeContext = linkPurposeContext;
  const adjacentNewWindowWarning = ownData(record, 'adjacentNewWindowWarning');
  if (typeof adjacentNewWindowWarning === 'boolean') result.adjacentNewWindowWarning = adjacentNewWindowWarning;
  const newWindowBehavior = ownData(record, 'newWindowBehavior');
  if (NEW_WINDOW_BEHAVIORS.has(newWindowBehavior)) result.newWindowBehavior = newWindowBehavior;
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
    const editable = editableElement(tagName, attributes);
    const runtimeData = copyRuntime(node, base);
    const normalized = {
      nodeId: idByBackend.get(node.backendNodeId) || `n-fixture-${index + 1}`,
      parentId: node.parentBackendNodeId == null ? null : idByBackend.get(node.parentBackendNodeId) || null,
      children: [],
      tagName,
      attributes,
      backendNodeId: Number.isFinite(node.backendNodeId) ? node.backendNodeId : null,
      frameId: primitiveFrameId(ownData(node, 'frameId'), 'main'),
      framePath: primitiveFramePath(ownData(node, 'framePath')),
      selectorHint: typeof node.selectorHint === 'string' && !SENSITIVE.test(node.selectorHint) ? node.selectorHint : '',
      text: editable || EXECUTABLE_TEXT_PARENTS.has(tagName) ? '' : cleanText(node.text),
      visibleText: editable ? '' : cleanText(node.visibleText ?? node.text),
      hidden: node.hidden === true || (tagName === 'input' && cleanText(attributes.type).toLowerCase() === 'hidden'),
      ...(copyRect(node.rect) ? { rect: copyRect(node.rect) } : {}),
      ...runtimeData
    };
    const ax = axByBackend.get(node.backendNodeId);
    if (ax) {
      const role = axString(ax.role);
      const name = axString(ax.name);
      const description = axString(ax.description);
      const value = editable ? '' : axString(ax.value);
      if (role) normalized.axRole = role;
      if (role === 'heading' && observedAxHeadingLevel(ax) !== undefined) normalized.headingLevel = observedAxHeadingLevel(ax);
      if (hasAxString(ax.name)) normalized.accessibleName = projectAccessibleText(name);
      if (description) normalized.accessibleDescription = projectAccessibleText(description);
      if (value) normalized.axValue = projectAccessibleText(value);
    }
    deriveRuleObservations(normalized);
    return normalized;
  });
  const byId = new Map(nodes.map(node => [node.nodeId, node]));
  for (const node of nodes) if (node.parentId && byId.has(node.parentId)) byId.get(node.parentId).children.push(node.nodeId);
  const executableById = new Map(nodes.map(node => [node.nodeId, EXECUTABLE_TEXT_PARENTS.has(node.tagName)]));
  const privateTextById = new Map(nodes.map(node => [node.nodeId, privateTextElement(node.tagName, node.attributes)]));
  const parentOfNode = node => node.parentId ? byId.get(node.parentId) : null;
  const privateTextAncestors = ancestorsOfMatching(nodes, node => privateTextById.get(node.nodeId), parentOfNode);
  const inExecutableSubtree = node => {
    const visited = new Set();
    let current = node;
    while (current && !visited.has(current.nodeId)) {
      visited.add(current.nodeId);
      if (executableById.get(current.nodeId)) return true;
      current = current.parentId ? byId.get(current.parentId) : null;
    }
    return false;
  };
  const inPrivateTextSubtree = node => {
    const visited = new Set();
    let current = node;
    while (current && !visited.has(current.nodeId)) {
      visited.add(current.nodeId);
      if (privateTextById.get(current.nodeId)) return true;
      current = current.parentId ? byId.get(current.parentId) : null;
    }
    return false;
  };
  const hasPrivateTextAncestor = node => {
    const visited = new Set();
    let current = node.parentId ? byId.get(node.parentId) : null;
    while (current && !visited.has(current.nodeId)) {
      visited.add(current.nodeId);
      if (privateTextById.get(current.nodeId)) return true;
      current = current.parentId ? byId.get(current.parentId) : null;
    }
    return false;
  };
  const privateReferenceIds = new Set(nodes
    .filter(inPrivateTextSubtree)
    .map(node => cleanText(node.attributes?.id))
    .filter(Boolean));
  markPrivateReferenceConsumers(nodes, privateReferenceIds);
  const redactedNodes = nodes.map(node => redactPlaceholderText(redactNormalizedNode(node, {
    executable: inExecutableSubtree(node),
    privateText: inPrivateTextSubtree(node),
    privateTextRoot: privateTextById.get(node.nodeId) && !hasPrivateTextAncestor(node),
    privateTextDescendant: hasPrivateTextAncestor(node),
    privateTextAncestor: privateTextAncestors.has(node),
    preserveAccessibleText: ['input', 'select', 'textarea'].includes(node.tagName) ||
      preservableAccessibleName(node),
  })));
  return assertSnapshotV1({
    schemaVersion: 1,
    document: {
      nodeId: 'document',
      title: cleanText(raw.document?.title),
      url: sanitizeResourceUrl(raw.document?.url || ''),
      language: cleanText(raw.document?.language),
      warnings: normalizedWarnings(raw),
      accessibilityWidgetSignals: normalizedWidgetSignals(raw),
      ...(raw.coverage && typeof raw.coverage === 'object' ? { coverage: sanitizeJsonData(raw.coverage) } : {})
    },
    nodes: redactedNodes
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
    const rawFrameId = ownData(document, 'frameId');
    const frameId = primitiveFrameId(
      stringAt(strings, rawFrameId) || rawFrameId,
      documentIndex === 0 ? 'main' : `frame-${documentIndex}`,
    );
    const base = sanitizeResourceUrl(stringAt(strings, document.documentURL)) || 'https://invalid.local/';
    const layoutByNode = new Map();
    let elementOrder = 0;
    if (document.layout && Array.isArray(document.layout.nodeIndex)) {
      document.layout.nodeIndex.forEach((nodeIndex, layoutIndex) => {
        const rect = copyRect(document.layout.bounds?.[layoutIndex]);
        const styles = {};
        let layoutBackgroundImageKind;
        const styleRow = document.layout.styles?.[layoutIndex];
        if (Array.isArray(styleRow)) styleNames.forEach((name, index) => {
          const value = stringAt(strings, styleRow[index]);
          if (value === '') return;
          if (name === 'background-image') layoutBackgroundImageKind = backgroundImageKind(value);
          else styles[name] = value;
        });
        layoutByNode.set(nodeIndex, {
          ...(rect ? { rect } : {}),
          ...(Object.keys(styles).length ? { styles } : {}),
          ...(layoutBackgroundImageKind ? { backgroundImageKind: layoutBackgroundImageKind } : {})
        });
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
        ...(tagName === 'meta' && cleanText(rawAttributes.name).toLowerCase() === 'viewport'
          ? { viewportDeclaration: viewportDeclaration(rawAttributes.content) } : {}),
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
  // Mirror the runtime collector's structural selector, not its ordinal: Chrome
  // includes user-agent shadow DOM in DOMSnapshot but not in document.children.
  // Posição :nth-of-type calculada uma vez por pai (antes era quadrática em contêineres com milhares de
  // filhos — vitrines; bateria de páginas hostis, 1.1.53). Mesmo seletor de antes.
  const typePositions = new Map();
  const typePosition = (parent, child) => {
    let entry = typePositions.get(parent);
    if (!entry) {
      const index = new Map();
      const totals = new Map();
      for (const item of childrenByRecord.get(parent)) {
        if (item.nodeType !== 1) continue;
        const position = (totals.get(item.tagName) ?? 0) + 1;
        totals.set(item.tagName, position);
        index.set(item, position);
      }
      entry = { index, totals };
      typePositions.set(parent, entry);
    }
    return { position: entry.index.get(child) ?? 0, total: entry.totals.get(child.tagName) ?? 0 };
  };
  const runtimeSelector = record => {
    if (record.nodeType !== 1) return '';
    if (record.attributes.id && !SENSITIVE.test(record.attributes.id)) return `#${escapeCssIdentifier(record.attributes.id)}`;
    const parts = [];
    let current = record;
    while (current?.nodeType === 1 && parts.length < 12) {
      let part = current.tagName;
      const parent = byDocumentAndIndex.get(`${current.documentIndex}:${current.parentIndex}`);
      if (parent?.nodeType === 1) {
        const { position, total } = typePosition(parent, current);
        if (total > 1) part += `:nth-of-type(${position})`;
      }
      parts.unshift(part);
      let root = parent;
      while (root && root.nodeType !== 9 && !root.shadowRootType) {
        root = byDocumentAndIndex.get(`${root.documentIndex}:${root.parentIndex}`);
      }
      if (root?.shadowRootType) {
        if (root.shadowRootType !== 'open') return '';
        parts.unshift('::shadow');
        current = byDocumentAndIndex.get(`${root.documentIndex}:${root.parentIndex}`);
      } else current = parent;
    }
    return parts.join(' > ');
  };
  const selectors = new Map(records.map(record => [record, runtimeSelector(record)]));
  const addMulti = (map, key, value) => {
    if (key === '' || key === null || key === undefined) return;
    const values = map.get(key) || [];
    values.push(value);
    map.set(key, values);
  };
  const runtimeByBackend = new Map();
  const runtimeBySelector = new Map();
  const runtimeByUrlSelector = new Map();
  for (const entry of Array.isArray(raw.pageData) ? raw.pageData : []) {
    const result = ownData(entry, 'result');
    const data = result && typeof result === 'object' ? result : entry;
    const entryFrameId = ownData(entry, 'frameId');
    const frameId = primitiveFrameId(entryFrameId ?? ownData(data, 'frameId'));
    const runtimeUrl = sanitizeResourceUrl(data?.url || '');
    for (const node of Array.isArray(data?.nodes) ? data.nodes : []) {
      if (Number.isFinite(node.backendNodeId)) addMulti(runtimeByBackend, node.backendNodeId, node);
      if (typeof node.selectorHint === 'string') {
        addMulti(runtimeBySelector, `${frameId}:${node.selectorHint}`, node);
        if (runtimeUrl) addMulti(runtimeByUrlSelector, `${runtimeUrl}:${node.selectorHint}`, node);
      }
    }
  }

  const recordsByBackend = new Map();
  const recordsBySelector = new Map();
  const recordsByUrlSelector = new Map();
  for (const record of records) {
    if (Number.isFinite(record.backendNodeId)) addMulti(recordsByBackend, record.backendNodeId, record);
    const idSelector = selectors.get(record);
    if (idSelector) {
      addMulti(recordsBySelector, `${record.frameId}:${idSelector}`, record);
      addMulti(recordsByUrlSelector, `${record.base}:${idSelector}`, record);
    }
  }
  let ambiguousRuntimeMatch = false;
  const uniqueMatch = (runtimeMap, recordMap, key) => {
    if (!key) return null;
    const runtimeCandidates = runtimeMap.get(key) || [];
    const recordCandidates = recordMap.get(key) || [];
    if (runtimeCandidates.length === 1 && recordCandidates.length === 1) return runtimeCandidates[0];
    if (runtimeCandidates.length > 0 && recordCandidates.length > 0 && (runtimeCandidates.length !== 1 || recordCandidates.length !== 1)) {
      ambiguousRuntimeMatch = true;
    }
    return null;
  };

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
  const executableMemo = new Map();
  const privateTextMemo = new Map();
  const parentOfRecord = record => byDocumentAndIndex.get(`${record.documentIndex}:${record.parentIndex}`);
  const privateTextAncestors = ancestorsOfMatching(
    records,
    record => privateTextElement(record.tagName, record.attributes),
    parentOfRecord,
  );
  const inExecutableSubtree = record => {
    if (executableMemo.has(record)) return executableMemo.get(record);
    let current = record;
    const visited = new Set();
    while (current && !visited.has(current)) {
      visited.add(current);
      if (EXECUTABLE_TEXT_PARENTS.has(current.tagName)) {
        executableMemo.set(record, true);
        return true;
      }
      current = byDocumentAndIndex.get(`${current.documentIndex}:${current.parentIndex}`);
    }
    executableMemo.set(record, false);
    return false;
  };
  const inPrivateTextSubtree = record => {
    if (privateTextMemo.has(record)) return privateTextMemo.get(record);
    let current = record;
    const visited = new Set();
    while (current && !visited.has(current)) {
      visited.add(current);
      if (privateTextElement(current.tagName, current.attributes)) {
        privateTextMemo.set(record, true);
        return true;
      }
      current = byDocumentAndIndex.get(`${current.documentIndex}:${current.parentIndex}`);
    }
    privateTextMemo.set(record, false);
    return false;
  };
  const hasPrivateTextAncestor = record => {
    let current = byDocumentAndIndex.get(`${record.documentIndex}:${record.parentIndex}`);
    const visited = new Set();
    while (current && !visited.has(current)) {
      visited.add(current);
      if (privateTextElement(current.tagName, current.attributes)) return true;
      current = byDocumentAndIndex.get(`${current.documentIndex}:${current.parentIndex}`);
    }
    return false;
  };
  const descendantText = (record) => {
    if (inExecutableSubtree(record) || inPrivateTextSubtree(record)) return '';
    const parts = [record.rawText];
    for (const child of childrenByRecord.get(record) || []) parts.push(descendantText(child));
    return cleanText(parts.join(' '));
  };
  const shadowScope = record => {
    let current = record;
    const visited = new Set();
    while (current && !visited.has(current)) {
      visited.add(current);
      if (current.shadowRootType) {
        const host = byDocumentAndIndex.get(`${current.documentIndex}:${current.parentIndex}`) || null;
        return { root: current, host };
      }
      current = byDocumentAndIndex.get(`${current.documentIndex}:${current.parentIndex}`);
    }
    return null;
  };
  const shadowRootByHost = new Map();
  for (const record of records) {
    if (!record.shadowRootType) continue;
    const host = byDocumentAndIndex.get(`${record.documentIndex}:${record.parentIndex}`);
    if (host && !shadowRootByHost.has(host)) shadowRootByHost.set(host, record);
  }
  const nodes = ordered.map(record => {
    const host = documentHost.get(record.documentIndex);
    const parent = byDocumentAndIndex.get(`${record.documentIndex}:${record.parentIndex}`);
    const effectiveParent = parent?.nodeType === 9 ? host || null : parent || host || null;
    const idSelector = selectors.get(record);
    const runtime = uniqueMatch(runtimeByBackend, recordsByBackend, record.backendNodeId) ||
      uniqueMatch(runtimeBySelector, recordsBySelector, idSelector ? `${record.frameId}:${idSelector}` : '') ||
      uniqueMatch(runtimeByUrlSelector, recordsByUrlSelector, idSelector ? `${record.base}:${idSelector}` : '') || null;
    const runtimeData = runtime ? copyRuntime(runtime, record.base) : {};
    const editable = editableElement(record.tagName, record.attributes);
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
      visibleText: editable ? '' : cleanText(runtimeData.visibleText ?? descendantText(record)),
      hidden: runtimeData.hidden === true || Object.hasOwn(record.attributes, 'hidden') || record.attributes['aria-hidden'] === 'true' ||
        (record.tagName === 'input' && cleanText(record.attributes.type).toLowerCase() === 'hidden') ||
        record.layout.styles?.display === 'none' || record.layout.styles?.visibility === 'hidden',
      ...record.layout,
      ...(!record.layout.rect && runtimeData.documentRect ? { rect: runtimeData.documentRect } : {}),
      ...runtimeData
    };
    // Ignored generic containers remain relevant. Only explicit exclusion reasons
    // prove invisibility, including descendants absent from the AX tree.
    let ancestor = record;
    while (ancestor) {
      const ancestorAx = axByBackend.get(ancestor.backendNodeId);
      if (ancestor.attributes['aria-hidden'] === 'true' || Object.hasOwn(ancestor.attributes, 'hidden') ||
          (ancestorAx?.ignored === true && ancestorAx.ignoredReasons?.some(reason =>
            ['notRendered', 'ariaHiddenElement', 'ariaHiddenSubtree'].includes(reason.name)))) {
        node.hidden = true;
        break;
      }
      ancestor = parentOfRecord(ancestor);
    }
    const scope = shadowScope(record);
    if (scope) {
      node.shadowRootId = scope.root.id;
      node.shadowHostId = scope.host?.id ?? null;
      node.shadowPath = scope.host ? [scope.host.id] : [];
    }
    const hostedRoot = shadowRootByHost.get(record);
    if (hostedRoot) {
      node.isShadowHost = true;
      node.hostedShadowRootId = hostedRoot.id;
      if (!scope) node.shadowRootId = hostedRoot.id;
    }
    if (record.shadowRootType) node.shadowRootType = record.shadowRootType;
    if (ax) {
      const role = axString(ax.role);
      const name = axString(ax.name);
      const description = axString(ax.description);
      const value = editable ? '' : axString(ax.value);
      if (role) node.axRole = role;
      if (role === 'heading' && observedAxHeadingLevel(ax) !== undefined) node.headingLevel = observedAxHeadingLevel(ax);
      if (hasAxString(ax.name)) node.accessibleName = projectAccessibleText(name);
      if (description) node.accessibleDescription = projectAccessibleText(description);
      if (value) node.axValue = projectAccessibleText(value);
    }
    deriveRuleObservations(node);
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

  const privateReferenceIds = new Set(ordered
    .filter(inPrivateTextSubtree)
    .map(record => cleanText(record.attributes?.id))
    .filter(Boolean));
  markPrivateReferenceConsumers(nodes, privateReferenceIds);

  const redactedNodes = ordered.map(record => redactPlaceholderText(redactNormalizedNode(outputByRecord.get(record), {
    executable: inExecutableSubtree(record),
    privateText: inPrivateTextSubtree(record),
    privateTextRoot: privateTextElement(record.tagName, record.attributes) && !hasPrivateTextAncestor(record),
    privateTextDescendant: hasPrivateTextAncestor(record),
    privateTextAncestor: privateTextAncestors.has(record),
    // O controle nativo mantém o nome; o nó de texto privado só mantém o nome VAZIO (ver
    // `preservableAccessibleName`), o que dá à regra de 5.13.10 a vaziez observada sem entregar conteúdo.
    preserveAccessibleText: ['input', 'select', 'textarea'].includes(record.tagName) ||
      preservableAccessibleName(outputByRecord.get(record) ?? {}),
  })));

  // A container's aggregate text must not be measured again using its own colors.
  // Derive only a finite provenance flag, after removing private/executable text.
  const redactedById = new Map(redactedNodes.map(node => [node.nodeId, node]));
  for (const node of redactedNodes) {
    node.textContrastScope = node.tagName !== '#text' && node.children.some(id => {
      const child = redactedById.get(id);
      return child?.tagName === '#text' && (!child.hidden || node.hasRenderedBox === true) && cleanText(child.text);
    }) ? 'direct' : 'aggregate';
  }

  const primary = documents[0] || {};
  const primaryRoot = (rootsByDocument.get(0) || []).find(record => record.nodeType === 9);
  const html = primaryRoot ? (childrenByRecord.get(primaryRoot) || []).find(record => record.nodeType === 1 && record.tagName === 'html') : null;
  const viewportRecords = records.filter(record => {
    if (record.documentIndex !== 0 || !Object.hasOwn(record, 'viewportDeclaration')) return false;
    let current = record;
    const visited = new Set();
    while (current && !visited.has(current)) {
      visited.add(current);
      if (current.shadowRootType || EXECUTABLE_TEXT_PARENTS.has(current.tagName)) return false;
      if (current === html) return true;
      current = parentOfRecord(current);
    }
    return false;
  });
  const document = {
    nodeId: 'document',
    title: cleanText(stringAt(strings, primary.title)),
    url: sanitizeResourceUrl(stringAt(strings, primary.documentURL)),
    language: cleanText(html?.attributes.lang || stringAt(strings, primary.contentLanguage)),
    layoutMetrics: raw.layoutMetrics && typeof raw.layoutMetrics === 'object' ? JSON.parse(JSON.stringify(raw.layoutMetrics)) : {},
    warnings: normalizedWarnings(raw, ambiguousRuntimeMatch ? [{ code: 'RUNTIME_MATCH_AMBIGUOUS' }] : []),
    accessibilityWidgetSignals: normalizedWidgetSignals(raw),
    ...(html ? { metaViewport: viewportRecords.length === 0 ? null
      : viewportRecords.length === 1 ? viewportRecords[0].viewportDeclaration : {} } : {}),
    ...(raw.coverage && typeof raw.coverage === 'object' ? { coverage: sanitizeJsonData(raw.coverage) } : {})
  };
  return assertSnapshotV1({ schemaVersion: 1, document, nodes: redactedNodes });
}

/** Normalizes a CDP DOMSnapshot/AX/runtime bundle into public SnapshotV1. */
export function normalizeSnapshot(raw) {
  if (!raw || typeof raw !== 'object') throw new TypeError('Dados brutos de DOMSnapshot são obrigatórios.');
  if (raw.format === 'simplified-v1') return normalizeSimplified(raw);
  return normalizeColumnar(raw);
}
