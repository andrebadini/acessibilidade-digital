import assert from 'node:assert/strict';
import test from 'node:test';

import { createPixelCaptureStateV1 } from '../../src/background/pixel-capture-consent.js';
import {
  PIXEL_CONSENT_ALARM_NAME,
  createPixelConsentExpirySchedulerV1,
} from '../../src/background/pixel-consent-expiry.js';
import { createCapturePolicyV1 } from '../../src/core/privacy/capture-policy.js';
import { sanitizeEvidenceUrlV1 } from '../../src/core/privacy/evidence-url.js';

const NOW = 1_800_000_000_000;
const DIGEST = `hmac-sha256:${'b'.repeat(43)}`;

function memorySessionArea() {
  const values = {};
  return {
    values,
    async get(key) { return key === null ? structuredClone(values) : { [key]: structuredClone(values[key]) }; },
    async set(input) { Object.assign(values, structuredClone(input)); },
    async remove(key) { for (const item of Array.isArray(key) ? key : [key]) delete values[item]; },
  };
}

function fixture({ now = () => NOW } = {}) {
  const sessionArea = memorySessionArea();
  const randomBytes = length => new Uint8Array(length).fill(7);
  const pixelState = createPixelCaptureStateV1({ sessionArea, now, randomBytes });
  const calls = [];
  const alarms = new Map();
  const chromeApi = { alarms: {
    async create(name, options) { alarms.set(name, structuredClone(options)); },
    async get(name) { return alarms.has(name) ? { name, scheduledTime: alarms.get(name).when, futureField: true } : undefined; },
    async clear(name) { return alarms.delete(name); },
  } };
  const liquidator = { async liquidate(input) { calls.push(input); return true; } };
  return { sessionArea, pixelState, calls, alarms, chromeApi, liquidator };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function manualTimer() {
  let nextHandle = 1;
  const pending = new Map();
  return {
    adapter: {
      set(callback, delayMs) {
        const handle = nextHandle;
        nextHandle += 1;
        pending.set(handle, { callback, delayMs });
        return handle;
      },
      clear(handle) { pending.delete(handle); },
    },
    pending,
    fire(handle = pending.keys().next().value) {
      const entry = pending.get(handle);
      assert.ok(entry, 'expected a pending local timer');
      pending.delete(handle);
      entry.callback();
    },
  };
}

async function settleMicrotasks(turns = 100) {
  for (let index = 0; index < turns; index += 1) await Promise.resolve();
}

function pauseInput(auditId, expiresAt) {
  return {
    auditId,
    observedTarget: {
      version: 'ObservedTargetV1', kind: 'attached', tabId: 7, windowId: 3, documentId: `doc-${auditId}`,
      urlEvidence: sanitizeEvidenceUrlV1('https://example.test/visible?secret=1'),
      urlSessionDigest: DIGEST,
    },
    mode: 'full-evidence', capturePolicy: createCapturePolicyV1({ mode: 'full-evidence', includeQuery: false }),
    categories: ['password'], authorityExpiresAt: expiresAt,
  };
}

function recoveryCandidate({
  auditId,
  consentId = 'BwcHBwcHBwcHBwcHBwcHBw',
  revision = 2,
  state = 'revoked',
  revokeReason = 'AUDIT_CANCELLED',
  cleanupNotBefore = NOW,
  expiresAt = NOW + 1_000,
  tabId = 7,
  windowId = 3,
} = {}) {
  const terminal = state === 'revoked' || state === 'finished';
  return Object.freeze({
    version: 'AuditSuspensionV1',
    revision,
    auditId,
    consentId,
    tabId,
    windowId,
    documentId: `doc-${auditId}`,
    urlEvidence: sanitizeEvidenceUrlV1('https://example.test/visible?secret=1'),
    urlSessionDigest: DIGEST,
    mode: 'full-evidence',
    capturePolicy: createCapturePolicyV1({ mode: 'full-evidence', includeQuery: false }),
    categories: Object.freeze(['password']),
    issuedAt: NOW - 1_000,
    updatedAt: NOW,
    expiresAt,
    cleanupAttempts: 0,
    cleanupNotBefore: terminal ? cleanupNotBefore : null,
    state,
    resumePhase: state === 'resuming' ? 'consent-claimed' : null,
    revokeReason: state === 'revoked' ? revokeReason : null,
    source: Object.freeze({ kind: 'attached' }),
  });
}

test('revokes expired or interrupted resumes through one liquidator then removes the journal', async () => {
  let now = NOW;
  const fixtureValue = fixture({ now: () => now });
  const { pixelState } = fixtureValue;
  const expired = await pixelState.pause(pauseInput('audit-expired', NOW + 1));
  const resumed = await pixelState.pause(pauseInput('audit-resumed', NOW + 1000));
  await pixelState.claimAndBeginResume({
    auditId: 'audit-resumed', consentId: resumed.consentId, proof: { kind: 'attached', tabId: 7, windowId: 3, documentId: 'doc-audit-resumed', urlSessionDigest: DIGEST }, mode: 'full-evidence', categories: ['password'],
  });
  now += 2;
  const scheduler = createPixelConsentExpirySchedulerV1(fixtureValue.chromeApi, {
    pixelState, liquidator: fixtureValue.liquidator, now: () => now,
  });
  await scheduler.recoverOnStartup();
  assert.deepEqual(fixtureValue.calls.map(call => [call.auditId, call.reason]).sort(), [
    ['audit-expired', 'PIXEL_CONSENT_EXPIRED'], ['audit-resumed', 'PIXEL_RESUME_INTERRUPTED'],
  ]);
  assert.equal(await pixelState.readSuspension(expired.auditId), null);
  assert.equal(await pixelState.readSuspension(resumed.auditId), null);
});

test('does not liquidate again when a finished journal only needs its own removal retried', async () => {
  const fixtureValue = fixture();
  const paused = await fixtureValue.pixelState.pause(pauseInput('audit-finished', NOW + 1000));
  await fixtureValue.pixelState.claimAndBeginResume({
    auditId: 'audit-finished', consentId: paused.consentId, proof: { kind: 'attached', tabId: 7, windowId: 3, documentId: 'doc-audit-finished', urlSessionDigest: DIGEST }, mode: 'full-evidence', categories: ['password'],
  });
  await fixtureValue.pixelState.markSessionRunning({ auditId: 'audit-finished', consentId: paused.consentId });
  await fixtureValue.pixelState.gateRunnerStart({ auditId: 'audit-finished', consentId: paused.consentId, proof: { kind: 'attached', tabId: 7, windowId: 3, documentId: 'doc-audit-finished', urlSessionDigest: DIGEST }, categories: ['password'] });
  // A remove no-op leaves only terminal journal cleanup pending.
  const originalRemove = fixtureValue.sessionArea.remove;
  fixtureValue.sessionArea.remove = async () => {};
  await assert.rejects(fixtureValue.pixelState.finish({ auditId: 'audit-finished', consentId: paused.consentId }), /PIXEL_STATE_UNAVAILABLE/u);
  fixtureValue.sessionArea.remove = originalRemove;
  const scheduler = createPixelConsentExpirySchedulerV1(fixtureValue.chromeApi, {
    pixelState: fixtureValue.pixelState, liquidator: fixtureValue.liquidator, now: () => NOW,
  });
  await scheduler.run('panel');
  assert.equal(fixtureValue.calls.length, 0);
  assert.equal(await fixtureValue.pixelState.readSuspension('audit-finished'), null);
});

test('only defers the exact or immediate terminal revision after finish throws', async () => {
  const scenarios = [
    { kind: 'immediate-finish', revisionDelta: 1, state: 'finished', cleanupAttempts: 0, expected: [3] },
    { kind: 'concurrent-defer', revisionDelta: 1, state: 'revoked', cleanupAttempts: 1, expected: [] },
    { kind: 'distant-replacement', revisionDelta: 2, state: 'finished', cleanupAttempts: 0, expected: [] },
    { kind: 'foreign-snapshot', revisionDelta: 0, state: 'revoked', cleanupAttempts: 0, expected: [] },
  ];
  for (const scenario of scenarios) {
    const fixtureValue = fixture();
    const candidate = recoveryCandidate({ auditId: `audit-${scenario.kind}` });
    const latest = Object.freeze({
      ...recoveryCandidate({
        auditId: candidate.auditId,
        consentId: candidate.consentId,
        revision: candidate.revision + scenario.revisionDelta,
        state: scenario.state,
        revokeReason: scenario.state === 'revoked' ? candidate.revokeReason : null,
        cleanupNotBefore: scenario.cleanupAttempts === 0 ? NOW : NOW + 60_000,
      }),
      cleanupAttempts: scenario.cleanupAttempts,
      ...(scenario.kind === 'foreign-snapshot' ? {
        tabId: 8,
        windowId: 4,
        documentId: 'foreign-document',
        urlEvidence: sanitizeEvidenceUrlV1('https://foreign.example/private'),
        urlSessionDigest: `hmac-sha256:${'c'.repeat(43)}`,
        mode: 'element-only',
        capturePolicy: createCapturePolicyV1({ mode: 'element-only', includeQuery: false }),
        categories: Object.freeze(['otp']),
        issuedAt: NOW - 900,
      } : {}),
    });
    const deferredRevisions = [];
    const state = {
      async listRecoveryCandidates() {
        return Object.freeze({
          version: 'PixelRecoveryScanV1', candidates: Object.freeze([candidate]),
          unavailableAuditIds: Object.freeze([]), hasUnattributedUnavailable: false, blockingCount: 0,
        });
      },
      async revokeAudit() {
        return Object.freeze({ version: 'PixelRevokeResultV1', status: 'already-revoked', suspension: candidate });
      },
      async finish() { throw new Error('finish outcome requires read-back'); },
      async readSuspension() { return latest; },
      async deferCleanup({ expectedRevision }) {
        deferredRevisions.push(expectedRevision);
        return latest;
      },
      async nextExpiresAt() { return null; },
    };
    const scheduler = createPixelConsentExpirySchedulerV1(fixtureValue.chromeApi, {
      pixelState: state,
      liquidator: { async liquidate() { return true; } },
      now: () => NOW,
    });

    await scheduler.run('panel');
    assert.deepEqual(deferredRevisions, scenario.expected);
  }
});

test('schedules the nearest expiry with one alarm and retries revoked cleanup no sooner than sixty seconds', async () => {
  let now = NOW;
  const fixtureValue = fixture({ now: () => now });
  await fixtureValue.pixelState.pause(pauseInput('audit-near', NOW + 5000));
  const scheduler = createPixelConsentExpirySchedulerV1(fixtureValue.chromeApi, {
    pixelState: fixtureValue.pixelState,
    liquidator: { async liquidate() { return false; } }, now: () => now,
  });
  await scheduler.scheduleNext();
  assert.deepEqual(fixtureValue.alarms.get(PIXEL_CONSENT_ALARM_NAME), { when: NOW + 5000 });
  now = NOW + 6000;
  await scheduler.run('alarm');
  assert.equal(fixtureValue.alarms.get(PIXEL_CONSENT_ALARM_NAME).when >= now + 60_000, true);
  scheduler.dispose();
  scheduler.dispose();
});

test('times out a hung liquidator without adopting a newer cleanup revision or its late success', async () => {
  let now = NOW;
  const fixtureValue = fixture({ now: () => now });
  const paused = await fixtureValue.pixelState.pause(pauseInput('audit-timeout', NOW + 1));
  const later = await fixtureValue.pixelState.pause(pauseInput('audit-timeout-b', NOW + 1));
  now += 2;
  const late = deferred();
  const localTimer = manualTimer();
  let observedSignal;
  const scheduler = createPixelConsentExpirySchedulerV1(fixtureValue.chromeApi, {
    pixelState: fixtureValue.pixelState,
    liquidator: {
      liquidate(input) {
        if (input.auditId === paused.auditId) {
          observedSignal = input.signal;
          return late.promise;
        }
        return true;
      },
    },
    now: () => now,
    timer: localTimer.adapter,
  });

  const running = scheduler.run('alarm');
  await settleMicrotasks();
  assert.equal(localTimer.pending.size, 1);
  const [{ delayMs }] = localTimer.pending.values();
  assert.equal(delayMs, 5_000);
  assert.ok(observedSignal instanceof AbortSignal);
  assert.equal(observedSignal.aborted, false);

  const confirmedRevocation = await fixtureValue.pixelState.readSuspension(paused.auditId);
  assert.equal(confirmedRevocation.state, 'revoked');
  const concurrentlyDeferred = await fixtureValue.pixelState.deferCleanup({
    auditId: paused.auditId,
    consentId: paused.consentId,
    expectedRevision: confirmedRevocation.revision,
  });
  assert.equal(concurrentlyDeferred.cleanupAttempts, 1);

  localTimer.fire();
  await running;
  assert.equal(observedSignal.aborted, true);
  const deferredCleanup = await fixtureValue.pixelState.readSuspension(paused.auditId);
  assert.equal(deferredCleanup.state, 'revoked');
  assert.equal(deferredCleanup.cleanupAttempts, 1);
  assert.equal(await fixtureValue.pixelState.readSuspension(later.auditId), null);

  late.resolve(true);
  await settleMicrotasks();
  const afterLateSuccess = await fixtureValue.pixelState.readSuspension(paused.auditId);
  assert.equal(afterLateSuccess.state, 'revoked');
  assert.equal(afterLateSuccess.cleanupAttempts, 1);
});

test('drains more than twenty-five interrupted resumes during one startup recovery', async () => {
  const fixtureValue = fixture();
  const pauses = [];
  for (let index = 0; index < 26; index += 1) {
    const auditId = `audit-resume-${String(index).padStart(2, '0')}`;
    const paused = await fixtureValue.pixelState.pause(pauseInput(auditId, NOW + 1000));
    await fixtureValue.pixelState.claimAndBeginResume({
      auditId,
      consentId: paused.consentId,
      proof: { kind: 'attached', tabId: 7, windowId: 3, documentId: `doc-${auditId}`, urlSessionDigest: DIGEST },
      mode: 'full-evidence',
      categories: ['password'],
    });
    pauses.push(paused);
  }
  const scheduler = createPixelConsentExpirySchedulerV1(fixtureValue.chromeApi, {
    pixelState: fixtureValue.pixelState,
    liquidator: {
      async liquidate(input) {
        assert.ok(input.signal instanceof AbortSignal);
        fixtureValue.calls.push(input);
        return true;
      },
    },
    now: () => NOW,
  });

  await scheduler.recoverOnStartup();
  assert.equal(fixtureValue.calls.length, 26);
  for (const paused of pauses) assert.equal(await fixtureValue.pixelState.readSuspension(paused.auditId), null);
});

test('alarm and panel runs never revoke an active resuming candidate', async () => {
  for (const trigger of ['alarm', 'panel']) {
    const fixtureValue = fixture();
    const paused = await fixtureValue.pixelState.pause(pauseInput(`audit-live-${trigger}`, NOW + 1000));
    await fixtureValue.pixelState.claimAndBeginResume({
      auditId: paused.auditId,
      consentId: paused.consentId,
      proof: { kind: 'attached', tabId: 7, windowId: 3, documentId: `doc-${paused.auditId}`, urlSessionDigest: DIGEST },
      mode: 'full-evidence',
      categories: ['password'],
    });
    const realList = fixtureValue.pixelState.listRecoveryCandidates;
    let revokeCalls = 0;
    const guardedState = {
      ...fixtureValue.pixelState,
      async listRecoveryCandidates(request) {
        const scan = await realList({ ...request, includeResuming: true });
        return scan;
      },
      async revokeAudit(request) {
        revokeCalls += 1;
        return fixtureValue.pixelState.revokeAudit(request);
      },
    };
    const scheduler = createPixelConsentExpirySchedulerV1(fixtureValue.chromeApi, {
      pixelState: guardedState,
      liquidator: fixtureValue.liquidator,
      now: () => NOW,
    });

    await scheduler.run(trigger);
    const current = await fixtureValue.pixelState.readSuspension(paused.auditId);
    assert.equal(current.state, 'resuming');
    assert.equal(revokeCalls, 0);
    assert.equal(fixtureValue.calls.length, 0);
  }
});

test('a failed cleaner is deferred so the twenty-sixth due candidate is not starved', async () => {
  let now = NOW;
  const fixtureValue = fixture({ now: () => now });
  const pauses = [];
  for (let index = 0; index < 26; index += 1) {
    const auditId = `audit-cleanup-${String(index).padStart(2, '0')}`;
    pauses.push(await fixtureValue.pixelState.pause(pauseInput(auditId, NOW + 1)));
  }
  now += 2;
  let calls = 0;
  const scheduler = createPixelConsentExpirySchedulerV1(fixtureValue.chromeApi, {
    pixelState: fixtureValue.pixelState,
    liquidator: {
      async liquidate() {
        calls += 1;
        return calls === 26;
      },
    },
    now: () => now,
  });

  await scheduler.recoverOnStartup();
  assert.equal(calls, 26);
  for (let index = 0; index < 25; index += 1) {
    const current = await fixtureValue.pixelState.readSuspension(pauses[index].auditId);
    assert.equal(current.state, 'revoked');
    assert.equal(current.cleanupNotBefore >= now + 60_000, true);
  }
  assert.equal(await fixtureValue.pixelState.readSuspension(pauses[25].auditId), null);
});

test('shares one startup readiness promise across factories and never reclassifies a later live resume', async () => {
  const fixtureValue = fixture();
  const first = createPixelConsentExpirySchedulerV1(fixtureValue.chromeApi, {
    pixelState: fixtureValue.pixelState,
    liquidator: fixtureValue.liquidator,
    now: () => NOW,
  });
  const second = createPixelConsentExpirySchedulerV1(fixtureValue.chromeApi, {
    pixelState: fixtureValue.pixelState,
    liquidator: fixtureValue.liquidator,
    now: () => NOW,
  });

  const readiness = first.recoverOnStartup();
  assert.strictEqual(second.recoverOnStartup(), readiness);
  await readiness;

  const paused = await fixtureValue.pixelState.pause(pauseInput('audit-after-readiness', NOW + 1000));
  await fixtureValue.pixelState.claimAndBeginResume({
    auditId: paused.auditId,
    consentId: paused.consentId,
    proof: { kind: 'attached', tabId: 7, windowId: 3, documentId: `doc-${paused.auditId}`, urlSessionDigest: DIGEST },
    mode: 'full-evidence',
    categories: ['password'],
  });
  assert.strictEqual(second.recoverOnStartup(), readiness);
  await readiness;
  assert.equal((await fixtureValue.pixelState.readSuspension(paused.auditId)).state, 'resuming');
  assert.equal(fixtureValue.calls.length, 0);
});

test('clears a failed shared startup promise so a later call can retry', async () => {
  const fixtureValue = fixture();
  let fail = true;
  const state = {
    ...fixtureValue.pixelState,
    async listRecoveryCandidates(request) {
      if (fail) throw new Error('private storage failure');
      return fixtureValue.pixelState.listRecoveryCandidates(request);
    },
  };
  const first = createPixelConsentExpirySchedulerV1(fixtureValue.chromeApi, {
    pixelState: state,
    liquidator: fixtureValue.liquidator,
    now: () => NOW,
  });
  const failed = first.recoverOnStartup();
  await assert.rejects(failed, /private storage failure/u);
  fail = false;
  const retried = first.recoverOnStartup();
  assert.notStrictEqual(retried, failed);
  await retried;
});

test('a disposed factory denies queued work and repairs an in-flight alarm mutation', async () => {
  const fixtureValue = fixture();
  const blocked = deferred();
  let firstRead = true;
  const nearState = {
    async listRecoveryCandidates() { throw new Error('not used by scheduleNext'); },
    async nextExpiresAt() {
      if (firstRead) {
        firstRead = false;
        await blocked.promise;
      }
      return NOW + 5_000;
    },
  };
  let staleReads = 0;
  const staleState = {
    async listRecoveryCandidates() { throw new Error('not used by scheduleNext'); },
    async nextExpiresAt() {
      staleReads += 1;
      return NOW + 50_000;
    },
  };
  const current = createPixelConsentExpirySchedulerV1(fixtureValue.chromeApi, {
    pixelState: nearState,
    liquidator: fixtureValue.liquidator,
    now: () => NOW,
  });
  const stale = createPixelConsentExpirySchedulerV1(fixtureValue.chromeApi, {
    pixelState: staleState,
    liquidator: fixtureValue.liquidator,
    now: () => NOW,
  });

  const currentSchedule = current.scheduleNext();
  const staleSchedule = stale.scheduleNext();
  stale.dispose();
  blocked.resolve();
  await currentSchedule;
  await assert.rejects(staleSchedule, /PIXEL_STATE_UNAVAILABLE/u);
  assert.equal(staleReads, 0);
  assert.deepEqual(fixtureValue.alarms.get(PIXEL_CONSENT_ALARM_NAME), { when: NOW + 5_000 });

  for (const mutation of ['create', 'clear']) {
    const alarms = new Map([[PIXEL_CONSENT_ALARM_NAME, { when: NOW + 5_000 }]]);
    const enteredMutation = deferred();
    const releaseMutation = deferred();
    let targetCalls = 0;
    const chromeApi = { alarms: {
      async create(name, options) {
        if (mutation === 'create') {
          targetCalls += 1;
          if (targetCalls === 1) {
            enteredMutation.resolve();
            await releaseMutation.promise;
          }
        }
        alarms.set(name, structuredClone(options));
      },
      async get(name) {
        return alarms.has(name)
          ? { name, scheduledTime: alarms.get(name).when }
          : undefined;
      },
      async clear(name) {
        if (mutation === 'clear') {
          targetCalls += 1;
          if (targetCalls === 1) {
            enteredMutation.resolve();
            await releaseMutation.promise;
          }
        }
        return alarms.delete(name);
      },
    } };
    const state = {
      async listRecoveryCandidates() { throw new Error('disposed work must stay closed'); },
      async nextExpiresAt() { return mutation === 'create' ? NOW + 50_000 : null; },
    };
    const scheduler = createPixelConsentExpirySchedulerV1(chromeApi, {
      pixelState: state,
      liquidator: fixtureValue.liquidator,
      now: () => NOW,
    });

    const pendingMutation = scheduler.scheduleNext();
    await enteredMutation.promise;
    scheduler.dispose();
    await assert.rejects(scheduler.scheduleNext(), /PIXEL_STATE_UNAVAILABLE/u);
    await assert.rejects(scheduler.run('alarm'), /PIXEL_STATE_UNAVAILABLE/u);
    await assert.rejects(scheduler.recoverOnStartup(), /PIXEL_STATE_UNAVAILABLE/u);
    releaseMutation.resolve();
    await assert.rejects(pendingMutation, /PIXEL_STATE_UNAVAILABLE/u);
    assert.deepEqual(alarms.get(PIXEL_CONSENT_ALARM_NAME), { when: NOW + 5_000 });
  }
});

test('recalculates after create or clear when the journal deadline changes during the alarm await', async () => {
  for (const values of [
    [NOW + 50_000, NOW + 5_000, NOW + 5_000],
    [null, NOW + 5_000, NOW + 5_000],
  ]) {
    const fixtureValue = fixture();
    fixtureValue.alarms.set(PIXEL_CONSENT_ALARM_NAME, { when: NOW + 90_000 });
    let reads = 0;
    const state = {
      async listRecoveryCandidates() { throw new Error('not used by scheduleNext'); },
      async nextExpiresAt() {
        const value = values[Math.min(reads, values.length - 1)];
        reads += 1;
        return value;
      },
    };
    const scheduler = createPixelConsentExpirySchedulerV1(fixtureValue.chromeApi, {
      pixelState: state,
      liquidator: fixtureValue.liquidator,
      now: () => NOW,
    });

    await scheduler.scheduleNext();
    assert.equal(reads >= 3, true);
    assert.deepEqual(fixtureValue.alarms.get(PIXEL_CONSENT_ALARM_NAME), { when: NOW + 5_000 });
  }
});

test('processes valid candidates despite scoped malformed-record diagnostics', async () => {
  const fixtureValue = fixture();
  const candidate = recoveryCandidate({ auditId: 'audit-valid', revision: 3 });
  let finished = 0;
  const state = {
    async listRecoveryCandidates() {
      return Object.freeze({
        version: 'PixelRecoveryScanV1', candidates: Object.freeze([candidate]),
        unavailableAuditIds: Object.freeze(['audit-malformed']),
        hasUnattributedUnavailable: true, blockingCount: 0,
      });
    },
    async revokeAudit() {
      return Object.freeze({ version: 'PixelRevokeResultV1', status: 'already-revoked', suspension: candidate });
    },
    async finish() { finished += 1; return true; },
    async deferCleanup() { throw new Error('must not defer a successful cleanup'); },
    async readSuspension() { return null; },
    async nextExpiresAt() { return null; },
  };
  const scheduler = createPixelConsentExpirySchedulerV1(fixtureValue.chromeApi, {
    pixelState: state,
    liquidator: fixtureValue.liquidator,
    now: () => NOW,
  });

  await scheduler.run('panel');
  assert.equal(fixtureValue.calls.length, 1);
  assert.equal(finished, 1);
});

test('does not liquidate a stale listed pair when revoke reports mismatch', async () => {
  const fixtureValue = fixture();
  const candidate = recoveryCandidate({ auditId: 'audit-stale', state: 'paused', revokeReason: null, expiresAt: NOW - 1 });
  let finishCalls = 0;
  const state = {
    async listRecoveryCandidates() {
      return Object.freeze({ version: 'PixelRecoveryScanV1', candidates: Object.freeze([candidate]), unavailableAuditIds: Object.freeze([]), hasUnattributedUnavailable: false, blockingCount: 0 });
    },
    async revokeAudit() { return Object.freeze({ version: 'PixelRevokeResultV1', status: 'mismatch', suspension: null }); },
    async finish() { finishCalls += 1; return true; },
    async nextExpiresAt() { return null; },
  };
  const scheduler = createPixelConsentExpirySchedulerV1(fixtureValue.chromeApi, {
    pixelState: state,
    liquidator: fixtureValue.liquidator,
    now: () => NOW,
  });

  await scheduler.run('alarm');
  assert.equal(fixtureValue.calls.length, 0);
  assert.equal(finishCalls, 0);
});

test('continues with a later candidate when a failed cleaner cannot be deferred', async () => {
  const fixtureValue = fixture();
  const first = recoveryCandidate({ auditId: 'audit-cleaner-a' });
  const second = recoveryCandidate({ auditId: 'audit-cleaner-b', consentId: 'CAgICAgICAgICAgICAgICA', revokeReason: 'SESSION_ENDED' });
  const liquidated = [];
  const finished = [];
  const state = {
    async listRecoveryCandidates() {
      return Object.freeze({ version: 'PixelRecoveryScanV1', candidates: Object.freeze([first, second]), unavailableAuditIds: Object.freeze([]), hasUnattributedUnavailable: false, blockingCount: 0 });
    },
    async revokeAudit({ auditId }) {
      const suspension = auditId === first.auditId ? first : second;
      return Object.freeze({ version: 'PixelRevokeResultV1', status: 'already-revoked', suspension });
    },
    async readSuspension(auditId) { return auditId === first.auditId ? first : second; },
    async deferCleanup({ auditId }) {
      if (auditId === first.auditId) throw new Error('scoped write failure');
      return null;
    },
    async finish({ auditId }) { finished.push(auditId); return true; },
    async nextExpiresAt() { return null; },
  };
  const scheduler = createPixelConsentExpirySchedulerV1(fixtureValue.chromeApi, {
    pixelState: state,
    liquidator: {
      async liquidate({ auditId }) {
        liquidated.push(auditId);
        return auditId === second.auditId;
      },
    },
    now: () => NOW,
  });

  await scheduler.run('panel');
  assert.deepEqual(liquidated, [first.auditId, second.auditId]);
  assert.deepEqual(finished, [second.auditId]);
});

test('accepts commit-then-throw alarm mutations and rejects confirmed no-ops', async () => {
  const scenarios = [
    { next: NOW + 5_000, initial: null, method: 'create' },
    { next: null, initial: { when: NOW + 5_000 }, method: 'clear' },
  ];
  for (const scenario of scenarios) {
    for (const commit of [true, false]) {
      const alarms = new Map();
      if (scenario.initial) alarms.set(PIXEL_CONSENT_ALARM_NAME, scenario.initial);
      const chromeApi = { alarms: {
        async create(name, options) {
          if (scenario.method === 'create' && commit) alarms.set(name, structuredClone(options));
          throw new Error('native API rejected');
        },
        async clear(name) {
          if (scenario.method === 'clear' && commit) alarms.delete(name);
          throw new Error('native API rejected');
        },
        async get(name) {
          return alarms.has(name) ? { name, scheduledTime: alarms.get(name).when, futureChromeField: 1 } : undefined;
        },
      } };
      const state = {
        async listRecoveryCandidates() { throw new Error('not used by scheduleNext'); },
        async nextExpiresAt() { return scenario.next; },
      };
      const scheduler = createPixelConsentExpirySchedulerV1(chromeApi, {
        pixelState: state,
        liquidator: { async liquidate() { return true; } },
        now: () => NOW,
      });

      if (commit) await scheduler.scheduleNext();
      else await assert.rejects(scheduler.scheduleNext(), /PIXEL_STATE_UNAVAILABLE/u);
    }
  }
});

test('shares a monotonic scheduler clock across factories and rejects rollback before alarm mutation', async () => {
  const fixtureValue = fixture();
  const state = {
    async listRecoveryCandidates() { throw new Error('not used by scheduleNext'); },
    async nextExpiresAt() { return NOW + 100_000; },
  };
  const first = createPixelConsentExpirySchedulerV1(fixtureValue.chromeApi, {
    pixelState: state,
    liquidator: fixtureValue.liquidator,
    now: () => NOW + 500,
  });
  await first.scheduleNext();
  let createCalls = 0;
  const originalCreate = fixtureValue.chromeApi.alarms.create;
  fixtureValue.chromeApi.alarms.create = async (...args) => {
    createCalls += 1;
    return originalCreate(...args);
  };
  const rolledBack = createPixelConsentExpirySchedulerV1(fixtureValue.chromeApi, {
    pixelState: state,
    liquidator: fixtureValue.liquidator,
    now: () => NOW,
  });

  await assert.rejects(rolledBack.scheduleNext(), /PIXEL_STATE_UNAVAILABLE/u);
  assert.equal(createCalls, 0);
});

test('dispose aborts and clears a pending local liquidation timer without late effects', async () => {
  let now = NOW;
  const fixtureValue = fixture({ now: () => now });
  const paused = await fixtureValue.pixelState.pause(pauseInput('audit-dispose-timeout', NOW + 1));
  now += 2;
  const late = deferred();
  const localTimer = manualTimer();
  let observedSignal;
  const scheduler = createPixelConsentExpirySchedulerV1(fixtureValue.chromeApi, {
    pixelState: fixtureValue.pixelState,
    liquidator: {
      liquidate({ signal }) {
        observedSignal = signal;
        return late.promise;
      },
    },
    now: () => now,
    timer: localTimer.adapter,
  });
  const running = scheduler.run('alarm');
  await settleMicrotasks();
  assert.equal(localTimer.pending.size, 1);

  scheduler.dispose();
  assert.equal(observedSignal.aborted, true);
  assert.equal(localTimer.pending.size, 0);
  await assert.rejects(running, /PIXEL_STATE_UNAVAILABLE/u);
  const afterDispose = await fixtureValue.pixelState.readSuspension(paused.auditId);
  assert.equal(afterDispose.state, 'revoked');
  assert.equal(afterDispose.cleanupAttempts, 1);

  late.resolve(true);
  await settleMicrotasks();
  const afterLate = await fixtureValue.pixelState.readSuspension(paused.auditId);
  assert.equal(afterLate.state, 'revoked');
  assert.equal(afterLate.cleanupAttempts, 1);
});

test('serializes schedule, run, and startup recovery across factories sharing one alarms object', async () => {
  const fixtureValue = fixture();
  const gate = deferred();
  const events = [];
  let scheduleReads = 0;
  const schedulingState = {
    async listRecoveryCandidates() { throw new Error('not used'); },
    async nextExpiresAt() {
      scheduleReads += 1;
      if (scheduleReads === 1) {
        events.push('schedule-enter');
        await gate.promise;
        events.push('schedule-release');
      }
      return NOW + 5_000;
    },
  };
  const runningState = {
    async listRecoveryCandidates() {
      events.push('run-scan');
      return Object.freeze({ version: 'PixelRecoveryScanV1', candidates: Object.freeze([]), unavailableAuditIds: Object.freeze([]), hasUnattributedUnavailable: false, blockingCount: 0 });
    },
    async nextExpiresAt() { events.push('run-schedule'); return NOW + 5_000; },
  };
  const recoveryState = {
    async listRecoveryCandidates() {
      events.push('recovery-scan');
      return Object.freeze({ version: 'PixelRecoveryScanV1', candidates: Object.freeze([]), unavailableAuditIds: Object.freeze([]), hasUnattributedUnavailable: false, blockingCount: 0 });
    },
    async nextExpiresAt() { events.push('recovery-schedule'); return NOW + 5_000; },
  };
  const scheduler = createPixelConsentExpirySchedulerV1(fixtureValue.chromeApi, {
    pixelState: schedulingState, liquidator: fixtureValue.liquidator, now: () => NOW,
  });
  const runner = createPixelConsentExpirySchedulerV1(fixtureValue.chromeApi, {
    pixelState: runningState, liquidator: fixtureValue.liquidator, now: () => NOW,
  });
  const recovery = createPixelConsentExpirySchedulerV1(fixtureValue.chromeApi, {
    pixelState: recoveryState, liquidator: fixtureValue.liquidator, now: () => NOW,
  });

  const scheduled = scheduler.scheduleNext();
  const ran = runner.run('panel');
  const recovered = recovery.recoverOnStartup();
  await settleMicrotasks();
  assert.deepEqual(events, ['schedule-enter']);
  gate.resolve();
  await Promise.all([scheduled, ran, recovered]);
  assert.equal(events.indexOf('run-scan') > events.indexOf('schedule-release'), true);
  assert.equal(events.indexOf('recovery-scan') > events.indexOf('run-scan'), true);
});

test('never invokes extra native alarm getters and fails closed on a revoked alarm proxy', async () => {
  let extraReads = 0;
  const alarms = new Map();
  const chromeApi = { alarms: {
    async create(name, options) { alarms.set(name, structuredClone(options)); },
    async clear(name) { return alarms.delete(name); },
    async get(name) {
      if (!alarms.has(name)) return undefined;
      const value = { name, scheduledTime: alarms.get(name).when };
      Object.defineProperty(value, 'futureField', {
        enumerable: true,
        get() { extraReads += 1; throw new Error('must not read extra field'); },
      });
      return value;
    },
  } };
  const state = {
    async listRecoveryCandidates() { throw new Error('not used'); },
    async nextExpiresAt() { return NOW + 5_000; },
  };
  const scheduler = createPixelConsentExpirySchedulerV1(chromeApi, {
    pixelState: state, liquidator: { async liquidate() { return true; } }, now: () => NOW,
  });
  await scheduler.scheduleNext();
  assert.equal(extraReads, 0);

  const target = {};
  const revoked = Proxy.revocable(target, {});
  revoked.revoke();
  chromeApi.alarms.get = async () => revoked.proxy;
  await assert.rejects(scheduler.scheduleNext(), /PIXEL_STATE_UNAVAILABLE/u);
});

test('fails closed instead of looping forever when the deadline never stabilizes', async () => {
  const fixtureValue = fixture();
  let reads = 0;
  const state = {
    async listRecoveryCandidates() { throw new Error('not used'); },
    async nextExpiresAt() {
      reads += 1;
      if (reads > 40) throw new Error('unbounded deadline loop');
      return reads % 2 === 0 ? NOW + 5_000 : NOW + 10_000;
    },
  };
  const scheduler = createPixelConsentExpirySchedulerV1(fixtureValue.chromeApi, {
    pixelState: state, liquidator: fixtureValue.liquidator, now: () => NOW,
  });

  await assert.rejects(scheduler.scheduleNext(), /PIXEL_STATE_UNAVAILABLE/u);
  assert.equal(reads <= 30, true);
});

test('keeps scoped cleanup scheduled when another startup resume still blocks readiness', async () => {
  const fixtureValue = fixture();
  const blocked = recoveryCandidate({ auditId: 'audit-blocked', state: 'resuming', revokeReason: null });
  const cleanup = recoveryCandidate({ auditId: 'audit-cleanup-retry' });
  const retryAt = NOW + 60_000;
  let scanCalls = 0;
  let deferredCleanup = cleanup;
  const state = {
    async listRecoveryCandidates() {
      scanCalls += 1;
      return Object.freeze({
        version: 'PixelRecoveryScanV1',
        candidates: Object.freeze(scanCalls === 1 ? [blocked, cleanup] : [blocked]),
        unavailableAuditIds: Object.freeze([]),
        hasUnattributedUnavailable: false,
        blockingCount: 1,
      });
    },
    async revokeAudit({ auditId }) {
      if (auditId === blocked.auditId) return Object.freeze({ version: 'PixelRevokeResultV1', status: 'mismatch', suspension: null });
      return Object.freeze({ version: 'PixelRevokeResultV1', status: 'already-revoked', suspension: cleanup });
    },
    async readSuspension(auditId) { return auditId === cleanup.auditId ? deferredCleanup : blocked; },
    async deferCleanup() {
      deferredCleanup = recoveryCandidate({
        auditId: cleanup.auditId,
        consentId: cleanup.consentId,
        revision: cleanup.revision + 1,
        cleanupNotBefore: retryAt,
      });
      return deferredCleanup;
    },
    async finish() { throw new Error('cleanup was not confirmed'); },
    async nextExpiresAt() { return retryAt; },
  };
  const scheduler = createPixelConsentExpirySchedulerV1(fixtureValue.chromeApi, {
    pixelState: state,
    liquidator: { async liquidate() { return false; } },
    now: () => NOW,
  });

  await assert.rejects(scheduler.recoverOnStartup(), /PIXEL_RECOVERY_PENDING/u);
  assert.deepEqual(fixtureValue.alarms.get(PIXEL_CONSENT_ALARM_NAME), { when: retryAt });
});

test('rejects malformed recovery scans and candidates without invoking getters or opening readiness', async () => {
  for (const maliciousValue of ['scan', 'candidate', 'policy', 'blocking-count']) {
    const fixtureValue = fixture();
    let getterReads = 0;
    let valid = false;
    const goodEmptyScan = Object.freeze({
      version: 'PixelRecoveryScanV1', candidates: Object.freeze([]),
      unavailableAuditIds: Object.freeze([]), hasUnattributedUnavailable: false, blockingCount: 0,
    });
    let maliciousScan;
    if (maliciousValue === 'scan') {
      maliciousScan = {
        version: 'PixelRecoveryScanV1', unavailableAuditIds: Object.freeze([]),
        hasUnattributedUnavailable: false, blockingCount: 0,
      };
      Object.defineProperty(maliciousScan, 'candidates', {
        enumerable: true,
        get() { getterReads += 1; return []; },
      });
    } else if (maliciousValue === 'candidate') {
      const maliciousCandidate = { ...recoveryCandidate({ auditId: 'audit-getter', state: 'paused', revokeReason: null }) };
      Object.defineProperty(maliciousCandidate, 'state', {
        enumerable: true,
        get() { getterReads += 1; return 'paused'; },
      });
      maliciousScan = Object.freeze({
        version: 'PixelRecoveryScanV1', candidates: Object.freeze([maliciousCandidate]),
        unavailableAuditIds: Object.freeze([]), hasUnattributedUnavailable: false, blockingCount: 0,
      });
    } else if (maliciousValue === 'policy') {
      const maliciousCandidate = { ...recoveryCandidate({ auditId: 'audit-policy-getter', state: 'paused', revokeReason: null }) };
      const maliciousPolicy = { ...maliciousCandidate.capturePolicy };
      Object.defineProperty(maliciousPolicy, 'mode', {
        enumerable: true,
        get() { getterReads += 1; return 'full-evidence'; },
      });
      maliciousCandidate.capturePolicy = maliciousPolicy;
      maliciousScan = Object.freeze({
        version: 'PixelRecoveryScanV1', candidates: Object.freeze([Object.freeze(maliciousCandidate)]),
        unavailableAuditIds: Object.freeze([]), hasUnattributedUnavailable: false, blockingCount: 0,
      });
    } else {
      maliciousScan = Object.freeze({
        version: 'PixelRecoveryScanV1',
        candidates: Object.freeze([recoveryCandidate({ auditId: 'audit-unreported-resume', state: 'resuming', revokeReason: null })]),
        unavailableAuditIds: Object.freeze([]), hasUnattributedUnavailable: false, blockingCount: 0,
      });
    }
    const state = {
      async listRecoveryCandidates() { return valid ? goodEmptyScan : maliciousScan; },
      async nextExpiresAt() { return null; },
    };
    const scheduler = createPixelConsentExpirySchedulerV1(fixtureValue.chromeApi, {
      pixelState: state, liquidator: fixtureValue.liquidator, now: () => NOW,
    });

    await assert.rejects(scheduler.recoverOnStartup(), /PIXEL_STATE_UNAVAILABLE/u);
    assert.equal(getterReads, 0);
    valid = true;
    await scheduler.recoverOnStartup();
  }
});

test('uses a fresh post-await clock when a deadline becomes overdue while scheduling', async () => {
  let now = NOW;
  const fixtureValue = fixture({ now: () => now });
  let reads = 0;
  const state = {
    async listRecoveryCandidates() { throw new Error('not used'); },
    async nextExpiresAt() {
      reads += 1;
      if (reads === 1) now = NOW + 10_000;
      return NOW + 5_000;
    },
  };
  const scheduler = createPixelConsentExpirySchedulerV1(fixtureValue.chromeApi, {
    pixelState: state, liquidator: fixtureValue.liquidator, now: () => now,
  });

  await scheduler.scheduleNext();
  assert.equal(fixtureValue.alarms.get(PIXEL_CONSENT_ALARM_NAME).when >= now + 60_000, true);
});

test('does not start a liquidator after an injected timer fires synchronously', async () => {
  const fixtureValue = fixture();
  const candidate = recoveryCandidate({ auditId: 'audit-sync-timeout' });
  let liquidatorCalls = 0;
  let deferCalls = 0;
  let clearCalls = 0;
  const state = {
    async listRecoveryCandidates() {
      return Object.freeze({ version: 'PixelRecoveryScanV1', candidates: Object.freeze([candidate]), unavailableAuditIds: Object.freeze([]), hasUnattributedUnavailable: false, blockingCount: 0 });
    },
    async revokeAudit() { return Object.freeze({ version: 'PixelRevokeResultV1', status: 'already-revoked', suspension: candidate }); },
    async readSuspension() { return candidate; },
    async deferCleanup() { deferCalls += 1; return recoveryCandidate({ auditId: candidate.auditId, revision: 3, cleanupNotBefore: NOW + 60_000 }); },
    async nextExpiresAt() { return NOW + 60_000; },
  };
  const scheduler = createPixelConsentExpirySchedulerV1(fixtureValue.chromeApi, {
    pixelState: state,
    liquidator: { async liquidate() { liquidatorCalls += 1; return true; } },
    now: () => NOW,
    timer: {
      set(callback) { callback(); return 7; },
      clear(handle) { assert.equal(handle, 7); clearCalls += 1; },
    },
  });

  await scheduler.run('alarm');
  assert.equal(liquidatorCalls, 0);
  assert.equal(deferCalls, 1);
  assert.equal(clearCalls, 1);
});

test('rejects a future paused candidate before revoking its still-valid consent', async () => {
  const fixtureValue = fixture();
  const candidate = recoveryCandidate({
    auditId: 'audit-future-pause',
    state: 'paused',
    revokeReason: null,
    expiresAt: NOW + 60_000,
  });
  let revokeCalls = 0;
  const state = {
    async listRecoveryCandidates() {
      return Object.freeze({ version: 'PixelRecoveryScanV1', candidates: Object.freeze([candidate]), unavailableAuditIds: Object.freeze([]), hasUnattributedUnavailable: false, blockingCount: 0 });
    },
    async revokeAudit() { revokeCalls += 1; return Object.freeze({ version: 'PixelRevokeResultV1', status: 'mismatch', suspension: null }); },
    async nextExpiresAt() { return null; },
  };
  const scheduler = createPixelConsentExpirySchedulerV1(fixtureValue.chromeApi, {
    pixelState: state, liquidator: fixtureValue.liquidator, now: () => NOW,
  });

  await assert.rejects(scheduler.run('alarm'), /PIXEL_STATE_UNAVAILABLE/u);
  assert.equal(revokeCalls, 0);
  assert.equal(fixtureValue.calls.length, 0);
});

test('rejects duplicate candidates before a second copy can bypass newly deferred cleanup', async () => {
  const fixtureValue = fixture();
  const candidate = recoveryCandidate({ auditId: 'audit-duplicate-cleanup' });
  let current = candidate;
  let revokeCalls = 0;
  let liquidatorCalls = 0;
  const state = {
    async listRecoveryCandidates() {
      return Object.freeze({ version: 'PixelRecoveryScanV1', candidates: Object.freeze([candidate, candidate]), unavailableAuditIds: Object.freeze([]), hasUnattributedUnavailable: false, blockingCount: 0 });
    },
    async revokeAudit() {
      revokeCalls += 1;
      return Object.freeze({ version: 'PixelRevokeResultV1', status: 'already-revoked', suspension: current });
    },
    async readSuspension() { return current; },
    async deferCleanup() {
      current = recoveryCandidate({ auditId: candidate.auditId, revision: 3, cleanupNotBefore: NOW + 60_000 });
      return current;
    },
    async finish() { return true; },
    async nextExpiresAt() { return current.cleanupNotBefore; },
  };
  const scheduler = createPixelConsentExpirySchedulerV1(fixtureValue.chromeApi, {
    pixelState: state,
    liquidator: {
      async liquidate() {
        liquidatorCalls += 1;
        return liquidatorCalls > 1;
      },
    },
    now: () => NOW,
  });

  await assert.rejects(scheduler.run('panel'), /PIXEL_STATE_UNAVAILABLE/u);
  assert.equal(revokeCalls, 0);
  assert.equal(liquidatorCalls, 0);
});

test('accepts zero tab and window identifiers emitted by the canonical state', async () => {
  const fixtureValue = fixture();
  const candidate = recoveryCandidate({ auditId: 'audit-zero-ids', tabId: 0, windowId: 0 });
  let liquidatorCalls = 0;
  const state = {
    async listRecoveryCandidates() {
      return Object.freeze({ version: 'PixelRecoveryScanV1', candidates: Object.freeze([candidate]), unavailableAuditIds: Object.freeze([]), hasUnattributedUnavailable: false, blockingCount: 0 });
    },
    async revokeAudit() { return Object.freeze({ version: 'PixelRevokeResultV1', status: 'already-revoked', suspension: candidate }); },
    async finish() { return true; },
    async nextExpiresAt() { return null; },
  };
  const scheduler = createPixelConsentExpirySchedulerV1(fixtureValue.chromeApi, {
    pixelState: state,
    liquidator: { async liquidate() { liquidatorCalls += 1; return true; } },
    now: () => NOW,
  });

  await scheduler.run('alarm');
  assert.equal(liquidatorCalls, 1);
});

test('reads a dense candidate array through descriptors without invoking its get trap', async () => {
  const fixtureValue = fixture();
  const candidate = recoveryCandidate({ auditId: 'audit-array-proxy' });
  let getTrapCalls = 0;
  let revokeCalls = 0;
  let finishCalls = 0;
  const candidateValues = [candidate];
  Object.defineProperty(candidateValues, 'unexpected', { enumerable: true, value: true });
  const candidates = new Proxy(candidateValues, {
    get() {
      getTrapCalls += 1;
      throw new Error('candidate array values must come from descriptors');
    },
  });
  const state = {
    async listRecoveryCandidates() {
      return Object.freeze({
        version: 'PixelRecoveryScanV1', candidates,
        unavailableAuditIds: Object.freeze([]), hasUnattributedUnavailable: false, blockingCount: 0,
      });
    },
    async revokeAudit() { revokeCalls += 1; return Object.freeze({ version: 'PixelRevokeResultV1', status: 'mismatch', suspension: null }); },
    async finish() { finishCalls += 1; return true; },
    async nextExpiresAt() { return null; },
  };
  const scheduler = createPixelConsentExpirySchedulerV1(fixtureValue.chromeApi, {
    pixelState: state, liquidator: fixtureValue.liquidator, now: () => NOW,
  });

  await assert.rejects(scheduler.run('alarm'), /PIXEL_STATE_UNAVAILABLE/u);
  assert.equal(getTrapCalls, 0);
  assert.equal(revokeCalls, 0);
  assert.equal(finishCalls, 0);
  assert.equal(fixtureValue.calls.length, 0);
});

test('validates descriptor-safe policy and URL copies without re-entering their proxies', async () => {
  const fixtureValue = fixture();
  const candidate = { ...recoveryCandidate({ auditId: 'audit-nested-proxies' }) };
  const policyTraps = { get: 0, getPrototypeOf: 0, ownKeys: 0 };
  const urlTraps = { get: 0, getPrototypeOf: 0, ownKeys: 0 };
  const monitoredProxy = (value, traps) => new Proxy({ ...value }, {
    get(target, property, receiver) {
      traps.get += 1;
      return Reflect.get(target, property, receiver);
    },
    getPrototypeOf(target) {
      traps.getPrototypeOf += 1;
      return Reflect.getPrototypeOf(target);
    },
    ownKeys(target) {
      traps.ownKeys += 1;
      return Reflect.ownKeys(target);
    },
  });
  candidate.capturePolicy = monitoredProxy(candidate.capturePolicy, policyTraps);
  candidate.urlEvidence = monitoredProxy(candidate.urlEvidence, urlTraps);
  Object.freeze(candidate);
  let revokeCalls = 0;
  const state = {
    async listRecoveryCandidates() {
      return Object.freeze({
        version: 'PixelRecoveryScanV1', candidates: Object.freeze([candidate]),
        unavailableAuditIds: Object.freeze([]), hasUnattributedUnavailable: false, blockingCount: 0,
      });
    },
    async revokeAudit() {
      revokeCalls += 1;
      return Object.freeze({ version: 'PixelRevokeResultV1', status: 'mismatch', suspension: null });
    },
    async nextExpiresAt() { return null; },
  };
  const scheduler = createPixelConsentExpirySchedulerV1(fixtureValue.chromeApi, {
    pixelState: state, liquidator: fixtureValue.liquidator, now: () => NOW,
  });

  await scheduler.run('panel');
  assert.equal(revokeCalls, 1);
  assert.equal(policyTraps.get, 0);
  assert.equal(urlTraps.get, 0);
  assert.equal(policyTraps.getPrototypeOf, 1);
  assert.equal(urlTraps.getPrototypeOf, 1);
  assert.equal(policyTraps.ownKeys, 1);
  assert.equal(urlTraps.ownKeys, 1);
});

for (const unsafeStringField of ['source.ownershipId', 'source.pageId', 'auditId', 'consentId', 'urlSessionDigest']) {
  test(`rejects non-string ${unsafeStringField} without invoking string coercion`, async () => {
    const fixtureValue = fixture();
    const candidate = { ...recoveryCandidate({ auditId: `audit-coercion-${unsafeStringField.replace('.', '-')}` }) };
    let coercions = 0;
    const coercible = validValue => Object.freeze({
      [Symbol.toPrimitive]() {
        coercions += 1;
        return validValue;
      },
    });
    if (unsafeStringField === 'source.ownershipId') {
      candidate.source = Object.freeze({
        kind: 'owned-disposable', ownershipId: coercible('owner-valid'),
        cleanupMode: 'always', pageId: null,
      });
    } else if (unsafeStringField === 'source.pageId') {
      candidate.source = Object.freeze({
        kind: 'owned-disposable', ownershipId: 'owner-valid',
        cleanupMode: 'always', pageId: coercible('page-valid'),
      });
    } else if (unsafeStringField === 'auditId') candidate.auditId = coercible('audit-coercion-valid');
    else if (unsafeStringField === 'consentId') candidate.consentId = coercible('BwcHBwcHBwcHBwcHBwcHBw');
    else candidate.urlSessionDigest = coercible(DIGEST);
    Object.freeze(candidate);
    let revokeCalls = 0;
    let finishCalls = 0;
    const state = {
      async listRecoveryCandidates() {
        return Object.freeze({
          version: 'PixelRecoveryScanV1', candidates: Object.freeze([candidate]),
          unavailableAuditIds: Object.freeze([]), hasUnattributedUnavailable: false, blockingCount: 0,
        });
      },
      async revokeAudit() { revokeCalls += 1; return Object.freeze({ version: 'PixelRevokeResultV1', status: 'mismatch', suspension: null }); },
      async finish() { finishCalls += 1; return true; },
      async nextExpiresAt() { return null; },
    };
    const scheduler = createPixelConsentExpirySchedulerV1(fixtureValue.chromeApi, {
      pixelState: state, liquidator: fixtureValue.liquidator, now: () => NOW,
    });

    await assert.rejects(scheduler.run('alarm'), /PIXEL_STATE_UNAVAILABLE/u);
    assert.equal(coercions, 0);
    assert.equal(revokeCalls, 0);
    assert.equal(finishCalls, 0);
    assert.equal(fixtureValue.calls.length, 0);
  });
}

test('rejects a candidate updated in the future before revocation or cleanup effects', async () => {
  const fixtureValue = fixture();
  const candidate = Object.freeze({
    ...recoveryCandidate({ auditId: 'audit-future-update', state: 'paused', revokeReason: null, expiresAt: NOW - 1 }),
    updatedAt: NOW + 1,
  });
  let revokeCalls = 0;
  let finishCalls = 0;
  const state = {
    async listRecoveryCandidates() {
      return Object.freeze({
        version: 'PixelRecoveryScanV1', candidates: Object.freeze([candidate]),
        unavailableAuditIds: Object.freeze([]), hasUnattributedUnavailable: false, blockingCount: 0,
      });
    },
    async revokeAudit() { revokeCalls += 1; return Object.freeze({ version: 'PixelRevokeResultV1', status: 'mismatch', suspension: null }); },
    async finish() { finishCalls += 1; return true; },
    async nextExpiresAt() { return null; },
  };
  const scheduler = createPixelConsentExpirySchedulerV1(fixtureValue.chromeApi, {
    pixelState: state, liquidator: fixtureValue.liquidator, now: () => NOW,
  });

  await assert.rejects(scheduler.run('alarm'), /PIXEL_STATE_UNAVAILABLE/u);
  assert.equal(revokeCalls, 0);
  assert.equal(finishCalls, 0);
  assert.equal(fixtureValue.calls.length, 0);
});

test('rejects valid categories outside canonical order as a malformed scan', async () => {
  const fixtureValue = fixture();
  const candidate = Object.freeze({
    ...recoveryCandidate({ auditId: 'audit-category-order' }),
    categories: Object.freeze(['otp', 'password']),
  });
  let revokeCalls = 0;
  let finishCalls = 0;
  const state = {
    async listRecoveryCandidates() {
      return Object.freeze({
        version: 'PixelRecoveryScanV1', candidates: Object.freeze([candidate]),
        unavailableAuditIds: Object.freeze([]), hasUnattributedUnavailable: false, blockingCount: 0,
      });
    },
    async revokeAudit() { revokeCalls += 1; return Object.freeze({ version: 'PixelRevokeResultV1', status: 'mismatch', suspension: null }); },
    async finish() { finishCalls += 1; return true; },
    async nextExpiresAt() { return null; },
  };
  const scheduler = createPixelConsentExpirySchedulerV1(fixtureValue.chromeApi, {
    pixelState: state, liquidator: fixtureValue.liquidator, now: () => NOW,
  });

  await assert.rejects(scheduler.run('panel'), /PIXEL_STATE_UNAVAILABLE/u);
  assert.equal(revokeCalls, 0);
  assert.equal(finishCalls, 0);
  assert.equal(fixtureValue.calls.length, 0);
});

test('does not adopt immutable fields from a foreign already-revoked snapshot', async () => {
  const scenarios = [
    {
      name: 'owned source',
      changes: {
        source: Object.freeze({
          kind: 'owned-disposable', ownershipId: 'owner-foreign',
          cleanupMode: 'always', pageId: 'page-owned',
        }),
      },
    },
    { name: 'binding', changes: { tabId: 8 } },
    { name: 'digest', changes: { urlSessionDigest: `hmac-sha256:${'c'.repeat(43)}` } },
    {
      name: 'policy',
      changes: {
        capturePolicy: createCapturePolicyV1({ mode: 'full-evidence', includeQuery: true }),
      },
    },
    { name: 'categories', changes: { categories: Object.freeze(['otp']) } },
  ];

  for (const scenario of scenarios) {
    const fixtureValue = fixture();
    const candidate = Object.freeze({
      ...recoveryCandidate({ auditId: `audit-foreign-${scenario.name.replace(' ', '-')}` }),
      source: Object.freeze({
        kind: 'owned-disposable', ownershipId: 'owner-owned',
        cleanupMode: 'always', pageId: 'page-owned',
      }),
    });
    const foreign = Object.freeze({ ...candidate, ...scenario.changes });
    let liquidatorCalls = 0;
    let deferCalls = 0;
    let finishCalls = 0;
    const state = {
      async listRecoveryCandidates() {
        return Object.freeze({
          version: 'PixelRecoveryScanV1', candidates: Object.freeze([candidate]),
          unavailableAuditIds: Object.freeze([]), hasUnattributedUnavailable: false,
          blockingCount: 0,
        });
      },
      async revokeAudit() {
        return Object.freeze({
          version: 'PixelRevokeResultV1', status: 'already-revoked',
          suspension: foreign,
        });
      },
      async deferCleanup() { deferCalls += 1; return foreign; },
      async finish() { finishCalls += 1; return true; },
      async nextExpiresAt() { return null; },
    };
    const scheduler = createPixelConsentExpirySchedulerV1(fixtureValue.chromeApi, {
      pixelState: state,
      liquidator: { async liquidate() { liquidatorCalls += 1; return true; } },
      now: () => NOW,
    });

    await scheduler.run('panel');
    assert.deepEqual(
      { liquidatorCalls, deferCalls, finishCalls },
      { liquidatorCalls: 0, deferCalls: 0, finishCalls: 0 },
      scenario.name,
    );
  }
});

test('rejects revoke results outside the allowed status-specific correlation', async () => {
  const pausedCandidate = auditId => recoveryCandidate({
    auditId, state: 'paused', revokeReason: null, expiresAt: NOW - 1,
  });
  const revokedResult = (candidate, changes = {}) => Object.freeze({
    ...candidate,
    revision: candidate.revision + 1,
    cleanupAttempts: 0,
    cleanupNotBefore: NOW,
    state: 'revoked',
    resumePhase: null,
    revokeReason: candidate.state === 'paused'
      ? 'PIXEL_CONSENT_EXPIRED'
      : 'PIXEL_RESUME_INTERRUPTED',
    ...changes,
  });
  const finishedResult = (candidate, changes = {}) => Object.freeze({
    ...candidate,
    revision: candidate.revision + 1,
    cleanupAttempts: 0,
    cleanupNotBefore: NOW,
    state: 'finished',
    resumePhase: null,
    revokeReason: null,
    ...changes,
  });
  const scenarios = [
    {
      name: 'already-revoked concurrent defer', status: 'already-revoked',
      candidate: recoveryCandidate({ auditId: 'audit-status-already-deferred' }),
      result(candidate) {
        return Object.freeze({
          ...candidate, revision: candidate.revision + 1,
          cleanupAttempts: 1, cleanupNotBefore: NOW + 60_000,
        });
      },
    },
    {
      name: 'already-revoked after the immediate revocation was deferred',
      status: 'already-revoked',
      candidate: pausedCandidate('audit-status-already-paused-deferred'),
      result(candidate) {
        return revokedResult(candidate, {
          revision: candidate.revision + 2,
          revokeReason: 'AUDIT_CANCELLED',
          cleanupAttempts: 1,
          cleanupNotBefore: NOW + 60_000,
        });
      },
    },
    {
      name: 'revoked without revision increment', status: 'revoked',
      candidate: pausedCandidate('audit-status-revoked-same-revision'),
      result: candidate => revokedResult(candidate, { revision: candidate.revision }),
    },
    {
      name: 'revoked after a skipped revision', status: 'revoked',
      candidate: pausedCandidate('audit-status-revoked-skipped-revision'),
      result: candidate => revokedResult(candidate, { revision: candidate.revision + 2 }),
    },
    {
      name: 'revoked with a foreign reason', status: 'revoked',
      candidate: pausedCandidate('audit-status-revoked-reason'),
      result: candidate => revokedResult(candidate, { revokeReason: 'AUDIT_CANCELLED' }),
    },
    {
      name: 'revoked carrying cleanup attempts', status: 'revoked',
      candidate: pausedCandidate('audit-status-revoked-cleanup-attempts'),
      result: candidate => revokedResult(candidate, { cleanupAttempts: 1 }),
    },
    {
      name: 'revoked with delayed cleanup', status: 'revoked',
      candidate: pausedCandidate('audit-status-revoked-cleanup-delay'),
      result: candidate => revokedResult(candidate, { cleanupNotBefore: NOW + 60_000 }),
    },
    {
      name: 'revoked from an already-revoked candidate', status: 'revoked',
      candidate: recoveryCandidate({ auditId: 'audit-status-revoked-origin' }),
      result: candidate => candidate,
    },
    {
      name: 'finished without a newer revision', status: 'finished',
      candidate: pausedCandidate('audit-status-finished-same-revision'),
      result: candidate => finishedResult(candidate, { revision: candidate.revision }),
    },
    {
      name: 'finished with a regressed update time', status: 'finished',
      candidate: recoveryCandidate({ auditId: 'audit-status-finished-regressed-time' }),
      result: candidate => finishedResult(candidate, {
        revision: candidate.revision + 2,
        updatedAt: candidate.updatedAt - 1,
        cleanupNotBefore: candidate.updatedAt - 1,
      }),
    },
    {
      name: 'finished with a concurrent cleanup mutation', status: 'finished',
      candidate: recoveryCandidate({ auditId: 'audit-status-finished-cleanup' }),
      result: candidate => finishedResult(candidate, {
        cleanupAttempts: 1, cleanupNotBefore: NOW,
      }),
    },
  ];

  for (const scenario of scenarios) {
    const fixtureValue = fixture();
    let liquidatorCalls = 0;
    let deferCalls = 0;
    let finishCalls = 0;
    const state = {
      async listRecoveryCandidates() {
        return Object.freeze({
          version: 'PixelRecoveryScanV1', candidates: Object.freeze([scenario.candidate]),
          unavailableAuditIds: Object.freeze([]), hasUnattributedUnavailable: false,
          blockingCount: scenario.startup ? 1 : 0,
        });
      },
      async revokeAudit() {
        return Object.freeze({
          version: 'PixelRevokeResultV1', status: scenario.status,
          suspension: scenario.result(scenario.candidate),
        });
      },
      async deferCleanup() { deferCalls += 1; return null; },
      async finish() { finishCalls += 1; return true; },
      async nextExpiresAt() { return null; },
    };
    const scheduler = createPixelConsentExpirySchedulerV1(fixtureValue.chromeApi, {
      pixelState: state,
      liquidator: { async liquidate() { liquidatorCalls += 1; return true; } },
      now: () => NOW,
    });

    if (scenario.startup) {
      await assert.rejects(scheduler.recoverOnStartup(), /PIXEL_RECOVERY_PENDING/u);
    } else {
      await scheduler.run('panel');
    }
    assert.deepEqual(
      { liquidatorCalls, deferCalls, finishCalls },
      { liquidatorCalls: 0, deferCalls: 0, finishCalls: 0 },
      scenario.name,
    );
  }
});

for (const race of [
  { state: 'paused', firstReason: 'AUDIT_CANCELLED', startup: false },
  { state: 'resuming', firstReason: 'SESSION_ENDED', startup: true },
]) {
  test(`accepts a real ${race.state} first-writer revocation returned as already-revoked`, async () => {
    let wall = NOW;
    const fixtureValue = fixture({ now: () => wall });
    const paused = await fixtureValue.pixelState.pause(pauseInput(
      `audit-real-already-${race.state}`,
      race.state === 'paused' ? NOW + 1 : NOW + 1_000,
    ));
    if (race.state === 'paused') {
      wall += 2;
    } else {
      await fixtureValue.pixelState.claimAndBeginResume({
        auditId: paused.auditId,
        consentId: paused.consentId,
        proof: {
          kind: 'attached', tabId: 7, windowId: 3,
          documentId: `doc-${paused.auditId}`, urlSessionDigest: DIGEST,
        },
        mode: 'full-evidence',
        categories: ['password'],
      });
    }
    let firstRevocation = null;
    const racedState = {
      ...fixtureValue.pixelState,
      async revokeAudit(request) {
        if (firstRevocation === null) {
          firstRevocation = await fixtureValue.pixelState.revokeAudit({
            ...request,
            reason: race.firstReason,
          });
          assert.equal(firstRevocation.status, 'revoked');
        }
        return fixtureValue.pixelState.revokeAudit(request);
      },
    };
    const scheduler = createPixelConsentExpirySchedulerV1(fixtureValue.chromeApi, {
      pixelState: racedState,
      liquidator: fixtureValue.liquidator,
      now: () => wall,
    });

    if (race.startup) await scheduler.recoverOnStartup();
    else await scheduler.run('panel');

    assert.equal(firstRevocation.suspension.revokeReason, race.firstReason);
    assert.equal(fixtureValue.calls.length, 1);
    assert.equal(fixtureValue.calls[0].reason, race.firstReason);
    assert.equal(await fixtureValue.pixelState.readSuspension(paused.auditId), null);
  });
}

for (const race of [
  { state: 'paused', firstReason: 'AUDIT_DELETED', startup: false },
  { state: 'resuming', firstReason: 'SESSION_ENDED', startup: true },
]) {
  test(`finishes only after a real ${race.state} revocation-and-finish race`, async () => {
    let wall = NOW;
    const fixtureValue = fixture({ now: () => wall });
    const paused = await fixtureValue.pixelState.pause(pauseInput(
      `audit-real-finished-${race.state}`,
      race.state === 'paused' ? NOW + 1 : NOW + 1_000,
    ));
    if (race.state === 'paused') {
      wall += 2;
    } else {
      await fixtureValue.pixelState.claimAndBeginResume({
        auditId: paused.auditId,
        consentId: paused.consentId,
        proof: {
          kind: 'attached', tabId: 7, windowId: 3,
          documentId: `doc-${paused.auditId}`, urlSessionDigest: DIGEST,
        },
        mode: 'full-evidence',
        categories: ['password'],
      });
    }
    const listed = await fixtureValue.pixelState.readSuspension(paused.auditId);
    let raced = false;
    let schedulerFinishCalls = 0;
    const racedState = {
      ...fixtureValue.pixelState,
      async revokeAudit(request) {
        if (!raced) {
          raced = true;
          const revoked = await fixtureValue.pixelState.revokeAudit({
            ...request,
            reason: race.firstReason,
          });
          assert.equal(revoked.status, 'revoked');
          assert.equal(revoked.suspension.revision, listed.revision + 1);
          const originalRemove = fixtureValue.sessionArea.remove;
          fixtureValue.sessionArea.remove = async () => {};
          try {
            await assert.rejects(
              fixtureValue.pixelState.finish({
                auditId: paused.auditId,
                consentId: paused.consentId,
              }),
              /PIXEL_STATE_UNAVAILABLE/u,
            );
          } finally {
            fixtureValue.sessionArea.remove = originalRemove;
          }
          const terminal = await fixtureValue.pixelState.readSuspension(paused.auditId);
          assert.equal(terminal.state, 'finished');
          assert.equal(terminal.revision, listed.revision + 2);
          assert.equal(terminal.cleanupAttempts, 0);
          assert.equal(terminal.cleanupNotBefore, terminal.updatedAt);
        }
        return fixtureValue.pixelState.revokeAudit(request);
      },
      async finish(request) {
        schedulerFinishCalls += 1;
        return fixtureValue.pixelState.finish(request);
      },
    };
    const scheduler = createPixelConsentExpirySchedulerV1(fixtureValue.chromeApi, {
      pixelState: racedState,
      liquidator: fixtureValue.liquidator,
      now: () => wall,
    });

    if (race.startup) await scheduler.recoverOnStartup();
    else await scheduler.run('panel');

    assert.equal(fixtureValue.calls.length, 0);
    assert.equal(schedulerFinishCalls, 1);
    assert.equal(await fixtureValue.pixelState.readSuspension(paused.auditId), null);
  });
}

test('accepts exact canonical snapshots for each revoke result status', async () => {
  const paused = recoveryCandidate({
    auditId: 'audit-status-valid-revoked', state: 'paused',
    revokeReason: null, expiresAt: NOW - 1,
  });
  const revoked = recoveryCandidate({ auditId: 'audit-status-valid-already' });
  const cleanupPending = Object.freeze({
    ...recoveryCandidate({ auditId: 'audit-status-valid-finished' }),
    issuedAt: NOW - 120_000, updatedAt: NOW - 60_000,
    cleanupAttempts: 1, cleanupNotBefore: NOW,
  });
  const scenarios = [
    {
      name: 'revoked', candidate: paused, status: 'revoked', liquidatorCalls: 1,
      result: Object.freeze({
        ...paused, revision: paused.revision + 1,
        cleanupAttempts: 0, cleanupNotBefore: NOW,
        state: 'revoked', resumePhase: null, revokeReason: 'PIXEL_CONSENT_EXPIRED',
      }),
    },
    {
      name: 'already-revoked', candidate: revoked, status: 'already-revoked',
      liquidatorCalls: 1, result: revoked,
    },
    {
      name: 'finished', candidate: cleanupPending, status: 'finished', liquidatorCalls: 0,
      result: Object.freeze({
        ...cleanupPending, revision: cleanupPending.revision + 1,
        updatedAt: NOW, cleanupAttempts: 0, cleanupNotBefore: NOW,
        state: 'finished', resumePhase: null, revokeReason: null,
      }),
    },
  ];

  for (const scenario of scenarios) {
    const fixtureValue = fixture();
    let revokeCalls = 0;
    let liquidatorCalls = 0;
    let deferCalls = 0;
    let finishCalls = 0;
    const state = {
      async listRecoveryCandidates() {
        return Object.freeze({
          version: 'PixelRecoveryScanV1', candidates: Object.freeze([scenario.candidate]),
          unavailableAuditIds: Object.freeze([]), hasUnattributedUnavailable: false,
          blockingCount: 0,
        });
      },
      async revokeAudit() {
        revokeCalls += 1;
        return Object.freeze({
          version: 'PixelRevokeResultV1', status: scenario.status,
          suspension: scenario.result,
        });
      },
      async deferCleanup() { deferCalls += 1; return null; },
      async finish() { finishCalls += 1; return true; },
      async nextExpiresAt() { return null; },
    };
    const scheduler = createPixelConsentExpirySchedulerV1(fixtureValue.chromeApi, {
      pixelState: state,
      liquidator: { async liquidate() { liquidatorCalls += 1; return true; } },
      now: () => NOW,
    });

    await scheduler.run('panel');
    assert.deepEqual(
      { revokeCalls, liquidatorCalls, deferCalls, finishCalls },
      {
        revokeCalls: 1, liquidatorCalls: scenario.liquidatorCalls,
        deferCalls: 0, finishCalls: 1,
      },
      scenario.name,
    );
  }
});

test('accepts an immediate finished transition from runner-started recovery', async () => {
  const fixtureValue = fixture();
  const candidate = Object.freeze({
    ...recoveryCandidate({
      auditId: 'audit-status-valid-runner-finished',
      state: 'resuming', revokeReason: null,
    }),
    resumePhase: 'runner-started',
  });
  const finished = Object.freeze({
    ...candidate, revision: candidate.revision + 1,
    cleanupAttempts: 0, cleanupNotBefore: NOW,
    state: 'finished', resumePhase: null, revokeReason: null,
  });
  let active = true;
  let liquidatorCalls = 0;
  let finishCalls = 0;
  const state = {
    async listRecoveryCandidates() {
      return Object.freeze({
        version: 'PixelRecoveryScanV1',
        candidates: Object.freeze(active ? [candidate] : []),
        unavailableAuditIds: Object.freeze([]), hasUnattributedUnavailable: false,
        blockingCount: active ? 1 : 0,
      });
    },
    async revokeAudit() {
      return Object.freeze({
        version: 'PixelRevokeResultV1', status: 'finished', suspension: finished,
      });
    },
    async finish() { finishCalls += 1; active = false; return true; },
    async nextExpiresAt() { return null; },
  };
  const scheduler = createPixelConsentExpirySchedulerV1(fixtureValue.chromeApi, {
    pixelState: state,
    liquidator: { async liquidate() { liquidatorCalls += 1; return true; } },
    now: () => NOW,
  });

  await scheduler.recoverOnStartup();
  assert.equal(liquidatorCalls, 0);
  assert.equal(finishCalls, 1);
});

const invalidRevokeResultScenarios = [
  {
    name: 'revoked status with a different audit',
    status: 'revoked',
    suspension: candidate => recoveryCandidate({ auditId: `${candidate.auditId}-other`, consentId: candidate.consentId }),
  },
  {
    name: 'already-revoked status with a different consent',
    status: 'already-revoked',
    suspension: candidate => recoveryCandidate({ auditId: candidate.auditId, consentId: 'CAgICAgICAgICAgICAgICA' }),
  },
  {
    name: 'revoked status with a finished suspension',
    status: 'revoked',
    suspension: candidate => recoveryCandidate({ auditId: candidate.auditId, consentId: candidate.consentId, state: 'finished', revokeReason: null }),
  },
  {
    name: 'already-revoked status with a finished suspension',
    status: 'already-revoked',
    suspension: candidate => recoveryCandidate({ auditId: candidate.auditId, consentId: candidate.consentId, state: 'finished', revokeReason: null }),
  },
  {
    name: 'finished status with a revoked suspension',
    status: 'finished',
    suspension: candidate => recoveryCandidate({ auditId: candidate.auditId, consentId: candidate.consentId }),
  },
];

for (const scenario of invalidRevokeResultScenarios) {
  test(`does not act on ${scenario.name}`, async () => {
    const fixtureValue = fixture();
    const candidate = recoveryCandidate({
      auditId: `audit-revoke-${scenario.status.replace('already-revoked', 'already')}`,
      state: 'paused', revokeReason: null, expiresAt: NOW - 1,
    });
    let finishCalls = 0;
    let liquidatorCalls = 0;
    const state = {
      async listRecoveryCandidates() {
        return Object.freeze({
          version: 'PixelRecoveryScanV1', candidates: Object.freeze([candidate]),
          unavailableAuditIds: Object.freeze([]), hasUnattributedUnavailable: false, blockingCount: 0,
        });
      },
      async revokeAudit() {
        return Object.freeze({
          version: 'PixelRevokeResultV1', status: scenario.status,
          suspension: scenario.suspension(candidate),
        });
      },
      async finish() { finishCalls += 1; return true; },
      async nextExpiresAt() { return null; },
    };
    const scheduler = createPixelConsentExpirySchedulerV1(fixtureValue.chromeApi, {
      pixelState: state,
      liquidator: { async liquidate() { liquidatorCalls += 1; return true; } },
      now: () => NOW,
    });

    await scheduler.run('alarm');
    assert.equal(liquidatorCalls, 0);
    assert.equal(finishCalls, 0);
  });
}

test('rejects future-dated revoked and finished responses before cleanup effects', async () => {
  const outcomes = [];
  for (const status of ['revoked', 'finished']) {
    const fixtureValue = fixture();
    const candidate = recoveryCandidate({
      auditId: `audit-future-${status}`,
      state: 'paused',
      revokeReason: null,
      expiresAt: NOW - 1,
    });
    const terminal = Object.freeze({
      ...recoveryCandidate({
        auditId: candidate.auditId,
        consentId: candidate.consentId,
        revision: candidate.revision + 1,
        state: status,
        revokeReason: status === 'revoked' ? 'PIXEL_CONSENT_EXPIRED' : null,
        cleanupNotBefore: NOW + 600_000,
      }),
      updatedAt: NOW + 600_000,
    });
    let liquidatorCalls = 0;
    let finishCalls = 0;
    const state = {
      async listRecoveryCandidates() {
        return Object.freeze({
          version: 'PixelRecoveryScanV1', candidates: Object.freeze([candidate]),
          unavailableAuditIds: Object.freeze([]), hasUnattributedUnavailable: false, blockingCount: 0,
        });
      },
      async revokeAudit() {
        return Object.freeze({ version: 'PixelRevokeResultV1', status, suspension: terminal });
      },
      async finish() { finishCalls += 1; return true; },
      async nextExpiresAt() { return null; },
    };
    const scheduler = createPixelConsentExpirySchedulerV1(fixtureValue.chromeApi, {
      pixelState: state,
      liquidator: { async liquidate() { liquidatorCalls += 1; return true; } },
      now: () => NOW,
    });

    await scheduler.run('alarm');
    outcomes.push([liquidatorCalls, finishCalls]);
  }

  assert.deepEqual(outcomes, [[0, 0], [0, 0]]);
});

test('rescans startup readiness after confirmed resume revocation despite inconclusive cleanup', async () => {
  const outcomes = [];
  for (const cleanupOutcome of ['finish-false', 'defer-null']) {
    const fixtureValue = fixture();
    const resuming = recoveryCandidate({
      auditId: `audit-startup-${cleanupOutcome}`,
      state: 'resuming',
      revokeReason: null,
    });
    const revoked = recoveryCandidate({
      auditId: resuming.auditId,
      consentId: resuming.consentId,
      revision: resuming.revision + 1,
      state: 'revoked',
      revokeReason: 'PIXEL_RESUME_INTERRUPTED',
    });
    let scans = 0;
    let liquidatorCalls = 0;
    let finishCalls = 0;
    let deferCalls = 0;
    const state = {
      async listRecoveryCandidates() {
        scans += 1;
        return Object.freeze({
          version: 'PixelRecoveryScanV1',
          candidates: Object.freeze(scans === 1 ? [resuming] : []),
          unavailableAuditIds: Object.freeze([]),
          hasUnattributedUnavailable: false,
          blockingCount: scans === 1 ? 1 : 0,
        });
      },
      async revokeAudit() {
        return Object.freeze({ version: 'PixelRevokeResultV1', status: 'revoked', suspension: revoked });
      },
      async readSuspension() { return revoked; },
      async deferCleanup() { deferCalls += 1; return null; },
      async finish() { finishCalls += 1; return false; },
      async nextExpiresAt() { return null; },
    };
    const scheduler = createPixelConsentExpirySchedulerV1(fixtureValue.chromeApi, {
      pixelState: state,
      liquidator: {
        async liquidate() {
          liquidatorCalls += 1;
          return cleanupOutcome === 'finish-false';
        },
      },
      now: () => NOW,
    });

    await scheduler.recoverOnStartup();
    outcomes.push([scans, liquidatorCalls, finishCalls, deferCalls]);
  }

  assert.deepEqual(outcomes, [[2, 1, 1, 0], [2, 1, 0, 1]]);
});

test('detects rollback during the first deadline read before mutating the alarm', async () => {
  let wall = NOW;
  const fixtureValue = fixture({ now: () => wall });
  let reads = 0;
  let createCalls = 0;
  const originalCreate = fixtureValue.chromeApi.alarms.create;
  fixtureValue.chromeApi.alarms.create = async (...args) => {
    createCalls += 1;
    return originalCreate(...args);
  };
  const state = {
    async listRecoveryCandidates() { throw new Error('not used by scheduleNext'); },
    async nextExpiresAt() {
      reads += 1;
      if (reads === 1) wall = NOW - 1_000;
      return NOW + 5_000;
    },
  };
  const scheduler = createPixelConsentExpirySchedulerV1(fixtureValue.chromeApi, {
    pixelState: state,
    liquidator: fixtureValue.liquidator,
    now: () => wall,
  });

  await assert.rejects(scheduler.scheduleNext(), /PIXEL_STATE_UNAVAILABLE/u);
  assert.equal(createCalls, 0);
  assert.equal(fixtureValue.alarms.has(PIXEL_CONSENT_ALARM_NAME), false);
});
