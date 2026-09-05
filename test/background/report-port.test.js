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

const flush = () => new Promise(resolve => setImmediate(resolve));
const admitted = value => ({
  ok: true, auditId: value.auditId, sessionCapabilityId: value.sessionCapabilityId, intent: value.intent,
});
const helloPacket = auditId => ({
  protocol: 'audita-report', version: 1, type: 'hello', auditId, sessionCapabilityId: 'R'.repeat(22),
});
const activeEvent = auditId => ({
  version: 1, type: 'HIGHLIGHT_STATE_CHANGED', auditId, occurrenceId: 'occ-1', state: 'active',
});

function cleanupFixture(t, overrides = {}) {
  const reports = [];
  const coordinator = createReportPortCoordinator({
    reportLaunch: { authorizeIntent: overrides.authorizeIntent ?? (async value => admitted(value)) },
    readHighlightState: overrides.readHighlightState ?? (async () => ({ ok: true, highlight: { state: 'clear' } })),
    setTimer: setTimeout, clearTimer: clearTimeout,
  });
  t.after(() => { for (const report of reports) report.disconnect(); });
  return { coordinator, connect(auditId = null) {
    const report = port({ id: 'ext-test', documentId: `report-${reports.length}`,
      url: 'chrome-extension://ext-test/src/review/index.html' });
    reports.push(report);
    coordinator.attachReportPort(report);
    if (auditId !== null) report.onMessage.emit(helloPacket(auditId));
    return report;
  } };
}

test('report cleanup detaches only the requested audit, preserves foreign and idle ports, and is idempotent', async t => {
  const { coordinator, connect } = cleanupFixture(t);
  const own = [connect('audit-delete'), connect('audit-delete')];
  const foreign = connect('audit-keep');
  const idle = connect();
  await flush();
  assert.equal(await coordinator.clearAudit('audit-delete'), 2);
  assert.equal(await coordinator.clearAudit('audit-delete'), 0);
  assert.deepEqual(await coordinator.publishHighlightState(activeEvent('audit-delete')), { delivered: 0 });
  assert.deepEqual(own.map(report => report.posted.length), [1, 1]);
  assert.deepEqual(await coordinator.publishHighlightState(activeEvent('audit-keep')), { delivered: 1 });
  assert.deepEqual(foreign.posted.at(-1), activeEvent('audit-keep'));
  idle.onMessage.emit(helloPacket('audit-later'));
  await flush();
  assert.equal(idle.posted.length, 1);
  await assert.rejects(coordinator.clearAudit('https://private.invalid/?secret=sentinel'),
    error => error.message === 'REPORT_PORT_CLEANUP_DENIED');
  assert.deepEqual(await coordinator.publishHighlightState(activeEvent('audit-later')), { delivered: 1 });
});

test('report cleanup sees authentication in flight and suppresses the late initial snapshot', async t => {
  let release;
  let snapshotCalls = 0;
  const { coordinator, connect } = cleanupFixture(t, {
    authorizeIntent: value => new Promise(resolve => { release = () => resolve(admitted(value)); }),
    async readHighlightState() { snapshotCalls += 1; return { ok: true, highlight: { state: 'clear' } }; },
  });
  const report = connect('audit-delete');
  assert.equal(await coordinator.clearAudit('audit-delete'), 1);
  release();
  await flush();
  assert.equal(snapshotCalls, 0);
  assert.deepEqual(report.posted, []);
  assert.deepEqual(await coordinator.publishHighlightState(activeEvent('audit-delete')), { delivered: 0 });
});

test('report cleanup suppresses a snapshot and buffered event that finish after detachment', async t => {
  let release;
  const { coordinator, connect } = cleanupFixture(t, {
    readHighlightState: () => new Promise(resolve => { release = () => resolve({ ok: true, highlight: { state: 'clear' } }); }),
  });
  const report = connect('audit-delete');
  await flush();
  assert.deepEqual(await coordinator.publishHighlightState(activeEvent('audit-delete')), { delivered: 1 });
  assert.equal(await coordinator.clearAudit('audit-delete'), 1);
  release();
  await flush();
  assert.deepEqual(report.posted, []);
});

test('report cleanup prevents an in-flight highlight authorization from publishing after detachment', async t => {
  let release;
  let highlightAuthorizations = 0;
  const { coordinator, connect } = cleanupFixture(t, {
    authorizeIntent: async value => {
      if (value.intent === 'export' || ++highlightAuthorizations > 1) return admitted(value);
      return new Promise(resolve => { release = () => resolve(admitted(value)); });
    },
  });
  const report = connect('audit-delete');
  const nextReport = connect('audit-delete');
  await flush();
  const before = structuredClone(report.posted);
  const publishing = coordinator.publishHighlightState(activeEvent('audit-delete'));
  assert.equal(await coordinator.clearAudit('audit-delete'), 2);
  release();
  assert.deepEqual(await publishing, { delivered: 0 });
  assert.deepEqual(report.posted, before);
  assert.equal(nextReport.posted.length, 1);
  assert.equal(highlightAuthorizations, 1);
});

test('a second report hello cannot change audit ownership while the first authorization is pending', async t => {
  const releases = [];
  const { coordinator, connect } = cleanupFixture(t, {
    authorizeIntent: value => new Promise(resolve => { releases.push(() => resolve(admitted(value))); }),
  });
  const report = connect('audit-first');
  report.onMessage.emit(helloPacket('audit-second'));
  for (const release of releases) release();
  await flush();
  assert.deepEqual(report.posted, []);
  assert.equal(releases.length, 1);
});

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
