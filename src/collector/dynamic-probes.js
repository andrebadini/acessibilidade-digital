import { redactSensitiveText } from '../core/privacy.js';

function errorMessage(error) {
  return redactSensitiveText(error instanceof Error ? error.message : error);
}

function abortMessage(signal) {
  if (!signal?.aborted) return '';
  return typeof signal.reason === 'string' && signal.reason ? signal.reason : 'Probe cancelado.';
}

/**
 * Runs non-destructive probes through an injected browser/CDP adapter.
 * The adapter is the boundary used by the disposable audit tab: it may use
 * CDP Input/Emulation and Runtime.evaluate, while this orchestration remains
 * deterministic and independently testable.
 */
export async function runDynamicProbes(options = {}) {
  const adapter = options.adapter ?? options;
  if (!adapter || typeof adapter !== 'object') throw new TypeError('O adaptador de probes é obrigatório.');
  const warnings = [];
  const actions = [];
  const raw = { focus: { focusableCount: null, completed: false, events: [] }, warnings, actions };
  let state = { focus: null, scroll: null, viewport: null, styles: null };

  const warn = (code, error) => warnings.push({ code, message: errorMessage(error) });
  const call = async (name, args, code) => {
    if (typeof adapter[name] !== 'function') {
      warn(code, `${name} indisponível`);
      return undefined;
    }
    try {
      return await adapter[name](...args);
    } catch (error) {
      warn(code, error);
      return undefined;
    }
  };

  try {
    if (typeof adapter.snapshotState === 'function') {
      try {
        state = { ...state, ...(await adapter.snapshotState()) };
      } catch (error) {
        warn('STATE_CAPTURE_FAILED', error);
      }
    } else {
      warn('STATE_CAPTURE_MISSING', 'snapshotState indisponível');
    }

    if (options.signal?.aborted) {
      warn('CANCELLED', abortMessage(options.signal));
      return raw;
    }

    actions.push({ type: 'guard-navigation', operation: 'install' });
    await call('installNavigationGuards', [], 'GUARD_INSTALL_FAILED');

    const count = await call('getFocusableCount', [], 'FOCUSABLE_COUNT_FAILED');
    if (Number.isSafeInteger(count) && count >= 0) {
      raw.focus.focusableCount = count;
      const limit = count + 2;
      let complete = true;
      for (let index = 0; index < limit; index += 1) {
        if (options.signal?.aborted) {
          warn('CANCELLED', abortMessage(options.signal));
          complete = false;
          break;
        }
        actions.push({ type: 'key', key: 'Tab', index });
        const event = await call('pressTab', [], 'TAB_PROBE_FAILED');
        if (!event) {
          complete = false;
          break;
        }
        raw.focus.events.push(event);
      }
      raw.focus.completed = complete;
    }

    if (!options.signal?.aborted) {
      actions.push({ type: 'viewport', widthCssPx: 320 });
      raw.reflow = await call('measureReflow', [320], 'REFLOW_PROBE_FAILED');
      actions.push({ type: 'text-resize', scalePercent: 200 });
      raw.textResize = await call('measureTextResize', [200], 'TEXT_RESIZE_PROBE_FAILED');
      actions.push({ type: 'measure-targets', thresholdsCssPx: [24, 44] });
      raw.targetSizes = await call('measureTargetSizes', [[24, 44]], 'TARGET_SIZE_PROBE_FAILED');
      actions.push({ type: 'motion', prefersReducedMotion: true });
      raw.motion = await call('measureMotion', [{ prefersReducedMotion: true }], 'MOTION_PROBE_FAILED');
    }
  } finally {
    const restorations = [
      ['removeNavigationGuards', [], 'GUARD_REMOVE_FAILED', 'listeners'],
      ['restoreStyles', [state.styles], 'STYLE_RESTORE_FAILED', 'styles'],
      ['restoreViewport', [state.viewport], 'VIEWPORT_RESTORE_FAILED', 'viewport'],
      ['restoreScroll', [state.scroll], 'SCROLL_RESTORE_FAILED', 'scroll'],
      ['restoreFocus', [state.focus], 'FOCUS_RESTORE_FAILED', 'focus']
    ];
    for (const [name, args, code, target] of restorations) {
      actions.push({ type: 'restore', target });
      await call(name, args, code);
    }
  }
  return raw;
}
