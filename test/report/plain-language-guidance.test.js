import assert from 'node:assert/strict';
import test from 'node:test';
import { NBR17225_ITEMS } from '../../src/core/normative/nbr17225.js';
import { accessibilityGuidance as guidance } from '../../src/core/report/plain-language-guidance.js';

// Catches evidence being replaced by a topic's hypothetical failure.
test('preserves supplied evidence verbatim when explaining a failure', () => {
  const observed = 'Botão #buscar: razão medida 2.1:1; amostra parcial.\nEstado: aberto.';
  const result = guidance({ itemId: '5.11.4', outcome: 'failed', observed, correction: 'Rever a borda de #buscar.' });
  assert.ok(result.observed.includes(observed));
  assert.ok(result.correction.includes('Rever a borda de #buscar.'));
});

// Catches pending results receiving the same definitive repair as a failure.
for (const outcome of ['cantTell', 'untested']) {
  test(`${outcome} keeps the conclusion open and makes correction conditional`, () => {
    const result = guidance({ itemId: '5.2.1', outcome, correction: 'Descreva a imagem.' });
    assert.match(result.observed, /não (?:confirma|foi avaliado)/i);
    assert.match(result.correction, /se .*confirm/i);
    assert.doesNotMatch(result.observed, /imagem (?:está|sem)|falha confirmada/i);
  });
}

// Catches imposing the supplied repair even when this result passed or does not apply.
for (const outcome of ['passed', 'inapplicable']) {
  test(`${outcome} does not mandate a correction`, () => {
    const result = guidance({ itemId: '5.1.1', outcome, correction: 'Adicione um contorno.' });
    assert.doesNotMatch(result.correction, /Adicione um contorno/);
    assert.match(result.correction, /nenhuma correção/i);
  });
}

// Catches routing all findings to a generic keyboard/image instruction or using the untrusted title to route.
test('routes verified items to relevant review actions and hypothetical examples', () => {
  const focus = guidance({ itemId: '5.1.1', title: 'Imagem', outcome: 'cantTell' });
  const image = guidance({ itemId: '5.2.1', outcome: 'cantTell' });
  const link = guidance({ itemId: '5.7.4', outcome: 'cantTell' });
  const contrast = guidance({ itemId: '5.11.3', outcome: 'cantTell' });
  assert.match(focus.reviewSteps.join(' '), /Tab/);
  assert.match(image.reviewSteps.join(' '), /imagem/);
  assert.match(link.reviewSteps.join(' '), /destino/);
  assert.match(contrast.reviewSteps.join(' '), /contraste/);
  for (const result of [focus, image, link, contrast]) {
    assert.match(result.example, /hipotético/i);
    assert.ok(result.impact.length > 30);
  }
});

// Catches treating a decorative image as missing a mandatory description.
test('decorative image guidance distinguishes decoration from meaningful content', () => {
  const result = guidance({ itemId: '5.2.3', outcome: 'failed' });
  assert.match(result.reviewSteps.join(' '), /decorativ/);
  assert.match(result.correction, /ignora|vazio/);
});

// Catches family fallbacks silently dropping the actual item under review.
test('every catalogue item retains its own topic in actionable family guidance', () => {
  for (const item of NBR17225_ITEMS) {
    const result = guidance({ itemId: item.id, outcome: 'cantTell' });
    assert.ok(result.reviewSteps.join(' ').includes(item.title), item.id);
    assert.ok(result.reviewSteps.length >= 2, item.id);
    assert.match(result.example, /hipotético/i, item.id);
  }
});

// Catches inventing a normative topic from an unknown numeric prefix or claiming unobserved facts.
test('unknown items use a safe generic review and do not invent observations', () => {
  const result = guidance({ itemId: '5.2.999', title: 'Verificação local', outcome: 'failed' });
  assert.match(result.observed, /sem descrição|não foi fornecida/i);
  assert.doesNotMatch(result.correction, /alt=|imagem/);
  assert.ok(result.reviewSteps.join(' ').includes('Verificação local'));
});
