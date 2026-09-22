import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { tabReadingPageCommand } from '../../src/reader/page-inspector.js';

class Element {
  constructor(tag, attributes = {}, content = []) {
    this.nodeType = 1; this.localName = tag; this.tagName = tag.toUpperCase();
    this.attributes = new Map(Object.entries(attributes)); this.children = []; this.childNodes = [];
    this.style = { setProperty(name, value) { this[name] = value; } }; this.isConnected = true;
    this.scrolls = 0; this.focuses = 0; this.checked = false; this.disabled = false;
    this.rect = { x: 10, y: 20, left: 10, top: 20, width: 100, height: 30 };
    for (const node of content) this.append(typeof node === 'string' ? { nodeType: 3, nodeValue: node } : node);
  }
  getAttribute(name) { return this.attributes.has(name) ? String(this.attributes.get(name)) : null; }
  hasAttribute(name) { return this.attributes.has(name); }
  getAttributeNames() { return [...this.attributes.keys()]; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  get tabIndex() {
    if (this.hasAttribute('tabindex')) return Number(this.getAttribute('tabindex'));
    return ['button', 'input', 'select', 'textarea', 'summary', 'iframe'].includes(this.localName) ||
      (this.localName === 'a' && this.hasAttribute('href')) ? 0 : -1;
  }
  matches(selector) {
    if (selector !== ':disabled') return false;
    if (!['button', 'input', 'select', 'textarea', 'fieldset', 'option', 'optgroup'].includes(this.localName)) return false;
    for (let node = this; node; node = node.parentElement) {
      if ((node === this || node.localName === 'fieldset') && (node.disabled || node.hasAttribute('disabled'))) return true;
    }
    return false;
  }
  append(...nodes) {
    for (const node of nodes) {
      this.childNodes.push(node); node.parentNode = this;
      if (node.nodeType === 1) { this.children.push(node); node.parentElement = this; }
      if (this.ownerDocument) assignDocument(node, this.ownerDocument);
    }
  }
  appendChild(node) { this.append(node); return node; }
  getRootNode() { return this.parentNode?.getRootNode?.() ?? this.ownerDocument; }
  attachShadow() {
    this.shadowRoot = { nodeType: 11, mode: 'open', host: this, children: [], childNodes: [],
      appendChild(node) { this.children.push(node); this.childNodes.push(node); node.parentNode = this; assignDocument(node, this.host.ownerDocument); },
      getRootNode() { return this; } };
    return this.shadowRoot;
  }
  getBoundingClientRect() { return this.rect; }
  getClientRects() { return this.hidden ? [] : [this.rect]; }
  scrollIntoView() { this.scrolls += 1; }
  focus() { this.focuses += 1; }
  remove() {
    this.isConnected = false;
    if (this.parentElement) {
      this.parentElement.children = this.parentElement.children.filter(node => node !== this);
      this.parentElement.childNodes = this.parentElement.childNodes.filter(node => node !== this);
    }
  }
}
function assignDocument(node, document) {
  if (node.nodeType !== 1) return;
  node.ownerDocument = document;
  for (const child of node.children) assignDocument(child, document);
  for (const child of node.shadowRoot?.children ?? []) assignDocument(child, document);
}
function el(tag, attributes = {}, ...content) { return new Element(tag, attributes, content); }
async function harness(...nodes) {
  const body = el('body', {}, ...nodes); const html = el('html', {}, body);
  const listeners = new Map(); const timers = new Map(); let nextTimer = 0;
  const observers = [];
  class MutationObserver {
    constructor(callback) { this.callback = callback; this.records = []; this.targets = []; this.active = true; observers.push(this); }
    observe(target) { this.targets.push(target); this.active = true; }
    disconnect() { this.active = false; this.records = []; }
    takeRecords() { const records = this.records; this.records = []; return records; }
  }
  const document = { nodeType: 9, documentElement: html, body, children: [html], activeElement: body,
    createElement: tag => { const node = el(tag); assignDocument(node, document); return node; },
    addEventListener(type, handler) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(handler); },
    removeEventListener(type, handler) { listeners.get(type)?.delete(handler); },
  };
  assignDocument(html, document);
  const global = { document, MutationObserver, location: { href: 'https://example.test/page' }, innerWidth: 1000, innerHeight: 800,
    getComputedStyle: node => ({ display: node.hidden ? 'none' : 'block', visibility: 'visible' }),
    setTimeout(handler, delay) { const id = ++nextTimer; timers.set(id, { handler, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    addEventListener: document.addEventListener.bind(document), removeEventListener: document.removeEventListener.bind(document),
  };
  const context = vm.createContext(global);
  const runtime = await readFile(new URL('../../src/core/accessibility/accessible-preview-runtime.classic.js', import.meta.url), 'utf8');
  new vm.Script(runtime).runInContext(context);
  const run = command => {
    context.command = command;
    return JSON.parse(JSON.stringify(vm.runInContext(`(${tabReadingPageCommand.toString()})(command)`, context)));
  };
  return { document, body, context, timers, observers,
    collect: () => run({ type: 'collect', sessionId: 'test-session' }), run,
    dispatch(type, event) { for (const handler of [...(listeners.get(type) ?? [])]) handler(event); },
    mutate(records) { for (const observer of observers.filter(value => value.active)) observer.callback(records); },
    queueMutations(records) { for (const observer of observers.filter(value => value.active)) observer.records.push(...records); },
    listenerCount: type => listeners.get(type)?.size ?? 0,
  };
}

test('collect is serializable, passive, and distinguishes Tab, structural reading and skipped controls', async () => {
  const natural = el('button', {}, 'Continuar');
  const positive = el('a', { href: '/next', tabindex: '2' }, 'Avançar');
  const custom = el('div', { role: 'button' }, 'Comprar');
  const heading = el('h2', {}, 'Resumo');
  const h = await harness(natural, positive, custom, heading);
  const inventory = h.collect();
  assert.equal(inventory.version, 1);
  const byName = Object.fromEntries(inventory.entries.map(entry => [entry.name, entry]));
  assert.equal(byName.Avançar.tabOrder, 1); assert.equal(byName.Continuar.tabOrder, 2);
  assert.equal(byName.Comprar.category, 'outside-tab');
  assert.ok(byName.Comprar.reasons.includes('control-outside-tab'));
  assert.equal(byName.Resumo.category, 'reading');
  assert.match(byName.Resumo.preview, /nível 2/u);
  assert.equal(natural.focuses + positive.focuses + natural.scrolls + positive.scrolls, 0);
  assert.ok(inventory.limitations.includes('estimated-order-not-literal-screen-reader'));
});

test('forms retain safe labels and checkbox/radio states without reading any editable values or contents', async () => {
  const label = el('label', { for: 'mail' }, 'E-mail');
  const input = el('input', { id: 'mail', type: 'email' });
  const checkbox = el('input', { type: 'checkbox', 'aria-label': 'Aceito os termos' }); checkbox.checked = true;
  const textarea = el('textarea', { 'aria-label': 'Mensagem' });
  const select = el('select', { 'aria-label': 'País' });
  const editable = el('div', { contenteditable: 'true', 'aria-label': 'Editor' });
  for (const node of [input, checkbox, textarea, select, editable]) {
    Object.defineProperty(node, 'value', { get() { throw new Error('value must never be read'); } });
    if (node !== checkbox && node !== input) Object.defineProperty(node, 'childNodes', { get() { throw new Error('editable content must never be read'); } });
  }
  const h = await harness(label, input, checkbox, textarea, select, editable);
  const entries = h.collect().entries;
  assert.ok(entries.find(entry => entry.name === 'E-mail' && entry.category === 'tab'));
  assert.deepEqual(entries.find(entry => entry.name === 'Aceito os termos').states, ['marcado']);
  assert.ok(['Mensagem', 'País', 'Editor'].every(name => entries.some(entry => entry.name === name)));
});

test('an implicit editing host enters Tab even when Chromium tabIndex IDL is negative', async () => {
  const implicit = el('div', { contenteditable: 'true', role: 'textbox', 'aria-label': 'Editor natural' });
  const negative = el('div', { contenteditable: 'true', tabindex: '-1', 'aria-label': 'Editor programático' });
  assert.equal(implicit.tabIndex, -1);
  const h = await harness(implicit, negative);
  const entries = h.collect().entries;
  assert.equal(entries[0].category, 'tab'); assert.equal(entries[0].tabIndex, 0);
  assert.ok(entries[0].reasons.includes('implicit-editing-host'));
  assert.equal(entries[1].category, 'outside-tab');
});

test('private and credential contents are never read or projected, including referenced field content', async () => {
  const privateNode = el('div', { 'data-audita-private': '' });
  Object.defineProperty(privateNode, 'childNodes', { get() { throw new Error('private contents'); } });
  const password = el('input', { type: 'password', 'aria-label': 'SECRET-DO-NOT-READ' });
  const originalGet = password.getAttribute.bind(password);
  password.getAttribute = key => { if (['aria-label', 'title', 'value'].includes(key)) throw new Error('credential content'); return originalGet(key); };
  const editable = el('textarea', { id: 'field-secret' });
  Object.defineProperty(editable, 'childNodes', { get() { throw new Error('field content'); } });
  const button = el('button', { 'aria-labelledby': 'field-secret' }, 'Prosseguir');
  const h = await harness(privateNode, password, editable, button);
  const inventory = h.collect();
  assert.ok(inventory.limitations.includes('private-content-omitted'));
  assert.ok(inventory.limitations.includes('editable-values-omitted'));
  assert.ok(!JSON.stringify(inventory).includes('SECRET-DO-NOT-READ'));
  assert.ok(inventory.entries.some(entry => entry.tag === 'input' && entry.name === ''));
});

test('real Tab candidates include aria-disabled and aria-hidden; native disabled, inert and negative tabindex are outside', async () => {
  const ariaDisabled = el('button', { 'aria-disabled': 'true' }, 'Ainda focável');
  const ariaHidden = el('button', { 'aria-hidden': 'true', 'aria-label': 'AX oculta' });
  const nativeDisabled = el('fieldset', { disabled: '' }, el('button', {}, 'Desabilitado'));
  const inert = el('div', { inert: '' }, el('button', {}, 'Inerte'));
  const negative = el('button', { tabindex: '-1' }, 'Programático');
  const h = await harness(ariaDisabled, ariaHidden, nativeDisabled, inert, negative);
  const entries = h.collect().entries;
  assert.equal(entries.find(entry => entry.name === 'Ainda focável').category, 'tab');
  assert.ok(entries.some(entry => entry.category === 'tab' && entry.reasons.includes('aria-hidden')));
  assert.equal(entries.find(entry => entry.name === 'Desabilitado').category, 'outside-tab');
  assert.equal(entries.find(entry => entry.name === 'Inerte').category, 'hidden');
  assert.equal(entries.find(entry => entry.name === 'Programático').category, 'outside-tab');
});

test('radio groups have one sequential stop while arrow-navigation siblings stay explained', async () => {
  const first = el('input', { type: 'radio', name: 'choice', 'aria-label': 'Primeiro' });
  const second = el('input', { type: 'radio', name: 'choice', 'aria-label': 'Segundo' }); second.checked = true;
  const third = el('input', { type: 'radio', name: 'independent', 'aria-label': 'Outro' });
  const h = await harness(first, second, third);
  const entries = h.collect().entries;
  assert.equal(entries.find(entry => entry.name === 'Primeiro').tabOrder, null);
  assert.ok(entries.find(entry => entry.name === 'Primeiro').reasons.includes('radio-group-arrow-navigation'));
  assert.equal(entries.find(entry => entry.name === 'Segundo').category, 'tab');
  assert.equal(entries.find(entry => entry.name === 'Outro').category, 'tab');
});

test('safe name references and image alt inside links produce useful ordered text', async () => {
  const description = el('span', { id: 'help' }, 'Abre a página inicial');
  const link = el('a', { href: '/', 'aria-describedby': 'help' }, 'Visitar ', el('img', { alt: 'Página inicial' }));
  const h = await harness(description, link);
  const entry = h.collect().entries.find(entry => entry.tag === 'a');
  assert.equal(entry.name, 'Visitar Página inicial');
  assert.equal(entry.description, 'Abre a página inicial');
});

test('hidden descendants do not contaminate visible names and referenced hidden labels remain usable', async () => {
  const hidden = el('span', {}, 'Não anunciar'); hidden.hidden = true;
  const ariaHidden = el('span', { 'aria-hidden': 'true' }, 'Ícone decorativo');
  const label = el('span', { id: 'hidden-label' }, 'Rótulo referenciado'); label.hidden = true;
  const h = await harness(el('button', {}, 'Salvar', hidden, ariaHidden), label, el('button', { 'aria-labelledby': 'hidden-label' }));
  const entries = h.collect().entries;
  assert.equal(entries[0].name, 'Salvar');
  assert.equal(entries[1].name, 'Rótulo referenciado');
});

test('highlight scrolls only explicitly and rejects removed or replaced identity and wrong sessions', async () => {
  const button = el('button', { id: 'go' }, 'Ir'); const h = await harness(button);
  const entry = h.collect().entries[0];
  assert.equal(h.run({ type: 'highlight', sessionId: 'wrong', elementId: entry.id }).ok, false);
  assert.equal(h.run({ type: 'highlight', sessionId: 'test-session', elementId: entry.id }).ok, true);
  assert.equal(button.scrolls, 1); assert.equal(button.focuses, 0);
  button.setAttribute('id', 'changed');
  assert.equal(h.run({ type: 'highlight', sessionId: 'test-session', elementId: entry.id }).reason, 'stale-element');
});

test('observe follows composed focus without scrolling and Escape removes its isolated overlay and listeners', async () => {
  const host = el('div'); const shadow = host.attachShadow(); const button = el('button', {}, 'No shadow'); shadow.appendChild(button);
  const h = await harness(el('main', {}, host)); const inventory = h.collect();
  assert.ok(inventory.entries.some(entry => entry.name === 'No shadow'));
  assert.equal(h.run({ type: 'observe', sessionId: 'test-session' }).ok, true);
  h.dispatch('focusin', { target: host, composedPath: () => [button, shadow, host] });
  assert.equal(button.scrolls + button.focuses, 0);
  const overlay = h.body.children.find(node => node.hasAttribute('data-audita-tab-reading'));
  assert.ok(overlay?.shadowRoot);
  assert.match(overlay.shadowRoot.children.map(node => node.textContent ?? '').join(' '), /No shadow/u);
  h.dispatch('keydown', { key: 'Escape' });
  assert.equal(overlay.isConnected, false); assert.equal(h.listenerCount('focusin'), 0);
  assert.equal(h.run({ type: 'observe', sessionId: 'test-session' }).ok, true);
  assert.equal(h.run({ type: 'clear', sessionId: 'test-session' }).ok, true);
  assert.equal(h.run({ type: 'clear', sessionId: 'test-session' }).ok, true);
});

test('new collections clean old overlays; expiry and navigation revoke retained references', async () => {
  const h = await harness(el('button', {}, 'Continuar'));
  h.collect(); h.run({ type: 'observe', sessionId: 'test-session' }); h.collect();
  assert.equal(h.body.children.filter(node => node.hasAttribute('data-audita-tab-reading')).length, 0);
  const expiry = [...h.timers.values()].find(timer => timer.delay === 600000); assert.ok(expiry); expiry.handler();
  assert.equal(h.run({ type: 'observe', sessionId: 'test-session' }).ok, false);
  h.collect(); h.dispatch('pagehide', {});
  assert.equal(h.run({ type: 'observe', sessionId: 'test-session' }).ok, false);
});

test('entry and traversal bounds are explicit and never silently advertise complete coverage', async () => {
  const h = await harness(...Array.from({ length: 1005 }, (_, index) => el('button', {}, `Botão ${index}`)));
  const inventory = h.collect();
  assert.equal(inventory.entries.length, 1000);
  assert.equal(inventory.counts.truncated, true);
  assert.ok(inventory.limitations.includes('entry-limit-reached'));
});

test('private subtrees count toward the traversal bound and cannot bypass its limit', async () => {
  const h = await harness(...Array.from({ length: 5005 }, () => el('div', { 'data-audita-private': '' })));
  const inventory = h.collect();
  assert.equal(inventory.counts.scanned, 5000);
  assert.equal(inventory.counts.truncated, true);
  assert.ok(inventory.limitations.includes('node-limit-reached'));
  assert.equal(inventory.entries.length, 0);
});

test('central dispose removes the isolated session, overlay, mutation observers and retained actions', async () => {
  const h = await harness(el('button', {}, 'Continuar'));
  h.collect(); h.run({ type: 'observe', sessionId: 'test-session' });
  assert.equal(h.observers.length, 1);
  const removed = vm.runInContext(`(() => {
    const key = Symbol.for('audita.tab-reading.inspector.v1');
    globalThis[key]?.dispose();
    return !Object.hasOwn(globalThis, key);
  })()`, h.context);
  assert.equal(removed, true);
  assert.equal(h.body.children.some(node => node.hasAttribute('data-audita-tab-reading')), false);
  assert.equal(h.observers.some(observer => observer.active), false);
  assert.equal(h.run({ type: 'observe', sessionId: 'test-session' }).ok, false);
});

test('public label text mutations invalidate old legends, including pending records before a command', async () => {
  const label = el('label', { for: 'name' }, 'Nome original'); const field = el('input', { id: 'name' });
  const h = await harness(label, field); const entry = h.collect().entries[0];
  h.run({ type: 'observe', sessionId: 'test-session' });
  h.dispatch('focusin', { target: field, composedPath: () => [field] });
  label.childNodes[0].nodeValue = 'Nome alterado';
  h.queueMutations([{ type: 'characterData', target: label.childNodes[0] }]);
  assert.equal(h.run({ type: 'highlight', sessionId: 'test-session', elementId: entry.id }).reason, 'page-changed');
  assert.equal(field.scrolls, 0);
  const overlay = h.body.children.find(node => node.hasAttribute('data-audita-tab-reading'));
  assert.match(overlay.shadowRoot.children.map(node => node.textContent ?? '').join(' '), /Página alterada/u);
  assert.equal(h.run({ type: 'observe', sessionId: 'test-session' }).reason, 'page-changed');
  assert.equal(h.collect().entries[0].name, 'Nome alterado');
});

test('ARIA names, hidden state and native checkbox/disabled IDL changes cannot reuse a stale preview', async () => {
  for (const change of [
    node => node.setAttribute('aria-label', 'Outro nome'),
    node => node.setAttribute('aria-hidden', 'true'),
    node => { node.checked = true; },
    node => { node.disabled = true; },
  ]) {
    const checkbox = el('input', { type: 'checkbox', 'aria-label': 'Aceitar' });
    Object.defineProperty(checkbox, 'value', { get() { throw new Error('value must never be read'); } });
    const h = await harness(checkbox); const entry = h.collect().entries[0];
    change(checkbox);
    assert.equal(h.run({ type: 'highlight', sessionId: 'test-session', elementId: entry.id }).reason, 'page-changed');
    assert.equal(checkbox.scrolls, 0);
  }
});

test('mutation monitoring includes open shadow roots and ignores only owned overlays and omitted editable content', async () => {
  const host = el('div'); const shadow = host.attachShadow(); const button = el('button', {}, 'Shadow'); shadow.appendChild(button);
  const textarea = el('textarea', { 'aria-label': 'Mensagem' }); const h = await harness(host, textarea);
  const inventory = h.collect(); h.run({ type: 'observe', sessionId: 'test-session' });
  assert.ok(h.observers[0].targets.includes(shadow));
  const overlay = h.body.children.find(node => node.hasAttribute('data-audita-tab-reading'));
  h.mutate([{ type: 'childList', target: h.body, addedNodes: [overlay], removedNodes: [] }]);
  h.mutate([{ type: 'childList', target: textarea, addedNodes: [], removedNodes: [] }]);
  assert.equal(h.run({ type: 'observe', sessionId: 'test-session' }).ok, true);
  h.mutate([{ type: 'attributes', target: button, attributeName: 'aria-hidden' }]);
  assert.equal(h.run({ type: 'highlight', sessionId: 'test-session', elementId: inventory.entries[0].id }).reason, 'page-changed');
});

test('native change events replace a stale checkbox caption without reading the field value', async () => {
  const checkbox = el('input', { type: 'checkbox', 'aria-label': 'Aceitar' });
  Object.defineProperty(checkbox, 'value', { get() { throw new Error('private value'); } });
  const h = await harness(checkbox); h.collect(); h.run({ type: 'observe', sessionId: 'test-session' });
  h.dispatch('focusin', { target: checkbox, composedPath: () => [checkbox] });
  checkbox.checked = true;
  h.dispatch('change', { target: checkbox });
  const overlay = h.body.children.find(node => node.hasAttribute('data-audita-tab-reading'));
  assert.match(overlay.shadowRoot.children.map(node => node.textContent ?? '').join(' '), /Página alterada/u);
  assert.equal(h.run({ type: 'observe', sessionId: 'test-session' }).reason, 'page-changed');
});
