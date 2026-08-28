import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

function eventTarget(properties = {}) {
  const listeners = new Map();
  return Object.assign(properties, {
    addEventListener(type, listener) {
      const registered = listeners.get(type) || [];
      registered.push(listener);
      listeners.set(type, registered);
    },
    dispatch(type) {
      for (const listener of listeners.get(type) || []) listener({ type, target: this });
    },
  });
}

function classList() {
  const values = new Set();
  return {
    add: value => values.add(value),
    remove: value => values.delete(value),
    contains: value => values.has(value),
  };
}

async function reportRuntimeHarness() {
  const { REPORT_SCRIPT } = await import('../../src/core/report/report.js.js');
  const document = { activeElement: null };
  const control = (id, kind = 'select') => eventTarget({
    id, kind, value: '', defaultValue: '', disabled: true,
    focus() { document.activeElement = this; },
  });
  const controls = {
    impact: control('filter-impact'), wcag: control('filter-wcag'), outcome: control('filter-outcome'),
    classification: control('filter-classification'), page: control('filter-page'),
    engine: control('filter-engine'), abnt: control('filter-abnt'),
    formClear: control('form-clear', 'button'), emptyClear: control('empty-clear', 'button'),
    expand: control('expand-details', 'button'), collapse: control('collapse-details', 'button'),
  };
  const form = eventTarget({
    elements: [controls.impact, controls.wcag, controls.outcome, controls.classification, controls.page,
      controls.engine, controls.abnt, controls.formClear, controls.expand, controls.collapse],
    reset() {
      for (const entry of this.elements) entry.value = entry.defaultValue;
    },
  });
  const cards = [
    { hidden: false, dataset: { impact: 'serious', wcagLevels: 'A AA', outcome: 'failed', classification: 'requirement', page: 'page-1', engine: 'audita-core', abntItem: '5.1.1' } },
    { hidden: false, dataset: { impact: 'minor', wcagLevels: 'AAA', outcome: 'cantTell', classification: 'editorial', page: 'page-2', engine: 'axe-core', abntItem: '__none__' } },
  ];
  const details = [{ open: true }, { open: true }];
  const status = { textContent: '' };
  const empty = { hidden: true };
  const root = { classList: classList() };
  const elements = new Map([
    ['report-filters', form], ['filter-status', status], ['filter-empty', empty],
    ['expand-details', controls.expand], ['collapse-details', controls.collapse],
    ...Object.values(controls).filter(entry => entry.id.startsWith('filter-')).map(entry => [entry.id, entry]),
  ]);
  document.documentElement = root;
  document.getElementById = id => elements.get(id) || null;
  document.querySelectorAll = selector => ({
    '[data-occurrence-card]': cards,
    'details[data-collapsible]': details,
    '[data-clear-filters]': [controls.formClear, controls.emptyClear],
  })[selector] || [];
  const animationFrames = [];
  const window = eventTarget({
    requestAnimationFrame(callback) {
      animationFrames.push(callback);
      return animationFrames.length;
    },
  });
  const flushAnimationFrames = () => {
    while (animationFrames.length) animationFrames.shift()(0);
  };

  runInNewContext(REPORT_SCRIPT, { document, window });
  return { cards, controls, details, document, empty, flushAnimationFrames, form, root, status, window };
}

test('combines all seven report filters with AND semantics including no ABNT item', async () => {
  const runtime = await import('../../src/core/report/report.js.js').catch(() => ({}));
  assert.equal(typeof runtime.matchesReportFilters, 'function');
  const tokens = {
    impact: 'serious', wcagLevels: 'A AA', outcome: 'failed', classification: 'recommendation',
    page: 'page-2', engine: 'axe-core', abntItem: '__none__',
  };
  const all = {
    impact: '', wcagLevel: '', outcome: '', classification: '', page: '', engine: '', abntItem: '',
  };
  assert.equal(runtime.matchesReportFilters(tokens, all), true);
  for (const [key, value] of Object.entries({
    impact: 'serious', wcagLevel: 'AA', outcome: 'failed', classification: 'recommendation',
    page: 'page-2', engine: 'axe-core', abntItem: '__none__',
  })) {
    assert.equal(runtime.matchesReportFilters(tokens, { ...all, [key]: value }), true, key);
  }
  assert.equal(runtime.matchesReportFilters(tokens, { ...all, impact: 'serious', wcagLevel: 'AA', page: 'page-2' }), true);
  assert.equal(runtime.matchesReportFilters(tokens, { ...all, impact: 'minor', wcagLevel: 'AA' }), false);
  assert.equal(runtime.matchesReportFilters(tokens, { ...all, impact: 'serious', wcagLevel: 'AAA' }), false);
  assert.equal(runtime.matchesReportFilters(tokens, { ...all, abntItem: '5.1.1' }), false);
});

test('static enhancement script owns one delegated filter listener and print restoration lifecycle', async () => {
  const runtime = await import('../../src/core/report/report.js.js').catch(() => ({}));
  assert.equal(typeof runtime.REPORT_SCRIPT, 'string');
  assert.match(runtime.REPORT_SCRIPT, /requestAnimationFrame/u);
  assert.match(runtime.REPORT_SCRIPT, /beforeprint/u);
  assert.match(runtime.REPORT_SCRIPT, /afterprint/u);
  assert.match(runtime.REPORT_SCRIPT, /addEventListener\(['"]change['"]/u);
  assert.doesNotMatch(runtime.REPORT_SCRIPT, /querySelector\([^)]*(?:dataset|filter|value)/u);
});

test('executes combined filters, empty state, clear focus and detail controls in the static runtime', async () => {
  const harness = await reportRuntimeHarness();
  assert.equal(harness.status.textContent, '2 de 2 ocorrências exibidas.');
  assert.equal(harness.root.classList.contains('report-enhanced'), true);
  assert.equal(harness.controls.impact.disabled, false);
  assert.deepEqual(harness.details.map(detail => detail.open), [false, false]);

  harness.controls.impact.value = 'serious';
  harness.controls.wcag.value = 'AA';
  harness.form.dispatch('change');
  harness.form.dispatch('change');
  harness.flushAnimationFrames();
  assert.deepEqual(harness.cards.map(card => card.hidden), [false, true]);
  assert.equal(harness.status.textContent, '1 de 2 ocorrências exibidas.');
  assert.equal(harness.empty.hidden, true);

  harness.controls.engine.value = 'axe-core';
  harness.form.dispatch('change');
  harness.flushAnimationFrames();
  assert.deepEqual(harness.cards.map(card => card.hidden), [true, true]);
  assert.equal(harness.empty.hidden, false);
  assert.equal(harness.status.textContent, '0 de 2 ocorrências exibidas.');

  harness.controls.emptyClear.dispatch('click');
  harness.flushAnimationFrames();
  assert.deepEqual(harness.cards.map(card => card.hidden), [false, false]);
  assert.equal(harness.empty.hidden, true);
  assert.equal(harness.document.activeElement, harness.controls.impact);

  harness.controls.expand.dispatch('click');
  assert.deepEqual(harness.details.map(detail => detail.open), [true, true]);
  harness.controls.collapse.dispatch('click');
  assert.deepEqual(harness.details.map(detail => detail.open), [false, false]);
});

test('reveals the complete report for print and restores filters, cards and details afterwards', async () => {
  const harness = await reportRuntimeHarness();
  harness.controls.impact.value = 'serious';
  harness.form.dispatch('change');
  harness.flushAnimationFrames();
  harness.details[0].open = true;
  assert.deepEqual(harness.cards.map(card => card.hidden), [false, true]);
  assert.deepEqual(harness.details.map(detail => detail.open), [true, false]);

  harness.window.dispatch('beforeprint');
  assert.equal(harness.root.classList.contains('report-printing'), true);
  assert.deepEqual(harness.cards.map(card => card.hidden), [false, false]);
  assert.deepEqual(harness.details.map(detail => detail.open), [true, true]);

  harness.window.dispatch('afterprint');
  assert.equal(harness.root.classList.contains('report-printing'), false);
  assert.equal(harness.controls.impact.value, 'serious');
  assert.deepEqual(harness.cards.map(card => card.hidden), [false, true]);
  assert.deepEqual(harness.details.map(detail => detail.open), [true, false]);
  harness.flushAnimationFrames();
  assert.deepEqual(harness.cards.map(card => card.hidden), [false, true]);
});
