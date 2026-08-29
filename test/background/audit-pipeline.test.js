import assert from 'node:assert/strict';
import test from 'node:test';

import { executeObservedAuditPipeline } from '../../src/background/audit-pipeline.js';
import { createPageCheckpointRecorder } from '../../src/background/execution-checkpoint.js';
import { createCapturePolicyV1 } from '../../src/core/privacy/capture-policy.js';
import { createInstalledCoreRuleInventory } from '../../src/core/rules/core-rule-inventory.js';

const observedTarget = Object.freeze({
  version: 1, kind: 'attached', tabId: 17, windowId: 9,
  documentId: 'document-1', urlSessionDigest: `hmac-sha256:${'A'.repeat(43)}`,
  urlEvidence: 'https://example.test/path',
});

async function checkpointFixture() {
  const inventory = await createInstalledCoreRuleInventory();
  const recorder = await createPageCheckpointRecorder({
    auditId: 'audit-a', pageId: 'page-1', startedAt: '2026-08-29T10:00:00.000Z',
    rulesVersion: inventory.rulesVersion, inventory, onCheckpoint: async () => {},
  });
  return { inventory, recorder };
}

test('collects only a proven target, records core outcomes, persists a model, and keeps checkpoint internal', async () => {
  const { inventory, recorder } = await checkpointFixture();
  const calls = [];
  const model = Object.freeze({ schemaVersion: 2, auditId: 'audit-a', session: Object.freeze({ status: 'complete', diagnostics: Object.freeze([]) }) });
  const result = await executeObservedAuditPipeline({
    auditId: 'audit-a', observedTarget,
    capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
    checkpointRecorder: recorder,
    services: {
      async collectObservedPage(input) {
        calls.push(['collect', input.capturePolicy]);
        assert.equal(input.observedTarget, observedTarget);
        return { snapshot: { title: 'safe' }, supplementalResults: [{ ruleId: 'axe.extra', outcome: 'failed' }] };
      },
      async runCoreRules() {
        calls.push(['core']);
        return {
          ruleResults: [
            { ruleId: inventory.ruleIds[0], outcome: 'passed' },
            { ruleId: inventory.ruleIds[1], outcome: 'failed' },
          ],
        };
      },
      async buildAuditModel(input) {
        calls.push(['model']);
        assert.equal(Object.hasOwn(input, 'observedTarget'), false);
        assert.equal(Object.hasOwn(input, 'checkpoint'), false);
        return model;
      },
      async persistAuditModel(value) { calls.push(['persist']); assert.equal(value, model); },
    },
  });
  assert.deepEqual(calls.map(value => value[0]), ['collect', 'core', 'model', 'persist']);
  assert.deepEqual(result, {
    model,
    checkpoint: recorder.snapshot(),
    observationState: 'observed',
  });
  assert.equal(Object.hasOwn(result.model, 'checkpoint'), false);
  assert.equal(Object.hasOwn(result.model, 'observedTarget'), false);
  assert.deepEqual(result.checkpoint.pages[0].outcomes.map(value => value.ruleId), [inventory.ruleIds[0], inventory.ruleIds[1]].sort((a, b) => a.localeCompare(b)));
});

test('rejects an unproven target and malformed services before collection or pixels', async () => {
  let calls = 0;
  const { recorder } = await checkpointFixture();
  const services = {
    async collectObservedPage() { calls += 1; },
    async runCoreRules() {}, async buildAuditModel() {}, async persistAuditModel() {},
  };
  for (const target of [
    { ...observedTarget, documentId: '' },
    { ...observedTarget, urlSessionDigest: 'raw-url' },
    { ...observedTarget, rawUrl: 'https://example.test/?secret=1' },
  ]) {
    await assert.rejects(() => executeObservedAuditPipeline({
      auditId: 'audit-a', observedTarget: target,
      capturePolicy: createCapturePolicyV1({ mode: 'no-pixels', includeQuery: false }),
      checkpointRecorder: recorder, services,
    }), /OBSERVED_PIPELINE_DENIED/u);
  }
  assert.equal(calls, 0);
});
