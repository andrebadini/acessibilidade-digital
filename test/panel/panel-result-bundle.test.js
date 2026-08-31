import assert from 'node:assert/strict';
import test from 'node:test';

import { SAMPLE_AUDIT } from '../../fixtures/audits/sample-audit.js';
import { AXE_PROVENANCE } from '../../src/browser/axe-adapter.js';
import { AUDIT_EXECUTION_INTERNAL } from '../../src/background/chrome-adapter.js';
import { runAudit } from '../../src/background/run-audit.js';
import { createCapturePolicyV1 } from '../../src/core/privacy/capture-policy.js';
import { createInstalledCoreRuleInventory } from '../../src/core/rules/core-rule-inventory.js';
import { enrichAuditForReport } from '../../src/core/report/enrich-audit.js';
import {
  copyPanelResultBundleV1,
  createPanelResultBundleV1,
} from '../../src/panel/panel-result-bundle.js';

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

async function fixture(status = null) {
  const draft = status === 'failed'
    ? await failedAudit('audit-panel-failed-result')
    : structuredClone(SAMPLE_AUDIT);
  if (status !== null && status !== 'failed') {
    draft.session.status = status;
    draft.session.partial = status === 'partial';
    draft.integrity.canonicalModelHash = 'pending';
    draft.integrity.evidenceManifestHash = 'pending';
  }
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
