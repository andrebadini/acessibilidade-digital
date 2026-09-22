import { targetOperationLockName } from '../background/target-operation-queue.js';

const PREFIX = 'audita.reading-active.';
const denied = () => Object.freeze({ ok: false, code: 'READING_CLEANUP_UNCONFIRMED' });
const success = state => Object.freeze({ ok: true, state });

function validRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record) ||
    Object.keys(record).length !== 3 || !['documentId', 'sessionId', 'expiresAt'].every(key => Object.hasOwn(record, key))) return false;
  return typeof record.documentId === 'string' && record.documentId.length > 0 && record.documentId.length <= 512 &&
    !/[\u0000-\u001F\u007F]/u.test(record.documentId) && typeof record.sessionId === 'string' &&
    /^[A-Za-z0-9_-]{1,128}$/u.test(record.sessionId) && Number.isSafeInteger(record.expiresAt) && record.expiresAt >= 0;
}

// Self-contained because chrome.scripting serializes the function into the exact
// isolated document. A stale timer is not proof of absence: dispose even expired state.
function disposeReadingForAudit(sessionId) {
  const key = Symbol.for('audita.tab-reading.inspector.v1');
  const state = globalThis[key];
  if (state === undefined) return { ok: true, sessionId };
  if (!state || state.sessionId !== sessionId || typeof state.dispose !== 'function') return { ok: false };
  try { state.dispose(); } catch { return { ok: false }; }
  return { ok: globalThis[key] === undefined, sessionId };
}

export function createReadingAuditCleaner({ chromeApi }) {
  // The caller holds the shared target Web Lock across this cleanup and the audit.
  // Reading actions take that same lock before validating or changing their record.
  async function clearForTarget(target) {
    try {
      targetOperationLockName(target);
      const key = PREFIX + target.tabId;
      const area = chromeApi.storage.session;
      const envelope = await area.get(key);
      if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return denied();
      if (!Object.hasOwn(envelope, key)) return success('absent');
      const record = envelope[key];
      if (!validRecord(record)) return denied();
      if (record.documentId !== target.documentId) return success('absent');
      const results = await chromeApi.scripting.executeScript({
        target: { tabId: target.tabId, documentIds: [target.documentId] }, world: 'ISOLATED',
        func: disposeReadingForAudit, args: [record.sessionId],
      });
      if (!Array.isArray(results) || results.length !== 1 || results[0].documentId !== target.documentId ||
        results[0].result?.ok !== true || results[0].result?.sessionId !== record.sessionId) return denied();
      // Do not delete a replacement if another document replaced this tab's slot.
      const beforeRemoval = (await area.get(key))?.[key];
      if (!validRecord(beforeRemoval) || beforeRemoval.documentId !== record.documentId ||
        beforeRemoval.sessionId !== record.sessionId || beforeRemoval.expiresAt !== record.expiresAt) return denied();
      await area.remove(key);
      const after = await area.get(key);
      if (!after || typeof after !== 'object' || Object.hasOwn(after, key)) return denied();
      return success('revoked');
    } catch { return denied(); }
  }
  return Object.freeze({ clearForTarget });
}
