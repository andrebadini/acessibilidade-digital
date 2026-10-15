import assert from 'node:assert/strict';
import test from 'node:test';

import { createPageRelocationOfferStore } from '../../src/background/page-relocation-offer.js';
import { DIGEST, INSTALLATION_ID, SESSION_ID, createControllerFixture, deferred } from './page-markers-controller-fixture.js';

async function waitForNativePort(fixture) {
  for (let attempt = 0; attempt < 5_000; attempt += 1) {
    const port = fixture.latestPort();
    if (port) return port;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error('a porta nativa não apareceu dentro do limite de turnos do teste');
}

test('idless evidence flows through the authorized controller into a real marker and selection', async () => {
  const fixture = await createControllerFixture({ omitNullArguments: true, changeDraft(draft) {
    draft.evidence[1].selector.css = 'main > button';
    draft.evidence[1].snippet = '<button class="primary action">Continuar</button>';
  } });
  fixture.page.first.removeAttribute('id');
  fixture.page.first.setAttribute('class', 'primary action');
  const result = await fixture.dispatch('PANEL_SHOW_PAGE_MARKERS');
  assert.equal(result.ok, true);
  assert.equal(result.markers.counts.located, 2);
  const injected = fixture.calls.scripts.find(call => call.func.name === 'runAuditaPageMarkersCommand' && call.args[0].op === 'install');
  assert.equal(Object.hasOwn(injected.args[0].targets[0].match, 'id'), false,
    'the wire command must not depend on null dictionary fields preserved by Node but omitted by Chrome');
  assert.equal(fixture.page.environment.markerButtons().length, 1);
  const selected = await fixture.dispatch('PANEL_SELECT_PAGE_MARKER', { ordinal: 2, scroll: true });
  assert.equal(selected.ok, true);
  assert.equal(fixture.page.first.scrollCalls.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /primary|action|Continuar/u);
});

test('idless controller keeps different class identities separate even when tag and absent ID agree', async () => {
  const fixture = await createControllerFixture({ changeDraft(draft) {
    const source = draft.occurrences.find(row => row.occurrenceId === 'occ-focus-review');
    draft.evidence[1].selector.css = 'button:nth-of-type(1)';
    draft.evidence[1].snippet = '<button class="primary">Continuar</button>';
    draft.ruleResults.find(row => row.ruleId === 'focus-order').targets.push('node-second');
    draft.occurrences.push({ ...structuredClone(source), occurrenceId: 'occ-review-second', nodeId: 'node-second',
      target: { nodeId: 'node-second', selector: null, framePath: [] },
      evidenceIds: ['evidence-second'], evidenceRefs: ['evidence-second'] });
    draft.manualReview.push({ ...structuredClone(draft.manualReview[0]), occurrenceId: 'occ-review-second' });
    draft.evidence.push({ ...structuredClone(draft.evidence[1]), evidenceId: 'evidence-second', nodeId: 'node-second', backendNodeId: 42,
      selector: { css: 'button:nth-of-type(2)', framePath: [] }, snippet: '<button class="secondary">Voltar</button>' });
  } });
  fixture.page.first.removeAttribute('id');
  fixture.page.first.setAttribute('class', 'primary');
  const second = fixture.page.document.createElement('button');
  second.setAttribute('class', 'secondary');
  fixture.page.main.appendChild(second);
  const result = await fixture.dispatch('PANEL_SHOW_PAGE_MARKERS');
  assert.equal(result.ok, true);
  assert.equal(result.markers.counts.markers, 2);
  assert.equal(result.markers.counts.located, 3);
  assert.equal(fixture.page.environment.markerButtons().length, 2);
  assert.equal((await fixture.dispatch('PANEL_SELECT_PAGE_MARKER', { ordinal: 3, scroll: true })).ok, true);
  assert.equal(second.scrollCalls.length, 1);
  assert.equal(fixture.page.first.scrollCalls.length, 0);
});

test('non-ASCII class spacing cannot transfer audited findings to an unrelated element', async () => {
  for (const separator of ['\u00a0', '\u2003', '\ufeff']) {
    const fixture = await createControllerFixture({ changeDraft(draft) {
      draft.evidence[1].selector.css = 'button:nth-of-type(1)';
      draft.evidence[1].snippet = `<button class="primary${separator}action">Continuar</button>`;
    } });
    fixture.page.first.removeAttribute('id');
    fixture.page.first.setAttribute('class', `primary${separator}action`);
    const unrelated = fixture.page.document.createElement('button');
    unrelated.setAttribute('class', 'primary action');
    fixture.page.main.appendChild(unrelated);
    const result = await fixture.dispatch('PANEL_SHOW_PAGE_MARKERS');
    assert.equal(result.ok, true);
    assert.equal(result.markers.counts.located, 0);
    assert.equal((await fixture.dispatch('PANEL_SELECT_PAGE_MARKER', { ordinal: 2, scroll: true })).ok, false);
    assert.equal(unrelated.scrollCalls.length, 0);
  }
});

test('show authorizes the private panel window and returns only located physical groups and global counts', async () => {
  const fixture = await createControllerFixture();
  const originalHash = fixture.model.integrity.canonicalModelHash;

  const result = await fixture.dispatch('PANEL_SHOW_PAGE_MARKERS');

  assert.deepEqual(result, { ok: true, markers: {
    state: 'active', modelRevision: 7,
    groups: [{ number: 1, ordinals: [1, 2] }],
    counts: { markers: 1, located: 2, unlocated: 0, general: 1, omitted: 0 },
    selectedOrdinal: null, reasons: [],
  } });
  assert.equal(fixture.model.integrity.canonicalModelHash, originalHash);
  assert.deepEqual(fixture.calls.authorize[0], {
    sessionCapabilityId: SESSION_ID, auditId: fixture.model.auditId, consumer: 'panel',
    intent: 'review-markers', sender: fixture.sender, claimedWindowId: 9,
  });
  assert.equal(fixture.calls.scripts.some(call => Object.hasOwn(call.target, 'frameIds')), false);
  assert.equal(JSON.stringify(result).includes(INSTALLATION_ID), false);
  assert.deepEqual(fixture.calls.publish, [{
    windowId: 9, sessionCapabilityId: SESSION_ID, auditId: fixture.model.auditId,
    modelRevision: 7, state: 'active', selectedOrdinal: null,
  }]);
});

test('unassessed checklist records do not appear as omitted page findings', async () => {
  const fixture = await createControllerFixture();
  fixture.bundle.details = fixture.bundle.details.filter(row => row.occurrenceId === 'occ-focus-failed');
  const result = await fixture.dispatch('PANEL_SHOW_PAGE_MARKERS');
  assert.equal(result.ok, true);
  assert.equal(result.markers.counts.located, 1);
  assert.equal(result.markers.counts.omitted, 0);
});

test('authorization refusal and unavailable origin have no browser effects', async () => {
  for (const options of [{ authorized: false }, { noOrigin: true }]) {
    const fixture = await createControllerFixture(options);
    const result = await fixture.dispatch('PANEL_SHOW_PAGE_MARKERS');
    assert.deepEqual(result, { ok: false, code: options.authorized === false
      ? 'PAGE_MARKERS_NOT_AUTHORIZED' : 'PAGE_MARKERS_UNAVAILABLE' });
    assert.deepEqual(fixture.calls.probe, []);
    assert.deepEqual(fixture.calls.scripts, []);
  }
});

test('closed envelope, private window mismatch, stale revision and bundle mismatch fail closed', async () => {
  const fixture = await createControllerFixture();
  const accessor = fixture.envelope('PANEL_SHOW_PAGE_MARKERS');
  let getterReads = 0;
  Object.defineProperty(accessor, 'extra', { enumerable: true, get() { getterReads += 1; return 'private'; } });
  assert.deepEqual(await fixture.controller.dispatch({ envelope: accessor, sender: fixture.sender,
    panelWindowId: 9, isCurrent: () => true }), { ok: false, code: 'PAGE_MARKERS_INVALID' });
  assert.equal(getterReads, 0);
  assert.deepEqual(await fixture.dispatch('PANEL_SHOW_PAGE_MARKERS', {}, { panelWindowId: 8 }),
    { ok: false, code: 'PAGE_MARKERS_INVALID' });

  const stale = await createControllerFixture();
  assert.deepEqual(await stale.controller.dispatch({
    envelope: { ...stale.envelope('PANEL_SHOW_PAGE_MARKERS'), modelRevision: 6 }, sender: stale.sender,
    panelWindowId: 9, isCurrent: () => true,
  }), { ok: false, code: 'PAGE_MARKERS_STALE_RESULT' });
  const mismatch = await createControllerFixture({ bundle: { ...fixture.bundle, modelHash: 'f'.repeat(64) } });
  assert.deepEqual(await mismatch.dispatch('PANEL_SHOW_PAGE_MARKERS'),
    { ok: false, code: 'PAGE_MARKERS_STALE_RESULT' });
});

test('copy source is sanitized immediately and a redirect incompatible with the model is rejected before injection', async () => {
  const fixture = await createControllerFixture({ source: {
    version: 'AttachedCopySourceV1', tabId: 17, windowId: 9, documentId: 'document-a',
    urlSessionDigest: DIGEST, rawUrl: 'https://other.example.test/private?token=secret',
  } });
  assert.deepEqual(await fixture.dispatch('PANEL_SHOW_PAGE_MARKERS'),
    { ok: false, code: 'PAGE_MARKERS_DOCUMENT_CHANGED' });
  assert.deepEqual(fixture.calls.scripts, []);
  assert.equal(JSON.stringify(fixture.calls.publish).includes('secret'), false);
});

test('selection and filtering translate ordinals through the private table and never alter audit totals', async () => {
  const fixture = await createControllerFixture();
  await fixture.dispatch('PANEL_SHOW_PAGE_MARKERS');
  const selected = await fixture.dispatch('PANEL_SELECT_PAGE_MARKER', { ordinal: 2, scroll: true });
  assert.equal(selected.ok, true);
  assert.equal(selected.markers.selectedOrdinal, 2);
  assert.deepEqual(fixture.page.first.scrollCalls, [{ behavior: 'instant', block: 'center', inline: 'nearest' }]);
  const filtered = await fixture.dispatch('PANEL_FILTER_PAGE_MARKERS', { visibleOrdinals: '' });
  assert.equal(filtered.ok, true);
  assert.deepEqual(filtered.markers.counts, selected.markers.counts);
  assert.equal(filtered.markers.selectedOrdinal, null);
  assert.equal(fixture.page.environment.markerButtons()[0].style.display, 'none');
  assert.deepEqual(await fixture.dispatch('PANEL_SELECT_PAGE_MARKER', { ordinal: 0, scroll: false }),
    { ok: false, code: 'PAGE_MARKERS_SELECTION_UNAVAILABLE' });
  for (const visibleOrdinals of ['2,1', '01', '1,1', '64', '3']) {
    assert.deepEqual(await fixture.dispatch('PANEL_FILTER_PAGE_MARKERS', { visibleOrdinals }),
      { ok: false, code: 'PAGE_MARKERS_INVALID' });
  }
});

test('native selected event uses singular W2 name and rejects foreign senders and installation ids synchronously', async () => {
  const fixture = await createControllerFixture();
  await fixture.dispatch('PANEL_SHOW_PAGE_MARKERS');
  const sender = { id: 'extension-id', documentId: 'document-a', frameId: 0, tab: { id: 17, windowId: 9 } };
  assert.equal(fixture.controller.handleRuntimeMessage({
    type: 'AUDITA_PAGE_MARKER_SELECTED', installationId: INSTALLATION_ID, selectionId: 's3',
  }, sender), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fixture.calls.publish.at(-1).selectedOrdinal, 2);
  assert.equal(fixture.controller.handleRuntimeMessage({
    type: 'AUDITA_PAGE_MARKERS_SELECTED', installationId: INSTALLATION_ID, selectionId: 's3',
  }, sender), false);
  assert.equal(fixture.controller.handleRuntimeMessage({
    type: 'AUDITA_PAGE_MARKER_SELECTED', installationId: 'F'.repeat(22), selectionId: 's3',
  }, sender), false);
  assert.equal(fixture.controller.handleRuntimeMessage({
    type: 'AUDITA_PAGE_MARKER_SELECTED', installationId: INSTALLATION_ID, selectionId: 's3',
  }, { ...sender, frameId: 1 }), false);
});

test('hello is resolved directly by the native Port and a foreign sender cannot attach', async () => {
  const fixture = await createControllerFixture({ autoHello: false });
  const pending = fixture.dispatch('PANEL_SHOW_PAGE_MARKERS');
  // The native port appears only after several awaited authorization, probe and script steps; the
  // turn budget is generous so a loaded machine cannot exhaust it before the port is bound.
  await waitForNativePort(fixture);
  const owned = fixture.latestPort();
  assert.ok(fixture.timerDelays().includes(5_000));
  assert.equal(fixture.controller.attachPort(fixture.nativePort(INSTALLATION_ID, { frameId: 1 })), false);
  owned.hello();
  assert.equal((await pending).ok, true);
  assert.equal(fixture.timerDelays().includes(5_000), false);
});

test('audit deletion during the first authorization await invalidates the captured generation before injection', async () => {
  const gate = deferred();
  const fixture = await createControllerFixture({ authorizationGate: gate });
  const pending = fixture.dispatch('PANEL_SHOW_PAGE_MARKERS');
  const clearing = fixture.controller.clearAudit(fixture.model.auditId);
  gate.resolve();
  assert.deepEqual(await pending, { ok: false, code: 'PAGE_MARKERS_UNAVAILABLE' });
  assert.equal(await clearing, true);
  assert.deepEqual(fixture.calls.scripts, []);
  assert.deepEqual(fixture.calls.publish, []);
  assert.equal(fixture.originCache.get(fixture.model.auditId), null);
});

test('document A changing to B after installation triggers compensation only against A with no tab fallback', async () => {
  const changed = { tabId: 17, windowId: 9, documentId: 'document-b', urlSessionDigest: `hmac-sha256:${'B'.repeat(43)}` };
  const fixture = await createControllerFixture({ proofs: [
    { tabId: 17, windowId: 9, documentId: 'document-a', urlSessionDigest: DIGEST },
    { tabId: 17, windowId: 9, documentId: 'document-a', urlSessionDigest: DIGEST }, changed,
  ] });
  assert.deepEqual(await fixture.dispatch('PANEL_SHOW_PAGE_MARKERS'),
    { ok: false, code: 'PAGE_MARKERS_DOCUMENT_CHANGED' });
  assert.ok(fixture.calls.scripts.every(call => JSON.stringify(call.target) === JSON.stringify({ tabId: 17, documentIds: ['document-a'] })));
  assert.equal(fixture.calls.scripts.some(call => Object.hasOwn(call.target, 'frameIds')), false);
});

test('same document with a changed URL digest is explicitly cleared rather than presumed absent', async () => {
  const changedDigest = { tabId: 17, windowId: 9, documentId: 'document-a',
    urlSessionDigest: `hmac-sha256:${'B'.repeat(43)}` };
  const fixture = await createControllerFixture({ proofs: [
    { tabId: 17, windowId: 9, documentId: 'document-a', urlSessionDigest: DIGEST },
    { tabId: 17, windowId: 9, documentId: 'document-a', urlSessionDigest: DIGEST }, changedDigest,
  ] });
  assert.deepEqual(await fixture.dispatch('PANEL_SHOW_PAGE_MARKERS'),
    { ok: false, code: 'PAGE_MARKERS_DOCUMENT_CHANGED' });
  assert.equal(Object.hasOwn(fixture.page.environment, '__auditaPageMarkersOverlayV1'), false);
  assert.equal(fixture.calls.scripts.some(call => call.args[0]?.op === 'clear'), true);
});

test('document A changing during the final authorization await is rejected before any injected effect', async () => {
  const changed = { tabId: 17, windowId: 9, documentId: 'document-b', urlSessionDigest: `hmac-sha256:${'B'.repeat(43)}` };
  const fixture = await createControllerFixture({ proofs: [
    { tabId: 17, windowId: 9, documentId: 'document-a', urlSessionDigest: DIGEST }, changed,
  ] });
  assert.deepEqual(await fixture.dispatch('PANEL_SHOW_PAGE_MARKERS'),
    { ok: false, code: 'PAGE_MARKERS_DOCUMENT_CHANGED' });
  assert.deepEqual(fixture.calls.scripts, []);
});

test('hello timeout cancels while SHOW owns the lock and compensates the real W2 installation', async () => {
  const fixture = await createControllerFixture({ autoHello: false });
  const pending = fixture.dispatch('PANEL_SHOW_PAGE_MARKERS');
  // The native port appears only after several awaited authorization, probe and script steps; the
  // turn budget is generous so a loaded machine cannot exhaust it before the port is bound.
  await waitForNativePort(fixture);
  fixture.fireTimer(5_000);
  assert.deepEqual(await pending, { ok: false, code: 'PAGE_MARKERS_UNAVAILABLE' });
  assert.equal(Object.hasOwn(fixture.page.environment, '__auditaPageMarkersOverlayV1'), false);
  assert.deepEqual(fixture.calls.publish, []);
});

test('expired origin and copy/view-only session boundaries remain separate', async () => {
  const expired = await createControllerFixture({ session: {
    version: 1, sessionCapabilityId: SESSION_ID, auditId: 'audit-sample-20260826', windowId: 9,
    mode: 'attached', targetBinding: { kind: 'attached' }, state: 'result', issuedAt: 9_999, expiresAt: 80_000,
  } });
  expired.setTime(70_000);
  assert.deepEqual(await expired.dispatch('PANEL_SHOW_PAGE_MARKERS'),
    { ok: false, code: 'PAGE_MARKERS_UNAVAILABLE' });
  assert.deepEqual(expired.calls.scripts, []);

  const copy = await createControllerFixture({ session: {
    version: 1, sessionCapabilityId: SESSION_ID, auditId: expired.model.auditId, windowId: 9,
    mode: 'attached-copy', targetBinding: { kind: 'disposable' }, state: 'view-only', issuedAt: 9_999, expiresAt: 70_000,
  } });
  assert.equal((await copy.dispatch('PANEL_SHOW_PAGE_MARKERS')).ok, true);
});

test('authorization must affirm a non-batch mode instead of accepting a missing mode', async () => {
  const fixture = await createControllerFixture({ session: {
    version: 1, sessionCapabilityId: SESSION_ID, auditId: 'audit-sample-20260826', windowId: 9,
    targetBinding: { kind: 'attached' }, state: 'result', issuedAt: 9_999, expiresAt: 70_000,
  } });
  assert.deepEqual(await fixture.dispatch('PANEL_SHOW_PAGE_MARKERS'),
    { ok: false, code: 'PAGE_MARKERS_NOT_AUTHORIZED' });
  assert.deepEqual(fixture.calls.scripts, []);
});

test('HIDE uses the retained original target when the origin TTL has just expired', async () => {
  const fixture = await createControllerFixture({ session: {
    version: 1, sessionCapabilityId: SESSION_ID, auditId: 'audit-sample-20260826', windowId: 9,
    mode: 'attached', targetBinding: { kind: 'attached' }, state: 'result', issuedAt: 9_999, expiresAt: 80_000,
  } });
  await fixture.dispatch('PANEL_SHOW_PAGE_MARKERS');
  fixture.setTime(70_000);
  assert.equal((await fixture.dispatch('PANEL_HIDE_PAGE_MARKERS')).ok, true);
  assert.equal(Object.hasOwn(fixture.page.environment, '__auditaPageMarkersOverlayV1'), false);
});

test('a later HIDE invalidates a SHOW waiting at its first authorization before browser effects', async () => {
  const gate = deferred();
  const fixture = await createControllerFixture({ authorizationGate: gate });
  const showing = fixture.dispatch('PANEL_SHOW_PAGE_MARKERS');
  const hiding = fixture.dispatch('PANEL_HIDE_PAGE_MARKERS');
  gate.resolve();
  assert.equal((await hiding).ok, true);
  assert.deepEqual(await showing, { ok: false, code: 'PAGE_MARKERS_UNAVAILABLE' });
  assert.deepEqual(fixture.calls.scripts, []);
  assert.deepEqual(fixture.calls.publish, []);
});

test('native Port disconnect clears the active installation and publishes clear once', async () => {
  const fixture = await createControllerFixture();
  await fixture.dispatch('PANEL_SHOW_PAGE_MARKERS');
  fixture.latestPort().onDisconnect.emit();
  for (let attempt = 0; attempt < 10 && fixture.calls.publish.length < 2; attempt += 1)
    await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(fixture.calls.publish.map(message => message.state), ['active', 'clear']);
  assert.equal(Object.hasOwn(fixture.page.environment, '__auditaPageMarkersOverlayV1'), false);
});

test('clear proves foreign replacement absent without erasing it, while operational uncertainty is retryable', async () => {
  const foreignFixture = await createControllerFixture();
  await foreignFixture.dispatch('PANEL_SHOW_PAGE_MARKERS');
  const foreign = Object.freeze({ version: 1, installationId: 'F'.repeat(22),
    dispose() { throw new Error('foreign'); }, execute() { throw new Error('foreign'); } });
  Reflect.deleteProperty(foreignFixture.page.environment, '__auditaPageMarkersOverlayV1');
  Object.defineProperty(foreignFixture.page.environment, '__auditaPageMarkersOverlayV1', {
    value: foreign, enumerable: false, configurable: true, writable: false,
  });
  assert.equal(await foreignFixture.controller.clearAudit(foreignFixture.model.auditId), true);
  assert.strictEqual(foreignFixture.page.environment.__auditaPageMarkersOverlayV1, foreign);

  let fail = false;
  const uncertain = await createControllerFixture({ scriptFailure: request => fail && request.func.name !== 'bindAuditaPageMarkersPort' });
  await uncertain.dispatch('PANEL_SHOW_PAGE_MARKERS');
  fail = true;
  assert.equal(await uncertain.controller.closePanel({ windowId: 9, sessionCapabilityId: SESSION_ID }), false);
  const scriptsAfterFailure = uncertain.calls.scripts.length;
  assert.deepEqual(await uncertain.dispatch('PANEL_SHOW_PAGE_MARKERS'),
    { ok: false, code: 'PAGE_MARKERS_CLEANUP_UNCONFIRMED' });
  assert.equal(uncertain.calls.scripts.length, scriptsAfterFailure);
  fail = false;
  assert.equal(await uncertain.controller.closePanel({ windowId: 9, sessionCapabilityId: SESSION_ID }), true);
  assert.equal(Object.hasOwn(uncertain.page.environment, '__auditaPageMarkersOverlayV1'), false);
});

test('hide clears real W2 state and returns the closed clear projection', async () => {
  const fixture = await createControllerFixture();
  await fixture.dispatch('PANEL_SHOW_PAGE_MARKERS');
  assert.equal(Object.hasOwn(fixture.page.environment, '__auditaPageMarkersOverlayV1'), true);
  assert.deepEqual(await fixture.dispatch('PANEL_HIDE_PAGE_MARKERS'), { ok: true, markers: {
    state: 'clear', modelRevision: 7, groups: [],
    counts: { markers: 0, located: 0, unlocated: 0, general: 0, omitted: 0 }, selectedOrdinal: null,
    reasons: [],
  } });
  assert.equal(Object.hasOwn(fixture.page.environment, '__auditaPageMarkersOverlayV1'), false);
});

test('panel close during the final pre-effect proof prevents all injection and publication', async () => {
  const entered = deferred();
  const release = deferred();
  const fixture = await createControllerFixture({ probePause: { call: 2, entered, release } });
  const showing = fixture.dispatch('PANEL_SHOW_PAGE_MARKERS');
  await entered.promise;
  assert.equal(await fixture.controller.closePanel({ windowId: 9, sessionCapabilityId: SESSION_ID }), true);
  release.resolve();
  assert.deepEqual(await showing, { ok: false, code: 'PAGE_MARKERS_UNAVAILABLE' });
  assert.deepEqual(fixture.calls.scripts, []);
  assert.deepEqual(fixture.calls.publish, []);
});

test('panel close during install completion prevents binder injection and compensates under the held lock', async () => {
  const entered = deferred();
  const release = deferred();
  const scriptPause = {
    entered, release,
    when: request => request.func.name === 'runAuditaPageMarkersCommand' && request.args[0]?.op === 'install',
  };
  const fixture = await createControllerFixture({ scriptPause });
  const showing = fixture.dispatch('PANEL_SHOW_PAGE_MARKERS');
  await entered.promise;
  const closing = fixture.controller.closePanel({ windowId: 9, sessionCapabilityId: SESSION_ID });
  release.resolve();
  assert.deepEqual(await showing, { ok: false, code: 'PAGE_MARKERS_UNAVAILABLE' });
  assert.equal(await closing, true);
  assert.equal(fixture.calls.scripts.some(call => call.func.name === 'bindAuditaPageMarkersPort'), false);
  assert.equal(Object.hasOwn(fixture.page.environment, '__auditaPageMarkersOverlayV1'), false);
  assert.deepEqual(fixture.calls.publish, []);
});

test('window drift alone does not prove the exact original document lacks its W2 overlay', async () => {
  const fixture = await createControllerFixture();
  await fixture.dispatch('PANEL_SHOW_PAGE_MARKERS');
  fixture.queueProof({ tabId: 17, windowId: 10, documentId: 'document-a', urlSessionDigest: DIGEST });
  assert.equal(await fixture.controller.closePanel({ windowId: 9, sessionCapabilityId: SESSION_ID }), true);
  assert.equal(Object.hasOwn(fixture.page.environment, '__auditaPageMarkersOverlayV1'), false);
  assert.equal(fixture.calls.scripts.some(call => call.args[0]?.op === 'clear'), true);
});

test('selection-unavailable still proves the document, clears stale selection and publishes null', async () => {
  const fixture = await createControllerFixture();
  await fixture.dispatch('PANEL_SHOW_PAGE_MARKERS');
  assert.equal((await fixture.dispatch('PANEL_SELECT_PAGE_MARKER', { ordinal: 2, scroll: false })).ok, true);
  const probesBefore = fixture.calls.probe.length;
  assert.deepEqual(await fixture.dispatch('PANEL_SELECT_PAGE_MARKER', { ordinal: 0, scroll: false }),
    { ok: false, code: 'PAGE_MARKERS_SELECTION_UNAVAILABLE' });
  assert.equal(fixture.calls.probe.length, probesBefore + 2);
  assert.equal(fixture.calls.publish.at(-1).selectedOrdinal, null);
  const shown = await fixture.dispatch('PANEL_SHOW_PAGE_MARKERS');
  assert.equal(shown.markers.selectedOrdinal, null);
});

// --- Recarga da página (1.1.60): mesmo endereço, documento novo ------------------------------

const installCommands = fixture => fixture.calls.scripts
  .filter(call => call.func.name === 'runAuditaPageMarkersCommand' && call.args[0]?.op === 'install');

test('a reloaded page offers the signals before relocating them, and the accepted offer installs them', async () => {
  const fixture = await createControllerFixture({ liveDocumentId: 'document-b' });
  // O texto registrado na auditoria continua no elemento: é o que permite desenhar o sinal.
  fixture.page.first.textContent = 'Avançar';
  assert.deepEqual(await fixture.dispatch('PANEL_SHOW_PAGE_MARKERS'),
    { ok: false, code: 'PAGE_MARKERS_RELOADED_PAGE' });
  assert.deepEqual(fixture.calls.scripts, []);
  assert.deepEqual(fixture.calls.publish, []);
  assert.equal(fixture.page.environment.markerButtons().length, 0);

  const accepted = await fixture.dispatch('PANEL_SHOW_PAGE_MARKERS_RELOADED');
  assert.equal(accepted.ok, true);
  assert.equal(accepted.markers.counts.located, 2);
  assert.equal(fixture.page.environment.markerButtons().length, 1);
  const install = installCommands(fixture).at(-1);
  assert.deepEqual(install.target.documentIds, ['document-b']);
  assert.deepEqual(install.args[0].targets[0].corroboration, { name: 'Continuar', text: 'Avançar' });
  // Remover os sinais alcança a instalação recolocada, que vive no documento novo.
  assert.equal((await fixture.dispatch('PANEL_HIDE_PAGE_MARKERS')).ok, true);
  assert.equal(fixture.page.environment.markerButtons().length, 0);
  assert.equal(fixture.calls.scripts.some(call => call.args[0]?.op === 'clear'), true);
});

test('the normal document never carries corroboration and never relocates silently', async () => {
  const fixture = await createControllerFixture();
  assert.equal((await fixture.dispatch('PANEL_SHOW_PAGE_MARKERS')).ok, true);
  const install = installCommands(fixture).at(-1);
  assert.equal(install.args[0].targets.every(target => !Object.hasOwn(target, 'corroboration')), true);
  assert.deepEqual(install.target.documentIds, ['document-a']);
});

test('without the accepted offer the reloaded intent only offers again and installs nothing', async () => {
  const fixture = await createControllerFixture({ liveDocumentId: 'document-b' });
  fixture.page.first.textContent = 'Avançar';
  assert.deepEqual(await fixture.dispatch('PANEL_SHOW_PAGE_MARKERS_RELOADED'),
    { ok: false, code: 'PAGE_MARKERS_RELOADED_PAGE' });
  assert.deepEqual(fixture.calls.scripts, []);
  assert.equal(fixture.page.environment.markerButtons().length, 0);
  // O convite fica registrado: a tentativa seguinte, também por gesto, é a que recoloca.
  assert.equal((await fixture.dispatch('PANEL_SHOW_PAGE_MARKERS_RELOADED')).ok, true);
  assert.equal(fixture.page.environment.markerButtons().length, 1);
});

test('an offer minted for another live document is not accepted', async () => {
  let clock = 10_000;
  const offers = createPageRelocationOfferStore({ now: () => clock });
  const fixture = await createControllerFixture({ liveDocumentId: 'document-b', relocationOffers: offers });
  assert.deepEqual(await fixture.dispatch('PANEL_SHOW_PAGE_MARKERS'),
    { ok: false, code: 'PAGE_MARKERS_RELOADED_PAGE' });
  // A aba recarregou de novo antes do aceite: a oferta nomeia o documento que já não está vivo.
  assert.equal(offers.register({ auditId: fixture.model.auditId, tabId: 17, windowId: 9,
    documentId: 'document-c', urlSessionDigest: DIGEST, scope: 'page-markers', expiresAt: clock + 10_000 }), true);
  assert.deepEqual(await fixture.dispatch('PANEL_SHOW_PAGE_MARKERS_RELOADED'),
    { ok: false, code: 'PAGE_MARKERS_RELOADED_PAGE' });
  assert.deepEqual(fixture.calls.scripts, []);
});

test('a navigation keeps the audit provenance and only a departed tab takes it away', async () => {
  // A navegação da aba (o ciclo de vida em TAB_LOADING) não pode apagar a que página a auditoria
  // pertence: é essa procedência que permite oferecer a versão recarregada em vez de um erro.
  const offers = createPageRelocationOfferStore({ now: () => 10_000 });
  const navigated = await createControllerFixture({ liveDocumentId: 'document-b', relocationOffers: offers });
  navigated.page.first.textContent = 'Avançar';
  assert.equal(await navigated.controller.invalidateTab(17, 'navigation'), true);
  assert.deepEqual(await navigated.dispatch('PANEL_SHOW_PAGE_MARKERS'),
    { ok: false, code: 'PAGE_MARKERS_RELOADED_PAGE' });
  assert.deepEqual(navigated.calls.scripts, []);
  const accepted = await navigated.dispatch('PANEL_SHOW_PAGE_MARKERS_RELOADED');
  assert.equal(accepted.ok, true);
  assert.deepEqual(installCommands(navigated).at(-1).target.documentIds, ['document-b']);

  // Aba fechada ou descartada: a auditoria não tem mais página, então nada é oferecido.
  for (const reason of ['tab-removed', 'discarded']) {
    const gone = await createControllerFixture({ liveDocumentId: 'document-b' });
    assert.equal(await gone.controller.invalidateTab(17, reason), true, reason);
    assert.deepEqual(await gone.dispatch('PANEL_SHOW_PAGE_MARKERS'),
      { ok: false, code: 'PAGE_MARKERS_UNAVAILABLE' }, reason);
    assert.deepEqual(gone.calls.scripts, [], reason);
  }

  // Motivo fora do conjunto fechado não é aceito e não muda nada.
  const guarded = await createControllerFixture({ liveDocumentId: 'document-b' });
  assert.equal(await guarded.controller.invalidateTab(17, 'porque-sim'), false);
  assert.equal(await guarded.controller.invalidateTab(0, 'navigation'), false);
  assert.equal(await guarded.controller.invalidateTab(17), true);
});

test('an expired offer is refused and offered again', async () => {
  let clock = 10_000;
  const offers = createPageRelocationOfferStore({ now: () => clock, ttlMs: 5_000 });
  const fixture = await createControllerFixture({ liveDocumentId: 'document-b', relocationOffers: offers });
  assert.deepEqual(await fixture.dispatch('PANEL_SHOW_PAGE_MARKERS'),
    { ok: false, code: 'PAGE_MARKERS_RELOADED_PAGE' });
  clock += 5_000;
  fixture.setTime(15_000);
  assert.deepEqual(await fixture.dispatch('PANEL_SHOW_PAGE_MARKERS_RELOADED'),
    { ok: false, code: 'PAGE_MARKERS_RELOADED_PAGE' });
  assert.deepEqual(fixture.calls.scripts, []);
  assert.equal(offers.read({ auditId: fixture.model.auditId, tabId: 17, windowId: 9,
    documentId: 'document-b', scope: 'page-markers' })?.documentId, 'document-b');
});

test('another address, tab or window is another page: the reload intent never relocates it', async () => {
  const otherAddress = await createControllerFixture({
    liveDocumentId: 'document-b', liveDigest: `hmac-sha256:${'B'.repeat(43)}`,
  });
  assert.deepEqual(await otherAddress.dispatch('PANEL_SHOW_PAGE_MARKERS'),
    { ok: false, code: 'PAGE_MARKERS_DOCUMENT_CHANGED' });
  assert.deepEqual(await otherAddress.dispatch('PANEL_SHOW_PAGE_MARKERS_RELOADED'),
    { ok: false, code: 'PAGE_MARKERS_DOCUMENT_CHANGED' });
  assert.deepEqual(otherAddress.calls.scripts, []);

  for (const drift of [{ tabId: 18 }, { windowId: 10 }]) {
    const moved = await createControllerFixture({ liveDocumentId: 'document-b' });
    moved.queueProof({ tabId: 17, windowId: 9, documentId: 'document-b', urlSessionDigest: DIGEST, ...drift });
    assert.deepEqual(await moved.dispatch('PANEL_SHOW_PAGE_MARKERS_RELOADED'),
      { ok: false, code: 'PAGE_MARKERS_DOCUMENT_CHANGED' });
    moved.queueProof({ tabId: 17, windowId: 9, documentId: 'document-b', urlSessionDigest: DIGEST, ...drift });
    assert.deepEqual(await moved.dispatch('PANEL_SHOW_PAGE_MARKERS_RELOADED'),
      { ok: false, code: 'PAGE_MARKERS_DOCUMENT_CHANGED' });
    assert.deepEqual(moved.calls.scripts, []);
  }
});

test('a signal whose element no longer matches the recorded evidence is not drawn', async () => {
  const fixture = await createControllerFixture({ liveDocumentId: 'document-b' });
  // Nenhum sinal da auditoria confere com este elemento: a versão recarregada não recebe sinal.
  fixture.page.first.textContent = 'Outro texto completamente diferente';
  await fixture.dispatch('PANEL_SHOW_PAGE_MARKERS');
  const accepted = await fixture.dispatch('PANEL_SHOW_PAGE_MARKERS_RELOADED');
  assert.equal(accepted.ok, true);
  assert.equal(accepted.markers.counts.located, 0);
  assert.equal(accepted.markers.counts.markers, 0);
  assert.equal(fixture.page.environment.markerButtons().length, 0);
  assert.deepEqual(accepted.markers.reasons.map(row => row.reason), ['evidence-mismatch']);
});

test('clearing the audit retires its pending invitation', async () => {
  let clock = 10_000;
  const offers = createPageRelocationOfferStore({ now: () => clock });
  const fixture = await createControllerFixture({ liveDocumentId: 'document-b', relocationOffers: offers });
  await fixture.dispatch('PANEL_SHOW_PAGE_MARKERS');
  assert.equal(offers.size(), 1);
  await fixture.controller.clearAudit(fixture.model.auditId, 'audit-deleted');
  assert.equal(offers.size(), 0);
});
