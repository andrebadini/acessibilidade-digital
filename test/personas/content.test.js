import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const namespaceExpression = 'globalThis[Symbol.for("audita.accessible-preview.runtime.v1")]';
let structuredCloneCalls = 0;

class FakeClassList {
  constructor(values = []) { this.values = new Set(values); }
  add(value) { this.values.add(value); }
  remove(value) { this.values.delete(value); }
  contains(value) { return this.values.has(value); }
}

class FakeElement {
  constructor(tagName, init = {}) {
    this.nodeType = 1;
    this.tagName = tagName.toUpperCase();
    this.attributes = new Map(Object.entries(init.attributes ?? {}));
    this.children = [];
    this.childNodes = [];
    this.parentElement = null;
    this.parentNode = null;
    this.shadowRoot = null;
    this.ownerDocument = null;
    this.isConnected = true;
    this.hidden = init.hidden === true;
    this.disabled = init.disabled === true;
    this.rect = init.rect ?? { x: 10, y: 10, width: 120, height: 32 };
    this.classList = new FakeClassList(init.classes);
    this.style = { setProperty() {}, removeProperty() {} };
    this.focusCalls = 0;
    this.clickCalls = 0;
    this.scrollCalls = 0;
  }
  append(...nodes) {
    for (const node of nodes) {
      this.childNodes.push(node);
      node.parentNode = this;
      if (node.nodeType === 1) {
        this.children.push(node);
        node.parentElement = this;
      }
      if (this.ownerDocument) assignDocument(node, this.ownerDocument);
    }
  }
  appendChild(node) { this.append(node); return node; }
  remove() {
    this.isConnected = false;
    if (this.parentElement) {
      this.parentElement.children = this.parentElement.children.filter(child => child !== this);
      this.parentElement.childNodes = this.parentElement.childNodes.filter(child => child !== this);
    }
  }
  getAttribute(name) { return this.attributes.has(name) ? String(this.attributes.get(name)) : null; }
  hasAttribute(name) { return this.attributes.has(name); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  get tabIndex() {
    const value = this.getAttribute('tabindex');
    return value === null ? (['A', 'BUTTON', 'SUMMARY'].includes(this.tagName) ? 0 : -1) : Number(value);
  }
  getBoundingClientRect() { return { ...this.rect, top: this.rect.y, left: this.rect.x, right: this.rect.x + this.rect.width, bottom: this.rect.y + this.rect.height }; }
  getClientRects() { return this.rect.width > 0 && this.rect.height > 0 ? [this.getBoundingClientRect()] : []; }
  focus(options) { this.focusCalls += 1; this.lastFocusOptions = options; this.ownerDocument.activeElement = this; }
  click() { this.clickCalls += 1; }
  scrollIntoView() { this.scrollCalls += 1; }
  assignedElements() { return this.assigned ?? []; }
  getRootNode() { return this.rootNode ?? this.ownerDocument; }
}

function text(value) { return { nodeType: 3, nodeValue: value, parentNode: null }; }
function guardedText(secret, reads) {
  return Object.defineProperties({ nodeType: 3, parentNode: null }, {
    nodeValue: { get() { reads.count += 1; throw new Error(`private text read: ${secret}`); } },
  });
}
function element(tag, id, label, init = {}) {
  const node = new FakeElement(tag, { ...init, attributes: { id, ...(init.attributes ?? {}) } });
  if (label !== null && label !== undefined) node.append(text(label));
  return node;
}

function assignDocument(node, document) {
  if (node.nodeType !== 1) return;
  node.ownerDocument = document;
  for (const child of node.children) assignDocument(child, document);
  if (node.shadowRoot) {
    node.shadowRoot.ownerDocument = document;
    for (const child of node.shadowRoot.children) assignDocument(child, document);
  }
}

class FakeDocument {
  constructor(body) {
    this.nodeType = 9;
    this.body = body;
    this.documentElement = new FakeElement('html');
    this.documentElement.append(body);
    this.children = [this.documentElement];
    this.childNodes = [this.documentElement];
    this.listeners = new Map();
    this.windowListeners = new Map();
    this.activeElement = body;
    this.defaultView = {
      getComputedStyle: element => ({
        display: element.computedDisplay ?? 'block',
        visibility: element.computedVisibility ?? 'visible',
      }),
      addEventListener: (type, listener) => {
        if (!this.windowListeners.has(type)) this.windowListeners.set(type, []);
        this.windowListeners.get(type).push(listener);
      },
      removeEventListener: (type, listener) => {
        this.windowListeners.set(type, (this.windowListeners.get(type) ?? []).filter(value => value !== listener));
      },
    };
    assignDocument(this.documentElement, this);
  }
  createElement(tag) { const node = new FakeElement(tag); assignDocument(node, this); return node; }
  addEventListener(type, listener, options) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push({ listener, options });
  }
  removeEventListener(type, listener) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter(entry => entry.listener !== listener));
  }
  dispatch(type, event) { for (const entry of [...(this.listeners.get(type) ?? [])]) entry.listener(event); }
  dispatchWindow(type, event = {}) { for (const listener of [...(this.windowListeners.get(type) ?? [])]) listener(event); }
}

async function loadContentFactory(contextGlobals = {}) {
  const runtime = await readFile(new URL('../../src/core/accessibility/accessible-preview-runtime.classic.js', import.meta.url), 'utf8');
  const reader = await readFile(new URL('../../src/personas/screen-reader-module.js', import.meta.url), 'utf8');
  let content = '';
  try { content = await readFile(new URL('../../src/personas/content.js', import.meta.url), 'utf8'); } catch { /* RED */ }
  assert.notEqual(content, '', 'o runtime clássico de conteúdo precisa existir');
  structuredCloneCalls = 0;
  const context = vm.createContext({
    structuredClone() { structuredCloneCalls += 1; throw new Error('structuredClone não deve tocar a mensagem'); },
    ...contextGlobals,
  });
  for (const source of [runtime, reader, content]) new vm.Script(source).runInContext(context);
  return vm.runInContext(namespaceExpression, context);
}

function fixturePage() {
  const reads = { count: 0 };
  const body = element('body', 'body', null);
  const positiveTwo = element('button', 'positive-two', 'Positivo dois', { attributes: { tabindex: '2' } });
  const natural = element('button', 'natural', 'Ordem natural');
  const host = element('div', 'host', null);
  const slotted = element('a', 'slotted', 'Link atribuído', { attributes: { href: '/destino' } });
  host.append(slotted);
  const shadowButton = element('button', 'shadow-button', 'Botão no shadow');
  const slot = element('slot', 'slot', null);
  slot.assigned = [slotted];
  slotted.assignedSlot = slot;
  const privateSlotted = element('button', 'private-slotted', null);
  privateSlotted.append(guardedText('SEGREDO-SLOT-4488', reads));
  host.append(privateSlotted);
  const privateSlot = element('slot', 'private-slot', null, { attributes: { 'data-audita-private': '' } });
  privateSlot.assigned = [privateSlotted];
  privateSlotted.assignedSlot = privateSlot;
  const ariaHiddenSlotted = element('button', 'aria-hidden-slotted', null);
  ariaHiddenSlotted.append(guardedText('SEGREDO-SLOT-ARIA-HIDDEN-6612', reads));
  host.append(ariaHiddenSlotted);
  const ariaHiddenSlot = element('slot', 'aria-hidden-slot', null);
  ariaHiddenSlot.assigned = [ariaHiddenSlotted];
  ariaHiddenSlotted.assignedSlot = ariaHiddenSlot;
  const ariaHiddenWrapper = element('div', 'aria-hidden-slot-wrapper', null, {
    attributes: { 'aria-hidden': 'true' },
  });
  ariaHiddenWrapper.append(ariaHiddenSlot);
  const inertSlotted = element('button', 'inert-slotted', null);
  inertSlotted.append(guardedText('SEGREDO-SLOT-INERT-7734', reads));
  host.append(inertSlotted);
  const inertSlot = element('slot', 'inert-slot', null);
  inertSlot.assigned = [inertSlotted];
  inertSlotted.assignedSlot = inertSlot;
  const inertSlotWrapper = element('div', 'inert-slot-wrapper', null, { attributes: { inert: '' } });
  inertSlotWrapper.append(inertSlot);
  const shadowRoot = {
    nodeType: 11, mode: 'open', host,
    children: [shadowButton, slot, privateSlot, ariaHiddenWrapper, inertSlotWrapper],
    childNodes: [shadowButton, slot, privateSlot, ariaHiddenWrapper, inertSlotWrapper],
  };
  host.shadowRoot = shadowRoot;
  shadowButton.parentNode = shadowRoot;
  shadowButton.rootNode = shadowRoot;
  slot.parentNode = shadowRoot;
  slot.rootNode = shadowRoot;
  privateSlot.parentNode = shadowRoot;
  privateSlot.rootNode = shadowRoot;
  ariaHiddenWrapper.parentNode = shadowRoot;
  ariaHiddenWrapper.rootNode = shadowRoot;
  ariaHiddenSlot.rootNode = shadowRoot;
  inertSlotWrapper.parentNode = shadowRoot;
  inertSlotWrapper.rootNode = shadowRoot;
  inertSlot.rootNode = shadowRoot;
  const positiveOne = element('button', 'positive-one', 'Positivo um', { attributes: { tabindex: '1' } });
  const hiddenRoot = element('div', 'hidden-root', null, { hidden: true });
  hiddenRoot.hidden = true;
  hiddenRoot.append(element('button', 'hidden-button', 'Oculto'));
  const inertRoot = element('div', 'inert-root', null, { attributes: { inert: '' } });
  inertRoot.append(element('button', 'inert-button', 'Inerte'));
  const disabled = element('button', 'disabled', 'Desabilitado', { disabled: true, attributes: { disabled: '' } });
  const privateLabel = element('span', 'private-label', null, { attributes: { 'data-audita-private': '' } });
  privateLabel.append(guardedText('SEGREDO-CONTENT-9321', reads));
  const safeReference = element('button', 'safe-reference', 'Continuar', { attributes: { 'aria-labelledby': 'private-label' } });
  const textarea = element('textarea', 'editable-label', null);
  textarea.append(guardedText('SEGREDO-EDITAVEL-5321', reads));
  const editableReference = element('button', 'editable-reference', 'Prosseguir', { attributes: { 'aria-labelledby': 'editable-label' } });
  const customTextbox = element('div', 'custom-textbox', null, {
    attributes: { role: 'textbox', tabindex: '0', 'aria-label': 'SEGREDO-WIDGET-7711' },
  });
  const otpCombobox = element('div', 'otp-combobox', null, {
    attributes: { role: 'combobox', tabindex: '0', autocomplete: 'section-login one-time-code', 'aria-label': 'SEGREDO-OTP-8822' },
  });
  const zero = element('button', 'zero', 'Sem geometria', { rect: { x: 0, y: 0, width: 0, height: 0 } });
  const frame = element('iframe', 'frame', null);
  frame.contentDocument = null;
  body.append(positiveTwo, natural, host, positiveOne, hiddenRoot, inertRoot, disabled,
    privateLabel, safeReference, textarea, editableReference, customTextbox, otpCombobox, zero, frame);
  const document = new FakeDocument(body);
  return {
    document, reads, shadowRoot,
    nodes: {
      positiveOne, positiveTwo, natural, host, shadowButton, slotted, privateSlotted,
      ariaHiddenSlotted, inertSlotted,
      safeReference, editableReference, customTextbox, otpCombobox,
    },
  };
}

test('discovers a deterministic composed focus queue without actuating the page or reading tainted text', async () => {
  const namespace = await loadContentFactory();
  const fixture = fixturePage();
  const messages = [];
  const content = namespace.createContentRuntime({
    document: fixture.document,
    window: fixture.document.defaultView,
    emitEvent: message => messages.push(message),
    speechSynthesis: null,
  });

  const queue = content.collectReaderCandidates();
  assert.deepEqual(Array.from(queue, candidate => candidate.element.getAttribute('id')), [
    'positive-one', 'positive-two', 'natural', 'shadow-button', 'slotted',
    'safe-reference', 'editable-reference',
  ]);
  assert.equal(queue.filter(candidate => candidate.element === fixture.nodes.slotted).length, 1, 'slot/light DOM é deduplicado');
  assert.equal(queue.some(candidate => candidate.element === fixture.nodes.privateSlotted), false, 'slot privado contamina seus nós atribuídos');
  assert.equal(queue.some(candidate => candidate.element === fixture.nodes.ariaHiddenSlotted), false,
    'ancestral composto aria-hidden exclui o nó atribuído antes de qualquer anúncio');
  assert.equal(queue.some(candidate => candidate.element === fixture.nodes.inertSlotted), false,
    'ancestral composto inert exclui o nó atribuído antes de qualquer anúncio');
  assert.equal(fixture.reads.count, 0, 'raízes privadas/editáveis são marcadas antes de ler texto');
  assert.doesNotMatch(JSON.stringify(queue.map(item => item.caption)), /SEGREDO/iu);
  for (const node of Object.values(fixture.nodes)) {
    assert.equal(node.focusCalls, 0);
    assert.equal(node.clickCalls, 0);
    assert.equal(node.scrollCalls, 0);
  }
  assert.deepEqual(JSON.parse(JSON.stringify(content.getLimitations())), [{ code: 'frame-uncoordinated', count: 1 }]);
  assert.doesNotMatch(JSON.stringify(content.getLimitations()), /https?:|\/destino/iu);
  assert.equal(messages.length, 0);
});

test('keeps modes exclusive/reversible and blocks pointer while preserving keyboard activation', async () => {
  const namespace = await loadContentFactory();
  const fixture = fixturePage();
  fixture.document.documentElement.classList.add('audita-persona-preexisting');
  const messages = [];
  let now = 0;
  const content = namespace.createContentRuntime({
    document: fixture.document,
    window: fixture.document.defaultView,
    emitEvent: message => messages.push(message),
    speechSynthesis: null,
    now: () => now,
  });

  assert.equal(content.activate('reader', { voiceId: '', rate: 1 }).activeMode, 'reader');
  messages.length = 0;
  assert.equal(content.activate('achromatopsia').activeMode, 'achromatopsia');
  assert.deepEqual(messages, [], 'troca de modo não pode publicar estado inativo transitório na geração do ACK final');
  assert.equal(fixture.document.documentElement.classList.contains('audita-persona-achromatopsia'), true);
  assert.equal(content.activate('motor').activeMode, 'motor');
  assert.equal(fixture.document.documentElement.classList.contains('audita-persona-achromatopsia'), false);
  assert.equal(fixture.document.documentElement.classList.contains('audita-persona-motor'), true);

  const pointer = event({ isTrusted: true, detail: 1 });
  fixture.document.dispatch('pointerdown', pointer);
  assert.equal(pointer.prevented, true);
  assert.equal(pointer.stopped, true);
  for (const type of [
    'pointerover', 'pointerenter', 'pointerout', 'pointerleave',
    'mouseover', 'mouseenter', 'mouseout', 'mouseleave', 'mousemove', 'dblclick', 'auxclick',
  ]) {
    const blocked = event({ isTrusted: true, detail: 1 });
    fixture.document.dispatch(type, blocked);
    assert.equal(blocked.prevented, true, `${type} precisa ser bloqueado`);
    assert.equal(blocked.stopped, true, `${type} não pode chegar à página`);
  }
  const keyboardClick = event({ isTrusted: true, detail: 0 });
  fixture.document.dispatch('click', keyboardClick);
  assert.equal(keyboardClick.prevented, true, 'click detail=0 durante sequência apontadora continua bloqueado');
  const pointerClick = event({ isTrusted: true, detail: 1 });
  fixture.document.dispatch('click', pointerClick);
  const keyboardAfterPointer = event({ isTrusted: true, detail: 0 });
  fixture.document.dispatch('click', keyboardAfterPointer);
  assert.equal(keyboardAfterPointer.prevented, false, 'ativação por teclado sem sequência apontadora é preservada');

  fixture.document.dispatch('pointermove', event({ isTrusted: true, detail: 0 }));
  now += 1600;
  const keyboardAfterMove = event({ isTrusted: true, detail: 0 });
  fixture.document.dispatch('click', keyboardAfterMove);
  assert.equal(keyboardAfterMove.prevented, false, 'movimento antigo não deixa trava apontadora pendurada');

  for (let press = 0; press < 2; press += 1) {
    now += 200;
    const escape = event({ isTrusted: true, key: 'Escape', repeat: false });
    fixture.document.dispatch('keydown', escape);
    assert.equal(escape.prevented, false);
    assert.equal(content.getState().activeMode, 'motor');
  }
  now += 200;
  fixture.document.dispatch('keydown', event({ isTrusted: true, key: 'Escape', repeat: true }));
  assert.equal(content.getState().activeMode, 'motor');
  fixture.document.dispatch('keydown', event({ isTrusted: false, key: 'Escape', repeat: false }));
  assert.equal(content.getState().activeMode, 'motor');
  fixture.document.dispatch('keydown', event({ isTrusted: true, key: 'Escape', repeat: false }));
  assert.equal(content.getState().activeMode, null);
  assert.equal(fixture.document.documentElement.classList.contains('audita-persona-motor'), false);
  assert.equal(fixture.document.documentElement.classList.contains('audita-persona-preexisting'), true);
  assert.equal(messages.at(-1).event, 'emergency-stop');
});

test('cleanup removes only classes it owns and a material SPA mutation stops the active mode', async () => {
  const namespace = await loadContentFactory();
  const fixture = fixturePage();
  fixture.document.documentElement.classList.add('audita-persona-preexisting');
  let observer;
  class FakeMutationObserver {
    constructor(callback) { this.callback = callback; observer = this; }
    observe(target, init) { this.target = target; this.init = init; }
    disconnect() { this.disconnected = true; }
  }
  const content = namespace.createContentRuntime({
    document: fixture.document,
    window: fixture.document.defaultView,
    emitEvent() {},
    speechSynthesis: null,
    MutationObserver: FakeMutationObserver,
  });
  content.activate('motor');
  content.stop('requested');
  assert.equal(fixture.document.documentElement.classList.contains('audita-persona-preexisting'), true);

  content.activate('reader', { voiceId: '', rate: 1 });
  assert.ok(observer, 'mutação material deve ser observada durante a persona');
  observer.callback([{ type: 'childList', target: fixture.document.body, addedNodes: [], removedNodes: [fixture.nodes.natural] }]);
  assert.equal(content.getState().activeMode, null);
  assert.equal(observer.disconnected, true);
});

test('root ownership makes residual CSS inert and rejects preexisting persona collisions', async () => {
  const namespace = await loadContentFactory();
  for (const collision of ['class', 'root-attribute', 'artifact']) {
    const fixture = fixturePage();
    if (collision === 'class') fixture.document.documentElement.classList.add('audita-persona-achromatopsia');
    if (collision === 'root-attribute') fixture.document.documentElement.setAttribute('data-audita-persona-root', 'site-value');
    if (collision === 'artifact') {
      const artifact = element('div', `site-${collision}`, null, { attributes: { 'data-audita-persona-owned': 'site-value' } });
      fixture.document.body.append(artifact);
    }
    const content = namespace.createContentRuntime({
      document: fixture.document, window: fixture.document.defaultView, speechSynthesis: null,
    });
    assert.equal(content.activate('achromatopsia').activeMode, null, collision);
    assert.notEqual(fixture.document.documentElement.getAttribute('data-audita-persona-root'), 'audita-accessible-preview-v1');
    content.stop();
    if (collision === 'class') assert.equal(fixture.document.documentElement.classList.contains('audita-persona-achromatopsia'), true);
  }

  const fixture = fixturePage();
  const content = namespace.createContentRuntime({
    document: fixture.document, window: fixture.document.defaultView, speechSynthesis: null,
  });
  assert.equal(content.activate('reader', { voiceId: '', rate: 1 }).activeMode, 'reader');
  assert.equal(fixture.document.documentElement.getAttribute('data-audita-persona-root'), 'audita-accessible-preview-v1');
  assert.ok(fixture.document.body.children
    .filter(node => node.hasAttribute('data-audita-persona-owned'))
    .every(node => node.getAttribute('data-audita-persona-owned') === 'audita-accessible-preview-v1'));
  content.stop();
  assert.equal(fixture.document.documentElement.hasAttribute('data-audita-persona-root'), false);
});

test('root ownership fails closed when collision proof truncates or a collision appears after activation', async () => {
  const namespace = await loadContentFactory();
  const largeBody = element('body', 'ownership-large-body', null);
  for (let index = 0; index < 5_010; index += 1) {
    const node = element('div', `ownership-${index}`, null);
    if (index === 5_009) node.classList.add('audita-persona-reader-overlay');
    largeBody.append(node);
  }
  const largeDocument = new FakeDocument(largeBody);
  const largeContent = namespace.createContentRuntime({
    document: largeDocument, window: largeDocument.defaultView, speechSynthesis: null,
  });
  assert.equal(largeContent.activate('achromatopsia').activeMode, null);

  const fixture = fixturePage();
  let observer;
  class FakeMutationObserver {
    constructor(callback) { this.callback = callback; observer = this; }
    observe() {}
    disconnect() { this.disconnected = true; }
  }
  const content = namespace.createContentRuntime({
    document: fixture.document, window: fixture.document.defaultView,
    speechSynthesis: null, MutationObserver: FakeMutationObserver,
  });
  content.activate('motor');
  const hostile = element('div', 'late-persona-collision', null, {
    attributes: { 'data-audita-persona-owned': 'audita-accessible-preview-v1' },
  });
  fixture.document.body.append(hostile);
  observer.callback([{ type: 'childList', target: fixture.document.body, addedNodes: [hostile], removedNodes: [] }]);
  assert.equal(content.getState().activeMode, null);
});

test('a reserved persona selector inserted below an ordinary nested node fails closed', async () => {
  const namespace = await loadContentFactory();
  const fixture = fixturePage();
  const nestedTarget = new FakeElement('div');
  fixture.document.body.append(nestedTarget);
  let observer;
  class FakeMutationObserver {
    constructor(callback) { this.callback = callback; observer = this; }
    observe() {}
    disconnect() { this.disconnected = true; }
  }
  const content = namespace.createContentRuntime({
    document: fixture.document, window: fixture.document.defaultView,
    speechSynthesis: null, MutationObserver: FakeMutationObserver,
  });
  content.activate('reader', { voiceId: '', rate: 1 });
  const wrapper = new FakeElement('div');
  const hostile = new FakeElement('div', {
    attributes: { 'data-audita-persona-owned': 'audita-accessible-preview-v1' },
    classes: ['audita-persona-reader-overlay'],
  });
  wrapper.append(hostile);
  assignDocument(wrapper, fixture.document);
  observer.callback([{ type: 'childList', target: nestedTarget, addedNodes: [wrapper], removedNodes: [] }]);
  assert.equal(content.getState().activeMode, null);
});

test('root ownership attribute and active mode class remain enforced lifecycle invariants', async () => {
  const namespace = await loadContentFactory();
  for (const tamper of ['remove-root', 'change-root', 'remove-mode-class']) {
    const fixture = fixturePage();
    let observer;
    class FakeMutationObserver {
      constructor(callback) { this.callback = callback; observer = this; }
      observe() {}
      disconnect() { this.disconnected = true; }
    }
    const content = namespace.createContentRuntime({
      document: fixture.document, window: fixture.document.defaultView,
      speechSynthesis: null, MutationObserver: FakeMutationObserver,
    });
    content.activate('motor');
    if (tamper === 'remove-root') {
      fixture.document.documentElement.removeAttribute('data-audita-persona-root');
      observer.callback([{
        type: 'attributes', target: fixture.document.documentElement,
        attributeName: 'data-audita-persona-root',
      }]);
    } else if (tamper === 'change-root') {
      fixture.document.documentElement.setAttribute('data-audita-persona-root', 'site-tamper');
      observer.callback([{
        type: 'attributes', target: fixture.document.documentElement,
        attributeName: 'data-audita-persona-root',
      }]);
    } else {
      fixture.document.documentElement.classList.remove('audita-persona-motor');
      observer.callback([{ type: 'attributes', target: fixture.document.documentElement, attributeName: 'class' }]);
    }
    assert.equal(content.getState().activeMode, null, tamper);
  }
});

test('bounded DOM discovery reports an explicit truncation limitation with a count', async () => {
  const namespace = await loadContentFactory();
  const body = element('body', 'large-body', null);
  for (let index = 0; index < 2_010; index += 1) {
    body.append(element('button', `large-${index}`, `Botão ${index}`));
  }
  const document = new FakeDocument(body);
  const content = namespace.createContentRuntime({ document, window: document.defaultView, speechSynthesis: null });
  const queue = content.collectReaderCandidates();
  assert.equal(queue.length, 2_000);
  const limitation = content.getLimitations().find(item => item.code === 'dom-traversal-truncated');
  assert.ok(limitation);
  assert.equal(limitation.truncated, true);
  assert.ok(Number.isSafeInteger(limitation.count) && limitation.count >= 10);
});

test('content messaging rejects nested accessors/replayed initialize and uses only a correlated port for captions', async () => {
  const namespace = await loadContentFactory();
  const fixture = fixturePage();
  const onMessage = hook();
  const onConnect = hook();
  const broadcasts = [];
  const chromeApi = {
    runtime: {
      id: 'test-extension', onMessage, onConnect,
      sendMessage(message) { broadcasts.push(message); },
    },
  };
  const content = namespace.createContentRuntime({
    document: fixture.document,
    window: fixture.document.defaultView,
    speechSynthesis: null,
  });
  content.installMessaging(chromeApi);
  const initialize = contentCommand('initialize', 'init-1', 1, {});
  let firstResponse;
  assert.equal(onMessage.fireWithResult(initialize, { id: 'test-extension' }, value => { firstResponse = value; }), true);
  assert.equal(firstResponse.ok, true);
  const contentPort = createEventPort();
  onConnect.fire(contentPort);
  contentPort.onMessage.fire({
    protocol: 'audita-persona-content', version: 1, type: 'bind-events',
    token: 'content-token', generation: 1, documentId: 'content-document',
  });
  assert.equal(JSON.stringify(contentPort.posted.at(-1)), JSON.stringify({
    protocol: 'audita-persona-content', version: 1, type: 'events-bound',
    token: 'content-token', generation: 1, documentId: 'content-document',
  }));
  let replayResponse;
  onMessage.fireWithResult(initialize, { id: 'test-extension' }, value => { replayResponse = value; });
  assert.equal(replayResponse.code, 'PERSONA_REPLAY_REJECTED');

  let reads = 0;
  const hostileArgs = {};
  Object.defineProperty(hostileArgs, 'mode', { enumerable: true, get() { reads += 1; return 'reader'; } });
  const hostile = contentCommand('activate', 'nested-accessor', 2, hostileArgs);
  assert.equal(onMessage.fireWithResult(hostile, { id: 'test-extension' }, () => {}), false);
  assert.equal(reads, 0);

  const activate = contentCommand('activate', 'activate-1', 2, { mode: 'reader', preferences: { voiceId: '', rate: 1 } });
  let activeResponse;
  onMessage.fireWithResult(activate, { id: 'test-extension' }, value => { activeResponse = value; });
  assert.equal(activeResponse.ok, true);
  assert.equal(structuredCloneCalls, 0, 'validação por descritores não delega a clone que possa ler getters');
  assert.equal(broadcasts.length, 0);
  assert.ok(contentPort.posted.some(message => message.type === 'event' && message.state?.reader?.caption === 'Positivo um, botão'));
  assert.ok(contentPort.posted.every(message => message.token === 'content-token' && message.documentId === 'content-document'));
  assert.doesNotMatch(JSON.stringify(contentPort.posted), /SEGREDO-(?:WIDGET|OTP)/iu);

  const duplicatePort = createEventPort();
  onConnect.fire(duplicatePort);
  duplicatePort.onMessage.fire({
    protocol: 'audita-persona-content', version: 1, type: 'bind-events',
    token: 'content-token', generation: 2, documentId: 'content-document',
  });
  assert.equal(duplicatePort.disconnectCalls, 1, 'uma segunda porta não substitui o canal já correlacionado');

  let bindGetterReads = 0;
  const hostilePort = createEventPort();
  onConnect.fire(hostilePort);
  const hostileBinding = {};
  Object.defineProperty(hostileBinding, 'token', {
    enumerable: true, get() { bindGetterReads += 1; return 'content-token'; },
  });
  hostilePort.onMessage.fire(hostileBinding);
  assert.equal(bindGetterReads, 0);
  assert.equal(hostilePort.disconnectCalls, 1);

  contentPort.disconnect();
  assert.equal(content.getState().activeMode, null, 'morte do worker encerra a persona localmente');
  assert.equal(fixture.document.body.children.filter(node => node.hasAttribute('data-audita-persona-owned')).length, 0);
  const reinitialize = {
    ...contentCommand('initialize', 'init-after-worker-restart', 1, {}),
    token: 'content-token-restarted', documentId: 'content-document-restarted',
  };
  let restartResponse;
  onMessage.fireWithResult(reinitialize, { id: 'test-extension' }, value => { restartResponse = value; });
  assert.equal(restartResponse.ok, true);
  const restartedPort = createEventPort();
  onConnect.fire(restartedPort);
  restartedPort.onMessage.fire({
    protocol: 'audita-persona-content', version: 1, type: 'bind-events',
    token: 'content-token-restarted', generation: 1, documentId: 'content-document-restarted',
  });
  const restartActivation = {
    ...contentCommand('activate', 'activate-after-worker-restart', 2, { mode: 'motor', preferences: { voiceId: '', rate: 1 } }),
    token: 'content-token-restarted', documentId: 'content-document-restarted',
  };
  onMessage.fireWithResult(restartActivation, { id: 'test-extension' }, () => {});
  assert.equal(content.getState().activeMode, 'motor');
});

test('reader artifacts are owned, aria-hidden, pointer-transparent by CSS contract and cleaned idempotently', async () => {
  const namespace = await loadContentFactory();
  const fixture = fixturePage();
  const content = namespace.createContentRuntime({
    document: fixture.document,
    window: fixture.document.defaultView,
    emitEvent() {},
    speechSynthesis: null,
  });
  const active = content.activate('reader', { voiceId: '', rate: 1 });
  assert.equal(active.activeMode, 'reader');
  const owned = fixture.document.body.children.filter(node => node.hasAttribute('data-audita-persona-owned'));
  assert.equal(owned.length, 2);
  assert.ok(owned.every(node => node.getAttribute('aria-hidden') === 'true'));
  assert.ok(owned.every(node => node.getAttribute('tabindex') === '-1'));
  assert.ok(owned.every(node => !node.childNodes.some(child => child.nodeType === 3)), 'legenda não é copiada para o DOM auditado');
  content.stop('requested');
  content.stop('again');
  assert.equal(fixture.document.body.children.filter(node => node.hasAttribute('data-audita-persona-owned')).length, 0);
  assert.equal(fixture.document.documentElement.hasAttribute('aria-hidden'), false);
  assert.equal(fixture.document.documentElement.hasAttribute('inert'), false);
});

test('lifecycle boundary stops on relevant attributes, open-shadow mutations, SPA and pagehide but ignores owned artifacts', async () => {
  const namespace = await loadContentFactory();
  const fixture = fixturePage();
  const observers = [];
  const messages = [];
  const nestedContainer = element('div', 'nested-container', null);
  fixture.document.body.append(nestedContainer);
  class FakeMutationObserver {
    constructor(callback) { this.callback = callback; this.observed = []; observers.push(this); }
    observe(target, init) { this.observed.push({ target, init }); }
    disconnect() { this.disconnected = true; }
  }
  const content = namespace.createContentRuntime({
    document: fixture.document, window: fixture.document.defaultView,
    emitEvent: message => messages.push(message), speechSynthesis: null,
    MutationObserver: FakeMutationObserver,
  });

  content.activate('reader', { voiceId: '', rate: 1 });
  let observer = observers.at(-1);
  assert.ok(observer.observed.some(entry => entry.target === fixture.shadowRoot), 'Shadow DOM aberto já descoberto é observado');
  const owned = fixture.document.body.children.find(node => node.hasAttribute('data-audita-persona-owned'));
  observer.callback([{ type: 'attributes', target: owned, attributeName: 'style' }]);
  assert.equal(content.getState().activeMode, 'reader', 'atributos dos artefatos próprios não invalidam a persona');
  observer.callback([{ type: 'attributes', target: fixture.nodes.natural, attributeName: 'aria-label' }]);
  assert.equal(content.getState().activeMode, null);
  assert.equal(observer.disconnected, true);

  content.activate('reader', { voiceId: '', rate: 1 });
  observer = observers.at(-1);
  observer.callback([{ type: 'characterData', target: fixture.nodes.natural.childNodes[0] }]);
  assert.equal(content.getState().activeMode, null, 'texto que pode alterar anúncio invalida a fila');

  content.activate('reader', { voiceId: '', rate: 1 });
  observer = observers.at(-1);
  observer.callback([{ type: 'attributes', target: fixture.nodes.positiveOne, attributeName: 'style' }]);
  assert.equal(content.getState().activeMode, null, 'classe/estilo que pode ocultar item corrente invalida a fila');

  content.activate('reader', { voiceId: '', rate: 1 });
  observer = observers.at(-1);
  const nestedWrapper = element('div', 'nested-wrapper', null);
  nestedWrapper.append(element('button', 'nested-new-button', 'Novo candidato aninhado'));
  observer.callback([{ type: 'childList', target: nestedContainer, addedNodes: [nestedWrapper], removedNodes: [] }]);
  assert.equal(content.getState().activeMode, null, 'inserção navegável aninhada invalida a fila determinística');

  content.activate('motor');
  observer = observers.at(-1);
  const addedInShadow = element('button', 'late-shadow', 'Novo no shadow');
  observer.callback([{ type: 'childList', target: fixture.shadowRoot, addedNodes: [addedInShadow], removedNodes: [] }]);
  assert.equal(content.getState().activeMode, null);

  content.activate('achromatopsia');
  fixture.document.dispatchWindow('popstate');
  assert.equal(content.getState().activeMode, null);
  assert.equal(messages.at(-1).event, 'lifecycle-stop');

  content.activate('motor');
  fixture.document.dispatchWindow('pagehide');
  assert.equal(content.getState().activeMode, null);
  assert.doesNotThrow(() => content.stop('after-pagehide'));
});

test('a page-controlled owned attribute never suppresses material lifecycle invalidation', async () => {
  const namespace = await loadContentFactory();
  for (const mutationKind of ['attribute', 'text', 'child']) {
    const fixture = fixturePage();
    let observer;
    class FakeMutationObserver {
      constructor(callback) { this.callback = callback; observer = this; }
      observe() {}
      disconnect() { this.disconnected = true; }
    }
    const content = namespace.createContentRuntime({
      document: fixture.document, window: fixture.document.defaultView,
      speechSynthesis: null, MutationObserver: FakeMutationObserver,
    });
    assert.equal(content.activate('reader', { voiceId: '', rate: 1 }).activeMode, 'reader');
    fixture.document.body.setAttribute('data-audita-persona-owned', 'audita-accessible-preview-v1');
    if (mutationKind === 'attribute') {
      observer.callback([{ type: 'attributes', target: fixture.document.body, attributeName: 'aria-label' }]);
    } else if (mutationKind === 'text') {
      observer.callback([{ type: 'characterData', target: fixture.nodes.natural.childNodes[0] }]);
    } else {
      const added = element('button', 'site-added', 'Adicionado pela página');
      observer.callback([{ type: 'childList', target: fixture.document.body, addedNodes: [added], removedNodes: [] }]);
    }
    assert.equal(content.getState().activeMode, null, mutationKind);
  }
});

test('tampering with a real reader artifact always fails closed', async () => {
  const namespace = await loadContentFactory();
  for (const tamper of ['aria-hidden', 'tabindex', 'class', 'content']) {
    const fixture = fixturePage();
    let observer;
    class FakeMutationObserver {
      constructor(callback) { this.callback = callback; observer = this; }
      observe() {}
      disconnect() { this.disconnected = true; }
    }
    const content = namespace.createContentRuntime({
      document: fixture.document, window: fixture.document.defaultView,
      speechSynthesis: null, MutationObserver: FakeMutationObserver,
    });
    content.activate('reader', { voiceId: '', rate: 1 });
    const artifact = fixture.document.body.children.find(node => node.hasAttribute('data-audita-persona-owned'));
    if (tamper === 'aria-hidden') {
      artifact.setAttribute('aria-hidden', 'false');
      observer.callback([{ type: 'attributes', target: artifact, attributeName: 'aria-hidden' }]);
    } else if (tamper === 'tabindex') {
      artifact.setAttribute('tabindex', '0');
      observer.callback([{ type: 'attributes', target: artifact, attributeName: 'tabindex' }]);
    } else if (tamper === 'class') {
      artifact.classList.add('site-tamper');
      observer.callback([{ type: 'attributes', target: artifact, attributeName: 'class' }]);
    } else {
      const injectedText = text('conteúdo hostil');
      artifact.append(injectedText);
      observer.callback([{ type: 'childList', target: artifact, addedNodes: [injectedText], removedNodes: [] }]);
    }
    assert.equal(content.getState().activeMode, null, tamper);
  }
});

test('observer bounds fail closed instead of hiding a material mutation beyond the cap', async () => {
  const namespace = await loadContentFactory();
  for (const overflowKind of ['records', 'nested-children']) {
    const fixture = fixturePage();
    const mutationTarget = element('div', `overflow-target-${overflowKind}`, null);
    fixture.document.body.append(mutationTarget);
    let observer;
    class FakeMutationObserver {
      constructor(callback) { this.callback = callback; observer = this; }
      observe() {}
      disconnect() { this.disconnected = true; }
    }
    const content = namespace.createContentRuntime({
      document: fixture.document, window: fixture.document.defaultView,
      speechSynthesis: null, MutationObserver: FakeMutationObserver,
    });
    content.activate('reader', { voiceId: '', rate: 1 });
    if (overflowKind === 'records') {
      const records = Array.from({ length: 128 }, () => ({
        type: 'attributes', target: fixture.nodes.natural, attributeName: 'data-neutral',
      }));
      records.push({ type: 'attributes', target: fixture.nodes.natural, attributeName: 'aria-label' });
      observer.callback(records);
    } else {
      const wrapper = new FakeElement('div');
      for (let index = 0; index < 513; index += 1) wrapper.append(new FakeElement('div'));
      wrapper.append(element('button', 'overflow-final-button', 'Candidato após o limite'));
      assignDocument(wrapper, fixture.document);
      observer.callback([{ type: 'childList', target: mutationTarget, addedNodes: [wrapper], removedNodes: [] }]);
    }
    assert.equal(content.getState().activeMode, null, overflowKind);
  }
});

test('reader with an empty queue can explicitly recollect and start after safe DOM content appears', async () => {
  const namespace = await loadContentFactory();
  const body = element('body', 'empty-body', null);
  const document = new FakeDocument(body);
  const content = namespace.createContentRuntime({
    document, window: document.defaultView, emitEvent() {}, speechSynthesis: null,
  });
  const empty = content.activate('reader', { voiceId: '', rate: 1 });
  assert.equal(empty.activeMode, 'reader');
  assert.equal(empty.reader.playback, 'idle');
  assert.equal(empty.reader.total, 0);
  body.append(element('button', 'late-button', 'Botão adicionado'));
  const restarted = content.readerAction('start');
  assert.equal(restarted.reader.playback, 'playing');
  assert.equal(restarted.reader.total, 1);
  assert.equal(restarted.reader.caption, 'Botão adicionado, botão');
  content.stop('done');
  assert.equal(document.body.children.filter(node => node.hasAttribute('data-audita-persona-owned')).length, 0);
});

test('hostile speech bootstrap is never evaluated and visual reader fallback remains usable', async () => {
  const namespace = await loadContentFactory();
  const fixture = fixturePage();
  let speechReads = 0;
  let utteranceReads = 0;
  const environment = {
    document: fixture.document,
    window: fixture.document.defaultView,
    emitEvent() {},
  };
  Object.defineProperty(environment, 'speechSynthesis', {
    enumerable: true,
    get() { speechReads += 1; throw new Error('PRIVATE_SPEECH_BOOTSTRAP'); },
  });
  Object.defineProperty(environment, 'Utterance', {
    enumerable: true,
    get() { utteranceReads += 1; throw new Error('PRIVATE_UTTERANCE_BOOTSTRAP'); },
  });

  let content;
  assert.doesNotThrow(() => { content = namespace.createContentRuntime(environment); });
  const active = content.activate('reader', { voiceId: '', rate: 1 });

  assert.equal(speechReads, 0);
  assert.equal(utteranceReads, 0);
  assert.equal(active.activeMode, 'reader');
  assert.equal(active.reader.playback, 'playing');
  assert.equal(active.reader.caption, 'Positivo um, botão');
  assert.equal(active.reader.speechAvailability, 'unavailable');
  assert.equal(fixture.document.body.children.filter(node => node.hasAttribute('data-audita-persona-owned')).length, 2);
  assert.equal(content.readerAction('next').reader.index, 1);
});

test('voice inventory changes use the trusted inherited EventTarget listener', async () => {
  const listeners = new Map();
  class FakeEventTarget {
    addEventListener(type, listener) { listeners.set(type, listener); }
    removeEventListener(type, listener) { if (listeners.get(type) === listener) listeners.delete(type); }
  }
  class SpeechSynthesis extends FakeEventTarget {
    getVoices() { return []; }
    speak() {}
    cancel() {}
    pause() {}
    resume() {}
    get speaking() { return false; }
    get pending() { return false; }
    get paused() { return false; }
  }
  const namespace = await loadContentFactory({ SpeechSynthesis });
  const fixture = fixturePage();
  const synthesis = new SpeechSynthesis();
  const content = namespace.createContentRuntime({
    document: fixture.document,
    window: fixture.document.defaultView,
    emitEvent() {},
    speechSynthesis: synthesis,
  });

  content.activate('reader', { voiceId: '', rate: 1 });
  assert.equal(typeof listeners.get('voiceschanged'), 'function');
  content.stop('done');
  assert.equal(listeners.has('voiceschanged'), false);
});

function event(init) {
  return {
    ...init,
    prevented: false,
    stopped: false,
    preventDefault() { this.prevented = true; },
    stopImmediatePropagation() { this.stopped = true; },
  };
}

function hook() {
  const listeners = [];
  return {
    addListener(listener) { listeners.push(listener); },
    removeListener(listener) { const index = listeners.indexOf(listener); if (index >= 0) listeners.splice(index, 1); },
    fire(...args) { for (const listener of [...listeners]) listener(...args); },
    fireWithResult(...args) { return listeners[0]?.(...args); },
  };
}

function createEventPort() {
  const onMessage = hook();
  const onDisconnect = hook();
  return {
    name: 'audita-persona-content-v1', sender: { id: 'test-extension' },
    onMessage, onDisconnect, posted: [], disconnectCalls: 0,
    postMessage(message) { this.posted.push(message); },
    disconnect() { this.disconnectCalls += 1; onDisconnect.fire(); },
  };
}

function contentCommand(command, requestId, generation, args) {
  return {
    protocol: 'audita-persona-content', version: 1, type: 'command', requestId,
    token: 'content-token', generation, documentId: 'content-document', command, args,
  };
}
