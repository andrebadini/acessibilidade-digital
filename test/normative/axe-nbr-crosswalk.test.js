import assert from 'node:assert/strict';
import test from 'node:test';

import { AXE_ALLOWED_RULE_IDS } from '../../src/browser/axe-adapter.js';
import { NBR17225_ITEMS } from '../../src/core/normative/nbr17225.js';
import {
  AXE_NBR_CROSSWALK,
  axeEquivalenceForAuditaRule,
  axeNbrMappingForRule,
  validateAxeNbrCrosswalk,
} from '../../src/core/normative/axe-nbr-crosswalk.js';

test('curated axe mappings bind rule IDs to official ABNT items and WCAG criteria', () => {
  const imageAlt = axeNbrMappingForRule('image-alt');

  assert.deepEqual(imageAlt, {
    axeRuleId: 'image-alt',
    nbrItemRef: '5.2.1',
    wcagRefs: ['1.1.1'],
    rationale: 'Imagem de conteúdo sem alternativa textual programaticamente determinável.',
    applicability: 'confirmation-required',
  });
  assert.equal(axeNbrMappingForRule('unknown-rule'), null);
  assert.deepEqual(AXE_ALLOWED_RULE_IDS, AXE_NBR_CROSSWALK.map(entry => entry.axeRuleId),
    'the in-frame catalog and the curated normative catalog cannot drift');
  assert.equal(Object.isFrozen(AXE_NBR_CROSSWALK), true);
  assert.deepEqual(validateAxeNbrCrosswalk(), []);

  const itemById = new Map(NBR17225_ITEMS.map(item => [item.id, item]));
  for (const mapping of AXE_NBR_CROSSWALK) {
    const item = itemById.get(mapping.nbrItemRef);
    assert.ok(item, mapping.axeRuleId);
    assert.ok(mapping.wcagRefs.every(id => item.wcag.some(reference => reference.id === id)));
    assert.doesNotMatch(JSON.stringify(mapping), /section508|experimental/iu);
  }
});

test('publishes only explicit reviewed cross-engine equivalence keys', () => {
  const language = axeNbrMappingForRule('html-has-lang');
  assert.deepEqual(axeEquivalenceForAuditaRule('page-language'), {
    axeRuleId: 'html-has-lang', auditaRuleId: 'page-language',
    equivalenceKey: 'document-language-declaration', targetScope: 'document',
  });
  assert.equal(language.equivalenceKey, 'document-language-declaration');
  assert.equal(language.targetScope, 'document');
  assert.equal(axeEquivalenceForAuditaRule('content-image-alternative'), null);
});

test('binds axe target-size only to the minimum target-size rule on the same node', () => {
  assert.deepEqual(axeNbrMappingForRule('target-size'), {
    axeRuleId: 'target-size',
    nbrItemRef: '5.8.7',
    wcagRefs: ['2.5.8'],
    rationale: 'Alvo de acionamento observado abaixo do tamanho mínimo automatizável.',
    applicability: 'confirmation-required',
    auditaRuleId: 'target-size-minimum',
    equivalenceKey: 'minimum-target-size',
    targetScope: 'node',
  });
  assert.deepEqual(axeEquivalenceForAuditaRule('target-size-minimum'), {
    axeRuleId: 'target-size',
    auditaRuleId: 'target-size-minimum',
    equivalenceKey: 'minimum-target-size',
    targetScope: 'node',
  });
  assert.deepEqual(validateAxeNbrCrosswalk(), []);
});

test('crosswalk validation rejects tag inference, duplicate IDs and incompatible WCAG references', () => {
  const valid = AXE_NBR_CROSSWALK[0];
  assert.match(validateAxeNbrCrosswalk([valid, valid]).join('\n'), /duplicad|duplicate/i);
  assert.match(validateAxeNbrCrosswalk([{
    ...valid, axeRuleId: 'bad-wcag', wcagRefs: ['9.9.9'],
  }]).join('\n'), /wcag/i);
  assert.match(validateAxeNbrCrosswalk([{
    ...valid, axeRuleId: 'tag-derived', tags: ['wcag2aa'],
  }]).join('\n'), /tag/i);
});
