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
    const preservedExportStatus = ['queued', 'running', 'delivering', 'complete', 'partial', 'failed'].includes(current.exportStatus)
      ? current.exportStatus
      : message.exportStatus === 'preparing' ? 'preparing' : current.exportStatus;
    return {
      ...current,
      status: message.status === 'partial' ? 'partial' : 'complete',
      percent: 100,
      message: message.status === 'partial' ? 'Auditoria concluída com limitações.' : 'Auditoria concluída.',
      reviewUrl: isSafeReportUrl(message.reviewUrl, extensionBaseUrl) ? message.reviewUrl : null,
      ...(preservedExportStatus ? { exportStatus: preservedExportStatus } : {}),
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
  if (message.type === 'AUDIT_REVIEW_UPDATED') {
    const incomingRevision = message.exportRevision;
    if (!Number.isSafeInteger(incomingRevision) || incomingRevision < 0) return current;
    const currentRevision = Number.isSafeInteger(current.exportRevision) && current.exportRevision >= 0
      ? current.exportRevision
      : null;
    if (currentRevision !== null && incomingRevision <= currentRevision) return current;
    const { exportAttempt: _exportAttempt, leaseOwnerId: _leaseOwnerId, deliveryReceipt: _deliveryReceipt, ...rest } = current;
    return {
      ...rest,
      exportStatus: 'preparing',
      exportRevision: incomingRevision,
      message: 'A revisão foi atualizada; gere o relatório novamente.',
    };
  }
  if (message.type === 'EXPORT_PROGRESS') {
    return applyExportEvent(current, message, 'running', {
      message: typeof message.message === 'string' ? message.message : 'Gerando os arquivos do relatório.',
    });
  }
  if (message.type === 'EXPORT_COMPLETE') {
    const exportStatus = message.status === 'partial' ? 'partial' : 'complete';
    return applyExportEvent(current, message, exportStatus, {
      message: exportStatus === 'partial' ? 'Relatório gerado com limitações.' : 'Arquivos do relatório gerados.',
    });
  }
  if (message.type === 'EXPORT_FAILED') {
    return applyExportEvent(current, message, 'failed', {
      message: typeof message.error === 'string' ? message.error : 'Não foi possível gerar os arquivos do relatório.',
    });
  }
  if (message.type === 'EXPORT_INVALIDATED') {
    return applyExportEvent(current, message, 'preparing', {
      message: typeof message.error === 'string'
        ? message.error
        : 'A auditoria foi atualizada; gere o relatório novamente.',
    });
  }
  return current;
}

export function applyExportEvent(current, message, exportStatus, patch = {}) {
  const incomingRevision = message.exportRevision;
  const incomingAttempt = message.exportAttempt;
  const incomingOwner = message.leaseOwnerId;
  if (!Number.isSafeInteger(incomingRevision) || incomingRevision < 0 ||
    !Number.isSafeInteger(incomingAttempt) || incomingAttempt < 1 ||
    typeof incomingOwner !== 'string' || !VALID_CORRELATION_ID.test(incomingOwner) ||
    !EXPORT_STATUSES.has(exportStatus)) return current;
  const currentRevision = Number.isSafeInteger(current.exportRevision) && current.exportRevision >= 0
    ? current.exportRevision
    : null;
  const currentAttempt = Number.isSafeInteger(current.exportAttempt) && current.exportAttempt >= 1
    ? current.exportAttempt
    : null;
  if (currentRevision !== null && incomingRevision < currentRevision) return current;
  if (currentAttempt !== null) {
    if (incomingAttempt < currentAttempt) return current;
    if (incomingAttempt === currentAttempt) {
      if (typeof current.leaseOwnerId === 'string' && current.leaseOwnerId !== incomingOwner) return current;
      if (incomingRevision === currentRevision && (
        (EXPORT_PHASE_ORDER[exportStatus] ?? -1) < (EXPORT_PHASE_ORDER[current.exportStatus] ?? -1) ||
        EXPORT_TERMINAL_STATUSES.has(current.exportStatus)
      )) return current;
    }
  }
  return {
    ...current,
    ...patch,
    exportStatus,
    exportRevision: incomingRevision,
    exportAttempt: incomingAttempt,
    leaseOwnerId: incomingOwner,
  };
}

export function restoreExportEventState(saved) {
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return {};
  const restored = {};
  if (EXPORT_STATUSES.has(saved.exportStatus)) restored.exportStatus = saved.exportStatus;
  if (Number.isSafeInteger(saved.exportRevision) && saved.exportRevision >= 0) {
    restored.exportRevision = saved.exportRevision;
  }
  if (Number.isSafeInteger(saved.exportAttempt) && saved.exportAttempt >= 1) {
    restored.exportAttempt = saved.exportAttempt;
  }
  if (typeof saved.leaseOwnerId === 'string' && VALID_CORRELATION_ID.test(saved.leaseOwnerId)) {
    restored.leaseOwnerId = saved.leaseOwnerId;
  }
  return restored;
}
const EXPORT_STATUSES = new Set(['preparing', 'queued', 'running', 'delivering', 'complete', 'partial', 'failed']);
const EXPORT_PHASE_ORDER = Object.freeze({
  preparing: 0,
  queued: 1,
  running: 2,
  delivering: 3,
  complete: 4,
  partial: 4,
  failed: 4,
});
const EXPORT_TERMINAL_STATUSES = new Set(['complete', 'partial', 'failed']);
const VALID_CORRELATION_ID = /^[A-Za-z0-9._:-]{1,200}$/u;
