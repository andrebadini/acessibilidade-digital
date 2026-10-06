import assert from 'node:assert/strict';
import test from 'node:test';

import { SAMPLE_AUDIT } from '../../fixtures/audits/sample-audit.js';
import { NBR17225_ITEMS } from '../../src/core/normative/nbr17225.js';
import { applyReviewDecisions, createReviewDecision } from '../../src/core/review/decisions.js';
import {
  ANSWER_LABELS, GLOSSARY, LAY_ANSWERS, LAY_GROUPS, buildLayReviewPlan, compareItemIds, describeEvidenceElement,
  draftFinding, formatLocalInstant, imagePlan, layGuideFor, layHint, layReviewProgress, withArticle,
} from '../../src/core/report/lay-review.js';
import { buildFindingsBoard, citationParagraph, scoreboardSentence } from '../../src/core/report/findings-board.js';

const GROUP_IDS = new Set(LAY_GROUPS.map(group => group.id));

test('every one of the 146 ABNT items has a plain-language question, steps and a known group', () => {
  for (const item of NBR17225_ITEMS) {
    const guide = layGuideFor(item.id);
    assert.ok(guide, item.id);
    assert.match(guide.question, /\?$/u, `${item.id} must be phrased as a question`);
    assert.ok(guide.steps.length >= 1, item.id);
    assert.ok(GROUP_IDS.has(guide.group), `${item.id} → ${guide.group}`);
    for (const term of guide.terms) assert.ok(GLOSSARY[term], `${item.id} uses an undefined term: ${term}`);
    // Jargão técnico não aparece na pergunta: a pessoa leiga responde sobre o que vê.
    assert.doesNotMatch(guide.question, /aria-|\balt=|\brole\b|landmark|seletor|WCAG/iu, item.id);
  }
});

test('lay answers map one-to-one onto the four canonical review answers', () => {
  assert.deepEqual(LAY_ANSWERS.map(value => value.answer), ['conforme', 'não conforme', 'não foi possível determinar', 'não se aplica']);
  assert.deepEqual(LAY_ANSWERS.map(value => value.label), ['Sim', 'Não', 'Não consegui verificar', 'Não existe nesta página']);
  for (const value of LAY_ANSWERS) assert.ok(ANSWER_LABELS[value.answer]);
});

test('item ids sort numerically, not as text', () => {
  assert.deepEqual(['5.1.10', '5.10.1', '5.1.2', '5.2.1'].sort(compareItemIds), ['5.1.2', '5.1.10', '5.2.1', '5.10.1']);
});

test('dates are shown in the audit time zone with an explicit offset and no milliseconds', () => {
  assert.equal(formatLocalInstant('2026-10-06T15:03:22.123Z', 'America/Cuiaba'), '06/10/2026, 11:03:22 (America/Cuiaba, UTC−04:00)');
  assert.equal(formatLocalInstant('2026-10-06T15:03:22.123Z', 'Fuso/Inexistente'), '06/10/2026, 15:03:22 (UTC)');
});

test('element facts come from the recorded evidence, in plain words', () => {
  const missing = describeEvidenceElement({ snippet: '<img width="20">', accessibility: { role: 'image', name: '' } });
  assert.equal(missing.label, 'imagem sem nome');
  assert.equal(missing.altAttribute, null);
  assert.equal(withArticle(missing), 'à imagem sem nome');
  const link = describeEvidenceElement({ snippet: '<a href="/x">Saiba mais</a>', accessibility: { role: 'link', name: 'Saiba mais' } });
  assert.equal(link.label, 'link “Saiba mais”');
  assert.equal(link.altAttribute, undefined);
  assert.equal(withArticle(link), 'ao link “Saiba mais”');
  assert.equal(describeEvidenceElement({ snippet: '<img alt="">', accessibility: { role: 'image', name: '' } }).altAttribute, '');
});

test('engine hints become concrete sentences, including the measured contrast', () => {
  assert.match(layHint({ data: { reason: 'insufficient-text-contrast', ratio: 1.9197, threshold: 4.5 } }), /1,92:1.*4,5:1/u);
  assert.match(layHint({ data: { reason: 'zoom-restricted' } }), /impedir a ampliação/u);
  assert.equal(layHint({ data: { reason: 'motivo-desconhecido' } }), null);
});

test('one image purpose resolves 5.2.1 to 5.2.6 from the observed alternative text', () => {
  const noAlt = describeEvidenceElement({ snippet: '<img width="20">', accessibility: { role: 'image', name: '' } });
  const content = imagePlan({ purpose: 'conteudo', element: noAlt });
  assert.equal(content['5.2.1'].answer, 'não conforme');
  for (const id of ['5.2.2', '5.2.3', '5.2.4', '5.2.5', '5.2.6']) assert.equal(content[id].answer, 'não se aplica', id);
  const decorativeEmpty = imagePlan({ purpose: 'decorativa', element: describeEvidenceElement({ snippet: '<img alt="">', accessibility: { role: 'image', name: '' } }) });
  assert.equal(decorativeEmpty['5.2.3'].answer, 'conforme');
  assert.equal(imagePlan({ purpose: 'decorativa', element: noAlt })['5.2.3'].answer, 'não conforme');
  const withAlt = imagePlan({ purpose: 'conteudo', element: describeEvidenceElement({ snippet: '<img alt="foto">', accessibility: { role: 'image', name: 'foto' } }) });
  assert.match(withAlt['5.2.1'].followUp, /“foto”/u);
  assert.ok(imagePlan({ purpose: 'complexa', element: noAlt })['5.2.4'].followUp);
});

test('the image plan never presumes a missing text when the evidence did not record it', () => {
  const unread = describeEvidenceElement({ snippet: '<svg aria-label="Carrinho">', accessibility: {} });
  assert.ok(imagePlan({ purpose: 'funcional', element: unread })['5.2.2'].followUp, 'sem registro, pergunta');
  assert.ok(imagePlan({ purpose: 'decorativa', element: null })['5.2.3'].followUp);
  const unnamedRoleImg = describeEvidenceElement({ snippet: '<div role="img">', accessibility: { role: 'img', name: '', nameSource: 'none' } });
  assert.ok(imagePlan({ purpose: 'decorativa', element: unnamedRoleImg })['5.2.3'].followUp, 'role=img sem nome não é presumida ignorada');
  const emptyAlt = describeEvidenceElement({ snippet: '<img alt="">', accessibility: { role: 'none', name: '', nameSource: 'none' } });
  assert.equal(imagePlan({ purpose: 'conteudo', element: emptyAlt })['5.2.1'].answer, 'não conforme');
  assert.match(imagePlan({ purpose: 'conteudo', element: emptyAlt })['5.2.1'].reason, /marcada como enfeite/u);
});

test('the finding draft is a grammatical first-person sentence the reviewer can edit', () => {
  assert.equal(draftFinding({ itemId: '5.7.4', element: { label: 'link “Saiba mais”', roleWord: 'link' } }),
    'Constatei, em relação ao link “Saiba mais”, que nem o texto do link nem o contexto em volta indicam o destino.');
  assert.match(draftFinding({ itemId: '5.13.5', aid: 'zoom-200' }), /^Constatei, em relação à página, .*ampliação de 200%/u);
});

test('the guided plan groups review entries by element, requirements first, and counts progress', () => {
  const plan = buildLayReviewPlan(SAMPLE_AUDIT);
  assert.equal(plan.length, 2);
  assert.equal(plan[0].requirement, true);
  assert.equal(plan[0].elementLevel, true);
  assert.equal(plan[0].groupId, 'teclado');
  assert.equal(plan[1].requirement, false);
  assert.equal(plan[1].elementLevel, false);
  assert.deepEqual(layReviewProgress(plan), { requirement: { total: 1, answered: 0 }, recommendation: { total: 1, answered: 0 } });
  const reviewed = applyReviewDecisions(SAMPLE_AUDIT, [createReviewDecision({
    auditId: SAMPLE_AUDIT.auditId, itemId: '5.1.4', occurrenceId: 'occ-focus-review', answer: 'conforme',
    evaluator: 'Fiscal Ana', decidedAt: '2026-08-27T12:00:00.000Z', mode: 'assisted',
  })]);
  assert.deepEqual(layReviewProgress(buildLayReviewPlan(reviewed)).requirement, { total: 1, answered: 1 });
});

test('the findings board lists only requirements, with citable sentences for automatic and human findings', () => {
  const board = buildFindingsBoard(SAMPLE_AUDIT);
  const total = Object.values(board.scoreboard).slice(1).reduce((sum, value) => sum + value, 0);
  assert.equal(board.scoreboard.requirements, NBR17225_ITEMS.filter(item => item.classification === 'requirement').length);
  assert.equal(total, board.scoreboard.requirements);
  assert.deepEqual(board.groups.notMet.map(entry => entry.itemId), ['5.1.1']);
  const automatic = board.groups.notMet[0].findings[0];
  assert.equal(automatic.source, 'automatic');
  assert.match(automatic.citation, /^Em \d\d\/\d\d\/\d{4}, \d\d:\d\d:\d\d \(America\/Cuiaba, UTC−0[34]:00\), na página https:\/\/servico\.exemplo\.test\/consulta\/inicio/u);
  assert.match(automatic.citation, /item 5\.1\.1 \(Indicador de foco visível, requisito\) da ABNT NBR 17225:2025/u);
  assert.match(scoreboardSentence(board.scoreboard), /^Dos 96 requisitos da norma: 1 não atendidos/u);
  assert.equal(board.recommendations.pending >= 1, true);

  const reviewed = applyReviewDecisions(SAMPLE_AUDIT, [createReviewDecision({
    auditId: SAMPLE_AUDIT.auditId, itemId: '5.1.4', occurrenceId: 'occ-focus-review', answer: 'não conforme',
    note: 'Ao apertar Tab, a seleção salta do topo para o rodapé.',
    evaluator: 'Fiscal Ana', decidedAt: '2026-08-27T12:00:00.000Z', mode: 'assisted',
  })]);
  const after = buildFindingsBoard(reviewed);
  const human = after.groups.notMet.find(entry => entry.itemId === '5.1.4');
  assert.ok(human);
  assert.equal(human.method, 'revisão humana');
  assert.match(human.findings[0].citation, /revisão humana registrada por Fiscal Ana/u);
  assert.match(human.findings[0].citation, /“Ao apertar Tab, a seleção salta do topo para o rodapé\.”/u);
  assert.equal(citationParagraph({ item: { id: '5.1.4', title: 'Ordem de foco previsível' }, finding: human.findings[0] }), human.findings[0].citation);
  assert.match(after.legalParagraph, /Lei nº 8\.078\/1990/u);
});
