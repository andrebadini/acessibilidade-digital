import { sha256Hex } from '../core/report/hash.js';

const MIME = Object.freeze({
  html: 'text/html;charset=utf-8',
  json: 'application/json;charset=utf-8',
  csv: 'text/csv;charset=utf-8',
  pdf: 'application/pdf',
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
  const artifacts = [
    ['html', payload.html],
    ['json', payload.json],
    ['csv', payload.csv],
    ['pdf', payload.pdf],
  ].filter(([, value]) => value !== undefined && value !== null);
  const formats = [];
  const limitations = [];
  for (const [format, value] of artifacts) {
    const bytes = toBytes(value);
    const filename = `${payload.baseName}.${format}`;
    const sha256 = await sha256Hex(bytes);
    let blobUrl;
    try {
      blobUrl = adapter.createObjectURL(new Blob([bytes], { type: MIME[format] }));
    } catch {
      formats.push({ format, filename, mimeType: MIME[format], status: 'interrupted', sha256 });
      limitations.push(`O artefato ${format.toUpperCase()} não pôde ser preparado para download.`);
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
        }), timeoutMs, id => adapter.cancelDownload?.(id));
        if (!Number.isSafeInteger(downloadId) || downloadId < 0) throw new TypeError('ID de download inválido.');
      } catch (error) {
        const status = error?.name === 'TimeoutError' ? 'timeout' : 'interrupted';
        formats.push({ format, filename, mimeType: MIME[format], status, sha256 });
        limitations.push(status === 'timeout'
          ? `O artefato ${format.toUpperCase()} excedeu o tempo limite antes de iniciar o download.`
          : `O artefato ${format.toUpperCase()} não pôde iniciar o download.`);
        continue;
      }
      try {
        const terminal = await adapter.waitForDownload(downloadId, { timeoutMs });
        if (terminal?.state !== 'complete') throw Object.assign(new Error('Download interrompido.'), { name: 'DownloadInterruptedError' });
        formats.push({ format, filename, mimeType: MIME[format], status: 'complete', downloadId, sha256 });
      } catch (error) {
        const status = error?.name === 'TimeoutError' ? 'timeout' : 'interrupted';
        formats.push({ format, filename, mimeType: MIME[format], status, downloadId, sha256 });
        limitations.push(`O artefato ${format.toUpperCase()} não concluiu o download (${status === 'timeout' ? 'tempo limite excedido' : 'interrompido'}).`);
      }
    } finally {
      try { adapter.revokeObjectURL(blobUrl); } catch {
        limitations.push(`A liberação do endereço temporário do artefato ${format.toUpperCase()} não pôde ser confirmada.`);
      }
    }
  }
  return { formats, limitations };
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
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError('Artefato precisa ser texto ou bytes.');
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
