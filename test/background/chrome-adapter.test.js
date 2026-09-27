import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AUDIT_EXECUTION_INTERNAL,
  captureFocusLocator,
  createChromeAdapter as createChromeAdapterFromAuthority,
  createChromeAuditAuthority,
  resolveActiveNodeId,
  restoreFocusLocator,
} from '../../src/background/chrome-adapter.js';
import * as chromeAdapterModule from '../../src/background/chrome-adapter.js';
import { createCapturePolicyV1 } from '../../src/core/privacy/capture-policy.js';

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
      if (method === 'DOM.requestNode') throw new Error('No frontend DOM tree was initialized.');
      if (method === 'DOM.describeNode') {
        assert.deepEqual(params, { objectId: 'remote-active', depth: 0, pierce: true });
        return { node: { backendNodeId: 45 } };
      }
      return {};
    },
  };
  assert.equal(await resolveActiveNodeId(cdp), 'n-45');
  assert.deepEqual(calls.map(([method]) => method), ['Runtime.evaluate', 'DOM.describeNode', 'Runtime.releaseObject']);
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

function createChromeAdapter(chromeApi, rawOptions) {
  const authority = createChromeAuditAuthority(chromeApi);
  return arguments.length === 1
    ? createChromeAdapterFromAuthority(authority)
    : createChromeAdapterFromAuthority(authority, rawOptions);
}

test('captures installed extension version without keeping a mutable manifest reference', () => {
  const fake = chromeFake();
  const manifest = { version: '1.1.12', version_name: '1.1.12 beta 1' };
  fake.chromeApi.runtime.getManifest = () => manifest;
  const adapter = createChromeAdapter(fake.chromeApi);
  manifest.version = '9.9.9';
  assert.equal(adapter.manifestVersion, '1.1.12');
});

test('does not invent an installed extension version when Chrome provides none', () => {
  const fake = chromeFake();
  assert.equal(createChromeAdapter(fake.chromeApi).manifestVersion, 'não disponível');
});

test('waits for a quiet URL after load before freezing the observed document', async () => {
  const fake = chromeFake();
  let current = { id: 17, status: 'complete', url: 'https://example.test/' };
  fake.chromeApi.tabs.get = async () => ({ ...current });
  const adapter = createChromeAdapter(fake.chromeApi);
  let resolved = false;
  const pending = adapter.waitForStable(17, { timeoutMs: 2000 }).then(tab => { resolved = true; return tab; });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(resolved, false, 'load complete is not yet a stable URL');
  current = { ...current, url: 'https://example.test/?state=ready' };
  fake.updated.listener(17, { status: 'loading', url: current.url }, { ...current, status: 'loading' });
  fake.updated.listener(17, { status: 'complete' }, current);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(resolved, false, 'a same-document URL update must restart the quiet window');
  assert.equal((await pending).url, current.url);
  assert.equal(fake.updated.removed, true);
  assert.equal(fake.removed.removed, true);
});

test('keeps a closed session facade and CSPRNG behind a non-enumerable execution contract', () => {
  const fake = chromeFake();
  const adapter = createChromeAdapter(fake.chromeApi);
  const sessionArea = adapter[AUDIT_EXECUTION_INTERNAL].sessionArea;
  assert.equal(Object.keys(adapter).includes(String(AUDIT_EXECUTION_INTERNAL)), false);
  assert.equal(Object.getOwnPropertyDescriptor(adapter, AUDIT_EXECUTION_INTERNAL).enumerable, false);
  assert.notEqual(sessionArea, fake.chromeApi.storage.session);
  assert.equal(Object.getPrototypeOf(sessionArea), null);
  assert.equal(Object.isFrozen(sessionArea), true);
  assert.deepEqual(Reflect.ownKeys(sessionArea).sort(), ['get', 'remove', 'set']);
  assert.equal(adapter[AUDIT_EXECUTION_INTERNAL].randomBytes(16).byteLength, 16);
});

test('invokes receiver-branded StorageArea methods on the captured native session object', async () => {
  const fake = chromeFake();
  const calls = [];
  const nativeSession = {
    async get(key) {
      assert.equal(this, nativeSession);
      calls.push(['get', key]);
      return {};
    },
    async set(value) {
      assert.equal(this, nativeSession);
      calls.push(['set', value]);
    },
    async remove(key) {
      assert.equal(this, nativeSession);
      calls.push(['remove', key]);
    },
  };
  fake.chromeApi.storage.session = nativeSession;

  const sessionArea = createChromeAdapter(fake.chromeApi)[AUDIT_EXECUTION_INTERNAL].sessionArea;
  await sessionArea.get('owned-key');
  await sessionArea.set({ 'owned-key': { state: 'created' } });
  await sessionArea.remove('owned-key');

  assert.notEqual(sessionArea, nativeSession);
  assert.equal(Object.getPrototypeOf(sessionArea), null);
  assert.equal(Object.isFrozen(sessionArea), true);
  assert.deepEqual(calls, [
    ['get', 'owned-key'],
    ['set', { 'owned-key': { state: 'created' } }],
    ['remove', 'owned-key'],
  ]);
});

test('invokes receiver-branded Chrome Event methods on their captured native event objects', async () => {
  const fake = chromeFake();
  const calls = [];
  const updatedEvent = {
    addListener(listener) {
      assert.equal(this, updatedEvent);
      calls.push(['updated-add', typeof listener]);
    },
    removeListener(listener) {
      assert.equal(this, updatedEvent);
      calls.push(['updated-remove', typeof listener]);
    },
  };
  const removedEvent = {
    addListener(listener) {
      assert.equal(this, removedEvent);
      calls.push(['removed-add', typeof listener]);
    },
    removeListener(listener) {
      assert.equal(this, removedEvent);
      calls.push(['removed-remove', typeof listener]);
    },
  };
  fake.chromeApi.tabs.onUpdated = updatedEvent;
  fake.chromeApi.tabs.onRemoved = removedEvent;
  fake.chromeApi.tabs.get = async id => ({ id, status: 'complete', url: 'https://example.test/' });

  const adapter = createChromeAdapter(fake.chromeApi);
  await adapter.waitForStable(17, { timeoutMs: 1000 });

  assert.deepEqual(calls, [
    ['updated-add', 'function'], ['removed-add', 'function'],
    ['updated-remove', 'function'], ['removed-remove', 'function'],
  ]);
});

test('publishes only the explicit Task 3C execution dependencies', () => {
  const fake = chromeFake();
  const capturePolicy = createCapturePolicyV1({ mode: 'full-evidence', includeQuery: false });
  const sessionUrlDigestManager = Object.freeze({ async digest() { return `hmac-sha256:${'A'.repeat(43)}`; } });
  const onExecutionCheckpoint = async () => {};
  const persistAuditModel = async () => {};
  const adapter = createChromeAdapter(fake.chromeApi, {
    sessionUrlDigestManager,
    capturePolicy,
    onExecutionCheckpoint,
    persistAuditModel,
  });
  const internal = adapter[AUDIT_EXECUTION_INTERNAL];

  assert.deepEqual(
    [...Reflect.ownKeys(internal)].sort(),
    ['capturePolicy', 'onExecutionCheckpoint', 'persistAuditModel', 'randomBytes', 'sessionArea', 'snapshotAttachedCopySource'].sort(),
  );
  assert.notEqual(internal.capturePolicy, capturePolicy);
  assert.deepEqual({ ...internal.capturePolicy }, capturePolicy);
  assert.equal(Object.getPrototypeOf(internal.capturePolicy), null);
  assert.equal(Object.isFrozen(internal.capturePolicy), true);
  assert.equal(internal.onExecutionCheckpoint, onExecutionCheckpoint);
  assert.equal(internal.persistAuditModel, persistAuditModel);
  assert.equal(Object.hasOwn(internal, 'sessionUrlDigestManager'), false);
  assert.deepEqual(fake.calls, []);
});

test('rejects a mutable capture policy instead of publishing authority that can drift', () => {
  const mutablePolicy = {
    ...createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
  };
  assert.throws(
    () => createChromeAdapter(chromeFake().chromeApi, { capturePolicy: mutablePolicy }),
    error => error?.constructor === TypeError && error.message === 'AUDIT_ADAPTER_OPTIONS_DENIED',
  );
});

test('rejects an evil policy when its Proxy replaces the downstream descriptor validator', () => {
  const originalGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
  const safePolicy = createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false });
  const target = {
    version: 'CapturePolicyV1',
    mode: 'evil-mode',
    includeQuery: false,
    captureFullPage: false,
    captureElements: false,
    composeAnnouncementMap: false,
  };
  let ownKeysCalls = 0;
  const policy = new Proxy(target, {
    ownKeys(value) {
      ownKeysCalls += 1;
      Object.getOwnPropertyDescriptor = (object, key) => {
        if (object !== policy && Object.hasOwn(safePolicy, key)) {
          return {
            configurable: false,
            enumerable: true,
            writable: false,
            value: safePolicy[key],
          };
        }
        return originalGetOwnPropertyDescriptor(object, key);
      };
      return Reflect.ownKeys(value);
    },
  });
  let adapter;
  let caught;

  try {
    try { adapter = createChromeAdapter(chromeFake().chromeApi, { capturePolicy: policy }); }
    catch (error) { caught = error; }
  } finally {
    Object.getOwnPropertyDescriptor = originalGetOwnPropertyDescriptor;
  }

  assert.equal(adapter, undefined);
  assert.equal(caught?.constructor, TypeError);
  assert.equal(caught?.message, 'AUDIT_ADAPTER_OPTIONS_DENIED');
  assert.equal(ownKeysCalls, 1);
});

test('accepts canonical snapshots for every CapturePolicyV1 mode', () => {
  for (const mode of ['full-evidence', 'element-only', 'no-pixels']) {
    const policy = createCapturePolicyV1({ mode, includeQuery: true });
    const snapshot = createChromeAdapter(chromeFake().chromeApi, {
      capturePolicy: policy,
    })[AUDIT_EXECUTION_INTERNAL].capturePolicy;
    assert.notEqual(snapshot, policy);
    assert.deepEqual({ ...snapshot }, policy);
    assert.equal(Object.getPrototypeOf(snapshot), null);
    assert.equal(Object.isFrozen(snapshot), true);
  }
});

test('snapshots every top-level option before a nested manager can replace a sibling policy', () => {
  const initialPolicy = createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false });
  const replacementPolicy = createCapturePolicyV1({ mode: 'full-evidence', includeQuery: true });
  const managerTarget = Object.freeze({
    async digest() { return `hmac-sha256:${'A'.repeat(43)}`; },
  });
  let nestedOwnKeys = 0;
  let options;
  const manager = new Proxy(managerTarget, {
    ownKeys(target) {
      nestedOwnKeys += 1;
      options.capturePolicy = replacementPolicy;
      return Reflect.ownKeys(target);
    },
  });
  options = {
    sessionUrlDigestManager: manager,
    capturePolicy: initialPolicy,
  };

  const snapshot = createChromeAdapter(chromeFake().chromeApi, options)[AUDIT_EXECUTION_INTERNAL].capturePolicy;

  assert.equal(nestedOwnKeys, 1);
  assert.equal(options.capturePolicy, replacementPolicy);
  assert.deepEqual({ ...snapshot }, initialPolicy);
});

test('rejects a mutable policy when nested manager introspection mutates it in place', () => {
  const expectedPolicy = createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false });
  const mutablePolicy = { ...expectedPolicy };
  const replacementPolicy = createCapturePolicyV1({ mode: 'full-evidence', includeQuery: true });
  const managerTarget = {
    async digest() { return `hmac-sha256:${'A'.repeat(43)}`; },
  };
  let nestedOwnKeys = 0;
  const manager = new Proxy(managerTarget, {
    ownKeys(target) {
      nestedOwnKeys += 1;
      Object.assign(mutablePolicy, replacementPolicy);
      return Reflect.ownKeys(target);
    },
  });
  const options = {
    sessionUrlDigestManager: manager,
    capturePolicy: mutablePolicy,
  };

  let adapter;
  let caught;
  try { adapter = createChromeAdapter(chromeFake().chromeApi, options); }
  catch (error) { caught = error; }

  assert.equal(nestedOwnKeys, 1);
  assert.deepEqual(mutablePolicy, replacementPolicy);
  assert.equal(adapter, undefined);
  assert.equal(caught?.constructor, TypeError);
  assert.equal(caught?.message, 'AUDIT_ADAPTER_OPTIONS_DENIED');
});

test('rejects cross-mutated policy after the closed top-level descriptor phase', () => {
  const expectedPolicy = createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false });
  const mutablePolicy = { ...expectedPolicy };
  const replacementPolicy = createCapturePolicyV1({ mode: 'full-evidence', includeQuery: true });
  const target = {
    sessionUrlDigestManager: {
      async digest() { return `hmac-sha256:${'A'.repeat(43)}`; },
    },
    capturePolicy: mutablePolicy,
  };
  const descriptorOrder = [];
  const options = new Proxy(target, {
    ownKeys() { return ['sessionUrlDigestManager', 'capturePolicy']; },
    getOwnPropertyDescriptor(value, key) {
      descriptorOrder.push(key);
      if (key === 'sessionUrlDigestManager') Object.assign(mutablePolicy, replacementPolicy);
      return Reflect.getOwnPropertyDescriptor(value, key);
    },
  });

  let adapter;
  let caught;
  try { adapter = createChromeAdapter(chromeFake().chromeApi, options); }
  catch (error) { caught = error; }

  assert.deepEqual(descriptorOrder, ['capturePolicy', 'sessionUrlDigestManager']);
  assert.deepEqual(mutablePolicy, replacementPolicy);
  assert.equal(adapter, undefined);
  assert.equal(caught?.constructor, TypeError);
  assert.equal(caught?.message, 'AUDIT_ADAPTER_OPTIONS_DENIED');
});

test('captures every top-level dependency before policy introspection can replace siblings', async () => {
  const fake = chromeFake();
  const rawUrl = 'https://example.test/original-authority';
  fake.chromeApi.tabs.get = async id => ({ id, windowId: 9, status: 'complete', url: rawUrl });
  fake.chromeApi.scripting.executeScript = async () => [{
    frameId: 0,
    documentId: 'top-level-snapshot-document',
    result: rawUrl,
  }];
  let originalDigests = 0;
  let evilDigests = 0;
  const originalManager = Object.freeze({
    async digest() { originalDigests += 1; return `hmac-sha256:${'A'.repeat(43)}`; },
  });
  const evilManager = Object.freeze({
    async digest() { evilDigests += 1; return `hmac-sha256:${'B'.repeat(43)}`; },
  });
  const originalCheckpoint = async () => {};
  const originalPersist = async () => {};
  const evilCheckpoint = async () => {};
  const evilPersist = async () => {};
  let policyOwnKeys = 0;
  let options;
  const policy = new Proxy(
    createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    {
      ownKeys(target) {
        policyOwnKeys += 1;
        options.sessionUrlDigestManager = evilManager;
        options.onExecutionCheckpoint = evilCheckpoint;
        options.persistAuditModel = evilPersist;
        return Reflect.ownKeys(target);
      },
    },
  );
  options = {
    capturePolicy: policy,
    sessionUrlDigestManager: originalManager,
    onExecutionCheckpoint: originalCheckpoint,
    persistAuditModel: originalPersist,
  };

  const adapter = createChromeAdapter(fake.chromeApi, options);
  const internal = adapter[AUDIT_EXECUTION_INTERNAL];
  const proof = await adapter.probeDocumentIdentity(17);

  assert.equal(policyOwnKeys, 1);
  assert.equal(options.sessionUrlDigestManager, evilManager);
  assert.equal(options.onExecutionCheckpoint, evilCheckpoint);
  assert.equal(options.persistAuditModel, evilPersist);
  assert.equal(internal.onExecutionCheckpoint, originalCheckpoint);
  assert.equal(internal.persistAuditModel, originalPersist);
  assert.equal(proof.urlSessionDigest, `hmac-sha256:${'A'.repeat(43)}`);
  assert.equal(originalDigests, 1);
  assert.equal(evilDigests, 0);
});

test('rejects accessor and Proxy Chrome envelopes by descriptor before observing raw options', async t => {
  const cases = [
    ['tabs accessor', fake => {
      let reads = 0;
      Object.defineProperty(fake.chromeApi, 'tabs', {
        configurable: true,
        enumerable: true,
        get() { reads += 1; throw new Error('PRIVATE_TABS_GETTER'); },
      });
      return { chromeApi: fake.chromeApi, reads: () => reads };
    }],
    ['storage accessor', fake => {
      let reads = 0;
      Object.defineProperty(fake.chromeApi, 'storage', {
        configurable: true,
        enumerable: true,
        get() { reads += 1; throw new Error('PRIVATE_STORAGE_GETTER'); },
      });
      return { chromeApi: fake.chromeApi, reads: () => reads };
    }],
    ['session accessor', fake => {
      let reads = 0;
      Object.defineProperty(fake.chromeApi.storage, 'session', {
        configurable: true,
        enumerable: true,
        get() { reads += 1; throw new Error('PRIVATE_SESSION_GETTER'); },
      });
      return { chromeApi: fake.chromeApi, reads: () => reads };
    }],
    ['root descriptor trap', fake => ({
      chromeApi: new Proxy(fake.chromeApi, {
        getOwnPropertyDescriptor() { throw new Error('PRIVATE_ROOT_DESCRIPTOR'); },
      }),
      reads: () => 0,
    })],
    ['storage descriptor trap', fake => {
      fake.chromeApi.storage = new Proxy(fake.chromeApi.storage, {
        getOwnPropertyDescriptor() { throw new Error('PRIVATE_STORAGE_DESCRIPTOR'); },
      });
      return { chromeApi: fake.chromeApi, reads: () => 0 };
    }],
  ];

  for (const [name, prepare] of cases) {
    await t.test(name, () => {
      const fake = chromeFake();
      const hostile = prepare(fake);
      let optionOwnKeys = 0;
      const options = new Proxy({}, {
        ownKeys(target) {
          optionOwnKeys += 1;
          return Reflect.ownKeys(target);
        },
      });
      let adapter;
      let caught;
      try { adapter = createChromeAdapter(hostile.chromeApi, options); }
      catch (error) { caught = error; }

      assert.equal(adapter, undefined);
      assert.equal(caught?.constructor, TypeError);
      assert.equal(caught?.message, 'As APIs Chrome de auditoria não estão disponíveis.');
      assert.doesNotMatch(String(caught), /PRIVATE_/u);
      assert.equal(hostile.reads(), 0);
      assert.equal(optionOwnKeys, 0);
      assert.deepEqual(fake.calls, []);
    });
  }
});

test('rejects an unbranded Chrome graph before a tabs trap can replace session methods', () => {
  const fake = chromeFake();
  const trustedSession = fake.chromeApi.storage.session;
  const safeGet = trustedSession.get;
  const safeSet = trustedSession.set;
  const safeRemove = trustedSession.remove;
  const evilSession = {
    async get() { return { private: true }; },
    async set() {},
    async remove() {},
  };
  let tabsDescriptors = 0;
  let optionOwnKeys = 0;
  const chromeApi = new Proxy(fake.chromeApi, {
    getOwnPropertyDescriptor(target, key) {
      if (key === 'tabs') {
        tabsDescriptors += 1;
        trustedSession.get = evilSession.get;
        trustedSession.set = evilSession.set;
        trustedSession.remove = evilSession.remove;
      }
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
  const options = new Proxy({}, {
    ownKeys(target) {
      optionOwnKeys += 1;
      return Reflect.ownKeys(target);
    },
  });

  assert.throws(
    () => createChromeAdapterFromAuthority(chromeApi, options),
    error => error?.constructor === TypeError &&
      error.message === 'As APIs Chrome de auditoria não estão disponíveis.',
  );
  assert.equal(tabsDescriptors, 0);
  assert.equal(optionOwnKeys, 0);
  assert.equal(trustedSession.get, safeGet);
  assert.equal(trustedSession.set, safeSet);
  assert.equal(trustedSession.remove, safeRemove);
  assert.deepEqual(fake.calls, []);
});

test('rejects an unbranded Chrome graph before a scripting trap can replace tabs methods', () => {
  const fake = chromeFake();
  const safeCreate = fake.chromeApi.tabs.create;
  const safeGet = fake.chromeApi.tabs.get;
  const safeRemove = fake.chromeApi.tabs.remove;
  const evilTabs = {
    async create() { return { id: 99 }; },
    async get(id) { return { id, url: 'https://evil.example/' }; },
    async remove() {},
  };
  let scriptingDescriptors = 0;
  let optionOwnKeys = 0;
  const chromeApi = new Proxy(fake.chromeApi, {
    getOwnPropertyDescriptor(target, key) {
      if (key === 'scripting') {
        scriptingDescriptors += 1;
        target.tabs.create = evilTabs.create;
        target.tabs.get = evilTabs.get;
        target.tabs.remove = evilTabs.remove;
      }
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
  const options = new Proxy({}, {
    ownKeys(target) {
      optionOwnKeys += 1;
      return Reflect.ownKeys(target);
    },
  });

  assert.throws(
    () => createChromeAdapterFromAuthority(chromeApi, options),
    error => error?.constructor === TypeError &&
      error.message === 'As APIs Chrome de auditoria não estão disponíveis.',
  );
  assert.equal(scriptingDescriptors, 0);
  assert.equal(optionOwnKeys, 0);
  assert.equal(fake.chromeApi.tabs.create, safeCreate);
  assert.equal(fake.chromeApi.tabs.get, safeGet);
  assert.equal(fake.chromeApi.tabs.remove, safeRemove);
  assert.deepEqual(fake.calls, []);
});

test('trusted bootstrap mints a closed Chrome authority for normal adapter use', async () => {
  const fake = chromeFake();
  const authorityFactory = chromeAdapterModule.createChromeAuditAuthority;

  assert.equal(typeof authorityFactory, 'function');
  const authority = authorityFactory(fake.chromeApi);
  const adapter = createChromeAdapterFromAuthority(authority);
  const created = await adapter.createTab({ active: false });
  const finalUrl = await adapter.getFinalUrl(17);
  await adapter.removeTab(17);

  assert.equal(Object.getPrototypeOf(authority), null);
  assert.equal(Object.isFrozen(authority), true);
  assert.deepEqual(Reflect.ownKeys(authority).sort(), ['debugger', 'runtime', 'scripting', 'storage', 'tabs']);
  assert.equal(created.id, 17);
  assert.equal(finalUrl, 'https://example.test/final');
  assert.deepEqual(fake.calls.filter(call => ['create', 'remove'].includes(call[0])), [
    ['create', { active: false }],
    ['remove', 17],
  ]);
});

test('captures every root namespace before a session method descriptor can replace tabs', async () => {
  const fake = chromeFake();
  const safeCalls = [];
  const evilCalls = [];
  fake.chromeApi.tabs.create = async options => {
    safeCalls.push(['create', options]);
    return { id: 17, ...options };
  };
  fake.chromeApi.tabs.get = async id => {
    safeCalls.push(['get', id]);
    return { id, status: 'complete', url: 'https://safe.example/root-phase' };
  };
  fake.chromeApi.tabs.remove = async id => { safeCalls.push(['remove', id]); };
  const evilTabs = {
    ...fake.chromeApi.tabs,
    async create(options) { evilCalls.push(['create', options]); return { id: 99, ...options }; },
    async get(id) { evilCalls.push(['get', id]); return { id, url: 'https://evil.example/' }; },
    async remove(id) { evilCalls.push(['remove', id]); },
  };
  const sessionTarget = fake.chromeApi.storage.session;
  let getDescriptors = 0;
  fake.chromeApi.storage.session = new Proxy(sessionTarget, {
    getOwnPropertyDescriptor(target, key) {
      if (key === 'get') {
        getDescriptors += 1;
        fake.chromeApi.tabs = evilTabs;
      }
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });

  const adapter = createChromeAdapter(fake.chromeApi);
  const created = await adapter.createTab({ active: false });
  const finalUrl = await adapter.getFinalUrl(17);
  await adapter.removeTab(17);

  assert.equal(getDescriptors, 2);
  assert.equal(created.id, 17);
  assert.equal(finalUrl, 'https://safe.example/root-phase');
  assert.deepEqual(safeCalls, [
    ['create', { active: false }],
    ['get', 17],
    ['remove', 17],
  ]);
  assert.deepEqual(evilCalls, []);
});

test('fails closed when the create descriptor replaces sibling tabs methods between passes', () => {
  const fake = chromeFake();
  const safeCalls = [];
  const evilCalls = [];
  const tabsTarget = fake.chromeApi.tabs;
  tabsTarget.create = async options => {
    safeCalls.push(['create', options]);
    return { id: 17, ...options };
  };
  tabsTarget.update = async (id, options) => {
    safeCalls.push(['update', id, options]);
    return { id, ...options };
  };
  tabsTarget.get = async id => {
    safeCalls.push(['get', id]);
    return { id, status: 'complete', url: 'https://safe.example/tabs-phase' };
  };
  tabsTarget.remove = async id => { safeCalls.push(['remove', id]); };
  const evil = {
    async update(id, options) { evilCalls.push(['update', id, options]); return { id, ...options }; },
    async get(id) { evilCalls.push(['get', id]); return { id, url: 'https://evil.example/' }; },
    async remove(id) { evilCalls.push(['remove', id]); },
  };
  let createDescriptors = 0;
  fake.chromeApi.tabs = new Proxy(tabsTarget, {
    getOwnPropertyDescriptor(target, key) {
      if (key === 'create') {
        createDescriptors += 1;
        target.update = evil.update;
        target.get = evil.get;
        target.remove = evil.remove;
      }
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });

  let adapter;
  let caught;
  try { adapter = createChromeAdapter(fake.chromeApi); }
  catch (error) { caught = error; }

  assert.equal(createDescriptors, 2);
  assert.equal(adapter, undefined);
  assert.equal(caught?.constructor, TypeError);
  assert.equal(caught?.message, 'As APIs Chrome de auditoria não estão disponíveis.');
  assert.deepEqual(safeCalls, []);
  assert.deepEqual(evilCalls, []);
});

test('rejects a mutated native StorageArea graph before invoking a captured method', async () => {
  const fake = chromeFake();
  const safeCalls = [];
  const evilCalls = [];
  const trustedSession = {
    async get(key) { safeCalls.push(['get', key]); return this.remove(key); },
    async set(value) { safeCalls.push(['set', value]); },
    async remove(key) { safeCalls.push(['remove', key]); return { safe: key }; },
  };
  fake.chromeApi.storage.session = trustedSession;
  const options = new Proxy({}, {
    ownKeys(target) {
      trustedSession.remove = async key => { evilCalls.push(['remove', key]); return { evil: key }; };
      return Reflect.ownKeys(target);
    },
  });

  const sessionArea = createChromeAdapter(fake.chromeApi, options)[AUDIT_EXECUTION_INTERNAL].sessionArea;
  assert.throws(
    () => sessionArea.get('closed-key'),
    error => error?.constructor === TypeError && error.message === 'As APIs Chrome de auditoria não estão disponíveis.',
  );

  assert.deepEqual(safeCalls, []);
  assert.deepEqual(evilCalls, []);
});

test('publishes an exact frozen null-prototype execution contract immune to inherited policies', () => {
  const pollution = {
    capturePolicy: createCapturePolicyV1({ mode: 'full-evidence', includeQuery: true }),
    privacyDecision: Object.freeze({ status: 'authorized' }),
    privacyState: Object.freeze({ state: 'paused' }),
    consentAuthority: Object.freeze({ consume() { return true; } }),
    resumePauseId: 'private-pause-id',
  };
  const descriptors = new Map();
  let internal;
  let inherited;
  try {
    for (const [key, value] of Object.entries(pollution)) {
      descriptors.set(key, Object.getOwnPropertyDescriptor(Object.prototype, key));
      Object.defineProperty(Object.prototype, key, {
        configurable: true, enumerable: true, writable: true, value,
      });
    }
    internal = createChromeAdapter(chromeFake().chromeApi)[AUDIT_EXECUTION_INTERNAL];
    inherited = Object.fromEntries(Object.keys(pollution).map(key => [key, internal[key]]));
  } finally {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(Object.prototype, key, descriptor);
      else delete Object.prototype[key];
    }
  }

  assert.equal(Object.getPrototypeOf(internal), null);
  assert.equal(Object.isFrozen(internal), true);
  assert.deepEqual(Reflect.ownKeys(internal).sort(), ['randomBytes', 'sessionArea', 'snapshotAttachedCopySource']);
  assert.deepEqual(inherited, {
    capturePolicy: undefined,
    privacyDecision: undefined,
    privacyState: undefined,
    consentAuthority: undefined,
    resumePauseId: undefined,
  });
});

test('publishes with captured primordials after hostile option reentrancy mutates globals', () => {
  const originalCreate = Object.create;
  const originalDefineProperty = Object.defineProperty;
  const originalFreeze = Object.freeze;
  const originalOwnKeys = Reflect.ownKeys;
  const innerFake = chromeFake();
  const outerFake = chromeFake();
  let inner;
  let outer;
  let caught;
  let ownKeysCalls = 0;
  const options = new Proxy({}, {
    ownKeys(target) {
      ownKeysCalls += 1;
      Object.create = () => { throw new Error('PRIVATE_OBJECT_CREATE'); };
      Object.defineProperty = () => { throw new Error('PRIVATE_OBJECT_DEFINE_PROPERTY'); };
      Object.freeze = () => { throw new Error('PRIVATE_OBJECT_FREEZE'); };
      Reflect.ownKeys = () => { throw new Error('PRIVATE_REFLECT_OWN_KEYS'); };
      inner = createChromeAdapter(innerFake.chromeApi);
      return originalOwnKeys(target);
    },
  });

  try {
    try { outer = createChromeAdapter(outerFake.chromeApi, options); }
    catch (error) { caught = error; }
  } finally {
    Object.create = originalCreate;
    Object.defineProperty = originalDefineProperty;
    Object.freeze = originalFreeze;
    Reflect.ownKeys = originalOwnKeys;
  }

  assert.ifError(caught);
  assert.equal(ownKeysCalls, 1);
  for (const adapter of [inner, outer]) {
    const internal = adapter[AUDIT_EXECUTION_INTERNAL];
    assert.equal(Object.getPrototypeOf(internal), null);
    assert.equal(Object.isFrozen(internal), true);
    assert.deepEqual(Reflect.ownKeys(internal).sort(), ['randomBytes', 'sessionArea', 'snapshotAttachedCopySource']);
  }
  assert.deepEqual(innerFake.calls, []);
  assert.deepEqual(outerFake.calls, []);
});

test('rejects every present invalid Task 3C dependency before publication', async t => {
  let digestGetterReads = 0;
  const digestAccessor = {};
  Object.defineProperty(digestAccessor, 'digest', {
    enumerable: true,
    get() {
      digestGetterReads += 1;
      throw new Error('PRIVATE_DIGEST_GETTER');
    },
  });
  const invalid = [
    ['sessionUrlDigestManager undefined', { sessionUrlDigestManager: undefined }],
    ['sessionUrlDigestManager null', { sessionUrlDigestManager: null }],
    ['sessionUrlDigestManager without digest', { sessionUrlDigestManager: {} }],
    ['sessionUrlDigestManager accessor digest', { sessionUrlDigestManager: digestAccessor }],
    ['sessionUrlDigestManager extra key', { sessionUrlDigestManager: { digest() {}, extra: true } }],
    ['capturePolicy undefined', { capturePolicy: undefined }],
    ['capturePolicy null', { capturePolicy: null }],
    ['capturePolicy malformed', { capturePolicy: {} }],
    ['onExecutionCheckpoint undefined', { onExecutionCheckpoint: undefined }],
    ['onExecutionCheckpoint null', { onExecutionCheckpoint: null }],
    ['onExecutionCheckpoint non-function', { onExecutionCheckpoint: {} }],
    ['persistAuditModel undefined', { persistAuditModel: undefined }],
    ['persistAuditModel null', { persistAuditModel: null }],
    ['persistAuditModel non-function', { persistAuditModel: {} }],
  ];

  for (const [name, options] of invalid) {
    await t.test(name, () => {
      const fake = chromeFake();
      let adapter;
      let caught;
      try { adapter = createChromeAdapter(fake.chromeApi, options); }
      catch (error) { caught = error; }
      assert.equal(adapter, undefined);
      assert.equal(caught?.constructor, TypeError);
      assert.equal(caught?.message, 'AUDIT_ADAPTER_OPTIONS_DENIED');
      assert.deepEqual(fake.calls, []);
    });
  }
  assert.equal(digestGetterReads, 0);
});

test('rejects retired execution options before publication without reading hostile accessors', async t => {
  const retired = ['privacyDecision', 'privacyState', 'consentAuthority', 'resumePauseId'];
  for (const key of retired) {
    await t.test(`${key} data property`, () => {
      const fake = chromeFake();
      let adapter;
      assert.throws(() => {
        adapter = createChromeAdapter(fake.chromeApi, { [key]: Object.freeze({ legacy: true }) });
      }, TypeError);
      assert.equal(adapter, undefined);
      assert.deepEqual(fake.calls, []);
    });

    await t.test(`${key} accessor`, () => {
      const fake = chromeFake();
      const options = {};
      let reads = 0;
      Object.defineProperty(options, key, {
        enumerable: true,
        get() {
          reads += 1;
          throw new Error(`PRIVATE_${key.toUpperCase()}`);
        },
      });
      let adapter;
      let caught;
      try { adapter = createChromeAdapter(fake.chromeApi, options); }
      catch (error) { caught = error; }
      assert.equal(adapter, undefined);
      assert.equal(caught instanceof TypeError, true);
      assert.doesNotMatch(String(caught), /PRIVATE_/u);
      assert.equal(reads, 0);
      assert.deepEqual(fake.calls, []);
    });
  }
});

test('rejects symbolic adapter options without evaluating them or publishing an adapter', () => {
  const fake = chromeFake();
  const options = {};
  let reads = 0;
  Object.defineProperty(options, Symbol('hostile-option'), {
    enumerable: true,
    get() {
      reads += 1;
      throw new Error('PRIVATE_SYMBOL_VALUE');
    },
  });
  let adapter;
  let caught;
  try { adapter = createChromeAdapter(fake.chromeApi, options); }
  catch (error) { caught = error; }

  assert.equal(adapter, undefined);
  assert.equal(caught instanceof TypeError, true);
  assert.doesNotMatch(String(caught), /PRIVATE_SYMBOL_VALUE/u);
  assert.equal(reads, 0);
  assert.deepEqual(fake.calls, []);
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

test('projects the real observed URL to its sanitized path without query authority', async () => {
  const fake = chromeFake();
  fake.chromeApi.tabs.get = async id => ({
    id, windowId: 9, status: 'complete',
    url: 'https://example.test/pessoa/CPF-123456789?case=7&secret=x#fragmento',
  });
  const adapter = createChromeAdapter(fake.chromeApi);
  assert.equal(await adapter.getEvidenceUrl(17, false), 'https://example.test/pessoa/:redacted-2');
  assert.equal(await adapter.getEvidenceUrl(17, true), 'https://example.test/pessoa/:redacted-2');
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
    sessionUrlDigestManager: Object.freeze({
      async digest(value) { digested.push(value); return `hmac-sha256:${'A'.repeat(43)}`; },
    }),
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

test('probes sensitive capture signals only in the exact enumerated documents', async () => {
  const fake = chromeFake();
  const scriptTargets = [];
  const immediate = [];
  fake.chromeApi.scripting.executeScript = async options => {
    scriptTargets.push(options.target);
    immediate.push(options.injectImmediately);
    if (options.target.allFrames === true) {
      return [
        { frameId: 0, documentId: 'document-main', result: null },
        { frameId: 3, documentId: 'document-child', result: null },
      ];
    }
    return [
      {
        frameId: 0,
        documentId: 'document-main',
        result: { password: false, otp: false, payment: false, privateMarker: false },
      },
      {
        frameId: 3,
        documentId: 'document-child',
        result: { password: true, otp: false, payment: true, privateMarker: false },
      },
    ];
  };

  const signals = await createChromeAdapter(fake.chromeApi).probeSensitiveCaptureSignals(17, 'document-main');

  assert.deepEqual(signals, {
    version: 'SensitiveCaptureSignalsV1',
    detected: true,
    categories: ['password', 'payment'],
  });
  assert.deepEqual(scriptTargets, [
    { tabId: 17, allFrames: true },
    { tabId: 17, documentIds: ['document-main', 'document-child'] },
  ]);
  // Iframe lazy fora da tela (portal institucional real, 1.1.52): sem injeção imediata a chamada nunca volta e a auditoria trava.
  assert.deepEqual(immediate, [true, true]);
});

test('rejects a hostile document enumeration without reading its array values', async () => {
  const fake = chromeFake();
  let reads = 0;
  const hostileFrames = [];
  Object.defineProperty(hostileFrames, '0', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return { frameId: 0, documentId: 'document-main', result: null };
    },
  });
  hostileFrames.length = 1;
  fake.chromeApi.scripting.executeScript = async () => hostileFrames;

  await assert.rejects(
    () => createChromeAdapter(fake.chromeApi).probeSensitiveCaptureSignals(17, 'document-main'),
    /SENSITIVE_CONTEXT_PROBE_UNAVAILABLE/u,
  );
  assert.equal(reads, 0);
});

test('rejects a sensitive probe when the enumerated main document is not the expected document', async () => {
  const fake = chromeFake();
  let scripts = 0;
  fake.chromeApi.scripting.executeScript = async () => {
    scripts += 1;
    return [{ frameId: 0, documentId: 'replacement-document', result: null }];
  };

  await assert.rejects(
    () => createChromeAdapter(fake.chromeApi).probeSensitiveCaptureSignals(17, 'expected-document'),
    /SENSITIVE_CONTEXT_PROBE_UNAVAILABLE/u,
  );
  assert.equal(scripts, 1);
});

test('rejects a mutable digest manager whose digest descriptor injects a URL-receiving destroy', async () => {
  const fake = chromeFake();
  const rawUrl = 'https://example.test/private-digest-descriptor';
  fake.chromeApi.tabs.get = async id => ({ id, windowId: 9, status: 'complete', url: rawUrl });
  fake.chromeApi.scripting.executeScript = async () => [{
    frameId: 0,
    documentId: 'target-document-hostile-manager-descriptor',
    result: rawUrl,
  }];
  const leakedUrls = [];
  let digestDescriptors = 0;
  const target = {
    async digest(value) { return this.destroy(value); },
    async destroy() { return `hmac-sha256:${'A'.repeat(43)}`; },
  };
  const manager = new Proxy(target, {
    getOwnPropertyDescriptor(value, key) {
      if (key === 'digest') {
        digestDescriptors += 1;
        value.destroy = async url => {
          leakedUrls.push(url);
          return `hmac-sha256:${'B'.repeat(43)}`;
        };
      }
      return Reflect.getOwnPropertyDescriptor(value, key);
    },
  });
  let adapter;
  let caught;
  try { adapter = createChromeAdapter(fake.chromeApi, { sessionUrlDigestManager: manager }); }
  catch (error) { caught = error; }
  if (adapter) {
    try { await adapter.probeDocumentIdentity(17); } catch { /* Rejection is acceptable, disclosure is not. */ }
  }

  assert.equal(digestDescriptors, 1);
  assert.equal(adapter, undefined);
  assert.equal(caught?.constructor, TypeError);
  assert.equal(caught?.message, 'AUDIT_ADAPTER_OPTIONS_DENIED');
  assert.deepEqual(leakedUrls, []);
});

test('captures and binds an immutable null-prototype digest manager', async () => {
  const fake = chromeFake();
  fake.chromeApi.tabs.get = async id => ({ id, windowId: 9, status: 'complete', url: 'https://example.test/path' });
  fake.chromeApi.scripting.executeScript = async () => [{
    frameId: 0,
    documentId: 'target-document-bound',
    result: 'https://example.test/path',
  }];
  const manager = Object.create(null);
  let receiver;
  let calls = 0;
  manager.digest = async function digest(value) {
    receiver = this;
    calls += 1;
    assert.equal(value, 'https://example.test/path');
    return `hmac-sha256:${'A'.repeat(43)}`;
  };
  manager.destroy = async () => {};
  Object.freeze(manager);
  const adapter = createChromeAdapter(fake.chromeApi, { sessionUrlDigestManager: manager });

  const proof = await adapter.probeDocumentIdentity(17);

  assert.equal(calls, 1);
  assert.notEqual(receiver, manager);
  assert.equal(Object.getPrototypeOf(receiver), null);
  assert.equal(Object.isFrozen(receiver), true);
  assert.deepEqual(Reflect.ownKeys(receiver), ['digest', 'destroy']);
  assert.equal(proof.urlSessionDigest, `hmac-sha256:${'A'.repeat(43)}`);
});

test('binds immutable digest and destroy to one frozen receiver', async () => {
  const fake = chromeFake();
  const rawUrl = 'https://example.test/private-path';
  fake.chromeApi.tabs.get = async id => ({ id, windowId: 9, status: 'complete', url: rawUrl });
  fake.chromeApi.scripting.executeScript = async () => [{
    frameId: 0,
    documentId: 'target-document-isolated-manager',
    result: rawUrl,
  }];
  let safeDestroyCalls = 0;
  let safeReceiver;
  const leakedUrls = [];
  const manager = Object.freeze({
    async digest(value) { return this.destroy(value); },
    async destroy(value) {
      safeDestroyCalls += 1;
      safeReceiver = this;
      assert.equal(value, rawUrl);
      return `hmac-sha256:${'A'.repeat(43)}`;
    },
  });
  const adapter = createChromeAdapter(fake.chromeApi, { sessionUrlDigestManager: manager });

  const proof = await adapter.probeDocumentIdentity(17);

  assert.equal(safeDestroyCalls, 1);
  assert.deepEqual(leakedUrls, []);
  assert.equal(Object.getPrototypeOf(safeReceiver), null);
  assert.equal(Object.isFrozen(safeReceiver), true);
  assert.deepEqual(Reflect.ownKeys(safeReceiver), ['digest', 'destroy']);
  assert.equal(proof.urlSessionDigest, `hmac-sha256:${'A'.repeat(43)}`);
});

test('captures trusted session and CSPRNG primordials before hostile raw-option introspection', () => {
  const fake = chromeFake();
  const trustedSession = fake.chromeApi.storage.session;
  const hostileSession = Object.freeze({ async get() { return {}; }, async set() {}, async remove() {} });
  const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const OriginalUint8Array = globalThis.Uint8Array;
  let hostileAllocations = 0;
  let hostileRandomCalls = 0;
  let optionOwnKeys = 0;
  class HostileUint8Array extends OriginalUint8Array {
    constructor(length) {
      super(length);
      hostileAllocations += 1;
    }
  }
  const hostileCrypto = {
    getRandomValues(bytes) {
      hostileRandomCalls += 1;
      bytes.fill(0);
      return bytes;
    },
  };
  const options = new Proxy({}, {
    ownKeys(target) {
      optionOwnKeys += 1;
      fake.chromeApi.storage.session = hostileSession;
      Object.defineProperty(globalThis, 'crypto', {
        configurable: true,
        enumerable: true,
        writable: true,
        value: hostileCrypto,
      });
      globalThis.Uint8Array = HostileUint8Array;
      return Reflect.ownKeys(target);
    },
  });
  let internal;
  let bytes;
  let caught;

  try {
    try {
      internal = createChromeAdapter(fake.chromeApi, options)[AUDIT_EXECUTION_INTERNAL];
      bytes = internal.randomBytes(16);
    } catch (error) { caught = error; }
  } finally {
    fake.chromeApi.storage.session = trustedSession;
    Object.defineProperty(globalThis, 'crypto', cryptoDescriptor);
    globalThis.Uint8Array = OriginalUint8Array;
  }

  assert.ifError(caught);
  assert.equal(optionOwnKeys, 1);
  assert.notEqual(internal.sessionArea, trustedSession);
  assert.equal(Object.getPrototypeOf(internal.sessionArea), null);
  assert.equal(Object.isFrozen(internal.sessionArea), true);
  assert.deepEqual(Reflect.ownKeys(internal.sessionArea).sort(), ['get', 'remove', 'set']);
  assert.equal(bytes?.constructor, OriginalUint8Array);
  assert.equal(bytes?.byteLength, 16);
  assert.equal(hostileAllocations, 0);
  assert.equal(hostileRandomCalls, 0);
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
    sessionUrlDigestManager: Object.freeze({
      async digest() {
        digestStarted = true;
        await digestGate;
        return `hmac-sha256:${'A'.repeat(43)}`;
      },
    }),
  });
  const pending = adapter.probeDocumentIdentity(17);
  while (!digestStarted) await new Promise(resolve => setImmediate(resolve));
  current = { url: 'https://example.test/after', documentId: 'document-after', status: 'loading' };
  releaseDigest();
  // A prova nunca mistura o digest do endereço anterior com o documento novo. Desde a 1.1.53 ela é repetida
  // em caso de corrida: ou rejeita, ou devolve uma prova inteira do documento novo (que o chamador compara
  // com o alvo e trata como página mudada).
  const outcome = await pending.then(value => value, error => error);
  if (outcome instanceof Error) assert.match(outcome.message, /TARGET_DOCUMENT_UNAVAILABLE/u);
  else assert.equal(outcome.documentId, 'document-after');
});

test('snapshots an attached source URL only through the opaque worker contract without mutating the tab', async () => {
  const fake = chromeFake();
  const rawUrl = 'https://example.test/private-path?token=KEEP-IN-WORKER#state';
  const tab = Object.freeze({
    id: 17,
    windowId: 9,
    status: 'complete',
    url: rawUrl,
  });
  let tabReads = 0;
  let scriptReads = 0;
  fake.chromeApi.tabs.get = async () => {
    tabReads += 1;
    return structuredClone(tab);
  };
  fake.chromeApi.scripting.executeScript = async options => {
    scriptReads += 1;
    assert.deepEqual(options.target, { tabId: 17, frameIds: [0] });
    assert.equal(options.world, 'ISOLATED');
    return [{ frameId: 0, documentId: 'attached-document-a', result: rawUrl }];
  };
  const digest = `hmac-sha256:${'A'.repeat(43)}`;
  const adapter = createChromeAdapter(fake.chromeApi, {
    sessionUrlDigestManager: Object.freeze({ async digest(value) {
      assert.equal(value, rawUrl);
      return digest;
    } }),
  });

  assert.equal(Object.hasOwn(adapter, 'snapshotAttachedCopySource'), false);
  const source = await adapter[AUDIT_EXECUTION_INTERNAL].snapshotAttachedCopySource(Object.freeze({
    tabId: 17,
    windowId: 9,
    documentId: 'attached-document-a',
    urlSessionDigest: digest,
  }));

  assert.deepEqual(source, {
    version: 'AttachedCopySourceV1',
    tabId: 17,
    windowId: 9,
    documentId: 'attached-document-a',
    urlSessionDigest: digest,
    rawUrl,
  });
  assert.equal(Object.isFrozen(source), true);
  assert.equal(tabReads, 3);
  assert.equal(scriptReads, 2);
  assert.deepEqual(tab, { id: 17, windowId: 9, status: 'complete', url: rawUrl });
  assert.deepEqual(fake.calls.filter(([name]) => ['create', 'update', 'remove', 'attach', 'cdp'].includes(name)), []);
});

test('denies an attached source snapshot when navigation A to B occurs while its digest is pending', async () => {
  const fake = chromeFake();
  const digest = `hmac-sha256:${'A'.repeat(43)}`;
  let current = { url: 'https://example.test/a?secret=NEVER-RETURN', documentId: 'document-a', status: 'complete' };
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
    sessionUrlDigestManager: Object.freeze({
      async digest() {
        digestStarted = true;
        await digestGate;
        return digest;
      },
    }),
  });

  const pending = adapter[AUDIT_EXECUTION_INTERNAL].snapshotAttachedCopySource({
    tabId: 17,
    windowId: 9,
    documentId: 'document-a',
    urlSessionDigest: digest,
  });
  while (!digestStarted) await new Promise(resolve => setImmediate(resolve));
  current = { url: 'https://example.test/b', documentId: 'document-b', status: 'complete' };
  releaseDigest();

  await assert.rejects(pending, error => {
    assert.equal(error.message, 'ATTACHED_COPY_SOURCE_UNAVAILABLE');
    assert.doesNotMatch(error.message, /NEVER-RETURN|example\.test|document-a|hmac/iu);
    return true;
  });
});

test('rejects non-exact attached source targets before any browser or digest effect', async () => {
  const fake = chromeFake();
  let effects = 0;
  fake.chromeApi.tabs.get = async () => { effects += 1; throw new Error('must not read'); };
  fake.chromeApi.scripting.executeScript = async () => { effects += 1; throw new Error('must not script'); };
  const adapter = createChromeAdapter(fake.chromeApi, {
    sessionUrlDigestManager: Object.freeze({ async digest() { effects += 1; throw new Error('must not digest'); } }),
  });

  await assert.rejects(
    () => adapter[AUDIT_EXECUTION_INTERNAL].snapshotAttachedCopySource({
      tabId: 17,
      windowId: 9,
      documentId: 'document-a',
      urlSessionDigest: `hmac-sha256:${'A'.repeat(43)}`,
      rawUrl: 'https://example.test/private',
    }),
    /ATTACHED_COPY_SOURCE_UNAVAILABLE/u,
  );
  assert.equal(effects, 0);
});

test('rejects ambiguous, stale, or non-HTTP document probes', async () => {
  const fake = chromeFake();
  const manager = Object.freeze({ async digest() { return `hmac-sha256:${'A'.repeat(43)}`; } });
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
    sessionUrlDigestManager: Object.freeze({ async digest() { return `hmac-sha256:${'A'.repeat(43)}`; } }),
  });
  await assert.rejects(() => adapter.probeDocumentIdentity(17), /TARGET_DOCUMENT_UNAVAILABLE/u);
});

test('creates, navigates, waits, scripts all frames, connects CDP and removes only the exact tab', async () => {
  const fake = chromeFake();
  const adapter = createChromeAdapter(fake.chromeApi);
  const tab = await adapter.createTab({ url: 'about:blank', active: false });
  await adapter.navigateTab(tab.id, 'https://example.test/');
  const stable = await adapter.waitForStable(tab.id, { timeoutMs: 1000 });
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

test('retains observed viewport when the debugger denies Browser.getVersion', async () => {
  const fake = chromeFake();
  const adapter = createChromeAdapter(fake.chromeApi);
  const environment = await adapter.getEnvironment(17, {
    async command(method) {
      if (method === 'Browser.getVersion') throw new Error('PRIVATE_BROWSER_FAILURE');
      assert.equal(method, 'Runtime.evaluate');
      return { result: { value: { width: 1024, height: 768, deviceScaleFactor: 2 } } };
    },
  });
  assert.deepEqual(environment, {
    chromeVersion: '', viewport: { width: 1024, height: 768, deviceScaleFactor: 2 },
  });
  assert.doesNotMatch(JSON.stringify(environment), /PRIVATE_BROWSER_FAILURE/);
});

test('does not manufacture viewport when its independent read fails', async () => {
  const adapter = createChromeAdapter(chromeFake().chromeApi);
  const environment = await adapter.getEnvironment(17, {
    async command(method) {
      if (method === 'Browser.getVersion') return { product: 'Chrome/152.0.0.0' };
      throw new Error('PRIVATE_VIEWPORT_FAILURE');
    },
  });
  assert.equal(environment.chromeVersion, 'Chrome/152.0.0.0');
  assert.deepEqual(environment.viewport, { width: null, height: null, deviceScaleFactor: null });
  assert.doesNotMatch(JSON.stringify(environment), /PRIVATE_VIEWPORT_FAILURE/);
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
    { rect: { x: 0, y: 0, width: 44, height: 44 } },
    { rect: { x: 0, y: 0, width: 44, height: 44 } },
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
    { rect: { x: 0, y: 0, width: 44, height: 44 } },
    { rect: { x: 0, y: 0, width: 44, height: 44 } },
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

const HIGHLIGHT_SIGNATURE = 'd9d995574b8ab6b35d4450e54365fe187f36b1c6561ae4a207522b5634dea7a2';

function highlightSelector() {
  return {
    syntax: 'CSSSelectorV1',
    value: 'button#continue',
    byteLength: 15,
    complexity: 2,
  };
}

function highlightStructuralInput() {
  return {
    version: 'StructuralSignatureInputV1',
    tag: 'button',
    computedRole: 'button',
    ancestry: [
      { tag: 'button', nthOfType: 1, attributes: [] },
      { tag: 'body', nthOfType: 1, attributes: [] },
      { tag: 'html', nthOfType: 1, attributes: [] },
    ],
  };
}

function highlightCandidate() {
  return {
    occurrenceId: 'occ-1',
    evidenceId: 'ev-1',
    backendNodeId: 91,
    selector: highlightSelector(),
  };
}

function highlightTarget(overrides = {}) {
  return {
    documentId: 'doc-child',
    frameId: 4,
    backendNodeId: 91,
    evidenceId: 'ev-1',
    selector: highlightSelector(),
    structuralSignature: {
      version: 'StructuralSignatureV1',
      sha256: HIGHLIGHT_SIGNATURE,
    },
    rectBucket: null,
    ...overrides,
  };
}

function highlightCommand(overrides = {}) {
  return {
    version: 1,
    op: 'install',
    nonce: 'N'.repeat(22),
    documentId: 'doc-child',
    frameId: 4,
    selector: highlightSelector(),
    structuralSignature: {
      version: 'StructuralSignatureV1',
      sha256: HIGHLIGHT_SIGNATURE,
    },
    kind: 'failed',
    markerNumber: 1,
    ...overrides,
  };
}

function highlightProofChromeFake() {
  const fake = chromeFake();
  const url = 'https://example.test/private?token=never-return-this';
  const state = {
    topDocuments: ['doc-top', 'doc-top'],
    proofResult: {
      version: 1,
      entries: [{ occurrenceId: 'occ-1', structuralInput: highlightStructuralInput() }],
      reason: null,
    },
  };
  fake.chromeApi.tabs.get = async id => ({
    id,
    windowId: 3,
    status: 'complete',
    discarded: false,
    url,
  });
  fake.chromeApi.scripting.executeScript = async options => {
    fake.calls.push(['script-options', options]);
    if (options.target.allFrames === true) {
      const result = structuredClone(state.proofResult);
      if (result.entries.length === 1) result.entries[0].occurrenceId = options.args[0][0].occurrenceId;
      return [{ frameId: 4, documentId: 'doc-child', result }];
    }
    const documentId = state.topDocuments.shift() ?? 'doc-top';
    return [{ frameId: 0, documentId, result: url }];
  };
  fake.chromeApi.debugger.sendCommand = async (_target, method, params) => {
    fake.calls.push(['cdp-params', method, params]);
    if (method === 'DOM.resolveNode') return { object: { objectId: 'remote-node-91' } };
    if (method === 'Runtime.callFunctionOn') {
      const value = structuredClone(state.proofResult);
      if (value.entries.length === 1) value.entries[0].occurrenceId = params.arguments[0].value.occurrenceId;
      return { result: { value } };
    }
    return {};
  };
  return { ...fake, state };
}

test('correlates backend identity with one exact isolated document and returns no private page data', async () => {
  const fake = highlightProofChromeFake();
  const adapter = createChromeAdapter(fake.chromeApi);

  const proofs = await adapter.proveHighlightTargets({
    tabId: 7,
    windowId: 3,
    topDocumentId: 'doc-top',
    candidates: [highlightCandidate()],
  });

  assert.deepEqual(proofs, [{
    occurrenceId: 'occ-1',
    evidenceId: 'ev-1',
    documentId: 'doc-child',
    frameId: 4,
    backendNodeId: 91,
    selector: highlightSelector(),
    structuralSignature: {
      version: 'StructuralSignatureV1',
      sha256: HIGHLIGHT_SIGNATURE,
    },
    rectBucket: null,
  }]);
  assert.equal(Object.isFrozen(proofs), true);
  assert.doesNotMatch(JSON.stringify(proofs), /never-return-this|example\.test/u);
  assert.deepEqual(fake.calls.filter(call => call[0] === 'attach').length, 1);
  assert.deepEqual(fake.calls.filter(call => call[0] === 'detach').length, 1);
  assert.deepEqual(
    fake.calls.find(call => call[0] === 'cdp-params' && call[1] === 'DOM.resolveNode')?.[2],
    { backendNodeId: 91, objectGroup: 'audita-mt-highlight-proof' },
  );
});

test('fails document-bound verification after same-URL document replacement and still detaches CDP', async () => {
  const fake = highlightProofChromeFake();
  fake.state.topDocuments = ['doc-top', 'doc-after-reload'];
  const adapter = createChromeAdapter(fake.chromeApi);

  const result = await adapter.verifyHighlightTarget({
    tabId: 7,
    windowId: 3,
    topDocumentId: 'doc-top',
    target: highlightTarget(),
  });

  assert.deepEqual(result, { ok: false, reason: 'document-changed' });
  assert.equal(fake.calls.filter(call => call[0] === 'detach').length, 1);
});

test('accepts a canonical rectangle bucket without treating coordinates as live authority', async () => {
  const fake = highlightProofChromeFake();
  const result = await createChromeAdapter(fake.chromeApi).verifyHighlightTarget({
    tabId: 7,
    windowId: 3,
    topDocumentId: 'doc-top',
    target: highlightTarget({ rectBucket: { x: -16, y: 32, width: 96, height: 32 } }),
  });

  assert.deepEqual(result, {
    ok: true,
    topDocumentId: 'doc-top',
    documentId: 'doc-child',
    frameId: 4,
  });
  assert.equal(JSON.stringify(result).includes('width'), false);
});

test('serialized structural proof preserves the locator role map for unknown input types', async () => {
  const fake = chromeFake();
  const url = 'https://example.test/form';
  let browserProof;
  const document = {
    children: [],
    querySelectorAll(selector) { return selector === 'input#field' ? [input] : []; },
  };
  const element = (tag, attributes = {}) => ({
    tagName: tag.toUpperCase(),
    children: [],
    parentElement: null,
    parentNode: null,
    ownerDocument: document,
    getAttribute(name) { return Object.hasOwn(attributes, name) ? attributes[name] : null; },
    getRootNode() { return document; },
  });
  const html = element('html');
  const body = element('body');
  const input = element('input', { id: 'field', type: 'madeup' });
  document.children = [html];
  html.parentNode = document;
  html.children = [body];
  body.parentElement = html;
  body.parentNode = html;
  body.children = [input];
  input.parentElement = body;
  input.parentNode = body;
  fake.chromeApi.tabs.get = async id => ({ id, windowId: 3, status: 'complete', discarded: false, url });
  fake.chromeApi.scripting.executeScript = async options => {
    if (options.target.allFrames === true) {
      const original = globalThis.document;
      try {
        globalThis.document = document;
        browserProof = await options.func(...options.args);
      } finally {
        if (original === undefined) delete globalThis.document;
        else globalThis.document = original;
      }
      return [{ frameId: 0, documentId: 'doc-top', result: browserProof }];
    }
    return [{ frameId: 0, documentId: 'doc-top', result: url }];
  };
  fake.chromeApi.debugger.sendCommand = async (_target, method) => {
    if (method === 'DOM.resolveNode') return { object: { objectId: 'remote-input' } };
    if (method === 'Runtime.callFunctionOn') return { result: { value: structuredClone(browserProof) } };
    return {};
  };
  const selector = { syntax: 'CSSSelectorV1', value: 'input#field', byteLength: 11, complexity: 2 };

  await createChromeAdapter(fake.chromeApi).proveHighlightTargets({
    tabId: 7,
    windowId: 3,
    topDocumentId: 'doc-top',
    candidates: [{ occurrenceId: 'occ-input', evidenceId: 'ev-input', backendNodeId: 92, selector }],
  });

  assert.equal(browserProof.entries[0].structuralInput.computedRole, 'textbox');
});

test('rejects ambiguous or backend-divergent live targets instead of falling back to a selector', async () => {
  for (const mutation of [
    fake => { fake.state.proofResult.entries = []; fake.state.proofResult.reason = 'ambiguous'; },
    fake => { fake.state.proofResult.entries[0].structuralInput.tag = 'a'; },
  ]) {
    const fake = highlightProofChromeFake();
    mutation(fake);
    const result = await createChromeAdapter(fake.chromeApi).verifyHighlightTarget({
      tabId: 7,
      windowId: 3,
      topDocumentId: 'doc-top',
      target: highlightTarget(),
    });
    assert.equal(result.ok, false);
    assert.equal(['ambiguous', 'live-proof-failed'].includes(result.reason), true);
    assert.equal(fake.calls.filter(call => call[0] === 'detach').length, 1);
  }
});

test('injects an exact overlay command by documentIds only and correlates document plus frame', async () => {
  const fake = chromeFake();
  const scriptCalls = [];
  let forgeDocument = false;
  fake.chromeApi.scripting.executeScript = async options => {
    scriptCalls.push(options);
    return [{
      documentId: forgeDocument ? 'forged-document' : 'doc-child',
      frameId: 4,
      result: { ok: true, nonce: 'N'.repeat(22) },
    }];
  };
  const adapter = createChromeAdapter(fake.chromeApi);
  const command = highlightCommand();

  assert.deepEqual(await adapter.injectHighlight({ tabId: 7, documentId: 'doc-child', command }), {
    ok: true,
    nonce: 'N'.repeat(22),
    documentId: 'doc-child',
    frameId: 4,
  });
  assert.deepEqual(scriptCalls[0].target, { tabId: 7, documentIds: ['doc-child'] });
  assert.equal(Object.hasOwn(scriptCalls[0].target, 'frameIds'), false);
  assert.equal(scriptCalls[0].world, 'ISOLATED');
  assert.deepEqual(scriptCalls[0].args, [command]);

  forgeDocument = true;
  assert.deepEqual(await adapter.injectHighlight({ tabId: 7, documentId: 'doc-child', command }), {
    ok: false,
    reason: 'result-mismatch',
  });
});

test('rejects hostile highlight adapter inputs before invoking Chrome APIs', async () => {
  const fake = highlightProofChromeFake();
  const adapter = createChromeAdapter(fake.chromeApi);
  let getterCalls = 0;
  const hostile = { tabId: 7, documentId: 'doc-child', command: highlightCommand() };
  Object.defineProperty(hostile, 'command', {
    enumerable: true,
    get() { getterCalls += 1; return highlightCommand(); },
  });
  const scriptCallsBefore = fake.calls.filter(call => call[0] === 'script-options').length;

  assert.deepEqual(await adapter.injectHighlight(hostile), { ok: false, reason: 'invalid-input' });
  assert.equal(getterCalls, 0);
  assert.equal(fake.calls.filter(call => call[0] === 'script-options').length, scriptCallsBefore);
});

// Bateria de páginas hostis (1.1.53).
test('reads the viewport from the isolated world when the page redefines its own window metrics', async () => {
  const fake = chromeFake();
  const targets = [];
  fake.chromeApi.scripting.executeScript = async options => {
    targets.push(options.target);
    return [{ frameId: 0, documentId: 'document-a', result: { width: 1280, height: 720, deviceScaleFactor: 2 } }];
  };
  const adapter = createChromeAdapter(fake.chromeApi);
  const environment = await adapter.getEnvironment(17, {
    async command(method) {
      if (method === 'Browser.getVersion') return { product: 'Chrome/152.0.0.0' };
      return { result: { value: { width: 0, height: 720, deviceScaleFactor: 2 } } };
    },
  });
  assert.deepEqual(environment.viewport, { width: 1280, height: 720, deviceScaleFactor: 2 });
  assert.deepEqual(targets, [{ tabId: 17, frameIds: [0] }]);
});

test('repeats the sensitive probe when a rotating ad frame replaces its document between inventory and inspection', async () => {
  const fake = chromeFake();
  let inventories = 0;
  fake.chromeApi.scripting.executeScript = async options => {
    if (options.target.allFrames === true) {
      inventories += 1;
      return [
        { frameId: 0, documentId: 'document-main', result: null },
        { frameId: 3, documentId: `ad-document-${inventories}`, result: null },
      ];
    }
    // A primeira inspeção chega depois da rotação: o documento do anúncio já é outro.
    const adDocument = inventories === 1 ? 'ad-document-rotated' : 'ad-document-2';
    return [
      { frameId: 0, documentId: 'document-main', result: { password: false, otp: false, payment: false, privateMarker: false } },
      { frameId: 3, documentId: adDocument, result: { password: false, otp: false, payment: false, privateMarker: false } },
    ];
  };
  const signals = await createChromeAdapter(fake.chromeApi).probeSensitiveCaptureSignals(17, 'document-main');
  assert.equal(inventories, 2);
  assert.deepEqual(signals, { version: 'SensitiveCaptureSignalsV1', detected: false, categories: [] });
});

test('an injection that never answers becomes an error instead of holding the audit forever', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fake = chromeFake();
  fake.chromeApi.scripting.executeScript = () => new Promise(() => {});
  const adapter = createChromeAdapter(fake.chromeApi);
  const pending = adapter.executeScript({ target: { tabId: 17, frameIds: [0] }, func: () => true });
  t.mock.timers.tick(30_000);
  await assert.rejects(pending, /SCRIPT_INJECTION_TIMEOUT/u);
});
