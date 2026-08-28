import {
  ANNOTATION_MAP_ALGORITHM,
  ANNOTATION_MAP_LIMITS,
  ANNOTATION_MAP_VERSION,
  hashAnnotationMapArtifact,
  hashAnnotationMapGeometry,
} from '../../src/core/evidence/annotation-map-artifact.js';

export const TEST_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
export const TEST_PNG_HASH = '431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460';

export function createPristineMapSource({ evidenceId = 'ev-full', pageId = 'page-1' } = {}) {
  return {
    evidenceId, pageId, kind: 'full-page', state: 'pristine', dataUrl: TEST_PNG,
    metadata: { width: 1, height: 1 }, hash: TEST_PNG_HASH,
  };
}
export async function createAnnotationMapFixture({
  evidenceId = 'ev-map',
  sourceEvidenceId = 'ev-full',
  pageId = 'page-1',
  status = 'complete',
  preview = 'Salvar, botão',
} = {}) {
  const hasAnnotation = status !== 'empty';
  const geometry = {
    coordinateSpace: 'document-css-px',
    sourceCssSize: { width: 1, height: 1 },
    sourcePixelSize: { width: 1, height: 1 },
    scaleX: 1,
    scaleY: 1,
    deviceScaleFactor: 1,
    annotations: hasAnnotation ? [{
      number: 1, nodeId: 'n-map', sourceRect: { x: 0, y: 0, width: 1, height: 1 },
      marker: { x: 0.5, y: 0.5, size: 28, leaderX: 0.5, leaderY: 0.5 }, segmentIndex: 1,
    }] : [],
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
      segmentId: `${evidenceId}-segment-1`, index: 1, count: 1, role: 'image-and-legend',
      sourceCssClip: { x: 0, y: 0, width: 1, height: 1 }, width: 1, height: 1,
      dataUrl: TEST_PNG, contentHash: TEST_PNG_HASH,
    }] : [],
    legend: hasAnnotation ? [{
      number: 1, nodeId: 'n-map', selectorSummary: 'button', announcementPreview: preview,
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
