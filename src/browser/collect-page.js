import { collectRuntimePageData } from '../collector/page-collector.js';
import { sanitizeEvidenceUrl, sanitizeWarning } from '../core/privacy.js';

export const COMPUTED_STYLE_PROPERTIES = Object.freeze([
  'display', 'visibility', 'opacity', 'color', 'background-color',
  'background-image', 'font-size', 'font-weight', 'line-height',
  'letter-spacing', 'word-spacing', 'text-align', 'direction', 'outline-color', 'outline-style',
  'outline-width', 'box-shadow', 'text-decoration-color', 'overflow-x',
  'overflow-y', 'animation-duration', 'animation-iteration-count',
  'transition-duration'
]);

function defaultExecuteScript(options) {
  if (!globalThis.chrome?.scripting?.executeScript) {
    throw new Error('chrome.scripting.executeScript não está disponível.');
  }
  return globalThis.chrome.scripting.executeScript(options);
}

/** Collects structural CDP state plus best-effort per-frame runtime state. */
export async function collectPage(cdp, tabId, options = {}) {
  if (!cdp || typeof cdp.command !== 'function') throw new TypeError('O cliente CDP é inválido.');
  if (!Number.isInteger(tabId)) throw new TypeError('O tabId da coleta é inválido.');

  for (const domain of ['Page', 'DOM', 'Accessibility', 'Network']) {
    await cdp.command(`${domain}.enable`, {});
  }

  // Network is enabled to preserve the planned CDP domain set, but no network
  // event, request header, cookie, authentication or storage data is consumed.
  const frameTreeResult = await cdp.command('Page.getFrameTree', {});
  const expectedFrames = [];
  const seenFrameIds = new Set();
  const visitFrame = tree => {
    const frameId = typeof tree?.frame?.id === 'string' ? tree.frame.id : '';
    if (frameId && !seenFrameIds.has(frameId)) {
      seenFrameIds.add(frameId);
      expectedFrames.push({ frameId, url: sanitizeEvidenceUrl(tree.frame.url || '') });
    }
    for (const child of Array.isArray(tree?.childFrames) ? tree.childFrames : []) visitFrame(child);
  };
  visitFrame(frameTreeResult?.frameTree);

  // Structural DOM and layout failures are fatal. Keep this sequence
  // deterministic and never request cookies, storage or headers.
  const capturedDomSnapshot = await cdp.command('DOMSnapshot.captureSnapshot', {
    computedStyles: [...COMPUTED_STYLE_PROPERTIES],
    includeDOMRects: true,
    includePaintOrder: true
  });
  const domSnapshot = { ...capturedDomSnapshot, computedStyles: [...COMPUTED_STYLE_PROPERTIES] };
  const warnings = [];
  const axNodes = [];
  const axFrames = [];
  let observedAxFrames = 0;
  const framesForAx = expectedFrames.length > 0 ? expectedFrames : [{ frameId: null, url: '' }];
  for (const frame of framesForAx) {
    try {
      const response = await cdp.command('Accessibility.getFullAXTree', frame.frameId === null ? {} : { frameId: frame.frameId });
      const nodes = Array.isArray(response?.nodes) ? response.nodes : [];
      axNodes.push(...nodes);
      axFrames.push({ frameId: frame.frameId, nodes });
      observedAxFrames += 1;
    } catch {
      warnings.push(sanitizeWarning({ code: 'AX_FRAME_UNAVAILABLE', frameId: frame.frameId }));
    }
  }
  const axTree = { nodes: axNodes, frames: axFrames };
  const layoutMetrics = await cdp.command('Page.getLayoutMetrics', {});

  let pageData = [];
  const executeScript = options.executeScript ?? defaultExecuteScript;
  try {
    const results = await executeScript({
      target: { tabId, allFrames: true },
      world: 'ISOLATED',
      func: collectRuntimePageData
    });
    const extracted = safeScriptEntries(results);
    pageData = extracted.entries;
    if (extracted.malformed) warnings.push(sanitizeWarning({ code: 'FRAME_RUNTIME_BLOCKED', frameId: null }));
    for (const entry of extracted.blocked) {
      warnings.push(sanitizeWarning({ code: 'FRAME_RUNTIME_BLOCKED', frameId: ownData(entry, 'frameId') ?? null }));
    }
  } catch {
    warnings.push(sanitizeWarning({ code: 'FRAME_RUNTIME_BLOCKED', frameId: null }));
  }

  const observedFrameIds = new Set(pageData.map(entry => {
    const frameId = ownData(entry, 'frameId');
    return typeof frameId === 'string' ? frameId : '';
  }).filter(Boolean));
  const expectedByUrl = new Map();
  const observedByUrl = new Map();
  const addByUrl = (map, url, value) => {
    if (!url) return;
    const values = map.get(url) || [];
    values.push(value);
    map.set(url, values);
  };
  for (const frame of expectedFrames) addByUrl(expectedByUrl, frame.url, frame.frameId);
  for (const entry of pageData) {
    const result = ownData(entry, 'result');
    addByUrl(observedByUrl, sanitizeEvidenceUrl(ownData(result, 'url') || ''), entry);
  }
  let matchedRuntimeFrames = 0;
  for (const frame of expectedFrames) {
    const explicit = observedFrameIds.has(frame.frameId);
    const urlMatch = !explicit && frame.url && expectedByUrl.get(frame.url)?.length === 1 && observedByUrl.get(frame.url)?.length === 1;
    if (explicit || urlMatch) matchedRuntimeFrames += 1;
    else warnings.push(sanitizeWarning({ code: 'RUNTIME_FRAME_MISSING', frameId: frame.frameId }));
  }
  const expectedCount = framesForAx.length;
  const coverage = {
    runtime: {
      outcome: expectedFrames.length > 0 && matchedRuntimeFrames === expectedFrames.length ? 'complete' : 'partial',
      expectedFrameCount: expectedFrames.length,
      observedFrameCount: matchedRuntimeFrames
    },
    accessibility: {
      outcome: observedAxFrames === expectedCount ? 'complete' : 'partial',
      expectedFrameCount: expectedCount,
      observedFrameCount: observedAxFrames
    }
  };
  const widgetObservations = aggregateWidgetSignals(pageData, coverage.runtime.outcome);
  return { domSnapshot, axTree, layoutMetrics, pageData, warnings, coverage, widgetObservations };
}

function ownData(value, key) {
  try {
    const descriptor = value !== null && typeof value === 'object'
      ? Object.getOwnPropertyDescriptor(value, key)
      : null;
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function safeScriptEntries(value) {
  let length;
  try {
    if (!Array.isArray(value)) return { entries: [], blocked: [], malformed: true };
    length = ownData(value, 'length');
  } catch {
    return { entries: [], blocked: [], malformed: true };
  }
  if (!Number.isSafeInteger(length) || length < 0 || length > 256) {
    return { entries: [], blocked: [], malformed: true };
  }
  const entries = [];
  const blocked = [];
  let malformed = false;
  for (let index = 0; index < length; index += 1) {
    const entry = ownData(value, String(index));
    if (!entry || typeof entry !== 'object') {
      malformed = true;
      continue;
    }
    const error = ownData(entry, 'error');
    const result = ownData(entry, 'result');
    if (error !== undefined && error !== null && error !== false) blocked.push(entry);
    else if (result && typeof result === 'object') entries.push(entry);
    else malformed = true;
  }
  return { entries, blocked, malformed };
}

function aggregateWidgetSignals(pageData, runtimeCoverage) {
  const aggregate = {
    vlibras: { dom: false, script: false, global: false },
    'hand-talk': { dom: false, script: false, global: false },
  };
  let readable = Array.isArray(pageData);
  const length = readable ? ownData(pageData, 'length') : 0;
  readable &&= Number.isSafeInteger(length) && length >= 0 && length <= 256;
  for (let index = 0; readable && index < length; index += 1) {
    const entry = ownData(pageData, String(index));
    const result = ownData(entry, 'result');
    const signals = ownData(result, 'widgetSignals');
    for (const id of ['vlibras', 'hand-talk']) {
      const widget = ownData(signals, id);
      for (const field of ['dom', 'script', 'global']) {
        const value = ownData(widget, field);
        if (value === true) aggregate[id][field] = true;
        else if (value !== false) readable = false;
      }
    }
  }
  return {
    coverage: readable && runtimeCoverage === 'complete' ? 'complete' : readable ? 'partial' : 'unavailable',
    widgets: aggregate,
  };
}
