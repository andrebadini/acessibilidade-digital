import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import test from 'node:test';

import {
  canonicalPath,
  createStructuralSignatureV1,
  parseCssSelectorV1,
  roleForStructuralSignature,
} from '../../src/background/highlight-locator.js';
import { runAuditaHighlightCommand } from '../../src/browser/highlight-overlay.js';

const FAILED_NONCE = 'F'.repeat(22);
const MANUAL_NONCE = 'M'.repeat(22);

class FixtureElement {
  constructor(tag, attributes = {}, ownerDocument = null) {
    this.tagName = String(tag).toUpperCase();
    this.attributes = { ...attributes };
    this.className = this.attributes.class ?? '';
    this.style = {};
    this.parentElement = null;
    this.parentNode = null;
    this.children = [];
    this.ownerDocument = ownerDocument;
    this.tabIndex = 0;
    this._textContent = '';
    this._rect = { left: 40, top: 70, width: 180, height: 36, right: 220, bottom: 106 };
    this.scrollCalls = [];
    this.focusCalls = 0;
  }

  appendChild(child) {
    child.parentElement = this;
    child.parentNode = this;
    child.ownerDocument = this.ownerDocument;
    this.children.push(child);
    return child;
  }

  append(...children) {
    for (const child of children) this.appendChild(child);
    return children.at(-1);
  }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index < 0) throw new Error('fixture child absent');
    this.children.splice(index, 1);
    child.parentElement = null;
    child.parentNode = null;
    return child;
  }

  remove() {
    if (this.parentNode && typeof this.parentNode.removeChild === 'function') this.parentNode.removeChild(this);
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === 'class') this.className = String(value);
  }

  getAttribute(name) {
    return Object.hasOwn(this.attributes, name) ? String(this.attributes[name]) : null;
  }

  getRootNode() {
    let current = this;
    const seen = new Set();
    while (current.parentNode) {
      if (seen.has(current)) return current;
      seen.add(current);
      current = current.parentNode;
    }
    return current;
  }

  get isConnected() {
    return this.getRootNode()?.nodeType === 9;
  }

  set textContent(value) {
    this._textContent = String(value);
    this.children = [];
  }

  get textContent() {
    return `${this._textContent}${this.children.map(child => child.textContent).join('')}`;
  }

  getBoundingClientRect() {
    return { ...this._rect };
  }

  setRect(rect) {
    this._rect = {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
    };
  }

  scrollIntoView(options) {
    this.scrollCalls.push(structuredClone(options));
  }

  focus() {
    this.focusCalls += 1;
    if (this.ownerDocument) this.ownerDocument.activeElement = this;
  }

  matches(selector) {
    return fixtureSegmentMatches(this, selector);
  }
}

class FixtureDocument {
  constructor() {
    this.nodeType = 9;
    this.children = [];
    this.parentElement = null;
    this.parentNode = null;
    this.activeElement = null;
    this.selector = null;
    this.selection = [];
    this.selectorQueryCalls = 0;
    this.created = [];
    this.documentElement = null;
  }

  append(...children) {
    for (const child of children) {
      child.parentElement = null;
      child.parentNode = this;
      child.ownerDocument = this;
      this.children.push(child);
    }
    if (!this.documentElement) this.documentElement = children[0] ?? null;
    return children.at(-1);
  }

  createElement(tag) {
    const element = new FixtureElement(tag, {}, this);
    this.created.push(element);
    return element;
  }

  querySelectorAll(selector) {
    if (selector === this.selector) {
      this.selectorQueryCalls += 1;
      return [...this.selection];
    }
    if (selector === '[data-audita-highlight-root]') return rootsWithin(this.documentElement);
    return fixtureQuery(this, selector);
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

function fixtureSegmentMatches(element, source) {
  let segment = source;
  let nth = null;
  const nthMatch = segment.match(/:nth-of-type\(([1-9]\d*)\)$/u);
  if (nthMatch) {
    nth = Number(nthMatch[1]);
    segment = segment.slice(0, -nthMatch[0].length);
  }
  let attribute = null;
  const attributeMatch = segment.match(/\[(role|type)="([a-z]+)"\]$/u);
  if (attributeMatch) {
    attribute = { name: attributeMatch[1], value: attributeMatch[2] };
    segment = segment.slice(0, -attributeMatch[0].length);
  }
  const tagMatch = segment.match(/^[a-z][a-z0-9-]*/u);
  if (!tagMatch || element.tagName.toLowerCase() !== tagMatch[0]) return false;
  segment = segment.slice(tagMatch[0].length);
  const idMatch = segment.match(/^#(-?[_A-Za-z][_A-Za-z0-9-]*)/u);
  if (idMatch) {
    if (element.getAttribute('id') !== idMatch[1]) return false;
    segment = segment.slice(idMatch[0].length);
  }
  while (segment.startsWith('.')) {
    const classMatch = segment.match(/^\.(-?[_A-Za-z][_A-Za-z0-9-]*)/u);
    if (!classMatch) return false;
    const classTokens = (element.getAttribute('class') ?? '').split(/[\t\n\f\r ]+/u).filter(Boolean);
    if (!classTokens.includes(classMatch[1])) return false;
    segment = segment.slice(classMatch[0].length);
  }
  if (segment !== '' || (attribute && element.getAttribute(attribute.name) !== attribute.value)) return false;
  if (nth !== null) {
    const parent = element.parentElement ?? element.parentNode;
    const siblings = (parent?.children ?? []).filter(child => child.tagName === element.tagName);
    if (siblings.indexOf(element) + 1 !== nth) return false;
  }
  return true;
}

function fixtureQuery(scopeRoot, selector) {
  const segments = selector.split(' > ');
  const descendants = [];
  const visit = node => {
    for (const child of node.children ?? []) {
      descendants.push(child);
      visit(child);
    }
  };
  visit(scopeRoot);
  return descendants.filter(candidate => {
    let current = candidate;
    for (let index = segments.length - 1; index >= 0; index -= 1) {
      if (!current || !fixtureSegmentMatches(current, segments[index])) return false;
      if (index > 0) current = current.parentElement;
    }
    return true;
  });
}

function rootsWithin(node) {
  const roots = [];
  const visit = current => {
    if (!current) return;
    if (current.getAttribute?.('data-audita-highlight-root') !== null) roots.push(current);
    for (const child of current.children ?? []) visit(child);
  };
  visit(node);
  return roots;
}

function createEnvironment({ tag = 'button', attributes = { id: 'action', class: 'primary', role: 'button' } } = {}) {
  const document = new FixtureDocument();
  const html = document.append(new FixtureElement('html', {}, document));
  const body = html.append(new FixtureElement('body', {}, document));
  const main = body.append(new FixtureElement('main', {}, document));
  const target = main.append(new FixtureElement(tag, attributes, document));
  const priorFocus = main.append(new FixtureElement('a', { href: '/before' }, document));
  document.activeElement = priorFocus;

  const listeners = new Map();
  const frames = new Map();
  const observers = new Set();
  const messages = [];
  let nextFrame = 1;

  const environment = {
    document,
    innerWidth: 1024,
    innerHeight: 768,
    crypto: webcrypto,
    chrome: {
      runtime: {
        sendMessage(message) {
          messages.push(structuredClone(message));
          return Promise.resolve({ ok: true });
        },
      },
    },
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    requestAnimationFrame(callback) {
      const frame = nextFrame;
      nextFrame += 1;
      frames.set(frame, callback);
      return frame;
    },
    cancelAnimationFrame(frame) {
      frames.delete(frame);
    },
    MutationObserver: class FixtureMutationObserver {
      constructor(callback) {
        this.callback = callback;
        this.active = false;
      }

      observe() {
        this.active = true;
        observers.add(this);
      }

      disconnect() {
        this.active = false;
        observers.delete(this);
      }
    },
  };

  environment.dispatch = (type, event = {}) => {
    for (const listener of [...(listeners.get(type) ?? [])]) listener(event);
  };
  environment.dispatchKey = key => environment.dispatch('keydown', { key });
  environment.flushAnimationFrames = () => {
    const pending = [...frames.entries()];
    frames.clear();
    for (const [, callback] of pending) callback(16);
  };
  environment.triggerMutations = (records = []) => {
    for (const observer of [...observers]) observer.callback(records, observer);
  };
  environment.listenerCounts = () => Object.fromEntries(
    ['scroll', 'resize', 'keydown', 'pagehide'].map(type => [type, listeners.get(type)?.size ?? 0]),
  );
  environment.activeObserverCount = () => observers.size;
  environment.pendingFrameCount = () => frames.size;
  environment.messages = messages;

  return { environment, document, html, body, main, target, priorFocus };
}

async function installCommand(fixture, overrides = {}) {
  const located = canonicalPath(fixture.target, { scopeRoot: fixture.document, maxSegments: 16 });
  const selector = {
    syntax: located.syntax,
    value: located.value,
    byteLength: located.byteLength,
    complexity: located.complexity,
  };
  fixture.document.selector = selector.value;
  fixture.document.selection = [fixture.target];
  const structuralSignature = await createStructuralSignatureV1({
    documentId: 'doc-main',
    frameId: 0,
    element: fixture.target,
    scopeRoot: fixture.document,
    subtle: webcrypto.subtle,
  });
  return {
    version: 1,
    op: 'install',
    nonce: FAILED_NONCE,
    documentId: 'doc-main',
    frameId: 0,
    selector,
    structuralSignature,
    kind: 'failed',
    markerNumber: 17,
    ...overrides,
  };
}

function mutateAfterCanonicalDigest(fixture, mutation) {
  let mutated = false;
  fixture.environment.crypto = {
    subtle: {
      async digest(algorithm, bytes) {
        const result = await webcrypto.subtle.digest(algorithm, bytes);
        if (!mutated && new TextDecoder().decode(bytes).includes('StructuralSignatureInputV1')) {
          mutated = true;
          mutation();
        }
        return result;
      },
    },
  };
}

function gateCanonicalDigest(fixture) {
  let canonicalCalls = 0;
  let releaseDigest;
  let announceFirst;
  const released = new Promise(resolve => { releaseDigest = resolve; });
  const firstCanonical = new Promise(resolve => { announceFirst = resolve; });
  fixture.environment.crypto = {
    subtle: {
      async digest(algorithm, bytes) {
        if (new TextDecoder().decode(bytes).includes('StructuralSignatureInputV1')) {
          canonicalCalls += 1;
          if (canonicalCalls === 1) announceFirst();
          await released;
        }
        return webcrypto.subtle.digest(algorithm, bytes);
      },
    },
  };
  return {
    firstCanonical,
    release() { releaseDigest(); },
    canonicalCalls: () => canonicalCalls,
  };
}

function installComputedStyleModel(fixture) {
  const overrides = new Map();
  const color = value => ({
    transparent: 'rgba(0, 0, 0, 0)',
    '#8b1e1e': 'rgb(139, 30, 30)',
    '#6b4e00': 'rgb(107, 78, 0)',
    '#ffffff': 'rgb(255, 255, 255)',
  })[value] ?? value;
  fixture.environment.matchMedia = () => ({ matches: false });
  fixture.environment.getComputedStyle = element => ({
    display: element.style.display,
    visibility: element.style.visibility,
    opacity: element.style.opacity,
    pointerEvents: element.style.pointerEvents,
    position: element.style.position,
    boxSizing: element.style.boxSizing,
    zIndex: element.style.zIndex,
    backgroundColor: color(element.style.background),
    outlineStyle: element.style.outline?.includes(' solid ') ? 'solid' : 'none',
    outlineWidth: element.style.outline?.split(' ')[0] ?? '0px',
    outlineOffset: element.style.outlineOffset ?? '0px',
    borderWidth: element.style.borderWidth ?? '0px',
    borderStyle: element.style.borderStyle ?? 'none',
    borderColor: color(element.style.borderColor ?? ''),
    borderRadius: element.style.borderRadius ?? '0px',
    boxShadow: element.style.boxShadow ?? 'none',
    width: element.style.width,
    height: element.style.height,
    ...(overrides.get(element) ?? {}),
  });
  return overrides;
}

function authorSnapshot(target) {
  return {
    attributes: Object.entries(target.attributes).sort(([left], [right]) => left.localeCompare(right)),
    className: target.className,
    inlineStyle: { ...target.style },
    activeElement: target.ownerDocument.activeElement,
  };
}

function assertDisposed(fixture) {
  assert.equal(fixture.document.querySelector('[data-audita-highlight-root]'), null);
  assert.deepEqual(fixture.environment.listenerCounts(), { scroll: 0, resize: 0, keydown: 0, pagehide: 0 });
  assert.equal(fixture.environment.activeObserverCount(), 0);
  assert.equal(fixture.environment.pendingFrameCount(), 0);
  assert.equal(Object.hasOwn(fixture.environment, '__auditaHighlightOverlayV1'), false);
}

test('creates the required failure treatment without mutating or focusing the target', async () => {
  const fixture = createEnvironment();
  const command = await installCommand(fixture);
  const before = authorSnapshot(fixture.target);

  assert.deepEqual(await runAuditaHighlightCommand(command, fixture.environment), {
    ok: true,
    nonce: FAILED_NONCE,
  });

  const root = fixture.document.querySelector('[data-audita-highlight-root]');
  assert.ok(root);
  assert.equal(root.parentNode, fixture.document.documentElement);
  assert.equal(root.style.position, 'fixed');
  assert.equal(root.style.display, 'block');
  assert.equal(root.style.visibility, 'visible');
  assert.equal(root.style.opacity, '1');
  assert.equal(root.style.pointerEvents, 'none');
  assert.equal(root.style.borderWidth, '3px');
  assert.equal(root.style.borderStyle, 'solid');
  assert.equal(root.style.borderColor, 'rgb(139, 30, 30)');
  assert.equal(root.style.borderRadius, '3px');
  assert.equal(root.style.boxShadow,
    'inset 0 0 0 1px #ffffff, 0 0 0 1px #ffffff, 0 0 0 4px rgba(139, 30, 30, 0.35)');
  assert.match(root.style.outline, /CanvasText/u);
  assert.equal(root.getAttribute('aria-hidden'), 'true');
  assert.equal(root.tabIndex, -1);
  assert.equal(root.children.length, 2);
  assert.deepEqual(root.children.map(child => child.tagName), ['SPAN', 'SPAN']);
  assert.match(root.textContent, /^×Falha confirmada$/u);
  assert.deepEqual(fixture.target.scrollCalls, [{ block: 'center', inline: 'nearest' }]);
  assert.equal(fixture.target.focusCalls, 0);
  assert.deepEqual(authorSnapshot(fixture.target), before);
  assert.deepEqual(fixture.environment.listenerCounts(), { scroll: 1, resize: 1, keydown: 1, pagehide: 1 });
  assert.equal(fixture.environment.activeObserverCount(), 1);
  assert.equal(fixture.document.selectorQueryCalls, 2);
});

test('creates the distinct manual-review treatment with only fixed local text', async () => {
  const fixture = createEnvironment();
  const command = await installCommand(fixture, {
    nonce: MANUAL_NONCE,
    kind: 'manual',
    markerNumber: 5_000,
  });

  assert.deepEqual(await runAuditaHighlightCommand(command, fixture.environment), {
    ok: true,
    nonce: MANUAL_NONCE,
  });
  const root = fixture.document.querySelector('[data-audita-highlight-root]');
  assert.equal(root.style.borderWidth, '3px');
  assert.equal(root.style.borderStyle, 'dashed');
  assert.equal(root.style.borderColor, 'rgb(107, 78, 0)');
  assert.match(root.textContent, /^\?Revisão humana necessária$/u);
  assert.doesNotMatch(root.textContent, /action|primary|doc-main/iu);
});

test('rejects extra, inherited and malformed install data before querying or touching the DOM', async () => {
  const fixture = createEnvironment();
  const valid = await installCommand(fixture);
  const invalidCommands = [
    { ...valid, extra: true },
    Object.assign(Object.create({ inherited: true }), valid),
    { ...valid, nonce: 'short' },
    { ...valid, documentId: 'https://private.test/' },
    { ...valid, frameId: -1 },
    { ...valid, kind: 'warning' },
    { ...valid, markerNumber: 0 },
    { ...valid, markerNumber: 5_001 },
    { ...valid, selector: { ...valid.selector, extra: true } },
    { ...valid, selector: { ...valid.selector, complexity: valid.selector.complexity + 1 } },
    { ...valid, structuralSignature: { ...valid.structuralSignature, extra: true } },
    { ...valid, structuralSignature: { ...valid.structuralSignature, sha256: valid.structuralSignature.sha256.toUpperCase() } },
  ];

  for (const candidate of invalidCommands) {
    assert.deepEqual(await runAuditaHighlightCommand(candidate, fixture.environment), {
      ok: false,
      reason: 'invalid-command',
    });
  }
  assert.equal(fixture.document.selectorQueryCalls, 0);
  assert.equal(fixture.document.querySelector('[data-audita-highlight-root]'), null);
});

test('snapshots command descriptors without invoking value getters', async () => {
  const fixture = createEnvironment();
  const valid = await installCommand(fixture);
  let reads = 0;
  const proxy = new Proxy(valid, {
    get(target, key, receiver) {
      reads += 1;
      return Reflect.get(target, key, receiver);
    },
  });

  assert.deepEqual(await runAuditaHighlightCommand(proxy, fixture.environment), {
    ok: true,
    nonce: FAILED_NONCE,
  });
  assert.equal(reads, 0);
});

test('fails closed on non-unique targets, signature changes and an initially non-rendered target', async () => {
  const absent = createEnvironment();
  const absentCommand = await installCommand(absent);
  absent.document.selection = [];
  assert.deepEqual(await runAuditaHighlightCommand(absentCommand, absent.environment), {
    ok: false,
    reason: 'target-not-unique',
  });
  assert.equal(absent.document.selectorQueryCalls, 1);

  const duplicate = createEnvironment();
  const duplicateCommand = await installCommand(duplicate);
  duplicate.document.selection = [duplicate.target, new FixtureElement('button')];
  assert.deepEqual(await runAuditaHighlightCommand(duplicateCommand, duplicate.environment), {
    ok: false,
    reason: 'target-not-unique',
  });

  const changed = createEnvironment();
  const changedCommand = await installCommand(changed);
  changed.target.attributes.type = 'submit';
  assert.deepEqual(await runAuditaHighlightCommand(changedCommand, changed.environment), {
    ok: false,
    reason: 'signature-mismatch',
  });

  const zero = createEnvironment();
  const zeroCommand = await installCommand(zero);
  zero.target.setRect({ left: 0, top: 0, width: 0, height: 36 });
  assert.deepEqual(await runAuditaHighlightCommand(zeroCommand, zero.environment), {
    ok: false,
    reason: 'target-not-rendered',
  });
  assertDisposed(zero);
});

test('matches the locator role map and complete Web Crypto signature semantics', async () => {
  const cases = [
    ['button', { role: 'presentation link button' }],
    ['a', { href: '' }],
    ['area', { href: '/map' }],
    ['button', {}],
    ['input', { type: 'checkbox' }],
    ['input', { type: 'number' }],
    ['input', { type: 'radio' }],
    ['input', { type: 'range' }],
    ['input', { type: 'submit' }],
    ['input', { type: 'email' }],
    ['input', { type: 'date' }],
    ['textarea', {}],
    ['img', {}],
    ['nav', {}],
    ['main', {}],
    ['ol', {}],
    ['li', {}],
    ['h4', {}],
    ['dialog', {}],
    ['select', {}],
    ['div', {}],
  ];

  for (const [tag, attributes] of cases) {
    const fixture = createEnvironment({ tag, attributes });
    const command = await installCommand(fixture);
    assert.deepEqual(await runAuditaHighlightCommand(command, fixture.environment), {
      ok: true,
      nonce: FAILED_NONCE,
    }, `${tag}:${JSON.stringify(attributes)}:${String(roleForStructuralSignature(fixture.target))}`);
    assert.deepEqual(await runAuditaHighlightCommand({ version: 1, op: 'clear', nonce: FAILED_NONCE }, fixture.environment), {
      ok: true,
      nonce: FAILED_NONCE,
    });
  }
});

test('closes Web Crypto TOCTOU by revalidating uniqueness attributes href and ancestry before install', async () => {
  const cases = [
    {
      label: 'uniqueness',
      create: () => createEnvironment(),
      mutate(fixture) {
        fixture.document.selection = [fixture.target, new FixtureElement('button')];
      },
      reason: 'target-not-unique',
    },
    {
      label: 'role',
      create: () => createEnvironment({ tag: 'button', attributes: { role: 'presentation link button' } }),
      mutate(fixture) { fixture.target.attributes.role = 'presentation button'; },
      reason: 'signature-mismatch',
    },
    {
      label: 'type',
      create: () => createEnvironment({ tag: 'input', attributes: { type: 'date' } }),
      mutate(fixture) { fixture.target.attributes.type = 'month'; },
      reason: 'signature-mismatch',
    },
    {
      label: 'href',
      create: () => createEnvironment({ tag: 'a', attributes: { href: '/before' } }),
      mutate(fixture) { fixture.target.attributes.href = '/after'; },
      reason: 'signature-mismatch',
    },
    {
      label: 'ancestry',
      create: () => createEnvironment(),
      mutate(fixture) {
        fixture.main.removeChild(fixture.target);
        fixture.body.removeChild(fixture.main);
        const replacement = fixture.body.append(new FixtureElement('section', {}, fixture.document));
        replacement.append(fixture.target);
      },
      reason: 'signature-mismatch',
    },
  ];

  for (const entry of cases) {
    const fixture = entry.create();
    const command = await installCommand(fixture);
    mutateAfterCanonicalDigest(fixture, () => entry.mutate(fixture));
    assert.deepEqual(await runAuditaHighlightCommand(command, fixture.environment), {
      ok: false,
      reason: entry.reason,
    }, entry.label);
    assert.equal(fixture.document.querySelector('[data-audita-highlight-root]'), null, entry.label);
    assert.equal(Object.hasOwn(fixture.environment, '__auditaHighlightOverlayV1'), false, entry.label);
  }
});

test('updates fixed geometry through one scheduled frame on captured scroll and resize', async () => {
  const fixture = createEnvironment();
  const command = await installCommand(fixture);
  await runAuditaHighlightCommand(command, fixture.environment);
  const root = fixture.document.querySelector('[data-audita-highlight-root]');
  // The contour wraps the element from the outside: 3px border + 3px gap on each side.
  assert.deepEqual(
    { left: root.style.left, top: root.style.top, width: root.style.width, height: root.style.height },
    { left: '34px', top: '64px', width: '192px', height: '48px' },
  );

  fixture.target.setRect({ left: 11.5, top: 22.25, width: 205.75, height: 44.5 });
  fixture.environment.dispatch('scroll');
  fixture.environment.dispatch('resize');
  assert.equal(fixture.environment.pendingFrameCount(), 1);
  fixture.environment.flushAnimationFrames();
  assert.deepEqual(
    { left: root.style.left, top: root.style.top, width: root.style.width, height: root.style.height },
    { left: '5.5px', top: '16.25px', width: '217.75px', height: '56.5px' },
  );
});

test('the tab rides the contour top-left, flips under it at the viewport edge and never leaves the screen', async () => {
  // Room above: the tab's bottom edge sits on the contour's top edge.
  const above = createEnvironment();
  const aboveCommand = await installCommand(above);
  assert.deepEqual(await runAuditaHighlightCommand(aboveCommand, above.environment), { ok: true, nonce: FAILED_NONCE });
  const aboveRoot = above.document.querySelector('[data-audita-highlight-root]');
  const [aboveMarker, aboveLabel] = aboveRoot.children;
  assert.deepEqual({ left: aboveMarker.style.left, top: aboveMarker.style.top },
    { left: '-3px', top: '-27px' });
  assert.deepEqual({ left: aboveLabel.style.left, top: aboveLabel.style.top },
    { left: '24px', top: '-27px' });
  assert.equal(aboveMarker.style.borderRadius, '4px 0 0 0');
  assert.equal(aboveLabel.style.borderRadius, '0 4px 0 0');
  assert.equal(aboveMarker.style.height, '24px');
  assert.equal(aboveLabel.style.height, '24px');
  assert.equal(aboveMarker.style.border, '1px solid #ffffff');
  assert.equal(aboveMarker.style.background, 'rgb(139, 30, 30)');
  assert.equal(aboveMarker.style.color, '#ffffff');
  assert.equal(aboveMarker.textContent, '×');
  assert.equal(aboveLabel.textContent, 'Falha confirmada');

  // Less than 22px of room above: the tab hangs below the contour with the corners flipped.
  const below = createEnvironment();
  const belowCommand = await installCommand(below);
  below.target.setRect({ left: 40, top: 10, width: 180, height: 36 });
  assert.deepEqual(await runAuditaHighlightCommand(belowCommand, below.environment), { ok: true, nonce: FAILED_NONCE });
  const belowRoot = below.document.querySelector('[data-audita-highlight-root]');
  const [belowMarker, belowLabel] = belowRoot.children;
  assert.equal(belowRoot.style.top, '4px');
  // Contour top 4 + height 48 = 52, minus the padding-box origin at 4 + 3.
  assert.equal(belowMarker.style.top, '45px');
  assert.equal(belowMarker.style.borderRadius, '0 0 0 4px');
  assert.equal(belowLabel.style.borderRadius, '0 0 4px 0');

  // Off to the right: the tab is clamped inside the viewport instead of disappearing.
  const right = createEnvironment();
  const rightCommand = await installCommand(right);
  right.target.setRect({ left: 4_000, top: 700, width: 100, height: 40 });
  assert.deepEqual(await runAuditaHighlightCommand(rightCommand, right.environment), { ok: true, nonce: FAILED_NONCE });
  const rightRoot = right.document.querySelector('[data-audita-highlight-root]');
  const [rightMarker] = rightRoot.children;
  assert.equal(rightRoot.style.left, '3994px');
  assert.equal(Number.parseFloat(rightRoot.style.left) + 3 + Number.parseFloat(rightMarker.style.left),
    1024 - (28 + 140 - 1));
  assert.equal(rightMarker.style.top, '-27px');

  // Taller than the viewport and starting above the screen: the tab pins to the viewport top.
  const tall = createEnvironment();
  const tallCommand = await installCommand(tall);
  tall.target.setRect({ left: 100, top: -500, width: 200, height: 2_000 });
  assert.deepEqual(await runAuditaHighlightCommand(tallCommand, tall.environment), { ok: true, nonce: FAILED_NONCE });
  const tallRoot = tall.document.querySelector('[data-audita-highlight-root]');
  const [tallMarker] = tallRoot.children;
  assert.equal(tallRoot.style.top, '-506px');
  // The contour starts 506px above the viewport; the tab is pinned to viewport y=0 instead.
  assert.equal(tallMarker.style.top, '503px');
  assert.equal(tallMarker.style.left, '-3px');
  assert.equal(tallMarker.style.borderRadius, '4px 0 0 0');
});

// The strict grammar never emits these selectors, so the command is assembled by hand: the page has
// to accept what the eased grammar allows even though the exporter keeps refusing to produce it.
async function rawSelectorCommand(fixture, value, complexity) {
  fixture.document.selection = [fixture.target];
  return {
    version: 1,
    op: 'install',
    nonce: FAILED_NONCE,
    documentId: 'doc-main',
    frameId: 0,
    selector: {
      syntax: 'CSSSelectorV1',
      value,
      byteLength: new TextEncoder().encode(value).byteLength,
      complexity,
    },
    structuralSignature: await createStructuralSignatureV1({
      documentId: 'doc-main',
      frameId: 0,
      element: fixture.target,
      scopeRoot: fixture.document,
      subtle: webcrypto.subtle,
    }),
    kind: 'failed',
    markerNumber: 17,
  };
}

// Wraps the target in `depth` extra divs so the real ancestry — and therefore the signature the page
// recomputes — is as deep as the selector claims.
function deepen(fixture, depth) {
  fixture.main.removeChild(fixture.target);
  let parent = fixture.main;
  for (let index = 0; index < depth; index += 1) parent = parent.append(new FixtureElement('div', {}, fixture.document));
  parent.appendChild(fixture.target);
}

test('accepts the eased selector vocabulary the individual highlight shares with the signals', async () => {
  // Ids and classes carrying four digits or eight hex characters are page furniture, not secrets.
  for (const [selector, complexity, attributes] of [
    ['button#post-1234', 2, { id: 'post-1234' }],
    ['button.card-2024', 2, { class: 'card-2024' }],
    ['button.hex-9f8e7d6c', 2, { class: 'hex-9f8e7d6c' }],
    ['main > button#post-1234', 4, { id: 'post-1234' }],
  ]) {
    const fixture = createEnvironment({ attributes });
    const command = await rawSelectorCommand(fixture, selector, complexity);
    assert.deepEqual(await runAuditaHighlightCommand(command, fixture.environment), { ok: true, nonce: FAILED_NONCE }, selector);
    assert.ok(fixture.document.querySelector('[data-audita-highlight-root]'), selector);
  }

  // Deep ancestries: 40 segments (complexity 79) and the 64-segment ceiling (complexity 127).
  for (const [wrappers, segments, complexity] of [[36, 40, 79], [60, 64, 127]]) {
    const fixture = createEnvironment();
    deepen(fixture, wrappers);
    const value = `html > body > main > ${'div > '.repeat(wrappers)}button`;
    assert.equal(value.split(' > ').length, segments);
    const command = await rawSelectorCommand(fixture, value, complexity);
    assert.deepEqual(await runAuditaHighlightCommand(command, fixture.environment), { ok: true, nonce: FAILED_NONCE }, value);
    assert.ok(fixture.document.querySelector('[data-audita-highlight-root]'), value);
  }
});

test('still refuses credential-shaped names and past-ceiling selectors on the highlight path', async () => {
  for (const [selector, complexity] of [
    ['button#password', 2],
    ['button.token-value', 2],
    ['button.session-id', 2],
    ['button.csrf-token', 2],
    ['button#api-key', 2],
    ['div.user@example.com', 2],
    [`html > body > main > ${'div > '.repeat(61)}button`, 129],
  ]) {
    const fixture = createEnvironment();
    const command = await rawSelectorCommand(fixture, selector, complexity);
    assert.deepEqual(await runAuditaHighlightCommand(command, fixture.environment),
      { ok: false, reason: 'invalid-command' }, selector);
    assert.equal(fixture.document.querySelector('[data-audita-highlight-root]'), null, selector);
  }
});

test('same nonce is idempotent while replacement disposes the old root without invalidation', async () => {
  const fixture = createEnvironment();
  const first = await installCommand(fixture);
  await runAuditaHighlightCommand(first, fixture.environment);
  const firstRoot = fixture.document.querySelector('[data-audita-highlight-root]');
  const firstQueryCount = fixture.document.selectorQueryCalls;

  assert.deepEqual(await runAuditaHighlightCommand(first, fixture.environment), { ok: true, nonce: FAILED_NONCE });
  assert.strictEqual(fixture.document.querySelector('[data-audita-highlight-root]'), firstRoot);
  assert.equal(fixture.document.selectorQueryCalls, firstQueryCount + 1);

  const replacement = await installCommand(fixture, { nonce: 'R'.repeat(22), markerNumber: 18 });
  assert.deepEqual(await runAuditaHighlightCommand(replacement, fixture.environment), {
    ok: true,
    nonce: 'R'.repeat(22),
  });
  const replacementRoot = fixture.document.querySelector('[data-audita-highlight-root]');
  assert.notStrictEqual(replacementRoot, firstRoot);
  assert.equal(rootsWithin(fixture.document.documentElement).length, 1);
  assert.deepEqual(fixture.environment.messages, []);
  assert.deepEqual(fixture.environment.listenerCounts(), { scroll: 1, resize: 1, keydown: 1, pagehide: 1 });
  assert.equal(fixture.environment.activeObserverCount(), 1);
});

test('same nonce is idempotent only for the exact original install command', async () => {
  const fixture = createEnvironment();
  const command = await installCommand(fixture);
  await runAuditaHighlightCommand(command, fixture.environment);
  const root = fixture.document.querySelector('[data-audita-highlight-root]');

  assert.deepEqual(await runAuditaHighlightCommand({ ...command, markerNumber: 18 }, fixture.environment), {
    ok: false,
    reason: 'runtime-error',
  });
  assert.strictEqual(fixture.document.querySelector('[data-audita-highlight-root]'), root);
  assert.deepEqual(fixture.environment.listenerCounts(), { scroll: 1, resize: 1, keydown: 1, pagehide: 1 });
  assert.equal(fixture.environment.activeObserverCount(), 1);
  assert.deepEqual(fixture.environment.messages, []);
});

test('same nonce accepts the browser-normalized serialization of its own fractional geometry', async () => {
  const fixture = createEnvironment();
  const createElement = fixture.document.createElement.bind(fixture.document);
  fixture.document.createElement = tag => {
    const element = createElement(tag);
    const values = {};
    element.style = new Proxy(values, {
      set(target, key, value) {
        const source = String(value);
        const match = source.match(/^(-?\d+\.\d{4,})px$/u);
        target[key] = match ? `${Number(match[1]).toFixed(3)}px` : source;
        return true;
      },
    });
    return element;
  };
  fixture.target.setRect({ left: 1 / 3, top: 2 / 3, width: 100 / 3, height: 80 / 3 });
  const command = await installCommand(fixture);
  assert.deepEqual(await runAuditaHighlightCommand(command, fixture.environment), {
    ok: true,
    nonce: FAILED_NONCE,
  });
  assert.deepEqual(await runAuditaHighlightCommand(command, fixture.environment), {
    ok: true,
    nonce: FAILED_NONCE,
  });
  assert.deepEqual(fixture.environment.messages, []);
});

test('same nonce fails closed and autonomously cleans every corrupted runtime invariant', async () => {
  const corruptions = [
    ['disconnected-root', fixture => fixture.document.querySelector('[data-audita-highlight-root]').remove()],
    ['wrong-parent', fixture => {
      const root = fixture.document.querySelector('[data-audita-highlight-root]');
      root.remove();
      fixture.body.append(root);
    }],
    ['ownership', fixture => fixture.document.querySelector('[data-audita-highlight-root]').setAttribute('data-audita-highlight-root', 'page-owned')],
    ['aria-hidden', fixture => fixture.document.querySelector('[data-audita-highlight-root]').setAttribute('aria-hidden', 'false')],
    ['tab-index', fixture => { fixture.document.querySelector('[data-audita-highlight-root]').tabIndex = 0; }],
    ['pointer-events', fixture => { fixture.document.querySelector('[data-audita-highlight-root]').style.pointerEvents = 'auto'; }],
    ['all-reset', fixture => { fixture.document.querySelector('[data-audita-highlight-root]').style.all = 'unset'; }],
    ['display', fixture => { fixture.document.querySelector('[data-audita-highlight-root]').style.display = 'none'; }],
    ['visibility', fixture => { fixture.document.querySelector('[data-audita-highlight-root]').style.visibility = 'hidden'; }],
    ['opacity', fixture => { fixture.document.querySelector('[data-audita-highlight-root]').style.opacity = '0'; }],
    ['z-index', fixture => { fixture.document.querySelector('[data-audita-highlight-root]').style.zIndex = '1'; }],
    ['box-sizing', fixture => { fixture.document.querySelector('[data-audita-highlight-root]').style.boxSizing = 'content-box'; }],
    ['background', fixture => { fixture.document.querySelector('[data-audita-highlight-root]').style.background = '#ffffff'; }],
    ['outline', fixture => { fixture.document.querySelector('[data-audita-highlight-root]').style.outline = 'none'; }],
    ['outline-offset', fixture => { fixture.document.querySelector('[data-audita-highlight-root]').style.outlineOffset = '0'; }],
    ['interactive-child', fixture => fixture.document.querySelector('[data-audita-highlight-root]').append(
      new FixtureElement('button', {}, fixture.document),
    )],
    ['missing-child', fixture => {
      const root = fixture.document.querySelector('[data-audita-highlight-root]');
      root.removeChild(root.children[1]);
    }],
  ];

  for (const [label, corrupt] of corruptions) {
    const fixture = createEnvironment();
    const command = await installCommand(fixture);
    assert.deepEqual(await runAuditaHighlightCommand(command, fixture.environment), {
      ok: true,
      nonce: FAILED_NONCE,
    });
    corrupt(fixture);
    assert.deepEqual(await runAuditaHighlightCommand(command, fixture.environment), {
      ok: false,
      reason: 'runtime-error',
    }, label);
    assertDisposed(fixture);
    assert.deepEqual(fixture.environment.messages, [{
      type: 'AUDITA_HIGHLIGHT_INVALIDATED',
      nonce: FAILED_NONCE,
    }], label);
  }
});

test('computed page CSS cannot hide or visually neutralize an intact inline overlay', async () => {
  for (const [label, override] of [
    ['background', { backgroundColor: 'rgb(255, 255, 255)' }],
    ['outline', { outlineStyle: 'none', outlineWidth: '0px' }],
  ]) {
    const fixture = createEnvironment();
    const computedOverrides = installComputedStyleModel(fixture);
    const command = await installCommand(fixture);
    assert.deepEqual(await runAuditaHighlightCommand(command, fixture.environment), {
      ok: true,
      nonce: FAILED_NONCE,
    }, label);
    const root = fixture.document.querySelector('[data-audita-highlight-root]');
    computedOverrides.set(root, override);

    assert.deepEqual(await runAuditaHighlightCommand(command, fixture.environment), {
      ok: false,
      reason: 'runtime-error',
    }, label);
    assertDisposed(fixture);
    assert.deepEqual(fixture.environment.messages, [{
      type: 'AUDITA_HIGHLIGHT_INVALIDATED',
      nonce: FAILED_NONCE,
    }], label);
  }
});

test('serializes deliberately interleaved same- and different-nonce installs across Web Crypto awaits', async () => {
  for (const sameNonce of [true, false]) {
    const fixture = createEnvironment();
    const firstCommand = await installCommand(fixture);
    const secondCommand = await installCommand(fixture, {
      nonce: sameNonce ? FAILED_NONCE : 'D'.repeat(22),
      markerNumber: sameNonce ? 17 : 18,
    });
    const gate = gateCanonicalDigest(fixture);

    const first = runAuditaHighlightCommand(firstCommand, fixture.environment);
    await gate.firstCanonical;
    const second = runAuditaHighlightCommand(secondCommand, fixture.environment);
    await new Promise(resolve => setImmediate(resolve));
    gate.release();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    assert.deepEqual(firstResult, { ok: true, nonce: FAILED_NONCE });
    assert.deepEqual(secondResult, { ok: false, reason: 'runtime-error' });
    assert.equal(gate.canonicalCalls(), 1);
    assert.equal(rootsWithin(fixture.document.documentElement).length, 1);
    assert.deepEqual(fixture.environment.listenerCounts(), { scroll: 1, resize: 1, keydown: 1, pagehide: 1 });
    assert.equal(fixture.environment.activeObserverCount(), 1);
    assert.equal(Object.hasOwn(fixture.environment, '__auditaHighlightOverlayV1'), true);
    assert.equal(Object.hasOwn(fixture.environment, '__auditaHighlightInstallV1'), false);
  }
});

test('fails a reentrant install claim without awaiting itself or deadlocking Web Crypto', async () => {
  const fixture = createEnvironment();
  const command = await installCommand(fixture);
  let nestedPromise = null;
  let immediateNestedResult = null;
  fixture.environment.crypto = {
    subtle: {
      async digest(algorithm, bytes) {
        if (nestedPromise === null) {
          nestedPromise = runAuditaHighlightCommand(command, fixture.environment);
          immediateNestedResult = await Promise.race([
            nestedPromise,
            Promise.resolve({ pending: true }),
          ]);
        }
        return webcrypto.subtle.digest(algorithm, bytes);
      },
    },
  };

  assert.deepEqual(await runAuditaHighlightCommand(command, fixture.environment), {
    ok: true,
    nonce: FAILED_NONCE,
  });
  assert.deepEqual(immediateNestedResult, { ok: false, reason: 'runtime-error' });
  assert.deepEqual(await nestedPromise, { ok: false, reason: 'runtime-error' });
  assert.equal(rootsWithin(fixture.document.documentElement).length, 1);
  assert.deepEqual(fixture.environment.listenerCounts(), { scroll: 1, resize: 1, keydown: 1, pagehide: 1 });
  assert.equal(fixture.environment.activeObserverCount(), 1);
});

test('fails closed if its document-realm install claim is lost during Web Crypto', async () => {
  const fixture = createEnvironment();
  const command = await installCommand(fixture);
  mutateAfterCanonicalDigest(fixture, () => {
    Reflect.deleteProperty(fixture.environment, '__auditaHighlightInstallV1');
  });

  assert.deepEqual(await runAuditaHighlightCommand(command, fixture.environment), {
    ok: false,
    reason: 'runtime-error',
  });
  assertDisposed(fixture);
  assert.equal(Object.hasOwn(fixture.environment, '__auditaHighlightInstallV1'), false);
});

test('rechecks its install claim after DOM preparation immediately before registration', async () => {
  const fixture = createEnvironment();
  const command = await installCommand(fixture);
  const createElement = fixture.document.createElement.bind(fixture.document);
  let stoleClaim = false;
  fixture.document.createElement = tag => {
    const element = createElement(tag);
    if (!stoleClaim) {
      stoleClaim = true;
      Reflect.deleteProperty(fixture.environment, '__auditaHighlightInstallV1');
    }
    return element;
  };

  assert.deepEqual(await runAuditaHighlightCommand(command, fixture.environment), {
    ok: false,
    reason: 'runtime-error',
  });
  assertDisposed(fixture);
  assert.equal(Object.hasOwn(fixture.environment, '__auditaHighlightInstallV1'), false);
});

test('rejects a hostile pre-existing install claim without invoking nested accessors', async () => {
  const fixture = createEnvironment();
  const command = await installCommand(fixture);
  let nestedReads = 0;
  const hostileClaim = {
    version: 1,
    nonce: FAILED_NONCE,
  };
  Object.defineProperty(hostileClaim, 'token', {
    enumerable: true,
    get() {
      nestedReads += 1;
      throw new Error('hostile token getter');
    },
  });
  Object.defineProperty(fixture.environment, '__auditaHighlightInstallV1', {
    value: hostileClaim,
    enumerable: false,
    configurable: true,
    writable: false,
  });

  assert.deepEqual(await runAuditaHighlightCommand(command, fixture.environment), {
    ok: false,
    reason: 'runtime-error',
  });
  assert.equal(nestedReads, 0);
  assert.equal(fixture.document.selectorQueryCalls, 0);
  assert.equal(fixture.document.querySelector('[data-audita-highlight-root]'), null);
});

test('registration failure is atomic and leaves no root runtime claim listener or observer', async () => {
  const fixture = createEnvironment();
  const command = await installCommand(fixture);
  const hostileEnvironment = new Proxy(fixture.environment, {
    defineProperty(target, key, descriptor) {
      if (key === '__auditaHighlightOverlayV1') throw new Error('registration denied');
      return Reflect.defineProperty(target, key, descriptor);
    },
  });

  assert.deepEqual(await runAuditaHighlightCommand(command, hostileEnvironment), {
    ok: false,
    reason: 'runtime-error',
  });
  assertDisposed(fixture);
  assert.equal(Object.hasOwn(fixture.environment, '__auditaHighlightInstallV1'), false);
  assert.deepEqual(fixture.environment.messages, []);
});

test('append failure rolls back its local root even if the runtime slot disappears', async () => {
  const fixture = createEnvironment();
  const command = await installCommand(fixture);
  const appendChild = fixture.html.appendChild.bind(fixture.html);
  fixture.html.appendChild = child => {
    appendChild(child);
    Reflect.deleteProperty(fixture.environment, '__auditaHighlightOverlayV1');
    throw new Error('append interrupted after attachment');
  };

  assert.deepEqual(await runAuditaHighlightCommand(command, fixture.environment), {
    ok: false,
    reason: 'runtime-error',
  });
  assertDisposed(fixture);
  assert.equal(Object.hasOwn(fixture.environment, '__auditaHighlightInstallV1'), false);
  assert.deepEqual(fixture.environment.messages, []);
});

test('partial event registration failure removes the listener that threw after registering', async () => {
  const fixture = createEnvironment();
  const command = await installCommand(fixture);
  const addEventListener = fixture.environment.addEventListener.bind(fixture.environment);
  let registrations = 0;
  fixture.environment.addEventListener = (type, listener, options) => {
    addEventListener(type, listener, options);
    registrations += 1;
    if (registrations === 2) throw new Error('listener registration interrupted');
  };

  assert.deepEqual(await runAuditaHighlightCommand(command, fixture.environment), {
    ok: false,
    reason: 'runtime-error',
  });
  assertDisposed(fixture);
  assert.equal(Object.hasOwn(fixture.environment, '__auditaHighlightInstallV1'), false);
  assert.deepEqual(fixture.environment.messages, []);
});

test('explicit clear is exact, nonce-correlated, idempotent and sends no autonomous event', async () => {
  const fixture = createEnvironment();
  const command = await installCommand(fixture);
  await runAuditaHighlightCommand(command, fixture.environment);

  assert.deepEqual(await runAuditaHighlightCommand({ version: 1, op: 'clear', nonce: MANUAL_NONCE }, fixture.environment), {
    ok: false,
    reason: 'nonce-mismatch',
  });
  assert.ok(fixture.document.querySelector('[data-audita-highlight-root]'));
  assert.deepEqual(await runAuditaHighlightCommand({ version: 1, op: 'clear', nonce: FAILED_NONCE }, fixture.environment), {
    ok: true,
    nonce: FAILED_NONCE,
  });
  assertDisposed(fixture);
  assert.deepEqual(fixture.environment.messages, []);
  assert.deepEqual(await runAuditaHighlightCommand({ version: 1, op: 'clear', nonce: FAILED_NONCE }, fixture.environment), {
    ok: true,
    nonce: FAILED_NONCE,
  });
  assert.deepEqual(await runAuditaHighlightCommand({ version: 1, op: 'clear', nonce: FAILED_NONCE, extra: true }, fixture.environment), {
    ok: false,
    reason: 'invalid-command',
  });
});

test('Escape and pagehide each autonomously dispose and notify the exact nonce once', async () => {
  for (const [eventName, trigger] of [
    ['Escape', environment => environment.dispatchKey('Escape')],
    ['pagehide', environment => environment.dispatch('pagehide')],
  ]) {
    const fixture = createEnvironment();
    const command = await installCommand(fixture);
    await runAuditaHighlightCommand(command, fixture.environment);
    trigger(fixture.environment);
    trigger(fixture.environment);
    assertDisposed(fixture);
    assert.deepEqual(fixture.environment.messages, [{
      type: 'AUDITA_HIGHLIGHT_INVALIDATED',
      nonce: FAILED_NONCE,
    }], eventName);
  }
});

test('zero size and disconnect during geometry refresh autonomously dispose and notify once', async () => {
  for (const [label, invalidate] of [
    ['zero-size', fixture => fixture.target.setRect({ left: 0, top: 0, width: 0, height: 30 })],
    ['disconnect', fixture => fixture.main.removeChild(fixture.target)],
  ]) {
    const fixture = createEnvironment();
    const command = await installCommand(fixture);
    await runAuditaHighlightCommand(command, fixture.environment);
    invalidate(fixture);
    fixture.environment.dispatch('scroll');
    fixture.environment.flushAnimationFrames();
    assertDisposed(fixture);
    assert.deepEqual(fixture.environment.messages, [{
      type: 'AUDITA_HIGHLIGHT_INVALIDATED',
      nonce: FAILED_NONCE,
    }], label);
  }
});

test('mutation observes only continued identity and uniqueness and never relocates the overlay', async () => {
  const fixture = createEnvironment();
  const command = await installCommand(fixture);
  await runAuditaHighlightCommand(command, fixture.environment);
  const root = fixture.document.querySelector('[data-audita-highlight-root]');

  fixture.environment.triggerMutations();
  assert.strictEqual(fixture.document.querySelector('[data-audita-highlight-root]'), root);
  assert.equal(fixture.document.selectorQueryCalls, 2);
  assert.equal(fixture.environment.pendingFrameCount(), 1);
  fixture.environment.flushAnimationFrames();
  assert.equal(fixture.document.selectorQueryCalls, 3);

  const replacement = new FixtureElement('button', { id: 'action', class: 'primary', role: 'button' }, fixture.document);
  fixture.document.selection = [replacement];
  fixture.environment.triggerMutations();
  fixture.environment.flushAnimationFrames();
  assertDisposed(fixture);
  assert.equal(replacement.parentNode, null);
  assert.deepEqual(fixture.environment.messages, [{
    type: 'AUDITA_HIGHLIGHT_INVALIDATED',
    nonce: FAILED_NONCE,
  }]);
});

test('coalesces a mutation burst into at most one exact query per animation frame', async () => {
  const fixture = createEnvironment();
  const command = await installCommand(fixture);
  await runAuditaHighlightCommand(command, fixture.environment);
  assert.equal(fixture.document.selectorQueryCalls, 2);

  fixture.environment.triggerMutations();
  fixture.environment.triggerMutations();
  fixture.environment.triggerMutations();
  assert.equal(fixture.document.selectorQueryCalls, 2);
  assert.equal(fixture.environment.pendingFrameCount(), 1);
  fixture.environment.flushAnimationFrames();
  assert.equal(fixture.document.selectorQueryCalls, 3);
  assert.ok(fixture.document.querySelector('[data-audita-highlight-root]'));
});

test('conservatively disposes when a mutation cannot schedule its verification frame', async () => {
  const fixture = createEnvironment();
  const command = await installCommand(fixture);
  await runAuditaHighlightCommand(command, fixture.environment);
  fixture.environment.requestAnimationFrame = () => { throw new Error('frame unavailable'); };

  assert.doesNotThrow(() => fixture.environment.triggerMutations());
  assertDisposed(fixture);
  assert.deepEqual(fixture.environment.messages, [{
    type: 'AUDITA_HIGHLIGHT_INVALIDATED',
    nonce: FAILED_NONCE,
  }]);
});

test('mutation and geometry paths dispose a corrupted overlay runtime with one notification', async () => {
  for (const [label, corrupt, trigger] of [
    ['mutation', fixture => {
      fixture.document.querySelector('[data-audita-highlight-root]').style.pointerEvents = 'auto';
    }, fixture => fixture.environment.triggerMutations([{ type: 'attributes', attributeName: 'style' }])],
    ['geometry', fixture => {
      fixture.document.querySelector('[data-audita-highlight-root]').setAttribute('aria-hidden', 'false');
    }, fixture => fixture.environment.dispatch('resize')],
  ]) {
    const fixture = createEnvironment();
    const command = await installCommand(fixture);
    await runAuditaHighlightCommand(command, fixture.environment);
    corrupt(fixture);
    trigger(fixture);
    fixture.environment.flushAnimationFrames();
    assertDisposed(fixture);
    assert.deepEqual(fixture.environment.messages, [{
      type: 'AUDITA_HIGHLIGHT_INVALIDATED',
      nonce: FAILED_NONCE,
    }], label);
  }
});

test('best-effort invalidation never converts autonomous cleanup into a runtime failure', async () => {
  const fixture = createEnvironment();
  const command = await installCommand(fixture);
  fixture.environment.chrome.runtime.sendMessage = () => Promise.reject(new Error('worker unavailable'));
  await runAuditaHighlightCommand(command, fixture.environment);
  fixture.environment.dispatchKey('Escape');
  assertDisposed(fixture);
});

test('maps unexpected DOM or Web Crypto failures to the closed runtime reason', async () => {
  const fixture = createEnvironment();
  const command = await installCommand(fixture);
  fixture.environment.crypto = {
    subtle: {
      async digest() { throw new Error('private crypto detail'); },
    },
  };
  assert.deepEqual(await runAuditaHighlightCommand(command, fixture.environment), {
    ok: false,
    reason: 'runtime-error',
  });
  assert.equal(fixture.document.querySelector('[data-audita-highlight-root]'), null);
});

test('remains executable after Chrome-style function serialization with no module closure', async () => {
  const fixture = createEnvironment();
  const command = await installCommand(fixture);
  const serialized = runAuditaHighlightCommand.toString();
  const revived = Function(`"use strict"; return (${serialized});`)();

  assert.deepEqual(await revived(command, fixture.environment), {
    ok: true,
    nonce: FAILED_NONCE,
  });
  assert.equal(fixture.document.querySelector('[data-audita-highlight-root]')?.style.pointerEvents, 'none');
});

test('selector fixture itself remains valid under the frozen CSSSelectorV1 grammar', async () => {
  const fixture = createEnvironment();
  const command = await installCommand(fixture);
  const parsed = parseCssSelectorV1(command.selector.value);
  assert.deepEqual({
    syntax: parsed.syntax,
    value: parsed.value,
    byteLength: parsed.byteLength,
    complexity: parsed.complexity,
  }, command.selector);
});
