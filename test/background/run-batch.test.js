import assert from 'node:assert/strict';
import test from 'node:test';

import { runBatch } from '../../src/background/run-batch.js';
import { runAudit } from '../../src/background/run-audit.js';
import { normalizeUrlList } from '../../src/core/batch/normalize-url-list.js';
import { reportInput } from '../report/helpers.js';
import { AXE_PROVENANCE } from '../../src/browser/axe-adapter.js';
import { enrichAuditForReport } from '../../src/core/report/enrich-audit.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

const REPORT_OPTIONS = Object.freeze({
  timezone: 'America/Cuiaba', manifestVersion: '0.1.0',
  rulesVersion: '1.0.0', browserVersion: 'Chrome/151.0.0.0',
});

function rawChild({ auditId, url, status = 'complete' }) {
  const value = reportInput({
    auditId,
    requestedUrl: url,
    finalUrl: `${new URL(url).origin}/final?session=REMOVE&view=public`,
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
    return rawChild({ auditId: options.idFactory(), url: options.url });
  };
  const chromeAdapter = {
    async emitProgress(message) { progress.push(message); },
    async handoffReport(model) {
      parentHandoffs += 1;
      assert.equal(model.schemaVersion, 2);
      assert.equal(model.pages.length, 3);
      return { reviewUrl: `chrome-extension://test/src/review/index.html?auditId=${model.auditId}` };
    },
  };

  const model = await runBatch({
    entries: normalized.entries, batchAuditId: 'batch-sequential', runner, chromeAdapter,
    now: clock(), reportOptions: REPORT_OPTIONS, pageTimeoutMs: 1_000, cleanupTimeoutMs: 100,
  });

  assert.equal(maxActive, 1);
  assert.deepEqual(starts, normalized.entries.map(entry => entry.navigationUrl));
  assert.equal(argumentsSeen.every(value => value.closeAuditTab === true), true);
  assert.deepEqual(argumentsSeen.map(value => value.idFactory()), [
    'batch-sequential:page-1', 'batch-sequential:page-2', 'batch-sequential:page-3',
  ]);
  assert.equal(parentHandoffs, 1);
  assert.deepEqual(model.pages.map(page => page.status), ['complete', 'failed', 'complete']);
  assert.equal(model.session.status, 'partial');
  assert.equal(model.pages.length, 3, 'redirects ou links descobertos nunca criam uma quarta página');
  assert.match(model.report.reviewUrl, /^chrome-extension:\/\/test\//u);
  assert.doesNotMatch(JSON.stringify(model), /SECRET_ONE|PRIVATE_THROW_DETAILS|child-private-message|token=|session=/u);
  assert.ok(progress.length > 0);
  assert.ok(progress.every((entry, index) => index === 0 || entry.percent >= progress[index - 1].percent));
  assert.ok(progress.every(entry => entry.auditId === 'batch-sequential' && entry.sessionId === 'batch-sequential'));
  assert.ok(progress.every(entry => entry.statusCounts && Number.isSafeInteger(entry.statusCounts.complete)));
  assert.match(progress.find(entry => entry.pageNumber === 3)?.message ?? '', /3 de 3/iu);
});

test('enters an explicit non-cancellable finalization boundary before aggregate handoff', async () => {
  const events = [];
  const entries = normalizeUrlList('https://boundary.example.test/').entries;
  await runBatch({
    entries, batchAuditId: 'batch-boundary',
    runner: async options => {
      events.push('child');
      return rawChild({ auditId: options.idFactory(), url: options.url });
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
    runner: async options => rawChild({ auditId: options.idFactory(), url: options.url }),
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
    format: 'simplified-v1', document: { url, title: 'Fixture', language: 'pt-BR' }, warnings: [],
    coverage: { runtime: { outcome: 'complete' }, accessibility: { outcome: 'complete' } },
    layoutMetrics: { cssContentSize: { width: 800, height: 600 }, cssLayoutViewport: { clientWidth: 800, clientHeight: 600 } },
    nodes: [], axTree: { nodes: [] },
  });
  const adapter = {
    async createTab() { nextTabId += 1; return { id: nextTabId }; },
    async navigateTab(id, url) { urlByTab.set(id, url); currentUrl = url; order.push(url); },
    async waitForStable(id) {
      if (urlByTab.get(id).includes('fixture-fail')) throw new Error('controlled fixture failure');
      return { url: urlByTab.get(id) };
    },
    async connectCdp() { return { async command(method) { return method === 'Page.captureScreenshot' ? { data: PNG } : method === 'Page.getLayoutMetrics' ? page('').layoutMetrics : {}; }, async disconnect() {} }; },
    async runAxeInTab() { return {
      status: 'complete', provenance: AXE_PROVENANCE, diagnostics: [], frames: [{ frameId: 0, status: 'success', result: {
        violations: [{ id: 'custom-batch-fixture', impact: 'minor', nodes: [{ impact: 'minor', target: ['html'] }] }],
        incomplete: [], passes: [], inapplicable: [],
      } }],
    }; },
    async collectPage() { return page(currentUrl); },
    async runDynamicProbes() { return { focus: { completed: true, events: [] }, warnings: [], actions: [] }; },
    async getEnvironment() { return { chromeVersion: 'Chrome/152', viewport: { width: 800, height: 600, deviceScaleFactor: 1 } }; },
    async getFinalUrl() { return currentUrl; },
    async emitProgress() {},
    async handoffReport(model) { finalHandoffs += 1; return { reviewUrl: `chrome-extension://test/src/review/index.html?auditId=${model.auditId}` }; },
    async removeTab(id) { removed.push(id); },
  };
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
  assert.ok(model.axePages.flatMap(value => value.result.occurrences).every(value => /^occurrence-axe-[a-f0-9]{32}$/u.test(value.occurrenceId)));
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
  assert.match(model.ruleResults.find(value => value.ruleId === 'axe.custom-batch-fixture').summary,
    /2 de 3 páginas.*falha confirmada/iu);
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
          resolve(rawChild({ auditId: options.idFactory(), url: options.url, status: 'cancelled' }));
        }, 5);
      }, { once: true }));
    }
    active -= 1;
    order.push('finish:next');
    return Promise.resolve(rawChild({ auditId: options.idFactory(), url: options.url }));
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
    if (calls === 1) return Promise.resolve(rawChild({ auditId: options.idFactory(), url: options.url }));
    return new Promise(resolve => {
      setTimeout(() => controller.abort(new DOMException('Cancelado pelo usuário.', 'AbortError')), 2);
      options.signal.addEventListener('abort', () => resolve(rawChild({
        auditId: options.idFactory(), url: options.url, status: 'cancelled',
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
