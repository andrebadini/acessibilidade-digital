import assert from 'node:assert/strict';
import test from 'node:test';

import { SAMPLE_AUDIT } from '../../fixtures/audits/sample-audit.js';
import { createInstalledCoreRuleInventory } from '../../src/core/rules/core-rule-inventory.js';
import { enrichAuditForReport } from '../../src/core/report/enrich-audit.js';
import {
  copyPanelResultBundleV1,
  createPanelResultBundleV1,
} from '../../src/panel/panel-result-bundle.js';

async function fixture() {
  const model = await enrichAuditForReport(structuredClone(SAMPLE_AUDIT), {
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
