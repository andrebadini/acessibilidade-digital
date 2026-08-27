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
