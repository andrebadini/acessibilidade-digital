import assert from 'node:assert/strict';
import test from 'node:test';
import { deflateSync } from 'node:zlib';

import {
  ANNOTATION_MAP_ALGORITHM,
  ANNOTATION_MAP_LEADER_MIN_PX,
  ANNOTATION_MAP_LIMITS,
  ANNOTATION_MAP_VERSION,
  annotationBadgeSize,
  annotationLeaderPoint,
  hashAnnotationMapArtifact,
  hashAnnotationMapGeometry,
  validateAnnotationMapArtifact,
} from '../../src/core/evidence/annotation-map-artifact.js';
import { hashEvidenceArtifact } from '../../src/core/evidence/artifact-hash.js';
import { sha256Hex } from '../../src/core/report/hash.js';

const PNG_1X1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const PNG_1X1_HASH = '431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460';

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function inflateBombPng(width = 1, height = 1) {
  const chunk = (type, data) => {
    const typeBytes = Buffer.from(type, 'ascii');
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
    return Buffer.concat([length, typeBytes, data, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return new Uint8Array(Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(new Uint8Array(10 * 1024 * 1024))), chunk('IEND', Buffer.alloc(0)),
  ]));
}

function rgbaPng(width, height) {
  const chunk = (type, data) => {
    const typeBytes = Buffer.from(type, 'ascii');
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
    return Buffer.concat([length, typeBytes, data, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const raster = Buffer.alloc(height * (1 + width * 4), 255);
  for (let row = 0; row < height; row += 1) raster[row * (1 + width * 4)] = 0;
  return new Uint8Array(Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(raster)), chunk('IEND', Buffer.alloc(0)),
  ]));
}

// Captura de referência dos artefatos: 160×100 CSS na escala 1. A caixa do código mede 17×13 CSS, então a
// página precisa comportar a etiqueta — na 1.3.0 o que fica desenhado sobre o elemento é o código (L1…).
const PAGE = Object.freeze({ width: 160, height: 100 });
const PAGE_PNG_BYTES = rgbaPng(PAGE.width, PAGE.height);
const PNG = `data:image/png;base64,${Buffer.from(PAGE_PNG_BYTES).toString('base64')}`;
const PNG_HASH = await sha256Hex(PAGE_PNG_BYTES);

/** Marcador da 1.3.0 com a linha-guia derivada do próprio contorno, como o validador recalcula. */
function markerFor(number, sourceRect, x, y, cssWidth = PAGE.width) {
  const size = annotationBadgeSize(number, cssWidth);
  const leader = annotationLeaderPoint(sourceRect, x, y);
  return { x, y, width: size.width, height: size.height, leaderX: leader.x, leaderY: leader.y };
}

/** PNG de um trecho e a data URL correspondente, para os recortes que não são a página inteira. */
function segmentRaster(width, height) {
  const bytes = rgbaPng(width, height);
  return { dataUrl: `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`, height };
}

async function completeArtifact() {
  const sourceRect = { x: 8, y: 8, width: 40, height: 16 };
  const geometry = {
    coordinateSpace: 'document-css-px',
    sourceCssSize: { ...PAGE },
    sourcePixelSize: { ...PAGE },
    scaleX: 1,
    scaleY: 1,
    deviceScaleFactor: 2,
    annotations: [{
      number: 1,
      nodeId: 'n-1',
      sourceRect,
      marker: markerFor(1, sourceRect, 16, 60),
      segmentIndex: 1,
    }],
  };
  const artifact = {
    evidenceId: 'announcement-map-test',
    pageId: 'page-1',
    kind: 'announcement-map',
    state: 'derived',
    fullPageEvidenceId: 'full-page-test',
    derivation: {
      type: 'annotated-announcement-map',
      algorithm: ANNOTATION_MAP_ALGORITHM,
      version: ANNOTATION_MAP_VERSION,
      sourceEvidenceId: 'full-page-test',
      sourceHash: PNG_HASH,
      geometrySnapshotHash: await hashAnnotationMapGeometry(geometry),
      geometry,
    },
    status: 'complete',
    segments: [{
      segmentId: 'announcement-map-test-segment-1',
      index: 1,
      count: 1,
      role: 'image',
      sourceCssClip: { x: 0, y: 0, ...PAGE },
      width: PAGE.width,
      height: PAGE.height,
      dataUrl: PNG,
      contentHash: PNG_HASH,
    }],
    legend: [{
      number: 1,
      nodeId: 'n-1',
      selectorSummary: 'button',
      announcementPreview: 'Salvar, botão',
      nameSource: 'contents',
      segmentIndex: 1,
    }],
    counts: { eligible: 1, annotated: 1, omittedNoRect: 0, omittedFrame: 0, omittedLimit: 0, unresolvedOverlap: 0 },
    limits: { ...ANNOTATION_MAP_LIMITS },
    limitations: [
      'observed-dom-ax-order-not-literal-assistive-technology',
      'non-atomic-source-geometry',
      'top-document-open-shadow-only',
      'rasterization-browser-dependent',
      'source-capture-may-contain-personal-data',
    ],
    hash: '0'.repeat(64),
  };
  artifact.hash = await hashAnnotationMapArtifact(artifact);
  return artifact;
}

test('validates a closed derivation and recomputes segment, geometry and group hashes', async () => {
  const artifact = await completeArtifact();
  const sourceArtifact = {
    evidenceId: 'full-page-test', pageId: 'page-1', kind: 'full-page', state: 'pristine',
    dataUrl: PNG, hash: PNG_HASH,
  };

  assert.equal(validateAnnotationMapArtifact(artifact, { sourceArtifact }), artifact);
  assert.equal(await hashAnnotationMapArtifact(artifact), artifact.hash);
  assert.equal(await hashEvidenceArtifact(artifact), artifact.hash);

  const changedGeometry = structuredClone(artifact);
  changedGeometry.derivation.geometry.annotations[0].marker.x = 0.25;
  await assert.rejects(hashAnnotationMapArtifact(changedGeometry), /geometria|geometry|geométr/iu);

  const changedBytesHash = structuredClone(artifact);
  changedBytesHash.segments[0].contentHash = 'f'.repeat(64);
  await assert.rejects(hashAnnotationMapArtifact(changedBytesHash), /segmento|hash/iu);
});

test('rejects extra fields, cross-page/non-pristine origins and incoherent annotation links', async () => {
  const artifact = await completeArtifact();
  const extra = structuredClone(artifact);
  extra.derivation.geometry.privateValue = 'PRIVATE-SENTINEL';
  assert.throws(() => validateAnnotationMapArtifact(extra), /geometria|derivação|esquema/iu);

  for (const sourceArtifact of [
    { evidenceId: 'full-page-test', pageId: 'page-2', kind: 'full-page', state: 'pristine', hash: PNG_HASH },
    { evidenceId: 'full-page-test', pageId: 'page-1', kind: 'full-page', state: 'derived', hash: PNG_HASH },
    { evidenceId: 'full-page-test', pageId: 'page-1', kind: 'full-page', state: 'pristine', hash: 'e'.repeat(64) },
  ]) assert.throws(() => validateAnnotationMapArtifact(artifact, { sourceArtifact }), /origem|pristine|página/iu);

  const wrongLink = structuredClone(artifact);
  wrongLink.legend[0].nodeId = 'n-2';
  assert.throws(() => validateAnnotationMapArtifact(wrongLink), /legenda|geometria|anotação/iu);
});

test('enforces the aggregate legend budget and couples omission counts to their limitations', async () => {
  const oversizedLegend = await completeArtifact();
  oversizedLegend.derivation.geometry.annotations = Array.from({ length: 65 }, (_, index) => ({
    number: index + 1, nodeId: `n-${index + 1}`,
    sourceRect: { x: 8, y: 8, width: 40, height: 16 },
    marker: markerFor(index + 1, { x: 8, y: 8, width: 40, height: 16 }, 80, 50), segmentIndex: 1,
  }));
  oversizedLegend.derivation.geometrySnapshotHash = await hashAnnotationMapGeometry(oversizedLegend.derivation.geometry);
  oversizedLegend.legend = Array.from({ length: 65 }, (_, index) => ({
    number: index + 1, nodeId: `n-${index + 1}`, selectorSummary: 'button',
    announcementPreview: 'x'.repeat(4096), nameSource: 'contents', segmentIndex: 1,
  }));
  oversizedLegend.counts = { ...oversizedLegend.counts, eligible: 65, annotated: 65 };
  await assert.rejects(hashAnnotationMapArtifact(oversizedLegend), /legenda|limite|pontos de código/iu);

  for (const mutate of [
    value => { value.status = 'partial'; value.counts.omittedFrame = 1; },
    value => { value.status = 'partial'; value.counts.omittedLimit = 1; },
    value => { value.status = 'partial'; value.counts.unresolvedOverlap = 1; },
    value => { value.limitations.push('frame-content-omitted'); },
  ]) {
    const incoherent = await completeArtifact();
    mutate(incoherent);
  assert.throws(() => validateAnnotationMapArtifact(incoherent), /limitaç|contagens?|parcial|omiss/iu);
  }
});

/** Geometria mínima válida só para exercitar a regra da linha-guia. */
function geometryWithLeader(marker, sourceRect = { x: 10, y: 10, width: 100, height: 50 }) {
  return {
    coordinateSpace: 'document-css-px',
    sourceCssSize: { width: 300, height: 200 },
    sourcePixelSize: { width: 300, height: 200 },
    scaleX: 1,
    scaleY: 1,
    deviceScaleFactor: null,
    annotations: [{
      number: 1, nodeId: 'n-1', sourceRect,
      marker: { ...markerFor(1, sourceRect, marker.x, marker.y, 300), ...marker },
      segmentIndex: 1,
    }],
  };
}

test('declares the algorithm version that matches the drawn geometry', () => {
  // 1.0.0 → 1.1.0: contorno do alvo. 1.1.0 → 1.2.0: a linha-guia terminava no centro do elemento e
  // riscava o conteúdo; agora termina na borda do contorno. 1.2.0 → 1.3.0: o círculo numerado e a
  // legenda raster saem de cena e entram a caixa com o código (L1, L2…) e a legenda na coluna ao lado.
  // O mapa guardado é versionado: um artefato com a versão anterior deixa de ser aceito, e o bump é a
  // marca disso.
  assert.equal(ANNOTATION_MAP_ALGORITHM, 'audita.annotation-map');
  assert.equal(ANNOTATION_MAP_VERSION, '1.3.0');
  assert.equal(ANNOTATION_MAP_LEADER_MIN_PX, 6);
});

test('ends the leader line on the nearest point of the element rect, never on its centre', async () => {
  // À direita do contorno: a ponta é a borda direita, na mesma altura do marcador.
  await hashAnnotationMapGeometry(geometryWithLeader({ x: 150, y: 35, leaderX: 110, leaderY: 35 }));
  // Abaixo: a ponta é a borda inferior, na mesma coluna.
  await hashAnnotationMapGeometry(geometryWithLeader({ x: 60, y: 100, leaderX: 60, leaderY: 60 }));
  // Na diagonal: a ponta é o canto mais próximo.
  await hashAnnotationMapGeometry(geometryWithLeader({ x: 150, y: 100, leaderX: 110, leaderY: 60 }));
  // A regra antiga — ponta no centro do elemento — não passa mais.
  await assert.rejects(hashAnnotationMapGeometry(geometryWithLeader({ x: 150, y: 35, leaderX: 60, leaderY: 35 })),
    /Bounds da anotação geométrica 1/u);
  // Nem uma ponta torta que não seja a projeção exata.
  await assert.rejects(hashAnnotationMapGeometry(geometryWithLeader({ x: 150, y: 35, leaderX: 110, leaderY: 40 })),
    /Bounds da anotação geométrica 1/u);
});

test('suppresses the leader line when the marker already touches the outline', async () => {
  // Exatamente no mínimo (6 px) a linha existe — no eixo e na diagonal (3, 4, 5 não serve: 5 fica abaixo).
  await hashAnnotationMapGeometry(geometryWithLeader({ x: 116, y: 35, leaderX: 110, leaderY: 35 }));
  await hashAnnotationMapGeometry(geometryWithLeader({ x: 116, y: 34, leaderX: 110, leaderY: 34 }));
  // Abaixo do mínimo — a 5,9 px, sobre a própria borda e dentro do contorno — a ponta é o próprio
  // marcador: linha de comprimento zero, que o desenho não traça. Guardar a borda deixaria um fio
  // atravessando a folga que o escurecimento agora mantém clara.
  for (const [x, y] of [[115.9, 35], [110, 35], [60, 35]]) {
    await hashAnnotationMapGeometry(geometryWithLeader({ x, y, leaderX: x, leaderY: y }));
    await assert.rejects(hashAnnotationMapGeometry(geometryWithLeader({ x, y, leaderX: 10, leaderY: 10 })),
      /Bounds da anotação geométrica 1/u);
  }
});

test('accepts the optional count of elements hidden by an inner scrollport and keeps older maps valid', async () => {
  // Mapas guardados antes desse campo seguem válidos: a chave é opcional e ausente vale zero.
  const stored = await completeArtifact();
  assert.equal('omittedClipped' in stored.counts, false);
  assert.equal(validateAnnotationMapArtifact(stored), stored);

  const clipped = await completeArtifact();
  clipped.status = 'partial';
  clipped.counts = { ...clipped.counts, eligible: 3, omittedClipped: 2 };
  clipped.limitations = [...clipped.limitations, 'ancestor-clipped-elements-omitted'];
  clipped.hash = await hashAnnotationMapArtifact(clipped);

  assert.equal(validateAnnotationMapArtifact(clipped), clipped);
  assert.equal(await hashAnnotationMapArtifact(clipped), clipped.hash, 'a contagem entra no hash derivado');
});

test('rejects a clipped-omission count that contradicts its limitation or the eligible total', async () => {
  const clipped = value => {
    value.status = 'partial';
    value.counts = { ...value.counts, eligible: 3, omittedClipped: 2 };
    value.limitations = [...value.limitations, 'ancestor-clipped-elements-omitted'];
  };
  for (const mutate of [
    // Contagem sem a limitação que a explica.
    value => { value.status = 'partial'; value.counts = { ...value.counts, eligible: 3, omittedClipped: 2 }; },
    // Limitação sem contagem alguma.
    value => { value.limitations = [...value.limitations, 'ancestor-clipped-elements-omitted']; },
    // Total de elegíveis que ignora o que ficou escondido.
    value => {
      clipped(value);
      value.counts = { ...value.counts, eligible: 1 };
    },
    // O conjunto de contagens continua fechado: chave nova não passa.
    value => { value.counts = { ...value.counts, omittedHidden: 1 }; },
    // Estado completo não pode carregar omissão material.
    value => { clipped(value); value.status = 'complete'; },
    // Contagem negativa ou fracionária.
    value => { clipped(value); value.counts = { ...value.counts, omittedClipped: -1 }; },
  ]) {
    const artifact = await completeArtifact();
    mutate(artifact);
    assert.throws(() => validateAnnotationMapArtifact(artifact), TypeError);
  }
});

test('rejects an empty status when a closed shadow root makes coverage materially partial', async () => {
  const artifact = await completeArtifact();
  artifact.status = 'empty';
  artifact.segments = [];
  artifact.legend = [];
  artifact.derivation.geometry.annotations = [];
  artifact.counts = { eligible: 0, annotated: 0, omittedNoRect: 0, omittedFrame: 0, omittedLimit: 0, unresolvedOverlap: 0 };
  artifact.limitations.push('closed-shadow-root-omitted');

  assert.throws(() => validateAnnotationMapArtifact(artifact), /vazio|parcial|limitaç|cobertura/iu);
});

test('rejects a persisted segment whose raster ratio exceeds the printable algorithm bound', async () => {
  const artifact = await completeArtifact();
  const bytes = rgbaPng(1, 2);
  artifact.segments[0].height = 2;
  artifact.segments[0].dataUrl = `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;

  assert.throws(() => validateAnnotationMapArtifact(artifact), /proporção|imprimível|segmento/iu);
});

test('rejects a persisted image segment too short to contain its declared source raster clip', async () => {
  const artifact = await completeArtifact();
  // O recorte declara 100 px CSS de origem, mas o raster guardado tem só 40 linhas.
  artifact.segments[0].sourceCssClip.height = 100;
  artifact.segments[0].height = 40;
  artifact.segments[0].dataUrl = segmentRaster(PAGE.width, 40).dataUrl;

  await assert.rejects(hashAnnotationMapArtifact(artifact), /altura|raster|recorte|segmento/iu);
});

/** Página partida em duas metades, para exercitar a que trecho cada anotação pertence. */
function splitPage() {
  const half = { dataUrl: segmentRaster(PAGE.width, PAGE.height / 2).dataUrl, height: PAGE.height / 2 };
  return [
    {
      segmentId: 'announcement-map-test-segment-1', index: 1, count: 2, role: 'image',
      sourceCssClip: { x: 0, y: 0, width: PAGE.width, height: 50 },
      width: PAGE.width, height: half.height, dataUrl: half.dataUrl, contentHash: '0'.repeat(64),
    },
    {
      segmentId: 'announcement-map-test-segment-2', index: 2, count: 2, role: 'image',
      sourceCssClip: { x: 0, y: 50, width: PAGE.width, height: 50 },
      width: PAGE.width, height: half.height, dataUrl: half.dataUrl, contentHash: '0'.repeat(64),
    },
  ];
}

async function splitArtifact() {
  const artifact = await completeArtifact();
  const segments = splitPage();
  for (const segment of segments) segment.contentHash = await sha256Hex(Buffer.from(segment.dataUrl.split(',')[1], 'base64'));
  artifact.segments = segments;
  return artifact;
}

test('requires each annotation center and marker to belong to its declared image segment', async () => {
  const artifact = await splitArtifact();
  // A anotação declara o primeiro trecho, mas o centro e o marcador caem na segunda metade.
  const rect = { x: 8, y: 60, width: 40, height: 16 };
  artifact.derivation.geometry.annotations[0].sourceRect = rect;
  artifact.derivation.geometry.annotations[0].marker = markerFor(1, rect, 16, 76);
  artifact.derivation.geometrySnapshotHash = await hashAnnotationMapGeometry(artifact.derivation.geometry);

  assert.throws(() => validateAnnotationMapArtifact(artifact), /segmento|recorte|marcador|anotação/iu);
});

test('treats an exact non-final lower clip boundary as belonging to the next image segment', async () => {
  const artifact = await splitArtifact();
  // O centro do alvo cai exatamente na fronteira: 50 pertence ao segundo trecho, nunca ao primeiro.
  const rect = { x: 8, y: 42, width: 40, height: 16 };
  artifact.derivation.geometry.annotations[0].sourceRect = rect;
  artifact.derivation.geometry.annotations[0].marker = markerFor(1, rect, 16, 76);
  artifact.derivation.geometrySnapshotHash = await hashAnnotationMapGeometry(artifact.derivation.geometry);

  assert.throws(() => validateAnnotationMapArtifact(artifact), /segmento|recorte|marcador|anotação/iu);
});

test('accepts canonical fractional composer clips within numeric tolerance across many image segments', async () => {
  const artifact = await completeArtifact();
  // Cada trecho tem ~20 px CSS: espaço suficiente para a caixa do código caber dentro do recorte.
  const cssHeight = 62 * 20 + 0.4;
  const segmentHeight = cssHeight / 62;
  const raster = segmentRaster(PAGE.width, 24);
  const rasterHash = await sha256Hex(Buffer.from(raster.dataUrl.split(',')[1], 'base64'));
  artifact.derivation.geometry.sourceCssSize.height = cssHeight;
  artifact.derivation.geometry.sourcePixelSize.height = 1253;
  artifact.derivation.geometry.scaleY = 1.01;
  const rect = { x: 8, y: 8, width: 40, height: 4 };
  artifact.derivation.geometry.annotations[0].sourceRect = rect;
  artifact.derivation.geometry.annotations[0].marker = markerFor(1, rect, 16, 10);
  artifact.segments = Array.from({ length: 62 }, (_, offset) => {
    const y = offset * segmentHeight;
    return {
      ...structuredClone(artifact.segments[0]),
      segmentId: `announcement-map-test-segment-${offset + 1}`,
      index: offset + 1,
      count: 62,
      sourceCssClip: { x: 0, y, width: PAGE.width, height: offset === 61 ? cssHeight - y : segmentHeight },
      height: raster.height,
      dataUrl: raster.dataUrl,
      contentHash: rasterHash,
    };
  });
  artifact.derivation.geometrySnapshotHash = await hashAnnotationMapGeometry(artifact.derivation.geometry);
  artifact.hash = await hashAnnotationMapArtifact(artifact);

  assert.equal(validateAnnotationMapArtifact(artifact), artifact);
});

test('rejects a structurally valid derived PNG inflate bomb during integrity hashing', async () => {
  const artifact = await completeArtifact();
  const bytes = inflateBombPng(PAGE.width, PAGE.height);
  artifact.segments[0].dataUrl = `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;
  artifact.segments[0].contentHash = await sha256Hex(bytes);

  await assert.rejects(hashAnnotationMapArtifact(artifact), /raster|IHDR|scanline|tamanho/iu);
});
