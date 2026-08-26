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

export function reducePanelState(current, message, extensionBaseUrl = '') {
  if (!current || typeof current !== 'object' || !message || typeof message !== 'object') return current;
  if (!isMessageForAudit(message, current.auditId)) return current;
  if (message.type === 'AUDIT_PROGRESS') {
    if (['complete', 'partial', 'failed', 'cancelled'].includes(current.status)) return current;
    const percent = Number.isFinite(message.percent) ? Math.max(0, Math.min(100, message.percent)) : current.percent;
    if (percent < (current.percent ?? 0)) return current;
    return {
      ...current,
      status: 'running',
      percent,
      message: typeof message.message === 'string' ? message.message : current.message,
    };
  }
  if (message.type === 'AUDIT_COMPLETE') {
    return {
      ...current,
      status: message.status === 'partial' ? 'partial' : 'complete',
      percent: 100,
      message: message.status === 'partial' ? 'Auditoria concluída com limitações.' : 'Auditoria concluída.',
      reviewUrl: isSafeReportUrl(message.reviewUrl, extensionBaseUrl) ? message.reviewUrl : null,
    };
  }
  if (message.type === 'AUDIT_FAILED') {
    return {
      ...current,
      status: message.status === 'cancelled' ? 'cancelled' : 'failed',
      message: typeof message.error === 'string' ? message.error : 'A auditoria não pôde ser concluída.',
      reviewUrl: null,
    };
  }
  return current;
}
