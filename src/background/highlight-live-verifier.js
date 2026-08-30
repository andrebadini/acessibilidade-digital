import { validateHighlightBindingV1 } from './highlight-binding.js';

const HMAC = /^hmac-sha256:[A-Za-z0-9_-]{43}$/u;
const FORWARDED_PROOF_FAILURES = new Set([
  'ambiguous',
  'document-changed',
  'inaccessible',
  'shadow-root',
]);

function exactDataRecord(value, expectedKeys) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== expectedKeys.length || keys.some(key => typeof key !== 'string') ||
      expectedKeys.some(key => !keys.includes(key))) return null;
    const output = Object.create(null);
    for (const key of expectedKeys) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      output[key] = descriptor.value;
    }
    return output;
  } catch {
    return null;
  }
}

function ownData(value, key) {
  try {
    const descriptor = value && typeof value === 'object'
      ? Reflect.getOwnPropertyDescriptor(value, key)
      : null;
    return descriptor?.enumerable && Object.hasOwn(descriptor, 'value')
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

function ownCallable(value, key) {
  const candidate = ownData(value, key);
  return typeof candidate === 'function' ? candidate : null;
}

function sameData(left, right, seen = new WeakMap()) {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object' ||
    Array.isArray(left) !== Array.isArray(right)) return false;
  try {
    const paired = seen.get(left);
    if (paired !== undefined) return paired === right;
    seen.set(left, right);
    const leftPrototype = Reflect.getPrototypeOf(left);
    const rightPrototype = Reflect.getPrototypeOf(right);
    const validPrototype = value => value === Object.prototype || value === null || value === Array.prototype;
    if (!validPrototype(leftPrototype) || leftPrototype !== rightPrototype) return false;
    const leftKeys = Reflect.ownKeys(left);
    const rightKeys = Reflect.ownKeys(right);
    if (leftKeys.length !== rightKeys.length || leftKeys.some(key => typeof key !== 'string' || !rightKeys.includes(key))) {
      return false;
    }
    for (const key of leftKeys) {
      const leftDescriptor = Reflect.getOwnPropertyDescriptor(left, key);
      const rightDescriptor = Reflect.getOwnPropertyDescriptor(right, key);
      if (!leftDescriptor || !rightDescriptor || !Object.hasOwn(leftDescriptor, 'value') ||
        !Object.hasOwn(rightDescriptor, 'value') || leftDescriptor.enumerable !== rightDescriptor.enumerable ||
        !sameData(leftDescriptor.value, rightDescriptor.value, seen)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function canonicalTarget(binding, input) {
  const matches = [];
  for (const target of Object.values(binding.targets)) {
    if (sameData(target, input)) matches.push(target);
  }
  return matches.length >= 1 ? matches[0] : null;
}

function webUrl(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 32_768) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}

function safeTime(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function failure(reason) {
  return Object.freeze({ ok: false, reason });
}

function success(binding, target) {
  return Object.freeze({
    ok: true,
    tabId: binding.tabId,
    windowId: binding.windowId,
    documentId: target.documentId,
    frameId: target.frameId,
  });
}

function proofFailure(value) {
  const record = exactDataRecord(value, ['ok', 'reason']);
  if (!record || record.ok !== false || typeof record.reason !== 'string') return failure('live-proof-failed');
  return failure(FORWARDED_PROOF_FAILURES.has(record.reason) ? record.reason : 'live-proof-failed');
}

function proofSuccess(value, binding, target) {
  const record = exactDataRecord(value, ['ok', 'topDocumentId', 'documentId', 'frameId']);
  if (!record || record.ok !== true || typeof record.topDocumentId !== 'string' ||
    typeof record.documentId !== 'string' || !Number.isSafeInteger(record.frameId) || record.frameId < 0) {
    return failure('live-proof-failed');
  }
  if (record.topDocumentId !== binding.topDocumentId) return failure('document-changed');
  if (record.documentId !== target.documentId || record.frameId !== target.frameId) {
    return failure('live-proof-failed');
  }
  return success(binding, target);
}

export function createHighlightLiveVerifier(raw) {
  const options = exactDataRecord(raw, ['chromeApi', 'digestManager', 'chromeAdapter', 'now']);
  const tabs = options && ownData(options.chromeApi, 'tabs');
  const tabsGet = tabs && ownCallable(tabs, 'get');
  const digest = options && ownCallable(options.digestManager, 'digest');
  const verifyHighlightTarget = options && ownCallable(options.chromeAdapter, 'verifyHighlightTarget');
  if (!options || !tabsGet || !digest || !verifyHighlightTarget || typeof options.now !== 'function') {
    throw new TypeError('HIGHLIGHT_LIVE_VERIFIER_INVALID');
  }

  let lastNow = null;
  function readNow() {
    const value = options.now();
    if (!safeTime(value) || (lastNow !== null && value < lastNow)) {
      throw new TypeError('HIGHLIGHT_LIVE_VERIFIER_CLOCK_INVALID');
    }
    lastNow = value;
    return value;
  }

  function bindingTimeFailure(binding) {
    const value = readNow();
    if (value < binding.createdAt) return failure('live-proof-failed');
    return value >= binding.expiresAt ? failure('expired') : null;
  }

  async function confirmTabAndUrl(binding) {
    let tab;
    try {
      tab = await Reflect.apply(tabsGet, tabs, [binding.tabId]);
    } catch {
      return failure('page-or-process');
    }
    const tabId = ownData(tab, 'id');
    const windowId = ownData(tab, 'windowId');
    const discarded = ownData(tab, 'discarded');
    let rawUrl = webUrl(ownData(tab, 'url'));
    tab = null;
    if (tabId !== binding.tabId) return failure('page-or-process');
    if (windowId !== binding.windowId) return failure('window-changed');
    if (discarded !== false || rawUrl === null) return failure('page-or-process');

    let currentDigest;
    try {
      currentDigest = await Reflect.apply(digest, options.digestManager, [rawUrl]);
    } catch {
      rawUrl = null;
      return failure('url-changed');
    }
    rawUrl = null;
    if (typeof currentDigest !== 'string' || !HMAC.test(currentDigest) ||
      currentDigest !== binding.topUrlSessionDigest) return failure('url-changed');
    currentDigest = null;
    return null;
  }

  async function verify(rawInput) {
    const input = exactDataRecord(rawInput, ['binding', 'target']);
    let binding;
    let target;
    try {
      if (!input) return failure('invalid-input');
      binding = validateHighlightBindingV1(input.binding);
      target = canonicalTarget(binding, input.target);
      if (!target) return failure('invalid-input');
    } catch {
      return failure('invalid-input');
    }
    try {
      const timeFailure = bindingTimeFailure(binding);
      if (timeFailure) return timeFailure;
    } catch {
      return failure('live-proof-failed');
    }

    const firstTabFailure = await confirmTabAndUrl(binding);
    if (firstTabFailure) return firstTabFailure;

    let proof;
    try {
      proof = await Reflect.apply(verifyHighlightTarget, options.chromeAdapter, [{
        tabId: binding.tabId,
        windowId: binding.windowId,
        topDocumentId: binding.topDocumentId,
        target,
      }]);
    } catch {
      return failure('live-proof-failed');
    }

    let proofResult;
    try {
      const ok = ownData(proof, 'ok');
      proofResult = ok === false
        ? proofFailure(proof)
        : proofSuccess(proof, binding, target);
      if (!proofResult.ok) return proofResult;
    } catch {
      return failure('live-proof-failed');
    }
    const finalTabFailure = await confirmTabAndUrl(binding);
    if (finalTabFailure) return finalTabFailure;
    try {
      const timeFailure = bindingTimeFailure(binding);
      if (timeFailure) return timeFailure;
    } catch {
      return failure('live-proof-failed');
    }
    return proofResult;
  }

  return Object.freeze({ verify });
}
