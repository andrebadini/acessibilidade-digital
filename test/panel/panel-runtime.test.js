import assert from 'node:assert/strict';
import test from 'node:test';

import { createInitialPanelState, reducePanelState } from '../../src/panel/panel-state.js';

const priorDocument = globalThis.document;
globalThis.document = { querySelector() { return null; } };
const runtime = await import(`../../src/panel/panel.js?panel-runtime-test=${Date.now()}`);
if (priorDocument === undefined) delete globalThis.document;
else globalThis.document = priorDocument;

const {
  createPanelAuditDeletionController,
  createPanelAttachedAuditIntent,
  createPanelBatchAuditIntent,
  createPanelUrlAuditIntent,
  createPanelPrivacyConfirmationController,
  normalizePanelUrlEntry,
  normalizePanelBatchEntry,
  projectPanelAuditProgressEvent,
  projectPanelBootstrapEvent,
  shouldShowPanelStartFailure,
} = runtime;

const PRIVACY_MESSAGE = 'A página contém conteúdo potencialmente sensível. Confirme para capturar imagens visíveis.';

function pausedState(mode = 'full-evidence', categories = ['password']) {
  let state = reducePanelState(createInitialPanelState(), {
    type: 'CAPTURE_MODE_SELECTED', mode, focusId: `capture-mode-${mode}`,
  });
  state = reducePanelState(state, { type: 'START_REQUESTED', source: 'attached' });
  state = reducePanelState(state, { type: 'AUDIT_RUNNING', auditId: 'audit-private' });
  return reducePanelState(state, {
    type: 'PRIVACY_PAUSED', auditId: 'audit-private', mode, categories, message: PRIVACY_MESSAGE,
  });
}

function deferred() {
  let resolve;
  const promise = new Promise(settle => { resolve = settle; });
  return { promise, resolve };
}

function kebab(value) { return value.replace(/[A-Z]/gu, letter => `-${letter.toLowerCase()}`); }

class RuntimeElement {
  constructor(tagName, document) {
    this.tagName = String(tagName).toUpperCase();
    this.ownerDocument = document;
    this.children = [];
    this.attributes = new Map();
    this.listeners = new Map();
    this.className = '';
    this.scrollTop = 0;
    this.value = '';
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
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  hasAttribute(name) { return this.attributes.has(name); }
  append(...children) { for (const child of children) this.appendChild(child); }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  focus() { this.ownerDocument.activeElement = this; }
  async dispatch(type) {
    for (const listener of this.listeners.get(type) ?? []) {
      await listener({ currentTarget: this, preventDefault() {} });
    }
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  querySelectorAll(selector) {
    const output = [];
    const tag = selector.match(/^[a-z]+/iu)?.[0]?.toUpperCase();
    const attributes = [...selector.matchAll(/\[([^\]=]+)(?:="([^"]*)")?\]/gu)];
    const visit = node => {
      if (node !== this && (!tag || node.tagName === tag) && attributes.every(match => {
        const [, name, expected] = match;
        return node.hasAttribute(name) && (expected === undefined || node.getAttribute(name) === expected);
      })) output.push(node);
      for (const child of node.children) visit(child);
    };
    visit(this);
    return output;
  }
}

function runtimeEvent() {
  const listeners = [];
  return {
    addListener(listener) { listeners.push(listener); },
    removeListener(listener) {
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
    },
    emit(...args) { for (const listener of [...listeners]) listener(...args); },
  };
}

test('waits for the first valid bootstrap before exposing authorized panel actions', async t => {
  const originalDocument = globalThis.document;
  const originalChrome = globalThis.chrome;
  const originalLocation = globalThis.location;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  t.after(() => {
    if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument;
    if (originalChrome === undefined) delete globalThis.chrome; else globalThis.chrome = originalChrome;
    if (originalLocation === undefined) delete globalThis.location; else globalThis.location = originalLocation;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  });

  const document = {
    activeElement: null,
    createElement(tagName) { return new RuntimeElement(tagName, document); },
    querySelector(selector) { return selector === '#panel-root' ? document.root : null; },
  };
  document.root = new RuntimeElement('main', document);
  const timers = [];
  globalThis.setTimeout = (callback, delay) => {
    const timer = { callback, delay, cleared: false };
    timers.push(timer);
    return timer;
  };
  globalThis.clearTimeout = timer => { timer.cleared = true; };
  const ports = [];
  const chrome = {
    runtime: {
      id: 'abcdefghijklmnopabcdefghijklmnop',
      connect({ name }) {
        const port = {
          name, posted: [], onMessage: runtimeEvent(), onDisconnect: runtimeEvent(),
          postMessage(message) { this.posted.push(structuredClone(message)); },
          disconnects: 0,
          disconnect() { this.disconnects += 1; },
        };
        ports.push(port);
        return port;
      },
    },
  };
  globalThis.document = document;
  globalThis.chrome = chrome;
  globalThis.location = {
    href: `chrome-extension://${chrome.runtime.id}/src/panel/index.html?launch=${'A'.repeat(43)}`,
  };

  await import(`../../src/panel/panel.js?initial-bootstrap-gate=${Date.now()}`);
  assert.deepEqual(ports.map(port => port.name), ['audita-panel-v1']);
  const firstPort = ports[0];
  assert.ok(document.root.querySelector('[data-screen="connecting"]'));
  assert.match(document.root.textContent, /Preparando o painel/iu);
  assert.doesNotMatch(document.root.textContent, /Página alterada|resultado local está sendo recuperado/iu);
  assert.equal(document.root.querySelectorAll('button').length, 0);
  assert.equal(document.root.querySelector('form[id="audit-form"]'), null);
  assert.equal(document.root.querySelector('button[data-action="start-url-audit"]'), null);

  const firstWatchdog = timers[0];
  assert.equal(firstWatchdog.delay, 5000);
  firstWatchdog.callback();
  assert.equal(firstPort.disconnects, 1);
  assert.ok(document.root.querySelector('[data-screen="connecting"]'));
  assert.equal(document.root.querySelectorAll('button').length, 0);
  const reconnect = timers.at(-1);
  assert.equal(reconnect.delay, 250);
  reconnect.callback();
  assert.equal(ports.length, 2);
  const port = ports[1];
  assert.equal(timers.at(-1).delay, 5000);

  port.onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'bootstrap-result', state: 'initial',
    auditId: null, sessionCapabilityId: null, result: null,
  });
  assert.ok(document.root.querySelector('[data-screen="initial"]'));
  const personaPrepare = port.posted.find(packet =>
    packet?.envelope?.type === 'PREPARE_PANEL_PERSONA_CAPABILITY');
  if (personaPrepare) port.onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'intent-result', requestId: personaPrepare.requestId,
    response: { ok: false, code: 'PERSONA_NOT_FOUND' },
  });
  await new Promise(resolve => setImmediate(resolve));

  await document.root.querySelector('button[data-intent="OPEN_URL_FORM"]').dispatch('click');
  const form = document.root.querySelector('form[id="audit-form"]');
  const url = document.root.querySelector('input[id="audit-url"]');
  const submit = document.root.querySelector('button[data-action="start-url-audit"]');
  assert.ok(form);
  assert.ok(url);
  assert.ok(submit);
  assert.equal(submit.hasAttribute('disabled'), false);
  url.value = 'https://example.test/bootstrap-ready';
  await form.dispatch('submit');

  const prepare = port.posted.find(packet =>
    packet?.envelope?.type === 'PREPARE_PANEL_NAVIGATION_CAPABILITY');
  assert.ok(prepare);
  port.onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'intent-result', requestId: prepare.requestId,
    response: { ok: false, code: 'TARGET_UNAVAILABLE' },
  });
  await new Promise(resolve => setImmediate(resolve));

  port.onDisconnect.emit();
  assert.ok(document.root.querySelector('[data-screen="reconnecting"]'));
  assert.match(document.root.textContent, /Página alterada|Reconectando o painel/iu);
  assert.equal(document.root.querySelectorAll('button').length, 0);

  const reconnectAfterBootstrap = timers.at(-1);
  assert.equal(reconnectAfterBootstrap.delay, 250);
  reconnectAfterBootstrap.callback();
  const reconnectedPort = ports.at(-1);
  reconnectedPort.onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'bootstrap-result', state: 'initial',
    auditId: null, sessionCapabilityId: null, result: null,
  });
  assert.ok(document.root.querySelector('[data-screen="initial"]'));
  assert.ok(document.root.querySelector('form[id="audit-form"]'));
  assert.ok(document.root.querySelector('button[data-action="start-url-audit"]'));
});

test('shows terminal static unavailability after all pre-bootstrap Port attempts time out', async t => {
  const originalDocument = globalThis.document;
  const originalChrome = globalThis.chrome;
  const originalLocation = globalThis.location;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  t.after(() => {
    if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument;
    if (originalChrome === undefined) delete globalThis.chrome; else globalThis.chrome = originalChrome;
    if (originalLocation === undefined) delete globalThis.location; else globalThis.location = originalLocation;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  });

  const document = {
    activeElement: null,
    createElement(tagName) { return new RuntimeElement(tagName, document); },
    querySelector(selector) { return selector === '#panel-root' ? document.root : null; },
  };
  document.root = new RuntimeElement('main', document);
  const timers = [];
  globalThis.setTimeout = (callback, delay) => {
    const timer = { callback, delay, cleared: false };
    timers.push(timer);
    return timer;
  };
  globalThis.clearTimeout = timer => { timer.cleared = true; };
  const ports = [];
  const chrome = {
    runtime: {
      id: 'abcdefghijklmnopabcdefghijklmnop',
      connect({ name }) {
        const port = {
          name, posted: [], onMessage: runtimeEvent(), onDisconnect: runtimeEvent(), disconnects: 0,
          postMessage(message) { this.posted.push(structuredClone(message)); },
          disconnect() { this.disconnects += 1; },
        };
        ports.push(port);
        return port;
      },
    },
  };
  globalThis.document = document;
  globalThis.chrome = chrome;
  globalThis.location = {
    href: `chrome-extension://${chrome.runtime.id}/src/panel/index.html?launch=${'A'.repeat(43)}`,
  };

  await import(`../../src/panel/panel.js?bootstrap-exhausted=${Date.now()}`);

  const reconnectDelays = [250, 500, 1000, 2000, 5000];
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const watchdog = timers.at(-1);
    assert.equal(watchdog.delay, 5000);
    watchdog.callback();
    assert.equal(ports.at(-1).disconnects, 1);
    assert.equal(document.root.querySelectorAll('button').length, 0);
    if (attempt === reconnectDelays.length) continue;
    assert.ok(document.root.querySelector('[data-screen="connecting"]'));
    const reconnect = timers.at(-1);
    assert.equal(reconnect.delay, reconnectDelays[attempt]);
    reconnect.callback();
  }

  assert.equal(ports.length, 6);
  assert.equal(timers.length, 11);
  assert.ok(document.root.querySelector('[data-screen="unavailable"]'));
  assert.match(document.root.textContent, /Painel indisponível/iu);
  assert.doesNotMatch(document.root.textContent, /Preparando|Reconectando/iu);
  assert.equal(document.root.querySelector('form[id="audit-form"]'), null);
  assert.equal(document.root.querySelector('button[data-action="start-url-audit"]'), null);
});

test('builds the exact attached start envelope from each user-selected capture mode', () => {
  for (const mode of ['full-evidence', 'element-only', 'no-pixels']) {
    assert.deepEqual(createPanelAttachedAuditIntent({
      capabilityId: 'C'.repeat(22), captureMode: mode,
    }), {
      type: 'PANEL_START_ATTACHED_AUDIT', capabilityId: 'C'.repeat(22), captureMode: mode,
      includeQuery: false, deleteAfterCompleteExport: false,
    });
  }
  for (const input of [
    { capabilityId: 'short', captureMode: 'full-evidence' },
    { capabilityId: 'C'.repeat(22), captureMode: 'pixels' },
    { capabilityId: 'C'.repeat(22), captureMode: 'full-evidence', extra: 'PRIVATE' },
  ]) assert.equal(createPanelAttachedAuditIntent(input), null);
});

test('normalizes one transient URL and builds the exact start envelope for each capture mode', () => {
  assert.deepEqual(normalizePanelUrlEntry(' https://example.test/path?q=private '), {
    ok: true, url: 'https://example.test/path?q=private',
  });
  assert.deepEqual(normalizePanelUrlEntry('https://example.test'), {
    ok: true, url: 'https://example.test/',
  });
  for (const [value, code] of [
    ['', 'required'], ['   ', 'required'], ['x'.repeat(2_049), 'too-long'],
    ['example.test', 'invalid'], ['file:///private', 'invalid'], ['https://user:pass@example.test/', 'invalid'],
  ]) assert.deepEqual(normalizePanelUrlEntry(value), { ok: false, code });
  assert.equal(normalizePanelUrlEntry({ toString() { throw new Error('PRIVATE'); } }).ok, false);

  const input = { capabilityId: 'C'.repeat(22), url: 'https://example.test/path?q=private' };
  for (const captureMode of ['full-evidence', 'element-only', 'no-pixels']) {
    assert.deepEqual(createPanelUrlAuditIntent({ ...input, captureMode }), {
      type: 'PANEL_START_URL_AUDIT', capabilityId: 'C'.repeat(22),
      url: 'https://example.test/path?q=private', captureMode,
      includeQuery: false, deleteAfterCompleteExport: false,
    });
  }
  for (const invalid of [
    { ...input, captureMode: 'pixels' },
    { ...input, captureMode: 'full-evidence', capabilityId: 'short' },
    { ...input, captureMode: 'full-evidence', url: 'file:///private' },
    { ...input, captureMode: 'full-evidence', extra: 'secret' },
  ]) assert.equal(createPanelUrlAuditIntent(invalid), null);
});

test('normalizes 2–20 explicit batch URLs and builds only the exact no-pixels envelope', () => {
  const raw = [
    ' https://one.example/private?token=alpha ',
    'https://two.example',
    'https://one.example/private?token=alpha',
  ].join('\n');
  assert.deepEqual(normalizePanelBatchEntry(raw), {
    ok: true,
    urls: [
      'https://one.example/private?token=alpha',
      'https://two.example/',
      'https://one.example/private?token=alpha',
    ].join('\n'),
    total: 2,
  });
  for (const [value, code] of [
    ['', 'required'],
    ['https://one.example', 'too-few'],
    [Array.from({ length: 21 }, (_value, index) => `https://example${index}.test`).join('\n'), 'too-many'],
  ]) {
    const result = normalizePanelBatchEntry(value);
    assert.equal(result.ok, false);
    assert.equal(result.code, code);
    assert.equal(Object.hasOwn(result, 'urls'), false);
  }
  const invalid = normalizePanelBatchEntry([
    'https://one.example', 'file:///private', 'https://user:pass@two.example', 'x'.repeat(2_049),
  ].join('\n'));
  assert.deepEqual(invalid, {
    ok: false, code: 'invalid-lines',
    lines: [{ line: 2, code: 'invalid' }, { line: 3, code: 'invalid' }, { line: 4, code: 'too-long' }],
  });
  assert.doesNotMatch(JSON.stringify(invalid), /user:pass|file:\/\/\/private/u);

  const urls = normalizePanelBatchEntry(raw).urls;
  assert.deepEqual(createPanelBatchAuditIntent({ capabilityId: 'C'.repeat(22), urls }), {
    type: 'PANEL_START_BATCH_AUDIT', capabilityId: 'C'.repeat(22), urls,
    captureMode: 'no-pixels', includeQuery: false, deleteAfterCompleteExport: false,
  });
  for (const invalidIntent of [
    { capabilityId: 'short', urls },
    { capabilityId: 'C'.repeat(22), urls, captureMode: 'full-evidence' },
    { capabilityId: 'C'.repeat(22), urls, extra: 'PRIVATE' },
  ]) assert.equal(createPanelBatchAuditIntent(invalidIntent), null);
});

test('starts a batch through an authorized capability and announces safe total and warnings', async t => {
  const originalDocument = globalThis.document;
  const originalChrome = globalThis.chrome;
  const originalLocation = globalThis.location;
  t.after(() => {
    if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument;
    if (originalChrome === undefined) delete globalThis.chrome; else globalThis.chrome = originalChrome;
    if (originalLocation === undefined) delete globalThis.location; else globalThis.location = originalLocation;
  });
  const document = {
    activeElement: null,
    createElement(tagName) { return new RuntimeElement(tagName, document); },
    querySelector(selector) { return selector === '#panel-root' ? document.root : null; },
  };
  document.root = new RuntimeElement('main', document);
  const ports = [];
  const chrome = {
    runtime: {
      id: 'abcdefghijklmnopabcdefghijklmnop',
      connect({ name }) {
        const port = {
          name, posted: [], onMessage: runtimeEvent(), onDisconnect: runtimeEvent(),
          postMessage(message) { this.posted.push(structuredClone(message)); }, disconnect() {},
        };
        ports.push(port);
        return port;
      },
    },
  };
  globalThis.document = document;
  globalThis.chrome = chrome;
  globalThis.location = { href: `chrome-extension://${chrome.runtime.id}/src/panel/index.html?launch=${'A'.repeat(43)}` };

  await import(`../../src/panel/panel.js?batch-start=${Date.now()}`);
  const port = ports[0];
  port.onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'bootstrap-result', state: 'initial',
    auditId: null, sessionCapabilityId: null, result: null,
  });
  const personaPrepare = port.posted.find(packet => packet?.envelope?.type === 'PREPARE_PANEL_PERSONA_CAPABILITY');
  if (personaPrepare) port.onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'intent-result', requestId: personaPrepare.requestId,
    response: { ok: false, code: 'PERSONA_NOT_FOUND' },
  });
  await new Promise(resolve => setImmediate(resolve));

  await document.root.querySelector('button[data-intent="OPEN_BATCH_FORM"]').dispatch('click');
  let textarea = document.root.querySelector('textarea[id="audit-urls"]');
  const rejectedUrls = 'https://one.example/private?token=alpha\nfile:///private';
  textarea.value = rejectedUrls;
  await textarea.dispatch('input');
  port.onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'bootstrap-result', state: 'initial',
    auditId: null, sessionCapabilityId: null, result: null,
  });
  textarea = document.root.querySelector('textarea[id="audit-urls"]');
  assert.equal(textarea.value, rejectedUrls, 'a benign re-render keeps a draft before its first submit');
  await document.root.querySelector('form[id="batch-audit-form"]').dispatch('submit');
  textarea = document.root.querySelector('textarea[id="audit-urls"]');
  assert.equal(textarea.value, rejectedUrls, 'safe validation re-render keeps the transient text only in the DOM/runtime');
  assert.match(document.root.textContent, /Linha 2/u);
  assert.doesNotMatch(document.root.textContent, /token=alpha|file:\/\/\/private/u);
  textarea.value = [
    'https://one.example/private?token=alpha',
    'https://two.example/private?token=beta',
    'https://one.example/private?token=alpha',
  ].join('\n');
  await document.root.querySelector('form[id="batch-audit-form"]').dispatch('submit');
  const prepare = port.posted.find(packet => packet?.envelope?.type === 'PREPARE_PANEL_NAVIGATION_CAPABILITY');
  assert.deepEqual(prepare.envelope, {
    type: 'PREPARE_PANEL_NAVIGATION_CAPABILITY', requestId: prepare.envelope.requestId, intent: 'batch',
  });
  port.onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'intent-result', requestId: prepare.requestId,
    response: { ok: true, requestId: prepare.envelope.requestId, capabilityId: 'C'.repeat(22) },
  });
  await new Promise(resolve => setImmediate(resolve));
  const start = port.posted.find(packet => packet?.envelope?.type === 'PANEL_START_BATCH_AUDIT');
  assert.deepEqual(start.envelope, {
    type: 'PANEL_START_BATCH_AUDIT', capabilityId: 'C'.repeat(22),
    urls: [
      'https://one.example/private?token=alpha',
      'https://two.example/private?token=beta',
      'https://one.example/private?token=alpha',
    ].join('\n'),
    captureMode: 'no-pixels', includeQuery: false, deleteAfterCompleteExport: false,
  });
  port.onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'intent-result', requestId: start.requestId,
    response: {
      ok: true, auditId: 'audit-batch-1', state: 'running', total: 2,
      warnings: [{
        line: 3, code: 'DUPLICATE_URL', firstLine: 1,
        message: 'A URL repete uma entrada anterior e não será auditada novamente.',
      }],
    },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(document.root.querySelector('[data-screen="running"]'));
  assert.match(document.root.textContent, /Avaliando lote/u);
  assert.match(document.root.textContent, /2 páginas/u);
  assert.match(document.root.textContent, /Linha 3/u);
  assert.doesNotMatch(document.root.textContent, /token=alpha|token=beta/u);
});

test('does not start residual URL navigation when the form closes before PREPARE resolves', async t => {
  const originalDocument = globalThis.document;
  const originalChrome = globalThis.chrome;
  const originalLocation = globalThis.location;
  t.after(() => {
    if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument;
    if (originalChrome === undefined) delete globalThis.chrome; else globalThis.chrome = originalChrome;
    if (originalLocation === undefined) delete globalThis.location; else globalThis.location = originalLocation;
  });

  const document = {
    activeElement: null,
    createElement(tagName) { return new RuntimeElement(tagName, document); },
    querySelector(selector) { return selector === '#panel-root' ? document.root : null; },
  };
  document.root = new RuntimeElement('main', document);
  const ports = [];
  const chrome = {
    runtime: {
      id: 'abcdefghijklmnopabcdefghijklmnop',
      connect({ name }) {
        const port = {
          name, posted: [], onMessage: runtimeEvent(), onDisconnect: runtimeEvent(),
          postMessage(message) { this.posted.push(structuredClone(message)); },
          disconnect() {},
        };
        ports.push(port);
        return port;
      },
    },
  };
  globalThis.document = document;
  globalThis.chrome = chrome;
  globalThis.location = {
    href: `chrome-extension://${chrome.runtime.id}/src/panel/index.html?launch=${'A'.repeat(43)}`,
  };

  await import(`../../src/panel/panel.js?url-form-race=${Date.now()}`);
  assert.deepEqual(ports.map(port => port.name), ['audita-panel-v1']);
  ports[0].onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'bootstrap-result', state: 'initial',
    auditId: null, sessionCapabilityId: null, result: null,
  });
  const personaPrepare = ports[0].posted.find(packet =>
    packet?.envelope?.type === 'PREPARE_PANEL_PERSONA_CAPABILITY');
  if (personaPrepare) ports[0].onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'intent-result', requestId: personaPrepare.requestId,
    response: { ok: false, code: 'PERSONA_NOT_FOUND' },
  });

  await document.root.querySelector('button[data-intent="OPEN_URL_FORM"]').dispatch('click');
  const noPixels = document.root.querySelector('input[data-capture-mode="no-pixels"]');
  noPixels.checked = true;
  await noPixels.dispatch('change');
  const url = document.root.querySelector('input[id="audit-url"]');
  url.value = 'https://example.test/path?transient=private';
  await document.root.querySelector('form[id="audit-form"]').dispatch('submit');

  const prepare = ports[0].posted.find(packet =>
    packet?.envelope?.type === 'PREPARE_PANEL_NAVIGATION_CAPABILITY');
  assert.ok(prepare);
  await document.root.querySelector('button[data-intent="CLOSE_URL_FORM"]').dispatch('click');
  await document.root.querySelector('button[data-intent="OPEN_URL_FORM"]').dispatch('click');
  ports[0].onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'intent-result', requestId: prepare.requestId,
    response: {
      ok: true, requestId: prepare.envelope.requestId, capabilityId: 'C'.repeat(22),
    },
  });
  await new Promise(resolve => setImmediate(resolve));

  const residualStart = ports[0].posted.find(packet => packet?.envelope?.type === 'PANEL_START_URL_AUDIT');
  if (residualStart) ports[0].onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'intent-result', requestId: residualStart.requestId,
    response: { ok: false, code: 'AUDIT_NOT_STARTED' },
  });
  assert.equal(Boolean(residualStart), false);
  assert.ok(document.root.querySelector('form[id="audit-form"]'));
  assert.doesNotMatch(document.root.textContent, /Abrindo o site|Gerando relatório/iu);

  const secondUrl = document.root.querySelector('input[id="audit-url"]');
  secondUrl.value = 'https://example.test/second?transient=private';
  await document.root.querySelector('form[id="audit-form"]').dispatch('submit');
  const prepares = ports[0].posted.filter(packet =>
    packet?.envelope?.type === 'PREPARE_PANEL_NAVIGATION_CAPABILITY');
  const secondPrepare = prepares.at(-1);
  assert.equal(prepares.length, 2);
  const changedMode = document.root.querySelector('input[data-capture-mode="full-evidence"]');
  changedMode.checked = true;
  await changedMode.dispatch('change');
  const restoredMode = document.root.querySelector('input[data-capture-mode="no-pixels"]');
  restoredMode.checked = true;
  await restoredMode.dispatch('change');
  ports[0].onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'intent-result', requestId: secondPrepare.requestId,
    response: {
      ok: true, requestId: secondPrepare.envelope.requestId, capabilityId: 'C'.repeat(22),
    },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ports[0].posted.filter(packet => packet?.envelope?.type === 'PANEL_START_URL_AUDIT').length, 0);

  const thirdUrl = document.root.querySelector('input[id="audit-url"]');
  thirdUrl.value = 'https://example.test/third?transient=private';
  await document.root.querySelector('form[id="audit-form"]').dispatch('submit');
  const thirdPrepare = ports[0].posted.filter(packet =>
    packet?.envelope?.type === 'PREPARE_PANEL_NAVIGATION_CAPABILITY').at(-1);
  const fourthUrl = document.root.querySelector('input[id="audit-url"]');
  fourthUrl.value = 'https://example.test/fourth?transient=private';
  await document.root.querySelector('form[id="audit-form"]').dispatch('submit');
  const allPrepares = ports[0].posted.filter(packet =>
    packet?.envelope?.type === 'PREPARE_PANEL_NAVIGATION_CAPABILITY');
  const fourthPrepare = allPrepares.at(-1);
  assert.equal(allPrepares.length, 4);
  assert.notEqual(thirdPrepare.requestId, fourthPrepare.requestId);

  ports[0].onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'intent-result', requestId: thirdPrepare.requestId,
    response: { ok: true, requestId: thirdPrepare.envelope.requestId, capabilityId: 'D'.repeat(22) },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ports[0].posted.filter(packet => packet?.envelope?.type === 'PANEL_START_URL_AUDIT').length, 0);
  ports[0].onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'intent-result', requestId: fourthPrepare.requestId,
    response: { ok: true, requestId: fourthPrepare.envelope.requestId, capabilityId: 'E'.repeat(22) },
  });
  await new Promise(resolve => setImmediate(resolve));
  const starts = ports[0].posted.filter(packet => packet?.envelope?.type === 'PANEL_START_URL_AUDIT');
  assert.equal(starts.length, 1);
  assert.equal(starts[0].envelope.url, 'https://example.test/fourth?transient=private');
  assert.equal(starts[0].envelope.captureMode, 'no-pixels');
  ports[0].onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'intent-result', requestId: starts[0].requestId,
    response: { ok: true, auditId: 'audit-fourth-submission', state: 'running' },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(document.root.querySelector('[data-screen="running"]'));
});

test('a duplicate idle bootstrap during URL PREPARE preserves the submitted form and starts once', async t => {
  const originalDocument = globalThis.document;
  const originalChrome = globalThis.chrome;
  const originalLocation = globalThis.location;
  t.after(() => {
    if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument;
    if (originalChrome === undefined) delete globalThis.chrome; else globalThis.chrome = originalChrome;
    if (originalLocation === undefined) delete globalThis.location; else globalThis.location = originalLocation;
  });

  const document = {
    activeElement: null,
    createElement(tagName) { return new RuntimeElement(tagName, document); },
    querySelector(selector) { return selector === '#panel-root' ? document.root : null; },
  };
  document.root = new RuntimeElement('main', document);
  const ports = [];
  const chrome = {
    runtime: {
      id: 'abcdefghijklmnopabcdefghijklmnop',
      connect({ name }) {
        const port = {
          name, posted: [], onMessage: runtimeEvent(), onDisconnect: runtimeEvent(),
          postMessage(message) { this.posted.push(structuredClone(message)); },
          disconnect() {},
        };
        ports.push(port);
        return port;
      },
    },
  };
  globalThis.document = document;
  globalThis.chrome = chrome;
  globalThis.location = {
    href: `chrome-extension://${chrome.runtime.id}/src/panel/index.html?launch=${'A'.repeat(43)}`,
  };

  await import(`../../src/panel/panel.js?url-idle-bootstrap-race=${Date.now()}`);
  const port = ports[0];
  const idleBootstrap = {
    protocol: 'audita-panel', version: 1, type: 'bootstrap-result', state: 'initial',
    auditId: null, sessionCapabilityId: null, result: null,
  };
  port.onMessage.emit(idleBootstrap);
  const personaPrepare = port.posted.find(packet =>
    packet?.envelope?.type === 'PREPARE_PANEL_PERSONA_CAPABILITY');
  if (personaPrepare) port.onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'intent-result', requestId: personaPrepare.requestId,
    response: { ok: false, code: 'PERSONA_NOT_FOUND' },
  });
  await new Promise(resolve => setImmediate(resolve));

  await document.root.querySelector('button[data-intent="OPEN_URL_FORM"]').dispatch('click');
  const elementOnly = document.root.querySelector('input[data-capture-mode="element-only"]');
  elementOnly.checked = true;
  await elementOnly.dispatch('change');
  const url = document.root.querySelector('input[id="audit-url"]');
  url.value = 'https://example.test/idle-bootstrap-race?transient=private';
  await document.root.querySelector('form[id="audit-form"]').dispatch('submit');
  const prepare = port.posted.find(packet =>
    packet?.envelope?.type === 'PREPARE_PANEL_NAVIGATION_CAPABILITY');
  assert.ok(prepare);

  port.onMessage.emit(idleBootstrap);
  assert.ok(document.root.querySelector('form[id="audit-form"]'),
    'an equivalent idle bootstrap must not discard the local submitted view');
  port.onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'intent-result', requestId: prepare.requestId,
    response: { ok: true, requestId: prepare.envelope.requestId, capabilityId: 'C'.repeat(22) },
  });
  await new Promise(resolve => setImmediate(resolve));

  const starts = port.posted.filter(packet => packet?.envelope?.type === 'PANEL_START_URL_AUDIT');
  assert.equal(starts.length, 1);
  assert.deepEqual(starts[0].envelope, {
    type: 'PANEL_START_URL_AUDIT', capabilityId: 'C'.repeat(22),
    url: 'https://example.test/idle-bootstrap-race?transient=private',
    captureMode: 'element-only', includeQuery: false, deleteAfterCompleteExport: false,
  });
  port.onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'intent-result', requestId: starts[0].requestId,
    response: { ok: true, auditId: 'audit-idle-bootstrap-race', state: 'running' },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(document.root.querySelector('[data-screen="running"]'));
});

test('benign persona synchronization during URL PREPARE does not discard the submitted start', async t => {
  const originalDocument = globalThis.document;
  const originalChrome = globalThis.chrome;
  const originalLocation = globalThis.location;
  t.after(() => {
    if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument;
    if (originalChrome === undefined) delete globalThis.chrome; else globalThis.chrome = originalChrome;
    if (originalLocation === undefined) delete globalThis.location; else globalThis.location = originalLocation;
  });

  const document = {
    activeElement: null,
    createElement(tagName) { return new RuntimeElement(tagName, document); },
    querySelector(selector) { return selector === '#panel-root' ? document.root : null; },
  };
  document.root = new RuntimeElement('main', document);
  const ports = [];
  const chrome = {
    runtime: {
      id: 'abcdefghijklmnopabcdefghijklmnop',
      connect({ name }) {
        const port = {
          name, posted: [], onMessage: runtimeEvent(), onDisconnect: runtimeEvent(),
          postMessage(message) { this.posted.push(structuredClone(message)); },
          disconnect() {},
        };
        ports.push(port);
        return port;
      },
    },
  };
  globalThis.document = document;
  globalThis.chrome = chrome;
  globalThis.location = {
    href: `chrome-extension://${chrome.runtime.id}/src/panel/index.html?launch=${'A'.repeat(43)}`,
  };

  await import(`../../src/panel/panel.js?url-persona-sync-race=${Date.now()}`);
  const port = ports[0];
  port.onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'bootstrap-result', state: 'initial',
    auditId: null, sessionCapabilityId: null, result: null,
  });
  const personaPrepare = port.posted.find(packet =>
    packet?.envelope?.type === 'PREPARE_PANEL_PERSONA_CAPABILITY');
  assert.ok(personaPrepare);

  await document.root.querySelector('button[data-intent="OPEN_URL_FORM"]').dispatch('click');
  const url = document.root.querySelector('input[id="audit-url"]');
  url.value = 'https://example.test/persona-sync-race?transient=private';
  await document.root.querySelector('form[id="audit-form"]').dispatch('submit');
  const navigationPrepare = port.posted.find(packet =>
    packet?.envelope?.type === 'PREPARE_PANEL_NAVIGATION_CAPABILITY');
  assert.ok(navigationPrepare);

  port.onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'intent-result', requestId: personaPrepare.requestId,
    response: {
      ok: true, requestId: personaPrepare.envelope.requestId, capabilityId: 'P'.repeat(22),
    },
  });
  await new Promise(resolve => setImmediate(resolve));
  const personaRehydrate = port.posted.find(packet =>
    packet?.envelope?.type === 'PANEL_REHYDRATE_PERSONA');
  assert.ok(personaRehydrate);
  port.onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'intent-result', requestId: personaRehydrate.requestId,
    response: { ok: false, code: 'PERSONA_NOT_FOUND' },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(document.root.querySelector('form[id="audit-form"]'));

  port.onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'intent-result', requestId: navigationPrepare.requestId,
    response: {
      ok: true, requestId: navigationPrepare.envelope.requestId, capabilityId: 'C'.repeat(22),
    },
  });
  await new Promise(resolve => setImmediate(resolve));

  const starts = port.posted.filter(packet => packet?.envelope?.type === 'PANEL_START_URL_AUDIT');
  assert.equal(starts.length, 1);
  assert.equal(starts[0].envelope.captureMode, 'full-evidence');
  port.onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'intent-result', requestId: starts[0].requestId,
    response: { ok: true, auditId: 'audit-persona-sync-race', state: 'running' },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(document.root.querySelector('[data-screen="running"]'));
});

test('a late URL start response cannot replace an authoritative privacy pause', async t => {
  const originalDocument = globalThis.document;
  const originalChrome = globalThis.chrome;
  const originalLocation = globalThis.location;
  t.after(() => {
    if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument;
    if (originalChrome === undefined) delete globalThis.chrome; else globalThis.chrome = originalChrome;
    if (originalLocation === undefined) delete globalThis.location; else globalThis.location = originalLocation;
  });

  const document = {
    activeElement: null,
    createElement(tagName) { return new RuntimeElement(tagName, document); },
    querySelector(selector) { return selector === '#panel-root' ? document.root : null; },
  };
  document.root = new RuntimeElement('main', document);
  const ports = [];
  const chrome = {
    runtime: {
      id: 'abcdefghijklmnopabcdefghijklmnop',
      connect({ name }) {
        const port = {
          name, posted: [], onMessage: runtimeEvent(), onDisconnect: runtimeEvent(),
          postMessage(message) { this.posted.push(structuredClone(message)); },
          disconnect() {},
        };
        ports.push(port);
        return port;
      },
    },
  };
  globalThis.document = document;
  globalThis.chrome = chrome;
  globalThis.location = {
    href: `chrome-extension://${chrome.runtime.id}/src/panel/index.html?launch=${'A'.repeat(43)}`,
  };

  await import(`../../src/panel/panel.js?url-start-privacy-race=${Date.now()}`);
  const port = ports[0];
  port.onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'bootstrap-result', state: 'initial',
    auditId: null, sessionCapabilityId: null, result: null,
  });
  const personaPrepare = port.posted.find(packet =>
    packet?.envelope?.type === 'PREPARE_PANEL_PERSONA_CAPABILITY');
  if (personaPrepare) port.onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'intent-result', requestId: personaPrepare.requestId,
    response: { ok: false, code: 'PERSONA_NOT_FOUND' },
  });
  await new Promise(resolve => setImmediate(resolve));

  await document.root.querySelector('button[data-intent="OPEN_URL_FORM"]').dispatch('click');
  const url = document.root.querySelector('input[id="audit-url"]');
  url.value = 'https://example.test/path?transient=private';
  await document.root.querySelector('form[id="audit-form"]').dispatch('submit');
  const prepare = port.posted.find(packet =>
    packet?.envelope?.type === 'PREPARE_PANEL_NAVIGATION_CAPABILITY');
  assert.ok(prepare);
  port.onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'intent-result', requestId: prepare.requestId,
    response: { ok: true, requestId: prepare.envelope.requestId, capabilityId: 'C'.repeat(22) },
  });
  await new Promise(resolve => setImmediate(resolve));

  const start = port.posted.find(packet => packet?.envelope?.type === 'PANEL_START_URL_AUDIT');
  assert.ok(start);
  assert.equal(start.envelope.captureMode, 'full-evidence');
  port.onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'bootstrap-result', state: 'running',
    auditId: 'audit-private', sessionCapabilityId: 'S'.repeat(22), result: null,
  });
  port.onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'privacy-paused',
    auditId: 'audit-private', sessionCapabilityId: 'S'.repeat(22),
    mode: 'full-evidence', categories: ['password'], message: PRIVACY_MESSAGE,
  });
  assert.ok(document.root.querySelector('[data-session-status="privacy-paused"]'));

  port.onMessage.emit({
    protocol: 'audita-panel', version: 1, type: 'intent-result', requestId: start.requestId,
    response: { ok: true, auditId: 'audit-private', state: 'running' },
  });
  await new Promise(resolve => setImmediate(resolve));

  assert.ok(document.root.querySelector('[data-session-status="privacy-paused"]'));
  assert.match(document.root.textContent, /Confirme antes de capturar imagens/u);
  assert.doesNotMatch(document.root.textContent, /example\.test|transient=private|consent|digest/iu);
});

test('a late start timeout cannot replace an authoritative running or result bootstrap', () => {
  assert.equal(shouldShowPanelStartFailure({ screen: 'running', auditId: null }), true);
  assert.equal(shouldShowPanelStartFailure({ screen: 'running', auditId: 'audit-started' }), false);
  assert.equal(shouldShowPanelStartFailure({ screen: 'result', auditId: 'audit-started' }), false);
  assert.equal(shouldShowPanelStartFailure({ screen: 'unavailable', auditId: null }), false);
});

test('projects only canonical progress from the current worker and audit', () => {
  const runtime = { id: 'extension-id', workerUrl: 'chrome-extension://extension-id/src/background/service-worker.js' };
  const message = {
    type: 'AUDIT_PROGRESS', auditId: 'audit-1', sessionId: 'audit-1',
    phase: 'testing', message: 'Verificando acessibilidade', percent: 50, at: '2026-09-01T12:00:00.000Z',
  };
  assert.deepEqual(projectPanelAuditProgressEvent(message, { id: runtime.id, url: runtime.workerUrl }, runtime, 'audit-1'), message);
  assert.deepEqual(projectPanelAuditProgressEvent(message, { id: runtime.id }, runtime, 'audit-1'), message);
  assert.deepEqual(projectPanelAuditProgressEvent(
    message,
    { id: runtime.id, url: runtime.workerUrl, origin: 'chrome-extension://extension-id' },
    runtime,
    'audit-1',
  ), message);
  for (const [sender, event] of [
    [{ id: 'other', url: runtime.workerUrl }, message],
    [{ id: runtime.id, url: 'chrome-extension://extension-id/src/review/index.html' }, message],
    [{ id: runtime.id, tab: { id: 7 } }, message],
    [{ id: runtime.id, url: runtime.workerUrl }, { ...message, auditId: 'other-audit', sessionId: 'other-audit' }],
    [{ id: runtime.id, url: runtime.workerUrl }, { ...message, message: 'PRIVATE', percent: 51 }],
    [{ id: runtime.id, url: runtime.workerUrl }, { ...message, at: '2026-09-01T12:00:00Z' }],
    [{ id: runtime.id, url: runtime.workerUrl }, { ...message, private: 'SECRET' }],
    [{ id: runtime.id, url: runtime.workerUrl }, {
      ...message, phase: 'complete', message: 'Auditoria concluída', percent: 100,
    }],
  ]) assert.equal(projectPanelAuditProgressEvent(event, sender, runtime, 'audit-1'), null);

  const batch = {
    type: 'AUDIT_PROGRESS', auditId: 'audit-1', sessionId: 'audit-1', phase: 'batch-page',
    message: 'Página 2 de 3: auditoria em andamento.', percent: 50, pageNumber: 2, total: 3,
    at: '2026-09-01T12:00:01.000Z', statusCounts: { complete: 1, partial: 0, failed: 0, cancelled: 0 },
  };
  assert.deepEqual(projectPanelAuditProgressEvent(
    batch, { id: runtime.id, url: runtime.workerUrl }, runtime, 'audit-1',
  ), {
    type: 'AUDIT_PROGRESS', auditId: 'audit-1', sessionId: 'audit-1', phase: 'batch-page',
    message: batch.message, percent: 50, pageNumber: 2, total: 3, at: batch.at,
  });
  assert.equal(projectPanelAuditProgressEvent(
    { ...batch, message: 'PRIVATE https://secret.example/?token=raw' },
    { id: runtime.id, url: runtime.workerUrl }, runtime, 'audit-1',
  ), null);
});

test('clears the matching in-memory result when the worker confirms audit deletion', () => {
  let current = { screen: 'result', auditId: 'audit-1' };
  let result = { auditId: 'audit-1', pixels: 'data:image/png;base64,PRIVATE' };
  const events = [];
  let invalidations = 0;
  const workerUrl = 'chrome-extension://extension-id/src/background/service-worker.js';
  const controller = createPanelAuditDeletionController({
    runtime: { id: 'extension-id', workerUrl },
    readState: () => current,
    readResult: () => result,
    clearResult() { result = null; },
    invalidateHighlight() { invalidations += 1; },
    transition(event) { events.push(event); current = { ...current, screen: 'initial', auditId: null }; },
  });

  assert.equal(controller.receive({
    type: 'AUDIT_DELETED', auditId: 'audit-1', reason: 'delete-one',
  }, { id: 'extension-id', url: workerUrl }), true);
  assert.equal(result, null);
  assert.deepEqual(events, [{ type: 'AUDIT_DELETED' }]);
  assert.equal(invalidations, 1);
});

test('ignores deletion notices from another audit or an untrusted sender without clearing memory', () => {
  let result = { auditId: 'audit-1', pixels: 'data:image/png;base64,PRIVATE' };
  let effects = 0;
  const workerUrl = 'chrome-extension://extension-id/src/background/service-worker.js';
  const controller = createPanelAuditDeletionController({
    runtime: { id: 'extension-id', workerUrl },
    readState: () => ({ screen: 'result', auditId: 'audit-1' }),
    readResult: () => result,
    clearResult() { result = null; effects += 1; },
    invalidateHighlight() { effects += 1; },
    transition() { effects += 1; },
  });

  assert.equal(controller.receive({
    type: 'AUDIT_DELETED', auditId: 'audit-2', reason: 'delete-one',
  }, { id: 'extension-id', url: workerUrl }), false);
  assert.equal(controller.receive({
    type: 'AUDIT_DELETED', auditId: 'audit-1', reason: 'delete-one',
  }, { id: 'extension-id', url: 'chrome-extension://extension-id/src/review/index.html' }), false);
  assert.notEqual(result, null);
  assert.equal(effects, 0);
});

test('projects only the safe privacy bootstrap fields and rejects hostile transport shapes', () => {
  const safe = {
    state: 'privacy-paused', auditId: 'audit-private', result: null,
    mode: 'full-evidence', categories: ['password', 'payment'], message: PRIVACY_MESSAGE,
  };
  assert.deepEqual(projectPanelBootstrapEvent(safe), {
    type: 'PRIVACY_PAUSED', auditId: 'audit-private', mode: 'full-evidence',
    categories: ['password', 'payment'], message: PRIVACY_MESSAGE,
  });
  assert.equal(Object.isFrozen(projectPanelBootstrapEvent(safe)), true);
  assert.equal(Object.isFrozen(projectPanelBootstrapEvent(safe).categories), true);

  for (const hostile of [
    { ...safe, consentId: 'PRIVATE' },
    Object.assign({ ...safe }, { [Symbol('private')]: true }),
    Object.defineProperty({ ...safe }, 'mode', { enumerable: true, get() { throw new Error('PRIVATE'); } }),
    new Proxy(safe, { ownKeys() { throw new Error('PRIVATE'); } }),
  ]) assert.equal(projectPanelBootstrapEvent(hostile), null);
});

test('marks confirmation pending before one exact safe request and blocks a second click', async () => {
  let state = pausedState();
  const sent = [];
  const gate = deferred();
  let pendingWasVisible = false;
  const controller = createPanelPrivacyConfirmationController({
    readState: () => state,
    transition(event) { state = reducePanelState(state, event); },
    requestIntent(intent) {
      pendingWasVisible = state.privacy.confirmationPending;
      sent.push(structuredClone(intent));
      return gate.promise;
    },
    announce() {},
  });

  const first = controller.confirm({ type: 'CONFIRM_PIXEL_CAPTURE', mode: 'full-evidence', accepted: true });
  const second = await controller.confirm({ type: 'CONFIRM_PIXEL_CAPTURE', mode: 'full-evidence', accepted: true });
  assert.equal(pendingWasVisible, true);
  assert.equal(second, false);
  assert.deepEqual(sent, [{ type: 'CONFIRM_PIXEL_CAPTURE', mode: 'full-evidence', accepted: true }]);
  assert.doesNotMatch(JSON.stringify({ state, sent }), /consent|capability|documentId|tabId|digest|PRIVATE/u);

  gate.resolve({ ok: true, state: 'running' });
  assert.equal(await first, true);
  assert.equal(state.sessionStatus, 'privacy-paused', 'only an authoritative running bootstrap clears the pause');
});

test('a rotated pause rearms confirmation and a stale response cannot alter the new pause', async () => {
  let state = pausedState();
  const requests = [];
  const announcements = [];
  const controller = createPanelPrivacyConfirmationController({
    readState: () => state,
    transition(event) { state = reducePanelState(state, event); },
    requestIntent(intent) {
      const gate = deferred();
      requests.push({ intent: structuredClone(intent), gate });
      return gate.promise;
    },
    announce(message) { announcements.push(message); },
  });

  const first = controller.confirm({ type: 'CONFIRM_PIXEL_CAPTURE', mode: 'full-evidence', accepted: true });
  state = reducePanelState(state, {
    type: 'PRIVACY_PAUSED', auditId: 'audit-private', mode: 'element-only',
    categories: ['private-marker'], message: PRIVACY_MESSAGE,
  });
  assert.equal(state.privacy.confirmationPending, false);

  requests[0].gate.resolve({ ok: false, code: 'STALE_PRIVATE_RESPONSE' });
  assert.equal(await first, false);
  assert.deepEqual(state.privacy, {
    mode: 'element-only', categories: ['private-marker'], message: PRIVACY_MESSAGE, confirmationPending: false,
  });
  assert.deepEqual(announcements, [], 'a stale response does not announce over the current pause');

  const second = controller.confirm({ type: 'CONFIRM_PIXEL_CAPTURE', mode: 'element-only', accepted: true });
  assert.deepEqual(requests[1].intent, {
    type: 'CONFIRM_PIXEL_CAPTURE', mode: 'element-only', accepted: true,
  });
  requests[1].gate.resolve({ ok: true, state: 'running' });
  assert.equal(await second, true);
});

test('confirmation controller rejects malformed and mismatched UI intents without transport effects', async () => {
  let state = pausedState();
  let calls = 0;
  const controller = createPanelPrivacyConfirmationController({
    readState: () => state,
    transition(event) { state = reducePanelState(state, event); },
    async requestIntent() { calls += 1; return { ok: true, state: 'running' }; },
    announce() {},
  });
  const safe = { type: 'CONFIRM_PIXEL_CAPTURE', mode: 'full-evidence', accepted: true };
  for (const hostile of [
    { ...safe, mode: 'element-only' },
    { ...safe, accepted: false },
    { ...safe, consentId: 'PRIVATE' },
    Object.assign({ ...safe }, { [Symbol('private')]: true }),
    Object.defineProperty({ ...safe }, 'mode', { enumerable: true, get() { throw new Error('PRIVATE'); } }),
    new Proxy(safe, { ownKeys() { throw new Error('PRIVATE'); } }),
  ]) assert.equal(await controller.confirm(hostile), false);
  assert.equal(calls, 0);
});

test('announces document drift exactly and normalizes malformed failure responses', async () => {
  async function confirmWith(response) {
    let state = pausedState();
    const announcements = [];
    const controller = createPanelPrivacyConfirmationController({
      readState: () => state,
      transition(event) { state = reducePanelState(state, event); },
      async requestIntent() { return response; },
      announce(message) { announcements.push(message); },
    });
    const confirmed = await controller.confirm({
      type: 'CONFIRM_PIXEL_CAPTURE', mode: 'full-evidence', accepted: true,
    });
    return { confirmed, announcements };
  }

  assert.deepEqual(await confirmWith({ ok: false, code: 'PIXEL_CONSENT_DOCUMENT_CHANGED' }), {
    confirmed: false,
    announcements: ['A página mudou; inicie uma nova avaliação.'],
  });

  for (const hostile of [
    { ok: false, code: 'PIXEL_CONSENT_DOCUMENT_CHANGED', extra: 'PRIVATE' },
    Object.defineProperty({ ok: false }, 'code', {
      enumerable: true, get() { throw new Error('PRIVATE'); },
    }),
    Object.assign({ ok: false, code: 'PIXEL_CONSENT_DOCUMENT_CHANGED' }, { [Symbol('private')]: true }),
  ]) {
    const result = await confirmWith(hostile);
    assert.deepEqual(result, {
      confirmed: false,
      announcements: ['Não foi possível confirmar a captura. Cancele a auditoria ou aguarde uma nova confirmação.'],
    });
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|PIXEL_CONSENT_DOCUMENT_CHANGED/u);
  }
});
