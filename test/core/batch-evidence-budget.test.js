import assert from 'node:assert/strict';
import test from 'node:test';

import { applyBatchEvidenceBudget } from '../../src/core/batch/evidence-budget.js';

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

test('drops a derived map atomically when one of its required PNGs exceeds the budget', async () => {
  const result = {
    page: { pageId: 'page-1', status: 'complete', diagnostics: [], limitations: [] },
    evidence: [{
      evidenceId: 'map-1', pageId: 'page-1', kind: 'announcement-map', hash: 'c'.repeat(64),
      segments: [{ segmentId: 'segment-1', dataUrl: pixel(20) }],
    }],
  };
  const applied = await applyBatchEvidenceBudget(result, { usedBytes: 0, limitBytes: 10 });
  assert.deepEqual(applied.result.evidence, []);
  assert.deepEqual(applied.result.page.omittedEvidence, [{
    evidenceId: 'map-1', kind: 'announcement-map', contentHash: 'c'.repeat(64), reason: 'budget',
  }]);
});
