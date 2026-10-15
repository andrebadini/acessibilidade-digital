import assert from 'node:assert/strict';
import test from 'node:test';

import { SAMPLE_AUDIT } from '../../fixtures/audits/sample-audit.js';
import { createHighlightBindingV1 } from '../../src/background/highlight-binding.js';
import { createHighlightBindingStore } from '../../src/background/highlight-binding-store.js';
import { createHighlightController } from '../../src/background/highlight-controller.js';
import { createPageRelocationOfferStore } from '../../src/background/page-relocation-offer.js';
import { createTargetOperationQueue } from '../../src/background/target-operation-queue.js';
import { enrichAuditForReport } from '../../src/core/report/enrich-audit.js';
import { verifyAuditIntegritySnapshot } from '../../src/core/report/integrity.js';

const EPOCH = 1_788_000_000_000;
const TTL_MS = 30 * 60_000;
const DIGEST = `hmac-sha256:${'A'.repeat(43)}`;
const SENDER = Object.freeze({ id: 'extension-test', documentId: 'panel-document' });
const OPTIONS = Object.freeze({
  now: () => '2026-08-29T12:00:00.000Z',
  timezone: 'America/Cuiaba',
  manifestVersion: '0.1.0',
  rulesVersion: '1.0.0',
  browserVersion: 'Chrome/147.0.0.0',
});

function sessionArea() {
  const values = Object.create(null);
  return {
    async get(key) {
      return Object.hasOwn(values, key) ? { [key]: structuredClone(values[key]) } : {};
    },
    async set(entries) { Object.assign(values, structuredClone(entries)); },
  };
}

async function snapshotFixture() {
  const draft = structuredClone(SAMPLE_AUDIT);
  draft.auditId = 'audit-highlight-controller';
  draft.finalUrl = 'https://servico.exemplo.test/consulta/inicio?view=public';
  draft.pages[0].finalUrl = draft.finalUrl;
  draft.evidence.find(value => value.evidenceId === 'ev-control').selector.css = 'button#continue';
  draft.integrity.canonicalModelHash = 'pending';
  draft.integrity.evidenceManifestHash = 'pending';
  const model = await verifyAuditIntegritySnapshot(await enrichAuditForReport(draft, OPTIONS));
  return Object.freeze({ model, modelRevision: 4, modelHash: model.integrity.canonicalModelHash });
}

function target() {
  return {
    documentId: 'document-main',
    frameId: 0,
    backendNodeId: 41,
    evidenceId: 'ev-control',
    selector: {
      syntax: 'CSSSelectorV1', value: 'button#continue', byteLength: 15, complexity: 2,
    },
    structuralSignature: { version: 'StructuralSignatureV1', sha256: 'b'.repeat(64) },
    rectBucket: null,
  };
}

function bindingFixture(snapshot) {
  const targets = Object.create(null);
  targets['occ-focus-failed'] = target();
  targets['occ-focus-review'] = target();
  return createHighlightBindingV1({
    version: 1,
    auditId: snapshot.model.auditId,
    pageId: 'page-1',
    modelRevision: snapshot.modelRevision,
    modelHash: snapshot.modelHash,
    tabId: 7,
    windowId: 9,
    topDocumentId: 'document-main',
    topUrlEvidence: snapshot.model.pages[0].finalUrl,
    topUrlSessionDigest: DIGEST,
    createdAt: EPOCH,
    expiresAt: EPOCH + TTL_MS,
    locatorVersion: 'CSSSelectorV1+StructuralSignatureV1',
    targets,
  });
}

function request(auditId, occurrenceId) {
  return {
    sessionCapabilityId: 'session-highlight-1',
    auditId,
    occurrenceId,
    sender: SENDER,
  };
}

function clearRequest(auditId) {
  return { sessionCapabilityId: 'session-highlight-1', auditId, sender: SENDER };
}

function randomBytesFixture() {
  let call = 0;
  return length => {
    assert.equal(length, 16);
    call += 1;
    return Uint8Array.from({ length }, (_value, index) => (call * 17 + index) % 256);
  };
}

async function harness({
  inject, decorateStore, liveVerify, tabState, authorize, snapshotForLoad, probe, relocationOffers, clock: givenClock,
} = {}) {
  const snapshot = await snapshotFixture();
  const binding = bindingFixture(snapshot);
  const clock = givenClock ?? { value: EPOCH };
  const realStore = createHighlightBindingStore({ sessionArea: sessionArea(), now: () => clock.value });
  await realStore.put(binding);
  const bindingStore = decorateStore ? decorateStore(realStore) : realStore;
  const trace = [];
  const chromeAdapter = {
    // Prova de documento viva: o documento auditado no caso de sempre, o documento recarregado
    // quando o teste declara um `probe`.
    async probeDocumentIdentity(tabId) {
      trace.push(['probe', tabId]);
      if (typeof probe === 'function') return probe(tabId, trace);
      if (probe) return structuredClone(probe);
      return { tabId, windowId: 9, documentId: 'document-main', urlSessionDigest: DIGEST };
    },
    async injectHighlight(input) {
      trace.push(['inject', structuredClone(input)]);
      if (inject) return inject(input, trace);
      const frameId = input.command.op === 'install' ? input.command.frameId : 0;
      return {
        ok: true,
        nonce: input.command.nonce,
        documentId: input.documentId,
        frameId,
      };
    },
  };
  const sessionAuthority = {
    async authorizeSession(input) {
      trace.push(['authorize', input.auditId]);
      if (authorize) return authorize(input, trace);
      return {
        ok: true,
        session: {
          auditId: snapshot.model.auditId,
          windowId: 9,
          state: 'result',
          intents: ['highlight'],
        },
      };
    },
  };
  const modelAuthority = {
    async loadValidated(input) {
      trace.push(['model', input.auditId]);
      return snapshotForLoad ? snapshotForLoad(snapshot) : snapshot;
    },
  };
  const liveVerifier = {
    async verify(input) {
      trace.push(['verify', input.target.documentId]);
      if (liveVerify) return liveVerify(input, trace);
      return {
        ok: true,
        tabId: input.binding.tabId,
        windowId: input.binding.windowId,
        documentId: input.target.documentId,
        frameId: input.target.frameId,
      };
    },
  };
  const controller = createHighlightController({
    chromeApi: {
      runtime: { id: 'extension-test' },
      tabs: {
        async get(tabId) {
          if (tabState instanceof Error) throw tabState;
          return { id: tabId, windowId: 9, status: 'complete', discarded: false, ...(tabState ?? {}) };
        },
      },
    },
    chromeAdapter,
    sessionAuthority,
    modelAuthority,
    bindingStore,
    liveVerifier,
    targetQueue: createTargetOperationQueue(),
    now: () => clock.value,
    randomBytes: randomBytesFixture(),
    ...(relocationOffers ? { relocationOffers } : {}),
  });
  return { controller, binding, bindingStore, realStore, snapshot, clock, trace };
}

test('highlights unchanged exported content but still requires the live document proof', async () => {
  const fixture = await harness({ snapshotForLoad: snapshot => ({ ...snapshot, modelRevision: snapshot.modelRevision + 1 }) });
  const input = request(fixture.snapshot.model.auditId, 'occ-focus-failed');
  assert.deepEqual(await fixture.controller.availability(input), { ok: true, bindingStatus: { state: 'available' } });
  const result = await fixture.controller.highlight(input);
  assert.equal(result.ok, true);
  assert.ok(fixture.trace.some(row => row[0] === 'verify'));
  assert.ok(fixture.trace.some(row => row[0] === 'inject' && row[1].command.op === 'install'));

  const navigated = await harness({
    snapshotForLoad: snapshot => ({ ...snapshot, modelRevision: snapshot.modelRevision + 1 }),
    liveVerify: async () => ({ ok: false, reason: 'document-changed' }),
  });
  assert.equal((await navigated.controller.highlight(request(navigated.snapshot.model.auditId, 'occ-focus-failed'))).ok, false);
  assert.equal(navigated.trace.some(row => row[0] === 'inject'), false);
});

test('returns only the authorized durable overlay state needed to resynchronize a consumer', async () => {
  const fixture = await harness();

  assert.deepEqual(await fixture.controller.currentState(clearRequest(fixture.snapshot.model.auditId)), {
    ok: true, highlight: { state: 'clear' },
  });
  await fixture.controller.highlight(request(fixture.snapshot.model.auditId, 'occ-focus-failed'));
  const before = fixture.trace.filter(entry => entry[0] === 'inject').length;

  assert.deepEqual(await fixture.controller.currentState(clearRequest(fixture.snapshot.model.auditId)), {
    ok: true, highlight: { state: 'active', occurrenceId: 'occ-focus-failed' },
  });
  assert.equal(fixture.trace.filter(entry => entry[0] === 'inject').length, before);
});

test('never discloses durable overlay state to an unauthorized reconnect', async () => {
  let allowed = true;
  const fixture = await harness({
    authorize(input) {
      return allowed
        ? { ok: true, session: { auditId: input.auditId, windowId: 9, state: 'result', intents: ['highlight'] } }
        : { ok: false, code: 'HIGHLIGHT_NOT_AUTHORIZED' };
    },
  });
  await fixture.controller.highlight(request(fixture.snapshot.model.auditId, 'occ-focus-failed'));
  allowed = false;

  assert.deepEqual(await fixture.controller.currentState(clearRequest(fixture.snapshot.model.auditId)), {
    ok: false, code: 'HIGHLIGHT_NOT_AUTHORIZED',
  });
});

test('installs and clears one model-derived overlay through durable CAS states', async () => {
  const fixture = await harness();
  const highlighted = await fixture.controller.highlight(
    request(fixture.snapshot.model.auditId, 'occ-focus-failed'),
  );

  assert.deepEqual(highlighted, {
    ok: true,
    highlight: { state: 'active', occurrenceId: 'occ-focus-failed' },
  });
  const owner = await fixture.realStore.getActiveOverlay(7);
  assert.equal(owner.state, 'active');
  assert.equal(owner.revision, 2);
  const install = fixture.trace.find(entry => entry[0] === 'inject')[1];
  assert.equal(install.documentId, 'document-main');
  assert.equal(install.command.kind, 'failed');
  assert.equal(install.command.markerNumber, 1);
  assert.deepEqual(install.command.selector, fixture.binding.targets['occ-focus-failed'].selector);

  assert.deepEqual(await fixture.controller.clear(clearRequest(fixture.snapshot.model.auditId)), {
    ok: true,
    highlight: { state: 'clear' },
  });
  assert.equal(await fixture.realStore.getActiveOverlay(7), null);
  const commands = fixture.trace.filter(entry => entry[0] === 'inject').map(entry => entry[1].command);
  assert.deepEqual(commands.map(value => value.op), ['install', 'clear']);
  assert.equal(commands[1].nonce, commands[0].nonce);
});

test('serializes concurrent replacement so only one overlay owns the tab', async () => {
  let releaseFirst;
  let firstInstallStarted;
  const started = new Promise(resolve => { firstInstallStarted = resolve; });
  let installCount = 0;
  const fixture = await harness({
    async inject(input) {
      if (input.command.op === 'install') {
        installCount += 1;
        if (installCount === 1) {
          firstInstallStarted();
          await new Promise(resolve => { releaseFirst = resolve; });
        }
      }
      return {
        ok: true,
        nonce: input.command.nonce,
        documentId: input.documentId,
        frameId: input.command.op === 'install' ? input.command.frameId : 0,
      };
    },
  });

  const first = fixture.controller.highlight(request(fixture.snapshot.model.auditId, 'occ-focus-failed'));
  await started;
  const second = fixture.controller.highlight(request(fixture.snapshot.model.auditId, 'occ-focus-review'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fixture.trace.filter(entry => entry[0] === 'inject').length, 1);
  releaseFirst();

  assert.equal((await first).ok, true);
  assert.equal((await second).ok, true);
  const commands = fixture.trace.filter(entry => entry[0] === 'inject').map(entry => entry[1].command);
  assert.deepEqual(commands.map(value => value.op), ['install', 'clear', 'install']);
  assert.equal(commands[2].kind, 'manual');
  assert.equal(commands[2].markerNumber, 2);
  const owner = await fixture.realStore.getActiveOverlay(7);
  assert.equal(owner.occurrenceId, 'occ-focus-review');
  assert.equal(Object.keys((await fixture.realStore.snapshot()).activeOverlayByTab).length, 1);
});

test('compensates an activation CAS failure and retains state when cleanup is unconfirmed', async () => {
  let realStore;
  const fixture = await harness({
    decorateStore(store) {
      realStore = store;
      return Object.freeze({
        ...store,
        async activateOverlay(input) {
          await store.activateOverlay(input);
          return { ok: false, code: 'HIGHLIGHT_OVERLAY_CAS_MISMATCH' };
        },
      });
    },
    inject(input) {
      if (input.command.op === 'clear') return { ok: false, reason: 'execution-failed' };
      return {
        ok: true,
        nonce: input.command.nonce,
        documentId: input.documentId,
        frameId: input.command.frameId,
      };
    },
  });

  assert.deepEqual(await fixture.controller.highlight(
    request(fixture.snapshot.model.auditId, 'occ-focus-failed'),
  ), { ok: false, code: 'HIGHLIGHT_CLEANUP_UNCONFIRMED' });
  assert.deepEqual(
    fixture.trace.filter(entry => entry[0] === 'inject').map(entry => entry[1].command.op),
    ['install', 'clear'],
  );
  assert.equal((await realStore.getActiveOverlay(7)).state, 'clearing');
});

test('recovers an interrupted install and rehydrates a verified active owner', async () => {
  const interrupted = await harness();
  await interrupted.realStore.beginOverlay({
    version: 1,
    tabId: 7,
    windowId: 9,
    topDocumentId: 'document-main',
    documentId: 'document-main',
    frameId: 0,
    nonce: 'R'.repeat(22),
    auditId: interrupted.snapshot.model.auditId,
    occurrenceId: 'occ-focus-failed',
    createdAt: EPOCH,
    expiresAt: EPOCH + TTL_MS,
    state: 'installing',
    revision: 1,
  });
  const interruptedResult = await interrupted.controller.recover();
  assert.equal(interruptedResult.ok, true);
  assert.equal(await interrupted.realStore.getActiveOverlay(7), null);

  const active = await harness();
  await active.controller.highlight(request(active.snapshot.model.auditId, 'occ-focus-failed'));
  active.trace.length = 0;
  const activeResult = await active.controller.recover();
  assert.equal(activeResult.ok, true);
  assert.equal((await active.realStore.getActiveOverlay(7)).state, 'active');
  assert.deepEqual(
    active.trace.filter(entry => entry[0] === 'inject').map(entry => entry[1].command.op),
    ['install'],
  );
});

test('restart recovery clears instead of rehydrating a mismatched live proof', async () => {
  const fixture = await harness({
    liveVerify(input) {
      return {
        ok: true,
        tabId: input.binding.tabId,
        windowId: input.binding.windowId,
        documentId: 'forged-document',
        frameId: input.target.frameId,
      };
    },
  });
  const installing = await fixture.realStore.beginOverlay({
    version: 1,
    tabId: 7,
    windowId: 9,
    topDocumentId: 'document-main',
    documentId: 'document-main',
    frameId: 0,
    nonce: 'V'.repeat(22),
    auditId: fixture.snapshot.model.auditId,
    occurrenceId: 'occ-focus-failed',
    createdAt: EPOCH,
    expiresAt: EPOCH + TTL_MS,
    state: 'installing',
    revision: 1,
  });
  await fixture.realStore.activateOverlay({
    tabId: 7,
    nonce: installing.overlay.nonce,
    expectedRevision: installing.overlay.revision,
  });

  const result = await fixture.controller.recover();

  assert.equal(result.ok, true);
  assert.equal(await fixture.realStore.getActiveOverlay(7), null);
  assert.deepEqual(
    fixture.trace.filter(entry => entry[0] === 'inject').map(entry => entry[1].command.op),
    ['clear'],
  );
});

test('accepts autonomous invalidation only from the exact extension document, frame and nonce', async () => {
  const fixture = await harness();
  await fixture.controller.highlight(request(fixture.snapshot.model.auditId, 'occ-focus-failed'));
  const owner = await fixture.realStore.getActiveOverlay(7);
  const sender = {
    id: 'extension-test',
    documentId: owner.documentId,
    frameId: owner.frameId,
    tab: { id: owner.tabId, windowId: owner.windowId },
  };

  assert.deepEqual(await fixture.controller.invalidateContent({
    message: { type: 'AUDITA_HIGHLIGHT_INVALIDATED', nonce: 'Z'.repeat(22) },
    sender,
  }), { ok: false, code: 'HIGHLIGHT_INVALIDATION_IGNORED' });
  assert.equal((await fixture.realStore.getActiveOverlay(7)).state, 'active');

  assert.deepEqual(await fixture.controller.invalidateContent({
    message: { type: 'AUDITA_HIGHLIGHT_INVALIDATED', nonce: owner.nonce },
    sender,
  }), {
    ok: true, auditId: fixture.snapshot.model.auditId,
    highlight: { state: 'clear' },
  });
  assert.equal(await fixture.realStore.getActiveOverlay(7), null);
  assert.deepEqual(
    fixture.trace.filter(entry => entry[0] === 'inject').map(entry => entry[1].command.op),
    ['install'],
  );
});

test('navigation and discard events retire owner and binding without injecting into the departed document', async () => {
  for (const reason of ['navigation', 'discarded', 'tab-removed']) {
    const fixture = await harness({
      inject(input) {
        if (input.command.op === 'clear') return { ok: false, reason: 'execution-failed' };
        return { ok: true, nonce: input.command.nonce, documentId: input.documentId, frameId: input.command.frameId };
      },
    });
    await fixture.controller.highlight(request(fixture.snapshot.model.auditId, 'occ-focus-failed'));

    assert.deepEqual(await fixture.controller.invalidateTab(7, reason), {
      ok: true, state: 'invalidated', clearedAuditIds: [fixture.snapshot.model.auditId],
    }, reason);
    assert.equal(await fixture.realStore.getActiveOverlay(7), null, reason);
    const found = await fixture.realStore.findTarget({
      auditId: fixture.snapshot.model.auditId, occurrenceId: 'occ-focus-failed',
    });
    // Uma navegação não é o fim da auditoria: a ligação durável (seletor e assinatura) fica, e é
    // ela que permite oferecer o destaque na versão recarregada. Nenhum sinal é desenhado no
    // documento que foi embora em nenhum dos casos.
    if (reason === 'navigation') assert.ok(found, reason);
    else assert.equal(found, null, reason);
    assert.deepEqual(
      fixture.trace.filter(entry => entry[0] === 'inject').map(entry => entry[1].command.op),
      ['install'],
      reason,
    );
  }
});

test('a navigation keeps the durable binding so the reloaded page can offer the highlight', async () => {
  let live = 'document-main';
  let verifier = async input => ({
    ok: true, tabId: 7, windowId: 9, documentId: input.target.documentId, frameId: input.target.frameId,
  });
  const fixture = await harness({
    probe: tabId => reloadedProbe(live)(tabId),
    liveVerify: input => verifier(input),
  });
  const input = request(fixture.snapshot.model.auditId, 'occ-focus-failed');

  // A auditoria e o destaque originais, e então a navegação: o painel pergunta de novo, tenta
  // destacar, recebe o convite e só desenha depois do gesto.
  assert.equal((await fixture.controller.highlight(input)).ok, true);
  live = 'document-next';
  verifier = documentChanged;
  await fixture.controller.invalidateTab(7, 'navigation');
  assert.deepEqual(await fixture.controller.availability(input), { ok: true, bindingStatus: { state: 'available' } });
  assert.deepEqual(await fixture.controller.highlight(input), { ok: false, code: 'HIGHLIGHT_RELOADED_PAGE' });
  assert.equal((await fixture.controller.highlightReloaded(input)).ok, true);

  const commands = installs(fixture);
  assert.equal(commands.length, 2);
  assert.equal(commands[1].command.signedDocumentId, 'document-main');
  assert.equal(commands[1].command.documentId, 'document-next');
  assert.equal((await fixture.realStore.getActiveOverlay(7)).relocatedFrom, 'document-main');
});

test('a read-only session may relocate the highlight, and no other session state may', async () => {
  let sessionState = 'view-only';
  const fixture = await harness({
    authorize: input => ({
      ok: true, session: { auditId: input.auditId, windowId: 9, state: sessionState, intents: ['highlight'] },
    }),
    probe: tabId => ({ tabId, windowId: 9, documentId: 'document-next', urlSessionDigest: DIGEST }),
    liveVerify: documentChanged,
  });
  const input = request(fixture.snapshot.model.auditId, 'occ-focus-failed');
  // A leitura do resultado (o painel volta assim quando a aba navegou) recebe o convite e, com o
  // gesto seguinte, recoloca o destaque no documento de agora.
  assert.deepEqual(await fixture.controller.highlight(input), { ok: false, code: 'HIGHLIGHT_RELOADED_PAGE' });
  assert.equal((await fixture.controller.highlightReloaded(input)).ok, true);
  assert.equal(installs(fixture).at(-1).command.signedDocumentId, 'document-main');
  // Sessão em execução ou parada por privacidade não ganha nada por isso: continua fora.
  for (const denied of ['running', 'privacy-paused']) {
    sessionState = denied;
    assert.deepEqual(await fixture.controller.availability(input), { ok: false, code: 'HIGHLIGHT_NOT_AUTHORIZED' });
    assert.deepEqual(await fixture.controller.highlightReloaded(input), { ok: false, code: 'HIGHLIGHT_NOT_AUTHORIZED' });
  }
  assert.deepEqual(
    fixture.trace.filter(entry => entry[0] === 'inject').map(entry => entry[1].command.op),
    ['install'],
    'a denied session never reaches the page',
  );
});

test('recovery and expiry confirm a discarded tab as absent before retiring owner and binding', async () => {
  for (const [mode, clearFailure] of [
    ['recover', 'response'], ['expire', 'response'], ['expire', 'throw'],
  ]) {
    let discarded = false;
    const fixture = await harness({
      tabState: { discarded: true },
      liveVerify(input) {
        return discarded
          ? { ok: false, reason: 'page-or-process' }
          : {
            ok: true, tabId: input.binding.tabId, windowId: input.binding.windowId,
            documentId: input.target.documentId, frameId: input.target.frameId,
          };
      },
      inject(input) {
        if (input.command.op === 'clear') {
          if (clearFailure === 'throw') throw new Error('discarded execution context');
          return { ok: false, reason: 'execution-failed' };
        }
        return { ok: true, nonce: input.command.nonce, documentId: input.documentId, frameId: input.command.frameId };
      },
    });
    await fixture.controller.highlight(request(fixture.snapshot.model.auditId, 'occ-focus-failed'));
    discarded = true;
    if (mode === 'expire') fixture.clock.value = EPOCH + TTL_MS;

    const result = mode === 'recover'
      ? await fixture.controller.recover()
      : await fixture.controller.expireDue();

    const label = `${mode}-${clearFailure}`;
    assert.equal(result.ok, true, label);
    assert.deepEqual(result.clearedAuditIds, [fixture.snapshot.model.auditId], label);
    assert.equal(await fixture.realStore.getActiveOverlay(7), null, label);
    assert.equal(await fixture.realStore.findTarget({
      auditId: fixture.snapshot.model.auditId, occurrenceId: 'occ-focus-failed',
    }), null, label);
  }
});

test('clears expired owners before purging their bindings without renewing TTL', async () => {
  const fixture = await harness();
  await fixture.controller.highlight(request(fixture.snapshot.model.auditId, 'occ-focus-failed'));
  fixture.clock.value = EPOCH + TTL_MS;

  const expired = await fixture.controller.expireDue();

  assert.equal(expired.ok, true);
  assert.equal(await fixture.realStore.getActiveOverlay(7), null);
  assert.equal(await fixture.realStore.findTarget({
    auditId: fixture.snapshot.model.auditId,
    occurrenceId: 'occ-focus-failed',
  }), null);
  assert.deepEqual(
    fixture.trace.filter(entry => entry[0] === 'inject').map(entry => entry[1].command.op),
    ['install', 'clear'],
  );
});

test('rejects hostile request accessors before authorization or injection', async () => {
  const fixture = await harness();
  let getterCalls = 0;
  const hostile = request(fixture.snapshot.model.auditId, 'occ-focus-failed');
  Object.defineProperty(hostile, 'occurrenceId', {
    enumerable: true,
    get() { getterCalls += 1; return 'occ-focus-failed'; },
  });
  const traceLength = fixture.trace.length;

  assert.deepEqual(await fixture.controller.highlight(hostile), {
    ok: false,
    code: 'HIGHLIGHT_INPUT_INVALID',
  });
  assert.equal(getterCalls, 0);
  assert.equal(fixture.trace.length, traceLength);
});

// --- Página recarregada (1.1.60): mesmo endereço, documento novo ---

const OTHER_DIGEST = `hmac-sha256:${'C'.repeat(43)}`;

function reloadedProbe(live) {
  return tabId => ({ tabId, windowId: 9, documentId: live, urlSessionDigest: DIGEST });
}

const documentChanged = async () => ({ ok: false, reason: 'document-changed' });

function injected(fixture, from = 0) {
  return fixture.trace.slice(from).filter(row => row[0] === 'inject').map(row => row[1]);
}

function installs(fixture) {
  return injected(fixture).filter(command => command.command.op === 'install');
}

test('relocation demands both the invitation from the refusal and the explicit request', async () => {
  const fixture = await harness({ probe: reloadedProbe('document-next'), liveVerify: documentChanged });
  const input = request(fixture.snapshot.model.auditId, 'occ-focus-failed');

  // Recolocar sem convite: nada é desenhado e o convite é (re)feito.
  assert.deepEqual(await fixture.controller.highlightReloaded(input), { ok: false, code: 'HIGHLIGHT_RELOADED_PAGE' });
  assert.deepEqual(injected(fixture), []);

  // A tentativa comum também não desenha nada: ela só convida.
  assert.deepEqual(await fixture.controller.highlight(input), { ok: false, code: 'HIGHLIGHT_RELOADED_PAGE' });
  assert.deepEqual(injected(fixture), []);

  const mark = fixture.trace.length;
  const accepted = await fixture.controller.highlightReloaded(input);
  assert.equal(accepted.ok, true);
  // O convite não repete a verificação de estrutura do alvo: ela não tem como valer no documento novo.
  assert.equal(fixture.trace.slice(mark).some(row => row[0] === 'verify'), false);

  const [install] = installs(fixture);
  assert.equal(install.documentId, 'document-next');
  assert.equal(install.command.documentId, 'document-next');
  assert.equal(install.command.signedDocumentId, 'document-main');
  assert.equal(install.command.frameId, 0);
  assert.equal(install.command.kind, 'failed');

  const owner = await fixture.realStore.getActiveOverlay(7);
  assert.equal(owner.state, 'active');
  assert.equal(owner.topDocumentId, 'document-next');
  assert.equal(owner.documentId, 'document-next');
  assert.equal(owner.relocatedFrom, 'document-main');
  assert.equal(owner.frameId, 0);
  assert.equal(owner.occurrenceId, 'occ-focus-failed');
  assert.equal(owner.expiresAt, fixture.binding.expiresAt);
});

test('a second reload needs a new invitation before drawing anything', async () => {
  let live = 'document-next';
  const fixture = await harness({ probe: tabId => reloadedProbe(live)(tabId), liveVerify: documentChanged });
  const input = request(fixture.snapshot.model.auditId, 'occ-focus-failed');

  assert.deepEqual(await fixture.controller.highlight(input), { ok: false, code: 'HIGHLIGHT_RELOADED_PAGE' });
  live = 'document-third';
  assert.deepEqual(await fixture.controller.highlightReloaded(input), { ok: false, code: 'HIGHLIGHT_RELOADED_PAGE' });
  assert.deepEqual(injected(fixture), []);
  assert.equal(await fixture.realStore.getActiveOverlay(7), null);

  assert.equal((await fixture.controller.highlightReloaded(input)).ok, true);
  const [install] = installs(fixture);
  assert.equal(install.command.documentId, 'document-third');
  assert.equal(install.command.signedDocumentId, 'document-main');
  assert.equal((await fixture.realStore.getActiveOverlay(7)).topDocumentId, 'document-third');
});

test('another address, tab or window never becomes a relocation', async () => {
  const cases = [
    { name: 'endereço', probe: tabId => ({ tabId, windowId: 9, documentId: 'document-next', urlSessionDigest: OTHER_DIGEST }) },
    { name: 'janela', probe: tabId => ({ tabId, windowId: 11, documentId: 'document-next', urlSessionDigest: DIGEST }) },
  ];
  for (const scenario of cases) {
    const fixture = await harness({ probe: scenario.probe, liveVerify: documentChanged });
    const input = request(fixture.snapshot.model.auditId, 'occ-focus-failed');
    assert.deepEqual(await fixture.controller.highlight(input), { ok: false, code: 'HIGHLIGHT_DOCUMENT_CHANGED' }, scenario.name);
    assert.deepEqual(await fixture.controller.highlightReloaded(input), { ok: false, code: 'HIGHLIGHT_DOCUMENT_CHANGED' }, scenario.name);
    assert.deepEqual(injected(fixture), [], scenario.name);
  }

  // Outra aba: o alvo é o documento do quadro principal da aba guardada, e nada é oferecido.
  const otherTab = await harness({
    probe: tabId => ({ tabId: 8, windowId: 9, documentId: 'document-next', urlSessionDigest: DIGEST }),
    liveVerify: documentChanged,
  });
  assert.deepEqual(await otherTab.controller.highlightReloaded(request(otherTab.snapshot.model.auditId, 'occ-focus-failed')), {
    ok: false, code: 'HIGHLIGHT_DOCUMENT_CHANGED',
  });
  assert.deepEqual(injected(otherTab), []);
});

test('the invitation expires and dies with the audit', async () => {
  const clock = { value: EPOCH };
  const offers = createPageRelocationOfferStore({ now: () => clock.value, ttlMs: 5_000 });
  const fixture = await harness({
    clock, relocationOffers: offers, probe: reloadedProbe('document-next'), liveVerify: documentChanged,
  });
  const auditId = fixture.snapshot.model.auditId;
  const input = request(auditId, 'occ-focus-failed');

  assert.deepEqual(await fixture.controller.highlight(input), { ok: false, code: 'HIGHLIGHT_RELOADED_PAGE' });
  clock.value += 5_000;
  assert.deepEqual(await fixture.controller.highlightReloaded(input), { ok: false, code: 'HIGHLIGHT_RELOADED_PAGE' });
  assert.deepEqual(injected(fixture), []);
  assert.equal(await fixture.realStore.getActiveOverlay(7), null);

  // Depois de limpar a auditoria o convite também não serve mais.
  const cleared = await harness({
    clock, relocationOffers: offers, probe: reloadedProbe('document-next'), liveVerify: documentChanged,
  });
  await cleared.controller.highlight(input);
  await cleared.controller.clearAudit(auditId, 'audit-deleted');
  assert.equal((await cleared.controller.highlightReloaded(input)).ok, false);
  assert.deepEqual(injected(cleared), []);
});

test('rejects hostile relocation accessors before touching the store or the page', async () => {
  const fixture = await harness({ probe: reloadedProbe('document-next'), liveVerify: documentChanged });
  let getterCalls = 0;
  const hostile = request(fixture.snapshot.model.auditId, 'occ-focus-failed');
  Object.defineProperty(hostile, 'occurrenceId', {
    enumerable: true,
    get() { getterCalls += 1; return 'occ-focus-failed'; },
  });
  const mark = fixture.trace.length;

  assert.deepEqual(await fixture.controller.highlightReloaded(hostile), { ok: false, code: 'HIGHLIGHT_INPUT_INVALID' });
  assert.equal(getterCalls, 0);
  assert.equal(fixture.trace.length, mark);
});
