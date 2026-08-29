import assert from 'node:assert/strict';
import test from 'node:test';

import { dedupeFindingsForPresentation } from '../../src/core/axe/dedupe-findings.js';

function documentOccurrence({ id, engine, item = '5.13.2', outcome = 'failed', fakeKey = 'forged' }) {
  const axe = engine === 'axe-core';
  return {
    occurrenceId: id, pageId: 'page-1', outcome, nbrItemRef: item, ruleId: axe ? 'axe.html-has-lang' : 'page-language',
    equivalenceKey: fakeKey, presentationTargetKey: 'forged-target',
    target: { nodeId: null, selector: axe ? 'html' : null, framePath: [] },
    source: axe
      ? { engine, ruleId: 'axe.html-has-lang', engineRuleId: 'html-has-lang', version: '4.13.0' }
      : { engine, ruleId: 'page-language', version: '1.0.0' },
  };
}

test('groups only a curated document equivalence and ignores caller grouping keys', () => {
  const findings = [
    documentOccurrence({ id: 'occ-core', engine: 'audita-core', fakeKey: 'fake-a' }),
    documentOccurrence({ id: 'occ-axe', engine: 'axe-core', fakeKey: 'fake-b' }),
    { ...documentOccurrence({ id: 'occ-frame', engine: 'axe-core' }), target: { nodeId: null, selector: 'html', framePath: ['frame:2'] } },
    documentOccurrence({ id: 'occ-review', engine: 'axe-core', outcome: 'cantTell' }),
  ];
  const original = structuredClone(findings);
  const result = dedupeFindingsForPresentation(findings);

  assert.deepEqual(findings, original);
  assert.equal(result.groups.length, 3);
  const combined = result.groups.find(group => group.occurrenceIds.includes('occ-core'));
  assert.deepEqual(combined.occurrenceIds, ['occ-core', 'occ-axe']);
  assert.equal(combined.equivalenceKey, 'document-language-declaration');
  assert.equal(combined.presentationTargetKey, 'document');
  assert.equal(result.occurrenceCount, 4);
  assert.equal(result.hiddenOccurrenceCount, 0);
});

test('keeps ambiguous selectors, fake keys, different items and unrelated rule conditions separate', () => {
  const common = {
    pageId: 'page-1', outcome: 'failed', nbrItemRef: '5.13.13',
    target: { nodeId: null, selector: 'button', framePath: [] },
    equivalenceKey: 'same-forged-key', presentationTargetKey: 'node:forged',
  };
  const findings = [
    { ...common, occurrenceId: 'allowed', ruleId: 'axe.aria-allowed-attr', source: { engine: 'axe-core', ruleId: 'axe.aria-allowed-attr', engineRuleId: 'aria-allowed-attr', version: '4.13.0' } },
    { ...common, occurrenceId: 'required', ruleId: 'axe.aria-required-attr', source: { engine: 'axe-core', ruleId: 'axe.aria-required-attr', engineRuleId: 'aria-required-attr', version: '4.13.0' } },
    { ...documentOccurrence({ id: 'wrong-item', engine: 'axe-core' }), nbrItemRef: '5.13.1' },
    { ...documentOccurrence({ id: 'wrong-version', engine: 'axe-core' }), source: { engine: 'axe-core', ruleId: 'axe.html-has-lang', engineRuleId: 'html-has-lang', version: '99.0.0' } },
  ];
  const result = dedupeFindingsForPresentation(findings);
  assert.equal(result.groups.length, 4);
  assert.deepEqual(result.groups.map(group => group.occurrenceIds), [['allowed'], ['required'], ['wrong-item'], ['wrong-version']]);
});

function targetSizeOccurrence({ id, engine, nodeId = 'node-1' }) {
  const axe = engine === 'axe-core';
  return {
    occurrenceId: id, pageId: 'page-1', outcome: 'failed', nbrItemRef: '5.8.7',
    ruleId: axe ? 'axe.target-size' : 'target-size-minimum',
    equivalenceKey: 'minimum-target-size', presentationTargetKey: `node:${nodeId}`, nodeId,
    target: { nodeId, selector: axe ? 'html > body > button' : null, framePath: [] },
    source: axe
      ? { engine, ruleId: 'axe.target-size', engineRuleId: 'target-size', version: '4.13.0' }
      : { engine, ruleId: 'target-size-minimum', version: '1.0.0' },
  };
}

test('deduplicates node-scoped target-size only with an independent exact canonical-node binding', () => {
  const core = targetSizeOccurrence({ id: 'occ-core', engine: 'audita-core' });
  const axe = targetSizeOccurrence({ id: 'occ-axe', engine: 'axe-core' });
  const canonical = new Map([['occ-core', 'node-1'], ['occ-axe', 'node-1']]);

  const combined = dedupeFindingsForPresentation([core, axe], { canonicalNodeByOccurrenceId: canonical });
  assert.equal(combined.groups.length, 1);
  assert.deepEqual(combined.groups[0].occurrenceIds, ['occ-core', 'occ-axe']);
  assert.equal(combined.groups[0].equivalenceKey, 'minimum-target-size');
  assert.equal(combined.groups[0].presentationTargetKey, 'node:node-1');

  assert.equal(dedupeFindingsForPresentation([core, axe]).groups.length, 2, 'no external node authority');
  assert.equal(dedupeFindingsForPresentation([core, axe], {
    canonicalNodeByOccurrenceId: new Map([['occ-core', 'node-1'], ['occ-axe', 'node-2']]),
  }).groups.length, 2, 'different canonical nodes');

  const forged = targetSizeOccurrence({ id: 'occ-forged', engine: 'axe-core', nodeId: 'node-2' });
  assert.equal(dedupeFindingsForPresentation([core, forged], {
    canonicalNodeByOccurrenceId: new Map([['occ-core', 'node-1'], ['occ-forged', 'node-1']]),
  }).groups.length, 2, 'caller map cannot override the persisted node binding');
});
