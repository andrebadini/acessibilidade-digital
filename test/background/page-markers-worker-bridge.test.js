import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PAGE_MARKERS_PORT_NAME,
  createPageMarkersWorkerLifecycle,
  createPageMarkersWorkerBridge,
  isPageMarkersRuntimeMessage,
} from '../../src/background/page-markers-worker-bridge.js';

function event() {
  const listeners = new Set();
  return {
    addListener(listener) { listeners.add(listener); },
    removeListener(listener) { listeners.delete(listener); },
    emit(...args) { for (const listener of [...listeners]) listener(...args); },
  };
}

test('private marker bridge forwards only its exact page channel without echoing payloads', () => {
  const calls = [];
  const controller = {
    attachPort(port) { calls.push(['port', port]); return true; },
    handleRuntimeMessage(message, sender) { calls.push(['message', message, sender]); return true; },
  };
  const bridge = createPageMarkersWorkerBridge({ controller });
  const port = {
    name: PAGE_MARKERS_PORT_NAME,
    sender: { id: 'extension' },
    onMessage: event(), onDisconnect: event(),
    postMessage() { assert.fail('the worker bridge must not echo page payloads'); },
    disconnect() { this.onDisconnect.emit(); },
  };
  const sender = { id: 'extension', documentId: 'original-document' };
  const selected = { type: 'AUDITA_PAGE_MARKER_SELECTED', installationId: 'I'.repeat(22), selectionId: 's1' };

  assert.equal(bridge.attachPort(port), true);
  assert.equal(bridge.handleRuntimeMessage(selected, sender), true);
  assert.deepEqual(calls, [['port', port], ['message', selected, sender]]);
});

test('page event classifier rejects extras and accessors without invoking them', () => {
  const selected = { type: 'AUDITA_PAGE_MARKER_SELECTED', installationId: 'I'.repeat(22), selectionId: 's1' };
  const cleared = { type: 'AUDITA_PAGE_MARKERS_CLEARED', installationId: 'I'.repeat(22) };
  let getters = 0;
  const accessor = { type: 'AUDITA_PAGE_MARKERS_CLEARED' };
  Object.defineProperty(accessor, 'installationId', {
    enumerable: true,
    get() { getters += 1; return 'I'.repeat(22); },
  });

  assert.equal(isPageMarkersRuntimeMessage(selected), true);
  assert.equal(isPageMarkersRuntimeMessage(cleared), true);
  assert.equal(isPageMarkersRuntimeMessage({ ...selected, selectionId: 's65' }), false);
  assert.equal(isPageMarkersRuntimeMessage({ ...selected, privateDigest: 'never' }), false);
  assert.equal(isPageMarkersRuntimeMessage(accessor), false);
  assert.equal(getters, 0);
});

test('dispose closes every owned marker Port and prevents later forwarding', () => {
  const calls = [];
  const controller = {
    attachPort(port) { calls.push(['port', port.name]); return true; },
    handleRuntimeMessage(message) { calls.push(['message', message.type]); return true; },
  };
  const bridge = createPageMarkersWorkerBridge({ controller });
  const makePort = () => {
    const onDisconnect = event();
    return {
      name: PAGE_MARKERS_PORT_NAME, onMessage: event(), onDisconnect, disconnects: 0,
      postMessage() { assert.fail('bridge must stay silent'); },
      disconnect() { this.disconnects += 1; onDisconnect.emit(); },
    };
  };
  const first = makePort();
  const second = makePort();
  assert.equal(bridge.attachPort(first), true);
  assert.equal(bridge.attachPort(second), true);

  assert.equal(bridge.dispose(), true);
  assert.equal(bridge.dispose(), false);
  assert.equal(first.disconnects, 1);
  assert.equal(second.disconnects, 1);
  assert.equal(bridge.attachPort(makePort()), false);
  assert.equal(bridge.handleRuntimeMessage({
    type: 'AUDITA_PAGE_MARKERS_CLEARED', installationId: 'I'.repeat(22),
  }, {}), false);
  assert.deepEqual(calls, [['port', PAGE_MARKERS_PORT_NAME], ['port', PAGE_MARKERS_PORT_NAME]]);
});

test('failed controller admission is not retained as a bridge-owned channel', () => {
  const bridge = createPageMarkersWorkerBridge({
    controller: { attachPort() { return false; }, handleRuntimeMessage() { return false; } },
  });
  const onDisconnect = event();
  const port = {
    name: PAGE_MARKERS_PORT_NAME, onMessage: event(), onDisconnect, disconnects: 0,
    postMessage() {}, disconnect() { this.disconnects += 1; onDisconnect.emit(); },
  };
  assert.equal(bridge.attachPort(port), false);
  assert.equal(bridge.dispose(), true);
  assert.equal(port.disconnects, 0);
});

test('bridge disposal closes publication before disconnect cleanup and queued publication effects', async () => {
  const calls = [];
  const gate = {};
  const lifecycle = createPageMarkersWorkerLifecycle({
    async publish(event) { calls.push(structuredClone(event)); return { delivered: 1 }; },
  });
  const controller = {
    attachPort(port) {
      port.onDisconnect.addListener(() => {
        void lifecycle.publish({ state: 'clear', source: 'disconnect' });
      });
      return true;
    },
    handleRuntimeMessage() { return false; },
  };
  const bridge = createPageMarkersWorkerBridge({ controller, lifecycle });
  const onDisconnect = event();
  const port = {
    name: PAGE_MARKERS_PORT_NAME, onMessage: event(), onDisconnect,
    postMessage() {}, disconnect() { onDisconnect.emit(); },
  };
  assert.equal(bridge.attachPort(port), true);
  const pending = lifecycle.publish({ state: 'active', gate });
  assert.equal(bridge.dispose(), true);
  assert.deepEqual(await pending, { delivered: 0 });
  await Promise.resolve();
  assert.deepEqual(calls, []);
});
