import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decodePngDataUrl,
  parsePngBytes,
  pngDataUrlDecodedByteLength,
  validatePngRasterData,
} from '../../src/core/evidence/png.js';
import { buildPng, pngChunk as chunk } from '../support/png-fixture.js';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

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
  const originalFromBase64 = Uint8Array.fromBase64;
  const originalAtob = globalThis.atob;
  let decodeCalls = 0;
  const count = () => { decodeCalls += 1; };
  Uint8Array.fromBase64 = function counted(value, options) { count(); return originalFromBase64.call(this, value, options); };
  globalThis.atob = value => { count(); return originalAtob(value); };
  try {
    const oversized = `data:image/png;base64,${Buffer.alloc(256).toString('base64')}`;
    assert.throws(() => decodePngDataUrl(oversized, { maxBytes: 68 }), /limite|grande|bytes/iu);
    assert.equal(decodeCalls, 0);
  } finally {
    Uint8Array.fromBase64 = originalFromBase64;
    globalThis.atob = originalAtob;
  }
});

test('keeps the base64 canonicity contract after the fast decode path', () => {
  const payload = PNG.slice('data:image/png;base64,'.length);
  const head = payload.slice(0, 4);
  const tail = payload.slice(4);

  // '=' no meio, alfabeto url-safe, espaço em branco e nova linha continuam rejeitados como base64.
  for (const broken of [
    `data:image/png;base64,${head.replace('i', '=')}${tail}`,
    `data:image/png;base64,${payload.slice(0, 4)}${payload.slice(4, 5) === 'A' ? '-' : '_'}${payload.slice(5)}`,
    `data:image/png;base64,${head} ${tail}`,
    `data:image/png;base64,${head}\n${tail}`,
  ]) {
    assert.throws(() => decodePngDataUrl(broken), /base64 PNG/u, broken.slice(0, 40));
  }

  // Preenchimento alterado: continua rejeitado, pela canonicidade ou pelo formato PNG, nunca aceito.
  for (const broken of [
    `data:image/png;base64,${payload.slice(0, -1)}A`,
    `data:image/png;base64,${payload.slice(0, -2)}==`,
    `data:image/png;base64,${payload.slice(0, -1)}`,
  ]) {
    assert.throws(() => decodePngDataUrl(broken), TypeError, broken.slice(0, 40));
  }

  // Bits residuais não nulos no último quarteto: os mesmos bytes decodificados, mas codificação não
  // canônica. O PNG (68 bytes, resto 2) termina em um '=' e o caractere anterior carrega 2 bits livres.
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const spareIndex = payload.length - 2;
  const spareValue = alphabet.indexOf(payload[spareIndex]);
  assert.ok(spareValue >= 0 && spareValue % 4 === 0 && payload.endsWith('='));
  for (const delta of [1, 2, 3]) {
    const tampered = `${payload.slice(0, spareIndex)}${alphabet[spareValue + delta]}${payload.slice(spareIndex + 1)}`;
    assert.throws(() => decodePngDataUrl(`data:image/png;base64,${tampered}`), /base64 PNG/u, `delta ${delta}`);
  }
});

test('the fallback base64 path (sem codificador nativo) produz o mesmo resultado', async () => {
  const payloads = [
    PNG,
    `data:image/png;base64,${Buffer.from(buildPng()).toString('base64')}`,
    `data:image/png;base64,${Buffer.from(new Uint8Array([137, 80, 78, 71])).toString('base64')}`,
    'data:image/png;base64,%%%%',
    `data:image/png;base64,${PNG.slice('data:image/png;base64,'.length, -1)}A`,
  ];
  const native = await import('../../src/core/evidence/png.js');
  const originalFromBase64 = Uint8Array.fromBase64;
  const originalToBase64 = Uint8Array.prototype.toBase64;
  delete Uint8Array.fromBase64;
  delete Uint8Array.prototype.toBase64;
  let fallback;
  try {
    fallback = await import('../../src/core/evidence/png.js?sem-nativo');
  } finally {
    Uint8Array.fromBase64 = originalFromBase64;
    Uint8Array.prototype.toBase64 = originalToBase64;
  }

  for (const payload of payloads) {
    const attempt = module => {
      try { return { ok: true, bytes: Buffer.from(module.decodePngDataUrl(payload).bytes).toString('hex') }; }
      catch (error) { return { ok: false, message: error.message }; }
    };
    assert.deepEqual(attempt(fallback), attempt(native), payload.slice(0, 40));
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

test('a full-page capture larger than 8 MB of base64 is decoded without exhausting the stack', async () => {
  // A regex com grupo repetido estourava a pilha do V8 a partir de ~8 MB de base64 e derrubava a
  // auditoria de páginas altas em Evidência completa (1.1.55). A captura abaixo tem ~10 MB de base64.
  const { randomFillSync } = await import('node:crypto');
  const width = 1280;
  const height = 1500;
  const raster = new Uint8Array((width * 4 + 1) * height);
  randomFillSync(raster);
  for (let row = 0; row < height; row += 1) raster[row * (width * 4 + 1)] = 0;
  const bytes = buildPng({ width, height, raster });
  const dataUrl = `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;
  assert.ok(dataUrl.length > 8 * 1024 * 1024, `fixture pequena demais: ${dataUrl.length}`);
  assert.equal(pngDataUrlDecodedByteLength(dataUrl), bytes.length);
  const decoded = decodePngDataUrl(dataUrl);
  assert.equal(decoded.width, width);
  assert.equal(decoded.height, height);
  await validatePngRasterData(decoded.bytes);
});
