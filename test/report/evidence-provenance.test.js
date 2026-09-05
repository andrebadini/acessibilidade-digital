import assert from 'node:assert/strict';
import test from 'node:test';
import { projectTechnicalEvidence } from '../../src/review/report-view.js';

const pages = [
  { pageId: 'page-a', finalUrl: 'https://page.test/a', finalUrlObserved: true,
    timestamps: { startedAt: '2026-09-05T12:00:00.000Z', endedAt: '2026-09-05T12:00:01.000Z' } },
  { pageId: 'page-b', finalUrl: 'https://page.test/b', finalUrlObserved: true,
    timestamps: { startedAt: '2026-09-05T12:01:00.000Z', endedAt: '2026-09-05T12:01:02.000Z' } },
];

test('evidence provenance follows its exact page instead of the first page or media URL', () => {
  const model = { pages, evidence: [
    { evidenceId: 'ev-b', pageId: 'page-b', kind: 'element', mediaUrl: 'https://media.test/image.png' },
    { evidenceId: 'ev-a', pageId: 'page-a', kind: 'full-page' },
  ], finalUrl: 'https://foreign.test/', timestamps: pages[0].timestamps };
  const before = JSON.stringify(model);
  const projected = projectTechnicalEvidence(model);
  assert.deepEqual(projected.map(item => item.provenance), [
    { pageUrl: 'https://page.test/a', startedAt: '2026-09-05T12:00:00.000Z', endedAt: '2026-09-05T12:00:01.000Z' },
    { pageUrl: 'https://page.test/b', startedAt: '2026-09-05T12:01:00.000Z', endedAt: '2026-09-05T12:01:02.000Z' },
  ]);
  assert.equal(projected[1].mediaUrl, 'https://media.test/image.png');
  assert.equal(JSON.stringify(model), before);
  assert.ok(Object.isFrozen(projected[1].provenance));
  assert.equal(projected[1].observedAt, undefined, 'a page period is not an individual capture instant');
});

test('missing and ambiguous page identity never borrow global or neighboring provenance', () => {
  for (const candidatePages of [[], [pages[0]], [pages[1], { ...pages[1] }]]) {
    const projected = projectTechnicalEvidence({ pages: candidatePages,
      evidence: [{ evidenceId: 'ev-b', pageId: 'page-b', kind: 'element' }],
      finalUrl: 'https://foreign.test/', timestamps: pages[0].timestamps });
    assert.deepEqual(projected[0].provenance, { pageUrl: null, startedAt: null, endedAt: null });
  }
});

test('a requested URL is not presented as an observed page URL', () => {
  const projected = projectTechnicalEvidence({
    pages: [{ ...pages[0], finalUrl: null, finalUrlObserved: false, requestedUrl: 'https://requested.test/' }],
    evidence: [{ evidenceId: 'ev-a', pageId: 'page-a', kind: 'element' }],
  });
  assert.deepEqual(projected[0].provenance, { pageUrl: null,
    startedAt: '2026-09-05T12:00:00.000Z', endedAt: '2026-09-05T12:00:01.000Z' });
});
