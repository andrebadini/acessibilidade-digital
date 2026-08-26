const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function canonicalStringify(value) {
  return serialize(value, new WeakSet(), '$');
}

function serialize(value, ancestors, path) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`Número não finito no JSON canônico em ${path}.`);
    return JSON.stringify(value);
  }
  if (!value || typeof value !== 'object') throw new TypeError(`Valor não JSON-safe no JSON canônico em ${path}.`);
  if (ancestors.has(value)) throw new TypeError(`Ciclo detectado no JSON canônico em ${path}.`);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return serializeArray(value, ancestors, path);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`Objeto não simples no JSON canônico em ${path}.`);
    return serializeRecord(value, ancestors, path);
  } finally {
    ancestors.delete(value);
  }
}

function serializeArray(value, ancestors, path) {
  if (Object.getPrototypeOf(value) !== Array.prototype) throw new TypeError(`Lista não simples no JSON canônico em ${path}.`);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some(key => typeof key !== 'string' || (key !== 'length' && !/^(?:0|[1-9]\d*)$/u.test(key)))) {
    throw new TypeError(`Propriedade inválida em lista no JSON canônico em ${path}.`);
  }
  const parts = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new TypeError(`Lista esparsa no JSON canônico em ${path}[${index}].`);
    parts.push(serialize(descriptor.value, ancestors, `${path}[${index}]`));
  }
  return `[${parts.join(',')}]`;
}

function serializeRecord(value, ancestors, path) {
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string')) throw new TypeError(`Chave não textual no JSON canônico em ${path}.`);
  for (const key of keys) {
    if (UNSAFE_KEYS.has(key)) throw new TypeError(`Chave de protótipo proibida no JSON canônico em ${path}.${key}.`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
      throw new TypeError(`Propriedade não segura no JSON canônico em ${path}.${key}.`);
    }
  }
  keys.sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${serialize(Object.getOwnPropertyDescriptor(value, key).value, ancestors, `${path}.${key}`)}`).join(',')}}`;
}
