import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const runtimeUrl = new URL('../../src/core/report/report-view-script.js', import.meta.url);
async function harness() {
  const runtime = await import(runtimeUrl.href).catch(error => {
    if (error.code === 'ERR_MODULE_NOT_FOUND' && error.url === runtimeUrl.href) return {};
    throw error;
  });
  assert.equal(typeof runtime.REPORT_VIEW_SCRIPT, 'string', 'standalone report enhancement is available');
  const node = (dataset = {}) => {
    const listeners = new Map();
    return { dataset, hidden: false, open: false, attributes: new Map(), parentElement: null,
      addEventListener(type, listener) { listeners.set(type, listener); },
      dispatch(type) { listeners.get(type)?.({ preventDefault() {} }); },
      setAttribute(name, value) { this.attributes.set(name, value); },
      getAttribute(name) { return this.attributes.get(name) ?? null; },
      removeAttribute(name) { this.attributes.delete(name); },
      focus() { this.focused = true; }, scrollIntoView() {},
    };
  };
  const cards = [node({ result: 'failed', reportCheckKey: 'check-a' }), node({ result: 'humanReview', reportCheckKey: 'check-a' }), node({ result: 'passed', reportCheckKey: 'check-b' })];
  const groups = cards.map(card => {
    const group = node(); group.tagName = 'DETAILS';
    group.querySelectorAll = () => [card]; card.parentElement = group; return group;
  });
  const metrics = ['failed', 'alerts', 'humanReview', 'passed'].map(value => node({ reportMetric: value }));
  const clear = node();
  const status = node();
  const printButton = node();
  const printStatus = node();
  const body = node();
  const detail = node(); detail.tagName = 'DETAILS'; detail.parentElement = groups[0];
  const evidence = node(); evidence.parentElement = detail;
  const link = node(); link.getAttribute = () => '#report-evidence-1';
  const document = {
    body,
    title: 'Relatório completo',
    querySelectorAll(selector) { return ({
      '[data-report-issue]': cards, '[data-report-item-group]': groups,
      '[data-report-metric]': metrics, '[data-report-clear-filters]': [clear],
      'details': [...groups, detail], 'a[href^="#"]': [link],
      '[data-report-print-summary]': [printButton],
    })[selector] ?? []; },
    querySelector(selector) { return selector === '[data-report-print-status]' ? printStatus : status; },
    getElementById(id) { return id === 'report-evidence-1' ? evidence : null; },
  };
  const window = node();
  runInNewContext(runtime.REPORT_VIEW_SCRIPT, { document, window });
  return { runtime, cards, groups, metrics, clear, status, detail, evidence, link, window, printButton, printStatus, body, document };
}

test('downloaded summary print restores filters and layout after native success or failure', async () => {
  for (const failure of [false, true]) {
    const h = await harness();
    let printed = null;
    h.metrics[0].dispatch('click');
    h.window.print = () => {
      printed = { layout: h.body.getAttribute('data-print-layout'), title: h.document.title,
        allVisible: h.cards.every(card => !card.hidden), allOpen: h.groups.every(group => group.open) };
      if (failure) throw new Error('PRIVATE_PRINT_FAILURE');
    };
    h.printButton.dispatch('click');
    assert.deepEqual(printed, { layout: 'summary', title: 'Resumo executivo — Audita Acessibilidade', allVisible: true, allOpen: true });
    assert.equal(h.document.title, 'Relatório completo');
    assert.equal(h.body.getAttribute('data-print-layout'), null);
    assert.deepEqual(h.cards.map(card => card.hidden), [false, true, true]);
    assert.ok(h.groups.every(group => !group.open));
    assert.doesNotMatch(h.printStatus.textContent ?? '', /PRIVATE_PRINT_FAILURE|salvo com sucesso/u);
    if (failure) assert.match(h.printStatus.textContent, /Não foi possível/u);
    h.window.dispatch('beforeprint');
    assert.equal(h.body.getAttribute('data-print-layout'), null);
    h.window.dispatch('afterprint');
  }
});

test('downloaded report filters grouped item cards without changing totals or double-counting checks', async () => {
  const h = await harness();
  assert.match(h.status.textContent, /^2 verificações/);
  h.metrics[1].dispatch('click');
  assert.ok(h.cards.every(card => card.hidden));
  assert.ok(h.groups.every(group => group.hidden));
  assert.equal(h.metrics[1].getAttribute('aria-pressed'), 'true');
  h.metrics[2].dispatch('click');
  assert.deepEqual(h.cards.map(card => card.hidden), [true, false, true]);
  assert.match(h.status.textContent, /^1 verificação/);
  h.clear.dispatch('click');
  assert.ok(h.cards.every(card => !card.hidden));
  assert.ok(h.metrics.every(metric => metric.getAttribute('aria-pressed') === 'false'));
});

test('print exposes all evidence and restores prior expansion and filters afterwards', async () => {
  const h = await harness();
  h.groups[1].open = true;
  h.metrics[0].dispatch('click');
  h.window.dispatch('beforeprint');
  h.window.dispatch('beforeprint');
  assert.ok(h.cards.every(card => !card.hidden));
  assert.ok(h.groups.every(group => !group.hidden && group.open));
  assert.equal(h.detail.open, true);
  h.window.dispatch('afterprint');
  assert.deepEqual(h.cards.map(card => card.hidden), [false, true, true]);
  assert.deepEqual(h.groups.map(group => group.open), [false, true, false]);
  assert.equal(h.detail.open, false);
});

test('local evidence links reveal closed ancestors without executing content or navigating remotely', async () => {
  const h = await harness();
  h.metrics[3].dispatch('click');
  h.link.dispatch('click');
  assert.equal(h.groups[0].open, true);
  assert.equal(h.groups[0].hidden, false);
  assert.equal(h.detail.open, true);
  assert.equal(h.evidence.focused, true);
  assert.equal(h.runtime.REPORT_VIEW_SCRIPT_CSP_HASH,
    `sha256-${createHash('sha256').update(h.runtime.REPORT_VIEW_SCRIPT).digest('base64')}`);
  assert.doesNotMatch(h.runtime.REPORT_VIEW_SCRIPT, /fetch\(|XMLHttpRequest|innerHTML|eval\(|new Function|localStorage|chrome\./);
});
