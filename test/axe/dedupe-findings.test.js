import assert from 'node:assert/strict';
import test from 'node:test';

import { dedupeFindingsForPresentation } from '../../src/core/axe/dedupe-findings.js';

function occurrence({ id, engine, selector, framePath = [], item = '5.13.10', outcome = 'failed', equivalenceKey = 'component-name-missing' }) {
  return {
    occurrenceId: id, pageId: 'page-1', outcome, nbrItemRef: item,
    equivalenceKey,
    target: { nodeId: null, selector, framePath },
    source: { engine, ruleId: `${engine}.rule`, version: '1.0.0' },
  };
}

test('deduplicates only the visual presentation and preserves every source occurrence', () => {
  const findings = [
    occurrence({ id: 'occ-core', engine: 'audita-core', selector: 'button:nth-of-type(1)' }),
    occurrence({ id: 'occ-axe', engine: 'axe-core', selector: 'button:nth-of-type(1)' }),
    occurrence({ id: 'occ-frame', engine: 'axe-core', selector: 'button:nth-of-type(1)', framePath: ['frame:2'] }),
    occurrence({ id: 'occ-review', engine: 'axe-core', selector: 'button:nth-of-type(1)', outcome: 'cantTell' }),
  ];
  const original = structuredClone(findings);

  const result = dedupeFindingsForPresentation(findings);

  assert.deepEqual(findings, original);
  assert.equal(result.groups.length, 3);
  const combined = result.groups.find(group => group.occurrenceIds.includes('occ-core'));
  assert.deepEqual(combined.occurrenceIds, ['occ-core', 'occ-axe']);
  assert.deepEqual(combined.sources.map(source => source.engine), ['audita-core', 'axe-core']);
  assert.equal(result.occurrenceCount, 4);
  assert.equal(result.hiddenOccurrenceCount, 0);
});

test('keeps distinct rule conditions separate even on the same item and target', () => {
  const findings = [
    occurrence({ id: 'occ-allowed', engine: 'axe-core', selector: 'button:nth-of-type(1)', item: '5.13.13', equivalenceKey: 'aria-allowed-attr' }),
    occurrence({ id: 'occ-required', engine: 'axe-core', selector: 'button:nth-of-type(1)', item: '5.13.13', equivalenceKey: 'aria-required-attr' }),
  ];

  const result = dedupeFindingsForPresentation(findings);

  assert.equal(result.groups.length, 2);
  assert.deepEqual(result.groups.map(group => group.occurrenceIds), [['occ-allowed'], ['occ-required']]);
});

test('does not merge findings without a stable page, target or condition identity', () => {
  const findings = [
    occurrence({ id: 'occ-a', engine: 'audita-core', selector: null, item: null, equivalenceKey: null }),
    occurrence({ id: 'occ-b', engine: 'axe-core', selector: null, item: null, equivalenceKey: null }),
  ];
  const result = dedupeFindingsForPresentation(findings);

  assert.equal(result.groups.length, 2);
  assert.deepEqual(result.groups.map(group => group.occurrenceIds), [['occ-a'], ['occ-b']]);
});
