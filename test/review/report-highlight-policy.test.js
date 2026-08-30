import assert from 'node:assert/strict';
import test from 'node:test';

test('availability is interaction-driven and reconnect rechecks only a bounded serialized working set', async () => {
  const module = await import('../../src/review/report-highlight-policy.js').catch(() => ({}));
  assert.equal(typeof module.createReportHighlightPolicy, 'function');
  const calls = [];
  let active = 0;
  let maximumActive = 0;
  const policy = module.createReportHighlightPolicy({
    async requestAvailability(occurrenceId, options) {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      calls.push([occurrenceId, options]);
      await new Promise(resolve => setImmediate(resolve));
      active -= 1;
      return true;
    },
    maximumKnown: 4,
    maximumQueued: 4,
  });

  assert.deepEqual(calls, []);
  for (let index = 1; index <= 6; index += 1) {
    assert.equal(await policy.requestExplicit(`occ-${index}`), true);
  }
  calls.length = 0;
  await policy.recheckKnown();
  assert.deepEqual(calls, [
    ['occ-3', { announce: false }], ['occ-4', { announce: false }],
    ['occ-5', { announce: false }], ['occ-6', { announce: false }],
  ]);
  assert.equal(maximumActive, 1);
  assert.equal(Object.keys(policy).includes('remember'), false);
});

test('availability queue deduplicates an occurrence and rejects excess work without an unbounded backlog', async () => {
  const { createReportHighlightPolicy } = await import('../../src/review/report-highlight-policy.js');
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const calls = [];
  const policy = createReportHighlightPolicy({
    async requestAvailability(occurrenceId) {
      calls.push(occurrenceId);
      await gate;
      return true;
    },
    maximumKnown: 2,
    maximumQueued: 2,
  });

  const first = policy.requestExplicit('occ-1');
  const duplicate = policy.requestExplicit('occ-1');
  const second = policy.requestExplicit('occ-2');
  const denied = await policy.requestExplicit('occ-3');
  assert.equal(denied, false);
  release();
  assert.deepEqual(await Promise.all([first, duplicate, second]), [true, true, true]);
  assert.deepEqual(calls, ['occ-1', 'occ-2']);
});

test('availability accepts the complete shared occurrence identifier alphabet but rejects oversized correlation', async () => {
  const { createReportHighlightPolicy } = await import('../../src/review/report-highlight-policy.js');
  const calls = [];
  const policy = createReportHighlightPolicy({
    async requestAvailability(occurrenceId) { calls.push(occurrenceId); return true; },
  });
  assert.equal(await policy.requestExplicit('occ:page.1_item-2'), true);
  assert.equal(await policy.requestExplicit('x'.repeat(201)), false);
  assert.deepEqual(calls, ['occ:page.1_item-2']);
});
