import {
  KEYBOARD_MAP_ALGORITHM,
  KEYBOARD_MAP_LIMITS,
  KEYBOARD_MAP_VERSION,
  hashKeyboardMapArtifact,
} from '../../src/core/keyboard/keyboard-map-artifact.js';
import {
  TEST_PAGE_CSS, TEST_PAGE_PIXELS, TEST_PNG, TEST_PNG_HASH, createPristineMapSource,
} from './annotation-map-fixture.js';

export { TEST_PNG, TEST_PNG_HASH, createPristineMapSource };

/**
 * Mapa do teclado mínimo e verificável para os testes de relatório.
 *
 * `status` decide o conteúdo, como no mapa de anúncios: `empty` não tem nada, `partial` declara a
 * limitação que o compõe (e exige o diagnóstico correspondente na página).
 */
export async function createKeyboardMapFixture({
  evidenceId = 'ev-keyboard-map',
  sourceEvidenceId = 'ev-full',
  pageId = 'page-1',
  status = 'complete',
  name = 'Consultar, botão',
} = {}) {
  const hasEntries = status !== 'empty';
  const partial = status === 'partial';
  const artifact = {
    evidenceId, pageId, kind: 'keyboard-map', state: 'derived', fullPageEvidenceId: sourceEvidenceId,
    derivation: {
      type: 'annotated-keyboard-map', algorithm: KEYBOARD_MAP_ALGORITHM, version: KEYBOARD_MAP_VERSION,
      sourceEvidenceId, sourceHash: TEST_PNG_HASH,
      geometry: {
        coordinateSpace: 'document-css-px',
        sourceCssSize: { ...TEST_PAGE_CSS },
        sourcePixelSize: { ...TEST_PAGE_PIXELS },
        scaleX: 1,
        scaleY: 1,
        deviceScaleFactor: 1,
      },
    },
    status,
    segments: hasEntries ? [{
      segmentId: `${evidenceId}-segment-1`, index: 1, count: 1, role: 'image',
      sourceCssClip: { x: 0, y: 0, ...TEST_PAGE_CSS },
      width: TEST_PAGE_PIXELS.width, height: TEST_PAGE_PIXELS.height,
      dataUrl: TEST_PNG, contentHash: TEST_PNG_HASH,
    }] : [],
    stops: [{
      number: 1, nodeId: 'n-stop', tag: 'button', kind: 'button', tabIndex: 0,
      name, nameSource: 'contents', nameStatus: 'projected',
      bounds: { x: 0, y: 0, width: 1, height: 1 }, segmentIndex: 1,
    }],
    suspects: [],
    counts: {
      eligible: hasEntries ? 1 : 0, stops: hasEntries ? 1 : 0, suspects: 0,
      omittedNotVisible: 0, omittedNoRect: 0, omittedClipped: 0,
      omittedFrame: partial ? 1 : 0, omittedLimit: 0,
    },
    limits: { ...KEYBOARD_MAP_LIMITS },
    limitations: [
      'tab-order-estimated-not-observed',
      'top-document-open-shadow-only',
      ...(partial ? ['frame-content-omitted'] : []),
    ],
    hash: '0'.repeat(64),
  };
  if (!hasEntries) {
    artifact.stops = [];
    artifact.limitations = ['tab-order-estimated-not-observed', 'top-document-open-shadow-only'];
  }
  artifact.hash = await hashKeyboardMapArtifact(artifact);
  return artifact;
}
