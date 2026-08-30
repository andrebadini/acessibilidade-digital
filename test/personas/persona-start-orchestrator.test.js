import assert from 'node:assert/strict';
import test from 'node:test';

import { createPersonaStartOrchestrator } from '../../src/background/persona-start-orchestrator.js';
import { createTargetOperationQueue } from '../../src/background/target-operation-queue.js';

const CAPABILITY = 'P'.repeat(22);
const TARGET = Object.freeze({
  tabId: 17,
  windowId: 9,
  documentId: 'document-persona',
  urlSessionDigest: `hmac-sha256:${'A'.repeat(43)}`,
});
const CONTEXT = Object.freeze({
  issuer: Object.freeze({
    type: 'extension-document',
    documentId: 'side-panel-window:9',
    path: '/src/panel/index.html',
  }),
  windowId: 9,
  tabId: null,
  contextType: 'SIDE_PANEL',
  documentUrl: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/src/panel/index.html',
});
const CONSUMER = Object.freeze({
  extensionId: 'abcdefghijklmnopabcdefghijklmnop',
  documentId: 'side-panel-window:9',
  path: '/src/panel/index.html',
  windowId: 9,
});

function fixture(overrides = {}) {
  const trace = [];
  const targetQueue = createTargetOperationQueue();
  const authority = {
    async inspectPreparedTarget(value) {
      trace.push(['inspect', value]);
      return { ok: true, target: TARGET };
    },
    async claimPreparedTarget(value) {
      trace.push(['claim', value]);
      return { ok: true, target: TARGET };
    },
    ...overrides.authority,
  };
  const personaCoordinator = {
    async claimLocked(value) {
      trace.push(['claim-lease', value.target, value.mode]);
      targetQueue.assertHeld(value.lock, value.target);
      return { ok: true, lease: { leaseId: `lease-${'L'.repeat(22)}`, activeMode: value.mode, expiresAt: 300 } };
    },
    async rehydrateLocked(value) {
      trace.push(['rehydrate-lease', value.target]);
      targetQueue.assertHeld(value.lock, value.target);
      return { ok: true, lease: { leaseId: `lease-${'L'.repeat(22)}`, activeMode: 'reader', expiresAt: 300 } };
    },
    ...overrides.personaCoordinator,
  };
  return {
    trace,
    orchestrator: createPersonaStartOrchestrator({ authority, targetQueue, personaCoordinator }),
  };
}

test('inspects then serializes a fresh persona claim and runtime installation on the exact target', async () => {
  const { orchestrator, trace } = fixture();
  const result = await orchestrator.start({
    capabilityId: CAPABILITY,
    mode: 'reader',
    senderContext: CONTEXT,
    consumer: CONSUMER,
  });

  assert.deepEqual(result, {
    ok: true,
    lease: { leaseId: `lease-${'L'.repeat(22)}`, activeMode: 'reader', expiresAt: 300 },
  });
  assert.deepEqual(trace.map(row => row[0]), ['inspect', 'claim', 'claim-lease']);
  assert.deepEqual(trace[0][1], {
    capabilityId: CAPABILITY,
    intent: 'start-persona',
    senderContext: CONTEXT,
  });
  assert.deepEqual(trace[1][1], trace[0][1]);
});

test('rehydration consumes a fresh target capability under the same target lock', async () => {
  const { orchestrator, trace } = fixture();
  const result = await orchestrator.rehydrate({
    capabilityId: CAPABILITY,
    senderContext: CONTEXT,
    consumer: CONSUMER,
  });

  assert.equal(result.ok, true);
  assert.equal(result.lease.activeMode, 'reader');
  assert.deepEqual(trace.map(row => row[0]), ['inspect', 'claim', 'rehydrate-lease']);
});

test('a changed target after inspection consumes no coordinator operation', async () => {
  const changed = Object.freeze({ ...TARGET, documentId: 'document-changed' });
  const { orchestrator, trace } = fixture({
    authority: {
      async claimPreparedTarget(value) {
        trace.push(['claim', value]);
        return { ok: true, target: changed };
      },
    },
  });

  assert.deepEqual(await orchestrator.start({
    capabilityId: CAPABILITY,
    mode: 'motor',
    senderContext: CONTEXT,
    consumer: CONSUMER,
  }), { ok: false, code: 'CAPABILITY_UNAVAILABLE' });
  assert.deepEqual(trace.map(row => row[0]), ['inspect', 'claim']);
});

test('invalid and accessor-backed requests are denied before capability inspection', async () => {
  const { orchestrator, trace } = fixture();
  let getterCalls = 0;
  const accessor = {
    capabilityId: CAPABILITY,
    senderContext: CONTEXT,
    consumer: CONSUMER,
  };
  Object.defineProperty(accessor, 'mode', {
    enumerable: true,
    get() { getterCalls += 1; return 'reader'; },
  });

  for (const request of [
    { capabilityId: 'short', mode: 'reader', senderContext: CONTEXT, consumer: CONSUMER },
    { capabilityId: CAPABILITY, mode: 'visual', senderContext: CONTEXT, consumer: CONSUMER },
    { capabilityId: CAPABILITY, mode: 'reader', senderContext: CONTEXT, consumer: CONSUMER, tabId: 17 },
    accessor,
  ]) {
    assert.deepEqual(await orchestrator.start(request), { ok: false, code: 'CAPABILITY_UNAVAILABLE' });
  }
  assert.equal(getterCalls, 0);
  assert.deepEqual(trace, []);
});
