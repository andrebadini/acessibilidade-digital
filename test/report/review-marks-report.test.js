import assert from 'node:assert/strict';
import test from 'node:test';

import { SAMPLE_AUDIT } from '../../fixtures/audits/sample-audit.js';
import { hashKeyboardMapArtifact } from '../../src/core/keyboard/keyboard-map-artifact.js';
import { createAuditModel } from '../../src/core/report/audit-model.js';
import { buildFindingsBoard } from '../../src/core/report/findings-board.js';
import { renderHtmlReport } from '../../src/core/report/html.js';
import { canonicalReviewQuestion } from '../../src/core/report/text-policy.js';
import { marksText, reviewMarksAreaCrops, reviewMarksRecords } from '../../src/core/report/review-marks-presentation.js';
import { applyReviewDecisions, createReviewDecision } from '../../src/core/review/decisions.js';
import { REVIEW_MARKS_VERSION } from '../../src/core/review/review-marks.js';
import { createKeyboardMapFixture, createPristineMapSource, TEST_PNG } from './keyboard-map-fixture.js';

const AREA = Object.freeze({ x: 0, y: 0, width: 1, height: 1 });
const NOTE = 'Os cartões de serviço abrem menus só quando o mouse passa por cima.';

/** Mapa do teclado com um item laranja visível, para o apontamento ter a que se referir. */
async function mapWithSuspect() {
  const artifact = await createKeyboardMapFixture();
  artifact.suspects = [{
    number: 1, nodeId: 'n-card', tag: 'div', role: '', reason: 'cursor-pointer', ruleId: null,
    name: 'Consumidor', nameSource: 'contents', nameStatus: 'projected',
    bounds: { x: 0, y: 0, width: 1, height: 1 }, segmentIndex: 1,
  }];
  artifact.counts.suspects = 1;
  artifact.hash = await hashKeyboardMapArtifact(artifact);
  return artifact;
}

/**
 * Auditoria com uma revisão humana do item 5.1.13 e a marcação feita no mapa: os números dos itens
 * sem caixa e uma área desenhada, em pixels CSS do documento.
 */
async function marksAudit({
  marks = { version: REVIEW_MARKS_VERSION, suspects: [1], areas: [AREA] },
  itemId = '5.1.13',
  map = null,
} = {}) {
  const source = structuredClone(SAMPLE_AUDIT);
  source.evidence[0] = createPristineMapSource();
  source.evidence.push(map ?? await mapWithSuspect());
  const review = structuredClone(source.occurrences.find(value => value.occurrenceId === 'occ-cross-page'));
  const item = source.itemResults.find(value => value.id === itemId);
  source.occurrences.push(Object.assign(review, {
    occurrenceId: 'occ-keyboard-513', itemId, nbrItemRef: itemId,
    // A ocorrência de revisão manual se identifica pela origem "manual:<item>" e repete a
    // classificação normativa do próprio item (requisito ou recomendação).
    source: { ...review.source, ruleId: `manual:${itemId}` },
    classification: item.classification,
    // A justificativa da revisão humana é a do próprio item, como o modelo exige.
    justification: item.humanReason,
  }));
  source.manualReview.push({
    occurrenceId: 'occ-keyboard-513', itemId, ruleId: null, mode: 'manual', status: 'unanswered',
    question: canonicalReviewQuestion(item), reason: item.humanReason,
  });
  const decision = createReviewDecision({
    auditId: source.auditId, itemId, occurrenceId: 'occ-keyboard-513', answer: 'não conforme',
    evaluator: 'Pessoa revisora', decidedAt: '2026-08-27T12:00:00.000Z', mode: 'manual', note: NOTE, marks,
  });
  return createAuditModel(applyReviewDecisions(source, [decision]));
}

test('o apontamento do mapa entra no texto copiável e na citação do quadro de constatações', async () => {
  const model = await marksAudit();
  const entry = buildFindingsBoard(model).groups.notMet.find(value => value.itemId === '5.1.13');
  assert.ok(entry, 'a resposta do mapa reprova o item 5.1.13');
  const finding = entry.findings[0];
  assert.equal(finding.text, `${NOTE} Itens apontados: Consumidor. Áreas marcadas no mapa do teclado: 1.`);
  assert.equal(finding.marksText, 'Itens apontados: Consumidor. Áreas marcadas no mapa do teclado: 1.');
  assert.match(finding.citation, /Itens apontados: Consumidor\. Áreas marcadas no mapa do teclado: 1\./u);
  assert.match(finding.citation, /item 5\.1\.13 \([^)]+, requisito\) da ABNT NBR 17225:2025/u);
  assert.deepEqual(finding.marks, { version: REVIEW_MARKS_VERSION, suspects: [1], areas: [AREA] });
});

test('a decisão sem marcação continua com a constatação de sempre', async () => {
  const source = await marksAudit({ marks: null });
  const finding = buildFindingsBoard(source).groups.notMet.find(value => value.itemId === '5.1.13').findings[0];
  assert.equal(finding.text, NOTE);
  assert.equal(finding.marks, null);
  assert.doesNotMatch(finding.citation, /Itens apontados/u);
});

test('o nome omitido por privacidade e o item sem nome aparecem como na lista do mapa', async () => {
  const map = await createKeyboardMapFixture();
  map.suspects = [
    { ...map.stops[0], number: 1, name: 'Consumidor', nameStatus: 'projected', reason: 'cursor-pointer', ruleId: null },
    { ...map.stops[0], number: 2, name: '', nameStatus: 'omitted-privacy', reason: 'cursor-pointer', ruleId: null },
    { ...map.stops[0], number: 3, name: '', nameStatus: 'projected', reason: 'cursor-pointer', ruleId: null },
  ];
  map.counts.suspects = 3;

  // O apontamento cita o nome exatamente como a pessoa leu na lista de itens sem caixa.
  assert.equal(marksText({ version: 1, suspects: [1, 2, 3], areas: [] }, map),
    'Itens apontados: Consumidor; Nome omitido por privacidade; Sem nome visível.');
  // Sem áreas marcadas a contagem não aparece: o texto só cita o que existe.
  assert.equal(marksText({ version: 1, suspects: [1], areas: [AREA] }, map),
    'Itens apontados: Consumidor. Áreas marcadas no mapa do teclado: 1.');
  // Número que o mapa não tem (defesa): o texto nomeia a posição na lista, nunca inventa um nome.
  assert.equal(marksText({ version: 1, suspects: [1, 9], areas: [] }, map),
    'Itens apontados: Consumidor; item 9 da lista.');
});

test('o recorte da área reaproveita a imagem guardada e aponta o trecho certo', async () => {
  const model = await marksAudit();
  const record = reviewMarksRecords(model)[0];
  assert.equal(record.itemId, '5.1.13');
  assert.deepEqual(record.areas, [{ number: 1, ...AREA }]);
  const crop = record.crops[0];
  assert.equal(crop.segmentId, 'ev-keyboard-map-segment-1');
  assert.equal(crop.dataUrl, TEST_PNG, 'o recorte usa a imagem já guardada, sem gerar pixel novo');
  assert.deepEqual(crop.area, { x: 0, y: 0, width: 1, height: 1 });
  assert.ok(crop.view.width > 1 && crop.view.height > 1, 'a área marcada vem com folga em volta');
  assert.match(crop.caption, /Área 1 marcada na revisão guiada/u);
});

test('o relatório entregue mostra os itens apontados e o recorte com contorno, sem estilo embutido', async () => {
  const model = await marksAudit();
  const html = renderHtmlReport(model);
  assert.match(html, /Itens apontados: Consumidor\. Áreas marcadas no mapa do teclado: 1\./u);
  assert.match(html, /<svg class="marks-crop"[^>]*data-marks-crop="1"/u);
  assert.match(html, /<rect class="marks-area-outline"/u);
  assert.ok(html.includes(TEST_PNG), 'a imagem do recorte é a mesma evidência já embarcada');
  // A meta de segurança do relatório não permite atributo de estilo: o desenho é todo apresentacional.
  assert.doesNotMatch(html, /<svg[^>]* style=/u);
  assert.doesNotMatch(html, /<rect[^>]* style=/u);
  assert.doesNotMatch(html, /data-marks-crop="1"[^>]*><(image|rect)[^>]*style=/u);

  // Sem trecho de imagem guardado não há recorte a inventar: o apontamento continua no texto.
  const semImagem = await createKeyboardMapFixture({ status: 'empty' });
  const marks = { version: REVIEW_MARKS_VERSION, suspects: [], areas: [AREA] };
  assert.deepEqual(reviewMarksAreaCrops(marks, semImagem), [],
    'mapa sem imagem não produz recorte');
  assert.equal(marksText(marks, semImagem), 'Áreas marcadas no mapa do teclado: 1.');
});

test('o modelo recusa apontamento que não existe no mapa ou que sai do documento', async () => {
  const markOf = marks => ({ version: REVIEW_MARKS_VERSION, suspects: [], areas: [], ...marks });
  // Como nos demais testes de contrato, o modelo embrulha toda incoerência num erro único: o que se
  // afirma é que marcas incoerentes não entram no relatório.
  const inválido = /Modelo de auditoria inválido/u;
  await assert.rejects(marksAudit({ marks: markOf({ suspects: [2] }) }), inválido,
    'número que não está na lista de itens sem caixa');
  // A captura de referência tem 160×100 CSS: a área abaixo é maior que a página inteira.
  await assert.rejects(marksAudit({ marks: markOf({ areas: [{ x: 0, y: 0, width: 400, height: 100 }] }) }), inválido,
    'área que passa do documento observado');
  await assert.rejects(marksAudit({ marks: markOf({ suspects: [1] }), itemId: '5.1.4' }), inválido,
    'item que não é o do mapa do teclado');
  await assert.rejects(marksAudit({ marks: markOf({ areas: [AREA] }), map: await createKeyboardMapFixture({ status: 'empty' }) }),
    inválido, 'área marcada em mapa sem imagem guardada');

  // A mesma marcação, dentro do mapa e do documento, é aceita: a recusa vem da incoerência.
  assert.deepEqual((await marksAudit()).reviewDecisions[0].marks, { version: REVIEW_MARKS_VERSION, suspects: [1], areas: [AREA] });
});
