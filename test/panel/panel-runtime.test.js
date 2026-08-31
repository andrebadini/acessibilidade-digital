import assert from 'node:assert/strict';
import test from 'node:test';

import { createInitialPanelState, reducePanelState } from '../../src/panel/panel-state.js';

const priorDocument = globalThis.document;
globalThis.document = { querySelector() { return null; } };
const runtime = await import(`../../src/panel/panel.js?panel-runtime-test=${Date.now()}`);
if (priorDocument === undefined) delete globalThis.document;
else globalThis.document = priorDocument;

const {
  createPanelAttachedAuditIntent,
  createPanelPrivacyConfirmationController,
  projectPanelBootstrapEvent,
} = runtime;

const PRIVACY_MESSAGE = 'A página contém conteúdo potencialmente sensível. Confirme para capturar imagens visíveis.';

function pausedState(mode = 'full-evidence', categories = ['password']) {
  let state = reducePanelState(createInitialPanelState(), {
    type: 'CAPTURE_MODE_SELECTED', mode, focusId: `capture-mode-${mode}`,
  });
  state = reducePanelState(state, { type: 'START_REQUESTED' });
  state = reducePanelState(state, { type: 'AUDIT_RUNNING', auditId: 'audit-private' });
  return reducePanelState(state, {
    type: 'PRIVACY_PAUSED', auditId: 'audit-private', mode, categories, message: PRIVACY_MESSAGE,
  });
}

function deferred() {
  let resolve;
  const promise = new Promise(settle => { resolve = settle; });
  return { promise, resolve };
}

test('builds the exact attached start envelope from each user-selected capture mode', () => {
  for (const mode of ['full-evidence', 'element-only', 'no-pixels']) {
    assert.deepEqual(createPanelAttachedAuditIntent({
      capabilityId: 'C'.repeat(22), captureMode: mode,
    }), {
      type: 'PANEL_START_ATTACHED_AUDIT', capabilityId: 'C'.repeat(22), captureMode: mode,
      includeQuery: false, deleteAfterCompleteExport: false,
    });
  }
  for (const input of [
    { capabilityId: 'short', captureMode: 'full-evidence' },
    { capabilityId: 'C'.repeat(22), captureMode: 'pixels' },
    { capabilityId: 'C'.repeat(22), captureMode: 'full-evidence', extra: 'PRIVATE' },
  ]) assert.equal(createPanelAttachedAuditIntent(input), null);
});

test('projects only the safe privacy bootstrap fields and rejects hostile transport shapes', () => {
  const safe = {
    state: 'privacy-paused', auditId: 'audit-private', result: null,
    mode: 'full-evidence', categories: ['password', 'payment'], message: PRIVACY_MESSAGE,
  };
  assert.deepEqual(projectPanelBootstrapEvent(safe), {
    type: 'PRIVACY_PAUSED', auditId: 'audit-private', mode: 'full-evidence',
    categories: ['password', 'payment'], message: PRIVACY_MESSAGE,
  });
  assert.equal(Object.isFrozen(projectPanelBootstrapEvent(safe)), true);
  assert.equal(Object.isFrozen(projectPanelBootstrapEvent(safe).categories), true);

  for (const hostile of [
    { ...safe, consentId: 'PRIVATE' },
    Object.assign({ ...safe }, { [Symbol('private')]: true }),
    Object.defineProperty({ ...safe }, 'mode', { enumerable: true, get() { throw new Error('PRIVATE'); } }),
    new Proxy(safe, { ownKeys() { throw new Error('PRIVATE'); } }),
  ]) assert.equal(projectPanelBootstrapEvent(hostile), null);
});

test('marks confirmation pending before one exact safe request and blocks a second click', async () => {
  let state = pausedState();
  const sent = [];
  const gate = deferred();
  let pendingWasVisible = false;
  const controller = createPanelPrivacyConfirmationController({
    readState: () => state,
    transition(event) { state = reducePanelState(state, event); },
    requestIntent(intent) {
      pendingWasVisible = state.privacy.confirmationPending;
      sent.push(structuredClone(intent));
      return gate.promise;
    },
    announce() {},
  });

  const first = controller.confirm({ type: 'CONFIRM_PIXEL_CAPTURE', mode: 'full-evidence', accepted: true });
  const second = await controller.confirm({ type: 'CONFIRM_PIXEL_CAPTURE', mode: 'full-evidence', accepted: true });
  assert.equal(pendingWasVisible, true);
  assert.equal(second, false);
  assert.deepEqual(sent, [{ type: 'CONFIRM_PIXEL_CAPTURE', mode: 'full-evidence', accepted: true }]);
  assert.doesNotMatch(JSON.stringify({ state, sent }), /consent|capability|documentId|tabId|digest|PRIVATE/u);

  gate.resolve({ ok: true, state: 'running' });
  assert.equal(await first, true);
  assert.equal(state.sessionStatus, 'privacy-paused', 'only an authoritative running bootstrap clears the pause');
});

test('a rotated pause rearms confirmation and a stale response cannot alter the new pause', async () => {
  let state = pausedState();
  const requests = [];
  const announcements = [];
  const controller = createPanelPrivacyConfirmationController({
    readState: () => state,
    transition(event) { state = reducePanelState(state, event); },
    requestIntent(intent) {
      const gate = deferred();
      requests.push({ intent: structuredClone(intent), gate });
      return gate.promise;
    },
    announce(message) { announcements.push(message); },
  });

  const first = controller.confirm({ type: 'CONFIRM_PIXEL_CAPTURE', mode: 'full-evidence', accepted: true });
  state = reducePanelState(state, {
    type: 'PRIVACY_PAUSED', auditId: 'audit-private', mode: 'element-only',
    categories: ['private-marker'], message: PRIVACY_MESSAGE,
  });
  assert.equal(state.privacy.confirmationPending, false);

  requests[0].gate.resolve({ ok: false, code: 'STALE_PRIVATE_RESPONSE' });
  assert.equal(await first, false);
  assert.deepEqual(state.privacy, {
    mode: 'element-only', categories: ['private-marker'], message: PRIVACY_MESSAGE, confirmationPending: false,
  });
  assert.deepEqual(announcements, [], 'a stale response does not announce over the current pause');

  const second = controller.confirm({ type: 'CONFIRM_PIXEL_CAPTURE', mode: 'element-only', accepted: true });
  assert.deepEqual(requests[1].intent, {
    type: 'CONFIRM_PIXEL_CAPTURE', mode: 'element-only', accepted: true,
  });
  requests[1].gate.resolve({ ok: true, state: 'running' });
  assert.equal(await second, true);
});

test('confirmation controller rejects malformed and mismatched UI intents without transport effects', async () => {
  let state = pausedState();
  let calls = 0;
  const controller = createPanelPrivacyConfirmationController({
    readState: () => state,
    transition(event) { state = reducePanelState(state, event); },
    async requestIntent() { calls += 1; return { ok: true, state: 'running' }; },
    announce() {},
  });
  const safe = { type: 'CONFIRM_PIXEL_CAPTURE', mode: 'full-evidence', accepted: true };
  for (const hostile of [
    { ...safe, mode: 'element-only' },
    { ...safe, accepted: false },
    { ...safe, consentId: 'PRIVATE' },
    Object.assign({ ...safe }, { [Symbol('private')]: true }),
    Object.defineProperty({ ...safe }, 'mode', { enumerable: true, get() { throw new Error('PRIVATE'); } }),
    new Proxy(safe, { ownKeys() { throw new Error('PRIVATE'); } }),
  ]) assert.equal(await controller.confirm(hostile), false);
  assert.equal(calls, 0);
});

test('announces document drift exactly and normalizes malformed failure responses', async () => {
  async function confirmWith(response) {
    let state = pausedState();
    const announcements = [];
    const controller = createPanelPrivacyConfirmationController({
      readState: () => state,
      transition(event) { state = reducePanelState(state, event); },
      async requestIntent() { return response; },
      announce(message) { announcements.push(message); },
    });
    const confirmed = await controller.confirm({
      type: 'CONFIRM_PIXEL_CAPTURE', mode: 'full-evidence', accepted: true,
    });
    return { confirmed, announcements };
  }

  assert.deepEqual(await confirmWith({ ok: false, code: 'PIXEL_CONSENT_DOCUMENT_CHANGED' }), {
    confirmed: false,
    announcements: ['A página mudou; inicie uma nova avaliação.'],
  });

  for (const hostile of [
    { ok: false, code: 'PIXEL_CONSENT_DOCUMENT_CHANGED', extra: 'PRIVATE' },
    Object.defineProperty({ ok: false }, 'code', {
      enumerable: true, get() { throw new Error('PRIVATE'); },
    }),
    Object.assign({ ok: false, code: 'PIXEL_CONSENT_DOCUMENT_CHANGED' }, { [Symbol('private')]: true }),
  ]) {
    const result = await confirmWith(hostile);
    assert.deepEqual(result, {
      confirmed: false,
      announcements: ['Não foi possível confirmar a captura. Cancele a auditoria ou aguarde uma nova confirmação.'],
    });
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|PIXEL_CONSENT_DOCUMENT_CHANGED/u);
  }
});
