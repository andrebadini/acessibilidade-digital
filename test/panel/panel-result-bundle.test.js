import assert from 'node:assert/strict';
import test from 'node:test';
import { deflateSync } from 'node:zlib';

import { SAMPLE_AUDIT } from '../../fixtures/audits/sample-audit.js';
import { AXE_PROVENANCE } from '../../src/browser/axe-adapter.js';
import { AUDIT_EXECUTION_INTERNAL } from '../../src/background/chrome-adapter.js';
import { runAudit } from '../../src/background/run-audit.js';
import { createCapturePolicyV1 } from '../../src/core/privacy/capture-policy.js';
import { NBR17225_ITEMS } from '../../src/core/normative/nbr17225.js';
import { section508ReferencesForWcag } from '../../src/core/normative/section508.js';
import { aggregateItems } from '../../src/core/rules/aggregate-items.js';
import { createInstalledCoreRuleInventory } from '../../src/core/rules/core-rule-inventory.js';
import { enrichAuditForReport } from '../../src/core/report/enrich-audit.js';
import { canonicalCoreRuleSummary } from '../../src/core/report/text-policy.js';
import {
  copyPanelResultBundleV1,
  createPanelResultBundleV1,
} from '../../src/panel/panel-result-bundle.js';
import { buildCompleteReportSummary } from '../../src/panel/panel-summary.js';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const PANEL_PREVIEW_TOTAL_BYTES = 2_000_000;

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, checksum]);
}

function deterministicPngDataUrl(width, height, seed = 0x12345678) {
  const rowBytes = 1 + width * 4;
  const raster = Buffer.alloc(height * rowBytes);
  let state = seed >>> 0;
  for (let row = 0; row < height; row += 1) {
    const offset = row * rowBytes;
    raster[offset] = 0;
    for (let index = 1; index < rowBytes; index += 1) {
      state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
      raster[offset + index] = state & 0xff;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 6;
  const bytes = Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raster)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${bytes.toString('base64')}`;
}

async function failedAudit(auditId) {
  const internalValues = {};
  const adapter = {
    async createTab() { return { id: 42, windowId: 9 }; },
    async navigateTab() {},
    async waitForStable() { return { url: 'https://example.test/' }; },
    async probeDocumentIdentity(tabId) {
      return { tabId, windowId: 9, documentId: 'document-a', urlSessionDigest: `hmac-sha256:${'A'.repeat(43)}` };
    },
    async getEvidenceUrl() { return 'https://example.test/'; },
    async connectCdp() {
      return {
        async command() {
          return {
            cssContentSize: { width: 800, height: 600 },
            cssLayoutViewport: { clientWidth: 800, clientHeight: 600 },
          };
        },
        async disconnect() {},
      };
    },
    async runAxeInTab() {
      return {
        status: 'disabled', provenance: AXE_PROVENANCE, frames: [],
        diagnostics: [{ code: 'AXE_FEATURE_DISABLED', frameId: null }],
      };
    },
    async getEnvironment() {
      return { chromeVersion: 'Chrome/147.0.0.0', viewport: { width: 800, height: 600, deviceScaleFactor: 1 } };
    },
    async collectPage() { throw new Error('structural collection failure'); },
    async removeTab() {},
    // Aba viva para a reatestação da limpeza (achado D1 da 1.1.37).
    async getTab(tabId) { return { id: tabId, windowId: 9 }; },
  };
  Object.defineProperty(adapter, AUDIT_EXECUTION_INTERNAL, {
    value: Object.freeze({
      sessionArea: {
        async get(key) { return Object.hasOwn(internalValues, key) ? { [key]: structuredClone(internalValues[key]) } : {}; },
        async set(entries) { Object.assign(internalValues, structuredClone(entries)); },
        async remove(key) { delete internalValues[key]; },
      },
      randomBytes(length) { return new Uint8Array(length).fill(12); },
      capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    }),
  });
  return runAudit({
    url: 'https://example.test/', chromeAdapter: adapter,
    now: () => '2026-08-29T11:59:00.000Z', idFactory: () => auditId,
  });
}

async function fixture(status = null, mutateDraft = () => {}) {
  const draft = status === 'failed'
    ? await failedAudit('audit-panel-failed-result')
    : structuredClone(SAMPLE_AUDIT);
  if (status !== null && status !== 'failed') {
    draft.session.status = status;
    draft.session.partial = status === 'partial';
    draft.integrity.canonicalModelHash = 'pending';
    draft.integrity.evidenceManifestHash = 'pending';
  }
  mutateDraft(draft);
  const model = await enrichAuditForReport(draft, {
    now: () => '2026-08-29T12:00:00.000Z', timezone: 'America/Cuiaba',
    manifestVersion: '0.1.0', rulesVersion: '1.0.0', browserVersion: 'Chrome/147.0.0.0',
  });
  const inventory = await createInstalledCoreRuleInventory();
  const checkpoint = {
    version: 1, auditId: model.auditId,
    pages: model.pages.map(page => ({
      pageId: page.pageId, attempted: page.attempted,
      startedAt: page.attempted ? page.timestamps.startedAt : null,
      rulesVersion: inventory.rulesVersion, inventoryVersion: inventory.inventoryVersion,
      inventoryHash: inventory.sha256, outcomes: [],
    })),
  };
  return {
    inventory,
    reportRevision: {
      version: 1, auditId: model.auditId, modelRevision: 1,
      modelHash: model.integrity.canonicalModelHash, model, checkpoint,
    },
  };
}

test('builds a result bundle for a canonical failed terminal audit', async () => {
  const input = await fixture('failed');
  const bundle = await createPanelResultBundleV1(input);

  assert.equal(bundle.auditId, input.reportRevision.auditId);
  assert.equal(bundle.modelHash, input.reportRevision.modelHash);
  assert.equal(bundle.summary.identity.status, 'failed');
  assert.equal(Object.isFrozen(bundle), true);
});

test('builds one sorted detail per unique occurrence exposed by the four summary groups', async () => {
  const input = await fixture();
  const bundle = await createPanelResultBundleV1(input);
  const occurrenceIds = Object.values(bundle.summary.groups).flat()
    .flatMap(card => card.occurrenceIds).filter(Boolean)
    .filter((value, index, all) => all.indexOf(value) === index)
    .sort((left, right) => left.localeCompare(right));
  assert.deepEqual(Object.keys(bundle), ['version', 'auditId', 'modelRevision', 'modelHash', 'summary', 'details']);
  assert.deepEqual(bundle.details.map(detail => detail.occurrenceId), occurrenceIds);
  assert.equal(bundle.auditId, input.reportRevision.auditId);
  assert.equal(bundle.modelHash, input.reportRevision.modelHash);
  assert.equal(Object.isFrozen(bundle), true);
  assert.equal(Object.isFrozen(bundle.details), true);

  const copy = copyPanelResultBundleV1(structuredClone(bundle));
  assert.deepEqual(copy, bundle);
  assert.notEqual(copy, bundle);
});

test('bounds the interactive panel projection while preserving complete occurrence counts for the report', async () => {
  const input = await fixture(null, draft => {
    for (const ruleId of ['focus-visible', 'focus-order']) {
      const rule = draft.ruleResults.find(value => value.ruleId === ruleId);
      rule.outcome = 'inapplicable';
      rule.targets = [];
      rule.summary = canonicalCoreRuleSummary(ruleId, 'inapplicable');
      rule.limitations = [];
      for (const itemId of rule.nbrItems) {
        draft.itemResults.find(value => value.id === itemId).outcome = 'inapplicable';
      }
    }
    const source = SAMPLE_AUDIT.occurrences.find(value => value.source.engine === 'audita-manual-review');
    const review = SAMPLE_AUDIT.manualReview.find(value => value.occurrenceId === source.occurrenceId);
    draft.occurrences = Array.from({ length: 256 }, (_value, index) => ({
      ...structuredClone(source), occurrenceId: `occ-panel-limit-${String(index).padStart(3, '0')}`,
    }));
    draft.manualReview = draft.occurrences.map(occurrence => ({
      ...structuredClone(review), occurrenceId: occurrence.occurrenceId,
    }));
    draft.reviewDecisions = [];
  });

  const bundle = await createPanelResultBundleV1(input);
  const exposedIds = Object.values(bundle.summary.groups).flatMap(cards =>
    cards.flatMap(card => card.occurrenceIds));

  assert.equal(bundle.summary.counts.humanReview.occurrences, 0);
  assert.equal(bundle.summary.checklist.flatMap(card => card.occurrenceIds).length, 256);
  assert.equal(exposedIds.length, 0);
  assert.equal(bundle.details.length, exposedIds.length);
  assert.equal(bundle.summary.limitations.codes.some(value => /painel.+relat.rio completo/iu.test(value)), false);
  assert.equal(input.reportRevision.model.occurrences.length, 256);
});

test('keeps an image issue visible when an earlier card alone exceeds the occurrence budget', async () => {
  const input = await fixture(null, draft => {
    const originalOccurrence = SAMPLE_AUDIT.occurrences.find(value => value.occurrenceId === 'occ-focus-failed');
    const originalEvidence = SAMPLE_AUDIT.evidence.find(value => value.evidenceId === 'ev-control');
    draft.occurrences = [];
    draft.manualReview = [];
    draft.reviewDecisions = [];
    draft.evidence = draft.evidence.filter(value => value.evidenceId === 'ev-full');
    for (const rule of draft.ruleResults) {
      const count = rule.ruleId === 'accessible-component-name' ? 70 : rule.ruleId === 'content-image-alternative' ? 1 : 0;
      rule.outcome = count > 0 ? 'failed' : 'inapplicable';
      rule.targets = [];
      rule.summary = canonicalCoreRuleSummary(rule.ruleId, rule.outcome);
      rule.limitations = [];
      for (let index = 0; index < count; index += 1) {
        const suffix = `${rule.ruleId}-${String(index).padStart(3, '0')}`;
        const nodeId = `node-${suffix}`;
        const evidenceId = `ev-${suffix}`;
        const itemId = rule.nbrItems[0];
        rule.targets.push(nodeId);
        draft.evidence.push({
          ...structuredClone(originalEvidence), evidenceId, nodeId,
          selector: { css: `#${nodeId}`, framePath: [] },
        });
        draft.occurrences.push({
          ...structuredClone(originalOccurrence), occurrenceId: `occ-${suffix}`,
          itemId, ruleId: rule.ruleId, mode: rule.mode, nodeId,
          source: { ...rule.source }, nbrItemRef: itemId,
          itemWcagRefs: [...rule.wcag], sourceWcagRefs: [...rule.wcag],
          testedWcagRefs: [...rule.wcag], wcagRefs: [...rule.wcag],
          foreignBenchmarkRefs: [...section508ReferencesForWcag(rule.wcag)],
          target: { nodeId, selector: null, framePath: [] },
          evidenceIds: ['ev-full', evidenceId], evidenceRefs: ['ev-full', evidenceId],
          justification: rule.summary,
        });
      }
    }
    draft.itemResults = aggregateItems(draft.ruleResults, NBR17225_ITEMS).map(item => ({
      ...item, ruleResults: item.ruleResults.map(rule => rule.ruleId),
    }));
  });
  const originalModel = JSON.stringify(input.reportRevision.model);
  const bundle = await createPanelResultBundleV1(input);
  const cards = bundle.summary.groups.failed;

  assert.deepEqual(cards.map(card => card.ruleId), ['accessible-component-name', 'content-image-alternative']);
  assert.deepEqual(cards.map(card => card.occurrenceIds.length), [63, 1]);
  assert.equal(cards[0].occurrenceIds.at(-1), 'occ-accessible-component-name-062');
  assert.equal(cards[1].occurrenceIds[0], 'occ-content-image-alternative-000');
  assert.equal(bundle.details.length, 64);
  assert.deepEqual(bundle.summary.counts.errors, { checkKeys: 2, occurrences: 71 });
  for (const card of cards) {
    assert.deepEqual(card.evidence.evidenceIds,
      ['ev-full', ...card.occurrenceIds.map(id => id.replace(/^occ-/u, 'ev-'))]
        .sort((left, right) => left.localeCompare(right)));
  }
  assert.deepEqual(copyPanelResultBundleV1(structuredClone(bundle)), bundle);
  const complete = await buildCompleteReportSummary({
    model: input.reportRevision.model, executionCheckpoint: input.reportRevision.checkpoint, inventory: input.inventory,
  });
  assert.deepEqual(complete.groups.failed.map(card => card.occurrenceIds.length), [70, 1]);
  // The panel truncates its interactive projection, but the headline totals must still match
  // the complete report for the same model: a person comparing the panel with the report
  // cannot see two different numbers for the same audit.
  assert.deepEqual(complete.counts, bundle.summary.counts,
    'panel and report totals must agree for the same revision');
  assert.equal(JSON.stringify(input.reportRevision.model), originalModel);
});

test('keeps a valid large canonical raster in the report while omitting only its panel preview', async () => {
  const largePng = deterministicPngDataUrl(500, 500);
  assert.equal(largePng.length > 1_300_000, true, 'fixture exercises the former generic string ceiling');
  const input = await fixture(null, draft => {
    const fullPage = draft.evidence.find(value => value.evidenceId === 'ev-full');
    fullPage.dataUrl = largePng;
    fullPage.metadata = { width: 500, height: 500 };
  });
  const reportHash = input.reportRevision.modelHash;
  const evidenceHash = input.reportRevision.model.evidence.find(value => value.evidenceId === 'ev-full').hash;

  const bundle = await createPanelResultBundleV1(input);
  const detail = bundle.details.find(value => value.occurrenceId === 'occ-focus-failed');
  const largePreview = detail.previews.find(value => value.evidenceId === 'ev-full');
  const smallPreview = detail.previews.find(value => value.evidenceId === 'ev-control');

  assert.equal(bundle.modelHash, reportHash);
  assert.equal(input.reportRevision.model.evidence.find(value => value.evidenceId === 'ev-full').dataUrl, largePng);
  assert.equal(input.reportRevision.model.evidence.find(value => value.evidenceId === 'ev-full').hash, evidenceHash);
  assert.equal(largePreview.dataUrl, null);
  assert.equal(smallPreview.dataUrl.startsWith('data:image/png;base64,'), true);
});

test('applies one deterministic closed preview budget without rejecting valid evidence or emitting partial data', async () => {
  const mediumPng = deterministicPngDataUrl(360, 360, 0x2468ace0);
  assert.equal(mediumPng.length < 1_000_000, true, 'each preview fits the per-item boundary');
  const input = await fixture(null, draft => {
    const fullPage = draft.evidence.find(value => value.evidenceId === 'ev-full');
    fullPage.dataUrl = mediumPng;
    fullPage.metadata = { width: 360, height: 360 };
    const control = draft.evidence.find(value => value.evidenceId === 'ev-control');
    control.dataUrl = mediumPng;
    for (const suffix of ['a', 'b']) {
      draft.evidence.push({
        ...structuredClone(control), evidenceId: `ev-extra-${suffix}`,
        mediaUrl: `https://servico.exemplo.test/assets/controle-${suffix}.png`,
      });
    }
    const occurrence = draft.occurrences.find(value => value.occurrenceId === 'occ-focus-failed');
    occurrence.evidenceRefs.push('ev-extra-a', 'ev-extra-b');
    occurrence.evidenceIds.push('ev-extra-a', 'ev-extra-b');
  });

  const first = await createPanelResultBundleV1(input);
  const second = await createPanelResultBundleV1(input);
  const firstUrls = first.details.flatMap(detail => detail.previews.map(preview => preview.dataUrl));
  const secondUrls = second.details.flatMap(detail => detail.previews.map(preview => preview.dataUrl));
  const retainedBytes = firstUrls.filter(value => typeof value === 'string' && value)
    .reduce((total, value) => total + Buffer.byteLength(value, 'utf8'), 0);

  assert.equal(retainedBytes <= PANEL_PREVIEW_TOTAL_BYTES, true);
  assert.equal(firstUrls.some(value => value === null), true, 'at least one over-budget preview is explicitly omitted');
  assert.equal(firstUrls.every(value => value === null || value === '' || value === mediumPng), true, 'no preview is truncated or fabricated');
  assert.deepEqual(secondUrls, firstUrls, 'the same canonical report yields the same retained previews');
  assert.equal(first.modelHash, input.reportRevision.modelHash);

  const forged = structuredClone(first);
  for (const detail of forged.details) {
    for (const preview of detail.previews) if (preview.dataUrl === null) preview.dataUrl = mediumPng;
  }
  assert.throws(
    () => copyPanelResultBundleV1(forged),
    /PANEL_RESULT_BUNDLE_DENIED/u,
    'the copy boundary independently enforces the same aggregate preview budget',
  );
});

test('copy rejects hostile graphs, correlation drift, cycles and fixed budget excess', async () => {
  const bundle = await createPanelResultBundleV1(await fixture());
  const attacks = [];
  const extra = structuredClone(bundle); extra.summary.extra = true; attacks.push(extra);
  const drift = structuredClone(bundle); drift.summary.auditId = 'foreign-audit'; attacks.push(drift);
  const duplicate = structuredClone(bundle); duplicate.details.push(structuredClone(duplicate.details[0])); attacks.push(duplicate);
  const cycle = structuredClone(bundle); cycle.summary.identity.self = cycle; attacks.push(cycle);
  const huge = structuredClone(bundle); huge.summary.identity.finalUrl = 'x'.repeat(1_048_577); attacks.push(huge);
  for (const attack of attacks) {
    assert.throws(() => copyPanelResultBundleV1(attack), error => error?.message === 'PANEL_RESULT_BUNDLE_DENIED');
  }
  let reads = 0;
  const accessor = structuredClone(bundle);
  Object.defineProperty(accessor, 'auditId', { enumerable: true, get() { reads += 1; return bundle.auditId; } });
  assert.throws(() => copyPanelResultBundleV1(accessor), /PANEL_RESULT_BUNDLE_DENIED/u);
  assert.equal(reads, 0);
});
