import assert from 'node:assert/strict';
import test from 'node:test';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { startFixtureServer, launchUnpackedExtension, resolveRealChromeTestBinary, evaluate, waitForValue } from './support/real-chrome.mjs';

// The numbered in-page signals ("Mostrar sinais na página") are the step between reading the
// report and finding the element on the page. They were dead in the product: every request was
// answered PAGE_MARKERS_UNAVAILABLE because the provenance the controller requires to resolve a
// target — tab, window, document and session digest — was never registered after the attached
// audit start path was replaced. A controller that cannot resolve a target must refuse, so the
// refusal itself was correct; the missing registration was the defect. This test only passes
// when a real numbered marker is drawn over a real element of the audited page, so a regression
// back to "the button exists but nothing happens" fails here.
// Measured on this fixture: the audit settles in about 0.4 s and the signals become active in
// about 0.1 s, so the timeouts below are generous rather than tight.
const DOCUMENT = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Sinais numerados</title></head>
<body><main id="alvo"><h1>Página avaliada</h1>
<img id="missing-alt" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==">
<button id="missing-name">Botão sem nome</button><input id="missing-label" type="text"></main></body></html>`;

// The overlay lives in a closed shadow root attached to documentElement, so every read goes
// through the host element and its shadowRoot, never through body's children. A ring is drawn
// only for the signal the report currently has selected; the other signals stay as numbered
// buttons, which is what keeps the page readable while marking it.
const markerSurface = `(() => {
  const host = document.querySelector('[data-audita-page-markers-root="v1"]');
  if (!host) return { roots: 0, buttons: [], ring: null };
  const shadow = host.shadowRoot;
  const buttonBox = group => { const box = group.querySelector('.audita-marker').getBoundingClientRect();
    return [Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)]; };
  const groups = [...shadow.querySelectorAll('.audita-group')].map(group => ({
    label: group.querySelector('.audita-marker').getAttribute('aria-label'),
    text: group.querySelector('.audita-marker').textContent,
    marked: group.querySelector('.audita-ring').style.display !== 'none',
    box: buttonBox(group),
  }));
  const markedGroup = [...shadow.querySelectorAll('.audita-group')]
    .find(group => group.querySelector('.audita-ring').style.display !== 'none') ?? null;
  return { roots: document.querySelectorAll('[data-audita-page-markers-root="v1"]').length,
    buttons: groups,
    ring: markedGroup ? (() => {
      const box = markedGroup.querySelector('.audita-ring').getBoundingClientRect();
      const covered = [...document.querySelectorAll('main *')].filter(element => {
        const other = element.getBoundingClientRect();
        return other.width > 0 && other.height > 0 && other.x < box.x + box.width && box.x < other.x + other.width &&
          other.y < box.y + box.height && box.y < other.y + other.height;
      }).map(element => element.id || element.tagName.toLowerCase());
      return { label: markedGroup.querySelector('.audita-marker').getAttribute('aria-label'),
        box: [Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)],
        covered: covered.filter((tag, index, all) => all.indexOf(tag) === index) };
    })() : null };
})()`;

const panelMarkerState = `(() => ({
  state: document.querySelector('[data-page-marker-review]')?.dataset.markerStatus ?? null,
  counts: [...document.querySelectorAll('.page-marker-counts li')].map(node => node.textContent),
  selected: [...document.querySelectorAll('[data-intent="SELECT_OCCURRENCE"][aria-pressed="true"] [data-page-marker-number]')]
    .map(node => Number(node.dataset.pageMarkerNumber)),
}))()`;

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

test('the panel draws numbered signals over the audited page', { timeout: 300_000 }, async t => {
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
  await runCurrentPageAudit(extension, panel);

  assert.equal(await evaluate(extension.startPage.page,
    `document.querySelectorAll('[data-audita-page-markers-root="v1"]').length`), 0,
  'reading the report alone must not draw signals on the page');
  const intact = await evaluate(extension.startPage.page, `(() => ({
    x: scrollX, y: scrollY, focus: document.activeElement?.tagName ?? null,
  }))()`);

  const offer = await evaluate(panel, `(() => {
    const button = document.querySelector('[data-intent="SHOW_PAGE_MARKERS"]');
    const result = document.querySelector('[data-screen="result"]');
    return { present: Boolean(button), disabled: button?.disabled ?? null,
      text: (result?.textContent ?? '').replace(/\\s+/gu, ' ').slice(0, 400) };
  })()`);
  assert.equal(offer.present, true, 'the report must offer the in-page signals');
  assert.equal(offer.disabled, false, 'the offer must be actionable');
  // Anchors that this report really belongs to the audited page: without them a stale panel
  // could satisfy the signal assertions below.
  assert.match(offer.text, /Falhas confirmadas/u, `the fixture produces confirmed failures: ${offer.text}`);
  assert.ok(offer.text.includes(fixture.origin), `the report must name the audited page: ${offer.text}`);

  await extension.click(panel, '[data-intent="SHOW_PAGE_MARKERS"]');
  const state = await waitForValue(panel, panelMarkerState, value => value?.state === 'active' || value?.state === 'unavailable',
    { timeoutMs: 65_000, intervalMs: 100 });
  assert.equal(state.state, 'active', `the signals must become active, not unavailable: ${JSON.stringify(state)}`);

  const surface = await waitForValue(extension.startPage.page, markerSurface,
    value => value?.roots === 1 && value.buttons.length >= 2,
    { timeoutMs: 15_000, intervalMs: 100 });
  assert.equal(surface.roots, 1, 'exactly one signals overlay belongs on the page');
  assert.ok(surface.buttons.length >= 2, `the fixture has at least two locatable occurrences: ${JSON.stringify(surface)}`);
  for (const button of surface.buttons) {
    assert.match(button.label ?? '', /^Sinal [0-9]+/u, `every signal is numbered for the report: ${JSON.stringify(button)}`);
    assert.ok(button.box[2] > 0 && button.box[3] > 0,
      `every signal must be drawn where the reader can see it: ${JSON.stringify(button)}`);
  }
  // A ring is drawn only for the signal the report has selected, so the page stays readable
  // while marked. The report opens on its first occurrence, so exactly one ring is expected and
  // it must be the ring of the signal the panel also reports as selected.
  assert.ok(surface.ring, `the selected occurrence must be ringed on the page: ${JSON.stringify(surface)}`);
  const number = Number(surface.ring.label.match(/^Sinal ([0-9]+)/u)[1]);
  assert.equal(surface.buttons.filter(button => button.marked).length, 1,
    `only the selected signal may draw a ring: ${JSON.stringify(surface.buttons)}`);

  // The numbered signal has to sit on a real element of the audited page, otherwise the number
  // tells the reader nothing about where the problem is.
  assert.ok(surface.ring.box[2] > 0 && surface.ring.box[3] > 0,
    `the ring must have a visible area: ${JSON.stringify(surface.ring)}`);
  assert.ok(surface.ring.covered.length > 0, `the ring must cover a real element: ${JSON.stringify(surface.ring)}`);
  const selected = await waitForValue(panel, panelMarkerState,
    value => (value?.selected ?? []).includes(number), { timeoutMs: 15_000, intervalMs: 100 });
  assert.ok(selected.selected.includes(number), `the page and the panel must agree on the number: ${JSON.stringify(selected)}`);
  assert.ok((selected.counts ?? []).length > 0, `the panel must summarise what it marked: ${JSON.stringify(selected)}`);
  assert.deepEqual(await evaluate(extension.startPage.page, `(() => ({
    x: scrollX, y: scrollY, focus: document.activeElement?.tagName ?? null,
  }))()`), intact, 'showing the signals must not move, focus or edit the page');
});
