import assert from 'node:assert/strict';
import test from 'node:test';
import { createSpeaker, pickLocalVoice } from '../../src/reader/speech.js';

const voice = (name, lang, localService) => ({ name, lang, localService });

function fakeSynthesis(voices, { late = false } = {}) {
  const listeners = new Map();
  const spoken = [];
  let list = late ? [] : voices;
  return {
    spoken,
    cancels: 0,
    getVoices: () => list,
    speak(utterance) { spoken.push(utterance); },
    cancel() { this.cancels += 1; const last = spoken.at(-1); last?.onerror?.({ error: 'interrupted' }); },
    addEventListener(type, callback) { listeners.set(type, callback); },
    removeEventListener(type) { listeners.delete(type); },
    load() { list = voices; listeners.get('voiceschanged')?.(); },
  };
}
class FakeUtterance { constructor(text) { this.text = text; } }

test('only local Portuguese voices are eligible, preferring pt-BR', () => {
  assert.equal(pickLocalVoice([voice('Google português do Brasil', 'pt-BR', false)]), null, 'online voices are never used');
  assert.equal(pickLocalVoice([voice('Samantha', 'en-US', true)]), null);
  assert.equal(pickLocalVoice([voice('Joana', 'pt-PT', true), voice('Luciana', 'pt-BR', true)]).name, 'Luciana');
  assert.equal(pickLocalVoice([voice('Joana', 'pt_PT', true)]).name, 'Joana');
  assert.equal(pickLocalVoice(null), null);
});

test('speaks nothing while off and cannot be turned on without a local voice', async () => {
  const synthesis = fakeSynthesis([voice('Google', 'pt-BR', false)]);
  const speaker = createSpeaker({ synthesis, Utterance: FakeUtterance, setTimer: callback => callback() });
  assert.equal(await speaker.speak('Olá'), false);
  assert.equal(await speaker.prepare(), null);
  assert.equal(speaker.setEnabled(true), false);
  assert.equal(await speaker.speak('Olá'), false);
  assert.equal(synthesis.spoken.length, 0);
});

test('with a local voice it speaks, resolves on end and cancels on demand', async () => {
  const synthesis = fakeSynthesis([voice('Luciana', 'pt-BR', true)]);
  const speaker = createSpeaker({ synthesis, Utterance: FakeUtterance });
  assert.equal((await speaker.prepare()).name, 'Luciana');
  assert.equal(speaker.setEnabled(true), true);
  const first = speaker.speak('Tab 1. Enviar, botão');
  const utterance = synthesis.spoken.at(-1);
  assert.equal(utterance.text, 'Tab 1. Enviar, botão');
  assert.equal(utterance.voice.name, 'Luciana');
  assert.equal(utterance.lang, 'pt-BR');
  utterance.onend();
  assert.equal(await first, true);
  const second = speaker.speak('Tab 2. Sair, link');
  speaker.cancel();
  assert.equal(await second, false);
  assert.equal(speaker.setEnabled(false), false);
  assert.equal(await speaker.speak('x'), false);
});

test('waits for the voice list that Chrome loads late', async () => {
  const synthesis = fakeSynthesis([voice('Luciana', 'pt-BR', true)], { late: true });
  const speaker = createSpeaker({ synthesis, Utterance: FakeUtterance, setTimer: () => {} });
  const ready = speaker.prepare();
  synthesis.load();
  assert.equal((await ready).name, 'Luciana');
});

test('is unavailable without the Web Speech API', async () => {
  const speaker = createSpeaker({ synthesis: undefined, Utterance: undefined });
  assert.equal(speaker.supported(), false);
  assert.equal(await speaker.prepare(), null);
  assert.equal(speaker.setEnabled(true), false);
});
