import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const namespaceExpression = 'globalThis[Symbol.for("audita.accessible-preview.runtime.v1")]';

async function loadReaderFactory() {
  const runtime = await readFile(new URL('../../src/core/accessibility/accessible-preview-runtime.classic.js', import.meta.url), 'utf8');
  let reader = '';
  try {
    reader = await readFile(new URL('../../src/personas/screen-reader-module.js', import.meta.url), 'utf8');
  } catch {
    // Keep the first missing-feature result as an assertion failure.
  }
  assert.notEqual(reader, '', 'o módulo clássico dedicado de leitura precisa existir');
  const context = vm.createContext({});
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
    }
  }
  const speech = options.speech === null ? null : {
    speaking: false,
    pending: false,
    paused: false,
    cancelCalls: 0,
    pauseCalls: 0,
    resumeCalls: 0,
    voices: options.voices ?? [{ voiceURI: 'voice-a', name: 'Voz A', lang: 'pt-BR' }],
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
  };
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
  reader.start({ voiceId: '', rate: 1 });
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
  reader.start({ voiceId: '', rate: 1 });
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
  fixture.speech.voices = [{ voiceURI: 'voice-b', name: 'Voz B', lang: 'pt-BR' }];
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
  reader.start({ voiceId: '', rate: 1 });
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
