/**
 * Gerador de PNG válido para as suítes.
 *
 * Várias verificações precisam de uma imagem com dimensões conhecidas — a conferência entre o quadro
 * declarado na captura e o raster, por exemplo — e só um PNG de verdade, com IHDR, CRC e IEND
 * corretos, atravessa os decodificadores do projeto. Por isso mora aqui e não dentro de uma suíte.
 */
import { deflateSync } from 'node:zlib';

import { pngDataUrlFromBytes } from '../../src/core/evidence/png.js';

export const PNG_SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

const CHANNELS_BY_COLOR_TYPE = Object.freeze({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 });

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function pngChunk(type, data = new Uint8Array()) {
  const typeBytes = new TextEncoder().encode(type);
  const output = new Uint8Array(12 + data.length);
  const view = new DataView(output.buffer);
  view.setUint32(0, data.length);
  output.set(typeBytes, 4);
  output.set(data, 8);
  view.setUint32(8 + data.length, crc32(output.subarray(4, 8 + data.length)));
  return output;
}

export function concatenateBytes(...parts) {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

/** Raster de uma cor só (filtro 0 por linha), no formato que o cabeçalho descreve. */
export function blankRaster({ width = 1, height = 1, bitDepth = 8, colorType = 6 } = {}) {
  const rowBytes = Math.ceil((width * (CHANNELS_BY_COLOR_TYPE[colorType] ?? 4) * bitDepth) / 8);
  return new Uint8Array((rowBytes + 1) * height);
}

export function buildPng({
  width = 1,
  height = 1,
  bitDepth = 8,
  colorType = 6,
  interlace = 0,
  raster = blankRaster({ width, height, bitDepth, colorType }),
  beforeIdat = [],
  afterIdat = [],
} = {}) {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  ihdr[12] = interlace;
  return concatenateBytes(
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    ...beforeIdat,
    pngChunk('IDAT', deflateSync(raster)),
    ...afterIdat,
    pngChunk('IEND'),
  );
}

/** Data URL de um PNG de cor única com as dimensões pedidas. */
export function pngDataUrl(width, height, options = {}) {
  return pngDataUrlFromBytes(buildPng({ width, height, ...options }));
}
