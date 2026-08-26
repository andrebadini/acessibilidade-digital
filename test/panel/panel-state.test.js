import assert from 'node:assert/strict';
import test from 'node:test';

import { createSubmissionGate, isMessageForAudit, isSafeReportUrl } from '../../src/panel/panel-state.js';

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
