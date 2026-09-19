import { PANEL_UNPREPARED_MESSAGE } from './panel-status.js';

const PANEL_AUDIT_ID = /^[A-Za-z0-9._:-]{1,160}$/u;
const PANEL_FILTERS = Object.freeze(['impact', 'wcag', 'abnt', 'result']);
const RESULT_FILTERS = Object.freeze(['failed', 'alerts', 'humanReview', 'passed']);
const CAPTURE_MODES = Object.freeze(['full-evidence', 'element-only', 'no-pixels']);
const PIXEL_CAPTURE_MODES = Object.freeze(['full-evidence', 'element-only']);
const PRIVACY_CATEGORIES = Object.freeze(['password', 'otp', 'payment', 'private-marker']);
const PRIVACY_MESSAGE = 'A página contém conteúdo potencialmente sensível. Confirme para capturar imagens visíveis.';
const DUPLICATE_URL_MESSAGE = 'A URL repete uma entrada anterior e não será auditada novamente.';
const SINGLE_ENTRY_ERRORS = Object.freeze(['required', 'invalid', 'too-long', 'start-failed']);
const BATCH_ENTRY_ERRORS = Object.freeze(['required', 'too-few', 'too-many', 'invalid-lines', 'start-failed']);
const BATCH_LINE_ERRORS = Object.freeze(['invalid', 'too-long']);
const MAX_BATCH_LINE_NUMBER = 65_536;
const PANEL_STATE_KEYS = Object.freeze([
  'version', 'screen', 'auditId', 'entryMode', 'entryError', 'auditSource', 'captureMode', 'sessionStatus', 'privacy',
  'progress', 'batch', 'filters', 'selectedOccurrenceId', 'evidenceExpanded', 'persona', 'highlight',
  'focusId', 'scrollTop', 'reason',
]);
const PERSONA_MODES = new Set(['reader', 'achromatopsia', 'keyboard']);
const PANEL_ABORTED_MESSAGE = 'A auditoria foi encerrada antes de concluir. Refaça a auditoria e, se '
  + 'o modo de imagem falhar de novo, use o modo sem pixels.';
const PANEL_UNAVAILABLE_REASONS = new Set([
  PANEL_UNPREPARED_MESSAGE,
  'O resultado local não pôde ser exibido com segurança.',
  'Não foi possível concluir a operação local.',
  // A auditoria foi encerrada sem chegar ao resultado, e o usuário NÃO pediu para parar (a revisão final da
  // 1.1.45 mediu: no modo de imagem, sem sinal sensível na página, a sessão é revogada e o painel voltava ao
  // início EM SILÊNCIO). A mensagem é o que a revisão exige: nunca o retorno silencioso ao neutro.
  PANEL_ABORTED_MESSAGE,
]);
const HIGHLIGHT_BINDING_REASONS = new Set(['no-binding', 'expired', 'live-proof-failed']);
const READER_SPEECH_AVAILABILITY = new Set(['available', 'unavailable', 'busy', 'error']);
const PERSONA_KEYS = Object.freeze([
  'mode', 'readerPaused', 'readerCaption', 'readerPosition', 'speechAvailability', 'voiceId', 'rate', 'message',
]);

function neutralPersona(message = 'Escolha uma simulação para esta página.') {
  return {
    mode: null, readerPaused: false, readerCaption: '', readerPosition: '',
    speechAvailability: 'unavailable', voiceId: '', rate: 1, message,
  };
}

function uncheckedHighlight() {
  return { state: 'idle', operation: null, occurrenceId: null, bindingStatus: { state: 'unchecked' }, message: null };
}

function neutralPrivacy() {
  return { mode: null, categories: [], message: null, confirmationPending: false };
}

function neutralProgress() {
  return { phase: null, message: null, percent: null, at: null };
}

function neutralBatch() {
  return { total: null, pageNumber: null, warnings: [], errors: [] };
}

const AUDIT_PROGRESS = Object.freeze([
  ['opening', 'Abrindo o site', 5],
  ['collecting', 'Lendo a estrutura', 25],
  ['testing', 'Verificando acessibilidade', 50],
  ['evidence', 'Preparando evidências', 72],
  ['reporting', 'Gerando relatório', 92],
]);

export function createInitialPanelState() {
  return deepFreezePanelState({
    version: 1,
    screen: 'initial',
    auditId: null,
    entryMode: 'sources',
    entryError: null,
    auditSource: null,
    captureMode: 'full-evidence',
    sessionStatus: null,
    privacy: neutralPrivacy(),
    progress: neutralProgress(),
    batch: neutralBatch(),
    filters: { impact: [], wcag: [], abnt: [], result: [] },
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
  const eventType = dataProperty(event, 'type');
  if (typeof eventType !== 'string') return current;
  switch (eventType) {
    case 'BOOTSTRAP_INITIAL':
      return createInitialPanelState();
    case 'CAPTURE_MODE_SELECTED': {
      const selected = exactDataRecord(event, ['type', 'mode', 'focusId']);
      if (!selected || current.screen !== 'initial' || !CAPTURE_MODES.includes(selected.mode)) return current;
      return nextPanelState(current, {
        captureMode: selected.mode,
        focusId: panelFocusId(selected.focusId, `capture-mode-${selected.mode}`),
      });
    }
    case 'URL_FORM_OPENED':
      if (!exactDataRecord(event, ['type']) || current.screen !== 'initial') return current;
      return nextPanelState(current, { entryMode: 'single-url', entryError: null, batch: neutralBatch(), focusId: 'audit-url' });
    case 'URL_FORM_CLOSED':
      if (!exactDataRecord(event, ['type']) || current.screen !== 'initial') return current;
      return nextPanelState(current, { entryMode: 'sources', entryError: null, batch: neutralBatch(), focusId: 'open-url-form' });
    case 'BATCH_FORM_OPENED':
      if (!exactDataRecord(event, ['type']) || current.screen !== 'initial') return current;
      return nextPanelState(current, {
        entryMode: 'batch', entryError: null, captureMode: 'no-pixels', batch: neutralBatch(), focusId: 'audit-urls',
      });
    case 'BATCH_FORM_CLOSED':
      if (!exactDataRecord(event, ['type']) || current.screen !== 'initial' || current.entryMode !== 'batch') return current;
      return nextPanelState(current, { entryMode: 'sources', entryError: null, batch: neutralBatch(), focusId: 'open-batch-form' });
    case 'URL_ENTRY_REJECTED': {
      const rejected = exactDataRecord(event, ['type', 'code']);
      if (!rejected || !['required', 'invalid', 'too-long', 'start-failed'].includes(rejected.code)) return current;
      if (rejected.code === 'start-failed' && current.screen === 'running' &&
        current.auditSource === 'single-url' && current.auditId === null) {
        return nextPanelState(current, {
          screen: 'initial', entryMode: 'single-url', entryError: 'start-failed', auditSource: null,
          sessionStatus: null, privacy: neutralPrivacy(), progress: neutralProgress(), focusId: 'audit-url', reason: null,
        });
      }
      if (current.screen !== 'initial' || current.entryMode !== 'single-url') return current;
      return nextPanelState(current, { entryError: rejected.code, focusId: 'audit-url' });
    }
    case 'BATCH_ENTRY_REJECTED': {
      const rejected = exactDataRecord(event, ['type', 'code', 'lines']);
      const errors = rejected ? copyBatchErrors(rejected.lines) : null;
      if (!rejected || !BATCH_ENTRY_ERRORS.includes(rejected.code) || !errors ||
        (rejected.code === 'invalid-lines') !== (errors.length > 0)) return current;
      if (rejected.code === 'start-failed' && current.screen === 'running' &&
        current.auditSource === 'batch' && current.auditId === null) {
        return nextPanelState(current, {
          screen: 'initial', entryMode: 'batch', entryError: 'start-failed', auditSource: null,
          sessionStatus: null, privacy: neutralPrivacy(), progress: neutralProgress(),
          batch: { ...neutralBatch(), errors }, focusId: 'audit-urls', reason: null,
        });
      }
      if (current.screen !== 'initial' || current.entryMode !== 'batch') return current;
      return nextPanelState(current, {
        entryError: rejected.code, batch: { ...neutralBatch(), errors }, focusId: 'audit-urls',
      });
    }
    case 'START_REQUESTED': {
      const requested = exactDataRecord(event, ['type', 'source']);
      if (!requested || !['attached', 'single-url', 'batch'].includes(requested.source) || current.screen !== 'initial' ||
        requested.source === 'single-url' && current.entryMode !== 'single-url' ||
        requested.source === 'batch' && current.entryMode !== 'batch') return current;
      return nextPanelState(current, {
        screen: 'running', auditId: null, selectedOccurrenceId: null,
        auditSource: requested.source, entryError: null,
        sessionStatus: null, privacy: neutralPrivacy(),
        progress: neutralProgress(),
        batch: neutralBatch(),
        evidenceExpanded: false, focusId: 'cancel-audit', scrollTop: 0, reason: null,
      });
    }
    case 'BATCH_STARTED': {
      const started = exactDataRecord(event, ['type', 'auditId', 'total', 'warnings']);
      const warnings = started ? copyBatchWarnings(started.warnings) : null;
      if (!started || current.screen !== 'running' || current.auditSource !== 'batch' ||
        current.auditId !== null && current.auditId !== started.auditId ||
        !validPanelAuditId(started.auditId) || !validBatchTotal(started.total) || !warnings ||
        current.batch.total !== null && current.batch.total !== started.total) return current;
      return nextPanelState(current, {
        auditId: started.auditId,
        batch: {
          total: started.total,
          pageNumber: current.batch.total === started.total ? current.batch.pageNumber : 0,
          warnings, errors: [],
        },
      });
    }
    case 'BATCH_PREPARED': {
      const prepared = exactDataRecord(event, ['type', 'total']);
      if (!prepared || current.screen !== 'running' || current.auditSource !== 'batch' || current.auditId !== null ||
        !validBatchTotal(prepared.total) || current.batch.total !== null) return current;
      return nextPanelState(current, {
        batch: { total: prepared.total, pageNumber: 0, warnings: [], errors: [] },
      });
    }
    case 'AUDIT_RUNNING': {
      const ordinary = exactDataRecord(event, ['type', 'auditId']);
      const authoritative = ordinary ? null : exactDataRecord(event, ['type', 'auditId', 'captureMode']);
      const running = ordinary ?? authoritative;
      if (!running || !validPanelAuditId(running.auditId) || authoritative && !CAPTURE_MODES.includes(authoritative.captureMode)) {
        return current;
      }
      return nextPanelState(current, {
        screen: 'running', auditId: running.auditId, selectedOccurrenceId: null,
        auditSource: current.auditSource ?? 'attached',
        captureMode: authoritative?.captureMode ?? current.captureMode,
        sessionStatus: null, privacy: neutralPrivacy(),
        progress: current.auditId === running.auditId ? current.progress : neutralProgress(),
        evidenceExpanded: false, focusId: 'cancel-audit', reason: null,
      });
    }
    case 'PRIVACY_PAUSED': {
      const ordinary = exactDataRecord(event, ['type', 'auditId', 'mode', 'categories', 'message']);
      const batchPaused = ordinary ? null : exactDataRecord(event, [
        'type', 'auditId', 'mode', 'categories', 'message', 'pageNumber',
      ]);
      const paused = ordinary ?? batchPaused;
      const categories = paused ? copyPrivacyCategories(paused.categories) : null;
      if (!paused || current.screen !== 'running' || !validPanelAuditId(paused.auditId) ||
        (current.auditId !== null && current.auditId !== paused.auditId) ||
        !PIXEL_CAPTURE_MODES.includes(paused.mode) || paused.message !== PRIVACY_MESSAGE || !categories ||
        batchPaused && (!Number.isSafeInteger(batchPaused.pageNumber) || batchPaused.pageNumber < 1 ||
          batchPaused.pageNumber > 20 || current.batch.total !== null && batchPaused.pageNumber > current.batch.total) ||
        !batchPaused && current.auditSource === 'batch') return current;
      return nextPanelState(current, {
        auditId: paused.auditId,
        auditSource: batchPaused ? 'batch' : current.auditSource,
        captureMode: paused.mode,
        sessionStatus: 'privacy-paused',
        privacy: { mode: paused.mode, categories, message: PRIVACY_MESSAGE, confirmationPending: false },
        progress: batchPaused && batchPaused.pageNumber !== current.batch.pageNumber
          ? neutralProgress() : current.progress,
        batch: batchPaused ? {
          total: current.batch.total, pageNumber: batchPaused.pageNumber,
          warnings: current.auditSource === 'batch' ? current.batch.warnings : [], errors: [],
        } : current.batch,
        focusId: 'confirm-pixel-capture',
      });
    }
    case 'AUDIT_PROGRESS': {
      const progress = canonicalProgress(event);
      if (!progress || current.screen !== 'running' || current.sessionStatus !== null ||
        current.auditId !== progress.auditId || current.progress.percent !== null &&
          (progress.percent <= current.progress.percent || progress.at < current.progress.at)) return current;
      const infersBatch = progress.pageNumber !== null && current.auditSource === 'attached' &&
        current.batch.total === null && current.batch.pageNumber === null && current.progress.percent === null;
      if (progress.pageNumber !== null && (!infersBatch && current.auditSource !== 'batch' ||
        current.batch.total !== null && current.batch.total !== progress.total ||
        current.batch.pageNumber !== null && current.batch.pageNumber > progress.pageNumber)) return current;
      if (progress.pageNumber === null && current.auditSource === 'batch') return current;
      return nextPanelState(current, {
        progress: { phase: progress.phase, message: progress.message, percent: progress.percent, at: progress.at },
        batch: progress.pageNumber === null ? current.batch : {
          total: progress.total, pageNumber: progress.pageNumber,
          warnings: current.auditSource === 'batch' ? current.batch.warnings : [], errors: [],
        },
        auditSource: infersBatch ? 'batch' : current.auditSource,
        captureMode: current.captureMode,
      });
    }
    case 'PRIVACY_CONFIRM_REQUESTED':
      if (!exactDataRecord(event, ['type']) || current.screen !== 'running' ||
        current.sessionStatus !== 'privacy-paused' || current.privacy.confirmationPending) return current;
      return nextPanelState(current, {
        privacy: { ...current.privacy, confirmationPending: true },
        focusId: 'confirm-pixel-capture',
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
        sessionStatus: null, privacy: neutralPrivacy(),
        progress: neutralProgress(),
        batch: neutralBatch(),
        evidenceExpanded: false, focusId: 'result-summary',
        highlight: uncheckedHighlight(),
        reason: null,
      });
    }
    case 'AUDIT_DELETED':
      if (!exactDataRecord(event, ['type'])) return current;
      return nextPanelState(current, {
        screen: 'initial', auditId: null, sessionStatus: null, privacy: neutralPrivacy(),
        entryMode: 'sources', entryError: null, auditSource: null,
        progress: neutralProgress(),
        batch: neutralBatch(),
        filters: { impact: [], wcag: [], abnt: [] }, selectedOccurrenceId: null,
        evidenceExpanded: false, highlight: uncheckedHighlight(), focusId: 'start-attached',
        scrollTop: 0, reason: null,
      });
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
      if (!values || event.filter === 'result' && values.some(value => !RESULT_FILTERS.includes(value))) return current;
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
        focusId: `persona-${event.mode}`,
        scrollTop: event.mode === 'reader' ? 0 : current.scrollTop,
        persona: {
          mode: event.mode, readerPaused: false,
          readerCaption: '', readerPosition: '',
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
            readerCaption: '', readerPosition: '',
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
          readerCaption: event.caption, readerPosition: `${event.index + 1} de ${event.total}`,
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
    case 'NEW_AUDIT_REQUESTED':
      // A tela de indisponibilidade também devolve o seletor de modo (N-1 da re-verificação da 1.1.47): sem
      // esse caminho, "Tentar novamente" repetia o MESMO modo e a tela não oferecia como escolher outro.
      if (!exactDataRecord(event, ['type']) || !['result', 'unavailable'].includes(current.screen) ||
        current.highlight.state !== 'idle') return current;
      return deepFreezePanelState({
        ...createInitialPanelState(), captureMode: current.captureMode, persona: current.persona,
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
  const state = exactDataRecord(value, PANEL_STATE_KEYS);
  if (!state || state.version !== 1 || !['initial', 'running', 'result', 'unavailable'].includes(state.screen) ||
    !['sources', 'single-url', 'batch'].includes(state.entryMode) ||
    !validEntryError(state.entryMode, state.entryError) ||
    ![null, 'attached', 'single-url', 'batch'].includes(state.auditSource) ||
    !CAPTURE_MODES.includes(state.captureMode) || ![null, 'privacy-paused'].includes(state.sessionStatus) ||
    !exactProgress(state.progress) || !exactBatch(state.batch) || !exactPersona(state.persona) ||
    state.progress.phase === 'batch-page' && state.auditSource !== 'batch' ||
    state.progress.phase !== null && state.progress.phase !== 'batch-page' && state.auditSource === 'batch' ||
    state.progress.phase === 'batch-page' && (!validBatchProgressMessage(
      state.progress.message, state.batch.pageNumber, state.batch.total,
    ) || state.batch.pageNumber < 1) ||
    state.auditSource !== 'batch' && (state.batch.total !== null || state.batch.pageNumber !== null || state.batch.warnings.length > 0) ||
    !state.filters || !PANEL_FILTERS.every(filter => Array.isArray(state.filters[filter]) ||
      filter === 'result' && state.filters[filter] === undefined)) return false;
  const privacy = exactPrivacy(state.privacy);
  if (!privacy) return false;
  return state.sessionStatus === 'privacy-paused'
    ? state.screen === 'running' && PIXEL_CAPTURE_MODES.includes(state.captureMode) && privacy.mode === state.captureMode
    : privacy.mode === null;
}

function immutablePanelState(value) {
  if (Object.isFrozen(value) && Object.isFrozen(value.filters) &&
    PANEL_FILTERS.every(filter => Object.isFrozen(value.filters[filter])) &&
    Object.isFrozen(value.privacy) && Object.isFrozen(value.privacy.categories) &&
    Object.isFrozen(value.batch) && Object.isFrozen(value.batch.warnings) &&
    Object.isFrozen(value.batch.errors) && value.batch.warnings.every(Object.isFrozen) &&
    value.batch.errors.every(Object.isFrozen) &&
    Object.isFrozen(value.persona) && Object.isFrozen(value.highlight) &&
    Object.isFrozen(value.highlight.bindingStatus)) return value;
  return deepFreezePanelState({
    version: value.version,
    screen: value.screen,
    auditId: value.auditId,
    entryMode: value.entryMode,
    entryError: value.entryError,
    auditSource: value.auditSource,
    captureMode: value.captureMode,
    sessionStatus: value.sessionStatus,
    privacy: copyPrivacy(value.privacy),
    progress: copyProgress(value.progress),
    batch: copyBatch(value.batch),
    filters: Object.fromEntries(PANEL_FILTERS.map(filter => [filter, [...(value.filters[filter] ?? [])]])),
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
        readerCaption: value.readerCaption,
        readerPosition: value.readerPosition,
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

function exactPersona(value) {
  const persona = exactDataRecord(value, PERSONA_KEYS);
  if (!persona || !(PERSONA_MODES.has(persona.mode) || persona.mode === null) ||
    typeof persona.readerPaused !== 'boolean' || typeof persona.readerCaption !== 'string' ||
    /[\u0000-\u001F\u007F]/u.test(persona.readerCaption) || Array.from(persona.readerCaption).length > 2048 ||
    persona.readerCaption !== persona.readerCaption.replace(/\s+/gu, ' ').trim() ||
    typeof persona.readerPosition !== 'string') return null;
  if (persona.readerCaption === '') return persona.readerPosition === '' ? persona : null;
  if (persona.mode !== 'reader') return null;
  const position = /^([1-9][0-9]{0,3}) de ([1-9][0-9]{0,3})$/u.exec(persona.readerPosition);
  return position && Number(position[1]) <= Number(position[2]) && Number(position[2]) <= 2000 ? persona : null;
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
    sessionStatus: null,
    privacy: neutralPrivacy(),
    progress: neutralProgress(),
    batch: neutralBatch(),
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

function copyPrivacyCategories(value) {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
      value.length < 1 || value.length > PRIVACY_CATEGORIES.length) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== value.length + 1 || !keys.includes('length')) return null;
    const categories = [];
    let previous = -1;
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      const rank = PRIVACY_CATEGORIES.indexOf(descriptor.value);
      if (rank <= previous) return null;
      previous = rank;
      categories.push(descriptor.value);
    }
    return categories;
  } catch { return null; }
}

function exactPrivacy(value) {
  const privacy = exactDataRecord(value, ['mode', 'categories', 'message', 'confirmationPending']);
  if (!privacy || typeof privacy.confirmationPending !== 'boolean') return null;
  if (privacy.mode === null) {
    return Array.isArray(privacy.categories) && privacy.categories.length === 0 &&
      privacy.message === null && privacy.confirmationPending === false ? privacy : null;
  }
  return PIXEL_CAPTURE_MODES.includes(privacy.mode) && copyPrivacyCategories(privacy.categories) &&
    privacy.message === PRIVACY_MESSAGE ? privacy : null;
}

function canonicalProgress(value) {
  const regular = exactDataRecord(value, ['type', 'auditId', 'sessionId', 'phase', 'message', 'percent', 'at']);
  if (regular && regular.type === 'AUDIT_PROGRESS' && validPanelAuditId(regular.auditId) &&
    regular.sessionId === regular.auditId && canonicalIsoTime(regular.at) && AUDIT_PROGRESS.some(([phase, message, percent]) =>
      regular.phase === phase && regular.message === message && regular.percent === percent)) {
    return {
      phase: regular.phase, message: regular.message, percent: regular.percent, at: regular.at,
      auditId: regular.auditId, pageNumber: null, total: null,
    };
  }
  const progress = exactDataRecord(value, [
    'type', 'auditId', 'sessionId', 'phase', 'message', 'percent', 'pageNumber', 'total', 'at',
  ]);
  if (!progress || progress.type !== 'AUDIT_PROGRESS' || !validPanelAuditId(progress.auditId) ||
    progress.sessionId !== progress.auditId || progress.phase !== 'batch-page' || !canonicalIsoTime(progress.at) ||
    !validBatchTotal(progress.total) || !Number.isSafeInteger(progress.pageNumber) || progress.pageNumber < 1 ||
    progress.pageNumber > progress.total || typeof progress.percent !== 'number' || !Number.isFinite(progress.percent) ||
    progress.percent < 0 || progress.percent > 100 || !validBatchProgressMessage(progress.message, progress.pageNumber, progress.total)) return null;
  return {
    phase: progress.phase, message: progress.message, percent: progress.percent, at: progress.at,
    auditId: progress.auditId, pageNumber: progress.pageNumber, total: progress.total,
  };
}

function exactProgress(value) {
  const progress = exactDataRecord(value, ['phase', 'message', 'percent', 'at']);
  if (!progress) return null;
  if (progress.phase === null) return progress.message === null && progress.percent === null && progress.at === null ? progress : null;
  if (progress.phase === 'batch-page') {
    return typeof progress.message === 'string' &&
      /^Página [1-9][0-9]* de [1-9][0-9]*: (?:auditoria em andamento|processamento encerrado)\.$/u.test(progress.message) &&
      typeof progress.percent === 'number' && Number.isFinite(progress.percent) && progress.percent >= 0 && progress.percent <= 100 &&
      canonicalIsoTime(progress.at) ? progress : null;
  }
  return AUDIT_PROGRESS.some(([phase, message, percent]) =>
    progress.phase === phase && progress.message === message && progress.percent === percent) && canonicalIsoTime(progress.at)
    ? progress : null;
}

function copyProgress(value) {
  const progress = exactProgress(value);
  return progress ? { phase: progress.phase, message: progress.message, percent: progress.percent, at: progress.at } : neutralProgress();
}

function validEntryError(entryMode, entryError) {
  if (entryError === null) return true;
  if (entryMode === 'single-url') return SINGLE_ENTRY_ERRORS.includes(entryError);
  if (entryMode === 'batch') return BATCH_ENTRY_ERRORS.includes(entryError);
  return false;
}

function validBatchTotal(value) {
  return Number.isSafeInteger(value) && value >= 2 && value <= 20;
}

function validBatchProgressMessage(value, pageNumber, total) {
  return value === `Página ${pageNumber} de ${total}: auditoria em andamento.` ||
    value === `Página ${pageNumber} de ${total}: processamento encerrado.`;
}

function copyBatchWarnings(value) {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > 20) return null;
    const own = Reflect.ownKeys(value);
    if (own.length !== value.length + 1 || !own.includes('length')) return null;
    const warnings = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      const warning = exactDataRecord(descriptor.value, ['line', 'code', 'firstLine', 'message']);
      if (!warning || !Number.isSafeInteger(warning.line) || warning.line < 1 || warning.line > MAX_BATCH_LINE_NUMBER ||
        warning.code !== 'DUPLICATE_URL' || warning.message !== DUPLICATE_URL_MESSAGE ||
        warning.firstLine !== null && (!Number.isSafeInteger(warning.firstLine) || warning.firstLine < 1 ||
          warning.firstLine > MAX_BATCH_LINE_NUMBER || warning.firstLine >= warning.line)) return null;
      warnings.push({ ...warning });
    }
    return warnings;
  } catch { return null; }
}

function copyBatchErrors(value) {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > 20) return null;
    const own = Reflect.ownKeys(value);
    if (own.length !== value.length + 1 || !own.includes('length')) return null;
    const errors = [];
    let priorLine = 0;
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      const issue = exactDataRecord(descriptor.value, ['line', 'code']);
      if (!issue || !Number.isSafeInteger(issue.line) || issue.line <= priorLine || issue.line > MAX_BATCH_LINE_NUMBER ||
        !BATCH_LINE_ERRORS.includes(issue.code)) return null;
      priorLine = issue.line;
      errors.push({ ...issue });
    }
    return errors;
  } catch { return null; }
}

function exactBatch(value) {
  const batch = exactDataRecord(value, ['total', 'pageNumber', 'warnings', 'errors']);
  if (!batch) return null;
  const warnings = copyBatchWarnings(batch.warnings);
  const errors = copyBatchErrors(batch.errors);
  if (!warnings || !errors) return null;
  if (batch.total === null) {
    if (warnings.length > 0) return null;
    if (batch.pageNumber === null) return batch;
    return errors.length === 0 && Number.isSafeInteger(batch.pageNumber) &&
      batch.pageNumber >= 1 && batch.pageNumber <= 20 ? batch : null;
  }
  if (batch.pageNumber === null) return null;
  return validBatchTotal(batch.total) && Number.isSafeInteger(batch.pageNumber) && batch.pageNumber >= 0 &&
    batch.pageNumber <= batch.total && errors.length === 0 ? batch : null;
}

function copyBatch(value) {
  const batch = exactBatch(value);
  return batch ? {
    total: batch.total, pageNumber: batch.pageNumber,
    warnings: copyBatchWarnings(batch.warnings), errors: copyBatchErrors(batch.errors),
  } : neutralBatch();
}

function copyPrivacy(value) {
  const privacy = exactPrivacy(value);
  return privacy
    ? { mode: privacy.mode, categories: [...privacy.categories], message: privacy.message, confirmationPending: privacy.confirmationPending }
    : neutralPrivacy();
}

function dataProperty(value, key) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  } catch { return undefined; }
}

function exactDataRecord(value, keys) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return null;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== keys.length || ownKeys.some(key => typeof key !== 'string' || !keys.includes(key))) return null;
    const copy = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      copy[key] = descriptor.value;
    }
    return copy;
  } catch { return null; }
}

function validPanelAuditId(value) { return typeof value === 'string' && PANEL_AUDIT_ID.test(value); }
function canonicalIsoTime(value) {
  if (typeof value !== 'string') return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}
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
