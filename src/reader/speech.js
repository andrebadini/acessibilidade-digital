/**
 * Leitura em voz alta opcional da conferência de Tab.
 *
 * Usa somente vozes locais do sistema (`localService === true`). Vozes on-line enviariam o texto da página
 * a um serviço externo, o que contraria o processamento local da extensão; sem voz local em português, a
 * opção com áudio fica indisponível e a conferência continua sem áudio.
 */

export const SPEECH_LANGUAGE = 'pt-BR';
const VOICE_WAIT_MS = 1500;

/** Escolhe uma voz local em português, preferindo pt-BR. Retorna null se não houver. */
export function pickLocalVoice(voices, language = SPEECH_LANGUAGE) {
  const local = (Array.isArray(voices) ? voices : []).filter(voice => voice && voice.localService === true && typeof voice.lang === 'string');
  const normalized = voice => voice.lang.replace('_', '-').toLowerCase();
  const wanted = language.toLowerCase();
  return local.find(voice => normalized(voice) === wanted)
    ?? local.find(voice => normalized(voice).startsWith(`${wanted.split('-')[0]}-`) || normalized(voice) === wanted.split('-')[0])
    ?? null;
}

/**
 * Cria o leitor em voz alta. `synthesis` e `Utterance` são injetáveis para teste.
 * Enquanto desligado, `speak` não fala nada e resolve `false`.
 */
export function createSpeaker({
  synthesis = globalThis.speechSynthesis,
  Utterance = globalThis.SpeechSynthesisUtterance,
  setTimer = (callback, ms) => globalThis.setTimeout(callback, ms),
} = {}) {
  let enabled = false;
  let voice = null;
  let pending = null;

  const supported = () => Boolean(synthesis && typeof synthesis.speak === 'function' && typeof Utterance === 'function');

  function findVoice() {
    if (!supported()) return null;
    try { return pickLocalVoice(synthesis.getVoices()); } catch { return null; }
  }

  /** Procura a voz local; o Chrome pode carregar a lista de vozes alguns instantes depois. */
  async function prepare() {
    voice = findVoice();
    if (voice || !supported() || typeof synthesis.addEventListener !== 'function') return voice;
    await new Promise(resolve => {
      const done = () => { synthesis.removeEventListener?.('voiceschanged', done); resolve(); };
      synthesis.addEventListener('voiceschanged', done);
      setTimer(done, VOICE_WAIT_MS);
    });
    voice = findVoice();
    return voice;
  }

  function finishPending(result) {
    const current = pending;
    pending = null;
    current?.(result);
  }

  function cancel() {
    if (supported()) {
      try { synthesis.cancel(); } catch { /* nada a cancelar */ }
    }
    finishPending(false);
  }

  /** Fala o texto e resolve quando termina (true) ou quando é interrompido/indisponível (false). */
  function speak(text) {
    if (!enabled || !voice || !supported() || typeof text !== 'string' || !text.trim()) return Promise.resolve(false);
    cancel();
    return new Promise(resolve => {
      pending = resolve;
      const utterance = new Utterance(text.slice(0, 600));
      utterance.lang = voice.lang;
      try { utterance.voice = voice; } catch { /* o idioma já orienta a escolha da voz */ }
      utterance.onend = () => { if (pending === resolve) finishPending(true); };
      utterance.onerror = () => { if (pending === resolve) finishPending(false); };
      try { synthesis.speak(utterance); } catch { finishPending(false); }
    });
  }

  return {
    supported,
    prepare,
    speak,
    cancel,
    voice: () => voice,
    enabled: () => enabled,
    /** Liga só se houver voz local; retorna o estado efetivo. */
    setEnabled(value) {
      enabled = Boolean(value) && Boolean(voice);
      if (!enabled) cancel();
      return enabled;
    },
  };
}
