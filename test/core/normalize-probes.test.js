import test from 'node:test';
import assert from 'node:assert/strict';

import { runDynamicProbes } from '../../src/collector/dynamic-probes.js';
import { mergeProbesIntoSnapshot, normalizeProbes } from '../../src/core/normalize-probes.js';
import { runCoreAudit } from '../../src/core/index.js';

function completeRaw() {
  return {
    focus: {
      focusableCount: 2,
      completed: true,
      events: [
        { nodeId: 'n-101', selector: '#a', beforeCss: { outlineWidth: '0px' }, afterCss: { outlineWidth: '2px' }, rect: { x: 0, y: 0, width: 24, height: 24 }, intersectionRatio: 1, areaSufficient: true },
        { nodeId: 'n-102', selector: '#b', beforeCss: { outlineWidth: '0px' }, afterCss: { outlineWidth: '0px' }, rect: { x: 10, y: 10, width: 44, height: 44 }, intersectionRatio: 0.5, areaSufficient: false },
        { nodeId: 'n-102', selector: '#b', beforeCss: { outlineWidth: '0px' }, afterCss: { outlineWidth: '0px' }, rect: { x: 10, y: 10, width: 44, height: 44 }, intersectionRatio: 0.5, areaSufficient: false }
      ]
    },
    reflow: { testedWidthCssPx: 320, horizontalOverflow: true, exception: 'none', exceptionProof: 'complete' },
    textResize: { scalePercent: 200, lossOfContent: false },
    targetSizes: [
      { nodeId: 'n-201', width: 23.99, height: 24, exception: 'none', exceptionProof: 'complete' },
      { nodeId: 'n-202', width: 24, height: 24, exception: 'none', exceptionProof: 'complete' },
      { nodeId: 'n-203', width: 43.99, height: 44, exception: 'none', exceptionProof: 'complete' },
      { nodeId: 'n-204', width: 44, height: 44, exception: 'none', exceptionProof: 'complete' }
    ],
    motion: { prefersReducedMotion: true, animatedCount: 2, reducedAnimatedCount: 1, complete: true },
    warnings: [],
    actions: [{ type: 'key', key: 'Tab' }]
  };
}

test('normalizes focus order, repeated-focus traps, CSS change and viewport intersection', () => {
  const probes = normalizeProbes(completeRaw());
  assert.deepEqual(probes.focusOrder.targets, ['n-101', 'n-102', 'n-102']);
  assert.equal(probes.focusOrder.outcome, 'passed');
  assert.equal(probes.keyboardTraps.outcome, 'failed');
  assert.deepEqual(probes.keyboardTraps.targets, ['n-102']);
  assert.equal(probes.focusAppearance.outcome, 'failed');
  assert.deepEqual(probes.focusAppearance.targets, ['n-102']);
  assert.equal(probes.obscuredTargets.outcome, 'failed');
  assert.deepEqual(probes.obscuredTargets.targets, ['n-102']);
});

test('normalizes exact 320 px, 200%, 24/44 boundaries and reduced motion', () => {
  const probes = normalizeProbes(completeRaw());
  assert.equal(probes.reflow.outcome, 'failed');
  assert.equal(probes.reflow.testedWidthCssPx, 320);
  assert.equal(probes.textResize.outcome, 'cantTell');
  assert.equal(probes.textResize.scalePercent, 200);
  assert.deepEqual(probes.targetSizes.minimum24.failedNodeIds, ['n-201']);
  assert.deepEqual(probes.targetSizes.enhanced44.failedNodeIds, ['n-201', 'n-202', 'n-203']);
  assert.equal(probes.targetSizes.observations.find(item => item.nodeId === 'n-202').minimum24, true);
  assert.equal(probes.targetSizes.observations.find(item => item.nodeId === 'n-204').enhanced44, true);
  assert.equal(probes.motion.outcome, 'failed');
  assert.equal(probes.motion.prefersReducedMotion, true);
});

test('absence of horizontal overflow does not certify reflow or discard the measured width', async () => {
  for (const exception of ['unknown', 'none', 'essential']) {
    const probes = normalizeProbes({ reflow: { testedWidthCssPx: 320, horizontalOverflow: false, exception, exceptionProof: 'complete' } });
    assert.equal(probes.reflow.outcome, 'cantTell');
    assert.equal(probes.reflow.testedWidthCssPx, 320);
    assert.equal(probes.reflow.horizontalOverflow, false);
    assert.equal(probes.probeCoverage.reflow, 'cantTell');
    const merged = mergeProbesIntoSnapshot({ schemaVersion: 1, document: { nodeId: 'document', title: 'Fixture' }, nodes: [] }, probes);
    assert.equal(merged.document.dynamicProbes.reflow.horizontalOverflow, false);
    const audit = await runCoreAudit(merged);
    assert.equal(audit.ruleResults.find(rule => rule.ruleId === 'responsive-reflow').outcome, 'cantTell');
  }
});

test('missing, timed-out or incomplete observations remain cantTell', () => {
  const probes = normalizeProbes({ warnings: [{ code: 'TIMEOUT', message: 'limite token=PROBE_WARNING_FAKE' }], actions: [{ type: 'ACTION_MARKER_FAKE', detail: 'authorization=ACTION_FAKE' }] });
  for (const key of ['focusOrder', 'keyboardTraps', 'focusAppearance', 'obscuredTargets', 'reflow', 'textResize', 'motion']) {
    assert.equal(probes[key].outcome, 'cantTell');
  }
  assert.equal(probes.targetSizes.minimum24.outcome, 'cantTell');
  assert.equal(probes.targetSizes.enhanced44.outcome, 'cantTell');
  assert.deepEqual(probes.warnings, [{ code: 'TIMEOUT', message: 'Uma medição excedeu o tempo limite.' }]);
  assert.doesNotMatch(JSON.stringify(probes), /PROBE_WARNING_FAKE|ACTION_FAKE|ACTION_MARKER_FAKE/);
});

test('small targets without an observed exception remain cantTell', () => {
  const probes = normalizeProbes({ targetSizes: [{ nodeId: 'unknown', width: 20, height: 20 }], warnings: [], actions: [] });
  assert.equal(probes.targetSizes.minimum24.outcome, 'cantTell');
  assert.equal(probes.targetSizes.enhanced44.outcome, 'cantTell');
  assert.equal(probes.targetSizes.observations[0].exception, 'unknown');
});

test('fails closed when reflow and target-size exception states are absent or hostile', () => {
  for (const exception of [undefined, 'none', 'PRIVATE-exception', '<script>']) {
    const probes = normalizeProbes({
      reflow: { testedWidthCssPx: 320, horizontalOverflow: true, ...(exception === undefined ? {} : { exception }) },
      targetSizes: [{ nodeId: 'n-201', width: 20, height: 20, ...(exception === undefined ? {} : { exception }) }],
      warnings: [], actions: [],
    });
    assert.equal(probes.reflow.outcome, 'cantTell');
    assert.equal(probes.reflow.exception, 'unknown');
    assert.equal(probes.targetSizes.minimum24.outcome, 'cantTell');
    assert.equal(probes.targetSizes.observations[0].exception, 'unknown');
    assert.doesNotMatch(JSON.stringify(probes), /PRIVATE|script/iu);
  }
});

test('reads exception evidence only from own data descriptors without invoking hostile getters', () => {
  let getterReads = 0;
  const accessorReflow = { testedWidthCssPx: 320, horizontalOverflow: true };
  Object.defineProperty(accessorReflow, 'exception', {
    enumerable: true,
    get() { getterReads += 1; return 'none'; },
  });
  Object.defineProperty(accessorReflow, 'exceptionProof', {
    enumerable: true,
    get() { getterReads += 1; return 'complete'; },
  });
  const inheritedTarget = Object.create({ exception: 'none', exceptionProof: 'complete' });
  Object.assign(inheritedTarget, { nodeId: 'n-201', width: 20, height: 20 });

  const probes = normalizeProbes({
    reflow: accessorReflow,
    targetSizes: [inheritedTarget],
    warnings: [], actions: [],
  });

  assert.equal(getterReads, 0);
  assert.equal(probes.reflow.exception, 'unknown');
  assert.equal(probes.reflow.outcome, 'cantTell');
  assert.equal(probes.targetSizes.observations[0].exception, 'unknown');
  assert.equal(probes.targetSizes.minimum24.outcome, 'cantTell');
});

test('treats revoked reflow and target observations as unknown without executing or throwing', () => {
  const reflowPair = Proxy.revocable({
    testedWidthCssPx: 320, horizontalOverflow: true, exception: 'none', exceptionProof: 'complete',
  }, {});
  const targetPair = Proxy.revocable({
    nodeId: 'n-201', width: 20, height: 20, exception: 'none', exceptionProof: 'complete',
  }, {});
  reflowPair.revoke();
  targetPair.revoke();

  const probes = normalizeProbes({
    reflow: reflowPair.proxy,
    targetSizes: [targetPair.proxy],
    warnings: [], actions: [],
  });

  assert.equal(probes.reflow.exception, 'unknown');
  assert.equal(probes.reflow.outcome, 'cantTell');
  assert.equal(probes.targetSizes.minimum24.outcome, 'cantTell');
  assert.deepEqual(probes.targetSizes.observations, []);
});

test('snapshots target-size arrays without consulting a hostile iterator', () => {
  const marker = 'PRIVATE_TARGET_ITERATOR_MESSAGE';
  let iteratorGetterReads = 0;
  let iteratorGetTraps = 0;
  const targetSizes = [{
    nodeId: 'n-201', width: 20, height: 20, exception: 'none', exceptionProof: 'complete',
  }];
  Object.defineProperty(targetSizes, Symbol.iterator, {
    configurable: true,
    get() {
      iteratorGetterReads += 1;
      throw new Error(marker);
    },
  });
  const proxiedTargets = new Proxy(targetSizes, {
    get(target, property, receiver) {
      if (property === Symbol.iterator) iteratorGetTraps += 1;
      return Reflect.get(target, property, receiver);
    },
  });

  const probes = normalizeProbes({ targetSizes: proxiedTargets, warnings: [], actions: [] });

  assert.equal(iteratorGetterReads, 0);
  assert.equal(iteratorGetTraps, 0);
  assert.equal(probes.targetSizes.minimum24.outcome, 'cantTell');
  assert.equal(probes.targetSizes.enhanced44.outcome, 'cantTell');
  assert.deepEqual(probes.targetSizes.observations, []);
  assert.doesNotMatch(JSON.stringify(probes), new RegExp(marker));
});

test('rejects sparse and accessor target-size slots without reading an index value', () => {
  const marker = 'PRIVATE_TARGET_INDEX_MESSAGE';
  let indexGetterReads = 0;
  const sparse = new Array(1);
  const accessor = new Array(1);
  Object.defineProperty(accessor, '0', {
    configurable: true,
    enumerable: true,
    get() {
      indexGetterReads += 1;
      throw new Error(marker);
    },
  });

  for (const targetSizes of [sparse, accessor]) {
    const probes = normalizeProbes({ targetSizes, warnings: [], actions: [] });
    assert.equal(probes.targetSizes.minimum24.outcome, 'cantTell');
    assert.equal(probes.targetSizes.enhanced44.outcome, 'cantTell');
    assert.deepEqual(probes.targetSizes.observations, []);
    assert.doesNotMatch(JSON.stringify(probes), new RegExp(marker));
  }
  assert.equal(indexGetterReads, 0);
});

test('contains target-size length descriptor failures without propagating private errors', () => {
  const marker = 'PRIVATE_TARGET_LENGTH_MESSAGE';
  const targetSizes = new Proxy([{
    nodeId: 'n-201', width: 20, height: 20, exception: 'none', exceptionProof: 'complete',
  }], {
    getOwnPropertyDescriptor(target, property) {
      if (property === 'length') throw new Error(marker);
      return Reflect.getOwnPropertyDescriptor(target, property);
    },
  });

  const probes = normalizeProbes({ targetSizes, warnings: [], actions: [] });

  assert.equal(probes.targetSizes.minimum24.outcome, 'cantTell');
  assert.equal(probes.targetSizes.enhanced44.outcome, 'cantTell');
  assert.deepEqual(probes.targetSizes.observations, []);
  assert.doesNotMatch(JSON.stringify(probes), new RegExp(marker));
});

test('bounds dense target-size collections before copying their slots', () => {
  const targetSizes = new Array(5_001).fill({
    nodeId: 'n-201', width: 20, height: 20, exception: 'none', exceptionProof: 'complete',
  });

  const probes = normalizeProbes({ targetSizes, warnings: [], actions: [] });

  assert.equal(probes.targetSizes.minimum24.outcome, 'cantTell');
  assert.equal(probes.targetSizes.enhanced44.outcome, 'cantTell');
  assert.deepEqual(probes.targetSizes.observations, []);
});

test('invalidates the entire target-size collection when any observation leaf is unsafe or partial', () => {
  const marker = 'PRIVATE_TARGET_LEAF_MESSAGE';
  let getterReads = 0;
  const accessor = { nodeId: 'n-202', height: 44, exception: 'none', exceptionProof: 'complete' };
  Object.defineProperty(accessor, 'width', {
    enumerable: true,
    get() {
      getterReads += 1;
      throw new Error(marker);
    },
  });
  const revoked = Proxy.revocable({
    nodeId: 'n-202', width: 44, height: 44, exception: 'none', exceptionProof: 'complete',
  }, {});
  revoked.revoke();
  const trapped = new Proxy({
    nodeId: 'n-202', width: 44, height: 44, exception: 'none', exceptionProof: 'complete',
  }, {
    getOwnPropertyDescriptor() { throw new Error(marker); },
  });
  const invalidObservations = [
    accessor,
    revoked.proxy,
    trapped,
    { nodeId: 'n-202', width: 44 },
    { nodeId: 'n-202', width: 44, height: 44, unexpected: marker },
    { selector: `#${'a'.repeat(4_097)}`, width: 44, height: 44 },
  ];
  const valid = {
    nodeId: 'n-201', width: 44, height: 44, exception: 'none', exceptionProof: 'complete',
  };

  for (const invalid of invalidObservations) {
    let probes;
    assert.doesNotThrow(() => {
      probes = normalizeProbes({ targetSizes: [valid, invalid], warnings: [], actions: [] });
    });
    assert.equal(probes.targetSizes.minimum24.outcome, 'cantTell');
    assert.equal(probes.targetSizes.enhanced44.outcome, 'cantTell');
    assert.equal(probes.probeCoverage.targetSizes, 'cantTell');
    assert.deepEqual(probes.targetSizes.observations, []);
    assert.doesNotMatch(JSON.stringify(probes), new RegExp(marker));
  }
  assert.equal(getterReads, 0);
});

test('uses the same dense boundary for other raw probe collections', () => {
  const marker = 'PRIVATE_OTHER_COLLECTION_MESSAGE';
  let getterReads = 0;
  const focusEvents = new Array(1);
  const actions = new Array(1);
  const warnings = new Array(1);
  for (const values of [focusEvents, actions, warnings]) {
    Object.defineProperty(values, '0', {
      configurable: true,
      enumerable: true,
      get() {
        getterReads += 1;
        throw new Error(marker);
      },
    });
  }

  const probes = normalizeProbes({
    focus: { completed: true, focusableCount: 1, events: focusEvents },
    targetSizes: [], actions, warnings,
  });

  assert.equal(getterReads, 0);
  assert.equal(probes.focusOrder.outcome, 'cantTell');
  assert.equal(probes.keyboardTraps.outcome, 'cantTell');
  assert.equal(probes.focusAppearance.outcome, 'cantTell');
  assert.equal(probes.obscuredTargets.outcome, 'cantTell');
  assert.deepEqual(probes.actions, []);
  assert.deepEqual(probes.warnings, [{
    code: 'WARNINGS_UNAVAILABLE',
    message: 'Os avisos de coleta não puderam ser normalizados com segurança.',
  }]);
  assert.doesNotMatch(JSON.stringify(probes), new RegExp(marker));
});

test('marks an accessor-backed warnings property unavailable without invoking it', () => {
  const marker = 'PRIVATE_WARNINGS_PROPERTY_MESSAGE';
  let getterReads = 0;
  const raw = {};
  Object.defineProperty(raw, 'warnings', {
    enumerable: true,
    get() {
      getterReads += 1;
      throw new Error(marker);
    },
  });

  let probes;
  assert.doesNotThrow(() => { probes = normalizeProbes(raw); });
  assert.equal(getterReads, 0);
  assert.deepEqual(probes.warnings, [{
    code: 'WARNINGS_UNAVAILABLE',
    message: 'Os avisos de coleta não puderam ser normalizados com segurança.',
  }]);
  assert.doesNotMatch(JSON.stringify(probes), new RegExp(marker));
});

test('rejects accessor-backed focus-event leaves without invoking them', () => {
  const values = {
    indicatorVisible: true,
    beforeCss: { outline: '0px none' },
    afterCss: { outline: '2px solid' },
    areaSufficient: true,
    intersectionRatio: 1,
    rect: { x: 0, y: 0, width: 24, height: 24 },
  };

  for (const [field, value] of Object.entries(values)) {
    const marker = `PRIVATE_FOCUS_${field.toUpperCase()}_MESSAGE`;
    let getterReads = 0;
    const event = { nodeId: 'n-101', ...values };
    Object.defineProperty(event, field, {
      enumerable: true,
      get() {
        getterReads += 1;
        throw new Error(marker);
      },
    });

    let probes;
    assert.doesNotThrow(() => {
      probes = normalizeProbes({
        focus: { focusableCount: 1, completed: true, events: [event] },
        warnings: [], actions: [], targetSizes: [],
      });
    }, field);
    assert.equal(getterReads, 0, field);
    for (const key of ['focusOrder', 'keyboardTraps', 'focusAppearance', 'obscuredTargets']) {
      assert.equal(probes[key].outcome, 'cantTell', `${field}:${key}`);
    }
    assert.equal(probes.focusOrder.focusableCount, null, field);
    assert.deepEqual(probes.focusAppearance.observations, [], field);
    assert.deepEqual(probes.obscuredTargets.observations, [], field);
    assert.doesNotMatch(JSON.stringify(probes), new RegExp(marker), field);
  }
});

test('rejects accessor, inherited and partial nested focus measurements without accepting fragments', () => {
  const marker = 'PRIVATE_NESTED_FOCUS_MESSAGE';
  let getterReads = 0;
  const accessorCss = {};
  Object.defineProperty(accessorCss, 'outline', {
    enumerable: true,
    get() {
      getterReads += 1;
      throw new Error(marker);
    },
  });
  const accessorRect = { y: 0, width: 24, height: 24 };
  Object.defineProperty(accessorRect, 'x', {
    enumerable: true,
    get() {
      getterReads += 1;
      throw new Error(marker);
    },
  });
  const inherited = Object.create({
    indicatorVisible: true,
    beforeCss: { outline: '0px none' },
    afterCss: { outline: '2px solid' },
    areaSufficient: true,
    intersectionRatio: 1,
    rect: { x: 0, y: 0, width: 24, height: 24 },
  });
  inherited.nodeId = 'n-101';
  const inheritedCss = Object.create({ outline: '0px none' });
  const inheritedRect = Object.create({ x: 0, y: 0, width: 24, height: 24 });
  const revokedCss = Proxy.revocable({ outline: '0px none' }, {});
  revokedCss.revoke();
  const revokedRect = Proxy.revocable({ x: 0, y: 0, width: 24, height: 24 }, {});
  revokedRect.revoke();
  const trappedCss = new Proxy({ outline: '0px none' }, {
    ownKeys() { throw new Error(marker); },
  });
  const trappedRect = new Proxy({ x: 0, y: 0, width: 24, height: 24 }, {
    getOwnPropertyDescriptor() { throw new Error(marker); },
  });

  const cases = [
    {
      nodeId: 'n-101', indicatorVisible: true,
      beforeCss: accessorCss, afterCss: { outline: '2px solid' },
      areaSufficient: true, intersectionRatio: 1,
      rect: { x: 0, y: 0, width: 24, height: 24 },
    },
    {
      nodeId: 'n-101', indicatorVisible: true,
      beforeCss: { outline: '0px none' }, afterCss: { outline: '2px solid' },
      areaSufficient: true, intersectionRatio: 1, rect: accessorRect,
    },
    inherited,
    ...[inheritedCss, revokedCss.proxy, trappedCss].map(beforeCss => ({
      nodeId: 'n-101', indicatorVisible: true,
      beforeCss, afterCss: { outline: '2px solid' },
      areaSufficient: true, intersectionRatio: 1,
      rect: { x: 0, y: 0, width: 24, height: 24 },
    })),
    ...[inheritedRect, revokedRect.proxy, trappedRect].map(rect => ({
      nodeId: 'n-101', indicatorVisible: true,
      beforeCss: { outline: '0px none' }, afterCss: { outline: '2px solid' },
      areaSufficient: true, intersectionRatio: 1, rect,
    })),
    {
      nodeId: 'n-101', indicatorVisible: true,
      beforeCss: { outline: '0px none' }, afterCss: { outline: '2px solid' },
      areaSufficient: true, intersectionRatio: 1,
      rect: { x: 0, y: 0, width: 24 },
    },
    {
      nodeId: 'n-101', indicatorVisible: true,
      beforeCss: { outline: '0px none' },
      areaSufficient: true, intersectionRatio: 1,
      rect: { x: 0, y: 0, width: 24, height: 24 },
    },
  ];

  for (const event of cases) {
    const probes = normalizeProbes({
      focus: { focusableCount: 1, completed: true, events: [event] },
      warnings: [], actions: [], targetSizes: [],
    });
    for (const key of ['focusOrder', 'keyboardTraps', 'focusAppearance', 'obscuredTargets']) {
      assert.equal(probes[key].outcome, 'cantTell', key);
    }
    assert.equal(probes.focusOrder.focusableCount, null);
    assert.deepEqual(probes.focusAppearance.observations, []);
    assert.deepEqual(probes.obscuredTargets.observations, []);
    assert.doesNotMatch(JSON.stringify(probes), new RegExp(marker));
  }
  assert.equal(getterReads, 0);
});

test('contains revoked and throwing descriptor traps in focus leaves', () => {
  const marker = 'PRIVATE_FOCUS_TRAP_MESSAGE';
  const revoked = Proxy.revocable({
    nodeId: 'n-101', indicatorVisible: true,
    beforeCss: { outline: '0px none' }, afterCss: { outline: '2px solid' },
    areaSufficient: true, intersectionRatio: 1,
    rect: { x: 0, y: 0, width: 24, height: 24 },
  }, {});
  revoked.revoke();
  const trapped = new Proxy({ nodeId: 'n-101' }, {
    getOwnPropertyDescriptor() { throw new Error(marker); },
  });

  for (const event of [revoked.proxy, trapped]) {
    const probes = normalizeProbes({
      focus: { focusableCount: 1, completed: true, events: [event] },
      warnings: [], actions: [], targetSizes: [],
    });
    for (const key of ['focusOrder', 'keyboardTraps', 'focusAppearance', 'obscuredTargets']) {
      assert.equal(probes[key].outcome, 'cantTell', key);
    }
    assert.equal(probes.focusOrder.focusableCount, null);
    assert.deepEqual(probes.focusAppearance.observations, []);
    assert.deepEqual(probes.obscuredTargets.observations, []);
    assert.doesNotMatch(JSON.stringify(probes), new RegExp(marker));
  }
});

test('rejects accessor-backed text-resize leaves without invoking them', () => {
  for (const field of ['scalePercent', 'lossOfContent']) {
    const marker = `PRIVATE_TEXT_RESIZE_${field.toUpperCase()}_MESSAGE`;
    let getterReads = 0;
    const textResize = { scalePercent: 200, lossOfContent: false };
    Object.defineProperty(textResize, field, {
      enumerable: true,
      get() {
        getterReads += 1;
        throw new Error(marker);
      },
    });
    let probes;
    assert.doesNotThrow(() => { probes = normalizeProbes({ textResize }); }, field);
    assert.equal(getterReads, 0, field);
    assert.deepEqual(probes.textResize, { outcome: 'cantTell', scalePercent: null, lossOfContent: null }, field);
    assert.doesNotMatch(JSON.stringify(probes), new RegExp(marker), field);
  }

  const marker = 'PRIVATE_TEXT_RESIZE_ROOT_MESSAGE';
  let getterReads = 0;
  const raw = {};
  Object.defineProperty(raw, 'textResize', {
    enumerable: true,
    get() {
      getterReads += 1;
      throw new Error(marker);
    },
  });
  const probes = normalizeProbes(raw);
  assert.equal(getterReads, 0);
  assert.deepEqual(probes.textResize, { outcome: 'cantTell', scalePercent: null, lossOfContent: null });
  assert.doesNotMatch(JSON.stringify(probes), new RegExp(marker));
});

test('rejects inherited, revoked, trapped and partial text-resize records', () => {
  const inherited = Object.create({ scalePercent: 200, lossOfContent: false });
  const revoked = Proxy.revocable({ scalePercent: 200, lossOfContent: false }, {});
  revoked.revoke();
  const marker = 'PRIVATE_TEXT_RESIZE_TRAP_MESSAGE';
  const trapped = new Proxy({ scalePercent: 200, lossOfContent: false }, {
    getOwnPropertyDescriptor() { throw new Error(marker); },
  });

  for (const textResize of [inherited, revoked.proxy, trapped, { scalePercent: 200 }, { lossOfContent: false }]) {
    const probes = normalizeProbes({ textResize });
    assert.deepEqual(probes.textResize, { outcome: 'cantTell', scalePercent: null, lossOfContent: null });
    assert.doesNotMatch(JSON.stringify(probes), new RegExp(marker));
  }
});

test('rejects accessor-backed motion leaves without invoking them', () => {
  const cases = {
    prefersReducedMotion: { complete: true, prefersReducedMotion: true, animatedCount: 2, reducedAnimatedCount: 1 },
    preference: { complete: true, preference: 'reduce', animatedCount: 2, reducedAnimatedCount: 1 },
    complete: { complete: true, prefersReducedMotion: true, animatedCount: 2, reducedAnimatedCount: 1 },
    animatedCount: { complete: true, prefersReducedMotion: true, animatedCount: 2, reducedAnimatedCount: 1 },
    reducedAnimatedCount: { complete: true, prefersReducedMotion: true, animatedCount: 2, reducedAnimatedCount: 1 },
  };

  for (const [field, motion] of Object.entries(cases)) {
    const marker = `PRIVATE_MOTION_${field.toUpperCase()}_MESSAGE`;
    let getterReads = 0;
    Object.defineProperty(motion, field, {
      enumerable: true,
      get() {
        getterReads += 1;
        throw new Error(marker);
      },
    });
    let probes;
    assert.doesNotThrow(() => { probes = normalizeProbes({ motion }); }, field);
    assert.equal(getterReads, 0, field);
    assert.deepEqual(probes.motion, {
      outcome: 'cantTell', prefersReducedMotion: null, animatedCount: null, reducedAnimatedCount: null,
    }, field);
    assert.doesNotMatch(JSON.stringify(probes), new RegExp(marker), field);
  }
});

test('rejects inherited, revoked, trapped and partial motion records', () => {
  const inherited = Object.create({
    complete: true, preference: 'reduce', prefersReducedMotion: true,
    animatedCount: 2, reducedAnimatedCount: 1,
  });
  const revoked = Proxy.revocable({
    complete: true, preference: 'reduce', prefersReducedMotion: true,
    animatedCount: 2, reducedAnimatedCount: 1,
  }, {});
  revoked.revoke();
  const marker = 'PRIVATE_MOTION_TRAP_MESSAGE';
  const trapped = new Proxy({
    complete: true, preference: 'reduce', prefersReducedMotion: true,
    animatedCount: 2, reducedAnimatedCount: 1,
  }, {
    getOwnPropertyDescriptor() { throw new Error(marker); },
  });

  for (const motion of [
    inherited, revoked.proxy, trapped,
    { complete: true, prefersReducedMotion: true, animatedCount: 2 },
  ]) {
    const probes = normalizeProbes({ motion });
    assert.deepEqual(probes.motion, {
      outcome: 'cantTell', prefersReducedMotion: null, animatedCount: null, reducedAnimatedCount: null,
    });
    assert.doesNotMatch(JSON.stringify(probes), new RegExp(marker));
  }
});

test('contains a revoked raw probe root as wholly unavailable', () => {
  const revoked = Proxy.revocable(completeRaw(), {});
  revoked.revoke();
  let probes;
  assert.doesNotThrow(() => { probes = normalizeProbes(revoked.proxy); });
  for (const key of ['focusOrder', 'keyboardTraps', 'focusAppearance', 'obscuredTargets', 'reflow', 'textResize', 'motion']) {
    assert.equal(probes[key].outcome, 'cantTell', key);
  }
  assert.equal(probes.targetSizes.minimum24.outcome, 'cantTell');
  assert.equal(probes.targetSizes.enhanced44.outcome, 'cantTell');
  assert.deepEqual(probes.warnings, [{
    code: 'WARNINGS_UNAVAILABLE',
    message: 'Os avisos de coleta não puderam ser normalizados com segurança.',
  }]);
  assert.deepEqual(probes.actions, []);
});

test('bounds focus leaf strings and never coerces hostile leaf values', () => {
  const marker = 'PRIVATE_PROBE_COERCION_MESSAGE';
  let coercions = 0;
  const hostileValue = {
    [Symbol.toPrimitive]() {
      coercions += 1;
      throw new Error(marker);
    },
  };
  const focusEvents = [
    {
      nodeId: 'n-101', selector: '#a', frameId: hostileValue,
      indicatorVisible: true, intersectionRatio: 1,
    },
    {
      nodeId: 'n-101', selector: '#a',
      beforeCss: { outline: hostileValue }, afterCss: { outline: '2px solid' },
      intersectionRatio: 1,
    },
    {
      nodeId: 'n-101', selector: '#a', indicatorVisible: true,
      intersectionRatio: 1, rect: { x: hostileValue, y: 0, width: 24, height: 24 },
    },
    {
      nodeId: 'n-101', selector: `#${'a'.repeat(4_097)}`,
      indicatorVisible: true, intersectionRatio: 1,
    },
  ];

  for (const event of focusEvents) {
    const probes = normalizeProbes({
      focus: { focusableCount: 1, completed: true, events: [event] },
      textResize: { scalePercent: hostileValue, lossOfContent: false },
      motion: {
        complete: true, prefersReducedMotion: true,
        animatedCount: hostileValue, reducedAnimatedCount: 0,
      },
    });
    assert.equal(probes.focusOrder.outcome, 'cantTell');
    assert.deepEqual(probes.textResize, { outcome: 'cantTell', scalePercent: null, lossOfContent: null });
    assert.deepEqual(probes.motion, {
      outcome: 'cantTell', prefersReducedMotion: null, animatedCount: null, reducedAnimatedCount: null,
    });
    assert.doesNotMatch(JSON.stringify(probes), new RegExp(marker));
  }
  assert.equal(coercions, 0);
});

test('does not coerce an object frameId while correlating selector fallbacks during merge', () => {
  const marker = 'PRIVATE_MERGE_FRAME_COERCION_MESSAGE';
  let coercions = 0;
  const hostileFrameId = {
    [Symbol.toPrimitive]() {
      coercions += 1;
      throw new Error(marker);
    },
  };
  const snapshot = {
    schemaVersion: 1,
    document: { nodeId: 'document', title: 'Fixture' },
    nodes: [{
      nodeId: 'n-301', parentId: null, children: [], tagName: 'button', attributes: {},
      selectorHint: '#target', frameId: hostileFrameId, focusable: true,
    }],
  };
  const probes = normalizeProbes({
    targetSizes: [{
      selector: '#target', frameId: 'main', width: 44, height: 44,
      exception: 'none', exceptionProof: 'complete',
    }],
  });

  let merged;
  assert.doesNotThrow(() => { merged = mergeProbesIntoSnapshot(snapshot, probes); });
  assert.equal(coercions, 0);
  assert.equal(Object.hasOwn(merged.nodes[0], 'targetSize'), false);
  assert.doesNotMatch(JSON.stringify(merged), new RegExp(marker));
});

test('does not read accessor slots in nested action threshold collections', () => {
  const marker = 'PRIVATE_ACTION_THRESHOLD_MESSAGE';
  let getterReads = 0;
  const thresholdsCssPx = new Array(1);
  Object.defineProperty(thresholdsCssPx, '0', {
    configurable: true,
    enumerable: true,
    get() {
      getterReads += 1;
      throw new Error(marker);
    },
  });

  const probes = normalizeProbes({
    targetSizes: [], warnings: [],
    actions: [{ type: 'measure-targets', thresholdsCssPx }],
  });

  assert.equal(getterReads, 0);
  assert.deepEqual(probes.actions, [{ type: 'measure-targets' }]);
  assert.doesNotMatch(JSON.stringify(probes), new RegExp(marker));
});

test('only preserves authoritative SnapshotV1 node IDs and assigns opaque IDs to arbitrary nodeId or selector values', () => {
  const marker = 'PROBE_NODE_PRIVACY_MARKER';
  const raw = {
    focus: {
      focusableCount: 4,
      completed: true,
      events: [
        { nodeId: 'n-42', indicatorVisible: true, intersectionRatio: 1 },
        { nodeId: 'n-0042', indicatorVisible: true, intersectionRatio: 1 },
        { nodeId: `password-token-${marker}`, indicatorVisible: false, intersectionRatio: 0 },
        { selector: `#secret-${marker}`, indicatorVisible: false, intersectionRatio: 0 }
      ]
    },
    targetSizes: [{ nodeId: `authorization-${marker}`, width: 1, height: 1, exception: 'none' }]
  };
  const first = normalizeProbes(raw);
  const second = normalizeProbes(raw);
  assert.equal(first.focusOrder.targets[0], 'n-42');
  for (const id of [
    ...first.focusOrder.targets,
    ...first.keyboardTraps.targets,
    ...first.focusAppearance.targets,
    ...first.obscuredTargets.targets,
    ...first.focusAppearance.observations.map(item => item.nodeId),
    ...first.obscuredTargets.observations.map(item => item.nodeId),
    ...first.targetSizes.minimum24.failedNodeIds,
    ...first.targetSizes.enhanced44.failedNodeIds,
    ...first.targetSizes.observations.map(item => item.nodeId)
  ]) assert.match(id, /^(?:n-42|probe-\d+)$/u);
  assert.deepEqual(first, second);
  assert.doesNotMatch(JSON.stringify(first), new RegExp(marker));
});

test('keeps two selectors that collide under the legacy 32-bit hash as distinct probe identities', () => {
  const probes = normalizeProbes({ targetSizes: [
    { selector: '#p-kinuqo', frameId: 'main', width: 20, height: 20, exception: 'none' },
    { selector: '#p-1h27v3v', frameId: 'main', width: 44, height: 44, exception: 'none' },
  ] });
  assert.equal(new Set(probes.targetSizes.observations.map(item => item.nodeId)).size, 2);
});

test('runDynamicProbes caps Tab traversal at focusableCount plus two and records no destructive action', async () => {
  let tabCount = 0;
  const cleanup = [];
  const adapter = {
    snapshotState: async () => ({ focus: '#start', scroll: { x: 4, y: 5 }, viewport: { width: 1280, height: 720 }, styles: 'original' }),
    installNavigationGuards: async () => {},
    getFocusableCount: async () => 3,
    pressTab: async () => ({ nodeId: `n${++tabCount}`, selector: `#n${tabCount}`, beforeCss: {}, afterCss: { outlineWidth: '2px' }, intersectionRatio: 1 }),
    measureReflow: async width => ({ testedWidthCssPx: width, horizontalOverflow: false, exception: 'none' }),
    measureTextResize: async percent => ({ scalePercent: percent, lossOfContent: false }),
    measureTargetSizes: async () => [],
    measureMotion: async () => ({ prefersReducedMotion: false, animatedCount: 0, reducedAnimatedCount: 0, complete: true }),
    removeNavigationGuards: async () => cleanup.push('listeners'),
    restoreStyles: async value => cleanup.push(`styles:${value}`),
    restoreViewport: async value => cleanup.push(`viewport:${value.width}`),
    restoreScroll: async value => cleanup.push(`scroll:${value.x},${value.y}`),
    restoreFocus: async value => cleanup.push(`focus:${value}`)
  };
  const raw = await runDynamicProbes({ adapter });
  assert.equal(tabCount, 5);
  assert.equal(raw.focus.events.length, 5);
  assert.equal(raw.actions.filter(action => action.type === 'key' && action.key === 'Tab').length, 5);
  assert.equal(raw.actions.some(action => ['click', 'submit', 'navigate'].includes(action.type)), false);
  assert.deepEqual(cleanup, ['listeners', 'styles:original', 'viewport:1280', 'scroll:4,5', 'focus:#start']);
});

test('runDynamicProbes restores captured or installed state after each probe-stage rejection', async () => {
  const stages = ['getFocusableCount', 'pressTab', 'measureReflow', 'measureTextResize', 'measureTargetSizes', 'measureMotion'];
  for (const failingStage of stages) {
    const restored = new Set();
    const adapter = {
      snapshotState: async () => ({ focus: 'x', scroll: {}, viewport: {}, styles: {} }),
      installNavigationGuards: async () => {}, getFocusableCount: async () => 1,
      pressTab: async () => ({ nodeId: 'x', selector: '#x', beforeCss: {}, afterCss: {}, intersectionRatio: 1 }),
      measureReflow: async () => ({}), measureTextResize: async () => ({}), measureTargetSizes: async () => [], measureMotion: async () => ({}),
      removeNavigationGuards: async () => restored.add('listeners'), restoreStyles: async () => restored.add('styles'),
      restoreViewport: async () => restored.add('viewport'), restoreScroll: async () => restored.add('scroll'), restoreFocus: async () => restored.add('focus')
    };
    adapter[failingStage] = async () => { throw new Error(`${failingStage} rejected`); };
    const raw = await runDynamicProbes({ adapter });
    assert.deepEqual([...restored].sort(), ['focus', 'listeners', 'scroll', 'styles', 'viewport'], failingStage);
    assert.equal(raw.warnings.length > 0, true);
  }
});

test('mandatory baseline and guard failures abort before Tab or viewport mutations', async () => {
  for (const failure of ['snapshotState', 'installNavigationGuards']) {
    const calls = [];
    const adapter = {
      snapshotState: async () => ({ focus: null, scroll: {}, viewport: {}, styles: {} }),
      installNavigationGuards: async () => {},
      getFocusableCount: async () => { calls.push('focus'); return 1; },
      measureReflow: async () => { calls.push('reflow'); return {}; },
      restoreStyles: async () => calls.push('restoreStyles'), restoreViewport: async () => calls.push('restoreViewport'),
      restoreScroll: async () => calls.push('restoreScroll'), restoreFocus: async () => calls.push('restoreFocus'),
      removeNavigationGuards: async () => calls.push('removeNavigationGuards')
    };
    adapter[failure] = async () => { throw new Error('token=DO_NOT_SERIALIZE'); };
    const raw = await runDynamicProbes({ adapter, timeoutMs: 20, cleanupTimeoutMs: 20 });
    assert.equal(calls.includes('focus') || calls.includes('reflow'), false, failure);
    assert.equal(calls.includes('removeNavigationGuards'), failure === 'installNavigationGuards');
    assert.doesNotMatch(JSON.stringify(raw), /DO_NOT_SERIALIZE/);
  }
});

test('removes guards once after partial installation rejects before resolving', async () => {
  let residue = false;
  let removed = 0;
  let focusCalls = 0;
  const raw = await runDynamicProbes({ timeoutMs: 20, cleanupTimeoutMs: 20, adapter: {
    snapshotState: async () => ({}),
    installNavigationGuards: async context => {
      assert.equal(typeof context?.token, 'object');
      assert.equal(typeof context?.signal?.aborted, 'boolean');
      residue = true;
      throw new Error('partial install');
    },
    removeNavigationGuards: async () => { removed += 1; residue = false; },
    getFocusableCount: async () => { focusCalls += 1; return 0; }
  } });
  assert.equal(removed, 1);
  assert.equal(residue, false);
  assert.equal(focusCalls, 0);
  assert.equal(raw.warnings.length > 0, true);
});

test('cancels and removes partial never-resolving guard installation on timeout and abort', async () => {
  for (const termination of ['timeout', 'abort']) {
    let residue = false;
    let removed = 0;
    let installContext;
    const controller = new AbortController();
    const promise = runDynamicProbes({
      signal: termination === 'abort' ? controller.signal : undefined,
      timeoutMs: termination === 'abort' ? 1_000 : 10,
      cleanupTimeoutMs: 20,
      adapter: {
        snapshotState: async () => ({}),
        installNavigationGuards: async context => {
          installContext = context;
          residue = true;
          return new Promise(() => {});
        },
        removeNavigationGuards: async context => {
          removed += 1;
          assert.equal(context, installContext);
          residue = false;
        },
        getFocusableCount: async () => { throw new Error('must not run'); }
      }
    });
    if (termination === 'abort') setTimeout(() => controller.abort(), 5);
    const raw = await promise;
    assert.equal(removed, 1, termination);
    assert.equal(residue, false, termination);
    assert.equal(installContext.token.cancelled, true, termination);
    assert.equal(installContext.signal.aborted, true, termination);
    assert.equal(raw.actions.some(item => item.type === 'key' || item.type === 'viewport'), false, termination);
  }
});

test('timeout and AbortSignal stop immediately and cleanup cannot hang', async () => {
  const never = () => new Promise(() => {});
  const cleanup = [];
  const baseline = {
    snapshotState: async () => ({ focus: 'start', scroll: {}, viewport: {}, styles: {} }),
    installNavigationGuards: async () => {}, getFocusableCount: never,
    removeNavigationGuards: async () => cleanup.push('listeners'), restoreStyles: async () => cleanup.push('styles'),
    restoreViewport: async () => cleanup.push('viewport'), restoreScroll: never, restoreFocus: async () => cleanup.push('focus')
  };
  const started = Date.now();
  const timed = await runDynamicProbes({ adapter: baseline, timeoutMs: 15, cleanupTimeoutMs: 15 });
  assert.equal(Date.now() - started < 250, true);
  assert.equal(timed.warnings.some(item => item.code === 'TIMEOUT'), true);
  assert.deepEqual(cleanup, ['listeners', 'styles', 'viewport', 'focus']);

  const controller = new AbortController();
  const abortCalls = [];
  const promise = runDynamicProbes({ signal: controller.signal, timeoutMs: 1000, cleanupTimeoutMs: 15, adapter: {
    snapshotState: async () => ({ focus: null, scroll: {}, viewport: {}, styles: {} }),
    installNavigationGuards: async () => {}, getFocusableCount: never,
    removeNavigationGuards: async () => abortCalls.push('listeners'), restoreStyles: async () => abortCalls.push('styles'),
    restoreViewport: async () => abortCalls.push('viewport'), restoreScroll: async () => abortCalls.push('scroll'), restoreFocus: async () => abortCalls.push('focus')
  } });
  setTimeout(() => controller.abort(), 5);
  const aborted = await promise;
  assert.equal(aborted.warnings.some(item => item.code === 'ABORTED'), true);
  assert.deepEqual(abortCalls, ['listeners', 'styles', 'viewport', 'scroll', 'focus']);
});

test('invalid dimensions and a non-reduce motion run remain cantTell', () => {
  for (const width of [-1, Number.NaN]) assert.equal(normalizeProbes({ reflow: { testedWidthCssPx: width, horizontalOverflow: false } }).reflow.outcome, 'cantTell');
  assert.equal(normalizeProbes({ motion: { complete: true, prefersReducedMotion: false, animatedCount: 0, reducedAnimatedCount: 0 } }).motion.outcome, 'cantTell');
  assert.equal(normalizeProbes({ motion: { complete: true, prefersReducedMotion: false, preference: 'reduce', animatedCount: 0, reducedAnimatedCount: 0 } }).motion.outcome, 'cantTell');
});

test('merge treats untrusted probe objects as raw input without reading accessors or revoked proxies', () => {
  const marker = 'PRIVATE_MERGE_PROBE_ACCESSOR';
  let getterReads = 0;
  const hostile = {};
  Object.defineProperty(hostile, 'focusOrder', {
    configurable: true,
    enumerable: true,
    get() {
      getterReads += 1;
      throw new Error(marker);
    },
  });
  const snapshot = {
    schemaVersion: 1,
    document: { nodeId: 'document', title: 'Fixture' },
    nodes: [],
  };

  let merged;
  let mergeError;
  try {
    merged = mergeProbesIntoSnapshot(snapshot, hostile);
  } catch (error) {
    mergeError = error;
  }

  assert.equal(getterReads, 0);
  assert.ifError(mergeError);
  assert.equal(merged.document.probeCoverage.focusOrder, 'cantTell');
  assert.equal(merged.document.probeCoverage.targetSizes, 'cantTell');
  assert.doesNotMatch(JSON.stringify(merged), new RegExp(marker));

  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  assert.doesNotThrow(() => {
    const unavailable = mergeProbesIntoSnapshot(snapshot, revoked.proxy);
    assert.equal(unavailable.document.probeCoverage.focusAppearance, 'cantTell');
    assert.equal(unavailable.document.probeCoverage.targetSizes, 'cantTell');
  });
});

test('merges probe observations into a fresh serializable SnapshotV1 consumed by core rules', async () => {
  const snapshot = {
    schemaVersion: 1,
    document: { nodeId: 'document', title: 'Fixture' },
    nodes: completeRaw().targetSizes.map(item => ({ nodeId: item.nodeId, parentId: null, children: [], tagName: 'button', attributes: {}, focusable: true }))
  };
  snapshot.nodes.push({ nodeId: 'n-101', parentId: null, children: [], tagName: 'a', attributes: { href: '#' }, focusable: true });
  snapshot.nodes.push({ nodeId: 'n-102', parentId: null, children: [], tagName: 'button', attributes: {}, focusable: true });
  const merged = mergeProbesIntoSnapshot(snapshot, normalizeProbes(completeRaw()));
  assert.notEqual(merged, snapshot);
  assert.deepEqual(merged.document.reflowObservation, { testedWidthCssPx: 320, twoDimensionalScroll: true, exception: 'none' });
  assert.equal(merged.document.textResizeObservation, null);
  assert.deepEqual(merged.nodes.find(node => node.nodeId === 'n-202').targetSize, { width: 24, height: 24, exception: 'none' });
  assert.deepEqual(merged.nodes.find(node => node.nodeId === 'n-102').focusObservation, {
    indicatorVisible: false, fullyVisible: false, partiallyVisible: true, areaSufficient: false
  });
  assert.doesNotThrow(() => JSON.stringify(merged));
  assert.equal(Object.hasOwn(snapshot.document, 'reflowObservation'), false);

  const audit = await runCoreAudit(merged);
  const result = ruleId => audit.ruleResults.find(item => item.ruleId === ruleId).outcome;
  assert.equal(result('responsive-reflow'), 'failed');
  assert.equal(result('text-resizing'), 'cantTell');
  assert.equal(result('target-size-minimum'), 'failed');
  assert.equal(result('focus-visible'), 'failed');
});

test('a width-only 200% text probe never claims conformity or failure', async () => {
  const snapshot = {
    schemaVersion: 1,
    document: { nodeId: 'document', title: 'Fixture' },
    nodes: [],
  };
  for (const lossOfContent of [false, true]) {
    const probes = normalizeProbes({ textResize: { scalePercent: 200, lossOfContent } });
    assert.equal(probes.textResize.outcome, 'cantTell');
    assert.equal(probes.probeCoverage.textResize, 'cantTell');
    const merged = mergeProbesIntoSnapshot(snapshot, probes);
    assert.equal(merged.document.textResizeObservation, null);
    const audit = await runCoreAudit(merged);
    const result = audit.ruleResults.find(item => item.ruleId === 'text-resizing');
    assert.equal(result.outcome, 'cantTell');
    assert.match(result.summary, /recorte vertical[^.]*sobreposição[^.]*perda funcional[^.]*revisão humana/iu);
  }
});

test('merge preserves unknown focus observations as cantTell instead of fabricating false', async () => {
  const snapshot = {
    schemaVersion: 1,
    document: { nodeId: 'document', title: 'Fixture' },
    nodes: [{ nodeId: 'n-301', parentId: null, children: [], tagName: 'button', attributes: {}, focusable: true }]
  };
  const probes = normalizeProbes({
    focus: { focusableCount: 1, completed: false, events: [{ nodeId: 'n-301', selector: '#a' }] },
    warnings: [{ code: 'TIMEOUT', message: 'sem observação visual' }], actions: []
  });
  const merged = mergeProbesIntoSnapshot(snapshot, probes);
  assert.equal(merged.nodes[0].focusObservation, undefined);
  const audit = await runCoreAudit(merged);
  for (const ruleId of ['focus-visible', 'focus-fully-visible', 'focus-partially-visible', 'focus-indicator-area']) {
    assert.equal(audit.ruleResults.find(item => item.ruleId === ruleId).outcome, 'cantTell');
  }
});

test('partial frame coverage propagates cantTell before pass or inapplicable', async () => {
  const snapshot = {
    schemaVersion: 1,
    document: { nodeId: 'document', coverage: { runtime: { outcome: 'partial' } } },
    nodes: []
  };
  const merged = mergeProbesIntoSnapshot(snapshot, normalizeProbes(completeRaw()));
  assert.equal(merged.document.probeCoverage.focusAppearance, 'cantTell');
  assert.equal(merged.document.reflowObservation, null);
  assert.equal(merged.nodes.some(node => node.focusObservation || node.targetSize), false);
  const audit = await runCoreAudit(merged);
  for (const ruleId of ['focus-visible', 'responsive-reflow', 'text-resizing', 'target-size-minimum', 'interaction-animation']) {
    assert.equal(audit.ruleResults.find(item => item.ruleId === ruleId).outcome, 'cantTell', ruleId);
  }
});
