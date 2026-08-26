import { collectPage } from '../browser/collect-page.js';
import { captureElement, captureFullPage } from '../browser/capture-evidence.js';
import { createCdpClient, createChromeDebuggerTransport } from '../browser/cdp-client.js';
import { runDynamicProbes } from '../collector/dynamic-probes.js';

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

export function createChromeAdapter(chromeApi) {
  if (!chromeApi?.tabs || !chromeApi?.scripting || !chromeApi?.debugger || !chromeApi?.runtime) {
    throw new TypeError('As APIs Chrome de auditoria não estão disponíveis.');
  }
  const executeScript = options => invoke(chromeApi, chromeApi.scripting, 'executeScript', options);
  const transport = createChromeDebuggerTransport(chromeApi);

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
        return executeOne(testedWidthCssPx => ({ testedWidthCssPx, horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth, exception: 'none' }), [width]);
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
      measureTargetSizes: () => executeOne(() => [...document.querySelectorAll('a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])')].map(element => {
        const rect = element.getBoundingClientRect();
        return { selector: element.id ? `#${CSS.escape(element.id)}` : element.localName, width: rect.width, height: rect.height, exception: 'none' };
      })),
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

  return {
    createTab(options) { return invoke(chromeApi, chromeApi.tabs, 'create', options); },
    navigateTab(tabId, url) { return invoke(chromeApi, chromeApi.tabs, 'update', tabId, { url }); },
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
}
