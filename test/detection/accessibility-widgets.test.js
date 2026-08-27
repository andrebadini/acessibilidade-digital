import assert from 'node:assert/strict';
import test from 'node:test';

const detectorModule = await import('../../src/core/detection/accessibility-widgets.js').catch(() => null);

const emptySignals = () => ({
  coverage: 'complete',
  widgets: {
    vlibras: { dom: false, script: false, global: false },
    'hand-talk': { dom: false, script: false, global: false },
  },
});

test('emits the exact ordered informational inventory schema and signal taxonomy', () => {
  assert.ok(detectorModule, 'accessibility widget detector module must exist');
  const inventory = detectorModule.detectAccessibilityWidgets(emptySignals());
  assert.deepEqual(Object.keys(inventory).sort(), ['coverage', 'detector', 'version', 'widgets']);
  assert.equal(inventory.detector, 'audita.accessibility-widgets');
  assert.equal(inventory.version, '1.0.0');
  assert.equal(inventory.coverage, 'complete');
  assert.deepEqual(inventory.widgets, [
    { id: 'vlibras', status: 'absent', signals: [] },
    { id: 'hand-talk', status: 'absent', signals: [] },
  ]);
  assert.equal(Object.isFrozen(inventory), true);
  assert.equal(Object.isFrozen(inventory.widgets), true);
});

test('detects each widget from DOM, script and global booleans without inferring quality', () => {
  assert.ok(detectorModule, 'accessibility widget detector module must exist');
  const fields = [
    ['dom', 'dom-signature'], ['script', 'script-signature'], ['global', 'global-signature'],
  ];
  for (const widgetId of ['vlibras', 'hand-talk']) for (const [field, signal] of fields) {
    const observation = emptySignals();
    observation.widgets[widgetId][field] = true;
    const inventory = detectorModule.detectAccessibilityWidgets(observation);
    const widget = inventory.widgets.find(entry => entry.id === widgetId);
    assert.deepEqual(widget, { id: widgetId, status: 'present', signals: [signal] });
    assert.equal(Object.hasOwn(widget, 'quality'), false);
    assert.equal(Object.hasOwn(widget, 'conformance'), false);
  }

  const all = emptySignals();
  all.widgets.vlibras = { dom: true, script: true, global: true };
  assert.deepEqual(detectorModule.detectAccessibilityWidgets(all).widgets[0].signals, [
    'dom-signature', 'script-signature', 'global-signature',
  ]);
});

test('reports absence only for complete coverage and otherwise remains unknown', () => {
  assert.ok(detectorModule, 'accessibility widget detector module must exist');
  for (const coverage of ['partial', 'unavailable']) {
    const observation = emptySignals();
    observation.coverage = coverage;
    const inventory = detectorModule.detectAccessibilityWidgets(observation);
    assert.equal(inventory.coverage, coverage);
    assert.deepEqual(inventory.widgets.map(entry => entry.status), ['unknown', 'unknown']);
  }

  const partialPositive = emptySignals();
  partialPositive.coverage = 'partial';
  partialPositive.widgets['hand-talk'].script = true;
  assert.deepEqual(detectorModule.detectAccessibilityWidgets(partialPositive).widgets[1], {
    id: 'hand-talk', status: 'present', signals: ['script-signature'],
  });
});

test('contains malformed/accessor/revoked inputs and never emits private source or global values', () => {
  assert.ok(detectorModule, 'accessibility widget detector module must exist');
  let reads = 0;
  const hostile = emptySignals();
  Object.defineProperty(hostile.widgets.vlibras, 'dom', {
    enumerable: true, get() { reads += 1; return 'PRIVATE-DOM-SENTINEL'; },
  });
  Object.defineProperty(hostile.widgets['hand-talk'], 'global', {
    enumerable: true, get() { reads += 1; return { secret: 'PRIVATE-GLOBAL-SENTINEL' }; },
  });
  const pair = Proxy.revocable(emptySignals(), {});
  pair.revoke();

  const hostileInventory = detectorModule.detectAccessibilityWidgets(hostile);
  const revokedInventory = detectorModule.detectAccessibilityWidgets(pair.proxy);
  assert.equal(reads, 0);
  assert.equal(hostileInventory.widgets[0].status, 'unknown');
  assert.equal(hostileInventory.widgets[1].status, 'unknown');
  assert.equal(revokedInventory.coverage, 'unavailable');
  assert.deepEqual(revokedInventory.widgets.map(entry => entry.status), ['unknown', 'unknown']);
  assert.doesNotMatch(JSON.stringify([hostileInventory, revokedInventory]), /PRIVATE-|selector|scriptSrc|globalValue/iu);
});
