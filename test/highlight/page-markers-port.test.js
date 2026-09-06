import assert from 'node:assert/strict';
import test from 'node:test';

import { bindAuditaPageMarkersPort } from '../../src/browser/page-markers-port.js';

const INSTALLATION_ID = 'A'.repeat(22);

class EventHook {
  constructor() { this.listeners = new Set(); }
  addListener(listener) { this.listeners.add(listener); }
  removeListener(listener) { this.listeners.delete(listener); }
  emit(...args) { for (const listener of [...this.listeners]) listener(...args); }
}

function fixture() {
  const events = [];
  const timers = new Map();
  let nextTimer = 1;
  const onDisconnect = new EventHook();
  const port = {
    onDisconnect,
    messages: [],
    disconnected: 0,
    postMessage(message) {
      events.push(['post', structuredClone(message), onDisconnect.listeners.size]);
      this.messages.push(structuredClone(message));
    },
    disconnect() { this.disconnected += 1; },
  };
  const overlay = Object.freeze({
    version: 1,
    installationId: INSTALLATION_ID,
    disposeCalls: [],
    dispose(autonomous) { this.disposeCalls.push(autonomous); },
    execute() { return { ok: true }; },
  });
  const environment = {
    chrome: { runtime: { connect(options) { events.push(['connect', structuredClone(options)]); return port; } } },
    setTimeout(callback, delay) { const id = nextTimer++; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  Object.defineProperty(environment, '__auditaPageMarkersOverlayV1', {
    value: overlay, enumerable: false, configurable: true, writable: false,
  });
  return {
    environment, overlay, port, events,
    timerDelays: () => [...timers.values()].map(value => value.delay),
    fireTimer() {
      const [entry] = timers.entries();
      assert.ok(entry, 'timer expected');
      timers.delete(entry[0]);
      entry[1].callback();
    },
  };
}

test('serialized binder opens its native channel and installs disconnect before hello', () => {
  const isolated = (0, eval)(`(${bindAuditaPageMarkersPort.toString()})`);
  const value = fixture();

  assert.deepEqual(isolated(INSTALLATION_ID, value.environment), { ok: true });
  assert.deepEqual(value.events, [
    ['connect', { name: 'audita-page-markers-v1' }],
    ['post', { type: 'AUDITA_PAGE_MARKERS_HELLO', installationId: INSTALLATION_ID }, 1],
  ]);
  assert.deepEqual(value.timerDelays(), [20_000]);
  const descriptor = Reflect.getOwnPropertyDescriptor(value.environment, '__auditaPageMarkersPortV1');
  assert.deepEqual({ enumerable: descriptor.enumerable, configurable: descriptor.configurable, writable: descriptor.writable },
    { enumerable: false, configurable: true, writable: false });
});

test('identical binding is idempotent and heartbeat stops when the exact overlay slot is lost', () => {
  const value = fixture();
  assert.deepEqual(bindAuditaPageMarkersPort(INSTALLATION_ID, value.environment), { ok: true });
  const binder = value.environment.__auditaPageMarkersPortV1;
  assert.deepEqual(bindAuditaPageMarkersPort(INSTALLATION_ID, value.environment), { ok: true });
  assert.strictEqual(value.environment.__auditaPageMarkersPortV1, binder);
  assert.equal(value.events.filter(event => event[0] === 'connect').length, 1);

  value.fireTimer();
  assert.deepEqual(value.port.messages.at(-1), {
    type: 'AUDITA_PAGE_MARKERS_PING', installationId: INSTALLATION_ID,
  });
  assert.deepEqual(value.timerDelays(), [20_000]);

  const foreign = Object.freeze({ foreign: true });
  Reflect.deleteProperty(value.environment, '__auditaPageMarkersOverlayV1');
  Object.defineProperty(value.environment, '__auditaPageMarkersOverlayV1', {
    value: foreign, enumerable: false, configurable: true, writable: false,
  });
  value.fireTimer();
  assert.deepEqual(value.overlay.disposeCalls, [true]);
  assert.equal(value.port.disconnected, 1);
  assert.equal(Object.hasOwn(value.environment, '__auditaPageMarkersPortV1'), false);
  assert.strictEqual(value.environment.__auditaPageMarkersOverlayV1, foreign);
});

test('native disconnect and post failure clean owned resources without deleting a replacement binder', () => {
  for (const mode of ['disconnect', 'post-failure']) {
    const value = fixture();
    assert.deepEqual(bindAuditaPageMarkersPort(INSTALLATION_ID, value.environment), { ok: true });
    const foreign = Object.freeze({ foreign: true });
    Reflect.deleteProperty(value.environment, '__auditaPageMarkersPortV1');
    Object.defineProperty(value.environment, '__auditaPageMarkersPortV1', {
      value: foreign, enumerable: false, configurable: true, writable: false,
    });
    if (mode === 'disconnect') value.port.onDisconnect.emit();
    else {
      value.port.postMessage = () => { throw new Error('native post failed'); };
      value.fireTimer();
    }
    assert.deepEqual(value.overlay.disposeCalls, [true]);
    assert.strictEqual(value.environment.__auditaPageMarkersPortV1, foreign);
    assert.deepEqual(value.timerDelays(), []);
    assert.equal(value.port.onDisconnect.listeners.size, 0);
  }
});

test('foreign overlay or binder state is denied without getters or replacement', () => {
  for (const slot of ['__auditaPageMarkersOverlayV1', '__auditaPageMarkersPortV1']) {
    const value = fixture();
    let reads = 0;
    const foreign = {};
    Object.defineProperty(foreign, 'installationId', { get() { reads += 1; return INSTALLATION_ID; } });
    if (slot === '__auditaPageMarkersOverlayV1') Reflect.deleteProperty(value.environment, slot);
    Object.defineProperty(value.environment, slot, {
      value: foreign, enumerable: false, configurable: true, writable: false,
    });
    assert.deepEqual(bindAuditaPageMarkersPort(INSTALLATION_ID, value.environment), { ok: false });
    assert.strictEqual(value.environment[slot], foreign);
    assert.equal(reads, 0);
    assert.equal(value.events.length, 0);
  }
});

test('an incomplete lookalike overlay cannot acquire the native binder channel', () => {
  const value = fixture();
  const lookalike = Object.freeze({ version: 1, installationId: INSTALLATION_ID, dispose() {} });
  Reflect.deleteProperty(value.environment, '__auditaPageMarkersOverlayV1');
  Object.defineProperty(value.environment, '__auditaPageMarkersOverlayV1', {
    value: lookalike, enumerable: false, configurable: true, writable: false,
  });
  assert.deepEqual(bindAuditaPageMarkersPort(INSTALLATION_ID, value.environment), { ok: false });
  assert.deepEqual(value.events, []);
  assert.strictEqual(value.environment.__auditaPageMarkersOverlayV1, lookalike);
});
