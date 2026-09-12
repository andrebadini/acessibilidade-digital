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
import { validateCoreRuleTargetInventory } from '../../src/core/report/remediation-policy.js';

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

test('text width uses the ABNT language limit and leaves the configuration alternative open', async () => {
  for (const [language, count, outcome, targetCount] of [
    ['pt-BR', 80, 'passed', 0], ['pt-BR', 81, 'cantTell', 1],
    ['ja', 40, 'passed', 0], ['ja', 41, 'cantTell', 1],
    ['zh-Hant', 60, 'cantTell', 1], ['ko', 60, 'cantTell', 1],
    ['', 40, 'passed', 0], ['', 60, 'cantTell', 0],
    ['qaa', 60, 'cantTell', 0], ['', 81, 'cantTell', 1],
    ['pt-BR', NaN, 'cantTell', 0], ['pt-BR', Infinity, 'cantTell', 0],
    ['pt-BR', -1, 'cantTell', 0], ['pt-BR', 0, 'cantTell', 0],
    ['pt-BR', 12.5, 'cantTell', 0],
  ]) {
    const value = await evaluate('text-block-width', snapshot([
      record('copy', 'p', { text: 'Texto observado', textBlock: true, charactersPerLine: count }),
    ], { language }));
    assert.equal(value.outcome, outcome, `${language}/${count}`);
    assert.equal(value.targets.length, targetCount, `${language}/${count}`);
    if (targetCount) {
      const targets = value.targets.map(({ nodeId, message, data }) => ({ nodeId, message, data }));
      assert.equal(validateCoreRuleTargetInventory('text-block-width', 'cantTell', targets), true);
      assert.equal(validateCoreRuleTargetInventory('text-block-width', 'failed', targets), false);
    }
  }
});

test('text width honors inherited local language and missing measurements without inventing targets', async () => {
  const parent = record('section', 'section', { attributes: { lang: 'ja' }, children: ['copy'] });
  const child = record('copy', 'p', { parentId: 'section', text: '本文', textBlock: true, charactersPerLine: 60 });
  assert.equal((await evaluate('text-block-width', snapshot([parent, child]))).targets.length, 1);
  child.attributes.lang = '';
  assert.equal((await evaluate('text-block-width', snapshot([parent, child]))).targets.length, 0);
  assert.equal((await evaluate('text-block-width', snapshot([parent, child]))).outcome, 'cantTell');
  child.attributes.lang = 'pt-BR';
  const unsupported = record('complex', 'p', { text: 'Sem medição', textBlock: true });
  const value = await evaluate('text-block-width', snapshot([parent, child, unsupported]));
  assert.equal(value.outcome, 'cantTell');
  assert.deepEqual(value.targets, []);
});

test('text width includes rendered aria-hidden text and skips only proven aggregate duplicates', async () => {
  const parent = record('container', 'div', { text: 'One Two', textBlock: true, textContrastScope: 'aggregate', children: ['one', 'two'] });
  const one = record('one', 'p', { text: 'One', parentId: 'container', textBlock: true, charactersPerLine: 3 });
  const two = record('two', 'p', { text: 'Two', parentId: 'container', textBlock: true, charactersPerLine: 3, hidden: true, hasRenderedBox: true });
  assert.equal((await evaluate('text-block-width', snapshot([parent, one, two]))).outcome, 'passed');
  two.charactersPerLine = 81;
  assert.deepEqual((await evaluate('text-block-width', snapshot([parent, one, two]))).targets.map(target => target.nodeId), ['two']);
  two.charactersPerLine = 3;
  parent.text = 'Own text One Two';
  assert.equal((await evaluate('text-block-width', snapshot([parent, one, two]))).outcome, 'cantTell');
});

test('ABNT alignment distinguishes language direction and does not confirm an essentiality exception automatically', async () => {
  for (const [language, textAlign, direction, outcome, count] of [
    ['pt-BR', 'left', 'ltr', 'passed', 0],
    ['pt-BR', 'center', 'ltr', 'cantTell', 1],
    ['pt-BR', 'right', 'ltr', 'cantTell', 1],
    ['pt-BR', 'justify', 'ltr', 'cantTell', 1],
    ['ar', 'right', 'rtl', 'passed', 0],
    ['ar', 'left', 'rtl', 'cantTell', 1],
    ['ar', 'start', 'rtl', 'passed', 0],
    ['pt-BR', 'start', 'rtl', 'cantTell', 1],
    ['pt-BR', 'unexpected', 'ltr', 'cantTell', 0],
    ['', 'left', 'ltr', 'cantTell', 0],
    ['qaa', 'left', 'ltr', 'cantTell', 0],
  ]) {
    const value = await evaluate('text-block-alignment', snapshot([
      record('copy', 'p', { text: 'Conteúdo', textBlock: true, textAlign, styles: { direction } })
    ], { language }));
    assert.equal(value.outcome, outcome, `${language}/${textAlign}/${direction}`);
    assert.equal(value.targets.length, count);
    if (count) {
      const targets = value.targets.map(({ nodeId, message, data }) => ({ nodeId, message, data }));
      assert.equal(validateCoreRuleTargetInventory('text-block-alignment', 'cantTell', targets), true);
      assert.equal(validateCoreRuleTargetInventory('text-block-alignment', 'failed', targets), false);
    }
  }
});

test('alignment respects local language and unknown observations without hiding concrete suspicions', async () => {
  const parent = record('parent', 'section', { attributes: { lang: 'ar' } });
  const child = record('child', 'p', { parentId: 'parent', text: 'نص', textBlock: true, textAlign: 'right' });
  assert.equal((await evaluate('text-block-alignment', snapshot([parent, child]))).outcome, 'passed');
  child.attributes.lang = '';
  assert.equal((await evaluate('text-block-alignment', snapshot([parent, child]))).outcome, 'cantTell');
  const value = await evaluate('text-block-alignment', snapshot([
    record('unknown', 'p', { textBlock: true, text: 'Texto' }),
    record('center', 'p', { textBlock: true, text: 'Texto', textAlign: 'center' }),
    record('hidden', 'p', { textBlock: true, textAlign: 'center', hidden: true })
  ]));
  assert.equal(value.outcome, 'cantTell');
  assert.deepEqual(value.targets.map(t => t.nodeId), ['center']);
});

test('alignment does not duplicate a paragraph through a text-aggregating container', async () => {
  const value = await evaluate('text-block-alignment', snapshot([
    record('container', 'div', { text: 'Mesmo texto', textBlock: true, textAlign: 'center', textContrastScope: 'aggregate', children: ['paragraph'] }),
    record('paragraph', 'p', { parentId: 'container', text: 'Mesmo texto', textBlock: true, textAlign: 'center', textContrastScope: 'direct' })
  ]));
  assert.deepEqual(value.targets.map(t => t.nodeId), ['paragraph']);
});

test('alignment does not count a container whose text is entirely inside multiple child blocks', async () => {
  const value = await evaluate('text-block-alignment', snapshot([
    record('container', 'div', { text: 'Primeiro Segundo', textBlock: true, textAlign: 'center', textContrastScope: 'aggregate', children: ['first', 'second'] }),
    record('first', 'p', { parentId: 'container', text: 'Primeiro', textBlock: true, textAlign: 'center', textContrastScope: 'direct' }),
    record('second', 'p', { parentId: 'container', text: 'Segundo', textBlock: true, textAlign: 'center', textContrastScope: 'direct' })
  ]));
  assert.deepEqual(value.targets.map(t => t.nodeId), ['first', 'second']);
});

test('alignment does not invent a concrete occurrence for a block whose text was redacted', async () => {
  const result = await evaluate('text-block-alignment', snapshot([
    record('private', 'p', { text: '', visibleText: '', textBlock: true, textAlign: 'center', hasRenderedBox: true })
  ]));
  assert.equal(result.outcome, 'cantTell');
  assert.deepEqual(result.targets, []);
});

test('graphic contrast recognizes ordinary rendered media without declaring every image a violation', async () => {
  for (const node of [
    record('image', 'img', { attributes: { alt: 'Evolução das vendas' } }),
    record('chart', 'svg'),
    record('canvas', 'canvas'),
    record('semantic', 'div', { axRole: 'graphics-document' }),
    record('background', 'div', { backgroundImageKind: 'url' }),
  ]) {
    const value = await evaluate('graphic-object-contrast', snapshot([node]));
    assert.equal(value.outcome, 'cantTell', node.nodeId);
    assert.deepEqual(value.targets, [], 'unmeasured media is not a concrete low-contrast occurrence');
  }
});

test('one measured graphic cannot approve another image whose relevant parts were not measured', async () => {
  const value = await evaluate('graphic-object-contrast', snapshot([
    record('known', 'svg', { graphicContrast: { foreground: '#000', background: '#fff', reliable: true } }),
    record('unknown', 'img', { attributes: { alt: 'Mapa' } })
  ]));
  assert.equal(value.outcome, 'cantTell');
  assert.deepEqual(value.targets, []);
});

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

test('6.386 contrast meets minimum but fails enhanced without approving unobserved text', async () => {
  const measured = record('measured', 'p', { text: 'Texto', contrast: {
    foreground: '#000', background: srgbGrayForBlackContrast(6.386), fontSizePx: 16, fontWeight: 400
  } });
  assert.equal((await evaluate('text-contrast-minimum', snapshot([measured]))).outcome, 'passed');
  const enhanced = await evaluate('text-contrast-enhanced', snapshot([measured]));
  assert.equal(enhanced.outcome, 'failed');
  assert.equal(enhanced.targets[0].data.threshold, 7);
  assert.ok(Math.abs(enhanced.targets[0].data.ratio - 6.386) < 1e-10);
  const partial = snapshot([measured, record('unobserved', 'p', { text: 'Outro texto' })]);
  assert.equal((await evaluate('text-contrast-minimum', partial)).outcome, 'cantTell');
  assert.equal((await evaluate('text-contrast-enhanced', partial)).outcome, 'failed');
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

test('component contrast exempts native inactive controls without exempting active controls or graphics', async () => {
  const low = { foreground: '#fff', background: '#fff', reliable: true };
  for (const disabled of ['', 'false']) {
    const inactive = record('inactive', 'button', { attributes: { disabled }, componentContrast: low });
    assert.equal((await evaluate('component-contrast', snapshot([inactive]))).outcome, 'inapplicable');
  }
  const inherited = record('inherited', 'input', { disabled: true, form: { disabled: false }, componentContrast: low });
  assert.equal((await evaluate('component-contrast', snapshot([inherited]))).outcome, 'inapplicable');
  const active = record('active', 'button', { componentContrast: low });
  assert.equal((await evaluate('component-contrast', snapshot([
    record('false-flag', 'button', { attributes: { disabled: false }, componentContrast: low })
  ]))).outcome, 'failed');
  const mixed = await evaluate('component-contrast', snapshot([inherited, active]));
  assert.equal(mixed.outcome, 'failed');
  assert.deepEqual(mixed.targets.map(target=>target.nodeId), ['active']);
  const graphic = record('graphic', 'button', { attributes: { disabled: '' }, graphicContrast: low });
  assert.equal((await evaluate('graphic-object-contrast', snapshot([graphic]))).outcome, 'failed');
});

test('the report accepts an observed ARIA inactivity review without accepting it as a failure', async () => {
  const review = await evaluate('component-contrast', snapshot([
    record('n-1', 'button', { attributes: { 'aria-disabled': 'true' } }),
  ]));
  assert.equal(review.outcome, 'cantTell');
  const targets = review.targets.map(({ selectorHint, ...target }) => target);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].data.reason, 'inactive-component-unconfirmed');
  assert.equal(validateCoreRuleTargetInventory('component-contrast', 'cantTell', targets), true,
    'the report must accept the actual review emitted by the rule');
  assert.equal(validateCoreRuleTargetInventory('component-contrast', 'failed', targets), false);
  assert.equal(validateCoreRuleTargetInventory('graphic-object-contrast', 'cantTell', targets), false);
  assert.equal(validateCoreRuleTargetInventory('component-contrast', 'cantTell', [{
    ...targets[0], message: 'Infração comprovada sem revisão.'
  }]), false);
  assert.equal(validateCoreRuleTargetInventory('component-contrast', 'cantTell', [{
    ...targets[0], data: { ...targets[0].data, ratio: 1 }
  }]), false);
});

test('declared ARIA inactivity is not assumed to prevent operation', async () => {
  const low = { foreground: '#fff', background: '#fff', reliable: true };
  const declared = record('custom', 'div', { role: 'button', attributes: { 'aria-disabled': 'true' }, componentContrast: low });
  const review = await evaluate('component-contrast', snapshot([declared]));
  assert.equal(review.outcome, 'cantTell');
  assert.equal(review.targets.length, 1);
  assert.equal((await evaluate('component-contrast', snapshot([
    record('fake', 'div', { role: 'button', attributes: { disabled: '' }, componentContrast: low })
  ]))).outcome, 'failed');
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
  }))).outcome, 'cantTell');
  const restricted = await evaluate('zoom-not-blocked', snapshot([], { metaViewport: { userScalable: false } }));
  assert.equal(restricted.targets.length, 1, 'a concrete restrictive declaration must remain actionable');
  assert.equal((await evaluate('zoom-not-blocked', snapshot([], { metaViewport: null }))).outcome, 'cantTell');
  assert.equal((await evaluate('zoom-not-blocked', snapshot([], { metaViewport: { userScalable: true, maximumScale: 5 } }))).outcome, 'cantTell');
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
    }))).outcome, 'cantTell');
    assert.equal((await evaluate(ruleId, snapshot())).outcome, 'cantTell');
    assert.equal((await evaluate(ruleId, snapshot([], {
      textSpacingObservation: { applied: true, lossOfContent: false }
    }))).outcome, 'cantTell');
  }
});

test('reflow without horizontal scrolling cannot approve missing or lost content', async () => {
  for (const lossOfContent of [undefined, false, true]) {
    const result = await evaluate('responsive-reflow', snapshot([], {
      probeCoverage: { reflow: 'complete' },
      reflowObservation: { testedWidthCssPx: 320, twoDimensionalScroll: false,
        ...(lossOfContent === undefined ? {} : { lossOfContent }) }
    }));
    assert.equal(result.outcome, 'cantTell');
    assert.deepEqual(result.targets, []);
  }
});

test('reflow pass limitation does not change observed orientation outcomes', async () => {
  for (const orientationObservation of [{ restricted: false }, { restricted: true, exception: 'essential' }]) {
    assert.equal((await evaluate('display-orientation', snapshot([], { orientationObservation }))).outcome, 'passed');
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
