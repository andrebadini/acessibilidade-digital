import { canonicalStringify } from '../core/report/canonical-json.js';

const MAX_SELECTOR_BYTES = 2_048;
const MAX_SELECTOR_SEGMENTS = 16;
const MAX_SELECTOR_COMPLEXITY = 64;
const MAX_TOKEN_LENGTH = 23;
const MAX_RAW_CLASS_CODE_UNITS = 2_048;
const MAX_RAW_ID_CODE_UNITS = 2_048;
const MAX_RAW_ROLE_CODE_UNITS = 512;
const MAX_RAW_TYPE_CODE_UNITS = 128;
const MAX_CHILDREN_PER_PARENT = 10_000;

const TAG_PATTERN = /^[a-z][a-z0-9-]{0,62}$/u;
const DOCUMENT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,240}$/u;
const SAFE_TOKEN_PATTERN = /^-?[_A-Za-z][_A-Za-z0-9-]*$/u;
const SENSITIVE_TOKEN_PATTERN = /(?:pass(?:word|wd)?|token|secret|auth(?:orization)?|session|cookie|csrf|xsrf|otp|one[-_]?time|api[-_]?key)/iu;
const URL_LIKE_PATTERN = /@|:\/\/|www\./iu;
const UUID_PATTERN = /[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/iu;
const FOUR_DECIMALS_PATTERN = /[0-9]{4}/u;
const EIGHT_HEX_PATTERN = /[0-9a-f]{8}/iu;
const RAW_SELECTOR_TOKEN_PATTERN = /[#.]([^#.\[\]:()>\t\n\f\r ,\\*]+)/gu;
const SEGMENT_PATTERN = /^([a-z][a-z0-9-]{0,62})(?:#(-?[_A-Za-z][_A-Za-z0-9-]*))?((?:\.-?[_A-Za-z][_A-Za-z0-9-]*){0,2})(?:\[(role|type)="([a-z]+)"\])?(?::nth-of-type\(([1-9][0-9]*)\))?$/u;
// Mesma forma, com o vocabulário semântico dos sinais no lugar das enumerações de role/type.
const SEMANTIC_SEGMENT_PATTERN = new RegExp(
  '^([a-z][a-z0-9-]{0,62})'
  + '(?:#(-?[_A-Za-z][_A-Za-z0-9-]*))?'
  + '((?:\\.-?[_A-Za-z][_A-Za-z0-9-]*){0,2})'
  + '(?:\\[([a-z][a-z0-9-]{0,31})="((?:[^"\\\\]|\\\\.)*)"\\])?'
  + '(?::nth-of-type\\(([1-9][0-9]*)\\))?$', 'u');
const CLASS_PATTERN = /\.(-?[_A-Za-z][_A-Za-z0-9-]*)/gu;

// ---------------------------------------------------------------------------------------------
// Gramática dos SINAIS na página (page markers)
// ---------------------------------------------------------------------------------------------
//
// O seletor dos sinais é produzido por `buildStableSelector` e só pode assumir três formas:
//   `tag#id`, `tag[atributo-semântico="valor"]` e o caminho estrutural `tag > tag:nth-of-type(n)`.
// Ele é revalidado dentro da própria página, então o vocabulário continua FECHADO — o que muda
// em relação a `parseCssSelectorV1` é o que hoje impede marcação legítima:
//
//   · o caminho estrutural pode ter até 64 segmentos (antes 16), com complexidade proporcional;
//   · ids/classes com 4 dígitos ou 8 hexadecimais são aceitos (o dado já está no DOM da própria
//     página e não sai dela), mantendo a recusa de nomes com cara de credencial;
//   · atributos semânticos além de role/type (name, alt, title, aria-label, data-testid) são
//     aceitos com valor até 256 caracteres.
//
// Nenhum destes afrouxamentos vale para o relatório/exportação: `parseCssSelectorV1` continua
// sendo a gramática estrita usada pelo modelo e pela captura.
// The individual highlight walks the same ancestry the page walks. It is deeper than the strict
// 16-segment export grammar because a page that nests controls 20 levels down still deserves a
// highlight, and the ancestry depth never leaves the page: it only feeds the SHA-256 structural
// signature that the page and the worker compute independently.
//
// O destaque individual também usa a gramática ampliada (`parseHighlightSelectorV1`), e por isso
// aceita os mesmos `tag[atributo-semântico="valor"]` que os sinais aceitam: sem isso, um `<input
// name="q">` sem classe — que `buildStableSelector` descreve exatamente assim — ganhava sinal na
// página e não ganhava destaque. A profundidade da assinatura (`MAX_SIGNATURE_ANCESTRY`) e o
// vocabulário do segmento são os mesmos nos dois caminhos, e o anel desenhado pelo destaque usa
// esse mesmo teto dentro da página.
export const MAX_SIGNATURE_ANCESTRY = 64;
export const SIGNAL_SEMANTIC_ATTRIBUTES = Object.freeze([
  'name', 'alt', 'title', 'aria-label', 'data-testid', 'role',
]);
export const MAX_SIGNAL_SEGMENTS = 64;
export const MAX_SIGNAL_COMPLEXITY = 320;
export const MAX_SIGNAL_ATTRIBUTE_VALUE = 256;
export const MAX_SIGNAL_CLASSES = 24;

// Um segmento dos sinais nunca carrega classes: as classes registradas viajam ao lado do caminho,
// como corroboração, e não dentro do seletor.
const SIGNAL_SEGMENT_PATTERN = new RegExp(
  '^([a-z][a-z0-9-]{0,62})'
  + '(?:#(-?[_A-Za-z][_A-Za-z0-9-]*))?'
  + '(?:\\[([a-z][a-z0-9-]{0,31})="((?:[^"\\\\]|\\\\.)*)"\\])?'
  + '(?::nth-of-type\\(([1-9][0-9]*)\\))?$', 'u');

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;

/** Same closed token shape as `classifySelectorToken`, minus the date/hash heuristics. */
export function classifySignalToken(value) {
  return typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= MAX_TOKEN_LENGTH &&
    SAFE_TOKEN_PATTERN.test(value) &&
    !isSignalSensitiveToken(value);
}

/** Credential-shaped names stay refused even inside the page. */
export function isSignalSensitiveToken(value) {
  return SENSITIVE_TOKEN_PATTERN.test(value) || URL_LIKE_PATTERN.test(value) || UUID_PATTERN.test(value);
}

export function isSafeSignalAttributeValue(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= MAX_SIGNAL_ATTRIBUTE_VALUE &&
    !CONTROL_CHARACTER_PATTERN.test(value) && !isSignalSensitiveToken(value);
}

/** Undoes the CSS string escaping produced by `escapeCssString` in core/evidence/selector.js. */
export function unescapeCssString(value) {
  let output = '';
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== '\\') { output += value[index]; continue; }
    index += 1;
    if (index >= value.length) break;
    const hex = /^[0-9a-fA-F]{1,6}/u.exec(value.slice(index));
    if (hex) {
      const code = Number.parseInt(hex[0], 16);
      if (code > 0 && code <= 0x10ffff) output += String.fromCodePoint(code);
      index += hex[0].length - 1;
      if (value[index + 1] === ' ') index += 1;
      continue;
    }
    output += value[index];
  }
  return output;
}

export function parseSignalSelectorV1(value) {
  if (typeof value !== 'string') throw invalidSelector('O seletor deve ser texto primitivo.');
  if (value.length > MAX_SELECTOR_BYTES) throw invalidSelector('CSSSelectorV1 excede 2.048 bytes.');
  const byteLength = utf8(value).byteLength;
  if (byteLength > MAX_SELECTOR_BYTES) throw invalidSelector('CSSSelectorV1 excede 2.048 bytes.');

  RAW_SELECTOR_TOKEN_PATTERN.lastIndex = 0;
  for (const match of value.matchAll(RAW_SELECTOR_TOKEN_PATTERN)) {
    if (isSignalSensitiveToken(match[1])) throw invalidSelector('Token sensível proibido em CSSSelectorV1.');
  }

  const rawSegments = value.split(' > ');
  if (rawSegments.length < 1 || rawSegments.length > MAX_SIGNAL_SEGMENTS) {
    throw invalidSelector('CSSSelectorV1 excede o limite de segmentos.');
  }

  const segments = [];
  let complexity = Math.max(0, rawSegments.length - 1);
  for (const rawSegment of rawSegments) {
    const match = SIGNAL_SEGMENT_PATTERN.exec(rawSegment);
    if (!match) throw invalidSelector('CSSSelectorV1 não pertence à gramática fechada.');
    const [, tag, id = null, attributeName, rawAttributeValue, rawNth] = match;
    if (id !== null && !classifySignalToken(id)) throw invalidSelector('Token inválido em CSSSelectorV1.');

    let attribute = null;
    if (attributeName !== undefined) {
      const attributeValue = unescapeCssString(rawAttributeValue);
      if (!SIGNAL_SEMANTIC_ATTRIBUTES.includes(attributeName) || !isSafeSignalAttributeValue(attributeValue)) {
        throw invalidSelector('Atributo semântico não permitido em CSSSelectorV1.');
      }
      attribute = { name: attributeName, value: attributeValue };
    }

    let nthOfType = null;
    if (rawNth !== undefined) {
      nthOfType = Number(rawNth);
      if (!Number.isSafeInteger(nthOfType) || nthOfType < 1) throw invalidSelector('Ordinal inválido em CSSSelectorV1.');
    }

    complexity += 1 + (id === null ? 0 : 1) + (attribute === null ? 0 : 2) + (nthOfType === null ? 0 : 3);
    if (complexity > MAX_SIGNAL_COMPLEXITY) throw invalidSelector('CSSSelectorV1 excede a complexidade permitida.');
    segments.push({ tag, id, attribute, nthOfType });
  }

  // Um id ou um atributo descrevem o próprio elemento: nunca aparecem no meio de um caminho.
  if (segments.length > 1 && segments.some(segment => segment.id !== null || segment.attribute !== null)) {
    throw invalidSelector('CSSSelectorV1 não pertence à gramática fechada.');
  }

  return deepFreezePlain({ syntax: 'CSSSelectorV1', value, byteLength, complexity, segments });
}

const ALLOWED_ROLES = Object.freeze(new Set([
  'alert', 'button', 'checkbox', 'dialog', 'heading', 'img', 'link', 'list', 'listitem',
  'main', 'menu', 'menuitem', 'navigation', 'option', 'radio', 'region', 'search', 'slider',
  'spinbutton', 'status', 'switch', 'tab', 'tabpanel', 'textbox',
]));

const ALLOWED_TYPES = Object.freeze(new Set([
  'button', 'checkbox', 'email', 'file', 'number', 'password', 'radio', 'range', 'reset',
  'search', 'submit', 'tel', 'text', 'url',
]));

const BUTTON_INPUT_TYPES = new Set(['button', 'file', 'image', 'reset', 'submit']);
const TEXTBOX_INPUT_TYPES = new Set(['email', 'password', 'search', 'tel', 'text', 'url']);
const NO_ROLE_INPUT_TYPES = new Set(['color', 'date', 'datetime-local', 'hidden', 'month', 'time', 'week']);

function tokenShapeOk(value) {
  return typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= MAX_TOKEN_LENGTH &&
    SAFE_TOKEN_PATTERN.test(value);
}

export function classifySelectorToken(value) {
  return tokenShapeOk(value) && !isSensitiveSelectorToken(value);
}

// One closed grammar, two vocabularies. The strict one (`parseCssSelectorV1`) still governs the
// model, the export and the report; the eased one (`parseHighlightSelectorV1`) governs the live
// individual highlight, which is re-proved inside the page by the structural signature and must not
// refuse an element merely because its id or class carries four digits or eight hex characters.
// Credential-shaped names stay refused in both.
// A gramática ampliada aceita duas leituras do mesmo campo: as enumerações que o modelo exporta
// (role/type) e o atributo semântico do próprio elemento, exatamente como os sinais o revalidam
// dentro da página.
function allowsSemanticAttribute(name, value) {
  const enumerations = name === 'role' ? ALLOWED_ROLES : name === 'type' ? ALLOWED_TYPES : null;
  if (enumerations?.has(value)) return true;
  return SIGNAL_SEMANTIC_ATTRIBUTES.includes(name) && isSafeSignalAttributeValue(value);
}

function parseSelectorV1(value, { maxSegments, maxComplexity, sensitive, vocabulary = 'enum' }) {
  if (typeof value !== 'string') throw invalidSelector('O seletor deve ser texto primitivo.');
  if (value.length > MAX_SELECTOR_BYTES) throw invalidSelector('CSSSelectorV1 excede 2.048 bytes.');
  const byteLength = utf8(value).byteLength;
  if (byteLength > MAX_SELECTOR_BYTES) throw invalidSelector('CSSSelectorV1 excede 2.048 bytes.');

  RAW_SELECTOR_TOKEN_PATTERN.lastIndex = 0;
  for (const match of value.matchAll(RAW_SELECTOR_TOKEN_PATTERN)) {
    if (sensitive(match[1])) throw invalidSelector('Token sensível proibido em CSSSelectorV1.');
  }
  const rawSegments = value.split(' > ');
  if (rawSegments.length < 1 || rawSegments.length > maxSegments) {
    throw invalidSelector('CSSSelectorV1 excede o limite de segmentos.');
  }

  const assertSafeToken = token => {
    if (sensitive(token) || !tokenShapeOk(token)) throw invalidSelector('Token sensível proibido em CSSSelectorV1.');
  };
  const semantic = vocabulary === 'semantic';
  const segments = [];
  let complexity = Math.max(0, rawSegments.length - 1);
  for (const rawSegment of rawSegments) {
    const match = (semantic ? SEMANTIC_SEGMENT_PATTERN : SEGMENT_PATTERN).exec(rawSegment);
    if (!match) throw invalidSelector('CSSSelectorV1 não pertence à gramática fechada.');
    const [, tag, id = null, rawClasses = '', attributeName, rawAttributeValue, rawNth] = match;
    const classes = [...rawClasses.matchAll(CLASS_PATTERN)].map(entry => entry[1]);
    if (id !== null) assertSafeToken(id);
    for (const className of classes) assertSafeToken(className);

    let enumAttribute = null;
    if (attributeName !== undefined) {
      // Duas leituras do mesmo campo: a estrita só admite as enumerações de role/type exportadas no
      // modelo; a ampliada admite o atributo semântico do próprio elemento, com o mesmo teste de
      // valor que os sinais fazem dentro da página.
      const attributeValue = semantic ? unescapeCssString(rawAttributeValue) : rawAttributeValue;
      const allowed = semantic
        ? allowsSemanticAttribute(attributeName, attributeValue)
        : (attributeName === 'role' ? ALLOWED_ROLES : ALLOWED_TYPES).has(attributeValue);
      if (!allowed) throw invalidSelector('Atributo semântico não permitido em CSSSelectorV1.');
      enumAttribute = { name: attributeName, value: attributeValue };
    }

    let nthOfType = null;
    if (rawNth !== undefined) {
      nthOfType = Number(rawNth);
      if (!Number.isSafeInteger(nthOfType) || nthOfType < 1) {
        throw invalidSelector('Ordinal inválido em CSSSelectorV1.');
      }
    }

    complexity += 1 + (id === null ? 0 : 1) + classes.length + (enumAttribute === null ? 0 : 2) + (nthOfType === null ? 0 : 3);
    if (complexity > maxComplexity) throw invalidSelector('CSSSelectorV1 excede a complexidade permitida.');
    segments.push({ tag, id, classes, enumAttribute, nthOfType });
  }

  return deepFreezePlain({ syntax: 'CSSSelectorV1', value, byteLength, complexity, segments });
}

export function parseCssSelectorV1(value) {
  return parseSelectorV1(value, {
    maxSegments: MAX_SELECTOR_SEGMENTS,
    maxComplexity: MAX_SELECTOR_COMPLEXITY,
    sensitive: isSensitiveSelectorToken,
  });
}

export function parseHighlightSelectorV1(value) {
  return parseSelectorV1(value, {
    maxSegments: MAX_SIGNAL_SEGMENTS,
    maxComplexity: MAX_SIGNAL_COMPLEXITY,
    sensitive: isSignalSensitiveToken,
    vocabulary: 'semantic',
  });
}

export function canonicalPath(element, { scopeRoot, maxSegments } = {}) {
  assertPathArguments(element, scopeRoot, maxSegments);
  assertOpenScope(scopeRoot);
  assertScopeReachable(element, scopeRoot, maxSegments, 'CSSSelectorV1');

  const reversed = [];
  const seen = new Set();
  let current = element;
  while (true) {
    if (!current || seen.has(current)) throw new TypeError('Ciclo ou escopo não alcançado em CSSSelectorV1.');
    seen.add(current);
    reversed.push(segmentFor(current));

    if (isScopeRoot(current, scopeRoot)) break;
    if (reversed.length >= maxSegments) throw new TypeError('Escopo não alcançado em CSSSelectorV1.');
    current = parentWithinScope(current, scopeRoot);
  }

  const value = reversed.reverse().join(' > ');
  const parsed = parseCssSelectorV1(value);
  if (!selectorMatchesOne(scopeRoot, parsed.value, element)) {
    throw new TypeError('CSSSelectorV1 não produziu um seletor único para o elemento esperado.');
  }
  return parsed;
}

export function selectorMatchesOne(scopeRoot, selector, expectedElement) {
  try {
    return Boolean(expectedElement) && exactQuery(scopeRoot, selector) === expectedElement;
  } catch {
    return false;
  }
}

export function roleForStructuralSignature(element) {
  const tag = tagToken(element);
  const explicitRole = boundedAttribute(element, 'role', MAX_RAW_ROLE_CODE_UNITS);
  if (explicitRole !== null) {
    for (const token of explicitRole.split(/[\t\n\f\r ]+/u)) {
      if (ALLOWED_ROLES.has(token)) return token;
    }
  }

  if ((tag === 'a' || tag === 'area') && safeAttribute(element, 'href') !== null) return 'link';
  if (tag === 'button') return 'button';
  if (tag === 'input') return nativeInputRole(boundedAttribute(element, 'type', MAX_RAW_TYPE_CODE_UNITS));
  // The native combobox/listbox roles of select are intentionally outside the frozen role vocabulary.
  if (tag === 'select') return null;
  if (tag === 'textarea') return 'textbox';
  if (tag === 'img') return 'img';
  if (tag === 'nav') return 'navigation';
  if (tag === 'main') return 'main';
  if (tag === 'ul' || tag === 'ol') return 'list';
  if (tag === 'li') return 'listitem';
  if (/^h[1-6]$/u.test(tag)) return 'heading';
  if (tag === 'dialog') return 'dialog';
  return null;
}

export async function createStructuralSignatureV1(args) {
  const { documentId, frameId, element, scopeRoot, subtle } = validateSignatureArguments(args);
  assertOpenScope(scopeRoot);
  const canonical = await canonicalSignatureInput({ documentId, frameId, element, scopeRoot, subtle });
  const sha256 = await sha256Hex(utf8(canonicalStringify(canonical)), subtle);
  return deepFreezePlain({ version: 'StructuralSignatureV1', sha256 });
}

export async function structuralSignatureMatches(expected, input) {
  const expectedBytes = validateExpectedSignature(expected);
  let actual;
  try {
    actual = await createStructuralSignatureV1(input);
  } catch {
    return false;
  }
  const actualBytes = hexBytes(actual.sha256);
  let difference = 0;
  for (let index = 0; index < expectedBytes.length; index += 1) difference |= expectedBytes[index] ^ actualBytes[index];
  return difference === 0;
}

function invalidSelector(message) {
  return new TypeError(message);
}

function utf8(value) {
  return new TextEncoder().encode(value);
}

function isSensitiveSelectorToken(value) {
  return SENSITIVE_TOKEN_PATTERN.test(value) || URL_LIKE_PATTERN.test(value) ||
    FOUR_DECIMALS_PATTERN.test(value) || EIGHT_HEX_PATTERN.test(value) || UUID_PATTERN.test(value);
}

function assertSafeSelectorToken(value) {
  if (isSensitiveSelectorToken(value)) throw invalidSelector('Token sensível proibido em CSSSelectorV1.');
  if (!classifySelectorToken(value)) throw invalidSelector('Token inválido em CSSSelectorV1.');
}

function assertPathArguments(element, scopeRoot, maxSegments) {
  if (!element || !scopeRoot) throw new TypeError('Elemento e escopo são obrigatórios em CSSSelectorV1.');
  if (!Number.isSafeInteger(maxSegments) || maxSegments < 1 || maxSegments > MAX_SELECTOR_SEGMENTS) {
    throw new TypeError('Limite de segmentos inválido em CSSSelectorV1.');
  }
}

function assertOpenScope(scopeRoot) {
  if (scopeRoot && scopeRoot.mode === 'closed' && scopeRoot.host) {
    throw new TypeError('Shadow root fechado não é aceito como escopo de CSSSelectorV1.');
  }
}

function isScopeRoot(node, scopeRoot) {
  if (!node || node === scopeRoot) return false;
  if (node.parentNode === scopeRoot) return true;
  if (node.parentElement === null && typeof node.getRootNode === 'function') {
    try {
      return node.getRootNode() === scopeRoot;
    } catch {
      return false;
    }
  }
  return false;
}

function parentWithinScope(node, scopeRoot) {
  if (isScopeRoot(node, scopeRoot)) return null;
  const parent = node?.parentElement;
  if (!parent || parent === node) throw new TypeError('Escopo não alcançado em CSSSelectorV1.');
  return parent;
}

function tagToken(node) {
  const rawTag = node?.tagName;
  if (typeof rawTag !== 'string' || rawTag.length > 63) throw new TypeError('Tag inválida em CSSSelectorV1.');
  const tag = rawTag.toLowerCase();
  if (!TAG_PATTERN.test(tag)) throw new TypeError('Tag inválida em CSSSelectorV1.');
  return tag;
}

function nthOfType(node) {
  const tag = tagToken(node);
  const parent = node.parentElement ?? node.parentNode;
  const children = boundedChildren(parent);
  let ordinal = 0;
  let foundOrdinal = null;
  for (const sibling of children) {
    if (tagToken(sibling) !== tag) continue;
    ordinal += 1;
    if (sibling === node) foundOrdinal = ordinal;
  }
  if (!Number.isSafeInteger(foundOrdinal) || foundOrdinal < 1) {
    throw new TypeError('Ordinal inválido em StructuralSignatureV1.');
  }
  return foundOrdinal;
}

function segmentFor(node) {
  const tag = tagToken(node);
  const rawId = boundedAttribute(node, 'id', MAX_RAW_ID_CODE_UNITS);
  const id = rawId === null || rawId === '' ? null : rawId;
  if (id !== null) assertSafeSelectorToken(id);

  const rawClass = boundedAttribute(node, 'class', MAX_RAW_CLASS_CODE_UNITS);
  const allClasses = rawClass === null ? [] : rawClass.split(/[\t\n\f\r ]+/u).filter(Boolean);
  for (const className of allClasses) assertSafeSelectorToken(className);
  const classes = [...new Set(allClasses)].slice(0, 2);

  let enumAttribute = null;
  const role = boundedAttribute(node, 'role', MAX_RAW_ROLE_CODE_UNITS);
  const type = boundedAttribute(node, 'type', MAX_RAW_TYPE_CODE_UNITS);
  if (role !== null && ALLOWED_ROLES.has(role)) enumAttribute = { name: 'role', value: role };
  else if (type !== null && ALLOWED_TYPES.has(type)) enumAttribute = { name: 'type', value: type };

  let value = `${tag}${id === null ? '' : `#${id}`}${classes.map(className => `.${className}`).join('')}`;
  if (enumAttribute !== null) value += `[${enumAttribute.name}="${enumAttribute.value}"]`;

  const parent = node.parentElement ?? node.parentNode;
  const siblings = boundedChildren(parent).filter(sibling => {
    try { return tagToken(sibling) === tag; } catch { return false; }
  });
  let matchingSiblings = 0;
  for (const sibling of siblings) {
    try {
      if (typeof sibling.matches === 'function' && sibling.matches(value)) matchingSiblings += 1;
    } catch {
      throw new TypeError('Seletor intermediário inválido em CSSSelectorV1.');
    }
  }
  if (matchingSiblings !== 1) value += `:nth-of-type(${nthOfType(node)})`;
  return value;
}

function exactQuery(scopeRoot, value) {
  if (!scopeRoot || typeof scopeRoot.querySelectorAll !== 'function') return null;
  const parsed = parseCssSelectorV1(value);
  const matches = scopeRoot.querySelectorAll(parsed.value);
  return matches !== null && typeof matches.length === 'number' && matches.length === 1 ? matches[0] : null;
}

async function canonicalSignatureInput({ documentId, frameId, element, scopeRoot, subtle }) {
  assertScopeReachable(element, scopeRoot, MAX_SIGNATURE_ANCESTRY, 'StructuralSignatureV1');
  const ancestry = [];
  const seen = new Set();
  let current = element;
  while (true) {
    if (!current || seen.has(current)) throw new TypeError('Ciclo ou escopo não alcançado em StructuralSignatureV1.');
    seen.add(current);
    const ordinal = nthOfType(current);
    const attributes = [];
    for (const [name, budget] of [
      ['role', MAX_RAW_ROLE_CODE_UNITS],
      ['type', MAX_RAW_TYPE_CODE_UNITS],
    ]) {
      const rawValue = boundedAttribute(current, name, budget);
      if (rawValue !== null && classifySelectorToken(rawValue)) {
        attributes.push({ name, valueSha256: await sha256Hex(utf8(rawValue), subtle) });
      }
    }
    ancestry.push({ tag: tagToken(current), nthOfType: ordinal, attributes });
    if (isScopeRoot(current, scopeRoot)) break;
    if (ancestry.length >= MAX_SIGNATURE_ANCESTRY) throw new TypeError('Escopo não alcançado em StructuralSignatureV1.');
    current = parentWithinScope(current, scopeRoot);
  }

  return {
    version: 'StructuralSignatureInputV1',
    documentId,
    frameId,
    tag: tagToken(element),
    computedRole: roleForStructuralSignature(element),
    ancestry,
  };
}

async function sha256Hex(bytes, subtle) {
  let digest;
  try {
    digest = await subtle.digest('SHA-256', bytes);
  } catch {
    throw new TypeError('SHA-256 indisponível em StructuralSignatureV1.');
  }
  const output = new Uint8Array(digest);
  if (output.byteLength !== 32) throw new TypeError('SHA-256 inválido em StructuralSignatureV1.');
  return [...output].map(value => value.toString(16).padStart(2, '0')).join('');
}

function safeAttribute(element, name) {
  if (!element || typeof element.getAttribute !== 'function') throw new TypeError('Elemento inválido em StructuralSignatureV1.');
  const value = element.getAttribute(name);
  if (value !== null && typeof value !== 'string') throw new TypeError('Atributo inválido em StructuralSignatureV1.');
  return value;
}

function boundedAttribute(element, name, maxCodeUnits) {
  const value = safeAttribute(element, name);
  if (value !== null && value.length > maxCodeUnits) {
    throw new TypeError(`Orçamento do atributo ${name} excedido em StructuralSignatureV1.`);
  }
  return value;
}

function boundedChildren(parent) {
  if (!parent) throw new TypeError('Ordinal indisponível em StructuralSignatureV1.');
  const collection = parent.children;
  if (!collection) throw new TypeError('Ordinal indisponível em StructuralSignatureV1.');
  const length = collection.length;
  if (!Number.isSafeInteger(length) || length < 0) throw new TypeError('Coleção de filhos inválida em StructuralSignatureV1.');
  if (length > MAX_CHILDREN_PER_PARENT) throw new TypeError('Orçamento de filhos excedido em StructuralSignatureV1.');
  const children = [];
  for (let index = 0; index < length; index += 1) {
    const child = collection[index];
    if (!child) throw new TypeError('Coleção de filhos inválida em StructuralSignatureV1.');
    children.push(child);
  }
  if (collection.length !== length) throw new TypeError('Coleção de filhos alterada durante StructuralSignatureV1.');
  return children;
}

function nativeInputRole(rawType) {
  const type = rawType === null || rawType === '' ? 'text' : rawType.toLowerCase();
  if (BUTTON_INPUT_TYPES.has(type)) return 'button';
  if (TEXTBOX_INPUT_TYPES.has(type)) return 'textbox';
  if (type === 'checkbox') return 'checkbox';
  if (type === 'number') return 'spinbutton';
  if (type === 'radio') return 'radio';
  if (type === 'range') return 'slider';
  if (NO_ROLE_INPUT_TYPES.has(type)) return null;
  return 'textbox';
}

function validateSignatureArguments(args) {
  const keys = ['documentId', 'element', 'frameId', 'scopeRoot', 'subtle'];
  const snapshot = snapshotExactPlainDataRecord(args, keys);
  if (snapshot === null) throw new TypeError('Entrada de assinatura com argumentos inválidos.');
  const { documentId, frameId, element, scopeRoot, subtle } = snapshot;
  if (typeof documentId !== 'string' || !DOCUMENT_ID_PATTERN.test(documentId) ||
    !Number.isSafeInteger(frameId) || frameId < 0 || !element || !scopeRoot ||
    !subtle || typeof subtle.digest !== 'function') {
    throw new TypeError('Entrada de assinatura com argumentos inválidos.');
  }
  return { documentId, frameId, element, scopeRoot, subtle };
}

function validateExpectedSignature(expected) {
  const snapshot = snapshotExactPlainDataRecord(expected, ['sha256', 'version']);
  if (snapshot === null || snapshot.version !== 'StructuralSignatureV1' ||
    typeof snapshot.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(snapshot.sha256)) {
    throw new TypeError('Assinatura StructuralSignatureV1 inválida.');
  }
  return hexBytes(snapshot.sha256);
}

function assertScopeReachable(element, scopeRoot, maxSegments, label) {
  const seen = new Set();
  let current = element;
  for (let depth = 1; depth <= maxSegments; depth += 1) {
    if (!current || seen.has(current)) throw new TypeError(`Ciclo ou escopo não alcançado em ${label}.`);
    seen.add(current);
    if (isScopeRoot(current, scopeRoot)) return;
    if (depth === maxSegments) break;
    current = current.parentElement;
  }
  throw new TypeError(`Escopo não alcançado em ${label}.`);
}

function snapshotExactPlainDataRecord(value, expectedKeys) {
  try {
    if (!value || typeof value !== 'object') return null;
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== expectedKeys.length || keys.some(key => typeof key !== 'string')) return null;
    const sorted = [...keys].sort();
    const expected = [...expectedKeys].sort();
    for (let index = 0; index < sorted.length; index += 1) if (sorted[index] !== expected[index]) return null;

    const snapshot = Object.create(null);
    for (const key of expectedKeys) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) return null;
      Object.defineProperty(snapshot, key, {
        value: descriptor.value,
        enumerable: true,
        configurable: false,
        writable: false,
      });
    }
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}

function hexBytes(value) {
  const output = new Uint8Array(32);
  for (let index = 0; index < output.length; index += 1) output[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return output;
}

function deepFreezePlain(value) {
  if (Array.isArray(value)) {
    for (const entry of value) deepFreezePlain(entry);
    return Object.freeze(value);
  }
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreezePlain(value[key]);
    return Object.freeze(value);
  }
  return value;
}
