import assert from 'node:assert/strict';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { evaluate, launchUnpackedExtension, resolveRealChromeTestBinary, startFixtureServer, waitForValue } from './support/real-chrome.mjs';

// A página de serviços esconde os links de cada cartão atrás de `:hover`. O cartão não é focável e
// não existe regra de `:focus-within`, então TAB nunca alcança os links: é a falha de acessibilidade
// por teclado parcial (ABNT 5.1.13 / WCAG 2.1.1) que o produto só sabia devolver como dúvida para
// revisão humana. Este teste percorre o caminho real — ação, painel lateral, auditoria da página
// atual, sondagem por `CSS.forcePseudoState`, relatório e sinais na página — e reprova se o cartão
// só-mouse deixar de ser uma falha confirmada, se o cartão com `:focus-within` virar falha, ou se o
// hover forçado ficar aplicado depois da auditoria.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// O cartão só-mouse é escondido por `visibility` animada e os outros por `display`: o estado guarda os
// dois valores, para a comparação antes/depois provar que nada ficou aberto em nenhum dos dois modos.
const hiddenLists = `(() => Object.fromEntries(['so-mouse', 'com-foco', 'com-botao'].map(id => {
  const style = getComputedStyle(document.querySelector('#' + id + ' ul'));
  return [id, style.display + '/' + style.visibility];
})))()`;

const pageState = `(() => ({
  scroll: [scrollX, scrollY],
  focus: document.activeElement?.tagName ?? null,
  hidden: ${hiddenLists},
  markerRoots: document.querySelectorAll('[data-audita-page-markers-root="v1"]').length,
  card: (() => { const box = document.querySelector('#so-mouse').getBoundingClientRect();
    return [Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)]; })()
}))()`;

// Cartão do relatório: o item normativo aparece no texto, o que impede confundir esta falha com
// outra qualquer da mesma página.
const hoverCard = `(() => {
  const cards = [...document.querySelectorAll('[data-result-card]')]
    .filter(card => /ABNT[^\\n]*5\\.1\\.13/u.test(card.textContent));
  return cards.map(card => ({
    classification: card.dataset.classification,
    checkKey: card.dataset.checkKey,
    occurrences: card.querySelectorAll('button[data-intent="SELECT_OCCURRENCE"]').length,
    text: card.textContent.replace(/\\s+/gu, ' ').trim()
  }));
})()`;

const markerSurface = `(() => {
  const host = document.querySelector('[data-audita-page-markers-root="v1"]');
  if (!host) return { roots: 0, groups: [] };
  const shadow = host.shadowRoot;
  return { roots: document.querySelectorAll('[data-audita-page-markers-root="v1"]').length,
    groups: [...shadow.querySelectorAll('.audita-group')].map(group => {
      const ring = group.querySelector('.audita-ring').getBoundingClientRect();
      return { label: group.querySelector('.audita-marker').getAttribute('aria-label') ?? '',
        marked: group.querySelector('.audita-ring').style.display !== 'none',
        box: [Math.round(ring.x), Math.round(ring.y), Math.round(ring.width), Math.round(ring.height)] };
    }) };
})()`;

async function runCurrentPageAudit(extension, panel) {
  await waitForValue(panel, `(() => {
    const input = document.querySelector('input[data-capture-mode="no-pixels"]');
    const button = document.querySelector('button[data-intent="START_ATTACHED"]');
    return Boolean(input && !input.disabled && button && !button.disabled);
  })()`, value => value === true, { timeoutMs: 30_000, intervalMs: 50 });
  await extension.click(panel, 'input[data-capture-mode="no-pixels"]');
  await extension.click(panel, 'button[data-intent="START_ATTACHED"]');
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const screen = await evaluate(panel, `document.querySelector('[data-screen]')?.dataset.screen ?? null`).catch(() => null);
    if (screen === 'result') return;
    if (screen === 'error') throw new Error('AUDIT_SCREEN_ERROR');
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('AUDIT_RESULT_TIMEOUT');
}

function overlapRatio(ring, card) {
  const width = Math.max(0, Math.min(ring[0] + ring[2], card[0] + card[2]) - Math.max(ring[0], card[0]));
  const height = Math.max(0, Math.min(ring[1] + ring[3], card[1] + card[3]) - Math.max(ring[1], card[1]));
  return (width * height) / (card[2] * card[3]);
}

test('a card that only opens with the mouse is a confirmed keyboard failure, with a signal on the card', { timeout: 300_000 }, async t => {
  const fixture = await startFixtureServer(t, new Map([['/current', {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
    body: await readFile(join(root, 'test/e2e/fixtures/hover-only.html'), 'utf8')
  }]]));
  const extension = await launchUnpackedExtension(t, {
    extensionPath: await realpath(root),
    startUrl: `${fixture.origin}/current`, chromeBinary: resolveRealChromeTestBinary(), expectedMajor: 152,
    viewport: { width: 1280, height: 900 }
  });
  const panel = await extension.openSidePanelFromAction();
  await panel.command('Page.bringToFront');
  await waitForValue(panel, 'document.visibilityState', value => value === 'visible', { timeoutMs: 10_000 });

  const before = await evaluate(extension.startPage.page, pageState);
  assert.deepEqual(before.hidden, {
    'so-mouse': 'block/hidden', 'com-foco': 'none/visible', 'com-botao': 'none/visible'
  });
  assert.equal(before.markerRoots, 0, 'nada é desenhado na página antes da auditoria');

  await runCurrentPageAudit(extension, panel);

  const cards = await waitForValue(panel, hoverCard,
    value => value.some(card => card.classification === 'failed'), { timeoutMs: 30_000, intervalMs: 250 });
  assert.equal(cards.length, 1, `a regra precisa aparecer uma única vez no relatório: ${JSON.stringify(cards)}`);
  const [card] = cards;
  assert.equal(card.classification, 'failed', `o cartão só-mouse é falha confirmada: ${JSON.stringify(card)}`);
  assert.equal(card.occurrences, 1, `só o cartão só-mouse vira ocorrência: ${JSON.stringify(card)}`);
  assert.match(card.text, /Acessibilidade por teclado parcial/u, card.text);
  assert.doesNotMatch(card.text, /com-foco|com-botao|Protocolos|Agendamentos/u,
    `os cartões com foco e com botão não podem entrar na falha: ${card.text}`);

  await extension.click(panel, `[data-check-key=${JSON.stringify(card.checkKey)}] button[data-intent="SELECT_OCCURRENCE"]`);
  const detail = await waitForValue(panel, `(() => {
    const block = document.querySelector('[data-result-detail] [data-detail-block="correction"]');
    const observed = document.querySelector('[data-result-detail] [data-detail-block="observed"]');
    return { correction: (block?.textContent ?? '').replace(/\\s+/gu, ' ').trim(),
      observed: (observed?.textContent ?? '').replace(/\\s+/gu, ' ').trim() };
  })()`, value => value.correction.length > 0, { timeoutMs: 15_000, intervalMs: 100 });
  assert.match(detail.correction, /mouse/u, detail.correction);
  assert.match(detail.correction, /teclado|TAB/u, detail.correction);
  assert.match(detail.correction, /focável|foco|:focus-within/u, detail.correction);
  assert.doesNotMatch(detail.correction, /hover-only|not-keyboard-reachable|undefined/iu, detail.correction);
  assert.match(detail.observed, /mouse|teclado|conteúdo/u, detail.observed);

  // O sinal numerado tem de cair sobre o cartão defeituoso e o contorno dele precisa cobrir o cartão
  // de verdade — um número solto não diria onde está o problema.
  await extension.click(panel, '[data-intent="SHOW_PAGE_MARKERS"]');
  const selectedNumber = await waitForValue(panel,
    `document.querySelector('[data-intent="SELECT_OCCURRENCE"][aria-pressed="true"] [data-page-marker-number]')?.dataset.pageMarkerNumber ?? null`,
    value => typeof value === 'string', { timeoutMs: 65_000, intervalMs: 100 });
  const surface = await waitForValue(extension.startPage.page, markerSurface,
    value => value.roots === 1 && value.groups.length > 0, { timeoutMs: 15_000, intervalMs: 100 });
  const expectedLabel = `Sinal ${selectedNumber}`;
  const signal = surface.groups.find(group => group.label.startsWith(expectedLabel));
  assert.ok(signal, `o cartão defeituoso precisa do seu sinal: ${JSON.stringify({ expectedLabel, surface })}`);
  assert.equal(signal.marked, true, `o sinal do cartão defeituoso precisa do contorno: ${JSON.stringify(signal)}`);
  assert.ok(signal.box[2] > 0 && signal.box[3] > 0, `o sinal precisa ter área visível: ${JSON.stringify(signal)}`);
  assert.ok(overlapRatio(signal.box, before.card) >= 0.5,
    `o contorno do sinal precisa cair sobre o cartão só-mouse: ${JSON.stringify({ signal: signal.box, card: before.card })}`);

  // A promessa publicada da página atual continua valendo: a sondagem força hover no motor de estilo
  // e sempre desfaz, então nada fica aberto, rolado ou focado depois da auditoria.
  const after = await evaluate(extension.startPage.page, pageState);
  assert.deepEqual(after.hidden, before.hidden,
    `nenhuma lista pode continuar aberta depois da sondagem: ${JSON.stringify(after.hidden)}`);
  assert.deepEqual(after.scroll, before.scroll, 'a auditoria da página atual não pode rolar a página');
  assert.equal(after.focus, before.focus, 'a auditoria da página atual não pode mover o foco');
});
