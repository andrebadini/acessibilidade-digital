import assert from 'node:assert/strict';
import test from 'node:test';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { runAuditaPageMarkersCommand } from '../../src/browser/page-markers-overlay.js';
import {
  evaluate, launchUnpackedExtension, resolveRealChromeTestBinary, startFixtureServer, waitForValue,
} from './support/real-chrome.mjs';

// The label of every signal is placed against the page text: the placement now measures the text
// lines around each contour, so a pass does more work per signal than it used to. A page with many
// signals is exactly where extra work turns into a frozen tab, and no unit test with a fake DOM can
// answer that — the cost is layout reads. Here the real overlay source is injected into a real page
// with 300 signals and 300 lines of text, all inside one viewport, and every pass is timed. The
// control is the same tab with the text lines removed: what the text costs is the difference.
//
// The page offers the same message port the content script has (`chrome.runtime.sendMessage`),
// because the overlay refuses to start without it; nothing is sent from here.
const DENSITY = 300;
const INSTALLATION = 'A'.repeat(22);

const DOCUMENT = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Densidade de sinais</title>
<style>
  html, body { margin: 0; }
  body { font: 14px/1.2 system-ui, sans-serif; }
  main { display: grid; grid-template-columns: repeat(20, 48px); }
  button { width: 32px; height: 16px; }
  span { display: block; width: 44px; height: 14px; }
</style></head>
<body><main id="grade"></main>
<script>
  const grade = document.getElementById('grade');
  for (let index = 1; index <= ${DENSITY}; index += 1) {
    const button = document.createElement('button');
    button.id = 'ponto-' + index;
    const label = document.createElement('span');
    label.textContent = 'texto ' + index;
    grade.append(button, label);
  }
  const port = { sendMessage() { return Promise.resolve(); } };
  if (!window.chrome) window.chrome = {};
  try { window.chrome.runtime = port; }
  catch { Object.defineProperty(window.chrome, 'runtime', { value: port, configurable: true }); }
</script>
</body></html>`;

const INSTALL = {
  version: 1, op: 'install', installationId: INSTALLATION, ttlMs: 60_000,
  targets: Array.from({ length: DENSITY }, (_, index) => ({
    markerId: `m${index + 1}`,
    number: index + 1,
    match: { tag: 'button', id: `ponto-${index + 1}` },
    signals: [{ selectionId: `s${index + 1}`, classification: 'failed' }],
  })),
};

const PROBE = `(() => {
  const run = (${runAuditaPageMarkersCommand.toString()});
  const install = ${JSON.stringify(INSTALL)};
  const selections = install.targets.map(target => target.signals[0].selectionId);
  const pass = () => {
    const started = performance.now();
    const result = run({ version: 1, op: 'filter', installationId: install.installationId, selectionIds: selections }, window);
    return { ms: Math.round(performance.now() - started), ok: result.ok === true };
  };
  const before = performance.now();
  const installed = run(install, window);
  const installMs = Math.round(performance.now() - before);
  const withText = [pass(), pass(), pass()];
  const shadow = document.querySelector('[data-audita-page-markers-root="v1"]')?.shadowRoot ?? null;
  const markers = shadow ? [...shadow.querySelectorAll('.audita-marker')] : [];
  const rings = shadow ? [...shadow.querySelectorAll('.audita-ring')] : [];
  // Each cell's text, one line per fragment, measured with Range — the same thing the label avoids.
  const lines = (() => {
    const range = document.createRange();
    const found = [];
    for (const span of document.querySelectorAll('#grade span')) {
      range.selectNodeContents(span);
      for (const rect of range.getClientRects()) {
        if (rect.width > 0 && rect.height > 0) found.push({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom });
      }
    }
    return found;
  })();
  const drawn = markers.filter(marker => marker.getBoundingClientRect().width > 0);
  // Measured before the control: clearing removes the overlay from the page and the stored
  // references then measure zero, which says nothing about what was drawn.
  const ringDrawn = rings.filter(ring => ring.getBoundingClientRect().width > 0).length;
  const overlapping = drawn.filter(marker => {
    const box = marker.getBoundingClientRect();
    return lines.some(line => Math.min(box.right, line.right) - Math.max(box.left, line.left) > 1 &&
      Math.min(box.bottom, line.bottom) - Math.max(box.top, line.top) > 1);
  }).length;
  // Control: the same 300 labels with no line of text left on the page.
  for (const span of [...document.querySelectorAll('#grade span')]) span.remove();
  window.scrollTo(0, 0);
  void document.documentElement.scrollHeight;
  const withoutText = [pass(), pass(), pass()];
  const cleared = run({ version: 1, op: 'clear', installationId: install.installationId }, window);
  return {
    installed: installed.ok === true, located: installed.locatedMarkerIds?.length ?? 0, installMs,
    withText, withoutText, groups: markers.length, drawn: drawn.length, rings: ringDrawn,
    textLines: lines.length, overlapping, cleared: cleared.ok === true,
    roots: document.querySelectorAll('[data-audita-page-markers-root="v1"]').length,
  };
})()`;

function worst(passes) { return Math.max(...passes.map(entry => entry.ms)); }

test('300 signals on a page full of text do not stall the pass', { timeout: 300_000 }, async t => {
  const fixture = await startFixtureServer(t, new Map([
    ['/denso', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: DOCUMENT }],
  ]));
  const extension = await launchUnpackedExtension(t, {
    extensionPath: await realpath(fileURLToPath(new URL('../../', import.meta.url))),
    startUrl: `${fixture.origin}/denso`, chromeBinary: resolveRealChromeTestBinary(), expectedMajor: 152,
    viewport: { width: 1280, height: 900 },
  });
  const page = extension.startPage.page;
  await waitForValue(page, 'document.querySelectorAll("#grade button").length',
    value => value === DENSITY, { timeoutMs: 15_000, intervalMs: 100 });

  const measured = await evaluate(page, PROBE);
  t.diagnostic(`300 sinais com texto: instalação ${measured.installMs} ms, passadas ` +
    `${measured.withText.map(entry => entry.ms).join('/')} ms (${measured.textLines} linhas medidas, ` +
    `${measured.overlapping} etiqueta(s) sobre texto); sem texto: ` +
    `${measured.withoutText.map(entry => entry.ms).join('/')} ms`);

  assert.equal(measured.installed, true, `a instalação recusou: ${JSON.stringify(measured)}`);
  assert.equal(measured.located, DENSITY);
  assert.equal(measured.groups, DENSITY, 'todo sinal tem seu próprio grupo');
  assert.equal(measured.drawn, DENSITY, 'toda etiqueta é desenhada');
  assert.equal(measured.rings, DENSITY, 'todo sinal tem seu contorno');
  assert.ok(measured.textLines >= DENSITY, `as linhas de texto foram medidas: ${measured.textLines}`);
  assert.deepEqual([...measured.withText, ...measured.withoutText].map(entry => entry.ok), [true, true, true, true, true, true]);
  // In a grid with no free space every possible position covers some line of text, so the most that
  // can be required is that text stops being the preferred place. Without the text measurement 209
  // of the 300 signals rested on words (measured); with it, only the cases with no alternative left.
  assert.ok(measured.overlapping <= DENSITY * 0.15,
    `etiquetas sobre texto: ${measured.overlapping} de ${DENSITY}`);
  assert.equal(measured.cleared, true);
  assert.equal(measured.roots, 0, 'a limpeza deixa a página como estava');
  // A freeze is measured in seconds: the limit is loose on purpose and still catches one.
  assert.ok(measured.installMs < 4_000, `a instalação com 300 sinais levou ${measured.installMs} ms`);
  assert.ok(worst(measured.withText) < 2_000, `uma passada com 300 sinais levou ${worst(measured.withText)} ms`);
});
