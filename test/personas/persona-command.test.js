import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';

let commandModule = {};
try { commandModule = await import('../../src/personas/persona-command.js'); } catch { /* RED */ }
const LEASE = `lease-${'L'.repeat(22)}`;

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
    activate(nextMode, preferences, correlation) {
      calls.push(['activate', nextMode, preferences, correlation]);
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

function readerRuntimeFixture({
  voices = [{ id: 'local-a', label: 'Voz local', lang: 'pt-BR' }],
  voiceStatus = 'available',
  actionStatuses = [],
} = {}) {
  const calls = [];
  let mode = 'reader';
  let reader = {
    playback: 'playing', index: 0, total: 2, caption: 'Primeiro, botão',
    canPrevious: false, canNext: true, speechAvailability: 'available',
    voiceId: 'local-a', rate: 1,
  };
  const snapshot = () => ({
    activeMode: mode,
    reader: structuredClone(reader),
    limitations: [{ code: 'PRIVATE_INTERNAL_LIMITATION', count: 1 }],
    coverage: 'PRIVATE_INTERNAL_COVERAGE',
  });
  const runtime = Object.freeze({
    activate(nextMode) { calls.push(['activate', nextMode]); mode = nextMode; return snapshot(); },
    stop() { calls.push(['persona-stop']); mode = null; return snapshot(); },
    getState() { calls.push(['inspect']); return snapshot(); },
    readerAction(action) {
      calls.push(['reader-action', action]);
      const actionStatus = actionStatuses.length ? actionStatuses.shift() : 'accepted';
      if (actionStatus === 'accepted' && action === 'stop') reader = { ...reader, playback: 'idle', index: -1, total: 0, caption: '', canPrevious: false, canNext: false };
      if (actionStatus === 'accepted' && action === 'resume' && reader.playback === 'idle') reader = { ...reader, playback: 'playing', index: 0, total: 2, caption: 'Primeiro, botão', canNext: true };
      if (actionStatus === 'accepted' && action === 'pause' && reader.playback === 'playing') reader = { ...reader, playback: 'paused' };
      if (actionStatus === 'accepted' && action === 'next' && reader.index === 0) reader = { ...reader, index: 1, caption: 'Segundo, link', canPrevious: true, canNext: false };
      if (actionStatus === 'terminal') reader = { ...reader, speechAvailability: 'error' };
      return {
        actionStatus,
        state: snapshot(),
      };
    },
    setPreferences(preferences) {
      calls.push(['reader-preferences', structuredClone(preferences)]);
      if (voices.some(voice => voice.id === preferences.voiceId)) {
        reader = { ...reader, voiceId: preferences.voiceId, rate: preferences.rate };
      }
      return snapshot();
    },
    listReaderVoices() {
      calls.push(['reader-voices']);
      return { status: voiceStatus, voices: structuredClone(voices) };
    },
  });
  return { runtime, calls, state: () => snapshot() };
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
  const sent = [];
  const environment = {
    document: Object.freeze({ nodeType: 9 }),
    ...(options.withMessaging ? {
      chrome: {
        runtime: {
          sendMessage(message) {
            sent.push(structuredClone(message));
            return Promise.resolve({ ok: true });
          },
        },
      },
    } : {}),
  };
  Object.defineProperty(environment, Symbol.for('audita.accessible-preview.runtime.v1'), {
    value: options.namespace ?? namespace,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return { environment, namespace, created, sent, getSingleton: () => singleton };
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
    { version: 1, op: 'install', mode: 'reader' },
    { version: 1, op: 'install', mode: 'unknown' },
    { version: 1, op: 'install', mode: 'reader', leaseId: 'short' },
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

test('probe treats a valid shared preview namespace without a persona singleton or bridge as absent', () => {
  const { environment, created } = environmentFixture();
  assert.deepEqual(apply({ version: 1, op: 'probe' }, environment), {
    ok: true, present: false, mode: null,
  });
  assert.equal(created.length, 0);
});

test('probe never treats an orphan or accessor persona bridge as proof of absence', () => {
  for (const descriptor of [
    { value: null },
    { value: Object.freeze({ version: 1 }) },
    { get() { throw new Error('bridge accessor must not run'); } },
  ]) {
    const { environment } = environmentFixture();
    Object.defineProperty(environment, '__auditaPersonaV1', descriptor);
    assert.deepEqual(apply({ version: 1, op: 'probe' }, environment), {
      ok: true, present: true, mode: null,
    });
  }
});

test('probe keeps malformed falsy singleton values present so commands fail closed', () => {
  for (const singleton of [false, 0, '']) {
    const { environment } = environmentFixture({ singleton });
    assert.deepEqual(apply({ version: 1, op: 'probe' }, environment), {
      ok: true, present: true, mode: null,
    });
  }
});

test('install binds one opaque lease and exposes only the closed autonomous shutdown emitter', () => {
  const createdRuntime = runtimeFixture();
  const { environment, created, sent, getSingleton } = environmentFixture({
    createdRuntime: createdRuntime.runtime,
    withMessaging: true,
  });
  assert.deepEqual(apply({ version: 1, op: 'install', mode: 'reader', leaseId: LEASE }, environment), {
    ok: true, mode: 'reader',
  });
  assert.strictEqual(getSingleton(), createdRuntime.runtime);
  assert.deepEqual(createdRuntime.calls, [
    ['inspect'],
    ['activate', 'reader', undefined, { leaseId: LEASE }],
    ['inspect'],
  ]);
  assert.equal(created.length, 1);
  assert.deepEqual(Object.keys(created[0]).sort(), ['document', 'emitEvent', 'window']);
  assert.strictEqual(created[0].document, environment.document);
  assert.strictEqual(created[0].window, environment);
  assert.equal(Object.hasOwn(createdRuntime.runtime, 'installMessaging'), false);

  for (const reason of ['emergency-stop', 'lifecycle-stop', 'reader-terminal']) {
    created[0].emitEvent({ event: reason, leaseId: LEASE });
  }
  for (const rejected of [
    { event: 'state', leaseId: LEASE },
    { event: 'emergency-stop', leaseId: 'short' },
    { event: 'lifecycle-stop', leaseId: LEASE, url: 'https://private.test/' },
  ]) created[0].emitEvent(rejected);
  assert.deepEqual(sent, [
    { type: 'AUDITA_PERSONA_AUTONOMOUS_STOP', leaseId: LEASE, reason: 'emergency-stop' },
    { type: 'AUDITA_PERSONA_AUTONOMOUS_STOP', leaseId: LEASE, reason: 'lifecycle-stop' },
    { type: 'AUDITA_PERSONA_AUTONOMOUS_STOP', leaseId: LEASE, reason: 'reader-terminal' },
  ]);
  assert.doesNotMatch(JSON.stringify(sent), /private|https?:|selector/iu);

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

  assert.deepEqual(apply({ version: 1, op: 'install', mode: 'reader', leaseId: LEASE }, environment), {
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
  assert.deepEqual(apply({ version: 1, op: 'install', mode: 'reader', leaseId: LEASE }, hostile.environment), {
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
  assert.deepEqual(apply({ version: 1, op: 'install', mode: 'motor', leaseId: LEASE }, environment), { ok: true, mode: 'motor' });
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
  assert.deepEqual(apply({ version: 1, op: 'install', mode: 'reader', leaseId: LEASE }, environment), {
    ok: false, reason: 'runtime-error',
  });
  assert.deepEqual(apply({ version: 1, op: 'inspect' }, environment), {
    ok: false, reason: 'runtime-error',
  });
});

test('reader state returns only a bounded closed projection and never internal runtime details', () => {
  const current = readerRuntimeFixture();
  const { environment } = environmentFixture({ singleton: current.runtime });

  const result = apply({ version: 1, op: 'reader-state' }, environment);

  assert.deepEqual(result, {
    ok: true,
    kind: 'state',
    state: {
      version: 1,
      playback: 'playing', index: 0, total: 2, caption: 'Primeiro, botão',
      canPrevious: false, canNext: true, speechAvailability: 'available',
      voiceId: 'local-a', rate: 1,
    },
  });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_INTERNAL/u);
});

test('reader stop and resume affect playback without invoking the persona stop operation', () => {
  const current = readerRuntimeFixture();
  const { environment } = environmentFixture({ singleton: current.runtime });

  const stopped = apply({ version: 1, op: 'reader-action', action: 'stop' }, environment);
  assert.equal(stopped.ok, true);
  assert.equal(stopped.actionStatus, 'accepted');
  assert.equal(stopped.state.playback, 'idle');
  assert.equal(stopped.state.caption, '');
  assert.equal(current.state().activeMode, 'reader');
  assert.equal(current.calls.some(call => call[0] === 'persona-stop'), false);

  const resumed = apply({ version: 1, op: 'reader-action', action: 'resume' }, environment);
  assert.equal(resumed.ok, true);
  assert.equal(resumed.actionStatus, 'accepted');
  assert.equal(resumed.state.playback, 'playing');
  assert.equal(resumed.state.caption, 'Primeiro, botão');
  assert.equal(current.state().activeMode, 'reader');
});

test('reader action bridge preserves and validates the closed internal disposition', () => {
  const current = readerRuntimeFixture({
    actionStatuses: ['rejected', 'terminal', 'unknown'],
  });
  const { environment } = environmentFixture({ singleton: current.runtime });

  assert.equal(apply({
    version: 1, op: 'reader-action', action: 'next',
  }, environment).actionStatus, 'rejected');
  assert.equal(apply({
    version: 1, op: 'reader-action', action: 'next',
  }, environment).actionStatus, 'terminal');
  assert.deepEqual(apply({
    version: 1, op: 'reader-action', action: 'next',
  }, environment), { ok: false, reason: 'runtime-error' });
});

test('reader voice inventory requires an explicit gesture and exposes only id label and language', () => {
  const current = readerRuntimeFixture({ voices: [
    { id: 'local-a', label: 'Voz local', lang: 'pt-BR' },
    { id: 'local-en', label: 'Local English', lang: 'en-US' },
  ] });
  const { environment } = environmentFixture({ singleton: current.runtime });

  assert.deepEqual(apply({
    version: 1, op: 'reader-voices', explicitUserGesture: false,
  }, environment), { ok: false, reason: 'gesture-required' });
  assert.equal(current.calls.some(call => call[0] === 'reader-voices'), false);

  assert.deepEqual(apply({
    version: 1, op: 'reader-voices', explicitUserGesture: true,
  }, environment), {
    ok: true,
    kind: 'voices',
    status: 'available',
    voices: [
      { id: 'local-a', label: 'Voz local', lang: 'pt-BR' },
      { id: 'local-en', label: 'Local English', lang: 'en-US' },
    ],
  });
});

test('reader voice inventory preserves unavailable and fails closed on enumeration error', () => {
  const unavailable = readerRuntimeFixture({ voices: [], voiceStatus: 'unavailable' });
  assert.deepEqual(apply({
    version: 1, op: 'reader-voices', explicitUserGesture: true,
  }, environmentFixture({ singleton: unavailable.runtime }).environment), {
    ok: true,
    kind: 'voices',
    status: 'unavailable',
    voices: [],
  });

  const failed = readerRuntimeFixture({ voices: [], voiceStatus: 'error' });
  assert.deepEqual(apply({
    version: 1, op: 'reader-voices', explicitUserGesture: true,
  }, environmentFixture({ singleton: failed.runtime }).environment), {
    ok: false,
    reason: 'runtime-error',
  });
});

test('reader preferences accept only an exact local voice and a numeric rate from 0.5 through 2', () => {
  const current = readerRuntimeFixture();
  const { environment } = environmentFixture({ singleton: current.runtime });
  assert.deepEqual(apply({
    version: 1, op: 'reader-preferences', voiceId: 'local-a', rate: 1.75,
  }, environment).state.voiceId, 'local-a');
  assert.equal(current.state().reader.rate, 1.75);

  assert.deepEqual(apply({
    version: 1, op: 'reader-preferences', voiceId: 'remote-cloud', rate: 1.5,
  }, environment), { ok: false, reason: 'voice-unavailable' });
  assert.equal(current.state().reader.voiceId, 'local-a');
  assert.equal(current.state().reader.rate, 1.75);

  for (const rate of [0.49, 2.01, NaN, '1']) {
    assert.deepEqual(apply({
      version: 1, op: 'reader-preferences', voiceId: 'local-a', rate,
    }, environment), { ok: false, reason: 'invalid-command' });
  }
});
