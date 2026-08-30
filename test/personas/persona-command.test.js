import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';

let commandModule = {};
try { commandModule = await import('../../src/personas/persona-command.js'); } catch { /* RED */ }

function apply(command, environment) {
  assert.equal(
    typeof commandModule.applyAuditaPersonaCommand,
    'function',
    'a ponte local de personas precisa existir',
  );
  return commandModule.applyAuditaPersonaCommand(command, environment);
}

function runtimeFixture({ activeMode = null, stopLeavesMode = false } = {}) {
  const calls = [];
  let mode = activeMode;
  const runtime = Object.freeze({
    activate(nextMode) {
      calls.push(['activate', nextMode]);
      mode = nextMode;
      return { activeMode: mode };
    },
    stop() {
      calls.push(['stop']);
      if (!stopLeavesMode) mode = null;
      return { activeMode: mode };
    },
    getState() {
      calls.push(['inspect']);
      return { activeMode: mode };
    },
  });
  return { runtime, calls, readMode: () => mode };
}

function environmentFixture(options = {}) {
  let singleton = options.singleton ?? null;
  const created = [];
  const namespace = Object.assign(Object.create(null), {
    brand: 'audita-accessible-preview',
    version: 1,
    createRuntime() { return Object.freeze({}); },
    registerScreenReaderFactory() {},
    createScreenReaderModule() {},
    registerContentFactory() {},
    createContentRuntime(environment) {
      created.push(environment);
      singleton = options.createdRuntime ?? runtimeFixture().runtime;
      return singleton;
    },
    getContentSingleton() { return singleton; },
    setContentSingleton(candidate) {
      if (!singleton) singleton = candidate;
      return singleton;
    },
  });
  Object.freeze(namespace);
  const environment = { document: Object.freeze({ nodeType: 9 }) };
  Object.defineProperty(environment, Symbol.for('audita.accessible-preview.runtime.v1'), {
    value: options.namespace ?? namespace,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return { environment, namespace, created, getSingleton: () => singleton };
}

test('self-contained probe distinguishes an absent namespace without installing anything', () => {
  const environment = { document: {} };
  assert.deepEqual(apply({ version: 1, op: 'probe' }, environment), {
    ok: true, present: false, mode: null,
  });
  assert.equal(Object.hasOwn(environment, '__auditaPersonaV1'), false);

  const source = commandModule.applyAuditaPersonaCommand.toString();
  const context = vm.createContext({});
  const result = new vm.Script(`(${source})({version:1,op:'probe'}, globalThis)`).runInContext(context);
  assert.equal(JSON.stringify(result), '{"ok":true,"present":false,"mode":null}');
});

test('rejects non-exact commands and never evaluates accessor properties', () => {
  const { environment } = environmentFixture();
  const invalid = [
    null,
    {},
    { version: 1, op: 'probe', mode: 'reader' },
    { version: 1, op: 'install' },
    { version: 1, op: 'install', mode: 'unknown' },
    { version: 1, op: 'inspect', extra: true },
    { version: 2, op: 'clear' },
  ];
  for (const value of invalid) {
    assert.deepEqual(apply(value, environment), { ok: false, reason: 'invalid-command' });
  }

  let reads = 0;
  const hostile = { version: 1 };
  Object.defineProperty(hostile, 'op', {
    enumerable: true,
    get() { reads += 1; return 'probe'; },
  });
  assert.deepEqual(apply(hostile, environment), { ok: false, reason: 'invalid-command' });
  assert.equal(reads, 0);
});

test('probe reports a conflicting namespace but only commands diagnose its brand', () => {
  const conflicting = Object.freeze({ brand: 'foreign', version: 1 });
  const { environment } = environmentFixture({ namespace: conflicting });
  assert.deepEqual(apply({ version: 1, op: 'probe' }, environment), {
    ok: true, present: true, mode: null,
  });
  assert.deepEqual(apply({ version: 1, op: 'inspect' }, environment), {
    ok: false, reason: 'runtime-brand-mismatch',
  });
});

test('install creates the registered singleton, activates exactly one mode and installs no messaging', () => {
  const createdRuntime = runtimeFixture();
  const { environment, created, getSingleton } = environmentFixture({
    createdRuntime: createdRuntime.runtime,
  });
  assert.deepEqual(apply({ version: 1, op: 'install', mode: 'reader' }, environment), {
    ok: true, mode: 'reader',
  });
  assert.strictEqual(getSingleton(), createdRuntime.runtime);
  assert.deepEqual(createdRuntime.calls, [['inspect'], ['activate', 'reader'], ['inspect']]);
  assert.equal(created.length, 1);
  assert.deepEqual(Object.keys(created[0]).sort(), ['document', 'window']);
  assert.strictEqual(created[0].document, environment.document);
  assert.strictEqual(created[0].window, environment);
  assert.equal(Object.hasOwn(createdRuntime.runtime, 'installMessaging'), false);

  const bridge = Object.getOwnPropertyDescriptor(environment, '__auditaPersonaV1');
  assert.equal(bridge?.enumerable, false);
  assert.equal(bridge?.configurable, true);
  assert.equal(bridge?.writable, false);
  assert.equal(Object.isFrozen(bridge?.value), true);
  assert.strictEqual(bridge?.value.runtime, createdRuntime.runtime);
});

test('install never invokes arbitrary own or prototype document accessors', () => {
  const document = Object.freeze({ nodeType: 9 });
  let prototypeReads = 0;
  const hostilePrototype = Object.create(null);
  Object.defineProperty(hostilePrototype, 'document', {
    enumerable: true,
    configurable: false,
    get() { prototypeReads += 1; return document; },
  });
  const fixture = environmentFixture({ createdRuntime: runtimeFixture().runtime });
  const environment = Object.create(hostilePrototype);
  Object.defineProperty(environment, Symbol.for('audita.accessible-preview.runtime.v1'), {
    value: fixture.namespace,
    enumerable: false,
    configurable: false,
    writable: false,
  });

  assert.deepEqual(apply({ version: 1, op: 'install', mode: 'reader' }, environment), {
    ok: true, mode: 'reader',
  });
  assert.equal(prototypeReads, 0);
  assert.strictEqual(fixture.created[0].document, undefined);

  let hostileReads = 0;
  const hostile = environmentFixture({ createdRuntime: runtimeFixture().runtime });
  Object.defineProperty(hostile.environment, 'document', {
    enumerable: true,
    configurable: true,
    get() { hostileReads += 1; return document; },
  });
  assert.deepEqual(apply({ version: 1, op: 'install', mode: 'reader' }, hostile.environment), {
    ok: true, mode: 'reader',
  });
  assert.equal(hostileReads, 0);
  assert.equal(hostile.created[0].document, undefined);
});

test('inspect reads only the existing singleton and clear removes its bridge after confirmed cleanup', () => {
  const current = runtimeFixture({ activeMode: 'motor' });
  const { environment, created } = environmentFixture({ singleton: current.runtime });
  assert.deepEqual(apply({ version: 1, op: 'inspect' }, environment), { ok: true, mode: 'motor' });
  assert.equal(created.length, 0);
  assert.deepEqual(apply({ version: 1, op: 'install', mode: 'motor' }, environment), { ok: true, mode: 'motor' });
  assert.equal(Object.hasOwn(environment, '__auditaPersonaV1'), true);

  assert.deepEqual(apply({ version: 1, op: 'clear' }, environment), { ok: true, mode: null });
  assert.equal(Object.hasOwn(environment, '__auditaPersonaV1'), false);
  assert.deepEqual(
    current.calls.map(call => call[0]),
    ['inspect', 'inspect', 'activate', 'inspect', 'inspect', 'stop', 'inspect'],
  );
});

test('missing runtime and unconfirmed cleanup fail closed with closed reasons', () => {
  const absent = { document: {} };
  assert.deepEqual(apply({ version: 1, op: 'inspect' }, absent), {
    ok: false, reason: 'runtime-missing',
  });
  assert.deepEqual(apply({ version: 1, op: 'clear' }, absent), {
    ok: false, reason: 'runtime-missing',
  });

  const stubborn = runtimeFixture({ activeMode: 'reader', stopLeavesMode: true });
  const { environment } = environmentFixture({ singleton: stubborn.runtime });
  assert.deepEqual(apply({ version: 1, op: 'clear' }, environment), {
    ok: false, reason: 'cleanup-unconfirmed',
  });
});

test('runtime exceptions and malformed singleton state never escape the local bridge', () => {
  const broken = Object.freeze({
    activate() { throw new Error('page-controlled detail'); },
    stop() {},
    getState() { return { activeMode: 'forged' }; },
  });
  const { environment } = environmentFixture({ singleton: broken });
  assert.deepEqual(apply({ version: 1, op: 'install', mode: 'reader' }, environment), {
    ok: false, reason: 'runtime-error',
  });
  assert.deepEqual(apply({ version: 1, op: 'inspect' }, environment), {
    ok: false, reason: 'runtime-error',
  });
});
