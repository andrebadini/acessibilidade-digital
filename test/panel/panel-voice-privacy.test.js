import assert from 'node:assert/strict';
import test from 'node:test';

class FakeElement {
  constructor(id = '') {
    this.id = id;
    this.attributes = new Map();
    this.children = [];
    this.options = this.children;
    this.listeners = new Map();
    this.elements = { 'audit-mode': { value: 'single' } };
    this.value = '';
    this.textContent = '';
    this.hidden = false;
    this.disabled = false;
    this.inert = false;
    this.isConnected = true;
  }

  addEventListener(type, listener) { this.listeners.set(type, listener); }
  removeEventListener(type) { this.listeners.delete(type); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  hasAttribute(name) { return this.attributes.has(name); }
  replaceChildren(...children) { this.children = children; this.options = this.children; }
  appendChild(child) { this.children.push(child); this.options = this.children; return child; }
  querySelector(selector) {
    if (selector === 'button[type="submit"]') return elements.get('audit-submit');
    return null;
  }
  querySelectorAll() { return []; }
  focus() {}
  contains() { return false; }
}

const elements = new Map();

function element(id) {
  if (!elements.has(id)) elements.set(id, new FakeElement(id));
  return elements.get(id);
}

function personaState(requestId, voiceId) {
  return {
    protocol: 'audita-persona-panel', version: 1, type: 'state', requestId,
    ok: true, bound: true, targetTabId: 7, token: 'token-1', generation: 0,
    activeMode: null,
    reader: {
      playback: 'idle', index: -1, total: 0, caption: '', canPrevious: false, canNext: false,
      speechAvailability: 'unknown', voiceId, rate: 1,
    },
    limitations: [], coverage: 'dom-fallback-top-document-open-shadow',
    preferences: { voiceId, rate: 1 },
  };
}

function personaError(requestId) {
  return {
    protocol: 'audita-persona-panel', version: 1, type: 'error', requestId,
    ok: false, bound: true, code: 'PERSONA_COMMAND_FAILED', message: 'Falha transitória ao limpar a preferência.',
  };
}

test('panel lists only descriptor-safe local voices and clears a persisted remote selection', async t => {
  const original = {
    document: globalThis.document,
    chrome: globalThis.chrome,
    speechSynthesis: globalThis.speechSynthesis,
    SpeechSynthesisVoice: globalThis.SpeechSynthesisVoice,
  };
  t.after(() => {
    if (original.document === undefined) delete globalThis.document; else globalThis.document = original.document;
    if (original.chrome === undefined) delete globalThis.chrome; else globalThis.chrome = original.chrome;
    if (original.speechSynthesis === undefined) delete globalThis.speechSynthesis;
    else globalThis.speechSynthesis = original.speechSynthesis;
    if (original.SpeechSynthesisVoice === undefined) delete globalThis.SpeechSynthesisVoice;
    else globalThis.SpeechSynthesisVoice = original.SpeechSynthesisVoice;
    elements.clear();
  });

  let getterReads = 0;
  const accessor = { localService: true, name: 'Privada', lang: 'pt-BR' };
  Object.defineProperty(accessor, 'voiceURI', {
    enumerable: true,
    get() { getterReads += 1; return 'PRIVATE_REMOTE_VOICE'; },
  });
  class SpeechSynthesisVoice {
    constructor() { this.values = ['local-a', 'Local A', 'pt-BR', true]; }
    get voiceURI() { return this.values[0]; }
    get name() { return this.values[1]; }
    get lang() { return this.values[2]; }
    get localService() { return this.values[3]; }
  }
  let listed = [
    { voiceURI: 'remote-default', name: 'Remota', lang: 'pt-BR', localService: false, default: true },
    { voiceURI: 'missing-local-service', name: 'Incerta', lang: 'pt-BR' },
    new SpeechSynthesisVoice(),
  ];
  let voicesChanged = null;
  const speechSynthesis = {
    getVoices() { return listed; },
    addEventListener(type, listener) { if (type === 'voiceschanged') voicesChanged = listener; },
  };
  const document = {
    activeElement: null,
    querySelector(selector) { return element(selector.replace(/^#/u, '')); },
    querySelectorAll() { return []; },
    createElement(tagName) { return new FakeElement(tagName); },
    addEventListener() {},
    removeEventListener() {},
  };
  for (const id of ['delete-all-dialog']) element(id).ownerDocument = document;

  const posted = [];
  let panelMessage = null;
  const port = {
    onMessage: { addListener(listener) { panelMessage = listener; } },
    onDisconnect: { addListener() {} },
    postMessage(message) { posted.push(message); },
    disconnect() {},
  };
  const chrome = {
    runtime: {
      id: 'extension-test', lastError: null,
      getURL(path = '') { return `chrome-extension://extension-test/${String(path).replace(/^\//u, '')}`; },
      sendMessage(_message, callback) { callback?.({ ok: false }); },
      onMessage: { addListener() {} },
      connect() { return port; },
    },
    tabs: { getCurrent(callback) { callback?.({ id: 99 }); } },
  };
  globalThis.document = document;
  globalThis.chrome = chrome;
  globalThis.speechSynthesis = speechSynthesis;
  globalThis.SpeechSynthesisVoice = SpeechSynthesisVoice;

  await import(`../../src/panel/panel.js?voice-privacy=${Date.now()}`);

  const voiceSelect = element('persona-voice');
  assert.equal(getterReads, 0);
  assert.deepEqual(voiceSelect.options.map(option => option.value), ['', 'local-a']);
  assert.match(voiceSelect.options[0].textContent, /selecione[^.]*voz local/iu);
  assert.doesNotMatch(JSON.stringify(voiceSelect.options.map(option => option.textContent)), /Remota|Incerta|Privada|PRIVATE/iu);

  const hello = posted.find(message => message.type === 'hello');
  assert.ok(hello);
  panelMessage(personaState(hello.requestId, 'remote-default'));
  const firstClear = posted.find(message => message.type === 'command' && message.command === 'preferences');
  assert.equal(firstClear?.args?.voiceId, '');
  assert.equal(voiceSelect.value, '');
  panelMessage(personaError(firstClear.requestId));
  let clears = posted.filter(message => message.type === 'command' && message.command === 'preferences');
  assert.equal(clears.length, 2, 'uma falha correlacionada permite uma única nova tentativa automática');
  assert.equal(clears[1].args.voiceId, '');
  panelMessage(personaError(clears[1].requestId));
  panelMessage(personaState('event-after-clear-retries', 'remote-default'));
  clears = posted.filter(message => message.type === 'command' && message.command === 'preferences');
  assert.equal(clears.length, 2, 'a limpeza automática é limitada e não entra em ciclo');

  const clearedState = personaState('event-cleared-preference', '');
  clearedState.activeMode = 'reader';
  clearedState.reader.playback = 'playing';
  clearedState.reader.speechAvailability = 'available';
  panelMessage(clearedState);
  assert.equal(voiceSelect.disabled, false);

  listed = [accessor];
  voicesChanged();
  assert.equal(getterReads, 0);
  assert.deepEqual(voiceSelect.options.map(option => option.value), ['']);
  assert.match(voiceSelect.options[0].textContent, /não foi possível validar/iu);
  assert.doesNotMatch(voiceSelect.options[0].textContent, /Privada|PRIVATE/iu);
  assert.equal(voiceSelect.disabled, true);
  assert.match(element('persona-disabled-reason').textContent, /validar[^.]*voz local[^.]*legenda/iu);

  const { proxy: revokedVoices, revoke } = Proxy.revocable([], {});
  revoke();
  listed = revokedVoices;
  assert.doesNotThrow(() => voicesChanged());
  assert.deepEqual(voiceSelect.options.map(option => option.value), ['']);
  assert.match(voiceSelect.options[0].textContent, /não foi possível validar/iu);

  let synthesisGetterReads = 0;
  Object.defineProperty(globalThis, 'speechSynthesis', {
    configurable: true,
    get() { synthesisGetterReads += 1; return speechSynthesis; },
  });
  assert.doesNotThrow(() => voicesChanged());
  assert.equal(synthesisGetterReads, 0);
  assert.deepEqual(voiceSelect.options.map(option => option.value), ['']);
  assert.match(voiceSelect.options[0].textContent, /não foi possível validar/iu);

  Object.defineProperty(globalThis, 'speechSynthesis', {
    configurable: true, writable: true, value: speechSynthesis,
  });
  listed = [];
  voicesChanged();
  assert.deepEqual(voiceSelect.options.map(option => option.value), ['']);
  assert.match(voiceSelect.options[0].textContent, /nenhuma voz local/iu);
  assert.match(element('persona-disabled-reason').textContent, /nenhuma voz local[^.]*legenda/iu);
});
