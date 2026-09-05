import assert from 'node:assert/strict';
import test from 'node:test';
import { SAMPLE_AUDIT } from '../../fixtures/audits/sample-audit.js';
import { createInMemoryAuditStore } from '../../src/storage/audit-store.js';
import { createAuditDeletionCoordinatorV1 } from '../../src/background/audit-deletion-coordinator.js';

const moduleUrl = new URL('../../src/background/retention-scheduler.js', import.meta.url);
const schedulerModule = await import(moduleUrl.href).catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND' && error.url === moduleUrl.href) return {};
  throw error;
});
const NOW = '2026-09-05T14:00:00.000Z';
const EPOCH = Date.parse(NOW);
const ALARM = 'audita-retention-cleanup-v1';
const SECRET = 'PRIVATE_SCHEDULER_FAILURE';
const tombstone = () => ({ version: 1, auditId: 'pending-audit', reason: 'retention-expired', requestedAt: NOW,
  phase: 'transient-cleanup-pending', attempts: 0, lastAttemptAt: null });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const unavailable = error => {
  assert.equal(error.constructor, Error);
  assert.equal(error.message, 'RETENTION_SCHEDULER_UNAVAILABLE');
  assert.equal(error.cause, undefined);
  assert.equal(JSON.stringify(error).includes(SECRET), false);
  return true;
};
function create(chromeApi, dependencies) {
  assert.equal(typeof schedulerModule.registerRetentionSchedulerV1, 'function', 'scheduler factory is missing');
  return schedulerModule.registerRetentionSchedulerV1(chromeApi, dependencies);
}
function event() {
  const listeners = new Set();
  return {
    listeners,
    addListener(listener) { listeners.add(listener); },
    removeListener(listener) { listeners.delete(listener); },
    emit(value) { for (const listener of [...listeners]) listener(value); },
  };
}
function fixture() {
  const trace = [];
  const handlers = {};
  const alarms = new Map([['foreign-alarm', { when: 123 }]]);
  const state = { next: null, pending: [], clock: NOW, clockReads: 0 };
  const call = (name, operation) => async (...args) => {
    trace.push([name, ...structuredClone(args)]);
    return Object.hasOwn(handlers, name) ? handlers[name](...args) : operation(...args);
  };
  const chromeApi = {
    runtime: { onStartup: event() },
    alarms: {
      onAlarm: event(),
      create: call('create', (name, info) => { alarms.set(name, info); }),
      clear: call('clear', name => alarms.delete(name)),
    },
  };
  const dependencies = {
    store: {
      stageExpiredAuditDeletionsV1: call('stage', () => []),
      nextExpiresAtV1: call('next', () => state.next),
      listDeletionTombstonesV1: call('list', () => state.pending),
    },
    deletionCoordinator: { resumePending: call('resume', () => undefined) },
    now() { state.clockReads += 1; return state.clock; },
  };
  return { trace, handlers, alarms, state, chromeApi, dependencies, register: () => create(chromeApi, dependencies) };
}

test('retention scheduler preserves absolute expiry and clears only confirmed empty state', async t => {
  for (const [name, next, pending, expected] of [
    ['future', '2026-09-05T15:00:00.000Z', [], { when: EPOCH + 3_600_000 }],
    ['expired', '2026-09-05T13:00:00.000Z', [], { when: EPOCH }],
    ['empty', null, [], undefined],
    ['pending only', null, [tombstone()], { when: EPOCH + 60_000 }],
    ['expiry before retry', '2026-09-05T14:00:20.000Z', [tombstone()], { when: EPOCH + 20_000 }],
    ['retry before expiry', '2026-09-05T15:00:00.000Z', [tombstone()], { when: EPOCH + 60_000 }],
  ]) await t.test(name, async () => {
    const f = fixture();
    f.state.next = next;
    f.state.pending = pending;
    const scheduler = f.register();
    assert.equal(Object.isFrozen(scheduler), true);
    assert.deepEqual(f.trace, [], 'registration must not run bootstrap');
    assert.equal(await scheduler.scheduleNext(), undefined);
    assert.deepEqual(f.alarms.get(ALARM), expected);
    assert.deepEqual(f.alarms.get('foreign-alarm'), { when: 123 });
    assert.deepEqual(f.trace.slice(0, 2), [['next'], ['list', { limit: 1 }]]);
    assert.equal(f.state.clockReads, 1);
    scheduler.dispose();
  });
});

test('retention scheduler gives remaining and failed real tombstones another one-shot trigger', async t => {
  for (const failCleaner of [false, true]) await t.test(failCleaner ? 'pending cleanup' : 'more than 25', async () => {
    const store = createInMemoryAuditStore();
    for (let index = 0; index < (failCleaner ? 1 : 26); index += 1) {
      const auditId = `scheduler-${String(index).padStart(2, '0')}`;
      const model = structuredClone(SAMPLE_AUDIT);
      model.auditId = auditId;
      await store.commitAudit(auditId, model, { auditId }, { now: '2026-08-01T00:00:00.000Z' });
    }
    await store.stageExpiredAuditDeletionsV1({ now: NOW, limit: 25 });
    await store.stageExpiredAuditDeletionsV1({ now: NOW, limit: 25 });
    assert.equal(await store.nextExpiresAtV1(), null);
    let failing = failCleaner;
    const coordinator = createAuditDeletionCoordinatorV1({
      store, now: () => NOW,
      authority: {
        async clearAudit() { return { ok: true, invalidated: 0 }; },
        async finalizeAudit() { return { ok: true, purged: 0 }; },
      },
      panelPortRegistry: { async clearAudit() { return true; } },
      reportPortRegistry: { async clearAudit() { return 0; } },
      highlightController: { async clearAudit() { return { ok: true, state: 'clear' }; } },
      highlightBindingStore: { async deleteAudit() { return false; } },
      rawNavigationVault: { async clearAudit() { return 0; } },
      pixelCaptureState: {
        async readSuspension() { return null; },
        async revokeAudit() { throw new Error('unexpected'); },
        async finish() { return true; },
      },
      blobRegistry: { async clearAudit() { if (failing) throw new Error(SECRET); return 0; } },
      exportLaunch: { async clearAudit() { return true; } },
      reportLaunch: { async clearAudit() { return true; } },
      ownedDisposableTabStore: { async clearAudit() { return 0; }, async purgeRemovedAudit() { return 0; } },
    });
    const f = fixture();
    const scheduler = create(f.chromeApi, { store, deletionCoordinator: coordinator, now: () => NOW });
    assert.equal(await scheduler.run('startup'), undefined);
    const remaining = await store.listDeletionTombstonesV1({ limit: 25 });
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].attempts, failCleaner ? 1 : 0);
    assert.deepEqual(f.alarms.get(ALARM), { when: EPOCH + 60_000 });
    failing = false;
    await scheduler.run('alarm');
    assert.deepEqual(await store.listDeletionTombstonesV1({ limit: 25 }), []);
    assert.equal(f.alarms.has(ALARM), false);
    scheduler.dispose();
  });
});

test('retention scheduler rearms after partial failures and never treats malformed results as absence', async t => {
  for (const boundary of ['stage', 'resume', 'next', 'list']) await t.test(boundary, async () => {
    const f = fixture();
    f.handlers[boundary] = () => { throw new Error(SECRET); };
    const scheduler = f.register();
    await assert.rejects(scheduler.run('startup'), unavailable);
    assert.deepEqual(f.trace.map(([name]) => name), ['stage', 'resume', 'next', 'list', 'create']);
    assert.deepEqual(f.trace[0], ['stage', { now: NOW, limit: 25 }]);
    assert.deepEqual(f.trace[1], ['resume', { limit: 25 }]);
    assert.deepEqual(f.alarms.get(ALARM), { when: EPOCH + 60_000 });
    delete f.handlers[boundary];
    await scheduler.run('alarm');
    assert.equal(f.alarms.has(ALARM), false);
    scheduler.dispose();
  });
  for (const [boundary, values] of [
    ['next', [undefined, NaN, 0, '', '2026-09-05', new Date(NOW), {}]],
    ['list', [undefined, null, {}, [undefined], new Array(1), [{}], [tombstone(), tombstone()], Object.assign([], { extra: true })]],
  ]) for (const [index, value] of values.entries()) await t.test(`${boundary} malformed ${index}`, async () => {
    const f = fixture();
    f.handlers[boundary] = () => value;
    const scheduler = f.register();
    await assert.rejects(scheduler.scheduleNext(), unavailable);
    assert.deepEqual(f.alarms.get(ALARM), { when: EPOCH + 60_000 });
    assert.equal(f.trace.some(([name]) => name === 'clear'), false);
    scheduler.dispose();
  });
  await t.test('known earlier expiry survives failed cleanup', async () => {
    const f = fixture();
    f.state.next = '2026-09-05T14:00:20.000Z';
    f.handlers.resume = () => { throw new Error(SECRET); };
    const scheduler = f.register();
    await assert.rejects(scheduler.run('alarm'), unavailable);
    assert.deepEqual(f.alarms.get(ALARM), { when: EPOCH + 20_000 });
    scheduler.dispose();
  });
  for (const boundary of ['create', 'clear']) await t.test(`alarm ${boundary} fails once`, async () => {
    const f = fixture();
    if (boundary === 'create') f.state.pending = [tombstone()];
    f.handlers[boundary] = () => { throw new Error(SECRET); };
    const scheduler = f.register();
    await assert.rejects(scheduler.run('alarm'), unavailable);
    assert.equal(f.trace.filter(([name]) => name === boundary).length, 1);
    scheduler.dispose();
  });
});

test('retention scheduler serializes events and public calls with one clock capture per operation', async () => {
  const f = fixture();
  const entered = deferred();
  const release = deferred();
  let first = true;
  f.handlers.stage = async () => {
    if (first) { first = false; entered.resolve(); await release.promise; }
    return [];
  };
  f.state.pending = [tombstone()];
  const scheduler = f.register();
  const initial = scheduler.run('panel');
  await entered.promise;
  f.chromeApi.runtime.onStartup.emit();
  f.chromeApi.alarms.onAlarm.emit({ name: ALARM });
  f.chromeApi.alarms.onAlarm.emit({ name: 'foreign-alarm' });
  const last = scheduler.scheduleNext();
  assert.deepEqual(f.trace, [['stage', { now: NOW, limit: 25 }]]);
  f.state.clock = '2026-09-05T14:10:00.000Z';
  release.resolve();
  await initial;
  await last;
  assert.deepEqual(f.trace.map(([name]) => name), [
    'stage', 'resume', 'next', 'list', 'create',
    'stage', 'resume', 'next', 'list', 'create',
    'stage', 'resume', 'next', 'list', 'create',
    'next', 'list', 'create',
  ]);
  assert.equal(f.state.clockReads, 4);
  assert.deepEqual(f.trace.filter(([name]) => name === 'create')[0], ['create', ALARM, { when: EPOCH + 60_000 }]);
  assert.deepEqual(f.alarms.get(ALARM), { when: EPOCH + 660_000 });
  scheduler.dispose();
});

test('retention scheduler disposal and invalid clocks cannot mutate alarms or foreign listeners', async t => {
  for (const clock of [undefined, null, 0, NaN, '', '2026-09-05', new Date(NOW), () => { throw new Error(SECRET); }]) {
    await t.test(`invalid clock ${typeof clock}`, async () => {
      const f = fixture();
      f.dependencies.now = typeof clock === 'function' ? clock : () => clock;
      const scheduler = f.register();
      await assert.rejects(scheduler.run('startup'), unavailable);
      await assert.rejects(scheduler.scheduleNext(), unavailable);
      assert.deepEqual(f.trace, []);
      scheduler.dispose();
    });
  }
  for (const boundary of ['stage', 'next']) await t.test(`dispose while ${boundary} awaits`, async () => {
    const f = fixture();
    const entered = deferred();
    const release = deferred();
    f.handlers[boundary] = async () => { entered.resolve(); return release.promise; };
    const foreign = () => {};
    f.chromeApi.runtime.onStartup.addListener(foreign);
    f.chromeApi.alarms.onAlarm.addListener(foreign);
    const scheduler = f.register();
    const active = boundary === 'stage' ? scheduler.run('startup') : scheduler.scheduleNext();
    const activeRejection = assert.rejects(active, unavailable);
    await entered.promise;
    const queuedRejection = assert.rejects(scheduler.run('alarm'), unavailable);
    scheduler.dispose();
    scheduler.dispose();
    release.resolve(boundary === 'stage' ? [] : NOW);
    await Promise.all([activeRejection, queuedRejection]);
    assert.deepEqual(f.trace.map(([name]) => name), [boundary]);
    assert.deepEqual([...f.chromeApi.runtime.onStartup.listeners], [foreign]);
    assert.deepEqual([...f.chromeApi.alarms.onAlarm.listeners], [foreign]);
    await assert.rejects(scheduler.scheduleNext(), unavailable);
    assert.deepEqual(f.alarms.get('foreign-alarm'), { when: 123 });
  });
  await t.test('listeners consume rejected runs without leaking native failure', async () => {
    const f = fixture();
    f.handlers.stage = () => { throw new Error(SECRET); };
    const scheduler = f.register();
    f.chromeApi.runtime.onStartup.emit();
    f.chromeApi.alarms.onAlarm.emit({ name: ALARM });
    await scheduler.scheduleNext();
    assert.equal(f.trace.filter(([name]) => name === 'stage').length, 2);
    scheduler.dispose();
  });
  await t.test('invalid dependencies register no listeners', () => {
    const f = fixture();
    delete f.dependencies.store.listDeletionTombstonesV1;
    assert.throws(() => f.register(), unavailable);
    assert.equal(f.chromeApi.runtime.onStartup.listeners.size, 0);
    assert.equal(f.chromeApi.alarms.onAlarm.listeners.size, 0);
  });
});
