import assert from 'node:assert/strict';
import test from 'node:test';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { startFixtureServer, launchUnpackedExtension, resolveRealChromeTestBinary, evaluate, waitForValue } from './support/real-chrome.mjs';

// Reloading the audited page is the ordinary thing a reader does before going back to the report:
// the address is the same, the document is not. The extension used to answer "not available"
// there — the audit was still valid and the signals could be re-found, so the refusal was the
// defect. This test drives the real gestures: audit, show the signals, reload the tab, ask for the
// signals again (the panel must offer instead of erroring), accept, and check that the numbered
// signals and the highlight are drawn on the reloaded document. The second test reloads to another
// address and asserts the panel asks for a new audit instead of pretending to relocate.
const DOCUMENT = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Sinais depois da recarga</title></head>
<body><main id="alvo"><h1>Página avaliada</h1>
<img id="missing-alt" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==">
<button id="missing-name">Botão sem nome</button><input id="missing-label" type="text"></main></body></html>`;

// The signals live in a closed shadow root attached to documentElement, so every read goes through
// the host element. A relocated signal has to sit on a real element of the reloaded page.
const markerSurface = `(() => {
  const host = document.querySelector('[data-audita-page-markers-root="v1"]');
  if (!host) return { roots: 0, buttons: [], covered: 0 };
  const shadow = host.shadowRoot;
  return { roots: document.querySelectorAll('[data-audita-page-markers-root="v1"]').length,
    buttons: [...shadow.querySelectorAll('.audita-group')].map(group => {
      const button = group.querySelector('.audita-marker');
      const box = button.getBoundingClientRect();
      const ring = group.querySelector('.audita-ring').getBoundingClientRect();
      const covered = [...document.querySelectorAll('main *')].filter(element => {
        const other = element.getBoundingClientRect();
        return other.width > 0 && other.height > 0 && other.x < ring.x + ring.width && ring.x < other.x + other.width &&
          other.y < ring.y + ring.height && ring.y < other.y + other.height;
      }).length;
      return { label: button.getAttribute('aria-label'), text: button.textContent,
        box: [Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)], covered };
    }) };
})()`;

const panelMarkerCard = `(() => {
  const card = document.querySelector('[data-page-marker-review]');
  return { status: card?.dataset.markerStatus ?? null,
    action: card?.querySelector('[data-intent]')?.dataset.intent ?? null,
    message: card?.querySelector('[role="status"]')?.textContent ?? null,
    relocated: Boolean(card?.querySelector('[data-page-marker-relocated]')),
    text: (card?.textContent ?? '').replace(/\\s+/gu, ' ').trim().slice(0, 400) };
})()`;

const highlightSurface = `(() => {
  const roots = [...document.querySelectorAll('[data-audita-highlight-root]')];
  return { count: roots.length, texts: roots.map(root => (root.textContent ?? '').slice(0, 40)) };
})()`;

const panelHighlightActions = `(() => ({
  actions: [...document.querySelectorAll('[data-result-detail] .detail-actions [data-action]')].map(node => node.dataset.action),
  live: [...document.querySelectorAll('.panel-live')].map(node => node.textContent ?? ''),
}))()`;

async function auditCurrentPage(extension, panel) {
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

async function reloadPage(extension) {
  await evaluate(extension.startPage.page, 'window.__auditaDocumentBeforeReload = true');
  await extension.command(extension.startPage.page, 'Page.reload', { ignoreCache: false });
  await waitForValue(extension.startPage.page, `({ fresh: typeof window.__auditaDocumentBeforeReload === 'undefined',
    ready: document.readyState })`, value => value?.fresh === true && value?.ready === 'complete',
  { timeoutMs: 30_000, intervalMs: 100 });
}

// The reader's gestures after the reload. The panel may still believe the signals are on the page
// (the overlay died with the document), so the path is the same one a person would take: retire
// what it shows as visible, then ask for the signals again.
async function askForSignalsAgain(extension, panel) {
  // A recarga da aba recria o painel desta aba: espere o documento NOVO do painel se acomodar
  // antes de pedir qualquer coisa, senão o gesto cai em um documento que já não existe.
  await waitForValue(panel, 'typeof window.__auditaPanelBeforeReload',
    value => value === 'undefined', { timeoutMs: 30_000, intervalMs: 100 });
  const card = await waitForValue(panel, panelMarkerCard,
    value => value?.action === 'SHOW_PAGE_MARKERS' || value?.action === 'HIDE_PAGE_MARKERS',
    { timeoutMs: 30_000, intervalMs: 100 });
  if (card.action === 'HIDE_PAGE_MARKERS') {
    await clickWhenReady(extension, panel, '[data-page-marker-review] [data-intent="HIDE_PAGE_MARKERS"]');
    await waitForValue(panel, panelMarkerCard, value => value?.action === 'SHOW_PAGE_MARKERS',
      { timeoutMs: 30_000, intervalMs: 100 });
  }
  await clickWhenReady(extension, panel, '[data-page-marker-review] [data-intent="SHOW_PAGE_MARKERS"]');
  return waitForValue(panel, panelMarkerCard, value => value?.action !== 'SHOW_PAGE_MARKERS',
    { timeoutMs: 65_000, intervalMs: 100 });
}

async function clickWhenReady(extension, panel, selector, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { await extension.click(panel, selector); return true; } catch { /* o painel pode estar sendo recriado */ }
    if (Date.now() >= deadline) throw new Error(`CLICK_TIMEOUT ${selector}`);
    await new Promise(resolvePromise => setTimeout(resolvePromise, 250));
  }
}

// O item destacável é encontrado pela mesma ação que a pessoa usa: escolher a ocorrência e olhar as
// ações do detalhe. A primeira tentativa pode convidar em vez de destacar (a página recarregou).
async function selectHighlightableFinding(extension, panel) {
  const candidates = await evaluate(panel,
    `Array.from(document.querySelectorAll('[data-result-card][data-classification="failed"] button[data-intent="SELECT_OCCURRENCE"]'), element => element.dataset.focusId)`);
  assert.ok(candidates.length > 0, 'the fixture must produce a confirmed element-level finding');
  for (const focusId of candidates) {
    await evaluate(panel, `(() => {
      const button=[...document.querySelectorAll('button[data-focus-id]')].find(node=>node.dataset.focusId===${JSON.stringify(focusId)});
      const group=button?.closest('details[data-abnt-group]');
      if(group&&!group.open)group.querySelector('summary').click();
      return Boolean(button);
    })()`);
    await extension.click(panel, `button[data-focus-id="${focusId}"]`);
    // As ações do detalhe são lidas todas de uma vez: o botão dos sinais vem antes do destaque, e
    // procurar só o primeiro perderia o botão do destaque.
    const highlights = ['highlight-occurrence', 'highlight-reloaded'];
    const offered = await waitForValue(panel,
      `[...document.querySelectorAll('[data-result-detail] .detail-actions [data-action]')].map(node => node.dataset.action)`,
      value => Array.isArray(value) && value.some(entry => highlights.includes(entry)),
      { timeoutMs: 20_000, intervalMs: 50 }).catch(() => null);
    const action = offered?.find(entry => highlights.includes(entry)) ?? null;
    if (action) return action;
  }
  throw new Error('NO_HIGHLIGHT_OFFER');
}

test('the panel relocates the signals and the highlight after a reload of the same address', { timeout: 300_000 }, async t => {
  const fixture = await startFixtureServer(t, new Map([
    ['/current', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: DOCUMENT }],
  ]));
  const extension = await launchUnpackedExtension(t, {
    extensionPath: await realpath(fileURLToPath(new URL('../../', import.meta.url))),
    startUrl: `${fixture.origin}/current`, chromeBinary: resolveRealChromeTestBinary(), expectedMajor: 152,
    viewport: { width: 1280, height: 900 },
  });
  const panel = await extension.openSidePanelFromAction();
  await panel.command('Page.bringToFront');
  await waitForValue(panel, 'document.visibilityState', value => value === 'visible', { timeoutMs: 10_000 });
  await auditCurrentPage(extension, panel);

  // Primeiro: os sinais na página auditada, como em qualquer auditoria.
  await extension.click(panel, '[data-page-marker-review] [data-intent="SHOW_PAGE_MARKERS"]');
  const first = await waitForValue(panel, panelMarkerCard, value => value?.status === 'active' || value?.status === 'unavailable',
    { timeoutMs: 65_000, intervalMs: 100 });
  assert.equal(first.status, 'active', `the signals must become active before the reload: ${JSON.stringify(first)}`);
  assert.equal(first.relocated, false, 'the first showing is not a relocation');
  const before = await waitForValue(extension.startPage.page, markerSurface, value => value?.roots === 1 && value.buttons.length >= 2,
    { timeoutMs: 15_000, intervalMs: 100 });
  assert.ok(before.buttons.every(button => button.covered > 0), `every signal sits on a real element: ${JSON.stringify(before)}`);

  // A recarga: mesmo endereço, documento novo. A camada da página morre junto com o documento.
  const address = await evaluate(extension.startPage.page, 'location.href');
  await evaluate(panel, 'window.__auditaPanelBeforeReload = true');
  await reloadPage(extension);
  assert.equal(await evaluate(extension.startPage.page, 'location.href'), address, 'a recarga é do mesmo endereço');
  assert.equal(await evaluate(extension.startPage.page, `document.querySelectorAll('[data-audita-page-markers-root="v1"]').length`), 0,
    'a camada antiga sai com o documento antigo');

  const offer = await askForSignalsAgain(extension, panel);
  assert.equal(offer.status, 'reload-offer', `the panel must offer the reloaded version instead of failing: ${JSON.stringify(offer)}`);
  assert.match(offer.message ?? '', /recarregada depois da auditoria/u, JSON.stringify(offer));
  assert.equal(offer.action, 'SHOW_PAGE_MARKERS_RELOADED', JSON.stringify(offer));
  assert.equal(await evaluate(extension.startPage.page, `document.querySelectorAll('[data-audita-page-markers-root="v1"]').length`), 0,
    'an offer alone must not draw anything: the version of now is shown by an explicit gesture');

  // O gesto explícito aceita a versão recarregada.
  await extension.click(panel, '[data-page-marker-review] [data-intent="SHOW_PAGE_MARKERS_RELOADED"]');
  const relocated = await waitForValue(panel, panelMarkerCard, value => value?.status === 'active' || value?.status === 'unavailable',
    { timeoutMs: 65_000, intervalMs: 100 });
  assert.equal(relocated.status, 'active', `the relocated signals must be drawn: ${JSON.stringify(relocated)}`);
  assert.equal(relocated.relocated, true, `the panel must say they were re-found: ${JSON.stringify(relocated)}`);
  assert.match(relocated.message ?? '', /reencontrados na versão recarregada/u, JSON.stringify(relocated));
  assert.match(relocated.text, /confira se correspondem ao que foi auditado/u, JSON.stringify(relocated));

  const after = await waitForValue(extension.startPage.page, markerSurface, value => value?.roots === 1 && value.buttons.length >= 2,
    { timeoutMs: 15_000, intervalMs: 100 });
  assert.equal(after.roots, 1, 'exactly one signals overlay on the reloaded page');
  assert.ok(after.buttons.every(button => button.covered > 0),
    `every relocated signal must sit on a real element of the new document: ${JSON.stringify(after)}`);
  for (const button of after.buttons) {
    assert.match(button.label ?? '', /^Sinal [0-9]+/u, `the relocated signals stay numbered: ${JSON.stringify(button)}`);
    assert.ok(button.box[2] > 0 && button.box[3] > 0, `the relocated signal must be visible: ${JSON.stringify(button)}`);
  }

  // O destaque individual segue a mesma lógica: a primeira tentativa convida, o gesto seguinte
  // destaca no documento de agora.
  const action = await selectHighlightableFinding(extension, panel);
  if (action !== 'highlight-reloaded') {
    assert.equal(action, 'highlight-occurrence', 'the audited-page action is the first attempt');
    await extension.click(panel, '[data-result-detail] .detail-actions [data-action="highlight-occurrence"]');
    const invited = await waitForValue(panel,
      `[...document.querySelectorAll('[data-result-detail] .detail-actions [data-action]')].map(node => node.dataset.action)`,
      value => Array.isArray(value) && value.includes('highlight-reloaded'), { timeoutMs: 20_000, intervalMs: 100 });
    assert.ok(invited.includes('highlight-reloaded'), 'the reloaded page must invite the highlight instead of failing');
    assert.equal((await evaluate(extension.startPage.page, highlightSurface)).count, 0,
      'the invitation alone must not draw the highlight');
  }
  assert.equal(await evaluate(panel, `document.querySelector('[data-result-detail] .detail-actions [data-action="highlight-reloaded"]')?.textContent ?? null`),
    'Destacar na versão atual', 'the offer must be a button with the explicit label');
  await extension.click(panel, '[data-result-detail] .detail-actions [data-action="highlight-reloaded"]');
  const marked = await waitForValue(extension.startPage.page, highlightSurface, value => value?.count === 1,
    { timeoutMs: 15_000, intervalMs: 100 });
  assert.match(marked.texts[0], /Falha confirmada/u, 'the relocated box must name what it marks');

  // O painel precisa contar a mesma história que a página: se a caixa foi desenhada, o destaque está
  // ativo e oferece como desfazê-lo — e não um erro de que nada foi destacado.
  const settled = await waitForValue(panel, panelHighlightActions, value => value?.actions.includes('clear-highlight'),
    { timeoutMs: 15_000, intervalMs: 100 });
  assert.ok(settled.actions.includes('clear-highlight'), `the panel must offer to clear the drawn highlight: ${JSON.stringify(settled)}`);
  assert.match(settled.live.join(' '), /Destaque reencontrado na versão recarregada/u, JSON.stringify(settled));
  assert.match(settled.live.join(' '), /confira se corresponde ao que foi auditado/u, JSON.stringify(settled));
  assert.doesNotMatch(settled.live.join(' '), /Não foi possível destacar/u, JSON.stringify(settled));

  // E o desfazer também vale para a versão recarregada: o sinal sai da página e o painel volta ao convite.
  await extension.click(panel, '[data-result-detail] .detail-actions [data-action="clear-highlight"]');
  const cleared = await waitForValue(extension.startPage.page, highlightSurface, value => value?.count === 0,
    { timeoutMs: 15_000, intervalMs: 100 });
  assert.equal(cleared.count, 0, 'clearing must remove the box from the reloaded page');
  await waitForValue(panel, panelHighlightActions, value => value?.actions.includes('highlight-occurrence'),
    { timeoutMs: 15_000, intervalMs: 100 });

  assert.deepEqual(await evaluate(extension.startPage.page, '({ href: location.href, scroll: [scrollX, scrollY] })'),
    { href: address, scroll: [0, 0] }, 'showing the relocated signals must not move the page');
  await extension.close();
});

test('a reload to another address asks for a new audit instead of relocating', { timeout: 300_000 }, async t => {
  const fixture = await startFixtureServer(t, new Map([
    ['/current', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: DOCUMENT }],
    ['/other', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: DOCUMENT }],
  ]));
  const extension = await launchUnpackedExtension(t, {
    extensionPath: await realpath(fileURLToPath(new URL('../../', import.meta.url))),
    startUrl: `${fixture.origin}/current`, chromeBinary: resolveRealChromeTestBinary(), expectedMajor: 152,
    viewport: { width: 1280, height: 900 },
  });
  const panel = await extension.openSidePanelFromAction();
  await panel.command('Page.bringToFront');
  await waitForValue(panel, 'document.visibilityState', value => value === 'visible', { timeoutMs: 10_000 });
  await auditCurrentPage(extension, panel);
  await extension.click(panel, '[data-page-marker-review] [data-intent="SHOW_PAGE_MARKERS"]');
  const first = await waitForValue(panel, panelMarkerCard, value => value?.status === 'active',
    { timeoutMs: 65_000, intervalMs: 100 });
  assert.equal(first.status, 'active', `the signals must become active before the navigation: ${JSON.stringify(first)}`);

  await extension.command(extension.startPage.page, 'Page.navigate', { url: `${fixture.origin}/other` });
  await waitForValue(extension.startPage.page, `({ href: location.href, ready: document.readyState })`,
    value => value?.href === `${fixture.origin}/other` && value?.ready === 'complete', { timeoutMs: 30_000, intervalMs: 100 });

  const card = await askForSignalsAgain(extension, panel);
  assert.equal(card.status, 'changed-address', `another address cannot be relocated: ${JSON.stringify(card)}`);
  assert.match(card.message ?? '', /endereço da página mudou/u, JSON.stringify(card));
  assert.equal(card.action, 'NEW_AUDIT', JSON.stringify(card));
  assert.equal(await evaluate(extension.startPage.page, `document.querySelectorAll('[data-audita-page-markers-root="v1"]').length`), 0,
    'nothing may be drawn on a page that was not audited');
  await extension.close();
});
