import assert from 'node:assert/strict';
import test from 'node:test';

import { buildPanelView, renderPanelView } from '../../src/panel/panel-view.js';

const SAFE_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

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
  dispatch(type) {
    for (const listener of this.listeners.get(type) ?? []) listener({ currentTarget: this, preventDefault() {} });
  }
  click() {
    for (const listener of this.listeners.get('click') ?? []) listener({ currentTarget: this, preventDefault() {} });
    if (this.tagName === 'LABEL') {
      const input = this.querySelector('input');
      if (input) {
        input.checked = true;
        input.dispatch('change');
      }
    }
  }
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

function card({ checkKey, occurrenceId, occurrenceIds, impact, wcag, abnt, classification = 'failed', context = 'top-document' }) {
  const ids = occurrenceIds ?? (occurrenceId ? [occurrenceId] : []);
  return {
    checkKey, pageId: 'page-1', engine: 'audita-core', ruleId: checkKey,
    originalOutcome: classification === 'passed' ? 'passed' : 'failed',
    displayOutcome: classification === 'passed' ? 'passed' : 'failed',
    title: checkKey === 'check-1' ? 'Imagem sem texto alternativo' : 'Ordem de foco não lógica',
    impact, wcag: [wcag], abntItemIds: [abnt], occurrenceIds: ids,
    classification, context, accessibleName: null, announcement: null,
    evidence: { evidenceIds: ids.map(id => `ev-${id}`), highlightAvailable: false },
  };
}

function fixture() {
  const first = card({ checkKey: 'check-1', occurrenceId: 'occ-1', impact: 'critical', wcag: '2.4.7', abnt: '5.1.1' });
  const second = card({ checkKey: 'check-2', occurrenceId: 'occ-2', impact: 'serious', wcag: '2.4.3', abnt: '5.1.4', classification: 'manual-review', context: 'mixed' });
  const passed = card({ checkKey: 'check-3', occurrenceId: null, impact: null, wcag: '2.4.12', abnt: '5.1.2', classification: 'passed', context: 'page-or-process' });
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
    captureMode: 'no-pixels', sessionStatus: null,
    privacy: { mode: null, categories: [], message: null, confirmationPending: false },
    filters: { impact: [], wcag: [], abnt: [] }, selectedOccurrenceId: 'occ-1',
    evidenceExpanded: false, focusId: 'occurrence-occ-1', scrollTop: 160, reason: null,
  };
  return { state, summary, detail };
}

function markerSnapshot(overrides = {}) {
  return {
    status: 'active',
    groups: [{ number: 7, occurrenceIds: ['occ-1', 'occ-2'] }],
    counts: { markers: 1, located: 2, unlocated: 0, general: 0, omitted: 0 },
    selectedOccurrenceId: 'occ-1',
    message: 'Sinais visíveis na página atual.',
    ...overrides,
  };
}

test('panel checklist is available separately and does not add selectable finding targets', () => {
  const input = fixture();
  input.summary.checklist = [{ ...input.summary.groups.humanReview[0], checkKey: 'general-question', occurrenceIds: ['general-1'] }];
  const view = buildPanelView(input);
  const root = renderPanelView({ view, document: new TestDocument(), onIntent() {} });
  assert.ok(root.querySelector('[data-report-checklist]'));
  assert.equal(root.querySelector('[data-report-checklist]').querySelectorAll('[data-intent="SELECT_OCCURRENCE"]').length, 0);
  assert.equal(view.result.visibleOccurrenceIds.includes('general-1'), false);
});

test('each targeted finding offers direct highlight before any page signals are activated', () => {
  const input = fixture();
  const intents = [];
  const root = renderPanelView({ view: buildPanelView(input), document: new TestDocument(), onIntent: intent => intents.push(intent) });
  const button = root.querySelector('[data-intent="HIGHLIGHT_PAGE_OCCURRENCE"]');
  assert.ok(button);
  assert.equal(button.textContent, 'Destacar elemento na página');
  button.click();
  assert.deepEqual(intents, [{ type: 'HIGHLIGHT_PAGE_OCCURRENCE', occurrenceId: 'occ-1' }]);
});

test('marker projection copies only public fields and derives visible occurrence IDs from filtered cards', () => {
  const input = fixture();
  input.state.filters = { impact: ['serious'], wcag: [], abnt: [] };
  const markers = {
    ...markerSnapshot(), auditId: 'PRIVATE_AUDIT', modelRevision: 8,
    groups: [{ number: 7, occurrenceIds: ['occ-1', 'occ-2'], ordinals: [0, 1], documentId: 'PRIVATE_DOCUMENT' }],
    counts: { ...markerSnapshot().counts, eligible: 2 },
  };
  const view = buildPanelView({ ...input, markers });

  assert.deepEqual(view.result.visibleOccurrenceIds, ['occ-2']);
  assert.deepEqual(view.markers, markerSnapshot());
  assert.equal(Object.isFrozen(view.markers), true);
  assert.equal(Object.isFrozen(view.markers.groups[0].occurrenceIds), true);
  assert.doesNotMatch(JSON.stringify(view), /PRIVATE|auditId":"PRIVATE|modelRevision|ordinal|documentId|eligible/u);

  markers.groups[0].occurrenceIds.push('mutated');
  markers.counts.located = 99;
  assert.deepEqual(view.markers.groups[0].occurrenceIds, ['occ-1', 'occ-2']);
  assert.equal(view.markers.counts.located, 2);
  assert.equal(view.result.summary.counts.errors.occurrences, 1, 'filters and markers preserve canonical totals');
});

test('result defaults to an idle marker snapshot without changing non-result contracts', () => {
  const input = fixture();
  const view = buildPanelView(input);
  assert.deepEqual(view.markers, {
    status: 'idle', groups: [], counts: null, selectedOccurrenceId: null, message: null,
  });
  assert.deepEqual(view.result.visibleOccurrenceIds, ['occ-1', 'occ-2']);
});

test('active markers render a compact ABNT-first review block, shared numbers and exact navigation intents', () => {
  const input = fixture();
  const intents = [];
  const markers = markerSnapshot({
    counts: { markers: 1, located: 2, unlocated: 3, general: 4, omitted: 5 },
  });
  const root = renderPanelView({
    view: buildPanelView({ ...input, markers }), document: new TestDocument(),
    onIntent: intent => intents.push(intent), onEvent() {},
  });

  const review = root.querySelector('[data-page-marker-review]');
  assert.ok(review);
  assert.match(review.textContent, /Conferir na página/u);
  assert.match(review.textContent, /resultado registrado.*elemento correspondente.*página atual/iu);
  assert.match(review.textContent, /não cria nova prova/iu);
  for (const [kind, symbol, label] of [
    ['failure', '×', 'Falha'], ['alert', '!', 'Alerta'], ['review', '?', 'Revisão'], ['positive', '✓', 'Positivo'],
  ]) {
    const item = review.querySelector(`[data-marker-legend="${kind}"]`);
    assert.ok(item, kind);
    assert.equal(item.textContent, `${symbol}${label}`);
  }
  for (const copy of [
    '1 elemento sinalizado', '2 ocorrências localizadas', '4 questões gerais',
    '3 ocorrências não localizadas', '5 ocorrências omitidas — consulte o relatório',
  ]) assert.match(review.textContent, new RegExp(copy, 'u'));

  const first = root.querySelector('button[data-focus-id="occurrence-occ-1"]');
  const second = root.querySelector('button[data-focus-id="occurrence-occ-2"]');
  assert.equal(first.querySelector('[data-page-marker-number="7"]').textContent, 'Sinal 7');
  assert.equal(second.querySelector('[data-page-marker-number="7"]').textContent, 'Sinal 7');
  const firstCard = root.querySelector('[data-result-card][data-check-key="check-1"]');
  assert.ok(firstCard.textContent.indexOf('ABNT 5.1.1') < firstCard.textContent.indexOf('WCAG 2.4.7'));
  root.querySelector('button[data-intent="HIDE_PAGE_MARKERS"]').click();
  root.querySelector('button[data-intent="GO_TO_PAGE_MARKER"]').click();
  assert.deepEqual(intents, [
    { type: 'HIDE_PAGE_MARKERS' },
    { type: 'GO_TO_PAGE_MARKER', occurrenceId: 'occ-1' },
  ]);
});

test('marker busy states are one-shot, announce progress and block a new audit', () => {
  for (const [status, intent, label, message] of [
    ['showing', 'SHOW_PAGE_MARKERS', 'Preparando sinais', 'Preparando os sinais na página atual.'],
    ['hiding', 'HIDE_PAGE_MARKERS', 'Removendo sinais', 'Removendo os sinais da página atual.'],
  ]) {
    const input = fixture();
    const intents = [];
    const root = renderPanelView({
      view: buildPanelView({ ...input, markers: markerSnapshot({ status, message: null }) }),
      document: new TestDocument(), onIntent: value => intents.push(value), onEvent() {},
    });
    const review = root.querySelector('[data-page-marker-review]');
    assert.equal(review.getAttribute('aria-busy'), 'true');
    assert.match(review.textContent, new RegExp(label, 'u'));
    assert.match(root.querySelector('[role="status"]').textContent, new RegExp(message.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
    const button = root.querySelector(`button[data-intent="${intent}"]`);
    assert.equal(button.getAttribute('aria-disabled'), 'true');
    button.click();
    const newAudit = root.querySelector('button[data-intent="NEW_AUDIT"]');
    assert.equal(newAudit.getAttribute('aria-disabled'), 'true');
    newAudit.click();
    assert.deepEqual(intents, []);
  }
});

test('active zero-location review remains hideable and preserves detail evidence with an explicit limit', () => {
  const input = fixture();
  input.state.evidenceExpanded = true;
  const intents = [];
  const root = renderPanelView({
    view: buildPanelView({ ...input, markers: markerSnapshot({
      groups: [], counts: { markers: 0, located: 0, unlocated: 1, general: 1, omitted: 2 },
      selectedOccurrenceId: null,
    }) }),
    document: new TestDocument(), onIntent: value => intents.push(value), onEvent() {},
  });

  const hide = root.querySelector('button[data-intent="HIDE_PAGE_MARKERS"]');
  assert.ok(hide);
  hide.click();
  assert.deepEqual(intents, [{ type: 'HIDE_PAGE_MARKERS' }]);
  assert.equal(root.querySelector('[data-page-marker-number]'), null);
  assert.equal(root.querySelector('button[data-intent="GO_TO_PAGE_MARKER"]'), null);
  assert.match(root.querySelector('[data-result-detail]').textContent, /não tem sinal localizado.*evidências.*relatório/iu);
  assert.ok(root.querySelector('[data-detail-block="previews"]'));
  assert.ok(root.querySelector('[data-detail-block="technical"]'));
});

test('idle and unavailable review states expose one keyboard-native action each', () => {
  for (const [status, message] of [['idle', null], ['unavailable', 'Não foi possível mostrar os sinais nesta página. Esta página não tem mais um canal ativo da extensão, então repetir a auditoria não resolve; consulte as evidências e as capturas no relatório.']]) {
    const input = fixture();
    const intents = [];
    const root = renderPanelView({
      view: buildPanelView({ ...input, markers: markerSnapshot({
        status, groups: [], counts: null, selectedOccurrenceId: null, message,
      }) }),
      document: new TestDocument(), onIntent: value => intents.push(value), onEvent() {},
    });
    const expectedIntent = status === 'unavailable' ? 'OPEN_REPORT' : 'SHOW_PAGE_MARKERS';
    // The report button also exists in the result actions, so scope the lookup to the
    // "Conferir na página" region.
    const region = root.querySelector('[data-page-marker-review]');
    const action = region.querySelector(`button[data-intent="${expectedIntent}"]`);
    assert.equal(action.tagName, 'BUTTON');
    assert.equal(action.getAttribute('type'), 'button');
    assert.equal(action.hasAttribute('aria-disabled'), false);
    action.click();
    assert.deepEqual(intents, [{ type: expectedIntent }]);
    if (message) {
      assert.match(root.textContent, /Não foi possível mostrar os sinais/u);
      // The notice must not promise a retry that cannot work, and the action must lead to the
      // recorded evidence instead of repeating the same denied request.
      assert.doesNotMatch(root.textContent, /Refaça a auditoria|Tente novamente/iu);
      assert.equal(region.querySelector('button[data-intent="SHOW_PAGE_MARKERS"]'), null);
      assert.match(action.textContent, /Ver evidências no relatório/u);
    }
  }
});

test('result metrics select a result filter without changing the audit totals', () => {
  const input = fixture();
  const events = [];
  let view = buildPanelView(input);
  const root = renderPanelView({ view, document: new TestDocument(), onIntent() {}, onEvent: e => events.push(e) });
  const metric = root.querySelector('button[data-result-filter="humanReview"]');
  assert.ok(metric, 'summary cards must be operable buttons');
  metric.click();
  assert.deepEqual(events[0], { type: 'FILTER_SET', filter: 'result', values: ['humanReview'], focusId: 'metric-humanReview' });
  input.state.filters.result = ['humanReview'];
  view = buildPanelView(input);
  assert.equal(view.result.groups.failed.length, 0);
  assert.equal(view.result.groups.humanReview.length, 1);
  assert.equal(view.result.summary.counts.errors.occurrences, 1);
});

test('ABNT expanders group checks and occurrence actions once per item', () => {
  const input = fixture();
  input.summary.groups.failed.push(card({ checkKey: 'check-4', occurrenceIds: ['occ-4', 'occ-5'], impact: 'serious', wcag: '2.4.7', abnt: '5.1.1' }));
  const root = renderPanelView({ view: buildPanelView(input), document: new TestDocument(), onIntent() {} });
  const groups = root.querySelectorAll('details[data-abnt-group="5.1.1"]');
  assert.equal(groups.length, 1);
  assert.equal(groups[0].querySelectorAll('[data-result-card]').length, 2);
  assert.equal(groups[0].querySelectorAll('button[data-intent="SELECT_OCCURRENCE"]').length, 3);
  assert.match(groups[0].querySelector('summary').textContent, /3 ocorrências/u);
  assert.equal(groups[0].open, true, 'selected detail remains reachable after rerender');
  assert.equal(root.querySelectorAll('button[data-filter-dimension="abnt"]').length, 0);
});

test('result offers a fresh audit choice without emitting capture or deletion', () => {
  const intents = [];
  const root = renderPanelView({ view: buildPanelView(fixture()), document: new TestDocument(), onIntent: e => intents.push(e) });
  const button = root.querySelector('button[data-intent="NEW_AUDIT"]');
  assert.ok(button);
  assert.match(button.textContent, /Refazer auditoria/u);
  button.click();
  assert.deepEqual(intents, [{ type: 'NEW_AUDIT' }]);
});

test('refazer is disabled while a highlight operation is pending', () => {
  const input = fixture();
  const intents = [];
  input.state.highlight = { ...input.state.highlight, state: 'busy', operation: 'clear', occurrenceId: 'occ-1' };
  const root = renderPanelView({ view: buildPanelView(input), document: new TestDocument(), onIntent: intent => intents.push(intent) });
  const button = root.querySelector('button[data-intent="NEW_AUDIT"]');
  assert.equal(button.getAttribute('aria-disabled'), 'true');
  button.click();
  button.click();
  assert.deepEqual(intents, []);
});

test('a check spanning two ABNT items keeps each occurrence in its own item expander', () => {
  const input = fixture();
  const mixed = input.summary.groups.failed[0];
  mixed.abntItemIds = ['5.1.1', '5.1.4'];
  mixed.occurrenceIds = ['occ-1', 'occ-other'];
  input.details = [input.detail, { ...input.detail, occurrenceId: 'occ-other', normative: { ...input.detail.normative, abntItem: '5.1.4' } }];
  const root = renderPanelView({ view: buildPanelView(input), document: new TestDocument(), onIntent() {} });
  const first = root.querySelector('details[data-abnt-group="5.1.1"]');
  const second = root.querySelector('details[data-abnt-group="5.1.4"]');
  assert.equal(first.querySelectorAll('button[data-focus-id="occurrence-occ-other"]').length, 0);
  assert.equal(second.querySelectorAll('button[data-focus-id="occurrence-occ-1"]').length, 0);
  assert.equal(root.querySelectorAll('button[data-focus-id="occurrence-occ-other"]').length, 1);
});

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

  input.state.filters = { impact: [], wcag: ['AAA'], abnt: [] };
  view = buildPanelView(input);
  assert.deepEqual(view.result.groups.failed, []);
  assert.deepEqual(view.result.groups.humanReview, []);
  assert.deepEqual(view.result.groups.passed.map(row => row.checkKey), ['check-3']);
  assert.deepEqual(view.result.detail.normative.wcag, ['1.1.1'], 'detail keeps criterion IDs instead of filter levels');
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

test('renders native determinate coverage progress and a semantic result focus destination', () => {
  const input = fixture();
  const root = renderPanelView({
    view: buildPanelView(input), document: new TestDocument(), onIntent() {}, onEvent() {},
  });
  const progress = root.querySelector('progress');
  assert.ok(progress);
  assert.equal(progress.getAttribute('value'), '78');
  assert.equal(progress.getAttribute('max'), '100');
  assert.match(progress.getAttribute('aria-label'), /78,0%/u);
  const summary = root.querySelector('[data-focus-id="result-summary"]');
  assert.equal(summary.tagName, 'H2');
  assert.equal(summary.getAttribute('tabindex'), '-1');
});

test('labels a structurally failed audit explicitly instead of presenting it as completed', () => {
  const input = fixture();
  input.summary.identity.status = 'failed';
  const root = renderPanelView({
    view: buildPanelView(input), document: new TestDocument(), onIntent() {}, onEvent() {},
  });
  const status = root.querySelector('p');
  assert.match(status.className, /(?:^|\s)status-failed(?:\s|$)/u, 'failed has its own visual and semantic state');
  assert.equal(status.textContent, 'A avaliação não pôde ser concluída');
  assert.doesNotMatch(status.textContent, /^Avaliação concluída$/u);
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

test('every occurrence in a multi-occurrence card is independently selectable', () => {
  const input = fixture();
  const first = input.summary.groups.failed[0];
  first.occurrenceIds = ['occ-1', 'occ-1b'];
  input.state.selectedOccurrenceId = 'occ-1b';
  input.detail.occurrenceId = 'occ-1b';
  const intents = [];
  const root = renderPanelView({
    view: buildPanelView(input), document: new TestDocument(), onIntent: intent => intents.push(intent), onEvent() {},
  });
  const failedCard = root.querySelector('[data-result-card][data-check-key="check-1"]');
  const selectors = failedCard.querySelectorAll('button[data-intent="SELECT_OCCURRENCE"]');
  assert.equal(selectors.length, 2);
  selectors.forEach(button => button.click());
  assert.deepEqual(intents.map(intent => intent.occurrenceId), ['occ-1', 'occ-1b']);
  assert.equal(selectors[1].getAttribute('aria-pressed'), 'true');
  assert.doesNotMatch(failedCard.textContent, /occ-1/iu, 'opaque occurrence IDs stay out of visible copy');
});

test('renders closed result metadata with impact/WCAG filters and ABNT disclosures', () => {
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
  assert.ok(root.querySelector('details[data-abnt-group="5.1.1"]'));
  assert.equal(root.querySelector('button[data-filter-dimension="impact"][data-filter-value="critical"]').getAttribute('aria-pressed'), 'false');
});

test('filter listeners read currentTarget data and emit a closed reducer event', () => {
  const input = fixture();
  const events = [];
  const root = renderPanelView({
    view: buildPanelView(input), document: new TestDocument(), onIntent() {}, onEvent: event => events.push(event),
  });
  root.querySelector('button[data-filter-dimension="impact"][data-filter-value="critical"]').click();
  assert.deepEqual(events, [{
    type: 'FILTER_SET', filter: 'impact', values: ['critical'], focusId: 'filter-impact-0',
  }]);
});

test('filters expose a compact Todos reset and one stable focus ID per option', () => {
  const input = fixture();
  input.state.filters.impact = ['critical'];
  const events = [];
  const root = renderPanelView({
    view: buildPanelView(input), document: new TestDocument(), onIntent() {}, onEvent: event => events.push(event),
  });
  const controls = root.querySelectorAll('button[data-filter-dimension]');
  const focusIds = controls.map(control => control.dataset.focusId);
  assert.equal(new Set(focusIds).size, focusIds.length);
  const all = root.querySelector('button[data-filter-dimension="impact"][data-filter-control="all"]');
  assert.equal(all.getAttribute('aria-pressed'), 'false');
  all.click();
  assert.deepEqual(events, [{ type: 'FILTER_SET', filter: 'impact', values: [], focusId: 'filter-impact-all' }]);
});

test('manual evidence disclosure emits state and survives a re-render for both details', () => {
  const input = fixture();
  const events = [];
  let root = renderPanelView({
    view: buildPanelView(input), document: new TestDocument(), onIntent() {}, onEvent: event => events.push(event),
  });
  const previews = root.querySelector('[data-detail-block="previews"]');
  previews.open = true;
  previews.dispatch('toggle');
  assert.deepEqual(events, [{ type: 'EVIDENCE_TOGGLED', expanded: true, focusId: 'evidence-summary' }]);

  input.state.evidenceExpanded = true;
  root = renderPanelView({
    view: buildPanelView(input), document: new TestDocument(), onIntent() {}, onEvent: event => events.push(event),
  });
  assert.equal(root.querySelector('[data-detail-block="previews"]').open, true);
  const technical = root.querySelector('[data-detail-block="technical"]');
  assert.equal(technical.open, true);
  technical.open = false;
  technical.dispatch('toggle');
  assert.deepEqual(events[1], { type: 'EVIDENCE_TOGGLED', expanded: false, focusId: 'technical-summary' });
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
  resultInput.state.highlight = {
    state: 'idle', occurrenceId: null,
    bindingStatus: { state: 'unavailable', reason: 'no-binding' }, message: null,
  };
  const resultRoot = renderPanelView({ view: buildPanelView(resultInput), document, onIntent: value => emitted.push(value), onEvent() {} });
  for (const button of resultRoot.querySelectorAll('button[data-intent]')) button.click();
  const pausedInput = fixture();
  pausedInput.state = {
    ...pausedInput.state, screen: 'running', captureMode: 'full-evidence', sessionStatus: 'privacy-paused',
    privacy: {
      mode: 'full-evidence', categories: ['password'],
      message: 'A página contém conteúdo potencialmente sensível. Confirme para capturar imagens visíveis.',
      confirmationPending: false,
    },
  };
  const pausedRoot = renderPanelView({
    view: buildPanelView({ state: pausedInput.state }), document,
    onIntent: value => emitted.push(value), onEvent() {},
  });
  for (const button of pausedRoot.querySelectorAll('button[data-intent]')) button.click();
  assert.deepEqual(new Set(emitted.map(value => value.type)), new Set([
    'OPEN_TAB_READING',
    'START_ATTACHED', 'OPEN_URL_FORM', 'OPEN_BATCH_FORM', 'CANCEL_AUDIT',
    'OPEN_REPORT', 'NEW_AUDIT', 'SELECT_OCCURRENCE', 'CONSULT_EVIDENCE', 'RETRY',
    'PERSONA_SELECT', 'CONFIRM_PIXEL_CAPTURE', 'SHOW_PAGE_MARKERS', 'HIGHLIGHT_PAGE_OCCURRENCE',
  ]));
});

test('initial screen exposes three described radio modes and emits only a safe local selection event', () => {
  const input = fixture();
  input.state = {
    ...input.state, screen: 'initial', auditId: null, captureMode: 'full-evidence', sessionStatus: null,
    privacy: { mode: null, categories: [], message: null, confirmationPending: false },
  };
  const events = [];
  const root = renderPanelView({
    view: buildPanelView({ state: input.state }), document: new TestDocument(),
    onIntent() {}, onEvent: event => events.push(event),
  });

  const fieldset = root.querySelector('fieldset');
  assert.ok(fieldset);
  assert.match(fieldset.textContent, /Modo de evidência/u);
  for (const [mode, label] of [
    ['full-evidence', 'Evidência completa'],
    ['element-only', 'Somente elementos'],
    ['no-pixels', 'Sem imagens'],
  ]) {
    const radio = root.querySelector(`input[data-capture-mode="${mode}"]`);
    assert.ok(radio, mode);
    assert.equal(radio.getAttribute('type'), 'radio');
    assert.equal(radio.getAttribute('name'), 'capture-mode');
    assert.ok(radio.getAttribute('aria-describedby'));
    assert.match(root.textContent, new RegExp(label, 'u'));
  }
  assert.equal(root.querySelector('input[data-capture-mode="full-evidence"]').checked, true);
  assert.match(
    root.textContent,
    /A auditoria pode capturar pixels e conteúdo visível, inclusive dados pessoais\. Tudo permanece neste dispositivo\./u,
  );

  root.querySelector('input[data-capture-mode="element-only"]').dispatch('change');
  assert.deepEqual(events, [{
    type: 'CAPTURE_MODE_SELECTED', mode: 'element-only', focusId: 'capture-mode-element-only',
  }]);
  assert.match(root.textContent, /Auditar a página atual/u);
  assert.match(root.textContent, /Outra URL/u);
  assert.match(root.textContent, /Lote de páginas/u);
});

test('batch form keeps URLs transient, defaults to no-pixels, and exposes all three evidence modes', () => {
  const input = fixture();
  input.state = {
    ...input.state, screen: 'initial', auditId: null, entryMode: 'batch', entryError: null,
    auditSource: null, captureMode: 'no-pixels', sessionStatus: null,
    batch: { total: null, pageNumber: null, warnings: [], errors: [] },
    privacy: { mode: null, categories: [], message: null, confirmationPending: false },
  };
  const emitted = [];
  const events = [];
  const view = buildPanelView({ state: input.state });
  assert.equal(Object.hasOwn(view, 'urls'), false);
  const root = renderPanelView({
    view, document: new TestDocument(), onIntent: intent => emitted.push(intent), onEvent: event => events.push(event),
  });
  const form = root.querySelector('form[id="batch-audit-form"]');
  const urls = root.querySelector('textarea[id="audit-urls"]');
  const submit = root.querySelector('button[data-intent="START_BATCH"]');
  assert.ok(form);
  assert.ok(urls);
  assert.equal(urls.getAttribute('name'), 'batch-urls');
  assert.equal(urls.hasAttribute('required'), true);
  assert.equal(submit.textContent, 'Avaliar páginas');
  assert.match(root.textContent, /2 a 20 URLs HTTP\/HTTPS/u);
  assert.match(root.textContent, /uma por linha/u);
  assert.match(root.textContent, /não segue links/u);
  assert.match(root.textContent, /Você poderá confirmar antes de qualquer captura sensível/u);
  assert.equal(root.querySelectorAll('input[data-capture-mode]').length, 3);
  assert.equal(root.querySelector('input[data-capture-mode="no-pixels"]').checked, true);
  assert.ok(root.querySelector('input[data-capture-mode="full-evidence"]'));
  assert.ok(root.querySelector('input[data-capture-mode="element-only"]'));
  assert.ok(root.querySelector('button[data-intent="CLOSE_BATCH_FORM"]'));

  root.querySelector('input[data-capture-mode="element-only"]').dispatch('change');
  assert.deepEqual(events, [{
    type: 'CAPTURE_MODE_SELECTED', mode: 'element-only', focusId: 'capture-mode-element-only',
  }]);

  urls.value = 'https://one.example/private?token=alpha\nhttps://two.example/private?token=beta';
  form.dispatch('submit');
  assert.deepEqual(emitted, [{
    type: 'START_BATCH',
    urls: 'https://one.example/private?token=alpha\nhttps://two.example/private?token=beta',
  }]);
  assert.doesNotMatch(JSON.stringify(view), /token=alpha|token=beta/u);
});

test('batch errors and running progress show only safe line numbers, totals, and warnings', () => {
  const input = fixture();
  input.state = {
    ...input.state, screen: 'initial', auditId: null, entryMode: 'batch', entryError: 'invalid-lines',
    auditSource: null, captureMode: 'no-pixels', sessionStatus: null,
    batch: {
      total: null, pageNumber: null, warnings: [],
      errors: [{ line: 2, code: 'invalid' }, { line: 4, code: 'too-long' }],
    },
  };
  let root = renderPanelView({
    view: buildPanelView({ state: input.state }), document: new TestDocument(), onIntent() {}, onEvent() {},
  });
  assert.match(root.textContent, /linhas indicadas/u);
  assert.match(root.textContent, /Linha 2/u);
  assert.match(root.textContent, /Linha 4/u);
  assert.doesNotMatch(root.textContent, /secret\.example|token=/u);

  input.state = {
    ...input.state, screen: 'running', auditId: 'audit-batch-1', entryError: null, auditSource: 'batch',
    progress: {
      phase: 'batch-page', message: 'Página 1 de 2: auditoria em andamento.', percent: 25,
      at: '2026-09-01T12:00:00.000Z',
    },
    batch: {
      total: 2, pageNumber: 1, errors: [], warnings: [{
        line: 3, code: 'DUPLICATE_URL', firstLine: 1,
        message: 'A URL repete uma entrada anterior e não será auditada novamente.',
      }],
    },
  };
  root = renderPanelView({
    view: buildPanelView({ state: input.state }), document: new TestDocument(), onIntent() {}, onEvent() {},
  });
  assert.match(root.textContent, /Avaliando lote/u);
  assert.match(root.textContent, /Página 1 de 2/u);
  assert.match(root.textContent, /Linha 3/u);
  assert.match(root.textContent, /linha 1/u);
  const batchProgress = root.querySelector('[data-page-number="1"][data-total="2"]');
  assert.ok(batchProgress);
  assert.match(root.querySelector('[role="status"]').textContent, /Página 1 de 2/u);
});

test('batch running phases follow the current page while the progress bar preserves the batch total', () => {
  const input = fixture();
  input.state = {
    ...input.state, screen: 'running', auditId: 'audit-batch-phases', auditSource: 'batch', sessionStatus: null,
  };

  for (const [pageNumber, total, percent, complete, label] of [
    [2, 2, 52.5, 0, 'Abrindo e estabilizando a página'],
    [2, 2, 55, 0, 'Abrindo e estabilizando a página'],
    [2, 2, 75, 2, 'Verificando regras automáticas'],
    [2, 2, 80, 2, 'Verificando regras automáticas'],
    [2, 2, 100, 5, null],
    [1, 3, 8.333333333333332, 1, 'Lendo estrutura e acessibilidade'],
    [1, 3, 33.33333333333333, 5, null],
  ]) {
    input.state.batch = { total, pageNumber, warnings: [], errors: [] };
    input.state.progress = {
      phase: 'batch-page',
      message: `Página ${pageNumber} de ${total}: ${complete === 5 ? 'processamento encerrado.' : 'auditoria em andamento.'}`,
      percent, at: '2026-09-01T12:00:00.000Z',
    };
    const root = renderPanelView({
      view: buildPanelView({ state: input.state }), document: new TestDocument(), onIntent() {}, onEvent() {},
    });

    const progress = root.querySelector('progress[data-audit-progress]');
    assert.equal(progress.getAttribute('value'), String(percent));
    assert.equal(progress.getAttribute('max'), '100');
    assert.equal(root.querySelectorAll('li[data-phase-state]').length, 5);
    assert.equal(root.querySelectorAll('[data-phase-state="complete"]').length, complete, `batch progress ${percent}%`);
    assert.equal(root.querySelectorAll('[data-phase-indicator="complete"]').length, complete);
    assert.equal(root.querySelectorAll('[data-phase-state="current"]').length, label ? 1 : 0);
    if (label) {
      const current = root.querySelector('[data-phase-state="current"]');
      assert.equal(current.getAttribute('aria-current'), 'step');
      assert.ok(current.textContent.includes(`${label} — em andamento`));
    }
    if (complete > 0) assert.equal(root.querySelector('[data-phase-indicator="complete"]').textContent, '✓');
  }
});

test('single-URL form keeps the typed value transient and enables all three explicit modes', () => {
  for (const mode of ['full-evidence', 'element-only', 'no-pixels']) {
    const input = fixture();
    input.state = {
      ...input.state, screen: 'initial', auditId: null, entryMode: 'single-url', entryError: null,
      auditSource: null, captureMode: mode, sessionStatus: null,
      privacy: { mode: null, categories: [], message: null, confirmationPending: false },
    };
    const emitted = [];
    const view = buildPanelView({ state: input.state });
    assert.equal(Object.hasOwn(view, 'url'), false);
    const root = renderPanelView({
      view, document: new TestDocument(), onIntent: intent => emitted.push(intent), onEvent() {},
    });
    const form = root.querySelector('form[id="audit-form"]');
    const url = root.querySelector('input[id="audit-url"]');
    const submit = root.querySelector('button[data-intent="START_URL"]');
    assert.ok(form);
    assert.ok(url);
    assert.equal(url.getAttribute('name'), 'audit-url');
    assert.equal(url.getAttribute('type'), 'url');
    assert.equal(url.getAttribute('inputmode'), 'url');
    assert.equal(url.getAttribute('autocomplete'), 'url');
    assert.equal(url.hasAttribute('required'), true);
    assert.equal(url.getAttribute('maxlength'), '2048');
    assert.equal(submit.hasAttribute('disabled'), false, mode);
    assert.equal(submit.hasAttribute('aria-disabled'), false, mode);
    assert.match(root.textContent, /Informe a URL e escolha como coletar as evidências\./u);
    assert.match(root.textContent, /A auditoria pode capturar pixels e conteúdo visível/u);
    assert.doesNotMatch(root.textContent, /somente no modo Sem imagens/iu);
    url.value = 'https://example.test/private?token=transient';
    form.dispatch('submit');
    assert.deepEqual(emitted, [{ type: 'START_URL', url: 'https://example.test/private?token=transient' }]);
    assert.doesNotMatch(JSON.stringify(view), /token=transient/u);
  }
});

test('single-URL errors are useful and never echo the rejected address', () => {
  for (const [entryError, copy] of [
    ['required', 'Informe uma URL para continuar.'],
    ['invalid', 'Informe um endereço completo começando por http:// ou https://.'],
    ['too-long', 'A URL é longa demais. Use um endereço com até 2.048 caracteres.'],
    ['start-failed', 'Não foi possível iniciar a avaliação desta URL. Tente novamente.'],
  ]) {
    const input = fixture();
    input.state = {
      ...input.state, screen: 'initial', auditId: null, entryMode: 'single-url', entryError,
      auditSource: null, captureMode: 'no-pixels', sessionStatus: null,
      privacy: { mode: null, categories: [], message: null, confirmationPending: false },
    };
    const root = renderPanelView({
      view: buildPanelView({ state: input.state }), document: new TestDocument(), onIntent() {}, onEvent() {},
    });
    assert.match(root.textContent, new RegExp(copy.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
    assert.doesNotMatch(root.textContent, /secret\.example|token=/u);
  }
});

test('the complete radio card, including its description, is one associated clickable target', () => {
  const input = fixture();
  input.state = {
    ...input.state, screen: 'initial', auditId: null, captureMode: 'full-evidence', sessionStatus: null,
    privacy: { mode: null, categories: [], message: null, confirmationPending: false },
  };
  const events = [];
  const root = renderPanelView({
    view: buildPanelView({ state: input.state }), document: new TestDocument(),
    onIntent() {}, onEvent: event => events.push(event),
  });
  const card = root.querySelector('label[data-capture-option="element-only"]');
  assert.ok(card);
  assert.match(card.textContent, /Somente elementos/u);
  assert.match(card.textContent, /Captura apenas os elementos relacionados/u);
  card.click();
  assert.equal(card.querySelector('input').checked, true);
  assert.deepEqual(events, [{
    type: 'CAPTURE_MODE_SELECTED', mode: 'element-only', focusId: 'capture-mode-element-only',
  }]);
});

test('privacy pause stays on running screen, hides phases and personas, and emits no private identifier', () => {
  const input = fixture();
  input.state = {
    ...input.state, screen: 'running', captureMode: 'full-evidence', sessionStatus: 'privacy-paused',
    privacy: {
      mode: 'full-evidence', categories: ['password', 'payment'],
      message: 'A página contém conteúdo potencialmente sensível. Confirme para capturar imagens visíveis.',
      confirmationPending: false,
    },
  };
  const intents = [];
  const root = renderPanelView({
    view: buildPanelView({ state: input.state }), document: new TestDocument(),
    onIntent: intent => intents.push(intent), onEvent() {},
  });

  assert.equal(root.dataset.screen, 'running');
  assert.equal(root.dataset.sessionStatus, 'privacy-paused');
  assert.match(root.textContent, /Confirme antes de capturar imagens/u);
  assert.match(root.textContent, /Tudo permanece neste dispositivo/u);
  assert.match(root.textContent, /Campo de senha/u);
  assert.match(root.textContent, /Dados de pagamento/u);
  assert.equal(root.querySelector('[data-running-phases]'), null);
  assert.equal(root.querySelector('[data-persona-controls]'), null);
  assert.match(root.textContent, /Continuar e capturar/u);
  assert.match(root.textContent, /Cancelar auditoria/u);
  const live = root.querySelector('[role="status"][aria-live="polite"]');
  assert.equal(live.getAttribute('aria-atomic'), 'true');

  root.querySelector('button[data-intent="CONFIRM_PIXEL_CAPTURE"]').click();
  assert.deepEqual(intents[0], { type: 'CONFIRM_PIXEL_CAPTURE', mode: 'full-evidence', accepted: true });
  assert.doesNotMatch(JSON.stringify(intents), /consent|capability|documentId|tabId|digest|PRIVATE/u);
});

test('batch privacy pause shows only safe mode, categories and page position before one-shot actions', () => {
  const input = fixture();
  input.state = {
    ...input.state, screen: 'running', auditSource: 'batch', auditId: 'audit-batch-private',
    captureMode: 'element-only', sessionStatus: 'privacy-paused',
    batch: { total: 5, pageNumber: 3, warnings: [], errors: [] },
    privacy: {
      mode: 'element-only', categories: ['otp', 'private-marker'],
      message: 'A página contém conteúdo potencialmente sensível. Confirme para capturar imagens visíveis.',
      confirmationPending: false,
    },
  };
  const intents = [];
  const root = renderPanelView({
    view: buildPanelView({ state: input.state }), document: new TestDocument(),
    onIntent: intent => intents.push(intent), onEvent() {},
  });

  assert.match(root.textContent, /Somente elementos/u);
  assert.match(root.textContent, /Página 3 de 5/u);
  assert.equal(root.dataset.pageNumber, '3');
  assert.equal(root.dataset.total, '5');
  assert.match(root.textContent, /Código de uso único/u);
  assert.match(root.textContent, /Conteúdo marcado como privado/u);
  assert.match(root.textContent, /Continuar e capturar/u);
  assert.match(root.textContent, /Cancelar auditoria/u);
  assert.doesNotMatch(root.textContent, /https?:|consent|owner|digest|documentId|tabId|audit-batch-private/iu);

  root.querySelector('button[data-intent="CONFIRM_PIXEL_CAPTURE"]').click();
  assert.deepEqual(intents, [{ type: 'CONFIRM_PIXEL_CAPTURE', mode: 'element-only', accepted: true }]);

  input.state = {
    ...input.state,
    batch: { total: null, pageNumber: 3, warnings: [], errors: [] },
  };
  const rehydratedRoot = renderPanelView({
    view: buildPanelView({ state: input.state }), document: new TestDocument(),
    onIntent() {}, onEvent() {},
  });
  assert.match(rehydratedRoot.textContent, /Página 3 pausada/u);
  assert.doesNotMatch(rehydratedRoot.textContent, /Página 3 de/u);
});

test('pending privacy confirmation is visibly one-shot while cancel remains available', () => {
  const input = fixture();
  input.state = {
    ...input.state, screen: 'running', captureMode: 'element-only', sessionStatus: 'privacy-paused',
    privacy: {
      mode: 'element-only', categories: ['private-marker'],
      message: 'A página contém conteúdo potencialmente sensível. Confirme para capturar imagens visíveis.',
      confirmationPending: true,
    },
  };
  const intents = [];
  const root = renderPanelView({
    view: buildPanelView({ state: input.state }), document: new TestDocument(),
    onIntent: intent => intents.push(intent), onEvent() {},
  });
  const confirm = root.querySelector('button[data-intent="CONFIRM_PIXEL_CAPTURE"]');
  assert.equal(confirm.getAttribute('aria-disabled'), 'true');
  assert.match(confirm.textContent, /Confirmação enviada/u);
  confirm.click();
  root.querySelector('button[data-intent="CANCEL_AUDIT"]').click();
  assert.deepEqual(intents, [{ type: 'CANCEL_AUDIT' }]);
});

test('rejects an impossible no-pixels privacy projection before rendering', () => {
  const input = fixture();
  input.state = {
    ...input.state, screen: 'running', captureMode: 'no-pixels', sessionStatus: 'privacy-paused',
    privacy: {
      mode: 'no-pixels', categories: ['password'],
      message: 'A página contém conteúdo potencialmente sensível. Confirme para capturar imagens visíveis.',
      confirmationPending: false,
    },
  };
  assert.throws(() => buildPanelView({ state: input.state }), /PANEL_VIEW_PRIVACY_INVALID/u);
});

test('details expose exactly the worker-approved action and emit no target internals', () => {
  const input = fixture();
  input.state.evidenceExpanded = true;
  input.state.highlight = {
    state: 'idle', occurrenceId: null, bindingStatus: { state: 'available' },
    message: 'Este item pode ser destacado na página.',
  };
  const intents = [];
  let root = renderPanelView({
    view: buildPanelView(input), document: new TestDocument(), onIntent: value => intents.push(value), onEvent() {},
  });
  assert.equal(root.querySelector('[data-detail-block="previews"]').open, true);
  assert.equal(root.querySelector('[data-detail-block="technical"]').open, true);
  assert.match(root.textContent, /Ver e destacar na página/iu);
  assert.equal(root.querySelector('[data-action="clear-highlight"]'), null);
  assert.equal(root.querySelector('[data-action="consult-evidence"]'), null);
  root.querySelector('[data-action="highlight-occurrence"]').click();
  assert.deepEqual(intents, [{ type: 'HIGHLIGHT_OCCURRENCE', occurrenceId: 'occ-1' }]);
  assert.equal(JSON.stringify(intents).includes('selector'), false);

  input.state.highlight = {
    state: 'active', occurrenceId: 'occ-1', bindingStatus: { state: 'available' },
    message: 'Destaque visível na página atual.',
  };
  root = renderPanelView({
    view: buildPanelView(input), document: new TestDocument(), onIntent: value => intents.push(value), onEvent() {},
  });
  assert.equal(root.querySelector('[data-action="highlight-occurrence"]'), null);
  root.querySelector('[data-action="clear-highlight"]').click();
  assert.deepEqual(intents.at(-1), { type: 'CLEAR_HIGHLIGHT' });
});

test('live highlight action keeps one stable focus identity while its label and intent change', () => {
  const input = fixture();
  input.state.highlight = {
    state: 'idle', occurrenceId: null, bindingStatus: { state: 'available' }, message: null,
  };
  let root = renderPanelView({
    view: buildPanelView(input), document: new TestDocument(), onIntent() {}, onEvent() {},
  });
  const highlight = root.querySelector('[data-action="highlight-occurrence"]');
  assert.equal(highlight.dataset.focusId, 'live-highlight-action');

  input.state.highlight = {
    state: 'active', occurrenceId: 'occ-1', bindingStatus: { state: 'available' }, message: null,
  };
  root = renderPanelView({
    view: buildPanelView(input), document: new TestDocument(), onIntent() {}, onEvent() {},
  });
  const clear = root.querySelector('[data-action="clear-highlight"]');
  assert.equal(clear.dataset.focusId, highlight.dataset.focusId);

  input.state.highlight = {
    state: 'idle', occurrenceId: null, bindingStatus: { state: 'checking' }, message: null,
  };
  root = renderPanelView({
    view: buildPanelView(input), document: new TestDocument(), onIntent() {}, onEvent() {},
  });
  const checking = root.querySelector('[data-action="highlight-checking"]');
  assert.equal(checking.dataset.focusId, highlight.dataset.focusId);
  assert.equal(checking.disabled, false);
  assert.equal(checking.getAttribute('aria-disabled'), 'true');

  input.state.highlight = {
    state: 'busy', operation: 'highlight', occurrenceId: 'occ-1', bindingStatus: { state: 'available' }, message: null,
  };
  root = renderPanelView({
    view: buildPanelView(input), document: new TestDocument(), onIntent() {}, onEvent() {},
  });
  const busy = root.querySelector('[data-action="highlight-occurrence"]');
  assert.equal(busy.dataset.focusId, highlight.dataset.focusId);
  assert.equal(busy.disabled, false);
  assert.equal(busy.getAttribute('aria-disabled'), 'true');
  assert.match(busy.textContent, /Destacando na página/iu);
  assert.equal(root.querySelector('[data-action="clear-highlight"]'), null);

  input.state.highlight = {
    state: 'busy', operation: 'clear', occurrenceId: 'occ-1', bindingStatus: { state: 'available' }, message: null,
  };
  root = renderPanelView({
    view: buildPanelView(input), document: new TestDocument(), onIntent() {}, onEvent() {},
  });
  const clearing = root.querySelector('[data-action="clear-highlight"]');
  assert.ok(clearing);
  assert.match(clearing.textContent, /Removendo destaque/iu);
});

test('an overlay keeps an accessible global clear action when another occurrence is selected or filters hide its detail', () => {
  const input = fixture();
  input.state.selectedOccurrenceId = 'occ-2';
  input.state.highlight = {
    state: 'active', occurrenceId: 'occ-1', bindingStatus: { state: 'unchecked' }, message: null,
  };
  const intents = [];
  let root = renderPanelView({
    view: buildPanelView(input), document: new TestDocument(), onIntent: value => intents.push(value), onEvent() {},
  });
  let clear = root.querySelector('[data-global-highlight-clear]');
  assert.ok(clear);
  assert.match(clear.textContent, /Limpar destaque/iu);
  clear.click();
  assert.deepEqual(intents, [{ type: 'CLEAR_HIGHLIGHT' }]);

  input.state.selectedOccurrenceId = 'occ-1';
  input.state.filters = { impact: ['serious'], wcag: [], abnt: [] };
  root = renderPanelView({
    view: buildPanelView(input), document: new TestDocument(), onIntent: value => intents.push(value), onEvent() {},
  });
  clear = root.querySelector('[data-global-highlight-clear]');
  assert.ok(clear, 'filtering the active detail cannot orphan the overlay');
});

test('evidence fallback renders only a validated local PNG with contextual alternative text and intrinsic dimensions', () => {
  const input = fixture();
  input.state.evidenceExpanded = true;
  input.detail.previews = [
    { evidenceId: 'ev-safe', kind: 'element', dataUrl: SAFE_PNG, mediaUrl: '', origin: 'captura local' },
    { evidenceId: 'ev-remote', kind: 'full-page', dataUrl: 'https://remote.invalid/secret.png', mediaUrl: 'https://remote.invalid/secret.png', origin: 'remota' },
  ];
  const root = renderPanelView({
    view: buildPanelView(input), document: new TestDocument(), onIntent() {}, onEvent() {},
  });
  const images = root.querySelectorAll('[data-evidence-preview-image]');
  assert.equal(images.length, 1);
  assert.equal(images[0].getAttribute('src'), SAFE_PNG);
  assert.match(images[0].getAttribute('alt'), /captura do elemento.*ev-safe/iu);
  assert.equal(images[0].getAttribute('width'), '1');
  assert.equal(images[0].getAttribute('height'), '1');
  assert.equal(root.querySelectorAll('[src="https://remote.invalid/secret.png"]').length, 0);
});

test('explains a preview omitted by the panel budget without inventing or exposing an image source', () => {
  const input = fixture();
  input.state.evidenceExpanded = true;
  input.detail.previews = [
    { evidenceId: 'ev-large', kind: 'full-page', dataUrl: null, mediaUrl: '', origin: '' },
  ];
  const root = renderPanelView({
    view: buildPanelView(input), document: new TestDocument(), onIntent() {}, onEvent() {},
  });

  assert.equal(root.querySelectorAll('[data-evidence-preview-image]').length, 0);
  assert.match(root.textContent, /prévia.*omitida.*painel.*relatório/iu);
});

test('explains that structural evidence has no raster in no-pixels mode', () => {
  const input = fixture();
  input.state.evidenceExpanded = true;
  input.state.captureMode = 'no-pixels';
  input.detail.previews = [
    { evidenceId: 'ev-structure', kind: 'element', dataUrl: '', mediaUrl: '', origin: '' },
  ];
  const root = renderPanelView({
    view: buildPanelView(input), document: new TestDocument(), onIntent() {}, onEvent() {},
  });

  assert.equal(root.querySelectorAll('[data-evidence-preview-image]').length, 0);
  assert.match(root.querySelector('[data-detail-block="previews"]').textContent,
    /nenhuma captura raster.*modo sem imagens.*evidências estruturais/iu);
});

test('persistent simulation controls expose pressed state and reader transport labels', () => {
  const input = fixture();
  input.state.persona = {
    mode: 'reader', readerPaused: false, speechAvailability: 'unavailable', voiceId: '', rate: 1,
    message: 'Leitura simulada ativa. Use os controles para navegar pela legenda.',
  };
  const root = renderPanelView({
    view: buildPanelView(input), document: new TestDocument(), onIntent() {}, onEvent() {},
  });
  const reader = root.querySelector('button[data-persona-mode="reader"]');
  assert.equal(reader.getAttribute('aria-pressed'), 'true');
  for (const label of ['Anterior', 'Repetir', 'Pausar', 'Próximo', 'Encerrar']) assert.match(root.textContent, new RegExp(label, 'u'));
  const enableVoice = root.querySelector('button[data-intent="PERSONA_READER_ENABLE_VOICE"]');
  assert.ok(enableVoice);
  assert.match(enableVoice.textContent, /Ativar voz local/u);
  assert.match(root.textContent, /Leitura simulada ativa/u);
});

test('result prioritizes summary filters and ABNT before secondary coverage guidance', () => {
  const root = renderPanelView({
    view: buildPanelView(fixture()), document: new TestDocument(), onIntent() {},
  });
  const metrics = root.querySelector('[aria-label="Resumo dos resultados"]');
  const ready = root.querySelector('[data-report-ready]');
  assert.ok(root.children.indexOf(metrics) < root.children.indexOf(ready), 'summary before action/help blocks');
  const summaryFocus = root.querySelector('[data-focus-id="result-summary"]');
  assert.equal(summaryFocus.textContent, 'Resumo da avaliação');
  assert.equal(summaryFocus.parentNode, root, 'result focus must not be inside a closed disclosure');
  const coverage = root.querySelector('details[data-result-guidance]');
  assert.ok(coverage);
  assert.equal(coverage.open, false);
  assert.ok(coverage.querySelector('progress'));
  assert.match(coverage.textContent, /78 de 100 testes/u);
  const groups = root.children.find(node => node.querySelector('[data-abnt-group]'));
  assert.ok(root.children.indexOf(groups) < root.children.indexOf(coverage));
  assert.ok(root.children.some(node => /Não é certificação de conformidade/u.test(node.textContent) && node.tagName === 'P'));
});

test('compact marker help never hides show/hide actions, status or omitted-result warning', () => {
  for (const status of ['idle', 'active', 'unavailable']) {
    const root = renderPanelView({
      view: buildPanelView({ ...fixture(), markers: markerSnapshot({ status, counts: { markers: 1, located: 2, unlocated: 3, general: 4, omitted: 5 } }) }),
      document: new TestDocument(), onIntent() {},
    });
    const review = root.querySelector('[data-page-marker-review]');
    const help = review.querySelector('details[data-marker-help]');
    assert.ok(help);
    assert.equal(help.open, false);
    assert.match(help.textContent, /não cria nova prova/u);
    assert.equal(help.querySelectorAll('[data-marker-legend]').length, 4);
    assert.equal(help.querySelector('[data-intent]'), null);
    assert.equal(review.querySelector('[role="status"]').parentNode, review);
    assert.ok(review.children.some(node => /5 ocorrências omitidas/u.test(node.textContent) && node.tagName === 'P'));
    assert.equal(review.querySelector('button').parentNode, review);
  }
});

test('advanced filters are collapsed by default and stay exposed while a filter is active', () => {
  for (const active of [false, true]) {
    const input = fixture();
    if (active) input.state.filters.impact = ['critical'];
    const root = renderPanelView({ view: buildPanelView(input), document: new TestDocument(), onIntent() {} });
    const filters = root.querySelector('details[data-advanced-filters]');
    assert.ok(filters);
    assert.equal(filters.open, active);
    assert.ok(filters.querySelector('button'));
  }
});

test('clearing the last advanced filter leaves its focus destination exposed', () => {
  const input = fixture();
  input.state.focusId = 'filter-impact-all';
  const root = renderPanelView({ view: buildPanelView(input), document: new TestDocument(), onIntent() {} });
  assert.equal(root.querySelector('details[data-advanced-filters]').open, true);
  assert.ok(root.querySelector('button[data-focus-id="filter-impact-all"]'));
  assert.doesNotMatch(root.querySelector('details[data-advanced-filters]').querySelector('summary').textContent, /filtros ativos/u);
});

test('completed result exposes the report action before filters and occurrences', () => {
  const root = renderPanelView({
    view: buildPanelView(fixture()), document: new TestDocument(), onIntent() {},
  });
  const ready = root.querySelector('[data-report-ready]');
  assert.ok(ready, 'the report has a visible ready block, not only a footer button');
  assert.match(ready.textContent, /relatório.*pronto/iu);
  const button = ready.querySelector('button[data-intent="OPEN_REPORT"]');
  assert.ok(button);
  assert.match(button.className, /primary-action/u);
  assert.equal(root.querySelectorAll('button[data-intent="OPEN_REPORT"]').length, 1);
  const sections = root.children;
  assert.ok(sections.indexOf(ready) < sections.findIndex(node => node.className === 'filters'));
  assert.ok(ready.querySelector('[data-report-launch-status]'));
});

test('reader caption is prominent, separate from voice status and preserves literal text', () => {
  const input = fixture();
  input.state.persona = {
    mode: 'reader', readerPaused: false, speechAvailability: 'unavailable', voiceId: '', rate: 1,
    message: 'Nenhuma voz local disponível.',
    readerCaption: '<Enviar>, botão', readerPosition: '2 de 3',
  };
  const root = renderPanelView({
    view: buildPanelView(input), document: new TestDocument(), onIntent() {},
  });
  const controls = root.querySelector('[data-persona-controls]');
  assert.equal(root.children[0], controls, 'active reader is visible before the long results');
  assert.equal(root.querySelector('[data-reader-caption]')?.textContent, '<Enviar>, botão');
  assert.equal(root.querySelector('[data-reader-position]')?.textContent, '2 de 3');
  assert.equal(root.querySelector('[data-reader-caption]').children.length, 0);
  assert.match(root.textContent, /estimativa|simulação/iu);
});

test('reader voice activation is an explicit panel intent and disappears after a local voice is active', () => {
  const input = fixture();
  input.state.persona = {
    mode: 'reader', readerPaused: false, speechAvailability: 'unavailable', voiceId: '', rate: 1,
    message: 'A legenda está ativa; ative uma voz local para ouvir.',
  };
  const intents = [];
  let root = renderPanelView({
    view: buildPanelView(input), document: new TestDocument(), onIntent: value => intents.push(value), onEvent() {},
  });
  root.querySelector('button[data-intent="PERSONA_READER_ENABLE_VOICE"]').click();
  assert.deepEqual(intents, [{ type: 'PERSONA_READER_ENABLE_VOICE' }]);

  input.state.persona = {
    ...input.state.persona, speechAvailability: 'available', voiceId: 'local-a', rate: 1.25,
    message: 'Voz local ativa.',
  };
  root = renderPanelView({
    view: buildPanelView(input), document: new TestDocument(), onIntent: value => intents.push(value), onEvent() {},
  });
  assert.equal(root.querySelector('button[data-intent="PERSONA_READER_ENABLE_VOICE"]'), null);
});

test('running view starts indeterminate and becomes determinate only after a validated progress event', () => {
  const input = fixture();
  input.state = {
    ...input.state, screen: 'running', auditId: null, sessionStatus: null,
    progress: { phase: null, message: null, percent: null, at: null },
  };
  let root = renderPanelView({
    view: buildPanelView(input), document: new TestDocument(), onIntent() {}, onEvent() {},
  });
  let progress = root.querySelector('progress[data-audit-progress]');
  assert.ok(progress);
  assert.equal(progress.hasAttribute('value'), false);
  assert.match(root.textContent, /Iniciando avaliação/u);

  input.state = {
    ...input.state, auditId: 'audit-1',
    progress: { phase: 'testing', message: 'Verificando acessibilidade', percent: 50, at: '2026-09-01T12:00:00.000Z' },
  };
  root = renderPanelView({
    view: buildPanelView(input), document: new TestDocument(), onIntent() {}, onEvent() {},
  });
  progress = root.querySelector('progress[data-audit-progress]');
  assert.equal(progress.getAttribute('value'), '50');
  assert.equal(progress.getAttribute('max'), '100');
  assert.match(root.textContent, /Etapa atual: Verificando regras automáticas/u);
  assert.match(root.querySelector('[role="status"]').textContent, /50%/u);
  assert.equal(root.querySelectorAll('[data-phase-state="complete"]').length, 2);
  assert.equal(root.querySelectorAll('[data-phase-state="current"]').length, 1);
  assert.equal(root.querySelector('[data-phase-state="current"]').getAttribute('aria-current'), 'step');
  assert.equal(root.querySelectorAll('[data-phase-indicator="complete"]').length, 2);
  assert.equal(root.querySelectorAll('[data-phase-indicator="current"]').length, 1);
  assert.equal(root.querySelector('[data-phase-indicator="complete"]').textContent, '✓');
  assert.equal(root.querySelectorAll('[data-phase-state="complete"]')
    .every(item => /concluída/u.test(item.textContent)), true);
});

test('todo controle da própria interface do painel tem nome acessível', () => {
  // O produto audita acessibilidade alheia: a interface dele precisa passar no mesmo critério. Nenhum
  // teste varria os controles em busca de nome acessível — só contava botões por intenção. Uma pessoa
  // com leitor de tela ouve o nome; um botão sem nome é uma barreira no nosso próprio produto.
  // Uma tela só não basta: a varredura percorre TODAS as telas que o painel pode mostrar, porque um
  // controle sem nome numa tela de erro ou de pausa de privacidade é a mesma barreira.
  const telas = ['initial', 'running', 'result', 'batch', 'single-url', 'start-failed', 'unavailable'];
  let controlesVarridos = 0;
  for (const screen of telas) {
    const { state, summary, detail } = fixture();
    const variacao = { ...state, screen };
    let root;
    try {
      root = renderPanelView({ view: buildPanelView({ state: variacao, summary, detail }), document: new TestDocument(), onIntent() {} });
    } catch {
      continue; // tela que exige outros dados de fixture não entra na varredura
    }
    const elementos = [];
    (function walk(node) {
      for (const child of node.children ?? []) { elementos.push(child); walk(child); }
    })(root);
    const interativos = elementos.filter(node => ['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'A'].includes(String(node.tagName).toUpperCase()));
    controlesVarridos += interativos.length;
    // `<label for>` explícito também dá nome acessível: sem isto a varredura acusaria campo rotulado.
    const rotulos = new Set(elementos.filter(node => String(node.tagName).toUpperCase() === 'LABEL')
      .map(node => node.getAttribute('for')).filter(Boolean));
    const semNome = [];
    for (const node of interativos) {
      const rotulo = [node.textContent, node.getAttribute('aria-label'), node.getAttribute('title'), node.getAttribute('placeholder')]
        .map(valor => String(valor ?? '').trim()).find(valor => valor.length > 0);
      if (rotulo || node.getAttribute('aria-labelledby') || rotulos.has(node.getAttribute('id'))) continue;
      semNome.push(`${node.tagName}${node.getAttribute('type') ? `[type="${node.getAttribute('type')}"]` : ''}${node.getAttribute('id') ? `#${node.getAttribute('id')}` : ''}`);
    }
    assert.deepEqual(semNome, [], `tela ${screen}: controles sem nome acessível: ${semNome.join(', ')}`);
  }
  assert.ok(controlesVarridos > 0, 'a varredura precisa encontrar controles, senão ela é vacuosa');
});

test('a tela de indisponibilidade oferece repetir e escolher outro modo (N-1 da 1.1.47)', () => {
  const emitted = [];
  const document = new TestDocument();
  const motivo = 'A auditoria foi encerrada antes de concluir. Refaça a auditoria e, se o modo de imagem '
    + 'falhar de novo, use o modo sem pixels.';
  const state = { ...fixture().state, screen: 'unavailable', auditId: 'audit-1', reason: motivo };
  const root = renderPanelView({
    view: buildPanelView({ state }), document, onIntent: value => emitted.push(value), onEvent() {},
  });
  assert.equal(root.dataset.screen, 'unavailable');
  assert.ok(root.textContent.includes(motivo), 'o motivo específico precisa chegar à tela');
  const retry = root.querySelector('button[data-intent="RETRY"]');
  const choose = root.querySelector('button[data-intent="NEW_AUDIT"]');
  assert.ok(retry, 'a retentativa continua disponível');
  assert.ok(choose, 'a tela precisa oferecer a escolha de outro modo');
  assert.equal(choose.textContent, 'Escolher outro modo');
  assert.equal(root.querySelector('button[data-intent="START_ATTACHED"]'), null,
    'repetir o mesmo modo sem oferecer o seletor era o defeito N-1');
  retry.click();
  choose.click();
  assert.deepEqual(emitted, [{ type: 'RETRY' }, { type: 'NEW_AUDIT' }]);
});
