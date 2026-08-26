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
    reflow: { testedWidthCssPx: 320, horizontalOverflow: true, exception: 'none' },
    textResize: { scalePercent: 200, lossOfContent: false },
    targetSizes: [
      { nodeId: 'n-201', width: 23.99, height: 24, exception: 'none' },
      { nodeId: 'n-202', width: 24, height: 24, exception: 'none' },
      { nodeId: 'n-203', width: 43.99, height: 44, exception: 'none' },
      { nodeId: 'n-204', width: 44, height: 44, exception: 'none' }
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
  assert.equal(probes.textResize.outcome, 'passed');
  assert.equal(probes.textResize.scalePercent, 200);
  assert.deepEqual(probes.targetSizes.minimum24.failedNodeIds, ['n-201']);
  assert.deepEqual(probes.targetSizes.enhanced44.failedNodeIds, ['n-201', 'n-202', 'n-203']);
  assert.equal(probes.targetSizes.observations.find(item => item.nodeId === 'n-202').minimum24, true);
  assert.equal(probes.targetSizes.observations.find(item => item.nodeId === 'n-204').enhanced44, true);
  assert.equal(probes.motion.outcome, 'failed');
  assert.equal(probes.motion.prefersReducedMotion, true);
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

test('only preserves authoritative SnapshotV1 node IDs and hashes every arbitrary nodeId or selector', () => {
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
  ]) assert.match(id, /^(?:n-42|probe-[0-9a-f]{8})$/u);
  assert.deepEqual(first, second);
  assert.doesNotMatch(JSON.stringify(first), new RegExp(marker));
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
  assert.deepEqual(merged.document.textResizeObservation, { scalePercent: 200, lossOfContent: false });
  assert.deepEqual(merged.nodes.find(node => node.nodeId === 'n-202').targetSize, { width: 24, height: 24, exception: 'none' });
  assert.deepEqual(merged.nodes.find(node => node.nodeId === 'n-102').focusObservation, {
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
