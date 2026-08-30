import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const namespaceExpression = 'globalThis[Symbol.for("audita.accessible-preview.runtime.v1")]';

const trustedVoiceState = new WeakMap();
const trustedSynthesisState = new WeakMap();
const trustedUtteranceState = new WeakMap();

function requireBrand(state, value, label) {
  const record = state.get(value);
  if (!record) throw new TypeError(`${label} inválido`);
  return record;
}

class TrustedSpeechSynthesisVoice {
  constructor(values = {}) { trustedVoiceState.set(this, { ...values }); }
  get voiceURI() { return requireBrand(trustedVoiceState, this, 'voz').voiceURI; }
  get name() { return requireBrand(trustedVoiceState, this, 'voz').name; }
  get lang() { return requireBrand(trustedVoiceState, this, 'voz').lang; }
  get localService() { return requireBrand(trustedVoiceState, this, 'voz').localService; }
}

class TrustedSpeechSynthesis {
  constructor(options = {}) {
    trustedSynthesisState.set(this, {
      voices: options.voices ?? [], events: options.events ?? [], speakThrows: options.speakThrows === true,
      cancelEndsSynchronously: options.cancelEndsSynchronously === true,
      speaking: false, pending: false, paused: false, cancelCalls: 0, pauseCalls: 0, resumeCalls: 0,
      current: null, foreignQueue: [],
    });
  }
  get speaking() { return requireBrand(trustedSynthesisState, this, 'síntese').speaking; }
  get pending() { return requireBrand(trustedSynthesisState, this, 'síntese').pending; }
  get paused() { return requireBrand(trustedSynthesisState, this, 'síntese').paused; }
  get voices() { return requireBrand(trustedSynthesisState, this, 'síntese').voices; }
  set voices(value) { requireBrand(trustedSynthesisState, this, 'síntese').voices = value; }
  get cancelCalls() { return requireBrand(trustedSynthesisState, this, 'síntese').cancelCalls; }
  get pauseCalls() { return requireBrand(trustedSynthesisState, this, 'síntese').pauseCalls; }
  get resumeCalls() { return requireBrand(trustedSynthesisState, this, 'síntese').resumeCalls; }
  get current() { return requireBrand(trustedSynthesisState, this, 'síntese').current; }
  getVoices() { return requireBrand(trustedSynthesisState, this, 'síntese').voices; }
  speak(utterance) {
    const state = requireBrand(trustedSynthesisState, this, 'síntese');
    state.events.push(`speak:${utterance.text}`);
    if (state.speakThrows) throw new Error('speech unavailable');
    state.speaking = true;
    state.current = utterance;
  }
  cancel() {
    const state = requireBrand(trustedSynthesisState, this, 'síntese');
    state.events.push('cancel');
    state.cancelCalls += 1;
    for (const utterance of state.foreignQueue) utterance.cancelled = true;
    state.foreignQueue = [];
    state.speaking = false;
    state.pending = false;
    if (state.cancelEndsSynchronously) state.current?.onend?.();
  }
  pause() {
    const state = requireBrand(trustedSynthesisState, this, 'síntese');
    state.pauseCalls += 1;
    state.paused = true;
  }
  resume() {
    const state = requireBrand(trustedSynthesisState, this, 'síntese');
    state.resumeCalls += 1;
    state.paused = false;
  }
}

class TrustedSpeechSynthesisUtterance {
  constructor(text) {
    trustedUtteranceState.set(this, {
      text, voice: null, lang: '', rate: 1, onend: null, onerror: null, onVoiceAssignment: null,
    });
  }
  get text() { return requireBrand(trustedUtteranceState, this, 'enunciado').text; }
  get voice() { return requireBrand(trustedUtteranceState, this, 'enunciado').voice; }
  set voice(value) {
    const state = requireBrand(trustedUtteranceState, this, 'enunciado');
    if (state.onVoiceAssignment?.(value) === false) return;
    state.voice = value;
  }
  get lang() { return requireBrand(trustedUtteranceState, this, 'enunciado').lang; }
  set lang(value) { requireBrand(trustedUtteranceState, this, 'enunciado').lang = value; }
  get rate() { return requireBrand(trustedUtteranceState, this, 'enunciado').rate; }
  set rate(value) { requireBrand(trustedUtteranceState, this, 'enunciado').rate = value; }
  get onend() { return requireBrand(trustedUtteranceState, this, 'enunciado').onend; }
  set onend(value) { requireBrand(trustedUtteranceState, this, 'enunciado').onend = value; }
  get onerror() { return requireBrand(trustedUtteranceState, this, 'enunciado').onerror; }
  set onerror(value) { requireBrand(trustedUtteranceState, this, 'enunciado').onerror = value; }
}

function trustedVoice(values) { return new TrustedSpeechSynthesisVoice(values); }

async function loadReaderFactory(contextGlobals = {}) {
  const runtime = await readFile(new URL('../../src/core/accessibility/accessible-preview-runtime.classic.js', import.meta.url), 'utf8');
  let reader = '';
  try {
    reader = await readFile(new URL('../../src/personas/screen-reader-module.js', import.meta.url), 'utf8');
  } catch {
    // Keep the first missing-feature result as an assertion failure.
  }
  assert.notEqual(reader, '', 'o módulo clássico dedicado de leitura precisa existir');
  const context = vm.createContext({
    SpeechSynthesisVoice: TrustedSpeechSynthesisVoice,
    SpeechSynthesis: TrustedSpeechSynthesis,
    SpeechSynthesisUtterance: TrustedSpeechSynthesisUtterance,
    ...contextGlobals,
  });
  new vm.Script(runtime).runInContext(context);
  new vm.Script(reader).runInContext(context);
  return vm.runInContext(namespaceExpression, context);
}

function fixtureEnvironment(options = {}) {
  const events = [];
  const terminalEvents = [];
  const utterances = [];
  let focusListener = null;
  let voicesListener = null;
  let focusUnsubscribes = 0;
  let voicesUnsubscribes = 0;
  let candidates = options.candidates ?? [
    { element: { id: 'first' }, caption: 'Primeiro, botão' },
    { element: { id: 'second' }, caption: 'Segundo, link' },
    { element: { id: 'third' }, caption: 'Terceiro, caixa de seleção' },
  ];
  const speech = options.speechObject ?? (options.speech === null ? null : new TrustedSpeechSynthesis({
    voices: options.voices ?? [trustedVoice({
      voiceURI: 'voice-a', name: 'Voz A', lang: 'pt-BR', localService: true,
    })],
    events,
    speakThrows: options.speakThrows,
    cancelEndsSynchronously: options.cancelEndsSynchronously,
  }));
  function Utterance(text) {
    const utterance = new TrustedSpeechSynthesisUtterance(text);
    const state = requireBrand(trustedUtteranceState, utterance, 'enunciado');
    state.onVoiceAssignment = value => options.onVoiceAssignment?.(utterance, speech, value);
    utterances.push(utterance);
    events.push(`utterance:${text}`);
    options.onUtterance?.(utterance, speech);
    return utterance;
  }
  const originalFocus = { id: 'original', connected: true };
  const environment = {
    collectCandidates() { events.push('collect'); return candidates; },
    activeElement() { return originalFocus; },
    isSafeElement(element) { return element?.connected !== false; },
    focus(element, init) { events.push(`focus:${element.id}:${String(init?.preventScroll)}`); },
    restoreFocus(element, init) { events.push(`restore:${element.id}:${String(init?.preventScroll)}`); },
    render(current, state) {
      events.push(`render:${state.caption}:${current?.element?.id ?? 'none'}`);
    },
    publish(state) { events.push(`publish:${state.playback}:${state.index}:${state.caption}`); },
    onTerminal(reason) { terminalEvents.push(reason); },
    onFocus(listener) { focusListener = listener; return () => { focusListener = null; focusUnsubscribes += 1; }; },
    onVoicesChanged(listener) { voicesListener = listener; return () => { voicesListener = null; voicesUnsubscribes += 1; }; },
    speechSynthesis: speech,
    Utterance,
  };
  return {
    environment, speech, events, terminalEvents, utterances, get candidates() { return candidates; },
    setSpeechState(patch) { Object.assign(requireBrand(trustedSynthesisState, speech, 'síntese'), patch); },
    enqueueForeignSpeech(text = 'Fala da página') {
      const state = requireBrand(trustedSynthesisState, speech, 'síntese');
      const utterance = { text, cancelled: false };
      state.foreignQueue.push(utterance);
      state.pending = true;
      events.push(`foreign:${text}`);
      return utterance;
    },
    finishOwnedSpeech(kind = 'end') {
      const state = requireBrand(trustedSynthesisState, speech, 'síntese');
      const utterance = state.current;
      state.current = null;
      state.speaking = false;
      if (!state.foreignQueue.length) state.pending = false;
      if (kind === 'error') utterance?.onerror?.();
      else utterance?.onend?.();
    },
    setCandidates(value) { candidates = value; },
    listenerState() { return { focus: Boolean(focusListener), voices: Boolean(voicesListener), focusUnsubscribes, voicesUnsubscribes }; },
    captureFocusListener() { return focusListener; },
    captureVoicesListener() { return voicesListener; },
    focus(element) { focusListener?.(element); },
    voicesChanged() { voicesListener?.(); },
  };
}

test('starts caption-first, navigates exact bounds and focuses only selected items', async () => {
  const namespace = await loadReaderFactory();
  const fixture = fixtureEnvironment();
  const reader = namespace.createScreenReaderModule(fixture.environment);

  const started = reader.start({ voiceId: 'voice-a', rate: 1.25 });
  assert.deepEqual(JSON.parse(JSON.stringify(started)), {
    playback: 'playing', index: 0, total: 3, caption: 'Primeiro, botão',
    canPrevious: false, canNext: true, speechAvailability: 'available',
    voiceId: 'voice-a', rate: 1.25,
  });
  assert.ok(fixture.events.indexOf('render:Primeiro, botão:first') < fixture.events.indexOf('speak:Primeiro, botão'));
  assert.equal(fixture.speech.cancelCalls, 0, 'start nunca cancela a fila global preventivamente');

  assert.equal(reader.previous().index, 0);
  fixture.finishOwnedSpeech();
  assert.equal(reader.next().index, 0);
  fixture.finishOwnedSpeech();
  assert.equal(reader.getState().index, 1);
  assert.ok(fixture.events.includes('focus:second:true'));
  assert.equal(reader.next().index, 1);
  fixture.finishOwnedSpeech();
  assert.equal(reader.getState().index, 2);
  assert.equal(reader.next().index, 2, 'não há wrap no fim');
  fixture.finishOwnedSpeech();
  assert.equal(reader.getState().canNext, false);
});

test('pause/resume change only Audita state and never pause or resume the shared page queue', async () => {
  const namespace = await loadReaderFactory();
  const fixture = fixtureEnvironment();
  const reader = namespace.createScreenReaderModule(fixture.environment);
  reader.start({ voiceId: 'voice-a', rate: 1 });
  const foreign = fixture.enqueueForeignSpeech('Fala da página após Audita');
  assert.equal(reader.pause().playback, 'playing');
  assert.equal(fixture.speech.pauseCalls, 0, 'pause é global e não pode afetar a página');
  fixture.finishOwnedSpeech();
  assert.equal(reader.getState().playback, 'paused');
  const utteranceCount = fixture.utterances.length;

  fixture.focus(fixture.candidates[2].element);
  assert.equal(reader.getState().index, 2);
  assert.equal(reader.getState().caption, 'Terceiro, caixa de seleção');
  assert.equal(fixture.utterances.length, utteranceCount, 'foco pausado não cria fala');
  assert.equal(reader.resume().playback, 'playing');
  assert.equal(fixture.speech.resumeCalls, 0, 'resume é global e não pode afetar a página');
  assert.equal(foreign.cancelled, false);

  const stopped = reader.stop('requested');
  assert.equal(stopped.actionStatus, 'accepted');
  assert.equal(stopped.playback, 'idle');
  assert.equal(fixture.speech.cancelCalls, 0);
  assert.ok(fixture.events.includes('restore:original:true'));
  const duplicateStop = reader.stop('again');
  assert.equal(duplicateStop.actionStatus, 'rejected');
  assert.equal(duplicateStop.playback, 'idle');
});

test('never cancels foreign speech and ignores stale synchronous callbacks from owned speech', async () => {
  const namespace = await loadReaderFactory();
  const fixture = fixtureEnvironment({ cancelEndsSynchronously: true });
  fixture.setSpeechState({ speaking: true });
  const reader = namespace.createScreenReaderModule(fixture.environment);
  reader.start({ voiceId: 'voice-a', rate: 1 });
  assert.equal(fixture.utterances.length, 0);
  assert.equal(fixture.speech.cancelCalls, 0);
  assert.equal(reader.getState().speechAvailability, 'busy');

  fixture.setSpeechState({ speaking: false });
  reader.repeat();
  assert.equal(fixture.utterances.length, 1);
  const stale = fixture.utterances[0];
  reader.next();
  assert.equal(reader.getState().index, 0);
  fixture.finishOwnedSpeech();
  const afterNext = reader.getState();
  assert.equal(afterNext.index, 1);
  stale.onerror?.();
  stale.onend?.();
  assert.deepEqual(reader.getState(), afterNext);
});

test('next, repeat, stop and voiceschanged never cancel speech queued by the page after Audita starts', async () => {
  const namespace = await loadReaderFactory();
  for (const action of ['next', 'repeat', 'stop', 'voiceschanged']) {
    const fixture = fixtureEnvironment();
    const reader = namespace.createScreenReaderModule(fixture.environment);
    reader.start({ voiceId: 'voice-a', rate: 1 });
    assert.equal(fixture.utterances.length, 1, `${action}: a fala Audita precisa estar ativa`);
    const foreign = fixture.enqueueForeignSpeech(`Página depois de ${action}`);

    if (action === 'voiceschanged') {
      fixture.speech.voices = [];
      fixture.voicesChanged();
    } else {
      reader[action]();
    }

    assert.equal(fixture.speech.cancelCalls, 0, `${action}: cancel é global e não pode ser usado`);
    assert.equal(foreign.cancelled, false, `${action}: a fala alheia precisa permanecer na fila`);
    assert.equal(fixture.utterances.length, 1, `${action}: nenhuma fala Audita obsoleta pode entrar depois da fala alheia`);
    if (action === 'next') assert.equal(reader.getState().caption, 'Primeiro, botão');
    if (action === 'stop') assert.equal(reader.getState().playback, 'playing');
    else assert.notEqual(reader.getState().playback, 'idle');
  }
});

test('voiceschanged cannot hide that the shared queue remains busy while Audita owns its utterance', async () => {
  const namespace = await loadReaderFactory();
  const fixture = fixtureEnvironment();
  const reader = namespace.createScreenReaderModule(fixture.environment);
  reader.start({ voiceId: 'voice-a', rate: 1 });
  fixture.enqueueForeignSpeech();
  reader.next();
  assert.equal(reader.getState().speechAvailability, 'busy');

  fixture.voicesChanged();

  assert.equal(reader.getState().speechAvailability, 'busy');
  assert.equal(fixture.speech.cancelCalls, 0);
});

test('keeps caption/navigation when synthesis is missing, throws, or loses a preferred voice', async () => {
  const namespace = await loadReaderFactory();
  for (const options of [{ speech: null }, { speakThrows: true }]) {
    const fixture = fixtureEnvironment(options);
    const reader = namespace.createScreenReaderModule(fixture.environment);
    assert.doesNotThrow(() => reader.start({ voiceId: 'removed-voice', rate: 9 }));
    assert.equal(reader.getState().caption, 'Primeiro, botão');
    assert.equal(reader.getState().rate, 2);
    assert.equal(reader.next().index, 1);
    assert.match(reader.getState().speechAvailability, /unavailable|error/iu);
  }

  const fixture = fixtureEnvironment({ voices: [] });
  const reader = namespace.createScreenReaderModule(fixture.environment);
  reader.start({ voiceId: 'voice-a', rate: 1 });
  fixture.speech.voices = [trustedVoice({ voiceURI: 'voice-b', name: 'Voz B', lang: 'pt-BR', localService: true })];
  fixture.voicesChanged();
  assert.equal(reader.getState().voiceId, '');
  assert.equal(reader.getState().caption, 'Primeiro, botão');
});

test('empty queue lifecycle can restart and always releases subscriptions independently of playback', async () => {
  const namespace = await loadReaderFactory();
  const fixture = fixtureEnvironment({ candidates: [] });
  const reader = namespace.createScreenReaderModule(fixture.environment);
  const empty = reader.start({ voiceId: '', rate: 1 });
  assert.equal(empty.playback, 'idle');
  assert.equal(empty.total, 0);
  assert.deepEqual(fixture.listenerState(), {
    focus: true, voices: true, focusUnsubscribes: 0, voicesUnsubscribes: 0,
  });
  const stopped = reader.stop('empty-stop');
  assert.equal(stopped.playback, 'idle');
  assert.deepEqual(fixture.listenerState(), {
    focus: false, voices: false, focusUnsubscribes: 1, voicesUnsubscribes: 1,
  });
  assert.equal(fixture.events.filter(value => value === 'restore:original:true').length, 1);
  reader.stop('double-stop');
  assert.deepEqual(fixture.listenerState(), {
    focus: false, voices: false, focusUnsubscribes: 1, voicesUnsubscribes: 1,
  });

  reader.start({ voiceId: '', rate: 1 });
  fixture.setCandidates([{ element: { id: 'late' }, caption: 'Elemento tardio, botão' }]);
  const restarted = reader.start();
  assert.equal(restarted.playback, 'playing');
  assert.equal(restarted.caption, 'Elemento tardio, botão');
  reader.stop('restarted-stop');
  assert.deepEqual(fixture.listenerState(), {
    focus: false, voices: false, focusUnsubscribes: 3, voicesUnsubscribes: 3,
  });
});

test('late focus and voices callbacks after stop cannot publish or recreate reader visuals', async () => {
  const namespace = await loadReaderFactory();
  const fixture = fixtureEnvironment();
  const reader = namespace.createScreenReaderModule(fixture.environment);
  reader.start({ voiceId: 'voice-a', rate: 1 });
  const lateFocus = fixture.captureFocusListener();
  const lateVoices = fixture.captureVoicesListener();
  reader.stop('done');
  fixture.finishOwnedSpeech();
  const afterStop = fixture.events.slice();
  lateFocus?.(fixture.candidates[1].element);
  lateVoices?.();
  assert.deepEqual(fixture.events, afterStop);
  assert.equal(reader.getState().playback, 'idle');
  assert.equal(reader.getState().caption, '');
});

test('never speaks an implicit default, remote voice or voice without explicit localService true', async () => {
  const namespace = await loadReaderFactory();
  const scenarios = [
    {
      preference: '',
      voices: [trustedVoice({ voiceURI: 'local-default', name: 'Local padrão', lang: 'pt-BR', localService: true })],
    },
    {
      preference: 'remote-default',
      voices: [trustedVoice({ voiceURI: 'remote-default', name: 'Remota', lang: 'pt-BR', localService: false })],
    },
    {
      preference: 'unknown-service',
      voices: [trustedVoice({ voiceURI: 'unknown-service', name: 'Sem origem', lang: 'pt-BR' })],
    },
    { preference: 'missing', voices: [] },
  ];

  for (const scenario of scenarios) {
    const fixture = fixtureEnvironment({ voices: scenario.voices });
    const reader = namespace.createScreenReaderModule(fixture.environment);
    assert.equal(reader.getState().speechAvailability, 'unavailable');
    const started = reader.start({ voiceId: scenario.preference, rate: 1 });
    assert.equal(fixture.events.some(value => value.startsWith('speak:')), false);
    assert.equal(started.caption, 'Primeiro, botão');
    assert.equal(reader.next().index, 1, 'a navegação visual continua disponível');
    assert.equal(reader.getState().voiceId, '');
    assert.equal(reader.getState().speechAvailability, 'unavailable');
  }
});

test('uses only the explicitly selected trusted local voice', async () => {
  const namespace = await loadReaderFactory();
  const local = trustedVoice({ voiceURI: 'local-a', name: 'Voz local', lang: 'pt-BR', localService: true });
  const fixture = fixtureEnvironment({ voices: [local] });
  const reader = namespace.createScreenReaderModule(fixture.environment);

  reader.start({ voiceId: 'local-a', rate: 1 });

  assert.equal(fixture.events.filter(value => value.startsWith('speak:')).length, 1);
  assert.equal(fixture.utterances[0].voice, local);
  assert.equal(reader.getState().voiceId, 'local-a');
  assert.equal(reader.getState().speechAvailability, 'available');
});

test('supports the trusted SpeechSynthesisVoice prototype without accepting arbitrary accessors', async () => {
  class SpeechSynthesisVoice {
    constructor() { this.values = ['native-local', 'Voz nativa', 'pt-BR', true]; }
    get voiceURI() { return this.values[0]; }
    get name() { return this.values[1]; }
    get lang() { return this.values[2]; }
    get localService() { return this.values[3]; }
  }
  const local = new SpeechSynthesisVoice();
  class SpeechSynthesis {
    constructor() { this.voices = [local]; this.spoken = []; }
    get speaking() { return false; }
    get pending() { return false; }
    get paused() { return false; }
    getVoices() { return this.voices; }
    speak(utterance) { this.spoken.push(utterance); }
    cancel() {}
    pause() {}
    resume() {}
  }
  const namespace = await loadReaderFactory({ SpeechSynthesisVoice, SpeechSynthesis });
  const synthesis = new SpeechSynthesis();
  const fixture = fixtureEnvironment({ speechObject: synthesis });
  const reader = namespace.createScreenReaderModule(fixture.environment);

  reader.start({ voiceId: 'native-local', rate: 1 });

  assert.equal(synthesis.spoken.length, 1);
  assert.equal(synthesis.spoken[0].voice, local);
});

test('rejects an ordinary synthesis before traversing proxy-controlled voice lists or speaking', async () => {
  const namespace = await loadReaderFactory();
  let listTraps = 0;
  let voiceTraps = 0;
  let spoken = 0;
  const voice = new Proxy({
    voiceURI: 'proxy-local', name: 'Voz proxy', lang: 'pt-BR', localService: true,
  }, {
    ownKeys(target) { voiceTraps += 1; return Reflect.ownKeys(target); },
    getOwnPropertyDescriptor(target, key) { voiceTraps += 1; return Reflect.getOwnPropertyDescriptor(target, key); },
  });
  const voices = new Proxy([voice], {
    ownKeys(target) { listTraps += 1; return Reflect.ownKeys(target); },
    getOwnPropertyDescriptor(target, key) { listTraps += 1; return Reflect.getOwnPropertyDescriptor(target, key); },
  });
  const synthesis = {
    speaking: false, pending: false, paused: false,
    getVoices() { return voices; },
    speak() { spoken += 1; },
    cancel() {}, pause() {}, resume() {},
  };
  const fixture = fixtureEnvironment({ speechObject: synthesis });
  const reader = namespace.createScreenReaderModule(fixture.environment);

  const started = reader.start({ voiceId: 'proxy-local', rate: 1 });

  assert.equal(spoken, 0);
  assert.equal(listTraps, 0);
  assert.equal(voiceTraps, 0);
  assert.equal(started.caption, 'Primeiro, botão');
  assert.equal(reader.next().index, 1, 'o fallback visual continua navegável');
  assert.match(reader.getState().speechAvailability, /unavailable|error/iu);
});

test('does not execute voice, array-slot or getVoices accessors and never echoes their data', async () => {
  const namespace = await loadReaderFactory();
  const marker = 'PRIVATE_REMOTE_VOICE';
  let getterReads = 0;
  const accessorVoice = { name: 'Voz', lang: 'pt-BR' };
  Object.defineProperty(accessorVoice, 'voiceURI', {
    enumerable: true,
    get() { getterReads += 1; return marker; },
  });
  Object.defineProperty(accessorVoice, 'localService', {
    enumerable: true,
    get() { getterReads += 1; return true; },
  });
  const accessorFixture = fixtureEnvironment({ voices: [accessorVoice] });
  const accessorReader = namespace.createScreenReaderModule(accessorFixture.environment);
  accessorReader.start({ voiceId: marker, rate: 1 });

  const slotVoices = [];
  Object.defineProperty(slotVoices, '0', {
    enumerable: true,
    configurable: true,
    get() { getterReads += 1; return { voiceURI: marker, localService: true }; },
  });
  slotVoices.length = 1;
  const slotFixture = fixtureEnvironment({ voices: slotVoices });
  const slotReader = namespace.createScreenReaderModule(slotFixture.environment);
  slotReader.start({ voiceId: marker, rate: 1 });

  const methodFixture = fixtureEnvironment();
  Object.defineProperty(methodFixture.speech, 'getVoices', {
    configurable: true,
    get() { getterReads += 1; return () => [{ voiceURI: marker, localService: true }]; },
  });
  const methodReader = namespace.createScreenReaderModule(methodFixture.environment);
  methodReader.start({ voiceId: marker, rate: 1 });

  const revokedTarget = { voiceURI: marker, name: 'Privada', lang: 'pt-BR', localService: true };
  const { proxy: revokedVoice, revoke: revokeVoice } = Proxy.revocable(revokedTarget, {});
  revokeVoice();
  const revokedFixture = fixtureEnvironment({ voices: [revokedVoice] });
  const revokedReader = namespace.createScreenReaderModule(revokedFixture.environment);
  assert.doesNotThrow(() => revokedReader.start({ voiceId: marker, rate: 1 }));

  assert.equal(getterReads, 0);
  for (const [reader, fixture] of [
    [accessorReader, accessorFixture], [slotReader, slotFixture], [methodReader, methodFixture],
    [revokedReader, revokedFixture],
  ]) {
    assert.equal(fixture.events.some(value => value.startsWith('speak:')), false);
    assert.doesNotMatch(JSON.stringify(reader.getState()), new RegExp(marker, 'u'));
    assert.doesNotMatch(JSON.stringify(fixture.events), new RegExp(marker, 'u'));
    assert.match(reader.getState().speechAvailability, /unavailable|error/iu);
  }
});

test('does not execute synthesis state or speak accessors before deciding whether speech is safe', async () => {
  const namespace = await loadReaderFactory();
  let getterReads = 0;
  const stateFixture = fixtureEnvironment();
  Object.defineProperty(stateFixture.speech, 'speaking', {
    configurable: true,
    get() { getterReads += 1; return false; },
  });
  const stateReader = namespace.createScreenReaderModule(stateFixture.environment);
  stateReader.start({ voiceId: 'voice-a', rate: 1 });

  const speakFixture = fixtureEnvironment();
  Object.defineProperty(speakFixture.speech, 'speak', {
    configurable: true,
    get() { getterReads += 1; return () => { throw new Error('PRIVATE_SYNTHESIS_MARKER'); }; },
  });
  const speakReader = namespace.createScreenReaderModule(speakFixture.environment);
  speakReader.start({ voiceId: 'voice-a', rate: 1 });

  assert.equal(getterReads, 0);
  assert.equal(stateFixture.events.some(value => value.startsWith('speak:')), false);
  assert.equal(speakFixture.events.some(value => value.startsWith('speak:')), false);
  assert.match(stateReader.getState().speechAvailability, /unavailable|error/iu);
  assert.match(speakReader.getState().speechAvailability, /unavailable|error/iu);
  assert.doesNotMatch(JSON.stringify([stateFixture.events, speakFixture.events]), /PRIVATE_SYNTHESIS_MARKER/u);
});

test('revalidates a selected local voice immediately before speak and on voiceschanged', async () => {
  const namespace = await loadReaderFactory();
  const local = trustedVoice({ voiceURI: 'local-a', name: 'Voz local', lang: 'pt-BR', localService: true });
  const removedDuringConstruction = fixtureEnvironment({
    voices: [local],
    onUtterance(_utterance, speech) { speech.voices = []; },
  });
  const constructionReader = namespace.createScreenReaderModule(removedDuringConstruction.environment);
  constructionReader.start({ voiceId: 'local-a', rate: 1 });
  assert.equal(removedDuringConstruction.events.some(value => value.startsWith('speak:')), false);
  assert.equal(constructionReader.getState().voiceId, '');
  assert.equal(constructionReader.getState().speechAvailability, 'unavailable');

  const repeatFixture = fixtureEnvironment({ voices: [local] });
  const repeatReader = namespace.createScreenReaderModule(repeatFixture.environment);
  repeatReader.start({ voiceId: 'local-a', rate: 1 });
  assert.equal(repeatFixture.events.filter(value => value.startsWith('speak:')).length, 1);
  repeatFixture.speech.voices = [];
  repeatFixture.finishOwnedSpeech();
  repeatReader.repeat();
  assert.equal(repeatFixture.events.filter(value => value.startsWith('speak:')).length, 1);
  assert.equal(repeatReader.getState().voiceId, '');
  assert.equal(repeatReader.getState().speechAvailability, 'unavailable');

  const changedFixture = fixtureEnvironment({ voices: [local] });
  const changedReader = namespace.createScreenReaderModule(changedFixture.environment);
  changedReader.start({ voiceId: 'local-a', rate: 1 });
  changedFixture.speech.voices = [];
  changedFixture.voicesChanged();
  assert.equal(changedFixture.speech.cancelCalls, 0, 'a perda da voz não autoriza cancelar a fila global');
  assert.equal(changedReader.getState().voiceId, '');
  assert.equal(changedReader.getState().speechAvailability, 'unavailable');
});

test('never falls back to a default when assignment removes or does not retain the selected voice', async () => {
  const namespace = await loadReaderFactory();
  const removed = fixtureEnvironment({
    onVoiceAssignment(_utterance, synthesis) { synthesis.voices = []; },
  });
  const removedReader = namespace.createScreenReaderModule(removed.environment);

  removedReader.start({ voiceId: 'voice-a', rate: 1 });

  assert.equal(removed.events.some(value => value.startsWith('speak:')), false);
  assert.equal(removedReader.getState().voiceId, '');
  assert.equal(removedReader.getState().speechAvailability, 'unavailable');
  assert.equal(removedReader.getState().caption, 'Primeiro, botão');
  assert.equal(removedReader.next().index, 1);

  const ignored = fixtureEnvironment({ onVoiceAssignment() { return false; } });
  const ignoredReader = namespace.createScreenReaderModule(ignored.environment);
  ignoredReader.start({ voiceId: 'voice-a', rate: 1 });

  assert.equal(ignored.events.some(value => value.startsWith('speak:')), false);
  assert.equal(ignoredReader.getState().caption, 'Primeiro, botão');
  assert.equal(ignoredReader.next().index, 1);
  assert.match(ignoredReader.getState().speechAvailability, /unavailable|error/iu);
});

test('projects only a bounded minimal inventory of trusted local voices on explicit request', async () => {
  const namespace = await loadReaderFactory();
  const local = trustedVoice({
    voiceURI: 'local-pt-br', name: 'Voz local brasileira', lang: 'pt-BR', localService: true,
  });
  const remote = trustedVoice({
    voiceURI: 'remote-cloud', name: 'Voz remota', lang: 'pt-BR', localService: false,
  });
  const fixture = fixtureEnvironment({ voices: [local, remote] });
  const reader = namespace.createScreenReaderModule(fixture.environment);

  assert.deepEqual(JSON.parse(JSON.stringify(reader.listLocalVoices())), {
    status: 'available',
    voices: [{ id: 'local-pt-br', label: 'Voz local brasileira', lang: 'pt-BR' }],
  });
  assert.equal(JSON.stringify(reader.listLocalVoices()).includes('remote-cloud'), false);
  assert.equal(JSON.stringify(reader.listLocalVoices()).includes('Voz remota'), false);
});

test('selects preferences atomically only when the requested voice is still trusted and local', async () => {
  const namespace = await loadReaderFactory();
  const first = trustedVoice({ voiceURI: 'local-a', name: 'Voz A', lang: 'pt-BR', localService: true });
  const second = trustedVoice({ voiceURI: 'local-b', name: 'Voz B', lang: 'pt-BR', localService: true });
  const remote = trustedVoice({ voiceURI: 'remote-a', name: 'Remota', lang: 'pt-BR', localService: false });
  const fixture = fixtureEnvironment({ voices: [first, second, remote] });
  const reader = namespace.createScreenReaderModule(fixture.environment);
  reader.start({ voiceId: 'local-a', rate: 1 });

  assert.deepEqual(JSON.parse(JSON.stringify(reader.setPreferences({ voiceId: 'remote-a', rate: 1.75 }))), {
    playback: 'playing', index: 0, total: 3, caption: 'Primeiro, botão',
    canPrevious: false, canNext: true, speechAvailability: 'available',
    voiceId: 'local-a', rate: 1,
  });
  const selected = reader.setPreferences({ voiceId: 'local-b', rate: 1.75 });
  assert.equal(selected.voiceId, 'local-b');
  assert.equal(selected.rate, 1.75);
});

test('activating the first trusted local voice announces the current caption without disturbing foreign speech', async () => {
  const namespace = await loadReaderFactory();
  const local = trustedVoice({ voiceURI: 'local-a', name: 'Voz local', lang: 'pt-BR', localService: true });
  const fixture = fixtureEnvironment({ voices: [local] });
  const reader = namespace.createScreenReaderModule(fixture.environment);
  reader.start({ voiceId: '', rate: 1 });
  assert.equal(fixture.events.some(value => value === 'speak:Primeiro, botão'), false);

  const activated = reader.setPreferences({ voiceId: 'local-a', rate: 1.25 });
  assert.equal(activated.voiceId, 'local-a');
  assert.equal(activated.rate, 1.25);
  assert.equal(fixture.events.filter(value => value === 'speak:Primeiro, botão').length, 1);

  const busyFixture = fixtureEnvironment({ voices: [local] });
  const busyReader = namespace.createScreenReaderModule(busyFixture.environment);
  busyReader.start({ voiceId: '', rate: 1 });
  const foreign = busyFixture.enqueueForeignSpeech('Fala da página preservada');
  const busy = busyReader.setPreferences({ voiceId: 'local-a', rate: 1 });
  assert.equal(busy.speechAvailability, 'busy');
  assert.equal(busyFixture.events.some(value => value === 'speak:Primeiro, botão'), false);
  assert.equal(busyFixture.speech.cancelCalls, 0);
  assert.equal(foreign.cancelled, false);
});

test('retrying explicit local voice activation after a speech error attempts the current caption again', async () => {
  const namespace = await loadReaderFactory();
  const local = trustedVoice({ voiceURI: 'local-a', name: 'Voz local', lang: 'pt-BR', localService: true });
  const fixture = fixtureEnvironment({ voices: [local], speakThrows: true });
  const reader = namespace.createScreenReaderModule(fixture.environment);
  reader.start({ voiceId: '', rate: 1 });

  const failed = reader.setPreferences({ voiceId: 'local-a', rate: 1 });
  assert.equal(failed.voiceId, 'local-a');
  assert.equal(failed.speechAvailability, 'error');
  fixture.setSpeechState({ speakThrows: false });

  const retried = reader.setPreferences({ voiceId: 'local-a', rate: 1 });
  assert.equal(retried.speechAvailability, 'available');
  assert.equal(fixture.events.filter(value => value === 'speak:Primeiro, botão').length, 2);
});

test('reader stop clears only playback and caption while resume safely recollects without global speech controls', async () => {
  const namespace = await loadReaderFactory();
  const fixture = fixtureEnvironment();
  const reader = namespace.createScreenReaderModule(fixture.environment);
  reader.start({ voiceId: 'voice-a', rate: 1 });
  const foreign = fixture.enqueueForeignSpeech('Fala da página preservada');

  const stopped = reader.stop();
  assert.equal(stopped.playback, 'playing');
  assert.equal(stopped.caption, 'Primeiro, botão');
  assert.equal(fixture.speech.cancelCalls, 0);
  assert.equal(fixture.speech.pauseCalls, 0);
  assert.equal(fixture.speech.resumeCalls, 0);
  assert.equal(foreign.cancelled, false);

  fixture.finishOwnedSpeech();
  assert.equal(reader.getState().playback, 'idle');
  assert.equal(reader.getState().caption, '');
  fixture.setSpeechState({ pending: false, paused: false });
  const resumed = reader.resume();
  assert.equal(resumed.playback, 'playing');
  assert.equal(resumed.caption, 'Primeiro, botão');
  assert.equal(fixture.speech.cancelCalls, 0);
  assert.equal(fixture.speech.pauseCalls, 0);
  assert.equal(fixture.speech.resumeCalls, 0);
});

test('pause and stop remain truthful until the owned utterance actually ends', async () => {
  const namespace = await loadReaderFactory();

  const pausedFixture = fixtureEnvironment();
  const pausedReader = namespace.createScreenReaderModule(pausedFixture.environment);
  pausedReader.start({ voiceId: 'voice-a', rate: 1 });
  const pausePending = pausedReader.pause();
  assert.equal(pausePending.playback, 'playing', 'a fala ainda audível não pode ser declarada pausada');
  assert.equal(pausePending.caption, 'Primeiro, botão');
  assert.equal(pausedFixture.speech.pauseCalls, 0);
  pausedFixture.finishOwnedSpeech();
  assert.equal(pausedReader.getState().playback, 'paused');
  assert.equal(pausedFixture.utterances.length, 1);

  const stoppedFixture = fixtureEnvironment();
  const stoppedReader = namespace.createScreenReaderModule(stoppedFixture.environment);
  stoppedReader.start({ voiceId: 'voice-a', rate: 1 });
  const stopPending = stoppedReader.stop();
  assert.equal(stopPending.playback, 'playing', 'a fala ainda audível não pode ser declarada encerrada');
  assert.equal(stopPending.caption, 'Primeiro, botão');
  assert.equal(stoppedFixture.speech.cancelCalls, 0);
  stoppedFixture.finishOwnedSpeech();
  assert.equal(stoppedReader.getState().playback, 'idle');
  assert.equal(stoppedReader.getState().caption, '');
});

test('next repeat and resume requested during owned speech announce after the current utterance', async () => {
  const namespace = await loadReaderFactory();

  const nextFixture = fixtureEnvironment();
  const nextReader = namespace.createScreenReaderModule(nextFixture.environment);
  nextReader.start({ voiceId: 'voice-a', rate: 1 });
  const nextPending = nextReader.next();
  assert.equal(nextPending.index, 0, 'a legenda deve continuar correspondendo à fala audível');
  assert.equal(nextFixture.utterances.length, 1);
  nextFixture.finishOwnedSpeech();
  assert.equal(nextReader.getState().index, 1);
  assert.equal(nextReader.getState().caption, 'Segundo, link');
  assert.equal(nextFixture.utterances.length, 2);
  assert.equal(nextFixture.utterances[1].text, 'Segundo, link');

  const repeatFixture = fixtureEnvironment();
  const repeatReader = namespace.createScreenReaderModule(repeatFixture.environment);
  repeatReader.start({ voiceId: 'voice-a', rate: 1 });
  repeatReader.repeat();
  assert.equal(repeatFixture.utterances.length, 1);
  repeatFixture.finishOwnedSpeech();
  assert.equal(repeatFixture.utterances.length, 2);
  assert.equal(repeatFixture.utterances[1].text, 'Primeiro, botão');

  const resumeFixture = fixtureEnvironment();
  const resumeReader = namespace.createScreenReaderModule(resumeFixture.environment);
  resumeReader.start({ voiceId: 'voice-a', rate: 1 });
  resumeReader.pause();
  const resumePending = resumeReader.resume();
  assert.equal(resumePending.playback, 'playing');
  assert.equal(resumeFixture.utterances.length, 1);
  resumeFixture.finishOwnedSpeech();
  assert.equal(resumeFixture.utterances.length, 2);
  assert.equal(resumeFixture.utterances[1].text, 'Primeiro, botão');

  for (const fixture of [nextFixture, repeatFixture, resumeFixture]) {
    assert.equal(fixture.speech.cancelCalls, 0);
    assert.equal(fixture.speech.pauseCalls, 0);
    assert.equal(fixture.speech.resumeCalls, 0);
  }
});

test('queued semantic actions run FIFO with navigation calculated only when consumed', async () => {
  const namespace = await loadReaderFactory();

  const nextRepeatFixture = fixtureEnvironment();
  const nextRepeatReader = namespace.createScreenReaderModule(nextRepeatFixture.environment);
  nextRepeatReader.start({ voiceId: 'voice-a', rate: 1 });
  nextRepeatReader.next();
  nextRepeatReader.repeat();
  nextRepeatFixture.finishOwnedSpeech();
  assert.deepEqual(nextRepeatFixture.utterances.map(item => item.text), [
    'Primeiro, botão', 'Segundo, link',
  ]);
  nextRepeatFixture.finishOwnedSpeech();
  assert.deepEqual(nextRepeatFixture.utterances.map(item => item.text), [
    'Primeiro, botão', 'Segundo, link', 'Segundo, link',
  ]);

  const nextNextFixture = fixtureEnvironment();
  const nextNextReader = namespace.createScreenReaderModule(nextNextFixture.environment);
  nextNextReader.start({ voiceId: 'voice-a', rate: 1 });
  nextNextReader.next();
  nextNextReader.next();
  nextNextFixture.finishOwnedSpeech();
  assert.equal(nextNextReader.getState().index, 1);
  nextNextFixture.finishOwnedSpeech();
  assert.equal(nextNextReader.getState().index, 2);
  assert.deepEqual(nextNextFixture.utterances.map(item => item.text), [
    'Primeiro, botão', 'Segundo, link', 'Terceiro, caixa de seleção',
  ]);

  const nextPreviousFixture = fixtureEnvironment();
  const nextPreviousReader = namespace.createScreenReaderModule(nextPreviousFixture.environment);
  nextPreviousReader.start({ voiceId: 'voice-a', rate: 1 });
  nextPreviousReader.next();
  nextPreviousReader.previous();
  nextPreviousFixture.finishOwnedSpeech();
  assert.equal(nextPreviousReader.getState().index, 1);
  nextPreviousFixture.finishOwnedSpeech();
  assert.equal(nextPreviousReader.getState().index, 0);
  assert.deepEqual(nextPreviousFixture.utterances.map(item => item.text), [
    'Primeiro, botão', 'Segundo, link', 'Primeiro, botão',
  ]);

  for (const fixture of [nextRepeatFixture, nextNextFixture, nextPreviousFixture]) {
    assert.equal(fixture.speech.cancelCalls, 0);
    assert.equal(fixture.speech.pauseCalls, 0);
    assert.equal(fixture.speech.resumeCalls, 0);
  }
});

test('pending action queue has an exact bound and overflow fails closed after owned speech', async () => {
  const namespace = await loadReaderFactory();
  const acceptedFixture = fixtureEnvironment();
  const acceptedReader = namespace.createScreenReaderModule(acceptedFixture.environment);
  acceptedReader.start({ voiceId: 'voice-a', rate: 1 });
  for (let count = 0; count < 32; count += 1) acceptedReader.repeat();
  for (let count = 0; count < 32; count += 1) acceptedFixture.finishOwnedSpeech();
  assert.equal(acceptedFixture.utterances.length, 33, '32 ações devem caber na fila fechada');
  assert.equal(acceptedReader.getState().playback, 'playing');

  const overflowFixture = fixtureEnvironment();
  const overflowReader = namespace.createScreenReaderModule(overflowFixture.environment);
  overflowReader.start({ voiceId: 'voice-a', rate: 1 });
  for (let count = 0; count < 32; count += 1) overflowReader.repeat();
  const overflow = overflowReader.next();
  assert.equal(overflow.actionStatus, 'terminal');
  assert.equal(overflow.playback, 'playing', 'overflow não pode declarar idle antes do término real');
  assert.equal(overflow.speechAvailability, 'error');
  assert.equal(overflowReader.repeat().actionStatus, 'rejected');
  overflowFixture.finishOwnedSpeech();
  assert.equal(overflowReader.getState().playback, 'idle');
  assert.equal(overflowFixture.utterances.length, 1, 'overflow descarta ações e encerra sem nova fala');
  assert.equal(overflowFixture.speech.cancelCalls, 0);
  assert.equal(overflowFixture.speech.pauseCalls, 0);
  assert.equal(overflowFixture.speech.resumeCalls, 0);

  const errorFixture = fixtureEnvironment();
  const errorReader = namespace.createScreenReaderModule(errorFixture.environment);
  errorReader.start({ voiceId: 'voice-a', rate: 1 });
  for (let count = 0; count < 32; count += 1) errorReader.repeat();
  assert.equal(errorReader.next().actionStatus, 'terminal');
  errorFixture.finishOwnedSpeech('error');
  assert.equal(errorReader.getState().playback, 'idle');
  assert.equal(errorReader.getState().speechAvailability, 'error');
  assert.equal(errorFixture.utterances.length, 1);
  assert.equal(errorFixture.speech.cancelCalls, 0);
});

test('focus-driven queue overflow emits one terminal signal and cannot silently restart', async () => {
  const namespace = await loadReaderFactory();
  const fixture = fixtureEnvironment();
  const reader = namespace.createScreenReaderModule(fixture.environment);
  reader.start({ voiceId: 'voice-a', rate: 1 });

  for (let count = 0; count < 33; count += 1) fixture.focus(fixture.candidates[1].element);

  assert.deepEqual(fixture.terminalEvents, ['queue-overflow']);
  assert.equal(reader.getState().playback, 'playing');
  assert.equal(reader.getState().speechAvailability, 'error');
  fixture.finishOwnedSpeech();
  assert.equal(reader.getState().playback, 'idle');
  assert.equal(reader.resume().actionStatus, 'accepted', 'the module remains reusable only when its owner accepts the terminal signal');
  assert.deepEqual(fixture.terminalEvents, ['queue-overflow']);
});

test('stop is terminal for queued actions but remains truthful until onend', async () => {
  const namespace = await loadReaderFactory();
  const fixture = fixtureEnvironment();
  const reader = namespace.createScreenReaderModule(fixture.environment);
  reader.start({ voiceId: 'voice-a', rate: 1 });
  assert.equal(reader.next().actionStatus, 'accepted');
  const stopping = reader.stop();
  assert.equal(stopping.actionStatus, 'accepted');
  assert.equal(reader.next().actionStatus, 'rejected');
  assert.equal(reader.repeat().actionStatus, 'rejected');

  assert.equal(stopping.playback, 'playing');
  assert.equal(reader.getState().index, 0);
  fixture.finishOwnedSpeech();
  assert.equal(reader.getState().playback, 'idle');
  assert.equal(fixture.utterances.length, 1);
  assert.equal(fixture.speech.cancelCalls, 0);
  assert.equal(fixture.speech.pauseCalls, 0);
  assert.equal(fixture.speech.resumeCalls, 0);
});
