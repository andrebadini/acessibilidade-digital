import { redactSensitiveText } from '../core/privacy.js';

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
const MAX_TEXT = 512;
const DEFAULT_TIMEOUT_MS = 30_000;

function safeText(value, limit = MAX_TEXT) {
  return redactSensitiveText(typeof value === 'string' ? value : '').slice(0, limit);
}

function safeImpact(value) {
  return ['minor', 'moderate', 'serious', 'critical'].includes(value) ? value : null;
}

function sanitizeTarget(value, depth = 0) {
  if (typeof value === 'string') return safeText(value);
  if (!Array.isArray(value) || depth >= 3) return null;
  return value.slice(0, MAX_TARGET_PARTS).map(item => sanitizeTarget(item, depth + 1)).filter(item => item !== null);
}

function sanitizeCheck(check) {
  return {
    id: safeText(check?.id, 128),
    impact: safeImpact(check?.impact),
    message: safeText(check?.message),
  };
}

function sanitizeNode(node) {
  return {
    impact: safeImpact(node?.impact),
    target: sanitizeTarget(node?.target) ?? [],
    failureSummary: safeText(node?.failureSummary),
    any: (Array.isArray(node?.any) ? node.any : []).slice(0, MAX_CHECKS).map(sanitizeCheck),
    all: (Array.isArray(node?.all) ? node.all : []).slice(0, MAX_CHECKS).map(sanitizeCheck),
    none: (Array.isArray(node?.none) ? node.none : []).slice(0, MAX_CHECKS).map(sanitizeCheck),
  };
}

function sanitizeGroup(group) {
  return {
    id: safeText(group?.id, 128),
    impact: safeImpact(group?.impact),
    tags: (Array.isArray(group?.tags) ? group.tags : []).slice(0, MAX_TAGS).map(tag => safeText(tag, 128)),
    description: safeText(group?.description),
    help: safeText(group?.help),
    nodes: (Array.isArray(group?.nodes) ? group.nodes : []).slice(0, MAX_NODES).map(sanitizeNode),
  };
}

function sanitizeAxeResults(results) {
  const output = {};
  for (const name of ['violations', 'incomplete', 'passes', 'inapplicable']) {
    output[name] = (Array.isArray(results?.[name]) ? results[name] : []).slice(0, MAX_GROUPS).map(sanitizeGroup);
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

async function withTimeout(operation, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new DOMException('Tempo limite do axe excedido.', 'TimeoutError')), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function executeAxe(tabId, executeScript) {
  const target = { tabId, allFrames: true };
  let injections;
  try {
    injections = await executeScript({ target, world: 'ISOLATED', files: [AXE_PROVENANCE.runtimePath] });
  } catch {
    return { status: 'partial', provenance: AXE_PROVENANCE, frames: [], diagnostics: [diagnostic('AXE_INJECTION_FAILED')] };
  }
  let runs;
  try {
    runs = await executeScript({ target, world: 'ISOLATED', func: runAxeInFrame, args: [AXE_RUN_CONFIG] });
  } catch {
    return { status: 'partial', provenance: AXE_PROVENANCE, frames: [], diagnostics: [diagnostic('AXE_EXECUTION_FAILED')] };
  }

  const runByFrame = new Map((Array.isArray(runs) ? runs : []).filter(entry => Number.isSafeInteger(entry?.frameId)).map(entry => [entry.frameId, entry]));
  const frames = [];
  const diagnostics = [];
  for (const injection of Array.isArray(injections) ? injections : []) {
    if (!Number.isSafeInteger(injection?.frameId)) continue;
    const frameId = injection.frameId;
    const entry = runByFrame.get(frameId);
    if (!entry) {
      frames.push({ frameId, status: 'missing' });
      diagnostics.push(diagnostic('AXE_FRAME_MISSING', frameId));
    } else if (!entry.result?.ok) {
      frames.push({ frameId, status: 'failed' });
      diagnostics.push(diagnostic('AXE_FRAME_RUN_FAILED', frameId));
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

export async function probeAxeInTab(tabId, { executeScript = defaultExecuteScript, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!Number.isSafeInteger(tabId) || tabId < 0) throw new TypeError('O tabId do axe é inválido.');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000) throw new TypeError('O timeout do axe é inválido.');
  try {
    return await withTimeout(executeAxe(tabId, executeScript), timeoutMs);
  } catch (error) {
    if (error?.name !== 'TimeoutError') throw error;
    return { status: 'partial', provenance: AXE_PROVENANCE, frames: [], diagnostics: [diagnostic('AXE_TIMEOUT')] };
  }
}

export async function runAxeInTab(tabId, options = {}) {
  if (!Number.isSafeInteger(tabId) || tabId < 0) throw new TypeError('O tabId do axe é inválido.');
  if (!AXE_MV3_CSP_GATE.enabled) {
    return {
      status: 'disabled',
      provenance: AXE_PROVENANCE,
      frames: [],
      diagnostics: [diagnostic('AXE_FEATURE_DISABLED')],
    };
  }
  return probeAxeInTab(tabId, options);
}
