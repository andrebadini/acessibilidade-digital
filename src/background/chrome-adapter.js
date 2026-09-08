import { collectPage } from '../browser/collect-page.js';
import { captureElement, captureFullPage } from '../browser/capture-evidence.js';
import { composeAnnouncementMapForProduction as composeAnnouncementMap } from '../browser/annotation-map.js';
import { createCdpClient, createChromeDebuggerTransport } from '../browser/cdp-client.js';
import { runDynamicProbes } from '../collector/dynamic-probes.js';
import { sanitizeEvidenceUrlV1 } from '../core/privacy.js';
import { canonicalStringify } from '../core/report/canonical-json.js';
import { parseCssSelectorV1 } from './highlight-locator.js';
import { runAuditaHighlightCommand } from '../browser/highlight-overlay.js';
import { probeSensitiveContextInTab } from '../browser/sensitive-context-probe.js';

export const AUDIT_EXECUTION_INTERNAL = Symbol('audita.audit-execution-internal');

const PrimordialTypeError = TypeError;
const ObjectPrototype = Object.prototype;
const ObjectCreate = Object.create;
const ObjectDefineProperty = Object.defineProperty;
const ObjectFreeze = Object.freeze;
const ObjectPreventExtensions = Object.preventExtensions;
const ObjectGetPrototypeOf = Object.getPrototypeOf;
const ObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const ObjectHasOwn = Object.hasOwn;
const ObjectIsExtensible = Object.isExtensible;
const ReflectOwnKeys = Reflect.ownKeys;
const ReflectApply = Reflect.apply;
const FunctionPrototypeBind = Function.prototype.bind;
const WeakSetPrototypeAdd = WeakSet.prototype.add;
const WeakSetPrototypeHas = WeakSet.prototype.has;
const PrimordialUint8Array = Uint8Array;
const PrimordialCrypto = globalThis.crypto;
const PrimordialGetRandomValues = PrimordialCrypto?.getRandomValues;
const ChromeAuditAuthorities = new WeakSet();

const HIGHLIGHT_ID = /^[A-Za-z0-9._:-]{1,200}$/u;
const HIGHLIGHT_DOCUMENT_ID = /^[A-Za-z0-9._:-]{1,240}$/u;
const HIGHLIGHT_NONCE = /^[A-Za-z0-9_-]{22}$/u;
const HIGHLIGHT_SHA256 = /^[a-f0-9]{64}$/u;
const MAX_HIGHLIGHT_TARGETS = 5_000;
const MAX_HIGHLIGHT_SELECTOR_BYTES = 1_000_000;
const CAPTURE_POLICY_KEYS = ObjectFreeze([
  'version', 'mode', 'includeQuery', 'captureFullPage', 'captureElements', 'composeAnnouncementMap',
]);
const ATTACHED_COPY_TARGET_KEYS = ObjectFreeze(['tabId', 'windowId', 'documentId', 'urlSessionDigest']);

function exactHighlightRecord(value, expectedKeys) {
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

function denseHighlightArray(value, maximum) {
  try {
    if (!Array.isArray(value) || Reflect.getPrototypeOf(value) !== Array.prototype) return null;
    const length = Reflect.getOwnPropertyDescriptor(value, 'length')?.value;
    if (!Number.isSafeInteger(length) || length < 0 || length > maximum) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== length + 1 || !keys.includes('length')) return null;
    const output = new Array(length);
    for (let index = 0; index < length; index += 1) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      output[index] = descriptor.value;
    }
    return output;
  } catch {
    return null;
  }
}

function validHighlightChromeId(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validHighlightId(value) {
  return typeof value === 'string' && HIGHLIGHT_ID.test(value) &&
    !['__proto__', 'prototype', 'constructor'].includes(value);
}

function highlightSelectorRecord(value) {
  const record = exactHighlightRecord(value, ['syntax', 'value', 'byteLength', 'complexity']);
  if (!record || record.syntax !== 'CSSSelectorV1') return null;
  try {
    const parsed = parseCssSelectorV1(record.value);
    if (parsed.byteLength !== record.byteLength || parsed.complexity !== record.complexity) return null;
    return Object.freeze({
      syntax: 'CSSSelectorV1',
      value: parsed.value,
      byteLength: parsed.byteLength,
      complexity: parsed.complexity,
    });
  } catch {
    return null;
  }
}

function highlightSignatureRecord(value) {
  const record = exactHighlightRecord(value, ['version', 'sha256']);
  return record?.version === 'StructuralSignatureV1' && typeof record.sha256 === 'string' &&
    HIGHLIGHT_SHA256.test(record.sha256)
    ? Object.freeze({ version: 'StructuralSignatureV1', sha256: record.sha256 })
    : null;
}

function highlightRectRecord(value) {
  if (value === null) return null;
  const record = exactHighlightRecord(value, ['x', 'y', 'width', 'height']);
  if (!record) return undefined;
  for (const key of ['x', 'y', 'width', 'height']) {
    if (!Number.isSafeInteger(record[key]) || Math.abs(record[key]) > 1_000_000 || record[key] % 16 !== 0) {
      return undefined;
    }
  }
  return record.width >= 0 && record.height >= 0
    ? Object.freeze({ x: record.x, y: record.y, width: record.width, height: record.height })
    : undefined;
}

function highlightCandidateRecord(value) {
  const record = exactHighlightRecord(value, ['occurrenceId', 'evidenceId', 'backendNodeId', 'selector']);
  const selector = record && highlightSelectorRecord(record.selector);
  return record && validHighlightId(record.occurrenceId) && validHighlightId(record.evidenceId) &&
    Number.isSafeInteger(record.backendNodeId) && record.backendNodeId > 0 && selector
    ? Object.freeze({
      occurrenceId: record.occurrenceId,
      evidenceId: record.evidenceId,
      backendNodeId: record.backendNodeId,
      selector,
    })
    : null;
}

function highlightTargetRecord(value) {
  const record = exactHighlightRecord(value, [
    'documentId', 'frameId', 'backendNodeId', 'evidenceId', 'selector',
    'structuralSignature', 'rectBucket',
  ]);
  const selector = record && highlightSelectorRecord(record.selector);
  const structuralSignature = record && highlightSignatureRecord(record.structuralSignature);
  const rectBucket = record && highlightRectRecord(record.rectBucket);
  if (!record || typeof record.documentId !== 'string' || !HIGHLIGHT_DOCUMENT_ID.test(record.documentId) ||
    !validHighlightChromeId(record.frameId) || !Number.isSafeInteger(record.backendNodeId) ||
    record.backendNodeId <= 0 || !validHighlightId(record.evidenceId) || !selector ||
    !structuralSignature || rectBucket === undefined) return null;
  return Object.freeze({
    documentId: record.documentId,
    frameId: record.frameId,
    backendNodeId: record.backendNodeId,
    evidenceId: record.evidenceId,
    selector,
    structuralSignature,
    rectBucket,
  });
}

function highlightProofInput(value) {
  const record = exactHighlightRecord(value, ['tabId', 'windowId', 'topDocumentId', 'candidates']);
  const candidates = record && denseHighlightArray(record.candidates, MAX_HIGHLIGHT_TARGETS);
  if (!record || !validHighlightChromeId(record.tabId) || !validHighlightChromeId(record.windowId) ||
    typeof record.topDocumentId !== 'string' || !HIGHLIGHT_DOCUMENT_ID.test(record.topDocumentId) ||
    !candidates || candidates.length < 1) return null;
  const output = [];
  const occurrenceIds = new Set();
  let selectorBytes = 0;
  for (const candidateValue of candidates) {
    const candidate = highlightCandidateRecord(candidateValue);
    if (!candidate || occurrenceIds.has(candidate.occurrenceId)) return null;
    occurrenceIds.add(candidate.occurrenceId);
    selectorBytes += candidate.selector.byteLength;
    if (!Number.isSafeInteger(selectorBytes) || selectorBytes > MAX_HIGHLIGHT_SELECTOR_BYTES) return null;
    output.push(candidate);
  }
  return Object.freeze({
    tabId: record.tabId,
    windowId: record.windowId,
    topDocumentId: record.topDocumentId,
    candidates: Object.freeze(output),
  });
}

function highlightVerifyInput(value) {
  const record = exactHighlightRecord(value, ['tabId', 'windowId', 'topDocumentId', 'target']);
  const target = record && highlightTargetRecord(record.target);
  return record && validHighlightChromeId(record.tabId) && validHighlightChromeId(record.windowId) &&
    typeof record.topDocumentId === 'string' && HIGHLIGHT_DOCUMENT_ID.test(record.topDocumentId) && target
    ? Object.freeze({
      tabId: record.tabId,
      windowId: record.windowId,
      topDocumentId: record.topDocumentId,
      target,
    })
    : null;
}

function highlightCommandInput(value) {
  const record = exactHighlightRecord(value, ['tabId', 'documentId', 'command']);
  if (!record || !validHighlightChromeId(record.tabId) || typeof record.documentId !== 'string' ||
    !HIGHLIGHT_DOCUMENT_ID.test(record.documentId)) return null;
  let command;
  const operation = exactHighlightRecord(record.command, ['version', 'op', 'nonce']);
  if (operation && operation.version === 1 && operation.op === 'clear' &&
    typeof operation.nonce === 'string' && HIGHLIGHT_NONCE.test(operation.nonce)) {
    command = Object.freeze({ version: 1, op: 'clear', nonce: operation.nonce });
  } else {
    const install = exactHighlightRecord(record.command, [
      'version', 'op', 'nonce', 'documentId', 'frameId', 'selector',
      'structuralSignature', 'kind', 'markerNumber',
    ]);
    const selector = install && highlightSelectorRecord(install.selector);
    const structuralSignature = install && highlightSignatureRecord(install.structuralSignature);
    if (!install || install.version !== 1 || install.op !== 'install' ||
      typeof install.nonce !== 'string' || !HIGHLIGHT_NONCE.test(install.nonce) ||
      install.documentId !== record.documentId || !validHighlightChromeId(install.frameId) ||
      !selector || !structuralSignature || !['failed', 'manual'].includes(install.kind) ||
      !Number.isSafeInteger(install.markerNumber) || install.markerNumber < 1 || install.markerNumber > 5_000) {
      return null;
    }
    command = Object.freeze({
      version: 1,
      op: 'install',
      nonce: install.nonce,
      documentId: install.documentId,
      frameId: install.frameId,
      selector,
      structuralSignature,
      kind: install.kind,
      markerNumber: install.markerNumber,
    });
  }
  return Object.freeze({ tabId: record.tabId, documentId: record.documentId, command });
}

async function collectHighlightStructuralProofs(rawCandidates, expectedElement = null) {
  function safeRecord(value, keys) {
    try {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
      const prototype = Reflect.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) return null;
      const ownKeys = Reflect.ownKeys(value);
      if (ownKeys.length !== keys.length || ownKeys.some(key => typeof key !== 'string') ||
        keys.some(key => !ownKeys.includes(key))) return null;
      const output = Object.create(null);
      for (const key of keys) {
        const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
        output[key] = descriptor.value;
      }
      return output;
    } catch {
      return null;
    }
  }

  const failure = reason => ({ version: 1, entries: [], reason });
  const tagOf = element => {
    const raw = element?.tagName;
    if (typeof raw !== 'string' || raw.length > 63) throw new TypeError();
    const tag = raw.toLowerCase();
    if (!/^[a-z][a-z0-9-]{0,62}$/u.test(tag)) throw new TypeError();
    return tag;
  };
  const attribute = (element, name, maximum) => {
    if (!element || typeof element.getAttribute !== 'function') throw new TypeError();
    const value = element.getAttribute(name);
    if (value !== null && (typeof value !== 'string' || value.length > maximum)) throw new TypeError();
    return value;
  };
  const sensitive = /(?:pass(?:word|wd)?|token|secret|auth(?:orization)?|session|cookie|csrf|xsrf|otp|one[-_]?time|api[-_]?key)/iu;
  const safeToken = value => typeof value === 'string' && value.length >= 1 && value.length <= 23 &&
    /^-?[_A-Za-z][_A-Za-z0-9-]*$/u.test(value) && !sensitive.test(value) &&
    !/@|:\/\/|www\./iu.test(value) && !/[0-9]{4}/u.test(value) &&
    !/[0-9a-f]{8}/iu.test(value) && !/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/iu.test(value);
  const hexDigest = async value => {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    const bytes = new Uint8Array(digest);
    if (bytes.byteLength !== 32) throw new TypeError();
    return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
  };
  const children = parent => {
    const values = parent?.children;
    if (!values || typeof values.length !== 'number' || !Number.isSafeInteger(values.length) ||
      values.length < 1 || values.length > 10_000) throw new TypeError();
    return Array.from(values);
  };
  const ordinal = element => {
    const tag = tagOf(element);
    let value = 0;
    let found = null;
    for (const sibling of children(element.parentElement ?? element.parentNode)) {
      if (tagOf(sibling) !== tag) continue;
      value += 1;
      if (sibling === element) found = value;
    }
    if (!Number.isSafeInteger(found) || found < 1) throw new TypeError();
    return found;
  };
  const computedRole = element => {
    const tag = tagOf(element);
    const allowed = new Set([
      'alert', 'button', 'checkbox', 'dialog', 'heading', 'img', 'link', 'list', 'listitem',
      'main', 'menu', 'menuitem', 'navigation', 'option', 'radio', 'region', 'search', 'slider',
      'spinbutton', 'status', 'switch', 'tab', 'tabpanel', 'textbox',
    ]);
    const explicit = attribute(element, 'role', 512);
    if (explicit !== null) {
      for (const token of explicit.split(/[\t\n\f\r ]+/u)) if (allowed.has(token)) return token;
    }
    if ((tag === 'a' || tag === 'area') && attribute(element, 'href', 8_192) !== null) return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'input') {
      const type = (attribute(element, 'type', 128) ?? 'text').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'range') return 'slider';
      if (type === 'number') return 'spinbutton';
      if (['button', 'file', 'image', 'reset', 'submit'].includes(type)) return 'button';
      if (['email', 'password', 'search', 'tel', 'text', 'url'].includes(type)) return 'textbox';
      if (['color', 'date', 'datetime-local', 'hidden', 'month', 'time', 'week'].includes(type)) return null;
      return 'textbox';
    }
    if (tag === 'textarea') return 'textbox';
    if (tag === 'img') return 'img';
    if (tag === 'nav') return 'navigation';
    if (tag === 'main') return 'main';
    if (tag === 'ul' || tag === 'ol') return 'list';
    if (tag === 'li') return 'listitem';
    if (/^h[1-6]$/u.test(tag)) return 'heading';
    if (tag === 'dialog') return 'dialog';
    return null;
  };
  const structuralInput = async element => {
    const ancestry = [];
    const seen = new Set();
    let current = element;
    while (true) {
      if (!current || seen.has(current) || ancestry.length >= 16) throw new TypeError();
      seen.add(current);
      const attributes = [];
      for (const [name, maximum] of [['role', 512], ['type', 128]]) {
        const value = attribute(current, name, maximum);
        if (value !== null && safeToken(value)) attributes.push({ name, valueSha256: await hexDigest(value) });
      }
      ancestry.push({ tag: tagOf(current), nthOfType: ordinal(current), attributes });
      if (current.parentNode === current.ownerDocument) break;
      current = current.parentElement;
    }
    return {
      version: 'StructuralSignatureInputV1',
      tag: tagOf(element),
      computedRole: computedRole(element),
      ancestry,
    };
  };

  try {
    if (!Array.isArray(rawCandidates) || rawCandidates.length < 1 || rawCandidates.length > 5_000) {
      return failure('inaccessible');
    }
    const entries = [];
    for (const rawCandidate of rawCandidates) {
      const candidate = safeRecord(rawCandidate, ['occurrenceId', 'selector']);
      if (!candidate || typeof candidate.occurrenceId !== 'string' ||
        typeof candidate.selector !== 'string' || candidate.selector.length < 1 || candidate.selector.length > 2_048) {
        return failure('inaccessible');
      }
      let selected = expectedElement;
      if (selected !== null) {
        if (typeof selected.getRootNode !== 'function' || selected.getRootNode() !== selected.ownerDocument) {
          return failure('shadow-root');
        }
      }
      const scope = selected?.ownerDocument ?? globalThis.document;
      const matches = scope.querySelectorAll(candidate.selector);
      if (!matches || matches.length !== 1 || (selected !== null && matches[0] !== selected)) {
        if (selected !== null) return failure('ambiguous');
        continue;
      }
      selected = matches[0];
      if (typeof selected.getRootNode !== 'function' || selected.getRootNode() !== scope) {
        if (expectedElement !== null) return failure('shadow-root');
        continue;
      }
      entries.push({ occurrenceId: candidate.occurrenceId, structuralInput: await structuralInput(selected) });
    }
    return { version: 1, entries, reason: null };
  } catch {
    return failure('inaccessible');
  }
}

function structuralInputRecord(value) {
  const record = exactHighlightRecord(value, ['version', 'tag', 'computedRole', 'ancestry']);
  const ancestry = record && denseHighlightArray(record.ancestry, 16);
  if (!record || record.version !== 'StructuralSignatureInputV1' ||
    typeof record.tag !== 'string' || !/^[a-z][a-z0-9-]{0,62}$/u.test(record.tag) ||
    (record.computedRole !== null && (typeof record.computedRole !== 'string' || record.computedRole.length > 32)) ||
    !ancestry || ancestry.length < 1) return null;
  const canonicalAncestry = [];
  for (const rawEntry of ancestry) {
    const entry = exactHighlightRecord(rawEntry, ['tag', 'nthOfType', 'attributes']);
    const attributes = entry && denseHighlightArray(entry.attributes, 2);
    if (!entry || typeof entry.tag !== 'string' || !/^[a-z][a-z0-9-]{0,62}$/u.test(entry.tag) ||
      !Number.isSafeInteger(entry.nthOfType) || entry.nthOfType < 1 || entry.nthOfType > 10_000 || !attributes) return null;
    const canonicalAttributes = [];
    const names = new Set();
    for (const rawAttribute of attributes) {
      const attribute = exactHighlightRecord(rawAttribute, ['name', 'valueSha256']);
      if (!attribute || !['role', 'type'].includes(attribute.name) || names.has(attribute.name) ||
        typeof attribute.valueSha256 !== 'string' || !HIGHLIGHT_SHA256.test(attribute.valueSha256)) return null;
      names.add(attribute.name);
      canonicalAttributes.push(Object.freeze({ name: attribute.name, valueSha256: attribute.valueSha256 }));
    }
    canonicalAncestry.push(Object.freeze({
      tag: entry.tag,
      nthOfType: entry.nthOfType,
      attributes: Object.freeze(canonicalAttributes),
    }));
  }
  return Object.freeze({
    version: 'StructuralSignatureInputV1',
    tag: record.tag,
    computedRole: record.computedRole,
    ancestry: Object.freeze(canonicalAncestry),
  });
}

function structuralProofResult(value) {
  const record = exactHighlightRecord(value, ['version', 'entries', 'reason']);
  const entries = record && denseHighlightArray(record.entries, MAX_HIGHLIGHT_TARGETS);
  if (!record || record.version !== 1 || !entries ||
    (record.reason !== null && !['ambiguous', 'inaccessible', 'shadow-root'].includes(record.reason))) return null;
  const canonicalEntries = [];
  const occurrenceIds = new Set();
  for (const rawEntry of entries) {
    const entry = exactHighlightRecord(rawEntry, ['occurrenceId', 'structuralInput']);
    const structuralInput = entry && structuralInputRecord(entry.structuralInput);
    if (!entry || !validHighlightId(entry.occurrenceId) || occurrenceIds.has(entry.occurrenceId) || !structuralInput) return null;
    occurrenceIds.add(entry.occurrenceId);
    canonicalEntries.push(Object.freeze({ occurrenceId: entry.occurrenceId, structuralInput }));
  }
  return Object.freeze({ version: 1, entries: Object.freeze(canonicalEntries), reason: record.reason });
}

async function structuralSignatureForProof(documentId, frameId, input) {
  const value = {
    version: 'StructuralSignatureInputV1',
    documentId,
    frameId,
    tag: input.tag,
    computedRole: input.computedRole,
    ancestry: input.ancestry,
  };
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonicalStringify(value)),
  );
  const bytes = new Uint8Array(digest);
  if (bytes.byteLength !== 32) throw new TypeError('HIGHLIGHT_PROOF_FAILED');
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function frozenHighlightFailure(reason) {
  return Object.freeze({ ok: false, reason });
}

function compositionDenied() {
  return new PrimordialTypeError('AUDIT_ADAPTER_COMPOSITION_DENIED');
}

function adapterOptionsDenied() {
  return new PrimordialTypeError('AUDIT_ADAPTER_OPTIONS_DENIED');
}

function attachedCopySourceUnavailable() {
  return new Error('ATTACHED_COPY_SOURCE_UNAVAILABLE');
}

function attachedCopyExpectedTarget(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = ObjectGetPrototypeOf(value);
    if (prototype !== ObjectPrototype && prototype !== null) return null;
    const keys = ReflectOwnKeys(value);
    if (keys.length !== ATTACHED_COPY_TARGET_KEYS.length ||
      keys.some(key => typeof key !== 'string' || !ATTACHED_COPY_TARGET_KEYS.includes(key))) return null;
    const output = ObjectCreate(null);
    for (let index = 0; index < ATTACHED_COPY_TARGET_KEYS.length; index += 1) {
      const key = ATTACHED_COPY_TARGET_KEYS[index];
      const descriptor = ObjectGetOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !ObjectHasOwn(descriptor, 'value')) return null;
      output[key] = descriptor.value;
    }
    if (!Number.isSafeInteger(output.tabId) || output.tabId < 0 ||
      !Number.isSafeInteger(output.windowId) || output.windowId < 0 ||
      typeof output.documentId !== 'string' || !HIGHLIGHT_DOCUMENT_ID.test(output.documentId) ||
      typeof output.urlSessionDigest !== 'string' ||
      !/^hmac-sha256:[A-Za-z0-9_-]{43}$/u.test(output.urlSessionDigest)) return null;
    return ObjectFreeze(output);
  } catch {
    return null;
  }
}

function isAdapterOptionName(key) {
  return key === 'sessionUrlDigestManager' || key === 'capturePolicy' ||
    key === 'onExecutionCheckpoint' || key === 'persistAuditModel';
}

function captureDigestManager(value) {
  if (!value || typeof value !== 'object') throw adapterOptionsDenied();
  const prototype = ObjectGetPrototypeOf(value);
  if (prototype !== ObjectPrototype && prototype !== null) throw adapterOptionsDenied();
  const keys = ReflectOwnKeys(value);
  if (keys.length < 1 || keys.length > 2) throw adapterOptionsDenied();
  let digest = null;
  let destroy = null;
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (key !== 'digest' && key !== 'destroy') throw adapterOptionsDenied();
    const descriptor = ObjectGetOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || descriptor.configurable || descriptor.writable ||
      !ObjectHasOwn(descriptor, 'value') || typeof descriptor.value !== 'function') {
      throw adapterOptionsDenied();
    }
    if (key === 'digest') digest = descriptor.value;
    else destroy = descriptor.value;
  }
  if (ObjectIsExtensible(value)) throw adapterOptionsDenied();
  if (digest === null) throw adapterOptionsDenied();
  const captured = ObjectCreate(null);
  defineDataProperty(
    captured,
    'digest',
    ReflectApply(FunctionPrototypeBind, digest, [captured]),
    true,
    false,
    false,
  );
  if (destroy !== null) {
    defineDataProperty(
      captured,
      'destroy',
      ReflectApply(FunctionPrototypeBind, destroy, [captured]),
      true,
      false,
      false,
    );
  }
  return ObjectFreeze(captured);
}

function isCapturePolicyKey(key) {
  return key === 'version' || key === 'mode' || key === 'includeQuery' ||
    key === 'captureFullPage' || key === 'captureElements' || key === 'composeAnnouncementMap';
}

function isCanonicalCapturePolicy(value) {
  if (value.version !== 'CapturePolicyV1' || typeof value.includeQuery !== 'boolean') return false;
  let captureFullPage;
  let captureElements;
  let composeAnnouncementMap;
  if (value.mode === 'full-evidence') {
    captureFullPage = true;
    captureElements = true;
    composeAnnouncementMap = true;
  } else if (value.mode === 'element-only') {
    captureFullPage = false;
    captureElements = true;
    composeAnnouncementMap = false;
  } else if (value.mode === 'no-pixels') {
    captureFullPage = false;
    captureElements = false;
    composeAnnouncementMap = false;
  } else return false;
  return value.captureFullPage === captureFullPage && value.captureElements === captureElements &&
    value.composeAnnouncementMap === composeAnnouncementMap;
}

function capturePolicySnapshot(value) {
  if (!value || typeof value !== 'object') throw adapterOptionsDenied();
  const prototype = ObjectGetPrototypeOf(value);
  if (prototype !== ObjectPrototype && prototype !== null) throw adapterOptionsDenied();
  const keys = ReflectOwnKeys(value);
  if (keys.length !== CAPTURE_POLICY_KEYS.length) throw adapterOptionsDenied();
  for (let index = 0; index < keys.length; index += 1) {
    if (typeof keys[index] !== 'string' || !isCapturePolicyKey(keys[index])) throw adapterOptionsDenied();
  }
  if (ObjectIsExtensible(value)) throw adapterOptionsDenied();
  const snapshot = ObjectCreate(null);
  for (let index = 0; index < CAPTURE_POLICY_KEYS.length; index += 1) {
    const key = CAPTURE_POLICY_KEYS[index];
    const descriptor = ObjectGetOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || descriptor.configurable || descriptor.writable ||
      !ObjectHasOwn(descriptor, 'value')) throw adapterOptionsDenied();
    defineDataProperty(snapshot, key, descriptor.value, true, false, false);
  }
  ObjectFreeze(snapshot);
  if (!isCanonicalCapturePolicy(snapshot)) throw adapterOptionsDenied();
  return snapshot;
}

function captureAdapterOptionValue(key, value) {
  if (key === 'sessionUrlDigestManager') return captureDigestManager(value);
  if (key === 'capturePolicy') return capturePolicySnapshot(value);
  if (typeof value !== 'function') throw adapterOptionsDenied();
  return value;
}

function captureAdapterOptions(value) {
  try {
    if (!value || typeof value !== 'object') throw adapterOptionsDenied();
    const prototype = ObjectGetPrototypeOf(value);
    if (prototype !== ObjectPrototype && prototype !== null) throw adapterOptionsDenied();
    const keys = ReflectOwnKeys(value);
    let hasCapturePolicy = false;
    let hasSessionUrlDigestManager = false;
    let hasOnExecutionCheckpoint = false;
    let hasPersistAuditModel = false;
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      if (typeof key !== 'string' || !isAdapterOptionName(key)) throw adapterOptionsDenied();
      if (key === 'capturePolicy') hasCapturePolicy = true;
      else if (key === 'sessionUrlDigestManager') hasSessionUrlDigestManager = true;
      else if (key === 'onExecutionCheckpoint') hasOnExecutionCheckpoint = true;
      else hasPersistAuditModel = true;
    }
    const rawValues = ObjectCreate(null);
    if (hasCapturePolicy) {
      const descriptor = ObjectGetOwnPropertyDescriptor(value, 'capturePolicy');
      if (!descriptor?.enumerable || !ObjectHasOwn(descriptor, 'value')) throw adapterOptionsDenied();
      rawValues.capturePolicy = descriptor.value;
    }
    if (hasSessionUrlDigestManager) {
      const descriptor = ObjectGetOwnPropertyDescriptor(value, 'sessionUrlDigestManager');
      if (!descriptor?.enumerable || !ObjectHasOwn(descriptor, 'value')) throw adapterOptionsDenied();
      rawValues.sessionUrlDigestManager = descriptor.value;
    }
    if (hasOnExecutionCheckpoint) {
      const descriptor = ObjectGetOwnPropertyDescriptor(value, 'onExecutionCheckpoint');
      if (!descriptor?.enumerable || !ObjectHasOwn(descriptor, 'value')) throw adapterOptionsDenied();
      rawValues.onExecutionCheckpoint = descriptor.value;
    }
    if (hasPersistAuditModel) {
      const descriptor = ObjectGetOwnPropertyDescriptor(value, 'persistAuditModel');
      if (!descriptor?.enumerable || !ObjectHasOwn(descriptor, 'value')) throw adapterOptionsDenied();
      rawValues.persistAuditModel = descriptor.value;
    }

    const captured = ObjectCreate(null);
    if (hasSessionUrlDigestManager) {
      captured.sessionUrlDigestManager = captureAdapterOptionValue(
        'sessionUrlDigestManager',
        rawValues.sessionUrlDigestManager,
      );
    }
    if (hasCapturePolicy) {
      captured.capturePolicy = captureAdapterOptionValue('capturePolicy', rawValues.capturePolicy);
    }
    if (hasOnExecutionCheckpoint) {
      captured.onExecutionCheckpoint = captureAdapterOptionValue(
        'onExecutionCheckpoint',
        rawValues.onExecutionCheckpoint,
      );
    }
    if (hasPersistAuditModel) {
      captured.persistAuditModel = captureAdapterOptionValue(
        'persistAuditModel',
        rawValues.persistAuditModel,
      );
    }
    return captured;
  } catch {
    throw adapterOptionsDenied();
  }
}

function chromeApiDenied() {
  return new PrimordialTypeError('As APIs Chrome de auditoria não estão disponíveis.');
}

function ownChromeApiValue(value, key) {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) throw chromeApiDenied();
  const descriptor = ObjectGetOwnPropertyDescriptor(value, key);
  if (!descriptor || !ObjectHasOwn(descriptor, 'value')) throw chromeApiDenied();
  return descriptor.value;
}

function sameChromeDescriptor(left, right) {
  if (!left || !right) return left === right;
  const leftData = ObjectHasOwn(left, 'value');
  if (leftData !== ObjectHasOwn(right, 'value') || left.enumerable !== right.enumerable ||
    left.configurable !== right.configurable) return false;
  if (leftData) return left.value === right.value && left.writable === right.writable;
  return left.get === right.get && left.set === right.set;
}

function captureChromeSessionArea(value) {
  const set = ownChromeApiValue(value, 'set');
  const remove = ownChromeApiValue(value, 'remove');
  const get = ownChromeApiValue(value, 'get');
  const confirmedSet = ownChromeApiValue(value, 'set');
  const confirmedRemove = ownChromeApiValue(value, 'remove');
  const confirmedGet = ownChromeApiValue(value, 'get');
  if (set !== confirmedSet || remove !== confirmedRemove || get !== confirmedGet) throw chromeApiDenied();
  if (typeof get !== 'function' || typeof set !== 'function' || typeof remove !== 'function') {
    throw chromeApiDenied();
  }
  const assertStable = () => {
    const liveGet = ownChromeApiValue(value, 'get');
    const liveSet = ownChromeApiValue(value, 'set');
    const liveRemove = ownChromeApiValue(value, 'remove');
    if (liveGet !== get || liveSet !== set || liveRemove !== remove) throw chromeApiDenied();
  };
  const invokeSession = (method, argument) => {
    assertStable();
    return ReflectApply(method, value, [argument]);
  };
  const captured = ObjectCreate(null);
  defineDataProperty(captured, 'get', argument => invokeSession(get, argument), true, false, false);
  defineDataProperty(captured, 'set', argument => invokeSession(set, argument), true, false, false);
  defineDataProperty(captured, 'remove', argument => invokeSession(remove, argument), true, false, false);
  return ObjectFreeze(captured);
}

function captureChromeEvent(value) {
  const removeListener = ownChromeApiValue(value, 'removeListener');
  const addListener = ownChromeApiValue(value, 'addListener');
  const confirmedRemoveListener = ownChromeApiValue(value, 'removeListener');
  const confirmedAddListener = ownChromeApiValue(value, 'addListener');
  if (removeListener !== confirmedRemoveListener || addListener !== confirmedAddListener) throw chromeApiDenied();
  if (typeof addListener !== 'function' || typeof removeListener !== 'function') throw chromeApiDenied();
  const assertStable = () => {
    const liveAddListener = ownChromeApiValue(value, 'addListener');
    const liveRemoveListener = ownChromeApiValue(value, 'removeListener');
    if (liveAddListener !== addListener || liveRemoveListener !== removeListener) throw chromeApiDenied();
  };
  const invokeEvent = (method, listener) => {
    assertStable();
    return ReflectApply(method, value, [listener]);
  };
  const captured = ObjectCreate(null);
  defineDataProperty(
    captured,
    'addListener',
    listener => invokeEvent(addListener, listener),
    true,
    false,
    false,
  );
  defineDataProperty(
    captured,
    'removeListener',
    listener => invokeEvent(removeListener, listener),
    true,
    false,
    false,
  );
  return ObjectFreeze(captured);
}

function captureChromeTabs(value) {
  const update = ownChromeApiValue(value, 'update');
  const get = ownChromeApiValue(value, 'get');
  const remove = ownChromeApiValue(value, 'remove');
  const onUpdated = ownChromeApiValue(value, 'onUpdated');
  const onRemoved = ownChromeApiValue(value, 'onRemoved');
  const create = ownChromeApiValue(value, 'create');
  const confirmedUpdate = ownChromeApiValue(value, 'update');
  const confirmedGet = ownChromeApiValue(value, 'get');
  const confirmedRemove = ownChromeApiValue(value, 'remove');
  const confirmedOnUpdated = ownChromeApiValue(value, 'onUpdated');
  const confirmedOnRemoved = ownChromeApiValue(value, 'onRemoved');
  const confirmedCreate = ownChromeApiValue(value, 'create');
  if (update !== confirmedUpdate || get !== confirmedGet || remove !== confirmedRemove ||
    onUpdated !== confirmedOnUpdated || onRemoved !== confirmedOnRemoved || create !== confirmedCreate) {
    throw chromeApiDenied();
  }
  if (typeof create !== 'function' || typeof update !== 'function' ||
    typeof get !== 'function' || typeof remove !== 'function') throw chromeApiDenied();
  const captured = ObjectCreate(null);
  defineDataProperty(captured, 'create', ReflectApply(FunctionPrototypeBind, create, [captured]), true, false, false);
  defineDataProperty(captured, 'update', ReflectApply(FunctionPrototypeBind, update, [captured]), true, false, false);
  defineDataProperty(captured, 'get', ReflectApply(FunctionPrototypeBind, get, [captured]), true, false, false);
  defineDataProperty(captured, 'remove', ReflectApply(FunctionPrototypeBind, remove, [captured]), true, false, false);
  defineDataProperty(captured, 'onUpdated', captureChromeEvent(onUpdated), true, false, false);
  defineDataProperty(captured, 'onRemoved', captureChromeEvent(onRemoved), true, false, false);
  return ObjectFreeze(captured);
}

function captureChromeScripting(value) {
  const executeScript = ownChromeApiValue(value, 'executeScript');
  const confirmedExecuteScript = ownChromeApiValue(value, 'executeScript');
  if (executeScript !== confirmedExecuteScript || typeof executeScript !== 'function') throw chromeApiDenied();
  const captured = ObjectCreate(null);
  defineDataProperty(
    captured,
    'executeScript',
    ReflectApply(FunctionPrototypeBind, executeScript, [captured]),
    true,
    false,
    false,
  );
  return ObjectFreeze(captured);
}

function captureChromeDebugger(value) {
  const sendCommand = ownChromeApiValue(value, 'sendCommand');
  const detach = ownChromeApiValue(value, 'detach');
  const attach = ownChromeApiValue(value, 'attach');
  const confirmedSendCommand = ownChromeApiValue(value, 'sendCommand');
  const confirmedDetach = ownChromeApiValue(value, 'detach');
  const confirmedAttach = ownChromeApiValue(value, 'attach');
  if (sendCommand !== confirmedSendCommand || detach !== confirmedDetach || attach !== confirmedAttach) {
    throw chromeApiDenied();
  }
  if (typeof attach !== 'function' || typeof sendCommand !== 'function' || typeof detach !== 'function') {
    throw chromeApiDenied();
  }
  const captured = ObjectCreate(null);
  defineDataProperty(captured, 'attach', ReflectApply(FunctionPrototypeBind, attach, [captured]), true, false, false);
  defineDataProperty(
    captured,
    'sendCommand',
    ReflectApply(FunctionPrototypeBind, sendCommand, [captured]),
    true,
    false,
    false,
  );
  defineDataProperty(captured, 'detach', ReflectApply(FunctionPrototypeBind, detach, [captured]), true, false, false);
  return ObjectFreeze(captured);
}

function captureChromeRuntime(value) {
  const sendMessage = ownChromeApiValue(value, 'sendMessage');
  const lastError = ObjectGetOwnPropertyDescriptor(value, 'lastError');
  const getURL = ownChromeApiValue(value, 'getURL');
  const confirmedSendMessage = ownChromeApiValue(value, 'sendMessage');
  const confirmedLastError = ObjectGetOwnPropertyDescriptor(value, 'lastError');
  const confirmedGetURL = ownChromeApiValue(value, 'getURL');
  if (sendMessage !== confirmedSendMessage || getURL !== confirmedGetURL ||
    !sameChromeDescriptor(lastError, confirmedLastError) ||
    typeof getURL !== 'function' || typeof sendMessage !== 'function') throw chromeApiDenied();
  const captured = ObjectCreate(null);
  let manifestVersion = 'não disponível';
  const getManifest = ObjectGetOwnPropertyDescriptor(value, 'getManifest')?.value;
  if (typeof getManifest === 'function') {
    const manifest = ReflectApply(getManifest, value, []);
    const version = manifest && ObjectGetOwnPropertyDescriptor(manifest, 'version')?.value;
    if (typeof version === 'string' && /^\d{1,5}(?:\.\d{1,5}){0,3}$/u.test(version)) manifestVersion = version;
  }
  defineDataProperty(captured, 'manifestVersion', manifestVersion, true, false, false);
  defineDataProperty(captured, 'getURL', ReflectApply(FunctionPrototypeBind, getURL, [captured]), true, false, false);
  defineDataProperty(
    captured,
    'sendMessage',
    ReflectApply(FunctionPrototypeBind, sendMessage, [captured]),
    true,
    false,
    false,
  );
  if (lastError && ObjectHasOwn(lastError, 'value')) {
    defineDataProperty(captured, 'lastError', lastError.value, true, false, false);
  } else if (lastError) {
    if (typeof lastError.get !== 'function') throw chromeApiDenied();
    defineGetterProperty(
      captured,
      'lastError',
      ReflectApply(FunctionPrototypeBind, lastError.get, [captured]),
      true,
      false,
    );
  }
  return ObjectFreeze(captured);
}

function captureChromeApi(value) {
  try {
    const storageApi = ownChromeApiValue(value, 'storage');
    const session = ownChromeApiValue(storageApi, 'session');
    const tabsApi = ownChromeApiValue(value, 'tabs');
    const scriptingApi = ownChromeApiValue(value, 'scripting');
    const rawDebuggerApi = ownChromeApiValue(value, 'debugger');
    const runtimeApi = ownChromeApiValue(value, 'runtime');

    const sessionArea = captureChromeSessionArea(session);
    const tabs = captureChromeTabs(tabsApi);
    const scripting = captureChromeScripting(scriptingApi);
    const debuggerApi = captureChromeDebugger(rawDebuggerApi);
    const runtime = captureChromeRuntime(runtimeApi);

    const storage = ObjectCreate(null);
    defineDataProperty(storage, 'session', sessionArea, true, false, false);
    ObjectFreeze(storage);
    const captured = ObjectCreate(null);
    defineDataProperty(captured, 'tabs', tabs, true, false, false);
    defineDataProperty(captured, 'scripting', scripting, true, false, false);
    defineDataProperty(captured, 'debugger', debuggerApi, true, false, false);
    defineDataProperty(captured, 'runtime', runtime, true, false, false);
    defineDataProperty(captured, 'storage', storage, true, false, false);
    return ObjectFreeze(captured);
  } catch {
    throw chromeApiDenied();
  }
}

/**
 * Closes the browser-supplied Chrome graph at trusted extension bootstrap.
 * The input is an environmental root of trust, not an untrusted value to validate.
 */
export function createChromeAuditAuthority(chromeApi) {
  if (arguments.length !== 1) throw chromeApiDenied();
  const authority = captureChromeApi(chromeApi);
  ReflectApply(WeakSetPrototypeAdd, ChromeAuditAuthorities, [authority]);
  return authority;
}

function requireChromeAuditAuthority(value) {
  try {
    if ((!value || (typeof value !== 'object' && typeof value !== 'function')) ||
      ReflectApply(WeakSetPrototypeHas, ChromeAuditAuthorities, [value]) !== true) {
      throw chromeApiDenied();
    }
    return value;
  } catch {
    throw chromeApiDenied();
  }
}

function isWorkerOverrideName(name) {
  return name === 'enterFinalization'
    || name === 'tryEnterFinalization'
    || name === 'handoffReport'
    || name === 'emitProgress';
}

function defineDataProperty(target, key, value, enumerable, configurable, writable) {
  const descriptor = ObjectCreate(null);
  descriptor.value = value;
  descriptor.enumerable = enumerable;
  descriptor.configurable = configurable;
  descriptor.writable = writable;
  ObjectDefineProperty(target, key, descriptor);
}

function defineGetterProperty(target, key, get, enumerable, configurable) {
  const descriptor = ObjectCreate(null);
  descriptor.get = get;
  descriptor.enumerable = enumerable;
  descriptor.configurable = configurable;
  ObjectDefineProperty(target, key, descriptor);
}

/** Copies a trusted adapter while preserving its single opaque execution contract. */
export function composeChromeAdapter(base, overrides) {
  if (arguments.length !== 2) throw compositionDenied();
  if (!base || typeof base !== 'object' || !overrides || typeof overrides !== 'object') throw compositionDenied();
  let baseNames;
  let baseValues;
  let baseCount = 0;
  let internalValue;
  try {
    const baseKeys = ReflectOwnKeys(base);
    const internal = ObjectGetOwnPropertyDescriptor(base, AUDIT_EXECUTION_INTERNAL);
    if (!internal || internal.enumerable || !ObjectHasOwn(internal, 'value')) {
      throw compositionDenied();
    }
    internalValue = internal.value;
    baseNames = ObjectCreate(null);
    baseValues = ObjectCreate(null);
    for (let index = 0; index < baseKeys.length; index += 1) {
      const key = baseKeys[index];
      if (key === AUDIT_EXECUTION_INTERNAL) continue;
      if (typeof key !== 'string') throw compositionDenied();
      const descriptor = ObjectGetOwnPropertyDescriptor(base, key);
      if (!descriptor?.enumerable || !ObjectHasOwn(descriptor, 'value')) throw compositionDenied();
      baseNames[baseCount] = key;
      baseValues[baseCount] = descriptor.value;
      baseCount += 1;
    }
  } catch { throw compositionDenied(); }
  let overrideNames;
  let overrideValues;
  let overrideCount = 0;
  try {
    const prototype = ObjectGetPrototypeOf(overrides);
    if (prototype !== ObjectPrototype && prototype !== null) throw compositionDenied();
    const overrideKeys = ReflectOwnKeys(overrides);
    overrideNames = ObjectCreate(null);
    overrideValues = ObjectCreate(null);
    for (let index = 0; index < overrideKeys.length; index += 1) {
      const key = overrideKeys[index];
      if (typeof key !== 'string' || !isWorkerOverrideName(key)) throw compositionDenied();
      const descriptor = ObjectGetOwnPropertyDescriptor(overrides, key);
      if (!descriptor?.enumerable || !ObjectHasOwn(descriptor, 'value') || typeof descriptor.value !== 'function') {
        throw compositionDenied();
      }
      overrideNames[overrideCount] = key;
      overrideValues[overrideCount] = descriptor.value;
      overrideCount += 1;
    }
  } catch { throw compositionDenied(); }
  try {
    const composed = ObjectCreate(null);
    for (let index = 0; index < baseCount; index += 1) {
      defineDataProperty(composed, baseNames[index], baseValues[index], true, true, true);
    }
    for (let index = 0; index < overrideCount; index += 1) {
      defineDataProperty(composed, overrideNames[index], overrideValues[index], true, true, true);
    }
    defineDataProperty(composed, AUDIT_EXECUTION_INTERNAL, internalValue, false, false, false);
    ObjectPreventExtensions(composed);
    return ObjectFreeze(composed);
  } catch {
    throw compositionDenied();
  }
}

function timeoutError() {
  return new DOMException('A página não ficou estável dentro do tempo limite.', 'TimeoutError');
}

function abortError(signal) {
  return signal?.reason || new DOMException('Operação cancelada.', 'AbortError');
}

function invoke(chromeApi, owner, method, ...args) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (handler, value) => {
      if (settled) return;
      settled = true;
      handler(value);
    };
    const callback = value => {
      const error = chromeApi.runtime?.lastError;
      if (error) finish(reject, new Error(error.message || `Falha em chrome.${method}.`));
      else finish(resolve, value);
    };
    try {
      const result = owner[method](...args, callback);
      if (result && typeof result.then === 'function') result.then(value => finish(resolve, value), error => finish(reject, error));
    } catch (error) {
      finish(reject, error);
    }
  });
}

function firstResult(results) {
  return Array.isArray(results) ? results.find(entry => !entry?.error)?.result : undefined;
}

export function captureFocusLocator(root = globalThis.document) {
  const active = root?.activeElement;
  if (!active || typeof active.localName !== 'string') return '';
  if (active.id) {
    const escape = globalThis.CSS?.escape || (value => String(value).replace(/[^A-Za-z0-9_-]/gu, character => `\\${character}`));
    return `#${escape(active.id)}`;
  }
  const parts = [];
  let current = active;
  while (current && current !== root.documentElement && typeof current.localName === 'string') {
    const siblings = Array.from(current.parentElement?.children || []).filter(element => element.localName === current.localName);
    const position = Math.max(0, siblings.indexOf(current)) + 1;
    parts.unshift(`${current.localName}:nth-of-type(${position})`);
    current = current.parentElement;
  }
  return parts.join(' > ');
}

export function restoreFocusLocator(locator, root = globalThis.document) {
  if (typeof locator === 'string' && locator) {
    const target = root?.querySelector?.(locator);
    if (target && typeof target.focus === 'function') {
      target.focus();
      return true;
    }
  }
  if (typeof root?.activeElement?.blur === 'function') root.activeElement.blur();
  return false;
}

export async function resolveActiveNodeId(cdp) {
  const remote = await cdp.command('Runtime.evaluate', {
    expression: 'document.activeElement',
    objectGroup: 'audita-mt-probe',
    returnByValue: false,
  });
  const objectId = remote?.result?.objectId;
  if (typeof objectId !== 'string' || !objectId) return null;
  try {
    const requested = await cdp.command('DOM.requestNode', { objectId });
    if (!Number.isSafeInteger(requested?.nodeId)) return null;
    const described = await cdp.command('DOM.describeNode', { nodeId: requested.nodeId, depth: 0, pierce: true });
    return Number.isSafeInteger(described?.node?.backendNodeId) ? `n-${described.node.backendNodeId}` : null;
  } finally {
    try { await cdp.command('Runtime.releaseObject', { objectId }); } catch { /* Best-effort remote handle cleanup. */ }
  }
}

export function createChromeAdapter(chromeAuthority, rawOptions = {}) {
  const chromeApi = requireChromeAuditAuthority(chromeAuthority);
  const options = captureAdapterOptions(rawOptions);
  const executeScript = options => invoke(chromeApi, chromeApi.scripting, 'executeScript', options);
  const transport = createChromeDebuggerTransport(chromeApi);
  const sessionUrlDigestManager = options.sessionUrlDigestManager;

  const createProbeAdapter = (tabId, cdp) => {
    const executeOne = async (func, args = []) => firstResult(await executeScript({
      target: { tabId, frameIds: [0] }, world: 'ISOLATED', func, args,
    }));
    return {
      async snapshotState() {
        const metrics = await cdp.command('Page.getLayoutMetrics', {});
        const dom = await executeOne(() => ({
          scroll: { x: scrollX, y: scrollY },
          styles: true,
          viewport: { deviceScaleFactor: devicePixelRatio },
        }));
        const focus = await executeOne(captureFocusLocator);
        const viewport = metrics?.cssLayoutViewport || {};
        return { ...dom, focus, viewport: { width: viewport.clientWidth, height: viewport.clientHeight, deviceScaleFactor: dom?.viewport?.deviceScaleFactor ?? 1 } };
      },
      installNavigationGuards: () => executeOne(() => {
        const key = '__auditaMtNavigationGuard';
        if (globalThis[key]) return true;
        const block = event => { event.preventDefault(); event.stopImmediatePropagation(); };
        document.addEventListener('submit', block, true);
        document.addEventListener('click', block, true);
        globalThis[key] = block;
        return true;
      }),
      removeNavigationGuards: () => executeOne(() => {
        const key = '__auditaMtNavigationGuard';
        const block = globalThis[key];
        if (block) {
          document.removeEventListener('submit', block, true);
          document.removeEventListener('click', block, true);
          delete globalThis[key];
        }
        return true;
      }),
      getFocusableCount: () => executeOne(() => document.querySelectorAll('a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])').length),
      async pressTab() {
        const before = await executeOne(() => {
          const active = document.activeElement;
          return active instanceof Element ? { beforeCss: { outline: getComputedStyle(active).outline } } : {};
        });
        await cdp.command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
        await cdp.command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
        const observation = await executeOne(previous => {
          const active = document.activeElement;
          if (!(active instanceof Element)) return previous;
          const rect = active.getBoundingClientRect();
          const css = getComputedStyle(active);
          return {
            ...previous, afterCss: { outline: css.outline },
            indicatorVisible: css.outlineStyle !== 'none' || css.boxShadow !== 'none',
            areaSufficient: rect.width * rect.height >= 4,
            intersectionRatio: rect.top >= 0 && rect.left >= 0 && rect.bottom <= innerHeight && rect.right <= innerWidth ? 1 : 0,
            rect: { x: rect.x + scrollX, y: rect.y + scrollY, width: rect.width, height: rect.height },
          };
        }, [before]);
        return { ...observation, nodeId: await resolveActiveNodeId(cdp) };
      },
      async measureReflow(width) {
        await cdp.command('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: false });
        return executeOne(testedWidthCssPx => ({ testedWidthCssPx, horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth, exception: 'unknown' }), [width]);
      },
      async measureTextResize(scalePercent) {
        return executeOne(percent => {
          const id = '__audita-mt-text-resize';
          document.getElementById(id)?.remove();
          const style = document.createElement('style');
          style.id = id;
          style.textContent = `html{font-size:${percent}% !important}`;
          document.documentElement.append(style);
          return { scalePercent: percent, lossOfContent: document.documentElement.scrollWidth > document.documentElement.clientWidth };
        }, [scalePercent]);
      },
      async measureTargetSizes() {
        const [frameTree, observations] = await Promise.all([
          cdp.command('Page.getFrameTree', {}),
          executeOne(() => {
            const selector = element => {
              if (element.id) return `#${CSS.escape(element.id)}`;
              const parts = [];
              let current = element;
              while (current instanceof Element && parts.length < 12) {
                let part = current.localName;
                const siblings = [...(current.parentElement?.children || [])].filter(item => item.localName === current.localName);
                if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
                parts.unshift(part);
                current = current.parentElement;
              }
              return parts.join(' > ');
            };
            return [...document.querySelectorAll('a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])')].map(element => {
              const rect = element.getBoundingClientRect();
              return { selector: selector(element), width: rect.width, height: rect.height, exception: 'unknown' };
            });
          })
        ]);
        const frameId = typeof frameTree?.frameTree?.frame?.id === 'string' ? frameTree.frameTree.frame.id : '';
        if (!Array.isArray(observations)) return [];
        let documentNodeId = null;
        try {
          const documentNode = await cdp.command('DOM.getDocument', { depth: 0, pierce: true });
          documentNodeId = Number.isSafeInteger(documentNode?.root?.nodeId) ? documentNode.root.nodeId : null;
        } catch { /* Selector+frame remains the conservative fallback. */ }
        const backendBySelector = new Map();
        const backendNodeId = async selector => {
          if (!documentNodeId || typeof selector !== 'string' || !selector) return null;
          if (!backendBySelector.has(selector)) backendBySelector.set(selector, (async () => {
            try {
              const selected = await cdp.command('DOM.querySelectorAll', { nodeId: documentNodeId, selector });
              if (!Array.isArray(selected?.nodeIds) || selected.nodeIds.length !== 1 || !Number.isSafeInteger(selected.nodeIds[0])) return null;
              const described = await cdp.command('DOM.describeNode', { nodeId: selected.nodeIds[0], depth: 0, pierce: true });
              return Number.isSafeInteger(described?.node?.backendNodeId) ? described.node.backendNodeId : null;
            } catch { return null; }
          })());
          return backendBySelector.get(selector);
        };
        return Promise.all(observations.map(async item => {
          const backendNodeIdValue = await backendNodeId(item.selector);
          return {
            ...item,
            ...(frameId ? { frameId } : {}),
            ...(backendNodeIdValue !== null ? { backendNodeId: backendNodeIdValue } : {})
          };
        }));
      },
      async measureMotion(options) {
        await cdp.command('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
        return executeOne(preference => {
          const animations = document.getAnimations?.() || [];
          return { complete: true, preference, prefersReducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches, animatedCount: animations.length, reducedAnimatedCount: animations.filter(animation => animation.playState === 'running').length };
        }, [options.preference]);
      },
      async restoreStyles() {
        await executeOne(() => { document.getElementById('__audita-mt-text-resize')?.remove(); return true; });
        await cdp.command('Emulation.setEmulatedMedia', { features: [] });
      },
      restoreViewport: () => cdp.command('Emulation.clearDeviceMetricsOverride', {}),
      restoreScroll: value => executeOne(position => { scrollTo(position.x, position.y); return true; }, [value]),
      restoreFocus: value => executeOne(restoreFocusLocator, [value]),
    };
  };

  const probeHighlightTopDocument = async ({ tabId, windowId, topDocumentId }) => {
    try {
      const before = await invoke(chromeApi, chromeApi.tabs, 'get', tabId);
      const rawUrl = before?.url;
      if (before?.id !== tabId || before.windowId !== windowId || before.status !== 'complete' ||
        before.discarded !== false || typeof rawUrl !== 'string') return false;
      const parsed = new URL(rawUrl);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.href !== rawUrl) return false;
      const results = denseHighlightArray(await executeScript({
        target: { tabId, frameIds: [0] },
        world: 'ISOLATED',
        func: () => globalThis.location?.href,
      }), 1);
      if (!results || results.length !== 1) return false;
      const result = exactHighlightRecord(results[0], ['frameId', 'documentId', 'result']);
      if (!result || result.frameId !== 0 || result.documentId !== topDocumentId || result.result !== rawUrl) return false;
      const after = await invoke(chromeApi, chromeApi.tabs, 'get', tabId);
      return after?.id === tabId && after.windowId === windowId && after.status === 'complete' &&
        after.discarded === false && after.url === rawUrl;
    } catch {
      return false;
    }
  };

  const collectFrameHighlightProofs = async input => {
    const scriptCandidates = input.candidates.map(candidate => Object.freeze({
      occurrenceId: candidate.occurrenceId,
      selector: candidate.selector.value,
    }));
    let rawResults;
    try {
      rawResults = await executeScript({
        target: { tabId: input.tabId, allFrames: true },
        world: 'ISOLATED',
        func: collectHighlightStructuralProofs,
        args: [scriptCandidates],
      });
    } catch {
      return { ok: false, reason: 'inaccessible' };
    }
    const results = denseHighlightArray(rawResults, 1_000);
    if (!results) return { ok: false, reason: 'live-proof-failed' };
    const byOccurrence = new Map();
    const documents = new Set();
    for (const rawResult of results) {
      const result = exactHighlightRecord(rawResult, ['frameId', 'documentId', 'result']);
      if (!result || !validHighlightChromeId(result.frameId) || typeof result.documentId !== 'string' ||
        !HIGHLIGHT_DOCUMENT_ID.test(result.documentId)) return { ok: false, reason: 'live-proof-failed' };
      const documentKey = `${result.frameId}\u0000${result.documentId}`;
      if (documents.has(documentKey)) return { ok: false, reason: 'live-proof-failed' };
      documents.add(documentKey);
      const proof = structuralProofResult(result.result);
      if (!proof) return { ok: false, reason: 'live-proof-failed' };
      for (const entry of proof.entries) {
        const matches = byOccurrence.get(entry.occurrenceId) ?? [];
        matches.push(Object.freeze({
          documentId: result.documentId,
          frameId: result.frameId,
          structuralInput: entry.structuralInput,
        }));
        byOccurrence.set(entry.occurrenceId, matches);
      }
    }
    return { ok: true, byOccurrence };
  };

  const proveResolvedHighlightCandidate = async (cdp, candidate) => {
    let objectId = null;
    try {
      const resolved = await cdp.command('DOM.resolveNode', {
        backendNodeId: candidate.backendNodeId,
        objectGroup: 'audita-mt-highlight-proof',
      });
      objectId = resolved?.object?.objectId;
      if (typeof objectId !== 'string' || !objectId) return { ok: false, reason: 'inaccessible' };
      const functionDeclaration = `function(candidate){return (${collectHighlightStructuralProofs.toString()})([candidate],this);}`;
      const called = await cdp.command('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration,
        arguments: [{ value: { occurrenceId: candidate.occurrenceId, selector: candidate.selector.value } }],
        awaitPromise: true,
        returnByValue: true,
        objectGroup: 'audita-mt-highlight-proof',
      });
      if (called?.exceptionDetails !== undefined) return { ok: false, reason: 'inaccessible' };
      const proof = structuralProofResult(called?.result?.value);
      if (!proof) return { ok: false, reason: 'live-proof-failed' };
      if (proof.reason !== null) return { ok: false, reason: proof.reason };
      if (proof.entries.length !== 1 || proof.entries[0].occurrenceId !== candidate.occurrenceId) {
        return { ok: false, reason: 'ambiguous' };
      }
      return { ok: true, structuralInput: proof.entries[0].structuralInput };
    } catch {
      return { ok: false, reason: 'inaccessible' };
    } finally {
      if (objectId !== null) {
        try { await cdp.command('Runtime.releaseObject', { objectId }); } catch { /* detached below */ }
      }
    }
  };

  const proveHighlightTargetsCore = async input => {
    if (!await probeHighlightTopDocument(input)) {
      return { ok: false, reason: 'document-changed', proofs: [], failures: new Map() };
    }
    const cdp = createCdpClient(transport);
    let connected = false;
    let frameProofs;
    const resolvedByOccurrence = new Map();
    let globalReason = null;
    try {
      await cdp.connect(input.tabId);
      connected = true;
      frameProofs = await collectFrameHighlightProofs(input);
      if (!frameProofs.ok) globalReason = frameProofs.reason;
      if (globalReason === null) {
        for (const candidate of input.candidates) {
          resolvedByOccurrence.set(
            candidate.occurrenceId,
            await proveResolvedHighlightCandidate(cdp, candidate),
          );
        }
      }
    } catch {
      globalReason = 'inaccessible';
    } finally {
      if (connected) {
        try { await cdp.disconnect(); } catch { globalReason = 'inaccessible'; }
      }
    }
    if (!await probeHighlightTopDocument(input)) globalReason = 'document-changed';
    if (globalReason !== null) {
      return { ok: false, reason: globalReason, proofs: [], failures: new Map() };
    }

    const proofs = [];
    const failures = new Map();
    for (const candidate of input.candidates) {
      const resolved = resolvedByOccurrence.get(candidate.occurrenceId);
      if (!resolved?.ok) {
        failures.set(candidate.occurrenceId, resolved?.reason ?? 'live-proof-failed');
        continue;
      }
      const frames = frameProofs.byOccurrence.get(candidate.occurrenceId) ?? [];
      if (frames.length !== 1) {
        failures.set(candidate.occurrenceId, 'ambiguous');
        continue;
      }
      const frame = frames[0];
      if (canonicalStringify(frame.structuralInput) !== canonicalStringify(resolved.structuralInput)) {
        failures.set(candidate.occurrenceId, 'live-proof-failed');
        continue;
      }
      let sha256;
      try {
        sha256 = await structuralSignatureForProof(frame.documentId, frame.frameId, frame.structuralInput);
      } catch {
        failures.set(candidate.occurrenceId, 'live-proof-failed');
        continue;
      }
      proofs.push(Object.freeze({
        occurrenceId: candidate.occurrenceId,
        evidenceId: candidate.evidenceId,
        documentId: frame.documentId,
        frameId: frame.frameId,
        backendNodeId: candidate.backendNodeId,
        selector: candidate.selector,
        structuralSignature: Object.freeze({ version: 'StructuralSignatureV1', sha256 }),
        rectBucket: null,
      }));
    }
    return { ok: true, proofs: Object.freeze(proofs), failures };
  };

  const snapshotAttachedCopySource = async rawExpectedTarget => {
    const expected = attachedCopyExpectedTarget(rawExpectedTarget);
    if (!expected || typeof sessionUrlDigestManager?.digest !== 'function') {
      throw attachedCopySourceUnavailable();
    }
    try {
      const tab = await invoke(chromeApi, chromeApi.tabs, 'get', expected.tabId);
      if (tab?.id !== expected.tabId || tab.windowId !== expected.windowId ||
        tab.status !== 'complete' || typeof tab.url !== 'string') throw attachedCopySourceUnavailable();
      const parsed = new URL(tab.url);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.href !== tab.url ||
        parsed.username !== '' || parsed.password !== '') throw attachedCopySourceUnavailable();
      const firstResults = await executeScript({
        target: { tabId: expected.tabId, frameIds: [0] },
        world: 'ISOLATED',
        func: () => globalThis.location?.href,
      });
      if (!Array.isArray(firstResults) || firstResults.length !== 1) throw attachedCopySourceUnavailable();
      const [firstResult] = firstResults;
      if (firstResult?.frameId !== 0 || firstResult.documentId !== expected.documentId ||
        firstResult.result !== tab.url) throw attachedCopySourceUnavailable();
      const confirmedTab = await invoke(chromeApi, chromeApi.tabs, 'get', expected.tabId);
      if (confirmedTab?.id !== tab.id || confirmedTab.windowId !== tab.windowId ||
        confirmedTab.status !== 'complete' || confirmedTab.url !== tab.url) throw attachedCopySourceUnavailable();
      const urlSessionDigest = await sessionUrlDigestManager.digest(tab.url);
      if (urlSessionDigest !== expected.urlSessionDigest) throw attachedCopySourceUnavailable();
      const finalResults = await executeScript({
        target: { tabId: expected.tabId, frameIds: [0] },
        world: 'ISOLATED',
        func: () => globalThis.location?.href,
      });
      if (!Array.isArray(finalResults) || finalResults.length !== 1) throw attachedCopySourceUnavailable();
      const [finalResult] = finalResults;
      if (finalResult?.frameId !== 0 || finalResult.documentId !== expected.documentId ||
        finalResult.result !== tab.url) throw attachedCopySourceUnavailable();
      const finalTab = await invoke(chromeApi, chromeApi.tabs, 'get', expected.tabId);
      if (finalTab?.id !== tab.id || finalTab.windowId !== tab.windowId ||
        finalTab.status !== 'complete' || finalTab.url !== tab.url) throw attachedCopySourceUnavailable();
      return ObjectFreeze({
        version: 'AttachedCopySourceV1',
        tabId: expected.tabId,
        windowId: expected.windowId,
        documentId: expected.documentId,
        urlSessionDigest: expected.urlSessionDigest,
        rawUrl: tab.url,
      });
    } catch {
      throw attachedCopySourceUnavailable();
    }
  };

  const adapter = {
    manifestVersion: chromeApi.runtime.manifestVersion,
    createTab(options) { return invoke(chromeApi, chromeApi.tabs, 'create', options); },
    navigateTab(tabId, url) { return invoke(chromeApi, chromeApi.tabs, 'update', tabId, { url }); },
    async probeDocumentIdentity(tabId) {
      if (!Number.isSafeInteger(tabId) || tabId < 0 || typeof sessionUrlDigestManager?.digest !== 'function') {
        throw new Error('TARGET_DOCUMENT_UNAVAILABLE');
      }
      try {
        const tab = await invoke(chromeApi, chromeApi.tabs, 'get', tabId);
        if (tab?.id !== tabId || !Number.isSafeInteger(tab.windowId) || tab.status !== 'complete' || typeof tab.url !== 'string') {
          throw new Error('TARGET_DOCUMENT_UNAVAILABLE');
        }
        const parsed = new URL(tab.url);
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.href !== tab.url) {
          throw new Error('TARGET_DOCUMENT_UNAVAILABLE');
        }
        const results = await executeScript({
          target: { tabId, frameIds: [0] },
          world: 'ISOLATED',
          func: () => globalThis.location?.href,
        });
        if (!Array.isArray(results) || results.length !== 1) throw new Error('TARGET_DOCUMENT_UNAVAILABLE');
        const [result] = results;
        if (result?.frameId !== 0 || typeof result.documentId !== 'string' || !result.documentId || result.result !== tab.url) {
          throw new Error('TARGET_DOCUMENT_UNAVAILABLE');
        }
        const confirmedTab = await invoke(chromeApi, chromeApi.tabs, 'get', tabId);
        if (confirmedTab?.id !== tab.id || confirmedTab.windowId !== tab.windowId ||
          confirmedTab.status !== 'complete' || confirmedTab.url !== tab.url) {
          throw new Error('TARGET_DOCUMENT_UNAVAILABLE');
        }
        const urlSessionDigest = await sessionUrlDigestManager.digest(tab.url);
        if (typeof urlSessionDigest !== 'string' || !/^hmac-sha256:[A-Za-z0-9_-]{43}$/u.test(urlSessionDigest)) {
          throw new Error('TARGET_DOCUMENT_UNAVAILABLE');
        }
        const finalResults = await executeScript({
          target: { tabId, frameIds: [0] },
          world: 'ISOLATED',
          func: () => globalThis.location?.href,
        });
        if (!Array.isArray(finalResults) || finalResults.length !== 1) throw new Error('TARGET_DOCUMENT_UNAVAILABLE');
        const [finalResult] = finalResults;
        if (finalResult?.frameId !== 0 || finalResult.documentId !== result.documentId || finalResult.result !== tab.url) {
          throw new Error('TARGET_DOCUMENT_UNAVAILABLE');
        }
        const finalTab = await invoke(chromeApi, chromeApi.tabs, 'get', tabId);
        if (finalTab?.id !== tab.id || finalTab.windowId !== tab.windowId ||
          finalTab.status !== 'complete' || finalTab.url !== tab.url) {
          throw new Error('TARGET_DOCUMENT_UNAVAILABLE');
        }
        return Object.freeze({ tabId, windowId: tab.windowId, documentId: result.documentId, urlSessionDigest });
      } catch {
        throw new Error('TARGET_DOCUMENT_UNAVAILABLE');
      }
    },
    async getEvidenceUrl(tabId, includeQuery = false) {
      if (!Number.isSafeInteger(tabId) || tabId < 0 || typeof includeQuery !== 'boolean') return '';
      try {
        const rawUrl = (await invoke(chromeApi, chromeApi.tabs, 'get', tabId))?.url;
        return sanitizeEvidenceUrlV1(rawUrl, { includeQuery: false }).href;
      } catch {
        return '';
      }
    },
    async probeSensitiveCaptureSignals(tabId, expectedMainDocumentId) {
      if (!Number.isSafeInteger(tabId) || tabId < 0 || typeof expectedMainDocumentId !== 'string' ||
        expectedMainDocumentId.length === 0 || expectedMainDocumentId.length > 240) {
        throw new Error('SENSITIVE_CONTEXT_PROBE_UNAVAILABLE');
      }
      try {
        const frames = denseHighlightArray(await executeScript({
          target: { tabId, allFrames: true },
          world: 'ISOLATED',
          func: () => null,
        }), 256);
        if (!frames || frames.length === 0) {
          throw new Error('SENSITIVE_CONTEXT_PROBE_UNAVAILABLE');
        }
        const documentIds = [];
        let mainFrameDocumentId = null;
        for (const rawFrame of frames) {
          const frame = exactHighlightRecord(rawFrame, ['frameId', 'documentId', 'result']);
          if (!frame || !Number.isSafeInteger(frame.frameId) || frame.frameId < 0 ||
            typeof frame.documentId !== 'string' || frame.documentId.length === 0 || frame.documentId.length > 240 ||
            frame.result !== null || documentIds.includes(frame.documentId)) {
            throw new Error('SENSITIVE_CONTEXT_PROBE_UNAVAILABLE');
          }
          if (frame.frameId === 0) mainFrameDocumentId = frame.documentId;
          documentIds.push(frame.documentId);
        }
        if (mainFrameDocumentId !== expectedMainDocumentId) throw new Error('SENSITIVE_CONTEXT_PROBE_UNAVAILABLE');
        return await probeSensitiveContextInTab(tabId, { executeScript, documentIds });
      } catch { throw new Error('SENSITIVE_CONTEXT_PROBE_UNAVAILABLE'); }
    },
    async probePrivacySignals(tabId) {
      if (!Number.isSafeInteger(tabId) || tabId < 0) throw new Error('PRIVACY_PROBE_UNAVAILABLE');
      try {
        const results = await executeScript({
          target: { tabId, allFrames: true },
          world: 'ISOLATED',
          func: () => {
            const selectors = [
              ['password-field', 'input[type="password"]'],
              ['credential-autocomplete', '[autocomplete="current-password"],[autocomplete="new-password"]'],
              ['one-time-code', '[autocomplete="one-time-code"]'],
              ['payment-card', '[autocomplete="cc-number"],[autocomplete="cc-csc"]'],
              ['audita-private', '[data-audita-private]'],
            ];
            return selectors.map(([category, selector]) => ({
              category,
              count: document.querySelectorAll(selector).length,
            })).filter(value => value.count > 0);
          },
        });
        if (!Array.isArray(results)) throw new Error('PRIVACY_PROBE_UNAVAILABLE');
        const counts = new Map();
        for (const frame of results) {
          if (frame?.error !== undefined || !Array.isArray(frame?.result)) throw new Error('PRIVACY_PROBE_UNAVAILABLE');
          for (const value of frame.result) {
            if (!value || typeof value.category !== 'string' || !Number.isSafeInteger(value.count) || value.count < 1) {
              throw new Error('PRIVACY_PROBE_UNAVAILABLE');
            }
            counts.set(value.category, (counts.get(value.category) ?? 0) + value.count);
          }
        }
        return Object.freeze([...counts].sort(([a], [b]) => a.localeCompare(b))
          .map(([category, count]) => Object.freeze({ category, count })));
      } catch {
        throw new Error('PRIVACY_PROBE_UNAVAILABLE');
      }
    },
    executeScript,
    async waitForStable(tabId, options = {}) {
      const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 30_000;
      if (options.signal?.aborted) throw abortError(options.signal);
      return new Promise((resolve, reject) => {
        let timer;
        let quietTimer;
        let revision = 0;
        let settled = false;
        const cleanup = () => {
          clearTimeout(timer);
          clearTimeout(quietTimer);
          chromeApi.tabs.onUpdated.removeListener(onUpdated);
          chromeApi.tabs.onRemoved.removeListener(onRemoved);
          options.signal?.removeEventListener('abort', onAbort);
        };
        const finish = (handler, value) => {
          if (settled) return;
          settled = true; cleanup(); handler(value);
        };
        // A load event can precede a site's replaceState/redirect (for example
        // Google's startup URL). Freeze identity only after this quiet window;
        // the runner and each raster still prove the exact document separately.
        const observe = tab => {
          if (settled) return;
          const observedRevision = ++revision;
          clearTimeout(quietTimer);
          if (tab?.status !== 'complete') return;
          quietTimer = setTimeout(() => {
            void invoke(chromeApi, chromeApi.tabs, 'get', tabId).then(current => {
              if (settled || observedRevision !== revision) return;
              if (current?.status === 'complete' && current.url === tab.url) finish(resolve, current);
              else observe(current);
            }, error => finish(reject, error));
          }, 500);
        };
        const onUpdated = (id, changeInfo, tab) => {
          if (id === tabId && (changeInfo.status || changeInfo.url)) observe(tab);
        };
        const onRemoved = id => { if (id === tabId) finish(reject, new Error('A aba de auditoria foi fechada.')); };
        const onAbort = () => finish(reject, abortError(options.signal));
        chromeApi.tabs.onUpdated.addListener(onUpdated);
        chromeApi.tabs.onRemoved.addListener(onRemoved);
        options.signal?.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(() => finish(reject, timeoutError()), timeoutMs);
        void invoke(chromeApi, chromeApi.tabs, 'get', tabId).then(tab => {
          if (revision === 0) observe(tab);
        }, error => finish(reject, error));
      });
    },
    async connectCdp(tabId) {
      const cdp = createCdpClient(transport);
      await cdp.connect(tabId);
      return cdp;
    },
    collectPage(cdp, tabId) { return collectPage(cdp, tabId, { executeScript }); },
    captureFullPage,
    captureElement,
    composeAnnouncementMap,
    runDynamicProbes(tabId, cdp, options = {}) { return runDynamicProbes({ adapter: createProbeAdapter(tabId, cdp), signal: options.signal }); },
    async getEnvironment(_tabId, cdp) {
      const [version, viewport] = await Promise.allSettled([
        cdp.command('Browser.getVersion', {}),
        cdp.command('Runtime.evaluate', { expression: '({width:innerWidth,height:innerHeight,deviceScaleFactor:devicePixelRatio})', returnByValue: true }),
      ]);
      // Browser is not exposed by chrome.debugger. Its failure must not erase
      // a successful, independent measurement from the page's Runtime domain.
      const value = viewport.status === 'fulfilled' ? viewport.value?.result?.value : null;
      return {
        chromeVersion: version.status === 'fulfilled' ? String(version.value?.product || '') : '',
        viewport: { width: value?.width ?? null, height: value?.height ?? null, deviceScaleFactor: value?.deviceScaleFactor ?? null },
      };
    },
    async getFinalUrl(tabId) { return (await invoke(chromeApi, chromeApi.tabs, 'get', tabId))?.url || ''; },
    async proveHighlightTargets(rawInput) {
      const input = highlightProofInput(rawInput);
      if (!input) return Object.freeze([]);
      const result = await proveHighlightTargetsCore(input);
      return result.ok ? result.proofs : Object.freeze([]);
    },
    async verifyHighlightTarget(rawInput) {
      const input = highlightVerifyInput(rawInput);
      if (!input) return frozenHighlightFailure('live-proof-failed');
      const candidate = Object.freeze({
        occurrenceId: 'verify-target',
        evidenceId: input.target.evidenceId,
        backendNodeId: input.target.backendNodeId,
        selector: input.target.selector,
      });
      const proofInput = Object.freeze({
        tabId: input.tabId,
        windowId: input.windowId,
        topDocumentId: input.topDocumentId,
        candidates: Object.freeze([candidate]),
      });
      const result = await proveHighlightTargetsCore(proofInput);
      if (!result.ok) return frozenHighlightFailure(result.reason);
      if (result.proofs.length !== 1) {
        return frozenHighlightFailure(result.failures.get(candidate.occurrenceId) ?? 'live-proof-failed');
      }
      const [proof] = result.proofs;
      if (proof.documentId !== input.target.documentId) return frozenHighlightFailure('document-changed');
      if (proof.frameId !== input.target.frameId || proof.backendNodeId !== input.target.backendNodeId ||
        proof.structuralSignature.sha256 !== input.target.structuralSignature.sha256) {
        return frozenHighlightFailure('live-proof-failed');
      }
      return Object.freeze({
        ok: true,
        topDocumentId: input.topDocumentId,
        documentId: proof.documentId,
        frameId: proof.frameId,
      });
    },
    async injectHighlight(rawInput) {
      const input = highlightCommandInput(rawInput);
      if (!input) return frozenHighlightFailure('invalid-input');
      let results;
      try {
        results = denseHighlightArray(await executeScript({
          target: { tabId: input.tabId, documentIds: [input.documentId] },
          world: 'ISOLATED',
          func: runAuditaHighlightCommand,
          args: [input.command],
        }), 1);
      } catch {
        return frozenHighlightFailure('execution-failed');
      }
      if (!results || results.length !== 1) return frozenHighlightFailure('result-mismatch');
      const wrapper = exactHighlightRecord(results[0], ['documentId', 'frameId', 'result']);
      if (!wrapper || wrapper.documentId !== input.documentId || !validHighlightChromeId(wrapper.frameId) ||
        (input.command.op === 'install' && wrapper.frameId !== input.command.frameId)) {
        return frozenHighlightFailure('result-mismatch');
      }
      const success = exactHighlightRecord(wrapper.result, ['ok', 'nonce']);
      if (success?.ok === true && success.nonce === input.command.nonce) {
        return Object.freeze({
          ok: true,
          nonce: success.nonce,
          documentId: wrapper.documentId,
          frameId: wrapper.frameId,
        });
      }
      const failure = exactHighlightRecord(wrapper.result, ['ok', 'reason']);
      if (failure?.ok === false && [
        'invalid-command', 'target-not-unique', 'signature-mismatch', 'target-not-rendered',
        'nonce-mismatch', 'runtime-error',
      ].includes(failure.reason)) return frozenHighlightFailure(failure.reason);
      return frozenHighlightFailure('result-mismatch');
    },
    async emitProgress(message) { await invoke(chromeApi, chromeApi.runtime, 'sendMessage', message); },
    async handoffReport(model) {
      return {
        reviewUrl: chromeApi.runtime.getURL(`src/review/index.html?auditId=${encodeURIComponent(model.auditId)}`),
        artifact: { status: 'pending', formats: [] },
      };
    },
    removeTab(tabId) { return invoke(chromeApi, chromeApi.tabs, 'remove', tabId); },
  };
  const internal = ObjectCreate(null);
  defineDataProperty(internal, 'sessionArea', chromeApi.storage?.session, true, false, false);
  defineDataProperty(internal, 'randomBytes', length => {
    const bytes = new PrimordialUint8Array(length);
    ReflectApply(PrimordialGetRandomValues, PrimordialCrypto, [bytes]);
    return bytes;
  }, true, false, false);
  defineDataProperty(internal, 'snapshotAttachedCopySource', snapshotAttachedCopySource, true, false, false);
  if (ObjectHasOwn(options, 'capturePolicy')) {
    defineDataProperty(internal, 'capturePolicy', options.capturePolicy, true, false, false);
  }
  if (ObjectHasOwn(options, 'onExecutionCheckpoint')) {
    defineDataProperty(internal, 'onExecutionCheckpoint', options.onExecutionCheckpoint, true, false, false);
  }
  if (ObjectHasOwn(options, 'persistAuditModel')) {
    defineDataProperty(internal, 'persistAuditModel', options.persistAuditModel, true, false, false);
  }
  ObjectFreeze(internal);
  defineDataProperty(adapter, AUDIT_EXECUTION_INTERNAL, internal, false, false, false);
  return adapter;
}
