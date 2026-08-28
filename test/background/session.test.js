import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createAuditSession,
  createBatchSession,
  interruptBatchCheckpoint,
  transitionBatchSession,
  transitionSession,
} from '../../src/background/session.js';

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

test('creates only the minimal immutable non-resumable batch checkpoint', () => {
  const value = createBatchSession({
    id: 'batch-1', total: 3, startedAt: '2026-08-28T10:00:00.000Z',
  });
  assert.deepEqual(value, {
    id: 'batch-1', mode: 'batch', state: 'idle', total: 3, currentIndex: 0,
    completedCount: 0,
    statusCounts: { complete: 0, partial: 0, failed: 0, cancelled: 0 },
    cancelRequested: false,
    startedAt: '2026-08-28T10:00:00.000Z',
    updatedAt: '2026-08-28T10:00:00.000Z',
    resumable: false,
  });
  assert.equal(Object.isFrozen(value), true);
  assert.equal(Object.isFrozen(value.statusCounts), true);
  assert.doesNotMatch(JSON.stringify(value), /https?:|token|pixel|cookie/iu);
});

test('follows the explicit batch sequence and derives conservative terminal status', () => {
  let value = createBatchSession({ id: 'batch-1', total: 3, startedAt: '2026-08-28T10:00:00.000Z' });
  value = transitionBatchSession(value, { type: 'VALIDATE', at: '2026-08-28T10:00:01.000Z' });
  assert.equal(value.state, 'validating');
  value = transitionBatchSession(value, { type: 'QUEUE', at: '2026-08-28T10:00:02.000Z' });
  assert.equal(value.state, 'queued');
  value = transitionBatchSession(value, { type: 'START', at: '2026-08-28T10:00:03.000Z' });
  assert.equal(value.state, 'running');
  value = transitionBatchSession(value, { type: 'PAGE_FINISHED', status: 'complete', at: '2026-08-28T10:00:04.000Z' });
  value = transitionBatchSession(value, { type: 'PAGE_FINISHED', status: 'failed', at: '2026-08-28T10:00:05.000Z' });
  value = transitionBatchSession(value, { type: 'PAGE_FINISHED', status: 'complete', at: '2026-08-28T10:00:06.000Z' });
  assert.equal(value.currentIndex, 3);
  assert.equal(value.completedCount, 3);
  assert.deepEqual(value.statusCounts, { complete: 2, partial: 0, failed: 1, cancelled: 0 });
  value = transitionBatchSession(value, { type: 'FINISH', at: '2026-08-28T10:00:07.000Z' });
  assert.equal(value.state, 'partial');

  const allFailed = ['VALIDATE', 'QUEUE', 'START'].reduce((current, type) =>
    transitionBatchSession(current, { type, at: '2026-08-28T10:00:01.000Z' }),
  createBatchSession({ id: 'batch-2', total: 1, startedAt: '2026-08-28T10:00:00.000Z' }));
  const finishedFailed = transitionBatchSession(
    transitionBatchSession(allFailed, { type: 'PAGE_FINISHED', status: 'failed', at: '2026-08-28T10:00:02.000Z' }),
    { type: 'FINISH', at: '2026-08-28T10:00:03.000Z' },
  );
  assert.equal(finishedFailed.state, 'failed');
});

test('makes cancellation idempotent and terminal without authorizing another page', () => {
  let value = createBatchSession({ id: 'batch-cancel', total: 2, startedAt: '2026-08-28T10:00:00.000Z' });
  for (const type of ['VALIDATE', 'QUEUE', 'START']) {
    value = transitionBatchSession(value, { type, at: '2026-08-28T10:00:01.000Z' });
  }
  value = transitionBatchSession(value, { type: 'PAGE_FINISHED', status: 'complete', at: '2026-08-28T10:00:02.000Z' });
  const cancelling = transitionBatchSession(value, { type: 'CANCEL', at: '2026-08-28T10:00:03.000Z' });
  assert.equal(cancelling.state, 'cancelling');
  assert.equal(cancelling.cancelRequested, true);
  assert.equal(transitionBatchSession(cancelling, { type: 'CANCEL', at: '2026-08-28T10:00:04.000Z' }), cancelling);
  assert.throws(() => transitionBatchSession(cancelling, {
    type: 'PAGE_FINISHED', status: 'complete', at: '2026-08-28T10:00:05.000Z',
  }), /Transição inválida/iu);
  const terminal = transitionBatchSession(cancelling, {
    type: 'MARK_REMAINING_CANCELLED', count: 1, at: '2026-08-28T10:00:05.000Z',
  });
  assert.equal(terminal.state, 'cancelled');
  assert.deepEqual(terminal.statusCounts, { complete: 1, partial: 0, failed: 0, cancelled: 1 });
  assert.throws(() => transitionBatchSession(terminal, { type: 'CANCEL' }), /terminal/iu);
});

test('turns an active restored checkpoint into an explanatory non-resumable failure', () => {
  const running = {
    ...createBatchSession({ id: 'batch-restart', total: 2, startedAt: '2026-08-28T10:00:00.000Z' }),
    state: 'running', currentIndex: 1, completedCount: 1,
    statusCounts: { complete: 1, partial: 0, failed: 0, cancelled: 0 },
  };
  const interrupted = interruptBatchCheckpoint(running, '2026-08-28T10:05:00.000Z');
  assert.equal(interrupted.state, 'failed');
  assert.equal(interrupted.resumable, false);
  assert.equal(interrupted.currentIndex, 1);
  assert.equal(interrupted.completedCount, 1);
  assert.doesNotMatch(JSON.stringify(interrupted), /https?:|token|pixel|cookie/iu);
  assert.equal(interruptBatchCheckpoint({ ...running, state: 'complete' }, '2026-08-28T10:05:00.000Z').state, 'complete');
});
