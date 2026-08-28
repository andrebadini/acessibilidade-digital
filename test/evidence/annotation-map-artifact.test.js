import assert from 'node:assert/strict';
import test from 'node:test';
import { deflateSync } from 'node:zlib';

import {
  ANNOTATION_MAP_ALGORITHM,
  ANNOTATION_MAP_LIMITS,
  ANNOTATION_MAP_VERSION,
  hashAnnotationMapArtifact,
  hashAnnotationMapGeometry,
  validateAnnotationMapArtifact,
} from '../../src/core/evidence/annotation-map-artifact.js';
import { hashEvidenceArtifact } from '../../src/core/evidence/artifact-hash.js';
import { sha256Hex } from '../../src/core/report/hash.js';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const PNG_HASH = '431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460';

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function inflateBombPng() {
  const chunk = (type, data) => {
    const typeBytes = Buffer.from(type, 'ascii');
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
    return Buffer.concat([length, typeBytes, data, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
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

async function completeArtifact() {
  const geometry = {
    coordinateSpace: 'document-css-px',
    sourceCssSize: { width: 1, height: 1 },
    sourcePixelSize: { width: 1, height: 1 },
    scaleX: 1,
    scaleY: 1,
    deviceScaleFactor: 2,
    annotations: [{
      number: 1,
      nodeId: 'n-1',
      sourceRect: { x: 0, y: 0, width: 1, height: 1 },
      marker: { x: 0.5, y: 0.5, size: 28, leaderX: 0.5, leaderY: 0.5 },
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
      role: 'image-and-legend',
      sourceCssClip: { x: 0, y: 0, width: 1, height: 1 },
      width: 1,
      height: 1,
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
    sourceRect: { x: 0, y: 0, width: 1, height: 1 },
    marker: { x: 0.5, y: 0.5, size: 28, leaderX: 0.5, leaderY: 0.5 }, segmentIndex: 1,
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
  artifact.derivation.geometry.sourceCssSize.height = 100;
  artifact.derivation.geometry.sourcePixelSize.height = 100;
  artifact.derivation.geometrySnapshotHash = await hashAnnotationMapGeometry(artifact.derivation.geometry);
  artifact.segments[0].sourceCssClip.height = 100;

  await assert.rejects(hashAnnotationMapArtifact(artifact), /altura|raster|recorte|segmento/iu);
});

test('requires each annotation center and marker to belong to its declared image segment', async () => {
  const artifact = await completeArtifact();
  artifact.derivation.geometry.sourceCssSize.height = 2;
  artifact.derivation.geometry.sourcePixelSize.height = 2;
  artifact.derivation.geometry.annotations[0].sourceRect = { x: 0, y: 1, width: 1, height: 1 };
  artifact.derivation.geometry.annotations[0].marker = { x: 0.5, y: 1.5, size: 28, leaderX: 0.5, leaderY: 1.5 };
  artifact.segments[0].sourceCssClip = { x: 0, y: 0, width: 1, height: 1 };
  artifact.segments[0].count = 2;
  artifact.segments.push({
    ...structuredClone(artifact.segments[0]), segmentId: 'announcement-map-test-segment-2', index: 2,
    sourceCssClip: { x: 0, y: 1, width: 1, height: 1 },
  });
  artifact.derivation.geometrySnapshotHash = await hashAnnotationMapGeometry(artifact.derivation.geometry);

  assert.throws(() => validateAnnotationMapArtifact(artifact), /segmento|recorte|marcador|anotação/iu);
});

test('treats an exact non-final lower clip boundary as belonging to the next image segment', async () => {
  const artifact = await completeArtifact();
  artifact.derivation.geometry.sourceCssSize.height = 2;
  artifact.derivation.geometry.sourcePixelSize.height = 2;
  artifact.derivation.geometry.annotations[0].sourceRect = { x: 0, y: 0.5, width: 1, height: 1 };
  artifact.derivation.geometry.annotations[0].marker = { x: 0.5, y: 1, size: 28, leaderX: 0.5, leaderY: 1 };
  artifact.segments[0].sourceCssClip = { x: 0, y: 0, width: 1, height: 1 };
  artifact.segments[0].count = 2;
  artifact.segments.push({
    ...structuredClone(artifact.segments[0]), segmentId: 'announcement-map-test-segment-2', index: 2,
    sourceCssClip: { x: 0, y: 1, width: 1, height: 1 },
  });

  assert.throws(() => validateAnnotationMapArtifact(artifact), /segmento|recorte|marcador|anotação/iu);
});

test('accepts canonical fractional composer clips within numeric tolerance across many image segments', async () => {
  const artifact = await completeArtifact();
  const cssHeight = 62 / 1.01;
  const segmentHeight = cssHeight / 62;
  artifact.derivation.geometry.sourceCssSize.height = cssHeight;
  artifact.derivation.geometry.sourcePixelSize.height = 62;
  artifact.derivation.geometry.scaleY = 1.01;
  artifact.segments = Array.from({ length: 62 }, (_, offset) => {
    const y = offset * segmentHeight;
    return {
      ...structuredClone(artifact.segments[0]),
      segmentId: `announcement-map-test-segment-${offset + 1}`,
      index: offset + 1,
      count: 62,
      sourceCssClip: { x: 0, y, width: 1, height: offset === 61 ? cssHeight - y : segmentHeight },
    };
  });
  artifact.derivation.geometrySnapshotHash = await hashAnnotationMapGeometry(artifact.derivation.geometry);
  artifact.hash = await hashAnnotationMapArtifact(artifact);

  assert.equal(validateAnnotationMapArtifact(artifact), artifact);
});

test('rejects a structurally valid derived PNG inflate bomb during integrity hashing', async () => {
  const artifact = await completeArtifact();
  const bytes = inflateBombPng();
  artifact.segments[0].dataUrl = `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;
  artifact.segments[0].contentHash = await sha256Hex(bytes);

  await assert.rejects(hashAnnotationMapArtifact(artifact), /raster|IHDR|scanline|tamanho/iu);
});
