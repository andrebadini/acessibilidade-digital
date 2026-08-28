import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyExportEvent,
  createInitialPersonaState,
  createPersonaHello,
  expectPersonaHello,
  queuePersonaCommand,
  reducePersonaState,
  createSubmissionGate,
  isMessageForAudit,
  isSafeReportUrl,
  reducePanelState,
  restoreExportEventState,
} from '../../src/panel/panel-state.js';

function personaWorkerState(overrides = {}) {
  return {
    protocol: 'audita-persona-panel', version: 1, type: 'state', requestId: 'hello-1',
    ok: true, bound: true, targetTabId: 7, token: 'token-1', generation: 0,
    activeMode: null,
    reader: {
      playback: 'idle', index: -1, total: 0, caption: '', canPrevious: false, canNext: false,
      speechAvailability: 'available', voiceId: '', rate: 1,
    },
    limitations: [], coverage: 'dom-fallback-top-document-open-shadow',
    preferences: { voiceId: '', rate: 1 },
    ...overrides,
  };
}

test('correlates audit messages using auditId or sessionId', () => {
  assert.equal(isMessageForAudit({ auditId: 'a-1' }, 'a-1'), true);
  assert.equal(isMessageForAudit({ sessionId: 'a-1' }, 'a-1'), true);
  assert.equal(isMessageForAudit({ auditId: 'other' }, 'a-1'), false);
  assert.equal(isMessageForAudit({}, 'a-1'), false);
});

test('accepts reports only from this extension or its same-origin blob URLs', () => {
  const ownBase = 'chrome-extension://test/';
  assert.equal(isSafeReportUrl('chrome-extension://test/reports/a.html', ownBase), true);
  assert.equal(isSafeReportUrl('blob:chrome-extension://test/uuid', ownBase), true);
  for (const value of [
    'javascript:alert(1)', 'data:text/html,oi', 'https://example.test/r.html',
    'chrome-extension://other/reports/a.html', 'blob:chrome-extension://other/uuid',
  ]) {
    assert.equal(isSafeReportUrl(value, ownBase), false);
  }
});

test('uses a synchronous gate to reject reentrant submissions until released', () => {
  const gate = createSubmissionGate();
  assert.equal(gate.tryAcquire(), true);
  assert.equal(gate.tryAcquire(), false);
  gate.release();
  assert.equal(gate.tryAcquire(), true);
});

test('keeps progress monotonic and restores a safe completed review link', () => {
  const base = { auditId: 'a-1', status: 'running', percent: 50, message: 'Testando', reviewUrl: null };
  assert.deepEqual(reducePanelState(base, { type: 'AUDIT_PROGRESS', auditId: 'a-1', percent: 20, message: 'Antigo' }), base);
  const progressed = reducePanelState(base, { type: 'AUDIT_PROGRESS', auditId: 'a-1', percent: 72, message: 'Preparando evidências' });
  assert.equal(progressed.percent, 72);
  const completed = reducePanelState(progressed, { type: 'AUDIT_COMPLETE', auditId: 'a-1', status: 'complete', reviewUrl: 'chrome-extension://test/src/review/index.html?auditId=a-1' }, 'chrome-extension://test/');
  assert.equal(completed.status, 'complete');
  assert.equal(completed.reviewUrl, 'chrome-extension://test/src/review/index.html?auditId=a-1');
  assert.equal(reducePanelState(progressed, { type: 'AUDIT_COMPLETE', auditId: 'a-1', reviewUrl: 'javascript:alert(1)' }, 'chrome-extension://test/').reviewUrl, null);
});

test('ignores every progress event after a terminal state', () => {
  for (const status of ['complete', 'partial', 'failed', 'cancelled']) {
    const terminal = { auditId: 'a-1', status, percent: status === 'failed' ? 72 : 100, message: 'Terminal', reviewUrl: null };
    assert.deepEqual(reducePanelState(terminal, { type: 'AUDIT_PROGRESS', auditId: 'a-1', percent: 100, message: 'Atrasado' }), terminal);
  }
});

test('tracks export progress without regressing the terminal audit result', () => {
  const audited = reducePanelState(
    { auditId: 'a-1', status: 'running', percent: 99, message: 'Finalizando.', exportStatus: 'unavailable' },
    { type: 'AUDIT_COMPLETE', auditId: 'a-1', status: 'partial', exportStatus: 'preparing' },
  );
  assert.equal(audited.exportStatus, 'preparing');
  const exporting = reducePanelState(audited, {
    type: 'EXPORT_PROGRESS', auditId: 'a-1', status: 'running', message: 'Gerando arquivos.',
    exportRevision: 1, exportAttempt: 1, leaseOwnerId: 'owner-1',
  });
  assert.equal(exporting.status, 'partial');
  assert.equal(exporting.percent, 100);
  assert.equal(exporting.exportStatus, 'running');
  const complete = reducePanelState(exporting, {
    type: 'EXPORT_COMPLETE', auditId: 'a-1', status: 'complete', formats: ['html', 'json', 'csv', 'pdf'],
    exportRevision: 3, exportAttempt: 1, leaseOwnerId: 'owner-1',
  });
  assert.equal(complete.status, 'partial');
  assert.equal(complete.exportStatus, 'complete');
  assert.match(complete.message, /relatório|arquivos/iu);
  const lateAuditComplete = reducePanelState(complete, {
    type: 'AUDIT_COMPLETE', auditId: 'a-1', status: 'partial', exportStatus: 'preparing',
  });
  assert.equal(lateAuditComplete.exportStatus, 'complete');

  for (const exportStatus of ['queued', 'failed']) {
    const later = reducePanelState({ ...audited, exportStatus }, {
      type: 'AUDIT_COMPLETE', auditId: 'a-1', status: 'partial', exportStatus: 'preparing',
    });
    assert.equal(later.exportStatus, exportStatus);
  }

  for (const stale of [
    { type: 'EXPORT_PROGRESS', status: 'running', exportRevision: 1, exportAttempt: 1, leaseOwnerId: 'owner-old' },
    { type: 'EXPORT_FAILED', status: 'failed', exportRevision: 3, exportAttempt: 1, leaseOwnerId: 'owner-1' },
    { type: 'EXPORT_PROGRESS', status: 'running', exportRevision: 3, exportAttempt: 1, leaseOwnerId: 'owner-other' },
  ]) {
    assert.deepEqual(reducePanelState(complete, { ...stale, auditId: 'a-1' }), complete);
  }
  const regenerated = reducePanelState(complete, {
    type: 'EXPORT_PROGRESS', auditId: 'a-1', status: 'running', message: 'Nova geração.',
    exportRevision: 4, exportAttempt: 2, leaseOwnerId: 'owner-2',
  });
  assert.equal(regenerated.exportStatus, 'running');
  assert.equal(regenerated.exportRevision, 4);
  assert.equal(regenerated.exportAttempt, 2);
  assert.equal(regenerated.leaseOwnerId, 'owner-2');
});

test('a newer review invalidates an active export without leaving the panel stuck on running', () => {
  const running = {
    auditId: 'a-1', status: 'partial', percent: 100,
    exportStatus: 'running', exportRevision: 4, exportAttempt: 2, leaseOwnerId: 'owner-2',
    message: 'Gerando arquivos.',
  };
  const invalidated = reducePanelState(running, {
    type: 'EXPORT_INVALIDATED', auditId: 'a-1', status: 'preparing',
    exportRevision: 5, exportAttempt: 2, leaseOwnerId: 'owner-2',
    error: 'A revisão mais nova foi preservada.',
  });
  assert.equal(invalidated.exportStatus, 'preparing');
  assert.equal(invalidated.exportRevision, 5);
  assert.equal(invalidated.message, 'A revisão mais nova foi preservada.');
});

test('a committed review invalidates a terminal report and cannot regress a newer same-revision retry', () => {
  const complete = {
    auditId: 'a-1', status: 'partial', percent: 100,
    exportStatus: 'complete', exportRevision: 5, exportAttempt: 8, leaseOwnerId: 'owner-8',
    message: 'Arquivos do relatório gerados.',
  };
  const reviewed = reducePanelState(complete, {
    type: 'AUDIT_REVIEW_UPDATED', auditId: 'a-1', exportRevision: 6,
  });
  assert.equal(reviewed.exportStatus, 'preparing');
  assert.equal(reviewed.exportRevision, 6);
  assert.equal(reviewed.message, 'A revisão foi atualizada; gere o relatório novamente.');
  assert.equal(Object.hasOwn(reviewed, 'exportAttempt'), false);
  assert.equal(Object.hasOwn(reviewed, 'leaseOwnerId'), false);

  const retry = reducePanelState(reviewed, {
    type: 'EXPORT_PROGRESS', auditId: 'a-1', exportRevision: 6,
    exportAttempt: 9, leaseOwnerId: 'owner-9', message: 'Gerando novamente.',
  });
  assert.equal(retry.exportStatus, 'running');
  assert.strictEqual(reducePanelState(retry, {
    type: 'AUDIT_REVIEW_UPDATED', auditId: 'a-1', exportRevision: 6,
  }), retry);
});

test('keeps queued, running and delivering export events monotonic within one revision', () => {
  const queued = applyExportEvent(
    { auditId: 'a-1', exportStatus: 'preparing', exportRevision: 4 },
    { exportRevision: 4, exportAttempt: 1, leaseOwnerId: 'owner-4' },
    'queued',
  );
  const running = applyExportEvent(
    queued,
    { exportRevision: 4, exportAttempt: 1, leaseOwnerId: 'owner-4' },
    'running',
  );
  assert.strictEqual(applyExportEvent(
    running,
    { exportRevision: 4, exportAttempt: 1, leaseOwnerId: 'owner-4' },
    'queued',
  ), running);

  const delivering = applyExportEvent(
    running,
    { exportRevision: 4, exportAttempt: 1, leaseOwnerId: 'owner-4' },
    'delivering',
  );
  for (const staleStatus of ['queued', 'running']) {
    assert.strictEqual(applyExportEvent(
      delivering,
      { exportRevision: 4, exportAttempt: 1, leaseOwnerId: 'owner-4' },
      staleStatus,
    ), delivering);
  }
});

test('accepts a newer persisted attempt with a new owner at the same model revision', () => {
  const terminal = {
    auditId: 'a-1', exportStatus: 'complete', exportRevision: 5,
    exportAttempt: 7, leaseOwnerId: 'owner-old',
  };
  const retried = applyExportEvent(
    terminal,
    { exportRevision: 5, exportAttempt: 8, leaseOwnerId: 'owner-new' },
    'running',
  );
  assert.notStrictEqual(retried, terminal);
  assert.equal(retried.exportStatus, 'running');
  assert.equal(retried.exportAttempt, 8);
  assert.equal(retried.leaseOwnerId, 'owner-new');
  assert.strictEqual(applyExportEvent(
    retried,
    { exportRevision: 5, exportAttempt: 7, leaseOwnerId: 'owner-old' },
    'failed',
  ), retried);
});

test('hydrates persisted export correlation while rejecting malformed stored markers', () => {
  assert.deepEqual(restoreExportEventState({
    exportStatus: 'complete', exportRevision: 5, exportAttempt: 8, leaseOwnerId: 'owner-8',
  }), {
    exportStatus: 'complete', exportRevision: 5, exportAttempt: 8, leaseOwnerId: 'owner-8',
  });
  assert.deepEqual(restoreExportEventState({
    exportStatus: 'preparing', exportRevision: 6, exportAttempt: 8,
  }), {
    exportStatus: 'preparing', exportRevision: 6, exportAttempt: 8,
  });
  assert.deepEqual(restoreExportEventState({
    exportStatus: 'complete', exportRevision: 5, exportAttempt: 0, leaseOwnerId: 'bad owner',
  }), { exportStatus: 'complete', exportRevision: 5 });
});

test('persona state is independent from audit state and changes only after a correlated worker ACK', () => {
  const audit = { auditId: 'audit-immutable', occurrences: [{ id: 'occ-1', outcome: 'fail' }] };
  const auditBytes = JSON.stringify(audit);
  const initial = expectPersonaHello(createInitialPersonaState(), 'hello-1');
  assert.equal(initial.connection, 'connecting');
  assert.deepEqual(createPersonaHello('hello-1'), {
    protocol: 'audita-persona-panel', version: 1, type: 'hello', requestId: 'hello-1',
  });
  const ready = reducePersonaState(initial, personaWorkerState());
  assert.equal(ready.bound, true);
  assert.equal(ready.activeMode, null);
  assert.equal(queuePersonaCommand(ready, 'reader-start-1', 'reader-action', { action: 'start' }).message.args.action, 'start');

  const queued = queuePersonaCommand(ready, 'activate-1', 'activate', { mode: 'reader' });
  assert.equal(queued.state.pending.requestId, 'activate-1');
  assert.equal(queued.state.activeMode, null, 'fila local não publica estado otimista');
  const wrongAck = personaWorkerState({ requestId: 'other-request', generation: 1, activeMode: 'reader' });
  assert.strictEqual(reducePersonaState(queued.state, wrongAck), queued.state);
  const active = reducePersonaState(queued.state, personaWorkerState({
    requestId: 'activate-1', generation: 2, activeMode: 'reader',
    reader: { ...personaWorkerState().reader, playback: 'playing', index: 0, total: 2, caption: 'Enviar, botão', canNext: true },
  }));
  assert.equal(active.activeMode, 'reader');
  assert.equal(active.pending, null);
  assert.equal(active.reader.caption, 'Enviar, botão');
  assert.equal(JSON.stringify(audit), auditBytes);
  assert.equal(Object.hasOwn(active, 'auditId'), false);
});

test('a correlated hello failure leaves connecting and exposes a safe reconnect state', () => {
  const connecting = expectPersonaHello(createInitialPersonaState(), 'hello-failed');
  const failed = reducePersonaState(connecting, {
    protocol: 'audita-persona-panel', version: 1, type: 'error', requestId: 'hello-failed',
    ok: false, bound: true, code: 'PERSONA_TOKEN_FAILED', message: 'Não foi possível iniciar a sessão.',
  });
  assert.equal(failed.connection, 'error');
  assert.equal(failed.token, null);
  assert.equal(failed.code, 'PERSONA_TOKEN_FAILED');
  assert.strictEqual(reducePersonaState(connecting, {
    protocol: 'audita-persona-panel', version: 1, type: 'error', requestId: 'hello-other',
    ok: false, bound: true, code: 'PERSONA_TOKEN_FAILED', message: 'Não foi possível iniciar a sessão.',
  }), connecting);
});

test('connecting ignores an old-token state event until the exact hello ACK arrives', () => {
  const connecting = expectPersonaHello(createInitialPersonaState(), 'hello-new-document');
  const stale = personaWorkerState({
    requestId: 'event-old-speech', token: 'token-old', generation: 9,
    activeMode: 'reader',
    reader: { ...personaWorkerState().reader, playback: 'playing', caption: 'Estado antigo' },
  });
  assert.strictEqual(reducePersonaState(connecting, stale), connecting);
  const ready = reducePersonaState(connecting, personaWorkerState({
    requestId: 'hello-new-document', token: 'token-new', generation: 0,
  }));
  assert.equal(ready.connection, 'ready');
  assert.equal(ready.token, 'token-new');
});

test('persona state preserves a bounded truncation warning without claiming complete coverage', () => {
  const limitation = { code: 'dom-traversal-truncated', count: 37, truncated: true };
  const state = reducePersonaState(
    expectPersonaHello(createInitialPersonaState(), 'hello-1'),
    personaWorkerState({ limitations: [limitation] }),
  );
  assert.deepEqual(state.limitations, [limitation]);
});

test('persona reducer rejects extra fields, accessors, stale generations and uncorrelated errors', () => {
  const ready = reducePersonaState(expectPersonaHello(createInitialPersonaState(), 'hello-1'), personaWorkerState());
  const queued = queuePersonaCommand(ready, 'motor-1', 'activate', { mode: 'motor' });
  let reads = 0;
  const hostile = personaWorkerState({ requestId: 'motor-1' });
  Object.defineProperty(hostile.reader, 'caption', {
    enumerable: true, get() { reads += 1; return 'segredo'; },
  });
  assert.strictEqual(reducePersonaState(queued.state, hostile), queued.state);
  assert.equal(reads, 0);
  assert.strictEqual(reducePersonaState(queued.state, {
    ...personaWorkerState({ requestId: 'motor-1', generation: 1, activeMode: 'motor' }), extra: true,
  }), queued.state);
  assert.strictEqual(reducePersonaState(queued.state, personaWorkerState({
    requestId: 'motor-1', generation: -1, activeMode: 'motor',
  })), queued.state);
  assert.strictEqual(reducePersonaState(queued.state, {
    protocol: 'audita-persona-panel', version: 1, type: 'error', requestId: 'other',
    ok: false, bound: true, code: 'PERSONA_COMMAND_FAILED', message: 'Falhou.',
  }), queued.state);
});

test('persona reducer never accepts a pending ACK that silently changes token or target', () => {
  const ready = reducePersonaState(expectPersonaHello(createInitialPersonaState(), 'hello-1'), personaWorkerState());
  const queued = queuePersonaCommand(ready, 'activate-correlated', 'activate', { mode: 'motor' });
  const valid = personaWorkerState({
    requestId: 'activate-correlated', generation: 1, activeMode: 'motor',
  });
  assert.strictEqual(reducePersonaState(queued.state, {
    ...valid, token: 'token-retargeted',
  }), queued.state);
  assert.strictEqual(reducePersonaState(queued.state, {
    ...valid, targetTabId: 99,
  }), queued.state);
  assert.strictEqual(reducePersonaState(queued.state, {
    ...valid, generation: -1,
  }), queued.state);
  assert.equal(reducePersonaState(queued.state, valid).activeMode, 'motor');

  const sameGeneration = queuePersonaCommand(ready, 'go-correlated', 'go-target');
  assert.equal(reducePersonaState(sameGeneration.state, personaWorkerState({
    requestId: 'go-correlated', generation: ready.generation,
  })).pending, null, 'um ACK correlacionado pode manter a geração');
});
