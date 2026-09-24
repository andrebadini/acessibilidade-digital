/**
 * Percurso guiado pela sequência estimada de Tab: destaca cada parada na página, mostra a legenda e,
 * se a leitura em voz alta estiver ligada, fala o anúncio estimado. Não pressiona teclas nem aciona
 * controles do site. Pode ser interrompido a qualquer momento (botão Parar, Escape na página ou no relatório).
 */
import { spokenAnnouncement } from './plain-language.js';

export const WALK_STEP_MS = 2500;
export const WALK_PAUSE_AFTER_SPEECH_MS = 600;

/** Paradas de Tab em ordem. */
export function tabWalkEntries(entries) {
  return (Array.isArray(entries) ? entries : [])
    .filter(entry => entry.category === 'tab' && Number.isSafeInteger(entry.tabOrder))
    .sort((a, b) => a.tabOrder - b.tabOrder);
}

/**
 * @param {object} options
 * @param {Array} options.entries entradas do relatório
 * @param {(entry: object) => Promise<unknown>} options.highlight destaca a parada na página
 * @param {(text: string) => Promise<boolean>} options.speak fala o texto; resolve false quando não fala
 * @param {() => void} [options.cancelSpeech]
 * @param {(entry: object, index: number, total: number) => void} [options.onStep]
 * @param {(outcome: string, error?: unknown) => void} [options.onEnd] outcome: done | stopped | escape | page-changed | error | empty
 */
export function createTabWalk({
  entries,
  highlight,
  speak,
  cancelSpeech = () => {},
  onStep = () => {},
  onEnd = () => {},
  setTimer = (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimer = id => globalThis.clearTimeout(id),
}) {
  const stops = tabWalkEntries(entries);
  let state = 'idle';
  let wake = null;
  let finished = null;

  function wait(ms) {
    return new Promise(resolve => {
      const id = setTimer(() => { wake = null; resolve(); }, ms);
      wake = () => { clearTimer(id); wake = null; resolve(); };
    });
  }

  async function loop() {
    if (!stops.length) return 'empty';
    for (const [index, entry] of stops.entries()) {
      if (state !== 'running') return 'stopped';
      try {
        await highlight(entry);
      } catch (error) {
        if (state !== 'running') return 'stopped';
        if (error?.code === 'WALK_ESCAPED') return 'escape';
        if (error?.code === 'PAGE_CHANGED') return 'page-changed';
        throw error;
      }
      if (state !== 'running') return 'stopped';
      onStep(entry, index, stops.length);
      const spoken = await speak(spokenAnnouncement(entry));
      if (state !== 'running') return 'stopped';
      await wait(spoken ? WALK_PAUSE_AFTER_SPEECH_MS : WALK_STEP_MS);
    }
    return state === 'running' ? 'done' : 'stopped';
  }

  return {
    total: stops.length,
    running: () => state === 'running',
    /** Inicia o percurso; resolve com o desfecho quando termina. */
    start() {
      if (state !== 'idle') return finished;
      state = 'running';
      finished = loop().then(
        outcome => { state = 'ended'; onEnd(outcome); return outcome; },
        error => { state = 'ended'; cancelSpeech(); onEnd('error', error); return 'error'; },
      );
      return finished;
    },
    /** Interrompe e resolve quando o laço terminou. */
    stop() {
      if (state === 'running') state = 'stopping';
      cancelSpeech();
      wake?.();
      return finished ?? Promise.resolve('stopped');
    },
  };
}
