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

export class FixtureElement extends FixtureEventTarget {
  constructor(tag, attributes = {}, ownerDocument = null) {
    super();
    this.tagName = String(tag).toUpperCase();
    this.attributes = { ...attributes };
    this.ownerDocument = ownerDocument;
    this.parentNode = null;
    this.parentElement = null;
    this.children = [];
    this.style = {};
    this.shadowRoot = null;
    this._textContent = '';
    this._rect = { left: 30, top: 50, width: 160, height: 40, right: 190, bottom: 90 };
    this.scrollCalls = [];
    this.focusCalls = 0;
    this.clickCalls = 0;
  }

  appendChild(child) {
    child.parentNode = this;
    child.parentElement = this;
    child.ownerDocument = this.ownerDocument;
    this.children.push(child);
    return child;
  }

  append(...children) { for (const child of children) this.appendChild(child); }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index < 0) throw new Error('fixture child absent');
    this.children.splice(index, 1);
    child.parentNode = null;
    child.parentElement = null;
    return child;
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

  set textContent(value) { this._textContent = String(value); this.children = []; }
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
  const match = /^([a-z][a-z0-9-]{0,62})(?:#(-?[_A-Za-z][_A-Za-z0-9-]{0,22})|((?:\.-?[_A-Za-z][_A-Za-z0-9-]*){1,2}))$/u.exec(selector);
  if (!match) return [];
  const results = [];
  const visit = node => {
    for (const child of node.children ?? []) {
      const classes = (child.getAttribute('class') ?? '').split(/[\t\n\f\r ]+/u).filter(Boolean);
      if (child.tagName.toLowerCase() === match[1] &&
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

  Object.assign(environment, {
    document,
    chrome: { runtime: { sendMessage(message) { messages.push(structuredClone(message)); return Promise.resolve(); } } },
    getComputedStyle(element) {
      return { display: element.style.display ?? 'block', visibility: element.style.visibility ?? 'visible' };
    },
    requestAnimationFrame(callback) { const id = nextFrame++; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    setTimeout(callback, delay) {
      timerRegistrations += 1;
      const id = nextTimer++;
      timers.set(id, { callback, delay });
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
  environment.flushFrames = () => {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(16);
  };
  environment.fireTimers = () => {
    const pending = [...timers.values()];
    timers.clear();
    for (const { callback } of pending) callback();
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
      { markerId: 'm1', number: 1, match: { tag: 'button', id: 'continue' }, signals: [
        { selectionId: 's1', classification: 'failed' },
        { selectionId: 's2', classification: 'manual-review' },
      ] },
      { markerId: 'm2', number: 2, match: { tag: 'a', id: 'help' }, signals: [
        { selectionId: 's3', classification: 'passed' },
      ] },
    ],
    ...overrides,
  };
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
