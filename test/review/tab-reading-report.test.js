/**
 * Leitura por Tab no documento entregue: a seção da revisão humana no HTML/PDF e no relatório completo.
 *
 * O teste segue o caminho real de entrega (`enrichAuditForReport` → resumo do painel → `ReportView` →
 * `renderHtmlReport`) e o caminho do relatório completo (`renderHtmlReport` sem `ReportView`), porque é
 * nesses dois documentos que a pessoa lê as respostas e a constatação do tema.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { renderHtmlReport } from '../../src/core/report/html.js';
import { TAB_READING_QUESTION, TAB_READING_SECTION_TITLE } from '../../src/core/report/tab-reading-plan.js';
import { DEFAULT_STOPS, tabReadingModel, tabReadingReport } from '../report/tab-reading-fixture.js';

const THREE_ANSWERS = [
  { nodeId: 'n-tab-1', answer: 'conforme' },
  { nodeId: 'n-tab-2', answer: 'não conforme', note: 'Campo de busca, caixa de texto' },
  { nodeId: 'n-tab-3', answer: 'não foi possível determinar' },
];

function sectionOf(html) {
  const start = html.indexOf('<section data-report-tab-reading');
  assert.notEqual(start, -1, 'A seção da leitura por Tab precisa existir no documento');
  const end = html.indexOf('</section>', start);
  return html.slice(start, end);
}

function renderDelivered(model, view, forPrint) {
  return renderHtmlReport(model, { reportView: view, forPrint });
}

test('o HTML e o PDF entregues mostram a seção, o progresso e as linhas respondidas', async () => {
  const { model, view } = await tabReadingReport({ answers: THREE_ANSWERS });
  for (const forPrint of [false, true]) {
    const html = renderDelivered(model, view, forPrint);
    assert.ok(html.includes(TAB_READING_SECTION_TITLE));
    assert.ok(html.includes('3 de 3 conferidos'));
    assert.ok(html.includes(TAB_READING_QUESTION));
    // Uma linha por ponto respondido, com a resposta no atributo que o teste seguinte usa como âncora.
    assert.equal((html.match(/data-tab-reading-row=/gu) ?? []).length, 3);
    assert.equal((html.match(/data-tab-reading-answer="conforme"/gu) ?? []).length, 1);
    assert.equal((html.match(/data-tab-reading-answer="não conforme"/gu) ?? []).length, 1);
    assert.equal((html.match(/data-tab-reading-answer="não foi possível determinar"/gu) ?? []).length, 1);
    assert.ok(html.includes('O que deveria dizer:'));
    assert.ok(html.includes('Campo de busca, caixa de texto'));
  }
});

test('cada linha do documento entregue traz o recorte do elemento, contornado, sem reimagem nova', async () => {
  const { model, view } = await tabReadingReport({ answers: THREE_ANSWERS });
  const html = renderHtmlReport(model, { reportView: view, forPrint: true });
  const section = sectionOf(html);
  // Três recortes: o desenho usa a imagem guardada (`<use>` para o `<defs>` do documento).
  assert.equal((section.match(/evidence-highlight--target/gu) ?? []).length, 3);
  assert.equal((section.match(/<use href="#/gu) ?? []).length, 3);
  // O texto alternativo nomeia a origem do recorte e o contorno, como na página de conferência.
  assert.equal((section.match(/aria-label="Recorte da captura da página inteira, na região do elemento desta pergunta\./gu) ?? []).length, 3);
  assert.match(section, /Contorno vermelho: o elemento desta pergunta\./u);
  // A imagem não é recopiada em cada linha: as três linhas apontam para o bloco de definições da seção.
  assert.match(section, /class="evidence-definitions"[^>]*><defs>/u);
  const defined = new Set([...section.matchAll(/<image id="(evidence-image-\d+)"/gu)].map(match => match[1]));
  const used = [...section.matchAll(/<use href="#(evidence-image-\d+)"/gu)].map(match => match[1]);
  assert.ok(used.every(id => defined.has(id)), 'todo recorte aponta para uma imagem definida na seção');
  // Uma só definição para o mesmo PNG: os três pontos vêm do mesmo trecho guardado.
  assert.equal(defined.size, 1);
});

test('o documento entregue mostra só as linhas respondidas, com a contagem do total', async () => {
  const { model, view } = await tabReadingReport({ answers: [{ nodeId: 'n-tab-2', answer: 'não conforme' }] });
  const section = sectionOf(renderHtmlReport(model, { reportView: view, forPrint: true }));
  assert.equal((section.match(/data-tab-reading-row=/gu) ?? []).length, 1);
  assert.ok(section.includes('occ-tab-n-tab-2'));
  assert.ok(section.includes('1 de 3 conferidos'));
});

test('a constatação do tema é um parágrafo só, nomeando todos os pontos com “Não”', async () => {
  const { model, view } = await tabReadingReport({ answers: [
    { nodeId: 'n-tab-1', answer: 'não conforme', note: 'Botão Buscar' },
    { nodeId: 'n-tab-2', answer: 'não conforme' },
    { nodeId: 'n-tab-3', answer: 'conforme' },
  ] });
  for (const forPrint of [false, true]) {
    const section = sectionOf(renderDelivered(model, view, forPrint));
    assert.equal((section.match(/data-report-tab-reading-finding/gu) ?? []).length, 1, 'uma constatação única');
    const start = section.indexOf('<p data-report-tab-reading-finding>');
    const finding = section.slice(start, section.indexOf('</p>', start));
    assert.ok(finding.includes('Em 2 pontos da sequência de Tab'));
    assert.ok(finding.includes('Tab 1, botão “Buscar”'));
    assert.ok(finding.includes('Tab 2, campo de texto sem nome'));
    assert.ok(finding.includes('O que deveria dizer: “Botão Buscar”'));
    assert.ok(!finding.includes('Tab 3'));
    // O item normativo e a evidência são citados uma vez, no quadro de constatações, e não aqui.
    assert.ok(!finding.includes('ABNT NBR 17225:2025'));
    assert.ok(!finding.includes('Evidência:'));
  }
});

test('sem nenhuma resposta a seção não aparece, e a auditoria antiga continua rendendo o documento', async () => {
  const { model, view } = await tabReadingReport();
  const html = renderHtmlReport(model, { reportView: view, forPrint: true });
  // O que não pode existir é a SEÇÃO: a folha de estilo traz o seletor `[data-report-tab-reading]` em
  // toda auditoria, então procurar o atributo solto no documento inteiro acusaria estilo como conteúdo.
  assert.ok(!html.includes('<section data-report-tab-reading>'));
  assert.ok(!html.includes(TAB_READING_SECTION_TITLE));

  // Auditoria gravada antes da regra: sem pontos de Tab e sem inventário novo.
  const { model: antigo } = await tabReadingModel({ tabRule: false, stops: [], map: false });
  const antigoHtml = renderHtmlReport(antigo, { forPrint: true });
  assert.ok(!antigoHtml.includes('<section data-report-tab-reading>'));
  assert.match(antigoHtml, /Revisão humana/u);
});

test('o relatório completo (sem ReportView) também traz a seção e a constatação', async () => {
  const { model } = await tabReadingModel({ answers: THREE_ANSWERS });
  const html = renderHtmlReport(model);
  assert.ok(html.includes(TAB_READING_SECTION_TITLE));
  assert.equal((html.match(/data-tab-reading-row=/gu) ?? []).length, 3);
  assert.equal((html.match(/data-report-tab-reading-finding/gu) ?? []).length, 1);
  assert.ok(sectionOf(html).includes('Tab 2, campo de texto sem nome'));
});

test('o texto alternativo do recorte é o mesmo nas duas superfícies que desenham a imagem', async () => {
  const { readFile } = await import('node:fs/promises');
  const reviewScript = await readFile(new URL('../../src/review/review.js', import.meta.url), 'utf8');
  // A frase de origem vive em `evidence-crop.js`; nem a página de conferência nem o HTML a repetem.
  assert.ok(reviewScript.includes('EVIDENCE_CROP_PAGE_ORIGIN_ARIA'));
  assert.ok(!reviewScript.includes('Recorte da captura da página inteira, na região do elemento'));
  const { EVIDENCE_CROP_PAGE_ORIGIN_ARIA } = await import('../../src/core/report/evidence-crop.js');
  assert.equal(EVIDENCE_CROP_PAGE_ORIGIN_ARIA, 'Recorte da captura da página inteira, na região do elemento desta pergunta.');
  assert.deepEqual(DEFAULT_STOPS.map(stop => stop.nodeId), ['n-tab-1', 'n-tab-2', 'n-tab-3']);
});
