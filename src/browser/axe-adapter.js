export const AXE_MV3_CSP_GATE = Object.freeze({
  enabled: true,
  targetSizeEnabled: true,
  code: 'AXE_MV3_CSP_E2E_PASSED',
  testedBrowser: 'Google Chrome for Testing 152.0.7977.64',
});

export const AXE_RUN_CONFIG = Object.freeze({
  runOnly: Object.freeze({
    type: 'tag',
    values: Object.freeze(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']),
  }),
  rules: Object.freeze({ 'target-size': Object.freeze({ enabled: AXE_MV3_CSP_GATE.targetSizeEnabled }) }),
  resultTypes: Object.freeze(['violations', 'incomplete', 'passes', 'inapplicable']),
  preload: false,
  iframes: false,
});

export const AXE_PROVENANCE = Object.freeze({
  engine: 'axe-core',
  version: '4.13.0',
  runtimePath: 'vendor/axe/axe.min.js',
  runtimeSha256: 'c24f097bd2f451d4f933e8bc7d8d539f8672a2ebcb5cc9f9f3eec8ca9470a0c1',
  packageTarballSha256: '096912f6e77b4b695fc9304b7be65091db42d98de054da674ae222a11cb33f70',
  config: AXE_RUN_CONFIG,
  gate: AXE_MV3_CSP_GATE,
});

// This is the complete, stable catalog that may cross the adapter boundary.
// Runtime-only and thrown-error codes are deliberately not report diagnostics.
export const AXE_DIAGNOSTIC_CODES = Object.freeze([
  'AXE_FEATURE_DISABLED',
  'AXE_PROVENANCE_INVALID',
  'AXE_TIMEOUT',
  'AXE_INJECTION_FAILED',
  'AXE_EXECUTION_FAILED',
  'AXE_FRAME_TOPOLOGY_CHANGED',
  'AXE_FRAME_MISSING',
  'AXE_FRAME_RUNTIME_UNAVAILABLE',
  'AXE_FRAME_RUN_FAILED',
  'AXE_VERSION_MISMATCH',
  'AXE_FRAME_INVALID',
  'AXE_FRAME_DUPLICATE',
  'AXE_FRAME_FAILED',
  'AXE_FRAME_RESULT_INVALID',
  'AXE_RESULTS_TRUNCATED',
  'AXE_DIAGNOSTIC_UNAVAILABLE',
]);
const AXE_DIAGNOSTIC_RANK = new Map(AXE_DIAGNOSTIC_CODES.map((code, index) => [code, index]));
const MAX_CANONICAL_DIAGNOSTICS = 64;
const MAX_DIAGNOSTIC_CANDIDATES = 321;

function diagnosticOwnWithMetadata(value, key) {
  try {
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) {
      return { value: undefined, readable: true, ownData: false };
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) return { value: undefined, readable: true, ownData: false };
    if (!Object.hasOwn(descriptor, 'value')) return { value: undefined, readable: false, ownData: false };
    return { value: descriptor.value, readable: true, ownData: true };
  } catch { return { value: undefined, readable: false, ownData: false }; }
}

function diagnosticMetadata(diagnostics, truncated, valid, readable) {
  return Object.freeze({ diagnostics: Object.freeze(diagnostics), truncated, valid, readable });
}

/** Drops private fields and reports collection validity/readability plus unique-set truncation. */
export function canonicalizeAxeDiagnosticsWithMetadata(value) {
  let isArray = false;
  try { isArray = Array.isArray(value); } catch {
    return diagnosticMetadata([], false, false, false);
  }
  if (!isArray) return diagnosticMetadata([], false, false, true);
  const lengthRead = diagnosticOwnWithMetadata(value, 'length');
  const declaredLength = lengthRead.value;
  if (!lengthRead.readable || !lengthRead.ownData || !Number.isSafeInteger(declaredLength) || declaredLength < 0) {
    return diagnosticMetadata([], false, false, lengthRead.readable);
  }
  const length = Math.min(declaredLength, MAX_DIAGNOSTIC_CANDIDATES);
  const unique = new Map();
  let readable = true;
  for (let index = 0; index < length; index += 1) {
    const entryRead = diagnosticOwnWithMetadata(value, String(index));
    const entry = entryRead.value;
    const codeRead = diagnosticOwnWithMetadata(entry, 'code');
    const rawCode = codeRead.value;
    const code = AXE_DIAGNOSTIC_RANK.has(rawCode) ? rawCode : 'AXE_DIAGNOSTIC_UNAVAILABLE';
    const frameRead = diagnosticOwnWithMetadata(entry, 'frameId');
    const rawFrameId = frameRead.value;
    const frameId = Number.isSafeInteger(rawFrameId) && rawFrameId >= 0 ? rawFrameId : null;
    if (!entryRead.readable || !codeRead.readable || !frameRead.readable) readable = false;
    unique.set(`${code}\u0000${frameId ?? ''}`, { code, frameId });
  }
  const sorted = [...unique.values()].sort((left, right) =>
    AXE_DIAGNOSTIC_RANK.get(left.code) - AXE_DIAGNOSTIC_RANK.get(right.code) ||
    (left.frameId ?? -1) - (right.frameId ?? -1));
  let retained = sorted.slice(0, MAX_CANONICAL_DIAGNOSTICS);
  const truncation = sorted.find(entry => entry.code === 'AXE_RESULTS_TRUNCATED');
  if (truncation && !retained.includes(truncation)) retained = [...retained.slice(0, MAX_CANONICAL_DIAGNOSTICS - 1), truncation].sort((left, right) =>
    AXE_DIAGNOSTIC_RANK.get(left.code) - AXE_DIAGNOSTIC_RANK.get(right.code) ||
    (left.frameId ?? -1) - (right.frameId ?? -1));
  return diagnosticMetadata(
    retained.map(entry => Object.freeze(entry)),
    sorted.length > MAX_CANONICAL_DIAGNOSTICS || declaredLength > MAX_DIAGNOSTIC_CANDIDATES,
    true,
    readable,
  );
}

/** Compatibility projection for callers that only need the canonical entries. */
export function canonicalizeAxeDiagnostics(value) {
  return canonicalizeAxeDiagnosticsWithMetadata(value).diagnostics;
}

const MAX_GROUPS = 100;
const MAX_NODES = 100;
const DEFAULT_TIMEOUT_MS = 30_000;
const SELECTOR_ALLOWED_CHARACTERS = /^[a-z0-9*():>\- \t]+$/iu;
export const AXE_STRUCTURAL_SELECTOR_TAGS = Object.freeze([
  'a', 'abbr', 'address', 'area', 'article', 'aside', 'audio', 'b', 'base', 'bdi', 'bdo', 'blockquote', 'body', 'br', 'button',
  'canvas', 'caption', 'cite', 'code', 'col', 'colgroup', 'data', 'datalist', 'dd', 'del', 'details', 'dfn', 'dialog', 'div', 'dl', 'dt',
  'em', 'embed', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header', 'hgroup',
  'hr', 'html', 'i', 'iframe', 'img', 'input', 'ins', 'kbd', 'label', 'legend', 'li', 'link', 'main', 'map', 'mark', 'menu', 'meta',
  'meter', 'nav', 'noscript', 'object', 'ol', 'optgroup', 'option', 'output', 'p', 'picture', 'pre', 'progress', 'q', 'rp', 'rt', 'ruby',
  's', 'samp', 'script', 'search', 'section', 'select', 'slot', 'small', 'source', 'span', 'strong', 'style', 'sub', 'summary', 'sup',
  'table', 'tbody', 'td', 'template', 'textarea', 'tfoot', 'th', 'thead', 'time', 'title', 'tr', 'track', 'u', 'ul', 'var', 'video', 'wbr',
]);
const SAFE_TARGET_TAGS = new Set(AXE_STRUCTURAL_SELECTOR_TAGS);
export const AXE_ALLOWED_RULE_IDS = Object.freeze([
  'area-alt', 'aria-allowed-attr', 'aria-command-name', 'aria-input-field-name', 'aria-meter-name',
  'aria-progressbar-name', 'aria-required-attr', 'aria-required-children', 'aria-required-parent', 'aria-roles', 'aria-toggle-field-name', 'aria-tooltip-name',
  'aria-valid-attr-value', 'aria-valid-attr', 'button-name', 'bypass', 'color-contrast', 'definition-list', 'dlitem',
  'document-title', 'frame-title', 'html-has-lang', 'html-lang-valid', 'image-alt', 'input-button-name',
  'input-image-alt', 'label', 'label-content-name-mismatch', 'link-name', 'list', 'listitem', 'meta-viewport',
  'object-alt', 'role-img-alt', 'select-name', 'svg-img-alt', 'target-size', 'td-headers-attr', 'th-has-data-cells',
]);
const ALLOWED_RULE_ID_SET = new Set(AXE_ALLOWED_RULE_IDS);
export const AXE_FRAME_PROJECTION_POLICY = Object.freeze({
  allowedRuleIds: AXE_ALLOWED_RULE_IDS,
  allowedTags: AXE_STRUCTURAL_SELECTOR_TAGS,
  maxGroupsPerType: MAX_GROUPS,
  maxNodesPerGroup: MAX_NODES,
  maxSelectorLength: 256,
  maxSelectorParts: 12,
  targetUnavailable: '[target-unavailable]',
});
const DEFAULT_TIMERS = Object.freeze({
  set: (callback, timeoutMs) => setTimeout(callback, timeoutMs),
  clear: timer => clearTimeout(timer),
});

export const AXE_TARGET_UNAVAILABLE = '[target-unavailable]';

function safeImpact(value) {
  return ['minor', 'moderate', 'serious', 'critical'].includes(value) ? value : null;
}

function safeSelectorCompound(compound) {
  if (/^\*:nth-child\([1-9]\d{0,3}\)$/u.test(compound)) return true;
  const match = compound.match(/^([a-z][a-z0-9-]{0,31})(?::nth-of-type\(([1-9]\d{0,3})\))?$/iu);
  return Boolean(match && SAFE_TARGET_TAGS.has(match[1].toLowerCase()));
}

export function sanitizeAxeStructuralSelector(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) return AXE_TARGET_UNAVAILABLE;
  if (!SELECTOR_ALLOWED_CHARACTERS.test(value) || /[\u0000-\u001f\u007f]/u.test(value) || /(?:javascript|data|blob|file|https?):/iu.test(value)) return AXE_TARGET_UNAVAILABLE;
  const normalized = value.trim().replace(/\s*>\s*/gu, ' > ').replace(/[ \t]+/gu, ' ');
  if (!normalized || normalized.startsWith('>') || normalized.endsWith('>') || normalized.includes('> >')) return AXE_TARGET_UNAVAILABLE;
  const tokens = normalized.split(' ');
  let previousWasCombinator = true;
  for (const token of tokens) {
    if (token === '>') {
      if (previousWasCombinator) return AXE_TARGET_UNAVAILABLE;
      previousWasCombinator = true;
    } else {
      if (!safeSelectorCompound(token)) return AXE_TARGET_UNAVAILABLE;
      previousWasCombinator = false;
    }
  }
  return previousWasCombinator ? AXE_TARGET_UNAVAILABLE : normalized;
}

function ownData(value, key) {
  try {
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  } catch { return undefined; }
}

function projectedArray(value, key, limit) {
  const candidate = ownData(value, key);
  let isArray = false;
  try { isArray = Array.isArray(candidate); } catch { return { entries: [], length: 0, valid: false }; }
  if (!isArray) return { entries: [], length: 0, valid: false };
  const rawLength = ownData(candidate, 'length');
  if (!Number.isSafeInteger(rawLength) || rawLength < 0) return { entries: [], length: 0, valid: false };
  const entries = [];
  for (let index = 0; index < Math.min(rawLength, limit); index += 1) entries.push(ownData(candidate, String(index)));
  return { entries, length: rawLength, valid: true };
}

function projectedCount(metadata, rawLength, retained, limit, dropped = false) {
  const claimedOriginal = ownData(metadata, 'original');
  const claimedRetained = ownData(metadata, 'retained');
  const claimedTruncated = ownData(metadata, 'truncated');
  const claimValid = Number.isSafeInteger(claimedOriginal) && claimedOriginal >= 0 && claimedOriginal <= limit + 1 &&
    claimedRetained === retained && typeof claimedTruncated === 'boolean';
  const original = Math.max(Math.min(rawLength, limit + 1), retained, claimValid ? claimedOriginal : 0);
  return {
    original,
    retained,
    truncated: dropped || rawLength > limit || (claimValid && claimedTruncated) || original > retained,
  };
}

function sanitizeProjectedGroup(group) {
  const id = ownData(group, 'id');
  if (!ALLOWED_RULE_ID_SET.has(id)) return null;
  const inspected = projectedArray(group, 'nodes', MAX_NODES);
  const nodes = inspected.entries.filter(node => {
    try { return Boolean(node && typeof node === 'object' && !Array.isArray(node)); } catch { return false; }
  }).map(node => ({
      impact: safeImpact(ownData(node, 'impact')),
      target: sanitizeAxeStructuralSelector(ownData(node, 'target')),
    }));
  return {
    id,
    impact: safeImpact(ownData(group, 'impact')),
    nodes,
    truncation: {
      nodes: projectedCount(ownData(ownData(group, 'truncation'), 'nodes'), inspected.length, nodes.length, MAX_NODES,
        !inspected.valid || nodes.length !== inspected.entries.length),
    },
  };
}

function sanitizeAxeResults(results) {
  const output = { truncation: {} };
  for (const name of ['violations', 'incomplete', 'passes', 'inapplicable']) {
    const inspected = projectedArray(results, name, MAX_GROUPS);
    const permitted = inspected.entries.filter(group => ALLOWED_RULE_ID_SET.has(ownData(group, 'id')));
    const groups = permitted.map(sanitizeProjectedGroup).filter(Boolean);
    output[name] = groups;
    output.truncation[name] = projectedCount(
      ownData(ownData(results, 'truncation'), name),
      inspected.length > MAX_GROUPS ? MAX_GROUPS + 1 : permitted.length,
      groups.length,
      MAX_GROUPS,
      !inspected.valid || inspected.length > MAX_GROUPS || groups.length !== permitted.length,
    );
  }
  return output;
}

/** Runs inside each isolated frame after the separately packaged axe runtime is injected. */
export async function runAxeInFrame(config, policy) {
  try {
    // Everything below is intentionally local to this function: Chrome
    // serializes only this function and its explicit arguments into each frame.
    const read = (value, key) => {
      try {
        if (!value || (typeof value !== 'object' && typeof value !== 'function')) return undefined;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
      } catch { return undefined; }
    };
    const inspect = (value, key, limit) => {
      const candidate = read(value, key);
      let array = false;
      try { array = Array.isArray(candidate); } catch { return { entries: [], length: 0, valid: false }; }
      if (!array) return { entries: [], length: 0, valid: false };
      const length = read(candidate, 'length');
      if (!Number.isSafeInteger(length) || length < 0) return { entries: [], length: 0, valid: false };
      const entries = [];
      for (let index = 0; index < Math.min(length, limit); index += 1) entries.push(read(candidate, String(index)));
      return { entries, length, valid: true };
    };
    const allowedRules = new Set(read(policy, 'allowedRuleIds'));
    const allowedTags = new Set(read(policy, 'allowedTags'));
    const maxGroups = read(policy, 'maxGroupsPerType');
    const maxNodes = read(policy, 'maxNodesPerGroup');
    const maxSelectorLength = read(policy, 'maxSelectorLength');
    const maxSelectorParts = read(policy, 'maxSelectorParts');
    const unavailable = read(policy, 'targetUnavailable');
    if (!Number.isSafeInteger(maxGroups) || !Number.isSafeInteger(maxNodes) ||
      !Number.isSafeInteger(maxSelectorLength) || !Number.isSafeInteger(maxSelectorParts) ||
      typeof unavailable !== 'string') return { ok: false, code: 'AXE_RUN_FAILED' };
    const impact = value => ['minor', 'moderate', 'serious', 'critical'].includes(value) ? value : null;
    const count = (length, retained, limit, dropped) => ({
      original: Math.min(Number.isSafeInteger(length) && length >= 0 ? length : 0, limit + 1),
      retained,
      truncated: dropped || !Number.isSafeInteger(length) || length < 0 || length > limit || retained !== length,
    });
    const resolveUnique = rawTarget => {
      const target = inspect({ target: rawTarget }, 'target', 2);
      if (!target.valid || target.length !== 1 || typeof target.entries[0] !== 'string' ||
        target.entries[0].length === 0 || target.entries[0].length > maxSelectorLength) return unavailable;
      let matches;
      try { matches = globalThis.document.querySelectorAll(target.entries[0]); } catch { return unavailable; }
      if (!matches || matches.length !== 1) return unavailable;
      const element = matches[0];
      try {
        if (typeof element.getRootNode === 'function' && element.getRootNode() !== globalThis.document) return unavailable;
        const compounds = [];
        let current = element;
        while (current && compounds.length < maxSelectorParts) {
          const tag = typeof current.localName === 'string' ? current.localName.toLowerCase() : '';
          const anonymous = !allowedTags.has(tag);
          let compound = tag;
          const parent = current.parentElement;
          if (anonymous && !parent) break;
          if (parent) {
            const siblings = parent.children;
            let sameTag = 0;
            let position = 0;
            let childPosition = 0;
            const siblingLength = Math.min(Number.isSafeInteger(siblings?.length) ? siblings.length : 0, 2_048);
            for (let index = 0; index < siblingLength; index += 1) {
              const sibling = siblings[index];
              if (sibling === current) childPosition = index + 1;
              if (typeof sibling?.localName === 'string' && sibling.localName.toLowerCase() === tag) {
                sameTag += 1;
                if (sibling === current) position = sameTag;
              }
            }
            if (anonymous) {
              if (childPosition === 0) return unavailable;
              compound = `*:nth-child(${childPosition})`;
            } else if (sameTag > 1) {
              if (position === 0) return unavailable;
              compound += `:nth-of-type(${position})`;
            }
          }
          compounds.unshift(compound);
          if (tag === 'html') break;
          current = parent;
        }
        // Prefer the complete path. Deep trees and custom ancestors may leave
        // only a structural suffix; retain it solely if it resolves to this
        // exact element, without exporting page-controlled names or attributes.
        while (compounds.length > 0) {
          const selector = compounds.join(' > ');
          if (selector.length <= maxSelectorLength) {
            const verified = globalThis.document.querySelectorAll(selector);
            if (verified?.length === 1 && verified[0] === element) return selector;
          }
          compounds.shift();
        }
        return unavailable;
      } catch { return unavailable; }
    };
    const projectGroup = group => {
      const id = read(group, 'id');
      if (!allowedRules.has(id)) return null;
      const rawNodes = inspect(group, 'nodes', maxNodes);
      const nodes = rawNodes.entries.filter(node => {
        try { return Boolean(node && typeof node === 'object' && !Array.isArray(node)); } catch { return false; }
      }).map(node => ({
        impact: impact(read(node, 'impact')),
        target: resolveUnique(read(node, 'target')),
      }));
      return {
        id,
        impact: impact(read(group, 'impact')),
        nodes,
        truncation: { nodes: count(rawNodes.length, nodes.length, maxNodes,
          !rawNodes.valid || nodes.length !== rawNodes.entries.length) },
      };
    };
    const engine = globalThis.axe;
    if (!engine || typeof engine.run !== 'function') return { ok: false, code: 'AXE_RUNTIME_UNAVAILABLE' };
    const results = await engine.run(globalThis.document, config);
    const projected = { truncation: {} };
    for (const name of ['violations', 'incomplete', 'passes', 'inapplicable']) {
      const rawGroups = inspect(results, name, maxGroups);
      const permitted = rawGroups.entries.filter(group => allowedRules.has(read(group, 'id')));
      const groups = permitted.map(projectGroup).filter(Boolean);
      projected[name] = groups;
      projected.truncation[name] = count(rawGroups.length > maxGroups ? maxGroups + 1 : permitted.length, groups.length, maxGroups,
        !rawGroups.valid || rawGroups.length > maxGroups || groups.length !== permitted.length);
    }
    return { ok: true, version: engine.version, results: projected };
  } catch {
    return { ok: false, code: 'AXE_RUN_FAILED' };
  }
}

function defaultExecuteScript(options) {
  if (!globalThis.chrome?.scripting?.executeScript) throw new Error('chrome.scripting.executeScript não está disponível.');
  return globalThis.chrome.scripting.executeScript(options);
}

function diagnostic(code, frameId = null) {
  return { code, frameId: Number.isSafeInteger(frameId) ? frameId : null };
}

function timeoutError() {
  return new DOMException('Tempo limite do axe excedido.', 'TimeoutError');
}

function assertDeadline(deadline) {
  if (deadline.expired) throw timeoutError();
}

async function withTimeout(operation, timeoutMs, timers) {
  let timer;
  const deadline = { expired: false };
  try {
    const timedOut = new Promise((_, reject) => {
      timer = timers.set(() => {
        deadline.expired = true;
        reject(timeoutError());
      }, timeoutMs);
    });
    return await Promise.race([
      operation(deadline),
      timedOut,
    ]);
  } finally {
    timers.clear(timer);
  }
}

async function executeAxe(tabId, executeScript, deadline) {
  const target = { tabId, allFrames: true };
  let injections;
  assertDeadline(deadline);
  try {
    injections = await executeScript({ target, world: 'ISOLATED', files: [AXE_PROVENANCE.runtimePath] });
  } catch {
    assertDeadline(deadline);
    return { status: 'partial', provenance: AXE_PROVENANCE, frames: [], diagnostics: [diagnostic('AXE_INJECTION_FAILED')] };
  }
  // An already-issued Chrome API call cannot be canceled, so the expired guard
  // prevents its late resolution from starting or publishing subsequent work.
  assertDeadline(deadline);
  let runs;
  assertDeadline(deadline);
  try {
    runs = await executeScript({ target, world: 'ISOLATED', func: runAxeInFrame, args: [AXE_RUN_CONFIG, AXE_FRAME_PROJECTION_POLICY] });
  } catch {
    assertDeadline(deadline);
    return { status: 'partial', provenance: AXE_PROVENANCE, frames: [], diagnostics: [diagnostic('AXE_EXECUTION_FAILED')] };
  }
  assertDeadline(deadline);

  const injectionIds = [...new Set((Array.isArray(injections) ? injections : []).map(entry => entry?.frameId).filter(Number.isSafeInteger))];
  const runEntries = (Array.isArray(runs) ? runs : []).filter(entry => Number.isSafeInteger(entry?.frameId));
  const runByFrame = new Map(runEntries.map(entry => [entry.frameId, entry]));
  const frameIds = [...injectionIds, ...runEntries.map(entry => entry.frameId).filter(frameId => !injectionIds.includes(frameId))];
  const injectedFrames = new Set(injectionIds);
  const frames = [];
  const diagnostics = [];
  for (const frameId of frameIds) {
    if (!injectedFrames.has(frameId)) diagnostics.push(diagnostic('AXE_FRAME_TOPOLOGY_CHANGED', frameId));
    const entry = runByFrame.get(frameId);
    if (!entry) {
      frames.push({ frameId, status: 'missing' });
      diagnostics.push(diagnostic('AXE_FRAME_MISSING', frameId));
    } else if (!entry.result?.ok) {
      frames.push({ frameId, status: 'failed' });
      diagnostics.push(diagnostic(entry.result?.code === 'AXE_RUNTIME_UNAVAILABLE' ? 'AXE_FRAME_RUNTIME_UNAVAILABLE' : 'AXE_FRAME_RUN_FAILED', frameId));
    } else if (entry.result.version !== AXE_PROVENANCE.version) {
      frames.push({ frameId, status: 'failed' });
      diagnostics.push(diagnostic('AXE_VERSION_MISMATCH', frameId));
    } else {
      frames.push({ frameId, status: 'success', result: sanitizeAxeResults(entry.result.results) });
    }
  }
  return {
    status: diagnostics.length === 0 && frames.length > 0 ? 'complete' : 'partial',
    provenance: AXE_PROVENANCE,
    frames,
    diagnostics,
  };
}

export async function probeAxeInTab(tabId, { executeScript = defaultExecuteScript, timeoutMs = DEFAULT_TIMEOUT_MS, timers = DEFAULT_TIMERS } = {}) {
  if (!Number.isSafeInteger(tabId) || tabId < 0) throw new TypeError('O tabId do axe é inválido.');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000) throw new TypeError('O timeout do axe é inválido.');
  if (!timers || typeof timers.set !== 'function' || typeof timers.clear !== 'function') throw new TypeError('O timer do axe é inválido.');
  try {
    return await withTimeout(deadline => executeAxe(tabId, executeScript, deadline), timeoutMs, timers);
  } catch (error) {
    if (error?.name !== 'TimeoutError') throw error;
    return { status: 'partial', provenance: AXE_PROVENANCE, frames: [], diagnostics: [diagnostic('AXE_TIMEOUT')] };
  }
}

export async function runAxeInTab(tabId, options = {}) {
  if (!Number.isSafeInteger(tabId) || tabId < 0) throw new TypeError('O tabId do axe é inválido.');
  if (resolveAxeGateState(AXE_MV3_CSP_GATE) === 'disabled') {
    return {
      status: 'disabled',
      provenance: AXE_PROVENANCE,
      frames: [],
      diagnostics: [diagnostic('AXE_FEATURE_DISABLED')],
    };
  }
  return probeAxeInTab(tabId, options);
}

export function resolveAxeGateState(gate) {
  if (typeof gate?.enabled !== 'boolean' || typeof gate?.targetSizeEnabled !== 'boolean') {
    throw Object.assign(new TypeError('A configuração do gate axe é inválida.'), { code: 'AXE_MV3_CSP_GATE_INVALID' });
  }
  if (gate.enabled !== gate.targetSizeEnabled) {
    throw Object.assign(new TypeError('A configuração do gate axe é inválida.'), { code: 'AXE_MV3_CSP_GATE_INCONSISTENT' });
  }
  return gate.enabled ? 'enabled' : 'disabled';
}
