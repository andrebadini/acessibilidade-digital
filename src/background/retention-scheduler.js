import { canonicalRetentionInstant, validateDeletionTombstoneV1 } from '../storage/audit-retention.js';

export const RETENTION_ALARM_NAME = 'audita-retention-cleanup-v1';
const RETRY_MS = 60_000;

function unavailable() { return new Error('RETENTION_SCHEDULER_UNAVAILABLE'); }

function hasPendingTombstone(value) {
  if (!Array.isArray(value) || value.length > 1 || Reflect.ownKeys(value).length !== value.length + 1) throw unavailable();
  if (value.length === 0) return false;
  const item = Object.getOwnPropertyDescriptor(value, '0');
  if (!item || !Object.hasOwn(item, 'value')) throw unavailable();
  validateDeletionTombstoneV1(item.value);
  return true;
}

export function registerRetentionSchedulerV1(chromeApi, options) {
  let calls; let startup; let alarm; let now;
  try {
    const bind = (owner, method) => {
      if (typeof owner?.[method] !== 'function') throw unavailable();
      return owner[method].bind(owner);
    };
    now = options.now;
    if (typeof now !== 'function') throw unavailable();
    startup = chromeApi.runtime.onStartup;
    alarm = chromeApi.alarms.onAlarm;
    calls = {
      stage: bind(options.store, 'stageExpiredAuditDeletionsV1'),
      next: bind(options.store, 'nextExpiresAtV1'),
      list: bind(options.store, 'listDeletionTombstonesV1'),
      resume: bind(options.deletionCoordinator, 'resumePending'),
      create: bind(chromeApi.alarms, 'create'),
      clear: bind(chromeApi.alarms, 'clear'),
      addStartup: bind(startup, 'addListener'), removeStartup: bind(startup, 'removeListener'),
      addAlarm: bind(alarm, 'addListener'), removeAlarm: bind(alarm, 'removeListener'),
    };
  } catch { throw unavailable(); }

  let disposed = false;
  let tail = Promise.resolve();
  const assertActive = () => { if (disposed) throw unavailable(); };
  const serial = operation => {
    if (disposed) return Promise.reject(unavailable());
    const result = tail.then(() => { assertActive(); return operation(); });
    tail = result.catch(() => {});
    return result.catch(() => { throw unavailable(); });
  };

  async function rearm(at, failed = false) {
    let expiresAt = null;
    let pending = false;
    assertActive();
    try {
      const next = await calls.next();
      assertActive();
      if (next !== null) expiresAt = canonicalRetentionInstant(next).milliseconds;
    } catch { failed = true; }
    assertActive();
    try {
      const records = await calls.list({ limit: 1 });
      assertActive();
      pending = hasPendingTombstone(records);
    } catch { failed = true; }
    assertActive();

    // Only confirmed absence may clear the alarm. Failures and pending cleanup get a one-shot retry.
    let when = expiresAt;
    if (pending || failed) when = when === null ? at.milliseconds + RETRY_MS : Math.min(when, at.milliseconds + RETRY_MS);
    if (when === null) await calls.clear(RETENTION_ALARM_NAME);
    else await calls.create(RETENTION_ALARM_NAME, { when: Math.max(at.milliseconds, when) });
    assertActive();
    if (failed) throw unavailable();
  }

  function run(_trigger) {
    return serial(async () => {
      const at = canonicalRetentionInstant(now());
      let failed = false;
      try { await calls.stage({ now: at.iso, limit: 25 }); } catch { failed = true; }
      assertActive();
      try { await calls.resume({ limit: 25 }); } catch { failed = true; }
      assertActive();
      await rearm(at, failed);
    });
  }

  function scheduleNext() {
    return serial(() => rearm(canonicalRetentionInstant(now())));
  }

  const startupListener = () => { void run('startup').catch(() => {}); };
  const alarmListener = value => {
    if (value?.name === RETENTION_ALARM_NAME) void run('alarm').catch(() => {});
  };

  function dispose() {
    if (disposed) return;
    disposed = true;
    try { calls.removeStartup(startupListener); } catch { /* Local listener cleanup is best-effort. */ }
    try { calls.removeAlarm(alarmListener); } catch { /* A remaining listener can no longer enqueue work. */ }
  }

  try {
    calls.addStartup(startupListener);
    calls.addAlarm(alarmListener);
  } catch {
    dispose();
    throw unavailable();
  }
  return Object.freeze({ run, scheduleNext, dispose });
}
