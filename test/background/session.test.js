import assert from 'node:assert/strict';
import test from 'node:test';

import { createAuditSession, transitionSession } from '../../src/background/session.js';

const session = () => createAuditSession({
  id: 'audit-1',
  requestedUrl: 'https://example.test/',
  startedAt: '2026-08-26T10:00:00.000Z',
});

test('creates a JSON-safe immutable idle audit session', () => {
  const value = session();
  assert.deepEqual(value, {
    id: 'audit-1',
    requestedUrl: 'https://example.test/',
    startedAt: '2026-08-26T10:00:00.000Z',
    state: 'idle',
    diagnostics: [],
    partial: false,
  });
  assert.equal(Object.isFrozen(value), true);
  assert.equal(JSON.stringify(value), JSON.stringify(JSON.parse(JSON.stringify(value))));
});

test('follows the legal audit state sequence without mutating prior snapshots', () => {
  let current = session();
  for (const [type, state] of [
    ['NAVIGATE', 'navigating'],
    ['COLLECT', 'collecting'],
    ['TEST', 'testing'],
    ['CAPTURE', 'capturing'],
    ['REPORT', 'reporting'],
    ['COMPLETE', 'complete'],
  ]) {
    const previous = current;
    current = transitionSession(current, { type, at: '2026-08-26T10:01:00.000Z' });
    assert.equal(current.state, state);
    assert.notEqual(current, previous);
    assert.equal(Object.isFrozen(current), true);
  }
  assert.equal(current.completedAt, '2026-08-26T10:01:00.000Z');
});

test('rejects invalid transitions and all terminal transitions', () => {
  assert.throws(() => transitionSession(session(), { type: 'TEST' }), /Transição inválida/);

  let completed = session();
  for (const type of ['NAVIGATE', 'COLLECT', 'TEST', 'CAPTURE', 'REPORT', 'COMPLETE']) {
    completed = transitionSession(completed, { type });
  }
  assert.throws(() => transitionSession(completed, { type: 'REPORT' }), /terminal/i);
});

test('keeps capture failure recoverable and records serializable diagnostics', () => {
  let current = session();
  for (const type of ['NAVIGATE', 'COLLECT', 'TEST', 'CAPTURE']) {
    current = transitionSession(current, { type });
  }
  current = transitionSession(current, {
    type: 'CAPTURE_FAILED',
    at: '2026-08-26T10:05:00.000Z',
    diagnostic: { code: 'SCREENSHOT_FAILED', message: 'Falha controlada' },
  });
  assert.equal(current.state, 'partial');
  assert.equal(current.partial, true);
  assert.deepEqual(current.diagnostics, [{
    code: 'SCREENSHOT_FAILED', message: 'Falha controlada', at: '2026-08-26T10:05:00.000Z',
  }]);
  current = transitionSession(current, { type: 'REPORT' });
  current = transitionSession(current, { type: 'COMPLETE' });
  assert.equal(current.state, 'complete');
  assert.equal(current.partial, true);
});

test('requires a non-empty JSON-safe diagnostic for a recoverable capture failure', () => {
  let current = session();
  for (const type of ['NAVIGATE', 'COLLECT', 'TEST', 'CAPTURE']) {
    current = transitionSession(current, { type });
  }
  for (const diagnostic of [undefined, '', '   ', {}, { message: '' }, { message: 'ok', extra: () => {} }]) {
    assert.throws(() => transitionSession(current, { type: 'CAPTURE_FAILED', diagnostic }), /Diagnóstico/);
  }
});

test('can enter failed or cancelled terminal states from active states', () => {
  const navigating = transitionSession(session(), { type: 'NAVIGATE' });
  assert.equal(transitionSession(navigating, { type: 'FAIL', diagnostic: 'CDP indisponível' }).state, 'failed');
  assert.equal(transitionSession(navigating, { type: 'CANCEL' }).state, 'cancelled');
});
