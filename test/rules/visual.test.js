import test from 'node:test';
import assert from 'node:assert/strict';

import { contrastRatio } from '../../src/core/color.js';
import { NBR17225_ITEMS } from '../../src/core/normative/nbr17225.js';
import { validateNormativeData } from '../../src/core/normative/validate-normative-data.js';
import { FORM_RULES } from '../../src/core/rules/forms.js';
import { INTERACTIVE_RULES } from '../../src/core/rules/interactive.js';
import { MANUAL_REVIEW_RULES } from '../../src/core/rules/manual-review.js';
import { MEDIA_RULES } from '../../src/core/rules/media.js';
import { aggregateItems } from '../../src/core/rules/aggregate-items.js';
import { runRules } from '../../src/core/rules/run-rules.js';
import { STRUCTURE_RULES } from '../../src/core/rules/structure.js';
import { VISUAL_RULES } from '../../src/core/rules/visual.js';

function record(nodeId, tagName, overrides = {}) {
  return {
    nodeId,
    tagName,
    attributes: {},
    text: '',
    children: [],
    parentId: null,
    hidden: false,
    selectorHint: `#${nodeId}`,
    role: '',
    ...overrides
  };
}

function snapshot(nodes = [], documentOverrides = {}) {
  const document = { nodeId: 'document', title: 'Página', language: 'pt-BR', ...documentOverrides };
  return {
    document,
    nodes,
    byId: Object.fromEntries([['document', document], ...nodes.map(node => [String(node.nodeId), node])])
  };
}

async function evaluate(ruleId, value) {
  const rule = VISUAL_RULES.find(candidate => candidate.id === ruleId);
  assert.ok(rule, `Regra ausente: ${ruleId}`);
  return (await runRules(value, {}, [rule]))[0];
}

function srgbGrayForBlackContrast(ratio) {
  const linear = (ratio - 1) / 20;
  const channel = linear <= 0.0031308
    ? linear * 12.92
    : 1.055 * (linear ** (1 / 2.4)) - 0.055;
  return { r: channel * 255, g: channel * 255, b: channel * 255, a: 1 };
}

test('WCAG sRGB contrast preserves effective 4.49/4.50 and 2.99/3.00 boundaries', () => {
  assert.ok(Math.abs(contrastRatio('#000', srgbGrayForBlackContrast(4.49)) - 4.49) < 1e-10);
  assert.ok(Math.abs(contrastRatio('#000', srgbGrayForBlackContrast(4.5)) - 4.5) < 1e-10);
  assert.ok(Math.abs(contrastRatio('#000', srgbGrayForBlackContrast(2.99)) - 2.99) < 1e-10);
  assert.ok(Math.abs(contrastRatio('#000', srgbGrayForBlackContrast(3)) - 3) < 1e-10);
});

test('contrast thresholds compare the real ratio without epsilon or display rounding', async () => {
  const value = await evaluate('text-contrast-minimum', snapshot([
    record('below', 'p', { text: 'Texto', contrast: {
      foreground: '#000', background: srgbGrayForBlackContrast(4.499999999999501),
      fontSizePx: 16, fontWeight: 400
    } })
  ]));
  assert.equal(value.outcome, 'failed');
  assert.equal(value.targets[0].nodeId, 'below');
  assert.ok(value.targets[0].data.ratio < 4.5);
});

test('contrast flattens foreground alpha only against an explicit opaque background', () => {
  assert.equal(contrastRatio('rgba(0, 0, 0, 0.5)', '#fff').toFixed(6), '3.976653');
  assert.ok(Number.isNaN(contrastRatio('rgba(0, 0, 0, 0)', '#fff')));
  assert.ok(Number.isNaN(contrastRatio('#0000', '#fff')));
  assert.ok(Number.isNaN(contrastRatio('#00000000', '#fff')));
  assert.ok(Number.isNaN(contrastRatio('rgba(0, 0, 0, 0.5)', 'transparent')));
  assert.ok(Number.isNaN(contrastRatio('not-a-color', '#fff')));
  assert.ok(Number.isNaN(contrastRatio({ r: Number.NaN, g: 0, b: 0, a: 1 }, '#fff')));
});

test('fully transparent foreground colors make contrast rules cantTell', async () => {
  for (const foreground of ['rgba(0, 0, 0, 0)', '#0000', '#00000000']) {
    assert.equal((await evaluate('text-contrast-minimum', snapshot([
      record('transparent', 'p', { text: 'Texto', contrast: {
        foreground, background: '#fff', fontSizePx: 16, fontWeight: 400
      } })
    ]))).outcome, 'cantTell');
  }
});

test('text contrast uses size and weight for large text and never rounds near thresholds', async () => {
  const failed = await evaluate('text-contrast-minimum', snapshot([
    record('normal-low', 'p', { text: 'Texto', contrast: {
      foreground: '#000', background: srgbGrayForBlackContrast(4.49), fontSizePx: 16, fontWeight: 400
    } }),
    record('normal-ok', 'p', { text: 'Texto', contrast: {
      foreground: '#000', background: srgbGrayForBlackContrast(4.50000000000001), fontSizePx: 16, fontWeight: 400
    } }),
    record('large-low', 'p', { text: 'Texto', contrast: {
      foreground: '#000', background: srgbGrayForBlackContrast(2.99), fontSizePx: 24, fontWeight: 400
    } }),
    record('large-ok', 'p', { text: 'Texto', contrast: {
      foreground: '#000', background: srgbGrayForBlackContrast(3.000000000000001), fontSizePx: 18.6667, fontWeight: 700
    } })
  ]));
  assert.equal(failed.outcome, 'failed');
  assert.deepEqual(failed.targets.map(target => target.nodeId), ['normal-low', 'large-low']);

  assert.equal((await evaluate('text-contrast-enhanced', snapshot([
    record('enhanced', 'p', { text: 'Texto', contrast: {
      foreground: '#000', background: srgbGrayForBlackContrast(4.50000000000001), fontSizePx: 24, fontWeight: 400
    } })
  ]))).outcome, 'passed');
});

test('unknown pixel composition, gradients, canvas and invalid colors are cantTell', async () => {
  for (const node of [
    record('gradient', 'p', { text: 'Texto', contrast: { foreground: '#000', background: '#fff', backgroundImage: 'linear-gradient(#fff,#eee)', fontSizePx: 16, fontWeight: 400 } }),
    record('canvas', 'canvas', { text: 'Texto', contrast: { foreground: '#000', background: '#fff', renderingContext: 'canvas', fontSizePx: 16, fontWeight: 400 } }),
    record('webgl', 'canvas', { text: 'Texto', contrast: { foreground: '#000', background: '#fff', renderingContext: 'webgl', fontSizePx: 16, fontWeight: 400 } }),
    record('invalid', 'p', { text: 'Texto', contrast: { foreground: 'invalid', background: '#fff', fontSizePx: 16, fontWeight: 400 } })
  ]) {
    const value = await evaluate('text-contrast-minimum', snapshot([node]));
    assert.equal(value.outcome, 'cantTell');
  }
});

test('component, graphic and focus contrast require reliable observed pixels at ratio 3', async () => {
  const cases = [
    ['component-contrast', 'componentContrast'],
    ['graphic-object-contrast', 'graphicContrast'],
    ['focus-indicator-contrast', 'focusContrast']
  ];
  for (const [ruleId, field] of cases) {
    assert.equal((await evaluate(ruleId, snapshot([
      record('bad', 'button', { role: 'button', [field]: { foreground: '#000', background: srgbGrayForBlackContrast(2.99), reliable: true } })
    ]))).outcome, 'failed');
    assert.equal((await evaluate(ruleId, snapshot([
      record('ok', 'button', { role: 'button', [field]: { foreground: '#000', background: srgbGrayForBlackContrast(3), reliable: true } })
    ]))).outcome, 'passed');
    assert.equal((await evaluate(ruleId, snapshot([
      record('unknown', 'canvas', { role: 'button', [field]: { renderingContext: 'canvas', reliable: false } })
    ]))).outcome, 'cantTell');
  }
});

test('target sizes preserve 23.99/24 and 43.99/44 boundaries with explicit exceptions', async () => {
  const minimum = await evaluate('target-size-minimum', snapshot([
    record('small', 'button', { role: 'button', targetSize: { width: 23.99, height: 24, exception: 'none' } }),
    record('edge', 'button', { role: 'button', targetSize: { width: 24, height: 24, exception: 'none' } }),
    record('inline', 'a', { attributes: { href: '#' }, role: 'link', targetSize: { width: 10, height: 10, exception: 'inline' } })
  ]));
  assert.equal(minimum.outcome, 'failed');
  assert.deepEqual(minimum.targets.map(target => target.nodeId), ['small']);

  const enhanced = await evaluate('target-size-enhanced', snapshot([
    record('small', 'button', { role: 'button', targetSize: { width: 43.99, height: 44, exception: 'none' } }),
    record('edge', 'button', { role: 'button', targetSize: { width: 44, height: 44, exception: 'none' } })
  ]));
  assert.equal(enhanced.outcome, 'failed');
  assert.deepEqual(enhanced.targets.map(target => target.nodeId), ['small']);

  assert.equal((await evaluate('target-size-minimum', snapshot([
    record('unknown', 'button', { role: 'button', targetSize: { width: 20, height: 20 } })
  ]))).outcome, 'cantTell');
  assert.equal((await evaluate('target-size-minimum', snapshot([
    record('spaced', 'button', { role: 'button', targetSize: { width: 10, height: 10, exception: 'spacing' } })
  ]))).outcome, 'passed');
  assert.equal((await evaluate('target-size-enhanced', snapshot([
    record('not-exempt', 'button', { role: 'button', targetSize: { width: 10, height: 10, exception: 'spacing' } })
  ]))).outcome, 'failed');
  assert.equal((await evaluate('target-size-enhanced', snapshot([
    record('unknown', 'button', { role: 'button', targetSize: { width: 10, height: 10, exception: 'other' } })
  ]))).outcome, 'cantTell');
});

test('zoom reports restrictive viewport directives and distinguishes missing collection', async () => {
  assert.equal((await evaluate('zoom-not-blocked', snapshot([], {
    metaViewport: { userScalable: false, maximumScale: 1 }
  }))).outcome, 'failed');
  assert.equal((await evaluate('zoom-not-blocked', snapshot([], { metaViewport: null }))).outcome, 'passed');
  assert.equal((await evaluate('zoom-not-blocked', snapshot())).outcome, 'cantTell');
  for (const metaViewport of [
    { userScalable: 'no', maximumScale: '1' },
    { userScalable: false, maximumScale: Number.NaN },
    { userScalable: true, maximumScale: -1 },
    {}
  ]) {
    assert.equal((await evaluate('zoom-not-blocked', snapshot([], { metaViewport }))).outcome, 'cantTell');
  }
});

test('focus visibility and obstruction only conclude from explicit observations', async () => {
  const focusable = overrides => record('control', 'button', { role: 'button', focusable: true, ...overrides });
  assert.equal((await evaluate('focus-visible', snapshot([focusable({ focusObservation: { indicatorVisible: false } })]))).outcome, 'failed');
  assert.equal((await evaluate('focus-visible', snapshot([focusable({ focusObservation: { indicatorVisible: true } })]))).outcome, 'passed');
  assert.equal((await evaluate('focus-visible', snapshot([focusable({})]))).outcome, 'cantTell');
  assert.equal((await evaluate('focus-fully-visible', snapshot([focusable({ focusObservation: { fullyVisible: false } })]))).outcome, 'failed');
  assert.equal((await evaluate('focus-partially-visible', snapshot([focusable({ focusObservation: { partiallyVisible: false } })]))).outcome, 'failed');
  assert.equal((await evaluate('focus-indicator-area', snapshot([focusable({ focusObservation: { areaSufficient: false } })]))).outcome, 'failed');
});

test('orientation, reflow, resizing and text spacing require completed observations', async () => {
  assert.equal((await evaluate('display-orientation', snapshot([], {
    orientationObservation: { restricted: true, exception: 'none' }
  }))).outcome, 'failed');
  assert.equal((await evaluate('display-orientation', snapshot([], {
    orientationObservation: { restricted: true }
  }))).outcome, 'cantTell');
  assert.equal((await evaluate('responsive-reflow', snapshot([], {
    reflowObservation: { testedWidthCssPx: 320, twoDimensionalScroll: true, exception: 'none' }
  }))).outcome, 'failed');
  assert.equal((await evaluate('responsive-reflow', snapshot([], {
    reflowObservation: { twoDimensionalScroll: false }
  }))).outcome, 'cantTell');
  for (const testedWidthCssPx of [-1, 0, Number.NaN]) {
    assert.equal((await evaluate('responsive-reflow', snapshot([], {
      reflowObservation: { testedWidthCssPx, twoDimensionalScroll: false }
    }))).outcome, 'cantTell');
  }
  assert.equal((await evaluate('text-resizing', snapshot([], {
    textResizeObservation: { scalePercent: 200, lossOfContent: false }
  }))).outcome, 'cantTell');
  assert.equal((await evaluate('text-resizing', snapshot([], {
    textResizeObservation: { scalePercent: 200, lossOfContent: true }
  }))).outcome, 'cantTell');

  for (const ruleId of ['line-spacing', 'paragraph-spacing', 'letter-spacing', 'word-spacing']) {
    assert.equal((await evaluate(ruleId, snapshot([], {
      textSpacingObservation: { applied: true, lossOfContent: true, affectedNodeIds: [] }
    }))).outcome, 'failed');
    assert.equal((await evaluate(ruleId, snapshot())).outcome, 'cantTell');
  }
});

test('font weight accepts normalized CSS numbers and keywords without guessing relative weights', async () => {
  const largeFixture = fontWeight => snapshot([
    record('text', 'p', { text: 'Texto', contrast: {
      foreground: '#000', background: srgbGrayForBlackContrast(3.000000000000001), fontSizePx: 18.6667, fontWeight
    } })
  ]);
  for (const fontWeight of [700, '700', 'bold']) {
    assert.equal((await evaluate('text-contrast-minimum', largeFixture(fontWeight))).outcome, 'passed');
  }
  assert.equal((await evaluate('text-contrast-minimum', snapshot([
    record('text', 'p', { text: 'Texto', contrast: {
      foreground: '#000', background: srgbGrayForBlackContrast(4.50000000000001), fontSizePx: 16, fontWeight: 'normal'
    } })
  ]))).outcome, 'passed');
  for (const fontWeight of ['bolder', 'lighter', '-1', 'heavy', Number.NaN]) {
    assert.equal((await evaluate('text-contrast-minimum', largeFixture(fontWeight))).outcome, 'cantTell');
  }
  assert.equal((await evaluate('text-contrast-minimum', snapshot([
    record('text', 'p', { text: 'Texto', contrast: {
      foreground: '#000', background: '#fff', fontSizePx: -1, fontWeight: 400
    } })
  ]))).outcome, 'cantTell');
});

test('invalid text-block measurements remain cantTell instead of false failures', async () => {
  assert.equal((await evaluate('text-block-width', snapshot([
    record('text', 'p', { text: 'Texto', textBlock: true, charactersPerLine: Number.NaN })
  ]))).outcome, 'cantTell');
});

test('complete normative composition registers every catalog rule exactly once with exact metadata', () => {
  const rules = [...STRUCTURE_RULES, ...INTERACTIVE_RULES, ...FORM_RULES, ...VISUAL_RULES, ...MEDIA_RULES, ...MANUAL_REVIEW_RULES];
  const expectedIds = NBR17225_ITEMS.flatMap(item => item.ruleIds);
  assert.equal(new Set(expectedIds).size, 130);
  assert.equal(rules.length, 130);
  assert.equal(new Set(rules.map(rule => rule.id)).size, 130);
  assert.deepEqual(new Set(rules.map(rule => rule.id)), new Set(expectedIds));
  for (const rule of rules) {
    const items = NBR17225_ITEMS.filter(item => item.ruleIds.includes(rule.id));
    assert.deepEqual([...rule.nbrItems], items.map(item => item.id), rule.id);
    assert.deepEqual([...rule.wcag], [...new Set(items.flatMap(item => item.wcag.map(ref => ref.id)))], rule.id);
    assert.equal(rule.mode, items[0].evaluation, rule.id);
  }
  assert.deepEqual(validateNormativeData(), []);
});

test('complete normative composition executes safely and aggregates all 146 items', async () => {
  const rules = [...STRUCTURE_RULES, ...INTERACTIVE_RULES, ...FORM_RULES, ...VISUAL_RULES, ...MEDIA_RULES, ...MANUAL_REVIEW_RULES];
  const results = await runRules(snapshot(), {}, rules);
  assert.equal(results.length, 130);
  assert.ok(results.every(value => value.outcome !== 'untested'));
  const items = aggregateItems(results, NBR17225_ITEMS);
  assert.equal(items.length, 146);
  assert.deepEqual(items.map(item => item.id), NBR17225_ITEMS.map(item => item.id));
});
