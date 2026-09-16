import assert from 'node:assert/strict';
import test from 'node:test';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { startFixtureServer, launchUnpackedExtension, resolveRealChromeTestBinary, evaluate, waitForValue } from './support/real-chrome.mjs';

// The highlight is the required bridge between the panel and the page: the person selects an
// occurrence and must see a box on the page itself. Until this test existed, the only E2E
// coverage asserted that the *offer* was present, never that a mark appeared, so a rendering
// regression would have passed unnoticed — and an incorrect measurement of mine once claimed
// the mark was missing when it was there.
const DOCUMENT = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Destaque na página</title></head>
<body><main><h1>Página avaliada</h1>
<img id="missing-alt" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==">
<button id="missing-name">Botão sem nome</button><input id="missing-label" type="text"></main></body></html>`;

// Look for the overlay root in the whole document: it is attached to documentElement, not to
// body, which is exactly the detail that made an earlier measurement report absence.
const overlayExpression = `(() => {
  const roots = [...document.querySelectorAll('[data-audita-highlight-root]')];
  return { count: roots.length,
    boxes: roots.map(root => {
      const rect = root.getBoundingClientRect();
      return { text: (root.textContent ?? '').slice(0, 40), z: getComputedStyle(root).zIndex,
        rect: [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)] };
    }) };
})()`;

test('the panel highlight draws a marked box over the audited element', { timeout: 300_000 }, async t => {
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
  await waitForValue(panel, `(() => {
    const input=document.querySelector('input[data-capture-mode="no-pixels"]');
    const button=document.querySelector('button[data-intent="START_ATTACHED"]');
    return Boolean(input&&!input.disabled&&button&&!button.disabled);
  })()`, value => value === true, { timeoutMs: 30_000, intervalMs: 50 });
  const sourceState = `(() => ({ focus: document.activeElement?.tagName ?? null, scroll: [scrollX, scrollY] }))()`;
  const before = await evaluate(extension.startPage.page, sourceState);
  await extension.click(panel, 'input[data-capture-mode="no-pixels"]');
  await extension.click(panel, 'button[data-intent="START_ATTACHED"]');
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const screen = await evaluate(panel, `document.querySelector('[data-screen]')?.dataset.screen ?? null`).catch(() => null);
    if (screen === 'result') break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.equal(await evaluate(extension.startPage.page, `document.querySelectorAll('[data-audita-highlight-root]').length`), 0,
    'inspection alone must not draw anything on the page');

  // Pick an element-level finding, the same way the panel offers it.
  const candidates = await evaluate(panel,
    `Array.from(document.querySelectorAll('[data-result-card][data-classification="failed"] button[data-intent="SELECT_OCCURRENCE"]'), element => element.dataset.focusId)`);
  assert.ok(candidates.length > 0, 'the fixture must produce a confirmed element-level finding');
  let offered = false;
  for (const focusId of candidates) {
    await evaluate(panel, `(() => {
      const button=[...document.querySelectorAll('button[data-focus-id]')].find(node=>node.dataset.focusId===${JSON.stringify(focusId)});
      const group=button?.closest('details[data-abnt-group]');
      if(group&&!group.open)group.querySelector('summary').click();
      return Boolean(button);
    })()`);
    await extension.click(panel, `button[data-focus-id="${focusId}"]`);
    const action = await waitForValue(panel, `document.querySelector('[data-result-detail] .detail-actions [data-action]')?.dataset.action??null`,
      value => ['highlight-occurrence', 'consult-evidence'].includes(value), { timeoutMs: 5_000, intervalMs: 25 }).catch(() => null);
    if (action === 'highlight-occurrence') { offered = true; break; }
  }
  assert.equal(offered, true, 'at least one confirmed element-level finding must offer live highlighting');

  await extension.click(panel, '[data-result-detail] .detail-actions [data-action="highlight-occurrence"]');
  const marked = await waitForValue(extension.startPage.page, overlayExpression, value => value?.count === 1, { timeoutMs: 15_000, intervalMs: 100 });
  assert.equal(marked.boxes.length, 1);
  const [box] = marked.boxes;
  assert.equal(box.z, '2147483647', 'the box must sit above the page content');
  assert.match(box.text, /Falha confirmada/u, 'the box must name what it marks');
  assert.ok(box.rect[2] > 0 && box.rect[3] > 0, 'the box must have a visible area');
  // The marked box must cover a real element of the audited page.
  const targetInside = await evaluate(extension.startPage.page, `(() => {
    const root = document.querySelector('[data-audita-highlight-root]');
    const rect = root.getBoundingClientRect();
    const covered = [...document.querySelectorAll('main *')].filter(element => {
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0 &&
        box.left >= rect.left - 1 && box.top >= rect.top - 1 &&
        box.right <= rect.right + 1 && box.bottom <= rect.bottom + 1;
    }).map(element => element.tagName + (element.id ? '#' + element.id : ''));
    return covered;
  })()`);
  assert.ok(targetInside.length > 0, 'the box must contain the audited element');
  // Highlighting is a user request and must not move the page under the person.
  assert.deepEqual(await evaluate(extension.startPage.page, sourceState), before);
  await extension.close();
});
