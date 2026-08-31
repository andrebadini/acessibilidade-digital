import assert from 'node:assert/strict';
import test from 'node:test';

async function completionModule() {
  return import('../../src/export/export-completion.js').catch(() => ({}));
}

const REQUEST = Object.freeze({
  auditId: 'audit-1',
  sessionCapabilityId: 'S'.repeat(22),
  attemptId: '7',
});

test('completion acknowledgement keeps retrying after one failed burst until the exact terminal ACK arrives', async () => {
  const { awaitExportCompletionAcknowledgement } = await completionModule();
  assert.equal(typeof awaitExportCompletionAcknowledgement, 'function');
  const messages = [];
  const waits = [];
  let calls = 0;

  const result = await awaitExportCompletionAcknowledgement(REQUEST, {
    async send(message) {
      messages.push(message);
      calls += 1;
      return calls === 4
        ? { ok: true, auditId: REQUEST.auditId, state: 'terminal' }
        : { ok: false };
    },
    async wait(delay) { waits.push(delay); },
  }, { requestTimeoutMs: 10, initialRetryDelayMs: 5, maxRetryDelayMs: 20 });

  assert.deepEqual(result, { ok: true, auditId: REQUEST.auditId, state: 'terminal' });
  assert.equal(messages.length, 4);
  assert.deepEqual(messages[0], {
    type: 'EXPORT_COMPLETE',
    sessionCapabilityId: REQUEST.sessionCapabilityId,
    auditId: REQUEST.auditId,
    attemptId: REQUEST.attemptId,
  });
  assert.deepEqual(waits, [5]);
});

test('completion acknowledgement bounds a missing worker response and rejects malformed or hostile success envelopes', async () => {
  const { awaitExportCompletionAcknowledgement } = await completionModule();
  let calls = 0;
  let getterReads = 0;
  const hostile = Object.defineProperty({}, 'ok', {
    enumerable: true,
    get() { getterReads += 1; throw new Error('PRIVATE_ACK'); },
  });

  const result = await awaitExportCompletionAcknowledgement(REQUEST, {
    send() {
      calls += 1;
      if (calls === 1) return new Promise(() => {});
      if (calls === 2) return hostile;
      if (calls === 3) return { ok: true, auditId: 'other-audit', state: 'terminal' };
      return { ok: true, auditId: REQUEST.auditId, state: 'terminal' };
    },
    async wait() {},
  }, { requestTimeoutMs: 5, initialRetryDelayMs: 1, maxRetryDelayMs: 2 });

  assert.equal(calls, 4);
  assert.equal(getterReads, 0);
  assert.deepEqual(result, { ok: true, auditId: REQUEST.auditId, state: 'terminal' });
});
