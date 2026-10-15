import assert from 'node:assert/strict';
import test from 'node:test';

import { SAMPLE_AUDIT } from '../../fixtures/audits/sample-audit.js';
import { buildFindingsBoard, citationParagraph, consolidatedCitationParagraph } from '../../src/core/report/findings-board.js';

const ITEM = { id: '5.1.13', title: 'Acessibilidade por teclado parcial' };
const INSTANT = '15/10/2026, 12:33:48 (America/Cuiaba, UTC−04:00)';
const PAGE = 'http://www.vila-aurora.example/';
const FAILURE = 'A verificação automática registrou falha neste requisito.';

function automatic(subject, overrides = {}) {
  return {
    occurrenceId: `occ-${subject}`,
    source: 'automatic',
    pageUrl: PAGE,
    element: subject,
    subject,
    text: FAILURE,
    observedAtLabel: INSTANT,
    evaluator: null,
    decidedAtLabel: null,
    evidence: ['ev-full (SHA-256 24d69243a1bdd799…)'],
    ...overrides,
  };
}

function human(text, overrides = {}) {
  return {
    occurrenceId: `occ-human-${text.slice(0, 8)}`,
    source: 'human',
    pageUrl: PAGE,
    element: null,
    subject: 'à página',
    text,
    observedAtLabel: INSTANT,
    evaluator: 'Pessoa revisora',
    decidedAtLabel: '15/10/2026, 12:40:00 (America/Cuiaba, UTC−04:00)',
    evidence: ['ev-full (SHA-256 24d69243a1bdd799…)'],
    ...overrides,
  };
}

test('quatro constatações na mesma página e instante: um parágrafo só, com os quatro elementos nomeados', () => {
  const findings = [
    automatic('ao bloco com o texto “Saúde Consultas e vacinas”'),
    automatic('ao bloco com o texto “Educação Matrículas e escolas”'),
    automatic('ao bloco com o texto “Tributos IPTU e certidões”'),
    automatic('ao bloco com o texto “Ouvidoria Reclamações e sugestões”'),
  ];
  const text = consolidatedCitationParagraph({ item: ITEM, findings });
  assert.ok(text.startsWith(`Em ${INSTANT}, na página ${PAGE}, foram constatadas 4 ocorrências em desacordo com o item 5.1.13 (Acessibilidade por teclado parcial, requisito) da ABNT NBR 17225:2025: `), text.slice(0, 220));
  // Cada elemento continua citado nominalmente, no mesmo item numerado.
  for (const subject of ['“Saúde Consultas e vacinas”', '“Educação Matrículas e escolas”', '“Tributos IPTU e certidões”', '“Ouvidoria Reclamações e sugestões”']) {
    assert.ok(text.includes(subject), `o elemento ${subject} precisa ser citado`);
  }
  assert.equal(text.includes('(2) '), false, 'o texto repetido não vira uma segunda ocorrência');
  assert.equal((text.match(/verificação automática da ferramenta Audita Acessibilidade/gu) ?? []).length, 1);
  assert.equal(text.includes('(1) '), false, 'com uma só constatação repetida, não há numeração');
  assert.match(text, /: em relação ao bloco com o texto “Saúde Consultas e vacinas”, ao bloco com o texto “Educação Matrículas e escolas”, ao bloco com o texto “Tributos IPTU e certidões” e ao bloco com o texto “Ouvidoria Reclamações e sugestões”, a verificação automática registrou falha neste requisito \(verificação automática da ferramenta Audita Acessibilidade\)\. Evidência:/u);
  // A captura da página inteira é a mesma para todos: aparece uma vez, no singular.
  assert.equal(text.endsWith('Evidência: ev-full (SHA-256 24d69243a1bdd799…).'), true);
  assert.equal((text.match(/ev-full/gu) ?? []).length, 1);
});

test('páginas diferentes: cada ocorrência leva a sua página e o seu instante', () => {
  const text = consolidatedCitationParagraph({ item: ITEM, findings: [
    automatic('ao bloco com o texto “Saúde”'),
    automatic('ao bloco com o texto “Educação”', { pageUrl: 'http://www.vila-aurora.example/servicos', observedAtLabel: '15/10/2026, 12:35:00 (America/Cuiaba, UTC−04:00)' }),
  ] });
  assert.match(text, /^Foram constatadas 2 ocorrências em desacordo com o item 5\.1\.13 \(Acessibilidade por teclado parcial, requisito\) da ABNT NBR 17225:2025: /u);
  assert.ok(text.includes(`(1) na página ${PAGE}, em ${INSTANT}, em relação ao bloco com o texto “Saúde”`));
  assert.ok(text.includes('(2) na página http://www.vila-aurora.example/servicos, em 15/10/2026, 12:35:00 (America/Cuiaba, UTC−04:00), em relação ao bloco com o texto “Educação”'));
  assert.equal(text.includes(`${INSTANT}, na página`), false, 'sem contexto único, o instante não abre o parágrafo');
});

test('constatações automáticas de textos diferentes viram ocorrências separadas', () => {
  const text = consolidatedCitationParagraph({ item: ITEM, findings: [
    automatic('ao bloco com o texto “Saúde”'),
    automatic('ao link “Agendar consulta”', { text: 'O contraste medido está abaixo do mínimo. ' }),
  ] });
  assert.match(text, /\(1\) em relação ao bloco com o texto “Saúde”/u);
  assert.match(text, /\(2\) em relação ao link “Agendar consulta”, o contraste medido está abaixo do mínimo \(verificação automática da ferramenta Audita Acessibilidade\)/u);
});

test('elementos com o mesmo nome não somem: o nome aparece uma vez, com a quantidade', () => {
  const text = consolidatedCitationParagraph({ item: ITEM, findings: [
    automatic('ao botão sem nome', { text: 'O elemento não tem nome que o leitor de tela possa anunciar.', evidence: ['ev-1'] }),
    automatic('ao botão sem nome', { text: 'O elemento não tem nome que o leitor de tela possa anunciar.', evidence: ['ev-2'] }),
    automatic('ao botão sem nome', { text: 'O elemento não tem nome que o leitor de tela possa anunciar.', evidence: ['ev-3'] }),
  ] });
  assert.match(text, /foram constatadas 3 ocorrências/u);
  assert.equal((text.match(/ao botão sem nome/gu) ?? []).length, 1, 'o mesmo nome não se repete na frase');
  assert.match(text, /em relação ao botão sem nome \(3 elementos\), o elemento não tem nome que o leitor de tela possa anunciar \(verificação automática da ferramenta Audita Acessibilidade\)\./u);
  assert.equal(text.endsWith('Evidências: ev-1; ev-2; ev-3.'), true, 'a evidência de cada elemento continua citada');
});

test('revisão humana e verificação automática no mesmo parágrafo, com o texto de cada uma', () => {
  const text = consolidatedCitationParagraph({ item: ITEM, findings: [
    automatic('ao bloco com o texto “Saúde”'),
    human('Os cartões de serviço abrem menus só quando o mouse passa por cima.', { element: 'bloco com o texto “Serviços”' }),
    human('Duas áreas ficaram sem caixa numerada.', { evidence: ['ev-other (SHA-256 aaaa…)'] }),
  ] });
  assert.match(text, /foram constatadas 3 ocorrências/u);
  assert.match(text, /\(2\) em revisão humana registrada por Pessoa revisora em 15\/10\/2026, 12:40:00 \(America\/Cuiaba, UTC−04:00\), a constatação “Os cartões de serviço abrem menus só quando o mouse passa por cima\.”, no elemento bloco com o texto “Serviços”/u);
  assert.match(text, /\(3\) em revisão humana registrada por Pessoa revisora em 15\/10\/2026, 12:40:00 \(America\/Cuiaba, UTC−04:00\), a constatação “Duas áreas ficaram sem caixa numerada\.”\. Evidências:/u);
  assert.equal(text.includes('a constatação “Duas áreas ficaram sem caixa numerada.”, no elemento'), false);
});

test('as evidências aparecem uma vez só, sem repetir referências iguais e na ordem em que surgem', () => {
  const text = consolidatedCitationParagraph({ item: ITEM, findings: [
    automatic('ao bloco com o texto “Saúde”', { evidence: ['ev-full (SHA-256 24d…)'] }),
    automatic('ao link “Agendar consulta”', { text: 'Texto diferente.', evidence: ['ev-second (SHA-256 bb…)', 'ev-full (SHA-256 24d…)'] }),
  ] });
  assert.equal(text.endsWith('Evidências: ev-full (SHA-256 24d…); ev-second (SHA-256 bb…).'), true);
  assert.equal((text.match(/ev-full/gu) ?? []).length, 1);
});

test('uma constatação só continua com o texto de citationParagraph, sem passar pela consolidação', () => {
  const board = buildFindingsBoard(SAMPLE_AUDIT);
  const entry = board.groups.notMet.find(value => value.itemId === '5.1.1');
  assert.equal(entry.findings.length, 1);
  assert.equal(citationParagraph({ item: { id: entry.itemId, title: entry.title }, finding: entry.findings[0] }), entry.findings[0].citation);
  assert.match(entry.findings[0].citation, /constatou-se, em relação/u);
});

test('sem constatações não há parágrafo', () => {
  assert.equal(consolidatedCitationParagraph({ item: ITEM, findings: [] }), '');
  assert.equal(consolidatedCitationParagraph({ item: ITEM }), '');
});
