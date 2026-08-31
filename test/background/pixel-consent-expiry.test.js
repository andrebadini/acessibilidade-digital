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
