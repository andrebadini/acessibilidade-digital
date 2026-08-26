const PROTOCOL_VERSION = '1.3';
const DEFAULT_COMMAND_TIMEOUT_MS = 15_000;

export function createCdpClient({ attach, detach, send, commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS }) {
  if (typeof attach !== 'function' || typeof detach !== 'function' || typeof send !== 'function') {
    throw new TypeError('O transporte CDP precisa fornecer attach, send e detach.');
  }
  if (typeof commandTimeoutMs !== 'number' || !Number.isFinite(commandTimeoutMs) || commandTimeoutMs <= 0) {
    throw new TypeError('O timeout de comando CDP deve ser um número finito positivo.');
  }

  let queue = Promise.resolve();
  let connection = null;
  let detachFailure = null;

  const enqueue = (operation) => {
    const result = queue.then(operation, operation);
    queue = result.catch(() => {});
    return result;
  };
  const ensureUsable = () => {
    if (detachFailure) throw new Error('O CDP exige limpeza manual após falha ao desconectar.', { cause: detachFailure });
  };
  const release = async (record) => {
    if (!record || record.released) return;
    record.released = true;
    if (connection === record) connection = null;
    try {
      await detach(record.target);
    } catch (error) {
      detachFailure = error;
      throw error;
    }
  };

  return {
    connect(nextTabId) {
      return enqueue(async () => {
        if (!Number.isInteger(nextTabId)) throw new TypeError('O tabId do CDP é inválido.');
        ensureUsable();
        if (connection?.target.tabId === nextTabId) return;
        if (connection) await release(connection);
        const record = { target: { tabId: nextTabId }, released: false };
        await attach(record.target, PROTOCOL_VERSION);
        connection = record;
      });
    },
    command(method, params) {
      return enqueue(async () => {
        if (!connection) throw new Error('O CDP não está conectado.');
        ensureUsable();
        if (typeof method !== 'string' || !method) throw new TypeError('O método CDP é inválido.');
        return withTimeout(() => send(connection.target, method, params), commandTimeoutMs);
      });
    },
    disconnect() {
      return enqueue(async () => {
        if (detachFailure) return;
        await release(connection);
      });
    },
  };
}

function withTimeout(operation, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new DOMException('O comando CDP excedeu o tempo limite.', 'TimeoutError')), timeoutMs);
  });
  return Promise.race([Promise.resolve().then(operation), timeout]).finally(() => clearTimeout(timer));
}

export function createChromeDebuggerTransport(chromeApi) {
  if (!chromeApi?.debugger) throw new TypeError('chrome.debugger não está disponível.');
  return {
    attach: (target, version) => invokeChrome(chromeApi, (callback) => chromeApi.debugger.attach(target, version, callback)),
    send: (target, method, params) => invokeChrome(chromeApi, (callback) => chromeApi.debugger.sendCommand(target, method, params, callback)),
    detach: (target) => invokeChrome(chromeApi, (callback) => chromeApi.debugger.detach(target, callback)),
  };
}

function invokeChrome(chromeApi, invoke) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (handler, value) => {
      if (settled) return;
      settled = true;
      handler(value);
    };
    const callback = (result) => {
      const lastError = chromeApi.runtime?.lastError;
      if (lastError) settle(reject, new Error(lastError.message || 'Falha no chrome.debugger.'));
      else settle(resolve, result);
    };
    try {
      const result = invoke(callback);
      if (result && typeof result.then === 'function') result.then((value) => settle(resolve, value), (error) => settle(reject, error));
    } catch (error) {
      settle(reject, error);
    }
  });
}
