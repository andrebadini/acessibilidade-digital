import assert from 'node:assert/strict';
import test from 'node:test';

import { buildPanelView, renderPanelView } from '../../src/panel/panel-view.js';

function kebab(value) { return value.replace(/[A-Z]/gu, letter => `-${letter.toLowerCase()}`); }

class TestElement {
  constructor(tagName, ownerDocument) {
    this.tagName = String(tagName).toUpperCase();
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.listeners = new Map();
    this.className = '';
    this.hidden = false;
    this.open = false;
    this.scrollTop = 0;
    this._textContent = '';
    this.dataset = new Proxy({}, {
      set: (target, property, value) => {
        const string = String(value);
        target[property] = string;
        this.attributes.set(`data-${kebab(String(property))}`, string);
        return true;
      },
      get: (target, property) => target[property],
    });
  }
  set textContent(value) { this._textContent = String(value); this.children = []; }
  get textContent() { return this._textContent + this.children.map(child => child.textContent).join(''); }
  setAttribute(name, value) {
    const string = String(value);
    this.attributes.set(name, string);
    if (name.startsWith('data-')) {
      const key = name.slice(5).replace(/-([a-z])/gu, (_match, letter) => letter.toUpperCase());
      this.dataset[key] = string;
    }
  }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  append(...children) { for (const child of children) this.appendChild(child); }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  click() { for (const listener of this.listeners.get('click') ?? []) listener({ currentTarget: this, preventDefault() {} }); }
  focus() { this.ownerDocument.activeElement = this; }
  scrollIntoView() { this.scrolledIntoView = true; }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  querySelectorAll(selector) {
    const matches = [];
    const visit = node => {
      if (node !== this && matchesSelector(node, selector)) matches.push(node);
      for (const child of node.children) visit(child);
    };
    visit(this);
    return matches;
  }
}

class TestDocument {
  constructor() { this.activeElement = null; }
  createElement(tagName) { return new TestElement(tagName, this); }
}

function matchesSelector(node, selector) {
  const tag = selector.match(/^[a-z]+/iu)?.[0];
  if (tag && node.tagName !== tag.toUpperCase()) return false;
  for (const match of selector.matchAll(/\[([^\]=]+)(?:="([^"]*)")?\]/gu)) {
    const [, name, expected] = match;
    if (!node.hasAttribute(name)) return false;
    if (expected !== undefined && node.getAttribute(name) !== expected) return false;
  }
  return true;
}

function card({ checkKey, occurrenceId, impact, wcag, abnt, classification = 'failed', context = 'top-document' }) {
  return {
    checkKey, pageId: 'page-1', engine: 'audita-core', ruleId: checkKey,
    originalOutcome: classification === 'passed' ? 'passed' : 'failed',
    displayOutcome: classification === 'passed' ? 'passed' : 'failed',
    title: checkKey === 'check-1' ? 'Imagem sem texto alternativo' : 'Ordem de foco não lógica',
    impact, wcag: [wcag], abntItemIds: [abnt], occurrenceIds: occurrenceId ? [occurrenceId] : [],
    classification, context, accessibleName: null, announcement: null,
    evidence: { evidenceIds: occurrenceId ? [`ev-${occurrenceId}`] : [], highlightAvailable: false },
  };
}

function fixture() {
  const first = card({ checkKey: 'check-1', occurrenceId: 'occ-1', impact: 'critical', wcag: 'AA', abnt: '5.1.1' });
  const second = card({ checkKey: 'check-2', occurrenceId: 'occ-2', impact: 'serious', wcag: 'A', abnt: '5.1.4', classification: 'manual-review', context: 'mixed' });
  const passed = card({ checkKey: 'check-3', occurrenceId: null, impact: null, wcag: 'AAA', abnt: '5.1.2', classification: 'passed', context: 'page-or-process' });
  const summary = {
    version: 1, auditId: 'audit-1',
    identity: { finalUrl: 'https://exemplo.com/', completedAt: '2026-08-26T14:02:00.000Z', status: 'complete' },
    coverage: { status: 'available', numerator: 78, denominator: 100, percent: '78,0%' },
    counts: {
      errors: { checkKeys: 1, occurrences: 1 }, alerts: { checkKeys: 0, occurrences: 0 },
      humanReview: { checkKeys: 1, occurrences: 1 }, positive: { checkKeys: 1, occurrences: 0 },
    },
    distributions: {
      impact: [{ id: 'critical', count: 1 }, { id: 'serious', count: 1 }],
      wcag: [{ id: 'A', count: 1 }, { id: 'AA', count: 1 }, { id: 'AAA', count: 1 }],
      abnt: [{ id: '5.1.1', count: 1 }, { id: '5.1.2', count: 1 }, { id: '5.1.4', count: 1 }],
    },
    limitations: { codes: [], notStartedPageIds: [], inapplicableCheckKeys: [], untestedCheckKeys: [] },
    groups: { failed: [first], alerts: [], humanReview: [second], passed: [passed] },
  };
  const detail = {
    version: 1, auditId: 'audit-1', occurrenceId: 'occ-1', checkKey: 'check-1',
    heading: { title: first.title, classification: 'failed', impact: 'critical', context: 'top-document' },
    affected: { audience: 'Pessoas que não enxergam a imagem.', reason: 'A informação pode ser perdida.' },
    observed: 'Nome acessível ausente.', correction: 'Adicione um texto alternativo descritivo.',
    targets: [{ nodeId: 'n-1', position: 1, total: 1 }],
    accessibility: { name: null, nameSource: null, announcementPreview: 'Imagem' },
    normative: { wcag: ['1.1.1'], level: ['A'], abntItem: '5.1.1', classification: 'requirement' },
    legalReference: { basisRef: 'consumer-accessibility', abntItem: '5.1.1', statement: 'Referência normativa aplicável.', qualification: 'Não constitui conclusão automática.' },
    previews: [{ evidenceId: 'ev-occ-1', kind: 'element', dataUrl: null, mediaUrl: 'https://exemplo.com/evidencia.png', origin: 'captura sanitizada' }],
    technical: { selector: '#hero img', framePath: [], snippet: '<img src="/hero.png">', styles: [], engine: 'audita-core', ruleId: 'image-alt', version: '1.0.0', hashes: ['sha256:public'] },
    action: { kind: 'consult-evidence', reason: 'Esta verificação não possui um elemento único destacável no estado atual.' },
  };
  const state = {
    version: 1, screen: 'result', auditId: 'audit-1',
    filters: { impact: [], wcag: [], abnt: [] }, selectedOccurrenceId: 'occ-1',
    evidenceExpanded: false, focusId: 'occurrence-occ-1', scrollTop: 160, reason: null,
  };
  return { state, summary, detail };
}

test('buildPanelView copies and recursively freezes its complete render model', () => {
  const input = fixture();
  const view = buildPanelView(input);
  assert.equal(Object.isFrozen(view), true);
  assert.equal(Object.isFrozen(view.result.groups.failed), true);
  assert.notStrictEqual(view.result.summary, input.summary);
  input.summary.identity.finalUrl = 'https://mutated.invalid/private?token=secret';
  input.detail.heading.title = 'MUTATED';
  assert.equal(view.result.summary.identity.finalUrl, 'https://exemplo.com/');
  assert.equal(view.result.detail.heading.title, 'Imagem sem texto alternativo');
});

test('filters OR within a dimension, AND across dimensions, and preserve the selected detail', () => {
  const input = fixture();
  input.state.filters = { impact: ['critical', 'serious'], wcag: ['AA'], abnt: [] };
  let view = buildPanelView(input);
  assert.deepEqual(view.result.groups.failed.map(row => row.checkKey), ['check-1']);
  assert.deepEqual(view.result.groups.humanReview, []);
  assert.equal(view.result.detail.occurrenceId, 'occ-1');

  input.state.filters = { impact: ['serious'], wcag: ['AA'], abnt: [] };
  view = buildPanelView(input);
  assert.deepEqual(view.result.groups.failed, []);
  assert.deepEqual(view.result.groups.humanReview, []);
  assert.equal(view.result.detail.occurrenceId, 'occ-1', 'filtro não destrói a seleção oculta');
});

test('renders the exact ten detail blocks from PanelDetailV1', () => {
  const input = fixture();
  const root = renderPanelView({
    view: buildPanelView(input), document: new TestDocument(), onIntent() {}, onEvent() {},
  });
  assert.deepEqual([...root.querySelectorAll('[data-detail-block]')].map(node => node.dataset.detailBlock), [
    'heading', 'affected', 'observed', 'correction', 'targets', 'accessibility',
    'normative', 'legal', 'previews', 'technical',
  ]);
  assert.equal(root.querySelector('[data-detail-block="technical"]').tagName, 'DETAILS');
  assert.match(root.textContent, /#hero img/u);
  assert.match(root.textContent, /<img src="\/hero\.png">/u);
});

test('places the selected detail directly after its result card', () => {
  const input = fixture();
  const root = renderPanelView({
    view: buildPanelView(input), document: new TestDocument(), onIntent() {}, onEvent() {},
  });
  const card = root.querySelector('[data-result-card]');
  const siblings = card.parentNode.children;
  assert.equal(siblings[siblings.indexOf(card) + 1]?.hasAttribute('data-result-detail'), true);
});

test('renders closed result metadata and stable impact WCAG and ABNT filter selectors', () => {
  const input = fixture();
  const root = renderPanelView({
    view: buildPanelView(input), document: new TestDocument(), onIntent() {}, onEvent() {},
  });
  assert.equal(root.dataset.auditId, 'audit-1');
  const cardRoot = root.querySelector('[data-result-card][data-check-key]');
  assert.equal(cardRoot.dataset.classification, 'failed');
  assert.equal(cardRoot.dataset.context, 'top-document');
  const detailRoot = root.querySelector('[data-result-detail]');
  assert.equal(detailRoot.dataset.classification, input.detail.heading.classification);
  assert.equal(detailRoot.dataset.context, input.detail.heading.context);
  assert.ok(root.querySelector('button[data-filter-dimension="impact"][data-filter-value="critical"]'));
  assert.ok(root.querySelector('button[data-filter-dimension="wcag"][data-filter-value="AA"]'));
  assert.ok(root.querySelector('button[data-filter-dimension="abnt"][data-filter-value="5.1.1"]'));
  assert.equal(root.querySelector('button[data-filter-dimension="impact"][data-filter-value="critical"]').getAttribute('aria-pressed'), 'false');
});

test('filter listeners read currentTarget data and emit a closed reducer event', () => {
  const input = fixture();
  const events = [];
  const root = renderPanelView({
    view: buildPanelView(input), document: new TestDocument(), onIntent() {}, onEvent: event => events.push(event),
  });
  root.querySelector('button[data-filter-dimension="impact"][data-filter-value="critical"]').click();
  assert.deepEqual(events, [{ type: 'FILTER_SET', filter: 'impact', values: ['critical'] }]);
});

test('all four screens emit only the exhaustive UI intent union', () => {
  const emitted = [];
  const document = new TestDocument();
  for (const screen of ['initial', 'running', 'unavailable']) {
    const state = {
      ...fixture().state, screen, auditId: screen === 'initial' ? null : 'audit-1',
      reason: screen === 'unavailable' ? 'Não foi possível concluir a operação local.' : null,
    };
    const root = renderPanelView({ view: buildPanelView({ state }), document, onIntent: value => emitted.push(value), onEvent() {} });
    for (const button of root.querySelectorAll('button[data-intent]')) button.click();
  }
  const resultInput = fixture();
  const resultRoot = renderPanelView({ view: buildPanelView(resultInput), document, onIntent: value => emitted.push(value), onEvent() {} });
  for (const button of resultRoot.querySelectorAll('button[data-intent]')) button.click();
  assert.deepEqual(new Set(emitted.map(value => value.type)), new Set([
    'START_ATTACHED', 'OPEN_URL_FORM', 'OPEN_BATCH_FORM', 'CANCEL_AUDIT',
    'OPEN_REPORT', 'SELECT_OCCURRENCE', 'CONSULT_EVIDENCE', 'RETRY',
  ]));
});

test('consult evidence is a details action and never renders a highlight control', () => {
  const input = fixture();
  input.state.evidenceExpanded = true;
  const root = renderPanelView({
    view: buildPanelView(input), document: new TestDocument(), onIntent() {}, onEvent() {},
  });
  assert.equal(root.querySelector('[data-detail-block="previews"]').open, true);
  assert.equal(root.querySelector('[data-detail-block="technical"]').open, true);
  assert.doesNotMatch(root.textContent, /destacar na página|highlight/iu);
  assert.match(root.textContent, /Consultar evidências/iu);
});
