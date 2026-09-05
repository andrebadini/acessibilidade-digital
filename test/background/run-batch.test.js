import assert from 'node:assert/strict';
import test from 'node:test';

import { createBatchExecutionRunner, runBatch } from '../../src/background/run-batch.js';
import { runAudit } from '../../src/background/run-audit.js';
import { normalizeUrlList } from '../../src/core/batch/normalize-url-list.js';
import { reportInput } from '../report/helpers.js';
import { AXE_PROVENANCE } from '../../src/browser/axe-adapter.js';
import { enrichAuditForReport } from '../../src/core/report/enrich-audit.js';
import { AUDIT_EXECUTION_INTERNAL } from '../../src/background/chrome-adapter.js';
import { createCapturePolicyV1 } from '../../src/core/privacy/capture-policy.js';
import { createInstalledCoreRuleInventory } from '../../src/core/rules/core-rule-inventory.js';

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

test('passes onCheckpoint and cleanupMode always to every child execution', async () => {
  const entries = normalizeUrlList('https://one.example.test/\nhttps://two.example.test/').entries;
  const childContracts = [];
  const model = await runBatch({
    entries,
    batchAuditId: 'batch-child-checkpoints',
    runner: async options => {
      childContracts.push({
        pageId: options.pageId,
        cleanupMode: options.cleanupMode,
        onCheckpoint: options.onCheckpoint,
      });
      return rawChild({ auditId: options.idFactory(), url: options.url, now: options.now });
    },
    chromeAdapter: {
      async emitProgress() {},
      async handoffReport() { return { reviewUrl: null }; },
    },
    now: clock(),
    reportOptions: REPORT_OPTIONS,
  });

  assert.deepEqual(childContracts.map(value => ({
    pageId: value.pageId,
    cleanupMode: value.cleanupMode,
    checkpointCallable: typeof value.onCheckpoint === 'function',
  })), [
    { pageId: 'page-1', cleanupMode: 'always', checkpointCallable: true },
    { pageId: 'page-2', cleanupMode: 'always', checkpointCallable: true },
  ]);
  assert.deepEqual(model.pages.map(page => page.status), ['complete', 'complete']);
});

test('accepts only a locally branded batch execution runner for cleanup and checkpoint evidence', async () => {
  const entries = normalizeUrlList('https://one.example.test/\nhttps://two.example.test/').entries;
  const inventory = await createInstalledCoreRuleInventory();
  const executionCheckpoints = [];
  const runner = createBatchExecutionRunner(async options => {
    const auditId = options.idFactory();
    const model = await enrichAuditForReport(rawChild({ auditId, url: options.url, now: options.now }), {
      ...REPORT_OPTIONS,
      now: options.now,
    });
    return Object.freeze({
      model,
      checkpoint: Object.freeze({
        version: 1,
        auditId: 'batch-branded-execution',
        pages: [Object.freeze({
          pageId: options.pageId,
          attempted: true,
          startedAt: model.pages[0].timestamps.startedAt,
          rulesVersion: inventory.rulesVersion,
          inventoryVersion: inventory.inventoryVersion,
          inventoryHash: inventory.sha256,
          outcomes: [],
        })],
      }),
      ownershipState: 'removed',
    });
  });

  const model = await runBatch({
    entries,
    batchAuditId: 'batch-branded-execution',
    runner,
    chromeAdapter: {
      async emitProgress() {},
      async handoffReport() { return { reviewUrl: null }; },
    },
    now: clock(),
    reportOptions: REPORT_OPTIONS,
    onExecutionCheckpoint: async checkpoint => executionCheckpoints.push(checkpoint),
  });

  assert.equal(Object.isFrozen(runner), true);
  assert.deepEqual(model.pages.map(page => page.status), ['complete', 'complete']);
  assert.deepEqual(executionCheckpoints.at(-1).pages.map(page => page.pageId), ['page-1', 'page-2']);
});

test('restart seeds completed child pages and never invokes their runner again', async () => {
  const batchAuditId = 'batch-restart-seed';
  const entries = normalizeUrlList('https://one.example.test/\nhttps://two.example.test/').entries;
  const inventory = await createInstalledCoreRuleInventory();
  const now = clock();
  const firstChild = await enrichAuditForReport(rawChild({
    auditId: `${batchAuditId}:page-1`, url: entries[0].navigationUrl, now,
  }), { ...REPORT_OPTIONS, now });
  const firstCheckpoint = Object.freeze({
    version: 1,
    auditId: `${batchAuditId}:page-1`,
    pages: [Object.freeze({
      pageId: 'page-1', attempted: true,
      startedAt: firstChild.pages[0].timestamps.startedAt,
      rulesVersion: inventory.rulesVersion,
      inventoryVersion: inventory.inventoryVersion,
      inventoryHash: inventory.sha256,
      outcomes: [],
    })],
  });
  const calls = [];
  const runner = createBatchExecutionRunner(async options => {
    calls.push(options.pageId);
    const childAuditId = options.idFactory();
    const model = await enrichAuditForReport(rawChild({
      auditId: childAuditId, url: options.url, now: options.now,
    }), { ...REPORT_OPTIONS, now: options.now });
    const childCheckpoint = Object.freeze({
      version: 1,
      auditId: childAuditId,
      pages: [Object.freeze({
        pageId: 'page-1', attempted: true,
        startedAt: model.pages[0].timestamps.startedAt,
        rulesVersion: inventory.rulesVersion,
        inventoryVersion: inventory.inventoryVersion,
        inventoryHash: inventory.sha256,
        outcomes: [],
      })],
    });
    await options.onCheckpoint(Object.freeze({
      version: 1, auditId: batchAuditId,
      pages: [Object.freeze({ ...childCheckpoint.pages[0], pageId: options.pageId })],
    }));
    return Object.freeze({
      model,
      checkpoint: Object.freeze({
        version: 1, auditId: batchAuditId,
        pages: [Object.freeze({ ...childCheckpoint.pages[0], pageId: options.pageId })],
      }),
      ownershipState: 'removed',
    });
  });
  const executionCheckpoints = [];

  const model = await runBatch({
    entries, batchAuditId, runner,
    completedPages: [Object.freeze({
      pageId: 'page-1', model: firstChild, checkpoint: firstCheckpoint,
    })],
    chromeAdapter: {
      async emitProgress() {},
      async handoffReport() { return { reviewUrl: null }; },
      tryEnterFinalization() { return true; },
    },
    now,
    reportOptions: REPORT_OPTIONS,
    onExecutionCheckpoint: async value => executionCheckpoints.push(value),
  });

  assert.deepEqual(calls, ['page-2']);
  assert.deepEqual(model.pages.map(page => page.pageId), ['page-1', 'page-2']);
  assert.deepEqual(executionCheckpoints.at(-1).pages.map(page => page.pageId), ['page-1', 'page-2']);
  assert.doesNotMatch(JSON.stringify(model), /token=|session=/u);
});

test('restart restores a factual pre-observation failure and still generates the consolidated report', async () => {
  const batchAuditId = 'batch-restart-pre-observation';
  const entries = normalizeUrlList([
    'https://one.example.test/private?token=REMOVE',
    'https://two.example.test/',
  ].join('\n')).entries;
  const inventory = await createInstalledCoreRuleInventory();
  const failureStartedAt = '2026-08-28T12:00:00.000Z';
  const failureEndedAt = '2026-08-28T12:00:01.000Z';
  const firstCheckpoint = Object.freeze({
    version: 1,
    auditId: `${batchAuditId}:page-1`,
    pages: [Object.freeze({
      pageId: 'page-1', attempted: true, startedAt: failureStartedAt,
      rulesVersion: inventory.rulesVersion,
      inventoryVersion: inventory.inventoryVersion,
      inventoryHash: inventory.sha256,
      outcomes: [],
    })],
  });
  const calls = [];
  const runner = createBatchExecutionRunner(async options => {
    calls.push(options.pageId);
    const childAuditId = options.idFactory();
    const model = await enrichAuditForReport(rawChild({
      auditId: childAuditId, url: options.url, now: options.now,
    }), { ...REPORT_OPTIONS, now: options.now });
    const checkpoint = Object.freeze({
      version: 1,
      auditId: batchAuditId,
      pages: [Object.freeze({
        pageId: options.pageId, attempted: true,
        startedAt: model.pages[0].timestamps.startedAt,
        rulesVersion: inventory.rulesVersion,
        inventoryVersion: inventory.inventoryVersion,
        inventoryHash: inventory.sha256,
        outcomes: [],
      })],
    });
    await options.onCheckpoint(checkpoint);
    return Object.freeze({ model, failure: null, checkpoint, ownershipState: 'removed' });
  });

  const model = await runBatch({
    entries,
    batchAuditId,
    batchStartedAt: '2026-08-28T11:59:59.000Z',
    runner,
    completedPages: [Object.freeze({
      pageId: 'page-1',
      model: null,
      failure: Object.freeze({
        version: 1,
        kind: 'pre-observation-failure',
        attempted: true,
        startedAt: failureStartedAt,
        endedAt: failureEndedAt,
        urlEvidence: entries[0].evidenceUrl,
      }),
      checkpoint: firstCheckpoint,
    })],
    chromeAdapter: {
      async emitProgress() {},
      async handoffReport() { return { reviewUrl: null }; },
      tryEnterFinalization() { return true; },
    },
    now: clock(),
    reportOptions: REPORT_OPTIONS,
    async onExecutionCheckpoint() {},
  });

  assert.deepEqual(calls, ['page-2']);
  assert.deepEqual(model.pages.map(page => page.status), ['failed', 'complete']);
  assert.equal(model.pages[0].diagnostics[0].code, 'BATCH_PAGE_FAILED');
  assert.equal(model.session.status, 'partial');
  assert.doesNotMatch(JSON.stringify(model), /REMOVE|token=/u);
});

test('restart preserves the durable batch start when the retained first page began before the new worker clock', async () => {
  const entries = normalizeUrlList([
    'https://one.example.test/',
    'https://two.example.test/',
  ].join('\n')).entries;
  const durableBatchStartedAt = '2026-08-28T11:59:59.000Z';
  const restartedClock = (() => {
    let tick = 0;
    return () => new Date(Date.UTC(2026, 7, 28, 12, 5, tick++)).toISOString();
  })();
  let pageIndex = 0;

  const model = await runBatch({
    entries,
    batchAuditId: 'batch-restart-first-page-clock',
    batchStartedAt: durableBatchStartedAt,
    runner: async options => {
      const offset = pageIndex * 2;
      pageIndex += 1;
      let localTick = 0;
      return rawChild({
        auditId: options.idFactory(),
        url: options.url,
        now: () => new Date(Date.UTC(2026, 7, 28, 12, 0, offset + localTick++)).toISOString(),
      });
    },
    chromeAdapter: {
      async emitProgress() {},
      async handoffReport() { return { reviewUrl: null }; },
    },
    now: restartedClock,
    reportOptions: REPORT_OPTIONS,
  });

  assert.equal(model.timestamps.startedAt, durableBatchStartedAt);
  assert.equal(model.pages.every(page => page.timestamps.startedAt >= model.timestamps.startedAt), true);
  assert.deepEqual(model.pages.map(page => page.status), ['complete', 'complete']);
});

test('allows a branded token runner to process query-distinct pages with the same sanitized URL', async () => {
  const first = structuredClone(normalizeUrlList('https://example.test/item').entries[0]);
  const entries = [first, { ...structuredClone(first), line: 2 }];
  const inventory = await createInstalledCoreRuleInventory();
  const calls = [];
  const runner = createBatchExecutionRunner(async options => {
    calls.push(options.pageId);
    const auditId = options.idFactory();
    const model = await enrichAuditForReport(rawChild({ auditId, url: options.url, now: options.now }), {
      ...REPORT_OPTIONS, now: options.now,
    });
    const checkpoint = Object.freeze({
      version: 1,
      auditId: 'batch-query-distinct',
      pages: [Object.freeze({
        pageId: options.pageId, attempted: true,
        startedAt: model.pages[0].timestamps.startedAt,
        rulesVersion: inventory.rulesVersion,
        inventoryVersion: inventory.inventoryVersion,
        inventoryHash: inventory.sha256,
        outcomes: [],
      })],
    });
    await options.onCheckpoint(checkpoint);
    return Object.freeze({ model, checkpoint, ownershipState: 'removed' });
  });

  const model = await runBatch({
    entries, batchAuditId: 'batch-query-distinct', runner,
    chromeAdapter: { async emitProgress() {}, async handoffReport() { return { reviewUrl: null }; } },
    now: clock(), reportOptions: REPORT_OPTIONS,
    async onExecutionCheckpoint() {},
  });

  assert.deepEqual(calls, ['page-1', 'page-2']);
  assert.deepEqual(model.pages.map(page => page.pageId), ['page-1', 'page-2']);
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
  assert.equal(childModels.length, 2, 'falha pré-observação não fabrica um modelo filho');
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

function timedDefaultAdapter({ removalFails = false, settleDelayMs = 3, settleImmediately = false } = {}) {
  const values = {};
  const events = [];
  let nextTab = 80;
  let randomValue = 40;
  const adapter = {
    events,
    async createTab() { const tab = { id: nextTab++, windowId: 9 }; events.push(`create:${tab.id}`); return tab; },
    async navigateTab(id) { events.push(`navigate:${id}`); },
    async waitForStable(id, { signal }) {
      if (settleImmediately) throw new Error('CONTROLLED_IMMEDIATE_PAGE_FAILURE');
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

function cancelledDefaultAdapter({ removalFails = true, settlesAfterAbort = true } = {}) {
  const values = {};
  const events = [];
  let randomValue = 60;
  const adapter = {
    events,
    async createTab() { events.push('create'); return { id: 95, windowId: 9 }; },
    async navigateTab() { events.push('navigate'); },
    async waitForStable(_id, { signal }) {
      events.push('wait');
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
        events.push('abort');
        if (settlesAfterAbort) reject(signal.reason);
      }, { once: true }));
    },
    async probeDocumentIdentity() { throw new Error('must-not-probe'); },
    async removeTab() {
      events.push('remove');
      if (removalFails) throw new Error('PRIVATE_REMOVE_FAILURE');
    },
    async emitProgress() {},
    tryEnterFinalization() { return true; },
    async handoffReport() { return { reviewUrl: null }; },
  };
  Object.defineProperty(adapter, AUDIT_EXECUTION_INTERNAL, {
    enumerable: false,
    value: Object.freeze({
      sessionArea: {
        async get(key) { return Object.hasOwn(values, key) ? { [key]: structuredClone(values[key]) } : {}; },
        async set(entries) { Object.assign(values, structuredClone(entries)); },
        async remove(key) { delete values[key]; },
      },
      randomBytes(length) { return new Uint8Array(length).fill(++randomValue); },
      epochNow: () => 1_788_000_000_000,
    }),
  });
  return adapter;
}

function postObservationCancellationAdapter({ controller, removalFails = false }) {
  const values = {};
  const events = [];
  let randomValue = 70;
  let currentUrl = 'https://cancel-after-observation.example.test/';
  const page = () => ({
    format: 'simplified-v1',
    document: { url: currentUrl, title: 'Página em cancelamento', language: 'pt-BR' },
    coverage: { runtime: { outcome: 'complete' }, accessibility: { outcome: 'complete' } },
    warnings: [],
    layoutMetrics: {
      cssContentSize: { width: 800, height: 600 },
      cssLayoutViewport: { clientWidth: 800, clientHeight: 600 },
    },
    nodes: [], axTree: { nodes: [] },
  });
  const adapter = {
    events,
    async createTab() { events.push('create'); return { id: 96, windowId: 9 }; },
    async navigateTab(_id, url) { currentUrl = url; events.push('navigate'); },
    async waitForStable() { events.push('wait'); return { url: currentUrl }; },
    async probeDocumentIdentity(tabId) {
      events.push('probe');
      return { tabId, windowId: 9, documentId: 'document-a', urlSessionDigest: `hmac-sha256:${'A'.repeat(43)}` };
    },
    async getEvidenceUrl() { return currentUrl; },
    async connectCdp() {
      events.push('connect');
      return {
        async command(method) { return method === 'Page.getLayoutMetrics' ? page().layoutMetrics : {}; },
        async disconnect() { events.push('disconnect'); },
      };
    },
    async runAxeInTab() {
      return { status: 'disabled', provenance: AXE_PROVENANCE, frames: [], diagnostics: [{ code: 'AXE_FEATURE_DISABLED', frameId: null }] };
    },
    async collectPage() {
      events.push('collect');
      controller.abort(new DOMException('PRIVATE_POST_OBSERVATION_ABORT', 'AbortError'));
      return page();
    },
    async getEnvironment() {
      return { chromeVersion: 'Chrome/151.0.0.0', viewport: { width: 800, height: 600, deviceScaleFactor: 1 } };
    },
    async removeTab() {
      events.push('remove');
      if (removalFails) throw new Error('PRIVATE_REMOVE_FAILURE');
    },
    async emitProgress() {},
    tryEnterFinalization() { return true; },
    async handoffReport() { return { reviewUrl: null }; },
  };
  Object.defineProperty(adapter, AUDIT_EXECUTION_INTERNAL, {
    enumerable: false,
    value: Object.freeze({
      sessionArea: {
        async get(key) { return Object.hasOwn(values, key) ? { [key]: structuredClone(values[key]) } : {}; },
        async set(entries) { Object.assign(values, structuredClone(entries)); },
        async remove(key) { delete values[key]; },
      },
      randomBytes(length) { return new Uint8Array(length).fill(++randomValue); },
      epochNow: () => 1_788_000_000_000,
    }),
  });
  return adapter;
}

function canonicalCleanupBoundaryAdapter({ removalFails = false, onFinalization = null, finalizationResult = true } = {}) {
  const values = {};
  const events = [];
  let nextTab = 100;
  let randomValue = 90;
  const adapter = {
    events,
    async createTab() {
      const tab = { id: nextTab++, windowId: 9 };
      events.push(`create:${tab.id}`);
      return tab;
    },
    async navigateTab(id) { events.push(`navigate:${id}`); },
    async waitForStable(id) {
      events.push(`wait:${id}`);
      throw new Error('CONTROLLED_PRE_OBSERVATION_FAILURE');
    },
    async probeDocumentIdentity() { throw new Error('must-not-probe'); },
    async getEvidenceUrl() { throw new Error('must-not-read-evidence'); },
    async removeTab(id) {
      events.push(`remove:${id}`);
      if (removalFails) throw new Error('CONTROLLED_REMOVE_FAILURE');
    },
    async emitProgress() {},
    tryEnterFinalization() { onFinalization?.(); return finalizationResult; },
    async handoffReport() { return { reviewUrl: null }; },
  };
  const internal = Object.assign(Object.create(null), {
    sessionArea: {
      async get(key) { return Object.hasOwn(values, key) ? { [key]: structuredClone(values[key]) } : {}; },
      async set(entries) { Object.assign(values, structuredClone(entries)); },
      async remove(key) { delete values[key]; },
    },
    randomBytes(length) { return new Uint8Array(length).fill(++randomValue); },
    capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
  });
  Object.defineProperty(adapter, AUDIT_EXECUTION_INTERNAL, {
    enumerable: false,
    value: Object.freeze(internal),
  });
  return adapter;
}

function rejectedPostObservationCleanupAdapter() {
  const values = {};
  const events = [];
  let randomValue = 110;
  let proofCount = 0;
  let storageUnavailable = false;
  const adapter = {
    events,
    async createTab() {
      events.push('create');
      return { id: 120, windowId: 9 };
    },
    async navigateTab() { events.push('navigate'); },
    async waitForStable() { events.push('wait'); return { url: 'https://example.test/final' }; },
    async probeDocumentIdentity(tabId) {
      proofCount += 1;
      const changed = proofCount >= 2;
      return {
        tabId, windowId: 9,
        documentId: changed ? 'document-b' : 'document-a',
        urlSessionDigest: `hmac-sha256:${(changed ? 'B' : 'A').repeat(43)}`,
      };
    },
    async getEvidenceUrl() {
      return {
        version: 'EvidenceUrlV1', href: 'https://example.test/final',
        queryIncluded: false, redactedSegments: 0,
      };
    },
    async getFinalUrl() { return 'https://example.test/final'; },
    async removeTab() {
      events.push('remove');
      storageUnavailable = true;
      throw new Error('PRIVATE_REMOVE_FAILURE');
    },
    async emitProgress() {},
    tryEnterFinalization() { return true; },
    async handoffReport() { return { reviewUrl: null }; },
  };
  Object.defineProperty(adapter, AUDIT_EXECUTION_INTERNAL, {
    enumerable: false,
    value: Object.freeze({
      sessionArea: {
        async get(key) {
          if (storageUnavailable) throw new Error('PRIVATE_READBACK_FAILURE');
          return Object.hasOwn(values, key) ? { [key]: structuredClone(values[key]) } : {};
        },
        async set(entries) { Object.assign(values, structuredClone(entries)); },
        async remove(key) { delete values[key]; },
      },
      randomBytes(length) { return new Uint8Array(length).fill(++randomValue); },
    }),
  });
  return adapter;
}

test('advances after removed ownership but stops the next page after cleanup-pending', async t => {
  for (const scenario of [
    { name: 'removed', removalFails: false, creates: 2, attempted: [true, true] },
    { name: 'cleanup-pending', removalFails: true, creates: 1, attempted: [true, false] },
  ]) await t.test(scenario.name, async () => {
    const adapter = canonicalCleanupBoundaryAdapter({ removalFails: scenario.removalFails });
    const model = await runBatch({
      entries: normalizeUrlList('https://one.example.test/\nhttps://two.example.test/').entries,
      batchAuditId: `batch-boundary-${scenario.name}`,
      chromeAdapter: adapter,
      now: clock(),
      reportOptions: REPORT_OPTIONS,
      pageTimeoutMs: 1_000,
      cleanupTimeoutMs: 1_000,
    });

    assert.equal(adapter.events.filter(event => event.startsWith('create:')).length, scenario.creates);
    assert.deepEqual(model.pages.map(page => page.attempted), scenario.attempted);
    if (scenario.name === 'cleanup-pending') {
      assert.match(model.pages[1].diagnostics[0].code, /CLEANUP_UNCONFIRMED/u);
    }
  });
});

test('default batch stops after a rejected observed execution whose cleanup cannot be proven', async () => {
  const adapter = rejectedPostObservationCleanupAdapter();
  const model = await runBatch({
    entries: normalizeUrlList('https://one.example.test/\nhttps://must-not-start.example.test/').entries,
    batchAuditId: 'batch-rejected-cleanup-unknown',
    chromeAdapter: adapter,
    now: clock(),
    reportOptions: REPORT_OPTIONS,
    pageTimeoutMs: 1_000,
    cleanupTimeoutMs: 1_000,
  });

  assert.equal(adapter.events.filter(event => event === 'create').length, 1);
  assert.deepEqual(model.pages.map(page => page.attempted), [true, false]);
  assert.match(model.pages[0].diagnostics[0].code, /CLEANUP_UNCONFIRMED/u);
  assert.match(model.pages[1].diagnostics[0].code, /CLEANUP_UNCONFIRMED/u);
  assert.doesNotMatch(JSON.stringify(model), /PRIVATE_REMOVE|PRIVATE_READBACK/u);
});

test('default cancellation preserves cleanup-pending and blocks the remaining pages', async () => {
  const controller = new AbortController();
  const adapter = cancelledDefaultAdapter();
  const executionCheckpoints = [];
  const running = runBatch({
    entries: normalizeUrlList('https://cancel.example.test/\nhttps://must-not-start.example.test/').entries,
    batchAuditId: 'batch-cancel-cleanup-pending',
    chromeAdapter: adapter,
    signal: controller.signal,
    now: clock(),
    reportOptions: REPORT_OPTIONS,
    pageTimeoutMs: 1_000,
    cleanupTimeoutMs: 1_000,
    onExecutionCheckpoint: async value => executionCheckpoints.push(value),
  });
  while (!adapter.events.includes('wait')) await new Promise(resolve => setImmediate(resolve));
  controller.abort(new DOMException('PRIVATE_EXTERNAL_ABORT', 'AbortError'));

  const model = await running;

  assert.equal(adapter.events.filter(event => event === 'create').length, 1);
  assert.deepEqual(model.pages.map(page => [page.status, page.attempted]), [
    ['failed', true], ['failed', false],
  ]);
  assert.equal(model.pages[0].diagnostics[0].code, 'BATCH_PAGE_CLEANUP_UNCONFIRMED');
  assert.equal(model.pages[1].diagnostics[0].code, 'BATCH_NOT_STARTED_CLEANUP_UNCONFIRMED');
  assert.deepEqual(executionCheckpoints.at(-1)?.pages.map(page => page.pageId), ['page-1']);
  assert.equal(model.session.status, 'failed');
  assert.doesNotMatch(JSON.stringify(model), /BATCH_CANCELLED|PRIVATE_EXTERNAL_ABORT|PRIVATE_REMOVE_FAILURE/u);
});

test('default cancellation is clean only after the child confirms removed ownership', async () => {
  const controller = new AbortController();
  const adapter = cancelledDefaultAdapter({ removalFails: false });
  const running = runBatch({
    entries: normalizeUrlList('https://cancel-clean.example.test/\nhttps://not-started.example.test/').entries,
    batchAuditId: 'batch-cancel-clean-removed',
    chromeAdapter: adapter,
    signal: controller.signal,
    now: clock(),
    reportOptions: REPORT_OPTIONS,
    pageTimeoutMs: 1_000,
    cleanupTimeoutMs: 1_000,
  });
  while (!adapter.events.includes('wait')) await new Promise(resolve => setImmediate(resolve));
  controller.abort(new DOMException('PRIVATE_CLEAN_ABORT', 'AbortError'));

  const model = await running;

  assert.deepEqual(model.pages.map(page => [page.status, page.attempted]), [
    ['cancelled', true], ['cancelled', false],
  ]);
  assert.equal(adapter.events.includes('remove'), true);
  assert.equal(model.session.status, 'cancelled');
  assert.doesNotMatch(JSON.stringify(model), /PRIVATE_CLEAN_ABORT/u);
});

test('default cancellation after observation preserves the factual V2 cleanup outcome', async t => {
  for (const scenario of [
    { name: 'removed', removalFails: false, statuses: ['cancelled', 'cancelled'], session: 'cancelled' },
    { name: 'cleanup-pending', removalFails: true, statuses: ['failed', 'failed'], session: 'failed' },
  ]) await t.test(scenario.name, async () => {
    const controller = new AbortController();
    const adapter = postObservationCancellationAdapter({ controller, removalFails: scenario.removalFails });
    const checkpoints = [];
    const model = await runBatch({
      entries: normalizeUrlList([
        'https://cancel-after-observation.example.test/?secret=REMOVE',
        'https://must-not-start.example.test/',
      ].join('\n')).entries,
      batchAuditId: `batch-post-observation-${scenario.name}`,
      chromeAdapter: adapter,
      signal: controller.signal,
      now: clock(),
      reportOptions: REPORT_OPTIONS,
      pageTimeoutMs: 1_000,
      cleanupTimeoutMs: 1_000,
      onExecutionCheckpoint: async value => checkpoints.push(value),
    });

    assert.equal(adapter.events.filter(event => event === 'create').length, 1);
    assert.deepEqual(model.pages.map(page => page.status), scenario.statuses);
    assert.equal(model.session.status, scenario.session);
    assert.deepEqual(checkpoints.at(-1)?.pages.map(page => page.pageId), ['page-1']);
    if (scenario.removalFails) {
      assert.equal(model.pages[0].diagnostics[0].code, 'BATCH_PAGE_CLEANUP_UNCONFIRMED');
      assert.equal(model.pages[1].diagnostics[0].code, 'BATCH_NOT_STARTED_CLEANUP_UNCONFIRMED');
    }
    assert.doesNotMatch(JSON.stringify(model), /PRIVATE_POST_OBSERVATION_ABORT|PRIVATE_REMOVE_FAILURE|REMOVE/u);
  });
});

test('cleanup-unconfirmed wins when a cancelled default child never settles', async () => {
  const controller = new AbortController();
  const adapter = cancelledDefaultAdapter({ settlesAfterAbort: false });
  const running = runBatch({
    entries: normalizeUrlList('https://cancel-hung.example.test/\nhttps://must-not-start.example.test/').entries,
    batchAuditId: 'batch-cancel-cleanup-unconfirmed',
    chromeAdapter: adapter,
    signal: controller.signal,
    now: clock(),
    reportOptions: REPORT_OPTIONS,
    pageTimeoutMs: 1_000,
    cleanupTimeoutMs: 5,
  });
  while (!adapter.events.includes('wait')) await new Promise(resolve => setImmediate(resolve));
  controller.abort(new DOMException('PRIVATE_HUNG_ABORT', 'AbortError'));

  const model = await running;

  assert.deepEqual(model.pages.map(page => [page.status, page.attempted]), [
    ['failed', true], ['failed', false],
  ]);
  assert.equal(model.pages[0].diagnostics[0].code, 'BATCH_PAGE_CLEANUP_UNCONFIRMED');
  assert.equal(model.pages[1].diagnostics[0].code, 'BATCH_NOT_STARTED_CLEANUP_UNCONFIRMED');
  assert.equal(adapter.events.includes('remove'), false);
  assert.equal(model.session.status, 'failed');
  assert.doesNotMatch(JSON.stringify(model), /BATCH_CANCELLED|PRIVATE_HUNG_ABORT/u);
});

test('cleanup-pending wins when cancellation fires during terminal-boundary acquisition', async () => {
  const controller = new AbortController();
  const adapter = canonicalCleanupBoundaryAdapter({
    removalFails: true,
    finalizationResult: false,
    onFinalization() {
      controller.abort(new DOMException('PRIVATE_FINALIZATION_ABORT', 'AbortError'));
    },
  });
  const model = await runBatch({
    entries: normalizeUrlList('https://pending.example.test/\nhttps://must-not-start.example.test/').entries,
    batchAuditId: 'batch-cleanup-pending-finalization-abort',
    chromeAdapter: adapter,
    signal: controller.signal,
    now: clock(),
    reportOptions: REPORT_OPTIONS,
    pageTimeoutMs: 1_000,
    cleanupTimeoutMs: 1_000,
  });

  assert.equal(adapter.events.filter(event => event.startsWith('create:')).length, 1);
  assert.deepEqual(model.pages.map(page => [page.status, page.attempted]), [
    ['failed', true], ['failed', false],
  ]);
  assert.equal(model.pages[0].diagnostics[0].code, 'BATCH_PAGE_CLEANUP_UNCONFIRMED');
  assert.equal(model.pages[1].diagnostics[0].code, 'BATCH_NOT_STARTED_CLEANUP_UNCONFIRMED');
  assert.equal(model.session.status, 'failed');
  assert.doesNotMatch(JSON.stringify(model), /BATCH_CANCELLED|PRIVATE_FINALIZATION_ABORT/u);
});

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

test('custom batch failure consumes EvidenceUrlV1 and retains only its origin in the legacy report model', async () => {
  const entries = normalizeUrlList('https://example.test/pessoa/CPF-123456789?case=7&secret=x#fragmento').entries;
  assert.equal(Object.hasOwn(entries[0], 'reportUrl'), false);
  assert.equal(entries[0].evidenceUrl.href, 'https://example.test/pessoa/:redacted-2');
  const model = await runBatch({
    entries,
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

test('captures batch entries through own data descriptors without invoking accessors', async t => {
  const baseline = structuredClone(normalizeUrlList('https://descriptors.example.test/public').entries[0]);
  const cases = ['line', 'navigationUrl', 'evidenceUrl'];

  for (const field of cases) {
    await t.test(`rejects an accessor in ${field} without reading it`, async () => {
      const marker = `PRIVATE_BATCH_${field.toUpperCase()}_GETTER`;
      let reads = 0;
      const entry = { ...baseline };
      Object.defineProperty(entry, field, {
        enumerable: true,
        configurable: true,
        get() {
          reads += 1;
          throw new Error(marker);
        },
      });

      await assert.rejects(runBatch({
        entries: [entry], batchAuditId: `batch-accessor-${field}`,
        runner() { throw new Error('RUNNER_MUST_NOT_START'); },
        chromeAdapter: {}, now: clock(), reportOptions: REPORT_OPTIONS,
      }), error => {
        assert.equal(error instanceof TypeError, true);
        assert.equal(error.message, 'Lista normalizada do lote inválida.');
        assert.doesNotMatch(error.message, new RegExp(marker));
        return true;
      });
      assert.equal(reads, 0);
    });
  }

  await t.test('rejects an accessor array slot without reading it', async () => {
    const marker = 'PRIVATE_BATCH_ARRAY_SLOT_GETTER';
    let reads = 0;
    const entries = new Array(1);
    Object.defineProperty(entries, '0', {
      enumerable: true,
      configurable: true,
      get() {
        reads += 1;
        throw new Error(marker);
      },
    });

    await assert.rejects(runBatch({
      entries, batchAuditId: 'batch-accessor-slot',
      runner() { throw new Error('RUNNER_MUST_NOT_START'); },
      chromeAdapter: {}, now: clock(), reportOptions: REPORT_OPTIONS,
    }), error => {
      assert.equal(error instanceof TypeError, true);
      assert.equal(error.message, 'Lista normalizada do lote inválida.');
      assert.doesNotMatch(error.message, new RegExp(marker));
      return true;
    });
    assert.equal(reads, 0);
  });
});

test('captures the outer batch request without invoking caller-controlled accessors', async t => {
  const normalized = normalizeUrlList('https://outer-request.example.test/public').entries;
  const baseRequest = {
    entries: normalized,
    batchAuditId: 'batch-outer-request',
    runner: async options => rawChild({ auditId: options.idFactory(), url: options.url, now: options.now }),
    chromeAdapter: { async handoffReport() { return { reviewUrl: null }; } },
    now: clock(),
    reportOptions: REPORT_OPTIONS,
  };

  for (const field of Object.keys(baseRequest)) {
    await t.test(`rejects an outer accessor in ${field} without reading it`, async () => {
      const marker = `PRIVATE_OUTER_${field.toUpperCase()}_GETTER`;
      let reads = 0;
      const request = { ...baseRequest };
      Object.defineProperty(request, field, {
        enumerable: true,
        configurable: true,
        get() {
          reads += 1;
          throw new Error(marker);
        },
      });

      await assert.rejects(runBatch(request), error => {
        assert.equal(error instanceof TypeError, true);
        assert.equal(error.message, 'Configuração do lote inválida.');
        assert.doesNotMatch(error.message, new RegExp(marker));
        return true;
      });
      assert.equal(reads, 0);
    });
  }

  await t.test('accepts a transparent outer proxy without property reads', async () => {
    let reads = 0;
    const request = new Proxy(baseRequest, {
      get() {
        reads += 1;
        throw new Error('PRIVATE_OUTER_PROXY_GET');
      },
    });
    const model = await runBatch(request);
    assert.equal(reads, 0);
    assert.equal(model.pages.length, 1);
  });

  for (const [label, request] of [
    ['descriptor proxy', new Proxy(baseRequest, {
      ownKeys() { throw new Error('PRIVATE_OUTER_PROXY_OWN_KEYS'); },
    })],
    ['revoked proxy', (() => {
      const value = Proxy.revocable(baseRequest, {});
      value.revoke();
      return value.proxy;
    })()],
  ]) {
    await t.test(`rejects an outer ${label} with the fixed public error`, async () => {
      await assert.rejects(runBatch(request), error => {
        assert.equal(error instanceof TypeError, true);
        assert.equal(error.message, 'Configuração do lote inválida.');
        assert.doesNotMatch(error.message, /PRIVATE|proxy|revoked/iu);
        return true;
      });
    });
  }
});

test('captures report options once through exact own data descriptors', async t => {
  const entries = normalizeUrlList('https://report-options.example.test/public').entries;

  for (const field of Object.keys(REPORT_OPTIONS)) {
    await t.test(`rejects a report-options accessor in ${field} without reading it`, async () => {
      const marker = `PRIVATE_REPORT_OPTIONS_${field.toUpperCase()}_GETTER`;
      let reads = 0;
      const reportOptions = { ...REPORT_OPTIONS };
      Object.defineProperty(reportOptions, field, {
        enumerable: true,
        configurable: true,
        get() {
          reads += 1;
          throw new Error(marker);
        },
      });
      let runnerCalls = 0;
      await assert.rejects(runBatch({
        entries, batchAuditId: `batch-report-options-${field}`,
        runner() { runnerCalls += 1; throw new Error('RUNNER_MUST_NOT_START'); },
        chromeAdapter: {}, now: clock(), reportOptions,
      }), error => {
        assert.equal(error instanceof TypeError, true);
        assert.equal(error.message, 'Configuração do lote inválida.');
        assert.doesNotMatch(error.message, new RegExp(marker));
        return true;
      });
      assert.equal(reads, 0);
      assert.equal(runnerCalls, 0);
    });
  }

  for (const [label, reportOptions] of [
    ['extra property', { ...REPORT_OPTIONS, privateOption: 'PRIVATE_REPORT_OPTIONS_EXTRA' }],
    ['revoked proxy', (() => {
      const value = Proxy.revocable({ ...REPORT_OPTIONS }, {});
      value.revoke();
      return value.proxy;
    })()],
  ]) {
    await t.test(`rejects report options with ${label} using the fixed public error`, async () => {
      await assert.rejects(runBatch({
        entries, batchAuditId: 'batch-report-options-invalid',
        runner() { throw new Error('RUNNER_MUST_NOT_START'); },
        chromeAdapter: {}, now: clock(), reportOptions,
      }), error => {
        assert.equal(error instanceof TypeError, true);
        assert.equal(error.message, 'Configuração do lote inválida.');
        assert.doesNotMatch(error.message, /PRIVATE|proxy|revoked/iu);
        return true;
      });
    });
  }

  await t.test('uses the frozen report-options snapshot after the runner mutates its source', async () => {
    const reportOptions = { ...REPORT_OPTIONS };
    const expected = { ...reportOptions };
    const expectedExtensionIds = [];
    const model = await runBatch({
      entries, batchAuditId: 'batch-report-options-snapshot',
      runner: async options => {
        expectedExtensionIds.push(options.expectedExtensionId);
        reportOptions.timezone = 'PRIVATE/Mutated';
        reportOptions.manifestVersion = 'PRIVATE_MUTATED_VERSION';
        reportOptions.rulesVersion = 'PRIVATE_MUTATED_RULES';
        reportOptions.browserVersion = 'PRIVATE_MUTATED_BROWSER';
        reportOptions.expectedExtensionId = 'pppppppppppppppppppppppppppppppp';
        return rawChild({ auditId: options.idFactory(), url: options.url, now: options.now });
      },
      chromeAdapter: { async handoffReport() { return { reviewUrl: null }; } },
      now: clock(), reportOptions,
    });

    assert.deepEqual(expectedExtensionIds, [expected.expectedExtensionId]);
    assert.equal(model.timezone, expected.timezone);
    assert.equal(model.versions.extension, expected.manifestVersion);
    assert.equal(model.versions.rules, expected.rulesVersion);
    assert.equal(model.versions.browser, expected.browserVersion);
    assert.doesNotMatch(JSON.stringify(model), /PRIVATE_MUTATED/u);
  });
});

test('captures transparent proxies without property reads and masks hostile proxy failures', async t => {
  const baseline = structuredClone(normalizeUrlList('https://proxy.example.test/public').entries[0]);
  let reads = 0;
  const entry = new Proxy(baseline, {
    get() {
      reads += 1;
      throw new Error('PRIVATE_BATCH_PROXY_GET');
    },
  });
  const entries = new Proxy([entry], {
    get() {
      reads += 1;
      throw new Error('PRIVATE_BATCH_ARRAY_PROXY_GET');
    },
  });
  const starts = [];
  const model = await runBatch({
    entries, batchAuditId: 'batch-transparent-proxy',
    runner: async options => {
      starts.push(options.url);
      return rawChild({ auditId: options.idFactory(), url: options.url, now: options.now });
    },
    chromeAdapter: { async handoffReport() { return { reviewUrl: null }; } },
    now: clock(), reportOptions: REPORT_OPTIONS,
  });

  assert.equal(reads, 0);
  assert.deepEqual(starts, ['https://proxy.example.test/public']);
  assert.equal(model.pages.length, 1);

  for (const [label, hostile] of [
    ['descriptor proxy', new Proxy(baseline, {
      ownKeys() { throw new Error('PRIVATE_BATCH_PROXY_OWN_KEYS'); },
    })],
    ['revoked proxy', (() => {
      const value = Proxy.revocable(baseline, {});
      value.revoke();
      return value.proxy;
    })()],
  ]) {
    await t.test(`rejects ${label} with the fixed public error`, async () => {
      await assert.rejects(runBatch({
        entries: [hostile], batchAuditId: 'batch-hostile-proxy',
        runner() { throw new Error('RUNNER_MUST_NOT_START'); },
        chromeAdapter: {}, now: clock(), reportOptions: REPORT_OPTIONS,
      }), error => {
        assert.equal(error instanceof TypeError, true);
        assert.equal(error.message, 'Lista normalizada do lote inválida.');
        assert.doesNotMatch(error.message, /PRIVATE|proxy|revoked/iu);
        return true;
      });
    });
  }
});

test('requires a dense exact and unambiguous normalized batch entry list', async t => {
  const first = structuredClone(normalizeUrlList('https://one.example.test/public').entries[0]);
  const second = structuredClone(normalizeUrlList('https://two.example.test/public').entries[0]);
  second.line = 2;
  const cases = [
    ['extra entry key', [{ ...first, extra: 'PRIVATE_EXTRA' }]],
    ['sparse array', new Array(1)],
    ['duplicate line', [first, { ...second, line: first.line }]],
    ['duplicate navigation URL', [first, {
      ...second,
      navigationUrl: first.navigationUrl,
      evidenceUrl: structuredClone(first.evidenceUrl),
    }]],
  ];

  for (const [label, entries] of cases) {
    await t.test(`rejects ${label}`, async () => {
      let runnerCalls = 0;
      await assert.rejects(runBatch({
        entries, batchAuditId: 'batch-ambiguous-input',
        runner() { runnerCalls += 1; throw new Error('RUNNER_MUST_NOT_START'); },
        chromeAdapter: {}, now: clock(), reportOptions: REPORT_OPTIONS,
      }), error => {
        assert.equal(error instanceof TypeError, true);
        assert.equal(error.message, 'Lista normalizada do lote inválida.');
        assert.doesNotMatch(error.message, /PRIVATE|RUNNER_MUST_NOT_START/iu);
        return true;
      });
      assert.equal(runnerCalls, 0);
    });
  }
});

test('uses only the captured batch copy after validation even if the caller mutates future entries', async () => {
  const entries = structuredClone(normalizeUrlList([
    'https://stable-one.example.test/public',
    'https://stable-two.example.test/public',
  ].join('\n')).entries);
  const starts = [];

  const model = await runBatch({
    entries, batchAuditId: 'batch-captured-copy',
    runner: async options => {
      starts.push(options.url);
      if (starts.length === 1) {
        entries[0].navigationUrl = 'https://mutated-first.example.test/private';
        entries[0].evidenceUrl.href = 'https://mutated-first.example.test/private';
        entries[1] = structuredClone(
          normalizeUrlList('https://mutated-future.example.test/private').entries[0],
        );
        entries.push(structuredClone(
          normalizeUrlList('https://injected.example.test/private').entries[0],
        ));
      }
      return rawChild({ auditId: options.idFactory(), url: options.url, now: options.now });
    },
    chromeAdapter: { async handoffReport() { return { reviewUrl: null }; } },
    now: clock(), reportOptions: REPORT_OPTIONS,
  });

  assert.deepEqual(starts, [
    'https://stable-one.example.test/public',
    'https://stable-two.example.test/public',
  ]);
  assert.equal(model.pages.length, 2);
  assert.doesNotMatch(JSON.stringify(model), /mutated-first|mutated-future|injected/iu);
});

async function observeWithin(promise, timeoutMs = 1_000) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(promise).then(
        value => ({ kind: 'fulfilled', value }),
        error => ({ kind: 'rejected', error }),
      ),
      new Promise(resolve => {
        timer = setTimeout(() => resolve({ kind: 'boundary-timeout' }), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test('never starts a page when cancellation wins before boundary setup or the operation microtask', async t => {
  await t.test('already aborted at the page boundary', async () => {
    const controller = new AbortController();
    const target = {};
    const chromeAdapter = new Proxy(target, {
      getOwnPropertyDescriptor(object, key) {
        if (key === AUDIT_EXECUTION_INTERNAL && !controller.signal.aborted) {
          controller.abort(new DOMException('PRIVATE_FAST_ABORT', 'AbortError'));
        }
        return Reflect.getOwnPropertyDescriptor(object, key);
      },
    });
    let runnerCalls = 0;

    const model = await runBatch({
      entries: normalizeUrlList('https://fast-abort.example.test/').entries,
      batchAuditId: 'batch-fast-abort', signal: controller.signal,
      runner() { runnerCalls += 1; throw new Error('RUNNER_MUST_NOT_START'); },
      chromeAdapter, now: clock(), reportOptions: REPORT_OPTIONS,
      pageTimeoutMs: 100, cleanupTimeoutMs: 5,
    });

    assert.equal(runnerCalls, 0);
    assert.equal(model.session.status, 'cancelled');
    assert.doesNotMatch(JSON.stringify(model), /PRIVATE_FAST_ABORT|RUNNER_MUST_NOT_START/u);
  });

  await t.test('aborted after the loop check but before the queued operation', async () => {
    const controller = new AbortController();
    let abortedReads = 0;
    const signal = new Proxy(controller.signal, {
      get(target, key) {
        if (key === 'aborted') {
          abortedReads += 1;
          const aborted = Reflect.get(target, key, target);
          if (abortedReads === 2 && !aborted) {
            queueMicrotask(() => controller.abort(new DOMException('PRIVATE_MICROTASK_ABORT', 'AbortError')));
          }
          return aborted;
        }
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    let runnerCalls = 0;

    const model = await runBatch({
      entries: normalizeUrlList('https://microtask-abort.example.test/').entries,
      batchAuditId: 'batch-microtask-abort', signal,
      runner() { runnerCalls += 1; throw new Error('RUNNER_MUST_NOT_START'); },
      chromeAdapter: {}, now: clock(), reportOptions: REPORT_OPTIONS,
      pageTimeoutMs: 100, cleanupTimeoutMs: 5,
    });

    assert.equal(runnerCalls, 0);
    assert.equal(model.session.status, 'cancelled');
    assert.doesNotMatch(JSON.stringify(model), /PRIVATE_MICROTASK_ABORT|RUNNER_MUST_NOT_START/u);
  });
});

test('bounds controlling checkpoint callbacks with one fixed public failure', async t => {
  const assertPublicCheckpointFailure = outcome => {
    assert.equal(outcome.kind, 'rejected');
    assert.equal(outcome.error instanceof Error, true);
    assert.equal(outcome.error.message, 'O checkpoint do lote não pôde ser persistido.');
    assert.doesNotMatch(outcome.error.message, /PRIVATE|timeout|proxy|revoked/iu);
  };

  await t.test('onCheckpoint timeout', async () => {
    const outcome = await observeWithin(runBatch({
      entries: normalizeUrlList('https://checkpoint-timeout.example.test/').entries,
      batchAuditId: 'batch-checkpoint-timeout',
      runner() { throw new Error('RUNNER_MUST_NOT_START'); },
      chromeAdapter: {}, now: clock(), reportOptions: REPORT_OPTIONS, cleanupTimeoutMs: 5,
      onCheckpoint() { return new Promise(() => {}); },
    }));
    assertPublicCheckpointFailure(outcome);
  });

  await t.test('onCheckpoint private rejection', async () => {
    const outcome = await observeWithin(runBatch({
      entries: normalizeUrlList('https://checkpoint-rejection.example.test/').entries,
      batchAuditId: 'batch-checkpoint-rejection',
      runner() { throw new Error('RUNNER_MUST_NOT_START'); },
      chromeAdapter: {}, now: clock(), reportOptions: REPORT_OPTIONS, cleanupTimeoutMs: 5,
      onCheckpoint() { throw new Error('PRIVATE_CHECKPOINT_REJECTION'); },
    }));
    assertPublicCheckpointFailure(outcome);
  });

  await t.test('onExecutionCheckpoint timeout', async () => {
    const outcome = await observeWithin(runBatch({
      entries: normalizeUrlList('https://execution-checkpoint-timeout.example.test/').entries,
      batchAuditId: 'batch-execution-checkpoint-timeout',
      chromeAdapter: timedDefaultAdapter({ settleDelayMs: 1 }),
      now: clock(), reportOptions: REPORT_OPTIONS,
      pageTimeoutMs: 5, cleanupTimeoutMs: 5,
      onExecutionCheckpoint() { return new Promise(() => {}); },
    }));
    assertPublicCheckpointFailure(outcome);
  });

  await t.test('onExecutionCheckpoint timeout after a fulfilled page boundary', async () => {
    const outcome = await observeWithin(runBatch({
      entries: normalizeUrlList('https://fulfilled-execution-checkpoint-timeout.example.test/').entries,
      batchAuditId: 'batch-fulfilled-execution-checkpoint-timeout',
      chromeAdapter: timedDefaultAdapter({ settleImmediately: true }),
      now: clock(), reportOptions: REPORT_OPTIONS,
      pageTimeoutMs: 1_000, cleanupTimeoutMs: 5,
      onExecutionCheckpoint() { return new Promise(() => {}); },
    }));
    assertPublicCheckpointFailure(outcome);
  });
});

test('progress and handoff timeouts remain non-controlling and the batch still finishes', async () => {
  const outcome = await observeWithin(runBatch({
    entries: normalizeUrlList('https://non-controlling-timeouts.example.test/').entries,
    batchAuditId: 'batch-non-controlling-timeouts',
    runner: async options => {
      await options.chromeAdapter.emitProgress({ type: 'AUDIT_PROGRESS', percent: 25 });
      return rawChild({ auditId: options.idFactory(), url: options.url, now: options.now });
    },
    chromeAdapter: {
      emitProgress() { return new Promise(() => {}); },
      handoffReport() { return new Promise(() => {}); },
    },
    now: clock(), reportOptions: REPORT_OPTIONS,
    pageTimeoutMs: 100, cleanupTimeoutMs: 5,
  }));

  assert.equal(outcome.kind, 'fulfilled');
  assert.equal(outcome.value.pages.length, 1);
  assert.equal(outcome.value.pages[0].status, 'complete');
});

test('handoff method and result reflection never invoke hostile getters or leak proxy details', async t => {
  const run = chromeAdapter => observeWithin(runBatch({
    entries: normalizeUrlList('https://handoff-reflection.example.test/').entries,
    batchAuditId: 'batch-handoff-reflection',
    runner: async options => rawChild({ auditId: options.idFactory(), url: options.url, now: options.now }),
    chromeAdapter, now: clock(), reportOptions: REPORT_OPTIONS, cleanupTimeoutMs: 5,
  }));

  await t.test('handoffReport accessor', async () => {
    let reads = 0;
    const prototype = Object.defineProperty({}, 'handoffReport', {
      get() { reads += 1; throw new Error('PRIVATE_HANDOFF_METHOD_GETTER'); },
    });
    const outcome = await run(Object.create(prototype));
    assert.equal(outcome.kind, 'fulfilled');
    assert.equal(reads, 0);
    assert.doesNotMatch(JSON.stringify(outcome.value), /PRIVATE_HANDOFF_METHOD_GETTER/u);
  });

  await t.test('reviewUrl accessor', async () => {
    let reads = 0;
    const chromeAdapter = { handoffReport() {
      return Object.defineProperty({}, 'reviewUrl', {
        enumerable: true,
        get() { reads += 1; throw new Error('PRIVATE_HANDOFF_RESULT_GETTER'); },
      });
    } };
    const outcome = await run(chromeAdapter);
    assert.equal(outcome.kind, 'fulfilled');
    assert.equal(reads, 0);
    assert.doesNotMatch(JSON.stringify(outcome.value), /PRIVATE_HANDOFF_RESULT_GETTER/u);
  });

  await t.test('transparent result proxy with a hostile property-read trap', async () => {
    let reads = 0;
    const result = new Proxy({ reviewUrl: null }, {
      get() { reads += 1; throw new Error('PRIVATE_HANDOFF_PROXY_GET'); },
    });
    const outcome = await run({ handoffReport() { return result; } });
    assert.equal(outcome.kind, 'fulfilled');
    assert.equal(reads, 0);
    assert.doesNotMatch(JSON.stringify(outcome.value), /PRIVATE_HANDOFF_PROXY_GET/u);
  });
});
