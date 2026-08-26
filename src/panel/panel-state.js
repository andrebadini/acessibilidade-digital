export function isMessageForAudit(message, auditId) {
  return Boolean(auditId)
    && Boolean(message)
    && (message.auditId === auditId || message.sessionId === auditId);
}

export function isSafeReportUrl(value, extensionBaseUrl) {
  if (typeof value !== 'string' || typeof extensionBaseUrl !== 'string') return false;
  try {
    const own = new URL(extensionBaseUrl);
    const url = new URL(value);
    if (url.protocol === 'chrome-extension:') {
      return url.protocol === own.protocol && url.hostname === own.hostname;
    }
    if (url.protocol !== 'blob:') return false;
    const blobOrigin = new URL(url.pathname);
    return blobOrigin.protocol === own.protocol && blobOrigin.hostname === own.hostname;
  } catch {
    return false;
  }
}

export function createSubmissionGate() {
  let held = false;
  return {
    tryAcquire() {
      if (held) return false;
      held = true;
      return true;
    },
    release() { held = false; },
  };
}
