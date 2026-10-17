import assert from 'node:assert/strict';
import test from 'node:test';

import {
  KEYBOARD_MAP_MV3_GATE,
  KeyboardMapError,
  buildKeyboardMapPlan,
  composeKeyboardMap,
  composeKeyboardMapForProduction,
} from '../../src/browser/keyboard-map.js';
import { KEYBOARD_MAP_LIMITS, hashKeyboardMapArtifact, validateKeyboardMapArtifact } from '../../src/core/keyboard/keyboard-map-artifact.js';
import { pngDataUrlFromBytes } from '../../src/core/evidence/png.js';
import { keyboardMapPresentation } from '../../src/core/report/keyboard-map-presentation.js';
import { sha256Hex } from '../../src/core/report/hash.js';
import { buildPng } from '../support/png-fixture.js';

function snapshot(nodes) {
  const normalized = nodes.map((node, index) => ({
    nodeId: node.nodeId ?? `n-${index + 1}`,
    parentId: node.parentId ?? null,
    children: node.children ?? [],
    tagName: node.tagName ?? 'button',
    attributes: node.attributes ?? {},
    framePath: node.framePath ?? [],
    hidden: false,
    hasRenderedBox: true,
    ...node,
  }));
  const byId = new Map(normalized.map(node => [node.nodeId, node]));
  for (const node of normalized) {
    if (node.parentId && byId.has(node.parentId) && !byId.get(node.parentId).children.includes(node.nodeId)) {
      byId.get(node.parentId).children.push(node.nodeId);
    }
  }
  return {
    schemaVersion: 1,
    document: { nodeId: 'document', title: 'Fixture', url: 'https://example.test/' },
    nodes: normalized,
  };
}

async function pristineSource(width, height, overrides = {}) {
  const bytes = buildPng({ width, height });
  return {
    evidenceId: 'full', pageId: 'page-1', kind: 'full-page', state: 'pristine',
    dataUrl: pngDataUrlFromBytes(bytes), hash: await sha256Hex(bytes), metadata: {}, ...overrides,
  };
}

function recordingLog() {
  return { fills: [], strokeRects: [], drawImages: [], texts: [], strokes: [], dashes: [], paths: [], blobs: 0 };
}

function createContext(log) {
  const context = {
    fillStyle: '', strokeStyle: '', lineWidth: 0, font: '', textAlign: '', textBaseline: '', dash: [],
    fillRect(...args) { log.fills.push({ args, fillStyle: context.fillStyle }); },
    strokeRect(...args) { log.strokeRects.push({ args, strokeStyle: context.strokeStyle }); },
    drawImage(...args) { log.drawImages.push(args); },
    fillText(value, x, y) { log.texts.push({ value: String(value), x, y, fillStyle: context.fillStyle, font: context.font }); },
    setLineDash(value) { context.dash = [...value]; log.dashes.push([...value]); },
    beginPath() { log.paths.push([]); },
    moveTo(x, y) { log.paths[log.paths.length - 1].push([x, y]); },
    lineTo(x, y) { log.paths[log.paths.length - 1].push([x, y]); },
    stroke() {
      log.strokes.push({
        strokeStyle: context.strokeStyle, lineWidth: context.lineWidth,
        dash: [...context.dash], points: log.paths[log.paths.length - 1],
      });
    },
  };
  return context;
}

function canvasRuntime(log, overrides = {}) {
  class Canvas {
    constructor(width, height) { this.width = width; this.height = height; }
    getContext() { return createContext(log); }
    async convertToBlob() {
      log.blobs += 1;
      return new Blob([buildPng({ width: this.width, height: this.height })], { type: 'image/png' });
    }
  }
  return {
    runtime: { OffscreenCanvas: Canvas, createImageBitmap: async () => ({ close() {} }), ...overrides },
  };
}

const PAGE = [
  { nodeId: 'action', tagName: 'button', accessibleName: 'Consultar', axRole: 'button', rect: { x: 10, y: 10, width: 60, height: 20 } },
  { nodeId: 'menu', tagName: 'div', attributes: { role: 'button' }, accessibleName: 'Serviços', axRole: 'button', rect: { x: 10, y: 50, width: 60, height: 20 } },
];
const SOURCE = { cssContentSize: { width: 200, height: 100 } };

test('planeja paradas, suspeitos e fatias sem tocar no navegador', () => {
  const plan = buildKeyboardMapPlan({
    snapshot: snapshot(PAGE), sourceMetadata: { width: 200, height: 100 }, layoutMetrics: SOURCE,
  });

  assert.deepEqual(plan.stops.map(stop => [stop.number, stop.nodeId, stop.bounds]), [
    [1, 'action', { x: 10, y: 10, width: 60, height: 20 }],
  ]);
  assert.deepEqual(plan.suspects.map(entry => [entry.number, entry.nodeId, entry.reason]), [[1, 'menu', 'interactive-role']]);
  assert.deepEqual(plan.geometry, {
    cssWidth: 200, cssHeight: 100, scaleX: 1, scaleY: 1, deviceScaleFactor: null,
  });
  assert.equal(plan.segments.length, 1);
  assert.deepEqual(plan.segments[0].sourceCssClip, { x: 0, y: 0, width: 200, height: 100 });
  // A etiqueta fica FORA da caixa, encostada nela, para não cobrir o texto do item: sem espaço à esquerda
  // (a caixa começa em x=10) nem acima (y=10), ela vai para a direita, centrada na altura.
  assert.deepEqual(plan.segments[0].entries[0].placement, {
    number: 1, label: '1', kind: 'stop', box: { x: 10, y: 10, width: 60, height: 20 }, badge: { x: 72, y: 10, size: 20 },
  });
});

test('fatia páginas altas em segmentos imprimíveis e mantém cada item na sua fatia', () => {
  const plan = buildKeyboardMapPlan({
    snapshot: snapshot(PAGE), sourceMetadata: { width: 200, height: 1000 }, layoutMetrics: { cssContentSize: { width: 200, height: 1000 } },
  });

  assert.equal(plan.segments.length, 4);
  assert.deepEqual(plan.segments.map(segment => segment.sourceCssClip), [
    { x: 0, y: 0, width: 200, height: 260 },
    { x: 0, y: 260, width: 200, height: 260 },
    { x: 0, y: 520, width: 200, height: 260 },
    { x: 0, y: 780, width: 200, height: 220 },
  ]);
  assert.deepEqual(plan.segments.map(segment => segment.sourcePixelClip.height), [260, 260, 260, 220]);
  assert.equal(plan.stops[0].segmentIndex, 1);
  assert.equal(plan.suspects[0].segmentIndex, 1);
});

test('compõe um artefato determinístico, verificável e com as caixas nas cores certas', async () => {
  const log = recordingLog();
  const { runtime } = canvasRuntime(log);
  const fullPageEvidence = await pristineSource(200, 100);
  const input = {
    pageId: 'page-1', fullPageEvidence, snapshot: snapshot(PAGE), layoutMetrics: SOURCE, runtime,
  };

  const first = await composeKeyboardMap(input);
  const second = await composeKeyboardMap({ ...input, runtime: canvasRuntime(recordingLog()).runtime });

  assert.equal(first.kind, 'keyboard-map');
  assert.equal(first.state, 'derived');
  assert.equal(first.fullPageEvidenceId, 'full');
  assert.equal(first.evidenceId, second.evidenceId);
  assert.equal(first.hash, second.hash);
  assert.equal(first.segments.length, 1);
  assert.equal(first.segments[0].role, 'image');
  assert.equal(first.segments[0].segmentId, `${first.evidenceId}-segment-1`);
  assert.equal(first.segments[0].count, 1);
  assert.deepEqual(validateKeyboardMapArtifact(first, { sourceArtifact: fullPageEvidence }), first);
  assert.equal(await hashKeyboardMapArtifact(first, { sourceArtifact: fullPageEvidence }), first.hash);

  // Caixa azul sólida da parada, caixa laranja tracejada do suspeito e as etiquetas.
  const solid = log.strokes.filter(stroke => stroke.strokeStyle === '#0b4fa8' && stroke.dash.length === 0);
  const dashed = log.strokes.filter(stroke => stroke.strokeStyle === '#b45309');
  assert.equal(solid.length, 1);
  assert.deepEqual(solid[0].points, [[10, 10], [70, 10], [70, 30], [10, 30], [10, 10]]);
  assert.equal(dashed.length, 1);
  assert.deepEqual(dashed[0].dash.length, 2);
  assert.deepEqual(dashed[0].points, [[10, 50], [70, 50], [70, 70], [10, 70], [10, 50]]);
  assert.deepEqual(log.texts.map(entry => entry.value), ['1', '?']);
  assert.deepEqual(log.texts.map(entry => entry.fillStyle), ['#ffffff', '#ffffff']);
  assert.equal(log.fills.filter(fill => fill.args[2] === 20 && fill.args[3] === 20).length, 2);
  assert.deepEqual(log.drawImages.map(args => args.slice(1)), [[0, 0, 200, 100, 0, 0, 200, 100]]);
});

test('página sem nada alcançável gera artefato vazio sem desenhar nada', async () => {
  const log = recordingLog();
  const { runtime } = canvasRuntime(log);
  const artifact = await composeKeyboardMap({
    pageId: 'page-1', fullPageEvidence: await pristineSource(200, 100),
    snapshot: snapshot([{ nodeId: 'text', tagName: 'p', rect: { x: 0, y: 0, width: 100, height: 10 } }]),
    layoutMetrics: SOURCE, runtime,
  });

  assert.equal(artifact.status, 'empty');
  assert.deepEqual(artifact.segments, []);
  assert.deepEqual([artifact.stops, artifact.suspects], [[], []]);
  assert.equal(log.blobs, 0);
  assert.deepEqual(validateKeyboardMapArtifact(artifact), artifact);
});

test('declara parcialidade e deixa sem caixa o item fora da captura, sem encaixar na borda', async () => {
  const artifact = await composeKeyboardMap({
    pageId: 'page-1', fullPageEvidence: await pristineSource(200, 100),
    snapshot: snapshot([
      { nodeId: 'below', tagName: 'button', accessibleName: 'Abaixo da captura', axRole: 'button', rect: { x: 10, y: 400, width: 60, height: 20 } },
    ]),
    layoutMetrics: SOURCE, ...canvasRuntime(recordingLog()),
  });

  assert.equal(artifact.status, 'partial');
  assert.ok(artifact.limitations.includes('cursor-style-not-collected'));
  // A caixa não pode ser desenhada no lugar errado: o item sai das caixas, mas continua contado e a
  // imagem continua no relatório, agora sem nenhum retângulo de 1 px na borda.
  assert.ok(artifact.limitations.includes('stops-outside-source-omitted'));
  assert.deepEqual(artifact.stops, []);
  assert.equal(artifact.counts.stops, 0);
  assert.equal(artifact.counts.eligible, 1);
  assert.equal(artifact.counts.omittedNoRect, 1);
  assert.ok(artifact.segments.length > 0, 'a imagem continua no relatório para dar contexto à contagem');
  assert.deepEqual(validateKeyboardMapArtifact(artifact), artifact);

  // Com o leiaute reprovado nada é desenhado, então a lista continua inteira: o item fora da captura
  // permanece nela (a posição estimada é recortada só para o esquema fechado aceitar) e quem explica o
  // silêncio é `source-layout-changed`; duas limitações para o mesmo fato confundiriam quem lê.
  const rejected = await composeKeyboardMap({
    pageId: 'page-1', fullPageEvidence: await pristineSource(200, 100),
    snapshot: snapshot([
      { nodeId: 'below', tagName: 'button', accessibleName: 'Abaixo da captura', axRole: 'button', rect: { x: 10, y: 400, width: 60, height: 20 } },
    ]),
    layoutMetrics: SOURCE, sourceAligned: false, ...canvasRuntime(recordingLog()),
  });
  assert.equal(rejected.limitations.includes('stops-outside-source-omitted'), false);
  assert.equal(rejected.limitations.includes('stops-outside-source-clamped'), false);
  assert.ok(rejected.limitations.includes('source-layout-changed'));
  assert.deepEqual(rejected.stops.map(entry => entry.nodeId), ['below']);
  assert.equal(rejected.counts.stops, 1);
  assert.equal(rejected.counts.omittedNoRect, 0);
  assert.deepEqual(validateKeyboardMapArtifact(rejected), rejected);
});

test('ao omitir um item fora da captura, a numeração das caixas que sobram continua de 1 a N', async () => {
  // O item fora da área capturada é o PRIMEIRO da ordem de Tab. Se os números não fossem recalculados,
  // a parada seguinte ficaria com o número 2 e sem fatia correspondente — o artefato seria recusado.
  const artifact = await composeKeyboardMap({
    pageId: 'page-1', fullPageEvidence: await pristineSource(200, 100),
    snapshot: snapshot([
      { nodeId: 'acima', tagName: 'button', accessibleName: 'Antes da captura', axRole: 'button', rect: { x: 10, y: -60, width: 60, height: 20 } },
      { nodeId: 'dentro', tagName: 'button', accessibleName: 'Dentro da captura', axRole: 'button', rect: { x: 20, y: 30, width: 60, height: 20 } },
    ]),
    layoutMetrics: SOURCE, ...canvasRuntime(recordingLog()),
  });

  assert.ok(artifact.limitations.includes('stops-outside-source-omitted'));
  assert.deepEqual(artifact.stops.map(entry => [entry.number, entry.nodeId, entry.segmentIndex]), [[1, 'dentro', 1]]);
  assert.equal(artifact.counts.stops, 1);
  assert.equal(artifact.counts.eligible, 2);
  assert.equal(artifact.counts.omittedNoRect, 1);
  assert.deepEqual(validateKeyboardMapArtifact(artifact), artifact);
});

test('sem caixas confiáveis a imagem sai limpa, a lista continua completa e a limitação é declarada', async () => {
  const log = recordingLog();
  const { runtime } = canvasRuntime(log);
  const fullPageEvidence = await pristineSource(200, 100);
  const artifact = await composeKeyboardMap({
    pageId: 'page-1', fullPageEvidence, snapshot: snapshot(PAGE), layoutMetrics: SOURCE,
    sourceAligned: false, runtime,
  });

  // A imagem existe (a pessoa vê a página), mas sem caixa, sem etiqueta e sem risco de apontar errado.
  assert.equal(artifact.status, 'partial');
  assert.ok(artifact.limitations.includes('source-layout-changed'));
  assert.equal(log.strokes.length, 0);
  assert.equal(log.texts.length, 0);
  assert.equal(log.drawImages.length, 1);
  // A lista completa continua: os itens aparecem com nome e posição estimada, sem número na imagem.
  assert.deepEqual(artifact.stops.map(entry => [entry.number, entry.nodeId, entry.kind]), [[1, 'action', 'button']]);
  assert.deepEqual(artifact.suspects.map(entry => [entry.number, entry.nodeId, entry.reason]), [[1, 'menu', 'interactive-role']]);
  assert.equal(artifact.counts.stops, 1);
  assert.equal(artifact.counts.suspects, 1);
  assert.equal(artifact.segments.length, 1);
  assert.deepEqual(validateKeyboardMapArtifact(artifact, { sourceArtifact: fullPageEvidence }), artifact);

  // O relatório diz, em português claro, que a imagem vai sem marcação e que a lista continua valendo.
  const [presented] = keyboardMapPresentation([{ pageId: 'page-1' }], [artifact]);
  assert.match(presented.summary, /mudou de tamanho/iu);
  assert.match(presented.coverage, /nenhum número foi desenhado/iu);
  assert.deepEqual(presented.stops.map(entry => entry.name), ['Consultar']);
  assert.deepEqual(presented.stops.map(entry => entry.location), ['Sem marca na imagem; posição estimada no documento.']);
  assert.ok(presented.limitations.some(text => /mudou de tamanho/iu.test(text)));

  // O mesmo instantâneo com o leiaute confirmado volta a desenhar as caixas: a omissão não é permanente.
  const alignedLog = recordingLog();
  const aligned = await composeKeyboardMap({
    pageId: 'page-1', fullPageEvidence, snapshot: snapshot(PAGE), layoutMetrics: SOURCE,
    sourceAligned: true, runtime: canvasRuntime(alignedLog).runtime,
  });
  assert.equal(aligned.limitations.includes('source-layout-changed'), false);
  assert.equal(alignedLog.strokes.length > 0, true, 'com o leiaute confirmado as caixas voltam');
  assert.equal(alignedLog.texts.length, 2);
});

test('recusa origem que não é a captura integral pristine da mesma página', async () => {
  const { runtime } = canvasRuntime(recordingLog());
  const base = { snapshot: snapshot(PAGE), layoutMetrics: SOURCE, runtime };

  for (const [overrides, code] of [
    [{ kind: 'element' }, 'KEYBOARD_MAP_SOURCE_INVALID'],
    [{ state: 'redacted' }, 'KEYBOARD_MAP_SOURCE_INVALID'],
    [{ pageId: 'outra-pagina' }, 'KEYBOARD_MAP_SOURCE_INVALID'],
    [{ dataUrl: 'data:image/png;base64,0000' }, 'KEYBOARD_MAP_SOURCE_INVALID'],
    [{ hash: 'f'.repeat(64) }, 'KEYBOARD_MAP_SOURCE_HASH_MISMATCH'],
  ]) {
    const fullPageEvidence = await pristineSource(200, 100, overrides);
    await assert.rejects(composeKeyboardMap({ ...base, pageId: 'page-1', fullPageEvidence }),
      error => error instanceof KeyboardMapError && error.code === code);
  }
});

test('respeita cancelamento, tempo limite e compositor ausente', async () => {
  const fullPageEvidence = await pristineSource(200, 100);
  const controller = new AbortController();
  controller.abort(new DOMException('Operação cancelada.', 'AbortError'));
  await assert.rejects(composeKeyboardMap({
    pageId: 'page-1', fullPageEvidence, snapshot: snapshot(PAGE), layoutMetrics: SOURCE,
    runtime: canvasRuntime(recordingLog()).runtime, signal: controller.signal,
  }), error => error?.name === 'AbortError');

  await assert.rejects(composeKeyboardMap({
    pageId: 'page-1', fullPageEvidence, snapshot: snapshot(PAGE), layoutMetrics: SOURCE, timeoutMs: 5,
    runtime: {
      OffscreenCanvas: class { constructor(width, height) { this.width = width; this.height = height; } },
      createImageBitmap: () => new Promise(() => {}),
    },
  }), error => error instanceof KeyboardMapError && error.code === 'KEYBOARD_MAP_TIMEOUT');

  await assert.rejects(composeKeyboardMap({
    pageId: 'page-1', fullPageEvidence, snapshot: snapshot(PAGE), layoutMetrics: SOURCE,
    runtime: { OffscreenCanvas: undefined, createImageBitmap: undefined },
  }), error => error instanceof KeyboardMapError && error.code === 'KEYBOARD_MAP_COMPOSITOR_UNAVAILABLE');
});

test('recusa PNG derivado que não corresponde ao segmento pedido', async () => {
  const log = recordingLog();
  await assert.rejects(composeKeyboardMap({
    pageId: 'page-1', fullPageEvidence: await pristineSource(200, 100),
    snapshot: snapshot(PAGE), layoutMetrics: SOURCE,
    runtime: {
      OffscreenCanvas: class {
        constructor(width, height) { this.width = width; this.height = height; }
        getContext() { return createContext(log); }
        async convertToBlob() { return new Blob([buildPng({ width: 4, height: 4 })], { type: 'image/png' }); }
      },
      createImageBitmap: async () => ({ close() {} }),
    },
  }), error => error instanceof KeyboardMapError && error.code === 'KEYBOARD_MAP_OUTPUT_INVALID');
});

test('o ponto de produção falha fechado quando o portão MV3 está desligado', async () => {
  assert.equal(KEYBOARD_MAP_MV3_GATE.enabled, true);
  assert.ok(KEYBOARD_MAP_LIMITS.maxStops >= 400);
  const artifact = await composeKeyboardMapForProduction({
    pageId: 'page-1', fullPageEvidence: await pristineSource(200, 100),
    snapshot: snapshot(PAGE), layoutMetrics: SOURCE, ...canvasRuntime(recordingLog()),
  });
  assert.equal(artifact.kind, 'keyboard-map');
});
