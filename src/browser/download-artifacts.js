import { sha256Hex } from '../core/report/hash.js';
import { EXPORT_FORMATS_V1 } from '../export/export-formats.js';

const MIME = Object.freeze({
  html: 'text/html;charset=utf-8',
  json: 'application/json;charset=utf-8',
  csv: 'text/csv;charset=utf-8',
  pdf: 'application/pdf',
});
const PENDING_DOWNLOAD_OWNERSHIP = new WeakMap();

export const ARTIFACT_FAILURE_CONTRACT = Object.freeze({
  ARTIFACT_BYTES_INVALID: Object.freeze({ status: 'interrupted', hasHash: false, hasDownloadId: false }),
  ARTIFACT_HASH_FAILED: Object.freeze({ status: 'interrupted', hasHash: false, hasDownloadId: false }),
  ARTIFACT_BLOB_FAILED: Object.freeze({ status: 'interrupted', hasHash: true, hasDownloadId: false }),
  DOWNLOAD_START_TIMEOUT: Object.freeze({ status: 'timeout', hasHash: true, hasDownloadId: false }),
  DOWNLOAD_START_FAILED: Object.freeze({ status: 'interrupted', hasHash: true, hasDownloadId: false }),
  DOWNLOAD_WAIT_TIMEOUT: Object.freeze({ status: 'timeout', hasHash: true, hasDownloadId: true }),
  DOWNLOAD_INTERRUPTED: Object.freeze({ status: 'interrupted', hasHash: true, hasDownloadId: true }),
  DOWNLOAD_CANCELLED: Object.freeze({ status: 'interrupted', hasHash: true, hasDownloadId: true }),
});

const FAILURE_MESSAGES = Object.freeze({
  ARTIFACT_BYTES_INVALID: format => `O artefato ${format} não pôde ser convertido em bytes seguros.`,
  ARTIFACT_HASH_FAILED: format => `O artefato ${format} não pôde ter a integridade calculada.`,
  ARTIFACT_BLOB_FAILED: format => `O artefato ${format} não pôde ser preparado para download.`,
  DOWNLOAD_START_TIMEOUT: format => `O artefato ${format} excedeu o tempo limite antes de iniciar o download.`,
  DOWNLOAD_START_FAILED: format => `O artefato ${format} não pôde iniciar o download.`,
  DOWNLOAD_WAIT_TIMEOUT: format => `O artefato ${format} não concluiu o download (tempo limite excedido).`,
  DOWNLOAD_INTERRUPTED: format => `O artefato ${format} não concluiu o download (interrompido).`,
  DOWNLOAD_CANCELLED: format => `O download do artefato ${format} foi cancelado por você.`,
});

export function buildArtifactBaseName(auditId, timestamp) {
  if (typeof auditId !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/u.test(auditId)) throw new TypeError('Auditoria inválida.');
  if (!isCanonicalUtc(timestamp)) throw new TypeError('Timestamp do relatório inválido.');
  const instant = timestamp.replace(/[-:.]/gu, '');
  const safeAuditId = projectArtifactAuditId(auditId);
  const baseName = `audita-${safeAuditId}-${instant}`;
  if (baseName.length > 250) throw new TypeError('Nome-base dos artefatos inválido.');
  return baseName;
}

export function captureBlobLifecycle(value) {
  if (value === undefined) return null;
  try {
    if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError();
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 2 || !keys.includes('register') || !keys.includes('release')) throw new TypeError();
    const methods = {};
    for (const name of ['register', 'release']) {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function') throw new TypeError();
      const invoke = descriptor.value.bind(value);
      methods[name] = async blobUrl => {
        if (await invoke(blobUrl) !== undefined) throw new Error('BLOB_LIFECYCLE_UNCONFIRMED');
      };
    }
    return Object.freeze(methods);
  } catch { throw new TypeError('BLOB_LIFECYCLE_INVALID'); }
}

export async function downloadArtifacts(payload, adapter, options = {}) {
  validateAdapter(adapter);
  const blobLifecycle = captureBlobLifecycle(options.blobLifecycle);
  if (!payload || typeof payload.baseName !== 'string' || !/^[A-Za-z0-9._-]{1,250}$/u.test(payload.baseName)) {
    throw new TypeError('Nome-base dos artefatos inválido.');
  }
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('Timeout de download inválido.');
  // Quanto tempo a pessoa pode levar na janela "Perguntar onde salvar cada arquivo" antes de
  // o download ser encerrado. Sem esse campo, a espera do diálogo não é renovada: chamadas
  // diretas mantêm o prazo curto de sempre. A exportação passa alguns minutos.
  const dialogTimeoutMs = options.dialogTimeoutMs ?? 0;
  if (!Number.isFinite(dialogTimeoutMs) || dialogTimeoutMs < 0) throw new TypeError('Espera do diálogo de download inválida.');
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
  const resolveDownloadFilename = ownOrPrototypeMethod(adapter, 'resolveDownloadFilename');
  if (recordDeliveryState && !resolveDownloadFilename) {
    throw new TypeError('Adaptador de download sem atestação do nome real.');
  }
  const artifacts = EXPORT_FORMATS_V1.map(format => [format, payload[format]])
    .filter(([, value]) => value !== undefined && value !== null);
  const formats = [];
  const limitations = [];
  for (const [format, value] of artifacts) {
    const requestedFilename = `${payload.baseName}.${format}`;
    let filename = requestedFilename;
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
    let locallyRevoked = false;
    try {
      if (blobLifecycle) {
        const registration = Promise.resolve().then(() => blobLifecycle.register(blobUrl));
        try {
          await boundedOperation(registration, timeoutMs, 'O registro do endereço temporário excedeu o tempo limite.');
        } catch {
          // A late commit still needs cleanup, but must never start a download.
          void registration.then(() => {
            if (locallyRevoked) return blobLifecycle.release(blobUrl);
          }).catch(() => {});
          appendFailure(formats, limitations, { format, filename, sha256, failureCode: 'ARTIFACT_BLOB_FAILED' });
          continue;
        }
      }
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
        const recordedEntry = entry.state === 'terminal'
          ? { ...entry, mimeType: MIME[format], byteSize: bytes.byteLength, sha256 }
          : entry;
        const source = Promise.resolve().then(() => recordDeliveryState(recordedEntry));
        try {
          const acknowledgement = await boundedOperation(
            source,
            timeoutMs,
            'A atualização do journal de entrega excedeu o tempo limite.',
          );
          if (['cleaned', 'cleanup-failed'].includes(entry.state) && acknowledgement !== true) {
            throw downloadCleanupPendingError();
          }
        } catch (error) {
          if (entry.state === 'starting' && safeErrorName(error) === 'TimeoutError') {
            const compensation = source.then(
              () => Promise.resolve().then(() => recordDeliveryState({
                state: 'cleaned', format: entry.format, filename: entry.filename,
              })).then(acknowledgement => {
                if (acknowledgement !== true) throw downloadCleanupPendingError();
              }),
              () => undefined,
            );
            try {
              await boundedOperation(
                compensation,
                timeoutMs,
                'A compensação do journal de entrega excedeu o tempo limite.',
              );
            } catch (compensationError) {
              void compensation.catch(() => {});
              journalFailure = compensationError;
              throw downloadCleanupPendingError(compensationError, compensation);
            }
            journalFailure = error;
            throw error;
          }
          if (safeErrorName(error) === 'TimeoutError') {
            const pendingError = downloadCleanupPendingError(error, source);
            journalFailure = pendingError;
            throw pendingError;
          }
          journalFailure = error;
          throw error;
        }
      };
      await assertDelivery('before-start');
      await recordDelivery({ state: 'starting', format, filename });
      try {
        await assertDelivery('before-physical-start');
      } catch (error) {
        try { await recordDelivery({ state: 'cleaned', format, filename }); }
        catch (cleanupError) {
          let fallbackError = null;
          try { await recordDelivery({ state: 'cleanup-failed', format, filename }); }
          catch (error) { fallbackError = error; }
          throw downloadCleanupPendingError(cleanupError, undefined, fallbackError);
        }
        throw error;
      }
      let downloadId;
      let adoption;
      try {
        adoption = adoptDownload(adapter.download({
          url: blobUrl,
          filename,
          conflictAction: 'uniquify',
          saveAs: false,
        }), timeoutMs, async outcome => {
          if (outcome.status === 'rejected') {
            if (recordDeliveryState) await recordDelivery({ state: 'cleaned', format, filename });
            return;
          }
          const id = outcome.value;
          if (!Number.isSafeInteger(id) || id < 0) {
            if (recordDeliveryState) {
              await recordDelivery({ state: 'cleanup-failed', format, filename });
              throw downloadCleanupPendingError();
            }
            return;
          }
          const cleanup = await cleanupPhysicalDownload(adapter, id, undefined, timeoutMs);
          if (recordDeliveryState) {
            await recordDelivery({
              state: cleanup.removed ? 'cleaned' : 'cleanup-failed',
              format,
              filename,
              downloadId: id,
            });
          }
          if (!cleanup.removed && recordDeliveryState) throw downloadCleanupPendingError();
        });
        downloadId = await adoption.result;
        if (!Number.isSafeInteger(downloadId) || downloadId < 0) throw new TypeError('ID de download inválido.');
      } catch (error) {
        const timedOut = safeErrorName(error) === 'TimeoutError';
        if (timedOut && recordDeliveryState) {
          try {
            await boundedOperation(
              adoption.lateSettlement,
              timeoutMs,
              'A identificação tardia do download excedeu o tempo limite.',
            );
          } catch (settlementError) {
            void adoption.lateSettlement.catch(() => {});
            throw downloadCleanupPendingError(settlementError, adoption.lateSettlement);
          }
        } else if (!timedOut) {
          try {
            await recordDelivery({ state: 'cleaned', format, filename });
          } catch (cleanupError) {
            let fallbackError = null;
            try { await recordDelivery({ state: 'cleanup-failed', format, filename }); }
            catch (error) { fallbackError = error; }
            throw downloadCleanupPendingError(cleanupError, undefined, fallbackError);
          }
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
        } catch (cleanupError) {
          let fallbackError = null;
          try { await recordDelivery({ state: 'cleanup-failed', format, filename, downloadId }); }
          catch (fallback) { fallbackError = fallback; }
          throw downloadCleanupPendingError(cleanupError, undefined, fallbackError);
        }
        if (!cleanup.removed) throw downloadCleanupPendingError(error);
        throw error;
      }
      const cancelWait = once(() => cancelContained(adapter, downloadId));
      const dialogKeepAlive = createDialogKeepAlive();
      const containRevokedDownload = async cause => {
        const cleanup = await cleanupPhysicalDownload(adapter, downloadId, cancelWait, timeoutMs);
        if (cleanup.removed) {
          try {
            await recordDelivery({ state: 'cleaned', format, filename, downloadId });
          } catch (error) {
            let fallbackError = null;
            try { await recordDelivery({ state: 'cleanup-failed', format, filename, downloadId }); }
            catch (fallback) { fallbackError = fallback; }
            throw downloadCleanupPendingError(error, undefined, fallbackError);
          }
          return;
        }
        let cleanupFailure = null;
        try {
          await recordDelivery({ state: 'cleanup-failed', format, filename, downloadId });
        } catch (error) { cleanupFailure = error; }
        throw downloadCleanupPendingError(cleanupFailure ?? cause, undefined, cleanupFailure ? cause : null);
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
          adapter.waitForDownload(downloadId, {
            timeoutMs, keepWaiting: dialogKeepAlive.keepWaiting, dialogTimeoutMs,
          }),
          timeoutMs, cancelWait, dialogKeepAlive,
        );
        monitor = assertCanDownload
          ? createDeliveryMonitor(() => assertDelivery('in-flight'), timeoutMs)
          : null;
        const terminal = await (monitor ? Promise.race([terminalWait, monitor.promise]) : terminalWait);
        if (!isCompleteTerminal(terminal, downloadId)) throw Object.assign(new Error('Download interrompido.'), { name: 'DownloadInterruptedError' });
        if (resolveDownloadFilename) {
          const attested = await boundedOperation(
            Promise.resolve().then(() => Reflect.apply(resolveDownloadFilename, adapter, [downloadId, {
              requestedFilename,
              format,
            }])),
            timeoutMs,
            'A atestação do nome real do download excedeu o tempo limite.',
          );
          const actualFilename = canonicalAttestedFilename(attested, requestedFilename, format);
          if (actualFilename !== filename) {
            await recordDelivery({
              state: 'identified', format, requestedFilename, filename: actualFilename, downloadId,
            });
            filename = actualFilename;
          }
        }
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
        const cancelled = safeDownloadErrorCode(error) === 'USER_CANCELED';
        if (recordDeliveryState) {
          await containRevokedDownload(error);
        } else {
          cancelWait();
        }
        appendFailure(formats, limitations, {
          format, filename, sha256, downloadId,
          failureCode: cancelled ? 'DOWNLOAD_CANCELLED' : timedOut ? 'DOWNLOAD_WAIT_TIMEOUT' : 'DOWNLOAD_INTERRUPTED',
        });
      } finally {
        monitor?.stop();
      }
    } finally {
      try { adapter.revokeObjectURL(blobUrl); locallyRevoked = true; } catch {
        limitations.push(artifactCleanupLimitation(format));
      }
      if (locallyRevoked && blobLifecycle) {
        try {
          await boundedOperation(Promise.resolve().then(() => blobLifecycle.release(blobUrl)), timeoutMs,
            'A liberação do registro temporário excedeu o tempo limite.');
        } catch { limitations.push(artifactCleanupLimitation(format)); }
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
    resolveDownloadFilename: typeof chromeApi.downloads.search === 'function'
      ? async (downloadId, context) => canonicalDownloadSearchResult(
          await invokeChrome(chromeApi, callback => chromeApi.downloads.search({ id: downloadId }, callback)),
          downloadId,
          context,
        )
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
    waitForDownload(downloadId, { timeoutMs, keepWaiting, dialogTimeoutMs = Infinity } = {}) {
      return new Promise((resolve, reject) => {
        let settled = false;
        let timer = null;
        let poller = null;
        let dialogStartedAt = null;
        const finish = (handler, value) => {
          if (settled) return;
          settled = true;
          if (timer !== null) clearTimeout(timer);
          if (poller !== null) clearInterval(poller);
          chromeApi.downloads.onChanged.removeListener(listener);
          handler(value);
        };
        const armTimeout = (delayMs = timeoutMs) => {
          if (settled) return;
          if (timer !== null) clearTimeout(timer);
          timer = setTimeout(() => finish(reject, new DOMException('Download excedeu o tempo limite.', 'TimeoutError')), delayMs);
        };
        // Com "Perguntar onde salvar cada arquivo" ligado, o Chrome mantém o item em
        // in_progress com filename vazio enquanto o diálogo está aberto. Esse estado espera a
        // decisão da pessoa: o prazo é renovado e a espera continua até salvar ou cancelar.
        // O mesmo estado aparece quando o Chrome não consegue gravar na pasta de destino e a
        // API não os distingue; por isso a renovação tem um teto (`dialogTimeoutMs`).
        const awaitingDestination = item => item?.state === 'in_progress' && item?.filename === '';
        // O intervalo acompanha o prazo: precisa ser menor que ele para renovar a espera
        // antes de o temporizador disparar, inclusive em testes com prazo curto.
        const keepAlivePollMs = Number.isFinite(timeoutMs) && timeoutMs > 0
          ? Math.max(50, Math.min(1_000, Math.floor(timeoutMs / 3)))
          : 1_000;
        const keepDialogWaiting = item => {
          if (settled || !awaitingDestination(item)) {
            dialogStartedAt = null;
            return false;
          }
          if (dialogTimeoutMs !== Infinity && (!Number.isFinite(dialogTimeoutMs) || dialogTimeoutMs <= 0)) return false;
          if (dialogStartedAt === null) dialogStartedAt = Date.now();
          const remainingMs = dialogTimeoutMs === Infinity ? Infinity : dialogTimeoutMs - (Date.now() - dialogStartedAt);
          if (remainingMs <= 0) return false;
          armTimeout(Math.min(timeoutMs, remainingMs));
          if (typeof keepWaiting === 'function') {
            try { keepWaiting(); } catch {}
          }
          if (poller === null) poller = setInterval(inspect, keepAlivePollMs);
          return true;
        };
        const interruptedError = code => Object.assign(new Error(code || 'Download interrompido.'), {
          name: 'DownloadInterruptedError',
          downloadErrorCode: code || null,
        });
        // Chrome can emit an interruption and still finish the very same download, and it
        // finishes under a different physical name when the profile renames artifacts. The
        // durable search result is the authority, so an interruption signal is confirmed
        // before it is allowed to end the wait; a download that really stopped stays a
        // failure and the timeout still bounds the confirmation.
        const confirmInterrupted = errorCode => {
          invokeChrome(chromeApi, callback => chromeApi.downloads.search({ id: downloadId }, callback)).then(items => {
            const item = items?.[0];
            if (item?.state === 'complete') {
              finish(resolve, { id: downloadId, state: 'complete' });
              return;
            }
            if (keepDialogWaiting(item)) return;
            const code = typeof item?.error === 'string' && item.error ? item.error : errorCode;
            finish(reject, interruptedError(code));
          }, () => finish(reject, interruptedError(errorCode)));
        };
        const inspect = () => {
          invokeChrome(chromeApi, callback => chromeApi.downloads.search({ id: downloadId }, callback)).then(items => {
            const item = items?.[0];
            if (item?.state === 'complete') finish(resolve, { id: downloadId, state: 'complete' });
            else if (item?.state === 'interrupted') confirmInterrupted(item.error);
            else keepDialogWaiting(item);
          }, error => finish(reject, error));
        };
        const listener = delta => {
          if (delta?.id !== downloadId) return;
          if (delta.state?.current === 'complete') finish(resolve, { id: downloadId, state: 'complete' });
          if (delta.state?.current === 'interrupted') {
            const code = typeof delta.error?.current === 'string' ? delta.error.current : null;
            confirmInterrupted(code);
          }
          if (delta.filename?.current !== undefined || delta.state?.current === 'in_progress') inspect();
        };
        armTimeout();
        chromeApi.downloads.onChanged.addListener(listener);
        inspect();
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
  const auditId = options.auditId;
  if (entries.length > 0 && (typeof auditId !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/u.test(auditId))) {
    throw new TypeError('Auditoria do journal de entrega inválida.');
  }
  const resolvePersistedEntry = async (entry, outcome) => {
    const acknowledgement = await boundedOperation(
      Promise.resolve().then(() => resolveEntry(entry, outcome)),
      timeoutMs,
      'A atualização do journal reconciliado excedeu o tempo limite.',
    );
    if (acknowledgement !== true) throw downloadCleanupPendingError();
    return true;
  };
  for (const entry of entries) {
    const canonical = canonicalStaleEntry(entry);
    const legacyFilename = await isLegacyArtifactFilename(canonical, auditId);
    const publicFilename = isPublicArtifactFilename(canonical.filename, auditId, canonical.format) ||
      isPriorPublicArtifactFilename(canonical.filename, auditId, canonical.format);
    if (!legacyFilename && !publicFilename) throw downloadCleanupPendingError();
    if (canonical.state === 'terminal') {
      try { await resolvePersistedEntry(canonical, 'cleaned'); }
      catch (error) { throw downloadCleanupPendingError(error); }
      continue;
    }
    let ids = canonical.downloadId === undefined ? [] : [canonical.downloadId];
    if (ids.length === 0) {
      if (!legacyFilename) {
        try { await resolvePersistedEntry(canonical, 'cleanup-failed'); } catch {}
        throw downloadCleanupPendingError();
      }
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
        const recovery = await recoveryDownloadMatchesEntry(adapter, downloadId, canonical, timeoutMs);
        if (recovery === 'mismatch') {
          throw downloadCleanupPendingError();
        }
        if (recovery === 'absent') continue;
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

async function recoveryDownloadMatchesEntry(adapter, downloadId, entry, timeoutMs) {
  const inspect = ownOrPrototypeMethod(adapter, 'inspectDownload');
  if (!inspect) return 'mismatch';
  try {
    const value = await boundedOperation(
      Promise.resolve().then(() => Reflect.apply(inspect, adapter, [downloadId])),
      timeoutMs,
      'A correlação do download obsoleto excedeu o tempo limite.',
    );
    const inspection = snapshotDownloadInspection(value, downloadId);
    if (inspection === 'absent' || inspection === 'interrupted-no-destination') return 'absent';
    const actualFilename = canonicalDownloadSearchResult(value, downloadId, {
      requestedFilename: entry.filename,
      format: entry.format,
    });
    if (hasUniquifiedSuffix(entry.filename, entry.format) && actualFilename !== entry.filename) return 'mismatch';
    return 'matched';
  } catch {
    return 'mismatch';
  }
}

function hasUniquifiedSuffix(filename, format) {
  if (typeof filename !== 'string' || !Object.hasOwn(MIME, format) || !filename.endsWith(`.${format}`)) return false;
  const stem = filename.slice(0, -(format.length + 1));
  return / \([1-9]\d*\)$/u.test(stem);
}

function isPublicArtifactFilename(filename, auditId, format) {
  try {
    const prefix = `${buildArtifactBaseName(auditId, '2000-01-01T00:00:00.000Z')}`
      .replace(/20000101T000000000Z$/u, '');
    const suffix = filename.slice(prefix.length, -(format.length + 1));
    const match = /^(\d{8}T\d{9}Z)(?: \(([1-9]\d*)\))?$/u.exec(suffix);
    if (!filename.startsWith(prefix) || !match || !isCanonicalCompactUtc(match[1]) ||
      filename !== `${prefix}${suffix}.${format}`) return false;
    if (match[2] === undefined) return true;
    const uniquifyIndex = Number(match[2]);
    return Number.isSafeInteger(uniquifyIndex) && uniquifyIndex >= 1 && String(uniquifyIndex) === match[2];
  } catch {
    return false;
  }
}

function isPriorPublicArtifactFilename(filename, auditId, format) {
  try {
    if (typeof auditId !== 'string' || !/^[A-Za-z0-9._:-]{1,160}$/u.test(auditId)) return false;
    const escaped = auditId.replace(/_/gu, '_5f').replace(/:/gu, '_3a');
    if (escaped.length <= 200) return false;
    const bytes = new TextEncoder().encode(auditId);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const projected = `id64-${btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/gu, '')}`;
    const prefix = `audita-${projected}-`;
    const suffix = filename.slice(prefix.length, -(format.length + 1));
    const match = /^(\d{8}T\d{9}Z)(?: \(([1-9]\d*)\))?$/u.exec(suffix);
    if (!filename.startsWith(prefix) || !match || !isCanonicalCompactUtc(match[1]) ||
      filename !== `${prefix}${suffix}.${format}`) return false;
    if (match[2] === undefined) return true;
    const uniquifyIndex = Number(match[2]);
    return Number.isSafeInteger(uniquifyIndex) && uniquifyIndex >= 1 && String(uniquifyIndex) === match[2];
  } catch {
    return false;
  }
}

function projectArtifactAuditId(auditId) {
  const escaped = auditId.replace(/_/gu, '_5f').replace(/:/gu, '_3a');
  if (escaped.length <= 200) return escaped;
  return compactArtifactAuditId(auditId);
}

const AUDIT_ID_ALPHABET = '-.0123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';
const FILENAME_ALPHABET = '-.0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';

function compactArtifactAuditId(auditId) {
  const sourceBase = BigInt(AUDIT_ID_ALPHABET.length);
  const targetBase = BigInt(FILENAME_ALPHABET.length);
  let value = 0n;
  for (const character of auditId) {
    const digit = AUDIT_ID_ALPHABET.indexOf(character);
    if (digit < 0) throw new TypeError('Auditoria inválida.');
    value = (value * sourceBase) + BigInt(digit);
  }
  let encoded = '';
  do {
    encoded = FILENAME_ALPHABET[Number(value % targetBase)] + encoded;
    value /= targetBase;
  } while (value > 0n);
  return `__b${auditId.length}_${encoded}`;
}

function isCanonicalUtc(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function isCanonicalCompactUtc(value) {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z$/u.exec(value);
  if (!match) return false;
  return isCanonicalUtc(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.${match[7]}Z`);
}

async function isLegacyArtifactFilename(entry, auditId) {
  try {
    if (typeof auditId !== 'string' || !/^[A-Za-z0-9._:-]{1,160}$/u.test(auditId)) return false;
    const timestampLength = '20000101T000000000Z'.length;
    const projected = auditId.replace(/[^A-Za-z0-9._-]+/gu, '-')
      .slice(0, 160 - timestampLength - 1);
    const token = await deliveryToken(entry.ownerId, entry.exportAttempt);
    const prefix = `${projected}-`;
    const suffix = `-delivery-${token}.${entry.format}`;
    if (!entry.filename.startsWith(prefix) || !entry.filename.endsWith(suffix)) return false;
    const compactUtc = entry.filename.slice(prefix.length, -suffix.length);
    return isCanonicalCompactUtc(compactUtc) && entry.filename === `${prefix}${compactUtc}${suffix}`;
  } catch {
    return false;
  }
}

function canonicalDownloadSearchResult(value, downloadId, context) {
  const requestedFilename = ownData(context, 'requestedFilename');
  const format = ownData(context, 'format');
  if (!Number.isSafeInteger(downloadId) || downloadId < 0 ||
    typeof requestedFilename !== 'string' || !Object.hasOwn(MIME, format)) {
    throw new TypeError('Não foi possível atestar o nome real do download.');
  }
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
      Reflect.ownKeys(value).length !== 2) throw new TypeError();
    const length = Object.getOwnPropertyDescriptor(value, 'length');
    const entry = Object.getOwnPropertyDescriptor(value, '0');
    if (!length || !Object.hasOwn(length, 'value') || length.value !== 1 ||
      !entry?.enumerable || !Object.hasOwn(entry, 'value')) throw new TypeError();
    const item = entry.value;
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.getPrototypeOf(item) !== Object.prototype) {
      throw new TypeError();
    }
    for (const key of Reflect.ownKeys(item)) {
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (typeof key !== 'string' || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new TypeError();
    }
    if (ownData(item, 'id') !== downloadId) throw new TypeError();
    const path = ownData(item, 'filename');
    if (typeof path !== 'string' || path.length < 1 || path.length > 4_096 ||
      /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(path)) throw new TypeError();
    structuredClone(value);
    const basename = path.split(/[\\/]/u).at(-1);
    return canonicalAttestedFilename(basename, requestedFilename, format);
  } catch {
    throw new TypeError('Não foi possível atestar o nome real do download.');
  }
}

function canonicalAttestedFilename(value, requestedFilename, format) {
  if (typeof value !== 'string' || value.length < 6 || value.length > 255 || value !== value.trim() ||
    /[\\/\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value) ||
    typeof requestedFilename !== 'string' || !Object.hasOwn(MIME, format) ||
    !requestedFilename.endsWith(`.${format}`)) {
    throw new TypeError('Não foi possível atestar o nome real do download.');
  }
  const stem = requestedFilename.slice(0, -(format.length + 1));
  const escapedStem = stem.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = new RegExp(`^${escapedStem}(?: \\(([1-9]\\d*)\\))?\\.${format}$`, 'u').exec(value);
  if (!match) throw new TypeError('Não foi possível atestar o nome real do download.');
  if (match[1] !== undefined) {
    const suffix = Number(match[1]);
    if (!Number.isSafeInteger(suffix) || suffix < 1 || String(suffix) !== match[1]) {
      throw new TypeError('Não foi possível atestar o nome real do download.');
    }
  }
  return value;
}

function ownData(value, key) {
  try {
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  } catch {
    return undefined;
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

function createDialogKeepAlive() {
  let arm = null;
  return {
    bind(callback) {
      if (typeof callback === 'function') arm = callback;
    },
    keepWaiting() {
      if (arm !== null) arm();
    },
  };
}

function boundedDownloadWait(promise, timeoutMs, onTimeout, keepAlive = undefined) {
  let timer = null;
  let rejectTimeout;
  let finished = false;
  const source = Promise.resolve(promise);
  const timeout = new Promise((_, reject) => { rejectTimeout = reject; });
  const arm = () => {
    if (finished) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      if (finished) return;
      onTimeout();
      rejectTimeout(new DOMException('O download excedeu o tempo limite.', 'TimeoutError'));
    }, timeoutMs);
  };
  if (keepAlive && typeof keepAlive.bind === 'function') keepAlive.bind(arm);
  arm();
  return Promise.race([source, timeout]).finally(() => {
    finished = true;
    if (timer !== null) clearTimeout(timer);
  });
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
    if (inspection === 'interrupted-user-cancelled-absent' || inspection === 'interrupted-no-destination') {
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
    if (inspection === 'complete-absent') return { removed: true };
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
    if (state === 'complete') return field('exists') === false ? 'complete-absent' : 'complete';
    if (state === 'interrupted' && field('error') === 'USER_CANCELED' &&
      field('canResume') === false && field('exists') === false) {
      return 'interrupted-user-cancelled-absent';
    }
    // O Chrome marca exists:true só porque a entrada ainda existe; sem filename não há caminho em
    // disco, então um download interrompido antes de abrir o arquivo não pode ter deixado resíduo
    // físico — mesmo que os bytes já tenham chegado da origem, como acontece quando a pasta de
    // downloads recusa a escrita.
    if (state === 'interrupted' && field('error') === 'USER_CANCELED' &&
      field('canResume') === false && field('exists') === true && field('filename') === '') {
      return 'interrupted-no-destination';
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
      filename !== filename.trim() || filename.length > 255 ||
      !filename.endsWith(`.${format}`) ||
      (downloadId !== undefined && (!Number.isSafeInteger(downloadId) || downloadId < 0))) throw new TypeError();
    return { ownerId, exportAttempt, state, format, filename, ...(downloadId === undefined ? {} : { downloadId }) };
  } catch {
    throw new TypeError('Entrada do journal de entrega inválida.');
  }
}

export async function advancePendingDownloadOwnership(error, options = undefined) {
  let source;
  try {
    source = error && (typeof error === 'object' || typeof error === 'function')
      ? PENDING_DOWNLOAD_OWNERSHIP.get(error)
      : undefined;
  } catch {
    return 'waiting';
  }
  if (!source) return 'settled';
  const outcome = await settlePendingOwnership(source, pendingOwnershipTimeout(options));
  if (outcome === 'waiting') return 'waiting';
  try { PENDING_DOWNLOAD_OWNERSHIP.delete(error); } catch {}
  return 'settled';
}

function downloadCleanupPendingError(cause, pendingSource = undefined, ...relatedCauses) {
  const error = new Error('Um arquivo de exportação obsoleto não pôde ter sua remoção confirmada; tente novamente.');
  error.name = 'AuditDownloadCleanupPendingError';
  error.code = 'AUDIT_DOWNLOAD_CLEANUP_PENDING';
  const code = safeErrorCode(cause);
  if (code) error.causeCode = code;
  const sources = [];
  if (pendingSource !== undefined) sources.push(pendingSource);
  for (const candidate of [cause, ...relatedCauses]) {
    if (!candidate || (typeof candidate !== 'object' && typeof candidate !== 'function')) continue;
    try {
      const inherited = PENDING_DOWNLOAD_OWNERSHIP.get(candidate);
      if (inherited) sources.push(inherited);
    } catch {}
  }
  if (sources.length > 0) {
    const tracked = sources.length === 1
      ? Promise.resolve(sources[0])
      : Promise.allSettled(sources.map(source => Promise.resolve(source)));
    void tracked.catch(() => {});
    PENDING_DOWNLOAD_OWNERSHIP.set(error, tracked);
  }
  return error;
}

function pendingOwnershipTimeout(options) {
  try {
    if (options === undefined) return 5_000;
    if (!options || typeof options !== 'object' || Array.isArray(options)) return 5_000;
    const descriptor = Reflect.getOwnPropertyDescriptor(options, 'timeoutMs');
    const value = descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
    return Number.isFinite(value) && value > 0 ? value : 5_000;
  } catch {
    return 5_000;
  }
}

function settlePendingOwnership(source, timeoutMs) {
  return new Promise(resolve => {
    let settled = false;
    let timer;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    Promise.resolve(source).then(
      () => finish('settled'),
      () => finish('settled'),
    );
    timer = setTimeout(() => finish('waiting'), timeoutMs);
  });
}

function safeDownloadErrorCode(value) {
  try {
    if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return '';
    let current = value;
    for (let depth = 0; current && depth < 8; depth += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(current, 'downloadErrorCode');
      if (descriptor) {
        return Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'string' ? descriptor.value : '';
      }
      current = Object.getPrototypeOf(current);
    }
  } catch {}
  return '';
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

function adoptDownload(promise, timeoutMs, settleLate) {
  let timedOut = false;
  let timer;
  const source = Promise.resolve(promise);
  let resolveLate;
  let rejectLate;
  const lateSettlement = new Promise((resolve, reject) => {
    resolveLate = resolve;
    rejectLate = reject;
  });
  void source.then(value => {
    if (!timedOut) return;
    void Promise.resolve().then(() => settleLate({ status: 'fulfilled', value })).then(resolveLate, rejectLate);
  }, () => {
    if (!timedOut) return;
    void Promise.resolve().then(() => settleLate({ status: 'rejected' })).then(resolveLate, rejectLate);
  });
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new DOMException('O início do download excedeu o tempo limite.', 'TimeoutError'));
    }, timeoutMs);
  });
  return {
    result: Promise.race([source, timeout]).finally(() => clearTimeout(timer)),
    lateSettlement,
  };
}
