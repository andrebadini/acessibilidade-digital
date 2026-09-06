import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createInitialPanelState,
  reducePanelState,
} from '../../src/panel/panel-state.js';
import * as panelStateModule from '../../src/panel/panel-state.js';

function frozen(value) {
  for (const child of Object.values(value ?? {})) {
    if (child && typeof child === 'object' && !Object.isFrozen(child)) frozen(child);
  }
  return Object.freeze(value);
}

function resultBundle(overrides = {}) {
  const card = {
    checkKey: '["page-1","audita-core","focus-visible"]',
    pageId: 'page-1', engine: 'audita-core', ruleId: 'focus-visible',
    originalOutcome: 'failed', displayOutcome: 'failed', title: 'Indicador de foco visível',
    impact: 'critical', wcag: ['2.4.7'], abntItemIds: ['5.1.1'], occurrenceIds: ['occ-1'],
    classification: 'failed', context: 'top-document', accessibleName: 'Continuar',
    announcement: 'Continuar, botão', evidence: { evidenceIds: ['ev-1'], highlightAvailable: false },
  };
  const detail = {
    version: 1, auditId: 'audit-1', occurrenceId: 'occ-1', checkKey: card.checkKey,
    heading: { title: card.title, classification: 'failed', impact: 'critical', context: 'top-document' },
    affected: { audience: 'Pessoas que navegam por teclado.', reason: 'O foco pode ficar invisível.' },
    observed: 'O indicador de foco não ficou visível.', correction: 'Exiba um indicador de foco contrastante.',
    targets: [{ nodeId: 'n-1', position: 1, total: 1 }],
    accessibility: { name: 'Continuar', nameSource: 'aria-label', announcementPreview: 'Continuar, botão' },
    normative: { wcag: ['2.4.7'], level: ['AA'], abntItem: '5.1.1', classification: 'requirement' },
    legalReference: null, previews: [],
    technical: { selector: '#continue', framePath: [], snippet: '<button>Continuar</button>', styles: [], engine: 'audita-core', ruleId: 'focus-visible', version: '1.0.0', hashes: [] },
    action: { kind: 'consult-evidence', reason: 'Esta verificação não possui um elemento único destacável no estado atual.' },
  };
  const bundle = {
    version: 1, auditId: 'audit-1', modelRevision: 1, modelHash: 'a'.repeat(64),
    summary: {
      version: 1, auditId: 'audit-1',
      identity: { finalUrl: 'https://exemplo.com/', completedAt: '2026-08-26T14:02:00.000Z', status: 'complete' },
      coverage: { status: 'available', numerator: 78, denominator: 100, percent: '78,0%' },
      counts: {
        errors: { checkKeys: 1, occurrences: 1 }, alerts: { checkKeys: 0, occurrences: 0 },
        humanReview: { checkKeys: 0, occurrences: 0 }, positive: { checkKeys: 0, occurrences: 0 },
      },
      distributions: { impact: [{ id: 'critical', count: 1 }], wcag: [{ id: 'AA', count: 1 }], abnt: [{ id: '5.1.1', count: 1 }] },
      limitations: { codes: [], notStartedPageIds: [], inapplicableCheckKeys: [], untestedCheckKeys: [] },
      groups: { failed: [card], alerts: [], humanReview: [], passed: [] },
    },
    details: [detail],
    ...overrides,
  };
  return frozen(bundle);
}

test('result filter is local and a new audit clears the old selection without replaying consent', () => {
  let state = reducePanelState(createInitialPanelState(), { type: 'AUDIT_RESULT', auditId: 'audit-1', result: resultBundle() });
  assert.equal(state.screen, 'result');
  state = reducePanelState(state, { type: 'FILTER_SET', filter: 'result', values: ['humanReview'], focusId: 'metric-humanReview' });
  assert.deepEqual(state.filters.result, ['humanReview']);
  const denied = reducePanelState(state, { type: 'FILTER_SET', filter: 'result', values: ['invented'] });
  assert.deepEqual(denied.filters.result, ['humanReview']);
  const fresh = reducePanelState(state, { type: 'NEW_AUDIT_REQUESTED' });
  assert.equal(fresh.screen, 'initial');
  assert.equal(fresh.auditId, null);
  assert.equal(fresh.privacy.confirmationPending, false);
  assert.deepEqual(fresh.filters.result, []);
});

test('refazer preserves result controls until pending highlight removal succeeds', () => {
  let state = reducePanelState(createInitialPanelState(), { type: 'AUDIT_RESULT', auditId: 'audit-1', result: resultBundle() });
  state = reducePanelState(state, { type: 'HIGHLIGHT_ACTIVE', occurrenceId: 'occ-1' });
  assert.equal(reducePanelState(state, { type: 'NEW_AUDIT_REQUESTED' }).screen, 'result');
  state = reducePanelState(state, { type: 'HIGHLIGHT_CLEAR_BUSY' });
  state = reducePanelState(state, { type: 'NEW_AUDIT_REQUESTED' });
  state = reducePanelState(state, { type: 'NEW_AUDIT_REQUESTED' });
  assert.equal(state.screen, 'result', 'a second activation must not abandon pending cleanup');
  state = reducePanelState(state, { type: 'HIGHLIGHT_CLEAR_FAILED', occurrenceId: 'occ-1' });
  assert.equal(state.screen, 'result');
  assert.equal(state.highlight.state, 'active');
  state = reducePanelState(state, { type: 'HIGHLIGHT_CLEAR_BUSY' });
  state = reducePanelState(state, { type: 'HIGHLIGHT_CLEARED' });
  assert.equal(reducePanelState(state, { type: 'NEW_AUDIT_REQUESTED' }).screen, 'initial');
});

test('exports only the live four-screen panel state contract', () => {
  assert.deepEqual(Object.keys(panelStateModule).sort(), ['createInitialPanelState', 'reducePanelState']);
});

test('creates an immutable initial screen with only stable interaction state', () => {
  const state = createInitialPanelState();
  assert.deepEqual(state, {
    version: 1,
    screen: 'initial',
    auditId: null,
    entryMode: 'sources',
    entryError: null,
    auditSource: null,
    captureMode: 'full-evidence',
    sessionStatus: null,
    privacy: { mode: null, categories: [], message: null, confirmationPending: false },
    progress: { phase: null, message: null, percent: null, at: null },
    batch: { total: null, pageNumber: null, warnings: [], errors: [] },
    filters: { impact: [], wcag: [], abnt: [], result: [] },
    selectedOccurrenceId: null,
    evidenceExpanded: false,
    persona: {
      mode: null, readerPaused: false, speechAvailability: 'unavailable', voiceId: '', rate: 1,
      readerCaption: '', readerPosition: '',
      message: 'Escolha uma simulação para esta página.',
    },
    highlight: { state: 'idle', operation: null, occurrenceId: null, bindingStatus: { state: 'unchecked' }, message: null },
    focusId: 'start-attached',
    scrollTop: 0,
    reason: null,
  });
  assert.equal(Object.isFrozen(state), true);
  assert.equal(Object.isFrozen(state.filters.impact), true);
  assert.equal(Object.hasOwn(state, 'sessionCapabilityId'), false);
});

test('batch entry defaults to no-pixels, admits every explicit mode, and stores only safe diagnostics', () => {
  const initial = createInitialPanelState();
  const opened = reducePanelState(initial, { type: 'BATCH_FORM_OPENED' });
  assert.equal(opened.entryMode, 'batch');
  assert.equal(opened.captureMode, 'no-pixels');
  assert.equal(opened.focusId, 'audit-urls');

  const pixelBatch = reducePanelState(opened, {
    type: 'CAPTURE_MODE_SELECTED', mode: 'full-evidence', focusId: 'capture-mode-full-evidence',
  });
  assert.equal(pixelBatch.captureMode, 'full-evidence');
  assert.equal(pixelBatch.focusId, 'capture-mode-full-evidence');

  const rejected = reducePanelState(opened, {
    type: 'BATCH_ENTRY_REJECTED', code: 'invalid-lines', lines: [
      { line: 2, code: 'invalid' }, { line: 4, code: 'too-long' },
    ],
  });
  assert.equal(rejected.entryError, 'invalid-lines');
  assert.deepEqual(rejected.batch.errors, [
    { line: 2, code: 'invalid' }, { line: 4, code: 'too-long' },
  ]);
  assert.strictEqual(reducePanelState(opened, {
    type: 'BATCH_ENTRY_REJECTED', code: 'invalid-lines',
    lines: [{ line: 2, code: 'invalid', url: 'https://secret.example/?token=raw' }],
  }), opened);

  const requested = reducePanelState(opened, { type: 'START_REQUESTED', source: 'batch' });
  assert.equal(requested.screen, 'running');
  assert.equal(requested.auditSource, 'batch');
  assert.equal(requested.captureMode, 'no-pixels');
  assert.equal(Object.hasOwn(requested, 'urls'), false);
  assert.strictEqual(reducePanelState(opened, {
    type: 'START_REQUESTED', source: 'batch', urls: 'https://secret.example/?token=raw',
  }), opened);

  for (const mode of ['full-evidence', 'element-only', 'no-pixels']) {
    const selected = reducePanelState(opened, {
      type: 'CAPTURE_MODE_SELECTED', mode, focusId: `capture-mode-${mode}`,
    });
    const modeRequested = reducePanelState(selected, { type: 'START_REQUESTED', source: 'batch' });
    assert.equal(modeRequested.screen, 'running', mode);
    assert.equal(modeRequested.auditSource, 'batch', mode);
    assert.equal(modeRequested.captureMode, mode);
    const modePrepared = reducePanelState(modeRequested, { type: 'BATCH_PREPARED', total: 2 });
    assert.deepEqual(modePrepared.batch, { total: 2, pageNumber: 0, warnings: [], errors: [] }, mode);
  }

  const warning = {
    line: 3, code: 'DUPLICATE_URL', firstLine: 1,
    message: 'A URL repete uma entrada anterior e não será auditada novamente.',
  };
  const started = reducePanelState(requested, {
    type: 'BATCH_STARTED', auditId: 'audit-batch-1', total: 2, warnings: [warning],
  });
  assert.equal(started.auditId, 'audit-batch-1');
  assert.deepEqual(started.batch, { total: 2, pageNumber: 0, warnings: [warning], errors: [] });
  assert.doesNotMatch(JSON.stringify(started), /secret\.example|token=raw/iu);

  const progress = reducePanelState(started, {
    type: 'AUDIT_PROGRESS', auditId: 'audit-batch-1', sessionId: 'audit-batch-1',
    phase: 'batch-page', message: 'Página 1 de 2: auditoria em andamento.', percent: 25,
    pageNumber: 1, total: 2, at: '2026-09-01T12:00:00.000Z',
  });
  assert.equal(progress.batch.pageNumber, 1);
  assert.equal(progress.batch.total, 2);
  assert.equal(progress.progress.percent, 25);

  const prepared = reducePanelState(requested, { type: 'BATCH_PREPARED', total: 2 });
  assert.deepEqual(prepared.batch, { total: 2, pageNumber: 0, warnings: [], errors: [] });
  const authoritative = reducePanelState(prepared, { type: 'AUDIT_RUNNING', auditId: 'audit-batch-race' });
  const earlyProgress = reducePanelState(authoritative, {
    type: 'AUDIT_PROGRESS', auditId: 'audit-batch-race', sessionId: 'audit-batch-race',
    phase: 'batch-page', message: 'Página 1 de 2: auditoria em andamento.', percent: 10,
    pageNumber: 1, total: 2, at: '2026-09-01T12:00:00.000Z',
  });
  assert.equal(earlyProgress.batch.pageNumber, 1);
  const reconciled = reducePanelState(earlyProgress, {
    type: 'BATCH_STARTED', auditId: 'audit-batch-race', total: 2, warnings: [{
      line: 23, code: 'DUPLICATE_URL', firstLine: 1,
      message: 'A URL repete uma entrada anterior e não será auditada novamente.',
    }],
  });
  assert.equal(reconciled.auditId, 'audit-batch-race');
  assert.equal(reconciled.batch.total, 2, 'the exact start response can enrich an earlier authoritative running bootstrap');
  assert.equal(reconciled.batch.pageNumber, 1, 'the exact start response does not erase progress received first');
  assert.equal(reconciled.progress.percent, 10);
  assert.equal(reconciled.batch.warnings[0].line, 23, 'blank input lines do not make safe line numbers invalid');
  assert.strictEqual(reducePanelState(authoritative, {
    type: 'BATCH_STARTED', auditId: 'another-audit', total: 2, warnings: [],
  }), authoritative);

  const rehydrated = reducePanelState(createInitialPanelState(), {
    type: 'AUDIT_RUNNING', auditId: 'audit-batch-rehydrated',
  });
  const inferredBatch = reducePanelState(rehydrated, {
    type: 'AUDIT_PROGRESS', auditId: 'audit-batch-rehydrated', sessionId: 'audit-batch-rehydrated',
    phase: 'batch-page', message: 'Página 1 de 2: auditoria em andamento.', percent: 5,
    pageNumber: 1, total: 2, at: '2026-09-01T12:00:00.000Z',
  });
  assert.equal(inferredBatch.auditSource, 'batch');
  assert.equal(inferredBatch.captureMode, 'full-evidence');
  assert.deepEqual(inferredBatch.batch, { total: 2, pageNumber: 1, warnings: [], errors: [] });

  const closed = reducePanelState(opened, { type: 'BATCH_FORM_CLOSED' });
  assert.equal(closed.entryMode, 'sources');
  assert.deepEqual(closed.batch, { total: null, pageNumber: null, warnings: [], errors: [] });
});

test('batch privacy pause preserves the safe total and projects only its page number and public signals', () => {
  let state = reducePanelState(createInitialPanelState(), { type: 'BATCH_FORM_OPENED' });
  state = reducePanelState(state, {
    type: 'CAPTURE_MODE_SELECTED', mode: 'element-only', focusId: 'capture-mode-element-only',
  });
  state = reducePanelState(state, { type: 'START_REQUESTED', source: 'batch' });
  state = reducePanelState(state, { type: 'BATCH_PREPARED', total: 4 });
  state = reducePanelState(state, { type: 'AUDIT_RUNNING', auditId: 'audit-batch-private' });

  const paused = reducePanelState(state, {
    type: 'PRIVACY_PAUSED', auditId: 'audit-batch-private', mode: 'element-only',
    categories: ['password', 'payment'],
    message: 'A página contém conteúdo potencialmente sensível. Confirme para capturar imagens visíveis.',
    pageNumber: 3,
  });
  assert.equal(paused.sessionStatus, 'privacy-paused');
  assert.equal(paused.auditSource, 'batch');
  assert.equal(paused.captureMode, 'element-only');
  assert.deepEqual(paused.batch, { total: 4, pageNumber: 3, warnings: [], errors: [] });
  assert.doesNotMatch(JSON.stringify(paused), /https?:|consent|owner|digest|documentId|tabId/iu);

  const rehydrated = reducePanelState(reducePanelState(createInitialPanelState(), {
    type: 'AUDIT_RUNNING', auditId: 'audit-batch-rehydrated-private',
  }), {
    type: 'PRIVACY_PAUSED', auditId: 'audit-batch-rehydrated-private', mode: 'full-evidence',
    categories: ['private-marker'],
    message: 'A página contém conteúdo potencialmente sensível. Confirme para capturar imagens visíveis.',
    pageNumber: 2,
  });
  assert.equal(rehydrated.auditSource, 'batch');
  assert.deepEqual(rehydrated.batch, { total: null, pageNumber: 2, warnings: [], errors: [] });
});

test('rehydrated batch progress preserves the authoritative capture mode for every evidence policy', () => {
  for (const mode of ['full-evidence', 'element-only', 'no-pixels']) {
    let state = reducePanelState(createInitialPanelState(), {
      type: 'AUDIT_RUNNING', auditId: `audit-rehydrated-${mode}`, captureMode: mode,
    });
    assert.equal(state.captureMode, mode);
    state = reducePanelState(state, {
      type: 'AUDIT_PROGRESS', auditId: `audit-rehydrated-${mode}`, sessionId: `audit-rehydrated-${mode}`,
      phase: 'batch-page', message: 'Página 1 de 3: auditoria em andamento.', percent: 10,
      pageNumber: 1, total: 3, at: '2026-09-01T12:00:00.000Z',
    });
    assert.equal(state.auditSource, 'batch');
    assert.equal(state.captureMode, mode, `batch progress must not invent another mode for ${mode}`);
  }
});

test('a second-page privacy pause remains actionable after first-page progress', () => {
  let state = reducePanelState(createInitialPanelState(), {
    type: 'AUDIT_RUNNING', auditId: 'audit-two-pauses', captureMode: 'full-evidence',
  });
  state = reducePanelState(state, {
    type: 'AUDIT_PROGRESS', auditId: 'audit-two-pauses', sessionId: 'audit-two-pauses',
    phase: 'batch-page', message: 'Página 1 de 2: processamento encerrado.', percent: 50,
    pageNumber: 1, total: 2, at: '2026-09-04T12:00:00.000Z',
  });
  const pause = pageNumber => ({
    type: 'PRIVACY_PAUSED', auditId: 'audit-two-pauses', mode: 'full-evidence',
    categories: ['password'], pageNumber,
    message: 'A página contém conteúdo potencialmente sensível. Confirme para capturar imagens visíveis.',
  });
  const samePage = reducePanelState(state, pause(1));
  assert.equal(samePage.progress.percent, 50, 'same-page pause retains its correlated progress');
  const second = reducePanelState(state, pause(2));
  assert.equal(second.batch.total, 2);
  assert.equal(second.batch.pageNumber, 2);
  const confirmed = reducePanelState(second, { type: 'PRIVACY_CONFIRM_REQUESTED' });
  assert.equal(confirmed.privacy.confirmationPending, true,
    'a new page must not inherit a progress message which invalidates subsequent actions');
  assert.equal(second.progress.phase, null);
  assert.strictEqual(reducePanelState(confirmed, { type: 'PRIVACY_CONFIRM_REQUESTED' }), confirmed);
});

test('single-URL entry state never stores private correlation and starts each explicit capture mode', () => {
  const initial = createInitialPanelState();
  const opened = reducePanelState(initial, { type: 'URL_FORM_OPENED' });
  assert.equal(opened.entryMode, 'single-url');
  assert.equal(opened.focusId, 'audit-url');
  assert.doesNotMatch(JSON.stringify(opened), /example\.test|token=raw/iu);

  const rejected = reducePanelState(opened, { type: 'URL_ENTRY_REJECTED', code: 'invalid' });
  assert.equal(rejected.entryError, 'invalid');
  assert.strictEqual(reducePanelState(opened, {
    type: 'URL_ENTRY_REJECTED', code: 'invalid', url: 'https://secret.example/path?token=raw',
  }), opened);

  for (const mode of ['full-evidence', 'element-only', 'no-pixels']) {
    const selected = reducePanelState(opened, {
      type: 'CAPTURE_MODE_SELECTED', mode, focusId: `capture-mode-${mode}`,
    });
    const started = reducePanelState(selected, { type: 'START_REQUESTED', source: 'single-url' });
    assert.equal(started.screen, 'running', mode);
    assert.equal(started.auditSource, 'single-url', mode);
    assert.equal(started.captureMode, mode);
    assert.equal(started.entryError, null);
    assert.equal(Object.hasOwn(started, 'url'), false);
    assert.doesNotMatch(JSON.stringify(started), /example\.test|token=raw|consent|digest/iu);
    assert.strictEqual(reducePanelState(selected, {
      type: 'START_REQUESTED', source: 'single-url',
      url: 'https://example.test/path?token=raw', consentId: 'PRIVATE', digest: 'PRIVATE',
    }), selected, 'private start fields are never admitted to the reducer');
  }

  const closed = reducePanelState(opened, { type: 'URL_FORM_CLOSED' });
  assert.equal(closed.entryMode, 'sources');
  assert.equal(closed.entryError, null);
});

test('keeps persona simulation and page highlight UI state closed and independent from audit data', () => {
  const initial = createInitialPanelState();
  const reader = reducePanelState(initial, { type: 'PERSONA_SELECTED', mode: 'reader' });
  assert.deepEqual(reader.persona, {
    mode: 'reader', readerPaused: false, speechAvailability: 'unavailable', voiceId: '', rate: 1,
    readerCaption: '', readerPosition: '',
    message: 'Leitura simulada ativa. Use os controles para navegar pela legenda.',
  });
  const paused = reducePanelState(reader, { type: 'PERSONA_READER_PAUSED' });
  assert.equal(paused.persona.readerPaused, true);
  const announced = reducePanelState(paused, {
    type: 'PERSONA_READER_STATE', playback: 'playing', index: 1, total: 3,
    caption: 'Enviar formulário, botão', speechAvailability: 'unavailable', voiceId: '', rate: 1,
  });
  assert.deepEqual(announced.persona, {
    mode: 'reader', readerPaused: false, speechAvailability: 'unavailable', voiceId: '', rate: 1,
    readerCaption: 'Enviar formulário, botão', readerPosition: '2 de 3',
    message: 'Leitura 2 de 3: Enviar formulário, botão. A legenda está ativa; ative uma voz local para ouvir.',
  });
  const voiced = reducePanelState(announced, {
    type: 'PERSONA_READER_STATE', playback: 'playing', index: 1, total: 3,
    caption: 'Enviar formulário, botão', speechAvailability: 'available', voiceId: 'local-a', rate: 1.25,
  });
  assert.deepEqual(voiced.persona, {
    mode: 'reader', readerPaused: false, speechAvailability: 'available', voiceId: 'local-a', rate: 1.25,
    readerCaption: 'Enviar formulário, botão', readerPosition: '2 de 3',
    message: 'Leitura 2 de 3: Enviar formulário, botão. Voz local ativa.',
  });
  const failed = reducePanelState(voiced, { type: 'PERSONA_FAILED' });
  assert.deepEqual(failed.persona, {
    mode: 'reader', readerPaused: false, speechAvailability: 'available', voiceId: 'local-a', rate: 1.25,
    readerCaption: 'Enviar formulário, botão', readerPosition: '2 de 3',
    message: 'Não foi possível aplicar a simulação nesta página.',
  });
  const busy = reducePanelState(paused, { type: 'HIGHLIGHT_BUSY', occurrenceId: 'occ-1' });
  assert.deepEqual(busy.highlight, {
    state: 'busy', operation: 'highlight', occurrenceId: 'occ-1', bindingStatus: { state: 'unchecked' },
    message: 'Destacando na página atual.',
  });
  const active = reducePanelState(busy, { type: 'HIGHLIGHT_ACTIVE', occurrenceId: 'occ-1' });
  assert.equal(active.highlight.state, 'active');
  assert.equal(active.highlight.occurrenceId, 'occ-1');
  assert.equal(Object.hasOwn(active, 'sessionCapabilityId'), false);
  const cleared = reducePanelState({
    ...active,
    highlight: { ...active.highlight, bindingStatus: { state: 'available' } },
  }, { type: 'HIGHLIGHT_CLEARED', focusId: 'live-highlight-action' });
  assert.deepEqual(cleared.highlight, {
    state: 'idle', operation: null, occurrenceId: null, bindingStatus: { state: 'unchecked' }, message: 'Destaque removido.',
  });
  assert.equal(cleared.focusId, 'live-highlight-action');
});

test('distinguishes highlight installation from clear while preserving the same stable action focus', () => {
  const initial = reducePanelState(createInitialPanelState(), {
    type: 'AUDIT_RESULT', auditId: 'audit-1', result: resultBundle(),
  });
  const installing = reducePanelState(initial, {
    type: 'HIGHLIGHT_BUSY', occurrenceId: 'occ-1', focusId: 'live-highlight-action',
  });
  assert.equal(installing.highlight.operation, 'highlight');
  const active = reducePanelState(installing, {
    type: 'HIGHLIGHT_ACTIVE', occurrenceId: 'occ-1', focusId: 'live-highlight-action',
  });
  assert.equal(active.highlight.operation, null);
  const clearing = reducePanelState(active, {
    type: 'HIGHLIGHT_CLEAR_BUSY', focusId: 'live-highlight-action',
  });
  assert.equal(clearing.highlight.operation, 'clear');
  assert.equal(clearing.highlight.occurrenceId, 'occ-1');
  assert.equal(clearing.focusId, 'live-highlight-action');
});

test('implements the exact four-screen lifecycle and ignores unknown events', () => {
  const initial = createInitialPanelState();
  const requested = reducePanelState(initial, { type: 'START_REQUESTED', source: 'attached' });
  assert.equal(requested.screen, 'running');
  assert.equal(requested.auditId, null);
  const running = reducePanelState(requested, { type: 'AUDIT_RUNNING', auditId: 'audit-1' });
  assert.equal(running.screen, 'running');
  assert.equal(running.auditId, 'audit-1');
  const result = reducePanelState(running, { type: 'AUDIT_RESULT', auditId: 'audit-1', result: resultBundle() });
  assert.equal(result.screen, 'result');
  assert.equal(result.selectedOccurrenceId, 'occ-1');
  assert.equal(result.focusId, 'result-summary', 'the removed cancel control needs a semantic result destination');
  const restarted = reducePanelState(result, { type: 'BOOTSTRAP_INITIAL' });
  assert.equal(restarted.screen, 'initial');
  assert.equal(restarted.captureMode, 'full-evidence');
  assert.strictEqual(reducePanelState(restarted, { type: 'NOT_A_PANEL_EVENT' }), restarted);
  assert.strictEqual(reducePanelState(restarted, null), restarted);
});

test('records only canonical monotonic progress for the current running audit', () => {
  let state = reducePanelState(createInitialPanelState(), { type: 'START_REQUESTED', source: 'attached' });
  assert.deepEqual(state.progress, { phase: null, message: null, percent: null, at: null });
  state = reducePanelState(state, { type: 'AUDIT_RUNNING', auditId: 'audit-1' });
  const opening = {
    type: 'AUDIT_PROGRESS', auditId: 'audit-1', sessionId: 'audit-1',
    phase: 'opening', message: 'Abrindo o site', percent: 5, at: '2026-09-01T12:00:00.000Z',
  };
  state = reducePanelState(state, opening);
  assert.deepEqual(state.progress, { phase: 'opening', message: 'Abrindo o site', percent: 5, at: opening.at });

  const testing = { ...opening, phase: 'testing', message: 'Verificando acessibilidade', percent: 50, at: '2026-09-01T12:00:01.000Z' };
  state = reducePanelState(state, testing);
  assert.equal(state.progress.percent, 50);
  const evidence = { ...opening, phase: 'evidence', message: 'Preparando evidências', percent: 72, at: testing.at };
  state = reducePanelState(state, evidence);
  assert.equal(state.progress.percent, 72, 'distinct real milestones may share the same clock millisecond');
  for (const invalid of [
    { ...opening, at: '2026-09-01T12:00:02.000Z' },
    { ...testing, auditId: 'other-audit', sessionId: 'other-audit', at: '2026-09-01T12:00:02.000Z' },
    { ...testing, at: '2026-09-01T12:00:00.000Z' },
    { ...testing, phase: 'testing', message: 'dado não confiável', at: '2026-09-01T12:00:02.000Z' },
    { ...testing, phase: 'complete', message: 'Auditoria concluída', percent: 100, at: '2026-09-01T12:00:02.000Z' },
  ]) assert.strictEqual(reducePanelState(state, invalid), state);

  const paused = reducePanelState(state, {
    type: 'PRIVACY_PAUSED', auditId: 'audit-1', mode: 'full-evidence', categories: ['password'],
    message: 'A página contém conteúdo potencialmente sensível. Confirme para capturar imagens visíveis.',
  });
  assert.strictEqual(reducePanelState(paused, { ...testing, at: '2026-09-01T12:00:02.000Z' }), paused);
  const resumed = reducePanelState(paused, { type: 'AUDIT_RUNNING', auditId: 'audit-1' });
  assert.equal(resumed.progress.percent, 72);
});

test('keeps a dedicated caption and position through voice unavailability and clears them when the reader ends', () => {
  const selected = reducePanelState(createInitialPanelState(), { type: 'PERSONA_SELECTED', mode: 'reader' });
  const reading = reducePanelState(selected, {
    type: 'PERSONA_READER_STATE', playback: 'playing', index: 0, total: 2,
    caption: 'Salvar, botão', speechAvailability: 'available', voiceId: 'local-a', rate: 1,
  });
  const unavailable = reducePanelState(reading, { type: 'PERSONA_READER_VOICE_UNAVAILABLE' });
  assert.equal(unavailable.persona.readerCaption, 'Salvar, botão');
  assert.equal(unavailable.persona.readerPosition, '1 de 2');
  assert.equal(unavailable.persona.speechAvailability, 'unavailable');
  assert.equal(unavailable.persona.voiceId, '');
  assert.equal(unavailable.focusId, reading.focusId);
  assert.equal(Object.isFrozen(unavailable.persona), true);
  const paused = reducePanelState(unavailable, { type: 'PERSONA_READER_PAUSED' });
  assert.equal(paused.persona.readerCaption, 'Salvar, botão');
  const idle = reducePanelState(paused, {
    type: 'PERSONA_READER_STATE', playback: 'idle', index: -1, total: 0,
    caption: '', speechAvailability: 'unavailable', voiceId: '', rate: 1,
  });
  assert.equal(idle.persona.readerCaption, '');
  assert.equal(idle.persona.readerPosition, '');
  const ended = reducePanelState(reading, { type: 'PERSONA_ENDED' });
  assert.equal(ended.persona.readerCaption, '');
  assert.equal(ended.persona.readerPosition, '');
});

test('rejects malformed caption presentation in caller-owned panel state without reading accessors', () => {
  const selected = reducePanelState(createInitialPanelState(), { type: 'PERSONA_SELECTED', mode: 'reader' });
  for (const values of [
    { readerCaption: 'Salvar\nsegredo', readerPosition: '1 de 2' },
    { readerCaption: 'Salvar, botão', readerPosition: '3 de 2' },
    { readerCaption: 'Salvar, botão', readerPosition: '' },
    { readerCaption: '', readerPosition: '1 de 2' },
    { readerCaption: 'Salvar, botão', readerPosition: '1 de 2001' },
    { readerCaption: 'x'.repeat(2049), readerPosition: '1 de 2' },
  ]) {
    const invalid = { ...selected, persona: { ...selected.persona, ...values } };
    assert.strictEqual(reducePanelState(invalid, { type: 'PERSONA_ENDED' }), invalid);
  }
  let reads = 0;
  const persona = { ...selected.persona };
  Object.defineProperty(persona, 'readerCaption', { enumerable: true, get() { reads += 1; throw new Error('accessor'); } });
  const hostile = { ...selected, persona };
  assert.strictEqual(reducePanelState(hostile, { type: 'PERSONA_ENDED' }), hostile);
  assert.equal(reads, 0);
});

test('drops deleted audit state while preserving an active persona and the selected capture mode', () => {
  let result = reducePanelState(createInitialPanelState(), {
    type: 'CAPTURE_MODE_SELECTED', mode: 'no-pixels', focusId: 'capture-mode-no-pixels',
  });
  result = reducePanelState(result, { type: 'PERSONA_SELECTED', mode: 'reader' });
  result = reducePanelState(result, {
    type: 'AUDIT_RESULT', auditId: 'audit-1', result: resultBundle(),
  });

  const cleared = reducePanelState(result, { type: 'AUDIT_DELETED' });

  assert.equal(cleared.screen, 'initial');
  assert.equal(cleared.auditId, null);
  assert.equal(cleared.captureMode, 'no-pixels');
  assert.equal(cleared.persona.mode, 'reader');
  assert.equal(cleared.selectedOccurrenceId, null);
  assert.equal(cleared.evidenceExpanded, false);
  assert.deepEqual(cleared.highlight, {
    state: 'idle', operation: null, occurrenceId: null,
    bindingStatus: { state: 'unchecked' }, message: null,
  });
  assert.strictEqual(reducePanelState(result, { type: 'AUDIT_DELETED', auditId: 'PRIVATE' }), result);
});

test('unknown and invalid events return a detached recursively frozen valid state', () => {
  const mutable = {
    version: 1, screen: 'result', auditId: 'audit-1',
    entryMode: 'sources', entryError: null, auditSource: 'attached',
    captureMode: 'no-pixels', sessionStatus: null,
    privacy: { mode: null, categories: [], message: null, confirmationPending: false },
    progress: { phase: null, message: null, percent: null, at: null },
    batch: { total: null, pageNumber: null, warnings: [], errors: [] },
    filters: { impact: ['critical'], wcag: [], abnt: [], result: [] },
    selectedOccurrenceId: 'occ-1', evidenceExpanded: false,
    persona: {
      mode: null, readerPaused: false, speechAvailability: 'unavailable', voiceId: '', rate: 1,
      readerCaption: '', readerPosition: '',
      message: 'Escolha uma simulação para esta página.',
    },
    highlight: { state: 'idle', operation: null, occurrenceId: null, bindingStatus: { state: 'unchecked' }, message: null },
    focusId: 'result-summary', scrollTop: 24, reason: null,
  };
  for (const event of [{ type: 'NOT_A_PANEL_EVENT' }, null]) {
    const result = reducePanelState(mutable, event);
    assert.notStrictEqual(result, mutable);
    assert.deepEqual(result, mutable);
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.filters), true);
    assert.equal(Object.isFrozen(result.filters.impact), true);
  }
  assert.equal(Object.isFrozen(mutable), false, 'the reducer does not freeze caller-owned input');
  const invalid = { ...mutable, screen: 'private-invalid-screen' };
  assert.strictEqual(reducePanelState(invalid, { type: 'NOT_A_PANEL_EVENT' }), invalid);
});

test('does not trust an outer-frozen state whose privacy projection is still mutable', () => {
  const initial = createInitialPanelState();
  const callerPrivacy = { mode: null, categories: [], message: null, confirmationPending: false };
  const shallowFrozen = Object.freeze({ ...initial, privacy: callerPrivacy });
  const detached = reducePanelState(shallowFrozen, { type: 'NOT_A_PANEL_EVENT' });
  assert.notStrictEqual(detached, shallowFrozen);
  assert.equal(Object.isFrozen(detached.privacy), true);
  assert.equal(Object.isFrozen(detached.privacy.categories), true);
  callerPrivacy.categories.push('PRIVATE');
  assert.deepEqual(detached.privacy.categories, []);
});

test('every transition is recursively frozen and filters preserve selection focus and scroll', () => {
  const resultState = frozen({
    ...createInitialPanelState(), screen: 'result', auditId: 'audit-1',
    selectedOccurrenceId: 'occ-1', focusId: 'filter-impact', scrollTop: 160,
  });
  const state = reducePanelState(resultState, { type: 'FILTER_SET', filter: 'impact', values: ['critical'] });
  assert.equal(Object.isFrozen(state), true);
  assert.equal(Object.isFrozen(state.filters), true);
  assert.equal(Object.isFrozen(state.filters.impact), true);
  assert.equal(state.selectedOccurrenceId, 'occ-1');
  assert.equal(state.focusId, 'filter-impact');
  assert.equal(state.scrollTop, 160);
  assert.deepEqual(state.filters.impact, ['critical']);
});

test('selection and evidence events retain exact closed interaction fields', () => {
  const result = reducePanelState(createInitialPanelState(), {
    type: 'AUDIT_RESULT', auditId: 'audit-1', result: resultBundle(),
  });
  const selected = reducePanelState(result, {
    type: 'OCCURRENCE_SELECTED', occurrenceId: 'occ-1', focusId: 'occurrence-occ-1', scrollTop: 240,
  });
  assert.equal(selected.selectedOccurrenceId, 'occ-1');
  assert.equal(selected.focusId, 'occurrence-occ-1');
  assert.equal(selected.scrollTop, 240);
  const expanded = reducePanelState(selected, {
    type: 'EVIDENCE_TOGGLED', expanded: true, focusId: 'evidence-summary', scrollTop: 310,
  });
  assert.equal(expanded.evidenceExpanded, true);
  assert.equal(expanded.focusId, 'evidence-summary');
  assert.equal(expanded.scrollTop, 310);
  assert.equal(Object.isFrozen(expanded), true);
});

test('missing or duplicate occurrence details fail closed as unavailable', () => {
  const valid = resultBundle();
  for (const result of [
    frozen({ ...valid, details: frozen([]) }),
    frozen({ ...valid, details: frozen([valid.details[0], valid.details[0]]) }),
  ]) {
    const state = reducePanelState(createInitialPanelState(), {
      type: 'AUDIT_RESULT', auditId: 'audit-1', result,
    });
    assert.equal(state.screen, 'unavailable');
    assert.equal(state.reason, 'O resultado local não pôde ser exibido com segurança.');
    assert.equal(state.auditId, 'audit-1');
  }
});

test('checkpoint-only passed cards allow a valid zero-detail result', () => {
  const valid = resultBundle();
  const passed = frozen({
    ...valid.summary.groups.failed[0],
    displayOutcome: 'passed', originalOutcome: 'passed', classification: 'passed',
    occurrenceIds: frozen([]), evidence: frozen({ evidenceIds: frozen([]), highlightAvailable: false }),
  });
  const result = frozen({
    ...valid,
    summary: frozen({ ...valid.summary, groups: frozen({ failed: frozen([]), alerts: frozen([]), humanReview: frozen([]), passed: frozen([passed]) }) }),
    details: frozen([]),
  });
  const state = reducePanelState(createInitialPanelState(), { type: 'AUDIT_RESULT', auditId: 'audit-1', result });
  assert.equal(state.screen, 'result');
  assert.equal(state.selectedOccurrenceId, null);
});

test('port interruption and retry preserve only the last safe audit ID', () => {
  const running = reducePanelState(createInitialPanelState(), { type: 'AUDIT_RUNNING', auditId: 'audit-safe' });
  const interrupted = reducePanelState(running, { type: 'PORT_INTERRUPTED', error: 'Bearer PRIVATE' });
  assert.deepEqual(interrupted, {
    version: 1,
    screen: 'unavailable',
    auditId: 'audit-safe',
    entryMode: 'sources',
    entryError: null,
    auditSource: 'attached',
    captureMode: 'full-evidence',
    sessionStatus: null,
    privacy: { mode: null, categories: [], message: null, confirmationPending: false },
    progress: { phase: null, message: null, percent: null, at: null },
    batch: { total: null, pageNumber: null, warnings: [], errors: [] },
    filters: { impact: [], wcag: [], abnt: [] },
    selectedOccurrenceId: null,
    evidenceExpanded: false,
    persona: {
      mode: null, readerPaused: false, speechAvailability: 'unavailable', voiceId: '', rate: 1,
      readerCaption: '', readerPosition: '',
      message: 'Escolha uma simulação para esta página.',
    },
    highlight: { state: 'idle', operation: null, occurrenceId: null, bindingStatus: { state: 'unchecked' }, message: null },
    focusId: 'retry',
    scrollTop: 0,
    reason: 'Painel não preparado. Abra novamente pelo botão da extensão.',
  });
  const retrying = reducePanelState(interrupted, { type: 'RETRY_REQUESTED' });
  assert.equal(retrying.screen, 'unavailable');
  assert.equal(retrying.auditId, 'audit-safe');
  assert.doesNotMatch(JSON.stringify(retrying), /Bearer|PRIVATE/u);
});

test('AUDIT_UNAVAILABLE maps only closed reasons and never echoes native errors', () => {
  const state = reducePanelState(createInitialPanelState(), {
    type: 'AUDIT_UNAVAILABLE', auditId: 'audit-1', reason: 'native stack SECRET',
  });
  assert.equal(state.reason, 'Não foi possível concluir a operação local.');
  assert.doesNotMatch(JSON.stringify(state), /native|SECRET/u);
});

test('selects one closed capture mode only on the initial screen and preserves it when starting', () => {
  const initial = createInitialPanelState();
  assert.equal(initial.captureMode, 'full-evidence');
  const selected = reducePanelState(initial, {
    type: 'CAPTURE_MODE_SELECTED', mode: 'no-pixels', focusId: 'capture-mode-no-pixels',
  });
  assert.equal(selected.captureMode, 'no-pixels');
  assert.equal(selected.focusId, 'capture-mode-no-pixels');

  const started = reducePanelState(selected, { type: 'START_REQUESTED', source: 'attached' });
  assert.equal(started.screen, 'running');
  assert.equal(started.captureMode, 'no-pixels');
  assert.strictEqual(reducePanelState(started, {
    type: 'CAPTURE_MODE_SELECTED', mode: 'no-pixels', focusId: 'capture-mode-no-pixels',
  }), started, 'the running audit keeps the mode that was selected before start');

  const reset = reducePanelState(selected, { type: 'BOOTSTRAP_INITIAL' });
  assert.equal(reset.captureMode, 'full-evidence');

  for (const mode of ['', 'pixels', 'FULL-EVIDENCE', null]) {
    assert.strictEqual(reducePanelState(initial, { type: 'CAPTURE_MODE_SELECTED', mode }), initial);
  }
});

test('projects a privacy pause into the running screen without storing private correlation', () => {
  const message = 'A página contém conteúdo potencialmente sensível. Confirme para capturar imagens visíveis.';
  let state = reducePanelState(createInitialPanelState(), {
    type: 'CAPTURE_MODE_SELECTED', mode: 'full-evidence', focusId: 'capture-mode-full-evidence',
  });
  state = reducePanelState(state, { type: 'START_REQUESTED', source: 'attached' });
  state = reducePanelState(state, { type: 'AUDIT_RUNNING', auditId: 'audit-private' });
  state = reducePanelState(state, {
    type: 'PRIVACY_PAUSED', auditId: 'audit-private', mode: 'full-evidence',
    categories: ['password', 'payment'], message,
  });

  assert.equal(state.screen, 'running');
  assert.equal(state.sessionStatus, 'privacy-paused');
  assert.equal(state.captureMode, 'full-evidence');
  assert.deepEqual(state.privacy, {
    mode: 'full-evidence', categories: ['password', 'payment'], message, confirmationPending: false,
  });
  assert.equal(state.focusId, 'confirm-pixel-capture');
  assert.equal(Object.isFrozen(state.privacy), true);
  assert.equal(Object.isFrozen(state.privacy.categories), true);
  assert.doesNotMatch(JSON.stringify(state), /consent|capability|documentId|tabId|digest|PRIVATE/u);

  const pending = reducePanelState(state, { type: 'PRIVACY_CONFIRM_REQUESTED' });
  assert.equal(pending.privacy.confirmationPending, true);
  assert.equal(pending.focusId, 'confirm-pixel-capture');

  const resumed = reducePanelState(pending, { type: 'AUDIT_RUNNING', auditId: 'audit-private' });
  assert.equal(resumed.sessionStatus, null);
  assert.deepEqual(resumed.privacy, {
    mode: null, categories: [], message: null, confirmationPending: false,
  });
  assert.equal(resumed.captureMode, 'full-evidence');
});

test('a rotated privacy pause replaces the prior projection and rearms confirmation', () => {
  const message = 'A página contém conteúdo potencialmente sensível. Confirme para capturar imagens visíveis.';
  const running = reducePanelState(
    reducePanelState(createInitialPanelState(), { type: 'START_REQUESTED', source: 'attached' }),
    { type: 'AUDIT_RUNNING', auditId: 'audit-private' },
  );
  const first = reducePanelState(running, {
    type: 'PRIVACY_PAUSED', auditId: 'audit-private', mode: 'full-evidence',
    categories: ['password'], message,
  });
  const pending = reducePanelState(first, { type: 'PRIVACY_CONFIRM_REQUESTED' });
  const rotated = reducePanelState(pending, {
    type: 'PRIVACY_PAUSED', auditId: 'audit-private', mode: 'element-only',
    categories: ['private-marker'], message,
  });

  assert.notStrictEqual(rotated.privacy, pending.privacy);
  assert.deepEqual(rotated.privacy, {
    mode: 'element-only', categories: ['private-marker'], message, confirmationPending: false,
  });
  assert.equal(rotated.captureMode, 'element-only');
});

test('privacy reducer events fail closed for no-pixels, extra fields, accessors, symbols and proxies', () => {
  const message = 'A página contém conteúdo potencialmente sensível. Confirme para capturar imagens visíveis.';
  const running = reducePanelState(
    reducePanelState(createInitialPanelState(), { type: 'START_REQUESTED', source: 'attached' }),
    { type: 'AUDIT_RUNNING', auditId: 'audit-private' },
  );
  const valid = {
    type: 'PRIVACY_PAUSED', auditId: 'audit-private', mode: 'full-evidence', categories: ['password'], message,
  };
  const hostile = [
    { ...valid, mode: 'no-pixels' },
    { ...valid, consentId: 'PRIVATE' },
    Object.assign({ ...valid }, { [Symbol('private')]: true }),
    Object.defineProperty({ ...valid }, 'mode', { enumerable: true, get() { throw new Error('PRIVATE'); } }),
    new Proxy(valid, { ownKeys() { throw new Error('PRIVATE'); } }),
  ];
  for (const event of hostile) assert.strictEqual(reducePanelState(running, event), running);

  const selected = reducePanelState(createInitialPanelState(), {
    type: 'CAPTURE_MODE_SELECTED', mode: 'element-only', focusId: 'capture-mode-element-only',
  });
  assert.strictEqual(reducePanelState(selected, {
    type: 'CAPTURE_MODE_SELECTED', mode: 'full-evidence', focusId: 'capture-mode-full-evidence', extra: true,
  }), selected);
});
