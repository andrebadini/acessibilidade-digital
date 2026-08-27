export const AXE_MV3_CSP_GATE = Object.freeze({
  enabled: false,
  targetSizeEnabled: false,
  code: 'AXE_MV3_CSP_E2E_UNAVAILABLE',
  testedBrowser: 'Chrome for Testing 151.0.7922.138',
});

export const AXE_RUN_CONFIG = Object.freeze({
  runOnly: Object.freeze({
    type: 'tag',
    values: Object.freeze(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']),
  }),
  rules: Object.freeze({ 'target-size': Object.freeze({ enabled: AXE_MV3_CSP_GATE.targetSizeEnabled }) }),
  resultTypes: Object.freeze(['violations', 'incomplete', 'passes', 'inapplicable']),
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

const MAX_GROUPS = 100;
const MAX_NODES = 100;
const MAX_CHECKS = 32;
const MAX_TAGS = 32;
const MAX_TARGET_PARTS = 16;
const DEFAULT_TIMEOUT_MS = 30_000;
const CATALOG_IDENTIFIER = /^[a-z][a-z0-9._:-]{0,127}$/iu;
const SELECTOR_ALLOWED_CHARACTERS = /^[a-z0-9():>\- \t]+$/iu;
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
const DEFAULT_TIMERS = Object.freeze({
  set: (callback, timeoutMs) => setTimeout(callback, timeoutMs),
  clear: timer => clearTimeout(timer),
});

export const AXE_TARGET_UNAVAILABLE = '[target-unavailable]';
const AXE_CATALOG_ID_UNAVAILABLE = 'axe-id-unavailable';

function safeCatalogIdentifier(value, fallback = null) {
  return typeof value === 'string' && CATALOG_IDENTIFIER.test(value) ? value : fallback;
}

function safeImpact(value) {
  return ['minor', 'moderate', 'serious', 'critical'].includes(value) ? value : null;
}

function safeSelectorCompound(compound) {
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

function sanitizeTarget(value, depth = 0) {
  if (typeof value === 'string') return sanitizeAxeStructuralSelector(value);
  if (!Array.isArray(value) || depth >= 3 || value.length === 0) return AXE_TARGET_UNAVAILABLE;
  return value.slice(0, MAX_TARGET_PARTS).map(item => sanitizeTarget(item, depth + 1));
}

function sanitizeCheck(check) {
  return {
    id: safeCatalogIdentifier(check?.id, AXE_CATALOG_ID_UNAVAILABLE),
    impact: safeImpact(check?.impact),
  };
}

function boundedCount(value, limit) {
  const original = Array.isArray(value) ? value.length : 0;
  const retained = Math.min(original, limit);
  return { original, retained, truncated: original > limit };
}

function sanitizeNode(node) {
  const any = Array.isArray(node?.any) ? node.any : [];
  const all = Array.isArray(node?.all) ? node.all : [];
  const none = Array.isArray(node?.none) ? node.none : [];
  return {
    impact: safeImpact(node?.impact),
    target: sanitizeTarget(node?.target),
    any: any.slice(0, MAX_CHECKS).map(sanitizeCheck),
    all: all.slice(0, MAX_CHECKS).map(sanitizeCheck),
    none: none.slice(0, MAX_CHECKS).map(sanitizeCheck),
    truncation: {
      any: boundedCount(any, MAX_CHECKS),
      all: boundedCount(all, MAX_CHECKS),
      none: boundedCount(none, MAX_CHECKS),
    },
  };
}

function sanitizeGroup(group) {
  const tags = Array.isArray(group?.tags) ? group.tags : [];
  const nodes = Array.isArray(group?.nodes) ? group.nodes : [];
  return {
    id: safeCatalogIdentifier(group?.id, AXE_CATALOG_ID_UNAVAILABLE),
    impact: safeImpact(group?.impact),
    tags: tags.slice(0, MAX_TAGS).map(tag => safeCatalogIdentifier(tag)).filter(Boolean),
    nodes: nodes.slice(0, MAX_NODES).map(sanitizeNode),
    truncation: {
      tags: boundedCount(tags, MAX_TAGS),
      nodes: boundedCount(nodes, MAX_NODES),
    },
  };
}

function sanitizeAxeResults(results) {
  const output = { truncation: {} };
  for (const name of ['violations', 'incomplete', 'passes', 'inapplicable']) {
    const groups = Array.isArray(results?.[name]) ? results[name] : [];
    output[name] = groups.slice(0, MAX_GROUPS).map(sanitizeGroup);
    output.truncation[name] = boundedCount(groups, MAX_GROUPS);
  }
  return output;
}

/** Runs inside each isolated frame after the separately packaged axe runtime is injected. */
export async function runAxeInFrame(config) {
  try {
    const engine = globalThis.axe;
    if (!engine || typeof engine.run !== 'function') return { ok: false, code: 'AXE_RUNTIME_UNAVAILABLE' };
    const results = await engine.run(globalThis.document, config);
    return { ok: true, version: engine.version, results };
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
    runs = await executeScript({ target, world: 'ISOLATED', func: runAxeInFrame, args: [AXE_RUN_CONFIG] });
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
