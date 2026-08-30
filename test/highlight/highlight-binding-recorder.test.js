import assert from 'node:assert/strict';
import test from 'node:test';

import { createHighlightBindingRecorder } from '../../src/background/highlight-binding-recorder.js';

const SNAPSHOT = Object.freeze({
  model: Object.freeze({ auditId: 'audit-1' }),
  modelRevision: 1,
  modelHash: 'a'.repeat(64),
});
const OBSERVED = Object.freeze({ version: 1, kind: 'attached' });
const BINDING = Object.freeze({ auditId: 'audit-1', expiresAt: 1_800 });

function fixture(overrides = {}) {
  const order = [];
  const bindingStore = {
    async put(binding) { order.push(['put', binding]); return binding; },
    async deleteAudit(auditId) { order.push(['delete', auditId]); return true; },
    ...overrides.bindingStore,
  };
  const recorder = createHighlightBindingRecorder({
    bindingStore,
    chromeAdapter: Object.freeze({}),
    digestManager: Object.freeze({}),
    now: () => 1_000,
    recordBinding: async input => { order.push(['record', input]); return BINDING; },
    scheduleExpiry: async () => { order.push(['schedule']); },
    ...overrides.options,
  });
  return { recorder, order, bindingStore };
}

test('records, persists and schedules a verified live binding in strict order', async () => {
  const { recorder, order } = fixture();
  const result = await recorder.record({ snapshot: SNAPSHOT, observedTarget: OBSERVED });
  assert.equal(result, BINDING);
  assert.deepEqual(order.map(([name]) => name), ['record', 'put', 'schedule']);
  assert.equal(order[0][1].snapshot, SNAPSHOT);
  assert.equal(order[0][1].observedTarget, OBSERVED);
  assert.equal(Object.isFrozen(order[0][1]), true);
});

test('keeps evidence-only state when no candidate survives and performs no write or alarm', async () => {
  const { recorder, order } = fixture({
    options: { recordBinding: async input => { order.push(['record', input]); return null; } },
  });
  assert.equal(await recorder.record({ snapshot: SNAPSHOT, observedTarget: OBSERVED }), null);
  assert.deepEqual(order.map(([name]) => name), ['record']);
});

for (const [label, failure] of [
  ['persistence is uncertain', {
    bindingStore: { async put() { throw new Error('write may have landed'); } },
  }],
  ['expiry scheduling fails', {
    options: { async scheduleExpiry() { throw new Error('alarm denied'); } },
  }],
]) {
  test(`compensates the audit binding when ${label}`, async () => {
    const { recorder, order } = fixture(failure);
    await assert.rejects(
      () => recorder.record({ snapshot: SNAPSHOT, observedTarget: OBSERVED }),
      /HIGHLIGHT_BINDING_RECORD_FAILED/u,
    );
    assert.deepEqual(order.at(-1), ['delete', 'audit-1']);
  });
}

test('fails closed when compensation cannot confirm deletion', async () => {
  const { recorder } = fixture({
    bindingStore: {
      async put() { throw new Error('write may have landed'); },
      async deleteAudit() { throw new Error('delete denied'); },
    },
  });
  await assert.rejects(
    () => recorder.record({ snapshot: SNAPSHOT, observedTarget: OBSERVED }),
    /HIGHLIGHT_BINDING_CLEANUP_UNCONFIRMED/u,
  );
});

test('rejects malformed factories and request envelopes before any side effect', async () => {
  assert.throws(() => createHighlightBindingRecorder(), /HIGHLIGHT_BINDING_RECORDER_INVALID/u);
  const { recorder, order } = fixture();
  await assert.rejects(
    () => recorder.record({ snapshot: SNAPSHOT, observedTarget: OBSERVED, tabId: 7 }),
    /HIGHLIGHT_BINDING_RECORD_INPUT_INVALID/u,
  );
  assert.deepEqual(order, []);
});
