import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

import { documentRectToSegmentPixels, integerDocumentArea, segmentPixelsToDocumentRect } from '../../src/core/keyboard/keyboard-map-geometry.js';
import { keyboardMapCountsText, keyboardMapPresentation, KEYBOARD_MAP_INTRO } from '../../src/core/report/keyboard-map-presentation.js';
import { draftFinding } from '../../src/core/report/lay-review.js';
import { canonicalReviewMarks, describeReviewAreaPosition, REVIEW_MARKS_LIMITS, REVIEW_MARKS_VERSION } from '../../src/core/review/review-marks.js';
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
    tagName: tag, children: [], attributes: new Map(), dataset: {}, listeners: {}, value: '',
    hidden: false, focus() { document.activeElement = node; },
    addEventListener(type, listener) { (node.listeners[type] ??= []).push(listener); },
    click() { for (const listener of node.listeners.click ?? []) listener({ currentTarget: node, type: 'click' }); },
    append(...items) { for (const item of items) { item.parent = node; node.children.push(item); } },
    insertBefore(child, before) { child.parent = node; node.children.splice(node.children.indexOf(before), 0, child); },
    replaceChildren(...items) {
      node.children = [];
      for (const item of items) { item.parent = node; node.children.push(item); }
    },
    // O desenho tira o retângulo provisório e os antigos antes de pintar de novo: sem tirar de verdade,
    // a árvore acumularia retângulos que não existem mais.
    remove() {
      node.removed = true;
      const siblings = node.parent?.children;
      if (Array.isArray(siblings)) siblings.splice(siblings.indexOf(node), 1);
      node.parent = null;
    },
    setAttribute(key, value) { node.attributes.set(key, String(value)); },
    getAttribute(key) { return node.attributes.get(key) ?? null; },
    // Caixas e botões de teste medem o que já foi combinado no shim: o desenho usa as coordenadas do
    // evento e o tamanho da imagem, sem layout de verdade.
    getBoundingClientRect() {
      if (node.rect) return node.rect;
      // A imagem do mapa é desenhada no tamanho dela: 1 pixel da imagem por pixel do documento.
      const width = tag === 'svg' ? Number(node.attributes.get('width') ?? 0) : 0;
      const height = tag === 'svg' ? Number(node.attributes.get('height') ?? 0) : 0;
      return { left: 0, top: 0, width, height, right: width, bottom: height };
    },
  };
  let className = '';
  Object.defineProperty(node, 'className', {
    get() { return className; },
    set(value) {
      className = value;
      // Layout fingido: a superfície de desenho do mapa ocupa a janela a partir do topo. É o único
      // retângulo que o desenho consulta além da própria imagem.
      if (String(value).includes('lay-marks-surface')) {
        node.rect = { left: 0, top: 0, width: 1000, height: 1000, right: 1000, bottom: 1000 };
      }
    },
  });
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
  document = {
    activeElement: null,
    createElement: tag => element(tag),
    // O mapa desenhado usa SVG: o shim trata os dois criadores do mesmo jeito.
    createElementNS: (namespace, tag) => { const node = element(tag); node.namespace = namespace; return node; },
  };
  return document;
}

async function harness({ size = null } = {}) {
  const artifact = await createKeyboardMapFixture();
  // Uma página de verdade tem milhares de pixels CSS: só assim as áreas marcadas (mínimo de 8 px)
  // cabem no documento. O tamanho padrão de 1 × 1 serve às asserções do bloco do mapa.
  if (size) {
    artifact.derivation.geometry.sourceCssSize = { ...size };
    artifact.derivation.geometry.sourcePixelSize = { ...size };
    artifact.segments[0].sourceCssClip = { x: 0, y: 0, ...size };
    artifact.segments[0].width = size.width;
    artifact.segments[0].height = size.height;
  }
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
    layState: { activeAids: new Set(), revising: new Set(), marks: new Map() },
    status: { textContent: '' },
    draftFinding,
    // O apontamento no mapa: esquema fechado das marcas e a conta documento ↔ imagem. O esquema recusa
    // objetos de outro reino (proteção contra protótipos forjados); a ponte do teste copia por JSON,
    // como a mensagem real, que trafega serializada, já faz.
    canonicalReviewMarks: value => canonicalReviewMarks(value ? JSON.parse(JSON.stringify(value)) : value),
    REVIEW_MARKS_LIMITS, REVIEW_MARKS_VERSION, describeReviewAreaPosition,
    documentRectToSegmentPixels, segmentPixelsToDocumentRect, integerDocumentArea,
    window: { innerHeight: 800 },
    commitAnswers: async (card, plan, trigger) => { commits.push({ card, plan, trigger }); return true; },
    advanceFrom() {},
  };
  const names = ['KEYBOARD_MAP_QUESTION', 'KEYBOARD_MAP_FINDING_PROMPT', 'KEYBOARD_MAP_ANSWERS',
    'MARKS_AREA_STEP', 'MARKS_MIN_SIZE', 'MARKS_NEW_AREA_RATIO', 'MARKS_MIN_NEW_AREA',
    'marksState', 'marksForSubmit', 'describeMarksArea', 'keyboardMarksBlock',
    'el', 'button', 'noteProblem', 'keyboardMapBlock', 'answerForm'];
  const body = names.map(name => extract(name)).join('\n');
  Object.assign(context, {
    LAY_ANSWERS: [{ answer: 'conforme', label: 'Sim', meaning: 'atende ao item' },
      { answer: 'não conforme', label: 'Não', meaning: 'não atende ao item' },
      { answer: 'não foi possível determinar', label: 'Não consegui verificar', meaning: 'fica sem conclusão' },
      { answer: 'não se aplica', label: 'Não existe nesta página', meaning: 'não se aplica' }],
  });
  const api = runInNewContext(`${body}\n({answerForm, keyboardMapBlock, keyboardMarksBlock, marksForSubmit, KEYBOARD_MAP_ANSWERS, KEYBOARD_MAP_QUESTION, KEYBOARD_MAP_FINDING_PROMPT})`, context);
  const card = { key: 'card-5.1.13', pageId: 'page-1', element: null, elementLevel: false };
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

// --- Apontar no mapa do teclado (item 5.1.13): itens sem caixa e áreas desenhadas ---

const SVG_NS = 'http://www.w3.org/2000/svg';
const SURFACE_SIZE = { width: 1000, height: 2000 };

/** Abre a descrição obrigatória e devolve o bloco de apontamento já montado. */
function openMarks(api, form) {
  find(form, node => node.getAttribute('data-lay-answer') === 'não conforme')[0].click();
  const blocks = find(form, node => node.attributes.has('data-lay-marks'));
  assert.equal(blocks.length, 1, 'o bloco de apontamento aparece uma vez só');
  return blocks[0];
}

const marksBox = (block, number) => find(block, node => node.attributes.get('data-lay-marks-suspect') === String(number))[0];
const marksSurface = block => find(block, node => String(node.className).includes('lay-marks-surface'))[0];
const marksStatus = block => find(block, node => node.attributes.has('data-lay-marks-status'))[0];
const areaRects = block => find(block, node => node.attributes.has('data-lay-marks-area') && node.tagName === 'rect');
const areaButtons = block => find(block, node => node.attributes.has('data-lay-marks-area-list'));

function pressKey(surface, key, { shift = false } = {}) {
  let prevented = 0;
  for (const listener of surface.listeners.keydown ?? []) {
    listener({ key, shiftKey: shift, preventDefault() { prevented += 1; } });
  }
  return prevented;
}

function pointer(node, type, x, y) {
  for (const listener of node.listeners[type] ?? []) {
    listener({
      button: 0, pointerId: 1, clientX: x, clientY: y, target: node,
      preventDefault() {}, shiftKey: false,
    });
  }
}

function readMarks(entry) {
  return entry?.marks ? JSON.parse(JSON.stringify(entry.marks)) : null;
}

test('“Sim, falta caixa” mostra os itens laranja para apontar e grava os números apontados', async () => {
  const { api, card, question, commits } = await harness();
  const form = api.answerForm(card, question);
  const finding = find(form, node => node.className === 'lay-finding')[0];
  assert.equal(find(form, node => node.attributes.has('data-lay-marks')).length, 0,
    'o apontamento não existe antes de a pessoa escolher “Sim, falta caixa”');

  const block = openMarks(api, form);
  assert.equal(block.getAttribute('data-lay-marks'), card.key);
  assert.match(textOf(block), /Marque os itens que ficaram sem caixa azul/u);
  const box = marksBox(block, 1);
  assert.ok(box, 'cada item laranja do mapa vira uma caixa de marcação');
  assert.equal(box.type, 'checkbox');
  assert.equal(box.getAttribute('checked'), null);
  const label = find(block, node => node.tagName === 'label')[0];
  assert.match(textOf(label), /Consumidor — mostra a seta de clique e mesmo assim não recebe o Tab/u);

  // Desmarcado por padrão: nada é apontado sem a pessoa marcar.
  box.checked = false;
  for (const listener of box.listeners.change ?? []) listener({ type: 'change' });
  assert.equal(marksStatus(block).textContent, 'Item “Consumidor” desmarcado.');

  box.checked = true;
  for (const listener of box.listeners.change ?? []) listener({ type: 'change' });
  assert.equal(marksStatus(block).textContent, 'Item “Consumidor” marcado como sem caixa azul.');

  const textarea = find(finding, node => node.tagName === 'textarea')[0];
  textarea.value = 'O cartão Consumidor abre o menu só com o mouse';
  find(finding, node => String(node.className).includes('lay-confirm-fail'))[0].click();
  await Promise.resolve();
  assert.equal(commits.length, 1);
  // A marca acompanha cada ocorrência do item, em forma canônica e versionada.
  assert.deepEqual(commits[0].plan.map(entry => readMarks(entry)), [
    { version: 1, suspects: [1], areas: [] },
    { version: 1, suspects: [1], areas: [] },
  ]);
});

test('sem apontar nada a decisão não ganha marcas, e “conforme” nunca leva marcas', async () => {
  const { api, card, question, commits } = await harness();
  const form = api.answerForm(card, question);
  openMarks(api, form);
  const finding = find(form, node => node.className === 'lay-finding')[0];
  find(finding, node => node.tagName === 'textarea')[0].value = 'Nenhum item ficou sem caixa';
  find(finding, node => String(node.className).includes('lay-confirm-fail'))[0].click();
  await Promise.resolve();
  assert.equal(commits.length, 1);
  assert.deepEqual(commits[0].plan.map(readMarks), [null, null], 'apontamento é opcional');

  const { api: other, card: otherCard, question: otherQuestion, commits: otherCommits } = await harness();
  const otherForm = other.answerForm(otherCard, otherQuestion);
  const otherBlock = openMarks(other, otherForm);
  const box = marksBox(otherBlock, 1);
  box.checked = true;
  for (const listener of box.listeners.change ?? []) listener({ type: 'change' });
  find(otherForm, node => node.getAttribute('data-lay-answer') === 'conforme')[0].click();
  await Promise.resolve();
  assert.deepEqual(otherCommits[0].plan.map(readMarks), [null, null],
    '“todos os itens têm caixa” não pode carregar apontamento de item sem caixa');
});

test('“Adicionar área” cria a área no centro visível e as setas movem, redimensionam e removem', async () => {
  const { api, card, question, commits } = await harness({ size: SURFACE_SIZE });
  const form = api.answerForm(card, question);
  const block = openMarks(api, form);
  const surface = marksSurface(block);
  assert.equal(surface.getAttribute('tabindex'), '0', 'a superfície do desenho é alcançável pelo Tab');
  assert.equal(surface.getAttribute('role'), 'group');
  assert.match(surface.getAttribute('aria-label'), /Shift com as setas para redimensionar e Delete para remover/u);

  // Centro da parte visível: metade de 1000 de largura e 400 px abaixo do topo (a janela corta em 800).
  find(block, node => String(node.className).includes('lay-marks-add'))[0].click();
  assert.deepEqual(areaRects(block).map(rect => [
    rect.getAttribute('data-lay-marks-area'), rect.getAttribute('x'), rect.getAttribute('y'),
    rect.getAttribute('width'), rect.getAttribute('height'),
  ]), [['1', '425', '250', '150', '300']]);
  assert.equal(areaRects(block)[0].getAttribute('class'), 'lay-marks-area lay-marks-area--selected');
  assert.equal(marksStatus(block).textContent,
    'Área 1, no alto da página, no centro. Área marcada. Use as setas para mover, Shift com as setas para redimensionar e Delete para remover.');
  assert.equal(areaButtons(block).length, 1);
  assert.match(textOf(areaButtons(block)[0]), /Área 1, no alto da página, no centro\. \(área escolhida\)/u);
  const remove = find(block, node => node.tagName === 'button' && node.textContent === 'Remover área 1')[0];
  assert.ok(remove, 'cada área tem o seu botão de remover, sem depender do mouse');

  // Setas movem de 8 em 8 pixels do documento; Shift redimensiona.
  assert.equal(pressKey(surface, 'ArrowRight'), 1, 'a tecla não rola a página: o movimento é da área');
  assert.deepEqual(areaRects(block).map(rect => rect.getAttribute('x')), ['433']);
  assert.equal(marksStatus(block).textContent, 'Área 1, no alto da página, no centro.');
  pressKey(surface, 'ArrowDown', { shift: true });
  assert.deepEqual(areaRects(block).map(rect => [rect.getAttribute('width'), rect.getAttribute('height')]), [['150', '308']]);

  // A área escolhida continua sendo a que as setas movem, e o remover por teclado é o mesmo do botão.
  pressKey(surface, 'Delete');
  assert.equal(areaRects(block).length, 0);
  assert.equal(areaButtons(block).length, 0);
  assert.match(marksStatus(block).textContent, /Área removida: Área 1, no alto da página, no centro\. Restam 0 áreas marcadas\./u);
  pressKey(surface, 'ArrowRight');
  assert.equal(marksStatus(block).textContent, 'Escolha uma área na lista antes de mover.');

  find(block, node => String(node.className).includes('lay-marks-add'))[0].click();
  const textarea = find(form, node => node.tagName === 'textarea')[0];
  textarea.value = 'O menu do cabeçalho só abre com o mouse';
  find(form, node => String(node.className).includes('lay-confirm-fail'))[0].click();
  await Promise.resolve();
  assert.deepEqual(commits[0].plan.map(entry => readMarks(entry).areas), [
    [{ x: 425, y: 250, width: 150, height: 300 }],
    [{ x: 425, y: 250, width: 150, height: 300 }],
  ]);
});

test('o mouse desenha arrastando sobre a imagem e clique curto não vira área', async () => {
  const { api, card, question } = await harness({ size: SURFACE_SIZE });
  const form = api.answerForm(card, question);
  const block = openMarks(api, form);
  const svg = find(block, node => node.attributes.has('data-lay-marks-segment'))[0];
  assert.equal(svg.namespace, SVG_NS);
  assert.equal(svg.getAttribute('viewBox'), `0 0 ${SURFACE_SIZE.width} ${SURFACE_SIZE.height}`);
  const image = find(svg, node => node.tagName === 'image')[0];
  assert.equal(image.getAttribute('href'), TEST_PNG, 'a imagem guardada é reaproveitada, sem gerar pixel novo');

  pointer(svg, 'pointerdown', 100, 200);
  pointer(svg, 'pointermove', 300, 500);
  assert.deepEqual(areaRects(block).map(rect => [rect.getAttribute('x'), rect.getAttribute('y'), rect.getAttribute('width'), rect.getAttribute('height')]), [],
    'o retângulo em desenho ainda não é uma área marcada');
  const drawing = find(svg, node => String(node.getAttribute('class')).includes('lay-marks-area--drawing'))[0];
  assert.deepEqual([drawing.getAttribute('x'), drawing.getAttribute('y'), drawing.getAttribute('width'), drawing.getAttribute('height')],
    ['100', '200', '200', '300']);
  pointer(svg, 'pointerup', 300, 500);
  assert.deepEqual(areaRects(block).map(rect => [rect.getAttribute('x'), rect.getAttribute('y'), rect.getAttribute('width'), rect.getAttribute('height')]),
    [['100', '200', '200', '300']]);
  assert.equal(drawing.removed, true, 'o retângulo provisório sai de cena quando a área é registrada');

  // Clique sem arrastar não cria nada: a área mínima é de 8 pixels do documento.
  pointer(svg, 'pointerdown', 400, 400);
  pointer(svg, 'pointerup', 402, 401);
  assert.equal(areaRects(block).length, 1);
  assert.equal(marksStatus(block).textContent, 'A área marcada ficou pequena demais; clique e arraste para desenhar um retângulo maior.');
});

test('as áreas marcadas param em cinco e as marcas voltam numa nova abertura do cartão', async () => {
  const { api, card, question, context } = await harness({ size: SURFACE_SIZE });
  const form = api.answerForm(card, question);
  const block = openMarks(api, form);
  const add = find(block, node => String(node.className).includes('lay-marks-add'))[0];
  for (let index = 0; index < REVIEW_MARKS_LIMITS.maxAreas; index += 1) add.click();
  assert.equal(areaRects(block).length, REVIEW_MARKS_LIMITS.maxAreas);
  add.click();
  assert.equal(areaRects(block).length, REVIEW_MARKS_LIMITS.maxAreas, 'o limite de áreas é respeitado');
  assert.equal(marksStatus(block).textContent,
    `O limite é de ${REVIEW_MARKS_LIMITS.maxAreas} áreas marcadas. Remova uma área antes de marcar outra.`);

  // A decisão guardada com marcas volta marcada quando o cartão é montado de novo.
  const saved = api.marksForSubmit(card.key, question);
  assert.equal(saved.areas.length, REVIEW_MARKS_LIMITS.maxAreas);
  const restored = { ...question, entries: question.entries.map(entry => ({ ...entry, decision: { decidedAt: '2026-01-01T00:00:00Z', marks: saved } })) };
  context.layState.marks.clear();
  const reopened = api.answerForm(card, restored);
  const reopenedBlock = openMarks(api, reopened);
  assert.equal(areaRects(reopenedBlock).length, REVIEW_MARKS_LIMITS.maxAreas, 'as áreas gravadas voltam desenhadas');
  assert.equal(marksStatus(reopenedBlock).textContent, `${REVIEW_MARKS_LIMITS.maxAreas} áreas marcadas nesta resposta.`);
});
