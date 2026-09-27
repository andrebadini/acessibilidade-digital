const CATEGORY_ORDER = Object.freeze(['password', 'otp', 'payment', 'private-marker']);
const PROBE_RESULT_KEYS = Object.freeze(['password', 'otp', 'payment', 'privateMarker']);
const INJECTION_RESULT_KEYS = Object.freeze(['frameId', 'documentId', 'result']);
const MAX_DOCUMENT_IDS = 256;

export const SENSITIVE_CATEGORY_LABELS_V1 = Object.freeze({
  password: 'Campo de senha',
  otp: 'Código de uso único',
  payment: 'Dados de pagamento',
  'private-marker': 'Conteúdo marcado como privado',
});

function unavailable() { return new Error('SENSITIVE_CONTEXT_PROBE_UNAVAILABLE'); }

function exact(value, keys) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== keys.length || ownKeys.some(key => typeof key !== 'string') || keys.some(key => !ownKeys.includes(key))) return null;
    const copy = Object.create(null);
    for (const key of keys) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      copy[key] = descriptor.value;
    }
    return copy;
  } catch { return null; }
}

function dense(value, maximum = Number.MAX_SAFE_INTEGER) {
  try {
    if (!Array.isArray(value) || Reflect.getPrototypeOf(value) !== Array.prototype) return null;
    const length = Reflect.getOwnPropertyDescriptor(value, 'length')?.value;
    if (!Number.isSafeInteger(length) || length < 0 || length > maximum) return null;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== length + 1 || !ownKeys.includes('length')) return null;
    const copy = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      copy.push(descriptor.value);
    }
    return copy;
  } catch { return null; }
}

function validTabId(value) { return Number.isSafeInteger(value) && value >= 0; }
function validDocumentId(value) { return typeof value === 'string' && value.length > 0 && value.length <= 240; }

function inputOptions(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some(key => typeof key !== 'string') || !ownKeys.includes('executeScript') ||
      ownKeys.some(key => !['executeScript', 'documentIds'].includes(key))) return null;
    const executeScript = Reflect.getOwnPropertyDescriptor(value, 'executeScript');
    if (!executeScript?.enumerable || !Object.hasOwn(executeScript, 'value') || typeof executeScript.value !== 'function') return null;
    if (!ownKeys.includes('documentIds')) return null;
    const documentIds = Reflect.getOwnPropertyDescriptor(value, 'documentIds');
    if (!documentIds?.enumerable || !Object.hasOwn(documentIds, 'value')) return null;
    const ids = dense(documentIds.value, MAX_DOCUMENT_IDS);
    if (!ids || ids.length === 0 || ids.some(id => !validDocumentId(id)) || new Set(ids).size !== ids.length) return null;
    return {
      executeScript: executeScript.value,
      expectedDocumentIds: Object.freeze([...ids]),
      targetDocumentIds: Object.freeze([...ids]),
    };
  } catch { return null; }
}

function rawProbeResult(value) {
  const result = exact(value, PROBE_RESULT_KEYS);
  return result && PROBE_RESULT_KEYS.every(key => typeof result[key] === 'boolean') ? result : null;
}

export function detectSensitiveCaptureSignalsV1(probeResult) {
  const result = rawProbeResult(probeResult);
  if (!result) throw unavailable();
  const categories = CATEGORY_ORDER.filter(category => result[category === 'private-marker' ? 'privateMarker' : category]);
  return Object.freeze({
    version: 'SensitiveCaptureSignalsV1', detected: categories.length > 0, categories: Object.freeze(categories),
  });
}

function inspectSensitiveContext() {
  const output = { password: false, otp: false, payment: false, privateMarker: false };
  const elementPrototype = globalThis.Element?.prototype;
  const capturedGetAttribute = typeof elementPrototype?.getAttribute === 'function' ? elementPrototype.getAttribute : null;
  const capturedHasAttribute = typeof elementPrototype?.hasAttribute === 'function' ? elementPrototype.hasAttribute : null;
  const shadowDescriptor = elementPrototype && Object.getOwnPropertyDescriptor(elementPrototype, 'shadowRoot');
  const capturedShadowRoot = typeof shadowDescriptor?.get === 'function' ? shadowDescriptor.get : null;
  const scan = root => {
    const query = root?.querySelectorAll;
    if (typeof query !== 'function') throw new Error('SENSITIVE_CONTEXT_PROBE_UNAVAILABLE');
    const elements = query.call(root, '*');
    for (const element of elements) {
      const getAttribute = capturedGetAttribute ?? element?.getAttribute;
      const hasAttribute = capturedHasAttribute ?? element?.hasAttribute;
      if (typeof getAttribute !== 'function' || typeof hasAttribute !== 'function') throw new Error('SENSITIVE_CONTEXT_PROBE_UNAVAILABLE');
      const tagName = element.tagName;
      if (typeof tagName !== 'string') throw new Error('SENSITIVE_CONTEXT_PROBE_UNAVAILABLE');
      const isInput = tagName.toLowerCase() === 'input';
      const type = isInput ? getAttribute.call(element, 'type') : null;
      const autocomplete = getAttribute.call(element, 'autocomplete');
      if ((type !== null && typeof type !== 'string') || (autocomplete !== null && typeof autocomplete !== 'string')) {
        throw new Error('SENSITIVE_CONTEXT_PROBE_UNAVAILABLE');
      }
      const tokens = autocomplete === null ? [] : autocomplete.toLowerCase().split(/[\t\n\f\r ]+/u).filter(Boolean);
      if (isInput && type?.toLowerCase() === 'password') output.password = true;
      if (tokens.includes('current-password') || tokens.includes('new-password')) output.password = true;
      if (tokens.includes('one-time-code')) output.otp = true;
      if (tokens.some(token => token.startsWith('cc-'))) output.payment = true;
      if (hasAttribute.call(element, 'data-audita-private')) output.privateMarker = true;
      const shadowRoot = capturedShadowRoot ? capturedShadowRoot.call(element) : element.shadowRoot;
      if (shadowRoot !== null && shadowRoot !== undefined) scan(shadowRoot);
    }
  };
  scan(globalThis.document);
  return output;
}

function injectionResult(value) {
  const result = exact(value, INJECTION_RESULT_KEYS);
  const probeResult = result && rawProbeResult(result.result);
  return result && validTabId(result.frameId) && validDocumentId(result.documentId) && probeResult
    ? Object.freeze({ frameId: result.frameId, documentId: result.documentId, result: Object.freeze(probeResult) })
    : null;
}

function aggregate(results, documentIds) {
  const values = dense(results);
  if (!values || values.length === 0) return null;
  const frames = new Set();
  const documents = new Set();
  let mainFrame = false;
  const flags = { password: false, otp: false, payment: false, privateMarker: false };
  for (const value of values) {
    const result = injectionResult(value);
    if (!result || frames.has(result.frameId) || documents.has(result.documentId)) return null;
    frames.add(result.frameId); documents.add(result.documentId); mainFrame ||= result.frameId === 0;
    for (const key of PROBE_RESULT_KEYS) flags[key] ||= result.result[key];
  }
  if (!mainFrame) return null;
  if (documents.size !== documentIds.length || documentIds.some(documentId => !documents.has(documentId))) return null;
  return flags;
}

export async function probeSensitiveContextInTab(tabId, options) {
  const input = inputOptions(options);
  if (!validTabId(tabId) || !input) throw unavailable();
  const target = Object.freeze({ tabId, documentIds: input.targetDocumentIds });
  try {
    const flags = aggregate(await input.executeScript({ target, world: 'ISOLATED', injectImmediately: true, func: inspectSensitiveContext }), input.expectedDocumentIds);
    if (!flags) throw unavailable();
    return detectSensitiveCaptureSignalsV1(flags);
  } catch { throw unavailable(); }
}
