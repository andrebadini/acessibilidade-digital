const PNG_PREFIX = 'data:image/png;base64,';
const PNG_SIGNATURE = Object.freeze([137, 80, 78, 71, 13, 10, 26, 10]);
const DEFAULT_LIMITS = Object.freeze({
  maxBytes: 64 * 1024 * 1024,
  maxDimension: 100_000,
  maxPixels: 268_435_456,
});
const DEFAULT_MAX_INFLATED_BYTES = 256 * 1024 * 1024;
const CRITICAL_CHUNKS = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND']);
const CHANNELS_BY_COLOR_TYPE = Object.freeze({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 });
const ADAM7_PASSES = Object.freeze([
  Object.freeze({ x: 0, y: 0, dx: 8, dy: 8 }),
  Object.freeze({ x: 4, y: 0, dx: 8, dy: 8 }),
  Object.freeze({ x: 0, y: 4, dx: 4, dy: 8 }),
  Object.freeze({ x: 2, y: 0, dx: 4, dy: 4 }),
  Object.freeze({ x: 0, y: 2, dx: 2, dy: 4 }),
  Object.freeze({ x: 1, y: 0, dx: 2, dy: 2 }),
  Object.freeze({ x: 0, y: 1, dx: 1, dy: 2 }),
]);
const CRC_TABLE = makeCrcTable();

function abortReason(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  return new DOMException('Operação cancelada.', 'AbortError');
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortReason(signal);
}

function normalizedLimits(input = {}) {
  const limits = { ...DEFAULT_LIMITS, ...input };
  if (!Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 57 ||
    !Number.isSafeInteger(limits.maxDimension) || limits.maxDimension < 1 ||
    !Number.isSafeInteger(limits.maxPixels) || limits.maxPixels < 1) {
    throw new TypeError('Os limites PNG são inválidos.');
  }
  return limits;
}

function decodeBase64(encoded, maxBytes) {
  const decodedLength = canonicalBase64DecodedLength(encoded);
  if (decodedLength > maxBytes) {
    throw new TypeError('A captura PNG excede o limite local de bytes.');
  }
  let binary;
  try { binary = atob(encoded); } catch { throw new TypeError('A captura não contém base64 PNG canônico.'); }
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  const canonical = bytesToBase64(bytes);
  if (canonical !== encoded) throw new TypeError('A captura não contém base64 PNG canônico.');
  return bytes;
}

export function canonicalBase64DecodedLength(encoded) {
  if (typeof encoded !== 'string' || !encoded || encoded.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) {
    throw new TypeError('A captura não contém base64 PNG canônico.');
  }
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  return encoded.length / 4 * 3 - padding;
}

export function pngDataUrlDecodedByteLength(value) {
  if (typeof value !== 'string' || !value.startsWith(PNG_PREFIX)) {
    throw new TypeError('A captura não é um data URL PNG local.');
  }
  return canonicalBase64DecodedLength(value.slice(PNG_PREFIX.length));
}

export function bytesToBase64(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('Bytes PNG inválidos.');
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + chunkSize)));
  }
  return btoa(binary);
}

export function pngDataUrlFromBytes(bytes) {
  return `${PNG_PREFIX}${bytesToBase64(bytes)}`;
}

export function decodePngDataUrl(value, limits = {}) {
  if (typeof value !== 'string' || !value.startsWith(PNG_PREFIX)) {
    throw new TypeError('A captura não é um data URL PNG local.');
  }
  const normalized = normalizedLimits(limits);
  const bytes = decodeBase64(value.slice(PNG_PREFIX.length), normalized.maxBytes);
  const metadata = parsePngBytes(bytes, normalized);
  return { bytes, ...metadata };
}

export function parsePngBytes(bytes, inputLimits = {}) {
  const limits = normalizedLimits(inputLimits);
  const metadata = inspectPngBytes(bytes, limits);
  return { width: metadata.width, height: metadata.height };
}

function inspectPngBytes(bytes, limits) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 57 || bytes.length > limits.maxBytes ||
    !PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) {
    throw new TypeError('Estrutura PNG inválida ou fora dos limites.');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = PNG_SIGNATURE.length;
  let chunkIndex = 0;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let sawIdat = false;
  let endedIdat = false;
  let sawPalette = false;
  let idatBytes = 0;
  while (offset < bytes.length) {
    if (bytes.length - offset < 12) throw new TypeError('Chunk PNG truncado.');
    const length = view.getUint32(offset);
    if (length > bytes.length - offset - 12) throw new TypeError('Comprimento de chunk PNG excede o buffer.');
    const typeStart = offset + 4;
    const dataStart = offset + 8;
    const crcOffset = dataStart + length;
    const typeBytes = bytes.subarray(typeStart, dataStart);
    if (![...typeBytes].every(byte => (byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122))) {
      throw new TypeError('Tipo de chunk PNG inválido.');
    }
    const type = String.fromCharCode(...typeBytes);
    if (crc32(bytes.subarray(typeStart, crcOffset)) !== view.getUint32(crcOffset)) {
      throw new TypeError(`CRC PNG inválido no chunk ${type}.`);
    }
    if (typeBytes[2] < 65 || typeBytes[2] > 90) {
      throw new TypeError(`Bit reservado inválido no tipo de chunk PNG ${type}.`);
    }
    if (typeBytes[0] >= 65 && typeBytes[0] <= 90 && !CRITICAL_CHUNKS.has(type)) {
      throw new TypeError(`Chunk crítico PNG desconhecido: ${type}.`);
    }
    if (chunkIndex === 0) {
      if (type !== 'IHDR' || length !== 13) throw new TypeError('IHDR deve ser o primeiro chunk PNG e conter 13 bytes.');
      width = view.getUint32(dataStart);
      height = view.getUint32(dataStart + 4);
      bitDepth = bytes[dataStart + 8];
      colorType = bytes[dataStart + 9];
      interlace = bytes[dataStart + 12];
      const allowedDepths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!width || !height || width > limits.maxDimension || height > limits.maxDimension ||
        width * height > limits.maxPixels || !allowedDepths[colorType]?.includes(bitDepth) ||
        bytes[dataStart + 10] !== 0 || bytes[dataStart + 11] !== 0 || ![0, 1].includes(interlace)) {
        throw new TypeError('IHDR PNG contém dimensões ou parâmetros inválidos.');
      }
    } else if (type === 'IHDR') throw new TypeError('PNG contém mais de um IHDR.');
    if (type === 'PLTE') {
      const entries = length / 3;
      if (sawPalette || sawIdat || length < 3 || length > 768 || !Number.isInteger(entries) ||
        colorType === 0 || colorType === 4 || (colorType === 3 && entries > 2 ** bitDepth)) {
        throw new TypeError('Chunk PLTE PNG inválido, incompatível ou fora de ordem.');
      }
      sawPalette = true;
    } else if (type === 'IDAT') {
      if (endedIdat) throw new TypeError('Chunks IDAT PNG devem ser consecutivos.');
      if (colorType === 3 && !sawPalette) throw new TypeError('PNG indexado requer PLTE antes do primeiro IDAT.');
      sawIdat = true;
      idatBytes += length;
    } else if (sawIdat && type !== 'IEND') endedIdat = true;
    offset = crcOffset + 4;
    chunkIndex += 1;
    if (type === 'IEND') {
      if (length !== 0 || !sawIdat || idatBytes === 0 || offset !== bytes.length) {
        throw new TypeError('IEND PNG inválido, prematuro ou seguido por dados.');
      }
      return { width, height, bitDepth, colorType, interlace, idatBytes };
    }
  }
  throw new TypeError('PNG sem IEND final.');
}

export async function validatePngRasterData(bytes, inputLimits = {}) {
  const signal = inputLimits.signal;
  throwIfAborted(signal);
  const limits = normalizedLimits(inputLimits);
  const maxInflatedBytes = inputLimits.maxInflatedBytes ?? DEFAULT_MAX_INFLATED_BYTES;
  if (!Number.isSafeInteger(maxInflatedBytes) || maxInflatedBytes < 1) {
    throw new TypeError('O limite raster PNG é inválido.');
  }
  const metadata = inspectPngBytes(bytes, limits);
  const scanlines = scanlineLayout(metadata);
  if (scanlines.inflatedBytes > maxInflatedBytes) {
    throw new TypeError('O tamanho raster declarado no IHDR excede o limite local descompactado.');
  }
  if (typeof DecompressionStream !== 'function' || typeof ReadableStream !== 'function') {
    throw new TypeError('Validação raster PNG indisponível neste ambiente.');
  }

  const compressed = extractIdatBytes(bytes, metadata.idatBytes);
  throwIfAborted(signal);
  const source = new ReadableStream({
    start(controller) {
      controller.enqueue(compressed);
      controller.close();
    },
  });
  let reader;
  let onAbort;
  try {
    reader = source.pipeThrough(new DecompressionStream('deflate')).getReader();
    onAbort = () => {
      try { void Promise.resolve(reader.cancel(abortReason(signal))).catch(() => {}); } catch { /* reader already closed */ }
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });
    throwIfAborted(signal);
    await validateInflatedScanlines(reader, scanlines);
    throwIfAborted(signal);
  } catch (error) {
    if (reader) {
      try { await reader.cancel(); } catch { /* contenção já concluída */ }
    }
    if (signal?.aborted) throw abortReason(signal);
    if (error instanceof PngRasterError) throw error;
    throw new TypeError('Fluxo raster deflate PNG inválido.', { cause: error });
  } finally {
    signal?.removeEventListener?.('abort', onAbort);
    if (reader) {
      try { reader.releaseLock(); } catch { /* fluxo já encerrado */ }
    }
  }
  return { width: metadata.width, height: metadata.height };
}

class PngRasterError extends TypeError {}

function extractIdatBytes(bytes, totalBytes) {
  const output = new Uint8Array(totalBytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let inputOffset = PNG_SIGNATURE.length;
  let outputOffset = 0;
  while (inputOffset < bytes.length) {
    const length = view.getUint32(inputOffset);
    const typeStart = inputOffset + 4;
    const dataStart = inputOffset + 8;
    const type = String.fromCharCode(...bytes.subarray(typeStart, dataStart));
    if (type === 'IDAT') {
      output.set(bytes.subarray(dataStart, dataStart + length), outputOffset);
      outputOffset += length;
    }
    inputOffset = dataStart + length + 4;
  }
  return output;
}

function scanlineLayout({ width, height, bitDepth, colorType, interlace }) {
  const bitsPerPixel = bitDepth * CHANNELS_BY_COLOR_TYPE[colorType];
  const definitions = interlace === 0
    ? [{ x: 0, y: 0, dx: 1, dy: 1 }]
    : ADAM7_PASSES;
  const passes = [];
  let inflatedBytes = 0;
  for (const definition of definitions) {
    const columns = width > definition.x ? Math.ceil((width - definition.x) / definition.dx) : 0;
    const rows = height > definition.y ? Math.ceil((height - definition.y) / definition.dy) : 0;
    if (!columns || !rows) continue;
    const rowBytes = Math.ceil(columns * bitsPerPixel / 8);
    const passBytes = rows * (rowBytes + 1);
    if (!Number.isSafeInteger(passBytes) || !Number.isSafeInteger(inflatedBytes + passBytes)) {
      throw new TypeError('O tamanho raster PNG não pode ser representado com segurança.');
    }
    inflatedBytes += passBytes;
    passes.push({ rows, rowBytes });
  }
  return { passes, inflatedBytes };
}

async function validateInflatedScanlines(reader, layout) {
  let passIndex = 0;
  let rowIndex = 0;
  let rowBytesRemaining = 0;
  let expectsFilter = true;
  let inflatedBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!(value instanceof Uint8Array)) throw new PngRasterError('Fluxo raster PNG produziu bytes inválidos.');
    let offset = 0;
    while (offset < value.length) {
      if (inflatedBytes >= layout.inflatedBytes || passIndex >= layout.passes.length) {
        throw new PngRasterError('O raster PNG descompactado excede o tamanho declarado no IHDR.');
      }
      if (expectsFilter) {
        if (value[offset] > 4) throw new PngRasterError('Byte de filtro PNG inválido.');
        offset += 1;
        inflatedBytes += 1;
        rowBytesRemaining = layout.passes[passIndex].rowBytes;
        expectsFilter = false;
        continue;
      }
      const consumed = Math.min(rowBytesRemaining, value.length - offset);
      offset += consumed;
      inflatedBytes += consumed;
      rowBytesRemaining -= consumed;
      if (rowBytesRemaining === 0) {
        rowIndex += 1;
        if (rowIndex === layout.passes[passIndex].rows) {
          passIndex += 1;
          rowIndex = 0;
        }
        expectsFilter = true;
      }
    }
  }
  if (inflatedBytes !== layout.inflatedBytes || passIndex !== layout.passes.length || !expectsFilter) {
    throw new PngRasterError('O tamanho das scanlines PNG não corresponde ao IHDR.');
  }
}

function makeCrcTable() {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    table[index] = value >>> 0;
  }
  return table;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
