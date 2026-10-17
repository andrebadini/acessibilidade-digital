#!/usr/bin/env node
// Medição objetiva da precisão das caixas desenhadas pela extensão — medida contra a IMAGEM.
//
// A versão anterior comparava o retângulo gravado com o `getBoundingClientRect()` lido depois da
// auditoria. Isso não prova precisão de imagem: as duas medidas podem concordar entre si e ainda assim
// apontarem para outro lugar na captura integral. Esta versão mede duas coisas independentes:
//
// 1. Geometria no instante da captura. Um amostrador injetado na página registra, em lote e a cada
//    400 ms, o retângulo de TODOS os elementos (mais rolagem, largura de cliente e altura do
//    documento). O retângulo gravado no artefato é comparado com a posição real do mesmo elemento nas
//    amostras imediatamente antes e depois do instante da captura. Só valem amostras cuja largura de
//    cliente casa com a largura da imagem capturada: a captura alarga o leiaute (a barra de rolagem
//    clássica some) e comparar estados de larguras diferentes acusaria um erro que não é da caixa.
//
// 2. Pixels. Para uma amostra das caixas, o PNG da captura integral é decodificado e recortado no
//    retângulo gravado; o mesmo elemento é rolado para a área visível e fotografado. A diferença média
//    de cor entre os dois recortes diz se a caixa aponta para o conteúdo certo. O recorte no retângulo
//    medido AGORA também é comparado, o que separa "caixa no lugar errado" de "a página mudou depois
//    da captura".
//
// O roteiro também conta os elementos que ficaram SEM caixa (omitidos por falta de retângulo, frame,
// recorte, limite ou por estarem fora da imagem): caixa errada nunca deve ser trocada por caixa
// silenciosamente ausente.
//
// Uso:
//   node scripts/measure-box-precision.mjs --url https://... --viewport 1280x900 --zoom 1.25 \
//     --out qa-out/precisao --label depois
//
// O zoom é o zoom REAL do navegador (`chrome.tabs.setZoom`), aplicado antes de abrir o painel. A
// densidade de tela usa `Emulation.setDeviceMetricsOverride`. O Chrome é sempre com janela visível
// (nada de `--headless`). "misaligned" = caixa desenhada a mais de 4 px da posição real; "pixel"
// classifica a mesma caixa pelos pixels.

import { mkdir, writeFile } from 'node:fs/promises';
import { deflateSync, inflateSync } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  click, command, evaluate, launchUnpackedExtension, resolveRealChromeTestBinary, waitForValue,
} from '../test/e2e/support/real-chrome.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TOLERANCE_PX = 4;
const SAMPLE_INTERVAL_MS = 400;
const MAX_SAMPLER_FRAMES = 80;
const PIXEL_GRID = 28;
const PIXEL_ALIGNED_MAE = 12;
const PIXEL_RELATIVE_MARGIN = 10;
// Desvio mínimo de cor do recorte da tela para os pixels poderem decidir algo (ver `colorSpread`).
const PIXEL_MIN_DETAIL = 8;

function parseArguments(argv) {
  const options = {
    url: null, viewport: { width: 1280, height: 900 }, out: 'qa-out/precisao',
    deviceScaleFactor: 1, zoom: 1, pixelSamples: 12, pixels: true, label: '',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === '--url') { options.url = value; index += 1; continue; }
    if (argument === '--out') { options.out = value; index += 1; continue; }
    if (argument === '--label') { options.label = value ?? ''; index += 1; continue; }
    if (argument === '--zoom') { options.zoom = Number(value); index += 1; continue; }
    if (argument === '--device-scale-factor') { options.deviceScaleFactor = Number(value); index += 1; continue; }
    if (argument === '--pixel-samples') { options.pixelSamples = Number(value); index += 1; continue; }
    if (argument === '--no-pixels') { options.pixels = false; continue; }
    if (argument === '--save-full-image') { options.saveFullImage = true; continue; }
    if (argument === '--save-viewport') { options.saveViewport = true; continue; }
    if (argument === '--viewport') {
      const match = /^(\d+)x(\d+)$/u.exec(value ?? '');
      if (!match) throw new Error(`viewport inválido: ${value}`);
      options.viewport = { width: Number(match[1]), height: Number(match[2]) };
      index += 1;
      continue;
    }
    throw new Error(`argumento desconhecido: ${argument}`);
  }
  if (!options.url) throw new Error('--url é obrigatório');
  if (!Number.isFinite(options.zoom) || options.zoom < 0.25 || options.zoom > 4) throw new Error('--zoom fora da faixa 0,25–4');
  if (!Number.isFinite(options.deviceScaleFactor) || options.deviceScaleFactor < 0.5 || options.deviceScaleFactor > 4) {
    throw new Error('--device-scale-factor fora da faixa 0,5–4');
  }
  if (!Number.isSafeInteger(options.pixelSamples) || options.pixelSamples < 0) throw new Error('--pixel-samples inválido');
  return options;
}

function sleep(milliseconds) {
  return new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds));
}

function slugify(rawUrl) {
  const url = new URL(rawUrl);
  return `${url.hostname}${url.pathname}`.replace(/[^A-Za-z0-9._-]+/gu, '-').replace(/^[.-]+|[.-]+$/gu, '').slice(0, 80) || 'pagina';
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

// --- amostrador na página -------------------------------------------------------------------------

/**
 * Função de caminho estrutural usada nas duas pontas (amostrador e resolução do nó): `tag` e
 * `tag:nth-of-type(n)` entre irmãos da mesma tag, unidos por ` > `. Não precisa casar com o texto do
 * relatório; precisa produzir a MESMA chave para o mesmo elemento nos dois lados.
 */
const PATH_FUNCTION = `function pathOf(el) {
  const parts = [];
  let current = el;
  while (current && current.nodeType === 1) {
    const tag = current.tagName.toLowerCase();
    const parent = current.parentElement;
    if (!parent) { parts.unshift(tag); break; }
    let position = 1;
    let total = 0;
    for (const sibling of parent.children) {
      if (sibling.tagName === current.tagName) { total += 1; if (sibling === current) position = total; }
    }
    parts.unshift(total > 1 ? tag + ':nth-of-type(' + position + ')' : tag);
    current = parent;
  }
  return parts.join(' > ');
}`;

/**
 * Amostrador em memória da página. Guarda uma janela deslizante de amostras completas (os mapas só
 * precisam do entorno da captura) e devolve sempre um retângulo por caminho, para a leitura posterior
 * ser uma filtragem em lote — nunca uma ida ao navegador por elemento.
 */
const SAMPLER_START = `(() => {
  if (window.__auditaPrecisionSamplerV1?.active) return { resumed: true, frames: window.__auditaPrecisionSamplerV1.frames.length };
  const state = window.__auditaPrecisionSamplerV1 = { active: true, frames: [], timer: null, maxFrames: ${MAX_SAMPLER_FRAMES} };
  const lower = value => value.toLowerCase();
  const sample = () => {
    if (!state.active) return;
    const rects = new Map();
    const walk = (parent, prefix) => {
      const children = parent.children;
      if (!children || children.length === 0) return;
      const counts = new Map();
      for (let index = 0; index < children.length; index += 1) {
        const tag = children[index].tagName;
        counts.set(tag, (counts.get(tag) || 0) + 1);
      }
      const seen = new Map();
      for (let index = 0; index < children.length; index += 1) {
        const element = children[index];
        const tag = element.tagName;
        const position = (seen.get(tag) || 0) + 1;
        seen.set(tag, position);
        const segment = counts.get(tag) > 1 ? lower(tag) + ':nth-of-type(' + position + ')' : lower(tag);
        const path = prefix === '' ? segment : prefix + ' > ' + segment;
        let box = null;
        try { box = element.getBoundingClientRect(); } catch { box = null; }
        if (box && box.width > 0 && box.height > 0 && box.width * box.height < 1e8) {
          let parts = 1;
          try { parts = element.getClientRects().length; } catch { parts = 1; }
          rects.set(path, [box.x + window.scrollX, box.y + window.scrollY, box.width, box.height, parts]);
        }
        walk(element, path);
      }
    };
    const root = document.documentElement;
    if (root) {
      const box = root.getBoundingClientRect();
      if (box.width > 0 && box.height > 0) rects.set('html', [box.x + window.scrollX, box.y + window.scrollY, box.width, box.height, 1]);
      walk(root, 'html');
    }
    state.frames.push({
      ts: Date.now(), scrollX: window.scrollX, scrollY: window.scrollY,
      innerWidth: window.innerWidth, innerHeight: window.innerHeight,
      clientWidth: document.documentElement?.clientWidth ?? 0,
      documentHeight: document.documentElement?.scrollHeight ?? 0,
      dpr: window.devicePixelRatio || 1, rects,
    });
    if (state.frames.length > state.maxFrames) state.frames.shift();
  };
  sample();
  state.timer = setInterval(sample, ${SAMPLE_INTERVAL_MS});
  return { started: true, frames: state.frames.length };
})()`;

const SAMPLER_STATUS = `(() => {
  const state = window.__auditaPrecisionSamplerV1;
  if (!state) return { present: false, frames: 0 };
  if (!state.active) return { present: true, active: false, frames: state.frames.length };
  return { present: true, active: true, frames: state.frames.length };
})()`;

const SAMPLER_STOP = `(() => {
  const state = window.__auditaPrecisionSamplerV1;
  if (!state) return null;
  state.active = false;
  if (state.timer) clearInterval(state.timer);
  const frames = state.frames.map(frame => ({
    ts: frame.ts, scrollX: frame.scrollX, scrollY: frame.scrollY,
    innerWidth: frame.innerWidth, innerHeight: frame.innerHeight,
    clientWidth: frame.clientWidth, documentHeight: frame.documentHeight, dpr: frame.dpr,
  }));
  return { frames };
})()`;

/** Retângulos de um lote de caminhos, uma linha por caminho e uma coluna por amostra. */
const samplerRectsExpression = paths => `(() => {
  const state = window.__auditaPrecisionSamplerV1;
  if (!state) return [];
  return ${JSON.stringify(paths)}.map(path => state.frames.map(frame => frame.rects.get(path) ?? null));
})()`;

// --- painel e revisão -----------------------------------------------------------------------------

const PANEL_READY = `(() => {
  const input = document.querySelector('input[data-capture-mode="full-evidence"]');
  const button = document.querySelector('button[data-intent="START_ATTACHED"]');
  return Boolean(input && !input.disabled && button && !button.disabled);
})()`;

const PANEL_SCREEN = `(() => {
  const root = document.querySelector('[data-screen]');
  return { screen: root?.dataset.screen ?? null, auditId: root?.dataset.auditId ?? null,
    text: (document.body.innerText || '').replace(/\\s+/gu, ' ').slice(0, 300) };
})()`;

const revisionExpression = auditId => `import(chrome.runtime.getURL('/src/storage/audit-store.js')).then(module =>
  module.createAuditStore().getReportRevision(${JSON.stringify(auditId)})).then(revision => {
  if (!revision) return null;
  const evidence = revision.model?.evidence ?? [];
  const mapGeometry = artifact => artifact?.derivation?.geometry ? {
    sourceCssSize: artifact.derivation.geometry.sourceCssSize,
    sourcePixelSize: artifact.derivation.geometry.sourcePixelSize,
    scaleX: artifact.derivation.geometry.scaleX,
    scaleY: artifact.derivation.geometry.scaleY,
    deviceScaleFactor: artifact.derivation.geometry.deviceScaleFactor,
  } : null;
  const fullPage = evidence.find(item => item.kind === 'full-page' && item.state === 'pristine') ?? null;
  const annotation = evidence.find(item => item.kind === 'announcement-map') ?? null;
  const keyboard = evidence.find(item => item.kind === 'keyboard-map') ?? null;
  return {
    status: revision.model?.session?.status ?? null,
    diagnostics: (revision.model?.session?.diagnostics ?? revision.model?.diagnostics ?? []).map(item => item?.code ?? item),
    fullPage: fullPage ? {
      evidenceId: fullPage.evidenceId, width: fullPage.metadata?.width ?? null,
      height: fullPage.metadata?.height ?? null, pixelScale: fullPage.metadata?.pixelScale ?? null,
      hasPixels: typeof fullPage.dataUrl === 'string',
    } : null,
    annotation: annotation ? {
      status: annotation.status, counts: annotation.counts, limitations: annotation.limitations,
      geometry: mapGeometry(annotation),
      annotations: (annotation.derivation?.geometry?.annotations ?? []).map(entry => ({
        number: entry.number, nodeId: entry.nodeId, bounds: entry.sourceRect,
      })),
    } : null,
    keyboard: keyboard ? {
      status: keyboard.status, counts: keyboard.counts, limitations: keyboard.limitations,
      geometry: mapGeometry(keyboard),
      stops: (keyboard.stops ?? []).map(entry => ({ number: entry.number, nodeId: entry.nodeId, bounds: entry.bounds, name: entry.name })),
      suspects: (keyboard.suspects ?? []).map(entry => ({ number: entry.number, nodeId: entry.nodeId, bounds: entry.bounds })),
    } : null,
    elements: evidence.filter(item => item.kind === 'element').map(item => ({
      evidenceId: item.evidenceId, nodeId: item.nodeId ?? null,
      fullPageRect: item.fullPageRect ?? null, hasOwnPixels: typeof item.dataUrl === 'string',
      fullPageEvidenceId: item.fullPageEvidenceId ?? null,
    })),
  };
})`;

const LOAD_FULL_PAGE = auditId => `(async () => {
  const module = await import(chrome.runtime.getURL('/src/storage/audit-store.js'));
  const revision = await module.createAuditStore().getReportRevision(${JSON.stringify(auditId)});
  const artifact = (revision?.model?.evidence ?? []).find(item =>
    item.kind === 'full-page' && item.state === 'pristine' && typeof item.dataUrl === 'string');
  if (!artifact) return { length: 0, prefix: '' };
  globalThis.__auditaPrecisionFullPage = artifact.dataUrl;
  return { length: artifact.dataUrl.length, prefix: artifact.dataUrl.slice(0, 64) };
})()`;

const fullPageChunkExpression = (start, end) =>
  `(() => { const value = globalThis.__auditaPrecisionFullPage; return typeof value === 'string' ? value.slice(${start}, ${end}) : ''; })()`;

// --- PNG ------------------------------------------------------------------------------------------

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

/**
 * Decodificador PNG mínimo, suficiente para o que o Chrome produz: 8 bits por canal, sem
 * entrelaçamento, RGB/RGBA/escala de cinza/paleta. Devolve RGBA pronto para a amostragem de pixels.
 */
function decodePng(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 8 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('PNG inválido');
  }
  let offset = 8;
  let header = null;
  let palette = null;
  const data = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    if (body.length !== length) throw new Error('PNG truncado');
    if (type === 'IHDR') {
      header = {
        width: body.readUInt32BE(0), height: body.readUInt32BE(4),
        bitDepth: body[8], colorType: body[9], compression: body[10], filter: body[11], interlace: body[12],
      };
    } else if (type === 'PLTE') {
      palette = body;
    } else if (type === 'IDAT') {
      data.push(body);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  if (!header || header.bitDepth !== 8 || header.compression !== 0 || header.filter !== 0 || header.interlace !== 0) {
    throw new Error('PNG fora do subconjunto suportado');
  }
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[header.colorType];
  if (!channels || (header.colorType === 3 && !palette)) throw new Error('PNG com tipo de cor não suportado');
  const raw = inflateSync(Buffer.concat(data));
  const bpp = channels;
  const stride = header.width * bpp;
  if (raw.length < header.height * (stride + 1)) throw new Error('PNG sem dados suficientes');
  const rgba = new Uint8Array(header.width * header.height * 4);
  let previous = new Uint8Array(stride);
  let cursor = 0;
  for (let row = 0; row < header.height; row += 1) {
    const filter = raw[cursor];
    cursor += 1;
    const line = new Uint8Array(raw.subarray(cursor, cursor + stride));
    cursor += stride;
    for (let index = 0; index < stride; index += 1) {
      const left = index >= bpp ? line[index - bpp] : 0;
      const up = previous[index];
      const upLeft = index >= bpp ? previous[index - bpp] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = (left + up) >> 1;
      else if (filter === 4) {
        const estimate = left + up - upLeft;
        const leftDistance = Math.abs(estimate - left);
        const upDistance = Math.abs(estimate - up);
        const cornerDistance = Math.abs(estimate - upLeft);
        predictor = leftDistance <= upDistance && leftDistance <= cornerDistance ? left : upDistance <= cornerDistance ? up : upLeft;
      } else if (filter !== 0) throw new Error(`filtro PNG ${filter} não suportado`);
      line[index] = (line[index] + predictor) & 0xff;
    }
    previous = line;
    const rowOffset = row * header.width * 4;
    for (let column = 0; column < header.width; column += 1) {
      const source = column * bpp;
      const target = rowOffset + column * 4;
      if (header.colorType === 0) {
        rgba[target] = line[source]; rgba[target + 1] = line[source]; rgba[target + 2] = line[source]; rgba[target + 3] = 255;
      } else if (header.colorType === 4) {
        rgba[target] = line[source]; rgba[target + 1] = line[source]; rgba[target + 2] = line[source]; rgba[target + 3] = line[source + 1];
      } else if (header.colorType === 3) {
        const entry = line[source] * 3;
        rgba[target] = palette[entry] ?? 0; rgba[target + 1] = palette[entry + 1] ?? 0;
        rgba[target + 2] = palette[entry + 2] ?? 0; rgba[target + 3] = 255;
      } else if (header.colorType === 2) {
        rgba[target] = line[source]; rgba[target + 1] = line[source + 1]; rgba[target + 2] = line[source + 2]; rgba[target + 3] = 255;
      } else {
        rgba[target] = line[source]; rgba[target + 1] = line[source + 1];
        rgba[target + 2] = line[source + 2]; rgba[target + 3] = line[source + 3];
      }
    }
  }
  return { width: header.width, height: header.height, rgba };
}

function pngChunk(type, body) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length, 0);
  const name = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, body])), 0);
  return Buffer.concat([length, name, body, crc]);
}

function encodePng(width, height, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let row = 0; row < height; row += 1) {
    raw[row * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + row * stride, stride).copy(raw, row * (stride + 1) + 1);
  }
  return Buffer.concat([
    PNG_SIGNATURE, pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(raw, { level: 6 })), pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Recorte do PNG em px CSS do documento, reescalado para pixels de imagem. */
function cropPng(image, rect, scaleX, scaleY) {
  if (!image || !rect) return null;
  const left = Math.max(0, Math.floor(rect.x * scaleX));
  const top = Math.max(0, Math.floor(rect.y * scaleY));
  const right = Math.min(image.width, Math.ceil((rect.x + rect.width) * scaleX));
  const bottom = Math.min(image.height, Math.ceil((rect.y + rect.height) * scaleY));
  if (right - left < 2 || bottom - top < 2) return null;
  const width = right - left;
  const height = bottom - top;
  const rgba = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row += 1) {
    const sourceStart = ((top + row) * image.width + left) * 4;
    rgba.set(image.rgba.subarray(sourceStart, sourceStart + width * 4), row * width * 4);
  }
  return { width, height, rgba };
}

function sampleGrid(image, x, y) {
  const px = Math.min(image.width - 1, Math.max(0, Math.floor(x * image.width)));
  const py = Math.min(image.height - 1, Math.max(0, Math.floor(y * image.height)));
  const offset = (py * image.width + px) * 4;
  return [image.rgba[offset], image.rgba[offset + 1], image.rgba[offset + 2], image.rgba[offset + 3]];
}

/**
 * Quanto a imagem varia de cor na grade amostrada. Uma área chapada (fundo, espaço em branco) casa
 * com qualquer recorte parecido e produziria "alinhado" sem provar nada sobre o conteúdo; abaixo do
 * mínimo, a conferência por pixels é declarada inconclusiva em vez de mentir.
 */
function colorSpread(image) {
  if (!image) return 0;
  const values = [[], [], []];
  for (let row = 0; row < PIXEL_GRID; row += 1) {
    const y = (row + 0.5) / PIXEL_GRID;
    for (let column = 0; column < PIXEL_GRID; column += 1) {
      const pixel = sampleGrid(image, (column + 0.5) / PIXEL_GRID, y);
      if (pixel[3] < 24) continue;
      for (let channel = 0; channel < 3; channel += 1) values[channel].push(pixel[channel]);
    }
  }
  if (values[0].length < (PIXEL_GRID * PIXEL_GRID) * 0.6) return 0;
  return Math.max(...values.map(channel => {
    const mean = channel.reduce((total, value) => total + value, 0) / channel.length;
    return Math.sqrt(channel.reduce((total, value) => total + (value - mean) ** 2, 0) / channel.length);
  }));
}

/**
 * Diferença média de cor entre duas imagens, amostradas numa grade normalizada.
 *
 * `shiftX`/`shiftY` deslocam a amostragem da primeira imagem em pixels do raster. A tela fracionária
 * (1,25×, 2,5×) e a razão `largura do PNG / largura CSS` arredondada deixam o recorte gravado até um
 * pixel fora do recorte atual — em um ícone de 16 px isso muda quase todos os tons de borda e
 * produzia "caixa errada" onde o conteúdo era o mesmo. Procurar o melhor encaixe dentro de 1 px de
 * raster é honesto: meio pixel CSS é invisível e está muito abaixo da tolerância de 4 px.
 */
function meanAbsoluteError(left, right, shiftX = 0, shiftY = 0) {
  if (!left || !right) return null;
  let total = 0;
  let samples = 0;
  for (let row = 0; row < PIXEL_GRID; row += 1) {
    const y = (row + 0.5) / PIXEL_GRID;
    for (let column = 0; column < PIXEL_GRID; column += 1) {
      const x = (column + 0.5) / PIXEL_GRID;
      const a = sampleGrid(left, x + shiftX / left.width, y + shiftY / left.height);
      const b = sampleGrid(right, x, y);
      if (a[3] < 24 || b[3] < 24) continue;
      total += (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2])) / 3;
      samples += 1;
    }
  }
  return samples >= (PIXEL_GRID * PIXEL_GRID) * 0.6 ? total / samples : null;
}

/** Menor diferença média procurando o encaixe em até 2 px de raster nos dois eixos. */
function bestMeanAbsoluteError(left, right) {
  let best = null;
  for (const shiftX of [-2, -1, 0, 1, 2]) {
    for (const shiftY of [-2, -1, 0, 1, 2]) {
      const value = meanAbsoluteError(left, right, shiftX, shiftY);
      if (value !== null && (best === null || value < best)) best = value;
    }
  }
  return best;
}

// --- comparação de retângulos ---------------------------------------------------------------------

function rectClose(left, right, tolerance = 1.5) {
  return Boolean(left && right) && ['x', 'y', 'width', 'height']
    .every(key => Math.abs(left[key] - right[key]) <= tolerance);
}

function rectDistance(left, right) {
  if (!left || !right) return Infinity;
  return Math.max(
    Math.abs(left.x - right.x), Math.abs(left.y - right.y),
    Math.abs(left.width - right.width), Math.abs(left.height - right.height),
  );
}

function asRect(values) {
  return Array.isArray(values) && values.length >= 4
    ? { x: values[0], y: values[1], width: values[2], height: values[3], parts: values[4] ?? 1 }
    : null;
}

/**
 * Verdade de campo para um caminho: amostra estável imediatamente antes e depois do instante da
 * captura, entre as amostras cuja largura de cliente casa com a largura da imagem. Só o estado de
 * mesma largura descreve o leiaute que a captura mostra.
 */
function groundTruth(frames, path, captureTs, sourceWidth) {
  // A largura de cliente igual à da imagem descarta amostras de um leiaute alargado/restaurado
  // diferente. Mas a captura também pode cobrir somente a ÁREA DE CONTEÚDO, maior que a viewport
  // quando há transbordo horizontal: aí `clientWidth` nunca chega à largura da imagem. Só nesse caso
  // (imagem mais larga que toda amostra vista) a janela estável em volta do instante da captura serve
  // sem o filtro. Quando alguma amostra TEM a largura da imagem, o filtro vale: cair para o leiaute
  // com barra de rolagem compararia dois estados e chamaria de "caixa errada" uma página que só mudou
  // de largura — melhor declarar sem verdade do que inventar uma.
  const widestClient = frames.reduce((widest, frame) =>
    Number.isFinite(frame.clientWidth) ? Math.max(widest, frame.clientWidth) : widest, 0);
  const overflowFallback = sourceWidth !== null && widestClient > 0 && sourceWidth > widestClient + 2;
  const collect = strict => {
    const found = [];
    for (let index = 1; index < frames.length; index += 1) {
      const frame = frames[index];
      const previous = frames[index - 1];
      if (strict && sourceWidth !== null && Math.abs(frame.clientWidth - sourceWidth) > 2) continue;
      if (strict && sourceWidth !== null && Math.abs(previous.clientWidth - sourceWidth) > 2) continue;
      if (frame.ts - previous.ts > 1_800) continue;
      const after = frame.rects.get(path);
      const before = previous.rects.get(path);
      if (!before || !after || !rectClose(before, after, 1.0)) continue;
      found.push({ ts: frame.ts, rect: after });
    }
    return found;
  };
  let candidates = collect(true);
  if (candidates.length === 0 && overflowFallback) candidates = collect(false);
  if (candidates.length === 0) return { status: 'unresolved', rect: null, beforeTs: null, afterTs: null };
  let before = null;
  let after = null;
  for (const candidate of candidates) {
    if (candidate.ts <= captureTs) before = candidate;
    else if (after === null) after = candidate;
  }
  if (before && after && rectClose(before.rect, after.rect, 2)) {
    return { status: 'stable', rect: after.rect, beforeTs: before.ts, afterTs: after.ts, frames: candidates.length };
  }
  const only = after ?? before;
  return only
    ? { status: 'one-sided', rect: only.rect, beforeTs: before?.ts ?? null, afterTs: after?.ts ?? null, frames: candidates.length }
    : { status: 'unresolved', rect: null, beforeTs: null, afterTs: null, frames: candidates.length };
}

function clipToImage(rect, image) {
  if (!rect || !image) return null;
  const x = Math.max(0, Math.min(rect.x, image.width));
  const y = Math.max(0, Math.min(rect.y, image.height));
  const right = Math.max(x, Math.min(rect.x + rect.width, image.width));
  const bottom = Math.max(y, Math.min(rect.y + rect.height, image.height));
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

function fetchFrames(framesMeta, matrix, paths) {
  return framesMeta.map((meta, frameIndex) => {
    const rects = new Map();
    paths.forEach((path, pathIndex) => {
      const value = asRect(matrix[pathIndex]?.[frameIndex]);
      if (value) rects.set(path, value);
    });
    return { ...meta, rects };
  });
}

/** Resolve `n-<backendNodeId>` no elemento da página e no caminho estrutural correspondente. */
async function resolvePaths(page, nodeIds) {
  const backendIds = [...new Set(nodeIds.map(nodeId => Number(/^n-(\d+)$/u.exec(String(nodeId))?.[1])).filter(Number.isSafeInteger))];
  await command(page, 'DOM.enable');
  const paths = new Map();
  const objects = new Map();
  // Duas idas por nó, aceitáveis num roteiro de QA — nunca no caminho do produto.
  for (const backendNodeId of backendIds) {
    try {
      const { object } = await command(page, 'DOM.resolveNode', { backendNodeId });
      const evaluated = await command(page, 'Runtime.callFunctionOn', {
        objectId: object.objectId, returnByValue: true,
        functionDeclaration: `function() { ${PATH_FUNCTION}; return pathOf(this); }`,
      });
      if (typeof evaluated?.result?.value === 'string') {
        paths.set(`n-${backendNodeId}`, evaluated.result.value);
        objects.set(`n-${backendNodeId}`, object.objectId);
      }
    } catch { /* nó removido da página */ }
  }
  return { paths, objects };
}

function summarize(rows, type) {
  // Só a amostra ESTÁVEL (antes e depois do instante da captura, com o mesmo retângulo) prova a
  // posição no instante da captura. Amostra de um lado só, por definição, não viu a página antes E
  // depois: numa página que cresce durante a auditoria ela pode ser de um leiaute anterior, e acusar
  // a caixa por isso seria inventar um erro. Esses casos entram como "não resolvidas".
  const relevant = rows.filter(row => row.status === 'stable');
  const pixel = rows.filter(row => row.pixel);
  return {
    type,
    drawn: rows.length,
    checked: relevant.length,
    stable: relevant.length,
    oneSided: rows.filter(row => row.status === 'one-sided').length,
    misaligned: relevant.filter(row => row.misaligned).length,
    outsideImage: relevant.filter(row => row.status === 'outside-image').length,
    worstDistancePx: relevant.reduce((maximum, row) => Math.max(maximum, Number.isFinite(row.distance) ? row.distance : 0), 0),
    unresolved: rows.filter(row => ['unresolved', 'unresolved-path', 'one-sided'].includes(row.status)).length,
    pixelChecked: pixel.length,
    pixelMisaligned: pixel.filter(row => row.pixel?.verdict === 'misaligned').length,
    pixelInconclusive: pixel.filter(row => row.pixel?.verdict === 'inconclusive').length,
  };
}

// --- zoom, densidade e leitura da imagem -----------------------------------------------------------

async function waitForObservedZoom(page, expected, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  let observed = null;
  do {
    try {
      const metrics = await command(page, 'Page.getLayoutMetrics');
      observed = metrics?.cssVisualViewport?.zoom ?? metrics?.visualViewport?.zoom ?? null;
      if (typeof observed === 'number' && Math.abs(observed - expected) <= 0.02) return observed;
    } catch { /* contexto girando */ }
    await sleep(100);
  } while (Date.now() < deadline);
  return observed;
}

async function applyZoom(launch, zoom) {
  if (!(zoom > 0) || zoom === 1) return 1;
  const harness = launch.harnessPage;
  const applied = await evaluate(harness,
    `chrome.tabs.setZoom(${launch.startPage.tabId}, ${zoom}).then(() => true).catch(error => String(error))`,
    { awaitPromise: true });
  if (applied !== true) throw new Error(`setZoom falhou: ${applied}`);
  return waitForObservedZoom(launch.startPage.page, zoom);
}

/** Reproduz o leiaute alargado da captura para fotografar os elementos no MESMO estado da imagem. */
async function widenForPixelCheck(page) {
  try {
    const metrics = await command(page, 'Page.getLayoutMetrics');
    const size = metrics?.cssContentSize ?? metrics?.contentSize;
    const width = Number(size?.width);
    const height = Number(size?.height);
    if (!(width > 0) || !(height > 0)) return { ran: false, reason: 'size-unavailable' };
    await command(page, 'Page.captureScreenshot', {
      format: 'jpeg', quality: 40, captureBeyondViewport: true, fromSurface: true,
      clip: { x: 0, y: 0, width, height, scale: 0.05 },
    });
    return { ran: true };
  } catch { return { ran: false, reason: 'failed' }; }
}

async function readFullPagePng(panel, auditId) {
  const loaded = await evaluate(panel, LOAD_FULL_PAGE(auditId), { awaitPromise: true });
  const length = Number(loaded?.length ?? 0);
  if (!length) return null;
  const prefix = String(loaded.prefix ?? '');
  if (!prefix.startsWith('data:image/png;base64,')) return null;
  const chunks = [];
  const size = 6_000_000;
  for (let start = 0; start < length; start += size) {
    const chunk = await evaluate(panel, fullPageChunkExpression(start, Math.min(length, start + size)));
    if (typeof chunk !== 'string' || chunk.length === 0) throw new Error('leitura da captura integral interrompida');
    chunks.push(chunk);
  }
  const base64 = chunks.join('').slice('data:image/png;base64,'.length);
  const bytes = Buffer.from(base64, 'base64');
  return { image: decodePng(bytes), bytes };
}

function safeName(value) {
  return String(value ?? '').replace(/[^A-Za-z0-9._-]+/gu, '-').slice(0, 80) || 'item';
}

/**
 * Confere uma caixa contra os pixels da captura integral.
 *
 * `verdict`:
 * - `aligned`: o recorte no retângulo gravado é tão parecido com a fotografia do elemento quanto o
 *   recorte no retângulo medido agora.
 * - `misaligned`: o retângulo medido agora explica os pixels muito melhor do que o gravado.
 * - `inconclusive`: os dois recortes diferem do estado atual (conteúdo que mudou, animação, recorte
 *   maior que a área visível), então os pixels não decidem.
 */
async function pixelCheck(page, row, { image, imageScaleX, imageScaleY, directory, save }) {
  if (!image) return { verdict: 'skipped', reason: 'no-image' };
  if (!row.recorded || !row.truth) return { verdict: 'skipped', reason: 'no-geometry' };
  const objectId = row.objectId;
  if (!objectId) return { verdict: 'skipped', reason: 'no-element' };
  try {
    const beforeScroll = (await command(page, 'Runtime.callFunctionOn', {
      objectId, returnByValue: true,
      functionDeclaration: `function() {
        if (!this.isConnected) return null;
        const box = this.getBoundingClientRect();
        return { x: box.x + window.scrollX, y: box.y + window.scrollY };
      }`,
    }))?.result?.value;
    await command(page, 'Runtime.callFunctionOn', {
      objectId, returnByValue: true,
      functionDeclaration: 'function() { if (!this.isConnected) return false; this.scrollIntoView({ block: "center", inline: "center", behavior: "instant" }); return true; }',
    });
    await sleep(220);
    const measured = (await command(page, 'Runtime.callFunctionOn', {
      objectId, returnByValue: true,
      functionDeclaration: `function() {
        const box = this.getBoundingClientRect();
        return { connected: this.isConnected === true, x: box.x + window.scrollX, y: box.y + window.scrollY,
          width: box.width, height: box.height, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight,
          left: box.x, top: box.y, dpr: window.devicePixelRatio || 1 };
      }`,
    }))?.result?.value;
    // Cabeçalho fixo/adesivo muda de posição no documento quando a rolagem muda. A captura integral e o
    // amostrador viram esse elemento em uma rolagem; a fotografia da tela, em outra. Comparar as duas
    // posições acusaria o mapa por uma diferença que é da própria rolagem — não há o que decidir.
    if (beforeScroll && measured &&
      (Math.abs(beforeScroll.x - measured.x) > 1 || Math.abs(beforeScroll.y - measured.y) > 1)) {
      return { verdict: 'inconclusive', reason: 'position-depends-on-scroll' };
    }
    if (!measured?.connected || !(measured.width > 1) || !(measured.height > 1)) return { verdict: 'skipped', reason: 'element-gone' };
    if (measured.left < -1 || measured.top < -1 ||
      measured.left + measured.width > measured.viewportWidth + 1 ||
      measured.top + measured.height > measured.viewportHeight + 1) {
      return { verdict: 'skipped', reason: 'larger-than-viewport' };
    }
    // Fotografa a área visível inteira e recorta em Node. O clip do CDP é interpretado no espaço do
    // documento e, com zoom, misturar as duas convenções produzia um recorte em branco; a área visível
    // não tem essa ambiguidade — o retângulo do elemento é relativo a ela por definição.
    const screenshot = await command(page, 'Page.captureScreenshot', {
      format: 'png', captureBeyondViewport: false, fromSurface: true,
    });
    if (typeof screenshot?.data !== 'string') return { verdict: 'skipped', reason: 'no-screenshot' };
    const viewport = decodePng(Buffer.from(screenshot.data, 'base64'));
    const shotScaleX = viewport.width / measured.viewportWidth;
    const shotScaleY = viewport.height / measured.viewportHeight;
    const shot = cropPng(viewport, {
      x: measured.left, y: measured.top, width: measured.width, height: measured.height,
    }, shotScaleX, shotScaleY);
    if (!shot) return { verdict: 'skipped', reason: 'screenshot-crop-empty' };

    const recordedCrop = cropPng(image, row.recorded, imageScaleX, imageScaleY);
    const truthRect = { x: measured.x, y: measured.y, width: measured.width, height: measured.height };
    const truthCrop = cropPng(image, truthRect, imageScaleX, imageScaleY);
    const recordedMae = bestMeanAbsoluteError(recordedCrop, shot);
    const truthMae = bestMeanAbsoluteError(truthCrop, shot);
    const detail = colorSpread(shot);
    let verdict = 'inconclusive';
    if (detail >= PIXEL_MIN_DETAIL) {
      if (recordedMae !== null && truthMae !== null) {
        if (recordedMae <= PIXEL_ALIGNED_MAE && recordedMae <= truthMae + PIXEL_RELATIVE_MARGIN) verdict = 'aligned';
        else if (truthMae <= PIXEL_ALIGNED_MAE * 0.75 && truthMae <= recordedMae - PIXEL_RELATIVE_MARGIN) verdict = 'misaligned';
      } else if (recordedMae !== null && recordedMae <= PIXEL_ALIGNED_MAE) {
        verdict = 'aligned';
      }
    }

    // Abaixo de 1,5 px CSS a diferença não é de posição: é ruído de subpixel entre o raster da página
    // inteira (escala fracionária) e a fotografia da área visível, ampliado pelo contraste do texto.
    // Nenhuma caixa desenhada a menos de 1,5 px do elemento é visivelmente errada; chamar isso de erro
    // seria trocar uma medida honesta por um falso positivo.
    let reason = null;
    if (verdict === 'misaligned' && Number.isFinite(row.distance) && row.distance <= 1.5) {
      verdict = 'inconclusive';
      reason = 'subpixel-noise';
    }

    const base = `${row.artifact}-${row.number ?? row.evidenceId ?? 'sem-numero'}-${safeName(row.nodeId)}`;
    const saveFiles = save || verdict === 'misaligned';
    if (saveFiles && recordedCrop) await savePng(directory, `pixel-${base}-gravado.png`, recordedCrop);
    if (saveFiles && truthCrop) await savePng(directory, `pixel-${base}-atual.png`, truthCrop);
    if (saveFiles) await savePng(directory, `pixel-${base}-tela.png`, shot);

    return {
      verdict,
      ...(reason ? { reason } : {}),
      recordedMae: recordedMae === null ? null : round(recordedMae, 2),
      truthMae: truthMae === null ? null : round(truthMae, 2),
      detail: round(detail, 2),
      measuredRect: { x: round(truthRect.x), y: round(truthRect.y), width: round(truthRect.width), height: round(truthRect.height) },
      screenshotDpr: round(measured.dpr, 3),
      images: save ? [`pixel-${base}-gravado.png`, `pixel-${base}-atual.png`, `pixel-${base}-tela.png`] : [],
    };
  } catch (error) {
    return { verdict: 'skipped', reason: String(error?.message ?? error).slice(0, 120) };
  }
}

async function savePng(directory, name, image) {
  await writeFile(join(directory, name), encodePng(image.width, image.height, image.rgba));
}

// --- roteiro --------------------------------------------------------------------------------------

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const chromeBinary = resolveRealChromeTestBinary();
  if (!chromeBinary) throw new Error('AUDITA_E2E_CHROME não definido');
  const slug = [
    slugify(options.url), `${options.viewport.width}x${options.viewport.height}`,
    `z${String(options.zoom).replace('.', '_')}`, `d${String(options.deviceScaleFactor).replace('.', '_')}`,
    options.label,
  ].filter(Boolean).join('-');
  const outRoot = resolve(process.cwd(), options.out);
  const directory = join(outRoot, slug);
  await mkdir(directory, { recursive: true });

  const cleanups = [];
  const launch = await launchUnpackedExtension({ after: handler => cleanups.push(handler) }, {
    extensionPath: ROOT, startUrl: options.url, chromeBinary,
    viewport: options.viewport, downloadMode: 'profile',
    // A densidade entra na linha de comando (`--force-device-scale-factor`). O override por CDP era
    // apagado pela própria auditoria quando ela repunha as métricas de dispositivo; com a chave de
    // inicialização a densidade continua valendo do começo ao fim, que é o que a medição precisa.
    ...(options.deviceScaleFactor === 1 ? {} : { deviceScaleFactor: options.deviceScaleFactor }),
    expectedMajor: Number(process.env.AUDITA_EXPECT_CHROME_MAJOR) || 155,
  });
  const result = {
    url: options.url, viewport: options.viewport, label: options.label || null,
    requestedZoom: options.zoom, requestedDeviceScaleFactor: options.deviceScaleFactor,
    chrome: launch.chromeProduct, types: [], rows: [],
  };
  try {
    const page = launch.startPage.page;
    result.devicePixelRatioObserved = await evaluate(page, 'devicePixelRatio').catch(() => null);
    result.zoomObserved = await applyZoom(launch, options.zoom);

    const panel = await launch.openSidePanelFromAction();
    await command(panel, 'Page.bringToFront');
    await waitForValue(panel, PANEL_READY, Boolean, { timeoutMs: 60_000, intervalMs: 100 });
    await click(panel, 'input[data-capture-mode="full-evidence"]');
    await sleep(400);

    // Amostrador antes de começar. Ele é reinjetado se a página recarregar durante a auditoria.
    let sampler = await evaluate(page, SAMPLER_START);
    result.samplerStart = sampler;

    let terminal = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const status = await evaluate(page, SAMPLER_STATUS).catch(() => ({ present: false }));
      if (!status?.active) sampler = await evaluate(page, SAMPLER_START);
      await click(panel, 'button[data-intent="START_ATTACHED"]');
      terminal = await waitForValue(panel, PANEL_SCREEN,
        value => ['result', 'unavailable', 'failed'].includes(value?.screen), { timeoutMs: 180_000, intervalMs: 200 });
      const reloaded = terminal.screen === 'unavailable' && /recarregou/iu.test(terminal.text ?? '');
      if (terminal.screen !== 'unavailable' || !reloaded || attempt === 3) break;
      await waitForValue(panel, PANEL_READY, Boolean, { timeoutMs: 60_000, intervalMs: 200 });
      await sleep(600);
    }
    let samplerTail = await evaluate(page, SAMPLER_STOP).catch(() => null);
    if (terminal.screen !== 'result' || !terminal.auditId) throw new Error(`auditoria não concluiu: ${JSON.stringify(terminal)}`);
    // A página que recarregou no meio perde o amostrador: uma última dupla de amostras ainda dá uma
    // verdade unilateral (o estado atual), declarada como tal no resultado.
    if (!samplerTail?.frames?.length) {
      await evaluate(page, SAMPLER_START).catch(() => null);
      await sleep(900);
      samplerTail = await evaluate(page, SAMPLER_STOP).catch(() => null);
      result.samplerFallback = true;
    }

    const revision = await evaluate(panel, revisionExpression(terminal.auditId), { awaitPromise: true });
    if (!revision) throw new Error('revisão da auditoria ausente');
    result.auditId = terminal.auditId;
    result.status = revision.status;
    result.diagnostics = revision.diagnostics;
    result.fullPage = revision.fullPage;
    result.counts = {
      annotation: revision.annotation?.counts ?? null,
      annotationStatus: revision.annotation?.status ?? null,
      annotationLimitations: revision.annotation?.limitations ?? null,
      keyboard: revision.keyboard?.counts ?? null,
      keyboardStatus: revision.keyboard?.status ?? null,
      keyboardLimitations: revision.keyboard?.limitations ?? null,
      elements: {
        total: revision.elements.length,
        withBox: revision.elements.filter(item => item.fullPageRect).length,
        withoutBox: revision.elements.filter(item => !item.fullPageRect).length,
        withOwnPixels: revision.elements.filter(item => item.hasOwnPixels).length,
      },
    };

    await sleep(600);

    // Instante e pixels da captura integral.
    let image = null;
    if (options.pixels && revision.fullPage?.hasPixels) {
      try {
        const read = await readFullPagePng(panel, terminal.auditId);
        image = read.image;
        if (options.saveFullImage) {
          await writeFile(join(directory, 'full-page.png'), read.bytes);
          const cssWidth = revision.fullPage.width || image.width;
          const cssHeight = revision.fullPage.height || image.height;
          const top = cropPng(image, { x: 0, y: 0, width: cssWidth, height: 220 },
            image.width / cssWidth, image.height / cssHeight);
          if (top) await savePng(directory, 'full-page-top.png', top);
        }
      } catch (error) { result.imageError = String(error?.message ?? error).slice(0, 200); }
    }
    const metadata = await evaluate(panel, `import(chrome.runtime.getURL('/src/storage/audit-store.js')).then(module =>
      module.createAuditStore().getReportRevision(${JSON.stringify(terminal.auditId)})).then(revision => {
      const page = (revision?.model?.evidence ?? []).find(item => item.kind === 'full-page' && item.state === 'pristine');
      return page?.metadata ?? null;
    })`, { awaitPromise: true });
    const captureAt = Date.parse(metadata?.captureReceivedAt ?? '');
    result.captureTs = Number.isFinite(captureAt) ? captureAt : null;
    const imageSize = metadata && Number.isFinite(metadata.width) && Number.isFinite(metadata.height)
      ? { width: metadata.width, height: metadata.height } : null;
    result.imageSize = imageSize;
    result.imagePixels = image ? { width: image.width, height: image.height } : null;
    if (image && imageSize) {
      result.imageScale = { x: image.width / imageSize.width, y: image.height / imageSize.height };
    }

    // Caixas desenhadas pelos dois mapas e recortes de elemento.
    const collected = [];
    for (const entry of revision.annotation?.annotations ?? []) {
      collected.push({ ...entry, artifact: 'announcement-map', sourceWidth: revision.annotation?.geometry?.sourceCssSize?.width ?? null });
    }
    for (const entry of [...(revision.keyboard?.stops ?? []), ...(revision.keyboard?.suspects ?? [])]) {
      collected.push({ ...entry, artifact: 'keyboard-map', sourceWidth: revision.keyboard?.geometry?.sourceCssSize?.width ?? null });
    }
    for (const entry of revision.elements) {
      if (entry.fullPageRect) {
        collected.push({
          nodeId: entry.nodeId, bounds: entry.fullPageRect, evidenceId: entry.evidenceId,
          artifact: 'element', sourceWidth: revision.annotation?.geometry?.sourceCssSize?.width ??
            revision.keyboard?.geometry?.sourceCssSize?.width ?? null,
        });
      }
    }

    const resolved = await resolvePaths(page, collected.map(entry => entry.nodeId).filter(Boolean));
    for (const entry of collected) {
      entry.path = resolved.paths.get(String(entry.nodeId)) ?? null;
      entry.objectId = resolved.objects.get(String(entry.nodeId)) ?? null;
    }

    // Leitura em lote dos retângulos amostrados: um único evaluate por bloco de caminhos.
    const framesMeta = samplerTail?.frames ?? [];
    const paths = [...new Set(collected.map(entry => entry.path).filter(Boolean))];
    let matrix = [];
    if (framesMeta.length > 0 && paths.length > 0) {
      const block = 200;
      for (let start = 0; start < paths.length; start += block) {
        const slice = paths.slice(start, start + block);
        const part = await evaluate(page, samplerRectsExpression(slice));
        matrix = matrix.concat(Array.isArray(part) ? part : []);
      }
    }
    const frames = fetchFrames(framesMeta, matrix, paths);
    result.sampler = {
      frames: frames.length,
      started: Boolean(sampler?.started || sampler?.resumed),
      widthMatchingFrames: imageSize
        ? frames.filter(frame => Math.abs(frame.clientWidth - imageSize.width) <= 2).length
        : null,
      clientWidths: [...new Set(frames.map(frame => frame.clientWidth))].slice(0, 10),
      innerWidths: [...new Set(frames.map(frame => frame.innerWidth))].slice(0, 10),
    };

    const captureTimeForTruth = result.captureTs ?? (frames.at(-1)?.ts ?? Date.now());
    const byType = ['announcement-map', 'keyboard-map', 'element'];
    for (const type of byType) {
      const entries = collected.filter(entry => entry.artifact === type);
      if (entries.length === 0) continue;
      const rows = [];
      for (const entry of entries) {
        if (!entry.nodeId || !entry.bounds) continue;
        if (!entry.path) { rows.push({ ...entry, type, status: 'unresolved-path' }); continue; }
        const truth = groundTruth(frames, entry.path, captureTimeForTruth, entry.sourceWidth ?? imageSize?.width ?? null);
        if (truth.status === 'unresolved') {
          rows.push({ ...entry, type, status: truth.status, availableFrames: truth.frames });
          continue;
        }
        const imageBox = imageSize ? clipToImage(truth.rect, imageSize) : null;
        if (!imageBox) {
          rows.push({
            ...entry, type, status: 'outside-image', measured: truth.rect,
            recorded: entry.bounds, distance: null, misaligned: true,
          });
          continue;
        }
        const distance = rectDistance(entry.bounds, imageBox);
        rows.push({
          ...entry, type, status: truth.status, measured: truth.rect, truth: truth.rect, recorded: entry.bounds,
          expected: imageBox, distance: round(distance),
          misaligned: distance > TOLERANCE_PX,
        });
      }
      result.rows.push(...rows);
      result.types.push(summarize(rows, type));
    }

    // Confirmação por pixels: todas as desalinhadas e uma amostra determinística por tipo.
    if (options.pixels && image && imageSize && imageSize.width > 0 && imageSize.height > 0) {
      result.pixel = { enabled: true, widened: null, samples: 0, aligned: 0, misaligned: 0, inconclusive: 0, skipped: 0 };
      result.pixel.widened = await widenForPixelCheck(page);
      await sleep(200);
      if (options.saveViewport) {
        await evaluate(page, '(() => { window.scrollTo(0, 0); return true; })()').catch(() => null);
        await sleep(220);
        const shot = await command(page, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true });
        if (typeof shot?.data === 'string') await writeFile(join(directory, 'viewport.png'), Buffer.from(shot.data, 'base64'));
        result.viewportDiagnostics = await evaluate(page, `(() => {
          const link = document.querySelector('.aviso-topo a');
          const box = link ? link.getBoundingClientRect() : null;
          return { innerWidth, clientWidth: document.documentElement.clientWidth, scrollX, scrollY,
            dpr: devicePixelRatio, link: box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null };
        })()`).catch(() => null);
      }
      const scaleX = image.width / imageSize.width;
      const scaleY = image.height / imageSize.height;
      for (const type of byType) {
        const candidates = result.rows.filter(row => row.type === type && row.recorded && row.truth && row.objectId);
        if (candidates.length === 0) continue;
        const misaligned = candidates.filter(row => row.misaligned);
        const aligned = candidates.filter(row => !row.misaligned);
        const sampled = [...misaligned];
        if (aligned.length > 0 && options.pixelSamples > 0) {
          const step = Math.max(1, Math.floor(aligned.length / Math.min(options.pixelSamples, aligned.length)));
          for (let index = 0; index < aligned.length && sampled.length < misaligned.length + options.pixelSamples; index += step) {
            sampled.push(aligned[index]);
          }
        }
        for (const row of sampled.slice(0, misaligned.length + options.pixelSamples)) {
          const save = row.misaligned || sampled.indexOf(row) < misaligned.length + 3;
          const pixel = await pixelCheck(page, row, { image, imageScaleX: scaleX, imageScaleY: scaleY, directory, save });
          row.pixel = pixel;
          result.pixel.samples += 1;
          if (pixel.verdict === 'misaligned') result.pixel.misaligned += 1;
          else if (pixel.verdict === 'aligned') result.pixel.aligned += 1;
          else if (pixel.verdict === 'inconclusive') result.pixel.inconclusive += 1;
          else result.pixel.skipped += 1;
        }
      }
      // Recalcula os resumos com o veredito de pixels.
      result.types = byType
        .map(type => summarize(result.rows.filter(row => row.type === type), type))
        .filter(item => item.drawn > 0);
    }

    const misaligned = result.rows.filter(row => row.status === 'stable' && row.misaligned);
    for (const row of misaligned.slice(0, 40)) {
      row.series = frames.map(frame => {
        const value = frame.rects.get(row.path);
        return value
          ? { ts: frame.ts, x: round(value.x, 1), y: round(value.y, 1), width: round(value.width, 1), height: round(value.height, 1) }
          : { ts: frame.ts };
      });
    }
    result.misaligned = misaligned.length;
    result.checked = result.rows.filter(row => row.status === 'stable' && row.measured).length;
    result.drawn = result.rows.length;
    result.elementsWithoutBox = {
      annotationOmittedNoRect: revision.annotation?.counts?.omittedNoRect ?? null,
      keyboardOmittedNoRect: revision.keyboard?.counts?.omittedNoRect ?? null,
      elementsWithoutFullPageRect: result.counts.elements.withoutBox,
      annotationEligible: revision.annotation?.counts?.eligible ?? null,
      keyboardEligible: revision.keyboard?.counts?.eligible ?? null,
    };
    await writeFile(join(directory, 'precision.json'), `${JSON.stringify(result, null, 2)}\n`);

    console.log(`\n${options.url} — ${options.viewport.width}x${options.viewport.height} — zoom ${result.zoomObserved ?? '?'} — dSF ${options.deviceScaleFactor} — ${launch.chromeProduct}`);
    console.log(`auditId ${terminal.auditId} | status ${result.status} | amostras ${frames.length} | larguras ${JSON.stringify(result.sampler.clientWidths)} | imagem ${imageSize ? `${imageSize.width}x${imageSize.height}` : '?'}${image ? ` (${image.width}x${image.height} px)` : ''}`);
    for (const type of result.types) {
      console.log(`  ${type.type.padEnd(18)} desenhadas ${String(type.drawn).padStart(4)} | conferidas ${String(type.checked).padStart(4)} | ` +
        `desalinhadas ${String(type.misaligned).padStart(3)} (fora da imagem ${type.outsideImage}) | pior ${String(type.worstDistancePx).padStart(7)} px | ` +
        `não resolvidas ${type.unresolved} | pixels ${type.pixelChecked}: ${type.pixelMisaligned} erradas, ${type.pixelInconclusive} inconclusivas`);
    }
    console.log(`  TOTAL: ${result.misaligned} desalinhada(s) de ${result.checked} conferida(s); ` +
      `sem caixa: anúncios ${result.elementsWithoutBox.annotationOmittedNoRect}, teclado ${result.elementsWithoutBox.keyboardOmittedNoRect}, elementos ${result.elementsWithoutBox.elementsWithoutFullPageRect}`);
    if (result.pixel) console.log(`  PIXELS: ${result.pixel.aligned} alinhadas, ${result.pixel.misaligned} erradas, ${result.pixel.inconclusive} inconclusivas, ${result.pixel.skipped} puladas`);
    for (const row of misaligned.slice(0, 30)) {
      console.log(`    #${row.number ?? '-'} ${row.artifact} ${row.nodeId} ${row.path ?? 'sem caminho'} ` +
        `gravado=${JSON.stringify(row.recorded)} real=${JSON.stringify(row.measured)} distância=${row.distance}` +
        `${row.pixel ? ` | pixels=${row.pixel.verdict} (${row.pixel.recordedMae}/${row.pixel.truthMae})` : ''}`);
    }
    if (misaligned.length > 30) console.log(`    ... mais ${misaligned.length - 30}`);
    console.log(`  arquivo: ${join(outRoot, slug, 'precision.json')}`);
  } finally {
    for (const cleanup of cleanups.reverse()) await cleanup().catch(() => {});
  }
}

await main();
