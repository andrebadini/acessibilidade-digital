export const PIXEL_CONSENT_ALARM_NAME = 'audita-pixel-consent-expiry-v1';

const ALARM_STATES = new WeakMap();

function failure(code) { return new Error(code); }
function validEpoch(value) { return Number.isSafeInteger(value) && value >= 0; }
function alarmState(alarms) {
  let state = ALARM_STATES.get(alarms);
  if (!state) { state = { tail: Promise.resolve() }; ALARM_STATES.set(alarms, state); }
  return state;
}

function alarmProjection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    const name = Object.getOwnPropertyDescriptor(value, 'name');
    const scheduledTime = Object.getOwnPropertyDescriptor(value, 'scheduledTime');
    if (!name || !scheduledTime || !Object.hasOwn(name, 'value') || !Object.hasOwn(scheduledTime, 'value') || name.value !== PIXEL_CONSENT_ALARM_NAME || !validEpoch(scheduledTime.value)) return null;
    return { name: name.value, scheduledTime: scheduledTime.value };
  } catch { return null; }
}

export function createPixelConsentExpirySchedulerV1(chromeApi, { pixelState, liquidator, now }) {
  if (!chromeApi?.alarms || typeof chromeApi.alarms.create !== 'function' || typeof chromeApi.alarms.get !== 'function' || typeof chromeApi.alarms.clear !== 'function' || !pixelState || typeof liquidator?.liquidate !== 'function' || typeof now !== 'function') throw failure('PIXEL_STATE_UNAVAILABLE');
  const shared = alarmState(chromeApi.alarms);
  let disposed = false;
  let startupDone = false;
  const serial = operation => {
    if (disposed) return Promise.reject(failure('PIXEL_STATE_UNAVAILABLE'));
    const result = shared.tail.then(operation, operation);
    shared.tail = result.catch(() => {});
    return result;
  };
  const current = () => {
    let value;
    try { value = now(); } catch { throw failure('PIXEL_STATE_UNAVAILABLE'); }
    if (!validEpoch(value)) throw failure('PIXEL_STATE_UNAVAILABLE');
    return value;
  };
  const schedule = async () => {
    const at = current();
    const next = await pixelState.nextExpiresAt();
    const when = next === null ? null : Math.max(at, next);
    try {
      if (when === null) await chromeApi.alarms.clear(PIXEL_CONSENT_ALARM_NAME);
      else await chromeApi.alarms.create(PIXEL_CONSENT_ALARM_NAME, { when });
    } catch { /* storage/alarm read-back decides */ }
    let observed;
    try { observed = await chromeApi.alarms.get(PIXEL_CONSENT_ALARM_NAME); } catch { throw failure('PIXEL_STATE_UNAVAILABLE'); }
    if (when === null) {
      if (observed !== undefined) throw failure('PIXEL_STATE_UNAVAILABLE');
    } else if (alarmProjection(observed)?.scheduledTime !== when) throw failure('PIXEL_STATE_UNAVAILABLE');
  };
  const process = async (includeResuming, drainAll) => {
    do {
      const scan = await pixelState.listRecoveryCandidates({ limit: 25, includeResuming });
      if (scan.unavailableCount > 0) throw failure('PIXEL_STATE_UNAVAILABLE');
      for (const candidate of scan.candidates) {
        if (candidate.state === 'finished') {
          try { await pixelState.finish({ auditId: candidate.auditId, consentId: candidate.consentId }); }
          catch { await pixelState.deferCleanup({ auditId: candidate.auditId, consentId: candidate.consentId, expectedRevision: candidate.revision }); }
          continue;
        }
        const reason = candidate.state === 'paused' ? 'PIXEL_CONSENT_EXPIRED' : candidate.state === 'resuming' ? 'PIXEL_RESUME_INTERRUPTED' : candidate.revokeReason;
        const revoked = await pixelState.revokeAudit({ auditId: candidate.auditId, consentId: candidate.consentId, reason });
        if (!['revoked', 'already-revoked'].includes(revoked.status)) continue;
        const confirmed = revoked.suspension;
        try {
          if (await liquidator.liquidate({ auditId: confirmed.auditId, consentId: confirmed.consentId, reason: confirmed.revokeReason, source: confirmed.source }) !== true) throw failure('LIQUIDATOR_UNCONFIRMED');
          await pixelState.finish({ auditId: confirmed.auditId, consentId: confirmed.consentId });
        } catch {
          const latest = await pixelState.readSuspension(confirmed.auditId);
          if (latest && latest.consentId === confirmed.consentId) await pixelState.deferCleanup({ auditId: latest.auditId, consentId: latest.consentId, expectedRevision: latest.revision });
        }
      }
      if (!drainAll || scan.candidates.length === 0) return scan;
      await Promise.resolve();
    } while (true);
  };
  return Object.freeze({
    scheduleNext: () => serial(schedule),
    run: trigger => serial(async () => {
      if (!['alarm', 'panel'].includes(trigger)) throw failure('PIXEL_STATE_UNAVAILABLE');
      try { await process(false, false); } finally { await schedule(); }
    }),
    recoverOnStartup: () => serial(async () => {
      if (startupDone) return;
      try {
        const scan = await process(true, true);
        if (scan.blockingCount > 0) throw failure('PIXEL_RECOVERY_PENDING');
        startupDone = true;
      } finally { await schedule(); }
    }),
    dispose() { disposed = true; },
  });
}
