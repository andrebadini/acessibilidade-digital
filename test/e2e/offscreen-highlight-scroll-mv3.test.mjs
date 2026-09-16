import assert from 'node:assert/strict';
import test from 'node:test';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { startFixtureServer, launchUnpackedExtension, resolveRealChromeTestBinary, evaluate, waitForValue } from './support/real-chrome.mjs';

// "Ver e destacar na página" promises two things: that the element becomes visible and that it is
// marked. When the occurrence sits below the fold, keeping the promise requires moving the page,
// and an earlier probe measured exactly that: scrollY 0 to 2826 with the target landing centred
// in the viewport. This test pins the intended behaviour so it cannot silently become either a
// page that never moves (the promise broken) or a page that moves with an animation and leaves
// the reader disoriented. Reading the report must still leave the page exactly where it was.
const DOCUMENT = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Rolagem</title></head>
<body><main><h1>Página longa</h1>
${'<p>Preenchimento antes do alvo.</p>'.repeat(90)}
<img id="missing-alt" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==">
<button id="missing-name">Botão sem nome</button><input id="missing-label" type="text">
${'<p>Preenchimento depois do alvo.</p>'.repeat(30)}
</main></body></html>`;

const targetState = `(() => {
  const element = document.querySelector('#missing-name');
  const box = element.getBoundingClientRect();
  const root = document.querySelector('[data-audita-highlight-root]');
  const rootBox = root?.getBoundingClientRect() ?? null;
  return { scrollY: Math.round(scrollY), innerHeight,
    top: Math.round(box.top), bottom: Math.round(box.bottom),
    inViewport: box.top >= 0 && box.bottom <= innerHeight,
    focus: document.activeElement?.id || document.activeElement?.tagName || null,
    overlays: document.querySelectorAll('[data-audita-highlight-root]').length,
    overlayTop: rootBox ? Math.round(rootBox.top) : null,
    overlayText: (root?.textContent ?? '').slice(0, 40) };
})()`;

test('showing an off-screen occurrence brings it into view and marks it, without animating', { timeout: 300_000 }, async t => {
  const fixture = await startFixtureServer(t, new Map([
    ['/long', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: DOCUMENT }],
  ]));
  const extension = await launchUnpackedExtension(t, {
    extensionPath: await realpath(fileURLToPath(new URL('../../', import.meta.url))),
    startUrl: `${fixture.origin}/long`, chromeBinary: resolveRealChromeTestBinary(), expectedMajor: 152,
    viewport: { width: 1280, height: 800 },
  });
  const panel = await extension.openSidePanelFromAction();
  await panel.command('Page.bringToFront');
  await waitForValue(panel, 'document.visibilityState', value => value === 'visible', { timeoutMs: 10_000 });
  await waitForValue(panel, `(() => {
    const input = document.querySelector('input[data-capture-mode="no-pixels"]');
    const button = document.querySelector('button[data-intent="START_ATTACHED"]');
    return Boolean(input && !input.disabled && button && !button.disabled);
  })()`, value => value === true, { timeoutMs: 30_000, intervalMs: 50 });
  await extension.click(panel, 'input[data-capture-mode="no-pixels"]');
  await extension.click(panel, 'button[data-intent="START_ATTACHED"]');
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const screen = await evaluate(panel, `document.querySelector('[data-screen]')?.dataset.screen ?? null`).catch(() => null);
    if (screen === 'result') break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  await evaluate(extension.startPage.page, `(() => { scrollTo(0, 0); return true; })()`);
  await new Promise(resolve => setTimeout(resolve, 300));

  // Reading the report is not a reason for the audited page to move.
  const before = await evaluate(extension.startPage.page, targetState);
  assert.equal(before.scrollY, 0, 'the page must still be where the reader left it');
  assert.equal(before.inViewport, false, 'this fixture must place the confirmed failure below the fold');
  assert.equal(before.overlays, 0, 'reading the report must not mark the page');

  // Open the occurrence and ask to see it. The action that promises "Ver" must be offered.
  const candidates = await evaluate(panel,
    `Array.from(document.querySelectorAll('[data-result-card][data-classification="failed"] button[data-intent="SELECT_OCCURRENCE"]'), element => element.dataset.focusId)`);
  assert.ok((candidates ?? []).length > 0, 'the fixture must produce confirmed element-level findings');
  let offered = null;
  for (const focusId of candidates) {
    await evaluate(panel, `(() => {
      const button = [...document.querySelectorAll('button[data-focus-id]')].find(node => node.dataset.focusId === ${JSON.stringify(focusId)});
      const group = button?.closest('details[data-abnt-group]');
      if (group && !group.open) group.querySelector('summary').click();
      return Boolean(button);
    })()`);
    await extension.click(panel, `button[data-focus-id="${focusId}"]`);
    const action = await waitForValue(panel,
      `document.querySelector('[data-result-detail] .detail-actions [data-action]')?.dataset.action ?? null`,
      value => value !== null && value !== 'highlight-checking', { timeoutMs: 8_000, intervalMs: 25 }).catch(() => null);
    if (action === 'highlight-occurrence') { offered = focusId; break; }
  }
  assert.ok(offered, 'a confirmed element-level finding must offer the in-page marking');
  const label = await evaluate(panel,
    `document.querySelector('[data-result-detail] .detail-actions [data-action="highlight-occurrence"]')?.textContent?.trim() ?? null`);
  assert.match(label ?? '', /Ver e destacar|Destacar/u, `the action must say the page will be shown: ${label}`);

  await extension.click(panel, '[data-result-detail] .detail-actions [data-action="highlight-occurrence"]');
  const after = await waitForValue(extension.startPage.page, targetState, value => value?.overlays === 1,
    { timeoutMs: 20_000, intervalMs: 100 });

  // The element is now visible and marked, and the marking sits on it.
  assert.equal(after.inViewport, true, `the promised element must be in view: ${JSON.stringify(after)}`);
  assert.ok(after.scrollY > before.scrollY, `bringing an off-screen element into view requires scrolling: ${before.scrollY} -> ${after.scrollY}`);
  assert.ok(after.top > 0 && after.bottom < after.innerHeight,
    `the element must land inside the viewport, not against an edge: ${JSON.stringify(after)}`);
  assert.match(after.overlayText, /Falha confirmada/u, `the marking must name what it marks: ${JSON.stringify(after)}`);
  assert.ok(Math.abs(after.overlayTop - after.top) <= 2,
    `the marking must sit on the element it names: overlay ${after.overlayTop} vs element ${after.top}`);
  // Asking to see an element is not a reason to move the reader's focus into the page.
  assert.equal(after.focus, before.focus, `showing the element must not move focus: ${before.focus} -> ${after.focus}`);

  // The scroll has to be a jump, not an animation: a smooth scroll would still be in motion when
  // the marking is drawn, and the reader would watch the page slide under the box.
  const settled = await evaluate(extension.startPage.page, targetState);
  assert.equal(settled.scrollY, after.scrollY, 'the scroll must settle immediately, without an animation still running');
  t.diagnostic(`off-screen occurrence: scrollY ${before.scrollY} -> ${after.scrollY}; element top ${after.top} of ${after.innerHeight}; mark on target; focus kept`);
});
