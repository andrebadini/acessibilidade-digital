import assert from 'node:assert/strict';
import test from 'node:test';

import { createSubmissionGate, isMessageForAudit, isSafeReportUrl, reducePanelState } from '../../src/panel/panel-state.js';

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
  const audited = { auditId: 'a-1', status: 'partial', percent: 100, message: 'Auditoria concluída com limitações.', exportStatus: 'queued' };
  const exporting = reducePanelState(audited, { type: 'EXPORT_PROGRESS', auditId: 'a-1', status: 'running', message: 'Gerando arquivos.' });
  assert.equal(exporting.status, 'partial');
  assert.equal(exporting.percent, 100);
  assert.equal(exporting.exportStatus, 'running');
  const complete = reducePanelState(exporting, { type: 'EXPORT_COMPLETE', auditId: 'a-1', status: 'complete', formats: ['html', 'json', 'pdf'] });
  assert.equal(complete.status, 'partial');
  assert.equal(complete.exportStatus, 'complete');
  assert.match(complete.message, /relatório|arquivos/iu);
});
