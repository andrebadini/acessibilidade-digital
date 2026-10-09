import assert from 'node:assert/strict';
import test from 'node:test';

import { createHighlightBindingV1 } from '../../src/background/highlight-binding.js';
import { createHighlightBindingStore } from '../../src/background/highlight-binding-store.js';

const REGISTRY_KEY = 'audita:highlight-bindings:v1';
const EPOCH = 1_788_000_000_000;
const TTL_MS = 30 * 60_000;
const HASH = 'a'.repeat(64);
const DIGEST = `hmac-sha256:${'A'.repeat(43)}`;

function createSessionArea(initial = {}) {
  const values = Object.assign(Object.create(null), structuredClone(initial));
  const writes = [];
  return {
    values,
    writes,
    async get(key) {
      if (key === null) return structuredClone(values);
      return Object.hasOwn(values, key) ? { [key]: structuredClone(values[key]) } : {};
    },
    async set(entries) {
      writes.push(structuredClone(entries));
      Object.assign(values, structuredClone(entries));
    },
    inspect() { return structuredClone(values); },
  };
}

function clockFixture(value = EPOCH, initial = {}) {
  const clock = { value };
  const sessionArea = createSessionArea(initial);
  const store = createHighlightBindingStore({ sessionArea, now: () => clock.value });
  return { store, sessionArea, clock };
}

function sequenceClock(values) {
  let index = 0;
  return () => {
    const value = values[Math.min(index, values.length - 1)];
    index += 1;
    return value;
  };
}

function bindingFixture(overrides = {}) {
  const targets = Object.create(null);
  targets['occ-1'] = {
    documentId: 'document-main', frameId: 0, backendNodeId: 91, evidenceId: 'ev-1',
    selector: { syntax: 'CSSSelectorV1', value: 'button#continue', byteLength: 15, complexity: 2 },
    structuralSignature: { version: 'StructuralSignatureV1', sha256: 'b'.repeat(64) },
    rectBucket: null,
  };
  return createHighlightBindingV1({
    version: 1,
    auditId: 'audit-1',
    pageId: 'page-1',
    modelRevision: 4,
    modelHash: HASH,
    tabId: 7,
    windowId: 3,
    topDocumentId: 'document-main',
    topUrlEvidence: 'https://example.test/?view=public',
    topUrlSessionDigest: DIGEST,
    createdAt: EPOCH,
    expiresAt: EPOCH + TTL_MS,
    locatorVersion: 'CSSSelectorV1+StructuralSignatureV1',
    targets,
    ...overrides,
  });
}

function overlayFixture(overrides = {}) {
  return {
    version: 1,
    tabId: 7,
    windowId: 3,
    topDocumentId: 'document-main',
    documentId: 'document-main',
    frameId: 0,
    nonce: 'N'.repeat(22),
    auditId: 'audit-1',
    occurrenceId: 'occ-1',
    createdAt: EPOCH,
    expiresAt: EPOCH + TTL_MS,
    state: 'installing',
    revision: 1,
    ...overrides,
  };
}

function registryFixture({ binding = bindingFixture(), overlay = null } = {}) {
  const bindingsByAuditPage = Object.create(null);
  bindingsByAuditPage[`${binding.auditId}\u0000${binding.pageId}`] = binding;
  const activeOverlayByTab = Object.create(null);
  if (overlay) activeOverlayByTab[String(overlay.tabId)] = overlay;
  return {
    [REGISTRY_KEY]: { version: 1, bindingsByAuditPage, activeOverlayByTab },
  };
}

function bindingWithTargetRange({ pageId, start, count }) {
  const targets = Object.create(null);
  for (let index = start; index < start + count; index += 1) {
    targets[`occ-${index}`] = {
      documentId: 'document-main', frameId: 0, backendNodeId: index + 1, evidenceId: `ev-${index}`,
      selector: { syntax: 'CSSSelectorV1', value: 'button#continue', byteLength: 15, complexity: 2 },
      structuralSignature: { version: 'StructuralSignatureV1', sha256: 'b'.repeat(64) },
      rectBucket: null,
    };
  }
  return bindingFixture({ pageId, targets });
}

test('persists one closed registry transition and reloads frozen null-prototype records', async () => {
  const { store, sessionArea } = clockFixture();
  const source = bindingFixture();

  const stored = await store.put(source);
  const found = await store.findTarget({
    auditId: 'audit-1', occurrenceId: 'occ-1', expectedModelRevision: 4, expectedModelHash: HASH,
  });
  const snapshot = await store.snapshot();

  assert.deepEqual(stored, source);
  assert.notEqual(stored, source);
  assert.equal(sessionArea.writes.length, 1);
  assert.deepEqual(Object.keys(sessionArea.writes[0]), [REGISTRY_KEY]);
  assert.equal(Object.isFrozen(found), true);
  assert.equal(Object.isFrozen(found.binding), true);
  assert.equal(Object.isFrozen(found.target), true);
  assert.deepEqual(Reflect.ownKeys(found), ['binding', 'target']);
  assert.equal(found.target.backendNodeId, 91);
  assert.equal(Object.getPrototypeOf(snapshot.bindingsByAuditPage), null);
  assert.equal(Object.getPrototypeOf(snapshot.activeOverlayByTab), null);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(JSON.stringify(snapshot).includes('token='), false);
});

test('fails closed on revision rollback or model hash divergence', async () => {
  const { store, sessionArea } = clockFixture();
  await store.put(bindingFixture());
  const writesBefore = sessionArea.writes.length;

  for (const input of [
    { auditId: 'audit-1', occurrenceId: 'occ-1', expectedModelRevision: 3, expectedModelHash: HASH },
    { auditId: 'audit-1', occurrenceId: 'occ-1', expectedModelRevision: 4, expectedModelHash: 'c'.repeat(64) },
  ]) {
    await assert.rejects(
      store.findTarget(input),
      error => error instanceof Error && error.message === 'Modelo divergente.',
    );
  }
  await assert.rejects(
    store.findTarget({ auditId: 'audit-1', occurrenceId: 'occ-1', expectedModelRevision: 4 }),
    error => error instanceof TypeError && error.message === 'HIGHLIGHT_INPUT_INVALID',
  );
  assert.equal(sessionArea.writes.length, writesBefore);
});

test('finds unchanged content after export bookkeeping advances without refreshing expiry or rewriting proof', async () => {
  const { store, sessionArea } = clockFixture();
  const binding = bindingFixture();
  await store.put(binding);
  const writes = sessionArea.writes.length;
  const found = await store.findTarget({ auditId: binding.auditId, occurrenceId: 'occ-1',
    expectedModelRevision: binding.modelRevision + 1, expectedModelHash: HASH });
  assert.deepEqual(found.binding, binding);
  assert.equal(sessionArea.writes.length, writes);
  await assert.rejects(store.findTarget({ auditId: binding.auditId, occurrenceId: 'occ-1',
    expectedModelRevision: binding.modelRevision + 1, expectedModelHash: 'c'.repeat(64) }), /Modelo divergente/u);
  await assert.rejects(store.findTarget({ auditId: binding.auditId, occurrenceId: 'occ-1',
    expectedModelRevision: binding.modelRevision - 1, expectedModelHash: HASH }), /Modelo divergente/u);
});

test('serializes same-page collision so only one concurrent binding wins', async () => {
  const { store, sessionArea } = clockFixture();
  const first = bindingFixture();
  const second = bindingFixture({ topDocumentId: 'document-replaced' });
  const results = await Promise.allSettled([store.put(first), store.put(second)]);

  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.message, 'HIGHLIGHT_BINDING_CONFLICT');
  assert.equal(sessionArea.writes.length, 1);
  assert.equal((await store.findTarget({ auditId: 'audit-1', occurrenceId: 'occ-1' })).binding.topDocumentId, 'document-main');
});

test('makes an identical repeated put idempotent without renewing or writing again', async () => {
  const { store, sessionArea, clock } = clockFixture();
  const binding = bindingFixture();
  await store.put(binding);
  clock.value += 10_000;
  const repeated = await store.put(structuredClone(binding));

  assert.equal(sessionArea.writes.length, 1);
  assert.equal(repeated.createdAt, EPOCH);
  assert.equal(repeated.expiresAt, EPOCH + TTL_MS);
});

test('bounds the whole live registry to 5,000 occurrence targets', async () => {
  const { store, sessionArea } = clockFixture();
  await store.put(bindingWithTargetRange({ pageId: 'page-1', start: 0, count: 2_500 }));
  await store.put(bindingWithTargetRange({ pageId: 'page-2', start: 2_500, count: 2_500 }));
  const writesBefore = sessionArea.writes.length;

  await assert.rejects(
    store.put(bindingWithTargetRange({ pageId: 'page-3', start: 5_000, count: 1 })),
    error => error instanceof Error && error.message === 'HIGHLIGHT_BINDING_CAPACITY',
  );
  assert.equal(sessionArea.writes.length, writesBefore);
});

test('deletes an expired well-formed binding with one set and never renews it', async () => {
  const { store, sessionArea, clock } = clockFixture();
  await store.put(bindingFixture());
  clock.value = EPOCH + TTL_MS;
  const found = await store.findTarget({
    auditId: 'audit-1', occurrenceId: 'occ-1', expectedModelRevision: 4, expectedModelHash: HASH,
  });

  assert.equal(found, null);
  assert.equal(sessionArea.writes.length, 2);
  assert.equal(Object.keys((await store.snapshot()).bindingsByAuditPage).length, 0);
});

test('rejects future-issued records and regressive clocks without any write', async () => {
  const { store, sessionArea, clock } = clockFixture();
  const future = bindingFixture({ createdAt: EPOCH + 1_000, expiresAt: EPOCH + 1_000 + TTL_MS });
  await assert.rejects(
    store.put(future),
    error => error instanceof TypeError && error.message === 'HIGHLIGHT_CLOCK_INVALID',
  );
  assert.equal(sessionArea.writes.length, 0);

  await store.put(bindingFixture());
  const writesBefore = sessionArea.writes.length;
  clock.value = EPOCH - 1;
  await assert.rejects(
    store.findTarget({ auditId: 'audit-1', occurrenceId: 'occ-1' }),
    error => error instanceof TypeError && error.message === 'HIGHLIGHT_CLOCK_INVALID',
  );
  assert.equal(sessionArea.writes.length, writesBefore);
});

test('revalidates a monotonic clock after awaited storage before put, find and overlay authorization', async () => {
  {
    const sessionArea = createSessionArea();
    const store = createHighlightBindingStore({
      sessionArea,
      now: sequenceClock([EPOCH, EPOCH + TTL_MS]),
    });
    await assert.rejects(
      store.put(bindingFixture()),
      error => error instanceof Error && error.message === 'HIGHLIGHT_BINDING_EXPIRED',
    );
    assert.equal(sessionArea.writes.length, 0);
  }

  {
    const sessionArea = createSessionArea(registryFixture());
    const store = createHighlightBindingStore({
      sessionArea,
      now: sequenceClock([EPOCH, EPOCH + TTL_MS]),
    });
    assert.equal(await store.findTarget({ auditId: 'audit-1', occurrenceId: 'occ-1' }), null);
  }

  {
    const sessionArea = createSessionArea(registryFixture());
    const store = createHighlightBindingStore({
      sessionArea,
      now: sequenceClock([EPOCH, EPOCH + TTL_MS]),
    });
    assert.deepEqual(await store.beginOverlay(overlayFixture()), {
      ok: false, code: 'HIGHLIGHT_OVERLAY_EXPIRED',
    });
    assert.equal(sessionArea.writes.length, 0);
  }

  {
    const installing = overlayFixture();
    const sessionArea = createSessionArea(registryFixture({ overlay: installing }));
    const store = createHighlightBindingStore({
      sessionArea,
      now: sequenceClock([EPOCH, EPOCH + TTL_MS]),
    });
    assert.deepEqual(await store.activateOverlay({
      tabId: 7, nonce: installing.nonce, expectedRevision: 1,
    }), { ok: false, code: 'HIGHLIGHT_OVERLAY_EXPIRED' });
    assert.equal(sessionArea.writes.length, 0);
  }
});

test('rejects a clock that regresses across an awaited storage boundary', async () => {
  const sessionArea = createSessionArea();
  const store = createHighlightBindingStore({
    sessionArea,
    now: sequenceClock([EPOCH, EPOCH - 1]),
  });

  await assert.rejects(
    store.put(bindingFixture()),
    error => error instanceof TypeError && error.message === 'HIGHLIGHT_CLOCK_INVALID',
  );
  assert.equal(sessionArea.writes.length, 0);
});

test('does not return stale authorization when the clock crosses expiry during confirmed persistence', async () => {
  {
    const sessionArea = createSessionArea();
    const store = createHighlightBindingStore({
      sessionArea,
      now: sequenceClock([EPOCH, EPOCH, EPOCH, EPOCH + TTL_MS]),
    });
    await assert.rejects(
      store.put(bindingFixture()),
      error => error instanceof Error && error.message === 'HIGHLIGHT_BINDING_EXPIRED',
    );
    assert.equal(sessionArea.writes.length, 1);
  }

  {
    const sessionArea = createSessionArea(registryFixture());
    const store = createHighlightBindingStore({
      sessionArea,
      now: sequenceClock([EPOCH, EPOCH, EPOCH + TTL_MS]),
    });
    assert.equal(await store.findTarget({ auditId: 'audit-1', occurrenceId: 'occ-1' }), null);
    assert.equal(sessionArea.writes.length, 0);
  }

  {
    const sessionArea = createSessionArea(registryFixture());
    const store = createHighlightBindingStore({
      sessionArea,
      now: sequenceClock([EPOCH, EPOCH, EPOCH, EPOCH + TTL_MS]),
    });
    assert.deepEqual(await store.beginOverlay(overlayFixture()), {
      ok: false, code: 'HIGHLIGHT_OVERLAY_EXPIRED',
    });
    assert.equal(sessionArea.writes.length, 1);
    assert.equal((await store.getActiveOverlay(7)).state, 'installing');
  }

  {
    const installing = overlayFixture();
    const sessionArea = createSessionArea(registryFixture({ overlay: installing }));
    const store = createHighlightBindingStore({
      sessionArea,
      now: sequenceClock([EPOCH, EPOCH, EPOCH, EPOCH + TTL_MS]),
    });
    assert.deepEqual(await store.activateOverlay({
      tabId: 7, nonce: installing.nonce, expectedRevision: 1,
    }), { ok: false, code: 'HIGHLIGHT_OVERLAY_EXPIRED' });
    assert.equal(sessionArea.writes.length, 1);
    assert.equal((await store.getActiveOverlay(7)).state, 'active');
  }
});

test('serializes one overlay owner per tab and enforces nonce/revision CAS through confirmed clear', async () => {
  const { store, sessionArea } = clockFixture();
  await store.put(bindingFixture());
  const overlayA = overlayFixture();
  const overlayB = overlayFixture({ nonce: 'B'.repeat(22), occurrenceId: 'occ-other' });
  const starts = await Promise.all([store.beginOverlay(overlayA), store.beginOverlay(overlayB)]);
  assert.equal(starts.filter(value => value.ok).length, 1);
  assert.equal(sessionArea.writes.length, 2);

  let active = await store.getActiveOverlay(7);
  assert.equal(active.state, 'installing');
  assert.equal(active.revision, 1);
  const winningNonce = active.nonce;

  const writesBeforeWrongCas = sessionArea.writes.length;
  assert.deepEqual(await store.activateOverlay({ tabId: 7, nonce: 'Z'.repeat(22), expectedRevision: 1 }), {
    ok: false, code: 'HIGHLIGHT_OVERLAY_CAS_MISMATCH',
  });
  assert.equal(sessionArea.writes.length, writesBeforeWrongCas);

  const activated = await store.activateOverlay({ tabId: 7, nonce: winningNonce, expectedRevision: 1 });
  assert.equal(activated.ok, true);
  assert.equal(activated.overlay.state, 'active');
  assert.equal(activated.overlay.revision, 2);
  assert.equal(activated.overlay.expiresAt, EPOCH + TTL_MS);

  const clearing = await store.beginOverlayClear({ tabId: 7, nonce: winningNonce, expectedRevision: 2 });
  assert.equal(clearing.ok, true);
  assert.equal(clearing.overlay.state, 'clearing');
  assert.equal(clearing.overlay.revision, 3);
  assert.equal(clearing.overlay.expiresAt, EPOCH + TTL_MS);

  const writesBeforeUnconfirmed = sessionArea.writes.length;
  assert.deepEqual(await store.completeOverlayClear({ tabId: 7, nonce: winningNonce, expectedRevision: 2 }), {
    ok: false, code: 'HIGHLIGHT_OVERLAY_CAS_MISMATCH',
  });
  assert.equal(sessionArea.writes.length, writesBeforeUnconfirmed);
  assert.equal((await store.getActiveOverlay(7)).state, 'clearing');

  const completed = await store.completeOverlayClear({ tabId: 7, nonce: winningNonce, expectedRevision: 3 });
  assert.deepEqual(completed, { ok: true, overlay: null });
  assert.equal(await store.getActiveOverlay(7), null);
  assert.equal(sessionArea.writes.length, 5);
});

test('requires an overlay owner to match the exact stored binding and its original expiry', async () => {
  const { store, sessionArea } = clockFixture();
  const orphan = await store.beginOverlay(overlayFixture());
  assert.deepEqual(orphan, { ok: false, code: 'HIGHLIGHT_OVERLAY_BINDING_MISMATCH' });
  assert.equal(sessionArea.writes.length, 0);

  await store.put(bindingFixture());
  const writesBefore = sessionArea.writes.length;
  for (const overlay of [
    overlayFixture({ auditId: 'audit-other' }),
    overlayFixture({ occurrenceId: 'occ-other' }),
    overlayFixture({ expiresAt: EPOCH + TTL_MS - 16 }),
    overlayFixture({ documentId: 'document-other' }),
  ]) {
    assert.deepEqual(await store.beginOverlay(overlay), {
      ok: false, code: 'HIGHLIGHT_OVERLAY_BINDING_MISMATCH',
    });
  }
  assert.equal(sessionArea.writes.length, writesBefore);
});

test('retains expired and interrupted overlay owners for recovery rather than silently deleting them', async () => {
  const { store, sessionArea, clock } = clockFixture();
  await store.put(bindingFixture());
  await store.beginOverlay(overlayFixture());
  clock.value = EPOCH + TTL_MS + 1;

  const owner = await store.getActiveOverlay(7);
  const recoverable = await store.listRecoverableOverlays();

  assert.equal(owner.state, 'installing');
  assert.deepEqual(recoverable, [owner]);
  assert.equal(sessionArea.writes.length, 2);
});

test('refuses tab invalidation while any overlay owner still requires confirmed CAS cleanup', async () => {
  const first = clockFixture();
  await first.store.put(bindingFixture());
  await first.store.beginOverlay(overlayFixture());
  await assert.rejects(
    first.store.invalidateTab(7),
    error => error instanceof Error && error.message === 'HIGHLIGHT_OVERLAY_ACTIVE',
  );
  assert.equal(first.sessionArea.writes.length, 2);
  assert.equal((await first.store.getActiveOverlay(7)).state, 'installing');
  assert.ok(await first.store.findTarget({ auditId: 'audit-1', occurrenceId: 'occ-1' }));

  const clearing = await first.store.beginOverlayClear({
    tabId: 7, nonce: 'N'.repeat(22), expectedRevision: 1,
  });
  assert.equal(clearing.ok, true);
  const completed = await first.store.completeOverlayClear({
    tabId: 7, nonce: 'N'.repeat(22), expectedRevision: 2,
  });
  assert.equal(completed.ok, true);
  const invalidated = await first.store.invalidateTab(7);
  assert.equal(invalidated, true);
  assert.equal(first.sessionArea.writes.length, 5);
  assert.deepEqual(await first.store.snapshot(), {
    version: 1, bindingsByAuditPage: Object.create(null), activeOverlayByTab: Object.create(null),
  });

  const second = clockFixture();
  await second.store.put(bindingFixture());
  const deleted = await second.store.deleteAudit('audit-1');
  assert.equal(deleted, true);
  assert.equal(second.sessionArea.writes.length, 2);
  assert.equal(Object.keys((await second.store.snapshot()).bindingsByAuditPage).length, 0);
});

test('rejects malformed, accessor-backed, dangerous and cross-revision registries without repair', async () => {
  const binding = bindingFixture();
  const otherTargets = Object.create(null);
  otherTargets['occ-2'] = {
    ...structuredClone(binding.targets['occ-1']), evidenceId: 'ev-2', backendNodeId: 92,
  };
  const other = bindingFixture({
    pageId: 'page-2', modelRevision: 5, modelHash: 'd'.repeat(64), targets: otherTargets,
  });
  const divergentBindings = Object.create(null);
  divergentBindings['audit-1\u0000page-1'] = binding;
  divergentBindings['audit-1\u0000page-2'] = other;

  const dangerousBindings = Object.create(null);
  Object.defineProperty(dangerousBindings, 'constructor', { enumerable: true, value: binding });

  const registries = [
    { version: 1, bindingsByAuditPage: {}, activeOverlayByTab: {}, extra: true },
    { version: 1, bindingsByAuditPage: dangerousBindings, activeOverlayByTab: Object.create(null) },
    { version: 1, bindingsByAuditPage: divergentBindings, activeOverlayByTab: Object.create(null) },
  ];
  for (const registry of registries) {
    const area = createSessionArea({ [REGISTRY_KEY]: registry });
    const store = createHighlightBindingStore({ sessionArea: area, now: () => EPOCH });
    await assert.rejects(store.snapshot(), /HIGHLIGHT_REGISTRY_INVALID|Modelo divergente\./u);
    assert.equal(area.writes.length, 0);
  }

  let getterCalls = 0;
  const envelope = {};
  Object.defineProperty(envelope, REGISTRY_KEY, {
    enumerable: true,
    get() { getterCalls += 1; return {}; },
  });
  const area = createSessionArea();
  area.get = async () => envelope;
  const store = createHighlightBindingStore({ sessionArea: area, now: () => EPOCH });
  await assert.rejects(store.snapshot(), /HIGHLIGHT_REGISTRY_INVALID/u);
  assert.equal(getterCalls, 0);
  assert.equal(area.writes.length, 0);

  let thrownMessageReads = 0;
  const hostileThrown = {};
  Object.defineProperty(hostileThrown, 'message', {
    get() { thrownMessageReads += 1; return 'Modelo divergente.'; },
  });
  const hostileEnvelope = new Proxy({}, {
    ownKeys() { throw hostileThrown; },
  });
  const hostileArea = createSessionArea();
  hostileArea.get = async () => hostileEnvelope;
  const hostileStore = createHighlightBindingStore({ sessionArea: hostileArea, now: () => EPOCH });
  await assert.rejects(hostileStore.snapshot(), /HIGHLIGHT_REGISTRY_INVALID/u);
  assert.equal(thrownMessageReads, 0);
});

test('normalizes hostile storage errors and text coercion without invoking their traps', async () => {
  let messageReads = 0;
  const thrown = {};
  Object.defineProperty(thrown, 'message', {
    get() { messageReads += 1; return 'Modelo divergente.'; },
  });
  const area = createSessionArea();
  area.set = async () => { throw thrown; };
  const store = createHighlightBindingStore({ sessionArea: area, now: () => EPOCH });
  await assert.rejects(store.put(bindingFixture()), /HIGHLIGHT_REGISTRY_WRITE_DENIED/u);
  assert.equal(messageReads, 0);

  let coercions = 0;
  const hostileNonce = { [Symbol.toPrimitive]() { coercions += 1; return 'N'.repeat(22); } };
  const clean = clockFixture();
  await assert.rejects(
    clean.store.beginOverlay({ ...overlayFixture(), nonce: hostileNonce }),
    /HIGHLIGHT_INPUT_INVALID/u,
  );
  assert.equal(coercions, 0);
  assert.equal(clean.sessionArea.writes.length, 0);
});

test('rejects invalid factory and public operation inputs before reading storage', async () => {
  assert.throws(() => createHighlightBindingStore(), /HIGHLIGHT_BINDING_STORE_INVALID/u);
  let reads = 0;
  const sessionArea = {
    async get() { reads += 1; return {}; },
    async set() {},
  };
  const store = createHighlightBindingStore({ sessionArea, now: () => EPOCH });
  await assert.rejects(store.findTarget({ auditId: '__proto__', occurrenceId: 'occ-1' }), /HIGHLIGHT_INPUT_INVALID/u);
  await assert.rejects(store.beginOverlay({ ...overlayFixture(), rawUrl: 'https://private.test/' }), /HIGHLIGHT_INPUT_INVALID/u);
  await assert.rejects(store.activateOverlay({ tabId: 7, nonce: 'bad', expectedRevision: 1 }), /HIGHLIGHT_INPUT_INVALID/u);
  assert.equal(reads, 0);
});

test('a review answer moves the audit bindings to the new model identity and renews their window', async () => {
  const { store, clock } = clockFixture();
  await store.put(bindingFixture());
  await store.put(bindingFixture({ auditId: 'audit-2', modelRevision: 1, modelHash: 'c'.repeat(64) }));
  clock.value = EPOCH + 20 * 60_000;
  const next = 'd'.repeat(64);
  assert.equal(await store.refreshAudit({ auditId: 'audit-1', fromModelHash: HASH, modelRevision: 5, modelHash: next }), 1);
  const found = await store.findTarget({ auditId: 'audit-1', occurrenceId: 'occ-1', expectedModelRevision: 5, expectedModelHash: next });
  assert.equal(found.binding.modelRevision, 5);
  assert.equal(found.binding.modelHash, next);
  assert.equal(found.binding.createdAt, clock.value);
  assert.equal(found.binding.expiresAt, clock.value + TTL_MS);
  // Repetir com a identidade já nova é inofensivo; a auditoria vizinha não muda.
  assert.equal(await store.refreshAudit({ auditId: 'audit-1', fromModelHash: HASH, modelRevision: 5, modelHash: next }), 1);
  const foreign = await store.findTarget({ auditId: 'audit-2', occurrenceId: 'occ-1' });
  assert.equal(foreign.binding.modelHash, 'c'.repeat(64));
  // Depois de 45 minutos do registro original a prova ainda vale, porque foi renovada.
  clock.value = EPOCH + 45 * 60_000;
  assert.notEqual(await store.findTarget({ auditId: 'audit-1', occurrenceId: 'occ-1' }), null);
});

test('binding refresh refuses an unexpected model identity, an older target revision and expired proofs', async () => {
  const { store, clock } = clockFixture();
  await store.put(bindingFixture());
  assert.equal(await store.refreshAudit({ auditId: 'audit-1', fromModelHash: 'e'.repeat(64), modelRevision: 5, modelHash: 'd'.repeat(64) }), 0);
  assert.equal(await store.refreshAudit({ auditId: 'audit-1', fromModelHash: HASH, modelRevision: 3, modelHash: 'd'.repeat(64) }), 0);
  assert.equal((await store.findTarget({ auditId: 'audit-1', occurrenceId: 'occ-1' })).binding.modelHash, HASH);
  await assert.rejects(store.refreshAudit({ auditId: 'audit-1', fromModelHash: 'pending', modelRevision: 5, modelHash: HASH }),
    /HIGHLIGHT_INPUT_INVALID/u);
  clock.value = EPOCH + TTL_MS;
  assert.equal(await store.refreshAudit({ auditId: 'audit-1', fromModelHash: HASH, modelRevision: 5, modelHash: 'd'.repeat(64) }), 0);
  assert.equal(await store.refreshAudit({ auditId: 'missing', fromModelHash: HASH, modelRevision: 5, modelHash: 'd'.repeat(64) }), 0);
});

test('renewing an audit keeps its model identity and only extends live proofs', async () => {
  const { store, clock } = clockFixture();
  await store.put(bindingFixture());
  clock.value = EPOCH + 25 * 60_000;
  assert.equal(await store.renewAudit('audit-1'), 1);
  const renewed = await store.findTarget({ auditId: 'audit-1', occurrenceId: 'occ-1', expectedModelRevision: 4, expectedModelHash: HASH });
  assert.equal(renewed.binding.expiresAt, clock.value + TTL_MS);
  clock.value = EPOCH + 25 * 60_000 + TTL_MS;
  assert.equal(await store.renewAudit('audit-1'), 0, 'uma prova vencida não é ressuscitada');
  assert.equal(await store.renewAudit('missing'), 0);
});
