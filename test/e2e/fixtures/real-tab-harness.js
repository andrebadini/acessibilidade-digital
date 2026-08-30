const OPERATION = /^[A-Za-z0-9_-]{1,96}$/u;

function result(operationId, tabId, windowId, state) {
  return Object.freeze({ ok: true, operationId, tabId, windowId, state });
}

function safeOperation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !OPERATION.test(value.operationId ?? '')) {
    throw new TypeError('HARNESS_OPERATION_DENIED');
  }
  return value;
}

function once(event, predicate, operation) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let eventArgs;
    let operationSettled = false;
    let operationResult;
    const finish = (handler, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      event.removeListener(listener);
      handler(value);
    };
    const maybeSucceed = () => {
      if (eventArgs && operationSettled) finish(resolve, { eventArgs, operationResult });
    };
    const listener = (...args) => {
      let matched = false;
      try { matched = predicate(...args) === true; } catch { matched = false; }
      if (matched) {
        eventArgs = args;
        event.removeListener(listener);
        maybeSucceed();
      }
    };
    const timer = setTimeout(() => finish(reject, new Error('HARNESS_EVENT_TIMEOUT')), 15_000);
    event.addListener(listener);
    Promise.resolve().then(operation).then(value => {
      operationSettled = true;
      operationResult = value;
      maybeSucceed();
    }, error => finish(reject, error));
  });
}

async function create(operation) {
  if (typeof operation.url !== 'string' || typeof operation.active !== 'boolean') throw new TypeError('HARNESS_OPERATION_DENIED');
  const existing = new Set((await chrome.tabs.query({})).map(tab => tab.id));
  const { eventArgs: [observed], operationResult: created } = await once(chrome.tabs.onCreated,
    tab => Number.isSafeInteger(tab?.id) && !existing.has(tab.id) && [tab.url, tab.pendingUrl].includes(operation.url),
    () => chrome.tabs.create({ url: operation.url, active: operation.active }));
  if (!created || observed.id !== created.id) throw new TypeError('HARNESS_OPERATION_DENIED');
  const tab = await chrome.tabs.get(created.id);
  if (!Number.isSafeInteger(tab.id) || !Number.isSafeInteger(tab.windowId)) throw new TypeError('HARNESS_OPERATION_DENIED');
  return result(operation.operationId, tab.id, tab.windowId, tab.status === 'complete' ? 'complete' : 'created');
}

async function navigate(operation) {
  if (!Number.isSafeInteger(operation.tabId) || typeof operation.url !== 'string') throw new TypeError('HARNESS_OPERATION_DENIED');
  await once(chrome.tabs.onUpdated, (tabId, changeInfo) => tabId === operation.tabId && changeInfo.status === 'complete',
    () => chrome.tabs.update(operation.tabId, { url: operation.url }));
  const tab = await chrome.tabs.get(operation.tabId);
  if (tab.url !== operation.url) throw new TypeError('HARNESS_OPERATION_DENIED');
  return result(operation.operationId, tab.id, tab.windowId, 'complete');
}

async function activate(operation) {
  if (!Number.isSafeInteger(operation.tabId)) throw new TypeError('HARNESS_OPERATION_DENIED');
  const before = await chrome.tabs.get(operation.tabId);
  if (!before.active) {
    await once(chrome.tabs.onActivated, info => info.tabId === operation.tabId,
      () => chrome.tabs.update(operation.tabId, { active: true }));
  }
  const active = await chrome.tabs.query({ active: true, windowId: before.windowId });
  if (active.length !== 1 || active[0].id !== operation.tabId) throw new TypeError('HARNESS_OPERATION_DENIED');
  return result(operation.operationId, operation.tabId, before.windowId, 'active');
}

async function remove(operation) {
  if (!Number.isSafeInteger(operation.tabId)) throw new TypeError('HARNESS_OPERATION_DENIED');
  const before = await chrome.tabs.get(operation.tabId);
  await once(chrome.tabs.onRemoved, tabId => tabId === operation.tabId,
    () => chrome.tabs.remove(operation.tabId));
  return result(operation.operationId, operation.tabId, before.windowId, 'removed');
}

async function run(raw) {
  const operation = safeOperation(raw);
  if (operation.kind === 'create') return create(operation);
  if (operation.kind === 'navigate') return navigate(operation);
  if (operation.kind === 'activate') return activate(operation);
  if (operation.kind === 'remove') return remove(operation);
  throw new TypeError('HARNESS_OPERATION_DENIED');
}

Object.defineProperty(globalThis, '__auditaRealTabHarnessV1', {
  value: Object.freeze({ run }), enumerable: false, configurable: false, writable: false,
});
