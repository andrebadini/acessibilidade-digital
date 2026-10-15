class FixtureEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.key = init.key;
    this.defaultPrevented = false;
    this.propagationStopped = false;
  }

  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() { this.propagationStopped = true; }
}

class FixtureEventTarget {
  constructor() { this._listeners = new Map(); }

  addEventListener(type, listener) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(listener);
  }

  removeEventListener(type, listener) { this._listeners.get(type)?.delete(listener); }

  dispatchEvent(event) {
    for (const listener of [...(this._listeners.get(event.type) ?? [])]) listener.call(this, event);
    return !event.defaultPrevented;
  }

  listenerCount(type) { return this._listeners.get(type)?.size ?? 0; }
}

// A text node carries the line rectangles the overlay measures, like a real `Range` over it does.
export class FixtureTextNode {
  constructor(value, ownerDocument = null) {
    this.nodeType = 3;
    this.nodeValue = String(value);
    this.ownerDocument = ownerDocument;
    this.parentNode = null;
    this.parentElement = null;
    this._rects = [];
  }

  get textContent() { return this.nodeValue; }

  setRects(rects) {
    this._rects = rects.map(rect => ({ left: rect.left, top: rect.top, width: rect.width, height: rect.height,
      right: rect.left + rect.width, bottom: rect.top + rect.height }));
    return this;
  }

  setRect(rect) { return this.setRects([rect]); }

  getClientRects() { return this._rects.map(rect => ({ ...rect })); }

  getBoundingClientRect() {
    if (this._rects.length === 0) return { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
    const left = Math.min(...this._rects.map(rect => rect.left));
    const top = Math.min(...this._rects.map(rect => rect.top));
    const right = Math.max(...this._rects.map(rect => rect.right));
    const bottom = Math.max(...this._rects.map(rect => rect.bottom));
    return { left, top, width: right - left, height: bottom - top, right, bottom };
  }
}

class FixtureRange {
  constructor() { this.contents = null; }

  selectNodeContents(node) { this.contents = node; }

  getClientRects() {
    return typeof this.contents?.getClientRects === 'function' ? this.contents.getClientRects() : [];
  }

  getBoundingClientRect() {
    return typeof this.contents?.getBoundingClientRect === 'function'
      ? this.contents.getBoundingClientRect()
      : { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
  }
}

export class FixtureElement extends FixtureEventTarget {
  constructor(tag, attributes = {}, ownerDocument = null) {
    super();
    this.tagName = String(tag).toUpperCase();
    this.attributes = { ...attributes };
    this.ownerDocument = ownerDocument;
    this.parentNode = null;
    this.parentElement = null;
    this.nodes = [];
    this.style = {};
    this.shadowRoot = null;
    this._textContent = '';
    this._rect = { left: 30, top: 50, width: 160, height: 40, right: 190, bottom: 90 };
    this.scrollCalls = [];
    this.focusCalls = 0;
    this.clickCalls = 0;
  }

  // Element children, as in the DOM; text nodes are reachable through `childNodes`.
  get children() { return this.nodes.filter(node => node.nodeType !== 3); }
  get childNodes() { return this.nodes; }

  appendChild(child) {
    child.parentNode = this;
    child.parentElement = this;
    child.ownerDocument = this.ownerDocument;
    this.nodes.push(child);
    return child;
  }

  append(...children) { for (const child of children) this.appendChild(child); }

  removeChild(child) {
    const index = this.nodes.indexOf(child);
    if (index < 0) throw new Error('fixture child absent');
    this.nodes.splice(index, 1);
    child.parentNode = null;
    child.parentElement = null;
    return child;
  }

  contains(node) {
    for (let current = node; current; current = current.parentNode) {
      if (current === this) return true;
    }
    return false;
  }

  remove() { this.parentNode?.removeChild(this); }

  attachShadow({ mode }) {
    if (mode !== 'open' || this.shadowRoot) throw new Error('invalid shadow attachment');
    this.shadowRoot = new FixtureShadowRoot(this.ownerDocument, this);
    return this.shadowRoot;
  }

  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return Object.hasOwn(this.attributes, name) ? String(this.attributes[name]) : null; }
  removeAttribute(name) { delete this.attributes[name]; }

  get id() { return this.getAttribute('id') ?? ''; }
  set id(value) { this.setAttribute('id', value); }

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
    const root = this.getRootNode();
    return root?.nodeType === 9 || root?.host?.isConnected === true;
  }

  set textContent(value) { this._textContent = String(value); this.nodes = []; }
  get textContent() { return `${this._textContent}${this.children.map(child => child.textContent).join('')}`; }

  getBoundingClientRect() { return { ...this._rect }; }
  setRect({ left, top, width, height }) {
    this._rect = { left, top, width, height, right: left + width, bottom: top + height };
  }

  scrollIntoView(options) { this.scrollCalls.push(structuredClone(options)); }
  focus() { this.focusCalls += 1; this.ownerDocument.activeElement = this; }
  click() { this.clickCalls += 1; this.dispatchEvent(new FixtureEvent('click')); }
  activateByKeyboard(key) {
    const event = new FixtureEvent('keydown', { key });
    this.dispatchEvent(event);
    if (!event.defaultPrevented && this.tagName === 'BUTTON' && (key === 'Enter' || key === ' ')) this.click();
  }

  querySelectorAll(selector) { return fixtureQuery(this, selector); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}

class FixtureShadowRoot extends FixtureElement {
  constructor(ownerDocument, host) {
    super('#shadow-root', {}, ownerDocument);
    this.host = host;
    this.parentNode = null;
    this.parentElement = null;
  }

  getRootNode() { return this; }
}

class FixtureDocument extends FixtureEventTarget {
  constructor() {
    super();
    this.nodeType = 9;
    this.children = [];
    this.documentElement = null;
    this.activeElement = null;
    this.selection = { anchorNode: null, focusNode: null };
    this.queryOverrides = new Map();
    this.queryCounts = new Map();
  }

  append(...children) {
    for (const child of children) {
      child.parentNode = this;
      child.parentElement = null;
      child.ownerDocument = this;
      this.children.push(child);
    }
    if (!this.documentElement) this.documentElement = children[0] ?? null;
  }

  createElement(tag) { return new FixtureElement(tag, {}, this); }

  createRange() { return new FixtureRange(); }

  get body() {
    let found = null;
    const visit = node => {
      for (const child of node.children ?? []) {
        if (!found && child.tagName === 'BODY') found = child;
        visit(child);
      }
    };
    visit(this);
    return found;
  }

  querySelectorAll(selector) {
    this.queryCounts.set(selector, (this.queryCounts.get(selector) ?? 0) + 1);
    if (this.queryOverrides.has(selector)) return [...this.queryOverrides.get(selector)];
    return fixtureQuery(this, selector);
  }

  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  getSelection() { return this.selection; }
}

function fixtureQuery(root, selector) {
  const structural = selector.split(' > ').map(part => /^([a-z][a-z0-9-]*)(?::nth-of-type\(([1-9][0-9]*)\))?$/u.exec(part));
  if (structural.every(Boolean)) {
    const candidates = [];
    const matches = (element, index) => {
      const segment = structural[index];
      if (element?.tagName?.toLowerCase() !== segment[1]) return false;
      const siblings = element.parentNode?.children?.filter(child => child.tagName === element.tagName) ?? [];
      if (segment[2] && siblings.indexOf(element) + 1 !== Number(segment[2])) return false;
      return index === 0 || matches(element.parentNode, index - 1);
    };
    const visit = node => { for (const child of node.children ?? []) {
      if (matches(child, structural.length - 1)) candidates.push(child);
      visit(child);
    } };
    visit(root);
    return candidates;
  }
  const attribute = /^([a-z][a-z0-9-]{0,62})\[([a-z][a-z0-9-]{0,31})="((?:[^"\\]|\\.)*)"\]$/u.exec(selector);
  if (attribute) {
    const value = attribute[3].replace(/\\(.)/gu, '$1');
    const attributeResults = [];
    const visitAttribute = node => {
      for (const child of node.children ?? []) {
        if (child.tagName?.toLowerCase() === attribute[1] && child.getAttribute(attribute[2]) === value) {
          attributeResults.push(child);
        }
        visitAttribute(child);
      }
    };
    visitAttribute(root);
    return attributeResults;
  }
  const match = /^([a-z][a-z0-9-]{0,62})(?:#(-?[_A-Za-z][_A-Za-z0-9-]{0,22})|((?:\.-?[_A-Za-z][_A-Za-z0-9-]*){1,2}))$/u.exec(selector);
  if (!match) return [];
  const results = [];
  const visit = node => {
    for (const child of node.children ?? []) {
      const classes = (child.getAttribute('class') ?? '').split(/[\t\n\f\r ]+/u).filter(Boolean);
      if (child.tagName?.toLowerCase() === match[1] &&
        (match[2] === undefined ? match[3].slice(1).split('.').every(value => classes.includes(value)) : child.getAttribute('id') === match[2])) results.push(child);
      visit(child);
    }
  };
  visit(root);
  return results;
}

function recordIsWithin(record, observedTarget) {
  let current = record?.target ?? null;
  while (current) {
    if (current === observedTarget) return true;
    current = current.parentNode;
  }
  return false;
}

export function createPageMarkersFixture() {
  const document = new FixtureDocument();
  const html = new FixtureElement('html', {}, document);
  const body = new FixtureElement('body', {}, document);
  const main = new FixtureElement('main', {}, document);
  const first = new FixtureElement('button', { id: 'continue' }, document);
  const second = new FixtureElement('a', { id: 'help', href: '/help' }, document);
  const priorFocus = new FixtureElement('input', { id: 'prior' }, document);
  document.append(html);
  html.append(body);
  body.append(main);
  main.append(first, second, priorFocus);
  document.activeElement = priorFocus;
  document.selection = { anchorNode: first, focusNode: second };

  const environment = new FixtureEventTarget();
  const frames = new Map();
  const timers = new Map();
  const observers = new Set();
  const messages = [];
  let nextFrame = 1;
  let nextTimer = 1;
  let timerRegistrations = 0;
  let virtualNow = 0;

  Object.assign(environment, {
    document,
    innerWidth: 1024,
    innerHeight: 768,
    location: { pathname: '/', search: '' },
    performance: { now: () => virtualNow },
    chrome: { runtime: { sendMessage(message) { messages.push(structuredClone(message)); return Promise.resolve(); } } },
    getComputedStyle(element) {
      return {
        display: element.style.display ?? 'block',
        visibility: element.style.visibility ?? 'visible',
        overflowX: element.style.overflowX ?? element.style.overflow ?? 'visible',
        overflowY: element.style.overflowY ?? element.style.overflow ?? 'visible',
        position: element.style.position ?? 'static',
      };
    },
    requestAnimationFrame(callback) { const id = nextFrame++; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    setTimeout(callback, delay) {
      timerRegistrations += 1;
      const id = nextTimer++;
      timers.set(id, { callback, delay, dueAt: virtualNow + Math.max(0, Number(delay) || 0) });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    MutationObserver: class FixtureMutationObserver {
      constructor(callback) { this.callback = callback; this.active = false; this.target = null; this.options = null; }
      observe(target, options) { this.active = true; this.target = target; this.options = structuredClone(options); observers.add(this); }
      disconnect() { this.active = false; observers.delete(this); }
    },
  });

  environment.dispatch = (type, init = {}) => environment.dispatchEvent(new FixtureEvent(type, init));
  environment.now = () => virtualNow;
  environment.flushFrames = () => {
    const pending = [...frames.values()];
    frames.clear();
    virtualNow += 16;
    for (const callback of pending) callback(virtualNow);
    return virtualNow;
  };
  environment.fireTimers = () => {
    const pending = [...timers.values()];
    timers.clear();
    for (const { callback } of pending) callback();
  };
  // Advances the virtual clock and runs only the timers that became due, so a mutation-driven
  // re-check can be exercised without firing the lifetime timer.
  environment.advanceTime = milliseconds => {
    virtualNow += Math.max(0, Number(milliseconds) || 0);
    for (let guard = 0; guard < 64; guard += 1) {
      const due = [...timers.entries()].filter(([, entry]) => entry.dueAt <= virtualNow);
      if (due.length === 0) break;
      for (const [id, entry] of due) {
        timers.delete(id);
        entry.callback();
      }
    }
    return virtualNow;
  };
  environment.settle = () => {
    environment.advanceTime(120);
    environment.flushFrames();
    environment.advanceTime(0);
    return virtualNow;
  };
  environment.triggerMutations = records => {
    for (const observer of [...observers]) {
      const delivered = (records ?? []).filter(record => recordIsWithin(record, observer.target));
      if (delivered.length > 0) observer.callback(delivered, observer);
    }
  };
  environment.replaceDocumentElement = replacement => {
    const previous = document.documentElement;
    const index = document.children.indexOf(previous);
    if (index < 0) throw new Error('fixture documentElement absent');
    previous.parentNode = null;
    previous.parentElement = null;
    replacement.parentNode = document;
    replacement.parentElement = null;
    replacement.ownerDocument = document;
    document.children[index] = replacement;
    document.documentElement = replacement;
    environment.triggerMutations([{
      type: 'childList', target: document, removedNodes: [previous], addedNodes: [replacement],
    }]);
    return previous;
  };
  environment.listenerCounts = () => Object.fromEntries(
    ['scroll', 'resize', 'keydown', 'pagehide', 'popstate', 'hashchange']
      .map(type => [type, environment.listenerCount(type)]),
  );
  environment.timerDelays = () => [...timers.values()].map(entry => entry.delay);
  environment.timerRegistrationCount = () => timerRegistrations;
  environment.activeObserverCount = () => observers.size;
  environment.messages = messages;
  environment.hosts = () => html.children.filter(child => child.shadowRoot);
  environment.markerButtons = () => environment.hosts().flatMap(host => host.shadowRoot.querySelectorAll('button.audita-marker'));
  environment.markerGroups = () => environment.hosts().flatMap(host => host.shadowRoot.querySelectorAll('div.audita-group'));

  return { environment, document, html, body, main, first, second, priorFocus };
}

export function install(overrides = {}) {
  return {
    version: 1,
    op: 'install',
    installationId: 'A'.repeat(22),
    ttlMs: 60_000,
    targets: [
      { markerId: 'm1', number: 1, match: idMatch('button', 'continue'), signals: [
        { selectionId: 's1', classification: 'failed' },
        { selectionId: 's2', classification: 'manual-review' },
      ] },
      { markerId: 'm2', number: 2, match: idMatch('a', 'help'), signals: [
        { selectionId: 's3', classification: 'passed' },
      ] },
    ],
    ...overrides,
  };
}

export function idMatch(tag, id) {
  return { tag, id };
}

// Visible page text, as the overlay measures it: one text node whose line rectangles are known.
export function textLine(parent, value, rect) {
  const node = new FixtureTextNode(value, parent.ownerDocument);
  parent.appendChild(node);
  return node.setRect(rect);
}

export function semanticMatch(tag, name, value) {
  return { tag, attribute: { name, value } };
}

export function structuralMatch(tag, path, extras = {}) {
  return { tag, classes: extras.classes ?? [], path, id: extras.id ?? null,
    role: extras.role ?? null, type: extras.type ?? null };
}

export function select(selectionId, scroll = false, installationId = 'A'.repeat(22)) {
  return { version: 1, op: 'select', installationId, selectionId, scroll };
}

export function filter(selectionIds, installationId = 'A'.repeat(22)) {
  return { version: 1, op: 'filter', installationId, selectionIds };
}

export function clear(installationId = 'A'.repeat(22)) {
  return { version: 1, op: 'clear', installationId };
}
