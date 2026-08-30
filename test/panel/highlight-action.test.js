import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createHighlightStateSynchronizer,
  highlightActionForOccurrence,
  runHighlightAction,
  shouldApplyHighlightState,
} from '../../src/panel/highlight-action.js';

test('an event received during reconnect wins over an older durable snapshot', async () => {
  let resolveSnapshot;
  const applied = [];
  const synchronizer = createHighlightStateSynchronizer({
    requestCurrent: () => new Promise(resolve => { resolveSnapshot = resolve; }),
    applyState: value => applied.push(value),
  });

  const pending = synchronizer.synchronize();
  synchronizer.publish({ state: 'active', occurrenceId: 'occ-new' });
  resolveSnapshot({ ok: true, highlight: { state: 'clear' } });

  assert.equal(await pending, false);
  assert.deepEqual(applied, [{ state: 'active', occurrenceId: 'occ-new' }]);
});

test('applies one exact current state after a quiet reconnect and ignores malformed responses', async () => {
  const responses = [
    { ok: true, highlight: { state: 'active', occurrenceId: 'occ-current' } },
    { ok: true, highlight: { state: 'active', occurrenceId: 'occ-current', selector: '#forged' } },
  ];
  const applied = [];
  const synchronizer = createHighlightStateSynchronizer({
    requestCurrent: async () => responses.shift(),
    applyState: value => applied.push(value),
  });

  assert.equal(await synchronizer.synchronize(), true);
  assert.equal(await synchronizer.synchronize(), false);
  assert.deepEqual(applied, [{ state: 'active', occurrenceId: 'occ-current' }]);
});

test('projects only a current safe binding candidate to the closed highlight action', () => {
  const occurrence = { occurrenceId: 'occ-1', evidence: { highlightAvailable: false } };
  assert.deepEqual(highlightActionForOccurrence({
    occurrence, bindingStatus: { state: 'available' }, activeOccurrenceId: null,
  }), { kind: 'highlight', label: 'Ver e destacar na página', enabled: true, reason: null });
  assert.deepEqual(highlightActionForOccurrence({
    occurrence, bindingStatus: { state: 'unavailable', reason: 'document-changed' }, activeOccurrenceId: null,
  }), { kind: 'evidence', label: 'Consultar evidências', enabled: true, reason: 'Esta verificação não possui um elemento único destacável no estado atual.' });
  assert.deepEqual(highlightActionForOccurrence({
    occurrence, bindingStatus: { state: 'available' }, activeOccurrenceId: 'occ-1',
  }), { kind: 'clear', label: 'Limpar destaque', enabled: true, reason: null });
  assert.deepEqual(highlightActionForOccurrence({
    occurrence, bindingStatus: { state: 'checking' }, activeOccurrenceId: null,
  }), { kind: 'checking', label: 'Verificando possibilidade de destaque', enabled: false, reason: null });
});

test('highlight action always leaves busy state after a failed closed request', async () => {
  const states = [];
  const result = await runHighlightAction({
    request: async () => ({ ok: false }),
    onState: value => states.push(value),
  });
  assert.deepEqual(result, { ok: false });
  assert.deepEqual(states, ['busy', 'idle']);
});

test('deduplicates the correlated highlight response and publication without hiding real transitions', () => {
  assert.equal(shouldApplyHighlightState(
    { state: 'busy', operation: 'highlight', occurrenceId: 'occ-1' },
    { state: 'active', occurrenceId: 'occ-1' },
  ), true);
  assert.equal(shouldApplyHighlightState(
    { state: 'active', operation: null, occurrenceId: 'occ-1' },
    { state: 'active', occurrenceId: 'occ-1' },
  ), false);
  assert.equal(shouldApplyHighlightState(
    { state: 'busy', operation: 'clear', occurrenceId: 'occ-1' },
    { state: 'clear', occurrenceId: null },
  ), true);
  assert.equal(shouldApplyHighlightState(
    { state: 'idle', operation: null, occurrenceId: null },
    { state: 'clear', occurrenceId: null },
  ), false);
  assert.equal(shouldApplyHighlightState(
    { state: 'active', operation: null, occurrenceId: 'occ-1' },
    { state: 'active', occurrenceId: 'occ-2' },
  ), true);
});
