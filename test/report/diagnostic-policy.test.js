import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ATTACHED_COPY_RELOADED_MESSAGE,
  diagnosticPolicyEntry,
} from '../../src/core/report/diagnostic-policy.js';
import { deriveSystemLimitations, listedLimitations } from '../../src/core/report/text-policy.js';

test('passive observation omission reaches report limitations without claiming a technical failure', () => {
  const diagnostic = {
    code: 'DYNAMIC_PROBES_OMITTED_PASSIVE',
    message: 'A página foi observada sem alterar foco, rolagem ou layout. Testes interativos de teclado, redimensionamento e movimento não foram executados; revise esses aspectos manualmente.',
    recoverable: true,
  };
  const policy = diagnosticPolicyEntry(diagnostic, {
    role: 'page', mode: 'single', status: 'complete', attempted: true, finalUrlObserved: true,
  });
  assert.equal(policy?.causePartial, false);
  assert.ok(deriveSystemLimitations({
    requestedScope: { mode: 'single' },
    session: { status: 'complete', diagnostics: [diagnostic] },
    pages: [{ finalUrlObserved: false, viewport: {}, diagnostics: [diagnostic] }],
    axe: { limitations: [] },
  }).includes(diagnostic.message));
});

test('attached-copy reload is a non-partial page limitation with one canonical message', () => {
  assert.equal(
    ATTACHED_COPY_RELOADED_MESSAGE,
    'A auditoria foi executada em uma cópia temporária recarregada da URL da aba escolhida; alterações não salvas e estado mantido apenas em memória na aba original não foram observados.',
  );
  const diagnostic = {
    code: 'ATTACHED_COPY_RELOADED',
    message: ATTACHED_COPY_RELOADED_MESSAGE,
    recoverable: true,
  };
  const policy = diagnosticPolicyEntry(diagnostic, {
    role: 'page', mode: 'single', status: 'complete', attempted: true, finalUrlObserved: true,
  });
  assert.equal(policy?.fact, 'attached-copy-reloaded');
  assert.equal(policy?.causePartial, false);
  assert.deepEqual(deriveSystemLimitations({
    requestedScope: { mode: 'single' },
    session: { status: 'complete', diagnostics: [diagnostic, { ...diagnostic }] },
    pages: [{ finalUrlObserved: false, viewport: {}, diagnostics: [diagnostic] }],
    axe: { limitations: [] },
  }).filter(value => value === ATTACHED_COPY_RELOADED_MESSAGE), [ATTACHED_COPY_RELOADED_MESSAGE]);
});

test('lista de limitações nunca some em silêncio quando a entrada não é lista', () => {
  const body = 'Nenhuma captura raster foi coletada no modo sem imagens.';
  const coded = `PIXEL_CAPTURE_OMITTED: ${body}`;
  // A forma codificada fica (rastreabilidade) e a frase simples repetida sai; uma frase simples
  // que não é corpo de código nenhum permanece.
  assert.deepEqual(listedLimitations([coded, body, 'Frase simples.']), [coded, 'Frase simples.']);
  assert.deepEqual(listedLimitations([body]), [body]);
  // Devolver [] para entrada inválida faria o relatório afirmar "Limitações registradas (0)",
  // escondendo limitações reais: a entrada precisa falhar alto, não encolher em silêncio.
  for (const invalid of [undefined, null, 'texto', {}, 7]) {
    assert.throws(() => listedLimitations(invalid), { name: 'TypeError' },
      `entrada ${JSON.stringify(invalid) ?? 'undefined'} precisa ser recusada`);
  }
});
