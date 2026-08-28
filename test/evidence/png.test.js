import assert from 'node:assert/strict';
import test from 'node:test';
import { deflateSync } from 'node:zlib';

import {
  decodePngDataUrl,
  parsePngBytes,
  pngDataUrlDecodedByteLength,
  validatePngRasterData,
} from '../../src/core/evidence/png.js';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const PNG_SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data = new Uint8Array()) {
  const typeBytes = new TextEncoder().encode(type);
  const output = new Uint8Array(12 + data.length);
  const view = new DataView(output.buffer);
  view.setUint32(0, data.length);
  output.set(typeBytes, 4);
  output.set(data, 8);
  view.setUint32(8 + data.length, crc32(output.subarray(4, 8 + data.length)));
  return output;
}

function concatenate(...parts) {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function buildPng({
  width = 1,
  height = 1,
  bitDepth = 8,
  colorType = 6,
  interlace = 0,
  raster = Uint8Array.from([0, 0, 0, 0, 0]),
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
  return concatenate(
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    ...beforeIdat,
    chunk('IDAT', deflateSync(raster)),
    ...afterIdat,
    chunk('IEND'),
  );
}

test('decodes a canonical PNG data URL and reports checked dimensions', () => {
  const result = decodePngDataUrl(PNG, { maxBytes: 1024, maxPixels: 4, maxDimension: 2 });

  assert.equal(result.width, 1);
  assert.equal(result.height, 1);
  assert.equal(result.bytes.length, 68);
  assert.equal(pngDataUrlDecodedByteLength(PNG), 68);
});

test('rejects malformed base64, CRC changes, trailing bytes and oversized limits', () => {
  assert.throws(() => decodePngDataUrl('data:image/png;base64,%%%%'), /base64 PNG/u);

  const { bytes } = decodePngDataUrl(PNG);
  const badCrc = bytes.slice();
  badCrc[29] ^= 1;
  assert.throws(() => parsePngBytes(badCrc), /CRC PNG/u);

  const trailing = new Uint8Array(bytes.length + 1);
  trailing.set(bytes);
  assert.throws(() => parsePngBytes(trailing), /IEND PNG/u);

  assert.throws(() => decodePngDataUrl(PNG, { maxPixels: 0 }), /limites PNG/u);
  assert.throws(() => decodePngDataUrl(PNG, { maxBytes: 32 }), /limites PNG/u);
});

test('rejects an oversized base64 payload before allocating decoded bytes', () => {
  const originalAtob = globalThis.atob;
  let decodeCalls = 0;
  globalThis.atob = value => { decodeCalls += 1; return originalAtob(value); };
  try {
    const oversized = `data:image/png;base64,${Buffer.alloc(256).toString('base64')}`;
    assert.throws(() => decodePngDataUrl(oversized, { maxBytes: 68 }), /limite|grande|bytes/iu);
    assert.equal(decodeCalls, 0);
  } finally {
    globalThis.atob = originalAtob;
  }
});

test('rejects unknown critical PNG chunks even when their CRC is valid', () => {
  const bytes = buildPng({ beforeIdat: [chunk('ABCD')] });

  assert.throws(() => parsePngBytes(bytes), /crítico|ABCD/iu);
});

test('requires PLTE for indexed PNG and limits its entries to the declared bit depth', () => {
  const withoutPalette = buildPng({ bitDepth: 1, colorType: 3, raster: Uint8Array.from([0, 0]) });
  const tooManyEntries = buildPng({
    bitDepth: 1,
    colorType: 3,
    raster: Uint8Array.from([0, 0]),
    beforeIdat: [chunk('PLTE', new Uint8Array(9))],
  });

  assert.throws(() => parsePngBytes(withoutPalette), /PLTE|paleta/iu);
  assert.throws(() => parsePngBytes(tooManyEntries), /PLTE|paleta/iu);
});

test('rejects PLTE in grayscale PNG and after the first IDAT chunk', () => {
  const palette = chunk('PLTE', Uint8Array.from([0, 0, 0]));
  const grayscaleWithPalette = buildPng({
    bitDepth: 8,
    colorType: 0,
    raster: Uint8Array.from([0, 0]),
    beforeIdat: [palette],
  });
  const paletteAfterIdat = buildPng({ afterIdat: [palette] });

  assert.throws(() => parsePngBytes(grayscaleWithPalette), /PLTE|paleta/iu);
  assert.throws(() => parsePngBytes(paletteAfterIdat), /PLTE|paleta|IDAT/iu);
});

test('validates the exact inflated scanline size and filter bytes', async () => {
  const valid = buildPng();
  const invalidFilter = buildPng({ raster: Uint8Array.from([5, 0, 0, 0, 0]) });
  const truncated = buildPng({ raster: Uint8Array.from([0, 0]) });

  assert.deepEqual(await validatePngRasterData(valid), { width: 1, height: 1 });
  await assert.rejects(validatePngRasterData(invalidFilter), /filtro PNG/iu);
  await assert.rejects(validatePngRasterData(truncated), /raster|scanline|tamanho/iu);
});

test('stops an inflate bomb whose raster exceeds the exact IHDR footprint', async () => {
  const bomb = buildPng({ raster: new Uint8Array(10 * 1024 * 1024) });

  await assert.rejects(
    validatePngRasterData(bomb, { maxInflatedBytes: 1024 }),
    /excede[^.]*IHDR|IHDR[^.]*excede|tamanho[^.]*IHDR/iu,
  );
});

test('cancels the active inflate reader when its AbortSignal is aborted', async () => {
  const controller = new AbortController();
  const bomb = buildPng({ raster: new Uint8Array(10 * 1024 * 1024) });
  const validation = validatePngRasterData(bomb, { maxInflatedBytes: 1024, signal: controller.signal });
  controller.abort(new DOMException('cancelado', 'AbortError'));

  await assert.rejects(validation, error => error?.name === 'AbortError');
});

test('contains an asynchronous rejection from the active reader cancellation', async () => {
  const OriginalDecompressionStream = globalThis.DecompressionStream;
  let unhandled;
  const onUnhandled = reason => { unhandled = reason; };
  process.on('unhandledRejection', onUnhandled);
  globalThis.DecompressionStream = class {
    constructor() {
      this.readable = new ReadableStream({
        pull() { return new Promise(() => {}); },
        cancel() { return Promise.reject(new Error('cancel-failed')); },
      });
      this.writable = new WritableStream({ write() {}, close() {} });
    }
  };
  try {
    const controller = new AbortController();
    const validation = validatePngRasterData(buildPng(), { signal: controller.signal });
    await Promise.resolve();
    controller.abort(new DOMException('cancelado', 'AbortError'));

    await assert.rejects(validation, error => error?.name === 'AbortError');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(unhandled, undefined);
  } finally {
    globalThis.DecompressionStream = OriginalDecompressionStream;
    process.removeListener('unhandledRejection', onUnhandled);
  }
});
