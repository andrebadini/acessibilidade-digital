import { deflateSync } from 'node:zlib';

import {
  ANNOTATION_MAP_ALGORITHM,
  ANNOTATION_MAP_LIMITS,
  ANNOTATION_MAP_VERSION,
  annotationBadgeSize,
  annotationLeaderPoint,
  hashAnnotationMapArtifact,
  hashAnnotationMapGeometry,
} from '../../src/core/evidence/annotation-map-artifact.js';
import { sha256Hex } from '../../src/core/report/hash.js';

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** PNG uniforme do tamanho pedido: o suficiente para os artefatos derivados decodificarem dimensões reais. */
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
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(raster)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// A captura usada pelos mapas: 160×100 CSS em escala 1. O mapa da 1.3.0 precisa de espaço para a caixa
// do código (17×13 CSS no mínimo) e o recorte do segmento é sempre da largura inteira da captura, então
// uma origem de 1×1 não comporta mais nenhum mapa válido.
export const TEST_PAGE_CSS = Object.freeze({ width: 160, height: 100 });
export const TEST_PAGE_SCALE = 1;
export const TEST_PAGE_PIXELS = Object.freeze({
  width: TEST_PAGE_CSS.width * TEST_PAGE_SCALE,
  height: TEST_PAGE_CSS.height * TEST_PAGE_SCALE,
});
export const TEST_PNG_BYTES = rgbaPng(TEST_PAGE_PIXELS.width, TEST_PAGE_PIXELS.height);
export const TEST_PNG = `data:image/png;base64,${TEST_PNG_BYTES.toString('base64')}`;
// O hash do artefato é o do PNG decodificado, e não o da data URL: é o mesmo valor que a evidência
// original da captura e o conteúdo de cada segmento precisam declarar.
export const TEST_PNG_HASH = await sha256Hex(TEST_PNG_BYTES);

export function createPristineMapSource({ evidenceId = 'ev-full', pageId = 'page-1' } = {}) {
  return {
    evidenceId, pageId, kind: 'full-page', state: 'pristine', dataUrl: TEST_PNG,
    metadata: { ...TEST_PAGE_PIXELS }, hash: TEST_PNG_HASH,
  };
}
/**
 * Mapa guardado na versão anterior do algoritmo (1.2.0): número dentro da imagem e legenda raster, com
 * uma continuação de legenda depois do trecho de imagem. Serve para provar que uma auditoria antiga
 * continua abrindo com a apresentação com que foi gerada.
 */
export async function createLegacyAnnotationMapFixture({
  evidenceId = 'ev-map-legacy',
  sourceEvidenceId = 'ev-full',
  pageId = 'page-1',
  preview = 'Salvar, botão',
  version = '1.2.0',
} = {}) {
  const sourceRect = { x: 8, y: 8, width: 40, height: 16 };
  const marker = { x: 16, y: 60, size: 28, leaderX: 0, leaderY: 0 };
  const leader = annotationLeaderPoint(sourceRect, marker.x, marker.y);
  marker.leaderX = leader.x; marker.leaderY = leader.y;
  const geometry = {
    coordinateSpace: 'document-css-px',
    sourceCssSize: { ...TEST_PAGE_CSS },
    sourcePixelSize: { ...TEST_PAGE_PIXELS },
    scaleX: TEST_PAGE_SCALE,
    scaleY: TEST_PAGE_SCALE,
    deviceScaleFactor: TEST_PAGE_SCALE,
    annotations: [{ number: 1, nodeId: 'n-map', sourceRect, marker, segmentIndex: 1 }],
  };
  const artifact = {
    evidenceId, pageId, kind: 'announcement-map', state: 'derived', fullPageEvidenceId: sourceEvidenceId,
    derivation: {
      type: 'annotated-announcement-map', algorithm: ANNOTATION_MAP_ALGORITHM, version,
      sourceEvidenceId, sourceHash: TEST_PNG_HASH,
      geometrySnapshotHash: await hashAnnotationMapGeometry(geometry, { version }), geometry,
    },
    status: 'complete',
    segments: [
      {
        segmentId: `${evidenceId}-segment-1`, index: 1, count: 2, role: 'image-and-legend',
        sourceCssClip: { x: 0, y: 0, ...TEST_PAGE_CSS },
        width: TEST_PAGE_PIXELS.width, height: TEST_PAGE_PIXELS.height,
        dataUrl: TEST_PNG, contentHash: TEST_PNG_HASH,
      },
      {
        segmentId: `${evidenceId}-segment-2`, index: 2, count: 2, role: 'legend-continuation', sourceCssClip: null,
        width: TEST_PAGE_PIXELS.width, height: TEST_PAGE_PIXELS.height,
        dataUrl: TEST_PNG, contentHash: TEST_PNG_HASH,
      },
    ],
    legend: [{
      number: 1, nodeId: 'n-map', selectorSummary: 'button', announcementPreview: preview,
      nameSource: 'contents', segmentIndex: 1,
    }],
    counts: {
      eligible: 1, annotated: 1, omittedNoRect: 0, omittedFrame: 0, omittedLimit: 0, unresolvedOverlap: 0,
    },
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

export async function createAnnotationMapFixture({
  evidenceId = 'ev-map',
  sourceEvidenceId = 'ev-full',
  pageId = 'page-1',
  status = 'complete',
  preview = 'Salvar, botão',
} = {}) {
  const hasAnnotation = status !== 'empty';
  const number = 1;
  // Alvo pequeno à esquerda do alto da página; a caixa do código fica abaixo dele, com linha-guia.
  const sourceRect = { x: 8, y: 8, width: 40, height: 16 };
  const badge = annotationBadgeSize(number, TEST_PAGE_CSS.width);
  const marker = {
    x: sourceRect.x + 8, y: sourceRect.y + sourceRect.height + 36,
    width: badge.width, height: badge.height, leaderX: 0, leaderY: 0,
  };
  const leader = annotationLeaderPoint(sourceRect, marker.x, marker.y);
  marker.leaderX = leader.x; marker.leaderY = leader.y;
  const geometry = {
    coordinateSpace: 'document-css-px',
    sourceCssSize: { ...TEST_PAGE_CSS },
    sourcePixelSize: { ...TEST_PAGE_PIXELS },
    scaleX: TEST_PAGE_SCALE,
    scaleY: TEST_PAGE_SCALE,
    deviceScaleFactor: TEST_PAGE_SCALE,
    annotations: hasAnnotation ? [{ number, nodeId: 'n-map', sourceRect, marker, segmentIndex: 1 }] : [],
  };
  const partial = status === 'partial';
  const artifact = {
    evidenceId, pageId, kind: 'announcement-map', state: 'derived', fullPageEvidenceId: sourceEvidenceId,
    derivation: {
      type: 'annotated-announcement-map', algorithm: ANNOTATION_MAP_ALGORITHM, version: ANNOTATION_MAP_VERSION,
      sourceEvidenceId, sourceHash: TEST_PNG_HASH,
      geometrySnapshotHash: await hashAnnotationMapGeometry(geometry), geometry,
    },
    status,
    segments: hasAnnotation ? [{
      segmentId: `${evidenceId}-segment-1`, index: 1, count: 1, role: 'image',
      sourceCssClip: { x: 0, y: 0, ...TEST_PAGE_CSS }, width: TEST_PAGE_PIXELS.width, height: TEST_PAGE_PIXELS.height,
      dataUrl: TEST_PNG, contentHash: TEST_PNG_HASH,
    }] : [],
    legend: hasAnnotation ? [{
      number, nodeId: 'n-map', selectorSummary: 'button', announcementPreview: preview,
      nameSource: 'contents', segmentIndex: 1,
    }] : [],
    counts: {
      eligible: hasAnnotation ? 1 : 0, annotated: hasAnnotation ? 1 : 0, omittedNoRect: 0,
      omittedFrame: partial ? 1 : 0, omittedLimit: 0, unresolvedOverlap: 0,
    },
    limits: { ...ANNOTATION_MAP_LIMITS },
    limitations: [
      'observed-dom-ax-order-not-literal-assistive-technology',
      'non-atomic-source-geometry',
      'top-document-open-shadow-only',
      'rasterization-browser-dependent',
      'source-capture-may-contain-personal-data',
      ...(partial ? ['frame-content-omitted'] : []),
    ],
    hash: '0'.repeat(64),
  };
  artifact.hash = await hashAnnotationMapArtifact(artifact);
  return artifact;
}
