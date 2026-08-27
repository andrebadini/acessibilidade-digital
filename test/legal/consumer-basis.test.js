import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BRAZILIAN_LEGAL_BASIS,
  CONSUMER_ACCESSIBILITY_FIXED_BASIS,
  consumerBasisForOccurrence
} from '../../src/core/legal/consumer-basis.js';
import { validateNormativeData } from '../../src/core/normative/validate-normative-data.js';

const DISPLAY = 'Arts. 7º, caput, 20, § 2º, e 39, VIII, da Lei nº 8.078/1990, c/c art. 12, IX, “a”, do Decreto nº 2.181/1997.';
const QUALIFICATION = 'A referência padronizada não constitui conclusão automática de infração, responsabilidade ou sanção; a incidência depende da qualificação jurídica do alvo e dos fatos do caso concreto.';

test('returns one immutable Brazilian consumer basis with the fixed display and current-text caveat', () => {
  assert.equal(CONSUMER_ACCESSIBILITY_FIXED_BASIS.id, 'br.consumer.accessibility.fixed.v1');
  assert.equal(CONSUMER_ACCESSIBILITY_FIXED_BASIS.label, 'Base consumerista padronizada para análise');
  assert.equal(CONSUMER_ACCESSIBILITY_FIXED_BASIS.display, DISPLAY);
  assert.equal(CONSUMER_ACCESSIBILITY_FIXED_BASIS.qualification, QUALIFICATION);
  assert.equal(CONSUMER_ACCESSIBILITY_FIXED_BASIS.currentTextCaveatRef, 'br.law13874.art3.vi');
  assert.equal(BRAZILIAN_LEGAL_BASIS.consumerAccessibilityFixed, CONSUMER_ACCESSIBILITY_FIXED_BASIS);
  assert.ok(Object.isFrozen(BRAZILIAN_LEGAL_BASIS));
  assert.ok(Object.isFrozen(CONSUMER_ACCESSIBILITY_FIXED_BASIS));
  assert.ok(Object.isFrozen(CONSUMER_ACCESSIBILITY_FIXED_BASIS.sources));
  assert.ok(CONSUMER_ACCESSIBILITY_FIXED_BASIS.sources.every(Object.isFrozen));
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
