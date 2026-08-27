import { sha256Hex } from '../core/report/hash.js';

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

export function buildArtifactBaseName(pageUrl, timestamp) {
  const url = new URL(pageUrl);
  if (!/^https?:$/u.test(url.protocol)) throw new TypeError('URL do relatório inválida.');
  if (typeof timestamp !== 'string' || new Date(timestamp).toISOString() !== timestamp) throw new TypeError('Timestamp do relatório inválido.');
  const host = url.hostname.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '').slice(0, 100) || 'auditoria';
  return `${host}-${timestamp.replace(/[-:.]/gu, '')}`;
}

export async function downloadArtifacts(payload, adapter, options = {}) {
  validateAdapter(adapter);
  if (!payload || typeof payload.baseName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]*$/u.test(payload.baseName)) {
    throw new TypeError('Nome-base dos artefatos inválido.');
  }
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('Timeout de download inválido.');
  const hashBytes = options.hashBytes ?? sha256Hex;
  if (typeof hashBytes !== 'function') throw new TypeError('Calculador de integridade inválido.');
  const artifacts = [
    ['html', payload.html],
    ['json', payload.json],
    ['csv', payload.csv],
    ['pdf', payload.pdf],
  ].filter(([, value]) => value !== undefined && value !== null);
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
      let downloadId;
      try {
        downloadId = await adoptDownload(adapter.download({
          url: blobUrl,
          filename,
          conflictAction: 'uniquify',
          saveAs: false,
        }), timeoutMs, id => Number.isSafeInteger(id) && id >= 0 ? cancelContained(adapter, id) : undefined);
        if (!Number.isSafeInteger(downloadId) || downloadId < 0) throw new TypeError('ID de download inválido.');
      } catch (error) {
        appendFailure(formats, limitations, {
          format, filename, sha256,
          failureCode: safeErrorName(error) === 'TimeoutError' ? 'DOWNLOAD_START_TIMEOUT' : 'DOWNLOAD_START_FAILED',
        });
        continue;
      }
      const cancelWait = once(() => cancelContained(adapter, downloadId));
      try {
        const terminal = await boundedDownloadWait(
          adapter.waitForDownload(downloadId, { timeoutMs }),
          timeoutMs,
          cancelWait,
        );
        if (!isCompleteTerminal(terminal, downloadId)) throw Object.assign(new Error('Download interrompido.'), { name: 'DownloadInterruptedError' });
        formats.push({ format, filename, mimeType: MIME[format], status: 'complete', downloadId, sha256 });
      } catch (error) {
        const timedOut = safeErrorName(error) === 'TimeoutError';
        if (timedOut) cancelWait();
        appendFailure(formats, limitations, {
          format, filename, sha256, downloadId,
          failureCode: timedOut ? 'DOWNLOAD_WAIT_TIMEOUT' : 'DOWNLOAD_INTERRUPTED',
        });
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

function cancelContained(adapter, downloadId) {
  try {
    let current = adapter;
    for (let depth = 0; current && depth < 8; depth += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(current, 'cancelDownload');
      if (descriptor) {
        if (!Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function') return;
        void Promise.resolve(Reflect.apply(descriptor.value, adapter, [downloadId])).catch(() => {});
        return;
      }
      current = Object.getPrototypeOf(current);
    }
  } catch {}
}

function once(operation) {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    operation();
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
