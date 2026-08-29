import assert from 'node:assert/strict';
import test from 'node:test';

import { applyBatchEvidenceBudget } from '../../src/core/batch/evidence-budget.js';
import { createAnnotationMapFixture, createPristineMapSource } from '../report/annotation-map-fixture.js';

const pixel = bytes => `data:image/png;base64,${Buffer.alloc(bytes).toString('base64')}`;

test('retains pixels in page order until the total budget and then preserves metadata/hash as partial', async () => {
  const firstHash = 'a'.repeat(64);
  const secondHash = 'b'.repeat(64);
  const pageResult = {
    page: { pageId: 'page-1', status: 'complete', diagnostics: [], limitations: [] },
    evidence: [
      { evidenceId: 'evidence-1', pageId: 'page-1', kind: 'element', dataUrl: pixel(8), hash: firstHash },
      { evidenceId: 'evidence-2', pageId: 'page-1', kind: 'element', dataUrl: pixel(8), hash: secondHash },
      { evidenceId: 'evidence-3', pageId: 'page-1', kind: 'element', dataUrl: pixel(1), hash: 'd'.repeat(64) },
    ],
  };
  const applied = await applyBatchEvidenceBudget(pageResult, { usedBytes: 0, limitBytes: 10 });
  assert.equal(applied.usedBytes, 8);
  assert.equal(applied.exceeded, true);
  assert.equal(applied.result.evidence[0].dataUrl, pageResult.evidence[0].dataUrl);
  assert.equal(Object.hasOwn(applied.result.evidence[1], 'dataUrl'), false);
  assert.equal(applied.result.evidence[1].pixelState, 'omitted-budget');
  assert.equal(applied.result.evidence[1].pixelContentHash, secondHash);
  assert.notEqual(applied.result.evidence[1].hash, secondHash, 'o hash do artefato persistido é recalculado sem confiar no claim anterior');
  assert.equal(applied.result.page.status, 'partial');
  assert.equal(Object.hasOwn(applied.result.evidence[2], 'dataUrl'), false, 'após exceder, nenhum pixel posterior volta a ser retido');
  assert.equal(applied.result.page.diagnostics.at(-1).code, 'BATCH_EVIDENCE_BUDGET_EXCEEDED');
  assert.doesNotMatch(JSON.stringify(applied.result.evidence[1]), /data:image\/png;base64,/u);
});

test('retains a verifiable metadata-only map when its PNGs exceed the budget', async () => {
  const map = await createAnnotationMapFixture({ evidenceId: 'map-1', sourceEvidenceId: 'source-1' });
  const result = {
    page: { pageId: 'page-1', status: 'complete', diagnostics: [], limitations: [] },
    evidence: [map],
  };
  const applied = await applyBatchEvidenceBudget(result, { usedBytes: 0, limitBytes: 10 });
  assert.equal(applied.result.evidence.length, 1);
  assert.equal(applied.result.evidence[0].pixelState, 'omitted-budget');
  assert.equal(applied.result.evidence[0].pixelContentHash, map.hash);
  assert.equal(Object.hasOwn(applied.result.evidence[0].segments[0], 'dataUrl'), false);
  assert.deepEqual(applied.result.page.omittedEvidence, [{
    evidenceId: 'map-1', kind: 'announcement-map', contentHash: map.hash, reason: 'budget',
  }]);
});

test('resolves map to source dependencies before budgeting even when the map is listed first', async () => {
  const map = await createAnnotationMapFixture({ evidenceId: 'map-1', sourceEvidenceId: 'source-1' });
  const source = createPristineMapSource({ evidenceId: 'source-1' });
  const result = {
    page: { pageId: 'page-1', status: 'complete', diagnostics: [], limitations: [] },
    occurrences: [],
    evidence: [map, source],
  };
  const applied = await applyBatchEvidenceBudget(result, { limitBytes: 10 });
  assert.equal(applied.result.evidence.some(value =>
    value.kind === 'announcement-map' && value.pixelState === 'omitted-budget'), true);
  assert.equal(applied.result.evidence.find(value => value.evidenceId === 'source-1').pixelState, 'omitted-budget');
  assert.deepEqual(applied.result.page.omittedEvidence.map(value => value.evidenceId).sort(), ['map-1', 'source-1']);
});

test('never invents a budget omission for metadata-only evidence after the pixel budget is exhausted', async () => {
  const captureFailure = {
    code: 'ELEMENT_CAPTURE_FAILED',
    message: 'A miniatura do elemento não pôde ser capturada.',
    at: '2026-08-28T12:00:01.000Z',
    recoverable: true,
    details: { occurrenceId: 'occ-1' },
  };
  const evidence = {
    evidenceId: 'element-metadata-only',
    pageId: 'page-1',
    kind: 'element',
    nodeId: 'n-1',
    selector: { css: '#continuar' },
    snippet: '<button>Continuar</button>',
    hash: 'c'.repeat(64),
  };
  const pageResult = {
    page: {
      pageId: 'page-1', status: 'partial', diagnostics: [captureFailure], limitations: [],
      timestamps: { endedAt: '2026-08-28T12:00:01.000Z' },
    },
    evidence: [evidence],
  };

  const applied = await applyBatchEvidenceBudget(pageResult, {
    usedBytes: 10,
    limitBytes: 10,
    exhausted: true,
  });

  assert.equal(applied.exhausted, true);
  assert.equal(applied.exceeded, false);
  assert.equal(applied.usedBytes, 10);
  assert.deepEqual(applied.result.evidence, [evidence]);
  assert.deepEqual(applied.result.page.diagnostics, [captureFailure]);
  assert.equal(Object.hasOwn(applied.result.page, 'omittedEvidence'), false);
  assert.equal(Object.hasOwn(applied.result.evidence[0], 'pixelState'), false);
  assert.equal(Object.hasOwn(applied.result.evidence[0], 'pixelContentHash'), false);
});
