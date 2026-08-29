import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const namespaceExpression = 'globalThis[Symbol.for("audita.accessible-preview.runtime.v1")]';

async function loadReaderFactory(contextGlobals = {}) {
  const runtime = await readFile(new URL('../../src/core/accessibility/accessible-preview-runtime.classic.js', import.meta.url), 'utf8');
  let reader = '';
  try {
    reader = await readFile(new URL('../../src/personas/screen-reader-module.js', import.meta.url), 'utf8');
  } catch {
    // Keep the first missing-feature result as an assertion failure.
  }
  assert.notEqual(reader, '', 'o módulo clássico dedicado de leitura precisa existir');
  const context = vm.createContext({ ...contextGlobals });
  new vm.Script(runtime).runInContext(context);
  new vm.Script(reader).runInContext(context);
  return vm.runInContext(namespaceExpression, context);
}

function fixtureEnvironment(options = {}) {
  const events = [];
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
  class Utterance {
    constructor(text) {
      this.text = text;
      utterances.push(this);
      events.push(`utterance:${text}`);
      options.onUtterance?.(this, speech);
    }
  }
  const speech = options.speechObject ?? (options.speech === null ? null : {
    speaking: false,
    pending: false,
    paused: false,
    cancelCalls: 0,
    pauseCalls: 0,
    resumeCalls: 0,
    voices: options.voices ?? [{ voiceURI: 'voice-a', name: 'Voz A', lang: 'pt-BR', localService: true }],
    getVoices() { return this.voices; },
    speak(utterance) {
      events.push(`speak:${utterance.text}`);
      if (options.speakThrows) throw new Error('speech unavailable');
      this.speaking = true;
      this.current = utterance;
    },
    cancel() {
      events.push('cancel');
      this.cancelCalls += 1;
      this.speaking = false;
      this.pending = false;
      if (options.cancelEndsSynchronously) this.current?.onend?.();
    },
    pause() { this.pauseCalls += 1; this.paused = true; },
    resume() { this.resumeCalls += 1; this.paused = false; },
  });
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
    onFocus(listener) { focusListener = listener; return () => { focusListener = null; focusUnsubscribes += 1; }; },
    onVoicesChanged(listener) { voicesListener = listener; return () => { voicesListener = null; voicesUnsubscribes += 1; }; },
    speechSynthesis: speech,
    Utterance,
  };
  return {
    environment, speech, events, utterances, get candidates() { return candidates; },
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
  assert.equal(reader.next().index, 1);
  assert.ok(fixture.events.includes('focus:second:true'));
  assert.equal(reader.next().index, 2);
  assert.equal(reader.next().index, 2, 'não há wrap no fim');
  assert.equal(reader.getState().canNext, false);
});

test('pause/resume owns only its utterance and external focus while paused stays silent', async () => {
  const namespace = await loadReaderFactory();
  const fixture = fixtureEnvironment();
  const reader = namespace.createScreenReaderModule(fixture.environment);
  reader.start({ voiceId: 'voice-a', rate: 1 });
  assert.equal(reader.pause().playback, 'paused');
  assert.equal(fixture.speech.pauseCalls, 1);
  const utteranceCount = fixture.utterances.length;

  fixture.focus(fixture.candidates[2].element);
  assert.equal(reader.getState().index, 2);
  assert.equal(reader.getState().caption, 'Terceiro, caixa de seleção');
  assert.equal(fixture.utterances.length, utteranceCount, 'foco pausado não cria fala');
  assert.equal(reader.resume().playback, 'playing');
  assert.equal(fixture.speech.resumeCalls, 1);

  const stopped = reader.stop('requested');
  assert.equal(stopped.playback, 'idle');
  assert.equal(fixture.speech.cancelCalls, 1);
  assert.ok(fixture.events.includes('restore:original:true'));
  assert.deepEqual(reader.stop('again'), stopped, 'parar duas vezes é idempotente');
});

test('never cancels foreign speech and ignores stale synchronous callbacks from owned speech', async () => {
  const namespace = await loadReaderFactory();
  const fixture = fixtureEnvironment({ cancelEndsSynchronously: true });
  fixture.speech.speaking = true;
  const reader = namespace.createScreenReaderModule(fixture.environment);
  reader.start({ voiceId: 'voice-a', rate: 1 });
  assert.equal(fixture.utterances.length, 0);
  assert.equal(fixture.speech.cancelCalls, 0);
  assert.equal(reader.getState().speechAvailability, 'busy');

  fixture.speech.speaking = false;
  reader.repeat();
  assert.equal(fixture.utterances.length, 1);
  const stale = fixture.utterances[0];
  reader.next();
  const afterNext = reader.getState();
  assert.equal(afterNext.index, 1);
  stale.onerror?.();
  stale.onend?.();
  assert.deepEqual(reader.getState(), afterNext);
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
  fixture.speech.voices = [{ voiceURI: 'voice-b', name: 'Voz B', lang: 'pt-BR', localService: true }];
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
      voices: [{ voiceURI: 'local-default', name: 'Local padrão', lang: 'pt-BR', localService: true, default: true }],
    },
    {
      preference: 'remote-default',
      voices: [{ voiceURI: 'remote-default', name: 'Remota', lang: 'pt-BR', localService: false, default: true }],
    },
    {
      preference: 'unknown-service',
      voices: [{ voiceURI: 'unknown-service', name: 'Sem origem', lang: 'pt-BR' }],
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

test('uses only the explicitly selected descriptor-safe local voice', async () => {
  const namespace = await loadReaderFactory();
  const local = { voiceURI: 'local-a', name: 'Voz local', lang: 'pt-BR', localService: true };
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
  const local = { voiceURI: 'local-a', name: 'Voz local', lang: 'pt-BR', localService: true };
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
  repeatFixture.speech.speaking = false;
  repeatReader.repeat();
  assert.equal(repeatFixture.events.filter(value => value.startsWith('speak:')).length, 1);
  assert.equal(repeatReader.getState().voiceId, '');
  assert.equal(repeatReader.getState().speechAvailability, 'unavailable');

  const changedFixture = fixtureEnvironment({ voices: [local] });
  const changedReader = namespace.createScreenReaderModule(changedFixture.environment);
  changedReader.start({ voiceId: 'local-a', rate: 1 });
  changedFixture.speech.voices = [];
  changedFixture.voicesChanged();
  assert.equal(changedFixture.speech.cancelCalls, 1);
  assert.equal(changedReader.getState().voiceId, '');
  assert.equal(changedReader.getState().speechAvailability, 'unavailable');
});
