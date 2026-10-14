import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ATTACHED_COPY_RELOADED_MESSAGE,
  PAGE_NAVIGATION_HELD_MESSAGE,
  SYSTEM_DIAGNOSTIC_MESSAGES,
  diagnosticPolicyEntry,
} from '../../src/core/report/diagnostic-policy.js';
import { deriveSystemLimitations, listedLimitations } from '../../src/core/report/text-policy.js';

test('passive observation omission reaches report limitations without claiming a technical failure', () => {
  const diagnostic = {
    code: 'DYNAMIC_PROBES_OMITTED_PASSIVE',
    // A frase é literal e foi CORRIGIDA na 1.1.49 depois da revisão adversarial (achado N-1 do revisor): a
    // captura de elementos com `captureBeyondViewport` mexe transitoriamente na geometria do documento, e
    // numa página que reage a `resize` o efeito fica registrado — a mensagem antiga negava isso.
    message: 'A página foi observada sem navegação e sem alterar foco, rolagem ou o layout final. Nas verificações com imagens, a captura de elementos pode redimensionar a área de captura por um instante e restaurá-la; páginas que reagem a redimensionamento podem registrar essa mudança. Testes interativos de teclado, redimensionamento e movimento não foram executados; revise esses aspectos manualmente.',
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

test('congelamento de navegação é diagnóstico informativo, não limitação nem causa de parcial', () => {
  assert.equal(
    PAGE_NAVIGATION_HELD_MESSAGE,
    'A página tentou recarregar ou navegar sozinha durante a auditoria; a navegação foi segurada até o fim para que o resultado corresponda à página analisada.',
  );
  const diagnostic = { code: 'PAGE_NAVIGATION_HELD', message: PAGE_NAVIGATION_HELD_MESSAGE, recoverable: true };
  for (const status of ['complete', 'partial', 'failed', 'cancelled']) {
    const policy = diagnosticPolicyEntry(diagnostic, {
      role: 'page', mode: 'single', status, attempted: true, finalUrlObserved: true,
    });
    assert.equal(policy?.fact, 'page-navigation-held', `o diagnóstico precisa valer em ${status}`);
    assert.equal(policy?.causePartial, false, 'segurar uma navegação não degrada a auditoria');
  }
  // Também vale no lote: o mesmo congelamento protege a página de um lote.
  assert.equal(diagnosticPolicyEntry(diagnostic, {
    role: 'page', mode: 'batch', status: 'complete', attempted: true, finalUrlObserved: true,
  })?.fact, 'page-navigation-held');
  // O catálogo é fechado na mensagem: uma frase livre com o mesmo código NÃO é aceita.
  assert.equal(diagnosticPolicyEntry({ ...diagnostic, message: `${PAGE_NAVIGATION_HELD_MESSAGE} (3 vezes)` }, {
    role: 'page', mode: 'single', status: 'complete', attempted: true, finalUrlObserved: true,
  }), null);
  assert.equal(SYSTEM_DIAGNOSTIC_MESSAGES.includes(PAGE_NAVIGATION_HELD_MESSAGE), true);
  // Não vira "limitação": nada foi perdido, a navegação foi segurada e o resultado corresponde à página.
  assert.deepEqual(deriveSystemLimitations({
    requestedScope: { mode: 'single' },
    session: { status: 'complete', diagnostics: [diagnostic] },
    pages: [{ finalUrlObserved: false, viewport: {}, diagnostics: [diagnostic] }],
    axe: { limitations: [] },
  }).filter(value => value === PAGE_NAVIGATION_HELD_MESSAGE), []);
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

test('a deduplicação não depende da forma do código (tabela de lacunas da revisão)', () => {
  // A revisão da 1.1.21 reproduziu seis formas em que a heurística antiga falhava e a frase simples
  // repetida ficava na lista. Todas passam a ser reconhecidas pelo CORPO da entrada, não pela forma.
  const casos = [
    ['OTP: frase curta.', 'frase curta.'],                       // código com menos de 4 caracteres
    ['otp: frase minúscula.', 'frase minúscula.'],               // código em minúsculas
    ['REPORT-PDF: frase com hífen.', 'frase com hífen.'],        // hífen no código
    ['XYZ:  frase com espaço duplo.', 'frase com espaço duplo.'], // espaço duplo depois dos dois pontos
    ['ABC: frase com quebra.\n', 'frase com quebra.'],           // quebra de linha no fim
    ['A: B: frase encadeada.', 'frase encadeada.'],              // códigos encadeados
  ];
  for (const [codificada, simples] of casos) {
    assert.deepEqual(listedLimitations([codificada, simples]), [codificada],
      `a frase simples repetida precisa sair ao lado de ${JSON.stringify(codificada)}`);
    assert.deepEqual(listedLimitations([simples]), [simples], 'frase simples sozinha permanece');
  }
  // Uma frase simples que não é corpo de código nenhum continua intocada.
  assert.deepEqual(listedLimitations(['O relatório cobre somente uma página e o estado observado.', 'Outra frase.']),
    ['O relatório cobre somente uma página e o estado observado.', 'Outra frase.']);
});

test('dois códigos com a mesma frase produzem UMA entrada na lista (o código específico fica no JSON)', () => {
  // Os 12 códigos ANNOTATION_MAP_* de falha compartilham o mesmo `fact` e a mesma mensagem: sem
  // colapsar, a lista de limitações mostrava duas (ou mais) entradas para uma única frase distinta
  // (Minor 2 da revisão da 1.1.20 / V6). O primeiro código representa o fato; os demais continuam
  // registrados no diagnóstico técnico do modelo.
  const corpo = 'O mapa visual derivado não pôde ser gerado localmente; a captura original foi preservada.';
  const primeira = `ANNOTATION_MAP_TIMEOUT: ${corpo}`;
  const segunda = `ANNOTATION_MAP_GEOMETRY_INVALID: ${corpo}`;
  assert.deepEqual(listedLimitations([primeira, segunda, corpo]), [primeira]);
  // Frases diferentes continuam sendo entradas diferentes.
  const outra = 'ANNOTATION_MAP_PARTIAL: O mapa visual foi gerado com cobertura parcial e limitações explícitas.';
  assert.deepEqual(listedLimitations([primeira, segunda, outra, corpo]), [primeira, outra]);
});

test('a deduplicação aceita qualquer espaço depois dos dois pontos, não só o espaço comum', () => {
  // A revisão da 1.1.25 mediu que a minha alegação do V7 era mais larga que o código: o separador era
  // `': '` literal, então tab, quebra de linha e espaço não separável escapavam. O código passou a
  // aceitar qualquer espaço — e esta é a forma de a frase voltar a valer o que o código faz.
  const separadores = [' ', '\t', '\n', '\u00a0'];
  for (const separador of separadores) {
    const codificada = `CODE:${separador}frase repetida.`;
    assert.deepEqual(listedLimitations([codificada, 'frase repetida.']), [codificada],
      `separador ${JSON.stringify(separador)} precisa ser reconhecido`);
  }
  // Sem separador nenhum continua fora, e isso fica declarado: não é forma que o gerador produza.
  assert.deepEqual(listedLimitations(['CODE:frase colada.', 'frase colada.']),
    ['CODE:frase colada.', 'frase colada.']);
});
