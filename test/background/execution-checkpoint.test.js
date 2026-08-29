import assert from 'node:assert/strict';
import test from 'node:test';

import { createInstalledCoreRuleInventory } from '../../src/core/rules/core-rule-inventory.js';
import {
  createPageCheckpointRecorder,
  mergeExecutionCheckpoint,
} from '../../src/background/execution-checkpoint.js';

async function makeRecorder(overrides = {}) {
  const inventory = await createInstalledCoreRuleInventory();
  const emitted = [];
  const recorder = await createPageCheckpointRecorder({
    auditId: 'audit-a', pageId: 'page-1', startedAt: '2026-08-29T10:00:00.000Z',
    rulesVersion: inventory.rulesVersion, inventory,
    onCheckpoint: async value => { emitted.push(value); },
    ...overrides,
  });
  return { emitted, inventory, recorder };
}

test('emits deeply immutable checkpoints in event-time order', async () => {
  const { emitted, inventory, recorder } = await makeRecorder();
  await recorder.started();
  const first = recorder.record({ ruleId: inventory.ruleIds[0], outcome: 'passed' });
  const second = recorder.record({ ruleId: inventory.ruleIds[1], outcome: 'failed' });
  await Promise.all([first, second]);
  assert.deepEqual(emitted.map(value => value.pages[0].outcomes.map(row => row.ruleId)), [
    [], [inventory.ruleIds[0]], [inventory.ruleIds[0], inventory.ruleIds[1]].sort((a, b) => a.localeCompare(b)),
  ]);
  for (const snapshot of emitted) {
    assert.equal(Object.isFrozen(snapshot), true);
    assert.equal(Object.isFrozen(snapshot.pages), true);
    assert.equal(Object.isFrozen(snapshot.pages[0]), true);
    assert.equal(Object.isFrozen(snapshot.pages[0].outcomes), true);
  }
});

test('recorder rejects version drift, duplicate/unknown core outcomes, and invalid lifecycle', async () => {
  const inventory = await createInstalledCoreRuleInventory();
  await assert.rejects(() => createPageCheckpointRecorder({
    auditId: 'audit-a', pageId: 'page-1', startedAt: '2026-08-29T10:00:00.000Z',
    rulesVersion: 'wrong', inventory, onCheckpoint: async () => {},
  }), /CHECKPOINT_INVENTORY_VERSION_MISMATCH/u);
  const { recorder } = await makeRecorder();
  assert.throws(() => recorder.record({ ruleId: inventory.ruleIds[0], outcome: 'passed' }), /CHECKPOINT_RESULT_DENIED/u);
  await recorder.started();
  assert.throws(() => recorder.started(), /CHECKPOINT_ALREADY_STARTED/u);
  await recorder.record({ ruleId: inventory.ruleIds[0], outcome: 'passed' });
  assert.throws(() => recorder.record({ ruleId: inventory.ruleIds[0], outcome: 'failed' }), /CHECKPOINT_RESULT_DENIED/u);
  assert.throws(() => recorder.record({ ruleId: 'axe.color-contrast', outcome: 'failed' }), /CHECKPOINT_RESULT_DENIED/u);
});

test('merges pages in declared order and rejects audit, duplicate, unknown, outcome, or order drift', async () => {
  const inventory = await createInstalledCoreRuleInventory();
  const page = (pageId, ruleId = inventory.ruleIds[0]) => ({
    version: 1, auditId: 'audit-a', pages: [{
      pageId, attempted: true, startedAt: '2026-08-29T10:00:00.000Z',
      rulesVersion: inventory.rulesVersion, inventoryVersion: inventory.inventoryVersion,
      inventoryHash: inventory.sha256, outcomes: [{ ruleId, outcome: 'passed' }],
    }],
  });
  const first = mergeExecutionCheckpoint({ auditId: 'audit-a', prior: null, pageSnapshot: page('page-1'), pageOrder: ['page-1', 'page-2'] });
  const merged = mergeExecutionCheckpoint({ auditId: 'audit-a', prior: first, pageSnapshot: page('page-2', inventory.ruleIds[1]), pageOrder: ['page-1', 'page-2'] });
  assert.deepEqual(merged.pages.map(value => value.pageId), ['page-1', 'page-2']);
  assert.equal(Object.isFrozen(merged.pages[1].outcomes[0]), true);
  for (const input of [
    { auditId: 'audit-b', prior: first, pageSnapshot: page('page-2'), pageOrder: ['page-1', 'page-2'] },
    { auditId: 'audit-a', prior: first, pageSnapshot: page('page-1'), pageOrder: ['page-1', 'page-2'] },
    { auditId: 'audit-a', prior: first, pageSnapshot: page('page-3'), pageOrder: ['page-1', 'page-2'] },
    { auditId: 'audit-a', prior: first, pageSnapshot: page('page-2'), pageOrder: ['page-2', 'page-1'] },
    { auditId: 'audit-a', prior: null, pageSnapshot: { ...page('page-1'), pages: [{ ...page('page-1').pages[0], outcomes: [{ ruleId: inventory.ruleIds[0], outcome: 'passed' }, { ruleId: inventory.ruleIds[0], outcome: 'failed' }] }] }, pageOrder: ['page-1'] },
  ]) {
    assert.throws(() => mergeExecutionCheckpoint(input), /CHECKPOINT_MERGE_DENIED/u);
  }
});

test('rejects hostile checkpoint accessors without invoking them', async () => {
  const inventory = await createInstalledCoreRuleInventory();
  let getterCalls = 0;
  const hostile = { version: 1, auditId: 'audit-a' };
  Object.defineProperty(hostile, 'pages', {
    enumerable: true,
    get() { getterCalls += 1; return []; },
  });
  assert.throws(() => mergeExecutionCheckpoint({
    auditId: 'audit-a', prior: null, pageSnapshot: hostile, pageOrder: ['page-1'],
  }), /CHECKPOINT_MERGE_DENIED/u);
  assert.equal(getterCalls, 0);
  assert.ok(inventory.ruleIds.length > 0);
});
