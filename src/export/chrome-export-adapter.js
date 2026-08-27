import { createCdpClient, createChromeDebuggerTransport } from '../browser/cdp-client.js';

export function createExportTabAdapter(chromeApi) {
  if (!chromeApi?.tabs || !chromeApi?.debugger) throw new TypeError('APIs Chrome de exportação indisponíveis.');
  return {
    createPrintTab(options) { return invokeChrome(chromeApi, callback => chromeApi.tabs.create(options, callback)); },
    async waitForReady(tabId, { timeoutMs }) {
      await waitForComplete(chromeApi, tabId, timeoutMs);
    },
    async connectCdp(tabId, { commandTimeoutMs }) {
      const client = createCdpClient({ ...createChromeDebuggerTransport(chromeApi), commandTimeoutMs });
      await client.connect(tabId);
      return client;
    },
    async waitForAssets(cdp) {
      const response = await cdp.command('Runtime.evaluate', {
        expression: `Promise.all([
          document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve(),
          ...Array.from(document.images, image => image.complete ? Promise.resolve() : new Promise(resolve => {
            image.addEventListener('load', resolve, { once: true });
            image.addEventListener('error', resolve, { once: true });
          }))
        ]).then(() => true)`,
        awaitPromise: true,
        returnByValue: true,
      });
      if (response?.exceptionDetails || response?.result?.value !== true) throw new Error('A página de impressão não confirmou fontes e imagens prontas.');
    },
    removeTab(tabId) { return invokeChrome(chromeApi, callback => chromeApi.tabs.remove(tabId, callback)); },
  };
}

function waitForComplete(chromeApi, tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (handler, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chromeApi.tabs.onUpdated.removeListener(listener);
      handler(value);
    };
    const listener = (updatedId, changeInfo) => {
      if (updatedId === tabId && changeInfo?.status === 'complete') finish(resolve);
    };
    const timer = setTimeout(() => finish(reject, new DOMException('A aba de impressão excedeu o tempo limite.', 'TimeoutError')), timeoutMs);
    chromeApi.tabs.onUpdated.addListener(listener);
    invokeChrome(chromeApi, callback => chromeApi.tabs.get(tabId, callback)).then(tab => {
      if (tab?.status === 'complete') finish(resolve);
    }, error => finish(reject, error));
  });
}

function invokeChrome(chromeApi, invoke) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (handler, value) => {
      if (settled) return;
      settled = true;
      handler(value);
    };
    const callback = value => {
      const error = chromeApi.runtime?.lastError;
      if (error) finish(reject, new Error(error.message || 'Falha na API Chrome de exportação.'));
      else finish(resolve, value);
    };
    try {
      const result = invoke(callback);
      if (result && typeof result.then === 'function') result.then(value => finish(resolve, value), error => finish(reject, error));
    } catch (error) {
      finish(reject, error);
    }
  });
}
