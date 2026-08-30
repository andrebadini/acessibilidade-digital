import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BRAZILIAN_LEGAL_BASIS,
  CONSUMER_ACCESSIBILITY_FIXED_BASIS,
  consumerBasisForOccurrence,
  qualifiedConsumerReference,
} from '../../src/core/legal/consumer-basis.js';
import { NBR17225_ITEMS } from '../../src/core/normative/nbr17225.js';
import { validateNormativeData } from '../../src/core/normative/validate-normative-data.js';

const DISPLAY = 'Arts. 7º, caput, 20, § 2º, e 39, VIII, da Lei nº 8.078/1990, c/c art. 12, IX, “a”, do Decreto nº 2.181/1997.';
const QUALIFICATION = 'Referência normativa automatizada; não constitui conclusão automática de infração, responsabilidade, sanção, certificação jurídica ou dispensa de revisão humana.';

test('returns one immutable Brazilian consumer basis with exactly two official Câmara sources', () => {
  assert.equal(CONSUMER_ACCESSIBILITY_FIXED_BASIS.id, 'br.consumer.accessibility.fixed.v1');
  assert.equal(CONSUMER_ACCESSIBILITY_FIXED_BASIS.label, 'Base consumerista padronizada para análise');
  assert.equal(CONSUMER_ACCESSIBILITY_FIXED_BASIS.display, DISPLAY);
  assert.equal(CONSUMER_ACCESSIBILITY_FIXED_BASIS.qualification, QUALIFICATION);
  assert.equal(Object.hasOwn(CONSUMER_ACCESSIBILITY_FIXED_BASIS, 'currentTextCaveatRef'), false);
  assert.equal(CONSUMER_ACCESSIBILITY_FIXED_BASIS.sources.length, 2);
  assert.deepEqual(CONSUMER_ACCESSIBILITY_FIXED_BASIS.sources.map(source => source.publisher), ['Câmara dos Deputados', 'Câmara dos Deputados']);
  assert.deepEqual(CONSUMER_ACCESSIBILITY_FIXED_BASIS.sources.map(source => source.verifiedAt), ['2026-08-29', '2026-08-29']);
  assert.equal(CONSUMER_ACCESSIBILITY_FIXED_BASIS.sources.every(source => /^https:\/\/www2\.camara\.leg\.br\//u.test(source.url)), true);
  assert.equal(BRAZILIAN_LEGAL_BASIS.consumerAccessibilityFixed, CONSUMER_ACCESSIBILITY_FIXED_BASIS);
  assert.ok(Object.isFrozen(BRAZILIAN_LEGAL_BASIS));
  assert.ok(Object.isFrozen(CONSUMER_ACCESSIBILITY_FIXED_BASIS));
  assert.ok(Object.isFrozen(CONSUMER_ACCESSIBILITY_FIXED_BASIS.sources));
  assert.ok(CONSUMER_ACCESSIBILITY_FIXED_BASIS.sources.every(Object.isFrozen));
});

test('qualifies original and reviewed nonconformity without mutating the canonical occurrence', () => {
  const item = NBR17225_ITEMS.find(value => value.id === '5.1.1');
  const original = Object.freeze({
    occurrenceId: 'occ-1', itemId: item.id, nbrItemRef: item.id, outcome: 'failed', classification: 'requirement',
    legalAnalysis: Object.freeze({ basisRef: CONSUMER_ACCESSIBILITY_FIXED_BASIS.id }),
  });
  const before = structuredClone(original);
  const direct = qualifiedConsumerReference({ occurrence: original, item, displayOutcome: 'failed', decision: null, normativeItems: NBR17225_ITEMS });
  assert.match(direct.text, /A referida desconformidade infringe/u);
  assert.match(direct.text, /item 5\.1\.1 da ABNT NBR 17225:2025\.$/u);
  assert.equal(direct.label, 'Referência técnica e jurídica qualificada');
  assert.equal(direct.qualification, QUALIFICATION);
  assert.deepEqual(original, before);

  const review = Object.freeze({ ...original, occurrenceId: 'occ-2', outcome: 'cantTell', legalAnalysis: null });
  const decision = Object.freeze({
    decisionId: 'occ-2', auditId: 'audit-1', itemId: item.id, occurrenceId: 'occ-2', answer: 'não conforme',
    evaluator: 'Pessoa avaliadora', decidedAt: '2026-08-29T12:00:00.000Z', mode: 'manual', note: 'Verificação humana documentada.',
  });
  assert.ok(qualifiedConsumerReference({ occurrence: review, item, displayOutcome: 'failed', decision, normativeItems: NBR17225_ITEMS }));
  assert.equal(qualifiedConsumerReference({ occurrence: review, item, displayOutcome: 'failed', decision: { ...decision, note: '' }, normativeItems: NBR17225_ITEMS }), null);
  assert.equal(qualifiedConsumerReference({ occurrence: review, item, displayOutcome: 'passed', decision, normativeItems: NBR17225_ITEMS }), null);
});

test('associates the fixed basis with every conclusive failed ABNT occurrence, including recommendations', () => {
  assert.equal(
    consumerBasisForOccurrence({ outcome: 'failed', itemId: '5.1.1' }),
    CONSUMER_ACCESSIBILITY_FIXED_BASIS
  );
  assert.equal(
    consumerBasisForOccurrence({ outcome: 'failed', nbrItemRef: { id: '5.1.2' } }),
    CONSUMER_ACCESSIBILITY_FIXED_BASIS
  );
});

test('does not associate a legal basis with inconclusive, untested, inapplicable, or editorial findings', () => {
  for (const outcome of ['cantTell', 'untested', 'inapplicable', 'passed']) {
    assert.equal(consumerBasisForOccurrence({ outcome, itemId: '5.1.1' }), null, outcome);
  }
  assert.equal(consumerBasisForOccurrence({ outcome: 'failed', itemId: 'editorial.lorem-ipsum' }), null);
  assert.equal(consumerBasisForOccurrence({ outcome: 'failed', source: { kind: 'editorial' } }), null);
});

test('keeps the legal catalog validated and free of automatic legal-conclusion fields', () => {
  assert.deepEqual(validateNormativeData(), []);
  const serialized = JSON.stringify(BRAZILIAN_LEGAL_BASIS);
  for (const forbidden of ['violated' + 'Law', 'illegal', 'liability', 'sanction']) {
    assert.equal(serialized.includes(`\"${forbidden}\"`), false, forbidden);
  }
});
