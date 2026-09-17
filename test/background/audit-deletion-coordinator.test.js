import assert from 'node:assert/strict';
import test from 'node:test';
import { createInMemoryAuditStore } from '../../src/storage/audit-store.js';
import { createPixelCaptureStateV1 } from '../../src/background/pixel-capture-consent.js';
import { createCapturePolicyV1 } from '../../src/core/privacy/capture-policy.js';
import { sanitizeEvidenceUrlV1 } from '../../src/core/privacy/evidence-url.js';
import { createHighlightBindingV1 } from '../../src/background/highlight-binding.js';
import { createHighlightBindingStore } from '../../src/background/highlight-binding-store.js';
import { createHighlightController } from '../../src/background/highlight-controller.js';
import { createTargetOperationQueue } from '../../src/background/target-operation-queue.js';

const moduleUrl = new URL('../../src/background/audit-deletion-coordinator.js', import.meta.url);
const coordinatorModule = await import(moduleUrl.href).catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND' && error.url === moduleUrl.href) return {};
  throw error;
});
const NOW = '2026-09-05T14:00:00.000Z';
const EPOCH = Date.parse(NOW);
const AUDIT = 'audit-a';
const FOREIGN = 'audit-b';
const SECRET = 'PRIVATE_SENTINEL';
const DENIED = { status: 'denied', code: 'AUDIT_DELETION_DENIED' };
const CLEANERS = ['authority', 'panel', 'report-port', 'overlay', 'binding', 'raw',
  'pixel', 'blob', 'export-launch', 'report-launch', 'owned'];
const DEPENDENCIES = ['store', 'authority', 'panelPortRegistry', 'reportPortRegistry',
  'highlightController', 'highlightBindingStore', 'reportLaunch', 'exportLaunch',
  'rawNavigationVault', 'pixelCaptureState', 'ownedDisposableTabStore', 'blobRegistry', 'now'];
const METHODS = {
  store: ['stageAuditDeletionV1', 'listDeletionTombstonesV1', 'recordDeletionCleanupFailureV1', 'completeAuditDeletionV1'],
  authority: ['clearAudit', 'finalizeAudit'], panelPortRegistry: ['clearAudit'], reportPortRegistry: ['clearAudit'],
  highlightController: ['clearAudit'], highlightBindingStore: ['deleteAudit'],
  reportLaunch: ['clearAudit'], exportLaunch: ['clearAudit'], rawNavigationVault: ['clearAudit'],
  pixelCaptureState: ['readSuspension', 'revokeAudit', 'finish'], ownedDisposableTabStore: ['clearAudit', 'purgeRemovedAudit'], blobRegistry: ['clearAudit'],
};
const copy = value => value === undefined ? undefined : structuredClone(value);
const request = (auditId = AUDIT) => ({ auditId, reason: 'retention-expired', expectedRevision: null,
  terminalReceipt: null, manualAuthorization: null });
const tombstone = (auditId = AUDIT) => ({ version: 1, auditId, reason: 'retention-expired', requestedAt: NOW,
  phase: 'transient-cleanup-pending', attempts: 0, lastAttemptAt: null });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const unavailable = error => {
  assert.equal(error.constructor, Error);
  assert.equal(error.message, 'AUDIT_DELETION_UNAVAILABLE');
  assert.equal(error.cause, undefined);
  assert.equal(JSON.stringify(error).includes(SECRET), false);
  return true;
};
function create(options) {
  assert.equal(typeof coordinatorModule.createAuditDeletionCoordinatorV1, 'function', 'coordinator factory is missing');
  return coordinatorModule.createAuditDeletionCoordinatorV1(options);
}

function fixture() {
  const calls = [];
  const handlers = {};
  const models = new Set([AUDIT, FOREIGN]);
  const tombstones = new Map();
  const resources = new Map([AUDIT, FOREIGN].map(id => [id, new Set(CLEANERS)]));
  const boundary = (name, implementation) => async (...args) => {
    calls.push([name, ...copy(args)]);
    return Object.hasOwn(handlers, name) ? handlers[name](...args) : implementation(...args);
  };
  const clean = (name, acknowledgement) => boundary(name, id => {
    resources.get(id)?.delete(name);
    return copy(acknowledgement);
  });
  const store = {
    stageAuditDeletionV1: boundary('stage', input => {
      if (tombstones.has(input.auditId)) return { status: 'staged', tombstone: copy(tombstones.get(input.auditId)) };
      if (!models.has(input.auditId)) return copy(DENIED);
      models.delete(input.auditId);
      const record = { ...tombstone(input.auditId), requestedAt: input.now, reason: input.reason };
      tombstones.set(input.auditId, record);
      return { status: 'staged', tombstone: copy(record) };
    }),
    listDeletionTombstonesV1: boundary('list', ({ limit }) => [...tombstones.values()].slice(0, limit).map(copy)),
    recordDeletionCleanupFailureV1: boundary('failure', ({ auditId, at }) => {
      const record = tombstones.get(auditId);
      if (!record) return false;
      tombstones.set(auditId, { ...record, attempts: record.attempts + 1, lastAttemptAt: at });
      return true;
    }),
    completeAuditDeletionV1: boundary('complete', ({ auditId }) => tombstones.delete(auditId)),
  };
  const options = { store,
    authority: { clearAudit: clean('authority', { ok: true, invalidated: 0 }),
      finalizeAudit: boundary('authority-final', () => ({ ok: true, purged: 0 })) },
    panelPortRegistry: { clearAudit: clean('panel', true) },
    reportPortRegistry: { clearAudit: clean('report-port', 0) },
    highlightController: { clearAudit: clean('overlay', { ok: true, state: 'clear' }) },
    highlightBindingStore: { deleteAudit: clean('binding', false) },
    rawNavigationVault: { clearAudit: clean('raw', 0) },
    pixelCaptureState: { readSuspension: clean('pixel', null), revokeAudit: boundary('revoke', () => {
      throw new Error('Unexpected revoke for absent suspension');
    }), finish: boundary('pixel-finish', () => true) },
    blobRegistry: { clearAudit: clean('blob', 0) },
    exportLaunch: { clearAudit: clean('export-launch', true) },
    reportLaunch: { clearAudit: clean('report-launch', true) },
    ownedDisposableTabStore: { clearAudit: clean('owned', 0), purgeRemovedAudit: boundary('owned-purge', () => 0) },
    now() { calls.push(['now']); return handlers.now ? handlers.now() : NOW; },
  };
  return { calls, handlers, models, tombstones, resources, options, store, create: () => create(options) };
}

function sessionArea() {
  const values = {};
  return { values,
    async get(key) { return key === null ? copy(values) : Object.hasOwn(values, key) ? { [key]: copy(values[key]) } : {}; },
    async set(entries) { Object.assign(values, copy(entries)); },
    async remove(key) { for (const item of Array.isArray(key) ? key : [key]) delete values[item]; },
  };
}

const manualRequest = (scope = 'one') => ({ auditId: AUDIT, reason: 'manual', expectedRevision: 3,
  terminalReceipt: null, manualAuthorization: { version: 1, scope,
    auditId: scope === 'one' ? AUDIT : null, authorizedAt: NOW } });

function postExportRequest() {
  const mime = ['text/html;charset=utf-8', 'application/pdf', 'text/csv;charset=utf-8', 'application/json;charset=utf-8'];
  const terminalReceipt = { version: 1, auditId: AUDIT, modelRevision: 2, modelHash: 'a'.repeat(64),
    attemptId: '1', status: 'complete', formats: ['html', 'pdf', 'csv', 'json'].map((format, index) => ({
      format, mimeType: mime[index], byteSize: 10, sha256: 'b'.repeat(64), downloadId: index + 1, state: 'complete',
    })) };
  return { auditId: AUDIT, reason: 'post-export', expectedRevision: 3, terminalReceipt, manualAuthorization: null };
}

test('R3-F3 post-export staging defers every cleaner until explicit recovery outside the export lock', async () => {
  const env = fixture(); const coordinator = env.create();
  const request = postExportRequest();
  assert.deepEqual(await coordinator.request(request), { status: 'pending', auditId: AUDIT });
  assert.deepEqual(env.calls.map(row => row[0]), ['now', 'stage']);
  assert.deepEqual(env.calls[1][1], { auditId: AUDIT, reason: 'post-export', now: NOW,
    expectedRevision: 3, terminalReceipt: request.terminalReceipt });
  assert.equal(env.models.has(AUDIT), false); assert.equal(env.tombstones.get(AUDIT).reason, 'post-export');
  await coordinator.resumePending({ limit: 25 });
  assert.equal(env.tombstones.size, 0); assert.equal(env.models.has(FOREIGN), true);
});

test('R3-F3 post-export requires complete receipt and exact audit plus terminal revision before staging', async () => {
  const request = postExportRequest();
  for (const patch of [
    { expectedRevision: 2 }, { manualAuthorization: manualRequest().manualAuthorization },
    { terminalReceipt: { ...request.terminalReceipt, auditId: FOREIGN } },
    { terminalReceipt: { ...request.terminalReceipt, status: 'partial', formats: request.terminalReceipt.formats.slice(0, 2) } },
  ]) {
    const env = fixture();
    assert.deepEqual(await env.create().request({ ...request, ...patch }), DENIED);
    assert.deepEqual(env.calls, []);
  }
});

test('R3-F1 manual one and all authority stage the current revision before cleanup', async t => {
  for (const scope of ['one', 'all']) await t.test(scope, async () => {
    const env = fixture();
    assert.deepEqual(await env.create().request(manualRequest(scope)), { status: 'complete', auditId: AUDIT });
    assert.deepEqual(env.calls[1], ['stage', { auditId: AUDIT, reason: 'manual', now: NOW,
      expectedRevision: 3, terminalReceipt: null }]);
    assert.equal(env.models.has(AUDIT), false);
    assert.equal(env.models.has(FOREIGN), true);
    assert.deepEqual([...env.resources.get(FOREIGN)], CLEANERS);
  });
});

test('R3-F1 invalid manual proofs cannot stage or clean any audit', async () => {
  const base = manualRequest();
  const invalid = [
    { ...base, expectedRevision: null }, { ...base, expectedRevision: 0 },
    { ...base, terminalReceipt: {} }, { ...base, manualAuthorization: null },
    ...[{ auditId: FOREIGN }, { scope: 'all' }, { scope: 'unknown' }, { version: 2 },
      { authorizedAt: 'not-a-date' }, { extra: true }].map(patch => ({ ...base,
      manualAuthorization: { ...base.manualAuthorization, ...patch } })),
  ];
  let accessed = 0;
  invalid.push({ ...base, manualAuthorization: { ...base.manualAuthorization,
    get auditId() { accessed++; return AUDIT; } } });
  for (const input of invalid) {
    const env = fixture();
    assert.deepEqual(await env.create().request(input), DENIED);
    assert.deepEqual(env.calls, []);
  }
  assert.equal(accessed, 0);
});

test('R3-F1 manual cleanup failure preserves a recoverable manual tombstone', async () => {
  const env = fixture(); env.handlers.blob = () => { throw new Error(SECRET); };
  const coordinator = env.create();
  assert.deepEqual(await coordinator.request(manualRequest()), { status: 'pending', auditId: AUDIT });
  assert.equal(env.models.has(AUDIT), false);
  assert.equal(env.tombstones.get(AUDIT).reason, 'manual');
  assert.equal(env.tombstones.get(AUDIT).attempts, 1);
  delete env.handlers.blob;
  await coordinator.resumePending({ limit: 25 });
  assert.equal(env.tombstones.has(AUDIT), false);
  assert.equal(env.models.has(FOREIGN), true);
});
async function pixelFixture(state = 'paused', auditId = AUDIT) {
  const area = sessionArea();
  const pixel = createPixelCaptureStateV1({ sessionArea: area, now: () => EPOCH,
    randomBytes: length => new Uint8Array(length).fill(1) });
  const observedTarget = { version: 'ObservedTargetV1', kind: 'attached', tabId: 7, windowId: 3,
    documentId: 'document-a', urlEvidence: sanitizeEvidenceUrlV1('https://example.test/private?secret=1'),
    urlSessionDigest: `hmac-sha256:${'a'.repeat(43)}` };
  const capturePolicy = createCapturePolicyV1({ mode: 'full-evidence', includeQuery: false });
  const paused = await pixel.pause({ auditId, observedTarget, mode: 'full-evidence', capturePolicy,
    categories: ['password'], authorityExpiresAt: EPOCH + 600_000 });
  if (state === 'resuming') await pixel.claimAndBeginResume({ auditId, consentId: paused.consentId,
    proof: { kind: 'attached', tabId: 7, windowId: 3, documentId: 'document-a', urlSessionDigest: observedTarget.urlSessionDigest },
    mode: 'full-evidence', categories: ['password'] });
  if (state === 'revoked' || state === 'finished') await pixel.revokeAudit({ auditId, consentId: paused.consentId, reason: 'AUDIT_CANCELLED' });
  if (state === 'finished') {
    const remove = area.remove;
    area.remove = async () => { throw new Error('Simulated terminal journal removal failure'); };
    await assert.rejects(pixel.finish({ auditId, consentId: paused.consentId }), /PIXEL_STATE_UNAVAILABLE/u);
    area.remove = remove;
  }
  return { pixel, area, suspension: await pixel.readSuspension(auditId) };
}

test('R3-A constructor and API reject authority expansion and capture dependency methods', async t => {
  await t.test('exact frozen surface', () => {
    const env = fixture(); const coordinator = env.create();
    assert.deepEqual(Object.keys(coordinator).sort(), ['request', 'resumePending']);
    assert.ok(Object.isFrozen(coordinator)); assert.deepEqual(env.calls, []);
  });
  for (const key of DEPENDENCIES) await t.test(`missing dependency ${key}`, () => {
    const env = fixture(); delete env.options[key];
    assert.throws(() => env.create(), unavailable); assert.deepEqual(env.calls, []);
  });
  for (const [dependency, methods] of Object.entries(METHODS)) for (const method of methods) {
    await t.test(`uncallable ${dependency}.${method}`, () => {
      const env = fixture(); env.options[dependency][method] = true;
      assert.throws(() => env.create(), unavailable); assert.deepEqual(env.calls, []);
    });
  }
  for (const extra of ['personaLeaseStore', 'authorization', Symbol('extra')]) await t.test(`extra ${String(extra)}`, () => {
    const env = fixture(); env.options[extra] = {};
    assert.throws(() => env.create(), unavailable); assert.deepEqual(env.calls, []);
  });
  await t.test('accessors are rejected without invoking them', () => {
    const env = fixture(); let accessed = 0;
    Object.defineProperty(env.options.authority, 'clearAudit', { enumerable: true, get() { accessed++; return () => true; } });
    assert.throws(() => env.create(), unavailable); assert.equal(accessed, 0);
  });
  await t.test('method mutation during await cannot redirect cleanup', async () => {
    const env = fixture(); const coordinator = env.create(); const gate = deferred(); const started = deferred();
    const stage = env.store.stageAuditDeletionV1;
    env.handlers.stage = async input => { delete env.handlers.stage; const result = await stage(input); started.resolve(); await gate.promise; return result; };
    const pending = coordinator.request(request()); await started.promise;
    for (const [dependency, methods] of Object.entries(METHODS)) for (const method of methods) {
      env.options[dependency][method] = () => { throw new Error(SECRET); };
    }
    env.options.now = () => { throw new Error(SECRET); }; gate.resolve();
    assert.deepEqual(await pending, { status: 'complete', auditId: AUDIT });
    assert.equal(env.tombstones.size, 0);
  });
});

test('R3-A request gate denies malformed input and non-retention authority before every effect', async t => {
  const invalid = [null, undefined, [], {}, { ...request(), extra: true },
    ...Object.keys(request()).map(key => { const value = request(); delete value[key]; return value; }),
    ...['', ' audit-a', '__latest__', 'x'.repeat(201), SECRET + '/url'].map(auditId => ({ ...request(), auditId })),
    { ...request(), reason: 'manual', manualAuthorization: { version: 1, scope: 'one', auditId: AUDIT, authorizedAt: NOW } },
    { ...request(), reason: 'post-export', terminalReceipt: { status: 'complete' } },
    { ...request(), reason: 'unknown' }, ...['expectedRevision', 'terminalReceipt', 'manualAuthorization'].map(key => ({ ...request(), [key]: {} })),
    Object.assign(request(), { [Symbol('extra')]: true })];
  for (const [index, input] of invalid.entries()) await t.test(`invalid ${index}`, async () => {
    const env = fixture(); const result = await env.create().request(input);
    assert.deepEqual(result, DENIED); assert.ok(Object.isFrozen(result));
    assert.deepEqual(env.calls, []); assert.equal(env.models.size, 2); assert.equal(env.tombstones.size, 0);
  });
  await t.test('getter authorization never executes', async () => {
    let reads = 0; const input = request();
    Object.defineProperty(input, 'manualAuthorization', { enumerable: true, get() { reads++; throw new Error(SECRET); } });
    const env = fixture(); assert.deepEqual(await env.create().request(input), DENIED);
    assert.equal(reads, 0); assert.deepEqual(env.calls, []);
  });
  for (const length of [160, 161, 200]) await t.test(`canonical audit range ${length}`, async () => {
    const env = fixture(); const id = 'a'.repeat(length); env.models.add(id);
    assert.deepEqual(await env.create().request(request(id)), { status: 'complete', auditId: id });
  });
});

test('R3-A happy path stages first and confirms all eleven cleaners in exact serial order', async t => {
  await t.test('zero counts and false binding acknowledgement complete', async () => {
    const env = fixture(); const result = await env.create().request(request());
    assert.deepEqual(result, { status: 'complete', auditId: AUDIT }); assert.ok(Object.isFrozen(result));
    assert.deepEqual(env.calls, [['now'], ['stage', { auditId: AUDIT, reason: 'retention-expired', now: NOW,
      expectedRevision: null, terminalReceipt: null }], ...CLEANERS.map(name => name === 'overlay'
      ? [name, AUDIT, 'audit-deleted'] : [name, AUDIT]), ['pixel', AUDIT], ['owned-purge', AUDIT],
      ['authority-final', AUDIT], ['complete', { auditId: AUDIT }]]);
    assert.equal(env.models.has(AUDIT), false); assert.equal(env.tombstones.size, 0);
    assert.deepEqual([...env.resources.get(AUDIT)], []);
    assert.deepEqual([...env.resources.get(FOREIGN)], CLEANERS); assert.equal(env.models.has(FOREIGN), true);
  });
  await t.test('next cleaner waits for the preceding acknowledgement', async () => {
    const env = fixture(); const gate = deferred(); const started = deferred();
    env.handlers.authority = async () => { started.resolve(); await gate.promise; return { ok: true, invalidated: 3 }; };
    const pending = env.create().request(request()); await started.promise;
    assert.deepEqual(env.calls.map(row => row[0]), ['now', 'stage', 'authority']);
    gate.resolve(); assert.equal((await pending).status, 'complete');
  });
  await t.test('completion false confirms tombstone already absent', async () => {
    const env = fixture(); env.handlers.complete = () => { env.tombstones.delete(AUDIT); return false; };
    assert.deepEqual(await env.create().request(request()), { status: 'complete', auditId: AUDIT });
    assert.equal(env.calls.some(row => row[0] === 'failure'), false);
  });
  await t.test('real R1 staging makes the model unavailable before cleanup and restart retains tombstone', async () => {
    const values = new Map([[AUDIT, { timestamps: { endedAt: '2026-08-01T00:00:00.000Z' } }]]);
    const store = createInMemoryAuditStore(values); const env = fixture(); env.options.store = store;
    env.handlers.authority = async () => { assert.equal(values.has(AUDIT), false); throw new Error(SECRET); };
    assert.equal((await env.create().request(request())).status, 'pending');
    const restarted = createInMemoryAuditStore(values);
    assert.equal((await restarted.listDeletionTombstonesV1({ limit: 25 }))[0].attempts, 1);
    env.options.store = restarted; delete env.handlers.authority;
    assert.equal(await env.create().resumePending({ limit: 25 }), undefined);
    assert.deepEqual(await restarted.listDeletionTombstonesV1({ limit: 25 }), []);
    assert.equal(await restarted.getAudit(AUDIT), undefined);
  });
});

test('R3-A stage and clock must confirm a valid durable boundary before cleanup', async t => {
  await t.test('exact stage denial is fixed and does not create a pending result', async () => {
    const env = fixture(); env.handlers.stage = () => copy(DENIED);
    assert.deepEqual(await env.create().request(request()), DENIED);
    assert.deepEqual(env.calls.map(row => row[0]), ['now', 'stage']);
  });
  const stages = [undefined, null, true, {}, { ...DENIED, extra: SECRET }, { status: 'denied', code: SECRET },
    { status: 'staged' }, { status: 'staged', tombstone: tombstone(FOREIGN) },
    { status: 'staged', tombstone: { ...tombstone(), attempts: -1 } },
    { status: 'staged', tombstone: { ...tombstone(), requestedAt: '2026-09-05' } },
    { status: 'staged', tombstone: { ...tombstone(), extra: SECRET } },
    { status: 'staged', tombstone: tombstone(), extra: SECRET }, 'throw'];
  for (const [index, result] of stages.entries()) await t.test(`bad stage ${index}`, async () => {
    const env = fixture(); env.handlers.stage = () => { if (result === 'throw') throw new Error(SECRET); return result; };
    await assert.rejects(env.create().request(request()), unavailable);
    assert.deepEqual(env.calls.map(row => row[0]), ['now', 'stage']);
  });
  for (const value of [null, EPOCH, new Date(NOW), '2026-09-05', '2026-09-05T14:00:00Z', 'throw']) {
    await t.test(`bad clock ${String(value)}`, async () => {
      const env = fixture(); env.handlers.now = () => { if (value === 'throw') throw new Error(SECRET); return value; };
      await assert.rejects(env.create().request(request()), unavailable);
      assert.deepEqual(env.calls, [['now']]);
    });
  }
});

test('R3-A each unconfirmed cleaner stops immediately and only durable failure acknowledgement means pending', async t => {
  for (const cleaner of CLEANERS) for (const bad of ['throw', undefined, null, 'true']) {
    if (cleaner === 'pixel' && bad === null) continue;
    await t.test(`${cleaner} ${String(bad)}`, async () => {
      const env = fixture(); env.handlers[cleaner] = () => { if (bad === 'throw') throw new Error(SECRET); return bad; };
      const result = await env.create().request(request());
      assert.deepEqual(result, { status: 'pending', auditId: AUDIT }); assert.ok(Object.isFrozen(result));
      assert.deepEqual(env.calls.map(row => row[0]), ['now', 'stage', ...CLEANERS.slice(0, CLEANERS.indexOf(cleaner) + 1), 'failure']);
      assert.deepEqual(env.calls.at(-1), ['failure', { auditId: AUDIT, at: NOW }]);
      assert.equal(env.tombstones.get(AUDIT).attempts, 1); assert.equal(env.models.has(AUDIT), false);
      assert.deepEqual([...env.resources.get(FOREIGN)], CLEANERS);
    });
  }
  const malformed = { authority: [true, { ok: true, invalidated: -1 }, { ok: true, invalidated: 0, extra: true }],
    panel: [false, 0], 'report-port': [-1, 0.5, Number.MAX_SAFE_INTEGER + 1],
    overlay: [true, { ok: true, state: 'absent' }, { ok: true, state: 'clear', extra: true }],
    binding: [0], raw: [false, -1], blob: [false, -1], 'export-launch': [false, 0],
    'report-launch': [false, 0], owned: [false, -1] };
  for (const [cleaner, values] of Object.entries(malformed)) for (const [index, value] of values.entries()) {
    await t.test(`${cleaner} malformed ${index}`, async () => {
      const env = fixture(); env.handlers[cleaner] = () => value;
      assert.equal((await env.create().request(request())).status, 'pending');
      assert.equal(env.calls.some(row => row[0] === 'complete'), false);
    });
  }
  for (const bad of ['throw', undefined, null, 0, 'true']) await t.test(`bad completion ${String(bad)}`, async () => {
    const env = fixture(); env.handlers.complete = () => { if (bad === 'throw') throw new Error(SECRET); return bad; };
    assert.equal((await env.create().request(request())).status, 'pending');
    assert.equal(env.tombstones.get(AUDIT).attempts, 1);
    assert.deepEqual(env.calls.slice(-2), [['complete', { auditId: AUDIT }], ['failure', { auditId: AUDIT, at: NOW }]]);
  });
  for (const bad of ['throw', false, undefined, null, 0, {}]) await t.test(`unconfirmed failure journal ${String(bad)}`, async () => {
    const env = fixture(); env.handlers.authority = () => false;
    env.handlers.failure = () => { if (bad === 'throw') throw new Error(SECRET); return bad; };
    await assert.rejects(env.create().request(request()), unavailable);
    assert.equal(env.calls.filter(row => row[0] === 'failure').length, 1);
    assert.equal(env.tombstones.has(AUDIT), true);
  });
});

test('R3-A real pixel tuple and overlay contracts are preserved', async t => {
  for (const state of ['paused', 'resuming', 'revoked', 'finished']) await t.test(`real pixel ${state}`, async () => {
    const env = fixture(); const real = await pixelFixture(state); const revocations = [];
    env.options.pixelCaptureState = { readSuspension: real.pixel.readSuspension,
      async revokeAudit(input) { revocations.push(copy(input)); return real.pixel.revokeAudit(input); }, finish: real.pixel.finish };
    assert.equal((await env.create().request(request())).status, 'complete');
    assert.deepEqual(revocations, [{ auditId: AUDIT, consentId: real.suspension.consentId, reason: 'AUDIT_DELETED' }]);
    assert.equal(await real.pixel.readSuspension(AUDIT), null, 'complete means the private suspension was erased, not only revoked');
  });
  await t.test('missing returned after a real suspension read is confirmed absence', async () => {
    const env = fixture(); const real = await pixelFixture(); env.handlers.pixel = () => real.suspension;
    env.handlers.revoke = () => { env.handlers.pixel = () => null;
      return { version: 'PixelRevokeResultV1', status: 'missing', suspension: null }; };
    assert.equal((await env.create().request(request())).status, 'complete');
  });
  const real = await pixelFixture(); const revoked = await real.pixel.revokeAudit({ auditId: AUDIT,
    consentId: real.suspension.consentId, reason: 'AUDIT_DELETED' });
  const badSuspensions = [true, {}, { auditId: AUDIT, consentId: real.suspension.consentId },
    { ...real.suspension, auditId: FOREIGN }, { ...real.suspension, consentId: SECRET },
    { ...real.suspension, extra: true }, { ...real.suspension, state: 'unknown' }];
  for (const [index, value] of badSuspensions.entries()) await t.test(`bad suspension ${index}`, async () => {
    const env = fixture(); env.handlers.pixel = () => value;
    assert.equal((await env.create().request(request())).status, 'pending');
    assert.equal(env.calls.some(row => row[0] === 'revoke' || row[0] === 'blob'), false);
  });
  const badRevokes = [true, {}, { status: 'revoked' },
    { version: 'PixelRevokeResultV1', status: 'mismatch', suspension: null },
    { version: 'PixelRevokeResultV1', status: 'missing', suspension: real.suspension },
    { ...revoked, suspension: null }, { ...revoked, suspension: real.suspension },
    { ...revoked, suspension: { ...revoked.suspension, auditId: FOREIGN } },
    { ...revoked, suspension: { ...revoked.suspension, consentId: 'AgICAgICAgICAgICAgICAg' } },
    { ...revoked, suspension: { ...revoked.suspension, documentId: 'foreign-doc' } },
    { ...revoked, suspension: { ...revoked.suspension, tabId: 99 } },
    { ...revoked, suspension: { ...revoked.suspension, urlSessionDigest: `hmac-sha256:${'b'.repeat(43)}` } },
    { ...revoked, extra: SECRET }, 'throw'];
  for (const [index, value] of badRevokes.entries()) await t.test(`bad revoke ${index}`, async () => {
    const env = fixture(); env.handlers.pixel = () => real.suspension;
    env.handlers.revoke = () => { if (value === 'throw') throw new Error(SECRET); return value; };
    assert.equal((await env.create().request(request())).status, 'pending');
    assert.equal(env.calls.some(row => row[0] === 'blob'), false);
  });
  await t.test('real overlay without native ACK preserves binding and tombstone', async () => {
    const env = fixture(); const area = sessionArea(); let acknowledge = false;
    const bindingStore = createHighlightBindingStore({ sessionArea: area, now: () => EPOCH });
    await bindingStore.put(createHighlightBindingV1({ version: 1, auditId: AUDIT, pageId: 'page-1',
      modelRevision: 1, modelHash: 'a'.repeat(64), tabId: 7, windowId: 3,
      topDocumentId: 'document-a', topUrlEvidence: 'https://example.test/',
      topUrlSessionDigest: `hmac-sha256:${'a'.repeat(43)}`, createdAt: EPOCH, expiresAt: EPOCH + 600_000,
      locatorVersion: 'CSSSelectorV1+StructuralSignatureV1', targets: { 'occ-1': { documentId: 'document-a',
        frameId: 0, backendNodeId: 1, evidenceId: 'ev-1', selector: { syntax: 'CSSSelectorV1', value: 'button', byteLength: 6, complexity: 1 },
        structuralSignature: { version: 'StructuralSignatureV1', sha256: 'b'.repeat(64) }, rectBucket: null } } }));
    const owner = await bindingStore.beginOverlay({ version: 1, auditId: AUDIT, occurrenceId: 'occ-1',
      tabId: 7, windowId: 3, topDocumentId: 'document-a', documentId: 'document-a', frameId: 0,
      nonce: 'R'.repeat(22), createdAt: EPOCH, expiresAt: EPOCH + 600_000, state: 'installing', revision: 1 });
    assert.equal(owner.ok, true);
    const controller = createHighlightController({ bindingStore, targetQueue: createTargetOperationQueue(),
      chromeApi: { runtime: { id: 'extension-test' }, tabs: { async get() { return { id: 7, status: 'complete', discarded: false }; } } },
      chromeAdapter: { async injectHighlight(input) { return acknowledge
        ? { ok: true, nonce: input.command.nonce, documentId: input.documentId, frameId: 0 } : { ok: false }; } },
      sessionAuthority: { async authorizeSession() { throw new Error('Unused'); } },
      modelAuthority: { async loadValidated() { throw new Error('Unused'); } },
      liveVerifier: { async verify() { throw new Error('Unused'); } }, now: () => EPOCH,
      randomBytes: length => new Uint8Array(length).fill(1) });
    env.options.highlightController = controller; env.options.highlightBindingStore = bindingStore;
    const coordinator = env.create(); assert.equal((await coordinator.request(request())).status, 'pending');
    assert.equal((await bindingStore.getActiveOverlay(7)).state, 'clearing');
    assert.notEqual(await bindingStore.findTarget({ auditId: AUDIT, occurrenceId: 'occ-1' }), null);
    acknowledge = true; await coordinator.resumePending({ limit: 25 });
    assert.equal(await bindingStore.getActiveOverlay(7), null);
    assert.equal(await bindingStore.findTarget({ auditId: AUDIT, occurrenceId: 'occ-1' }), null);
    assert.equal(env.tombstones.size, 0);
  });
});

test('R3-A resume validates scans, retries independently and serializes same-store audit lifecycles', async t => {
  for (const input of [null, {}, { limit: 0 }, { limit: 26 }, { limit: 1.5 }, { limit: '1' }, { limit: 1, extra: true }]) {
    await t.test(`invalid resume ${JSON.stringify(input)}`, async () => {
      const env = fixture(); await assert.rejects(env.create().resumePending(input), unavailable);
      assert.deepEqual(env.calls, []);
    });
  }
  for (const list of [null, {}, [tombstone(), {}], [tombstone(), tombstone()], new Array(1),
    Object.assign([tombstone()], { extra: true }), [tombstone(), tombstone(FOREIGN)]]) {
    await t.test(`invalid scan ${String(list)}`, async () => {
      const env = fixture(); env.handlers.list = () => list;
      await assert.rejects(env.create().resumePending({ limit: 1 }), unavailable);
      assert.deepEqual(env.calls, [['list', { limit: 1 }]]);
    });
  }
  await t.test('list exception is sanitized before cleanup', async () => {
    const env = fixture(); env.handlers.list = () => { throw new Error(SECRET); };
    await assert.rejects(env.create().resumePending({ limit: 25 }), unavailable);
    assert.deepEqual(env.calls, [['list', { limit: 25 }]]);
  });
  await t.test('first failed audit does not block next; restart retries from authority without restaging', async () => {
    const env = fixture(); env.tombstones.set(AUDIT, tombstone()); env.tombstones.set(FOREIGN, tombstone(FOREIGN));
    env.handlers.authority = id => id === AUDIT ? false : { ok: true, invalidated: 0 };
    assert.equal(await env.create().resumePending({ limit: 25 }), undefined);
    assert.equal(env.tombstones.get(AUDIT).attempts, 1); assert.equal(env.tombstones.has(FOREIGN), false);
    assert.equal(env.calls.filter(row => row[0] === 'now').length, 2);
    assert.equal(env.calls.some(row => row[0] === 'stage'), false);
    delete env.handlers.authority; env.calls.length = 0;
    await env.create().resumePending({ limit: 1 });
    assert.deepEqual(env.calls.map(row => row[0]), ['list', 'now', ...CLEANERS, 'pixel', 'owned-purge', 'authority-final', 'complete']);
  });
  await t.test('unconfirmed failure journal rejects only after later audit progresses', async () => {
    const env = fixture(); env.tombstones.set(AUDIT, tombstone()); env.tombstones.set(FOREIGN, tombstone(FOREIGN));
    env.handlers.authority = id => id === AUDIT ? false : { ok: true, invalidated: 0 };
    env.handlers.failure = () => false;
    await assert.rejects(env.create().resumePending({ limit: 25 }), unavailable);
    assert.equal(env.tombstones.has(FOREIGN), false); assert.equal(env.tombstones.has(AUDIT), true);
  });
  await t.test('different audits progress while same-store same-audit requests wait', async () => {
    const env = fixture(); const gate = deferred(); const started = deferred();
    env.handlers.authority = async id => { if (id === AUDIT) { started.resolve(); await gate.promise; } return { ok: true, invalidated: 0 }; };
    const first = env.create().request(request()); await started.promise;
    const second = env.create().request(request());
    assert.equal((await env.create().request(request(FOREIGN))).status, 'complete');
    assert.equal(env.calls.filter(row => row[0] === 'stage' && row[1].auditId === AUDIT).length, 1);
    gate.resolve(); assert.equal((await first).status, 'complete');
    const secondResult = await second; assert.ok(['complete', 'denied'].includes(secondResult.status));
    assert.equal(env.calls.filter(row => row[0] === 'complete' && row[1].auditId === AUDIT).length, 1);
  });
  await t.test('stale scan cannot clean or complete after another factory completed that tombstone', async () => {
    const env = fixture(); env.tombstones.set(AUDIT, tombstone()); const gate = deferred(); const started = deferred();
    env.handlers.list = async () => { const snapshot = [copy(env.tombstones.get(AUDIT))]; started.resolve(); await gate.promise; return snapshot; };
    const resuming = env.create().resumePending({ limit: 25 }); await started.promise;
    assert.equal((await env.create().request(request())).status, 'complete'); gate.resolve();
    assert.equal(await resuming, undefined);
    assert.equal(env.calls.filter(row => row[0] === 'authority').length, 1);
    assert.equal(env.calls.filter(row => row[0] === 'complete').length, 1);
  });
});

test('R3-A final purge follows resource cleanup and is required before tombstone completion', async t => {
  for (const step of ['owned-purge', 'authority-final']) for (const bad of [false, null, 'throw']) {
    await t.test(`${step} rejects ${String(bad)} and retries`, async () => {
      const env = fixture();
      env.handlers[step] = () => { if (bad === 'throw') throw new Error(SECRET); return bad; };
      const coordinator = env.create();
      assert.equal((await coordinator.request(request())).status, 'pending');
      assert.ok(env.calls.findIndex(row => row[0] === step) > env.calls.findIndex(row => row[0] === 'owned'));
      assert.equal(env.calls.some(row => row[0] === 'complete'), false);
      assert.equal(env.tombstones.get(AUDIT).attempts, 1);
      delete env.handlers[step];
      await coordinator.resumePending({ limit: 25 });
      assert.equal(env.tombstones.size, 0);
    });
  }
  for (const bad of [false, undefined, 'throw']) await t.test(`pixel finish ${String(bad)}`, async () => {
    const env = fixture(); const real = await pixelFixture();
    env.options.pixelCaptureState = { ...real.pixel, finish: async () => {
      if (bad === 'throw') throw new Error(SECRET); return bad;
    } };
    assert.equal((await env.create().request(request())).status, 'pending');
    assert.equal(env.calls.some(row => row[0] === 'owned-purge' || row[0] === 'complete'), false);
    assert.equal(env.tombstones.get(AUDIT).attempts, 1);
  });
  await t.test('a different suspension appearing during resource cleanup is not finished', async () => {
    const env = fixture(); const real = await pixelFixture(); let reads = 0; let finishes = 0;
    env.options.pixelCaptureState = { ...real.pixel,
      async readSuspension(id) { const value = await real.pixel.readSuspension(id); reads++;
        return reads === 1 ? value : { ...value, consentId: 'AgICAgICAgICAgICAgICAg' }; },
      async finish() { finishes++; return true; },
    };
    assert.equal((await env.create().request(request())).status, 'pending');
    assert.equal(finishes, 0); assert.equal(env.calls.some(row => row[0] === 'complete'), false);
  });
});

test('R3-A canonical audit cleanup composes real 160-character services with R1 and Blob ownership', async t => {
  const { createRawNavigationVaultV1 } = await import('../../src/background/raw-navigation-vault.js');
  const { createOwnedTabRegistry } = await import('../../src/background/owned-tabs.js');
  const { createReportLaunchAuthority } = await import('../../src/background/report-launch.js');
  const { createExportLaunchAuthority } = await import('../../src/background/export-launch.js');
  const { createBlobUrlRegistryV1 } = await import('../../src/background/blob-url-registry.js');
  const cleaners = ['rawNavigationVault', 'pixelCaptureState', 'exportLaunch', 'reportLaunch', 'ownedDisposableTabStore'];
  const blobUrl = 'blob:chrome-extension://' + 'a'.repeat(32) + '/11111111-1111-4111-8111-111111111111';
  const unusedNative = async () => { throw new Error('No native resource exists in this cleanup fixture'); };
  for (const selected of [...cleaners, 'all']) for (const length of [160, 161, 200]) {
    await t.test(`${selected} canonical length ${length}`, async subtest => {
      const auditId = 'a'.repeat(length); const area = sessionArea(); const env = fixture();
      const values = new Map([[auditId, { timestamps: { endedAt: '2026-08-01T00:00:00.000Z' } }]]);
      const store = createInMemoryAuditStore(values);
      const chromeApi = { runtime: { id: 'extension-test', getURL: path => `chrome-extension://extension-test/${path}`,
        getContexts: unusedNative }, tabs: { create: unusedNative, update: unusedNative, get: unusedNative, remove: unusedNative } };
      const randomBytes = size => new Uint8Array(size).fill(1);
      const reportLaunch = createReportLaunchAuthority({ chromeApi, sessionArea: area, epochNow: () => EPOCH, randomBytes });
      const real = {
        rawNavigationVault: createRawNavigationVaultV1({ sessionArea: area, now: () => EPOCH, randomBytes }),
        pixelCaptureState: createPixelCaptureStateV1({ sessionArea: area, now: () => EPOCH, randomBytes }),
        exportLaunch: createExportLaunchAuthority({ chromeApi, sessionArea: area, auditStore: store, reportLaunch,
          epochNow: () => EPOCH, modelNow: () => NOW, randomBytes }),
        reportLaunch,
        ownedDisposableTabStore: createOwnedTabRegistry({
          sessionArea: area,
          // Reatestação viva da limpeza (achado D1 da 1.1.37): a aba viva responde pela janela registrada.
          chromeAdapter: { removeTab: unusedNative, getTab: async tabId => ({ id: tabId, windowId: 1 }) },
          now: () => NOW,
        }),
      };
      const blobRegistry = createBlobUrlRegistryV1({ sessionArea: area, isOwnerAlive: async () => false, revokeInOwner: unusedNative });
      await blobRegistry.register({ auditId, blobUrl, ownerDocumentId: 'owner-document' });
      env.options.store = store; env.options.blobRegistry = blobRegistry;
      for (const name of selected === 'all' ? cleaners : [selected]) env.options[name] = real[name];
      const result = await env.create().request(request(auditId));
      assert.equal(values.has(auditId), false, 'R1 already staged and made the canonical model unavailable');
      const tombstones = await store.listDeletionTombstonesV1({ limit: 25 });
      const liveBlobs = Object.keys(area.values).filter(key => key.startsWith('audita:blob-url:v1:')).length;
      subtest.diagnostic(`status=${result.status}; durableTombstones=${tombstones.length}; blobRecords=${liveBlobs}`);
      assert.deepEqual(result, { status: 'complete', auditId }, 'confirmed absence in real cleaners must cover the canonical audit domain');
      assert.equal(tombstones.length, 0); assert.equal(liveBlobs, 0);
      if (selected !== 'all' && length === 160) {
        const clear = id => real[selected][selected === 'pixelCaptureState' ? 'readSuspension' : 'clearAudit'](id);
        const deniesWithFalse = selected === 'exportLaunch' || selected === 'reportLaunch';
        for (const invalidId of ['a'.repeat(201), '__latest__']) {
          if (deniesWithFalse) assert.equal(await clear(invalidId), false);
          else await assert.rejects(clear(invalidId));
        }
        const beyondCreation = 'a'.repeat(161);
        if (selected === 'rawNavigationVault') {
          const vault = createRawNavigationVaultV1({ sessionArea: area, now: () => EPOCH, randomBytes,
            digestManager: { async digest() { return `hmac-sha256:${'a'.repeat(43)}`; } } });
          const creation = id => vault.put('https://example.test/', { auditId: id, purpose: 'single-url', ttlMs: 600_000, includeQuery: false });
          assert.ok((await creation(auditId)).navigationToken);
          await assert.rejects(creation(beyondCreation), /RAW_NAVIGATION_INVALID/u);
        } else if (selected === 'pixelCaptureState') {
          const creation = id => real.pixelCaptureState.pause({ auditId: id,
            observedTarget: { version: 'ObservedTargetV1', kind: 'attached', tabId: 7, windowId: 3,
              documentId: 'document-a', urlEvidence: sanitizeEvidenceUrlV1('https://example.test/'),
              urlSessionDigest: `hmac-sha256:${'a'.repeat(43)}` }, mode: 'full-evidence',
            capturePolicy: createCapturePolicyV1({ mode: 'full-evidence', includeQuery: false }),
            categories: ['password'], authorityExpiresAt: EPOCH + 600_000 });
          assert.equal((await creation(auditId)).state, 'paused');
          await assert.rejects(creation(beyondCreation), /PIXEL_STATE_UNAVAILABLE/u);
        } else if (selected === 'ownedDisposableTabStore') {
          const creation = id => real.ownedDisposableTabStore.registerCreated({ ownershipId: `owner-${id.length}`,
            auditId: id, purpose: 'audit', tabId: 7, windowId: 3, cleanupMode: 'always' });
          assert.equal((await creation(auditId)).state, 'created');
          await assert.rejects(creation(beyondCreation), /OWNERSHIP_DENIED/u);
        } else if (selected === 'reportLaunch') {
          let creates = 0;
          chromeApi.tabs.create = async () => { creates++; return unusedNative(); };
          await assert.rejects(real.reportLaunch.openRegisteredReport({ auditId, windowId: 3 }));
          assert.equal(creates, 1);
          await assert.rejects(real.reportLaunch.openRegisteredReport({ auditId: beyondCreation, windowId: 3 }));
          assert.equal(creates, 1, 'the 161-character request must not allocate a report tab');
        } else {
          const creation = id => real.exportLaunch.requestExport({ auditId: id, sessionCapabilityId: 'R'.repeat(22), sender: {} });
          assert.deepEqual(await creation(auditId), { ok: false, code: 'CONTEXT_DENIED' });
          assert.deepEqual(await creation(beyondCreation), { ok: false, code: 'REPORT_EXPORT_DENIED' });
        }
        area.get = async () => { throw new Error(SECRET); };
        if (deniesWithFalse) assert.equal(await clear('a'.repeat(200)), false);
        else await assert.rejects(clear('a'.repeat(200)));
      }
    });
  }
});
