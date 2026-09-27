const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const ARRAY_INDEX = /^(?:0|[1-9]\d*)$/u;

// O caminho ($.pages[0].nodes[12]…) só aparece na mensagem de erro. Montá-lo para cada valor criava milhões
// de strings em modelos de páginas grandes; agora ele é reconstruído apenas quando algo falha, enquanto o
// erro sobe pela recursão, e a mensagem final é idêntica à anterior.
class CanonicalPathError {
  constructor(prefix, segments = []) {
    this.prefix = prefix;
    this.segments = segments;
  }
}

function fail(prefix, ...segments) {
  throw new CanonicalPathError(prefix, segments);
}

export function canonicalStringify(value) {
  try {
    return serialize(value, new WeakSet());
  } catch (error) {
    if (error instanceof CanonicalPathError) {
      throw new TypeError(`${error.prefix} em $${error.segments.join('')}.`);
    }
    throw error;
  }
}

function serialize(value, ancestors) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('Número não finito no JSON canônico');
    return JSON.stringify(value);
  }
  if (!value || typeof value !== 'object') fail('Valor não JSON-safe no JSON canônico');
  if (ancestors.has(value)) fail('Ciclo detectado no JSON canônico');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return serializeArray(value, ancestors);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) fail('Objeto não simples no JSON canônico');
    return serializeRecord(value, ancestors);
  } finally {
    ancestors.delete(value);
  }
}

function serializeArray(value, ancestors) {
  if (Object.getPrototypeOf(value) !== Array.prototype) fail('Lista não simples no JSON canônico');
  const ownKeys = Reflect.ownKeys(value);
  // Uma lista densa tem exatamente `length` índices e a própria `length`; o laço abaixo confirma cada índice.
  // Só quando a contagem diverge é preciso procurar a chave estranha.
  if (ownKeys.length !== value.length + 1 &&
    ownKeys.some(key => typeof key !== 'string' || (key !== 'length' && !ARRAY_INDEX.test(key)))) {
    fail('Propriedade inválida em lista no JSON canônico');
  }
  const parts = new Array(value.length);
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail('Lista esparsa no JSON canônico', `[${index}]`);
    try {
      parts[index] = serialize(descriptor.value, ancestors);
    } catch (error) {
      if (error instanceof CanonicalPathError) error.segments.unshift(`[${index}]`);
      throw error;
    }
  }
  return `[${parts.join(',')}]`;
}

function serializeRecord(value, ancestors) {
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string')) fail('Chave não textual no JSON canônico');
  const values = new Map();
  for (const key of keys) {
    if (UNSAFE_KEYS.has(key)) fail('Chave de protótipo proibida no JSON canônico', `.${key}`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
      fail('Propriedade não segura no JSON canônico', `.${key}`);
    }
    values.set(key, descriptor.value);
  }
  keys.sort();
  const parts = new Array(keys.length);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    try {
      parts[index] = `${JSON.stringify(key)}:${serialize(values.get(key), ancestors)}`;
    } catch (error) {
      if (error instanceof CanonicalPathError) error.segments.unshift(`.${key}`);
      throw error;
    }
  }
  return `{${parts.join(',')}}`;
}
