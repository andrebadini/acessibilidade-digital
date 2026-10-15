import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

import { keyboardMapCountsText, keyboardMapPresentation, KEYBOARD_MAP_INTRO } from '../../src/core/report/keyboard-map-presentation.js';
import { draftFinding } from '../../src/core/report/lay-review.js';
import { createKeyboardMapFixture, TEST_PNG } from '../report/keyboard-map-fixture.js';

const source = await readFile(new URL('../../src/review/review.js', import.meta.url), 'utf8');

/** Recorta uma função ou constante de topo do review.js para rodá-la num DOM falso. */
function extract(name) {
  const markers = [`\nconst ${name} = `, `\nfunction ${name}(`, `\nasync function ${name}(`];
  let start = -1, from = 0, isFunction = false;
  for (const marker of markers) {
    const index = source.indexOf(marker);
    if (index >= 0 && (start < 0 || index < start)) {
      // A varredura começa no início do marcador para que parênteses e chaves fiquem equilibrados.
      start = index; from = index;
      isFunction = marker.includes('function');
    }
  }
  if (start < 0) throw new Error(`o review.js deveria definir ${name}`);
  let depth = 0;
  for (let index = from; index < source.length; index += 1) {
    const character = source[index];
    if ('{(['.includes(character)) depth += 1;
    else if ('})]'.includes(character)) depth -= 1;
    else if (depth === 0 && character === ';') return source.slice(start + 1, index + 1);
    else if (depth === 0 && character === '\n' && isFunction && source.slice(start + 1, index).trimEnd().endsWith('}')) {
      return source.slice(start + 1, index);
    }
  }
  throw new Error(`não foi possível recortar ${name}`);
}

function element(tag) {
  const node = {
    tagName: tag, className: '', children: [], attributes: new Map(), dataset: {}, listeners: {}, value: '',
    hidden: false, focus() { document.activeElement = node; },
    addEventListener(type, listener) { (node.listeners[type] ??= []).push(listener); },
    click() { for (const listener of node.listeners.click ?? []) listener({ currentTarget: node, type: 'click' }); },
    append(...items) { node.children.push(...items); },
    insertBefore(child, before) { node.children.splice(node.children.indexOf(before), 0, child); },
    setAttribute(key, value) { node.attributes.set(key, String(value)); },
    getAttribute(key) { return node.attributes.get(key) ?? null; },
  };
  Object.defineProperty(node, 'textContent', {
    get() { return node.ownText ?? ''; },
    set(value) { node.ownText = value === undefined || value === null ? '' : String(value); },
  });
  return node;
}

const walk = node => [node, ...node.children.flatMap(child => walk(child))];
const textOf = node => [node.textContent, ...node.children.map(textOf)].join(' ');
const find = (node, predicate) => walk(node).filter(predicate);

let document;
function fakeDocument() {
  document = { activeElement: null, createElement: tag => element(tag) };
  return document;
}

async function harness() {
  const artifact = await createKeyboardMapFixture();
  artifact.suspects = [{
    number: 1, nodeId: 'n-card', tag: 'div', reason: 'cursor-pointer', name: 'Consumidor',
    nameStatus: 'projected', bounds: { x: 0, y: 4, width: 1, height: 1 }, segmentIndex: 1,
  }];
  artifact.counts.suspects = 1;
  artifact.counts.omittedNotVisible = 1;
  const commits = [];
  const context = {
    document: fakeDocument(),
    chrome: { runtime: { getURL: path => `chrome-extension://test${path}` } },
    isSafeEvidenceImageUrl: () => true,
    keyboardMapPresentation, keyboardMapCountsText, KEYBOARD_MAP_INTRO,
    auditModel: { pages: [{ pageId: 'page-1' }], evidence: [artifact] },
    layState: { activeAids: new Set(), revising: new Set() },
    status: { textContent: '' },
    draftFinding,
    commitAnswers: async (card, plan, trigger) => { commits.push({ card, plan, trigger }); return true; },
    advanceFrom() {},
  };
  const names = ['KEYBOARD_MAP_QUESTION', 'KEYBOARD_MAP_FINDING_PROMPT', 'KEYBOARD_MAP_ANSWERS',
    'el', 'button', 'noteProblem', 'keyboardMapBlock', 'answerForm'];
  const body = names.map(name => extract(name)).join('\n');
  Object.assign(context, {
    LAY_ANSWERS: [{ answer: 'conforme', label: 'Sim', meaning: 'atende ao item' },
      { answer: 'não conforme', label: 'Não', meaning: 'não atende ao item' },
      { answer: 'não foi possível determinar', label: 'Não consegui verificar', meaning: 'fica sem conclusão' },
      { answer: 'não se aplica', label: 'Não existe nesta página', meaning: 'não se aplica' }],
  });
  const api = runInNewContext(`${body}\n({answerForm, keyboardMapBlock, KEYBOARD_MAP_ANSWERS, KEYBOARD_MAP_QUESTION, KEYBOARD_MAP_FINDING_PROMPT})`, context);
  const card = { key: 'card-5.1.13', element: null, elementLevel: false };
  const question = {
    itemId: '5.1.13', hints: ['pista da extensão'], entries: ['occ-1', 'occ-2'],
    guide: { aid: 'keyboard-map' }, item: { id: '5.1.13', title: 'Teclado' },
  };
  return { api, context, card, question, commits, artifact };
}

test('o cartão 5.1.13 troca as respostas genéricas pelas três respostas do mapa', async () => {
  const { api, card, question } = await harness();
  const form = api.answerForm(card, question);
  const answers = find(form, node => node.attributes.has('data-lay-answer'));
  assert.deepEqual(answers.map(node => [node.textContent, node.getAttribute('data-lay-answer')]), [
    ['Sim, falta caixa em algum item', 'não conforme'],
    ['Não, todos os itens que uso têm caixa', 'conforme'],
    ['Não consegui verificar', 'não foi possível determinar'],
  ]);
  // Sem a fileira genérica: dois caminhos de "não conforme" na mesma tela confundiriam quem só quer
  // conferir o mapa.
  assert.equal(answers.some(node => node.textContent === 'Não existe nesta página'), false);
  assert.match(textOf(form), /Pular revisão por enquanto/u);
  const group = find(form, node => String(node.className).includes('lay-keyboard-map-answers'))[0];
  assert.ok(group, 'as três respostas do mapa ficam no próprio grupo');
  assert.equal(group.getAttribute('role'), 'group');
  assert.equal(group.getAttribute('aria-label'), api.KEYBOARD_MAP_QUESTION);
});

test('o bloco do mapa mostra pergunta, legenda, contagens, imagem e listas numeradas', async () => {
  const { api, card, question } = await harness();
  const form = api.answerForm(card, question);
  const block = find(form, node => node.className === 'lay-keyboard-map')[0];
  assert.ok(block, 'a ajuda do mapa precisa aparecer no cartão');
  const blockText = textOf(block).replace(/\s+/gu, ' ');
  assert.ok(blockText.includes('Olhe o mapa. Algum menu, botão, link ou campo que você usaria está SEM caixa azul numerada?'));
  assert.ok(blockText.includes('Cada caixa azul numerada é um lugar onde a tecla Tab para, na ordem dos números. Caixas laranja tracejadas: itens que parecem clicáveis, mas o Tab não chega até eles.'));
  assert.ok(blockText.includes('1 lugar onde o Tab para; 1 item que parece clicável e o Tab não alcança.'));
  assert.ok(blockText.includes('Trecho 1 de 1 da imagem do mapa'));
  const image = find(block, node => node.tagName === 'img')[0];
  assert.equal(image.src, TEST_PNG);
  assert.equal(image.alt, 'Trecho 1 de 1 da imagem do mapa.');
  assert.ok(String(image.className).includes('lay-keyboard-map-thumb'));
  const stop = find(block, node => node.attributes.get('data-keyboard-map-stop') === '1')[0];
  assert.ok(stop, 'a lista numerada identifica cada parada do Tab');
  assert.equal(stop.getAttribute('value'), '1');
  assert.equal(stop.textContent, 'Consultar, botão (botão)');
  const suspect = find(block, node => node.attributes.get('data-keyboard-map-suspect') === '1')[0];
  assert.ok(suspect, 'a lista de itens sem caixa identificável fica separada');
  assert.equal(suspect.getAttribute('value'), null, 'suspeitos não levam número: no desenho eles têm "?"');
  assert.equal(suspect.textContent, 'Consumidor — mostra a seta de clique e mesmo assim não recebe o Tab');
  // A estimativa é declarada: a lista não foi observada apertando Tab.
  assert.match(blockText, /não foi observada pressionando Tab/u);
});

test('“Sim, falta caixa em algum item” abre a descrição obrigatória antes de registrar', async () => {
  const { api, context, card, question, commits } = await harness();
  const form = api.answerForm(card, question);
  const finding = find(form, node => node.className === 'lay-finding')[0];
  assert.equal(finding.hidden, true);

  find(form, node => node.getAttribute('data-lay-answer') === 'não conforme')[0].click();
  assert.equal(finding.hidden, false);
  const textarea = find(finding, node => node.tagName === 'textarea')[0];
  assert.equal(context.document.activeElement, textarea);
  assert.equal(commits.length, 0, 'abrir a descrição não pode registrar nada');
  // O rascunho já traz a frase do mapa do teclado, pronta para ajustar.
  assert.match(textarea.value, /não recebe caixa azul numerada no mapa do teclado/u);

  // Mesmo com o rascunho preenchido, a caixa é obrigatória: esvaziada, o registro não acontece.
  textarea.value = '   ';
  find(finding, node => String(node.className).includes('lay-confirm-fail'))[0].click();
  await Promise.resolve();
  assert.equal(commits.length, 0, 'sem descrição, a não conformidade não é registrada');
  assert.match(context.status.textContent, /Descreva o que você constatou/u);

  textarea.value = 'Os cartões Consumidor, Fornecedor, Servidor e Ouvidoria abrem menus só com o mouse';
  find(finding, node => String(node.className).includes('lay-confirm-fail'))[0].click();
  await Promise.resolve();
  assert.equal(commits.length, 1);
  assert.deepEqual(commits[0].plan.map(entry => [entry.itemId, entry.answer, entry.note]), [
    ['5.1.13', 'não conforme', 'Os cartões Consumidor, Fornecedor, Servidor e Ouvidoria abrem menus só com o mouse'],
    ['5.1.13', 'não conforme', 'Os cartões Consumidor, Fornecedor, Servidor e Ouvidoria abrem menus só com o mouse'],
  ]);
  assert.deepEqual(commits[0].plan.map(entry => entry.target), ['occ-1', 'occ-2']);
});

test('“Não, todos os itens que uso têm caixa” registra conforme sem exigir texto', async () => {
  const { api, card, question, commits, context } = await harness();
  const form = api.answerForm(card, question);
  find(form, node => node.getAttribute('data-lay-answer') === 'conforme')[0].click();
  await Promise.resolve();
  assert.equal(commits.length, 1);
  assert.deepEqual(commits[0].plan.map(entry => entry.answer), ['conforme', 'conforme']);
  assert.deepEqual(commits[0].plan.map(entry => entry.note), ['', '']);

  const undecided = api.answerForm(card, question);
  find(undecided, node => node.getAttribute('data-lay-answer') === 'não foi possível determinar')[0].click();
  await Promise.resolve();
  assert.equal(commits.length, 2);
  assert.deepEqual(commits[1].plan.map(entry => entry.answer), ['não foi possível determinar', 'não foi possível determinar']);
  assert.equal(context.status.textContent, '');
});

test('sem mapa do teclado na auditoria o cartão volta às respostas genéricas', async () => {
  const { api, card, question, context } = await harness();
  context.auditModel = { pages: [{ pageId: 'page-1' }], evidence: [] };
  const form = api.answerForm(card, question);
  assert.equal(find(form, node => node.className === 'lay-keyboard-map').length, 0);
  assert.deepEqual(find(form, node => node.attributes.has('data-lay-answer')).map(node => node.textContent),
    ['Sim', 'Não', 'Não consegui verificar', 'Não existe nesta página']);
});
