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

test('exports only the live four-screen panel state contract', () => {
  assert.deepEqual(Object.keys(panelStateModule).sort(), ['createInitialPanelState', 'reducePanelState']);
});

test('creates an immutable initial screen with only stable interaction state', () => {
  const state = createInitialPanelState();
  assert.deepEqual(state, {
    version: 1,
    screen: 'initial',
    auditId: null,
    captureMode: 'full-evidence',
    sessionStatus: null,
    privacy: { mode: null, categories: [], message: null, confirmationPending: false },
    filters: { impact: [], wcag: [], abnt: [] },
    selectedOccurrenceId: null,
    evidenceExpanded: false,
    persona: {
      mode: null, readerPaused: false, speechAvailability: 'unavailable', voiceId: '', rate: 1,
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

test('keeps persona simulation and page highlight UI state closed and independent from audit data', () => {
  const initial = createInitialPanelState();
  const reader = reducePanelState(initial, { type: 'PERSONA_SELECTED', mode: 'reader' });
  assert.deepEqual(reader.persona, {
    mode: 'reader', readerPaused: false, speechAvailability: 'unavailable', voiceId: '', rate: 1,
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
    message: 'Leitura 2 de 3: Enviar formulário, botão. A legenda está ativa; ative uma voz local para ouvir.',
  });
  const voiced = reducePanelState(announced, {
    type: 'PERSONA_READER_STATE', playback: 'playing', index: 1, total: 3,
    caption: 'Enviar formulário, botão', speechAvailability: 'available', voiceId: 'local-a', rate: 1.25,
  });
  assert.deepEqual(voiced.persona, {
    mode: 'reader', readerPaused: false, speechAvailability: 'available', voiceId: 'local-a', rate: 1.25,
    message: 'Leitura 2 de 3: Enviar formulário, botão. Voz local ativa.',
  });
  const failed = reducePanelState(voiced, { type: 'PERSONA_FAILED' });
  assert.deepEqual(failed.persona, {
    mode: 'reader', readerPaused: false, speechAvailability: 'available', voiceId: 'local-a', rate: 1.25,
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
  const requested = reducePanelState(initial, { type: 'START_REQUESTED' });
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
    captureMode: 'no-pixels', sessionStatus: null,
    privacy: { mode: null, categories: [], message: null, confirmationPending: false },
    filters: { impact: ['critical'], wcag: [], abnt: [] },
    selectedOccurrenceId: 'occ-1', evidenceExpanded: false,
    persona: {
      mode: null, readerPaused: false, speechAvailability: 'unavailable', voiceId: '', rate: 1,
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
    captureMode: 'full-evidence',
    sessionStatus: null,
    privacy: { mode: null, categories: [], message: null, confirmationPending: false },
    filters: { impact: [], wcag: [], abnt: [] },
    selectedOccurrenceId: null,
    evidenceExpanded: false,
    persona: {
      mode: null, readerPaused: false, speechAvailability: 'unavailable', voiceId: '', rate: 1,
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

  const started = reducePanelState(selected, { type: 'START_REQUESTED' });
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
  state = reducePanelState(state, { type: 'START_REQUESTED' });
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
    reducePanelState(createInitialPanelState(), { type: 'START_REQUESTED' }),
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
    reducePanelState(createInitialPanelState(), { type: 'START_REQUESTED' }),
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
