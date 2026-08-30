import { applyAuditaPersonaCommand } from '../personas/persona-command.js';

export const PERSONA_INJECTION_FILES = Object.freeze([
  'src/core/accessibility/accessible-preview-runtime.classic.js',
  'src/personas/screen-reader-module.js',
  'src/personas/content.js',
]);
export const PERSONA_INJECTION_CSS = Object.freeze(['src/personas/personas.css']);

const MODES = new Set(['reader', 'achromatopsia', 'motor']);
const TARGET_KEYS = ['tabId', 'windowId', 'documentId', 'urlSessionDigest'];
const DIGEST = /^hmac-sha256:[A-Za-z0-9_-]{43}$/u;
const READER_ACTIONS = new Set(['previous', 'repeat', 'pause', 'resume', 'next', 'stop']);
const READER_STATE_KEYS = [
  'version', 'playback', 'index', 'total', 'caption', 'canPrevious', 'canNext',
  'speechAvailability', 'voiceId', 'rate',
];

function exactDataRecord(value, keys) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== keys.length ||
      ownKeys.some(key => typeof key !== 'string' || !keys.includes(key))) return null;
    const copy = Object.create(null);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      copy[key] = descriptor.value;
    }
    return copy;
  } catch {
    return null;
  }
}

function parseTarget(value) {
  const target = exactDataRecord(value, TARGET_KEYS);
  if (!target || !Number.isSafeInteger(target.tabId) || target.tabId <= 0 ||
    !Number.isSafeInteger(target.windowId) || target.windowId < 0 ||
    typeof target.documentId !== 'string' || target.documentId.length < 1 ||
    target.documentId.length > 512 || /[\u0000-\u001F\u007F]/u.test(target.documentId) ||
    !DIGEST.test(target.urlSessionDigest ?? '')) return null;
  return Object.freeze({
    tabId: target.tabId,
    windowId: target.windowId,
    documentId: target.documentId,
    urlSessionDigest: target.urlSessionDigest,
  });
}

function parseApplyInput(value) {
  const inspect = exactDataRecord(value, ['target', 'op']);
  if (inspect && ['inspect', 'clear'].includes(inspect.op)) {
    const target = parseTarget(inspect.target);
    return target ? { target, op: inspect.op, mode: null } : null;
  }
  const install = exactDataRecord(value, ['target', 'op', 'mode']);
  if (!install || install.op !== 'install' || !MODES.has(install.mode)) return null;
  const target = parseTarget(install.target);
  return target ? { target, op: 'install', mode: install.mode } : null;
}

function canonicalText(value, limit, allowEmpty) {
  if (typeof value !== 'string' || /[\u0000-\u001F\u007F]/u.test(value)) return null;
  const normalized = Array.from(value.replace(/\s+/gu, ' ').trim()).slice(0, limit).join('');
  return (allowEmpty || normalized) && normalized === value ? normalized : null;
}

function parseReaderInput(value) {
  const input = exactDataRecord(value, ['target', 'command']);
  if (!input) return null;
  const target = parseTarget(input.target);
  if (!target) return null;

  const basic = exactDataRecord(input.command, ['version', 'op']);
  if (basic && basic.version === 1 && basic.op === 'state') {
    return { target, bridgeCommand: { version: 1, op: 'reader-state' }, gestureRequired: false };
  }
  const action = exactDataRecord(input.command, ['version', 'op', 'action']);
  if (action && action.version === 1 && action.op === 'action' && READER_ACTIONS.has(action.action)) {
    return {
      target,
      bridgeCommand: { version: 1, op: 'reader-action', action: action.action },
      gestureRequired: false,
    };
  }
  const voices = exactDataRecord(input.command, ['version', 'op', 'explicitUserGesture']);
  if (voices && voices.version === 1 && voices.op === 'voices' &&
    typeof voices.explicitUserGesture === 'boolean') {
    return {
      target,
      bridgeCommand: {
        version: 1,
        op: 'reader-voices',
        explicitUserGesture: voices.explicitUserGesture,
      },
      gestureRequired: !voices.explicitUserGesture,
    };
  }
  const preferences = exactDataRecord(input.command, ['version', 'op', 'voiceId', 'rate']);
  const voiceId = preferences && canonicalText(preferences.voiceId, 200, false);
  if (preferences && preferences.version === 1 && preferences.op === 'preferences' &&
    voiceId !== null && typeof preferences.rate === 'number' && Number.isFinite(preferences.rate) &&
    preferences.rate >= 0.5 && preferences.rate <= 2) {
    return {
      target,
      bridgeCommand: {
        version: 1,
        op: 'reader-preferences',
        voiceId,
        rate: preferences.rate,
      },
      gestureRequired: false,
    };
  }
  return null;
}

function parseInjectionMeta(results, expectedDocumentId) {
  try {
    if (!Array.isArray(results) || results.length !== 1) return null;
    const record = results[0];
    if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
    const frameDescriptor = Object.getOwnPropertyDescriptor(record, 'frameId');
    const documentDescriptor = Object.getOwnPropertyDescriptor(record, 'documentId');
    if (!frameDescriptor?.enumerable || !Object.hasOwn(frameDescriptor, 'value') ||
      !documentDescriptor?.enumerable || !Object.hasOwn(documentDescriptor, 'value') ||
      !Number.isSafeInteger(frameDescriptor.value) || frameDescriptor.value !== 0 ||
      documentDescriptor.value !== expectedDocumentId) return null;
    return record;
  } catch {
    return null;
  }
}

function parseProbeResult(value) {
  const result = exactDataRecord(value, ['ok', 'present', 'mode']);
  return result && result.ok === true && typeof result.present === 'boolean' &&
    (result.mode === null || MODES.has(result.mode))
    ? { ok: true, present: result.present, mode: result.mode }
    : null;
}

function parseCommandResult(value) {
  const success = exactDataRecord(value, ['ok', 'mode']);
  if (success && success.ok === true && (success.mode === null || MODES.has(success.mode))) {
    return { ok: true, mode: success.mode };
  }
  const failure = exactDataRecord(value, ['ok', 'reason']);
  if (failure && failure.ok === false && [
    'invalid-command', 'runtime-missing', 'runtime-brand-mismatch', 'runtime-error', 'cleanup-unconfirmed',
  ].includes(failure.reason)) return { ok: false, reason: failure.reason };
  return null;
}

function parseReaderState(value) {
  const state = exactDataRecord(value, READER_STATE_KEYS);
  if (!state || state.version !== 1 || !['idle', 'playing', 'paused'].includes(state.playback) ||
    !Number.isSafeInteger(state.index) || !Number.isSafeInteger(state.total) ||
    state.total < 0 || state.total > 2000 || typeof state.canPrevious !== 'boolean' ||
    typeof state.canNext !== 'boolean' ||
    !['available', 'unavailable', 'busy', 'error'].includes(state.speechAvailability) ||
    typeof state.rate !== 'number' || !Number.isFinite(state.rate) ||
    state.rate < 0.5 || state.rate > 2) return null;
  const caption = canonicalText(state.caption, 2048, true);
  const voiceId = canonicalText(state.voiceId, 200, true);
  if (caption === null || voiceId === null) return null;
  if (state.playback === 'idle') {
    if (state.index !== -1 || state.total !== 0 || caption !== '' ||
      state.canPrevious || state.canNext) return null;
  } else if (state.total < 1 || state.index < 0 || state.index >= state.total || !caption ||
    state.canPrevious !== (state.index > 0) ||
    state.canNext !== (state.index < state.total - 1)) return null;
  return Object.freeze({
    version: 1,
    playback: state.playback,
    index: state.index,
    total: state.total,
    caption,
    canPrevious: state.canPrevious,
    canNext: state.canNext,
    speechAvailability: state.speechAvailability,
    voiceId,
    rate: state.rate,
  });
}

function parseReaderVoices(value) {
  if (!Array.isArray(value)) return null;
  let length;
  let keys;
  try {
    length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
    keys = Reflect.ownKeys(value);
  } catch { return null; }
  if (!Number.isSafeInteger(length) || length < 0 || length > 128 || keys.length !== length + 1) {
    return null;
  }
  const ids = new Set();
  const voices = [];
  for (let index = 0; index < length; index += 1) {
    let item;
    try {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      item = descriptor?.enumerable && Object.hasOwn(descriptor, 'value')
        ? exactDataRecord(descriptor.value, ['id', 'label', 'lang'])
        : null;
    } catch { return null; }
    const id = item && canonicalText(item.id, 200, false);
    const label = item && canonicalText(item.label, 200, false);
    const lang = item && canonicalText(item.lang, 64, true);
    if (!item || id === null || label === null || lang === null || ids.has(id)) return null;
    ids.add(id);
    voices.push(Object.freeze({ id, label, lang }));
  }
  return Object.freeze(voices);
}

function parseReaderCommandResult(value) {
  const actionResult = exactDataRecord(value, ['ok', 'kind', 'actionStatus', 'state']);
  if (actionResult && actionResult.ok === true && actionResult.kind === 'state' &&
    ['accepted', 'rejected', 'terminal'].includes(actionResult.actionStatus)) {
    const state = parseReaderState(actionResult.state);
    return state
      ? { ok: true, kind: 'state', actionStatus: actionResult.actionStatus, state }
      : null;
  }
  const stateResult = exactDataRecord(value, ['ok', 'kind', 'state']);
  if (stateResult && stateResult.ok === true && stateResult.kind === 'state') {
    const state = parseReaderState(stateResult.state);
    return state ? { ok: true, kind: 'state', state } : null;
  }
  const voicesResult = exactDataRecord(value, ['ok', 'kind', 'status', 'voices']);
  if (voicesResult && voicesResult.ok === true && voicesResult.kind === 'voices' &&
    ['available', 'unavailable'].includes(voicesResult.status)) {
    const voices = parseReaderVoices(voicesResult.voices);
    if (!voices || (voicesResult.status === 'unavailable' && voices.length !== 0)) return null;
    return { ok: true, kind: 'voices', status: voicesResult.status, voices };
  }
  const failureResult = exactDataRecord(value, ['ok', 'reason']);
  if (failureResult && failureResult.ok === false && [
    'invalid-command', 'runtime-missing', 'runtime-brand-mismatch', 'runtime-error',
    'reader-inactive', 'gesture-required', 'voice-unavailable',
  ].includes(failureResult.reason)) return { ok: false, reason: failureResult.reason };
  return null;
}

function missingDocumentError(error) {
  let message = '';
  try { message = typeof error?.message === 'string' ? error.message : ''; } catch { return false; }
  return /(?:no (?:document|frame|tab)|document .* not found|frame .* not found|tab .* (?:closed|not found)|cannot access (?:a )?chrome)/iu.test(message);
}

function success(documentId, mode) {
  return Object.freeze({ ok: true, documentId, frameId: 0, mode });
}

function failure(reason) {
  return Object.freeze({ ok: false, reason });
}

function publicCommandFailure(reason) {
  return failure(reason === 'document-missing' || reason === 'result-mismatch'
    ? reason
    : 'runtime-error');
}

export function createPersonaInjectionRuntime({ chromeApi } = {}) {
  if (!chromeApi?.scripting || typeof chromeApi.scripting.executeScript !== 'function' ||
    typeof chromeApi.scripting.insertCSS !== 'function' ||
    typeof chromeApi.scripting.removeCSS !== 'function') {
    throw new TypeError('PERSONA_RUNTIME_CHROME_INVALID');
  }

  async function execute(target, details) {
    try {
      const results = await chromeApi.scripting.executeScript({
        target: { tabId: target.tabId, documentIds: [target.documentId] },
        world: 'ISOLATED',
        ...details,
      });
      const result = parseInjectionMeta(results, target.documentId);
      return result ? { ok: true, result } : { ok: false, reason: 'result-mismatch' };
    } catch (error) {
      return { ok: false, reason: missingDocumentError(error) ? 'document-missing' : 'runtime-error' };
    }
  }

  async function command(target, value, type) {
    const executed = await execute(target, { func: applyAuditaPersonaCommand, args: [value] });
    if (!executed.ok) return executed;
    let raw;
    try {
      const descriptor = Object.getOwnPropertyDescriptor(executed.result, 'result');
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) return { ok: false, reason: 'result-mismatch' };
      raw = descriptor.value;
    } catch {
      return { ok: false, reason: 'result-mismatch' };
    }
    const parsed = type === 'probe'
      ? parseProbeResult(raw)
      : type === 'reader'
        ? parseReaderCommandResult(raw)
        : parseCommandResult(raw);
    return parsed ?? { ok: false, reason: 'result-mismatch' };
  }

  async function executeFiles(target) {
    return execute(target, { files: [...PERSONA_INJECTION_FILES] });
  }

  async function insertCss(target) {
    try {
      await chromeApi.scripting.insertCSS({
        target: { tabId: target.tabId, documentIds: [target.documentId] },
        files: [...PERSONA_INJECTION_CSS],
        origin: 'AUTHOR',
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: missingDocumentError(error) ? 'document-missing' : 'runtime-error' };
    }
  }

  async function removeCss(target) {
    try {
      await chromeApi.scripting.removeCSS({
        target: { tabId: target.tabId, documentIds: [target.documentId] },
        files: [...PERSONA_INJECTION_CSS],
        origin: 'AUTHOR',
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: missingDocumentError(error) ? 'document-missing' : 'runtime-error' };
    }
  }

  async function apply(value) {
    const input = parseApplyInput(value);
    if (!input) throw new TypeError('PERSONA_RUNTIME_INPUT_INVALID');
    const probe = await command(input.target, { version: 1, op: 'probe' }, 'probe');
    if (!probe.ok) return failure(probe.reason);

    if (input.op === 'inspect') {
      if (!probe.present) return success(input.target.documentId, null);
      const inspected = await command(input.target, { version: 1, op: 'inspect' }, 'command');
      if (!inspected.ok) return publicCommandFailure(inspected.reason);
      return success(input.target.documentId, inspected.mode);
    }

    if (input.op === 'install') {
      if (!probe.present) {
        const files = await executeFiles(input.target);
        if (!files.ok) return failure(files.reason);
      }
      const css = await insertCss(input.target);
      if (!css.ok) return failure(css.reason);
      const installed = await command(
        input.target,
        { version: 1, op: 'install', mode: input.mode },
        'command',
      );
      if (!installed.ok) return publicCommandFailure(installed.reason);
      if (installed.mode !== input.mode) return failure('result-mismatch');
      return success(input.target.documentId, installed.mode);
    }

    if (!probe.present) {
      const css = await removeCss(input.target);
      if (!css.ok && css.reason !== 'document-missing') return failure('cleanup-unconfirmed');
      if (css.reason === 'document-missing') return failure('document-missing');
      const confirmedProbe = await command(input.target, { version: 1, op: 'probe' }, 'probe');
      if (!confirmedProbe.ok) return failure(confirmedProbe.reason);
      if (!confirmedProbe.present) return success(input.target.documentId, null);
      const confirmedInspect = await command(input.target, { version: 1, op: 'inspect' }, 'command');
      if (!confirmedInspect.ok) return failure(
        confirmedInspect.reason === 'document-missing' || confirmedInspect.reason === 'result-mismatch'
          ? confirmedInspect.reason
          : 'cleanup-unconfirmed',
      );
      return confirmedInspect.mode === null
        ? success(input.target.documentId, null)
        : failure('cleanup-unconfirmed');
    }

    const cleared = await command(input.target, { version: 1, op: 'clear' }, 'command');
    const css = await removeCss(input.target);
    if (css.reason === 'document-missing') return failure('document-missing');
    const inspected = await command(input.target, { version: 1, op: 'inspect' }, 'command');
    if (!cleared.ok || !css.ok || !inspected.ok || cleared.mode !== null || inspected.mode !== null) {
      if (cleared.reason === 'result-mismatch' || inspected.reason === 'result-mismatch') {
        return failure('result-mismatch');
      }
      if (cleared.reason === 'document-missing' || inspected.reason === 'document-missing') {
        return failure('document-missing');
      }
      return failure('cleanup-unconfirmed');
    }
    return success(input.target.documentId, null);
  }

  async function reader(value) {
    const input = parseReaderInput(value);
    if (!input) throw new TypeError('PERSONA_RUNTIME_INPUT_INVALID');
    if (input.gestureRequired) return failure('gesture-required');

    const probe = await command(input.target, { version: 1, op: 'probe' }, 'probe');
    if (!probe.ok) return failure(probe.reason);
    if (!probe.present || probe.mode !== 'reader') return failure('reader-inactive');

    const commanded = await command(input.target, input.bridgeCommand, 'reader');
    if (!commanded.ok) {
      if (['reader-inactive', 'gesture-required', 'voice-unavailable'].includes(commanded.reason)) {
        return failure(commanded.reason);
      }
      return publicCommandFailure(commanded.reason);
    }
    if (commanded.kind === 'state') {
      const expectsActionStatus = input.bridgeCommand.op === 'reader-action';
      if (expectsActionStatus !== Object.hasOwn(commanded, 'actionStatus')) {
        return failure('result-mismatch');
      }
      return Object.freeze({
        ok: true,
        documentId: input.target.documentId,
        frameId: 0,
        kind: 'state',
        ...(expectsActionStatus ? { actionStatus: commanded.actionStatus } : {}),
        state: commanded.state,
      });
    }
    return Object.freeze({
      ok: true,
      documentId: input.target.documentId,
      frameId: 0,
      kind: 'voices',
      status: commanded.status,
      voices: commanded.voices,
    });
  }

  return Object.freeze({ apply, reader });
}
