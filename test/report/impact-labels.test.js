import test from 'node:test';
import assert from 'node:assert/strict';
import { impactLabel, impactText } from '../../src/core/report/impact-labels.js';

test('rótulos de impacto: mesmo vocabulário em toda a interface', () => {
  assert.deepEqual(['critical', 'serious', 'moderate', 'minor'].map(impactLabel), ['Crítico', 'Alto', 'Moderado', 'Baixo']);
  assert.equal(impactText('serious'), 'Impacto Alto');
  assert.equal(impactText('serious', true), 'Impacto se confirmado: Alto');
  assert.equal(impactText(null), null);
});

test('resultado positivo não exibe impacto, nem quando a regra tem gravidade', () => {
  assert.equal(impactText('moderate', false, { positive: true }), null);
  assert.equal(impactText('critical', true, { positive: true }), null);
});
