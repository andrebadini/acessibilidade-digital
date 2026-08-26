import { sanitizeWarning } from '../core/privacy.js';

class ProbeFailure extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function positiveTimeout(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function deadline(promiseFactory, { signal, timeoutMs, useSignal = true }) {
  if (useSignal && signal?.aborted) return Promise.reject(new ProbeFailure('ABORTED'));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = callback => value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (useSignal) signal?.removeEventListener('abort', onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject)(new ProbeFailure('ABORTED'));
    const timer = setTimeout(() => finish(reject)(new ProbeFailure('TIMEOUT')), timeoutMs);
    if (useSignal) signal?.addEventListener('abort', onAbort, { once: true });
    Promise.resolve().then(promiseFactory).then(finish(resolve), finish(reject));
  });
}

/** Runs non-destructive probes with per-call cancellation and deadlines. */
export async function runDynamicProbes(options = {}) {
  const adapter = options.adapter ?? options;
  if (!adapter || typeof adapter !== 'object') throw new TypeError('O adaptador de probes é obrigatório.');
  const timeoutMs = positiveTimeout(options.timeoutMs, 5_000);
  const cleanupTimeoutMs = positiveTimeout(options.cleanupTimeoutMs, 1_000);
  const warnings = [];
  const actions = [];
  const raw = { focus: { focusableCount: null, completed: false, events: [] }, warnings, actions };
  let state = null;
  let guardsInstalled = false;

  const invoke = (name, args = []) => {
    if (typeof adapter[name] !== 'function') throw new ProbeFailure('PROBE_FAILED');
    return deadline(() => adapter[name](...args), { signal: options.signal, timeoutMs });
  };
  const cleanup = async (name, args, target) => {
    if (typeof adapter[name] !== 'function') return;
    actions.push({ type: 'restore', target });
    try {
      await deadline(() => adapter[name](...args), { timeoutMs: cleanupTimeoutMs, useSignal: false });
    } catch (error) {
      warnings.push(sanitizeWarning({ code: error instanceof ProbeFailure ? error.code : 'PROBE_FAILED' }));
    }
  };

  try {
    state = await invoke('snapshotState');
    if (!state || typeof state !== 'object') throw new ProbeFailure('PROBE_FAILED');
    actions.push({ type: 'guard-navigation', operation: 'install' });
    await invoke('installNavigationGuards');
    guardsInstalled = true;

    const count = await invoke('getFocusableCount');
    if (!Number.isSafeInteger(count) || count < 0) throw new ProbeFailure('PROBE_FAILED');
    raw.focus.focusableCount = count;
    for (let index = 0; index < count + 2; index += 1) {
      actions.push({ type: 'key', key: 'Tab', index });
      const event = await invoke('pressTab');
      if (!event || typeof event !== 'object') throw new ProbeFailure('PROBE_FAILED');
      raw.focus.events.push(event);
    }
    raw.focus.completed = true;

    actions.push({ type: 'viewport', widthCssPx: 320 });
    raw.reflow = await invoke('measureReflow', [320]);
    actions.push({ type: 'text-resize', scalePercent: 200 });
    raw.textResize = await invoke('measureTextResize', [200]);
    actions.push({ type: 'measure-targets', thresholdsCssPx: [24, 44] });
    raw.targetSizes = await invoke('measureTargetSizes', [[24, 44]]);
    actions.push({ type: 'motion', preference: 'reduce' });
    raw.motion = await invoke('measureMotion', [{ prefersReducedMotion: true, preference: 'reduce' }]);
  } catch (error) {
    warnings.push(sanitizeWarning({ code: error instanceof ProbeFailure ? error.code : 'PROBE_FAILED' }));
  } finally {
    if (guardsInstalled) await cleanup('removeNavigationGuards', [], 'listeners');
    if (state && Object.hasOwn(state, 'styles')) await cleanup('restoreStyles', [state.styles], 'styles');
    if (state && Object.hasOwn(state, 'viewport')) await cleanup('restoreViewport', [state.viewport], 'viewport');
    if (state && Object.hasOwn(state, 'scroll')) await cleanup('restoreScroll', [state.scroll], 'scroll');
    if (state && Object.hasOwn(state, 'focus')) await cleanup('restoreFocus', [state.focus], 'focus');
  }
  return raw;
}
