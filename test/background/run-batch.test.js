import assert from 'node:assert/strict';
import test from 'node:test';

import { runBatch } from '../../src/background/run-batch.js';
import { runAudit } from '../../src/background/run-audit.js';
import { normalizeUrlList } from '../../src/core/batch/normalize-url-list.js';
import { reportInput } from '../report/helpers.js';
import { AXE_PROVENANCE } from '../../src/browser/axe-adapter.js';
import { enrichAuditForReport } from '../../src/core/report/enrich-audit.js';
import { AUDIT_EXECUTION_INTERNAL } from '../../src/background/chrome-adapter.js';
import { createCapturePolicyV1 } from '../../src/core/privacy/capture-policy.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const TEST_EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';

const REPORT_OPTIONS = Object.freeze({
  timezone: 'America/Cuiaba', manifestVersion: '0.1.0',
  rulesVersion: '1.0.0', browserVersion: 'Chrome/151.0.0.0',
  expectedExtensionId: TEST_EXTENSION_ID,
});

function rawChild({ auditId, url, status = 'complete', now = null }) {
  const startedAt = typeof now === 'function' ? now() : '2026-08-28T12:00:00.000Z';
  const endedAt = typeof now === 'function' ? now() : '2026-08-28T12:00:01.000Z';
  const value = reportInput({
    auditId,
    requestedUrl: url,
    finalUrl: `${new URL(url).origin}/final?session=REMOVE&view=public`,
    timestamps: {
      startedAt,
      endedAt,
      generatedAt: endedAt,
    },
    session: { status, diagnostics: [], partial: status === 'partial' },
  });
  return value;
}

function clock() {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 7, 28, 12, 0, tick++)).toISOString();
}

test('runs an explicit success → throw → success list strictly sequentially and hands off once', async () => {
  const normalized = normalizeUrlList([
    'https://one.example.test/?token=SECRET_ONE&view=public',
    'https://two.example.test/',
    'https://three.example.test/',
  ].join('\n'));
  let active = 0;
  let maxActive = 0;
  let parentHandoffs = 0;
  const starts = [];
  const argumentsSeen = [];
  const progress = [];
  const runner = async options => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    starts.push(options.url);
    argumentsSeen.push(options);
    await options.chromeAdapter.emitProgress({ type: 'AUDIT_PROGRESS', percent: 20, message: 'child-private-message' });
    const childHandoff = await options.chromeAdapter.handoffReport({ auditId: options.idFactory() });
    assert.deepEqual(childHandoff, { reviewUrl: null, artifact: { status: 'pending', formats: [] } });
    await new Promise(resolve => setTimeout(resolve, 2));
    active -= 1;
    if (options.url.includes('two.example')) throw new Error('PRIVATE_THROW_DETAILS');
    return rawChild({ auditId: options.idFactory(), url: options.url, now: options.now });
  };
  const chromeAdapter = {
    async emitProgress(message) { progress.push(message); },
    async handoffReport(model) {
      parentHandoffs += 1;
      assert.equal(model.schemaVersion, 2);
      assert.equal(model.pages.length, 3);
      return { reviewUrl: `chrome-extension://${TEST_EXTENSION_ID}/src/review/index.html?auditId=${model.auditId}` };
    },
  };

  const model = await runBatch({
    entries: normalized.entries, batchAuditId: 'batch-sequential', runner, chromeAdapter,
    now: clock(), reportOptions: REPORT_OPTIONS, pageTimeoutMs: 1_000, cleanupTimeoutMs: 100,
  });

  assert.equal(maxActive, 1);
  assert.deepEqual(starts, normalized.entries.map(entry => entry.navigationUrl));
  assert.equal(argumentsSeen.every(value => value.closeAuditTab === true), true);
  assert.equal(argumentsSeen.every(value => value.cleanupMode === 'always'), true);
  assert.deepEqual(argumentsSeen.map(value => value.pageId), ['page-1', 'page-2', 'page-3']);
  assert.deepEqual(argumentsSeen.map(value => value.idFactory()), [
    'batch-sequential:page-1', 'batch-sequential:page-2', 'batch-sequential:page-3',
  ]);
  assert.equal(parentHandoffs, 1);
  assert.deepEqual(model.pages.map(page => page.status), ['complete', 'failed', 'complete']);
  assert.equal(model.session.status, 'partial');
  assert.equal(model.pages.length, 3, 'redirects ou links descobertos nunca criam uma quarta página');
  assert.equal(model.report.reviewUrl, null);
  assert.doesNotMatch(JSON.stringify(model), /SECRET_ONE|PRIVATE_THROW_DETAILS|child-private-message|token=|session=/u);
  assert.ok(progress.length > 0);
  assert.ok(progress.every((entry, index) => index === 0 || entry.percent >= progress[index - 1].percent));
  assert.ok(progress.every(entry => entry.auditId === 'batch-sequential' && entry.sessionId === 'batch-sequential'));
  assert.ok(progress.every(entry => entry.statusCounts && Number.isSafeInteger(entry.statusCounts.complete)));
  assert.match(progress.find(entry => entry.pageNumber === 3)?.message ?? '', /3 de 3/iu);
});

test('runBatch discards the validated handoff capability from its review-ready aggregate', async () => {
  const entries = normalizeUrlList('https://batch-review.example.test/').entries;
  const model = await runBatch({
    entries,
    batchAuditId: 'batch-transient-review',
    runner: async options => rawChild({ auditId: options.idFactory(), url: options.url, now: options.now }),
    chromeAdapter: {
      async emitProgress() {},
      async handoffReport() {
        return {
          reviewUrl: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/src/review/index.html?auditId=batch-transient-review',
        };
      },
    },
    now: clock(),
    reportOptions: REPORT_OPTIONS,
  });

  assert.deepEqual(model.report, {
    status: 'review-ready',
    reviewUrl: null,
    artifact: { status: 'pending', formats: [] },
  });
  assert.doesNotMatch(JSON.stringify(model), /chrome-extension:|abcdefghijklmnopabcdefghijklmnop/u);
});

test('enters an explicit non-cancellable finalization boundary before aggregate handoff', async () => {
  const events = [];
  const entries = normalizeUrlList('https://boundary.example.test/').entries;
  await runBatch({
    entries, batchAuditId: 'batch-boundary',
    runner: async options => {
      events.push('child');
      return rawChild({ auditId: options.idFactory(), url: options.url, now: options.now });
    },
    chromeAdapter: {
      tryEnterFinalization() { events.push('finalization'); return true; },
      async handoffReport() { events.push('handoff'); return { reviewUrl: null }; },
    },
    now: clock(), reportOptions: REPORT_OPTIONS,
  });
  assert.deepEqual(events, ['child', 'finalization', 'handoff']);
});

test('materializes cancellation when abort wins the synchronous finalization claim', async () => {
  const controller = new AbortController();
  const entries = normalizeUrlList('https://cancel-wins.example.test/').entries;
  const model = await runBatch({
    entries, batchAuditId: 'batch-cancel-wins', signal: controller.signal,
    runner: async options => rawChild({ auditId: options.idFactory(), url: options.url, now: options.now }),
    chromeAdapter: {
      tryEnterFinalization() {
        controller.abort(new DOMException('Cancelamento venceu.', 'AbortError'));
        return false;
      },
      async emitProgress() {}, async handoffReport() { return { reviewUrl: null }; },
    },
    now: clock(), reportOptions: REPORT_OPTIONS,
  });
  assert.equal(model.session.status, 'cancelled');
  assert.deepEqual(model.pages.map(value => value.status), ['cancelled']);
});

test('integrates three controlled fixtures through runBatch and runAudit into one mixed model', async t => {
  const entries = normalizeUrlList([
    'https://fixture-one.example.test/', 'https://fixture-fail.example.test/', 'https://fixture-three.example.test/',
  ].join('\n')).entries;
  const order = [];
  const removed = [];
  let finalHandoffs = 0;
  const childModels = [];
  let nextTabId = 40;
  const urlByTab = new Map();
  let currentUrl = '';
  const page = url => ({
    format: 'simplified-v1', document: { url, title: 'Fixture', language: '' }, warnings: [],
    coverage: { runtime: { outcome: 'complete' }, accessibility: { outcome: 'complete' } },
    layoutMetrics: { cssContentSize: { width: 800, height: 600 }, cssLayoutViewport: { clientWidth: 800, clientHeight: 600 } },
    nodes: [], axTree: { nodes: [] },
  });
  const adapter = {
    async createTab() { nextTabId += 1; return { id: nextTabId, windowId: 9 }; },
    async navigateTab(id, url) { urlByTab.set(id, url); currentUrl = url; order.push(url); },
    async waitForStable(id) {
      if (urlByTab.get(id).includes('fixture-fail')) throw new Error('controlled fixture failure');
      return { url: urlByTab.get(id) };
    },
    async connectCdp() { return { async command(method) { return method === 'Page.captureScreenshot' ? { data: PNG } : method === 'Page.getLayoutMetrics' ? page('').layoutMetrics : {}; }, async disconnect() {} }; },
    async runAxeInTab() { return {
      status: 'complete', provenance: AXE_PROVENANCE, diagnostics: [], frames: [{ frameId: 0, status: 'success', result: {
        violations: [{ id: 'html-has-lang', impact: 'serious', nodes: [{ impact: 'serious', target: ['html'] }] }],
        incomplete: [], passes: [], inapplicable: [],
      } }],
    }; },
    async collectPage() { return page(currentUrl); },
    async runDynamicProbes() { return { focus: { completed: true, events: [] }, warnings: [], actions: [] }; },
    async getEnvironment() { return { chromeVersion: 'Chrome/152', viewport: { width: 800, height: 600, deviceScaleFactor: 1 } }; },
    async getFinalUrl() { return currentUrl; },
    async getEvidenceUrl() { return currentUrl; },
    async probeDocumentIdentity(tabId) { return { tabId, windowId: 9, documentId: 'document-a', urlSessionDigest: `hmac-sha256:${'A'.repeat(43)}` }; },
    async probePrivacySignals() { return []; },
    async emitProgress() {},
    async handoffReport(model) { finalHandoffs += 1; return { reviewUrl: `chrome-extension://${TEST_EXTENSION_ID}/src/review/index.html?auditId=${model.auditId}` }; },
    async removeTab(id) { removed.push(id); },
  };
  const sessionValues = {};
  let randomValue = 0;
  Object.defineProperty(adapter, AUDIT_EXECUTION_INTERNAL, {
    enumerable: false,
    value: Object.freeze({
      sessionArea: {
        async get(key) { return Object.hasOwn(sessionValues, key) ? { [key]: structuredClone(sessionValues[key]) } : {}; },
        async set(entries) { Object.assign(sessionValues, structuredClone(entries)); },
        async remove(key) { delete sessionValues[key]; },
      },
      randomBytes(length) { return new Uint8Array(length).fill(++randomValue); },
      epochNow: () => 1_788_000_000_000,
      capturePolicy: createCapturePolicyV1({ mode: 'full-evidence', includeQuery: false }),
      privacyDecision: Object.freeze({
        status: 'allowed', consentCapabilityId: 'consent-a', documentId: 'document-a',
        urlSessionDigest: `hmac-sha256:${'A'.repeat(43)}`,
      }),
      consentAuthority: Object.freeze({ async consume() { return true; } }),
    }),
  });
  const model = await runBatch({
    entries, batchAuditId: 'batch-integration', chromeAdapter: adapter,
    runner: async options => { const child = await runAudit(options); childModels.push(child); return child; },
    now: clock(), reportOptions: REPORT_OPTIONS, pageTimeoutMs: 1_000, cleanupTimeoutMs: 100,
  });
  assert.deepEqual(order, entries.map(entry => entry.navigationUrl));
  assert.equal(model.pages.length, 3);
  assert.deepEqual(model.pages.map(value => value.status), ['complete', 'failed', 'complete'], JSON.stringify(childModels.map(value => value.session)));
  assert.equal(finalHandoffs, 1, 'handoffs filhos são no-op e só o modelo consolidado abre revisão');
  assert.deepEqual(removed.length, 3);
  assert.equal(model.auditId, 'batch-integration');
  assert.equal(childModels.length, 3);
  const occurrenceIds = new Set(model.occurrences.map(value => value.occurrenceId));
  assert.ok(model.occurrences.every(value => /^occurrence-[A-Za-z0-9._:-]+-\d{6}$/u.test(value.occurrenceId)));
  assert.ok(model.axePages.flatMap(value => value.result.occurrences)
    .every(value => occurrenceIds.has(value.occurrenceId)));
  const retainedAxeOccurrence = model.occurrences.find(value => value.source?.engine === 'axe-core');
  assert.ok(retainedAxeOccurrence);
  for (const [field, forgedValue] of [
    ['nodeId', 'node-forged'],
    ['selector', '#forged'],
    ['framePath', ['frame:99']],
  ]) {
    await t.test(`rejects a batch axe target whose ${field} diverges from its authoritative duplicate`, async () => {
      const forged = structuredClone(model);
      const occurrence = forged.occurrences.find(value => value.source?.engine === 'axe-core');
      occurrence.target[field] = forgedValue;
      await assert.rejects(enrichAuditForReport(forged, REPORT_OPTIONS), /axe|alvo|target|diverge|inválid/iu);
    });
  }
  assert.equal(
    model.ruleResults.find(value => value.ruleId === 'axe.html-has-lang').summary,
    'Resultado consolidado do lote: falha confirmada.',
  );
});

test('continues after timeout only after the aborted child confirms cleanup', async () => {
  const entries = normalizeUrlList('https://slow.example.test/\nhttps://next.example.test/').entries;
  const order = [];
  let active = 0;
  let maxActive = 0;
  const runner = options => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    order.push(`start:${options.url}`);
    if (options.url.includes('slow')) {
      return new Promise(resolve => options.signal.addEventListener('abort', () => {
        order.push('abort:slow');
        setTimeout(() => {
          active -= 1;
          order.push('cleanup:slow');
          resolve(rawChild({ auditId: options.idFactory(), url: options.url, status: 'cancelled', now: options.now }));
        }, 5);
      }, { once: true }));
    }
    active -= 1;
    order.push('finish:next');
    return Promise.resolve(rawChild({ auditId: options.idFactory(), url: options.url, now: options.now }));
  };
  const model = await runBatch({
    entries, batchAuditId: 'batch-timeout', runner,
    chromeAdapter: { async emitProgress() {}, async handoffReport() { return { reviewUrl: null }; } },
    now: clock(), reportOptions: REPORT_OPTIONS, pageTimeoutMs: 5, cleanupTimeoutMs: 50,
  });

  assert.equal(maxActive, 1);
  assert.ok(order.indexOf('cleanup:slow') < order.indexOf('start:https://next.example.test/'));
  assert.deepEqual(model.pages.map(page => page.status), ['failed', 'complete']);
  assert.equal(model.pages[0].diagnostics[0].code, 'BATCH_PAGE_TIMEOUT');
});

test('stops the scheduler when aborted cleanup is not confirmed and never overlaps another page', async () => {
  const entries = normalizeUrlList('https://stuck.example.test/\nhttps://must-not-start.example.test/').entries;
  let calls = 0;
  const model = await runBatch({
    entries, batchAuditId: 'batch-cleanup-stop',
    runner() { calls += 1; return new Promise(() => {}); },
    chromeAdapter: { async emitProgress() {}, async handoffReport() { return { reviewUrl: null }; } },
    now: clock(), reportOptions: REPORT_OPTIONS, pageTimeoutMs: 5, cleanupTimeoutMs: 5,
  });

  assert.equal(calls, 1);
  assert.deepEqual(model.pages.map(page => [page.status, page.attempted]), [
    ['failed', true], ['failed', false],
  ]);
  assert.equal(model.session.status, 'failed');
  assert.match(model.pages[1].diagnostics[0].code, /CLEANUP_UNCONFIRMED/u);
});

test('cancels the active and never-started pages while preserving earlier results', async () => {
  const entries = normalizeUrlList('https://done.example.test/\nhttps://active.example.test/\nhttps://queued.example.test/').entries;
  const controller = new AbortController();
  const checkpoints = [];
  const eventOrder = [];
  let calls = 0;
  const runner = options => {
    calls += 1;
    if (calls === 1) return Promise.resolve(rawChild({ auditId: options.idFactory(), url: options.url, now: options.now }));
    return new Promise(resolve => {
      setTimeout(() => controller.abort(new DOMException('Cancelado pelo usuário.', 'AbortError')), 2);
      options.signal.addEventListener('abort', () => resolve(rawChild({
        auditId: options.idFactory(), url: options.url, status: 'cancelled', now: options.now,
      })), { once: true });
    });
  };
  const model = await runBatch({
    entries, batchAuditId: 'batch-cancel', runner, signal: controller.signal,
    chromeAdapter: { async emitProgress() { eventOrder.push('progress'); }, async handoffReport() { return { reviewUrl: null }; } },
    now: clock(), reportOptions: REPORT_OPTIONS, pageTimeoutMs: 100, cleanupTimeoutMs: 50,
    async onCheckpoint(value) { checkpoints.push(value); eventOrder.push(`checkpoint:${value.state}`); },
  });

  assert.equal(calls, 2);
  assert.deepEqual(model.pages.map(page => [page.status, page.attempted]), [
    ['complete', true], ['cancelled', true], ['cancelled', false],
  ]);
  assert.equal(model.session.status, 'cancelled');
  assert.equal(checkpoints.at(-1).state, 'cancelled');
  assert.equal(checkpoints.at(-1).cancelRequested, true);
  assert.deepEqual(checkpoints.at(-1).statusCounts, { complete: 1, partial: 0, failed: 0, cancelled: 2 });
  assert.equal(eventOrder.slice(eventOrder.lastIndexOf('checkpoint:cancelled') + 1).includes('progress'), false);
});

test('returns a valid all-cancelled report without starting any child when already aborted', async () => {
  const controller = new AbortController();
  controller.abort(new DOMException('Cancelado pelo usuário.', 'AbortError'));
  let calls = 0;
  let handoffs = 0;
  const model = await runBatch({
    entries: normalizeUrlList('https://one.example.test/\nhttps://two.example.test/').entries,
    batchAuditId: 'batch-pre-cancelled', signal: controller.signal,
    runner() { calls += 1; },
    chromeAdapter: { async emitProgress() {}, async handoffReport() { handoffs += 1; return { reviewUrl: null }; } },
    now: clock(), reportOptions: REPORT_OPTIONS,
  });
  assert.equal(calls, 0);
  assert.equal(handoffs, 1);
  assert.equal(model.session.status, 'cancelled');
  assert.ok(model.pages.every(page => page.status === 'cancelled' && page.attempted === false));
  assert.match(model.integrity.canonicalModelHash, /^[a-f0-9]{64}$/u);
});

test('production default merges execution checkpoints and waits for owned cleanup before scheduling', async () => {
  const entries = normalizeUrlList('https://one.example.test/\nhttps://two.example.test/').entries;
  const values = {};
  const order = [];
  let randomValue = 20;
  const adapter = {
    async createTab() { const id = order.length + 41; order.push(`create:${id}`); return { id, windowId: 9 }; },
    async navigateTab(id) { order.push(`navigate:${id}`); },
    async waitForStable(id) { order.push(`wait:${id}`); throw new Error('CONTROLLED_NAVIGATION_FAILURE'); },
    async probeDocumentIdentity() { throw new Error('must not probe'); },
    async removeTab(id) { order.push(`remove:${id}`); },
    async emitProgress() {}, tryEnterFinalization() { return true; },
    async handoffReport() { return { reviewUrl: null }; },
  };
  Object.defineProperty(adapter, AUDIT_EXECUTION_INTERNAL, {
    enumerable: false,
    value: Object.freeze({
      sessionArea: {
        async get(key) { return Object.hasOwn(values, key) ? { [key]: structuredClone(values[key]) } : {}; },
        async set(entriesToStore) { Object.assign(values, structuredClone(entriesToStore)); },
        async remove(key) { delete values[key]; },
      },
      randomBytes(length) { return new Uint8Array(length).fill(++randomValue); },
      epochNow: () => 1_788_000_000_000,
    }),
  });
  const checkpoints = [];
  const model = await runBatch({
    entries, batchAuditId: 'batch-owned-default', chromeAdapter: adapter,
    now: clock(), reportOptions: REPORT_OPTIONS,
    onExecutionCheckpoint: async value => { checkpoints.push(value); },
  });
  assert.deepEqual(order, [
    'create:41', 'navigate:41', 'wait:41', 'remove:41',
    'create:45', 'navigate:45', 'wait:45', 'remove:45',
  ]);
  assert.deepEqual(checkpoints.map(value => value.pages.length), [1, 2]);
  assert.deepEqual(checkpoints.at(-1).pages.map(value => value.pageId), ['page-1', 'page-2']);
  assert.deepEqual(model.pages.map(value => value.status), ['failed', 'failed']);
  assert.doesNotMatch(JSON.stringify(model), /checkpoint|owner-|CONTROLLED_NAVIGATION_FAILURE/u);
});

function timedDefaultAdapter({ removalFails = false, settleDelayMs = 3 } = {}) {
  const values = {};
  const events = [];
  let nextTab = 80;
  let randomValue = 40;
  const adapter = {
    events,
    async createTab() { const tab = { id: nextTab++, windowId: 9 }; events.push(`create:${tab.id}`); return tab; },
    async navigateTab(id) { events.push(`navigate:${id}`); },
    async waitForStable(id, { signal }) {
      if (id !== 80) throw new Error('CONTROLLED_SECOND_PAGE_FAILURE');
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
        events.push('abort:80');
        setTimeout(() => { events.push('settle:80'); reject(signal.reason); }, settleDelayMs);
      }, { once: true }));
    },
    async probeDocumentIdentity() { throw new Error('must not probe'); },
    async removeTab(id) { events.push(`remove:${id}`); if (removalFails && id === 80) throw new Error('PRIVATE_REMOVE'); },
    async emitProgress() {}, tryEnterFinalization() { return true; }, async handoffReport() { return { reviewUrl: null }; },
  };
  Object.defineProperty(adapter, AUDIT_EXECUTION_INTERNAL, { enumerable: false, value: Object.freeze({
    sessionArea: {
      async get(key) { return Object.hasOwn(values, key) ? { [key]: structuredClone(values[key]) } : {}; },
      async set(entries) { Object.assign(values, structuredClone(entries)); },
      async remove(key) { delete values[key]; },
    },
    randomBytes(length) { return new Uint8Array(length).fill(++randomValue); },
    epochNow: () => 1_788_000_000_000,
  }) });
  return adapter;
}

test('default timeout blocks the next page when the settled execution confirms cleanup-pending', async () => {
  const adapter = timedDefaultAdapter({ removalFails: true });
  const model = await runBatch({
    entries: normalizeUrlList('https://slow.example.test/\nhttps://never.example.test/').entries,
    batchAuditId: 'batch-timeout-pending', chromeAdapter: adapter, now: clock(),
    reportOptions: REPORT_OPTIONS, pageTimeoutMs: 1_000, cleanupTimeoutMs: 1_000,
  });
  assert.equal(adapter.events.filter(event => event.startsWith('create:')).length, 1);
  assert.equal(model.pages[1].attempted, false);
  assert.match(model.pages[1].diagnostics[0].code, /CLEANUP_UNCONFIRMED/u);
});

test('default timeout merges the late factual checkpoint and starts the next page only after confirmed removal', async () => {
  const adapter = timedDefaultAdapter();
  const checkpoints = [];
  const model = await runBatch({
    entries: normalizeUrlList('https://slow.example.test/\nhttps://next.example.test/').entries,
    batchAuditId: 'batch-timeout-removed', chromeAdapter: adapter, now: clock(),
    reportOptions: REPORT_OPTIONS, pageTimeoutMs: 1_000, cleanupTimeoutMs: 1_000,
    onExecutionCheckpoint: async value => checkpoints.push(value),
  });
  assert.ok(adapter.events.indexOf('settle:80') < adapter.events.indexOf('create:81'));
  assert.deepEqual(checkpoints.at(-1).pages.map(page => page.pageId), ['page-1', 'page-2']);
  assert.deepEqual(model.pages.map(page => page.attempted), [true, true]);
});

test('default batch blocks after persistent ownership registration and removal failure without fabricating a journal', async () => {
  const values = {};
  let creates = 0;
  let randomValue = 70;
  const adapter = {
    async createTab() { creates += 1; return { id: 90, windowId: 7 }; },
    async navigateTab() { throw new Error('must not navigate'); },
    async waitForStable() { throw new Error('must not wait'); },
    async probeDocumentIdentity() { throw new Error('must not probe'); },
    async removeTab() { throw new Error('PRIVATE_REMOVE_FAILURE'); },
    async emitProgress() {}, tryEnterFinalization() { return true; }, async handoffReport() { return { reviewUrl: null }; },
  };
  Object.defineProperty(adapter, AUDIT_EXECUTION_INTERNAL, { enumerable: false, value: Object.freeze({
    sessionArea: {
      async get(key) { return Object.hasOwn(values, key) ? { [key]: structuredClone(values[key]) } : {}; },
      async set(entries) {
        if (Object.keys(entries).some(key => key.startsWith('audita:owned-tab:v1:'))) throw new Error('PRIVATE_SET_FAILURE');
        Object.assign(values, structuredClone(entries));
      },
      async remove(key) { delete values[key]; },
    },
    randomBytes(length) { return new Uint8Array(length).fill(++randomValue); },
    epochNow: () => 1_788_000_000_000,
  }) });
  const model = await runBatch({
    entries: normalizeUrlList('https://one.example.test/?token=PRIVATE_TOKEN\nhttps://must-not-start.example.test/').entries,
    batchAuditId: 'batch-registration-unconfirmed', chromeAdapter: adapter, now: clock(), reportOptions: REPORT_OPTIONS,
  });
  assert.equal(creates, 1);
  assert.equal(model.pages[1].attempted, false);
  assert.equal(Object.keys(values).some(key => key.startsWith('audita:owned-tab:v1:')), false);
  assert.doesNotMatch(JSON.stringify(model), /PRIVATE_TOKEN|PRIVATE_SET|PRIVATE_REMOVE|owner-/u);
});

test('custom batch failure persists only the requested origin', async () => {
  const model = await runBatch({
    entries: normalizeUrlList('https://example.test/pessoa/CPF-123456789?case=7&secret=x#fragmento').entries,
    batchAuditId: 'batch-safe-failure-url',
    runner: async () => { throw new Error('PRIVATE_NATIVE_FAILURE'); },
    chromeAdapter: { async emitProgress() {}, async handoffReport() { return { reviewUrl: null }; } },
    now: clock(), reportOptions: REPORT_OPTIONS,
  });
  assert.deepEqual(model.requestedScope.urls, ['https://example.test/']);
  assert.equal(model.pages[0].requestedUrl, 'https://example.test/');
  assert.equal(model.pages[0].finalUrl, 'https://example.test/');
  assert.doesNotMatch(JSON.stringify(model), /CPF-123456789|case=7|secret=x|fragmento|PRIVATE_NATIVE_FAILURE/u);
});

test('compatible batch success persists only requested and observed redirect origins', async () => {
  const requested = 'https://example.test/pessoa/CPF-123456789?case=7&secret=x#fragmento';
  const observed = 'https://redirect.example.test/conta/private?session=REMOVE&view=public#fim';
  const model = await runBatch({
    entries: normalizeUrlList(requested).entries,
    batchAuditId: 'batch-safe-compatible-success',
    runner: options => ({
      ...rawChild({ auditId: options.idFactory(), url: options.url, now: options.now }),
      finalUrl: observed,
    }),
    chromeAdapter: { async emitProgress() {}, async handoffReport() { return { reviewUrl: null }; } },
    now: clock(), reportOptions: REPORT_OPTIONS,
  });

  assert.deepEqual(model.requestedScope.urls, ['https://example.test/']);
  assert.equal(model.requestedUrl, 'https://example.test/');
  assert.equal(model.finalUrl, 'https://redirect.example.test/');
  assert.deepEqual(model.pages.map(page => ({
    pageId: page.pageId,
    requestedUrl: page.requestedUrl,
    finalUrl: page.finalUrl,
    finalUrlObserved: page.finalUrlObserved,
  })), [{
    pageId: 'page-1', requestedUrl: 'https://example.test/',
    finalUrl: 'https://redirect.example.test/', finalUrlObserved: true,
  }]);
});

test('compatible batch keeps two same-origin navigation targets as distinct ordered pages', async () => {
  const entries = normalizeUrlList([
    'https://example.test/first/private?case=7#one',
    'https://example.test/second/private?case=8#two',
  ].join('\n')).entries;
  const model = await runBatch({
    entries, batchAuditId: 'batch-compatible-shared-origin',
    runner: options => rawChild({ auditId: options.idFactory(), url: options.url, now: options.now }),
    chromeAdapter: { async emitProgress() {}, async handoffReport() { return { reviewUrl: null }; } },
    now: clock(), reportOptions: REPORT_OPTIONS,
  });

  assert.deepEqual(model.requestedScope.urls, ['https://example.test/', 'https://example.test/']);
  assert.deepEqual(model.pages.map(page => [page.pageId, page.requestedUrl, page.finalUrl]), [
    ['page-1', 'https://example.test/', 'https://example.test/'],
    ['page-2', 'https://example.test/', 'https://example.test/'],
  ]);
});

test('clears the losing cleanup timer after a timed-out runner settles', async () => {
  const nativeSetTimeout = globalThis.setTimeout;
  const nativeClearTimeout = globalThis.clearTimeout;
  const cleared = [];
  let nextTimer = 0;
  try {
    globalThis.setTimeout = (callback, delay) => {
      const id = { id: ++nextTimer, delay };
      queueMicrotask(callback);
      return id;
    };
    globalThis.clearTimeout = id => { cleared.push(id); };
    await runBatch({
      entries: normalizeUrlList('https://timer.example.test/').entries,
      batchAuditId: 'batch-cleanup-timer',
      runner: options => new Promise(resolve => options.signal.addEventListener('abort', () => resolve(
        rawChild({ auditId: options.idFactory(), url: options.url, status: 'cancelled', now: options.now }),
      ), { once: true })),
      chromeAdapter: { async emitProgress() {}, async handoffReport() { return { reviewUrl: null }; } },
      now: clock(), reportOptions: REPORT_OPTIONS, pageTimeoutMs: 5, cleanupTimeoutMs: 50,
    });
    assert.ok(cleared.some(timer => timer?.delay === 50));
  } finally {
    globalThis.setTimeout = nativeSetTimeout;
    globalThis.clearTimeout = nativeClearTimeout;
  }
});
