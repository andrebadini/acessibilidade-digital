import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_STOPS, tabReadingModel } from './tab-reading-fixture.js';
import { buildFindingsBoard } from '../../src/core/report/findings-board.js';
import {
  TAB_READING_QUESTION,
  TAB_READING_SECTION_TITLE,
  buildTabReadingPlan,
  tabReadingAnnouncementSentence,
  tabReadingDecisionSummary,
  tabReadingFindingText,
  tabReadingProgress,
  tabReadingRowLabel,
} from '../../src/core/report/tab-reading-plan.js';

const THREE_ANSWERS = [
  { nodeId: 'n-tab-1', answer: 'conforme' },
  { nodeId: 'n-tab-2', answer: 'não conforme', note: 'Campo de busca, caixa de texto' },
  { nodeId: 'n-tab-3', answer: 'não foi possível determinar' },
];

test('o plano apresenta os pontos na ordem do Tab, com o elemento e o anúncio estimado', async () => {
  const { model } = await tabReadingModel();
  const rows = buildTabReadingPlan(model);
  assert.deepEqual(rows.map(row => row.nodeId), ['n-tab-1', 'n-tab-2', 'n-tab-3']);
  assert.deepEqual(rows.map(row => row.number), [1, 2, 3]);
  assert.deepEqual(rows.map(row => row.label), ['botão “Buscar”', 'campo de texto sem nome', 'link “Pesquisar”']);
  assert.deepEqual(rows.map(row => row.announcement), ['Buscar, botão', 'caixa de texto', 'Pesquisar, link']);
  assert.deepEqual(rows.map(row => tabReadingRowLabel(row)), [
    'Tab 1, botão “Buscar”', 'Tab 2, campo de texto sem nome', 'Tab 3, link “Pesquisar”',
  ]);
  assert.deepEqual(tabReadingProgress(rows), { total: 3, answered: 0 });
  assert.ok(rows.every(row => row.answered === false && row.decision === null));
  assert.ok(Object.isFrozen(rows) && rows.every(row => Object.isFrozen(row)));
  // Cada linha carrega o que o recorte da imagem precisa: página, nó e a evidência do elemento.
  for (const row of rows) {
    assert.equal(row.pageId, 'page-1');
    assert.equal(row.elementLevel, true);
    assert.equal(row.evidence.evidenceId, `ev-${row.nodeId}`);
    assert.equal(row.pageKey, `page-1\u0000${row.nodeId}`);
  }
});

test('a ordem da seção é a ordem do Tab do mapa, não a ordem do documento', async () => {
  const { model } = await tabReadingModel({ mapStops: [...DEFAULT_STOPS].reverse() });
  const rows = buildTabReadingPlan(model);
  // As ocorrências continuam na ordem do documento (1, 2, 3) e a numeração do mapa inverte a leitura.
  assert.deepEqual(model.occurrences.filter(occurrence => occurrence.ruleId === 'tab-reading-announcement')
    .map(occurrence => occurrence.nodeId), ['n-tab-1', 'n-tab-2', 'n-tab-3']);
  assert.deepEqual(rows.map(row => [row.number, row.nodeId]), [[1, 'n-tab-3'], [2, 'n-tab-2'], [3, 'n-tab-1']]);
});

test('sem mapa do teclado a sequência continua numerada pela posição', async () => {
  const { model } = await tabReadingModel({ map: false });
  const rows = buildTabReadingPlan(model);
  assert.deepEqual(rows.map(row => row.number), [1, 2, 3]);
  assert.deepEqual(rows.map(row => row.nodeId), ['n-tab-1', 'n-tab-2', 'n-tab-3']);
});

test('pistas automáticas só entram quando falam do nome anunciado', async () => {
  const { model } = await tabReadingModel({ nameFailures: ['n-tab-2'] });
  const rows = buildTabReadingPlan(model);
  const byNode = new Map(rows.map(row => [row.nodeId, row.hints]));
  assert.deepEqual(byNode.get('n-tab-1'), []);
  assert.deepEqual(byNode.get('n-tab-3'), []);
  assert.deepEqual(byNode.get('n-tab-2'), ['O elemento não tem nome que o leitor de tela possa anunciar.']);
  assert.ok(Object.isFrozen(byNode.get('n-tab-2')));
});

test('a resposta registrada entra na linha, com avaliador e instante local', async () => {
  const { model } = await tabReadingModel({ answers: THREE_ANSWERS });
  const rows = buildTabReadingPlan(model);
  assert.deepEqual(tabReadingProgress(rows), { total: 3, answered: 3 });
  assert.deepEqual(rows.map(row => row.decision.answer), ['conforme', 'não conforme', 'não foi possível determinar']);
  assert.ok(rows.every(row => row.answered === true));
  const summary = tabReadingDecisionSummary(rows, 'America/Cuiaba');
  assert.deepEqual(summary.evaluators, ['Fiscal Ana']);
  assert.equal(summary.decidedAt, '2026-08-27T12:00:00.000Z');
  assert.equal(summary.decidedAtLabel, '27/08/2026, 08:00:00 (America/Cuiaba, UTC−04:00)');
  assert.deepEqual(tabReadingDecisionSummary([], 'America/Cuiaba'), { evaluators: [], decidedAt: null, decidedAtLabel: null });
});

test('a frase do anúncio cobre nome, anúncio vazio e elemento sem nome', () => {
  assert.equal(tabReadingAnnouncementSentence({ announcement: 'Buscar, botão' }), 'o leitor de tela diria “Buscar, botão”');
  assert.equal(tabReadingAnnouncementSentence({ announcement: '  ' }), 'o leitor de tela não teria o que anunciar além do próprio tipo do elemento');
  assert.equal(tabReadingAnnouncementSentence({ announcement: null, element: { name: '' } }), 'o leitor de tela não teria nome para anunciar');
});

test('a constatação do tema é um texto só, nomeando todos os pontos com “Não”', async () => {
  const { model } = await tabReadingModel({ answers: THREE_ANSWERS });
  const text = tabReadingFindingText(buildTabReadingPlan(model));
  assert.match(text, /^Em um ponto da sequência de Tab, o que o leitor de tela fala não corresponde ao elemento: /u);
  assert.match(text, /\(1\) Tab 2, campo de texto sem nome: o leitor de tela diria “caixa de texto”\./u);
  assert.match(text, /O que deveria dizer: “Campo de busca, caixa de texto”\./u);
  // Só o ponto respondido com “Não” entra: o “Sim” e o “Não sei” não viram constatação.
  assert.doesNotMatch(text, /Tab 1/u);
  assert.doesNotMatch(text, /Tab 3/u);
  // Uma resposta “Não” sem sugestão continua nomeando o ponto, sem inventar o que deveria ser dito.
  assert.equal(text, 'Em um ponto da sequência de Tab, o que o leitor de tela fala não corresponde ao elemento: (1) Tab 2, campo de texto sem nome: o leitor de tela diria “caixa de texto”. O que deveria dizer: “Campo de busca, caixa de texto”.');
  const { model: semSugestao } = await tabReadingModel({ answers: [{ nodeId: 'n-tab-2', answer: 'não conforme' }] });
  const semSugestaoText = tabReadingFindingText(buildTabReadingPlan(semSugestao));
  assert.equal(semSugestaoText, 'Em um ponto da sequência de Tab, o que o leitor de tela fala não corresponde ao elemento: (1) Tab 2, campo de texto sem nome: o leitor de tela diria “caixa de texto”.');
});

test('sem “Não” não há constatação, e vários “Não” viram uma frase com todos', async () => {
  const { model: semNao } = await tabReadingModel({ answers: [
    { nodeId: 'n-tab-1', answer: 'conforme' },
    { nodeId: 'n-tab-2', answer: 'não foi possível determinar' },
  ] });
  assert.equal(tabReadingFindingText(buildTabReadingPlan(semNao)), '');

  const { model: tresNao } = await tabReadingModel({ answers: [
    { nodeId: 'n-tab-1', answer: 'não conforme', note: 'Botão Buscar' },
    { nodeId: 'n-tab-2', answer: 'não conforme' },
    { nodeId: 'n-tab-3', answer: 'não conforme', note: 'Link para a busca' },
  ] });
  const text = tabReadingFindingText(buildTabReadingPlan(tresNao));
  assert.match(text, /^Em 3 pontos da sequência de Tab, o que o leitor de tela fala não corresponde ao elemento: /u);
  for (const label of ['Tab 1, botão “Buscar”', 'Tab 2, campo de texto sem nome', 'Tab 3, link “Pesquisar”']) {
    assert.ok(text.includes(label), label);
  }
  assert.equal((text.match(/O que deveria dizer/gu) ?? []).length, 2);
});

test('o quadro de constatações recebe UM achado com todos os pontos e uma citação', async () => {
  const { model } = await tabReadingModel({ answers: [
    { nodeId: 'n-tab-1', answer: 'não conforme', note: 'Botão Buscar' },
    { nodeId: 'n-tab-2', answer: 'não conforme' },
    { nodeId: 'n-tab-3', answer: 'conforme' },
  ] });
  const entry = buildFindingsBoard(model).groups.notMet.find(value => value.itemId === '5.13.10');
  assert.ok(entry, 'o item 5.13.10 passa a não atendido');
  assert.equal(entry.method, 'revisão humana');
  assert.equal(entry.findings.length, 1, 'um achado para o tema inteiro');
  const [finding] = entry.findings;
  assert.equal(finding.element, null);
  assert.ok(finding.occurrenceIds.includes('occ-tab-n-tab-1'));
  assert.ok(finding.occurrenceIds.includes('occ-tab-n-tab-2'));
  assert.ok(!finding.occurrenceIds.includes('occ-tab-n-tab-3'));
  assert.ok(finding.text.includes('Tab 1, botão “Buscar”') && finding.text.includes('Tab 2, campo de texto sem nome'));
  // A citação fala uma vez da página, uma vez do item normativo e uma vez das evidências.
  assert.equal((finding.citation.match(/ABNT NBR 17225:2025/gu) ?? []).length, 1);
  assert.equal((finding.citation.match(/Evidência:/gu) ?? []).length, 1);
  assert.match(finding.citation, /item 5\.13\.10 \(Componentes com nome acessível, requisito\)/u);
  assert.ok(finding.citation.includes(finding.text));
  assert.equal(finding.evaluator, 'Fiscal Ana');
  assert.equal(finding.legalBasis, true, 'há sugestão escrita por uma pessoa');
});

test('responder “Não sei” deixa o item sem conclusão, sem constatação inventada', async () => {
  const { model } = await tabReadingModel({ answers: [
    { nodeId: 'n-tab-1', answer: 'não foi possível determinar' },
    { nodeId: 'n-tab-2', answer: 'não foi possível determinar' },
  ] });
  const board = buildFindingsBoard(model);
  assert.equal(board.groups.notMet.some(entry => entry.itemId === '5.13.10'), false);
  assert.ok(board.groups.pending.some(entry => entry.itemId === '5.13.10'));
});

test('respostas “Sim” em todos os pontos aprovam o item', async () => {
  const { model } = await tabReadingModel({ answers: [
    { nodeId: 'n-tab-1', answer: 'conforme' },
    { nodeId: 'n-tab-2', answer: 'conforme' },
    { nodeId: 'n-tab-3', answer: 'conforme' },
  ] });
  const board = buildFindingsBoard(model);
  assert.equal(board.groups.notMet.some(entry => entry.itemId === '5.13.10'), false);
  assert.equal(board.groups.met.some(entry => entry.itemId === '5.13.10'), true);
});

test('auditoria gravada sem a regra da leitura por Tab continua abrindo, sem seção', async () => {
  const { model } = await tabReadingModel({ tabRule: false, stops: [], map: false });
  assert.equal(buildTabReadingPlan(model).length, 0);
  assert.equal(tabReadingFindingText([]), '');
  const board = buildFindingsBoard(model);
  assert.equal(board.groups.notMet.some(entry => entry.itemId === '5.13.10'), false);
  assert.equal(model.methodology.coreRuleCount, 131);
});

test('a seção diz em uma frase o que está sendo conferido', () => {
  assert.equal(TAB_READING_SECTION_TITLE, 'Leitura por Tab — o que o leitor de tela fala');
  assert.match(TAB_READING_QUESTION, /corresponde a este elemento.*o que ele é e o que faz/iu);
  // Sem jargão: nada de ARIA, seletor ou sigla de critério na pergunta da pessoa leiga.
  assert.doesNotMatch(TAB_READING_QUESTION, /aria|WCAG|role|seletor/iu);
});
