import assert from 'node:assert/strict';
import test from 'node:test';

import { collectPage } from '../../src/browser/collect-page.js';
import { collectRuntimePageData } from '../../src/collector/page-collector.js';
import { detectAccessibilityWidgets, normalizeSnapshot, runCoreAudit } from '../../src/core/index.js';

const NEW_WINDOW_RULE = 'new-window-link-warning';
const LINK_RULES = Object.freeze([
  'link-semantics', 'link-purpose-as-link', 'link-purpose-without-context',
  'link-purpose-in-context', 'new-window-link-warning',
]);
const WARNING = 'abre em nova aba';

class FakeElement {
  constructor(localName, { attributes = {}, innerText = '', style = {}, rect = null } = {}) {
    this.nodeType = 1;
    this.localName = localName;
    this.attributesMap = { ...attributes };
    this.innerText = innerText;
    this.styleState = {
      display: 'inline', visibility: 'visible', opacity: '1',
      'background-image': 'none', 'background-color': 'rgb(255, 255, 255)',
      ...style,
    };
    this.rectState = rect ?? { x: 0, y: 0, width: 80, height: 20 };
    this.id = attributes.id ?? '';
    this.className = attributes.class ?? '';
    this.children = [];
    this.childNodes = [];
    this.parentElement = null;
    this.previousSibling = null;
    this.nextSibling = null;
    this.previousElementSibling = null;
    this.nextElementSibling = null;
    this.shadowRoot = null;
    this.disabled = false;
  }

  getAttribute(name) { return Object.hasOwn(this.attributesMap, name) ? this.attributesMap[name] : null; }
  hasAttribute(name) { return Object.hasOwn(this.attributesMap, name); }
  getRootNode() { return globalThis.document; }
  getBoundingClientRect() { return this.rectState; }
  getAnimations() { return []; }
  matches(selector) {
    return (this.localName === 'a' && this.hasAttribute('href') && selector.includes('a[href]')) ||
      (this.hasAttribute('contenteditable') && selector.includes('[contenteditable="true"]'));
  }
}

class FakeText {
  constructor(nodeValue) {
    this.nodeType = 3;
    this.nodeValue = nodeValue;
    this.parentElement = null;
    this.previousSibling = null;
    this.nextSibling = null;
  }
}

function append(parent, ...nodes) {
  parent.childNodes = nodes;
  parent.children = nodes.filter(node => node instanceof FakeElement);
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    node.parentElement = parent;
    node.previousSibling = nodes[index - 1] ?? null;
    node.nextSibling = nodes[index + 1] ?? null;
  }
  for (let index = 0; index < parent.children.length; index += 1) {
    const element = parent.children[index];
    element.previousElementSibling = parent.children[index - 1] ?? null;
    element.nextElementSibling = parent.children[index + 1] ?? null;
  }
}

function adjacentNode(kind) {
  if (kind === 'direct-text') return new FakeText(` (${WARNING}) `);
  const options = { innerText: ` (${WARNING}) ` };
  if (kind === 'hidden') options.attributes = { hidden: '' };
  if (kind === 'aria-hidden') options.attributes = { 'aria-hidden': 'true' };
  if (kind === 'inert') options.attributes = { inert: '' };
  if (kind === 'display-none') options.style = { display: 'none' };
  if (kind === 'visibility-hidden') options.style = { visibility: 'hidden' };
  if (kind === 'sr-only') {
    options.style = { position: 'absolute' };
    options.rect = { x: -10_000, y: 0, width: 1, height: 1 };
  }
  return new FakeElement('span', options);
}

function fixture(kind, {
  privateAncestor = false, privateSource = false, hostile = false,
  anchorWithoutHref = false, roleLink = false,
} = {}) {
  const parent = new FakeElement('div', {
    attributes: privateAncestor ? { contenteditable: 'true' } : {},
    innerText: privateAncestor ? `PRIVATE-ANCESTOR-SENTINEL ${WARNING}` : '',
  });
  const link = new FakeElement(roleLink ? 'div' : 'a', {
    attributes: {
      ...(anchorWithoutHref ? { id: 'section' } : roleLink ? { role: 'link', target: '_blank' } : { href: '/ajuda', target: '_blank' }),
      ...(privateSource ? { contenteditable: 'true' } : {}),
    },
    innerText: privateSource ? 'PRIVATE-SOURCE-SENTINEL' : 'Ajuda',
  });
  const adjacent = adjacentNode(kind === 'beyond-cap' ? 'direct-text' : kind);
  const adjacentNodes = kind === 'beyond-cap'
    ? [new FakeText(' '), new FakeText(' '), new FakeText(' '), new FakeText(' '), adjacent]
    : [adjacent];
  append(parent, link, ...adjacentNodes);
  if (hostile) {
    Object.defineProperty(link, 'nextSibling', {
      configurable: true,
      get() { throw new Error('PRIVATE-HOSTILE-SENTINEL'); },
    });
    Object.defineProperty(link, 'nextElementSibling', {
      configurable: true,
      get() { throw new Error('PRIVATE-HOSTILE-SENTINEL'); },
    });
  }
  return { parent, link, adjacent };
}

function installCollectorWorld(root, callback, extraGlobals = {}) {
  const names = [
    'Node', 'Element', 'ShadowRoot', 'HTMLInputElement', 'HTMLSelectElement', 'HTMLTextAreaElement',
    'HTMLMediaElement', 'HTMLAudioElement', 'HTMLImageElement', 'HTMLCanvasElement', 'CSS', 'document',
    'getComputedStyle', 'location', 'innerWidth', 'innerHeight', 'scrollX', 'scrollY', 'matchMedia',
    ...Object.keys(extraGlobals),
  ];
  const saved = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  try {
    Object.assign(globalThis, {
      Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 }, Element: FakeElement, ShadowRoot: class {},
      HTMLInputElement: class {}, HTMLSelectElement: class {}, HTMLTextAreaElement: class {},
      HTMLMediaElement: class {}, HTMLAudioElement: class {}, HTMLImageElement: class {}, HTMLCanvasElement: class {},
      CSS: { escape: value => value }, document: { baseURI: 'https://example.test/', children: [root], activeElement: null },
      getComputedStyle: element => ({
        ...element.styleState,
        getPropertyValue: name => element.styleState?.[name] ?? '',
      }),
      location: { href: 'https://example.test/' }, innerWidth: 800, innerHeight: 600,
      scrollX: 0, scrollY: 0, matchMedia: () => ({ matches: false }), ...extraGlobals,
    });
    return callback();
  } finally {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
}

async function collectNormalizeAndEvaluate(kind, options = {}) {
  const graph = fixture(kind, options);
  const collected = installCollectorWorld(graph.parent, () => collectRuntimePageData());
  const elements = [graph.parent, graph.link, ...(graph.adjacent instanceof FakeElement ? [graph.adjacent] : [])];
  const backendId = new Map(elements.map((element, index) => [element, index + 1]));
  const nodes = collected.nodes.map((record, index) => ({
    ...record,
    backendNodeId: index + 1,
    attributes: { ...elements[index].attributesMap },
    parentBackendNodeId: elements[index].parentElement ? backendId.get(elements[index].parentElement) : null,
  }));
  const raw = {
    format: 'simplified-v1',
    document: { url: 'https://example.test/', title: 'Adjacência', language: 'pt-BR' },
    nodes,
    // A plain anchor without href has no link role in Chrome's AX tree.
    axTree: { nodes: options.anchorWithoutHref ? [] : [{ backendDOMNodeId: backendId.get(graph.link), role: { value: 'link' }, name: { value: 'Ajuda' } }] },
  };
  const normalized = normalizeSnapshot(raw);
  const audit = await runCoreAudit(normalized);
  return {
    collected, normalized, audit,
    linkNodeId: `n-${backendId.get(graph.link)}`,
    result: audit.ruleResults.find(rule => rule.ruleId === NEW_WINDOW_RULE),
  };
}

test('collector→normalizer→rule accepts direct text and sr-only accessible warnings', async () => {
  for (const kind of ['direct-text', 'sr-only']) {
    const { result } = await collectNormalizeAndEvaluate(kind);
    assert.equal(result.outcome, 'passed', kind);
    assert.doesNotMatch(JSON.stringify(result), /abre em nova aba/iu);
  }
});

test('collector→normalizer→rule rejects inaccessible adjacent warnings as observed absence', async () => {
  for (const kind of ['hidden', 'aria-hidden', 'display-none', 'visibility-hidden', 'inert']) {
    const { result } = await collectNormalizeAndEvaluate(kind);
    assert.equal(result.outcome, 'failed', kind);
    assert.deepEqual(result.targets[0].data, { reason: 'missing-new-window-warning', behavior: 'target-blank' });
    assert.doesNotMatch(JSON.stringify(result), /abre em nova aba/iu);
  }
});

test('private links are excluded while hostile or truncated public adjacency stays incomplete', async () => {
  for (const [kind, options] of [
    ['direct-text', { privateAncestor: true }],
    ['direct-text', { privateSource: true }],
    ['direct-text', { hostile: true }],
    ['beyond-cap', {}],
  ]) {
    const { normalized, result } = await collectNormalizeAndEvaluate(kind, options);
    const expected = options.privateAncestor || options.privateSource ? 'inapplicable' : 'cantTell';
    assert.equal(result.outcome, expected, `${kind}: ${JSON.stringify(options)}`);
    const link = normalized.nodes.find(node => node.tagName === 'a');
    assert.equal(Object.hasOwn(link, 'adjacentNewWindowWarning'), false);
    assert.doesNotMatch(JSON.stringify([normalized, result]), /PRIVATE-|HOSTILE-SENTINEL/u);
  }
});

test('all 131 rules ignore anchors without href but still evaluate genuine native and ARIA links', async () => {
  const anchor = await collectNormalizeAndEvaluate('direct-text', { anchorWithoutHref: true });
  assert.equal(anchor.audit.ruleResults.length, 131);
  assert.equal(anchor.audit.itemResults.length, 146);
  const collectedAnchor = anchor.collected.nodes.find(node => node.tagName === 'a');
  const normalizedAnchor = anchor.normalized.nodes.find(node => node.tagName === 'a');
  assert.equal(Object.hasOwn(collectedAnchor, 'interaction'), false);
  assert.equal(Object.hasOwn(normalizedAnchor, 'interaction'), false);
  for (const ruleId of LINK_RULES) {
    assert.equal(anchor.audit.ruleResults.find(rule => rule.ruleId === ruleId).outcome, 'inapplicable', ruleId);
  }
  assert.equal(anchor.audit.ruleResults.some(rule =>
    rule.outcome === 'failed' && rule.targets.some(target => target.nodeId === anchor.linkNodeId)), false);

  for (const options of [{}, { roleLink: true }]) {
    const legitimate = await collectNormalizeAndEvaluate('direct-text', options);
    assert.equal(legitimate.audit.ruleResults.length, 131);
    assert.equal(legitimate.audit.ruleResults.find(rule => rule.ruleId === 'link-semantics').outcome, 'passed');
    assert.equal(legitimate.result.outcome, 'passed');
  }
});

test('private text does not create link failures or erase an independently observed structural role', async () => {
  for (const options of [
    { privateSource: true },
    { privateAncestor: true },
    { privateAncestor: true, hostile: true },
  ]) {
    const value = await collectNormalizeAndEvaluate('direct-text', options);
    assert.equal(value.audit.ruleResults.length, 131);
    assert.equal(value.audit.itemResults.length, 146);
    const collectedLink = value.collected.nodes.find(node => node.tagName === 'a');
    const normalizedLink = value.normalized.nodes.find(node => node.tagName === 'a');
    assert.equal(Object.hasOwn(collectedLink, 'interaction'), false);
    assert.equal(Object.hasOwn(normalizedLink, 'interaction'), false);
    assert.equal(normalizedLink.axRole, 'link');
    const expected = {
      'link-semantics': 'passed',
      'link-purpose-as-link': 'cantTell',
      'link-purpose-without-context': 'cantTell',
      'link-purpose-in-context': 'cantTell',
      'new-window-link-warning': 'inapplicable',
    };
    for (const ruleId of LINK_RULES) {
      assert.equal(value.audit.ruleResults.find(rule => rule.ruleId === ruleId).outcome, expected[ruleId], `${ruleId}: ${JSON.stringify(options)}`);
    }
    assert.equal(value.audit.ruleResults.some(rule =>
      rule.outcome === 'failed' && rule.targets.some(target => target.nodeId === value.linkNodeId)), false);
    assert.doesNotMatch(JSON.stringify([value.normalized, value.audit]), /PRIVATE-|HOSTILE-SENTINEL/u);
  }
});

test('isolated-world collection cannot turn a page global into a completed widget signal', async () => {
  const graph = fixture('direct-text');
  let reads = 0;
  const pageGlobal = {};
  Object.defineProperty(pageGlobal, 'privateValue', {
    enumerable: true,
    get() { reads += 1; return 'PRIVATE-GLOBAL-SENTINEL'; },
  });
  const collected = installCollectorWorld(
    graph.parent,
    () => collectRuntimePageData(),
    { VLibras: pageGlobal },
  );
  assert.equal(Object.hasOwn(collected.widgetSignals.vlibras, 'global'), false);
  assert.equal(reads, 0);

  const cdp = { command: async method => {
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'root', url: 'https://example.test/' } } };
    if (method === 'DOMSnapshot.captureSnapshot') return { strings: [], documents: [] };
    if (method === 'Accessibility.getFullAXTree') return { nodes: [] };
    if (method === 'Page.getLayoutMetrics') return { cssContentSize: { width: 1, height: 1 } };
    return {};
  } };
  const raw = await collectPage(cdp, 42, {
    executeScript: async () => [{ frameId: 'root', result: collected }],
  });
  assert.equal(raw.widgetObservations.coverage, 'unavailable');
  const inventory = detectAccessibilityWidgets({
    coverage: raw.widgetObservations.coverage,
    widgets: raw.widgetObservations.widgets,
  });
  assert.equal(inventory.widgets[0].status, 'unknown');
  assert.doesNotMatch(JSON.stringify([raw.widgetObservations, inventory]), /PRIVATE-|globalValue/iu);
});
