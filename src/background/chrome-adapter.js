import { collectPage } from '../browser/collect-page.js';
import { captureElement, captureFullPage } from '../browser/capture-evidence.js';
import { composeAnnouncementMapForProduction as composeAnnouncementMap } from '../browser/annotation-map.js';
import { createCdpClient, createChromeDebuggerTransport } from '../browser/cdp-client.js';
import { runDynamicProbes } from '../collector/dynamic-probes.js';
import { projectAuditResourceOrigin } from '../core/privacy.js';

export const AUDIT_EXECUTION_INTERNAL = Symbol('audita.audit-execution-internal');

const WORKER_OVERRIDE_NAMES = Object.freeze([
  'enterFinalization', 'tryEnterFinalization', 'handoffReport', 'emitProgress',
]);

function compositionDenied() {
  return new TypeError('AUDIT_ADAPTER_COMPOSITION_DENIED');
}

/** Copies a trusted adapter while preserving its single opaque execution contract. */
export function composeChromeAdapter(base, overrides) {
  if (arguments.length !== 2) throw compositionDenied();
  if (!base || typeof base !== 'object' || !overrides || typeof overrides !== 'object' ||
    (Object.getPrototypeOf(overrides) !== Object.prototype && Object.getPrototypeOf(overrides) !== null)) {
    throw compositionDenied();
  }
  let baseKeys;
  let overrideKeys;
  try {
    baseKeys = Reflect.ownKeys(base);
    overrideKeys = Reflect.ownKeys(overrides);
  } catch { throw compositionDenied(); }
  const internal = Object.getOwnPropertyDescriptor(base, AUDIT_EXECUTION_INTERNAL);
  if (!internal || internal.enumerable || !Object.hasOwn(internal, 'value') || internal.get || internal.set) throw compositionDenied();
  const allowed = new Set(WORKER_OVERRIDE_NAMES);
  if (overrideKeys.some(key => typeof key !== 'string' || !allowed.has(key))) throw compositionDenied();
  const composed = {};
  for (const key of baseKeys) {
    if (key === AUDIT_EXECUTION_INTERNAL) continue;
    if (typeof key !== 'string') throw compositionDenied();
    const descriptor = Object.getOwnPropertyDescriptor(base, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw compositionDenied();
    Object.defineProperty(composed, key, descriptor);
  }
  for (const key of overrideKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(overrides, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function') throw compositionDenied();
    Object.defineProperty(composed, key, descriptor);
  }
  Object.defineProperty(composed, AUDIT_EXECUTION_INTERNAL, {
    enumerable: false, configurable: false, writable: false, value: internal.value,
  });
  return composed;
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

export function createChromeAdapter(chromeApi, options = {}) {
  if (!chromeApi?.tabs || !chromeApi?.scripting || !chromeApi?.debugger || !chromeApi?.runtime) {
    throw new TypeError('As APIs Chrome de auditoria não estão disponíveis.');
  }
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

  const adapter = {
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
        return projectAuditResourceOrigin(rawUrl);
      } catch {
        return '';
      }
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
        const cleanup = () => {
          clearTimeout(timer);
          chromeApi.tabs.onUpdated.removeListener(onUpdated);
          chromeApi.tabs.onRemoved.removeListener(onRemoved);
          options.signal?.removeEventListener('abort', onAbort);
        };
        const finish = (handler, value) => { cleanup(); handler(value); };
        const onUpdated = (id, changeInfo, tab) => {
          if (id === tabId && (changeInfo.status === 'complete' || tab?.status === 'complete')) finish(resolve, tab);
        };
        const onRemoved = id => { if (id === tabId) finish(reject, new Error('A aba de auditoria foi fechada.')); };
        const onAbort = () => finish(reject, abortError(options.signal));
        chromeApi.tabs.onUpdated.addListener(onUpdated);
        chromeApi.tabs.onRemoved.addListener(onRemoved);
        options.signal?.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(() => finish(reject, timeoutError()), timeoutMs);
        void invoke(chromeApi, chromeApi.tabs, 'get', tabId).then(tab => {
          if (tab?.status === 'complete') finish(resolve, tab);
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
      const [version, viewport] = await Promise.all([
        cdp.command('Browser.getVersion', {}),
        cdp.command('Runtime.evaluate', { expression: '({width:innerWidth,height:innerHeight,deviceScaleFactor:devicePixelRatio})', returnByValue: true }),
      ]);
      const value = viewport?.result?.value || {};
      return { chromeVersion: String(version?.product || ''), viewport: { width: value.width, height: value.height, deviceScaleFactor: value.deviceScaleFactor } };
    },
    async getFinalUrl(tabId) { return (await invoke(chromeApi, chromeApi.tabs, 'get', tabId))?.url || ''; },
    async emitProgress(message) { await invoke(chromeApi, chromeApi.runtime, 'sendMessage', message); },
    async handoffReport(model) {
      return {
        reviewUrl: chromeApi.runtime.getURL(`src/review/index.html?auditId=${encodeURIComponent(model.auditId)}`),
        artifact: { status: 'pending', formats: [] },
      };
    },
    removeTab(tabId) { return invoke(chromeApi, chromeApi.tabs, 'remove', tabId); },
  };
  Object.defineProperty(adapter, AUDIT_EXECUTION_INTERNAL, {
    enumerable: false,
    value: Object.freeze({
      sessionArea: chromeApi.storage?.session,
      randomBytes(length) {
        const bytes = new Uint8Array(length);
        globalThis.crypto.getRandomValues(bytes);
        return bytes;
      },
      ...(options.capturePolicy ? { capturePolicy: options.capturePolicy } : {}),
      ...(options.privacyDecision ? { privacyDecision: options.privacyDecision } : {}),
      ...(options.privacyState ? { privacyState: options.privacyState } : {}),
      ...(options.consentAuthority ? { consentAuthority: options.consentAuthority } : {}),
      ...(options.resumePauseId ? { resumePauseId: options.resumePauseId } : {}),
      ...(options.onExecutionCheckpoint ? { onExecutionCheckpoint: options.onExecutionCheckpoint } : {}),
      ...(options.persistAuditModel ? { persistAuditModel: options.persistAuditModel } : {}),
    }),
  });
  return adapter;
}
