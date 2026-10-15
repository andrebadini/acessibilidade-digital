import assert from 'node:assert/strict';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { evaluate, launchUnpackedExtension, resolveRealChromeTestBinary, startFixtureServer, waitForValue } from './support/real-chrome.mjs';

// A página de serviços tem um menu que abre por script no `mouseenter` e nenhum caminho de teclado.
// A sondagem por `CSS.forcePseudoState` não vê esse gatilho — nenhuma pseudo-classe é a causa — e
// antes desta mudança o bloco passaria como conforme. O que o teste percorre é o caminho real nas
// duas políticas de modo: na página atual, onde a promessa é de leitura, o bloco vira revisão humana
// e nenhum evento de ponteiro chega à página; numa página descartável, o ponteiro de verdade confirma
// a abertura e o bloco vira falha. O bloco com botão focável, o bloco com ouvinte de teclado no
// ancestral e o bloco de `:hover` de CSS ficam sem achado nenhum: são o controle desta mudança.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const pageState = `(() => ({
  scroll: [scrollX, scrollY],
  focus: document.activeElement?.tagName ?? null,
  // O painel da fixture conta os eventos de ponteiro recebidos: é a prova de que a sondagem não
  // executou nada do site no modo da página atual.
  pointerEvents: window.__pointerEvents,
  openCards: document.querySelectorAll('.card.is-open').length,
  hidden: Object.fromEntries([...document.querySelectorAll('.card')].map(card => {
    const menu = card.querySelector('ul');
    const style = getComputedStyle(menu);
    return [card.id, style.display + '/' + style.visibility];
  }))
}))()`;

const hoverCard = `(() => {
  const cards = [...document.querySelectorAll('[data-result-card]')]
    .filter(card => /ABNT[^\\n]*5\\.1\\.13/u.test(card.textContent));
  return cards.map(card => ({
    classification: card.dataset.classification,
    checkKey: card.dataset.checkKey,
    occurrences: [...card.querySelectorAll('button[data-intent="SELECT_OCCURRENCE"]')]
      .map(button => button.dataset.focusId)
  }));
})()`;

const correction = `(document.querySelector('[data-result-detail] [data-detail-block="correction"]')?.textContent ?? '').replace(/\\s+/gu, ' ').trim()`;

/** Lê o texto que a pessoa vê em cada ocorrência do item, uma a uma. */
async function occurrenceTexts(extension, panel, focusIds) {
  const texts = [];
  for (const focusId of focusIds) {
    await extension.click(panel, `button[data-intent="SELECT_OCCURRENCE"][data-focus-id=${JSON.stringify(focusId)}]`);
    texts.push(await waitForValue(panel, correction, value => typeof value === 'string' && value.length > 0,
      { timeoutMs: 15_000, intervalMs: 100 }));
  }
  return texts;
}

async function startCurrentPageAudit(extension, panel) {
  await waitForValue(panel, `(() => {
    const input = document.querySelector('input[data-capture-mode="no-pixels"]');
    const button = document.querySelector('button[data-intent="START_ATTACHED"]');
    return Boolean(input && !input.disabled && button && !button.disabled);
  })()`, value => value === true, { timeoutMs: 30_000, intervalMs: 50 });
  await extension.click(panel, 'input[data-capture-mode="no-pixels"]');
  await extension.click(panel, 'button[data-intent="START_ATTACHED"]');
  await waitForResultScreen(panel, 120);
}

/** Auditoria de "Outra URL": a página é descartável e o produto pode interagir com ela. */
async function startUrlAudit(extension, panel, url) {
  await waitForValue(panel, `document.querySelector('[data-screen]')?.dataset.screen ?? null`,
    value => value === 'initial', { timeoutMs: 30_000, intervalMs: 50 });
  await extension.click(panel, 'button[data-intent="OPEN_URL_FORM"]');
  await waitForValue(panel, `(() => {
    const input = document.querySelector('#audit-url');
    const button = document.querySelector('[data-action="start-url-audit"]');
    return Boolean(input && button && !button.disabled);
  })()`, value => value === true, { timeoutMs: 15_000, intervalMs: 50 });
  await extension.click(panel, 'input[data-capture-mode="no-pixels"]');
  assert.equal(await extension.evaluate(panel, `(() => {
    const input = document.querySelector('#audit-url');
    input.value = ${JSON.stringify(url)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return input.value === ${JSON.stringify(url)};
  })()`), true, 'a URL do alvo precisa entrar no formulário');
  await extension.click(panel, '[data-action="start-url-audit"]');
  await waitForResultScreen(panel, 180);
}

async function waitForResultScreen(panel, attempts) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const screen = await evaluate(panel, `document.querySelector('[data-screen]')?.dataset.screen ?? null`).catch(() => null);
    if (screen === 'result') return;
    if (screen === 'error') throw new Error('AUDIT_SCREEN_ERROR');
    await new Promise(resolvePromise => setTimeout(resolvePromise, 500));
  }
  throw new Error('AUDIT_RESULT_TIMEOUT');
}

async function openFixture(t, chromeBinary) {
  const fixture = await startFixtureServer(t, new Map([
    ['/servicos', {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: await readFile(join(root, 'test/e2e/fixtures/hover-script.html'), 'utf8'),
    }],
  ]));
  const extension = await launchUnpackedExtension(t, {
    extensionPath: await realpath(root),
    startUrl: `${fixture.origin}/servicos`, chromeBinary: resolveRealChromeTestBinary(), expectedMajor: 152,
    viewport: { width: 1280, height: 900 },
  });
  const panel = await extension.openSidePanelFromAction();
  await panel.command('Page.bringToFront');
  await waitForValue(panel, 'document.visibilityState', value => value === 'visible', { timeoutMs: 10_000 });
  return { fixture, extension, panel };
}

test('a menu that only a script opens is a human review on the current page, and the page is never touched', { timeout: 300_000 }, async t => {
  const { extension, panel } = await openFixture(t, resolveRealChromeTestBinary());
  const before = await evaluate(extension.startPage.page, pageState);
  assert.deepEqual(before.hidden, {
    'script-no-keyboard': 'none/visible',
    'script-with-button': 'none/visible',
    'css-hover': 'none/visible',
    'script-ancestor-key': 'none/visible',
  });

  await startCurrentPageAudit(extension, panel);

  // Uma ocorrência só: o cartão de script. O cartão com botão focável, o do ouvinte de teclado no
  // ancestral e o de `:hover` de CSS não entram — nenhum deles é achado.
  const cards = await waitForValue(panel, hoverCard,
    value => value.length === 1 && value[0].occurrences.length === 1, { timeoutMs: 30_000, intervalMs: 250 });
  const [card] = cards;
  assert.equal(card.classification, 'manual-review', `o item inteiro é dúvida: ${JSON.stringify(card)}`);

  const texts = await occurrenceTexts(extension, panel, card.occurrences);
  assert.match(texts[0], /script/u, texts[0]);
  assert.match(texts[0], /mouse/u, texts[0]);
  assert.match(texts[0], /Tab/u, texts[0]);
  assert.doesNotMatch(texts.join(' '), /hover-only|undefined/iu);

  // A promessa da página atual: a leitura dos ouvintes é consulta, não interação. Nenhum evento de
  // ponteiro pode ter chegado à página, nenhum menu pode ter aberto, e o foco e a rolagem ficam onde
  // estavam.
  const after = await evaluate(extension.startPage.page, pageState);
  assert.deepEqual(after.hidden, before.hidden,
    `nenhum menu pode abrir depois da auditoria da página atual: ${JSON.stringify(after.hidden)}`);
  assert.equal(after.openCards, 0, 'nenhum cartão pode ficar aberto');
  assert.equal(after.pointerEvents, 0, 'a sondagem não pode disparar evento de ponteiro na página atual');
  assert.deepEqual(after.scroll, before.scroll, 'a auditoria da página atual não pode rolar a página');
  assert.equal(after.focus, before.focus, 'a auditoria da página atual não pode mover o foco');
});

test('on a disposable page the real pointer confirms the script menu, and the review becomes a failure', { timeout: 300_000 }, async t => {
  const { fixture, extension, panel } = await openFixture(t, resolveRealChromeTestBinary());
  const before = await evaluate(extension.startPage.page, pageState);

  await startUrlAudit(extension, panel, `${fixture.origin}/servicos`);

  const cards = await waitForValue(panel, hoverCard,
    value => value.length === 1 && value[0].occurrences.length === 1, { timeoutMs: 60_000, intervalMs: 250 });
  const [card] = cards;
  assert.equal(card.classification, 'failed', `com o ponteiro confirmando, o item é falha: ${JSON.stringify(card)}`);

  // A página não tem regra de `:hover` para o cartão de script: sem a confirmação com o ponteiro de
  // verdade ele continuaria sendo o texto "parecem abrir por um script...". A ocorrência falando do
  // mouse (e não de script) é a prova de que o ponteiro revelou a lista.
  const texts = await occurrenceTexts(extension, panel, card.occurrences);
  assert.equal(texts.filter(text => /script/iu.test(text)).length, 0,
    `com o ponteiro confirmando, nenhuma ocorrência fica como revisão: ${JSON.stringify(texts)}`);
  for (const text of texts) assert.match(text, /mouse/u, text);

  // A página inicial (que não é a auditada) permanece intacta: a auditoria descartável não mexe nela.
  const after = await evaluate(extension.startPage.page, pageState);
  assert.deepEqual(after.hidden, before.hidden);
  assert.equal(after.pointerEvents, 0, 'o ponteiro é movido na página descartável, não nesta');
});
