const PROTOCOL_VERSION = '1.3';

export function createCdpClient({ attach, detach, send }) {
  if (typeof attach !== 'function' || typeof detach !== 'function' || typeof send !== 'function') {
    throw new TypeError('O transporte CDP precisa fornecer attach, send e detach.');
  }

  let tabId;
  let connected = false;

  return {
    async connect(nextTabId) {
      if (!Number.isInteger(nextTabId)) throw new TypeError('O tabId do CDP é inválido.');
      if (connected) throw new Error('O CDP já está conectado.');
      await attach({ tabId: nextTabId }, PROTOCOL_VERSION);
      tabId = nextTabId;
      connected = true;
    },

    async command(method, params) {
      if (!connected) throw new Error('O CDP não está conectado.');
      if (typeof method !== 'string' || !method) throw new TypeError('O método CDP é inválido.');
      try {
        return await send({ tabId }, method, params);
      } catch (error) {
        await disconnectAfterCommandFailure(detach, tabId, error);
        tabId = undefined;
        connected = false;
        throw error;
      }
    },

    async disconnect() {
      if (!connected) return;
      const target = tabId;
      tabId = undefined;
      connected = false;
      await detach({ tabId: target });
    },
  };
}

async function disconnectAfterCommandFailure(detach, tabId, commandError) {
  try {
    await detach({ tabId });
  } catch {
    // The command failure is the useful error; the local client is disconnected either way.
  }
}

export function createChromeDebuggerTransport(chromeApi) {
  if (!chromeApi?.debugger) throw new TypeError('chrome.debugger não está disponível.');
  return {
    attach: (target, version) => chromeApi.debugger.attach(target, version),
    send: (target, method, params) => chromeApi.debugger.sendCommand(target, method, params),
    detach: (target) => chromeApi.debugger.detach(target),
  };
}
