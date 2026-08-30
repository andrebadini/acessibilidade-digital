import assert from 'node:assert/strict';
import test from 'node:test';

import { REPORT_PORT_NAME, createReportPortCoordinator } from '../../src/background/report-port.js';

function event() {
  const listeners = new Set();
  return {
    addListener(listener) { listeners.add(listener); },
    removeListener(listener) { listeners.delete(listener); },
    emit(value) { for (const listener of [...listeners]) listener(value); },
  };
}

function port(sender) {
  const onMessage = event();
  const onDisconnect = event();
  const posted = [];
  return {
    name: REPORT_PORT_NAME, sender, onMessage, onDisconnect, posted,
    postMessage(value) { posted.push(value); },
    disconnect() { onDisconnect.emit(); },
  };
}

test('authenticated report ports publish only the closed highlight state event', async () => {
  const authorizations = [];
  const snapshots = [];
  const coordinator = createReportPortCoordinator({
    reportLaunch: {
      async authorizeIntent(value) {
        authorizations.push(value);
        return value.intent === 'export' || value.intent === 'highlight'
          ? { ok: true, auditId: value.auditId, sessionCapabilityId: value.sessionCapabilityId, intent: value.intent }
          : { ok: false };
      },
    },
    async readHighlightState(value) {
      snapshots.push(value);
      return { ok: true, highlight: { state: 'active', occurrenceId: 'occ-current' } };
    },
    setTimer: setTimeout, clearTimer: clearTimeout,
  });
  const report = port({ id: 'ext-test', documentId: 'report-document', url: 'chrome-extension://ext-test/src/review/index.html?auditId=audit-1' });
  assert.equal(coordinator.attachReportPort(report), true);
  report.onMessage.emit({ protocol: 'audita-report', version: 1, type: 'hello', auditId: 'audit-1', sessionCapabilityId: 'R'.repeat(22) });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(report.posted, [{
    version: 1, type: 'HIGHLIGHT_STATE_CHANGED', auditId: 'audit-1', occurrenceId: 'occ-current', state: 'active',
  }]);
  assert.deepEqual(snapshots, [{
    sessionCapabilityId: 'R'.repeat(22), auditId: 'audit-1', sender: report.sender,
  }]);
  assert.deepEqual(await coordinator.publishHighlightState({ version: 1, type: 'HIGHLIGHT_STATE_CHANGED', auditId: 'audit-1', occurrenceId: 'occ-1', state: 'active' }), { delivered: 1 });
  assert.deepEqual(report.posted.at(-1), { version: 1, type: 'HIGHLIGHT_STATE_CHANGED', auditId: 'audit-1', occurrenceId: 'occ-1', state: 'active' });
  assert.deepEqual(await coordinator.publishHighlightState({ version: 1, type: 'HIGHLIGHT_STATE_CHANGED', auditId: 'audit-1', occurrenceId: null, state: 'clear' }), { delivered: 1 });
  assert.deepEqual(report.posted.at(-1), { version: 1, type: 'HIGHLIGHT_STATE_CHANGED', auditId: 'audit-1', occurrenceId: null, state: 'clear' });
  assert.deepEqual(authorizations.map(value => value.intent), ['export', 'highlight', 'highlight']);
  assert.deepEqual(await coordinator.publishHighlightState({ version: 1, type: 'HIGHLIGHT_STATE_CHANGED', auditId: 'audit-1', occurrenceId: 'occ-1', state: 'unsafe' }), { delivered: 0 });
});

test('buffers a state publication while the reconnect snapshot is pending so stale state cannot win', async () => {
  let resolveSnapshot;
  const coordinator = createReportPortCoordinator({
    reportLaunch: {
      async authorizeIntent(value) {
        return {
          ok: true, auditId: value.auditId,
          sessionCapabilityId: value.sessionCapabilityId, intent: value.intent,
        };
      },
    },
    readHighlightState: () => new Promise(resolve => { resolveSnapshot = resolve; }),
    setTimer: setTimeout, clearTimer: clearTimeout,
  });
  const report = port({
    id: 'ext-test', documentId: 'report-document',
    url: 'chrome-extension://ext-test/src/review/index.html?auditId=audit-race',
  });
  coordinator.attachReportPort(report);
  report.onMessage.emit({
    protocol: 'audita-report', version: 1, type: 'hello', auditId: 'audit-race',
    sessionCapabilityId: 'R'.repeat(22),
  });
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(await coordinator.publishHighlightState({
    version: 1, type: 'HIGHLIGHT_STATE_CHANGED', auditId: 'audit-race',
    occurrenceId: 'occ-new', state: 'active',
  }), { delivered: 1 });
  assert.deepEqual(report.posted, []);
  resolveSnapshot({ ok: true, highlight: { state: 'clear' } });
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(report.posted, [{
    version: 1, type: 'HIGHLIGHT_STATE_CHANGED', auditId: 'audit-race',
    occurrenceId: 'occ-new', state: 'active',
  }]);
});
