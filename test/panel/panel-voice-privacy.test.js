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

function createSpeechPlatformAdapter(listProvider) {
  const voiceValues = new WeakMap();
  const synthesisProviders = new WeakMap();

  class SpeechSynthesisVoice {
    constructor({ voiceURI, name, lang, localService }) {
      voiceValues.set(this, { voiceURI, name, lang, localService });
    }

    get voiceURI() {
      const values = voiceValues.get(this);
      if (!values) throw new TypeError('Illegal invocation');
      return values.voiceURI;
    }

    get name() {
      const values = voiceValues.get(this);
      if (!values) throw new TypeError('Illegal invocation');
      return values.name;
    }

    get lang() {
      const values = voiceValues.get(this);
      if (!values) throw new TypeError('Illegal invocation');
      return values.lang;
    }

    get localService() {
      const values = voiceValues.get(this);
      if (!values) throw new TypeError('Illegal invocation');
      return values.localService;
    }
  }

  class SpeechSynthesis extends EventTarget {
    constructor() {
      super();
      synthesisProviders.set(this, listProvider);
    }

    getVoices() {
      const provider = synthesisProviders.get(this);
      if (!provider) throw new TypeError('Illegal invocation');
      return provider();
    }
  }

  return {
    SpeechSynthesis,
    SpeechSynthesisVoice,
    speechSynthesis: new SpeechSynthesis(),
  };
}

test('panel lists only descriptor-safe local voices and clears a persisted remote selection', async t => {
  const original = {
    document: globalThis.document,
    chrome: globalThis.chrome,
    speechSynthesis: Object.getOwnPropertyDescriptor(globalThis, 'speechSynthesis'),
    SpeechSynthesis: Object.getOwnPropertyDescriptor(globalThis, 'SpeechSynthesis'),
    SpeechSynthesisVoice: Object.getOwnPropertyDescriptor(globalThis, 'SpeechSynthesisVoice'),
  };
  t.after(() => {
    if (original.document === undefined) delete globalThis.document; else globalThis.document = original.document;
    if (original.chrome === undefined) delete globalThis.chrome; else globalThis.chrome = original.chrome;
    for (const key of ['speechSynthesis', 'SpeechSynthesis', 'SpeechSynthesisVoice']) {
      const descriptor = original[key];
      if (descriptor === undefined) delete globalThis[key];
      else Object.defineProperty(globalThis, key, descriptor);
    }
    elements.clear();
  });

  let getterReads = 0;
  const accessor = { localService: true, name: 'Privada', lang: 'pt-BR' };
  Object.defineProperty(accessor, 'voiceURI', {
    enumerable: true,
    get() { getterReads += 1; return 'PRIVATE_REMOTE_VOICE'; },
  });
  let listed = [
    null,
  ];
  const speechPlatform = createSpeechPlatformAdapter(() => listed);
  listed = [
    new speechPlatform.SpeechSynthesisVoice({
      voiceURI: 'remote-default', name: 'Remota', lang: 'pt-BR', localService: false,
    }),
    new speechPlatform.SpeechSynthesisVoice({
      voiceURI: 'local-a', name: 'Local A', lang: 'pt-BR', localService: true,
    }),
  ];
  const document = {
    activeElement: null,
    querySelector(selector) { return element(selector.replace(/^#/u, '')); },
    querySelectorAll() { return []; },
    createElement(tagName) { return new FakeElement(tagName); },
    addEventListener() {},
    removeEventListener() {},
  };
  element('audit-submit');
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
  Object.defineProperties(globalThis, {
    speechSynthesis: { configurable: true, writable: true, value: speechPlatform.speechSynthesis },
    SpeechSynthesis: { configurable: true, writable: true, value: speechPlatform.SpeechSynthesis },
    SpeechSynthesisVoice: { configurable: true, writable: true, value: speechPlatform.SpeechSynthesisVoice },
  });

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

  const busyState = personaState('event-shared-queue-busy', '');
  busyState.activeMode = 'reader';
  busyState.reader.playback = 'playing';
  busyState.reader.speechAvailability = 'busy';
  panelMessage(busyState);
  assert.match(element('persona-disabled-reason').textContent, /fila de fala está ocupada[^.]*preserva[^.]*legenda/iu);
  assert.doesNotMatch(element('persona-disabled-reason').textContent, /a página já usa/iu);

  listed = [{
    voiceURI: 'plain-local-claim', name: 'Voz comum', lang: 'pt-BR', localService: true,
  }];
  speechPlatform.speechSynthesis.dispatchEvent(new Event('voiceschanged'));
  assert.deepEqual(voiceSelect.options.map(option => option.value), ['']);
  assert.match(voiceSelect.options[0].textContent, /não foi possível validar/iu);
  assert.doesNotMatch(JSON.stringify(voiceSelect.options), /plain-local-claim|Voz comum/iu);

  listed = [accessor];
  speechPlatform.speechSynthesis.dispatchEvent(new Event('voiceschanged'));
  assert.equal(getterReads, 0);
  assert.deepEqual(voiceSelect.options.map(option => option.value), ['']);
  assert.match(voiceSelect.options[0].textContent, /não foi possível validar/iu);
  assert.doesNotMatch(voiceSelect.options[0].textContent, /Privada|PRIVATE/iu);
  assert.equal(voiceSelect.disabled, true);
  assert.match(element('persona-disabled-reason').textContent, /validar[^.]*voz local[^.]*legenda/iu);

  let listTrapCalls = 0;
  let ordinaryGetVoicesCalls = 0;
  const hostileList = new Proxy([], {
    ownKeys(target) { listTrapCalls += 1; return Reflect.ownKeys(target); },
    getOwnPropertyDescriptor(target, key) {
      listTrapCalls += 1;
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
    get(target, key, receiver) { listTrapCalls += 1; return Reflect.get(target, key, receiver); },
  });
  globalThis.speechSynthesis = {
    getVoices() { ordinaryGetVoicesCalls += 1; return hostileList; },
  };
  assert.doesNotThrow(() => speechPlatform.speechSynthesis.dispatchEvent(new Event('voiceschanged')));
  assert.equal(ordinaryGetVoicesCalls, 0);
  assert.equal(listTrapCalls, 0);
  assert.deepEqual(voiceSelect.options.map(option => option.value), ['']);
  assert.match(voiceSelect.options[0].textContent, /não foi possível validar/iu);

  let synthesisTrapCalls = 0;
  globalThis.speechSynthesis = new Proxy(speechPlatform.speechSynthesis, {
    getOwnPropertyDescriptor(target, key) {
      synthesisTrapCalls += 1;
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
    getPrototypeOf(target) { synthesisTrapCalls += 1; return Reflect.getPrototypeOf(target); },
    get(target, key, receiver) { synthesisTrapCalls += 1; return Reflect.get(target, key, receiver); },
  });
  assert.doesNotThrow(() => speechPlatform.speechSynthesis.dispatchEvent(new Event('voiceschanged')));
  assert.equal(synthesisTrapCalls, 0);
  assert.deepEqual(voiceSelect.options.map(option => option.value), ['']);
  assert.match(voiceSelect.options[0].textContent, /não foi possível validar/iu);

  let voiceTrapCalls = 0;
  const proxiedVoice = new Proxy(new speechPlatform.SpeechSynthesisVoice({
    voiceURI: 'proxy-voice', name: 'Proxy privada', lang: 'pt-BR', localService: true,
  }), {
    ownKeys(target) { voiceTrapCalls += 1; return Reflect.ownKeys(target); },
    getOwnPropertyDescriptor(target, key) {
      voiceTrapCalls += 1;
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
    getPrototypeOf(target) { voiceTrapCalls += 1; return Reflect.getPrototypeOf(target); },
    get(target, key, receiver) { voiceTrapCalls += 1; return Reflect.get(target, key, receiver); },
  });
  globalThis.speechSynthesis = speechPlatform.speechSynthesis;
  listed = [proxiedVoice];
  assert.doesNotThrow(() => speechPlatform.speechSynthesis.dispatchEvent(new Event('voiceschanged')));
  assert.equal(voiceTrapCalls, 0);
  assert.deepEqual(voiceSelect.options.map(option => option.value), ['']);
  assert.match(voiceSelect.options[0].textContent, /não foi possível validar/iu);
  const postedBeforeInvalidSelection = posted.length;
  voiceSelect.value = 'proxy-voice';
  voiceSelect.listeners.get('change')();
  const invalidSelectionCommand = posted.slice(postedBeforeInvalidSelection)
    .find(message => message.type === 'command' && message.command === 'preferences');
  assert.equal(invalidSelectionCommand?.args?.voiceId, '');
  const invalidSelectionSettled = personaState(invalidSelectionCommand.requestId, '');
  invalidSelectionSettled.activeMode = 'reader';
  invalidSelectionSettled.reader.playback = 'playing';
  invalidSelectionSettled.reader.speechAvailability = 'available';
  panelMessage(invalidSelectionSettled);

  let synthesisGetterReads = 0;
  Object.defineProperty(globalThis, 'speechSynthesis', {
    configurable: true,
    get() { synthesisGetterReads += 1; return speechPlatform.speechSynthesis; },
  });
  assert.doesNotThrow(() => speechPlatform.speechSynthesis.dispatchEvent(new Event('voiceschanged')));
  assert.equal(synthesisGetterReads, 0);
  assert.deepEqual(voiceSelect.options.map(option => option.value), ['']);
  assert.match(voiceSelect.options[0].textContent, /não foi possível validar/iu);

  Object.defineProperty(globalThis, 'speechSynthesis', {
    configurable: true, writable: true, value: speechPlatform.speechSynthesis,
  });
  listed = [];
  speechPlatform.speechSynthesis.dispatchEvent(new Event('voiceschanged'));
  assert.deepEqual(voiceSelect.options.map(option => option.value), ['']);
  assert.match(voiceSelect.options[0].textContent, /nenhuma voz local/iu);
  assert.match(element('persona-disabled-reason').textContent, /nenhuma voz local[^.]*legenda/iu);
});
