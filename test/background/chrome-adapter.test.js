import assert from 'node:assert/strict';
import test from 'node:test';

import { AUDIT_EXECUTION_INTERNAL, captureFocusLocator, createChromeAdapter, resolveActiveNodeId, restoreFocusLocator } from '../../src/background/chrome-adapter.js';
import * as chromeAdapterModule from '../../src/background/chrome-adapter.js';

test('captures and restores focus for elements without DOM IDs', () => {
  const first = { localName: 'button', id: '', parentElement: null };
  const second = { localName: 'button', id: '', parentElement: null, focused: false, focus() { this.focused = true; } };
  const body = { localName: 'body', id: '', parentElement: null, children: [first, second] };
  first.parentElement = body;
  second.parentElement = body;
  const documentElement = { localName: 'html', id: '', parentElement: null, children: [body] };
  body.parentElement = documentElement;
  const root = { activeElement: second, documentElement, querySelector: selector => selector === 'body:nth-of-type(1) > button:nth-of-type(2)' ? second : null };
  const locator = captureFocusLocator(root);
  assert.equal(locator, 'body:nth-of-type(1) > button:nth-of-type(2)');
  assert.equal(restoreFocusLocator(locator, root), true);
  assert.equal(second.focused, true);
});

test('resolves the active element to the authoritative SnapshotV1 backend node ID', async () => {
  const calls = [];
  const cdp = {
    async command(method, params) {
      calls.push([method, params]);
      if (method === 'Runtime.evaluate') return { result: { objectId: 'remote-active' } };
      if (method === 'DOM.requestNode') return { nodeId: 12 };
      if (method === 'DOM.describeNode') return { node: { backendNodeId: 45 } };
      return {};
    },
  };
  assert.equal(await resolveActiveNodeId(cdp), 'n-45');
  assert.deepEqual(calls.map(([method]) => method), ['Runtime.evaluate', 'DOM.requestNode', 'DOM.describeNode', 'Runtime.releaseObject']);
});

function chromeFake() {
  const calls = [];
  const updated = {};
  const removed = {};
  const chromeApi = {
    runtime: { getURL: path => `chrome-extension://test/${path}`, sendMessage: async message => calls.push(['message', message]) },
    tabs: {
      create: async options => { calls.push(['create', options]); return { id: 17, ...options }; },
      update: async (id, options) => { calls.push(['update', id, options]); return { id, ...options }; },
      get: async id => ({ id, status: 'complete', url: 'https://example.test/final' }),
      remove: async id => calls.push(['remove', id]),
      onUpdated: { addListener(listener) { updated.listener = listener; }, removeListener() { updated.removed = true; } },
      onRemoved: { addListener(listener) { removed.listener = listener; }, removeListener() { removed.removed = true; } },
    },
    scripting: { executeScript: async options => { calls.push(['script', options.target]); return []; } },
    debugger: {
      attach: async (target, version) => calls.push(['attach', target, version]),
      sendCommand: async (_target, method) => {
        calls.push(['cdp', method]);
        if (method === 'Browser.getVersion') return { product: 'Chrome/140.0' };
        if (method === 'Runtime.evaluate') return { result: { value: { width: 1280, height: 720, deviceScaleFactor: 2 } } };
        return {};
      },
      detach: async target => calls.push(['detach', target]),
    },
    storage: { session: { async get() { return {}; }, async set() {}, async remove() {} } },
  };
  return { chromeApi, calls, updated, removed };
}

test('keeps the real session area and CSPRNG behind a non-enumerable execution contract', () => {
  const fake = chromeFake();
  const adapter = createChromeAdapter(fake.chromeApi);
  assert.equal(Object.keys(adapter).includes(String(AUDIT_EXECUTION_INTERNAL)), false);
  assert.equal(Object.getOwnPropertyDescriptor(adapter, AUDIT_EXECUTION_INTERNAL).enumerable, false);
  assert.equal(adapter[AUDIT_EXECUTION_INTERNAL].sessionArea, fake.chromeApi.storage.session);
  assert.equal(adapter[AUDIT_EXECUTION_INTERNAL].randomBytes(16).byteLength, 16);
});

test('composes the real adapter with exact single and batch worker overrides without exposing internals', () => {
  assert.equal(typeof chromeAdapterModule.composeChromeAdapter, 'function');
  const base = createChromeAdapter(chromeFake().chromeApi);
  const contract = base[AUDIT_EXECUTION_INTERNAL];
  const single = chromeAdapterModule.composeChromeAdapter(base, {
    async enterFinalization() {}, async handoffReport() {}, async emitProgress() {},
  });
  const batch = chromeAdapterModule.composeChromeAdapter(base, {
    tryEnterFinalization() { return true; }, async enterFinalization() {},
    async handoffReport() {}, async emitProgress() {},
  });
  for (const adapter of [single, batch]) {
    assert.equal(adapter[AUDIT_EXECUTION_INTERNAL], contract);
    assert.equal(Object.getOwnPropertyDescriptor(adapter, AUDIT_EXECUTION_INTERNAL).enumerable, false);
    assert.equal(Object.keys(adapter).some(key => /internal|session|random/iu.test(key)), false);
    assert.doesNotMatch(JSON.stringify(adapter), /sessionArea|randomBytes|audit-execution-internal/u);
  }
});

test('composed adapters reject symbols, accessors, extra overrides, and internal replacement', () => {
  const compose = (...args) => chromeAdapterModule.composeChromeAdapter?.(...args);
  const base = createChromeAdapter(chromeFake().chromeApi);
  const hostileSymbol = { async emitProgress() {} };
  hostileSymbol[Symbol('hostile')] = true;
  const accessor = {};
  Object.defineProperty(accessor, 'emitProgress', { enumerable: true, get() { throw new Error('GETTER_INVOKED'); } });
  for (const overrides of [
    hostileSymbol,
    accessor,
    { async emitProgress() {}, removeTab() {} },
    { [AUDIT_EXECUTION_INTERNAL]: {} },
  ]) assert.throws(() => compose(base, overrides), /AUDIT_ADAPTER_COMPOSITION_DENIED/u);

  let thirdArgumentReads = 0;
  const hostileAllowlist = [];
  Object.defineProperty(hostileAllowlist, '0', {
    enumerable: true,
    get() { thirdArgumentReads += 1; throw new Error('GETTER_INVOKED'); },
  });
  hostileAllowlist.length = 1;
  assert.throws(
    () => chromeAdapterModule.composeChromeAdapter(base, { removeTab() {} }, hostileAllowlist),
    /AUDIT_ADAPTER_COMPOSITION_DENIED/u,
  );
  assert.equal(thirdArgumentReads, 0);
});

test('snapshots every trusted base capability before an overrides Proxy can mutate the base', async () => {
  const base = createChromeAdapter(chromeFake().chromeApi);
  const trustedRemoveTab = base.removeTab;
  const trustedInternal = base[AUDIT_EXECUTION_INTERNAL];
  let hostileRemoveCalls = 0;
  const overrides = new Proxy({ async emitProgress() {} }, {
    getPrototypeOf(target) {
      base.removeTab = async () => { hostileRemoveCalls += 1; };
      return Reflect.getPrototypeOf(target);
    },
  });

  const composed = chromeAdapterModule.composeChromeAdapter(base, overrides);
  assert.equal(composed.removeTab, trustedRemoveTab);
  assert.equal(composed[AUDIT_EXECUTION_INTERNAL], trustedInternal);
  await composed.removeTab(17);
  assert.equal(hostileRemoveCalls, 0);
});

test('normalizes every hostile overrides introspection trap without disclosing its error', () => {
  const traps = ['getPrototypeOf', 'ownKeys', 'getOwnPropertyDescriptor'];
  for (const trap of traps) {
    const secret = `PRIVATE_${trap.toUpperCase()}`;
    const overrides = new Proxy({ async emitProgress() {} }, {
      [trap]() { throw new Error(secret); },
    });
    let caught;
    try { chromeAdapterModule.composeChromeAdapter(createChromeAdapter(chromeFake().chromeApi), overrides); }
    catch (error) { caught = error; }
    assert.equal(caught?.message, 'AUDIT_ADAPTER_COMPOSITION_DENIED');
    assert.doesNotMatch(String(caught), new RegExp(secret, 'u'));
  }
});

test('does not let mutable Set primordials authorize a trusted-capability override', () => {
  const OriginalSet = globalThis.Set;
  const originalSetHas = OriginalSet.prototype.has;
  const originalPrototype = Object.prototype;
  const base = createChromeAdapter(chromeFake().chromeApi);
  const trustedRemoveTab = base.removeTab;
  let caught;
  let composed;
  const overrides = new Proxy({ removeTab() {} }, {
    getPrototypeOf() {
      globalThis.Set = class HostileSet { has() { return true; } };
      OriginalSet.prototype.has = () => true;
      return originalPrototype;
    },
  });

  try {
    try { composed = chromeAdapterModule.composeChromeAdapter(base, overrides); }
    catch (error) { caught = error; }
  } finally {
    globalThis.Set = OriginalSet;
    OriginalSet.prototype.has = originalSetHas;
  }

  assert.equal(composed, undefined);
  assert.equal(caught?.constructor, TypeError);
  assert.equal(caught?.message, 'AUDIT_ADAPTER_COMPOSITION_DENIED');
  assert.equal(base.removeTab, trustedRemoveTab);
});

const primordialMutationCases = [
  {
    name: 'Object.defineProperty',
    mutate() { Object.defineProperty = () => { throw new Error('PRIVATE_OBJECT_DEFINE_PROPERTY'); }; },
    restore: (() => { const value = Object.defineProperty; return () => { Object.defineProperty = value; }; })(),
  },
  {
    name: 'Object.getOwnPropertyDescriptor',
    mutate() { Object.getOwnPropertyDescriptor = () => { throw new Error('PRIVATE_OBJECT_GET_DESCRIPTOR'); }; },
    restore: (() => { const value = Object.getOwnPropertyDescriptor; return () => { Object.getOwnPropertyDescriptor = value; }; })(),
  },
  {
    name: 'Object.getPrototypeOf',
    mutate() { Object.getPrototypeOf = () => { throw new Error('PRIVATE_OBJECT_GET_PROTOTYPE'); }; },
    restore: (() => { const value = Object.getPrototypeOf; return () => { Object.getPrototypeOf = value; }; })(),
  },
  {
    name: 'Object.hasOwn',
    mutate() { Object.hasOwn = () => { throw new Error('PRIVATE_OBJECT_HAS_OWN'); }; },
    restore: (() => { const value = Object.hasOwn; return () => { Object.hasOwn = value; }; })(),
  },
  {
    name: 'Object.create',
    mutate() { Object.create = () => { throw new Error('PRIVATE_OBJECT_CREATE'); }; },
    restore: (() => { const value = Object.create; return () => { Object.create = value; }; })(),
  },
  {
    name: 'Object.freeze',
    mutate() { Object.freeze = () => { throw new Error('PRIVATE_OBJECT_FREEZE'); }; },
    restore: (() => { const value = Object.freeze; return () => { Object.freeze = value; }; })(),
  },
  {
    name: 'Reflect.ownKeys',
    mutate() { Reflect.ownKeys = () => { throw new Error('PRIVATE_REFLECT_OWN_KEYS'); }; },
    restore: (() => { const value = Reflect.ownKeys; return () => { Reflect.ownKeys = value; }; })(),
  },
  {
    name: 'Array iterator',
    mutate() { Array.prototype[Symbol.iterator] = () => { throw new Error('PRIVATE_ARRAY_ITERATOR'); }; },
    restore: (() => { const value = Array.prototype[Symbol.iterator]; return () => { Array.prototype[Symbol.iterator] = value; }; })(),
  },
  {
    name: 'Array numeric prototype accessors',
    mutate() {
      Object.defineProperty(Array.prototype, '0', {
        configurable: true,
        get() { throw new Error('PRIVATE_ARRAY_NUMERIC_GETTER'); },
        set() { throw new Error('PRIVATE_ARRAY_NUMERIC_SETTER'); },
      });
    },
    restore: (() => {
      const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, '0');
      return () => {
        delete Array.prototype[0];
        if (descriptor) Object.defineProperty(Array.prototype, '0', descriptor);
      };
    })(),
  },
  {
    name: 'Array.some',
    mutate() { Array.prototype.some = () => { throw new Error('PRIVATE_ARRAY_SOME'); }; },
    restore: (() => { const value = Array.prototype.some; return () => { Array.prototype.some = value; }; })(),
  },
  {
    name: 'Array.map',
    mutate() { Array.prototype.map = () => { throw new Error('PRIVATE_ARRAY_MAP'); }; },
    restore: (() => { const value = Array.prototype.map; return () => { Array.prototype.map = value; }; })(),
  },
  {
    name: 'Array.push',
    mutate() { Array.prototype.push = () => { throw new Error('PRIVATE_ARRAY_PUSH'); }; },
    restore: (() => { const value = Array.prototype.push; return () => { Array.prototype.push = value; }; })(),
  },
];

for (const primordialCase of primordialMutationCases) {
  test(`captures ${primordialCase.name} before observing hostile overrides`, () => {
    const target = { async emitProgress() {} };
    const targetPrototype = Object.getPrototypeOf(target);
    const base = createChromeAdapter(chromeFake().chromeApi);
    const trustedRemoveTab = base.removeTab;
    let caught;
    let composed;
    const overrides = new Proxy(target, {
      getPrototypeOf() {
        primordialCase.mutate();
        return targetPrototype;
      },
    });

    try {
      try { composed = chromeAdapterModule.composeChromeAdapter(base, overrides); }
      catch (error) { caught = error; }
    } finally {
      primordialCase.restore();
    }

    assert.ifError(caught);
    assert.equal(composed.emitProgress, target.emitProgress);
    assert.equal(composed.removeTab, trustedRemoveTab);
    assert.equal(Object.getPrototypeOf(composed), null);
    assert.equal(Object.isFrozen(composed), true);
    assert.equal(Object.isExtensible(composed), false);
  });
}

test('uses the captured TypeError when hostile introspection replaces the global constructor', () => {
  const OriginalTypeError = globalThis.TypeError;
  class PrivateTypeError extends Error {}
  const targetPrototype = Object.prototype;
  const overrides = new Proxy({ removeTab() {} }, {
    getPrototypeOf() {
      globalThis.TypeError = PrivateTypeError;
      return targetPrototype;
    },
  });
  let caught;

  try {
    try { chromeAdapterModule.composeChromeAdapter(createChromeAdapter(chromeFake().chromeApi), overrides); }
    catch (error) { caught = error; }
  } finally {
    globalThis.TypeError = OriginalTypeError;
  }

  assert.equal(caught?.constructor, OriginalTypeError);
  assert.equal(caught?.message, 'AUDIT_ADAPTER_COMPOSITION_DENIED');
});

test('returns a null-prototype adapter despite Object.prototype pollution during introspection', () => {
  const pollutionKey = '__auditaHostileCapability__';
  const originalDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, pollutionKey);
  const target = { async emitProgress() {} };
  const targetPrototype = Object.prototype;
  const base = createChromeAdapter(chromeFake().chromeApi);
  const trustedRemoveTab = base.removeTab;
  const hostileCapability = () => 'hostile';
  let inheritedDuringComposition;
  let composed;

  try {
    const overrides = new Proxy(target, {
      getPrototypeOf() {
        Object.defineProperty(Object.prototype, pollutionKey, {
          configurable: true, enumerable: true, writable: true, value: hostileCapability,
        });
        return targetPrototype;
      },
    });
    composed = chromeAdapterModule.composeChromeAdapter(base, overrides);
    inheritedDuringComposition = composed[pollutionKey];
  } finally {
    if (originalDescriptor) Object.defineProperty(Object.prototype, pollutionKey, originalDescriptor);
    else delete Object.prototype[pollutionKey];
  }

  assert.equal(inheritedDuringComposition, undefined);
  assert.equal(Object.getPrototypeOf(composed), null);
  assert.equal(composed.removeTab, trustedRemoveTab);
  assert.equal(Object.hasOwn(composed, pollutionKey), false);
});

test('recaptures property descriptors without inherited get/set fields', () => {
  const originalGet = Object.getOwnPropertyDescriptor(Object.prototype, 'get');
  const originalSet = Object.getOwnPropertyDescriptor(Object.prototype, 'set');
  const defineProperty = Object.defineProperty;
  const getPollution = Object.create(null);
  getPollution.configurable = true;
  getPollution.value = () => { throw new Error('PRIVATE_INHERITED_GET'); };
  const setPollution = Object.create(null);
  setPollution.configurable = true;
  setPollution.value = () => { throw new Error('PRIVATE_INHERITED_SET'); };
  const target = { async emitProgress() {} };
  const targetPrototype = Object.prototype;
  let caught;
  let composed;

  try {
    const overrides = new Proxy(target, {
      getPrototypeOf() {
        defineProperty(Object.prototype, 'get', getPollution);
        defineProperty(Object.prototype, 'set', setPollution);
        return targetPrototype;
      },
    });
    try { composed = chromeAdapterModule.composeChromeAdapter(createChromeAdapter(chromeFake().chromeApi), overrides); }
    catch (error) { caught = error; }
  } finally {
    delete Object.prototype.get;
    delete Object.prototype.set;
    if (originalGet) defineProperty(Object.prototype, 'get', originalGet);
    if (originalSet) defineProperty(Object.prototype, 'set', originalSet);
  }

  assert.ifError(caught);
  assert.equal(composed.emitProgress, target.emitProgress);
  assert.equal(Object.getPrototypeOf(composed), null);
  assert.equal(Object.isFrozen(composed), true);
});

test('keeps scratch state isolated when an overrides trap reenters composition', () => {
  const base = createChromeAdapter(chromeFake().chromeApi);
  const trustedInternal = base[AUDIT_EXECUTION_INTERNAL];
  const innerEmitProgress = () => {};
  const outerEmitProgress = () => {};
  const target = { emitProgress: outerEmitProgress };
  const targetPrototype = Object.getPrototypeOf(target);
  let inner;
  const outer = chromeAdapterModule.composeChromeAdapter(base, new Proxy(target, {
    getPrototypeOf() {
      inner = chromeAdapterModule.composeChromeAdapter(base, { emitProgress: innerEmitProgress });
      return targetPrototype;
    },
  }));

  assert.equal(inner.emitProgress, innerEmitProgress);
  assert.equal(outer.emitProgress, outerEmitProgress);
  assert.notEqual(inner, outer);
  assert.equal(inner[AUDIT_EXECUTION_INTERNAL], trustedInternal);
  assert.equal(outer[AUDIT_EXECUTION_INTERNAL], trustedInternal);
  assert.equal(Object.getPrototypeOf(inner), null);
  assert.equal(Object.getPrototypeOf(outer), null);
  assert.equal(Object.isFrozen(inner), true);
  assert.equal(Object.isFrozen(outer), true);
});

test('returns an immutable exact-hook adapter that remains safely recomposable', () => {
  const base = createChromeAdapter(chromeFake().chromeApi);
  const trustedInternal = base[AUDIT_EXECUTION_INTERNAL];
  const firstHooks = {
    enterFinalization() {}, tryEnterFinalization() { return true; },
    handoffReport() {}, emitProgress() {},
  };
  const first = chromeAdapterModule.composeChromeAdapter(base, firstHooks);
  const secondEmitProgress = () => {};
  const second = chromeAdapterModule.composeChromeAdapter(first, { emitProgress: secondEmitProgress });

  for (const adapter of [first, second]) {
    assert.equal(Object.getPrototypeOf(adapter), null);
    assert.equal(Object.isFrozen(adapter), true);
    assert.equal(Object.isExtensible(adapter), false);
    assert.equal(adapter[AUDIT_EXECUTION_INTERNAL], trustedInternal);
    assert.equal(Object.getOwnPropertyDescriptor(adapter, AUDIT_EXECUTION_INTERNAL).enumerable, false);
    assert.throws(() => { adapter.untrustedCapability = () => {}; }, TypeError);
  }
  assert.equal(first.enterFinalization, firstHooks.enterFinalization);
  assert.equal(first.tryEnterFinalization, firstHooks.tryEnterFinalization);
  assert.equal(first.handoffReport, firstHooks.handoffReport);
  assert.equal(first.emitProgress, firstHooks.emitProgress);
  assert.equal(second.emitProgress, secondEmitProgress);
  assert.equal(second.enterFinalization, firstHooks.enterFinalization);
});

test('projects the real observed URL to its durable origin regardless of query authority', async () => {
  const fake = chromeFake();
  fake.chromeApi.tabs.get = async id => ({
    id, windowId: 9, status: 'complete',
    url: 'https://example.test/pessoa/CPF-123456789?case=7&secret=x#fragmento',
  });
  const adapter = createChromeAdapter(fake.chromeApi);
  assert.equal(await adapter.getEvidenceUrl(17, false), 'https://example.test/');
  assert.equal(await adapter.getEvidenceUrl(17, true), 'https://example.test/');
});

test('proves a fresh top document identity without returning its raw URL', async () => {
  const fake = chromeFake();
  fake.chromeApi.tabs.get = async id => ({ id, windowId: 9, status: 'complete', url: 'https://example.test/path?token=private#fragment' });
  fake.chromeApi.scripting.executeScript = async () => [{
    frameId: 0,
    documentId: 'target-document-1',
    result: 'https://example.test/path?token=private#fragment',
  }];
  const digested = [];
  const adapter = createChromeAdapter(fake.chromeApi, {
    sessionUrlDigestManager: {
      async digest(value) { digested.push(value); return `hmac-sha256:${'A'.repeat(43)}`; },
    },
  });
  const proof = await adapter.probeDocumentIdentity(17);
  assert.deepEqual(proof, {
    tabId: 17,
    windowId: 9,
    documentId: 'target-document-1',
    urlSessionDigest: `hmac-sha256:${'A'.repeat(43)}`,
  });
  assert.deepEqual(digested, ['https://example.test/path?token=private#fragment']);
  assert.doesNotMatch(JSON.stringify(proof), /private|example\.test/u);
});

test('rejects navigation or document replacement while HMAC digest is pending', async () => {
  const fake = chromeFake();
  let current = { url: 'https://example.test/before', documentId: 'document-before', status: 'complete' };
  let releaseDigest;
  let digestStarted = false;
  const digestGate = new Promise(resolve => { releaseDigest = resolve; });
  fake.chromeApi.tabs.get = async id => ({ id, windowId: 9, status: current.status, url: current.url });
  fake.chromeApi.scripting.executeScript = async () => [{
    frameId: 0,
    documentId: current.documentId,
    result: current.url,
  }];
  const adapter = createChromeAdapter(fake.chromeApi, {
    sessionUrlDigestManager: {
      async digest() {
        digestStarted = true;
        await digestGate;
        return `hmac-sha256:${'A'.repeat(43)}`;
      },
    },
  });
  const pending = adapter.probeDocumentIdentity(17);
  while (!digestStarted) await new Promise(resolve => setImmediate(resolve));
  current = { url: 'https://example.test/after', documentId: 'document-after', status: 'loading' };
  releaseDigest();
  await assert.rejects(() => pending, /TARGET_DOCUMENT_UNAVAILABLE/u);
});

test('rejects ambiguous, stale, or non-HTTP document probes', async () => {
  const fake = chromeFake();
  const manager = { async digest() { return `hmac-sha256:${'A'.repeat(43)}`; } };
  const adapter = createChromeAdapter(fake.chromeApi, { sessionUrlDigestManager: manager });
  fake.chromeApi.tabs.get = async id => ({ id, windowId: 9, status: 'complete', url: 'https://example.test/' });
  fake.chromeApi.scripting.executeScript = async () => [];
  await assert.rejects(() => adapter.probeDocumentIdentity(17), /TARGET_DOCUMENT_UNAVAILABLE/u);
  fake.chromeApi.scripting.executeScript = async () => [{ frameId: 0, documentId: 'doc-1', result: 'https://changed.test/' }];
  await assert.rejects(() => adapter.probeDocumentIdentity(17), /TARGET_DOCUMENT_UNAVAILABLE/u);
  fake.chromeApi.tabs.get = async id => ({ id, windowId: 9, status: 'complete', url: 'chrome://settings/' });
  fake.chromeApi.scripting.executeScript = async () => [{ frameId: 0, documentId: 'doc-1', result: 'chrome://settings/' }];
  await assert.rejects(() => adapter.probeDocumentIdentity(17), /TARGET_DOCUMENT_UNAVAILABLE/u);
});

test('rechecks the tab after script proof and rejects an interleaved navigation', async () => {
  const fake = chromeFake();
  const tabs = [
    { id: 17, windowId: 9, status: 'complete', url: 'https://example.test/before' },
    { id: 17, windowId: 9, status: 'complete', url: 'https://example.test/after' },
  ];
  fake.chromeApi.tabs.get = async () => tabs.shift();
  fake.chromeApi.scripting.executeScript = async () => [{
    frameId: 0,
    documentId: 'document-before',
    result: 'https://example.test/before',
  }];
  const adapter = createChromeAdapter(fake.chromeApi, {
    sessionUrlDigestManager: { async digest() { return `hmac-sha256:${'A'.repeat(43)}`; } },
  });
  await assert.rejects(() => adapter.probeDocumentIdentity(17), /TARGET_DOCUMENT_UNAVAILABLE/u);
});

test('creates, navigates, waits, scripts all frames, connects CDP and removes only the exact tab', async () => {
  const fake = chromeFake();
  const adapter = createChromeAdapter(fake.chromeApi);
  const tab = await adapter.createTab({ url: 'about:blank', active: false });
  await adapter.navigateTab(tab.id, 'https://example.test/');
  const stable = await adapter.waitForStable(tab.id, { timeoutMs: 50 });
  await adapter.executeScript({ target: { tabId: tab.id, allFrames: true }, func() {} });
  const cdp = await adapter.connectCdp(tab.id);
  assert.equal(typeof adapter.captureFullPage, 'function');
  assert.equal(typeof adapter.composeAnnouncementMap, 'function');
  assert.equal(typeof adapter.captureElement, 'function');
  const environment = await adapter.getEnvironment(tab.id, cdp);
  await cdp.disconnect();
  await adapter.removeTab(tab.id);
  assert.equal(stable.url, 'https://example.test/final');
  assert.deepEqual(environment, { chromeVersion: 'Chrome/140.0', viewport: { width: 1280, height: 720, deviceScaleFactor: 2 } });
  assert.ok(fake.calls.some(call => call[0] === 'script' && call[1].allFrames === true));
  assert.deepEqual(fake.calls.filter(call => call[0] === 'remove'), [['remove', 17]]);
  assert.deepEqual(fake.calls.filter(call => call[0] === 'detach'), [['detach', { tabId: 17 }]]);
});

test('times out a tab that never reaches complete and removes its listeners', async () => {
  const fake = chromeFake();
  fake.chromeApi.tabs.get = async id => ({ id, status: 'loading', url: 'https://example.test/' });
  const adapter = createChromeAdapter(fake.chromeApi);
  await assert.rejects(adapter.waitForStable(17, { timeoutMs: 5 }), error => error?.name === 'TimeoutError');
  assert.equal(fake.updated.removed, true);
  assert.equal(fake.removed.removed, true);
});

test('runs dynamic probes with viewport data captured inside the audited page', async () => {
  const fake = chromeFake();
  const scriptResults = [
    { scroll: { x: 0, y: 0 }, focus: '', styles: true, viewport: { deviceScaleFactor: 2 } },
    '', true, 0,
    {}, { selector: 'button', indicatorVisible: true, areaSufficient: true, intersectionRatio: 1, rect: { x: 0, y: 0, width: 44, height: 44 } },
    {}, { selector: 'button', indicatorVisible: true, areaSufficient: true, intersectionRatio: 1, rect: { x: 0, y: 0, width: 44, height: 44 } },
    { testedWidthCssPx: 320, horizontalOverflow: false, exception: 'unknown' },
    { scalePercent: 200, lossOfContent: false },
    [{ selector: 'html > body > button:nth-of-type(2)', width: 44, height: 44, exception: 'unknown' }],
    { complete: true, preference: 'reduce', prefersReducedMotion: true, animatedCount: 0, reducedAnimatedCount: 0 },
    true, true, true, true,
  ];
  fake.chromeApi.scripting.executeScript = async () => [{ frameId: 0, result: scriptResults.shift() }];
  const adapter = createChromeAdapter(fake.chromeApi);
  const cdpCalls = [];
  const cdp = {
    async command(method, params) {
      cdpCalls.push([method, params]);
      if (method === 'Page.getLayoutMetrics') return { cssLayoutViewport: { clientWidth: 1280, clientHeight: 720 } };
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main-frame' } } };
      if (method === 'DOM.getDocument') return { root: { nodeId: 100 } };
      if (method === 'DOM.querySelectorAll') return { nodeIds: [101] };
      if (method === 'DOM.describeNode') return { node: { backendNodeId: 42 } };
      return {};
    },
  };
  const result = await adapter.runDynamicProbes(17, cdp, {});
  assert.equal(result.focus.completed, true);
  assert.equal(result.warnings.length, 0);
  assert.deepEqual(result.targetSizes, [{ selector: 'html > body > button:nth-of-type(2)', frameId: 'main-frame', backendNodeId: 42, width: 44, height: 44, exception: 'unknown' }]);
  assert.deepEqual(cdpCalls.find(([method]) => method === 'DOM.querySelectorAll'), ['DOM.querySelectorAll', { nodeId: 100, selector: 'html > body > button:nth-of-type(2)' }]);
});

test('keeps selector and frame fallback when duplicate IDs prevent target backend identity proof', async () => {
  const fake = chromeFake();
  const scriptResults = [
    { scroll: { x: 0, y: 0 }, focus: '', styles: true, viewport: { deviceScaleFactor: 1 } },
    '', true, 0,
    {}, { selector: 'button', indicatorVisible: true, areaSufficient: true, intersectionRatio: 1, rect: { x: 0, y: 0, width: 44, height: 44 } },
    {}, { selector: 'button', indicatorVisible: true, areaSufficient: true, intersectionRatio: 1, rect: { x: 0, y: 0, width: 44, height: 44 } },
    { testedWidthCssPx: 320, horizontalOverflow: false, exception: 'unknown' },
    { scalePercent: 200, lossOfContent: false },
    [{ selector: '#duplicate', width: 20, height: 20, exception: 'unknown' }],
    { complete: true, preference: 'reduce', prefersReducedMotion: true, animatedCount: 0, reducedAnimatedCount: 0 },
    true, true, true, true,
  ];
  fake.chromeApi.scripting.executeScript = async () => [{ frameId: 0, result: scriptResults.shift() }];
  const adapter = createChromeAdapter(fake.chromeApi);
  const cdpCalls = [];
  const cdp = {
    async command(method, params) {
      cdpCalls.push([method, params]);
      if (method === 'Page.getLayoutMetrics') return { cssLayoutViewport: { clientWidth: 1280, clientHeight: 720 } };
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main-frame' } } };
      if (method === 'DOM.getDocument') return { root: { nodeId: 100 } };
      if (method === 'DOM.querySelector') return { nodeId: 101 };
      if (method === 'DOM.querySelectorAll') return { nodeIds: [101, 102] };
      if (method === 'DOM.describeNode') return { node: { backendNodeId: 42 } };
      return {};
    },
  };
  const result = await adapter.runDynamicProbes(17, cdp, {});
  assert.deepEqual(result.targetSizes, [{ selector: '#duplicate', frameId: 'main-frame', width: 20, height: 20, exception: 'unknown' }]);
  assert.equal(cdpCalls.some(([method]) => method === 'DOM.describeNode'), false);
});
