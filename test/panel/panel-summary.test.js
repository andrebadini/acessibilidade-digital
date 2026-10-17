import assert from 'node:assert/strict';
import test from 'node:test';

import { SAMPLE_AUDIT } from '../../fixtures/audits/sample-audit.js';
import { reportInput } from '../report/helpers.js';
import {
  aggregateBatchAudits,
  createBatchFailurePage,
  createBatchReportTemplate,
} from '../../src/core/batch/aggregate-audits.js';
import { createInstalledCoreRuleInventory } from '../../src/core/rules/core-rule-inventory.js';
import { enrichAuditForReport } from '../../src/core/report/enrich-audit.js';
import { migrateAuditV1ToV2 } from '../../src/core/report/audit-model.js';
import {
  canonicalBatchRuleSummary,
  canonicalScope,
  derivePageLimitations,
  deriveSystemLimitations,
} from '../../src/core/report/text-policy.js';
import { applyReviewDecisions, createReviewDecision } from '../../src/core/review/decisions.js';
import {
  buildPanelSummary,
  coveragePercent,
} from '../../src/panel/panel-summary.js';
import {
  classifyPanelResultV1,
  deriveResultContextV1,
} from '../../src/panel/panel-result-contract.js';

const OPTIONS = Object.freeze({
  now: () => '2026-08-26T14:03:00.000Z',
  timezone: 'America/Cuiaba',
  manifestVersion: '0.1.0',
  rulesVersion: '1.0.0',
  browserVersion: 'Chrome/147.0.0.0',
});

function checkpointFor(model, inventory, pageOutcomes = new Map()) {
  return {
    version: 1,
    auditId: model.auditId,
    pages: model.pages.map(page => ({
      pageId: page.pageId,
      attempted: page.attempted,
      startedAt: page.attempted ? page.timestamps.startedAt : null,
      rulesVersion: inventory.rulesVersion,
      inventoryVersion: inventory.inventoryVersion,
      inventoryHash: inventory.sha256,
      outcomes: page.attempted
        ? [...(pageOutcomes.get(page.pageId) ?? [])]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([ruleId, outcome]) => ({ ruleId, outcome }))
        : [],
    })),
  };
}

async function failureBatch(attemptedValues) {
  if (attemptedValues.length === 2 && attemptedValues[0] === true && attemptedValues[1] === false) {
    const model = structuredClone(migrateAuditV1ToV2(reportInput()));
    const requestedUrl = 'https://not-started.example.test/';
    const pageRecoverable = {
      code: 'TAB_CLOSE_FAILED', message: 'A aba descartável não pôde ser fechada automaticamente.',
      at: '2026-08-26T14:01:00.000Z', recoverable: true,
    };
    const notStarted = {
      code: 'BATCH_NOT_STARTED_CLEANUP_UNCONFIRMED',
      message: 'A página não foi iniciada porque a limpeza anterior não foi confirmada.',
      at: '2026-08-26T14:01:00.000Z', recoverable: false,
    };
    model.requestedScope = { mode: 'batch', urls: [...model.requestedScope.urls, requestedUrl] };
    model.scope = canonicalScope('batch', 2);
    model.pages[0].coverage = {};
    model.pages[0].diagnostics = [pageRecoverable];
    for (const rule of model.ruleResults) {
      if (rule.source.engine === 'audita-core') rule.summary = canonicalBatchRuleSummary(rule.outcome, 1, 2);
    }
    model.pages.push({
      pageId: 'page-2', requestedUrl, finalUrl: requestedUrl, finalUrlObserved: false,
      status: 'failed', attempted: false,
      timestamps: {
        startedAt: '2026-08-26T14:01:00.000Z', endedAt: '2026-08-26T14:01:00.000Z',
        generatedAt: '2026-08-26T14:01:00.000Z',
      },
      viewport: { width: null, height: null, deviceScaleFactor: null },
      diagnostics: [notStarted], coverage: {}, warnings: [], axeStatus: 'not-run',
    });
    model.session = { status: 'partial', partial: true, diagnostics: [pageRecoverable, notStarted] };
    model.limitations = deriveSystemLimitations(model);
    for (const page of model.pages) {
      const limitations = derivePageLimitations(model, page);
      if (limitations.length > 0) page.limitations = limitations;
      else delete page.limitations;
    }
    return model;
  }

  const cancelledValues = attemptedValues.length === 1 && attemptedValues[0] === false
    ? [false, false]
    : attemptedValues;
  const pages = cancelledValues.map((attempted, index) => {
    const minute = String(index).padStart(2, '0');
    const startedAt = `2026-08-26T14:${minute}:00.000Z`;
    const endedAt = attempted ? `2026-08-26T14:${minute}:10.000Z` : startedAt;
    return createBatchFailurePage({
      pageId: `page-${index + 1}`,
      requestedUrl: `https://page-${index + 1}.example.test/private?token=REMOVE`,
      status: attempted ? 'failed' : 'cancelled', attempted, startedAt, endedAt,
      code: attempted ? 'BATCH_PAGE_FAILED' : 'BATCH_CANCELLED',
      message: attempted
        ? 'A página não pôde ser auditada.'
        : 'A página não foi iniciada porque o lote foi cancelado.',
    });
  });
  const raw = aggregateBatchAudits({
    batchAuditId: `batch-${cancelledValues.map(value => Number(value)).join('')}`,
    pageResults: pages,
    startedAt: '2026-08-26T14:00:00.000Z',
    endedAt: '2026-08-26T14:03:00.000Z',
    status: cancelledValues.some(value => !value) ? 'cancelled' : 'failed', progress: [], diagnostics: [],
    template: createBatchReportTemplate(OPTIONS),
  });
  return enrichAuditForReport(raw, OPTIONS);
}

function allCards(summary) {
  return Object.values(summary.groups).flat();
}

test('unassessed manual tasks stay in a separate checklist without inflating findings or losing the original records', async () => {
  const before = JSON.stringify(SAMPLE_AUDIT);
  const inventory = await createInstalledCoreRuleInventory();
  const summary = await buildPanelSummary({ model: SAMPLE_AUDIT,
    executionCheckpoint: checkpointFor(SAMPLE_AUDIT, inventory), inventory });
  assert.equal(summary.counts.humanReview.occurrences, 0);
  assert.equal(summary.checklist.length, 2);
  assert.equal(summary.checklist.flatMap(card=>card.occurrenceIds).length, 2);
  assert.equal(allCards(summary).some(card=>card.originalOutcome === 'cantTell'), false);
  assert.equal(JSON.stringify(SAMPLE_AUDIT), before);
});

function modelWithEveryImpact() {
  const model = structuredClone(SAMPLE_AUDIT);
  model.occurrences.find(value => value.occurrenceId === 'occ-focus-failed').impact = 'critical';
  model.occurrences.find(value => value.occurrenceId === 'occ-focus-review').impact = 'serious';
  model.occurrences.find(value => value.occurrenceId === 'occ-cross-page').impact = 'moderate';
  model.methodology.supplementalRuleCount += 1;
  model.methodology.ruleCount += 1;
  model.ruleResults.push({
    ruleId: 'editorial.placeholder-text', outcome: 'failed', mode: 'automated',
    classification: 'editorial', impact: 'minor', confidence: 'high',
    source: { engine: 'audita-editorial', ruleId: 'editorial.placeholder-text', version: '1.0.0' },
    nbrItems: [], wcag: [], targets: [{
      nodeId: 'n-1', selectorHint: '', message: 'Substitua o conteúdo provisório antes da publicação.',
      data: { reason: 'placeholder-text' },
    }],
    summary: 'Há conteúdo provisório inequívoco na página.', limitations: [],
  });
  model.occurrences.push({
    occurrenceId: 'occ-editorial-impact', pageId: 'page-1', outcome: 'failed',
    classification: 'editorial', impact: 'minor', confidence: 'high',
    source: { engine: 'audita-editorial', ruleId: 'editorial.placeholder-text', version: '1.0.0' },
    nbrItemRef: null, itemWcagRefs: [], sourceWcagRefs: [], testedWcagRefs: [], wcagRefs: [], foreignBenchmarkRefs: [],
    target: { nodeId: 'n-1', selector: null, framePath: [] }, accessiblePreview: null,
    evidenceRefs: [], legalAnalysis: null, itemId: null, ruleId: 'editorial.placeholder-text',
    mode: 'automated', nodeId: 'n-1', evidenceIds: [],
    justification: 'Há conteúdo provisório inequívoco na página.',
  });
  return model;
}

test('separates attempted core coverage pairs from all-engine checkKeys and occurrence counts', async () => {
  const inventory = await createInstalledCoreRuleInventory();
  const checkpoint = checkpointFor(SAMPLE_AUDIT, inventory, new Map([[
    'page-1',
    [['focus-fully-visible', 'passed'], ['focus-visible', 'failed'], ['keyboard-focus-trap', 'untested']],
  ]]));

  const summary = await buildPanelSummary({ model: SAMPLE_AUDIT, executionCheckpoint: checkpoint, inventory });
  const cards = allCards(summary);

  assert.deepEqual(summary.coverage, { status: 'available', numerator: 2, denominator: 132, percent: '1,5%' });
  assert.equal(new Set(cards.map(card => card.checkKey)).size, cards.length);
  assert.equal(cards.some(card => card.engine === 'audita-core'), true);
  assert.equal(cards.some(card => card.engine === 'audita-manual-review'), false);
  assert.equal(summary.checklist.some(card => card.engine === 'audita-manual-review'), true);
  assert.deepEqual(summary.counts, {
    errors: { checkKeys: 1, occurrences: 1 },
    alerts: { checkKeys: 0, occurrences: 0 },
    humanReview: { checkKeys: 0, occurrences: 0 },
    positive: { checkKeys: 1, occurrences: 0 },
  });
  assert.deepEqual(summary.limitations.untestedCheckKeys, [JSON.stringify(['page-1', 'audita-core', 'keyboard-focus-trap'])]);
});

test('distributes SAMPLE_AUDIT by canonical WCAG conformance level while cards preserve criterion IDs', async () => {
  const inventory = await createInstalledCoreRuleInventory();
  const checkpoint = checkpointFor(SAMPLE_AUDIT, inventory, new Map([[
    'page-1', [['focus-fully-visible', 'passed']],
  ]]));

  const summary = await buildPanelSummary({ model: SAMPLE_AUDIT, executionCheckpoint: checkpoint, inventory });
  const criteria = new Map([...allCards(summary), ...summary.checklist].map(card => [card.ruleId, card.wcag]));

  assert.deepEqual(summary.distributions.wcag, [
    { id: 'AA', count: 2 },
    { id: 'AAA', count: 1 },
  ]);
  assert.deepEqual(criteria.get('focus-visible'), ['2.4.7']);
  assert.deepEqual(criteria.get('focus-order'), ['2.4.3']);
  assert.deepEqual(criteria.get('manual:5.7.5'), ['2.4.9', '3.2.4']);
  assert.deepEqual(criteria.get('focus-fully-visible'), ['2.4.11', '2.4.12']);
});

test('uses integer half-up coverage arithmetic at exact boundaries', () => {
  assert.equal(coveragePercent(1, 16), '6,3%');
  assert.equal(coveragePercent(2, 130), '1,5%');
  assert.equal(coveragePercent(129, 130), '99,2%');
  assert.throws(() => coveragePercent(0, 0), /COVERAGE_PERCENT_DENIED/u);
});

test('preserves every canonical occurrence impact and counts checkKeys in the ordered impact distribution', async () => {
  const model = modelWithEveryImpact();
  const inventory = await createInstalledCoreRuleInventory();
  const summary = await buildPanelSummary({
    model, executionCheckpoint: checkpointFor(model, inventory), inventory,
  });
  const byOccurrence = new Map([...allCards(summary), ...summary.checklist].flatMap(card =>
    card.occurrenceIds.map(occurrenceId => [occurrenceId, card.impact])));

  assert.equal(byOccurrence.get('occ-focus-failed'), 'critical');
  assert.equal(byOccurrence.get('occ-focus-review'), 'serious');
  assert.equal(byOccurrence.get('occ-cross-page'), 'moderate');
  assert.equal(byOccurrence.get('occ-editorial-impact'), 'minor');
  assert.deepEqual(summary.distributions.impact, [
    { id: 'critical', count: 1 },
    { id: 'minor', count: 1 },
  ]);
});

for (const evidenceNodeState of ['absent', 'null']) {
  test(`does not assign ${evidenceNodeState} evidence node accessibility to an element card`, async () => {
    const model = structuredClone(SAMPLE_AUDIT);
    const artifact = model.evidence.find(value => value.evidenceId === 'ev-control');
    if (evidenceNodeState === 'absent') delete artifact.nodeId;
    else artifact.nodeId = null;
    const inventory = await createInstalledCoreRuleInventory();
    const summary = await buildPanelSummary({
      model, executionCheckpoint: checkpointFor(model, inventory), inventory,
    });
    const card = allCards(summary).find(value => value.occurrenceIds.includes('occ-focus-failed'));

    assert.deepEqual(
      { accessibleName: card.accessibleName, announcement: card.announcement },
      { accessibleName: null, announcement: null },
    );
  });
}

test('distinguishes zero denominator, started without outcomes, not-started pages and a partial batch', async () => {
  const inventory = await createInstalledCoreRuleInventory();
  const zeroModel = await failureBatch([false]);
  const zero = await buildPanelSummary({
    model: zeroModel,
    executionCheckpoint: checkpointFor(zeroModel, inventory),
    inventory,
  });
  assert.deepEqual(zero.coverage, { status: 'unavailable', reason: 'EXECUTION_NOT_STARTED' });
  assert.deepEqual(zero.limitations.notStartedPageIds, ['page-1', 'page-2']);

  const started = await buildPanelSummary({
    model: SAMPLE_AUDIT,
    executionCheckpoint: checkpointFor(SAMPLE_AUDIT, inventory),
    inventory,
  });
  assert.deepEqual(started.coverage, { status: 'available', numerator: 0, denominator: 132, percent: '0,0%' });

  const partialModel = await failureBatch([true, false]);
  const partial = await buildPanelSummary({
    model: partialModel,
    executionCheckpoint: checkpointFor(partialModel, inventory),
    inventory,
  });
  assert.equal(partial.coverage.denominator, 132);
  assert.deepEqual(partial.limitations.notStartedPageIds, ['page-2']);
});

test('rejects foreign, duplicate, out-of-order, unknown and version-incompatible checkpoint graphs', async () => {
  const inventory = await createInstalledCoreRuleInventory();
  const model = await failureBatch([true, false]);
  const valid = checkpointFor(model, inventory);
  const candidates = [];

  candidates.push({ ...structuredClone(valid), auditId: 'foreign-audit' });
  const duplicatePage = structuredClone(valid);
  duplicatePage.pages.push(structuredClone(duplicatePage.pages[0]));
  candidates.push(duplicatePage);
  const outOfOrder = structuredClone(valid);
  outOfOrder.pages.reverse();
  candidates.push(outOfOrder);
  const unknownRule = structuredClone(valid);
  unknownRule.pages[0].outcomes.push({ ruleId: 'unknown-core-rule', outcome: 'passed' });
  candidates.push(unknownRule);
  const wrongVersion = structuredClone(valid);
  wrongVersion.pages[0].rulesVersion = '9.9.9';
  candidates.push(wrongVersion);
  const duplicateOutcome = structuredClone(valid);
  duplicateOutcome.pages[0].outcomes = [
    { ruleId: inventory.ruleIds[0], outcome: 'failed' },
    { ruleId: inventory.ruleIds[0], outcome: 'passed' },
  ];
  candidates.push(duplicateOutcome);

  for (const executionCheckpoint of candidates) {
    await assert.rejects(
      () => buildPanelSummary({ model, executionCheckpoint, inventory }),
      /CHECKPOINT_GRAPH_DENIED/u,
    );
  }
});

test('normalizes the checkpoint authority rejection for a 161-character audit identifier', async () => {
  const inventory = await createInstalledCoreRuleInventory();
  const model = structuredClone(SAMPLE_AUDIT);
  model.auditId = `a${'b'.repeat(160)}`;
  await assert.rejects(
    () => buildPanelSummary({ model, executionCheckpoint: checkpointFor(model, inventory), inventory }),
    /CHECKPOINT_GRAPH_DENIED/u,
  );
});

test('reports an unverified inventory without inventing checkpoint passes', async () => {
  const inventory = await createInstalledCoreRuleInventory();
  const tampered = structuredClone(inventory);
  tampered.sha256 = '0'.repeat(64);
  const checkpoint = checkpointFor(SAMPLE_AUDIT, inventory, new Map([[
    'page-1', [['focus-fully-visible', 'passed']],
  ]]));

  const summary = await buildPanelSummary({ model: SAMPLE_AUDIT, executionCheckpoint: checkpoint, inventory: tampered });

  assert.deepEqual(summary.coverage, { status: 'unavailable', reason: 'CORE_INVENTORY_UNVERIFIED' });
  assert.deepEqual(summary.groups.passed, []);
  assert.equal(summary.groups.failed.length > 0, true);

  const conformingDecision = createReviewDecision({
    auditId: SAMPLE_AUDIT.auditId,
    itemId: '5.1.4', occurrenceId: 'occ-focus-review', answer: 'conforme',
    evaluator: 'Fiscal local', decidedAt: '2026-08-26T15:00:00.000Z',
    mode: 'assisted', note: 'A ordem observada foi confirmada como previsível.',
  });
  const reviewed = applyReviewDecisions(SAMPLE_AUDIT, [conformingDecision]);
  const reviewedSummary = await buildPanelSummary({ model: reviewed, executionCheckpoint: checkpoint, inventory: tampered });
  assert.deepEqual(reviewedSummary.groups.passed, []);
});

test('uses the canonical review decision without overwriting the original outcome', async () => {
  const inventory = await createInstalledCoreRuleInventory();
  const decision = createReviewDecision({
    auditId: SAMPLE_AUDIT.auditId,
    itemId: '5.1.4', occurrenceId: 'occ-focus-review', answer: 'não conforme',
    evaluator: 'Fiscal local', decidedAt: '2026-08-26T15:00:00.000Z',
    mode: 'assisted', note: 'A ordem observada não é previsível.',
  });
  const reviewedModel = applyReviewDecisions(SAMPLE_AUDIT, [decision]);
  const summary = await buildPanelSummary({
    model: reviewedModel,
    executionCheckpoint: checkpointFor(reviewedModel, inventory),
    inventory,
  });
  const card = allCards(summary).find(row => row.occurrenceIds.includes('occ-focus-review'));

  assert.equal(card.originalOutcome, 'cantTell');
  assert.equal(card.displayOutcome, 'failed');
  assert.equal(card.classification, 'failed');
});

test('derives the closed classification and every result context from correlated canonical facts', () => {
  assert.deepEqual(
    ['failed', 'alerts', 'humanReview', 'passed'].map(classifyPanelResultV1),
    ['failed', 'alert', 'manual-review', 'passed'],
  );
  assert.throws(() => classifyPanelResultV1('unknown'), /RESULT_CLASSIFICATION_DENIED/u);

  const evidenceById = new Map([
    ['top', { evidenceId: 'top', nodeId: 'n-top', selector: { css: '#top', framePath: [] } }],
    ['frame', { evidenceId: 'frame', nodeId: 'n-frame', selector: { css: '#inside', framePath: ['iframe#safe'] } }],
    ['shadow', { evidenceId: 'shadow', nodeId: 'n-shadow', selector: { css: 'main >>> button', framePath: [] } }],
    ['uncorrelated', { evidenceId: 'uncorrelated', nodeId: null, selector: { css: '#top', framePath: [] } }],
  ]);
  const occurrence = (occurrenceId, nodeId, evidenceRefs) => ({
    occurrenceId, target: { nodeId, selector: null, framePath: [] }, evidenceRefs,
  });
  assert.equal(deriveResultContextV1({ occurrences: [occurrence('process', null, [])], evidenceById }), 'page-or-process');
  assert.equal(deriveResultContextV1({ occurrences: [occurrence('top', 'n-top', ['top'])], evidenceById }), 'top-document');
  assert.equal(deriveResultContextV1({ occurrences: [occurrence('frame', 'n-frame', ['frame'])], evidenceById }), 'same-origin-frame');
  assert.equal(deriveResultContextV1({ occurrences: [occurrence('shadow', 'n-shadow', ['shadow'])], evidenceById }), 'open-shadow-root');
  const equivalentSelector = occurrence('equivalent-selector', 'n-top', ['top']);
  equivalentSelector.target.selector = 'button#top';
  assert.equal(deriveResultContextV1({ occurrences: [equivalentSelector], evidenceById }), 'top-document',
    'dois seletores canônicos podem nomear o mesmo nodeId sem invalidar o relatório');
  const uncorrelatedSelector = occurrence('uncorrelated-selector', null, ['uncorrelated']);
  uncorrelatedSelector.target.selector = 'button#top';
  assert.throws(
    () => deriveResultContextV1({ occurrences: [uncorrelatedSelector], evidenceById }),
    /RESULT_CONTEXT_DENIED/u,
    'seletores divergentes continuam fechados sem a correlação exata do nodeId',
  );
  assert.equal(deriveResultContextV1({
    occurrences: [occurrence('top', 'n-top', ['top']), occurrence('frame', 'n-frame', ['frame'])],
    evidenceById,
  }), 'mixed');
});

test('snapshots inputs before awaiting, deep-freezes output and invokes no hostile checkpoint getter', async () => {
  const inventory = structuredClone(await createInstalledCoreRuleInventory());
  const model = structuredClone(SAMPLE_AUDIT);
  const checkpoint = checkpointFor(model, inventory, new Map([[
    'page-1', [['focus-fully-visible', 'passed']],
  ]]));
  const pending = buildPanelSummary({ model, executionCheckpoint: checkpoint, inventory });
  checkpoint.pages[0].outcomes.length = 0;
  inventory.sha256 = '0'.repeat(64);
  model.auditId = 'mutated-after-call';
  const summary = await pending;

  assert.equal(summary.auditId, SAMPLE_AUDIT.auditId);
  assert.equal(summary.coverage.numerator, 1);
  assert.equal(Object.isFrozen(summary), true);
  assert.equal(Object.isFrozen(summary.groups.failed), true);
  assert.notEqual(summary.identity, model);

  let getterCalls = 0;
  const hostilePage = { ...checkpointFor(SAMPLE_AUDIT, await createInstalledCoreRuleInventory()).pages[0] };
  Object.defineProperty(hostilePage, 'outcomes', {
    enumerable: true,
    get() { getterCalls += 1; throw new Error('PRIVATE_CHECKPOINT'); },
  });
  await assert.rejects(
    () => buildPanelSummary({
      model: SAMPLE_AUDIT,
      executionCheckpoint: { version: 1, auditId: SAMPLE_AUDIT.auditId, pages: [hostilePage] },
      inventory,
    }),
    /CHECKPOINT_GRAPH_DENIED/u,
  );
  assert.equal(getterCalls, 0);
});

test('rejects hostile model proxies and never echoes their private error', async () => {
  const inventory = await createInstalledCoreRuleInventory();
  const marker = 'PRIVATE_PANEL_PROXY_MARKER';
  const model = new Proxy({}, {
    ownKeys() { throw new Error(marker); },
  });
  await assert.rejects(
    () => buildPanelSummary({ model, executionCheckpoint: {}, inventory }),
    error => {
      assert.doesNotMatch(String(error?.message ?? error), new RegExp(marker, 'u'));
      return true;
    },
  );
});
