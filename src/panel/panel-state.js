import { PANEL_UNPREPARED_MESSAGE } from './panel-status.js';

const PANEL_AUDIT_ID = /^[A-Za-z0-9._:-]{1,160}$/u;
const PANEL_FILTERS = Object.freeze(['impact', 'wcag', 'abnt']);
const PERSONA_MODES = new Set(['reader', 'achromatopsia', 'keyboard']);
const PANEL_UNAVAILABLE_REASONS = new Set([
  PANEL_UNPREPARED_MESSAGE,
  'O resultado local não pôde ser exibido com segurança.',
  'Não foi possível concluir a operação local.',
]);
const HIGHLIGHT_BINDING_REASONS = new Set(['no-binding', 'expired', 'live-proof-failed']);
const READER_SPEECH_AVAILABILITY = new Set(['available', 'unavailable', 'busy', 'error']);

function neutralPersona(message = 'Escolha uma simulação para esta página.') {
  return { mode: null, readerPaused: false, speechAvailability: 'unavailable', voiceId: '', rate: 1, message };
}

function uncheckedHighlight() {
  return { state: 'idle', operation: null, occurrenceId: null, bindingStatus: { state: 'unchecked' }, message: null };
}

export function createInitialPanelState() {
  return deepFreezePanelState({
    version: 1,
    screen: 'initial',
    auditId: null,
    filters: { impact: [], wcag: [], abnt: [] },
    selectedOccurrenceId: null,
    evidenceExpanded: false,
    persona: neutralPersona(),
    highlight: uncheckedHighlight(),
    focusId: 'start-attached',
    scrollTop: 0,
    reason: null,
  });
}

export function reducePanelState(current, event) {
  if (!panelState(current)) return current;
  current = immutablePanelState(current);
  if (!event || typeof event !== 'object' || Array.isArray(event)) return current;
  switch (event.type) {
    case 'BOOTSTRAP_INITIAL':
      return createInitialPanelState();
    case 'START_REQUESTED':
      return nextPanelState(current, {
        screen: 'running', auditId: null, selectedOccurrenceId: null,
        evidenceExpanded: false, focusId: 'cancel-audit', scrollTop: 0, reason: null,
      });
    case 'AUDIT_RUNNING':
      if (!validPanelAuditId(event.auditId)) return current;
      return nextPanelState(current, {
        screen: 'running', auditId: event.auditId, selectedOccurrenceId: null,
        evidenceExpanded: false, focusId: 'cancel-audit', reason: null,
      });
    case 'AUDIT_RESULT': {
      if (!validPanelAuditId(event.auditId) || event.result?.auditId !== event.auditId) {
        return unavailablePanelState(current, validPanelAuditId(event.auditId) ? event.auditId : current.auditId,
          'O resultado local não pôde ser exibido com segurança.');
      }
      const occurrenceIds = resultOccurrenceIds(event.result);
      if (!occurrenceIds) {
        return unavailablePanelState(current, event.auditId,
          'O resultado local não pôde ser exibido com segurança.');
      }
      const selected = occurrenceIds.includes(current.selectedOccurrenceId)
        ? current.selectedOccurrenceId
        : (occurrenceIds[0] ?? null);
      return nextPanelState(current, {
        screen: 'result', auditId: event.auditId, selectedOccurrenceId: selected,
        evidenceExpanded: false, focusId: 'result-summary',
        highlight: uncheckedHighlight(),
        reason: null,
      });
    }
    case 'AUDIT_UNAVAILABLE': {
      const auditId = validPanelAuditId(event.auditId) ? event.auditId : current.auditId;
      const reason = PANEL_UNAVAILABLE_REASONS.has(event.reason)
        ? event.reason
        : 'Não foi possível concluir a operação local.';
      return unavailablePanelState(current, auditId, reason);
    }
    case 'FILTER_SET': {
      if (current.screen !== 'result' || !PANEL_FILTERS.includes(event.filter)) return current;
      const values = panelFilterValues(event.values);
      if (!values) return current;
      return nextPanelState(current, {
        filters: { ...current.filters, [event.filter]: values },
        focusId: panelFocusId(event.focusId, current.focusId),
        scrollTop: panelScrollTop(event.scrollTop, current.scrollTop),
      });
    }
    case 'OCCURRENCE_SELECTED':
      if (current.screen !== 'result' || !validPanelOccurrenceId(event.occurrenceId)) return current;
      return nextPanelState(current, {
        selectedOccurrenceId: event.occurrenceId,
        evidenceExpanded: false,
        highlight: { ...current.highlight, bindingStatus: { state: 'unchecked' }, message: null },
        focusId: panelFocusId(event.focusId, `occurrence-${event.occurrenceId}`),
        scrollTop: panelScrollTop(event.scrollTop, current.scrollTop),
      });
    case 'EVIDENCE_TOGGLED':
      if (current.screen !== 'result' || typeof event.expanded !== 'boolean') return current;
      return nextPanelState(current, {
        evidenceExpanded: event.expanded,
        focusId: panelFocusId(event.focusId, 'evidence-summary'),
        scrollTop: panelScrollTop(event.scrollTop, current.scrollTop),
      });
    case 'PERSONA_SELECTED':
      if (!PERSONA_MODES.has(event.mode)) return current;
      return nextPanelState(current, {
        persona: {
          mode: event.mode, readerPaused: false,
          speechAvailability: 'unavailable', voiceId: '', rate: 1,
          message: event.mode === 'reader'
            ? 'Leitura simulada ativa. Use os controles para navegar pela legenda.'
            : event.mode === 'achromatopsia'
              ? 'Simulação de acromatopsia ativa nesta página.'
              : 'Simulação de navegação somente por teclado ativa nesta página.',
        },
      });
    case 'PERSONA_READER_PAUSED':
      return current.persona.mode === 'reader' ? nextPanelState(current, {
        persona: { ...current.persona, readerPaused: true, message: 'Leitura simulada pausada.' },
      }) : current;
    case 'PERSONA_READER_RESUMED':
      return current.persona.mode === 'reader' ? nextPanelState(current, {
        persona: { ...current.persona, readerPaused: false, message: 'Leitura simulada ativa.' },
      }) : current;
    case 'PERSONA_READER_STATE': {
      if (current.persona.mode !== 'reader' || !['idle', 'playing', 'paused'].includes(event.playback) ||
        !Number.isSafeInteger(event.index) || !Number.isSafeInteger(event.total) ||
        typeof event.caption !== 'string' || /[\u0000-\u001F\u007F]/u.test(event.caption) ||
        Array.from(event.caption).length > 2048 || event.caption !== event.caption.replace(/\s+/gu, ' ').trim() ||
        !READER_SPEECH_AVAILABILITY.has(event.speechAvailability) ||
        typeof event.voiceId !== 'string' || /[\u0000-\u001F\u007F]/u.test(event.voiceId) ||
        event.voiceId !== event.voiceId.replace(/\s+/gu, ' ').trim() || Array.from(event.voiceId).length > 200 ||
        typeof event.rate !== 'number' || !Number.isFinite(event.rate) || event.rate < 0.5 || event.rate > 2) {
        return current;
      }
      const speechMessage = readerSpeechMessage(event.speechAvailability, event.voiceId);
      if (event.playback === 'idle') {
        if (event.index !== -1 || event.total !== 0 || event.caption !== '') return current;
        return nextPanelState(current, {
          persona: {
            mode: 'reader', readerPaused: false,
            speechAvailability: event.speechAvailability, voiceId: event.voiceId, rate: event.rate,
            message: `Leitura simulada pronta. Use Próximo para começar. ${speechMessage}`,
          },
        });
      }
      if (event.total < 1 || event.total > 2000 || event.index < 0 || event.index >= event.total || event.caption === '') {
        return current;
      }
      return nextPanelState(current, {
        persona: {
          mode: 'reader', readerPaused: event.playback === 'paused',
          speechAvailability: event.speechAvailability, voiceId: event.voiceId, rate: event.rate,
          message: `Leitura ${event.index + 1} de ${event.total}: ${event.caption}. ${speechMessage}`,
        },
      });
    }
    case 'PERSONA_READER_VOICE_UNAVAILABLE':
      return current.persona.mode === 'reader' ? nextPanelState(current, {
        persona: {
          ...current.persona, speechAvailability: 'unavailable', voiceId: '',
          message: 'A legenda continua disponível, mas nenhuma voz local foi encontrada neste navegador.',
        },
      }) : current;
    case 'PERSONA_FAILED':
      return nextPanelState(current, {
        persona: { ...current.persona, message: 'Não foi possível aplicar a simulação nesta página.' },
      });
    case 'PERSONA_ENDED':
      return nextPanelState(current, { persona: neutralPersona('Simulação encerrada.') });
    case 'PERSONA_SYNCHRONIZED_NONE':
      return nextPanelState(current, { persona: neutralPersona() });
    case 'HIGHLIGHT_BUSY':
      return validPanelOccurrenceId(event.occurrenceId) ? nextPanelState(current, {
        highlight: {
          ...current.highlight, state: 'busy', operation: 'highlight',
          occurrenceId: event.occurrenceId, message: 'Destacando na página atual.',
        },
        focusId: panelFocusId(event.focusId, current.focusId),
        scrollTop: panelScrollTop(event.scrollTop, current.scrollTop),
      }) : current;
    case 'HIGHLIGHT_CLEAR_BUSY':
      return current.highlight.state === 'active' ? nextPanelState(current, {
        highlight: { ...current.highlight, state: 'busy', operation: 'clear', message: 'Removendo o destaque da página atual.' },
        focusId: panelFocusId(event.focusId, current.focusId),
        scrollTop: panelScrollTop(event.scrollTop, current.scrollTop),
      }) : current;
    case 'HIGHLIGHT_ACTIVE':
      return validPanelOccurrenceId(event.occurrenceId) ? nextPanelState(current, {
        highlight: {
          state: 'active', operation: null, occurrenceId: event.occurrenceId,
          bindingStatus: current.selectedOccurrenceId === event.occurrenceId
            ? { state: 'available' } : current.highlight.bindingStatus,
          message: 'Destaque visível na página atual.',
        },
        focusId: panelFocusId(event.focusId, current.focusId),
        scrollTop: panelScrollTop(event.scrollTop, current.scrollTop),
      }) : current;
    case 'HIGHLIGHT_CLEARED':
      return nextPanelState(current, {
        highlight: {
          ...current.highlight, state: 'idle', operation: null, occurrenceId: null,
          bindingStatus: { state: 'unchecked' }, message: 'Destaque removido.',
        },
        focusId: panelFocusId(event.focusId, current.focusId),
        scrollTop: panelScrollTop(event.scrollTop, current.scrollTop),
      });
    case 'HIGHLIGHT_CLEAR_FAILED':
      return validPanelOccurrenceId(event.occurrenceId) ? nextPanelState(current, {
        highlight: {
          ...current.highlight, state: 'active', operation: null, occurrenceId: event.occurrenceId,
          message: 'Não foi possível confirmar a remoção do destaque. Tente novamente.',
        },
        focusId: panelFocusId(event.focusId, current.focusId),
        scrollTop: panelScrollTop(event.scrollTop, current.scrollTop),
      }) : current;
    case 'HIGHLIGHT_AVAILABILITY_CHECKING':
      return current.screen === 'result' && event.occurrenceId === current.selectedOccurrenceId
        ? nextPanelState(current, {
          highlight: { ...current.highlight, bindingStatus: { state: 'checking' }, message: 'Verificando se o item pode ser destacado.' },
        }) : current;
    case 'HIGHLIGHT_AVAILABLE':
      return current.screen === 'result' && event.occurrenceId === current.selectedOccurrenceId
        ? nextPanelState(current, {
          highlight: { ...current.highlight, bindingStatus: { state: 'available' }, message: 'Este item pode ser destacado na página.' },
        }) : current;
    case 'HIGHLIGHT_UNAVAILABLE':
      if (event.occurrenceId && event.occurrenceId !== current.selectedOccurrenceId) return current;
      return nextPanelState(current, {
        highlight: {
          state: current.highlight.state === 'busy' ? 'idle' : current.highlight.state,
          operation: null,
          occurrenceId: current.highlight.state === 'busy' ? null : current.highlight.occurrenceId,
          bindingStatus: {
            state: 'unavailable',
            reason: HIGHLIGHT_BINDING_REASONS.has(event.reason) ? event.reason : 'live-proof-failed',
          },
          message: 'Não foi possível destacar este item na página. Consulte as evidências coletadas.',
        },
        focusId: panelFocusId(event.focusId, current.focusId),
        scrollTop: panelScrollTop(event.scrollTop, current.scrollTop),
      });
    case 'RETRY_REQUESTED':
      if (current.screen !== 'unavailable') return current;
      return nextPanelState(current, { focusId: 'retry' });
    case 'PORT_INTERRUPTED':
      return unavailablePanelState(current, current.auditId, PANEL_UNPREPARED_MESSAGE);
    default:
      return current;
  }
}

function panelState(value) {
  return Boolean(value) && value.version === 1 &&
    ['initial', 'running', 'result', 'unavailable'].includes(value.screen) &&
    value.filters && PANEL_FILTERS.every(filter => Array.isArray(value.filters[filter]));
}

function immutablePanelState(value) {
  if (Object.isFrozen(value) && Object.isFrozen(value.filters) &&
    PANEL_FILTERS.every(filter => Object.isFrozen(value.filters[filter]))) return value;
  return deepFreezePanelState({
    version: value.version,
    screen: value.screen,
    auditId: value.auditId,
    filters: Object.fromEntries(PANEL_FILTERS.map(filter => [filter, [...value.filters[filter]]])),
    selectedOccurrenceId: value.selectedOccurrenceId,
    evidenceExpanded: value.evidenceExpanded,
    persona: copyPersona(value.persona),
    highlight: copyHighlight(value.highlight),
    focusId: value.focusId,
    scrollTop: value.scrollTop,
    reason: value.reason,
  });
}

function copyPersona(value) {
  const valid = value && (PERSONA_MODES.has(value.mode) || value.mode === null);
  return valid
    ? {
        mode: value.mode,
        readerPaused: value.readerPaused === true,
        speechAvailability: READER_SPEECH_AVAILABILITY.has(value.speechAvailability)
          ? value.speechAvailability : 'unavailable',
        voiceId: typeof value.voiceId === 'string' && !/[\u0000-\u001F\u007F]/u.test(value.voiceId) &&
          Array.from(value.voiceId).length <= 200 ? value.voiceId : '',
        rate: typeof value.rate === 'number' && Number.isFinite(value.rate) && value.rate >= 0.5 && value.rate <= 2
          ? value.rate : 1,
        message: typeof value.message === 'string' ? value.message : '',
      }
    : neutralPersona();
}

function readerSpeechMessage(availability, voiceId) {
  if (availability === 'available' && voiceId) return 'Voz local ativa.';
  if (availability === 'busy' && voiceId) return 'A voz local aguarda o áudio atual do navegador.';
  if (availability === 'error') return 'A legenda está ativa; a voz local encontrou uma falha e pode ser ativada novamente.';
  return 'A legenda está ativa; ative uma voz local para ouvir.';
}

function copyHighlight(value) {
  const binding = value?.bindingStatus;
  const bindingStatus = binding?.state === 'available' || binding?.state === 'checking' || binding?.state === 'unchecked'
    ? { state: binding.state }
    : binding?.state === 'unavailable' && HIGHLIGHT_BINDING_REASONS.has(binding.reason)
      ? { state: 'unavailable', reason: binding.reason }
      : { state: 'unchecked' };
  const operation = value?.state === 'busy' && ['highlight', 'clear'].includes(value.operation)
    ? value.operation : value?.state === 'busy' ? undefined : null;
  return value && ['idle', 'busy', 'active'].includes(value.state) && operation !== undefined &&
    (value.occurrenceId === null || validPanelOccurrenceId(value.occurrenceId))
    ? {
      state: value.state, operation, occurrenceId: value.occurrenceId,
      bindingStatus, message: typeof value.message === 'string' ? value.message : null,
    }
    : uncheckedHighlight();
}

function nextPanelState(current, patch) {
  return deepFreezePanelState({ ...current, ...patch });
}

function unavailablePanelState(current, auditId, reason) {
  return nextPanelState(current, {
    screen: 'unavailable',
    auditId: validPanelAuditId(auditId) ? auditId : null,
    filters: { impact: [], wcag: [], abnt: [] },
    selectedOccurrenceId: null,
    evidenceExpanded: false,
    highlight: uncheckedHighlight(),
    focusId: 'retry',
    scrollTop: 0,
    reason,
  });
}

function resultOccurrenceIds(result) {
  try {
    if (!result || result.summary?.auditId !== result.auditId || !Array.isArray(result.details)) return null;
    const groups = result.summary?.groups;
    if (!groups || !['failed', 'alerts', 'humanReview', 'passed'].every(name => Array.isArray(groups[name]))) return null;
    const occurrenceIds = [];
    for (const name of ['failed', 'alerts', 'humanReview', 'passed']) {
      for (const card of groups[name]) {
        if (!Array.isArray(card.occurrenceIds)) return null;
        for (const occurrenceId of card.occurrenceIds) {
          if (!validPanelOccurrenceId(occurrenceId) || occurrenceIds.includes(occurrenceId)) return null;
          occurrenceIds.push(occurrenceId);
        }
      }
    }
    if (result.details.length !== occurrenceIds.length) return null;
    const detailIds = result.details.map(detail => detail?.occurrenceId);
    if (detailIds.some(id => !validPanelOccurrenceId(id)) || new Set(detailIds).size !== detailIds.length) return null;
    if (occurrenceIds.some(id => detailIds.filter(detailId => detailId === id).length !== 1)) return null;
    return occurrenceIds;
  } catch { return null; }
}

function panelFilterValues(values) {
  if (!Array.isArray(values) || values.length > 100) return null;
  const copy = [];
  for (const value of values) {
    if (typeof value !== 'string' || value.length < 1 || value.length > 200 || copy.includes(value)) return null;
    copy.push(value);
  }
  return copy;
}

function validPanelAuditId(value) { return typeof value === 'string' && PANEL_AUDIT_ID.test(value); }
function validPanelOccurrenceId(value) { return typeof value === 'string' && value.length >= 1 && value.length <= 200; }
function panelFocusId(value, fallback) {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,240}$/u.test(value) ? value : fallback;
}
function panelScrollTop(value, fallback) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function deepFreezePanelState(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreezePanelState(child, seen);
  return Object.freeze(value);
}
