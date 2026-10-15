import assert from 'node:assert/strict';
import test from 'node:test';

import {
  KEYBOARD_MAP_STOP_LIMIT,
  KEYBOARD_MAP_SUSPECT_LIMIT,
  selectKeyboardMapStops,
} from '../../src/core/keyboard/keyboard-map-model.js';

/** Instantâneo mínimo, com os filhos ligados pelos pais como o normalizador faz. */
function snapshot(nodes) {
  const normalized = nodes.map((node, index) => ({
    nodeId: node.nodeId ?? `n-${index + 1}`,
    parentId: node.parentId ?? null,
    children: node.children ?? [],
    tagName: node.tagName ?? 'button',
    attributes: node.attributes ?? {},
    framePath: node.framePath ?? [],
    hidden: false,
    hasRenderedBox: true,
    ...node,
  }));
  const byId = new Map(normalized.map(node => [node.nodeId, node]));
  for (const node of normalized) {
    if (node.parentId && byId.has(node.parentId) && !byId.get(node.parentId).children.includes(node.nodeId)) {
      byId.get(node.parentId).children.push(node.nodeId);
    }
  }
  return {
    schemaVersion: 1,
    document: { nodeId: 'document', title: 'Fixture', url: 'https://example.test/' },
    nodes: normalized,
  };
}

function rect(y, height = 30) {
  return { x: 10, y, width: 120, height };
}

test('ordena as paradas por tabindex positivo e depois pela ordem do documento', () => {
  const result = selectKeyboardMapStops(snapshot([
    { nodeId: 'first', tagName: 'a', attributes: { href: '/um' }, accessibleName: 'Primeiro', axRole: 'link', rect: rect(10) },
    { nodeId: 'later', tagName: 'button', attributes: { tabindex: '2' }, accessibleName: 'Depois', axRole: 'button', rect: rect(50) },
    { nodeId: 'sooner', tagName: 'button', attributes: { tabindex: '1' }, accessibleName: 'Antes', axRole: 'button', rect: rect(90) },
    { nodeId: 'field', tagName: 'input', attributes: { type: 'text' }, accessibleName: 'Campo', axRole: 'textbox', rect: rect(130) },
  ]));

  assert.deepEqual(result.stops.map(stop => [stop.number, stop.nodeId, stop.kind, stop.tabIndex]), [
    [1, 'sooner', 'button', 1],
    [2, 'later', 'button', 2],
    [3, 'first', 'link', 0],
    [4, 'field', 'field', 0],
  ]);
  assert.deepEqual(result.stops.map(stop => stop.name), ['Antes', 'Depois', 'Primeiro', 'Campo']);
  assert.ok(result.stops.every(stop => stop.nameStatus === 'projected'));
  assert.equal(result.counts.stops, 4);
});

test('exclui controle desabilitado, nó escondido, inerte, aria-hidden e input oculto', () => {
  const result = selectKeyboardMapStops(snapshot([
    { nodeId: 'live', tagName: 'button', accessibleName: 'Vivo', axRole: 'button', rect: rect(10) },
    { nodeId: 'disabled', tagName: 'button', attributes: { disabled: '' }, disabled: true, accessibleName: 'Travado', axRole: 'button', rect: rect(50) },
    { nodeId: 'hidden-attr', tagName: 'button', attributes: { hidden: '' }, accessibleName: 'Escondido', axRole: 'button', rect: rect(90) },
    { nodeId: 'no-box', tagName: 'button', hasRenderedBox: false, accessibleName: 'Sem caixa', axRole: 'button', rect: rect(130) },
    { nodeId: 'areahidden', tagName: 'section', attributes: { 'aria-hidden': 'true' }, children: ['inside'], rect: rect(170, 60) },
    { nodeId: 'inside', parentId: 'areahidden', tagName: 'button', accessibleName: 'Dentro do oculto', axRole: 'button', rect: rect(180) },
    { nodeId: 'inert', tagName: 'section', attributes: { inert: '' }, children: ['inert-child'], rect: rect(240, 60) },
    { nodeId: 'inert-child', parentId: 'inert', tagName: 'button', accessibleName: 'Inerte', axRole: 'button', rect: rect(250) },
    { nodeId: 'hidden-input', tagName: 'input', attributes: { type: 'hidden' }, accessibleName: '', axRole: '', rect: rect(300) },
  ]));

  assert.deepEqual(result.stops.map(stop => stop.nodeId), ['live']);
  // Nem parada nem suspeito: o controle desabilitado está fora da ordem de Tab por decisão do autor.
  assert.deepEqual(result.suspects, []);
  assert.equal(result.counts.omittedNotVisible, 7);
});

test('trata details recolhido, summary e área editável', () => {
  const result = selectKeyboardMapStops(snapshot([
    { nodeId: 'closed', tagName: 'details', children: ['closed-summary', 'closed-body'], rect: rect(10, 60) },
    { nodeId: 'closed-summary', parentId: 'closed', tagName: 'summary', accessibleName: 'Abrir', axRole: 'button', rect: rect(10) },
    { nodeId: 'closed-body', parentId: 'closed', tagName: 'a', attributes: { href: '/x' }, accessibleName: 'Escondido no recolhido', axRole: 'link', rect: rect(40) },
    { nodeId: 'open', tagName: 'details', attributes: { open: '' }, open: true, children: ['open-summary', 'open-body'], rect: rect(100, 80) },
    { nodeId: 'open-summary', parentId: 'open', tagName: 'summary', accessibleName: 'Fechar', axRole: 'button', rect: rect(100) },
    { nodeId: 'open-body', parentId: 'open', tagName: 'a', attributes: { href: '/y' }, accessibleName: 'Visível no aberto', axRole: 'link', rect: rect(130) },
    { nodeId: 'editor', tagName: 'div', attributes: { contenteditable: 'true' }, accessibleName: 'Escreva aqui', axRole: 'textbox', rect: rect(200), children: ['editor-child'] },
    { nodeId: 'editor-child', parentId: 'editor', tagName: 'span', rect: rect(210) },
  ]));

  assert.deepEqual(result.stops.map(stop => [stop.nodeId, stop.kind]), [
    ['closed-summary', 'summary'],
    ['open-summary', 'summary'],
    ['open-body', 'link'],
    ['editor', 'contenteditable'],
  ]);
  assert.equal(result.stops.some(stop => stop.nodeId === 'closed-body'), false);
  assert.equal(result.stops.some(stop => stop.nodeId === 'editor-child'), false);
});

test('aponta suspeitos por cursor pointer, papel interativo sem foco e ocorrência de regra', () => {
  const result = selectKeyboardMapStops(snapshot([
    { nodeId: 'stop', tagName: 'button', accessibleName: 'Parada real', axRole: 'button', rect: rect(10) },
    { nodeId: 'card', tagName: 'div', styles: { cursor: 'pointer' }, accessibleName: 'Consumidor', axRole: 'generic', rect: rect(50) },
    { nodeId: 'roled', tagName: 'div', attributes: { role: 'button' }, accessibleName: 'Abrir menu', axRole: 'button', rect: rect(90) },
    { nodeId: 'rule-only', tagName: 'div', attributes: { role: 'none' }, accessibleName: 'Cartão só com hover', axRole: 'generic', rect: rect(130) },
    { nodeId: 'native', tagName: 'a', attributes: { href: '/ok' }, styles: { cursor: 'pointer' }, accessibleName: 'Link normal', axRole: 'link', rect: rect(170) },
    { nodeId: 'unknown-rule', tagName: 'div', attributes: { role: 'none' }, accessibleName: 'Sem motivo', axRole: 'generic', rect: rect(210) },
  ]), {
    occurrences: [
      { occurrenceId: 'o1', ruleId: 'hover-only-interactive-content', outcome: 'fail', nodeId: 'rule-only' },
      { occurrenceId: 'o2', ruleId: 'regra-que-nao-existe', outcome: 'fail', nodeId: 'unknown-rule' },
    ],
  });

  assert.deepEqual(result.suspects.map(entry => [entry.number, entry.nodeId, entry.reason, entry.ruleId]), [
    [1, 'card', 'cursor-pointer', null],
    [2, 'roled', 'interactive-role', null],
    [3, 'rule-only', 'keyboard-rule', 'hover-only-interactive-content'],
  ]);
  assert.deepEqual(result.suspects.map(entry => entry.name), ['Consumidor', 'Abrir menu', 'Cartão só com hover']);
  assert.equal(result.suspects.some(entry => entry.nodeId === 'native'), false);
  assert.equal(result.suspects.some(entry => entry.nodeId === 'unknown-rule'), false);
});

test('não acusa roving tabindex, filho de parada nem papel de componente composto', () => {
  const result = selectKeyboardMapStops(snapshot([
    { nodeId: 'toolbar', tagName: 'div', attributes: { role: 'toolbar', tabindex: '0' }, accessibleName: 'Barra', axRole: 'toolbar', rect: rect(10, 40), children: ['item'] },
    { nodeId: 'item', parentId: 'toolbar', tagName: 'div', attributes: { role: 'button', tabindex: '-1' }, styles: { cursor: 'pointer' }, accessibleName: 'Item da barra', axRole: 'button', rect: rect(20) },
    { nodeId: 'listbox', tagName: 'div', attributes: { role: 'listbox', tabindex: '0' }, accessibleName: 'Lista', axRole: 'listbox', rect: rect(100, 60), children: ['option'] },
    { nodeId: 'option', parentId: 'listbox', tagName: 'div', attributes: { role: 'option' }, styles: { cursor: 'pointer' }, accessibleName: 'Opção', axRole: 'option', rect: rect(120) },
    { nodeId: 'wrapper', tagName: 'div', styles: { cursor: 'pointer' }, rect: rect(200, 60), children: ['wrapped-link'] },
    { nodeId: 'wrapped-link', parentId: 'wrapper', tagName: 'a', attributes: { href: '/z' }, accessibleName: 'Dentro do cartão', axRole: 'link', rect: rect(210) },
    { nodeId: 'anonymous', tagName: 'div', styles: { cursor: 'pointer' }, rect: rect(300) },
  ]), { occurrences: [] });

  assert.equal(result.suspects.some(entry => entry.nodeId === 'item'), false);
  assert.equal(result.suspects.some(entry => entry.nodeId === 'option'), false);
  assert.equal(result.suspects.some(entry => entry.nodeId === 'wrapper'), false);
  assert.equal(result.suspects.some(entry => entry.nodeId === 'anonymous'), false);
  assert.deepEqual(result.stops.map(stop => stop.nodeId), ['toolbar', 'listbox', 'wrapped-link']);
});

test('acusa cartão com texto visível e sem nome acessível, poupando quem não tem rótulo nenhum', () => {
  const result = selectKeyboardMapStops(snapshot([
    { nodeId: 'card', tagName: 'div', styles: { cursor: 'pointer' }, visibleText: 'Consumidor', axRole: 'generic', rect: rect(10) },
    { nodeId: 'spacer', tagName: 'div', styles: { cursor: 'pointer' }, visibleText: '   ', axRole: 'generic', rect: rect(50) },
    { nodeId: 'decorative', tagName: 'div', styles: { cursor: 'pointer' }, axRole: 'generic', rect: rect(90) },
  ]), { occurrences: [] });

  // O cartão não tem nome acessível: o texto visível entra como âncora para a pessoa reconhecer o
  // item que o Tab não alcança, e a origem declarada deixa claro que não veio de nome acessível.
  assert.deepEqual(result.suspects.map(entry => [entry.nodeId, entry.reason, entry.name, entry.nameSource]), [
    ['card', 'cursor-pointer', 'Consumidor', 'visible-text'],
  ]);
  assert.deepEqual(result.counts, {
    eligible: 0, stops: 0, suspects: 1,
    omittedNotVisible: 0, omittedNoRect: 0, omittedClipped: 0, omittedFrame: 0, omittedLimit: 0,
  });
});

test('não projeta texto visível de item contaminado por campo privado, mas ainda aponta a caixa', () => {
  const secret = 'TOPSECRET-visivel-9931';
  const result = selectKeyboardMapStops(snapshot([
    {
      nodeId: 'card', tagName: 'div', styles: { cursor: 'pointer' }, visibleText: secret,
      children: ['segredo'], axRole: 'generic', rect: rect(10, 60),
    },
    { nodeId: 'segredo', parentId: 'card', tagName: 'span', attributes: { 'data-private': '' }, visibleText: secret, rect: rect(20) },
  ]));

  // O item continua na lista — a pessoa precisa saber que aquele lugar não recebe o Tab — mas o
  // nome sai omitido: o texto do cartão contém o valor privado e nada dele pode ser projetado.
  assert.deepEqual(result.suspects.map(entry => [entry.nodeId, entry.reason, entry.name, entry.nameSource, entry.nameStatus]), [
    ['card', 'cursor-pointer', '', 'omitted-privacy', 'omitted-privacy'],
  ]);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('tabindex negativo sem ocorrência de regra não vira suspeito, mas com regra continua', () => {
  const nodes = [
    { nodeId: 'fora-da-ordem', tagName: 'button', attributes: { tabindex: '-1' }, accessibleName: 'Botão fora da ordem do Tab', axRole: 'button', rect: rect(10) },
    { nodeId: 'acao-invisivel', tagName: 'div', attributes: { tabindex: '-1', role: 'button' }, accessibleName: 'Ação só no hover', axRole: 'button', rect: rect(50) },
  ];
  // Sem ocorrência de regra, o tabindex negativo é decisão declarada do autor: não é parada do Tab
  // (já testado acima) e também não vira acusação de item sem caixa.
  const plain = selectKeyboardMapStops(snapshot(nodes));
  assert.equal(plain.stops.some(stop => stop.nodeId === 'fora-da-ordem'), false);
  assert.deepEqual(plain.suspects, []);

  // Com ocorrência da regra de conteúdo que só aparece com o mouse, a acusação tem lastro e entra.
  const withRule = selectKeyboardMapStops(snapshot(nodes), {
    occurrences: [{ ruleId: 'hover-only-interactive-content', nodeId: 'acao-invisivel' }],
  });
  assert.deepEqual(withRule.suspects.map(entry => [entry.nodeId, entry.reason]), [
    ['acao-invisivel', 'keyboard-rule'],
  ]);
});

test('declara que o cursor não foi coletado quando o instantâneo não traz o estilo', () => {
  const result = selectKeyboardMapStops(snapshot([
    { nodeId: 'plain', tagName: 'div', accessibleName: 'Cartão', axRole: 'generic', rect: rect(10) },
  ]));

  assert.ok(result.limitations.includes('cursor-style-not-collected'));
  assert.deepEqual(result.limitations.slice(0, 2), ['tab-order-estimated-not-observed', 'top-document-open-shadow-only']);
  assert.equal(result.suspects.length, 0);
});

test('omite o nome de quem pode carregar texto digitado e mantém o rótulo do campo', () => {
  const secret = 'TOPSECRET-digitado';
  const result = selectKeyboardMapStops(snapshot([
    { nodeId: 'editor', tagName: 'div', attributes: { contenteditable: 'true' }, accessibleName: secret, axRole: 'textbox', rect: rect(10) },
    { nodeId: 'private-box', tagName: 'div', attributes: { 'data-private': '' }, children: ['inside-private'], rect: rect(50, 60) },
    { nodeId: 'inside-private', parentId: 'private-box', tagName: 'input', attributes: { type: 'text' }, accessibleName: secret, axRole: 'textbox', rect: rect(60) },
    { nodeId: 'email', tagName: 'input', attributes: { type: 'email' }, accessibleName: 'E-mail para contato', axRole: 'textbox', rect: rect(120) },
    { nodeId: 'secret-ref', tagName: 'span', attributes: { id: 'segredo', 'data-private': '' }, accessibleName: secret, rect: rect(200) },
    { nodeId: 'referred', tagName: 'input', attributes: { type: 'text', 'aria-labelledby': 'segredo' }, accessibleName: secret, axRole: 'textbox', rect: rect(240) },
    { nodeId: 'secret-for', tagName: 'label', attributes: { for: 'campo-x', 'data-private': '' }, accessibleName: secret, rect: rect(280) },
    { nodeId: 'campo-x', tagName: 'input', attributes: { type: 'text', id: 'campo-x' }, accessibleName: secret, axRole: 'textbox', rect: rect(320) },
  ]));
  const byId = new Map(result.stops.map(stop => [stop.nodeId, stop]));

  // Área editável: o nome poderia vir do próprio texto digitado, então a parada existe sem nome.
  assert.equal(byId.get('editor').name, '');
  assert.equal(byId.get('editor').nameStatus, 'omitted-privacy');
  // Campo com rótulo do autor continua nomeado: é o que deixa a pessoa reconhecê-lo na lista.
  assert.deepEqual([byId.get('email').name, byId.get('email').nameStatus], ['E-mail para contato', 'projected']);
  // Contaminação por ancestral privado, por referência e por rótulo `for` também retira o nome.
  for (const nodeId of ['inside-private', 'referred', 'campo-x']) {
    assert.equal(byId.get(nodeId).nameStatus, 'omitted-privacy', nodeId);
  }
  assert.ok(result.limitations.includes('privacy-content-omitted'));
  assert.doesNotMatch(JSON.stringify(result), /TOPSECRET/u);
});

test('corta nas 400 paradas e nos 60 suspeitos declarando o teto', () => {
  const many = [];
  for (let index = 0; index < KEYBOARD_MAP_STOP_LIMIT + 5; index += 1) {
    many.push({ nodeId: `s-${index}`, tagName: 'button', accessibleName: `Botão ${index}`, axRole: 'button', rect: rect(index * 40) });
  }
  for (let index = 0; index < KEYBOARD_MAP_SUSPECT_LIMIT + 3; index += 1) {
    many.push({ nodeId: `x-${index}`, tagName: 'div', styles: { cursor: 'pointer' }, accessibleName: `Cartão ${index}`, axRole: 'generic', rect: rect(100000 + index * 40) });
  }
  const result = selectKeyboardMapStops(snapshot(many));

  assert.equal(result.stops.length, KEYBOARD_MAP_STOP_LIMIT);
  assert.equal(result.suspects.length, KEYBOARD_MAP_SUSPECT_LIMIT);
  assert.equal(result.counts.omittedLimit, 8);
  assert.ok(result.limitations.includes('stop-limit-reached'));
  assert.ok(result.limitations.includes('suspect-limit-reached'));
  assert.equal(result.counts.eligible, result.counts.stops + result.counts.omittedNoRect + result.counts.omittedClipped + result.counts.omittedLimit);
});

test('omite conteúdo de quadro e de sombra fechada declarando cada limitação', () => {
  const result = selectKeyboardMapStops(snapshot([
    { nodeId: 'host', tagName: 'iframe', accessibleName: 'Quadro', axRole: 'iframe', rect: rect(10) },
    { nodeId: 'in-frame', tagName: 'button', accessibleName: 'Dentro do quadro', axRole: 'button', framePath: ['host'], rect: rect(50) },
    { nodeId: 'shadow-root', tagName: '#document-fragment', shadowRootType: 'closed', children: ['closed-child'], rect: rect(90, 40) },
    { nodeId: 'closed-child', parentId: 'shadow-root', tagName: 'button', accessibleName: 'Fechado', axRole: 'button', rect: rect(100) },
  ]));

  assert.deepEqual(result.stops.map(stop => stop.nodeId), ['host']);
  assert.ok(result.limitations.includes('frame-content-omitted'));
  assert.ok(result.limitations.includes('closed-shadow-root-omitted'));
  assert.equal(result.counts.omittedFrame, 1);
});

test('sem ocorrências não quebra e a lista segue estável entre execuções', () => {
  const input = snapshot([
    { nodeId: 'a', tagName: 'button', accessibleName: 'A', axRole: 'button', rect: rect(10) },
    { nodeId: 'b', tagName: 'div', styles: { cursor: 'pointer' }, accessibleName: 'B', axRole: 'generic', rect: rect(50) },
  ]);
  const first = selectKeyboardMapStops(input);
  const second = selectKeyboardMapStops(input, {});
  assert.deepEqual(first, second);
});

test('imagem ou ícone dentro de link ou botão não é item sem caixa', () => {
  // Medido na página real de uma loja on-line: seis fotos de produto apareciam como "parece clicável
  // e o Tab não alcança" só porque a própria foto declara a seta de clique. Quem clica na foto segue o
  // link dono dela, e o Tab chega nesse link — o item não está sem caixa.
  const result = selectKeyboardMapStops(snapshot([
    { nodeId: 'card-link', tagName: 'a', attributes: { href: '/produto' }, rect: rect(10, 120), children: ['photo', 'badge'] },
    { nodeId: 'photo', parentId: 'card-link', tagName: 'img', attributes: { alt: 'Foto do produto' }, styles: { cursor: 'pointer' }, accessibleName: 'Foto do produto', axRole: 'image', rect: rect(10, 100) },
    { nodeId: 'badge', parentId: 'card-link', tagName: 'span', styles: { cursor: 'pointer' }, accessibleName: 'Novo', axRole: 'generic', rect: rect(20, 20) },
    { nodeId: 'icon-button', tagName: 'button', accessibleName: 'Buscar', axRole: 'button', rect: rect(200), children: ['icon'] },
    { nodeId: 'icon', parentId: 'icon-button', tagName: 'svg', styles: { cursor: 'pointer' }, accessibleName: 'Lupa', axRole: 'image', rect: rect(200) },
    { nodeId: 'solto', tagName: 'img', attributes: { alt: 'Banner que só abre com o mouse' }, styles: { cursor: 'pointer' }, accessibleName: 'Banner que só abre com o mouse', axRole: 'image', rect: rect(400) },
  ]), { occurrences: [] });

  assert.deepEqual(result.suspects.map(entry => entry.nodeId), ['solto']);
  assert.deepEqual(result.stops.map(stop => stop.nodeId), ['card-link', 'icon-button']);
});

test('fotos dentro de links não enchem o teto e os itens de verdade continuam na lista', () => {
  // Página de catálogo como as de loja on-line: dezenas de fotos de produto, cada uma com a seta de
  // clique dentro do próprio link. Antes da dispensa, cada foto consumia uma vaga do teto de 60 e os
  // quatro itens de verdade ficavam escondidos atrás do ruído (ou fora da lista, pelo limite).
  const nodes = [];
  for (let index = 0; index < 99; index += 1) {
    nodes.push({ nodeId: `link-${index}`, tagName: 'a', attributes: { href: `/produto-${index}` }, rect: rect(index * 4, 40) });
    nodes.push({
      nodeId: `foto-${index}`, parentId: `link-${index}`, tagName: 'img', attributes: { alt: `Foto do produto ${index}` },
      styles: { cursor: 'pointer' }, accessibleName: `Foto do produto ${index}`, axRole: 'image', rect: rect(index * 4, 40),
    });
  }
  const occurrences = [];
  for (let index = 0; index < 4; index += 1) {
    nodes.push({
      nodeId: `cartao-${index}`, tagName: 'div', styles: { cursor: 'pointer' },
      accessibleName: `Serviço ${index}`, axRole: 'generic', rect: rect(100000 + index * 40),
    });
    occurrences.push({ ruleId: 'hover-only-interactive-content', nodeId: `cartao-${index}`, outcome: 'failed' });
  }
  const result = selectKeyboardMapStops(snapshot(nodes), { occurrences });

  assert.deepEqual(result.suspects.map(entry => entry.nodeId), ['cartao-0', 'cartao-1', 'cartao-2', 'cartao-3']);
  assert.equal(result.limitations.includes('suspect-limit-reached'), false);
  assert.equal(result.counts.omittedLimit, 0);
  assert.equal(result.stops.length, 99, 'cada link do catálogo continua sendo uma parada do Tab');
});

test('item com ocorrência de regra continua apontado mesmo dentro de uma parada do Tab', () => {
  // A dispensa acima vale só para o desenho com seta de clique: um item que a verificação de teclado
  // confirmou como inalcançável continua sendo um achado, mesmo aninhado em outra parada.
  const result = selectKeyboardMapStops(snapshot([
    { nodeId: 'wrapper-link', tagName: 'a', attributes: { href: '/servico' }, rect: rect(10, 120), children: ['only-hover'] },
    { nodeId: 'only-hover', parentId: 'wrapper-link', tagName: 'span', styles: { cursor: 'pointer' }, accessibleName: 'Abrir opções', axRole: 'generic', rect: rect(20, 30) },
  ]), { occurrences: [{ ruleId: 'hover-only-interactive-content', nodeId: 'only-hover', outcome: 'failed' }] });

  assert.deepEqual(result.suspects.map(entry => [entry.nodeId, entry.reason]), [
    ['only-hover', 'keyboard-rule'],
  ]);
});

test('o texto de dentro de um cartão apontado não vira outro item (cursor herdado)', () => {
  // Medido nas capturas da loja: com `cursor: pointer` no cartão, o título e o subtítulo herdavam o
  // cursor e cada cartão aparecia três vezes na lista do que o Tab não alcança.
  const result = selectKeyboardMapStops(snapshot([
    { nodeId: 'card', tagName: 'div', styles: { cursor: 'pointer' }, visibleText: 'Saúde Consultas e vacinas', axRole: 'generic', rect: rect(10, 120) },
    { nodeId: 'title', parentId: 'card', tagName: 'span', styles: { cursor: 'pointer' }, visibleText: 'Saúde', axRole: 'generic', rect: rect(60, 20) },
    { nodeId: 'subtitle', parentId: 'card', tagName: 'span', styles: { cursor: 'pointer' }, visibleText: 'Consultas e vacinas', axRole: 'generic', rect: rect(85, 20) },
  ]), { occurrences: [] });
  assert.deepEqual(result.suspects.map(entry => entry.nodeId), ['card']);
});
