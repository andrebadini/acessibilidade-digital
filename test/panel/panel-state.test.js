import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createInitialPanelState,
  reducePanelState,
} from '../../src/panel/panel-state.js';

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

test('creates an immutable initial screen with only stable interaction state', () => {
  const state = createInitialPanelState();
  assert.deepEqual(state, {
    version: 1,
    screen: 'initial',
    auditId: null,
    filters: { impact: [], wcag: [], abnt: [] },
    selectedOccurrenceId: null,
    evidenceExpanded: false,
    focusId: 'start-attached',
    scrollTop: 0,
    reason: null,
  });
  assert.equal(Object.isFrozen(state), true);
  assert.equal(Object.isFrozen(state.filters.impact), true);
  assert.equal(Object.hasOwn(state, 'sessionCapabilityId'), false);
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
  assert.strictEqual(reducePanelState(restarted, { type: 'NOT_A_PANEL_EVENT' }), restarted);
  assert.strictEqual(reducePanelState(restarted, null), restarted);
});

test('unknown and invalid events return a detached recursively frozen valid state', () => {
  const mutable = {
    version: 1, screen: 'result', auditId: 'audit-1',
    filters: { impact: ['critical'], wcag: [], abnt: [] },
    selectedOccurrenceId: 'occ-1', evidenceExpanded: false,
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
    filters: { impact: [], wcag: [], abnt: [] },
    selectedOccurrenceId: null,
    evidenceExpanded: false,
    focusId: 'retry',
    scrollTop: 0,
    reason: 'Auditoria interrompida; ela não foi retomada automaticamente',
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
