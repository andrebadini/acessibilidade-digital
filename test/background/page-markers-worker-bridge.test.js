import assert from 'node:assert/strict';
import test from 'node:test';
import { createControllerFixture } from './page-markers-controller-fixture.js';
import { buildPanelSummary } from '../../src/panel/panel-summary.js';
import { createInstalledCoreRuleInventory } from '../../src/core/rules/core-rule-inventory.js';

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

test('an offered marker beyond global occurrence 64 opens its exact panel detail through the worker bridge', async () => {
  const changeDraft = draft => {
    const source = draft.occurrences.find(row => row.occurrenceId === 'occ-focus-failed');
    for (let index = 0; index < 64; index += 1) {
      const nodeId = `node-extra-${index}`, evidenceId = `ev-extra-${index}`;
      draft.ruleResults.find(row => row.ruleId === 'focus-visible').targets.push(nodeId);
      draft.occurrences.push({ ...structuredClone(source), occurrenceId: `occ-aaa-${String(index).padStart(2, '0')}`,
        nodeId, target: { nodeId, selector: null, framePath: [] }, evidenceIds: [evidenceId], evidenceRefs: [evidenceId] });
      draft.evidence.push({ ...structuredClone(draft.evidence[1]), evidenceId, nodeId, backendNodeId: 100 + index });
    }
  };
  const first = await createControllerFixture({ changeDraft });
  const inventory = await createInstalledCoreRuleInventory();
  const executionCheckpoint = { version: 1, auditId: first.model.auditId,
    pages: first.model.pages.map(page => ({ pageId: page.pageId, attempted: page.attempted,
      startedAt: page.attempted ? page.timestamps.startedAt : null, rulesVersion: inventory.rulesVersion,
      inventoryVersion: inventory.inventoryVersion, inventoryHash: inventory.sha256, outcomes: [] })) };
  const summary = await buildPanelSummary({ model: first.model, executionCheckpoint, inventory });
  const ids = Object.values(summary.groups).flatMap(cards => cards.flatMap(card => card.occurrenceIds))
    .sort((left, right) => left.localeCompare(right));
  const bundle = { ...first.bundle, details: ids.map(occurrenceId => ({ occurrenceId })) };
  const fixture = await createControllerFixture({ changeDraft, bundle });
  const shown = await fixture.dispatch('PANEL_SHOW_PAGE_MARKERS');
  assert.equal(first.model.occurrences.length, 67);
  assert.equal(ids.length, 64);
  assert.deepEqual(shown.markers.counts, { markers: 1, located: 63, unlocated: 0, general: 1, omitted: 3 });
  const ordinal = ids.indexOf('occ-focus-review');
  assert.equal(ordinal, 63);
  await fixture.dispatch('PANEL_FILTER_PAGE_MARKERS', { visibleOrdinals: String(ordinal) });
  fixture.page.environment.markerButtons()[0].click();
  const message = fixture.page.environment.messages.at(-1);
  assert.equal(message.selectionId, 's67');
  const bridge = createPageMarkersWorkerBridge({ controller: fixture.controller });
  assert.equal(isPageMarkersRuntimeMessage(message), true);
  assert.equal(bridge.handleRuntimeMessage(message, fixture.latestPort().sender), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fixture.calls.publish.at(-1).selectedOrdinal, ordinal);
});

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
  for (const selectionId of ['s65', 's71', 's5000']) {
    assert.equal(isPageMarkersRuntimeMessage({ ...selected, selectionId }), true);
  }
  for (const selectionId of ['s0', 's01', 's-1', 's1.5', 's9007199254740992']) {
    assert.equal(isPageMarkersRuntimeMessage({ ...selected, selectionId }), false);
  }
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
