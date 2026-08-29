export const AUDIT_MODEL_INPUT_ERROR_CODE = 'AUDIT_MODEL_INPUT_INVALID';
export const AUDIT_MODEL_INPUT_ERROR_MESSAGE =
  'Modelo de auditoria inválido: schema/esquema, integridade/hash, ocorrência, regra core, item ABNT, evidência/mapa/origem, revisão, decisão, status/sessão, widget, alvo, fonte/proveniência/registro, versão/metodologia, página/escopo/URL, resultado, data, cobertura/axe parcial/cobertura axe, captura integral ou alegação normativa/WCAG incoerente ou duplicada.';

const CAPTURED_AUDIT_INPUTS = new WeakSet();
const MAX_GRAPH_DEPTH = 96;
const MAX_GRAPH_NODES = 300_000;
const MAX_ARRAY_LENGTH = 300_000;

export function auditModelInputError() {
  const error = new TypeError(AUDIT_MODEL_INPUT_ERROR_MESSAGE);
  Object.defineProperty(error, 'code', {
    configurable: false,
    enumerable: false,
    writable: false,
    value: AUDIT_MODEL_INPUT_ERROR_CODE,
  });
  return error;
}

export function isAuditModelInputError(error) {
  return Boolean(error && typeof error === 'object' && error.code === AUDIT_MODEL_INPUT_ERROR_CODE);
}

export function captureAuditInput(input) {
  if (input && typeof input === 'object' && CAPTURED_AUDIT_INPUTS.has(input)) return input;
  try {
    const budget = { nodes: 0 };
    const captured = captureValue(input, new WeakSet(), budget, 0);
    // Materialize only the inert descriptor snapshot. Returning to the source
    // graph here would create a second traversal after proxy traps have run.
    const materialized = structuredClone(captured);
    deepFreeze(materialized);
    CAPTURED_AUDIT_INPUTS.add(materialized);
    return materialized;
  } catch {
    throw auditModelInputError();
  }
}

function captureValue(value, ancestors, budget, depth) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError();
    return value;
  }
  if (!value || typeof value !== 'object' || depth > MAX_GRAPH_DEPTH) throw new TypeError();
  if (ancestors.has(value) || ++budget.nodes > MAX_GRAPH_NODES) throw new TypeError();

  const prototype = Object.getPrototypeOf(value);
  const isArray = Array.isArray(value);
  if (isArray ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
    throw new TypeError();
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  ancestors.add(value);
  try {
    if (isArray) return captureArray(descriptors, keys, ancestors, budget, depth);
    const output = {};
    for (const key of keys) {
      if (typeof key !== 'string' || key === 'privateContext') throw new TypeError();
      const descriptor = descriptors[key];
      if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) throw new TypeError();
      output[key] = captureValue(descriptor.value, ancestors, budget, depth + 1);
    }
    return output;
  } finally {
    ancestors.delete(value);
  }
}

function captureArray(descriptors, keys, ancestors, budget, depth) {
  const length = descriptors.length;
  if (!length || !Object.hasOwn(length, 'value') || !Number.isSafeInteger(length.value) ||
    length.value < 0 || length.value > MAX_ARRAY_LENGTH) throw new TypeError();
  const expectedKeys = length.value + 1;
  if (keys.length !== expectedKeys) throw new TypeError();
  const output = new Array(length.value);
  for (let index = 0; index < length.value; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) throw new TypeError();
    output[index] = captureValue(descriptor.value, ancestors, budget, depth + 1);
  }
  return output;
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value) || Object.isFrozen(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}
