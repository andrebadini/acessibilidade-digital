import assert from 'node:assert/strict';
import test from 'node:test';

import { createPanelPersonaSession } from '../../src/panel/persona-session.js';

const LEASE_ID = `lease-${'L'.repeat(22)}`;
const CAPABILITY_ID = 'P'.repeat(22);

function lease(activeMode, overrides = {}) {
  return {
    ok: true,
    lease: { leaseId: LEASE_ID, activeMode, expiresAt: 1_788_001_800_000, ...overrides },
  };
}

function readerState(overrides = {}) {
  return {
    ok: true,
    readerState: {
      version: 1, playback: 'playing', index: 0, total: 2,
      caption: 'Primeiro, botão', canPrevious: false, canNext: true,
      speechAvailability: 'unavailable', voiceId: '', rate: 1,
      ...overrides,
    },
  };
}

function fixture(responses) {
  const calls = [];
  const events = [];
  let request = 0;
  const session = createPanelPersonaSession({
    async requestIntent(envelope) {
      calls.push(structuredClone(envelope));
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return structuredClone(response);
    },
    createRequestId() { request += 1; return `persona-request-${request}`; },
    onEvent(event) { events.push(structuredClone(event)); },
  });
  return { session, calls, events, responses };
}

test('rehydrates the exact active persona when a Side Panel is opened again and keeps an explicit stop path', async () => {
  const f = fixture([
    { ok: true, requestId: 'persona-request-1', capabilityId: CAPABILITY_ID },
    lease('motor'),
    { ok: true, lease: null },
  ]);

  assert.deepEqual(await f.session.synchronize(), { ok: true, state: 'active', mode: 'keyboard' });
  assert.deepEqual(f.calls.slice(0, 2), [
    { type: 'PREPARE_PANEL_PERSONA_CAPABILITY', requestId: 'persona-request-1' },
    { type: 'PANEL_REHYDRATE_PERSONA', capabilityId: CAPABILITY_ID },
  ]);
  assert.deepEqual(f.events, [{ type: 'PERSONA_SELECTED', mode: 'keyboard' }]);

  assert.deepEqual(await f.session.stop(), { ok: true, state: 'none' });
  assert.deepEqual(f.calls.at(-1), { type: 'PANEL_STOP_PERSONA', leaseId: LEASE_ID });
  assert.deepEqual(f.events.at(-1), { type: 'PERSONA_ENDED' });
});

test('retains a newly granted reader lease when the first state query fails so Encerrar still works', async () => {
  const f = fixture([
    { ok: true, requestId: 'persona-request-1', capabilityId: CAPABILITY_ID },
    lease('reader'),
    { ok: false, code: 'PERSONA_READER_RUNTIME_FAILED' },
    { ok: true, lease: null },
  ]);

  assert.deepEqual(await f.session.select('reader'), { ok: true, state: 'active', mode: 'reader', readerState: false });
  assert.deepEqual(f.events, [
    { type: 'PERSONA_SELECTED', mode: 'reader' },
    { type: 'PERSONA_FAILED' },
  ]);
  await f.session.stop();
  assert.deepEqual(f.calls.at(-1), { type: 'PANEL_STOP_PERSONA', leaseId: LEASE_ID });
  assert.deepEqual(f.events.at(-1), { type: 'PERSONA_ENDED' });
});

test('recovers the incumbent persona when a fresh start reports a conflict after a missed bootstrap sync', async () => {
  const f = fixture([
    { ok: true, requestId: 'persona-request-1', capabilityId: CAPABILITY_ID },
    { ok: false, code: 'PERSONA_CONFLICT' },
    { ok: true, requestId: 'persona-request-2', capabilityId: CAPABILITY_ID },
    lease('motor'),
    { ok: true, lease: null },
  ]);

  assert.deepEqual(await f.session.select('keyboard'), { ok: true, state: 'active', mode: 'keyboard' });
  assert.deepEqual(f.calls.map(call => call.type), [
    'PREPARE_PANEL_PERSONA_CAPABILITY', 'PANEL_START_PERSONA',
    'PREPARE_PANEL_PERSONA_CAPABILITY', 'PANEL_REHYDRATE_PERSONA',
  ]);
  await f.session.stop();
  assert.deepEqual(f.calls.at(-1), { type: 'PANEL_STOP_PERSONA', leaseId: LEASE_ID });
});

test('recovers from an autonomously revoked lease and starts the newly selected persona in the same click', async () => {
  const replacementLeaseId = `lease-${'N'.repeat(22)}`;
  const f = fixture([
    { ok: true, requestId: 'persona-request-1', capabilityId: CAPABILITY_ID },
    lease('motor'),
    { ok: false, code: 'PERSONA_REVOKED_AFTER_RUNTIME_FAILURE' },
    { ok: true, requestId: 'persona-request-2', capabilityId: CAPABILITY_ID },
    lease('achromatopsia', { leaseId: replacementLeaseId }),
  ]);

  await f.session.select('keyboard');
  assert.deepEqual(await f.session.select('achromatopsia'), {
    ok: true,
    state: 'active',
    mode: 'achromatopsia',
  });
  assert.deepEqual(f.calls.slice(2), [
    { type: 'PANEL_SET_PERSONA_MODE', leaseId: LEASE_ID, mode: 'achromatopsia' },
    { type: 'PREPARE_PANEL_PERSONA_CAPABILITY', requestId: 'persona-request-2' },
    { type: 'PANEL_START_PERSONA', capabilityId: CAPABILITY_ID, mode: 'achromatopsia' },
  ]);
  assert.deepEqual(f.events.slice(-2), [
    { type: 'PERSONA_ENDED' },
    { type: 'PERSONA_SELECTED', mode: 'achromatopsia' },
  ]);
});

test('rehydrates after an ambiguous persona failure so the panel does not remain on an unverified lease', async () => {
  const f = fixture([
    { ok: true, requestId: 'persona-request-1', capabilityId: CAPABILITY_ID },
    lease('motor'),
    { ok: false, code: 'PERSONA_STATE_FAILED' },
    { ok: true, requestId: 'persona-request-2', capabilityId: CAPABILITY_ID },
    lease('motor'),
    lease('achromatopsia'),
  ]);

  await f.session.select('keyboard');
  assert.deepEqual(await f.session.select('achromatopsia'), {
    ok: false,
    code: 'PANEL_PERSONA_START_FAILED',
  });
  assert.deepEqual(f.calls.slice(2, 5).map(call => call.type), [
    'PANEL_SET_PERSONA_MODE',
    'PREPARE_PANEL_PERSONA_CAPABILITY',
    'PANEL_REHYDRATE_PERSONA',
  ]);
  assert.deepEqual(f.events.at(-1), { type: 'PERSONA_SELECTED', mode: 'keyboard' });

  assert.deepEqual(await f.session.select('achromatopsia'), {
    ok: true,
    state: 'active',
    mode: 'achromatopsia',
  });
});

test('clears an autonomously revoked reader lease when a reader control reports absence', async () => {
  const f = fixture([
    { ok: true, requestId: 'persona-request-1', capabilityId: CAPABILITY_ID },
    lease('reader'),
    readerState(),
    { ok: false, code: 'PERSONA_READER_ACTION_TERMINAL' },
    { ok: true, requestId: 'persona-request-2', capabilityId: CAPABILITY_ID },
    lease('motor'),
  ]);

  await f.session.select('reader');
  assert.deepEqual(await f.session.readerAction('next'), {
    ok: false,
    code: 'PANEL_PERSONA_ENDED',
  });
  assert.deepEqual(f.events.at(-1), { type: 'PERSONA_ENDED' });

  await f.session.select('keyboard');
  assert.deepEqual(f.calls.at(-1), {
    type: 'PANEL_START_PERSONA', capabilityId: CAPABILITY_ID, mode: 'motor',
  });
});

test('treats an absent lease as already stopped and leaves the panel ready for a fresh persona', async () => {
  const f = fixture([
    { ok: true, requestId: 'persona-request-1', capabilityId: CAPABILITY_ID },
    lease('motor'),
    { ok: false, code: 'PERSONA_TARGET_CHANGED' },
    { ok: true, requestId: 'persona-request-2', capabilityId: CAPABILITY_ID },
    lease('achromatopsia'),
  ]);

  await f.session.select('keyboard');
  assert.deepEqual(await f.session.stop(), { ok: true, state: 'none' });
  assert.deepEqual(f.events.at(-1), { type: 'PERSONA_ENDED' });

  await f.session.select('achromatopsia');
  assert.deepEqual(f.calls.at(-1), {
    type: 'PANEL_START_PERSONA', capabilityId: CAPABILITY_ID, mode: 'achromatopsia',
  });
});

test('reconciles a failed audit start instead of retaining an obsolete local persona grant', async () => {
  const f = fixture([
    { ok: true, requestId: 'persona-request-1', capabilityId: CAPABILITY_ID },
    lease('motor'),
    { ok: true, requestId: 'persona-request-2', capabilityId: CAPABILITY_ID },
    { ok: false, code: 'PERSONA_NOT_FOUND' },
    { ok: true, requestId: 'persona-request-3', capabilityId: CAPABILITY_ID },
    lease('achromatopsia'),
  ]);

  await f.session.select('keyboard');
  assert.deepEqual(await f.session.afterAuditAttempt({ started: false }), { ok: true, state: 'none' });
  assert.deepEqual(f.events.at(-1), { type: 'PERSONA_SYNCHRONIZED_NONE' });
  await f.session.select('achromatopsia');
  assert.equal(f.calls.some(call => call.type === 'PANEL_SET_PERSONA_MODE'), false);
  assert.deepEqual(f.calls.at(-1), {
    type: 'PANEL_START_PERSONA', capabilityId: CAPABILITY_ID, mode: 'achromatopsia',
  });
});

test('preserves a known persona stop path when audit-failure reconciliation is inconclusive', async () => {
  const f = fixture([
    { ok: true, requestId: 'persona-request-1', capabilityId: CAPABILITY_ID },
    lease('motor'),
    { ok: true, requestId: 'persona-request-2', capabilityId: CAPABILITY_ID },
    { ok: false, code: 'CAPABILITY_UNAVAILABLE' },
    { ok: true, lease: null },
  ]);

  await f.session.select('keyboard');
  assert.deepEqual(await f.session.afterAuditAttempt({ started: false }), {
    ok: false,
    code: 'PANEL_PERSONA_SYNC_FAILED',
  });
  assert.deepEqual(f.events.at(-1), { type: 'PERSONA_FAILED' });

  await f.session.stop();
  assert.deepEqual(f.calls.at(-1), { type: 'PANEL_STOP_PERSONA', leaseId: LEASE_ID });
  assert.deepEqual(f.events.at(-1), { type: 'PERSONA_ENDED' });
});

test('a successful audit start clears the local persona grant without a second privileged request', async () => {
  const f = fixture([
    { ok: true, requestId: 'persona-request-1', capabilityId: CAPABILITY_ID },
    lease('motor'),
  ]);
  await f.session.select('keyboard');
  const callCount = f.calls.length;
  assert.deepEqual(await f.session.afterAuditAttempt({ started: true }), { ok: true, state: 'none' });
  assert.equal(f.calls.length, callCount);
  assert.deepEqual(f.events.at(-1), { type: 'PERSONA_ENDED' });
});

test('activates speech only after the user explicitly requests a bounded local voice inventory', async () => {
  const f = fixture([
    { ok: true, requestId: 'persona-request-1', capabilityId: CAPABILITY_ID },
    lease('reader'),
    readerState(),
    readerState({ speechAvailability: 'available', voiceId: 'local-pt', rate: 1 }),
  ]);
  await f.session.select('reader');

  assert.deepEqual(await f.session.enableVoice(), { ok: true, state: 'active', voiceId: 'local-pt' });
  assert.deepEqual(f.calls.at(-1), { type: 'PANEL_READER_ENABLE_VOICE', leaseId: LEASE_ID });
  assert.deepEqual(f.events.at(-1), {
    type: 'PERSONA_READER_STATE',
    version: 1, playback: 'playing', index: 0, total: 2,
    caption: 'Primeiro, botão', canPrevious: false, canNext: true,
    speechAvailability: 'available', voiceId: 'local-pt', rate: 1,
  });
  assert.equal(JSON.stringify(f.calls).includes('tabId'), false);
  assert.equal(JSON.stringify(f.calls).includes('documentId'), false);
});

test('reports the absence of a local voice without inventing a fallback or discarding the reader lease', async () => {
  const f = fixture([
    { ok: true, requestId: 'persona-request-1', capabilityId: CAPABILITY_ID },
    lease('reader'),
    readerState(),
    { ok: false, code: 'PERSONA_READER_VOICE_UNAVAILABLE' },
    { ok: true, lease: null },
  ]);
  await f.session.select('reader');
  assert.deepEqual(await f.session.enableVoice(), { ok: false, code: 'VOICE_UNAVAILABLE' });
  assert.deepEqual(f.events.at(-1), { type: 'PERSONA_READER_VOICE_UNAVAILABLE' });
  assert.equal(f.calls.some(call => call.type === 'PANEL_READER_ENABLE_VOICE'), true);
  await f.session.stop();
  assert.deepEqual(f.calls.at(-1), { type: 'PANEL_STOP_PERSONA', leaseId: LEASE_ID });
});
