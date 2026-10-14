import assert from 'node:assert/strict';
import test from 'node:test';

import {
  KEYBOARD_MAP_ALGORITHM,
  KEYBOARD_MAP_LIMITS,
  KEYBOARD_MAP_VERSION,
  hashKeyboardMapArtifact,
  hashKeyboardMapGeometry,
  keyboardMapStatus,
  validateKeyboardMapArtifact,
} from '../../src/core/keyboard/keyboard-map-artifact.js';
import { hashEvidenceArtifact } from '../../src/core/evidence/artifact-hash.js';
import { pngDataUrlFromBytes } from '../../src/core/evidence/png.js';
import { sha256Hex } from '../../src/core/report/hash.js';
import { buildPng } from '../support/png-fixture.js';

const SOURCE_BYTES = buildPng({ width: 10, height: 10 });
const SOURCE_URL = pngDataUrlFromBytes(SOURCE_BYTES);
const SOURCE_HASH = await sha256Hex(SOURCE_BYTES);

async function keyboardArtifact(overrides = {}) {
  const geometry = {
    coordinateSpace: 'document-css-px',
    sourceCssSize: { width: 10, height: 10 },
    sourcePixelSize: { width: 10, height: 10 },
    scaleX: 1,
    scaleY: 1,
    deviceScaleFactor: 2,
  };
  const artifact = {
    evidenceId: 'keyboard-map-test',
    pageId: 'page-1',
    kind: 'keyboard-map',
    state: 'derived',
    fullPageEvidenceId: 'full-page-test',
    derivation: {
      type: 'annotated-keyboard-map',
      algorithm: KEYBOARD_MAP_ALGORITHM,
      version: KEYBOARD_MAP_VERSION,
      sourceEvidenceId: 'full-page-test',
      sourceHash: SOURCE_HASH,
      geometry,
    },
    status: 'complete',
    segments: [{
      segmentId: 'keyboard-map-test-segment-1',
      index: 1,
      count: 1,
      role: 'image',
      sourceCssClip: { x: 0, y: 0, width: 10, height: 10 },
      width: 10,
      height: 10,
      dataUrl: SOURCE_URL,
      contentHash: SOURCE_HASH,
    }],
    stops: [{
      number: 1,
      nodeId: 'n-1',
      tag: 'button',
      kind: 'button',
      tabIndex: 0,
      name: 'Salvar',
      nameSource: 'accessibility-tree',
      nameStatus: 'projected',
      bounds: { x: 1, y: 1, width: 4, height: 4 },
      segmentIndex: 1,
    }],
    suspects: [{
      number: 1,
      nodeId: 'n-2',
      tag: 'div',
      role: 'button',
      reason: 'interactive-role',
      ruleId: null,
      name: 'Serviços',
      nameSource: 'contents',
      nameStatus: 'projected',
      bounds: { x: 1, y: 6, width: 4, height: 3 },
      segmentIndex: 1,
    }],
    counts: {
      eligible: 1, stops: 1, suspects: 1,
      omittedNotVisible: 0, omittedNoRect: 0, omittedClipped: 0, omittedFrame: 0, omittedLimit: 0,
    },
    limits: { ...KEYBOARD_MAP_LIMITS },
    limitations: ['tab-order-estimated-not-observed', 'top-document-open-shadow-only'],
    hash: '0'.repeat(64),
    ...overrides,
  };
  artifact.hash = await hashKeyboardMapArtifact(artifact);
  return artifact;
}

const SOURCE_ARTIFACT = {
  evidenceId: 'full-page-test', pageId: 'page-1', kind: 'full-page', state: 'pristine',
  dataUrl: SOURCE_URL, hash: SOURCE_HASH,
};

test('valida a derivação fechada e recomputa os hashes de segmento, geometria e do grupo', async () => {
  const artifact = await keyboardArtifact();

  assert.equal(validateKeyboardMapArtifact(artifact, { sourceArtifact: SOURCE_ARTIFACT }), artifact);
  assert.equal(await hashKeyboardMapArtifact(artifact, { sourceArtifact: SOURCE_ARTIFACT }), artifact.hash);
  assert.equal(await hashEvidenceArtifact(artifact, { sourceArtifact: SOURCE_ARTIFACT }), artifact.hash);

  const changedGeometry = structuredClone(artifact);
  changedGeometry.derivation.geometry.scaleX = 2;
  await assert.rejects(hashKeyboardMapArtifact(changedGeometry), /escala|geometria/iu);

  const changedBytes = structuredClone(artifact);
  changedBytes.segments[0].contentHash = 'f'.repeat(64);
  await assert.rejects(hashKeyboardMapArtifact(changedBytes), /segmento|hash/iu);
});

test('rejeita campo inventado em qualquer nível do esquema', async () => {
  const artifact = await keyboardArtifact();

  for (const mutate of [
    value => { value.extra = 'x'; },
    value => { value.derivation.extra = 'x'; },
    value => { value.derivation.geometry.extra = 'x'; },
    value => { value.segments[0].extra = 'x'; },
    value => { value.stops[0].extra = 'x'; },
    value => { value.suspects[0].extra = 'x'; },
    value => { value.counts.extra = 0; },
    value => { value.limits.extra = 0; },
  ]) {
    const tampered = structuredClone(artifact);
    mutate(tampered);
    assert.throws(() => validateKeyboardMapArtifact(tampered), TypeError);
  }
});

test('rejeita origem de outra página, não pristine ou com hash divergente', async () => {
  const artifact = await keyboardArtifact();

  for (const sourceArtifact of [
    { ...SOURCE_ARTIFACT, pageId: 'outra' },
    { ...SOURCE_ARTIFACT, kind: 'element' },
    { ...SOURCE_ARTIFACT, state: 'redacted' },
    { ...SOURCE_ARTIFACT, hash: 'a'.repeat(64) },
    { ...SOURCE_ARTIFACT, evidenceId: 'outro-full' },
  ]) {
    assert.throws(() => validateKeyboardMapArtifact(artifact, { sourceArtifact }), /origem|Origem/u);
  }
});

test('rejeita contagens, estado, limitações e vínculos incoerentes', async () => {
  const artifact = await keyboardArtifact();

  const cases = [
    [value => { value.counts.stops = 2; }, /Contagens/u],
    [value => { value.counts.eligible = 5; }, /Contagens/u],
    [value => { value.counts.omittedFrame = 1; }, /incoerentes|Limita/iu],
    [value => { value.limitations.pop(); }, /obrigatórias/u],
    [value => { value.limitations.push('limitação-inventada'); }, /Limita/iu],
    [value => { value.limitations = [...value.limitations].reverse(); }, /Limita/iu],
    [value => { value.limitations.push('stop-limit-reached'); }, /incoerentes|Estado/u],
    [value => { value.status = 'partial'; }, /Estado/u],
    [value => { value.stops[0].number = 2; }, /parada|Parada/iu],
    [value => { value.stops[0].segmentIndex = 2; }, /segmentIndex/u],
    [value => { value.stops[0].bounds = { x: 1, y: 1, width: 4, height: 40 }; }, /fora da área/u],
    [value => { value.stops[0].nameStatus = 'omitted-privacy'; }, /nome omitido/u],
    [value => { value.stops[0].kind = 'inventado'; }, /kind/u],
    [value => { value.stops[0].tabIndex = -1; }, /tabIndex/u],
    [value => { value.suspects[0].reason = 'inventado'; }, /reason/u],
    [value => { value.suspects[0].ruleId = 'hover-only-interactive-content'; }, /regra sem motivo/u],
    [value => { value.suspects[0].role = 'Botão'; }, /role/u],
    [value => { value.segments[0].sourceCssClip = { x: 2, y: 0, width: 10, height: 10 }; }, /canônico/u],
    [value => { value.segments[0].height = 40; }, /Proporção|Dimensões/u],
  ];
  for (const [mutate, pattern] of cases) {
    const tampered = structuredClone(artifact);
    mutate(tampered);
    assert.throws(() => validateKeyboardMapArtifact(tampered), pattern);
  }
});

test('aceita suspeito de regra de teclado, pixels omitidos por orçamento e duas fatias', async () => {
  const twoSegments = await keyboardArtifact({
    segments: [
      {
        segmentId: 'keyboard-map-test-segment-1', index: 1, count: 2, role: 'image',
        sourceCssClip: { x: 0, y: 0, width: 10, height: 5 }, width: 10, height: 5,
        dataUrl: pngDataUrlFromBytes(buildPng({ width: 10, height: 5 })),
        contentHash: await sha256Hex(buildPng({ width: 10, height: 5 })),
      },
      {
        segmentId: 'keyboard-map-test-segment-2', index: 2, count: 2, role: 'image',
        sourceCssClip: { x: 0, y: 5, width: 10, height: 5 }, width: 10, height: 5,
        dataUrl: pngDataUrlFromBytes(buildPng({ width: 10, height: 5 })),
        contentHash: await sha256Hex(buildPng({ width: 10, height: 5 })),
      },
    ],
    suspects: [{
      number: 1, nodeId: 'n-2', tag: 'div', role: 'generic', reason: 'keyboard-rule',
      ruleId: 'hover-only-interactive-content', name: 'Serviços', nameSource: 'contents',
      nameStatus: 'projected', bounds: { x: 1, y: 6, width: 4, height: 3 }, segmentIndex: 2,
    }],
  });
  assert.equal(validateKeyboardMapArtifact(twoSegments), twoSegments);

  // Item apontando para a fatia errada: o centro não cai no recorte declarado.
  const wrongSegment = structuredClone(twoSegments);
  wrongSegment.suspects[0].segmentIndex = 1;
  assert.throws(() => validateKeyboardMapArtifact(wrongSegment), /recorte do segmento declarado/u);

  const omitted = structuredClone(twoSegments);
  omitted.pixelState = 'omitted-budget';
  omitted.pixelContentHash = 'c'.repeat(64);
  omitted.limitations = ['tab-order-estimated-not-observed', 'top-document-open-shadow-only', 'frame-content-omitted'];
  // `eligible` conta candidatos a *parada*: sem paradas, zero.
  omitted.counts = { ...omitted.counts, stops: 0, suspects: 1, omittedFrame: 1, eligible: 0 };
  omitted.stops = [];
  omitted.status = keyboardMapStatus({
    stops: [], suspects: omitted.suspects, segments: [], limitations: omitted.limitations, pixelsOmitted: true,
  });
  omitted.segments = omitted.segments.map(segment => {
    const { dataUrl, ...rest } = segment;
    return rest;
  });
  omitted.hash = '0'.repeat(64);
  assert.equal(omitted.status, 'partial');
  assert.equal(validateKeyboardMapArtifact(omitted), omitted);
  omitted.hash = await hashKeyboardMapArtifact({ ...omitted, hash: '0'.repeat(64) });
  assert.equal(await hashEvidenceArtifact(omitted), omitted.hash);
});

test('aceita mapa vazio, sem paradas nem suspeitos', async () => {
  const artifact = await keyboardArtifact({
    segments: [], stops: [], suspects: [],
    counts: { eligible: 0, stops: 0, suspects: 0, omittedNotVisible: 0, omittedNoRect: 0, omittedClipped: 0, omittedFrame: 0, omittedLimit: 0 },
    status: 'empty',
  });

  assert.equal(validateKeyboardMapArtifact(artifact), artifact);
  assert.equal(await hashKeyboardMapArtifact(artifact), artifact.hash);
});
