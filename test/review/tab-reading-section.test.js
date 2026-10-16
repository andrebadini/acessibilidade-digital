/**
 * Seção "Leitura por Tab" da verificação guiada: o que a pessoa vê e o que acontece ao responder.
 *
 * O teste roda o próprio trecho de `review.js` num contexto isolado, com um DOM de mentira que registra
 * atributos, textos, foco e cliques — é assim que se prova comportamento de tela sem navegador. O que se
 * verifica aqui: a pergunta nomeia o elemento, cada resposta grava na hora, "Não" abre o campo do que
 * deveria ser dito, a janela de 20 linhas e o filtro de pendentes funcionam, e a marcação em bloco só
 * acontece depois da confirmação.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

import * as layReview from '../../src/core/report/lay-review.js';
import * as evidenceCrop from '../../src/core/report/evidence-crop.js';
import * as tabPlan from '../../src/core/report/tab-reading-plan.js';
import { EVIDENCE_HIGHLIGHT_UNMARKED_LEGEND } from '../../src/core/report/evidence-highlight.js';
import { GUIDED_REVIEW_TREATMENT_V1 } from '../../src/core/report/evidence-treatment.js';
import { isSafeEvidenceImageUrl } from '../../src/review/review-state.js';
import { applyReviewDecisions, createReviewDecision } from '../../src/core/review/decisions.js';
import { DEFAULT_STOPS, TEST_PNG, tabReadingModel } from '../report/tab-reading-fixture.js';

const source = await readFile(new URL('../../src/review/review.js', import.meta.url), 'utf8');
const renderSource = source.slice(source.indexOf('const layState = {'), source.indexOf('\nasync function start()'));

// ------------------------------------------------------------------ DOM de mentira

class Element {
  constructor(tag) {
    this.tagName = String(tag).toLowerCase();
    this.children = [];
    this.parent = null;
    this.textContent = '';
    this.attributes = {};
    this.listeners = new Map();
    this.classList = { add() {}, toggle() {}, contains: () => false };
  }

  get className() { return this.attributes.class ?? ''; }
  set className(value) { this.attributes.class = String(value); }
  get firstChild() { return this.children[0]; }
  get hidden() { return this._hidden === true; }
  set hidden(value) { this._hidden = Boolean(value); }

  append(...nodes) {
    for (const node of nodes) { node.parent = this; this.children.push(node); }
  }

  replaceWith(node) {
    const parent = this.parent;
    if (!parent) return;
    parent.children[parent.children.indexOf(this)] = node;
    node.parent = parent;
  }

  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null; }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  dispatch(type) { return this.listeners.get(type)?.({ currentTarget: this, target: this }); }
  click() { return this.dispatch('click'); }
  focus() { this.focused = true; this.ownerDocument.focused = this; }
  querySelectorAll(selector) { return matchesAll(this, selector); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}

function parseCompound(part) {
  const compound = { tag: null, classes: [], attributes: [] };
  for (const [token] of part.matchAll(/[a-zA-Z]+|\.[\w-]+|\[[^\]]+\]/gu)) {
    if (token.startsWith('.')) compound.classes.push(token.slice(1));
    else if (token.startsWith('[')) {
      const body = token.slice(1, -1);
      const [name, raw] = body.split('=');
      compound.attributes.push([name, raw === undefined ? null : raw.replace(/^["']|["']$/gu, '')]);
    } else compound.tag = token.toLowerCase();
  }
  return compound;
}

function matches(node, part) {
  const compound = parseCompound(part);
  if (compound.tag && node.tagName !== compound.tag) return false;
  const classes = String(node.attributes.class ?? '').split(/\s+/u).filter(Boolean);
  if (!compound.classes.every(name => classes.includes(name))) return false;
  return compound.attributes.every(([name, value]) => {
    const own = Object.hasOwn(node.attributes, name) ? node.attributes[name] : undefined;
    return value === null ? own !== undefined : own === value;
  });
}

function matchesChain(node, parts) {
  if (parts.length === 0) return false;
  if (!matches(node, parts[parts.length - 1])) return false;
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (matchesChain(parent, parts.slice(0, -1))) return true;
  }
  return parts.length === 1;
}

function matchesAll(root, selector) {
  const parts = String(selector).trim().split(/\s+/u);
  return descendants(root).filter(node => matchesChain(node, parts));
}

function descendants(root) {
  return (root.children ?? []).flatMap(child => [child, ...descendants(child)]);
}

// ------------------------------------------------------------------ execução

function mount(model) {
  const context = {
    ...layReview, ...evidenceCrop, ...tabPlan,
    EVIDENCE_HIGHLIGHT_UNMARKED_LEGEND, GUIDED_REVIEW_TREATMENT_V1, isSafeEvidenceImageUrl,
    auditModel: model,
    reportSessionState: 'result',
    reportSessionCapabilityId: 'x'.repeat(22),
    modelLookups: value => ({ evidence: value?.evidence ?? [] }),
    REVIEW_CARD_LIMIT: 40,
    TAB_READING_BLOCK: 20,
    list: new Element('div'),
    status: new Element('p'),
    evaluator: Object.assign(new Element('input'), { value: 'Fiscal Ana' }),
    tabBulkSummary: new Element('p'),
    // O botão de confirmar da caixa destrutiva: a marcação em bloco o cita como origem da retomada de
    // foco, e ele existe na página de verdade (`#lay-tab-bulk-confirm`).
    tabBulkConfirm: new Element('button'),
    tabBulkController: { open(trigger) { context.bulkOpened += 1; context.bulkTrigger = trigger; } },
    bulkOpened: 0,
    bulkTrigger: null,
    saved: [],
    speaker: { prepare: () => Promise.resolve(), setEnabled: () => Promise.resolve(true), voice: () => null, speak: () => Promise.resolve() },
    createSpeaker: () => context.speaker,
    evaluatorNameOrWarn: () => true,
    noteProblem: () => null,
    describeSaveFailure: error => String(error?.message ?? error),
    reportOccurrence: occurrenceId => ({ occurrenceId, itemId: '5.13.10', mode: 'assisted' }),
    reportModelRevision: 0,
    chrome: { runtime: { getURL: () => 'chrome-extension://extension/' } },
  };
  context.document = {
    createElement: tag => Object.assign(new Element(tag), { ownerDocument: context }),
    createElementNS: (_namespace, tag) => Object.assign(new Element(tag), { ownerDocument: context }),
    createTextNode: text => Object.assign(new Element('#text'), { ownerDocument: context, textContent: String(text) }),
    body: new Element('body'),
  };
  // O canal autorizado é o único ponto trocado: ele recebe as decisões já prontas e devolve `true` com o
  // modelo atualizado, como o serviço faz na extensão de verdade. A decisão entra no modelo pelo mesmo
  // `applyReviewDecisions` da revisão — sem isso a seção remontada depois da resposta não veria nada.
  context.saveDecisionBatch = async (entries, node, trigger) => {
    // Lista do próprio realm do teste: as listas que a página monta vivem em outro realm, e comparar
    // uma delas por identidade nunca dá igual.
    context.saved.push({ entries: Array.from(entries, entry => ({ ...entry })), node, trigger });
    // `Array.from` (e não `entries.map`): o serviço devolve uma lista do próprio realm dele, e a
    // revisão confere a lista por descritores antes de aplicar — uma lista de outro realm seria recusada.
    const decisions = Array.from(entries, entry => createReviewDecision({
      auditId: context.auditModel.auditId,
      itemId: entry.occurrence.itemId,
      occurrenceId: entry.occurrence.occurrenceId,
      answer: entry.answer,
      note: entry.note,
      evaluator: context.evaluator.value,
      decidedAt: '2026-08-27T12:00:00.000Z',
      mode: entry.occurrence.mode,
    }));
    context.auditModel = applyReviewDecisions(context.auditModel, decisions);
    return true;
  };
  const api = runInNewContext(`${renderSource}
({ layState, tabReadingRows, tabReadingSection, tabReadingWindow, refreshTabReading, saveTabReadingAnswer, openTabBulkConfirmation, runTabBulkMarking });`, context);
  return { ...api, context };
}

function sectionOf(api) {
  const rows = api.tabReadingRows();
  return rows.length ? api.tabReadingSection(rows) : null;
}

function texts(root) {
  return [root, ...descendants(root)].map(node => node.textContent).filter(Boolean).join(' ');
}

/**
 * Os botões chamam a gravação com `void`: o clique termina antes de a resposta ser salva. Esperar as
 * promessas pendentes é o que deixa o teste observar o efeito da resposta, como a pessoa o veria.
 */
async function settle() {
  for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();
  await new Promise(resolve => setTimeout(resolve, 0));
}
function classes(root) { return descendants(root).map(node => node.attributes.class).filter(Boolean).flatMap(value => value.split(/\s+/u)); }
function cellOf(row, column) { return descendants(row).find(node => node.getAttribute('data-tab-cell') === column); }
function rowNodes(section) { return matchesAll(section, 'tr[data-tab-reading-row]'); }
function rowOf(node) {
  for (let current = node; current; current = current.parent) {
    if (current.getAttribute?.('data-tab-reading-row')) return current.getAttribute('data-tab-reading-row');
  }
  return null;
}

async function modelWith(answers = [], options = {}) {
  return (await tabReadingModel({ answers, ...options })).model;
}

// ------------------------------------------------------------------ testes

test('a seção abre com título, uma frase de explicação e o progresso em números', async () => {
  const api = mount(await modelWith());
  const section = sectionOf(api);
  assert.equal(section.id, 'lay-tab-reading');
  assert.equal(section.getAttribute('aria-labelledby'), 'lay-tab-reading-title');
  assert.equal(texts(descendants(section).find(node => node.tagName === 'h3')), tabPlan.TAB_READING_SECTION_TITLE);
  assert.ok(texts(section).includes(tabPlan.TAB_READING_INTRO));
  const progress = descendants(section).find(node => node.getAttribute('data-tab-reading-progress'));
  assert.equal(progress.getAttribute('data-tab-reading-progress'), '0/3');
  assert.equal(progress.textContent, '0 de 3 conferidos');
  const meter = descendants(section).find(node => node.tagName === 'progress');
  assert.equal(meter.max, 3);
  assert.equal(meter.value, 0);
  assert.equal(meter.getAttribute('aria-label'), 'Pontos da sequência de Tab conferidos');
});

test('a tabela tem as cinco colunas, na linha do Tab e com o anúncio estimado', async () => {
  const api = mount(await modelWith());
  const section = sectionOf(api);
  const headers = matchesAll(section, 'th').map(node => node.textContent);
  assert.deepEqual(headers, ['Imagem do elemento', 'Ordem / elemento', 'Nome e função', 'Anúncio estimado', 'Pergunta']);
  const rows = rowNodes(section);
  assert.deepEqual(rows.map(row => row.getAttribute('data-tab-reading-row')), ['occ-tab-n-tab-1', 'occ-tab-n-tab-2', 'occ-tab-n-tab-3']);
  // Cada célula diz a que coluna pertence: em tela estreita a tabela se empilha e o cabeçalho sai de vista.
  assert.deepEqual(descendants(rows[0]).map(node => node.getAttribute('data-tab-cell')).filter(Boolean),
    ['Imagem do elemento', 'Ordem / elemento', 'Nome e função', 'Anúncio estimado', 'Pergunta']);
  assert.match(texts(cellOf(rows[0], 'Ordem / elemento')), /Tab 1 · botão #n-tab-1/u);
  assert.match(texts(cellOf(rows[0], 'Nome e função')), /“Buscar”/u);
  assert.match(texts(cellOf(rows[1], 'Nome e função')), /Sem nome acessível/u);
  assert.match(texts(cellOf(rows[2], 'Nome e função')), /“Pesquisar” Link/u);
  assert.equal(cellOf(rows[0], 'Anúncio estimado').children[0].textContent, 'Buscar, botão');
  assert.ok(texts(cellOf(rows[0], 'Pergunta')).includes(tabPlan.TAB_READING_QUESTION));
});

test('cada ponto mostra o recorte do elemento com o contorno e o botão de ouvir com nome próprio', async () => {
  const api = mount(await modelWith());
  const rows = rowNodes(sectionOf(api));
  for (const [index, expected] of ['Tab 1, botão “Buscar”', 'Tab 2, campo de texto sem nome', 'Tab 3, link “Pesquisar”'].entries()) {
    const image = cellOf(rows[index], 'Imagem do elemento');
    const svg = descendants(image).find(node => node.tagName === 'svg');
    assert.equal(svg.getAttribute('role'), 'img');
    // O texto alternativo diz de onde a imagem veio e o que o contorno marca — a mesma frase do cartão.
    assert.match(svg.getAttribute('aria-label'), /^Recorte da captura (?:da página inteira, na região do elemento|do elemento) desta pergunta\. Contorno vermelho: o elemento desta pergunta\./u);
    assert.ok(descendants(svg).some(node => node.attributes.class === 'evidence-highlight evidence-highlight--target'),
      'o contorno vermelho de localização é desenhado sobre a imagem');
    const listen = descendants(cellOf(rows[index], 'Anúncio estimado')).find(node => node.getAttribute('class') === 'lay-tab-listen');
    assert.equal(listen.textContent, tabPlan.TAB_READING_LISTEN_LABEL);
    assert.equal(listen.getAttribute('aria-label'), `${tabPlan.TAB_READING_LISTEN_LABEL} o anúncio estimado de ${expected}`);
  }
});

test('o botão de cada resposta nomeia o elemento, e responder não é o mesmo que escolher', async () => {
  const api = mount(await modelWith());
  const row = rowNodes(sectionOf(api))[0];
  const answers = descendants(cellOf(row, 'Pergunta')).find(node => node.getAttribute('role') === 'group');
  assert.equal(answers.getAttribute('aria-label'), `${tabPlan.TAB_READING_QUESTION} Tab 1, botão “Buscar”.`);
  const choices = answers.children;
  assert.deepEqual(choices.map(node => node.getAttribute('data-tab-reading-answer')), ['conforme', 'não conforme', 'não foi possível determinar']);
  assert.deepEqual(choices.map(node => node.textContent), ['Sim', 'Não', 'Não sei']);
  assert.deepEqual(choices.map(node => node.getAttribute('aria-label')),
    ['Sim — Tab 1, botão “Buscar”', 'Não — Tab 1, botão “Buscar”', 'Não sei — Tab 1, botão “Buscar”']);
  assert.equal(api.context.saved.length, 0, 'nada é gravado antes do clique');
});

test('“Sim” grava na hora, uma decisão do ponto, e o foco vai para o próximo pendente', async () => {
  const api = mount(await modelWith());
  api.layState.tabSection = sectionOf(api);
  const first = rowNodes(api.layState.tabSection)[0];
  const choices = descendants(cellOf(first, 'Pergunta')).find(node => node.getAttribute('role') === 'group').children;
  await choices[0].click();
  await settle();
  assert.equal(api.context.saved.length, 1);
  const [saved] = api.context.saved;
  assert.equal(saved.entries.length, 1, 'uma decisão por ponto da sequência');
  assert.deepEqual(saved.entries[0], {
    occurrence: { occurrenceId: 'occ-tab-n-tab-1', itemId: '5.13.10', mode: 'assisted' },
    answer: 'conforme', note: '', revise: false,
  });
  assert.equal(saved.node, first, 'a linha é quem recebe o estado de gravação');
  assert.equal(api.context.status.textContent, 'Resposta salva. Próximo ponto da sequência: Tab 2, campo de texto sem nome.');
  // A seção é remontada depois da resposta, e o foco vai para o primeiro botão da próxima linha pendente.
  const focused = descendants(api.layState.tabSection).find(node => node.focused);
  assert.equal(focused.getAttribute('data-tab-reading-answer'), 'conforme');
  assert.equal(rowOf(focused), 'occ-tab-n-tab-2');
});

test('“Não” abre o campo opcional do que deveria dizer e só grava no botão de registrar', async () => {
  const api = mount(await modelWith());
  api.layState.tabSection = sectionOf(api);
  const row = rowNodes(api.layState.tabSection)[1];
  const cell = cellOf(row, 'Pergunta');
  const choices = descendants(cell).find(node => node.getAttribute('role') === 'group').children;
  choices[1].click();
  assert.equal(api.context.saved.length, 0, 'abrir o campo não grava nada');
  const field = descendants(cell).find(node => node.tagName === 'textarea');
  assert.equal(field.getAttribute('aria-label'), 'O que deveria dizer no lugar do anúncio atual — Tab 2, campo de texto sem nome');
  field.value = 'Campo de busca, caixa de texto';
  field.dispatch('input');
  const register = descendants(cell).find(node => node.textContent === 'Registrar “Não”');
  await register.click();
  await settle();
  assert.equal(api.context.saved.length, 1);
  const [entry] = api.context.saved[0].entries;
  assert.equal(entry.occurrence.occurrenceId, 'occ-tab-n-tab-2');
  assert.equal(entry.occurrence.itemId, '5.13.10');
  assert.equal(entry.answer, 'não conforme');
  assert.equal(entry.note, 'Campo de busca, caixa de texto');
  assert.equal(entry.revise, false);
  // A seção é remontada com a resposta registrada, e o campo de texto sai de cena.
  const after = rowNodes(api.layState.tabSection)[1];
  assert.match(texts(cellOf(after, 'Pergunta')), /Resposta registrada: Não conforme/u);
});

test('a linha respondida mostra a resposta, o estado de cor e o que deveria dizer', async () => {
  const api = mount(await modelWith([
    { nodeId: 'n-tab-2', answer: 'não conforme', note: 'Campo de busca, caixa de texto' },
    { nodeId: 'n-tab-3', answer: 'não foi possível determinar' },
  ]));
  const section = sectionOf(api);
  const [first, second, third] = rowNodes(section);
  assert.equal(first.getAttribute('data-tab-reading-state'), null, 'ponto ainda pendente não tem estado');
  assert.equal(second.getAttribute('data-tab-reading-state'), 'nao');
  assert.equal(third.getAttribute('data-tab-reading-state'), 'nao-sei');
  assert.match(texts(cellOf(second, 'Pergunta')), /Resposta registrada: Não conforme \(não atende ao item\) — Fiscal Ana,/u);
  assert.match(texts(cellOf(second, 'Pergunta')), /O que deveria dizer: Campo de busca, caixa de texto/u);
  assert.ok(descendants(cellOf(second, 'Pergunta')).some(node => node.textContent === 'Rever resposta'));
  // O progresso acompanha: dois de três conferidos.
  assert.equal(descendants(section).find(node => node.getAttribute('data-tab-reading-progress')).getAttribute('data-tab-reading-progress'), '2/3');
  // E a pista automática do nome aparece no ponto cujo motor acusou falta de nome.
  const comPista = mount(await modelWith([], { nameFailures: ['n-tab-2'] }));
  assert.match(texts(cellOf(rowNodes(sectionOf(comPista))[1], 'Pergunta')), /O elemento não tem nome que o leitor de tela possa anunciar\./u);
  assert.doesNotMatch(texts(cellOf(rowNodes(sectionOf(comPista))[0], 'Pergunta')), /Pista/u);
});

test('a janela mostra 20 linhas por vez e o filtro deixa só as pendentes', async () => {
  const stops = Array.from({ length: 25 }, (_, index) => ({
    nodeId: `n-tab-${index + 1}`, tag: 'button', role: 'button', name: `Botão ${index + 1}`, nameSource: 'contents',
    visibleText: `Botão ${index + 1}`, announcement: `Botão ${index + 1}, botão`,
    bounds: { x: 10, y: 8 + index * 3, width: 60, height: 2 },
  }));
  const answers = stops.slice(0, 23).map(stop => ({ nodeId: stop.nodeId, answer: 'conforme' }));
  const api = mount(await modelWith(answers, { stops }));
  const section = sectionOf(api);
  assert.equal(rowNodes(section).length, 20, 'o primeiro bloco mostra 20 linhas');
  const more = descendants(section).find(node => node.getAttribute('data-tab-reading-more'));
  assert.equal(more.getAttribute('data-tab-reading-more'), '5');
  assert.match(more.textContent, /Mostrar mais 5 de 5 pontos/u);
  more.click();
  // O clique remonta a seção: a janela nova é lida do estado, não do nó antigo.
  const grown = sectionOf(api);
  api.layState.tabSection = grown;
  api.layState.tab.visible = 40;
  const wide = sectionOf(api);
  assert.equal(rowNodes(wide).length, 25);
  assert.equal(descendants(wide).some(node => node.getAttribute('data-tab-reading-more')), false);

  api.layState.tab.onlyPending = true;
  const onlyPending = sectionOf(api);
  assert.equal(rowNodes(onlyPending).length, 2);
  assert.deepEqual(rowNodes(onlyPending).map(row => row.getAttribute('data-tab-reading-row')), ['occ-tab-n-tab-24', 'occ-tab-n-tab-25']);
  api.layState.tab.onlyPending = false;
});

test('a marcação em bloco espera a confirmação e grava “Sim” com a nota do lote', async () => {
  const api = mount(await modelWith());
  const section = sectionOf(api);
  api.layState.tabSection = section;
  const bulk = descendants(section).find(node => node.attributes.class === 'lay-tab-bulk');
  assert.equal(bulk.disabled, false, 'há pendentes nas linhas mostradas');
  bulk.click();
  assert.equal(api.context.bulkOpened, 1);
  assert.equal(api.context.bulkTrigger, bulk);
  assert.equal(api.context.tabBulkSummary.textContent,
    'Isto grava “Sim” (o anúncio corresponde ao elemento) em 3 pontos, de Tab 1 a Tab 3. Cada ponto vira uma resposta registrada em seu nome no item 5.13.10 e pode ser revisto depois, um por um.');
  assert.equal(api.context.saved.length, 0, 'a caixa de confirmação não grava sozinha');
  await api.context.tabBulkRun();
  assert.equal(api.context.saved.length, 1, 'uma gravação em lote para o bloco');
  // Listas de outro realm não se comparam por identidade: a leitura é feita campo a campo.
  assert.deepEqual(api.context.saved[0].entries.map(entry =>
    `${entry.occurrence.occurrenceId} · ${entry.answer} · ${entry.note}`), [
    'occ-tab-n-tab-1 · conforme · Conferido em bloco: o anúncio estimado corresponde ao elemento.',
    'occ-tab-n-tab-2 · conforme · Conferido em bloco: o anúncio estimado corresponde ao elemento.',
    'occ-tab-n-tab-3 · conforme · Conferido em bloco: o anúncio estimado corresponde ao elemento.',
  ]);
  // E as três linhas ficam respondidas na seção remontada.
  assert.deepEqual(api.tabReadingRows().map(row => row.answered), [true, true, true]);
});

test('sem ponto de Tab a seção não é montada, e a auditoria antiga segue sem ela', async () => {
  const api = mount(await modelWith([], { tabRule: false, stops: [], map: false }));
  assert.deepEqual(api.tabReadingRows(), []);
  assert.equal(sectionOf(api), null);
  const comPontos = mount(await modelWith());
  assert.equal(sectionOf(comPontos).id, 'lay-tab-reading');
  assert.equal(DEFAULT_STOPS.length, 3);
  assert.equal(TEST_PNG.startsWith('data:image/png;base64,'), true);
  assert.ok(classes(sectionOf(comPontos)).includes('lay-tab-row'));
});
