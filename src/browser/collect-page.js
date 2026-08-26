import { collectRuntimePageData } from '../collector/page-collector.js';
import { redactSensitiveText } from '../core/privacy.js';

export const COMPUTED_STYLE_PROPERTIES = Object.freeze([
  'display', 'visibility', 'opacity', 'color', 'background-color',
  'background-image', 'font-size', 'font-weight', 'line-height',
  'letter-spacing', 'word-spacing', 'outline-color', 'outline-style',
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

  // Structural failures are fatal. Keep this sequence deterministic for an
  // auditable command log and never request cookies, storage or headers.
  const capturedDomSnapshot = await cdp.command('DOMSnapshot.captureSnapshot', {
    computedStyles: [...COMPUTED_STYLE_PROPERTIES],
    includeDOMRects: true,
    includePaintOrder: true
  });
  const domSnapshot = { ...capturedDomSnapshot, computedStyles: [...COMPUTED_STYLE_PROPERTIES] };
  const axTree = await cdp.command('Accessibility.getFullAXTree', {});
  const layoutMetrics = await cdp.command('Page.getLayoutMetrics', {});

  const warnings = [];
  let pageData = [];
  const executeScript = options.executeScript ?? defaultExecuteScript;
  try {
    const results = await executeScript({
      target: { tabId, allFrames: true },
      world: 'ISOLATED',
      func: collectRuntimePageData
    });
    pageData = Array.isArray(results) ? results.filter(entry => entry && !entry.error) : [];
    for (const entry of Array.isArray(results) ? results : []) {
      if (entry?.error) warnings.push({ code: 'FRAME_RUNTIME_BLOCKED', frameId: entry.frameId ?? null, message: redactSensitiveText(entry.error) });
    }
  } catch (error) {
    warnings.push({ code: 'FRAME_RUNTIME_BLOCKED', frameId: null, message: redactSensitiveText(error instanceof Error ? error.message : error) });
  }
  return { domSnapshot, axTree, layoutMetrics, pageData, warnings };
}
