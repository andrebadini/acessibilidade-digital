import { sha256Hex } from '../core/report/hash.js';
import { EXPORT_FORMATS_V1 } from '../export/export-formats.js';

const MIME = Object.freeze({
  html: 'text/html;charset=utf-8',
  json: 'application/json;charset=utf-8',
  csv: 'text/csv;charset=utf-8',
  pdf: 'application/pdf',
});

export const ARTIFACT_FAILURE_CONTRACT = Object.freeze({
  ARTIFACT_BYTES_INVALID: Object.freeze({ status: 'interrupted', hasHash: false, hasDownloadId: false }),
  ARTIFACT_HASH_FAILED: Object.freeze({ status: 'interrupted', hasHash: false, hasDownloadId: false }),
  ARTIFACT_BLOB_FAILED: Object.freeze({ status: 'interrupted', hasHash: true, hasDownloadId: false }),
  DOWNLOAD_START_TIMEOUT: Object.freeze({ status: 'timeout', hasHash: true, hasDownloadId: false }),
  DOWNLOAD_START_FAILED: Object.freeze({ status: 'interrupted', hasHash: true, hasDownloadId: false }),
  DOWNLOAD_WAIT_TIMEOUT: Object.freeze({ status: 'timeout', hasHash: true, hasDownloadId: true }),
  DOWNLOAD_INTERRUPTED: Object.freeze({ status: 'interrupted', hasHash: true, hasDownloadId: true }),
});

const FAILURE_MESSAGES = Object.freeze({
  ARTIFACT_BYTES_INVALID: format => `O artefato ${format} não pôde ser convertido em bytes seguros.`,
  ARTIFACT_HASH_FAILED: format => `O artefato ${format} não pôde ter a integridade calculada.`,
  ARTIFACT_BLOB_FAILED: format => `O artefato ${format} não pôde ser preparado para download.`,
  DOWNLOAD_START_TIMEOUT: format => `O artefato ${format} excedeu o tempo limite antes de iniciar o download.`,
  DOWNLOAD_START_FAILED: format => `O artefato ${format} não pôde iniciar o download.`,
  DOWNLOAD_WAIT_TIMEOUT: format => `O artefato ${format} não concluiu o download (tempo limite excedido).`,
  DOWNLOAD_INTERRUPTED: format => `O artefato ${format} não concluiu o download (interrompido).`,
});

export function buildArtifactBaseName(auditId, timestamp) {
  if (typeof auditId !== 'string' || !/^[A-Za-z0-9._:-]{1,160}$/u.test(auditId)) throw new TypeError('Auditoria inválida.');
  if (typeof timestamp !== 'string' || new Date(timestamp).toISOString() !== timestamp) throw new TypeError('Timestamp do relatório inválido.');
  const instant = timestamp.replace(/[-:.]/gu, '');
  const safeAuditId = auditId.replace(/[^A-Za-z0-9._-]+/gu, '-').slice(0, 160 - instant.length - 1);
  return `${safeAuditId}-${instant}`;
}

export async function bindDeliveryArtifactBaseName(baseName, ownerId, exportAttempt) {
  if (typeof baseName !== 'string' || !/^[A-Za-z0-9._-]{1,160}$/u.test(baseName) ||
    typeof ownerId !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/u.test(ownerId) ||
    !Number.isSafeInteger(exportAttempt) || exportAttempt < 1) {
    throw new TypeError('Identidade do nome de entrega inválida.');
  }
  return `${baseName}-delivery-${await deliveryToken(ownerId, exportAttempt)}`;
}

export async function downloadArtifacts(payload, adapter, options = {}) {
  validateAdapter(adapter);
  if (!payload || typeof payload.baseName !== 'string' || !/^[A-Za-z0-9._-]{1,240}$/u.test(payload.baseName)) {
    throw new TypeError('Nome-base dos artefatos inválido.');
  }
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('Timeout de download inválido.');
  const hashBytes = options.hashBytes ?? sha256Hex;
  if (typeof hashBytes !== 'function') throw new TypeError('Calculador de integridade inválido.');
  const assertCanDownload = options.assertCanDownload;
  if (assertCanDownload !== undefined && typeof assertCanDownload !== 'function') {
    throw new TypeError('Validador de exclusividade do download inválido.');
  }
  const recordDeliveryState = options.recordDeliveryState;
  if (recordDeliveryState !== undefined && typeof recordDeliveryState !== 'function') {
    throw new TypeError('Journal persistente de entrega inválido.');
  }
  const artifacts = EXPORT_FORMATS_V1.map(format => [format, payload[format]])
    .filter(([, value]) => value !== undefined && value !== null);
  const formats = [];
  const limitations = [];
  for (const [format, value] of artifacts) {
    const filename = `${payload.baseName}.${format}`;
    let bytes;
    try {
      bytes = toBytes(value);
    } catch {
      appendFailure(formats, limitations, { format, filename, failureCode: 'ARTIFACT_BYTES_INVALID' });
      continue;
    }
    let sha256;
    try {
      sha256 = await boundedOperation(
        Promise.resolve().then(() => hashBytes(bytes)),
        timeoutMs,
        'O cálculo de integridade excedeu o tempo limite.',
      );
      if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(sha256)) throw new TypeError('Hash inválido.');
    } catch {
      appendFailure(formats, limitations, { format, filename, failureCode: 'ARTIFACT_HASH_FAILED' });
      continue;
    }
    let blobUrl;
    try {
      blobUrl = adapter.createObjectURL(new Blob([bytes], { type: MIME[format] }));
      if (typeof blobUrl !== 'string' || !/^blob:/u.test(blobUrl)) throw new TypeError('Endereço temporário inválido.');
    } catch {
      appendFailure(formats, limitations, { format, filename, sha256, failureCode: 'ARTIFACT_BLOB_FAILED' });
      continue;
    }
    try {
      let deliveryFailure = null;
      let journalFailure = null;
      const assertDelivery = async stage => {
        if (!assertCanDownload) return;
        try {
          await boundedOperation(
            Promise.resolve().then(() => assertCanDownload({ format, stage })),
            timeoutMs,
            'A validação da exclusividade do download excedeu o tempo limite.',
          );
        } catch (error) {
          deliveryFailure = error;
          throw error;
        }
      };
      const recordDelivery = async entry => {
        if (!recordDeliveryState) return;
        try {
          await boundedOperation(
            Promise.resolve().then(() => recordDeliveryState(entry.state === 'terminal'
              ? { ...entry, mimeType: MIME[format], byteSize: bytes.byteLength, sha256 }
              : entry)),
            timeoutMs,
            'A atualização do journal de entrega excedeu o tempo limite.',
          );
        } catch (error) {
          journalFailure = error;
          throw error;
        }
      };
      await assertDelivery('before-start');
      await recordDelivery({ state: 'starting', format, filename });
      try {
        await assertDelivery('before-physical-start');
      } catch (error) {
        try { await recordDelivery({ state: 'cleaned', format, filename }); } catch {}
        throw error;
      }
      let downloadId;
      try {
        downloadId = await adoptDownload(adapter.download({
          url: blobUrl,
          filename,
          conflictAction: 'uniquify',
          saveAs: false,
        }), timeoutMs, async id => {
          if (!Number.isSafeInteger(id) || id < 0) return;
          const cleanup = await cleanupPhysicalDownload(adapter, id, undefined, timeoutMs);
          try {
            await recordDelivery({
              state: cleanup.removed ? 'cleaned' : 'cleanup-failed',
              format,
              filename,
              downloadId: id,
            });
          } catch {}
        });
        if (!Number.isSafeInteger(downloadId) || downloadId < 0) throw new TypeError('ID de download inválido.');
      } catch (error) {
        const timedOut = safeErrorName(error) === 'TimeoutError';
        if (!timedOut) {
          try { await recordDelivery({ state: 'cleaned', format, filename }); } catch {}
        }
        appendFailure(formats, limitations, {
          format, filename, sha256,
          failureCode: timedOut ? 'DOWNLOAD_START_TIMEOUT' : 'DOWNLOAD_START_FAILED',
        });
        continue;
      }
      try {
        await recordDelivery({ state: 'in-flight', format, filename, downloadId });
      } catch (error) {
        const cleanup = await cleanupPhysicalDownload(adapter, downloadId, undefined, timeoutMs);
        try {
          await recordDelivery({
            state: cleanup.removed ? 'cleaned' : 'cleanup-failed', format, filename, downloadId,
          });
        } catch {}
        if (!cleanup.removed) throw downloadCleanupPendingError(error);
        throw error;
      }
      const cancelWait = once(() => cancelContained(adapter, downloadId));
      const containRevokedDownload = async cause => {
        const cleanup = await cleanupPhysicalDownload(adapter, downloadId, cancelWait, timeoutMs);
        if (cleanup.removed) {
          try {
            await recordDelivery({ state: 'cleaned', format, filename, downloadId });
          } catch (error) {
            try { await recordDelivery({ state: 'cleanup-failed', format, filename, downloadId }); } catch {}
            throw downloadCleanupPendingError(cause ?? error);
          }
          return;
        }
        try {
          await recordDelivery({ state: 'cleanup-failed', format, filename, downloadId });
        } catch {}
        throw downloadCleanupPendingError(cause);
      };
      try {
        await assertDelivery('started');
      } catch (error) {
        await containRevokedDownload(error);
        throw error;
      }
      let monitor = null;
      try {
        const terminalWait = boundedDownloadWait(
          adapter.waitForDownload(downloadId, { timeoutMs }), timeoutMs, cancelWait,
        );
        monitor = assertCanDownload
          ? createDeliveryMonitor(() => assertDelivery('in-flight'), timeoutMs)
          : null;
        const terminal = await (monitor ? Promise.race([terminalWait, monitor.promise]) : terminalWait);
        if (!isCompleteTerminal(terminal, downloadId)) throw Object.assign(new Error('Download interrompido.'), { name: 'DownloadInterruptedError' });
        await recordDelivery({ state: 'terminal', format, filename, downloadId });
        await assertDelivery('terminal');
        formats.push({ format, filename, mimeType: MIME[format], byteSize: bytes.byteLength, status: 'complete', downloadId, sha256 });
      } catch (error) {
        monitor?.stop();
        monitor = null;
        if (error === deliveryFailure || error === journalFailure) {
          await containRevokedDownload(error);
          throw error;
        }
        const timedOut = safeErrorName(error) === 'TimeoutError';
        if (recordDeliveryState) {
          await containRevokedDownload(error);
        } else {
          cancelWait();
        }
        appendFailure(formats, limitations, {
          format, filename, sha256, downloadId,
          failureCode: timedOut ? 'DOWNLOAD_WAIT_TIMEOUT' : 'DOWNLOAD_INTERRUPTED',
        });
      } finally {
        monitor?.stop();
      }
    } finally {
      try { adapter.revokeObjectURL(blobUrl); } catch {
        limitations.push(artifactCleanupLimitation(format));
      }
    }
  }
  return { formats, limitations };
}

export function artifactFailureLimitation(format, failureCode) {
  if (!Object.hasOwn(MIME, format) || !Object.hasOwn(FAILURE_MESSAGES, failureCode)) {
    throw new TypeError('Código ou formato de falha de artefato inválido.');
  }
  return FAILURE_MESSAGES[failureCode](format.toUpperCase());
}

export function artifactCleanupLimitation(format) {
  if (!Object.hasOwn(MIME, format)) throw new TypeError('Formato de limpeza de artefato inválido.');
  return `A liberação do endereço temporário do artefato ${format.toUpperCase()} não pôde ser confirmada.`;
}

export function createDownloadsAdapter(chromeApi, urlApi = globalThis.URL) {
  if (!chromeApi?.downloads || !urlApi?.createObjectURL || !urlApi?.revokeObjectURL) throw new TypeError('APIs de download indisponíveis.');
  return {
    createObjectURL: blob => urlApi.createObjectURL(blob),
    revokeObjectURL: url => urlApi.revokeObjectURL(url),
    download: options => invokeChrome(chromeApi, callback => chromeApi.downloads.download(options, callback)),
    cancelDownload: downloadId => invokeChrome(chromeApi, callback => chromeApi.downloads.cancel(downloadId, callback)),
    removeDownloadFile: typeof chromeApi.downloads.removeFile === 'function'
      ? downloadId => invokeChrome(chromeApi, callback => chromeApi.downloads.removeFile(downloadId, callback))
      : undefined,
    inspectDownload: typeof chromeApi.downloads.search === 'function'
      ? downloadId => invokeChrome(chromeApi, callback => chromeApi.downloads.search({ id: downloadId }, callback))
      : undefined,
    eraseDownload: typeof chromeApi.downloads.erase === 'function'
      ? downloadId => invokeChrome(chromeApi, callback => chromeApi.downloads.erase({ id: downloadId }, callback))
      : undefined,
    findDownloadsByFilename: typeof chromeApi.downloads.search === 'function'
      ? async filename => {
          const escaped = filename.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
          const items = await invokeChrome(chromeApi, callback => chromeApi.downloads.search({
            filenameRegex: `(?:^|[\\\\/])${escaped}$`,
          }, callback));
          return Array.isArray(items)
            ? items.filter(item => Number.isSafeInteger(item?.id) && item.id >= 0).map(item => item.id)
            : [];
        }
      : undefined,
    waitForDownload(downloadId, { timeoutMs }) {
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (handler, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          chromeApi.downloads.onChanged.removeListener(listener);
          handler(value);
        };
        const listener = delta => {
          if (delta?.id !== downloadId || !delta.state?.current) return;
          if (delta.state.current === 'complete') finish(resolve, { id: downloadId, state: 'complete' });
          if (delta.state.current === 'interrupted') finish(reject, Object.assign(new Error(delta.error?.current ?? 'Download interrompido.'), { name: 'DownloadInterruptedError' }));
        };
        const timer = setTimeout(() => finish(reject, new DOMException('Download excedeu o tempo limite.', 'TimeoutError')), timeoutMs);
        chromeApi.downloads.onChanged.addListener(listener);
        invokeChrome(chromeApi, callback => chromeApi.downloads.search({ id: downloadId }, callback)).then(items => {
          const item = items?.[0];
          if (item?.state === 'complete') finish(resolve, { id: downloadId, state: 'complete' });
          else if (item?.state === 'interrupted') finish(reject, Object.assign(new Error(item.error ?? 'Download interrompido.'), { name: 'DownloadInterruptedError' }));
        }, error => finish(reject, error));
      });
    },
  };
}

export async function reconcileStaleDownloads(entries, adapter, resolveEntry, options = {}) {
  if (!Array.isArray(entries) || typeof resolveEntry !== 'function') {
    throw new TypeError('Journal de entregas pendentes inválido.');
  }
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('Timeout de limpeza inválido.');
  const resolvePersistedEntry = (entry, outcome) => boundedOperation(
    Promise.resolve().then(() => resolveEntry(entry, outcome)),
    timeoutMs,
    'A atualização do journal reconciliado excedeu o tempo limite.',
  );
  for (const entry of entries) {
    const canonical = canonicalStaleEntry(entry);
    const expectedSuffix = `-delivery-${await deliveryToken(canonical.ownerId, canonical.exportAttempt)}.${canonical.format}`;
    if (!canonical.filename.endsWith(expectedSuffix)) throw downloadCleanupPendingError();
    if (canonical.state === 'terminal') {
      try { await resolvePersistedEntry(canonical, 'cleaned'); }
      catch (error) { throw downloadCleanupPendingError(error); }
      continue;
    }
    let ids = canonical.downloadId === undefined ? [] : [canonical.downloadId];
    if (ids.length === 0) {
      const find = ownOrPrototypeMethod(adapter, 'findDownloadsByFilename');
      if (!find) throw downloadCleanupPendingError();
      let found;
      try {
        found = await boundedOperation(
          Promise.resolve().then(() => Reflect.apply(find, adapter, [canonical.filename])),
          timeoutMs,
          'A busca do download obsoleto excedeu o tempo limite.',
        );
      } catch {
        try { await resolvePersistedEntry(canonical, 'cleanup-failed'); } catch {}
        throw downloadCleanupPendingError();
      }
      if (!Array.isArray(found)) throw downloadCleanupPendingError();
      ids = found.map(value => typeof value === 'object' && value !== null ? value.id : value)
        .filter((value, index, all) => Number.isSafeInteger(value) && value >= 0 && all.indexOf(value) === index);
      if (ids.length !== 1) {
        try { await resolvePersistedEntry(canonical, 'cleanup-failed'); } catch {}
        throw downloadCleanupPendingError();
      }
    }
    try {
      for (const downloadId of ids) {
        const cleanup = await cleanupPhysicalDownload(adapter, downloadId, undefined, timeoutMs);
        if (!cleanup.removed) throw downloadCleanupPendingError();
      }
      await resolvePersistedEntry(canonical, 'cleaned');
    } catch (error) {
      try { await resolvePersistedEntry(canonical, 'cleanup-failed'); } catch {}
      if (safeErrorCode(error) === 'AUDIT_DOWNLOAD_CLEANUP_PENDING') throw error;
      throw downloadCleanupPendingError(error);
    }
  }
}

async function deliveryToken(ownerId, exportAttempt) {
  return sha256Hex(new TextEncoder().encode(`${ownerId}\u0000${exportAttempt}`));
}

function validateAdapter(adapter) {
  for (const method of ['createObjectURL', 'revokeObjectURL', 'download', 'waitForDownload']) {
    if (typeof adapter?.[method] !== 'function') throw new TypeError(`Adaptador de download sem ${method}.`);
  }
}

function toBytes(value) {
  if (typeof value === 'string') return new TextEncoder().encode(value);
  if (value instanceof ArrayBuffer) return Uint8Array.from(new Uint8Array(value));
  if (ArrayBuffer.isView(value)) return Uint8Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  throw new TypeError('Artefato precisa ser texto ou bytes.');
}

function appendFailure(formats, limitations, { format, filename, failureCode, sha256 = null, downloadId }) {
  const contract = ARTIFACT_FAILURE_CONTRACT[failureCode];
  formats.push({
    format,
    filename,
    mimeType: MIME[format],
    status: contract.status,
    ...(contract.hasDownloadId ? { downloadId } : {}),
    sha256: contract.hasHash ? sha256 : null,
    failureCode,
  });
  limitations.push(artifactFailureLimitation(format, failureCode));
}

function boundedDownloadWait(promise, timeoutMs, onTimeout) {
  let timer;
  const source = Promise.resolve(promise);
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new DOMException('O download excedeu o tempo limite.', 'TimeoutError'));
    }, timeoutMs);
  });
  return Promise.race([source, timeout]).finally(() => clearTimeout(timer));
}

function boundedOperation(promise, timeoutMs, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new DOMException(message, 'TimeoutError')), timeoutMs);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

function createDeliveryMonitor(assertDelivery, timeoutMs) {
  let timer = null;
  let stopped = false;
  let rejectMonitor;
  const intervalMs = Math.min(250, Math.max(1, Math.floor(timeoutMs / 4)));
  const promise = new Promise((_, reject) => { rejectMonitor = reject; });
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(async () => {
      try {
        await assertDelivery();
        schedule();
      } catch (error) {
        rejectMonitor(error);
      }
    }, intervalMs);
  };
  schedule();
  return {
    promise,
    stop() {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
    },
  };
}

function cancelContained(adapter, downloadId) {
  try {
    let current = adapter;
    for (let depth = 0; current && depth < 8; depth += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(current, 'cancelDownload');
      if (descriptor) {
        if (!Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function') return Promise.resolve();
        return Promise.resolve(Reflect.apply(descriptor.value, adapter, [downloadId])).catch(() => {});
      }
      current = Object.getPrototypeOf(current);
    }
  } catch {}
  return Promise.resolve();
}

function removeContained(adapter, downloadId) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(adapter, 'removeDownloadFile');
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function') return Promise.resolve();
    return Promise.resolve(Reflect.apply(descriptor.value, adapter, [downloadId])).catch(() => {});
  } catch {}
  return Promise.resolve();
}

async function cleanupPhysicalDownload(adapter, downloadId, cancelOperation, timeoutMs = 30_000) {
  try {
    await boundedOperation(
      Promise.resolve().then(() => cancelOperation ? cancelOperation() : cancelContained(adapter, downloadId)),
      timeoutMs,
      'O cancelamento do download excedeu o tempo limite.',
    );
  } catch {}
  const inspect = ownOrPrototypeMethod(adapter, 'inspectDownload');
  if (inspect) {
    let inspection;
    try {
      inspection = snapshotDownloadInspection(await boundedOperation(
        Promise.resolve().then(() => Reflect.apply(inspect, adapter, [downloadId])),
        timeoutMs,
        'A inspeção do download excedeu o tempo limite.',
      ), downloadId);
    } catch {
      return { removed: false };
    }
    if (inspection === 'interrupted-user-cancelled-absent') {
      const erase = ownOrPrototypeMethod(adapter, 'eraseDownload');
      if (!erase) return { removed: false };
      try {
        const erased = await boundedOperation(
          Promise.resolve().then(() => Reflect.apply(erase, adapter, [downloadId])),
          timeoutMs,
          'A remoção do histórico do download excedeu o tempo limite.',
        );
        if (!isExactErasure(erased, downloadId)) return { removed: false };
        const confirmed = snapshotDownloadInspection(await boundedOperation(
          Promise.resolve().then(() => Reflect.apply(inspect, adapter, [downloadId])),
          timeoutMs,
          'A confirmação da remoção do download excedeu o tempo limite.',
        ), downloadId);
        return { removed: confirmed === 'absent' };
      } catch {
        return { removed: false };
      }
    }
    if (inspection !== 'complete') return { removed: false };
  }
  const remove = ownOrPrototypeMethod(adapter, 'removeDownloadFile');
  if (!remove) return { removed: false };
  try {
    await boundedOperation(
      Promise.resolve().then(() => Reflect.apply(remove, adapter, [downloadId])),
      timeoutMs,
      'A remoção do download excedeu o tempo limite.',
    );
    return { removed: true };
  } catch {
    return { removed: false };
  }
}

function snapshotDownloadInspection(value, downloadId) {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return 'invalid';
    const length = Object.getOwnPropertyDescriptor(value, 'length');
    if (!length || !Object.hasOwn(length, 'value') || !Number.isSafeInteger(length.value) ||
      length.value < 0 || length.value > 1 || Reflect.ownKeys(value).length !== length.value + 1) return 'invalid';
    if (length.value === 0) {
      structuredClone(value);
      return 'absent';
    }
    const entry = Object.getOwnPropertyDescriptor(value, '0');
    if (!entry?.enumerable || !Object.hasOwn(entry, 'value')) return 'invalid';
    const item = entry.value;
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.getPrototypeOf(item) !== Object.prototype) return 'invalid';
    for (const key of Reflect.ownKeys(item)) {
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (typeof key !== 'string' || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return 'invalid';
    }
    const field = key => Object.getOwnPropertyDescriptor(item, key)?.value;
    if (field('id') !== downloadId) return 'invalid';
    const state = field('state');
    structuredClone(value);
    if (state === 'complete') return 'complete';
    if (state === 'interrupted' && field('error') === 'USER_CANCELED' &&
      field('canResume') === false && field('exists') === false) {
      return 'interrupted-user-cancelled-absent';
    }
    return 'invalid';
  } catch {
    return 'invalid';
  }
}

function isExactErasure(value, downloadId) {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== 2) return false;
    const length = Object.getOwnPropertyDescriptor(value, 'length');
    const entry = Object.getOwnPropertyDescriptor(value, '0');
    if (!length || !Object.hasOwn(length, 'value') || length.value !== 1 ||
      !entry?.enumerable || !Object.hasOwn(entry, 'value') || entry.value !== downloadId) return false;
    structuredClone(value);
    return true;
  } catch {
    return false;
  }
}

function ownOrPrototypeMethod(value, key) {
  try {
    let current = value;
    for (let depth = 0; current && depth < 8; depth += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor) return Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'function'
        ? descriptor.value
        : null;
      current = Object.getPrototypeOf(current);
    }
  } catch {}
  return null;
}

function canonicalStaleEntry(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError();
    const ownerId = value.ownerId;
    const exportAttempt = value.exportAttempt;
    const state = value.state;
    const format = value.format;
    const filename = value.filename;
    const downloadId = value.downloadId;
    if (typeof ownerId !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/u.test(ownerId) ||
      !Number.isSafeInteger(exportAttempt) || exportAttempt < 1 ||
      !['starting', 'in-flight', 'terminal', 'cleanup-failed'].includes(state) ||
      !Object.hasOwn(MIME, format) || typeof filename !== 'string' ||
      filename !== filename.trim() || filename.length > 240 ||
      !filename.endsWith(`.${format}`) ||
      (downloadId !== undefined && (!Number.isSafeInteger(downloadId) || downloadId < 0))) throw new TypeError();
    return { ownerId, exportAttempt, state, format, filename, ...(downloadId === undefined ? {} : { downloadId }) };
  } catch {
    throw new TypeError('Entrada do journal de entrega inválida.');
  }
}

function downloadCleanupPendingError(cause) {
  const error = new Error('Um arquivo de exportação obsoleto não pôde ter sua remoção confirmada; tente novamente.');
  error.name = 'AuditDownloadCleanupPendingError';
  error.code = 'AUDIT_DOWNLOAD_CLEANUP_PENDING';
  const code = safeErrorCode(cause);
  if (code) error.causeCode = code;
  return error;
}

function safeErrorCode(value) {
  try {
    const descriptor = value && (typeof value === 'object' || typeof value === 'function')
      ? Object.getOwnPropertyDescriptor(value, 'code')
      : null;
    return descriptor && Object.hasOwn(descriptor, 'value') &&
      ['AUDIT_REVISION_CONFLICT', 'AUDIT_EXPORT_LEASE_CONFLICT', 'AUDIT_DOWNLOAD_CLEANUP_PENDING'].includes(descriptor.value)
      ? descriptor.value
      : '';
  } catch {
    return '';
  }
}

function once(operation) {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    return operation();
  };
}

function safeErrorName(value) {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return '';
  try {
    let current = value;
    for (let depth = 0; current && depth < 8; depth += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(current, 'name');
      if (descriptor) {
        if (Object.hasOwn(descriptor, 'value')) return typeof descriptor.value === 'string' ? descriptor.value : '';
        if (current === globalThis.DOMException?.prototype && typeof descriptor.get === 'function') {
          try { return Reflect.apply(descriptor.get, value, []); } catch { return ''; }
        }
        return '';
      }
      current = Object.getPrototypeOf(current);
    }
  } catch {}
  return '';
}

function isCompleteTerminal(value, downloadId) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 2 || !keys.includes('id') || !keys.includes('state')) return false;
    const id = Object.getOwnPropertyDescriptor(value, 'id');
    const state = Object.getOwnPropertyDescriptor(value, 'state');
    if (!id?.enumerable || !state?.enumerable || !Object.hasOwn(id, 'value') || !Object.hasOwn(state, 'value') ||
      id.value !== downloadId || state.value !== 'complete') return false;
    structuredClone(value);
    return true;
  } catch {
    return false;
  }
}

function invokeChrome(chromeApi, invoke) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (handler, value) => {
      if (settled) return;
      settled = true;
      handler(value);
    };
    const callback = result => {
      const lastError = chromeApi.runtime?.lastError;
      if (lastError) settle(reject, new Error(lastError.message || 'Falha na API de downloads.'));
      else settle(resolve, result);
    };
    try {
      const result = invoke(callback);
      if (result && typeof result.then === 'function') result.then(value => settle(resolve, value), error => settle(reject, error));
    } catch (error) {
      settle(reject, error);
    }
  });
}

function adoptDownload(promise, timeoutMs, cancelLate) {
  let timedOut = false;
  let timer;
  const source = Promise.resolve(promise);
  void source.then(downloadId => {
    if (!timedOut) return;
    void Promise.resolve().then(() => cancelLate(downloadId)).catch(() => {});
  }, () => {});
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new DOMException('O início do download excedeu o tempo limite.', 'TimeoutError'));
    }, timeoutMs);
  });
  return Promise.race([source, timeout]).finally(() => clearTimeout(timer));
}
