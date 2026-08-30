import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createAbsentHighlightCleaner,
  createLiveAidCleanup,
} from '../../src/background/live-aid-cleanup.js';

const target = Object.freeze({
  tabId: 7,
  windowId: 3,
  documentId: 'document-main',
  urlSessionDigest: `hmac-sha256:${'A'.repeat(43)}`,
});

function queueFixture(trace = []) {
  const held = Object.freeze(Object.create(null));
  return {
    held,
    queue: {
      assertHeld(lock, receivedTarget) {
        trace.push('assert-lock');
        if (lock !== held || receivedTarget !== target) throw new Error('LOCK_DENIED');
        return true;
      },
    },
  };
}

test('clears highlight then persona under the one held target lock', async () => {
  const trace = [];
  const { queue, held } = queueFixture(trace);
  const cleanup = createLiveAidCleanup({
    targetQueue: queue,
    highlightCleaner: {
      async clearForTargetLocked(receivedTarget, reason, lock) {
        assert.strictEqual(receivedTarget, target);
        assert.strictEqual(lock, held);
        assert.equal(reason, 'audit-start');
        trace.push('clear-highlight');
        return { ok: true, state: 'absent' };
      },
    },
    personaCoordinator: {
      async revokeTargetLocked(args) {
        assert.deepEqual(args, { target, reason: 'audit-start', lock: held });
        trace.push('clear-persona');
        return { ok: true, state: 'revoked' };
      },
    },
  });

  assert.deepEqual(await cleanup.clearForAuditLocked({ target, lock: held }), {
    ok: true,
    state: 'clear',
  });
  assert.deepEqual(trace, ['assert-lock', 'clear-highlight', 'clear-persona']);
});

test('blocks audit and reports the first cleanup failure after attempting both aids', async () => {
  for (const failing of ['highlight', 'persona']) {
    const trace = [];
    const { queue, held } = queueFixture(trace);
    const cleanup = createLiveAidCleanup({
      targetQueue: queue,
      highlightCleaner: {
        async clearForTargetLocked() {
          trace.push('clear-highlight');
          return failing === 'highlight'
            ? { ok: false, code: 'HIGHLIGHT_CLEANUP_UNCONFIRMED' }
            : { ok: true, state: 'absent' };
        },
      },
      personaCoordinator: {
        async revokeTargetLocked() {
          trace.push('clear-persona');
          return failing === 'persona'
            ? { ok: false, code: 'PERSONA_CLEANUP_UNCONFIRMED' }
            : { ok: true, state: 'absent' };
        },
      },
    });

    assert.deepEqual(await cleanup.clearForAuditLocked({ target, lock: held }), {
      ok: false,
      code: failing === 'highlight'
        ? 'HIGHLIGHT_CLEANUP_UNCONFIRMED'
        : 'PERSONA_CLEANUP_UNCONFIRMED',
    });
    assert.deepEqual(trace, ['assert-lock', 'clear-highlight', 'clear-persona']);
  }
});

test('does not accept malformed success envelopes as proof of cleanup', async () => {
  for (const malformed of ['highlight', 'persona']) {
    const { queue, held } = queueFixture();
    const cleanup = createLiveAidCleanup({
      targetQueue: queue,
      highlightCleaner: {
        async clearForTargetLocked() {
          return malformed === 'highlight' ? { ok: true } : { ok: true, state: 'absent' };
        },
      },
      personaCoordinator: {
        async revokeTargetLocked() {
          return malformed === 'persona' ? { ok: true, state: 'active' } : { ok: true, state: 'absent' };
        },
      },
    });
    assert.deepEqual(await cleanup.clearForAuditLocked({ target, lock: held }), {
      ok: false,
      code: malformed === 'highlight'
        ? 'HIGHLIGHT_CLEANUP_UNCONFIRMED'
        : 'PERSONA_CLEANUP_UNCONFIRMED',
    });
  }
});

test('rejects malformed calls and a counterfeit lock before touching either aid', async () => {
  const trace = [];
  const { queue } = queueFixture(trace);
  const cleanup = createLiveAidCleanup({
    targetQueue: queue,
    highlightCleaner: { async clearForTargetLocked() { trace.push('highlight'); } },
    personaCoordinator: { async revokeTargetLocked() { trace.push('persona'); } },
  });
  await assert.rejects(
    () => cleanup.clearForAuditLocked({ target, lock: Object.freeze({}) }),
    /LOCK_DENIED/u,
  );
  await assert.rejects(
    () => cleanup.clearForAuditLocked({ target, lock: null, extra: true }),
    /LIVE_AID_CLEANUP_INPUT_INVALID/u,
  );
  assert.deepEqual(trace, ['assert-lock']);
});

function sessionFixture(envelope) {
  const calls = [];
  return {
    calls,
    area: {
      async get(key) {
        calls.push(['get', key]);
        if (envelope instanceof Error) throw envelope;
        return envelope;
      },
    },
  };
}

test('transitional highlight cleaner confirms absence only from an exact empty envelope', async () => {
  const trace = [];
  const { queue, held } = queueFixture(trace);
  const session = sessionFixture({});
  const cleaner = createAbsentHighlightCleaner({ sessionArea: session.area, targetQueue: queue });

  assert.deepEqual(await cleaner.clearForTargetLocked(target, 'audit-start', held), {
    ok: true,
    state: 'absent',
  });
  assert.deepEqual(session.calls, [['get', 'audita:highlight-bindings:v1']]);
  assert.deepEqual(trace, ['assert-lock']);
});

test('transitional highlight cleaner fails closed for any stored, hostile or unreadable value', async () => {
  const hostile = {};
  Object.defineProperty(hostile, 'audita:highlight-bindings:v1', {
    enumerable: true,
    get() { throw new Error('ACCESSOR_READ'); },
  });
  const inherited = Object.create({ inherited: true });
  const cases = [
    { 'audita:highlight-bindings:v1': undefined },
    { 'audita:highlight-bindings:v1': null },
    { unexpected: true },
    hostile,
    inherited,
    new Error('STORAGE_PRIVATE'),
  ];
  for (const envelope of cases) {
    const { queue, held } = queueFixture();
    const session = sessionFixture(envelope);
    const cleaner = createAbsentHighlightCleaner({ sessionArea: session.area, targetQueue: queue });
    assert.deepEqual(await cleaner.clearForTargetLocked(target, 'audit-start', held), {
      ok: false,
      code: 'HIGHLIGHT_CLEANUP_UNCONFIRMED',
    });
  }
});

test('transitional cleaner accepts only the internal audit-start call shape', async () => {
  const { queue, held } = queueFixture();
  const session = sessionFixture({});
  const cleaner = createAbsentHighlightCleaner({ sessionArea: session.area, targetQueue: queue });
  await assert.rejects(
    () => cleaner.clearForTargetLocked(target, 'navigation', held),
    /HIGHLIGHT_CLEANER_INPUT_INVALID/u,
  );
  await assert.rejects(
    () => cleaner.clearForTargetLocked(target, 'audit-start', null),
    /LOCK_DENIED/u,
  );
  assert.deepEqual(session.calls, []);
});
