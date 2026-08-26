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
        { nodeId: 'a', selector: '#a', beforeCss: { outlineWidth: '0px' }, afterCss: { outlineWidth: '2px' }, rect: { x: 0, y: 0, width: 24, height: 24 }, intersectionRatio: 1, areaSufficient: true },
        { nodeId: 'b', selector: '#b', beforeCss: { outlineWidth: '0px' }, afterCss: { outlineWidth: '0px' }, rect: { x: 10, y: 10, width: 44, height: 44 }, intersectionRatio: 0.5, areaSufficient: false },
        { nodeId: 'b', selector: '#b', beforeCss: { outlineWidth: '0px' }, afterCss: { outlineWidth: '0px' }, rect: { x: 10, y: 10, width: 44, height: 44 }, intersectionRatio: 0.5, areaSufficient: false }
      ]
    },
    reflow: { testedWidthCssPx: 320, horizontalOverflow: true, exception: 'none' },
    textResize: { scalePercent: 200, lossOfContent: false },
    targetSizes: [
      { nodeId: 'tiny', width: 23.99, height: 24, exception: 'none' },
      { nodeId: 'minimum-edge', width: 24, height: 24, exception: 'none' },
      { nodeId: 'enhanced-small', width: 43.99, height: 44, exception: 'none' },
      { nodeId: 'enhanced-edge', width: 44, height: 44, exception: 'none' }
    ],
    motion: { prefersReducedMotion: true, animatedCount: 2, reducedAnimatedCount: 1, complete: true },
    warnings: [],
    actions: [{ type: 'key', key: 'Tab' }]
  };
}

test('normalizes focus order, repeated-focus traps, CSS change and viewport intersection', () => {
  const probes = normalizeProbes(completeRaw());
  assert.deepEqual(probes.focusOrder.targets, ['a', 'b', 'b']);
  assert.equal(probes.focusOrder.outcome, 'passed');
  assert.equal(probes.keyboardTraps.outcome, 'failed');
  assert.deepEqual(probes.keyboardTraps.targets, ['b']);
  assert.equal(probes.focusAppearance.outcome, 'failed');
  assert.deepEqual(probes.focusAppearance.targets, ['b']);
  assert.equal(probes.obscuredTargets.outcome, 'failed');
  assert.deepEqual(probes.obscuredTargets.targets, ['b']);
});

test('normalizes exact 320 px, 200%, 24/44 boundaries and reduced motion', () => {
  const probes = normalizeProbes(completeRaw());
  assert.equal(probes.reflow.outcome, 'failed');
  assert.equal(probes.reflow.testedWidthCssPx, 320);
  assert.equal(probes.textResize.outcome, 'passed');
  assert.equal(probes.textResize.scalePercent, 200);
  assert.deepEqual(probes.targetSizes.minimum24.failedNodeIds, ['tiny']);
  assert.deepEqual(probes.targetSizes.enhanced44.failedNodeIds, ['tiny', 'minimum-edge', 'enhanced-small']);
  assert.equal(probes.targetSizes.observations.find(item => item.nodeId === 'minimum-edge').minimum24, true);
  assert.equal(probes.targetSizes.observations.find(item => item.nodeId === 'enhanced-edge').enhanced44, true);
  assert.equal(probes.motion.outcome, 'failed');
  assert.equal(probes.motion.prefersReducedMotion, true);
});

test('missing, timed-out or incomplete observations remain cantTell', () => {
  const probes = normalizeProbes({ warnings: [{ code: 'TIMEOUT', message: 'limite token=PROBE_WARNING_FAKE' }], actions: [{ type: 'probe', detail: 'authorization=ACTION_FAKE' }] });
  for (const key of ['focusOrder', 'keyboardTraps', 'focusAppearance', 'obscuredTargets', 'reflow', 'textResize', 'motion']) {
    assert.equal(probes[key].outcome, 'cantTell');
  }
  assert.equal(probes.targetSizes.minimum24.outcome, 'cantTell');
  assert.equal(probes.targetSizes.enhanced44.outcome, 'cantTell');
  assert.deepEqual(probes.warnings, [{ code: 'TIMEOUT', message: 'limite token=[redacted]' }]);
  assert.doesNotMatch(JSON.stringify(probes), /PROBE_WARNING_FAKE|ACTION_FAKE/);
});

test('small targets without an observed exception remain cantTell', () => {
  const probes = normalizeProbes({ targetSizes: [{ nodeId: 'unknown', width: 20, height: 20 }], warnings: [], actions: [] });
  assert.equal(probes.targetSizes.minimum24.outcome, 'cantTell');
  assert.equal(probes.targetSizes.enhanced44.outcome, 'cantTell');
  assert.equal(probes.targetSizes.observations[0].exception, 'unknown');
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

test('runDynamicProbes restores every mutable state after each probe-stage rejection and cancellation', async () => {
  const stages = ['installNavigationGuards', 'getFocusableCount', 'pressTab', 'measureReflow', 'measureTextResize', 'measureTargetSizes', 'measureMotion'];
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
    assert.match(raw.warnings.map(item => item.message).join(' '), /rejected/);
  }

  const controller = new AbortController();
  controller.abort('cancelled');
  const restored = [];
  await runDynamicProbes({ signal: controller.signal, adapter: {
    snapshotState: async () => ({ focus: null, scroll: {}, viewport: {}, styles: {} }),
    removeNavigationGuards: async () => restored.push('listeners'), restoreStyles: async () => restored.push('styles'),
    restoreViewport: async () => restored.push('viewport'), restoreScroll: async () => restored.push('scroll'), restoreFocus: async () => restored.push('focus')
  } });
  assert.deepEqual(restored, ['listeners', 'styles', 'viewport', 'scroll', 'focus']);
});

test('merges probe observations into a fresh serializable SnapshotV1 consumed by core rules', async () => {
  const snapshot = {
    schemaVersion: 1,
    document: { nodeId: 'document', title: 'Fixture' },
    nodes: completeRaw().targetSizes.map(item => ({ nodeId: item.nodeId, parentId: null, children: [], tagName: 'button', attributes: {}, focusable: true }))
  };
  snapshot.nodes.push({ nodeId: 'a', parentId: null, children: [], tagName: 'a', attributes: { href: '#' }, focusable: true });
  snapshot.nodes.push({ nodeId: 'b', parentId: null, children: [], tagName: 'button', attributes: {}, focusable: true });
  const merged = mergeProbesIntoSnapshot(snapshot, normalizeProbes(completeRaw()));
  assert.notEqual(merged, snapshot);
  assert.deepEqual(merged.document.reflowObservation, { testedWidthCssPx: 320, twoDimensionalScroll: true, exception: 'none' });
  assert.deepEqual(merged.document.textResizeObservation, { scalePercent: 200, lossOfContent: false });
  assert.deepEqual(merged.nodes.find(node => node.nodeId === 'minimum-edge').targetSize, { width: 24, height: 24, exception: 'none' });
  assert.deepEqual(merged.nodes.find(node => node.nodeId === 'b').focusObservation, {
    indicatorVisible: false, fullyVisible: false, partiallyVisible: true, areaSufficient: false
  });
  assert.doesNotThrow(() => JSON.stringify(merged));
  assert.equal(Object.hasOwn(snapshot.document, 'reflowObservation'), false);

  const audit = await runCoreAudit(merged);
  const result = ruleId => audit.ruleResults.find(item => item.ruleId === ruleId).outcome;
  assert.equal(result('responsive-reflow'), 'failed');
  assert.equal(result('text-resizing'), 'passed');
  assert.equal(result('target-size-minimum'), 'failed');
  assert.equal(result('focus-visible'), 'failed');
});

test('merge preserves unknown focus observations as cantTell instead of fabricating false', async () => {
  const snapshot = {
    schemaVersion: 1,
    document: { nodeId: 'document', title: 'Fixture' },
    nodes: [{ nodeId: 'a', parentId: null, children: [], tagName: 'button', attributes: {}, focusable: true }]
  };
  const probes = normalizeProbes({
    focus: { focusableCount: 1, completed: false, events: [{ nodeId: 'a', selector: '#a' }] },
    warnings: [{ code: 'TIMEOUT', message: 'sem observação visual' }], actions: []
  });
  const merged = mergeProbesIntoSnapshot(snapshot, probes);
  assert.deepEqual(merged.nodes[0].focusObservation, {});
  const audit = await runCoreAudit(merged);
  for (const ruleId of ['focus-visible', 'focus-fully-visible', 'focus-partially-visible', 'focus-indicator-area']) {
    assert.equal(audit.ruleResults.find(item => item.ruleId === ruleId).outcome, 'cantTell');
  }
});
